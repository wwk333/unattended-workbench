/**
 * 翻译器 · Pi（`pi -p --mode json`：**JSONL 事件流**）
 *
 * 契约（展示层 · 零依赖）：
 *   入：载体 stdout 的完整或**进行中**原文（尾部可能半截）
 *   出：[{ ts?, kind: 'thinking'|'message'|'tool'|'result'|'status'|'error', text }]
 *   认不出的行/类型**跳过**、绝不抛错（展示层，判定不靠这里）。
 *
 * 实测样本：`_unattended\logs\_角色自检\coder-a.out.json`（2026-10-09 自检）
 *   · session / agent_start / turn_start / message_start / message_end / message_update / turn_end / agent_end / agent_settled
 *   · assistant 正文与思考在 message_end.message.content[]（{type:'thinking'|'text'}）
 * ⚠️ 工具事件**无样本**：按常见形态尽力（toolCall / toolResult），样例到货再校。
 */
export function toEvents (text) {
  const out = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    let j
    try { j = JSON.parse(line) } catch { continue } // 半截/坏行跳过
    try {
      if (j.type === 'session') { out.push({ kind: 'status', text: '会话启动 ' + shortId(j.id) }); continue }
  // ★ b54（用户"没有限流"纠正了我）：那串"收工/开工"其实是 **Pi 的自动重试** —— out.json 原文：
  //   {"type":"auto_retry_start","attempt":1,"maxAttempts":3,"errorMessage":"429: … Upstream request failed: Endpoint is unavailable."}
  //   ⇒ 不是我们被限流，是**那家自己报"上游不可用"**；重试后多数成功 ⇒ 任务照常推进。
  //   光秃秃的"收工/开工"会让人以为任务在重启 ⇒ **把重试连原因一起亮出来**。
  if (j.type === 'auto_retry_start') { out.push({ role: 'assistant', kind: 'status', text: '⚠️ 自动重试 ' + (j.attempt ?? '?') + '/' + (j.maxAttempts ?? '?') + '（' + String(j.errorMessage ?? '').slice(0, 70) + '）', ts }); continue }
  if (j.type === 'auto_retry_end') { out.push({ role: 'assistant', kind: 'status', text: (j.success ? '重试成功' : '⚠️ 重试仍失败') + '（第 ' + (j.attempt ?? '?') + ' 次）', ts }); continue }
      if (j.type === 'agent_start') { out.push({ kind: 'status', text: '开工' }); continue }
      if (j.type === 'message_end') {
        const m = j.message || {}
        if (m.role !== 'assistant') continue
        for (const c of m.content || []) {
          if (c.type === 'thinking' && c.thinking) out.push({ kind: 'thinking', text: clip(c.thinking, 600) })
          else if (c.type === 'text' && c.text) out.push({ kind: 'message', text: clip(c.text, 1500) })
          else if (c.type === 'toolCall' || c.type === 'tool_use') out.push({ kind: 'tool', text: toolLine(c) })
          else if (c.type === 'toolResult' || c.type === 'tool_result') out.push({ kind: 'result', text: clip(String(c.text ?? c.output ?? ''), 220) })
        }
        continue
      }
      // agent_end / turn_end / message_start / message_update 等：机制步，跳过
    } catch {}
  }
  return out
}
function shortId (x) { const s = String(x ?? ''); return s.length > 12 ? s.slice(0, 12) + '…' : s }
function clip (s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + ' …' : s }
function toolLine (c) {
  const name = c.name ?? c.tool ?? '工具'
  let inp = c.input ?? c.arguments ?? ''
  if (inp && typeof inp === 'object') inp = inp.path ?? inp.command ?? inp.file_path ?? JSON.stringify(inp)
  return name + ': ' + clip(String(inp), 160)
}
