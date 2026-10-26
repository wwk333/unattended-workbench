/**
 * 收据回写 —— 把一次载体调用记成 C 状态库里的 attempt（施工文档 §六 / D-11 第二步）
 *
 * ## 为什么要单独一个模块
 * 收活处（`编排.mjs`）是主流程正中间，**不能因为记账失败让整轮跑挂**。
 * 所以这里把"记账"包成一个**永不抛**的函数：成功返回 attemptId，失败返回 `{ok:false, why}`，
 * 调用方只需要 `if (!r.ok) 日志一句`。
 *
 * ## 它记什么 / 不记什么
 * - 记：attempt 的开始/结束（state 只取 completed / failed / aborted）、角色、载体、失败判决、
 *   以及 `ctxPeak / compactions / firstCompactionTokens`（从 `out.json` 事件流算，**算不出就留空**）。
 * - **不记**：任务状态迁移（那是台账/编排的事）、审核结论（那是交付门的事）。
 *   记账只回答"这一趟跑了吗、跑成什么样"，不改变任何业务判断。
 *
 * ## 铁律
 * - run 不存在就**建一个**（id 由调用方给，通常用 RUNDIR 的 stamp）——否则 attempt 无处可挂；
 * - 库里读不到 / 写不进 ⇒ `{ok:false}` + 原因，**绝不影响发卡与收活**；
 * - 时间戳用真实时间，不编。
 */

import { existsSync, readFileSync } from 'node:fs'
import { openDb, migrate, startRun, startAttempt, finishAttempt, listRuns, listAttempts } from './_状态库.mjs'
import { DEFAULT_DB } from './_状态常量.mjs'
import { compactionStats } from './_收据统计.mjs'

/** 载体输出里能看出判决的字段（只认结构，不猜自由文本） */
const FAIL_VERDICTS = ['capability', 'quota', 'auth', 'timeout', 'flaky', 'flaky-twice', 'input-error', 'budget-exhausted']

/**
 * 从 `out.json` 文本里抽事件数组（jsonl 或一个 {events:[...]}）。
 * 抽不出就返回 `[]` —— 让 `compactionStats` 如实说"没有事件流"。
 */
export function eventsOfOut (text) {
  const s = String(text ?? '').trim()
  if (!s) return []
  // ① 整份是一个 JSON 且带 events 数组
  try {
    const j = JSON.parse(s)
    if (Array.isArray(j?.events)) return j.events
  } catch {}
  // ② 逐行 jsonl
  const out = []
  for (const line of s.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    try { out.push(JSON.parse(t)) } catch {}
  }
  return out
}

/**
 * 打开库并确保 run 存在。**内部用**，异常交给调用方兜。
 */
function openFor (dbPath) {
  const db = openDb({ dbPath: dbPath ?? process.env.DSH_STATE_DB ?? DEFAULT_DB })
  migrate(db)
  return db
}

function ensureRun (db, { project, runId }) {
  const exists = listRuns(db, { project }).some(x => x.runId === runId)
  if (!exists) startRun(db, { runId, project, snapshotId: null })
}

function statsOf (outFile) {
  if (!outFile || !existsSync(outFile)) return { ctxPeak: null, compactions: null, firstCompactionTokens: null, why: '没有给 outFile' }
  try {
    const r = compactionStats(eventsOfOut(readFileSync(outFile, 'utf8')))
    return { ctxPeak: r.ctxPeak, compactions: r.compactions, firstCompactionTokens: r.firstCompactionTokens, why: r.why }
  } catch (e) {
    return { ctxPeak: null, compactions: null, firstCompactionTokens: null, why: `读 out 失败：${String(e?.message ?? e).slice(0, 80)}` }
  }
}

/**
 * **开工即登记**（D-11 第三步）。永不抛。
 *
 * 为什么要单独这一步：只在收活时补记 attempt，`startedAt` 会是"收活那一刻"，
 * 那一趟到底跑了多久就**永远算不出来**。开工时先登记，才有时长。
 *
 * @returns {{ ok:boolean, attemptId:string|null, why:string|null }}
 */
export function beginAttempt ({ project, runId, taskId, role = null, carrier = null, attemptKind = 'initial', dbPath = null } = {}) {
  if (!project || !runId || !taskId) return { ok: false, attemptId: null, why: 'beginAttempt 缺 project/runId/taskId' }
  let db = null
  try {
    db = openFor(dbPath)
    ensureRun(db, { project, runId })
    const id = `A-${runId}-${taskId}-${Date.now().toString(36)}`
    startAttempt(db, { attemptId: id, runId, project, taskId, attemptKind, role, carrier })
    return { ok: true, attemptId: id, why: null }
  } catch (e) {
    return { ok: false, attemptId: null, why: `开工登记失败（不影响本轮）：${String(e?.message ?? e).slice(0, 160)}` }
  } finally { try { db?.close() } catch {} }
}

/**
 * 收口一个**已登记**的 attempt（配 `beginAttempt`）。永不抛。
 * 如果这个 attempt 不存在（比如开工时库没打开），退回 `recordAttempt` 补一条完整的，
 * 免得"开工没记上、收活也不记" ⇒ 这一趟彻底消失。
 */
