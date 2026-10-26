/**
 * 会话翻译器 · **CodeWhale**（`exec --auto --output-format stream-json`：**JSONL**，exec-stream 族）
 *
 * 实测样本：`_probe\upgrade-check\codewhale-stream.jsonl`（2026-10-09 真跑）
 *   · `content`（正文）· `turn_usage`（机制步，跳过）· `session_capture`（`saved_session_id`，续跑用）
 *   · `metadata`（`receipt_kind=terminal`：输入/输出 token）· `done`
 * ⚠️ 本家**无思考块、无工具事件样本**（实测只有上面这几类）⇒ 会话里主要是"正文 + 机制行"。
 * ★★ 2026-10-13（b72）**真跑坐实（两次）**：`codewhale exec --output-format stream-json` 的
 *   事件表**逐字就这五类** —— `content@codewhale.exec-stream` · `turn_usage` · `session_capture` ·
 *   `metadata` · `done`；**顶层键里没有任何能装思考正文的字段**（只有 `reasoning_tokens` **计数**）。
 *   两次样本：`deepseek-v4.1-flash`（reasoning_tokens=0）／`deepseek-v4-pro`（同样 0）。
 *   ⇒ **"思考正文"这家拿不到**（"形态不存在"，不是缺接线）。
 *   取证脚本：`_probe\_codewhale实测.mjs`（**手动跑、要花钱**；钥匙走子进程环境、**不写任何配置**）。
 */
// ★ b123：工具改从**叶子** `_工具.mjs` 取（原来指向 `../session.mjs` ⇒ 动态发现时会形成死锁环）
import { cut, eachJsonLine, tsOf } from '../_工具.mjs'

export function toConversation (text) {
  const out = []
  eachJsonLine(text, (j) => {
    const ts = tsOf(j.timestamp ?? j.__timestamp)
    if (j.type === 'content' && j.content) { out.push({ role: 'assistant', kind: 'text', text: cut(j.content), ts }); return }
    if (j.type === 'session_capture' && j.saved_session_id) { out.push({ role: 'assistant', kind: 'status', text: '会话已存 ' + shortId(j.saved_session_id), ts }); return }
    if (j.type === 'metadata') {
      const m = j.meta || {}
      if (m.receipt_kind === 'terminal') out.push({ role: 'assistant', kind: 'status', text: '结束 · 输入 ' + (m.input_tokens ?? '?') + ' / 输出 ' + (m.output_tokens ?? '?'), ts })
      return
    }
  // ★ b54（用户"没有限流"纠正了我）：那串"收工/开工"其实是 **Pi 的自动重试** —— out.json 原文：
  //   {"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,
  //    "errorMessage":"429: {"type":"server_error","message":"Upstream request failed: Endpoint is unavailable."}"}
  //   ⇒ 不是我们被限流，是**那家自己报"上游不可用"**；重试后多数成功（auto_retry_end success:true）⇒ 任务照常推进。
  //   光秃秃的"收工/开工"会让人以为任务在重启 ⇒ **把重试连原因一起亮出来**。
  if (j.type === 'auto_retry_start') { out.push({ role: 'assistant', kind: 'status', text: '⚠️ 自动重试 ' + (j.attempt ?? '?') + '/' + (j.maxAttempts ?? '?') + '（' + String(j.errorMessage ?? '').slice(0, 70) + '）', ts }); return }
  if (j.type === 'auto_retry_end') { out.push({ role: 'assistant', kind: 'status', text: (j.success ? '重试成功' : '⚠️ 重试仍失败') + '（第 ' + (j.attempt ?? '?') + ' 次）', ts }); return }    if (j.type === 'done') out.push({ role: 'assistant', kind: 'status', text: '收工', ts })
  })
  return out
}

function shortId (x) { const s = String(x ?? ''); return s.length > 12 ? s.slice(0, 12) + '…' : s }
