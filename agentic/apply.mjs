#!/usr/bin/env node
// Copyright (c) 2026 Ary Rabelo. All rights reserved. See agentic/LICENSE.
//
// Applies the agentic overlay to a checkout of upstream Rakazo, right before a build.
// Upstream files are never edited in git: this runs in the build tree only.
//
//   node agentic/apply.mjs          apply to the working tree (CI and image builds)
//   node agentic/apply.mjs --check  apply in memory only and report; exit 1 on any conflict
//
// Two kinds of change, both declared under agentic/:
//   files/<path>          new files copied to <path>. A path that upstream already has with
//                         different content is a conflict (upstream grew the same file).
//   patches/*.mjs         default export: an array of anchored edits to upstream files:
//                           { id, file, find, position: "before" | "after" | "replace", text }
//                         `find` must occur exactly once. An edit whose `text` is already in the
//                         file counts as applied, so running twice changes nothing.
// Any conflict aborts before anything is written, naming the edit, so an upstream update that
// moved an anchor fails the build loudly instead of shipping half the overlay.

import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const OVERLAY = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(OVERLAY, "..");
const check = process.argv.includes("--check");

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const exists = (p) =>
  stat(p).then(
    () => true,
    () => false,
  );

const errors = [];
const writes = new Map(); // absolute path -> new content
const read = async (abs) => writes.get(abs) ?? (await readFile(abs, "utf8"));

// 1. New files.
const filesDir = path.join(OVERLAY, "files");
for (const src of (await walk(filesDir)).sort()) {
  const rel = path.relative(filesDir, src);
  const dest = path.join(ROOT, rel);
  const content = await readFile(src, "utf8");
  if ((await exists(dest)) && (await readFile(dest, "utf8")) !== content) {
    errors.push(`files/${rel}: upstream already has ${rel} with other content`);
    continue;
  }
  writes.set(dest, content);
}

// 2. Anchored edits.
const patchFiles = (await walk(path.join(OVERLAY, "patches")))
  .filter((p) => p.endsWith(".mjs"))
  .sort();
const seen = new Set();
let applied = 0;
let already = 0;
for (const patchFile of patchFiles) {
  const edits = (await import(pathToFileURL(patchFile).href)).default;
  if (!Array.isArray(edits)) {
    errors.push(`${path.relative(OVERLAY, patchFile)}: default export must be an array`);
    continue;
  }
  for (const edit of edits) {
    const where = `${path.relative(OVERLAY, patchFile)}#${edit.id}`;
    if (!edit.id || seen.has(edit.id)) {
      errors.push(`${where}: missing or duplicate id`);
      continue;
    }
    seen.add(edit.id);
    if (!["before", "after", "replace"].includes(edit.position)) {
      errors.push(`${where}: position must be before, after or replace`);
      continue;
    }
    const abs = path.join(ROOT, edit.file);
    if (!(await exists(abs)) && !writes.has(abs)) {
      errors.push(`${where}: ${edit.file} does not exist`);
      continue;
    }
    const source = await read(abs);
    if (source.includes(edit.text)) {
      already++;
      continue;
    }
    const first = source.indexOf(edit.find);
    if (first < 0) {
      errors.push(`${where}: anchor not found in ${edit.file}`);
      continue;
    }
    if (source.indexOf(edit.find, first + 1) >= 0) {
      errors.push(`${where}: anchor occurs more than once in ${edit.file}`);
      continue;
    }
    const end = first + edit.find.length;
    const next =
      edit.position === "before"
        ? source.slice(0, first) + edit.text + source.slice(first)
        : edit.position === "after"
          ? source.slice(0, end) + edit.text + source.slice(end)
          : source.slice(0, first) + edit.text + source.slice(end);
    writes.set(abs, next);
    applied++;
  }
}

if (errors.length) {
  console.error(`agentic overlay: ${errors.length} conflict(s), nothing written:`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
if (!check) {
  for (const [abs, content] of writes) {
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, content);
  }
}
const files = (await walk(filesDir)).length;
console.log(
  `agentic overlay ${check ? "checked" : "applied"}: ${files} new file(s), ${applied} edit(s) applied, ${already} already present`,
);
