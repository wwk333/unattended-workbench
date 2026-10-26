/**
 * 阶段 3 · 派活内核 ↔ C 状态库 集成（§六）
 *
 * 纯函数测过之后，这里证明**真落库**也守同一条线：
 *   · 6 次编码调用后第 7 次被状态服务拒（不是靠调用方自觉）；
 *   · judge 不吃预算；budget 能查回来；
 *   · kill-intent 之后 attempt 标 aborted（不判 flaky、不吃预算）；
 *   · 没有 attempt 收据的卡**不许** done（`auditDb` 报 done-without-attempt）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './_服务夹具.mjs'
import { StateClient } from '../_unattended/_状态客户端.mjs'
import { startAttemptOn, finishAttemptOn, recover, classify, writeKillIntent, CODING_BUDGET } from '../_unattended/_派活内核.mjs'
import { auditDb, getTask, setTaskStatus, upsertTask, startRun, finishRun, openDb } from '../_unattended/_状态库.mjs'
import { dump } from './_助手.mjs'

const PROJECT = 'X:/fixture/kernel'

test('6 次编码预算由状态服务硬卡：第 7 次被拒（不是调用方自觉）', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  try {
    await c.startRun({ runId: 'R1', project: PROJECT })
    for (let i = 1; i <= CODING_BUDGET; i++) {
      await startAttemptOn(c, { attemptId: `A${i}`, runId: 'R1', project: PROJECT, taskId: 'T1' })
    }
    const b = await c.budget({ runId: 'R1', taskId: 'T1' })
    assert.equal(b.used, CODING_BUDGET)
    assert.equal(b.remaining, 0)
    await assert.rejects(
      () => startAttemptOn(c, { attemptId: 'A7', runId: 'R1', project: PROJECT, taskId: 'T1' }),
      (e) => e.conflict === true || /6 次/.test(e.message),
      '第 7 次必须被拒'
    )
    // judge 不吃预算
    await startAttemptOn(c, { attemptId: 'J1', runId: 'R1', project: PROJECT, taskId: 'T1', attemptKind: 'judge' })
    assert.equal((await c.budget({ runId: 'R1', taskId: 'T1' })).used, CODING_BUDGET)
    dump('budget-integration', { used: b.used, limit: CODING_BUDGET })
  } finally { await svc.stop() }
})

test('kill-intent：attempt 收口成 aborted（不是 failed），且不判 flaky', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  try {
    await c.startRun({ runId: 'R2', project: PROJECT })
    const a = await startAttemptOn(c, { attemptId: 'AK', runId: 'R2', project: PROJECT, taskId: 'T1' })
    assert.equal(a.state, 'running')
    const cls = classify({ hadKillIntent: true, collected: { exitCode: null } })
    assert.equal(cls.verdict, 'kill-intent')
    // 按 §六：杀完标 aborted-by-brain
    const done = await finishAttemptOn(c, { attemptId: 'AK', state: 'aborted', reason: 'aborted-by-brain', failure: { verdict: 'kill-intent' } })
    assert.equal(done.state, 'aborted')
    assert.equal(done.reason, 'aborted-by-brain')
    assert.equal(done.failure.verdict, 'kill-intent')
    // kill-intent 不吃预算
    assert.equal((await c.budget({ runId: 'R2', taskId: 'T1' })).used, 1) // 第 1 次是初始调用本身
    dump('kill-intent-integration', { state: done.state, reason: done.reason })
  } finally { await svc.stop() }
})

test('attempt state 只允许四种：blocked 会被服务拒（400）', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  try {
    await c.startRun({ runId: 'R3', project: PROJECT })
    await startAttemptOn(c, { attemptId: 'AB', runId: 'R3', project: PROJECT, taskId: 'T1' })
    await assert.rejects(
      () => finishAttemptOn(c, { attemptId: 'AB', state: 'blocked' }),
      (e) => e.status === 400 || /blocked/.test(e.message)
    )
  } finally { await svc.stop() }
})

test('没有 attempt 收据的卡不许 done（auditDb 报 done-without-attempt）', () => {
  const db = openDb({ dbPath: ':memory:' })
  try {
    upsertTask(db, { project: PROJECT, id: 'T1' })
    let t = getTask(db, PROJECT, 'T1')
    for (const to of ['ready', 'doing', 'review', 'done']) {
      t = setTaskStatus(db, { project: PROJECT, id: 'T1', to, expectedVersion: t.version })
    }
    assert.equal(t.status, 'done')
    const r = auditDb(db, { project: PROJECT })
    assert.equal(r.ok, false)
    assert.ok(r.problems.some(p => p.code === 'done-without-attempt'))
    dump('done-without-attempt', r.problems)
  } finally { db.close() }
})

test('run 被强杀 ⇒ aborted，attempt 一起收口（不留孤儿）', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  try {
    await c.startRun({ runId: 'R4', project: PROJECT, pid: 999999 })
    await startAttemptOn(c, { attemptId: 'A4', runId: 'R4', project: PROJECT, taskId: 'T1', pid: 999999 })
    const healed = await c.heal({ project: PROJECT })
    assert.equal(healed.runs.length, 1)
    const run = await c.run('R4')
    assert.equal(run.state, 'aborted')
    assert.equal(run.reason, 'unknown-external-termination')
    const atts = await c.attempts({ runId: 'R4' })
    assert.equal(atts[0].state, 'aborted')
    dump('run-killed-integration', { run: run.state, attempt: atts[0].state })
  } finally { await svc.stop() }
})

test('recover 与落库一致：rescue 计入预算、二次 rescue 被策略拦', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  try {
    await c.startRun({ runId: 'R5', project: PROJECT })
    // 第一次能力不足 ⇒ rescue，落库（算 1 次预算）
    const r1 = recover({ verdict: 'capability', budgetUsed: 0 })
    assert.equal(r1.action, 'rescue')
    await startAttemptOn(c, { attemptId: 'A5', runId: 'R5', project: PROJECT, taskId: 'T1', attemptKind: 'rescue' })
    await finishAttemptOn(c, { attemptId: 'A5', state: 'failed', failure: { verdict: 'capability', reason: r1.reason } })
    const used = (await c.budget({ runId: 'R5', taskId: 'T1' })).used
    assert.equal(used, 1)
    // 第二次能力不足 + 已有 rescue 记录 ⇒ 策略层直接 blocked
    const r2 = recover({ verdict: 'capability', budgetUsed: used, attempts: [{ attemptKind: 'rescue', reason: r1.reason }] })
    assert.equal(r2.action, 'blocked')
    dump('rescue-integration', { first: r1.action, used, second: r2.action })
  } finally { await svc.stop() }
})

test('kill-intent 文件协议：写在 _crew/kill-intent.json，能被读回', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = mkdtempSync(join(tmpdir(), 'ki-'))
  try {
    const { readKillIntent, clearKillIntent } = await import('../_unattended/_派活内核.mjs')
    const body = writeKillIntent(dir, { runId: 'R9', taskId: 'T9', reason: '改跑波器' })
    assert.equal(body.intent, 'brain-kill')
    assert.equal(readKillIntent(dir).reason, '改跑波器')
    assert.equal(clearKillIntent(dir), true)
    assert.equal(readKillIntent(dir), null)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
