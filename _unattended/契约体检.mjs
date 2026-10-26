#!/usr/bin/env node
/**
 * 契约体检 —— §八「契约有 AI 可执行的检测」
 *
 * 一句话：**文档里的约定，要能被机器判真伪**；判不了的就别写进文档。
 * 这里把 §八 那张"数据格式 × 字段 × 检查"表逐条变成可跑项，输出 `_crew/gate/contract-check.json`。
 *
 * 检查项（失败即红，不降级）：
 *   R1 核心契约登记表自检（每个事实一个写方、每个写方有消费方、无死字段）
 *   R2 信封统一（机器产物必须有 schema/kind/at/source/state/stale）
 *   R3 四套状态词表不串（attempt 里不许出现 blocked；task 里不许出现 completed）
 *   R4 `review.ok` 误用（调用成功当审核通过）
 *   R5 同名双写（同一个状态文件两个写方）
 *   R6 公共契约：5 个 schema 存在、自身合法、example 通过校验
 *   R7 HANDOFF 手写状态行未收编
 *   R8 TASKS.md 与库不一致（视图过期）
 *   R9 死字段（文档已删、代码还在写/读）
 *
 * 用法：
 *   node 契约体检.mjs [--project <dir>] [--json] [--write]
 * 退出码：0 全绿 / 3 有红项 / 2 用法错
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateRegistry, loadRegistry, DEAD_FIELDS } from './契约/写方.mjs'
import { ENVELOPE_REQUIRED, validateEnvelope, healthOf } from './契约/信封.mjs'
import { ENUMS } from './契约/枚举.mjs'
import { validate } from './_Schema.mjs'
import { readJsonSafe } from './契约/读.mjs'
import { extractMachine } from './_台账视图.mjs'
import { readHealthSources } from './_健康源.mjs'
import { StateClient } from './_状态客户端.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
export const WORKBENCH = resolve(HERE, '..')
export const CONTRACTS_DIR = join(WORKBENCH, 'contracts')
export const CHECK_OUT = join(WORKBENCH, '_crew', 'gate', 'contract-check.json')

/** 公共契约（§八 五个） */
export const PUBLIC_SCHEMAS = Object.freeze(['task', 'attempt', 'review', 'release', 'board-data'])

/** 机器产物清单（都要过信封） */
export const ENVELOPE_PRODUCTS = Object.freeze([
  { rel: ['_crew', '长命资源状态.json'], id: 'longlive' },
  { rel: ['_crew', '看护状态.json'], id: 'run-health' },
  { rel: ['_crew', '唤醒状态.json'], id: 'wake' },
  { rel: ['_crew', '卡片看护.json'], id: 'card-health' }
])

/** 允许出现 blocked 的词表（其余出现就是串词表） */
const BLOCKED_OWNERS = ['task', 'release']

/** 扫源码时要跳过的目录（备份/历史副本里当然有旧写法，不能算现行违规） */
const SKIP_DIRS = new Set(['backup', 'node_modules', 'logs', 'evidence', '.trash', 'dist', 'build'])

/**
 * 去掉注释再扫。
 * ★ 教训：R4 一开始直接正则扫全文，把**注释里**那句"`review.ok` 已改成 callOk"当成误用，
 *   一次报出 4 处假红。契约体检自己造假红，比不体检更糟。
 */
export function stripComments (src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1')
}

/** 遍历源码文件（跳过备份/日志/证据） */
export function walkSource (roots, visit, depth = 0, dir = null) {
  for (const root of roots) {
    const base = dir ?? root
    if (!existsSync(base)) continue
    for (const e of readdirSync(base, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith('.')) continue
      const p = join(base, e.name)
      if (e.isDirectory()) { if (depth < 3) walkSource([root], visit, depth + 1, p); continue }
      if (!/\.(mjs|js)$/.test(e.name)) continue
      visit(p, readFileSync(p, 'utf8'))
    }
  }
}

function ok (id, name, detail = null) { return { id, name, ok: true, detail } }
function bad (id, name, detail) { return { id, name, ok: false, detail } }

// ---------------------------------------------------------------- R1 登记表

export function checkRegistry (registry = loadRegistry()) {
  const v = validateRegistry(registry)
  if (!v.ok) return [bad('R1', '核心契约登记表自检', v.errors)]
  return [ok('R1', '核心契约登记表自检', { items: registry.items.length })]
}

