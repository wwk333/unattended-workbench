#!/usr/bin/env node
/**
 * 同步载体模型 —— 把「② 管 API / 钥匙」里**你勾选的模型**（`_coder路由表.json` 的已选）
 * 写进**载体自己**的模型清单，让"看板上能选"和"载体真能跑"变成同一件事。
 *
 * ## 为什么要有它（用户口径 2026-10-12）
 * 「难道不能我看板点击直接同步去配置载体的模型列表吗？」
 * 现实是：面板的候选来自 **DSH 档案**（`cordis.patch.yml` 的 `llm-pi-ai.providers.*`），
 * 而 coder-a 用的 **Pi 命令行读的是它自己目录**（`~/.pi/agent/models.json`）。
 * 实测（`pi --list-models`）：Pi 只自带 `xiaomi` / `xiaomi-token-plan-cn` / `qwen-token-plan-cn`，
 * **不认识 `ark` / `SiliconFlow` / `ocgo` / `u2`** ⇒ 面板给 coder-a 摆的那些是**假选项**：
 * 选了写进去，Pi 跑起来会说"不认识这家"。（账本也印证：coder-a 47 次里 `ark` 0 次、`u2` 0 次。）
 *
 * ## 做法
 * ① 读路由表的**已选**（`keep !== false`）当作唯一真源 —— 就是你在 ② 里勾的那些；
 * ② 用**假钥匙**问一次 Pi（`--list-models`）：列出来的就是**它自带的家** ⇒ **跳过**（别去覆盖它的内置清单，
 *    那会把 `xiaomi` 的 6 个模型替换成你只勾的 2 个）；
 * ③ 剩下的家按 Pi 官方的"兼容端点"写法声明进 `models.json`：
 *    `{ providers: { <家>: { baseUrl, api, apiKey: "${<钥匙环境变量>}", models: [{id}] } } }`
 *    ⚠️ `apiKey` 一律写成 **`${环境变量}` 引用**（Pi 支持），**绝不把密钥写进文件**；
 * ④ **合并写**：文件里原有、但不是我们声明的条目**原样保留**；我们上次声明、这次②里没有了 ⇒ 删掉
 *    （"哪几家是我们声明的"记在旁边的 `models.synced.json`，因为 JSON 不能写注释）。
 *
 * ## 用法
 *   node 同步载体模型.mjs            # 真写（会先备份）
 *   node 同步载体模型.mjs --dry      # 只打印将要写入的内容，不碰任何文件
 *   node 同步载体模型.mjs --carrier pi --pi-cli <path>   # 探针/排障用
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverProviders, resolveKey, loadBlocked } from './额度钥匙.mjs'
import { carrierNameOf, carrierKeyEnvOf } from './_家名.mjs'
// ★★ 2026-10-24：路径占位符**只认** `_agents-config.mjs` 的 PLACEHOLDERS（单一实现，见下方 AGENTS/NODE 的说明）。
import { PLACEHOLDERS } from './_agents-config.mjs'
// ★ 2026-10-23（施工文档 W2/W3 · 下发）：模型能力（上下文/最大输出）从 `_crew\模型能力.json` 来，**不在这里猜**。
import { capacityOf } from './模型能力.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, '..')
// ★★ 2026-10-24 修（用户问："看板 API 里 coder-a 为什么能选的比 coder-b 少？不应该选择一样多吗？"）——
//   症状：coder-a（pi）的下拉只有 6 个候选、缺 SiliconFlow / ocgo；coder-b（opencode）有 12 个。
//   真相：**下面这两行是搬家前的旧推法**。工作台搬到 `<工作台根>` 之后 `resolve(WORKSPACE,'..')` = `<盘符>\`
//     ⇒ `NODE` 算成 `<DSH根>\...\node.exe`（那个文件不存在）
//     ⇒ `piListModels()` 每次 spawn **立刻失败**（实测 1 ms、status=null、零输出）
//     ⇒ `_载体能力.mjs` 的 `fetchPiHomes()` 一个家都拿不到 ⇒ **静默回落档案** `cordis.patch.yml`
//       （那份只声明 ark / xiaomi / u2 / opencode-go）⇒ 下拉只摆得出 6 个。
//   而 **Pi 自己**的 `~/.pi/agent/models.json` 里 12 个全有（ark·SiliconFlow·xiaomi-token-plan-cn·ocgo·u2）
//   ⇒ 它本来就够得着全部 12 个，是**我们问不到**，不是它不能。
//   同一个坑 `_agents-config.mjs` 2026-10-18 已经修过（改成 APP_ROOT 探测），这里是**漏改的第二份实现**。
//   口径：不再自己推路径，直接取那边算好的 PLACEHOLDERS（`NODE` = 真 node、`AGENTS` = 真 agents 根）。
//   ⚠️ 只能**惰性取**：本模块与 `_agents-config.mjs` **互为 import**（它要本模块的 `carrierModelBinding`）
//      ⇒ 模块顶层读它的 `PLACEHOLDERS` 会踩 TDZ（实测：`ReferenceError: Cannot access 'PLACEHOLDERS' before initialization`）。
const agentsRoot = () => PLACEHOLDERS.AGENTS
const nodeBin = () => PLACEHOLDERS.NODE
const HOME = process.env.USERPROFILE ?? process.env.HOME ?? ''
/** Pi 的 agent 目录（它自己读 `models.json` 的地方；探针可用环境变量指到临时目录）。 */
export const PI_AGENT_DIR = process.env.PI_CODING_AGENT_DIR ?? join(HOME, '.pi', 'agent')
export const PI_MODELS = join(PI_AGENT_DIR, 'models.json')
export const PI_SIDECAR = join(PI_AGENT_DIR, 'models.synced.json')

const argv = process.argv.slice(2)
const has = (f) => argv.includes('--' + f)
const opt = (f, d = null) => { const i = argv.indexOf('--' + f); return i >= 0 ? (argv[i + 1] ?? d) : d }
const DRY = has('dry')

