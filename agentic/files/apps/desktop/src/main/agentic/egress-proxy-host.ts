// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
//
// Runs the egress proxy (egress-proxy-process.ts) as a separate process under the macOS sandbox
// and opens tunnels through it. The sandbox is what keeps routed traffic away from this
// computer's files and local network: the process can read only the runtime it starts from and
// system libraries, write nothing, accept only loopback connections and connect out only to
// ports 80 and 443. Windows and Linux have no equivalent available to an unprivileged app, so
// there the switch is not offered at all (see egressProxySupported).
import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import type { Socket } from "node:net";
import { connect } from "node:net";
import path from "node:path";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const READY_TIMEOUT_MS = 15_000;
const RESTART_MIN_MS = 1_000;
const RESTART_MAX_MS = 60_000;

export function egressProxySupported(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" && existsSync(SANDBOX_EXEC);
}

/** The folder the runtime loads itself from: the whole .app bundle, or the binary's folder. */
export function runtimeRoot(execPath: string): string {
  const bundle = execPath.match(/^(.*?\.app)\/Contents\/MacOS\/[^/]+$/);
  return bundle?.[1] ?? path.dirname(execPath);
}

const quote = (value: string) => JSON.stringify(value);

/** Every folder above `dir`: the runtime binary's path is looked up through them. */
function ancestors(dir: string): string[] {
  const out: string[] = [];
  for (let current = path.dirname(dir); ; current = path.dirname(current)) {
    out.push(current);
    if (current === path.dirname(current)) return out;
  }
}

/**
 * SBPL for the proxy. Everything not listed is denied, including every file write and every read
 * outside the runtime and the system. `execPath` must be a real path (no symlinks).
 */
export function egressSandboxProfile(execPath: string): string {
  const root = runtimeRoot(execPath);
  const lookups = ancestors(root)
    .map((dir) => `(literal ${quote(dir)})`)
    .join(" ");
  return `(version 1)
(deny default)
; Apple's base for system processes: dyld and its shared cache, system libraries and
; frameworks, /dev/null and /dev/random, standard symlinks like /etc. No user folders.
(import "system.sb")
; Start the runtime binary sandbox-exec hands over to.
(allow process-exec (literal ${quote(execPath)}))
; The runtime itself: its binary, frameworks and resources (V8 snapshot, ICU data).
(allow file-read* file-map-executable (subpath ${quote(root)}))
; Only stat, no listing or contents, of the folders above it, to resolve its path.
(allow file-read-metadata ${lookups})
; Name resolution: hosts and resolver config, the system resolver and directory services.
(allow file-read* (literal "/private/etc/hosts") (literal "/private/etc/resolv.conf")
  (literal "/private/var/run/resolv.conf"))
(allow mach-lookup (global-name "com.apple.dnssd.service")
  (global-name "com.apple.system.opendirectoryd.libinfo")
  (global-name "com.apple.SystemConfiguration.configd")
  (global-name "com.apple.SystemConfiguration.DNSConfiguration"))
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
; Runtime basics: CPU count, page size, clocks.
(allow sysctl-read)
; Listen and accept on loopback only; connect out to web ports only.
(allow network-bind (local ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
(allow network-outbound (remote ip "*:80") (remote ip "*:443"))
; Last, so nothing above or in system.sb lets it write a file: only stdio's /dev/null.
(deny file-write*)
(allow file-write-data (literal "/dev/null"))
`;
}

/** The command that starts the proxy: the bundled script runs inline, so no script file is read. */
export function egressProxyCommand(
  execPath: string,
  script: string,
): { command: string; args: string[]; env: NodeJS.ProcessEnv } {
  return {
    command: SANDBOX_EXEC,
    args: ["-p", egressSandboxProfile(execPath), execPath, "-e", script],
    // Nothing from the app's environment: only what turns the Electron binary into Node.
    env: { ELECTRON_RUN_AS_NODE: "1" },
  };
}

export interface EgressProxyEndpoint {
  port: number;
  secret: string;
}

