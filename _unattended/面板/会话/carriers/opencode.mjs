/**
 * 会话翻译器 · **OpenCode**（`run --format json`：JSONL 事件流）
 *
 * 实测样本：`_probe\role-skills\s9\S9-SKILL-1.out.json`（2026-10-09 coder-b 真跑）
 *   · `step_start`（part.type='step-start'）· **`text`**（`part.text`＝正文）
 *   · **`tool_use`**（`part.tool` + `part.state.input` 入参 + `part.state.status`）
 *   · `step_finish`（`part.reason`）
 * ⚠️ 它**没有** user 消息、也没有思考块（思考口未接，见施工文档 §7）⇒ 本家的会话只有"助手侧"。
 */
// ★ b123：工具改从**叶子** `_工具.mjs` 取（原来指向 `../session.mjs` ⇒ 动态发现时会形成死锁环）
import { cut, eachJsonLine, tsOf } from '../_工具.mjs'

export function toConversation (text) {
  const out = []
  let step = 0
  eachJsonLine(text, (j) => {
    const p = j.part || {}
    const ts = tsOf(j.timestamp)
    if (j.type === 'step_start') { step++; out.push({ role: 'assistant', kind: 'status', text: '── 第 ' + step + ' 步 ──', ts }); return }
    if (j.type === 'text') {
      const t = String(p.text ?? '')
      if (t.trim()) out.push({ role: 'assistant', kind: 'text', text: cut(t), ts })
      return
    }
    if (j.type === 'tool_use') {
      const st = p.state || {}
      out.push({
        role: 'assistant', kind: 'tool_use', tool: String(p.tool ?? '工具'),
        input: cut(String(argOf(st.input)), 300), ts
      })
      const o = st.output ?? st.result
      if (o != null && String(o).trim()) out.push({ role: 'assistant', kind: 'tool_result', text: cut(String(o), 1200), ts })
      return
    }
    if (j.type === 'step_finish') {
      const r = String(p.reason ?? '')
      out.push({ role: 'assistant', kind: 'status', text: '本步结束' + (r ? '（' + r + '）' : ''), ts })
    }
  })
  return out
}

function argOf (input) {
  if (input && typeof input === 'object') return input.command ?? input.path ?? input.filePath ?? input.pattern ?? JSON.stringify(input)
  return input ?? ''
}
