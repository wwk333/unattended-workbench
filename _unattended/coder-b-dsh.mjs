/**
 * ⛔⛔ 文件名骗人，先读这段（2026-10-24 加）⛔⛔
 *
 *   醒醒：**这不是 coder-b 的入口**。现行定编（`_crew\agents.json` 的 `roles`）是：
 *       coder-a = pi        coder-b = opencode     reviewer = codebuddy
 *       rescue  = qwencode   researcher = messenger ← **只有这一家走 DSH headless**
 *
 *   本文件是 **`messenger`（调研员）** 的 `entry`。headless **只许调研用**：
 *   编码 / 救急 / 审核 / 复查一律不许走这里（用户口径，2026-10-03 定）。
 *
 *   为什么写这段：2026-10-24 那次事故，大脑去目录里找"coder 入口"，看到文件名
 *   `coder-b-dsh.mjs`、读到下面那句自述"coder-b 的调用入口"⇒ 名正言顺拿 headless
 *   去写代码 ⇒ 4 个会话干活、0 条收据。名字过期会直接制造事故。
 *   （取证：`_crew\run` 无收据 + `.dsh\sessions\--<项目>--` 有会话；详见监控报告 §19.2）
 *
 *   要派编码活 ⇒ `编排.mjs --project <P> --execute`。别用这个文件。
 *
 * ------------------------------------------------------------------
 * messenger（调研员）的调用入口 —— 用 **DSH headless** 跑方舟 Coding Plan。
 * 历史名：coder-b-dsh.mjs（2026-10-02 时确实给 coder-b 用过，10-03 起 coder-b 换 opencode）。
 *
 * 为什么是它（2026-10-02 实测定下来的，不是选型偏好）：
 *   1) 需要 coder-b **能改文件、能跑命令**（coder 的本职），所以必须是个真 agent harness；
 *   2) "ark CLI"（`@volcengine/ark-cli`）**不是** agent —— 它的能力面只有
 *      `+chat` / `+gen` / `+understand` / `+new-agent` 这类**远端 API 调用**，
 *      帮助文本里没有任何 Read/Write/Edit/Bash 类工具参数，**当不了 coder**；
 *   3) DSH 自带 `dsh headless "任务"`（答一次、打印、退出），且**自带完整工具面**。
 *      把它叠上"方舟 Coding Plan"这条路由，就得到"coder-b 走方舟额度"的正解。
 *
 * 用法（与 Qoder 那条对齐：入口 + 任务正文）：
 *   node coder-b-dsh.mjs --task-file <提示词文件> --out <结果json> --err <日志> [选项]
 *   node coder-b-dsh.mjs [选项] "<任务正文>"          ← 派活.mjs 生成的就是这种
 *
 *   两种都认：
 *     · **给了 `--out/--err`** → 自己写文件（谁调用都不用操心）；
 *     · **没给** → 结果信封打 stdout、日志打 stderr，让调用方（编排.mjs 的 spawnSync
 *       收 stdout 落 out.json / 派活生成的 `1> out.json 2> err.txt`）自己收。
 *   这两种形状必须都支持：编排.mjs 走的是"管道收 stdout"，派活.mjs 打印的是"shell 重定向"，
 *   只认一种就会出现"手工能跑、上了编排就空文件"这种最难查的错。
 *
 * 选项：--model --effort --route --cwd --timeout-min --task-file --out --err
 *
 * ⚠️ 三个实测踩过的坑（都写在下面代码注释里）：
 *   ① 不叠 `agent-default-model` 覆盖 → headless 会去找 DEEPSEEK_API_KEY 并报
 *      `MISSING_CREDENTIAL: ... route "deepseek-official"`；
 *   ② prompt **走 stdin**（`-`），不走命令行参数 —— 中文走 argv 会被 GBK 弄乱
 *      （实测模型收到的是乱码"鏀跺埌"，它只是猜对了）；
 *   ③ baseURL 必须带 `/api/coding/v3`，写成 `/api/v3` **不消耗套餐额度、会另外计费**。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLI_JS as CLI_JS_P, DSH_EXE as DSH_EXE_P, need } from './_路径.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

function arg (name, dflt = null) {
  const i = process.argv.indexOf(name)
  return i >= 0 ? process.argv[i + 1] : dflt
}

const TASK_FILE = arg('--task-file')
const OUT = arg('--out')
const ERR = arg('--err')
const MODEL = arg('--model', 'glm-5.3-flash')
const EFFORT = arg('--effort', null)
const ROUTE = arg('--route', 'ark')
const CWD = resolve(arg('--cwd', process.cwd()))
const TIMEOUT_MIN = Number(arg('--timeout-min', '20'))

// 位置参数 = 任务正文（派活.mjs 生成的就是这个形状）。
// 拿法是"把所有已识别的 flag 及其值剔掉，剩下的就是正文"。
const FLAGS_WITH_VALUE = new Set(['--task-file', '--out', '--err', '--model', '--effort', '--route', '--cwd', '--timeout-min'])
const POSITIONAL = (() => {
  const a = process.argv.slice(2); const out = []
  for (let i = 0; i < a.length; i++) {
    if (FLAGS_WITH_VALUE.has(a[i])) { i++; continue }
    if (a[i].startsWith('--')) continue
    out.push(a[i])
  }
  return out.join(' ')
})()
const ROUTES_FILE = resolve(HERE, '_coder路由表.json')
// ⚠️ **不经 cmd.exe、不调 dsh.cmd**：`dsh.cmd` 里其实是用 Electron 当 node 跑
//    `app.asar\...\dsh-desktop-host\lib\cli.js`。走 cmd 那层时，中文路径/中文 prompt
//    会被系统的 GBK 码页弄乱（实测：信封里 cwd 变成 `E:\<中文目录>\...`（乱码），
//    随后 cmd 报"不是内部或外部命令"——错的是编码，不是路径真的不存在）。
//    这里直接以 `ELECTRON_RUN_AS_NODE=1` 起 exe，参数按数组传、prompt 走 stdin，
//    彻底绕开 cmd 的引号与码页。
const DSH_EXE = process.env.DSH_EXE ?? need('DSH 主程序', DSH_EXE_P)
const DSH_CLI_JS = process.env.DSH_CLI_JS ??
  need('DSH headless 入口', CLI_JS_P)
const DSH_PROFILE = process.env.DSH_HEADLESS_PROFILE ?? 'headless'

function fail (msg) {
  const env = { is_error: true, subtype: 'error', stop_reason: 'error', result: msg, source: 'coder-b-dsh' }
  if (OUT) { mkdirSync(dirname(OUT), { recursive: true }); writeFileSync(OUT, JSON.stringify(env, null, 2), 'utf8') }
  console.error(msg)
  process.exit(1)
}

const taskText = TASK_FILE ? readFileSync(TASK_FILE, 'utf8') : POSITIONAL
if (!taskText || !taskText.trim()) fail('没有任务正文：给 --task-file，或把正文当位置参数传进来')
if (TASK_FILE && !existsSync(TASK_FILE)) fail(`--task-file 不存在：${TASK_FILE}`)

// ── ① 从路由表取这条路由，并现读它的 key ─────────────────────────────────────
//    headless profile 不会自动从凭据库取 key（实测报 MISSING_CREDENTIAL），
//    所以由这里按路由声明的 `envField` 把 key 交给子进程。**不打印、不落盘**。
if (!existsSync(ROUTES_FILE)) fail(`找不到路由表：${ROUTES_FILE}`)
const ROUTES = JSON.parse(readFileSync(ROUTES_FILE, 'utf8').replace(/^\uFEFF/, ''))
const route = ROUTES[ROUTE]
if (!route) fail(`路由表里没有 "${ROUTE}"（可选：${Object.keys(ROUTES).filter(k => !k.startsWith('_')).join(' / ')}）`)
if (!Array.isArray(route.models) || route.models.length === 0) fail(`路由 "${ROUTE}" 没有 models`)

const CRED = process.env.DSH_CREDENTIALS ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), '.credentials.yaml')
const keyEnv = route.envField ?? route.apiKeyEnv
let apiKey = process.env[keyEnv] ?? null
if (!apiKey && existsSync(CRED)) {
  const m = readFileSync(CRED, 'utf8').match(new RegExp(`${keyEnv}\\s*:\\s*(\\S+)`))
  if (m) apiKey = m[1]
}
// ★ 2026-10-12（b38）：**第三层也要查 —— 面板存进"密钥库"的钥匙**。
//   实测踩到：`ocgo` 的钥匙在**面板**里存的（`~\.dsh\unattended-keys.json`），
//   而这里只查"环境变量 + 凭据库" ⇒ 调研员直接死在 `找不到 OCGO_API_KEY`（真跑一次才暴露）。
//   口径与全项目一致（`额度钥匙.mjs` 的三层解析：环境变量 > 密钥库 > 凭据库）⇒ 直接复用那个实现，
//   绝不再自己写一遍（两套解析必然分叉）。
if (!apiKey) {
  try {
    const { resolveKey, discoverProviders } = await import('./额度钥匙.mjs')
    const r = resolveKey(ROUTE, 0, undefined, undefined, discoverProviders())
    if (r?.key) apiKey = r.key
  } catch { /* 复用失败就按老口径报错（别静默） */ }
}
if (!apiKey) fail(`找不到 ${keyEnv}（环境变量、密钥库、${CRED} 三处都没有）`)