/** Opens host:port through the proxy and returns the socket once the proxy answered 200. */
export function connectThroughProxy(
  endpoint: EgressProxyEndpoint,
  host: string,
  port: number,
  signal?: AbortSignal,
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port: endpoint.port, noDelay: true });
    let head = Buffer.alloc(0);
    const fail = (error: Error) => {
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      reject(error);
    };
    const onAbort = () => fail(new Error("Tunnel cancelled"));
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) return onAbort();
    socket.once("error", fail);
    socket.once("close", () => fail(new Error("Egress proxy closed the connection")));
    socket.once("connect", () => {
      const target = host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Bearer ${endpoint.secret}\r\n\r\n`,
      );
    });
    const onData = (chunk: Buffer) => {
      head = Buffer.concat([head, chunk]);
      const end = head.indexOf("\r\n\r\n");
      if (end < 0) {
        if (head.length > 4096) fail(new Error("Egress proxy answered too much"));
        return;
      }
      socket.off("data", onData);
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");
      signal?.removeEventListener("abort", onAbort);
      const status = head.subarray(0, end).toString("latin1").split("\r\n")[0] ?? "";
      if (!/^HTTP\/1\.\d 200 /.test(status)) {
        socket.destroy();
        const code = status.split(" ")[1];
        reject(
          new Error(code === "403" ? "Destination not allowed" : `Egress proxy refused (${code})`),
        );
        return;
      }
      socket.pause();
      const rest = head.subarray(end + 4);
      if (rest.length) socket.unshift(rest);
      resolve(socket);
    };
    socket.on("data", onData);
  });
}

export interface EgressProxyHost {
  /** Starts the proxy if needed and resolves once it listens. */
  endpoint(): Promise<EgressProxyEndpoint>;
  /** Stops it and keeps it stopped until `endpoint` is asked again. */
  stop(): void;
}

/**
 * Keeps one proxy process running while wanted: restarted after a crash with backoff, stopped on
 * `stop`. Each start gets a new random secret.
 */
export function createEgressProxyHost(options: {
  execPath: string;
  /** Reads the bundled proxy script. */
  script: () => Promise<string>;
  spawnProcess?: typeof spawn;
}): EgressProxyHost {
  const spawnProcess = options.spawnProcess ?? spawn;
  let wanted = false;
  let child: ChildProcess | undefined;
  let ready: Promise<EgressProxyEndpoint> | undefined;
  let failures = 0;
  let restartTimer: NodeJS.Timeout | undefined;

  function start(): Promise<EgressProxyEndpoint> {
    const secret = randomBytes(32).toString("hex");
    const attempt = options.script().then(
      (script) =>
        new Promise<EgressProxyEndpoint>((resolve, reject) => {
          const { command, args, env } = egressProxyCommand(options.execPath, script);
          // cwd "/": nothing of the app's working folder is reachable or even named.
          const proc = spawnProcess(command, args, {
            cwd: "/",
            env,
            stdio: ["pipe", "pipe", "ignore"],
          });
          child = proc;
          let out = "";
          const timer = setTimeout(() => {
            proc.kill();
            reject(new Error("Egress proxy did not start"));
          }, READY_TIMEOUT_MS);
          proc.stdout?.on("data", (chunk: Buffer) => {
            out += chunk.toString("utf8");
            const match = out.match(/^ready (\d+)\n/);
            if (!match) return;
            clearTimeout(timer);
            failures = 0;
            resolve({ port: Number(match[1]), secret });
          });
          proc.once("error", (error) => {
            clearTimeout(timer);
            reject(error);
          });
          proc.once("exit", () => {
            clearTimeout(timer);
            reject(new Error("Egress proxy exited"));
            if (child !== proc) return;
            child = undefined;
            ready = undefined;
            if (!wanted) return;
            // Crashed while wanted: start again, backing off while it keeps failing.
            const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** failures);
            failures += 1;
            restartTimer = setTimeout(() => {
              if (wanted && !ready) ready = start();
              ready?.catch(() => undefined);
            }, delay);
            restartTimer.unref();
          });
          proc.stdin?.on("error", () => undefined);
          // Stays open: the proxy exits when this pipe closes, so it dies with the app.
          proc.stdin?.write(`${secret}\n`);
        }),
    );
    // A failed start is not kept: the next tunnel tries again.
    attempt.catch(() => {
      if (ready === attempt) ready = undefined;
    });
    return attempt;
  }

  return {
    endpoint() {
      wanted = true;
      clearTimeout(restartTimer);
      ready ??= start();
      return ready;
    },
    stop() {
      wanted = false;
      clearTimeout(restartTimer);
      ready = undefined;
      const proc = child;
      child = undefined;
      proc?.stdin?.end();
      proc?.kill();
    },
  };
}
