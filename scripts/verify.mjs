#!/usr/bin/env node
// scripts/verify.mjs
//
// Full pre-flight check for shipping the mcode-webui plugin.
// Runs in order:
//   1. validate-plugin   (plugin.json + SKILL.md + README + LICENSE + symlinks + BOM + TODO)
//   2. npm test          (290+ unit tests, must all pass)
//   3. npm run lint      (ESLint, 0 warnings)
//   4. npm run package:plugin  (rebuild dist/ zip)
//
// Exits non-zero on first failure. Outputs a summary at the end.
//
// Usage:
//   node scripts/verify.mjs
//   npm run verify

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));

// Avoid shell:true + args concatenation (DEP0190) by invoking node /
// scripts directly. npm.cmd wrappers are platform-specific — node + the
// actual script path works everywhere.
const steps = [
  {
    name: "validate-plugin",
    cmd: "node",
    args: [join(ROOT, "scripts", "validate-plugin.mjs")],
  },
  {
    name: "test",
    cmd: "node",
    args: [
      "--experimental-test-module-mocks",
      "--test",
      "test/*.test.js",
    ],
  },
  {
    name: "lint",
    cmd: "node",
    args: ["node_modules/eslint/bin/eslint.js", "server/", "test/"],
  },
  {
    name: "package:plugin",
    cmd: "node",
    args: [join(ROOT, "scripts", "package-plugin.mjs")],
  },
];

console.log(`=== verify.mjs (${new Date().toISOString()}) ===\n`);

let totalMs = Date.now();
const results = [];
for (const s of steps) {
  const t0 = Date.now();
  console.log(`\n--- ${s.name} ---`);
  const r = spawnSync(s.cmd, s.args, {
    cwd: ROOT,
    stdio: "inherit",
  });
  const dt = Date.now() - t0;
  if (r.error) {
    console.error(`spawn error: ${r.error.message}`);
    results.push({ name: s.name, ok: false, ms: dt, error: r.error.message });
    break;
  }
  const ok = r.status === 0;
  results.push({ name: s.name, ok, ms: dt, status: r.status });
  if (!ok) break;
}

const dur = ((Date.now() - totalMs) / 1000).toFixed(1);
console.log(`\n=== verify.mjs summary (${dur}s) ===`);
for (const r of results) {
  const flag = r.ok ? "PASS" : "FAIL";
  console.log(`  ${flag}  ${r.name}  (${(r.ms / 1000).toFixed(1)}s)`);
}
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`\n${failed.length} step(s) failed.`);
  process.exit(1);
}
console.log("\nAll checks passed.");
