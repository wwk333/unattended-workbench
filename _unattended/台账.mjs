#!/usr/bin/env node
/**
 * 台账（ledger / orchestration book）—— 无人值守模式 · 第 4 步的脚手架
 *
 * 照 `无人值守模式-方案.md` §7 实现：
 *   契约先冻结 `PROJECT_BLUEPRINT.md`（接口契约 = 编码与验收的唯一依据）
 *   波次状态机 `TASKS.md` + 依赖图
 *   分工表 `分工表.md`（谁负责哪些文件/路径）
 *   待裁决 `待裁决.md`（分歧与用户裁定）
 *   交接 `HANDOFF.md`（极简指路 + 进度心跳）
 *
 * 子命令：
 *   init     建全套模板（已存在则不动，除非 --force）
 *   add      加一条任务（--id/--wave/--role/--goal/--deliverables/--depends/--accept）
 *   set      改任务状态（--id --status pending|ready|doing|review|done|blocked|dropped）
 *            ⛔ **进 `done` 必须有派活回执**（2026-10-12 用户拍板，见下面"收工门"）；
 *               确实不是派活干出来的（环境类/纯脑力/文档类）⇒ `--no-receipt "理由"` 放行并**留痕**
 *   ready    按依赖图算出"现在能开工"的任务（**无人值守时靠它决定派谁**）
 *   list     列表（可按 --wave 过滤）
 *   machine  机器区段（TASKS.md 末尾的 <!-- MACHINE {...} -->）：--json 给消费方读、--fix 重建、缺/坏 ⇒ exit 1
 *
 * ⚠️ TASKS.md 是**机器可解析**的：一行一条任务，格式固定 `- [状态] ID · 波次 · 角色 · 目标 · 依赖:... · 交付:...`
 *    所以**别手改这一行** —— 用 `set` 改状态。其余文件是给人看的，随便写。
 *
 * 用法：
 *   node 台账.mjs init --project "<工作台根>\workspaces\demo" --name demo
 *   node 台账.mjs add --project <P> --id T1 --wave W1 --role coder-a --goal "实现登录" --deliverables "src/auth/login.ts" --accept "npm test 全绿"
 *   node 台账.mjs set --project <P> --id T1 --status doing
 *   node 台账.mjs set --project <P> --id T1 --status done          # 必须先有派活回执，否则拒收
 *   node 台账.mjs set --project <P> --id T1 --status done --no-receipt "环境类，没有派活"
 *   node 台账.mjs ready --project <P>
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ★ 收工门（2026-10-12 用户拍板）—— **`done` 必须有派活回执，堵"标 done 却没人派活"**
 *
 * 为什么加（实测，不是假想）：2026-10-12 大脑把三个编码任务（T52/T53/T54）派给了 **DSH 原生 `subagent`**
 * （prompt 里还自称"编程班组（coder-a）"）⇒ 它们**没有任务卡、没有回执、没有信封、没有门禁、没有审核**，
 * 而台账里照样被标成 `[x] done`（`_crew\tasks\` 里一张 T5x 的卡都没有）⇒ 账本/看板/审核全对不上。
 * 根因是**口径**（原 `roles\brain.md` §29，**b195 起在 `roles\班组须知-细则.md` §4**：写文件的活必须走 `派活.mjs` → coder-a/coder-b），
 * 这道门是它的**机器侧兜底**：口径靠自觉，门靠脚本。
 *
 * 认什么当回执（任一命中即放行）：
 *   · `<项目>\_crew\tasks\<ID>.dispatch.json`（`派活.mjs` 落的任务卡收据）
 *   · `<项目>\_crew\runs\<stamp>\{tasks,review}\<ID>.{dispatch.json,out.json}`（编排/载具的回执与信封）
 *
 * 逃生口（**受限**，用户拍板要留）：`--no-receipt "为什么没有回执"` ⇒ 放行，但
 *   ① stderr 出声；② 落一份 `<项目>\_crew\tasks\<ID>.no-receipt.json` 留痕（可追溯，别偷偷放行）。
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// ★ 2026-10-21（通用化①）：可执行验收的解析口径搬到 `_验收.mjs` —— 读宽容、写规范，
//   不再只认反引号+箭头（实测：全盘 75 份收据只有 12 份真让机器跑过验收）。
import { parseExecAC, canonicalizeAccept, splitAccept } from './_验收.mjs'
// ★ 2026-10-25（§三「TASKS.md 变成生成视图」）：渲染口径搬到 `_台账视图.mjs`，
//   与 `_TASKS生成.mjs` **共用同一份实现** —— 否则"生成视图"和"台账写回"会各长一套，又是两个真相。
import { STATUSES, STATUS_MARK, nowText, sha1, stripMachine, extractMachine, UNMATCHED_HEAD, formatLine, renderTasksView } from './_台账视图.mjs'
import { syncTasksToState } from './_TASKS生成.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
const cmd = argv[0]
function opt (n, d = null) { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const has = (n) => argv.includes('--' + n)

const P = resolve(opt('project', process.cwd()))
const NAME = opt('name', P.split(/[\\/]/).pop())

/** 台账管的那几个文件（模板/视图/分工/裁决/交接） */
const FILES = {
  blueprint: join(P, 'PROJECT_BLUEPRINT.md'),
  tasks: join(P, 'TASKS.md'),
  crew: join(P, '分工表.md'),
  decisions: join(P, '待裁决.md'),
  handoff: join(P, 'HANDOFF.md')
}

// 机器区段（MACHINE）与状态枚举的实现在 `_台账视图.mjs`（与 `_TASKS生成.mjs` 共用一份）


// ---------------------------------------------------------------- 模板

/** A 轨道的**精简蓝图**。
 *  ★ 2026-10-05 修（坑库同型**复发**）：原来 `--track A` **故意不建蓝图**（"别拿流程压死小项目"），
 *  但**门1 读轨道只认两个地方**：① 蓝图里的 `轨道: X` 行 ② 任务行里的 `track` 字段 ——
 *  而 A 轨道两样都没有（任务行格式里压根没有 track 这一格）→ 门1 判"没定轨道" → **第一条任务必被拦**。
 *  （真项目没踩是因为它的蓝图是**大脑手写**的；用 `台账 init --track A` 快速起项目就必踩。）
 *  修法：**A 轨道也给一份最小蓝图** —— 机器要的只有 `轨道:` 那一行，其余留白。 */
function tplBlueprintA (name) {
  return `# 项目蓝图 · ${name}（轨道 A · 精简版）

轨道: A

> ⚠️ **上面这一行是机器读的，别删也别加粗**：门 1 的正则是 \`^\\s*轨道\\s*[:：]\\s*([A-Ea-e])\`，
> 写成 \`**轨道: A**\` 会因为行首是 \`*\` 而**匹配不到 → 第一条任务必被门 1 拦下**（实测踩过）。
> 取值 A/B/C/D/E：**A 轨道豁免字典与契约**（不建 \`DICT.md\` / \`CONTRACT*.md\`），只走对话两列清单。

## 一句话目标

（要做什么、给谁用、怎么算完成 —— A 轨道写清这一句就够）

> 生成：${nowText()}（脚手架模板；A 轨道故意只留最少的东西）
`
}

