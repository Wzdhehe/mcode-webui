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
//   POST /api/workspace   {action|dir, syncTui?}           → per-cid 切换 workspace（v0.5.al）
//   GET  /api/workspace/browse?path=...                    → 列出 path 下的子目录（v0.5.am）
//   GET  /api/settings                                     → LAN / 端口 / 主机 等（v0.5.ap）
//   POST /api/settings   {lanBroadcast?: bool}             → 切 LAN 开关（v0.5.ap）
//   GET  /                                                  → public/index.html
//
// Run from inside the .minimax-code root so it finds the local mcode.cmd.
//   cd C:\Users\mjc39\.minimax-code\webui
//   node server.js

import http from 'node:http'
import { spawn, spawnSync } from 'node:child_process'
import { readFileSync, existsSync, statSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { networkInterfaces } from 'node:os'
import { dirname, join, resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID, createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { McodeAcpClient } from './acp.mjs'

// v0.5.bj: 启动时从 mcode 的 cli.js bundle 里提取 hardcoded 的 MiniMax-M* 模型列表
// （用户 TUI 显示的 model 候选项就是这一份，mcode 内部硬编码 — 我们从 mcode 自己的 bundle 读，不在 webui 硬编码）
let CACHED_BUILTIN_MODELS = null
function getBuiltinModelsFromMcode() {
  if (CACHED_BUILTIN_MODELS !== null) return CACHED_BUILTIN_MODELS
  try {
    // mcode 的 cli.js（mcode.ps1 里的 cliEntry 变量）
    // v0.5.bj: 优先用 MCODE_ROOT（跟 MCODE_CMD 同源），fallback __dirname
    const mcodePs1 = join(MCODE_ROOT, 'mcode.ps1')
    let cliEntry = null
    if (existsSync(mcodePs1)) {
      const ps1 = readFileSync(mcodePs1, 'utf-8')
      const m = ps1.match(/cliEntry\s*=\s*Join-Path\s+\$basedir\s+"([^"]+)"/)
      if (m) cliEntry = join(MCODE_ROOT, m[1])
    }
    if (!cliEntry || !existsSync(cliEntry)) {
      console.log('[models] cli.js not found, fallback empty')
      CACHED_BUILTIN_MODELS = []
      return []
    }
    const content = readFileSync(cliEntry, 'utf-8')
    // 匹配 MiniMax-M* 形式（带或不带 -highspeed 等后缀）
    const re = /MiniMax-M[0-9][a-z0-9.\-]*/g
    const found = new Set()
    let m
    while ((m = re.exec(content)) !== null) found.add(m[0])
    CACHED_BUILTIN_MODELS = [...found].sort().reverse()  // M3 排前
    console.log('[models] extracted from cli.js:', CACHED_BUILTIN_MODELS.length, 'models')
    return CACHED_BUILTIN_MODELS
  } catch (e) {
    console.error('[models] extract failed:', e.message)
    CACHED_BUILTIN_MODELS = []
    return []
  }
}

const __dirname = dirname(fileURLToPath(import.meta.url))

const PORT = Number(process.env.PORT) || 7890
// v0.5.ao: web UI 默认监听所有网卡（不限制本机）— 用户在浏览器/手机/局域网访问是主场景
// 如需限制为仅本机访问，设环境变量 HOST=127.0.0.1
const HOST = process.env.HOST || '0.0.0.0'
const MCODE_ROOT = resolve(__dirname, '..')
const MCODE_CMD = join(MCODE_ROOT, 'mcode.cmd')
const DEFAULT_MODEL = process.env.MCODE_MODEL || 'minimax_api/MiniMax-M3'

// v0.5.ap: 局域网访问设置 — 运行时可切换（per-server）
// 状态从 /api/settings GET 获取；POST /api/settings {lanBroadcast: bool} 修改
// 关闭时：拒绝所有非本地 IP 的请求，返 403 + 提示页
let lanBroadcastEnabled = true

// 检测本机局域网 IPv4（取第一个非 internal 的 IPv4）
function detectLanIp() {
  const ifaces = networkInterfaces()
  for (const name of Object.keys(ifaces)) {
    for (const i of ifaces[name] || []) {
      if (i.family === 'IPv4' && !i.internal) return i.address
    }
  }
  return '127.0.0.1'
}
const LAN_IP = detectLanIp()

// 判断请求是否来自本机（IPv4 / IPv6 loopback）
function isLocalRequest(req) {
  const ip = req.socket.remoteAddress || ''
  return ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === LAN_IP
}
// v0.5.z: workspace 优先级 — env MCODE_WORKSPACE > mcode TUI 写的 ~/.minimax/runtime/cwd.json > MCODE_ROOT fallback
// v0.5.bn: mcode 写的 cwd.json 开头有 UTF-8 BOM（\ufeff），JSON.parse 不认会抛 — 这里剥掉再 parse
function detectTuiCwd() {
  const f = join(homedir(), '.minimax', 'runtime', 'cwd.json')
  if (!existsSync(f)) return null
  try {
    let raw = readFileSync(f, 'utf8')
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)  // 剥 BOM
    const o = JSON.parse(raw)
    if (o && typeof o.cwd === 'string' && o.cwd) return o.cwd
  } catch (e) {
    console.warn(`[webui] detectTuiCwd: ${f} parse failed: ${e.message}`)
  }
  return null
}
// v0.5.bn: 默认工作区必须有真实路径，否则 mcode acp session/new 报 "Invalid params"
//   之前的 null 设计是想要"用户没选就不发"语义，但 acp 必须传 cwd
//   优先级：env MCODE_WORKSPACE > mcode TUI 的 cwd.json > 用户家目录（兜底）
// v0.5.bb 旧逻辑：process.env.MCODE_WORKSPACE || null  ← 这里 null 害了用户
const DEFAULT_WORKSPACE = (() => {
  if (process.env.MCODE_WORKSPACE) {
    console.log(`[webui] workspace: env MCODE_WORKSPACE=${process.env.MCODE_WORKSPACE}`)
    return process.env.MCODE_WORKSPACE
  }
  const tui = detectTuiCwd()
  if (tui) {
    console.log(`[webui] workspace: tui cwd.json=${tui}`)
    return tui
  }
  const home = homedir()
  console.log(`[webui] workspace: homedir fallback=${home}`)
  return home
})()
const DEFAULT_TIMEOUT = process.env.MCODE_TIMEOUT || '120s'

// v0.5.bl: 全局未捕获错误 handler — server 崩了不静默，至少打日志 + 写 .server.err
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err)
  try {
    const fs = require('node:fs')
    const logFile = join(__dirname, '.server.err')
    fs.appendFileSync(logFile, `\n[uncaughtException ${new Date().toISOString()}] ${err.stack || err.message}\n`)
  } catch {}
})
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason)
  try {
    const fs = require('node:fs')
    const logFile = join(__dirname, '.server.err')
    fs.appendFileSync(logFile, `\n[unhandledRejection ${new Date().toISOString()}] ${reason && reason.stack ? reason.stack : String(reason)}\n`)
  } catch {}
})
const DEFAULT_MAX_STEPS = Number(process.env.MCODE_MAX_STEPS) || 6
const MAX_CONCURRENT = Number(process.env.MCODE_MAX_CONCURRENT) || 3
const UPLOAD_DIR = process.env.MCODE_WEBUI_UPLOAD_DIR || join(MCODE_ROOT, '.webui-uploads')
const SESSIONS_DB = process.env.MCODE_WEBUI_SESSIONS_DB || join(MCODE_ROOT, '.webui-sessions.json')

// v0.5.ai: A2 per-client 架构
// 每个 webui tab 一个 client (cid = localStorage webui_cid)
// 每个 client 独立：state (chat/mcodeSessionId/context/usage/running), activeChild, SSE connection
// 缺 cid 的请求 fallback 到 'default' client (兼容老 client)

// 重置所有 context 字段（不只是 tokens/used；percent/spent/tps 之前漏了导致切完仍显示旧的 %）
function resetContext(cs) {
  cs.context.tokens = 0
  cs.context.used = 0
  cs.context.percent = 0
  cs.context.spent = 0
  cs.context.tps = 0
  cs.context.thinkingDuration = null
  cs.context.assistantLast = null
  cs.context.assistantAt = null
  cs.context.lastUsageAt = null
}

// v0.5.x: 把当前 state.chat 写回 db 里对应 session 的 chat 字段
// 切 session 时从这个字段加载历史（之前 db 只存 {id,title,createdAt}，导致切过去看不到聊天）
function persistCurrentChat(cs) {
  if (!cs.sessionId) return
  const all = loadSessions()
  const item = all.find((s) => s.id === cs.sessionId)
  if (!item) return
  item.chat = cs.chat || []
  item.updatedAt = Date.now()
  saveSessions(all)
}

if (!existsSync(MCODE_CMD)) {
  console.error(`[fatal] mcode.cmd not found at ${MCODE_CMD}`)
  process.exit(1)
}
mkdirSync(UPLOAD_DIR, { recursive: true })

// v0.5.ad: 流式更新 chat 数组 — 同 prefix 最后一行就地替换，否则追加
function streamUpdateLine(chat, prefix, text) {
  const target = `${prefix} `
  const last = chat[chat.length - 1]
  if (last && last.startsWith(target)) {
    chat[chat.length - 1] = `${target}${text} ▍`
  } else {
    chat.push(`${target}${text} ▍`)
  }
}

