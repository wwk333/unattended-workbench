#!/usr/bin/env node
/**
 * 档位对账（硬闸）—— 「看板选了档位」与「这个档位真的生效」是两件事，这道闸就是那两件事的机器判据。
 *
 * ★ 2026-10-16 用户拍板："②为主 ＋ ①的校验"，并**明确要求把"档位不支持"变成起飞前检查的硬闸**。
 *
 * 判据（依据 KB `重构\任务分级-施工文档.md` §3.5）：
 *   对 `_crew\agents.json` 里**每个角色 × 每个已配的级**：
 *     - 那一级配了**抽象档**（省/中/狠）⇒ 该档的候选串里**必须至少有一个**是这个模型声明支持的；
 *       一个都不支持 ⇒ **红**（否则就是"看板选了、实际压根没发出去"的那种静默）；
 *     - 那一级写的是**具体值**（老写法 `effort: "max"`）⇒ 该值必须在这个模型的白名单里，否则**红**；
 *     - 某一级**没配档位** ⇒ ⚪ 不参与判定（这不是错：载体不认档位时本来就该留空）；
 *     - **档案里查不到这个模型** ⇒ ⚠️ 黄（未核实，**不拦起飞** —— 我们不拿"自己读不到"当人家的错）。
 *
 * 退出码：0 = 全过（可能有黄）· 1 = 有红（拦起飞）· 2 = 配置/档案读不到（也算红：闸自己瞎了不能放行）
 *
 * 用法：
 *   node _档位对账.mjs                # 人话报告
 *   node _档位对账.mjs --json         # 只出机器可读（起飞前检查用这个）
 *   node _档位对账.mjs --project X    # 换成另一个工作台根（默认＝本文件上一级）
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { declaredEfforts, resolveEffort, effortsOfModel, EFFORT_TIERS, DEFAULT_EFFORT_TIERS } from './_档位.mjs'
// ⚠️ 载体的家名写法与档案里不一定一样（`xiaomi-token-plan-cn` vs `xiaomi`）——
//   不归一就会把**认识的模型**误报成"档案里查不到"（实测：第一版三条全报"未核实"）。
import { canonOfCarrierName } from './_家名.mjs'
import { discoverProviders } from './额度钥匙.mjs'

const providers = (() => { try { return discoverProviders() } catch { return {} } })()
const homeOf = (model) => {
  const raw = String(model).split(/[\/:]/)[0]
  try { return canonOfCarrierName(raw, null, { routing: providers }) ?? raw } catch { return raw }
}

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? d) : d }
const JSON_OUT = has('json')
const WS = resolve(opt('project', resolve(HERE, '..')))

const CFG = process.env.DSH_AGENTS_CONFIG ?? join(WS, '_crew', 'agents.json')
if (!existsSync(CFG)) {
  const out = { ok: false, red: 1, yellow: 0, why: `读不到 agents.json：${CFG}` }
  if (JSON_OUT) console.log(JSON.stringify(out))
  else { console.error(`❌ ${out.why}`) }
  process.exit(2)
}
let cfg
try { cfg = JSON.parse(readFileSync(CFG, 'utf8').replace(/^\uFEFF/, '')) } catch (e) {
  const out = { ok: false, red: 1, yellow: 0, why: `agents.json 解析失败：${String(e?.message ?? e)}` }
  if (JSON_OUT) console.log(JSON.stringify(out)); else console.error(`❌ ${out.why}`)
  process.exit(2)
}

const decl = declaredEfforts()
const tiers = cfg?.levels?.effortTiers ?? DEFAULT_EFFORT_TIERS
const rows = []
const red = []
const yellow = []

for (const [role, r] of Object.entries(cfg.roles ?? {})) {
  const lv = r?.levels
  if (!lv || typeof lv !== 'object') continue
  for (const L of ['L1', 'L2', 'L3', 'L4']) {
    const e = lv[L]
    if (!e) continue                                   // 这一级没启用 ⇒ 不参与（不是错）
    const model = String(e.model ?? '').trim()
    if (!model) { red.push({ role, level: L, kind: 'no-model', why: `${L} 声明了级却没给 model ⇒ 派这一级会当场报错` }); continue }
    // ★ 2026-10-16：**按这个角色走哪条路**取来源（messenger 读路由表；其余读 DSH 档案）——
    //   两处都查不到时 `supportedEffortsVia` 会按默认口径放行并标 assumed（不判"不支持"）。
    const via = (r?.agent === 'messenger') ? 'messenger' : 'carrier'
    const home = homeOf(model)
    const tier = String(e.effortTier ?? '').trim()
    const concrete = String(e.effort ?? '').trim()
    if (!tier && !concrete) { rows.push({ role, level: L, model, tier: null, status: 'none', why: '没配档位（载体不认档位时本来就该留空）' }); continue }

    if (tier) {
      if (!EFFORT_TIERS.includes(tier)) { red.push({ role, level: L, kind: 'bad-tier', why: `effortTier="${tier}" 不是 ${EFFORT_TIERS.join(' / ')} 之一` }); continue }
      const res = resolveEffort(home, model, tier, tiers, { via })
      if (res.assumed) {
        // ★ 2026-10-16：**未核实（按默认五档放行）** → 只记黄，不拦。
        //   这是"看板上新加的 API 还没声明精确档位"的正常状态；要精确就写 `_crew\档位声明.json`。
        yellow.push({ role, level: L, model, tier, why: `未核实：${res.why ?? '按默认五档'}（要精确就在 _crew\\档位声明.json 里写这一家的档位）` })
      }
      if (res.status === 'ok' || res.status === 'degraded') {
        rows.push({ role, level: L, model, tier, resolved: res.resolved, status: res.status, why: res.why })
      } else if (res.status === 'unsupported') {
        // ⚠️ 这里要分两种，别一刀切（第一版全判红，结果把一个**正常状态**判成了错）：
        //   · 这个模型**一个档位都没声明**（例 xiaomi）⇒ 载体压根不认档位 ⇒ 派活会**不传档位**，
        //     这是**如实、安全**的结果（且发车前会明确告诉你是"未发"）⇒ 只记**黄**（不拦起飞）；
        //   · 它**声明了档位**、但我们这档的候选一个都不在它白名单里 ⇒ 这才是**红** ——
        //     典型的"看板选了狠，实际发的是 low" 或 "压根发不出去"，必须逼人改模型或改档。
        const declaredAny = (res.values?.length ?? 0) > 0
        if (declaredAny) {
          red.push({ role, level: L, kind: 'tier-unsupported', model, tier, why: `「${tier}」一个候选都不被它支持 —— ${res.why}` })
        } else {
          yellow.push({ role, level: L, model, tier, why: `这个模型**不认任何档位** ⇒ 派活时**不传档位**（载体按自己默认跑）。这不是错，但你要知道"这一级选的档位不会被发出去"` })
          rows.push({ role, level: L, model, tier, status: 'no-effort-support', why: '载体不认档位 ⇒ 不传（如实）' })
        }
      } else {
        yellow.push({ role, level: L, model, tier, why: `未核实：${res.why}` })
        rows.push({ role, level: L, model, tier, status: 'unknown', why: res.why })
      }
    } else {
      // 老写法：具体值 —— 必须真的在白名单里
      const ef = { known: true, values: resolveEffort(home, model, concrete, { [concrete]: [concrete] }, { via }).supported ?? [] }
      if (!ef.known) { yellow.push({ role, level: L, model, effort: concrete, why: `未核实：${ef.why}` }); rows.push({ role, level: L, model, effort: concrete, status: 'unknown', why: ef.why }); continue }
      if (!ef.values.length) {
        red.push({ role, level: L, kind: 'effort-unsupported', model, effort: concrete, why: `这一级写死了档位 "${concrete}"，但这个模型**一个档位都不认**（它认：无）` })
      } else if (!ef.values.includes(concrete)) {
        red.push({ role, level: L, kind: 'effort-unsupported', model, effort: concrete, why: `这一级写死了档位 "${concrete}"，但该模型只认 ${ef.values.join(' / ')}` })
      } else {
        rows.push({ role, level: L, model, effort: concrete, status: 'ok', why: null })
      }
    }
  }
}

const out = {
  ok: red.length === 0,
  red: red.length,
  yellow: yellow.length,
  checked: rows.length + red.length,
  // 只出**结论 + 该改哪几处**，不把整张表白名单塞进 stdout（起飞前检查会读它）
  redList: red.map(x => `${x.role}/${x.level}：${x.why}`),
  yellowList: yellow.map(x => `${x.role}/${x.level}：${x.why}`),
  // 逐级真实落点（人话报告用）
  landed: rows.map(x => ({ role: x.role, level: x.level, status: x.status, resolved: x.resolved ?? x.effort ?? null }))
}

if (JSON_OUT) { console.log(JSON.stringify(out)); process.exit(out.ok ? 0 : 1) }

console.log('档位对账（三档抽象 ＋ 按模型校验）')
console.log(`配置：${CFG}`)
console.log(`档案：${decl.file ?? '（找不到）'}${decl.why ? ' —— ' + decl.why : ''}`)
console.log('')
for (const x of rows) {
  const mark = x.status === 'ok' ? '✅' : (x.status === 'degraded' ? '⚠️' : (x.status === 'unknown' ? '❔' : '⚪'))
  console.log(`  ${mark} ${x.role}/${x.level}  ${String(x.model).padEnd(38)} ${x.tier ? '档=' + x.tier : ''}${x.resolved ? ' → ' + x.resolved : ''}${x.why ? '　（' + x.why + '）' : ''}`)
}
for (const x of red) console.log(`  ❌ ${x.role}/${x.level}　${x.why}`)
for (const x of yellow) console.log(`  ❔ ${x.role}/${x.level}　${x.why}`)
console.log('')
console.log(red.length
  ? `❌ ${red.length} 处**档位会静默失效**（模型声明了档位、但这一级的候选一个都不在它白名单里）—— 必须修：改模型，或把该级档位改成这个模型真认的。`
  : (yellow.length ? `✅ 没有"档位静默失效"的硬错；⚠️ ${yellow.length} 处**不拦起飞但要你知道**：这个模型不认档位 / 档案里查不到它 ⇒ 派活时**不传档位**（见上面每行的原因）` : '✅ 全部档位都能真落地'))
process.exit(out.ok ? 0 : 1)
