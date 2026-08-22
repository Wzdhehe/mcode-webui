// webui/server/routes/sessions.js
// GET/POST /api/sessions, POST /api/sessions/switch, DELETE /api/sessions/:id,
// POST /api/sessions/cleanup-orphans, GET /api/acp-sessions, GET /api/acp-session-title

import { randomUUID } from 'node:crypto'
import { loadSessions, saveSessions, resetContext } from '../lib/sessions.js'
import { deleteMcodeSessionFromDb } from '../lib/db.js'
import { listAllMcodeSessions, getMcodeSessionTitle, getMcodeSessionsForWorkspace, invalidateMcodeSessionsCache } from '../lib/acp-client.js'
import { applyMavisUsageToCs } from '../lib/mavis-usage.js'
import { getMcodeModelLimit } from '../lib/models.js'
import { pushStateFor } from '../lib/state-bus.js'

// 读 body helper
async function readJson(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  try { return JSON.parse(body || '{}') } catch { return {} }
}

// GET /api/sessions — list
export function handleListSessions(_req, res) {
  const all = loadSessions()
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  return res.end(JSON.stringify({ ok: true, sessions: all }))
}

// POST /api/sessions — new (accepts body.workspace)
export async function handleNewSession(req, res, ctx) {
  const cs = ctx.cs
  const cid = ctx.cid
  const payload = await readJson(req)
  const all = loadSessions()
  const id = randomUUID()
  // v0.5.ar: 记录 session 所属工作区
  // v0.5.bl: DEFAULT_WORKSPACE 可能是 null — fallback 到空串
  const rawWs = payload.workspace || (cs && cs.workspace && cs.workspace.dir) || ''
  const sessionWs = (rawWs || '').trim()
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

// POST /api/sessions/switch — switch to session by webui id or mvs_xxx
export async function handleSwitchSession(req, res, ctx) {
  const cs = ctx.cs
  const cid = ctx.cid
  const payload = await readJson(req)
  const id = (payload.id || '').trim()
  if (!id) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: false, error: 'id required' }))
  }
  const all = loadSessions()
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
    const isMcodeSid = /^mvs_[a-f0-9]{32}$/.test(id)
    if (isMcodeSid) {
      const title = await getMcodeSessionTitle(id) || 'Mcode session'
      const ws = (cs.workspace && cs.workspace.dir) || ''
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
  const targetWs = (target.workspace || '').trim()
  if (cs.workspace.dir !== targetWs) {
    cs.workspace = { dir: targetWs, branch: null, tree: null }
  }
  resetContext(cs)
  // v0.5.bx-10: 切到历史 session 时立即从 mavis db 拉真实 token usage
  if (cs.mcodeSessionId) {
    const switchedSid = cs.mcodeSessionId
    applyMavisUsageToCs(cs, switchedSid, { getMcodeModelLimit })
      .then(() => pushStateFor(cid))
      .catch((e) => {
        if (process.env.MCODE_USAGE_DEBUG) console.warn(`[switch.mavis] cid=${cid} error: ${e.message}`)
      })
  }
  pushStateFor(cid)
  console.log(`[switch] cid=${cid} OK prev.sessionId=${prevSid ? prevSid.substring(0, 8) : 'null'}… → new.sessionId=${cs.sessionId.substring(0, 8)}… title="${cs.sessionTitle}" chatLen=${cs.chat.length}`)
  res.writeHead(200, { 'Content-Type': 'application/json' })
  return res.end(JSON.stringify({ ok: true, session: { id: target.id, mcodeSessionId: cs.mcodeSessionId, title: cs.sessionTitle, chat: cs.chat } }))
}