function tplBlueprint (name) {
  return `# 项目蓝图 · ${name}

> **这是接口契约的唯一出处。** 编码与验收都以本文为准；
> 契约冻结后任何改动都要先在这里改、并让用户确认（确认点①）。
> 生成：${nowText()}（脚手架模板，等内容填进来）

轨道: B

> ⚠️ **上面这一行是机器读的，别删也别加粗**：门 1 的正则是 \`^\\s*轨道\\s*[:：]\\s*([A-Ea-e])\`，
> 写成 \`**轨道: B**\` 会因为行首是 \`*\` 而**匹配不到 → 第一条任务必被门 1 拦下**（实测踩过）。
> 取值 A/B/C/D/E：A 轨道豁免字典与契约；非 A 轨道必须建 \`DICT.md\` 与带 \`C1\` 编号的 \`CONTRACT*.md\`。

## 1. 一句话目标

（要做什么、给谁用、成功长什么样）

## 2. 技术栈与约束

| 项 | 值 |
|---|---|
| 语言 / 框架 | |
| 运行环境 | |
| 测试入口 | （集成门禁跑的就是它） |
| 不许动的东西 | |

## 3. 模块划分

| 模块 | 负责文件/路径 | 谁做 | 依赖模块 |
|---|---|---|---|

## 4. 接口契约（**冻结前留足时间给用户挑毛病**）

\`\`\`ts
// 精确到函数签名 / 数据结构。这是并行开发的唯一前提：
// 契约不冻结，两个 coder 并行就是在制造返工。
\`\`\`

## 5. 波次划分

| 波次 | 内容 | 前置波次 |
|---|---|---|

## 6. 验收标准（硬条件，可勾选）

- [ ]

## 7. 用户确认记录

| 时间 | 确认了什么 | 结论 |
|---|---|---|
`
}

function tplTasks (name) {
  return `# 任务台账 · ${name}

> 状态机：\`pending → ready → doing → review → done\`，异常进 \`blocked\`，放弃进 \`dropped\`。
> **不要手改下面的任务行** —— 用 \`_unattended\\台账.mjs set --project "<本项目>" --id <ID> --status <状态>\`。
> 依赖图靠 \`依赖:T1,T2\` 解析；\`ready\` 子命令会算出"现在能开工"的。
> 最后更新：${nowText()}

## 任务

<!-- 格式固定：- [标记] ID · 波次 · 角色 · [级:Lx ·] 目标 · 依赖:… · 交付:… · 验收:… -->
<!-- 标记：空格=pending  r=ready  >=doing  ?=review  x=done  !=blocked  -=dropped -->
<!-- ↓↓ 下面两行是**样例**：标记 \`-\` ＝ 已放弃 ⇒ **永远不会被派出去**（留着也不花钱）。照它们的形状写你的卡，写完把这两行**直接删掉**（删掉不会报错）。 -->
- [-] T-样例1 · W1 · coder-a · 照这行的形状写你的任务卡 · 依赖:无 · 交付:src/example.ts · 验收:跑通
- [-] T-样例2 · W1 · coder-b · 依赖这一格怎么填：等上一张做完才会派 · 依赖:T-样例1 · 交付:src/example2.ts · 验收:跑通

## 波次汇总

（\`台账.mjs list\` 会给出实时汇总，这里只写稳定结论）

## 集成门禁（合并后必跑）

| 时机 | 命令 | 结果 |
|---|---|---|
| 每位 coder 合并后 | | |
`
}

function tplCrew (name) {
  return `# 分工表 · ${name}

> 一句话：**谁负责哪些文件/路径**。covers 是"能改"的范围；越界就是违约，集成时按 diff 追究。

| 角色 | 模型 | 工作目录 | 负责的文件 / 路径 | 不许碰 |
|---|---|---|---|---|
| coder-a | deepseek-v4.1-flash | 主树（无 worktree） | | |
| coder-b | glm-5.3-flash | 主树（无 worktree） | | |
| reviewer | Kimi-K3 | 主树（**可写 · 四条护栏**） | **判读门禁结果 + 只复跑红的那条 + 修 bug（每修一个补一条回归测试）** | 契约文件 / 越界改动 / 改测试换绿 |
| 大脑 | — | 主树 | 集成、提交、台账、落库 | 业务代码（软约束） |

> ⚠️ 本表是**占位模板**，真值以 \`_crew\\agents.json\`（含 \`route\` / \`worktree\` 字段）为准。
> 两个 coder 的载体是 DSH headless，**没有 \`--worktree\`**，所以工作目录写主树；
> 隔离靠"负责的文件 / 路径"这一列 + 模块所有权 + 集成门禁。

## 越界与打回记录

| 时间 | 谁 | 越界内容 | 处置 |
|---|---|---|---|
`
}

function tplDecisions (name) {
  return `# 待裁决 · ${name}

> 三区，别合并：§1 等你拍板；§2 已经定了的（只增不改）；§3 看见了但没处理的（记录在案）。
> 格式唯一来源＝SOP 源 \`待裁决-模板.md\`；细则/词典只许写"见模板"，不许复述列名。

三条硬规矩
1. 每条决策必须写清"为什么 + 代价"，没有代价的决策等于没记。
2. §2 不许改：只许加新行，并在旧行状态标"被取代 by Dn"。
3. 裁定当轮就落，不攒到收尾。

## 1 要你拍板的

| # | 时间 | 问题 | 选项 A | 选项 B | 我的建议 | 用户裁定 |
|---|---|---|---|---|---|---|

## 2 已经自决的

| # | 时间 | 事项 | 我的决定 | 理由（含代价） |
|---|---|---|---|---|

## 3 感知到但没处理的

`
}

function tplHandoff (name) {
  return `# HANDOFF · ${name}

> **重启后接手的人只看这一段就够。** 每完成一个子步就改"现在在哪"。
> 生成：${nowText()}

## 现在在哪（← 唯一权威）

| 项 | 值 |
|---|---|
| 当前波次 | |
| 正在做的任务 | |
| 最后完成的事 | |
| 下一步做什么 | |
| 卡在哪 / 等谁 | |
| 回滚怎么做 | |

## 一键命令

\`\`\`powershell
# 看板（数据 + 页面）
# ⚠️ 2026-10-03：采集器（看板采集器.mjs）没随迁移进新家，旧家 E: 已弃用 → 面板暂无数据。
#    这是"看板管线的引用"而不是"看板本身"：新家重做看板后，把下面这行的 # 去掉即可。
# & <DSH根>\\...\\node.exe <工作台根>\\_unattended\\看板采集器.mjs
# 现在能开工的任务
& <DSH根>\\...\\node.exe <工作台根>\\_unattended\\台账.mjs ready --project "${P}"
# 账号自检（派活前必过）
& <DSH根>\\...\\node.exe <工作台根>\\_unattended\\账号自检.mjs
\`\`\`

## 已入知识库

- （本波次新增的坑写这里：已入知识库：\`[[文件名]]\`）
`
}