function readJson (f, d = null) { try { return JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) } catch { return d } }
function writeJson (f, obj) {
  mkdirSync(dirname(f), { recursive: true })
  writeFileSync(f, JSON.stringify(obj, null, 2) + '\n', 'utf8')
}

/** Pi 的命令行入口（从 `_crew\agents.json` 现读；`${AGENTS}`/`${NODE}` 占位符照 `_agents-config.mjs` 的口径展开）。 */
export function piEntry () {
  const override = opt('pi-cli')
  if (override) return { node: null, entry: override }
  const cfg = readJson(process.env.DSH_AGENTS_CONFIG ?? join(WORKSPACE, '_crew', 'agents.json'), {})
  const a = cfg?.agents?.pi ?? {}
  const ex = (s) => String(s ?? '').replace(/\$\{AGENTS\}/g, agentsRoot()).replace(/\$\{NODE\}/g, nodeBin()).replace(/\$\{WORKSPACE\}/g, WORKSPACE)
  return { node: ex(a.node) || null, entry: ex(a.entry) }
}

/** 带着"这个家"该有的环境变量跑一次 Pi，把 `--list-models` 的输出解析成 `{ 家: [模型…] }`。 */
export function piListModels (env = {}) {
  const { node, entry } = piEntry()
  if (!entry || !existsSync(entry)) return { ok: false, why: '找不到 Pi 的入口：' + entry, homes: {} }
  const r = spawnSync(node || process.execPath, [entry, '--list-models'], {
    encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...env, CI: '' }
  })
  const out = String(r.stdout ?? '') + String(r.stderr ?? '')
  const homes = {}
  for (const line of out.split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)\s/.exec(line.trim())
    if (!m || m[1] === 'provider') continue
    ;(homes[m[1]] = homes[m[1]] ?? []).push(m[2])
  }
  return { ok: r.status === 0, code: r.status, homes, raw: out.trim().slice(0, 400) }
}

/** ② 的"已选"（＝路由表里 `keep !== false` 的模型）＋ 被删掉的家剔除。 */
export function selection () {
  const provs = discoverProviders()
  const blocked = loadBlocked()
  const out = []
  for (const [name, v] of Object.entries(provs)) {
    // 「删」＝这家整个不用了（判据与面板一致：屏蔽名单里有它 且 一把钥匙都解析不到）
    if ((blocked[name] ?? []).length && !resolveKey(name, 0, undefined, undefined, provs)) continue
    const models = (v.models ?? []).filter(Boolean)
    if (!models.length) continue
    out.push({ canon: name, baseUrl: v.baseURL ?? null, api: v.api ?? 'openai-completions', apiKeyEnv: v.apiKeyEnv ?? null, headers: v.headers ?? null, models })
  }
  return out
}

/** 每个家在每个载体上的名字 + 钥匙变量名（`perCarrier` 优先，见 `_家名.mjs`）。 */
export function homeForCarrier (h, carrier = 'pi') {
  return {
    name: carrierNameOf(h.canon, carrier),
    keyEnv: carrierKeyEnvOf(h.canon, carrier) ?? h.apiKeyEnv ?? null
  }
}
/** 给 `_载体能力.mjs` 用的两个便利别名（它只关心 Pi）。 */
export const piSelection = () => selection()
export const piHomeForCarrier = (h) => homeForCarrier(h, 'pi')

// ── 能力下发（2026-10-23 施工文档 W2/W3）────────────────────────────────────────
//
// 为什么必须下发：pi 的兜底是 `maxTokens ?? 16384` / `contextWindow ?? 128e3`，真值是 131072 / 1048576
//   ⇒ 不写进去，载体就按 1/8 容量跑（T1-01 #1 那张卡 8.6 分钟、正文 0 字、stopReason=length 就是这么来的）。
// 铁律：**拿不到就不写**（不许写 16384 这类默认值 —— 错值会 400，比默认值更糟）。

/** 查一个模型的能力；`found=false` 返回 null（调用方据此**不写**任何字段，并在输出里点名）。 */
export function capacityOfModel (providerName, modelId) {
  try {
    const c = capacityOf(`${providerName}/${modelId}`)
    return c?.found ? c : null
  } catch { return null }
}

/** pi 的模型条目：`{id}` ＋ `maxTokens` / `contextWindow`（W0 实测这两字段进得了请求）。 */
export function piModelEntry (providerName, id) {
  const c = capacityOfModel(providerName, id)
  if (!c) return { id }
  const e = { id }
  if (c.maxOutputTokens) e.maxTokens = c.maxOutputTokens
  if (c.contextWindow) e.contextWindow = c.contextWindow
  return e
}

/** opencode 的 `limit`：**两字段必须同时给**（只给一个会让整份配置加载失败，见施工文档 §6）。
 *  缺任一个 ⇒ 返回 null ⇒ 整块 `limit` 不写（宁可让它用默认，也不写出加载不了的配置）。 */
export function opencodeLimit (providerName, id) {
  const c = capacityOfModel(providerName, id)
  if (!c || !c.contextWindow || !c.maxOutputTokens) return null
  return { context: c.contextWindow, output: c.maxOutputTokens }
}

/** codebuddy 的两个上限字段（W0 实测名字是 `maxInputTokens` / `maxOutputTokens`，**不是** `maxTokens`）。 */
export function codebuddyCaps (providerName, id) {
  const c = capacityOfModel(providerName, id)
  if (!c) return null
  const out = {}
  if (c.contextWindow) out.maxInputTokens = c.contextWindow
  if (c.maxOutputTokens) out.maxOutputTokens = c.maxOutputTokens
  return Object.keys(out).length ? out : null
}

/** 这批模型里**能力未知**的那些（同步输出要点名，不许静默）。 */
function capacityUnknown (providerName, ids) {
  return ids.filter(id => !capacityOfModel(providerName, id))
}

/**
 * 算出 Pi 的 `models.json` 该长什么样（**不写盘**；纯函数，便于探针）。
 * 返回 `{ providers, declared, skippedBuiltin, removed, envForProbe }`。
 */