export function endAttempt ({ attemptId, project = null, runId = null, taskId = null, role = null, carrier = null, ok = false, verdict = null, why = null, outFile = null, dbPath = null } = {}) {
  const base = { ok: false, attemptId: attemptId ?? null, why: null, stats: null }
  let db = null
  try {
    db = openFor(dbPath)
    const row = attemptId ? listAttempts(db, { taskId, runId }).find(a => a.attemptId === attemptId) : null
    if (!row) {
      try { db.close() } catch {}
      db = null
      // 开工没登记成功 ⇒ 完整补一条（收活时刻为准，口径在文档里写明）
      const rec = recordAttempt({ project, runId, taskId, role, carrier, ok, verdict, why, outFile, attemptId, dbPath })
      return { ...rec, stats: rec.stats ?? null }
    }
    const stats = statsOf(outFile)
    finishAttempt(db, {
      attemptId: row.attemptId,
      state: ok ? 'completed' : 'failed',
      failure: ok ? null : { verdict: verdict ?? 'unknown', why: why ?? null },
      ctxPeak: stats.ctxPeak,
      compactions: stats.compactions,
      firstCompactionTokens: stats.firstCompactionTokens
    })
    return { ok: true, attemptId: row.attemptId, why: null, stats }
  } catch (e) {
    return { ...base, why: `收口登记失败（不影响本轮）：${String(e?.message ?? e).slice(0, 160)}` }
  } finally { try { db?.close() } catch {} }
}

/**
 * 记一次尝试。**永不抛**。
 * @param {object} o
 * @param {string} o.project
 * @param {string} o.runId      这次 run 的 id（通常用 RUNDIR 的 stamp）
 * @param {string} o.taskId
 * @param {string} [o.role]
 * @param {string} [o.carrier]
 * @param {boolean} o.ok        载体这趟算不算成功
 * @param {string} [o.outFile]  载体输出文件（用来算压缩统计）
 * @param {string} [o.verdict]  失败判决（ok=false 时尽量给）
 * @param {string} [o.why]
 * @param {string} [o.attemptId] 不给就自己生成
 * @param {string} [o.dbPath]
 * @returns {{ ok:boolean, attemptId:string|null, why:string|null, used:boolean, stats?:object }}
 */
export function recordAttempt ({ project, runId, taskId, role = null, carrier = null, ok = false, outFile = null, verdict = null, why = null, attemptId = null, dbPath = null } = {}) {
  const base = { ok: false, attemptId: null, why: null, used: false }
  if (!project || !runId || !taskId) return { ...base, why: 'recordAttempt 缺 project/runId/taskId' }
  let db = null
  try {
    db = openDb({ dbPath: dbPath ?? process.env.DSH_STATE_DB ?? DEFAULT_DB })
    migrate(db)

    // run 不存在就建（attempt 必须有地方挂，否则整条记录会丢）
    const exists = listRuns(db, { project }).some(x => x.runId === runId)
    if (!exists) startRun(db, { runId, project, snapshotId: null })

    const id = attemptId ?? `A-${runId}-${taskId}-${Date.now().toString(36)}`
    // 已经有同 id 的（重试重跑同一张卡）⇒ 不重复建，返回 already
    if (listAttempts(db, { runId, taskId }).some(a => a.attemptId === id)) {
      return { ...base, ok: true, attemptId: id, why: 'attempt 已存在（幂等，不重复记）', used: true }
    }

    const v = verdict && FAIL_VERDICTS.includes(String(verdict)) ? String(verdict) : (ok ? null : (verdict ?? 'unknown'))
    startAttempt(db, {
      attemptId: id, runId, project, taskId,
      attemptKind: 'initial',
      role: role ?? null,
      carrier: carrier ?? null
    })

    // 从 out.json 事件流算三个统计（算不出全是 null，**不估算**）
    let stats = { ctxPeak: null, compactions: null, firstCompactionTokens: null, why: '没有给 outFile' }
    if (outFile && existsSync(outFile)) {
      try {
        const r = compactionStats(eventsOfOut(readFileSync(outFile, 'utf8')))
        stats = { ctxPeak: r.ctxPeak, compactions: r.compactions, firstCompactionTokens: r.firstCompactionTokens, why: r.why }
      } catch (e) { stats = { ctxPeak: null, compactions: null, firstCompactionTokens: null, why: `读 out 失败：${String(e?.message ?? e).slice(0, 80)}` } }
    }

    finishAttempt(db, {
      attemptId: id,
      state: ok ? 'completed' : 'failed',
      failure: ok ? null : { verdict: v, why: why ?? null },
      ctxPeak: stats.ctxPeak,
      compactions: stats.compactions,
      firstCompactionTokens: stats.firstCompactionTokens
    })
    return { ok: true, attemptId: id, why: null, used: true, stats }
  } catch (e) {
    return { ...base, why: `记账失败（不影响本轮）：${String(e?.message ?? e).slice(0, 160)}` }
  } finally {
    try { db?.close() } catch {}
  }
}
