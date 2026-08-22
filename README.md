# mcode WebUI

A thin HTTP/SSE wrapper around `mcode exec --output-format stream-json`. Streams a
mcode session to the browser so you can chat with the agent from a web page
instead of the TUI.

## Architecture

```
[Browser :7890/public/index.html]
        │  fetch POST /api/chat {prompt, workspace?, model?}
        │  EventSource / SSE  ←────────────┐
        ▼                                  │
[Node server.js]                           │
   • reads JSON body                       │
   • spawns `cmd.exe /c mcode.cmd exec …`  │
   • reads stdout line-by-line (UTF-8)     │
   • wraps each JSON line as SSE event ────┘
```

## Why this path and not `mcode acp`

`mcode acp` is the official Agent Client Protocol stdio server. We started there
(see `../acp-probe/acp-handshake.mjs`) but hit a dead-end: `acp` defaults to the
`minimax-legacy/MiniMax-M3` model on the `custom_provider` route, which is
**not available for the `cn-prod` preset**. The protocol itself does not expose
a way to override the provider/model, so we cannot use `acp` without changing
the host machine's default provider.

`mcode exec` is the documented "non-interactive one-shot" path. Its
`--output-format stream-json` mode emits line-delimited JSON events
(`delta` for streaming, `message` for the full message + usage, `exec.result`
for the final status). It accepts `--model <provider/model>` to override per
run, so we can pin to the same `minimax_api/MiniMax-M3` the TUI uses.

## Verified mcode exec command template

```powershell
cmd.exe /c mcode.cmd exec `
  --input -                  # read prompt from stdin
  --input-format text
  --cwd <workspace>          # any folder mcode can write to
  --permission full          # MUST: ask/smart deadlock without TTY
  --timeout 120s
  --output-format stream-json
  --max-steps 6
  --model minimax_api/MiniMax-M3   # MUST: default route is unavailable
```

## Known pitfalls (verified, with fixes in `server.js`)

| # | Problem | Fix |
|---|---|---|
| 1 | Default `--permission` is `ask`/`smart`. Without a TTY (subprocess), agent immediately returns `PERMISSION_REQUIRED`. | Always pass `--permission full`. |
| 2 | Default model `custom_provider:minimax-legacy/MiniMax-M3` is not available for the `cn-prod` preset. | Pass `--model minimax_api/MiniMax-M3` (the only `active` provider per `mcode provider list`). |
| 3 | On Windows, default subprocess encoding is GBK; mcode outputs UTF-8 → garbled SSE events. | `cmd.exe /c mcode.cmd …` via Node's `spawn` works because Node defaults to UTF-8, but if we ever switch to Python, must pass `encoding='utf-8', errors='replace'`. |
| 4 | Each `mcode exec` is a fresh subprocess — no shared session history across requests. | Acceptable for now. Multi-turn conversation requires a different design. |

## Project layout

```
webui/
├── README.md             this file
├── package.json          zero deps
├── .gitignore
├── docs/
│   ├── ARCHITECTURE.md   module topology + SSE payload schema + API surface
│   └── acp-goal-plan-status.md
├── server.js             bootstrap only (55 lines)
├── acp.mjs               mcode acp JSON-RPC client (unchanged)
├── server/               ← all backend logic lives here
│   ├── router.js         URL → handler dispatcher + LAN reject
│   ├── cleanup.js        startup hooks
│   ├── lib/              pure modules, one per concern
│   │   ├── config.js     constants + global error handlers
│   │   ├── lan.js        detectLanIp + isLocalRequest
│   │   ├── models.js     builtin model extraction from mcode/cli.js
│   │   ├── db.js         better-sqlite3 lazy require + mcode session delete
│   │   ├── sessions.js   JSON file persistence + chat helpers
│   │   ├── acp-client.js McodeAcpClient singleton + command/session cache
│   │   ├── state-bus.js  per-cid state + SSE channel + active-child tracker
│   │   ├── mcode-exec.js spawn mcode exec subprocess + stream-json parser
│   │   ├── mcode-acp.js  spawn mcode acp + stream events
│   │   ├── mavis-usage.js real token usage from mavis sqlite db
│   │   ├── usage.js      mmx quota wrapper + runUsageQuery
│   │   ├── settings.js   LAN broadcast runtime toggle
│   │   ├── upload.js     multipart parser
│   │   ├── workspace.js  workspace state + directory browsing
│   │   ├── slash.js      webui-level slash command handlers
│   │   └── static.js     serveStatic + serveIndex
│   └── routes/           one file per URL family
│       ├── health.js     GET /api/health
│       ├── state.js      GET /api/state + GET /api/events (SSE)
│       ├── sessions.js   /api/sessions/* + /api/acp-*
│       ├── chat.js       POST /api/send + /api/stop + /api/cmd
│       ├── usage.js      /api/usage + /api/usage-real + /api/refresh
│       ├── workspace.js  POST /api/workspace + /api/workspace/browse
│       ├── settings.js   GET/POST /api/settings
│       ├── upload.js     POST /api/upload
│       ├── model.js      /api/models + /api/set-model + /api/permissions
│       └── debug.js      /api/debug/inject + /api/debug/state (DEBUG_INJECT gated)
└── public/
    ├── index.html        markup only (527 lines, no inline style/script)
    ├── app/
    │   └── main.js       ES module (4294 lines)
    ├── styles/
    │   └── main.css      full stylesheet (2774 lines)
    ├── lib/
    │   └── marked.min.js markdown lib
    └── brand-logo.png
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for module contracts,
SSE event payload schema, and the full HTTP API surface.

## Modularization history

| Date | Commit | Summary |
|---|---|---|
| 2026-08-20 | `97c499a` | Stage 1: split `server.js` (2456 → 55 lines) into `server/lib/*` + `server/routes/*` + `server/router.js` |
| 2026-08-20 | `6dfe014` | Stage 1 review fix: encapsulate `sseByCid` access via `state-bus` helpers |
| 2026-08-20 | `5114218` | Stage 2: extract inline `<script>` to `public/app/main.js` as ES module |
| 2026-08-20 | `5a0e364` | Stage 2 review fix: add `?v=2` cache-bust to `/app/main.js` script tag |
| 2026-08-20 | `44ed608` | Stage 3: extract inline `<style>` to `public/styles/main.css` |

Rollback anchor: `4a279be` (pre-modularization snapshot of monolithic webui).