export function planPi () {
  const sel = selection()
  // ① 假钥匙问一次：列出来的家 ＝ Pi 自带（跳过，别覆盖它的内置模型清单）
  const probeEnv = {}
  for (const h of sel) {
    const { keyEnv } = homeForCarrier(h, 'pi')
    if (keyEnv) probeEnv[keyEnv] = 'dummy-probe-key'
  }
  const probe = piListModels(probeEnv)
  const old = readJson(PI_MODELS, {}) ?? {}
  const sidecar = readJson(PI_SIDECAR, { synced: [] })
  const keepForeign = {}
  const mineBefore = new Set(Array.isArray(sidecar.synced) ? sidecar.synced : [])
  // ⚠️ **必须把我们上次自己声明的那些家排除掉**：它们写进 `models.json` 之后，假钥匙一探也会被列出来
  //    ⇒ 会被误判成"Pi 自带" ⇒ 下一次运行就把它们**删掉**（实测：声明 → 删 → 再声明，来回振荡，
  //      中间那一下 Pi 真就不认它们了）。旁挂的 `models.synced.json` 就是为这个判据存在的。
  const builtin = new Set(Object.keys(probe.homes).filter((n) => !mineBefore.has(n)))
  for (const [k, v] of Object.entries(old.providers ?? {})) if (!mineBefore.has(k)) keepForeign[k] = v

  const providers = { ...keepForeign }
  const declared = []
  const skippedBuiltin = []
  const unknownCap = []
  for (const h of sel) {
    const { name, keyEnv } = homeForCarrier(h, 'pi')
    if (!name) continue
    if (builtin.has(name)) { skippedBuiltin.push(name); continue }        // Pi 自带 ⇒ 不动它
    if (!h.baseUrl) continue                                             // 没地址声明不了（如实跳过）
    providers[name] = {
      baseUrl: h.baseUrl,
      api: h.api,
      ...(keyEnv ? { apiKey: '${' + keyEnv + '}' } : {}),
      // ★ 2026-10-23：带上 `maxTokens` / `contextWindow`（W0 实测：写 131072 真跑出 25,395 输出）
      models: h.models.map((id) => piModelEntry(name, id))
    }
    const miss = capacityUnknown(name, h.models)
    if (miss.length) unknownCap.push({ carrier: 'pi', home: name, models: miss })
    declared.push({ name, models: h.models.length, keyEnv, capped: h.models.length - miss.length })
  }
  const removed = [...mineBefore].filter((k) => !declared.some((d) => d.name === k))
  return { providers, declared, skippedBuiltin, removed, unknownCap, probeOk: probe.ok, probeRaw: probe.raw, envForProbe: probeEnv }
}

/** 跑一次同步（默认只做 Pi）。返回给人看的几行。 */
export function syncPi ({ dry = false } = {}) {
  const plan = planPi()
  const lines = []
  const body = { providers: plan.providers }
  const before = readJson(PI_MODELS, null)
  const same = before && JSON.stringify(before) === JSON.stringify(body)
  lines.push('载体 pi：声明 ' + (plan.declared.length ? plan.declared.map((d) => d.name + '(' + d.models + ')').join('、') : '（无）')
    + (plan.skippedBuiltin.length ? '　·　它自带的跳过：' + plan.skippedBuiltin.join('、') : '')
    + (plan.removed.length ? '　·　清掉已不在②里的：' + plan.removed.join('、') : ''))
  if (plan.declared.some((d) => !d.keyEnv)) lines.push('⚠️ 有家没有声明钥匙变量名 ⇒ 它列出来也没法鉴权')
  // ★ 2026-10-23：能力下发要能看见 —— 写进去多少条、哪些还是未知（未知的照样写 `{id}`，载体用它自己的兜底）
  const capped = plan.declared.reduce((a, d) => a + (d.capped ?? 0), 0)
  const total = plan.declared.reduce((a, d) => a + d.models, 0)
  if (total) lines.push(`　·　能力下发：${capped}/${total} 条写上了 maxTokens/contextWindow${capped < total ? `，⚠️ ${total - capped} 条**能力未知**（载体将用它自己的默认值 —— 跑「模型能力.mjs refresh」或手填）` : ' ✅'}`)
  if (dry) { lines.push('（--dry：不写盘）'); return { ok: true, lines, plan, body, wrote: false } }
  if (same) { lines.push('文件内容没变化 ⇒ 不重写（' + PI_MODELS + '）'); return { ok: true, lines, plan, body, wrote: false } }
  try {
    if (before) copyFileSync(PI_MODELS, PI_MODELS + '.bak-' + Date.now())
    writeJson(PI_MODELS, body)
    writeJson(PI_SIDECAR, { 说明: '哪几家是「同步载体模型.mjs」声明进 models.json 的（JSON 不能写注释，只能记在旁边的文件里）', at: new Date().toISOString(), synced: plan.declared.map((d) => d.name) })
    lines.push('✅ 已写入 ' + PI_MODELS + '（密钥用 ${环境变量} 引用，**不落盘**）')
  } catch (e) {
    return { ok: false, lines: lines.concat('❌ 写不进去：' + String(e?.message ?? e)), plan, body, wrote: false }
  }
  return { ok: true, lines, plan, body, wrote: true }
}

/** OpenCode 的配置文件（它自己的 provider 段）＋"哪几家是我们加进去的"旁挂记录。 */
export function opencodeFile () {
  const override = process.env.OPENCODE_CONFIG
  if (override) return override
  const cfg = readJson(process.env.DSH_AGENTS_CONFIG ?? join(WORKSPACE, '_crew', 'agents.json'), {})
  const p = String(cfg?.agents?.opencode?.env?.OPENCODE_CONFIG ?? '')
  const ex = p.replace(/\$\{AGENTS\}/g, agentsRoot()).replace(/\$\{WORKSPACE\}/g, WORKSPACE)
  return ex || join(agentsRoot(), 'config', 'opencode', 'opencode.json')
}
export const OPENCODE_SIDECAR = join(WORKSPACE, '_crew', 'opencode.synced.json')

