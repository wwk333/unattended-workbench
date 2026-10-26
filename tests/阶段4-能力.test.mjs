/**
 * 阶段 4 · 能力/profile（§五）
 *
 * 逐条对照文档那张表：
 *   1M/100/70 + API 393K ⇒ reserve 300K / maxTokens 300K
 *   1M/100/50 ⇒ reserve 500K / maxTokens 393K（夹紧，不发 500K）
 *   1M/60/70 ⇒ 180K / 180K，重任务不派
 *   1M/100/80 ⇒ 200K / 200K，重任务不派
 *   缺 maxTokens ⇒ 配置缺失（不静默 16K）；缺 reserveTokens ⇒ 配置缺失
 *   同模型不同 API ⇒ 各自独立能力/独立 reserve，换 API 不继承
 *   同一载体两个 profile ⇒ 排队（不并发写 models.json/settings.json）
 *   routeDecision requested/selected/actual 不一致 ⇒ route-mismatch
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  loadCapabilities, capabilityOf, deriveProfile, isHeavyCapable, inspectPiConfig, planRoute, routeDecision,
  SAFETY_MARGIN, HEAVY_MIN_OUTPUT, CapabilityError
} from '../_unattended/_能力.mjs'
import { canRunConcurrently, assertConfigWriteAllowed, normalizeProfile } from '../_unattended/契约/画像.mjs'
import { fixture, cleanup, dump } from './_助手.mjs'

const NOW = new Date().toISOString()
const CAP_393 = { contextWindow: 1000000, maxOutputTokens: 393000, source: 'manual', at: NOW }

function capsOf (models) { return loadCapabilities({ version: 1, at: NOW, models }) }

function derive (ctx, comp, cap = CAP_393, provider = 'ark', model = 'm') {
  const caps = capsOf({ [`${provider}/${model}`]: cap })
  return deriveProfile({
    profile: { carrier: 'pi', provider, model, contextPct: ctx, compactionPct: comp },
    capability: capabilityOf(caps, { provider, model })
  })
}

test('1M / 100% / 70%，API 上限 393K ⇒ reserve=300K、maxTokens=300K、trigger=700K', () => {
  const d = derive(100, 70)
  assert.equal(d.ok, true, d.errors.join('；'))
  assert.equal(d.effectiveContext, 1_000_000)
  assert.equal(d.reserveTokens, 300_000)
  assert.equal(d.maxTokens, 300_000)
  assert.equal(d.triggerTokens, 700_000)
  assert.equal(d.availableAtTrigger, 300_000 - SAFETY_MARGIN)
  assert.equal(d.clamped, false)
  dump('derive-100-70', { reserve: d.reserveTokens, max: d.maxTokens, avail: d.availableAtTrigger })
})

test('1M / 100% / 50%，API 上限 393K ⇒ reserve=500K、maxTokens 夹到 393K（不发 500K）', () => {
  const d = derive(100, 50)
  assert.equal(d.reserveTokens, 500_000)
  assert.equal(d.maxTokens, 393_000)
  assert.equal(d.clamped, true)
  assert.ok(d.warnings.some(w => /夹到 API 上限/.test(w)))
})

test('1M / 60% / 70% ⇒ 180K / 180K（不再分重/轻任务）', () => {
  const d = derive(60, 70)
  assert.equal(d.effectiveContext, 600_000)
  assert.equal(d.reserveTokens, 180_000)
  assert.equal(d.maxTokens, 180_000)
  // ★ 2026-10-26（用户拍板）：heavyOk 这个概念已删除，派生结果里不该再有它
  assert.equal('heavyOk' in d, false, '派生结果不该再有 heavyOk（不再分重/轻任务）')
  assert.equal(isHeavyCapable(d), true, 'isHeavyCapable 退化为"派生成功"，恒真')
})

test('1M / 100% / 80% ⇒ 200K / 200K（整数不是 199999）', () => {
  const d = derive(100, 80)
  assert.equal(d.reserveTokens, 200_000)
  assert.equal(d.maxTokens, 200_000)
  assert.equal('heavyOk' in d, false)
})

test('新默认档：100% / 60% ⇒ 留 400K、可用 395,904（用户 2026-10-26 拍板，D-09 结案）', () => {
  // ★ 不再分重/轻任务：默认就用 60% 的最大上下文（原来 70%）。
  const d = derive(100, 60)
  assert.equal(d.effectiveContext, 1_000_000)
  assert.equal(d.reserveTokens, 400_000)
  assert.equal(d.triggerTokens, 600_000)
  assert.equal(d.availableAtTrigger, 395_904, 'reserve − 4096 安全边距')
  assert.equal('heavyOk' in d, false, '不再分重/轻任务 ⇒ 不该再有 heavyOk')
  dump('default-100-60', { reserve: d.reserveTokens, availableAtTrigger: d.availableAtTrigger })
})

test('负向：能力 unknown ⇒ 阻断，不许当 1M', () => {
  const caps = capsOf({})
  const cap = capabilityOf(caps, { provider: 'ark', model: 'nope' })
  assert.equal(cap.known, false)
  const d = deriveProfile({ profile: { carrier: 'pi', provider: 'ark', model: 'nope', contextPct: 100, compactionPct: 70 }, capability: cap })
  assert.equal(d.ok, false)
  assert.ok(d.errors.some(e => /capability-unknown/.test(e)))
  assert.equal(d.maxTokens, null)
})

test('负向：模型条目缺 maxOutputTokens ⇒ config-missing（不静默 16K）', () => {
  const d = derive(100, 70, { contextWindow: 1000000, source: 'manual', at: NOW })
  assert.equal(d.ok, false)
  assert.ok(d.errors.some(e => /config-missing:maxOutputTokens/.test(e)), d.errors.join('；'))
  dump('missing-maxOutputTokens', d.errors)
})

test('负向：缺 contextWindow ⇒ 能力未知', () => {
  const caps = capsOf({ 'ark/m': { maxOutputTokens: 393000, source: 'manual', at: NOW } })
  const cap = capabilityOf(caps, { provider: 'ark', model: 'm' })
  assert.equal(cap.known, false)
  assert.match(cap.why, /contextWindow/)
})

test('负向：算出来 reserve ≤ 0 ⇒ config-missing:reserveTokens（否则 Pi 走 16K、触发线≈98.4%）', () => {
  // 用一个很小的窗口 + 80% 阈值，让 reserve 仍 > 0；要构造 ≤0 得让 compactionPct=100（非法），
  // 所以这里直接测"派生函数对非法派生值的守卫"：手工传一个 availableAtTrigger<0 的能力。
  const d = deriveProfile({
    profile: { carrier: 'pi', provider: 'ark', model: 'm', contextPct: 30, compactionPct: 80 },
    capability: { known: true, provider: 'ark', model: 'm', contextWindow: 1_000, maxOutputTokens: 393_000, source: 'manual', at: NOW, stale: false }
  })
  // 1000 窗口 / 30% / 80% ⇒ eff=300, reserve=60, avail=-4036 ⇒ 负值必须报错
  assert.equal(d.reserveTokens, 60)
  assert.ok(d.errors.some(e => /config-invalid:availableAtTrigger/.test(e)), d.errors.join('；'))
})

test('同模型不同 API：各自独立能力、独立 reserve，换 API 不继承', () => {
  const caps = capsOf({
    'ark/m': { contextWindow: 1000000, maxOutputTokens: 393000, source: 'manual', at: NOW },
    'ocgo/m': { contextWindow: 1000000, maxOutputTokens: 128000, source: 'manual', at: NOW }
  })
  const a = deriveProfile({ profile: { carrier: 'pi', provider: 'ark', model: 'm', contextPct: 100, compactionPct: 50 }, capability: capabilityOf(caps, { provider: 'ark', model: 'm' }) })
  const b = deriveProfile({ profile: { carrier: 'pi', provider: 'ocgo', model: 'm', contextPct: 100, compactionPct: 50 }, capability: capabilityOf(caps, { provider: 'ocgo', model: 'm' }) })
  assert.equal(a.reserveTokens, b.reserveTokens)   // reserve 只由两个百分比决定
  assert.equal(a.maxTokens, 393_000)
  assert.equal(b.maxTokens, 128_000)               // 夹到各自 API 的上限
  assert.notEqual(a.maxTokens, b.maxTokens, '换 API 后 maxTokens 必须按新 API 重算，不继承')
  dump('two-apis', { ark: a.maxTokens, ocgo: b.maxTokens })
})

test('缺某家能力时**不借别家的值**（等价表只管能不能换，不管上限一样）', () => {
  const caps = capsOf({ 'ark/m': { contextWindow: 1000000, maxOutputTokens: 393000, source: 'manual', at: NOW } })
  const other = capabilityOf(caps, { provider: 'ocgo', model: 'm' })
  assert.equal(other.known, false, 'ocgo/m 没有精确键就必须 unknown，不许借 ark 的值')
  assert.match(other.why, /精确键/)
})

test('profile 枚举：只允许 30/60/100 与 50/60/70/80；默认 100/60', () => {
  const p = normalizeProfile({ carrier: 'pi', provider: 'ark', model: 'm' })
  assert.equal(p.contextPct, 100)
  assert.equal(p.compactionPct, 60)
  assert.throws(() => deriveProfile({ profile: { carrier: 'pi', provider: 'ark', model: 'm', contextPct: 55 }, capability: { known: true } }), /上下文比例/)
})

test('Pi 落地体检：全局 compaction.reserveTokens 必须删；modelOverrides 必须对；models.json 必须显式', () => {
  const d = derive(100, 70)
  const good = inspectPiConfig({
    models: { providers: { ark: { models: { m: { contextWindow: d.effectiveContext, maxTokens: d.maxTokens } } } } },
    settings: { compaction: { modelOverrides: { 'ark/m': { reserveTokens: d.reserveTokens } } } },
    derived: d
  })
  assert.equal(good.ok, true, good.errors.join('；'))

  const hasGlobal = inspectPiConfig({
    models: { providers: { ark: { models: { m: { contextWindow: d.effectiveContext, maxTokens: d.maxTokens } } } } },
    settings: { compaction: { reserveTokens: 300000, modelOverrides: { 'ark/m': { reserveTokens: d.reserveTokens } } } },
    derived: d
  })
  assert.equal(hasGlobal.ok, false)
  assert.ok(hasGlobal.errors.some(e => /全局.*compaction\.reserveTokens/.test(e)))

  const wrongModel = inspectPiConfig({
    models: { providers: { ark: { models: { m: { contextWindow: 128000, maxTokens: 16384 } } } } },
    settings: { compaction: { modelOverrides: { 'ark/m': { reserveTokens: d.reserveTokens } } } },
    derived: d
  })
  assert.equal(wrongModel.ok, false)
  assert.ok(wrongModel.errors.some(e => /contextWindow=128000/.test(e)))
  dump('pi-inspect', { good: good.ok, hasGlobal: hasGlobal.errors, wrong: wrongModel.errors })
})

test('同一载体两个不同 profile ⇒ 排队；配置只能在两个 attempt 之间写', () => {
  assert.equal(canRunConcurrently({ carrier: 'pi' }, { carrier: 'pi' }).ok, false)
  assert.match(canRunConcurrently({ carrier: 'pi' }, { carrier: 'pi' }).reason, /同一载体/)
  assert.equal(assertConfigWriteAllowed({ carrier: 'pi', runningAttempts: 0 }), true)
  assert.throws(() => assertConfigWriteAllowed({ carrier: 'pi', runningAttempts: 1 }), /不许并发写/)
})

test('路由：额度类只在同款模型内换 API；能力型才允许换模型', () => {
  const caps = capsOf({
    'ark/m': { contextWindow: 1000000, maxOutputTokens: 393000, source: 'manual', at: NOW },
    'ocgo/m': { contextWindow: 1000000, maxOutputTokens: 200000, source: 'manual', at: NOW },
    'ocgo/stronger': { contextWindow: 2000000, maxOutputTokens: 400000, source: 'manual', at: NOW }
  })
  const cands = [{ provider: 'ocgo', model: 'm' }, { provider: 'ocgo', model: 'stronger' }]
  // 额度失败场景：卡上那个 API 已经不健康了 ⇒ 才要换
  const quota = planRoute({ requested: { provider: 'ark', model: 'm' }, candidates: cands, caps, allowModelSwitch: false, requestedHealthy: false })
  assert.equal(quota.ok, true)
  assert.deepEqual(quota.selected, { provider: 'ocgo', model: 'm' })
  assert.ok(quota.considered.find(c => c.model === 'stronger').rejected, '额度类不许选别的模型')

  const cap = planRoute({ requested: { provider: 'ark', model: 'm' }, candidates: cands, caps, allowModelSwitch: true, requestedHealthy: false })
  assert.equal(cap.ok, true)
  assert.ok(cap.considered.some(c => c.model === 'stronger'))
})

test('路由：没有可用候选 ⇒ 不选（不硬凑）', () => {
  const caps = capsOf({})
  const r = planRoute({ requested: { provider: 'ark', model: 'm' }, candidates: [], caps, heavyTask: true })
  assert.equal(r.ok, false)
  assert.equal(r.selected, null)
  assert.match(r.why, /没有可用候选/)
})

test('routeDecision：requested/selected/actual 三者不一致 ⇒ route-mismatch', () => {
  const same = routeDecision({ requested: { provider: 'ark', model: 'm' }, selected: { provider: 'ark', model: 'm' }, actual: { provider: 'ark', model: 'm' } })
  assert.equal(same.ok, true)
  assert.equal(same.verdict, null)

  const drift = routeDecision({ requested: { provider: 'ark', model: 'm' }, selected: { provider: 'ark', model: 'm' }, actual: { provider: 'ocgo', model: 'm' } })
  assert.equal(drift.ok, false)
  assert.equal(drift.verdict, 'route-mismatch')
  assert.ok(drift.problems.some(p => p.kind === 'selected≠actual'))

  const selDrift = routeDecision({ requested: { provider: 'ark', model: 'm' }, selected: { provider: 'ocgo', model: 'm' }, actual: { provider: 'ocgo', model: 'm' } })
  assert.equal(selDrift.ok, false)
  dump('route-decision', { drift: drift.problems, sel: selDrift.problems })
})

test('能力表：能从文件加载；坏文件要报错而不是静默空表', () => {
  const dir = fixture({ '模型能力.json': JSON.stringify({ version: 1, at: NOW, models: { 'ark/m': CAP_393 } }) })
  try {
    const caps = loadCapabilities(join(dir, '模型能力.json'))
    assert.equal(caps.byKey.size, 1)
    assert.equal(capabilityOf(caps, { provider: 'ark', model: 'm' }).known, true)
    assert.throws(() => loadCapabilities(join(dir, 'nope.json')), CapabilityError)
    writeFileSync(join(dir, 'bad.json'), '{坏', 'utf8')
    assert.throws(() => loadCapabilities(join(dir, 'bad.json')), SyntaxError)
  } finally { cleanup(dir) }
})

test('stale 能力：过期只警告，不阻断轻任务', () => {
  const old = new Date(Date.now() - 30 * 86400_000).toISOString()
  const caps = capsOf({ 'ark/m': { contextWindow: 1000000, maxOutputTokens: 393000, source: 'manual', at: old } })
  const cap = capabilityOf(caps, { provider: 'ark', model: 'm' })
  assert.equal(cap.known, true)
  assert.equal(cap.stale, true)
  const d = deriveProfile({ profile: { carrier: 'pi', provider: 'ark', model: 'm' }, capability: cap })
  assert.equal(d.ok, true)
  assert.ok(d.warnings.some(w => /过期/.test(w)))
})
