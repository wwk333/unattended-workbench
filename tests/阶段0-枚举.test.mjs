/**
 * 阶段 0 · 四套状态枚举（§零.2）
 * 正向：每层的合法值都能过；
 * 负向：跨层复用、blocked 写进 run/attempt、unknown 当状态 —— 全部必须抛。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ENUMS, BLOCKED_OWNERS, TRANSITIONS, UNKNOWN,
  assertState, isValidState, canTransition, assertTransition,
  isTerminal, completionWord, StateError
} from '../_unattended/契约/枚举.mjs'
import { dump } from './_助手.mjs'

test('四套枚举正好是文档那四套，一个不多一个不少', () => {
  assert.deepEqual(Object.keys(ENUMS).sort(), ['attempt', 'release', 'run', 'task'])
  assert.deepEqual([...ENUMS.task], ['pending', 'ready', 'doing', 'review', 'done', 'blocked', 'dropped'])
  assert.deepEqual([...ENUMS.run], ['running', 'completed', 'aborted', 'failed'])
  assert.deepEqual([...ENUMS.attempt], ['running', 'completed', 'failed', 'aborted'])
  assert.deepEqual([...ENUMS.release], ['blocked', 'ready', 'accepted', 'rejected', 'stale'])
  dump('enums', ENUMS)
})

test('每层的每个合法值都能 assertState 通过', () => {
  for (const [kind, list] of Object.entries(ENUMS)) {
    for (const v of list) assert.equal(assertState(kind, v), v, `${kind}=${v} 应合法`)
  }
})

test('负向：把别的层的枚举值抄过来必须抛（跨层复用禁止）', () => {
  const cases = [
    ['run', 'done'],           // done 只属 task
    ['run', 'blocked'],        // blocked 只属 task/release
    ['attempt', 'blocked'],    // 文档点名的验收项
    ['attempt', 'done'],
    ['attempt', 'running-done'],
    ['release', 'completed'],  // completed 只属 run/attempt
    ['release', 'done'],
    ['task', 'accepted'],      // accepted 只属 release
    ['task', 'completed'],
    ['task', 'stale']
  ]
  for (const [kind, v] of cases) {
    assert.throws(() => assertState(kind, v), StateError, `${kind}=${v} 应被拒绝`)
  }
  dump('cross-layer-rejects', cases.map(([k, v]) => `${k}=${v}`))
})

test('负向：unknown 是观测值不是状态值；不认识的层也拒绝', () => {
  assert.throws(() => assertState('task', UNKNOWN), /unknown.*不是状态值/)
  assert.throws(() => assertState('阶段', 'ready'), /不认识的层/)
  assert.equal(isValidState('task', UNKNOWN), false)
  assert.equal(isValidState('nope', 'ready'), false)
})

test('blocked 只归 task/release —— 这条是 schema 级硬约束', () => {
  assert.deepEqual([...BLOCKED_OWNERS], ['task', 'release'])
  assert.ok(isValidState('task', 'blocked'))
  assert.ok(isValidState('release', 'blocked'))
  assert.ok(!isValidState('run', 'blocked'))
  assert.ok(!isValidState('attempt', 'blocked'))
})

test('doing 残留自愈：doing → pending 必须有边（§三）', () => {
  assert.ok(canTransition('task', 'doing', 'pending'))
  assert.equal(assertTransition('task', 'doing', 'pending'), 'pending')
})

test('正常主链 pending→ready→doing→review→done 全通', () => {
  const chain = ['pending', 'ready', 'doing', 'review', 'done']
  for (let i = 0; i < chain.length - 1; i++) assert.ok(canTransition('task', chain[i], chain[i + 1]), `${chain[i]}→${chain[i + 1]}`)
})

test('负向：跨层跳步与终态出边必须拒绝', () => {
  const bad = [
    ['task', 'pending', 'done'],
    ['task', 'ready', 'review'],
    ['task', 'done', 'doing'],
    ['task', 'dropped', 'doing'],
    ['run', 'running', 'stale'],
    ['run', 'completed', 'failed'],
    ['attempt', 'failed', 'completed'],
    ['release', 'accepted', 'accepted'],
    ['release', 'blocked', 'accepted'],
    ['release', 'stale', 'accepted']
  ]
  for (const [kind, from, to] of bad) {
    assert.equal(canTransition(kind, from, to), false, `${kind} ${from}→${to} 不该合法`)
    assert.throws(() => assertTransition(kind, from, to), StateError)
  }
  // 同值迁移也不是状态变更
  assert.throws(() => assertTransition('task', 'doing', 'doing'), /同值迁移/)
  dump('illegal-transitions', bad.map(x => x.join(' ')))
})

test('release 没有真终态：accepted 之后代码变了要能 stale', () => {
  assert.equal(isTerminal('release', 'accepted'), false)
  assert.ok(canTransition('release', 'accepted', 'stale'))
  assert.equal(isTerminal('task', 'done'), true)
  assert.equal(isTerminal('task', 'review'), false)
  assert.equal(isTerminal('run', 'aborted'), true)
  assert.equal(isTerminal('attempt', 'failed'), true)
})

test('done / completed / accepted 三个词不许混着念', () => {
  assert.match(completionWord('task', 'done'), /done/)
  assert.match(completionWord('attempt', 'completed'), /completed/)
  assert.match(completionWord('release', 'accepted'), /accepted/)
  assert.notEqual(completionWord('task', 'done'), completionWord('release', 'accepted'))
})

test('迁移表里出现的每个目标值都必须在该层枚举内（防手写错字）', () => {
  for (const [kind, table] of Object.entries(TRANSITIONS)) {
    for (const [from, tos] of Object.entries(table)) {
      assert.ok(ENUMS[kind].includes(from), `${kind} 迁移表出现非法起点 ${from}`)
      for (const to of tos) assert.ok(ENUMS[kind].includes(to), `${kind} 迁移表出现非法终点 ${from}→${to}`)
    }
  }
})
