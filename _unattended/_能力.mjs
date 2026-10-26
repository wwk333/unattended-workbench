/**
 * 能力/profile —— **两个百分比驱动压缩与输出**（施工文档 §五）
 *
 * 用户只填两个东西：**上下文比例**（30/60/100%）和**压缩阈值**（50/60/70/80%）。
 * 其余全是**派生值**，不让用户填、也不许各处在算第二遍：
 *
 * ```text
 * effectiveContext   = X × contextPct
 * reserveTokens      = effectiveContext × (1 - compactionPct)
 * maxTokens          = min(reserveTokens, 当前 API 的 maxOutputTokens)
 * triggerTokens      = effectiveContext - reserveTokens
 * availableAtTrigger = reserveTokens - 4096          ← Pi 的 buildBaseOptions 还会夹这一层
 * ```
 *
 * ## 为什么要有它（真事）
 * coder-a 的 `ark/deepseek-v4.1-flash` 能力是 unknown；Pi 自定义 provider 没写
 * `contextWindow/maxTokens` ⇒ Pi 回落到默认 128K/16K；而项目全局 `reserveTokens=300000` 比 128K 还大
 * ⇒ **触发线算成负数**，T1-07 一卡压缩 59 次。根因不是模型不行，是**没有一处按"API+模型"算这件事**。
 *
 * ## 铁律
 * 1. 能力键 = **API + 模型**（`provider/model`）。换 API 必须**重新读该 API 的上限并重算**，不继承旧值。
 * 2. `maxTokens` / `reserveTokens` 都是**派生字段**，不设用户级 `requestMaxTokens`。
 * 3. 缺 `maxOutputTokens` 或缺 reserve ⇒ **阻断**，绝不静默走 Pi 默认 16K。
 * 4. 同一载体 `maxConcurrent=1`；不同 profile 排队，配置只在两个 attempt 之间写。
 * 5. "重任务至少 300K 输出"只是**派活筛选条件**，不是配置非法条件（§五）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { DEFAULT_CONTEXT_PCT, DEFAULT_COMPACTION_PCT, normalizeProfile, profileKey } from './契约/画像.mjs'
import { routeMismatch } from './_派活内核.mjs'

/** Pi 的 buildBaseOptions 会按 `contextWindow - 当前上下文 - 4096` 再夹紧 maxTokens（§五） */
export const SAFETY_MARGIN = 4096
/** 「重任务至少 300K 输出」—— 派活筛选条件 */
// ⚠️ 2026-10-26 起**不再作为派活门槛**（用户：不分重/轻任务）。
//   保留导出只为兼容旧引用；判据已删除，别再用它拦人。
export const HEAVY_MIN_OUTPUT = 300_000
/** 能力数据超过这么久没更新 ⇒ 标 stale（不阻断轻任务，但重任务不派） */
export const CAPABILITY_STALE_DAYS = 14

export class CapabilityError extends Error {
  constructor (code, msg, detail) {
    super(`[能力] ${msg}${detail ? `（${detail}）` : ''}`)
    this.name = 'CapabilityError'
    this.code = code
    this.detail = detail ?? null
  }
}

// ---------------------------------------------------------------- 能力表

/**
 * 把 `模型能力.json` 装成"精确键"索引。
 * 只认 `provider/model` 精确键 —— **不按模型 id 借别人的值**（§五：two APIs' limits differ）。
 * @returns {{ byKey: Map<string,object>, at: string|null, version: number|null, path: string|null }}
 */
export function loadCapabilities (reg, { path = null } = {}) {
  let data = reg
  if (typeof reg === 'string') {
    if (!existsSync(reg)) throw new CapabilityError('E_NO_FILE', `能力表不存在：${reg}`)
    data = JSON.parse(readFileSync(reg, 'utf8').replace(/^\uFEFF/, ''))
    path = reg
  }
  const models = data?.models ?? {}
  const byKey = new Map(Object.entries(models).map(([k, v]) => [String(k), v]))
  return { byKey, at: data?.at ?? null, version: data?.version ?? null, path }
}

/**
 * 取某个「API + 模型」的能力。**取不到就是 unknown**（不许猜成 1M）。
 *
 * ★ 2026-10-26：`known` 拆成三个键，因为三种缺失的处置不同：
 *   · 缺 `contextWindow` ⇒ **能力未知**（连窗口都不知道，没法算）
 *   · 缺 `maxOutputTokens` ⇒ **配置缺失**（窗口知道、输出上限不知道 —— 不许静默走 16K）
 *   · 两个都有 ⇒ `known:true`
 * @returns {{ known:boolean, contextKnown:boolean, outputKnown:boolean, provider, model, key,
 *             contextWindow:number|null, maxOutputTokens:number|null, source:string|null, at:string|null,
 *             stale:boolean, why:string|null }}
 */
