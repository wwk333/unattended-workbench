/**
 * 阶段 3 · 派活内核（§六）
 *
 * 逐条钉住文档「验收与待测试数据」表：
 *   · input-error 不调模型、不 rescue、不换模型；
 *   · quota 只换同款模型 API；
 *   · rescue 只能力型，每卡最多 1 次，reason=capability-escalation；
 *   · 6 次预算上限；judge/审核不计入；
 *   · kill-intent / resume；
 *   · attempt 只有 running/completed/failed/aborted（blocked 是 schema 违规）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  preflight, pickRole, ackState, collect, classify, recover, countSameStreak,
  resumePlan, routeMismatch, receiptOf, writeKillIntent, readKillIntent, clearKillIntent,
  ATTEMPT_KINDS, ACK_DEADLINE_MS, CODING_BUDGET, MAX_REWORK, RESCUE_REASON
} from '../_unattended/_派活内核.mjs'
import {
  rescueAble, canRescue, canSwitchApi, canSwitchModel, countsBudget,
  failoverAllowed, NEVER_RESCUE, CODING_BUDGET as BUDGET2
} from '../_unattended/_失败处置.mjs'
import { fixture, cleanup, dump } from './_助手.mjs'

// ---------------------------------------------------------------- preflight

const TASK = { id: 'T1', status: 'ready', role: 'coder-a', rolePool: [], writes: ['src/a.js'], resources: [], accept: ['`node t.mjs` → ok'], depends: [], deliverables: ['src/a.js'] }

function pf (over = {}) {
  return preflight({ task: TASK, rolePool: ['coder-a'], carrier: { name: 'pi', maxConcurrent: 1, busy: 0 }, keyHealthy: true, frozen: true, staticAc: { ok: true }, ...over })
}

test('preflight 全绿才允许启动载体', () => {
  const r = pf()
  assert.equal(r.ok, true)
  assert.equal(r.detail.role, 'coder-a')
  assert.equal(r.detail.remaining, CODING_BUDGET)
  dump('preflight-ok', r.detail)
})

test('负向：依赖没完成 / 有未销 halt / 预算用完 / 角色不可用 都不许派', () => {
  assert.equal(pf({ doneTaskIds: [], task: { ...TASK, depends: ['T0'] } }).verdict, 'input-error')
  assert.equal(pf({ openHalts: [{ reason: 'ac-red' }] }).verdict, 'halt-open')
  assert.equal(pf({ budgetUsed: CODING_BUDGET }).verdict, 'budget-exhausted')
  assert.equal(pf({ rolePool: ['coder-b'], task: { ...TASK, role: 'coder-a' } }).verdict, 'input-error')
})

test('负向：载体满载（同载体 maxConcurrent=1）不许派', () => {
  const r = pf({ carrier: { name: 'pi', maxConcurrent: 1, busy: 1 } })
  assert.equal(r.ok, false)
  assert.match(r.why, /满载/)
})

test('负向：能力 unknown 且重任务 ⇒ 不派（不许把未知当 1M）', () => {
  const r = pf({ capability: { known: false }, heavyTask: true })
  assert.equal(r.ok, false)
  assert.equal(r.verdict, 'capability')
})

test('负向：已知同文件冲突不派；未知写域照派（软写域）', () => {
  assert.equal(pf({ conflictWrites: ['src/a.js'] }).ok, false)
  assert.equal(pf({ task: { ...TASK, writes: null } }).ok, true)
})

test('负向：静态 AC 不过 ⇒ ac-missing（不启动模型）；AC_PENDING_CREATE 放行', () => {
  assert.equal(pf({ staticAc: { ok: false, code: 'E_NO_SCRIPT', why: '脚本不存在' } }).verdict, 'ac-missing')
  assert.equal(pf({ staticAc: { ok: false, code: 'AC_PENDING_CREATE' } }).ok, true)
  assert.equal(pf({ staticAc: { ok: false, code: 'E_NO_SCRIPT' }, manualAccept: true }).ok, true)
})

test('负向：卡面没冻结 ⇒ 不派', () => {
  assert.equal(pf({ frozen: false }).ok, false)
})

test('角色池：池内挑空闲、assignedRole 粘住、没池就严格用 role', () => {
  assert.equal(pickRole({ role: 'coder-a' }), 'coder-a')
  assert.equal(pickRole({ role: 'coder-a', rolePool: ['coder-a', 'coder-b'] }, ['coder-b']), 'coder-b')
  assert.equal(pickRole({ role: 'coder-a', rolePool: ['coder-a', 'coder-b'], assignedRole: 'coder-a' }, ['coder-b']), 'coder-a')
  assert.equal(pickRole({ role: 'coder-a', rolePool: ['coder-a'] }, ['coder-b']), null)
})

// ---------------------------------------------------------------- ack

test('ack：120 秒内没首个事件且没 pid ⇒ no-start；有事件 ⇒ acked', () => {
  const t0 = new Date(Date.now() - 10_000).toISOString()
  assert.equal(ackState({ startedAt: t0, now: Date.now() }).noStart, false)
  const old = new Date(Date.now() - ACK_DEADLINE_MS - 5000).toISOString()
  assert.equal(ackState({ startedAt: old, now: Date.now() }).noStart, true)
  assert.equal(ackState({ startedAt: old, firstEventAt: old, now: Date.now() }).acked, true)
  // 进程起来了但还没事件、且**没到** 120 秒 ⇒ 继续等（不误判）
  assert.equal(ackState({ startedAt: t0, pid: 1234, now: Date.now() }).noStart, false)
  // 过了 120 秒还没有首个事件 ⇒ 即使有 pid 也判 no-start（§六：120 秒无 ack 判 no-start）
  assert.equal(ackState({ startedAt: old, pid: 1234, now: Date.now() }).noStart, true)
  dump('ack', { deadlineSec: ACK_DEADLINE_MS / 1000 })
})

// ---------------------------------------------------------------- classify

test('classify：优先级正确（被掐 > 预算 > 超时 > no-start > AC > 症状）', () => {
  assert.equal(classify({ hadKillIntent: true, collected: { timedOut: true } }).verdict, 'kill-intent')
  assert.equal(classify({ budgetExhausted: true, collected: { timedOut: true } }).verdict, 'budget-exhausted')
  assert.equal(classify({ collected: { timedOut: true } }).verdict, 'timeout')
  assert.equal(classify({ collected: { noStart: true } }).verdict, 'no-start')
  assert.equal(classify({ acVerdict: 'ac-red', collected: { exitCode: 0 } }).verdict, 'ac-red')
  assert.equal(classify({ collected: { exitCode: 0 } }).verdict, 'ok')
})

test('classify：症状表能认出额度/权限/被拦/能力/环境/凭据', () => {
  const cases = {
    account: 'Error 429 rate limit exceeded',
    denied: 'EACCES: permission denied, open file',
    filtered: 'content filter triggered',
    capability: 'maximum context length exceeded',
    'ac-env-workspace': "Cannot find module 'pytest'",
    'ac-env-credential': 'missing API key, please sign in'
  }
  for (const [want, text] of Object.entries(cases)) {
    const r = classify({ collected: { exitCode: 1, text } })
    assert.equal(r.verdict, want, `${want} ← ${text}（实际 ${r.verdict}）`)
  }
})

test('classify：认不出 ⇒ ac-unknown（不猜成别的）', () => {
  const r = classify({ collected: { exitCode: 1, text: 'flurble wibble 42' } })
  assert.equal(r.verdict, 'ac-unknown')
  dump('classify-unknown', r)
})

// ---------------------------------------------------------------- recover：核心约束

test('**input-error 不调模型、不急救、不换模型**（§六删/并/退）', () => {
  const r = recover({ verdict: 'input-error' })
  assert.equal(r.action, 'edit-card')
  assert.equal(r.attemptKind, null, 'input-error 不该产生任何 attempt')
  assert.equal(r.countsBudget, false)
  assert.equal(r.switchModel, false)
  assert.equal(r.switchApi, false)
  assert.equal(canRescue('input-error'), false)
  assert.equal(canSwitchModel('input-error'), false)
})

test('**额度失败只换同款模型 API**：有替代 API ⇒ retry+switchApi；没有 ⇒ 停该角色、不换模型', () => {
  const withAlt = recover({ verdict: 'account', apiAlternatives: 2 })
  assert.equal(withAlt.action, 'retry')
  assert.equal(withAlt.switchApi, true)
  assert.equal(withAlt.switchModel, false)
  assert.match(withAlt.why, /不换模型/)

  const none = recover({ verdict: 'account', apiAlternatives: 0 })
  assert.equal(none.action, 'blocked')
  assert.equal(none.switchApi, false)
  assert.equal(none.switchModel, false)
  assert.match(none.why, /停这个角色/)
  assert.equal(canSwitchModel('account'), false)
  assert.equal(canSwitchApi('account'), true)
})

test('**rescue 只能力型**：capability 允许 1 次、reason 固定、计入预算；用完即 blocked', () => {
  const r = recover({ verdict: 'capability', budgetUsed: 2 })
  assert.equal(r.action, 'rescue')
  assert.equal(r.attemptKind, 'rescue')
  assert.equal(r.reason, RESCUE_REASON)
  assert.equal(r.reason, 'capability-escalation')
  assert.equal(r.countsBudget, true)
  assert.equal(r.switchModel, true)

  const used = recover({ verdict: 'capability', budgetUsed: 3, attempts: [{ attemptKind: 'rescue', reason: RESCUE_REASON }] })
  assert.equal(used.action, 'blocked')
  assert.match(used.why, /急救已用过/)
})

test('负向：input-error/quota/env/权限/timeout/filtered/代码红 **一律不急救**', () => {
  for (const v of ['input-error', 'account', 'ac-env-workspace', 'ac-env-credential', 'denied', 'timeout', 'filtered', 'ac-red']) {
    const r = recover({ verdict: v, collected: { sessionId: 's' }, apiAlternatives: 3 })
    assert.notEqual(r.action, 'rescue', `${v} 不许急救（实际 ${r.action}）`)
    assert.equal(canRescue(v), false, `${v} canRescue 应为 false`)
    assert.ok(NEVER_RESCUE.includes(v), `${v} 应登记在 NEVER_RESCUE`)
  }
  assert.deepEqual([...rescueAble()].sort(), ['capability', 'thinking-overflow-final'])
})

test('6 次预算：用满即 blocked，且 rescue 也算在预算里', () => {
  const r = recover({ verdict: 'ac-red', budgetUsed: CODING_BUDGET })
  assert.equal(r.action, 'blocked')
  assert.match(r.why, /6 次/)
  assert.equal(BUDGET2, CODING_BUDGET)
})

test('judge/审核调用不计入预算；kill-intent 也不吃预算', () => {
  assert.equal(countsBudget({ attemptKind: 'judge' }), false)
  assert.equal(countsBudget({ verdict: 'kill-intent' }), false)
  assert.equal(countsBudget({ verdict: 'ac-red', attemptKind: 'rework' }), true)
  // recover 里 ac-unknown 的诊断卡是 judge ⇒ countsBudget=false
  assert.equal(recover({ verdict: 'ac-unknown' }).countsBudget, false)
})

test('超时三档：AC 绿直接 review / 有 session 续跑 / 都没有则拆卡', () => {
  assert.equal(recover({ verdict: 'timeout', collected: { acGreen: true } }).action, 'accept')
  assert.equal(recover({ verdict: 'timeout', collected: { sessionId: 's' } }).attemptKind, 'resume')
  assert.equal(recover({ verdict: 'timeout', collected: {} }).action, 'blocked')
})

test('代码/AC 红：返工同一角色最多 2 轮，不换模型', () => {
  const a = recover({ verdict: 'ac-red', reworkCount: 0 })
  assert.equal(a.attemptKind, 'rework')
  assert.equal(a.switchModel, false)
  const b = recover({ verdict: 'ac-red', reworkCount: MAX_REWORK })
  assert.equal(b.action, 'blocked')
})

test('filtered：新会话重试 1 次（不续会话），仍拦 ⇒ blocked', () => {
  const a = recover({ verdict: 'filtered', collected: { sessionId: 's' } })
  assert.equal(a.attemptKind, 'retry')
  assert.equal(a.freshSession, true)
  const b = recover({ verdict: 'filtered', attempts: [{ attemptKind: 'retry', failure: { verdict: 'filtered' } }] })
  assert.equal(b.action, 'blocked')
})

test('环境类：缺工具派 ENV 卡；缺凭据才问用户', () => {
  assert.equal(recover({ verdict: 'ac-env-workspace' }).action, 'env-card')
  assert.equal(recover({ verdict: 'ac-env-credential' }).action, 'wait-user')
})

test('no-start：同载体重试 1 次；重试过仍 no-start ⇒ blocked', () => {
  assert.equal(recover({ verdict: 'no-start' }).attemptKind, 'retry')
  const again = recover({ verdict: 'no-start', attempts: [{ attemptKind: 'retry', failure: { verdict: 'no-start' } }] })
  assert.equal(again.action, 'blocked')
})

test('同一失败原因连续 2 次 ⇒ 不再原样重试（转改卡/拆卡）', () => {
  const r = recover({
    verdict: 'timeout',
    collected: { sessionId: 's' },
    attempts: [{ failure: { verdict: 'timeout' } }, { failure: { verdict: 'timeout' } }]
  })
  assert.equal(r.action, 'blocked')
  assert.match(r.why, /连续 2 次/)
  assert.equal(countSameStreak([{ failure: { verdict: 'timeout' } }, { failure: { verdict: 'timeout' } }], 'timeout'), 2)
})

// ---------------------------------------------------------------- attempt 状态合法性

test('attemptKind 只允许那 7 种；blocked 不是 attempt 状态', () => {
  assert.deepEqual([...ATTEMPT_KINDS], ['initial', 'retry', 'capability', 'rescue', 'rework', 'judge', 'resume'])
  for (const bad of ['blocked', 'running', 'done', 'completed']) {
    assert.equal(ATTEMPT_KINDS.includes(bad), false, `${bad} 不该是 attemptKind`)
  }
})

test('receiptOf：把 classify + recover 的结论收成一份可落库的收据', () => {
  const rec = receiptOf({ verdict: 'ac-red', action: 'rework', why: 'AC 红 ⇒ 返工' })
  assert.equal(rec.verdict, 'ac-red')
  assert.equal(rec.action, 'rework')
  assert.equal(rec.countsBudget, true)
  assert.equal(receiptOf({ verdict: 'kill-intent' }).countsBudget, false)
})

test('routeMismatch：requested vs actual 不一致必须报出来（不静默）', () => {
  assert.equal(routeMismatch({ provider: 'ark', model: 'm' }, { provider: 'ark', model: 'm' }), null)
  const m = routeMismatch({ provider: 'ark', model: 'm' }, { provider: 'ocgo', model: 'm' })
  assert.equal(m.kind, 'route-mismatch')
  assert.deepEqual(m.fields, ['provider'])
  assert.equal(routeMismatch(null, null), null)
})

// ---------------------------------------------------------------- kill-intent / resume

test('kill-intent：写/读/清；有 intent + 有 session ⇒ resume', () => {
  const dir = fixture({})
  try {
    assert.equal(readKillIntent(dir), null)
    const body = writeKillIntent(dir, { runId: 'R1', taskId: 'T1', reason: '改脚本', artifacts: ['a.js'] })
    assert.equal(body.kind, 'kill-intent')
    assert.equal(body.intent, 'brain-kill')
    const back = readKillIntent(dir)
    assert.equal(back.reason, '改脚本')
    assert.deepEqual(back.artifacts, ['a.js'])

    const plan = resumePlan({ killIntent: back, attempts: [{ sessionId: 's1', state: 'aborted' }] })
    assert.equal(plan.mode, 'resume')
    assert.equal(plan.attemptKind, 'resume')
    assert.equal(plan.carry.reason, '改脚本')

    assert.equal(clearKillIntent(dir), true)
    assert.equal(readKillIntent(dir), null)
    dump('kill-intent', back)
  } finally { cleanup(dir) }
})

test('resume：没 session 只能冷重派；已 completed 则不需要 resume', () => {
  const cold = resumePlan({ killIntent: null, attempts: [{ state: 'aborted', sessionId: null }] })
  assert.equal(cold.mode, 'cold-start')
  assert.equal(cold.attemptKind, 'initial')
  const done = resumePlan({ attempts: [{ state: 'completed', sessionId: 's' }] })
  assert.equal(done.mode, 'blocked')
})

test('collect 不猜：拿不到就是 null', () => {
  const c = collect({})
  assert.equal(c.exitCode, null)
  assert.equal(c.sessionId, null)
  assert.equal(c.acGreen, null)
  assert.equal(c.artifactsComplete, null)
  assert.deepEqual(c.artifacts, [])
  assert.equal(collect({ exitCode: 0, artifactsComplete: true }).artifactsComplete, true)
})
