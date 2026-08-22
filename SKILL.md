---
name: mcode-webui
displayName: mcode Web UI
version: 0.5.bx
description: Browser-based chat frontend for the mcode agent runtime. Streams mcode acp / exec sessions to a Kimi-Code-style web UI with real-time tool events, plan review, ask-user prompts, context usage, and quota. Zero npm dependencies; runs on Node 22+.
author: Ponkan
icon: 🌐
category: developer-tools
tags:
  - mcode
  - webui
  - acp
  - chat
  - sse
  - zero-deps
mcp:
  - name: mcode-webui
    type: http
    entry: server.js
    port: 7890
    health: /api/health
capabilities:
  - chat-streaming
  - tool-execution
  - plan-mode
  - ask-user-tool
  - permission-prompts
  - workspace-switching
  - session-management
  - file-attachments
  - quota-usage
  - bilingual-ui
  - lan-sharing
  - token-auth
  - mobile-responsive
runtime:
  minNodeVersion: "22.19"
  maxNodeVersion: "26"
  zeroDeps: true
  platforms: [windows, linux, macos]
exampleQueries:
  - open mcode webui
  - start the mcode webui
  - launch mcode browser
  - mcode webui status
  - show mcode webui url
---

# mcode Web UI

A Kimi-Code-style browser frontend for the `mcode` agent runtime.
Speaks mcode's two native transports (acp JSON-RPC, exec stream-json)
and renders everything as a single SPA. Designed to be the only UI
you need to drive a mcode session from a browser.

## When to use this

The mcode Web UI is the right frontend when:

- You want a real browser, not a TUI. Phones, tablets, multiple
  monitors, sharing a session via LAN.
- You need a persistent session log with search, not just the
  current turn.
- You want to attach files (drag, drop, paste) and have them
  injected as `@path` references automatically.
- You're building tooling that consumes mcode via the same acp
  protocol and want a known-good reference client.

The mcode Web UI is **not** the right frontend when:

- You only need non-interactive single-shot prompts — `mcode exec`
  on the CLI is faster and leaves no UI state.
- You need a fully offline client — the webui is HTTP, not local
  binary.
- You need to script mcode from another language — use the
  python / go acp SDKs directly, not the webui.

## How to start

```bash
# 1. install (zero npm deps, no build step)
cd C:\Users\mjc39\.minimax-code\webui
node server.js

# 2. open
#    http://127.0.0.1:7890/                 local
#    http://<lan-ip>:7890/                  LAN (toggle "局域网访问" in sidebar)
```

Optional env:
```bash
PORT=8080            # default 7890
HOST=127.0.0.1       # default 0.0.0.0
TOKEN=s3cret         # require this in ?token= or Authorization: Bearer
MCODE_MODEL=...      # default model override
DEBUG_INJECT=1       # enable /api/debug/* (testing only)
```

## What it does

| | |
|---|---|
| ✅ | Multi-turn chat with streaming deltas and tool events |
| ✅ | Plan mode with structured review modal |
| ✅ | Ask-user tool with modal question UI (single + multi-select) |
| ✅ | Permission prompts (ask / auto / full) |
| ✅ | Slash-command autocomplete (`/help`, `/compact`, `/model`, …) |
| ✅ | File attachments (drag, drop, paste) → `@path` injection |
| ✅ | Workspace switching with directory-tree browser |
| ✅ | Session persistence (webui JSON + mcode sqlite) |
| ✅ | Real-time context window, cache hit, tok/s |
| ✅ | `mmx quota show` parsed + per-turn `mavis` runtime db |
| ✅ | Bilingual UI (zh-CN / en) |
| ✅ | LAN sharing with runtime on/off toggle |
| ✅ | Token auth (`?token=` or `Authorization: Bearer`) |
| ✅ | Mobile responsive |
| ⚠ | Mid-session mode switch (mcode 0.1.5 acp doesn't support `set_mode` — shows toast) |
| ⚠ | Mid-flight cancel (mcode 0.1.5 acp doesn't support `cancel` — falls back to SIGTERM) |
| ❌ | Rewind / regenerate / edit-and-resend (no acp method) |
| ❌ | HTTPS (use a reverse proxy) |

See [docs/CAPABILITIES.md](docs/CAPABILITIES.md) for the full matrix.

## Architecture in one diagram

```
[Browser :7890]  ←── SSE /api/events  ←──  [Node server.js]  ←──  mcode acp / exec subprocess
       ▲                                  │
       └───── REST /api/*  ───────────────┘
```

Single Node process, single HTML file, single ES module for the
frontend. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the
full topology, module contracts, and SSE event schema.

## Plugin integration

This skill installs the webui as a mavis / minimax plugin:

1. Copy the repo to `<mavis-data-dir>/plugins/mcode-webui/`
2. Add the plugin to the mavis plugin loader
3. The plugin provides a `mcode-webui` MCP entry that auto-starts
   the server and exposes the URL

Configuration knobs (all via env or `plugin.json`):
- `PORT` — webui port (default 7890)
- `HOST` — bind address (default 0.0.0.0)
- `TOKEN` — required token for non-local requests
- `MCODE_CMD` — path to `mcode.cmd` / `mcode` (auto-detected)
- `MCODE_MODEL` — default model (default `minimax_api/MiniMax-M3`)
- `MCODE_WEBUI_UPLOAD_DIR` — attachment target dir

## Known issues with mcode 0.1.5 acp

These are upstream limitations, not webui bugs. Reported to the
mcode team in 2026-08; expected to be addressed in a later release:

- `session/set_mode` — "Method not found"
- `session/set_config_option` — "Method not found"
- `session/cancel` — "Method not found" (webui falls back to SIGTERM)
- `session/activate`, `session/fork`, `session/resume`, `session/delete`,
  `session/request_permission`, `session/subscribe` — same

The webui's `mcode-rpc.js` whitelists these methods and returns
`{ok:false, code:'unsupported'}` so the UI can degrade gracefully
instead of throwing.

## Documentation

| Doc | Purpose |
|---|---|
| [README.md](README.md) | Project overview, quickstart, capability summary |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module topology, request lifecycle, SSE schema, why each file exists |
| [docs/CAPABILITIES.md](docs/CAPABILITIES.md) | What works / what doesn't / workarounds, per-feature status matrix |
| [docs/API.md](docs/API.md) | Every HTTP endpoint: method, path, request, response, errors |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Dev setup, code structure, how to add routes / events / panels / slash commands |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common errors with stack traces and verified fixes |
| [docs/acp-goal-plan-status.md](docs/acp-goal-plan-status.md) | Historical acp coverage notes (archaeology) |

## License

Internal project. Not published.
