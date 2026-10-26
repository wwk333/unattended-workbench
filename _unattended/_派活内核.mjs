/**
 * 派活内核 —— **派活与故障恢复的唯一闭环**（施工文档 §六）
 *
 * ```text
 * 编排调度
 *   → preflight()          派活前检查，不通过不启动载体
 *   → startAttempt()       写 attempt(running)，启动载体
 *   → ack()                pid + 首个事件；120 秒无 ack 判 no-start
 *   → collect()            产物、事件、退出码、sessionId、实际 provider/model
 *   → classify()           唯一失败归因
 *   → recover()            唯一恢复动作
 *   → finishAttempt()      completed / failed / aborted
 * ```
 *
 * ## 为什么要有它（真事，§六「解决什么问题」）
 * 派活与恢复原来散在三处：`派活.mjs` 只管出卡和静态 AC，`编排.mjs` 里写着重试/急救/返工/换家分支，
 * `_失败处置.mjs` 只有判决和一句建议。结果是"表里写 input-error 要急救，实际换模型也修不好"、
 * "T1-07 attempt 1 被主动 kill 却无收据，2.7 MB 白烧"、"7 个 run 缺 verdict.json"。
 * 现在判决只有一张表（`_失败处置.mjs`），**动作只在这里执行一次**。
 *
 * ## 本文件的纪律
 * 1. **纯函数在前、I/O 在后**：`preflight/ackState/classify/recover/resumePlan` 都是纯函数
 *    （给定输入就有确定输出），所以能用单测把 §六 那张验收表逐条钉住，不需要真起模型。
 * 2. **一次失败只允许一个恢复动作**（§六：禁止降档+重试+急救+返工叠着烧）。`recover()` 只回一个。
 * 3. **不换模型的硬约束在这里**：`canSwitchModel` 只对能力型为真；额度类只能换同款模型 API。
 * 4. **预算在状态库卡**（`startAttempt` 已有 6 次硬限制），这里再做一次纯函数预检，避免白启动进程。
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import {
  canRescue, canSwitchApi, canSwitchModel, countsBudget,
  forVerdict, nextOf, zhOf, RESCUE_REASON, RESCUE_PER_TASK, CODING_BUDGET
} from './_失败处置.mjs'
import { assertState } from './契约/枚举.mjs'
// ★ 2026-10-26（§七）：收据三字段的唯一算法（compactionStats）
import { compactionStats } from './_收据统计.mjs'

// 预算/急救常量从这里传出去（消费方不必知道它们其实定义在 `_失败处置.mjs`）
export { CODING_BUDGET, RESCUE_REASON, RESCUE_PER_TASK }

/**
 * 各等级的 **run 卡住阈值**（分钟）—— §七「阈值跟级别走，不再固定 100」。
 *
 * 为什么按级别：L1 是改一行字，卡 30 分钟就该管；L4 是重构一个模块，150 分钟的活
 * 用 30 分钟的尺子量，只会**天天误报**（用户实感："看护老说卡住，其实还在干"）。
 *
 * ⚠️ 这里只是**阈值表**，不含"怎么判活着"（那是 `进度看护.mjs` 的事）。
 */
export const LEVEL_STALL_MIN = Object.freeze({ L1: 30, L2: 55, L3: 100, L4: 160 })
/** 不知道级别时的兜底（与历史默认一致，免得改了阈值把老的判断全打乱） */
export const DEFAULT_STALL_MIN = 100

/**
 * 查阈值。**级别不知道就如实说不知道**，不猜一个级别（猜错比固定值更糟）。
 * @param {string|null} level  L1 / L2 / L3 / L4
 * @param {number|null} [override] 命令行 `--stall-min` 显式指定（人说了算）
 * @returns {{ min:number, level:string|null, source:'cli'|'level'|'default', why:string|null }}
 */
