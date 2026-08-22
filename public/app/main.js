import { currentLang, setLang, t, applyI18n, applyTheme, toggleTheme } from './i18n.js'
import { parseMarkdown, escapeHtml, formatNumber, nextFiveHourReset, nextWeeklyReset, formatTimeUntil, formatResetTime } from './util.js'
// ============================================================
// Debug log (in-page) — v0.5.bx-NN
// 默认收起 (hidden), 首次报错自动弹出; 用户可关闭; 关闭后只显小红点提示
// ============================================================
const __DBG = (() => {
  const buf = []
  const MAX = 30
  const panel = () => document.getElementById('debug-log-panel')
  const pre = () => document.getElementById('debug-log')
  const titleEl = () => document.getElementById('debug-log-title')

  const flush = () => {
    const el = pre()
    if (el) el.textContent = buf.map(e => `[${e.t}] ${e.msg}`).join('\n')
  }
  const hasError = () => buf.some(e => /^❌/.test(e.msg))
  const updateBadge = () => {
    const p = panel()
    if (!p) return
    // 报错时: 自动展开面板 (除非用户主动收起过)
    if (hasError() && !p.dataset.userClosed) {
      p.hidden = false
    }
    if (titleEl()) {
      const errCount = buf.filter(e => /^❌/.test(e.msg)).length
      titleEl().textContent = errCount > 0
        ? `📋 webui log (${errCount} ❌ + ${buf.length - errCount} info)`
        : `📋 webui log (${buf.length} lines)`
    }
  }
  const log = (msg) => {
    const t = new Date().toTimeString().slice(0, 8)
    buf.push({ t, msg: String(msg) })
    if (buf.length > MAX) buf.shift()
    flush()
    updateBadge()
    try { console.log('[webui]', msg) } catch {}
  }
  return { log, buf, flush, hasError, updateBadge }
})()
window.__DBG = __DBG
window.addEventListener('error', (e) => {
  __DBG.log('❌ERR: ' + (e.error?.message || e.message) + ' @ ' + (e.filename || '?') + ':' + (e.lineno || '?') + ':' + (e.colno || '?'))
})
window.addEventListener('unhandledrejection', (e) => {
  __DBG.log('❌REJ: ' + (e.reason?.message || e.reason?.toString() || e.reason))
})
document.addEventListener('DOMContentLoaded', () => {
  // copy: 全部 buffer → clipboard
  document.getElementById('debug-log-copy')?.addEventListener('click', () => {
    const txt = __DBG.buf.map(e => `[${e.t}] ${e.msg}`).join('\n')
    navigator.clipboard?.writeText(txt).then(() => __DBG.log('✓ copied ' + __DBG.buf.length + ' lines'))
  })
  // clear: 清空 buffer (不隐藏面板, 让用户看到空状态)
  document.getElementById('debug-log-clear')?.addEventListener('click', () => {
    __DBG.buf.length = 0
    __DBG.flush()
    __DBG.updateBadge()
  })
  // close: 隐藏面板 + 标记 user-closed, 不再自动展开
  document.getElementById('debug-log-close')?.addEventListener('click', () => {
    const p = document.getElementById('debug-log-panel')
    if (p) { p.hidden = true; p.dataset.userClosed = '1' }
  })
  // 调试入口: 在 console 输 __DBG.show() 可手动展开
  __DBG.show = () => { const p = panel(); if (p) { p.hidden = false; delete p.dataset.userClosed } }
  // URL 里有 ?debug=1 时强制显示 (开发用)
  try {
    if (new URLSearchParams(window.location.search).get('debug') === '1') {
      __DBG.show()
    }
  } catch {}
})

// ============================================================
// Config
// ============================================================
const urlParams = new URLSearchParams(window.location.search)
const tokenParam = urlParams.get('token') || ''
const TOKEN = tokenParam  // 给 fetch/SSE 用
const TOKEN_QUERY = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : ''

// v0.5.ai: A2 per-client — 每个 webui tab 一个 client id (localStorage 持久化)
// 拼到所有 /api/xxx URL query string，server 端按 cid 路由 SSE + state
const CID = (() => {
  let c = localStorage.getItem('webui_cid')
  if (!c) {
    c = (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : ('c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10))
    try { localStorage.setItem('webui_cid', c) } catch {}
  }
  return c
})()
const CID_QUERY = `cid=${encodeURIComponent(CID)}`
// API_SUFFIX = TOKEN_QUERY (if any) + '&cid=xxx' (or '?cid=xxx' first)
const API_SUFFIX = TOKEN_QUERY ? `${TOKEN_QUERY}&${CID_QUERY}` : `?${CID_QUERY}`

const HEADERS = TOKEN ? { 'Authorization': `Bearer ${TOKEN}` } : {}

// 权限模式图标（按当前 permissions 状态切换）
// shield=完全访问 / help=询问 / check=自动 / eye=只读
const MODE_ICONS = {
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
  help: '<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
}


// ============================================================
// State
// ============================================================
let state = null
let slashOpen = false
let slashQuery = ''
let slashActiveIdx = 0
let slashFiltered = []
let modeOpen = false
// v0.5.ap: 旧 settingsOpen 变量已废弃（v0.5.ap 改用 settings-modal 替代旧 settings-menu）
// 保留定义兼容可能的旧代码引用，但本文件其他地方不再使用
// let settingsOpen = false
let attachedFiles = []
let isSending = false
let leftOpen = false
let rightOpen = false

// v0.5.ax: 欢迎页时隐藏右侧栏（chat-area 居中铺满）
function hideRightForWelcome(isWelcome) {
  const rp = document.getElementById('right-panel')
  if (!rp) return
  if (isWelcome) {
    rp.classList.add('welcome-hidden')
    // 同时关掉右侧栏展开状态（避免下次的"显示按钮"逻辑不一致）
    rightOpen = false
    rp.classList.remove('open')
  } else {
    rp.classList.remove('welcome-hidden')
  }
}
let lastTpsValue = null
let lastTpsTime = null
let spentSinceLastUsage = 0
let sessionSearchQuery = ''   // v0.5.x: 侧边栏会话搜索词

// Modal state (v0.5.bx-14: askOpen/askSelectedIdx/askSending/lastShownAskKey 已删, 用 #ask-modal ASK_MODAL_STATE)
let planOpen = false
let planSending = false
let planModeOpen = false
let permOpen = false
let lastShownPlanKey = null
let lastShownPermKey = null
let lastShownPlanModeKey = null

// ============================================================
// Slash commands
// v0.5.bx-23: 删掉 11 个 mcode 0.1.5 acp 不识别的"假命令"
//   之前列的 17 个里: /sessions /plan /permission /plugins /provider /feedback /steer /init /logout /quit
//   mcode 0.1.5 acp 都不识别 (availableCommands 只有 10 个, mcode 0.1.5 acp 也不暴露 goal/plan)
//   删掉避免 user 输完发现啥也没发生
// 保留: mcode 真支持 5 个 (help/new/model/status/usage) + webui 自己处理 4 个 (goal/goal-done/goal-blocked/clear)
//   + 加 mcode 真的但 webui 漏的 4 个 (doctor/skills/mcp/compact) — 让 user 知道这些命令可用
// ============================================================
const SLASH_COMMANDS = [
  // --- mcode 0.1.5 acp 真支持 ---
  { cmd: '/help', zh: '显示可用命令', en: 'Show available commands' },
  { cmd: '/new', zh: '开启新会话', en: 'Start a fresh session' },
  { cmd: '/model', zh: '选择模型', en: 'Choose model' },
  { cmd: '/context', zh: '只读上下文', en: 'Read-only context' },
  { cmd: '/doctor', zh: '诊断 mcode 健康度', en: 'Diagnose mcode health' },
  { cmd: '/skills', zh: '管理 skills', en: 'Manage skills' },
  { cmd: '/mcp', zh: 'MCP servers', en: 'MCP servers' },
  { cmd: '/usage', zh: '会话用量', en: 'Show session usage' },
  { cmd: '/compact', zh: '压缩上下文', en: 'Compact context' },
  // --- webui 自己处理 (不走 mcode) ---
  { cmd: '/status', zh: '当前 session 状态 (webui)', en: 'Show current session status (webui)' },
  { cmd: '/goal', zh: '设定目标 (webui 改写消息, 单轮执行)', en: 'Set goal (webui rewrites msg, single-turn)' },
  { cmd: '/goal-done', zh: '标记目标完成 (webui)', en: 'Mark goal done (webui)' },
  { cmd: '/goal-blocked', zh: '标记目标阻塞 (webui)', en: 'Mark goal blocked (webui)' },
  { cmd: '/clear', zh: '清空当前对话 (webui)', en: 'Clear current chat (webui)' },
]

const SLASH_SKILLS = [
  { name: 'plan', zh: 'Plan Mode（先出方案再执行）', en: 'Plan Mode (plan first)' },
  { name: 'context', zh: '只读当前会话上下文', en: 'Read-only session context' },
  { name: 'feedback', zh: '提交反馈', en: 'Submit feedback' },
]

// ============================================================
// SSE connection
// ============================================================
let es = null
let autoRefreshTimer = null
function connect() {
  if (es) { try { es.close() } catch {} }
  const url = '/api/events' + API_SUFFIX
  es = new EventSource(url)
  es.onmessage = (ev) => {
    try {
      // v0.5.bx-8: 保留 askUserAnswers (webui-only, server 不存) — SSE 推送整 state 会覆盖
      const preserved = state?.askUserAnswers
      state = JSON.parse(ev.data)
      if (preserved) state.askUserAnswers = preserved
      // v0.5.bx-31: mcodeSessions 第一次非空时 sidebarReady=true, renderSessions 切到真实列表
      //   之前没这判断, 首次 render 用空 mcodeSessions 渲染, 用户点删除/切时 race
      if (!sidebarReady && Array.isArray(state.mcodeSessions) && state.mcodeSessions.length > 0) {
        console.log('[webui] sidebar ready: mcodeSessions.length=' + state.mcodeSessions.length)
        sidebarReady = true
      }
      render()
    } catch (e) { console.error('sse parse', e) }
  }
  es.onerror = () => { setTimeout(connect, 3000) }
  // v0.5.ak: user footer 已改为静态 GitHub 链接，不需要 ticker

  // 自动 /api/refresh 触发：页面打开 2s + 每 60s 拉一次
  // 避免 web UI 一直显示 "—" / "Loading..."
  const trigger = async () => {
    try { await fetch('/api/refresh' + API_SUFFIX, { method: 'POST', headers: HEADERS }) } catch {}
  }
  setTimeout(trigger, 2000)
  if (autoRefreshTimer) clearInterval(autoRefreshTimer)
  autoRefreshTimer = setInterval(trigger, 60000)
}

// ============================================================
// Render
// ============================================================
function render() {
  if (!state) return
  // v0.5.ap: chip-lan — 局域网访问状态（替 v0.5.ak 的 chip-status "空闲"）
  // v0.5.at: 跟其他 btn-menu 同结构，value 位置显示 开/关
  const lanBroadcast = state.lanBroadcast !== false  // 缺省 true
  const lanChip = document.getElementById('chip-lan')
  const lanValue = document.getElementById('chip-lan-value')
  if (lanChip) {
    lanChip.setAttribute('data-lan', lanBroadcast ? 'on' : 'off')
    lanChip.title = lanBroadcast ? t('lan_title_on') : t('lan_title_off')
  }
  if (lanValue) {
    lanValue.textContent = lanBroadcast ? t('lan_on') : t('lan_off')
    lanValue.setAttribute('data-i18n', lanBroadcast ? 'lan_on' : 'lan_off')
  }
  // v0.5.bp: 顶栏 LAN 链接 chip — LAN on 时显示当前 IP，off 时隐藏
  const chipLanLink = document.getElementById('chip-lan-link')
  if (chipLanLink) {
    chipLanLink.hidden = !lanBroadcast
  } else {
    console.warn('[lan] render: chip-lan-link element NOT found in DOM')
  }

  // v0.5.aa: TPS 还在用
  const tpsEl = document.getElementById('chip-tps')

  // v0.5.ak: 在线 webui tab 数（server sseByCid.size）
  // v0.5.bh: 走 i18n（zh: 1 台, en: 1 dev），离线时显示红点 + "offline" 文案
  const onlineCount = state.onlineCount || 1
  const isOnline = navigator.onLine !== false  // 浏览器没主动报 false = 算在线
  const onlineText = isOnline
    ? (onlineCount === 1 ? t('chip_online_single') : t('chip_online_plural').replace('{n}', onlineCount))
    : t('chip_offline')
  const onlineDot = isOnline ? '🟢' : '🔴'
  const chipOnline = document.getElementById('chip-online')
  if (chipOnline) {
    chipOnline.querySelector('span:first-child').textContent = onlineDot
    chipOnline.querySelector('#chip-online-text').textContent = onlineText
  }

  // v0.5.aa: chat 底部思考中指示器 + send 按钮 → stop 按钮
  const isRunning = state.running?.active === true
  const chatThinkingEl = document.getElementById('chat-thinking')
  if (chatThinkingEl) {
    chatThinkingEl.hidden = !isRunning
  }
  const btn = document.getElementById('btn-send')
  if (btn) {
    if (isRunning) {
      btn.classList.add('is-stop')
      btn.title = t('btn_stop_title')
      btn.disabled = false
    } else {
      btn.classList.remove('is-stop')
      btn.title = t('btn_send_title')
    }
  }

  if (state.context?.tps) {
    if (tpsEl) tpsEl.hidden = false
    document.getElementById('tps-value').textContent = state.context.tps
  } else {
    if (tpsEl) tpsEl.hidden = true
  }

  // Version
  if (state.version) document.getElementById('version').textContent = 'v' + state.version

  // Workspace — v0.5.ax: 顶栏 chip 挪到 chat-empty 欢迎页（启动对话后 chip 隐藏）
  // v0.5.bb: 默认 workspace 可以是 null（用户没选），chip 显示 "未选择" + 提示选工作区
  const wsDir = state.workspace?.dir
  const wsText = wsDir
    ? (() => { const parts = wsDir.split(/[\\\/]/).filter(Boolean); return parts[parts.length - 1] || wsDir })()
    : t('workspace_unset_text')
  const wsEl = document.getElementById('workspace-text')
  if (wsEl) wsEl.textContent = wsText
  const emptyWs = document.getElementById('chat-empty-ws-text')
  if (emptyWs) {
    emptyWs.textContent = wsText
    const btn = document.getElementById('chat-empty-workspace')
    if (btn) btn.title = wsDir || t('workspace_picker_hint')
  }

  // Right panel
  renderRight()

  // Model + mode in input
  if (state.model?.name) {
    const shortName = state.model.name.split('/').pop() || state.model.name
    document.getElementById('model-label').textContent = shortName
    document.getElementById('r-model').textContent = state.model.name
  }
  if (state.model?.ctx) document.getElementById('r-ctx').textContent = state.model.ctx
  if (state.model?.thinking) document.getElementById('r-thinking').textContent = state.model.thinking

  // Workspace right
  if (state.workspace?.dir) document.getElementById('r-dir').textContent = state.workspace.dir
  if (state.workspace?.branch) document.getElementById('r-branch').textContent = state.workspace.branch
  if (state.workspace?.tree) document.getElementById('r-tree').textContent = state.workspace.tree

  // Session right
  // v0.5.bx: 优先显示 mcode session id (mvs_xxx)，fallback webui randomUUID
  const rightId = state?.mcodeSessionId || state?.sessionId
  if (rightId) document.getElementById('r-session-id').textContent = rightId
  if (state.sessionTitle) document.getElementById('r-session-title').textContent = state.sessionTitle

  // Permissions → mode label + icon
  if (state.permissions) {
    let modeLabel = 'Default'
    let modeIcon = 'shield'  // full access default
    if (/完全|full/i.test(state.permissions)) { modeLabel = t('mode_full'); modeIcon = 'shield' }
    else if (/ask|询问/i.test(state.permissions)) { modeLabel = t('mode_ask'); modeIcon = 'help' }
    else if (/auto|自动/i.test(state.permissions)) { modeLabel = t('mode_auto'); modeIcon = 'check' }
    else if (/read|只读/i.test(state.permissions)) { modeLabel = t('mode_read'); modeIcon = 'eye' }
    document.getElementById('mode-label').textContent = modeLabel
    const iconEl = document.getElementById('mode-icon')
    if (iconEl) iconEl.innerHTML = MODE_ICONS[modeIcon] || MODE_ICONS.shield
  }

  // Context right (real-time usage + TPS)
  renderContext()

  // Goal (dynamic)
  renderGoal()

  // Todo (dynamic)
  renderTodo()

  // User footer: v0.5.ak 改为 GitHub 链接（静态，不需要 render）

  // Sessions list (左栏 RECENT)
  renderSessions()

  // Quota card (左下角, btn-menu 风格 + popover, mmx 直拉 + 本机时间)
  renderUsage()

  // Chat
  renderChat()

  // Modals (v0.4.0)
  checkModals()
}

function renderRight() {
  // SESSION / MODEL / WORKSPACE 已在 render() 里单独处理
  // 这里只处理 mode popover 的 active 高亮
  document.querySelectorAll('.mode-popover-item').forEach(el => {
    const mode = el.getAttribute('data-mode')
    const perm = (state?.permissions || '').toLowerCase()
    el.classList.toggle('active',
      (mode === 'full' && /完全|full/.test(perm)) ||
      (mode === 'ask' && /ask|询问/.test(perm)) ||
      (mode === 'auto' && /auto|自动/.test(perm)) ||
      (mode === 'plan' && !!state?.planMode)  // v0.5.bx-9: Plan 模式 webui 本地 toggle
    )
  })
  // v0.5.bx-9: Plan 模式激活时, btn-mode 顶栏按钮加 active 视觉提示
  const btnMode = document.getElementById('btn-mode')
  if (btnMode) btnMode.classList.toggle('active-plan', !!state?.planMode)
}

function renderContext() {
  const ctx = state?.context || {}
  const spent = ctx.spent || ctx.tokens || 0
  const limit = parseInt(ctx.limit || state?.model?.ctx || 0, 10) || 0
  const percent = ctx.percent || (limit > 0 ? Math.min(100, (spent / limit) * 100) : 0)
  // v0.5.bx-9: mcode 0.1.4 acp 不发 usage_update, server 端用 thinking+answer 长度估算 (粗略)
  //   显示数字 + `~` 前缀, tooltip 说明是估算; 0.1.5+ 返 usage 时 ctx.estimated = false, 自动去掉 ~
  // v0.5.bx-10: mavis desktop db 也存了真实 token usage (local_runtime_token_usage 表)
  //   server 端在 streamAcpPrompt finalize 后 400ms 自动查 mavis db, 拿到真值会覆盖估算
  //   数据源: ctx.usageSource ('mavis-db' | 'mcode-rusage' | 'estimate')
  const isEstimated = ctx.estimated === true
  const usageSource = ctx.usageSource || (isEstimated ? 'estimate' : 'mcode-rusage')
  const hasData = spent > 0
  // v0.5.bx-20: used 显示 "264.9k/512k" 格式 (used / limit) — Ponkan 反馈
  //   之前只显示 used 数字 + 下面 progress bar + percent
  //   现在把限额拼到数字后面, 一眼看到 used 占 limit 的比例
  //   没有 limit (model 未识别) 时降级为只用数字
  const usedText = hasData
    ? `${isEstimated ? '≈' : ''}${formatNumber(spent)}${limit > 0 ? '/' + formatNumber(limit) : ''}`
    : '—'
  document.getElementById('r-used').textContent = usedText
  document.getElementById('r-used').title = hasData
    ? (isEstimated
        ? '估算值 (mcode 0.1.4 不返 usage, 基于输出文本长度 / 3 估算 token; 0.1.5+ 自动用真值)'
        : (usageSource === 'mavis-db'
            ? '真实用量 (来自 mavis 桌面端 sqlite: local_runtime_token_usage 表, mcode 调 LLM 时自动记录)'
            : '真实用量 (mcode 0.1.5+ 返 usage)'))
    : '暂无数据 (还没跑过任务)'
  // v0.5.bx-10: 数据源 badge — 显示 "估算" / "mavis db" / "mcode" 帮用户知道真假
  const srcEl = document.getElementById('r-usage-source')
  if (srcEl) {
    if (hasData) {
      srcEl.style.display = ''
      srcEl.textContent = usageSource === 'mavis-db' ? 'mavis db' : (isEstimated ? '估算' : 'mcode')
      srcEl.title = usageSource === 'mavis-db'
        ? '数据源: mavis 桌面端 sqlite db (C:\\Users\\mjc39\\.minimax\\v2\\sqlite\\runtime-state.sqlite)'
        : (isEstimated
            ? '估算: mcode 0.1.4 不返 usage, 临时估算'
            : '数据源: mcode 0.1.5+ 直接返回的 usage')
      srcEl.className = 'kv-usage-source ' + (usageSource === 'mavis-db' ? 'real' : (isEstimated ? 'estimate' : 'mcode'))
    } else {
      srcEl.style.display = 'none'
    }
  }
  // v0.5.bx-10: mavis model — 拿不到就隐藏
  const mdlEl = document.getElementById('r-mavis-model')
  if (mdlEl) {
    const m = state?.usage?.mavisModel
    if (hasData && m) {
      mdlEl.style.display = ''
      mdlEl.textContent = m
      mdlEl.title = `mavis db 记录的真实 model (mavis db model 字段)`
    } else {
      mdlEl.style.display = 'none'
    }
  }
  // v0.5.bx-10: cache chip — 显示多少 token 是从 cache 来的 (input 的子集, 不算 context)
  // v0.5.bx-20: 主显示改 "cache 89%" 命中率, hover 显示详细数字 — Ponkan 反馈
  //   mavis db schema: input_tokens = "新" input, cache_read_tokens = 从 cache 读, 真实 total = 两者之和
  //   真实命中率 = cache_read / (input + cache_read) — server 算好塞 cs.usage.sessionCacheHitRate
  const cacheEl = document.getElementById('r-cache-read')
  if (cacheEl) {
    const cr = state?.usage?.sessionCacheRead
    const cw = state?.usage?.sessionCacheWrite
    const hitRate = state?.usage?.sessionCacheHitRate
    if (hasData && (cr > 0 || cw > 0)) {
      cacheEl.style.display = ''
      // 主显示: 命中率 (重点) + 数字 ↓
      // v0.5.bx-20 (改): 用 i18n key r_cache 跟其他 label 走 — zh="缓存 70%", en="cache 70%"
      //   命中率有值就显示 "缓存 70%", 没有就降级显示原 "缓存 ↓609.9k"
      const cacheLabel = t('r_cache') || 'cache'
      if (typeof hitRate === 'number' && hitRate > 0) {
        const pct = Math.round(hitRate * 100)
        cacheEl.textContent = `${cacheLabel} ${pct}%`
      } else {
        let parts = []
        if (cr > 0) parts.push(`↓${formatNumber(cr)}`)
        if (cw > 0) parts.push(`↑${formatNumber(cw)}`)
        cacheEl.textContent = `${cacheLabel} ${parts.join('/')}`
      }
      // hover: 显示详细 — 命中率公式 + 数字
      let titleParts = []
      if (typeof hitRate === 'number' && hitRate > 0) {
        titleParts.push(`真实 cache 命中率 (累计): ${(hitRate * 100).toFixed(1)}% = cache_read / (input + cache_read)`)
      }
      if (cr > 0) titleParts.push(`↓ ${formatNumber(cr)} tokens 从 cache 读 (input 子集, 不计入 context)`)
      if (cw > 0) titleParts.push(`↑ ${formatNumber(cw)} tokens 写入 cache`)
      cacheEl.title = titleParts.join('\n')
    } else {
      cacheEl.style.display = 'none'
    }
  }
  document.getElementById('r-percent').textContent = hasData
    ? (limit > 0 ? `${percent.toFixed(1)}%` : '—')
    : '—'
  const bar = document.getElementById('r-context-bar')
  if (bar) {
    bar.style.width = hasData ? `${Math.min(100, percent)}%` : '0%'
    bar.classList.remove('high', 'danger', 'estimated')
    if (hasData && percent > 80) bar.classList.add('danger')
    else if (hasData && percent > 50) bar.classList.add('high')
    if (hasData && isEstimated) bar.classList.add('estimated')
  }

  document.getElementById('r-tps').textContent = ctx.tps || '—'
}

function renderGoal() {
  const section = document.getElementById('r-goal-section')
  const g = state?.goal
  if (g && g.active) {
    section.hidden = false
    const status = g.status || 'Active'
    const badge = document.getElementById('r-goal-status')
    badge.textContent = t(status === 'Active' ? 'goal_active' : status === 'Complete' ? 'goal_complete' : status === 'Paused' ? 'goal_paused' : status)
    badge.classList.toggle('complete', status === 'Complete')
    badge.classList.toggle('paused', status === 'Paused')
    document.getElementById('r-goal-text').textContent = g.text || '—'
    document.getElementById('r-goal-duration').textContent = g.duration ? `已运行 ${g.duration}` : ''
  } else {
    section.hidden = true
  }
}

function renderTodo() {
  const section = document.getElementById('r-todo-section')
  const list = state?.todo || []
  if (list.length > 0) {
    section.hidden = false
    const html = list.map(item => `
      <div class="todo-item ${item.status}">
        <span class="todo-marker">${item.status === 'done' ? '✓' : item.status === 'failed' ? '✗' : '○'}</span>
        <span class="todo-text">${escapeHtml(item.text)}</span>
      </div>
    `).join('')
    document.getElementById('r-todo-list').innerHTML = html
  } else {
    section.hidden = true
  }
}

// v0.5.ar: 已折叠的工作区（localStorage 持久化）
let collapsedWorkspaces = (() => {
  try { return new Set(JSON.parse(localStorage.getItem('webui_ws_collapsed_v1') || '[]')) } catch { return new Set() }
})()

// v0.5.bx-31: sidebar 首次 SSE 推 mcodeSessions 之前显示 skeleton, 避免点删除/切时 race
//   mcode acp singleton 启动要 1-3s, 期间 state.mcodeSessions=[] → render 显示空
//   用户在空 sidebar 上点删除 webui entry, mcode db 的对应 session 没删 → SSE 推过来时"又出现"
//   sidebarReady=false 时 renderSessions 显示 skeleton + 全部 click 不绑
//   SSE 推过来 mcodeSessions.length>0 时设 true (模块级 let, 跨 render 共享)
let sidebarReady = false
function saveCollapsedWorkspaces() {
  try { localStorage.setItem('webui_ws_collapsed_v1', JSON.stringify([...collapsedWorkspaces])) } catch {}
}

// 取工作区短名（最后一段路径）— 桌面端风格显示
function wsShortName(ws) {
  if (!ws) return t('workspace_unset_short')
  // 去掉尾部斜杠
  let s = ws.replace(/[\\/]+$/, '')
  if (!s) return t('workspace_unset_short')
  // 取最后一段
  const parts = s.split(/[\\/]/)
  return parts[parts.length - 1] || s
}

function renderSessions() {
  console.log('[webui] renderSessions: state.sessions=' + (state?.sessions?.length || 0) + ' mcodeSessions=' + (state?.mcodeSessions?.length || 0) + ' sidebarReady=' + sidebarReady)
  const list = document.getElementById('sessions-list')
  // v0.5.bx-31: 首次 SSE 推 mcodeSessions 之前显示 skeleton, 禁用全部 click
  //   等 SSE 推过来 mcodeSessions 第一次非空时, 消息处理那边会设 sidebarReady=true
  if (!sidebarReady) {
    list.innerHTML = `
      <div class="session-skeleton">
        <div class="session-skeleton-line"></div>
        <div class="session-skeleton-line short"></div>
        <div class="session-skeleton-line"></div>
        <div class="session-skeleton-line short"></div>
        <div class="session-skeleton-line"></div>
        <div class="session-skeleton-line short"></div>
      </div>
      <div class="session-skeleton-hint">${t('sidebar_loading') || '加载会话中…'}</div>
    `
    return
  }
  // v0.5.bv: 优先显示 mcode 真实 sessions（mvs_xxx id + mcode 自动 title）
  // 合并：mcode sessions (按 cwd 过滤) + webui 自己的 sessions (还没跟 mcode 关联的)
  const mcodeSessions = Array.isArray(state?.mcodeSessions) ? state.mcodeSessions : []
  const webuiSessions = Array.isArray(state?.sessions) ? state.sessions : []
  // 用 webui session 的 mcodeSessionId 字段去重：mcode 有但 webui 也有的就归 mcode
  const webuiWithMcode = new Set()
  const merged = []
  for (const ms of mcodeSessions) {
    webuiWithMcode.add(ms.sessionId)
    merged.push({
      id: ms.sessionId,           // mcode session id (mvs_xxx)
      kind: 'mcode',
      title: ms.title || '(untitled)',
      workspace: ms.cwd || '',
      updatedAt: ms.updatedAt || 0,
    })
  }
  for (const ws of webuiSessions) {
    if (ws.mcodeSessionId && webuiWithMcode.has(ws.mcodeSessionId)) continue  // 已在 mcode 列表里
    if (ws.mcodeSessionId) {
      // webui 有 mcodeSessionId 但 mcode list 里没出现（可能 mcode 那边已删）— 仍显示
      merged.push({
        id: ws.mcodeSessionId, kind: 'webui-mcode', title: ws.title || '(untitled)',
        workspace: ws.workspace || '', updatedAt: ws.updatedAt || 0,
      })
    } else {
      // webui session 还没 prompt 过（无 mcode 关联）— 用 webui id 显示
      merged.push({
        id: ws.id, kind: 'webui', title: ws.title || '(untitled)',
        workspace: ws.workspace || '', updatedAt: ws.updatedAt || 0,
      })
    }
  }
  const sessions = merged
  // v0.5.bx-31: currentWs 改用 state.lastUsedWorkspace (独立字段)
  //   之前用 state.workspace.dir, 但 server 切 session 会同步改它 (v0.5.ar),导致 sidebar 排序把该工作区置顶
  //   现在 server 切 session 只写 lastUsedWorkspace,state.workspace.dir 保持不变 (chip-workspace 跟它无关)
  //   第一次 (没切过) lastUsedWorkspace=null, fallback 到 state.workspace.dir (chip 当前显示的工作区)
  const currentWs = (state && state.lastUsedWorkspace) || (state && state.workspace && state.workspace.dir) || ''
  const q = (sessionSearchQuery || '').trim().toLowerCase()
  let filtered = sessions
  if (q) {
    filtered = sessions.filter(s => {
      const title = (s.title || s.id || '').toLowerCase()
      return title.includes(q) || s.id.toLowerCase().includes(q)
    })
  }
  if (filtered.length === 0) {
    const msg = q ? (currentLang === 'zh' ? '没有匹配的会话' : 'No matching sessions') : t('no_sessions')
    list.innerHTML = `<div class="session-title-empty">${msg}</div>`
    return
  }
  // 按 workspace 分组
  const groups = new Map()
  for (const s of filtered) {
    const ws = (s.workspace || '').trim() || t('workspace_unset')
    if (!groups.has(ws)) groups.set(ws, [])
    groups.get(ws).push(s)
  }
  // v0.5.bx-31: 子分类置顶 — group 内按 updatedAt desc 排序
  //   之前没做, 最近触发的对话不排到第一位
  for (const [ws, items] of groups) {
    items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }
  const sortedKeys = [...groups.keys()].sort((a, b) => {
    if (a === currentWs) return -1
    if (b === currentWs) return 1
    const aMax = Math.max(...groups.get(a).map(s => s.updatedAt || 0))
    const bMax = Math.max(...groups.get(b).map(s => s.updatedAt || 0))
    return bMax - aMax
  })
  const folderSvg = '<svg class="icon workspace-group-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
  const html = sortedKeys.map(ws => {
    const items = groups.get(ws)
    const isCurrent = ws === currentWs
    const collapsed = collapsedWorkspaces.has(ws)
    const headerClass = `workspace-group${collapsed ? ' collapsed' : ''}`
    const badge = isCurrent ? `<span class="workspace-group-current-badge">${t('workspace_current')}</span>` : ''
    const itemsHtml = items.map(s => {
      // v0.5.bv: 空 title fallback 到 (untitled)，避免 mcode 端没生成时显示空
      const title = (s.title && s.title.trim()) || '(untitled)'
      const short = escapeHtml(title.substring(0, 28))
      // v0.5.bv: active 判断用 mcodeSessionId（mcode sessions）或 webui sessionId（webui sessions）
      const activeId = state?.mcodeSessionId || state?.sessionId
      const active = s.id === activeId ? ' active' : ''
      // mcode session id (mvs_xxx) 跟 webui randomUUID 一视同仁 — 都显示 12 字符 + 后缀
      const idLabel = escapeHtml(s.id.substring(0, 12) + '…')
      // v0.5.bx-24 (改): mcode session 也显示 X 按钮 — server DELETE 端点 v0.5.bx-5/bx-19 已支持 mvs_xxx 直接 SQL 删 mcode db
      //   之前 v0.5.bv 写死不显示是因为 webui 没能力删 mcode session; 现在能了
      //   删 mcode session 走 server DELETE → SQL 删 mcode db (8 张表事务), 不依赖 mcode TUI
      const deleteBtn = `<button class="session-delete" data-id="${escapeHtml(s.id)}" title="${t('session_delete')}">×</button>`
      return `<div class="session-item${active}" data-id="${escapeHtml(s.id)}" data-kind="${s.kind}" title="${escapeHtml(title)}">
        <div class="session-dot"></div>
        <div class="session-info">
          <div class="session-name">${short}</div>
          <div class="session-id">${idLabel}</div>
        </div>
        ${deleteBtn}
      </div>`
    }).join('')
    return `<div class="${headerClass}" data-ws="${escapeHtml(ws)}">
      <div class="workspace-group-header" data-ws="${escapeHtml(ws)}">
        <span class="workspace-group-chevron">▼</span>
        ${folderSvg}
        <span class="workspace-group-name" title="${escapeHtml(ws)}">${escapeHtml(wsShortName(ws))}</span>
        <span class="workspace-group-count">${items.length}</span>
        ${badge}
      </div>
      <div class="workspace-group-items">${itemsHtml}</div>
    </div>`
  }).join('')
  list.innerHTML = html

  // 点击 group header 折叠/展开
  list.querySelectorAll('.workspace-group-header').forEach(h => {
    h.addEventListener('click', (e) => {
      // 防止误点 group 内的 session 时触发
      if (e.target.closest('.session-item')) return
      const ws = h.getAttribute('data-ws')
      const group = h.closest('.workspace-group')
      if (!group) return
      if (collapsedWorkspaces.has(ws)) {
        collapsedWorkspaces.delete(ws)
        group.classList.remove('collapsed')
      } else {
        collapsedWorkspaces.add(ws)
        group.classList.add('collapsed')
      }
      saveCollapsedWorkspaces()
    })
  })

  // 点击 session：切到那个 session
  list.querySelectorAll('.session-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.session-delete') || e.target.closest('.session-confirm')) return
      const id = el.getAttribute('data-id')
      switchSession(id)
    })
  })
  // 删除按钮：第一次点显示二次确认，第二次点确认按钮才真删
  list.querySelectorAll('.session-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation()
      const item = btn.closest('.session-item')
      if (item.classList.contains('confirming')) return
      item.classList.add('confirming')
      const bar = document.createElement('div')
      bar.className = 'session-confirm'
      bar.innerHTML = `<span>${t('session_delete_confirm')}</span><button class="session-confirm-yes" data-id="${btn.getAttribute('data-id')}">${t('session_delete_yes')}</button><button class="session-confirm-no" title="${t('session_delete_cancel')}">×</button>`
      item.appendChild(bar)
      const timer = setTimeout(() => cancelConfirm(item), 5000)
      item._confirmTimer = timer
      bar.querySelector('.session-confirm-yes').addEventListener('click', async (ev) => {
        ev.stopPropagation()
        clearTimeout(timer)
        const id = btn.getAttribute('data-id')
        await deleteSession(id)
      })
      bar.querySelector('.session-confirm-no').addEventListener('click', (ev) => {
        ev.stopPropagation()
        clearTimeout(timer)
        cancelConfirm(item)
      })
    })
  })
}

