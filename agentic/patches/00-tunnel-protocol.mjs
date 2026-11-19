// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
// Adds the tunnel messages (agentic-tunnel-protocol.ts) to the paired-device WebSocket protocol.
const file = "packages/adapters/src/computers/host/user-device-protocol.ts";

export default [
  {
    id: "tunnel-protocol-import",
    file,
    find: 'import { hostComputerRequest } from "./host-computer-protocol.js";\n',
    position: "after",
    text: 'import {\n  agenticTunnelClientMessages,\n  agenticTunnelServerMessages,\n} from "./agentic-tunnel-protocol.js";\n',
  },
  {
    id: "tunnel-protocol-server-messages",
    file,
    find: '  z.object({ type: z.literal("revoked"), reason: userDeviceRevokeReason.optional() }),\n',
    position: "after",
    text: "  ...agenticTunnelServerMessages,\n",
  },
  {
    id: "tunnel-protocol-client-messages",
    file,
    find: '  z.object({ type: z.literal("frame"), id: z.string().min(1).max(64), frame: z.unknown() }),\n',
    position: "after",
    text: "  ...agenticTunnelClientMessages,\n",
  },
];
