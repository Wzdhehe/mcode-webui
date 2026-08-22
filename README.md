# mcode WebUI

> HTTP/SSE + browser frontend for the `mcode` CLI. Streams agent sessions, real
> tool calls, plan mode, ask-user prompts, and token usage to a Kimi-Code-style
> web UI. Zero npm dependencies. Runs on Node 22+.

```
[Browser :7890]  ←─  SSE  /api/events  ←─  [Node server.js]  ←─  mcode acp / exec subprocess
       ▲                                  │
       └───  REST  /api/*  ──────────────┘
```

## What this is

A standalone web client for the mcode agent runtime. It is not a wrapper around
mcode TUI; it speaks mcode's own JSON-RPC / stream-json output formats
directly. Two backend transports are supported:

| Transport | When used | Reference |
|---|---|---|
| `mcode acp` (JSON-RPC over stdio) | default since v0.5.by; multi-turn, real-time tool events | `server/lib/mcode-acp.js` |
| `mcode exec --output-format stream-json` | legacy single-turn fallback (1.5.0 < client) | `server/lib/mcode-exec.js` |

## Capabilities at a glance

✅ **Works**:
- Multi-turn chat with streaming assistant responses (delta + tool calls)
- Tool execution events (Bash, Read, Write, Edit, Glob, Grep, WebFetch, …)
- Permission prompts (auto / ask / full / plan)
- Plan-mode plan review with options
- `ask_user` tool with modal question UI
- Slash command autocomplete (`/help`, `/compact`, `/model`, …)
- File attachments (drag/drop, paste, click) — paths injected as `@file`
- Workspace switching with directory-tree browser (Windows drive roots, Linux `/`)
- Session persistence: webui-side JSON store + cross-deletes into mcode sqlite
- Real-time context window: % used, cache hit rate, tok/s
- Quota usage: `mmx quota show` parsed + per-turn `mavis` runtime db
- Bilingual UI: zh-CN / en (single key, no pluralization)
- LAN sharing with runtime on/off toggle (403 + friendly page when off)
- Token auth (`?token=...` query or `Authorization: Bearer ...`)
- Mobile responsive: < 900 px drawer, < 600 px single column
- Per-cid SSE channel (one client disconnect ≠ all lose state)

❌ **Does NOT work** (see `docs/CAPABILITIES.md` for full matrix):
- Mid-session provider switch via the UI — `mcode acp` does not implement `session/set_mode` / `set_config_option` (returns "Method not found"). Workaround: server-side graceful failure surfaces as a toast.
- True mid-conversation cancellation with rollback — `session/cancel` is best-effort; in-flight tool runs may still finish and emit a few extra events. The webui filters out anything arriving after `cancel` ack.
- Resuming a session that the mcode TUI has already opened elsewhere — the acp session has a single stdin owner; the webui falls back to a read-only view with banner.
- Voice / TTS, image generation, web-search-as-a-tool — these are mcode features; if mcode itself doesn't expose them through acp, the webui can't either.
- Per-message `permissionDecision` for individual tool calls — the webui only sets the session-level mode (`ask` / `auto` / `full`); per-tool prompts are forwarded to the in-process modal.

## Quickstart

```powershell
# 1. Install (zero deps)
cd C:\Users\mjc39\.minimax-code\webui
node server.js            # binds 0.0.0.0:7890 by default

# 2. Open
#    http://127.0.0.1:7890/                   (local)
#    http://192.168.31.95:7890/               (LAN — toggle "局域网访问" in sidebar)
```

Override defaults via env:
```powershell
$env:PORT = 8080
$env:HOST = '127.0.0.1'                      # loopback only
$env:TOKEN = 's3cret'                        # require this in URL or Authorization header
$env:MCODE_MODEL = 'minimax_api/MiniMax-M3'  # default model
$env:MCODE_WEBUI_UPLOAD_DIR = 'D:\uploads'  # attachment target
node server.js
```

## Documentation map

