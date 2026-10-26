/**
 * 会话翻译器的**公共小工具**（叶子模块 —— ⚠️ **不许 import 任何本目录的兄弟模块**）。
 *
 * ## 为什么单独抽出来（★ 2026-10-18 · b123）
 * 这些函数原来住在 `session.mjs` 里，而 6 个载体翻译器写的是 `import { cut, tsOf } from '../session.mjs'`。
 * b123 把"载体分派"改成**动态发现**（`../_翻译器.mjs` 顶层 await 去 import 每个 carriers 文件）之后，
 * 这条边就变成了**死锁环**：
 *   `session.mjs` →（await）→ `carriers\pi.mjs` →（import）→ `session.mjs`（还在等自己）
 * 实测症状：`Warning: Detected unsettled top-level await`、进程 exit 13、**一个翻译器都装不上**。
 * ⇒ 把工具搬到**叶子**上：loader → carriers → `_工具.mjs`（到此为止，没有环）。
 *
 * `session.mjs` 仍然**再导出**这些名字（对老调用方零改动）。
 */

/** 单块正文上限（防一屏糊死；截断处标"（截断）"，不假装完整）。 */
export const BLOCK_MAX = 4000

// ★ b71（2026-10-13）：**两种包装都吃**的读取器（数组 / JSONL）—— 唯一实现在 `面板\_读事件.mjs`。
//   为什么需要它：CodeBuddy / Qwen Code 切 `stream-json` 之后，同一家的输出从"JSON 数组"变"JSONL"，
//   而**逐元素处理逻辑一模一样**（差的只是外层包装）。
export { readEvents } from '../_读事件.mjs'

/** 工具：按行喂 JSON（JSONL 族通用）。坏行/半截行**跳过**。 */
export function eachJsonLine (text, fn) {
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue
    let j
    try { j = JSON.parse(line) } catch { continue }
    try { fn(j) } catch {}
  }
}

/** 工具：整段 JSON。进行中/坏 ⇒ 放弃（数组族与单信封族无法半截解析）。 */
export function readWholeJson (text) {
  const t = String(text ?? '').replace(/^\uFEFF/, '')
  try { return JSON.parse(t) } catch { return null }
}

/** 工具：夹长度 + 压空白（展示层用）。 */
export function cut (s, n = BLOCK_MAX) {
  const t = String(s ?? '')
  return t.length > n ? t.slice(0, n) + '\n…（截断，共 ' + t.length + ' 字）' : t
}

/** 工具：时间戳（毫秒数/ISO 字符串/Date 都吃；认不出留 undefined）。 */
export function tsOf (v) {
  if (v == null || v === '') return undefined
  if (typeof v === 'number') { try { return new Date(v).toISOString() } catch { return undefined } }
  const d = new Date(v)
  return isNaN(d.getTime()) ? undefined : d.toISOString()
}

/** 工具：工具入参 → 一行摘要（命令/路径优先）。 */
export function argLine (a) {
  if (a == null) return ''
  let o = a
  if (typeof a === 'string') { try { o = JSON.parse(a) } catch { return cut(a, 300) } }
  if (o && typeof o === 'object') {
    const pick = o.command ?? o.path ?? o.file_path ?? o.filePath ?? o.pattern ?? o.query ?? o.url
    if (pick != null) return cut(String(pick), 300)
    try { return cut(JSON.stringify(o), 300) } catch { return '' }
  }
  return cut(String(o), 300)
}
