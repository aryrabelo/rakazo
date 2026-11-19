// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
//
// The paired desktop's side of "Route traffic through this computer": carries the server's TCP
// tunnels (agentic-tunnel-protocol.ts) over the device WebSocket. It never opens a socket itself:
// `routeTraffic.connect` goes through the desktop's sandboxed egress proxy, which enforces the
// destination rules again on the resolved address.
import type { Duplex } from "node:stream";
import WebSocket from "ws";
import type { z } from "zod";
import type {
  agenticTunnelClientMessages,
  agenticTunnelServerMessages,
} from "./agentic-tunnel-protocol.js";
import {
  TUNNEL_CHUNK_BYTES,
  TUNNEL_MAX_OPEN,
  TUNNEL_OPEN_TIMEOUT_MS,
} from "./agentic-tunnel-protocol.js";

export interface AgenticRouteTraffic {
  /** Whether this computer currently routes this server's traffic. Asked on every tunnel-open. */
  enabled(): boolean;
  /** Opens host:port through the egress proxy; rejects for a refused or unreachable destination. */
  connect(host: string, port: number, signal: AbortSignal): Promise<Duplex>;
  /** `listener` runs on every change of `enabled`; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
}

type TunnelServerMessage = z.infer<(typeof agenticTunnelServerMessages)[number]>;
type TunnelClientMessage = z.infer<(typeof agenticTunnelClientMessages)[number]>;

/** Ports a tunnel may reach; the egress proxy refuses any other too. */
const TUNNEL_PORTS: ReadonlySet<number> = new Set([80, 443]);
/** Above this many bytes queued on the WebSocket, tunnel sockets stop being read. */
const PAUSE_BUFFERED_BYTES = 4 * 1024 * 1024;
const RESUME_BUFFERED_BYTES = 1024 * 1024;
const RESUME_CHECK_MS = 25;

interface Tunnel {
  abort: AbortController;
  timer: NodeJS.Timeout;
  socket?: Duplex;
}

export interface AgenticTunnels {
  /** Handles a tunnel message; false for any other message, which the caller handles. */
  handle<M extends { type: string }>(message: M): message is Extract<M, TunnelServerMessage>;
  /** The socket opened: reports the switch and follows its changes. */
  opened(): void;
  /** The socket closed: every tunnel ends. */
  dispose(): void;
}

export function createAgenticTunnels(
  ws: WebSocket,
  routeTraffic: AgenticRouteTraffic | undefined,
): AgenticTunnels {
  const tunnels = new Map<string, Tunnel>();
  const paused = new Set<Duplex>();
  let resumeTimer: NodeJS.Timeout | undefined;
  let unsubscribe: (() => void) | undefined;

  function send(message: TunnelClientMessage) {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
  }

  function end(id: string, error?: string, notify = true) {
    const tunnel = tunnels.get(id);
    if (!tunnel) return;
    tunnels.delete(id);
    clearTimeout(tunnel.timer);
    tunnel.abort.abort();
    if (tunnel.socket) {
      paused.delete(tunnel.socket);
      tunnel.socket.destroy();
    }
    if (notify)
      send({ type: "tunnel-close", id, ...(error ? { error: error.slice(0, 200) } : {}) });
  }

  function endAll(error?: string, notify = true) {
    for (const id of [...tunnels.keys()]) end(id, error, notify);
  }

  function resumeWhenDrained() {
    if (resumeTimer) return;
    resumeTimer = setInterval(() => {
      if (ws.bufferedAmount > RESUME_BUFFERED_BYTES && ws.readyState === WebSocket.OPEN) return;
      clearInterval(resumeTimer);
      resumeTimer = undefined;
      for (const socket of paused) socket.resume();
      paused.clear();
    }, RESUME_CHECK_MS);
    resumeTimer.unref();
  }

  function announce() {
    const enabled = routeTraffic?.enabled() === true;
    send({ type: "route-traffic", enabled });
    if (!enabled) endAll("Route traffic is off");
  }

  function open(id: string, host: string, port: number) {
    // A repeated id is a confused server: end both rather than mix two streams.
    if (tunnels.has(id)) return end(id, "Duplicate tunnel");
    const refusal = !routeTraffic?.enabled()
      ? "Route traffic is off"
      : tunnels.size >= TUNNEL_MAX_OPEN
        ? "Too many tunnels"
        : !TUNNEL_PORTS.has(port)
          ? "Port not allowed"
          : undefined;
    if (refusal || !routeTraffic) {
      send({ type: "tunnel-close", id, error: refusal });
      return;
    }
    const tunnel: Tunnel = {
      abort: new AbortController(),
      timer: setTimeout(() => end(id, "Timed out"), TUNNEL_OPEN_TIMEOUT_MS),
    };
    tunnel.timer.unref();
    tunnels.set(id, tunnel);
    routeTraffic.connect(host, port, tunnel.abort.signal).then(
      (socket) => {
        if (tunnels.get(id) !== tunnel) {
          socket.destroy();
          return;
        }
        clearTimeout(tunnel.timer);
        tunnel.socket = socket;
        send({ type: "tunnel-opened", id });
        socket.on("data", (chunk: Buffer) => {
          for (let offset = 0; offset < chunk.length; offset += TUNNEL_CHUNK_BYTES)
            send({
              type: "tunnel-data",
              id,
              data: chunk.subarray(offset, offset + TUNNEL_CHUNK_BYTES).toString("base64"),
            });
          if (ws.bufferedAmount > PAUSE_BUFFERED_BYTES) {
            socket.pause();
            paused.add(socket);
            resumeWhenDrained();
          }
        });
        socket.once("close", () => end(id));
        socket.once("error", () => end(id, "Connection failed"));
        socket.resume();
      },
      (error: unknown) => end(id, error instanceof Error ? error.message : "Connection failed"),
    );
  }

  return {
    handle<M extends { type: string }>(message: M): message is Extract<M, TunnelServerMessage> {
      const tunnel = message as unknown as TunnelServerMessage;
      if (tunnel.type === "tunnel-open") open(tunnel.id, tunnel.host, tunnel.port);
      else if (tunnel.type === "tunnel-data") {
        const socket = tunnels.get(tunnel.id)?.socket;
        // Data before tunnel-opened, or for a tunnel already gone, breaks the contract: close it.
        if (socket) socket.write(Buffer.from(tunnel.data, "base64"));
        else if (tunnels.has(tunnel.id)) end(tunnel.id, "Tunnel is not open");
        else send({ type: "tunnel-close", id: tunnel.id, error: "Tunnel is not open" });
      } else if (tunnel.type === "tunnel-close") end(tunnel.id, undefined, false);
      else return false;
      return true;
    },
    opened() {
      if (!routeTraffic) return;
      unsubscribe = routeTraffic.subscribe(announce);
      announce();
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = undefined;
      clearInterval(resumeTimer);
      resumeTimer = undefined;
      paused.clear();
      endAll(undefined, false);
    },
  };
}
