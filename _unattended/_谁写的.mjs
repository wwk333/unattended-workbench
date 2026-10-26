/**
 * "这个文件**是谁写的**" —— 铁证认领（施工文档 D22，补 20261022 D11）。
 *
 * 为什么重写（2026-10-23 实测）：
 *   老做法是**文本子串匹配**：把 `out.json` 尾部 400KB 读成字符串，`includes(路径) || includes(basename)`。
 *   可是那个文件里有一条 **203,738 字符的 `agent_end`**（整段对话 + 系统提示 + 所有工具调用都在里面），
 *   系统提示里就写着 "editing code, and **writing** new files" ⇒ **任何**提到过文件名的卡都会被算成"它写的"。
 *   回放昨天 10 条越界：老做法认领 4 条；按"写类工具调用"只有 1 条（审核员改它本职的文件）。
 *   最刺眼的一条：`策划方案.md` 被判给 T1-01，而 T1-01 那 **13 次工具调用里一次都没提这个文件**。
 *
 * 现在的判据只有一条：**载体事件流里"写"的那一次调用，参数里带的路径**。
 *   · 只认**写类**工具（write / edit / apply_patch / 带重定向的 shell）；`read`/`grep`/`ls` 不算；
 *   · 三家格式不同，各写一套解析（pi / codebuddy / opencode），**不认识就返回空集**（＝认不出，不是"没关系"）；
 *   · opencode 把动作写成一段 JS 代码（`await tools.write({path})`），从代码里抠；抠不出就宁可认不出。
 *
 * ⚠️ 纪律：这个模块**只回答"有没有铁证"**。认不出时调用方必须落到 `unknown`，**不许**回头去猜。
 */
import { existsSync, readFileSync } from 'node:fs'

/** 写类工具名（大小写不敏感）。 */
const WRITE_TOOL = /^(write|writefile|write_file|edit|multiedit|multi_edit|apply_patch|patch|str_replace|strreplace|create_file|createfile|notebookedit|notebook_edit)$/i
/** shell 类工具名（它们的"写"藏在命令文本里）。 */
const SHELL_TOOL = /^(bash|shell|run_command|runcommand|exec|execute|powershell|pwsh|cmd|terminal|process)$/i
/** 参数里"目标文件"可能叫什么。 */
const PATH_KEY = /^(path|file_path|filepath|file|filename|target|target_file|targetfile|paths|file_paths)$/i

