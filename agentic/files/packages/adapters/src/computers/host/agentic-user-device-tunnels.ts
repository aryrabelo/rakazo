// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
//
// Opens a "route traffic through this computer" tunnel to a user's connected device from any
// API process. The device socket lives in one API process; a tunnel asked for elsewhere is
// carried to it over an internal HTTP upgrade authorized by the device forward secret, so bytes
// never pass through the database.
import type { IncomingMessage } from "node:http";
import { request as httpRequest } from "node:http";
import type { Duplex } from "node:stream";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import type { TunnelDestinationPolicy } from "./agentic-tunnel-policy.js";
import {
  checkTunnelDestination,
  TUNNEL_PORTS,
  TunnelBusyError,
  TunnelFailedError,
  TunnelRefusedError,
  TunnelUnavailableError,
} from "./agentic-tunnel-policy.js";
import { TUNNEL_OPEN_TIMEOUT_MS } from "./agentic-tunnel-protocol.js";
import type { UserDeviceHub, UserDeviceRoute } from "./user-device-gateway.js";
import { validUserDeviceForwardSecret } from "./user-device-gateway.js";

/** Internal upgrade path between API processes. Not under /api, so the public proxy never routes it. */
export const USER_DEVICE_TUNNEL_PATH = "/internal/user-devices/tunnel";
/** The Upgrade token of every internal tunnel; after 101 the connection carries raw bytes. */
export const TUNNEL_UPGRADE = "rakazo-tunnel";
export const TUNNEL_HOST_HEADER = "x-rakazo-tunnel-host";
export const TUNNEL_PORT_HEADER = "x-rakazo-tunnel-port";
const DEVICE_HEADER = "x-rakazo-device";
const USER_HEADER = "x-rakazo-user";
const CONNECTION_HEADER = "x-rakazo-connection";
/** How long a closed side waits for the other to flush before both are destroyed. */
const LINGER_MS = 5_000;
/** A connection row older than this has lost its holding process (as in user-device-gateway). */
const STALE_AFTER_MS = 75_000;

const STATUS_TEXT: Record<number, string> = {
  101: "Switching Protocols",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  409: "Conflict",
  502: "Bad Gateway",
  503: "Service Unavailable",
};

/** The upgrade status a tunnel failure answers with. */
export function tunnelErrorStatus(error: unknown): number {
  if (error instanceof TunnelUnavailableError) return 409;
  if (error instanceof TunnelRefusedError) return 403;
  if (error instanceof TunnelBusyError) return 503;
  return 502;
}

function tunnelErrorFromStatus(status: number): Error {
  if (status === 409) return new TunnelUnavailableError();
  if (status === 403) return new TunnelRefusedError();
  if (status === 503) return new TunnelBusyError();
  return new TunnelFailedError();
}

