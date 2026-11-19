// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
//
// "Route traffic through this computer", per paired server origin. Off by default, saved
// app-privately next to the device consent. It takes effect only while "Let bots use this
// computer" is on for that server, and only where the egress proxy can be sandboxed.
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { UserDeviceClientOptions } from "@rakazo/adapters/user-device-client";
import { bestEffort } from "@rakazo/logging";
import { readPrivateFile, writePrivateFile } from "../setup/setup-store.js";
import type { EgressProxyHost } from "./egress-proxy-host.js";
import {
  connectThroughProxy,
  createEgressProxyHost,
  egressProxySupported,
} from "./egress-proxy-host.js";

type RouteTrafficSource = NonNullable<UserDeviceClientOptions["routeTraffic"]>;

const MAX_FILE_BYTES = 1024;

/** Same folder and key as the device's own files (auth/user-device.ts). */
function routeFile(userDataDir: string, origin: string) {
  const key = createHash("sha256").update(origin).digest("hex").slice(0, 32);
  return path.join(userDataDir, "devices", `${key}.route-traffic.json`);
}

export async function readRouteTraffic(userDataDir: string, origin: string): Promise<boolean> {
  const raw = await readPrivateFile(routeFile(userDataDir, origin), MAX_FILE_BYTES);
  try {
    const saved = raw === null ? null : JSON.parse(raw);
    return saved?.origin === origin && saved.enabled === true;
  } catch {
    return false;
  }
}

export async function saveRouteTraffic(
  userDataDir: string,
  origin: string,
  enabled: boolean,
): Promise<void> {
  const file = routeFile(userDataDir, origin);
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writePrivateFile(file, JSON.stringify({ origin, enabled }));
}

export interface AgenticRouteTraffic {
  /** Present only where the switch is offered; the saved choice for that origin. */
  state(origin: string): { routeTraffic?: boolean };
  set(origin: string, enabled: boolean): Promise<void>;
  /** Something `enabled` depends on changed, such as "Let bots use this computer". */
  changed(): void;
  /** What the paired-device client for `origin` routes through; undefined where not offered. */
  forClient(origin: string): RouteTrafficSource | undefined;
  close(): void;
}

export function createAgenticRouteTraffic(deps: {
  userDataDir: string;
  supported: boolean;
  /** Whether "Let bots use this computer" is on for that origin. */
  allowed: (origin: string) => boolean;
  proxy: EgressProxyHost;
}): AgenticRouteTraffic {
  const saved = new Map<string, boolean>();
  const loading = new Map<string, Promise<void>>();
  const listeners = new Set<() => void>();
  let closed = false;

  const effective = (origin: string) =>
    deps.supported && !closed && saved.get(origin) === true && deps.allowed(origin);

  function load(origin: string) {
    let pending = loading.get(origin);
    if (!pending) {
      pending = readRouteTraffic(deps.userDataDir, origin).then((enabled) => {
        if (!saved.has(origin)) saved.set(origin, enabled);
        changed();
      });
      loading.set(origin, pending);
    }
    return pending;
  }

  /** The proxy runs only while some server routes through it. */
  function syncProxy() {
    if ([...saved.keys()].some(effective))
      void bestEffort("start egress proxy", deps.proxy.endpoint());
    else deps.proxy.stop();
  }

  function changed() {
    syncProxy();
    for (const listener of listeners) listener();
  }

  return {
    state(origin) {
      if (!deps.supported) return {};
      void load(origin);
      return { routeTraffic: saved.get(origin) === true };
    },
    async set(origin, enabled) {
      if (!deps.supported) return;
      await load(origin);
      await saveRouteTraffic(deps.userDataDir, origin, enabled);
      saved.set(origin, enabled);
      changed();
    },
    changed,
    forClient(origin) {
      if (!deps.supported) return undefined;
      void load(origin);
      return {
        enabled: () => effective(origin),
        async connect(host, port, signal) {
          return connectThroughProxy(await deps.proxy.endpoint(), host, port, signal);
        },
        subscribe(listener) {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      };
    },
    close() {
      closed = true;
      listeners.clear();
      deps.proxy.stop();
    },
  };
}

/**
 * The app's instance: the proxy is this app's own binary run as Node, on the script the build
 * bundles next to main.js (scripts/build.mjs).
 */
export function createDesktopRouteTraffic(
  userDataDir: string,
  allowed: (origin: string) => boolean,
): AgenticRouteTraffic {
  const supported = egressProxySupported();
  return createAgenticRouteTraffic({
    userDataDir,
    supported,
    allowed,
    proxy: createEgressProxyHost({
      // The profile names real paths only; a symlinked binary would not start.
      execPath: supported ? realpathSync(process.execPath) : process.execPath,
      script: () => readFile(path.join(import.meta.dirname, "egress-proxy.cjs"), "utf8"),
    }),
  });
}