export function capabilityOf (caps, { provider, model }, { now = Date.now(), staleDays = CAPABILITY_STALE_DAYS } = {}) {
  const key = `${provider}/${model}`
  const base = { known: false, contextKnown: false, outputKnown: false, provider, model, key, contextWindow: null, maxOutputTokens: null, source: null, at: null, stale: true, why: null }
  const e = caps?.byKey?.get(key) ?? null
  if (!e) return { ...base, why: `能力表里没有精确键 ${key}（换 API 必须重新读上限，不继承别的 API 的值）` }

  const cw = Number(e.contextWindow)
  const mo = Number(e.maxOutputTokens)
  const hasCw = Number.isFinite(cw) && cw > 0
  const hasMo = Number.isFinite(mo) && mo > 0
  const at = e.at ?? null
  const stale = at ? (now - Date.parse(at)) > staleDays * 86400_000 : true
  const missing = []
  if (!hasCw) missing.push('contextWindow')
  if (!hasMo) missing.push('maxOutputTokens')
  return {
    known: hasCw && hasMo,
    contextKnown: hasCw,
    outputKnown: hasMo,
    provider,
    model,
    key,
    contextWindow: hasCw ? cw : null,
    maxOutputTokens: hasMo ? mo : null,
    source: e.source ?? null,
    at,
    stale,
    why: missing.length ? `${key} 缺 ${missing.join('/')}（不许静默走 Pi 默认 128K/16K）` : null
  }
}

/** @deprecated 2026-10-26：不再分重/轻任务；保留函数只为兼容，恒等于"派生成功"。 */
export function isHeavyCapable (derived) {
  return derived?.ok === true
}

// ---------------------------------------------------------------- 派生

/**
 * 两个百分比 ⇒ 全部派生值。
 *
 * @param {object} o
 * @param {object} o.profile      {carrier, provider, model, contextPct, compactionPct}
 * @param {object} o.capability   `capabilityOf()` 的结果
 * @returns {{ ok:boolean, errors:string[], warnings:string[], profile:object, capability:object,
 *             effectiveContext:number|null, reserveTokens:number|null, maxTokens:number|null,
 *             triggerTokens:number|null, availableAtTrigger:number|null,
 *             clamped:boolean, heavyOk:boolean, pi:object|null }}
 */
export function deriveProfile ({ profile, capability, safetyMargin = SAFETY_MARGIN, heavyMinOutput = HEAVY_MIN_OUTPUT } = {}) {
  const errors = []
  const warnings = []
  const p = normalizeProfile(profile) // 校验枚举 + 补默认（30/60/100、50/60/70/80）
  const cap = capability ?? { known: false, why: '没有能力数据' }

  if (!cap.known) {
    // 区分两种缺失：连窗口都不知道（能力未知）vs 只有输出上限不知道（配置缺失）
    if (cap.contextKnown === false) {
      errors.push(`capability-unknown：${cap.why ?? `${cap.provider}/${cap.model} 能力未知`}`)
      return { ok: false, errors, warnings, profile: p, capability: cap, effectiveContext: null, reserveTokens: null, maxTokens: null, triggerTokens: null, availableAtTrigger: null, clamped: false, heavyOk: false, pi: null }
    }
    // contextKnown === true 但 outputKnown === false ⇒ 落到下面的 config-missing:maxOutputTokens
  }
  // 缺 maxOutputTokens ⇒ 配能力缺失，不静默 16K
  if (!Number.isFinite(cap.maxOutputTokens) || cap.maxOutputTokens <= 0) {
    errors.push('config-missing:maxOutputTokens：该 API 的输出上限缺失 ⇒ 阻断（不许静默走 16K）')
  }

  const X = Number(cap.contextWindow)
  // ★ 用整数运算再取整：`1 - 80/100` 在浮点下是 0.19999999999999996，
  //   直接 floor 会把 200000 算成 199999（实测踩到）。口径必须是文档那张表里的整数。
  const effectiveContext = Math.round(X * (p.contextPct / 100))
  const reserveTokens = Math.round(effectiveContext * (100 - p.compactionPct) / 100)
  const maxTokensRaw = reserveTokens
  const maxTokens = Math.min(maxTokensRaw, Number(cap.maxOutputTokens) || 0)
  const triggerTokens = effectiveContext - reserveTokens
  const availableAtTrigger = reserveTokens - safetyMargin
  const clamped = Number(cap.maxOutputTokens) > 0 && maxTokensRaw > Number(cap.maxOutputTokens)

  // 缺 reserve ⇒ 配置缺失（Pi 会回落 16K，触发线会变成 98.4%）
  if (!Number.isFinite(reserveTokens) || reserveTokens <= 0) {
    errors.push('config-missing:reserveTokens：算出来的 reserveTokens <= 0 ⇒ 阻断（否则 Pi 走默认 16K，触发线≈98.4%）')
  }
  if (availableAtTrigger < 0) {
    errors.push(`config-invalid:availableAtTrigger：reserve(${reserveTokens}) - ${safetyMargin} < 0 ⇒ 触发点附近没有可用输出`)
  }
  if (clamped) {
    warnings.push(`maxTokens 从 ${maxTokensRaw} 夹到 API 上限 ${cap.maxOutputTokens}（不发 ${maxTokensRaw}，否则 API 会 400）`)
  }
  if (cap.stale) {
    warnings.push(`能力数据过期（at=${cap.at ?? 'null'}）—— 轻任务可用，重任务按 availableAtTrigger 判`)
  }

  // ★ 2026-10-26：删掉 heavyOk/heavyWhy —— 不再分重/轻任务。
  const _unusedHeavy = (availableAtTrigger >= 0) ? null : `availableAtTrigger=${availableAtTrigger} < ${0} ⇒ 该 profile 不接重任务（换 profile/载体或调上下文/阈值）`

  // Pi 落地：models.json 显式写 contextWindow/maxTokens；settings.json 用 modelOverrides，**不写全局 reserveTokens**
  const pi = {
    provider: p.provider,
    model: p.model,
    models: { contextWindow: effectiveContext, maxTokens },
    settings: { modelOverrides: { [`${p.provider}/${p.model}`]: { reserveTokens } } }
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    profile: p,
    capability: cap,
    effectiveContext,
    reserveTokens,
    maxTokens,
    triggerTokens,
    availableAtTrigger,
    clamped,
    pi
  }
}

