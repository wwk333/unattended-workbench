/**
 * 翻译器加载器 —— **按目录动态发现**，不再"一行一家"地静态 import。
 *
 * ## 为什么要有它（★ 2026-10-18 · b123）
 * `adapters\index.mjs` 与 `会话\session.mjs` 原来是
 *   `import { toEvents as pi } from './pi.mjs'` × 6 ＋ `const MAP = { pi, opencode, … }`
 * ⇒ **加一个载体就得改这两个核心文件**，正是《重构总表》§十三 要消灭的"改代码才能加减载体"。
 * 而且**每行只有一个载体名**（名字还没加引号）⇒ `_probe\_载体可插拔性审计.mjs` 那个
 * "一行里 ≥2 个载体名"的扫描**抓不到它**（实测：审计报 0 处，缺口却在）。
 * ⇒ 现在改成"扫目录"，加载体只需**多一个翻译器文件**，这两个文件一个字都不用动。
 *
 * ## 两个契约（别混，见 `会话\session.mjs` 头部）
 *   `adapters\*.mjs`        → `{ kind, text }`  事件行（"最近动态"用）
 *   `会话\carriers\*.mjs`   → `{ role, kind, text, … }` 会话条目（会话视图用）
 *
 * ## 三条纪律
 * 1. **顶层 await 预装**：模块评估完再让上层跑 ⇒ `toEvents`/`toConversation` 保持**同步** API
 *    （`帧数据.mjs` 的 `buildFrames()` 是同步的，不能为了这个改成 async）。
 * 2. **坏文件只跳过、并记账**（`LOAD_ERRORS`）：某一个翻译器写坏了，**不许让整个面板起不来**。
 * 3. `ensureShape()` 给**运行时新加的载体**用（面板「载体」页加完立刻生效，**不必重启**）——
 *    它往**同一张 Map**里塞，所以同步路径也立刻看得到。
 */
import { existsSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))            // = _unattended\面板
const ADAPTER_DIR = join(HERE, 'adapters')
const SESSION_DIR = join(HERE, '会话', 'carriers')

const A = new Map()   // shape → toEvents
const S = new Map()   // shape → toConversation

/** 加载失败的翻译器（面板启动时不拦，但要能看见）。 */
export const LOAD_ERRORS = []

/** 支持列表 —— **同一个数组对象**（`会话流.mjs` 持有它并 `.includes()`，所以只能原地增删）。 */
export const ADAPTER_SUPPORTED = []
export const SUPPORTED = []

const keyOf = (k) => String(k ?? '').toLowerCase().trim()

function listMjs (dir) {
  try {
    // ⚠️ 跳过 index.mjs：它就是**本模块的再导出壳**，装进来会自己 import 自己
    return readdirSync(dir).filter((f) => f.endsWith('.mjs') && f !== 'index.mjs')
  } catch { return [] }
}

async function loadOne (dir, file, into, pick, bust) {
  const shape = file.slice(0, -4)
  try {
    const url = pathToFileURL(join(dir, file)).href + (bust ? '?t=' + Date.now() : '')
    const m = await import(url)
    const f = m?.[pick]
    if (typeof f !== 'function') { LOAD_ERRORS.push(`${shape}: 没有导出 ${pick}()`); return false }
    into.set(shape, f)
    return true
  } catch (e) {
    LOAD_ERRORS.push(`${shape}: ${String(e?.message ?? e)}`)
    return false
  }
}

/** 重新扫两个目录（启动时跑一次；加了文件也可以手动再来一次）。 */
export async function rescan () {
  for (const f of listMjs(ADAPTER_DIR)) if (!A.has(f.slice(0, -4))) await loadOne(ADAPTER_DIR, f, A, 'toEvents', false)
  for (const f of listMjs(SESSION_DIR)) if (!S.has(f.slice(0, -4))) await loadOne(SESSION_DIR, f, S, 'toConversation', false)
  syncLists()
  return { adapters: [...A.keys()], sessions: [...S.keys()], errors: [...LOAD_ERRORS] }
}

function syncLists () {
  for (const k of A.keys()) if (!ADAPTER_SUPPORTED.includes(k)) ADAPTER_SUPPORTED.push(k)
  for (const k of S.keys()) if (!SUPPORTED.includes(k)) SUPPORTED.push(k)
}

/**
 * 让某个 shape **当场可用**（面板刚写完新翻译器文件时调）。
 * @returns {Promise<boolean>} 至少装上一个（两个目录里有一个存在且能加载）
 */
export async function ensureShape (shape) {
  const k = keyOf(shape)
  if (!k) return false
  let any = false
  const a = join(ADAPTER_DIR, k + '.mjs')
  if (!A.has(k) && existsSync(a)) any = (await loadOne(ADAPTER_DIR, k + '.mjs', A, 'toEvents', true)) || any
  const s = join(SESSION_DIR, k + '.mjs')
  if (!S.has(k) && existsSync(s)) any = (await loadOne(SESSION_DIR, k + '.mjs', S, 'toConversation', true)) || any
  syncLists()
  return any
}

/** 某个 shape 的两个翻译器文件都在吗（**只看文件在不在**，不加载）。 */
export function translatorFilesOf (shape) {
  const k = keyOf(shape)
  if (!k) return { adapter: false, session: false }
  return { adapter: existsSync(join(ADAPTER_DIR, k + '.mjs')), session: existsSync(join(SESSION_DIR, k + '.mjs')) }
}

/** 载体输出原文 → 事件行（"最近动态"）。同步。 */
export function toEvents (carrierKey, text) {
  const f = A.get(keyOf(carrierKey))
  if (!f) return []
  try { return f(String(text ?? '')) } catch { return [] }
}

/** 载体输出原文 → 会话条目（会话视图）。同步。 */
export function toConversation (carrier, text) {
  const f = S.get(keyOf(carrier))
  if (!f) return []
  try { return f(String(text ?? '')) } catch { return [] }
}

// ── 顶层 await：先把目录里的翻译器都装好，再放上层跑（同步 API 不变）──────────
await rescan()
