/**
 * 阶段 2 · 入口 E2E 证据（§二）
 *
 * 核心：**只写 ok:true 的适配器就是橡皮章**。缺 checks / checks 里有一条 false /
 * degraded / snapshotId 不一致 / 声明的产物不在盘上 ⇒ 一律红。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { validateEntryEvidence, inspectEntryEvidence, resolveEvidencePath } from '../_unattended/契约/入口.mjs'
import { stepsFromGateJson } from '../_unattended/_门禁入口.mjs'
import { fixture, cleanup, dump } from './_助手.mjs'

const SNAP = 'sha256:deadbeef'

function goodEvidence (over = {}) {
  return {
    schema: 1,
    kind: 'entry',
    snapshotId: SNAP,
    at: new Date().toISOString(),
    source: 'project-adapter',
    state: 'green',
    ok: true,
    entry: 'cli:my-tool convert',
    checks: [
      { id: 'E1', ok: true, detail: '真实命令退出码 0' },
      { id: 'E2', ok: true, detail: '输出文件内容匹配' }
    ],
    artifacts: ['_crew/gate/entry-output.txt'],
    durationMs: 1200,
    ...over
  }
}

function projectWith (evidence, artifactBody = 'ok') {
  const dir = fixture({ '_crew/gate/entry-output.txt': artifactBody })
  if (evidence !== undefined) writeFileSync(join(dir, '_crew/gate/entry-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
  return dir
}

test('合规证据 ⇒ 过（逐条 checks + 产物真在盘上）', () => {
  const dir = projectWith(goodEvidence())
  try {
    const v = inspectEntryEvidence(join(dir, '_crew/gate/entry-evidence.json'), { snapshotId: SNAP, project: dir })
    assert.equal(v.ok, true, (v.errors ?? []).join('；'))
    assert.equal(v.checks.length, 2)
    assert.equal(v.entry, 'cli:my-tool convert')
    dump('entry-ok', { ok: v.ok, checks: v.checks.length, artifacts: v.artifacts })
  } finally { cleanup(dir) }
})

test('负向：证据文件缺失 / 坏 JSON ⇒ 红（不降级）', () => {
  const dir = projectWith(undefined)
  try {
    const miss = inspectEntryEvidence(join(dir, '_crew/gate/entry-evidence.json'), { snapshotId: SNAP, project: dir })
    assert.equal(miss.ok, false)
    assert.match(miss.errors[0], /不存在/)
    writeFileSync(join(dir, '_crew/gate/entry-evidence.json'), '{坏', 'utf8')
    const bad = inspectEntryEvidence(join(dir, '_crew/gate/entry-evidence.json'), { snapshotId: SNAP, project: dir })
    assert.equal(bad.ok, false)
    assert.match(bad.errors[0], /不是合法 JSON/)
  } finally { cleanup(dir) }
})

test('负向：只写 ok:true、没有 checks ⇒ 红（橡皮章）', () => {
  const dir = projectWith(goodEvidence({ checks: [] }))
  try {
    const v = inspectEntryEvidence(join(dir, '_crew/gate/entry-evidence.json'), { snapshotId: SNAP, project: dir })
    assert.equal(v.ok, false)
    assert.ok(v.errors.some(e => /checks 为空/.test(e)))
  } finally { cleanup(dir) }
})

test('负向：checks 里有一条 ok:false 或无 detail ⇒ 红', () => {
  const dir = projectWith(goodEvidence({ checks: [{ id: 'E1', ok: true, detail: '过' }, { id: 'E2', ok: false, detail: '失败' }] }))
  try {
    const v = inspectEntryEvidence(join(dir, '_crew/gate/entry-evidence.json'), { snapshotId: SNAP, project: dir })
    assert.equal(v.ok, false)
    assert.ok(v.errors.some(e => /E2.*ok 不为 true/.test(e)))
  } finally { cleanup(dir) }
  const dir2 = projectWith(goodEvidence({ checks: [{ id: 'E1', ok: true }] }))
  try {
    const v = inspectEntryEvidence(join(dir2, '_crew/gate/entry-evidence.json'), { snapshotId: SNAP, project: dir2 })
    assert.ok(v.errors.some(e => /缺 detail/.test(e)))
  } finally { cleanup(dir2) }
})

test('负向：degraded=true ⇒ 红（必过步骤不许降级冒充通过）', () => {
  const dir = projectWith(goodEvidence({ degraded: true }))
  try {
    const v = inspectEntryEvidence(join(dir, '_crew/gate/entry-evidence.json'), { snapshotId: SNAP, project: dir })
    assert.equal(v.ok, false)
    assert.ok(v.errors.some(e => /degraded/.test(e)))
  } finally { cleanup(dir) }
})

test('负向：snapshotId 不一致 / 缺失 ⇒ 红（旧证据冒充新绿灯）', () => {
  const dir = projectWith(goodEvidence({ snapshotId: 'sha256:other' }))
  try {
    const v = inspectEntryEvidence(join(dir, '_crew/gate/entry-evidence.json'), { snapshotId: SNAP, project: dir })
    assert.equal(v.ok, false)
    assert.ok(v.errors.some(e => /snapshotId 不一致/.test(e)))
  } finally { cleanup(dir) }
  const dir2 = projectWith(goodEvidence({ snapshotId: undefined }))
  try {
    const v = inspectEntryEvidence(join(dir2, '_crew/gate/entry-evidence.json'), { snapshotId: SNAP, project: dir2 })
    assert.ok(v.errors.some(e => /缺 snapshotId/.test(e)))
  } finally { cleanup(dir2) }
})

test('负向：产物不存在 / 空文件 / 没有 artifacts ⇒ 红', () => {
  const dir = projectWith(goodEvidence({ artifacts: ['_crew/gate/nope.txt'] }))
  try {
    const v = inspectEntryEvidence(join(dir, '_crew/gate/entry-evidence.json'), { snapshotId: SNAP, project: dir })
    assert.ok(v.errors.some(e => /产物不存在/.test(e)))
  } finally { cleanup(dir) }
  const dir2 = projectWith(goodEvidence({ artifacts: ['_crew/gate/entry-output.txt'] }), '')
  try {
    const v = inspectEntryEvidence(join(dir2, '_crew/gate/entry-evidence.json'), { snapshotId: SNAP, project: dir2 })
    assert.ok(v.errors.some(e => /空文件/.test(e)))
  } finally { cleanup(dir2) }
  const dir3 = projectWith(goodEvidence({ artifacts: undefined }))
  try {
    const v = inspectEntryEvidence(join(dir3, '_crew/gate/entry-evidence.json'), { snapshotId: SNAP, project: dir3 })
    assert.ok(v.errors.some(e => /缺 artifacts/.test(e)))
  } finally { cleanup(dir3) }
})

test('负向：ok:false / state 不是 green / stale / 缺 at / kind 不对', () => {
  const cases = {
    okFalse: { ok: false },
    stateRed: { state: 'red' },
    stale: { stale: true },
    atBad: { at: '昨天' },
    kindBad: { kind: 'gate' },
    schemaBad: { schema: 2 }
  }
  for (const [name, over] of Object.entries(cases)) {
    const v = validateEntryEvidence(goodEvidence(over), { snapshotId: SNAP, requireArtifacts: false })
    assert.equal(v.ok, false, `${name} 应判红`)
  }
})

test('gate.json 的 e2e 步骤要带 evidence/required/timeoutSec（内核靠它判证据）', () => {
  const steps = stepsFromGateJson({
    steps: [
      { name: 'unit', kind: 'unit', cmd: 'node tests/unit.mjs' },
      { name: 'entry', kind: 'e2e', required: true, cmd: 'node tests/entry.mjs', timeoutSec: 120, evidence: '_crew/gate/entry-evidence.json' }
    ]
  })
  assert.equal(steps.length, 2)
  const e2e = steps.find(s => s.kind === 'e2e')
  assert.equal(e2e.evidence, '_crew/gate/entry-evidence.json')
  assert.equal(e2e.required, true)
  assert.equal(e2e.timeoutSec, 120)
  assert.equal(e2e.exe, 'node')
  assert.deepEqual(e2e.args, ['tests/entry.mjs'])
  dump('e2e-step', e2e)
})

test('resolveEvidencePath：相对项目根，绝对路径原样', () => {
  const dir = fixture({ 'x/y.json': '{}' })
  try {
    assert.ok(resolveEvidencePath(dir, 'x/y.json').includes('x'))
    assert.equal(resolveEvidencePath(dir, 'X:/abs/z.json'), 'X:/abs/z.json')
    assert.equal(resolveEvidencePath(dir, null), null)
  } finally { cleanup(dir) }
})
