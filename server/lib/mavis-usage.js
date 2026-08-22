// webui/server/lib/mavis-usage.js
// Pull real token usage from mavis runtime-state.sqlite (per-turn + cumulative).

import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { MAVIS_DB_PATH, SQLITE3_BIN } from './config.js'

// v0.5.bx-10: 从 mavis 桌面端 sqlite 读 mcode acp session 的真实 token usage
//   数据源：MAVIS_DB_PATH (=~/.minimax/v2/sqlite/runtime-state.sqlite) 的 local_runtime_token_usage 表
//   mavis hook 自动写入所有 mcode 调用 (framework_type='pi-agent')
//   返回 { totalInput, totalOutput, totalCacheRead, totalCacheWrite, count, byModel: {model: {input,output,...}} }
//   失败（db 不存在 / 查不到 / 0 条）时返回 null，调用方 fallback 估算
export async function getMavisTokenUsage(mvsSessionId) {
  if (!mvsSessionId || !existsSync(MAVIS_DB_PATH)) return null
  // sql 注入防护：mvsSessionId 必须 mvs_ 前缀
  if (!/^mvs_[a-f0-9]{16,}$/i.test(mvsSessionId)) return null
  return await new Promise((resolve) => {
    // v0.5.bx-20 (改): 用 per-turn 命中率 (最近一行的 cache_read / total input)
    //   之前算的是累计 (SUM(cache_read) / SUM(input + cache_read)) — 但 context limit 只有 512k,
    //   累计 cache_read 13 轮能到 6519.5k, 跟 "上下文一共最高才 512k" 矛盾 (Ponkan 反馈)
    //   per-turn 反映"当前一轮 prompt" 的 cache 复用 — 这才是 user 关心的"当前 context 命中率"
    //   稳态 session per-turn 95-100%, 早期/大 input session 低一些 (因为新加 input 多, cache miss 多)
    const sql = `SELECT
      COALESCE(SUM(input_tokens),0) AS total_input,
      COALESCE(SUM(output_tokens),0) AS total_output,
      COALESCE(SUM(cache_read_tokens),0) AS total_cache_read,
      COALESCE(SUM(cache_write_tokens),0) AS total_cache_write,
      COALESCE(SUM(reasoning_tokens),0) AS total_reasoning,
      COUNT(*) AS rows,
      COALESCE(MAX(ts),0) AS last_ts,
      COALESCE(MIN(ts),0) AS first_ts,
      (SELECT cache_read_tokens FROM local_runtime_token_usage WHERE session_id = '${mvsSessionId}' ORDER BY ts DESC LIMIT 1) AS last_cache_read,
      (SELECT input_tokens FROM local_runtime_token_usage WHERE session_id = '${mvsSessionId}' ORDER BY ts DESC LIMIT 1) AS last_input,
      (SELECT cache_write_tokens FROM local_runtime_token_usage WHERE session_id = '${mvsSessionId}' ORDER BY ts DESC LIMIT 1) AS last_cache_write
    FROM local_runtime_token_usage WHERE session_id = '${mvsSessionId}'`
    const child = spawn(SQLITE3_BIN, [MAVIS_DB_PATH, '-readonly', sql], { windowsHide: true })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill() } catch {} }, 5000)
    child.stdout?.on('data', (d) => { stdout += d.toString('utf8') })
    child.stderr?.on('data', (d) => { stderr += d.toString('utf8') })
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) { resolve(null); return }
      // 解析: "total_input|total_output|total_cache_read|total_cache_write|total_reasoning|rows|last_ts|first_ts|last_cache_read|last_input|last_cache_write"
      const parts = stdout.trim().split('|').map(s => s.trim())
      if (parts.length < 11) { resolve(null); return }
      const [ti, to, tcr, tcw, tr, rows] = parts.map(Number)
      if (rows === 0) { resolve(null); return }
      // v0.5.bx-20: per-turn cache 命中率 — 基于最近一行的 input + cache_read + cache_write
      //   这才是"当前 context 命中率", 反映最近一轮 prompt 的 cache 复用程度
      //   公式: cache_read / (input + cache_read + cache_write)
      const lastCr = Number(parts[8])
      const lastIn = Number(parts[9])
      const lastCw = Number(parts[10])
      const lastTotal = lastIn + lastCr + lastCw
      const cacheHitRate = lastTotal > 0 ? lastCr / lastTotal : 0
      resolve({
        rows,
        totalInput: ti, totalOutput: to,
        totalCacheRead: tcr, totalCacheWrite: tcw, totalReasoning: tr,
        firstTs: Number(parts[6]), lastTs: Number(parts[7]),
        cacheHitRate,
        // v0.5.bx-20: 也带 per-turn 原始值 (调试/显示用)
        lastTurnInput: lastIn,
        lastTurnCacheRead: lastCr,
        lastTurnCacheWrite: lastCw,
      })
    })
  })
}

