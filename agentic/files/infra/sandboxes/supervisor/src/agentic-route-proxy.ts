// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
//
// One computer's route proxy: an HTTP proxy (CONNECT, and absolute-form requests for http://)
// that the computer's browser reaches on the supervisor's address in that computer's network.
// The listener it was accepted on names the computer, so the computer holds no credential. Each
// connection asks the API for a tunnel through the computer owner's desktop; when there is none
// the connection is reset before any answer, so Chromium falls back to the PAC's DIRECT entry.
import { createHmac } from "node:crypto";
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import type { Server, Socket } from "node:net";
import { BlockList, createServer, isIP } from "node:net";
import type { Duplex } from "node:stream";
import { getLogger } from "@rakazo/logging";

/** The API's tunnel path for computers (apps/api/src/agentic/route-traffic.ts). */
export const COMPUTER_TUNNEL_PATH = "/internal/computers/tunnel";
const MAX_HEAD_BYTES = 16 * 1024;
const HEAD_TIMEOUT_MS = 10_000;
/** The API's own open timeout is 20 s; this bounds the whole ask. */
const OPEN_TIMEOUT_MS = 25_000;
const LINGER_MS = 5_000;
/** Connections one computer's proxy carries at once; the desktop takes 64 tunnels. */
const MAX_CONNECTIONS = 128;
const PORTS: ReadonlySet<number> = new Set([80, 443]);

/** Same derivation as computerTunnelSecret in the API, from SANDBOX_SUPERVISOR_TOKEN. */
export function computerTunnelSecret(supervisorToken: string): string {
  return createHmac("sha256", supervisorToken).update("rakazo:computer-tunnel:v1").digest("hex");
}

const blocked = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 96],
  ["64:ff9b::", 96],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(network, prefix, "ipv6");

/**
 * Whether the proxy may ask for host:port. Ports 80 and 443 only; IP literals must be public;
 * names must be dotted and not local. Names are resolved and checked again by the API and by
 * the desktop, which connects only to the address it checked.
 */
export function routeDestinationAllowed(host: string, port: number): boolean {
  if (!PORTS.has(port)) return false;
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  const family = isIP(bare);
  if (family) return !blocked.check(bare, family === 4 ? "ipv4" : "ipv6");
  const name = bare.toLowerCase();
  if (!/^[a-z0-9.-]{1,253}$/.test(name) || !name.includes(".")) return false;
  return !/(^|\.)(localhost|local|internal)\.?$/.test(name);
}

export interface ProxyRequest {
  host: string;
  port: number;
  /** CONNECT gets a 200 and then raw bytes; anything else is forwarded as `head`. */
  connect: boolean;
  /** What to send the destination first, for a plain HTTP request. */
  head?: Buffer;
}

function splitHostPort(value: string, defaultPort: number): { host: string; port: number } | null {
  const match = /^(\[[0-9a-fA-F:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/.exec(value);
  if (!match) return null;
  const port = match[2] ? Number(match[2]) : defaultPort;
  return { host: match[1]!.replace(/^\[|\]$/g, ""), port };
}

/** Parses a proxy request head (through the blank line); null when it is not one this serves. */
export function parseProxyRequest(head: string): ProxyRequest | null {
  const lines = head.split("\r\n");
  const [method, target, version] = (lines[0] ?? "").split(" ");
  if (!method || !target || !version?.startsWith("HTTP/1.")) return null;
  if (method === "CONNECT") {
    const destination = splitHostPort(target, 443);
    return destination && { ...destination, connect: true };
  }
  let url: URL;
  try {
    url = new URL(target);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || url.username || url.password) return null;
  const destination = splitHostPort(url.host, 80);
  if (!destination) return null;
  // Origin form for the destination, one request per connection, nothing meant for the proxy.
  const headers = lines
    .slice(1)
    .filter(
      (line) =>
        line && !/^(proxy-connection|proxy-authorization|connection|keep-alive):/i.test(line),
    );
  const rewritten = [
    `${method} ${url.pathname}${url.search} ${version}`,
    ...headers,
    "Connection: close",
    "",
    "",
  ].join("\r\n");
  return { ...destination, connect: false, head: Buffer.from(rewritten, "latin1") };
}

/** Pipes two byte streams into each other until either side ends or fails. */
export function spliceStreams(a: Duplex, b: Duplex): void {
  const teardown = () => {
    a.destroy();
    b.destroy();
  };
  a.on("error", teardown);
  b.on("error", teardown);
  a.pipe(b);
  b.pipe(a);
  const linger = (closed: Duplex, other: Duplex) =>
    closed.once("close", () => {
      if (!other.writableEnded) other.end();
      setTimeout(() => other.destroy(), LINGER_MS).unref();
    });
  linger(a, b);
  linger(b, a);
}

/** Asks the API for a tunnel for one computer; resolves with the raw connection on 101. */
export function openApiTunnel(
  apiUrl: URL,
  secret: string,
  computer: string,
  host: string,
  port: number,
  signal: AbortSignal,
): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    signal.throwIfAborted();
    const request = httpRequest(new URL(COMPUTER_TUNNEL_PATH, apiUrl), {
      method: "GET",
      headers: {
        authorization: `Bearer ${secret}`,
        connection: "Upgrade",
        upgrade: "rakazo-tunnel",
        "x-rakazo-computer": computer,
        "x-rakazo-tunnel-host": host,
        "x-rakazo-tunnel-port": String(port),
      },
    });
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      finish();
    };
    const abort = () => {
      settle(() => reject(signal.aborted ? signal.reason : new Error("The API did not answer")));
      request.destroy();
    };
    const timer = setTimeout(abort, OPEN_TIMEOUT_MS);
    signal.addEventListener("abort", abort, { once: true });
    request.once("upgrade", (_response: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (head.length) socket.unshift(head);
      settle(() => resolve(socket));
    });
    request.once("response", (response: IncomingMessage) => {
      response.resume();
      settle(() => reject(new Error(`No route (${response.statusCode})`)));
    });
    request.once("error", (error) => settle(() => reject(error)));
    request.end();
  });
}

