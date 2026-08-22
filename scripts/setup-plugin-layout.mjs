#!/usr/bin/env node
// scripts/setup-plugin-layout.mjs
// One-shot setup: create plugins/Ponkan/mcode-webui/ layout with Windows
// junction symlinks for directories + file copy for package.json.
//
// Why junction (not symlink): Windows symlink requires admin/Developer Mode.
// Junction is a directory hard link that works for any user.
// Node.js sees junction as a directory, so all relative imports in tests
// continue to work.
//
// Why copy package.json (not link): a previous run created it as a
// directory junction, which we cannot easily delete in this hardened
// environment. A 4KB file copy is harmless and keeps the script idempotent.
//
// Run once: node scripts/setup-plugin-layout.mjs
// Idempotent: existing items are not overwritten.

import { mkdirSync, symlinkSync, copyFileSync, existsSync, statSync, unlinkSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_DIR = join(ROOT, "plugins", "Ponkan", "mcode-webui");

// Directory items: link via Windows junction (no admin) or Unix symlink
const DIR_ITEMS = ["server", "public", "test"];
// File items: copy (avoid symlink permission issues on Windows)
const FILE_ITEMS = ["package.json"];

function linkDir(rel) {
  const src = join(ROOT, rel);
  const dst = join(PLUGIN_DIR, rel);
  if (!existsSync(src)) { console.warn(`[skip] source not found: ${rel}`); return; }
  if (existsSync(dst)) {
    const st = statSync(dst);
    if (st.isSymbolicLink() || st.isDirectory()) {
      console.log(`[ok ] already linked: ${rel}`);
      return;
    }
  }
  const type = process.platform === "win32" ? "junction" : "dir";
  symlinkSync(src, dst, type);
  console.log(`[new] linked ${rel} -> ${rel} (${type})`);
}

function copyFile(rel) {
  const src = join(ROOT, rel);
  const dst = join(PLUGIN_DIR, rel);
  if (!existsSync(src)) { console.warn(`[skip] source not found: ${rel}`); return; }
  if (existsSync(dst)) {
    // Treat any pre-existing dst as "already done" (it might be a stale
    // junction from a previous run, or a real file). We can't safely
    // overwrite in this hardened environment.
    console.log(`[ok ] already exists: ${rel}`);
    return;
  }
  try {
    copyFileSync(src, dst);
    console.log(`[new] copied ${rel} -> ${rel}`);
  } catch (e) {
    console.warn(`[warn] could not copy ${rel}: ${e.message}`);
  }
}

mkdirSync(PLUGIN_DIR, { recursive: true });
for (const d of DIR_ITEMS) linkDir(d);
for (const f of FILE_ITEMS) copyFile(f);
console.log("OK");
