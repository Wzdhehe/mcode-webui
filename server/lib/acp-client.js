// webui/server/lib/acp-client.js
// ACP client singleton + command/session cache.
// Does NOT replace acp.mjs (which is the JSON-RPC transport).
// Wraps it with caching/lifecycle for webui use.

import { McodeAcpClient } from '../../acp.mjs'
import { DEFAULT_WORKSPACE } from './config.js'

// v0.5.bu: 拉 mcode 真实 session 列表（mcode acp session/list 协议）
// 数据源：mcode TUI 自己的 session 存储（不是 webui 的 .webui-sessions.json）
// 按 cwd 过滤（mcode 每个 session 都有 cwd 字段，匹配 cs.workspace.dir 才显示）
let mcodeSessionsCache = { ws: null, sessions: [], fetchedAt: 0 }

// v0.5.bx-19: mcode acp client 单例后台常驻 — 之前每次 getMcodeSessionsForWorkspace cache miss 都
//   new McodeAcpClient + start + list + stop, 切 session 频繁触发, 2-3 个 mcode 子进程并发, CPU 高
//   单例常驻后, 切 session 只走 30s cache hit, 0 spawn
let _mcodeAcpSingleton = null
let _mcodeAcpInitPromise = null  // 防止并发 init 同一个 client

export async function getMcodeAcpClient() {
  if (_mcodeAcpSingleton && _mcodeAcpSingleton.alive) return _mcodeAcpSingleton
  if (_mcodeAcpInitPromise) return _mcodeAcpInitPromise
  _mcodeAcpInitPromise = (async () => {
    const client = new McodeAcpClient({ debug: false })
    try {
      await client.start()
      _mcodeAcpSingleton = client
      console.log(`[acp] singleton client started pid=${client.pid || '?'}`)
      return client
    } catch (e) {
      console.warn(`[acp] singleton start failed: ${e.message}`)
      try { client.stop() } catch {}
      return null
    } finally {
      _mcodeAcpInitPromise = null
    }
  })()
  return _mcodeAcpInitPromise
}

// v0.5.bx-19 (改 #2): 列出所有 mcode session (跨 workspace), 不做 cwd 过滤
//   之前 getMcodeSessionsForWorkspace 内部用同一个 cache, 但 cleanup 需要列所有
//   这函数绕过 cwd 过滤, 走 mcode acp 直接拿 raw 列表
export async function listAllMcodeSessions() {
  const client = await getMcodeAcpClient()
  if (!client) return []
  try {
    const r = await client.listSessions()
    return (r && Array.isArray(r.sessions)) ? r.sessions : []
  } catch (e) {
    console.warn(`[acp] listAllMcodeSessions failed: ${e.message}`)
    if (_mcodeAcpSingleton === client) _mcodeAcpSingleton = null
    return []
  }
}

export async function getMcodeSessionsForWorkspace(workspace) {
  const STALE_MS = 30 * 1000  // 30s — 比 commands 的 5min 短，因为 prompt 后要立即刷新
  const now = Date.now()
  if (mcodeSessionsCache.ws === workspace && (now - mcodeSessionsCache.fetchedAt) < STALE_MS) {
    return mcodeSessionsCache.sessions
  }
  const all = await listAllMcodeSessions()
  // 按 cwd 过滤（normalize path — windows 大小写不敏感 + 去尾斜杠）
  const norm = (p) => (p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const target = norm(workspace)
  const filtered = target ? all.filter(s => norm(s.cwd) === target) : all
  mcodeSessionsCache = { ws: workspace, sessions: filtered, fetchedAt: now }
  return filtered
}

// v0.5.bx: prompt 完成后用 mcodeSessionId 反查 mcode 真实 title
// 数据源：mcode TUI 自己的 session 存储（不是 webui 的）
// 用途：替换 webui "New session" / 截断首句 → 用 mcode 自动生成的标题
export async function getMcodeSessionTitle(mcodeSessionId) {
  if (!mcodeSessionId) return null
  const client = await getMcodeAcpClient()
  if (!client) return null
  try {
    const r = await client.listSessions()
    const all = (r && Array.isArray(r.sessions)) ? r.sessions : []
    const hit = all.find(s => s.sessionId === mcodeSessionId)
    return hit && hit.title ? hit.title : null
  } catch (e) {
    console.warn(`[acp] getMcodeSessionTitle failed: ${e.message}`)
    if (_mcodeAcpSingleton === client) _mcodeAcpSingleton = null
    return null
  }
}

// v0.5.bx-19: 软失效 — 只让 TTL 立即过期, 保留 cached sessions (这样切 session 不阻塞)
export function invalidateMcodeSessionsCache() {
  mcodeSessionsCache = { ...mcodeSessionsCache, fetchedAt: 0 }
}

// v0.5.bx-19: 进程退出时关掉 singleton mcode acp (避免僵尸)
export function shutdownMcodeAcpSingleton() {
  if (_mcodeAcpSingleton) {
    try { _mcodeAcpSingleton.stop() } catch {}
    _mcodeAcpSingleton = null
  }
}

// ============================================================
// v0.5.ak: mcode 真实命令缓存（不套预设）
// 用一个长寿命 McodeAcpClient lazy init 拉 available_commands_update
// /help 读这里，不用 hardcode 列表
// ============================================================
let cachedMcodeCommands = { mcode: [], webui: [], fetchedAt: 0, source: 'none' }
export const WEBUI_LOCAL_COMMANDS = [
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

export function getCachedMcodeCommands() { return cachedMcodeCommands }

export async function ensureMcodeCommands({ forceRefresh = false, onRefresh } = {}) {
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
      if (typeof onRefresh === 'function') onRefresh()
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