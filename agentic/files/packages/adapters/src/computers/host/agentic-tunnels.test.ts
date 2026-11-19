// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
import { EventEmitter, once } from "node:events";
import type { Server as HttpServer } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo, Server, Socket } from "node:net";
import { connect, createServer } from "node:net";
import type { Duplex } from "node:stream";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";
import { deviceTunnelMessage, openDeviceTunnel } from "./agentic-device-tunnels.js";
import {
  checkTunnelDestination,
  isPublicAddress,
  TunnelBusyError,
  TunnelFailedError,
  TunnelRefusedError,
  TunnelUnavailableError,
} from "./agentic-tunnel-policy.js";
import { TUNNEL_CHUNK_BYTES, TUNNEL_MAX_OPEN } from "./agentic-tunnel-protocol.js";
import { UserDeviceTunnels } from "./agentic-user-device-tunnels.js";
import type { UserDeviceSocket } from "./user-device-gateway.js";
import { UserDeviceHub, userDeviceForwardSecret } from "./user-device-gateway.js";

const secret = userDeviceForwardSecret("test-encryption-key");
const device = { id: "device-1", userId: "user-1", name: "Laptop", platform: "darwin" };
const cleanups: Array<() => unknown> = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** The Prisma calls the hub and tunnels make, over one in-memory connection table. */
function fakePrisma() {
  const connections = new Map<
    string,
    { deviceId: string; connectionId: string; address: string; heartbeatAt: Date }
  >();
  const prisma = {
    userDevice: {
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => null,
      findMany: async () => [],
    },
    userDeviceConnection: {
      upsert: async ({
        create,
      }: {
        create: { deviceId: string; connectionId: string; address: string; heartbeatAt: Date };
      }) => connections.set(create.deviceId, { ...create }),
      updateMany: async () => ({ count: 0 }),
      deleteMany: async ({ where }: { where: { connectionId: string | { in: string[] } } }) => {
        const gone =
          typeof where.connectionId === "string" ? [where.connectionId] : where.connectionId.in;
        for (const [key, row] of connections)
          if (gone.includes(row.connectionId)) connections.delete(key);
        return { count: 0 };
      },
      findMany: async ({ where }: { where: { device: { userId: string } } }) =>
        where.device.userId === device.userId ? [...connections.values()] : [],
    },
    session: { findMany: async () => [] },
    $transaction: (run: (tx: unknown) => Promise<unknown>) => run(prisma),
  };
  return { prisma: prisma as unknown as PrismaClient, connections };
}

/** A desktop speaking the tunnel contract: connects tunnels to whatever TCP address it is told. */
class FakeDevice extends EventEmitter implements UserDeviceSocket {
  bufferedAmount = 0;
  answer = true;
  sent: Array<Record<string, unknown>> = [];
  private readonly sockets = new Map<string, Socket>();

  send(data: string) {
    const message = JSON.parse(data) as Record<string, unknown>;
    this.sent.push(message);
    const id = String(message.id);
    if (message.type === "tunnel-open" && this.answer) {
      const socket = connect(Number(message.port), String(message.host));
      this.sockets.set(id, socket);
      socket.once("connect", () => this.reply({ type: "tunnel-opened", id }));
      // A desktop sends at most TUNNEL_CHUNK_BYTES per message; larger ones are dropped.
      socket.on("data", (chunk: Buffer) => {
        for (let offset = 0; offset < chunk.length; offset += TUNNEL_CHUNK_BYTES)
          this.reply({
            type: "tunnel-data",
            id,
            data: chunk.subarray(offset, offset + TUNNEL_CHUNK_BYTES).toString("base64"),
          });
      });
      socket.once("close", () => {
        if (this.sockets.delete(id)) this.reply({ type: "tunnel-close", id });
      });
      socket.on("error", () => undefined);
    } else if (message.type === "tunnel-data") {
      this.sockets.get(id)?.write(Buffer.from(String(message.data), "base64"));
    } else if (message.type === "tunnel-close") {
      const socket = this.sockets.get(id);
      this.sockets.delete(id);
      socket?.destroy();
    }
  }
  reply(message: object) {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
  route(enabled: boolean) {
    this.reply({ type: "route-traffic", enabled });
  }
  close() {
    for (const socket of this.sockets.values()) socket.destroy();
    this.sockets.clear();
    this.emit("close");
  }
  ping() {}
  terminate() {
    this.close();
  }
}

async function listening<T extends Server | HttpServer>(server: T): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as AddressInfo).port;
}

