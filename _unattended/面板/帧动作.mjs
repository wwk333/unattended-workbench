/**
 * 看板格动作（「控」）· 2026-10-10
 *
 * · **暂停**＝真动作：任务管理器杀进程树（`taskkill /PID … /T /F`）＋写中断收据；
 * · **继续**＝**两段**：默认**还是预览**（`dry:true`）；带 **`execute:true`** 才**真 spawn**。
 *   ★ 2026-10-13（b73）**真执行落地**（用户拍板"直接花费 token 去做小测试，我允许了"）：
 *   - 为什么默认仍是预览：既有判据（`_probe\board-look\_verify-look.mjs`、`_probe\think-recon\_verify-resume-wiring.mjs`）
 *     断言的就是"不显式要求就不许 spawn" ⇒ **保持向后兼容**，真跑必须由调用方**显式**要。
 *   - 真跑时**照编排同一套路**：写 `runs\<戳>\tasks\<cardId>.{prompt.txt,out.json,err.txt}` ＋
 *     `running\<cardId>.json`（面板的「在跑」灯与会话视图**立刻**看得见，走的是既有那条链）＋
 *     收活后**删登记**并**补一条账本记录**（否则"跑完反而从会话里消失"）。
 *   - **三条硬闸**：① 该角色**已经在跑** ⇒ 拒（不许在同一个会话上开两个进程）；
 *     ② 载体没声明 `sessionFlag`（如 DSH headless）⇒ 拒；③ 会话**不在盘上** ⇒ 拒（不拼注定失败的假命令）。
 * · 留痕两轨：① 面板级审计 `面板\panel-actions.jsonl`（三种 op 都记）；
 *   ② 项目级中断收据 `<项目>\_crew\runs\frame-actions.jsonl`（暂停/续跑时记，给接手者看）。
 */
import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, resolveRole, buildInvocation, envFor, parseCarrierOutput } from '../_agents-config.mjs'
import { findRunningRecord } from './帧数据.mjs'
// ★ b123：显示名改从**载体声明**读（`_crew\carriers.json` 的 `displayName`）—— 原来这里又写死一张表（与 `帧数据.mjs` 那张重复）。
import { carrierDisplayNameOf } from '../_载体属性.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const PANEL_AUDIT = join(HERE, 'panel-actions.jsonl')
const PI_SESS_DIR = process.env.DSH_PI_SESSION_DIR ?? join(homedir(), '.pi', 'agent', 'sessions')

/**
 * 会话**是否真在盘上**：`true` / `false` / `null`（＝这家没接核对，**不假装知道**）。
 *
 * 为什么必须有这一手：2026-10-10 极小真跑实测出一个陷阱 ——
 *   账本里 coder-a 的会话号是**`--no-session` 时代**记下的，**盘上根本没有那个会话**
 *   （那时 Pi 压根不落盘）。若预览照旧把命令拼出来，使用者会拿到一条**注定被载体拒绝**的命令
 *   （Pi 的 `--session` 找不到会话就 `exit 1`）——**"看着能续、其实续不了"正是本项目最恨的那种假象**。
 * 目前只接了 Pi（会话落盘位置已实测：`~/.pi/agent/sessions/<cwd 转写>/<时间戳>_<id>.jsonl`）；
 *   其余载体返回 `null`（如实标"未接核对"，不许猜）。
 */
export function sessionOnDisk (agentName, sessionId) {
  if (!sessionId) return false
  if (agentName !== 'pi') return null
  if (findPiSession(sessionId)) return true
  try { readdirSync(PI_SESS_DIR); return false } catch { return null }
}

