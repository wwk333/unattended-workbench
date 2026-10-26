/**
 * 阶段 9（准备）· E2E 验收驱动器
 *
 * 阶段 9 要"在真实项目上跑一遍"，所以先把**流水线本身**验好：
 *   ① 五步顺序固定 ② 任一步红就整体红 ③ 缺证据＝unknown（不算绿）④ 不写项目文件（交付门只 --check）
 *
 * 这里只跑**秒级**的失败路径；完整流水线由 `node scripts/e2e-演练.mjs --project examples/demo` 手动跑
 *（会在证据目录留下 `e2e-演练.json`）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runE2E, WORKBENCH, E2E_OUT } from '../scripts/e2e-演练.mjs'
import { dump } from './_助手.mjs'

const SCRATCH = () => mkdtempSync(join(tmpdir(), 'crew-e2e-'))

test('目录不存在 ⇒ 第一步就红，零耗时，不往下走', () => {
  const r = runE2E({ project: join(tmpdir(), 'crew-e2e-not-exist-xyz') })
  assert.equal(r.kind, 'e2e-run')
  assert.equal(r.state, 'red')
  assert.equal(r.ok, false)
  assert.equal(r.steps.length, 1, '第一步就失败，不该继续跑后面四步')
  assert.equal(r.steps[0].id, 'S1')
  assert.match(String(r.steps[0].detail), /目录不存在/)
  dump('e2e-missing-dir', r.counts)
})

test('有目录但既无 gate.json 又无 TASKS.md ⇒ 红并说明"不知道该怎么验收"', () => {
  const dir = SCRATCH()
  try {
    const r = runE2E({ project: dir })
    assert.equal(r.state, 'red')
    assert.match(String(r.steps[0].detail), /不知道该怎么验收/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('fail-closed：缺证据记 unknown，整体不许算绿', () => {
  const dir = SCRATCH()
  try {
    writeFileSync(join(dir, 'TASKS.md'), '# 空任务单\n', 'utf8')
    const r = runE2E({ project: dir, skipGate: true })
    const gateStep = r.steps.find(s => s.id === 'S2')
    assert.equal(gateStep.ok, null, '跳过/没有门禁必须是 unknown，不是 green')
    assert.match(String(gateStep.detail), /不算绿/)
    assert.equal(r.state, 'red', '交付门会因为缺 gate/e2e/review 而红')
    // 整体绿的前提是"没有红且没有未知"
    assert.equal(r.ok, false)
    assert.ok(r.steps.some(s => s.id === 'S3' && s.ok === false), '交付门应判红（缺 gate/e2e/review）')
    dump('e2e-fail-closed', { state: r.state, counts: r.counts })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('五步都在、顺序固定、结论由各步自己给（这里不重写判据）', () => {
  const src = readFileSync(join(WORKBENCH, 'scripts', 'e2e-演练.mjs'), 'utf8')
  for (const id of ['S1', 'S2', 'S3', 'S4', 'S5']) assert.match(src, new RegExp(`'${id}'`), `缺 ${id}`)
  // 顺序：S1 在 S2 之前……
  const pos = ['S1', 'S2', 'S3', 'S4', 'S5'].map(id => src.indexOf(`'${id}'`))
  assert.deepEqual([...pos].sort((a, b) => a - b), pos, '五步顺序被打乱了')
  // 交付门只判定不写
  assert.match(src, /'--check'/, '交付门必须只 --check（不许在验收时改项目状态）')
  // 缺结果不许当绿
  assert.match(src, /unk\('S2'/, '缺门禁结果要记 unknown')
})

test('证据落盘位置固定（给阶段 9 留痕）', () => {
  assert.match(E2E_OUT, /_crew[\\/]gate[\\/]e2e-演练\.json$/)
  if (existsSync(E2E_OUT)) {
    const j = JSON.parse(readFileSync(E2E_OUT, 'utf8'))
    assert.equal(j.kind, 'e2e-run')
    assert.equal(j.source, 'scripts/e2e-演练.mjs')
    assert.ok(Object.hasOwn(j, 'stale'))
    assert.ok(typeof j.counts.red === 'number')
  }
})
