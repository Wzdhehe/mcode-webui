// mcode-webui HTTP/SSE server.
//
// Adapts to old webui.html (115KB) endpoints:
//   POST /api/send           {content, command}            → spawn mcode exec, push chat lines
//   POST /api/usage                                          → spawn mmx quota show, push state + chat
//   POST /api/refresh                                        → re-fetch status, push state
//   POST /api/usage-trigger                                  (alias of /api/usage)
//
//   GET  /api/state                                        → JSON snapshot of full state
//   GET  /api/events (SSE)                                 → EventSource stream of state updates
//   GET  /api/sessions    / POST /api/sessions              → SQLite-backed session list
//   POST /api/upload                                       → save attachment, return @path
//
//   GET  /api/health                                       → {ok, port, defaultModel, defaultWorkspace}
//   GET  /                                                  → public/index.html
//
// Run from inside the .minimax-code root so it finds the local mcode.cmd.
//   cd C:\Users\mjc39\.minimax-code\webui
//   node server.js

import http from 'node:http'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT) || 7890
const HOST = process.env.HOST || '127.0.0.1'
const MCODE_ROOT = resolve(__dirname, '..')
const MCODE_CMD = join(MCODE_ROOT, 'mcode.cmd')
const DEFAULT_MODEL = process.env.MCODE_MODEL || 'minimax_api/MiniMax-M3'
const DEFAULT_WORKSPACE = process.env.MCODE_WORKSPACE || MCODE_ROOT
const DEFAULT_TIMEOUT = process.env.MCODE_TIMEOUT || '120s'
const DEFAULT_MAX_STEPS = Number(process.env.MCODE_MAX_STEPS) || 6
const MAX_CONCURRENT = Number(process.env.MCODE_MAX_CONCURRENT) || 3
const UPLOAD_DIR = process.env.MCODE_WEBUI_UPLOAD_DIR || join(MCODE_ROOT, '.webui-uploads')
const SESSIONS_DB = process.env.MCODE_WEBUI_SESSIONS_DB || join(MCODE_ROOT, '.webui-sessions.json')

// v0.5.x: 把当前 state.chat 写回 db 里对应 session 的 chat 字段
// 切 session 时从这个字段加载历史（之前 db 只存 {id,title,createdAt}，导致切过去看不到聊天）
function persistCurrentChat() {
  if (!state.sessionId) return
  const all = loadSessions()
  const item = all.find((s) => s.id === state.sessionId)
  if (!item) return
  item.chat = state.chat || []
  item.updatedAt = Date.now()
  saveSessions(all)
}

// v0.5.x: 重置所有 context 字段（不只是 tokens/used；percent/spent/tps 之前漏了导致切完仍显示旧的 %）
function resetContext() {
  state.context.tokens = 0
  state.context.used = 0
  state.context.percent = 0
  state.context.spent = 0
  state.context.tps = 0
  state.context.thinkingDuration = null
  state.context.assistantLast = null
  state.context.assistantAt = null
  state.context.lastUsageAt = null
}

if (!existsSync(MCODE_CMD)) {
  console.error(`[fatal] mcode.cmd not found at ${MCODE_CMD}`)
  process.exit(1)
}
mkdirSync(UPLOAD_DIR, { recursive: true })

// ============================================================
// In-memory state
// ============================================================
const state = {
  version: '0.1.2',
  workspace: { dir: DEFAULT_WORKSPACE, branch: null, tree: null },
  model: { name: DEFAULT_MODEL, thinking: 'On', ctx: '512k' },
  sessionId: null,         // v0.5.x: webui 侧边栏 session id (randomUUID)，用来在 db 里查找并更新标题
  mcodeSessionId: null,    // v0.5.x: mcode exec 自己生成的 session id (mvs_xxx)，用作下次续接的 --session 参数
  sessionTitle: 'Untitled',
  context: {
    tokens: 0, used: 0, percent: 0, limit: 512000,
    tps: 0, thinkingStatus: 'Idle', thinkingDuration: null,
    lastUsageAt: null,
  },
  usage: {
    plan: null, expires: null, credits: null,
    fiveHourPercent: null, fiveHourReset: null, weekly: null,
    sessionInput: 0, sessionOutput: 0, sessionTotal: 0,
    raw: null,
  },
  permissions: 'Full access',
  chat: [],
  sessions: [],
  goal: { active: false, text: null, status: null, duration: null },
  todo: [],
  ask: { active: false, total: 0, answered: 0, currentIdx: 0, question: '', options: [] },
  plan: { active: false, title: null, summary: '', options: [] },
  // running state
  running: { active: false, prompt: null, pid: null, startedAt: null, model: null, sessionId: null, lastDeltaAt: null, tps: 0 },
}

