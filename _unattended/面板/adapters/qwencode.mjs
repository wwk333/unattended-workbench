/**
 * 翻译器 · Qwen Code（`--output-format json`＝**JSON 数组** ／ `stream-json`＝**JSONL**）
 *
 * 契约同 pi.mjs。★ b71（2026-10-13）**切了 `stream-json`**（真样本 `_probe\stream-json\rescue.stream-json.jsonl`）：
 * 事件形状与数组族**完全相同**，只有"读"要兼容两种包装 ⇒ 用 `面板\_读事件.mjs` 的 `readEvents`。
 * 顺带白得：JSONL 可半截解析（进行中也能出内容）。数组族仍然只能等完整。
 * 实测样本：`_unattended\logs\_角色自检\rescue.out.json`（2026-10-09 真跑）
 *   · system/init（session_id）· assistant（message.content[]：thinking/text）· result（subtype/num_turns/duration_ms）
 * ⚠️ tool_use 事件**无样本**：按 OpenAI 兼容常见形态尽力，样例到货再校。
 */
import { readEvents } from '../_读事件.mjs'

export function toEvents (text) {
  const out = []
  const arr = readEvents(text)          // ★ b71：数组 / JSONL 两种包装都吃
  if (!arr.length) return out
  for (const j of arr) {
    try {
      if (j.type === 'system' && j.subtype === 'init') { out.push({ kind: 'status', text: '会话启动 ' + shortId(j.session_id) }); continue }
      if (j.type === 'assistant') {
        for (const c of (j.message && j.message.content) || []) {
          if (c.type === 'thinking' && c.thinking) out.push({ kind: 'thinking', text: clip(c.thinking, 600) })
          else if (c.type === 'text' && c.text) out.push({ kind: 'message', text: clip(c.text, 1500) })
          else if (c.type === 'tool_use') out.push({ kind: 'tool', text: String(c.name || 'tool') + ': ' + clip(inputSummary(c.input), 160) })
          else if (c.type === 'tool_result') out.push({ kind: 'result', text: clip(String(c.content ?? c.output ?? ''), 220) })
        }
        continue
      }
      if (j.type === 'result') {
        out.push({
          kind: 'status',
          text: '任务结束（' + String(j.subtype || '?') + (j.is_error ? ' · 报错' : '') + ' · ' + (j.num_turns ?? '?') + ' 回合' + (j.duration_ms != null ? ' · ' + (j.duration_ms / 1000).toFixed(1) + 's' : '') + '）'
        })
      }
      // user / 其他：跳过
    } catch {}
  }
  return out
}
function shortId (x) { const s = String(x ?? ''); return s.length > 12 ? s.slice(0, 12) + '…' : s }
function clip (s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + ' …' : s }
function inputSummary (input) {
  if (input && typeof input === 'object') return String(input.path ?? input.command ?? input.file_path ?? JSON.stringify(input))
  return String(input ?? '')
}