/** Reads one request head; resolves with it and whatever followed, or null. */
function readHead(socket: Socket): Promise<{ head: string; rest: Buffer } | null> {
  return new Promise((resolve) => {
    let buffered = Buffer.alloc(0);
    const finish = (value: { head: string; rest: Buffer } | null) => {
      clearTimeout(timer);
      socket.off("data", onData);
      socket.off("end", onEnd);
      socket.pause();
      resolve(value);
    };
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end >= 0)
        finish({
          head: buffered.subarray(0, end + 4).toString("latin1"),
          rest: buffered.subarray(end + 4),
        });
      else if (buffered.length > MAX_HEAD_BYTES) finish(null);
    };
    const onEnd = () => finish(null);
    const timer = setTimeout(() => finish(null), HEAD_TIMEOUT_MS);
    socket.on("data", onData);
    socket.once("end", onEnd);
    socket.resume();
  });
}

export interface RouteProxyOptions {
  /** Opens a tunnel through the computer owner's desktop, or rejects when there is none. */
  openTunnel(host: string, port: number, signal: AbortSignal): Promise<Duplex>;
  /** Whether a connection from this address is the computer itself. */
  isComputer?(remoteAddress: string): boolean | Promise<boolean>;
}

/** Serves one accepted connection. */
export async function handleRouteProxyConnection(
  socket: Socket,
  options: RouteProxyOptions,
): Promise<void> {
  socket.on("error", (error) => getLogger().debug("route proxy socket error", { error }));
  const controller = new AbortController();
  socket.once("close", () => controller.abort(new Error("Connection closed")));
  if (options.isComputer && !(await options.isComputer(socket.remoteAddress ?? ""))) {
    socket.resetAndDestroy();
    return;
  }
  const read = await readHead(socket);
  const request = read && parseProxyRequest(read.head);
  if (!read || !request) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  if (!routeDestinationAllowed(request.host, request.port)) {
    socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    return;
  }
  let tunnel: Duplex;
  try {
    tunnel = await options.openTunnel(request.host, request.port, controller.signal);
  } catch (error) {
    // Off, offline or failed: a reset makes Chromium use DIRECT instead.
    getLogger().debug("route proxy has no tunnel", { error });
    if (!socket.destroyed) socket.resetAndDestroy();
    return;
  }
  if (socket.destroyed) {
    tunnel.destroy();
    return;
  }
  if (request.connect) socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
  else tunnel.write(request.head);
  if (read.rest.length) tunnel.write(read.rest);
  spliceStreams(socket, tunnel);
  socket.resume();
}

/** A route proxy server for one computer; the caller binds it to the computer-network address. */
export function createRouteProxyServer(options: RouteProxyOptions): Server {
  const server = createServer({ pauseOnConnect: true, noDelay: true }, (socket) => {
    void handleRouteProxyConnection(socket, options).catch((error: unknown) => {
      getLogger().warn("route proxy connection failed", { error });
      socket.destroy();
    });
  });
  server.maxConnections = MAX_CONNECTIONS;
  return server;
}
