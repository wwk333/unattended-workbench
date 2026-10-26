#!/usr/bin/env node
/**
 * 门禁 —— 全量测试的**唯一执行者**，零 LLM、零 token。
 *
 * 为什么要有它（2026-10-05 用户拍板的三条改造之一）：
 *   原来"跑全量测试"这件事**没有人固定负责**：
 *     · coder 每次任务都自己跑一遍全仓 `npm test`（45 条任务 = 45 次全量输出进它自己的上下文，最贵的一笔）；
 *     · 大脑"集成门禁"手跑一遍（每次都要把整段上下文重发 ≈ 31 万 token）；
 *     · 审核员被 plan 模式挡住 Bash，**一次都没跑成**（实跑由大脑代执 → 谁执行谁背书）。
 *   现在改成：**全量由这个脚本跑**，仓库里任何 LLM 都不再自己跑全量。
 *   脚本输出**结构化结果 + 一份极短摘要**（挂了的用例名 + 汇总数字），
 *   让审核员读 ~1KB 摘要而不是 300KB 测试输出 —— 这是"跑全量"与"省 token"能同时成立的关键。
 *
 *   另一个身份：它是**机器签字方**。审核员可以改 bug，但"改好了没有"由它复跑判定（红→绿证据）。
 *   它是程序、是异源、退出码稳定 —— 比"两个 LLM 互相看"更硬。
 *
 * 用法：
 *   node 门禁.mjs --project "<项目>"                    # 跑全量：构建 + 单测 + 冒烟
 *   node 门禁.mjs --project "<项目>" --quick            # 只跑构建 + 单测（冒烟太慢时用）
 *   node 门禁.mjs --project "<项目>" --only test,smoke  # 只跑指定几类
 *   node 门禁.mjs --project "<项目>" --unit-only        # 只跑某一种（等同 --only 单值）
 *   node 门禁.mjs --project "<项目>" --no-write         # 只打印，不写结果文件
 *   node 门禁.mjs --project "<项目>" --print            # 连完整测试输出也打出来（默认只打摘要）
 *
 * 退出码：0 = 全绿；1 = 有红（**不许进 done**）；2 = 环境/前置问题（没装依赖、脚本不存在）；3 = 用法错
 *
 * 输出：
 *   <项目>\_crew\gate\gate-result.json   ← 机器读（编排/审核员/看板）
 *   <项目>\_crew\gate\latest.log         ← 人读（末 60 行 + 摘要）
 *   <项目>\_crew\gate\history.jsonl      ← 每次一行的流水（红→绿证据链就靠它）
 *
 * ★ 2026-10-09（重构总表 §六·S3「绿灯自证身份」）：产物里多了两样、身份换了一条路 ——
 *   · `manifest`：**本次跑测试时**被测文件（测试根子树）的 sha256 前 12 位 ⇒ 大脑不用重跑测试，
 *     比「manifest ＝ 当前工作区指纹 ＝ reviewer 回执声称改过的文件」三方一致即可判"绿是不是这份代码的"；
 *   · `inputs`：本次的口子（scope / cwd / only / quick / unitOnly / 上一份 base）。
 *   · `ranBy`：**环境变量 `DSH_GATE_RANBY` 优先**（编排层与派活命令行注入），命令行 `--by` 只作兜底。
 *
 * 设计纪律（照本工作台踩过的坑）：
 *   ① **绝不接管道**：一律 spawn 直收 stdout（等价于 `1> 文件`），不走 PowerShell 重定向；
 *   ② **绝不 `shell: true`**：命令按空格切好直接 spawn，避免引号/中文路径出鬼；
 *   ③ **超时是护栏**：单步超时到点杀子进程，并把 timedOut 如实记进结果（不猜）；
 *   ④ **只跑白名单前缀**：package.json 里的脚本名必须匹配 `test*` / `smoke*` / `build` / `lint` / `typecheck`
 *      —— 防止有人往项目里塞个 `smoke-x: "rm -rf"` 被门禁当测试跑掉。
 */
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// ★ 2026-10-21（通用化④）：测试入口解析器 + 排除清单单一来源
import { resolvePlan, readGateJson } from './_门禁入口.mjs'
import { SKIP_DIRS as SHARED_SKIP_DIRS } from './_排除清单.mjs'
// ★ 2026-10-26（§零.1 / §一 / §二）：快照与入口证据都走契约层**唯一实现**
import { computeSnapshot } from './契约/快照.mjs'
import { inspectEntryEvidence, resolveEvidencePath } from './契约/入口.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const has = (n) => argv.includes('--' + n)

const rawProject = opt('project', process.env.DSH_ACTIVE_PROJECT ?? '')
if (!rawProject) { console.error('[门禁] 缺 --project <项目目录>'); process.exit(3) }
const PROJECT = resolve(rawProject)
if (!existsSync(PROJECT)) { console.error(`[门禁] 项目目录不存在：${PROJECT}`); process.exit(3) }

// 测试代码在哪：默认 <项目>\server（异次元这种"项目根是文档、代码在子目录"的结构），
// 没写 --cwd 时自动判断：<项目>\server\package.json 存在就用它，否则用项目根。
const CWD = resolve(opt('cwd', existsSync(join(PROJECT, 'server', 'package.json'))
  ? join(PROJECT, 'server')
  : PROJECT))

const ONLY = (opt('only', '') || '').split(/[,;，；]/).map(s => s.trim()).filter(Boolean)
const UNIT_ONLY = has('unit-only')
let QUICK = has('quick')                 // ★ 2026-10-16：显式 `--quick` 仍是**最高优先**（人不许被按级改主意）
const QUICK_EXPLICIT = QUICK

