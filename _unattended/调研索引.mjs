#!/usr/bin/env node
/**
 * 调研索引 —— 调研库 S1/S3（零 token）：**两级索引只由本脚本生成**，人和 AI 都不许手改。
 *
 * 一级 `<库>\_索引.md`：一行一个抽屉（抽屉 | 条目数 | 更新日 | 一句话）
 * 二级 `<库>\索引\<抽屉>.md`：一行一份原文（主题 | 路径 | 版本 | 抓取日 | 说明）
 *   —— 二级的每一行都**搬自 `来源\<抽屉>.md`**（说明也在那里给），脚本不编造任何一个字。
 *
 * 两条机检（`--check`，v3 新增）：
 *   ① **词可达性**：说明里 ≥2 个 ASCII 标识符，且**每个都能在原文里真找到**（防"编词"＝索引失效）
 *   ② **锚有效性**：笔记里 `路径#L12-20` 的路径存在、行号在文件范围内（防"锚指向空气"）
 *
 * 用法：
 *   node 调研索引.mjs --project <P> --init     # 建骨架（幂等；不覆盖已有文件）
 *   node 调研索引.mjs --project <P>            # 重跑索引（幂等：日期取文件 mtime，不取当前时间）
 *   node 调研索引.mjs --project <P> --check    # 只检查不写盘（exit 2＝有问题）
 *   node 调研索引.mjs --project <P> --json
 *   · 不给 `--project`：读 `_crew\当前项目.txt`
 *
 * 铁律：**空库／没有库 ⇒ 静默退出 0**（不建库不影响任何现有流程）。
 */
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? d) : d }
const JSON_OUT = has('json')
const INIT = has('init')
const DEMO = has('demo')
const CHECK = has('check')

function projectDir () {
  const a = opt('project')
  if (a) return resolve(a)
  try { return resolve(readFileSync(join(HERE, '..', '_crew', '当前项目.txt'), 'utf8').trim()) } catch { return null }
}
const PROJECT = projectDir()
if (!PROJECT) { console.error('❌ 没有钉住的项目：给 --project <目录>，或先写 `_crew\\当前项目.txt`'); process.exit(1) }

const LIB = join(PROJECT, '文档', '调研')
const P_MAT = join(LIB, '资料')
const P_SRC = join(LIB, '来源')
const P_IDX = join(LIB, '索引')
const P_NOTE = join(LIB, '笔记')
const TOP = join(LIB, '_索引.md')
const TPL = join(HERE, '模板', '调研库')
const DESC_RE = /^<!--\s*抽屉一句话[:：]\s*([\s\S]*?)\s*-->\s*$/m
const COL_N = 7

