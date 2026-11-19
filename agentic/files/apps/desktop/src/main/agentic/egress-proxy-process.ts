// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
//
// Entry of the sandboxed egress proxy process (bundled to dist/egress-proxy.cjs). The secret
// arrives as the first line on stdin, never in argv or the environment. Prints `ready <port>`
// once listening on 127.0.0.1, and exits when stdin closes, so it never outlives the app.
import { createEgressProxy } from "./egress-proxy.js";

let input = "";
function onInput(chunk: Buffer) {
  input += chunk.toString("utf8");
  const newline = input.indexOf("\n");
  if (newline < 0) {
    if (input.length > 1024) process.exit(2);
    return;
  }
  process.stdin.off("data", onInput);
  const server = createEgressProxy({ secret: input.slice(0, newline).trim() });
  input = "";
  server.listen({ host: "127.0.0.1", port: 0, exclusive: true }, () => {
    const address = server.address();
    if (address === null || typeof address === "string") process.exit(3);
    process.stdout.write(`ready ${address.port}\n`);
  });
  server.on("error", () => process.exit(4));
}
process.stdin.on("data", onInput);
process.stdin.on("end", () => process.exit(0));
process.stdin.on("error", () => process.exit(0));