// ★ 2026-10-16（任务分级 L1–L4，KB 重构\任务分级-施工文档.md §3 ③ / §7-6）：
//   **门禁 scope 按级**：本波最深一级是 L1/L2 ⇒ 自动走 `--quick`（构建＋全仓单测，跳过 12 条冒烟 ≈146s）；
//   L3/L4 ⇒ 全量。级号从**派活收据**里读（`_crew\runs\<戳>\{tasks,review}\*.dispatch.json` 的 `levelGate`）。
//   纪律：① 显式 `--only` / `--unit-only` / `--quick` **一律优先**（这里不覆盖人的手令）；
//         ② **读不到任何级号 ⇒ 一分不改**（`QUICK` 保持 false ＝今天的行为，老项目/老卡零影响）；
//         ③ 只要还有一张 L3/L4 ⇒ 按最深的那张走（不会因为一张 L1 就把全量省掉）。
if (!QUICK_EXPLICIT && !ONLY.length && !UNIT_ONLY) {
  const rank = { L1: 0, L2: 1, L3: 2, L4: 3 }
  let deepest = null
  try {
    const runsRoot = join(PROJECT, '_crew', 'runs')
    const stamps = readdirSync(runsRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
    for (const s of stamps.slice(-3)) {                     // 最近 3 轮足够（本轮的卡就在最后一轮里）
      for (const sub of ['tasks', 'review']) {
        const dir = join(runsRoot, s, sub)
        let files = []
        try { files = readdirSync(dir).filter(f => /\.dispatch\.json$/i.test(f)) } catch { continue }
        for (const f of files) {
          try {
            const j = JSON.parse(readFileSync(join(dir, f), 'utf8').replace(/^\uFEFF/, ''))
            if (!j?.level) continue
            const L = String(j.level).toUpperCase()
            if (!(L in rank)) continue
            if (deepest === null || rank[L] > rank[deepest]) deepest = L
          } catch { /* 单份读不动就跳过，不猜 */ }
        }
      }
    }
  } catch { /* 没有 runs 目录 ⇒ 按无级号处理 */ }
  if (deepest === 'L1' || deepest === 'L2') QUICK = true
  if (deepest) console.log(`[门禁] 分级：本波最深一级＝${deepest} ⇒ scope＝${QUICK ? 'build+unit（--quick，按级自动）' : '全量（L3/L4）'}`)
}
const NO_WRITE = has('no-write')
const PRINT = has('print')

// 单步超时（分钟）：构建/单测/冒烟分开设，冒烟要连服务所以给得多些。
const T_BUILD = Number(opt('timeout-build-min', 10))
const T_TEST = Number(opt('timeout-test-min', 20))
const T_SMOKE = Number(opt('timeout-smoke-min', 15))

const GD = join(PROJECT, '_crew', 'gate')
const RESULT = join(GD, 'gate-result.json')
const LATEST = join(GD, 'latest.log')
const HISTORY = join(GD, 'history.jsonl')

const nowLocal = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const stamp = nowLocal().replace(/[: ]/g, '-')

// ---------------------------------------------------------------- 跑一条命令（不接管道、不 shell）

function runOne (label, exe, args, { timeoutMin, cwd = CWD }) {
  return new Promise((resolveP) => {
    const started = Date.now()
    let out = '', err = '', timedOut = false, settled = false, errorCode = null, sig = null
    let child
    try {
      // ⚠️ 2026-10-05 实测（本脚本第一次真跑就红了，抓到的就是这条）：
      //   Windows 上 `npm` 是 `npm.cmd`（批处理），**裸 spawn 会 `EINVAL`**（Node ≥18.20 起连
      //   `shell:true` + args 数组都被拿掉了旧行为）→ 必须 `shell:true`。代价是参数不再转义，
      //   所以**命令名过了 SAFE_PREFIX 白名单**才允许走到这里（见文件头纪律④），不是随便跑。
      child = spawn(exe, args, { cwd, windowsHide: true, shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'],
      // ★ 2026-10-26：把本次快照号告诉步骤 —— 入口证据必须绑定它跑的是哪一份代码，
      //   否则适配器只能瞎写（或者自算一份，那就是双真相）。
      env: { ...process.env, CI: '1', NO_COLOR: '1', DSH_GATE_SNAPSHOT: String(globalThis.__GATE_SNAPSHOT__ ?? '') } })
    } catch (e) {
      return resolveP({ label, exe, args, status: null, out: '', err: String(e?.message ?? e), timedOut: false, errorCode: 'SPAWN_FAIL', tookMs: 0 })
    }
    const timer = setTimeout(() => { timedOut = true; try { child.kill('SIGKILL') } catch {} }, timeoutMin * 60_000)
    child.stdout?.on('data', (c) => { if (out.length < (48 << 20)) out += c.toString('utf8') })
    child.stderr?.on('data', (c) => { if (err.length < (16 << 20)) err += c.toString('utf8') })
    const done = (status, code) => {
      if (settled) return
      settled = true; clearTimeout(timer)
      resolveP({ label, exe, args, status, out, err, timedOut, errorCode: code ?? null, signal: sig, tookMs: Date.now() - started })
    }
    child.on('error', (e) => { errorCode = e?.code ?? 'ERROR'; done(null, errorCode) })
    child.on('close', (code, s) => { sig = s ?? null; done(code, errorCode) })
  })
}

// ---------------------------------------------------------------- npm 脚本发现（带白名单）
//
// ⚠️ 2026-10-05 实测：桌面端自带的 node 目录里**只有 node.exe，没有 npm**（`bin\` 下就一个文件）。
//   但 `npm` 在 PATH 上（`%ProgramFiles%\nodejs\npm.cmd`）—— 载体们能 `npm test` 就是这个原因。
//   所以门禁**直接用 PATH 上的 npm**，找不到就明说（exit 2），不猜、不自己造一个。
const SAFE_PREFIX = /^(build|lint|typecheck|check|test|smoke)/i

/** 找一个能用的 npm（PATH 优先；找不到返回 null）。 */
function resolveNpm () {
  const cand = process.platform === 'win32'
    ? ['npm.cmd', join(process.env.ProgramFiles ?? 'C:\\Program Files', 'nodejs', 'npm.cmd'),
       join(process.env.APPDATA ?? '', 'npm', 'npm.cmd')]
    : ['npm', '/usr/local/bin/npm', '/usr/bin/npm']
  for (const c of cand) {
    if (!c) continue
    if (c.includes('\\') || c.includes('/')) { if (!existsSync(c)) continue }
    const r = spawnSync(c, ['-v'], { encoding: 'utf8', shell: process.platform === 'win32', timeout: 30_000, windowsHide: true })
    if (r.status === 0 && /\d+\.\d+/.test(String(r.stdout ?? ''))) return c
  }
  return null
}

function npmScripts () {
  const pkgPath = join(CWD, 'package.json')
  if (!existsSync(pkgPath)) return null
  try {
    // ★ 2026-10-21：去 BOM —— PowerShell 的 `Set-Content -Encoding utf8` 会带 BOM，
    //   不去就会 JSON.parse 失败（实测：package.json 带 BOM 时这里返回 null，而探测层认为"有 package.json" ⇒ 两边打架）。
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''))
    return { name: pkg.name ?? '(未命名)', scripts: pkg.scripts ?? {} }
  } catch { return null }
}

