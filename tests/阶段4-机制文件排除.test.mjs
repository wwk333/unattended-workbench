/**
 * 阶段 4（补）· 机制文件不算交付物（2026-10-26 demo 真跑第三次逼出来的）
 *
 * 事故链：审核前指纹把 `_crew/卡片看护.json`（我方 _监控.mjs 每 10 秒刷的健康文件）
 * 记成"1 处改动" ⇒ 越界清单里出现它 ⇒ 审核员按 C2 判 `contract:C2（机制文件被计改动，口径不通）`
 * ⇒ 整轮审核被判 blocked。一条**假越界**把结论判死，属于最坏那类错（看起来很有理，其实是噪音）。
 *
 * 两条修：
 *   ① `_排除清单.mjs` 把机制文件/目录排除掉（不再进指纹 diff）；
 *   ② `_归因.classifyOutOfScope` 兜底：`_crew/**` 等先摘成 `infra`，**不进越界统计**。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { shouldSkipFile, SKIP_RELS, SKIP_FILES } from '../_unattended/_排除清单.mjs'
import { isInfraPath, splitInfra, classifyOutOfScope } from '../_unattended/_归因.mjs'
import { dump } from './_助手.mjs'

const skipped = (p) => shouldSkipFile(p) || [...SKIP_RELS].some(r => p === r || p.startsWith(r + '/'))

test('机制文件被排除（卡片看护 / 看护状态 / gate / 状态库 / 调参）', () => {
  const mustSkip = [
    '_crew/卡片看护.json',
    '_crew/看护状态.json',
    '_crew/长命资源状态.json',
    '_crew/唤醒状态.json',
    '_crew/gate-status.json',
    '_crew/gate/gate-result.json',
    '_crew/state/crew.db',
    '_crew/调参/当前.json',
    '_crew/runs/2026-10-25T20-20-13/verdict.json'
  ]
  for (const p of mustSkip) assert.ok(skipped(p), `应排除但没排：${p}`)
  dump('skip-ok', mustSkip.length)
})

test('真交付物一个都不能被误排（反向判据）', () => {
  const mustKeep = ['hello.txt', 'src/a.mjs', 'tests/u.mjs', 'server/src/x.ts', 'docs/README.md', 'gate.json']
  for (const p of mustKeep) assert.ok(!skipped(p), `不该排除却被排了：${p}`)
})

test('isInfraPath：只认机制目录，不认名字里带 _crew 的普通文件', () => {
  assert.equal(isInfraPath('_crew/卡片看护.json'), true)
  assert.equal(isInfraPath('node_modules/x/index.js'), true)
  assert.equal(isInfraPath('src/_crew/a.mjs'), false, '路径中间出现 _crew 不算机制文件')
  assert.equal(isInfraPath('hello.txt'), false)
})

test('classifyOutOfScope：机制文件进 infra，不进"真越界"', () => {
  const r = classifyOutOfScope(['_crew/卡片看护.json', 'src/a.mjs', 'server/src/b.ts'], ['src/a.mjs'])
  assert.deepEqual(r.infra, ['_crew/卡片看护.json'])
  assert.deepEqual(r.whitelistGap, ['src/a.mjs'])
  assert.deepEqual(r.realOverreach, ['server/src/b.ts'])
  dump('classify', { infra: r.infra.length, gap: r.whitelistGap.length, real: r.realOverreach.length })
})

test('splitInfra：批量拆分保持原顺序', () => {
  const { infra, rest } = splitInfra(['a/b.mjs', '_crew/x.json', 'c/d.mjs'])
  assert.deepEqual(rest, ['a/b.mjs', 'c/d.mjs'])
  assert.deepEqual(infra, ['_crew/x.json'])
})
