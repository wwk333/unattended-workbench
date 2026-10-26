#!/usr/bin/env node
/**
 * 看板 · 终端版（零依赖 · 零 token · 只读）
 *
 * 为什么有它：浏览器版（<http://127.0.0.1:19450/>）要开浏览器、要刷新；
 *   日常"瞄一眼谁在跑、烧了多少、谁出错了"，在终端里看更顺手，也更容易挂进别的流程。
 *
 * 数据源**与浏览器版完全同一份**（`面板\帧数据.mjs` 的 `buildFrames()`）⇒ 两处口径不会漂。
 *
 * 用法：
 *   node _unattended\看板-终端.mjs                 # 打一次
 *   node _unattended\看板-终端.mjs --watch 10      # 每 10 秒刷新（Ctrl+C 退出）
 *   node _unattended\看板-终端.mjs --json          # 打原始 JSON（给脚本用）
 *   node _unattended\看板-终端.mjs --no-color      # 关颜色（重定向到文件时自动关）
 *
 * 口径（与浏览器版一致）：取不到就如实写"—/暂无动态"，不猜、不编。
 */
import { buildFrames } from './面板/帧数据.mjs'

const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? d) : d }
const WATCH = argv.includes('--watch') ? Number(opt('watch', 10)) || 10 : 0
const JSONOUT = has('json')
const USE_COLOR = !has('no-color') && process.stdout.isTTY

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', blue: '\x1b[34m', red: '\x1b[31m', gray: '\x1b[90m', cyan: '\x1b[36m', yellow: '\x1b[33m'
}
const c = (s, k) => (USE_COLOR && C[k] ? C[k] + s + C.reset : String(s))

/** 状态灯：四色对四态（与浏览器版同一张表）。 */
const DOT = { on: ['●', 'green'], busy: ['◐', 'blue'], err: ['✕', 'red'], off: ['○', 'gray'] }
const KIND_ICO = { status: '·', message: '✉', thinking: '✻', tool: '›', result: '↳', error: '✕' }

const dispWidth = (s) => {
  // 粗略显示宽度：CJK 算 2，其余算 1（够用；不做完整 East Asian Width）
  // ★ 先剥 ANSI 色码，否则转义序列会被当成可见字符、把两列挤歪
  const t = String(s).replace(/\x1b\[[0-9;]*m/g, '')
  let w = 0
  for (const ch of t) w += /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch) ? 2 : 1
  return w
}
const pad = (s, n) => { const d = n - dispWidth(s); return d > 0 ? s + ' '.repeat(d) : s }
const clip = (s, n) => {
  // ★ 按**显示宽度**截断（不能按字符数切：中文一个字占两格，按字符切会顶出列宽）
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  if (dispWidth(t) <= n) return t
  let out = '', w = 0
  for (const ch of t) { const cw2 = dispWidth(ch); if (w + cw2 > n - 1) break; out += ch; w += cw2 }
  return out + '…'
}

function cellLines (f, w) {
  const [dot, tone] = DOT[f.tone] ?? DOT.off
  const out = []
  out.push(c(dot, tone) + ' ' + c(pad('职位:' + f.role, 16) + '载体:' + f.carrier, 'bold'))
  out.push(c('  状态:' + f.stateZh + (f.live ? '（在跑 ' + clip(f.live.task, 18) + '）' : ''), tone === 'gray' ? 'dim' : tone))
  out.push(c('  模型:' + clip(f.modelText || '—', w - 8), 'dim'))
  const rows = (f.recent || []).slice(0, 4)
  if (!rows.length) out.push(c('  暂无动态', 'dim'))
  else for (const r of rows) out.push('  ' + c(KIND_ICO[r.kind] ?? '·', r.kind === 'error' ? 'red' : 'dim') + ' ' + clip(r.text, w - 6))
  return out
}

function render (snap) {
  const cols = process.stdout.columns || 120
  const twoCol = cols >= 96
  const cw = twoCol ? Math.floor(cols / 2) - 2 : Math.min(cols - 2, 100)
  const head = [
    c('班组看板（终端）', 'bold'),
    '项目 ' + c((snap.project && snap.project.name) || '—', 'cyan') + (snap.project && snap.project.pinned ? c('  已钉住', 'dim') : ''),
    '数据 ' + c(snap.dataAt || '—', 'dim') + '　取样 ' + c(snap.at || '—', 'dim')
  ].join('　')
  const lines = [head, c('─'.repeat(Math.min(cols, 120)), 'dim')]

  const frames = snap.frames || []
  if (twoCol) {
    for (let i = 0; i < frames.length; i += 2) {
      const L = cellLines(frames[i], cw)
      const R = frames[i + 1] ? cellLines(frames[i + 1], cw) : []
      const n = Math.max(L.length, R.length)
      for (let j = 0; j < n; j++) lines.push(pad(L[j] ?? '', cw) + '  ' + (R[j] ?? ''))
      if (i + 2 < frames.length) lines.push(c('─'.repeat(Math.min(cols, 120)), 'dim'))
    }
  } else {
    for (const f of frames) { lines.push(...cellLines(f, cw)); lines.push('') }
  }
  lines.push(c('─'.repeat(Math.min(cols, 120)), 'dim'))
  lines.push(c('浏览器版：http://127.0.0.1:19450/　｜　刷新：--watch 10　｜　原始 JSON：--json', 'dim'))
  return lines.join('\n')
}

function once () {
  const snap = buildFrames()
  if (JSONOUT) { console.log(JSON.stringify(snap, null, 2)); return snap }
  if (snap.ok === false) { console.log(c('⚠️ ' + (snap.error || '取不到数据'), 'red')); return snap }
  console.log(render(snap))
  return snap
}

if (!WATCH) { once(); process.exitCode = 0 } else {
  const tick = () => { if (USE_COLOR) process.stdout.write('\x1b[2J\x1b[H'); once() }
  tick()
  const t = setInterval(tick, WATCH * 1000)
  process.on('SIGINT', () => { clearInterval(t); console.log('\n（已退出）') ; process.exit(0) })
}