// ---------------------------------------------------------------- 摘要提取（这一步就是"省 token"）

/** vitest 的汇总行：`Tests  123 passed (123)` / `Test Files  44 passed (44)`。 */
function extractUnitSummary (text) {
  const s = { files: null, tests: null, failed: null, passed: null, duration: null }
  const t = text.replace(/\u001b\[[0-9;]*m/g, '')   // 去 ANSI
  const tests = t.match(/^\s*Tests\s+(.+)$/m)
  if (tests) {
    const line = tests[1]
    s.passed = Number((line.match(/(\d+)\s+passed/) ?? [])[1] ?? NaN) || null
    s.failed = Number((line.match(/(\d+)\s+failed/) ?? [])[1] ?? NaN) || null
    s.tests = (s.passed ?? 0) + (s.failed ?? 0) || null
  }
  const files = t.match(/^\s*Test Files\s+(.+)$/m)
  if (files) s.files = Number((files[1].match(/(\d+)/) ?? [])[1] ?? NaN) || null
  const dur = t.match(/^\s*Duration\s+(.+)$/m)
  if (dur) s.duration = dur[1].trim()
  return s
}

/** 找出挂了的用例/文件（最多 12 条，宁少勿多 —— 摘要要能一眼看完）。 */
function extractFailures (text) {
  const t = text.replace(/\u001b\[[0-9;]*m/g, '')
  const lines = t.split(/\r?\n/)
  const bad = []
  // ★ 2026-10-05 补（红绿灯演练暴露的缺口）：**构建（tsc）红的时候，摘要一条也点不出来** ——
  //   因为原来只认 vitest 的 FAIL/× 行。tsc 的原话是 `src/x.ts(116,3): error TS2322: …`
  //   ⇒ 这种带文件:行号的报错必须原样进摘要（它是"红在哪"里最有用的一类）。
  for (const l of lines) {
    const ts = l.match(/^\s*(\S+\.(?:ts|tsx|js|mjs|cjs))\((\d+),(\d+)\):\s*error\s+(TS\d+):\s*(.+)$/)
    if (ts) { bad.push(`${ts[1]}:${ts[2]} ${ts[4]} ${ts[5].slice(0, 100)}`); continue }
    if (bad.length >= 12) break
  }
  if (bad.length >= 12) return [...new Set(bad)].slice(0, 12)
  // ★ 2026-10-06 补（闭环演练第二刀暴露）：冒烟脚本自己的失败行是 `[smoke:xxx] FAIL ⑥ … —— 原因`。
  //   它的 tail 里通常正好带着这一行（12 行窗口）→ 必须认它，否则摘要是"红了但不说红在哪"。
  for (const l of lines) {
    // ① 行首就带标签的（`[smoke:x] FAIL ⑥ …`）；② 前缀被日志前缀吃掉的（tail 里只剩 `FAIL ⑥ …`）。
    //    两种都要认 —— 认不出就等于"红了但不说红在哪"（演练当场抓到过）。
    const m = l.match(/FAIL\s+([⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮]|\d+)[.、)）]?\s*(.{0,190})$/)
    if (m) { bad.push(m[0].trim().replace(/^.*?FAIL/, 'FAIL')); continue }
    const w = l.match(/^\s*\d+\)\s+(.{3,200})$/)     // vitest 失败清单：`1) test/x.test.ts > 用例`
    if (w) bad.push(w[1].trim())
    if (bad.length >= 12) break
  }
  if (bad.length >= 12) return [...new Set(bad)].slice(0, 12)
  for (const l of lines) {
    const m = l.match(/^\s*(?:FAIL|×|✗|not ok)\s+(.{3,160})$/)
    if (m) { bad.push(m[1].trim()); continue }
    const s = l.match(/^\s*(?:AssertionError|Error):\s*(.{3,160})$/)
    if (s) bad.push(s[1].trim())
    if (bad.length >= 12) break
  }
  return [...new Set(bad)].slice(0, 12)
}

