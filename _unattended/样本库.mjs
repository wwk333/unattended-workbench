#!/usr/bin/env node
/**
 * 样本库 —— 无人值守的**长期样本层**（施工文档 §12 落地）。
 *
 * 为什么要有（一句话）：调参要"越攒越准"，而收据跟着项目走 —— **项目一删就清零**。
 *   所以样本必须存在**工作台根**（`_crew\样本\`），不放进项目；项目删了，库里那行照样有效。
 *
 * 一条样本 ＝ **一张卡的一次真实执行**（不是一次对话）。字段见 §12.3。
 *
 * 判据（§12.5，两条线，不是 A/B 二分）：
 *   · 意图：`purpose` —— 显式声明优先（`编排 --purpose drill` → 写进 verdict；否则项目根 `gate.json` 的 `purpose`），
 *     都没有才按老数据的项目名兜底。**不靠猜名字**。
 *   · 证据：`ev{verdict,dispatch,envelope,ledger,chain}` 五个布尔，**入库时按位记录、永不改**。
 *   · 能进统计：`purpose==="real" && ev.verdict && (ev.ledger || ev.dispatch)`
 *     —— 信封（原始输出）被清理了照样能用：调参要的数字（判决/耗时/产物）都在收据里。
 *   · 能追责：五件套全 true 且 `ev.chain`。
 *
 * 删失（§12.6）：超时卡的 `tookMs` ≈ 上限，真实耗时是"至少这么多" ⇒ 记 `censored:true`，
 *   算耗时分布时必须排除（否则会把上限越推越松）。
 *
 * 防事后改（§12.7）：每条带 `h = sha1(prev + 关键字段)`、`prev` ＝ 上一条的 `h`（哈希链）。
 *   ⚠️ 挡不住"当场伪造"，只挡"事后篡改"。
 *
 * 用法：
 *   node 样本库.mjs ingest --project <项目> [--dry-run] [--json]
 *   node 样本库.mjs ingest --all [--dry-run] [--json]      # 扫所有能找到的项目（补扫）
 *   node 样本库.mjs stats [--json]                          # 库有多大、按项目/意图分布
 * 退出码：0 正常 / 2 用法错 / 3 库坏了（某行解析失败但不阻塞）
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROJECTS_ROOT } from './_路径.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const WS = resolve(HERE, '..')
export const DIR = join(WS, '_crew', '样本')
export const LIB = join(DIR, '样本.jsonl')
export const REJECT = join(DIR, '拒收.jsonl')
export const CHAIN = join(DIR, '链头.json')
export const SCHEMA = 'sample-v2'

const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return d } }
const writeJson = (p, o) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(o, null, 2) + '\n', 'utf8') }
const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex')
const norm = (s) => String(s ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** 老数据兜底用的演练项目名（**新数据看 `purpose` 声明，不看名字**）。
 *  ⚠️ 这张表只服务"入库时还没有 purpose 字段"的老收据；2026-10-24 首次回填时实测漏了
 *  `_t_d21` / `_t_d22b` / `_演练`（无数字）⇒ 这里按"工作台自带的测试脚手架"放宽，别再一个个补。 */
const DRILL_RE = [
  /\/_演练\d*$/i,
  /\/_t_[a-z0-9]+$/i,
  /\/_t_e2e$/i,
  /\/_t_p\d+$/i,
  /\/_并行冒烟$/i,
  /\/_冒烟[a-z0-9]*$/i,
  /\/e2e-proj$/i
]

/** 这个项目/这一轮算不算演练：**声明优先**，名字只兜底（§12.5）。 */
export function purposeOf (project, verdictPurpose = null) {
  if (verdictPurpose) return String(verdictPurpose)
  const g = readJson(join(project, 'gate.json'))
  if (g && g.purpose) return String(g.purpose)
  const n = norm(project)
  if (DRILL_RE.some((re) => re.test(n))) return 'drill'
  return 'real'
}

/** 幂等键：同一个项目同一轮的同一张卡只算一次。 */
export function keyOf (proj, run, task) { return sha1(`${norm(proj)}|${run}|${task}`) }

/** 这条样本能不能进统计（§12.5 第一套阈值）。 */
export function countable (s) {
  return s && s.purpose === 'real' && s.ev?.verdict === true && (s.ev?.ledger === true || s.ev?.dispatch === true)
}
/** 能不能用来追责/复核（§12.5 第二套阈值）。 */
export function auditable (s) {
  return countable(s) && s.ev?.envelope === true && s.ev?.chain === true
}

/** 读全库（坏行跳过，不炸）。 */
export function readAll (file = LIB) {
  if (!existsSync(file)) return []
  const out = []
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    try { out.push(JSON.parse(t)) } catch { /* 坏行跳过 */ }
  }
  return out
}

/** 链头：库里最后一条的 h（文件不存在＝空串）。 */
export function chainHead () {
  const j = readJson(CHAIN, null)
  if (j && typeof j.h === 'string') return j.h
  const all = readAll()
  return all.length ? String(all[all.length - 1].h ?? '') : ''
}

