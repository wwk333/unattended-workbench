/**
 * 翻译器 · DSH headless（`coder-b-dsh.mjs`：**单信封 JSON**，一次一份）
 *
 * 契约同 pi.mjs。进行中/坏 JSON ⇒ 整段放弃（等完整）。
 * 实测样本：`_unattended\logs\_角色自检\researcher.out.json`（2026-10-09 真跑）
 *   · { is_error, subtype, result, session_id, duration_ms, num_turns, usage, permission_denials, stderr_tail }
 */
export function toEvents (text) {
  const out = []
  let j
  try { j = JSON.parse(String(text).replace(/^\uFEFF/, '')) } catch { return out }
  if (!j || typeof j !== 'object' || Array.isArray(j)) return out
  if (j.result === undefined && j.is_error === undefined) return out // 不是信封形状：放弃
  try {
    if (j.is_error) out.push({ kind: 'error', text: clip(String(j.result ?? j.error ?? '报错'), 600) })
    else if (j.result != null && String(j.result).trim()) out.push({ kind: 'message', text: clip(String(j.result), 1500) })
    const bits = []
    if (j.num_turns != null) bits.push(j.num_turns + ' 回合')
    if (j.duration_ms != null) bits.push((j.duration_ms / 1000).toFixed(1) + 's')
    if (j.session_id) bits.push('会话 ' + shortId(j.session_id))
    if (bits.length) out.push({ kind: 'status', text: '完成 · ' + bits.join(' · ') })
    if (Array.isArray(j.permission_denials) && j.permission_denials.length) {
      out.push({ kind: 'error', text: '有被拒权限 ' + j.permission_denials.length + ' 项（见账本）' })
    }
  } catch {}
  return out
}
function shortId (x) { const s = String(x ?? ''); return s.length > 12 ? s.slice(0, 12) + '…' : s }
function clip (s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + ' …' : s }
