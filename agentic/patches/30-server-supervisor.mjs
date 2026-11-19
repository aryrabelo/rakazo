// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
// Route traffic, supervisor side: computers get the routed PAC (agentic-route-pac.ts), the
// supervisor joins computer networks with the route proxy alias and keeps one listener per
// computer network (agentic-route-networks.ts). Off unless SANDBOX_ROUTE_TRAFFIC_API_URL is set.
const src = "infra/sandboxes/supervisor/src";

const composeEnv = (file) => ({
  id: `server-compose-env-${file.replace(/\.yml$/, "").replace(/^docker-compose\.?/, "") || "base"}`,
  file: `infra/compose/${file}`,
  find: "      SANDBOX_COMPUTER_BROWSER_PROXY_PAC_URL: ${SANDBOX_COMPUTER_BROWSER_PROXY_PAC_URL:-}\n",
  position: "after",
  text: "      SANDBOX_ROUTE_TRAFFIC_API_URL: ${SANDBOX_ROUTE_TRAFFIC_API_URL:-}\n",
});

export default [
  {
    id: "server-supervisor-context-import",
    file: `${src}/context.ts`,
    find: 'import { computerImageEnsurer } from "./computer-image.js";\n',
    position: "before",
    text: 'import { routedBrowserProxyPacUrl } from "./agentic-route-pac.js";\n',
  },
  {
    id: "server-supervisor-context-pac",
    file: `${src}/context.ts`,
    find: "export const computerBrowserProxyPacUrl = resolveComputerBrowserProxyPacUrl();\n",
    position: "replace",
    text: [
      "export const computerBrowserProxyPacUrl = routedBrowserProxyPacUrl(",
      "  resolveComputerBrowserProxyPacUrl(),",
      "  screenNetworkMode,",
      ");",
      "",
    ].join("\n"),
  },
  {
    id: "server-supervisor-networks-import",
    file: `${src}/networks.ts`,
    find: 'import { withBotLifecycleLock } from "./locks.js";\n',
    position: "after",
    text: 'import { syncRouteProxies, withRouteProxyAlias } from "./agentic-route-networks.js";\n',
  },
  {
    id: "server-supervisor-networks-alias",
    file: `${src}/networks.ts`,
    find: "      network.connect(screenPeerNetworkConnectOptions(containerId, apiVersion)).catch((error) => {\n",
    position: "replace",
    text: [
      "      network",
      "        .connect(",
      "          withRouteProxyAlias(",
      "            screenPeerNetworkConnectOptions(containerId, apiVersion),",
      "            containerId === info.Id,",
      "          ),",
      "        )",
      "        .catch((error) => {",
      "",
    ].join("\n"),
  },
  {
    id: "server-supervisor-networks-sync",
    file: `${src}/networks.ts`,
    find: "        if (!/already exists|already connected/i.test(String(error))) throw error;\n      }),\n    ),\n  );\n}\n",
    position: "replace",
    text: [
      "          if (!/already exists|already connected/i.test(String(error))) throw error;",
      "        }),",
      "    ),",
      "  );",
      '  await bestEffort("sync route proxies", syncRouteProxies());',
      "}",
      "",
    ].join("\n"),
  },
  {
    id: "server-supervisor-networks-best-effort",
    file: `${src}/networks.ts`,
    find: 'import { getLogger } from "@rakazo/logging";\n',
    position: "replace",
    text: 'import { bestEffort, getLogger } from "@rakazo/logging";\n',
  },
  {
    id: "server-supervisor-index-import",
    file: `${src}/index.ts`,
    find: 'import { reclaimIdleComputerNetworks } from "./networks.js";\n',
    position: "before",
    text: 'import { startRouteProxies } from "./agentic-route-networks.js";\n',
  },
  {
    id: "server-supervisor-index-start",
    file: `${src}/index.ts`,
    find: "  void reclaimIdleComputerNetworks().catch((error) => {\n",
    position: "before",
    text: "  startRouteProxies();\n",
  },
  composeEnv("docker-compose.yml"),
  composeEnv("docker-compose.images.yml"),
  composeEnv("docker-compose.prod.docker.yml"),
  composeEnv("docker-compose.topology.yml"),
];