// ── ② 现造一份"本次调用"的 patch：路由（provider+模型清单）+ 默认模型/档位 ──────
//    ⚠️ 模型清单随路由走、不写死在代码里；`agent-default-model` 的
//    `reasoningEffort` 是**真字段**（从 asar 里读到 schema：provider/model/reasoningEffort
//    三个都是可配项），所以 --effort 不是摆设，会真的传给 DSH。
const tmpDir = join(HERE, 'logs', '_coderb-patch')
mkdirSync(tmpDir, { recursive: true })
const generated = join(tmpDir, `patch-${process.pid}.yml`)
const yaml = []
yaml.push('- id: agent-default-model')
yaml.push('  config:')
yaml.push(`    provider: ${ROUTE}`)
yaml.push(`    model: ${MODEL}`)
if (EFFORT) yaml.push(`    reasoningEffort: ${EFFORT}`)
yaml.push('')
yaml.push('- id: llm-pi-ai')
yaml.push("  name: '@deepseek-ai/dsh-llm-pi-ai'")
yaml.push('  config:')
yaml.push('    providers:')
yaml.push(`      ${ROUTE}:`)
yaml.push(`        displayName: ${route.displayName ?? ROUTE}`)
yaml.push(`        apiKeyEnv: ${route.apiKeyEnv}`)
yaml.push(`        api: ${route.api}`)
yaml.push(`        baseURL: ${route.baseURL}`)
if (route.compat) {
  yaml.push('        compat:')
  for (const [k, v] of Object.entries(route.compat)) yaml.push(`          ${k}: ${v}`)
}
// ★ 2026-10-12（b38）：**这家要求的额外请求头也带进生成的配置里** —— 实测 `ocgo`（opencode zen/go）
//   的推理请求少了 `x-opencode-session` 就回 400（`MissingSessionID`），补上就 200。
//   只改"检测"不改这里 ⇒ 检测变绿而调研员真跑照样红 = **假绿**，比诚实红更糟。
if (route.headers && typeof route.headers === 'object') {
  yaml.push('        headers:')
  for (const [k, v] of Object.entries(route.headers)) yaml.push(`          ${k}: ${v}`)
}
yaml.push('        models:')
for (const m of route.models) {
  yaml.push(`          - id: ${m.id}`)
  yaml.push(`            name: ${m.name ?? m.id}`)
  if (m.contextWindow) yaml.push(`            contextWindow: ${m.contextWindow}`)
  if (m.maxTokens) yaml.push(`            maxTokens: ${m.maxTokens}`)
  if (m.input) yaml.push(`            input: [${m.input.join(', ')}]`)
  // ★ 2026-10-16（用户："为什么 ocgo 不支持选择档位？"）：**要让 DSH 认它是"推理模型"，靠的是 `reasoningEfforts`**。
  //   实测（3 次真跑）：路由表里**只加** `reasoningEfforts: {low,high,max}` 这一处声明，
  //   `--effort low/high/max` 就都能真跑通（stderr 空、有 usage）；不加则**硬拒**：
  //   `UNSUPPORTED_REASONING_EFFORT: provider "ocgo" model "deepseek-v4.1-flash" does not support reasoning effort "high"`。
  //   ⚠️ 别在模型里另写 `reasoning: true` —— 实测**加了也没用**（DSH 的 patch schema 不认这个键，白写）。
  if (m.reasoningEfforts) {
    yaml.push('            reasoningEfforts:')
    for (const [k, v] of Object.entries(m.reasoningEfforts)) yaml.push(`              ${k}: ${v}`)
  }
}
yaml.push('')
writeFileSync(generated, yaml.join('\n'), 'utf8')