| Doc | What it covers |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module topology, request lifecycle, SSE payload schema, data ownership, why each file exists. |
| [docs/CAPABILITIES.md](docs/CAPABILITIES.md) | Capability matrix: what works, what doesn't, what the workaround is, what mcode would need to add to make it work. |
| [docs/API.md](docs/API.md) | Every HTTP endpoint: method, path, request body, response, error cases. |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Dev setup, code structure, how to add a route / a slash command / a UI panel. |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common errors with stack traces and verified fixes. |
| [SKILL.md](SKILL.md) | Plugin-format description (frontmatter + body) for mavis / minimax plugin packaging. |
| [docs/acp-goal-plan-status.md](docs/acp-goal-plan-status.md) | Historical notes on acp protocol coverage (kept for archaeology). |

## Repository layout

```
webui/
├── server.js                  # bootstrap: error handlers + http.createServer
├── server/
│   ├── router.js              # URL pattern → handler dispatch + LAN guard
│   ├── lib/                   # pure modules, one concern each
│   │   ├── config.js          # constants, env loading, uncaughtException sink
│   │   ├── lan.js             # isLocalRequest, detectLanIp
│   │   ├── models.js          # builtin model extraction from mcode/cli.js
│   │   ├── db.js              # better-sqlite3 lazy require (avoids load when unused)
│   │   ├── sessions.js        # webui-side JSON session store
│   │   ├── acp-client.js      # JSON-RPC over stdio, singleton + command cache
│   │   ├── state-bus.js       # per-cid state, SSE channel, active-child map
│   │   ├── mcode-exec.js      # exec transport (legacy single-turn)
│   │   ├── mcode-acp.js       # acp transport (default multi-turn)
│   │   ├── mcode-rpc.js       # UNSUPPORTED whitelist + graceful callRpc wrapper
│   │   ├── mavis-usage.js     # per-turn context usage from mavis sqlite
│   │   ├── usage.js           # mmx quota wrapper
│   │   ├── settings.js        # LAN broadcast runtime toggle
│   │   ├── upload.js          # multipart parser
│   │   ├── workspace.js       # workspace state + dir tree browsing
│   │   ├── slash.js           # /command handlers (webui-level)
│   │   └── static.js          # serveStatic, serveIndex
│   ├── routes/                # one file per URL family
│   │   ├── health.js, state.js, sessions.js, chat.js, usage.js,
│   │   ├── workspace.js, settings.js, upload.js, model.js,
│   │   ├── protocol.js, debug.js
│   └── cleanup.js             # startup hooks (env probe, log redirect)
├── public/
│   ├── index.html             # markup only, no inline style/script
│   ├── app/main.js            # ES module, ~4200 lines
│   ├── styles/main.css        # external stylesheet
│   ├── lib/marked.min.js      # markdown renderer
│   └── brand-logo.png
├── docs/                      # this documentation set
├── .minimax-plugin/           # mavis plugin manifest (plugin.json, SKILL.md)
├── package.json               # zero deps, `npm start` / `npm run dev`
└── SKILL.md                   # mavis skill description (frontmatter)
```

## Why mcode exec AND acp, not just one

`mcode exec` was the only documented non-interactive path when this project
started. It is still simpler (no JSON-RPC, no handshake) and is used as a
fallback when:
- mcode version < 0.1.4 (acp not available)
- the user explicitly opts in with the `/exec` slash command
- the acp subprocess keeps crashing and we want a degraded mode

`mcode acp` is the official Agent Client Protocol server. It is the right
choice for multi-turn sessions because the subprocess keeps state between
turns. The webui uses it as the default transport since v0.5.by.

Both transports share a single normalized event shape on the SSE channel,
so the UI is unaware of which transport is active. See
[docs/ARCHITECTURE.md § SSE event schema](docs/ARCHITECTURE.md) for details.

## Known limitations (mcode 0.1.5 acp)

These were reported upstream to the mcode team in 2026-08 with the
understanding that they will be addressed in a later release:

- `session/set_mode` — returns "Method not found"
- `session/set_config_option` — returns "Method not found"
- `session/cancel` — returns "Method not found"
- `session/activate`, `session/fork`, `session/resume`, `session/delete`,
  `session/request_permission`, `session/subscribe` — same

The webui's `mcode-rpc.js` whitelists these and returns
`{ok:false, code:'unsupported'}` so the UI can degrade gracefully
(toast + fallback path) instead of throwing.

## License

Internal project. Not published.