/** 人话一行（给看板/报告用，用户看不懂代码）。 */
function plainOneLine (r) {
  if (r.ok) return `✅ 全绿（${r.summaryText}）`
  const first = r.failures?.[0] ? `：${r.failures[0].slice(0, 60)}` : ''
  return `❌ 红了（${r.summaryText}）${first}`
}

// ---------------------------------------------------------------- 被测文件 manifest（六·S3「绿灯自证身份」）
//
// ★ 2026-10-26（§零.1 / §一）：manifest 不再是第二套扫描 —— 它由 契约/快照.mjs 的 snapshot.files
//   按 CWD 子树投影出来（一份真相：快照）。

// ---------------------------------------------------------------- 主流程

const scripts = npmScripts()
// ★ 2026-10-21（通用化④）：非 Node 项目不再必然判红。
//   优先级：显式 gate.json → package.json（走原 npm 路，零改动）→ 按生态自动探测 → 诚实降级。
// ★ 2026-10-26 **修"声明了却不生效"**：原来只要项目里有 package.json 的 scripts，
//   就**根本不调 resolvePlan** ⇒ 显式 gate.json 里声明的 steps（unit / e2e）被静默忽略，
//   门禁只跑 npm test 自动探测那一条，交付门于是永远报
//   `gate:scope（只跑了 build+unit，不是全量）` + `e2e:missing`。
//   这是"表里不一"最典型的一种：文件里写了，代码里没读。
//   现在：**永远走 resolvePlan** —— 它自己的优先级就是 gate.json → package.json → 按生态探测。
const PLAN = resolvePlan({ project: PROJECT, cwd: CWD })

function writeResAndExit (res, code, human) {
  // ★ 2026-10-26（§零.6）：提前退出的产物也必须是**合规信封**，否则消费方只能靠猜。
  //   `state`：ok:false ⇒ red；ok:true 但 degraded ⇒ unknown（**不许当绿**）。
  const body = { ...res }
  body.testSource = res.testSource ?? res.source ?? null
  delete body.source // 信封的 source 只表示"谁写的"；测试入口来源挪到 testSource
  Object.assign(body, {
    schema: 1,
    kind: 'gate-result',
    at: new Date().toISOString(),
    source: '门禁.mjs',
    state: res.ok === false ? 'red' : (res.degraded ? 'unknown' : 'green'),
    stale: false
  })
  if (!NO_WRITE) { mkdirSync(GD, { recursive: true }); writeFileSync(RESULT, JSON.stringify(body, null, 2), 'utf8') }
  console.error(`[门禁] ${code === 0 ? '⚠️' : '❌'} ${human ?? res.reason}`)
  process.exit(code)
}

if (PLAN.error) {
  writeResAndExit({ ok: false, reason: PLAN.note, source: PLAN.source, ranAt: nowLocal(), steps: [] }, 2)
}
if (PLAN.source === 'none') {
  // 没有测试入口 ≠ 故障。判红会让人去修一个不存在的东西（实测：Python 项目因此永远红）。
  writeResAndExit({
    ok: true, degraded: true, reason: PLAN.note, source: 'none',
    summaryText: '没有测试入口（跳过）', ranAt: nowLocal(), steps: [],
    hint: '想让门禁真跑：在项目根放 gate.json（形如 {"steps":[{"name":"test","kind":"unit","cmd":"python -m pytest -q"}]}）'
  }, 0, `没有测试入口 → 诚实降级跳过（不是故障）：${PLAN.note}`)
}

// 要跑哪几步：构建 → 单测 → 冒烟（冒烟在 --quick 下跳过）
const wantsAll = ONLY.length === 0 && !UNIT_ONLY
// ★ 2026-10-06 止血②（审计实锤）：单测脚本被归为 kind='unit'，而卡里教审核员用 `--only build,test`
//    —— `ONLY.includes('unit')` 永远不命中 → **单测被静默跳过还报"全绿"**（假绿）。
//    给 'test' 加别名指向 'unit'，两种写法从此等价。
const want = (kind) => UNIT_ONLY ? kind === 'unit'
  : (ONLY.length ? (ONLY.includes(kind) || (kind === 'unit' && ONLY.includes('test')))
                 : (wantsAll ? (QUICK ? kind !== 'smoke' : true) : false))
const steps = []
if (PLAN.source === 'npm') {
  if (!scripts) {
    // 有 package.json 但解析不出来（BOM/语法错）⇒ 如实报"文件坏了"，**不许崩**，也不许当"没测试"
    writeResAndExit({ ok: false, reason: 'package.json 解析失败（可能是 BOM 或 JSON 语法错）', source: 'npm', ranAt: nowLocal(), steps: [] }, 2)
  }
  for (const [name, cmd] of Object.entries(scripts.scripts)) {
    if (!SAFE_PREFIX.test(name)) continue
    const kind = /^smoke/i.test(name) ? 'smoke' : /^test/i.test(name) ? 'unit' : name
    if (!want(kind)) continue
    if (kind === 'unit' && /^test/i.test(name) && Object.keys(scripts.scripts).some(k => /^test$/i.test(k)) && !/^test$/i.test(name)) {
      // 有 `npm test` 时，不同时跑 `test:xxx` 子集（避免同一次门禁把同一批用例跑两遍）
      continue
    }
    steps.push({ kind, name, cmd, exe: null, args: null })   // exe/args 为空 ⇒ 走 npm run <name>
  }
} else {
  for (const s of PLAN.steps) if (want(s.kind)) steps.push(s)
}
// 顺序：构建 → 单测 → 冒烟（冒烟最慢、最可能在环境上出问题，放最后）
// ★ 2026-10-26（§二）：`e2e` 排在**最后**（9）。入口验收要跑在"构建/单测都过了"之后 ——
//   否则它验的可能是一个还没构建完的半成品，绿了也不算数。
const order = { build: 0, lint: 1, typecheck: 1, check: 1, unit: 2, smoke: 3, e2e: 9 }
steps.sort((a, b) => (order[a.kind] ?? 2) - (order[b.kind] ?? 2) || a.name.localeCompare(b.name))

