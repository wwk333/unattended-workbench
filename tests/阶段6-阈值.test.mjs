/**
 * 阶段 6（补）· run 卡住阈值跟级别走（§七）
 *
 * 文档：L1 30 / L2 55 / L3 100 / L4 160 分钟；「L4 任务 150 分钟 ⇒ run 卡住阈值 160 分钟」。
 * 以前是固定 100 分钟 —— L1 改一行字卡 30 分钟没人管，L4 重构 150 分钟天天误报。
 *
 * 纪律：**级别不知道就如实说不知道**，不猜一个级别（猜错比固定值更糟）；`--stall-min` 人说了算。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { LEVEL_STALL_MIN, DEFAULT_STALL_MIN, stallMinOf } from '../_unattended/_派活内核.mjs'
import { UNATTENDED } from './_服务夹具.mjs'
import { dump } from './_助手.mjs'

test('阈值表与文档一致：L1 30 / L2 55 / L3 100 / L4 160', () => {
  assert.deepEqual({ ...LEVEL_STALL_MIN }, { L1: 30, L2: 55, L3: 100, L4: 160 })
  assert.equal(DEFAULT_STALL_MIN, 100)
})

test('各等级取到自己的阈值；L4 的 150 分钟活不会被判卡住', () => {
  for (const [lv, min] of Object.entries(LEVEL_STALL_MIN)) {
    const r = stallMinOf(lv)
    assert.equal(r.min, min)
    assert.equal(r.source, 'level')
    assert.equal(r.why, null)
  }
  // 文档原话：L4 任务 150 分钟 ⇒ run 卡住阈值 160 分钟
  assert.ok(150 < stallMinOf('L4').min, '150 分钟的 L4 活必须不算卡住')
  // 反过来：L1 卡 35 分钟就该管（旧固定 100 分钟会漏）
  assert.ok(35 > stallMinOf('L1').min, '35 分钟没动的 L1 必须判卡住（旧值 100 会漏）')
  dump('stall-by-level', Object.fromEntries(Object.keys(LEVEL_STALL_MIN).map(l => [l, stallMinOf(l).min])))
})

test('小写/带空格也认；不认识就兜底且说明白', () => {
  assert.equal(stallMinOf('l4').min, 160)
  assert.equal(stallMinOf(' L2 ').min, 55)
  const weird = stallMinOf('L9')
  assert.equal(weird.min, DEFAULT_STALL_MIN)
  assert.equal(weird.source, 'default')
  assert.match(weird.why, /不在阈值表/)
})

test('不知道级别 ⇒ 兜底 + 明说"不做级别猜测"（不瞎猜）', () => {
  const r = stallMinOf(null)
  assert.equal(r.min, DEFAULT_STALL_MIN)
  assert.equal(r.source, 'default')
  assert.match(r.why, /不知道这轮的级别/)
  assert.match(r.why, /不做级别猜测/)
  assert.equal(r.level, null)
})

test('--stall-min 最高优先（人显式说了算）', () => {
  const r = stallMinOf('L4', 200)
  assert.equal(r.min, 200)
  assert.equal(r.source, 'cli')
  assert.match(r.why, /--stall-min/)
  assert.equal(stallMinOf(null, 0).source, 'default', '0 不算有效覆盖')
  assert.equal(stallMinOf(null, 'abc').source, 'default')
})

test('进度看护接线：用 STALL.min 判卡住，输出带级别与来源', () => {
  const src = readFileSync(join(UNATTENDED, '进度看护.mjs'), 'utf8')
  assert.match(src, /const STALL = stallMinOf\(lock\?\.level \?\? null, STALL_OVERRIDE\)/)
  assert.ok(!/fresh\.noProgressMin > STALL_MIN/.test(src), '还在用固定 STALL_MIN 判卡住')
  assert.match(src, /fresh\.noProgressMin > STALL\.min/)
  assert.match(src, /stallMin: STALL\.min, stallLevel: STALL\.level/)
})

// ★W2（D22）：这条断言的是**真实运行时产物**，包里不带数据 ⇒ 明说跳过。
//   **不许静默改成"有就查、没有就算过"** —— 那是假绿。
const REAL_GUARD = join(UNATTENDED, '..', '_crew', '看护状态.json')
const SKIP_NO_REAL = existsSync(REAL_GUARD) ? false : '需要真实 _crew/看护状态.json（开源包里不带运行时数据）'

test('真实产物：看护状态.json 里带 stallMin/stallLevel/stallLevelSource', { skip: SKIP_NO_REAL }, () => {
  const j = JSON.parse(readFileSync(REAL_GUARD, 'utf8'))
  assert.equal(typeof j.stallMin, 'number')
  assert.ok(Object.hasOwn(j, 'stallLevel'))
  assert.ok(['cli', 'level', 'default'].includes(j.stallLevelSource), `来源非法：${j.stallLevelSource}`)
  dump('stall-real', { min: j.stallMin, level: j.stallLevel, src: j.stallLevelSource })
})
