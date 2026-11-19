// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
//
// Keeps one route proxy listener (agentic-route-proxy.ts) on the supervisor's address in each
// computer network it has joined, and only there: never a wildcard address, never the host.
// A listener's address names its computer. Listeners follow the supervisor's networks: a sync
// runs after every join and every few seconds, so a removed network loses its listener.
import type { Server } from "node:net";
import { bestEffort, getLogger } from "@rakazo/logging";
import type Docker from "dockerode";
import {
  ROUTE_PROXY_ALIAS,
  ROUTE_PROXY_PORT,
  routeTrafficApiUrl,
  routeTrafficEnabled,
} from "./agentic-route-pac.js";
import {
  computerTunnelSecret,
  createRouteProxyServer,
  openApiTunnel,
} from "./agentic-route-proxy.js";
import {
  computerNetworkNameFor,
  computerNetworkOwnerFor,
  containerNameFor,
} from "./computer-spec.js";
import { dataDir, docker, screenNetworkMode, supervisorToken } from "./context.js";

const SYNC_INTERVAL_MS = 5_000;
const apiUrl = routeTrafficApiUrl();
const enabled = routeTrafficEnabled(screenNetworkMode, apiUrl);

interface Listener {
  computer: string;
  server: Server;
}

const listeners = new Map<string, Listener>();
let syncing: Promise<void> | undefined;
let syncAgain = false;

/**
 * The supervisor joins computer networks with the route proxy alias, which the computers' PAC
 * names; other screen peers join as before.
 */
export function withRouteProxyAlias(
  options: Docker.NetworkConnectOptions,
  isSupervisor: boolean,
): Docker.NetworkConnectOptions {
  if (!enabled || !isSupervisor) return options;
  return {
    ...options,
    EndpointConfig: { ...options.EndpointConfig, Aliases: [ROUTE_PROXY_ALIAS] },
  };
}

function endpointAddresses(endpoint: Docker.NetworkInfo | undefined): string[] {
  return [endpoint?.IPAddress, endpoint?.GlobalIPv6Address].filter((address): address is string =>
    Boolean(address),
  );
}

/** The computer's own addresses in its network, which are the only ones its proxy serves. */
async function computerAddresses(computer: string, network: string): Promise<Set<string>> {
  const info = await bestEffort(
    "inspect a computer for its route proxy",
    docker.getContainer(containerNameFor(computer)).inspect(),
  );
  return new Set(endpointAddresses(info?.NetworkSettings.Networks[network]));
}

async function listen(address: string, computer: string, network: string, secret: string) {
  let known = await computerAddresses(computer, network);
  const server = createRouteProxyServer({
    openTunnel: (host, port, signal) =>
      openApiTunnel(apiUrl!, secret, computer, host, port, signal),
    isComputer: async (remote) => {
      if (known.has(remote)) return true;
      // The computer may have restarted with a new address since the last look.
      known = await computerAddresses(computer, network);
      return known.has(remote);
    },
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen({ host: address, port: ROUTE_PROXY_PORT, exclusive: true }, () => {
        server.off("error", reject);
        resolve();
      });
    });
  } catch (error) {
    getLogger().warn("route proxy listen failed", { error, address });
    return;
  }
  server.on("error", (error) => getLogger().warn("route proxy server error", { error }));
  listeners.set(address, { computer, server });
}

async function syncOnce(secret: string) {
  const hostname = process.env.HOSTNAME;
  if (!hostname) return;
  const self = await docker.getContainer(hostname).inspect();
  const owner = computerNetworkOwnerFor(dataDir, self);
  const networks = await docker.listNetworks({
    filters: { label: [`rakazo.computerOwner=${owner}`] },
  });
  const wanted = new Map<string, { computer: string; network: string }>();
  for (const network of networks) {
    const computer = network.Labels?.["rakazo.botId"];
    if (!computer || network.Name !== computerNetworkNameFor(computer)) continue;
    for (const address of endpointAddresses(self.NetworkSettings.Networks[network.Name]))
      wanted.set(address, { computer, network: network.Name });
  }
  for (const [address, listener] of listeners) {
    if (wanted.get(address)?.computer === listener.computer) continue;
    listeners.delete(address);
    listener.server.close();
  }
  for (const [address, target] of wanted)
    if (!listeners.has(address)) await listen(address, target.computer, target.network, secret);
}

/** Brings listeners in line with the supervisor's networks; concurrent calls share one run. */
export function syncRouteProxies(): Promise<void> {
  if (!enabled) return Promise.resolve();
  if (syncing) {
    syncAgain = true;
    return syncing;
  }
  const secret = computerTunnelSecret(supervisorToken);
  syncing = (async () => {
    do {
      syncAgain = false;
      await syncOnce(secret);
    } while (syncAgain);
  })().finally(() => {
    syncing = undefined;
  });
  return syncing;
}

/** Starts the route proxies when configured; called once at supervisor start. */
export function startRouteProxies(): void {
  if (!enabled) {
    if (apiUrl)
      getLogger().warn(
        "route traffic is off: it needs SANDBOX_SCREEN_NETWORK=isolated, so each computer has its own network",
      );
    return;
  }
  const sync = () => void bestEffort("sync route proxies", syncRouteProxies());
  sync();
  setInterval(sync, SYNC_INTERVAL_MS).unref();
}
