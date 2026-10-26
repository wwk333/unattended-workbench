#!/usr/bin/env node
/**
 * 模型能力注册表（`_crew\模型能力.json` 的唯一读写口）—— 2026-10-23 施工（施工文档 D1 / D14 / §14）
 *
 * 为什么要有这个文件：
 *   卡片被 16384 截断（`stopReason=length`）的根因不是模型弱，是**没人告诉载体这个模型能吃多少**：
 *   pi 的兜底是 `maxTokens ?? 16384`、`contextWindow ?? 128e3`，而真值是 131072 / 1048576。
 *   这一支就是「把能力变成系统自动拿到的数据」的**那一份数据**，供三处消费：
 *     ① `同步载体模型.mjs` 写进各载体配置（pi `maxTokens`／opencode `limit`／codebuddy `maxOutputTokens`）；
 *     ② `编排.mjs` 算上下文占用（D14：纯 prompt ÷ 模型窗口）；
 *     ③ `看板数据.mjs` 出「每载体上次使用」（§14：上下文 / 最大输出）。
 *
 * 三层来源（命中即止，施工文档 §3）：
 *   a. 网关 `/models` 元数据          → source: gateway  （ark 有 token_limits、u2 有 context_window/max_output）
 *   b. models.dev 公共注册表（随包内置一份 + 每周拉）→ source: registry
 *   c. 探测（400 回复告诉你真实上限）/ 手填面板 → source: probe / manual
 *   三层都拿不到 → source: unknown，两个值写 null。**绝不填默认值**（错值会 400，比默认值更糟）。
 *
 * 铁律（施工文档 §2 非目标 / §4 规则）：
 *   · **不猜**：拿不到就 unknown；
 *   · `source` 必填；`unknown` 时 `contextWindow` / `maxOutputTokens` 都是 null；
 *   · 手填（manual）**优先级最高**，抓取不得覆盖，除非显式 `--force`；
 *   · 每次抓取覆盖同键，`at` 用于新鲜度（默认 7 天过期）。
 *
 * 用法：
 *   node 模型能力.mjs status [--json] [--project <项目>]
 *   node 模型能力.mjs refresh [--provider ark] [--force] [--no-network]
 *   node 模型能力.mjs get --model "xiaomi-token-plan-cn/mimo-v2.6-flash" [--json]
 *   node 模型能力.mjs set --model "家/模型" --context 1048576 --output 131072 [--note "…"]
 *   node 模型能力.mjs unknown --model "家/模型" --note "…"
 *   node 模型能力.mjs models-dev [--refresh] [--json]
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// 载体上的家名 → 路由表的权威名（唯一权威在 `_家名.mjs`；这里只是**用**它，不复制一份映射表）
import { canonOfCarrierName } from './_家名.mjs'
// 路由表 = "哪些家是真的"（钥匙/地址的唯一真源；判"载体自造的家名"要靠它）
import { readRoutingTable, resolveKey } from './额度钥匙.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const WORKSPACE = resolve(HERE, '..')

/** 注册表（全局一份：模型能力不随项目走；项目侧要覆盖就自己写 `<项目>\_crew\模型能力.json`）。 */
export const REGISTRY_FILE = join(WORKSPACE, '_crew', '模型能力.json')
/** models.dev 的**随包内置**副本（D1：断网也能用；拉取失败保留旧副本并标 stale）。 */
export const MODELS_DEV_FILE = join(HERE, '数据', 'models.dev.json')

const SCHEMA_VERSION = 1
const STALE_DAYS = Number(process.env.DSH_CAPACITY_TTL_DAYS ?? 7)

// ════════════════════════════════════════════════════════════════════════════════
// 一、归一：任何一家 `/models` 的返回 → `{contextWindow, maxOutputTokens}`
//
// ⚠️ 字段名各家不同，**实测**（2026-10-23 现读六个家）：
//   ark        `token_limits.context_window` / `max_input_token_length` / `max_output_token_length`
//              （施工文档 §5 写的是 `token_limits.max_output_tokens` —— 实测**不是**这个名字，已按实测放宽）
//   u2         `context_window` / `max_input` / `max_output`
//   xiaomi / SiliconFlow / ocgo / aliyun  一个上限字段都没有（只能注册表/手填）
// ════════════════════════════════════════════════════════════════════════════════

const ALIAS_CONTEXT = [
  'context_window', 'contextWindow', 'context_length', 'max_model_len',
  'max_input_tokens', 'maxInputTokens', 'max_input', 'max_context_length',
  'token_limits.context_window', 'token_limits.max_input_token_length'
]
const ALIAS_OUTPUT = [
  'max_output_token_length', 'max_output_tokens', 'maxOutputTokens', 'max_output',
  'max_tokens', 'maxTokens', 'max_completion_tokens',
  'token_limits.max_output_token_length', 'token_limits.max_output_tokens',
  'top_provider.max_completion_tokens'
]
const ALIAS_REASONING = [
  'token_limits.max_reasoning_token_length', 'max_reasoning_token_length', 'max_reasoning_tokens'
]

function dig (obj, path) {
  let cur = obj
  for (const seg of String(path).split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined
    cur = cur[seg]
  }
  return cur
}
function firstPositive (obj, aliases) {
  for (const a of aliases) {
    const v = dig(obj, a)
    if (v === undefined || v === null || v === '') continue
    const n = Number(v)
    if (Number.isFinite(n) && n > 0) return { value: n, field: a }
  }
  return { value: null, field: null }
}