// SSE clients
const sseClients = new Set()

function pushState() {
  // 注入 sessions 列表（来自磁盘 db）— 让 webui 侧边栏 "最近会话" 不被 SSE 推送覆盖
  const snapshot = { ...state, sessions: loadSessions() }
  const payload = JSON.stringify(snapshot)
  for (const res of sseClients) {
    try { res.write(`data: ${payload}\n\n`) } catch {}
  }
}

function updateState(partial) {
  // shallow merge for top-level keys
  for (const k of Object.keys(partial)) {
    if (partial[k] && typeof partial[k] === 'object' && !Array.isArray(partial[k])) {
      state[k] = { ...state[k], ...partial[k] }
    } else {
      state[k] = partial[k]
    }
  }
  pushState()
}

// Sessions store (file-backed JSON; minimal)
function loadSessions() {
  if (!existsSync(SESSIONS_DB)) return []
  try { return JSON.parse(readFileSync(SESSIONS_DB, 'utf8')) } catch { return [] }
}
function saveSessions(s) { writeFileSync(SESSIONS_DB, JSON.stringify(s, null, 2), 'utf8') }

const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf8')

// v0.5.x → v0.5.y: /usage 改成直接调 mmx CLI（mmx quota show --output json），
// 完全不走 mcode exec/AI，拿到的是 mmx API 返回的真实结构化数据。
// 提取成 helper 让 /api/send (/usage slash)、/api/usage、/api/cmd /usage 三处都走同一份逻辑。
// 结果以 assistant 消息（● 前缀）的形式进 chat，不再隐藏（之前是 LLM fabrication 所以隐藏）。

function mmxQuotaShow() {
  // mmx 在 Windows 上是 .ps1 shim，用 shell:true 让 cmd 自动解析
  return new Promise((resolve, reject) => {
    const child = spawn('mmx', ['quota', 'show', '--output', 'json', '--no-color', '--quiet'], {
      windowsHide: true,
      shell: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      reject(new Error('mmx quota show 超时（15s）'))
    }, 15000)
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString('utf8') })
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString('utf8') })
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(new Error(`mmx 启动失败：${e.message}（确认 mmx CLI 已安装并登录）`))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) {
        return reject(new Error(`mmx 退出码 ${code}：${(stderr || stdout).trim().slice(0, 200) || '无输出'}`))
      }
      try {
        resolve(JSON.parse(stdout))
      } catch (e) {
        reject(new Error(`mmx 返回非 JSON：${e.message}\nstdout: ${stdout.slice(0, 200)}`))
      }
    })
  })
}

function formatDuration(ms) {
  if (!ms || ms < 0) return '—'
  const totalSec = Math.floor(ms / 1000)
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const mins = Math.floor((totalSec % 3600) / 60)
  if (days > 0) return `${days}d ${hours}h 后重置`
  if (hours > 0) return `${hours}h ${mins}m 后重置`
  return `${mins}m 后重置`
}

function formatMmxQuota(data) {
  const arr = data?.model_remains
  if (!Array.isArray(arr) || arr.length === 0) return '  暂无数据'
  return arr.map((m) => {
    const intervalPct = m.current_interval_remaining_percent
    const weeklyPct = m.current_weekly_remaining_percent
    const intervalReset = formatDuration(m.remains_time)
    const weeklyReset = formatDuration(m.weekly_remains_time)
    const name = m.model_name || 'model'
    return `  ${name}\n    5 小时  ${intervalPct}% 剩余 · ${intervalReset}\n    周  ${weeklyPct}% 剩余 · ${weeklyReset}`
  }).join('\n')
}