// ============================================================
// v0.5.ak: mcode 真实命令缓存（不套预设）
// 用一个长寿命 McodeAcpClient lazy init 拉 available_commands_update
// /help 读这里，不用 hardcode 列表
// 不让我（Mavis）abort — 这个 client 是 webui server 的子进程
// ============================================================
let cachedMcodeCommands = { mcode: [], webui: [], fetchedAt: 0, source: 'none' }
const WEBUI_LOCAL_COMMANDS = [
  { name: 'new',     desc: '新建会话' },
  { name: 'clear',   desc: '清空当前对话' },
  { name: 'status',  desc: '查看状态' },
  { name: 'sessions',desc: '最近会话列表' },
  { name: 'usage',   desc: '套餐用量' },
  { name: 'help',    desc: '可用命令' },
  { name: 'stop',    desc: '停止当前任务' },
]
let mcodeCommandsClient = null  // long-lived McodeAcpClient
let mcodeCommandsPromise = null // 去重 lazy init

async function ensureMcodeCommands({ forceRefresh = false } = {}) {
  const STALE_MS = 5 * 60 * 1000  // 5 min
  const now = Date.now()
  if (!forceRefresh && cachedMcodeCommands.mcode.length > 0 && (now - cachedMcodeCommands.fetchedAt) < STALE_MS) {
    return cachedMcodeCommands
  }
  // 去重：如果已经在 fetch，复用
  if (mcodeCommandsPromise) return mcodeCommandsPromise
  mcodeCommandsPromise = (async () => {
    try {
      // 关掉旧 client（refresh 时）
      if (mcodeCommandsClient) {
        try { mcodeCommandsClient.stop() } catch {}
        mcodeCommandsClient = null
      }
      const client = new McodeAcpClient({ debug: false })
      mcodeCommandsClient = client
      // v0.5.ak fix: available_commands_update 是在 session/new 之后才发的，不是 initialize 之后
      // 所以要：start → newSession → listen event
      const got = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('mcode acp available_commands_update timeout 8s')), 8000)
        client.on('available_commands_update', (u) => {
          // payload 形态待定：{commands: [...]} 或 [...string] 或其他
          const cmds = (u && (u.commands || u.availableCommands || u)) || []
          const list = Array.isArray(cmds) ? cmds : []
          clearTimeout(timer)
          resolve(list)
        })
        client.start()
          .then(() => client.newSession(DEFAULT_WORKSPACE))
          .catch((e) => { clearTimeout(timer); reject(e) })
      })
      const list = await got
      cachedMcodeCommands = {
        mcode: list,
        webui: WEBUI_LOCAL_COMMANDS,
        fetchedAt: Date.now(),
        source: 'mcode.acp.available_commands_update',
      }
      console.log(`[webui] cachedMcodeCommands refreshed: ${list.length} mcode commands`)
      pushStateFor('__broadcast__')  // 推给所有 client（让所有 tab 更新命令列表 UI）
      return cachedMcodeCommands
    } catch (e) {
      console.warn(`[webui] ensureMcodeCommands failed: ${e.message}`)
      cachedMcodeCommands = {
        mcode: [],
        webui: WEBUI_LOCAL_COMMANDS,
        fetchedAt: 0,
        source: `error: ${e.message}`,
      }
      return cachedMcodeCommands
    } finally {
      mcodeCommandsPromise = null
      // 关掉 client（保持长寿命的话别 stop，但 mcode acp 闲置 5min 后可能 hang，先关掉按需重启）
      if (mcodeCommandsClient) {
        try { mcodeCommandsClient.stop() } catch {}
        mcodeCommandsClient = null
      }
    }
  })()
  return mcodeCommandsPromise
}

// v0.5.bu: 拉 mcode 真实 session 列表（mcode acp session/list 协议）
// 数据源：mcode TUI 自己的 session 存储（不是 webui 的 .webui-sessions.json）
// 按 cwd 过滤（mcode 每个 session 都有 cwd 字段，匹配 cs.workspace.dir 才显示）
let mcodeSessionsCache = { ws: null, sessions: [], fetchedAt: 0 }
async function getMcodeSessionsForWorkspace(workspace) {
  const STALE_MS = 30 * 1000  // 30s — 比 commands 的 5min 短，因为 prompt 后要立即刷新
  const now = Date.now()
  if (mcodeSessionsCache.ws === workspace && (now - mcodeSessionsCache.fetchedAt) < STALE_MS) {
    return mcodeSessionsCache.sessions
  }
  const client = new McodeAcpClient({ debug: false })
  try {
    await client.start()
    const r = await client.listSessions()
    const all = (r && Array.isArray(r.sessions)) ? r.sessions : []
    // 按 cwd 过滤（normalize path — windows 大小写不敏感 + 去尾斜杠）
    const norm = (p) => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    const target = norm(workspace)
    const filtered = target ? all.filter(s => norm(s.cwd) === target) : all
    mcodeSessionsCache = { ws: workspace, sessions: filtered, fetchedAt: now }
    return filtered
  } catch (e) {
    console.warn(`[acp] listSessions failed: ${e.message}`)
    return mcodeSessionsCache.sessions || []
  } finally {
    try { client.stop() } catch {}
  }
}

// v0.5.bx: prompt 完成后用 mcodeSessionId 反查 mcode 真实 title
// 数据源：mcode TUI 自己的 session 存储（不是 webui 的）
// 用途：替换 webui "New session" / 截断首句 → 用 mcode 自动生成的标题
async function getMcodeSessionTitle(mcodeSessionId) {
  if (!mcodeSessionId) return null
  const client = new McodeAcpClient({ debug: false })
  try {
    await client.start()
    const r = await client.listSessions()
    const all = (r && Array.isArray(r.sessions)) ? r.sessions : []
    const hit = all.find(s => s.sessionId === mcodeSessionId)
    return hit && hit.title ? hit.title : null
  } catch (e) {
    console.warn(`[acp] getMcodeSessionTitle failed: ${e.message}`)
    return null
  } finally {
    try { client.stop() } catch {}
  }
}

function invalidateMcodeSessionsCache() {
  mcodeSessionsCache = { ws: null, sessions: [], fetchedAt: 0 }
}

// ============================================================
// In-memory state (A2 per-client)
// ============================================================
// v0.5.ai: 每个 webui tab 一个独立 state。
// clients: cid -> clientState
// sseByCid: cid -> SSE response
// activeChildByCid: cid -> 当前 mcode 子进程（acp client 或 exec child）
function makeClientState() {
  return {
    version: '0.1.3',
    workspace: { dir: DEFAULT_WORKSPACE, branch: null, tree: null },  // v0.5.bb: 默认 null（之前是 MCODE_ROOT）
    model: { name: DEFAULT_MODEL, thinking: 'On', ctx: '512k' },
    sessionId: null,         // webui 侧边栏 session id (randomUUID)
    mcodeSessionId: null,    // mcode acp/exec 自己的 session id (mvs_xxx)
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
      raw: null, fetchedAt: null, error: null,
    },
    permissions: 'Full access',
    chat: [],
    sessions: [],
    goal: { active: false, text: null, status: null, duration: null },
    todo: [],
    ask: { active: false, total: 0, answered: 0, currentIdx: 0, question: '', options: [] },
    plan: { active: false, title: null, summary: '', options: [] },
    running: { active: false, prompt: null, pid: null, startedAt: null, model: null, sessionId: null, lastDeltaAt: null, tps: 0 },
  }
}

const clients = new Map()            // cid -> clientState
const sseByCid = new Map()           // cid -> SSE response
const activeChildByCid = new Map()   // cid -> child process

function getClient(cid) {
  if (!cid) cid = 'default'
  if (!clients.has(cid)) clients.set(cid, makeClientState())
  return clients.get(cid)
}

function getCidFromReq(req) {
  try {
    const u = new URL(req.url, 'http://x')
    return u.searchParams.get('cid') || ''
  } catch {
    return ''
  }
}

function pushStateFor(cid) {
  // v0.5.ak: '__broadcast__' 推给所有 client（用于全局缓存更新如 cachedMcodeCommands）
  if (cid === '__broadcast__') {
    for (const [c, res] of sseByCid) {
      const cs = clients.get(c) || makeClientState()
      const snapshot = { ...cs, sessions: loadSessions(), availableCommands: cachedMcodeCommands, onlineCount: sseByCid.size, lanBroadcast: lanBroadcastEnabled }
      try { res.write(`data: ${JSON.stringify(snapshot)}\n\n`) } catch {}
    }
    return
  }
  const cs = getClient(cid)
  // 注入 sessions 列表（来自磁盘 db）— 让 webui 侧边栏 "最近会话" 不被 SSE 推送覆盖
  // v0.5.bv: 同步带 mcodeSessions（cache 命中，0 cost；cache miss 才 await）
  const snapshot = { ...cs, sessions: loadSessions(), mcodeSessions: (mcodeSessionsCache.sessions || []), availableCommands: cachedMcodeCommands, onlineCount: sseByCid.size, lanBroadcast: lanBroadcastEnabled }
  const payload = JSON.stringify(snapshot)
  const res = sseByCid.get(cid)
  if (res) { try { res.write(`data: ${payload}\n\n`) } catch {} }
}

// v0.5.ak: SSE 客户端数变化时广播（让所有 tab 实时看到 onlineCount）
function pushOnlineCount() {
  for (const [c, res] of sseByCid) {
    const cs = clients.get(c) || makeClientState()
    const snapshot = { ...cs, sessions: loadSessions(), availableCommands: cachedMcodeCommands, onlineCount: sseByCid.size, lanBroadcast: lanBroadcastEnabled }
    try { res.write(`data: ${JSON.stringify(snapshot)}\n\n`) } catch {}
  }
}

