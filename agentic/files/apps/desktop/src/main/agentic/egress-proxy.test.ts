// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo, Server } from "node:net";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isAllowedDestination, isPublicAddress } from "./egress-filter.js";
import { createEgressProxy, parseConnectTarget } from "./egress-proxy.js";
import { connectThroughProxy, egressSandboxProfile, runtimeRoot } from "./egress-proxy-host.js";
import { readRouteTraffic, saveRouteTraffic } from "./route-traffic.js";

const SECRET = "s".repeat(64);

describe("egress destination filter", () => {
  it.each([
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "100.64.0.1",
    "100.127.255.254",
    "169.254.169.254",
    "0.0.0.0",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::",
    "::1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "fe80::1%en0",
    "ff02::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::192.168.0.1",
    "2001:db8::1",
    "2002:c0a8:101::1",
    "not-an-address",
    "",
  ])("refuses %s", (address) => {
    expect(isPublicAddress(address)).toBe(false);
  });

  it.each([
    "1.1.1.1",
    "8.8.8.8",
    "172.32.0.1",
    "100.128.0.1",
    "2606:4700:4700::1111",
    "::ffff:8.8.8.8",
    "64:ff9b::8.8.8.8",
  ])("allows public %s", (address) => {
    expect(isPublicAddress(address)).toBe(true);
  });

  it("allows only ports 80 and 443", () => {
    expect(isAllowedDestination("1.1.1.1", 443)).toBe(true);
    expect(isAllowedDestination("1.1.1.1", 80)).toBe(true);
    for (const port of [22, 25, 8080, 8443, 3306])
      expect(isAllowedDestination("1.1.1.1", port)).toBe(false);
  });

  it("parses CONNECT targets", () => {
    expect(parseConnectTarget("example.com:443")).toEqual({ host: "example.com", port: 443 });
    expect(parseConnectTarget("[2606:4700::1]:80")).toEqual({ host: "2606:4700::1", port: 80 });
    expect(parseConnectTarget("user@host:443")).toBeNull();
    expect(parseConnectTarget("host:99999")).toBeNull();
    expect(parseConnectTarget("host")).toBeNull();
  });
});

describe("egress proxy", () => {
  let echo: Server;
  let echoPort: number;
  let proxy: Server;
  let port: number;

  beforeEach(async () => {
    echo = createServer((socket) => socket.pipe(socket)).listen(0, "127.0.0.1");
    await once(echo, "listening");
    echoPort = (echo.address() as AddressInfo).port;
    // Only this test lets the loopback echo through; production uses isAllowedDestination.
    proxy = createEgressProxy({
      secret: SECRET,
      allow: (address, p) =>
        (address === "127.0.0.1" && p === echoPort) || isAllowedDestination(address, p),
      resolve: async (host) =>
        host === "echo.test"
          ? ["127.0.0.1"]
          : host === "inside.test"
            ? ["1.1.1.1", "10.0.0.1"]
            : [host],
    }).listen(0, "127.0.0.1");
    await once(proxy, "listening");
    port = (proxy.address() as AddressInfo).port;
  });

  afterEach(() => {
    echo.close();
    proxy.close();
  });

  async function rawConnect(request: string): Promise<string> {
    const socket = connect({ host: "127.0.0.1", port });
    await once(socket, "connect");
    socket.write(request);
    let out = "";
    socket.on("data", (chunk) => (out += chunk.toString()));
    await once(socket, "close");
    return out;
  }

  it("streams to an allowed destination with the right secret", async () => {
    const socket = await connectThroughProxy({ port, secret: SECRET }, "echo.test", echoPort);
    socket.resume();
    socket.write("ping");
    const [chunk] = await once(socket, "data");
    expect(chunk.toString()).toBe("ping");
    socket.destroy();
  });

  it("refuses a missing or wrong secret", async () => {
    expect(await rawConnect(`CONNECT echo.test:${echoPort} HTTP/1.1\r\n\r\n`)).toMatch(
      /^HTTP\/1\.1 407 /,
    );
    expect(
      await rawConnect(
        `CONNECT echo.test:${echoPort} HTTP/1.1\r\nProxy-Authorization: Bearer ${"x".repeat(64)}\r\n\r\n`,
      ),
    ).toMatch(/^HTTP\/1\.1 407 /);
    await expect(
      connectThroughProxy({ port, secret: "wrong" }, "echo.test", echoPort),
    ).rejects.toThrow("407");
  });

  it("refuses private destinations after resolving, and other ports", async () => {
    await expect(connectThroughProxy({ port, secret: SECRET }, "10.0.0.1", 443)).rejects.toThrow(
      "Destination not allowed",
    );
    await expect(connectThroughProxy({ port, secret: SECRET }, "inside.test", 443)).rejects.toThrow(
      "Destination not allowed",
    );
    await expect(connectThroughProxy({ port, secret: SECRET }, "1.1.1.1", 22)).rejects.toThrow(
      "Destination not allowed",
    );
    await expect(connectThroughProxy({ port, secret: SECRET }, "127.0.0.1", 443)).rejects.toThrow(
      "Destination not allowed",
    );
  });
});

describe("egress sandbox profile", () => {
  it("allows reading only the runtime bundle and denies every write", () => {
    const exec = "/Applications/Rakazo.app/Contents/MacOS/Rakazo";
    expect(runtimeRoot(exec)).toBe("/Applications/Rakazo.app");
    const profile = egressSandboxProfile(exec);
    expect(profile).toContain("(deny default)");
    expect(profile).toContain(
      '(allow file-read* file-map-executable (subpath "/Applications/Rakazo.app"))',
    );
    expect(profile.trimEnd().split("\n").slice(-2)).toEqual([
      "(deny file-write*)",
      '(allow file-write-data (literal "/dev/null"))',
    ]);
    expect(profile).not.toMatch(/Users|HOME/);
    expect(profile).toContain('(allow network-outbound (remote ip "*:80") (remote ip "*:443"))');
  });
});

describe("route traffic persistence", () => {
  it("is off by default and saved per server origin", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "rakazo-route-test-"));
    try {
      expect(await readRouteTraffic(dir, "https://a.example")).toBe(false);
      await saveRouteTraffic(dir, "https://a.example", true);
      expect(await readRouteTraffic(dir, "https://a.example")).toBe(true);
      expect(await readRouteTraffic(dir, "https://b.example")).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
