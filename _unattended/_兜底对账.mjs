/**
 * 兜底对账（①b）· 2026-10-10 · 零 token、不联网、不 spawn 载体
 *
 * **为什么有这道闸**：修一个存量 gap 时实测出来的真缺陷 ——
 *   `_agents-config.mjs` 的 `resolveRole()` 原来是
 *       `const agent = cfg.agents[agentName] ?? cfg.agents[cfg.defaultAgent] ?? {}`
 *   ⇒ 当"角色指定的载体没声明"时**静默冒用 defaultAgent 的载体**，而且 `agentName` 字段照旧返回原名字：
 *   **名字报 codebuddy、命令其实是 Pi 的 cli.js**（比"换成 messenger"更难查）。
 *   同时 `FALLBACK.agents`（兜底）里**没有 codebuddy** —— 两个源结构不对等，正是上面那条路的燃料。
 *
 * 这道闸管四件事（都是结构性事实，不读散文）：
 *   ① **配置自洽**：`_crew\agents.json` 里每个 `roles.*.agent` 与 `defaultAgent` 都必须在 `agents` 段里声明；
 *   ② **兜底覆盖**：`FALLBACK.agents` 的键必须**盖住**在编角色用到的全部载体（本次 gap 就是这条）；
 *   ③ **兜底可用**：兜底里每个载体都得有入口 ＋ `printArgs` 是数组（否则"兜底"等于没有）；
 *   ④ **根因自证**：给一个"角色指向不存在载体"的配置，`resolveRole()` 必须**抛错**，
 *      而且**不许**悄悄返回 defaultAgent 的载体（这一条是反向验收，直接盯住修完的那个洞）。
 *
 * 用法：node _unattended\_兜底对账.mjs          正常检查（有问题 exit 1）
 *       node _unattended\_兜底对账.mjs --selftest 闸自检（故意造三种坏情形，必须都报红）
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FALLBACK, resolveRole } from './_agents-config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CFG = process.env.DSH_AGENTS_CONFIG ?? join(resolve(HERE, '..'), '_crew', 'agents.json')

const rows = []
const add = (name, ok, detail) => rows.push({ name, ok, detail })

const readJson = (p) => {
  const buf = readFileSync(p)
  let text = buf.toString('utf8')
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
  return JSON.parse(text)
}

/** ① 配置自洽：角色/默认角色指向的载体必须真的声明了 */
function checkConfigSelfConsistent (raw) {
  const agents = raw?.agents ?? {}
  const bad = []
  if (!agents[raw?.defaultAgent]) bad.push(`defaultAgent "${raw?.defaultAgent}" 不在 agents 段里`)
  for (const [role, r] of Object.entries(raw?.roles ?? {})) {
    if (r?.agent && !agents[r.agent]) bad.push(`角色 ${role} 指定的载体 "${r.agent}" 没在 agents 段里声明`)
  }
  return bad
}

/** ② 兜底覆盖：兜底必须盖住"在编角色真正用到的载体" */
function checkFallbackCovers (raw, fallback = FALLBACK) {
  const used = new Set(Object.values(raw?.roles ?? {}).map(r => r?.agent).filter(Boolean))
  if (raw?.defaultAgent) used.add(raw.defaultAgent)
  const missing = [...used].filter(a => !fallback?.agents?.[a])
  return missing
}

/** ③ 兜底可用：入口 ＋ printArgs */
function checkFallbackUsable (fallback = FALLBACK) {
  const bad = []
  for (const [name, a] of Object.entries(fallback?.agents ?? {})) {
    if (!a?.entry) bad.push(`兜底载体 ${name} 没有 entry`)
    if (!Array.isArray(a?.printArgs)) bad.push(`兜底载体 ${name} 的 printArgs 不是数组`)
  }
  return bad
}

/** ④ 根因自证：角色指向不存在的载体 ⇒ 必须抛错，且不许冒用 defaultAgent */
function checkNoSilentCarrierSwap () {
  const broken = {
    defaultAgent: 'pi',
    agents: { pi: { kind: 'generic', entry: '${AGENTS}\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js', printArgs: ['-p', '--mode', 'json'] } },
    roles: { reviewer: { agent: 'codebuddy', prefer: { model: 'custom-local:kimi-k3', effort: 'max' } } }   // 允许模型名：这是"角色指向不存在的载体"的**夹具**（不是派活配置）
  }
  try {
    const rr = resolveRole('reviewer', broken, { quotaFailover: false })
    return { ok: false, why: `**没抛错**：返回了载体 "${rr.agentName}"，入口却是 ${String(rr.agent?.entry ?? '').slice(-40)} —— 这正是"名字对、命令错"` }
  } catch (e) {
    const msg = String((e && e.message) || e)
    if (!msg.includes('在 agents 里**不存在**')) return { ok: false, why: '抛错了，但不是"载体不存在"那条（文案变了？）：' + msg.slice(0, 120) }
    return { ok: true, why: msg.slice(0, 90) + '…' }
  }
}

