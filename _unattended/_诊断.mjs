/**
 * 诊断（施工文档 20261024 §4/§5）—— 证据包 ＋ 对账 ＋ 归因阶梯。
 *
 * 这是纯函数库：**不读项目、不调模型、不写文件**。所有输入由调用方（`编排.mjs`）递进来。
 * 为什么单独一份：对账要能被夹具单测（零 token），而且它必须"只看证据、不看嘴"。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 冻结的接口契约（2026-10-23，两边并行施工时以此为准 —— 改它要先改 §8 契约）
 * ══════════════════════════════════════════════════════════════════════════════
 * 证据包（`buildEvidence` 的返回）：
 *   { card, role, attempt,
 *     ac: { cmd, exit, stdoutTail, stderrTail, assertions: [{ name, ok, detail }] },
 *     diff: { added, changed, removed, files: [] } | null,
 *     env: { cwd, os, node, python },
 *     selfTest: { ranIt, cmdSame, selfExit },
 *     history: [] }
 *
 * 对账结果（`reconcile` 的返回）：
 *   { kind: 'real-fail'|'derelict'|'conflict'|'misreport'|'unknown',
 *     why: '一句人话', detail: { ranSame, cmdSame, selfExit, claimExit, carrier, weak } }
 *
 * 收据里新增字段（`工量账本.mjs` / `编排.mjs` 写）：
 *   reconcile / reworkCount / rework:[{task,noDelta,at}] / selfHeal:{red,healed} / deferredJudges:[]
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 判序（写死，防重叠 —— 见施工文档 §4.3）
 *   ① 先看"跑没跑卡里那条命令" → 没跑 = derelict
 *   ② 跑了再看"它自己那条的退出码" → 红 = real-fail
 *   ③ 它报绿而机器红 = conflict
 *   ④ 它自己红/报错却说"已通过" = misreport
 * ══════════════════════════════════════════════════════════════════════════════
 */

import { readFileSync, existsSync } from 'node:fs'
import { signatureOf } from './_失败处置.mjs'

/** 只留最后 n 行（证据包要小；整段 stdout 动辄几 MB）。 */
export function tailOf (text, lines = 40, maxChars = 4000) {
  const s = String(text ?? '')
  if (!s) return ''
  const arr = s.split(/\r?\n/)
  const t = arr.slice(Math.max(0, arr.length - lines)).join('\n')
  return t.length > maxChars ? t.slice(-maxChars) : t
}