export function stallMinOf (level, override = null) {
  if (Number.isFinite(Number(override)) && Number(override) > 0) {
    return { min: Number(override), level: level ?? null, source: 'cli', why: `命令行 --stall-min 指定 ${override} 分钟` }
  }
  const lv = level == null ? null : String(level).trim().toUpperCase()
  if (lv && Object.prototype.hasOwnProperty.call(LEVEL_STALL_MIN, lv)) {
    return { min: LEVEL_STALL_MIN[lv], level: lv, source: 'level', why: null }
  }
  return {
    min: DEFAULT_STALL_MIN,
    level: lv,
    source: 'default',
    why: lv ? `级别 ${lv} 不在阈值表里，用兜底 ${DEFAULT_STALL_MIN} 分钟` : `不知道这轮的级别，用兜底 ${DEFAULT_STALL_MIN} 分钟（` + '不做级别猜测）'
  }
}

export const ATTEMPT_KINDS = Object.freeze(['initial', 'retry', 'capability', 'rescue', 'rework', 'judge', 'resume'])
/** 120 秒没有 pid/首个事件 ⇒ 判 no-start（§六） */
export const ACK_DEADLINE_MS = 120_000
/** 同一失败原因连续出现这么多次 ⇒ 不再原样重试 */
export const SAME_REASON_STOP = 2
/** 代码/AC 红最多返工轮数 */
export const MAX_REWORK = 2
/** 每波最多诊断卡数 */
export const MAX_DIAGNOSE_PER_WAVE = 1

