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
├── README.md         this file
├── package.json      zero deps
├── .gitignore
├── server.js         Node HTTP server (port 7890)
├── public/
│   └── index.html    chat UI (Kimi-style, single page)
└── probes/           (gitignored) ad-hoc verification scripts
```