/** ark 的 `/models` 不按状态过滤（实测 83 Shutdown / 17 Retiring / 37 无 status）。
 *  ⚠️ 实测**一个 `Ready` 都没有** —— 施工文档 §5 的「跳过非 Ready」若照字面写会**一个都抓不到**。
 *  改成按语义判：**只跳过明确死了的**；没有 status 字段当作可用（老接口/别家不发这个字段）。 */
const DEAD_STATUS = /^(shutdown|retir(ing|ed)|deprecat(ed|ing)|offline|disabled|expired|deleted|下线|停用|废弃)/i
export function isAliveStatus (s) {
  if (s === null || s === undefined || s === '') return true
  return !DEAD_STATUS.test(String(s).trim())
}

/**
 * 把一条 `/models` 条目归一成能力。
 * 返回 `{contextWindow, maxOutputTokens, reasoningTokens, status, fields, alive}`；
 * 两个上限都没有 ⇒ 两个值都是 null（调用方据此**不落盘**，避免给 100 多个无关模型写 unknown）。
 */
export function normalizeModelEntry (m) {
  const c = firstPositive(m, ALIAS_CONTEXT)
  const o = firstPositive(m, ALIAS_OUTPUT)
  const r = firstPositive(m, ALIAS_REASONING)
  return {
    contextWindow: c.value,
    maxOutputTokens: o.value,
    reasoningTokens: r.value,
    status: m?.status ?? null,
    alive: isAliveStatus(m?.status),
    // 记下"这个数是从哪个字段读到的" —— 出问题时不用再猜是哪家哪种写法
    fields: { context: c.field, output: o.field, reasoning: r.field },
    id: m?.id ?? m?.name ?? null
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// 二、键归一：`家/模型` 与 `家:模型` 两种写法都认（§14.9 风险第 3 条）
// ════════════════════════════════════════════════════════════════════════════════

/** `xiaomi-token-plan-cn/mimo-v2.6-flash` / `custom-local:kimi-k3` → `{provider, modelId, key}`。
 *  ⚠️ 只切**第一个**分隔符：模型 id 自己可能带 `/`（SiliconFlow 的 `deepseek-ai/DeepSeek-V4.1-Flash`）。 */
export function normModelKey (model) {
  const raw = String(model ?? '').trim()
  if (!raw) return { provider: null, modelId: null, key: null, raw }
  const m = /^([^/:]+)[/:](.+)$/.exec(raw)
  if (!m) return { provider: null, modelId: raw, key: raw, raw }
  return { provider: m[1], modelId: m[2], key: `${m[1]}/${m[2]}`, raw }
}

// ════════════════════════════════════════════════════════════════════════════════
// 三、读写注册表
// ════════════════════════════════════════════════════════════════════════════════

function readJson (f, dflt = null) {
  try { return JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) } catch { return dflt }
}

export function registryFile (project = null) {
  // 项目侧覆盖（可选）：存在就用它，否则用全局那份
  if (project) {
    const p = join(resolve(project), '_crew', '模型能力.json')
    if (existsSync(p)) return p
  }
  return REGISTRY_FILE
}

export function load (project = null) {
  const j = readJson(registryFile(project), null)
  if (!j || typeof j !== 'object') return { version: SCHEMA_VERSION, at: null, models: {} }
  return { version: j.version ?? SCHEMA_VERSION, at: j.at ?? null, models: j.models && typeof j.models === 'object' ? j.models : {} }
}

export function save (reg, project = null) {
  const f = registryFile(project)
  mkdirSync(dirname(f), { recursive: true })
  const body = { version: SCHEMA_VERSION, at: new Date().toISOString(), models: reg.models ?? {} }
  // 排序：键稳定 ⇒ 文件 diff 可读（不进 git，但人要看）
  body.models = Object.fromEntries(Object.entries(body.models).sort(([a], [b]) => a.localeCompare(b)))
  writeFileSync(f, JSON.stringify(body, null, 2) + '\n', 'utf8')
  return { file: f, count: Object.keys(body.models).length, at: body.at }
}

/** 一条能力的新鲜度：`{stale, ageDays}`。没有 `at` 一律算过期。 */
export function staleness (entry, days = STALE_DAYS) {
  const at = Date.parse(entry?.at ?? '')
  if (!Number.isFinite(at)) return { stale: true, ageDays: null }
  const ageDays = (Date.now() - at) / 86400000
  return { stale: ageDays > days, ageDays: Math.round(ageDays * 10) / 10 }
}

/** models.dev 快照（随包内置那份）。 */
let _mdCache = null
export function modelsDev () {
  if (_mdCache) return _mdCache
  const j = readJson(MODELS_DEV_FILE, null)
  _mdCache = (j && j.version === 2 && j.byModelId && typeof j.byModelId === 'object')
    ? j
    : { at: null, providers: {}, byModelId: {} }
  return _mdCache
}
/**
 * 按**模型 id**查 models.dev。归一到某个 models.dev 家之后再查，**只认三种**，其余 null（**不猜**）：
 *   ① 地址对得上（`baseURL` 与 models.dev 的 `api` 相同）—— 最准，例 ark ↔ `volcengine-coding-plan`；
 *   ② 只有"域名"对得上、且该域名下**所有家给的值一致** —— 例 ocgo ↔ opencode.ai 的 `opencode-go` / `opencode`；
 *   ③ 都对不上时，只有当**全库所有家给的值完全一致**（共识）才采用。
 * ⚠️ 为什么砍掉"取全局第一家的值"（施工文档 §3 b 的朴素写法）：
 *   实测同一个 `deepseek-v4.1-flash`，27 个家报的最大输出从 **65,536 到 1,048,576** 不等；
 *   随手取一家给 ark 用，写进配置就是**400**（错值比默认值更糟 —— §11 第 1 条）。
 *   宁可 unknown，交给第三层（探测）去问出真值。
 */
export function modelsDevLookup (modelId, opts = null) {
  const md = modelsDev()
  const id = String(modelId ?? '').trim()
  if (!id) return null
  const o = typeof opts === 'string' ? { provider: opts } : (opts ?? {})
  const pick = (h, how) => {
    const c = Number(h?.context), out = Number(h?.output)
    if (!(c > 0) && !(out > 0)) return null
    return {
      contextWindow: c > 0 ? c : null,
      maxOutputTokens: out > 0 ? out : null,
      at: md.at ?? null, source: 'registry', how
    }
  }
  // ① 地址精确匹配
  if (o.baseURL) {
    const pname = md.byApi?.[normUrl(o.baseURL)]
    if (pname) { const hit = pick(md.providers?.[pname]?.models?.[id], `api=${pname}`); if (hit) return hit }
  }
  // ①b 家名匹配（我们表里的家名恰好等于 models.dev 的家名）
  if (o.provider) {
    const hit = pick(md.providers?.[o.provider]?.models?.[id], 'provider')
    if (hit) return hit
  }
  // ② 同域名、多家一致
  if (o.baseURL) {
    const host = hostOf(o.baseURL)
    const names = md.byHost?.[host] ?? []
    if (names.length) {
      const vals = names.map(n => md.providers?.[n]?.models?.[id]).filter(Boolean)
      if (vals.length) {
        const uniq = new Set(vals.map(v => `${v.context}|${v.output}`))
        if (uniq.size === 1) return pick(vals[0], `host=${host}×${vals.length}`)
        return null        // 同域名下各家不一致 ⇒ 不猜
      }
    }
  }
  // ③ 全库共识
  const g = md.byModelId[id] ?? md.byModelId[id.toLowerCase()]
  if (!g || g.agree === false) return null
  return pick(g, g.n > 1 ? `consensus×${g.n}` : 'single')
}

/**
 * 查一个模型的能力 —— 所有消费方的**唯一入口**。
 * 返回 `{key, provider, modelId, contextWindow, maxOutputTokens, source, at, stale, found, note}`。
 * ⚠️ `found=false` 时两个值是 null，**不是 16384**（§8：不许给默认值）。
 *
 * 查法：按优先级排一串候选（精确键 → 家名别名键 → **唯一**同模型 id 的键），
 *   **每个字段各取第一个非空值**（例：探测只问得出输出上限，上下文就从同模型的别名条目借）。
 *   候选多于一个同模型 id 时**不借**（那是猜）。
 */
export function capacityOf (model, project = null, reg = null) {
  const { provider, modelId, key } = normModelKey(model)
  const R = reg ?? load(project)
  const cands = []
  if (key && R.models[key]) cands.push({ key, e: R.models[key] })
  // ① 家名别名：载体上的家名与路由表的权威名常常不同（例 `xiaomi-token-plan-cn` ↔ `xiaomi`）。
  //    走 `_家名.mjs` 的**同一套**映射（那里是唯一权威，别在这里再抄一份）。
  if (provider && provider !== modelId) {
    try {
      const canon = canonOfCarrierName(provider)
      if (canon && canon !== provider && R.models[`${canon}/${modelId}`]) cands.push({ key: `${canon}/${modelId}`, e: R.models[`${canon}/${modelId}`] })
    } catch { /* 映射读不到就跳下一步 */ }
  }
  // ② 载体自造的家名（例 codebuddy 的 `custom-local:<模型>`，路由表里根本没有这家）
  //    ⇒ 允许按 **模型 id** 反查，且**唯一命中**才认。
  //    ⚠️ 反面纪律（本次实测踩过两次）：**路由表里真有的家不许借别人的值** ——
  //    ocgo 的 `deepseek-v4.1-flash` 被借成 u2 的 393216、aliyun 被借成 u2 的 1048576，
  //    那都是**两个网关各自的夹取**，写进配置就是 400（§11 第 1 条：错值比默认值更糟）。
  //    判据：这个家名**不在路由表里**（＝载体自造名），才算"真没有这家"。
  if (!cands.length) {
    const known = (() => { try { return Object.keys(readRoutingTable()) } catch { return [] } })()
    const providerSeen = known.includes(provider) || Object.keys(R.models).some(k => normModelKey(k).provider === provider)
    if (!providerSeen) {
      const same = Object.entries(R.models).filter(([k, v]) => normModelKey(k).modelId === modelId && v && (v.contextWindow || v.maxOutputTokens))
      if (same.length === 1) cands.push({ key: same[0][0], e: same[0][1] })
    }
  }
  const pick = (field) => {
    for (const c of cands) { const v = c.e?.[field]; if (v !== null && v !== undefined && Number(v) > 0) return { v: Number(v), from: c.key, e: c.e } }
    return null
  }
  const cw = pick('contextWindow')
  const mo = pick('maxOutputTokens')
  const main = cands[0]?.e ?? null
  const usedAlias = cands.find(c => c.key !== key && (c.e === cw?.e || c.e === mo?.e))?.key ?? null
  if (!cw && !mo) {
    return { key, provider, modelId, contextWindow: null, maxOutputTokens: null, source: 'unknown', at: null, stale: true, ageDays: null, found: false, note: null, viaAlias: null, fields: { context: null, output: null } }
  }
  const primary = main ?? (cw?.e ?? mo?.e)
  const st = staleness(primary)
  return {
    key, provider, modelId,
    contextWindow: cw?.v ?? null,
    maxOutputTokens: mo?.v ?? null,
    source: primary?.source ?? 'unknown', at: primary?.at ?? null,
    stale: st.stale, ageDays: st.ageDays,
    found: true,
    note: primary?.note ?? null,
    viaAlias: usedAlias,
    // 每个字段是从哪条键借来的（`key` = 本条，其它 = 别名）—— 排障时不用猜
    fields: { context: cw?.from ?? null, output: mo?.from ?? null }
  }
}

/** 写一条（内部）。`manual` 覆盖一切；抓取不覆盖 manual（除非 force）。返回是否写入。 */
function put (reg, key, entry, { force = false } = {}) {
  const old = reg.models[key]
  if (old?.source === 'manual' && !force) return { written: false, why: 'manual-protected' }
  reg.models[key] = { ...entry, at: entry.at ?? new Date().toISOString() }
  return { written: true }
}

export function setManual (model, { contextWindow = null, maxOutputTokens = null, note = null } = {}) {
  const { key } = normModelKey(model)
  if (!key) return { ok: false, why: '模型名为空' }
  const reg = load()
  reg.models[key] = {
    contextWindow: contextWindow ?? null,
    maxOutputTokens: maxOutputTokens ?? null,
    source: 'manual',
    at: new Date().toISOString(),
    note: note ?? '面板手填'
  }
  return { ok: true, ...save(reg), key }
}

export function markUnknown (model, note = null) {
  const { key } = normModelKey(model)
  if (!key) return { ok: false, why: '模型名为空' }
  const reg = load()
  if (reg.models[key]?.source === 'manual') return { ok: false, why: '手填值不覆盖（要改就重新手填）' }
  reg.models[key] = { contextWindow: null, maxOutputTokens: null, source: 'unknown', at: new Date().toISOString(), note: note ?? '三层来源都拿不到' }
  return { ok: true, ...save(reg), key }
}

// ════════════════════════════════════════════════════════════════════════════════
// 四、第一层：从网关 `/models` 抓
// ════════════════════════════════════════════════════════════════════════════════

/**
 * 抓一家。返回 `{provider, ok, why, models:[{id, contextWindow, maxOutputTokens, status}], wrote}`。
 * ⚠️ 只写有值的条目 —— 一家 137 个模型、其中上百个是它自己下线的东西，全写 unknown 会把注册表淹掉。
 */
export async function fetchGateway (provider, { timeoutMs = 15000 } = {}) {
  const out = { provider, ok: false, why: null, models: [], wrote: 0 }
  let routing, keyRes
  try {
    routing = readRoutingTable()[provider]
    if (!routing?.baseURL) return { ...out, why: '路由表里没有这家（或没 baseURL）' }
    keyRes = resolveKey(provider)
    const base = String(routing.baseURL).replace(/\/+$/, '')
    const headers = { ...(routing.headers ?? {}) }
    if (keyRes?.key) headers.Authorization = 'Bearer ' + keyRes.key
    const r = await fetch(base + '/models', { headers, signal: AbortSignal.timeout(timeoutMs) })
    if (r.status !== 200) return { ...out, why: 'HTTP ' + r.status }
    const j = await r.json().catch(() => null)
    const arr = j?.data ?? j?.models ?? []
    if (!Array.isArray(arr)) return { ...out, why: '返回不是数组' }
    out.ok = true
    out.models = arr.map(normalizeModelEntry).filter(x => x.id)
  } catch (e) {
    return { ...out, why: String(e?.message ?? e).slice(0, 120) }
  }
  return out
}

/**
 * 全量刷新：① 网关（有 `/models` 上限的那几家）→ ② models.dev → ③ 保留 manual。
 * 返回 `{ok, at, gateway:{...}, registry:{written,missed}, total, unknown}`。
 */
export async function refreshAll ({ providers = null, force = false, noNetwork = false, models: extraModels = [], probeUnknown = false } = {}) {
  const reg = load()
  const gw = {}
  const warnings = []

  if (!noNetwork) {
    let names = providers
    if (!names) {
      try {
        names = Object.keys(readRoutingTable())
      } catch { names = [] }
    }
    for (const name of names) {
      const res = await fetchGateway(name)
      gw[name] = { ok: res.ok, why: res.why ?? null, models: res.models.length, withLimits: 0, wrote: 0, deadSkipped: 0 }
      if (!res.ok) { warnings.push(`${name}：${res.why}`); continue }
      for (const m of res.models) {
        if (m.contextWindow === null && m.maxOutputTokens === null) continue
        if (!m.alive) { gw[name].deadSkipped++; continue }
        gw[name].withLimits++
        const key = `${name}/${m.id}`
        const w = put(reg, key, {
          contextWindow: m.contextWindow, maxOutputTokens: m.maxOutputTokens,
          ...(m.reasoningTokens ? { reasoningTokens: m.reasoningTokens } : {}),
          source: 'gateway', at: new Date().toISOString(),
          note: `网关 /models（字段 ${m.fields.context ?? '-'} / ${m.fields.output ?? '-'}${m.status ? `，status=${m.status}` : ''}）`
        }, { force })
        if (w.written) gw[name].wrote++
      }
    }
  } else {
    warnings.push('--no-network：跳过网关抓取')
  }

  // ② models.dev：把"该用到的模型"里仍缺值的补上
  const want = new Set(extraModels.map(m => String(m)))
  try {
    for (const [name, v] of Object.entries(readRoutingTable())) for (const id of (v.models ?? [])) want.add(`${name}/${id}`)
  } catch { /* 路由表读不到就只补显式给的 */ }
  let regWrote = 0; const regMissed = []
  const md = modelsDev()
  const rtable = (() => { try { return readRoutingTable() } catch { return {} } })()
  for (const model of want) {
    const { key, modelId } = normModelKey(model)
    if (!key) continue
    const cur = reg.models[key]
    if (cur?.source === 'manual') continue
    if (cur && (cur.contextWindow || cur.maxOutputTokens) && !staleness(cur).stale) continue
    const ourProvider = normModelKey(key).provider
    const hit = modelsDevLookup(modelId, { provider: ourProvider, baseURL: rtable?.[ourProvider]?.baseURL ?? null })
    if (!hit) { regMissed.push(key); continue }
    const w = put(reg, key, {
      contextWindow: hit.contextWindow, maxOutputTokens: hit.maxOutputTokens,
      source: 'registry', at: new Date().toISOString(),
      note: `models.dev（快照 ${String(md.at ?? '未知').slice(0, 10)}${hit.how ? '，' + hit.how : ''}）`
    }, { force })
    if (w.written) regWrote++
  }

  // ③ 探测（可选，只问"角色真在用、前两层都没问到"的那几个）—— 零 token，一个 400 换一个权威值
  const probe = { tried: [], got: [], failed: [] }
  if (probeUnknown && !noNetwork) {
    const targets = new Set(roleModels().map(m => String(m)))
    for (const t of targets) {
      const { provider, modelId, key } = normModelKey(t)
      if (!provider || !modelId) continue
      const cur = reg.models[key]
      if (cur?.source === 'manual') continue
      if (cur && (cur.contextWindow || cur.maxOutputTokens) && !staleness(cur).stale) continue
      const canon = (() => { try { return canonOfCarrierName(provider) || provider } catch { return provider } })()
      probe.tried.push(`${canon}/${modelId}`)
      const r = await probeModel(canon, modelId)
      if (r.ok) {
        const w = put(reg, key, {
          contextWindow: r.contextWindow ?? reg.models[key]?.contextWindow ?? null,
          maxOutputTokens: r.maxOutputTokens,
          source: 'probe', at: new Date().toISOString(),
          note: `探测：网关报「${String(r.raw ?? '').slice(0, 90)}」`
        }, { force: false })
        probe.got.push({ model: key, maxOutputTokens: r.maxOutputTokens, contextWindow: r.contextWindow, written: w.written })
      } else {
        probe.failed.push({ model: key, why: r.why })
      }
    }
  }

  const saved = save(reg)
  const models = Object.values(reg.models)
  return {
    ok: true, at: saved.at, file: saved.file, total: models.length,
    known: models.filter(m => m.contextWindow || m.maxOutputTokens).length,
    unknown: models.filter(m => !(m.contextWindow || m.maxOutputTokens)).length,
    gateway: gw, registry: { snapshot: md.at ?? null, wrote: regWrote, missed: regMissed },
    probe, warnings
  }
}

// ════════════════════════════════════════════════════════════════════════════════
// 五、models.dev 快照维护（D1：随包内置一份 + 每周拉一次；断网用旧的并标 stale）
// ════════════════════════════════════════════════════════════════════════════════

export const MODELS_DEV_URL = 'https://models.dev/api.json'

/** 地址归一：小写、去协议、去尾部斜杠与 `/chat/completions`（用来跟 models.dev 的 `api` 比对）。 */
export function normUrl (u) {
  return String(u ?? '').trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\/chat\/completions\/?$/, '')
    .replace(/\/+$/, '')
}
export function hostOf (u) {
  const n = normUrl(u)
  return n.split('/')[0] ?? ''
}