/**
 * 找 Pi 的会话文件，**顺便读出它建在哪个 cwd**。
 *
 * ★★ b73（2026-10-13）**真跑撞出来的坑**：Pi 的会话是**按 cwd 归属**的 —— 续跑时若给了别的 cwd，它会：
 *   ```
 *   Session found in different project: <盘符>\…\_角色自检
 *   Fork this session into current directory? [y/N]
 *   ```
 *   而非交互模式下**没人回答** ⇒ 它**立刻退出、输出 0 字节**（实测：2 秒、0 字节、账本记成 `ok=false`）。
 *   ⇒ **续跑进程的工作目录必须等于会话自己的 cwd**，不是"项目根"、也不是从输出路径推出来的那个。
 *
 * 权威来源＝**会话文件首行**的 `cwd` 字段（实测首行：
 *   `{"type":"session","version":3,"id":"…","cwd":"<盘符>\\…\\_角色自检"}`）。
 * **不去反解目录名** —— 那套编码有歧义（`:` / `\` / 字面 `-` **都会变成 `-`**，见 `--D--dsh桌面端-无人值守--`），
 * 反解出来的路径可能"看着对、其实错"，那正是本项目最恨的假象。
 */
export function findPiSession (sessionId) {
  if (!sessionId) return null
  const stack = [PI_SESS_DIR]
  try {
    while (stack.length) {
      const d = stack.pop()
      for (const f of readdirSync(d)) {
        const p = join(d, f)
        let st
        try { st = statSync(p) } catch { continue }
        if (st.isDirectory()) { stack.push(p); continue }
        if (!f.includes(String(sessionId))) continue
        let cwd = null
        try {
          const first = readFileSync(p, 'utf8').split(/\r?\n/, 1)[0]
          const j = JSON.parse(first)
          if (j && typeof j.cwd === 'string') cwd = j.cwd
        } catch {}
        return { file: p, cwd }
      }
    }
    return null
  } catch { return null }
}

/** 续跑指令的三条纪律写在预览里（真执行时它就是要塞进 prompt 的那段）。 */
const RESUME_RULE = '先重读你上次改过的文件、核对指纹，再接着干（你手上的上下文是改之前的）'

function readJson (p) { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null } }

/** 这次调用属于哪个项目：优先从信封路径上溯（`<项目>\_crew\tasks\X.out.json`），否则用钉住的项目。 */
function projectOfCall (call) {
  const p = call && typeof call.envelope === 'string' ? call.envelope : ''
  if (p) {
    const d = resolve(dirname(p), '..', '..')
    if (existsSync(join(d, '_crew'))) return d
  }
  try { const cur = String(readFileSync(join(ROOT, '_crew', '当前项目.txt'), 'utf8')).trim(); if (cur) return cur } catch {}
  return ROOT
}

/**
 * 拟一条"续跑命令"——**只组装、绝不执行**。
 * 失败一律返回 {ok:false,error}（续不了就明说），成功返回 {ok:true,inv,...}。
 * 口径：模型按**该角色当前首选**组装（`quotaFailover:false`）—— 免得预览随额度状态漂；
 *       真跑时额度兜底可能当场换家，那时命令会跟着变（这是引擎行为，不是本预览的错）。
 */
