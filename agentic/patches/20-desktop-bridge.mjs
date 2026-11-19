// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
// The route-traffic switch on the desktop bridge: contract, IPC channel, preload method.
export default [
  {
    id: "desktop-contract-device-state",
    file: "packages/contracts/src/clients/desktop.ts",
    find: "  name: string;\n  allowed: boolean;\n}\n",
    position: "replace",
    text:
      "  name: string;\n" +
      "  allowed: boolean;\n" +
      "  /** Present only where this computer can route its bots' web traffic (agentic). */\n" +
      "  routeTraffic?: boolean;\n" +
      "}\n",
  },
  {
    id: "desktop-contract-device-bridge",
    file: "packages/contracts/src/clients/desktop.ts",
    find: "    setAllowed: (allowed: boolean) => Promise<RakazoDesktopDevice | null>;\n",
    position: "after",
    text:
      "    /** Absent on releases without it; use only when `state` reports `routeTraffic` (agentic). */\n" +
      "    setRouteTraffic?: (enabled: boolean) => Promise<RakazoDesktopDevice | null>;\n",
  },
  {
    id: "desktop-ipc-route-traffic",
    file: "apps/desktop/src/main/ipc/ipc-channels.ts",
    find: '  "desktop.device.setAllowed": appPage<Desktop["device"]["setAllowed"]>(null),\n',
    position: "after",
    text: '  "desktop.device.setRouteTraffic": appPage<NonNullable<Desktop["device"]["setRouteTraffic"]>>(null),\n',
  },
  {
    id: "desktop-preload-route-traffic",
    file: "apps/desktop/src/preload/preload.cjs",
    find: '    setAllowed: (allowed) => ipcRenderer.invoke("desktop.device.setAllowed", allowed),\n',
    position: "after",
    text: '    setRouteTraffic: (enabled) => ipcRenderer.invoke("desktop.device.setRouteTraffic", enabled),\n',
  },
];
