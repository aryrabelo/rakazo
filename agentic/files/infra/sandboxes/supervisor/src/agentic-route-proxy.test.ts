// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
import { once } from "node:events";
import type { Server as HttpServer, IncomingMessage } from "node:http";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo, Server, Socket } from "node:net";
import { connect, createServer } from "node:net";
import type { Duplex } from "node:stream";
import { runInNewContext } from "node:vm";
import { afterEach, describe, expect, it } from "vitest";
import {
  ROUTE_PROXY_ALIAS,
  ROUTE_PROXY_PORT,
  routedBrowserProxyPacUrl,
  routeTrafficApiUrl,
} from "./agentic-route-pac.js";
import {
  COMPUTER_TUNNEL_PATH,
  computerTunnelSecret,
  createRouteProxyServer,
  openApiTunnel,
  parseProxyRequest,
  routeDestinationAllowed,
} from "./agentic-route-proxy.js";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function listen(server: Server | HttpServer): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return (server.address() as AddressInfo).port;
}

/** A destination that records what it received and answers each chunk with "echo:<chunk>". */
async function destination() {
  const received: string[] = [];
  const port = await listen(
    createServer((socket) => {
      socket.on("error", () => undefined);
      socket.on("data", (chunk: Buffer) => {
        received.push(chunk.toString());
        socket.write(`echo:${chunk}`);
      });
    }),
  );
  return { port, received };
}

