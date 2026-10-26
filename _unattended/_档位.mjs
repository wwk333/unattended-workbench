#!/usr/bin/env node
/**
 * 档位（思考深度）—— **三档抽象 ＋ 按 DSH 真实规则校验**（2026-10-16；口径已按实测更正）
 *
 * ⚠️ 2026-10-16 更正（用户拿 DSH 的档位截图质疑"你不是说小米不认吗？"）：
 *   我第一版按"档案里有没有 `reasoningEfforts`"来判，得出"xiaomi 一个档位都不认" —— **那是错的**。
 *   DSH 的真实规则在 `getSupportedThinkingLevels()` 里（app.asar）：
 *
 *     const EXTENDED_THINKING_LEVELS = ["off","minimal","low","medium","high","xhigh","max"]
 *     if (!model.reasoning) return ["off"]
 *     return EXTENDED_THINKING_LEVELS.filter(level => {
 *       const mapped = model.thinkingLevelMap?.[level]
 *       if (mapped === null) return false                  // 显式 null ＝ 不支持
 *       if (level === "xhigh" || level === "max") return mapped !== undefined   // ★ 只有这两个要显式声明
 *       return true                                        // off/minimal/low/medium/high 是标准档，默认就有
 *     })
 *
 *   ⇒ 真相是：
 *     · **标准五档（off/minimal/low/medium/high）对"推理模型"默认全部可用**；
 *     · **`xhigh` / `max` 是 opt-in** —— 没显式声明就没有（这就是 DSH 里 MiMo 只到 High、没有 Max 的原因）；
 *     · 档案里写了 `reasoningEfforts: {max: ...}` 才有 max；写 `false` ＝ 非推理模型（只剩 off）；
 *     · **不报错 ≠ 生效**：pi 那边会把超出的档**静默夹到**它支持的最高档（实测：xiaomi 上 `--thinking max` 也是 exit 0，
 *       但 UI 里它只到 High）⇒ 所以"我要 max、实际跑 high"正是必须机器记账的那种静默。
 *
 * 因此本模块的口径是：**"这个模型真支持的档位集合"** = 标准五档（减掉显式 null 的）＋ 显式声明的 xhigh/max；
 *   落地取第一个支持的；取不到首选就如实标 `degraded`（并写清会落成什么），一个都没有才 `unsupported`。
 *
 * ⚠️ 档案（`~\.dsh\profiles\desktop\cordis.patch.yml`）**只读、绝不写**。
 */
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DSH_HOME } from './_agents-config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 我们自己的路由表（messenger/DSH headless 那条路的**唯一来源**）。 */
export const ROUTE_FILE = process.env.DSH_ROUTE_TABLE ?? join(HERE, '_coder路由表.json')

/** 三个抽象档（顺序＝从省到狠）。键就是写进配置的字面量。 */
export const EFFORT_TIERS = ['省', '中', '狠']

/**
 * 每个抽象档的**候选串** —— 按顺序取第一个模型真支持的。
 * 存进 `agents.json` 的 `levels.effortTiers` 后可被用户覆盖（这里只是机制默认值，**不是模型名**）。
 */
export const DEFAULT_EFFORT_TIERS = {
  省: ['off', 'none', 'minimal', 'low'],
  中: ['high', 'medium', 'low'],
  狠: ['max', 'xhigh', 'high']
}

/** DSH 的档位总表（顺序有意义：从省到狠）。**这是 DSH 代码里的常量，不是我们编的。** */
export const DSH_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
/** 其中这两个必须**显式声明**才存在（其余是标准档，推理模型默认就有）。 */
export const OPT_IN_LEVELS = ['xhigh', 'max']
/** 标准档（推理模型默认支持）。 */
export const STANDARD_LEVELS = ['off', 'minimal', 'low', 'medium', 'high']

export function isEffortTier (v) { return EFFORT_TIERS.includes(String(v ?? '').trim()) }