/** 把 models.dev 的原始 api.json 压成我们用的形状。
 *  原始形状（2026-10-23 现读）：`{ "<家>": { id, env, api, name, models: { "<模型id>": { limit:{context,output}, … } } } }`
 *  压成三份索引：`providers[家].models[模型id]`、`byApi[归一地址]`、`byHost[域名]`，
 *  以及 `byModelId[模型id] = {context, output, n, agree}`（`agree` ＝ 所有家报的值是否一致）。
 *  为什么压：原文件几 MB、含 modalities/cost/canonical_model_id 等我们一个都用不到的字段。 */
export function projectModelsDev (raw) {
  const providers = {}
  const byApi = {}
  const byHost = {}
  const votes = new Map()          // mid → Map<"c|o", {rec, n}>
  for (const [pname, p] of Object.entries(raw ?? {})) {
    const ms = p?.models
    if (!ms || typeof ms !== 'object') continue
    const bag = {}
    for (const [mid, m] of Object.entries(ms)) {
      const lim = m?.limit ?? {}
      const context = Number(lim.context ?? m?.context_window ?? m?.context)
      const output = Number(lim.output ?? m?.max_output ?? m?.output)
      if (!(context > 0) && !(output > 0)) continue
      const rec = { context: context > 0 ? context : null, output: output > 0 ? output : null }
      bag[mid] = rec
      if (!votes.has(mid)) votes.set(mid, new Map())
      const k = `${rec.context}|${rec.output}`
      const slot = votes.get(mid).get(k) ?? { rec, n: 0 }
      slot.n++
      votes.get(mid).set(k, slot)
    }
    if (!Object.keys(bag).length) continue
    providers[pname] = { id: p?.id ?? pname, api: p?.api ?? null, models: bag }
    // 地址/域名索引（一个地址可能被多家声明，先到先得；域名可能对应多家）
    if (p?.api) {
      const nu = normUrl(p.api)
      if (!byApi[nu]) byApi[nu] = pname
      const host = nu.split('/')[0]
      byHost[host] = [...new Set([...(byHost[host] ?? []), pname])]
    }
  }
  const byModelId = {}
  for (const [mid, m] of votes) {
    const arr = [...m.values()].sort((a, b) => b.n - a.n)
    byModelId[mid] = { ...arr[0].rec, n: arr.reduce((a, x) => a + x.n, 0), agree: arr.length === 1 }
  }
  return { version: 2, source: MODELS_DEV_URL, at: new Date().toISOString(), providers, byApi, byHost, byModelId }
}

