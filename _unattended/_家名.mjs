/**
 * 家名 —— **同一个家，在不同载体上叫什么**（★ 2026-10-12 新增，唯一实现）。
 *
 * ## 为什么必须单独抽出来
 * 这个映射原来**有两份**，而且**不一致**：
 *   · 运行侧 `_agents-config.mjs`（拼载体的命令行）＝ 先查路由表那家的 `perCarrier[载体].name`，查不到回落 `alias[0]`。
 *   · 面板侧 `额度面板.mjs`（写 `agents.json`）＝ **只看 `alias[0]`**，`perCarrier` 一眼都没看。
 * ⇒ 实测后果（用户报障："选不了模型，选了也没用"）：
 *   ① 面板给 coder-a（Pi）写 `xiaomi/…`，而运行侧拼的是 `xiaomi-token-plan-cn/…`；
 *   ② 路由表里记着 2026-10-07 的实测口径：**Pi / OpenCode 的 `xiaomi` 是按量计费口，套餐钥匙打过去 401**
 *      （`_coder路由表.json` 的 `xiaomi.perCarrier._说明`、`_agents-config.mjs` 的同一段注释）。
 *   于是"在看板改个模型"会**静默把家名换成打不通的那个口** —— 正是本项目最恨的静默坏件。
 *
 * ## 口径（**数据驱动，代码不写死任何厂商名**）
 *   `carrierNameOf(canon, 载体)`：
 *     ① 路由表 `rt[canon].perCarrier[载体].name`  ← **权威**（同一家在不同载体上可以叫不同名字）
 *     ② 否则 `rt[canon].alias[0]`（档案里的另一种叫法）
 *     ③ 否则权威名本身
 *   `canonOfCarrierName(名字, 载体)` 是**反向**（界面/配置里送来的前缀到底是哪一家）。
 *
 * ⚠️ 本模块**只有 fs/path 依赖**（`_agents-config.mjs` 特意不 import 兄弟模块，怕成环；
 *    任何要读路由表的模块都可以安全 import 它）。
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 路由表路径（可用环境变量指到别处，便于探针在临时目录里造现场）。 */
export const ROUTING_FILE = process.env.DSH_ROUTING_TABLE || join(HERE, '_coder路由表.json')

let _mt = null
let _cache = null

/**
 * 读路由表（**按 mtime 缓存**）。
 * ⚠️ 必须带失效判据：面板是**长驻进程**，用户随时可能在「＋ 添加」里新增一家
 *   （`addProvider` 直接改这个文件）—— 若缓存不失效，新家的名字会**永远**解析不出来。
 */
export function routingTable () {
  try {
    const mt = statSync(ROUTING_FILE).mtimeMs
    if (_cache && mt === _mt) return _cache
    _cache = JSON.parse(readFileSync(ROUTING_FILE, 'utf8').replace(/^\uFEFF/, ''))
    _mt = mt
    return _cache
  } catch {
    return _cache ?? {}      // 读不到就退回上一次的好值（别把调用方炸掉）
  }
}

/** 那家的 `perCarrier` 段（**这个家在各载体上的私有名字/钥匙变量**）。查不到 → null。
 *  ⚠️ **永远读原表**：`discoverProviders()` 那份合并视图是**白名单挑字段**的（`额度钥匙.mjs` 的
 *  `readRoutingTable`），里面**没有 `perCarrier`** —— 拿它当路由表查会**静默查不到**（我第一版就踩了）。 */
export function perCarrierOf (provider) {
  const rt = routingTable()
  return (rt && rt[provider] && rt[provider].perCarrier) || null
}

/**
 * 权威名 → **这个载体认的名字**。
 * @param {string} canon 路由表里的权威名（例 `xiaomi`）
 * @param {string} agentName 载体名（例 `pi`）
 * @param {{routing?:object}} [options] `routing` 只用来取**别名**（合并视图里才有 `alias`）；`perCarrier` 一律读原表
 */
export function carrierNameOf (canon, agentName, options = {}) {
  if (!canon) return canon
  const m = perCarrierOf(canon)?.[String(agentName ?? '')]
  if (m && m.name) return m.name
  const alias = options.routing?.[canon]?.alias
  if (Array.isArray(alias) && alias.length) return alias[0]
  return canon
}

/** 这个载体上，这家的**钥匙环境变量名**（查不到 → null，调用方自己回落路由表的 `apiKeyEnv`）。 */
export function carrierKeyEnvOf (canon, agentName) {
  const m = perCarrierOf(canon)?.[String(agentName ?? '')]
  return (m && m.keyEnv) || null
}

/**
 * **反向**：载体上的名字 → 权威名（认不出就**原样返回**，绝不瞎猜）。
 *
 * 三道：① 原表里本身就是权威名 → 原样；② 是某家的 `alias`（别名只在合并视图里）→ 那家；
 * ③ 是某家 `perCarrier` 里**这个载体**那一格的名字 → 那家（`agentName` 为空时才跨载体搜）。
 */
export function canonOfCarrierName (name, agentName = null, options = {}) {
  const s = String(name ?? '')
  if (!s) return s
  const raw = routingTable()
  if (raw[s]) return s
  // ★W10：**先查原表的 alias** —— 合并视图（options.routing）是白名单挑字段的，
  //   而且很多调用方根本不传它（运行侧拼命令时就没传）⇒ 只查合并视图＝这条规则形同虚设。
  const byRawAlias = Object.entries(raw).find(([, v]) => Array.isArray(v?.alias) && v.alias.includes(s))
  if (byRawAlias) return byRawAlias[0]
  const rt = options.routing ?? {}
  const byAlias = Object.entries(rt).find(([, v]) => Array.isArray(v?.alias) && v.alias.includes(s))
  if (byAlias) return byAlias[0]
  const byPc = Object.entries(raw).find(([, v]) => {
    const pc = v?.perCarrier
    if (!pc) return false
    if (agentName) return pc[String(agentName)]?.name === s
    return Object.values(pc).some((x) => x && x.name === s)
  })
  return byPc ? byPc[0] : s
}

/**
 * 这个载体**认得**的前缀名（用于：① 校验"你选的家它认不认"；② 把界面送来的值拆成「家 + 裸名」）。
 * 返回 Map：`名字 → 权威名`。**含**权威名本身、`alias`、以及 `perCarrier[这个载体].name`。
 */
export function carrierNameMap (agentName, options = {}) {
  const raw = routingTable()
  const rt = { ...(options.routing ?? {}), ...raw }
  const out = new Map()
  for (const canon of Object.keys(rt)) {
    if (!rt[canon] || typeof rt[canon] !== 'object') continue
    out.set(canon, canon)
    for (const a of (rt[canon].alias ?? [])) out.set(a, canon)
    const m = perCarrierOf(canon)?.[String(agentName ?? '')]
    if (m && m.name) out.set(m.name, canon)
  }
  return out
}

/** 探针用：把缓存丢掉（改了路由表文件之后强制重读）。 */
export function forgetRoutingCache () { _mt = null; _cache = null }
