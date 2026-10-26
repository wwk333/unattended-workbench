/**
 * 阶段 3（补）· 审核白名单（2026-10-26 抽出，钉住 whitelistEmpty 那个 bug）
 *
 * 事故：白名单折算要求交付物**必须带目录分隔符** ⇒ 根目录交付物（index.html / gate.json / 启动器.vbs）
 * 全被丢掉 ⇒ 这一波若只有根目录交付物，白名单就是空数组 ⇒ 编排只打一句"越界归不了因"，
 * 越界护栏形同虚设（真项目 T1/T3 全是根目录交付物，正好踩中）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewWhitelist } from '../_unattended/_审核白名单.mjs'
import { dump } from './_助手.mjs'

test('只有根目录交付物时，白名单**不为空**（这就是 whitelistEmpty 的回归锁）', () => {
  const r = reviewWhitelist(['index.html', 'gate.json', '启动-背单词.vbs'])
  assert.ok(r.length > 0, '根目录交付物不该被丢光')
  assert.deepEqual(r, ['index.html', 'gate.json', '启动-背单词.vbs'])
  dump('wl-root-only', r)
})

test('带目录的取所在目录，根文件保留文件名（混排）', () => {
  assert.deepEqual(
    reviewWhitelist(['tests/selftest.mjs', 'src/a/b.mjs', 'index.html']),
    ['tests', 'src/a', 'index.html']
  )
})

test('反斜杠 / 前导 ./ / 重复项都归一', () => {
  assert.deepEqual(
    reviewWhitelist(['tests\\a.mjs', './tests/b.mjs', 'index.html', 'index.html']),
    ['tests', 'index.html']
  )
})

test('空输入 / 非字符串 / 空串 ⇒ 空数组（不炸）', () => {
  assert.deepEqual(reviewWhitelist([]), [])
  assert.deepEqual(reviewWhitelist(null), [])
  assert.deepEqual(reviewWhitelist([null, 42, '', '   ']), [])
})

test('限量 12 条（多了只是噪音）', () => {
  const many = Array.from({ length: 30 }, (_, i) => `dir${i}/x.mjs`)
  assert.equal(reviewWhitelist(many).length, 12)
})