/** 拉一次 models.dev。失败返回 `{ok:false}`（调用方保留旧副本）。 */
export async function fetchModelsDev ({ timeoutMs = 20000 } = {}) {
  try {
    const r = await fetch(MODELS_DEV_URL, { signal: AbortSignal.timeout(timeoutMs) })
    if (r.status !== 200) return { ok: false, why: 'HTTP ' + r.status }
    const j = await r.json()
    const proj = projectModelsDev(j)
    const n = Object.keys(proj.byModelId).length
    if (!n) return { ok: false, why: '拉回来的条目是 0（格式变了？）' }
    return { ok: true, data: proj, count: n }
  } catch (e) {
    return { ok: false, why: String(e?.message ?? e).slice(0, 140) }
  }
}

/** 写入内置副本（先留一份 .bak，方便回滚）。 */
export function saveModelsDev (proj) {
  mkdirSync(dirname(MODELS_DEV_FILE), { recursive: true })
  try { if (existsSync(MODELS_DEV_FILE)) writeFileSync(MODELS_DEV_FILE + '.bak-' + Date.now(), readFileSync(MODELS_DEV_FILE)) } catch {}
  writeFileSync(MODELS_DEV_FILE, JSON.stringify(proj, null, 1) + '\n', 'utf8')
  _mdCache = null
  return { file: MODELS_DEV_FILE, count: Object.keys(proj.byModelId).length }
}