const selftest = process.argv.includes('--selftest')

if (selftest) {
  // 闸自检：三种坏情形必须都能被抓到（闸有牙才算装上了）
  let bad = 0
  const expect = (label, cond) => { console.log((cond ? '✅ ' : '❌ ') + label); if (!cond) bad++ }
  const raw = (() => { try { return existsSync(CFG) ? readJson(CFG) : { agents: {}, roles: {} } } catch { return { agents: {}, roles: {} } } })()

  const missing = checkFallbackCovers(raw, { agents: { ...FALLBACK.agents } })
  expect('正向：当前配置下"兜底覆盖"无缺口', missing.length === 0)

  const f2 = { agents: { ...FALLBACK.agents } }; delete f2.agents.codebuddy
  expect('反向 1：把兜底里的 codebuddy 删掉 ⇒ 必须报缺口', checkFallbackCovers(raw, f2).includes('codebuddy'))

  const r2 = JSON.parse(JSON.stringify(raw)); delete r2.agents.pi
  expect('反向 2：把配置里的 pi 删掉 ⇒ "配置自洽"必须报红', checkConfigSelfConsistent(r2).some(s => s.includes('pi')))

  const f3 = { agents: { ...FALLBACK.agents, pi: { entry: '', printArgs: null } } }
  expect('反向 3：兜底载体缺入口/printArgs ⇒ "兜底可用"必须报红', checkFallbackUsable(f3).length >= 2)

  expect('反向 4：「角色指向不存在载体」必须抛错、不冒用', checkNoSilentCarrierSwap().ok)

  console.log(bad ? `\n❌ 闸自检未过（${bad} 项）` : '\n✅ 闸自检全过（有牙）')
  process.exit(bad ? 1 : 0)
}

const okCfg = existsSync(CFG)
add('配置存在', okCfg, CFG)
if (okCfg) {
  // ★ 2026-10-10 实测补：**解析失败也要整齐报红**，不许把异常甩出栈 ——
  //   本次就撞过一次（agents.json 里一个没转义的双引号）：闸崩了、只留下 Node 的堆栈，
  //   而"配置坏了"这件事本身才是最该被一句话说清的。（顺手也证明了别处是安全的：loadConfig 会退到兜底并⚠️，角色自检报"没有这个角色"、起飞前检查 exit 1。）
  let raw = null
  try { raw = readJson(CFG) } catch (e) {
    add('① 配置能解析', false, '解析失败：' + String((e && e.message) || e).slice(0, 160))
  }
  if (raw) {
    add('① 配置能解析', true, 'JSON 合法')
    const bad1 = checkConfigSelfConsistent(raw)
    add('① 配置自洽（roles/defaultAgent 指向的载体都已声明）', bad1.length === 0, bad1.join('；') || '逐条对上')
    const miss = checkFallbackCovers(raw)
    add('② 兜底覆盖（FALLBACK.agents ⊇ 在编角色用到的载体）', miss.length === 0, miss.length ? `兜底缺：${miss.join('、')}` : `${Object.keys(FALLBACK.agents).length} 个载体已覆盖`)
    const bad3 = checkFallbackUsable()
    add('③ 兜底可用（每个兜底载体都有入口 ＋ printArgs）', bad3.length === 0, bad3.join('；') || '都有')
  }
}
const swap = checkNoSilentCarrierSwap()
add('④ 不静默冒用载体（角色指向不存在载体 ⇒ 响亮报错）', swap.ok, swap.why)

let fails = 0
for (const r of rows) { console.log((r.ok ? '✅ ' : '❌ ') + r.name + (r.detail ? ' ｜ ' + r.detail : '')); if (!r.ok) fails++ }
console.log(fails ? `\n❌ 兜底对账 ${fails} 项不达标` : `\n✅ 兜底对账全过（${rows.length} 项）—— 两个源结构对等、且不会"名字对、命令错"`)
process.exit(fails ? 1 : 0)