async function refreshSessions() {
  const btn = document.getElementById('btn-refresh-sessions')
  if (btn) { btn.disabled = true; btn.classList.add('loading') }
  try {
    // 双通道：先 mavis CLI（独立、快），再 mcode /sessions（兜底）
    let got = false
    try {
      const r = await fetch('/api/sessions' + API_SUFFIX, { method: 'GET', headers: HEADERS })
      if (r.ok) {
        const data = await r.json()
        if (data.ok && data.sessions && data.sessions.length > 0) {
          state = state || {}
          state.sessions = data.sessions
          render()
          got = true
        }
      }
    } catch {}
    if (!got) {
      // fallback: 触发 mcode /sessions
      try { await fetch('/api/sessions' + API_SUFFIX, { method: 'POST', headers: HEADERS }) } catch {}
    }
  } finally {
    if (btn) { btn.disabled = false; btn.classList.remove('loading') }
  }
}

// v0.5.x: 点击 sidebar session 切到该会话（#1 反馈修复）
function cancelConfirm(item) {
  if (!item) return
  if (item._confirmTimer) clearTimeout(item._confirmTimer)
  item.classList.remove('confirming')
  const bar = item.querySelector('.session-confirm')
  if (bar) bar.remove()
}

async function deleteSession(sessionId) {
  if (!sessionId) return
  try {
    const r = await fetch('/api/sessions/' + encodeURIComponent(sessionId) + API_SUFFIX, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
    })
    if (r.ok) {
      const data = await r.json().catch(() => ({}))
      // v0.5.bx-5: 同时按 webui id 和 mcodeSessionId 过滤（孤儿 webui-mcode session 的 id 是 mvs_xxx）
      state.sessions = (state.sessions || []).filter(s => s.id !== sessionId && s.mcodeSessionId !== sessionId)
      // v0.5.bx-31: 同时清 mcodeSessions (mvs_xxx id), 避免 SSE 推过来时"删了又出现"
      //   server 端 mcode acp cache 30s 内可能还有这 session, invalidate 后下次 list 才彻底干净
      //   但 mcodeSessions 是 server 推送的, 下次 push 会覆盖整个 state; 本地提前 filter 避免闪动
      state.mcodeSessions = (state.mcodeSessions || []).filter(s => s.sessionId !== sessionId)
      renderSessions()
      // 触发 SSE 拉取最新 state（包括 current session 是否被清空）
      // （SSE 会自动推送，但 pushState 已被 server 调过——等下一次刷新也行）
    } else {
      console.error('deleteSession failed', r.status, await r.text())
    }
  } catch (e) { console.error('deleteSession', e) }
}

async function switchSession(sessionId) {
  if (!sessionId) return
  try {
    const r = await fetch('/api/sessions/switch' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ id: sessionId }),
    })
    if (r.ok) {
      const data = await r.json()
      if (data.ok) {
        // 直接用 server 返回的 session 数据更新本地 state（避免 SSE race condition）
        state.sessionId = data.session.id
        state.sessionTitle = data.session.title
        // v0.5.bx-20 (改): 切 session 不再关闭 ask_user 弹窗 — Ponkan 反馈
        //   "切换对话再切回来也保留弹窗" → 弹窗绑 module-level, 切走不清
        //   v0.5.bx-15 改 #4 移除 (之前是切 session 关弹窗, 行为反了)
        // v0.5.bx-25 (改): 切 session 关掉旧 session 的弹窗 — Ponkan 反馈
        //   "触发问题弹窗后, 切到其他对话, 弹窗还在" — 弹窗应属于触发它的 session, 切走就关
        //   跟 v0.5.bx-20 "保留弹窗" 立场相反, 但 v0.5.bx-20 时 Ponkan 没表达"切走也要保留", 是 v0.5.bx-15 改 #4 那次的原话误读
        //   现在按 "弹窗属于触发它的 session" 理解: 切走关, 切回不自动重弹 (主动点 inline ask indicator 才重开)
        if (typeof closeAskModal === 'function') {
          closeAskModal()
        }
        // v0.5.bx-24 (改): 触发 2s suppress, 避免新 session 立即 re-render 历史 ask_user 块时弹窗
        //   "明明历史对话最新的没有提问, 为什么还会弹" — 切到历史 session, 历史 ask_user 块被 parseChatLines
        //   解析为 latestAskIdx, openAskModal 弹窗. suppress 2s 让 user 先看 chat, 2s 后再弹 (如果 mcode 真在等 answer)
        if (typeof suppressAskModal === 'function') {
          suppressAskModal()
        }
        // v0.5.bx: 也同步 mcodeSessionId（之前没同步，sidebar 切后 state.mcodeSessionId 还是旧的）
        if (data.session.mcodeSessionId !== undefined) {
          state.mcodeSessionId = data.session.mcodeSessionId || null
        }
        // 关键：从 db 加载该 session 的历史 chat
        state.chat = Array.isArray(data.session.chat) ? data.session.chat : []
        // v0.5.bx-26: 把新 session chat history 里的 ask_user 块标"已答 (skipped)"
        //   切 session 后, renderChat 重新跑会调 openAskModal (source='render')
        //   如果新 session chat 里有 ask_user 块, 又会弹窗
        //   提前给 state.askUserAnswers 设占位, openAskModal allAnswered 检查会跳过
        //   不持久化 (saveAskUserAnswers 不调) — 只在内存里, 跨 session 共享
        //   click 来源 (user 主动点 inline ask indicator) 跳过此检查, 仍能打开
        if (Array.isArray(state.chat)) {
          if (!state.askUserAnswers) state.askUserAnswers = {}
          for (const line of state.chat) {
            if (typeof line !== 'string' || !line.includes('→ ask_user')) continue
            // chat 行格式: "→ ask_user  {\"mode\":\"questionnaire\",\"title\":\"...\",\"steps\":[{...}]}"
            // 提取 question 文本 — 支持单/多 step
            const stepMatches = line.match(/"question"\s*:\s*"([^"]+)"/g) || []
            for (const m of stepMatches) {
              const qm = m.match(/"question"\s*:\s*"([^"]+)"/)
              if (qm && qm[1] && !state.askUserAnswers[qm[1]]) {
                state.askUserAnswers[qm[1]] = { answer: '未回答', mode: 'skipped' }
              }
            }
          }
        }
        renderSessions()
        render()
      } else {
        console.error('switchSession data error', data.error)
      }
    } else {
      console.error('switchSession failed', r.status)
    }
  } catch (e) { console.error('switchSession', e) }
}

function renderUserFooter() {
  // v0.5.ak: 完全改用动态有效信息
  // 第 1 行（粗体）：实时状态 + 短 session id（mcode session 而不是 webui session）
  //   不显示 model name（已在右栏）+ 不显示 sessionTitle（已在左栏最近会话）
  // 第 2 行（灰）：当前时间 + 累计 chat lines 数（实时变）
  const running = state?.running?.active
  const tps = state?.running?.tps || 0
  const thinkingStatus = state?.context?.thinkingStatus || 'Idle'
  let status, dot
  if (running && thinkingStatus === 'Running') { status = '运行中'; dot = '🔵' }
  else if (running && thinkingStatus === 'Loading') { status = '加载中'; dot = '🟡' }
  else if (thinkingStatus && thinkingStatus !== 'Idle') { status = thinkingStatus; dot = '🟡' }
  else { status = '空闲'; dot = '🟢' }
  // mcode session 短 hash（12 字符）— 让用户知道现在用哪个 mcode 会话
  const mcodeSid = state?.mcodeSessionId || ''
  const sidShort = mcodeSid ? mcodeSid.substring(0, 12) : '—'
  const tpsSuffix = running && tps > 0 ? ` · ${tps}tps` : ''
  const name = `${dot} ${status} · ${sidShort}${tpsSuffix}`
  const avatar = (state?.context?.thinkingStatus === 'Running') ? '⋯' : 'M'
  document.getElementById('user-avatar').textContent = avatar
  document.getElementById('user-name').textContent = name
  // 第 2 行：当前时间 + 累计 chat 行数（实时变）
  const chatLines = (state?.chat || []).filter(l => l && l.trim()).length
  const now = new Date()
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const timeStr = `${hh}:${mm}`
  const planLine = `${timeStr} · ${chatLines} 行`
  document.getElementById('user-plan').textContent = planLine
}

// v0.5.ak: User footer 已改为静态 GitHub 链接，renderUserFooter / startUserFooterTicker 不再需要
// 保留 renderUserFooter 旧定义兼容（CSS 已 hide 其内容），但不再被调用

