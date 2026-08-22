# Mcode Web UI

**[English](README.md) | [简体中文](README.zh-CN.md)**

Browser-based chat frontend for the **Mcode CLI** — run `mcode` from a
browser instead of the terminal. Speaks Mcode's own protocols directly
(`mcode acp` JSON-RPC + `mcode exec` stream-json); not a TUI wrapper.
Zero npm dependencies at runtime (Node 22+ stdlib only).

> 三栏布局(会话/对话/上下文),`/` 命令搜索,附件上传,套餐用量右向展开,
> token 鉴权局域网,移动端响应。

```
[Browser :8080] ←─ SSE /api/events ─ [Node server.js] ─ mcode acp / exec ─ [Mcode CLI]
      │                                     │
      └──── REST /api/* ────────────────────┴── ~/.minimax/v2 sqlite (read + session delete)
```

## Features

- **Three-column layout** — sessions / conversation / context panel
- **Real-time streaming** — model output, tool events (Bash / Read /
  Edit / Glob / Grep / WebFetch…), agent thought chunks
- **Slash command search** — `/` opens the palette with fuzzy search
  over live Mcode commands + webui-local commands
- **File attachments** — click / drag / Ctrl+V paste; paths injected as `@file`
- **Quota panel** — right-side expandable: 5h + weekly quota, context
  bar, cache hit rate, tok/s, per-session token stats
- **Plan review & ask-user modals** — plan mode and `AskUserQuestion`
  surface as native UI, not terminal prompts
- **Workspace switching** — directory-tree browser (Windows drives, `/`)
- **Token-authed LAN sharing** — `0.0.0.0` bind, `?token=` or
  `Authorization: Bearer`, runtime on/off toggle with friendly 403 page
- **Mobile responsive** — `<900px` drawers, `<600px` single column
- **Bilingual UI** — English / 简体中文, instant toggle
- **Monochrome theme** — "Ink & Paper" dark / light, follows system
- **Two transports** — `mcode acp` (default, multi-turn) with
  `mcode exec` fallback for old clients / degraded mode

## Quick start

```bash
git clone https://github.com/Wzdhehe/Mcode-webui.git
cd Mcode-webui
node server.js                 # Mcode CLI auto-detected
# → http://127.0.0.1:8080/     (LAN: http://<lan-ip>:8080/)

# Recommended on shared networks:
TOKEN=$(openssl rand -hex 16) node server.js
# → open http://127.0.0.1:8080/?token=$TOKEN
```

## Configuration

All env vars, all optional:

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `8080` | HTTP port (was `7890` before v1.0) |
| `HOST` | `0.0.0.0` | Bind address (`127.0.0.1` = loopback-only) |
| `TOKEN` | (empty) | Required token for non-local requests |
| `MCODE_MODEL` | `minimax_api/MiniMax-M3` | Default model |
| `MCODE_CMD` | auto-detect | `mcode` / `mcode.cmd` path |
| `MCODE_WEBUI_UPLOAD_DIR` | auto | Attachment directory |
| `MCODE_RUNTIME_DB` | `~/.minimax/v2/...` | mcode runtime db (tests use copies) |

## Known limitations (mcode 0.1.5 acp)

Reported upstream 2026-08: `session/set_mode`, `session/cancel`,
`session/fork`, `session/delete`… return "Method not found". The webui
whitelists these in `mcode-rpc.js` and degrades gracefully (toast +
fallback) — no fake UI buttons. Full matrix:
[docs/CAPABILITIES.md](docs/CAPABILITIES.md).

## Documentation

| Doc | What |
|-----|------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module topology, SSE schema, request lifecycle |
| [docs/CAPABILITIES.md](docs/CAPABILITIES.md) | What works / doesn't / workarounds |
| [docs/API.md](docs/API.md) | Every HTTP endpoint |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Dev setup, adding routes / commands / panels |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common errors + verified fixes |
| [CHANGELOG.md](CHANGELOG.md) | Release history |
| [SECURITY-NOTES](plugins/Wzdhehe/Mcode-webui/references/SECURITY-NOTES.md) | Canonical security disclosure |

## Plugin packaging

`plugins/Wzdhehe/Mcode-webui/` holds the Agent Plugins 1.0 packaging
(skills layout, security notes, validator) — submitted to the
[community registry](https://github.com/MiniMax-AI/MiniMax-Code-Plugins).

```bash
npm run validate-plugin   # contract checks (mirrors the registry gate)
npm run package:plugin    # dist/Wzdhehe/Mcode-webui/ + .zip
```

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). `npm test` (302 tests) and
`npm run lint` must stay green; plugin-tree copies sync from root.

## License

MIT — see [LICENSE](plugins/Wzdhehe/Mcode-webui/LICENSE).