/** 内置副本多旧了（天）。 */
export function modelsDevAgeDays () {
  const md = modelsDev()
  const at = Date.parse(md.at ?? '')
  if (!Number.isFinite(at)) {
    try { return (Date.now() - statSync(MODELS_DEV_FILE).mtimeMs) / 86400000 } catch { return null }
  }
  return (Date.now() - at) / 86400000
}

// ════════════════════════════════════════════════════════════════════════════════
// 六、探针回填（第三层）：网关 400 会告诉我们真实上限（W0 实测原文：
//    `max_completion_tokens is too large: 1039357. This model supports at most 131072 completion tokens`）
// ════════════════════════════════════════════════════════════════════════════════

const RE_400_OUTPUT = /supports? at most (\d{3,9}) (?:completion |output )?tokens/i
const RE_400_CONTEXT = /(?:maximum context length|context length is|context window)[^\d]{0,24}(\d{3,9})/i

/** 从一段错误文本里抠出"真实上限"。抠不到返回 null（**不许猜**）。 */
export function parseLimitFromError (text) {
  const t = String(text ?? '')
  const o = RE_400_OUTPUT.exec(t)
  const c = RE_400_CONTEXT.exec(t)
  if (!o && !c) return null
  return { maxOutputTokens: o ? Number(o[1]) : null, contextWindow: c ? Number(c[1]) : null, raw: (o ?? c)[0].slice(0, 160) }
}

