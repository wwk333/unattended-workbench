/**
 * 读载体输出的事件序列 —— **两种外层包装都吃**：
 *   · **整段 JSON**（数组 / 单信封）—— CodeBuddy / Qwen Code 的 `--output-format json`
 *   · **JSONL**（一行一个对象）—— 同一家切 `--output-format stream-json` 之后，
 *     **以及** pi / opencode / codewhale 本来就是 JSONL
 *
 * ★ b71（2026-10-13）为什么要有它：Claude 式那两家（CodeBuddy / Qwen Code）切 `stream-json` 之后，
 *   **逐元素处理逻辑与数组族一模一样**（`system/init` · `assistant.message.content[]` · `result`），
 *   差的只是**外层包装**。读取器兼容两种 ⇒ 翻译器不必写两套，也**不会因为漏改一处而整格空白**。
 * ★ 顺带白得一条：JSONL **可以半截解析**（文件正在变长时也能出内容）—— 这正是"边跑边看"要的。
 * ⚠️ 数组族仍然**无法**半截解析（进行中拿到的是坏 JSON）⇒ 那种情况返回 `[]`，与从前行为一致。
 */

/** @param {string} text 原始输出（完整或进行中） @returns {Array<object>} 事件数组（读不到就是空数组，不抛） */
export function readEvents (text) {
  const t = String(text ?? '').replace(/^\uFEFF/, '')
  let whole = null
  try { whole = JSON.parse(t) } catch { whole = null }
  if (Array.isArray(whole)) return whole
  if (whole && typeof whole === 'object') return [whole]
  const out = []
  for (const line of t.split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try { const j = JSON.parse(s); if (j && typeof j === 'object') out.push(j) } catch {}
  }
  return out
}
