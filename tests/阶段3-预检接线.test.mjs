/**
 * 阶段 3（补）· DEVIATIONS D-11 第一步：把派活内核的 `preflight` **真正接进发卡路径**
 *
 * 之前内核的 25 个导出只被 tests 引用、`派活.mjs` 一行都没 import —— "建好了没人用"。
 * 这一步只接 `preflight`，查的是库里能确定的事实：**未销 halt + 本卡编码预算**。
 *
 * 这里**跑真脚本**（用临时库，`DSH_STATE_DB` 指过去，不碰生产库），验三条：
 *   ① 有未销 halt ⇒ exit 9 + `halt-open` ② 预算用光 ⇒ exit 9 + `budget-exhausted` ③ 干净 ⇒ 放行
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDb, migrate, upsertTask, openHalt, startRun, startAttempt, finishAttempt } from '../_unattended/_状态库.mjs'
import { UNATTENDED } from './_服务夹具.mjs'
import { WORKSPACE } from '../_unattended/_路径.mjs'
import { dump } from './_助手.mjs'

const NODE = process.execPath
const DISPATCH = join(UNATTENDED, '派活.mjs')
// ★W2：**不再写死工作台的绝对路径** —— 从工作台根算，包里也能跑
const PROJECT = join(WORKSPACE, 'workspaces', '_演练8').replace(/\\/g, '/')
const OUT = join(tmpdir(), 'crew-d11-tasks')

/**
 * ★W2（D22 · 测试必须自带夹具）：以前这里靠"本机恰好有 `_crew\agents.json`"，
 *   于是包一解开就 4 条红。改成**自己写一份最小配置**，用 `DSH_AGENTS_CONFIG` 指过去。
 *   最小到什么程度：够 `resolveRole` 认出 5 个角色即可（预检路径不启动任何载体）。
 */
const CFG = join(tmpdir(), `crew-d11-agents-${process.pid}.json`)
const ROLES = ['coder-a', 'coder-b', 'reviewer', 'researcher', 'rescue']
writeFileSync(CFG, JSON.stringify({
  _说明: '测试夹具：只够解析角色，不代表真实班组',
  agents: { pi: { kind: 'generic', node: '${NODE}', entry: '${AGENTS}\\__fixture__.mjs', printArgs: ['-p'], modelFlag: '--model' } },
  roles: Object.fromEntries(ROLES.map(r => [r, { agent: 'pi', prefer: { model: 'fixture/model' } }])),
  modelSource: {},
  levels: {}
}), 'utf8')

function dispatch (dbFile) {
  const r = spawnSync(NODE, [DISPATCH, '--task', 'T1', '--project', PROJECT, '--goal', 'D-11 预检', '--out', OUT], {
    encoding: 'utf8', env: { ...process.env, DSH_STATE_DB: dbFile, DSH_AGENTS_CONFIG: CFG }, timeout: 120000, windowsHide: true, maxBuffer: 16 << 20
  })
  return { code: r.status ?? -1, out: String(r.stdout ?? ''), err: String(r.stderr ?? '') }
}

function freshDb () {
  const dir = mkdtempSync(join(tmpdir(), 'crew-d11-'))
  const file = join(dir, 'crew.db')
  const db = openDb({ dbPath: file })
  migrate(db)
  upsertTask(db, { project: PROJECT, id: 'T1', wave: 'W1', role: 'coder-a', goal: 'g' })
  return { db, file, dir, done: () => { try { db.close() } catch {} try { rmSync(dir, { recursive: true, force: true }) } catch {} } }
}

test('派活.mjs 真的 import 了内核（不再是"建好没人用"）', () => {
  const src = readFileSync(DISPATCH, 'utf8')
  assert.match(src, /import \{ preflight \} from '\.\/_派活内核\.mjs'/)
  assert.match(src, /D11-PREFLIGHT/)
  assert.match(src, /if \(!PREFLIGHT\.ok\)/)
  assert.match(src, /process\.exit\(9\)/)
})

test('有未销 halt ⇒ **拒绝出卡**（exit 9 + halt-open）', () => {
  const t = freshDb()
  try {
    openHalt(t.db, { project: PROJECT, subject: 'T1', reason: '演练：等人工裁决' })
    const r = dispatch(t.file)
    assert.equal(r.code, 9, `应 exit 9，实际 ${r.code}；stderr=${r.err.slice(-300)}`)
    assert.match(r.err, /预检不过（halt-open）/)
    assert.match(r.err, /拒绝出卡/)
    dump('preflight-halt', r.err.match(/预检不过.*/)?.[0])
  } finally { t.done() }
})

test('编码预算用光 ⇒ **拒绝出卡**（exit 9 + budget-exhausted）', () => {
  const t = freshDb()
  try {
    const runId = 'R-BUDGET'
    startRun(t.db, { runId, project: PROJECT })
    for (let i = 0; i < 6; i++) {
      const a = startAttempt(t.db, { attemptId: `A-${i}`, runId, project: PROJECT, taskId: 'T1', attemptKind: i === 0 ? 'initial' : 'retry', role: 'coder-a', carrier: 'pi' })
      finishAttempt(t.db, { attemptId: a.attemptId, state: 'failed', failure: { verdict: 'flaky' } })
    }
    const r = dispatch(t.file)
    assert.equal(r.code, 9)
    assert.match(r.err, /预检不过（budget-exhausted）/)
    dump('preflight-budget', r.err.match(/预检不过.*/)?.[0])
  } finally { t.done() }
})

test('干净的库 ⇒ 放行，并**说明查了哪几项**（不是静默通过）', () => {
  const t = freshDb()
  try {
    const r = dispatch(t.file)
    assert.equal(r.code, 0, r.err.slice(-300))
    assert.match(r.err, /预检通过/)
    assert.match(r.err, /halt\/budget/)
    assert.match(r.err, /编码预算 0\/6/)
  } finally { t.done() }
})

test('库里读不到 ⇒ 跳过预检但**明说跳过**（不让基础设施故障变成"检查通过"）', () => {
  const r = spawnSync(NODE, [DISPATCH, '--task', 'T1', '--project', PROJECT, '--goal', 'x', '--out', OUT], {
    encoding: 'utf8', env: { ...process.env, DSH_STATE_DB: join(tmpdir(), 'crew-nonexistent-dir', 'nope.db'), DSH_AGENTS_CONFIG: CFG }, timeout: 120000, windowsHide: true, maxBuffer: 16 << 20
  })
  assert.equal(r.status, 0, '找不到库不该拦住发卡（这是基础设施问题，不是卡的问题）')
  assert.match(String(r.stderr ?? ''), /预检跳过/)
  assert.match(String(r.stderr ?? ''), /不当成检查通过/)
})