// Sessions store (file-backed JSON; minimal)
// v0.5.bx-5: 剥 UTF-8 BOM — 之前直接 JSON.parse 在 \ufeff 上抛 syntax error，try/catch 静默吞掉返 []
//   结果：所有 session 查找都查不到，delete/switch 都 404 "session not found"（用户报"删除不掉对话"）
function loadSessions() {
  if (!existsSync(SESSIONS_DB)) return []
  try {
    let raw = readFileSync(SESSIONS_DB, 'utf8')
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1)  // 剥 BOM
    return JSON.parse(raw)
  } catch { return [] }
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

// v0.5.ai: /usage 改成 per-cid — 每个 webui tab 自己的 usage
async function runUsageQuery(cs, cid) {
  try {
    const data = await mmxQuotaShow()
    const general = data.model_remains?.find((m) => m.model_name === 'general') || data.model_remains?.[0]
    if (general) {
      cs.usage.fiveHourPercent = general.current_interval_remaining_percent
      cs.usage.weekly = `${general.current_weekly_remaining_percent}%`
    }
    cs.usage.raw = JSON.stringify(data, null, 2)
    cs.usage.fetchedAt = Date.now()
    cs.usage.error = null
  } catch (e) {
    cs.usage.fetchedAt = Date.now()
    cs.usage.error = String(e.message || e)
  }
  pushStateFor(cid)
  // 不写 chat，不 persistCurrentChat
}

