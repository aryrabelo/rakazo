// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
//
// "Route traffic through this computer": TCP tunnels carried over the paired device's existing
// WebSocket (user-device-protocol.ts). The server opens a tunnel to host:port; the desktop app
// connects through its local egress proxy, which listens on loopback only, reaches only public
// addresses and has no file access. Bytes travel base64 in tunnel-data, both ways.
import { z } from "zod";

/** Largest raw chunk in one tunnel-data message; base64 grows it by 4/3. */
export const TUNNEL_CHUNK_BYTES = 32 * 1024;
/** Open tunnels one device carries at once; a further tunnel-open is refused with tunnel-close. */
export const TUNNEL_MAX_OPEN = 64;
/** A tunnel-open not answered by tunnel-opened or tunnel-close within this is closed. */
export const TUNNEL_OPEN_TIMEOUT_MS = 20_000;

const tunnelId = z.string().min(1).max(64);
const tunnelData = z
  .string()
  .max(Math.ceil(TUNNEL_CHUNK_BYTES / 3) * 4)
  .regex(/^[A-Za-z0-9+/]*={0,2}$/);

/** Server → desktop. */
export const agenticTunnelServerMessages = [
  z.object({
    type: z.literal("tunnel-open"),
    id: tunnelId,
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65_535),
  }),
  z.object({ type: z.literal("tunnel-data"), id: tunnelId, data: tunnelData }),
  z.object({ type: z.literal("tunnel-close"), id: tunnelId }),
] as const;

/** Desktop → server. */
export const agenticTunnelClientMessages = [
  z.object({ type: z.literal("tunnel-opened"), id: tunnelId }),
  z.object({ type: z.literal("tunnel-data"), id: tunnelId, data: tunnelData }),
  z.object({
    type: z.literal("tunnel-close"),
    id: tunnelId,
    error: z.string().max(200).optional(),
  }),
  /** Sent after connecting and whenever the person flips the toggle. */
  z.object({ type: z.literal("route-traffic"), enabled: z.boolean() }),
] as const;