// ---------------------------------------------------------------- TASKS.md 读写

// ---------------------------------------------------------------- 可执行验收标准（executable AC）
//
// ★ 2026-10-05 新增（用户拍板的三条改造之一：**"做完"和"验过"必须分开**）。
//
// 背景（这是本工作台最大的一处空转）：
//   任务行里的 `验收:` 一直是**一句中文**（例：`npm run smoke:auth十条全绿`）。
//   编排收活只看**信封**（退出码 / is_error / 上下文占用 / 文件指纹），
//   于是"这活到底验过没有"完全靠 coder 自己说 —— 全仓没有任何代码去跑那句话。
//
// 现在的写法（写在 `--accept` 里，和中文条目混用没问题）：
//   `命令`                      → 只要求退出码 0
//   `命令` => 期望串            → 退出码 0 且输出里必须含这个串（大小写不敏感）
//   例：--accept "`npm run test -- --run test/account-repo.test.ts` => passed,单测补齐"
//   ⚠️ 命令用**反引号**包住，内部的逗号不会被当成分隔符（`splitAccept` 专门绕开）。
//
// 纪律：
//   ① **只跑任务自己声明的命令**，白名单词首（npm/npx/node/python/py/dotnet/tsx/vitest/pwsh）——
//      台账不是通用 shell，别指望它跑任意东西；
//   ② 跑之前**必须确认任务已经在 doing/review**（防止拿它当"随便跑跑"的工具）；
//   ③ 单命令超时默认 10 分钟（`--timeout-min` 可调），超时判红并如实记录；
//   ④ 结果写 `<项目>\_crew\gate\ac-<ID>.json` + 追加进 `history.jsonl`（红→绿证据链）。
const AC_RE = null   // ★ 2026-10-21：解析口径已搬到 `_验收.mjs`（本文件不再自己写正则）

/** 真的跑一条 AC：不接管道、不 shell 拼串（除了 Windows 的 .cmd 必需）、到点杀进程。 */
function runAC (cmd, { cwd, timeoutMin = 10 }) {
  const started = Date.now()
  const isWin = process.platform === 'win32'
  const isCmdShim = isWin && /^(npm|npx)$/i.test(cmd.split(/\s+/)[0])
  // Windows 上 npm/npx 是 .cmd 批处理 → 裸 spawn 报 EINVAL（本工作台 2026-10-05 实测），
  // 只有这种白名单词首才允许借 shell；其余一律直接 spawn。
  const r = isCmdShim
    ? spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMin * 60_000, windowsHide: true, maxBuffer: 32 << 20, env: { ...process.env, CI: '1', NO_COLOR: '1' } })
    : (() => {
        const [exe, ...args] = cmd.split(/\s+/)
        return spawnSync(exe, args, { cwd, encoding: 'utf8', timeout: timeoutMin * 60_000, windowsHide: true, maxBuffer: 32 << 20, env: { ...process.env, CI: '1', NO_COLOR: '1' } })
      })()
  const text = `${r.stdout ?? ''}\n${r.stderr ?? ''}`
  const timedOut = r.error?.code === 'ETIMEDOUT'
  return { status: r.status, timedOut, errorCode: r.error?.code ?? null, text, tookSec: Number(((Date.now() - started) / 1000).toFixed(1)) }
}

/** 判定一条 AC：退出码 0（+ 期望串命中）。**期望串没命中就是红**，不解释、不宽容。 */
function judgeAC (ac, run) {
  const okExit = run.status === 0 && !run.timedOut
  const hit = ac.expect ? run.text.toLowerCase().includes(ac.expect.toLowerCase()) : true
  return {
    cmd: ac.cmd, expect: ac.expect, ok: okExit && hit, exitCode: run.status, timedOut: run.timedOut,
    tookSec: run.tookSec,
    why: !okExit
      ? (run.timedOut ? `超时被掐断` : `退出码 ${run.status ?? '?'}${run.errorCode ? `（${run.errorCode}）` : ''}`)
      : (hit ? '退出码 0 且期望串命中' : `退出码 0 但输出里没有期望串「${ac.expect}」`),
    tail: run.text.trim().split(/\r?\n/).filter(Boolean).slice(-8).join('\n').slice(0, 800)
  }
}

/** 跑一条任务的**全部**可执行 AC；返回结构化结果（编排与审核员都读这个）。 */
function checkTaskAC (t, { cwd, quiet = true, write = true } = {}) {
  const execs = (t.accept ?? []).map(parseExecAC).filter(Boolean)
  if (!execs.length) {
    return { task: t.id, cwd, ranAt: nowText(), ranBy: '台账.mjs ac', ok: null, machineVerified: false, checks: [], hint: '这条任务没有可执行 AC → **未机器验证**（只有中文验收标准）' }
  }
  const checks = []
  for (const ac of execs) {
    if (!quiet) console.log(`[台账] ▶ ${t.id}：${ac.cmd}${ac.expect ? `　期望含「${ac.expect}」` : ''}`)
    const run = runAC(ac.cmd, { cwd, timeoutMin: Number(opt('timeout-min', 10)) })
    const j = judgeAC(ac, run)
    checks.push(j)
    if (!quiet) console.log(`        ${j.ok ? '✅' : '❌'} ${j.tookSec}s　${j.why}`)
  }
  const failed = checks.filter(c => !c.ok)
  const out = {
    task: t.id, cwd, ranAt: nowText(), ranBy: '台账.mjs ac', ok: failed.length === 0, machineVerified: true,
    checks, failures: failed.map(c => `${c.cmd} → ${c.why}`).slice(0, 8),
    hint: failed.length === 0 ? 'AC 全过' : 'AC 红了 → **不许进 done**：照 why 里的原因修，修完重跑'
  }
  if (write) {
    try {
      const gd = join(P, '_crew', 'gate')
      mkdirSync(gd, { recursive: true })
      writeFileSync(join(gd, `ac-${t.id}.json`), JSON.stringify(out, null, 2), 'utf8')
    } catch (e) { console.log(`  ⚠️ AC 结果写不进文件（不影响判定）：${String(e?.message ?? e)}`) }
  }
  return out
}