const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm'
if (PLAN.source === 'npm' && !resolveNpm()) {
  const res = { ok: false, reason: '找不到可用的 npm（PATH 上没有 npm.cmd/npm）—— 先装 Node.js 或把它加进 PATH', ranAt: nowLocal(), steps: [] }
  if (!NO_WRITE) { mkdirSync(GD, { recursive: true }); writeFileSync(RESULT, JSON.stringify(res, null, 2), 'utf8') }
  console.error(`[门禁] ❌ ${res.reason}`)
  process.exit(2)
}

// 并行度：构建/检查是 CPU 密集、单测/冒烟各自起进程 —— 串行跑 10 步会慢到没法用在"每波一跑"上。
// 口径：**构建/类型检查先串行跑完**（后面的步骤通常依赖编译产物），其余按并发上限并行。
// `--concurrency 1` 可退回全串行（排查"到底哪一步互相干扰"时用）。
const CONC = Math.max(1, Number(opt('concurrency', 3)))
const results = []

/**
 * ★ 2026-10-26（§零.1）：**本次门禁跑的是哪一份代码** —— 由 `契约/快照.mjs` 唯一计算。
 * 门禁/审核/done/交付门/入口 E2E 五处必须写同一个 `snapshotId`，所以这里绝不自算第二份。
 * 范围由项目 `gate.json` 的 `snapshot` 段声明（不配则用默认范围，排除 `_crew` 与证据文件）。
 */
const GATE_JSON = readGateJson(PROJECT, CWD)
const SNAPSHOT = NO_WRITE
  ? { snapshotId: null, manifestHash: null, count: 0, degraded: false, bigSkipped: 0, files: {}, scope: { declared: false, source: 'no-write', exclude: [], include: null } }
  : computeSnapshot({ project: PROJECT, gate: GATE_JSON?.data ?? null })

/** 把快照文件表按 CWD 子树投影成"被测文件 manifest"（唯一真相仍是快照，不另扫一遍） */
function projectManifestUnder (cwd) {
  const rel = relative(PROJECT, cwd).replace(/\\/g, '/')
  const prefix = rel ? rel + '/' : ''
  const files = {}
  let count = 0
  for (const [k, v] of Object.entries(SNAPSHOT.files ?? {})) {
    if (prefix && !k.startsWith(prefix)) continue
    files[k] = v
    count++
  }
  return { files, count }
}

console.log(`[门禁] 项目：${PROJECT}`)
console.log(`[门禁] 测试根目录：${CWD}（${scripts?.name ?? PLAN.source}）`)
globalThis.__GATE_SNAPSHOT__ = SNAPSHOT.snapshotId ?? ''
console.log(`[门禁] 快照：${SNAPSHOT.snapshotId ?? '(no-write)'}（${SNAPSHOT.count} 个受管文件${SNAPSHOT.degraded ? ' · 已降级' : ''}${SNAPSHOT.scope?.declared ? ' · 范围来自 gate.json' : ''}）`)
console.log(`[门禁] 要跑 ${steps.length} 步（并发 ${CONC}）：${steps.map(s => s.name).join(' → ') || '（没有可跑的）'}`)

