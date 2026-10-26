/**
 * 阶段 0 · snapshotId 唯一实现（§零.1）
 * 正向：同内容同 id、确定性、范围可声明；
 * 负向：改一个字节 id 必变、证据文件不算代码、旧 gate-result 不得补造快照。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  resolveScope, buildManifest, snapshotIdFromManifest, computeSnapshot,
  snapshotIdFromGateResult, migrateSnapshotField, diffManifests, globToRe, describeSnapshot
} from '../_unattended/契约/快照.mjs'
import { fixture, cleanup, dump, gateResultWithSnapshot } from './_助手.mjs'

const BASE = {
  'package.json': '{"name":"demo"}',
  'src/a.js': 'export const a = 1',
  'src/b.js': 'export const b = 2',
  'tests/a.test.mjs': 'test("a",()=>{})',
  'gate.json': '{"steps":[]}',
  '_crew/tasks/TASKS.md': '这是运行现场，不是代码',
  '_crew/gate/gate-result.json': '{"ok":true}',
  'HANDOFF.md': '手写的"已交付"',
  'TASKS.md': '- [done] T1',
  'node_modules/x/index.js': 'noise'
}

test('快照是确定性的：同内容跑两次同一个 id', () => {
  const root = fixture(BASE)
  try {
    const a = computeSnapshot({ project: root })
    const b = computeSnapshot({ project: root })
    assert.equal(a.snapshotId, b.snapshotId)
    assert.match(a.snapshotId, /^sha256:[0-9a-f]{64}$/)
    assert.equal(a.manifestHash, a.snapshotId.slice('sha256:'.length))
    dump('snapshot-base', { snapshotId: a.snapshotId, count: a.count, paths: Object.keys(a.files).sort() })
  } finally { cleanup(root) }
})

test('改一个受管字节 ⇒ snapshotId 必变（§零 验收第一条）', () => {
  const root = fixture(BASE)
  try {
    const before = computeSnapshot({ project: root })
    writeFileSync(join(root, 'src/a.js'), 'export const a = 2', 'utf8')
    const after = computeSnapshot({ project: root })
    assert.notEqual(before.snapshotId, after.snapshotId)
    const d = diffManifests(before.files, after.files)
    assert.deepEqual(d.changed, ['src/a.js'])
    assert.deepEqual(d.added, [])
    assert.deepEqual(d.removed, [])
    dump('snapshot-changed', { before: before.snapshotId, after: after.snapshotId, diff: d })
  } finally { cleanup(root) }
})

test('gate.json 变也变（它是影响验收的配置，必须进快照）', () => {
  const root = fixture(BASE)
  try {
    const before = computeSnapshot({ project: root })
    writeFileSync(join(root, 'gate.json'), '{"steps":[{"name":"unit"}]}', 'utf8')
    assert.notEqual(before.snapshotId, computeSnapshot({ project: root }).snapshotId)
  } finally { cleanup(root) }
})

test('负向：证据/报告/运行现场/依赖目录不许进快照', () => {
  const root = fixture(BASE)
  try {
    const s = computeSnapshot({ project: root })
    const files = Object.keys(s.files)
    assert.ok(!files.some(f => f.startsWith('_crew/')), '_crew 不许进快照')
    assert.ok(!files.includes('HANDOFF.md'), 'HANDOFF 不许进快照')
    assert.ok(!files.includes('TASKS.md'), 'TASKS.md 不许进快照')
    assert.ok(!files.some(f => f.startsWith('node_modules/')), 'node_modules 不许进快照')
    assert.deepEqual(files.sort(), ['gate.json', 'package.json', 'src/a.js', 'src/b.js', 'tests/a.test.mjs'])
  } finally { cleanup(root) }
})

test('只改 HANDOFF（证据）不该让快照变 —— 否则交期会被证据噪音刷成 stale', () => {
  const root = fixture(BASE)
  try {
    const before = computeSnapshot({ project: root })
    writeFileSync(join(root, 'HANDOFF.md'), '又写了一版"已交付"', 'utf8')
    assert.equal(before.snapshotId, computeSnapshot({ project: root }).snapshotId)
  } finally { cleanup(root) }
})

test('gate.json#snapshot 能声明 include/exclude，且是唯一范围出处', () => {
  const root = fixture({ ...BASE, 'docs/x.md': 'doc', 'src/keep.js': 'k' })
  try {
    const gate = { snapshot: { include: ['src/**', 'package.json', 'gate.json'], exclude: ['src/skip/**'] } }
    const scope = resolveScope({ gate })
    assert.equal(scope.declared, true)
    assert.equal(scope.source, 'gate.json#snapshot')
    const s = computeSnapshot({ project: root, gate })
    assert.deepEqual(Object.keys(s.files).sort(), ['gate.json', 'package.json', 'src/a.js', 'src/b.js', 'src/keep.js'])
    assert.ok(!Object.keys(s.files).some(f => f.startsWith('tests/')), 'include 之外不许进')
    dump('snapshot-declared-scope', { scope: s.scope, files: Object.keys(s.files).sort() })
  } finally { cleanup(root) }
})

test('默认范围（没声明）也能用，并自报 source', () => {
  const root = fixture(BASE)
  try {
    const s = computeSnapshot({ project: root })
    assert.equal(s.scope.declared, false)
    assert.equal(s.scope.source, 'default(§一)')
    assert.ok(s.scope.exclude.includes('_crew'))
    assert.match(describeSnapshot(s), /snapshot=sha256:[0-9a-f]{64}/)
  } finally { cleanup(root) }
})

test('大文件不哈希（只计数），超上限降级 —— 宁可粗也不把派活卡住', () => {
  const root = fixture({ 'a.txt': 'x' })
  try {
    const big = 'y'.repeat(1024)
    writeFileSync(join(root, 'huge.bin'), big, 'utf8')
    const s = computeSnapshot({ project: root, big: 100 })
    assert.equal(s.bigSkipped, 1)
    assert.ok(!Object.hasOwn(s.files, 'huge.bin'))
    const s2 = computeSnapshot({ project: root, cap: 1 })
    assert.equal(s2.degraded, true)
  } finally { cleanup(root) }
})

test('gate-result：新格式（有 snapshot 段）直接用；旧格式 ⇒ legacy，不补造', () => {
  const ok = snapshotIdFromGateResult(gateResultWithSnapshot({ snapshotId: 'sha256:deadbeef' }))
  assert.equal(ok.ok, true)
  assert.equal(ok.snapshotId, 'sha256:deadbeef')
  assert.equal(ok.manifestHash, 'deadbeef')

  const legacy = snapshotIdFromGateResult({ schema: 1, stamp: '2026-10-09-19-16-43', ok: true, manifest: { 'a.js': 'abc' } })
  assert.equal(legacy.ok, false)
  assert.equal(legacy.reason, 'legacy-no-snapshot')
  assert.equal(legacy.snapshotId, null)

  const nothing = snapshotIdFromGateResult({})
  assert.equal(nothing.reason, 'legacy-no-manifest')
  assert.equal(snapshotIdFromGateResult(null).reason, 'no-gate-result')
  dump('gate-result-snapshot', { ok, legacy, nothing })
})

test('旧字段 snapshot 统一迁移成 snapshotId（不再各算各的）', () => {
  assert.equal(migrateSnapshotField({ snapshot: 'abc123' }).snapshotId, 'sha256:abc123')
  assert.equal(migrateSnapshotField({ snapshot: 'sha256:abc' }).snapshotId, 'sha256:abc')
  assert.equal(migrateSnapshotField({ snapshot: { id: 'xyz' } }).snapshotId, 'xyz')
  const already = migrateSnapshotField({ snapshotId: 'sha256:keep', snapshot: 'old' })
  assert.equal(already.snapshotId, 'sha256:keep')
  assert.equal(already.snapshot, undefined)
  assert.deepEqual(migrateSnapshotField({}), {})
})

test('manifest 直算与 computeSnapshot 一致（消费方不必重扫）', () => {
  const root = fixture(BASE)
  try {
    const s = computeSnapshot({ project: root })
    const again = snapshotIdFromManifest(s.files)
    assert.equal(again.snapshotId, s.snapshotId)
    // 顺序无关：把 manifest 的键序打乱，id 不变
    const shuffled = {}
    for (const k of Object.keys(s.files).reverse()) shuffled[k] = s.files[k]
    assert.equal(snapshotIdFromManifest(shuffled).snapshotId, s.snapshotId)
  } finally { cleanup(root) }
})

test('buildManifest 缺 project 直接抛（不许算出一个"空快照"冒充绿）', () => {
  assert.throws(() => buildManifest({ scope: resolveScope({}) }), /缺 project/)
  assert.throws(() => snapshotIdFromManifest(null), /需要 manifest/)
})

test('globToRe 只支持需要的三个通配，不做花活', () => {
  assert.ok(globToRe('src/**').test('src/a/b.js'))
  assert.ok(globToRe('src/*.js').test('src/a.js'))
  assert.ok(!globToRe('src/*.js').test('src/a/b.js'))
  assert.ok(globToRe('a?.js').test('ab.js'))
  assert.ok(globToRe('gate.json').test('gate.json'))
  assert.ok(!globToRe('gate.json').test('x/gate.json'))
})