const LINE_RE = /^- \[(.)\]\s+(\S+)\s+·\s*([^·]*)\s*·\s*([^·]*)\s*·\s*([^·]*)\s*·\s*依赖:([^·]*)\s*·\s*交付:([^·]*)\s*·\s*验收:(.*)$/
// ★ 2026-10-16（任务分级 L1–L4，KB 重构\任务分级-施工文档.md §7-4）：
//   **可选**字段 `级:L2`，写在哪都行（建议紧跟角色后面）——老行没有它 ⇒ `level = null`（＝今天的行为，零迁移）。
//   取值只认 L1..L4（单项覆盖 `L2+slim` 也收，取级号那一段）；不认识的值**如实留 null**（不猜、不归一到默认档）。
const LEVEL_IN_LINE = /(?:\s*·\s*)?级:\s*(L?[1-4](?:\+[A-Za-z]+)?)(?=\s*·|\s*$)/
function extractLevel (line) {
  const m = LEVEL_IN_LINE.exec(String(line))
  if (!m) return { level: null, line: String(line) }
  const lm = /^L?([1-4])/.exec(m[1].toUpperCase())
  const iso = /\+([A-Za-z]+)/.exec(m[1])
  // 整段（含它前面那个 ` · ` 分隔符）一起摘掉 —— 否则会留下一个空段，严格定长正则认不出（实测踩过）。
  return { level: lm ? 'L' + lm[1] + (iso ? '+' + iso[1].toLowerCase() : '') : null, line: String(line).replace(LEVEL_IN_LINE, '') }
}

/**
 * 宽松解析：把**常见的手写/粘贴偏差**归一成标准形状，再交给严格正则。
 *
 * ★ 2026-10-06 新增（三方交叉验证共同确认的"静默删行"根因之一）：
 *   实测三种偏差会让整行**解析失败**，而失败的行会在下一次 `set/add` 触发全量重写时**被物理删除**
 *   （我复现过：写进去 6 行，改一条状态后只剩 3 行，命令一个字都没提示）：
 *     ① 段间**少空格**：`- [ ] T4·W1·coder-a·…`（`·` 两侧没空格）
 *     ② **全角冒号**：`依赖：无`（应为 `依赖:无`）
 *     ③ **缺段**：没有 `· 验收:…` 那一段
 *   归一**只做这三类**（不改字段内容、不猜语义）；归不动的仍然算"认不出"，但**再也不会被删**（见 readTasks）。
 */
function normalizeTaskLine (line) {
  let s = String(line).trim()
  if (!s.startsWith('- [')) return s
  s = s.replace(/[：]/g, ':')                 // ② 全角冒号 → 半角（只影响字段名分隔，不改正文里的中文冒号？—— 见下）
  s = s.replace(/\s*·\s*/g, ' · ')             // ① 段间统一成 " · "
  // ③ 缺尾段：补齐到 7 段（ID · 波次 · 角色 · 目标 · 依赖 · 交付 · 验收）
  const segs = s.split(' · ')
  // ★ 2026-10-16（任务分级）：`级:` 段先摘出来、最后**固定插在角色之后**（老写法可能把它塞在别处，
  //   而严格正则的段序是 依赖→交付→验收 ⇒ 位置不固定会被判"认不出"）。
  const lvSegs = segs.filter(x => /^级:/.test(x))
  const rest = segs.filter(x => !/^级:/.test(x))
  const hasDep = rest.some(x => /^依赖:/.test(x))
  const hasDel = rest.some(x => /^交付:/.test(x))
  const hasAcc = rest.some(x => /^验收:/.test(x))
  if (!hasDel && hasDep) rest.splice(rest.indexOf(rest.find(x => /^依赖:/.test(x))) + 1, 0, '交付:无')
  if (!hasAcc) rest.push('验收:无')
  if (!hasDep) rest.splice(3, 0, '依赖:无')
  // 段序：[0]=ID [1]=波次 [2]=角色 [3]=目标 [4]=级号(可空) [5]=依赖 [6]=交付 [7]=验收
  if (lvSegs.length) rest.splice(4, 0, lvSegs[0])
  s = rest.join(' · ')
  return s
}

/**
 * 读任务台账。
 * ★ 2026-10-06 改（**最重要的一处**）：返回 `{ tasks, unmatched }` ——
 *   认不出的行**原样带出来**，由 `writeTasks` 回写到"未识别"区，**绝不静默丢弃**。
 *   为什么必须这样：`writeTasks` 是**全量重写**，原来只回写解析成功的行 ⇒
 *   一行格式偏的任务会在下一次任何 `set/add` 时**物理消失**，而且账面看不出来（本项目不用 git，没有后悔药）。
 *   ⚠️ 兼容：老的调用方只想要数组，所以仍然导出一个 `readTasks()` 薄包装（见下）。
 */
/**
 * ★ 2026-10-24（施工文档 §10.2 ②）：**像任务卡、却没写勾选框**的行怎么认。
 *
 * 为什么要有（实测事故，不是推演）：模板原来 `## 任务` 区**一行卡都没有**，大脑就照着"文档的样子"
 *   写了 **49 张卡**（`### T0000 · L3 · 构建器` 标题 ＋ `- **依赖**：…` 之类的字段），
 *   **一张都没有 `- [ ]`** ⇒ 解析器把它们当普通正文 `continue` 掉 ⇒ 台账 0 条、编排 0 条、
 *   **一个字都不报**。"活干了、账没有"的入口就在这里：**静默归零**。
 *
 * 判据（宁可少报，不许瞎报；**只读**，绝不改正文）：
 *   ① `### T0000 · L3 · 构建器` —— 卡标题带级号（2026-10-24 事故就是这 49 行）
 *   ② `- T1 · W1 · coder-a · 目标 · 依赖:…` —— 任务行结构齐全，唯独少了勾选框
 * 排除：`>` 引用、`<!-- -->` 注释、`|` 表格行，以及**已经带勾选框的合法行**（那不是"疑似"，是正经卡）。
 */
const SUSPECT_RES = [
  /^#{1,4}\s+\S+\s+·\s*L[1-4]\b/,
  /^[-*]\s+.*·.*(?:依赖|验收)\s*[:：]/
]
/** 行尾的 `<!-- ⚠️ … -->` 标记（"未识别" / "没写勾选框" 都会贴），回读时先剥掉，免得越叠越多。 */
const MARKER_TAIL = /(?:\s*<!--\s*⚠️\s*[^>]*?-->)+$/
const stripMarker = (line) => String(line).replace(MARKER_TAIL, '').trim()
function isSuspectLine (raw) {
  const line = String(raw).trim()
  if (!line || line.startsWith('>') || line.startsWith('<!--') || line.startsWith('|')) return false
  if (/^-\s*\[.\]/.test(line)) return false      // 已经是正经任务行 ⇒ 不是"疑似"
  return SUSPECT_RES.some(re => re.test(line))
}

