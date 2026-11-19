// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
//
// "Route traffic through this computer", API side. The sandbox supervisor asks for a tunnel for
// one computer; this resolves whose computer it is and opens the tunnel through that person's
// connected desktop when its switch is on. Both internal paths are HTTP upgrades that the public
// proxy never routes (not under /api), each with its own secret.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type { TunnelDestinationPolicy, UserDeviceHub } from "@rakazo/adapters";
import {
  acceptTunnelUpgrade,
  headerValue,
  refuseTunnelUpgrade,
  TunnelUnavailableError,
  tunnelErrorStatus,
  tunnelTarget,
  USER_DEVICE_TUNNEL_PATH,
  UserDeviceTunnels,
} from "@rakazo/adapters";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";

/** Where the supervisor asks for a computer's tunnel. */
export const COMPUTER_TUNNEL_PATH = "/internal/computers/tunnel";
/** The computer's home key, which the supervisor knows each computer by. */
export const COMPUTER_TUNNEL_COMPUTER_HEADER = "x-rakazo-computer";

type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * The supervisor's credential for COMPUTER_TUNNEL_PATH, derived from SANDBOX_SUPERVISOR_TOKEN,
 * the secret the API and supervisor already share. The supervisor never holds ENCRYPTION_KEY,
 * and a derived value cannot be replayed as the token the API uses to drive the supervisor.
 */
export function computerTunnelSecret(supervisorToken: string): string {
  return createHmac("sha256", supervisorToken).update("rakazo:computer-tunnel:v1").digest("hex");
}

function validBearer(expected: string, header: string | undefined): boolean {
  const supplied = /^Bearer (.+)$/.exec(header ?? "")?.[1];
  if (!supplied) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(supplied);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * The person whose desktop may carry a computer's browser traffic, or null when nobody's may.
 * A computer belongs to `computers.userId`, but a Space's members share its computers and bots
 * of several people can sit on one Team computer. So it routes only while every bot on it
 * belongs to that person and nobody else (person or another person's bot) holds its control.
 */
export async function computerRouteOwner(
  prisma: PrismaClient,
  homeKey: string,
): Promise<string | null> {
  const computer = await runAsSystem("find whose desktop routes a computer's traffic", () =>
    prisma.computer.findUnique({
      where: { homeKey },
      select: {
        userId: true,
        controlHolder: true,
        controlUserId: true,
        controlBotId: true,
        bots: { select: { id: true, userId: true } },
      },
    }),
  );
  if (!computer?.userId) return null;
  const owner = computer.userId;
  if (!computer.bots.every((bot) => bot.userId === owner)) return null;
  if (computer.controlHolder === "user" && computer.controlUserId !== owner) return null;
  if (
    computer.controlHolder === "bot" &&
    !computer.bots.some((bot) => bot.id === computer.controlBotId)
  )
    return null;
  return owner;
}

export interface RouteTrafficDeps {
  prisma: PrismaClient;
  /** userDeviceForwardSecret(ENCRYPTION_KEY). */
  forwardSecret: string;
  /** SANDBOX_SUPERVISOR_TOKEN; without it the supervisor cannot ask. */
  supervisorToken?: string;
  /** Tests relax the destination rules here. */
  destination?: TunnelDestinationPolicy;
}

/**
 * The API's `upgrade` listener: the two tunnel paths, then the device hub's own upgrades.
 * Undefined when this process holds no device sockets, as before.
 */
export function routeTrafficUpgrade(
  hub: UserDeviceHub | undefined,
  deps: RouteTrafficDeps,
): UpgradeHandler | undefined {
  if (!hub) return undefined;
  const tunnels = new UserDeviceTunnels({
    prisma: deps.prisma,
    forwardSecret: deps.forwardSecret,
    hub,
    destination: deps.destination,
  });
  const supervisorSecret = deps.supervisorToken
    ? computerTunnelSecret(deps.supervisorToken)
    : undefined;
  return (request, socket, head) => {
    const path = new URL(request.url ?? "/", "http://api").pathname;
    if (path === USER_DEVICE_TUNNEL_PATH) {
      socket.on("error", (error) => getLogger().info("device tunnel socket error", { error }));
      return tunnels.handleForwardedUpgrade(request, socket, head);
    }
    if (path !== COMPUTER_TUNNEL_PATH) return hub.handleUpgrade(request, socket, head);
    socket.on("error", (error) => getLogger().info("computer tunnel socket error", { error }));
    if (!supervisorSecret) return refuseTunnelUpgrade(socket, 404);
    if (!validBearer(supervisorSecret, request.headers.authorization))
      return refuseTunnelUpgrade(socket, 401);
    const computer = headerValue(request, COMPUTER_TUNNEL_COMPUTER_HEADER);
    const target = tunnelTarget(request);
    if (!computer || !target) return refuseTunnelUpgrade(socket, 400);
    const controller = new AbortController();
    const abort = () => controller.abort(new Error("Connection closed"));
    socket.once("close", abort);
    void (async () => {
      const owner = await computerRouteOwner(deps.prisma, computer);
      if (!owner) throw new TunnelUnavailableError("Nobody's computer routes this traffic");
      return tunnels.open(owner, target.host, target.port, controller.signal);
    })().then(
      (tunnel) => {
        socket.off("close", abort);
        if (socket.destroyed) return tunnel.destroy();
        acceptTunnelUpgrade(socket, head, tunnel);
      },
      (error: unknown) => {
        socket.off("close", abort);
        const status = tunnelErrorStatus(error);
        if (status === 502) getLogger().warn("computer tunnel failed", { error });
        if (!socket.destroyed) refuseTunnelUpgrade(socket, status);
      },
    );
  };
}
