// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
// Desktop main process: creates the route-traffic switch (apps/desktop/src/main/agentic/), hands
// it to the paired-device client, answers its IPC channel, and bundles the egress proxy script.
const main = "apps/desktop/src/main/main.ts";

export default [
  {
    id: "desktop-main-import",
    file: main,
    find: 'import { createUserDeviceAccess, deviceName } from "./auth/user-device.js";\n',
    position: "after",
    text: 'import { createDesktopRouteTraffic } from "./agentic/route-traffic.js";\n',
  },
  {
    id: "desktop-main-create",
    file: main,
    find: "  desktop.userDevices = createUserDeviceAccess({\n",
    position: "before",
    text:
      "  const routeTraffic = createDesktopRouteTraffic(\n" +
      "    userDataDir,\n" +
      "    (origin) => desktop.userDevices?.state(origin)?.allowed === true,\n" +
      "  );\n" +
      '  app.once("will-quit", () => routeTraffic.close());\n',
  },
  {
    id: "desktop-main-connect",
    file: main,
    find: "        screen: hostScreen,\n        ...events,\n",
    position: "after",
    text: "        routeTraffic: routeTraffic.forClient(origin),\n",
  },
  {
    id: "desktop-main-state",
    file: main,
    find: "    return state ? { ...state, name: await deviceName() } : null;\n",
    position: "replace",
    text:
      "    return state && origin !== null\n" +
      "      ? { ...state, ...routeTraffic.state(origin), name: await deviceName() }\n" +
      "      : null;\n",
  },
  {
    id: "desktop-main-ipc",
    file: main,
    find: "    await desktop.userDevices?.setAllowed(origin, allowed);\n    return deviceState(remoteDeviceOrigin(event));\n  });\n",
    position: "replace",
    text:
      "    await desktop.userDevices?.setAllowed(origin, allowed);\n" +
      "    routeTraffic.changed();\n" +
      "    return deviceState(remoteDeviceOrigin(event));\n" +
      "  });\n" +
      '  handleIpc("desktop.device.setRouteTraffic", async (event, enabled) => {\n' +
      "    const origin = remoteDeviceOrigin(event);\n" +
      '    if (origin === null || typeof enabled !== "boolean") return null;\n' +
      "    await routeTraffic.set(origin, enabled);\n" +
      "    return deviceState(remoteDeviceOrigin(event));\n" +
      "  });\n",
  },
  {
    id: "desktop-build-egress-proxy",
    file: "apps/desktop/scripts/build.mjs",
    find: 'await build({\n  entryPoints: ["src/main/main.ts"],\n',
    position: "before",
    text:
      "// The egress proxy runs as its own sandboxed process; main.js reads this and runs it inline.\n" +
      "await build({\n" +
      '  entryPoints: ["src/main/agentic/egress-proxy-process.ts"],\n' +
      '  outfile: "dist/egress-proxy.cjs",\n' +
      "  bundle: true,\n" +
      '  platform: "node",\n' +
      '  format: "cjs",\n' +
      '  target: "node22",\n' +
      "});\n\n",
  },
];
