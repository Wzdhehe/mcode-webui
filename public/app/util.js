// webui/public/app/util.js
// Extracted from main.js (REFACTORING.md batch 4, step 1).
// Pure helpers: markdown/html formatting + usage-window date math.
// No app-state dependencies.

export function parseMarkdown(text) {
  if (!text) return ''
  if (window.marked) {
    try {
      const html = marked.parse(text)
      // 链接外链化 + 中文化 title
      return html.replace(/<a\s+href="([^"]+)"/g, (m, href) =>
        `<a href="${href}" target="_blank" rel="noopener"`)
    } catch (e) {
      console.error('marked error', e)
      return `<pre>${escapeHtml(text)}</pre>`
    }
  }
  return `<pre>${escapeHtml(text)}</pre>`  // 库没加载时的降级
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

export function formatNumber(n) {
  if (n == null) return '—'
  if (n < 1000) return String(Math.round(n))
  if (n < 1000000) return (n / 1000).toFixed(1) + 'k'
  return (n / 1000000).toFixed(2) + 'M'
}

// 5h 窗口边界（最后一个是 4h 20→24）
export const FIVE_HOUR_BOUNDARIES = [5, 10, 15, 20, 24]

export function nextFiveHourReset(now = new Date()) {
  // 返回下一次 5h 窗口的本地时间
  const h = now.getHours()
  const m = now.getMinutes()
  const s = now.getSeconds()
  for (const b of FIVE_HOUR_BOUNDARIES) {
    if (h < b) {
      const t = new Date(now)
      t.setHours(b, 0, 0, 0)
      return t
    }
  }
  // h >= 20 但 < 24：b=24 (今日午夜)
  // 实际上 h<24 时已经会被 b=20 截掉当 h<20
  // 如果 h>=24 不可能 (setHours clamp)，兜底：
  const t = new Date(now)
  t.setDate(t.getDate() + 1)
  t.setHours(5, 0, 0, 0)
  return t
}

export function nextWeeklyReset(now = new Date()) {
  // 周日半夜 (周日 00:00) 刷新周限额
  // 如果现在还没到本周周日 00:00：days = (7 - day) % 7, 0 = 今天就是周日
  // 如果今天是周日且已过 00:00 (0:00 ~ 现在)，下一次是下周日
  const t = new Date(now)
  t.setHours(0, 0, 0, 0)
  const day = now.getDay()  // 0=周日
  let daysUntil = (7 - day) % 7
  if (daysUntil === 0) {
    // 今天就是周日，看是否已过 00:00
    if (now.getHours() === 0 && now.getMinutes() === 0 && now.getSeconds() === 0) {
      return t  // 正好 0 点
    }
    // 已过 0 点，下一次是下周日
    daysUntil = 7
  }
  t.setDate(t.getDate() + daysUntil)
  return t
}

export function formatTimeUntil(target, now = new Date()) {
  // 输出 "X天 Y小时 Z分 后重置"，去掉"钟"避免"分 分钟"重复
  const ms = target.getTime() - now.getTime()
  if (ms <= 0) return '现在'
  const total = Math.floor(ms / 1000)
  const d = Math.floor(total / 86400)
  const h = Math.floor((total % 86400) / 3600)
  const m = Math.floor((total % 3600) / 60)
  const parts = []
  if (d > 0) parts.push(`${d}天`)
  if (h > 0) parts.push(`${h}小时`)
  if (m > 0 || parts.length === 0) parts.push(`${m}分`)
  return `${parts.join(' ')} 后重置`
}

export function formatResetTime(target) {
  // 显示绝对时间 "15:00" 或 "周日 00:00"（比"X小时Y分"更直观）
  const h = target.getHours()
  const m = target.getMinutes()
  const hm = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
  // 检查是否本周日（day === 0）
  const today = new Date()
  if (target.getDay() === 0) return `周日 ${hm}`
  return hm
}