function planResume (role, sessionId, cwd, instruction) {
  let roleRes
  try {
    const { cfg } = loadConfig()
    roleRes = resolveRole(role, cfg, { quotaFailover: false })
  } catch (e) { return { ok: false, error: '拼命令失败：' + String((e && e.message) || e) } }
  const a = roleRes.agent || {}
  const carrier = roleRes.agentName ? carrierDisplayNameOf(roleRes.agentName) : '这家'
  if (!a.sessionFlag) return { ok: false, error: carrier + ' 没有续跑口（配置里 sessionFlag 为空）—— 如实续不了，不拼假命令' }
  if (!sessionId) return { ok: false, error: '账本里没有 ' + role + ' 的会话号（sessionId），续不了' }
  // ★ 会话**在不在盘上**：知道它不在，就**不许**再拼一条注定被载体拒绝的命令（详见 sessionOnDisk 的注释）
  const onDisk = sessionOnDisk(roleRes.agentName, sessionId)
  if (onDisk === false) {
    return {
      ok: false,
      error: carrier + ' 的会话 ' + String(sessionId).slice(0, 22) + '… **盘上找不到**（这份账本记录来自 `--no-session` 时代，那时它压根不落盘）'
        + ' —— 等下一次真派活产生新会话再续；**不拼一条注定失败的命令**'
    }
  }
  // ★ b73：**进程 cwd 用"会话自己的 cwd"**（见 findPiSession 的注释 —— 用错了 Pi 会当场退出、0 字节）
  const sess = roleRes.agentName === 'pi' ? findPiSession(sessionId) : null
  const runCwd = sess?.cwd ?? cwd
  const inv = buildInvocation(roleRes, instruction || ('<' + RESUME_RULE + '>'), { cwd: runCwd, resumeSessionId: sessionId })
  return {
    ok: true, inv, agentName: roleRes.agentName, carrier, model: roleRes.model, sessionFlag: a.sessionFlag,
    env: envFor(roleRes, process.env),   // ★ b73：真跑要带钥匙（照 `envFor` 现读，绝不落盘/不进 argv）
    runCwd, sessionFile: sess?.file ?? null,
    cwdNote: sess?.cwd
      ? (sess.cwd === cwd ? '续跑工作目录 = 会话自己的目录 ✓' : '★ 续跑工作目录改用**会话自己的目录**（' + sess.cwd + '）—— 原按输出路径推出来的是 ' + cwd + '，两者不同，用错会被载体当场拒（实测过）')
      : '（未接"会话文件 → cwd"核对，按项目目录续）',
    sessionOnDisk: onDisk,   // true＝盘上有；null＝这家没接核对（如实标，不假装知道）
    sessionOnDiskNote: onDisk === true ? '会话在盘上 ✅' : '（' + carrier + ' 未接"会话在盘上"核对 —— 续不续得上由载体自己判）'
  }
}

/**
 * ★ 2026-10-14（用户拍板）：**「发送」＝新会话新派活** —— 取代旧的"发送＝插话预览"。
 *
 * 与「继续」的**唯一区别**：**不带 `resumeSessionId`** ⇒ 载体开一条**全新会话**，**不接前文**
 * （也就不接"刚被暂停杀掉的那条会话"的内容）。
 * 口径：模型照该角色当前首选组装（`quotaFailover:false`，与 `planResume` 一致 —— 预览别随额度状态漂）。
 */
function planSend (role, text, cwd) {
  let roleRes
  try {
    const { cfg } = loadConfig()
    roleRes = resolveRole(role, cfg, { quotaFailover: false })
  } catch (e) { return { ok: false, error: '拼命令失败：' + String((e && e.message) || e) } }
  const carrier = roleRes.agentName ? carrierDisplayNameOf(roleRes.agentName) : '这家'
  const inv = buildInvocation(roleRes, String(text), { cwd })
  return {
    ok: true, inv, agentName: roleRes.agentName, carrier, model: roleRes.model,
    env: envFor(roleRes, process.env),
    runCwd: cwd,
    cwdNote: '**新会话**：工作目录＝' + cwd + '，不接前文'
  }
}

/** 只在**写**这一类工具上认"动过文件"；`glob`/`grep`/`read` 是搜索与读取，不算改动。 */
const WRITE_TOOLS = /^(write|write_file|create_file|edit|edit_file|str_replace|str_replace_editor|apply_patch|multi_edit|notebook_edit|insert|patch|mv|cp|rm|del)$/i
const BASH_TOOLS = /^(bash|shell|run_command|execute|terminal|run)$/i
const PATH_KEYS = ['file_path', 'filePath', 'filepath', 'path', 'file', 'filename', 'target_file', 'notebook_path']