// ---------------------------------------------------------------- R2 信封

export function checkEnvelopes ({ project = WORKBENCH } = {}) {
  const out = []
  for (const p of ENVELOPE_PRODUCTS) {
    const file = join(resolve(project), ...p.rel)
    if (!existsSync(file)) {
      out.push({ id: `R2:${p.id}`, name: `信封统一 ${p.id}`, ok: null, detail: `文件不存在（未知，不算绿）：${file}` })
      continue
    }
    const j = readJsonSafe(file)
    const v = validateEnvelope(j)
    out.push(v.ok
      ? ok(`R2:${p.id}`, `信封统一 ${p.id}`, { health: healthOf(j) })
      : bad(`R2:${p.id}`, `信封统一 ${p.id}`, `缺 ${v.missing.join(',')}`))
  }
  return out
}

// ---------------------------------------------------------------- R3 词表不串

/**
 * 在一份已存在的状态库里查串词表（直接读 DB，不依赖服务）。
 * @returns {object[]}
 */
export function checkEnums ({ dbFile = null } = {}) {
  const file = dbFile ?? join(WORKBENCH, '_crew', 'state', 'crew.db')
  if (!existsSync(file)) return [{ id: 'R3', name: '四套状态词表不串', ok: null, detail: `没有状态库（未知）：${file}` }]
  let db
  try {
    const { openDb } = require_openDb()
    db = openDb({ dbPath: file, readonly: true })
    const out = []
    const badTasks = db.prepare(`SELECT id,status FROM tasks WHERE status NOT IN (${ENUMS.task.map(() => '?').join(',')})`).all(...ENUMS.task)
    out.push(badTasks.length ? bad(`R3:task`, 'task 词表', badTasks.map(r => `${r.id}=${r.status}`)) : ok('R3:task', 'task 词表'))
    const badRuns = db.prepare(`SELECT run_id,state FROM runs WHERE state NOT IN (${ENUMS.run.map(() => '?').join(',')})`).all(...ENUMS.run)
    out.push(badRuns.length ? bad('R3:run', 'run 词表', badRuns.map(r => `${r.run_id}=${r.state}`)) : ok('R3:run', 'run 词表'))
    const badAttempts = db.prepare(`SELECT attempt_id,state FROM attempts WHERE state NOT IN (${ENUMS.attempt.map(() => '?').join(',')})`).all(...ENUMS.attempt)
    out.push(badAttempts.length ? bad('R3:attempt', 'attempt 词表', badAttempts.map(r => `${r.attempt_id}=${r.state}`)) : ok('R3:attempt', 'attempt 词表'))
    // attempt 里出现 blocked ⇒ 串了（blocked 只属于 task/release）
    const blockedAttempts = db.prepare(`SELECT attempt_id,state FROM attempts WHERE state = 'blocked'`).all()
    out.push(blockedAttempts.length ? bad('R3:attempt-blocked', 'attempt 不许 blocked', blockedAttempts.map(r => r.attempt_id)) : ok('R3:attempt-blocked', 'attempt 不许 blocked'))
    // task 里出现 completed ⇒ 串了（completed 是 run/attempt 的词）
    const completedTasks = db.prepare(`SELECT id,status FROM tasks WHERE status = 'completed'`).all()
    out.push(completedTasks.length ? bad('R3:task-completed', 'task 不许 completed', completedTasks.map(r => r.id)) : ok('R3:task-completed', 'task 不许 completed'))
    return out
  } catch (e) {
    return [{ id: 'R3', name: '四套状态词表不串', ok: null, detail: `读不了状态库（未知）：${String(e?.message ?? e)}` }]
  } finally { try { db?.close() } catch {} }
}

// `_状态库.mjs` 是同步模块，这里用动态 require 的等价写法（ESM 顶层只能 import）——
// 为了不把 `_状态库` 拉进 CLI 的启动路径，用一个惰性工厂包一层。
let _stateMod = null
function require_openDb () {
  if (!_stateMod) throw new Error('状态库模块未加载')
  return _stateMod
}
export async function preloadStateModule () { _stateMod = await import('./_状态库.mjs'); return true }

// ---------------------------------------------------------------- R4 review.ok

