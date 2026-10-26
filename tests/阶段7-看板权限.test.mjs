/**
 * 阶段 7 · 看板三层权限（§十）
 *
 *  状态区：只读 —— 任何写都 403
 *  配置区：可写，但必须走配置网关，且每次留 `who/what/before/after/at` 审计
 *  操作区：可写，但必须走 C 服务命令，且进事件流
 *
 * 这里直接打 `权限闸.mjs`（服务端的唯一执行点），不需要起看板进程。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { guardWrite, recordConfigAudit, CONFIG_FILES, ACTION_OPS, AUDIT_LOG } from '../_unattended/面板/权限闸.mjs'
import { regionOfRoute, REGIONS } from '../_unattended/契约/权限.mjs'
import { taskSource } from '../_unattended/_看板任务源.mjs'
import { renderTasksView } from '../_unattended/_台账视图.mjs'
import { generateView } from '../_unattended/_TASKS生成.mjs'
import { StateClient } from '../_unattended/_状态客户端.mjs'
import { UNATTENDED, startService } from './_服务夹具.mjs'
import { fixture, cleanup, dump } from './_助手.mjs'

const fakeReq = ({ method = 'POST', origin = '', remote = '127.0.0.1', headers = {} } = {}) => ({
  method,
  headers: { origin, ...headers },
  socket: { remoteAddress: remote }
})
const fakeRes = () => {
  const handlers = {}
  return { once: (ev, fn) => { handlers[ev] = fn }, emit: (ev) => handlers[ev]?.() }
}

test('GET 一律放行（读不改变事实）', async () => {
  const r = await guardWrite({ req: fakeReq({ method: 'GET' }), pathname: '/board-data.json' })
  assert.equal(r.ok, true)
  assert.equal(r.readOnly, true)
})

test('状态区：任何写都 403，且说明原因（不是 200 假成功）', async () => {
  for (const route of ['/board-data.json', '/chain.json', '/health', '/longlive.json', '/carriers.json']) {
    const r = await guardWrite({ req: fakeReq(), pathname: route })
    assert.equal(r.ok, false, `${route} 不该允许写`)
    assert.equal(r.status, 403)
    assert.match(r.error, /状态区只读/)
  }
  dump('status-reject', ['/board-data.json', '/chain.json', '/health', '/longlive.json', '/carriers.json'])
})

test('配置区：放行，但**必须**留下 who/what/before/after/at 五段审计', async () => {
  const dir = fixture({ '调参/当前.json': JSON.stringify({ lamp: { yellow: 10 } }) }, 'panel-audit-')
  try {
    const log = join(dir, '配置审计.jsonl')
    // 用临时审计文件；CONFIG_FILES 指向真实工作台，before 会是 null（诚实，不编）
    const res = fakeRes()
    const r = await guardWrite({ req: fakeReq({ headers: { 'x-dsh-who': '测试员' } }), res, pathname: '/carriers-action', auditLog: log })
    assert.equal(r.ok, true)
    assert.equal(r.region, 'config')
    assert.equal(r.auditRequired, true)
    assert.ok(existsSync(log), '审计没落盘')
    const line = JSON.parse(readFileSync(log, 'utf8').trim().split('\n')[0])
    for (const k of ['who', 'what', 'before', 'after', 'at']) assert.ok(Object.hasOwn(line, k), `审计缺 ${k}`)
    assert.equal(line.who, '测试员')
    assert.equal(line.route, '/carriers-action')
    assert.equal(line.kind, 'config-audit')
    assert.equal(line.schema, 1)
    assert.equal(line.source, '面板/权限闸.mjs')
    dump('config-audit', line)
  } finally { cleanup(dir) }
})

test('配置区：写完之后补 after（finish 钩子）', async () => {
  const dir = fixture({})
  try {
    const log = join(dir, 'a.jsonl')
    const res = fakeRes()
    await guardWrite({ req: fakeReq(), res, pathname: '/rules-action', auditLog: log })
    res.emit('finish')
    const lines = readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l))
    assert.equal(lines.length, 2, '应有 before 与 after 两条')
    assert.match(lines[1].what, /after/)
    dump('config-audit-after', lines.map(l => l.what))
  } finally { cleanup(dir) }
})

test('审计：默认值算数，只有说不出"改了什么"才判 incomplete', () => {
  const dir = fixture({})
  try {
    const log = join(dir, 'a.jsonl')
    const ok = recordConfigAudit({ what: 'x', before: null, after: null }, log)
    assert.equal(ok.state, 'ok')
    assert.equal(ok.who, '面板用户') // 默认值
    assert.ok(ok.at)
    assert.match(String(ok.note ?? ''), /未提供/) // 如实说"调用方没给 who/at"

    const bad = recordConfigAudit({}, log)
    assert.equal(bad.state, 'incomplete')
    assert.equal(bad.what, '(未写)')
    // 落到纸上的那一行五段齐全（缺的用默认值/null 填，不许少字段）
    for (const k of ['who', 'what', 'before', 'after', 'at']) assert.ok(Object.hasOwn(bad, k), `缺 ${k}`)
    dump('audit-incomplete', bad)
  } finally { cleanup(dir) }
})

test('操作区：放行并把命令镜像进 C 服务事件流（C 服务在跑时）', async () => {
  const env = process.env.DSH_CREW_STATE_PORT
  try {
    process.env.DSH_CREW_STATE_PORT = process.env.DSH_CREW_STATE_PORT ?? '19460'
    const r = await guardWrite({ req: fakeReq(), pathname: '/brain-say', body: { text: '看板权限自检' } })
    assert.equal(r.ok, true)
    assert.equal(r.region, 'action')
    assert.equal(r.commandRequired, true)
    // C 服务在这台机器上是起着的 ⇒ 应当真拿到 event id；没起也不许"假装成功"
    if (r.command?.ok) assert.ok(r.command.id, '镜像成功却没回 event id')
    else assert.match(String(r.command?.why ?? ''), /不可达|HTTP|没登记/)
    dump('action-mirror', r.command)
  } finally {
    if (env === undefined) delete process.env.DSH_CREW_STATE_PORT
    else process.env.DSH_CREW_STATE_PORT = env
  }
})

test('操作区每个路由都必须登记 op（新加操作不能绕过）', () => {
  for (const route of ['/brain-say', '/brain-stop', '/frame-action', '/longlive-action', '/run']) {
    assert.ok(ACTION_OPS[route], `${route} 没登记 op`)
    assert.equal(regionOfRoute(route).id, 'action', `${route} 应属操作区`)
  }
  assert.equal(regionOfRoute('/run').id, 'action', '「跑一轮」是操作，不是状态区')
})

test('非本机来源一律 403（配置/操作都不例外）', async () => {
  for (const route of ['/carriers-action', '/brain-say']) {
    const r = await guardWrite({ req: fakeReq({ origin: 'http://evil.example.com' }), pathname: route })
    assert.equal(r.ok, false)
    assert.equal(r.status, 403)
    assert.match(r.error, /本机/)
  }
})

test('源码级断言：service.mjs 的写路由全部过权限闸，且旧 guardLocal 已删', () => {
  const svc = readFileSync(join(UNATTENDED, '面板', 'service.mjs'), 'utf8')
  assert.match(svc, /import \{ guardWrite, recordAfter \} from '\.\/权限闸\.mjs'/)
  assert.ok(!/function guardLocal/.test(svc), 'guardLocal 应已删除（它只验来源，不验区域）')
  assert.ok(!/guardLocal\(req, res\)/.test(svc), '还有路由在用旧守卫')
  const guards = (svc.match(/guardWrite\(\{ req, res, pathname \}\)/g) ?? []).length
  assert.ok(guards >= 10, `写路由过闸的数量太少：${guards}`)
  assert.match(svc, /function json403/)
  dump('service-guards', { guards })
})

test('三层权限的口径与文档一致', () => {
  assert.equal(REGIONS.status.permission, 'read-only')
  assert.equal(REGIONS.config.permission, 'write-via-gateway')
  assert.equal(REGIONS.action.permission, 'write-via-command')
  // 配置区覆盖"API 额度/职位模型/载体/profile/设置"
  for (const r of ['/api-keys', '/api-tune', '/carriers-action', '/rules-action', '/pin']) {
    assert.equal(regionOfRoute(r).id, 'config', `${r} 应属配置区`)
  }
})

// ---------------------------------------------------------------- 看板任务源：从 C 读，TASKS 只对照

test('任务从 C 状态库读（不是 TASKS.md）', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  const dir = fixture({ 'TASKS.md': renderTasksView({ tasks: [], prevText: '# t\n\n## 任务\n\n## 波次汇总\n', name: 'p', template: '# t\n\n## 任务\n\n## 波次汇总\n' }).full })
  try {
    await c.upsertTask({ project: dir, id: 'T1', wave: 'W1', role: 'coder-a', goal: 'g' })
    const t1 = await c.task(dir, 'T1')
    await c.setTaskStatus({ project: dir, id: 'T1', to: 'ready', expectedVersion: t1.version })
    const r = await taskSource({ project: dir, client: c })
    assert.equal(r.source, 'state-service')
    assert.equal(r.found, true)
    assert.equal(r.total, 1)
    assert.equal(r.tasks[0].status, 'ready')
    assert.equal(r.byStatus.ready, 1)
    assert.equal(r.stale, true, 'TASKS.md 里没有这张卡 ⇒ 视图过期')
    assert.match(r.staleWhy, /以库为准/)
    dump('task-source', { source: r.source, total: r.total, stale: r.stale, byStatus: r.byStatus })
  } finally { await svc.stop(); cleanup(dir) }
})

test('视图与库一致 ⇒ stale:false', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  const dir = fixture({})
  try {
    await c.upsertTask({ project: dir, id: 'T1', wave: 'W1', role: 'coder-a', goal: 'g' })
    await generateView({ project: dir, client: c, quiet: true })
    const r = await taskSource({ project: dir, client: c })
    assert.equal(r.stale, false, JSON.stringify(r.view.mismatches))
    assert.equal(r.view.found, true)
    assert.equal(r.view.mismatches.length, 0)
  } finally { await svc.stop(); cleanup(dir) }
})

test('C 服务不可用 ⇒ 任务区"读不到"，**绝不退回 TASKS.md**', async () => {
  const dir = fixture({ 'TASKS.md': renderTasksView({ tasks: [{ id: 'T1', status: 'doing', wave: 'W1', role: 'coder-a', level: null, goal: 'g', depends: [], deliverables: [], accept: [] }], prevText: '# t\n\n## 任务\n\n## 波次汇总\n', name: 'p', template: '# t\n\n## 任务\n\n## 波次汇总\n' }).full })
  try {
    const dead = new StateClient({ port: 1, ensure: false, timeoutMs: 300 })
    const r = await taskSource({ project: dir, client: dead })
    assert.equal(r.found, false)
    assert.equal(r.source, 'unavailable')
    assert.equal(r.stale, true)
    assert.equal(r.total, 0, '不许把 TASKS.md 的卡当成任务返回')
    assert.match(r.staleWhy, /不退回 TASKS\.md|不可用/)
    dump('task-source-unavailable', { source: r.source, stale: r.stale, why: r.staleWhy })
  } finally { cleanup(dir) }
})

test('源码级断言：看板数据从任务源读，不再自己解析 TASKS.md 标记', () => {
  const board = readFileSync(join(UNATTENDED, '看板数据.mjs'), 'utf8')
  assert.match(board, /from '\.\/_看板任务源\.mjs'/)
  assert.match(board, /await taskSource\(/)
  // 原来那段"读 TASKS.md 的 [x]>?"已删除
  assert.ok(!/map\(l => l\.match\(\/\^\\s\*-\\s\*\\\[\(\[ x>?!\]\)\\\]\/\)\)/.test(board), '看板仍在自己解析 TASKS.md 标记')
})

test('board-data 是缓存视图：必须带 schema/generatedAt/sources/stale', () => {
  const board = readFileSync(join(UNATTENDED, '看板数据.mjs'), 'utf8')
  for (const k of ['data.schema', 'data.generatedAt', 'data.sources', 'data.stale']) {
    assert.ok(board.includes(k), `board-data 缺 ${k}`)
  }
  assert.match(board, /data\.stale = data\.sources\.some/, 'stale 必须由各源汇总，不能硬编码 false')
})
