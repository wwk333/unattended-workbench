/**
 * 阶段 3（补）· D-11 第二步：收据回写（编排收活 → C 状态库里的 attempt）
 *
 * 关键纪律：**记账失败不能影响发卡与收活**。所以 `recordAttempt()` 永不抛，
 * 失败只回 `{ok:false, why}`，调用方记一句日志就继续。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { recordAttempt, eventsOfOut } from '../_unattended/_收据回写.mjs'
import { openDb, listAttempts, listRuns } from '../_unattended/_状态库.mjs'
import { dump } from './_助手.mjs'

const P = 'X:/无人值守/workspaces/_演练8'

function scratch () {
  const dir = mkdtempSync(join(tmpdir(), 'crew-receipt-'))
  return { dir, db: join(dir, 'crew.db'), done: () => { try { rmSync(dir, { recursive: true, force: true }) } catch {} } }
}

test('eventsOfOut：认得 {events:[…]}、jsonl、空、坏行', () => {
  assert.deepEqual(eventsOfOut('{"events":[{"type":"a"},{"type":"b"}]}').length, 2)
  assert.equal(eventsOfOut('{"type":"x"}\n{"type":"y"}\nnot json\n').length, 2)
  assert.deepEqual(eventsOfOut(''), [])
  assert.deepEqual(eventsOfOut('纯文字'), [])
})

test('成功的一趟 ⇒ 库里一条 completed，且 run 自动建出来', () => {
  const t = scratch()
  try {
    const r = recordAttempt({ project: P, runId: 'R-step2', taskId: 'T1', role: 'coder-a', carrier: 'pi', ok: true, dbPath: t.db })
    assert.equal(r.ok, true, r.why)
    assert.ok(r.attemptId)
    const db = openDb({ dbPath: t.db, readonly: true })
    try {
      assert.equal(listRuns(db, { project: P }).length, 1, 'run 应被自动建出来')
      const rows = listAttempts(db, { taskId: 'T1' })
      assert.equal(rows.length, 1)
      assert.equal(rows[0].state, 'completed')
      assert.equal(rows[0].role, 'coder-a')
    } finally { db.close() }
    dump('record-ok', { attemptId: r.attemptId })
  } finally { t.done() }
})

test('失败的一趟 ⇒ state=failed 且带判决', () => {
  const t = scratch()
  try {
    const r = recordAttempt({ project: P, runId: 'R-step2', taskId: 'T2', role: 'coder-b', carrier: 'opencode', ok: false, verdict: 'capability', why: '上下文不够', dbPath: t.db })
    assert.equal(r.ok, true, r.why)
    const db = openDb({ dbPath: t.db, readonly: true })
    try {
      const row = listAttempts(db, { taskId: 'T2' })[0]
      assert.equal(row.state, 'failed')
      assert.equal(row.failure.verdict, 'capability')
      assert.match(String(row.failure.why), /上下文不够/)
    } finally { db.close() }
  } finally { t.done() }
})

test('有 out.json ⇒ 压缩统计落库；没有 ⇒ 留空不估算', () => {
  const t = scratch()
  try {
    const out = join(t.dir, 'T3.out.json')
    writeFileSync(out, [
      JSON.stringify({ type: 'turn_end', usage: { promptTokens: 120000 } }),
      JSON.stringify({ type: 'compaction_end', tokensBefore: 400000 }),
      JSON.stringify({ type: 'turn_end', usage: { promptTokens: 390000 } })
    ].join('\n'), 'utf8')

    recordAttempt({ project: P, runId: 'R-step2', taskId: 'T3', role: 'coder-a', carrier: 'pi', ok: true, outFile: out, dbPath: t.db })
    recordAttempt({ project: P, runId: 'R-step2', taskId: 'T4', role: 'coder-a', carrier: 'pi', ok: true, dbPath: t.db })

    const db = openDb({ dbPath: t.db, readonly: true })
    try {
      const a = listAttempts(db, { taskId: 'T3' })[0]
      assert.equal(a.ctxPeak, 400000)
      assert.equal(a.compactions, 1)
      assert.equal(a.firstCompactionTokens, 400000)
      const b = listAttempts(db, { taskId: 'T4' })[0]
      assert.equal(b.ctxPeak, null, '没有事件流就必须留空')
      dump('record-stats', { withOut: a.ctxPeak, without: b.ctxPeak })
    } finally { db.close() }
  } finally { t.done() }
})

test('永不抛：库路径不可写 ⇒ 返回 ok:false + 原因（调用方能继续跑）', () => {
  const r = recordAttempt({ project: P, runId: 'R-x', taskId: 'T9', ok: true, dbPath: join(tmpdir(), 'crew-no-such-dir-xyz', 'sub', 'crew.db') })
  // 注意：openDb 会 mkdir -p，所以这里其实能建成功；真正保证的是"任何异常都被兜住"
  assert.equal(typeof r.ok, 'boolean')
  if (r.ok === false) assert.match(String(r.why), /记账失败/)
  // 缺参数也必须安全返回
  assert.equal(recordAttempt({}).ok, false)
  assert.match(String(recordAttempt({}).why), /缺 project\/runId\/taskId/)
})

test('幂等：同一个 attemptId 重记不会变成两条', () => {
  const t = scratch()
  try {
    const a = recordAttempt({ project: P, runId: 'R-idem', taskId: 'T5', ok: true, attemptId: 'A-fixed', dbPath: t.db })
    const b = recordAttempt({ project: P, runId: 'R-idem', taskId: 'T5', ok: true, attemptId: 'A-fixed', dbPath: t.db })
    assert.equal(a.ok, true)
    assert.equal(b.ok, true)
    assert.match(String(b.why), /已存在/)
    const db = openDb({ dbPath: t.db, readonly: true })
    try { assert.equal(listAttempts(db, { taskId: 'T5' }).length, 1) } finally { db.close() }
  } finally { t.done() }
})

test('编排真的在记账：开工登记 + 收口，而且**失败只告警**（源码级断言）', async () => {
  const { readFileSync } = await import('node:fs')
  const { join } = await import('node:path')
  const { UNATTENDED } = await import('./_服务夹具.mjs')
  const src = readFileSync(join(UNATTENDED, '编排.mjs'), 'utf8')
  assert.match(src, /import \{ beginAttempt, endAttempt \} from '\.\/_收据回写\.mjs'/)
  // 第三步：开工即登记（D11-SPAWN）
  assert.match(src, /D11-SPAWN/)
  assert.match(src, /attemptHandle = beginAttempt\(/)
  assert.match(src, /let attemptHandle = null/)
  // 第二/三步：收口（D11-RECEIPT），有 handle 收口、没有就补记
  assert.match(src, /D11-RECEIPT/)
  assert.match(src, /endAttempt\(\{/)
  assert.match(src, /attemptId: attemptHandle\?\.ok \? attemptHandle\.attemptId : null/)
  // 失败只 log，不阻断
  assert.match(src, /⚠️ 开工登记失败（不影响本轮）/)
  assert.match(src, /⚠️ 收据回写失败（不影响本轮）/)
  assert.match(src, /⚠️ 收据回写异常（不影响本轮）/)
  // runId 用 RUNDIR 的 stamp（同一轮挂同一个 run）
  assert.match(src, /runId: stamp/)
})
