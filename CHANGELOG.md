# Changelog

All notable changes to this project are documented here. Versions
follow `v0.5.bx-NN` where `bx` is the modularization branch and
`NN` is the iteration counter.

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
- The plugin at `C:\Users\mjc39\.minimax\plugins\mcode-webui\`
  (the mavis-level install) was not updated in this pass; its
  `SKILL.md` is a different artifact (mavis skill format, with
  the install steps for the mcode.ps1 shim injection).
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