function renderChat() {
  const inner = document.getElementById('chat-inner')
  const empty = document.getElementById('chat-empty')
  let lines = state?.chat || []
  // 过滤掉 mcode TUI 的 placeholder / 空 prompt 标记（shim 偶尔会误抓）
  lines = lines.filter(l => {
    if (!l) return false
    const t = l.trim()
    if (!t) return false
    if (/^Message\s*·\s*Enter\s*send/i.test(t)) return false
    if (/Shift\+Enter\s*newline/i.test(t)) return false
    if (/^Start\s*[·•]/i.test(t)) return false
    if (/^autocomplete\s*[·•]/i.test(t)) return false
    if (/^@ file\s*[·•]/i.test(t)) return false
    if (/^Ready$/i.test(t)) return false
    // 空 prompt 标记：只有 › / ● / ○ / > 但没内容
    if (/^[›>●•○◯]\s*$/.test(t)) return false
    return true
  })
  if (lines.length === 0) {
    if (empty) empty.style.display = ''
    // v0.5.x: 切到空 chat 的 session 时必须清空 inner，否则会残留上一个 session 的 messages
    if (inner) inner.innerHTML = ''
    // v0.5.ae: 空 chat 时清空 right panel todo
    if (state) { state.todo = []; renderTodo() }
    // v0.5.ax: 欢迎页时隐藏右侧栏
    hideRightForWelcome(true)
    // v0.5.bd: 切到欢迎页布局（chat-empty + input-area 居中堆叠）
    const chatArea = document.getElementById('chat-area')
    if (chatArea) chatArea.classList.add('is-welcome')
    // v0.5.bx: 欢迎页才显示"选工作区"chip，已有对话时整个 row 隐藏
    const wsRow = document.getElementById('input-workspace-row')
    if (wsRow) wsRow.hidden = false
    // v0.5.bx-2: mcode session 切过来 + chatLen=0（acp session/load 不带 chat 历史）→ 显示"已切到 mcode session,没历史"空状态
    // 区别于 welcome 页（无 mcodeSessionId）
    if (state && state.mcodeSessionId && state.sessionTitle) {
      if (inner) {
        inner.innerHTML = `<div class="chat-empty-mcode">
          <div class="chat-empty-mcode-icon">📭</div>
          <div class="chat-empty-mcode-title">${escapeHtml(state.sessionTitle)}</div>
          <div class="chat-empty-mcode-text">已切到这个 mcode session，但 webui 没有它的历史 chat。</div>
          <div class="chat-empty-mcode-hint">mcode acp <code>session/load</code> 协议不返回历史消息，只在 mcode TUI 里能看。发新消息会续接这个 mcode session。</div>
        </div>`
      }
      return
    }
    return
  }
  if (empty) empty.style.display = 'none'
  // v0.5.ax: 欢迎页隐藏右侧栏（chat-area 居中）
  hideRightForWelcome(false)
  // v0.5.bd: 退出欢迎页布局（恢复 input-area 吸底）
  const chatArea2 = document.getElementById('chat-area')
  // v0.5.bx: 有对话时隐藏"选工作区"chip — 已选工作区不让改，要改点 sidebar "New Chat"
  const wsRow2 = document.getElementById('input-workspace-row')
  if (wsRow2) wsRow2.hidden = true
  if (chatArea2) chatArea2.classList.remove('is-welcome')

  // Parse chat lines into messages
  const messages = parseChatLines(lines)
  // v0.5.bx-20: 找"最新"包含 ask_user tool 的 message index — 只有它能弹窗
  //   旧 chat history 里的 ask_user 全部不弹, 避免 mcode LLM 死循环反复弹同一题
  let latestAskIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'tool' && messages[i].name === 'ask_user') {
      latestAskIdx = i
      break
    }
  }
  // 渲染时把 isLatestAsk 透传给 renderMessage
  inner.innerHTML = messages.map((m, i) => renderMessage(m, { isLatestAsk: i === latestAskIdx })).join('')
  // v0.5.ab: 绑定 Ask/Plan 块的点击事件（事件委托）
  attachStructuredBlockHandlers(inner)
  // v0.5.ae: 把 chat 内的 todo block 实时同步到 state.todo（right panel 用）
  // dedup by text：同一个 todo 在多轮里可能重复，最后一次状态生效
  if (state) {
    const todos = []
    const seen = new Set()
    for (const m of messages) {
      if (m.role === 'todo' && Array.isArray(m.items)) {
        for (const it of m.items) {
          if (it && it.text && !seen.has(it.text)) {
            seen.add(it.text)
            todos.push(it)
          }
        }
      }
    }
    state.todo = todos
    renderTodo()
  }
  // scroll to bottom
  const scroll = document.getElementById('chat-scroll')
  scroll.scrollTop = scroll.scrollHeight
}

// v0.5.ab: 事件委托 — Ask 选项点击发送 / Plan 选项点击发送 / "查看完整计划" 打开弹窗
function attachStructuredBlockHandlers(root) {
  if (!root) return
  // v0.5.bx-13: click inline ask indicator → 重新打开弹窗
  root.querySelectorAll('.msg-ask-indicator').forEach(el => {
    el.addEventListener('click', () => {
      // 找最近的 tool 块 (data-ask-tool 属性保存了 first question)
      const q = el.getAttribute('data-ask-tool') || ''
      if (!q) return
      // 从 state.askUserAnswers 反查 pq
      // 简单做法: 找当前 chat 里最新的同 question 的 tool
      if (state?.chat) {
        // 暂时重新解析整个 chat 找 pq
        const lines = state.chat
        for (let i = lines.length - 1; i >= 0; i--) {
          if (lines[i] && lines[i].includes('→ ask_user')) {
            // 用 parseChatLines 太重, 这里只重新打开 — 弹窗里的答案会从 state.askUserAnswers 读
            // openAskModal 内部会用 state.askUserAnswers 状态判断是否已答
            // 构造一个最小的 pq
            // v0.5.bx-20: source:'click' 不受 isLatestAsk 限制 — 主动点历史 ask indicator 应能重新打开
            const fakePq = { steps: [{ question: q, options: [] }], mode: 'single' }
            openAskModal(fakePq, { source: 'click' })
            return
          }
        }
      }
    })
  })
  // Ask 选项
  root.querySelectorAll('.ask-option').forEach(el => {
    el.addEventListener('click', () => {
      const label = el.getAttribute('data-ask-opt') || ''
      const isOther = el.getAttribute('data-ask-other') === '1'
      if (isOther) {
        // "Other" 自由输入：弹个小输入框在 chat 里
        const input = prompt('请输入自定义回答：', '')
        if (input == null) return
        sendAskAnswer(input)
      } else {
        sendAskAnswer(label)
      }
    })
  })
  // Plan 选项（Agree/Skip/Revise）
  root.querySelectorAll('[data-plan-opt]').forEach(el => {
    el.addEventListener('click', () => {
      const text = el.getAttribute('data-plan-opt') || ''
      sendPlanAnswer(text)
    })
  })
  // Plan 弹窗
  root.querySelectorAll('[data-plan-view]').forEach(el => {
    el.addEventListener('click', () => {
      const title = el.getAttribute('data-plan-view') || ''
      // 从 messages 中找到这个 plan 的 content
      const planMsg = (state?.chat ? parseChatLines(state.chat) : []).find(m => m.role === 'plan' && m.title === title)
      if (planMsg) openPlanModal(planMsg)
    })
  })
  // v0.5.bx-6: tool 涉及的本地文件路径 — 点击复制到剪贴板
  root.querySelectorAll('.msg-tool-loc').forEach(el => {
    el.addEventListener('click', async () => {
      const p = el.getAttribute('data-path') || ''
      if (!p) return
      try {
        await navigator.clipboard.writeText(p)
        el.classList.add('copied')
        setTimeout(() => el.classList.remove('copied'), 800)
      } catch (e) {
        // fallback: 用 textarea 选中文本
        const ta = document.createElement('textarea')
        ta.value = p
        ta.style.position = 'fixed'
        ta.style.opacity = '0'
        document.body.appendChild(ta)
        ta.select()
        try { document.execCommand('copy') } catch {}
        document.body.removeChild(ta)
      }
    })
  })
  // v0.5.bx-7: ask_user 问卷选项 — 点击 label 作为下一次 prompt 发给 mcode
  // v0.5.bx-8: 单 step 模式选项 click 自动 send; 多 step 模式选项 click 只 highlight, 等底部"发送"按钮模板化发
  //   状态持久化到 state.askUserAnswers (跨 render 保留, 不被 parseChatLines 重建对象丢)
  root.querySelectorAll('.ask-questionnaire').forEach(questionnaire => {
    const mode = questionnaire.getAttribute('data-mode') || 'single'

    // 选项 click
    questionnaire.querySelectorAll('.ask-opt').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (btn.disabled) return
        const label = btn.getAttribute('data-ask-label') || ''
        const q = btn.getAttribute('data-ask-q') || ''
        if (!label) return
        if (!state.askUserAnswers) state.askUserAnswers = {}
        if (state.askUserAnswers[q]) return  // 已答过
        // 持久化 (state + localStorage)
        setAskUserAnswer(q, { answer: label, mode: 'answered' })
        // 清 pending (只清 single step 模式的)
        if (mode === 'single' && state?.pendingAskUser) {
          state.pendingAskUser = null
        }
        if (mode === 'single') {
          // 单 step: 选项 click 自动 send
          const prompt = `Q: ${q}\nA: ${label}`
          try {
            const r = await fetch('/api/send' + API_SUFFIX, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...HEADERS },
              body: JSON.stringify({ content: prompt, command: 'prompt' })
            })
            if (!r.ok) console.warn('[ask-opt] send failed', r.status)
          } catch (e) { console.error('[ask-opt] send error', e) }
        } else {
          // 多 step: 只 highlight, 不发
        }
        renderAskUserToolIfChanged()
      })
    })

    // 跳过按钮 (单 step 模式)
    if (mode === 'single') {
      const skipBtn = questionnaire.querySelector('.ask-skip')
      if (skipBtn) {
        skipBtn.addEventListener('click', async () => {
          if (skipBtn.disabled) return
          // v0.5.bx-8: .ask-skip 自身有 data-ask-q, 直接读
          const q = skipBtn.getAttribute('data-ask-q') || ''
          if (!q) return
          if (!state.askUserAnswers) state.askUserAnswers = {}
          if (state.askUserAnswers[q]) return
          setAskUserAnswer(q, { answer: '未回答', mode: 'skipped' })
          if (state?.pendingAskUser) state.pendingAskUser = null
          // 自动 send "Q: ... A: 未回答"
          const prompt = `Q: ${q}\nA: 未回答`
          try {
            const r = await fetch('/api/send' + API_SUFFIX, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...HEADERS },
              body: JSON.stringify({ content: prompt, command: 'prompt' })
            })
            if (!r.ok) console.warn('[ask-skip] send failed', r.status)
          } catch (e) { console.error('[ask-skip] send error', e) }
          renderAskUserToolIfChanged()
        })
      }
    }

    // "其他"输入框 input 监听 — 设 state.askUserAnswers (highlight 当前 step 的回答为"其他")
    questionnaire.querySelectorAll('.ask-step-other-input').forEach(input => {
      const update = () => {
        const step = input.closest('.ask-step')
        const firstOpt = step?.querySelector('.ask-opt')
        const q = firstOpt ? firstOpt.getAttribute('data-ask-q') : ''
        if (!q) return
        if (!state.askUserAnswers) state.askUserAnswers = {}
        const text = input.value.trim()
        if (text) {
          setAskUserAnswer(q, { answer: text, mode: 'answered-other' })
        } else {
          // 清空 = 清除"其他"回答 (回到未答)
          if (state.askUserAnswers[q]?.mode === 'answered-other') {
            setAskUserAnswer(q, null)  // null = 删除
          }
        }
        // 只 highlight, 不发 (也不重渲染 — input 事件触发太频繁, 直接改 class)
        // 重渲染只更新样式, 不发请求
        if (mode === 'single') {
          // 单 step: 清除其他选项的 .clicked
          step.querySelectorAll('.ask-opt').forEach(o => o.classList.remove('clicked'))
        }
        renderAskUserToolIfChanged()
      }
      input.addEventListener('input', update)
      input.addEventListener('change', update)
      // Enter 键 — 单 step 模式自动 send, 多 step 模式只 highlight (再点发送才发)
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          if (mode === 'single') {
            const text = input.value.trim()
            if (!text) return
            // 走 sendAskUserAnswer
            const step = input.closest('.ask-step')
            const firstOpt = step?.querySelector('.ask-opt')
            const q = firstOpt ? firstOpt.getAttribute('data-ask-q') : ''
            if (!q) return
            if (!state.askUserAnswers) state.askUserAnswers = {}
            setAskUserAnswer(q, { answer: text, mode: 'answered-other' })
            if (state?.pendingAskUser) state.pendingAskUser = null
            const prompt = `Q: ${q}\nA: ${text}`
            fetch('/api/send' + API_SUFFIX, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...HEADERS },
              body: JSON.stringify({ content: prompt, command: 'prompt' })
            }).then(r => {
              if (!r.ok) console.warn('[ask-other] send failed', r.status)
            }).catch(e => console.error('[ask-other] send error', e))
            renderAskUserToolIfChanged()
          }
        }
      })
    })

    // 发送按钮 (多 step 模式)
    if (mode === 'multi') {
      const submitBtn = questionnaire.querySelector('.ask-submit')
      if (submitBtn) {
        submitBtn.addEventListener('click', async () => {
          // 收集所有 step 的 answer (没答的 = "未回答")
          const stepEls = questionnaire.querySelectorAll('.ask-step')
          const blocks = []
          for (const stepEl of stepEls) {
            const firstOpt = stepEl.querySelector('.ask-opt')
            const q = firstOpt ? firstOpt.getAttribute('data-ask-q') : ''
            if (!q) continue
            const ans = state?.askUserAnswers?.[q]
            const otherInput = stepEl.querySelector('.ask-step-other-input')
            const otherText = otherInput?.value.trim() || ''
            // 优先用 state.askUserAnswers, 其次从 input 读 (实时未触发 input 事件的情况)
            let finalAnswer
            if (ans && ans.mode === 'skipped') {
              finalAnswer = '未回答'
            } else if (otherText) {
              finalAnswer = otherText
            } else if (ans) {
              finalAnswer = ans.answer
            } else {
              finalAnswer = '未回答'
            }
            blocks.push(`Q: ${q}\nA: ${finalAnswer}`)
            // 持久化到 state + localStorage
            if (!state.askUserAnswers) state.askUserAnswers = {}
            setAskUserAnswer(q, { answer: finalAnswer, mode: otherText ? 'answered-other' : (ans?.mode === 'skipped' ? 'skipped' : 'answered') })
          }
          if (blocks.length === 0) return
          // 清 pending
          if (state?.pendingAskUser) state.pendingAskUser = null
          // 模板化发
          const prompt = blocks.join('\n')
          try {
            const r = await fetch('/api/send' + API_SUFFIX, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...HEADERS },
              body: JSON.stringify({ content: prompt, command: 'prompt' })
            })
            if (!r.ok) console.warn('[ask-submit] send failed', r.status)
          } catch (e) { console.error('[ask-submit] send error', e) }
          renderAskUserToolIfChanged()
        })
      }
    }
  })
}

async function sendAskAnswer(text) {
  // 走 /api/send 通路（跟正常发消息一致）
  // v0.5.bx-13: isAskAnswer:true 告诉 server 不要把 Q/A 当 user message 加到 chat
  const r = await fetch('/api/send' + API_SUFFIX, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...HEADERS },
    body: JSON.stringify({ content: text, command: 'prompt', isAskAnswer: true })
  })
  if (!r.ok) console.warn('sendAskAnswer failed', r.status)
}

// ============================================================
// v0.5.bx-13: ask_user 真弹窗 (替代内嵌 questionnaire)
// - 弹窗打开后, chat 里只显示紧凑 "ask_user · 待答/已答" 标记
// - 选项 / 其他 / 跳过 / 关闭 全部在弹窗里操作
// - 提交后 sendAskAnswer(isAskAnswer:true), server 不把 Q/A 加到 chat
// - 答完自动关弹窗, 重新进来不重复弹
// v0.5.bx-14: 加 presentedKeys 集合 — 同一 ask (pq key) 只弹一次, 进历史 session / re-render 不重弹
// v0.5.bx-15 (改 #3): 加 DISMISSED_QUESTIONS 集合 — 按 question 文本去重 (跨 pq key / 跨 session)
// ============================================================
const ASK_MODAL_STATE = {
  open: false,            // 弹窗当前是否显示
  pqKey: null,            // 当前弹窗对应的 pq 指纹 (steps[0].question 拼接), 用于去重
  pq: null,               // parsedQuestionnaire
  currentStep: 0,         // 多 step 模式下的当前题 index
  answers: {},            // 当前弹窗的临时 answers (question -> {answer, mode})
  presentedKeys: new Set(),  // v0.5.bx-14: 已经"展示过" (弹过/跳过/答过) 的 pq key, 同 key 不重弹
  suppressUntilTs: 0,        // v0.5.bx-24: 切 session 后 2s 内不弹窗 (避免重复弹历史 ask_user)
}
// v0.5.bx-15 (改 #3): module-level "已答过/已 dismiss" 的 question 集合
//   切到任何 mcode session, 该 question 都不会再弹 (即使 pq key 不同)
//   init() 时从 localStorage.askUserAnswers 恢复
const DISMISSED_QUESTIONS = new Set()

function askModalPqKey(pq) {
  if (!pq || !Array.isArray(pq.steps) || pq.steps.length === 0) return null
  return pq.steps.map(s => s.question).join('||')
}

function openAskModal(pq, opts) {
  if (!pq || !Array.isArray(pq.steps) || pq.steps.length === 0) return
  // v0.5.bx-24: 切 session 后 2s 内不弹窗 (suppressUntilTs)
  //   解决"切到历史 session, 历史 ask_user 块立即弹窗"问题
  //   2s 后再弹 (如果 mcode 端真在等 answer, user 切回来看几眼确认是历史 ask 后, 弹窗会自己出)
  if (Date.now() < (ASK_MODAL_STATE.suppressUntilTs || 0)) {
    return
  }
  // v0.5.bx-20: 守卫 — 只有"最新一条 agent 回复"里的 ask_user 才弹窗
  //   旧 chat history 里的 ask 不弹, 避免 mcode LLM 死循环时反复弹同一题
  //   opts = { isLatestAsk: true/false, source: 'render' | 'click' }
  //   'click' 来源 (点 inline ask indicator 重新打开) 不受 isLatestAsk 限制
  const source = (opts && opts.source) || 'render'
  if (source === 'render' && opts && opts.isLatestAsk === false) {
    return  // 历史 ask 不弹窗
  }
  const key = askModalPqKey(pq)
  if (!key) return
  // v0.5.bx-15 (改 #3): 按 question 文本去重 — 切到任何 mcode session, 该 question 都不再弹
  //   即使 mcode 重发不同 pq key 但相同 question 文本, 也视为已 dismiss
  //   (DISMISSED_QUESTIONS 在 init() 从 localStorage 恢复, 在 setAskUserAnswer 加)
  if (pq.steps.every(s => DISMISSED_QUESTIONS.has(s.question))) {
    ASK_MODAL_STATE.presentedKeys.add(key)
    return
  }
  // v0.5.bx-14: 已经"展示过" (弹过/答过/跳过) 的 ask 不再弹 — 解决历史 session / re-render 重复弹窗
  //   同一个 pq key 在整个 session 生命周期只弹一次
  //   想要重新答, 点 chat 里的 inline ask indicator 即可
  if (ASK_MODAL_STATE.presentedKeys.has(key)) {
    // 已经展示过, 什么都不做 (不刷内容, 不重开)
    return
  }
  // v0.5.bx-26: chat history 里的 ask_user 块被切 session 时标"已答 (skipped)" —
  //   render 来源 (source='render') 命中 allAnswered=true 跳过; click 来源跳过此检查
  //   避免 "切到历史 session, 弹窗又开" 的 race
  const allAnswered = pq.steps.every(s => state?.askUserAnswers?.[s.question])
  if (allAnswered && source !== 'click') {
    ASK_MODAL_STATE.presentedKeys.add(key)
    return
  }
  // v0.5.bx-15 (改 #3): 按 question 文本去重 — 切到任何 mcode session, 该 question 都不再弹
  //   即使 mcode 重发不同 pq key 但相同 question 文本, 也视为已 dismiss
  //   (DISMISSED_QUESTIONS 在 init() 从 localStorage 恢复, 在 setAskUserAnswer 加)
  if (pq.steps.every(s => DISMISSED_QUESTIONS.has(s.question))) {
    ASK_MODAL_STATE.presentedKeys.add(key)
    return
  }
  // v0.5.bx-14: 已经"展示过" (弹过/答过/跳过) 的 ask 不再弹 — 解决历史 session / re-render 重复弹窗
  //   同一个 pq key 在整个 session 生命周期只弹一次
  //   想要重新答, 点 chat 里的 inline ask indicator 即可
  if (ASK_MODAL_STATE.presentedKeys.has(key)) {
    // 已经展示过, 什么都不做 (不刷内容, 不重开)
    return
  }
  // 第一次见这个 ask → 标记 + 弹窗
  ASK_MODAL_STATE.presentedKeys.add(key)
  ASK_MODAL_STATE.open = true
  ASK_MODAL_STATE.pqKey = key
  ASK_MODAL_STATE.pq = pq
  ASK_MODAL_STATE.currentStep = 0
  ASK_MODAL_STATE.answers = {}
  const modal = document.getElementById('ask-modal')
  if (modal) modal.style.display = 'flex'
  // v0.5.bx-15 (改 #3): 顶替输入框 — 弹窗出现时 input 区域隐藏
  const inputArea = document.querySelector('.input-area')
  if (inputArea) inputArea.style.display = 'none'
  renderAskModalContent()
}

