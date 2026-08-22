// webui/server/lib/config.js
// Pure configuration constants. No side effects.

import { resolve, join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))
// __dirname here = webui/server/lib/. We need webui/ as root, so go up 3 levels.
// But config.js is imported by router.js which lives at webui/server/. The expected
// pattern: MCODE_ROOT = webui/.., i.e. the project root that contains mcode.cmd.
// Original behavior: server.js at webui/, MCODE_ROOT = resolve(__dirname, '..').
// Since config.js is at webui/server/lib/, we resolve up 3 levels to land at .minimax-code/.

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

export const MCODE_ROOT = resolve(__dirname, '..', '..', '..')  // webui/server/lib → ../../../ → .minimax-code
export const MCODE_CMD = join(MCODE_ROOT, 'mcode.cmd')
export const PORT = Number(process.env.PORT) || 7890
// v0.5.ao: web UI 默认监听所有网卡（不限制本机）— 用户在浏览器/手机/局域网访问是主场景
export const HOST = process.env.HOST || '0.0.0.0'
export const DEFAULT_MODEL = process.env.MCODE_MODEL || 'minimax_api/MiniMax-M3'
export const DEFAULT_TIMEOUT = process.env.MCODE_TIMEOUT || '120s'
export const DEFAULT_MAX_STEPS = Number(process.env.MCODE_MAX_STEPS) || 6
export const MAX_CONCURRENT = Number(process.env.MCODE_MAX_CONCURRENT) || 3
export const UPLOAD_DIR = process.env.MCODE_WEBUI_UPLOAD_DIR || join(MCODE_ROOT, '.webui-uploads')
export const SESSIONS_DB = process.env.MCODE_WEBUI_SESSIONS_DB || join(MCODE_ROOT, '.webui-sessions.json')
// v0.5.bx-19: mcode session 物理存储位置
export const MCODE_RUNTIME_DB = join(homedir(), '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite')
// v0.5.bx-10: mavis 桌面端 sqlite db — local_runtime_token_usage 表存真实 token usage
export const MAVIS_DATA_DIR = process.env.MAVIS_DATA_DIR || join(homedir(), '.minimax')
export const MAVIS_DB_PATH = join(MAVIS_DATA_DIR, 'v2', 'sqlite', 'runtime-state.sqlite')
export const SQLITE3_BIN = process.env.SQLITE3_BIN || 'C:\\Users\\mjc39\\anaconda3\\Library\\bin\\sqlite3.exe'

// v0.5.bn: 默认工作区必须有真实路径，否则 mcode acp session/new 报 "Invalid params"
//   之前的 null 设计是想要"用户没选就不发"语义，但 acp 必须传 cwd
//   优先级：env MCODE_WORKSPACE > mcode TUI 的 cwd.json > 用户家目录（兜底）
export const DEFAULT_WORKSPACE = (() => {
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

// re-export detectTuiCwd for workspace route
export { detectTuiCwd }

// v0.5.bl: 全局未捕获错误处理（server 崩了不静默，至少打日志 + 写 .server.err）
export function installGlobalErrorHandlers() {
  process.on('uncaughtException', (err) => {
    console.error('[uncaughtException]', err)
    try {
      import('node:fs').then(({ appendFileSync }) => {
        const logFile = join(MCODE_ROOT, '.server.err')
        appendFileSync(logFile, `\n[uncaughtException ${new Date().toISOString()}] ${err.stack || err.message}\n`)
      })
    } catch {}
  })
  process.on('unhandledRejection', (reason) => {
    console.error('[unhandledRejection]', reason)
    try {
      import('node:fs').then(({ appendFileSync }) => {
        const logFile = join(MCODE_ROOT, '.server.err')
        appendFileSync(logFile, `\n[unhandledRejection ${new Date().toISOString()}] ${reason && reason.stack ? reason.stack : String(reason)}\n`)
      })
    } catch {}
  })
}