/** 找档案 patch（与 `额度钥匙.mjs` 同一处；找不到返回 null，**不猜路径**）。 */
function findPatch () {
  const root = join(DSH_HOME, 'profiles')
  for (const p of ['desktop', 'default']) {
    const f = join(root, p, 'cordis.patch.yml')
    if (existsSync(f)) return f
  }
  try {
    for (const p of readdirSync(root)) {
      const f = join(root, p, 'cordis.patch.yml')
      if (existsSync(f)) return f
    }
  } catch { /* 读不到就算了 */ }
  return null
}

let _cache = null
/**
 * 读档案里 `llm-pi-ai` 那段：`{ <家>: { <模型id>: { 声明: {level: wire} | false, seen: true } } }`。
 * 只读、带缓存（mtime 变了才重读）。
 */
export function declaredEfforts (patchFile = null) {
  const f = patchFile ?? findPatch()
  if (!f || !existsSync(f)) return { file: f, homes: {}, why: '找不到档案 patch' }
  let mtime = 0
  try { mtime = statSync(f).mtimeMs } catch { /* 取不到就每次重读 */ }
  if (_cache && _cache.file === f && _cache.mtime === mtime) return _cache.data

  const lines = readFileSync(f, 'utf8').split(/\r?\n/)
  const homes = {}
  const i0 = lines.findIndex(l => /^\s*-\s*id:\s*llm-pi-ai\s*$/.test(l))
  if (i0 < 0) return { file: f, homes, why: '档案里没有 llm-pi-ai 段' }
  let base = -1
  let i = i0 + 1
  for (; i < lines.length; i++) {
    const m = /^(\s*)providers:\s*$/.exec(lines[i])
    if (m) { base = m[1].length; break }
    if (/^\s*-\s*id:\s*\S/.test(lines[i])) return { file: f, homes, why: 'llm-pi-ai 段里没有 providers' }
  }
  if (base < 0) return { file: f, homes, why: 'llm-pi-ai 段里没有 providers' }

  let home = null
  let model = null
  let inEfforts = false
  let effBase = -1
  for (i = i + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent <= base) break                                  // 出 providers 块
    // 收集 reasoningEfforts 的子项
    if (inEfforts && home && model) {
      if (indent <= effBase) { inEfforts = false } else {
        const kv = /^\s*([A-Za-z_]+):\s*(.+?)\s*$/.exec(line)
        if (kv) {
          const key = kv[1]
          const raw = kv[2].replace(/^["']|["']$/g, '')
          homes[home][model].声明[key] = (raw === 'null' ? null : raw)
        }
        continue
      }
    }
    const homeM = new RegExp(`^\\s{${base + 2}}([A-Za-z0-9_.\\-]+):\\s*$`).exec(line)
    if (homeM) { home = homeM[1]; homes[home] = homes[home] ?? {}; model = null; continue }
    if (!home) continue
    const modelM = new RegExp(`^\\s{${base + 6}}-\\s*id:\\s*(.+?)\\s*$`).exec(line)
    if (modelM) {
      model = modelM[1].replace(/^["']|["']$/g, '')
      homes[home][model] = homes[home][model] ?? { 声明: {}, seen: true }
      continue
    }
    if (model && /^\s*reasoningEfforts:\s*$/.test(line)) { inEfforts = true; effBase = indent; continue }
    if (model && /^\s*reasoningEfforts:\s*(false|true)\s*$/.test(line)) {
      homes[home][model].声明 = line.includes('false') ? false : {}
      continue
    }
  }
  const data = { file: f, homes, why: null }
  _cache = { file: f, mtime, data }
  return data
}

/**
 * 某家某模型**真支持的档位集合**（完全按 DSH 的 `getSupportedThinkingLevels` 口径复现）。
 * @returns {{ known: boolean, levels: string[], wire: Record<string,string>, reasoning: boolean, why: string|null, source: string }}
 *   `levels` ＝ 可选的档位键（顺序按 DSH_LEVELS）· `wire[level]` ＝ 分派时真正该发的拼写（支持改名）
 */
export function supportedEfforts (home, modelId, decl = null) {
  const d = decl ?? declaredEfforts()
  const h = d.homes?.[home]
  const id = String(modelId ?? '').split(/[\/:]/).pop()
  if (!h || !(id in h)) {
    // 档案里没这家/没这模型 ⇒ 我们**不知道**它是不是推理模型 ⇒ 不猜（由调用方标"未核实"）
    return { known: false, levels: [], wire: {}, reasoning: null, why: `档案里没有 ${home}/${id} —— 未核实（不猜）`, source: 'none' }
  }
  const 声明 = h[id]?.声明
  if (声明 === false) {
    return { known: true, levels: ['off'], wire: { off: 'off' }, reasoning: false, why: '档案声明 reasoningEfforts: false ＝ 非推理模型（只剩 off）', source: 'patch' }
  }
  const map = (声明 && typeof 声明 === 'object') ? 声明 : {}
  const levels = []
  const wire = {}
  for (const level of DSH_LEVELS) {
    const mapped = map[level]
    if (mapped === null) continue                                    // 显式 null ＝ 不支持
    if (OPT_IN_LEVELS.includes(level) && mapped === undefined) continue // xhigh/max 必须显式声明
    levels.push(level)
    wire[level] = mapped ?? level                                    // 改名：声明里给什么就发什么
  }
  return { known: true, levels, wire, reasoning: true, why: null, source: 'patch' }
}

/** 兼容旧名（面板/闸还在调它）：返回"真支持的档位"（新版按 DSH 规则算，含标准五档）。 */
export function effortsOfModel (home, modelId, decl = null) {
  const s = supportedEfforts(home, modelId, decl)
  return { known: s.known, values: s.levels, why: s.why }
}

// ══════════════════════════════════════════════════════════════════════════════════════════
// ★★ 2026-10-16（用户："我需要一个通用解决方案，别我在看板上加一个 API，这边分级又不能选档位了"）
//
//   病根不是某一家的能力问题，是**"能力从哪来"没有唯一出口**：
//   档案（DSH profile）、路由表（我们生成给 messenger 的那份）各自只覆盖一部分家 ⇒
//   一加新 API，它两处都不在 ⇒ 面板判"查不到" ⇒ 置灰。
//
//   ⇒ 通用解：**我们自己的那份声明文件** `_crew\档位声明.json` 当**最高优先级、唯一可写出口**：
//
//     {
//       "说明": "…",
//       "<家>": {
//         "default": "standard",        // 这家没单独声明的模型都用这个
//         "models": {
//           "<模型>": ["low","high","max"]   // ← 直接给具体档位（也认 'standard' / 'off-only' / false）
//         }
//       }
//     }
//
//   解析顺序（`capabilityOf`）：
//     ① 声明文件（家→模型 → 家 default）
//     ② messenger 路 → 路由表的 `reasoningEfforts`；其它载体的路 → DSH 档案
//     ③ **都没有 ⇒ `standard`（放行、标 assumed）** —— 这一条就是"加 API 不再置灰"的保证
//   面板**加 API 时自动往声明文件里写一条 `default: standard`**（幂等、不覆盖已有），
//   于是"新加的家"从第一天起就**能选三档**，`_档位对账` 也不会把它判红（判"未核实·黄"，可随时升级成精确声明）。
// ══════════════════════════════════════════════════════════════════════════════════════════

/** 我们的档位能力声明（**唯一可写出口**；面板加 API 时会自动登记一条 default）。 */
export const DECL_FILE = process.env.DSH_EFFORT_DECL ?? join(HERE, '..', '_crew', '档位声明.json')

let _declCache = null
let _declMtime = 0
export function readDecl () {
  try {
    const st = statSync(DECL_FILE)
    if (_declCache && _declMtime === st.mtimeMs) return _declCache
    const j = JSON.parse(readFileSync(DECL_FILE, 'utf8').replace(/^\uFEFF/, ''))
    _declCache = (j && typeof j === 'object') ? j : {}
    _declMtime = st.mtimeMs
    return _declCache
  } catch { return _declCache ?? {} }
}

/**
 * 把"某家（某模型）的档位能力"写进声明文件（**面板加 API / 首次遇到未知模型时自动调用**）。
 * 幂等：**已有的键一个都不覆盖**（用户手填的精确声明优先）。
 * @param {string} home 家名
 * @param {object} opt { models: string[], defaultCap: 'standard'|string[] , why }
 * @returns {{ok:boolean, wrote:boolean, reason?:string}}
 */
export function ensureDecl (home, opt = {}) {
  if (!home) return { ok: false, wrote: false, reason: '缺家名' }
  let j = {}
  try { j = JSON.parse(readFileSync(DECL_FILE, 'utf8').replace(/^\uFEFF/, '')) } catch { j = {} }
  if (!j || typeof j !== 'object') j = {}
  j['说明'] = j['说明'] ?? '档位能力声明（唯一可写出口）：<家>.default / <家>.models.<模型> = ["low","high","max"] 或 "standard" / "off-only" / false。'
    + '解析顺序：本文件 → 路由表(messenger)/DSH档案(其它载体) → 默认 standard（放行并标"未核实"）。面板「＋添加 API」会自动登记一条 default，不会覆盖你手填的。'
  let wrote = false
  const cur = (j[home] && typeof j[home] === 'object') ? j[home] : null
  if (!cur) {
    j[home] = { default: opt.defaultCap ?? 'standard', ...(opt.why ? { 说明: opt.why } : {}) }
    wrote = true
  } else if (cur.default === undefined) {
    cur.default = opt.defaultCap ?? 'standard'
    wrote = true
  }
  // 逐模型补登记：**只补没有的**（不覆盖）
  const models = Array.isArray(opt.models) ? opt.models : []
  if (models.length) {
    j[home].models = (j[home].models && typeof j[home].models === 'object') ? j[home].models : {}
    for (const m of models) {
      const id = String(m ?? '').split(/[\/:]/).pop()
      if (!id || j[home].models[id] !== undefined) continue
      j[home].models[id] = opt.defaultCap ?? 'standard'
      wrote = true
    }
  }
  if (!wrote) return { ok: true, wrote: false, reason: '已有声明，未改动' }
  try {
    writeFileSync(DECL_FILE + '.bak-' + Date.now(), readFileSync(DECL_FILE))
  } catch { /* 第一次建文件时没有旧文件 */ }
  writeFileSync(DECL_FILE, JSON.stringify(j, null, 2), 'utf8')
  _declCache = null
  return { ok: true, wrote: true }
}

/** 把一条声明值（数组 / 'standard' / 'off-only' / false）解释成"支持哪些档位（含 wire 拼写）"。 */
function fromCap (cap) {
  if (cap === false) return { levels: ['off'], wire: { off: 'off' }, reasoning: false, why: '声明为 off-only' }
  if (cap === 'off-only') return { levels: ['off'], wire: { off: 'off' }, reasoning: false, why: '声明为 off-only' }
  if (Array.isArray(cap)) {
    const levels = cap.map(String).filter(x => DSH_LEVELS.includes(x))
    const wire = {}; for (const l of levels) wire[l] = l
    return { levels, wire, reasoning: levels.some(l => l !== 'off'), why: null }
  }
  // 'standard' 或任何没写的形状 ⇒ 标准五档
  const levels = STANDARD_LEVELS.slice(); const wire = {}
  for (const l of levels) wire[l] = l
  return { levels, wire, reasoning: true, why: null }
}

/**
 * **唯一入口**：某家某模型在这个角色走的那条路上，真支持哪些档位。
 * 顺序：声明文件 → 路由表/档案 → 默认 standard（放行＋assumed）。
 */
export function capabilityOf (home, modelId, via = 'carrier') {
  const id = String(modelId ?? '').split(/[\/:]/).pop()
  const decl = readDecl()
  const h = decl?.[home]
  if (h && typeof h === 'object') {
    const cap = (h.models && typeof h.models === 'object' && h.models[id] !== undefined) ? h.models[id] : h.default
    if (cap !== undefined) return { ...fromCap(cap), known: true, assumed: false, source: 'decl' }
  }
  // 没有显式声明 ⇒ 去两个"自动发现源"找（找到就是精确的）
  const auto = (via === 'messenger') ? routeEfforts(home, modelId) : supportedEfforts(home, modelId)
  if (auto.known) return { ...auto, assumed: false }
  // 都找不到 ⇒ **放行**（标准五档）并标未核实 —— 这就是"加 API 不再置灰"的兜底
  return { ...fromCap('standard'), known: true, assumed: true, source: 'assumed',
    why: `「${home}/${id}」没有显式声明（${auto.why ?? '两处都没有'}）⇒ 按默认五档放行（未核实；要精确就写 _crew\\档位声明.json）` }
}

//   病根：`messenger`（调研员）跑的时候，配置是 `coder-b-dsh.mjs` 按 `_coder路由表.json` **现生成**的一份 patch；
//   而 ocgo 只在这张表里、**不在 DSH 档案里** ⇒ 只读档案的检查器直接判"查不到"，
//   面板那一格就被置灰（用户看到的就是"ocgo 不支持选档位"）。
//   而按 DSH 的规则，**没有 `reasoning` 标记的模型只认 `off`** —— 所以要不要支持、支持到几档，
//   完全取决于**我们在生成的那份 patch 里怎么声明**（`reasoning: true` / `reasoningEfforts`）。
//   ⇒ 这里把"路由表"也当声明源：`m.reasoning === true` 或 `route.compat.supportsReasoningEffort === true`
//     ⇒ 标准五档可用；`m.reasoningEfforts` 里的 `xhigh`/`max` 追加。两处都没声明 ⇒ 只有 `off`（如实）。
// ══════════════════════════════════════════════════════════════════════════════════════════
let _routeCache = null
export function routeTable () {
  if (_routeCache) return _routeCache
  try { _routeCache = JSON.parse(readFileSync(ROUTE_FILE, 'utf8').replace(/^\uFEFF/, '')) } catch { _routeCache = {} }
  return _routeCache
}

/** 路由表里某家某模型的能力声明（只读）。 */
export function routeEfforts (home, modelId) {
  const t = routeTable()
  const r = t?.[home]
  if (!r || typeof r !== 'object') return { known: false, levels: [], wire: {}, reasoning: null, why: `路由表里没有这家（${home}）`, source: 'none' }
  const id = String(modelId ?? '').split(/[\/:]/).pop()
  const m = (r.models ?? []).find(x => (typeof x === 'string' ? x : x?.id) === id)
  if (!m || typeof m === 'string') return { known: false, levels: [], wire: {}, reasoning: null, why: `路由表里 ${home} 没列这个模型（${id}）`, source: 'none' }
  // ★ 实测（2026-10-16，3 次真跑）：**只有 `reasoningEfforts` 这一个声明才真正让 DSH 认它是推理模型**；
  //   另写 `reasoning: true` 没用（patch schema 不认，白写）。所以判定就以它为准，其次看 compat。
  const reasoning = Boolean(m.reasoningEfforts && typeof m.reasoningEfforts === 'object') ||
    m.reasoning === true || r.compat?.supportsReasoningEffort === true
  if (!reasoning) {
    return { known: true, levels: ['off'], wire: { off: 'off' }, reasoning: false, source: 'route',
      why: `路由表里这个模型**没声明 reasoningEfforts** ⇒ 生成给 DSH 的配置里它是"非推理模型"，只认 off（实测：要 high 会被硬拒 UNSUPPORTED_REASONING_EFFORT）。要支持就去 _coder路由表.json 给它加 reasoningEfforts` }
  }
  const map = (m.reasoningEfforts && typeof m.reasoningEfforts === 'object') ? m.reasoningEfforts : {}
  const levels = []; const wire = {}
  for (const level of DSH_LEVELS) {
    const mapped = map[level]
    if (mapped === null) continue
    if (OPT_IN_LEVELS.includes(level) && mapped === undefined) continue
    levels.push(level); wire[level] = mapped ?? level
  }
  return { known: true, levels, wire, reasoning: true, why: null, source: 'route' }
}

/**
 * **按这个角色走哪条路**取"真支持的档位"（唯一入口）。
 *   via='messenger' ⇒ 读**路由表**（那份生成的 patch 就是从它来的）
 *   其它（pi / opencode / codebuddy / qwencode）⇒ 读 **DSH 档案**
 *   两处都查不到 ⇒ 回退"标准五档（assumed：按 DSH 默认，未核实）"—— **不置灰**，但如实标 assumed。
 */
export function supportedEffortsVia (home, modelId, via = 'carrier') {
  // ★ 2026-10-16：**统一走 `capabilityOf`** —— 声明文件优先，其次自动发现源，最后默认 standard（放行＋assumed）。
  //   这样"看板上加一个新 API"不会再因为"两处都没登记"而置灰（用户口径：要通用方案，不是每家手动补）。
  return capabilityOf(home, modelId, via)
}


/**
 * 把一个**抽象档**落到某个模型上（核心函数）。
 * @returns {{ tier, want: string[], resolved: string|null, wire: string|null, status: 'ok'|'degraded'|'unsupported'|'unknown', supported: string[], why }}
 */
export function resolveEffort (home, modelId, tier, tiers, opts = {}) {
  const cands = (tiers?.[tier] ?? DEFAULT_EFFORT_TIERS[tier] ?? []).map(String)
  const s = opts.via ? supportedEffortsVia(home, modelId, opts.via) : supportedEfforts(home, modelId)
  if (!s.known) return { tier, want: cands, resolved: null, wire: null, status: 'unknown', supported: [], why: s.why }
  if (!s.levels.length) {
    return { tier, want: cands, resolved: null, wire: null, status: 'unsupported', supported: [], why: `${home}/${String(modelId).split('/').pop()} 一个档位都不支持` }
  }
  const hit = cands.find(c => s.levels.includes(c))
  if (!hit) {
    // 一个候选都没有：注意 pi 那边不会报错，而是**静默夹到**它支持的最高/最近一档 —— 这才是要留痕的静默
    return { tier, want: cands, resolved: null, wire: null, status: 'unsupported', supported: s.levels,
      why: `它支持 ${s.levels.join(' / ')}，「${tier}」的候选（${cands.join(' / ')}）一个都不在 ⇒ 会被静默夹到 ${s.levels[s.levels.length - 1]}` }
  }
  const status = hit === cands[0] ? 'ok' : 'degraded'
  return {
    tier, want: cands, resolved: hit, wire: s.wire?.[hit] ?? hit, status, supported: s.levels,
    source: s.source ?? null, assumed: Boolean(s.assumed),
    why: status === 'degraded'
      ? `「${tier}」首选 ${cands[0]} 它没有 ⇒ 落成 ${hit}（它支持 ${s.levels.join(' / ')}）${s.assumed ? '（未核实：按 DSH 默认口径）' : ''}`
      : (s.assumed ? s.why : null)
  }
}

/** 给界面用：某模型真支持的档位（按角色走哪条路取来源；`assumed` ＝未核实但按默认口径放行）。 */
export function effortChoices (home, modelId, via = 'carrier') {
  const s = supportedEffortsVia(home, modelId, via)
  return { known: s.known, values: s.levels, why: s.why, reasoning: s.reasoning, assumed: Boolean(s.assumed), source: s.source ?? null }
}
