<!-- Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE. -->
# agentic overlay

Our changes on top of upstream Rakazo, kept out of upstream's files so the fork can follow
upstream `main` without merge conflicts. Licensed separately: see `LICENSE` in this folder.
Upstream Rakazo stays under Apache 2.0 (`../LICENSE`, `../NOTICE`).

## How it works

Nothing under `apps/`, `packages/` or `infra/` is edited in git. At build time, after checking
out upstream code, the build runs:

```sh
node agentic/apply.mjs
```

which copies `files/<path>` into the tree and applies the anchored edits in `patches/*.mjs`.
Each edit names an exact anchor that must occur once. If an upstream update moves or removes an
anchor, the run lists every conflict and writes nothing, so the build fails instead of shipping a
half-applied overlay. Running it twice changes nothing.

`node agentic/apply.mjs --check` does the same in memory: run it after pulling upstream.

Do not commit an applied tree. To go back after a local build: `git checkout -- apps packages infra`
and remove the copied files listed under `files/`.

## Updating upstream

```sh
git fetch upstream && git merge upstream/main   # only upstream files change; agentic/ is ours
node agentic/apply.mjs --check                   # fix any anchor it reports, in patches/
```

## Features

### Route traffic through this computer

A switch in the desktop app's computer settings, below **Let bots use this computer**. When it
is on, the browser on the person's bots' cloud computers reaches the web through the person's own
internet connection instead of the server's. For sites that block datacenter addresses.

- Desktop: a separate egress proxy process, listening on `127.0.0.1` only, reachable only with a
  per-launch secret, with no file access (macOS sandbox), reaching only public addresses on ports
  80 and 443. Other platforms do not offer the switch.
- Transport: TCP tunnels over the paired device's existing WebSocket
  (`files/packages/adapters/src/computers/host/agentic-tunnel-protocol.ts`).
- Server: the supervisor gives each Docker computer a proxy on that computer's own network and
  points its browser at it, falling back to a direct connection when the owner's desktop is not
  connected or the switch is off.

Builds: `.github/workflows/agentic-app-image.yml` (server image) and
`.github/workflows/agentic-desktop.yml` (macOS desktop app, unsigned).
