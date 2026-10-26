/**
 * 会话翻译器 · **Pi**（`pi -p --mode json`：JSONL 事件流）
 *
 * 实测样本：`_unattended\logs\_角色自检\coder-a.out.json`（2026-10-09）
 *   · `session` / `agent_start` / `turn_start` / `message_start` / **`message_update`** / `message_end` / `turn_end` / `agent_end` / `agent_settled`
 *   · 正文与思考在 **`message_end.message.content[]`**（`{type:'thinking'|'text'}`）
 *
 * ★ 增量（`message_update.assistantMessageEvent`，实测类型 = `thinking_start`/`thinking_delta`/`thinking_end`
 *   / `text_start`/`text_delta`/`text_end`，`delta` 是真增量）——
 *   本模块**故意不用增量**：`message_end` 已给**当轮完整版**，两处都出会双计。
 *   ⇒ 增量留给"边跑边看"（A4-②，由面板轮询正在变长的文件实现），这里是**权威归档视图**。
 * ⚠️ `message_end` 里也会出现 `role:'system'`（preamble / tools 清单）—— **跳过**，那是提示词不是对话。
 */
// ★ b123：工具改从**叶子** `_工具.mjs` 取（原来指向 `../session.mjs` ⇒ 动态发现时会形成死锁环）
import { cut, eachJsonLine, tsOf } from '../_工具.mjs'

export function toConversation (text) {
  const out = []
  eachJsonLine(text, (j) => {
    const ts = tsOf(j.timestamp)
    if (j.type === 'session') { out.push({ role: 'assistant', kind: 'status', text: '会话启动 ' + shortId(j.id), ts }); return }
  // ★ b54（用户"没有限流"纠正了我）：那串"收工/开工"其实是 **Pi 的自动重试** —— out.json 原文：
  //   {"type":"auto_retry_start","attempt":1,"maxAttempts":3,"errorMessage":"429: … Upstream request failed: Endpoint is unavailable."}
  //   ⇒ 不是我们被限流，是**那家自己报"上游不可用"**；重试后多数成功 ⇒ 任务照常推进。
  //   光秃秃的"收工/开工"会让人以为任务在重启 ⇒ **把重试连原因一起亮出来**。
  if (j.type === 'auto_retry_start') { out.push({ role: 'assistant', kind: 'status', text: '⚠️ 自动重试 ' + (j.attempt ?? '?') + '/' + (j.maxAttempts ?? '?') + '（' + String(j.errorMessage ?? '').slice(0, 70) + '）', ts }); return }
  if (j.type === 'auto_retry_end') { out.push({ role: 'assistant', kind: 'status', text: (j.success ? '重试成功' : '⚠️ 重试仍失败') + '（第 ' + (j.attempt ?? '?') + ' 次）', ts }); return }
    if (j.type === 'agent_start') { out.push({ role: 'assistant', kind: 'status', text: '开工', ts }); return }
    if (j.type === 'agent_end' || j.type === 'agent_settled') { out.push({ role: 'assistant', kind: 'status', text: '收工', ts }); return }
    if (j.type !== 'message_end') return
    const m = j.message || {}
    // ⚠️ 只认 assistant：`role:'system'` 是提示词块，出了会把会话糊满
    if (m.role !== 'assistant') return
    for (const c of m.content || []) {
      if (!c || typeof c !== 'object') continue
      if (c.type === 'thinking' && c.thinking) out.push({ role: 'assistant', kind: 'thinking', text: cut(c.thinking), ts })
      else if (c.type === 'text' && c.text) out.push({ role: 'assistant', kind: 'text', text: cut(c.text), ts })
      else if (c.type === 'toolCall' || c.type === 'tool_use') out.push({ role: 'assistant', kind: 'tool_use', tool: String(c.name ?? c.tool ?? '工具'), input: argOf(c), ts })
      else if (c.type === 'toolResult' || c.type === 'tool_result') out.push({ role: 'assistant', kind: 'tool_result', text: cut(String(c.text ?? c.output ?? ''), 1200), ts })
    }
  })
  return out
}

function argOf (c) {
  const a = c.input ?? c.arguments
  if (a && typeof a === 'object') return cut(String(a.path ?? a.command ?? a.file_path ?? JSON.stringify(a)), 300)
  return cut(String(a ?? ''), 300)
}
function shortId (x) { const s = String(x ?? ''); return s.length > 12 ? s.slice(0, 12) + '…' : s }