/**
 * 算出 OpenCode 的 `opencode.json` 该怎么改（**纯函数，不写盘**）。
 *
 * 口径（比 Pi 更保守，因为这份文件是**手写过的**、还有 `agent`/`instructions` 等段）：
 *   · ② 里有、它没有的家 ⇒ **整家加上**（`{env:钥匙变量}` 引用，密钥不落盘）；
 *   · ② 里有、它也有、但缺某些已选模型 ⇒ **只补缺的模型**，**绝不删**它原有的（手写的 `glm-5.3` 那些留着）；
 *   · 我们加过、现在 ② 里没有的家 ⇒ 删掉（只删**我们加的**，旁挂文件记着是哪几家）。
 */
export function planOpenCode () {
  const file = opencodeFile()
  const cfg = readJson(file, null)
  if (!cfg) return { ok: false, why: '读不到 ' + file, file }
  const sel = selection()
  const sidecar = readJson(OPENCODE_SIDECAR, { added: [] })
  const addedBefore = new Set(Array.isArray(sidecar.added) ? sidecar.added : [])
  const prov = { ...(cfg.provider ?? {}) }
  const want = new Map()
  for (const h of sel) {
    const name = carrierNameOf(h.canon, 'opencode')
    const keyEnv = carrierKeyEnvOf(h.canon, 'opencode') ?? h.apiKeyEnv
    // ⚠️ 字段名是 **`baseUrl`**（`selection()` 里就是这么起的）。我第一版写成 `h.baseURL` ⇒
    //    `!h.baseURL` 恒为真 ⇒ **全部 continue** ⇒ 计划永远"没有新家"、静默什么都不做
    //    （Pi 那条用的是 `h.baseUrl` 所以没事）。探针已钉住这条。
    if (!name || !h.baseUrl) continue
    // ★ b38：这家要求的额外请求头（例 `ocgo` 要 `x-opencode-session`）也要带进它的 options
    const headers = (h.headers && typeof h.headers === 'object') ? h.headers : null
    want.set(name, { baseURL: h.baseUrl, keyEnv, models: h.models, headers })
  }
  const added = []
  const extended = []
  const removed = []
  const unknownCap = []
  for (const n of addedBefore) if (!want.has(n) && prov[n]) { delete prov[n]; removed.push(n) }
  for (const [name, w] of want) {
    const has = prov[name]
    const modelObjs = () => Object.fromEntries(w.models.map((id) => {
      const lim = opencodeLimit(name, id)
      return [id, { name: id, ...(lim ? { limit: lim } : {}) }]
    }))
    const miss = capacityUnknown(name, w.models)
    if (miss.length) unknownCap.push({ carrier: 'opencode', home: name, models: miss })
    if (!has) {
      prov[name] = {
        name: name + '（同步自 ② 管 API）',
        npm: '@ai-sdk/openai-compatible',
        options: { baseURL: w.baseURL, ...(w.keyEnv ? { apiKey: '{env:' + w.keyEnv + '}' } : {}), ...(w.headers ? { headers: w.headers } : {}) },
        models: modelObjs()
      }
      added.push({ name, models: w.models.length, capped: w.models.length - miss.length })
      continue
    }
    has.options = has.options ?? {}
    has.models = has.models ?? {}
    const missIds = w.models.filter((id) => !has.models[id])
    for (const id of missIds) {
      const lim = opencodeLimit(name, id)
      has.models[id] = { name: id + '（同步自 ② 管 API）', ...(lim ? { limit: lim } : {}) }
    }
    // ★ 2026-10-23：**已经存在的条目也要补 limit**（老条目是 `{name}`，不补就永远按默认 16384 跑）。
    let patched = 0
    for (const id of w.models) {
      const cur = has.models[id]
      if (!cur || cur.limit) continue
      const lim = opencodeLimit(name, id)
      if (!lim) continue
      cur.limit = lim
      patched++
    }
    if (missIds.length) extended.push({ name, models: missIds.length, capped: missIds.length - (missIds.filter(id => opencodeLimit(name, id)).length) })
    if (patched && !missIds.length) extended.push({ name, models: 0, patchedLimit: patched })
    if (!has.options.baseURL) has.options.baseURL = w.baseURL
    if (!has.options.apiKey && w.keyEnv) has.options.apiKey = '{env:' + w.keyEnv + '}'
    if (w.headers && !has.options.headers) has.options.headers = w.headers
  }
  return { ok: true, file, cfg: { ...cfg, provider: prov }, added, extended, removed, unknownCap }
}

/** 跑一次 OpenCode 同步（**只合并、不重建**；有变化才写，写前备份）。 */
export function syncOpenCode ({ dry = false } = {}) {
  const plan = planOpenCode()
  if (!plan.ok) return { ok: false, lines: ['载体 opencode：' + plan.why], plan, wrote: false }
  const lines = ['载体 opencode（' + plan.file + '）：'
    + (plan.added.length ? '加上 ' + plan.added.map((d) => d.name + '(' + d.models + ')').join('、') : '没有新家')
    + (plan.extended.length ? '　·　补模型 ' + plan.extended.map((d) => d.name + '×' + d.models).join('、') : '')
    + (plan.removed.length ? '　·　清掉我们加过、② 里已没有的 ' + plan.removed.join('、') : '')]
  const before = readJson(plan.file, null)
  const same = before && JSON.stringify(before) === JSON.stringify(plan.cfg)
  if (dry || same) {
    lines.push(dry ? '（--dry：不写盘）' : '文件内容没变化 ⇒ 不重写')
    return { ok: true, lines, plan, wrote: false }
  }
  try {
    copyFileSync(plan.file, plan.file + '.bak-' + Date.now())
    writeJson(plan.file, plan.cfg)
    writeJson(OPENCODE_SIDECAR, { 说明: '哪几家是「同步载体模型.mjs」加进 OpenCode 配置的（JSON 不能写注释，只能记在旁边）', at: new Date().toISOString(), added: [...new Set([...plan.added.map((d) => d.name), ...(readJson(OPENCODE_SIDECAR, { added: [] }).added ?? []).filter((n) => !plan.removed.includes(n))])] })
    lines.push('✅ 已写入（密钥仍是 {env:变量} 引用，**不落盘**）')
  } catch (e) {
    return { ok: false, lines: lines.concat('❌ 写不进去：' + String(e?.message ?? e)), plan, wrote: false }
  }
  return { ok: true, lines, plan, wrote: true }
}