function readTasksFull () {
  if (!existsSync(FILES.tasks)) return { tasks: [], unmatched: [], suspects: [] }
  const text = readFileSync(FILES.tasks, 'utf8')
  const tasks = []
  const unmatched = []
  const suspects = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    // 只关心"看起来像任务行"的（`- [x] …`）；空行、标题、说明文字一律不动也不报
    if (!/^-\s*\[.\]\s/.test(line)) {
      if (isSuspectLine(line)) suspects.push(stripMarker(line))
      continue
    }
    const lv = extractLevel(line)                      // 级号可出现在任意位置（独立判定，不参与严格定长正则）
    const m = LINE_RE.exec(lv.line) ?? LINE_RE.exec(normalizeTaskLine(lv.line))
    // ★ 2026-10-09 八·S6 连带修：回读时**剥掉"未识别"标记**（`<!-- ⚠️ 未识别 -->`）——
    //   否则每写一轮就被再贴一层（实测叠出两枚），而且标记里的 `-->` 会**炸掉机器区段的边界**
    //   （区段用 `-->` 收口，数据里再出现一个就提前截断）。
    if (!m) { unmatched.push(line.replace(/(?:\s*<!--\s*⚠️\s*未识别\s*-->)+$/, '').trim()); continue }
    const mark = m[1]
    const status = Object.entries(STATUS_MARK).find(([, v]) => v === mark)?.[0] ?? 'pending'
    tasks.push({
      status, mark, id: m[2].trim(), wave: m[3].trim(), role: m[4].trim(), goal: m[5].trim(),
      level: lv.level,                                   // ★ 任务分级：L1..L4（可带 +覆盖），没写＝null
      depends: m[6].trim() === '无' ? [] : m[6].split(',').map(s => s.trim()).filter(Boolean),
      deliverables: m[7].trim() === '无' ? [] : m[7].split(',').map(s => s.trim()).filter(Boolean),
      // ★ 2026-10-05：验收标准改走 `splitAccept` —— **反引号包住的命令里的逗号不算分隔符**，
      //   否则 `--accept "`npm run test -- --run a,b`"` 这种会被切碎（可执行 AC 立刻失效）。
      accept: m[8].trim() === '无' ? [] : splitAccept(m[8])
    })
  }
  return { tasks, unmatched, suspects }
}

/** 兼容包装：只要任务数组的调用方（`ready`/`list` 等）继续用这个。 */
function readTasks () { return readTasksFull().tasks }

// 认不出的行抬头（`UNMATCHED_HEAD`）与行渲染（`formatLine`）已搬到 `_台账视图.mjs` —— 与生成视图共用一份。

function writeTasks (tasks, headerText, quiet = false) {
  return writeTasksAsync(tasks, headerText, quiet)
}

/**
 * 写 TASKS.md —— **先落库，再渲染**（§三：TASKS.md 是生成视图，不是第二真相）
 *
 * 顺序不能反：
 *   ① `syncTasksToState()` 把这次变更写进 C 状态库（带版本 + 幂等键）；
 *   ② 从库里**回读**任务，交给 `_台账视图.renderTasksView()` 渲染；
 *   ③ 原子落盘（tmp + rename，别让看板读到半个文件）。
 * 服务不可用 ⇒ 抛 `StateUnavailable`，**不写文件**（fail-closed）。
 * 原来那条"直接拼字符串写文件"的路已删除：留着它就是两个真相。
 */
async function writeTasksAsync (tasks, headerText, quiet = false) {
  const stateTasks = await syncTasksToState({ project: P, tasks })
  const prevText = existsSync(FILES.tasks) ? readFileSync(FILES.tasks, 'utf8') : null
  const { unmatched, suspects } = readTasksFull()
  const rendered = renderTasksView({
    tasks: stateTasks,
    prevText,
    headerText,
    name: NAME,
    unmatched,
    suspects,
    template: tplTasks(NAME),
    generatedFrom: '_crew/state/crew.db'
  })
  const tmp = FILES.tasks + '.tmp-' + process.pid
  writeFileSync(tmp, rendered.full, 'utf8')
  renameSync(tmp, FILES.tasks)
  if (unmatched.length && !quiet) {
    console.log(`[台账] ⚠️ 有 ${unmatched.length} 行**没认出来**（已原样保留在"未识别"区，没删）：`)
    for (const l of unmatched.slice(0, 5)) console.log(`        ${l.slice(0, 110)}`)
    if (unmatched.length > 5) console.log(`        …还有 ${unmatched.length - 5} 行（见 TASKS.md 的"未识别"区）`)
  }
  if (suspects.length && !quiet) {
    console.log(`[台账] ⚠️ 有 ${suspects.length} 行**像任务卡、却没写勾选框**（\`- [ ]\`）⇒ 机器认不出，等于这张卡没写：`)
    for (const l of suspects.slice(0, 3)) console.log(`        ${l.slice(0, 110)}`)
    if (suspects.length > 3) console.log(`        …还有 ${suspects.length - 3} 行`)
    console.log('        正确形状：`- [ ] T1 · W1 · coder-a · 目标 · 依赖:无 · 交付:a.ts · 验收:跑通`')
  }
}

/** 依赖是否都已完成。 */
function depsSatisfied (t, byId) {
  return t.depends.every(d => byId.get(d)?.status === 'done')
}

// ---------------------------------------------------------------- 子命令

