// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
//
// The egress proxy: the only code that opens outbound sockets for routed traffic. It runs in its
// own sandboxed process (egress-proxy-process.ts) and speaks a minimal HTTP CONNECT on loopback:
//
//   CONNECT host:port HTTP/1.1
//   Proxy-Authorization: Bearer <secret>
//
// 200 then raw bytes both ways; 407 wrong secret, 403 refused destination, 502 unreachable.
import { timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import type { Server, Socket } from "node:net";
import { connect, createServer, isIP } from "node:net";
import { isAllowedDestination } from "./egress-filter.js";

const MAX_HEAD_BYTES = 4096;
const HEAD_TIMEOUT_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;

export interface EgressProxyOptions {
  secret: string;
  /** Test seam: the destination policy. Production always uses isAllowedDestination. */
  allow?: (address: string, port: number) => boolean;
  /** Test seam: name resolution. */
  resolve?: (host: string) => Promise<string[]>;
}

/** Splits `host:port` or `[v6]:port`; null for anything else. */
export function parseConnectTarget(target: string): { host: string; port: number } | null {
  const match = target.match(/^(?:\[([0-9A-Fa-f:.]+)\]|([^\s:[\]/@]+)):(\d{1,5})$/);
  const host = match?.[1] ?? match?.[2];
  const port = Number(match?.[3]);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host, port };
}

async function resolveAll(host: string): Promise<string[]> {
  if (isIP(host)) return [host];
  return (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
}

function sameSecret(given: string, secret: string): boolean {
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function createEgressProxy(options: EgressProxyOptions): Server {
  if (options.secret.length < 32) throw new Error("Egress proxy secret is too short");
  const allow = options.allow ?? isAllowedDestination;
  const resolve = options.resolve ?? resolveAll;

  function refuse(client: Socket, status: string) {
    client.end(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  }

  async function open(client: Socket, head: string, rest: Buffer) {
    const [requestLine = "", ...headerLines] = head.split("\r\n");
    const [method, target, version] = requestLine.split(" ");
    const authorization = headerLines
      .find((line) => line.toLowerCase().startsWith("proxy-authorization:"))
      ?.slice("proxy-authorization:".length)
      .trim();
    if (
      !authorization?.startsWith("Bearer ") ||
      !sameSecret(authorization.slice(7), options.secret)
    )
      return refuse(client, "407 Proxy Authentication Required");
    const destination =
      method === "CONNECT" && version?.startsWith("HTTP/1.") && target
        ? parseConnectTarget(target)
        : null;
    if (!destination) return refuse(client, "400 Bad Request");
    let addresses: string[];
    try {
      addresses = await resolve(destination.host);
    } catch {
      return refuse(client, "502 Bad Gateway");
    }
    // Every answer must be allowed, so a name that also points inside cannot be used to reach in.
    if (!addresses.length || !addresses.every((candidate) => allow(candidate, destination.port)))
      return refuse(client, "403 Forbidden");
    // Connect to the addresses just checked, in order, never to the name again.
    let upstream: Socket | undefined;
    for (const address of addresses) {
      if (client.destroyed) return;
      upstream = await reach(address, destination.port);
      if (upstream) break;
    }
    if (!upstream) return refuse(client, "502 Bad Gateway");
    const connected = upstream;
    if (client.destroyed) return connected.destroy();
    client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (rest.length) connected.write(rest);
    client.pipe(connected);
    connected.pipe(client);
    connected.on("error", () => connected.destroy());
    connected.once("close", () => client.destroy());
    client.once("close", () => connected.destroy());
  }

  /** A connected socket, or undefined when that address does not answer. */
  function reach(address: string, port: number): Promise<Socket | undefined> {
    return new Promise((done) => {
      const socket = connect({ host: address, port });
      socket.setTimeout(CONNECT_TIMEOUT_MS, () => socket.destroy());
      socket.once("connect", () => {
        socket.setTimeout(0);
        socket.removeAllListeners("close");
        done(socket);
      });
      socket.once("error", () => undefined);
      socket.once("close", () => done(undefined));
    });
  }

  return createServer({ noDelay: true }, (client) => {
    client.on("error", () => client.destroy());
    // Listening on 127.0.0.1 already keeps other machines out; this refuses anything else regardless.
    if (client.remoteAddress !== "127.0.0.1") {
      client.destroy();
      return;
    }
    client.setTimeout(HEAD_TIMEOUT_MS, () => client.destroy());
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) {
        if (buffered.length > MAX_HEAD_BYTES) client.destroy();
        return;
      }
      client.off("data", onData);
      client.pause();
      client.setTimeout(0);
      void open(
        client,
        buffered.subarray(0, end).toString("latin1"),
        buffered.subarray(end + 4),
      ).then(
        () => client.resume(),
        () => client.destroy(),
      );
    };
    client.on("data", onData);
  });
}