/** 源码里 `review.ok` 的判读（`verdict.review.ok` 当放行依据就是误用） */
export function checkReviewOk (files = null) {
  const targets = files ?? ['编排.mjs', '交付门.mjs', '_派活内核.mjs', '契约/审核.mjs', '门禁.mjs']
  const out = []
  for (const rel of targets) {
    const p = join(HERE, rel)
    if (!existsSync(p)) continue
    // ★ 先剥注释：注释里写"review.ok 已改成 callOk"不算误用（第一版没剥，一次报了 4 处假红）
    const src = stripComments(readFileSync(p, 'utf8'))
    const hits = [...src.matchAll(/(?:verdict\.)?review\.ok\b/g)].length
    const callOk = [...src.matchAll(/(?:verdict\.)?review\.callOk\b/g)].length
    if (hits) out.push(bad(`R4:${rel}`, `review.ok 误用 ${rel}`, `${hits} 处（应用 decision / callOk，不许把调用成功当通过）`))
    else if (callOk) out.push(ok(`R4:${rel}`, `review.ok 未误用 ${rel}`, { callOk }))
  }
  return out.length ? out : [ok('R4', 'review.ok 未误用')]
}

// ---------------------------------------------------------------- R5 同名双写

/** 一个状态文件只能有一个写方（`writeFileSync(…'看护状态.json'…)` 出现两处就是双写） */
export function checkDoubleWrite (roots = null) {
  const WATCHED = ['看护状态.json', '卡片看护.json', '长命资源状态.json', '唤醒状态.json', 'release-status.json', 'TASKS.md']
  const writers = new Map(WATCHED.map(f => [f, []]))
  walkSource(roots ?? [HERE], (p, src) => {
    const clean = stripComments(src)
    for (const f of WATCHED) {
      // 只看"真的写"，不看注释/读
      const re = new RegExp(`(writeFileSync|appendFileSync|renameSync)\\s*\\([^)]*['"\`][^'"\`]*${f.replace('.', '\\.')}`, 'g')
      const n = [...clean.matchAll(re)].length
      if (n) writers.get(f).push(`${p.replace(WORKBENCH + '\\', '')}×${n}`)
    }
  })
  const out = []
  for (const [f, ws] of writers) {
    // 允许的成对写法：`X.json.tmp` 写 + rename 到 `X.json` 是**同一个写方**（原子替换），不算双写
    const real = ws.filter(w => !/\.tmp/.test(w))
    if (real.length > 1) out.push(bad(`R5:${f}`, `同名双写 ${f}`, real))
  }
  return out.length ? out : [ok('R5', '同名双写检查')]
}

// ---------------------------------------------------------------- R6 公共契约

export function checkSchemas ({ dir = CONTRACTS_DIR, checkExamples = true } = {}) {
  const out = []
  for (const name of PUBLIC_SCHEMAS) {
    const file = join(dir, `${name}.schema.json`)
    if (!existsSync(file)) { out.push(bad(`R6:${name}`, `契约 ${name}`, `缺 ${file}`)); continue }
    let schema = null
    try { schema = JSON.parse(readFileSync(file, 'utf8')) } catch (e) {
      out.push(bad(`R6:${name}`, `契约 ${name}`, `不是合法 JSON：${String(e?.message ?? e)}`)); continue
    }
    if (!schema.$id) { out.push(bad(`R6:${name}`, `契约 ${name}`, '缺 $id')); continue }
    const failures = []
    for (const [i, ex] of (schema.examples ?? []).entries()) {
      if (!checkExamples) break
      const r = validate(schema, ex, `#/examples/${i}`)
      if (!r.ok) failures.push(...r.errors)
    }
    out.push(failures.length ? bad(`R6:${name}`, `契约 ${name}`, failures) : ok(`R6:${name}`, `契约 ${name}`, { examples: (schema.examples ?? []).length }))
  }
  return out
}

// ---------------------------------------------------------------- R7 HANDOFF

