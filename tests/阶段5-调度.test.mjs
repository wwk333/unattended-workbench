/**
 * 阶段 5 · 调度（§四 软写域 + DAG + wave 降级 + 角色池）
 *
 * 逐条对照文档验收表：
 *   A 写 src/a、B 写 src/b ⇒ 并行；C 也写 src/a ⇒ 与 A 串行
 *   A 写 `_crew/shots/T1/a.png`、B 写 `_crew/shots/T2/b.png` ⇒ 不冲突
 *   任务没有 writes ⇒ unknown-scope，仍可并行
 *   同组两卡碰同一文件 ⇒ 记冲突交审核
 *   同一载体两卡 ⇒ 并发不超过 maxConcurrent
 *   coder-a 两张、coder-b 空闲且同能力 ⇒ 自动分流
 *   W1 审核未完成、W2 独立任务就绪 ⇒ W2 可先跑（wave 不是屏障）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadPolicy, isSharedOutput, isHarmful, effectiveWrites, isDirLike, writesConflict,
  classifyOverreach, planSchedule, resourceNeeds, DEFAULT_POLICY
} from '../_unattended/_调度.mjs'
import { fixture, cleanup, dump } from './_助手.mjs'

const P = loadPolicy(null)

test('策略来自项目（gate.json#policy 优先），内核不硬编码', () => {
  const dir = fixture({
    'gate.json': JSON.stringify({ policy: { sharedOutputs: ['^build/'], harmful: ['^secret/'] } })
  })
  try {
    const own = loadPolicy(dir)
    assert.equal(own.source, 'gate.json#policy')
    assert.equal(isSharedOutput('build/x.js', own), true)
    assert.equal(isSharedOutput('_crew/logs/a.log', own), false, '项目覆盖后不再用默认清单')
    assert.equal(isHarmful('secret/k.txt', own), true)
  } finally { cleanup(dir) }
  const d2 = fixture({ '_crew/策略.json': JSON.stringify({ sharedOutputs: ['^out/'] }) })
  try {
    assert.equal(loadPolicy(d2).source, '_crew/策略.json')
  } finally { cleanup(d2) }
  assert.equal(loadPolicy(null).source, 'default(§四)')
})

test('共享产物/噪音 vs 有害越界：两条清单互不重叠', () => {
  assert.equal(isSharedOutput('_crew/gate/gate-result.json', P), true)
  assert.equal(isSharedOutput('_crew/shots/a.png', P), true)
  assert.equal(isSharedOutput('.obsidian/workspace.json', P), true)
  assert.equal(isSharedOutput('src/a.js', P), false)
  assert.equal(isHarmful('secrets/key.txt', P), true)
  assert.equal(isHarmful('.env.local', P), true)
  assert.equal(isHarmful('src/a.js', P), false)
  dump('policy', { source: P.source, shared: P.sharedOutputs.length, harmful: P.harmful.length })
})

test('目录级 vs 精确文件：目录级的共享产物不进冲突集，精确文件进', () => {
  assert.equal(isDirLike('_crew/shots/'), true)
  assert.equal(isDirLike('_crew/shots'), true)
  assert.equal(isDirLike('_crew/shots/T1/a.png'), false)
  assert.deepEqual(effectiveWrites({ writes: ['_crew/shots/', 'src/a.js'] }, P), ['src/a.js'])
  assert.deepEqual(effectiveWrites({ writes: ['_crew/shots/T1/a.png'] }, P), ['_crew/shots/T1/a.png'])
  assert.equal(effectiveWrites({ writes: null }, P), null)
  assert.deepEqual(effectiveWrites({ writes: [] }, P), [])
})

test('A 写 src/a、B 写 src/b ⇒ 不冲突；C 也写 src/a ⇒ 与 A 冲突', () => {
  const A = { id: 'A', writes: ['src/a.js'] }
  const B = { id: 'B', writes: ['src/b.js'] }
  const C = { id: 'C', writes: ['src/a.js'] }
  assert.equal(writesConflict(A, B, P).conflict, false)
  const ac = writesConflict(A, C, P)
  assert.equal(ac.conflict, true)
  assert.deepEqual(ac.files, ['src/a.js'])
})

test('未知写域不挡（软约束）：unknown 与任何卡都不判冲突', () => {
  const r = writesConflict({ writes: null }, { writes: ['src/a.js'] }, P)
  assert.equal(r.conflict, false)
  assert.equal(r.unknown, true)
})

test('`_crew/shots/T1/a.png` vs `_crew/shots/T2/b.png` ⇒ 不冲突（不同文件）', () => {
  const a = { id: 'A', writes: ['_crew/shots/T1/a.png'] }
  const b = { id: 'B', writes: ['_crew/shots/T2/b.png'] }
  assert.equal(writesConflict(a, b, P).conflict, false)
  // 但同一个截图文件仍然冲突（真会坏）
  assert.equal(writesConflict(a, { id: 'A2', writes: ['_crew/shots/T1/a.png'] }, P).conflict, true)
})

test('调度：同文件串行、不同文件并行、未知写域并行', () => {
  const tasks = [
    { id: 'A', status: 'ready', writes: ['src/a.js'] },
    { id: 'B', status: 'ready', writes: ['src/b.js'] },
    { id: 'C', status: 'ready', writes: ['src/a.js'] },
    { id: 'D', status: 'ready', writes: null }
  ]
  const r = planSchedule({ tasks, policy: P })
  const b1 = r.batches[0].tasks
  assert.ok(b1.includes('A') && b1.includes('B') && b1.includes('D'), `第一批应有 A/B/D，实际 ${JSON.stringify(b1)}`)
  assert.ok(!b1.includes('C'), 'C 与 A 同文件，必须排到后面')
  assert.ok(r.batches.slice(1).some(b => b.tasks.includes('C')))
  assert.deepEqual(r.stats.unknownScope, ['D'])
  dump('schedule-writes', { batches: r.batches.map(b => b.tasks), hotspot: r.stats.hotspotFiles })
})

test('DAG：依赖没完成的卡不排（不靠"等一等"）', () => {
  const r = planSchedule({
    tasks: [{ id: 'B', status: 'ready', depends: ['A'], writes: ['b.js'] }],
    doneIds: [],
    policy: P
  })
  assert.equal(r.queue.length, 0)
  assert.ok(r.skipped.some(s => s.id === 'B' && /依赖未完成/.test(s.why)))
  const r2 = planSchedule({ tasks: [{ id: 'B', status: 'ready', depends: ['A'], writes: ['b.js'] }], doneIds: ['A'], policy: P })
  assert.deepEqual(r2.queue, ['B'])
})

test('wave 只是标签：W1 在 review、W2 独立任务照样先跑', () => {
  const tasks = [
    { id: 'W1-A', wave: 'W1', status: 'review', writes: ['x.js'] },
    { id: 'W2-B', wave: 'W2', status: 'ready', writes: ['y.js'] }
  ]
  const r = planSchedule({ tasks, policy: P })
  assert.deepEqual(r.queue, ['W2-B'], 'W2 不该等 W1 的 review（wave 不是全局屏障）')
  assert.ok(r.skipped.some(s => s.id === 'W1-A'))
})

test('同一载体：并发不超过 maxConcurrent（roleCarrier 映射）', () => {
  const tasks = [
    { id: 'A', status: 'ready', role: 'coder-a', writes: ['a.js'] },
    { id: 'B', status: 'ready', role: 'coder-b', writes: ['b.js'] }
  ]
  const same = planSchedule({ tasks, policy: P, roleCarrier: { 'coder-a': 'pi', 'coder-b': 'pi' } })
  const firstBatch = same.batches[0].tasks
  assert.equal(firstBatch.length, 1, `同载体只能 1 张，实际 ${JSON.stringify(firstBatch)}`)
  assert.ok(same.batches.length >= 2)

  const diff = planSchedule({ tasks, policy: P, roleCarrier: { 'coder-a': 'pi', 'coder-b': 'opencode' } })
  assert.equal(diff.batches[0].tasks.length, 2, '不同载体可以并行')
  dump('carrier-limit', { same: same.batches.map(b => b.tasks), diff: diff.batches.map(b => b.tasks) })
})

test('角色池：coder-a 两张、coder-b 空闲且同能力 ⇒ 自动分流', () => {
  const tasks = [
    { id: 'A', status: 'ready', role: 'coder-a', rolePool: ['coder-a', 'coder-b'], writes: ['a.js'] },
    { id: 'B', status: 'ready', role: 'coder-a', rolePool: ['coder-a', 'coder-b'], writes: ['b.js'] }
  ]
  const r = planSchedule({ tasks, policy: P, roleAvailable: ['coder-a', 'coder-b'] })
  assert.equal(r.queue.length, 2)
  // 两张卡都进了可派队列；具体派给谁由 pickRole 在开工时定（池内空闲优先）
  assert.equal(r.batches[0].tasks.length, 2)
})

test('角色池里没可用角色 ⇒ 不排并说明原因', () => {
  const r = planSchedule({ tasks: [{ id: 'A', status: 'ready', role: 'coder-z', writes: ['a.js'] }], policy: P, roleAvailable: ['coder-a'] })
  assert.equal(r.queue.length, 0)
  assert.ok(r.skipped.some(s => /角色池/.test(s.why)))
})

test('共享资源：缺省独占（同 build 只能一张）', () => {
  const tasks = [
    { id: 'A', status: 'ready', resources: ['build'], writes: ['a.js'] },
    { id: 'B', status: 'ready', resources: ['build'], writes: ['b.js'] }
  ]
  const r = planSchedule({ tasks, policy: P })
  assert.equal(r.batches[0].tasks.length, 1)
  assert.equal(r.batches.length, 2)
  const wide = planSchedule({ tasks, policy: { ...P, resources: { build: 2 } } })
  assert.equal(wide.batches[0].tasks.length, 2)
  dump('resource-capacity', { exclusive: r.batches.map(b => b.tasks), shared: wide.batches.map(b => b.tasks) })
})

test('已在跑的任务占用的写域/载体也算进去', () => {
  const r = planSchedule({
    tasks: [{ id: 'B', status: 'ready', writes: ['src/a.js'], role: 'coder-a' }],
    running: [{ id: 'A', writes: ['src/a.js'], role: 'coder-a' }],
    policy: P,
    roleCarrier: { 'coder-a': 'pi' }
  })
  assert.equal(r.queue.length, 0, 'A 正在写同一个文件，B 必须等')
})

test('热点文件：被多张卡写的文件要统计出来（并行瓶颈）', () => {
  const tasks = ['A', 'B', 'C'].map(id => ({ id, status: 'ready', writes: ['src/hot.js', `src/${id}.js`] }))
  const r = planSchedule({ tasks, policy: P })
  const hot = r.stats.hotspotFiles.find(h => h.file === 'src/hot.js')
  assert.ok(hot, '热点文件没统计到')
  assert.equal(hot.tasks, 3)
})

test('越界归因：declared / noise / benign / harmful 四分类（不猜动机）', () => {
  const r = classifyOverreach({
    declaredWrites: ['src/a.js'],
    actual: ['src/a.js', 'src/neighbor.js', '_crew/shots/a.png', 'secrets/k.txt']
  }, P)
  assert.deepEqual(r.declared, ['src/a.js'])
  assert.deepEqual(r.benign, ['src/neighbor.js'])
  assert.deepEqual(r.noise, ['_crew/shots/a.png'])
  assert.deepEqual(r.harmful, ['secrets/k.txt'])
  assert.equal(r.unknownScope, false)
  const u = classifyOverreach({ declaredWrites: null, actual: ['src/x.js'] }, P)
  assert.equal(u.unknownScope, true)
  dump('overreach-classify', r)
})

test('资源需求：非数组当空；数组原样', () => {
  assert.deepEqual(resourceNeeds({ resources: ['build', 'port:3000'] }), ['build', 'port:3000'])
  assert.deepEqual(resourceNeeds({}), [])
  assert.deepEqual(resourceNeeds(null), [])
})

test('空批次不许出现（看板不该有"0 张卡的一波"）', () => {
  const r = planSchedule({ tasks: [{ id: 'A', status: 'ready', writes: [] }], policy: P })
  for (const b of r.batches) assert.ok(b.tasks.length > 0)
})

test('策略可覆盖资源容量（项目说了算）', () => {
  assert.deepEqual({ ...DEFAULT_POLICY.resources }, {})
  const dir = fixture({ 'gate.json': JSON.stringify({ policy: { resources: { build: 3 } } }) })
  try {
    assert.equal(loadPolicy(dir).resources.build, 3)
  } finally { cleanup(dir) }
})