function closeAskModal() {
  ASK_MODAL_STATE.open = false
  ASK_MODAL_STATE.pq = null
  ASK_MODAL_STATE.pqKey = null
  ASK_MODAL_STATE.currentStep = 0
  ASK_MODAL_STATE.answers = {}
  const modal = document.getElementById('ask-modal')
  if (modal) modal.style.display = 'none'
  // v0.5.bx-15 (改 #3): 恢复输入框
  const inputArea = document.querySelector('.input-area')
  if (inputArea) inputArea.style.display = ''
  // 清空 other input
  const other = document.getElementById('ask-modal-other')
  if (other) other.value = ''
  // v0.5.bx-28: 防御性清 pendingAskUser — 任何关弹窗路径 (X / Esc / 背景 / 切会话) 都要清,
  //   否则 send() 会把后续正常消息包成 Q/A 模板 ("Q: <question>\nA: <user input>")
  //   X / Esc / 背景 现在都绑 closeAskModal (不再过 askModalSkip), 语义是"我放弃这题, 让我正常发消息"
  if (state && state.pendingAskUser) state.pendingAskUser = null
}

// v0.5.bx-14: 清掉"已展示"记录 (调试/重置用, 切 session 时也调, 让历史 ask 重新可答)
// v0.5.bx-24: 加 suppressUntilTs — 切 session 时设 = now + 2s, openAskModal 检查后早 return
//   解决"切 session 立即重弹 ask_user 弹窗"问题 — 切到历史 session, 历史里的 ask_user 块被新 session 解析又弹一次
function clearAskPresentedKeys() {
  ASK_MODAL_STATE.presentedKeys.clear()
}
// v0.5.bx-24: 切 session 后 2s 内不弹 ask_user 弹窗 (给 user 时间看 chat 内容, 不被弹窗打断)
function suppressAskModal() {
  ASK_MODAL_STATE.suppressUntilTs = Date.now() + 2000
}

function renderAskModalContent() {
  const pq = ASK_MODAL_STATE.pq
  if (!pq) return
  const stepIdx = Math.min(ASK_MODAL_STATE.currentStep, pq.steps.length - 1)
  const step = pq.steps[stepIdx]
  if (!step) return
  const isMulti = pq.steps.length > 1
  const counter = document.getElementById('ask-modal-step-counter')
  const qEl = document.getElementById('ask-modal-question')
  const optsEl = document.getElementById('ask-modal-options')
  const sendBtn = document.getElementById('ask-modal-send')
  const other = document.getElementById('ask-modal-other')
  if (counter) counter.textContent = isMulti ? `第 ${stepIdx + 1} / ${pq.steps.length} 题` : ''
  if (qEl) qEl.textContent = step.question
  // 选项
  if (optsEl) {
    if (!Array.isArray(step.options) || step.options.length === 0) {
      optsEl.innerHTML = '<div class="ask-modal-no-options">无预设选项 — 在下方"其他"输入回答后按回车或点"发送"</div>'
    } else {
      const cur = ASK_MODAL_STATE.answers[step.question]
      optsEl.innerHTML = step.options.map((o, oi) => {
        const letter = String.fromCharCode(65 + oi)
        const isPicked = cur && cur.mode === 'answered' && cur.answer === o.label
        return `<button class="ask-modal-opt${isPicked ? ' clicked' : ''}" data-opt-idx="${oi}" data-opt-label="${escapeHtml(o.label)}">
          <span class="ask-modal-opt-letter">${letter}</span>
          <span class="ask-modal-opt-label">${escapeHtml(o.label)}</span>
        </button>`
      }).join('')
    }
  }
  // 恢复 other input (answered-other 模式)
  if (other) {
    const cur = ASK_MODAL_STATE.answers[step.question]
    other.value = (cur && cur.mode === 'answered-other') ? cur.answer : ''
  }
  // 发送按钮文案
  if (sendBtn) {
    if (isMulti) {
      const allDone = pq.steps.every(s => ASK_MODAL_STATE.answers[s.question] || state?.askUserAnswers?.[s.question])
      sendBtn.textContent = allDone ? '已答完 (点重发)' : `发送 (${pq.steps.length} 题)`
    } else {
      sendBtn.textContent = '发送'
    }
  }
}

// 弹窗内选项 click
function onAskModalOptClick(btn) {
  const pq = ASK_MODAL_STATE.pq
  if (!pq) return
  const step = pq.steps[ASK_MODAL_STATE.currentStep]
  if (!step) return
  const label = btn.getAttribute('data-opt-label') || ''
  if (!label) return
  // 设 answer (answered 模式)
  ASK_MODAL_STATE.answers[step.question] = { answer: label, mode: 'answered' }
  // 同步到全局 state.askUserAnswers (持久化)
  if (!state.askUserAnswers) state.askUserAnswers = {}
  setAskUserAnswer(step.question, { answer: label, mode: 'answered' })
  // 单 step: 选项 click 后自动 send
  if (pq.steps.length === 1) {
    submitAskModal()
  } else {
    // 多 step: 高亮 + 不发, 让用户能继续选下一题
    renderAskModalContent()
  }
}

// 弹窗 "其他" input 输入时
function onAskModalOtherInput() {
  const pq = ASK_MODAL_STATE.pq
  if (!pq) return
  const step = pq.steps[ASK_MODAL_STATE.currentStep]
  if (!step) return
  const other = document.getElementById('ask-modal-other')
  if (!other) return
  const text = other.value.trim()
  if (text) {
    ASK_MODAL_STATE.answers[step.question] = { answer: text, mode: 'answered-other' }
    if (!state.askUserAnswers) state.askUserAnswers = {}
    setAskUserAnswer(step.question, { answer: text, mode: 'answered-other' })
  } else {
    delete ASK_MODAL_STATE.answers[step.question]
    if (state.askUserAnswers && state.askUserAnswers[step.question]?.mode === 'answered-other') {
      setAskUserAnswer(step.question, null)
    }
  }
}

// 弹窗 "发送" / 跳到下一题
function askModalNextOrSend() {
  const pq = ASK_MODAL_STATE.pq
  if (!pq) return
  const step = pq.steps[ASK_MODAL_STATE.currentStep]
  // 先把 other input 同步进来
  onAskModalOtherInput()
  // 多 step: 还没到最后一题 → 切下一题
  if (pq.steps.length > 1 && ASK_MODAL_STATE.currentStep < pq.steps.length - 1) {
    ASK_MODAL_STATE.currentStep += 1
    renderAskModalContent()
    return
  }
  // 单 step / 多 step 最后一题 → 提交
  submitAskModal()
}

// 弹窗 "跳过" — 整个 questionnaire 跳过 (提交所有未答题为 "未回答" 给 mcode)
// v0.5.bx-15 (改): 之前是 "跳当前题 + 进下一题", 用户反馈 "问题弹窗关不掉" — 改成整个跳过
// v0.5.bx-20 (改): 关闭弹窗不持久化 dismiss — Ponkan 反馈
//   "如果跳过, 点叉号关掉, 回复未回答就可以" → 关闭即关, 下次 mcode 发新 ask_user 仍要弹窗
//   v0.5.bx-15 改 #3 (state.askUserDismissed + saveAskDismissed 持久化) 移除
function askModalSkip() {
  const pq = ASK_MODAL_STATE.pq
  if (!pq) return
  if (!state.askUserAnswers) state.askUserAnswers = {}
  // 所有 step 都标 skipped
  for (const step of pq.steps) {
    ASK_MODAL_STATE.answers[step.question] = { answer: '未回答', mode: 'skipped' }
    setAskUserAnswer(step.question, { answer: '未回答', mode: 'skipped' })
  }
  // 清 other input
  const other = document.getElementById('ask-modal-other')
  if (other) other.value = ''
  // 整个 questionnaire 提交
  submitAskModal()
}

// 提交弹窗答案 — 模板化 Q/A → sendAskAnswer → 关弹窗 → re-render
function submitAskModal() {
  const pq = ASK_MODAL_STATE.pq
  if (!pq) return
  // 收集所有 step 的最终 answer
  const blocks = []
  for (const step of pq.steps) {
    // 优先用弹窗临时答案, fallback 到全局 state.askUserAnswers
    const fromModal = ASK_MODAL_STATE.answers[step.question]
    const fromState = state?.askUserAnswers?.[step.question]
    const entry = fromModal || fromState
    const ans = entry ? entry.answer : '未回答'
    blocks.push(`Q: ${step.question}\nA: ${ans}`)
    // 持久化到全局 (用 final answer 兜底)
    if (!state.askUserAnswers) state.askUserAnswers = {}
    setAskUserAnswer(step.question, { answer: ans, mode: entry?.mode || 'skipped' })
  }
  if (blocks.length === 0) return
  const prompt = blocks.join('\n')
  // 清 pending (老 send() 入口检测用, 现在 modal 提交不走 send(), 但还是清一下)
  if (state?.pendingAskUser) state.pendingAskUser = null
  // 发给 mcode (isAskAnswer:true, server 不把 Q/A 加到 chat)
  sendAskAnswer(prompt)
  // 关弹窗
  closeAskModal()
  // re-render chat (让 inline 指示从"待答"变成"已答")
  renderAskUserToolIfChanged()
}

// 弹窗事件绑定 (一次性, 在 DOM ready 时)
function bindAskModal() {
  const modal = document.getElementById('ask-modal')
  if (!modal) return
  const close = document.getElementById('ask-modal-close')
  const skip = document.getElementById('ask-modal-skip')
  const send = document.getElementById('ask-modal-send')
  const other = document.getElementById('ask-modal-other')
  const backdrop = document.getElementById('ask-modal-backdrop')
  const opts = document.getElementById('ask-modal-options')
  // v0.5.bx-28: X / Esc / 点背景 = 彻底放弃 (dismiss) — 关弹窗 + 清 pendingAskUser, 不发任何 Q/A 给 mcode
  //   用户明确说"我不回答这个问题, 让我正常发消息", 后续 chat 走 send() 正常通路, 不会被套 Q/A 模板
  //   "跳过" 按钮 (skip) 才是明确动作: 发 "Q: ... A: 未回答" 给 mcode, 走 askModalSkip → submitAskModal
  //   "发送" 按钮 (send) 走 askModalNextOrSend → submitAskModal: 模板化所有题目, 已答正常 Q/A, 未答 "未回答"
  if (close) close.addEventListener('click', closeAskModal)  // × 彻底放弃当前 ask
  if (skip) skip.addEventListener('click', askModalSkip)
  if (send) send.addEventListener('click', askModalNextOrSend)
  if (other) {
    other.addEventListener('input', onAskModalOtherInput)
    other.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        askModalNextOrSend()
      }
    })
  }
  if (backdrop) backdrop.addEventListener('click', closeAskModal)  // 点背景 = 彻底放弃
  if (opts) {
    opts.addEventListener('click', (e) => {
      const btn = e.target.closest('.ask-modal-opt')
      if (!btn) return
      onAskModalOptClick(btn)
    })
  }
  // Esc 关闭 = 彻底放弃
  document.addEventListener('keydown', (e) => {
    if (ASK_MODAL_STATE.open && e.key === 'Escape') {
      e.preventDefault()
      closeAskModal()
    }
  })
}
// v0.5.bx-13: 立即绑定弹窗 (modal HTML 已在 script 之前, 直接能 getElementById)
bindAskModal()

// ============================================================
// Ask User Tool (v0.5.bx-8: mcode 0.1.4 ask_user 工具 — 内嵌选项 + 跳过)
// 选项 click → 自动 send "Q: <q> A: <label>"
// 跳过 click → 自动 send "Q: <q> A: 未回答"
// 弹窗外的 chat 消息 → send() 入口检测 state.pendingAskUser, 模板化
// 已答状态持久化: state.askUserAnswers[question] (跨 render 保留, 不被 parseChatLines 重建对象丢)
// v0.5.bx-8 (持久化): state.askUserAnswers 也写 localStorage, 刷新后能恢复
// ============================================================

// 模板化: 把 user answer 包装成 "Q: <question> A: <answer>" 发给 mcode
// mcode/LLM 看到这是 ask_user 工具的 result 上下文
function buildAskUserPrompt(question, answer) {
  return `Q: ${question}\nA: ${answer}`
}

// 重渲染 chat (让已答状态 ✓ 立刻显示)
function renderAskUserToolIfChanged() {
  if (typeof renderChat === 'function') renderChat()
  else if (typeof render === 'function') render()
}

// localStorage 持久化 — 刷新页面后能恢复已答状态, 避免按钮重新可点
const ASK_ANSWERS_LS_KEY = 'webui-askUserAnswers'
function loadAskUserAnswers() {
  try {
    const raw = localStorage.getItem(ASK_ANSWERS_LS_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return (parsed && typeof parsed === 'object') ? parsed : {}
  } catch (e) {
    console.warn('[ask-user] loadAskUserAnswers failed', e)
    return {}
  }
}
function saveAskUserAnswers(answers) {
  try {
    localStorage.setItem(ASK_ANSWERS_LS_KEY, JSON.stringify(answers || {}))
  } catch (e) {
    console.warn('[ask-user] saveAskUserAnswers failed', e)
  }
}
// 包装函数: 设 state.askUserAnswers[q] = entry 时同步写 localStorage
//   注意: 不会覆盖整个 state.askUserAnswers, 只 set/delete 单个 key
//   额外 (v0.5.bx-15 改 #3): 把 question 加到 module-level DISMISSED_QUESTIONS set
//     这样切到任何 mcode session, 该 question 都不会再弹 (即使 pq key 不同)
function setAskUserAnswer(question, entry) {
  if (!state) return
  if (!state.askUserAnswers) state.askUserAnswers = {}
  if (entry === null || entry === undefined) {
    delete state.askUserAnswers[question]
  } else {
    state.askUserAnswers[question] = entry
    if (typeof DISMISSED_QUESTIONS !== 'undefined' && question) {
      DISMISSED_QUESTIONS.add(question)
    }
  }
  saveAskUserAnswers(state.askUserAnswers)
}

// v0.5.bx-15 (改): localStorage 持久化 "弹窗已 dismiss" 标志 — reload 后还能拦住
//   per-CID 存, 不同浏览器 tab / 设备独立
const ASK_DISMISSED_LS_KEY = `webui-askDismissed-${CID}`
function loadAskDismissed() {
  try {
    return localStorage.getItem(ASK_DISMISSED_LS_KEY) === '1'
  } catch (e) { return false }
}
function saveAskDismissed(v) {
  try {
    if (v) localStorage.setItem(ASK_DISMISSED_LS_KEY, '1')
    else localStorage.removeItem(ASK_DISMISSED_LS_KEY)
  } catch (e) {
    console.warn('[ask-user] saveAskDismissed failed', e)
  }
}
// 重置入口 (用户在 logo 上长按 3 秒触发) — 让用户能反悔重新看到弹窗
function resetAskDismissed() {
  saveAskDismissed(false)
  if (state) state.askUserDismissed = false
  ASK_MODAL_STATE.presentedKeys.clear()
}

// v0.5.bx-NN: removed dead sendPlanAnswer declaration (was at line ~1850 in original).
//   The original inline <script> had two declarations of sendPlanAnswer; non-strict script
//   mode let the second declaration (line 4108, modal flow, calls /api/answer) overwrite
//   the first (simple /api/send). ES modules are strict — duplicate function declarations
//   throw SyntaxError. Removed the dead first declaration to preserve original behavior.

function openPlanModal(planMsg) {
  const root = document.getElementById('modal-root')
  if (!root) return
  // v0.5.ab: 弹窗打开时让 modal-root 接收 pointer-events（之前用 pointer-events:none 防止平时挡点击，
  // 但子元素没显式 auto 就继承 none，导致 X 按钮、背景点击全失效）
  root.style.pointerEvents = 'auto'
  root.innerHTML = `
    <div class="modal-overlay" id="plan-modal">
      <div class="modal" role="dialog" aria-label="Plan Review">
        <div class="modal-header">
          <span>📋</span>
          <span class="modal-header-title">${t('plan_review')} · ${escapeHtml(planMsg.title)}</span>
          <span class="modal-header-meta">Frozen Runtime snapshot</span>
          <button class="modal-close" id="plan-modal-close" aria-label="关闭">×</button>
        </div>
        <div class="modal-body" id="plan-modal-body">${parseMarkdown(planMsg.content || '*（空）*')}</div>
        <div class="modal-footer">
          <span>↑↓ select · Enter confirm · Esc skip · PgUp/PgDn scroll</span>
          <span class="modal-footer-spacer"></span>
          ${planMsg.options.map(o => `<button class="plan-action ${o.selected ? 'primary' : ''}" data-modal-opt="${escapeHtml(o.text)}">${escapeHtml(o.text)}</button>`).join('')}
        </div>
      </div>
    </div>
  `
  const close = () => {
    root.innerHTML = ''
    root.style.pointerEvents = 'none'  // 关闭后恢复不挡点击
  }
  document.getElementById('plan-modal-close').addEventListener('click', close)
  document.getElementById('plan-modal').addEventListener('click', (e) => {
    // 点 overlay 背景（非 modal 内容）关闭
    if (e.target.id === 'plan-modal') close()
  })
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc) }
  })
  root.querySelectorAll('[data-modal-opt]').forEach(el => {
    el.addEventListener('click', async () => {
      const text = el.getAttribute('data-modal-opt')
      close()
      await sendPlanAnswer(text)
    })
  })
}

function parseChatLines(lines) {
  // › user / ● assistant / ○ system / ◎ Goal/Ask / ✓ todo / Plan: 标题 块
  const messages = []
  let current = null
  let currentType = null
  let i = 0

  const isNewBlockStart = (l) => /^[›>●•○◯◎✓✔◌✗✘×▲!→]/.test(l) || /^Plan\s*[:：]/i.test(l.trim()) || /^Ask\b/i.test(l.trim())

  while (i < lines.length) {
    const line = lines[i]
    if (!line) { i++; continue }

    // Plan block（以 "Plan: 标题" 开头，到 "Plan complete." 之后 + 3 个选项，到下一行 prefix）
    if (/^Plan\s*[:：]\s*.+/i.test(line.trim())) {
      if (current) { messages.push(current); current = null; currentType = null }
      const plan = collectPlanBlock(lines, i)
      messages.push({ role: 'plan', ...plan })
      i = plan.endIdx
      continue
    }

    // Ask block（以 ◎ Ask / Ask 开头，到下一行 prefix 或 footer hint）
    if (/^[\u25ce]\s*Ask\b/i.test(line.trim()) || /^Ask\b\s*[:：]?/i.test(line.trim())) {
      if (current) { messages.push(current); current = null; currentType = null }
      const ask = collectAskBlock(lines, i)
      messages.push({ role: 'ask', ...ask })
      i = ask.endIdx
      continue
    }

    // Goal block
    if (/^[\u25ce]\s*Goal\b/i.test(line.trim())) {
      if (current) { messages.push(current); current = null; currentType = null }
      const goal = { role: 'goal', text: line, items: [] }
      let j = i + 1
      while (j < lines.length) {
        const l = lines[j]
        if (!l) break
        if (isNewBlockStart(l)) break
        goal.text += '\n' + l
        j++
      }
      messages.push(goal)
      i = j
      current = null; currentType = null
      continue
    }

    // User message
    if (/^[›>]\s+/.test(line)) {
      if (current) messages.push(current)
      current = { role: 'user', text: line.replace(/^[›>]\s+/, '') }
      currentType = 'user'
      i++
      continue
    }

    // Assistant message
    if (/^[●•]\s+/.test(line)) {
      if (current) messages.push(current)
      current = { role: 'assistant', text: line.replace(/^[●•]\s+/, '') }
      currentType = 'assistant'
      i++
      continue
    }

    // Todo item（v0.5.ab: 必须放在 system 前面，否则 ○ 会被先匹配成 system）
    // v0.5.ag: 之前会吞掉 system 错误（[error] / Questionnaire）— 提到 todo 之前先排除
    if (/^[✓✔○◌◯✗✘×]\s+/.test(line)) {
      const tm = line.match(/^([✓✔○◌◯✗✘×])\s+(.+)$/)
      const ttext = tm ? tm[2] : ''
      // 看起来像 system 的（!前缀 [新] / ○ [error|warning|info] [旧] / ○ Questionnaire/requires [旧]）→ 走 system 分支
      if (tm && (/^\[(error|warning|info|system)\]/i.test(ttext) || /Questionnaire|requires.*user input|requires.*interactive/i.test(ttext))) {
        if (current) messages.push(current)
        current = { role: 'system', text: ttext }
        currentType = 'system'
        i++
        continue
      }
      if (currentType !== 'todo' || !current) {
        if (current) messages.push(current)
        current = { role: 'todo', text: '', items: [] }
        currentType = 'todo'
      }
      const m = tm
      if (m) {
        const status = m[1] === '✓' || m[1] === '✔' ? 'done' : m[1] === '✗' || m[1] === '✘' || m[1] === '×' ? 'failed' : 'pending'
        current.items.push({ status, text: m[2] })
      }
      i++
      continue
    }

    // System message
    if (/^[○◯]\s+/.test(line)) {
      if (current) messages.push(current)
      current = { role: 'system', text: line.replace(/^[○◯]\s+/, '') }
      currentType = 'system'
      i++
      continue
    }

    // v0.5.ag: 错误/系统提示（! 前缀，避免与 todo 的 ○ 冲突）
    if (/^!\s+/.test(line)) {
      if (current) messages.push(current)
      current = { role: 'system', text: line.replace(/^!\s+/, '') }
      currentType = 'system'
      i++
      continue
    }

    // v0.5.ac: Thinking block（▲ 前缀）。连续多行 ▲ 聚成单个 thinking 块
    if (/^▲\s+/.test(line)) {
      if (currentType !== 'thinking' || !current) {
        if (current) messages.push(current)
        current = { role: 'thinking', text: line.replace(/^▲\s+/, '') }
        currentType = 'thinking'
      } else {
        current.text += '\n' + line.replace(/^▲\s+/, '')
      }
      i++
      continue
    }

    // v0.5.bw: Tool call block（→ 前缀）。
    //   格式：→ toolName  {input}     ← tool 块头
    //         [status]                 ← server v0.5.bs 写的 `  [completed]`
    //         output line 1            ← server v0.5.bs 写的 `  text`
    //         output line 2
    //         @ /path/to/file          ← server v0.5.bx-6 写的 tool locations
    //         ! error text             ← server v0.5.bs 写的 `  ! ...`
    // 收集直到下一个非 `  ` 缩进行
    if (/^→\s+/.test(line)) {
      if (current) { messages.push(current); current = null; currentType = null }
      // 解析 → toolName [input]
      const tm = line.match(/^→\s+(\S+?)(?:\s{2}(.+))?$/)
      const tool = {
        role: 'tool',
        name: tm ? tm[1] : 'tool',
        input: (tm && tm[2]) ? tm[2] : '',
        status: 'pending',
        output: [],
        locations: [],   // v0.5.bx-6: tool 涉及的本地文件路径
        error: null,
        streaming: false,  // v0.5.bw: 流式中默认展开
      }
      let j = i + 1
      while (j < lines.length) {
        const l = lines[j]
        if (l == null) { j++; continue }
        // 2+ 空格缩进 = 属于本 tool 块
        if (/^\s{2,}\S/.test(l)) {
          const stripped = l.replace(/^\s{2,}/, '')
          const statusMatch = stripped.match(/^\[([^\]]+)\]$/)
          if (statusMatch) {
            tool.status = statusMatch[1]
            // v0.5.bw: status=in_progress 时默认展开
            if (statusMatch[1] === 'in_progress') tool.streaming = true
          } else if (/^!\s+/.test(stripped)) {
            tool.error = stripped.replace(/^!\s+/, '')
          } else if (/^@\s+/.test(stripped)) {
            // v0.5.bx-6: 路径行 — 跟输出分开存
            const p = stripped.replace(/^@\s+/, '').trim()
            if (p && !tool.locations.includes(p)) tool.locations.push(p)
          } else {
            tool.output.push(stripped)
          }
          j++
        } else {
          break
        }
      }
      messages.push(tool)
      i = j
      current = null; currentType = null
      continue
    }

    // Continuation of current message
    if (current) {
      current.text += (current.text ? '\n' : '') + line
    }
    i++
  }
  if (current) messages.push(current)
  return messages
}

