// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
// Hooks the tunnel handler (agentic-tunnel-client.ts) into the paired-device client.
const file = "packages/adapters/src/computers/host/user-device-client.ts";

export default [
  {
    id: "desktop-client-import",
    file,
    find: 'import { createHostComputerRunner } from "./host-computer-runner.js";\n',
    position: "after",
    text:
      'import type { AgenticRouteTraffic } from "./agentic-tunnel-client.js";\n' +
      'import { createAgenticTunnels } from "./agentic-tunnel-client.js";\n',
  },
  {
    id: "desktop-client-option",
    file,
    find: "  retryMs?: { min: number; max: number };\n",
    position: "after",
    text: "  /** Carries the server's tunnels while this computer routes its traffic (agentic). */\n  routeTraffic?: AgenticRouteTraffic;\n",
  },
  {
    id: "desktop-client-create",
    file,
    find: "    socket = ws;\n",
    position: "after",
    text: "    const tunnels = createAgenticTunnels(ws, options.routeTraffic);\n",
  },
  {
    id: "desktop-client-opened",
    file,
    find: "      openedAt = Date.now();\n",
    position: "after",
    text: "      tunnels.opened();\n",
  },
  {
    id: "desktop-client-closed",
    file,
    find: "      clearInterval(ping);\n",
    position: "after",
    text: "      tunnels.dispose();\n",
  },
  {
    id: "desktop-client-message",
    file,
    find: '      if (message.type === "revoked") {\n',
    position: "before",
    text: "      if (tunnels.handle(message)) return;\n",
  },
];