/** 命令规范化：去反引号/引号、反斜杠转正斜杠、压空白、小写。 */
export function normalizeCmd (s) {
  return String(s ?? '')
    .replace(/[`"']/g, '')
    .replace(/\\/g, '/')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/** 两条命令是不是"同一条"（宽松：一方包含另一方即可；用于"它跑的是不是卡里那条"）。 */
export function sameCommand (a, b) {
  const x = normalizeCmd(a)
  const y = normalizeCmd(b)
  if (!x || !y) return false
  if (x === y) return true
  // 取"去掉公共前缀参数后的主体"再做包含判断（`python tests/x.py` vs `cd .; python tests/x.py`）
  return x.includes(y) || y.includes(x)
}

/** 解析 AC 输出里的 `ASSERT <名字> OK|FAIL <期望>|<实际>`（认不出就空数组，**不猜**）。 */
export function parseAssertions (text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*ASSERT\s+(\S+)\s+(OK|FAIL)\b\s*(.*)$/i.exec(line)
    if (!m) continue
    out.push({ name: m[1], ok: m[2].toUpperCase() === 'OK', detail: m[3].trim() })
  }
  return out
}

/** 解析回执里的 `ran: {json}`（一行一个）—— 这是**它的自我陈述**，只用于对账，不当证据。 */
export function parseRan (text) {
  const out = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*ran:\s*(\{.*\})\s*$/.exec(line)
    if (!m) continue
    try {
      const j = JSON.parse(m[1])
      if (j && typeof j.cmd === 'string') out.push({ cmd: j.cmd, exit: Number.isFinite(j.exit) ? j.exit : null })
    } catch { /* 解析不了就不算（不猜） */ }
  }
  return out
}

function unescapeJs (s) {
  return String(s ?? '').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
}

/**
 * 从载体输出里抽"它自己跑过什么、退出码多少"。
 * 三档能力（实测，见施工文档 §4.3「载体能力档」）：
 *   pi       —— `tool_execution_start/end` 配对，`structuredContent.exit_code` **有退出码**
 *   opencode —— `tool_use.part`：只有 status/metadata.error，命令包在 JS 里 ⇒ **弱档**（exit=null）
 *   codebuddy / 其它 —— `message.content[].tool_use`：**弱档**
 * @returns {Array<{cmd:string, exit:number|null, errored:boolean|null, carrier:string}>}
 */
export function selfTestsOf (textOrPath) {
  let text = String(textOrPath ?? '')
  if (textOrPath && typeof textOrPath === 'string' && existsSync(textOrPath)) {
    try { text = readFileSync(textOrPath, 'utf8') } catch { return [] }
  }
  if (!text.trim()) return []

  const out = []
  const lines = text.split(/\r?\n/)

  // ── pi
  if (text.includes('tool_execution_start')) {
    const cmds = new Map()
    for (const line of lines) {
      if (!line.includes('"tool_execution_start"') && !line.includes('"tool_execution_end"')) continue
      let j
      try { j = JSON.parse(line) } catch { continue }
      if (j.type === 'tool_execution_start') {
        const cmd = j?.args?.command
        if (typeof cmd === 'string') cmds.set(j.toolCallId, cmd)
        continue
      }
      if (j.type === 'tool_execution_end') {
        const cmd = cmds.get(j.toolCallId)
        if (!cmd) continue
        const sc = j?.result?.structuredContent
        let exit = Number.isFinite(sc?.exit_code) ? sc.exit_code : null
        if (exit === null) {
          const txt = (j?.result?.content ?? []).map((c) => c?.text ?? '').join('\n')
          const m = /exited with code (\d+)/i.exec(txt)
          if (m) exit = Number(m[1])
        }
        out.push({ cmd, exit, errored: exit === null ? null : exit !== 0, carrier: 'pi' })
      }
    }
    return out
  }

  // ── opencode
  if (text.includes('"tool_use"')) {
    for (const line of lines) {
      if (!line.includes('"tool_use"')) continue
      let j
      try { j = JSON.parse(line) } catch { continue }
      const part = j.part ?? null
      const state = part?.state ?? null
      const code = state?.input?.code ?? null
      if (typeof code === 'string') {
        const m = /command\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(code)
        const cmd = m ? unescapeJs(m[1]) : null
        if (!cmd) continue
        const errored = state?.status === 'error' || state?.metadata?.metadata?.error === true
        out.push({ cmd, exit: null, errored, carrier: 'opencode' })
        continue
      }
      // ── codebuddy / claude 风格
      const content = j?.message?.content
      if (Array.isArray(content)) {
        for (const c of content) {
          if (!c || (c.type !== 'tool_use' && c.type !== 'toolCall')) continue
          const cmd = c?.input?.command
          if (typeof cmd === 'string') out.push({ cmd, exit: null, errored: null, carrier: 'codebuddy' })
        }
      }
    }
  }
  return out
}

/**
 * 对账：把"AC 红"拆成四件事（见文件头判序）。
 * @param {object} o
 * @param {string} o.acCmd   卡里那条验收命令
 * @param {number|null} o.acExit 机器跑的退出码（红：非 0）
 * @param {Array} o.selfTests `selfTestsOf()` 的结果
 * @param {Array} o.claims   `parseRan(回执)` 的结果
 */
export function reconcile ({ acCmd, acExit, selfTests = [], claims = [] }) {
  const acRed = acExit !== 0 && acExit !== null && acExit !== undefined
  if (!acRed) return { kind: 'unknown', why: 'AC 没红（不该走对账）', detail: { acExit } }

  const same = selfTests.filter((t) => sameCommand(t.cmd, acCmd))
  const claimSame = claims.filter((c) => sameCommand(c.cmd, acCmd))
  const claimGreen = claimSame.find((c) => c.exit === 0) ?? null
  const claimRed = claimSame.find((c) => c.exit !== null && c.exit !== 0) ?? null
  const carrier = selfTests[0]?.carrier ?? null
  const weak = same.length > 0 && same.every((t) => t.exit === null)

  // ① 有工具证据、且跑的就是卡里那条
  if (same.length) {
    if (weak) {
      const err = same.find((t) => t.errored === true)
      if (err) {
        if (claimGreen) return { kind: 'misreport', why: `它报错（${carrier} 弱档），回执却写已通过`, detail: { carrier, weak } }
        return { kind: 'real-fail', why: `它自己跑过同一条并且报错（${carrier} 弱档，无退出码）`, detail: { carrier, weak } }
      }
      if (same.every((t) => t.errored === false)) return { kind: 'conflict', why: `它跑同一条自认为成功（${carrier} 弱档，无退出码），机器红`, detail: { carrier, weak } }
      return { kind: 'unknown', why: `${carrier} 拿不到退出码，判不出是红是绿`, detail: { carrier, weak } }
    }
    const red = same.find((t) => t.exit !== 0)
    if (red) {
      if (claimGreen && claimGreen.exit === 0 && red.exit !== 0) {
        return { kind: 'misreport', why: `它自己跑出 ${red.exit}，回执里的 ran 却写 0`, detail: { selfExit: red.exit, claimExit: claimGreen.exit, carrier } }
      }
      return { kind: 'real-fail', why: `它自己跑同一条也是红的（exit ${red.exit}）`, detail: { selfExit: red.exit, carrier } }
    }
    const green = same.find((t) => t.exit === 0)
    if (green) return { kind: 'conflict', why: '它自己跑同一条是绿的，机器跑却红（假绿 / 环境差异 / 交付物不同步）', detail: { selfExit: 0, carrier } }
    return { kind: 'unknown', why: '有工具证据但读不出退出码', detail: { carrier } }
  }

  // ② 没有工具证据：只认它自己的登记（弱证据）
  if (claimRed) return { kind: 'real-fail', why: `回执里登记跑了同一条且失败（exit ${claimRed.exit}），但没有工具证据`, detail: { claimExit: claimRed.exit, carrier } }
  if (claimGreen) return { kind: 'conflict', why: '回执里登记跑了同一条且成功，机器红（无工具证据，需审核核）', detail: { claimExit: 0, carrier } }
  return { kind: 'derelict', why: '没跑卡里那条命令（或跑的是别的）', detail: { carrier } }
}

/** 证据包（固定结构，零 token —— 全是已有文件的摘录）。 */
export function buildEvidence ({ card, role, attempt = 1, acCmd, acExit, stdout = '', stderr = '', diff = null, cwd = null, history = [], selfTests = [], claims = [] }) {
  const selfSame = selfTests.filter((t) => sameCommand(t.cmd, acCmd))
  const selfExit = selfSame.find((t) => t.exit !== null && t.exit !== undefined)?.exit ?? null
  return {
    card: card ?? null,
    role: role ?? null,
    attempt,
    ac: {
      cmd: acCmd ?? null,
      exit: acExit ?? null,
      stdoutTail: tailOf(stdout),
      stderrTail: tailOf(stderr),
      assertions: parseAssertions(`${stdout}\n${stderr}`)
    },
    diff: diff ?? null,
    env: {
      cwd: cwd ?? null,
      os: process.platform,
      node: process.version,
      python: process.env.PYTHON_VERSION ?? null
    },
    selfTest: {
      ranIt: selfSame.length > 0,
      cmdSame: selfSame.length > 0,
      selfExit
    },
    history: Array.isArray(history) ? history.slice(-10) : []
  }
}

/**
 * 归因阶梯的前两级（第 2 级"诊断卡"要花 token，由调用方决定，不在这个纯函数里）。
 *   0 级：症状库命中 ⇒ 直接给类型
 *   1 级：没命中 ⇒ 证据包已备好，需要诊断
 */
export function attribute ({ stderr = '', stdout = '' } = {}) {
  const hay = `${stderr}\n${stdout}`
  const sig = signatureOf(hay)
  if (sig) return { level: 0, hit: sig.id, kind: sig.kind, zh: sig.zh, needsDiagnose: false }
  return { level: 1, hit: null, kind: 'unknown', zh: '症状库没命中', needsDiagnose: true }
}
