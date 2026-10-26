/**
 * 会话翻译器 · **Qwen Code**（`--output-format json`＝**JSON 数组** ／ `stream-json`＝**JSONL**）
 *
 * 实测样本：`_unattended\logs\_角色自检\rescue.out.json`（2026-10-09 真跑）
 *   · `system/init`（session_id）· `assistant`（`message.content[]`：thinking / text / tool_use / tool_result）
 *   · `result`（subtype / num_turns / duration_ms / is_error）
 * ★ b71（2026-10-13）**切了 `stream-json`**：真样本 `_probe\stream-json\rescue.stream-json.jsonl`
 *   （事件 `system/init → stream_event → assistant → result/success`）。**逐元素形状与数组族完全相同**
 *   ⇒ 只有"读"这一步要兼容两种包装（`readEvents`），下面的分支**一行没改**。
 *   ⚠️ 数组族**无法半截解析**；JSONL 可以（切过去之后"边跑边看"更顺）。
 * ⚠️ tool_use 事件**仍无真样本**：按 OpenAI 兼容常见形态尽力，样例到货再校。
 */
// ★ b123：工具改从**叶子** `_工具.mjs` 取（原来指向 `../session.mjs` ⇒ 动态发现时会形成死锁环）
import { cut, readEvents, tsOf } from '../_工具.mjs'

export function toConversation (text) {
  const out = []
  const arr = readEvents(text)          // ★ b71：数组 / JSONL 两种包装都吃
  if (!arr.length) return out
  for (const j of arr) {
    if (!j || typeof j !== 'object') continue
    const ts = tsOf(j.timestamp ?? j.__timestamp)
    if (j.type === 'system' && j.subtype === 'init') {
      out.push({ role: 'assistant', kind: 'status', text: '会话启动 ' + shortId(j.session_id), ts })
      continue
    }
    if (j.type === 'user') {
      // 有的版本会回吐 user（形态未实测）—— 有就出，没有就算了
      const t = String(j.message?.content ?? j.content ?? '')
      if (t.trim()) out.push({ role: 'user', kind: 'text', text: cut(t), ts })
      continue
    }
    if (j.type === 'assistant') {
      for (const c of (j.message && j.message.content) || []) {
        if (!c || typeof c !== 'object') continue
        if (c.type === 'thinking' && c.thinking) out.push({ role: 'assistant', kind: 'thinking', text: cut(c.thinking), ts })
        else if (c.type === 'text' && c.text) out.push({ role: 'assistant', kind: 'text', text: cut(c.text), ts })
        else if (c.type === 'tool_use') out.push({ role: 'assistant', kind: 'tool_use', tool: String(c.name ?? '工具'), input: cut(String(inputSummary(c.input)), 300), ts })
        else if (c.type === 'tool_result') out.push({ role: 'assistant', kind: 'tool_result', text: cut(String(c.content ?? c.output ?? ''), 1200), ts })
      }
      continue
    }
    if (j.type === 'result') {
      out.push({
        role: 'assistant', kind: 'status', ts,
        text: '任务结束（' + String(j.subtype || '?') + (j.is_error ? ' · 报错' : '') + ' · ' + (j.num_turns ?? '?') + ' 回合' +
          (j.duration_ms != null ? ' · ' + (j.duration_ms / 1000).toFixed(1) + 's' : '') + '）'
      })
    }
  }
  return out
}

function shortId (x) { const s = String(x ?? ''); return s.length > 12 ? s.slice(0, 12) + '…' : s }
function inputSummary (input) {
  if (input && typeof input === 'object') return String(input.path ?? input.command ?? input.file_path ?? JSON.stringify(input))
  return String(input ?? '')
}