async function cmdInit () {
  if (existsSync(FILES.tasks) && !has('force')) {
    console.log(`[台账] 已存在，未改动：${FILES.tasks}（要覆盖加 --force）`)
    return
  }
  mkdirSync(P, { recursive: true })
  const made = []
  const put = (path, content) => {
    if (existsSync(path) && !has('force')) return
    writeFileSync(path, content, 'utf8'); made.push(path)
  }

  // 按轨道决定建哪几份（SOP v3.0 §二① 轨道表）：
  //   A 快速（练手/小脚本/一次性工具）：**不建字典、不建契约**，只要 HANDOFF + 台账 + 待裁决，免得小项目被流程压死。
  //   B/C：三件套（蓝图含契约段 + 台账 + 分工表 + 待裁决 + HANDOFF）。
  //   D/E：另提示"按领域拆 DICT-*.md / 按模块拆 CONTRACT-*.md"（拆出来的文件由大脑建，台账不预铺空文件）。
  const track = (opt('track', 'B') || 'B').toUpperCase()
  if (!'ABCDE'.includes(track)) { console.error(`[台账] --track 只能是 A/B/C/D/E，收到：${track}`); process.exit(1) }

  if (track === 'A') {
    put(FILES.blueprint, tplBlueprintA(NAME))   // ★ 2026-10-05 修：A 轨道**也要建蓝图**（就为那一行 `轨道: A`）——
                                                //   否则门1 读不到轨道 → 第一条任务必被拦（坑库同型复发）
    put(FILES.handoff, tplHandoff(NAME))
    put(FILES.tasks, tplTasks(NAME))
    put(FILES.decisions, tplDecisions(NAME))   // ★ 全轨都建：细则 :497「其余一律自己拍板、写进 待裁决.md」无轨道限定
  } else {
    put(FILES.blueprint, tplBlueprint(NAME))
    put(FILES.tasks, tplTasks(NAME))
    put(FILES.crew, tplCrew(NAME))
    put(FILES.decisions, tplDecisions(NAME))
    put(FILES.handoff, tplHandoff(NAME))
  }

  // ★ 八·S5：新台账一建好就补上机器区段（读方"读不到就报错"，所以初始就得有）。
  if (made.includes(FILES.tasks)) { const { tasks } = readTasksFull(); await writeTasks(tasks, undefined, true) }
  console.log(`[台账] 项目：${P}（${NAME}）　轨道：${track}`)
  for (const m of made) console.log('   + ' + m)
  console.log(`[台账] 共 ${made.length} 个文件（已存在的没动）`)
  if (track === 'A') console.log('   · 轨道 A：按 SOP §二① **不建 DICT/CONTRACT**，字典在对话里快查；跨会话才写 HANDOFF-会话1.md\n     ★ 已附一份**精简蓝图**（只为让门1 读到 `轨道: A` —— 原来不建蓝图会导致第一条任务被门1 拦下）')
  if (track === 'D' || track === 'E') console.log(`   · 轨道 ${track}：DICT 要**按领域拆**成 DICT-领域.md、CONTRACT 要**按模块拆**成 CONTRACT-模块.md（由大脑在②③步建，这里不预铺空文件）`)
  if (track === 'B' || track === 'C') console.log(`   · 轨道 ${track}：字典/契约都是**单文件**（DICT.md / CONTRACT.md），有行数上限，见规则书 §八`)
}

async function cmdAdd () {
  const id = opt('id')
  if (!id) { console.error('缺 --id'); process.exit(1) }
  const tasks = readTasks()
  if (tasks.some(t => t.id === id)) { console.error(`[台账] ID 已存在：${id}（状态机不允许重复 ID）`); process.exit(1) }
  const t = {
    status: opt('status', 'pending'),
    id,
    wave: opt('wave', 'W1'),
    role: opt('role', 'coder-a'),
    level: extractLevel(' 级:' + String(opt('level', '') || '').trim()).level,   // ★ 任务分级：--level L2（缺/不合法 ⇒ null，不猜）
    goal: opt('goal', '（未填）'),
    depends: (opt('depends', '') || '').split(/[,;，；]/).map(s => s.trim()).filter(Boolean),
    deliverables: (opt('deliverables', '') || '').split(/[,;，；]/).map(s => s.trim()).filter(Boolean),
    accept: splitAccept(opt('accept', '')).map(canonicalizeAccept)
  }
  if (!STATUSES.includes(t.status)) { console.error(`未知状态：${t.status}`); process.exit(1) }
  for (const d of t.depends) if (!tasks.some(x => x.id === d)) { console.error(`[台账] 依赖的 ${d} 不存在（先加它）`); process.exit(1) }
  tasks.push(t)
  await writeTasks(tasks)
  console.log(`[台账] + ${t.id}（${t.wave} / ${t.role} / ${t.status}）依赖 ${t.depends.join(',') || '无'}`)
}

/**
 * 找这条任务的**派活回执**（收工门用，见文件头「收工门」）。
 * 认两种落法：`_crew\tasks\<ID>.dispatch.json` 与 `_crew\runs\<stamp>\{tasks,review}\<ID>.{dispatch.json,out.json}`。
 * 命中返回 `{ok:true, path}`；没命中返回 `{ok:false, tried}`（tried 原样打给用户，好让他自己核）。
 */
function findReceipt (id) {
  const tried = []
  const direct = join(P, '_crew', 'tasks', id + '.dispatch.json')
  tried.push(direct)
  if (existsSync(direct)) return { ok: true, path: direct, tried }
  const runs = join(P, '_crew', 'runs')
  tried.push(join(runs, '*', '{tasks,review}', id + '.{dispatch.json,out.json}'))
  let stamps = []
  try { stamps = readdirSync(runs) } catch { return { ok: false, tried } }
  for (const st of stamps) {
    for (const sub of ['tasks', 'review']) {
      const d = join(runs, st, sub)
      let files = []
      try { files = readdirSync(d) } catch { continue }
      for (const f of files) {
        if (f !== id + '.dispatch.json' && f !== id + '.out.json') continue
        return { ok: true, path: join(d, f), tried }
      }
    }
  }
  return { ok: false, tried }
}

/**
 * ★ 2026-10-23（施工文档 D7）：**没有绿收据不许 done**。
 *
 * 为什么要有（实测代价）：T1-03 的唯一判决是 `filtered`（红），`_crew\gate\` 里**没有它的 AC 收据**，
 *   但台账里是 `[x] done`。那天这张卡恰好代码是好的（`check_T1_03.py` 复跑 18/0），**那是运气，不是机制**。
 *
 * 三条口径（与施工文档那张表一一对应）：
 *   ① 有 `ok=true` 的 `ac-<卡>.json` ⇒ 允许（有机器签字）；
 *   ② 最新收据里这张卡是红的（`filtered` / `ac-red` / `ac-unknown` / `ac-env` / `ac-missing` / `thinking-overflow-final` / `blocked` 系）
 *      且**没有绿收据** ⇒ 拒绝；
 *   ③ 显式人工放行 `--waive "原因"` ⇒ 允许，**必须留痕**（`_crew\waivers.jsonl`，一行一条）。
 * ⚠️「压根没有可执行 AC 的项目」**不在这里变砖**：那种卡本来就没有绿收据可言，沿用旧的"必须有派活回执"那道门
 *   （要严格化的项目在 `gate.json` 里写 `requireAC:true`，那由编排的 AC 机判挡）。
 */
const WAIVE_FILE = () => join(P, '_crew', 'waivers.jsonl')
const RED_VERDICTS = new Set(['filtered', 'ac-red', 'ac-unknown', 'ac-env', 'ac-missing', 'thinking-overflow-final', 'denied', 'timeout', 'flaky-twice', 'rescue-failed', 'review-overreach'])

