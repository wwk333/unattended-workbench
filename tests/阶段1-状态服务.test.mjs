/**
 * 阶段 1 · C 状态服务（HTTP 层）（§三）
 *
 * 覆盖文档「验收与待测试数据」表里服务相关的项：
 *   · 服务启动到 /health ready（目标 ≤2 秒，实测填）；
 *   · 状态写延迟（keep-alive 连续 1000 次，p95 目标 ≤5ms，实测填）；
 *   · 50 个并发客户端改不同任务，丢更新 0；
 *   · 同任务并发冲突：一个成功、一个 409，不能双写；
 *   · 服务强杀后自动复活 ≤5 秒；
 *   · 服务不可用 ⇒ fail-closed（客户端抛 StateUnavailable，不退回文件双写）；
 *   · 幂等键重放只落一次；
 *   · 重启后数据还在。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { startService, http, sleep, UNATTENDED } from './_服务夹具.mjs'
import { StateClient, StateUnavailable, StateRejected } from '../_unattended/_状态客户端.mjs'
import { validateEnvelope, envelopeGreen } from '../_unattended/契约/信封.mjs'
import { dump } from './_助手.mjs'

const PROJECT = 'X:/fixture/svc'

test('服务能起、/health 绿、响应带合规信封', async () => {
  const t0 = Date.now()
  const svc = await startService()
  try {
    const readyMs = Date.now() - t0
    const h = await http(svc.base, 'GET', '/health')
    assert.equal(h.status, 200)
    assert.equal(validateEnvelope(h.json).ok, true)
    assert.equal(h.json.ok, true)
    assert.equal(envelopeGreen(h.json), true)
    assert.equal(h.json.db.writeOk, true)
    assert.equal(h.json.pid, svc.pid)
    dump('health', { readyMs, body: h.json })
  } finally { await svc.stop() }
})

test('不认识的端点回 404 且照样带信封（消费方不用猜格式）', async () => {
  const svc = await startService()
  try {
    const r = await http(svc.base, 'GET', '/v1/nope')
    assert.equal(r.status, 404)
    assert.equal(validateEnvelope(r.json).ok, true)
    assert.equal(r.json.ok, false)
  } finally { await svc.stop() }
})

test('建卡 → 改状态（HTTP 全链路）', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  try {
    const t = await c.upsertTask({ project: PROJECT, id: 'T1', role: 'coder-a', goal: 'g', deliverables: ['a.js'] })
    assert.equal(t.status, 'pending')
    const r = await c.setTaskStatus({ project: PROJECT, id: 'T1', to: 'ready', expectedVersion: t.version, source: 'test' })
    assert.equal(r.status, 'ready')
    assert.equal(r.version, t.version + 1)
    const list = await c.tasks(PROJECT)
    assert.equal(list.length, 1)
  } finally { await svc.stop() }
})

test('同任务并发冲突：两个请求拿同一版本 ⇒ 一个 200、一个 409（不能双写）', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  try {
    const t = await c.upsertTask({ project: PROJECT, id: 'T1' })
    const body = (to) => ({ project: PROJECT, id: 'T1', to, expectedVersion: t.version })
    const [a, b] = await Promise.all([
      http(svc.base, 'POST', '/v1/tasks/T1/status', body('ready')),
      http(svc.base, 'POST', '/v1/tasks/T1/status', body('blocked'))
    ])
    const codes = [a.status, b.status].sort()
    assert.deepEqual(codes, [200, 409], `实际 ${JSON.stringify([a.status, b.status])}`)
    const final = await c.task(PROJECT, 'T1')
    assert.ok(['ready', 'blocked'].includes(final.status))
    dump('concurrent-same-task', { codes, final: final.status })
  } finally { await svc.stop() }
})

test('50 个并发客户端改**不同**任务：丢更新 0', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port, timeoutMs: 20000 })
  try {
    const N = 50
    const created = []
    for (let i = 1; i <= N; i++) created.push(await c.upsertTask({ project: PROJECT, id: `T${i}` }))
    const t0 = Date.now()
    const results = await Promise.all(created.map((t, i) =>
      http(svc.base, 'POST', `/v1/tasks/T${i + 1}/status`, { project: PROJECT, to: 'ready', expectedVersion: t.version })
    ))
    const elapsedMs = Date.now() - t0
    const bad = results.filter(r => r.status !== 200)
    assert.equal(bad.length, 0, `失败 ${bad.length} 个：${JSON.stringify(bad.slice(0, 2))}`)
    const list = await c.tasks(PROJECT)
    assert.equal(list.filter(t => t.status === 'ready').length, N, '有卡没被改到（丢更新）')
    dump('concurrent-50', { N, elapsedMs, allReady: true })
  } finally { await svc.stop() }
})

test('状态写延迟：keep-alive 连续 1000 次，p95 目标 ≤5ms（实测填）', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port, timeoutMs: 30000 })
  try {
    const N = 1000
    let t = await c.upsertTask({ project: PROJECT, id: 'T1' })
    // 用不停在两个终态之间往返的迁移：ready ⇄ pending（都合法），避免中途被终态卡住
    const samples = []
    const t0 = Date.now()
    for (let i = 0; i < N; i++) {
      const to = i % 4 === 3 ? 'pending' : (t.status === 'ready' ? 'pending' : 'ready')
      const s = process.hrtime.bigint()
      t = await c.setTaskStatus({ project: PROJECT, id: 'T1', to, expectedVersion: t.version, source: 'bench' })
      samples.push(Number(process.hrtime.bigint() - s) / 1e6)
    }
    const totalMs = Date.now() - t0
    samples.sort((a, b) => a - b)
    const p = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))]
    const stats = { n: N, totalMs, p50: +p(0.5).toFixed(3), p95: +p(0.95).toFixed(3), p99: +p(0.99).toFixed(3), max: +samples[samples.length - 1].toFixed(3) }
    dump('write-latency', stats)
    assert.equal(stats.n, N)
    // 目标值不达标要出声（不许"跑过就算"）
    assert.ok(stats.p95 <= 5, `p95=${stats.p95}ms 超过目标 5ms`)
  } finally { await svc.stop() }
})

test('幂等键：同一个 key 重放两次，只落一次，第二次回放同一结果', async () => {
  const svc = await startService()
  try {
    const key = 'idem-' + Date.now()
    const body = { project: PROJECT, id: 'T1', role: 'coder-a' }
    const a = await http(svc.base, 'POST', '/v1/tasks', body, { 'idempotency-key': key })
    const b = await http(svc.base, 'POST', '/v1/tasks', body, { 'idempotency-key': key })
    assert.equal(a.status, 200)
    assert.equal(b.status, 200)
    assert.deepEqual(b.json.data, a.json.data)
    const events = await http(svc.base, 'GET', `/v1/events?project=${encodeURIComponent(PROJECT)}`)
    const creates = events.json.data.events.filter(e => e.kind === 'task-create' && e.subject === 'T1')
    assert.equal(creates.length, 1, `task-create 事件出现了 ${creates.length} 次（说明重放又写了一遍）`)
  } finally { await svc.stop() }
})

test('业务错误：400/404/409 都带信封和错误码，客户端能分辨', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  try {
    await assert.rejects(() => c.task(PROJECT, 'NOPE'), (e) => e instanceof StateRejected && e.status === 404)
    const r = await http(svc.base, 'POST', '/v1/tasks/T1/status', { project: PROJECT, to: 'nonsense', expectedVersion: 1 })
    assert.equal(r.status, 400)
    assert.equal(r.json.error.code, 'E_STATE')
    dump('error-shapes', { notFound: 404, badState: 400 })
  } finally { await svc.stop() }
})

test('服务不可用 ⇒ fail-closed：客户端抛 StateUnavailable，不许退回文件双写', async () => {
  const svc = await startService()
  const port = svc.port
  await svc.stop()
  const c = new StateClient({ port, ensure: false, timeoutMs: 800 })
  await assert.rejects(() => c.requireReady(), (e) => {
    assert.ok(e instanceof StateUnavailable, `实际 ${e.name}`)
    assert.match(e.message, /fail-closed|不可用/)
    return true
  })
  await assert.rejects(() => c.tasks(PROJECT), (e) => e instanceof StateUnavailable)
  dump('fail-closed', { port, behaviour: 'StateUnavailable（不双写）' })
})

test('重启后数据还在（同一个库文件）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-restart-'))
  const dbPath = join(dir, 'crew.db')
  try {
    const first = await startService({ dbPath })
    const c1 = new StateClient({ port: first.port })
    await c1.upsertTask({ project: PROJECT, id: 'T1', goal: '重启也要在' })
    await first.stop()

    const second = await startService({ dbPath })
    const c2 = new StateClient({ port: second.port })
    try {
      const t = await c2.task(PROJECT, 'T1')
      assert.equal(t.goal, '重启也要在')
    } finally { await second.stop() }
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('服务强杀后自动复活 ≤5 秒（ensure 实测）', async () => {
  const svc = await startService()
  const port = svc.port
  const dbPath = svc.dbPath
  // 强杀（pkill -9 等价）
  svc.proc.kill('SIGKILL')
  await new Promise(r => { svc.proc.once('exit', r); setTimeout(r, 3000) })
  const dead = await http(`http://127.0.0.1:${port}`, 'GET', '/health').then(() => false).catch(() => true)
  assert.equal(dead, true, '杀了之后还活着？')

  const t0 = Date.now()
  const r = spawnSync(process.execPath, [join(UNATTENDED, '确保状态服务.mjs'), '--port', String(port), '--db', dbPath, '--no-register', '--wait', '8'], { encoding: 'utf8', timeout: 20000 })
  const elapsedMs = Date.now() - t0
  const after = await http(`http://127.0.0.1:${port}`, 'GET', '/health').catch(() => null)
  dump('kill-and-ensure', { ensureExit: r.status, elapsedMs, health: after?.json?.ok ?? null, out: (r.stdout ?? '').trim().split('\n').slice(-3) })
  assert.equal(r.status, 0, `ensure 失败：${r.stderr}`)
  assert.equal(after?.status, 200)
  assert.ok(elapsedMs <= 5000, `复活用了 ${elapsedMs}ms，超过目标 5 秒`)
  // 收尾：杀掉 ensure 拉起的那个
  const pid = after.json.pid
  try { process.kill(pid, 'SIGKILL') } catch {}
  try { svc.dir && (await svc.stop()) } catch {}
})

test('第二次启动同端口被占用 ⇒ 拒绝起第二个实例（同一库只能一个写者）', async () => {
  const svc = await startService()
  try {
    const r = spawnSync(process.execPath, [join(UNATTENDED, '_状态服务.mjs'), '--port', String(svc.port), '--db', svc.dbPath], { encoding: 'utf8', timeout: 15000 })
    assert.equal(r.status, 3, `期望 exit 3，实际 ${r.status}：${r.stdout}${r.stderr}`)
    assert.match(r.stderr + r.stdout, /已被占用|拒绝起第二个/)
  } finally { await svc.stop() }
})
