// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
// Route traffic, server side: the device hub hands tunnel messages to agentic-device-tunnels.ts,
// ends a connection's tunnels when it drops, and opens tunnels through a socket it holds.
const file = "packages/adapters/src/computers/host/user-device-gateway.ts";

export default [
  {
    id: "server-gateway-import",
    file,
    find: '  userDeviceClientMessage,\n  userDeviceRevokeReason,\n} from "./user-device-protocol.js";\n',
    position: "after",
    text: 'import {\n  closeDeviceTunnels,\n  deviceTunnelMessage,\n  openDeviceTunnel,\n} from "./agentic-device-tunnels.js";\nimport { TunnelUnavailableError } from "./agentic-tunnel-policy.js";\n',
  },
  {
    id: "server-gateway-receive",
    file,
    find: "    if (!message.success) return;\n",
    position: "after",
    text: '    if (message.data.type !== "frame") return deviceTunnelMessage(entry, message.data);\n',
  },
  {
    id: "server-gateway-drop",
    file,
    find: "    entry.pending.clear();\n",
    position: "after",
    text: "    closeDeviceTunnels(entry);\n",
  },
  {
    id: "server-gateway-open-tunnel",
    file,
    find: "  /** Closes this process's socket for a device and fails its in-flight requests. */\n",
    position: "before",
    text: [
      "  /** A tunnel to host:port through a device socket this process holds (agentic-device-tunnels.ts). */",
      "  async openTunnel(",
      "    route: UserDeviceRoute,",
      "    host: string,",
      "    port: number,",
      "    signal: AbortSignal,",
      "  ): Promise<Duplex> {",
      "    const entry = this.live.get(route.deviceId);",
      "    if (!entry || !this.holds(route)) throw new TunnelUnavailableError();",
      "    return openDeviceTunnel(entry, host, port, signal);",
      "  }",
      "",
      "",
    ].join("\n"),
  },
  {
    id: "server-adapters-exports",
    file: "packages/adapters/src/index.ts",
    find: 'export * from "./computers/host/user-device-protocol.js";\n',
    position: "after",
    text: 'export * from "./computers/host/agentic-tunnel-policy.js";\nexport * from "./computers/host/agentic-user-device-tunnels.js";\n',
  },
];