function readAcReceipt (id) {
  try { return JSON.parse(readFileSync(join(P, '_crew', 'gate', `ac-${id}.json`), 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}
/** 最近 5 轮收据里这张卡的**最后一次**判决（读不到返回 null —— 不猜）。 */
function lastVerdictOf (id) {
  try {
    const runs = join(P, '_crew', 'runs')
    const dirs = readdirSync(runs, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().slice(-5).reverse()
    for (const d of dirs) {
      const f = join(runs, d, 'verdict.json')
      if (!existsSync(f)) continue
      let j; try { j = JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
      const hit = (j.results ?? []).find(r => String(r.task) === String(id))
      if (hit) return { verdict: String(hit.verdict ?? ''), at: j.stamp ?? d, ac: hit.ac ?? null, action: hit.action ?? null }
    }
  } catch { /* 读不到就当没有 */ }
  return null
}
function appendWaiver ({ task, reason, by, receipt }) {
  try {
    mkdirSync(join(P, '_crew'), { recursive: true })
    const line = JSON.stringify({ task, at: new Date().toISOString(), reason: String(reason), by: by ?? '大脑', receipt: receipt ?? null }) + '\n'
    appendFileSync(WAIVE_FILE(), line, 'utf8')
    return true
  } catch { return false }
}

async function cmdSet () {
  const id = opt('id'); const status = opt('status')
  if (!id || !status) { console.error('缺 --id 或 --status'); process.exit(1) }
  if (!STATUSES.includes(status)) { console.error(`未知状态：${status}（可用：${STATUSES.join('/')}）`); process.exit(1) }
  const tasks = readTasks()
  const t = tasks.find(x => x.id === id)
  if (!t) { console.error(`[台账] 没这个任务：${id}`); process.exit(1) }
  if (status === 'doing') {
    const byId = new Map(tasks.map(x => [x.id, x]))
    if (!depsSatisfied(t, byId)) {
      console.error(`[台账] ❌ 拒绝开工：${id} 的依赖还没完成（${t.depends.filter(d => byId.get(d)?.status !== 'done').join('、')}）`)
      process.exit(1)
    }
  }
  // ★ 收工门（2026-10-12 用户拍板 · 见文件头「收工门」）：**进 done 必须有派活回执**。
  //   动机是实测：编码活被交给 DSH 原生 subagent 干，标 done 时**没有卡、没有回执、没有审核**，账本对不上。
  //   口径在 `roles\班组须知-细则.md` §4（原 brain.md §29；写文件的活必须走 `派活.mjs`）；这道门是它的机器侧兜底（口径靠自觉，门靠脚本）。
  if (status === 'done') {
    const why = opt('no-receipt')
    if (!why) {
      const r = findReceipt(id)
      if (!r.ok) {
        console.error(`[台账] ❌ 拒绝收工：${id} 没有派活回执 —— **这活是谁干的？**`)
        console.error('       找过：' + r.tried.join('\n              '))
        console.error('       编码类必须走 `派活.mjs`（它会把卡落在 <项目>\\_crew\\tasks\\<ID>.dispatch.json）；')
        console.error('       确实不是派活干出来的（环境类/纯脑力/文档类）⇒ 带理由重来：')
        console.error(`         node 台账.mjs set --project "${P}" --id ${id} --status done --no-receipt "为什么没有回执"`)
        process.exit(1)
      }
      console.log(`[台账] ✓ 收工门：有派活回执 ${r.path.replace(P, '')}`)
    } else {
      try {
        const d = join(P, '_crew', 'tasks'); mkdirSync(d, { recursive: true })
        writeFileSync(join(d, id + '.no-receipt.json'), JSON.stringify({
          at: nowText(), task: id, reason: String(why), from: t.status,
          note: '没有派活回执就进 done 的**留痕**（受限逃生口，用户 2026-10-12 定）；口径见 roles\\班组须知-细则.md §4（原 brain.md §29）'
        }, null, 2) + '\n', 'utf8')
      } catch (e) { console.error('[台账] ⚠️ 留痕写失败（不拦收工，但你要知道）：' + String(e?.message ?? e)) }
      console.error(`[台账] ⚠️ 放行但已留痕：${id} 进 done 且**没有派活回执**，理由＝${why}`)
    }
    // ★ 2026-10-23（D7）：**没有绿收据不许 done**（见 `readAcReceipt` 上方那段口径）
    {
      const ac = readAcReceipt(id)
      const green = ac?.ok === true && ac?.machineVerified === true
      const lv = lastVerdictOf(id)
      const waive = opt('waive')
      if (!green && lv && RED_VERDICTS.has(lv.verdict)) {
        if (!waive) {
          console.error(`[台账] ❌ 拒绝收工：${id} **没有绿收据**，而最新判决是「${lv.verdict}」（收据 ${lv.at}）`)
          console.error(`       AC 收据：${join(P, '_crew', 'gate', `ac-${id}.json`)} ${ac ? '（有，但 ok≠true）' : '（**没有**）'}`)
          if (lv.action) console.error(`       判决原话：${String(lv.action).slice(0, 220)}`)
          console.error('       → 先把活干绿（重派/返工，跑出 ok=true 的 AC 收据），或确实要放行就带理由重来：')
          console.error(`         node 台账.mjs set --project "${P}" --id ${id} --status done --waive "为什么可以放行"`)
          process.exit(5)
        }
        const okW = appendWaiver({ task: id, reason: waive, receipt: lv.at })
        console.error(`[台账] ⚠️ **人工放行**：${id} 没有绿收据（判决 ${lv.verdict}），理由是「${waive}」${okW ? '，已记进 _crew\\waivers.jsonl' : '，**留痕写失败**（你要知道）'}`)
      } else if (!green && !lv) {
        console.error(`[台账] ⚠️ ${id} 没有 AC 收据、也没有可查的判决 ⇒ 按老口径放行（无机器签字，别把它当"验过"）`)
      }
    }
  }
  const before = t.status
  t.status = status
  await writeTasks(tasks)
  console.log(`[台账] ${id}：${before} → ${status}`)
}

/**
 * `ac` —— 跑一条任务的可执行验收标准（★ 2026-10-05 新增，编排收活时会调它）。
 *
 * 用法：
 *   node 台账.mjs ac --project <P> --id T44            # 人读
 *   node 台账.mjs ac --project <P> --id T44 --json     # 机器读（编排用）
 *   node 台账.mjs ac --project <P> --id T44 --cwd <目录> --timeout-min 15
 *
 * 退出码：0 = 全过 / 1 = 有红 / 2 = 这条任务没有可执行 AC（= **未机器验证**，不是失败）
 */
async function cmdAc () {
  const id = opt('id')
  if (!id) { console.error('[台账] ac 需要 --id <任务ID>'); process.exit(3) }
  const t = readTasks().find(x => x.id === id)
  if (!t) { console.error(`[台账] 没这个任务：${id}`); process.exit(3) }
  // 跑在哪儿：默认测试代码所在目录（`<项目>\server` 有 package.json 就用它），可用 --cwd 覆盖
  const cwd = resolve(opt('cwd', existsSync(join(P, 'server', 'package.json')) ? join(P, 'server') : P))
  const res = checkTaskAC(t, { cwd, quiet: argv.includes('--json') })
  if (argv.includes('--json')) process.stdout.write(JSON.stringify(res) + '\n')
  else {
    console.log(`[台账] ${t.id} 的可执行 AC：${res.checks.length} 条`)
    for (const c of res.checks) console.log(`   ${c.ok ? '✅' : '❌'} ${c.cmd}　${c.tookSec}s　${c.why}`)
    console.log(`   → ${res.hint}`)
  }
  process.exit(res.machineVerified === false ? 2 : (res.ok ? 0 : 1))
}

function cmdReady () {
  const { tasks, suspects } = readTasksFull()
  // ★ 2026-10-24（施工文档 §10.2 ②）：**零条可开工 ＋ 一堆"疑似卡"** ＝ 昨天那场事故的样子
  //   （写了 49 张、机器认 0 张、`ready` 一张不派、全程不吭声）。这里往 **stderr** 喊一声：
  //   编排只读 stdout（`ready --json` 必须是干净的数组），所以喊话不会污染任何消费方。
  if (suspects.length) {
    console.error(`[台账] ⚠️ 有 ${suspects.length} 行**像任务卡、却没写勾选框**（\`- [ ]\`）⇒ 机器没认，等于这张卡没写：`)
    for (const l of suspects.slice(0, 3)) console.error(`        ${l.slice(0, 110)}`)
    console.error('        正确形状：`- [ ] T1 · W1 · coder-a · 目标 · 依赖:无 · 交付:a.ts · 验收:跑通`')
  }
  const byId = new Map(tasks.map(x => [x.id, x]))
  const ready = tasks.filter(t => (t.status === 'pending' || t.status === 'ready') && depsSatisfied(t, byId))
  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(ready, null, 2) + '\n')
  } else if (ready.length === 0) {
    console.log('[台账] 现在没有能开工的任务（要么都做完了，要么都被依赖卡着）')
    const blocked = tasks.filter(t => t.status === 'pending' && !depsSatisfied(t, byId))
    if (blocked.length) console.log(`   被依赖卡住：${blocked.map(t => t.id + '(等 ' + t.depends.filter(d => byId.get(d)?.status !== 'done').join(',') + ')').join('  ')}`)
  } else {
    console.log(`[台账] 现在能开工 ${ready.length} 个：`)
    for (const t of ready) console.log(`   ${t.id}  ${t.wave}  ${t.role}  依赖:${t.depends.join(',') || '无'}  ${t.goal}`)
  }
}

function cmdList () {
  const wave = opt('wave')
  let tasks = readTasks()
  if (wave) tasks = tasks.filter(t => t.wave === wave)
  if (tasks.length === 0) { console.log('[台账] 没有任务'); return }
  const byId = new Map(readTasks().map(x => [x.id, x]))
  console.log(`[台账] ${P}`)
  for (const t of tasks) {
    const dep = t.depends.length ? '  等:' + t.depends.map(d => `${d}(${byId.get(d)?.status ?? '?'})`).join(',') : ''
    console.log(`   [${STATUS_MARK[t.status]}] ${t.id.padEnd(8)} ${t.wave.padEnd(4)} ${t.role.padEnd(9)} ${t.status.padEnd(8)}${dep}  ${t.goal}`)
  }
  const counts = {}
  for (const t of tasks) counts[t.status] = (counts[t.status] ?? 0) + 1
  console.log('   —— ' + Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' · '))
}

/**
 * `machine` —— 机器区段（TASKS.md 末尾 `<!-- MACHINE {...} -->`）的**唯一读写口**。
 * 读方（编排 deliverablesOf、以后的 体检 等）**只走这里**，不再拿正则猜 TASKS.md。
 * 用法：node 台账.mjs machine --project <P> [--json] [--fix]
 * 退出码：0=给了数据 / 1=区段缺失或坏了（**出声**） / 3=没有 TASKS.md 或用法错
 */
async function cmdMachine () {
  if (!existsSync(FILES.tasks)) { console.error(`[台账] machine：没有 TASKS.md（${FILES.tasks}）`); process.exit(3) }
  if (has('fix')) {
    const { tasks } = readTasksFull()
    await writeTasks(tasks, undefined, true)
    console.error('[台账] machine --fix：已按当前正文重建机器区段')
  } else {
    const got = extractMachine(readFileSync(FILES.tasks, 'utf8'))
    // 过期（正文在上次生成后被改过）→ 顺手刷新再读；缺失/坏 → 留给下面统一报错（**不猜**）
    if (got.ok && got.data.srcHash !== sha1(stripMachine(readFileSync(FILES.tasks, 'utf8')))) {
      console.error('[台账] ℹ️ 机器区段过期（正文被改过）→ 已顺手刷新')
      const { tasks } = readTasksFull()
      await writeTasks(tasks, undefined, true)
    }
  }
  const cur = extractMachine(readFileSync(FILES.tasks, 'utf8'))
  if (!cur.ok) {
    console.error(`[台账] ❌ 机器区段读不到：${cur.why}`)
    console.error('[台账]        重建：node 台账.mjs machine --fix --project "<项目>"（或任意一次 set/add 也会重建）')
    process.exit(1)
  }
  const d = cur.data
  // ★ 2026-10-24：老区段（本字段上线前生成的）里没有 `suspects` ⇒ 现场从正文数一遍，**不写盘**
  //   （不这么做的话，存量项目会显示 0 —— 那比不显示更糟：看起来像"都没问题"）。
  if (!Array.isArray(d.suspects)) d.suspects = readTasksFull().suspects
  if (argv.includes('--json')) { process.stdout.write(JSON.stringify(d, null, 2) + '\n'); return }
  const by = {}
  for (const t of Object.values(d.tasks ?? {})) by[t.state] = (by[t.state] ?? 0) + 1
  console.log(`[台账] 机器区段 OK：${Object.keys(d.tasks ?? {}).length} 条任务（${Object.entries(by).map(([k, v]) => `${k} ${v}`).join(' · ')}）`)
  console.log(`         生成于 ${d.at}；未识别行 ${(d.unmatched ?? []).length} 条；**像卡但没写勾选框 ${(d.suspects ?? []).length} 条**；正文指纹 ${String(d.srcHash).slice(0, 10)}…`)
  if ((d.suspects ?? []).length) {
    console.log('         ⚠️ 上面这个数 > 0 ＝ 有人写了卡片但**没按 `- [ ]` 的形状写** ⇒ 机器一条都没认（等于白写）。')
    console.log('         形状：`- [ ] T1 · W1 · coder-a · 目标 · 依赖:无 · 交付:a.ts · 验收:跑通`（详见 TASKS.md 的 `## 任务` 区样例）')
  }
}

// ---------------------------------------------------------------- 入口

switch (cmd) {
  case 'init': await cmdInit(); break
  case 'add': await cmdAdd(); break
  case 'set': await cmdSet(); break
  case 'ready': await cmdReady(); break
  case 'ac': await cmdAc(); break
  case 'list': await cmdList(); break
  case 'machine': await cmdMachine(); break
  default:
    console.error('用法：台账.mjs <init|add|set|ready|ac|list|machine> --project <目录> …（详见文件头）')
    process.exit(1)
}
