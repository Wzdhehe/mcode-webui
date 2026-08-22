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
  lstatSync,
  mkdirSync,
  readdirSync,
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

// Return the symlink/junction target if `p` is one; null otherwise.
//   On Windows, `lstat` does NOT report isSymbolicLink() for junctions in
//   older Node, but `readlinkSync` works for both. Try lstat first; if
//   that fails OR the path is a symlink, return readlinkSync() result.
function readJunctionTarget(p) {
  try {
    const lst = lstatSync(p);
    if (lst.isSymbolicLink()) return readlinkSync(p);
    // Windows junctions: lstat reports isDirectory() === true for the
    // junction (because Windows reparse points confuse stat), but
    // readlinkSync still returns the target. Try it regardless of lstat.
    if (process.platform === "win32") {
      try {
        return readlinkSync(p);
      } catch {
        return null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

// Recursive copy that resolves junctions/symlinks. For each entry:
//   - If it's a junction/symlink: recurse into the resolved target
//   - If it's a real dir: recurse
//   - If it's a real file: copy
function copyRecursive(src, dest, stats) {
  const st = stats || statSync(src);
  if (st.isDirectory()) {
    mkdirSync(dest, { recursive: true });
    for (const child of readdirSync(src)) {
      if (SKIP.has(child)) continue;
      const childSrc = join(src, child);
      const childDest = join(dest, child);
      const childTarget = readJunctionTarget(childSrc);
      if (childTarget) {
        // Junction / symlink — recurse into the resolved target.
        // childTarget may be relative; resolve against src dir.
        const resolved =
          childTarget.startsWith("/") || /^[A-Z]:[\\/]/i.test(childTarget)
            ? childTarget
            : join(dirname(childSrc), childTarget);
        copyRecursive(resolved, childDest);
      } else {
        copyRecursive(childSrc, childDest);
      }
    }
  } else if (st.isFile()) {
    cpSync(src, dest);
  }
  // else: skip sockets/devices/etc.
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
console.log(`Copying ${SRC} -> ${DEST} (expanding junctions/symlinks)`);
copyRecursive(SRC, DEST);

// Verify: walk dist, ensure no entry is a symlink/junction.
const violations = [];
function walkAndCheck(p, rel = "") {
  let lst;
  try {
    lst = lstatSync(p);
  } catch {
    return;
  }
  if (lst.isSymbolicLink()) {
    violations.push(join(rel, basename(p)));
    return;
  }
  // Also check Windows junctions via readlinkSync
  if (process.platform === "win32") {
    try {
      readlinkSync(p);
      violations.push(join(rel, basename(p)) + " (junction)");
      return;
    } catch { /* not a junction */ }
  }
  if (lst.isDirectory()) {
    for (const child of readdirSync(p)) walkAndCheck(join(p, child), join(rel, child));
  }
}
walkAndCheck(DEST);

if (violations.length) {
  console.error(`FAIL: ${violations.length} symlinks/junctions remain in dist`);
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}
console.log(`OK: no symlinks/junctions in dist`);

// Quick file count + size summary
let fileCount = 0;
let totalSize = 0;
function walkCount(p) {
  const lst = lstatSync(p);
  if (lst.isFile()) {
    fileCount++;
    totalSize += lst.size;
  } else if (lst.isDirectory()) {
    for (const child of readdirSync(p)) walkCount(join(p, child));
  }
}
walkCount(DEST);
console.log(`Stats: ${fileCount} files, ${(totalSize / 1024).toFixed(1)} KB`);

// Write a manifest summary
const manifest = {
  generatedAt: new Date().toISOString(),
  source: relative(ROOT, SRC),
  dest: relative(ROOT, DEST),
  fileCount,
  totalSizeBytes: totalSize,
};
writeFileSync(join(DEST, "PACKAGE-MANIFEST.json"), JSON.stringify(manifest, null, 2));
console.log(`Wrote PACKAGE-MANIFEST.json`);

// Zip via PowerShell Compress-Archive (Windows built-in; cross-platform
// would need a Node zip lib — but contract says zero npm deps)
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

// Verify zip file
const zipStat = statSync(zipPath);
console.log(`DONE: ${zipPath} (${(zipStat.size / 1024).toFixed(1)} KB)`);