/** CodeBuddy 的模型清单（`CODEBUDDY_CONFIG_DIR\models.json`）＋旁挂记录。 */
export function codebuddyFile () {
  const override = process.env.CODEBUDDY_CONFIG_DIR
  if (override) return join(override, 'models.json')
  const cfg = readJson(process.env.DSH_AGENTS_CONFIG ?? join(WORKSPACE, '_crew', 'agents.json'), {})
  const d = String(cfg?.agents?.codebuddy?.env?.CODEBUDDY_CONFIG_DIR ?? '')
  const ex = d.replace(/\$\{AGENTS\}/g, agentsRoot()).replace(/\$\{WORKSPACE\}/g, WORKSPACE)
  return join(ex || join(agentsRoot(), 'config', 'codebuddy'), 'models.json')
}
export const CODEBUDDY_SIDECAR = join(WORKSPACE, '_crew', 'codebuddy.synced.json')

/**
 * 算出 CodeBuddy 的 `models.json` 该怎么改（**纯函数**）。
 *
 * 依据（2026-10-12 **真跑实验**）：它的 `models` 数组**一条模型一个 `url`** —— 我用临时配置目录加了
 * 一条指向 SiliconFlow（`custom-local:zai-org/GLM-5.3-Flash`）⇒ **真跑成功**（`is_error=false`、"好"），
 * 而 `CODEBUDDY_BASE_URL` **没有**覆盖 per-model 的 `url`。⇒ "只能吃火山"是**我们自己钉的**，不是它的限制。
 * 口径：② 里每家已选的模型 ⇒ 一条 `custom-local:<模型>` 条目（`apiKey` 写 `${钥匙变量}`，密钥不落盘）；
 *   **绝不删**它原有的条目（手写的 `kimi-k3` 那条留着）；我们加过、② 里没有了的 ⇒ 删掉（仅限我们加的）。
 */
export function planCodeBuddy () {
  const file = codebuddyFile()
  const cfg = readJson(file, null)
  if (!cfg) return { ok: false, why: '读不到 ' + file, file }
  const sel = selection()
  const sidecar = readJson(CODEBUDDY_SIDECAR, { added: [] })
  const mineBefore = new Set(Array.isArray(sidecar.added) ? sidecar.added : [])
  const list = Array.isArray(cfg.models) ? cfg.models.slice() : []
  const added = []
  const removed = []
  const wantIds = new Map()          // id → {url, apiKeyEnv, name, vendor}
  for (const h of sel) {
    const keyEnv = carrierKeyEnvOf(h.canon, 'codebuddy') ?? h.apiKeyEnv          // 无 perCarrier ⇒ 路由表变量名
    if (!h.baseUrl) continue
    for (const m of h.models) {
      wantIds.set('custom-local:' + m, {
        url: String(h.baseUrl).replace(/\/+$/, '') + '/chat/completions',
        apiKeyEnv: keyEnv, name: m + '（' + h.canon + '）', vendor: h.canon
      })
    }
  }
  for (let i = list.length - 1; i >= 0; i--) {
    const id = String(list[i]?.id ?? '')
    if (mineBefore.has(id) && !wantIds.has(id)) { list.splice(i, 1); removed.push(id) }
  }
  const have = new Set(list.map((x) => String(x?.id ?? '')))
  for (const [id, w] of wantIds) {
    if (have.has(id)) continue
    // ★ 2026-10-23：codebuddy 的上限字段是 `maxInputTokens` / `maxOutputTokens`（W0 实测，**不是** maxTokens）
    const caps = codebuddyCaps(w.vendor, id.replace(/^custom-local:/, ''))
    list.push({
      id, name: w.name, vendor: w.vendor,
      ...(w.apiKeyEnv ? { apiKey: '${' + w.apiKeyEnv + '}' } : {}),
      url: w.url, supportsToolCall: true,
      ...(caps ?? {})
    })
    added.push(id)
  }
  // 已有条目也补上限（老条目没有这两个键 ⇒ 它按自己的默认跑）
  let patched = 0
  for (const e of list) {
    const id = String(e?.id ?? '')
    if (!wantIds.has(id)) continue
    if (e.maxOutputTokens || e.maxInputTokens) continue
    const caps = codebuddyCaps(wantIds.get(id).vendor, id.replace(/^custom-local:/, ''))
    if (!caps) continue
    Object.assign(e, caps); patched++
  }
  const unknownCap = []
  for (const [id, w] of wantIds) if (!codebuddyCaps(w.vendor, id.replace(/^custom-local:/, ''))) unknownCap.push({ carrier: 'codebuddy', home: w.vendor, models: [id.replace(/^custom-local:/, '')] })
  return { ok: true, file, cfg: { ...cfg, models: list }, added, removed, patched, unknownCap }
}