/** A TCP target that echoes what it receives. */
async function echoServer() {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.pipe(socket);
  });
  cleanups.push(() => {
    for (const socket of sockets) socket.destroy();
  });
  return listening(server);
}

/** Loopback is a test target here; production allows only public addresses on 80 and 443. */
const loopbackPolicy = (port: number) => ({
  ports: new Set([port]),
  allowAddress: (address: string) => address === "127.0.0.1",
});

async function roundTrip(tunnel: Duplex, text: string) {
  const reply = once(tunnel, "data");
  tunnel.write(text);
  const [chunk] = (await reply) as [Buffer];
  return chunk.toString();
}

async function setup(address = "http://127.0.0.1:1") {
  const db = fakePrisma();
  const hub = new UserDeviceHub({ prisma: db.prisma, address });
  cleanups.push(() => hub.close());
  const socket = new FakeDevice();
  await hub.attach(device, socket);
  return { ...db, hub, socket };
}

describe("tunnel destinations", () => {
  it("allows only public addresses", () => {
    for (const address of ["93.184.216.34", "2606:4700::1111", "::ffff:8.8.8.8"])
      expect(isPublicAddress(address), address).toBe(true);
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "100.64.0.1",
      "169.254.169.254",
      "224.0.0.1",
      "0.0.0.0",
      "::1",
      "::",
      "fd00::1",
      "fe80::1",
      "::ffff:10.0.0.1",
      "::ffff:127.0.0.1",
      "64:ff9b::a00:1",
      "not-an-ip",
    ])
      expect(isPublicAddress(address), address).toBe(false);
  });

  it("refuses other ports and names that resolve inside a network", async () => {
    const publicOnly = { lookup: async () => ["93.184.216.34"] };
    await expect(checkTunnelDestination("example.com", 443, publicOnly)).resolves.toBeUndefined();
    await expect(checkTunnelDestination("example.com", 22, publicOnly)).rejects.toThrow(
      TunnelRefusedError,
    );
    await expect(checkTunnelDestination("10.0.0.1", 80)).rejects.toThrow(TunnelRefusedError);
    await expect(
      checkTunnelDestination("rebind.example", 443, {
        lookup: async () => ["93.184.216.34", "127.0.0.1"],
      }),
    ).rejects.toThrow(TunnelRefusedError);
  });
});

