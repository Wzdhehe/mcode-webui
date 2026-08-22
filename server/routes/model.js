// webui/server/routes/model.js
// GET /api/models, POST /api/set-model, POST /api/permissions, POST /api/answer (legacy)

import { getBuiltinModelsFromMcode } from '../lib/models.js'
import { pushStateFor } from '../lib/state-bus.js'
import { DEFAULT_MODEL } from '../lib/config.js'

async function readJson(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  try { return JSON.parse(body || '{}') } catch { return {} }
}

// GET /api/models
export function handleGetModels(_req, res, ctx) {
  const cs = ctx.cs
  const list = []
  const builtins = getBuiltinModelsFromMcode()
  const currentName = (cs.model && cs.model.name) || ''
  const currentProvider = currentName.includes('/') ? currentName.split('/')[0] : 'minimax_api'
  for (const m of builtins) {
    list.push({ id: `${currentProvider}/${m}`, label: m, provider: currentProvider })
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  return res.end(JSON.stringify({
    ok: true, models: list,
    current: currentName || DEFAULT_MODEL,
    source: 'mcode-cli-bundle'
  }))
}

// POST /api/set-model — 只更新 cs.model
export async function handleSetModel(req, res, ctx) {
  const cs = ctx.cs
  const cid = ctx.cid
  const payload = await readJson(req)
  const modelId = (payload.model || '').trim()
  if (!modelId) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: false, error: 'model required' }))
  }
  cs.model = cs.model || {}
  cs.model.name = modelId
  pushStateFor(cid)
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  return res.end(JSON.stringify({ ok: true, model: modelId, note: '仅更新本地状态，mcode session 创建时会用此 model' }))
}

// POST /api/permissions
export async function handleSetPermissions(req, res, ctx) {
  const cs = ctx.cs
  const cid = ctx.cid
  const payload = await readJson(req)
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

// POST /api/answer — legacy no-op (新 webui 走 /api/send)
export async function handleAnswer(req, res, _ctx) {
  const payload = await readJson(req)
  if (process.env.MCODE_USAGE_DEBUG) console.log(`[api.answer] type=${payload.type} option=${payload.option} (legacy, no-op)`)
  res.writeHead(200, { 'Content-Type': 'application/json' })
  return res.end(JSON.stringify({ ok: true, deprecated: true, note: 'use /api/send for new flow' }))
}