/** 跑一次 CodeBuddy 同步（只合并、不重建；有变化才写，写前备份）。 */
export function syncCodeBuddy ({ dry = false } = {}) {
  const plan = planCodeBuddy()
  if (!plan.ok) return { ok: false, lines: ['载体 codebuddy：' + plan.why], plan, wrote: false }
  const lines = ['载体 codebuddy（' + plan.file + '）：'
    + (plan.added.length ? '加上 ' + plan.added.length + ' 条模型（' + plan.added.slice(0, 3).join('、') + (plan.added.length > 3 ? ' 等' : '') + '）' : '没有要加的模型')
    + (plan.removed.length ? '　·　清掉我们加过、② 里已没有的 ' + plan.removed.length + ' 条' : '')]
  const before = readJson(plan.file, null)
  const same = before && JSON.stringify(before) === JSON.stringify(plan.cfg)
  if (dry || same) {
    lines.push(dry ? '（--dry：不写盘）' : '文件内容没变化 ⇒ 不重写')
    return { ok: true, lines, plan, wrote: false }
  }
  try {
    copyFileSync(plan.file, plan.file + '.bak-' + Date.now())
    writeJson(plan.file, plan.cfg)
    const prev = (readJson(CODEBUDDY_SIDECAR, { added: [] }).added ?? []).filter((x) => !plan.removed.includes(x))
    writeJson(CODEBUDDY_SIDECAR, { 说明: '哪些模型条目是「同步载体模型.mjs」加进 CodeBuddy models.json 的（JSON 不能写注释）', at: new Date().toISOString(), added: [...new Set([...plan.added, ...prev])] })
    lines.push('✅ 已写入（apiKey 仍是 ${变量} 引用，**不落盘**）')
  } catch (e) {
    return { ok: false, lines: lines.concat('❌ 写不进去：' + String(e?.message ?? e)), plan, wrote: false }
  }
  return { ok: true, lines, plan, wrote: true }
}

/** Qwen Code 的用户设置（它读 `~/.qwen/settings.json` 的 `modelProviders`）＋旁挂记录。 */
export const QWEN_SETTINGS = join(process.env.QWEN_DIR ?? join(HOME, '.qwen'), 'settings.json')
export const QWEN_SIDECAR = join(WORKSPACE, '_crew', 'qwen.synced.json')

/**
 * 算出 Qwen Code 的 `settings.json` 该怎么改（**纯函数**）。
 *
 * 依据（官方文档 `bundled/qc-helper/docs/configuration/model-providers.md`）：
 *   `modelProviders: { "<providerId>": ModelConfig[] }`，每个条目 `{ id, envKey?, name?, baseUrl? }`，
 *   **凭据永不写进设置**（运行时从 `process.env[envKey]` 读）；`openai` 是内置 provider id（auth 类型）。
 *   ⚠️ 模型身份 = (协议, id, baseUrl) 三元组 ⇒ 同一个 id 配不同 baseUrl 是**两条不同路由**；
 *   headless 用 `--model <id>` 选，**同名 id 跨家会撞**（谁在前选谁）⇒ 本同步对"撞名"的家
 *   **跳过不写**并在输出里点名（宁可少写，也不写出一条选不准的路由）。
 */
export function planQwen () {
  const file = QWEN_SETTINGS
  const cfg = readJson(file, {}) ?? {}
  const sel = selection()
  const added = []
  const removed = []
  const skipped = []
  // ★★ b46（"加 + 是哪家的"的**正解**）：Qwen Code 支持**自定义 provider id** ——
  //   `modelProviders: { "<家>": [...] }` ＋ 顶层 `providerProtocol: { "<家>": "openai" }`
  //   （官方文档原话："group several OpenAI-compatible endpoints under a friendlier name"），
  //   选择器是 **`provider:modelId`** ⇒ 每家一个 provider id ⇒ **同名跨家不再撞**，
  //   面板的选项值就能写成 `<家>:<模型>`（既不去重、又真能按家选）。
  const groups = { ...(cfg.modelProviders ?? {}) }
  const managed = new Set(sel.map((h) => h.canon))
  const before = new Set()
  for (const [k, arr] of Object.entries(groups)) {
    if (!managed.has(k)) continue                      // 不是我们管的 provider id ⇒ 一律不碰
    for (const x of (arr ?? [])) before.add(k + ':' + x.id)
    delete groups[k]                                   // 我们管的**整组重建**（幂等且不留旧条目）
  }
  const want = new Map()                               // 键 = `家|模型` ⇒ 同名跨家各留一条
  for (const h of sel) {
    const keyEnv = carrierKeyEnvOf(h.canon, 'qwencode') ?? h.apiKeyEnv
    if (!h.baseUrl) continue
    const headers = (h.headers && Object.keys(h.headers).length) ? h.headers : null
    // ★★ b48（方法 B）：baseUrl 指到**本机路由网关** —— `http://127.0.0.1:19420/<家>`
    //   （网关再把 `/<家>/<其余>` 转发到那家的真地址、补那家要求的头、换成那家的钥匙）
    //   ⇒ 载体侧**不再需要**知道真实端点，也不必拿钥匙；同名跨家由**路径**区分 ⇒ 天然不冲突。
    //   网关没起来时载体**直接失败**（用户拍板 A：失败要响，不静默回落）。
    const viaRouter = (process.env.DSH_ROUTER_URL ?? 'http://127.0.0.1:19420').replace(/\/+$/, '') + '/' + h.canon
    // ★★W11（方案 B）：条目 id 用**全局唯一**的 `家/模型` —— 载体照抄给网关，
    //   网关按路径剥前缀后上游收到的仍是真名。这样"同名跨家"不再靠运气，也不必再有"独占勾选"。
    for (const m of h.models) want.set(h.canon + '|' + m, { id: h.canon + '/' + m, upstream: m, name: m + '（' + h.canon + '）', baseUrl: viaRouter, envKey: keyEnv, headers, canon: h.canon })
  }
  for (const [, w] of want) {
    const g = groups[w.canon] ?? (groups[w.canon] = [])
    if (g.some((x) => String(x?.id ?? '') === w.id)) continue   // 幂等：同一个 `家/模型` 只留一条
    g.push({
      id: w.id, name: w.name, baseUrl: w.baseUrl, ...(w.envKey ? { envKey: w.envKey } : {}),
      // 这家要求的额外请求头写进 `generationConfig.customHeaders`；值用官方的 `${session_id}` 占位符
      //（Qwen Code 文档原文就拿 OpenCode Go 当例子：它拒收没有 `x-opencode-session` 的请求）。
      // ⚠️ 值先用**路由表里的原值**（ASCII）：`${session_id}` 占位符**要在 settings 里再开一个开关**才会展开
      //   （Qwen Code 提示原文："…true in settings.json to allow the value to be filled in per request"）；
      //   没开就原样发出去 ⇒ 网关当成"没有会话头" ⇒ 400。**开关名待查**，查到再换回占位符（更正确）。
      // ★★ b52：会话号交给**载体自己的会话号** —— Qwen Code 的 `${session_id}` 占位符（一跑一个号），
      //   并且**必须**在 settings 里开 `outboundCorrelation.allowDynamicHeaderValues`（见下面 cfg）才会展开；
      //   不展开就会把 `${session_id}` 这串字原样发出去（第一版踩过：网关当成"有号但没用"）。
      ...(w.headers ? { generationConfig: { customHeaders: Object.fromEntries(Object.entries(w.headers).map(([k, v]) => [k, /session/i.test(k) ? '${session_id}' : v])) } } : {})
    })
    added.push(w.canon + ':' + w.id)
  }
  const after = new Set(Object.entries(groups).filter(([k]) => managed.has(k)).flatMap(([k, arr]) => (arr ?? []).map((x) => k + ':' + x.id)))
  const removedFinal = [...before].filter((s) => !after.has(s))
  return {
    ok: true, file, added, removed: removedFinal, skipped, groups: [...managed],
    cfg: {
      ...cfg,
      modelProviders: groups,
      providerProtocol: { ...(cfg.providerProtocol ?? {}), ...Object.fromEntries([...managed].map((c) => [c, 'openai'])) },
      // ★ b52：**动态头的总开关**（从 Qwen Code 源码里挖到的字段名）——不开的话 `${session_id}` 不展开
      outboundCorrelation: { ...(cfg.outboundCorrelation ?? {}), allowDynamicHeaderValues: true },
      // （b47 在这里试过加 `model.generationConfig.customHeaders`：**不生效** —— Qwen 自己提示
      //   "is field to modelProviders.<家>[].generationConfig for that model if you want it to apply"）
    }
  }
}

