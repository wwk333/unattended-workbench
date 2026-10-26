/**
 * 翻译器 · CodeWhale（`exec --auto --output-format stream-json`：**JSONL**，exec-stream 族）
 *
 * 契约同 pi.mjs。
 * 实测样本：`_probe\upgrade-check\codewhale-stream.jsonl`（2026-10-09 真跑）
 *   · content（正文）· turn_usage（机制步，跳过）· session_capture（saved_session_id，续跑用）
 *   · metadata（receipt_kind=terminal：输入/输出 token）· done
 */
export function toEvents (text) {
  const out = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    let j
    try { j = JSON.parse(line) } catch { continue }
    try {
      if (j.type === 'content' && j.content) out.push({ kind: 'message', text: clip(j.content, 1500) })
      else if (j.type === 'session_capture' && j.saved_session_id) out.push({ kind: 'status', text: '会话已存 ' + shortId(j.saved_session_id) })
      else if (j.type === 'metadata') {
        const m = j.meta || {}
        if (m.receipt_kind === 'terminal') out.push({ kind: 'status', text: '结束 · 输入 ' + (m.input_tokens ?? '?') + ' / 输出 ' + (m.output_tokens ?? '?') })
      } else if (j.type === 'done') out.push({ kind: 'status', text: '收工' })
    } catch {}
  }
  return out
}
function shortId (x) { const s = String(x ?? ''); return s.length > 12 ? s.slice(0, 12) + '…' : s }
function clip (s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + ' …' : s }