/** 角色 → 载体（取工作台 `agents.json` 的当前映射；取不到留空，不猜）。 */
function roleCarrierMap () {
  const j = readJson(join(WS, '_crew', 'agents.json'), null)
  const m = new Map()
  for (const [role, v] of Object.entries(j?.roles ?? {})) m.set(role, v?.agent ?? null)
  return m
}

/** 账本：envelope(规范化) → 那条调用（用来判 ev.ledger 并取 sessionId）。 */
function ledgerByEnvelope () {
  const m = new Map()
  const j = readJson(join(WS, '_crew', 'ledger.json'), { calls: [] })
  for (const c of (j.calls ?? [])) {
    if (c?.envelope) m.set(norm(c.envelope), c)
  }
  return m
}

/** 卡级（L1–L4）：走 `台账.mjs machine --json`（唯一读写口，不自己猜 TASKS.md）。 */
function levelsOf (project) {
  const m = new Map()
  try {
    const out = execFileSync(process.execPath, [join(HERE, '台账.mjs'), 'machine', '--project', project, '--json'],
      { encoding: 'utf8', maxBuffer: 8 << 20, timeout: 30000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    const d = JSON.parse(out)
    for (const [id, t] of Object.entries(d?.tasks ?? {})) if (t?.level) m.set(id, t.level)
  } catch { /* 读不到就没 level，不猜 */ }
  return m
}

/**
 * 从一轮的 `verdict.json` 推出样本行（并给出拒收原因）。
 * @returns {{ rows: object[], rejects: object[] }}
 */
export function deriveFromRun (project, runDir, ctx = {}) {
  const v = readJson(join(runDir, 'verdict.json'), null)
  if (!v) return { rows: [], rejects: [] }
  const run = basename(runDir)
  const proj = basename(project)
  const purpose = purposeOf(project, v.purpose)
  const roleMap = ctx.roleMap ?? new Map()
  const led = ctx.ledger ?? new Map()
  const levels = ctx.levels ?? new Map()
  const rows = []; const rejects = []
  for (const r of (v.results ?? [])) {
    const task = r?.task ? String(r.task) : null
    const base = { ts: new Date().toISOString(), proj, path: project, run, task, schema: SCHEMA }
    if (!task) { rejects.push({ ...base, why: '缺 task（没有卡号就不是一张卡）' }); continue }
    const envPath = r.outJson || join(runDir, 'tasks', `${task}.out.json`)
    const dispatchPath = join(runDir, 'tasks', `${task}.dispatch.json`)
    // 载体/模型：**派活回执**里最准（收据的 results 不带 model）
    const disp = readJson(dispatchPath, null)
    const ev = {
      verdict: true,
      dispatch: existsSync(dispatchPath),
      envelope: existsSync(envPath),
      ledger: led.has(norm(envPath)),
      chain: true
    }
    if (purpose === 'drill') { rejects.push({ ...base, why: 'purpose=drill（演练/试卡，不进统计）' }); continue }
    const produced = ((r.fingerprint?.added ?? 0) + (r.fingerprint?.changed ?? 0)) > 0
    const verdict = String(r.verdict ?? '')
    const tok = Number(r.tookMs)
    const role = String(r.role ?? disp?.role ?? '').trim() || null
    rows.push({
      ts: base.ts, proj, path: project, run, task,
      level: levels.get(task) ?? null,
      role,
      carrier: roleMap.get(role) ?? null,
      model: disp?.model ?? r.model ?? null,
      verdict,
      tookMin: Number.isFinite(tok) && tok > 0 ? Math.round((tok / 60000) * 10) / 10 : null,
      produced,
      outOfScope: (r.outOfScope ?? []).length,
      attributed: (r.outOfScopeKind?.realOverreach ?? []).length,
      retryOf: r.retryOf ?? null,
      acOk: r.ac?.ok ?? null,
      policy: r.policy ?? null,
      purpose,
      ev,
      // §12.6：超时卡的耗时是"至少"（右删失）⇒ 算分布时必须排除
      censored: /timeout/i.test(verdict) || r.timedOut === true,
      schema: SCHEMA
    })
  }
  return { rows, rejects }
}

/** 把一批行追加进库（带哈希链），返回 { added, lastH }。 */
function appendRows (rows, dryRun) {
  let head = chainHead()
  const lines = []
  for (const r of rows) {
    const { h: _h, prev: _p, ...rest } = r
    const body = JSON.stringify(rest)
    const h = sha1(head + body)
    lines.push(JSON.stringify({ ...rest, h, prev: head }))
    head = h
  }
  if (!dryRun && lines.length) {
    mkdirSync(DIR, { recursive: true })
    appendFileSync(LIB, lines.join('\n') + '\n', 'utf8')
    writeJson(CHAIN, { at: new Date().toISOString(), h: head, n: readAll().length })
  }
  return { added: lines.length, lastH: head, lines }
}

function pushRejects (rejects, dryRun) {
  if (dryRun || !rejects.length) return
  mkdirSync(DIR, { recursive: true })
  appendFileSync(REJECT, rejects.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8')
}

/** 入库一个项目（幂等）。 */
export function ingestProject (project, { dryRun = false } = {}) {
  const runs = join(project, '_crew', 'runs')
  if (!existsSync(runs)) return { project, added: 0, skipped: 0, rejected: 0, note: '没有 runs 目录' }
  const seen = new Set(readAll().map((s) => keyOf(s.path, s.run, s.task)))
  const ctx = { roleMap: roleCarrierMap(), ledger: ledgerByEnvelope(), levels: levelsOf(project) }
  const dirs = readdirSync(runs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  const fresh = []; const rejects = []
  let skipped = 0
  for (const d of dirs) {
    const { rows, rejects: rj } = deriveFromRun(project, join(runs, d), ctx)
    rejects.push(...rj)
    for (const row of rows) {
      const k = keyOf(row.path, row.run, row.task)
      if (seen.has(k)) { skipped++; continue }
      seen.add(k); fresh.push(row)
    }
  }
  const { added } = appendRows(fresh, dryRun)
  pushRejects(rejects, dryRun)
  return { project, runs: dirs.length, added, skipped, rejected: rejects.length }
}

/** 找所有"像项目"的目录（补扫用）：当前项目 ＋ 映射表里的值 ＋ 常见根下的子目录。 */
export function discoverProjects () {
  const out = new Set()
  const add = (p) => { if (p && existsSync(join(p, '_crew', 'runs'))) out.add(resolve(p)) }
  const ptr = join(WS, '_crew', '当前项目.txt')
  if (existsSync(ptr)) add(readFileSync(ptr, 'utf8').trim().split(/\r?\n/)[0].trim())
  const map = readJson(join(WS, '_crew', '项目映射.json'), null)
  for (const v of Object.values(map?.map ?? {})) add(v)
  for (const root of [join(WS, 'workspaces'), PROJECTS_ROOT].filter(Boolean)) {
    if (!existsSync(root)) continue
    for (const d of readdirSync(root, { withFileTypes: true })) if (d.isDirectory()) add(join(root, d.name))
  }
  return [...out]
}

/** 库的体检（看板/体检用）。 */
export function stats () {
  const all = readAll()
  const byProj = {}; const byPurpose = {}
  let countableN = 0; let censored = 0
  for (const s of all) {
    byProj[s.proj] = (byProj[s.proj] ?? 0) + 1
    byPurpose[s.purpose] = (byPurpose[s.purpose] ?? 0) + 1
    if (countable(s)) countableN++
    if (s.censored) censored++
  }
  let bytes = 0
  try { bytes = statSync(LIB).size } catch {}
  let rejects = 0
  try { rejects = readFileSync(REJECT, 'utf8').split(/\r?\n/).filter(Boolean).length } catch {}
  return { ok: true, kind: 'sample-lib', at: new Date().toISOString(), file: LIB, bytes, total: all.length, countable: countableN, censored, rejects, byProj, byPurpose, head: chainHead() }
}

// ── CLI ──
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
  const has = (n) => argv.includes('--' + n)
  const dry = has('dry-run')
  if (cmd === 'ingest') {
    const one = opt('project')
    const list = one ? [resolve(one)] : (has('all') ? discoverProjects() : [])
    if (!list.length) { console.error('用法：样本库.mjs ingest --project <项目> | --all'); process.exit(2) }
    const res = list.map((p) => ingestProject(p, { dryRun: dry }))
    if (has('json')) { console.log(JSON.stringify({ ok: true, dryRun: dry, res, stats: stats() }, null, 2)); process.exit(0) }
    for (const r of res) console.log(`   ${r.project}　轮 ${r.runs ?? 0} · 新入 ${r.added} · 已在库 ${r.skipped} · 拒收 ${r.rejected}${r.note ? '（' + r.note + '）' : ''}`)
    const s = stats()
    console.log(`📦 样本库：${s.total} 条（可统计 ${s.countable} · 删失 ${s.censored} · 拒收记录 ${s.rejects}）${dry ? '　【dry-run，没写盘】' : ''}`)
    process.exit(0)
  }
  if (cmd === 'stats') {
    const s = stats()
    if (has('json')) { console.log(JSON.stringify(s, null, 2)); process.exit(0) }
    console.log(`📦 ${s.file}`)
    console.log(`   ${s.total} 条 · 可统计 ${s.countable} · 删失 ${s.censored} · 拒收记录 ${s.rejects} · ${(s.bytes / 1024).toFixed(1)} KB`)
    console.log('   按项目：' + Object.entries(s.byProj).map(([k, v]) => `${k}=${v}`).join(' · '))
    console.log('   按意图：' + Object.entries(s.byPurpose).map(([k, v]) => `${k}=${v}`).join(' · '))
    process.exit(0)
  }
  console.error('用法：样本库.mjs ingest --project <项目> [--dry-run] [--json] | ingest --all | stats')
  process.exit(2)
}
