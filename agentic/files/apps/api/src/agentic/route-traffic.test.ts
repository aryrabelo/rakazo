// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
import { EventEmitter, once } from "node:events";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import type { AddressInfo, Server, Socket } from "node:net";
import { connect, createServer } from "node:net";
import type { Duplex } from "node:stream";
import type { UserDeviceSocket } from "@rakazo/adapters";
import { UserDeviceHub, userDeviceForwardSecret } from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it } from "vitest";
import {
  COMPUTER_TUNNEL_PATH,
  computerRouteOwner,
  computerTunnelSecret,
  routeTrafficUpgrade,
} from "./route-traffic.js";

const SUPERVISOR_TOKEN = "supervisor-token-for-tests";
const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

interface ComputerRow {
  homeKey: string;
  userId: string;
  controlHolder: string;
  controlUserId: string | null;
  controlBotId: string | null;
  bots: { id: string; userId: string }[];
}

function fakePrisma(computers: ComputerRow[]) {
  const connections = new Map<string, Record<string, unknown>>();
  const prisma = {
    computer: {
      findUnique: async ({ where }: { where: { homeKey: string } }) =>
        computers.find((row) => row.homeKey === where.homeKey) ?? null,
    },
    userDevice: {
      update: async () => ({}),
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => null,
      findMany: async () => [],
    },
    userDeviceConnection: {
      upsert: async ({ create }: { create: { deviceId: string } }) =>
        connections.set(create.deviceId, create),
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
      findMany: async ({ where }: { where: { device: { userId: string } } }) =>
        where.device.userId === "owner" ? [...connections.values()] : [],
    },
    session: { findMany: async () => [] },
    $transaction: (run: (tx: unknown) => Promise<unknown>) => run(prisma),
  };
  return prisma as unknown as PrismaClient;
}

const computer = (overrides: Partial<ComputerRow> = {}): ComputerRow => ({
  homeKey: "home-1",
  userId: "owner",
  controlHolder: "none",
  controlUserId: null,
  controlBotId: null,
  bots: [{ id: "bot-1", userId: "owner" }],
  ...overrides,
});

/** A desktop that connects every tunnel to the TCP address it is told. */
class FakeDevice extends EventEmitter implements UserDeviceSocket {
  private readonly sockets = new Map<string, Socket>();
  send(data: string) {
    const message = JSON.parse(data) as {
      type: string;
      id: string;
      host?: string;
      port?: number;
      data?: string;
    };
    if (message.type === "tunnel-open") {
      const socket = connect(message.port!, message.host!);
      this.sockets.set(message.id, socket);
      socket.on("error", () => undefined);
      socket.once("connect", () => this.reply({ type: "tunnel-opened", id: message.id }));
      socket.on("data", (chunk: Buffer) =>
        this.reply({ type: "tunnel-data", id: message.id, data: chunk.toString("base64") }),
      );
    } else if (message.type === "tunnel-data") {
      this.sockets.get(message.id)?.write(Buffer.from(message.data!, "base64"));
    } else if (message.type === "tunnel-close") {
      this.sockets.get(message.id)?.destroy();
    }
  }
  reply(message: object) {
    this.emit("message", Buffer.from(JSON.stringify(message)));
  }
  close() {
    for (const socket of this.sockets.values()) socket.destroy();
    this.emit("close");
  }
  ping() {}
  terminate() {
    this.close();
  }
}

async function listen(server: Server | HttpServer): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as AddressInfo).port;
}

/** What the supervisor sends; resolves with the upgraded socket or the refusal status. */
function askForTunnel(apiPort: number, headers: Record<string, string>) {
  return new Promise<{ status: number; socket?: Duplex }>((resolve, reject) => {
    const request = httpRequest({
      host: "127.0.0.1",
      port: apiPort,
      path: COMPUTER_TUNNEL_PATH,
      headers: { connection: "Upgrade", upgrade: "rakazo-tunnel", ...headers },
    });
    request.once("upgrade", (_response: IncomingMessage, socket: Duplex) =>
      resolve({ status: 101, socket }),
    );
    request.once("response", (response: IncomingMessage) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0 });
    });
    request.once("error", reject);
    request.end();
  });
}

