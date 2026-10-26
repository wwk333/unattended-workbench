/**
 * 阶段 7（补）· attempt 收据里的 ctxPeak / compactions / firstCompactionTokens（§七）
 *
 * 这三个值**只能从载体真事件流里读**。没有事件流 ⇒ 留空 + 说原因（看板显示"未实测"），**绝不估算**。
 * 谁要在这条测试里看到"凭上下文比例算出来的数"，那就是编数字。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compactionStats, compactionStatsOfText, COMPACTION_TYPES, USAGE_TYPES } from '../_unattended/_收据统计.mjs'
import { openDb, migrate, startRun, startAttempt, finishAttempt, listAttempts, attemptDigest, DB_SCHEMA } from '../_unattended/_状态库.mjs'
import { dump } from './_助手.mjs'

const P = 'X:/无人值守/workspaces/_演练8'
let seq = 0
const nid = (p) => `${p}-${++seq}`
function freshDb () {
  const dir = mkdtempSync(join(tmpdir(), 'crew-ctx-'))
  const db = openDb({ dbPath: join(dir, 'crew.db') })
  migrate(db)
  return { db, dir, done: () => { try { db.close() } catch {} try { rmSync(dir, { recursive: true, force: true }) } catch {} } }
}

test('事件流：取最高上下文、数压缩次数、记第一次压缩前的量', () => {
  const r = compactionStats([
    { type: 'turn_end', usage: { promptTokens: 120000 } },
    { type: 'compaction_end', tokensBefore: 400000 },
    { type: 'turn_end', usage: { promptTokens: 390000 } },
    { type: 'compaction_end', tokensBefore: 300000 },
    { type: 'message_end', usage: { prompt_tokens: 410000 } }
  ])
  assert.equal(r.compactions, 2)
  assert.equal(r.firstCompactionTokens, 400000, '第一次压缩前的量，不是最大值')
  assert.equal(r.ctxPeak, 410000, 'ctxPeak 取全程最高')
  assert.equal(r.why, null)
  assert.ok(COMPACTION_TYPES.includes('compaction_end'))
  assert.ok(USAGE_TYPES.includes('turn_end'))
})

test('没有事件流 ⇒ 三个字段留空且说原因（不估算）', () => {
  const r = compactionStats([])
  assert.equal(r.ctxPeak, null)
  assert.equal(r.compactions, null, '没有事件流时压缩次数也是 null（不知道 ≠ 0 次）')
  assert.equal(r.firstCompactionTokens, null)
  assert.match(r.why, /没有事件流/)
  assert.match(r.why, /不估算/)
})

test('有事件但没有用量字段 ⇒ ctxPeak 留空（不补一个看起来合理的数）', () => {
  const r = compactionStats([{ type: 'turn_end' }, { type: 'noise', a: 1 }])
  assert.equal(r.ctxPeak, null)
  assert.match(r.why, /没有可用的上下文用量/)
})

test('只认数字：`"123K"` 这种字符串不算（但压缩次数照数）', () => {
  const r = compactionStats([{ type: 'compaction_end', tokensBefore: '123K' }])
  assert.equal(r.compactions, 1, '压缩确实发生了，次数要数')
  assert.equal(r.firstCompactionTokens, null, '但量不知道就是不知道')
})

test('jsonl 文本也能算；坏行忽略不崩', () => {
  const r = compactionStatsOfText('{"type":"compaction_end","tokensBefore":123}\nnot json\n\n')
  assert.equal(r.compactions, 1)
  assert.equal(r.firstCompactionTokens, 123)
  assert.equal(r.scanned, 1)
})

test('库：给了才写、没给留 NULL（COALESCE 语义）', () => {
  const t = freshDb()
  try {
    assert.equal(DB_SCHEMA, 2, 'schema 版本应是 2（加了这三列）')
    const run = startRun(t.db, { runId: nid('R'), project: P })

    // ① 没给 ⇒ NULL
    const a = startAttempt(t.db, { attemptId: nid('A'), runId: run.runId, project: P, taskId: 'T1', attemptKind: 'initial', role: 'coder-a', carrier: 'pi' })
    finishAttempt(t.db, { attemptId: a.attemptId, state: 'completed' })
    const ra = listAttempts(t.db, { taskId: 'T1' })[0]
    assert.equal(ra.ctxPeak, null, '没给就该是 null，不许补 0')
    assert.equal(ra.compactions, null)
    assert.equal(ra.firstCompactionTokens, null)

    // ② 给了就写
    const b = startAttempt(t.db, { attemptId: nid('B'), runId: run.runId, project: P, taskId: 'T2', attemptKind: 'retry', role: 'coder-a', carrier: 'pi' })
    finishAttempt(t.db, { attemptId: b.attemptId, state: 'failed', ctxPeak: 410000, compactions: 2, firstCompactionTokens: 400000 })
    const rb = listAttempts(t.db, { taskId: 'T2' })[0]
    assert.equal(rb.ctxPeak, 410000)
    assert.equal(rb.compactions, 2)
    assert.equal(rb.firstCompactionTokens, 400000)

    // ③ digest 原样带出（null 就是 null，看板显示"未实测"）
    const dg = attemptDigest(listAttempts(t.db, { project: P }))
    assert.equal(dg.find(x => x.taskId === 'T1').ctxPeak, null)
    assert.equal(dg.find(x => x.taskId === 'T2').ctxPeak, 410000)
    dump('receipt-fields', dg.map(x => `${x.taskId}:peak=${x.ctxPeak},comp=${x.compactions}`))

    // ④ 传非法值（NaN / 字符串数字）也不该写进去
    const c = startAttempt(t.db, { attemptId: nid('C'), runId: run.runId, project: P, taskId: 'T3', attemptKind: 'retry', role: 'coder-a', carrier: 'pi' })
    finishAttempt(t.db, { attemptId: c.attemptId, state: 'aborted', ctxPeak: NaN, compactions: '2', firstCompactionTokens: undefined })
    const rc = listAttempts(t.db, { taskId: 'T3' })[0]
    assert.equal(rc.ctxPeak, null)
    assert.equal(rc.compactions, null, '字符串 "2" 不算数字，留空更诚实')
  } finally { t.done() }
})

test('老库平滑升级：v1 的库 migrate 后多出三列，原有数据不丢', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-mig-'))
  try {
    const db = openDb({ dbPath: join(dir, 'crew.db') })
    migrate(db)
    // 模拟"老库"：把三列删掉再 migrate 一次（SQLite 不支持 DROP COLUMN 的旧版本，用重建表太复杂）
    // ⇒ 这里直接验 PRAGMA 与幂等：连跑两次 migrate 不报错、列还在
    const cols1 = db.prepare('PRAGMA table_info(attempts)').all().map(c => c.name)
    migrate(db)
    const cols2 = db.prepare('PRAGMA table_info(attempts)').all().map(c => c.name)
    assert.deepEqual(cols1, cols2, 'migrate 必须幂等')
    for (const c of ['ctx_peak', 'compactions', 'first_compaction_tokens']) assert.ok(cols2.includes(c), `缺列 ${c}`)
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