async function runUsageQuery() {
  state.chat = [...(state.chat || []), '› /usage']
  pushState()
  // 加一个 loading 占位（系统消息 ○），等数据回来再替换
  state.chat = [...state.chat, '○ 套餐用量加载中…']
  pushState()
  persistCurrentChat()
  try {
    const data = await mmxQuotaShow()
    const formatted = formatMmxQuota(data)
    // 同步给 state.usage 留一份（兼容老 webui.html 里可能用到的字段）
    const general = data.model_remains?.find((m) => m.model_name === 'general') || data.model_remains?.[0]
    if (general) {
      state.usage.fiveHourPercent = general.current_interval_remaining_percent
      state.usage.fiveHourReset = formatDuration(general.remains_time)
      state.usage.weekly = `${general.current_weekly_remaining_percent}%`
      state.usage.weeklyReset = formatDuration(general.weekly_remains_time)
    }
    state.usage.raw = JSON.stringify(data, null, 2)
    state.usage.fetchedAt = Date.now()
    // 替换最后一条 loading 为真实数据
    const reply = `● 套餐用量：\n${formatted}`
    state.chat = state.chat.slice(0, -1).concat([reply])
  } catch (e) {
    const errText = `○ /usage 失败：${e.message}`
    state.chat = state.chat.slice(0, -1).concat([errText])
  }
  pushState()
  persistCurrentChat()
}

// v0.5.x: 启动时清理空 chat + 默认标题的 session（用户点了"新建会话"但没发消息的残留）
// 保留：有 chat 内容的；或标题是用户手打的中文/英文（不是 New session/Untitled/对话 N 这种默认名）
;(function cleanupEmptyDefaultSessions() {
  if (!existsSync(SESSIONS_DB)) return
  let all
  try { all = JSON.parse(readFileSync(SESSIONS_DB, 'utf8')) } catch { return }
  if (!Array.isArray(all) || all.length === 0) return
  const before = all.length
  all = all.filter((s) => {
    if (!s || !s.id) return false
    const hasChat = Array.isArray(s.chat) && s.chat.length > 0
    if (hasChat) return true  // 有消息就保留
    const t = (s.title || '').trim()
    // 真实标题（有中文/英文实质内容，非默认名）也保留
    const isDefault = t === 'New session' || t === 'Untitled' || /^对话 \d+$/.test(t)
    return !isDefault
  })
  if (all.length !== before) {
    saveSessions(all)
    console.log(`[webui] cleanup: removed ${before - all.length} empty/default sessions, ${all.length} kept`)
  }
})()

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}

