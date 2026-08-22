# webui Architecture

> Companion document to [README.md](../README.md). Describes the
> modularized structure introduced in 2026-08 (Stage 0–4) — what each
> file is responsible for, how they wire up, and the contract between
> backend and frontend.

## High level

```
[Browser :7890/]
    │  GET /                                → public/index.html (527 lines, mostly markup)
    │  GET /styles/main.css?v=2             → external CSS file (2774 lines)
    │  GET /app/main.js?v=2                 → ES module (4294 lines)
    │  GET /lib/marked.min.js               → markdown library
    │  GET /brand-logo.png                  → branding asset
    │  fetch POST /api/send {content, ...}  → spawn mcode exec, push chat lines
    │  fetch POST /api/upload               → save attachment, return @path
    │  EventSource / SSE  ←─────────────────────┐
    ▼                                            │
[Node server.js (55 lines)]                       │
   │  http.createServer(handleRequest)           │
   │  delegates to server/router.js               │
   ▼                                            │
[server/router.js — URL → handler dispatch]      │
   │  ┌─────────────┬──────────────┐             │
   ▼  ▼             ▼              ▼             │
[server/lib/* — pure modules]                    │
   │  config / lan / models / db / sessions      │
   │  / acp-client / state-bus / mcode-exec      │
   │  / mcode-acp / mavis-usage / usage / settings│
   │  / upload / workspace / slash / static      │
   ▼                                             │
[server/routes/* — one file per URL family]      │
   /api/send   /api/events   /api/state          │
   /api/sessions/*  /api/upload  /api/settings    │
   /api/usage  /api/workspace  /api/models       │
   /api/health  /api/debug/{inject,state}        │
   └──────────── pushStateFor ──────────┬────────┘
                                          │
[activeChildByCid (mcode subprocess / acp client)] │
                                          │
   (mcode.exec / mcode acp subprocess spawns)──┘
```

## Backend topology

`server.js` is the bootstrap only — installs global error handlers,
checks preflight (`mcode.cmd` exists, `upload/` writable), starts a
`setInterval` for cleanup, then `http.createServer(handleRequest)` and
`listen`. All routing and logic live in `server/`.

### `server/lib/` — pure modules

Each lib file owns one concern and exports named functions. No HTTP, no
side effects beyond what's documented.

