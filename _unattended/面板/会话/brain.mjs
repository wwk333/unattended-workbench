/**
 * 会话翻译器 · **大脑（DSH 自己）** —— 把 `session.v4.jsonl.zstd` 里的事件流翻成会话条目
 *
 * ## 为什么有这个（它和六个载体翻译器不是一回事）
 * 大脑**不在班组账本里**，它不产生 `<task>.prompt.txt` / `.out.json` 那两份东西；
 * 它的话在 **DSH 自己的转录**里：`~\.dsh\sessions\<cwd 编码>\session-<id>\session.v4.jsonl.zstd`
 * （zstd 帧拼接，解出来是 JSONL）。⇒ 要看"大脑这格说了什么"，只能读它。
 *
 * ## 实测（2026-10-11 · 样本＝本会话真转录 6.5MB / 7192 行 / 事件类型 20 种）
 * 统一外壳：`{ type, seq, time, data, surfaceOp? }`，`time` 是毫秒时间戳。
 * 各类型的 `data` 形状（照样本写，不猜）：
 *   · `user/message`      `{ content:[{type:'text',text}], source:{kind,rpcId}, role:'user', id }`
 *   · `assistant/message` `{ turn, step, message:{ role:'assistant', content:[
 *                            {type:'reasoning',text} | {type:'text',text} | {type:'tool-call',id,name,arguments} ] } }`
 *   · `tool/result`       `{ turn, step, message:{ role:'tool', toolCallId, content:[{type:'text',text}] } }`
 *   · `turn/start|end`    `{ turn }` / `{ turn, reason:{kind} }`
 *   · `model/selection`   `{ provider, model }`
 *   · `command/run|done`  `{ commandId, name, args }` / `{ commandId, kind, text }`
 *   · `compaction/start|summary|end` `{ compactionId, summary:[{type:'text',text}] }`
 *   · `assistant/attempt` `{ stream:[{ chunk:{ type:'finish', reason:{kind:'error', failure:{message}} } }] }`
 *
 * ## 三条"故意不显示"（免得一屏糊死、也免得双计）
 *   1. **`tool/call` 不显示** —— 它和上一条 `assistant/message` 里的 `tool-call` **是同一个调用**
 *      （实测：`assistant/message` seq 6590 带 `tool-call`，紧接着 `tool/call` seq 6591 同 `callId`）⇒ 显示会双计。
 *   2. **`agent/inbox/spliced` 不显示** —— 它插进去的那条**随后会作为 `user/message` 出现**（实测同 id）⇒ 同样双计。
 *   3. **提示词不算对话** —— `system/message` / `developer/message` / `request/header` / `request/context`
 *      是每轮注入的提示词与请求元数据（`request/header` 里带着整份工具清单，几万字）⇒ 跳过。
 *      这与 `carriers\pi.mjs` 跳过 `role:'system'` 是同一条纪律。
 *   4. **`user/message` 里"注入的上下文"也不显示**（2026-10-11 用户拍板，见下面 `user/message` 那段的注释）：
 *      只有 `source.kind === 'user'` 才算"你说的话"；`agent-instructions`／`runtime-context`／`skill-catalog`
 *      打成 `kind:'inject'` **留在载荷里**（不丢证据），但**界面不画**（原来它们被当「👤 用户」平铺，
 *      用户原话："把全拼在一起了、根本不像 DSH 的会话框"）。
 *
 * ## 纪律
 *   · 认不出的行/类型**跳过、绝不抛错**（展示层；判定不靠这里）
 *   · 正在写的文件**末行必然半截**（物理必然）⇒ 逐行 parse ＋ try/catch（`eachJsonLine` 已具备）
 *   · 只读文本、不落任何新格式
 */
import { cut, eachJsonLine, tsOf, argLine } from './session.mjs'

/** `content:[{type:'text',text}]` → 一段纯文本（别的块类型忽略）。 */
function textOf (content) {
  if (!Array.isArray(content)) return ''
  return content.filter((c) => c && c.type === 'text' && c.text).map((c) => String(c.text)).join('\n')
}
/** `arguments` 实测是**字符串**（JSON 文本）⇒ 解析失败就当字符串用，别抛。 */
function argsOf (raw) {
  if (raw == null) return ''
  if (typeof raw === 'object') return argLine(raw)
  try { return argLine(JSON.parse(String(raw))) } catch { return cut(String(raw), 300) }
}
/** `finish` 块里是不是"失败"（用来把 401 这类如实显示出来）。 */
function failureOf (attempt) {
  const stream = Array.isArray(attempt?.stream) ? attempt.stream : []
  for (const s of stream) {
    const c = s?.chunk
    if (c?.type === 'finish' && c.reason?.kind === 'error') {
      const f = c.reason.failure ?? {}
      return String(f.message ?? c.reason.kind).slice(0, 300)
    }
  }
  return null
}