function runMcodeExec(prompt, opts = {}) {
  const workspace = opts.workspace || DEFAULT_WORKSPACE
  const model = opts.model || DEFAULT_MODEL
  const timeout = opts.timeout || DEFAULT_TIMEOUT
  const maxSteps = opts.maxSteps || DEFAULT_MAX_STEPS
  const label = opts.label || 'prompt'
  // 续接已有 session（多轮对话上下文）— 由 collectExecResult 写回的 mcode exec.sessionId
  const sessionId = opts.sessionId || null

  const args = [
    '/c', MCODE_CMD, 'exec',
    '--input', '-',
    '--input-format', 'text',
    '--cwd', workspace,
    '--permission', 'full',
    '--timeout', timeout,
    '--output-format', 'stream-json',
    '--max-steps', String(maxSteps),
    '--model', model,
  ]
  if (sessionId) args.push('--session', sessionId)
  const child = spawn('cmd.exe', args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  child.stdin.write(prompt, 'utf8')
  child.stdin.end()
  return { child, args, label, model, workspace, sessionId }
}

function collectExecResult(childPromise) {
  // Wraps runMcodeExec and accumulates a result object
  return new Promise((resolve) => {
    const r = {
      answer: null, thinking: null, status: 'unknown', error: null,
      usage: null, sessionId: null, durationMs: null, tps: null,
    }
    let buf = ''
    let lastDelta = 0
    const t0 = Date.now()
    const { child, label, model } = childPromise
    state.running = { active: true, prompt: label, pid: child.pid, startedAt: t0, model, sessionId: null, lastDeltaAt: t0, tps: 0 }
    state.context.thinkingStatus = label === '/usage' ? 'Loading' : 'Running'
    pushState()
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        try {
          const m = JSON.parse(line)
          if (m.type === 'delta') {
            if (typeof m.thinking === 'string') r.thinking = (r.thinking || '') + m.thinking
            if (typeof m.content === 'string') r.answer = (r.answer || '') + m.content
            const now = Date.now()
            if (state.running.lastDeltaAt) {
              const dt = (now - state.running.lastDeltaAt) / 1000
              if (dt > 0) state.running.tps = Math.round(1 / dt)
            }
            state.running.lastDeltaAt = now
            state.context.tps = state.running.tps
            pushState()
          } else if (m.type === 'message' && m.message) {
            if (m.message.usage) r.usage = m.message.usage
            if (typeof m.message.content === 'string' && !r.answer) r.answer = m.message.content
            if (typeof m.message.thinking === 'string' && !r.thinking) r.thinking = m.message.thinking
          } else if (m.type === 'exec.result') {
            if (m.sessionId) r.sessionId = m.sessionId
            if (typeof m.durationMs === 'number') r.durationMs = m.durationMs
            if (m.answer) r.answer = m.answer
            r.status = m.status || 'unknown'
            if (m.error) r.error = m.error
            // finalize NOW — don't wait for child.on('exit') which may never
            // fire in mcode 0.1.2's no-TTY stream-json mode
            finalize()
          }
        } catch {}
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => {}) // swallow; usage stats can land here

    // safety: if exec.result never arrives, resolve with whatever we have
    const safetyTimeout = setTimeout(() => {
      if (r.status === 'unknown') {
        r.status = 'timeout'
        r.error = { message: 'mcode exec did not produce exec.result in 90s' }
        try { child.kill() } catch {}
        finalize()
      }
    }, 90000)

    function finalize() {
      if (r._finalized) return
      r._finalized = true
      clearTimeout(safetyTimeout)
      const dt = Date.now() - t0
      r.durationMs = r.durationMs || dt
      state.running = { active: false, prompt: null, pid: null, startedAt: null, model: null, sessionId: null, lastDeltaAt: null, tps: 0 }
      state.context.thinkingStatus = 'Idle'
      state.context.tps = 0
      if (r.usage) {
        state.context.tokens = (state.context.tokens || 0) + (r.usage.totalTokens || 0)
        state.context.used = state.context.tokens
        state.context.percent = state.context.limit ? Math.round((state.context.tokens / state.context.limit) * 100) : 0
        state.context.lastUsageAt = Date.now()
        state.usage.sessionInput = (state.usage.sessionInput || 0) + (r.usage.inputTokens || 0)
        state.usage.sessionOutput = (state.usage.sessionOutput || 0) + (r.usage.outputTokens || 0)
        state.usage.sessionTotal = state.usage.sessionInput + state.usage.sessionOutput
      }
      if (r.sessionId) state.mcodeSessionId = r.sessionId
      pushState()
      resolve(r)
      // mcode 0.1.2 sometimes hangs after exec.result is written.
      // Force-kill so we don't leak processes.
      try { child.kill() } catch {}
    }

    child.stdout.on('end', finalize)
    child.on('exit', finalize)
    child.on('error', (e) => {
      r.status = 'error'
      r.error = { message: e.message }
      finalize()
    })
  })
}

