/**
 * 阶段 0 · 统一 JSON 信封（§零.6）
 * 正向：合规信封能造、能读、能判绿；
 * 负向：缺字段 / stale / unknown / at 不可解析 / at 在未来 / source 写成路径 —— 一律不得当绿。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ENVELOPE_REQUIRED, ENVELOPE_SCHEMA,
  envelope, validateEnvelope, assertEnvelope, isFresh, envelopeGreen, healthOf, EnvelopeError
} from '../_unattended/契约/信封.mjs'
import { dump } from './_助手.mjs'

test('信封正好六个必填字段，与文档一字不差', () => {
  assert.deepEqual([...ENVELOPE_REQUIRED], ['schema', 'kind', 'at', 'source', 'state', 'stale'])
  const e = envelope({ kind: 'gate-result', source: '门禁.mjs', state: 'green' })
  for (const k of ENVELOPE_REQUIRED) assert.ok(Object.hasOwn(e, k), `缺 ${k}`)
  assert.equal(e.schema, ENVELOPE_SCHEMA)
  assert.equal(validateEnvelope(e).ok, true)
  dump('envelope-ok', e)
})

test('不传 state 时默认 unknown —— 默认值不能是"绿"', () => {
  const e = envelope({ kind: 'x', source: 'y.mjs' })
  assert.equal(e.state, 'unknown')
  assert.equal(envelopeGreen(e), false)
  assert.equal(healthOf(e), 'unknown')
})

test('负向：缺字段 / schema 不认 / stale 非布尔 / source 写路径 全部拦下', () => {
  const e = envelope({ kind: 'k', source: 'a.mjs', state: 'green' })
  for (const k of ENVELOPE_REQUIRED) {
    const clone = { ...e }
    delete clone[k]
    const r = validateEnvelope(clone)
    assert.equal(r.ok, false, `删掉 ${k} 后应不合规`)
    assert.deepEqual(r.missing, [k])
  }
  assert.equal(validateEnvelope({ ...e, schema: 2 }).ok, false)
  assert.equal(validateEnvelope({ ...e, stale: 'no' }).ok, false)
  assert.equal(validateEnvelope({ ...e, source: '面板/看板数据.mjs' }).ok, false)
  assert.equal(validateEnvelope({ ...e, state: '' }).ok, false)
  assert.equal(validateEnvelope(null).ok, false)
  assert.equal(validateEnvelope([]).ok, false)
  assert.throws(() => assertEnvelope({ kind: 'k' }, '单元'), EnvelopeError)
})

test('at 必须是可解析时间；未来时间算坏（有人在编时间）', () => {
  const e = envelope({ kind: 'k', source: 'a.mjs', state: 'green' })
  assert.equal(validateEnvelope({ ...e, at: '昨天' }).ok, false)
  assert.equal(validateEnvelope({ ...e, at: '2026-13-45T99:00:00Z' }).ok, false)
  const future = new Date(Date.now() + 30 * 60 * 1000).toISOString()
  const r = validateEnvelope({ ...e, at: future })
  assert.equal(r.ok, false)
  assert.ok(r.bad.some(x => /未来/.test(x)))
  // 5 分钟内的轻微偏差容忍（本机时钟抖动）
  const slightly = new Date(Date.now() + 60 * 1000).toISOString()
  assert.equal(validateEnvelope({ ...e, at: slightly }).ok, true)
})

test('envelopeGreen：只有"合规 + 非 stale + 非 unknown + 未过期"才是绿', () => {
  const green = envelope({ kind: 'k', source: 'a.mjs', state: 'green' })
  assert.equal(envelopeGreen(green), true)
  assert.equal(envelopeGreen({ ...green, stale: true }), false)
  assert.equal(envelopeGreen({ ...green, state: 'unknown' }), false)
  assert.equal(envelopeGreen({ ...green, state: 'red' }), false)
  const old = new Date(Date.now() - 3600_000).toISOString()
  assert.equal(envelopeGreen({ ...green, at: old }, { maxAgeSec: 60 }), false)
  assert.equal(envelopeGreen({ ...green, at: old }, { maxAgeSec: null }), true)
  assert.equal(envelopeGreen({ kind: 'k' }), false)
  assert.equal(envelopeGreen(null), false)
})

test('isFresh：无 maxAge 视为不过期，但 at 必须可解析', () => {
  const e = envelope({ kind: 'k', source: 'a.mjs', state: 'green' })
  assert.equal(isFresh(e), true)
  assert.equal(isFresh({ ...e, at: 'NaN' }), false)
  assert.equal(isFresh({}), false)
  assert.equal(isFresh(e, 0, Date.parse(e.at) + 1500), false)
})

test('healthOf 的三种输出，且"缺失"走 unknown 不走绿', () => {
  const green = envelope({ kind: 'k', source: 'a.mjs', state: 'green' })
  assert.equal(healthOf(green), 'green')
  assert.equal(healthOf({ ...green, state: 'red' }), 'red')
  assert.equal(healthOf(null), 'unknown')
  assert.equal(healthOf({}), 'unknown')
  assert.equal(healthOf({ ...green, state: 'unknown' }), 'unknown')
  assert.equal(healthOf({ ...green, stale: true }), 'unknown')
  dump('health-of', ['green', 'red', 'unknown(缺失)', 'unknown(未知)', 'unknown(stale)'])
})

test('信封可以另带 startedAt/endedAt，但 at 不能因此缺席', () => {
  const e = envelope({ kind: 'attempt', source: '状态服务', state: 'running', startedAt: '2026-10-25T00:00:00Z', endedAt: null })
  assert.ok(e.at)
  assert.equal(validateEnvelope(e).ok, true)
  const noAt = { ...e }
  delete noAt.at
  assert.equal(validateEnvelope(noAt).ok, false)
})