// v0.5.bx-10: 用 mavis db 拿最近一条 row 的 model 字段（拿不到 model id 就算了）
export async function getMavisTokenUsageModel(mvsSessionId) {
  if (!mvsSessionId || !existsSync(MAVIS_DB_PATH)) return null
  if (!/^mvs_[a-f0-9]{16,}$/i.test(mvsSessionId)) return null
  return await new Promise((resolve) => {
    const sql = `SELECT model, input_tokens, output_tokens, cache_read_tokens, ts FROM local_runtime_token_usage WHERE session_id = '${mvsSessionId}' AND model IS NOT NULL AND model != '' ORDER BY ts DESC LIMIT 1`
    const child = spawn(SQLITE3_BIN, [MAVIS_DB_PATH, '-readonly', sql], { windowsHide: true })
    let stdout = ''
    const timer = setTimeout(() => { try { child.kill() } catch {} }, 5000)
    child.stdout?.on('data', (d) => { stdout += d.toString('utf8') })
    child.on('error', () => { clearTimeout(timer); resolve(null) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) { resolve(null); return }
      const parts = stdout.trim().split('|')
      if (parts.length < 5) { resolve(null); return }
      resolve({ model: parts[0], input: Number(parts[1]), output: Number(parts[2]), cacheRead: Number(parts[3]), ts: Number(parts[4]) })
    })
  })
}

// Apply mavis token usage to cs.context + cs.usage (with cache_hit_rate + model).
// Caller is responsible for pushing state after this returns.
export async function applyMavisUsageToCs(cs, mvsSessionId, { getMcodeModelLimit }) {
  const mavisUsage = await getMavisTokenUsage(mvsSessionId)
  if (!mavisUsage || mavisUsage.rows === 0) return false
  // v0.5.bx-10 fix: cache_read / cache_write 是 input 的子集, 不应该加进 context
  //   context_used = input + output + reasoning (input 已经包含 cache 部分)
  //   之前加 cache 会让数字虚高 (input=42k + cacheRead=210k = 252k, 实际只用 42k)
  const newTokens = mavisUsage.totalInput + mavisUsage.totalOutput + mavisUsage.totalReasoning
  cs.context.tokens = newTokens
  cs.context.used = newTokens
  // v0.5.bx-10: 按 model 查真实 context limit (mcode cli.js 硬编码: MiniMax-M3=512k, M2.7*=200k)
  const modelName = cs.model && cs.model.name || ''
  if (typeof getMcodeModelLimit === 'function') {
    const realLimit = getMcodeModelLimit(modelName)
    if (realLimit) cs.context.limit = realLimit
  }
  cs.context.percent = cs.context.limit ? Math.round((newTokens / cs.context.limit) * 100) : 0
  cs.context.estimated = false  // 真值
  cs.context.usageSource = 'mavis-db'  // 标记数据源
  cs.usage.sessionInput = mavisUsage.totalInput
  cs.usage.sessionOutput = mavisUsage.totalOutput
  cs.usage.sessionCacheRead = mavisUsage.totalCacheRead
  cs.usage.sessionCacheWrite = mavisUsage.totalCacheWrite
  cs.usage.sessionReasoning = mavisUsage.totalReasoning
  cs.usage.sessionTotal = mavisUsage.totalInput + mavisUsage.totalOutput
  // v0.5.bx-20: 真实 cache 命中率 — 累计 cache_read / (input + cache_read)
  cs.usage.sessionCacheHitRate = mavisUsage.cacheHitRate || 0
  cs.usage.lastMavisUpdate = Date.now()
  // Try to also pull model name (best-effort)
  const m = await getMavisTokenUsageModel(mvsSessionId).catch(() => null)
  if (m && m.model) {
    cs.usage.mavisModel = m.model
    cs.usage.mavisModelAt = Date.now()
  }
  return true
}