const day = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` }

function drawers () {
  if (!existsSync(P_MAT)) return []
  return readdirSync(P_MAT, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort()
}
function filesOf (d) {
  const p = join(P_MAT, d)
  if (!existsSync(p)) return []
  return readdirSync(p, { withFileTypes: true }).filter(e => e.isFile() && !e.name.startsWith('_')).map(e => e.name).sort()
}
function readSource (d) {
  const p = join(P_SRC, d + '.md')
  if (!existsSync(p)) return { desc: '', rows: [] }
  const txt = readFileSync(p, 'utf8')
  const dm = txt.match(DESC_RE)
  const rows = []
  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('|')) continue
    const cells = t.split('|').slice(1, -1).map(x => x.trim())
    if (cells.length < COL_N) continue
    if (cells[0] === '文件' || /^-+$/.test(cells[0].replace(/[: ]/g, ''))) continue
    rows.push(cells.slice(0, COL_N))
  }
  rows.sort((a, b) => a[0].localeCompare(b[0]))
  return { desc: dm ? dm[1] : '', rows }
}

// ---------------------------------------------------------------- --init
if (INIT) {
  const made = []
  for (const d of [LIB, P_MAT, P_SRC, P_IDX, P_NOTE]) if (!existsSync(d)) { mkdirSync(d, { recursive: true }); made.push(d) }
  if (!existsSync(TOP)) {
    writeFileSync(TOP, '# 调研库 · 一级索引\n\n> 本文件由 `_unattended\\调研索引.mjs` **生成，别手改**。\n> 一行一个抽屉；大脑只读这一份（几十行），原文去 `资料\\<抽屉>\\` 按路径读。\n\n| 抽屉 | 条目数 | 更新日 | 一句话 |\n|---|---|---|---|\n', 'utf8')
    made.push(TOP)
  }
  // 模板样例（S10）：只在库是新建时拷一份，已有文件不覆盖
  if (existsSync(TPL)) {
    for (const f of readdirSync(TPL, { withFileTypes: true })) {
      const dst = join(LIB, f.name)
      if (f.isFile() && !existsSync(dst)) { copyFileSync(join(TPL, f.name), dst); made.push(dst) }
    }
  }
  if (DEMO) {
    // S10 示例抽屉：一份真原文 ＋ 一行来源表（走 登记来源.mjs，绝不手抄）＋ 索引，一眼看到成品
    const dd = '示例'
    const matDir = join(P_MAT, dd)
    mkdirSync(matDir, { recursive: true })
    const f = join(matDir, '示例原文.md')
    if (!existsSync(f)) {
      writeFileSync(f, '# 示例原文\n\n这段文字里有两个记号：sampleToken 与 AnchorDemo。\n登记时把这两个词写进"说明"，就能通过"词可达性"检查（索引里的词必须真在原文里）。\n', 'utf8')
      const r = spawnSync(process.execPath, [join(HERE, '登记来源.mjs'), '--project', PROJECT, '--drawer', dd, '--file', '示例原文.md',
        '--type', 'other', '--note', '示例：sampleToken 的用法与 AnchorDemo 结构', '--drawer-desc', '看一遍就知道怎么建抽屉'], { encoding: 'utf8', maxBuffer: 8 << 20 })
      if (r.status === 0) made.push(f + '（已登记）')
      else console.error('[init --demo] 登记失败：' + String(r.stderr || '').trim().split('\n').pop())
    }
  }
  if (JSON_OUT) console.log(JSON.stringify({ ok: true, lib: LIB, created: made }, null, 2))
  else console.log(made.length ? `✅ 建库完成（新建 ${made.length} 项）：${LIB}` : `ℹ️ 库已存在，未改动：${LIB}`)
  // ⚠️ 不 exit：接着往下重跑索引（`--demo` 时立刻能看到成品）
}

// ---------------------------------------------------------------- 没有库 ⇒ 静默
if (!existsSync(LIB)) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: true, skip: 'no-library', lib: LIB }))
  else console.log('ℹ️ 没有调研库（未建库不影响任何流程）—— 要建：`调研索引.mjs --init`')
  process.exit(0)
}

// ---------------------------------------------------------------- 生成两级索引（幂等）
const D = drawers()
const level1 = []
const level2 = new Map()
const issues = []
for (const d of D) {
  const { desc, rows } = readSource(d)
  const fs = filesOf(d)
  const byPath = new Map(rows.map(r => [r[0], r]))
  const out = []
  for (const f of fs) {
    const relPath = `资料/${d}/${f}`
    const r = byPath.get(relPath)
    const abs = join(P_MAT, d, f)
    if (!r) { out.push([`\`${f}\``, '—', '**未登记**', '—', '⚠️ 没有来源表行（先 `登记来源.mjs`）']); continue }
    const ver = (r[1] === 'git' && r[3] && r[3] !== '-') ? r[3] : (r[4] || '').slice(0, 12)
    out.push([`\`${f}\``, (() => { try { return day(statSync(abs).mtimeMs) } catch { return '—' } })(), ver, r[5] || '—', r[6] || '—'])
  }
  // 来源表里有、盘上没有的 ⇒ 也列出来（别让它静默消失）
  for (const r of rows) if (!fs.includes(r[0].split('/').pop())) out.push([`\`${r[0].split('/').pop()}\``, '—', (r[4] || '').slice(0, 12), r[5] || '—', '⚠️ 原文不在盘上'])
  const newest = fs.map(f => { try { return statSync(join(P_MAT, d, f)).mtimeMs } catch { return 0 } }).reduce((a, b) => Math.max(a, b), 0)
  level1.push([d, String(fs.length), newest ? day(newest) : '—', desc || '_（未填：登记时 `--drawer-desc` 补一句）_'])
  level2.set(d, out)
}

const mkL1 = () => [
  '# 调研库 · 一级索引', '',
  '> 本文件由 `_unattended\\调研索引.mjs` **生成，别手改**。',
  '> 一行一个抽屉；大脑只读这一份（几十行），原文去 `资料\\<抽屉>\\` 按路径读。', '',
  '| 抽屉 | 条目数 | 更新日 | 一句话 |', '|---|---|---|---|',
  ...level1.map(r => `| ${r.join(' | ')} |`), ''
].join('\n')

