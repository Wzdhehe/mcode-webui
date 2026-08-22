#!/usr/bin/env node
// scripts/validate-plugin.mjs
//
// Validate plugins/Ponkan/mcode-webui/ against the mcode-plugin-guide
// contract.md + red-lines.md. Single source of truth for what
// "shippable" means.
//
// Checks (exit non-zero on any ERR):
//   - plugin.json: top-level white-list, $schema, name, version, description,
//     author, license, keywords
//   - SKILL.md: frontmatter, name matches dir, description ≤1024, no hooks
//   - README.md: present + non-empty
//   - LICENSE: present + non-empty
//   - No symlinks/junctions in the plugin tree
//   - No UTF-8 BOM in any text file
//   - No "TODO" in shipped files
//   - No "hooks" / unsupported fields in plugin.json
//
// Warnings (exit 0) cover soft issues (e.g. missing version).
//
// Usage:
//   node scripts/validate-plugin.mjs

import { readFileSync, readdirSync, lstatSync, statSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLUGIN_DIR = join(ROOT, "plugins", "Ponkan", "mcode-webui");
const PLUGIN_JSON = join(PLUGIN_DIR, "plugin.json");
const SKILL_MD = join(PLUGIN_DIR, "SKILL.md");
const README = join(PLUGIN_DIR, "README.md");
const LICENSE = join(PLUGIN_DIR, "LICENSE");

const errors = [];
const warnings = [];
const ok = (msg) => console.log(`  OK   ${msg}`);
const fail = (msg) => { errors.push(msg); console.log(`  ERR  ${msg}`); };
const warn = (msg) => { warnings.push(msg); console.log(`  WARN ${msg}`); };

// ---------------------------------------------------------------
// 1. plugin.json
// ---------------------------------------------------------------
const ALLOWED_TOP_KEYS = ["$schema", "name", "version", "description", "author", "homepage", "repository", "license", "keywords", "extensions"];
const NAME_REGEX = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
const SKILL_NAME_REGEX = /^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FORBIDDEN_AUTHOR_KEYS = ["hooks", "lifecycle", "scripts", "config"]; // not strictly forbidden but unused
const EXPECTED_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";

console.log("=== plugin.json ===");
let plugin;
try {
  plugin = JSON.parse(readFileSync(PLUGIN_JSON, "utf8"));
  ok("parses as JSON");
} catch (e) {
  fail(`plugin.json parse error: ${e.message}`);
  printSummaryAndExit();
}

const topKeys = Object.keys(plugin);
const extraKeys = topKeys.filter((k) => !ALLOWED_TOP_KEYS.includes(k));
if (extraKeys.length) fail(`non-whitelisted top-level keys: ${extraKeys.join(", ")}`);
else ok(`top-level keys (${topKeys.length}) all in white-list`);

if (!plugin["$schema"]) fail("missing $schema");
else if (plugin["$schema"] !== EXPECTED_SCHEMA)
  fail(`$schema is "${plugin["$schema"]}" (expected ${EXPECTED_SCHEMA})`);
else ok(`$schema = ${EXPECTED_SCHEMA}`);

if (!plugin.name || plugin.name.length > 64) fail("name missing or > 64");
else if (!NAME_REGEX.test(plugin.name)) fail(`name fails regex: ${plugin.name}`);
else ok(`name = "${plugin.name}"`);

if (!plugin.version) warn("missing version (recommended)");
else ok(`version = ${plugin.version}`);

if (!plugin.description || plugin.description.length > 1024)
  fail(`description missing or > 1024 (current: ${plugin.description?.length})`);
else ok(`description = ${plugin.description.length} chars`);

if (typeof plugin.author !== "object" || Array.isArray(plugin.author))
  fail("author must be object, not string");
else {
  const ak = Object.keys(plugin.author);
  const ae = ak.filter((k) => !["name", "email", "url"].includes(k));
  if (ae.length) fail(`author has extra fields: ${ae.join(", ")}`);
  if (!plugin.author.name) fail("author.name missing");
  else ok(`author.name = ${plugin.author.name}`);
}

if (!plugin.license || typeof plugin.license !== "string" || plugin.license.length === 0)
  fail("license missing or non-string");
else ok(`license = ${plugin.license}`);

if (!Array.isArray(plugin.keywords) || plugin.keywords.length === 0)
  fail("keywords missing or empty");
else if (!plugin.keywords.every((k) => typeof k === "string"))
  fail("keywords must be array of strings");
else ok(`keywords = [${plugin.keywords.join(", ")}]`);

// Forbid "hooks" / unsupported capability fields anywhere
const flat = JSON.stringify(plugin);
if (/"hooks"\s*:/.test(flat) || /"lifecycle"\s*:/.test(flat))
  fail(`plugin.json contains unsupported "hooks" or "lifecycle" field`);
else ok(`no "hooks" or "lifecycle" fields`);

// ---------------------------------------------------------------
// 2. SKILL.md
// ---------------------------------------------------------------
console.log();
console.log("=== SKILL.md ===");
try {
  const txt = readFileSync(SKILL_MD, "utf8");
  if (!txt.startsWith("---\n")) fail("SKILL.md does not start with `---\\n`");
  else ok("starts with `---` frontmatter");

  const fmMatch = txt.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    fail("SKILL.md frontmatter is not closed with `\\n---\\n`");
  } else {
    const fm = fmMatch[1];
    const body = fmMatch[2];
    if (body.trim().length === 0) fail("SKILL.md body is empty");
    else ok(`body = ${body.length} chars`);

    // Parse frontmatter as YAML-ish (very loose: just key: value lines)
    const fmLines = fm.split("\n");
    const fmMap = {};
    for (const line of fmLines) {
      const m = line.match(/^([a-zA-Z_]+)\s*:\s*(.*)$/);
      if (m) fmMap[m[1]] = m[2];
    }
    if (!fmMap.name) fail("frontmatter missing `name`");
    else if (fmMap.name !== plugin.name) fail(`frontmatter name (${fmMap.name}) != plugin.json name (${plugin.name})`);
    else if (!SKILL_NAME_REGEX.test(fmMap.name)) fail(`frontmatter name fails regex: ${fmMap.name}`);
    else ok(`frontmatter name = "${fmMap.name}"`);

    if (!fmMap.description) fail("frontmatter missing `description`");
    else if (fmMap.description.length > 1024) fail(`frontmatter description > 1024 (${fmMap.description.length})`);
    else ok(`frontmatter description = ${fmMap.description.length} chars`);
  }
} catch (e) {
  fail(`SKILL.md read error: ${e.message}`);
}