| File | Responsibility | Key exports |
|---|---|---|
| `config.js` | Constants (PORT, MCODE_ROOT, MCODE_CMD, paths, defaults). Reads `process.env.*` once. Also installs `uncaughtException` / `unhandledRejection` handlers and writes to `.server.err`. | `PORT`, `HOST`, `MCODE_ROOT`, `MCODE_CMD`, `DEFAULT_MODEL`, `DEFAULT_WORKSPACE`, `DEFAULT_TIMEOUT`, `MCODE_RUNTIME_DB`, `MAVIS_DB_PATH`, `installGlobalErrorHandlers()`, `detectTuiCwd()` |
| `lan.js` | LAN IP detection + local request check. | `detectLanIp()`, `LAN_IP`, `isLocalRequest(req)` |
| `models.js` | Extract builtin model list from `mcode/cli.js` bundle (no hardcoded list). Cache lookup for model context limits. | `getBuiltinModelsFromMcode()`, `getMcodeModelLimit(name)` |
| `db.js` | Lazy require mcode's `better-sqlite3`. Delete a mcode session row + all related FTS5/lock/projection tables in one transaction. | `getMcodeBetterSqlite3()`, `deleteMcodeSessionFromDb(sid)`, `MCODE_SESSION_DELETE_TABLES` |
| `sessions.js` | JSON file persistence for webui sessions (`~/.webui-sessions.json`). Also exports chat-line helpers `resetContext`, `persistCurrentChat`, `streamUpdateLine`, and the startup `cleanupEmptyDefaultSessions`. | `loadSessions()`, `saveSessions(s)`, `resetContext(cs)`, `persistCurrentChat(cs)`, `streamUpdateLine(chat, prefix, text)`, `cleanupEmptyDefaultSessions()` |
| `acp-client.js` | Wraps `acp.mjs` with singleton lifecycle + caches for sessions and commands. The `McodeAcpClient` from `acp.mjs` is the JSON-RPC transport; this lib adds reuse, retry, and shutdown hooks. | `getMcodeAcpClient()`, `shutdownMcodeAcpSingleton()`, `getMcodeSessionsForWorkspace(ws)`, `listAllMcodeSessions()`, `getMcodeSessionTitle(sid)`, `invalidateMcodeSessionsCache()`, `ensureMcodeCommands()`, `getCachedMcodeCommands()`, `WEBUI_LOCAL_COMMANDS` |
| `state-bus.js` | Per-cid state (`clients` Map), SSE channel registry (`sseByCid` Map), and the active-child tracker (`activeChildByCid` Map). All mutation goes through this module; routes never touch the Maps directly. | `clients`, `sseByCid`, `activeChildByCid`, `makeClientState()`, `getClient(cid)`, `getCidFromReq(req)`, `pushStateFor(cid, opts)`, `pushOnlineCount(lanBroadcast)`, `setActiveChild(cid, child)`, `getActiveChild(cid)`, `clearActiveChild(cid)`, `setSseClient(cid, res)`, `getSseClient(cid)`, `endSseClient(cid, res)`, `SSE_HEADERS` |
| `mcode-exec.js` | Spawns `cmd.exe /c mcode.cmd exec --input - --output-format stream-json`, parses line-delimited JSON, drives stream markers into `cs.chat`. | `runMcodeExec(prompt, opts)`, `collectExecResult(childPromise)` |
| `mcode-acp.js` | Spawns `mcode acp` via `McodeAcpClient`, streams `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_update` / `plan_update` / `goal_update` events into `cs.chat`. After completion, fires a 400ms delayed mavis db query to replace estimated token counts with real values. | `runMcodeAcp(content, opts)` (internal `streamAcpPrompt`) |
| `mavis-usage.js` | Reads `~/.minimax/v2/sqlite/runtime-state.sqlite` via `sqlite3.exe` CLI (zero native deps). Returns per-turn cache hit rate + cumulative input/output/cache_read/cache_write. | `getMavisTokenUsage(mvsSessionId)`, `getMavisTokenUsageModel(mvsSessionId)`, `applyMavisUsageToCs(cs, mvsSessionId, opts)` |
| `usage.js` | Wraps `mmx quota show --output json` (no AI involved). Per-cid usage state. | `mmxQuotaShow()`, `runUsageQuery(cs, cid)` |
| `settings.js` | Runtime toggle for LAN broadcast. Reject page + JSON response when off and request is non-local. `/api/settings` is exempt (so users can re-enable LAN from a phone). | `getLanBroadcast()`, `setLanBroadcast(v)`, `rejectLan(res, pathname, remoteIp)`, `getSettingsSnapshot()` |
| `upload.js` | Zero-dep multipart/form-data parser. Saves uploaded file with a `<timestamp>-<md5-6>.<ext>` filename into `UPLOAD_DIR`. | `saveMultipartUpload(req)` |
| `workspace.js` | Per-cid workspace state mutation (set / useTui / reset / detect actions) + directory browsing (with Windows drive-letter enumeration when no path given). | `handleWorkspaceChange(cs, cid, payload)`, `browseWorkspace(rawPath)` |
| `slash.js` | Webui-level slash command handlers (`/goal`, `/goal-done`, `/goal-blocked`, `/clear`, `/new`, `/status`, `/usage`, `/help`) that don't need a mcode exec. Returns `{handled, continueMcode, rewriteContent}` for the route layer to decide. | `matchSlash(content)`, `handleLocalSlash(content, cs, cid)`, `handleCmdCommand(cmd, cs, cid)` |
| `static.js` | Static asset serving. MIME map for js/css/json/png/svg/ico/jpg/jpeg/gif/webp. Cache-Control: public, max-age=3600 on all responses. | `serveStatic(pathname, res)`, `serveIndex(res)`, `PUBLIC_DIR` |