// v0.5.ak: 启动时清理空 chat + 默认标题的 session（用户点了"新建会话"但没发消息的残留）
// 保留：有 chat 内容的；或标题是用户手打的中文/英文（不是 New session/Untitled/对话 N 这种默认名）
// 额外保护：updatedAt 距离现在 > 24h 的才清掉（避免把刚 + 按钮创建的 session 也干掉）
;(function cleanupEmptyDefaultSessions() {
  if (!existsSync(SESSIONS_DB)) return
  let all
  try { all = JSON.parse(readFileSync(SESSIONS_DB, 'utf8')) } catch { return }
  if (!Array.isArray(all) || all.length === 0) return
  const before = all.length
  const now = Date.now()
  const STALE_MS = 24 * 60 * 60 * 1000
  all = all.filter((s) => {
    if (!s || !s.id) return false
    const hasChat = Array.isArray(s.chat) && s.chat.length > 0
    if (hasChat) return true  // 有消息就保留
    const t = (s.title || '').trim()
    // 真实标题（非默认名）也保留
    const isDefault = t === 'New session' || t === 'Untitled' || /^对话 \d+$/.test(t)
    if (!isDefault) return true
    // 默认名 + 24h 内刚建的：保留（刚 + 按钮创建的，别误删）
    if (s.updatedAt && (now - s.updatedAt) < STALE_MS) return true
    return false  // 默认名 + 老于 24h：清理
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
  const workspace = opts.workspace || (opts.cs && opts.cs.workspace && opts.cs.workspace.dir) || DEFAULT_WORKSPACE
  const model = opts.model || DEFAULT_MODEL
  const timeout = opts.timeout || DEFAULT_TIMEOUT
  const maxSteps = opts.maxSteps || DEFAULT_MAX_STEPS
  const label = opts.label || 'prompt'
  // 续接已有 session（多轮对话上下文）— 由 collectExecResult 写回的 mcode exec.sessionId
  const sessionId = opts.sessionId || null
  const cs = opts.cs  // v0.5.ai: per-cid state
  const cid = opts.cid

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
  // v0.5.ai: per-cid child tracker（/api/stop 按 cid 找 child）
  if (cid) activeChildByCid.set(cid, child)
  return { child, args, label, model, workspace, sessionId, cs, cid }
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
    const { child, label, model, cs, cid } = childPromise
    cs.running = { active: true, prompt: label, pid: child.pid, startedAt: t0, model, sessionId: null, lastDeltaAt: t0, tps: 0 }
    cs.context.thinkingStatus = label === '/usage' ? 'Loading' : 'Running'
    pushStateFor(cid)
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
            if (typeof m.thinking === 'string') {
              r.thinking = (r.thinking || '') + m.thinking
              const oneLine = r.thinking.replace(/\n+/g, ' ').trim()
              streamUpdateLine(cs.chat, '▲', oneLine)
            }
            if (typeof m.content === 'string') {
              r.answer = (r.answer || '') + m.content
              const oneLine = r.answer.replace(/\n+/g, ' ').trim()
              streamUpdateLine(cs.chat, '●', oneLine)
            }
            const now = Date.now()
            if (cs.running.lastDeltaAt) {
              const dt = (now - cs.running.lastDeltaAt) / 1000
              if (dt > 0) cs.running.tps = Math.round(1 / dt)
            }
            cs.running.lastDeltaAt = now
            cs.context.tps = cs.running.tps
            pushStateFor(cid)
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
            finalize()
          }
        } catch {}
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', () => {}) // swallow; usage stats can land here

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
      if (r._stopped) r.status = 'stopped'
      if (cid) activeChildByCid.delete(cid)
      cs.running = { active: false, prompt: null, pid: null, startedAt: null, model: null, sessionId: null, lastDeltaAt: null, tps: 0 }
      cs.context.thinkingStatus = 'Idle'
      cs.context.tps = 0
      if (r.usage) {
        cs.context.tokens = (cs.context.tokens || 0) + (r.usage.totalTokens || 0)
        cs.context.used = cs.context.tokens
        cs.context.percent = cs.context.limit ? Math.round((cs.context.tokens / cs.context.limit) * 100) : 0
        cs.context.lastUsageAt = Date.now()
        cs.usage.sessionInput = (cs.usage.sessionInput || 0) + (r.usage.inputTokens || 0)
        cs.usage.sessionOutput = (cs.usage.sessionOutput || 0) + (r.usage.outputTokens || 0)
        cs.usage.sessionTotal = cs.usage.sessionInput + cs.usage.sessionOutput
      }
      if (r.sessionId) cs.mcodeSessionId = r.sessionId
      pushStateFor(cid)
      resolve(r)
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

// v0.5.ah: 走 mcode acp 协议 — 替代 mcode exec 的流式
// v0.5.ai: per-cid — opts.cs/cs.cid
// v0.5.al: 读 cs.workspace.dir（per-cid 可改）— 没有时 fallback DEFAULT_WORKSPACE
async function runMcodeAcp(content, opts = {}) {
  const label = opts.label || 'prompt'
  const existingSid = opts.sessionId || null
  const cs = opts.cs
  const cid = opts.cid
  const workspace = (cs && cs.workspace && cs.workspace.dir) || DEFAULT_WORKSPACE
  const client = new McodeAcpClient({ debug: false })
  let sid = existingSid
  try {
    await client.start()
    if (sid) {
      try {
        await client.loadSession(sid, workspace)
      } catch (e) {
        console.warn(`[webui] acp session/load ${sid} failed: ${e.message}; creating new`)
        sid = null
      }
    }
    if (!sid) {
      const r = await client.newSession(workspace)
      sid = r.sessionId
    }
    return await streamAcpPrompt(client, sid, content, label, cs, cid)
  } catch (e) {
    return { status: 'failed', error: { message: e.message }, sessionId: sid, answer: null, thinking: null }
  } finally {
    if (cid) activeChildByCid.delete(cid)
    client.stop()
  }
}

// 类似 collectExecResult，但事件源是 acp client 的 prompt callback
// v0.5.ai: per-cid — cs/cs.cid
function streamAcpPrompt(client, sid, content, label, cs, cid) {
  return new Promise((resolve) => {
    const r = {
      answer: null, thinking: null, status: 'unknown', error: null,
      usage: null, sessionId: sid, durationMs: null, stopReason: null, tps: null,
    }
    const t0 = Date.now()
    cs.running = {
      active: true, prompt: label, pid: null, startedAt: t0,
      model: cs.model.name, sessionId: sid, lastDeltaAt: t0, tps: 0,
    }
    cs.context.thinkingStatus = 'Running'
    if (cid) activeChildByCid.set(cid, client)
    pushStateFor(cid)
    const safetyTimeout = setTimeout(() => {
      if (r.status === 'unknown') {
        r.status = 'timeout'
        r.error = { message: 'mcode acp prompt did not return in 90s' }
        try { client.stop() } catch {}
        finalize()
      }
    }, 90000)
    function finalize() {
      if (r._finalized) return
      r._finalized = true
      clearTimeout(safetyTimeout)
      r.durationMs = r.durationMs || (Date.now() - t0)
      if (cid) activeChildByCid.delete(cid)
      cs.running = { active: false, prompt: null, pid: null, startedAt: null, model: null, sessionId: null, lastDeltaAt: null, tps: 0 }
      cs.context.thinkingStatus = 'Idle'
      cs.context.tps = 0
      // v0.5.bx: 去掉流式光标 ▍（streamUpdateLine 边推边加，finalize 必须清）
      // 否则 thinking 块/answer 块会被永久 mark 为 streaming，对话结束还闪
      if (Array.isArray(cs.chat)) {
        cs.chat = cs.chat.map(line => typeof line === 'string' && line.endsWith(' ▍') ? line.slice(0, -2) : line)
      }
      if (r.usage) {
        cs.context.tokens = (cs.context.tokens || 0) + (r.usage.totalTokens || 0)
        cs.context.used = cs.context.tokens
        cs.context.percent = cs.context.limit ? Math.round((cs.context.tokens / cs.context.limit) * 100) : 0
        cs.context.lastUsageAt = Date.now()
        cs.usage.sessionInput = (cs.usage.sessionInput || 0) + (r.usage.inputTokens || 0)
        cs.usage.sessionOutput = (cs.usage.sessionOutput || 0) + (r.usage.outputTokens || 0)
        cs.usage.sessionTotal = cs.usage.sessionInput + cs.usage.sessionOutput
      }
      // v0.5.bx-7: debug — 看 mcode 0.1.4 实际给的 usage 数据
      if (process.env.MCODE_USAGE_DEBUG) {
        console.log(`[finalize.usage] cid=${cid} r.usage=${JSON.stringify(r.usage)} r.answerLen=${(r.answer || '').length} r.thinkingLen=${(r.thinking || '').length}`)
      }
      if (r.sessionId) cs.mcodeSessionId = r.sessionId
      // v0.5.bx: prompt 完成后用 mcodeSessionId 反查 mcode 真实 title
      // 数据源：mcode TUI 自动生成的标题（比 webui 截断首句更准）
      if (r.sessionId) {
        const finalSid = r.sessionId
        getMcodeSessionTitle(finalSid).then((title) => {
          if (!title) return
          // 只在用户没改过（仍是默认标题）时更新
          const isDefault = !cs.sessionTitle || cs.sessionTitle === 'New session' || cs.sessionTitle === 'Untitled'
          if (isDefault && cs.mcodeSessionId === finalSid) {
            cs.sessionTitle = title
            // 同步到 webui session db（写 mcodeSessionId + title，让 sidebar 能 1:1 找回来）
            if (cs.sessionId) {
              try {
                const all = loadSessions()
                const item = all.find(s => s.id === cs.sessionId)
                if (item) {
                  item.title = title
                  item.mcodeSessionId = finalSid
                  item.updatedAt = Date.now()
                  saveSessions(all)
                }
              } catch (e) { console.warn(`[bx] save title/mcodeSid failed: ${e.message}`) }
            }
            pushStateFor(cid)
          }
        }).catch((e) => console.warn(`[bx] getMcodeSessionTitle: ${e.message}`))
        // v0.5.bv: 失效 mcode sessions cache + 异步拉新 list 推给 client
        // （让 sidebar 立即看到新 session，不用等 30s cache 过期）
        invalidateMcodeSessionsCache()
        getMcodeSessionsForWorkspace(cs.workspace && cs.workspace.dir).then(() => {
          pushStateFor(cid)  // pushStateFor 读 mcodeSessionsCache.sessions
        }).catch(() => {})
      }
      pushStateFor(cid)
      resolve(r)
    }
    client.prompt(sid, content, (c) => {
      // v0.5.bm: 详细日志 — 看到 mcode acp 返回了什么
      console.log(`[acp.cb] kind=${c.kind} text=${JSON.stringify((c.text || '').slice(0, 200))} data=${JSON.stringify(c.data || '').slice(0, 200)}`)
      // v0.5.bm: 处理 error 事件
      if (c.kind === 'error' || c.error) {
        r.error = { message: c.text || c.error || JSON.stringify(c) }
        r.status = 'failed'
        finalize()
        return
      }
      if (c.kind === 'usage' && c.update) {
        // v0.5.bx: mcode acp usage_update 事件（{used, size, cost} — 当前 session 已用 vs 上限）
        // 字段是累计值，直接覆盖 cs.context
        const u = c.update
        if (process.env.MCODE_USAGE_DEBUG) console.log(`[usage.chunk] cid=${cid} update=${JSON.stringify(u)}`)
        if (typeof u.used === 'number') {
          cs.context.used = u.used
          cs.context.tokens = u.used
        }
        if (typeof u.size === 'number' && u.size > 0) {
          cs.context.limit = u.size
        }
        if (cs.context.limit) {
          cs.context.percent = Math.round((cs.context.used / cs.context.limit) * 100)
        }
      } else if (c.kind === 'thought' && typeof c.text === 'string') {
        r.thinking = (r.thinking || '') + c.text
        const oneLine = r.thinking.replace(/\n+/g, ' ').trim()
        streamUpdateLine(cs.chat, '▲', oneLine)
      } else if (c.kind === 'message' && typeof c.text === 'string') {
        r.answer = (r.answer || '') + c.text
        const oneLine = r.answer.replace(/\n+/g, ' ').trim()
        streamUpdateLine(cs.chat, '●', oneLine)
      } else if (c.kind === 'tool_call' && c.update) {
        // v0.5.bs: 工具调用开始 — 写 `→ toolName` 行到 chat
        const u = c.update
        const name = u.title || u.name || u.toolName || 'tool'
        const input = u.rawInput ? JSON.stringify(u.rawInput) : ''
        const line = input ? `→ ${name}  ${input}` : `→ ${name}`
        cs.chat = [...cs.chat, line]
        // 记下这行在 chat 里的位置（之后 tool_update 用来在它后面插输出）
        if (!r.toolIndexById) r.toolIndexById = new Map()
        r.toolIndexById.set(u.toolCallId, cs.chat.length - 1)
      } else if (c.kind === 'tool_update' && c.update) {
        // v0.5.bs: 工具完成 — 在 `→ toolName` 行后插入输出行（`  text` 缩进标识）
        // v0.5.bx-6: 0.1.4+ mcode acp 的 tool_call_update 带 locations: [{path: "..."}]
        //   那些被工具读/写/编辑的本地文件路径 — 显示成 `  @ /path/to/file` 行（@ 前缀方便 client 识别）
        const u = c.update
        const status = u.status || 'completed'
        const rawOutput = u.rawOutput
        // 抽 rawOutput.content[].text
        const outText = (rawOutput && Array.isArray(rawOutput.content))
          ? rawOutput.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
          : ''
        const insertAfter = (r.toolIndexById && r.toolIndexById.get(u.toolCallId)) ?? (cs.chat.length - 1)
        const newLines = []
        // status 行（completed / failed / in_progress）
        newLines.push(`  [${status}]`)
        if (outText) {
          // 多行输出，每行都加 `  ` 前缀，跟在 `→ toolName` 后面读起来整齐
          for (const ln of outText.split('\n')) newLines.push('  ' + ln)
        }
        // v0.5.bx-6: tool 涉及的本地文件路径
        if (Array.isArray(u.locations) && u.locations.length > 0) {
          const seen = new Set()
          for (const loc of u.locations) {
            const p = loc && loc.path
            if (typeof p === 'string' && p && !seen.has(p)) {
              seen.add(p)
              newLines.push(`  @ ${p}`)
            }
          }
        }
        if (u.error) newLines.push(`  ! ${typeof u.error === 'string' ? u.error : (u.error.message || JSON.stringify(u.error))}`)
        // 插到 → 行后面
        cs.chat = [
          ...cs.chat.slice(0, insertAfter + 1),
          ...newLines,
          ...cs.chat.slice(insertAfter + 1),
        ]
        // 后续 tool 行的 index 都要往后挪 newLines.length
        if (r.toolIndexById) {
          for (const [k, v] of r.toolIndexById) {
            if (v > insertAfter) r.toolIndexById.set(k, v + newLines.length)
          }
        }
      } else if (c.kind === 'plan_update' && c.update) {
        // v0.5.bx-9: mcode 0.1.5+ 暴露 plan_update 事件（0.1.4 probe 验证不发, 但接好备用）
        //   字段: {sessionId, planId, title, summary, options: [{label, description}]}
        const u = c.update
        cs.plan = {
          active: true,
          planId: u.planId || null,
          title: u.title || '',
          summary: u.summary || '',
          options: Array.isArray(u.options) ? u.options.map(o => ({
            label: o.label || '',
            desc: o.description || o.desc || '',
          })) : [],
        }
        console.log(`[plan.update] cid=${cid} planId=${cs.plan.planId} title="${(u.title || '').slice(0, 50)}" options=${cs.plan.options.length}`)
      } else if (c.kind === 'plan_removed' && c.update) {
        // v0.5.bx-9: 取消 plan
        cs.plan = { active: false, planId: null, title: null, summary: '', options: [] }
        console.log(`[plan.removed] cid=${cid}`)
      } else if (c.kind === 'mode_update' && c.update) {
        // v0.5.bx-9: mcode 切模式 (plan/ask/normal)
        const u = c.update
        const mode = u.mode || u.currentMode || null
        if (mode === 'plan') {
          cs.enterPlanMode = { active: true, prompt: u.prompt || u.message || null }
        } else {
          cs.enterPlanMode = { active: false, prompt: null }
        }
        console.log(`[mode.update] cid=${cid} mode=${mode}`)
      } else if (c.kind === 'goal_update' && c.update) {
        // v0.5.bx-9: 目标追踪 (0.1.4 acp 没见, 0.1.5+ 可能加)
        const u = c.update
        cs.goal = {
          active: !!u.active,
          text: u.text || u.description || null,
          status: u.status || null,
          duration: u.duration || null,
        }
        console.log(`[goal.update] cid=${cid} active=${cs.goal.active} status=${cs.goal.status}`)
      } else if (c.kind === 'other' && c.update) {
        // v0.5.bx-9: 其他 event — 记日志方便排查
        const u = c.update
        if (u && u.sessionUpdate) {
          console.log(`[acp.other.event] sessionUpdate=${u.sessionUpdate} keys=${JSON.stringify(Object.keys(u)).slice(0, 200)}`)
        }
      }
      const now = Date.now()
      if (cs.running.lastDeltaAt) {
        const dt = (now - cs.running.lastDeltaAt) / 1000
        if (dt > 0) cs.running.tps = Math.round(1 / dt)
      }
      cs.running.lastDeltaAt = now
      cs.context.tps = cs.running.tps
      pushStateFor(cid)
    }).then((result) => {
      r.answer = result.answer || r.answer
      r.thinking = result.thinking || r.thinking
      r.stopReason = result.stopReason
      // v0.5.bx: 捕获 mcode 返的 usage（totalTokens/inputTokens/outputTokens/thoughtTokens）
      if (result.usage) r.usage = result.usage
      r.status = 'succeeded'
      finalize()
    }).catch((e) => {
      r.status = 'failed'
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

  // v0.5.ab: 静态文件服务（/lib/* — marked、highlight.js 库）
  // v0.5.ar: 扩展为任何文件扩展名（品牌 logo 等），用白名单防止 path traversal（拒绝 .. 和 \）
  if (req.method === 'GET' && pathname !== '/' && extname(pathname)) {
    const safe = pathname.replace(/^\/+/, '').replace(/\.\./g, '').replace(/\\/g, '')
    if (safe.includes('..') || safe.includes('\\') || safe.includes('\0')) {
      res.writeHead(403); return res.end('forbidden')
    }
    const filePath = join(__dirname, 'public', safe)
    if (existsSync(filePath) && statSync(filePath).isFile()) {
      const ext = extname(filePath).toLowerCase()
      const mime = ext === '.js' ? 'application/javascript; charset=utf-8'
        : ext === '.css' ? 'text/css; charset=utf-8'
        : ext === '.json' ? 'application/json; charset=utf-8'
        : ext === '.png' ? 'image/png'
        : ext === '.svg' ? 'image/svg+xml; charset=utf-8'
        : ext === '.ico' ? 'image/x-icon'
        : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.gif' ? 'image/gif'
        : ext === '.webp' ? 'image/webp'
        : 'application/octet-stream'
      res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'public, max-age=3600' })
      return res.end(readFileSync(filePath))
    }
  }

  if (req.method === 'GET' && pathname === '/api/health') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({
      ok: true, port: PORT,
      defaultModel: DEFAULT_MODEL, defaultWorkspace: DEFAULT_WORKSPACE,
      mcodeCmd: MCODE_CMD, mcodeVersion: '0.1.2', maxConcurrent: MAX_CONCURRENT,
    }))
  }

  // v0.5.ap: 局域网访问拦截（非本地 IP + lanBroadcast 关闭时返 403）
  // 例外：/api/settings 自己（让用户能从手机关 LAN 时有路径切回）/ /api/health
  if (!lanBroadcastEnabled && !isLocalRequest(req)) {
    const isApi = pathname.startsWith('/api/')
    const isSettings = pathname === '/api/settings'  // 让用户能远程切回
    if (!isSettings) {
      if (isApi) {
        res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok: false, error: 'LAN 访问已关闭。在本机打开设置开启。' }))
      }
      // 浏览器请求：返友好 HTML 页（提示如何开启）
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>webui — 局域网访问已关闭</title>
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 560px; margin: 80px auto; padding: 24px; color: #333; line-height: 1.6; }
h1 { color: #c0392b; margin-top: 0; }
code { background: #f4f4f4; padding: 2px 6px; border-radius: 3px; font-size: 14px; }
.box { background: #fef9e7; border-left: 4px solid #f1c40f; padding: 14px 18px; border-radius: 4px; margin: 20px 0; }
</style></head><body>
<h1>🚫 局域网访问已关闭</h1>
<p>本 webui 当前<strong>仅允许本机访问</strong>，你的设备（<code>${req.socket.remoteAddress || '远程'}</code>）不在白名单内。</p>
<div class="box"><strong>如何开启：</strong><br>在本机浏览器打开 <code>http://127.0.0.1:7890/</code> → 左下角点"设置" → 开启"局域网访问"</div>
<p>或者直接用本机 URL：<code>http://127.0.0.1:7890/</code></p>
</body></html>`)
    }
  }

  // v0.5.ai: 解析 client id（每个 webui tab 一个）；SSE 路由 + state 写都按 cid 走
  const cid = getCidFromReq(req)
  const cs = getClient(cid)

  // SSE: state push stream（v0.5.ai: per-cid 路由）
  if (req.method === 'GET' && pathname === '/api/events') {
    // 关掉旧 SSE（避免同一个 cid 有多个挂起连接）
    const old = sseByCid.get(cid)
    if (old) { try { old.end() } catch {} }
    res.writeHead(200, SSE_HEADERS)
    const snapshot = { ...cs, sessions: loadSessions() }
    res.write(`data: ${JSON.stringify(snapshot)}\n\n`)
    sseByCid.set(cid, res)
    const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 20000)
    req.on('close', () => {
      clearInterval(ping)
      if (sseByCid.get(cid) === res) sseByCid.delete(cid)
      pushOnlineCount()  // v0.5.ak: 客户端断开时广播在线数
    })
    pushOnlineCount()  // v0.5.ak: 客户端新连接时广播在线数
    return
  }

  // GET /api/state — full snapshot
  // v0.5.ay: 加 sessions（之前漏了，client fetch /api/state 会覆盖 state.sessions 为 []）
  // v0.5.bu: 加 mcodeSessions（mcode acp session/list 真实数据，按 cwd 过滤）
  if (req.method === 'GET' && pathname === '/api/state') {
    const mcodeSessions = await getMcodeSessionsForWorkspace(cs.workspace && cs.workspace.dir)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ...cs, sessions: loadSessions(), mcodeSessions, availableCommands: cachedMcodeCommands, lanBroadcast: lanBroadcastEnabled }))
  }

  // v0.5.bu: GET /api/acp-sessions?cwd=... — mcode acp session/list
  // 数据源：mcode TUI 自己的 session 存储（含真实 mvs_xxx id + mcode 自动 title）
  if (req.method === 'GET' && pathname === '/api/acp-sessions') {
    const url = new URL(req.url, 'http://localhost')
    const cwd = url.searchParams.get('cwd') || (cs.workspace && cs.workspace.dir) || DEFAULT_WORKSPACE || ''
    const sessions = await getMcodeSessionsForWorkspace(cwd)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ok: true, cwd, sessions }))
  }

  // v0.5.bx: GET /api/acp-session-title?sessionId=... — 查 mcode 真实 title
  if (req.method === 'GET' && pathname === '/api/acp-session-title') {
    const url = new URL(req.url, 'http://localhost')
    const sid = url.searchParams.get('sessionId') || ''
    if (!sid) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'sessionId required' }))
    }
    const title = await getMcodeSessionTitle(sid)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ok: true, sessionId: sid, title: title || null }))
  }

  // GET /api/sessions — list
  if (req.method === 'GET' && pathname === '/api/sessions') {
    const all = loadSessions()
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ok: true, sessions: all }))
  }
  // POST /api/sessions — new
  // v0.5.ar: 接受 body.workspace — 新会话在指定工作区创建，并把 cs.workspace 切过去
  if (req.method === 'POST' && pathname === '/api/sessions') {
    let body = ''
    for await (const chunk of req) body += chunk
    let payload = {}
    try { payload = JSON.parse(body || '{}') } catch {}
    const all = loadSessions()
    const id = randomUUID()
    // v0.5.ar: 记录 session 所属工作区（用于左侧按工作区分组）
    // v0.5.bl: DEFAULT_WORKSPACE 可能是 null (v0.5.bb 改的)，不能再 .trim() — fallback 到空串
    const rawWs = payload.workspace || (cs && cs.workspace && cs.workspace.dir) || DEFAULT_WORKSPACE || ''
    const sessionWs = rawWs.trim()
    const item = { id, title: 'New session', workspace: sessionWs, createdAt: Date.now(), updatedAt: Date.now(), chat: [] }
    all.unshift(item)
    saveSessions(all)
    // v0.5.ar: 如果指定了不同的工作区，先切 cs.workspace.dir
    if (cs.workspace.dir !== sessionWs) {
      cs.workspace = { dir: sessionWs, branch: null, tree: null }
    }
    cs.sessionId = id
    cs.mcodeSessionId = null  // 新建 webui session 同时开新 mcode 上下文
    cs.sessionTitle = item.title
    cs.chat = []
    cs.usage = { ...cs.usage, sessionInput: 0, sessionOutput: 0, sessionTotal: 0 }
    resetContext(cs)
    pushStateFor(cid)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ok: true, session: item }))
  }

  // POST /api/sessions/switch — 切换到指定 session（点击 sidebar item）
  // v0.5.bv: 接受 mcode session id 查找（mvs_xxx）— 优先按 mcodeSessionId 匹配，否则按 webui sessionId
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
    // v0.5.bx: 加详细日志排查"切不过去"bug
    console.log(`[switch] cid=${cid} incoming id=${id.substring(0, 12)}… isMcodeSid=${/^mvs_[a-f0-9]{32}$/.test(id)} allTotal=${all.length}`)
    // 优先按 mcode session id 找（v0.5.bv: 1:1 关联）
    let target = all.find((s) => s.mcodeSessionId === id)
    let matchKind = target ? 'mcodeSessionId' : null
    if (!target) {
      target = all.find((s) => s.id === id)
      if (target) matchKind = 'webuiId'
    }
    console.log(`[switch] cid=${cid} match=${matchKind || 'NONE'} target.id=${target ? target.id.substring(0, 8) : 'null'}… target.mcodeSid=${target && target.mcodeSessionId ? target.mcodeSessionId.substring(0, 12) : 'null'}… target.chatLen=${target ? (target.chat ? target.chat.length : 0) : 0} target.title="${target ? (target.title || '').substring(0, 30) : ''}"`)
    if (!target) {
      // v0.5.bv: 没找到 webui session，但 mcode session 存在 → 创建 webui session 关联
      // （用户从 sidebar 点 mcode session 切过来时可能 webui 这边没存过）
      const isMcodeSid = /^mvs_[a-f0-9]{32}$/.test(id)
      if (isMcodeSid) {
        // 查 mcode 拿 title
        const title = await getMcodeSessionTitle(id) || 'Mcode session'
        const ws = (cs.workspace && cs.workspace.dir) || DEFAULT_WORKSPACE || ''
        target = {
          id: randomUUID(),
          mcodeSessionId: id,
          title,
          workspace: ws,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          chat: [],
        }
        all.unshift(target)
        saveSessions(all)
        console.log(`[switch] cid=${cid} created new webui session ${target.id.substring(0, 8)}… for mcode ${id.substring(0, 12)}… title="${title}"`)
      } else {
        console.log(`[switch] cid=${cid} 404 id=${id} not found and not mcode sid`)
        res.writeHead(404, { 'Content-Type': 'application/json' })
        return res.end(JSON.stringify({ ok: false, error: 'session not found' }))
      }
    }
    const prevSid = cs.sessionId
    const prevMcodeSid = cs.mcodeSessionId
    cs.sessionId = target.id
    cs.mcodeSessionId = target.mcodeSessionId || null  // 切到有 mcodeSessionId 的就绑上
    cs.sessionTitle = target.title || 'Untitled'
    cs.chat = Array.isArray(target.chat) ? target.chat : []
    cs.usage = { ...cs.usage, sessionInput: 0, sessionOutput: 0, sessionTotal: 0 }
    // v0.5.ar: 跨工作区 session 切换 → 同步 cs.workspace.dir
    // v0.5.bl: DEFAULT_WORKSPACE 可能是 null — fallback 到空串
    const targetWs = (target.workspace || DEFAULT_WORKSPACE || '').trim()
    if (cs.workspace.dir !== targetWs) {
      cs.workspace = { dir: targetWs, branch: null, tree: null }
    }
    resetContext(cs)
    pushStateFor(cid)
    console.log(`[switch] cid=${cid} OK prev.sessionId=${prevSid ? prevSid.substring(0, 8) : 'null'}… → new.sessionId=${cs.sessionId.substring(0, 8)}… prev.mcodeSid=${prevMcodeSid ? prevMcodeSid.substring(0, 12) : 'null'}… → new.mcodeSid=${cs.mcodeSessionId ? cs.mcodeSessionId.substring(0, 12) : 'null'}… title="${cs.sessionTitle}" chatLen=${cs.chat.length}`)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, session: { id: target.id, mcodeSessionId: cs.mcodeSessionId, title: cs.sessionTitle, chat: cs.chat } }))
  }

  // DELETE /api/sessions/:id — 删一个 session
  // v0.5.bx-5: 也接受 mcode session id (mvs_xxx) — 孤儿 webui-mcode session 的 X 按钮传的就是 mvs_xxx
  //   优先按 webui id 匹配；找不到再按 mcodeSessionId 匹配（兼容 sidebar kind='webui-mcode' 的孤儿条目）
  if (req.method === 'DELETE' && pathname.startsWith('/api/sessions/') && pathname.length > '/api/sessions/'.length) {
    const id = pathname.slice('/api/sessions/'.length)
    if (!id) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'id required' }))
    }
    console.log(`[delete] cid=${cid} incoming id=${id.substring(0, 12)}… isMcodeSid=${/^mvs_[a-f0-9]{32}$/.test(id)}`)
    const all = loadSessions()
    let idx = all.findIndex((s) => s.id === id)
    let matchKind = idx >= 0 ? 'webuiId' : null
    if (idx < 0) {
      idx = all.findIndex((s) => s.mcodeSessionId === id)
      if (idx >= 0) matchKind = 'mcodeSessionId'
    }
    if (idx < 0) {
      console.log(`[delete] cid=${cid} 404 id=${id.substring(0, 12)}… not found (by webuiId or mcodeSessionId)`)
      res.writeHead(404, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'session not found' }))
    }
    const deletedItem = all[idx]
    all.splice(idx, 1)
    saveSessions(all)
    // v0.5.bx-5: 当前会话可能是被删的 webui session，也可能是它的 mcode sibling
    if (cs.sessionId === id || cs.mcodeSessionId === id) {
      cs.sessionId = null
      cs.mcodeSessionId = null
      cs.sessionTitle = 'Untitled'
      cs.chat = []
      cs.usage = { ...cs.usage, sessionInput: 0, sessionOutput: 0, sessionTotal: 0 }
      resetContext(cs)
    }
    pushStateFor(cid)
    console.log(`[delete] cid=${cid} OK match=${matchKind} deleted.webuiId=${deletedItem.id.substring(0, 8)}… deleted.mcodeSid=${deletedItem.mcodeSessionId ? deletedItem.mcodeSessionId.substring(0, 12) : 'null'}… title="${(deletedItem.title || '').substring(0, 30)}" remaining=${all.length}`)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ok: true, deleted: id, matchKind, remaining: all.length }))
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

  // v0.5.bk: POST /api/set-model — 只更新 cs.model（不发 mcode /model 命令，不创建 session）
  // 解决"欢迎页点 model 选个候选项就新开对话 + 展开侧栏 + mcode 报 invalid params"的问题
  if (req.method === 'POST' && pathname === '/api/set-model') {
    let body = ''
    for await (const chunk of req) body += chunk
    let payload
    try { payload = JSON.parse(body || '{}') } catch { payload = {} }
    const modelId = (payload.model || '').trim()
    if (!modelId) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'model required' }))
    }
    // v0.5.bk: 只更新 cs.model.name，不发 mcode 命令（避免 /model invalid params）
    cs.model = cs.model || {}
    cs.model.name = modelId
    pushStateFor(cid)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ok: true, model: modelId, note: '仅更新本地状态，mcode session 创建时会用此 model' }))
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

    // v0.5.ai: per-cid — 操作 cs
    cs.chat = [...(cs.chat || []), `› ${content}`]
    pushStateFor(cid)
    persistCurrentChat(cs)

    // v0.5.ak: 发首条消息时如果 cs.sessionId 为空，先建一个 webui session entry
    //   之前 persistCurrentChat 在 sessionId==null 时 early return，session 永远不入库
    if (!cs.sessionId) {
      const all = loadSessions()
      const id = randomUUID()
      const item = { id, title: 'New session', createdAt: Date.now(), updatedAt: Date.now(), chat: cs.chat || [] }
      all.unshift(item)
      saveSessions(all)
      cs.sessionId = id
    }

    // v0.5.bx: 不再立即用首条内容给 session 改名（v0.5.x 的"前 50 字截断"被 Ponkan 嫌"取完整第一句话"）
    // 让 mcode finalize 时通过 getMcodeSessionTitle 拉真实自动 title
    // — 那边有 30s cache + mcode 自己的总结算法（"Ponkan 自我介绍" / "用 glob 统计 .js 文件数量" 等）

    // Detect slash commands that we can satisfy without spawning mcode
    const slashMatch = content.match(/^\/(\w+)\b\s*(.*)/)
    if (slashMatch) {
      const cmd = slashMatch[1]
      const rest = slashMatch[2] || ''
      if (cmd === 'clear' || cmd === 'new') {
        if (cmd === 'new') {
          const all = loadSessions()
          const id = randomUUID()
          const item = { id, title: 'New session', createdAt: Date.now(), updatedAt: Date.now(), chat: [] }
          all.unshift(item)
          saveSessions(all)
          cs.sessionId = id
          cs.sessionTitle = item.title
        } else {
          cs.chat = []
          persistCurrentChat(cs)
        }
        cs.chat = []
        cs.usage = { ...cs.usage, sessionInput: 0, sessionOutput: 0, sessionTotal: 0 }
        if (cmd === 'new') {
          cs.mcodeSessionId = null
          cs.sessionTitle = 'New session'
        } else {
          cs.mcodeSessionId = null
          cs.sessionTitle = 'Untitled'
        }
        resetContext(cs)
        pushStateFor(cid)
        return
      }
      if (cmd === 'status') {
        const t = `● 当前 model=${cs.model.name}\n  workspace=${cs.workspace.dir}\n  权限=${cs.permissions}`
        cs.chat = [...cs.chat, t]
        pushStateFor(cid)
        return
      }
      if (cmd === 'usage' || cmd === 'sessions' || cmd === 'help') {
        if (cmd === 'sessions') {
          const all = loadSessions()
          const t = `● 最近 ${all.length} 个会话：\n` + all.slice(0, 8).map((s, i) => `  ${i+1}. ${s.title} (${s.id.substring(0, 8)}…)`).join('\n')
          cs.chat = [...cs.chat, `› /sessions`, t]
          pushStateFor(cid)
          persistCurrentChat(cs)
          return
        }
        if (cmd === 'help') {
          // v0.5.ak: 真实命令（webui 本地 + mcode 真实支持），lazy init
          const cmds = await ensureMcodeCommands()
          const lines = ['● 可用命令：']
          for (const c of cmds.webui) lines.push(`  /${c.name} — ${c.desc}`)
          if (Array.isArray(cmds.mcode) && cmds.mcode.length > 0) {
            for (const c of cmds.mcode) {
              if (typeof c === 'string') lines.push(`  /${c}`)
              else if (c && c.name) lines.push(`  /${c.name}${c.description ? ' — ' + c.description : ''}`)
            }
          } else if (cmds.source && cmds.source.startsWith('error')) {
            lines.push(`  (mcode 命令拉取失败：${cmds.source.slice(7)})`)
          } else {
            lines.push(`  (mcode 命令待拉取…)`)
          }
          const t = lines.join('\n')
          cs.chat = [...cs.chat, `› /help`, t]
          pushStateFor(cid)
          persistCurrentChat(cs)
          return
        }
        if (cmd === 'usage') {
          await runUsageQuery(cs, cid)
          return
        }
      }
      // 其他命令走 mcode exec
    }

    // v0.5.ah: 走 mcode acp 协议（默认）— MCODE_USE_ACP=0 切回 mcode exec 逃生
    // v0.5.ai: per-cid — 传 cs+cid
    // v0.5.bm: 详细日志 — 看到 mcode 收到了什么，返回了什么
    const modelToUse = (cs && cs.model && cs.model.name) || DEFAULT_MODEL
    console.log(`[send] cid=${cid} content=${JSON.stringify(content.slice(0, 80))} model=${modelToUse} sessionId=${cs.mcodeSessionId} workspace=${(cs && cs.workspace && cs.workspace.dir) || 'null'}`)
    const t0 = Date.now()
    const r = process.env.MCODE_USE_ACP === '0'
      ? await collectExecResult(runMcodeExec(content, { label: 'prompt', sessionId: cs.mcodeSessionId, model: modelToUse, cs, cid }))
      : await runMcodeAcp(content, { label: 'prompt', sessionId: cs.mcodeSessionId, model: modelToUse, cs, cid })
    console.log(`[send] result ${Date.now() - t0}ms:`, JSON.stringify({ status: r.status, error: r.error, answer: r.answer && r.answer.slice(0, 80), sessionId: r.sessionId }).slice(0, 500))
    if (r.status === 'succeeded' && r.answer) {
      // v0.5.bx-4: 流式输出已经在 streamAcpPrompt/streamUpdateLine 里把 ▲ 和 ● 行写进 chat 了
      // 这里不再 append，避免重复（同一条回复显示两次）
      // 边界情况：切到老 session（chat 含历史 ● 行）后再发消息，findLast 找最近一个 ● 行就地替换
      const oneLine = r.answer.replace(/\n+/g, ' ').trim()
      // 找最近的 ● 行（不是看 chat 末尾，因为中间可能有 tool 行 / ▲ 行）
      let lastAnsIdx = -1
      for (let i = cs.chat.length - 1; i >= 0; i--) {
        if (typeof cs.chat[i] === 'string' && cs.chat[i].startsWith('● ')) { lastAnsIdx = i; break }
      }
      if (lastAnsIdx >= 0) {
        cs.chat[lastAnsIdx] = `● ${oneLine}`
      } else {
        cs.chat = [...cs.chat, `● ${oneLine}`]
      }
      cs.context.assistantLast = oneLine
      cs.context.assistantAt = Date.now()
    } else if (r.status === 'failed' || r.error) {
      const rawMsg = (r.error?.message || r.status).replace(/\n+/g, ' ')
      let oneLine = rawMsg
      let hint = ''
      if (/Questionnaire|user input/i.test(rawMsg)) {
        hint = ' (Ask 工具在 webui/exec 模式不可用，请直接用输入框发问)'
      } else if (/requires.*input|interactive/i.test(rawMsg)) {
        hint = ' (此工具需要交互模式，webui 暂不支持)'
      }
      cs.chat = [...cs.chat, `! [error] ${oneLine}${hint}`]
      cs.context.assistantLast = `[error] ${oneLine}`
      cs.context.assistantAt = Date.now()
    }
    persistCurrentChat(cs)  // 把刚追加的 assistant 消息写进 db
    pushStateFor(cid)
    return
  }

  // POST /api/usage — trigger mcode exec /usage, parse output, push state
  if (req.method === 'POST' && (pathname === '/api/usage' || pathname === '/api/usage-trigger')) {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true }))
    await runUsageQuery(cs, cid)
    return
  }

  // v0.5.bj: GET /api/models — 数据源：mcode 自带的 cli.js bundle（不是 webui 硬编码）
  if (req.method === 'GET' && pathname === '/api/models') {
    const list = []
    const builtins = getBuiltinModelsFromMcode()
    // 当前 cs 的 model.name 形如 minimax_api/MiniMax-M3，提取 provider 部分
    const currentName = (cs.model && cs.model.name) || ''
    const currentProvider = currentName.includes('/') ? currentName.split('/')[0] : 'minimax_api'
    for (const m of builtins) {
      list.push({ id: `${currentProvider}/${m}`, label: m, provider: currentProvider })
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({
      ok: true, models: list,
      current: currentName || DEFAULT_MODEL,
      source: 'mcode-cli-bundle'  // 调试用：让用户知道数据来源
    }))
  }

  // POST /api/refresh — noop (we already push state on demand). html calls this every 60s.
  if (req.method === 'POST' && pathname === '/api/refresh') {
    pushStateFor(cid)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ok: true }))
  }

  // POST /api/permissions — v0.5.x: 更新 webui 端的权限模式显示
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
    cs.permissions = label
    pushStateFor(cid)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, permissions: label }))
  }

  // POST /api/workspace — v0.5.al: per-cid 切换 workspace
  // body: {dir, syncTui?, saveRecent?}
  //   dir: 绝对路径（必须是存在的目录）
  //   syncTui: true 时同时写 ~/.minimax/runtime/cwd.json（让 mcode TUI 也看到新 cwd）
  //   saveRecent: true 时（默认 true）把 dir 加到 localStorage recents
  if (req.method === 'POST' && pathname === '/api/workspace') {
    let body = ''
    for await (const chunk of req) body += chunk
    let payload
    try { payload = JSON.parse(body || '{}') } catch { payload = {} }
    const action = payload.action || 'set'  // 'set' | 'useTui' | 'reset' | 'detect'
    let target = null
    if (action === 'useTui') {
      target = detectTuiCwd()
      if (!target) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok: false, error: 'mcode TUI 还没启动过，没有 cwd 记录' }))
      }
    } else if (action === 'reset') {
      target = DEFAULT_WORKSPACE
    } else if (action === 'detect') {
      // 只探测 TUI cwd，不修改 cs（前端想看到当前 TUI 在哪）
      const tui = detectTuiCwd()
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ ok: true, tuiCwd: tui, defaultWorkspace: DEFAULT_WORKSPACE, current: cs.workspace.dir }))
    } else {
      target = payload.dir
    }
    if (!target || typeof target !== 'string') {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ ok: false, error: 'dir 不能为空' }))
    }
    // 校验目录存在
    if (!existsSync(target) || !statSync(target).isDirectory()) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ ok: false, error: `目录不存在: ${target}` }))
    }
    const absDir = resolve(target)
    // 写到 cs
    cs.workspace = { dir: absDir, branch: null, tree: null }
    // 可选：同步 mcode TUI（写 cwd.json，下次 TUI 启动会看到新 cwd）
    if (payload.syncTui) {
      try {
        const cwdFile = join(homedir(), '.minimax', 'runtime', 'cwd.json')
        mkdirSync(dirname(cwdFile), { recursive: true })
        writeFileSync(cwdFile, JSON.stringify({ cwd: absDir, updatedAt: Date.now() }, null, 2), 'utf8')
      } catch (e) {
        console.warn(`[webui] sync cwd.json failed: ${e.message}`)
      }
    }
    pushStateFor(cid)
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ok: true, workspace: cs.workspace, tuiCwd: detectTuiCwd(), defaultWorkspace: DEFAULT_WORKSPACE }))
  }

  // GET /api/workspace/browse — v0.5.am: 列出目录下的子目录（仅目录，懒加载给前端树用）
  // query: ?path=<absolute>  (省略时返回根盘符 / 根目录)
  if (req.method === 'GET' && pathname === '/api/workspace/browse') {
    const url = new URL(req.url, `http://${req.headers.host}`)
    const rawPath = url.searchParams.get('path')
    const MAX = 500  // 单层最多返回 500 个子目录，避免 huge dirs 把前端卡死
    let target, parent, roots = null
    try {
      if (!rawPath) {
        // 没传 path → 返回根盘符（Windows: C:\ D:\ 等；其他: /）
        if (process.platform === 'win32') {
          // 探测 A-Z 盘符
          const found = []
          for (let c = 65; c <= 90; c++) {
            const letter = String.fromCharCode(c) + ':\\'
            try { if (existsSync(letter) && statSync(letter).isDirectory()) found.push(letter) } catch {}
          }
          if (found.length === 0) found.push('C:\\')
          roots = found
          target = null
        } else {
          target = '/'
        }
      } else {
        target = resolve(rawPath)
        if (!existsSync(target) || !statSync(target).isDirectory()) {
          res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ ok: false, error: `目录不存在: ${rawPath}` }))
        }
        // parent
        const parentPath = dirname(target)
        parent = (parentPath === target) ? null : parentPath
      }
      const children = []
      if (target) {
        let entries
        try { entries = readdirSync(target, { withFileTypes: true }) } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          return res.end(JSON.stringify({ ok: false, error: `无法读取: ${e.message}` }))
        }
        // 只列目录；按字母序；跳过权限错误
        const dirs = []
        let skipped = 0
        for (const ent of entries) {
          if (dirs.length >= MAX) { skipped++; continue }
          try {
            // ent.isDirectory() 在某些 win32 长路径/重解析点会 false；用 statSync 二次确认
            if (ent.isDirectory()) {
              dirs.push({ name: ent.name, path: join(target, ent.name) })
            }
          } catch { skipped++ }
        }
        dirs.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans'))
        children.push(...dirs)
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok: true, dir: target, parent, children, skipped, total: dirs.length }))
      } else {
        // roots
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok: true, dir: null, parent: null, roots, children: [] }))
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({ ok: false, error: e.message }))
    }
  }

  // v0.5.ap: /api/settings — 查看 / 修改服务设置（LAN 开关等）
  // 注：/api/settings 不受 LAN 拦截（middleware 例外），让用户能远程切回
  if (pathname === '/api/settings') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({
        ok: true,
        lanBroadcast: lanBroadcastEnabled,
        port: PORT,
        host: HOST,
        lanIp: LAN_IP,
        lanUrl: `http://${LAN_IP}:${PORT}`,
        localUrl: `http://127.0.0.1:${PORT}`,
        mcodeCmd: MCODE_CMD,
        mcodeVersion: '0.1.2',
        defaultWorkspace: DEFAULT_WORKSPACE,
        defaultModel: DEFAULT_MODEL,
      }))
    }
    if (req.method === 'POST') {
      let body = ''
      for await (const chunk of req) body += chunk
      let payload
      try { payload = JSON.parse(body || '{}') } catch { payload = {} }
      let changed = false
      if (typeof payload.lanBroadcast === 'boolean' && payload.lanBroadcast !== lanBroadcastEnabled) {
        lanBroadcastEnabled = payload.lanBroadcast
        changed = true
        console.log(`[webui] LAN access ${lanBroadcastEnabled ? 'enabled' : 'disabled'}`)
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify({
        ok: true,
        changed,
        lanBroadcast: lanBroadcastEnabled,
        port: PORT, host: HOST, lanIp: LAN_IP,
        lanUrl: `http://${LAN_IP}:${PORT}`,
        localUrl: `http://127.0.0.1:${PORT}`,
      }))
    }
  }

  // POST /api/stop — 中断正在跑的 mcode exec（前端 stop 按钮用）
  // v0.5.ai: per-cid — 找当前 cid 的 child
  if (req.method === 'POST' && pathname === '/api/stop') {
    const child = activeChildByCid.get(cid)
    const wasRunning = !!child
    if (child) {
      try { child.kill() } catch {}
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ ok: true, wasRunning }))
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
      // v0.5.ak: mcode 还在跑时禁止清空 chat（onChunk 写的是同一个 cs 对象，会污染新 session 显示）
      if (cs.running && cs.running.active) {
        cs.chat = [...(cs.chat || []), `! [warn] AI 还在回复中，先停止当前任务再新建会话`]
        pushStateFor(cid)
        return
      }
      // v0.5.ak: 避免 0 对话下无限新建 — 当前是默认空 session 时直接复用
      const isEmpty = !cs.chat || cs.chat.length === 0
      const isDefaultTitle = !cs.sessionTitle || cs.sessionTitle === 'Untitled' || cs.sessionTitle === 'New session'
      if (cs.sessionId && isEmpty && isDefaultTitle) {
        // 已经在空 session 里 — 不创建新的，只 push state 让前端知道还在
        pushStateFor(cid)
        return
      }
      const all = loadSessions()
      const id = randomUUID()
      const item = { id, title: 'New session', createdAt: Date.now(), updatedAt: Date.now(), chat: [] }
      all.unshift(item)
      saveSessions(all)
      cs.sessionId = id
      cs.mcodeSessionId = null
      cs.sessionTitle = item.title
      cs.chat = []
      cs.usage = { ...cs.usage, sessionInput: 0, sessionOutput: 0, sessionTotal: 0 }
      resetContext(cs)
      pushStateFor(cid)
      return
    }
    if (cmd === '/status') {
      const t = `● 当前 model=${cs.model.name}\n  workspace=${cs.workspace.dir}\n  权限=${cs.permissions}`
      cs.chat = [...(cs.chat || []), `› /status`, t]
      pushStateFor(cid)
      persistCurrentChat(cs)
      return
    }
    if (cmd === '/clear') {
      cs.chat = []
      cs.usage = { ...cs.usage, sessionInput: 0, sessionOutput: 0, sessionTotal: 0 }
      cs.mcodeSessionId = null
      cs.sessionTitle = 'Untitled'
      resetContext(cs)
      persistCurrentChat(cs)  // 把清空写回 db
      pushStateFor(cid)
      return
    }
    if (cmd === '/sessions') {
      const all = loadSessions()
      const t = `● 最近 ${all.length} 个会话：\n` + all.slice(0, 8).map((s, i) => `  ${i+1}. ${s.title} (${s.id.substring(0, 8)}…)`).join('\n')
      cs.chat = [...(cs.chat || []), `› /sessions`, t]
      pushStateFor(cid)
      persistCurrentChat(cs)
      return
    }
    if (cmd === '/help') {
      // v0.5.ak: 真实命令（webui 本地 + mcode 真实支持），lazy init mcode 命令缓存
      const cmds = await ensureMcodeCommands()
      const lines = ['● 可用命令：']
      for (const c of cmds.webui) lines.push(`  /${c.name} — ${c.desc}`)
      if (Array.isArray(cmds.mcode) && cmds.mcode.length > 0) {
        for (const c of cmds.mcode) {
          if (typeof c === 'string') lines.push(`  /${c}`)
          else if (c && c.name) lines.push(`  /${c.name}${c.description ? ' — ' + c.description : ''}`)
        }
      } else if (cmds.source && cmds.source.startsWith('error')) {
        lines.push(`  (mcode 命令拉取失败：${cmds.source.slice(7)})`)
      } else {
        lines.push(`  (mcode 命令待拉取，第一次 /help 时已触发…)`)
      }
      const t = lines.join('\n')
      cs.chat = [...(cs.chat || []), `› /help`, t]
      pushStateFor(cid)
      persistCurrentChat(cs)
      return
    }
    if (cmd === '/usage') {
      await runUsageQuery(cs, cid)
      return
    }
    if (cmd === '/stop') {
      const child = activeChildByCid.get(cid)
      const wasRunning = !!child
      if (child) {
        try { child.kill() } catch {}
      }
      const t = wasRunning ? `● 已发送停止信号` : `● 没有正在运行的任务`
      cs.chat = [...(cs.chat || []), `› /stop`, t]
      pushStateFor(cid)
      persistCurrentChat(cs)
      return
    }
    // 未知命令：忽略
    return
  }

  // v0.5.aj: debug inject — mock state 字段给浏览器测 UI 渲染
  // 必须 DEBUG_INJECT=1 env 才启用（默认关）。不碰 mcode runtime。
  // body: { goal?: {...}, todo?: [...], ask?: {...}, plan?: {...}, enterPlanMode?: {...}, appendChat?: [...行字符串] }
  if (req.method === 'POST' && pathname === '/api/debug/inject') {
    if (process.env.DEBUG_INJECT !== '1') {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'DEBUG_INJECT not enabled (set DEBUG_INJECT=1 env to use)' }))
    }
    let body = ''
    for await (const chunk of req) body += chunk
    let payload
    try { payload = JSON.parse(body || '{}') } catch { payload = {} }
    const applied = {}
    if (payload.goal && typeof payload.goal === 'object') {
      cs.goal = { ...cs.goal, ...payload.goal }
      applied.goal = true
    }
    if (Array.isArray(payload.todo)) {
      cs.todo = payload.todo
      applied.todoCount = cs.todo.length
    }
    if (payload.ask && typeof payload.ask === 'object') {
      cs.ask = { ...cs.ask, ...payload.ask }
      applied.ask = true
    }
    if (payload.plan && typeof payload.plan === 'object') {
      cs.plan = { ...cs.plan, ...payload.plan }
      applied.plan = true
    }
    if (payload.enterPlanMode && typeof payload.enterPlanMode === 'object') {
      cs.enterPlanMode = { ...cs.enterPlanMode, ...payload.enterPlanMode }
      applied.enterPlanMode = true
    }
    if (Array.isArray(payload.appendChat)) {
      cs.chat = [...(cs.chat || []), ...payload.appendChat]
      applied.appendedChatLines = payload.appendChat.length
    }
    pushStateFor(cid)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: true, applied, cid }))
  }

  // v0.5.aj: debug inspect — 看当前 cs 的 goal/todo/ask/chat
  if (req.method === 'GET' && pathname === '/api/debug/state') {
    if (process.env.DEBUG_INJECT !== '1') {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'DEBUG_INJECT not enabled' }))
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({
      ok: true,
      goal: cs.goal,
      todoCount: (cs.todo || []).length,
      ask: cs.ask,
      plan: cs.plan,
      enterPlanMode: cs.enterPlanMode,
      chatLast5: (cs.chat || []).slice(-5),
    }))
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
  console.log(`[webui] LAN url: http://${LAN_IP}:${PORT}`)
  console.log(`[webui] mcode cmd: ${MCODE_CMD}`)
  console.log(`[webui] default model: ${DEFAULT_MODEL}`)
  console.log(`[webui] default workspace: ${DEFAULT_WORKSPACE}`)
  console.log(`[webui] uploads: ${UPLOAD_DIR}`)
  console.log(`[webui] sessions: ${SESSIONS_DB}`)
})