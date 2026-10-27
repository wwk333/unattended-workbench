#!/usr/bin/env node
/**
 * 额度切换 —— 角色级「切换链」引擎（**按协议**，见 KB `08-额度兜底与切换协议.md`）
 *
 * 协议要点：
 *   P1 供应商名字**以载体路由表 `_coder路由表.json` 为准**（`额度钥匙.mjs` 的 `discoverProviders`）；
 *   P4 **只在 `quota / invalid-key / rate-limited` 上切**；`timeout / capability / input-error` **绝不切**；
 *   P3 **没探测到 ≠ 不可用** —— 没数据时不跳过（不编数）；
 *   ★ **没配切换链也能用**：自动从路由表推导"**同一款模型的其它供应商**"作为后备（只同款模型，不乱换）。
 *
 * 用法：
 *   node 额度切换.mjs plan                    # 每个角色：链条 + 各家状态 + 当前会选谁
 *   node 额度切换.mjs pick <角色> [--json]     # 输出选中的 { provider, model, effort, idx }（给编排用）
 *   node 额度切换.mjs advance <角色> --reason quota   # 把"当前这家"标记不可用 → 顺延下一家（写状态）
 *   node 额度切换.mjs reset [<角色>]           # 复位（补了钥匙后重来）
 *   node 额度切换.mjs status [--json]          # 汇总（看板读）
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { WORKSPACE, discoverProviders, loadSecrets, loadStruct, resolveKey } from './额度钥匙.mjs'
// ★ 2026-10-07：哪些载体不参与"换 API"那条轴（自有订阅）—— 见 `_载体属性.mjs`（零依赖，避免循环 import）
import { usesProviderAxis } from './_载体属性.mjs'

const STATE_FILE = join(WORKSPACE, '_crew', '额度状态.json')
const AGENTS_FILE = join(WORKSPACE, '_crew', 'agents.json')

const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const AS_JSON = has('json')

/** 协议 P4：只认这三种才切。 */
export const SWITCH_ON = ['quota', 'invalid-key', 'rate-limited']
export const NEVER_ON = ['timeout', 'capability', 'input-error', 'no-product']