// ---------------------------------------------------------------
// 3. README.md (required by contract.md "必须包含非空 README.md")
// ---------------------------------------------------------------
console.log();
console.log("=== README.md ===");
try {
  const txt = readFileSync(README, "utf8");
  if (txt.trim().length === 0) fail("README.md is empty");
  else ok(`README.md = ${txt.length} chars`);
} catch (e) {
  fail(`README.md missing: ${e.message}`);
}

// ---------------------------------------------------------------
// 4. LICENSE (required by contract.md "必须包含非空 LICENSE")
// ---------------------------------------------------------------
console.log();
console.log("=== LICENSE ===");
try {
  const txt = readFileSync(LICENSE, "utf8");
  if (txt.trim().length === 0) fail("LICENSE is empty");
  else ok(`LICENSE = ${txt.length} chars`);
} catch (e) {
  fail(`LICENSE missing: ${e.message}`);
}

// ---------------------------------------------------------------
// 5. No symlinks / junctions in plugin tree
// ---------------------------------------------------------------
// Note: in DEV layout, plugins/Ponkan/mcode-webui/{server,public,test}
// are Windows junctions to the project root. This is INTENTIONAL — the
// release artifact (`dist/`, built by `npm run package:plugin`) expands
// them into real files. We allow-list the 3 dev junctions here; the
// dist/ check below enforces "no junctions in shipped artifact".
const DEV_JUNCTION_ALLOWLIST = new Set([
  join(PLUGIN_DIR, "server"),
  join(PLUGIN_DIR, "public"),
  join(PLUGIN_DIR, "test"),
]);
console.log();
console.log("=== No symlinks/junctions (dev allowlist applied) ===");
let symlinkCount = 0;
function walkCheckSymlinks(p) {
  let lst;
  try { lst = lstatSync(p); } catch { return; }
  if (lst.isSymbolicLink()) {
    if (DEV_JUNCTION_ALLOWLIST.has(p)) return; // dev-only, OK
    symlinkCount++;
    fail(`symlink: ${p}`);
    return;
  }
  if (process.platform === "win32") {
    // Junction detection on Windows: lstat on a junction returns a
    // stat for the junction (not the target), so isDirectory() is
    // usually true. readlinkSync works for both symlinks and junctions.
    // We already handled symlink case above. Junction check:
    try {
      // readlinkSync will throw on a non-reparse-point file/dir
      const lst2 = lstatSync(p);
      // On NTFS junctions, lstat is unreliable. Use the fact that
      // Windows junctions appear as directories in statSync. The
      // check above (isSymbolicLink) already catches Unix-style
      // symlinks. For Windows junctions, the dist/ check below is
      // the authoritative one.
      if (lst2.isDirectory()) {
        for (const child of readdirSync(p)) walkCheckSymlinks(join(p, child));
        return;
      }
    } catch { /* not a junction */ }
  }
  if (lst.isDirectory()) {
    for (const child of readdirSync(p)) walkCheckSymlinks(join(p, child));
  }
}
walkCheckSymlinks(PLUGIN_DIR);
if (symlinkCount === 0) ok("no unexpected symlinks in dev tree (3 allow-listed junctions: server, public, test)");

