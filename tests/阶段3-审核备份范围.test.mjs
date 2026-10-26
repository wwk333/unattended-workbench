/**
 * 阶段 3（补）· 审核前快照的备份范围（2026-10-26 修：不再假设项目里有 server/*）
 *
 * 事故：demo 真跑第二次走到审核时 `审核前快照备份失败 → fail-closed 停手`，
 * 原因范围里硬写了 `server/src|server/test|server/scripts` —— 那是某个真实项目的结构。
 * 现在：交付物目录优先、常见目录存在才收、全都没有返回空数组（调用方按"跳过，不算失败"）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { reviewBackupScope, backupTargets, CONVENTIONAL_DIRS } from '../_unattended/_审核备份范围.mjs'
import { dump } from './_助手.mjs'

const win = (re) => (p) => re.test(String(p))

test('没有 server/* 的项目 ⇒ 空数组（调用方跳过，不是失败）', () => {
  const r = reviewBackupScope({ project: 'D:/x/demo', files: ['hello.txt'], exists: () => false })
  assert.deepEqual(r, [])
  dump('scope-empty', r)
})

test('交付物所在目录存在 ⇒ 收它；不存在的常见目录不收', () => {
  const r = reviewBackupScope({
    project: 'X:/p',
    files: ['src/convert.mjs'],
    // 只承认顶层的 src/，不承认 server/src（否则这条就等于没测）
    exists: (p) => /[\\/]src$/.test(p) && !/server/.test(p)
  })
  assert.deepEqual(r, ['src'])
})

test('常见目录存在才收（server/src + server/test 都在 ⇒ 两个都收，且去重）', () => {
  const r = reviewBackupScope({
    project: 'X:/p',
    files: ['server/src/a.mjs', 'server/src/b.mjs'],
    exists: win(/server[\\/](src|test)$/)
  })
  assert.deepEqual(r.sort(), ['server/src', 'server/test'])
})

test('交付物目录优先于常见目录（顺序稳定，便于日志核对）', () => {
  const r = reviewBackupScope({
    project: 'X:/p',
    files: ['app/ui/x.vue'],
    exists: () => true
  })
  assert.equal(r[0], 'app/ui', '交付物目录应排在最前')
  assert.deepEqual(r.slice(1), CONVENTIONAL_DIRS)
})

test('反斜杠 / 前导 ./ / 结尾 / 都要归一；重名只留一份', () => {
  const r = reviewBackupScope({
    project: 'X:/p',
    // files 是**文件**路径（传目录会得到它的父目录，不在本条的界面内）
    files: ['server\\src\\a.mjs', './server/src/b.mjs'],
    exists: () => true,
    conventional: []
  })
  assert.deepEqual(r, ['server/src'])
})

test('没给 project 时不查存在性（纯计算，便于单测/预览）', () => {
  const r = reviewBackupScope({ files: ['a/b/c.mjs'], conventional: [] })
  assert.deepEqual(r, ['a/b'])
})

// ------------------------------------------------------------------ backupTargets
// ★ 2026-10-27 真跑当场抓到的 bug：旧清洗要求路径**必须带 `/`**，于是根目录交付物全被丢掉，
//   `clean` 恒空 ⇒ 每轮都打「没有可备份的目录」⇒ **审核前的后悔药一次都没吃上**。

test('根目录交付物必须保留（这是真跑踩到的那个 bug 的回归锁）', () => {
  const t = backupTargets(['index.html', 'tests', 'gate.json', '启动-背单词.vbs'])
  assert.deepEqual(t, ['index.html', 'tests', 'gate.json', '启动-背单词.vbs'])
  assert.notEqual(t.length, 0, '不许再出现"全是根目录文件 ⇒ 备份范围为空"')
})

test('带目录的照旧可用 + 反斜杠归一 + 去重', () => {
  const t = backupTargets(['src\\a.mjs', './src/b.mjs', 'src', 'doc/x.md'])
  assert.deepEqual(t, ['src/a.mjs', 'src/b.mjs', 'src', 'doc/x.md'])
})

test('挡掉"整盘 / 整树"，不挡单个文件', () => {
  assert.deepEqual(backupTargets(['c:', 'c:/', 'C:/Windows', '/etc/passwd', '.', '..', '', null, undefined]), [])
  assert.deepEqual(backupTargets(['a.txt']), ['a.txt'])
})

test('空输入 / 非数组 ⇒ 空（调用方按"跳过，不算失败"处理）', () => {
  assert.deepEqual(backupTargets([]), [])
  assert.deepEqual(backupTargets(null), [])
  assert.deepEqual(backupTargets(undefined), [])
})
