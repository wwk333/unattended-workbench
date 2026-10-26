#!/usr/bin/env node
/**
 * 调研体检 —— 调研库 S7/S9（零 token）：**货架体检 ＋ 落盘收口判定**，人只对报表点头摇头。
 *
 * 报什么：抽屉/条目数 · 缺料几单 · 过期(>30 天)条目 · 空抽屉 · **零命中抽屉**（有货但没人查过）·
 *         未登记原文 · 索引是否比资料旧 · 来源表字段问题。
 * `--task <id>`：**落盘收口判定**（S5）—— 看收据里的 `research`：新增文件在不在 `资料/`、
 *         来源表过不过、索引有没有重跑。三件齐才算干完（缺一打印缺哪件）。
 *
 * 用法：
 *   node 调研体检.mjs --project <P> [--json]
 *   node 调研体检.mjs --project <P> --task T12 [--json]
 *   · 不给 `--project`：读 `_crew\当前项目.txt`
 *
 * 退出码：0 干净 ｜ 2 有问题（黄，不拦起飞） ｜ 3 收口缺件 ｜ 1 用法/环境错
 * 铁律：没有库 ⇒ 静默 0（不建库不影响任何流程）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? d) : d }
const JSON_OUT = has('json')
const TASK = opt('task', null)

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
const TOP = join(LIB, '_索引.md')
const MISS = join(PROJECT, '_crew', '缺料.jsonl')
const HITLOG = join(PROJECT, '_crew', '调研命中.log')
const EXPIRE_DAYS = 30
const now = Date.now()

function sources () {
  const m = new Map()
  if (!existsSync(P_SRC)) return m
  for (const f of readdirSync(P_SRC).filter(x => x.endsWith('.md'))) {
    const d = f.slice(0, -3)
    const rows = []
    for (const line of readFileSync(join(P_SRC, f), 'utf8').split(/\r?\n/)) {
      if (!line.startsWith('|')) continue
      const c = line.split('|').slice(1, -1).map(x => x.trim())
      if (c.length < 7 || c[0] === '文件' || /^-+$/.test(c[0].replace(/[: ]/g, ''))) continue
      rows.push({ file: c[0], type: c[1], ref: c[3], sha: c[4], date: c[5], note: c[6] })
    }
    m.set(d, rows)
  }
  return m
}

// ---------------------------------------------------------------- 收口判定（S5）
if (TASK) {
  const rec = join(PROJECT, '_crew', 'tasks', TASK + '.dispatch.json')
  const out = { ok: false, task: TASK, missing: [], detail: {} }
  if (!existsSync(rec)) { out.missing.push(`找不到收据：_crew\\tasks\\${TASK}.dispatch.json（这个任务没走派活？）`) }
  else {
    let d = null
    try { d = JSON.parse(readFileSync(rec, 'utf8')) } catch { out.missing.push('收据不是合法 JSON') }
    const r = d?.research || null
    if (!r) out.missing.push('收据里没有 `research` 字段（这张卡没带 --research，或旧版派活）')
    else {
      out.detail = r
      // 新增条目：收据里没写就**按时间窗现算**（收据生成之后落进 资料/ 的文件）—— 不靠载体自报
      let added = Array.isArray(r.added) ? r.added : []
      if (!added.length) {
        const since = (() => { try { return statSync(rec).mtimeMs - 2000 } catch { return 0 } })()
        added = []
        if (existsSync(P_MAT)) for (const dd of readdirSync(P_MAT, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name)) {
          for (const f of readdirSync(join(P_MAT, dd))) {
            try { if (statSync(join(P_MAT, dd, f)).mtimeMs >= since) added.push(`资料/${dd}/${f}`) } catch {}
          }
        }
      }
      // ① 新增文件在 资料/ 且真的落盘
      const badAdded = added.filter(p => !String(p).startsWith('资料/') || !existsSync(join(LIB, String(p).split('/').join(sep))))
      if (added.length && badAdded.length) out.missing.push(`新增条目不在 资料/ 或没落盘：${badAdded.join(' , ')}`)
      // ② 来源表逐行机判（复用 登记来源 --check）
      const ck = spawnSync(process.execPath, [join(HERE, '登记来源.mjs'), '--project', PROJECT, '--check', '--json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
      let issues = []
      try { issues = JSON.parse(ck.stdout).issues || [] } catch {}
      if (issues.length) out.missing.push(`来源表 ${issues.length} 处问题：${issues.slice(0, 3).join(' ； ')}`)
      // ③ 索引比新增文件新（＝索引重跑过）
      if (existsSync(TOP)) {
        const idxMs = statSync(TOP).mtimeMs
        const newest = added.map(p => { try { return statSync(join(LIB, String(p).split('/').join(sep))).mtimeMs } catch { return 0 } }).reduce((a, b) => Math.max(a, b), 0)
        if (newest && idxMs + 1000 < newest) out.missing.push('索引比新增的原文旧（新增后没重跑 `调研索引.mjs`）')
      } else out.missing.push('没有一级索引 `_index.md`（没重跑过索引）')
      out.detail = { cited: r.cited ?? 0, added: added.length, misses: Array.isArray(r.misses) ? r.misses.length : 0 }
    }
  }
  out.ok = out.missing.length === 0
  if (JSON_OUT) console.log(JSON.stringify(out, null, 2))
  else {
    if (out.ok) console.log(`✅ 收口通过：${TASK}（引用 ${out.detail.cited ?? 0} · 新增 ${out.detail.added ?? 0} · 缺料 ${out.detail.misses ?? 0}）`)
    else { console.log(`❌ 收口未过：${TASK}`); for (const m of out.missing) console.log('   - ' + m) }
  }
  process.exit(out.ok ? 0 : 3)
}

// ---------------------------------------------------------------- 货架体检
if (!existsSync(LIB)) {
  if (JSON_OUT) console.log(JSON.stringify({ ok: true, skip: 'no-library' }))
  else console.log('ℹ️ 没有调研库（未建库不影响任何流程）')
  process.exit(0)
}

const drawers = existsSync(P_MAT) ? readdirSync(P_MAT, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name).sort() : []
const src = sources()
const problems = []
const stat = { drawers: drawers.length, entries: 0, misses: 0, overdue: 0, empty: [], zeroHit: [], unregistered: 0, staleIndex: false, missingFile: 0 }

// 命中日志 → 哪些抽屉被查过
const hitCount = new Map()
if (existsSync(HITLOG)) for (const line of readFileSync(HITLOG, 'utf8').split(/\r?\n/).filter(Boolean)) {
  const c = line.split('\t'); const ds = c[3] || ''
  for (const d of ds.split(',').filter(Boolean)) hitCount.set(d, (hitCount.get(d) || 0) + 1)
}

for (const d of drawers) {
  const rows = src.get(d) || []
  const files = existsSync(join(P_MAT, d)) ? readdirSync(join(P_MAT, d)).filter(f => !f.startsWith('_')) : []
  stat.entries += files.length
  if (!files.length) { stat.empty.push(d); continue }
  if (!hitCount.get(d)) stat.zeroHit.push(d)
  const listed = new Set(rows.map(r => r.file.split('/').pop()))
  for (const f of files) if (!listed.has(f)) { stat.unregistered++; problems.push(`[${d}] 未登记：资料/${d}/${f}`) }
  for (const r of rows) {
    if (!files.includes(r.file.split('/').pop())) { stat.missingFile++; problems.push(`[${d}] 来源表有、盘上没有：${r.file}`) }
    if (/^\d{4}-\d{2}-\d{2}$/.test(r.date || '')) {
      const age = (now - new Date(r.date + 'T00:00:00').getTime()) / 864e5
      if (age > EXPIRE_DAYS) { stat.overdue++; problems.push(`[${d}] 过期 ${Math.floor(age)} 天：${r.file}（用前先复抓）`) }
    }
  }
}
if (existsSync(MISS)) stat.misses = readFileSync(MISS, 'utf8').split(/\r?\n/).filter(Boolean).length

// 索引是否比资料/来源旧
if (existsSync(TOP)) {
  const idxMs = statSync(TOP).mtimeMs
  let newest = 0
  for (const d of drawers) for (const f of readdirSync(join(P_MAT, d))) { try { newest = Math.max(newest, statSync(join(P_MAT, d, f)).mtimeMs) } catch {} }
  for (const f of (existsSync(P_SRC) ? readdirSync(P_SRC) : [])) { try { newest = Math.max(newest, statSync(join(P_SRC, f)).mtimeMs) } catch {} }
  if (newest && idxMs + 1000 < newest) { stat.staleIndex = true; problems.push('索引比资料/来源旧 —— 重跑 `调研索引.mjs`') }
} else { stat.staleIndex = true; problems.push('没有一级索引 —— 跑 `调研索引.mjs`') }

// 来源表格式问题（复用 登记来源 --check，零 token）
const ck = spawnSync(process.execPath, [join(HERE, '登记来源.mjs'), '--project', PROJECT, '--check', '--json'], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
let srcIssues = []
try { srcIssues = JSON.parse(ck.stdout).issues || [] } catch {}
for (const s of srcIssues) problems.push(s)

const ok = problems.length === 0
if (JSON_OUT) {
  console.log(JSON.stringify({ ok, skip: null, ...stat, problems }, null, 2))
} else {
  console.log(`调研库体检：${stat.drawers} 屉 / ${stat.entries} 条 / 缺料 ${stat.misses} 单`)
  console.log(`  过期(>${EXPIRE_DAYS}天)：${stat.overdue}　空抽屉：${stat.empty.length}　零命中抽屉：${stat.zeroHit.length}　未登记：${stat.unregistered}　索引旧：${stat.staleIndex ? '是' : '否'}`)
  if (stat.empty.length) console.log(`  空抽屉：${stat.empty.join(' , ')}（建了没进货 —— 要么补，要么拆）`)
  if (stat.zeroHit.length) console.log(`  零命中：${stat.zeroHit.join(' , ')}（有货没人查过 —— 检查说明里的词是不是写得太窄）`)
  if (!ok) { console.log(`⚠️ ${problems.length} 处要处理（黄级，不拦起飞）：`); for (const p of problems.slice(0, 25)) console.log('  - ' + p); if (problems.length > 25) console.log(`  … 还有 ${problems.length - 25} 处`) }
  else console.log('✅ 货架整齐')
}
process.exit(ok ? 0 : 2)