/** Answers an upgrade request without upgrading, then closes it. */
export function refuseTunnelUpgrade(socket: Duplex, status: number): void {
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
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

/** Completes an upgrade and joins its connection to the tunnel. */
export function acceptTunnelUpgrade(socket: Duplex, head: Buffer, tunnel: Duplex): void {
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: ${TUNNEL_UPGRADE}\r\n\r\n`,
  );
  if (head.length) tunnel.write(head);
  spliceStreams(socket, tunnel);
}

/**
 * Asks for an internal tunnel upgrade; resolves with the raw connection on 101 and rejects with
 * the matching tunnel error otherwise.
 */
export function requestTunnelUpgrade(
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
  timeoutMs = TUNNEL_OPEN_TIMEOUT_MS + 5_000,
): Promise<Duplex> {
  return new Promise<Duplex>((resolve, reject) => {
    signal.throwIfAborted();
    const request = httpRequest(url, {
      method: "GET",
      headers: { ...headers, connection: "Upgrade", upgrade: TUNNEL_UPGRADE },
    });
    // Only the handshake is bounded: once upgraded, the connection lives as long as the tunnel.
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      finish();
    };
    const abort = () => {
      const reason = signal.aborted ? signal.reason : new TunnelFailedError("No answer in time");
      settle(() => reject(reason));
      request.destroy();
    };
    const timer = setTimeout(abort, timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    request.once("upgrade", (_response: IncomingMessage, socket: Duplex, head: Buffer) => {
      if (head.length) socket.unshift(head);
      settle(() => resolve(socket));
    });
    request.once("response", (response: IncomingMessage) => {
      response.resume();
      settle(() => reject(tunnelErrorFromStatus(response.statusCode ?? 502)));
    });
    request.once("error", (error) =>
      settle(() => reject(new TunnelUnavailableError(undefined, { cause: error }))),
    );
    request.end();
  });
}

/** One header's single value, or null. */
export function headerValue(request: IncomingMessage, name: string): string | null {
  const value = request.headers[name];
  return typeof value === "string" && value.length <= 253 ? value : null;
}

/** The destination an upgrade names, or null when malformed. */
export function tunnelTarget(request: IncomingMessage): { host: string; port: number } | null {
  const host = headerValue(request, TUNNEL_HOST_HEADER);
  const port = Number(headerValue(request, TUNNEL_PORT_HEADER));
  if (!host || !Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { host, port };
}

/** Aborts when the upgrade's connection closes before the tunnel is ready. */
function closeSignal(socket: Duplex): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const abort = () => controller.abort(new Error("Connection closed"));
  socket.once("close", abort);
  return { signal: controller.signal, done: () => socket.off("close", abort) };
}

export interface UserDeviceTunnelsDeps {
  prisma: PrismaClient;
  /** userDeviceForwardSecret(ENCRYPTION_KEY). */
  forwardSecret: string;
  /** Present in API processes, which hold device sockets. */
  hub?: UserDeviceHub;
  /** Tests relax the destination rules here; production uses the defaults. */
  destination?: TunnelDestinationPolicy;
}

/** Tunnels through a user's connected device whose "route traffic" switch is on. */
export class UserDeviceTunnels {
  constructor(private readonly deps: UserDeviceTunnelsDeps) {}

  /**
   * Opens a tunnel to host:port through the first of the user's connected devices, in pairing
   * order, that routes traffic. Throws TunnelUnavailableError when none does.
   */
  async open(userId: string, host: string, port: number, signal: AbortSignal): Promise<Duplex> {
    await checkTunnelDestination(host, port, this.deps.destination);
    const connections = await runAsSystem("find a user's devices that may route traffic", () =>
      this.deps.prisma.userDeviceConnection.findMany({
        where: {
          heartbeatAt: { gt: new Date(Date.now() - STALE_AFTER_MS) },
          device: { userId, revokedAt: null },
        },
        orderBy: [{ device: { createdAt: "asc" } }, { deviceId: "asc" }],
        select: { deviceId: true, connectionId: true, address: true },
      }),
    );
    for (const connection of connections) {
      const route = {
        deviceId: connection.deviceId,
        userId,
        connectionId: connection.connectionId,
      };
      try {
        if (this.deps.hub?.holds(route))
          return await this.deps.hub.openTunnel(route, host, port, signal);
        return await this.forward(connection.address, route, host, port, signal);
      } catch (error) {
        signal.throwIfAborted();
        if (!(error instanceof TunnelUnavailableError)) throw error;
      }
    }
    throw new TunnelUnavailableError();
  }

  private forward(
    address: string,
    route: UserDeviceRoute,
    host: string,
    port: number,
    signal: AbortSignal,
  ): Promise<Duplex> {
    return requestTunnelUpgrade(
      new URL(USER_DEVICE_TUNNEL_PATH, address),
      {
        authorization: `Bearer ${this.deps.forwardSecret}`,
        [DEVICE_HEADER]: route.deviceId,
        [USER_HEADER]: route.userId,
        [CONNECTION_HEADER]: route.connectionId,
        [TUNNEL_HOST_HEADER]: host,
        [TUNNEL_PORT_HEADER]: String(port),
      },
      signal,
    );
  }

  /**
   * Node `upgrade` handling for USER_DEVICE_TUNNEL_PATH: another API process asks this one for
   * a tunnel through a device socket it holds.
   */
  handleForwardedUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    const hub = this.deps.hub;
    const deviceId = headerValue(request, DEVICE_HEADER);
    const userId = headerValue(request, USER_HEADER);
    const connectionId = headerValue(request, CONNECTION_HEADER);
    const target = tunnelTarget(request);
    const route = deviceId && userId && connectionId ? { deviceId, userId, connectionId } : null;
    // The asking process resolved and checked the destination; the port is cheap to hold here too.
    const refusal = !hub
      ? 404
      : !validUserDeviceForwardSecret(this.deps.forwardSecret, request.headers.authorization)
        ? 401
        : !route || !target
          ? 400
          : !(this.deps.destination?.ports ?? TUNNEL_PORTS).has(target.port)
            ? 403
            : !hub.holds(route)
              ? 409
              : null;
    if (refusal !== null || !hub || !route || !target) {
      refuseTunnelUpgrade(socket, refusal ?? 400);
      return;
    }
    const { signal, done } = closeSignal(socket);
    hub.openTunnel(route, target.host, target.port, signal).then(
      (tunnel) => {
        done();
        if (socket.destroyed) return tunnel.destroy();
        acceptTunnelUpgrade(socket, head, tunnel);
      },
      (error: unknown) => {
        done();
        if (!(error instanceof TunnelUnavailableError))
          getLogger().info("forwarded device tunnel refused", { error });
        if (!socket.destroyed) refuseTunnelUpgrade(socket, tunnelErrorStatus(error));
      },
    );
  }
}