/** 跑一步并归一化结果（供串行/并行两条路共用）。 */
async function runStep (s) {
  const timeoutMin = s.timeoutSec ? Math.max(1, Math.ceil(s.timeoutSec / 60))
    : s.kind === 'build' || s.kind === 'lint' || s.kind === 'typecheck' || s.kind === 'check' ? T_BUILD
      : s.kind === 'smoke' ? T_SMOKE : T_TEST
  const t0 = Date.now()
  // ★ 2026-10-21：步骤自带 exe/args（gate.json 或生态探测）时直接跑；否则回落到 `npm run <name>`
  const r = await runOne(s.name, s.exe ?? NPM, s.args ?? ['run', s.name], { timeoutMin })
  const secs = Number(((Date.now() - t0) / 1000).toFixed(1))
  const text = `${r.out}\n${r.err}`
  // 判定：非 0 退出 / 被杀 → 红。**不接受"看起来像成功"的猜测**。
  const ok = r.status === 0 && !r.timedOut
  // ★ 2026-10-21（通用化④）：**跑器本身没装** ≠ 测试红了。
  //   实测：Python 项目没装 pytest 时 `python -m pytest` 退出码 1、输出 "No module named pytest"，
  //   原来会被当成"单测红"→ 让人去修代码。那是在修一个不存在的问题。这里认出来标 env，由主流程按 exit 2 报。
  //
  // ★ 2026-10-26 修（负向自检抓到的**假环境**）：原来把任何 `ENOENT` 都当"跑器没装" ——
  //   实测：入口断了产物没写出来，测试自己 readFileSync 报 ENOENT，门禁却打印
  //   "测试跑器没装：这不是测试红了，是环境没准备好" ⇒ **真红被伪装成环境问题**。
  //   改判据：只有"**跑器/模块不可用**"才算 env；用户代码里的文件缺失一律算红。
  //     · ENOENT 只有在**出现于命令行程序名**（spawn 失败）时才算 env；正文里的不算。
  //     · `Cannot find module '<x>'`：x 是**包名**（不含 / \ 也不以 . 开头）才算 env；x 是路径 ⇒ 代码红。
  const ENV_HINTS = [
    /No module named\s+['"]?(\S+)/i,
    /is not recognized as an internal or external command/i,
    /不是内部或外部命令/i,
    /is not recognized as the name of a cmdlet/i,
    /command not found/i,
    /spawn\s+\S+\s+ENOENT/i
  ]
  let envHit = !ok ? ENV_HINTS.map(re => re.exec(text)).find(Boolean) : null
  if (!envHit && !ok) {
    const m = /Cannot find module ['"]([^'"]+)['"]/i.exec(text)
    const isBarePackage = m && !/[\\/]/.test(m[1]) && !m[1].startsWith('.')
    if (isBarePackage) envHit = m
  }
  const envMissing = envHit ? (envHit[1] ?? null) : null
  const unit = s.kind === 'unit' ? extractUnitSummary(text) : null
  const failures = ok ? [] : extractFailures(text)
  // 单测有失败数就以它为准（有些 runner 失败仍退 0）
  const okFinal = ok && !(unit && unit.failed)
  const step = {
    name: s.name, kind: s.kind, ok: okFinal, exitCode: r.status, timedOut: r.timedOut,
    signal: r.signal ?? null, tookSec: secs, unit, failures,
    env: !!envHit, envMissing,
    // ⚠️ 只留尾部：完整输出在 latest.log 里，不进摘要、不进上下文
    tail: text.trim().split(/\r?\n/).filter(Boolean).slice(-12).join('\n').slice(0, 1200)
  }
  // ★ 2026-10-26（§二）：入口 E2E 步骤**命令退出码 0 还不够** —— 必须有一条能解析、逐条断言为真、
  //   且绑定同一份快照的证据。缺证据/坏 JSON/ok:false/checks 空/degraded/产物不存在，一律判红。
  if (s.kind === 'e2e') {
    const evPath = resolveEvidencePath(PROJECT, s.evidence)
    const ev = s.evidence
      ? inspectEntryEvidence(evPath, { snapshotId: SNAPSHOT.snapshotId, project: PROJECT, requireArtifacts: true })
      : { ok: false, errors: ['gate.json 的 e2e 步骤没写 evidence（没有证据文件的入口验收等于没验）'], warnings: [], degraded: false, checks: [], artifacts: [] }
    step.e2e = {
      evidence: s.evidence ?? null,
      evidencePath: evPath,
      required: s.required !== false,
      ok: ev.ok,
      degraded: ev.degraded === true,
      checks: (ev.checks ?? []).map(c => ({ id: c?.id ?? null, ok: c?.ok === true, detail: c?.detail ?? null })),
      artifacts: ev.artifacts ?? [],
      entry: ev.entry ?? null,
      durationMs: ev.durationMs ?? null,
      errors: ev.errors ?? []
    }
    if (!ev.ok) {
      step.ok = false
      step.failures = [...(step.failures ?? []), ...(ev.errors ?? []).slice(0, 8)]
      step.env = false
    }
  }
  // 并行的实时日志会交错 → 每步跑完打**一整行**（不要用 process.stdout.write 的点号进度）
  console.log(`[门禁] ${step.ok ? '✅' : '❌'} ${s.name}　${secs}s${r.timedOut ? '（超时被掐断）' : ''}${unit ? `　${unit.passed ?? '?'} 通过 / ${unit.failed ?? 0} 失败` : ''}`)
  if (PRINT && !step.ok) console.log(text.trim().split(/\r?\n/).slice(-40).join('\n'))
  return step
}

// 构建/检查类**先串行跑完**（后面的步骤通常依赖编译产物）；其余按 CONC 并行。
// ★ 2026-10-26（§二）：**入口 e2e 最后串行跑** —— 它必须看到构建/单测都跑完之后的产物，
//   否则"整机能走通"证明的是一个还没构建完的半成品。它不是"再一个单测"，不能被并行穿插。
const preSteps = steps.filter(s => ['build', 'lint', 'typecheck', 'check'].includes(s.kind))
const e2eSteps = steps.filter(s => s.kind === 'e2e')
const restSteps = steps.filter(s => !preSteps.includes(s) && !e2eSteps.includes(s))
for (const s of preSteps) results.push(await runStep(s))

const queueSteps = [...restSteps]
const workers = Array.from({ length: Math.min(CONC, queueSteps.length) }, async () => {
  for (;;) {
    const s = queueSteps.shift()
    if (!s) return
    results.push(await runStep(s))
  }
})
await Promise.all(workers)
for (const s of e2eSteps) results.push(await runStep(s))
// 结果按"步骤计划顺序"重排，保证 latest.log / 摘要稳定（并发完成顺序是随机的）
const orderIdx = new Map(steps.map((s, i) => [s.name, i]))
results.sort((a, b) => (orderIdx.get(a.name) ?? 99) - (orderIdx.get(b.name) ?? 99))

const failed = results.filter(r => !r.ok)
// ★ 2026-10-21（通用化④）：跑器没装 ⇒ exit 2（环境/前置），**不许当成"测试红了"**
const envFailed = results.filter(r => r.env)
if (envFailed.length) {
  const miss = [...new Set(envFailed.map(r => r.envMissing).filter(Boolean))]
  const res = {
    ok: false, source: PLAN.source, envMissing: miss, ranAt: nowLocal(), steps: results,
    reason: `测试跑器没装：${miss.join('、') || envFailed[0].name} —— 这不是测试红了，是环境没准备好`,
    hint: '二选一：① 装上它（如 `pip install pytest`）② 在项目根写 gate.json 指定本机已有的跑器'
  }
  if (!NO_WRITE) { mkdirSync(GD, { recursive: true }); writeFileSync(RESULT, JSON.stringify(res, null, 2), 'utf8') }
  console.error(`[门禁] ❌ ${res.reason}`)
  console.error(`[门禁] ${res.hint}`)
  process.exit(2)
}
const unitStep = results.find(r => r.kind === 'unit')
const smokeSteps = results.filter(r => r.kind === 'smoke')
const summaryText = [
  unitStep?.unit?.tests ? `单测 ${unitStep.unit.passed ?? 0}/${unitStep.unit.tests}` : (unitStep ? `单测 ${unitStep.ok ? '过' : '红'}` : null),
  smokeSteps.length ? `冒烟 ${smokeSteps.filter(s => s.ok).length}/${smokeSteps.length}` : null,
  results.some(r => r.kind === 'build') ? `构建 ${results.find(r => r.kind === 'build').ok ? '过' : '红'}` : null
].filter(Boolean).join(' · ') || '（没跑任何步骤）'

// ★ 六·S3（绿灯自证身份）：落盘前先读"上一份"的 stamp（追溯"从哪份基线开始"），再算被测文件 manifest。
//   时刻口径＝**测试跑完时**（测试不改源树；若真被改，指纹会如实变化——这正是要看见的）。
let prevStamp = null
if (!NO_WRITE) { try { prevStamp = JSON.parse(readFileSync(RESULT, 'utf8'))?.stamp ?? null } catch {} }
const MANIFEST = NO_WRITE ? null : projectManifestUnder(CWD)
const SCOPE = UNIT_ONLY ? 'unit' : (ONLY.length ? ONLY.join(',') : (QUICK ? 'build+unit' : 'all'))

/**
 * ★ 2026-10-26（§二）：入口 E2E 汇总 —— 交付门只需要一个 `ok` 就能判放行，
 * 但人要看得见"跑了几条、哪条红、证据在哪"。所以这里把 e2e 步骤折成一段。
 * @returns {null | {declared:number, ran:number, ok:boolean, required:boolean, steps:object[], evidence:string[]}}
 */
function summarizeE2e () {
  const e2eSteps = results.filter(r => r.kind === 'e2e')
  if (!e2eSteps.length) return null
  const ok = e2eSteps.every(s => s.ok && s.e2e?.ok)
  return {
    declared: e2eSteps.length,
    ran: e2eSteps.length,
    ok,
    required: e2eSteps.some(s => s.e2e?.required !== false),
    steps: e2eSteps.map(s => ({
      name: s.name,
      ok: s.ok === true && s.e2e?.ok === true,
      evidence: s.e2e?.evidence ?? null,
      entry: s.e2e?.entry ?? null,
      checks: s.e2e?.checks?.length ?? 0,
      artifacts: s.e2e?.artifacts ?? [],
      errors: s.e2e?.errors ?? []
    })),
    evidence: e2eSteps.map(s => s.e2e?.evidence).filter(Boolean)
  }
}

/**
 * ★ b88（新问题稿 A 条）：把「收据外改动」一起写进门禁产物 —— 绿灯从此不只说"测试过了"，
 *   还能说"**这份绿之外，有没有人没走班组就动了源码**"（2026-10-12 那晚就是：门禁绿、run 0 条、
 *   6 个文件被改）。判据全在 `无收据改动.mjs`，这里只调它、不重写一遍。
 *   ⚠️ 纯增量：`--no-receipt-check` 关掉即回到今天的行为；扫一遍 ~60ms（只比 size+mtime）。
 */
let NO_RECEIPT = null
if (!NO_WRITE && !has('no-receipt-check')) {
  try {
    const r = spawnSync(process.execPath, [join(HERE, '无收据改动.mjs'), '--project', PROJECT, '--json'],
      { encoding: 'utf8', maxBuffer: 32 << 20, timeout: 120000, windowsHide: true })
    if (r.status === 0 || r.status === 2 || r.status === 3) {
      const j = JSON.parse(String(r.stdout ?? '').replace(/^\uFEFF/, ''))
      NO_RECEIPT = { state: j.state, count: j.counts?.unclaimedOpen ?? null, exempt: j.counts?.exempt ?? 0, files: (j.files ?? []).map((f) => f.path), windowFrom: j.window?.fromLocal ?? null, scope: j.scope ?? null }
    } else {
      const err = String(r.stderr ?? '').trim().split('\n').filter(Boolean).pop() ?? `exit=${r.status}`
      NO_RECEIPT = { state: 'unknown', why: err.slice(0, 160) }
    }
  } catch (e) { NO_RECEIPT = { state: 'unknown', why: String(e?.message ?? e).slice(0, 160) } }
}

const out = {
  schema: 1,
  project: PROJECT,
  cwd: CWD,
  ranAt: nowLocal(),
  stamp,
  // ★ 六·S3：ranBy 改由**编排层从环境注入**（`DSH_GATE_RANBY`，设于 编排.mjs / 派活.mjs 生成的命令行），
  //   命令行 `--by` 只作兜底 —— 从此"谁跑的"这栏不再是谁都能写的自由文本。
  ranBy: (process.env.DSH_GATE_RANBY ?? '').trim() || opt('by', '门禁.mjs'),
  // ★ 2026-10-26（§零.6）：统一信封字段 —— 消费方（交付门/体检/看板）据此判新鲜度，不再猜字段名
  kind: 'gate-result',
  at: new Date().toISOString(),
  source: '门禁.mjs',
  state: failed.length === 0 ? (PLAN.degraded ? 'unknown' : 'green') : 'red',
  stale: false,
  // ★ 2026-10-26（§零.1）：**唯一快照**。旧字段 `manifest` 保留为"被测子树投影"（审核三方比对用），
  //   `snapshot` 才是全项目口径，两者同源（都来自 `contracts/快照.mjs` 的这一次扫描）。
  snapshot: {
    snapshotId: SNAPSHOT.snapshotId,
    manifestHash: SNAPSHOT.manifestHash,
    count: SNAPSHOT.count,
    degraded: SNAPSHOT.degraded,
    bigSkipped: SNAPSHOT.bigSkipped,
    scope: SNAPSHOT.scope
  },
  scope: SCOPE,
  ok: failed.length === 0,
  summaryText,
  // ★ 2026-10-21（通用化④）：这次"测试入口"是从哪来的 —— npm / gate.json / python / go / … / none
  // ★ 2026-10-26：字段改名 `source → testSource`。`source` 现在归**信封**（= 写方文件名），
  //   否则同一份产物里 `source` 既表示"谁写的"又表示"测试入口从哪来"，消费方必然读错。
  testSource: PLAN.source,
  testEntry: PLAN.source === 'npm' ? 'package.json' : (PLAN.note ?? PLAN.source),
  degraded: !!PLAN.degraded,
  // ★ 2026-10-26（§二）：入口 E2E 汇总（`null` = 这个项目没声明 e2e 步骤）
  e2e: summarizeE2e(),
  // ★ manifest / inputs 为纯增量字段（删掉即回到今天的行为）；用途见 projectManifestUnder 注释
  manifest: MANIFEST?.files ?? {},
  // ★ b88：**收据外改动**（= 窗口期内被动过、却没有任何一轮收据/指纹覆盖的代码文件）。
  //   `null` ＝ 没算（`--no-write` / `--no-receipt-check`）；`{state,count,files,...}` ＝ 算过了。
  noReceipt: NO_RECEIPT,
  inputs: {
    scope: SCOPE,
    cwd: relative(PROJECT, CWD).replace(/\\/g, '/') || '.',
    only: ONLY,
    quick: QUICK,
    unitOnly: UNIT_ONLY,
    base: prevStamp,
    manifestCount: MANIFEST?.count ?? 0,
    manifestDegraded: MANIFEST?.degraded ?? false,
    manifestBigSkipped: MANIFEST?.bigSkipped ?? 0
  },
  steps: results,
  failures: failed.flatMap(f => f.failures.map(x => `${f.name}: ${x}`)).slice(0, 12),
  hint: failed.length === 0
    ? '全绿：可以往下走'
    : failed.some(f => f.timedOut)
      ? '有步骤被超时掐断 —— 先看是不是任务太大（拆小）或本机太忙，别急着当代码错'
      : '有红：按 failures 里的用例名去修，修完**重跑本脚本**（红→绿才算修好）'
}

if (!NO_WRITE) {
  mkdirSync(GD, { recursive: true })
  writeFileSync(RESULT, JSON.stringify(out, null, 2), 'utf8')
  // ★★ 2026-10-06 补（实测抓到的"假红灯"）：**门禁自己就把"给用户看的那一行"写掉**。
  //   原来只要 `编排.mjs` 的 runGate 会写 `<项目>\_crew\gate-status.json` ——
  //   于是**任何手动/单独跑的 `门禁.mjs` 都不会更新那一行**：
  //   实测现场 = 我手动跑门禁已全绿（8/8），而看板还挂着上一次的红灯（7/8），
  //   审核员修好的结果**在看板上看不见**（用户会以为还没修好）。
  //   现在：谁跑门禁谁刷新那一行（口径唯一 = 本次跑出来的结果）。
  const statusPath = join(PROJECT, '_crew', 'gate-status.json')
  try {
    writeFileSync(statusPath, JSON.stringify({
      at: out.ranAt, by: out.ranBy, ok: out.ok, summaryText: out.summaryText,
      failures: out.failures, hint: out.hint, scope: out.scope,
      line: out.ok ? `✅ 全绿（${out.summaryText}）` : `❌ 红了（${out.summaryText}）${out.failures?.[0] ? '：' + String(out.failures[0]).slice(0, 70) : ''}`
    }, null, 2), 'utf8')
  } catch (e) { console.warn(`[门禁] ⚠️ 看板状态行写不进去（不影响判定）：${String(e?.message ?? e)}`) }
  appendFileSync(HISTORY, JSON.stringify({ stamp, ranAt: out.ranAt, ranBy: out.ranBy, scope: out.scope, ok: out.ok, summaryText, failed: failed.map(f => f.name) }) + '\n', 'utf8')
  const logBody = [
    `# 门禁 ${out.ranAt} · ${out.ok ? '全绿' : '红了'} · ${summaryText}`,
    `跑的人/脚本：${out.ranBy}　范围：${out.scope}`,
    '',
    ...results.map(r => `## ${r.name} ${r.ok ? '✅' : '❌'}　exit=${r.exitCode}　${r.tookSec}s\n${r.tail}`),
    '',
    out.hint
  ].join('\n')
  writeFileSync(LATEST, logBody, 'utf8')
}

console.log(`\n[门禁] ${plainOneLine(out)}`)
if (failed.length) {
  // ⚠️ 这里必须打**实际算出来的 failures**（曾经打的是 out.failures，而构建红时它为空 →
  //   摘要变成"红了，但红在哪一片空白"，等于没用；红绿灯演练当场抓到）。
  const detail = out.failures.length ? out.failures : failed.map(f => `${f.name}: 退出码 ${f.exitCode}${f.timedOut ? '（超时）' : ''}`)
  console.log('[门禁] 红在哪（摘要，最多 12 条）：')
  for (const f of detail.slice(0, 12)) console.log('   · ' + f)
  console.log(`[门禁] 完整输出：${LATEST}`)
}
console.log(`[门禁] ${out.hint}`)
if (!NO_WRITE) console.log(`[门禁] 结果：${RESULT}`)

process.exit(failed.length === 0 ? 0 : 1)
