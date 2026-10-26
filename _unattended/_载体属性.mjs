/**
 * 载体属性 —— **载体声明的唯一读口**（声明文件＝`_crew\carriers.json`）。
 *
 * ## 为什么要有它（★ 2026-10-18 · b122 · 《重构总表》§十三 S2）
 * "哪些载体吃自家订阅""哪些载体的网关能从模型前缀推"原来散成**三份手抄名单**：
 *   `_载体属性.OWNS_SUBSCRIPTION` · `账号自检.OWNS_SUB`（纯抄上一行）· `_定编对账.GW_FROM_MODEL`，
 * 外加 `_agents-config.mjs` 里一条载体名判断。**漏改一处已实测出假警报**：
 * rescue 的裸模型被"照名字"认到阿里头上 ⇒ `❌ 1 家没钥匙：aliyun`。
 * ⇒ 现在这些名单**只在 `_crew\carriers.json`**，本模块只**读**它、并只对外导出**语义查询**
 *   （不再导出任何名单常量 —— 名单本身没有第二个出处）。
 *
 * ## 两条硬约束（改本文件前先读）
 * 1. **只 import node 内置**（fs/path）。`_agents-config.mjs` 要 import 本模块，
 *    而本模块**不能**再 import 回去（会绕成循环依赖：`_载体能力` → `_agents-config` → `额度切换` → 本模块）。
 *    与 `_家名.mjs` 同一套路。
 * 2. **按 mtime 缓存**：面板/看护是长驻进程，用户加减载体后**不该重启就能生效**
 *    （`_家名.mjs` 为同一个理由也这么做）。
 *
 * ## 口径：**没声明 ⇒ 响亮报错，绝不静默当默认**（§十三 判据③）
 * 唯一例外是 `carrierDeclOrNull()`（给"只想看看"的地方用，如自检/面板渲染）。
 */
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 声明文件路径（可用环境变量指到别处 —— 便于探针在临时目录里造现场）。 */
export const CARRIERS_FILE = process.env.DSH_CARRIERS_FILE || join(HERE, '..', '_crew', 'carriers.json')

const GATEWAY_SOURCES = ['model', 'route', 'own']

let _mt = null
let _cache = null
let _err = null

/** 读声明（mtime 缓存）。读不到/坏了 ⇒ 回 null，并把原因留在 `_err`。 */
function load () {
  let mt
  try { mt = statSync(CARRIERS_FILE).mtimeMs } catch (e) {
    _err = `读不到载体声明：${CARRIERS_FILE}（${String(e?.message ?? e)}）`
    return null
  }
  if (_cache && mt === _mt) return _cache
  try {
    // ⚠️ 必须剥 BOM：本项目的 JSON 曾被 BOM 坑过（`JSON.parse` 见到 BOM 直接报 Unexpected token）
    const raw = JSON.parse(readFileSync(CARRIERS_FILE, 'utf8').replace(/^\uFEFF/, ''))
    const reg = (raw && typeof raw.carriers === 'object' && raw.carriers) ? raw.carriers : {}
    _cache = reg
    _mt = mt
    _err = null
    return reg
  } catch (e) {
    _err = `载体声明解析失败：${CARRIERS_FILE}（${String(e?.message ?? e)}）`
    return null
  }
}

/** 已声明载体的 id（按声明文件里的顺序）。读不到 ⇒ **抛**。 */
export function carrierIds () {
  const reg = load()
  if (!reg) throw new Error(_err)
  return Object.keys(reg)
}

/** 某载体的声明对象；**没声明 ⇒ 抛"没有这个载体"**。 */
export function carrierDecl (id) {
  const reg = load()
  const key = String(id ?? '')
  if (!reg) throw new Error(`${_err} —— 查的是「${key}」`)
  const d = reg[key]
  if (!d) {
    throw new Error(
      `❌ 没有这个载体：${key || '(空)'} —— \`_crew\\carriers.json\` 里没有声明它（已声明：${Object.keys(reg).join('、') || '（空）'}）。` +
      '加载体＝声明文件加一条 ＋ `_crew\\agents.json` 的 agents 段加一条 ＋ 两个翻译器文件（`面板\\会话\\carriers\\.mjs` 与 `面板\\adapters\\.mjs`）。'
    )
  }
  return d
}

/** **安静版**：没声明（或声明读不到）回 null。只给"看看而已"的地方用；判据类调用一律用 `carrierDecl()`。 */
export function carrierDeclOrNull (id) {
  const reg = load()
  if (!reg) return null
  return reg[String(id ?? '')] ?? null
}

/** 这个载体吃自家订阅吗（＝不进"换 API"那条轴、也不查我们的钥匙）。 */
export function ownsSubscriptionOf (id) {
  return carrierDecl(id).ownsSubscription === true
}

/** 网关从哪来：`model`（按模型前缀推）/ `route`（按路由表）/ `own`（吃自有清单，不许推）。取值非法 ⇒ **抛**。 */
export function gatewaySourceOf (id) {
  const s = carrierDecl(id).gatewaySource
  if (!GATEWAY_SOURCES.includes(s)) {
    throw new Error(`❌ 载体 ${id} 的 gatewaySource 取值非法：${JSON.stringify(s)}（只许 ${GATEWAY_SOURCES.join(' / ')}）`)
  }
  return s
}

/** 派活时要按"它自己配置里这条模型绑的那家"补钥匙变量吗。 */
export function needsModelBindingKeyOf (id) {
  return carrierDecl(id).needsModelBindingKey === true
}

/** 面板翻译器名（null ＝ 未进编制、面板不显示它的会话）。 */
export function carrierShapeOf (id) {
  const s = carrierDecl(id).shape
  return s == null ? null : String(s)
}

/**
 * 看板上显示的名字。★ 2026-10-18（b123）：从声明里读（`displayName`）——
 * 以前这张名字表**写死在面板代码里两处**（`面板\帧数据.mjs` 与 `面板\帧动作.mjs` 各一张 `pi→'Pi'`），
 * 加一个载体就得改面板。**缺了就回落裸 id**（不编、不猜）。
 */
export function carrierDisplayNameOf (id) {
  const d = carrierDeclOrNull(id)
  const n = d?.displayName
  return (typeof n === 'string' && n.trim()) ? n.trim() : String(id ?? '')
}

/**
 * 这个载体要不要走"换 API（换家）"那条轴。★ 保留旧函数名 —— `额度切换.mjs` 在用。
 * 语义＝ `usesProviderAxis(x) === !ownsSubscriptionOf(x)`。
 */
export function usesProviderAxis (agentId) {
  return !ownsSubscriptionOf(agentId)
}

/** 声明文件的读取状态（给 `_载体声明自检.mjs` 与起飞前检查看；**不抛**）。 */
export function carriersSource () {
  const reg = load()
  return { file: CARRIERS_FILE, ok: !!reg, ids: reg ? Object.keys(reg) : [], error: _err }
}