// v0.5.ab: 收集 Plan 块（"Plan: 标题" → Summary/目标/非目标 → "Plan complete." → 选项）
function collectPlanBlock(lines, startIdx) {
  const titleMatch = lines[startIdx].trim().match(/^Plan\s*[:：]\s*(.+)$/i)
  const title = titleMatch ? titleMatch[1].trim() : ''
  const contentLines = []
  const options = []
  let phase = 'content'  // 'content' | 'options'
  let i = startIdx + 1

  while (i < lines.length) {
    const l = lines[i]
    if (!l) { i++; continue }
    const trimmed = l.trim()
    // 遇新块：用户/助手/系统/todo/新 ask/新 plan → 停
    // 注意：在 options 阶段，" > 1. xxx" 形式不能算 user message，要继续
    const isOptionLine = phase === 'options' && /^[>\s]*\d+\.\s+/.test(l)
    if (!isOptionLine) {
      if (/^[›>●•○◯◎✓✔◌✗✘×]/.test(l)) break
      if (/^Plan\s*[:：]/i.test(trimmed)) break
      if (/^Ask\b/i.test(trimmed)) break
    }

    if (/^Plan complete\./i.test(trimmed)) {
      phase = 'options'
      i++
      // 跳过 "What would you like to do?" 一行
      if (i < lines.length && /what would you like to do/i.test(lines[i])) i++
      continue
    }

    if (phase === 'options') {
      // 形如 "  1. Agree and start implementation" 或 "> 1. Agree ..." 或 "> Agree ..."
      const optMatch = l.match(/^[>\s]*(\d+)\.\s+(.+)$/) || l.match(/^>\s+(.+)$/) || l.match(/^\s*[-*]\s+(.+)$/)
      if (optMatch) {
        options.push({ num: (optMatch[1] || '1').toString(), text: optMatch[2].trim(), selected: l.trimStart().startsWith('>') })
      } else if (trimmed) {
        // 兜底：非空行也作为选项
        options.push({ num: String(options.length + 1), text: trimmed, selected: false })
      }
    } else {
      contentLines.push(l)
    }
    i++
  }
  return { title, content: contentLines.join('\n'), options, endIdx: i }
}

// v0.5.ab: 收集 Ask 块（"◎ Ask" / "Ask" → 标签/问题/编号选项）
function collectAskBlock(lines, startIdx) {
  const blockLines = []
  let i = startIdx
  while (i < lines.length) {
    const l = lines[i]
    if (!l) { i++; continue }
    // tab 行（含 ● 和 ○，如 "● 故事类型  ○ 长度"）是 ask 的多问题标签，不能算新消息
    const isTabLine = /[●•].*[○◯]|[○◯].*[●•]/.test(l)
    if (!isTabLine) {
      if (/^[›>●•○◯◎✓✔◌✗✘×]/.test(l) && !/^[\u25ce]\s*Ask\b/i.test(l.trim())) break
      if (/^Plan\s*[:：]/i.test(l.trim())) break
      // 底部快捷键提示 "↑↓ move" / "1-5 select" / "Esc cancel" / "Tab/←/→" → 停
      if (/^↑↓\s/.test(l.trim()) || /^\d+-\d+\s+select/i.test(l.trim()) ||
          /^Esc\s+(cancel|back|deny)/i.test(l.trim()) || /^Tab\//i.test(l.trim())) break
    }
    blockLines.push(l)
    i++
  }
  return { raw: blockLines, endIdx: i }
}

function renderMessage(msg, ctx) {
  if (msg.role === 'goal') {
    return `<div class="goal-block">
      <div class="goal-block-label">◎ ${t('section_goal')}</div>
      <div class="goal-block-text">${escapeHtml(msg.text)}</div>
    </div>`
  }
  // v0.5.bw: 工具调用块（→ toolName + output/status/error）
  // 模仿 mcode TUI 的样式：tool 块独立成块，header 显示 tool name + status
  // 默认折叠（点开看 input/output），流式中（status=in_progress）默认展开
  if (msg.role === 'tool') {
    const statusClass = msg.status === 'completed' ? 'done'
      : msg.status === 'failed' ? 'failed'
      : msg.status === 'in_progress' ? 'running'
      : 'pending'
    const statusLabel = msg.status === 'completed' ? '✓'
      : msg.status === 'failed' ? '✗'
      : msg.status === 'in_progress' ? '…'
      : '○'
    // input 尝试 JSON 解析（pretty）— 失败就原样显示
    let inputHtml = ''
    if (msg.input) {
      let pretty = msg.input
      try {
        const parsed = JSON.parse(msg.input)
        pretty = JSON.stringify(parsed, null, 2)
      } catch {}
      inputHtml = `<div class="msg-tool-input"><span class="msg-tool-label">input</span><pre>${escapeHtml(pretty)}</pre></div>`
    }
    const outputText = msg.output.join('\n')
    let outputHtml = ''
    // v0.5.bx-7: ask_user 工具的特殊渲染 — 检测 INPUT 里的 questionnaire JSON
    //   mcode 0.1.4 调 ask_user 时 INPUT 是 { mode: "questionnaire", ... }（output 是 "waiting" 文本）
    //   解析成 question + options，渲染成可点击按钮 (内嵌在 tool 块里)
    // v0.5.bx-8: 选项 click → 自动 send (不走输入框); 加 .ask-skip 跳过按钮 → 发 "Q: ... A: 未回答";
    //   加 .ask-answered 状态条; 设 state.pendingAskUser 让 send() 模板化后续 chat 消息
    let questionnaireHtml = ''
    if (msg.name === 'ask_user' && msg.input && !msg.parsedQuestionnaire) {
      try {
        let inputStr = msg.input
        if (typeof inputStr === 'string') {
          const jsonStart = inputStr.indexOf('{')
          if (jsonStart >= 0) inputStr = inputStr.slice(jsonStart)
        }
        const q = typeof inputStr === 'string' ? JSON.parse(inputStr) : inputStr
        if (q && (q.mode === 'questionnaire' || q.steps)) {
          const rawSteps = Array.isArray(q.steps) ? q.steps : [q]
          // v0.5.bx-8: 存所有 step, 区分单/多模式
          //   单 step (rawSteps.length === 1): 选项 click 自动 send, 跳过按钮自动发 — 跟之前一致
          //   多 step (rawSteps.length > 1): 选项 click 只 highlight, 底部"发送"按钮模板化发, 没选 = 未回答
          const steps = rawSteps.map(step => ({
            question: step.question || step.title || '',
            options: (Array.isArray(step.options) ? step.options : []).map((o, oi) => ({
              label: (o && (o.label || o.text)) || `Option ${oi + 1}`,
              desc: (o && o.description) || '',
            })),
          }))
          msg.parsedQuestionnaire = {
            steps,
            mode: steps.length > 1 ? 'multi' : 'single',
          }
        }
      } catch {}
    }
    if (msg.parsedQuestionnaire) {
      const pq = msg.parsedQuestionnaire
      const isMulti = pq.mode === 'multi'
      const allAnswered = isMulti
        ? pq.steps.every(s => state?.askUserAnswers?.[s.question])
        : !!state?.askUserAnswers?.[pq.steps[0].question]

      // v0.5.bx-13: 弹窗模式 — inline 只显示紧凑指示 (不再内嵌 questionnaire HTML)
      //   实际交互走 #ask-modal 弹窗
      const firstQ = pq.steps[0]?.question || ''
      const statusText = allAnswered
        ? (isMulti ? '已答完' : `已答: ${(state.askUserAnswers[firstQ] && state.askUserAnswers[firstQ].answer) || '—'}`)
        : (isMulti ? `${pq.steps.length} 题待答` : '待答')
      questionnaireHtml = `<div class="msg-ask-indicator" data-ask-tool="${escapeHtml(firstQ)}" title="${escapeHtml(firstQ)}">
        <span class="msg-ask-indicator-icon">❓</span>
        <span>ask_user</span>
        <span class="msg-ask-indicator-status">· ${escapeHtml(statusText)}</span>
        ${!allAnswered ? '<span style="color:var(--text-tertiary);font-size:11px">· 弹窗已弹出</span>' : ''}
      </div>`
      // v0.5.bx-13: 首次解析时自动打开弹窗 (去重: 同 key 的 ask 不重复弹)
      // v0.5.bx-20: 只有"最新"包含 ask_user 的 message 才弹窗 (ctx.isLatestAsk)
      //   旧 chat history 里的 ask 不弹, 避免 mcode LLM 死循环反复弹同一题
      //   点 chat 里的 inline ask indicator 重新打开弹窗走 source:'click', 不受 isLatestAsk 限制 (见 attachStructuredBlockHandlers)
      const isLatestAsk = !!(ctx && ctx.isLatestAsk)
      openAskModal(pq, { isLatestAsk, source: 'render' })

      // v0.5.bx-31: 删掉 render 时设 state.pendingAskUser 的逻辑
      //   之前: 给每个未答的 ask_user 块都设 pendingAskUser, 让 send() 把下一条 chat 套成 Q/A 模板
      //         副作用: 历史 ask_user 块 (不是最新回复) 也触发模板化 — 进入有 N 个历史 ask 的对话,
      //         前 N 条 chat 都会被套成 "Q: Qx\nA: <输入>" 当假答案, 用户体验极差
      //   现在: Q/A 模板化只在弹窗 submit / skip / option click / 其他输入 时走 submitAskModal
      //         chat 输入框发消息永远走正常通路, 不被套
      //   pendingAskUser 字段保留 (closeAskModal 防御性清) 但不再被设也不再被 send() 读
    }
    if (outputText) {
      outputHtml = `<div class="msg-tool-output"><span class="msg-tool-label">output</span><pre>${escapeHtml(outputText)}</pre></div>`
    }
    // v0.5.bx-6: tool 涉及的本地文件路径 — 点击复制到剪贴板，hover 显示完整路径
    let locationsHtml = ''
    if (Array.isArray(msg.locations) && msg.locations.length > 0) {
      const items = msg.locations.map(p => {
        const safe = escapeHtml(p)
        return `<div class="msg-tool-loc" data-path="${safe}" title="点击复制：${safe}">
          <span class="msg-tool-loc-icon">📄</span><span class="msg-tool-loc-path">${safe}</span>
        </div>`
      }).join('')
      locationsHtml = `<div class="msg-tool-locations"><span class="msg-tool-label">files</span>${items}</div>`
    }
    let errorHtml = ''
    if (msg.error) {
      errorHtml = `<div class="msg-tool-error">${escapeHtml(msg.error)}</div>`
    }
    // 默认展开规则：completed (看 output) / streaming / 有 error → 展开；pending + 无 output → 折叠
    const hasContent = !!(msg.input || outputText || msg.error || questionnaireHtml || (msg.locations && msg.locations.length))
    const open = msg.streaming || msg.status === 'in_progress' || msg.status === 'failed' || hasContent
    // v0.5.bx-7: 问卷模式下隐藏 raw input + output（避免重复显示 JSON + 按钮）
    const finalInputHtml = msg.parsedQuestionnaire ? '' : inputHtml
    const finalOutputHtml = msg.parsedQuestionnaire ? '' : outputHtml
    return `<details class="msg-tool"${open ? ' open' : ''}>
      <summary>
        <span class="msg-tool-toggle">▸</span>
        <span class="msg-tool-icon">🔧</span>
        <span class="msg-tool-name">${escapeHtml(msg.name)}</span>
        <span class="msg-tool-status ${statusClass}">${statusLabel} ${escapeHtml(msg.status)}</span>
      </summary>
      <div class="msg-tool-body">
        ${finalInputHtml}
        ${questionnaireHtml}
        ${finalOutputHtml}
        ${locationsHtml}
        ${errorHtml}
      </div>
    </details>`
  }
  if (msg.role === 'todo') {
    return `<div class="todo-block">
      ${msg.items.map(i => `<div class="todo-item ${i.status}">
        <span class="todo-marker">${i.status === 'done' ? '✓' : i.status === 'failed' ? '✗' : '○'}</span>
        <span class="todo-text">${escapeHtml(i.text)}</span>
      </div>`).join('')}
    </div>`
  }
  if (msg.role === 'plan') return renderPlanBlock(msg)
  if (msg.role === 'ask')  return renderAskBlock(msg)
  // v0.5.ad: 检测末尾 ▍ 流式光标 — 拆出 text 和光标 span 单独渲染
  let body = msg.text
  let cursorHtml = ''
  if (body && body.endsWith(' ▍')) {
    body = body.slice(0, -2)
    cursorHtml = '<span class="msg-cursor">▍</span>'
  }
  // v0.5.af: 思考内容 — 紧凑内联 toggle，无 avatar 无双层标题
  if (msg.role === 'thinking') {
    const isStreaming = !!cursorHtml
    const lineCount = body.split('\n').filter(l => l.trim()).length
    const lineHint = lineCount > 1 ? ` <span class="msg-thinking-count">${lineCount} ${t('lines') || '行'}</span>` : ''
    return `<details class="msg-thinking-inline"${isStreaming ? ' open' : ''}>
      <summary>
        <span class="msg-thinking-toggle">▸</span>
        <span>${t('section_thinking') || '思考'}</span>${lineHint}
      </summary>
      <div class="msg-thinking">${parseMarkdown(body)}${cursorHtml}</div>
    </details>`
  }
  // v0.5.bs: assistant 消息的 avatar 改成 brand logo 图（user/system 仍是字母）
  const avatar = msg.role === 'user' ? 'You' : msg.role === 'assistant'
    ? '<img class="msg-avatar-img" src="/brand-logo.png" alt="MiniMax Code" />'
    : 'i'
  const role = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Mcode' : 'System'
  return `<div class="msg ${msg.role}">
    <div class="msg-avatar">${avatar}</div>
    <div class="msg-content">
      <div class="msg-role">${role}</div>
      <div class="msg-body">${parseMarkdown(body)}${cursorHtml}</div>
    </div>
  </div>`
}

// v0.5.ab: 渲染 Plan 块（内联 + "查看完整计划" 按钮触发弹窗）
function renderPlanBlock(msg) {
  const optsHtml = msg.options.map(o => `
    <div class="plan-action ${o.selected ? 'primary' : ''}" data-plan-opt="${escapeHtml(o.text)}">
      ${escapeHtml(o.text)}
    </div>`).join('')
  return `<div class="plan-block" data-plan-id="${msg.title}">
    <div class="plan-block-header">
      <span>📋</span>
      <span class="plan-block-title">Plan: ${escapeHtml(msg.title)}</span>
      <span class="plan-block-meta">${msg.content.split('\n').length} 行</span>
    </div>
    <div class="plan-block-summary">${parseMarkdown(msg.content || '*（无内容预览）*')}</div>
    ${msg.options.length > 0 ? `<div class="plan-block-actions">${optsHtml}</div>` : ''}
    <div class="plan-block-actions" style="margin-top:6px">
      <button class="plan-action" data-plan-view="${escapeHtml(msg.title)}">查看完整计划（弹窗）</button>
    </div>
  </div>`
}

// v0.5.ab: 渲染 Ask 块（内联 + 点击选项触发 send）
function renderAskBlock(msg) {
  // 解析 raw 行：① header (◎ Ask / Ask) ② 标签行 (● X  ○ Y) ③ 问题 ④ 选项 1..N
  const raw = msg.raw
  let headerText = ''
  let tabsText = ''
  let question = ''
  const options = []
  let hasOther = false

  for (const line of raw) {
    const t = line.trim()
    if (/^[\u25ce]\s*Ask\b/i.test(t) || /^Ask\s*[:：]?/i.test(t)) {
      if (!headerText) headerText = t
      continue
    }
    // 标签行: "● 故事类型  ○ 长度"（含 ● 和 ○）
    if (/[●•]/.test(t) && /[○◯]/.test(t) && !/^\d+\./.test(t)) {
      tabsText = t
      continue
    }
    // 编号选项: "  1  温暖治愈（生活/友情）  贴近日常..." 或 "  1. xxx"
    const optMatch = t.match(/^(\d+)\s+(.+)$/) || t.match(/^(\d+)\.\s+(.+)$/)
    if (optMatch) {
      const num = optMatch[1]
      // 剩余部分可能含 label + description
      const rest = optMatch[2]
      // 检测 Other
      if (/^Other\b/i.test(rest) || /^Others\b/i.test(rest)) {
        hasOther = true
        options.push({ num, label: rest.split(/\s{2,}|\s+/)[0] || 'Other', desc: rest, isOther: true })
      } else {
        // label 和 description 用 2+ 空格或 description 里常见词分割
        const parts = rest.split(/\s{2,}/)
        if (parts.length >= 2) {
          options.push({ num, label: parts[0], desc: parts.slice(1).join('  ') })
        } else {
          // 单段就当 label
          options.push({ num, label: rest, desc: '' })
        }
      }
      continue
    }
    // 其它行作为问题（直到编号选项出现）
    if (options.length === 0) {
      question = question ? question + '\n' + t : t
    }
  }

  const total = options.length || 1
  const optsHtml = options.map(o => `
    <div class="ask-option" data-ask-opt="${escapeHtml(o.label)}" data-ask-other="${o.isOther ? '1' : '0'}">
      <span class="ask-option-num">${o.num}</span>
      <span class="ask-option-label">${escapeHtml(o.label)}</span>
      ${o.desc ? `<span class="ask-option-desc">${escapeHtml(o.desc)}</span>` : ''}
    </div>`).join('')

  return `<div class="ask-block">
    <div class="ask-block-header">
      <span>◎</span>
      <span>${t('ask_title') || 'Ask'}</span>
      <span class="ask-block-progress">0/${total}</span>
    </div>
    ${tabsText ? `<div class="ask-block-tabs" style="margin-bottom:8px;color:var(--text-tertiary);font-size:12px">${escapeHtml(tabsText)}</div>` : ''}
    ${question ? `<div class="ask-block-question">${escapeHtml(question)}</div>` : ''}
    ${optsHtml}
  </div>`
}

// ============================================================
// Markdown (v0.5.ab: 用 marked + highlight.js 替换原 inline parser)
// ============================================================
// 注：bash.min.js / javascript.min.js / json.min.js 加载时已经自动调
// window.hljs.registerLanguage(...)，所以这里不用再手动注册。
if (window.marked) {
  marked.setOptions({
    gfm: true,
    breaks: true,
    headerIds: false,
    mangle: false,
    highlight(code, lang) {
      if (window.hljs && lang && hljs.getLanguage(lang)) {
        try { return hljs.highlight(code, { language: lang }).value } catch {}
      }
      return window.escapeHtml ? escapeHtml(code) : code
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    }
  })
}
// ============================================================
// Slash command overlay
// ============================================================
const slashOverlay = document.getElementById('slash-overlay')
const slashInput = document.getElementById('slash-input')
const slashResults = document.getElementById('slash-results')

function showSlash() {
  slashOpen = true
  slashOverlay.hidden = false
  slashInput.value = slashQuery
  filterSlash()
  setTimeout(() => slashInput.focus(), 0)
}
function hideSlash() {
  slashOpen = false
  slashOverlay.hidden = true
  slashQuery = ''
  slashActiveIdx = 0
}
function filterSlash() {
  const q = slashQuery.toLowerCase()
  const cmds = SLASH_COMMANDS.filter(c => {
    if (!q) return true
    return c.cmd.toLowerCase().includes(q) || c.zh.includes(q) || c.en.toLowerCase().includes(q)
  })
  const skills = SLASH_SKILLS.filter(s => {
    if (!q) return true
    return s.name.toLowerCase().includes(q) || s.zh.includes(q) || s.en.toLowerCase().includes(q)
  })
  slashFiltered = [...cmds, ...skills]  // 合并，但渲染时分 section
  slashActiveIdx = 0
  if (cmds.length === 0 && skills.length === 0) {
    slashResults.innerHTML = `<div class="slash-item empty">${t('slash_no_results')}</div>`
  } else {
    let html = ''
    let idx = 0
    if (cmds.length > 0) {
      html += `<div class="slash-section-label">${t('slash_section_cmd')}</div>`
      html += cmds.map((c, i) => {
        const active = i === 0 ? 'active' : ''
        idx++
        return `<div class="slash-item ${active}" data-idx="${i}" data-cmd="${c.cmd}" data-kind="cmd">
          <span class="slash-item-cmd">${escapeHtml(c.cmd)}</span>
          <span class="slash-item-desc">${escapeHtml(currentLang === 'zh' ? c.zh : c.en)}</span>
        </div>`
      }).join('')
    }
    if (skills.length > 0) {
      html += `<div class="slash-section-label">${t('slash_section_skill')}</div>`
      html += skills.map((s, i) => {
        const active = (cmds.length === 0 && i === 0) ? 'active' : ''
        const idxGlobal = cmds.length + i
        return `<div class="slash-item slash-skill ${active}" data-idx="${idxGlobal}" data-cmd="/skill ${s.name}" data-kind="skill">
          <span class="slash-item-cmd">${escapeHtml(s.name)}</span>
          <span class="slash-item-desc">${escapeHtml(currentLang === 'zh' ? s.zh : s.en)}</span>
        </div>`
      }).join('')
    }
    slashResults.innerHTML = html
  }
}

// ============================================================
// Mode popover
// ============================================================
const modePopover = document.getElementById('mode-popover')
function toggleMode() {
  modeOpen = !modeOpen
  modePopover.hidden = !modeOpen
}
function hideMode() { modeOpen = false; modePopover.hidden = true }
async function setMode(mode) {
  // v0.5.by: plan 模式本地 toggle — mcode 0.1.5 acp 不支持 session/set_mode (probe 验证 Method not found)
  //   fallback: send() 时给 prompt 加 plan 模板前缀, 强制 mcode 按 Plan: 格式输出
  //   这是 mcode 0.1.5 唯一可行的进 plan mode 路径
  //   (goal 模式: 之前是按钮, mcode 0.1.5 不支持, 删了按钮. 用 /goal slash command 代替)
  hideMode()
  if (mode === 'plan') {
    state.planMode = !state.planMode
    showToast(state.planMode ? '已开 Plan 模式 (下次发消息时 mcode 会按 Plan: 格式输出)' : '已关 Plan 模式', 'info', 2500)
    pushState()
    return
  }
  // 权限 mode (ask/auto/full/read) — mcode 0.1.5 acp 不支持 mid-session 改 permissionMode
  //   server 仅更新 webui UI, mcode 实际 mode 不变 (启动时已固定)
  try {
    const r = await fetch('/api/permissions' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ mode })
    })
    const j = await r.json().catch(() => ({}))
    if (state.planMode) state.planMode = false
    if (j && j.ok === true) {
      showToast('权限 mode 仅更新 webui UI, mcode 实际 mode 由启动 --permission 标志决定 (0.1.5 不支持 mid-session 改)', 'info', 4500)
    }
  } catch (e) { console.error(e) }
}