/** 把探测到的值写进注册表（source: probe）。**不覆盖 manual**。 */
export function setProbe (model, { contextWindow = null, maxOutputTokens = null, note = null } = {}) {
  const { key } = normModelKey(model)
  if (!key) return { ok: false, why: '模型名为空' }
  if (contextWindow === null && maxOutputTokens === null) return { ok: false, why: '两个值都没有，不写' }
  const reg = load()
  const old = reg.models[key]
  const w = put(reg, key, {
    contextWindow: contextWindow ?? old?.contextWindow ?? null,
    maxOutputTokens: maxOutputTokens ?? old?.maxOutputTokens ?? null,
    source: 'probe', at: new Date().toISOString(),
    note: note ?? `网关报错里读到的真实上限${old?.source ? `（原 source=${old.source}）` : ''}`
  }, { force: false })
  if (!w.written) return { ok: false, why: w.why }
  return { ok: true, ...save(reg), key }
}

/**
 * 真打一次网关，把「最大输出」问出来 —— **零 token**（请求必然被 400 挡下，不会真生成）。
 *
 * 原理（W0 实测）：`max_tokens` 给一个明显超限的值，网关回
 * `400 … max_completion_tokens is too large: N. This model supports at most 131072 completion tokens`
 * ⇒ 这个 131072 就是**权威值**，比任何公共注册表都准。
 *
 * ⚠️ 三种结果都要认，不许当成成功：
 *   · 400 + 报上限   ⇒ `{ok:true, maxOutputTokens:N, contextWindow?:M}`（写 source: probe）
 *   · 400 但不报数   ⇒ `{ok:false, why:'400 但没给上限'}`（不猜）
 *   · 200            ⇒ 说明这家**静默夹**（或真接受），拿不到数 ⇒ `{ok:false, why:'静默接受，问不出上限'}`
 */
