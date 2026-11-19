// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
//
// The server end of "route traffic through this computer" tunnels on one device socket
// (agentic-tunnel-protocol.ts). State hangs off the hub's per-connection entry, so a reconnect
// starts with the switch off and no tunnels until the device says otherwise.
import { randomUUID } from "node:crypto";
import { Duplex } from "node:stream";
import { getLogger } from "@rakazo/logging";
import {
  TunnelBusyError,
  TunnelFailedError,
  TunnelUnavailableError,
} from "./agentic-tunnel-policy.js";
import {
  TUNNEL_CHUNK_BYTES,
  TUNNEL_MAX_OPEN,
  TUNNEL_OPEN_TIMEOUT_MS,
} from "./agentic-tunnel-protocol.js";

/** Sending pauses while the device socket holds more than this unsent. */
const HIGH_WATER_BYTES = 1024 * 1024;
const DRAIN_POLL_MS = 20;
/** Data from the device that its reader has not taken; past this the tunnel is closed. */
const MAX_UNREAD_BYTES = 16 * 1024 * 1024;

/** The part of a device socket tunnels use. `ws` sockets also report `bufferedAmount`. */
export interface TunnelDeviceSocket {
  send(data: string): void;
}

/** What the hub keeps per connection; tunnels key their state on this object. */
export interface TunnelDeviceEntry {
  socket: TunnelDeviceSocket;
}

export type DeviceTunnelMessage =
  | { type: "tunnel-opened"; id: string }
  | { type: "tunnel-data"; id: string; data: string }
  | { type: "tunnel-close"; id: string; error?: string }
  | { type: "route-traffic"; enabled: boolean };

interface DeviceTunnelState {
  routing: boolean;
  tunnels: Map<string, DeviceTunnel>;
}

const states = new WeakMap<TunnelDeviceEntry, DeviceTunnelState>();

function stateOf(entry: TunnelDeviceEntry): DeviceTunnelState {
  let state = states.get(entry);
  if (!state) {
    state = { routing: false, tunnels: new Map() };
    states.set(entry, state);
  }
  return state;
}

function bufferedAmount(socket: TunnelDeviceSocket): number {
  if ("bufferedAmount" in socket && typeof socket.bufferedAmount === "number")
    return socket.bufferedAmount;
  return 0;
}

/** One tunnel: bytes written go to the device; bytes the device sends are read. */
class DeviceTunnel extends Duplex {
  opened = false;
  /** The device closed it, or the connection is gone: nothing more is sent. */
  private ended = false;
  private settle?: (error?: Error) => void;

  constructor(
    readonly id: string,
    private readonly socket: TunnelDeviceSocket,
    private readonly state: DeviceTunnelState,
  ) {
    super();
  }

