/**
 * 翻译器 · OpenCode（`run --standalone --format json`：**JSONL**）
 *
 * 契约同 pi.mjs：入=完整或进行中原文；出=统一事件行；认不出跳过、不抛错。
 * 实测样本：`_probe\role-skills\s9\S9-SKILL-1.out.json`（2026-10-09 coder-b 真跑）
 *   · part.type：step-start / tool / step-finish / text
 *   · 正文＝text 事件的 part.text；工具＝tool_use 的 part.tool + part.state.input
 *   · step_start / step_finish：机制步，跳过（"几步"看账本回合数）
 * ★ 2026-10-10（④思考层·T2）：**给它加了 `--thinking`**（`_crew\agents.json`）—— 上面那份样本里**没有思考正文**，
 *   只有思考 token 数 `part.tokens.reasoning: 1493`。
 * ★ 2026-10-10 **极小真跑已确认**（`_unattended\_角色自检.mjs`，两字卡；留档
 *   `_probe\board-look\samples\opencode-thinking.jsonl`）—— 思考事件的**真形状**是：
 *       `{"type":"reasoning","part":{"type":"reasoning","text":"…正文…"}}`
 *   ⇒ 下面把这条列为主路径（确认过）；`thinking` / `*_delta` 那几个名字**保留为兜底**（别的版本可能不同名），
 *   取正文的字段顺序也照实测（`part.text` 优先）。认不出照旧跳过、绝不抛错。
 */
const THINK_NAMES = new Set(['reasoning', 'thinking', 'reasoning_delta', 'thinking_delta'])
function thinkText (j, p) {
  const cand = p.text ?? p.thinking ?? j.text ?? j.thinking ?? p.content ?? j.content
  return typeof cand === 'string' ? cand : ''
}
export function toEvents (text) {
  const out = []
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue
    let j
    try { j = JSON.parse(line) } catch { continue }
    try {
      const p = j.part || {}
      const ts = j.timestamp ? new Date(j.timestamp).toISOString() : undefined
      if (THINK_NAMES.has(String(j.type)) || THINK_NAMES.has(String(p.type))) {
        const s = thinkText(j, p)
        if (s) out.push({ kind: 'thinking', text: clip(s, 800), ts })
      }
      else if (j.type === 'text' && p.text) out.push({ kind: 'message', text: clip(p.text, 1500), ts })
      else if (j.type === 'tool_use') {
        const st = p.state || {}
        if (st.status === 'error') out.push({ kind: 'error', text: String(p.tool || 'tool') + ' 失败: ' + clip(String(st.error ?? st.output ?? ''), 200), ts })
        else out.push({ kind: 'tool', text: toolWhat(p.tool, st.input), ts })
      }
    } catch {}
  }
  return out
}
function clip (s, n) { s = String(s ?? ''); return s.length > n ? s.slice(0, n) + ' …' : s }
function toolWhat (tool, input) {
  let s
  if (input && typeof input === 'object') s = input.path ?? input.command ?? input.filePath ?? JSON.stringify(input)
  else s = String(input ?? '')
  return String(tool || 'tool') + ': ' + clip(s, 160)
}