async function setup(rows: ComputerRow[]) {
  const echo = createServer((socket) => {
    socket.on("error", () => undefined);
    socket.pipe(socket);
  });
  const echoPort = await listen(echo);
  const prisma = fakePrisma(rows);
  const server = createHttpServer((_request, response) => response.end());
  const apiPort = await listen(server);
  const hub = new UserDeviceHub({ prisma, address: `http://127.0.0.1:${apiPort}` });
  cleanups.push(() => hub.close());
  const upgrade = routeTrafficUpgrade(hub, {
    prisma,
    forwardSecret: userDeviceForwardSecret("test-encryption-key"),
    supervisorToken: SUPERVISOR_TOKEN,
    destination: {
      ports: new Set([echoPort]),
      allowAddress: (address) => address === "127.0.0.1",
    },
  });
  server.on("upgrade", upgrade!);
  const device = new FakeDevice();
  await hub.attach({ id: "device-1", userId: "owner", name: "Mac", platform: "darwin" }, device);
  const headers = {
    authorization: `Bearer ${computerTunnelSecret(SUPERVISOR_TOKEN)}`,
    "x-rakazo-computer": "home-1",
    "x-rakazo-tunnel-host": "127.0.0.1",
    "x-rakazo-tunnel-port": String(echoPort),
  };
  return { apiPort, device, headers };
}

describe("computer route owner", () => {
  it("is the computer's owner only while nobody else's bot or hand is on it", async () => {
    const owner = (row: ComputerRow) => computerRouteOwner(fakePrisma([row]), "home-1");
    await expect(owner(computer())).resolves.toBe("owner");
    await expect(owner(computer({ bots: [] }))).resolves.toBe("owner");
    await expect(
      owner(
        computer({
          bots: [
            { id: "bot-1", userId: "owner" },
            { id: "bot-2", userId: "other" },
          ],
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      owner(computer({ controlHolder: "user", controlUserId: "other" })),
    ).resolves.toBeNull();
    await expect(owner(computer({ controlHolder: "user", controlUserId: "owner" }))).resolves.toBe(
      "owner",
    );
    await expect(
      owner(computer({ controlHolder: "bot", controlBotId: "bot-9" })),
    ).resolves.toBeNull();
    await expect(computerRouteOwner(fakePrisma([]), "home-1")).resolves.toBeNull();
  });

  it("derives the supervisor's credential the same way the supervisor does", () => {
    expect(computerTunnelSecret(SUPERVISOR_TOKEN)).toBe(
      "f7ddcb6d7ab4a50e477c806f8f9de1cee0e5eae2cdff57511949c53873bac1ff",
    );
  });
});

describe("computer tunnel upgrade", () => {
  it("pipes the supervisor's connection through the owner's routing desktop", async () => {
    const { apiPort, device, headers } = await setup([computer()]);
    device.reply({ type: "route-traffic", enabled: true });
    const { status, socket } = await askForTunnel(apiPort, headers);
    expect(status).toBe(101);
    const reply = once(socket!, "data");
    socket!.write("ping");
    expect(String((await reply)[0])).toBe("ping");
    socket!.destroy();
  });

  it("refuses without the switch, for another user's bot, or without the credential", async () => {
    const { apiPort, device, headers } = await setup([
      computer(),
      computer({ homeKey: "shared", bots: [{ id: "bot-2", userId: "other" }] }),
    ]);
    expect((await askForTunnel(apiPort, headers)).status).toBe(409);
    device.reply({ type: "route-traffic", enabled: true });
    expect(
      (await askForTunnel(apiPort, { ...headers, "x-rakazo-computer": "shared" })).status,
    ).toBe(409);
    expect((await askForTunnel(apiPort, { ...headers, authorization: "Bearer nope" })).status).toBe(
      401,
    );
    expect(
      (await askForTunnel(apiPort, { ...headers, "x-rakazo-tunnel-host": "10.0.0.1" })).status,
    ).toBe(403);
  });
});
