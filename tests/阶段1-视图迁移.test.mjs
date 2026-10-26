/**
 * 阶段 1 · TASKS.md 成为生成视图 + 旧状态迁移（§三）
 *
 * 覆盖：
 *   · 渲染器确定性、带 `generatedFrom`/`snapshotId`；
 *   · 手改视图必须被抓住（不许"看着像就对"）；
 *   · `台账.mjs` 走库后 TASKS.md 是投影（真实跑一遍 CLI）；
 *   · 迁移：备份、任务数相等、缺收据标 legacy-unknown（⛔ 不补造 completed）、幂等。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startService, UNATTENDED } from './_服务夹具.mjs'
import { fixture, cleanup, dump } from './_助手.mjs'
import { renderTasksView, compareView, extractMachine, formatLine } from '../_unattended/_台账视图.mjs'
import { StateClient } from '../_unattended/_状态客户端.mjs'
import { generateView, checkView, syncTasksToState, readStateTasks } from '../_unattended/_TASKS生成.mjs'
import { migrateProject, parseLegacyTasks, backupLegacy } from '../_unattended/_迁移状态.mjs'

const stripTime = (s) => s.replace(/"at":"[^"]*"/g, '').replace(/"atIso":"[^"]*"/g, '')

const TPL = `# 任务台账

## 任务

## 波次汇总

- 汇总占位
`

const TASKS = [
  { id: 'T1', status: 'done', wave: 'W1', role: 'coder-a', level: 'L2', goal: '做登录', depends: [], deliverables: ['src/a.js'], accept: ['node t1.mjs'] },
  { id: 'T2', status: 'doing', wave: 'W1', role: 'coder-b', level: null, goal: '做注册', depends: ['T1'], deliverables: ['src/b.js'], accept: [] }
]

test('渲染器：同样的输入出同样的字节（视图要能 diff）', () => {
  const a = renderTasksView({ tasks: TASKS, prevText: TPL, name: 'demo', template: TPL })
  const b = renderTasksView({ tasks: TASKS, prevText: TPL, name: 'demo', template: TPL })
  // 机器区段带 at（时间会变），其余字节必须一致
  assert.equal(a.prose, b.prose)
  assert.equal(stripTime(a.block), stripTime(b.block))
  assert.ok(a.full.includes('- [x] T1 · W1 · coder-a · 级:L2 · 做登录 · 依赖:无 · 交付:src/a.js · 验收:node t1.mjs'))
  assert.ok(a.full.includes('- [>] T2 · W1 · coder-b · 做注册 · 依赖:T1 · 交付:src/b.js · 验收:无'))
  dump('render-prose', a.prose)
})

test('机器区段：带 generatedFrom（缺了视为 stale）+ 认不出的行原样保留', () => {
  const r = renderTasksView({ tasks: TASKS, prevText: TPL, name: 'demo', template: TPL })
  const m = extractMachine(r.full)
  assert.equal(m.ok, true)
  assert.equal(m.data.kind, 'tasks')
  assert.equal(m.data.generatedFrom, '_crew/state/crew.db')
  assert.equal(m.data.tasks.T1.state, 'done')
  // 手写的、机器认不出的行要进"未识别"区而不是被删
  const withJunk = r.prose.replace('## 波次汇总', '这是我自己写的一句话\n另一句\n\n## 波次汇总')
  const r2 = renderTasksView({ tasks: TASKS, prevText: withJunk, name: 'demo', template: TPL })
  assert.match(r2.prose, /未识别/)
  assert.match(r2.prose, /这是我自己写的一句话/)
  // 幂等：再渲染一次不会越写越多
  const r3 = renderTasksView({ tasks: TASKS, prevText: r2.prose, name: 'demo', template: TPL })
  assert.equal((r3.prose.match(/这是我自己写的一句话/g) ?? []).length, 1)
})

test('对照：视图与库一致才 ok；手改状态行/改正文都要报出来', () => {
  const r = renderTasksView({ tasks: TASKS, prevText: TPL, name: 'demo', template: TPL })
  const dbTasks = TASKS.map(t => ({ ...t, writes: null, resources: [], rolePool: [], assignedRole: null }))
  assert.equal(compareView(r.full, dbTasks, { project: 'demo' }).ok, true)

  // ① 手改状态标记
  const edited = r.full.replace('- [x] T1', '- [ ] T1')
  const bad1 = compareView(edited, dbTasks, { project: 'demo' })
  assert.equal(bad1.ok, false)

  // ② 改正文（srcHash 对不上）
  const bad2 = compareView(r.full.replace('## 任务', '## 任务（我加的几个字）'), dbTasks, { project: 'demo' })
  assert.equal(bad2.ok, false)
  assert.match(bad2.reason, /手改|不一致/)

  // ③ 库里有卡、视图没有
  const bad3 = compareView(r.full, [...dbTasks, { ...TASKS[0], id: 'T9', status: 'pending' }], { project: 'demo' })
  assert.ok(bad3.mismatches.some(m => m.id === 'T9' && m.field === 'missing-in-view'))
  dump('view-compare', { ok: compareView(r.full, dbTasks, { project: 'demo' }), handEdit: bad1.reason ?? 'mismatch', proseEdit: bad2.reason })
})

test('服务在：generateView 落盘 → checkView 绿；改了库不重生成 → checkView 红', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  const dir = fixture({ 'TASKS.md': TPL })
  const project = dir
  try {
    // 先把任务写进库（模拟迁移完成后的常态）
    for (const t of TASKS) {
      await c.upsertTask({ project, id: t.id, wave: t.wave, role: t.role, level: t.level, goal: t.goal, deliverables: t.deliverables, depends: t.depends, accept: t.accept, status: 'pending' })
    }
    await generateView({ project, client: c, quiet: true })
    const ok1 = await checkView({ project, client: c })
    assert.equal(ok1.ok, true, ok1.reason ?? '')

    // 改库不改视图 ⇒ 不一致
    const t2 = await c.task(project, 'T2')
    await c.setTaskStatus({ project, id: 'T2', to: 'ready', expectedVersion: t2.version })
    const ok2 = await checkView({ project, client: c })
    assert.equal(ok2.ok, false)
    assert.ok(ok2.mismatches.some(m => m.id === 'T2' && m.field === 'status'))
    dump('view-from-service', { firstCheck: ok1.ok, afterDbChange: ok2.mismatches })
  } finally { await svc.stop(); cleanup(dir) }
})

test('台账.mjs 真实跑一遍：add 之后 TASKS.md 是投影，库里有卡', async () => {
  const svc = await startService()
  const dir = fixture({})
  const env = { ...process.env, DSH_CREW_STATE_PORT: String(svc.port) }
  const run = (...args) => spawnSync(process.execPath, [join(UNATTENDED, '台账.mjs'), ...args, '--project', dir], { encoding: 'utf8', env, timeout: 30000 })
  try {
    const init = run('init')
    assert.equal(init.status, 0, `init 失败：${init.stdout}\n${init.stderr}`)
    const add = run('add', '--id', 'T1', '--wave', 'W1', '--role', 'coder-a', '--goal', '做登录', '--deliverables', 'src/a.js', '--accept', 'node t.mjs')
    assert.equal(add.status, 0, `add 失败：${add.stdout}\n${add.stderr}`)
    const text = readFileSync(join(dir, 'TASKS.md'), 'utf8')
    assert.match(text, /- \[ \] T1 · W1 · coder-a · 做登录/)
    const m = extractMachine(text)
    assert.equal(m.ok, true)
    assert.equal(m.data.generatedFrom, '_crew/state/crew.db')
    assert.equal(m.data.tasks.T1.state, 'pending')

    const c = new StateClient({ port: svc.port })
    const inDb = await c.task(dir, 'T1')
    assert.equal(inDb.goal, '做登录')
    assert.deepEqual(inDb.deliverables, ['src/a.js'])

    const set = run('set', '--id', 'T1', '--status', 'ready')
    assert.equal(set.status, 0, `set 失败：${set.stdout}\n${set.stderr}`)
    const text2 = readFileSync(join(dir, 'TASKS.md'), 'utf8')
    assert.match(text2, /- \[r\] T1/)
    assert.equal((await c.task(dir, 'T1')).status, 'ready')
    dump('ledger-cli', { add: add.stdout.trim().split('\n').slice(-1)[0], set: set.stdout.trim().split('\n').slice(-1)[0], dbStatus: (await c.task(dir, 'T1')).status })
  } finally { await svc.stop(); cleanup(dir) }
})

test('迁移：备份齐全、任务数相等、旧收据按真实终态导入、残留 running 标 aborted', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  // 造一个"旧项目"：TASKS.md + 两份 verdict + 一个残留 running
  const tasksMd = renderTasksView({
    tasks: [
      { id: 'T1', status: 'done', wave: 'W1', role: 'coder-a', level: null, goal: 'g1', depends: [], deliverables: ['a.js'], accept: [] },
      { id: 'T2', status: 'pending', wave: 'W1', role: 'coder-a', level: null, goal: 'g2', depends: [], deliverables: ['b.js'], accept: [] }
    ],
    prevText: TPL, name: 'old', template: TPL
  }).full
  const dir = fixture({
    'TASKS.md': tasksMd,
    '_crew/runs/2026-10-01T00-00-00/verdict.json': { state: 'completed', reason: null, snapshotId: 'sha256:aaa', results: [] },
    '_crew/runs/2026-10-02T00-00-00/verdict.json': { results: [] }, // 没有 state ⇒ legacy-unknown
    '_crew/running/2026-10-03T00-00-00.json': { pid: 999999, project: 'old' },
    '_crew/ledger.json': { schema: 1, calls: [] }
  })
  try {
    const r = await migrateProject(dir, { client: c, backupTag: 'test-0001' })
    assert.equal(r.ok, true, JSON.stringify(r.errors))
    assert.equal(r.counts.tasksInFile, 2)
    assert.equal(r.counts.afterTasks, 2)
    assert.ok(r.backup && r.backup.copied.length >= 3, `备份项太少：${JSON.stringify(r.backup)}`)
    assert.ok(existsSync(join(r.backup.dir, 'TASKS.md')))

    const t1 = await c.task(dir, 'T1')
    assert.equal(t1.status, 'done')
    assert.equal(t1.legacy, true)

    const runs = await c.runs({ project: dir })
    const byId = Object.fromEntries(runs.map(x => [x.runId, x]))
    const name = dir.split(/[\\/]/).pop()
    const okRun = byId[`legacy-${name}-2026-10-01T00-00-00`]
    assert.equal(okRun.state, 'completed')
    const unkRun = byId[`legacy-${name}-2026-10-02T00-00-00`]
    assert.equal(unkRun.state, 'aborted', '缺 state 的旧收据绝不许补成 completed')
    assert.match(unkRun.reason, /legacy-unknown/)
    const staleRun = byId[`legacy-running-${name}-2026-10-03T00-00-00`]
    assert.equal(staleRun.state, 'aborted')
    assert.equal(staleRun.reason, 'legacy-stale-running')
    dump('migrate', { counts: r.counts, runs: runs.map(x => [x.runId, x.state, x.reason]) })
  } finally { await svc.stop(); cleanup(dir) }
})

test('迁移幂等：跑两遍不会造出重复卡/重复 run', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  const tasksMd = renderTasksView({
    tasks: [{ id: 'T1', status: 'ready', wave: 'W1', role: 'coder-a', level: null, goal: 'g', depends: [], deliverables: [], accept: [] }],
    prevText: TPL, name: 'old2', template: TPL
  }).full
  const dir = fixture({ 'TASKS.md': tasksMd, '_crew/runs/2026-10-01T00-00-00/verdict.json': { state: 'completed' } })
  try {
    const r1 = await migrateProject(dir, { client: c, backupTag: 'idem-1' })
    const tasks1 = (await c.tasks(dir)).length
    const runs1 = (await c.runs({ project: dir })).length
    const r2 = await migrateProject(dir, { client: c, backupTag: 'idem-2' })
    const tasks2 = (await c.tasks(dir)).length
    const runs2 = (await c.runs({ project: dir })).length
    assert.equal(r1.ok, true)
    assert.equal(r2.ok, true)
    assert.equal(tasks1, tasks2)
    assert.equal(runs1, runs2)
    dump('migrate-idempotent', { tasks: [tasks1, tasks2], runs: [runs1, runs2] })
  } finally { await svc.stop(); cleanup(dir) }
})

test('解析器：没有机器区段的老 TASKS.md 也能读（退到行正则）', () => {
  const old = `# 台账

## 任务

- [x] T1 · W1 · coder-a · 老卡 · 依赖:无 · 交付:a.js · 验收:node t1.mjs
- [ ] T2 · W1 · coder-b · 新卡 · 依赖:T1 · 交付:b.js · 验收:无
`
  const r = parseLegacyTasks(old)
  assert.equal(r.source, 'regex')
  assert.equal(r.tasks.length, 2)
  assert.equal(r.tasks[0].status, 'done')
  assert.equal(r.tasks[0].goal, '老卡')
  assert.deepEqual(r.tasks[0].accept, ['node t1.mjs'])
  assert.deepEqual(r.tasks[1].depends, ['T1'])

  const withMachine = renderTasksView({ tasks: TASKS, prevText: TPL, name: 'demo', template: TPL }).full
  const r2 = parseLegacyTasks(withMachine)
  assert.equal(r2.source, 'machine')
  assert.equal(r2.tasks.length, 2)
  assert.deepEqual(r2.tasks.find(t => t.id === 'T2').depends, ['T1'])
})

test('解析器：机器区段没有 goal/accept 时，从正文行补回来（迁移不能丢目标与验收命令）', () => {
  // 造一份"老机器区段"：只有 state/deps/deliverables，没有 goal/accept
  const prose = `# 台账

## 任务

- [>] T1 · W1 · coder-a · 写 src/T1.ts（桩） · 依赖:无 · 交付:src/T1.ts · 验收:文件生成且含 greet

## 波次汇总

- 占位
`
  const machine = { schema: 1, kind: 'tasks', project: 'x', at: '2026-10-01 00:00:00', srcHash: 'deadbeef', tasks: { T1: { state: 'doing', wave: 'W1', role: 'coder-a', level: null, deps: [], deliverables: ['src/T1.ts'] } }, unmatched: [], suspects: [] }
  const text = prose + '\n<!-- MACHINE\n' + JSON.stringify(machine) + '\n-->\n'
  const r = parseLegacyTasks(text)
  assert.equal(r.source, 'machine')
  assert.equal(r.tasks.length, 1)
  assert.equal(r.tasks[0].status, 'doing')          // 状态以机器区段为准
  assert.equal(r.tasks[0].goal, '写 src/T1.ts（桩）') // 目标从正文补
  assert.deepEqual(r.tasks[0].accept, ['文件生成且含 greet'])
  dump('parse-merge', r.tasks[0])
})

test('迁移：内容变了必须真更新（幂等键不能把"新内容"当成重放吞掉）', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  const dir = fixture({
    'TASKS.md': renderTasksView({
      tasks: [{ id: 'T1', status: 'ready', wave: 'W1', role: 'coder-a', level: null, goal: '老目标', depends: [], deliverables: ['a.js'], accept: ['跑老的'] }],
      prevText: TPL, name: 'old3', template: TPL
    }).full
  })
  try {
    await migrateProject(dir, { client: c, backupTag: 'k1' })
    assert.equal((await c.task(dir, 'T1')).goal, '老目标')
    // 改卡再迁一次：必须写进去，不能被上一次的幂等记录回放掉
    writeFileSync(join(dir, 'TASKS.md'), renderTasksView({
      tasks: [{ id: 'T1', status: 'ready', wave: 'W1', role: 'coder-a', level: null, goal: '新目标', depends: [], deliverables: ['a.js', 'b.js'], accept: ['跑新的'] }],
      prevText: TPL, name: 'old3', template: TPL
    }).full, 'utf8')
    const r = await migrateProject(dir, { client: c, backupTag: 'k2' })
    assert.equal(r.ok, true)
    const t = await c.task(dir, 'T1')
    assert.equal(t.goal, '新目标', '幂等键把新内容吞掉了')
    assert.deepEqual(t.accept, ['跑新的'])
    dump('migrate-content-key', { goal: t.goal, accept: t.accept })
  } finally { await svc.stop(); cleanup(dir) }
})

test('备份：三样东西都在（TASKS.md / running / ledger.json）', () => {
  const dir = fixture({
    'TASKS.md': '# x\n',
    '_crew/running/a.json': { pid: 1 },
    '_crew/ledger.json': { calls: [] }
  })
  try {
    const b = backupLegacy(dir, 'unit')
    const names = readdirSync(b.dir).sort()
    assert.ok(names.includes('TASKS.md'))
    assert.ok(names.some(n => n.includes('running')))
    assert.ok(names.some(n => n.includes('ledger.json')))
    dump('backup', { dir: b.dir, files: names })
  } finally { cleanup(dir) }
})