// ============================================================
// v0.5.aq: 旧 settings menu / modal 已全部废弃，chip-lan 自带开关
// ============================================================
const settingsMenu = null  // 旧元素已删除，置 null 防止任何残留引用报错
function toggleSettings() {}  // 旧 API no-op
function hideSettings() {}

// ============================================================
// v0.5.z: 套餐用量（btn-menu 按钮 + 右侧 popover，mmx quota + 本机时间自算）
// - % 从 mmx API 拿
// - 重置时间纯前端算：5h 窗口边界 (0/5/10/15/20) + 周日半夜周刷新
// - 只展示 general（不显示 video）
// - 时间格式 "X天 Y小时 Z分 后重置"（去掉"钟"避免"分分钟"重复）
// ============================================================

function getGeneralQuota() {
  // 从 state.usage.raw 拿 general 模型的数据（不返回 video）
  const raw = state?.usage?.raw
  let data = null
  if (typeof raw === 'string') {
    try { data = JSON.parse(raw) } catch {}
  } else if (raw && typeof raw === 'object') {
    data = raw
  }
  if (!data?.model_remains?.length) return null
  return data.model_remains.find((m) => m.model_name === 'general') || data.model_remains[0] || null
}

function renderUsagePopover() {
  const body = document.getElementById('usage-popover-body')
  const btn = document.getElementById('usage-popover-refresh')
  if (!body) return
  const g = getGeneralQuota()
  const now = new Date()
  if (!g) {
    body.innerHTML = `<div class="usage-empty">${t('quota_loading_idle')}</div>`
    return
  }
  const ip = g.current_interval_remaining_percent
  const wp = g.current_weekly_remaining_percent
  const ipClass = (typeof ip === 'number' && ip < 20) ? ' low' : ''
  const wpClass = (typeof wp === 'number' && wp < 20) ? ' low' : ''
  const next5h = nextFiveHourReset(now)
  const nextWk = nextWeeklyReset(now)
  body.innerHTML = `
    <div class="usage-row">
      <span class="usage-row-label">${t('quota_5h_limit')}</span>
      <span class="usage-row-value${ipClass}">${ip ?? '—'}% ${t('quota_remaining')}</span>
    </div>
    <div class="usage-reset">${t('quota_next_reset')} ${escapeHtml(formatResetTime(next5h))}（${escapeHtml(formatTimeUntil(next5h, now))}）</div>
    <div class="usage-row">
      <span class="usage-row-label">${t('quota_weekly_limit')}</span>
      <span class="usage-row-value${wpClass}">${wp ?? '—'}% ${t('quota_remaining')}</span>
    </div>
    <div class="usage-reset">${t('quota_next_reset')} ${escapeHtml(formatResetTime(nextWk))}（${escapeHtml(formatTimeUntil(nextWk, now))}）</div>
  `
  if (btn) {
    btn.classList.remove('loading')
    // v0.5.av: 恢复 "Refresh" 文案
    const txt = btn.querySelector('.usage-popover-refresh-text')
    if (txt) txt.textContent = t('refresh')
  }
}

function renderUsageValue() {
  // 按钮右侧的 value 字段，显示最关键的 5h 剩余%
  const val = document.getElementById('usage-value')
  if (!val) return
  const g = getGeneralQuota()
  if (!g || typeof g.current_interval_remaining_percent !== 'number') {
    val.textContent = '—'
    val.classList.remove('low')
    return
  }
  const ip = g.current_interval_remaining_percent
  // v0.5.aa: 加 "剩余" 后缀让"已用"和"剩余"语义明确（用户反馈）
  val.textContent = `${ip}% ${t('quota_remaining')}`
  if (ip < 20) val.classList.add('low')
  else val.classList.remove('low')
}

function renderUsage() {
  renderUsageValue()
  // 弹层只在打开时才更新内容（避免每秒重算浪费）
  const popover = document.getElementById('usage-popover')
  if (popover && !popover.hidden) renderUsagePopover()
}

function toggleUsagePopover(forceState) {
  const popover = document.getElementById('usage-popover')
  const btn = document.getElementById('btn-usage')
  if (!popover || !btn) return
  const willOpen = typeof forceState === 'boolean' ? forceState : popover.hidden
  popover.hidden = !willOpen
  btn.setAttribute('aria-expanded', willOpen ? 'true' : 'false')
  if (willOpen) {
    // 打开时立即刷新一次（让时间显示是新的）
    refreshUsage()
  }
}

async function refreshUsage(opts = {}) {
  const isManual = opts.manual === true
  const btn = document.getElementById('usage-popover-refresh')
  if (btn) {
    btn.classList.add('loading')
    // v0.5.av: loading 态显示 i18n 文案（避开 CSS ::before content 难 i18n）
    const txt = btn.querySelector('.usage-popover-refresh-text')
    if (txt) {
      txt.textContent = t('quota_loading_idle') === '点击套餐用量加载…' ? '加载中…' : 'Loading…'
    }
  }
  // v0.5.au: 改用 postTime 标记（Date.now()），避免 initial /api/state 提前 break wait loop
  // 之前用 beforeFetchedAt 比较的 bug：state 加载完成后 fetchedAt 任意变化都会 break，可能误判
  const postTime = Date.now()
  try {
    await fetch('/api/usage' + API_SUFFIX, { method: 'POST', headers: HEADERS })
    // 等真实数据到来（fetchedAt 必须 > postTime）才停转 + toast
    // v0.5.bb: deadline 18s > server 端 mmx quota 15s 超时（确保 mmx 跑完后 pushStateFor 的 fetchedAt > postTime）
    const deadline = Date.now() + 18_000
    let gotSseUpdate = false
    while (Date.now() < deadline) {
      const fetchedAt = state?.usage?.fetchedAt
      if (typeof fetchedAt === 'number' && fetchedAt > postTime) { gotSseUpdate = true; break }
      await new Promise((r) => setTimeout(r, 100))
    }
    if (!gotSseUpdate) {
      // SSE 没收到（典型场景：init 时 EventSource 还在 CONNECTING）
      // 兜底轮询 /api/state（每 1.5s 一次直到 deadline）— 避免 mmx 慢的情况下拿不到数据
      const fallbackDeadline = Date.now() + 8_000
      while (Date.now() < fallbackDeadline) {
        try {
          const r2 = await fetch('/api/state' + API_SUFFIX, { headers: HEADERS })
          if (r2.ok) {
            state = await r2.json()
            const fa = state?.usage?.fetchedAt
            if (typeof fa === 'number' && fa > postTime) { gotSseUpdate = true; break }
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 1500))
      }
    }
    // 兜底 render
    render()
    const fetchedAt = state?.usage?.fetchedAt
    if (!(typeof fetchedAt === 'number' && fetchedAt > postTime)) {
      // 没拿到新数据
      if (isManual) showToast(t('quota_loading_fail') + '（超时）')
    } else if (isManual) {
      showToast(t('usage_refreshed'))
    }
  } catch (e) {
    const body = document.getElementById('usage-popover-body')
    if (body) body.innerHTML = `<div class="usage-error">${t('quota_loading_fail')}：${escapeHtml(e.message || String(e))}</div>`
    if (isManual) showToast(t('quota_loading_fail') + '：' + (e.message || String(e)))
  } finally {
    if (btn) {
      btn.classList.remove('loading')
      // v0.5.av: 恢复 "Refresh" 文案
      const txt = btn.querySelector('.usage-popover-refresh-text')
      if (txt) txt.textContent = t('refresh')
    }
  }
}

// v0.5.bb: 全局 toast 通知
function showToast(msg, duration = 2200) {
  const t = document.getElementById('toast')
  if (!t) return
  t.textContent = msg
  t.classList.add('show')
  clearTimeout(t._timer)
  t._timer = setTimeout(() => t.classList.remove('show'), duration)
}

// ============================================================
// File upload
// ============================================================
const fileInput = document.getElementById('file-input')
const attachmentList = document.getElementById('attachment-list')

async function uploadFiles(files) {
  for (const file of files) {
    try {
      const fd = new FormData()
      fd.append('file', file)
      const r = await fetch('/api/upload' + API_SUFFIX, { method: 'POST', body: fd, headers: HEADERS })
      if (!r.ok) { alert(`Upload failed: ${r.status}`); continue }
      const data = await r.json()
      if (data.ok) {
        attachedFiles.push(data.path)
        renderAttachments()
      }
    } catch (e) { console.error('upload', e); alert(`Upload error: ${e.message}`) }
  }
}

function renderAttachments() {
  if (attachedFiles.length === 0) {
    attachmentList.innerHTML = ''
    return
  }
  attachmentList.innerHTML = attachedFiles.map((p, i) => {
    const name = p.split(/[\\\/]/).pop()
    return `<div class="attachment-chip">
      <span>📎 ${escapeHtml(name)}</span>
      <span class="remove" data-idx="${i}">×</span>
    </div>`
  }).join('')
}

function removeAttachment(idx) {
  attachedFiles.splice(idx, 1)
  renderAttachments()
}

// ============================================================
// Send command
// ============================================================
async function send() {
  const textarea = document.getElementById('input-textarea')
  const text = textarea.value.trim()
  if (!text && attachedFiles.length === 0) return
  if (isSending) return
  isSending = true
  const btn = document.getElementById('btn-send')
  btn.disabled = true
  try {
    // v0.5.ax: welcome 态（无 session）发消息时先创建 session，用当前 workspace
    if (!state?.sessionId) {
      const ws = state?.workspace?.dir || undefined
      const cr = await fetch('/api/sessions' + API_SUFFIX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...HEADERS },
        body: JSON.stringify({ workspace: ws })
      })
      const cd = await cr.json()
      if (!cd.ok) { alert('创建会话失败: ' + (cd.error || '未知错误')); return }
      // 等 SSE 推 state（含新 sessionId + mcodeSessionId）
      await new Promise(r => setTimeout(r, 300))
    }
    // v0.4.2: 用 mavis comm send 真正发消息到 mcode session（替代 M11 stdin 注入）
    // 附件先注入 @file 前缀（如果 mcode 端能处理）
    let content = text
    if (attachedFiles.length > 0) {
      const atPaths = attachedFiles.map(p => `@${p}`).join(' ')
      content = `${atPaths} ${content}`.trim()
    }
    // v0.5.bx-9: Plan 模式 — mcode 0.1.4 LLM 不能自己进 plan mode, webui workaround
    //   选 plan 后给 prompt 加 plan 模板前缀, 强制 mcode 按 Plan: 标题 / ## Summary / Plan complete. 格式输出
    //   webui parseChatLines 解析 + 渲染 plan 块 + 弹 plan 弹窗 (老渲染本来就 OK)
    if (state?.planMode && !state?.pendingAskUser) {
      const planTpl = `[Plan 模式 — 请按以下 markdown 格式输出]\n` +
        `Plan: <一句话标题>\n\n` +
        `## Summary\n<2-3 句总览>\n\n` +
        `## 目标\n- <目标 1>\n- <目标 2>\n- <...>\n\n` +
        `## 非目标\n- <非目标 1>\n- <...>\n\n` +
        `## 实施步骤\n1. <步骤 1>\n2. <步骤 2>\n3. <...>\n\n` +
        `Plan complete.\n` +
        `What would you like to do?\n` +
        `1. Agree and start implementation\n` +
        `2. Skip for now\n` +
        `3. Revise with feedback\n\n` +
        `---\n` +
        `用户问题: ${content}\n` +
        `---\n` +
        `(重要: 必须严格按上面 Plan 格式输出, 不要加额外解释. webui 会自动解析你的输出并显示 plan 弹窗让用户选.)`
      content = planTpl
      // v0.5.bx-9: 用了就关掉 plan mode (一次性, 不持续)
      //   user 想再来一次再点 plan chip
      state.planMode = false
      if (typeof renderRight === 'function') renderRight()
    }
    // v0.5.bx-31: 删掉 send() 里基于 pendingAskUser 的 Q/A 模板化兜底
    //   之前: 任何有 pendingAskUser 时, 用户在 chat 框发消息会被自动套成 "Q: <q>\nA: <text>"
    //   现在: chat 输入框发消息永远走正常通路, 不被套
    //   Q/A 模板化只在弹窗 submit (submitAskModal) 时走 — 用户必须明确点 × 提交 / 跳过 / 选项 / 其他+回车
    //   这样历史 ask_user 块 (不是最新回复) 也不会触发模板化, 避免"进入对话前 N 条都被套"的 bug
    //   pendingAskUser 字段已不在 render 时被设, 这里也不再读 (防御性保留 closeAskModal 清)
    const r = await fetch('/api/send' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ content, command: 'prompt' })
    })
    if (!r.ok) { alert(`Send failed: ${r.status}`); return }
    const data = await r.json()
    if (!data.ok) { alert(`Send error: ${data.error || 'unknown'}`); return }
    // 清空
    textarea.value = ''
    attachedFiles = []
    renderAttachments()
    autoResize()
  } catch (e) { console.error('send', e); alert(`Send error: ${e.message}`) }
  finally { isSending = false; btn.disabled = false }
}

// v0.5.aa: 停止按钮 — POST /api/stop，server kill 子进程
async function stopExec() {
  const btn = document.getElementById('btn-send')
  if (btn) btn.disabled = true
  try {
    const r = await fetch('/api/stop' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({})
    })
    const data = await r.json()
    if (!data.ok) console.warn('stop failed', data)
    // 状态由 server pushState 推送回来（state.running.active 变 false，render 切回 send）
  } catch (e) {
    console.error('stop', e)
  } finally {
    if (btn) btn.disabled = false
  }
}

function autoResize() {
  const ta = document.getElementById('input-textarea')
  if (!ta) return
  ta.style.height = 'auto'
  ta.style.height = Math.min(200, ta.scrollHeight) + 'px'
}

// ============================================================
// Init
// ============================================================
function init() {
  console.log('[webui] init: applyTheme/I18n start')
  applyTheme()
  applyI18n()
  console.log('[webui] init: applyTheme/I18n done')
  // v0.5.bx-8: 从 localStorage 恢复已答状态, 避免刷新后按钮重新可点
  if (!state) state = {}
  state.askUserAnswers = loadAskUserAnswers()
  // v0.5.bx-15 (改 #3): 恢复 DISMISSED_QUESTIONS — 从 state.askUserAnswers 重建
  //   切到任何 session, 这些 question 都不再弹
  try {
    for (const q of Object.keys(state.askUserAnswers || {})) {
      if (q) DISMISSED_QUESTIONS.add(q)
    }
  } catch (e) {}
  // v0.5.bx-20: 不再恢复 askUserDismissed 标志 — 关掉即关掉, reload 后弹窗默认能正常弹
  //   v0.5.bx-15 改 #3 (loadAskDismissed) 移除 (保留函数定义兼容, 不再调用)
  // v0.5.bh: 标记当前是不是本机（仅本机显示 chip-lan，LAN 设备上隐藏）
  const host = location.hostname
  const isLocal = host === 'localhost' || host === '127.0.0.1' || host === '' || host === '0.0.0.0'
  if (!isLocal) document.body.classList.add('is-remote')
  connect()
  attachEvents()
  // Fetch initial state
  console.log('[webui] init: fetch /api/state')
  fetch('/api/state' + API_SUFFIX, { headers: HEADERS })
    .then(r => r.json())
    .then(s => { state = s; console.log('[webui] init: state loaded, sessions=' + (s.sessions ? s.sessions.length : 'null')); render() })
    .catch(e => { console.error('[webui] init: /api/state FAIL', e); document.title = '⚠ /api/state FAIL' })
  // v0.4.1: 启动后自动拉一次 sessions 列表（mavis CLI 路径，不走 mcode）
  // v0.5.x: 改成立即拉，不延时轮询（避免刷新图标一直转的视觉噪音）
  refreshSessions()
  console.log('[webui] init: refreshSessions called')
  // v0.5.z: 启动后自动拉一次 quota（mmx quota show 直拉，按钮 value 用）
  refreshUsage()
  // v0.5.z: 定时刷新 popover 的本机时间倒计时（30s 一次，避免分钟级过期）
  setInterval(() => {
    const popover = document.getElementById('usage-popover')
    if (popover && !popover.hidden) renderUsagePopover()
  }, 30_000)
  // v0.5.aa: /usage 静默查询，每 2 分钟自动刷一次（按钮 value + 弹层用，chat 不污染）
  setInterval(refreshUsage, 2 * 60_000)
}

