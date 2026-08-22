# Changelog

All notable changes to this project are documented here. Versions
follow `vMAJOR.MINOR.PATCH`. The `v0.5.bx-NN` scheme was used during
the modularization period (2026-08-17 → 2026-08-20) and is preserved
in the "Earlier history" table below.

This project follows [Keep a Changelog](https://keepachangelog.com/).
The `## Unreleased` section at the top tracks changes that have
landed on the development branch but are not yet cut into a release.

## Unreleased

> Documentation patch layered on top of v1.0.0 — no behavior
> changes, no version bump. The plugin schema (`plugin.json`),
> runtime, and API surface are byte-identical to v1.0.0.

### Added

- **`README.zh-CN.md`** — full Chinese translation of `README.md`,
  with a "命名说明" section explaining why the product is called
  "Mcode CLI 的 webui" (mcode is the upstream CLI; webui is the
  browser layer for it — the direction is CLI → webui, not the
  other way around).
- **`CONTRIBUTING.md`** at the repo root — contribution workflow,
  commit message convention, PR checklist, release process,
  sync rule for the dual-layout repo, style guide, FAQ.
- **`CONTRIBUTING.md`** in the plugin tree — a short pointer doc
  for plugin-tree-only readers, linking back to the source repo.

### Changed

- **`SKILL.md` moved** from `plugins/Wzdhehe/mcode-webui/SKILL.md`
  to `plugins/Wzdhehe/mcode-webui/skills/mcode-webui/SKILL.md` to
  match the official Agent Plugins 1.0 `skills/` layout (the local
  `validate-plugin` mirror flagged this; the official registry
  gate is the same check).
- **`PR_DESCRIPTION.md`** — placeholder phrasing ("fill in the
  blanks", "Template for the upstream PR") replaced with direct
  language ("Submission body — use verbatim"). Repository link
  corrected from the non-existent `hetaoBackend/MiniMax-Code-Plugins`
  to the official `MiniMax-AI/MiniMax-Code-Plugins`.

### Verified (no code changes in this patch)

- `npm test` — 302/302 pass
- `npm run lint` — 0 warnings
- `npm run validate:plugin` — 0 errors, 0 warnings
- No tracked debug residue (`git ls-files` shows zero
  `.server.*`, `acp-probe*`, `goal-plan-probe*`, `probes/`)
- No new `node_modules` / build artifacts in the working tree
- No personal data committed (no IPs, usernames, real session
  IDs in any tracked file)

## v1.0.0 (2026-08-22) — First public release

> Scope: visual redesign, several silent-bug fixes, delete-coverage
> overhaul, and version alignment ahead of the first push.

### Fixed

- **Global toast was silently dead** — `showToast()` writes to
  `#toast`, but the element never existed in `index.html`; every toast
  in the app (LAN toggle, usage refresh, copy confirmations) was a
  no-op. Added the element + a single consolidated `.toast` rule
  (an earlier duplicate rule pair produced a stretched-box bug where
  `top: 50%` + `bottom: 96px` with no height made one-line toasts
  render screen-tall).
- **GitHub link covered by LAN popover** — the LAN URL hover popover
  positioned itself directly below the LAN card, on top of the GitHub
  link. The popover was removed entirely (the topbar LAN chip already
  shows + copies the access URL); LAN card now only toggles.
- **Session delete left ~19k-row orphans per active session** — the
  cross-delete covered 9 of 33 session-keyed tables in the Mcode
  schema, missing `local_runtime_message_rows` (message bodies),
  `local_runtime_token_usage`, `local_runtime_pi_history_rows`, and
  more. Table list extended to 32 (all `local_runtime_*` tables with a
  `session_id` column; `questionnaire_requests` skipped — ownership
  unclear). Verified by E2E: real-delete against a 713 MB copy of the
  production db reduced an 11,176-row session to 7 rows (the skipped
  table only).

### Changed

- **Theme: "Ink & Brass" → "Ink & Paper"** — full monochrome
  black/white palette; accent is near-white (dark) / near-black
  (light); new `--on-accent` token keeps text readable on accent
  backgrounds; success/warning desaturated to grays, danger kept as
  muted red. LAN wifi icon keeps a functional green (`--status-on`)
  when broadcast is on.
- **LAN toggle toast copy** (zh/en): "局域网已开启 — 局域网内其他设备
  可访问" / "LAN access on — other devices on this network can access"
  (and the off variants).
- **Version → v1.0** everywhere: topbar `v1.0`, manifests `1.0.0`.

### Added

- `MCODE_RUNTIME_DB` env override — lets tests run the real-delete
  path against a copy of the Mcode runtime db instead of the live one.
- Historical port note: default port is 8080 (was 7890 before v0.5).

## v0.5.bx (2026-08-20) — Documentation rewrite

> Scope: technical-tone rewrite of the entire documentation set, plus
> `SKILL.md` for plugin packaging.

### Added

- `README.md` — complete rewrite. Project overview, capability
  summary, quickstart, env reference, doc map, repository layout,
  why two mcode transports, known limitations.
- `docs/ARCHITECTURE.md` — complete rewrite. High-level topology
  diagram, request lifecycle trace, module contracts table, full
  `clientState.state` payload schema, SSE event schema, frontend
  topology, failure modes, instructions for adding new endpoints.
- `docs/CAPABILITIES.md` — **new file**. Full capability matrix:
  what works, what's partial, what's blocked, what mcode would
  need to add to unblock each ❌ row. Organized by feature area
  (chat, plan, permissions, ask-user, slash, workspace, sessions,
  usage, attachments, UI, network, ops).
- `docs/API.md` — **new file**. Every HTTP endpoint documented:
  method, path, request body schema, response schema, error cases,
  auth requirements, gating rules. Includes the static file
  endpoint table and the LAN-rejection exemption note.
- `docs/DEVELOPMENT.md` — **new file**. Dev setup, repo hygiene,
  recipes for adding routes / events / UI panels / slash commands
  (webui-side and mcode-translated), testing without mcode, common
  tasks (cache-bust, port change, debug subprocess), style guide,
  code review checklist.
- `docs/TROUBLESHOOTING.md` — **new file**. ~15 common failures
  with symptom → cause → fix triples, organized by observable
  symptom. Covers the 6 most common issues from the 2026-08 user
  feedback batch.
- `SKILL.md` — **new file**. mavis/minimax plugin-format description
  at the repo root. Frontmatter metadata + body covering when to
  use, how to start, capabilities matrix, architecture, plugin
  integration, known issues, doc map.
- `.minimax-plugin/plugin.json` — **new file**. Plugin manifest
  with schemaVersion 1, all 7 configurable env knobs documented,
  full endpoint table, capability tags, doc references.
- `CHANGELOG.md` — this file.

### Changed

- `README.md` — rewrote from 130 lines (architecture dump with
  partial code references) to 230 lines (overview + quickstart +
  capability matrix + doc map + repo layout).

### Notes

- `docs/acp-goal-plan-status.md` kept as-is (archaeology only).
- The plugin at `~\.minimax\plugins\Mcode-webui\`
  (the mavis-level install) was not updated in this pass; its
  `SKILL.md` is a different artifact (mavis skill format, with
  the install steps for the Mcode.ps1 shim injection).
- No code changes in this version — server, routes, libs, public/
  are all byte-identical to the previous `70e3555` commit. This
  is a docs-only release.

## Earlier history (pre-documentation-rewrite)

| Date | Commit | Summary |
|---|---|---|
| 2026-08-20 | `651aafc` | i18n: session delete 二次确认 + send/stop tooltip + workspace unset 补漏 |
| 2026-08-20 | `70e3555` | fix: 删 main.js 残留的 3 个被删 button 引用 (workspace-picker-confirm/tui/reset) |
| 2026-08-20 | `fa30285` | fix: 修 renderTreeNodes for 循环被吃 + browseToggle 提前出 scope 的 bug |
| 2026-08-20 | `c40c743` | debug log 面板 (visible) + render() 包 try/catch |
| 2026-08-20 | `ab54b78` | v0.5.bx UI 反馈 6 处修复 (tpsEl null / 删 3 按钮 / i18n / 版本 / cache-bust) |
| 2026-08-20 | `3a43f17` | v0.5.by: mcode acp 协议层封装 + 能力探测 + 降级路径 |
| 2026-08-20 | `b06bcea` | docs: remove backup HTMLs, add ARCHITECTURE.md, update README |
| 2026-08-20 | `44ed608` | refactor: extract inline `<style>` to /public/styles/main.css |
| 2026-08-20 | `5a0e364` | refactor: add `?v=2` cache-bust to /app/main.js |
| 2026-08-20 | `5114218` | refactor: extract inline `<script>` to /public/app/main.js ES module |
| 2026-08-20 | `6dfe014` | refactor: encapsulate sseByCid via state-bus helpers |
| 2026-08-20 | `97c499a` | refactor: split server.js (2456 → 55 lines) into lib/ + routes/ + router.js |
| 2026-08-20 | `4a279be` | (rollback anchor) pre-modularization monolithic webui snapshot |