### `server/routes/` — URL → handler

Each route file exports `handle*` functions. The router matches on
method + pathname prefix. Body parsing helpers are duplicated
(`readJson`) where needed; this is intentional — no shared request
parsing util to keep contracts local.

| File | Routes |
|---|---|
| `health.js` | `GET /api/health` |
| `state.js` | `GET /api/state`, `GET /api/events` (SSE) |
| `sessions.js` | `GET/POST /api/sessions`, `POST /api/sessions/switch`, `DELETE /api/sessions/:id`, `POST /api/sessions/cleanup-orphans`, `GET /api/acp-sessions`, `GET /api/acp-session-title` |
| `chat.js` | `POST /api/send`, `POST /api/stop`, `POST /api/cmd` |
| `usage.js` | `POST /api/usage`, `POST /api/usage-trigger`, `GET /api/usage-real`, `POST /api/refresh` |
| `workspace.js` | `POST /api/workspace`, `GET /api/workspace/browse` |
| `settings.js` | `GET/POST /api/settings` |
| `upload.js` | `POST /api/upload` |
| `model.js` | `GET /api/models`, `POST /api/set-model`, `POST /api/permissions`, `POST /api/answer` (legacy no-op) |
| `debug.js` | `POST /api/debug/inject`, `GET /api/debug/state` (gated by `DEBUG_INJECT=1`) |

### `server/router.js`

URL → handler dispatcher. Order of checks:

1. CORS headers (all paths).
2. LAN reject (skipped if request is local OR `/api/settings`).
3. Static files (`serveStatic` for any path with a `.` — handles
   `/lib/marked.min.js`, `/brand-logo.png`, `/app/main.js`, etc.).
4. `ROUTES` table — first match wins.

Errors are caught per route and return 500 JSON. The router also
enforces the SSE channel ownership boundary: routes call `setSseClient`
/ `endSseClient` rather than touching `sseByCid` directly.

### `server/cleanup.js`

Background timer hooks:
- `runStartupCleanup()` — runs `cleanupEmptyDefaultSessions()` on boot.
- `setTimeout(ensureMcodeCommands, 5000)` — warms the mcode command
  cache 5s after startup so `/help` responds instantly later.

## Frontend topology

```
[public/index.html]
   <link rel="stylesheet" href="/styles/main.css?v=2">
   <script src="/lib/marked.min.js"></script>
   <script type="module" src="/app/main.js?v=2"></script>
   <body>
     <div class="app"> ... full Kimi-style markup ... </div>
   </body>
```

`public/index.html` is 527 lines: pure markup + the three link/script
tags. No inline `<style>`, no inline `<script>`. The `data-i18n` /
`data-i18n-placeholder` / `data-i18n-title` attributes on every user-
visible string are populated by `applyI18n()` in main.js.

`public/app/main.js` is 4294 lines: one ES module containing all
frontend code. Top-level `let`/`const`/`function` declarations live in
module scope (not exposed to `window` — that's correct ES module
behavior, not a regression). The `?v=2` cache-bust query is bumped on
every deploy that changes the file.

`public/styles/main.css` is 2774 lines: all CSS variables, reset, and
component styles. Verified byte-for-byte against the pre-Stage-3 inline
`<style>` block.

## Backend ↔ Frontend contract

### SSE event payload

Every SSE event from `/api/events` carries a `data: <json>\n\n` line
where `<json>` is a snapshot of the entire per-cid state:

