/**
 * 限流拆分 + 退避（2026-10-26）
 *
 * 事故：`judge()` 原来把 `429` 和 `401/403/quota` 挤在同一个正则里 ⇒ 一次**限流**就被判成
 * `account`（账号/额度故障）⇒ 要么整轮停手、要么立刻换 API（烧掉一个还能用的家）。
 *
 * 依据（本机实测，490 个 DSH 会话、2745 次 `llm/retry`）：
 *   RATE_LIMIT × 2009（73%）／TRANSPORT × 550／TIMEOUT × 173／SERVER × 13
 *   —— 限流是**等一等就好**的抖动，和"没额度/坏 key"不是一回事。
 *
 * 这组测试锁三件事：
 *   ① 限流先判、不被 `exceeded` 抢走；② 账号类仍归 account；③ 退避时长可算、可夹、可被 Retry-After 覆盖。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  classifyRetryableFailure, isRateLimit, parseRetryAfterMs, backoffDelayMs, waitPlan,
} from '../_unattended/_退避.mjs'
import {
  MATRIX, OK_VERDICTS, NEVER_RESCUE, API_SWITCH_VERDICTS,
  forVerdict, canRescue, canSwitchApi, canSwitchModel, failoverAllowed, autoOf,
} from '../_unattended/_失败处置.mjs'
import { dump } from './_助手.mjs'

test('① 429 判限流（**不再判 account**——这是这组测试要钉的回归点）', () => {
  for (const s of [
    'HTTP 429 Too Many Requests',
    '{"error":{"code":429,"message":"..."}}',
    'Error: rate limit exceeded',
    'RATE_LIMIT reached, please retry',
    '请求过于频繁，请稍后再试',
    '触发限流：每分钟 60 次',
  ]) {
    assert.equal(classifyRetryableFailure(s), 'rate-limit', `应判限流：${s}`)
    assert.equal(isRateLimit(s), true, `isRateLimit 应为真：${s}`)
  }
  dump('rate-classify-cases', ['429', 'rate limit exceeded', '请求过于频繁'])
})

test('② 账号/额度类仍归 account（这些"等"没用，只能换 API 或换 key）', () => {
  for (const s of [
    'HTTP 401 Unauthorized',
    '403 Forbidden',
    'insufficient quota',
    'quota exceeded for this billing period',
    'invalid api key',
    '额度不足，请充值',
  ]) {
    assert.equal(classifyRetryableFailure(s), 'account', `应判账号类：${s}`)
    assert.equal(isRateLimit(s), false, `不该判限流：${s}`)
  }
})

test('③ 传输/超时类**不归**这两类（交给 flaky / no-start，别抢它们的活）', () => {
  for (const s of ['Connection error.', 'ECONNRESET', 'socket hang up', 'ETIMEDOUT', 'no ack in 120s']) {
    assert.equal(classifyRetryableFailure(s), null, `不该归限流/账号：${s}`)
  }
})

test('④ 空输入不炸、不猜', () => {
  for (const s of [null, undefined, '', '   ']) assert.equal(classifyRetryableFailure(s), null)
})

test('⑤ Retry-After 解析：秒 / 毫秒 / 中文 / 不认识的返回 null', () => {
  assert.equal(parseRetryAfterMs('429 retry after 5'), 5000)
  assert.equal(parseRetryAfterMs('Retry-After: 12'), 12000)
  assert.equal(parseRetryAfterMs('retry_after=3'), 3000)
  assert.equal(parseRetryAfterMs('retry after 500ms'), 500)
  assert.equal(parseRetryAfterMs('请在 30 秒后重试'), 30000)
  assert.equal(parseRetryAfterMs('429 Too Many Requests'), null, '没给时间就不许编')
  assert.equal(parseRetryAfterMs('retry after 9999'), 120000, '要夹在上限内')
  assert.equal(parseRetryAfterMs(''), null)
})

test('⑥ 退避：第 1 次 base、之后翻倍、封顶 cap（jitter=0 时确定性）', () => {
  const o = { baseMs: 20_000, capMs: 60_000, jitterRatio: 0 }
  assert.equal(backoffDelayMs(1, o), 20_000)
  assert.equal(backoffDelayMs(2, o), 40_000)
  assert.equal(backoffDelayMs(3, o), 60_000, '60s 封顶')
  assert.equal(backoffDelayMs(9, o), 60_000, '再久也不许超过 cap')
  assert.equal(backoffDelayMs(0, o), 20_000, '0/负数按第 1 次算')
})

test('⑦ 退避抖动只往下减，绝不超上限（防并行卡同时醒来再撞限流）', () => {
  const o = { baseMs: 20_000, capMs: 60_000, jitterRatio: 0.2 }
  assert.equal(backoffDelayMs(1, { ...o, rng: () => 1 }), 16_000)
  assert.equal(backoffDelayMs(1, { ...o, rng: () => 0 }), 20_000)
  for (const r of [0, 0.13, 0.5, 0.99, 1]) {
    const v = backoffDelayMs(3, { ...o, rng: () => r })
    assert.ok(v <= 60_000, `抖动后不许超 cap（r=${r} got ${v}）`)
  }
})

test('⑧ 等多久：服务端说了就听，没给才走默认退避', () => {
  const a = waitPlan('429 retry after 7', 1, { baseMs: 20_000, jitterRatio: 0 })
  assert.deepEqual(a, { ms: 7000, source: 'retry-after' })
  const b = waitPlan('429 Too Many Requests', 2, { baseMs: 20_000, capMs: 60_000, jitterRatio: 0 })
  assert.deepEqual(b, { ms: 40_000, source: 'backoff' })
})

test('⑨ 矩阵契约：rate-limit 只许退避重试，rate-limit-final 才许换家', () => {
  const first = forVerdict('rate-limit')
  assert.ok(first, 'rate-limit 必须在 MATRIX 里（否则起飞前检查 ⑯ 会红）')
  assert.equal(first.auto, 'retry')
  assert.equal(failoverAllowed('rate-limit'), false, '首跳不许换家（先等）')
  assert.equal(canSwitchApi('rate-limit'), false)
  assert.equal(autoOf('rate-limit'), 'retry')

  const final = forVerdict('rate-limit-final')
  assert.ok(final, 'rate-limit-final 必须在 MATRIX 里')
  assert.equal(failoverAllowed('rate-limit-final'), true, '退避过还限流 ⇒ 换通道')
  assert.equal(canSwitchApi('rate-limit-final'), true)
  assert.ok(API_SWITCH_VERDICTS.includes('rate-limit-final'))

  // 都不许急救（限流/账号不是"模型太弱"，换最强的模型也一样被限流）
  assert.equal(canRescue('rate-limit'), false)
  assert.equal(canRescue('rate-limit-final'), false)
  assert.ok(NEVER_RESCUE.includes('rate-limit') && NEVER_RESCUE.includes('rate-limit-final'))
  // 都不许换模型
  assert.equal(canSwitchModel('rate-limit'), false)
  assert.equal(canSwitchModel('rate-limit-final'), false)
  // 都不是"收下了"
  assert.equal(OK_VERDICTS.includes('rate-limit'), false)
  assert.equal(OK_VERDICTS.includes('rate-limit-final'), false)
})

test('⑩ 矩阵里没有重复判决（加行不许和老的撞名）', () => {
  const names = MATRIX.map((m) => m.verdict)
  assert.equal(new Set(names).size, names.length, 'MATRIX 有重复判决名')
  assert.ok(names.includes('rate-limit') && names.includes('rate-limit-final'))
})

// ─────────────────────────────────────────────────────────────────────────────
// ⑪ 接线锁（静态）：纯函数测过 ≠ 接线了。
//   2026-10-26 之前踩过"改了模块、主流程还在走老路"（改了没验），所以这里直接读源码断言三件事：
//     ① `judge()` 里的旧账号正则**不再含 429**；② 限流判定在账号判定**之前**；③ 重试前**真会 await 等待**。
// ─────────────────────────────────────────────────────────────────────────────
test('⑪ 接线：429 已从账号正则里拆走，限流判定在账号之前，重试前真的 await 退避', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../_unattended/编排.mjs', import.meta.url), 'utf8')

  assert.equal(/\/401\|403\|429\//.test(src), false, '旧账号正则 `/401|403|429/` 必须消失（429 归限流）')
  assert.ok(src.includes('classifyRetryableFailure(failBlob)'), 'judge() 必须调用纯函数判限流')

  const iRate = src.indexOf("if (retryCls === 'rate-limit')")
  const iAcct = src.indexOf("if (retryCls === 'account')")
  assert.ok(iRate > 0 && iAcct > 0, '两个分支都要在')
  assert.ok(iRate < iAcct, '限流必须先判（否则 `exceeded` 会把它抢去账号类）')

  // 重试前必须真的等，而不是只打一行日志
  assert.ok(src.includes('waitPlan('), '重试前要算等待时长（waitPlan）')
  assert.ok(/await new Promise\(\(r\) => setTimeout\(r, rateWaitMs\)\)/.test(src), '算了不 await 等于没等')
  assert.ok(src.includes("verdict: 'rate-limit-final'"), '退避后仍限流要能落到 rate-limit-final（才允许换家）')
})