/** Runs a PAC data: URL the way Chromium does, with the one helper the script uses. */
function findProxy(pacUrl: string, url: string): string {
  const script = Buffer.from(pacUrl.split(",")[1]!, "base64").toString("utf8");
  const sandbox = {
    isPlainHostName: (host: string) => !host.includes("."),
    shExpMatch: (text: string, pattern: string) =>
      new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`).test(text),
  };
  runInNewContext(script, sandbox);
  return runInNewContext(
    `FindProxyForURL(${JSON.stringify(url)}, ${JSON.stringify(new URL(url).hostname)})`,
    sandbox,
  );
}

const api = new URL("http://api:3001");
const routed = `PROXY ${ROUTE_PROXY_ALIAS}:${ROUTE_PROXY_PORT}; DIRECT`;

describe("route traffic PAC", () => {
  it("is off without an API URL or without isolated computer networks", () => {
    expect(routeTrafficApiUrl("")).toBeUndefined();
    expect(() => routeTrafficApiUrl("https://api.example")).toThrow(/expected http:/);
    expect(routedBrowserProxyPacUrl(undefined, "isolated", undefined)).toBeUndefined();
    expect(routedBrowserProxyPacUrl(undefined, "published", api)).toBeUndefined();
    expect(routedBrowserProxyPacUrl("http://pac.example/p.pac", "internal", api)).toBe(
      "http://pac.example/p.pac",
    );
  });

  it("sends web sites to the computer's proxy and keeps local and odd ports direct", () => {
    const pac = routedBrowserProxyPacUrl(undefined, "isolated", api)!;
    expect(pac).toMatch(/^data:application\/x-ns-proxy-autoconfig;base64,[A-Za-z0-9+/=]+$/);
    expect(findProxy(pac, "https://www.gov.example/")).toBe(routed);
    expect(findProxy(pac, "http://www.gov.example/path")).toBe(routed);
    expect(findProxy(pac, "wss://chat.example/socket")).toBe(routed);
    for (const url of [
      "https://www.gov.example:8443/",
      "http://localhost:3000/",
      "http://intranet/",
      "https://10.0.0.1/",
      "http://printer.local/",
      "ftp://files.example/",
    ])
      expect(findProxy(pac, url), url).toBe("DIRECT");
  });

  it("lets an operator's data: PAC decide first and routes only what it sends direct", () => {
    const operator = `data:application/x-ns-proxy-autoconfig,${encodeURIComponent(
      'function FindProxyForURL(url, host) { if (shExpMatch(host, "*.corp.example")) return "PROXY corp:8080"; return "DIRECT"; }',
    )}`;
    const pac = routedBrowserProxyPacUrl(operator, "isolated", api)!;
    expect(findProxy(pac, "https://app.corp.example/")).toBe("PROXY corp:8080");
    expect(findProxy(pac, "https://www.gov.example/")).toBe(routed);
    // A fetched PAC is not ours to rewrite: it stays as configured.
    expect(routedBrowserProxyPacUrl("https://pac.example/p.pac", "isolated", api)).toBe(
      "https://pac.example/p.pac",
    );
  });
});

describe("route proxy requests", () => {
  it("allows only public web destinations", () => {
    expect(routeDestinationAllowed("www.gov.example", 443)).toBe(true);
    expect(routeDestinationAllowed("93.184.216.34", 80)).toBe(true);
    for (const [host, port] of [
      ["www.gov.example", 22],
      ["10.0.0.1", 443],
      ["169.254.169.254", 80],
      ["127.0.0.1", 443],
      ["[::1]", 443],
      ["[::ffff:10.0.0.1]", 443],
      ["localhost", 443],
      ["api", 80],
      ["db.internal", 443],
    ] as const)
      expect(routeDestinationAllowed(host, port), `${host}:${port}`).toBe(false);
  });

  it("rewrites a plain HTTP request for the destination", () => {
    const parsed = parseProxyRequest(
      "GET http://www.gov.example/a?b=1 HTTP/1.1\r\nHost: www.gov.example\r\nProxy-Connection: keep-alive\r\nAccept: */*\r\n\r\n",
    );
    expect(parsed).toMatchObject({ host: "www.gov.example", port: 80, connect: false });
    expect(parsed!.head!.toString()).toBe(
      "GET /a?b=1 HTTP/1.1\r\nHost: www.gov.example\r\nAccept: */*\r\nConnection: close\r\n\r\n",
    );
    expect(parseProxyRequest("CONNECT [2606:4700::1]:443 HTTP/1.1\r\n\r\n")).toMatchObject({
      host: "2606:4700::1",
      port: 443,
      connect: true,
    });
    expect(parseProxyRequest("GET https://x.example/ HTTP/1.1\r\n\r\n")).toBeNull();
  });
});

describe("route proxy server", () => {
  async function proxy(routing: { on: boolean }, target: number, isComputer = true) {
    const asked: string[] = [];
    const server = createRouteProxyServer({
      openTunnel: async (host, port) => {
        asked.push(`${host}:${port}`);
        if (!routing.on) throw new Error("No route (409)");
        // Stands in for the API: every allowed destination is the local test target.
        const socket = connect(target, "127.0.0.1");
        await once(socket, "connect");
        return socket;
      },
      isComputer: () => isComputer,
    });
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => sockets.add(socket));
    cleanups.push(() => {
      for (const socket of sockets) socket.destroy();
    });
    return { port: await listen(server), asked };
  }

  function exchange(port: number, request: string) {
    return new Promise<{ data: string; error?: string }>((resolve) => {
      const socket = connect(port, "127.0.0.1");
      let data = "";
      socket.on("data", (chunk) => {
        data += chunk;
        if (data.includes("echo:")) socket.end();
      });
      socket.once("error", (error: NodeJS.ErrnoException) => resolve({ data, error: error.code }));
      socket.once("close", () => resolve({ data }));
      socket.write(request);
    });
  }

  it("pipes a CONNECT through the owner's tunnel when it routes", async () => {
    const target = await destination();
    const { port } = await proxy({ on: true }, target.port);
    const socket = connect(port, "127.0.0.1");
    socket.write("CONNECT www.gov.example:443 HTTP/1.1\r\nHost: www.gov.example:443\r\n\r\n");
    const [established] = (await once(socket, "data")) as [Buffer];
    expect(established.toString()).toBe("HTTP/1.1 200 Connection Established\r\n\r\n");
    socket.write("client-hello");
    const [echoed] = (await once(socket, "data")) as [Buffer];
    expect(echoed.toString()).toBe("echo:client-hello");
    socket.destroy();
  });

  it("forwards a plain HTTP request in origin form", async () => {
    const target = await destination();
    const { port } = await proxy({ on: true }, target.port);
    const result = await exchange(
      port,
      "GET http://www.gov.example/x HTTP/1.1\r\nHost: www.gov.example\r\n\r\n",
    );
    expect(result.data).toContain("echo:GET /x HTTP/1.1");
    expect(target.received.join("")).toContain("Connection: close");
  });

  it("resets the connection when the owner's desktop does not route", async () => {
    const target = await destination();
    const { port, asked } = await proxy({ on: false }, target.port);
    const result = await exchange(port, "CONNECT www.gov.example:443 HTTP/1.1\r\n\r\n");
    expect(result).toEqual({ data: "", error: "ECONNRESET" });
    expect(asked).toEqual(["www.gov.example:443"]);
  });

  it("refuses private destinations and other ports without asking", async () => {
    const target = await destination();
    const { port, asked } = await proxy({ on: true }, target.port);
    for (const request of [
      "CONNECT 10.0.0.1:443 HTTP/1.1\r\n\r\n",
      "CONNECT 169.254.169.254:80 HTTP/1.1\r\n\r\n",
      "CONNECT www.gov.example:22 HTTP/1.1\r\n\r\n",
      "GET http://localhost/ HTTP/1.1\r\n\r\n",
    ])
      expect((await exchange(port, request)).data).toMatch(/^HTTP\/1\.1 403 /);
    expect(asked).toEqual([]);
  });

  it("serves nothing but its own computer", async () => {
    const target = await destination();
    const { port, asked } = await proxy({ on: true }, target.port, false);
    const result = await exchange(port, "CONNECT www.gov.example:443 HTTP/1.1\r\n\r\n");
    expect(result.data).toBe("");
    expect(["ECONNRESET", "EPIPE"]).toContain(result.error);
    expect(asked).toEqual([]);
  });
});

describe("API tunnel request", () => {
  it("authenticates with the derived secret and names the computer", async () => {
    expect(computerTunnelSecret("supervisor-token-for-tests")).toBe(
      "f7ddcb6d7ab4a50e477c806f8f9de1cee0e5eae2cdff57511949c53873bac1ff",
    );
    const seen: IncomingMessage[] = [];
    const server = createHttpServer((_request, response) => response.end());
    server.on("upgrade", (request: IncomingMessage, socket: Duplex) => {
      seen.push(request);
      if (request.headers["x-rakazo-computer"] !== "home-1") {
        socket.end("HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\n\r\n");
        return;
      }
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: rakazo-tunnel\r\n\r\n",
      );
      socket.pipe(socket);
    });
    const port = await listen(server);
    const url = new URL(`http://127.0.0.1:${port}`);
    const signal = AbortSignal.timeout(5_000);
    const tunnel = await openApiTunnel(url, "secret", "home-1", "www.gov.example", 443, signal);
    expect(seen[0]!.url).toBe(COMPUTER_TUNNEL_PATH);
    expect(seen[0]!.headers).toMatchObject({
      authorization: "Bearer secret",
      "x-rakazo-tunnel-host": "www.gov.example",
      "x-rakazo-tunnel-port": "443",
    });
    tunnel.write("bytes");
    const [echoed] = (await once(tunnel, "data")) as [Buffer];
    expect(echoed.toString()).toBe("bytes");
    tunnel.destroy();
    await expect(
      openApiTunnel(url, "secret", "home-2", "www.gov.example", 443, signal),
    ).rejects.toThrow(/409/);
  });
});
