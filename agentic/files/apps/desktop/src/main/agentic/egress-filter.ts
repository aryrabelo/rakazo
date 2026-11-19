// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
//
// Which destinations a tunnel may reach from this computer: ports 80 and 443 on public addresses
// only. Checked on the resolved address the proxy then connects to, never on a name.
import { isIP } from "node:net";

export const EGRESS_PORTS: ReadonlySet<number> = new Set([80, 443]);

/** [prefix bytes, prefix length in bits] */
type Range = [number[], number];

/** Not public IPv4: this network, private, CGNAT, loopback, link-local, IETF, documentation, benchmarking, multicast, reserved, broadcast. */
const V4_BLOCKED: Range[] = [
  [[0], 8],
  [[10], 8],
  [[100, 64], 10],
  [[127], 8],
  [[169, 254], 16],
  [[172, 16], 12],
  [[192, 0, 0], 24],
  [[192, 0, 2], 24],
  [[192, 88, 99], 24],
  [[192, 168], 16],
  [[198, 18], 15],
  [[198, 51, 100], 24],
  [[203, 0, 113], 24],
  [[224], 4],
  [[240], 4],
];

/** Inside global unicast 2000::/3 but not public: IETF/Teredo, documentation, 6to4, documentation. */
const V6_BLOCKED: Range[] = [
  [[0x20, 0x01, 0x00], 23],
  [[0x20, 0x01, 0x0d, 0xb8], 32],
  [[0x20, 0x02], 16],
  [[0x3f, 0xff, 0x00], 20],
];

function inRange(bytes: number[], [prefix, bits]: Range): boolean {
  for (let bit = 0; bit < bits; bit += 8) {
    const width = Math.min(8, bits - bit);
    const mask = (0xff << (8 - width)) & 0xff;
    if (((bytes[bit / 8] ?? 0) & mask) !== ((prefix[bit / 8] ?? 0) & mask)) return false;
  }
  return true;
}

function v4Bytes(address: string): number[] {
  return address.split(".").map(Number);
}

/** The 16 bytes of an IPv6 address, including one ending in dotted IPv4. */
function v6Bytes(address: string): number[] {
  let text = address.split("%")[0] ?? "";
  const tail: number[] = [];
  const dotted = text.match(/:(\d+\.\d+\.\d+\.\d+)$/);
  if (dotted?.[1]) {
    tail.push(...v4Bytes(dotted[1]));
    text = `${text.slice(0, -dotted[1].length)}0:0`;
  }
  const [head = "", rest] = text.split("::");
  const groups = (part: string) =>
    part ? part.split(":").map((group) => parseInt(group, 16)) : [];
  const front = groups(head);
  const back = rest === undefined ? [] : groups(rest);
  const words = [...front, ...Array(8 - front.length - back.length).fill(0), ...back];
  const bytes = words.flatMap((word) => [(word >> 8) & 0xff, word & 0xff]);
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes;
}

function publicV4(bytes: number[]): boolean {
  return !V4_BLOCKED.some((range) => inRange(bytes, range));
}

/** True only for a public unicast address; anything unparsable is refused. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address.split("%")[0] ?? "");
  if (family === 4) return publicV4(v4Bytes(address));
  if (family !== 6) return false;
  const bytes = v6Bytes(address);
  // IPv4-mapped ::ffff:a.b.c.d and NAT64 64:ff9b::a.b.c.d reach the IPv4 address they carry.
  const mapped =
    bytes.slice(0, 10).every((byte) => byte === 0) && bytes[10] === 0xff && bytes[11] === 0xff;
  const nat64 = inRange(bytes, [[0x00, 0x64, 0xff, 0x9b, 0, 0, 0, 0, 0, 0, 0, 0], 96]);
  if (mapped || nat64) return publicV4(bytes.slice(12));
  // Only global unicast 2000::/3: excludes ::, ::1, ULA fc00::/7, link-local fe80::/10, multicast ff00::/8.
  if (!inRange(bytes, [[0x20], 3])) return false;
  return !V6_BLOCKED.some((range) => inRange(bytes, range));
}

/** The default policy: a public address on port 80 or 443. */
export function isAllowedDestination(address: string, port: number): boolean {
  return EGRESS_PORTS.has(port) && isPublicAddress(address);
}