/** 归一：斜杠、去项目前缀、去 ./、小写（Windows 大小写不敏感）。 */
export function normPath (p, project = null) {
  let s = String(p ?? '').trim().replace(/^["']|["']$/g, '').replace(/\\/g, '/')
  if (!s) return ''
  if (project) {
    const base = String(project).replace(/\\/g, '/').replace(/\/+$/, '')
    const i = s.toLowerCase().indexOf(base.toLowerCase())
    if (i === 0) s = s.slice(base.length)
  }
  return s.replace(/^\.\//, '').replace(/^\/+/, '').toLowerCase()
}

/** 从一段 shell 命令里抠"被写到"的路径。 */
export function pathsWrittenByShell (cmd) {
  const out = []
  const s = String(cmd ?? '')
  if (!s) return out
  // 重定向（> / >>），含 `2>` 这种 fd 前缀；排除 `>&1`、`>/dev/null`
  for (const m of s.matchAll(/(?:^|[^0-9&])\d?>>?\s*("([^"]+)"|'([^']+)'|([^\s|;&<>()]+))/g)) {
    const p = m[2] ?? m[3] ?? m[4]
    if (p && !/^(&\d|\/dev\/null|nul)$/i.test(p)) out.push(p)
  }
  // tee / Set-Content / Add-Content / Out-File
  for (const m of s.matchAll(/\b(?:tee|Set-Content|Add-Content|Out-File)\b(?:\s+-\w+)*\s+("([^"]+)"|'([^']+)'|([^\s|;&<>()]+))/gi)) {
    const p = m[2] ?? m[3] ?? m[4]
    if (p) out.push(p)
  }
  // python / node 里显式 open(..., 'w')
  for (const m of s.matchAll(/open\(\s*["']([^"']+)["']\s*,\s*["'][wa]/g)) out.push(m[1])
  // fs.writeFileSync('x')
  for (const m of s.matchAll(/writeFileSync\(\s*["']([^"']+)["']/g)) out.push(m[1])
  return out
}

/** 一次工具调用 → 它写了哪些文件（`isWrite` 为假表示这不是写）。 */
export function writesOf (name, args) {
  const n = String(name ?? '')
  const paths = []
  let isWrite = WRITE_TOOL.test(n)
  if (args && typeof args === 'object') {
    for (const [k, v] of Object.entries(args)) {
      if (!PATH_KEY.test(k)) continue
      if (typeof v === 'string' && v.trim()) paths.push(v)
      else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string' && x.trim()) paths.push(x)
    }
  }
  if (SHELL_TOOL.test(n)) {
    const cmd = args?.command ?? args?.cmd ?? args?.script ?? args?.code ?? ''
    const w = pathsWrittenByShell(cmd)
    if (w.length) { isWrite = true; paths.push(...w) }
  }
  return { isWrite, paths }
}

/** opencode 那种"动作写在一段代码里"的：从 code 里抠 `tools.write({path})` / shell 重定向。 */
function writesFromCode (code) {
  const paths = []
  const s = String(code ?? '')
  if (!s) return paths
  for (const m of s.matchAll(/(?:tools\.)?(?:write|writeFile|edit|patch|create)\s*\(\s*\{[^}]*?(?:file_?path|path)\s*:\s*["'`]([^"'`]+)["'`]/gi)) paths.push(m[1])
  for (const m of s.matchAll(/tools\.(?:shell|bash|exec)\s*\(\s*\{[^}]*?command\s*:\s*["'`]([^"'`]+)["'`]/gi)) {
    paths.push(...pathsWrittenByShell(m[1].replace(/\\n/g, '\n')))
  }
  return paths
}

function safeJson (s) { try { return JSON.parse(s) } catch { return null } }

/**
 * 读一份载体产出，返回**它写过的路径集合**。
 * @returns {{ ok:boolean, set:Set<string>, claims:Map<string,{tool:string,at:number|null}>, calls:number, formats:string[], bytes:number }}
 *   `ok:false` = 这份文件读不到 / 一行都解析不了（调用方必须当"认不出"处理）。
 */
export function writtenBy (file, { project = null, maxBytes = 8 << 20 } = {}) {
  const res = { ok: false, set: new Set(), claims: new Map(), calls: 0, formats: [], bytes: 0 }
  if (!file || !existsSync(file)) return res
  let txt = ''
  try {
    const b = readFileSync(file)
    res.bytes = b.length
    // 整份读（越界的判定不能只看尾巴：早期写过、后面才被快照的，尾巴里就没有了）
    txt = b.subarray(Math.max(0, b.length - maxBytes)).toString('utf8')
  } catch { return res }

  const add = (p, tool, at) => {
    const k = normPath(p, project)
    if (!k) return
    res.set.add(k)
    if (!res.claims.has(k)) res.claims.set(k, { tool: String(tool ?? '?'), at: at ?? null })
  }

  for (const line of txt.split(/\r?\n/)) {
    const t = line.trim()
    if (!t.startsWith('{')) continue
    const j = safeJson(t)
    if (!j) continue

    // ① pi：tool_execution_start { toolName, args }
    if (j.type === 'tool_execution_start') {
      res.calls++
      if (!res.formats.includes('pi')) res.formats.push('pi')
      const w = writesOf(j.toolName ?? j.name, j.args ?? j.arguments)
      if (w.isWrite) for (const p of w.paths) add(p, j.toolName ?? j.name)
      continue
    }

    // ② opencode：tool_use.part.{ tool, state.input.{code,input} }
    if (j.type === 'tool_use' && j.part) {
      res.calls++
      if (!res.formats.includes('opencode')) res.formats.push('opencode')
      const tool = j.part.tool ?? j.part.name
      const input = j.part.state?.input ?? j.part.input ?? {}
      const fromCode = writesFromCode(input.code ?? input.script ?? '')
      if (fromCode.length) { for (const p of fromCode) add(p, tool); continue }
      const w = writesOf(tool, input)
      if (w.isWrite) for (const p of w.paths) add(p, tool)
      continue
    }

    // ③ codebuddy / Claude 风格：message.content[].tool_use { name, input }
    const content = j.message?.content
    if (Array.isArray(content)) {
      for (const c of content) {
        if (!c || (c.type !== 'tool_use' && c.type !== 'toolCall')) continue
        res.calls++
        if (!res.formats.includes('codebuddy')) res.formats.push('codebuddy')
        const w = writesOf(c.name, c.input ?? c.arguments)
        if (w.isWrite) for (const p of w.paths) add(p, c.name)
      }
      continue
    }

    // ④ 裸 tool_calls（部分载体的 OpenAI 风格）
    if (Array.isArray(j.tool_calls)) {
      for (const c of j.tool_calls) {
        res.calls++
        if (!res.formats.includes('tool_calls')) res.formats.push('tool_calls')
        const args = typeof c.function?.arguments === 'string' ? safeJson(c.function.arguments) : (c.function?.arguments ?? c.arguments ?? c.input)
        const w = writesOf(c.function?.name ?? c.name, args)
        if (w.isWrite) for (const p of w.paths) add(p, c.function?.name ?? c.name)
      }
    }
  }

  res.ok = res.calls > 0
  return res
}

/**
 * 判一条越界记录：这张卡**有没有写它**的铁证。
 * @returns {'tool-call'|'none'}
 */
export function claimOf (written, targetPath, project = null) {
  if (!written?.ok) return 'none'
  return written.set.has(normPath(targetPath, project)) ? 'tool-call' : 'none'
}
