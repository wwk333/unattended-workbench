/**
 * 阶段 7（补）· 角色抽屉的 attempt / 恢复（§十）
 *
 * 文档要求：抽屉里能看到这个角色最近几次尝试；**缺 attempt 不许显示 completed**；
 * routeDecision 不一致要显红；读不到就说读不到（不显示空表假装没失败过）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, migrate, startRun, startAttempt, finishAttempt, listAttempts, attemptDigest } from '../_unattended/_状态库.mjs'
import { UNATTENDED } from './_服务夹具.mjs'
import { dump } from './_助手.mjs'

const PANEL = join(UNATTENDED, '面板')
const P = 'D:/无人值守/workspaces/_演练8'
let seq = 0
const nid = (p) => `${p}-${++seq}`

function freshDb () {
  const dir = mkdtempSync(join(tmpdir(), 'crew-attempt-'))
  const file = join(dir, 'crew.db')
  const db = openDb({ dbPath: file })
  migrate(db)
  return { db, file, dir, done: () => { try { db.close() } catch {} try { rmSync(dir, { recursive: true, force: true }) } catch {} } }
}

test('按角色查 attempt（listAttempts 支持 role 过滤）', () => {
  const t = freshDb()
  try {
    const run = startRun(t.db, { runId: nid('R'), project: P })
    startAttempt(t.db, { attemptId: nid('A'), runId: run.runId, project: P, taskId: 'T1', attemptKind: 'initial', role: 'coder-a', carrier: 'pi' })
    startAttempt(t.db, { attemptId: nid('A'), runId: run.runId, project: P, taskId: 'T2', attemptKind: 'initial', role: 'coder-b', carrier: 'opencode' })
    assert.equal(listAttempts(t.db, { project: P, role: 'coder-a' }).length, 1)
    assert.equal(listAttempts(t.db, { project: P, role: 'coder-b' }).length, 1)
    assert.equal(listAttempts(t.db, { project: P }).length, 2)
    assert.equal(listAttempts(t.db, { project: P, role: 'reviewer' }).length, 0)
  } finally { t.done() }
})

test('attemptDigest：缺 endedAt 的 completed 必须标出来（不许当已完成看）', () => {
  const t = freshDb()
  try {
    const run = startRun(t.db, { runId: nid('R'), project: P })
    const a = startAttempt(t.db, { attemptId: nid('A'), runId: run.runId, project: P, taskId: 'T1', attemptKind: 'capability', role: 'coder-a', carrier: 'pi' })
    finishAttempt(t.db, { attemptId: a.attemptId, state: 'aborted', failure: { verdict: 'capability', why: '能力不足' } })
    const dg = attemptDigest(listAttempts(t.db, { project: P, role: 'coder-a' }))
    assert.equal(dg.length, 1)
    assert.equal(dg[0].state, 'aborted')
    assert.equal(dg[0].verdict, 'capability')
    assert.match(String(dg[0].why), /能力不足/)
    assert.equal(dg[0].budget, 1, '编码型 attempt 记 1 次预算')

    // 手工造一条"completed 但没 endedAt"——只能绕过 finishAttempt 直接改库
    const b = startAttempt(t.db, { attemptId: nid('B'), runId: run.runId, project: P, taskId: 'T2', attemptKind: 'initial', role: 'coder-a', carrier: 'pi' })
    t.db.prepare("UPDATE attempts SET state='completed', ended_at=NULL WHERE attempt_id=?").run(b.attemptId)
    const dg2 = attemptDigest(listAttempts(t.db, { project: P, role: 'coder-a' }))
    const bad = dg2.find(x => x.id === b.attemptId)
    assert.ok(bad.missing, '缺 endedAt 的 completed 必须带 missing 说明')
    assert.match(bad.missing, /不许当已完成/)
    dump('attempt-digest', dg2.map(x => `${x.kind}/${x.state}${x.missing ? '(缺证据)' : ''}`))
  } finally { t.done() }
})

test('attemptDigest：route 三处不一致 ⇒ routeMismatch=true', () => {
  const t = freshDb()
  try {
    const run = startRun(t.db, { runId: nid('R'), project: P })
    const a = startAttempt(t.db, {
      attemptId: nid('A'), runId: run.runId, project: P, taskId: 'T1', attemptKind: 'initial', role: 'coder-a', carrier: 'pi',
      requested: { provider: 'ark', model: 'm' }
    })
    finishAttempt(t.db, { attemptId: a.attemptId, state: 'completed', actual: { provider: 'ocgo', model: 'm' } })
    const dg = attemptDigest(listAttempts(t.db, { project: P, role: 'coder-a' }))
    assert.equal(dg[0].routeMismatch, true, 'requested=ark / actual=ocgo 应判不一致')
  } finally { t.done() }
})

test('抽屉：详情里带 attempts，抽屉会画出来（源码级断言）', () => {
  const panel = readFileSync(join(PANEL, '链路面板.mjs'), 'utf8')
  assert.match(panel, /import \{ openDb, listAttempts, attemptDigest \} from '\.\.\/_状态库\.mjs'/)
  assert.match(panel, /listAttempts\(db, \{ project: String\(b\.currentProject\?\.path \?\? ''\), role: carrierRole, limit: 10 \}\)/)
  assert.match(panel, /readonly: true/, '看板只许只读打开状态库')
  assert.match(panel, /attemptsWhy = '读不到 C 状态库/, '读不到要明说，不许静默空表')
  assert.match(panel, /^\s+attempts,$/m)
  assert.match(panel, /^\s+attemptsWhy,$/m)

  const page = readFileSync(join(PANEL, '链路页.js'), 'utf8')
  assert.match(page, /Array\.isArray\(d\.attempts\) && d\.attempts\.length/)
  assert.match(page, /最近尝试（/)
  assert.match(page, /route-mismatch/)
  assert.match(page, /还没有 attempt 记录/)
})

test('真实状态库：能只读打开并查 attempt（空表也正常返回 0 条）', () => {
  const file = join(UNATTENDED, '..', '_crew', 'state', 'crew.db')
  if (!existsSync(file)) return
  const db = openDb({ dbPath: file, readonly: true })
  try {
    const rows = listAttempts(db, { limit: 5 })
    assert.ok(Array.isArray(rows))
    dump('real-attempts', { count: rows.length })
  } finally { try { db.close() } catch {} }
})