/** 跑一次 Qwen Code 同步（只合并、不重建；有变化才写，写前备份）。 */
export function syncQwen ({ dry = false } = {}) {
  const plan = planQwen()
  const lines = ['载体 qwencode（' + plan.file + '）：'
    + (plan.added.length ? '加上 ' + plan.added.length + ' 条路由（' + plan.added.slice(0, 3).join('、') + (plan.added.length > 3 ? ' 等' : '') + '）' : '没有要加的路由')
    + (plan.removed.length ? '　·　清掉 ' + plan.removed.length + ' 条' : '')
    + (plan.skipped?.length ? '　·　⚠️ 跳过撞名的：' + plan.skipped.join('、') : '')]
  const before = readJson(plan.file, null)
  const same = before && JSON.stringify(before) === JSON.stringify(plan.cfg)
  if (dry || same) {
    lines.push(dry ? '（--dry：不写盘）' : '文件内容没变化 ⇒ 不重写')
    return { ok: true, lines, plan, wrote: false }
  }
  try {
    if (before) copyFileSync(plan.file, plan.file + '.bak-' + Date.now())
    writeJson(plan.file, plan.cfg)
    const prev = (readJson(QWEN_SIDECAR, { added: [] }).added ?? []).filter((x) => !plan.removed.includes(x))
    writeJson(QWEN_SIDECAR, { 说明: '哪些模型路由是「同步载体模型.mjs」写进 Qwen Code settings.json 的', at: new Date().toISOString(), added: [...new Set([...plan.added, ...prev])] })
    lines.push('✅ 已写入（凭据仍只从 envKey 读，**不落盘**）')
  } catch (e) {
    return { ok: false, lines: lines.concat('❌ 写不进去：' + String(e?.message ?? e)), plan, wrote: false }
  }
  return { ok: true, lines, plan, wrote: true }
}

/**
 * 载体自己配置里**已经有的**模型条目 —— 给 `_载体能力.mjs` 当"真相"用
 * （"下拉 = ② 已选"要成立，前提是**载体真认得**这些；漂了就如实反映）。
 */
export function ownEntries (carrier) {
  try {
    if (carrier === 'codebuddy') {
      const cfg = readJson(codebuddyFile(), null)
      return (cfg?.models ?? []).map((m) => ({ bare: String(m.id ?? '').replace(/^custom-local:/, ''), canon: m.vendor ?? null })).filter((x) => x.bare)
    }
    if (carrier === 'qwencode') {
      const cfg = readJson(QWEN_SETTINGS, null)
      // ★ b47（方法 A）：选择器用**全项目统一的 `家/模型`**（和 Pi/OpenCode 一样好懂）。
      //   派活时把它拆成"`--model` 传裸名 + `--openai-base-url` 传那家的地址"（Qwen Code 的运行时模型三件套）
      //   ⇒ **家由 base URL 表达** ⇒ 同名跨家**天然不冲突**（不再依赖"按 id 选"）。
      const out = []
      for (const [home, arr] of Object.entries(cfg?.modelProviders ?? {})) {
        for (const m of (arr ?? [])) {
          const bare = String(m?.id ?? '')
          if (!bare) continue
          out.push({ bare, canon: home, baseUrl: m.baseUrl ?? null, sel: home + '/' + bare })
        }
      }
      return out
    }
  } catch { /* 读不到就当没有 */ }
  return []
}

