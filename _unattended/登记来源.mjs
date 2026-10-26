#!/usr/bin/env node
/**
 * 登记来源 —— 调研库 S2/S2b（零 token）：**来源表只由本脚本写**，人不手抄。
 *
 * 干什么：把一份已落盘的原文登记进 `来源\<抽屉>.md` 的一行，字段全自动：
 *   sha256（按内容算）· 抓取日（默认本地今天）· 必填校验（按 type）· 幂等（同文件更新那一行，不追加重复）。
 *
 * 为什么必须走脚本（2026-10-18 施工文档 v3 的理由）：抓取是外部会话/载体干的，**人手抄表格必错**
 *   （格式漂、手印填错、缺字段），而"缺字段＝该份不算落盘"的收口判定全靠这几列。
 *
 * 用法：
 *   node 登记来源.mjs --project <P> --drawer <抽屉> --file <资料/抽屉/x.md 或 x.md> --type git|web|api|video|other
 *        [--url <地址>] [--ref <commit/tag>] [--title <标题>] [--note "一句话说明"] [--date YYYY-MM-DD]
 *        [--drawer-desc "这屉能回答什么"] [--check] [--json]
 *   · `--check`：只校验已有来源表（不写盘）
 *   · 不给 `--project`：读 `_crew\当前项目.txt`
 *
 * 退出码：0 干净 ｜ 2 有告警（如 `--check` 发现缺字段） ｜ 1 用法/环境错
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? d) : d }
const JSON_OUT = has('json')
const CHECK = has('check')

function projectDir () {
  const a = opt('project')
  if (a) return resolve(a)
  try { return resolve(readFileSync(join(HERE, '..', '_crew', '当前项目.txt'), 'utf8').trim()) } catch { return null }
}
const PROJECT = projectDir()
if (!PROJECT) { console.error('❌ 没有钉住的项目：给 --project <目录>，或先写 `_crew\\当前项目.txt`'); process.exit(1) }
const LIB = join(PROJECT, '文档', '调研')
if (!existsSync(LIB)) { console.error(`❌ 调研库不存在：${LIB}\n   先建库：node _unattended\\调研索引.mjs --project "${PROJECT}" --init`); process.exit(1) }
const SRC = join(LIB, '来源')
const MAT = join(LIB, '资料')
const COLS = ['文件', 'type', '地址', 'git-ref', 'sha256', '抓取日', '说明']
const TYPES = new Set(['git', 'web', 'api', 'video', 'other'])
const DESC_RE = /^<!--\s*抽屉一句话[:：]\s*([\s\S]*?)\s*-->\s*$/m

const rel = (p) => relative(LIB, p).split(sep).join('/')
const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')
const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }
const cell = (s) => String(s ?? '').replace(/\|/g, '｜').replace(/\r?\n/g, ' ').trim()

/** 读来源表：返回 { desc, rows }（rows 按文件名字典序） */
function readSource (drawer) {
  const p = join(SRC, drawer + '.md')
  if (!existsSync(p)) return { desc: '', rows: [] }
  const txt = readFileSync(p, 'utf8')
  const dm = txt.match(DESC_RE)
  const rows = []
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.split('|').slice(1, -1).map(x => x.trim())
    if (cells.length < COLS.length) continue
    if (cells[0] === COLS[0] || /^-+$/.test(cells[0].replace(/[: ]/g, ''))) continue
    rows.push(cells.slice(0, COLS.length))
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]))
  return { desc: dm ? dm[1] : '', rows }
}

function writeSource (drawer, desc, rows) {
  mkdirSync(SRC, { recursive: true })
  const head = desc ? `<!-- 抽屉一句话：${desc} -->\n\n` : ''
  const body = [
    `# 来源表 · ${drawer}`,
    '',
    head.trim() ? head.trim() : '_（这屉能回答什么？用 `--drawer-desc` 补一句）_',
    '',
    `| ${COLS.join(' | ')} |`,
    `|${COLS.map(() => '---').join('|')}|`,
    ...rows.map(r => `| ${r.join(' | ')} |`),
    ''
  ].join('\n')
  writeFileSync(join(SRC, drawer + '.md'), body, 'utf8')
}

/** 校验一行：缺字段/类型/日期/sha 是否与磁盘一致 */
function validateRow (row, drawer) {
  const issues = []
  const [file, type, url, ref, sha, date, note] = row
  if (!file) issues.push('缺「文件」')
  if (!TYPES.has(type)) issues.push(`type 不合法：${type || '(空)'}`)
  if (type === 'git' && !ref) issues.push('git 类缺 git-ref（commit/tag）')
  if ((type === 'web' || type === 'api') && !url) issues.push(`${type} 类缺「地址」`)
  if (!sha || !/^[0-9a-f]{64}$/i.test(sha)) issues.push('sha256 缺失或格式不对')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) issues.push(`抓取日不是 YYYY-MM-DD：${date || '(空)'}`)
  if (!note) issues.push('缺「说明」（索引里那一行就是从这来的）')
  const abs = join(LIB, file.split('/').join(sep))
  if (!existsSync(abs)) issues.push(`原文不在盘上：${file}`)
  else if (sha && /^[0-9a-f]{64}$/i.test(sha)) {
    const now = sha256(abs)
    if (now.toLowerCase() !== sha.toLowerCase()) issues.push(`sha 与当前内容不符（登记后又被改过）：${file}`)
  }
  return issues.map(s => `[${drawer}] ${s}`)
}

