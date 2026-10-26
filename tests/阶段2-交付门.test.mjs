import { judgeReview } from '../_unattended/契约/审核.mjs'
/**
 * 阶段 2 · 交付门（§一）
 *
 * 覆盖文档「验收」表：
 *   · 改一个受管源码字节 ⇒ 从 ready 变 stale；
 *   · 审核报告写"打回"但机器块写 pass ⇒ 报冲突并阻断；
 *   · degraded:true ⇒ 阻断；
 *   · 只有 accepted 允许出现"已验收"；
 *   · 缺审核机器块 ⇒ 阻断。
 * 外加§二：缺 E2E / E2E 红 / 快照不一致 ⇒ blocked；状态服务不可用 ⇒ fail-closed。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { startService, UNATTENDED } from './_服务夹具.mjs'
import { fixture, cleanup, dump } from './_助手.mjs'
import { decide, projectHandoff, renderHandoffBlock, HANDOFF_BEGIN, HANDOFF_END, e2eOfGate } from '../_unattended/交付门.mjs'
import { computeSnapshot } from '../_unattended/契约/快照.mjs'
import { buildReviewBlock } from '../_unattended/契约/审核.mjs'

const SNAP = 'sha256:' + 'a'.repeat(64)
const OTHER = 'sha256:' + 'b'.repeat(64)

function goodGate (over = {}) {
  return {
    schema: 1,
    kind: 'gate-result',
    at: new Date().toISOString(),
    source: '门禁.mjs',
    state: 'green',
    stale: false,
    stamp: '2026-10-26-01-00-00',
    scope: 'all',
    ok: true,
    degraded: false,
    summaryText: '单测 10/10',
    snapshot: { snapshotId: SNAP, manifestHash: 'x', count: 10, degraded: false },
    e2e: { declared: 1, ran: 1, ok: true, required: true, steps: [], evidence: ['_crew/gate/entry-evidence.json'] },
    ...over
  }
}

function goodReview (over = {}) {
  return {
    decision: 'pass',
    conflict: false,
    why: null,
    block: { decision: 'pass', gateStamp: '2026-10-26-01-00-00', snapshotId: SNAP, blockers: [], reviewId: 'REVIEW-1' },
    ...over
  }
}

const GOOD_ARGS = {
  gate: goodGate(),
  gateEnvelopeOk: true,
  currentSnapshotId: SNAP,
  review: goodReview(),
  reviewReport: { path: 'r.md', sha: 'sha256:r1' },
  e2e: { declared: true, ok: true, evidence: [] },
  openHalts: [],
  stateServiceOk: true,
  previous: null,
  handoffDrift: null,
  entryEvidenceMissing: false
}

// ---------------------------------------------------------------- decide()

test('全绿 ⇒ ready', () => {
  const r = decide(GOOD_ARGS)
  assert.equal(r.state, 'ready')
  assert.deepEqual(r.blockers, [])
  dump('decide-ready', r)
})

test('负向：门禁侧五条阻断（缺失/红/降级/非全量/旧快照/快照不一致）', () => {
  const cases = {
    gateMissing: { gate: null },
    gateRed: { gate: goodGate({ ok: false }) },
    gateDegraded: { gate: goodGate({ degraded: true }) },
    gateScope: { gate: goodGate({ scope: 'unit' }) },
    gateLegacy: { gate: goodGate({ snapshot: undefined }) },
    gateSnapMismatch: { gate: goodGate({ snapshot: { snapshotId: OTHER, manifestHash: 'y', count: 1, degraded: false } }) },
    gateSnapDegraded: { gate: goodGate({ snapshot: { snapshotId: SNAP, manifestHash: 'y', count: 1, degraded: true } }) },
    gateEnvelope: { gateEnvelopeOk: false }
  }
  for (const [name, over] of Object.entries(cases)) {
    const r = decide({ ...GOOD_ARGS, ...over })
    assert.equal(r.state, 'blocked', `${name} 应阻断`)
    assert.ok(r.blockers.length, `${name} 应给出阻断原因`)
  }
})

test('负向：缺 E2E / E2E 红 / 证据缺失 ⇒ blocked（§二）', () => {
  for (const over of [
    { e2e: { declared: false, ok: false, why: '没声明' } },
    { e2e: { declared: true, ok: false, why: '红了' } },
    { entryEvidenceMissing: true }
  ]) {
    const r = decide({ ...GOOD_ARGS, ...over })
    assert.equal(r.state, 'blocked')
    assert.ok(r.blockers.some(b => b.startsWith('e2e:')), JSON.stringify(r.blockers))
  }
})

test('负向：审核四条阻断（缺块/未过/正文冲突/快照不一致/门禁戳不一致）', () => {
  const cases = {
    unknown: { review: { decision: 'unknown', conflict: false, why: '缺机器块', block: {} } },
    reject: { review: goodReview({ decision: 'reject', block: { decision: 'reject', gateStamp: '2026-10-26-01-00-00', snapshotId: SNAP } }) },
    conflict: { review: goodReview({ conflict: true, why: '正文说打回' }) },
    snapMismatch: { review: goodReview({ block: { decision: 'pass', gateStamp: '2026-10-26-01-00-00', snapshotId: OTHER } }) },
    gateStampMismatch: { review: goodReview({ block: { decision: 'pass', gateStamp: '2026-01-01-00-00-00', snapshotId: SNAP } }) }
  }
  for (const [name, over] of Object.entries(cases)) {
    const r = decide({ ...GOOD_ARGS, ...over })
    assert.equal(r.state, 'blocked', `${name} 应阻断`)
    assert.ok(r.blockers.some(b => b.startsWith('review:')), `${name}: ${JSON.stringify(r.blockers)}`)
  }
  const noReport = decide({ ...GOOD_ARGS, reviewReport: null })
  assert.equal(noReport.state, 'blocked')
  assert.ok(noReport.blockers.some(b => b.startsWith('review:missing')))
})

test('负向：未销 halt / 状态服务不可用 / HANDOFF 漂移 ⇒ blocked', () => {
  const h = decide({ ...GOOD_ARGS, openHalts: [{ reason: 'ac-red' }] })
  assert.ok(h.blockers.some(b => b.startsWith('halt:open')))
  const s = decide({ ...GOOD_ARGS, stateServiceOk: false, stateServiceWhy: '端口不通' })
  assert.equal(s.state, 'blocked')
  assert.ok(s.blockers.some(b => b.startsWith('state:unavailable')))
  const d = decide({ ...GOOD_ARGS, handoffDrift: 'HANDOFF 与源不一致' })
  assert.ok(d.blockers.some(b => b.startsWith('handoff:drift')))
})

test('已验收：同快照同报告 ⇒ accepted；快照变了 ⇒ stale', () => {
  const prev = { state: 'accepted', snapshotId: SNAP, review: { reportSha: 'sha256:r1' } }
  assert.equal(decide({ ...GOOD_ARGS, previous: prev }).state, 'accepted')
  const changed = decide({ ...GOOD_ARGS, previous: prev, currentSnapshotId: OTHER, gate: goodGate({ snapshot: { snapshotId: OTHER, manifestHash: 'z', count: 1, degraded: false } }), review: goodReview({ block: { decision: 'pass', gateStamp: '2026-10-26-01-00-00', snapshotId: OTHER } }) })
  assert.equal(changed.state, 'stale')
  dump('decide-stale', changed)
})

test('已打回：同一份快照 + 无阻断 ⇒ kept rejected；快照变了按新证据重算', () => {
  const prev = { state: 'rejected', snapshotId: SNAP }
  assert.equal(decide({ ...GOOD_ARGS, previous: prev }).state, 'rejected')
  const newer = decide({ ...GOOD_ARGS, previous: prev, currentSnapshotId: OTHER })
  assert.notEqual(newer.state, 'rejected')
})

test('验收后审核报告被改 ⇒ stale（而不是永久 blocked）', () => {
  const prev = { state: 'accepted', snapshotId: SNAP, review: { reportSha: 'sha256:old' } }
  const r = decide({ ...GOOD_ARGS, previous: prev })
  assert.equal(r.state, 'stale')
  assert.equal(r.blockers.length, 0, '验收前/后都不该把"报告变了"当阻断项，它只影响 state')
})

// ---------------------------------------------------------------- HANDOFF 投影

test('HANDOFF：生成块带 source/snapshotId/state，且手写"已交付"被停用（不是删）', () => {
  const release = { state: 'blocked', snapshotId: SNAP, at: new Date().toISOString(), blockers: ['gate:red（红了）'], gate: { ok: false, stamp: 'x', scope: 'all' }, review: { decision: 'unknown' }, e2e: { ok: false }, waivers: [] }
  const text = '# HANDOFF\n\n状态：已交付，可直接交付。\n\n其他说明保留。\n'
  const out = projectHandoff(text, release)
  assert.equal(out.disabled, 1)
  assert.match(out.text, /手写状态已停用/)
  assert.match(out.text, /已交付，可直接交付/)      // 原话保留（在注释里）
  assert.ok(out.text.includes(HANDOFF_BEGIN))
  assert.ok(out.text.includes(HANDOFF_END))
  assert.match(out.text, /其他说明保留/)            // 无关正文不许被吃掉
  const block = /<!-- RELEASE-BLOCK (\{[\s\S]*?\}) -->/.exec(out.text)
  assert.ok(block, '生成块 JSON 解析不到')
  const meta = JSON.parse(block[1])
  assert.equal(meta.generatedFrom, '_crew/release-status.json')
  assert.equal(meta.snapshotId, SNAP)
  assert.equal(meta.state, 'blocked')
  dump('handoff-projection', out.text)
})

test('HANDOFF：重复投影不会叠块（幂等）', () => {
  const release = { state: 'ready', snapshotId: SNAP, at: new Date().toISOString(), blockers: [], gate: { ok: true, stamp: 'x', scope: 'all' }, review: { decision: 'pass' }, e2e: { ok: true }, waivers: [] }
  const once = projectHandoff('# HANDOFF\n', release)
  const twice = projectHandoff(once.text, release)
  // 注意：收口标记 `<!-- /RELEASE-BLOCK -->` 里也含 RELEASE-BLOCK，所以要数**开头**那个
  assert.equal((twice.text.match(/<!-- RELEASE-BLOCK \{/g) ?? []).length, 1, '生成块被叠了')
  assert.equal((twice.text.match(/<!-- \/RELEASE-BLOCK -->/g) ?? []).length, 1, '收口标记被叠了')
})

test('renderHandoffBlock：只有 accepted 才写"已验收"', () => {
  const base = { snapshotId: SNAP, at: 'x', blockers: [], gate: { ok: true, stamp: 's', scope: 'all' }, review: { decision: 'pass' }, e2e: { ok: true }, waivers: [] }
  assert.match(renderHandoffBlock({ ...base, state: 'accepted' }), /已验收/)
  assert.ok(!/已验收/.test(renderHandoffBlock({ ...base, state: 'ready' })))
  assert.match(renderHandoffBlock({ ...base, state: 'stale' }), /过期/)
})

test('e2eOfGate：门禁没声明 e2e ⇒ 判缺失；旧格式没有 e2e 段 ⇒ 也判缺失', () => {
  assert.equal(e2eOfGate(goodGate()).ok, true)
  assert.equal(e2eOfGate(goodGate({ e2e: null })).declared, false)
  assert.equal(e2eOfGate({ stamp: 'x' }).declared, false)
  assert.equal(e2eOfGate(null).declared, false)
})

// ---------------------------------------------------------------- CLI 集成（真跑）

function buildReadyProject () {
  const dir = fixture({
    'src/a.js': 'export const a = 1\n',
    'gate.json': JSON.stringify({
      steps: [
        { name: 'unit', kind: 'unit', cmd: 'node -e "process.exit(0)"' },
        { name: 'entry', kind: 'e2e', required: true, cmd: 'node -e "process.exit(0)"', timeoutSec: 60, evidence: '_crew/gate/entry-evidence.json' }
      ]
    }, null, 2),
    '_crew/gate/entry-output.txt': 'real output\n',
    '_crew/runs/2026-10-26T01-00-00/review/审核报告.md': '# 审核报告\n\n结论：通过。\n'
  })
  const snap = computeSnapshot({ project: dir }).snapshotId
  const gateStamp = '2026-10-26-01-00-00'
  writeFileSync(join(dir, '_crew', 'gate', 'gate-result.json'), JSON.stringify(goodGate({
    stamp: gateStamp,
    snapshot: { snapshotId: snap, manifestHash: snap.slice(7), count: 5, degraded: false }
  }), null, 2), 'utf8')
  writeFileSync(join(dir, '_crew', 'gate', 'entry-evidence.json'), JSON.stringify({
    schema: 1,
    kind: 'entry',
    snapshotId: snap,
    at: new Date().toISOString(),
    source: 'project-adapter',
    state: 'green',
    ok: true,
    entry: 'cli:node -e',
    checks: [{ id: 'E1', ok: true, detail: '退出码 0' }],
    artifacts: ['_crew/gate/entry-output.txt'],
    durationMs: 12
  }, null, 2), 'utf8')
  const reportPath = join(dir, '_crew', 'runs', '2026-10-26T01-00-00', 'review', '审核报告.md')
  writeFileSync(reportPath, readFileSync(reportPath, 'utf8') + '\n' + buildReviewBlock({ decision: 'pass', gateStamp, snapshotId: snap, reviewId: 'REVIEW-1' }) + '\n', 'utf8')
  return { dir, snap, gateStamp }
}

test('CLI 全链路：blocked（缺门禁）→ ready → 改一个字节 stale；accept 只认人', async () => {
  const svc = await startService()
  const { dir, snap } = buildReadyProject()
  const env = { ...process.env, DSH_CREW_STATE_PORT: String(svc.port) }
  const run = (...args) => spawnSync(process.execPath, [join(UNATTENDED, '交付门.mjs'), '--project', dir, ...args], { encoding: 'utf8', env, timeout: 60000 })
  try {
    // ① 现在应该是 ready
    const r1 = run('--json')
    assert.equal(r1.status, 0, `${r1.stdout}\n${r1.stderr}`)
    const j1 = JSON.parse(r1.stdout)
    assert.equal(j1.state, 'ready')
    assert.equal(j1.snapshotId, snap)
    assert.equal(existsSync(join(dir, '_crew', 'release-status.json')), true)
    assert.equal(existsSync(join(dir, 'HANDOFF.md')), true)

    // ② 改一个受管字节 ⇒ 旧门禁/旧审核全部作废
    writeFileSync(join(dir, 'src/a.js'), 'export const a = 2\n', 'utf8')
    const r2 = run('--json')
    assert.equal(r2.status, 2, `期望 blocked(2)，实际 ${r2.status}`)
    const j2 = JSON.parse(r2.stdout)
    assert.equal(j2.state, 'blocked')
    assert.ok(j2.blockers.some(b => b.startsWith('gate:snapshot-mismatch')))
    assert.ok(j2.blockers.some(b => b.startsWith('review:snapshot-mismatch')))

    // ③ 用户验收（人）⇒ accepted
    writeFileSync(join(dir, 'src/a.js'), 'export const a = 1\n', 'utf8') // 改回原样 ⇒ 快照回到 snap
    const r3 = run('--accept', '--by', '用户')
    assert.equal(r3.status, 0, `${r3.stdout}\n${r3.stderr}`)
    const rel = JSON.parse(readFileSync(join(dir, '_crew', 'release-status.json'), 'utf8'))
    assert.equal(rel.state, 'accepted')
    assert.equal(rel.acceptedBy, '用户')

    // ④ 验收后代码再变 ⇒ stale
    writeFileSync(join(dir, 'src/a.js'), 'export const a = 3\n', 'utf8')
    const r4 = run('--json')
    assert.equal(r4.status, 4, `期望 stale(4)，实际 ${r4.status}`)
    assert.equal(JSON.parse(r4.stdout).state, 'stale')

    // ⑤ 大脑自批必须被拒
    const r5 = run('--accept', '--by', '大脑')
    assert.equal(r5.status, 5, `自批应 exit 5，实际 ${r5.status}`)
    assert.match(r5.stderr, /大脑|AI/)

    dump('delivery-cli', { ready: j1.state, afterEdit: j2.blockers.slice(0, 3), accepted: rel.state, afterAcceptEdit: 'stale' })
  } finally { await svc.stop(); cleanup(dir) }
})

test('CLI：--check 不写文件；缺 --by 的 accept 直接拒', async () => {
  const svc = await startService()
  const { dir } = buildReadyProject()
  const env = { ...process.env, DSH_CREW_STATE_PORT: String(svc.port) }
  const run = (...args) => spawnSync(process.execPath, [join(UNATTENDED, '交付门.mjs'), '--project', dir, ...args], { encoding: 'utf8', env, timeout: 60000 })
  try {
    const r = run('--check')
    assert.equal(r.status, 0)
    assert.equal(existsSync(join(dir, '_crew', 'release-status.json')), false, '--check 不该写文件')
    assert.equal(existsSync(join(dir, 'HANDOFF.md')), false, '--check 不该写 HANDOFF')
    const noBy = run('--accept')
    assert.equal(noBy.status, 5)
    assert.match(noBy.stderr, /--by/)
  } finally { await svc.stop(); cleanup(dir) }
})

test('CLI：审核报告写"打回"而机器块写 pass ⇒ 阻断（冲突）', async () => {
  const svc = await startService()
  const { dir } = buildReadyProject()
  const env = { ...process.env, DSH_CREW_STATE_PORT: String(svc.port) }
  try {
    const reportPath = join(dir, '_crew', 'runs', '2026-10-26T01-00-00', 'review', '审核报告.md')
    writeFileSync(reportPath, '# 审核报告\n\n结论：**打回**，入口没接。\n', 'utf8')
    // 重新补机器块（pass）—— 正文是打回
    const snap = computeSnapshot({ project: dir }).snapshotId
    writeFileSync(reportPath, readFileSync(reportPath, 'utf8') + '\n' + buildReviewBlock({ decision: 'pass', gateStamp: '2026-10-26-01-00-00', snapshotId: snap }) + '\n', 'utf8')
    const r = spawnSync(process.execPath, [join(UNATTENDED, '交付门.mjs'), '--project', dir, '--json'], { encoding: 'utf8', env, timeout: 60000 })
    assert.equal(r.status, 2, `${r.stdout}\n${r.stderr}`)
    const j = JSON.parse(r.stdout)
    assert.ok(j.blockers.some(b => b.startsWith('review:prose-conflict')), JSON.stringify(j.blockers))
  } finally { await svc.stop(); cleanup(dir) }
})

test('审核员的 why 不能被吞掉；没写 why 的阻断要被点出来（2026-10-26 demo 真跑抓到的）', () => {
  const base = { schema: 1, gateStamp: 'g1', snapshotId: 'sha256:' + 'a'.repeat(64) }
  const mk = (o) => '<!-- REVIEW-DECISION ' + JSON.stringify({ ...base, ...o }) + ' -->\n正文'

  const withWhy = judgeReview(mk({ decision: 'blocked', why: '有越界' }))
  assert.equal(withWhy.decision, 'blocked')
  assert.equal(withWhy.why, '有越界', '机器块里的 why 必须原样带到结论（原来写死 null）')

  const noWhy = judgeReview(mk({ decision: 'blocked' }))
  assert.equal(noWhy.decision, 'blocked')
  assert.match(String(noWhy.why), /没写 why/, '无理由的阻断必须被点出来，不能静默')
})