export async function probeModel (provider, modelId, { timeoutMs = 30000 } = {}) {
  const out = { provider, modelId, ok: false, why: null, maxOutputTokens: null, contextWindow: null, http: null, raw: null }
  try {
    const rt = readRoutingTable()[provider]
    if (!rt?.baseURL) return { ...out, why: '路由表里没有这家' }
    const keyRes = resolveKey(provider)
    const headers = { 'Content-Type': 'application/json', ...(rt.headers ?? {}) }
    if (keyRes?.key) headers.Authorization = 'Bearer ' + keyRes.key
    const body = { model: modelId, messages: [{ role: 'user', content: 'ping' }], max_tokens: 99999999, stream: false }
    const r = await fetch(String(rt.baseURL).replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs)
    })
    out.http = r.status
    const txt = await r.text().catch(() => '')
    out.raw = txt.slice(0, 600)
    if (r.status === 200) return { ...out, why: '静默接受（200）—— 这家不报上限，问不出来' }
    const hit = parseLimitFromError(txt)
    if (!hit) return { ...out, why: `HTTP ${r.status} 但正文里没有上限（${txt.slice(0, 120)}）` }
    return { ...out, ok: true, maxOutputTokens: hit.maxOutputTokens, contextWindow: hit.contextWindow, raw: hit.raw }
  } catch (e) {
    return { ...out, why: String(e?.message ?? e).slice(0, 140) }
  }
}

/** 角色实际在用的模型（`agents.json` 的 prefer + 各级覆盖）—— 探针只需要问这几个。 */
export function roleModels () {
  try {
    const cfg = readJson(join(WORKSPACE, '_crew', 'agents.json'), {})
    const out = new Set()
    for (const [, r] of Object.entries(cfg?.roles ?? {})) {
      const m = r?.prefer?.model ?? r?.model
      if (m) out.add(String(m))
      for (const lv of Object.values(r?.levels ?? {})) if (lv?.model) out.add(String(lv.model))
    }
    return [...out]
  } catch { return [] }
}

// ════════════════════════════════════════════════════════════════════════════════
// 七、给消费方的小工具
// ════════════════════════════════════════════════════════════════════════════════

/** 上下文占用（D14 唯一公式）：`(input + cache_read + cache_write) ÷ contextWindow`。
 *  返回 `{promptTokens, ctxWindow, ctxPct}`；窗口未知 ⇒ `ctxPct = null`（**不编数**）。 */
export function contextPct (promptTokens, ctxWindow) {
  const p = Number(promptTokens)
  const w = Number(ctxWindow)
  if (!Number.isFinite(p) || p <= 0) return { promptTokens: Number.isFinite(p) ? p : null, ctxWindow: Number.isFinite(w) && w > 0 ? w : null, ctxPct: null }
  if (!Number.isFinite(w) || w <= 0) return { promptTokens: p, ctxWindow: null, ctxPct: null }
  return { promptTokens: p, ctxWindow: w, ctxPct: Math.round((p / w) * 1000) / 10 }
}

/** 压缩预留（D14 附）：窗口 × 30% ⇒ 触发线 70%。拿不到窗口 ⇒ 退回 16384（保持原行为，不冒险）。 */
export function compactionReserve (ctxWindow) {
  const w = Number(ctxWindow)
  if (!Number.isFinite(w) || w <= 0) return 16384
  return Math.max(16384, Math.round(w * 0.3))
}

