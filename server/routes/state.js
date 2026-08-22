// webui/server/routes/state.js
// GET /api/events (SSE) + GET /api/state

import { getClient, getCidFromReq, sseByCid, clients, SSE_HEADERS, pushStateFor, pushOnlineCount } from '../lib/state-bus.js'
import { loadSessions } from '../lib/sessions.js'
import { getMcodeSessionsForWorkspace, getCachedMcodeCommands } from '../lib/acp-client.js'
import { getLanBroadcast } from '../lib/settings.js'

export async function handleEvents(req, res, ctx) {
  const cid = getCidFromReq(req)
  const cs = getClient(cid)
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
    pushOnlineCount(getLanBroadcast())  // v0.5.ak: 客户端断开时广播在线数
  })
  pushOnlineCount(getLanBroadcast())  // v0.5.ak: 客户端新连接时广播在线数
  return true
}

export async function handleState(req, res, ctx) {
  const cs = getClient(ctx.cid)
  const mcodeSessions = await getMcodeSessionsForWorkspace(cs.workspace && cs.workspace.dir)
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  return res.end(JSON.stringify({
    ...cs,
    sessions: loadSessions(),
    mcodeSessions,
    availableCommands: getCachedMcodeCommands(),
    lanBroadcast: getLanBroadcast(),
  }))
}