// ============================================================
// HTTP server
// ============================================================
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  const pathname = (req.url || '/').split('?')[0]

  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    return res.end(html)
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({
      ok: true, port: PORT,
      defaultModel: DEFAULT_MODEL, defaultWorkspace: DEFAULT_WORKSPACE,
      mcodeCmd: MCODE_CMD, mcodeVersion: '0.1.2', maxConcurrent: MAX_CONCURRENT,
    }))
  }

  // SSE: state push stream
  if (req.method === 'GET' && pathname === '/api/events') {
    res.writeHead(200, SSE_HEADERS)
    res.write(`data: ${JSON.stringify(state)}\n\n`)
    sseClients.add(res)
    const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 20000)
    req.on('close', () => { clearInterval(ping); sseClients.delete(res) })
    return
  }

  // GET /api/state — full snapshot
  if (req.method === 'GET' && pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify(state))
  }

  // GET /api/sessions — list
  if (req.method === 'GET' && pathname === '/api/sessions') {
    const all = loadSessions()
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ok: true, sessions: all }))
  }
  // POST /api/sessions — new
  if (req.method === 'POST' && pathname === '/api/sessions') {
    const all = loadSessions()
    const id = randomUUID()
    const item = { id, title: 'New session', createdAt: Date.now(), updatedAt: Date.now(), chat: [] }
    all.unshift(item)
    saveSessions(all)
    state.sessionId = id
    state.mcodeSessionId = null  // 新建 webui session 同时开新 mcode 上下文
    state.sessionTitle = item.title
    state.chat = []
    state.usage = { ...state.usage, sessionInput: 0, sessionOutput: 0, sessionTotal: 0 }
    resetContext()
    pushState()
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ok: true, session: item }))
  }

  // POST /api/sessions/switch — 切换到指定 session（点击 sidebar item）
  if (req.method === 'POST' && pathname === '/api/sessions/switch') {
    let body = ''
    for await (const chunk of req) body += chunk
    let payload
    try { payload = JSON.parse(body || '{}') } catch { payload = {} }
    const id = (payload.id || '').trim()
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'id required' }))
    }
    const all = loadSessions()
    const target = all.find((s) => s.id === id)
    if (!target) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'session not found' }))
    }
    // 切换 server 端 state：从 db 加载该 session 的历史 chat（之前只清空不加载，导致切过去看不见对话）
    state.sessionId = target.id
    state.mcodeSessionId = null  // 切到新 webui session 后，mcode 上下文也开新
    state.sessionTitle = target.title || 'Untitled'
    state.chat = Array.isArray(target.chat) ? target.chat : []
    state.usage = { ...state.usage, sessionInput: 0, sessionOutput: 0, sessionTotal: 0 }
    resetContext()
    pushState()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, session: { id: target.id, title: state.sessionTitle, chat: state.chat } }))
  }

  // DELETE /api/sessions/:id — 删一个 session（从 db 移除 + 如果是当前会话则清空 state）
  if (req.method === 'DELETE' && pathname.startsWith('/api/sessions/') && pathname.length > '/api/sessions/'.length) {
    const id = pathname.slice('/api/sessions/'.length)
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'id required' }))
    }
    const all = loadSessions()
    const idx = all.findIndex((s) => s.id === id)
    if (idx === -1) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'session not found' }))
    }
    all.splice(idx, 1)
    saveSessions(all)
    // 如果删的是当前 session，state 切到 Untitled/空 chat
    if (state.sessionId === id) {
      state.sessionId = null
      state.mcodeSessionId = null
      state.sessionTitle = 'Untitled'
      state.chat = []
      state.usage = { ...state.usage, sessionInput: 0, sessionOutput: 0, sessionTotal: 0 }
      resetContext()
    }
    pushState()
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ok: true, deleted: id, remaining: all.length }))
  }

  // POST /api/upload — save file
  if (req.method === 'POST' && pathname === '/api/upload') {
    const ctype = (req.headers['content-type'] || '').toLowerCase()
    if (!ctype.startsWith('multipart/form-data')) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'multipart required' }))
    }
    try {
      const saved = await saveMultipartUpload(req)
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ ok: true, path: saved.path, name: saved.name }))
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: e.message }))
    }
  }

  // POST /api/send — main chat entry, fire-and-forget (response = ack; output via /api/events SSE)
  if (req.method === 'POST' && pathname === '/api/send') {
    let body = ''
    for await (const chunk of req) body += chunk
    let payload
    try { payload = JSON.parse(body || '{}') } catch { payload = {} }
    const content = (payload.content || '').trim()
    if (!content) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'content required' }))
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true }))

    // Append user line immediately, push state
    state.chat = [...(state.chat || []), `› ${content}`]
    pushState()
    persistCurrentChat()

    // v0.5.x: 用户发首条消息时立即按首条内容给 session 改名（之前要等 assistant 回复才改名，导致新建的空 session 一直是 "New session"）
    if (state.sessionTitle === 'New session' || state.sessionTitle === 'Untitled' || !state.sessionTitle) {
      const newTitle = content.slice(0, 50)
      state.sessionTitle = newTitle
      const all = loadSessions()
      const existing = all.find((s) => s.id === state.sessionId)
      if (existing) { existing.title = newTitle; saveSessions(all) }
    }

    // Detect slash commands that we can satisfy without spawning mcode
    const slashMatch = content.match(/^\/(\w+)\b\s*(.*)/)
    if (slashMatch) {
      const cmd = slashMatch[1]
      const rest = slashMatch[2] || ''
      if (cmd === 'clear' || cmd === 'new') {
        // /clear 或 /new：清空当前 chat（如果是 /new 还要新建一个 session entry 并把清空状态写进去）
        if (cmd === 'new') {
          const all = loadSessions()
          const id = randomUUID()
          const item = { id, title: 'New session', createdAt: Date.now(), updatedAt: Date.now(), chat: [] }
          all.unshift(item)
          saveSessions(all)
          state.sessionId = id
          state.sessionTitle = item.title
        } else {
          // /clear：把当前 session 的 chat 数组清空并写回 db（别留下旧消息）
          state.chat = []
          persistCurrentChat()
        }
        state.chat = []
        state.usage = { ...state.usage, sessionInput: 0, sessionOutput: 0, sessionTotal: 0 }
        if (cmd === 'new') {
          state.mcodeSessionId = null
          state.sessionTitle = 'New session'
        } else {
          state.mcodeSessionId = null
          state.sessionTitle = 'Untitled'
        }
        resetContext()
        pushState()
        return
      }
      if (cmd === 'status') {
        const t = `● 当前 model=${state.model.name}\n  workspace=${state.workspace.dir}\n  权限=${state.permissions}`
        state.chat = [...state.chat, t]
        pushState()
        return
      }
      if (cmd === 'usage' || cmd === 'sessions' || cmd === 'help') {
        // 这些是 webui 端识别的斜杠命令，跟 /api/cmd 一样本地处理
        if (cmd === 'sessions') {
          const all = loadSessions()
          const t = `● 最近 ${all.length} 个会话：\n` + all.slice(0, 8).map((s, i) => `  ${i+1}. ${s.title} (${s.id.substring(0, 8)}…)`).join('\n')
          state.chat = [...state.chat, `› /sessions`, t]
          pushState()
          persistCurrentChat()
          return
        }
        if (cmd === 'help') {
          const t = `● 可用命令：\n  /new — 新建会话\n  /clear — 清空当前对话\n  /status — 查看状态\n  /sessions — 最近会话列表\n  /usage — 套餐用量\n  @文件 — 引用文件`
          state.chat = [...state.chat, `› /help`, t]
          pushState()
          persistCurrentChat()
          return
        }
        if (cmd === 'usage') {
          await runUsageQuery()
          return
        }
      }
      // 其他命令走 mcode exec
    }

    // Spawn mcode exec and stream result into state.chat
    // 续接 mcode 自己的 session（mvs_xxx），存在 state.mcodeSessionId；与 webui 侧边栏 sessionId 分离
    const exec = runMcodeExec(content, { label: 'prompt', sessionId: state.mcodeSessionId })
    const r = await collectExecResult(exec)
    // webui.html parseChatLines 角色前缀约定（见 public/index.html L2298-2340）：
    //   › / >  → user   bubble
    //   ● / •  → assistant bubble (Mcode)
    //   ○ / ◯  → system  bubble
    if (r.status === 'succeeded' && r.answer) {
      const oneLine = r.answer.replace(/\n+/g, ' ').trim()
      // webui.html parseChatLines 角色识别：
      //   › / >  → user
      //   ● / •  → assistant
      //   ○ / ◯  → system
      // 用 ● 前缀让 assistant 消息渲染到正确的 bubble
      state.chat = [...state.chat, `● ${oneLine}`]
      state.context.assistantLast = oneLine
      state.context.assistantAt = Date.now()
      // title 已在用户发首条消息时改过了，这里不用再改
    } else if (r.status === 'failed' || r.error) {
      const oneLine = (r.error?.message || r.status).replace(/\n+/g, ' ')
      // 错误用 ○ 渲染为 system bubble
      state.chat = [...state.chat, `○ [error] ${oneLine}`]
      state.context.assistantLast = `[error] ${oneLine}`
      state.context.assistantAt = Date.now()
    }
    persistCurrentChat()  // 把刚追加的 assistant 消息写进 db
    pushState()
    return
  }

  // POST /api/usage — trigger mcode exec /usage, parse output, push state
  if (req.method === 'POST' && (pathname === '/api/usage' || pathname === '/api/usage-trigger')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true }))
    await runUsageQuery()
    return
  }

  // POST /api/refresh — noop (we already push state on demand). html calls this every 60s.
  if (req.method === 'POST' && pathname === '/api/refresh') {
    pushState()
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ok: true }))
  }

  // POST /api/permissions — v0.5.x: 更新 webui 端的权限模式显示
  // 注意：实际 mcode exec 还是 hardcode --permission full（架构上无法动态切换）
  // 这里只更新 state.permissions 让 webui 按钮 label/icon 跟着变
  if (req.method === 'POST' && pathname === '/api/permissions') {
    let body = ''
    for await (const chunk of req) body += chunk
    let payload
    try { payload = JSON.parse(body || '{}') } catch { payload = {} }
    const mode = (payload.mode || 'full').toLowerCase()
    const label = mode === 'ask' ? 'Ask'
      : mode === 'auto' ? 'Auto'
      : mode === 'read' ? 'Read'
      : 'Full access'
    state.permissions = label
    pushState()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, permissions: label }))
  }

  // POST /api/cmd — v0.5.x: webui 的 "新建会话/查看命令/查看状态" 按钮走这个端点
  // 内部转调对应的 mcode 功能（新建 webui session、/status 文案、/usage 查询等）
  if (req.method === 'POST' && pathname === '/api/cmd') {
    let body = ''
    for await (const chunk of req) body += chunk
    let payload
    try { payload = JSON.parse(body || '{}') } catch { payload = {} }
    const cmd = (payload.cmd || '').trim()
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true }))

    if (cmd === '/new') {
      // 等同于点 "新建会话" 按钮
      const all = loadSessions()
      const id = randomUUID()
      const item = { id, title: 'New session', createdAt: Date.now(), updatedAt: Date.now(), chat: [] }
      all.unshift(item)
      saveSessions(all)
      state.sessionId = id
      state.mcodeSessionId = null
      state.sessionTitle = item.title
      state.chat = []
      state.usage = { ...state.usage, sessionInput: 0, sessionOutput: 0, sessionTotal: 0 }
      resetContext()
      pushState()
      return
    }
    if (cmd === '/status') {
      // 直接渲染 status 文案（不调 mcode）
      const t = `● 当前 model=${state.model.name}\n  workspace=${state.workspace.dir}\n  权限=${state.permissions}`
      state.chat = [...(state.chat || []), `› /status`, t]
      pushState()
      persistCurrentChat()
      return
    }
    if (cmd === '/clear') {
      state.chat = []
      state.usage = { ...state.usage, sessionInput: 0, sessionOutput: 0, sessionTotal: 0 }
      state.mcodeSessionId = null
      state.sessionTitle = 'Untitled'
      resetContext()
      persistCurrentChat()  // 把清空写回 db，避免下次切回来还看到旧消息
      pushState()
      return
    }
    if (cmd === '/sessions') {
      const all = loadSessions()
      const t = `● 最近 ${all.length} 个会话：\n` + all.slice(0, 8).map((s, i) => `  ${i+1}. ${s.title} (${s.id.substring(0, 8)}…)`).join('\n')
      state.chat = [...(state.chat || []), `› /sessions`, t]
      pushState()
      persistCurrentChat()
      return
    }
    if (cmd === '/help') {
      const t = `● 可用命令：\n  /new — 新建会话\n  /clear — 清空当前对话\n  /status — 查看状态\n  /sessions — 最近会话列表\n  /usage — 套餐用量\n  @文件 — 引用文件`
      state.chat = [...(state.chat || []), `› /help`, t]
      pushState()
      persistCurrentChat()
      return
    }
    if (cmd === '/usage') {
      await runUsageQuery()
      return
    }
    // 未知命令：忽略
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('not found')
})