  /** Resolves once the device answers tunnel-opened. */
  waitOpen(signal: AbortSignal, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => this.settle?.(new TunnelFailedError("Your computer did not answer")),
        timeoutMs,
      );
      const abort = () => this.settle?.(signal.reason ?? new Error("Aborted"));
      signal.addEventListener("abort", abort, { once: true });
      this.settle = (error) => {
        this.settle = undefined;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve();
      };
      if (signal.aborted) abort();
    });
  }

  markOpened() {
    if (this.opened) return;
    this.opened = true;
    this.settle?.();
  }

  receive(data: string) {
    if (!this.opened || this.ended) return;
    if (this.readableLength > MAX_UNREAD_BYTES) {
      this.destroy(new Error("Tunnel reader too slow"));
      return;
    }
    this.push(Buffer.from(data, "base64"));
  }

  /** The device closed the tunnel, or its connection is gone. */
  remoteClosed(error?: string) {
    if (this.ended) return;
    this.ended = true;
    this.state.tunnels.delete(this.id);
    if (!this.opened) {
      this.settle?.(new TunnelFailedError(error || "Your computer could not connect"));
      this.destroy();
      return;
    }
    this.push(null);
  }

  /** Ends the tunnel from this side and lets what was read drain: the switch went off. */
  shut() {
    this.closeLocally();
    this.end();
  }

  /** Ends the tunnel from this side: tells the device, then ends both directions. */
  private closeLocally() {
    if (this.ended) return;
    this.ended = true;
    this.state.tunnels.delete(this.id);
    this.send({ type: "tunnel-close", id: this.id });
    this.push(null);
  }

  private send(message: object): boolean {
    try {
      this.socket.send(JSON.stringify(message));
      return true;
    } catch (error) {
      getLogger().warn("device tunnel send failed", { error });
      return false;
    }
  }

  override _read() {
    // The device has no flow control message; MAX_UNREAD_BYTES bounds what waits here.
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error) => void) {
    if (this.ended) {
      callback();
      return;
    }
    const sendChunks = (offset: number) => {
      while (offset < chunk.length) {
        if (this.ended) return callback();
        if (bufferedAmount(this.socket) > HIGH_WATER_BYTES) {
          setTimeout(() => sendChunks(offset), DRAIN_POLL_MS);
          return;
        }
        const piece = chunk.subarray(offset, offset + TUNNEL_CHUNK_BYTES);
        if (!this.send({ type: "tunnel-data", id: this.id, data: piece.toString("base64") })) {
          this.remoteClosed();
          return callback(new Error("Your computer disconnected"));
        }
        offset += piece.length;
      }
      callback();
    };
    sendChunks(0);
  }

  override _final(callback: (error?: Error) => void) {
    this.closeLocally();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void) {
    this.closeLocally();
    callback(error);
  }
}

/** Handles a tunnel message the device sent. */
export function deviceTunnelMessage(entry: TunnelDeviceEntry, message: DeviceTunnelMessage): void {
  const state = stateOf(entry);
  if (message.type === "route-traffic") {
    state.routing = message.enabled;
    // Switching off ends what is already flowing too.
    if (!message.enabled) for (const tunnel of [...state.tunnels.values()]) tunnel.shut();
    return;
  }
  const tunnel = state.tunnels.get(message.id);
  if (!tunnel) return;
  if (message.type === "tunnel-opened") tunnel.markOpened();
  else if (message.type === "tunnel-data") tunnel.receive(message.data);
  else tunnel.remoteClosed(message.error);
}

/** Whether the device on this connection has its switch on. */
export function deviceRoutesTraffic(entry: TunnelDeviceEntry): boolean {
  return states.get(entry)?.routing ?? false;
}

/** The connection is gone: every tunnel on it ends. */
export function closeDeviceTunnels(entry: TunnelDeviceEntry): void {
  const state = states.get(entry);
  if (!state) return;
  state.routing = false;
  for (const tunnel of [...state.tunnels.values()])
    tunnel.remoteClosed("Your computer disconnected");
}

/** Opens a tunnel to host:port through the device; the caller has checked the destination. */
export async function openDeviceTunnel(
  entry: TunnelDeviceEntry,
  host: string,
  port: number,
  signal: AbortSignal,
  timeoutMs = TUNNEL_OPEN_TIMEOUT_MS,
): Promise<Duplex> {
  signal.throwIfAborted();
  const state = stateOf(entry);
  if (!state.routing) throw new TunnelUnavailableError("This computer does not route traffic");
  if (state.tunnels.size >= TUNNEL_MAX_OPEN) throw new TunnelBusyError();
  const tunnel = new DeviceTunnel(randomUUID(), entry.socket, state);
  state.tunnels.set(tunnel.id, tunnel);
  const opened = tunnel.waitOpen(signal, timeoutMs);
  try {
    entry.socket.send(JSON.stringify({ type: "tunnel-open", id: tunnel.id, host, port }));
  } catch (error) {
    tunnel.remoteClosed();
    throw new TunnelUnavailableError(undefined, { cause: error });
  }
  try {
    await opened;
  } catch (error) {
    tunnel.destroy();
    throw error;
  }
  return tunnel;
}
