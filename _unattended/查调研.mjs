#!/usr/bin/env node
/**
 * 查调研 —— 调研库 S4（零 token）：**查号台只回你要的那几行，不发整本电话簿**。
 *
 * 干什么：
 *   ① 按词查：只扫**二级索引**（`索引\<抽屉>.md`，一行一份原文）＋ 抽屉名/一句话，回命中行＋该读哪个文件。
 *   ② 记缺料：`--miss "<词>"` ⇒ 追加 `<项目>\_crew\缺料.jsonl`（讨论期攒单、定稿时批量派）。
 *   ③ 看缺料：`--list`。
 *   顺带记命中日志 `<项目>\_crew\调研命中.log`（喂 `调研体检.mjs` 的"零命中抽屉"）。
 *
 * 用法：
 *   node 查调研.mjs --project <P> 登录 token [--max 20] [--json]
 *   node 查调研.mjs --project <P> --q "登录,会话" [--json]
 *   node 查调研.mjs --project <P> --miss "灰度发布" [--why "方案里没覆盖" --drawer release]
 *   node 查调研.mjs --project <P> --list [--json]
 *   · 不给 `--project`：读 `_crew\当前项目.txt`
 *
 * 退出码：0 有命中 ｜ 2 没命中（**不是错**，提示记缺料） ｜ 1 用法/环境错
 * 铁律：没有库／没建索引 ⇒ 静默 0 命中（不建库不影响任何流程）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? d) : d }
const JSON_OUT = has('json')

function projectDir () {
  const a = opt('project')
  if (a) return resolve(a)
  try { return resolve(readFileSync(join(HERE, '..', '_crew', '当前项目.txt'), 'utf8').trim()) } catch { return null }
}
const PROJECT = projectDir()
if (!PROJECT) { console.error('❌ 没有钉住的项目：给 --project <目录>，或先写 `_crew\\当前项目.txt`'); process.exit(1) }

const LIB = join(PROJECT, '文档', '调研')
const P_IDX = join(LIB, '索引')
const MISS = join(PROJECT, '_crew', '缺料.jsonl')
const HITLOG = join(PROJECT, '_crew', '调研命中.log')
const CREW = join(PROJECT, '_crew')

const nowISO = () => new Date().toISOString().replace(/\.\d+Z$/, 'Z')
const wordsOf = () => {
  const q = opt('q', null)
  const fromQ = q ? String(q).split(/[,，;；\s]+/) : []
  // 位置参数：去掉 --xxx 及其值
  const pos = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) { if (!['list', 'json'].includes(a.slice(2))) i++; continue }
    pos.push(a)
  }
  return [...new Set([...fromQ, ...pos].map(s => String(s).trim()).filter(Boolean))]
}

// ---------------------------------------------------------------- 缺料
if (has('miss')) {
  const kw = String(opt('miss', '')).trim()
  if (!kw) { console.error('❌ --miss 后面要跟缺的词'); process.exit(1) }
  mkdirSync(CREW, { recursive: true })
  const rec = { at: nowISO(), words: kw, why: String(opt('why', '') || '').trim(), drawer: String(opt('drawer', '') || '').trim() }
  appendFileSync(MISS, JSON.stringify(rec) + '\n', 'utf8')
  if (JSON_OUT) console.log(JSON.stringify({ ok: true, appended: rec }, null, 2))
  else console.log(`📝 已记缺料：${kw}${rec.why ? `（${rec.why}）` : ''} —— 攒着，蓝图定稿时批量派`)
  process.exit(0)
}
if (has('list')) {
  if (!existsSync(MISS)) { console.log('缺料清单：空'); process.exit(0) }
  const rows = readFileSync(MISS, 'utf8').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  if (JSON_OUT) console.log(JSON.stringify({ ok: true, count: rows.length, items: rows }, null, 2))
  else {
    console.log(`缺料清单：${rows.length} 条`)
    for (const r of rows) console.log(`  - ${r.words}${r.why ? `　（${r.why}）` : ''}${r.drawer ? `　[${r.drawer}]` : ''}`)
  }
  process.exit(0)
}

// ---------------------------------------------------------------- 查
const words = wordsOf()
if (!words.length) { console.error('❌ 给几个词：`node 查调研.mjs --project <P> 登录 token`（或 --miss / --list）'); process.exit(1) }
const MAX = Math.max(1, Number(opt('max', 20)))
const log = (hits) => {
  try {
    mkdirSync(CREW, { recursive: true })
    appendFileSync(HITLOG, `${nowISO()}\t${words.join(',')}\t${hits.length}\t${[...new Set(hits.map(h => h.drawer))].join(',')}\n`, 'utf8')
  } catch {}
}

if (!existsSync(LIB) || !existsSync(P_IDX)) {
  log([])
  if (JSON_OUT) console.log(JSON.stringify({ ok: true, total: 0, hits: [], words, skip: 'no-library' }))
  else console.log(`ℹ️ 没有调研库／索引（未命中 0 条）—— 未建库不影响任何流程。\n   要查缺：\`node _unattended\\查调研.mjs --project "${PROJECT}" --miss "${words.join(' ')}" --why "库里没有"\``)
  process.exit(2)
}

const low = words.map(w => w.toLowerCase())
const hit = (s) => { const t = String(s).toLowerCase(); return low.some(w => t.includes(w)) }

// 抽屉名 + 抽屉一句话（一级索引）
const l1 = join(LIB, '_索引.md')
const drawerDesc = new Map()
if (existsSync(l1)) for (const line of readFileSync(l1, 'utf8').split(/\r?\n/)) {
  if (!line.startsWith('|')) continue
  const c = line.split('|').slice(1, -1).map(x => x.trim())
  if (c.length < 4 || c[0] === '抽屉' || /^-+$/.test(c[0])) continue
  drawerDesc.set(c[0], c[3])
}

const hits = []
for (const f of readdirSync(P_IDX).filter(x => x.endsWith('.md')).sort()) {
  const drawer = f.slice(0, -3)
  const drawerHit = hit(drawer) || hit(drawerDesc.get(drawer) || '')
  const rows = []
  for (const line of readFileSync(join(P_IDX, f), 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    const c = line.split('|').slice(1, -1).map(x => x.trim())
    if (c.length < 5 || c[0] === '主题' || /^-+$/.test(c[0])) continue
    if (!hit(c.join(' '))) continue
    const file = c[0].replace(/`/g, '')
    rows.push({ drawer, file, path: `资料/${drawer}/${file}`, date: c[3], version: c[2], note: c[4] })
  }
  if (rows.length) hits.push(...rows)
  else if (drawerHit) hits.push({ drawer, file: '(整屉相关)', path: `资料/${drawer}/`, note: `抽屉整体相关：${drawerDesc.get(drawer) || drawer}` })
}

const shown = hits.slice(0, MAX)
log(hits)

if (JSON_OUT) {
  console.log(JSON.stringify({ ok: true, total: hits.length, shown: shown.length, words, hits: shown }, null, 2))
} else if (!hits.length) {
  console.log(`未命中：「${words.join(' ')}」（0 条）`)
  console.log(`   改词再查（零 token）；确实没有 ⇒ 记缺料：\n   node _unattended\\查调研.mjs --project "${PROJECT}" --miss "${words.join(' ')}" --why "库里没有"`)
} else {
  console.log(`命中 ${hits.length} 条${hits.length > shown.length ? `（只列前 ${shown.length} 条）` : ''}：`)
  for (const h of shown) {
    const stale = /^\d{4}-\d{2}-\d{2}$/.test(h.date || '') && (Date.now() - new Date(h.date + 'T00:00:00').getTime()) > 30 * 864e5 ? ' ⚠过期(>30天)' : ''
    console.log(`  - [${h.drawer}] ${h.path}${stale}`)
    console.log(`      ${h.note || ''}`)
  }
  if (hits.some(h => /^\d{4}-\d{2}-\d{2}$/.test(h.date || '') && (Date.now() - new Date(h.date + 'T00:00:00').getTime()) > 30 * 864e5)) console.log('  ⚠ 带"过期"的行：引用前**先复抓那一份**（比 sha，没变就刷新日期）')
}
process.exit(hits.length ? 0 : 2)