// ============================================================
// Multipart upload parser (minimal, no deps)
// ============================================================
function saveMultipartUpload(req) {
  return new Promise((resolve, reject) => {
    const ctype = req.headers['content-type'] || ''
    const m = ctype.match(/boundary=(?:"([^"]+)"|([^;]+))/i)
    if (!m) return reject(new Error('no boundary'))
    const boundary = '--' + (m[1] || m[2])
    let buf = Buffer.alloc(0)
    const chunks = []
    req.on('data', (c) => { chunks.push(c) })
    req.on('end', () => {
      try {
        buf = Buffer.concat(chunks)
        const parts = splitMultipart(buf, boundary)
        for (const part of parts) {
          const cd = part.headers['content-disposition'] || ''
          const nameMatch = cd.match(/name="([^"]+)"/i)
          const filenameMatch = cd.match(/filename="([^"]+)"/i)
          if (!filenameMatch) continue
          const origName = filenameMatch[1]
          const ext = extname(origName) || ''
          const safeName = `${Date.now()}-${createHash('md5').update(origName).digest('hex').slice(0, 6)}${ext}`
          const fullPath = join(UPLOAD_DIR, safeName)
          writeFileSync(fullPath, part.body)
          return resolve({ path: fullPath, name: origName })
        }
        reject(new Error('no file part'))
      } catch (e) { reject(e) }
    })
    req.on('error', reject)
  })
}

