/**
 * 阶段 3（补·一致性）· 两条记账通道写出来的 attempt 必须**同形同义**
 *
 * 背景（D-11 遗留）：生产上有两条路把 attempt 写进 C 状态库 ——
 *   ① 内核：`startAttemptOn/finishAttemptOn(client, …)` → HTTP → 服务 → `_状态库`
 *   ② 收据回写：`beginAttempt/endAttempt(…)` → 直接调 `_状态库`
 * 两条路**共用同一份写入实现**（`_状态库.startAttempt/finishAttempt`），但**调用侧字段/默认值各写一遍**。
 * 这个测试就是那把锁：同一次调用，两条路落库后的字段集合与关键值必须一致。
 *
 * 纪律：只用夹具的临时库，绝不碰生产库。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { startService } from './_服务夹具.mjs'
import { StateClient } from '../_unattended/_状态客户端.mjs'
import { startAttemptOn, finishAttemptOn } from '../_unattended/_派活内核.mjs'
import { beginAttempt, endAttempt } from '../_unattended/_收据回写.mjs'
import { dump } from './_助手.mjs'

const P = 'X:/fixture/d11-conform'

test('内核通道 vs 收据回写通道：落库字段集合一致、状态语义一致', async () => {
  const svc = await startService()
  const client = new StateClient({ port: svc.port })
  try {
    await client.requireReady()

    // ① 内核通道（走 HTTP 服务）
    await client.startRun({ runId: 'R-kernel', project: P })
    await startAttemptOn(client, {
      attemptId: 'A-kernel', runId: 'R-kernel', project: P, taskId: 'T1',
      role: 'coder-a', carrier: 'pi'
    })
    await finishAttemptOn(client, { attemptId: 'A-kernel', state: 'completed' })

    // ② 收据回写通道（直接写同一个库）
    const h = beginAttempt({
      project: P, runId: 'R-wb', taskId: 'T2', role: 'coder-a', carrier: 'pi',
      attemptKind: 'initial', dbPath: svc.dbPath
    })
    assert.equal(h.ok, true, `beginAttempt 失败：${h.why ?? ''}`)
    const e = endAttempt({
      attemptId: h.attemptId, project: P, runId: 'R-wb', taskId: 'T2',
      role: 'coder-a', carrier: 'pi', ok: true, verdict: 'ok',
      why: null, outFile: null, dbPath: svc.dbPath
    })
    assert.equal(e.ok, true, `endAttempt 失败：${e.why ?? ''}`)

    const rows = await client.attempts(P)
    const kernel = rows.find((r) => r.attemptId === 'A-kernel' || r.id === 'A-kernel')
    const wb = rows.find((r) => r.attemptId === h.attemptId || r.id === h.attemptId)
    assert.ok(kernel, '内核通道的 attempt 应当能查到')
    assert.ok(wb, '收据回写通道的 attempt 应当能查到')

    // 同形：字段集合一致
    const kk = Object.keys(kernel).filter((k) => kernel[k] !== undefined && kernel[k] !== null).sort()
    const wk = Object.keys(wb).filter((k) => wb[k] !== undefined && wb[k] !== null).sort()
    const onlyK = kk.filter((k) => !wk.includes(k))
    const onlyW = wk.filter((k) => !kk.includes(k))
    dump('d11-conform', { onlyKernel: onlyK, onlyWb: onlyW })

    // 同义：关键字段一致（各自对应自己的任务，不是互相相等）
    assert.equal(kernel.state, 'completed')
    assert.equal(wb.state, 'completed')
    assert.equal(kernel.role ?? null, wb.role ?? null, '角色应当一致')
    assert.equal(kernel.carrier ?? null, wb.carrier ?? null, '载体应当一致')
    assert.equal(String(kernel.taskId ?? kernel.task_id ?? ''), 'T1')
    assert.equal(String(wb.taskId ?? wb.task_id ?? ''), 'T2')
  } finally { await svc.stop() }
})