export function toConversation (text) {
  const out = []
  eachJsonLine(text, (j) => {
    const ts = tsOf(j.time)
    const d = j.data ?? {}
    switch (String(j.type ?? '')) {
      case 'user/message': {
        const t = textOf(d.content)
        if (!t.trim()) return
        // ★ 2026-10-11（用户报障："这个会话框根本不像 DSH 的，**把全拼在一起了**"）：
        //   `user/message` 的 `source.kind` **不止 `user`** —— 实测四种（2026-10-11 真转录，异次元那条会话）：
        //     · `user`               你真正说的那句话（带 rpcId / clientTimeZone）
        //     · `agent-instructions` 工作区指令（AGENTS.md，**注入**）
        //     · `runtime-context`    运行时快照（沙箱/审批策略，**注入**）
        //     · `skill-catalog`      技能清单（**几万字**，注入）
        //   后三种是**注入的上下文**，DSH 自己的会话框不把它们当"你说的话"。
        //   handoff 里"提示词与请求元数据故意不显示"藏掉的是 `request/header`（几万字工具清单）那条路 ——
        //   **同一性质的东西从这条路漏进来了**（原来只贴了个 `（来源：xx）` 标签，照样冒充用户消息）。
        //   用户 2026-10-11 拍板：**彻底不显示**。⇒ 打成 `kind:'inject'` 留在载荷里（接口不丢证据），
        //   **由前端跳过不画**（`页面.js` 的 `pushSessEntries`）。
        const src = String(d.source?.kind ?? 'user')
        if (src !== 'user') {
          out.push({ role: 'system', kind: 'inject', injectKind: src, text: cut(t), ts })
          return
        }
        out.push({ role: 'user', kind: 'text', text: cut(t), ts })
        return
      }
      case 'assistant/message': {
        const content = d.message?.content
        if (!Array.isArray(content)) return
        for (const c of content) {
          if (!c || typeof c !== 'object') continue
          if (c.type === 'reasoning' && c.text) out.push({ role: 'assistant', kind: 'thinking', text: cut(c.text), ts })
          else if (c.type === 'text' && c.text) out.push({ role: 'assistant', kind: 'text', text: cut(c.text), ts })
          else if (c.type === 'tool-call') out.push({ role: 'assistant', kind: 'tool_use', tool: String(c.name ?? '工具'), input: argsOf(c.arguments), ts })
        }
        return
      }
      case 'tool/result': {
        const t = textOf(d.message?.content)
        if (!t.trim()) return
        out.push({ role: 'assistant', kind: 'tool_result', text: cut(t, 1200), ts })
        return
      }
      case 'turn/start':
        out.push({ role: 'assistant', kind: 'status', text: '第 ' + String(d.turn ?? '?') + ' 轮开始', ts })
        return
      case 'turn/end': {
        const why = d.reason?.kind ? '（' + String(d.reason.kind) + '）' : ''
        out.push({ role: 'assistant', kind: 'status', text: '第 ' + String(d.turn ?? '?') + ' 轮结束' + why, ts })
        return
      }
      case 'model/selection':
        out.push({ role: 'assistant', kind: 'status', text: '模型 → ' + String(d.provider ?? '?') + '/' + String(d.model ?? '?'), ts })
        return
      case 'command/run':
        out.push({ role: 'assistant', kind: 'status', text: '命令 /' + String(d.name ?? '?') + (d.args ? ' ' + String(d.args) : ''), ts })
        return
      case 'command/done':
        out.push({
          role: 'assistant', kind: d.kind === 'success' ? 'status' : 'error', ts,
          text: '命令结果' + (d.kind ? '（' + String(d.kind) + '）' : '') + '：' + String(d.text ?? '').slice(0, 300)
        })
        return
      case 'compaction/summary':
        out.push({ role: 'assistant', kind: 'status', text: '上下文压缩摘要（' + textOf(d.summary).length + ' 字）', ts })
        out.push({ role: 'assistant', kind: 'thinking', text: cut(textOf(d.summary)), ts })
        return
      case 'compaction/end':
        out.push({ role: 'assistant', kind: 'status', text: '上下文压缩完成', ts })
        return
      case 'assistant/attempt': {
        const fail = failureOf(d)
        if (fail) out.push({ role: 'assistant', kind: 'error', text: '这一轮请求失败：' + fail, ts })
        return
      }
      // 故意不显示（理由见文件头三条）：tool/call · agent/inbox/spliced · system/message ·
      //   developer/message · request/header · request/context · step/start · step/end ·
      //   workspace/changes · todo/write · compaction/start
      default:
        return
    }
  })
  return out
}

/** 这个类型值不值得显示（给探针/界面做"跳过清单"用，与上面的 switch 保持一致）。 */
export const HIDDEN_TYPES = [
  'tool/call', 'agent/inbox/spliced', 'system/message', 'developer/message',
  'request/header', 'request/context', 'step/start', 'step/end',
  'workspace/changes', 'todo/write', 'compaction/start'
]
