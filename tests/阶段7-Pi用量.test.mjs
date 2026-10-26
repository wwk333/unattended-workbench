/**
 * 阶段 7（补）· Pi 形态的用量提取（2026-10-26 真项目 beidanci 当场抓到）
 *
 * 事故：`ctxPeak` 永远是 null，但 `compactions` 数得对（4 次）。
 * 根因：Pi 的 usage 长在 `message.usage`，字段叫 `input` / `cacheRead`；
 *       我们只认 `usage.promptTokens` 和 `data.usage.*` ⇒ 一个都没匹配上。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { compactionStats } from '../_unattended/_收据统计.mjs'
import { dump } from './_助手.mjs'

test('Pi 形态：message.usage.input 能被认出来（上下文 = 输入 + 缓存读）', () => {
  const r = compactionStats([
    { type: 'message_end', message: { role: 'assistant', usage: { input: 9599, output: 142, cacheRead: 0 } } },
    { type: 'message_end', message: { role: 'assistant', usage: { input: 12000, output: 50, cacheRead: 800 } } }
  ])
  assert.equal(r.ctxPeak, 12800, '应取最大值，且把 cacheRead 算进上下文')
  assert.equal(r.compactions, 0)
  assert.equal(r.why, null)
  dump('pi-usage', r.ctxPeak)
})

test('压缩事件没有 tokensBefore 时，用"压缩前最后一次已知用量"顶替，不留空', () => {
  const r = compactionStats([
    { type: 'message_end', message: { usage: { input: 40949, cacheRead: 0 } } },
    { type: 'compaction_end', reason: 'threshold', result: { summary: 'x' } }
  ])
  assert.equal(r.compactions, 1)
  assert.equal(r.firstCompactionTokens, 40949, '载体不报 tokensBefore，就用最近一次已知用量')
})

test('载体报了 tokensBefore 时，优先用它（原文胜过推导）', () => {
  const r = compactionStats([
    { type: 'message_end', message: { usage: { input: 100 } } },
    { type: 'compaction_end', tokensBefore: 55555 }
  ])
  assert.equal(r.firstCompactionTokens, 55555)
  assert.equal(r.ctxPeak, 55555)
})