/**
 * Pi 配置体检（生成视图 vs 派生值）。**只读**，不改文件。
 * 检查 §五 的三条落地口径：
 *   ① `models.json` 每个模型显式写 `contextWindow = effectiveContext`、`maxTokens = min(reserve, API 上限)`；
 *   ② `settings.json` 用 `compaction.modelOverrides["provider/model"].reserveTokens`；
 *   ③ **全局 `compaction.reserveTokens` 必须删掉**（它在 128K 模型上会把触发线算成负数）。
 *
 * @param {object} o
 * @param {object} o.models    解析后的 Pi `models.json`
 * @param {object} o.settings  解析后的 Pi `settings.json`
 * @param {object} o.derived   `deriveProfile()` 的结果
 * @returns {{ ok:boolean, errors:string[], warnings:string[] }}
 */
export function inspectPiConfig ({ models = null, settings = null, derived } = {}) {
  const errors = []
  const warnings = []
  if (!derived || !derived.ok) return { ok: false, errors: ['没有可用的派生值，无法体检 Pi 配置'], warnings }

  const provider = derived.profile.provider
  const model = derived.profile.model
  const wantCtx = derived.effectiveContext
  const wantMax = derived.maxTokens
  const wantReserve = derived.reserveTokens

  if (models && typeof models === 'object') {
    // Pi 的 models.json 形状：{ providers: { [provider]: { models: { [model]: {...} } } } }
    const entry = models?.providers?.[provider]?.models?.[model] ?? models?.[`${provider}/${model}`] ?? null
    if (!entry) {
      errors.push(`models.json 里没有 ${provider}/${model} 的条目`)
    } else {
      if (Number(entry.contextWindow) !== wantCtx) errors.push(`models.json contextWindow=${entry.contextWindow} ≠ 派生 ${wantCtx}`)
      if (Number(entry.maxTokens) !== wantMax) errors.push(`models.json maxTokens=${entry.maxTokens} ≠ 派生 ${wantMax}`)
    }
  }

  if (settings && typeof settings === 'object') {
    const globalReserve = settings?.compaction?.reserveTokens
    if (globalReserve !== undefined && globalReserve !== null) {
      errors.push(`settings.json 里还有**全局** compaction.reserveTokens=${globalReserve} —— 必须删除（按模型写在 modelOverrides 里）`)
    }
    const ov = settings?.compaction?.modelOverrides?.[`${provider}/${model}`]?.reserveTokens
    if (ov === undefined) errors.push(`settings.json 缺 compaction.modelOverrides["${provider}/${model}"].reserveTokens`)
    else if (Number(ov) !== wantReserve) errors.push(`modelOverrides reserveTokens=${ov} ≠ 派生 ${wantReserve}`)
  }

  return { ok: errors.length === 0, errors, warnings }
}

