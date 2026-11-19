// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
// Route traffic, API side: the upgrade listener also answers the two internal tunnel paths
// (apps/api/src/agentic/route-traffic.ts) before the device hub's own upgrades.
const file = "apps/api/src/app.ts";

export default [
  {
    id: "server-api-import",
    file,
    find: 'import { endUserDeviceSession, mountUserDeviceRoutes } from "./auth/user-devices.js";\n',
    position: "after",
    text: 'import { routeTrafficUpgrade } from "./agentic/route-traffic.js";\n',
  },
  {
    id: "server-api-upgrade",
    file,
    find: "    handleUpgrade: userDeviceHub?.handleUpgrade,\n",
    position: "replace",
    text: [
      "    handleUpgrade: routeTrafficUpgrade(userDeviceHub, {",
      "      prisma,",
      "      forwardSecret: userDeviceSecret,",
      "      supervisorToken: env.sandboxSupervisorToken,",
      "    }),",
      "",
    ].join("\n"),
  },
];