function splitMultipart(buf, boundary) {
  const parts = []
  const start = buf.indexOf(boundary) + boundary.length
  let pos = start
  while (pos < buf.length) {
    const next = buf.indexOf(boundary, pos)
    if (next === -1) break
    const block = buf.slice(pos, next - 2) // strip trailing \r\n before next boundary
    const headerEnd = block.indexOf('\r\n\r\n')
    if (headerEnd === -1) { pos = next + boundary.length; continue }
    const headerStr = block.slice(0, headerEnd).toString('utf8')
    const body = block.slice(headerEnd + 4)
    const headers = {}
    for (const line of headerStr.split('\r\n')) {
      const i = line.indexOf(':')
      if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim()
    }
    parts.push({ headers, body })
    pos = next + boundary.length
  }
  return parts
}

server.listen(PORT, HOST, () => {
  console.log(`[webui] listening on http://${HOST}:${PORT}`)
  console.log(`[webui] mcode cmd: ${MCODE_CMD}`)
  console.log(`[webui] default model: ${DEFAULT_MODEL}`)
  console.log(`[webui] default workspace: ${DEFAULT_WORKSPACE}`)
  console.log(`[webui] uploads: ${UPLOAD_DIR}`)
  console.log(`[webui] sessions: ${SESSIONS_DB}`)
})