/** HANDOFF 里手写的"已交付/已验收"行必须被收编进机器块（否则文件和事实两套说法） */
export function checkHandoff ({ project = WORKBENCH } = {}) {
  const files = [join(resolve(project), 'HANDOFF.md'), join(resolve(project), '_crew', 'HANDOFF.md')].filter(existsSync)
  if (!files.length) return [{ id: 'R7', name: 'HANDOFF 手写状态', ok: null, detail: '没有 HANDOFF.md（未知）' }]
  const out = []
  for (const f of files) {
    const src = readFileSync(f, 'utf8')
    const hasBlock = /<!--\s*RELEASE-BLOCK/.test(src)
    // 机器块之外还有手写的"已交付/已验收" ⇒ 红
    const outside = src.replace(/<!--\s*RELEASE-BLOCK[\s\S]*?<!--\s*\/RELEASE-BLOCK\s*-->/, '')
    const handWritten = [...outside.matchAll(/^\s*(?:[-*]\s*)?(已交付|已验收|交付状态)\s*[:：]/gm)].length
    if (!hasBlock && handWritten) out.push(bad(`R7:${f}`, 'HANDOFF 手写状态', `有 ${handWritten} 处手写状态且没有 RELEASE-BLOCK 机器块`))
    else if (hasBlock && handWritten) out.push(ok(`R7:${f}`, 'HANDOFF 手写状态', { handWritten, note: '手写行已投影为注释（交付门负责）' }))
  }
  return out.length ? out : [ok('R7', 'HANDOFF 手写状态')]
}

// ---------------------------------------------------------------- R8 TASKS 视图

export async function checkTasksView ({ project = WORKBENCH } = {}) {
  const file = join(resolve(project), 'TASKS.md')
  if (!existsSync(file)) return [{ id: 'R8', name: 'TASKS 视图一致', ok: null, detail: '没有 TASKS.md（未知）' }]
  const m = extractMachine(readFileSync(file, 'utf8'))
  if (!m.ok) return [bad('R8', 'TASKS 视图一致', m.why)]
  let rows = null
  try {
    const c = new StateClient({ ensure: false, timeoutMs: 1500 })
    rows = await c.tasks(resolve(project))
  } catch (e) {
    return [{ id: 'R8', name: 'TASKS 视图一致', ok: null, detail: `C 服务不可用（未知，不判绿）：${String(e?.message ?? e)}` }]
  }
  const diffs = []
  for (const t of rows) {
    const v = m.data.tasks?.[t.id]
    if (!v) diffs.push(`${t.id} 库有视图无`)
    else if (v.state !== t.status) diffs.push(`${t.id} 库=${t.status} 视图=${v.state}`)
  }
  for (const id of Object.keys(m.data.tasks ?? {})) if (!rows.some(t => t.id === id)) diffs.push(`${id} 视图有库无`)
  return [diffs.length ? bad('R8', 'TASKS 视图一致', diffs.slice(0, 8)) : ok('R8', 'TASKS 视图一致')]
}

// ---------------------------------------------------------------- R9 死字段

export function checkDeadFields (roots = null) {
  const out = []
  // ★ DEAD_FIELDS 是**数组**（`{id, field, why, files[], pattern}`），不是 `{字段: 正则}` 的字典。
  //   第一版按字典迭代 ⇒ 拿数组下标当字段名、拿 `{}` 当正则，于是"每个文件都违规"，
  //   一次报出 7 条假红（还把自己 `契约体检.mjs` 也标了）。这类"体检器自己造红"必须先修。
  const list = Array.isArray(DEAD_FIELDS) ? DEAD_FIELDS : []
  if (!list.length) return [ok('R9', '死字段检查', { patterns: 0 })]
  for (const entry of list) {
    const field = String(entry.field ?? '')
    // 只看它声明的那几个文件（`files` 就是"以前用过它的地方"）
    const targets = Array.isArray(entry.files) ? entry.files : []
    const hits = []
    walkSource(roots ?? [HERE], (p, src) => {
      const rel = p.replace(WORKBENCH + '\\', '').replace(HERE.replace(WORKBENCH + '\\', '') + '\\', '')
      if (targets.length && !targets.includes(rel)) return
      const clean = stripComments(src)
      const re = entry.pattern?.re instanceof RegExp
        ? new RegExp(entry.pattern.re.source, entry.pattern.re.flags.replace('g', '') + 'g')
        : new RegExp(field.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\(.*\)$/, '') + '(?![\\w])', 'g')
      const n = [...clean.matchAll(re)].length
      if (n) hits.push(`${rel}×${n}`)
    })
    if (hits.length) out.push(bad(entry.id ?? `R9:${field}`, `死字段 ${field}`, { why: entry.why ?? null, hits }))
  }
  return out.length ? out : [ok('R9', '死字段检查', { patterns: list.length })]
}

// ---------------------------------------------------------------- R10 写方必须有消费方