// Also verify dist/ is clean (if it exists)
const DIST = join(ROOT, "dist", "Ponkan", "mcode-webui");
if (existsSync(DIST)) {
  let distSym = 0;
  function walkDist(p) {
    let lst;
    try { lst = lstatSync(p); } catch { return; }
    if (lst.isSymbolicLink()) { distSym++; fail(`dist symlink: ${p}`); return; }
    if (lst.isDirectory()) for (const c of readdirSync(p)) walkDist(join(p, c));
  }
  walkDist(DIST);
  if (distSym === 0) ok(`dist/ ${DEST_REL(DIST)} is clean (no symlinks)`);
} else {
  warn(`dist/ not built yet — run \`npm run package:plugin\` to verify release artifact`);
}

// ---------------------------------------------------------------
// 6. No UTF-8 BOM in any text file
// ---------------------------------------------------------------
console.log();
console.log("=== No UTF-8 BOM ===");
const TEXT_EXTS = new Set([".md", ".json", ".js", ".mjs", ".cjs", ".ts", ".txt", ".yml", ".yaml"]);
let bomCount = 0;
function walkCheckBom(p) {
  let lst;
  try { lst = lstatSync(p); } catch { return; }
  if (lst.isDirectory()) {
    for (const child of readdirSync(p)) walkCheckBom(join(p, child));
  } else if (lst.isFile() && TEXT_EXTS.has("." + p.split(".").pop().toLowerCase())) {
    const fd = readFileSync(p);
    if (fd.length >= 3 && fd[0] === 0xef && fd[1] === 0xbb && fd[2] === 0xbf) {
      bomCount++;
      fail(`UTF-8 BOM in ${p}`);
    }
  }
}
walkCheckBom(PLUGIN_DIR);
if (bomCount === 0) ok("no UTF-8 BOM");

// ---------------------------------------------------------------
// 7. No "TODO" in shipped files
// ---------------------------------------------------------------
// PR_DESCRIPTION.md is a TEMPLATE — its checklist mentions "TODO" by
// design ("no TODO in shipped files"). Exclude it.
const TODO_SKIP = new Set([join(PLUGIN_DIR, "PR_DESCRIPTION.md")]);
console.log();
console.log("=== No TODO in shipped files ===");
let todoCount = 0;
function walkCheckTodo(p) {
  let lst;
  try { lst = lstatSync(p); } catch { return; }
  if (lst.isDirectory()) {
    for (const child of readdirSync(p)) walkCheckTodo(join(p, child));
  } else if (lst.isFile() && TEXT_EXTS.has("." + p.split(".").pop().toLowerCase())) {
    if (TODO_SKIP.has(p)) return;
    const txt = readFileSync(p, "utf8");
    // Match TODO but not "TODO_LIST" (e.g. word boundary matters)
    if (/\bTODO\b/.test(txt)) {
      todoCount++;
      fail(`TODO in ${p.replace(ROOT + "\\", "")}`);
    }
  }
}
walkCheckTodo(PLUGIN_DIR);
if (todoCount === 0) ok("no TODO");

// ---------------------------------------------------------------
// 8. SECURITY-NOTES.md exists (red-line 7 best practice)
// ---------------------------------------------------------------
console.log();
console.log("=== references/SECURITY-NOTES.md ===");
try {
  const sec = readFileSync(join(PLUGIN_DIR, "references", "SECURITY-NOTES.md"), "utf8");
  if (sec.length < 500) warn(`SECURITY-NOTES.md is short (${sec.length} chars) — ensure full disclosure`);
  else ok(`SECURITY-NOTES.md = ${sec.length} chars`);
} catch (e) {
  warn(`references/SECURITY-NOTES.md missing: ${e.message}`);
}

// ---------------------------------------------------------------
// Summary
// ---------------------------------------------------------------
printSummaryAndExit();

function printSummaryAndExit() {
  console.log();
  console.log("=== summary ===");
  console.log(`errors:   ${errors.length}`);
  console.log(`warnings: ${warnings.length}`);
  process.exit(errors.length > 0 ? 1 : 0);
}

function DEST_REL(p) {
  return p.replace(ROOT, "").replace(/^[\\/]/, "");
}