// ---------------------------------------------------------------- --check
if (CHECK) {
  const drawers = existsSync(SRC) ? readdirSync(SRC).filter(f => f.endsWith('.md')).map(f => f.slice(0, -3)) : []
  const all = []
  let n = 0
  for (const d of drawers) { const { rows } = readSource(d); n += rows.length; for (const r of rows) all.push(...validateRow(r, d)) }
  // 反向：资料里有、来源表里没有的 = 没登记
  if (existsSync(MAT)) {
    for (const d of readdirSync(MAT, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)) {
      const listed = new Set(readSource(d).rows.map(r => r[0]))
      for (const f of readdirSync(join(MAT, d)).filter(x => !x.startsWith('_'))) {
        if (!listed.has(`资料/${d}/${f}`)) all.push(`[${d}] 有原文没登记：资料/${d}/${f}`)
      }
    }
  }
  if (JSON_OUT) console.log(JSON.stringify({ ok: all.length === 0, drawers: drawers.length, rows: n, issues: all }, null, 2))
  else {
    console.log(`来源表校验：${drawers.length} 屉 / ${n} 行`)
    if (!all.length) console.log('✅ 全部字段齐全、sha 与内容一致、无漏登记')
    else { console.log(`⚠️ ${all.length} 处问题：`); for (const s of all) console.log('  - ' + s) }
  }
  process.exit(all.length ? 2 : 0)
}

// ---------------------------------------------------------------- 登记一行
const drawer = String(opt('drawer') ?? '').trim()
if (!drawer) { console.error('❌ 缺 --drawer <抽屉名>（抽屉＝资料/ 下的一个目录名）'); process.exit(1) }
if (!existsSync(join(MAT, drawer))) { console.error(`❌ 抽屉不存在：资料\\${drawer}\\ —— 先建目录并把原文放进去`); process.exit(1) }

const rawFile = String(opt('file') ?? '').trim()
if (!rawFile) { console.error('❌ 缺 --file（原文路径，可写 `x.md` 或 `资料/<抽屉>/x.md`）'); process.exit(1) }
let abs = isAbsolute(rawFile) ? resolve(rawFile) : resolve(LIB, rawFile.split('/').join(sep))
if (!existsSync(abs) && !isAbsolute(rawFile)) abs = resolve(join(MAT, drawer), rawFile)
if (!existsSync(abs)) { console.error(`❌ 原文不存在：${rawFile}`); process.exit(1) }
if (!statSync(abs).isFile()) { console.error(`❌ 不是文件：${abs}`); process.exit(1) }
const relPath = rel(abs)
if (!relPath.startsWith(`资料/${drawer}/`)) {
  console.error(`❌ 这份原文不在 资料\\${drawer}\\ 里（实际：${relPath}）—— 原文必须放在对应抽屉下，别处的不登记`)
  process.exit(1)
}

const type = String(opt('type', 'other')).trim().toLowerCase()
if (!TYPES.has(type)) { console.error(`❌ --type 只认：${[...TYPES].join(' / ')}`); process.exit(1) }
const url = String(opt('url', '') ?? '').trim()
const ref = String(opt('ref', '') ?? '').trim()
const title = String(opt('title', '') ?? '').trim()
const note = String(opt('note', '') ?? '').trim()
const date = String(opt('date', today()) ?? today()).trim()

// 必填（按类型）—— 错就退出，不写半行
const missing = []
if (type === 'git' && !ref) missing.push('git 类必须给 --ref <commit/tag>')
if ((type === 'web' || type === 'api') && !url) missing.push(`${type} 类必须给 --url`)
if (type === 'web' && !title) missing.push('web 类必须给 --title <页面标题>')
if (type === 'api' && !url) missing.push('api 类必须给 --url <endpoint>')
if (!note) missing.push('必须给 --note "一句话说明"（索引行从这里来，不能空）')
if (missing.length) { console.error('❌ 字段不全，未写入：\n  - ' + missing.join('\n  - ')); process.exit(1) }

const { desc, rows } = readSource(drawer)
const newDesc = opt('drawer-desc', null) !== null ? String(opt('drawer-desc')).trim() : desc
const row = [relPath, type, url || '-', ref || '-', sha256(abs), date, note]
const idx = rows.findIndex(r => r[0] === relPath)
const action = idx >= 0 ? '更新' : '新增'
if (idx >= 0) rows[idx] = row; else rows.push(row)
rows.sort((a, b) => a[0].localeCompare(b[0]))
writeSource(drawer, newDesc, rows)

if (JSON_OUT) console.log(JSON.stringify({ ok: true, action, drawer, file: relPath, sha256: row[4], rows: rows.length }, null, 2))
else console.log(`${action === '更新' ? '♻️' : '✅'} ${action}来源：${relPath}（${type}，${row[4].slice(0, 12)}…，${date}）｜来源表共 ${rows.length} 行`)
process.exit(0)
