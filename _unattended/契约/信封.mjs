/**
 * 契约/信封 —— **统一 JSON 信封**（施工文档 §零.6）
 *
 * 所有机器产物至少带：
 *   { "schema": 1, "kind": "...", "at": "...", "source": "...", "state": "...", "stale": false }
 *
 * 为什么：以前每份 JSON 各写各的字段名（`updatedAt` / `checkedAt` / `stamp` / 没有时间），
 * 消费方（看板/交付门/体检）只好逐个猜，猜错就把 3 天前的旧结论当现在。信封统一后，
 * **"这份东西什么时候写的、谁写的、还能不能信"变成机器可判的一件事**。
 *
 * 纪律：
 *   · 时间字段可以另带 `startedAt/endedAt`，但**必须同时有 `at`** 供新鲜度判断；
 *   · 缺信封、`unknown`、`stale:true` 一律不得被看板/交付门当绿（`envelopeGreen()` 就是这条的唯一实现）；
 *   · 不要在这里做业务判断 —— 这里只回答"信封合不合规 / 新不新鲜 / 能不能当绿"。
 */

import { UNKNOWN } from './枚举.mjs'

export const ENVELOPE_SCHEMA = 1
export const ENVELOPE_REQUIRED = Object.freeze(['schema', 'kind', 'at', 'source', 'state', 'stale'])

export class EnvelopeError extends Error {
  constructor (why, detail) {
    super(`[信封] ${why}${detail ? `（${detail}）` : ''}`)
    this.name = 'EnvelopeError'
    this.code = 'E_ENVELOPE'
    this.detail = detail ?? null
  }
}

/**
 * 造一个信封合规的对象。
 * @param {object} o
 * @param {string} o.kind      产物类别，如 release-status / gate-result / attempt / 看护状态
 * @param {string} o.source    写方文件名（唯一写方，见 _核心契约.json）
 * @param {string} [o.state]   状态值；不传则 'unknown'（**不会被当绿**）
 * @param {string} [o.at]      ISO 时间；默认现在
 * @param {boolean} [o.stale]  是否过期；默认 false
 */
export function envelope ({ kind, source, state = UNKNOWN, at, stale = false, ...rest }) {
  if (!kind) throw new EnvelopeError('缺 kind')
  if (!source) throw new EnvelopeError('缺 source（唯一写方必须自报家门）')
  return {
    schema: ENVELOPE_SCHEMA,
    kind,
    at: at ?? new Date().toISOString(),
    source,
    state,
    stale: stale === true,
    ...rest
  }
}

/**
 * 校验信封。返回 { ok, missing[], bad[], value }。
 * 不抛 —— 体检/交付门需要"列举所有问题"，抛第一个会掩盖后面的。
 */
export function validateEnvelope (obj) {
  const missing = []
  const bad = []
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, missing: ENVELOPE_REQUIRED.slice(), bad: ['不是 JSON 对象'], value: obj }
  }
  for (const k of ENVELOPE_REQUIRED) if (!Object.hasOwn(obj, k)) missing.push(k)

  if (Object.hasOwn(obj, 'schema') && obj.schema !== ENVELOPE_SCHEMA) {
    bad.push(`schema=${JSON.stringify(obj.schema)}（只认 ${ENVELOPE_SCHEMA}）`)
  }
  for (const k of ['kind', 'source', 'state']) {
    if (Object.hasOwn(obj, k) && (typeof obj[k] !== 'string' || !obj[k].trim())) bad.push(`${k} 必须是非空字符串`)
  }
  if (Object.hasOwn(obj, 'source') && /[\\/]/.test(String(obj.source))) {
    multiWriterHint(obj.source, bad)
  }
  if (Object.hasOwn(obj, 'at')) {
    const t = Date.parse(obj.at)
    if (!Number.isFinite(t)) bad.push(`at 不是可解析时间：${JSON.stringify(obj.at)}`)
    else if (t > Date.now() + 5 * 60 * 1000) bad.push('at 在未来（时钟不对或有人编时间）')
  }
  if (Object.hasOwn(obj, 'stale') && typeof obj.stale !== 'boolean') bad.push('stale 必须是布尔')

  return { ok: missing.length === 0 && bad.length === 0, missing, bad, value: obj }
}

/** source 写成路径时提示：唯一写方登记要的是文件名，不是一个可能有两个写方的目录 */
function multiWriterHint (source, bad) {
  bad.push(`source 应写唯一写方文件名，不要写路径：${JSON.stringify(source)}`)
}

/** 断言信封合规，否则抛 */
export function assertEnvelope (obj, label = '') {
  const r = validateEnvelope(obj)
  if (!r.ok) {
    throw new EnvelopeError(`不合规${label ? ` @${label}` : ''}`, [...r.missing.map(x => `缺 ${x}`), ...r.bad].join('；'))
  }
  return obj
}

/** 新鲜度：无 maxAgeSec 视为"不过期"，但仍要求 at 可解析 */
export function isFresh (obj, maxAgeSec = null, now = Date.now()) {
  if (!obj || typeof obj.at !== 'string') return false
  const t = Date.parse(obj.at)
  if (!Number.isFinite(t)) return false
  if (maxAgeSec === null || maxAgeSec === undefined) return t <= now + 5 * 60 * 1000
  return now - t <= maxAgeSec * 1000
}

/** "绿"的合法状态词。**白名单**：没登记的词不算绿（宁可显示未知，也不许"看着像绿就当绿"）。 */
export const GREEN_STATES = Object.freeze(['green', 'ok'])

/** 黄/警告类状态（能当"已知但不绿"用，绝不是绿） */
export const YELLOW_STATES = Object.freeze(['yellow', 'warn', 'degraded'])

/**
 * **能不能当绿** —— 全系统唯一判据。
 * 缺信封 / state 是 unknown / state 不在绿名单 / stale:true / 过期 ⇒ 都不是绿。
 * 别再在别的文件里写 `state === 'green'` 就算绿（那正是"假绿"的来源）。
 */
export function envelopeGreen (obj, { maxAgeSec = null, now = Date.now(), greenStates = GREEN_STATES } = {}) {
  if (validateEnvelope(obj).ok !== true) return false
  if (obj.stale === true) return false
  if (obj.state === UNKNOWN || obj.state == null) return false
  if (!greenStates.includes(obj.state)) return false
  return isFresh(obj, maxAgeSec, now)
}

/** 看板/交付门用的四态投影：green / yellow / red / unknown —— 永远不要出现"缺失≈绿" */
export function healthOf (obj, opts = {}) {
  if (!obj) return 'unknown'
  if (!validateEnvelope(obj).ok) return 'unknown'
  if (obj.state === UNKNOWN) return 'unknown'
  if (obj.stale === true) return 'unknown'
  if (!isFresh(obj, opts.maxAgeSec ?? null, opts.now ?? Date.now())) return 'unknown'
  const greenStates = opts.greenStates ?? GREEN_STATES
  if (greenStates.includes(obj.state) && envelopeGreen(obj, opts)) return 'green'
  if (YELLOW_STATES.includes(obj.state)) return 'yellow'
  return 'red'
}
