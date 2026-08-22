// webui/server/routes/chat.js
// POST /api/send — main chat entry
// POST /api/stop — kill running child for cid
// POST /api/cmd — webui button-driven commands

import { randomUUID } from 'node:crypto'
import { loadSessions, saveSessions, persistCurrentChat, resetContext } from '../lib/sessions.js'
import { pushStateFor, getActiveChild } from '../lib/state-bus.js'
import { handleLocalSlash, handleCmdCommand } from '../lib/slash.js'
import { runMcodeAcp } from '../lib/mcode-acp.js'
import { collectExecResult, runMcodeExec } from '../lib/mcode-exec.js'
import { DEFAULT_MODEL } from '../lib/config.js'

async function readJson(req) {
  let body = ''
  for await (const chunk of req) body += chunk
  try { return JSON.parse(body || '{}') } catch { return {} }
}

// POST /api/send — main chat entry, fire-and-forget (response = ack; output via /api/events SSE)
export async function handleSend(req, res, ctx) {
  const cs = ctx.cs
  const cid = ctx.cid
  const payload = await readJson(req)
  let content = (payload.content || '').trim()
  if (!content) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify({ ok: false, error: 'content required' }))
  }
  // v0.5.bx-13: ask_user 弹窗答案 — 不当 user message 加到 chat
  const isAskAnswer = payload.isAskAnswer === true
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: true }))

  // v0.5.ai: per-cid — 操作 cs (ask 答案跳过, chat 保持干净)
  if (!isAskAnswer) {
    cs.chat = [...(cs.chat || []), `› ${content}`]
    pushStateFor(cid)
    persistCurrentChat(cs)
  }

  // v0.5.ak: 发首条消息时如果 cs.sessionId 为空，先建一个 webui session entry
  if (!cs.sessionId) {
    const all = loadSessions()
    const id = randomUUID()
    const item = { id, title: 'New session', createdAt: Date.now(), updatedAt: Date.now(), chat: cs.chat || [] }
    all.unshift(item)
    saveSessions(all)
    cs.sessionId = id
  }

  // Detect slash commands that we can satisfy without spawning mcode
  const slashResult = await handleLocalSlash(content, cs, cid)
  if (slashResult.handled) {
    if (slashResult.continueMcode && slashResult.rewriteContent !== undefined) {
      content = slashResult.rewriteContent
      // fall through to mcode call
    } else {
      return
    }
  }

  // v0.5.ah: 走 mcode acp 协议（默认）— MCODE_USE_ACP=0 切回 mcode exec 逃生
  const modelToUse = (cs && cs.model && cs.model.name) || DEFAULT_MODEL
  console.log(`[send] cid=${cid} content=${JSON.stringify(content.slice(0, 80))} model=${modelToUse} sessionId=${cs.mcodeSessionId} workspace=${(cs && cs.workspace && cs.workspace.dir) || 'null'}`)
  const t0 = Date.now()
  const r = process.env.MCODE_USE_ACP === '0'
    ? await collectExecResult(runMcodeExec(content, { label: 'prompt', sessionId: cs.mcodeSessionId, model: modelToUse, cs, cid }))
    : await runMcodeAcp(content, { label: 'prompt', sessionId: cs.mcodeSessionId, model: modelToUse, cs, cid })
  console.log(`[send] result ${Date.now() - t0}ms:`, JSON.stringify({ status: r.status, error: r.error, answer: r.answer && r.answer.slice(0, 80), sessionId: r.sessionId }).slice(0, 500))
  if (r.status === 'succeeded' && r.answer) {
    // v0.5.bx-4: 流式输出已经在 streamAcpPrompt/streamUpdateLine 里把 ▲ 和 ● 行写进 chat 了
    const oneLine = r.answer.replace(/\n+/g, ' ').trim()
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
  persistCurrentChat(cs)
  pushStateFor(cid)
}

// POST /api/stop — 中断正在跑的 mcode exec
export function handleStop(_req, res, ctx) {
  const cid = ctx.cid
  const child = getActiveChild(cid)
  const wasRunning = !!child
  if (child) {
    try { child.kill() } catch {}
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  return res.end(JSON.stringify({ ok: true, wasRunning }))
}

// POST /api/cmd — webui button-driven commands
export async function handleCmd(req, res, ctx) {
  const cs = ctx.cs
  const cid = ctx.cid
  const payload = await readJson(req)
  const cmd = (payload.cmd || '').trim()
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify({ ok: true }))
  await handleCmdCommand(cmd, cs, cid)
}