/**
 * ★ b43：**载体自己配置里那条模型路由"要哪个钥匙变量、走哪一家"**。
 *
 * 为什么要它：`prefixed` 模式的载体（CodeBuddy / Qwen Code）**靠自己的配置鉴权** ——
 *   Qwen Code 是从 `process.env[envKey]` 拿钥匙（settings 里 `modelProviders[].envKey`），
 *   CodeBuddy 是从 `apiKey` 的 `${VAR}` 拿钥匙。而派活时 `envFor` **只注入"钉死那一家"的钥匙**
 *   （实测：rescue 不管选谁，注入的都是 `OPENAI_API_KEY`）⇒ 别家的路由**根本没钥匙** ⇒ **401**。
 *   实测证据（2026-10-12）：四家的 `/models` 全 200（钥匙都是好的），
 *   但 rescue → `zai-org/GLM-5.3-Flash`(SiliconFlow) / `mimo-v2.6-flash`(xiaomi) 都 **401**。
 */
export function carrierModelBinding (carrier, modelId) {
  const id = String(modelId ?? '')
  if (!id) return null
  const norm = (u) => String(u ?? '').replace(/\/+$/, '').toLowerCase()
  const byUrl = new Map(selection().map((h) => [norm(h.baseUrl), h.canon]))
  try {
    if (carrier === 'codebuddy') {
      const e = (readJson(codebuddyFile(), {})?.models ?? []).find((m) => String(m.id ?? '').replace(/^custom-local:/, '') === id.replace(/^custom-local:/, ''))
      if (!e) return null
      const m = /\$\{([A-Z0-9_]+)\}/.exec(String(e.apiKey ?? ''))
      return { envKey: m ? m[1] : null, canon: e.vendor ?? byUrl.get(norm(String(e.url ?? '').replace(/\/chat\/completions$/, ''))) ?? null }
    }
    if (carrier === 'qwencode') {
      // ★ b46：模型值可能是**选择器** `<家>:<模型>`（Qwen Code 官方语法）⇒ 先按选择器定位，再回落按 id 找
      const cfg = readJson(QWEN_SETTINGS, {}) ?? {}
      const sel = /^([^:]+):(.+)$/.exec(id)
      if (sel) {
        const e = (cfg.modelProviders?.[sel[1]] ?? []).find((m) => String(m.id ?? '') === sel[2])
        if (e) return { envKey: e.envKey ?? null, canon: sel[1] }
      }
      for (const [home, arr] of Object.entries(cfg.modelProviders ?? {})) {
        const e = (arr ?? []).find((m) => String(m.id ?? '') === id)
        if (e) return { envKey: e.envKey ?? null, canon: home }
      }
      return null
    }
  } catch { /* 读不到就当没有（调用方回落老口径，不拦派活） */ }
  return null
}

// —— CLI ——
if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const carrier = opt('carrier', 'all')
  const wantPi = carrier === 'all' || carrier === 'pi'
  const wantOc = carrier === 'all' || carrier === 'opencode'
  const wantCb = carrier === 'all' || carrier === 'codebuddy'
  const wantQw = carrier === 'all' || carrier === 'qwencode'
  const rp = wantPi ? syncPi({ dry: DRY }) : { ok: true, lines: [], plan: { declared: [], skippedBuiltin: [], removed: [] }, wrote: false }
  const ro = wantOc ? syncOpenCode({ dry: DRY }) : { ok: true, lines: [], plan: { added: [], extended: [], removed: [] }, wrote: false }
  const rb = wantCb ? syncCodeBuddy({ dry: DRY }) : { ok: true, lines: [], plan: { added: [], removed: [] }, wrote: false }
  const rq = wantQw ? syncQwen({ dry: DRY }) : { ok: true, lines: [], plan: { added: [], removed: [], skipped: [] }, wrote: false }
  for (const l of [...rp.lines, ...ro.lines, ...rb.lines, ...rq.lines]) console.log(l)
  // ★ 2026-10-23：**能力未知**的模型要看得见（不是报错、但也不许静默 —— 施工文档 §8 兜底表）
  const unknownAll = [...(rp.plan.unknownCap ?? []), ...(ro.plan.unknownCap ?? []), ...(rb.plan.unknownCap ?? [])]
  if (unknownAll.length) {
    const flat = unknownAll.flatMap((u) => (u.models ?? []).map((m) => `${u.carrier}/${u.home}/${m}`))
    console.log(`⚠️ 能力未知 ${flat.length} 条（上下文/最大输出都没抓到，载体将用它自己的默认值 —— 跑 \`模型能力.mjs refresh\` 或手填）：${flat.slice(0, 6).join('、')}${flat.length > 6 ? ' 等' : ''}`)
  }
  // ★ 给**机器**看的那一行（结构化）：调用方（面板）只读它，**不许去解析上面那些人话**
  //   （起飞前检查的「禁散文自检」管的就是这个：机器要的状态走结构化产物）。
  console.log('<!--同步结果-->' + JSON.stringify({
    ok: rp.ok !== false && ro.ok !== false && rb.ok !== false && rq.ok !== false,
    pi: { wrote: !!rp.wrote, declared: (rp.plan.declared ?? []).map((d) => ({ name: d.name, models: d.models, capped: d.capped })), skippedBuiltin: rp.plan.skippedBuiltin ?? [], removed: rp.plan.removed ?? [], file: PI_MODELS },
    opencode: { wrote: !!ro.wrote, added: (ro.plan.added ?? []).map((d) => ({ name: d.name, models: d.models, capped: d.capped })), extended: ro.plan.extended ?? [], removed: ro.plan.removed ?? [], file: ro.plan.file ?? null },
    codebuddy: { wrote: !!rb.wrote, added: rb.plan.added ?? [], removed: rb.plan.removed ?? [], patched: rb.plan.patched ?? 0, file: rb.plan.file ?? null },
    qwencode: { wrote: !!rq.wrote, added: rq.plan.added ?? [], removed: rq.plan.removed ?? [], skipped: rq.plan.skipped ?? [], file: rq.plan.file ?? null },
    capacityUnknown: unknownAll.flatMap((u) => (u.models ?? []).map((m) => `${u.carrier}/${u.home}/${m}`))
  }))
  if (DRY && wantPi) console.log(JSON.stringify(rp.body, null, 2))
  process.exit(rp.ok !== false && ro.ok !== false && rb.ok !== false && rq.ok !== false ? 0 : 1)
}