/**
 * ★★ 2026-10-14（用户拍板）**「暂停」杀之前，把"它动过哪些文件"记下来** —— 给「继续」用。
 *
 * ## 为什么这么设计（用户问过"为什么不做"，这是答复的落地）
 * 房子里的 `_unattended\文件指纹.mjs` 走的是"**全项目**扫一遍、派活前/收活后配对"。
 * 那套**不适合放在"杀"这一刻**：① 全项目扫描＋哈希会**拖慢掐断**（而"暂停"的价值就在快）
 * ② 会把**同时段别的角色/别的任务**改的文件一起算进来 ⇒ 续跑时反而误导。
 * ⇒ 这里改成**只对它自己动过的那几个文件**算指纹：**快（毫秒级）、准（无噪声）、零 token**。
 *
 * ## ⚠️ 读**原始流**、**不要**走 `adapters`（2026-10-14 真跑踩到、已改）
 * 第一版我图省事用了 `toEvents(carrier, …)`（面板显示用的那套翻译器）—— 结果**一个文件都抠不到**：
 * `adapters` 是**给显示用的**，它把结构化 `input` **丢了**，只留一行 `"glob: <盘符>\\…"`（工具名＋首参）。
 * 真样本：`toEvents('qwencode', …)` ⇒ `{kind:'tool', text:'glob: <盘符>\\…', input:null}`，
 * 而**同一份原文**里明明有 `{"type":"tool_use","name":"glob","input":{"pattern":"killtest-*","path":"<盘符>\\…"}}`。
 * ⇒ 这里改成**直接读原始 JSONL 并递归找 tool_use/toolCall 节点**（各家键名不同：`input` / `arguments` 都收）。
 *
 * ## 另两条口径
 * · **只算"写"**：搜索/读取（glob/grep/read/ls）**不算动过文件** —— 第一版把 `glob` 也算进去是错的。
 * · **已知盲区（如实标）**：`bash` 里的 `sed -i` / `>` 重定向 / `rm` 这类**间接改动**事件流只给命令字符串
 *   ⇒ 只能正则尽力捞。**这正是续跑时仍要它"先重读核对"的原因。**
 */
