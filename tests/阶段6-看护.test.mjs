/**
 * 阶段 6 · 看护（§七）
 *
 * 一条循环 + 一个自愈器 + 一个唤醒入口 + 一个计划任务；四份健康文件各归各的写方。
 *
 * 这里能无副作用测的：自愈规则/退避/派活闸门、计划任务命令构造与自检解析、
 * 四份文件写方不重名（源码级断言）、两个死字段确实没了。
 * 真正"杀服务/杀循环/删计划任务"的演练放在 `阶段6-看护演练.test.mjs`（会动真实进程，但只动我们自己的）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  canHeal, healOnce, dispatchGate, appendLedger, readLedger,
  MAX_FAILS_PER_HOUR, BACKOFF_MIN, VERIFY_DELAY_MS
} from '../_unattended/自愈器.mjs'
import { buildCreateArgs, buildDeleteArgs, buildQueryArgs, parseQuery, taskCommand, TASK_NAME, selfCheck } from '../_unattended/计划任务.mjs'
import { UNATTENDED, startService } from './_服务夹具.mjs'
import { fixture, cleanup, dump } from './_助手.mjs'

// ---------------------------------------------------------------- 自愈规则

const ITEM = (over = {}) => ({ name: 'C 状态服务', expect: 'running', ensure: '确保状态服务.mjs', critical: true, status: 'dead', ...over })

test('自愈只拉起「expect:running + 有 ensure + dead」的项', () => {
  assert.equal(canHeal({ item: ITEM(), status: 'dead' }).allow, true)
  assert.equal(canHeal({ item: ITEM({ expect: 'stopped' }), status: 'dead' }).allow, false)
  assert.equal(canHeal({ item: ITEM({ ensure: null }), status: 'dead' }).allow, false)
  assert.equal(canHeal({ item: ITEM(), status: 'ok' }).allow, false)
})

test('孤儿/mismatch 只报告，绝不自动杀/拉', () => {
  for (const st of ['orphan', 'mismatch']) {
    const r = canHeal({ item: ITEM(), status: st })
    assert.equal(r.allow, false, `${st} 不该被拉起`)
    assert.match(r.why, st === 'orphan' ? /孤儿/ : /mismatch/)
  }
})

test('退避封顶：1 小时内失败 3 次 ⇒ 停止重试（防重启风暴）', () => {
  const now = Date.now()
  const mk = (n) => Array.from({ length: n }, (_, i) => ({ name: 'C 状态服务', ok: false, at: new Date(now - (i + 1) * 60_000).toISOString() }))
  assert.equal(canHeal({ item: ITEM(), status: 'dead', ledger: mk(2), now }).allow, true)
  const blocked = canHeal({ item: ITEM(), status: 'dead', ledger: mk(3), now })
  assert.equal(blocked.allow, false)
  assert.equal(blocked.failsLastHour, 3)
  assert.equal(MAX_FAILS_PER_HOUR, 3)
  assert.deepEqual([...BACKOFF_MIN], [5, 15, 30])
})

test('退避只看最近 1 小时：更早的失败不算', () => {
  const now = Date.now()
  const old = Array.from({ length: 5 }, (_, i) => ({ name: 'C 状态服务', ok: false, at: new Date(now - (i + 2) * 3_600_000).toISOString() }))
  assert.equal(canHeal({ item: ITEM(), status: 'dead', ledger: old, now }).allow, true)
})

test('成功的记录不算失败次数', () => {
  const now = Date.now()
  const ledger = [{ name: 'C 状态服务', ok: true, at: new Date(now - 60_000).toISOString() }]
  assert.equal(canHeal({ item: ITEM(), status: 'dead', ledger, now }).failsLastHour, 0)
})

test('healOnce：拉起成功 + 复查绿 ⇒ 记成功；拉起失败 ⇒ 记失败且不谎称绿', async () => {
  const okRun = await healOnce({
    items: [ITEM({ recheck: async () => ({ status: 'ok' }) })],
    ensure: async () => ({ ok: true, why: 'spawn ok' }),
    sleep: async () => {},
    ledger: []
  })
  assert.equal(okRun.attempts.length, 1)
  assert.equal(okRun.attempts[0].ok, true)
  assert.equal(okRun.ok, true)

  const badRun = await healOnce({
    items: [ITEM({ recheck: async () => ({ status: 'dead' }) })],
    ensure: async () => ({ ok: true }),
    sleep: async () => {},
    ledger: []
  })
  assert.equal(badRun.attempts[0].ok, false, '拉起后仍红就不许记绿')
  assert.match(badRun.attempts[0].why, /仍 dead/)
  assert.equal(VERIFY_DELAY_MS, 2000)

  const failed = await healOnce({ items: [ITEM()], ensure: async () => ({ ok: false, why: 'exit 1' }), sleep: async () => {}, ledger: [] })
  assert.equal(failed.attempts[0].ok, false)
  assert.match(failed.attempts[0].why, /exit 1/)
})

test('healOnce：dry-run 只判不动；每轮有上限防风暴', async () => {
  let called = 0
  const dry = await healOnce({ items: [ITEM()], ensure: async () => { called++; return { ok: true } }, dryRun: true, sleep: async () => {}, ledger: [] })
  assert.equal(called, 0, 'dry-run 不该真拉')
  assert.equal(dry.attempts[0].dryRun, true)

  const items = ['a', 'b', 'c', 'd', 'e'].map(n => ITEM({ name: n }))
  const capped = await healOnce({ items, ensure: async () => ({ ok: true }), sleep: async () => {}, ledger: [], maxPerCycle: 2 })
  assert.equal(capped.attempts.length, 2)
  assert.ok(capped.skipped.some(s => /本轮已达上限/.test(s.why)))
})

test('派活闸门：critical 不绿 ⇒ 停新派活（fail-closed）', () => {
  const okGate = dispatchGate([{ name: 'C 状态服务', critical: true, status: 'ok' }, { name: '看护循环', critical: false, status: 'dead' }])
  assert.equal(okGate.allowNewDispatch, true, '非 critical 死了只黄灯，不阻塞任务')
  const bad = dispatchGate([{ name: 'C 状态服务', critical: true, status: 'dead' }])
  assert.equal(bad.allowNewDispatch, false)
  assert.deepEqual(bad.criticalDown, ['C 状态服务'])
  assert.match(bad.why, /停新派活/)
})

test('自愈账本：一行一次尝试，可回读', () => {
  const dir = fixture({})
  try {
    const f = join(dir, '_crew', '自愈账本.jsonl')
    assert.equal(appendLedger({ name: 'X', ok: true }, f), true)
    assert.equal(appendLedger({ name: 'Y', ok: false, why: 'boom' }, f), true)
    const rows = readLedger(f)
    assert.equal(rows.length, 2)
    assert.equal(rows[0].source, '自愈器.mjs')
    assert.equal(rows[1].why, 'boom')
    assert.ok(rows[0].at)
  } finally { cleanup(dir) }
})

// ---------------------------------------------------------------- 计划任务

test('计划任务：名字、命令、参数都对（每 5 分钟、隐藏、已存在就覆盖）', () => {
  assert.equal(TASK_NAME, 'DSH-Crew-Supervisor')
  const args = buildCreateArgs({ node: 'NODE', ensureScript: 'D:/w/确保看守.mjs' })
  assert.deepEqual(args.slice(0, 2), ['/Create', '/TN'])
  assert.equal(args[2], TASK_NAME)
  assert.equal(args[3], '/TR')
  assert.match(args[4], /--ensure/)
  assert.equal(args[5], '/SC')
  assert.equal(args[6], 'MINUTE')
  assert.equal(args[7], '/MO')
  assert.equal(args[8], '5')
  assert.ok(args.includes('/F'), '必须幂等覆盖')
  assert.match(taskCommand({ node: 'NODE', ensureScript: 'S.mjs' }), /^"NODE" "S\.mjs" --ensure$/)
  assert.deepEqual(buildDeleteArgs(), ['/Delete', '/TN', TASK_NAME, '/F'])
  assert.deepEqual(buildQueryArgs(), ['/Query', '/TN', TASK_NAME])
})

test('计划任务自检：不存在 ⇒ 红灯（不假装绿）', () => {
  const s = selfCheck()
  assert.equal(s.kind, 'scheduler-check')
  assert.equal(s.name, TASK_NAME)
  assert.equal(s.state, s.exists ? 'ok' : 'red')
  assert.equal(s.stale, false)
  if (!s.exists) assert.match(s.why, /看护循环死了没人补/)
  dump('scheduler-check', s)
})

test('parseQuery 认得中文/英文两种输出', () => {
  assert.equal(parseQuery('任务名   DSH-Crew-Supervisor').exists, true)
  assert.equal(parseQuery('TaskName   DSH-Crew-Supervisor').exists, true)
  assert.equal(parseQuery('ERROR: 系统找不到指定的文件。').exists, false)
  assert.equal(parseQuery('cannot find the file').exists, false)
})

// ---------------------------------------------------------------- 四份健康文件各归各

test('源码级断言：四份健康文件只有一个写方，且没有同名双写', () => {
  const monitor = readFileSync(join(UNATTENDED, '_监控.mjs'), 'utf8')
  const progress = readFileSync(join(UNATTENDED, '进度看护.mjs'), 'utf8')
  const longlive = readFileSync(join(UNATTENDED, '长命资源巡检.mjs'), 'utf8')
  const wake = readFileSync(join(UNATTENDED, '_唤醒.mjs'), 'utf8')

  // ① `_监控` 写 卡片看护.json；**不再**写 看护状态.json（同名双写已删）
  assert.match(monitor, /卡片看护\.json/)
  assert.ok(!/this\.stateFile\s*=\s*join\([^)]*'看护状态\.json'\)/.test(monitor), '_监控 仍在写 看护状态.json（同名双写）')
  // ② `进度看护` 是 看护状态.json 的写方
  assert.match(progress, /看护状态\.json/)
  // ③ `长命资源巡检` 是 长命资源状态.json 的写方
  assert.match(longlive, /长命资源状态\.json/)
  // ④ `_唤醒` 写 唤醒状态.json
  assert.match(wake, /唤醒状态\.json/)
  dump('health-writers', { monitor: '卡片看护.json', progress: '看护状态.json', longlive: '长命资源状态.json', wake: '唤醒状态.json' })
})

test('死字段已删：closeMin、c.checked 永久缓存、进度看护自己的 wakeBrain', () => {
  const monitor = readFileSync(join(UNATTENDED, '_监控.mjs'), 'utf8')
  assert.ok(!/closeMin\s*:/.test(monitor), 'closeMin 应已从 DEFAULT_THRESHOLDS 删除')
  assert.ok(!/!\s*c\.checked\b/.test(monitor), 'c.checked 永久缓存应已删除')

  const progress = readFileSync(join(UNATTENDED, '进度看护.mjs'), 'utf8')
  // 允许保留一个**薄包装**（统一走 _唤醒），但**不许**再有自己读 token/挑会话的实现
  assert.ok(!/post\(\{\s*op:\s*'prompt'/.test(progress), '进度看护 仍在自己发唤醒（第二份实现）')
  assert.match(progress, /from '\.\/_唤醒\.mjs'/, '进度看护 必须用 _唤醒.mjs')
})

test('看护循环把巡检与自愈器都挂上（一条循环，不是四套）', () => {
  const loop = readFileSync(join(UNATTENDED, '看护循环.mjs'), 'utf8')
  assert.match(loop, /长命资源巡检\.mjs/)
  assert.match(loop, /自愈器\.mjs/)
  assert.match(loop, /进度看护\.mjs/)
})

// ---------------------------------------------------------------- 真实进程：C 服务被杀的复活路径

test('C 状态服务被强杀后：健康检查红 → 自愈器会判它 dead 且可拉起', async () => {
  const svc = await startService()
  const port = svc.port
  try {
    // 活着时：自愈器不该动它
    const before = await fetch(`http://127.0.0.1:${port}/health`).then(r => r.json())
    assert.equal(before.ok, true)
    assert.equal(canHeal({ item: ITEM(), status: 'ok' }).allow, false)

    // 杀掉
    svc.proc.kill('SIGKILL')
    await new Promise(r => { svc.proc.once('exit', r); setTimeout(r, 3000) })
    const dead = await fetch(`http://127.0.0.1:${port}/health`).then(() => false).catch(() => true)
    assert.equal(dead, true, '杀了还活着？')

    // 自愈器视角：dead 且 critical ⇒ 允许拉起；同时**停新派活**
    const gate = canHeal({ item: ITEM({ recheck: async () => ({ status: 'ok' }) }), status: 'dead' })
    assert.equal(gate.allow, true)
    const dg = dispatchGate([{ name: 'C 状态服务', critical: true, status: 'dead' }])
    assert.equal(dg.allowNewDispatch, false)
    dump('kill-critical-service', { dead: true, healAllowed: gate.allow, dispatchBlocked: !dg.allowNewDispatch })
  } finally { await svc.stop() }
})

// ---------------------------------------------------------------- 产物是否真在长（§七 grew）

test('grew：按近 10 分钟增量判，不再"曾经有字节就算有"', async () => {
  const { grewSince } = await import('../_unattended/_监控.mjs')
  const now = Date.now()
  const S = (arr) => arr.map(([d, s]) => ({ at: now - d, size: s }))

  const growing = grewSince(S([[9 * 60e3, 100], [5 * 60e3, 150], [0, 300]]), now)
  assert.equal(growing.grew, true)
  assert.equal(growing.delta, 200)

  const flat = grewSince(S([[9 * 60e3, 300], [0, 300]]), now)
  assert.equal(flat.grew, false, '字节没长就不许算"有产物"')
  assert.match(flat.why, /没长/)

  // 关键回归：旧判据 `lastSize > 0` 在这里会返回 true（文件有内容），新判据必须是 false
  const onlyOne = grewSince(S([[0, 300]]), now)
  assert.equal(onlyOne.grew, false)
  assert.match(onlyOne.why, /无法判断/)

  assert.equal(grewSince([], now, 600e3, 500).grew, false)
  assert.match(grewSince([], now, 600e3, 500).why, /还没有采样/)
  dump('grew-since', { growing: growing.delta, flat: flat.grew, one: onlyOne.grew })
})

test('grew：源码级确认旧判据已删（lastSize > 0 不许再出现）', () => {
  const src = readFileSync(join(UNATTENDED, '_监控.mjs'), 'utf8')
  assert.ok(!/const grew = \(c\.lastSize \?\? 0\) > 0/.test(src), '旧的"曾经有字节"判据还在')
  assert.match(src, /grewSince\(c\.sizeSamples/, '_scan 必须记采样点，机械三查按增量判')
  assert.match(src, /c\.sizeSamples = \(Array\.isArray\(c\.sizeSamples\)/)
})