// DELETE /api/sessions/:id — 删一个 session
export function handleDeleteSession(req, res, ctx) {
  const cs = ctx.cs
  const cid = ctx.cid
  const id = ctx.pathname.slice('/api/sessions/'.length)
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
  // v0.5.bx-19: 兜底 — webui session db 找不到, 但 id 是 mvs_xxx → 当孤儿 mcode session 直接 SQL 删
  if (idx < 0) {
    if (/^mvs_[a-f0-9]{32}$/.test(id)) {
      const mcodeDbDel = deleteMcodeSessionFromDb(id)
      console.log(`[delete] cid=${cid} ORPHAN mcode session sid=${id.substring(0, 12)}… ok=${mcodeDbDel.ok}`)
      if (mcodeDbDel.ok) {
        if (cs.mcodeSessionId === id) {
          cs.mcodeSessionId = null
          cs.sessionId = null
          cs.sessionTitle = 'Untitled'
          cs.chat = []
          resetContext(cs)
          pushStateFor(cid)
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
        return res.end(JSON.stringify({ ok: true, deleted: id, matchKind: 'orphan_mcode', mcodeDbDel }))
      }
      res.writeHead(500, { 'Content-Type': 'application/json' })
      return res.end(JSON.stringify({ ok: false, error: 'orphan mcode delete failed', mcodeDbDel }))
    }
    console.log(`[delete] cid=${cid} 404 id=${id.substring(0, 12)}… not found`)
    res.writeHead(404, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: false, error: 'session not found' }))
  }
  const deletedItem = all[idx]
  all.splice(idx, 1)
  saveSessions(all)
  // v0.5.bx-19: 同步删 mcode 端 session
  const mcodeSid = deletedItem.mcodeSessionId
  let mcodeDbDel = null
  if (mcodeSid) {
    mcodeDbDel = deleteMcodeSessionFromDb(mcodeSid)
    console.log(`[delete] cid=${cid} mcode db delete sid=${mcodeSid.substring(0, 12)}… ok=${mcodeDbDel.ok}`)
  }
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
  console.log(`[delete] cid=${cid} OK match=${matchKind} deleted.webuiId=${deletedItem.id.substring(0, 8)}… remaining=${all.length}`)
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  return res.end(JSON.stringify({ ok: true, deleted: id, matchKind, remaining: all.length, mcodeDbDel }))
}

// POST /api/sessions/cleanup-orphans
export async function handleCleanupOrphans(req, res, ctx) {
  const cs = ctx.cs
  const cid = ctx.cid
  const url = new URL(req.url, 'http://localhost')
  const scope = url.searchParams.get('scope') || 'orphans'
  const mcodeSessList = await listAllMcodeSessions()
  const all = loadSessions()
  const webuiLinkedMcodeSids = new Set(all.filter(s => s.mcodeSessionId).map(s => s.mcodeSessionId))
  const protectedSids = new Set()
  if (cs && cs.mcodeSessionId) protectedSids.add(cs.mcodeSessionId)

  let targets
  if (scope === 'all') {
    targets = mcodeSessList.filter(s => !protectedSids.has(s.sessionId))
  } else {
    targets = mcodeSessList.filter(s => !webuiLinkedMcodeSids.has(s.sessionId) && !protectedSids.has(s.sessionId))
  }
  const result = { scope, total: mcodeSessList.length, targets: targets.length, deleted: 0, deletedWebui: 0, failed: 0, log: [] }
  console.log(`[cleanup-orphans] cid=${cid} scope=${scope} total=${result.total} targets=${result.targets} (linked=${webuiLinkedMcodeSids.size} protected=${protectedSids.size})`)
  for (const o of targets) {
    if (scope === 'all') {
      const webuiIdx = all.findIndex(s => s.mcodeSessionId === o.sessionId)
      if (webuiIdx >= 0) {
        all.splice(webuiIdx, 1)
        result.deletedWebui++
      }
    }
    const r = deleteMcodeSessionFromDb(o.sessionId)
    if (r.ok) {
      result.deleted++
      result.log.push({ sid: o.sessionId, title: o.title, ok: true })
    } else {
      result.failed++
      result.log.push({ sid: o.sessionId, title: o.title, ok: false, error: r.reason || r.error })
    }
  }
  if (scope === 'all' && result.deletedWebui > 0) saveSessions(all)
  invalidateMcodeSessionsCache()
  pushStateFor(cid)
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  return res.end(JSON.stringify({ ok: true, ...result }))
}

// GET /api/acp-sessions?cwd=... — mcode acp session/list
export async function handleAcpSessions(req, res, ctx) {
  const cs = ctx.cs
  const url = new URL(req.url, 'http://localhost')
  const cwd = url.searchParams.get('cwd') || (cs.workspace && cs.workspace.dir) || ''
  const sessions = await getMcodeSessionsForWorkspace(cwd)
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  return res.end(JSON.stringify({ ok: true, cwd, sessions }))
}

// GET /api/acp-session-title?sessionId=...
export async function handleAcpSessionTitle(req, res, _ctx) {
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