const dshArgs = ['--expose-internals', DSH_CLI_JS,
  '--profile', DSH_PROFILE, '--patch', generated, '--json', '-']
const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1', // ← 让 Electron 以 node 身份跑 cli.js（dsh.cmd 就是这么干的）
  DSH_HOME: process.env.DSH_HOME ?? join(homedir(), '.dsh'),
  [keyEnv]: apiKey // 按路由声明的环境变量名注入（ARK_API_KEY / QWEN_TOKEN_PLAN_CN_API_KEY …）
}

// ── ③ 真跑：prompt 走 stdin（避免 argv 的中文编码坑）─────────────────────────
const started = Date.now()
if (OUT) mkdirSync(dirname(OUT), { recursive: true })
const r = spawnSync(DSH_EXE, dshArgs, {
  input: taskText,
  cwd: CWD,
  env,
  encoding: 'utf8',
  maxBuffer: 64 << 20,
  timeout: TIMEOUT_MIN * 60_000,
  windowsHide: true
})
const took = Date.now() - started
try { rmSync(generated, { force: true }) } catch {}

const stdout = r.stdout ?? ''
const stderr = r.stderr ?? ''
if (ERR) writeFileSync(ERR, stderr, 'utf8')
else if (stderr) process.stderr.write(stderr)