function attachEvents() {
  // Input textarea
  const textarea = document.getElementById('input-textarea')
  textarea.addEventListener('input', () => {
    autoResize()
    // Slash command detection
    const v = textarea.value
    // v0.5.bx-21: 含空格的输入不再开 slash overlay — 允许 "/goal 帮我" 这种 命令+参数 格式
    //   之前 v.startsWith('/') 永远 true, 导致 "/goal 帮我" 还显示 "No matching commands" 干扰 user
    //   修后: 只有 / 开头且无空格才开 slash (完整命令后空格 = 命令已选, 进入自然语言补充)
    if (v === '/' || (v.startsWith('/') && !v.includes(' '))) {
      slashQuery = v.slice(1)
      if (!slashOpen) showSlash()
      else filterSlash()
    } else if (slashOpen) {
      hideSlash()
    }
  })
  textarea.addEventListener('keydown', (e) => {
    if (slashOpen) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveSlash(1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); moveSlash(-1) }
      else if (e.key === 'Enter') { e.preventDefault(); selectSlash() }
      else if (e.key === 'Escape') { e.preventDefault(); hideSlash() }
    } else {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
    }
  })
  textarea.addEventListener('paste', async (e) => {
    // Paste any file from clipboard (image, video, document)
    // 终端页面只能 ctrl+v 粘贴，所以这里要处理所有附件
    if (e.clipboardData?.files?.length > 0) {
      const files = Array.from(e.clipboardData.files)
      if (files.length > 0) {
        e.preventDefault()
        await uploadFiles(files)
      }
    }
  })

  // Send button
  // v0.5.aa: send 按钮根据 is-running 切 send / stop
  document.getElementById('btn-send').addEventListener('click', () => {
    if (state?.running?.active) stopExec()
    else send()
  })

  // Refresh sessions button
  document.getElementById('btn-refresh-sessions')?.addEventListener('click', refreshSessions)

  // Quota card refresh button (手动刷新 → 弹 toast)
  document.getElementById('usage-popover-refresh')?.addEventListener('click', () => refreshUsage({ manual: true }))

  // Search sessions input — 实时过滤 sidebar 列表
  document.getElementById('search-input')?.addEventListener('input', (e) => {
    sessionSearchQuery = e.target.value || ''
    renderSessions()
  })

  // Attach
  document.getElementById('btn-attach').addEventListener('click', () => fileInput.click())
  fileInput.addEventListener('change', (e) => {
    if (e.target.files?.length > 0) {
      uploadFiles(e.target.files)
      e.target.value = ''
    }
  })
  attachmentList.addEventListener('click', (e) => {
    if (e.target.classList.contains('remove')) {
      removeAttachment(parseInt(e.target.getAttribute('data-idx'), 10))
    }
  })

  // Mode
  document.getElementById('btn-mode').addEventListener('click', (e) => {
    e.stopPropagation()
    toggleMode()
  })
  modePopover.addEventListener('click', (e) => {
    const item = e.target.closest('.mode-popover-item')
    if (item) setMode(item.getAttribute('data-mode'))
  })

  // Settings
  // v0.4.0: btn-settings 已移除（外观/语言/局域网在主栏已暴露）
  // document.getElementById('btn-settings').addEventListener('click', (e) => {
  //   e.stopPropagation()
  //   toggleSettings()
  // })

  // Appearance / Language buttons
  document.getElementById('btn-appearance').addEventListener('click', () => { toggleTheme() })
  document.getElementById('btn-language').addEventListener('click', () => { toggleLang() })

  // Usage button → toggle popover
  document.getElementById('btn-usage').addEventListener('click', (e) => {
    e.stopPropagation()
    toggleUsagePopover()
  })

  // v0.5.ak: 模型切换 — btn-model click 弹 model-picker popover
  // v0.5.bh: 拉 /api/models 显示可选列表，点一个直接切（用户反馈：不想手输）
  const modelPicker = document.getElementById('model-picker')
  const modelPickerInput = document.getElementById('model-picker-input')
  const modelPickerList = document.getElementById('model-picker-list')
  async function loadModelList() {
    if (!modelPickerList) return
    modelPickerList.innerHTML = '<div class="model-picker-loading">' + t('model_picker_loading') + '</div>'
    try {
      const r = await fetch('/api/models' + API_SUFFIX, { headers: HEADERS })
      const d = await r.json()
      if (!d.ok || !Array.isArray(d.models) || d.models.length === 0) {
        // v0.5.bj: TUI 没配 model — 显示 server hint（提示用户手输）
        const hint = d.hint || t('model_picker_empty')
        modelPickerList.innerHTML = '<div class="model-picker-empty">' + hint + '</div>'
        return
      }
      const currentName = (d.current || '').toLowerCase()
      modelPickerList.innerHTML = d.models.map(m => {
        const isCurrent = (m.id || '').toLowerCase() === currentName
        return '<button class="model-picker-item-btn' + (isCurrent ? ' current' : '') + '" data-model-id="' + (m.id || '').replace(/"/g, '&quot;') + '">' +
               '<span>' + (m.label || m.id) + '</span>' +
               '<span class="provider">' + (m.provider || '') + '</span>' +
               '</button>'
      }).join('')
      // 绑定 click — 直接调 /api/set-model（v0.5.bk: 不再发 /model 命令，避免 mcode 报 invalid params + 新开对话）
      modelPickerList.querySelectorAll('.model-picker-item-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const id = btn.getAttribute('data-model-id') || ''
          modelPickerInput.value = id
          modelPickerInput.dataset.fullName = id
          modelPicker.hidden = true
          try {
            await fetch('/api/set-model' + API_SUFFIX, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', ...HEADERS },
              body: JSON.stringify({ model: id }),
            })
            // 服务端 pushStateFor 自动更新 state，render() 会被 SSE 推过来触发
            // 但保险起见主动 fetch 一次
            const r = await fetch('/api/state' + API_SUFFIX, { headers: HEADERS })
            if (r.ok) { state = await r.json(); render() }
            showToast && showToast(t('model_switched') + ' ' + id, 1500)
          } catch (e) { console.error('[set-model]', e) }
        })
      })
    } catch (e) {
      console.error('[models] load failed', e)
      modelPickerList.innerHTML = '<div class="model-picker-empty">' + t('model_picker_empty') + '</div>'
    }
  }
  document.getElementById('btn-model').addEventListener('click', (e) => {
    e.stopPropagation()
    const wasHidden = modelPicker.hidden
    // 关掉其他 popover
    document.querySelectorAll('.mode-popover, .settings-menu, .model-picker, .workspace-picker').forEach(el => { if (el !== modelPicker) el.hidden = true })
    modelPicker.hidden = !wasHidden
    if (!modelPicker.hidden) {
      // 预填当前 model（只显示短名，去掉 provider/ 前缀）
      const fullName = (state && state.model && state.model.name) || ''
      const shortName = fullName.includes('/') ? fullName.split('/').pop() : fullName
      modelPickerInput.value = shortName
      modelPickerInput.dataset.fullName = fullName  // 保留完整路径作 fallback
      // v0.5.bh: 拉可选模型列表
      loadModelList()
      setTimeout(() => modelPickerInput.focus(), 0)
    }
  })
  document.getElementById('model-picker-cancel').addEventListener('click', (e) => {
    e.stopPropagation()
    modelPicker.hidden = true
  })
  modelPickerInput.addEventListener('keydown', async (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const v = modelPickerInput.value.trim()
      if (!v) return
      modelPicker.hidden = true
      // 直接调 /api/send 发 "/model <v>" 给 mcode acp
      try {
        await fetch('/api/send' + API_SUFFIX, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...HEADERS },
          body: JSON.stringify({ content: '/model ' + v }),
        })
      } catch (e) { console.error(e) }
    } else if (e.key === 'Escape') {
      modelPicker.hidden = true
    }
  })
  // 点击 popover 外关掉
  document.addEventListener('click', (e) => {
    if (modelPicker && !modelPicker.hidden && !modelPicker.contains(e.target) && e.target.id !== 'btn-model') {
      modelPicker.hidden = true
    }
  })

  // v0.5.al: workspace 切换 — chip-workspace click 弹 popover
  const wsPicker = document.getElementById('workspace-picker')
  const wsInput = document.getElementById('workspace-picker-input')
  const wsCurrent = document.getElementById('workspace-picker-current')
  const wsChip = document.getElementById('chip-workspace')
  const wsRecentsEl = document.getElementById('workspace-picker-recents')
  const wsRecentsList = document.getElementById('workspace-picker-recents-list')
  const wsSyncCheckbox = document.getElementById('workspace-picker-sync')

  // localStorage 工具：保存/读取 recents
  const WS_RECENTS_KEY = 'webui_workspace_recents_v1'
  const WS_LAST_KEY = 'webui_workspace_last_v1'
  function loadWsRecents() {
    try { return JSON.parse(localStorage.getItem(WS_RECENTS_KEY) || '[]') } catch { return [] }
  }
  function saveWsRecents(arr) {
    try { localStorage.setItem(WS_RECENTS_KEY, JSON.stringify(arr.slice(0, 5))) } catch {}
  }
  function pushWsRecent(dir) {
    if (!dir) return
    const cur = loadWsRecents().filter(d => d !== dir)
    cur.unshift(dir)
    saveWsRecents(cur)
  }
  function renderWsRecents() {
    const recents = loadWsRecents()
    if (recents.length === 0) {
      wsRecentsEl.hidden = true
      return
    }
    wsRecentsEl.hidden = false
    wsRecentsList.innerHTML = ''
    for (const dir of recents) {
      const btn = document.createElement('div')
      btn.className = 'workspace-picker-recent'
      btn.textContent = dir
      btn.title = dir
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        wsInput.value = dir
        submitWorkspaceChange({ dir })
      })
      wsRecentsList.appendChild(btn)
    }
  }

  function positionWsPicker() {
    // v0.5.bg: 用户反馈"显示不全" — 改成屏幕居中显示（fixed + 50% translate），不再跟 chip
    if (!wsPicker) return
    // 居中定位（fixed + transform）
    wsPicker.style.top = '50%'
    wsPicker.style.left = '50%'
    wsPicker.style.transform = 'translate(-50%, -50%)'
  }

  async function submitWorkspaceChange(payload) {
    try {
      const r = await fetch('/api/workspace' + API_SUFFIX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...HEADERS },
        body: JSON.stringify(payload),
      })
      const data = await r.json()
      if (data.ok) {
        if (payload && payload.dir) {
          pushWsRecent(data.workspace.dir)
          try { localStorage.setItem(WS_LAST_KEY, data.workspace.dir) } catch {}
        }
        wsPicker.hidden = true
        // server 会 push state，render() 自动更新 chip + 输入区
        // 立即本地 fallback（不等 SSE）
        if (state) {
          state.workspace = data.workspace
          render()
        }
      } else {
        alert('切换失败: ' + (data.error || '未知错误'))
      }
    } catch (e) {
      console.error('[ws] submit failed', e)
      alert('切换失败: ' + e.message)
    }
  }

  wsChip?.addEventListener('click', (e) => {
    e.stopPropagation()
    openWsPicker()
  })

  // v0.5.ax: 欢迎页的工作区 chip 也触发同样的 popover
  const emptyWsBtn = document.getElementById('chat-empty-workspace')
  if (emptyWsBtn) {
    emptyWsBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      // v0.5.ax: 仅在 welcome 态（无消息）允许改工作区
      const hasMessages = (state?.chat?.length || 0) > 0
      if (hasMessages) {
        showToast(t('workspace_locked_in_chat'))
        return
      }
      openWsPicker()
    })
  }

  function openWsPicker() {
    const wasHidden = wsPicker.hidden
    // 关掉其他 popover
    document.querySelectorAll('.mode-popover, .settings-menu, .model-picker, .workspace-picker').forEach(el => { if (el !== wsPicker) el.hidden = true })
    wsPicker.hidden = !wasHidden
    if (!wsPicker.hidden) {
      // 显示当前工作区全路径
      const cur = (state && state.workspace && state.workspace.dir) || ''
      wsCurrent.textContent = cur || t('workspace_unset')
      wsInput.value = cur
      renderWsRecents()
      // 探测 TUI cwd，让 "跟随 TUI" 按钮显示真实路径（tooltip）
      fetch('/api/workspace' + API_SUFFIX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...HEADERS },
        body: JSON.stringify({ action: 'detect' }),
      }).then(r => r.json()).then(data => {
        if (data && data.tuiCwd) {
          const tuiBtn = document.getElementById('workspace-picker-tui')
          if (tuiBtn) tuiBtn.title = 'mcode TUI 当前在: ' + data.tuiCwd
        }
      }).catch(() => {})
      setTimeout(() => {
        positionWsPicker()
        wsInput.focus()
        wsInput.select()
      }, 0)
    }
  }

  // 输入框回车 = 切换
  wsInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      const dir = wsInput.value.trim()
      if (!dir) return
      submitWorkspaceChange({ dir, syncTui: wsSyncCheckbox.checked })
    } else if (e.key === 'Escape') {
      e.stopPropagation()
      wsPicker.hidden = true
    }
  })

  // v0.5.by: 3 按钮 (workspace-picker-confirm/tui/reset) HTML 已删 — Enter 键提交已覆盖
  //   (见上方 wsInput.addEventListener('keydown') Enter 分支)

  // v0.5.am: 可视化目录树浏览（懒加载）
  const browseToggle = document.getElementById('workspace-picker-browse-toggle')
  const browsePanel = document.getElementById('workspace-picker-browse-panel')
  const browseChevron = document.getElementById('workspace-picker-browse-chevron')
  const breadcrumb = document.getElementById('workspace-picker-breadcrumb')
  const treeEl = document.getElementById('workspace-picker-tree')
  const treeLoading = document.getElementById('workspace-picker-tree-loading')
  // 内存缓存：path -> {ok, children, roots}  避免重复请求
  const browseCache = new Map()
  // 当前浏览的目录
  let browseCurrent = null  // absolute path or null (= roots)
  let browseOpen = false

  function fetchBrowse(path) {
    const key = path || '__roots__'
    if (browseCache.has(key)) return Promise.resolve(browseCache.get(key))
    const url = '/api/workspace/browse' + API_SUFFIX + (path ? '&path=' + encodeURIComponent(path) : '')
    return fetch(url, { headers: HEADERS })
      .then(r => r.json())
      .then(data => { browseCache.set(key, data); return data })
  }

  function renderBreadcrumb(dir) {
    breadcrumb.innerHTML = ''
    if (!dir) {
      // 根盘符视图
      const span = document.createElement('span')
      span.className = 'workspace-picker-breadcrumb-item'
      span.textContent = '盘符'
      span.title = '根盘符'
      breadcrumb.appendChild(span)
      return
    }
    // 拆路径：["C:", "Users", "mjc39", ...]
    const sep = dir.includes('\\') ? '\\' : '/'
    const isWin = dir.match(/^[A-Z]:/i)
    const parts = dir.split(/[\\\/]/).filter(Boolean)
    let acc = ''
    if (isWin) {
      acc = parts.shift() + sep  // "C:\"
    } else {
      acc = sep  // "/"
    }
    const firstCrumb = document.createElement('span')
    firstCrumb.className = 'workspace-picker-breadcrumb-item'
    firstCrumb.textContent = acc
    firstCrumb.title = isWin ? '回到根盘符' : '/'
    // 关键修复：firstCrumb 始终跳回根盘符视图（Windows = loadBrowse(null)，Linux = loadBrowse('/')）
    firstCrumb.addEventListener('click', (e) => {
      e.stopPropagation()
      loadBrowse(isWin ? null : '/')
    })
    breadcrumb.appendChild(firstCrumb)
    // 关键修复：第一个 part 之前不加 sep1（firstCrumb 已经以 sep 结尾，否则会出现 "C:\\" 双反斜杠）
    let isFirst = true
    for (const p of parts) {
      if (!isFirst) {
        const sep1 = document.createElement('span')
        sep1.className = 'workspace-picker-breadcrumb-sep'
        sep1.textContent = sep
        breadcrumb.appendChild(sep1)
      }
      isFirst = false
      acc = joinPath(acc, p, sep)
      const item = document.createElement('span')
      item.className = 'workspace-picker-breadcrumb-item'
      item.textContent = p
      item.title = acc
      item.addEventListener('click', (e) => { e.stopPropagation(); loadBrowse(acc) })
      breadcrumb.appendChild(item)
    }
  }
  function joinPath(base, part, sep) {
    if (base.endsWith(sep)) return base + part
    return base + sep + part
  }

  function renderTreeNodes(parent, children, currentDir) {
    parent.innerHTML = ''
    if (!children || children.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'workspace-picker-tree-empty'
      empty.textContent = '（无子目录）'
      parent.appendChild(empty)
      return
    }
    for (const c of children) {
      const node = document.createElement('div')
      node.className = 'workspace-tree-node'
      if (c.path === currentDir) node.classList.add('current')
      const chev = document.createElement('span')
      chev.className = 'workspace-tree-chevron'
      chev.textContent = '▶'
      const name = document.createElement('span')
      name.className = 'workspace-tree-name'
      name.textContent = c.name
      name.title = c.path
      const setBtn = document.createElement('button')
      setBtn.className = 'workspace-tree-set-btn'
      setBtn.textContent = '选'
      setBtn.title = '切换到此目录'
      const childrenBox = document.createElement('div')
      childrenBox.className = 'workspace-tree-children'
      childrenBox.hidden = true

      // 展开 / 收起
      chev.addEventListener('click', async (e) => {
        e.stopPropagation()
        if (childrenBox.hidden) {
          // 展开
          if (!childrenBox.dataset.loaded) {
            chev.classList.add('loading')
            chev.textContent = '…'
            const data = await fetchBrowse(c.path)
            chev.classList.remove('loading')
            chev.textContent = '▶'
            if (data.ok) {
              childrenBox.innerHTML = ''
              // 递归：子节点也用同样渲染（但要传入 currentDir 包含关系判断）
              renderTreeNodes(childrenBox, data.children, currentDir)
              childrenBox.dataset.loaded = '1'
            } else {
              const err = document.createElement('div')
              err.className = 'workspace-picker-tree-error'
              err.textContent = '加载失败: ' + (data.error || '未知')
              childrenBox.innerHTML = ''
              childrenBox.appendChild(err)
            }
          }
          childrenBox.hidden = false
          chev.classList.add('open')
        } else {
          childrenBox.hidden = true
          chev.classList.remove('open')
        }
      })
      // 点击 name = 进入该目录（重渲染树为该目录的子目录）
      name.addEventListener('click', (e) => {
        e.stopPropagation()
        loadBrowse(c.path)
      })
      // 选 = 切换工作区
      setBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        submitWorkspaceChange({ dir: c.path, syncTui: wsSyncCheckbox.checked })
      })

      node.appendChild(chev)
      node.appendChild(name)
      node.appendChild(setBtn)
      parent.appendChild(node)
      parent.appendChild(childrenBox)
    }
  }

  async function loadBrowse(path) {
    browseCurrent = path
    renderBreadcrumb(path)
    treeEl.innerHTML = '<div class="workspace-picker-tree-loading">加载中…</div>'
    const data = await fetchBrowse(path)
    if (!data.ok) {
      treeEl.innerHTML = `<div class="workspace-picker-tree-error">加载失败: ${data.error || '未知'}</div>`
      return
    }
    treeEl.innerHTML = ''
    if (data.roots) {
      // 根盘符视图
      const cur = (state && state.workspace && state.workspace.dir) || ''
      renderTreeNodes(treeEl, data.roots.map(r => ({ name: r, path: r })), cur)
    } else {
      const cur = (state && state.workspace && state.workspace.dir) || ''
      renderTreeNodes(treeEl, data.children, cur)
    }
  }

  browseToggle.addEventListener('click', async (e) => {
    e.stopPropagation()
    browseOpen = !browseOpen
    browsePanel.hidden = !browseOpen
    browseToggle.classList.toggle('open', browseOpen)
    if (browseOpen) {
      // 初始：从当前工作区（或根盘符）开始
      const cur = (state && state.workspace && state.workspace.dir) || null
      await loadBrowse(cur)
    }
  })

  // 点击 popover 外关掉
  document.addEventListener('click', (e) => {
    if (wsPicker && !wsPicker.hidden && !wsPicker.contains(e.target) && e.target.id !== 'chip-workspace' && !(wsChip && wsChip.contains(e.target))) {
      wsPicker.hidden = true
    }
  })
  // 窗口 resize / scroll 重新定位
  window.addEventListener('resize', () => { if (!wsPicker.hidden) positionWsPicker() })

  // v0.5.bh: 监听网络状态变化，实时更新顶栏在线指示
  window.addEventListener('online',  () => { try { render() } catch (e) {} })
  window.addEventListener('offline', () => { try { render() } catch (e) {} })

  // v0.5.al: 启动时恢复 localStorage 保存的工作区
  try {
    const last = localStorage.getItem(WS_LAST_KEY)
    if (last) {
      // 等首屏 render 完再切（state 已有 workspace 时不覆盖）—— 但 server 端默认 workspace 跟 saved 不同才切
      fetch('/api/workspace' + API_SUFFIX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...HEADERS },
        body: JSON.stringify({ action: 'detect' }),
      }).then(r => r.json()).then(data => {
        if (data && data.current !== last) {
          // server 默认跟 saved 不一样 → 恢复
          return fetch('/api/workspace' + API_SUFFIX, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...HEADERS },
            body: JSON.stringify({ dir: last, syncTui: false }),
          })
        }
      }).catch(() => {})
    }
  } catch {}

  // v0.5.aq: chip-lan toggle — 点 chip 切换 LAN 访问，hover 看访问 URL
  const chipLan = document.getElementById('chip-lan')
  const lanPopover = document.getElementById('lan-url-popover')
  const lanUrlLocal = document.getElementById('lan-url-local')
  const lanUrlLan = document.getElementById('lan-url-lan')
  // v0.5.bp: 顶栏 LAN 访问链接 chip（LAN on 时显示当前 IP，点复制完整 URL）
  const chipLanLink = document.getElementById('chip-lan-link')
  const chipLanLinkText = document.getElementById('chip-lan-link-text')

  async function loadLanInfo() {
    try {
      const r = await fetch('/api/settings' + API_SUFFIX, { headers: HEADERS })
      const d = await r.json()
      if (!d.ok) return
      if (lanUrlLocal) lanUrlLocal.textContent = d.localUrl || '—'
      if (lanUrlLan) lanUrlLan.textContent = d.lanUrl || '—'
      // v0.5.bp: 顶栏链接 chip 始终更新 URL（data-lan-url 留着点复制时用），可见性由 render() 决定
      if (chipLanLink) {
        chipLanLink.setAttribute('data-lan-url', d.lanUrl || '')
        if (chipLanLinkText) {
          // 只显示 host:port（去掉 http:// 前缀，紧凑）
          const u = (d.lanUrl || '').replace(/^https?:\/\//, '')
          chipLanLinkText.textContent = u || '—'
        }
      } else {
        console.warn('[lan] chipLanLink NOT found in DOM — element missing?')
      }
    } catch (e) { console.error('[lan] load failed', e) }
  }
  loadLanInfo()  // 启动时拉一次（hover 时再刷新一次也 OK）

  // v0.5.bp: 顶栏 LAN 链接点击 = 复制完整 URL 到剪贴板（data-lan-url 由 loadLanInfo 填入，URL 来自 server 的 detectLanIp()，非硬编码）
  if (chipLanLink) {
    chipLanLink.addEventListener('click', async (e) => {
      e.preventDefault()
      const url = chipLanLink.getAttribute('data-lan-url') || ''
      if (!url) return
      try {
        await navigator.clipboard.writeText(url)
        showToast(t('copy_success') + ': ' + url, 1500)
      } catch (err) {
        showToast(t('copy_failed') + ': ' + err.message, 2000)
      }
    })
  }

  // 点击 chip = 切换 LAN 访问 on/off
  if (chipLan) {
    chipLan.addEventListener('click', async (e) => {
    e.stopPropagation()
    const wasOn = chipLan.getAttribute('data-lan') === 'on'
    const enabled = !wasOn
    try {
      const r = await fetch('/api/settings' + API_SUFFIX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...HEADERS },
        body: JSON.stringify({ lanBroadcast: enabled }),
      })
      const d = await r.json()
      if (!d.ok) { alert('切换失败: ' + (d.error || '未知错误')); return }
      if (state) state.lanBroadcast = enabled
      render()
      showToast(enabled ? t('lan_title_on') : t('lan_title_off'))
    } catch (e) {
      console.error('[lan] toggle failed', e)
      alert('切换失败: ' + e.message)
    }
  })
  }

  // hover chip = 显示 popover（带本机/局域网 URL，点 URL 复制）
  function positionLanPopover() {
    if (!chipLan || !lanPopover) return
    const rect = chipLan.getBoundingClientRect()
    lanPopover.style.top = (rect.bottom + 6) + 'px'
    lanPopover.style.right = Math.max(8, window.innerWidth - rect.right) + 'px'
  }
  if (chipLan) {
    chipLan.addEventListener('mouseenter', () => {
      positionLanPopover()
      if (lanPopover) lanPopover.hidden = false
    })
  }
  if (chipLan && lanPopover) {
    chipLan.addEventListener('mouseleave', () => {
      // 延迟关闭：允许鼠标从 chip 滑到 popover 上
      setTimeout(() => {
        if (!lanPopover.matches(':hover')) lanPopover.hidden = true
      }, 150)
    })
    lanPopover.addEventListener('mouseleave', () => { lanPopover.hidden = true })
  }
  // 点 URL 复制
  ;[lanUrlLocal, lanUrlLan].forEach(el => {
    if (!el) return
    el.addEventListener('click', async (e) => {
      e.stopPropagation()
      const text = el.textContent
      if (text === '—') return
      try {
        await navigator.clipboard.writeText(text)
        showToast(t('copy_success') + ': ' + text, 1500)
      } catch (err) {
        alert(t('copy_failed_manual') + ': ' + text)
      }
    })
  })

  // New chat
  // v0.5.ar: 新建会话 → 弹工作区选择 popover（选完工作区再调 /api/sessions）
  const newChatPicker = document.getElementById('new-chat-ws-picker')
  const newChatCurrent = document.getElementById('new-chat-current-ws')
  const newChatList = document.getElementById('new-chat-ws-list')
  const newChatCancel = document.getElementById('new-chat-ws-cancel')
  const newChatOther = document.getElementById('new-chat-ws-other')
  function positionNewChatPicker() {
    const btn = document.getElementById('btn-new-chat')
    if (!btn) return
    const rect = btn.getBoundingClientRect()
    newChatPicker.style.top = (rect.bottom + 6) + 'px'
    newChatPicker.style.left = rect.left + 'px'
  }
  function openNewChatPicker() {
    // 收集所有已知 workspace（当前 + 所有 session 所属 workspace，去重）
    const currentWs = (state && state.workspace && state.workspace.dir) || ''
    const wsSet = new Set()
    if (currentWs) wsSet.add(currentWs)
    ;(state && state.sessions || []).forEach(s => { if (s.workspace) wsSet.add(s.workspace) })
    const wsList = [...wsSet]
    newChatCurrent.textContent = currentWs || '—'
    // 渲染列表（按当前工作区在顶 + 字母序）
    wsList.sort((a, b) => {
      if (a === currentWs) return -1
      if (b === currentWs) return 1
      return a.localeCompare(b)
    })
    newChatList.innerHTML = wsList.map(ws => {
      const count = (state.sessions || []).filter(s => s.workspace === ws).length
      const isCurrent = ws === currentWs
      const folderSvg = '<svg class="icon ws-picker-item-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>'
      return `<button class="ws-picker-item${isCurrent ? ' current' : ''}" data-ws="${escapeHtml(ws)}">
        ${folderSvg}
        <span class="ws-picker-item-text" title="${escapeHtml(ws)}">${escapeHtml(ws)}</span>
        <span class="ws-picker-item-count">${count}</span>
      </button>`
    }).join('')
    newChatList.querySelectorAll('.ws-picker-item').forEach(it => {
      it.addEventListener('click', async (e) => {
        e.stopPropagation()
        const ws = it.getAttribute('data-ws')
        newChatPicker.hidden = true
        await createNewSession(ws)
      })
    })
    positionNewChatPicker()
    newChatPicker.hidden = false
  }
  newChatCancel.addEventListener('click', () => { newChatPicker.hidden = true })
  newChatOther.addEventListener('click', async () => {
    // 走现有的 workspace-picker 流程：调 /api/workspace set 后再创建
    const dir = prompt('输入工作区路径（例如 D:\\\\projects\\\\myapp）')
    if (!dir || !dir.trim()) return
    newChatPicker.hidden = true
    try {
      const r = await fetch('/api/workspace' + API_SUFFIX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...HEADERS },
        body: JSON.stringify({ dir: dir.trim(), syncTui: true }),
      })
      const d = await r.json()
      if (!d.ok) { alert('切换工作区失败: ' + (d.error || '未知错误')); return }
    } catch (e) { alert('切换工作区失败: ' + e.message); return }
    await createNewSession(dir.trim())
  })
  // 点击 popover 外关闭
  document.addEventListener('click', (e) => {
    if (newChatPicker.hidden) return
    if (!newChatPicker.contains(e.target) && e.target.id !== 'btn-new-chat' && !e.target.closest('#btn-new-chat')) {
      newChatPicker.hidden = true
    }
  })

  async function createNewSession(workspace) {
    // v0.5.ak: mcode 还在跑时禁止清空 chat
    if (state && state.running && state.running.active) {
      alert('AI 还在回复中，请先等回复完成或点 ⏹ 停止。\n\n如果要开启新话题，先停止当前任务。')
      return
    }
    try {
      const r = await fetch('/api/sessions' + API_SUFFIX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...HEADERS },
        body: JSON.stringify({ workspace: workspace || undefined })
      })
      const d = await r.json()
      if (!d.ok) { alert('创建会话失败: ' + (d.error || '未知错误')); return }
      // 触发 SSE 拉取 state（server 端会推）
      if (typeof loadState === 'function') loadState()
    } catch (e) { console.error(e) }
  }

  document.getElementById('btn-new-chat').addEventListener('click', (e) => {
    e.stopPropagation()
    if (state && state.running && state.running.active) {
      alert('AI 还在回复中，请先等回复完成或点 ⏹ 停止。\n\n如果要开启新话题，先停止当前任务。')
      return
    }
    // v0.5.ax: "新建会话" = 切回 welcome 状态（清空当前 sessionId + chat 数组）
    // 真正的 session 创建推迟到用户发第一条消息时（带当前 workspace）
    clearCurrentSession()
  })

  // v0.5.bx-33: 删 "清理孤儿" 按钮 (用户反馈不要这个功能) — 按钮 + handler + API 一起删
  //   之前: index.html btn-cleanup-orphans + main.js click handler + router.js 路由 + handleCleanupOrphans
  //   现在: 全部清掉,代码干净,用户改主意找 git history

  // v0.5.ax: 清空当前 session，回到 welcome 页（不创建新 session，等用户发消息时再创建）
  function clearCurrentSession() {
    if (state) {
      state.sessionId = null
      state.mcodeSessionId = null
      state.sessionTitle = 'Untitled'
      state.chat = []
      state.goal = { active: false, text: null, status: null, duration: null }
      state.todo = []
      // 不改 state.workspace — 保留当前工作区（welcome 页显示短名）
    }
    // 关掉所有 popover
    document.querySelectorAll('.mode-popover, .settings-menu, .model-picker, .workspace-picker, .new-chat-picker').forEach(el => { el.hidden = true })
    newChatPicker.hidden = true
    render()
  }

  // Mobile toggles
  // v0.5.bx-37: 强制刷新按钮 — 手机/平板浏览器 hard refresh 麻烦, 一键绕过 HTTP cache
  //   行为: fetch 关键资源 (main.js/main.css/index.html) 用 cache:'reload' 覆盖 HTTP cache
  //   之后再 location.reload() 加载新版本
  document.getElementById('chip-force-reload').addEventListener('click', async () => {
    const btn = document.getElementById('chip-force-reload')
    if (btn) { btn.disabled = true; btn.classList.add('loading') }
    try {
      await Promise.allSettled([
        fetch('/app/main.js', { cache: 'reload' }),
        fetch('/styles/main.css', { cache: 'reload' }),
        fetch('/', { cache: 'reload' }),
      ])
    } catch {}
    location.reload()
  })
  document.getElementById('btn-toggle-left').addEventListener('click', () => {
    leftOpen = !leftOpen
    document.getElementById('left-panel').classList.toggle('open', leftOpen)
    document.getElementById('drawer-backdrop').classList.toggle('show', leftOpen || rightOpen)
  })
  document.getElementById('btn-toggle-right').addEventListener('click', () => {
    rightOpen = !rightOpen
    document.getElementById('right-panel').classList.toggle('open', rightOpen)
    document.getElementById('drawer-backdrop').classList.toggle('show', leftOpen || rightOpen)
  })
  document.getElementById('drawer-backdrop').addEventListener('click', () => {
    leftOpen = false; rightOpen = false
    document.getElementById('left-panel').classList.remove('open')
    document.getElementById('right-panel').classList.remove('open')
    document.getElementById('drawer-backdrop').classList.remove('show')
  })

  // Chat hints
  document.querySelectorAll('.chat-hint').forEach(h => {
    h.addEventListener('click', () => {
      const cmd = h.getAttribute('data-cmd')
      fetch('/api/cmd' + API_SUFFIX, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...HEADERS },
        body: JSON.stringify({ cmd })
      })
    })
  })

  // Drop zone
  const chatArea = document.getElementById('chat-area')
  const dropOverlay = document.getElementById('dropzone-overlay')
  ;['dragenter', 'dragover'].forEach(ev => {
    chatArea.addEventListener(ev, (e) => {
      e.preventDefault()
      dropOverlay.classList.add('show')
    })
  })
  ;['dragleave', 'drop'].forEach(ev => {
    chatArea.addEventListener(ev, (e) => {
      e.preventDefault()
      if (ev === 'dragleave' && e.relatedTarget) return
      dropOverlay.classList.remove('show')
    })
  })
  chatArea.addEventListener('drop', async (e) => {
    e.preventDefault()
    if (e.dataTransfer?.files?.length > 0) {
      await uploadFiles(e.dataTransfer.files)
    }
  })

  // Slash overlay click
  slashResults.addEventListener('click', (e) => {
    const item = e.target.closest('.slash-item')
    if (item?.getAttribute('data-cmd')) {
      const cmd = item.getAttribute('data-cmd')
      slashQuery = cmd
      selectSlash()
    }
  })
  // v0.5.bx-21: 鼠标 hover slash item 切 active idx (跟键盘 ArrowUp/Down 一致)
  //   之前只有 click → 直接 selectSlash, 没切换高亮. Ponkan 反馈 "鼠标点别的, 只会选中help"
  //   修: mouseenter 切 slashActiveIdx + 重新渲染 active class
  //   注意: 不绑 mouseleave, 否则用户键盘移到 /new 后鼠标移走又跳回 /help
  slashResults.addEventListener('mouseover', (e) => {
    const item = e.target.closest('.slash-item')
    if (!item || !item.getAttribute('data-cmd')) return
    const idx = parseInt(item.getAttribute('data-idx') || '-1', 10)
    if (idx < 0 || idx === slashActiveIdx) return
    slashActiveIdx = idx
    slashResults.querySelectorAll('.slash-item').forEach((el, i) => {
      el.classList.toggle('active', i === slashActiveIdx)
    })
  })
  slashInput.addEventListener('input', (e) => {
    slashQuery = e.target.value
    filterSlash()
  })
  slashInput.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); moveSlash(1) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); moveSlash(-1) }
    else if (e.key === 'Enter') { e.preventDefault(); selectSlash() }
    else if (e.key === 'Escape') { e.preventDefault(); hideSlash(); textarea.focus() }
    else if (e.key === 'Tab') { e.preventDefault(); selectSlash() }
  })

  // Document click to close popovers
  document.addEventListener('click', (e) => {
    if (modeOpen && !modePopover.contains(e.target) && e.target.id !== 'btn-mode' && !document.getElementById('btn-mode').contains(e.target)) {
      hideMode()
    }
    // v0.5.z: 点 popover 外面就关（btn-usage click 用 stopPropagation 自己处理开关）
    const up = document.getElementById('usage-popover')
    const ub = document.getElementById('btn-usage')
    if (up && !up.hidden && ub && !up.contains(e.target) && !ub.contains(e.target)) {
      toggleUsagePopover(false)
    }
    // v0.5.aq: settings modal 已删，不再需要这层 backdrop 检查
  })

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    // Modal shortcuts 优先
    // v0.5.bx-14: 旧 askOpen keydown 块已删, ask_user 弹窗自己有 keydown 监听 (bindAskModal)
    if (planOpen) {
      if (e.key >= '1' && e.key <= '3') {
        e.preventDefault()
        const actions = ['agree', 'skip', 'add']
        const action = actions[parseInt(e.key, 10) - 1]
        if (action === 'add') {
          const ta = document.getElementById('plan-add-context')
          ta.hidden = !ta.hidden
          if (!ta.hidden) ta.focus()
        }
        sendPlanAnswer(action)
        return
      } else if (e.key === 'Enter') {
        e.preventDefault()
        sendPlanAnswer('agree')
        return
      }
    }
    if (planModeOpen) {
      if (e.key === '1' || e.key === 'Enter') { e.preventDefault(); sendPlanModeAnswer('continue'); return }
      else if (e.key === '2' || e.key === 'Escape') { e.preventDefault(); sendPlanModeAnswer('deny'); return }
    }
    if (permOpen) {
      const map = { '1': 'ask', '2': 'auto', '3': 'full' }
      if (map[e.key]) { e.preventDefault(); sendPermAnswer(map[e.key]); return }
    }
    // Esc 关所有浮层
    if (e.key === 'Escape') {
      if (slashOpen) hideSlash()
      else if (modeOpen) hideMode()
      else { const up2 = document.getElementById('usage-popover'); if (up2 && !up2.hidden) toggleUsagePopover(false) }
    }
    // Ctrl+K / Cmd+K 聚焦输入
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault()
      textarea.focus()
    }
  })
}