```jsonc
{
  "version": "0.1.3",
  "workspace": { "dir": "...", "branch": null, "tree": null },
  "model": { "name": "minimax_api/MiniMax-M3", "thinking": "On", "ctx": "512k" },
  "sessionId": "...uuid...",        // webui randomUUID
  "mcodeSessionId": "mvs_...",        // mcode's own session id (mvs_xxx)
  "sessionTitle": "...",
  "context": {
    "tokens": 0, "used": 0, "percent": 0, "limit": 512000,
    "tps": 0, "thinkingStatus": "Idle",
    "estimated": false, "usageSource": "mavis-db" | "mcode-rusage" | "estimate"
  },
  "usage": {
    "plan": null, "expires": null, "credits": null,
    "fiveHourPercent": 78, "weekly": "100%",
    "sessionInput": 42305, "sessionOutput": 139, "sessionTotal": 42444,
    "sessionCacheRead": 220000, "sessionCacheWrite": 0,
    "sessionReasoning": 0, "sessionCacheHitRate": 0.84,
    "mavisModel": "MiniMax-M3",
    "fetchedAt": 1787211441394,
    "raw": "{...mmx json...}",
    "error": null
  },
  "permissions": "Full access",
  "chat": ["› user prompt", "● assistant response", "▲ thinking", "→ tool", ...],
  "sessions": [...webui session entries...],
  "mcodeSessions": [...filtered mcode acp session entries...],
  "availableCommands": { "mcode": [...], "webui": [...], "fetchedAt": ..., "source": "..." },
  "goal": { "active": false, "text": null, "status": null, "duration": null },
  "todo": [],
  "ask": { "active": false, "total": 0, "answered": 0, "currentIdx": 0, "question": "", "options": [] },
  "plan": { "active": false, "title": null, "summary": "", "options": [] },
  "running": { "active": false, "prompt": null, "pid": null, "startedAt": null, "model": null, "sessionId": null, "lastDeltaAt": null, "tps": 0 },
  "onlineCount": 1,
  "lanBroadcast": true
}
```

The frontend preserves `state.askUserAnswers` across SSE pushes (it's
client-only state, never sent to the server).

### HTTP API surface

| Verb | URL | Purpose |
|---|---|---|
| GET | `/` | HTML |
| GET | `/styles/main.css?v=N` | CSS |
| GET | `/app/main.js?v=N` | JS module |
| GET | `/lib/marked.min.js` | Markdown lib |
| GET | `/brand-logo.png` | Branding |
| GET | `/api/health` | Server status |
| GET | `/api/state` | Full state snapshot |
| GET | `/api/events` | SSE stream (per-cid, see cid query) |
| GET | `/api/sessions` | List webui sessions |
| POST | `/api/sessions` | Create webui session (`{workspace?}`) |
| POST | `/api/sessions/switch` | Switch active session (`{id}` — accepts webui uuid or `mvs_xxx`) |
| DELETE | `/api/sessions/:id` | Delete session (also deletes mcode session row if linked) |
| POST | `/api/sessions/cleanup-orphans` | Clean orphan mcode sessions (`?scope=orphans|all`) |
| GET | `/api/acp-sessions?cwd=...` | List mcode sessions for workspace |
| GET | `/api/acp-session-title?sessionId=...` | Title lookup |
| POST | `/api/send` | Submit prompt (`{content, isAskAnswer?}`) — fire-and-forget; output via SSE |
| POST | `/api/stop` | Kill current cid's mcode subprocess |
| POST | `/api/cmd` | Webui button command (`{cmd: '/new|/status|/clear|/sessions|/help|/usage|/stop'}`) |
| POST | `/api/upload` | Multipart file upload |
| GET | `/api/workspace/browse?path=...` | List directory subdirs |
| POST | `/api/workspace` | Set/reset/useTui workspace (`{action, dir?, syncTui?}`) |
| GET | `/api/usage` | (alias: `/api/usage-trigger`) Trigger mmx quota pull |
| GET | `/api/usage-real` | Raw mavis db usage dump |
| POST | `/api/refresh` | Push current state to client |
| GET | `/api/models` | Builtin model list |
| POST | `/api/set-model` | Set `cs.model.name` (`{model}`) |
| POST | `/api/permissions` | Set permission mode (`{mode: ask|auto|read|full}`) |
| POST | `/api/answer` | Legacy no-op for old ask/plan/perm modals |
| GET | `/api/settings` | Server settings snapshot |
| POST | `/api/settings` | Update settings (`{lanBroadcast?}`) |
| POST | `/api/debug/inject` | Mock state (DEBUG_INJECT=1 only) |
| GET | `/api/debug/state` | Inspect state (DEBUG_INJECT=1 only) |