// ★ b72（2026-10-13）：**原始 NDJSON 落盘**（设了 `DSH_RAW_OUT=<路径>` 就写）——
//   用来回答"这家到底吐了哪些事件"。为什么需要它：下面 ④ 只挑
//   `session` / `final` / `text` / `status` **四类**，**其余事件（含思考）会被丢掉**
//   ⇒ "messenger 有没有思考正文"这个问题**在信封里永远看不出来**（实测：只能看原始流）。
//   顺带它也是"边跑边看"要的东西：面板那格读的就是载体输出文件。
if (process.env.DSH_RAW_OUT) { try { writeFileSync(process.env.DSH_RAW_OUT, stdout, 'utf8') } catch {} }

// ── ④ 把 NDJSON 事件流收口成一封稳定信封 ─────────────────────────────────────
let finalText = null; let sessionId = null; let usage = null; let reason = null; let cwd = null
const texts = []
for (const line of stdout.split(/\r?\n/)) {
  const t = line.trim(); if (!t.startsWith('{')) continue
  let e; try { e = JSON.parse(t) } catch { continue }
  if (e.type === 'session') { sessionId = e.sessionId ?? null; cwd = e.cwd ?? null }
  else if (e.type === 'final') finalText = e.text ?? finalText
  else if (e.type === 'text') texts.push(e.text ?? '')
  else if (e.type === 'status' && e.phase === 'step_end' && e.usage) usage = e.usage
  else if (e.type === 'status' && e.phase === 'turn_end') reason = e.reason?.kind ?? null
}
const result = finalText ?? texts.join('\n')
const exitCode = r.status
const isError = exitCode !== 0 || (!result && !/MISSING_CREDENTIAL/.test(stdout))
const envelope = {
  is_error: isError,
  subtype: isError ? 'error' : 'success',
  stop_reason: isError ? (reason ?? 'error') : (reason ?? 'end_turn'),
  result,
  source: 'coder-b-dsh',
  provider: ROUTE,
  model: MODEL,
  reasoning_effort: EFFORT,
  session_id: sessionId,
  cwd_used: cwd ?? CWD,
  duration_ms: took,
  num_turns: 1,
  exit_code: exitCode,
  usage: usage
    ? {
        input_tokens: usage.inputTokens ?? null,
        output_tokens: usage.outputTokens ?? null,
        cache_read_input_tokens: usage.cacheReadTokens ?? null,
        total_tokens: usage.totalTokens ?? null
      }
    : null,
  permission_denials: [],
  stderr_tail: stderr ? stderr.slice(-2000) : null
}
const payload = JSON.stringify(envelope, null, 2)
if (OUT) {
  writeFileSync(OUT, payload, 'utf8')
  // ⚠️ 有 --out 时**结果信封不往 stdout 打**：编排.mjs 会把 stdout 收进 out.json，
  //    再打一份就变成"文件里套文件"（账本解析不了）。日志走 stderr，不污染信封。
  console.error(JSON.stringify({ ok: !isError, exit: exitCode, tookMs: took, model: MODEL, out: OUT }))
} else {
  // 没给 --out：信封打 stdout，让调用方（派活的 `1> out.json` / 编排的 spawnSync）自己收
  process.stdout.write(payload)
}
process.exit(isError ? 1 : 0)