export class DispatchError extends Error {
  constructor (code, msg, detail) {
    super(`[派活内核] ${msg}${detail ? `（${detail}）` : ''}`)
    this.name = 'DispatchError'
    this.code = code
    this.detail = detail ?? null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. preflight —— 派活前一次查完，任何一项不满足都不启动模型
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {object} o.task            卡（id/status/role/rolePool/writes/resources/accept/depends/deliverables）
 * @param {object} [o.run]           本轮 run（budget 相关）
 * @param {string[]} [o.rolePool]    可用角色（池）
 * @param {object} [o.carrier]       { name, maxConcurrent, busy }
 * @param {object} [o.capability]    { known, contextWindow, maxOutputTokens } —— unknown 时重任务不派
 * @param {number} [o.budgetUsed]    本卡本 run 已用编码调用数
 * @param {object[]} [o.openHalts]   未销 halt
 * @param {string[]} [o.conflictWrites] 已知同文件冲突（别的卡正在写同一文件）
 * @param {string[]} [o.doneTaskIds] 已完成任务集合（DAG 依赖判定）
 * @param {boolean} [o.manualAccept] 卡声明了 manualAccept
 * @param {object} [o.staticAc]      { ok, code, why } 派活静态校验结果
 * @param {boolean} [o.frozen]       卡面/prompt/路由快照是否已冻结
 * @param {boolean} [o.keyHealthy]   钥匙/健康是否可用
 * @returns {{ ok:boolean, verdict:string|null, why:string|null, detail:object }}
 */
export function preflight (o = {}) {
  const d = (why, verdict = 'input-error', extra = {}) => ({ ok: false, verdict, why, detail: { ...o, ...extra } })

  const task = o.task
  if (!task || !task.id) return d('没有卡（任务不存在）')
  if (task.status && !['ready', 'pending'].includes(task.status)) {
    return d(`卡状态是 ${task.status}，不是 ready/pending —— 不许派`, 'input-error')
  }

  // 依赖（DAG）
  const deps = task.depends ?? []
  if (deps.length) {
    const done = new Set(o.doneTaskIds ?? [])
    const missing = deps.filter(x => !done.has(x))
    if (missing.length) return d(`依赖未完成：${missing.join(',')}`, 'input-error', { missingDeps: missing })
  }

  // 未销 halt
  const halts = o.openHalts ?? []
  if (halts.length) return d(`有 ${halts.length} 条未销 halt：${halts.slice(0, 3).map(h => h.reason ?? h).join('；')}`, 'halt-open')

  // 预算
  const used = Number(o.budgetUsed ?? 0)
  if (used >= CODING_BUDGET) return d(`本卡本 run 的 ${CODING_BUDGET} 次编码调用已用完`, 'budget-exhausted', { used })

  // 角色（池内选；没池就严格用 role，不自动挪）—— 且必须**真的可用**
  const role = pickRole(task, o.rolePool)
  if (!role) return d(`角色不可用：role=${task.role ?? '-'} rolePool=${(task.rolePool ?? []).join('/') || '-'}`, 'input-error')
  if (Array.isArray(o.rolePool) && o.rolePool.length && !o.rolePool.includes(role)) {
    return d(`角色 ${role} 当前不可用（可用：${o.rolePool.join('/')}）—— 没声明 rolePool 的卡不许自动挪角色`, 'input-error')
  }

  // 载体并发（同一载体 maxConcurrent=1）
  const carrier = o.carrier
  if (carrier) {
    const max = Number(carrier.maxConcurrent ?? 1)
    if ((carrier.busy ?? 0) >= max) return d(`载体 ${carrier.name} 已满载（${carrier.busy}/${max}）`, 'input-error', { carrierBusy: true })
  }

  // 钥匙/健康
  if (o.keyHealthy === false) return d('钥匙/健康不可用（先修额度或换 API，不要启动模型）', 'account')

  // 能力（unknown 不许当 1M；重任务不派）
  const cap = o.capability
  // ★ 2026-10-26：不再看 heavyTask —— 能力未知就一律不派（不知道窗口＝算不出预算）。
  if (cap && cap.known === false) {
    return d('模型能力 unknown，重任务不派（不许把未知当 1M/300K）', 'capability')
  }

  // 同文件已知冲突（软写域：只挡"已知"的，不挡"未知"的）
  const conflict = o.conflictWrites ?? []
  if (conflict.length) return d(`已知同文件冲突：${conflict.slice(0, 3).join(',')}`, 'input-error', { writeConflict: conflict })

  // 静态验收（AC 脚本存在性/可跑性）
  const ac = o.staticAc
  if (ac && ac.ok === false) {
    // 文档：第一张"创建测试脚本"的卡允许 AC_PENDING_CREATE
    if (ac.code === 'AC_PENDING_CREATE' && o.allowPendingAccept !== false) {
      // 放行，但记一笔（完成时必须真实存在且通过，由收活判定兜）
    } else if (!o.manualAccept) {
      return d(`静态 AC 不通过：${ac.why ?? ac.code ?? '未知'}`, 'ac-missing', { acCode: ac.code ?? null })
    }
  }

  // 卡面/prompt/路由快照冻结
  if (o.frozen === false) return d('卡面/prompt/路由快照没冻结 —— 冻结后再派', 'input-error')

  return {
    ok: true,
    verdict: null,
    why: null,
    detail: { role, taskId: task.id, budgetUsed: used, remaining: CODING_BUDGET - used, heavyTask: o.heavyTask === true }
  }
}

/** 角色池：有池就在池内挑空闲的；没池就严格用 `role`（§六「角色池与粘性」） */
export function pickRole (task, availableRoles = null) {
  const pool = Array.isArray(task?.rolePool) ? task.rolePool.filter(Boolean) : []
  if (!pool.length) return task?.role ?? null
  if (task?.assignedRole && pool.includes(task.assignedRole)) return task.assignedRole // 粘性
  if (!availableRoles) return pool[0]
  return pool.find(r => availableRoles.includes(r)) ?? null
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. ack —— 120 秒没有 pid/首个事件 ⇒ no-start
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @param {object} o
 * @param {string} o.startedAt       attempt 开工时间（ISO）
 * @param {string|null} [o.firstEventAt] 首个事件时间
 * @param {number|null} [o.pid]     载体 pid
 * @param {number} [o.now]
 * @param {number} [o.deadlineMs]
 * @returns {{ acked:boolean, noStart:boolean, waitedMs:number, why:string|null }}
 */
export function ackState ({ startedAt, firstEventAt = null, pid = null, now = Date.now(), deadlineMs = ACK_DEADLINE_MS } = {}) {
  const t0 = Date.parse(startedAt)
  if (!Number.isFinite(t0)) return { acked: false, noStart: true, waitedMs: 0, why: 'attempt 没有可解析的 startedAt' }
  const waitedMs = now - t0
  const hasEvent = Boolean(firstEventAt)
  if (hasEvent) return { acked: true, noStart: false, waitedMs, why: null }
  if (pid && waitedMs < deadlineMs) return { acked: false, noStart: false, waitedMs, why: null } // 进程起来了，还在等首个事件
  if (waitedMs >= deadlineMs) return { acked: false, noStart: true, waitedMs, why: `${Math.round(deadlineMs / 1000)} 秒内没有首个事件（pid=${pid ?? 'null'}）` }
  return { acked: false, noStart: false, waitedMs, why: null }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. collect —— 收活：产物、退出码、会话、真实 provider/model
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 归一化一次调用的收据。**不猜**：拿不到就是 null。
 * @returns {{ exitCode:number|null, timedOut:boolean, killed:boolean, sessionId:string|null,
 *             actual:object|null, artifacts:string[], artifactsComplete:boolean|null,
 *             lastEvent:string|null, acGreen:boolean|null, text:string }}
 */
export function collect ({ exitCode = null, timedOut = false, killed = false, sessionId = null, actual = null, artifacts = [], artifactsComplete = null, lastEvent = null, acGreen = null, text = '' } = {}) {
  return {
    exitCode: typeof exitCode === 'number' ? exitCode : null,
    timedOut: timedOut === true,
    killed: killed === true,
    sessionId: sessionId ?? null,
    actual: actual ?? null,
    artifacts: Array.isArray(artifacts) ? artifacts : [],
    artifactsComplete: artifactsComplete === null ? null : artifactsComplete === true,
    lastEvent: lastEvent ?? null,
    acGreen: acGreen === null ? null : acGreen === true,
    text: String(text ?? '')
  }
}

/** `requested` 与 `actual` 不一致 ⇒ route-mismatch（不静默） */
export function routeMismatch (requested, actual) {
  if (!requested || !actual) return null
  const diff = []
  if (requested.provider && actual.provider && requested.provider !== actual.provider) diff.push('provider')
  if (requested.model && actual.model && requested.model !== actual.model) diff.push('model')
  return diff.length ? { kind: 'route-mismatch', fields: diff, requested, actual } : null
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. classify —— **唯一失败归因**
// ─────────────────────────────────────────────────────────────────────────────

/** 症状 → 判决（顺序即优先级；**先判"被掐"和"超时"，它们会掩盖其它症状**） */
export const CLASSIFY_RULES = Object.freeze([
  { verdict: 'kill-intent', re: null, why: '大脑主动掐（有 kill-intent.json）' },
  { verdict: 'budget-exhausted', re: null, why: '预算耗尽' },
  { verdict: 'timeout', re: null, why: '跑满超时被收尾掐断' },
  { verdict: 'no-start', re: null, why: '启动失败 / 无 ack' },
  { verdict: 'account', re: /(rate.?limit|quota|insufficient|余额|额度|401|403.*key|429|invalid.?api.?key|unauthori[sz]ed)/i, why: '额度/限流/坏 key' },
  { verdict: 'denied', re: /(permission denied|EACCES|权限不足|拒绝访问|access is denied)/i, why: '权限被拒' },
  { verdict: 'filtered', re: /(content.?filter|filtered|内容被拦|safety|refus)/i, why: '内容被拦' },
  { verdict: 'ac-env-credential', re: /(missing.?api.?key|no.?api.?key|需要.*(key|密钥|token)|请登录|sign.?in|payment|付款|欠费)/i, why: '环境缺凭据' },
  { verdict: 'ac-env-workspace', re: /(command not found|不是内部或外部命令|No module named|Cannot find module|ENOENT|is not recognized)/i, why: '环境缺工具/包' },
  { verdict: 'capability', re: /(context.?window|context length|max.?tokens|too many tokens|thinking.?overflow|compact(ion|ed).*(storm|loop)|超出.*(上下文|窗口)|输出(不足|截断))/i, why: '能力不足（窗口/输出/压缩）' },
  { verdict: 'ac-red', re: null, why: '验收机判红' },
  { verdict: 'input-error', re: /(input.?error|invalid.?task|卡格式|派活|静态.*AC|validateAccept)/i, why: '卡/派活本身错' }
])

/**
 * 唯一失败归因。**输入不足时如实说"认不出"，不猜。**
 * @param {object} o
 * @param {object} [o.collected]   `collect()` 的结果
 * @param {boolean} [o.hadKillIntent]
 * @param {boolean} [o.budgetExhausted]
 * @param {string|null} [o.acVerdict]  AC 机的结论（`ac-red` 等）
 * @returns {{ verdict:string, why:string, evidence:string }}
 */
export function classify ({ collected = null, hadKillIntent = false, budgetExhausted = false, acVerdict = null } = {}) {
  const c = collected ?? {}
  if (hadKillIntent) return { verdict: 'kill-intent', why: CLASSIFY_RULES[0].why, evidence: 'kill-intent.json' }
  if (budgetExhausted) return { verdict: 'budget-exhausted', why: CLASSIFY_RULES[1].why, evidence: `budget>=${CODING_BUDGET}` }
  if (c.timedOut) return { verdict: 'timeout', why: CLASSIFY_RULES[2].why, evidence: 'timedOut=true' }
  if (c.noStart || c.noStart === true) return { verdict: 'no-start', why: CLASSIFY_RULES[3].why, evidence: 'no-ack' }
  if (acVerdict) return { verdict: String(acVerdict), why: forVerdict(acVerdict)?.zh ?? 'AC 机结论', evidence: 'ac' }
  if (c.exitCode === 0 && c.acGreen !== false) return { verdict: 'ok', why: '退出码 0 且无失败信号', evidence: 'exit=0' }
  for (const r of CLASSIFY_RULES) {
    if (!r.re) continue
    if (r.re.test(c.text ?? '')) return { verdict: r.verdict, why: r.why, evidence: String(c.text ?? '').slice(0, 160) }
  }
  return { verdict: 'ac-unknown', why: '认不出的失败（不许直接报人，先上证据包/诊断卡）', evidence: String(c.text ?? '').slice(0, 160) }
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. recover —— **唯一恢复动作**（一次只允许一个）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 决定下一步动作。返回**恰好一个** action。
 *
 * @param {object} o
 * @param {string} o.verdict          classify 的结论
 * @param {object} [o.collected]      收活数据（判断有没有 session / 产物全不全）
 * @param {object[]} [o.attempts]     本卡本 run 的 attempt 列表（判"同原因连续 2 次"、急救次数）
 * @param {number} [o.budgetUsed]
 * @param {number} [o.reworkCount]
 * @param {number} [o.apiAlternatives] 同款模型还有几个可用 API
 * @param {number} [o.diagnoseCount]   本波已用诊断卡数
 * @returns {{ action:string, attemptKind:string|null, reason:string|null, verdict:string,
 *             blocked:boolean, why:string, countsBudget:boolean, switchModel:boolean, switchApi:boolean }}
 */
export function recover (o = {}) {
  const verdict = String(o.verdict ?? 'ac-unknown')
  const c = o.collected ?? {}
  const attempts = Array.isArray(o.attempts) ? o.attempts : []
  const budgetUsed = Number(o.budgetUsed ?? 0)
  const budgetLeft = CODING_BUDGET - budgetUsed
  const out = (action, extra = {}) => ({
    action,
    attemptKind: extra.attemptKind ?? null,
    reason: extra.reason ?? null,
    verdict,
    blocked: action === 'blocked',
    why: extra.why ?? (forVerdict(verdict)?.suggest ?? zhOf(verdict)),
    countsBudget: extra.countsBudget ?? false,
    switchModel: false,
    switchApi: false,
    ...extra
  })

  // 成功 / 无需动作
  if (verdict === 'ok') return out('accept', { why: '调用成功，进收活' })
  if (verdict === 'kill-intent') return out('none', { why: '大脑主动掐：保留产物/会话，标记 aborted-by-brain，下次 resume' })

  // 预算
  if (verdict === 'budget-exhausted' || budgetLeft <= 0) {
    return out('blocked', { why: `本卡本 run 的 ${CODING_BUDGET} 次编码调用已用完（已试 ${budgetUsed} 次）` })
  }

  // 同一失败原因连续 2 次 ⇒ 不再原样重试（§六）
  const sameStreak = countSameStreak(attempts, verdict)
  if (sameStreak >= SAME_REASON_STOP && !['ac-red', 'capability'].includes(verdict)) {
    return out('blocked', { why: `同一失败原因（${verdict}）已连续 ${sameStreak} 次 —— 停止原样重试，转改卡/拆卡` })
  }

  const hasSession = Boolean(c.sessionId)
  const artifactsComplete = c.artifactsComplete

  switch (verdict) {
    // 超时：先验产物；AC 绿直接 review；有 session 才 resume；否则拆卡
    case 'timeout':
      if (c.acGreen === true) return out('accept', { why: '超时但 AC 已绿 ⇒ 直接进 review，不重跑' })
      if (artifactsComplete === true && hasSession) return out('resume', { attemptKind: 'resume', countsBudget: true, why: '超时但产物完整且有 session ⇒ 续跑 1 次（不冷重派）' })
      if (hasSession) return out('resume', { attemptKind: 'resume', countsBudget: true, why: '超时但有 session ⇒ 续跑 1 次' })
      return out('blocked', { why: '超时且无产物/无 session ⇒ 拆卡或 blocked' })

    // 启动失败 / 无 ack：杀进程树，同载体重试 1 次
    case 'no-start': {
      const retried = attempts.some(a => a.attemptKind === 'retry' && a.failure?.verdict === 'no-start')
      if (!retried) return out('retry', { attemptKind: 'retry', countsBudget: true, why: '杀进程树，同载体重试 1 次' })
      return out('blocked', { why: '同载体重试过仍 no-start ⇒ blocked' })
    }

    // 传输类：能续就续，重试 1 次
    case 'flaky': {
      const retried = attempts.some(a => a.attemptKind === 'retry' && a.failure?.verdict === 'flaky')
      if (!retried) return out('retry', { attemptKind: 'retry', countsBudget: true, why: hasSession ? '传输断：续会话重试 1 次' : '传输断：同载体重试 1 次' })
      return out('blocked', { why: '同通道重试过仍失败 ⇒ 换通道/交人（不换模型）' })
    }
    case 'flaky-twice':
      return out('blocked', { why: '同通道已重试 1 次仍失败 —— 传输问题换模型没用' })

    // 额度/限流/坏 key：**只换同款模型的下一个 API**
    case 'account': {
      const alts = Number(o.apiAlternatives ?? 0)
      if (alts > 0) return out('retry', { attemptKind: 'retry', switchApi: true, countsBudget: true, why: `额度失败：只换同款模型的下一个 API（剩 ${alts} 个），不换模型` })
      return out('blocked', { why: '同款模型没有可用 API 了 ⇒ 停这个角色（其他角色继续），不换模型' })
    }

    // 能力不足：能力路由 1 次；再不行拆卡
    case 'capability':
    case 'thinking-overflow-final': {
      const rescueUsed = attempts.filter(a => a.attemptKind === 'rescue' || a.reason === RESCUE_REASON || a.failure?.reason === RESCUE_REASON).length
      if (rescueUsed >= RESCUE_PER_TASK) return out('blocked', { why: `急救已用过 ${rescueUsed} 次（每卡最多 ${RESCUE_PER_TASK} 次）⇒ capability-exhausted，拆卡` })
      if (!canRescue(verdict)) return out('blocked', { why: `${verdict} 不允许急救` })
      if (canSwitchModel(verdict) === false) return out('blocked', { why: `${verdict} 不允许换模型` })
      return out('rescue', {
        attemptKind: 'rescue',
        reason: RESCUE_REASON,
        countsBudget: true,
        switchModel: true,
        why: `能力不足 ⇒ 急救 1 次（reason=${RESCUE_REASON}，计入 ${CODING_BUDGET} 次预算）`
      })
    }

    // 代码/AC 红：返工同一角色，不换模型
    case 'ac-red': {
      const rounds = Number(o.reworkCount ?? 0)
      if (rounds < MAX_REWORK) return out('rework', { attemptKind: 'rework', countsBudget: true, why: `AC 红 ⇒ 返工第 ${rounds + 1}/${MAX_REWORK} 轮（同一角色，不换模型）` })
      return out('blocked', { why: `返工 ${MAX_REWORK} 轮仍未绿 ⇒ blocked` })
    }

    // 环境缺工具：自动派 ENV 卡
    case 'ac-env-workspace':
      return out('env-card', { countsBudget: false, why: '环境缺工具/包 ⇒ 自动派 ENV 卡，ENV 绿后重派原卡' })
    // 环境缺凭据：**唯一**允许问用户的一类
    case 'ac-env-credential':
    case 'ac-env':
      return out('wait-user', { why: '缺 key/要付款/要注册 —— 这是唯一允许问用户的一类' })

    // 权限被拒：改卡/白名单，不重试
    case 'denied':
      return out('edit-card', { why: '权限被拒 ⇒ 改卡/白名单，不重试（重试也还是拒）' })

    // 内容被拦：新会话重试 1 次（不续会话），仍拦 ⇒ blocked
    case 'filtered': {
      const retried = attempts.some(a => a.attemptKind === 'retry' && a.failure?.verdict === 'filtered')
      if (!retried) return out('retry', { attemptKind: 'retry', countsBudget: true, freshSession: true, why: '内容被拦 ⇒ **新会话**重试 1 次（不续会话，别把被拦内容再发一遍）' })
      return out('blocked', { why: '新会话重试仍被拦 ⇒ blocked' })
    }

    // 卡/派活本身错：改卡重派，不急救、不换模型、不产生模型调用
    case 'input-error':
      return out('edit-card', { why: '卡/派活本身错 ⇒ 改卡重派（不急救、不换模型）' })
    case 'ac-missing':
      return out('edit-card', { why: '卡没有可执行验收 ⇒ 补一条能跑的 AC（不许进 done）' })

    // 未知：证据包 + 每波最多 1 张诊断卡；不直接问用户
    case 'ac-unknown': {
      const used = Number(o.diagnoseCount ?? 0)
      if (used < MAX_DIAGNOSE_PER_WAVE) return out('diagnose', { attemptKind: 'judge', countsBudget: false, why: '认不出的失败 ⇒ 先上证据包 + 1 张诊断卡（judge 只诊断，不算独立审核）' })
      return out('blocked', { why: '诊断卡本波已用完 ⇒ 证据包 + blocked（不直接报人）' })
    }

    default:
      return out('blocked', { why: `没有恢复策略的判决：${verdict}` })
  }
}

/** 同判决连续出现几次（从最近往回数） */
export function countSameStreak (attempts = [], verdict) {
  let n = 0
  for (let i = attempts.length - 1; i >= 0; i--) {
    const v = attempts[i]?.failure?.verdict ?? attempts[i]?.verdict ?? null
    if (v === verdict) n++
    else break
  }
  return n
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. kill-intent —— 掐进程协议（§六）
// ─────────────────────────────────────────────────────────────────────────────

export const KILL_INTENT_FILE = 'kill-intent.json'

/** 大脑主动杀之前先写这个；杀完 attempt 标 aborted-by-brain，不判 flaky */
export function writeKillIntent (project, { runId = null, taskId = null, reason = '未写原因', snapshotId = null, lastEvent = null, artifacts = [] } = {}) {
  const path = join(project, '_crew', KILL_INTENT_FILE)
  mkdirSync(join(project, '_crew'), { recursive: true })
  const body = {
    schema: 1,
    kind: 'kill-intent',
    intent: 'brain-kill',
    at: new Date().toISOString(),
    source: '_派活内核.mjs',
    state: 'active',
    stale: false,
    runId, taskId, snapshotId, reason,
    lastEvent,
    artifacts
  }
  writeFileSync(path, JSON.stringify(body, null, 2), 'utf8')
  return body
}

export function readKillIntent (project) {
  const path = join(project, '_crew', KILL_INTENT_FILE)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) } catch { return { broken: true } }
}

export function clearKillIntent (project) {
  const path = join(project, '_crew', KILL_INTENT_FILE)
  try { rmSync(path, { force: true }); return true } catch { return false }
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. resume 计划
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 下次派活优先 resume（带上次原因与产物清单）；没有 session 才冷重派。
 * @returns {{ mode:'resume'|'cold-start'|'blocked', why:string, attemptKind:string, carry:object }}
 */
export function resumePlan ({ killIntent = null, attempts = [], lastCollected = null } = {}) {
  const last = attempts.length ? attempts[attempts.length - 1] : null
  const sessionId = last?.sessionId ?? lastCollected?.sessionId ?? null
  const artifacts = lastCollected?.artifacts ?? killIntent?.artifacts ?? []
  const carry = { reason: killIntent?.reason ?? last?.failure?.verdict ?? last?.reason ?? null, artifacts, lastEvent: killIntent?.lastEvent ?? lastCollected?.lastEvent ?? null }

  if (last?.state === 'completed') return { mode: 'blocked', why: '上一次已 completed，不需要 resume', attemptKind: 'none', carry }
  if (killIntent && sessionId) return { mode: 'resume', why: '有 kill-intent 且有 session ⇒ 带上原因/产物 resume', attemptKind: 'resume', carry }
  if (sessionId) return { mode: 'resume', why: '有 session ⇒ 优先续跑（比重派便宜）', attemptKind: 'resume', carry }
  return { mode: 'cold-start', why: '没有 session ⇒ 只能冷重派（带上次原因与产物清单）', attemptKind: 'initial', carry }
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. I/O：把 attempt 写进 C 状态库（唯一写方是状态服务，这里只调它）
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 开一个 attempt。**状态服务不可用 ⇒ 抛，调用方必须停手**（fail-closed，不退回文件双写）。
 * 6 次预算由状态库硬卡（`startAttempt` 会 409），这里不重复实现。
 */
export async function startAttemptOn (client, { attemptId, runId, project, taskId, attemptKind = 'initial', role = null, carrier = null, requested = null, selected = null, pid = null, timeoutMin = null, promptHash = null, cardHash = null, writes = [], resources = [], envKeysInjected = [], idempotencyKey = null }) {
  if (!ATTEMPT_KINDS.includes(attemptKind)) throw new DispatchError('E_KIND', `attemptKind 非法：${attemptKind}（只允许 ${ATTEMPT_KINDS.join('/')}）`)
  const rec = await client.startAttempt({
    attemptId, runId, project, taskId, attemptKind, role, carrier,
    requested, selected, pid, timeoutMin, promptHash, cardHash, writes, resources, envKeysInjected
  }, { idempotencyKey: idempotencyKey ?? `attempt-${attemptId}` })
  assertState('attempt', rec.state) // 只允许 running/completed/failed/aborted；blocked 在这里就是错
  return rec
}

/**
 * 收口 attempt。state 只允许 completed/failed/aborted（blocked 会被枚举层拒）
 *
 * ★ 2026-10-26（§七）：收据里的 `ctxPeak / compactions / firstCompactionTokens` 从这里进库。
 *   两种给法（**都不给就留空**，绝不估算）：
 *     · 直接给值：`{ ctxPeak, compactions, firstCompactionTokens }`
 *     · 给事件流：`{ events }` —— 算法只在 `_收据统计.mjs` 一处，这里不重算
 */
export async function finishAttemptOn (client, { attemptId, state, failure = null, actual = null, sessionId = null, reason = null, idempotencyKey = null, events = null, ctxPeak = null, compactions = null, firstCompactionTokens = null }) {
  assertState('attempt', state)
  const stats = Array.isArray(events) ? compactionStats(events) : { ctxPeak, compactions, firstCompactionTokens }
  return client.finishAttempt({
    attemptId,
    state,
    failure,
    actual,
    sessionId,
    reason,
    // 只有真拿到数才传；null 原样传下去（库里 COALESCE 会保留旧值，不会写成 0）
    ctxPeak: stats.ctxPeak ?? null,
    compactions: stats.compactions ?? null,
    firstCompactionTokens: stats.firstCompactionTokens ?? null,
    idempotencyKey: idempotencyKey ?? `attempt-finish-${attemptId}`
  })
}

/** 给 attempt 收据补上"这次为什么这么收口"（classify + recover 的结论） */
export function receiptOf ({ verdict, action, why, reason = null, budget = null }) {
  return {
    verdict,
    action: action ?? null,
    why: why ?? null,
    reason,
    // ⚠️ 参数名叫 budget 不叫 countsBudget：后者是本模块导入的函数，同名会被参数遮蔽（踩过）
    countsBudget: budget === null ? countsBudget({ verdict }) : budget === true
  }
}
