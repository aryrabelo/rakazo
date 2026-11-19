// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
//
// Where a "route traffic through this computer" tunnel may go, and why one was not opened.
// The desktop enforces the same rules after its own DNS lookup and connects to the address it
// checked; this side refuses early so a refused destination never reaches a person's computer.
import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/** Ports a tunnel may reach: the web. */
export const TUNNEL_PORTS: ReadonlySet<number> = new Set([80, 443]);

/** The device is offline, its switch is off, or it is not this process's to reach. */
export class TunnelUnavailableError extends Error {
  constructor(message = "No computer routes this traffic", options?: ErrorOptions) {
    super(message, options);
    this.name = "TunnelUnavailableError";
  }
}

/** The destination is not a public web address. */
export class TunnelRefusedError extends Error {
  constructor(message = "Destination refused") {
    super(message);
    this.name = "TunnelRefusedError";
  }
}

/** The device already carries TUNNEL_MAX_OPEN tunnels. */
export class TunnelBusyError extends Error {
  constructor(message = "Too many open tunnels") {
    super(message);
    this.name = "TunnelBusyError";
  }
}

/** The device tried and could not connect, or did not answer in time. */
export class TunnelFailedError extends Error {
  constructor(message = "The tunnel could not be opened") {
    super(message);
    this.name = "TunnelFailedError";
  }
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
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  // Unspecified, loopback and the deprecated IPv4-compatible block.
  ["::", 96],
  ["100::", 64],
  ["2001:db8::", 32],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
] as const)
  blocked.addSubnet(network, prefix, "ipv6");

/** The IPv4 address an IPv4-mapped or NAT64 IPv6 address stands for. */
function embeddedIpv4(address: string): string | null {
  const canonical = new URL(`http://[${address}]`).hostname.slice(1, -1);
  const match = /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(canonical);
  if (!match) return null;
  const high = Number.parseInt(match[1]!, 16);
  const low = Number.parseInt(match[2]!, 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join(".");
}

/** Whether an IP address is on the public internet. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  const mapped = embeddedIpv4(address);
  if (mapped) return isPublicAddress(mapped);
  return !blocked.check(address, "ipv6");
}

export interface TunnelDestinationPolicy {
  /** Defaults to TUNNEL_PORTS. */
  ports?: ReadonlySet<number>;
  /** Defaults to isPublicAddress; tests allow loopback here. */
  allowAddress?: (address: string) => boolean;
  lookup?: (host: string) => Promise<string[]>;
}

async function lookupAll(host: string): Promise<string[]> {
  return (await dnsLookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
}

/**
 * Refuses a destination that is not a web port or does not resolve only to allowed addresses.
 * Every address must pass, so a name that also points inside a network is refused.
 */
export async function checkTunnelDestination(
  host: string,
  port: number,
  policy: TunnelDestinationPolicy = {},
): Promise<void> {
  if (!(policy.ports ?? TUNNEL_PORTS).has(port)) throw new TunnelRefusedError("Port refused");
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!bare || bare.length > 253) throw new TunnelRefusedError("Host refused");
  const allow = policy.allowAddress ?? isPublicAddress;
  let addresses: string[];
  if (isIP(bare)) addresses = [bare];
  else {
    if (!/^[a-z0-9.-]+$/i.test(bare)) throw new TunnelRefusedError("Host refused");
    try {
      addresses = await (policy.lookup ?? lookupAll)(bare);
    } catch {
      throw new TunnelRefusedError("Host not found");
    }
  }
  if (!addresses.length || !addresses.every(allow))
    throw new TunnelRefusedError("Destination refused");
}
