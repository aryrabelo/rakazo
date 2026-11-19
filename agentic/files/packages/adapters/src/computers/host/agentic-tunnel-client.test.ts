// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
import { once } from "node:events";
import { mkdtemp, realpath } from "node:fs/promises";
import type { Server as HttpServer } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo, Server } from "node:net";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WebSocket } from "ws";
import { WebSocketServer } from "ws";
import type { AgenticRouteTraffic } from "./agentic-tunnel-client.js";
import { TUNNEL_MAX_OPEN } from "./agentic-tunnel-protocol.js";
import type { UserDeviceClient } from "./user-device-client.js";
import { startUserDeviceClient } from "./user-device-client.js";

type Message = { type: string; id?: string; data?: string; error?: string; enabled?: boolean };

describe("agentic tunnels on the paired-device client", () => {
  let http: HttpServer;
  let wss: WebSocketServer;
  let echo: Server;
  let echoPort: number;
  let device: WebSocket;
  let received: Message[];
  let waiters: { match: (m: Message) => boolean; resolve: (m: Message) => void }[];
  let client: UserDeviceClient | undefined;
  let enabled: boolean;
  let listeners: Set<() => void>;
  let hang: boolean;

  function next(match: (m: Message) => boolean): Promise<Message> {
    const found = received.find(match);
    if (found) {
      received.splice(received.indexOf(found), 1);
      return Promise.resolve(found);
    }
    return new Promise((resolve) => waiters.push({ match, resolve }));
  }

  /** Stands in for the egress proxy: the test alone lets loopback through, on the echo's port. */
  const routeTraffic: AgenticRouteTraffic = {
    enabled: () => enabled,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    connect(host, port, signal) {
      if (hang) return new Promise((_, reject) => signal.addEventListener("abort", reject));
      if (host !== "127.0.0.1" || port !== 443)
        return Promise.reject(new Error("Destination not allowed"));
      const socket = connect({ host, port: echoPort });
      return once(socket, "connect").then(() => socket);
    },
  };

  beforeEach(async () => {
    received = [];
    waiters = [];
    enabled = true;
    hang = false;
    listeners = new Set();
    echo = createServer((socket) => socket.pipe(socket));
    echo.listen(0, "127.0.0.1");
    await once(echo, "listening");
    echoPort = (echo.address() as AddressInfo).port;
    http = createHttpServer();
    wss = new WebSocketServer({ noServer: true });
    const connected = new Promise<WebSocket>((resolve) => {
      http.on("upgrade", (request, socket, head) =>
        wss.handleUpgrade(request, socket, head, (ws) => {
          ws.on("message", (data) => {
            const message = JSON.parse(data.toString()) as Message;
            const waiter = waiters.find((w) => w.match(message));
            if (waiter) {
              waiters.splice(waiters.indexOf(waiter), 1);
              waiter.resolve(message);
            } else received.push(message);
          });
          resolve(ws);
        }),
      );
    });
    http.listen(0, "127.0.0.1");
    await once(http, "listening");
    client = startUserDeviceClient({
      serverUrl: `http://127.0.0.1:${(http.address() as AddressInfo).port}`,
      token: "device-token",
      root: await realpath(await mkdtemp(path.join(tmpdir(), "rakazo-tunnel-test-"))),
      onRevoked: () => undefined,
      authorize: async () => true,
      routeTraffic,
    });
    device = await connected;
  });

  afterEach(async () => {
    client?.close();
    client = undefined;
    wss.close();
    http.close();
    echo.close();
  });

  const send = (message: object) => device.send(JSON.stringify(message));

  it("reports the switch on connect and streams bytes both ways", async () => {
    expect(await next((m) => m.type === "route-traffic")).toEqual({
      type: "route-traffic",
      enabled: true,
    });
    send({ type: "tunnel-open", id: "t1", host: "127.0.0.1", port: 443 });
    expect(await next((m) => m.type === "tunnel-opened")).toEqual({
      type: "tunnel-opened",
      id: "t1",
    });
    send({ type: "tunnel-data", id: "t1", data: Buffer.from("hello tunnel").toString("base64") });
    const echoed = await next((m) => m.type === "tunnel-data");
    expect(Buffer.from(echoed.data ?? "", "base64").toString()).toBe("hello tunnel");
    send({ type: "tunnel-close", id: "t1" });
    send({ type: "tunnel-data", id: "t1", data: "" });
    expect(await next((m) => m.type === "tunnel-close")).toMatchObject({ id: "t1" });
  });

  it("refuses a destination the proxy refuses, and ports other than 80 and 443", async () => {
    send({ type: "tunnel-open", id: "far", host: "10.0.0.1", port: 443 });
    expect(await next((m) => m.id === "far")).toEqual({
      type: "tunnel-close",
      id: "far",
      error: "Destination not allowed",
    });
    send({ type: "tunnel-open", id: "ssh", host: "127.0.0.1", port: 22 });
    expect(await next((m) => m.id === "ssh")).toEqual({
      type: "tunnel-close",
      id: "ssh",
      error: "Port not allowed",
    });
  });

  it("refuses every tunnel while the switch is off, and closes open ones when it turns off", async () => {
    await next((m) => m.type === "route-traffic");
    send({ type: "tunnel-open", id: "t1", host: "127.0.0.1", port: 443 });
    await next((m) => m.type === "tunnel-opened");
    enabled = false;
    for (const listener of listeners) listener();
    expect(await next((m) => m.type === "route-traffic")).toEqual({
      type: "route-traffic",
      enabled: false,
    });
    expect(await next((m) => m.id === "t1")).toEqual({
      type: "tunnel-close",
      id: "t1",
      error: "Route traffic is off",
    });
    send({ type: "tunnel-open", id: "t2", host: "127.0.0.1", port: 443 });
    expect(await next((m) => m.id === "t2")).toEqual({
      type: "tunnel-close",
      id: "t2",
      error: "Route traffic is off",
    });
  });

  it(`refuses a tunnel past ${TUNNEL_MAX_OPEN} open ones`, async () => {
    hang = true;
    for (let i = 0; i < TUNNEL_MAX_OPEN; i++)
      send({ type: "tunnel-open", id: `t${i}`, host: "127.0.0.1", port: 443 });
    send({ type: "tunnel-open", id: "extra", host: "127.0.0.1", port: 443 });
    expect(await next((m) => m.id === "extra")).toEqual({
      type: "tunnel-close",
      id: "extra",
      error: "Too many tunnels",
    });
    expect(received.filter((m) => m.type === "tunnel-close")).toEqual([]);
  });
});