const mkL2 = (d) => [
  `# 二级索引 · ${d}`, '',
  `> 本文件由 \`_unattended\\调研索引.mjs\` **生成，别手改**；一行一份原文，说明搬自 \`来源\\${d}.md\`。`, '',
  '| 主题 | 落盘日 | 版本/sha | 抓取日 | 说明 |', '|---|---|---|---|---|',
  ...(level2.get(d) || []).map(r => `| ${r.join(' | ')} |`), ''
].join('\n')

// ---------------------------------------------------------------- --check（两条机检 ＋ 来源校验）
function checkWords () {
  const bad = []
  for (const d of D) {
    const { rows } = readSource(d)
    for (const r of rows) {
      const note = r[6] || ''
      const toks = [...new Set((note.match(/[A-Za-z][A-Za-z0-9_.:/-]{2,}/g) || []))]
      if (toks.length < 2) { bad.push(`[${d}] 说明里 ASCII 标识符不足 2 个："${note}"（${r[0]}）`); continue }
      const abs = join(LIB, r[0].split('/').join(sep))
      let text = ''
      try { text = readFileSync(abs, 'utf8') } catch { continue }
      const miss = toks.filter(t => !text.includes(t))
      if (miss.length) bad.push(`[${d}] 说明里的词在原文里找不到：${miss.join(' , ')}（${r[0]}）`)
    }
  }
  return bad
}
function checkAnchors () {
  const bad = []
  if (!existsSync(P_NOTE)) return bad
  for (const f of readdirSync(P_NOTE).filter(x => x.endsWith('.md'))) {
    const txt = readFileSync(join(P_NOTE, f), 'utf8')
    const re = /`([^`\s]+)#L(\d+)(?:-(\d+))?`/g
    let m
    while ((m = re.exec(txt))) {
      const [, relP, a, b] = m
      const abs = join(LIB, relP.split('/').join(sep))
      if (!existsSync(abs)) { bad.push(`[笔记/${f}] 锚指向不存在的文件：${relP}`); continue }
      const n = readFileSync(abs, 'utf8').split(/\r?\n/).length
      const hi = Number(b || a)
      if (Number(a) < 1 || hi > n) bad.push(`[笔记/${f}] 锚行号越界：${relP}#L${a}${b ? '-' + b : ''}（该文件只有 ${n} 行）`)
    }
  }
  return bad
}
function checkSources () {
  const r = spawnSync(process.execPath, [join(HERE, '登记来源.mjs'), '--project', PROJECT, '--check', '--json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  try { return JSON.parse(r.stdout).issues || [] } catch { return [] }
}

if (CHECK) {
  const w = checkWords(); const a = checkAnchors(); const s = checkSources()
  const all = [...w, ...a, ...s]
  if (JSON_OUT) { console.log(JSON.stringify({ ok: all.length === 0, drawers: D.length, words: w, anchors: a, sources: s }, null, 2)) }
  else {
    console.log(`调研库检查：${D.length} 屉`)
    console.log(`  词可达性：${w.length ? '⚠️ ' + w.length + ' 处' : '✅'}`)
    console.log(`  锚有效性：${a.length ? '⚠️ ' + a.length + ' 处' : '✅'}`)
    console.log(`  来源表  ：${s.length ? '⚠️ ' + s.length + ' 处' : '✅'}`)
    for (const x of all.slice(0, 30)) console.log('   - ' + x)
    if (all.length > 30) console.log(`   … 还有 ${all.length - 30} 处`)
  }
  process.exit(all.length ? 2 : 0)
}

// ---------------------------------------------------------------- 写盘
mkdirSync(P_IDX, { recursive: true })
const w1 = mkL1(); writeFileSync(TOP, w1, 'utf8')
for (const d of D) {
  const p = join(P_IDX, d + '.md'); const t = mkL2(d)
  if (!existsSync(p) || readFileSync(p, 'utf8') !== t) writeFileSync(p, t, 'utf8')
}
// 二级索引里已被删掉的抽屉文件，清理掉（避免读到空气）
if (existsSync(P_IDX)) for (const f of readdirSync(P_IDX).filter(x => x.endsWith('.md'))) if (!D.includes(f.slice(0, -3))) { try { writeFileSync(join(P_IDX, f), '', 'utf8') } catch {} }

const total = [...level2.values()].reduce((s, r) => s + r.length, 0)
if (JSON_OUT) console.log(JSON.stringify({ ok: true, drawers: D.length, entries: total, index: TOP }, null, 2))
else console.log(`✅ 索引已重跑：${D.length} 屉 / ${total} 条（${TOP}）`)
process.exit(0)