All `/api/*` URLs take a `?cid=<uuid>` query (auto-generated by the
frontend, persisted in `localStorage.webui_cid`). Multiple webui tabs
each have their own cid → independent SSE channel + state.

## Per-cid state model

Each webui tab (cid) owns:
- `cs` — server-side state object (see SSE payload above)
- `sseByCid[cid]` — the SSE response stream for that tab
- `activeChildByCid[cid]` — the running mcode subprocess (exec child or
  acp client). `/api/stop` kills this; the SSE push after death
  contains `running.active = false`.

Mutations to `cs` always go through one of:
- `pushStateFor(cid, opts)` — write full snapshot to that cid's SSE
  channel
- `pushOnlineCount(lanBroadcast)` — broadcast to all channels
  (used by SSE open/close to keep `onlineCount` accurate)
- `pushStateFor('__broadcast__', opts)` — broadcast snapshot to all
  channels (used by `ensureMcodeCommands` after cache refresh)

Routes never mutate `clients` / `sseByCid` / `activeChildByCid`
directly — they call the helpers in `state-bus.js`.

## Known sharp edges

These are bugs/limitations preserved from the original monolithic
server.js. They are NOT introduced by Stage 1-4. Filing them for a
later cleanup stage.

1. **Duplicate `sendPlanAnswer` (resolved in Stage 2).** The original
   inline script had two `async function sendPlanAnswer(text)`
   declarations. Non-strict script mode let the second one (line 4108,
   `/api/answer` flow) silently overwrite the first (line 1850,
   `/api/send` flow). Stage 2 removed the dead first declaration. The
   inline plan-block flow still calls the modal version (which goes
   to `/api/answer` instead of `/api/send`) — this is the pre-existing
   behavior, preserved intentionally. Fixing the inline plan-block
   flow to call `/api/send` directly is a one-line change but changes
   user-visible behavior, deferred.

2. **LAN broadcast exempts `/api/settings`.** When `lanBroadcast =
   false` and the request is non-local, every `/api/*` returns 403
   JSON except `/api/settings` (which lets a phone-user toggle LAN back
   on). This is deliberate — the same endpoint is how the user
   re-enables LAN. Documented in `lib/settings.js`.

3. **`MCODE_USE_ACP=0` env to fall back to `mcode exec` from ACP.**
   Set on the server. Otherwise all `/api/send` calls use the mcode
   acp protocol (`mcode acp`). Both code paths exist; the acp path is
   the default since v0.5.ah.

4. **Auto-refresh ping.** The frontend `connect()` (in main.js) pings
   `/api/refresh` every 60s. Stage 1 refactored nothing here — this is
   to prevent the right panel from going stale ("—" / "Loading...")
   when no other SSE event has fired.

5. **Cache policy.** All static assets served with
   `Cache-Control: public, max-age=3600`. Bumping the `?v=N` query on
   `/app/main.js` and `/styles/main.css` is the only cache-bust
   mechanism. Stage 2 added `?v=2`; Stage 3 matched it on CSS. Future
   deploys that change either file must bump the version.

## Testing approach

Per-stage review by independent Explore agent:
- Stage 1 (backend): route coverage check + body/state/env regression
  scan + module-boundary contract verification.
- Stage 2 (frontend): verbatim diff check + ES module strict-mode
  trap scan + cache-bust verification.
- Stage 3 (CSS): verbatim diff + visual regression screenshot via
  Playwright.

End-to-end smoke test (manual, after every Stage):
1. `node server.js` (default port 7890)
2. Browser `http://127.0.0.1:7890/`
3. Send a prompt — confirm mcode acp stream + token counter + sidebar
4. Switch sessions — confirm SSE delivery + title rendering
5. Toggle LAN — confirm 403 from another IP

## Related documents

- [README.md](../README.md) — operational guide (start/stop, port,
  env vars, mcode exec command template)
- [acp-goal-plan-status.md](acp-goal-plan-status.md) — design doc for
  the goal/plan/ask_user modal flow