// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
//
// "Route traffic through this computer": the bot browser's proxy auto-config. Every computer gets
// the same script, naming the supervisor by a network alias it holds only on each computer's own
// network, so the proxy a computer reaches is always the listener on its own bridge. Whether
// traffic actually leaves through the owner's desktop is decided per connection by that
// listener; when it refuses, Chromium falls back to the DIRECT entry.

/** The supervisor's alias on every computer network (agentic-route-networks.ts). */
export const ROUTE_PROXY_ALIAS = "rakazo-route-proxy";
/** The port of each computer's proxy listener. */
export const ROUTE_PROXY_PORT = 3128;
const MAX_PAC_URL_LENGTH = 64 * 1024;

/** The API base URL the supervisor asks for tunnels, from SANDBOX_ROUTE_TRAFFIC_API_URL; unset turns the feature off. */
export function routeTrafficApiUrl(
  value: string | undefined = process.env.SANDBOX_ROUTE_TRAFFIC_API_URL,
): URL | undefined {
  const raw = (value ?? "").trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("Unsupported SANDBOX_ROUTE_TRAFFIC_API_URL: expected an absolute http:// URL");
  }
  if (url.protocol !== "http:")
    throw new Error(
      `Unsupported SANDBOX_ROUTE_TRAFFIC_API_URL: expected http://, received ${url.protocol}`,
    );
  return url;
}

/**
 * Whether computers get a route proxy: an API URL is configured and each computer has its own
 * network the supervisor joins (SANDBOX_SCREEN_NETWORK=isolated). Elsewhere a listener could not
 * tell computers apart, or would have to sit on the host.
 */
export function routeTrafficEnabled(
  screenNetworkMode: string,
  apiUrl: URL | undefined = routeTrafficApiUrl(),
): boolean {
  return Boolean(apiUrl) && screenNetworkMode === "isolated";
}

/**
 * Which requests go to the proxy: http(s) and ws(s) on ports 80 and 443 to a named host. Local
 * names and IP literals stay direct, so the proxy never refuses a request the PAC sent it for a
 * reason that would make Chromium skip it for every site for a while.
 */
const ROUTABLE = `function rakazoRoutable(url, host) {
  var m = /^(https?|wss?):\\/\\/(?:[^@\\/]*@)?(\\[[^\\]]*\\]|[^:\\/]*)(?::(\\d+))?/i.exec(url);
  if (!m) return false;
  var secure = /^(https|wss)$/i.test(m[1]);
  var port = m[3] ? parseInt(m[3], 10) : secure ? 443 : 80;
  if (port !== 80 && port !== 443) return false;
  host = String(host).toLowerCase();
  if (isPlainHostName(host) || host === "localhost") return false;
  if (/\\.(localhost|local|internal|lan|home\\.arpa)$/.test(host)) return false;
  if (host.indexOf(":") >= 0 || /^[0-9.]+$/.test(host)) return false;
  return true;
}`;

function decodeDataUrl(url: string): string | null {
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0) return null;
  const header = url.slice(5, comma);
  const body = url.slice(comma + 1);
  try {
    return /;base64$/i.test(header)
      ? Buffer.from(body, "base64").toString("utf8")
      : decodeURIComponent(body);
  } catch {
    return null;
  }
}

/** The PAC script itself, with an operator's script (if any) deciding first. */
export function routedPacScript(operatorScript?: string): string {
  const proxy = `PROXY ${ROUTE_PROXY_ALIAS}:${ROUTE_PROXY_PORT}; DIRECT`;
  const operator = operatorScript
    ? `var rakazoOperator = (function () {\n${operatorScript}\n;return FindProxyForURL;\n})();\n`
    : "";
  const decide = operatorScript ? "String(rakazoOperator(url, host))" : '"DIRECT"';
  return `${operator}${ROUTABLE}
function FindProxyForURL(url, host) {
  var decided = ${decide};
  if (!/^\\s*DIRECT\\s*;?\\s*$/i.test(decided) || !rakazoRoutable(url, host)) return decided;
  return "${proxy}";
}
`;
}

/**
 * The PAC URL computers get when the route proxy is on. An operator's data: PAC keeps deciding
 * first and only what it sends DIRECT may use the route proxy. An operator's http(s) PAC URL is
 * kept unchanged: its script is not ours to fetch and rewrite, so those computers do not route.
 */
export function routedBrowserProxyPacUrl(
  operatorPacUrl: string | undefined,
  screenNetworkMode: string,
  apiUrl: URL | undefined = routeTrafficApiUrl(),
): string | undefined {
  if (!routeTrafficEnabled(screenNetworkMode, apiUrl)) return operatorPacUrl;
  let operatorScript: string | undefined;
  if (operatorPacUrl) {
    const decoded = decodeDataUrl(operatorPacUrl);
    if (decoded === null) return operatorPacUrl;
    operatorScript = decoded;
  }
  const url = `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(routedPacScript(operatorScript)).toString("base64")}`;
  return url.length > MAX_PAC_URL_LENGTH ? operatorPacUrl : url;
}
