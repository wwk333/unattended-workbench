/**
 * 端到端：事件流 → 收据 → 库（§七）
 *
 * 这条链有**四个环节**，任何一环把字段吞了，值就到不了库里：
 *   ① `_收统计数据.compactionStats(events)` 算
 *   ② `_派活内核.finishAttemptOn(client, {events})` 传
 *   ③ `_状态客户端.finishAttempt` 发（HTTP body）
 *   ④ `_状态库.finishAttempt` 写（COALESCE）
 *
 * 所以这里**走真服务**验一遍，而不是只测第 ①④ 两头。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './_服务夹具.mjs'
import { StateClient } from '../_unattended/_状态客户端.mjs'
import { finishAttemptOn } from '../_unattended/_派活内核.mjs'
import { openDb, listAttempts } from '../_unattended/_状态库.mjs'
import { dump } from './_助手.mjs'

const PROJECT = 'D:/无人值守/workspaces/_演练8'

test('事件流经 finishAttemptOn 一路写进库（四环不掉字段）', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  try {
    const run = await c.startRun({ runId: 'R-' + Math.random().toString(36).slice(2, 9), project: PROJECT })
    const a = await c.startAttempt({ attemptId: 'A-' + Math.random().toString(36).slice(2, 9), runId: run.runId, project: PROJECT, taskId: 'T-RECEIPT', attemptKind: 'initial', role: 'coder-a', carrier: 'pi' })

    const events = [
      { type: 'turn_end', usage: { promptTokens: 120000 } },
      { type: 'compaction_end', tokensBefore: 400000 },
      { type: 'turn_end', usage: { promptTokens: 390000 } }
    ]
    await finishAttemptOn(c, { attemptId: a.attemptId, state: 'completed', events })

    const db = openDb({ dbPath: svc.dbPath, readonly: true })
    try {
      const row = listAttempts(db, { taskId: 'T-RECEIPT' })[0]
      assert.equal(row.ctxPeak, 400000, 'ctxPeak 应取全程最高（压缩前 400K 那次）')
      assert.equal(row.compactions, 1)
      assert.equal(row.firstCompactionTokens, 400000)
      dump('receipt-e2e', { ctxPeak: row.ctxPeak, compactions: row.compactions })
    } finally { try { db.close() } catch {} }
  } finally { await svc.stop() }
})

test('不给事件流 ⇒ 库里三列留 NULL（不估算、不写 0）', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  try {
    const run = await c.startRun({ runId: 'R-' + Math.random().toString(36).slice(2, 9), project: PROJECT })
    const a = await c.startAttempt({ attemptId: 'A-' + Math.random().toString(36).slice(2, 9), runId: run.runId, project: PROJECT, taskId: 'T-NORECEIPT', attemptKind: 'initial', role: 'coder-b', carrier: 'opencode' })
    await finishAttemptOn(c, { attemptId: a.attemptId, state: 'failed', failure: { verdict: 'flaky', why: 'x' } })

    const db = openDb({ dbPath: svc.dbPath, readonly: true })
    try {
      const row = listAttempts(db, { taskId: 'T-NORECEIPT' })[0]
      assert.equal(row.ctxPeak, null, '没数据就该是 null')
      assert.equal(row.compactions, null)
      assert.equal(row.firstCompactionTokens, null)
    } finally { try { db.close() } catch {} }
  } finally { await svc.stop() }
})

test('直接给值也走同一条路（两种给法等价）', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  try {
    const run = await c.startRun({ runId: 'R-' + Math.random().toString(36).slice(2, 9), project: PROJECT })
    const a = await c.startAttempt({ attemptId: 'A-' + Math.random().toString(36).slice(2, 9), runId: run.runId, project: PROJECT, taskId: 'T-DIRECT', attemptKind: 'retry', role: 'coder-a', carrier: 'pi' })
    await finishAttemptOn(c, { attemptId: a.attemptId, state: 'completed', ctxPeak: 512000, compactions: 3, firstCompactionTokens: 300000 })
    const db = openDb({ dbPath: svc.dbPath, readonly: true })
    try {
      const row = listAttempts(db, { taskId: 'T-DIRECT' })[0]
      assert.equal(row.ctxPeak, 512000)
      assert.equal(row.compactions, 3)
      assert.equal(row.firstCompactionTokens, 300000)
    } finally { try { db.close() } catch {} }
  } finally { await svc.stop() }
})