function collectToolCalls (text) {
  const out = []
  const walk = (o) => {
    if (!o || typeof o !== 'object') return
    if (Array.isArray(o)) { for (const x of o) walk(x); return }
    const t = String(o.type ?? '')
    const args = o.input ?? o.arguments ?? null
    if (args && typeof args === 'object' && (t === 'tool_use' || t === 'toolCall' || t === 'tool_call' || (t === '' && o.name))) {
      out.push({ name: String(o.name ?? ''), args })
    }
    for (const v of Object.values(o)) walk(v)
  }
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim()
    if (!s || s[0] !== '{') continue
    try { walk(JSON.parse(s)) } catch {}
  }
  return out
}
function touchedFilesOf (carrier, outFile) {
  let text = ''
  try { text = readFileSync(outFile, 'utf8') } catch { return [] }
  const set = new Set()
  const push = (s) => {
    const t = String(s ?? '').trim().replace(/^["']|["']$/g, '')
    if (!t || t.length > 400 || t === '.') return
    if (!/[\\/]/.test(t) && !/\.\w{1,8}$/.test(t)) return     // 既无目录分隔、又无扩展名 ⇒ 不当路径
    set.add(t)
  }
  for (const { name, args } of collectToolCalls(text)) {
    if (WRITE_TOOLS.test(name)) { for (const k of PATH_KEYS) push(args[k]) }
    else if (BASH_TOOLS.test(name)) {
      const cmd = args.command ?? args.cmd ?? args.script ?? null
      if (typeof cmd === 'string') {
        for (const m of cmd.matchAll(/(?:^|\s)([A-Za-z]:\\[^\s"'|><]+|\/[^\s"'|><]+|[\w.\u4e00-\u9fa5-]+\.(?:js|mjs|cjs|ts|tsx|json|jsonl|md|txt|ps1|cmd|sh|css|html|py|yaml|yml|toml))\b/g)) push(m[1])
      }
    }
  }
  return [...set]
}
/** 只对给定文件算 size+mtime+sha256（>8MB 不哈希，与 `文件指纹.mjs` 同纪律）。 */
function fingerprintFiles (paths, cwd) {
  const out = []
  for (const p of paths.slice(0, 200)) {
    const abs = resolve(cwd, p)
    try {
      const st = statSync(abs)
      if (!st.isFile()) continue
      let sha = null
      if (st.size <= 8 * 1024 * 1024) { try { sha = createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 16) } catch {} }
      out.push({ path: p, size: st.size, mtimeMs: Math.round(st.mtimeMs), sha })
    } catch { /* 文件不在了 ⇒ 不收（如实：它可能刚删） */ }
  }
  return out
}
const interruptionFile = (project, role) => join(project, '_crew', 'runs', 'interruption-' + role + '.json')
/** 「继续」时把上次暂停记下的指纹块拼进指令 —— **你的话在前、这一块在后**。 */
function interruptedNote (cwd, role) {
  const rec = readJson(interruptionFile(cwd, role))
  if (!rec || !Array.isArray(rec.files) || !rec.files.length) return null
  const lines = rec.files.map((f) => '· ' + f.path + '（' + f.size + ' B' + (f.sha ? '，sha ' + f.sha : '，>8MB 未哈希') + '）')
  return '★ 先重读下面这些文件、核对内容，**再接着干** —— 你上一轮被「暂停」杀掉时可能只写了一半，**以盘上为准、别信自己的记忆**：\n'
    + lines.join('\n')
    + '\n（这份清单来自你上一轮的工具调用记录，抓于杀之前；共 ' + rec.files.length + ' 个文件'
    + (rec.blind ? '；⚠️ bash 里的间接改动可能没进清单' : '') + '）'
}

/**
 * ★ b73（2026-10-13）**真跑一条载体进程** —— 照 `编排.mjs` 同一套路（同一份文件规则、同一个"在跑"判据）。
 *   b82（2026-10-14）改名 `runResume` → `runCarrier`：**「继续」（接旧会话）与「发送」（新会话）共用它**
 *   —— 两者只差 `plan.inv` 里带不带续跑旗标，落文件/登记/收活/补账本**必须一模一样**（否则面板的灯、
 *   会话视图、收活判据会分成两条链）。
 *
 * 为什么必须照编排那套：`面板\帧数据.mjs` 的"在跑那一轮"是**算出来的**
 * （`running\<cardId>.json` → `runs\<戳>\{tasks,review}\<cardId>.out.json`）⇒ 只要按同一规则落文件，
 * 面板的灯、会话视图、收活判据**全都自动认它**，不需要为"面板跑的"另开一条链。
 *
 * 收活：子进程退出 ⇒ ① 删 `running\<cardId>.json`（否则灯永远亮着）② 用**同一个解析器**
 * （`parseCarrierOutput`）读回执并**补一条账本**（否则"跑完反而从会话里看不见"）。
 */
function runCarrier ({ role, plan, project, cardId, by = '面板·继续', auditOp = 'continue' }) {
  const stamp = cardId.replace(/^PANEL-(RESUME|SEND)-/, '')
  const dir = join(project, '_crew', 'runs', stamp, 'tasks')
  mkdirSync(dir, { recursive: true })
  const promptFile = join(dir, cardId + '.prompt.txt')
  const outFile = join(dir, cardId + '.out.json')
  const errFile = join(dir, cardId + '.err.txt')
  const runningDir = join(project, '_crew', 'running')
  mkdirSync(runningDir, { recursive: true })
  const runningFile = join(runningDir, cardId + '.json')

  writeFileSync(promptFile, String(plan.inv.args[plan.inv.args.length - 1] ?? ''), 'utf8')
  const outFd = openSync(outFile, 'w')
  const errFd = openSync(errFile, 'w')
  const t0 = Date.now()
  const child = spawn(plan.inv.exe, plan.inv.argv, {
    // ★ b73：**进程 cwd ＝ 会话自己的目录**（`plan.runCwd`）；输出文件仍落项目里（两件事分开）。
    cwd: plan.runCwd ?? project, env: plan.env, windowsHide: true, detached: true, stdio: ['ignore', outFd, errFd]
  })
  const timeoutMin = 90
  try {
    writeFileSync(runningFile, JSON.stringify({
      cardId, task: cardId, role, agent: plan.agentName, childPid: child.pid, orchPid: process.pid,
      startedAt: new Date(t0).toISOString(), startedAtMs: t0,
      timeoutMin, deadlineMs: t0 + timeoutMin * 60_000 + 5 * 60_000,
      run: stamp, by
    }, null, 2), 'utf8')
  } catch {}

  let done = false
  child.on('exit', (code) => {
    if (done) return
    done = true
    try { unlinkSync(runningFile) } catch {}
    let env = null
    try { env = parseCarrierOutput(readFileSync(outFile, 'utf8'), existsSync(errFile) ? readFileSync(errFile, 'utf8') : '') } catch {}
    const tookMs = Date.now() - t0
    // 补账本（**用同一个解析器**；失败只告警，不影响"已经跑完了"这个事实）
    try {
      const args = ['add', '--role', role, '--task', cardId, '--envelope', outFile,
        '--ok', String(env ? !env.isError : code === 0), '--duration-ms', String(tookMs),
        '--session-id', String(env?.sessionId ?? ''), '--model', String(plan.model ?? '')]
      if (env?.numTurns != null) args.push('--num-turns', String(env.numTurns))
      const r = spawnSync(process.execPath, [join(ROOT, '_unattended', '工量账本.mjs'), ...args], { encoding: 'utf8', windowsHide: true, timeout: 30_000 })
      if (r.status !== 0) console.error('[面板·' + (by.includes('发送') ? '发送' : '继续') + '] 补账本失败：' + String(r.stderr || r.stdout || '').slice(0, 200))
    } catch (e) { console.error('[面板] 补账本异常：' + String(e?.message ?? e).slice(0, 160)) }
    auditPanel({ op: auditOp + '-run-exit', role, cardId, exit: code, tookMs, ok: env ? !env.isError : null })
    auditProject(project, { op: auditOp + '-run-exit', role, cardId, exit: code, tookMs, outFile })
  })
  child.unref()
  return { child, outFile, errFile, promptFile, runningFile, cmd: plan.inv.argvForDisplay.join(' ') }
}
function auditPanel (line) { try { appendFileSync(PANEL_AUDIT, JSON.stringify({ at: new Date().toISOString(), by: '面板', ...line }) + '\n', 'utf8') } catch {} }
function auditProject (project, line) {
  try {
    const dir = join(project, '_crew', 'runs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'frame-actions.jsonl'), JSON.stringify({ at: new Date().toISOString(), by: '面板', ...line }) + '\n', 'utf8')
  } catch {}
}
function latestCall (role) {
  const L = readJson(join(ROOT, '_crew', 'ledger.json')) ?? {}
  const calls = Array.isArray(L.calls) ? L.calls : []
  const mine = calls.filter((c) => c.role === role)
  return mine.length ? mine[mine.length - 1] : null
}

export function frameAction ({ op, role, text, execute }) {
  if (!['pause', 'continue', 'send'].includes(op)) return { ok: false, error: '未知动作：' + op }

  /* ── 暂停（真动作）─────────────────────────────────────────────────── */
  if (op === 'pause') {
    const run = findRunningRecord(role)
    if (!run) return { ok: false, error: role + ' 现在没在跑（没有活着的运行登记）' }
    // ★★ 2026-10-14：**杀之前**把它"动过哪些文件"记下来（只对这几个文件算指纹，不扫全项目）——
    //   给「继续」（插话）用：续跑时把这份清单塞进指令，让它"先重读核对、再接着干"。
    //   抓在杀前＝记的是"被杀那一刻盘上的样子"（可能正写一半，那正是要给它看的）。
    let interrupted = null
    try {
      const outFile = (run.run && run.cardId)
        ? join(run.project, '_crew', 'runs', String(run.run), 'tasks', String(run.cardId) + '.out.json')
        : null
      const paths = (outFile && existsSync(outFile)) ? touchedFilesOf(run.agent, outFile) : []
      const files = fingerprintFiles(paths, run.project)
      mkdirSync(join(run.project, '_crew', 'runs'), { recursive: true })
      interrupted = {
        at: new Date().toISOString(), role, cardId: run.cardId ?? null, task: run.task ?? null,
        agent: run.agent ?? null, outFile, snapshot: '杀前（pre-kill）',
        files, blind: true,   // ⚠️ bash 里的间接改动（sed -i / > / rm）捞不到 —— 如实标
        source: '会话流（载体工具调用）＋ 逐文件 size/mtime/sha256'
      }
      writeFileSync(interruptionFile(run.project, role), JSON.stringify(interrupted, null, 2), 'utf8')
    } catch (e) { interrupted = { error: String(e?.message ?? e).slice(0, 160) } }
    const r = spawnSync('taskkill', ['/PID', String(run.childPid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    const killed = r.status === 0
    const ranSec = run.startedAtMs ? Math.max(0, Math.round((Date.now() - run.startedAtMs) / 1000)) : null
    auditPanel({ op: 'pause', role, task: run.task, childPid: run.childPid, killed })
    auditProject(run.project, { op: 'pause', role, task: run.task, cardId: run.cardId, childPid: run.childPid, startedAt: run.startedAt, ranSec, deadlineMs: run.deadlineMs ?? null, killed })
    return {
      ok: killed, killed, op: 'pause', role, childPid: run.childPid, task: run.task,
      interruptedFiles: Array.isArray(interrupted?.files) ? interrupted.files.length : null,
      note: killed
        ? '已停 · 中断收据已落（这轮跑了约 ' + (ranSec != null ? Math.round(ranSec / 60) + ' 分钟' : '?') + '）'
          + (Array.isArray(interrupted?.files)
            ? ' · 抓了它动过的 **' + interrupted.files.length + ' 个文件**的指纹（杀前快照，给「继续」用）'
            : '（未能抓到文件指纹：' + String(interrupted?.error ?? '没有输出文件') + '）')
        : 'taskkill 返回非 0：' + String((r.stderr || r.stdout || '')).trim().slice(0, 160)
    }
  }

  /* ── 继续：默认＝预览；`execute:true` 才真 spawn ─────────────────────── */
  if (op === 'continue') {
    const call = latestCall(role)
    if (!call) return { ok: false, error: '账本里没有 ' + role + ' 的记录，无可续会话' }
    const cwd = projectOfCall(call)
    // ★ 2026-10-14：指令＝**你的话在前** ＋ 杀前抓的"动过哪些文件"指纹 ＋ 通用核对提醒（都在后）。
    const touched = interruptedNote(cwd, role)
    const instruction = [
      text ? String(text) : null,
      (touched ? touched + '\n\n' : '') + '（' + RESUME_RULE + '）'
    ].filter(Boolean).join('\n\n')
    const plan = planResume(role, call.sessionId, cwd, instruction)
    auditPanel({ op: execute === true ? 'continue-run' : 'continue-preview', role, task: call.task, sessionId: call.sessionId ?? null, planned: plan.ok })
    if (!plan.ok) return { ok: false, dry: true, op: 'continue', role, error: plan.error }

    // ★ b73 真执行前的**最后一道闸**：这个角色**现在就在跑** ⇒ 拒。
    //   为什么必须拦：两个进程挂在**同一个会话**上，会互相覆盖上下文（载体那边看不见我们，我们这边也看不见它）。
    const live = findRunningRecord(role)
    if (execute === true && live) {
      return {
        ok: false, op: 'continue', role,
        error: role + ' 现在正在跑（pid ' + live.childPid + ' · 任务 ' + live.task + '）—— 先「暂停」或等它收活，'
          + '**不在同一个会话上开两个进程**'
      }
    }

    if (execute !== true) {
      return {
        ok: true, dry: true, op: 'continue', role,
        sessionId: call.sessionId, task: call.task,
        carrier: plan.carrier, model: plan.model, cwd, runCwd: plan.runCwd,
        sessionFlag: plan.sessionFlag,
        sessionOnDisk: plan.sessionOnDisk,
        command: plan.inv.argvForDisplay.join(' '),
        commandShort: plan.inv.args.join(' '),      // 只留 CLI 参数（去掉 node 与入口路径）——给窄格子显示用
        plan: '拟续跑：让新进程接着会话 ' + String(call.sessionId).slice(0, 22) + '… 继续干 —— 指令必带「' + RESUME_RULE + '」',
        note: plan.sessionOnDiskNote + '；' + plan.cwdNote + '；**默认仍是预览**（本窗口只做"组装＋安全点"，不 spawn）。要真跑：再点一次并确认（前端会带 `execute:true`）。'
      }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const cardId = 'PANEL-RESUME-' + stamp
    let run
    try { run = runCarrier({ role, plan, project: cwd, cardId, by: '面板·继续', auditOp: 'continue' }) }
    catch (e) { return { ok: false, op: 'continue', role, error: '起进程失败：' + String(e?.message ?? e).slice(0, 200) } }
    auditProject(cwd, { op: 'continue-run', role, cardId, childPid: run.child.pid, sessionId: call.sessionId, outFile: run.outFile })
    return {
      ok: true, dry: false, op: 'continue', role, running: true,
      sessionId: call.sessionId, task: call.task, carrier: plan.carrier, model: plan.model, cwd, runCwd: plan.runCwd,
      childPid: run.child.pid, cardId, outFile: run.outFile,
      command: run.cmd,
      plan: '已续跑：新进程接着会话 ' + String(call.sessionId).slice(0, 22) + '… 干活（指令带「' + RESUME_RULE + '」）',
      note: 'pid ' + run.child.pid + ' 已起（工作目录＝' + String(plan.runCwd ?? cwd) + '）；面板那格会**立刻**显示"在跑"，会话视图边走边读。收活后自动删登记、并把这一轮补进账本。'
    }
  }

  /* ── 发送：**新会话新派活**（默认＝预览；`execute:true` 才真 spawn）─────────────────
     ★ 2026-10-14 用户拍板：**「发送」不再是插话**。插话 ＝「暂停」＋「继续」（杀+续）——
       这里起的是**一条全新会话**：载体不带续跑旗标 ⇒ **不接前文**，也不接"刚被杀掉的那条会话"的内容。
     ★ 与「继续」同一个前置闸：这个角色**正在跑**就拒（同一个角色不开两条）。 */
  if (op === 'send') {
    if (!text) return { ok: false, error: '发送要带一句话——先在消息框里打上' }
    if (String(text).length > 3000) return { ok: false, error: '话太长（>' + 3000 + ' 字），先精简' }
    const live = findRunningRecord(role)
    if (live) {
      return {
        ok: false, op: 'send', role,
        error: role + ' 现在正在跑（pid ' + live.childPid + ' · 任务 ' + live.task + '）—— 先「暂停」或等它收活，**同一个角色不开两条**'
      }
    }
    const call = latestCall(role)
    const cwd = call ? projectOfCall(call) : ROOT
    const plan = planSend(role, String(text), cwd)
    auditPanel({ op: execute === true ? 'send-run' : 'send-preview', role, planned: plan.ok })
    if (!plan.ok) return { ok: false, dry: true, op: 'send', role, error: plan.error }

    if (execute !== true) {
      return {
        ok: true, dry: true, op: 'send', role,
        carrier: plan.carrier, model: plan.model, cwd,
        command: plan.inv.argvForDisplay.join(' '),
        commandShort: plan.inv.args.join(' '),
        plan: '拟**新会话**派活：起一个新进程、开一条**全新会话**（不接前文）',
        note: '**默认仍是预览**（只组装、不 spawn）。要真跑：再点一次（前端会带 `execute:true`）。' + plan.cwdNote
      }
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const cardId = 'PANEL-SEND-' + stamp
    let run
    try { run = runCarrier({ role, plan, project: cwd, cardId, by: '面板·发送', auditOp: 'send' }) }
    catch (e) { return { ok: false, op: 'send', role, error: '起进程失败：' + String(e?.message ?? e).slice(0, 200) } }
    auditProject(cwd, { op: 'send-run', role, cardId, childPid: run.child.pid, outFile: run.outFile })
    return {
      ok: true, dry: false, op: 'send', role, running: true,
      carrier: plan.carrier, model: plan.model, cwd,
      childPid: run.child.pid, cardId, outFile: run.outFile,
      command: run.cmd,
      plan: '已派新活：新进程 ＋ **新会话**（不接前文）',
      note: 'pid ' + run.child.pid + ' 已起；面板那格会**立刻**显示"在跑"，会话视图边走边读。收活后自动删登记、并把这一轮补进账本。'
    }
  }
}
