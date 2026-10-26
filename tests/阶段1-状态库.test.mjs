/**
 * 阶段 1 · 状态库（库层）（§三）
 *
 * 覆盖文档点名的验收项里**不需要起服务**的那些：
 *   · 并发/丢更新（版本冲突）；
 *   · doing 残留自愈；
 *   · 进程被杀 → run=aborted，不编 completed；
 *   · attempt=blocked 被拒；run=done 被拒；
 *   · halt 匹配不上不许销；
 *   · 6 次编码预算（judge 不计）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  openDb, dbInfo, heal, pidAlive,
  upsertTask, getTask, listTasks, setTaskStatus, assignRole, readyTasks,
  startRun, getRun, listRuns, finishRun, updateRunProgress, heartbeat,
  startAttempt, listAttempts, finishAttempt, budgetUsed,
  openHalt, listHalts, closeHalt, addRework, listReworks,
  auditDb, logEvent, listEvents, CODING_BUDGET, DB_SCHEMA,
  ConflictError, NotFoundError, BadRequestError
} from '../_unattended/_状态库.mjs'
import { dump } from './_助手.mjs'

const PROJECT = 'X:/fixture/proj'

function freshDb () {
  return openDb({ dbPath: ':memory:' })
}

test('库能建、能报信息、六张表都在', () => {
  const db = freshDb()
  const info = dbInfo(db)
  assert.equal(info.schemaVersion, DB_SCHEMA) // v2 加了 ctx_peak/compactions/first_compaction_tokens（§七），断言跟着版本走
  assert.equal(info.tasks, 0)
  dump('db-info', info)
  db.close()
})

test('建卡 → 读卡 → 定义更新；状态不在 upsert 里改', () => {
  const db = freshDb()
  const t = upsertTask(db, { project: PROJECT, id: 'T1', wave: 'W1', role: 'coder-a', goal: '做登录', deliverables: ['src/a.js'], depends: [], accept: ['node t.mjs'] })
  assert.equal(t.status, 'pending')
  assert.deepEqual(t.deliverables, ['src/a.js'])
  const t2 = upsertTask(db, { project: PROJECT, id: 'T1', goal: '做登录+注册', writes: [] })
  assert.equal(t2.goal, '做登录+注册')
  assert.deepEqual(t2.writes, []) // 显式空数组 ≠ null（null 是 unknown-scope）
  assert.equal(t2.version, 2)
  assert.equal(t2.status, 'pending')
  dump('task-basic', t2)
  db.close()
})

test('负向：不存在的卡读出来是 NotFound，不是"空对象"', () => {
  const db = freshDb()
  assert.throws(() => getTask(db, PROJECT, 'NOPE'), NotFoundError)
  assert.throws(() => setTaskStatus(db, { project: PROJECT, id: 'NOPE', to: 'ready', expectedVersion: 1 }), NotFoundError)
  db.close()
})

test('状态迁移：正常链走得通，跨层值/跳步被拒', () => {
  const db = freshDb()
  upsertTask(db, { project: PROJECT, id: 'T1' })
  let t = getTask(db, PROJECT, 'T1')
  t = setTaskStatus(db, { project: PROJECT, id: 'T1', to: 'ready', expectedVersion: t.version })
  t = setTaskStatus(db, { project: PROJECT, id: 'T1', to: 'doing', expectedVersion: t.version })
  t = setTaskStatus(db, { project: PROJECT, id: 'T1', to: 'review', expectedVersion: t.version })
  t = setTaskStatus(db, { project: PROJECT, id: 'T1', to: 'done', expectedVersion: t.version })
  assert.equal(t.status, 'done')
  assert.equal(t.version, 5)

  // done → doing 不许（要先 review）
  assert.throws(() => setTaskStatus(db, { project: PROJECT, id: 'T1', to: 'doing', expectedVersion: t.version }), ConflictError)
  // 跨层值：accepted 只属 release
  assert.throws(() => setTaskStatus(db, { project: PROJECT, id: 'T1', to: 'accepted', expectedVersion: t.version }), /不是 task 的合法值/)
  // 不带版本 = 没法发现并发
  assert.throws(() => setTaskStatus(db, { project: PROJECT, id: 'T1', to: 'review' }), /expectedVersion/)
  db.close()
})

test('并发：两个人拿同一个版本改同一张卡 —— 一个成功，一个 409（不能双写）', () => {
  const db = freshDb()
  upsertTask(db, { project: PROJECT, id: 'T1' })
  const v = getTask(db, PROJECT, 'T1').version
  const a = setTaskStatus(db, { project: PROJECT, id: 'T1', to: 'ready', expectedVersion: v })
  assert.equal(a.status, 'ready')
  assert.throws(() => setTaskStatus(db, { project: PROJECT, id: 'T1', to: 'blocked', expectedVersion: v }), ConflictError)
  assert.equal(getTask(db, PROJECT, 'T1').status, 'ready') // 没被第二次覆盖
  db.close()
})

test('doing 自愈：没有活着的 running attempt ⇒ 自动回 pending + 留 recovery 事件', () => {
  const db = freshDb()
  upsertTask(db, { project: PROJECT, id: 'T1' })
  let t = getTask(db, PROJECT, 'T1')
  t = setTaskStatus(db, { project: PROJECT, id: 'T1', to: 'ready', expectedVersion: t.version })
  t = setTaskStatus(db, { project: PROJECT, id: 'T1', to: 'doing', expectedVersion: t.version })
  const run = startRun(db, { runId: 'R1', project: PROJECT, pid: process.pid })
  // 造一条死 pid 的 running attempt
  startAttempt(db, { attemptId: 'A1', runId: 'R1', taskId: 'T1', pid: 999999, role: 'coder-a', carrier: 'pi' })
  const r = heal(db, { isAlive: () => false })
  assert.equal(r.tasks.length, 1)
  assert.equal(getTask(db, PROJECT, 'T1').status, 'pending')
  const ev = listEvents(db, { project: PROJECT }).filter(e => e.kind === 'heal')
  assert.ok(ev.some(e => e.payload?.scope === 'task' && e.payload?.reason === 'doing-no-live-attempt'))
  dump('heal-doing', { healed: r, events: ev.map(e => e.payload) })
  db.close()
})

test('doing 自愈：真有活在跑就保留（不误杀）', () => {
  const db = freshDb()
  upsertTask(db, { project: PROJECT, id: 'T1' })
  let t = getTask(db, PROJECT, 'T1')
  t = setTaskStatus(db, { project: PROJECT, id: 'T1', to: 'ready', expectedVersion: t.version })
  setTaskStatus(db, { project: PROJECT, id: 'T1', to: 'doing', expectedVersion: t.version })
  startRun(db, { runId: 'R1', project: PROJECT, pid: process.pid })
  startAttempt(db, { attemptId: 'A1', runId: 'R1', taskId: 'T1', pid: process.pid })
  const r = heal(db, { isAlive: () => true })
  assert.equal(r.tasks.length, 0)
  assert.equal(getTask(db, PROJECT, 'T1').status, 'doing')
  db.close()
})

test('进程被杀：run 从 running → aborted，原因 unknown-external-termination，⛔ 不编 completed', () => {
  const db = freshDb()
  startRun(db, { runId: 'R-kill', project: PROJECT, pid: 999999 })
  startAttempt(db, { attemptId: 'A-kill', runId: 'R-kill', taskId: 'T1' })
  const r = heal(db, { isAlive: () => false })
  assert.equal(r.runs.length, 1)
  const run = getRun(db, 'R-kill')
  assert.equal(run.state, 'aborted')
  assert.equal(run.reason, 'unknown-external-termination')
  assert.equal(run.endedAt?.length > 0, true)
  const a = listAttempts(db, { runId: 'R-kill' })[0]
  assert.equal(a.state, 'aborted')
  assert.equal(a.reason, 'unknown-external-termination')
  dump('run-killed', { run, attempt: a })
  db.close()
})

test('超期：deadline 过了还在 running ⇒ aborted（deadline-exceeded）', () => {
  const db = freshDb()
  startRun(db, { runId: 'R-late', project: PROJECT, pid: process.pid, deadlineMs: 1000 })
  // 把 started_at 改成 1 小时前
  db.prepare('UPDATE runs SET started_at = ? WHERE run_id = ?').run(new Date(Date.now() - 3600_000).toISOString(), 'R-late')
  const r = heal(db, { isAlive: () => true })
  assert.equal(r.runs.length, 1)
  assert.equal(getRun(db, 'R-late').reason, 'deadline-exceeded')
  db.close()
})

test('run：重复收口 409（不许两条收据）；running 不能当收口值', () => {
  const db = freshDb()
  startRun(db, { runId: 'R1', project: PROJECT })
  finishRun(db, { runId: 'R1', state: 'completed' })
  assert.throws(() => finishRun(db, { runId: 'R1', state: 'aborted' }), ConflictError)
  startRun(db, { runId: 'R2', project: PROJECT })
  assert.throws(() => finishRun(db, { runId: 'R2', state: 'running' }), /不能用 running/)
  // blocked 不属于 run
  assert.throws(() => finishRun(db, { runId: 'R2', state: 'blocked' }), /blocked.*只属于 task\/release/)
  db.close()
})

test('run 收口时把名下 running 的 attempt 一起收口（不留孤儿）', () => {
  const db = freshDb()
  startRun(db, { runId: 'R1', project: PROJECT })
  startAttempt(db, { attemptId: 'A1', runId: 'R1', taskId: 'T1' })
  finishRun(db, { runId: 'R1', state: 'aborted', reason: 'budget' })
  const a = listAttempts(db, { runId: 'R1' })[0]
  assert.equal(a.state, 'aborted')
  assert.match(a.reason, /run-aborted/)
  db.close()
})

test('attempt：blocked 被 schema 拒（文档点名的验收项）', () => {
  const db = freshDb()
  startRun(db, { runId: 'R1', project: PROJECT })
  startAttempt(db, { attemptId: 'A1', runId: 'R1', taskId: 'T1' })
  assert.throws(() => finishAttempt(db, { attemptId: 'A1', state: 'blocked' }), /blocked.*只属于 task\/release/)
  assert.throws(() => finishAttempt(db, { attemptId: 'A1', state: 'done' }), /不是 attempt 的合法值/)
  finishAttempt(db, { attemptId: 'A1', state: 'completed' })
  assert.throws(() => finishAttempt(db, { attemptId: 'A1', state: 'failed' }), ConflictError)
  db.close()
})

test('6 次编码预算：第 7 次被拒；judge 不计入', () => {
  const db = freshDb()
  startRun(db, { runId: 'R1', project: PROJECT })
  for (let i = 1; i <= CODING_BUDGET; i++) {
    startAttempt(db, { attemptId: `A${i}`, runId: 'R1', taskId: 'T1', attemptKind: 'initial' })
  }
  assert.equal(budgetUsed(db, { runId: 'R1', taskId: 'T1' }), CODING_BUDGET)
  assert.throws(
    () => startAttempt(db, { attemptId: 'A7', runId: 'R1', taskId: 'T1' }),
    /6 次编码调用已用完/
  )
  // judge 不吃预算
  startAttempt(db, { attemptId: 'J1', runId: 'R1', taskId: 'T1', attemptKind: 'judge' })
  assert.equal(budgetUsed(db, { runId: 'R1', taskId: 'T1' }), CODING_BUDGET)
  // 另一张卡有自己的预算
  startAttempt(db, { attemptId: 'B1', runId: 'R1', taskId: 'T2' })
  assert.equal(budgetUsed(db, { runId: 'R1', taskId: 'T2' }), 1)
  dump('budget', { used: budgetUsed(db, { runId: 'R1', taskId: 'T1' }), limit: CODING_BUDGET })
  db.close()
})

test('attempt 只能开工在 running 的 run 上', () => {
  const db = freshDb()
  startRun(db, { runId: 'R1', project: PROJECT })
  finishRun(db, { runId: 'R1', state: 'completed' })
  assert.throws(() => startAttempt(db, { attemptId: 'A1', runId: 'R1', taskId: 'T1' }), ConflictError)
  db.close()
})

test('halt：没原因的 halt 直接拒；证据不匹配不许销', () => {
  const db = freshDb()
  assert.throws(() => openHalt(db, { project: PROJECT, reason: '' }), /缺 reason/)
  const h = openHalt(db, { project: PROJECT, subject: 'T1', reason: 'ac-red', evidence: { cmd: 'node t.mjs' } })
  assert.equal(h.status, 'open')
  assert.throws(() => closeHalt(db, { haltId: h.haltId, by: 'x' }), ConflictError)
  assert.throws(() => closeHalt(db, { haltId: h.haltId, by: 'x', matched: false }), /保持 open/)
  const closed = closeHalt(db, { haltId: h.haltId, by: '门禁复核', matched: true, evidence: { gate: 'green' } })
  assert.equal(closed.status, 'closed')
  assert.equal(listHalts(db, { project: PROJECT, status: 'open' }).length, 0)
  dump('halt', closed)
  db.close()
})

test('rework 落库可回查（不再只在内存）', () => {
  const db = freshDb()
  startRun(db, { runId: 'R1', project: PROJECT })
  addRework(db, { project: PROJECT, taskId: 'T1', runId: 'R1', round: 1, reason: 'ac-red', evidence: { cmd: 'node t.js' } })
  addRework(db, { project: PROJECT, taskId: 'T1', runId: 'R1', round: 2, reason: 'ac-red' })
  const list = listReworks(db, { project: PROJECT, taskId: 'T1' })
  assert.equal(list.length, 2)
  assert.equal(list[0].round, 1)
  assert.deepEqual(list[0].evidence, { cmd: 'node t.js' })
  db.close()
})

test('ready：依赖没 done 就不算 ready；没依赖立刻可派', () => {
  const db = freshDb()
  upsertTask(db, { project: PROJECT, id: 'A' })
  upsertTask(db, { project: PROJECT, id: 'B', depends: ['A'] })
  let ready = readyTasks(db, { project: PROJECT }).map(t => t.id)
  assert.deepEqual(ready, ['A'])
  let a = getTask(db, PROJECT, 'A')
  a = setTaskStatus(db, { project: PROJECT, id: 'A', to: 'ready', expectedVersion: a.version })
  a = setTaskStatus(db, { project: PROJECT, id: 'A', to: 'doing', expectedVersion: a.version })
  // A 在跑（doing）⇒ 现在没有"能开工"的卡；B 还等 A done
  assert.deepEqual(readyTasks(db, { project: PROJECT }).map(t => t.id), [])
  a = setTaskStatus(db, { project: PROJECT, id: 'A', to: 'review', expectedVersion: a.version })
  a = setTaskStatus(db, { project: PROJECT, id: 'A', to: 'done', expectedVersion: a.version })
  assert.deepEqual(readyTasks(db, { project: PROJECT }).map(t => t.id), ['B'])
  db.close()
})

test('角色粘性：assignedRole 记下来，重试不再重选', () => {
  const db = freshDb()
  upsertTask(db, { project: PROJECT, id: 'T1', rolePool: ['coder-a', 'coder-b'] })
  const t = assignRole(db, { project: PROJECT, id: 'T1', role: 'coder-b' })
  assert.equal(t.assignedRole, 'coder-b')
  assert.deepEqual(t.rolePool, ['coder-a', 'coder-b'])
  db.close()
})

test('auditDb：done 却没有 attempt 收据 ⇒ 报问题（"不得显示完成"）', () => {
  const db = freshDb()
  upsertTask(db, { project: PROJECT, id: 'T1' })
  let t = getTask(db, PROJECT, 'T1')
  for (const to of ['ready', 'doing', 'review', 'done']) {
    t = setTaskStatus(db, { project: PROJECT, id: 'T1', to, expectedVersion: t.version })
  }
  const r = auditDb(db, { project: PROJECT })
  assert.equal(r.ok, false)
  assert.ok(r.problems.some(p => p.code === 'done-without-attempt'))
  // 补一条 completed attempt 之后就不再报
  startRun(db, { runId: 'R1', project: PROJECT })
  startAttempt(db, { attemptId: 'A1', runId: 'R1', taskId: 'T1' })
  finishAttempt(db, { attemptId: 'A1', state: 'completed' })
  const r2 = auditDb(db, { project: PROJECT })
  assert.equal(r2.ok, true, JSON.stringify(r2.problems))
  dump('audit', r)
  db.close()
})

test('pidAlive：自己活着、假 pid 死', () => {
  assert.equal(pidAlive(process.pid), true)
  assert.equal(pidAlive(999999), false)
  assert.equal(pidAlive(null), null)
})

test('持久化：关库再开，数据还在（SQLite 单文件）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-db-'))
  const p = join(dir, 'crew.db')
  try {
    const db1 = openDb({ dbPath: p })
    upsertTask(db1, { project: PROJECT, id: 'T1', goal: '持久化' })
    logEvent(db1, { project: PROJECT, kind: 'note', payload: { z: 1 } })
    db1.close()
    const db2 = openDb({ dbPath: p })
    assert.equal(getTask(db2, PROJECT, 'T1').goal, '持久化')
    assert.ok(listEvents(db2, { project: PROJECT }).length >= 1)
    db2.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('心跳与进度：只有 running 的 run 能改', () => {
  const db = freshDb()
  startRun(db, { runId: 'R1', project: PROJECT })
  assert.equal(heartbeat(db, { runId: 'R1' }), true)
  const r = updateRunProgress(db, { runId: 'R1', inflight: ['T1'], results: [{ taskId: 'T0', verdict: 'ac-green' }] })
  assert.deepEqual(r.inflight, ['T1'])
  assert.equal(r.results.length, 1)
  finishRun(db, { runId: 'R1', state: 'completed' })
  assert.throws(() => heartbeat(db, { runId: 'R1' }), ConflictError)
  assert.throws(() => updateRunProgress(db, { runId: 'R1', inflight: [] }), ConflictError)
  db.close()
})

test('listRuns 能按 state 过滤（看护/看板要用）', () => {
  const db = freshDb()
  startRun(db, { runId: 'R1', project: PROJECT })
  startRun(db, { runId: 'R2', project: PROJECT })
  finishRun(db, { runId: 'R2', state: 'aborted', reason: 'x' })
  assert.equal(listRuns(db, { project: PROJECT, state: 'running' }).length, 1)
  assert.equal(listRuns(db, { project: PROJECT, state: 'aborted' }).length, 1)
  assert.equal(listRuns(db).length, 2)
  db.close()
})

test('任务列表按波次+ID 排序稳定（生成视图要字节稳定）', () => {
  const db = freshDb()
  upsertTask(db, { project: PROJECT, id: 'T2', wave: 'W2' })
  upsertTask(db, { project: PROJECT, id: 'T1', wave: 'W1' })
  upsertTask(db, { project: PROJECT, id: 'T3', wave: 'W1' })
  assert.deepEqual(listTasks(db, { project: PROJECT }).map(t => t.id), ['T1', 'T3', 'T2'])
  db.close()
})
