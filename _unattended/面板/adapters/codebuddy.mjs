/**
 * 翻译器 · CodeBuddy（`--output-format json`＝**JSON 数组** ／ `stream-json`＝**JSONL**）
 *
 * 契约同 pi.mjs。★ b71（2026-10-13）**切了 `stream-json`**，而且**这家两套 schema 不一样**，都得认：
 *   ① 数组族（`json`）：`reasoning`（rawContent[].text＝思考）· `function_call` · `function_call_result`
 *      · `message:assistant`（content[].output_text/text＝正文）· `result`（末元素）
 *      · `message:user`（系统提醒巨块）/ `file-history-snapshot`：跳过
 *   ② `stream-json`（Anthropic 式，真样本 `_probe\stream-json\reviewer.stream-json.jsonl`）：
 *      `system/init` · `assistant`（`message.content[]`：**thinking＝思考正文** ／ text ／ tool_use）· `result`
 *   读用 `面板\_读事件.mjs` 的 `readEvents`（两种包装都吃）；顺带白得：JSONL 可半截解析。
 * 实测样本：`<示例项目>\_crew\tasks\REV-W12.out.json`（2.163 真跑）
 */
import { readEvents } from '../_读事件.mjs'

export function toEvents (text) {
  const out = []
  const arr = readEvents(text)          // ★ b71：数组 / JSONL 两种包装都吃
  if (!arr.length) return out
  for (const j of arr) {
    try {
      const ts = j.timestamp ? new Date(j.timestamp).toISOString() : (j.__timestamp ? new Date(j.__timestamp).toISOString() : undefined)
      /* ── ② stream-json（Anthropic 式）── */
      if (j.type === 'system' && j.subtype === 'init') {
        out.push({ kind: 'status', text: '会话启动 ' + shortId(j.session_id), ts })
        continue
      }
      if (j.type === 'assistant') {
        for (const c of (j.message && j.message.content) || []) {
          if (!c || typeof c !== 'object') continue
          if (c.type === 'thinking' && c.thinking) out.push({ kind: 'thinking', text: clip(c.thinking, 600), ts })
          else if (c.type === 'text' && c.text) out.push({ kind: 'message', text: clip(c.text, 1500), ts })
          else if (c.type === 'tool_use') out.push({ kind: 'tool', text: String(c.name || 'tool') + ': ' + clip(inputSummary(c.input), 160), ts })
          else if (c.type === 'tool_result') out.push({ kind: 'result', text: clip(String(c.content ?? c.output ?? ''), 220), ts })
        }
        continue
      }
      /* ── ① 数组族（原样保留）── */
      if (j.type === 'reasoning') {
        const t = (j.rawContent || []).map(x => x && x.text).filter(Boolean).join('\n')
        if (t) out.push({ kind: 'thinking', text: clip(t, 600), ts })
      } else if (j.type === 'function_call') {
        out.push({ kind: 'tool', text: String(j.name || 'tool') + ': ' + clip(argSummary(j.arguments), 160), ts })
      } else if (j.type === 'function_call_result') {
        const t = j.output && j.output.text != null ? j.output.text : j.output
        if (String(t ?? '').trim()) out.push({ kind: 'result', text: clip(String(t), 220), ts })
      } else if (j.type === 'message' && j.role === 'assistant') {
        for (const c of j.content || []) {
          if ((c.type === 'output_text' || c.type === 'text') && c.text) out.push({ kind: 'message', text: clip(c.text, 1500), ts })
        }
      } else if (j.type === 'result') {
        out.push({
          kind: 'status',
          text: '任务结束（' + String(j.subtype || '?') + (j.is_error ? ' · 报错' : '') + ' · ' + (j.num_turns ?? '?') + ' 回合）',
          ts: j.__timestamp ? new Date(j.__timestamp).toISOString() : undefined
        })
      }
    } catch {}
  }
  return out
}
function clip (s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + ' …' : s }
function shortId (x) { const s = String(x ?? ''); return s.length > 12 ? s.slice(0, 12) + '…' : s }
function inputSummary (input) {
  if (input && typeof input === 'object') return String(input.path ?? input.command ?? input.file_path ?? JSON.stringify(input))
  return String(input ?? '')
}
function argSummary (a) {
  if (typeof a !== 'string') return JSON.stringify(a ?? '').slice(0, 160)
  try { const o = JSON.parse(a); return o.command ?? o.path ?? o.file_path ?? JSON.stringify(o) } catch { return a }
}