// ════════════════════════════════════════════════════════════════════════════════
// 八、命令行
// ════════════════════════════════════════════════════════════════════════════════

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const argv = process.argv.slice(2)
  const cmd = argv[0] ?? 'status'
  const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
  const has = (n) => argv.includes('--' + n)
  const project = opt('project', null)
  const json = has('json')

  if (cmd === 'status') {
    const reg = load(project)
    const rows = Object.entries(reg.models).map(([k, v]) => {
      const st = staleness(v)
      return { model: k, contextWindow: v.contextWindow ?? null, maxOutputTokens: v.maxOutputTokens ?? null, source: v.source ?? null, at: v.at ?? null, stale: st.stale, ageDays: st.ageDays, note: v.note ?? null }
    })
    const by = {}
    for (const r of rows) by[r.source] = (by[r.source] || 0) + 1
    const out = { file: registryFile(project), at: reg.at, total: rows.length, bySource: by, rows }
    if (json) console.log(JSON.stringify(out, null, 2))
    else {
      console.log(`注册表：${out.file}`)
      console.log(`更新时间：${reg.at ?? '（从未抓过）'}　共 ${rows.length} 条　来源分布：${Object.entries(by).map(([k, n]) => `${k} ${n}`).join(' / ') || '（空）'}`)
      for (const r of rows) {
        const v = r.contextWindow === null && r.maxOutputTokens === null ? '⚠️ unknown' : `${r.contextWindow ?? '?'} / ${r.maxOutputTokens ?? '?'}`
        console.log(`  ${r.model.padEnd(46)} ${v}${r.stale ? ' *过期' : ''}  [${r.source}]${r.note ? '  ' + r.note.slice(0, 40) : ''}`)
      }
    }
  } else if (cmd === 'refresh') {
    const providers = opt('provider', null) ? [opt('provider')] : null
    const r = await refreshAll({ providers, force: has('force'), noNetwork: has('no-network'), probeUnknown: has('probe') })
    if (json) console.log(JSON.stringify(r, null, 2))
    else {
      console.log(`✅ 注册表已刷新：${r.file}`)
      console.log(`  已知 ${r.known} / 未知 ${r.unknown}（共 ${r.total}）`)
      for (const [k, v] of Object.entries(r.gateway)) console.log(`  网关 ${k}：${v.ok ? `拿到 ${v.models} 个，带上限 ${v.withLimits}，写入 ${v.wrote}，跳过已下线 ${v.deadSkipped}` : '失败 —— ' + v.why}`)
      console.log(`  models.dev 快照 ${r.registry.snapshot ?? '（无）'}：补写 ${r.registry.wrote}${r.registry.missed.length ? `，查不到 ${r.registry.missed.length} 条` : ''}`)
      if (r.probe?.tried?.length) {
        console.log(`  探测：问了 ${r.probe.tried.length} 个，拿到 ${r.probe.got.length} 个${r.probe.got.length ? '（' + r.probe.got.map(g => `${g.model}=${g.maxOutputTokens}`).join('、') + '）' : ''}`)
        for (const f of r.probe.failed) console.log(`    · ${f.model}：${f.why}`)
      }
      for (const w of r.warnings) console.log(`  ⚠️ ${w}`)
    }
  } else if (cmd === 'probe') {
    const model = opt('model', null)
    if (!model) { console.error('用法：--model "家/模型"'); process.exit(1) }
    const { provider, modelId, key } = normModelKey(model)
    const canon = (() => { try { return canonOfCarrierName(provider) || provider } catch { return provider } })()
    const r = await probeModel(canon, modelId)
    if (!r.ok) { console.error(`❌ 探测失败（${canon}/${modelId}）：${r.why}`); process.exit(2) }
    const w = setProbe(key, { contextWindow: r.contextWindow, maxOutputTokens: r.maxOutputTokens, note: `探测：${String(r.raw ?? '').slice(0, 90)}` })
    console.log(`✅ ${key}：最大输出 ${r.maxOutputTokens}${r.contextWindow ? ` / 上下文 ${r.contextWindow}` : ''}（已写进注册表，source=probe）`)
  } else if (cmd === 'get') {
    const model = opt('model', null)
    if (!model) { console.error('用法：--model "家/模型"'); process.exit(1) }
    const c = capacityOf(model, project)
    if (json) console.log(JSON.stringify(c, null, 2))
    else console.log(`${c.key ?? model}：上下文 ${c.contextWindow ?? 'unknown'} / 最大输出 ${c.maxOutputTokens ?? 'unknown'}（source=${c.source}${c.stale ? '，已过期' : ''}${c.note ? '，' + c.note : ''}）`)
  } else if (cmd === 'set') {
    const model = opt('model', null)
    if (!model) { console.error('用法：--model "家/模型" --context N --output N'); process.exit(1) }
    const r = setManual(model, {
      contextWindow: opt('context', null) === null ? null : Number(opt('context')),
      maxOutputTokens: opt('output', null) === null ? null : Number(opt('output')),
      note: opt('note', null)
    })
    console.log(r.ok ? `✅ 已手填 ${r.key}（写进 ${r.file}）` : `❌ ${r.why}`)
  } else if (cmd === 'unknown') {
    const model = opt('model', null)
    if (!model) { console.error('用法：--model "家/模型" --note "…"'); process.exit(1) }
    const r = markUnknown(model, opt('note', null))
    console.log(r.ok ? `✅ 已标 ${r.key} = unknown` : `❌ ${r.why}`)
  } else if (cmd === 'models-dev') {
    if (has('refresh')) {
      const f = await fetchModelsDev()
      if (!f.ok) { console.error(`❌ 拉 models.dev 失败：${f.why}（**保留旧副本**，不阻塞派活）`); process.exit(2) }
      const s = saveModelsDev(f.data)
      console.log(`✅ models.dev 快照已更新：${s.file}（${s.count} 个模型）`)
    }
    const md = modelsDev()
    const age = modelsDevAgeDays()
    if (json) console.log(JSON.stringify({ file: MODELS_DEV_FILE, at: md.at, count: Object.keys(md.byModelId).length, ageDays: age, stale: age === null || age > 7 }, null, 2))
    else console.log(`models.dev 快照：${MODELS_DEV_FILE}\n  抓取时间 ${md.at ?? '（未知）'}（${age === null ? '?' : Math.round(age * 10) / 10} 天前${age !== null && age > 7 ? '，**已过期**' : ''}）　${Object.keys(md.byModelId).length} 个模型${age !== null && age > 7 ? '　→ `--refresh` 拉一次' : ''}`)
  } else {
    console.error(`未知子命令：${cmd}\n可用：status / refresh / get / set / unknown / models-dev`)
    process.exit(1)
  }
}
