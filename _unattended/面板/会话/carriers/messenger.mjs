/**
 * 会话翻译器 · **DSH headless**（`coder-b-dsh.mjs`：**单信封 JSON**，一次一份）
 *
 * 实测样本：`_unattended\logs\_角色自检\researcher.out.json`（2026-10-09 真跑）
 *   · `{ is_error, subtype, result, session_id, duration_ms, num_turns, usage, permission_denials, stderr_tail }`
 *
 * ⚠️ **这一家只有最终结果，看不到过程**（实测：0.6KB / 23 行，就是个信封）。
 *   原因：`coder-b-dsh.mjs` 用 `spawnSync` **全量收**宿主输出，且宿主吐的是整段 NDJSON
 *   ⇒ 要看到过程得去读 **DSH 自己的会话记录**（另一条链，成本高）。
 *   ⇒ 会话视图里如实标"这家只有最终结果"（施工文档 §6.4 代价一）。
 * ★★ 2026-10-13（b72）**真跑坐实（两次）**：宿主的**原始 NDJSON 里根本没有思考事件** ——
 *   ① xiaomi/mimo-v2.6-flash；② ark/deepseek-v4.1-flash @ max（**换到"档位有声明"的路径也一样**）。
 *   两次都是同样 7 类事件：`session` · `status/{turn_start,step_start,step_end,turn_end}` · `text` · `final`，
 *   全文 grep `thinking|reasoning|thought` = **0 命中**。
 *   ⇒ **不是我们把思考丢了，是这条路拿不到**（"形态不存在"）。所以"接思考"对这家**无从做起**。
 *   （取证口子：`coder-b-dsh.mjs` 支持 `DSH_RAW_OUT=<路径>` 把原始流落盘。）
 */
// ★ b123：工具改从**叶子** `_工具.mjs` 取（原来指向 `../session.mjs` ⇒ 动态发现时会形成死锁环）
import { cut, readWholeJson, tsOf } from '../_工具.mjs'

export function toConversation (text) {
  const out = []
  const j = readWholeJson(text)
  if (!j || typeof j !== 'object' || Array.isArray(j)) return out
  if (j.result === undefined && j.is_error === undefined) return out   // 不是信封形状：放弃
  const ts = tsOf(j.__timestamp ?? j.timestamp)
  if (j.is_error) out.push({ role: 'assistant', kind: 'error', text: cut(String(j.result ?? j.error ?? '报错')), ts })
  else if (j.result != null && String(j.result).trim()) out.push({ role: 'assistant', kind: 'text', text: cut(String(j.result)), ts })
  const bits = []
  if (j.num_turns != null) bits.push(j.num_turns + ' 回合')
  if (j.duration_ms != null) bits.push((j.duration_ms / 1000).toFixed(1) + 's')
  if (j.session_id) bits.push('会话 ' + shortId(j.session_id))
  if (bits.length) out.push({ role: 'assistant', kind: 'status', text: '完成 · ' + bits.join(' · '), ts })
  if (Array.isArray(j.permission_denials) && j.permission_denials.length) {
    out.push({ role: 'assistant', kind: 'error', text: '有被拒权限 ' + j.permission_denials.length + ' 项（见账本）', ts })
  }
  if (j.stderr_tail) out.push({ role: 'assistant', kind: 'status', text: 'stderr 尾部：' + cut(String(j.stderr_tail), 400), ts })
  return out
}

function shortId (x) { const s = String(x ?? ''); return s.length > 12 ? s.slice(0, 12) + '…' : s }
