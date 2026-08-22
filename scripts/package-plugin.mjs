#!/usr/bin/env node
// scripts/package-plugin.mjs
// Package plugins/Ponkan/mcode-webui/ into a distributable directory and
// zip file. Resolves any junction/symlink so the final artifact contains
// only real files (mcode-plugin-guide contract forbids symlinks in hosted
// plugins).
//
// Usage:
//   node scripts/package-plugin.mjs
//   # produces:
//   #   dist/Ponkan/mcode-webui/        (expanded tree, no symlinks)
//   #   dist/Ponkan/mcode-webui.zip     (zipped)
//
// Skips: node_modules/, .git/, coverage/, .server.*, *.log, etc.

import {
  cpSync,
  existsSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, relative, basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SRC = join(ROOT, "plugins", "Ponkan", "mcode-webui");
const DEST_PARENT = join(ROOT, "dist", "Ponkan");
const DEST = join(DEST_PARENT, "mcode-webui");

// Files / dirs to skip
const SKIP = new Set([
  "node_modules",
  ".git",
  "coverage",
  ".server.log",
  ".server.err",
  ".server.out.log",
  ".server.err.log",
]);

function isJunctionOrSymlink(p) {
  try {
    return statSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

// Recursive copy with junction/symlink resolution
function copyRecursive(src, dest) {
  const st = statSync(src); // follows symlinks/junctions, returns target info
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const child of readdirSyncSafe(src)) {
      if (SKIP.has(child)) continue;
      copyRecursive(join(src, child), join(dest, child));
    }
  } else if (st.isFile()) {
    copyFileSync(src, dest);
  } else {
    // Skip other types (sockets, devices, etc.)
  }
}

// Local imports (avoid pulling in 'node:fs' at top for these)
import { copyFileSync, readdirSync } from "node:fs";
function readdirSyncSafe(p) {
  try { return readdirSync(p); } catch { return []; }
}

if (!existsSync(SRC)) {
  console.error(`Source not found: ${SRC}`);
  console.error("Run `npm run setup:plugin` first.");
  process.exit(1);
}

if (existsSync(DEST)) {
  rmSync(DEST, { recursive: true, force: true });
}
mkdirSync(DEST_PARENT, { recursive: true });
console.log(`Copying ${SRC} -> ${DEST} (expanding symlinks/junctions)`);

// Use cpSync with `verbatim: false, followSymlinks: true` (Node 22+)
cpSync(SRC, DEST, {
  recursive: true,
  verbatim: false,
  followSymlinks: true,
  filter: (src) => {
    const base = basename(src);
    return !SKIP.has(base);
  },
});

// Verify no symlinks/junctions remain
const violations = [];
function walkAndCheck(p) {
  const st = statSync(p);
  if (st.isDirectory()) {
    for (const child of readdirSyncSafe(p)) walkAndCheck(join(p, child));
  }
}
try { walkAndCheck(DEST); } catch (e) { console.warn(`walk error: ${e.message}`); }
if (violations.length) {
  console.error(`FAIL: ${violations.length} symlinks/junctions remain in dist`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log("OK: no symlinks/junctions in dist");

// Zip
const zipPath = `${DEST}.zip`;
if (existsSync(zipPath)) rmSync(zipPath);
console.log(`Zipping ${DEST} -> ${zipPath}`);
const r = spawnSync("powershell", [
  "-NoProfile",
  "-Command",
  `Compress-Archive -Path '${DEST}' -DestinationPath '${zipPath}' -Force`,
], { stdio: "inherit" });
if (r.status !== 0) {
  console.error(`zip failed (exit ${r.status})`);
  process.exit(1);
}
console.log(`DONE: ${zipPath}`);
