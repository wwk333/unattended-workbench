#!/usr/bin/env node
/**
 * 换会话的**收尾核验**（b90）—— 三件事实的**单一实现**
 *
 * ## 为什么要有它（真跑实测，不是推演）
 * 2026-10-16 在异次元工作区真换了一次会话，结果：
 *   · 收尾指令**投递成功**（旧会话转录里 `agent/inbox/spliced`，`rpcId: swap-…`）；
 *   · turn 起了，**15 毫秒后**被宿主判 `turn/end{reason:{kind:'blocked'}}`，指令被丢回空；
 *   · 而换会话脚本当时只会打印 **"✓ 旧会话已停（等了 5s）"** —— **看着像成功**。
 * 根因（DSH 源码，`app.asar` 内）：`dsh-api-session-controller` 注册了
 *   `agent/pre-step → underArchivedSession(ctx, agent) ? {kind:'reject'} : next()`，
 * 而 `dsh-agent-loop` 遇 `reject` 就把这一轮判成 `blocked` ⇒ **归档会话连唤醒都被挡**。
 * 那具旧会话确实在 `~\.dsh\storages\workspace.json` 的 `archivedSessionIds` 里。
 *
 * ⇒ 所以"收尾"这件事**不能靠脚本自己嘴说**，必须机器核三件事：
 *   ① 这具会话**是不是归档**（归档 ⇒ 收尾必然落空，换之前就该拦住）；
 *   ② 收到指令后**转录有没有新事件**（一点动静都没有 ⇒ 它压根没跑）；
 *   ③ 有动静的话，是**真收尾**（goal 不再 active / `进度.md` 被写）还是**被 blocked**。
 *
 * ## 用法（换新会话.mjs 调它；探针也直接测它）
 *   const a = readArchivedSessionIds()            // → Set<sessionId>
 *   const f = transcriptOf(sessionId)             // → 转录文件绝对路径 | null
 *   const v = wrapVerdict({ text, goalPhase, progressMtimeMs, sendAt, waitedSec })
 *   //   v = { ok, level:'ok'|'warn'|'error', why, facts:{ran,blocked,replied,goalChanged,progressTouched} }
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DSH_HOME = () => process.env.DSH_HOME || join(homedir(), '.dsh')

/**
 * 归档会话名单（`~\.dsh\storages\workspace.json` 的 `archivedSessionIds`）。
 * ⚠️ 读不到就返回 `null`（**不是空集**）—— 调用方要如实说"没能核对"，别把"读不到"当成"没归档"。
 */
export function readArchivedSessionIds (opts = {}) {
  const file = opts.workspaceFile ?? join(opts.dshHome ?? DSH_HOME(), 'storages', 'workspace.json')
  let j = null
  try { j = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
  const found = findArray(j, 'archivedSessionIds')
  return found ? new Set(found.map(String)) : null
}

/** 递归找第一个叫 `key` 的数组（`workspace.json` 是嵌套结构，别写死路径）。 */
function findArray (o, key) {
  if (!o || typeof o !== 'object') return null
  if (Array.isArray(o[key])) return o[key]
  for (const v of Object.values(o)) { const r = findArray(v, key); if (r) return r }
  return null
}

/** 会话 id → 它的转录文件（`~\.dsh\sessions\<cwd 编码>\<sessionId>\session.v4.jsonl.zstd`）。 */
export function transcriptOf (sessionId, opts = {}) {
  if (!sessionId) return null
  const root = opts.sessionsRoot ?? join(opts.dshHome ?? DSH_HOME(), 'sessions')
  const cands = ['session.v4.jsonl.zstd', 'session.jsonl', 'session.v4.jsonl']
  let dirs = []
  try { dirs = readdirSync(root) } catch { return null }
  for (const d of dirs) {
    const dir = join(root, d, sessionId)
    if (!existsSync(dir)) continue
    for (const c of cands) { const p = join(dir, c); try { if (statSync(p).isFile()) return p } catch {} }
    return null
  }
  return null
}

/** 转录文件里"这条时间点之后"的事件（`text` 是 `readTranscriptTail` 解出来的 JSONL）。 */
export function eventsAfter (text, sinceMs) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue
    let e = null
    try { e = JSON.parse(line) } catch { continue }
    if (Number(e?.time ?? 0) >= Number(sinceMs)) out.push(e)
  }
  return out
}

/**
 * 判据（**唯一实现**）：
 *   · `ran`            ＝ 收到指令后转录有新事件（它真的开始干了）
 *   · `blocked`        ＝ 其中出现 `turn/end{reason.kind:'blocked'}`（宿主拒绝执行 ⇒ 归档会话的典型形态）
 *   · `replied`        ＝ 出现 `assistant/message`（它真回了话）
 *   · `goalChanged`    ＝ goal 不再是 `active`
 *   · `progressTouched`＝ `进度.md` 在发指令之后被写过
 * `ok` 的判据：**跑过 且（goal 变了 或 断点写了）**；其余按严重度出声：
 *   · 一点没跑 / 被 blocked ⇒ `level:'error'`（收尾**根本没发生**）
 *   · 跑了但没有收尾痕迹   ⇒ `level:'warn'`（跑了，但没照"收尾四件事"做）
 */
export function wrapVerdict ({ text = '', goalPhase = null, progressMtimeMs = null, sendAt = 0, waitedSec = null } = {}) {
  const evs = eventsAfter(text, sendAt)
  const ran = evs.length > 0
  const blocked = evs.some((e) => e?.type === 'turn/end' && e?.data?.reason?.kind === 'blocked')
  const replied = evs.some((e) => e?.type === 'assistant/message')
  const goalChanged = goalPhase != null && String(goalPhase) !== 'active'
  const progressTouched = Number(progressMtimeMs ?? 0) > Number(sendAt)
  const facts = { ran, blocked, replied, goalPhase: goalPhase ?? null, goalChanged, progressTouched, events: evs.length }
  const waited = waitedSec != null ? `（等了 ${waitedSec}s）` : ''

  if (!ran && !blocked) {
    return { ok: false, level: 'error', facts, why: `旧会话在收到收尾指令后**一点动静都没有**${waited}：转录里没有任何新事件 ⇒ 收尾**根本没发生**（多半已被归档/休眠，或它压根没被叫醒）` }
  }
  if (blocked) {
    return { ok: false, level: 'error', facts, why: `宿主把旧会话的这一轮判成 **blocked**${waited} ⇒ 收尾指令被丢弃（归档会话会被这样挡：DSH 的 \`agent/pre-step\` 对归档会话直接 reject）` }
  }
  if (!goalChanged && !progressTouched) {
    return { ok: false, level: 'warn', facts, why: `旧会话跑了一轮（${evs.length} 个事件${replied ? '、有回复' : '、没看到回复'}），但**没有收尾痕迹**：goal 仍是 active、\`进度.md\` 没被写 ⇒ 新会话会读到旧断点` }
  }
  return { ok: true, level: 'ok', facts, why: `旧会话收了尾（${goalChanged ? `goal → ${goalPhase}` : ''}${goalChanged && progressTouched ? '，' : ''}${progressTouched ? '写了进度.md' : ''}${replied ? '，有回复' : ''}）` }
}
