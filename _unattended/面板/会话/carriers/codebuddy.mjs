/**
 * 会话翻译器 · **CodeBuddy**（`--output-format json`＝**JSON 数组** ／ `stream-json`＝**JSONL**）
 *
 * ⚠️★ b71（2026-10-13）**这家两套 schema 不一样**，必须都认（切了 `stream-json` 之后走下面第二套）：
 *
 * **① 数组族**（`json`）实测样本 `_unattended\logs\_角色自检\reviewer.out.json`（2.163 真跑）
 *   · `message:user`  → `content[]` 全是 `input_text`：**第 1 块是系统提醒/记忆巨块，第 2 块才是任务正文**
 *   · `reasoning`     → `rawContent[].text` ＝ 思考
 *   · `function_call` → `name` + `arguments`（JSON 字符串）
 *   · `function_call_result` → `output.text`
 *   · `message:assistant` → `content[].output_text|text` ＝ 正文
 *   · `result`        → 末元素（subtype / num_turns / is_error）
 *   · `file-history-snapshot` → 跳过
 *   ★ **本家是"最完整"的一家**：连 user 消息都回吐。
 *
 * **② `stream-json`**（Anthropic 式；真样本 `_probe\stream-json\reviewer.stream-json.jsonl`）
 *   · `system/init`（session_id / model）· `system/status`（跳过）
 *   · `assistant` → `message.content[]`：**`{type:'thinking', thinking}` ＝ 思考正文**（★ 真跑已见）
 *     ／ `{type:'text', text}` ＝ 正文 ／ `{type:'tool_use', name, input}`（**此形态尚无真样本**）
 *   · `result`（subtype / is_error / num_turns / total_cost_usd）
 *   ⚠️ 这一套**不回吐 user** ⇒ 会话视图里的"输入"仍以 `.prompt.txt`（A2 注入）为准，不受影响。
 * ⚠️ 数组族**无法半截解析**；JSONL 可以（切过去之后"边跑边看"更顺）。
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
    /* ── ② stream-json（Anthropic 式）：system/init ＋ assistant.message.content[] ── */
    if (j.type === 'system' && j.subtype === 'init') {
      out.push({ role: 'assistant', kind: 'status', text: '会话启动 ' + shortId(j.session_id) + (j.model ? '（' + j.model + '）' : ''), ts })
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
    /* ── ① 数组族（原样保留） ── */
    if (j.type === 'message' && j.role === 'user') {
      const blocks = (j.content || []).filter((c) => c && (c.type === 'input_text' || c.type === 'text') && c.text)
      for (const c of blocks) {
        // ⚠️ 第 1 块常常是"系统提醒/记忆巨块"，**不是任务正文**。别把它当任务显示 ——
        //    真任务正文的权威来源是 `.prompt.txt`（A2 拼会话时注入）；这里出的是载体自己的回声。
        out.push({ role: 'user', kind: 'text', text: cut(c.text), ts })
      }
      continue
    }
    if (j.type === 'reasoning') {
      const t = (j.rawContent || []).map((x) => x && x.text).filter(Boolean).join('\n')
      if (t.trim()) out.push({ role: 'assistant', kind: 'thinking', text: cut(t), ts })
      continue
    }
    if (j.type === 'function_call') {
      out.push({ role: 'assistant', kind: 'tool_use', tool: String(j.name ?? 'tool'), input: argLine(j.arguments), ts })
      continue
    }
    if (j.type === 'function_call_result') {
      const t = (j.output && j.output.text != null) ? j.output.text : j.output
      if (String(t ?? '').trim()) out.push({ role: 'assistant', kind: 'tool_result', text: cut(String(t), 1200), ts })
      continue
    }
    if (j.type === 'message' && j.role === 'assistant') {
      for (const c of j.content || []) {
        if (c && (c.type === 'output_text' || c.type === 'text') && c.text) out.push({ role: 'assistant', kind: 'text', text: cut(c.text), ts })
      }
      continue
    }
    if (j.type === 'result') {
      out.push({
        role: 'assistant', kind: 'status', ts,
        text: '任务结束（' + String(j.subtype || '?') + (j.is_error ? ' · 报错' : '') + ' · ' + (j.num_turns ?? '?') + ' 回合）'
      })
    }
  }
  return out
}

function argLine (a) {
  if (typeof a !== 'string') { try { return cut(JSON.stringify(a ?? ''), 300) } catch { return '' } }
  try { const o = JSON.parse(a); return cut(String(o.command ?? o.path ?? o.file_path ?? JSON.stringify(o)), 300) } catch { return cut(a, 300) }
}
function shortId (x) { const s = String(x ?? ''); return s.length > 12 ? s.slice(0, 12) + '…' : s }
function inputSummary (input) {
  if (input && typeof input === 'object') return String(input.path ?? input.command ?? input.file_path ?? JSON.stringify(input))
  return String(input ?? '')
}
