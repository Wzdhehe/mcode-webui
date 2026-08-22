// webui/server/lib/state-bus.js
// Per-cid state + SSE channel management.

import { DEFAULT_WORKSPACE, DEFAULT_MODEL } from './config.js'
import { loadSessions } from './sessions.js'
import { getCachedMcodeCommands } from './acp-client.js'

// v0.5.ai: A2 per-client 架构
// 每个 webui tab 一个 client (cid = localStorage webui_cid)
// 每个 client 独立：state (chat/mcodeSessionId/context/usage/running), activeChild, SSE connection
// 缺 cid 的请求 fallback 到 'default' client (兼容老 client)

// v0.5.ai: 每个 webui tab 一个独立 state。
export function makeClientState() {
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

export const clients = new Map()            // cid -> clientState
export const sseByCid = new Map()           // cid -> SSE response
export const activeChildByCid = new Map()   // cid -> child process

export function getClient(cid) {
  if (!cid) cid = 'default'
  if (!clients.has(cid)) clients.set(cid, makeClientState())
  return clients.get(cid)
}

export function getCidFromReq(req) {
  try {
    const u = new URL(req.url, 'http://x')
    return u.searchParams.get('cid') || ''
  } catch {
    return ''
  }
}

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
}

// pushStateFor: 推 state 给指定 cid（或 '__broadcast__' 推给所有）
//   opts.lanBroadcast: 当前 LAN 广播状态（从 settings.js 注入）
//   opts.mcodeSessions: 已过滤的 mcode sessions 数组（从 acp-client.js 注入）
export function pushStateFor(cid, opts = {}) {
  const lanBroadcast = opts.lanBroadcast
  const cachedCmds = getCachedMcodeCommands()
  const mcodeSessions = opts.mcodeSessions !== undefined ? opts.mcodeSessions : null

  if (cid === '__broadcast__') {
    for (const [c, res] of sseByCid) {
      const cs = clients.get(c) || makeClientState()
      const snapshot = {
        ...cs,
        sessions: loadSessions(),
        availableCommands: cachedCmds,
        onlineCount: sseByCid.size,
        lanBroadcast,
      }
      try { res.write(`data: ${JSON.stringify(snapshot)}\n\n`) } catch {}
    }
    return
  }
  const cs = getClient(cid)
  // 注入 sessions 列表（来自磁盘 db）— 让 webui 侧边栏 "最近会话" 不被 SSE 推送覆盖
  // v0.5.bv: 同步带 mcodeSessions（cache 命中，0 cost；cache miss 才 await）
  const snapshot = {
    ...cs,
    sessions: loadSessions(),
    mcodeSessions,
    availableCommands: cachedCmds,
    onlineCount: sseByCid.size,
    lanBroadcast,
  }
  const payload = JSON.stringify(snapshot)
  const res = sseByCid.get(cid)
  if (res) { try { res.write(`data: ${payload}\n\n`) } catch {} }
}

// v0.5.ak: SSE 客户端数变化时广播（让所有 tab 实时看到 onlineCount）
export function pushOnlineCount(lanBroadcast) {
  const cachedCmds = getCachedMcodeCommands()
  for (const [c, res] of sseByCid) {
    const cs = clients.get(c) || makeClientState()
    const snapshot = {
      ...cs,
      sessions: loadSessions(),
      availableCommands: cachedCmds,
      onlineCount: sseByCid.size,
      lanBroadcast,
    }
    try { res.write(`data: ${JSON.stringify(snapshot)}\n\n`) } catch {}
  }
}

// 把当前 cid 的 child 设为 active（acp client / exec child 都用同一个 map）
export function setActiveChild(cid, child) {
  if (cid) activeChildByCid.set(cid, child)
}

export function getActiveChild(cid) {
  return activeChildByCid.get(cid) || null
}

export function clearActiveChild(cid) {
  if (cid) activeChildByCid.delete(cid)
}

// v0.5.bx-29: 找出所有绑定了同一个 mcodeSessionId 的 cid
//   用于 mavis db 真值更新后, 通知其它同 session 的 cid (手机 + 电脑开同一 session)
//   返回 [{cid, cs}, ...] 数组
export function getCidsByMcodeSession(mvsSessionId) {
  if (!mvsSessionId) return []
  const out = []
  for (const [cid, cs] of clients) {
    if (cs && cs.mcodeSessionId === mvsSessionId) {
      out.push({ cid, cs })
    }
  }
  return out
}

// SSE channel helpers — only state-bus.js should touch sseByCid directly.
export function getSseClient(cid) {
  return sseByCid.get(cid) || null
}

export function setSseClient(cid, res) {
  sseByCid.set(cid, res)
}

export function endSseClient(cid, res) {
  // Only clear the map entry if it still points at the same res (avoid races)
  if (sseByCid.get(cid) === res) sseByCid.delete(cid)
}