// ---------------------------------------------------------------- 路由

/**
 * 选择要用的 API/模型（§五「路由与 failover」）。
 *
 * 纪律：
 *   · **额度/限流/坏 key** ⇒ 只在**同一逻辑模型**的不同 API 之间换（`allowModelSwitch=false`）；
 *   · **能力不足** ⇒ 才允许换模型（`allowModelSwitch=true`）；
 *   · `providerOrder` 只做同能力候选排序，**不先于能力过滤**；
 *   · 能力 unknown 的重任务**不选**；
 *   · 不保留永久粘住的 `failover.idx`（按健康状态现算）。
 *
 * @param {object} o
 * @param {object} o.requested          卡上写的 {provider, model}
 * @param {object[]} o.candidates       候选 [{provider, model, healthy, order}]
 * @param {object} o.caps               能力表（loadCapabilities 结果）
 * @param {boolean} [o.heavyTask]       是不是重任务
 * @param {boolean} [o.allowModelSwitch] 是否允许换模型（只有能力不足才 true）
 * @param {boolean} [o.requestedHealthy] 卡上写的那个 API 现在健不健康（额度失败时为 false）
 * @returns {{ ok:boolean, selected:object|null, why:string, considered:object[] }}
 */
export function planRoute ({ requested, candidates = [], caps, heavyTask = false, allowModelSwitch = false, requestedHealthy = true } = {}) {
  if (!requested?.provider || !requested?.model) {
    return { ok: false, selected: null, why: '卡上没写 requested provider/model', considered: [] }
  }
  // 若候选里就有 requested 本身，以候选的健康状态为准（调用方不需要重复声明）
  const self = candidates.find(c => c && c.provider === requested.provider && c.model === requested.model)
  const reqHealthy = self ? self.healthy !== false : requestedHealthy !== false
  const list = [
    { ...requested, healthy: reqHealthy, order: 0, sameModel: true },
    ...candidates.filter(c => c && c.provider && c.model && !(c.provider === requested.provider && c.model === requested.model)).map((c, i) => ({
      ...c,
      healthy: c.healthy !== false,
      order: Number.isFinite(c.order) ? c.order : i + 1,
      sameModel: c.model === requested.model
    }))
  ]
  const considered = []
  const viable = []
  for (const c of list) {
    const cap = capabilityOf(caps, { provider: c.provider, model: c.model })
    const row = { ...c, capability: { known: cap.known, contextWindow: cap.contextWindow, maxOutputTokens: cap.maxOutputTokens }, rejected: null }
    if (!c.sameModel && !allowModelSwitch) row.rejected = '模型不同（额度类失败不许换模型）'
    else if (!c.healthy) row.rejected = '健康状态不绿'
    // ★ 2026-10-26：不分重/轻 —— 能力 unknown 一律不派（不知道窗口就没法算预算）。
    else if (!cap.known) row.rejected = '能力 unknown（不知道上下文窗口/输出上限）⇒ 不派'
    considered.push(row)
    if (!row.rejected) viable.push(row)
  }
  // 排序：同模型优先 → 健康 → providerOrder（只做最后 tiebreak）
  viable.sort((a, b) => (Number(b.sameModel) - Number(a.sameModel)) || (a.order - b.order))
  if (!viable.length) {
    return { ok: false, selected: null, why: '没有可用候选（能力/健康/模型限制都过不了）', considered }
  }
  const sel = viable[0]
  return {
    ok: true,
    selected: { provider: sel.provider, model: sel.model },
    why: sel.sameModel ? '同款模型内的可用 API' : '能力路由（允许换模型）',
    considered
  }
}

/**
 * 一次调用的 routeDecision：`requested`（卡上写的）/`selected`（路由选的）/`actual`（事件流回读的）。
 * 三者不一致 ⇒ `route-mismatch`，**复核/阻断，不静默**（§五 / §六）。
 */
export function routeDecision ({ requested = null, selected = null, actual = null } = {}) {
  const problems = []
  const selMismatch = selected && requested ? routeMismatch(requested, selected) : null
  if (selMismatch) problems.push({ kind: 'requested≠selected', fields: selMismatch.fields })
  const actMismatch = actual ? routeMismatch(selected ?? requested, actual) : null
  if (actMismatch) problems.push({ kind: 'selected≠actual', fields: actMismatch.fields, detail: actMismatch })
  return {
    ok: problems.length === 0,
    problems,
    verdict: problems.length ? 'route-mismatch' : null,
    requested,
    selected,
    actual
  }
}