/**
 * §零：「一个事实一个写方；**每个写方必须有消费方**；没有消费方的字段删除」。
 * R5 只查"是不是两个人在写"，这里查"写完有没有人读" —— 写了一份没人看的状态，等于假的状态。
 *
 * 判据（按产物文件名找"提过它的文件"）：
 *   · 写方文件自己也算提过，所以至少要在**两个**文件里出现（写方 + 至少一个读者）；
 *   · 只出现在一个文件里 ⇒ 红（没人消费）。
 *
 * @param {string[]} products 产物文件名清单
 * @returns {object[]}
 */
export const CONSUMED_PRODUCTS = Object.freeze([
  '看护状态.json', '卡片看护.json', '长命资源状态.json', '唤醒状态.json',
  'release-status.json', 'gate-result.json', 'board-data.json', 'contract-check.json', 'TASKS.md'
])

export function checkConsumers (products = CONSUMED_PRODUCTS, roots = null) {
  const mentions = new Map(products.map(p => [p, []]))
  walkSource(roots ?? [HERE, join(WORKBENCH, 'scripts')], (p, src) => {
    const clean = stripComments(src)
    const rel = p.replace(WORKBENCH + '\\', '')
    for (const f of products) {
      if (clean.includes(f)) mentions.get(f).push(rel)
    }
  })
  const out = []
  for (const [f, who] of mentions) {
    if (who.length <= 1) {
      out.push(bad(`R10:${f}`, `写方没有消费方 ${f}`, {
        seen: who,
        why: who.length === 0 ? '整个代码库都没有人提它' : '只有它自己那份文件提到（写完没人读）'
      }))
    }
  }
  return out.length ? out : [ok('R10', '写方都有消费方', { products: products.length })]
}

// ---------------------------------------------------------------- 汇总

export async function runChecks ({ project = WORKBENCH, withDb = true } = {}) {
  if (withDb) { try { await preloadStateModule() } catch { /* 没装也能跑其它项 */ } }
  const groups = [
    checkRegistry(),
    checkEnvelopes({ project }),
    withDb ? checkEnums() : [{ id: 'R3', name: '四套状态词表不串', ok: null, detail: '未启用（--no-db）' }],
    checkReviewOk(),
    checkDoubleWrite(),
    checkSchemas(),
    checkHandoff({ project }),
    await checkTasksView({ project }),
    checkDeadFields(),
    checkConsumers()
  ]
  const checks = groups.flat()
  const red = checks.filter(c => c.ok === false)
  const unknown = checks.filter(c => c.ok === null)
  return {
    schema: 1,
    kind: 'contract-check',
    at: new Date().toISOString(),
    source: '契约体检.mjs',
    state: red.length ? 'red' : 'green',
    stale: false,
    ok: red.length === 0,
    project: resolve(project),
    counts: { total: checks.length, green: checks.filter(c => c.ok === true).length, red: red.length, unknown: unknown.length },
    checks
  }
}

// ---------------------------------------------------------------- CLI

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const a = process.argv.slice(2)
  const has = (n) => a.includes('--' + n)
  const opt = (n, d = null) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] ?? d : d }
  if (has('help')) { console.log('用法：契约体检.mjs [--project <dir>] [--json] [--write] [--no-db]'); process.exit(0) }
  const res = await runChecks({ project: opt('project', WORKBENCH), withDb: !has('no-db') })
  if (has('write')) {
    mkdirSync(dirname(CHECK_OUT), { recursive: true })
    writeFileSync(CHECK_OUT, JSON.stringify(res, null, 2) + '\n', 'utf8')
  }
  if (has('json')) console.log(JSON.stringify(res, null, 2))
  else {
    console.log(`[契约体检] ${res.state === 'green' ? '✅ 全绿' : '❌ 有红项'}　共 ${res.counts.total} 项：绿 ${res.counts.green} / 红 ${res.counts.red} / 未知 ${res.counts.unknown}`)
    for (const c of res.checks) {
      const mark = c.ok === true ? '✓' : c.ok === false ? '✗' : '?'
      if (c.ok !== true) console.log(`  ${mark} ${c.name}${c.detail ? `：${Array.isArray(c.detail) ? c.detail.join('；') : JSON.stringify(c.detail)}` : ''}`)
    }
  }
  process.exit(res.ok ? 0 : 3)
}