function moveSlash(delta) {
  if (slashFiltered.length === 0) return
  slashActiveIdx = (slashActiveIdx + delta + slashFiltered.length) % slashFiltered.length
  slashResults.querySelectorAll('.slash-item').forEach((el, i) => {
    el.classList.toggle('active', i === slashActiveIdx)
    if (i === slashActiveIdx) el.scrollIntoView({ block: 'nearest' })
  })
}

function selectSlash() {
  if (slashFiltered.length === 0) return
  const cmd = slashFiltered[slashActiveIdx].cmd
  const textarea = document.getElementById('input-textarea')
  textarea.value = cmd
  textarea.focus()
  hideSlash()
}

function toggleLang() {
  setLang(currentLang === 'zh' ? 'en' : 'zh')
  localStorage.setItem('webui-lang', currentLang)
  applyI18n()
  render()
}

// ============================================================
// v0.5.bx-14: 旧 Ask Modal (v0.4.0) 已删除 — showAsk/hideAsk/renderAsk/sendAskAnswer
//   旧代码用 /api/answer endpoint (server 没实现, 一直 404)
//   新 ask_user 弹窗用 v0.5.bx-13 的 #ask-modal + /api/send (isAskAnswer:true)
// ============================================================

// ============================================================
// Plan Review Modal (v0.4.0)
// ============================================================
function showPlan() {
  if (!state?.plan?.active) return
  planOpen = true
  document.getElementById('plan-modal').classList.add('show')
  renderPlan()
}
function hidePlan() {
  planOpen = false
  document.getElementById('plan-modal').classList.remove('show')
}
function renderPlan() {
  const p = state?.plan
  if (!p || !p.active) { hidePlan(); return }
  document.getElementById('plan-title').textContent = p.title || 'Plan'
  const summaryEl = document.getElementById('plan-summary')
  if (p.summary) {
    summaryEl.textContent = p.summary
    summaryEl.classList.remove('plan-summary-empty')
  } else {
    summaryEl.innerHTML = '<div class="plan-summary-empty">没有 Summary</div>'
  }
  document.getElementById('plan-frozen').textContent = p.totalLines > 0
    ? `Frozen · Lines 1-${Math.min(p.totalLines, 9999)} of ${p.totalLines}`
    : 'Frozen Runtime snapshot'
  const optsEl = document.getElementById('plan-options')
  const labels = (p.options && p.options.length > 0)
    ? p.options.map(o => o.label)
    : ['Agree and start implementation', 'Skip for now', 'Add context to revise']
  optsEl.innerHTML = labels.map((label, i) => {
    const primary = i === 0 ? ' primary' : ''
    return `<button class="plan-option${primary}" data-action="${['agree', 'skip', 'add'][i] || 'agree'}">
      <span class="plan-option-num">${i + 1}</span>
      <span class="plan-option-label">${escapeHtml(label)}</span>
    </button>`
  }).join('')
  optsEl.querySelectorAll('.plan-option').forEach(el => {
    el.addEventListener('click', () => {
      const action = el.getAttribute('data-action')
      if (action === 'add') {
        const ta = document.getElementById('plan-add-context')
        ta.hidden = !ta.hidden
        if (!ta.hidden) ta.focus()
      }
      sendPlanAnswer(action)
    })
  })
}
async function sendPlanAnswer(action) {
  if (planSending) return
  planSending = true
  try {
    const ta = document.getElementById('plan-add-context')
    const extra = (action === 'add' && ta?.value) ? `\n${ta.value}` : ''
    await fetch('/api/answer' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ type: 'plan', option: action })
    })
    hidePlan()
  } catch (e) {
    console.error('plan answer', e)
  } finally {
    planSending = false
  }
}

// ============================================================
// EnterPlanMode Modal (v0.4.0)
// ============================================================
function showPlanMode() {
  if (!state?.enterPlanMode?.active) return
  planModeOpen = true
  document.getElementById('planmode-modal').classList.add('show')
}
function hidePlanMode() {
  planModeOpen = false
  document.getElementById('planmode-modal').classList.remove('show')
}
async function sendPlanModeAnswer(choice) {
  try {
    await fetch('/api/answer' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ type: 'planmode', option: choice })
    })
    hidePlanMode()
  } catch (e) { console.error('planmode answer', e) }
}

// ============================================================
// Permission Modal (v0.4.0)
// ============================================================
function showPerm() {
  if (!state?.permissionChoice?.active) return
  permOpen = true
  document.getElementById('perm-modal').classList.add('show')
  renderPerm()
}
function hidePerm() {
  permOpen = false
  document.getElementById('perm-modal').classList.remove('show')
}
function renderPerm() {
  const p = state?.permissionChoice
  if (!p || !p.active) { hidePerm(); return }
  document.getElementById('perm-current').textContent = `Current · ${p.current || '—'}`
}
async function sendPermAnswer(choice) {
  try {
    await fetch('/api/answer' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ type: 'permission', option: choice })
    })
    hidePerm()
  } catch (e) { console.error('perm answer', e) }
}

// ============================================================
// 弹窗触发（render 时自动检测）
// ============================================================
function checkModals() {
  // v0.5.bx-14: 旧 Ask 分支已删 (旧 modal 删了, 用 v0.5.bx-13 的 #ask-modal 替代, 由 openAskModal 触发)
  // Plan
  const p = state?.plan
  if (p?.active) {
    const key = `p-${p.title}-${p.summaryLines}-${p.totalLines}`
    if (key !== lastShownPlanKey) { lastShownPlanKey = key; showPlan() }
  } else {
    lastShownPlanKey = null
    if (planOpen) hidePlan()
  }
  // EnterPlanMode
  const pm = state?.enterPlanMode
  if (pm?.active) {
    if (lastShownPlanModeKey !== 'on') { lastShownPlanModeKey = 'on'; showPlanMode() }
  } else {
    lastShownPlanModeKey = null
    if (planModeOpen) hidePlanMode()
  }
  // Permission
  const pe = state?.permissionChoice
  if (pe?.active) {
    const key = `pe-${pe.current}-${pe.options?.length || 0}`
    if (key !== lastShownPermKey) { lastShownPermKey = key; showPerm() }
  } else {
    lastShownPermKey = null
    if (permOpen) hidePerm()
  }
}

// ============================================================
// Modal 事件绑定
// ============================================================
function attachModalEvents() {
  // v0.5.bx-27: 所有 getElementById 加 null check — 老 modal 元素 (ask-close/plan-modal 等) v0.5.bx-14 已删,
  //   但 attachModalEvents 还在引用 → null.addEventListener 报 TypeError → 整个 init 失败 → 页面没 JS
  //   现在每个都检查, 元素不存在就跳过 — 单个缺失不影响整体
  const $ = (id) => document.getElementById(id)
  const on = (id, evt, fn) => { const e = $(id); if (e) e.addEventListener(evt, fn) }

  // Ask (v0.5.bx-14: 旧 ask-close 元素已删, ask-modal 是新元素)
  on('ask-close', 'click', () => {
    fetch('/api/answer' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ type: 'ask', option: 'esc' })
    }).catch(() => {})
    hideAsk()
  })
  on('ask-modal', 'click', (e) => {
    if (e.target.id === 'ask-modal') hideAsk()
  })
  // Plan
  on('plan-close', 'click', () => {
    fetch('/api/answer' + API_SUFFIX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...HEADERS },
      body: JSON.stringify({ type: 'plan', option: 'skip' })
    }).catch(() => {})
    hidePlan()
  })
  on('plan-modal', 'click', (e) => {
    if (e.target.id === 'plan-modal') hidePlan()
  })
  // PlanMode
  on('planmode-close', 'click', () => sendPlanModeAnswer('deny'))
  on('planmode-modal', 'click', (e) => {
    if (e.target.id === 'planmode-modal') sendPlanModeAnswer('deny')
  })
  document.querySelectorAll('#planmode-options .choice-option').forEach(el => {
    el.addEventListener('click', () => sendPlanModeAnswer(el.getAttribute('data-choice')))
  })
  // Permission
  on('perm-close', 'click', () => hidePerm())
  on('perm-modal', 'click', (e) => {
    if (e.target.id === 'perm-modal') hidePerm()
  })
  document.querySelectorAll('#perm-options .choice-option').forEach(el => {
    el.addEventListener('click', () => sendPermAnswer(el.getAttribute('data-choice')))
  })
  // Esc 关弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (planOpen) { hidePlan() }
      else if (planModeOpen) { hidePlanMode() }
      else if (permOpen) { hidePerm() }
    }
  })
  // v0.5.bx-15 (改): 双击 logo 重置 ask_user 弹窗
  const topbarLogo = $('topbar-logo')
  if (topbarLogo) {
    topbarLogo.addEventListener('dblclick', () => {
      const hadKeys = ASK_MODAL_STATE.presentedKeys.size > 0
      ASK_MODAL_STATE.presentedKeys.clear()
      if (typeof showToast === 'function') {
        showToast(hadKeys ? '✓ ask_user 弹窗已重新开启 (清空 presentedKeys)' : 'ask_user 弹窗未开启过 (无需重置)', 'info')
      }
    })
  }
}

// Start
// v0.5.bx-31: 删 send() 里基于 pendingAskUser 的 Q/A 模板化兜底 + render 时设 pendingAskUser; chat 发消息永远不被套
// v0.5.bx-28: ask_user 弹窗 X / Esc / 背景 = 彻底放弃, 不发 Q/A 给 mcode; 防御性清 pendingAskUser
// v0.5.bx-27: 启动日志 + JS 错误捕获 — 让 reload 后能立刻看到 fatal error
console.log('[webui] init start, version=v0.5.bx-31, build=2026-08-20')
window.addEventListener('error', (e) => {
  console.error('[webui FATAL]', e.error?.stack || e.message, '@', e.filename + ':' + e.lineno + ':' + e.colno)
  document.title = '⚠ JS ERR: ' + (e.error?.message || e.message).substring(0, 50)
})
try {
  init()
  attachModalEvents()
  console.log('[webui] init done')
} catch (e) {
  console.error('[webui INIT FATAL]', e?.stack || e?.message || e)
  document.body.innerHTML = '<pre style="color:red;padding:20px;font-size:14px;">⚠ webui JS 初始化失败:\n\n' + (e?.stack || e?.message || JSON.stringify(e)) + '\n\n请截图给开发</pre>'
  throw e
}