describe("device tunnels", () => {
  it("carries bytes both ways through a routing device", async () => {
    const port = await echoServer();
    const { prisma, hub, socket } = await setup();
    socket.route(true);
    const tunnels = new UserDeviceTunnels({
      prisma,
      forwardSecret: secret,
      hub,
      destination: loopbackPolicy(port),
    });
    const tunnel = await tunnels.open(device.userId, "127.0.0.1", port, AbortSignal.timeout(5_000));
    expect(await roundTrip(tunnel, "hello")).toBe("hello");
    // Larger than one tunnel-data chunk.
    const big = "x".repeat(100_000);
    let received = "";
    tunnel.on("data", (chunk: Buffer) => {
      received += chunk.toString();
    });
    tunnel.write(big);
    await expect.poll(() => received.length).toBe(big.length);
    expect(socket.sent.some((message) => message.type === "tunnel-open")).toBe(true);
    tunnel.destroy();
  });

  it("refuses when the device's switch is off or another user asks", async () => {
    const port = await echoServer();
    const { prisma, hub, socket } = await setup();
    const tunnels = new UserDeviceTunnels({
      prisma,
      forwardSecret: secret,
      hub,
      destination: loopbackPolicy(port),
    });
    const signal = AbortSignal.timeout(5_000);
    await expect(tunnels.open(device.userId, "127.0.0.1", port, signal)).rejects.toThrow(
      TunnelUnavailableError,
    );
    socket.route(true);
    await expect(tunnels.open("user-2", "127.0.0.1", port, signal)).rejects.toThrow(
      TunnelUnavailableError,
    );
    expect(socket.sent.some((message) => message.type === "tunnel-open")).toBe(false);
  });

  it("checks the destination before asking the device", async () => {
    const { prisma, hub, socket } = await setup();
    socket.route(true);
    const tunnels = new UserDeviceTunnels({ prisma, forwardSecret: secret, hub });
    await expect(
      tunnels.open(device.userId, "192.168.0.10", 443, AbortSignal.timeout(5_000)),
    ).rejects.toThrow(TunnelRefusedError);
    expect(socket.sent).toEqual([]);
  });

  it("ends open tunnels when the device disconnects or switches off", async () => {
    const port = await echoServer();
    const { prisma, hub, socket } = await setup();
    socket.route(true);
    const tunnels = new UserDeviceTunnels({
      prisma,
      forwardSecret: secret,
      hub,
      destination: loopbackPolicy(port),
    });
    const signal = AbortSignal.timeout(5_000);
    const first = await tunnels.open(device.userId, "127.0.0.1", port, signal);
    first.resume();
    const firstEnded = once(first, "end");
    socket.route(false);
    await firstEnded;
    expect(socket.sent.some((message) => message.type === "tunnel-close")).toBe(true);

    socket.route(true);
    const second = await tunnels.open(device.userId, "127.0.0.1", port, signal);
    second.resume();
    const secondEnded = once(second, "end");
    socket.close();
    await secondEnded;
    await expect(tunnels.open(device.userId, "127.0.0.1", port, signal)).rejects.toThrow(
      TunnelUnavailableError,
    );
  });

  it("holds the per-device limit and the open timeout", async () => {
    const socket = new FakeDevice();
    socket.answer = false;
    const entry = { socket };
    deviceTunnelMessage(entry, { type: "route-traffic", enabled: true });
    // A silent device: every open waits, so the limit is reached without any connection.
    const controller = new AbortController();
    const pending = Array.from({ length: TUNNEL_MAX_OPEN }, () =>
      openDeviceTunnel(entry, "example.com", 443, controller.signal).catch((error) => error),
    );
    await expect(openDeviceTunnel(entry, "example.com", 443, controller.signal)).rejects.toThrow(
      TunnelBusyError,
    );
    controller.abort(new Error("done"));
    await Promise.all(pending);
    await expect(
      openDeviceTunnel(entry, "example.com", 443, AbortSignal.timeout(5_000), 50),
    ).rejects.toThrow(TunnelFailedError);
    const closes = socket.sent.filter((message) => message.type === "tunnel-close");
    expect(closes).toHaveLength(TUNNEL_MAX_OPEN + 1);
  });

  it("forwards a tunnel to the process holding the device", async () => {
    const port = await echoServer();
    let holder: UserDeviceTunnels | undefined;
    const server = createHttpServer((_request, response) => response.end());
    server.on("upgrade", (request, upgraded: Duplex, head: Buffer) =>
      holder!.handleForwardedUpgrade(request, upgraded, head),
    );
    const apiPort = await listening(server);
    const { prisma, hub, socket } = await setup(`http://127.0.0.1:${apiPort}`);
    socket.route(true);
    holder = new UserDeviceTunnels({
      prisma,
      forwardSecret: secret,
      hub,
      destination: loopbackPolicy(port),
    });
    // Another process: no hub, so it must forward.
    const other = new UserDeviceTunnels({
      prisma,
      forwardSecret: secret,
      destination: loopbackPolicy(port),
    });
    const tunnel = await other.open(device.userId, "127.0.0.1", port, AbortSignal.timeout(5_000));
    expect(await roundTrip(tunnel, "across")).toBe("across");
    tunnel.destroy();

    const intruder = new UserDeviceTunnels({
      prisma,
      forwardSecret: "wrong-secret",
      destination: loopbackPolicy(port),
    });
    await expect(
      intruder.open(device.userId, "127.0.0.1", port, AbortSignal.timeout(5_000)),
    ).rejects.toThrow(TunnelFailedError);
  });
});