export function readState () {
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return { version: 1, providers: {}, summary: {} } }
}
export function writeState (s) { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf8') }

function readAgents () { try { return JSON.parse(readFileSync(AGENTS_FILE, 'utf8')) } catch { return { roles: {} } } }

/** 拆 `"供应商/模型"` 或 `"供应商:模型"` 或裸 `"模型"`（后者用角色的 `route` 补供应商）。 */
export function splitModel (spec, fallbackRoute = null) {
  const s = String(spec ?? '').trim()
  for (const sep of ['/', ':']) {
    const i = s.indexOf(sep)
    if (i > 0) return { provider: s.slice(0, i), model: s.slice(i + 1) }
  }
  return { provider: fallbackRoute, model: s }
}

/** 档案里的名字 → **路由表的权威名字**（`qwen-token-plan-cn` → `aliyun`；靠 `alias` 配对）。 */
export function canonName (p, routing) {
  if (!p) return null
  if (routing[p]) return p
  const hit = Object.entries(routing).find(([, v]) => (v.alias ?? []).includes(p))
  return hit ? hit[0] : p
}

/**
 * 角色链条（顺序 = 先试谁）—— ★ 2026-10-07 **按用户口径重写**：
 *   「失败（**全因**）→ 先**切模型**；切模型还不行 → **切 API**（按看板的"先试顺序"）；
 *     切过去后**优先主模型**，失败再**备选模型**。」
 *   ⇒ 链条 = **家 × 模型 的交叉积**（provider-major）：
 *      [当前那家: 主 → 备] → [下一个家: 主 → 备] → …（某家不提供某模型就跳过那格）
 *   · 载体**自有订阅**（Qoder / CodeBuddy / Codex，见 `_载体属性.mjs`）**不参与换家** ⇒ 只有模型轴：主 → 备。
 *   · 显式链（`_crew\额度兜底.json` 的 `roles.<角色>.chain`）仍然**最高优先**，原样返回。
 */
export function chainFor (role, struct = loadStruct(), routing = discoverProviders(), agents = readAgents()) {
  const cfg = struct.roles?.[role]
  if (Array.isArray(cfg) && cfg.length) return cfg
  const r = agents.roles?.[role]
  if (!r) return []
  const specs = []
  const addSpec = (spec, effort) => {
    const s = splitModel(spec, r.route ?? null)
    if (!s.model || specs.some(x => x.model === s.model)) return
    specs.push({ model: s.model, effort: effort ?? r.prefer?.effort ?? 'high', declared: s.provider })
  }
  if (r.prefer?.model) addSpec(r.prefer.model, r.prefer.effort)
  for (const f of (r.fallback ?? [])) addSpec(f.model, f.effort)
  if (!specs.length) return []
  // ① 自有订阅的载体：只有模型轴（主 → 备选）
  if (!usesProviderAxis(String(r.agent ?? ''))) return specs.map(x => ({ provider: null, model: x.model, effort: x.effort, own: true }))
  // ② 家名单：**当前那家排第一**（角色首选是刻意安排的异构），其余按看板的 `providerOrder`
  // ★ 2026-10-07（用户："先修换 api 的问题"）：**同一逻辑模型在不同家的 id 常常不同**
  //   （例：火山 `deepseek-v4.1-flash` vs SiliconFlow `deepseek-ai/DeepSeek-V4-Flash`）。
  //   原链条按 **id 全等** 匹配家 ⇒ 实测"两家以上都能跑的模型 = 0 款" ⇒ **换 API 永远不可能发生**。
  //   现在读 `_crew\模型等价表.json` 的 `equiv`：**只有人工确认过的等价关系才生效**
  //   （**没证据不许填** —— 用户口径；空表 = 行为与从前完全一致，零风险）。
  let EQUIV = {}
  try {
    const ej = JSON.parse(readFileSync(join(WORKSPACE, '_crew', '模型等价表.json'), 'utf8').replace(/^\uFEFF/, ''))
    EQUIV = ej.equiv ?? {}
  } catch { /* 没有这张表 / 读坏了 ⇒ 等价于空表，不报错 */ }
  const sameId = (a, b) => String(a).toLowerCase() === String(b).toLowerCase()
  const eqIds = (m) => {                                   // 这个逻辑模型的全部等价 id（含它自己）
    for (const k of Object.keys(EQUIV)) {
      const list = Array.isArray(EQUIV[k]) ? EQUIV[k] : []
      if (sameId(k, m) || list.some(x => sameId(x, m))) return [k, ...list]
    }
    return [m]
  }
  const idFor = (p, m) => {                                // 这家**用它自己的那个 id** 跑这个逻辑模型
    const ms = routing[p]?.models ?? []
    return ms.find(x => sameId(x, m)) ?? ms.find(x => eqIds(m).some(y => sameId(x, y))) ?? null
  }
  const decl = (p, m) => idFor(p, m) !== null
  const homes = Object.keys(routing).filter(p => specs.some(x => decl(p, x.model)))
  const order = Array.isArray(struct.providerOrder) ? struct.providerOrder : []
  const rank = (p) => { const i = order.indexOf(p); return i === -1 ? 999 : i }
  const cur = canonName(specs[0].declared, routing) ?? homes[0] ?? null
  homes.sort((a, b) => (a === cur ? -1 : b === cur ? 1 : rank(a) - rank(b)))
  const out = []
  // ⚠️ 跳板里的 `model` 必须写**这家自己认的 id**（等价表换家时尤其重要）；`logical` 记原逻辑名，便于显示
  for (const p of homes) for (const x of specs) { const id = idFor(p, x.model); if (id) out.push({ provider: p, model: id, effort: x.effort, logical: x.model !== id ? x.model : undefined }) }
  // ③ 一个家都不声明（例：手填的名字）⇒ 留 `provider:null` 的跳板，`pick` 会明确报"找不到供应商"，不崩
  if (!out.length) for (const x of specs) out.push({ provider: null, model: x.model, effort: x.effort })
  return out
}

/** 这家"现在能不能用"：按探测结果判；**没数据 = 未知（不跳过）**。 */
function providerUsable (provider, state, struct, secrets, routing) {
  // ★W12（2026-10-27）：**探测结果有保质期** —— 实测踩到：4 天前的 `ark: ok` 被当今天的结论，
  //   而 ark 早已额度耗尽 ⇒ 兜底把 coder-a 送到一个死掉的家，报"额度用完"，
  //   看起来像"配置写 ocgo、实际却打 ark"。超过 TTL 的记录一律当**没数据**（未知 ≠ 不可用）。
  const TTL_MS = 6 * 60 * 60 * 1000
  const fresh = (r) => {
    const t = Date.parse(String(r?.at ?? ''))
    return Number.isFinite(t) ? (Date.now() - t) <= TTL_MS : false   // 没时间戳 = 无法证明新鲜 ⇒ 不算数
  }
  const rows = (state.providers?.[provider] ?? []).filter(fresh)
  if (!rows.length) return { usable: true, why: '未探测（未知 ≠ 不可用）' }
  // ★ 2026-10-07：**真调用判据优先** —— `/models` 判 ok 但真调用红（real 字段）也按不可用算（口径见 额度检测.mjs）。
  const good = rows.filter(r => (r.verdict === 'ok' || r.verdict === 'no-probe' || r.verdict === 'network' || r.verdict === 'missing') && !(r.real && r.real !== 'ok' && r.real !== 'network'))
  const bad = rows.filter(r => SWITCH_ON.includes(r.verdict) || (r.real && r.real !== 'ok' && r.real !== 'network'))
  if (!bad.length) return { usable: true, why: rows.map(r => r.verdict).join('/') }
  if (good.length) return { usable: true, why: `有 ${good.length} 把还行（${bad.length} 把不可用）` }
  return { usable: false, why: `全部不可用：${[...new Set(bad.map(r => r.verdict))].join('/')}` }
}

/** 选出这一轮该用谁。返回 `{ ok, provider, model, effort, idx, why }` 或 `{ ok:false, reason, tried }`。 */
export function pick (role, { struct = loadStruct(), routing = discoverProviders(), state = readState(), secrets = loadSecrets() } = {}) {
  const chainAll = chainFor(role, struct, routing)
  if (!chainAll.length) return { ok: false, reason: `角色 ${role} 没有可用链条（agents.json 里没有 route/prefer，也没配 roles.${role}.chain）`, tried: [] }
  // ★ 2026-10-05（**用户口径，硬规则**）：**额度兜底"只换 API、不换模型"** ——
  //   只在"**同一款模型**"的跳板之间顺延（例：pi 选定 `deepseek-v4.1-flash` → 阿里没额度了就换火山跑**同一个模型**）。
  //   `agents.json` 里 `fallback[]` 那些**换了模型**的条目（例 `glm-5.3`）**不由额度兜底触发**：
  //   **换模型是判断性动作**（能力/价格都变了），得由人/大脑决定，不该被"额度用完"顺手做掉。
  //   若同一款模型只有一家提供 → 链条就一条，"没得换"**如实报**（不偷偷换模型顶上）。
  // ★ 2026-10-07（用户口径）：链条本身已经是"家 × 模型（主→备）"的顺序了（见 `chainFor`）
  //   ⇒ 这里**不再过滤成"同一款模型"**（那条老硬规则"只换 API、不换模型"已被用户的新口径取代：
  //   现在是"**先切模型，再切 API**"）。`pick` 只负责按 idx 往下走、跳过不可用的家。
  const chain = chainAll
  let start = Math.max(0, Math.min(Number(state.failover?.roles?.[role]?.idx ?? 0) || 0, chain.length - 1))
  // ★W12：**首选能用就必须回到 0** —— 否则"上次切过一次"会变成永久改道：
  //   实测 coder-a 的 idx 卡在 1（ark），而首选 ocgo 明明健康，于是每次都从 ark 起跑、每次都死。
  //   口径：兜底是"本轮换个家顶上"，不是"以后都用那家"。
  if (start > 0) {
    const first = chain[0]
    const u0 = first?.own ? { usable: true } : providerUsable(first?.provider, state, struct, secrets, routing)
    if (u0?.usable) start = 0
  }
  const tried = []
  for (let i = start; i < chain.length; i++) {
    const hop = chain[i]
    // ★ 2026-10-07：**自有订阅的载体**（Qoder / CodeBuddy / Codex）的跳板 `provider:null`
    //   —— 它们不花我们的钥匙（用自家登录态/被钉死的端点）⇒ **不需要钥匙、也不算"定位不到"**。
    if (!hop.provider && hop.own) {
      tried.push({ i, provider: null, usable: true, why: '载体自有订阅（不用我们的钥匙）' })
      return { ok: true, provider: null, model: hop.model, effort: hop.effort, idx: i, why: '载体自有订阅（不用我们的钥匙）', keySource: null, keyLabel: null, chainLen: chain.length }
    }
    const u = providerUsable(hop.provider, state, struct, secrets, routing)
    tried.push({ i, provider: hop.provider, usable: u.usable, why: u.why })
    if (!u.usable) continue
    // ⚠️ **"解析不到钥匙"不算不可用**（踩过）：本地供应商（如 `custom-local`）本来就不需要钥匙，
    //   拿"没钥匙"当不可用会把它跳过 → **干净状态下也乱改行为**。只有探测判定的
    //   `quota / invalid-key / rate-limited` 才算不可用（见 `providerUsable`）。
    const k = resolveKey(hop.provider, 0, struct, secrets, routing)
    return { ok: true, provider: hop.provider, model: hop.model, effort: hop.effort, idx: i, why: u.why, keySource: k?.source ?? null, keyLabel: k?.label ?? null, chainLen: chain.length }
  }
  return { ok: false, reason: `角色 ${role} 的切换链走完了，全线无可用（${chain.map(h => h.provider).join(' → ')}）`, tried }
}

/**
 * 推进链条。
 * ★ 2026-10-07 **按用户口径改成"全因"**：用户原话 ——「当 API 没有额度，或者调用失败（**全因**）自动切模型，
 *   如果切模型还不行，直接切 api（按照看板设置的优先顺序去切）；切过去后，优先调用主模型，失败就调用备选模型」。
 *   所以原来协议 P4 的两道闸（只有 `quota`/`invalid-key`/`rate-limited` 才推；`timeout`/`capability`/`input-error`
 *   **一律拒绝**）**不再拦**：原因照记（`history[]`），但**照切**。
 * ⚠️ 代价（要知情）：**任务层失败**（它跑完了、活没干对 / 门禁红）也会被当成"这次调用不成"而往下换 ——
 *   换家/换模型**解决不了**这类问题，只会多花时间与额度，还可能把真错误盖住 ⇒ 事后请按 `history[].reason` 看。
 */
export function advance (role, reason, opts = {}) {
  const typeNote = NEVER_ON.includes(reason) ? `（★"全因切换"口径：${reason} 也照切；换家/换模型解决不了它）` : ''
  const struct = opts.struct ?? loadStruct()
  const state = readState()
  state.failover = state.failover ?? { at: null, roles: {} }
  // ★ 2026-10-07（用户口径）：**"没额度"一次就换；其他原因（全因去掉没额度）同一格先试 2 次才换。**
  //   额度是硬伤（再试也没用）⇒ 立刻走；超时/网络/被拒/任务没干对这类**可能只是抖一下**
  //   ⇒ 给同一格第二次机会，免得"偶发一次就把好好的模型/家换掉"（换了反而更差）。
  var QUOTA_LIKE = ['quota', 'invalid-key', 'rate-limited', 'account', 'exceeded']
  var _st = state.failover.roles[role] ?? { idx: 0, history: [] }
  var _at = Math.max(0, Number(_st.idx ?? 0) || 0)
  if (QUOTA_LIKE.indexOf(String(reason)) === -1) {
    var _n = (_st.history ?? []).filter(function (x) { return x.idx === _at && x.reason === reason }).length + 1
    if (_n < 2) {
      _st.history = [...(_st.history ?? []), { at: new Date().toISOString(), idx: _at, reason: reason, soft: true }].slice(-20)
      state.failover.roles[role] = _st
      writeState(state)
      return { ok: false, soft: true, retrySame: true, role: role, reason: reason, why: '「' + reason + '」不是额度类 ⇒ 按口径**同一格先试 2 次**（这是第 ' + _n + ' 次，**先不换**）' }
    }
  }
  const chain = chainFor(role, struct, opts.routing ?? discoverProviders(), readAgents())
  const cur = state.failover.roles[role] ?? { idx: 0, history: [] }
  const from = chain[cur.idx]?.provider ?? '?'
  const fromModel = chain[cur.idx]?.model ?? '?'
  if (cur.idx >= chain.length - 1) {
    // ★ 已在链条末尾：**不许谎报"已切换"** —— 明确告诉调用方"没有下一家了"
    return { ok: false, atEnd: true, role, from, why: `已在链条末尾（${chain.map(h => (h.provider ? h.provider + '/' : '') + h.model).join(' → ')}）—— 没有下一格可切；请补钥匙/加备选模型，然后 reset` }
  }
  const next = cur.idx + 1
  const to = chain[next]?.provider ?? null
  cur.idx = next
  cur.reason = reason
  cur.from = from
  cur.to = to
  cur.at = new Date().toISOString()
  cur.history = [...(cur.history ?? []), { at: cur.at, from, to, reason }].slice(-20)
  state.failover.roles[role] = cur
  state.failover.at = cur.at
  writeState(state)
  return { ok: true, role, from, to, idx: next, reason, fromModel, toModel: chain[next]?.model ?? null, note: typeNote }
}

// ---------------------------------------------------------------- CLI
const cmd = argv[0]
const isMain = (() => { const e = process.argv[1]; if (!e) return false; try { return e.replace(/\\/g, '/').toLowerCase().endsWith('/额度切换.mjs') } catch { return false } })()

if (isMain) {
  const struct = loadStruct(); const routing = discoverProviders(); const state = readState(); const secrets = loadSecrets()
  const roles = [...new Set([...Object.keys(struct.roles ?? {}), ...Object.keys(readAgents().roles ?? {})])]
  if (cmd === 'plan') {
    console.log('🔀 切换链（★2026-10-07 用户口径：**失败（全因）→ 先换模型 → 再按看板"先试顺序"换家**；往下依次试）：')
    for (const role of roles) {
      const chain = chainFor(role, struct, routing)
      const p = pick(role, { struct, routing, state, secrets })
      console.log('  ── ' + role + '　' + (struct.roles?.[role]?.length ? '（已配置链）' : '（自动推导：家 × 模型）'))
      const firstModel = chain[0]?.model ?? null
      chain.forEach((h, i) => {
        const u = h.own ? { usable: true, why: '载体自有订阅（不用我们的钥匙）' }
          : (h.provider ? providerUsable(h.provider, state, struct, secrets, routing) : { usable: false, why: '模型没写供应商，且路由表里也没人提供它 → 无法定位' })
        // ★ 2026-10-07（用户口径）：链条是"家 × 模型（主→备）"⇒ 标出**哪一格是主、哪一格是备选**
        const isMain = h.model === firstModel
        console.log('       ' + i + '. ' + String(h.provider ?? (h.own ? '（自有订阅）' : '—（找不到供应商）')).padEnd(30) + String(h.model).padEnd(24) + (u.usable ? '✅ ' : '❌ ') + u.why + (isMain ? '　（主模型）' : '　⬅ **备选模型**（主模型失败后换它）'))
      })
      console.log('       → 这一轮会走：' + (p.ok ? (p.provider || '（自有订阅）') + ' / ' + p.model + '（钥匙来源 ' + (p.keySource ?? '自有订阅，不用钥匙') + '）' : '❌ ' + p.reason))
    }
    process.exit(0)
  }
  if (cmd === 'pick') {
    const role = argv[1]
    if (!role) { console.error('用法：额度切换.mjs pick <角色> [--json]'); process.exit(2) }
    const p = pick(role, { struct, routing, state, secrets })
    if (AS_JSON) { console.log(JSON.stringify(p, null, 2)); process.exit(p.ok ? 0 : 3) }
    console.log(p.ok ? `${p.provider} ${p.model} ${p.effort}` : `# 无可用：${p.reason}`)
    process.exit(p.ok ? 0 : 3)
  }
  if (cmd === 'advance') {
    const role = argv[1]; const reason = opt('reason', 'quota')
    if (!role) { console.error('用法：额度切换.mjs advance <角色> --reason quota|invalid-key|rate-limited'); process.exit(2) }
    const r = advance(role, reason, { struct, routing })
    console.log(r.ok ? `🔀 已切换：${r.role}　${r.from}/${r.fromModel} → ${r.to}/${r.toModel}（原因 ${r.reason}）` : `⛔ ${r.atEnd ? '没有下一家' : '拒绝切换'}：${r.why}`)
    process.exit(r.ok ? 0 : 4)
  }
  if (cmd === 'reset') {
    const role = argv[1]
    if (role) { if (state.failover?.roles) delete state.failover.roles[role] } else { state.failover = { at: null, roles: {} } }
    writeState(state)
    console.log('✅ 已复位' + (role ? '：' + role : '（全部角色）'))
    process.exit(0)
  }
  if (cmd === 'status' || !cmd) {
    const out = { at: new Date().toISOString(), roles: roles.map(r => { const p = pick(r, { struct, routing, state, secrets }); return { role: r, ok: p.ok, provider: p.provider ?? null, model: p.model ?? null, why: p.ok ? p.why : p.reason, switchedFrom: state.failover?.roles?.[r]?.from ?? null, at: state.failover?.roles?.[r]?.at ?? null } }) }
    if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); process.exit(0) }
    console.log('📊 额度切换状态（' + out.roles.length + ' 个角色）')
    for (const r of out.roles) console.log('  ' + r.role.padEnd(12) + (r.ok ? '✅ ' + r.provider + ' / ' + r.model + '　(' + r.why + ')' : '❌ ' + r.why) + (r.switchedFrom ? '　← 已从 ' + r.switchedFrom + ' 切走（' + r.at + '）' : ''))
    process.exit(0)
  }
  console.error('未知命令：' + cmd + '（可用：plan | pick | advance | reset | status）')
  process.exit(2)
}