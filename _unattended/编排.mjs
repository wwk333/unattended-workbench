#!/usr/bin/env node
/**
 * 编排（orchestrator）—— 无人值守模式 · 第 4 步
 *
 * 干什么：一个波次跑完的固定分支，全在这一个脚本里：
 *
 *   ① 读台账          `TASKS.md`（唯一真源，状态机 + 依赖图）
 *   ② 算能做谁        依赖都 done 的 pending/ready 任务（= `台账.mjs ready` 的口径）
 *   ③ 拼任务卡        每条任务调 `派活.mjs`（**自动把相关坑原文内嵌**）
 *   ④ 分批 + **真并行**   每批上限默认 **5**（`--max`）；**并行上限默认 2**（`--parallel`）
 *                      ★ 2026-10-05 改（用户拍板"coder-a 干活时不能让 coder-b 干等"）：
 *                      **首轮尝试改成异步 spawn 并发跑**（`Promise.all`），收尾（判定/记账/改状态/重试/急救）仍**串行**
 *                      （台账与账本是单文件，并发写会丢更新）。
 *                      **安全护栏 = 文件白名单 ＋ 载体**：同一组里只要两条任务的文件清单**有交集**（或没写清单），
 *                      就自动降级为串行 —— 这就是 `分工表.md` §4"波内串行提交（a 先 b 后）"的**代码落地**。
 *                      ★ 2026-10-20（b210，用户拍板）：**同一个载体不许同时跑两个**（一个载体＝一个进程/会话/cwd）。
 *                      允许的是**不同载体**并行（coder-a 的 Pi 与 coder-b 的 OpenCode）。
 *                      零成本实证（桩载体，各睡 6 秒）：T1/T2 开始相差 106ms、同时结束（真并行）；
 *                      T3 与 T1 同文件 → 严格排在 T2 结束后才起（自动串行）。
 *                      ⚠️ 历史更正（2026-10-04 那版写的是"这不是真并行…墙钟与串行相同"）**已作废**；
 *                      原"两个 coder 并行、各在自己 worktree"也不准（本项目不用 git → 没有 worktree）。
 *   ⑤ 收活判定        `-p -o json` 信封 + §5.4 的失败分支表
 *   ⑥ 回填            账本（工量）+ `TASKS.md`（状态）+ 结果 JSON
 *
 * **默认演练（dry-run），不真的调用班组**。要真跑必须显式 `--execute`。
 *   这样"把流程固化成代码"和"真花额度干活"是两件事。
 *
 * 用法：
 *   node 编排.mjs --project "<项目>"                    # 演练：只打印要派谁、什么命令
 *   node 编排.mjs --project "<项目>" --execute           # 真跑（**花额度**）
 *   node 编排.mjs --project "<项目>" --execute --wave W1 # 只跑某一波
 *   node 编排.mjs --project "<项目>" --max 5 --timeout-min 90
 *
 * 失败分支（方案 §5.4 的实现）：
 *   偶发（无信封 / is_error 且 stop_reason=error）→ 同通道重试 1 次 → 仍失败 → 标 blocked + 记台账
 *   权限类（permission_denials 非空）             → **不重试**，标 blocked，把被拒条目摆出来
 *   账号类（logged_in=false / 401 / 403）         → **整轮停手**（三角色同账号，换人没用）
 *   上下文挤爆（usage.context_usage_ratio ≥ 阈值）→ 记账 + 提示拆任务（不自动重试）
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { loadConfig, resolveRole, buildInvocation, envFor, parseCarrierOutput } from './_agents-config.mjs'
import { reviewWhitelist } from './_审核白名单.mjs'
import { reviewBackupScope, backupTargets } from './_审核备份范围.mjs'
// ★ 2026-10-05 额度兜底（失败后切换）：只在**额度/账号类**失败上推进链条，然后让既有的"重试 1 次"机制
//   重新走一遍 `callCrew`（它每次都重新 `resolveRole`）→ 于是重试**自动用上下一家的供应商+模型+钥匙**。
import { advance as failoverAdvance } from './额度切换.mjs'
import { acquireLock, LOCK_FILE, readLock } from './_lock.mjs'
// ★ 2026-10-21（通用化③⑤）：越界归因搬进纯函数模块（目录级声明 + 同批剔除），可直接单测
import { classifyOutOfScope, deductSiblings } from './_归因.mjs'
import { readGateJson } from './_门禁入口.mjs'
// ★ 2026-10-23（施工文档 20261024 §4）：对账（证据包 / 四分类 / 归因阶梯）—— 纯函数，不花 token
import { reconcile, buildEvidence, attribute, selfTestsOf, parseRan } from './_诊断.mjs'
import { actionForReconcile } from './_失败处置.mjs'
// ★ 2026-10-21（越界台账）：不判罚，只记账 + 广播（用户口径："越界不是罪，是情报"）
import { classifyRecords, appendLedger, briefFor, summarize as summarizeOverreach, whyFromEnvelope, readLedger } from './_越界.mjs'
// ★ 2026-10-23（施工文档 D22）：越界的"谁写的"改成**铁证认领**（写类工具调用），不再文本子串匹配
import { writtenBy, claimOf, normPath } from './_谁写的.mjs'
// ★ D22 第 ② 级：认不出"谁写的"时查留痕记录（这份文件在这段时间里谁动过）
import { query as traceQuery } from './留痕看护.mjs'
// ★ 2026-10-23（施工文档 W2/D14）：模型能力（上下文窗口/最大输出）—— 算占用、判撞顶、写压缩线都靠它
import { capacityOf, contextPct, compactionReserve, parseLimitFromError, setProbe, markUnknown, modelsDevAgeDays } from './模型能力.mjs'
// ★ 2026-10-23（施工文档 D4/D12）：事件流监控与唤醒（黄/红/45 唤醒/90 收尾）
import { Monitor, thresholdsFrom } from './_监控.mjs'
// ★ 2026-10-23（施工文档 D20/D21/D23）：失败处置矩阵 —— 判决 → 自动动作 → 建议大脑。
//   唯一真源；`RESCUE_ABLE` / `FAIL_OK` / 换家判定 / 建议动作全从它派生（不再各处手写一份）。
import { OK_VERDICTS, rescueAble, failoverAllowed, nextOf, suggestOf } from './_失败处置.mjs'
// ★ 2026-10-26（限流拆分）：**"怎么认出来 + 等多久"** 是纯函数，单独一份（`_退避.mjs`，有单测）。
//   为什么不塞进 `_失败处置.mjs`：那张表是"判决 → 动作"的**数据**，这里放算法；混在一起表会越来越难读。
import { classifyRetryableFailure, parseRetryAfterMs, waitPlan } from './_退避.mjs'
// ★ 2026-10-26（§一）：审核结论机器化的唯一解析器（与 `交付门.mjs` 共用一份）
import { judgeReview, reviewReportSha, findReviewReport, upsertReviewBlock, buildReviewBlock } from './契约/审核.mjs'
// ★ 2026-10-27（审核一次制）：**项目周期只审 1 次** + 锚点由机器给 —— 纯函数，有单测。
//   为什么单独一份：这套判据（做完没有 / 用过没有 / 锚点归谁）是本次改动的**唯一真源**，
//   散在 2000 行的编排里就没法单测，而它恰好是"假绿最容易钻进来"的那一段。
import { OPEN_STATUSES, parseLedgerRows, reviewPlan, planAnchors, reviewPolicyOf } from './_审核一次.mjs'
// ★ 2026-10-26（§四）：越界/噪音/有害策略的唯一出处（内核不再硬编码 SCOPE_NOISE）
import { loadPolicy, isSharedOutput } from './_调度.mjs'
// ★ 2026-10-26（D-11 第二步）：收活时把这一趟记成 C 状态库里的 attempt。
//   **记账失败只告警**，绝不阻断收活（主流程不能被记账拖死）。
import { beginAttempt, endAttempt } from './_收据回写.mjs'
import { NODE_BIN as NODE_P, need } from './_路径.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, '..')

const argv = process.argv.slice(2)
function opt (n, d = null) { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const has = (n) => argv.includes('--' + n)

// ★ 2026-10-23（施工文档 D3）：**思考档位的梯子**。pi 的帮助原文只认这几个名字
//   （`--thinking <level>  off, minimal, low, medium, high, xhigh, max`，**不接受具体数字**）⇒
//   "high 只准想 8K"这种精细切分没有接口，只能**整档升降**。撞顶时降一格，仅一次。
const EFFORT_LADDER = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
function lowerEffort (e) {
  const cur = String(e ?? '').trim().toLowerCase()
  if (!cur) return null                       // 没设档位 ⇒ 无从降（不瞎给一个）
  const i = EFFORT_LADDER.indexOf(cur)
  if (i <= 0) return null                     // 已经在最低档 / 认不出的档位 ⇒ 不降
  return EFFORT_LADDER[i - 1]
}

// NODE 只用于跑**本套内部脚本**（台账/派活/账号自检/账本），与"班组用哪个 agent"无关 ——
// 班组程序一律从 _crew\agents.json 读（见 _agents-config.mjs）。
// ★W2：NODE 只用于跑**本套内部脚本**，用"正在跑我的这个 node"完全可以 —— 硬 need() 会让
//   没装 config 的机器连 --help 都跑不了。DSH 自带 node 仍在优先位。
const NODE = process.env.DSH_NODE_EXE ?? NODE_P ?? process.execPath
const { cfg: AGENTS_CFG, source: AGENTS_SRC, warnings: AGENTS_WARN } = loadConfig()
const LEDGER = join(HERE, '工量账本.mjs')
const DISPATCH = join(HERE, '派活.mjs')

/**
 * ★ b197（施工文档 §四 M6-10 第 4 件 · "另一个 agent 知道"）：**任务 → 它真越界过的文件**。
 * 为什么要有：越界这件事今天只写进收据，**下一个干同类活的执行者一无所知**（同一个文件被反复越界）。
 *   所以像 `--files` 那样，把它**递进下一张卡**（`派活.mjs --out-of-scope` ⇒ 渲染进 VOLATILE）。
 * 三个来源：① 本任务上一次尝试（重试/急救）② 它的依赖任务 ③ **上一轮**（最近 3 份收据，跨运行也管用）。
 * ⚠️ 只传 `realOverreach`：`whitelistGap` 是**我们卡没写全**，让下一张卡背这个锅是甩锅。
 */
const OVERREACH = new Map()
// ★ 2026-10-21（越界台账）：本轮所有越界记录（三档）＋ 按卡归堆，供"广播"用
const RUN_RECORDS = []
const SCOPE_BY_TASK = new Map()
let OVERREACH_SEEDED = false
function seedOverreach () {
  if (OVERREACH_SEEDED) return
  OVERREACH_SEEDED = true
  try {
    const runs = join(PROJECT, '_crew', 'runs')
    const dirs = readdirSync(runs).sort().reverse().slice(0, 3)
    for (const d of dirs) {
      const f = join(runs, d, 'verdict.json')
      if (!existsSync(f)) continue
      let j; try { j = JSON.parse(readFileSync(f, 'utf8')) } catch { continue }
      const add = (id, arr) => {
        if (!id || !arr?.length) return
        OVERREACH.set(id, [...new Set([...(OVERREACH.get(id) ?? []), ...arr])])
      }
      for (const r of (j.results ?? [])) add(r.task, r.outOfScopeKind?.realOverreach)
      add(j.review?.task, j.review?.outOfScopeKind?.realOverreach)
    }
  } catch { /* 读不到就不带（**不编**） */ }
}
/** 这张卡该带上的"上轮真越界"清单（本任务 ＋ 依赖任务）。 */
function overreachFor (t) {
  seedOverreach()
  const mine = OVERREACH.get(t.id) ?? []
  const dep = (t.depends ?? []).flatMap(d => OVERREACH.get(d) ?? [])
  return [...new Set([...mine, ...dep])]
}

/**
 * ★ 2026-10-21（越界台账）：这张卡该看到的**越界记录**（带"谁/为什么"，不只是路径）。
 * 三个来源：本轮内存 → 本轮之前批次（兄弟）→ 台账最近 200 条（跨运行）。
 */
function scopeRecordsFor (t) {
  const mine = SCOPE_BY_TASK.get(t.id) ?? []
  const dep = (t.depends ?? []).flatMap(d => SCOPE_BY_TASK.get(d) ?? [])
  if (mine.length || dep.length) return [...mine, ...dep]
  try {
    const led = readLedger(PROJECT, { last: 200 })
    return led.filter(r => r.task === t.id || (t.depends ?? []).includes(r.task))
  } catch { return [] }
}

/**
 * ★ b197（施工文档 §四 M6-5 · D 通道）：**上一轮这个角色的"审核口径违规"次数**（从最近 3 份收据里数）。
 * 为什么要它：`policy` 判据（回执里跑全量／没引用门禁结果／工具调用超预算）今天**零后果**——
 *   违规事实只落在收据里，**下一个同角色的执行者一无所知**，于是同一个毛病反复犯。
 *   做法照 M6-5 定稿：**不重做本轮**，只在**下一张同角色的卡**里带一行 ⇒ 零额外轮次，且正好在"下一轮开工"这个决策点施压。
 * ⚠️ 口径：**只数、不判**（判决层一个字不改 —— 那会触发额度切换、白烧另一个网关；M6-5 明令不采用 A/B）。
 */
const POLICY_BY_ROLE = new Map()
function seedPolicy () {
  if (POLICY_BY_ROLE.size) return
  try {
    const runs = join(PROJECT, '_crew', 'runs')
    for (const d of readdirSync(runs).sort().reverse().slice(0, 3)) {
      const f = join(runs, d, 'verdict.json')
      if (!existsSync(f)) continue
      let j; try { j = JSON.parse(readFileSync(f, 'utf8')) } catch { continue }
      for (const r of (j.results ?? [])) {
        if (!r.policy) continue
        const k = r.role ?? '?'
        const cur = POLICY_BY_ROLE.get(k) ?? { overreach: 0, unverified: 0, overBudget: 0, n: 0 }
        if (r.policy === 'review-overreach') cur.overreach++
        else if (r.policy === 'review-unverified') cur.unverified++
        else if (r.policy === 'review-over-budget') cur.overBudget++
        cur.n++
        POLICY_BY_ROLE.set(k, cur)
      }
    }
  } catch { /* 读不到就不带（**不编**） */ }
}
/** 给这张卡（角色 R）配的"上一轮违规"一行；没有就返回 null（卡片逐字节不变）。 */
function policyNoteFor (role) {
  seedPolicy()
  const c = POLICY_BY_ROLE.get(role)
  if (!c || !c.n) return null
  const parts = []
  if (c.overreach) parts.push(`回执里跑全量命令 ${c.overreach} 次`)
  if (c.unverified) parts.push(`没引用门禁结果 ${c.unverified} 次`)
  if (c.overBudget) parts.push(`工具调用超预算 ${c.overBudget} 次`)
  return `上一轮「${role}」这个角色被判**审核口径违规 ${c.n} 次**（近 3 轮收据）：${parts.join('；')}。\n- 这轮注意：① **不许跑全仓测试**（跑卡上写死的那一条）② 回执里**要引用** \`gate-result.json\` ③ 工具调用**省着用**。`
}
const ACCOUNT = join(HERE, '账号自检.mjs')
const FINGERPRINT = join(HERE, '文件指纹.mjs')
const GATE = join(HERE, '门禁.mjs')          // ★ 2026-10-05：全量测试的唯一执行者（零 token）
const LEDGER_JS = join(HERE, '台账.mjs')     // 台账（含可执行 AC 的跑法）

/**
 * 文件指纹（§6.6）：派活前扫一遍、收活后再扫一遍。
 *
 * ★ 三条纪律：
 *   ① **绝不让它挡住派活** —— 指纹失败只告警，不影响真调（它是证据，不是门禁）；
 *   ② **每次尝试一份独立快照**（用 cardId：重试是 `<ID>-retry`）—— 否则重试会把"上一次
 *      失败的现场"覆盖进 before，差异就再也报不出来（与任务卡不覆盖是同一条理由）；
 *   ③ 白名单只收**看起来像路径**的交付物（`t.files` 优先），免得把一句中文描述当 glob
 *      判出一堆假"越界"。
 */
function fingerprintSnap (id, phase) {
  if (!EXECUTE) return null
  const r = spawnSync(NODE, [FINGERPRINT, 'snap', '--project', PROJECT, '--id', id, '--phase', phase],
    { encoding: 'utf8', maxBuffer: 8 << 20 })
  if (r.status !== 0) {
    console.log(`  ⚠️ 指纹 ${phase} 快照失败（不影响派活）：${String(r.stderr ?? '').trim().slice(-160)}`)
    return null
  }
  return true
}

function fingerprintDiff (id, allowed) {
  if (!EXECUTE) return null
  const args = [FINGERPRINT, 'diff', '--project', PROJECT, '--id', id, '--json']
  if (allowed.length) args.push('--allow', allowed.join(','))
  const r = spawnSync(NODE, args, { encoding: 'utf8', maxBuffer: 16 << 20 })
  if (r.status !== 0) { console.log(`  ⚠️ 指纹差异算不出来（不影响收活）：${String(r.stderr ?? '').trim().slice(-160)}`); return null }
  try { return JSON.parse(r.stdout) } catch { return null }
}

// ---------------------------------------------------------------- 参数

const PROJECT = resolve(opt('project', process.env.DSH_ACTIVE_PROJECT ?? ''))
/**
 * **早退也要留话**（2026-10-26 用户拍板 A）。
 * 这两处（项目不存在 / 没台账）发生在 RUNDIR 与退出钩子安装之前，
 * 所以它们原本**什么文件都不留**。这里单独补一个最小落盘，再退。
 */
function dieEarly (why, code = 1) {
  try {
    const st = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const dir = join(PROJECT || '.', '_crew', 'runs', st)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify({
      schema: 1, kind: 'run-verdict', at: new Date().toISOString(), stamp: st,
      source: '编排.mjs', stage: 'precheck', error: String(why).slice(0, 600), minimal: true
    }, null, 2), 'utf8')
  } catch (e) { console.error('[编排] 最小 verdict 也写不进去：' + String(e?.message ?? e)) }
  console.error(why)
  process.exit(code)
}

if (!PROJECT || !existsSync(PROJECT)) { dieEarly(`[编排] 项目目录不存在：${PROJECT || '(未给 --project)'}`, 2) }
const EXECUTE = has('execute')
// ★ 2026-10-24（施工文档 §12.5）：**意图显式声明** —— `--purpose drill` 标"演练/试卡"，默认 real。
//   这是"这批数据算不算数"的唯一权威；名字匹配只在入库时给老数据兜底（别在这儿加名单）。
const PURPOSE = String(opt('purpose', 'real')).toLowerCase() === 'drill' ? 'drill' : 'real'
// ★ 2026-10-24（§5.3）：四步链开关 —— 演练不受影响；真跑时默认开，`--no-rework` 可关
const REWORK_ON = !has('no-rework')
// 2026-10-24: observations 的数据源 —— 返工明细与自愈率（调参.mjs 读这两个字段）
const REWORKS = []
const SELF_HEAL = { red: 0, healed: 0 }
// ★ 2026-10-21（通用化②）：**"没有可执行验收"算不算不合格**，由项目自己声明。
//   默认 false ＝ 老项目零影响（放行但收据标 machineVerified:false，诚实但不拦）；
//   项目根 `gate.json` 写 `"requireAC": true` ⇒ fail-closed（没 AC 不许进 done）。
const REQUIRE_AC = (() => {
  try { const g = readGateJson(PROJECT, PROJECT); return !!(g?.data?.requireAC) } catch { return false }
})()
// 绕过准入四道门：只在"我明确知道在绕哪道门"时用，会打醒目警告并写进 verdict。
const FORCE = has('force')
// 急救（rescue）自动触发开关：`--no-rescue` 可关掉。默认开。
// 只在"编码本身搞不定"时上（**账号类/权限类换人也解决不了，不许拉急救**）。
const RESCUE_ON = !has('no-rescue')
// ★ 2026-10-23（施工文档 D20/D21）：急救名单**不再手写**，从 `_失败处置.mjs` 的矩阵派生
//   （`auto === 'rescue'`）。加进去的 `thinking-overflow-final` 就是"撞顶降档还撞 ⇒ 换模型再试一次"。
const RESCUE_ABLE = rescueAble()
const WAVE = opt('wave', null)
// ★ 2026-10-05 新增：**只跑指定的一条任务**（演练 / 验证审核员能力 / 单个返工都靠它）。
//   为什么需要：原来想单独跑一条只能"伪造一个项目"或手动拼命令 —— 而审核员那条链
//   （跑门禁 → 修红 → 复跑）**必须有一条真实路径能跑**，否则永远验不了。
//   语义：绕过波次过滤与依赖排序，只处理这一个 ID（门照过、指纹照拍、账照样记、审照样走）。
const ONLY_TASK = opt('only-task', null)
// 审核总开关：默认开。`--no-review` 用于"只想跑任务、不想审"的场合（省钱）。
// `--force-review`：**同一批任务再审一次**（默认靠 review-stamp 指纹去重，防重复烧钱）。
const REVIEW_ON = !has('no-review')
const FORCE_REVIEW = has('force-review')
// ★ 2026-10-05：`--review-only` —— **不派任何活，只跑门禁 + 拉审核员**。
//   用途：复审 / 返工 / 演练审核员那条链（`--only-task <一个 review 状态的任务>` 会自动走这条路）。
const REVIEW_ONLY = has('review-only')
// 每批上限（默认 5，--max 可调）。⚠️ 它**不是并发数** —— 真并发由下面的 `--parallel` 控制。
//   它只决定"一批塞几个 / 日志怎么分组"。
// ★ 2026-10-24（施工文档 §11.2 B）：**接线** —— `timeout_min` / `parallel` 的默认值改从
//   `_crew\调参\当前.json` 读 ⇒ "看板上采纳了就真生效"（原来只有 `_监控.mjs` 读它，且只认 lamp / N）。
//   优先级**命令行 > 当前.json > 代码默认**：命令行永远赢，否则"临时压一个值重跑"就没法覆盖了。
//   ⚠️ `retries` **不接**：编排里是一次写死的重试，硬接要动失败处置矩阵，等 C 条重新定义再碰。
//   ⚠️ `_监控.mjs` 里的 `closeMin` 是**死字段**（全仓没有读它的地方；"90 分钟收尾"实际由本文件的超时逻辑执行）
//      ⇒ 改 `timeout_min` 时收尾时限自然跟着变，不用再接那条线。
const TUNED = (() => {
  try { return JSON.parse(readFileSync(join(PROJECT, '_crew', '调参', '当前.json'), 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
})()
function tunedNum (key, cliName, hard) {
  const cli = opt(cliName, null)
  if (cli !== null && cli !== '' && Number.isFinite(Number(cli))) return { v: Number(cli), src: '命令行 --' + cliName }
  const f = Number(TUNED?.[key])
  if (TUNED && Number.isFinite(f) && f > 0) return { v: f, src: '调参\\当前.json' }
  return { v: hard, src: '代码默认' }
}
const MAX = Number(opt('max', 5))
// ★ 2026-10-05 新增：**真并行**上限（默认 2 —— 用户拍板"coder-a 干活时不能让 coder-b 干等"）。
//   为什么以前没有：批内是 `for` 逐个 `spawnSync`（阻塞）→ **分批 ≠ 同时**，墙钟与串行相同。
//   现在改成：**首轮尝试用异步 spawn 并发跑**，收尾（判定/记账/改状态/重试/急救）**仍然串行**。
//   ⚠️ 安全护栏（**分工表 §4 的"波内串行提交"自动化**）：并发只发生在**文件白名单互不重叠**的任务之间；
//      有交集（或任务没写文件清单）→ 自动降级为串行。这样"共享文件 a 先 b 后"是**代码保证**，不靠人记。
const PAR_T = tunedNum('parallel', 'parallel', 2)
const PAR = Math.max(1, Math.round(PAR_T.v))
// ★ 2026-10-26（限流拆分）：被限流时退避多久 —— 也走调参（`_crew\调参\当前.json` 的
//   `rate_backoff_base_s` / `rate_backoff_cap_s`），命令行 `--rate-backoff-base` / `--rate-backoff-cap` 优先。
//   默认 20s 起、翻倍、封顶 60s。依据：实测 2745 次重试里 RATE_LIMIT 占 73%，这类失败"等一等"就好；
//   但**等多久必须能调** —— 半夜跑被限流，是等 20s 还是等 2 分钟，得由实测定，不能写死在代码里。
const RATE_BACKOFF_BASE_MS = Math.max(0, Number(tunedNum('rate_backoff_base_s', 'rate-backoff-base', 20).v) || 0) * 1000
const RATE_BACKOFF_CAP_MS = Math.max(1000, Number(tunedNum('rate_backoff_cap_s', 'rate-backoff-cap', 60).v) || 60) * 1000
// 每条任务的**保护性超时**（分钟）。★ 2026-10-05：20 → 45。★ 2026-10-07：45 → **90**（用户拍板）。
//   45 的经历：实测编码任务普遍 20–45 分钟（T9 23.6 / T11 25.4 / T26 44.7），20 分钟会误杀（连错误记录都来不及写）。
//   90 的理由：45 分钟仍在**截断已经干完的活**——实测 `T35`、`P3`、`P4` 三张卡都在 45 分钟整点被掐，
//   产物已完整落盘、验收也能全绿，单纯因为"跑满 45 分钟"被判 timeout/blocked，每次都要人工收尾。
//   ⇒ 上限抬到 90，给"读码慢但确实在做"的大任务足够跑道；**任务粒度要求不变**（规则书：≤5 文件／≤300 行）。
//   覆盖方式照旧：`--timeout-min <n>`。
const TMO_T = tunedNum('timeout_min', 'timeout-min', 90)
const TIMEOUT_MIN = TMO_T.v
const CTX_LIMIT = Number(opt('ctx-limit', 0.85))
const TASKS_FILE = join(PROJECT, 'TASKS.md')
if (!existsSync(TASKS_FILE)) { dieEarly(`[编排] 找不到台账：${TASKS_FILE}`, 2) }

// ---------------------------------------------------------------- 起飞闸门 · 规矩版本（施工文档 §10.2 ① · 2026-10-24）
//
// **治的病**：`brain.md` 改了、桌面端没重启 ⇒ 内存里还是**旧规矩**，而编排照样起飞，一路花额度。
//   宿主在**加载 profile 时**用 `readFileSync` 把 persona 一次性读进去，之后**再也不读** ——
//   实测（2026-10-24）：04:39 起的会话，到 04:59 / 05:02 连开两个新会话，persona 字符数一模一样、
//   缺的还是同样那 7 行 ⇒ **"新建会话"不等于"换上新规矩"**，只有重启进程才算。
// **判据**（零 token，只比两个时间）：`roles\brain.md` 的 mtime **必须早于**桌面端主进程启动时间（+2 秒容差）。
//   · 进程名/环境变量与 `起飞前检查.mjs ⑩` **同一口径**（`DSH_APP_PROC` / `DSH_BRAIN_MD`），不另造第三套。
//   · 拿不到启动时间（没在跑 / 改名 / 非 Windows）⇒ **放行但明说"判不了"**：判不了不能假装判过。
// **为什么只在 `--execute` 拦**：演练不花额度、不派活，没必要因为规矩版本挡人。
// **为什么不给 `--skip` 开关**：这道门治的就是"改了规矩悄悄跑"，留个口子等于没有 —— 要跑就重启，30 秒的事。
const BRAIN_MD = process.env.DSH_BRAIN_MD ?? join(HERE, 'roles', 'brain.md')
function appStartMs () {
  const names = (process.env.DSH_APP_PROC ?? 'DeepSeek Harness,DeepSeek,electron').split(',').map(s => s.trim()).filter(Boolean)
  try {
    const cmd = `$p = Get-Process -Name @(${names.map(n => `'${n}'`).join(',')}) -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1; if ($p) { $p.StartTime.ToFileTimeUtc() }`
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd], { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim()
    const ft = Number(out)
    if (!Number.isFinite(ft) || ft <= 0) return null
    return ft / 10000 - 11644473600000   // FILETIME(1601, 100ns) → epoch ms
  } catch { return null }
}
if (EXECUTE && existsSync(BRAIN_MD)) {
  const bm = statSync(BRAIN_MD).mtimeMs
  const st = appStartMs()
  const zh = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false })
  if (st === null) {
    console.error('[编排] ℹ️ 规矩版本：拿不到桌面端启动时间（没在跑 / 进程名不同 → 用 DSH_APP_PROC 指定）⇒ **判不了**，放行 —— 但别当"验过"')
  } else if (bm > st + 2000) {
    console.error('[编排] ⛔ 拒绝起飞：**内存里跑的还是旧规矩**')
    console.error(`         brain.md 改于 ${zh(bm)}，而桌面端 ${zh(st)} 才启动 —— 新规矩是在那次启动**之后**写的`)
    console.error('         → **关掉桌面端再打开**（重开页面 / 新建会话都不算：persona 只在加载 profile 时读一次）')
    console.error(`         → 自查：node "${join(HERE, '起飞前检查.mjs')}"（看 ⑩ 规矩版本）`)
    console.error('         → 重启后原命令直接再跑；本闸门**没有 --skip 开关**。')
    process.exit(2)
  } else {
    console.error(`[编排] ✅ 规矩版本：brain.md ${zh(bm)} 早于桌面端启动 ${zh(st)} ⇒ 内存里就是这一版`)
  }
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const RUN_STARTED_AT = new Date().toISOString()   // ★ b219：整轮起点（写进 verdict.startedAt）
const RUNDIR = join(PROJECT, '_crew', 'runs', stamp)
const log = (...a) => console.log('[编排]', ...a)
let DONE_IDS = []   // 本批 done 的任务 id；派活要它做 DAG 依赖判定（--done）

/* ══ 2026-10-26（用户拍板 A）：**失败也必须留话** ══════════════════════════════
   事故：T2 载体失败那次，`_crew\runs\2026-10-26T12-22-44\` 是个**空目录** ——
   系统说"失败了"，但不知道是派活没派成、载体崩了、还是超时；退出码、错误原文全没有。
   这跟"改状态失败不说原因"是同一个病：**结论没有证据**。

   现在：任何一条退出路径（正常 / 抛异常 / 未捕获 / 被信号杀 / 空目录）都要有
   `verdict.json`，至少写清 stage + error + exitCode + 时间。
   纪律：**只在还没写过 verdict 时才写**（不许覆盖真正的那份结论）。 */
let VERDICT_WRITTEN = false
const STAGE = { current: 'start' }
function writeMinimalVerdict (why, extra = {}) {
  if (VERDICT_WRITTEN) return
  try {
    const body = {
      schema: 1,
      kind: 'run-verdict',
      at: new Date().toISOString(),
      stamp,
      source: '编排.mjs',
      stage: STAGE.current,
      error: String(why ?? '').slice(0, 600) || null,
      exitCode: typeof process.exitCode === 'number' ? process.exitCode : null,
      minimal: true,
      ...extra
    }
    mkdirSync(RUNDIR, { recursive: true })
    writeFileSync(join(RUNDIR, 'verdict.json'), JSON.stringify(body, null, 2), 'utf8')
    VERDICT_WRITTEN = true
    console.error('[编排] ⚠️ 已落最小 verdict（不是正常收据）：' + String(why).slice(0, 200))
  } catch (e) {
    console.error('[编排] ❌ 连最小 verdict 都写不进去：' + String(e?.message ?? e))
  }
}
process.on('uncaughtException', (e) => { writeMinimalVerdict('未捕获异常：' + (e?.stack ?? e)); process.exitCode = 1 })
process.on('unhandledRejection', (e) => { writeMinimalVerdict('未处理的 Promise 拒绝：' + (e?.stack ?? e)); process.exitCode = 1 })
process.on('exit', () => { writeMinimalVerdict('进程退出但没有写正常 verdict（stage=' + STAGE.current + '）') })
// SIGINT/SIGTERM：先落盘再退（别直接死）
for (const sig of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  try { process.on(sig, () => { writeMinimalVerdict('进程收到 ' + sig); process.exit(130) }) } catch {}
}

// ★ 2026-10-23（施工文档 D4/D12）：**事件流监控**。只在真跑时开（演练没有进程可盯）。
//   它零 token、每 10 秒读一次 `out.json` 的新增字节；判定与动作全写 `<项目>\_crew\看护状态.json`。
const MONITOR = new Monitor({
  project: PROJECT,
  log,
  thresholds: thresholdsFrom(PROJECT),
  // 测试缝（与 `_lock.mjs` 的 `DSH_LOCK_FILE` 同款纪律）：探针用 100ms 一轮验黄/红/唤醒，不必等 10 分钟。
  intervalMs: Number(process.env.DSH_MONITOR_INTERVAL_MS ?? 10_000)
})
if (EXECUTE) MONITOR.start()

// ★ 2026-10-23（施工文档 D1）：models.dev **每周拉一次**。
//   做法：开跑时看一眼内置副本多旧了；超过 7 天就**后台**拉一次（detached，不等它）——
//   拉失败保留旧副本并标 stale（`模型能力.mjs` 里就是这么写的），**绝不阻塞派活**。
if (EXECUTE) {
  try {
    const age = modelsDevAgeDays()
    if (age === null || age > 7) {
      const c = spawn(NODE, [join(HERE, '模型能力.mjs'), 'models-dev', '--refresh'], { detached: true, stdio: 'ignore', windowsHide: true })
      c.unref?.()
      log(`  [能力] models.dev 副本已 ${age === null ? '未知' : Math.round(age * 10) / 10} 天 ⇒ 后台拉一次（失败用旧的，不阻塞）`)
    }
  } catch { /* 拉不动就算了，旧副本照用 */ }
}

// ---------------------------------------------------------------- 准入四道门（照 SOP）
//
// 依据 `brain.md` 的「无人值守模式下 SOP 八步接线」里那三道硬门 + 任务粒度要求。
// **为什么必须做成硬检查**：这些规矩写在规则书里，但"写在文档里"和"脚本真的拦住"是两回事 ——
// 之前字典没填、契约没冻结、任务没写验收标准，照样能派活，一定返工。
// 也留了 `--force` 给"我确实知道自己在绕过什么"的场景（会打醒目警告）。

// ★ 2026-10-09 八·S3（§14.3）：门2 的"验实质"小工具（旧版只验行数 ⇒ 3 行空壳也过 = 虚假安全感）。
//   字典：数**实质行**（空行/标题/引用/代码围栏/表格分隔线/HTML 注释都不算）；
//   契约：数**活着的 C 条目**（行里有 C\d+ 且没写"废弃/作废/停用/过期"才算）；
//   新鲜度：只做"超 180 天没动过"的**提醒级**检查 —— 实测异次元 CONTRACT（22:44）比 BLUEPRINT（22:55）
//   还早 11 分钟，mtime 先后 ≠ "是不是这次的"，硬拦会误伤；所以它只提醒、不拦。
const GATE2_STALE_DAYS = 180
function countSubstanceLines (text) {
  return String(text).split(/\r?\n/).filter(l => {
    const s = l.trim()
    if (!s) return false
    if (s.startsWith('#') || s.startsWith('>') || s.startsWith('```') || s.startsWith('<!--')) return false
    if (/^[\s|:\-]+$/.test(s)) return false
    return true
  }).length
}
function activeCItems (text) {
  let n = 0
  for (const l of String(text).split(/\r?\n/)) {
    if (!/C\d+/.test(l)) continue
    if (/(废弃|作废|停用|过期|已删|已废|失效|deprecated|obsolete)/i.test(l)) continue
    n++
  }
  return n
}
function staleDays (f) {
  try { return Math.floor((Date.now() - statSync(f).mtimeMs) / 86400000) } catch { return null }
}

function admissionGates (task) {
  const problems = []   // 阻断
  const warnings = []   // 提示

  const blueprint = join(PROJECT, 'PROJECT_BLUEPRINT.md')
  const bp = existsSync(blueprint) ? readFileSync(blueprint, 'utf8') : ''
  const track = (bp.match(/^\s*轨道\s*[:：]\s*([A-Ea-e])/m) ?? [])[1]?.toUpperCase()
    ?? (task.track ? String(task.track).toUpperCase() : null)

  // 门 1：没定轨道 → 不许开工（SOP ①）
  if (!track) {
    problems.push('【门1·轨道】PROJECT_BLUEPRINT.md 里没有 `轨道:` 字段，台账里也没有 track —— SOP ① 要求先定轨道（A/B/C/D/E）')
  } else {
    // 门 2：字典/契约没冻结 → 不许进编码（按轨道分档：A 轨道豁免）
    if (track !== 'A') {
      const dict = join(PROJECT, 'DICT.md')
      const dictFiles = existsSync(dict)
        ? [dict]
        : (existsSync(PROJECT) ? readdirSync(PROJECT).filter(f => /^DICT-.*\.md$/i.test(f)).map(f => join(PROJECT, f)) : [])
      // ★ 八·S3：验实质（实质行 ≥6）+ 新鲜度提醒（>180 天）—— 旧版只验"≥3 行"，3 行空壳也放行。
      const dictBad = dictFiles.filter(f => { try { return countSubstanceLines(readFileSync(f, 'utf8')) < 6 } catch { return true } })
      const dictOk = dictFiles.length > 0 && dictBad.length === 0
      if (!dictOk) problems.push(`【门2·字典】轨道 ${track} 必须建 DICT.md 且**填过实质内容**（≥6 行正文；SOP ②：字典没填完不进编码）${dictBad.length ? ` —— 没过的：${dictBad.map(f => f.split(/[\\/]/).pop()).join('、')}` : ''}`)
      for (const f of dictFiles) { const d = staleDays(f); if (d !== null && d > GATE2_STALE_DAYS) warnings.push(`【门2·新鲜度】${f.split(/[\\/]/).pop()} 已 ${d} 天没动过 —— 核对是不是"上一版"的（提醒级，不拦）`) }

      const contractFiles = existsSync(PROJECT)
        ? readdirSync(PROJECT).filter(f => /^CONTRACT.*\.md$/i.test(f)).map(f => join(PROJECT, f))
        : []
      // ★ 八·S3：验实质（≥1 条**活着**的 C 条目）—— 旧版只认 /C\d+/，`C1 于 2025 年废弃` 也过。
      const contractOk = contractFiles.length > 0 && contractFiles.some(f => { try { return activeCItems(readFileSync(f, 'utf8')) > 0 } catch { return false } })
      if (!contractOk) problems.push(`【门2·契约】轨道 ${track} 必须建 CONTRACT*.md 且**至少 1 条未标废弃的 C 条目**（SOP ③：契约没冻结不派活；全是"已废弃"＝不算冻结）`)
      for (const f of contractFiles) { const d = staleDays(f); if (d !== null && d > GATE2_STALE_DAYS) warnings.push(`【门2·新鲜度】${f.split(/[\\/]/).pop()} 已 ${d} 天没动过 —— 核对是不是"上一版"的（提醒级，不拦）`) }
    } else {
      warnings.push('轨道 A（快速）：按 SOP ②③ 豁免字典与契约，只走对话两列清单')
    }
  }

  // 门 3：任务没有验收标准(AC) → 不许派活（SOP ④）
  const ac = task.accept ?? task.ac ?? []
  if (!ac.length) problems.push('【门3·验收标准】这条任务没有 AC —— SOP ④ 要求每条 TASK 写明"跑什么、看到什么算过"')

  // 门 4（警告级）：粒度 ≤5 文件 / ≤300 行（SOP ④）
  const files = task.files ?? []
  if (files.length > 5) warnings.push(`【粒度】涉及文件 ${files.length} 个 > 5，SOP ④ 要求再拆`)

  return { track, problems, warnings }
}

// ---------------------------------------------------------------- 找活

function readyTasks () {
  const out = execFileSync(NODE, [join(HERE, '台账.mjs'), 'ready', '--project', PROJECT, '--json'], { encoding: 'utf8', maxBuffer: 8 << 20 })
  let list = JSON.parse(out)
  if (WAVE) list = list.filter(t => t.wave === WAVE)
  return list
}

// ---------------------------------------------------------------- 账号闸门（§5.4 账号类）
//
// ★ 2026-10-06 改（三方交叉验证共同指出：这道闸**恒绿**、§5.4 的"账号类整轮停手"永不触发）：
//   原来 `ok = r.status === 0 && j.ok === true`，而 `账号自检.mjs` 在"登录态未知"时也报 `ok:true`
//   ⇒ 只要不是 Qoder 那条通道，这里永远放行。现在两边都改成**三态**：
//     0 = 明确可用（放行）｜ **3 = 登录态未知**（放行但**打醒目警告**，并写进收据）｜ 2 = 明确不可用（**整轮停手**）。
//   另外把"角色要用的钥匙在不在"一并带出来（那是确定性检查，不需要联网）。
function accountGate () {
  const r = spawnSync(NODE, [ACCOUNT, '--json'], { encoding: 'utf8', maxBuffer: 8 << 20, timeout: 120_000, env: { ...process.env, CI: '' } })
  let j = null
  try { j = JSON.parse(r.stdout ?? '{}') } catch {}
  const unknown = r.status === 3 || j?.unknown === true
  const ok = r.status === 0 && j?.ok === true
  return { ok, unknown, status: r.status, detail: j, keyCheck: j?.keyCheck ?? null }
}

// ---------------------------------------------------------------- ★ 2026-10-07 "谁真的在跑"

/**
 * 给看板的**角色灯**提供一份**真的**存活依据：派活 spawn 成功那一刻登记，收活**立刻删**。
 *
 * 为什么必须做（实测，不是推测）：看板角色灯原来只按"最近 15 分钟内有回执/账本事件"猜，
 *   而**回执写在派活那一刻、账本写在收活那一刻** —— 一条任务在**飞行途中一个事件都不落**。
 *   我在 `<示例项目>` 上把「回执 → 落账」的间隔当真实时长量了 **47 次尝试**：
 *     · **21 次（45%）时长超过 15 分钟窗口**；
 *     · 这些任务平均有 **13.3 分钟**"明明还在干、却被显示成停着"；
 *     · 最坏一次（`T35`，跑了 **54.5 分钟**）有 **39.5 分钟**是误报；
 *     · 反方向同样错：干完之后还会再亮 **15 分钟假绿灯**（用户当场问"审核员为什么还绿着"）。
 *   ⇒ 时间窗口判"在跑"**两个方向都不可信**。改成**问 pid** —— 与面板「▶ 干活/停」按钮、
 *     `_lock.mjs` 是**同一套真假标准**（那里也是 `process.kill(pid,0)`）。
 *
 * ⚠️ 为什么不用"定时推 mtime 的心跳"（`_lock.mjs` 那种）：读的人**不在同一个进程**里，
 *   而 pid 存活本身就是原子的、即时的、不需要任何约定；心跳只在**同进程自证**时才必要
 *   （`_lock.mjs` 要它，是为了"长任务别被其它进程当死锁抢走"，目的不同）。
 */
const RUNNING_DIR = join(PROJECT, '_crew', 'running')

/** pid 还活着吗（与 `_lock.mjs` 同一手法）。 */
function pidAlive (pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * 登记一条"正在跑"。**必须在 spawn 成功那一刻调用**（此时 `child.pid` 才有效）。
 * 返回文件路径，收活时交给 `clearRunning` 删掉。
 */
function markRunning (cardId, t, roleRes, childPid) {
  try {
    mkdirSync(RUNNING_DIR, { recursive: true })
    const now = Date.now()
    const p = join(RUNNING_DIR, `${cardId}.json`)
    writeFileSync(p, JSON.stringify({
      cardId,
      task: t.id,
      role: t.role || 'coder-a',
      agent: roleRes?.agentName ?? null,
      childPid,                                     // ★ 真正在干活的那个子进程
      orchPid: process.pid,                         // 编排自己（诊断用）
      startedAt: new Date(now).toISOString(),
      startedAtMs: now,
      // deadline = 本次尝试自己的保护超时 + 5 分钟宽限。**防 pid 被复用**：
      // 一条早该被掐断的记录，过期就不再算"在跑"（否则回收后的 pid 会让看板永恒亮灯）。
      timeoutMin: TIMEOUT_MIN,
      deadlineMs: now + TIMEOUT_MIN * 60_000 + 5 * 60_000,
      run: stamp
    }, null, 2), 'utf8')
    return p
  } catch (e) {
    // 它是**证据**，不是门禁：写不出来只告警，绝不影响派活（与指纹同纪律）。
    console.log(`  ⚠️ 写"正在跑"状态失败（不影响派活）：${String(e?.message ?? e).slice(0, 120)}`)
    return null
  }
}

/** 收活即删 —— **必须删**：留着看板就会一直说"在跑"。 */
function clearRunning (p) {
  if (!p) return
  try { unlinkSync(p) } catch {}
}

/** 开跑前清掉**上一轮遗留**的登记（编排被强杀时会留下；此刻已持有单实例锁，清是安全的）。 */
function clearStaleRunning () {
  try {
    const fs2 = readdirSync(RUNNING_DIR).filter(f => f.endsWith('.json'))
    let n = 0
    for (const f of fs2) {
      const p = join(RUNNING_DIR, f)
      try {
        const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
        const pid = Number(j.childPid)
        const expired = Number(j.deadlineMs) && Date.now() > Number(j.deadlineMs)
        // 只有"进程真没了 或 已过期"才删 —— 别人还在跑的登记绝不动
        if (!Number.isFinite(pid) || expired || !pidAlive(pid)) { unlinkSync(p); n++ }
      } catch { try { unlinkSync(p) } catch {} ; n++ }
    }
    if (n) log(`  清理上一轮遗留的"正在跑"登记 ${n} 条`)
  } catch { /* 目录不存在 = 没有遗留 */ }
}

// ---------------------------------------------------------------- 调一个班组

/**
 * ★ 2026-10-23（施工文档 D14 附）：**压缩线定在 70%**。
 *
 * pi 的机制：`reserveTokens` 是**全局旋钮**（`settings.json`），触发线 = `contextWindow − reserveTokens`；
 *   没有按模型/按次/环境变量的覆盖口子（CLI 无参数、模型定义无此字段）。
 * 必须避开的坑：写死 `0.3 × 1M = 314,573` 而某个模型没配 `contextWindow`（pi 兜底 128K）⇒ 触发线变负数 ⇒ **每轮都压缩**。
 *   所以：**派发前按这个模型的窗口现算**，写**项目级** `<项目>\.pi\settings.json`；拿不到窗口 ⇒ 退回 16,384（保持原行为，不冒险）。
 * 代价：触发提前 ⇒ 压缩更早/更频繁（每次压缩是一次额外模型调用）；昨天最长卡 27.7 分钟、峰值远不到 70%，实际几乎不触发。
 * 风险：同项目并行两张 pi 卡、模型不同时，项目级设置会互相覆盖（pi 角色只有 coder-a 一个，同模型并发值相同，影响很小）。
 */
function ensurePiCompaction (roleRes, model) {
  if (String(roleRes?.agentName ?? '') !== 'pi') return null      // 只对 pi 生效（别的载体没这个旋钮）
  let cap = null
  try { cap = capacityOf(model)?.contextWindow ?? null } catch { cap = null }
  if (!cap) return { ok: false, why: '模型窗口未知 ⇒ 不写压缩线（保持 pi 默认 16384，不冒险）' }
  const reserve = compactionReserve(cap)
  const file = join(PROJECT, '.pi', 'settings.json')
  try {
    let cur = {}
    try { cur = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) } catch { cur = {} }
    if (cur?.compaction?.reserveTokens === reserve) return { ok: true, file, reserve, unchanged: true }
    mkdirSync(dirname(file), { recursive: true })
    if (existsSync(file)) { try { writeFileSync(file + '.bak-' + Date.now(), readFileSync(file)) } catch {} }
    writeFileSync(file, JSON.stringify({ ...cur, compaction: { ...(cur.compaction ?? {}), reserveTokens: reserve } }, null, 2) + '\n', 'utf8')
    return { ok: true, file, reserve, cap, unchanged: false }
  } catch (e) {
    return { ok: false, why: `写不进去：${String(e?.message ?? e).slice(0, 120)}` }
  }
}

async function callCrew (t, taskDir, opts = {}) {
  const role = t.role || 'coder-a'
  // ⚠️ 2026-10-02 修：worktree 这事**必须问配置，不能按角色名猜**。
  //    原来只写 `isCoder ? 'task-'+id : null` —— 于是载体换成"没有 --worktree 参数"的 messenger 后，
  //    传下去的 --worktree 被 buildInvocation 静默忽略，而**任务卡里照样写着那个不存在的目录**
  //    （实测：两个 coder 都发现目录不存在、自行纠正并回报差异；卡片在骗人）。
  //    现在三个条件同时成立才用 worktree：①是编码角色 ②配置里 worktree=true ③那个 agent 真有这个参数。
  const roleRes0 = resolveRole(role, AGENTS_CFG)
  // ★ 2026-10-23（施工文档 D3）：撞顶后**降一档**重发 —— 只换 effort，其余（模型/参数/白名单）一字不动。
  const roleRes = (opts.effort && opts.effort !== roleRes0.effort) ? { ...roleRes0, effort: opts.effort } : roleRes0
  const isCoder = /^coder-/.test(role)
  const worktree = (isCoder && roleRes.worktree && roleRes.agent?.worktreeFlag) ? `task-${t.id}` : null

  // ① 拼任务卡 + 内嵌相关坑（派活脚本负责，含"先看坑"硬要求 + 班组须知）
  //    opts.retryHint：重试时附上"上次为什么失败"，让这次别原样重放
  //    ⚠️ 重试时给不同的 --task 后缀，避免覆盖上一次的任务卡（否则现场的失败卡就没了，排查不了）
  // ★ 2026-10-03 修（实测：跑失败分支矩阵时暴露）：`cardId` 必须**贯穿到 prompt/out/err 三个文件名**。
  //   原来只用了 `cardId` 拼任务卡，而 promptPath/outJson/errTxt 仍写死 `${t.id}.…` →
  //   两个后果：① 重试**读回原始 prompt**，"换 prompt（附上次失败原因）"整个是空转；
  //   ② 重试/急救的 out.json **覆盖**首次尝试的信封 → 事后记账读到的是最后那份成功信封（账目说谎）。
  //   `opts.attempt` 让每一次尝试各有独立后缀（retry / rescue），互不覆盖。
  const cardId = opts.attempt ? `${t.id}-${opts.attempt}` : t.id
  const pfArgs = [DISPATCH, '--task', cardId, '--role', role, '--goal', t.goal,
    '--project', PROJECT, '--out', taskDir,
    '--deliverables', (t.deliverables || []).join(';'),
    '--accept', (t.accept || []).join(';')]
  if (opts.retryHint) pfArgs.push('--boundary', opts.retryHint)
  // ★ 2026-10-16（任务分级 L1–L4）：把工单级号**一路传到派活**（补的正是文档 §6 ① 那条现状缺口：
  //   以前 `编排.mjs --execute` 根本不读工单里的级号/模型，只有手工 `派活.mjs` 吃得到）。
  //   ⚠️ 级号一律**从工单里读**（handoff 传进来的 t.level），这里不猜、也不给默认级 —— 没写＝不带这个参数。
  if (t.level) pfArgs.push('--level', String(t.level))
  if (t.wave) pfArgs.push('--wave', t.wave)
  if (t.track) pfArgs.push('--track', t.track)
  if (t.depends?.length) pfArgs.push('--depends', t.depends.join(','))
  // ★ 2026-10-26 修（真项目 T2 连续被判「依赖未完成」）：派活靠 --done 判 DAG，编排原来**从来没传** ⇒
  //   只要卡片声明了依赖，就永远派不出去（T1 明明已经 done）。这里把本批已 done 的 id 传下去。
  if (DONE_IDS.length) pfArgs.push('--done', DONE_IDS.join(','))
  if (worktree) pfArgs.push('--worktree', worktree)
  if (opt('pitfall-keywords')) pfArgs.push('--pitfall-keywords', opt('pitfall-keywords'))
// ★ 2026-10-18（调研库 S4）：`--research-keywords "词,词"` 一路传到派活（不给 ⇒ 卡片逐字节不变）
if (opt('research-keywords')) pfArgs.push('--research', opt('research-keywords'))
  if (/^reviewer/.test(role)) pfArgs.push('--review-question', '这次有没有再犯库里记过的同类坑？')
  // ★ 2026-10-21（越界台账 · 广播）：审核员必须知道"本轮谁越界、动了什么、为什么" —— 它本来就是核这个的。
  if (/^reviewer/.test(role) && RUN_RECORDS.length) {
    const rv = briefFor('review', RUN_RECORDS)
    if (rv) pfArgs.push('--scope-brief', rv)
  }
  // ★ 2026-10-06 止血③：把"改动白名单"真递到卡里（护栏①宣称写死在卡，实际从没传过）
  if (/^reviewer/.test(role) && Array.isArray(t.files) && t.files.length) pfArgs.push('--files', t.files.join(';'))
  // ★ b197（M6-10 第 4 件）：把"上一轮真越界过哪些文件"递进这张卡（只传真越界，最多 20 条）。
  const oosCarry = overreachFor(t)
  if (oosCarry.length) pfArgs.push('--out-of-scope', oosCarry.slice(0, 20).join(';'))
  // ★ 2026-10-21（越界台账 · 广播）：把"谁/为什么"递进去（路径清单之上再加人话）。
  //   ① deps：本卡或它依赖的卡上轮越界过的（带理由）
  //   ② siblings：**本轮更早批次**里别人越界过的（同批并行的兄弟还没跑，只能给"已经跑完的那批"）
  const briefParts = []
  const depsBrief = briefFor('deps', scopeRecordsFor(t))
  if (depsBrief) briefParts.push(depsBrief)
  const sibRecords = RUN_RECORDS.filter(r => r.task !== t.id && !(t.depends ?? []).includes(r.task))
  if (sibRecords.length) briefParts.push(briefFor('siblings', sibRecords))
  if (briefParts.length) pfArgs.push('--scope-brief', briefParts.join('\n'))
  // ★ b197（M6-5 · D 通道）：上一轮**同角色**的审核口径违规 ⇒ 下一张卡里带一行（不重做本轮）
  const polNote = policyNoteFor(role)
  if (polNote) pfArgs.push('--policy-note', polNote)

  const pf = spawnSync(NODE, pfArgs, { encoding: 'utf8', maxBuffer: 16 << 20 })
  if (pf.status !== 0) {
    // ★ 2026-10-26：**取 stderr 的尾巴**，不是脑袋。开头全是 agents.json 的告警，真正的错误在最后。
    const tail = (pf.stderr || pf.stdout || '').trim().slice(-900)
    return { stage: 'dispatch', ok: false, error: tail, argv: pfArgs.slice(2), exit: pf.status }
  }

  const promptPath = join(taskDir, `${cardId}.prompt.txt`)
  const outJson = join(taskDir, `${cardId}.out.json`)
  const errTxt = join(taskDir, `${cardId}.err.txt`)
  // 角色 → agent/模型/参数，**全部来自 _crew\agents.json**（留了口子：换 agent 只改那份 JSON）
  // （★ 这个 res 与函数开头那个为算 worktree 而解析的同名变量是同一个东西，
  //   开头已解析过一次，这里复用，别再声明 —— 重复声明会 SyntaxError，实测踩过。）
  const invDry = buildInvocation(roleRes, '<PROMPT>', { worktreeName: worktree, cwd: PROJECT })
  if (!EXECUTE) {
    return { stage: 'dry-run', ok: true, promptPath, outJson, errTxt, role, worktree,
             agent: roleRes.agentName,
             command: `${invDry.argvForDisplay.slice(0, -1).join(' ')} $prompt 1> ${outJson} 2> ${errTxt}` }
  }

  // ② 真调：**输出落文件、绝不接管道**（spawnSync 直接收 stdout 等价于 `1> 文件`，
  //    而且不经过 PowerShell 的 UTF-16 重定向 —— 踩过那个坑，见 工量账本.mjs readJsonAuto）
  // ⚠️ 2026-10-05：`opts.skipBefore` 时不再自己留痕（由并发调度段**整组统一先拍 before**，
  //    否则并发组里后启动的任务会把先启动那位的产物算进自己的 before，导致"越界"误报）。
  if (!opts.skipBefore) fingerprintSnap(cardId, 'before')
  const prompt = readFileSync(promptPath, 'utf8')
  // ★ D14 附：压缩线（按这个模型的窗口现算 30% 预留 ⇒ 触发线 70%）
  const compact = ensurePiCompaction(roleRes, roleRes.model)
  if (compact && !compact.unchanged) log(`  [压缩线] ${roleRes.model}：reserveTokens=${compact.reserve}（窗口 ${compact.cap} ⇒ 触发线 ${(100 - 30).toFixed(0)}%）`)
  else if (compact && compact.ok === false && EXECUTE) log(`  [压缩线] ⚠️ ${compact.why}`)
  const inv = buildInvocation(roleRes, prompt, { worktreeName: worktree, cwd: PROJECT, resumeSessionId: opts.resumeSessionId ?? null, mcpConfig: opts.mcpConfig ?? t.mcpConfig ?? null })
  const started = Date.now()
  // ★ 2026-10-07：子进程一起来就登记"谁真的在跑"，**收活立刻删**（`finally` 保证异常/超时也会删）——
  //   看板角色灯从此按 pid 判活，不再按"最近 15 分钟有没有事件"猜（见 markRunning 的实测理由）。
  let attemptHandle = null
  let runningFile = null
  let r
  try {
    // ★ 六·S3：给载体进程注入身份 —— 它照卡跑 `门禁.mjs` 时，ranBy 就是它（不再靠命令行 --by 文本捏造）。
    r = await runCarrierAsync(inv, {
      cwd: PROJECT,
      env: { ...envFor(roleRes, process.env), DSH_GATE_RANBY: role },
      timeoutMs: TIMEOUT_MIN * 60_000,
      // ★ 2026-10-23（D12）：90 分钟到了不是"盲杀"，是**收尾**：先取证（扫一次指纹）、宽限 60 秒看它自己收工，再杀。
      graceMs: Number(process.env.DSH_CLOSE_GRACE_MS ?? 60_000),
      onClosing: () => {
        log(`  ⏳ ${t.id} 跑满 ${TIMEOUT_MIN} 分钟 → **进收尾**：先扫一次指纹留下已落盘的东西，再宽限 ${Math.round(Number(process.env.DSH_CLOSE_GRACE_MS ?? 60_000) / 1000)} 秒看它自己收工`)
        try { fingerprintSnap(cardId, 'closing') } catch {}
        try {
          appendFileSync(join(RUNDIR, '收尾.jsonl'), JSON.stringify({ at: new Date().toISOString(), cardId, task: t.id, timeoutMin: TIMEOUT_MIN, graceSec: Math.round(Number(process.env.DSH_CLOSE_GRACE_MS ?? 60_000) / 1000) }) + '\n', 'utf8')
        } catch {}
        MONITOR.record({ at: new Date().toISOString(), cardId, verdict: 'timeout', action: 'closing', timeoutMin: TIMEOUT_MIN })
      },
      outFile: outJson, errFile: errTxt,

      onSpawn: (pid) => {
        runningFile = markRunning(cardId, t, roleRes, pid)
        // ★ 2026-10-26（D11-SPAWN，D-11 第三步）：**开工即登记** attempt。
        //   只在收活时补记的话，startedAt 会是"收活那一刻"，一趟跑了多久永远算不出来。
        try {
          attemptHandle = beginAttempt({ project: PROJECT, runId: stamp, taskId: t.id, role, carrier: roleRes.agentName ?? null })
          if (!attemptHandle.ok) log(`  ⚠️ 开工登记失败（不影响本轮）：${attemptHandle.why}`)
        } catch (e) { log(`  ⚠️ 开工登记异常（不影响本轮）：${String(e?.message ?? e)}`) }
        // ★ D4：登记进监控（判据是**工具调用事件**，不是文件时间）
        MONITOR.register({ cardId, task: t.id, role: t.role, outFile: outJson, model: roleRes.model })
      }
    })
  } finally {
    clearRunning(runningFile)
    MONITOR.unregister(cardId)
  }
  const took = Date.now() - started
  if (r.stdout) writeFileSync(outJson, r.stdout, 'utf8')
  // ★ 2026-10-05：**stderr 无条件落盘**（原来只有非空才写 → 事后分不清"被超时杀"还是"自己崩"）。
  //   超时会 kill 子进程并标记 `timedOut` → 顺手把这条铁证写进 err.txt。
  writeFileSync(errTxt, `${r.stderr ?? ''}${r.timedOut ? `\n[编排] ⚠️ 被保护性超时掐断（TIMEOUT_MIN=${TIMEOUT_MIN} 分钟）\n` : ''}`, 'utf8')

  // ★ 2026-10-26（D11-RECEIPT，D-11 第二/三步）：收口这一趟的 attempt。
  //   有开工 handle 就收口它（时长＝真开工到收活）；没有（开工时库没打开）就**完整补记一条**，
  //   避免"开工没记上、收活也不记" ⇒ 这一趟在库里彻底消失。
  //   ⚠️ 只记账，不改任务状态、不改判决；失败只告警。
  try {
    const rec = endAttempt({
      attemptId: attemptHandle?.ok ? attemptHandle.attemptId : null,
      project: PROJECT,
      runId: stamp,
      taskId: t.id,
      role,
      carrier: roleRes.agentName ?? roleRes.agent ?? null,
      ok: r.status === 0,
      outFile: outJson,
      verdict: r.status === 0 ? null : (r.timedOut ? 'timeout' : 'unknown'),
      why: r.status === 0 ? null : `exit ${r.status}${r.timedOut ? '（保护性超时）' : ''}`
    })
    if (!rec.ok) log(`  ⚠️ 收据回写失败（不影响本轮）：${rec.why}`)
  } catch (e) {
    log(`  ⚠️ 收据回写异常（不影响本轮）：${String(e?.message ?? e)}`)
  }

  const call = { stage: 'call', ok: r.status === 0, exitCode: r.status, tookMs: took, startedAt: new Date(started).toISOString(), endedAt: new Date().toISOString(), promptPath, outJson, errTxt, role, worktree,
           agent: roleRes.agentName, fingerprintId: cardId, fingerprint: null, outOfScope: [],
           timedOut: r.timedOut, signal: r.signal ?? null, spawnErrorCode: r.errorCode ?? null }
  // ★ 2026-10-05：**并发组里"收活后留痕"必须延后到整组跑完**（见 `afterSnapshot`）——
  //   否则 A 的 after 会在 B 还在写文件时拍，把 B 的产物算成 A 的差异。
  //   延后是安全的：差异按**本任务自己的文件白名单**归属，而并发组内白名单互不重叠（调度段保证）。
  if (!opts.deferAfter) afterSnapshot(call, t)
  return call
}

/**
 * 把"越界清单"**分成两种**（施工文档 §四 M6-10 第 2 件）—— 这是"越界"这件事最容易误判的地方：
 *   · **白名单缺项**：越界文件**就在交付物所在目录里**（或它本身就是交付物）⇒ 不是"手伸长了"，
 *     是**卡的白名单没写全** ⇒ 该做的是**补白名单**，不是骂执行者；
 *   · **真越界**：落在交付物所在模块**之外** ⇒ 这才是要报给人看的。
 * 判据来自实测：T59 那批"越界" `server/src/modules/chat/service.ts`（7 次）**就是它的交付物**。
 * ⚠️ 白名单为空 ⇒ 归不了因 ⇒ **fail-loud**（出声不拦，见调用处）。
 */
function classifyOutOfScopeLegacy (paths, allowed) {
  const norm = (x) => String(x).replace(/\\/g, '/').replace(/^\.\//, '')
  const allow = allowed.map(norm)
  const dirs = new Set(allow.filter(a => a.includes('/')).map(a => a.slice(0, a.lastIndexOf('/'))))
  const whitelistGap = []; const realOverreach = []
  for (const p of paths) {
    const q = norm(p)
    if (allow.includes(q) || [...dirs].some(d => d && q.startsWith(d + '/'))) whitelistGap.push(q)
    else realOverreach.push(q)
  }
  return { whitelistGap, realOverreach }
}

/**
 * ★ b200（施工文档 §四 M6-6 落地）：**原片（`out.json`）的三个数**进收据 —— 存在性／大小／最后修改。
 * 为什么只补这三个：查过历史（b144 查 369 个会话、b191 复测 385 个），**大脑一次都没真读过原片**；
 *   它真问过的只有"那个目录里**有没有出现** `REVIEW-*.out.json`"这种**存在性**问题 ⇒
 *   **这正是它历史上真用过的粒度**。补上它，大脑不必去读那份很大的档案就能回答这类问题。
 * ⚠️ 只记**元数据**，不把原片内容搬进收据（收据要瘦）。
 */
function outFileMeta (p) {
  if (!p) return { exists: false, path: null, bytes: null, mtime: null }
  try {
    const st = statSync(p)
    return { exists: true, path: p, bytes: st.size, mtime: new Date(st.mtimeMs).toISOString() }
  } catch { return { exists: false, path: p, bytes: null, mtime: null } }
}

/**
 * ★ 2026-10-23（施工文档 D11）：**白名单补齐** —— 这些东西本来就不该被算成"越界"。
 *
 * ★ 2026-10-26（§四 删/并/退：「删除内核硬编码 SCOPE_NOISE，改为项目策略」）：
 *   这份清单**搬到了** `_调度.mjs` 的 `DEFAULT_POLICY.sharedOutputs`，项目可以用
 *   `gate.json#policy.sharedOutputs` 或 `_crew/策略.json` 覆盖。内核不再硬编码。
 */
const SCOPE_POLICY = loadPolicy(PROJECT)
function isScopeNoise (p) { return isSharedOutput(p, SCOPE_POLICY) }

/** 收活后留痕 + 差异清单（可延后调用；并发组里由调度段在整组跑完后**逐个**调用）。
 *  ★ b211：`siblingPaths` ＝ **同一并行组里别人的交付物** —— 这些文件出现在我的窗口里是**正常**，
 *  不能算我越界（实测：冒烟跑里 S1 把 b.txt 记成"真越界"、S2 把 a.txt 记成"真越界"，各 1 处假警报）。
 *  ★ D11：再加两道 —— ① 白名单补齐（`证据/` 之类根本不算）② **拿不到写入者就不指认**。 */
function afterSnapshot (call, t, siblingPaths = [], opts = {}) {  const allowed = (Array.isArray(t.files) && t.files.length ? t.files : (t.deliverables ?? []))
    .filter(x => typeof x === 'string' && /[\\/]|\.[a-zA-Z0-9]{1,6}$/.test(x))
  fingerprintSnap(call.fingerprintId ?? t.id, 'after')
  const fp = fingerprintDiff(call.fingerprintId ?? t.id, allowed)
  const { kept: keptRaw, dropped } = deductSiblings(fp?.outOfScope ?? [], siblingPaths, allowed)
  // ★ D11 第 3 条：白名单补齐（在分类之前摘掉，免得它们又变成"无理由越界"）
  const noise = keptRaw.filter(isScopeNoise)
  const kept = keptRaw.filter(p => !isScopeNoise(p))
  if (fp) {
    const c = fp.counts
    console.log(`  [指纹] ${t.id}：${c.added} 增 / ${c.changed} 改 / ${c.removed} 删${kept.length ? ` / ⚠️ ${kept.length} 处越界` : ''}` +
      (dropped.length ? `（其中 ${dropped.length} 处是**同一批别人产出的**，已剔除：${dropped.slice(0, 3).join('、')}）` : '') +
      (noise.length ? `（另有 ${noise.length} 处是**白名单补齐项**，不算越界）` : ''))
  }
  call.fingerprint = fp?.counts ?? null
  call.outOfScope = kept
  call.siblingProduced = dropped
  call.scopeNoise = noise
  // ★ b197（M6-10 第 2／3／6 件）：越界**分两种**、写进收据、白名单空就出声（不拦）
  call.whitelist = allowed
  call.whitelistEmpty = allowed.length === 0
  // ★ D22（补 20261022 D11 第 1 条）：**铁证认领** —— 只认载体事件流里"写"类调用的目标路径。
  //   老做法是文本子串匹配（那个 `agent_end` 有 20 万字符，系统提示里就写着 "writing new files" ⇒ 谁都能命中），
  //   回放 10 条：老做法认领 4 条、真答案 1 条。现在按写类调用认定，认不出就是 unknown（**不回头猜**）。
  const written = writtenBy(call.outJson, { project: PROJECT })
  const mine = []
  const notMine = []
  const claimDetail = {}
  const traced = []
  // 留痕记录的时间窗：这一次调用从开工到收工（前后各放 60 秒，容忍文件系统时间粒度）
  const isoMs = (x) => {
    if (x == null) return null
    const t = typeof x === 'number' ? x : Date.parse(String(x))
    return Number.isFinite(t) ? t : null
  }
  const win = { since: isoMs(call.startedAt), until: isoMs(call.endedAt) ?? Date.now(), windowMs: 60_000 }
  for (const p of kept) {
    const k = normPath(p, PROJECT)
    if (written.ok && written.set.has(k)) {
      claimDetail[k] = { claim: 'tool-call', ...(written.claims.get(k) ?? { tool: '?' }) }
      mine.push(p)
      continue
    }
    // ★ D22 第 ② 级：载体事件流里没有 ⇒ 查留痕记录（**这是 D11 原文说的"从 actions.jsonl 取 actor"**）。
    //   查到了 ⇒ 这条**不是这张卡改的**（多半是大脑/人在改文档），记 `claim:'trace'` 并写明是谁。
    let hit = null
    try { hit = traceQuery(PROJECT, p, win) } catch { hit = null }
    if (hit) {
      claimDetail[k] = { claim: 'trace', actorHint: hit.actor_hint ?? null, kind: hit.kind ?? null, at: hit.at ?? null }
      traced.push(p)
    } else {
      claimDetail[k] = null
    }
    notMine.push(p)
  }
  call.claim = {
    formats: written.formats, calls: written.calls, writtenFiles: written.set.size,
    traced: traced.length, detail: claimDetail
  }
  const mineSummary = written.ok
    ? (written.formats.join('/') || '?') + ' 事件流 · ' + written.calls + ' 次调用'
    : '**解析不出调用**（这份产出认不出格式）'
  if (traced.length) console.log(`  [越界] ${t.id}：其中 ${traced.length} 处**查到了留痕**（不是这张卡改的，见 actions.jsonl）：${traced.slice(0, 3).join('、')}`)
  call.outOfScopeKind = classifyOutOfScope(mine, allowed)
  call.outOfScopeUnattributed = notMine
  if (kept.length) {
    const k = call.outOfScopeKind
    console.log(`  [越界] ${t.id}：共 ${kept.length} 处 —— 有写入者 ${mine.length}（**白名单缺项 ${k.whitelistGap.length}** / **真越界 ${k.realOverreach.length}**）/ **查不到写入者 ${notMine.length}**（不指认）｜ 依据：${mineSummary}${k.realOverreach.length ? ' ⚠️ 要报给人看' : ''}`)
  }
  if (call.whitelistEmpty) {
    console.log(`  [越界] ⚠️ **${t.id} 的文件白名单是空的** ⇒ 越界归不了因（出声不拦；收据已记 whitelistEmpty=true）`)
  }
  // ★ b197（M6-10 第 4 件）：把这次的真越界记进内存表 ⇒ **下一个干同类活的卡会带上它**
  if (call.outOfScopeKind.realOverreach.length) {
    OVERREACH.set(t.id, [...new Set([...(OVERREACH.get(t.id) ?? []), ...call.outOfScopeKind.realOverreach])])
    console.log(`  [越界] ↳ 已记进"下一张卡通道"：${t.id} 真越界 ${call.outOfScopeKind.realOverreach.length} 个文件（依赖它的卡会收到提醒）`)
  }
  // ★ 2026-10-21（越界台账 · 用户口径"越界不是罪，是情报"）：
  //   ① 把"为什么动了白名单外的文件"从回执里抽出来（卡里早就要求写 `why:`，以前没人回收）
  //   ② 三档分类（卡欠账／有理由／无理由）→ 追加进 `<项目>\_crew\越界.jsonl`
  //   ③ 记录挂到 call 上，后面给依赖卡/兄弟卡/审核员广播用；**不判罚、不拦流程**。
  if (call.outOfScope.length) {
    const why = call.outJson ? whyFromEnvelope(call.outJson) : null
    const ev = { run: stamp, outJson: call.outJson ?? null, source: 'out.json 里的写类工具调用' }
    // ★ D22：认不出的那部分再分两档 —— 「留痕里查到了是谁」（trace）vs「真查不到」（unattributed）
    const tracedPaths = notMine.filter((p) => claimDetail[normPath(p, PROJECT)]?.claim === 'trace')
    const unknownPaths = notMine.filter((p) => claimDetail[normPath(p, PROJECT)]?.claim !== 'trace')
    const recs = [
      ...classifyRecords({
        task: t.id, role: t.role, paths: mine,
        gapPaths: call.outOfScopeKind.whitelistGap, why, batch: stamp,
        actor: 'this-card', sharedSnapshot: !!opts.sharedSnapshot, evidence: ev, claim: 'tool-call',
        claimDetail
      }),
      // ★ D22 第 ② 级：留痕记录说这次改动是**别人**做的（多半是大脑在改文档）⇒ 照记，写明出处
      ...classifyRecords({
        task: t.id, role: t.role, paths: tracedPaths, gapPaths: [], why, batch: stamp,
        actor: 'unknown', sharedSnapshot: !!opts.sharedSnapshot, claim: 'trace',
        claimDetail,
        evidence: { ...ev, note: '这条卡的写类调用里没有它；`_crew\\actions.jsonl` 里有同一路径的留痕 ⇒ **不是这张卡改的**' }
      }),
      // ★ D11：真查不到写入者的那部分**照记但标 unattributed**（留作情报，不冤枉谁）
      ...classifyRecords({
        task: t.id, role: t.role, paths: unknownPaths, gapPaths: [], why, batch: stamp,
        actor: 'unknown', sharedSnapshot: !!opts.sharedSnapshot, claim: 'none',
        evidence: { ...ev, note: '这张卡的写类调用里没有它、留痕里也查不到 ⇒ **不知道谁改的**' }
      })
    ]
    call.overreach = recs
    RUN_RECORDS.push(...recs)
    for (const r of recs) {
      const list = SCOPE_BY_TASK.get(r.task) ?? []
      list.push(r); SCOPE_BY_TASK.set(r.task, list)
    }
    const s = summarizeOverreach(recs)
    const led = appendLedger(PROJECT, recs)
    console.log(`  [越界·台账] ${t.id}：${s.total} 处（卡欠账 ${s.gap} / 有理由 ${s.justified} / 无理由 ${s.unjustified} / 查不到写入者 ${s.unattributed}）${why ? `｜理由：${why.slice(0, 40)}` : '｜回执里没写 why:'}`)
    if (led.added) console.log(`  [越界·台账] ↳ 已追加 ${led.added} 行 → ${led.path}`)
  }
  return call
}

/**
 * 异步跑载体（**真并发的地基**）。
 * 为什么不用 spawnSync：它**阻塞** —— 批内 `for` 逐个调 = 墙钟与串行相同（"分批 ≠ 同时"就是这么来的）。
 * ⚠️ 输出仍然**只落文件、不接管道**（PowerShell UTF-16 重定向那个坑的纪律不变）：
 *   这里用 `stdio: ['ignore','pipe','pipe']` 收 stdout/stderr 到内存，再用 Node 自己写文件（等价于 `1> 文件`，
 *   不经过 PowerShell 重定向）；父进程只在被掐断时 kill 子进程。
 */
function runCarrierAsync (inv, { cwd, env, timeoutMs, onSpawn, outFile, errFile, graceMs = 0, onClosing = null }) {
  return new Promise((resolve) => {
    let out = '', err = '', timedOut = false, errorCode = null, signal = null, settled = false
    let outStarted = false, errStarted = false
    // ★ 2026-10-10（A4 只读实验 `_probe\_A4流式实验.mjs` 的结论，修 bug）：
    //   原来内存那份是 `out += c.toString('utf8')` —— **逐块独立解码**，
    //   多字节字符（中文/emoji）一旦被块边界切开就解不出来 ⇒ 变成替换字符 `�`，
    //   而落盘的 `appendFileSync(outFile, c)` 追加的是**原始 Buffer**、跨块天然安全 ⇒ **两条路口径不一致**。
    //   实测：1 字节块坏 23 个字；**真实 64KB 块、240KB 文件也坏 2 个字**。
    //   ⇒ 内存那份改用 `StringDecoder`（不完整的尾巴留到下一块再拼），改完两边**逐字节一致**（`_A4修法验证.mjs` 实测 0 替换字符）。
    //   危害面小（账本抠的是 ASCII 字段、且本项目禁"读散文取状态"），但"内存 == 落盘"这条等价性值得钉死。
    const decOut = new StringDecoder('utf8')
    const decErr = new StringDecoder('utf8')
    let child
    try {
      child = spawn(inv.exe, inv.argv, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ status: null, stdout: '', stderr: String(e?.message ?? e), timedOut: false, signal: null, errorCode: 'SPAWN_FAIL' })
    }
    // ★ 2026-10-07：把**子进程 pid** 交给调用方 —— 看板的角色灯靠它判"真的在跑"（见 markRunning）。
    //   只有在这里才拿得到 pid（`spawn` 返回后立刻可用；等 `close` 再拿就没意义了 —— 那时它已经死了）。
    try { if (child?.pid) onSpawn?.(child.pid) } catch { /* 登记失败不影响这一次调用 */ }
    // ★ 2026-10-23（施工文档 D12「90 分钟是收尾，不是检查」）：
    //   到点**先取证再杀** —— 硬杀可能正好砍在写文件/写收据中间，留下半个文件；先留产物、再宽限、再杀，产物在、能续跑。
    let graceTimer = null
    const timer = setTimeout(() => {
      try { onClosing?.() } catch { /* 取证失败也照杀，不能因为记录失败把进程留着 */ }
      if (graceMs > 0 && !settled) {
        graceTimer = setTimeout(() => {
          timedOut = true
          try { child.kill('SIGKILL') } catch {}
        }, graceMs)
        return
      }
      timedOut = true
      try { child.kill('SIGKILL') } catch {}
    }, timeoutMs)
    // ★ 2026-10-10「边跑边写」：除照旧收内存，还**边收边落盘**（首块截断写、其后追加）——
    //   面板看板"每一步实时滚"靠它（原来只有 close 之后才 writeFileSync，中间过程看不见）。
    //   最终内容与旧路径逐字节相同；文件写不动只吞掉、绝不影响派活（与指纹同纪律）。
    child.stdout?.on('data', (c) => {
      const s = decOut.write(c)
      if (out.length < (64 << 20)) out += s
      if (outFile) { try { if (outStarted) appendFileSync(outFile, c); else { writeFileSync(outFile, c); outStarted = true } } catch {} }
    })
    child.stderr?.on('data', (c) => {
      const s = decErr.write(c)
      if (err.length < (8 << 20)) err += s
      if (errFile) { try { if (errStarted) appendFileSync(errFile, c); else { writeFileSync(errFile, c); errStarted = true } } catch {} }
    })
    child.on('error', (e) => { errorCode = e?.code ?? 'ERROR'; if (!settled) { settled = true; clearTimeout(timer); if (graceTimer) clearTimeout(graceTimer); resolve({ status: null, stdout: out + decOut.end(), stderr: err + decErr.end(), timedOut, signal, errorCode }) } })
    child.on('close', (code, sig) => {
      if (settled) return
      settled = true; clearTimeout(timer); if (graceTimer) clearTimeout(graceTimer); signal = sig ?? null
      resolve({ status: code, stdout: out + decOut.end(), stderr: err + decErr.end(), timedOut, signal, errorCode })
    })
  })
}


// ---------------------------------------------------------------- 收活判定（§5.4）

/**
 * ★ b219：认"内容被拦"。
 * 只在**这一趟已经失败**时才认（`isError` 或 `ok===false`）——成功的一趟里正文可能只是在"讨论"过滤器，
 * 不能拿关键词当证据（否则 coder 写个过滤器就把自己判成被拦）。
 * ★ 2026-10-22 真跑纠正（T1-03 误判）：原来还扫 out.json 原文**自由词**，结果模型**思考里提到** "content_filter"
 *   就把一趟 **ECONNRESET 传输错误**判成了"内容被拦"（filtered 不重试 ⇒ 一张本该重试的卡被 block）。
 *   现在只认**结构性证据**：`finish_reason/content_filter`、`data_inspection_failed` 这类**字段值**；
 *   并且**传输类错误一票排除**（ECONNRESET / ECONNREFUSED / ETIMEDOUT / socket 等）。
 */
const RE_TRANSPORT = /(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|connection (lost|reset|closed)|Connection lost while reading)/i
const RE_FILTER_STRUCT = /(?:finish_reason["']?\s*[:=]\s*["']?(?:content_filter|safety|sensitive)|"code"\s*:\s*"_?(?:data_inspection_failed|content_filter)"|data_inspection_failed)/i
function detectContentFilter (env, call) {
  if (!(env?.isError === true || env?.ok === false)) return null
  const errBits = [env?.stopReason, env?.error].filter((x) => typeof x === 'string' && x).join(' ')
  // 传输错误不是"被拦"——它该走 flaky 重试
  if (RE_TRANSPORT.test(errBits)) return null
  const m1 = RE_FILTER_STRUCT.exec(errBits)
  if (m1) return m1[0]
  // 兜底：错误没写进信封、只写在原始输出里 ⇒ **只认结构字段**，不认自由词（思考里提到不算）
  try {
    const t = readFileSync(call.outJson, 'utf8')
    const m2 = RE_FILTER_STRUCT.exec(t.slice(-8000))
    if (m2) return m2[0]
  } catch {}
  return null
}

function judge (call) {
  // ★ 2026-10-26：**必须把派活失败的原因带出来**。原来只回一句"任务卡/派活失败"，
  //   收据里一个字段都没有 ⇒ 现场只能靠猜（实测：T2 连跑两轮都是这句，人工手跑派活却 exit=0）。
  //   纪律：任何"失败"结论都必须带证据，哪怕证据只是 stderr 的前 600 字。
  if (call.stage === 'dispatch') {
    const why = String(call.error ?? '').trim() || '（派活进程非零退出，但没留下 stderr/stdout）'
    return { verdict: 'input-error', action: '打回大脑：任务卡/派活失败，不消耗班组重试', retry: false, why }
  }
  if (call.stage === 'dry-run') return { verdict: 'dry-run', action: '演练：未真调', retry: false }
  if (!call.outJson || !existsSync(call.outJson)) return { verdict: 'flaky', action: '无信封 → 同通道重试 1 次', retry: true }

  // ★ 2026-10-03：改用共用解析器 —— 单信封（Qoder / DSH）与 **JSONL 事件流**（Pi / OpenCode）都认。
  //    原来只会 JSON.parse 整段，于是 Pi/OpenCode 明明跑通了却被判"信封解析失败"（自检工具说谎）。
  let raw = null
  try {
    const b = readFileSync(call.outJson)
    raw = (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE)
      ? b.subarray(2).toString('utf16le')   // 兜底：PowerShell 重定向会写 UTF-16LE
      : b.toString('utf8')
  } catch { /* 落到下面判 flaky */ }
  if (raw === null) return { verdict: 'flaky', action: '信封读不出来 → 同通道重试 1 次', retry: true }

  const env = parseCarrierOutput(raw, existsSync(call.errTxt) ? readFileSync(call.errTxt, 'utf8') : '')
  if (env.kind === 'unknown') return { verdict: 'flaky', action: `输出无法解析（${env.error}）→ 重试 1 次`, retry: true }
  // ★ b219 补（2026-10-22 真跑逮到）：**不管判成什么，都把会话号/峰值挂在 call 上**。
  //   原来只有 'ok' 那三条分支带 sessionId ⇒ 一旦判成 ac-unknown / flaky / blocked，收据里就丢了
  //   （实测 T1-01：流里明明有 session_id，收据里是 null）⇒ 续跑接不上、事后没法回溯。
  call.sessionId = env.sessionId ?? call.sessionId ?? null
  call.ctxPeak = env.ctxPeak ?? call.ctxPeak ?? null
  // ★ 2026-10-23（D3 / D14）：把"怎么死的"和"用量"原样留下来 —— 撞顶要 stopReason，算占用要 usage。
  call.stopReason = env.stopReason ?? call.stopReason ?? null
  call.usageRaw = env.usage ?? call.usageRaw ?? null

  const denials = env.permissionDenials.length
  const ctx = env.usage?.context_usage_ratio ?? null
  // ★ b219：峰值（拆分经济用）；取不到就退回末值
  const ctxPeak = env.ctxPeak ?? ctx

  if (denials > 0) return { verdict: 'denied', action: '**不重试**：这是"卡住"的确证，把被拒条目摆出来', retry: false, denials }

  // ★ 2026-10-23（施工文档 D3 · 撞顶）：**结束态先判** —— 进程已经结束了，不是"还在跑但停了"，所以不走 D4。
  //   判据三条同时成立（T1-01 #1 的真实现场：output=16384 / reasoning=16383 / stopReason=length）：
  //     ① stopReason 是 length 一族；② 正文 0 字；③ 工具调用 0 次。
  //   动作：判 `thinking-overflow`，由主循环**只降一档重发一次**（降过还撞 ⇒ blocked 报人，不无限降档）。
  const stopReason = String(env.stopReason ?? '')
  const hitCeiling = /^(length|max_tokens|max_output_tokens|max_completion_tokens)$/i.test(stopReason)
  const emptyBody = !String(env.result ?? '').trim()
  const zeroTools = !(Number(env.toolCalls ?? 0) > 0)
  if (hitCeiling && emptyBody && zeroTools) {
    const u = env.usage ?? {}
    const outTok = u.output ?? u.output_tokens ?? u.completion_tokens ?? null
    const reaTok = u.reasoning ?? u.reasoning_tokens ?? u.reasoningTokens ?? null
    call.thinkingOverflow = true
    return {
      verdict: 'thinking-overflow', retry: false, ctx, ctxPeak, sessionId: env.sessionId ?? null, denials,
      kind: env.kind, toolCalls: env.toolCalls,
      action: `撞顶（stopReason=${stopReason}，正文 0 字、工具 0 次${outTok !== null ? `，output=${outTok}` : ''}${reaTok !== null ? ` / reasoning=${reaTok}` : ''}）⇒ **降一档重发（仅一次）**`
    }
  }
  // ★ 额度/账号类：只停这条网关，不重试（没额度时重试只是白烧次数）
  // ★ 2026-10-04 修（T1 实测误报）：原来把 `env.result`（=回执正文）也拼进关键词扫描——
  //   coder 在代码/回执里写了错误码总表（401/403/429/quota…）就被判"账号类故障"整轮停手。
  //   修正：账号类只认**失败证据面**（env.error + stderrTail），且必须信封确实报错（isError 或 exit≠0）才开这道闸。
  const failBlob = `${env.error ?? ''} ${env.stderrTail ?? ''}`
  const failed = env.isError === true || call.ok !== true
  // ★ 2026-10-26（限流拆分）：**先判限流，再判账号**。
  //   原来 `429` 和 `401/403/quota` 挤在同一个正则里 ⇒ 一次限流就被当"账号坏了"：
  //   要么整轮停手、要么立刻换 API（烧掉一个还能用的家）。
  //   实测依据：本机 490 个 DSH 会话、2745 次 `llm/retry`，失败码
  //     RATE_LIMIT × 2009（73%）／TRANSPORT × 550／TIMEOUT × 173／SERVER × 13
  //   —— 限流是**等一等就好**的抖动，不是账号故障。
  //   判定规则在 `_退避.mjs`（纯函数、有单测）：限流先命中，`rate limit exceeded` 不会被 `exceeded` 抢走。
  const retryCls = failed ? classifyRetryableFailure(failBlob) : null
  if (retryCls === 'rate-limit') {
    const hinted = parseRetryAfterMs(failBlob)
    return {
      verdict: 'rate-limit', retry: true, retryAfterMs: hinted, waitMs: hinted ?? undefined,
      action: `限流（${failBlob.replace(/\s+/g, ' ').trim().slice(0, 90)}）⇒ **退避后同通道重试 1 次**${hinted != null ? `（按服务端 Retry-After ≈${Math.round(hinted / 1000)}s）` : ''}`
    }
  }
  if (retryCls === 'account') {
    return { verdict: 'account', action: '**整轮停手**：账号/额度类故障（只停这条网关）', retry: false }
  }
  // ★ b219（2026-10-22，用户拍板"内容拦截要单列，别烧换家链"）：
  //   **必须插在 `env.isError === true` 之前** —— 现网 content_filter 会被解析器标成 isError，
  //   放在后面就永远进不到这一支，只会被当 flaky 重试。
  //   三条硬口径：① retry:false（重试同内容大概率再被拦）；② verdict 进 FAIL_OK（不触发换家）；
  //   ③ 不进 RESCUE_ABLE / ACABLE（不拉最贵的急救、不跑 AC 门）。
  //   重试走"**新会话**"由调用方决定（续跑会把被拦内容再发一遍）。
  const filterWhy = detectContentFilter(env, call)
  if (filterWhy) {
    return { verdict: 'filtered', action: `内容被拦（${filterWhy}）⇒ **不换家、不重试同会话**；可换新会话重试一次，仍被拦就报人`, retry: false }
  }
  if (env.isError === true) {
    return { verdict: 'flaky', action: `is_error / 报错（${String(env.error ?? env.stopReason ?? '').slice(0, 80)}）→ 重试 1 次`, retry: true }
  }
  if (ctx !== null && Number(ctx) >= CTX_LIMIT) {
    // ★ 2026-10-05（用户问"假如 coder-a 写了 50 分钟、一个会话上下文写满了呢"）：
    //   **上下文写满 ≠ 一定没干完** —— 实测 T8 急救的信封 `context_usage_ratio=1` 且 `subtype=success`、活全干完了。
    //   而载体自己也会"压缩上下文"续跑（opencode 库里有 compaction 记录），风险是**压缩后可能忘掉后半段要求**。
    //   所以：**有产物落盘 + 没被掐断** → 不判死，**进待审并明写"请重点核交付物"**（和 `rescue-uncertain` 同一口径）；
    //         否则维持"记账 + 提示拆任务（不自动重试）"。
    // ★★ b200（用户 2026-10-19 口径："**不给子 agent 设限，按它们自己的上下文管理即可**"；实测子 agent 很少一次任务到 50%）：
    //   **上下文占用不再参与判决** —— 判决权只给 M6-2 定稿的三条独立信号（空转／无产物／墙钟）。
    //   原来满上下文会把 verdict 改成 `ctx-full`／`ctx-full-reviewed` ⇒ 审计里这活就记成"非 ok"，
    //   哪怕活全干完了、载体已自行压缩续跑（实测 T8：`context_usage_ratio=1` 且 `subtype=success`）。现在：
    //     · **verdict 不变**（ok 就是 ok）；占用率只进收据字段 `ctxPct` ＋ action 一句提示；
    //     · **唯一保留的动作**：满上下文**且有产物** ⇒ `needsReview`（请审核员重点核交付物）—— 那不是罚载体。
    const cP = ((call.fingerprint?.added ?? 0) + (call.fingerprint?.changed ?? 0)) > 0
    // ⚠️ 这里**不能用 `...base`** —— `base` 在本函数后面才声明（`const` ⇒ TDZ，
    //    实测会 `Cannot access 'base' before initialization`；本文件另一处注释也记着这个坑）⇒ 显式写全字段。
    const ctxBase = { verdict: 'ok', retry: false, ctx, ctxPeak, sessionId: env.sessionId ?? null, denials, kind: env.kind, toolCalls: env.toolCalls }
    if (cP && call.timedOut !== true && call.signal == null) {
      return { ...ctxBase, needsReview: true,
        action: `收活（⚠️ 上下文占用 ${ctx} ≥ ${CTX_LIMIT} 满，但**有产物落盘**：+${call.fingerprint?.added ?? 0} 增 / ~${call.fingerprint?.changed ?? 0} 改）⇒ **请重点核交付物**（不判死、不重试；载体自己会压缩续跑）` }
    }
    return { ...ctxBase, needsReview: false,
      action: `收活（⚠️ 上下文占用 ${ctx} ≥ ${CTX_LIMIT} 满、**零新增零修改**）⇒ 只记账 ＋ 提示拆任务（不重试；按 b200 口径**不改判决**）` }
  }
  // ★ 2026-10-05 新增（用户问"假如 coder-a 确实写了 1 个小时呢"问出来的**烧钱死角**）：
  //   原来被保护性超时掐断 → `call.ok !== true` → 判 flaky(可重试) → 重试再撞 45 分钟 → 再急救又 45 分钟
  //   → **一个"真需要 1 小时"的任务最多白烧 3×45 分钟 + 3 份额度，最后 blocked**。
  //   口径（与"归因优先于重试"一致）：**超时不自动重试、也不上急救**（同任务同时限，重来大概率再撞），
  //   直接回给大脑：**要么拆小任务，要么显式加 `--timeout-min` 重跑**（并留痕）。
  //   ⚠️ 判定依据是 spawnSync 的 `ETIMEDOUT`（不是猜"疑超时"）。
  if (call.timedOut === true) {
    return { verdict: 'timeout', retry: false,
      action: `被保护性超时掐断（时限 ${TIMEOUT_MIN} 分钟，实跑约 ${Math.round((call.tookMs ?? 0) / 60000)} 分钟）→ **不自动重试**：任务太大就拆小；确实该跑这么久就显式加 --timeout-min 重跑` }
  }
  // ★ 2026-10-05 修（T24 实测）：超时被杀的进程，输出流末尾可以**没有任何 error 事件**——
  //   只看信封会判 ok（T24 主体做完但 smoke 脚本没落盘就被"收活"）。
  //   口径：进程退出码非 0（且**不是**上面的"确认被超时掐断"）一律按偶发失败重试；
  //   重试方 prompt 已带"先查产物再续做"，幂等不白干。
  if (call.ok !== true) {
    return { verdict: 'flaky', action: `进程退出异常（exit=${call.exitCode}，信封无错误标记，疑超时被杀）→ 重试 1 次`, retry: true }
  }
  // ★ 2026-10-07（用户拍板）**审核员机器校验：让卡上的规矩"长牙"**。
  //   为什么必须做：卡上的规矩只是"建议"，保守的模型会用"多跑一遍全量"来买安心 ⇒ 只有**能被机器判**的才算数。
  //   判据（**宁可漏判、不可误判**：只认明确的越界写法，其余只提示、不改判决）：
  //     ① 越界：回执里出现 `npm test` / `npm run test`（全量命令该由门禁跑，零 token）⇒ verdict = review-overreach
  //     ② 未验：回执里**没引用门禁结果文件**（`gate-result.json`）⇒ verdict = review-unverified
  //     ③ 超预算（软）：工具调用数 > 25 ⇒ **只写进 action 提示，不改判决**
  if (/^reviewer/.test(String(call.role ?? ''))) {
    // ★ 2026-10-27：判据搬进 `_审核一次.mjs` 的 `reviewPolicyOf()` —— **纯函数才测得了**。
    //   卡上规矩"长牙"全靠这一条；它要是没接线，规矩就退化成建议（`门禁.mjs` 那条就是这么漏的）。
    //   ⚠️ 口径不变：违规 ≠ 调用失败 ⇒ 一律 `verdict: 'ok'` 照常收活，只把违规写进 `policy`。
    const base = { verdict: 'ok', retry: false, ctx, ctxPeak, sessionId: env.sessionId ?? null, denials, kind: env.kind, toolCalls: env.toolCalls }
    const { policy, action } = reviewPolicyOf({ body: String(env?.result ?? ''), toolCalls: Number(env?.toolCalls ?? 0) })
    return { ...base, policy, action }
  }
  return { verdict: 'ok', action: '收活', retry: false, ctx, ctxPeak, sessionId: env.sessionId ?? null, denials, kind: env.kind, toolCalls: env.toolCalls }
}

// ---------------------------------------------------------------- 环境类 vs 代码类（★ 2026-10-06 用户拍板第 1 条）
//
// 用户原话："没 key、账号注册这类，**不算过**，但**也不需要去修 BUG**（我怕这类事件会给审核去修 BUG，
//   纯浪费 token 的），这类事件应该**留给我去想办法解决**；而有的 BUG 比如审核、急救也解决不了，
//   最后也应该给我解决。"
//
// 落成两条机器规矩：
//   ① **环境类失败的活，绝不派审核员去"修"** —— 它既修不了（要人去补 key/续费/注册），
//      又白烧一份额度。判定为环境类 → 任务标 `blocked`、写进 `_crew\halt.json`（待你处理的清单），
//      **不重试、不急救、不进审校**；同时**其它能做的任务照常往下跑**（用户第 2 条：能继续就继续）。
//   ② 代码类失败照旧走重试/急救/审核 —— 那才是它们该管的。
//
// 判定依据**只认证据面**（命令自身存在性 + 输出的错误特征），不猜：
//   · 命令/脚本根本不存在（"Missing script"、文件不存在）→ 环境类（活没干完，但根因不在代码）
//   · 输出里出现凭据/额度/网络/外部服务不可用的特征 → 环境类
//   · ★ 2026-10-09 八·S2：命中"真代码错"的**正面特征**（编译错/断言错/JS 异常/测试失败标记）→ 代码类
//   · ★ 其余（两张表都没认出）→ **未知类**：不派修、报给人（旧版把"认不出的"一律当代码错）
// ⚠️ 反向纪律：**不许把"真代码错"误判成环境类**（那会让真 bug 溜过去），所以特征串必须够具体
//   （例：只认 `401 unauthorized`，不认孤零零一个 `401`）。
const ENV_PATTERNS = [
  /missing script/i,                       // npm 脚本不存在
  /command not found|不是内部或外部命令|无法将.*识别为/i,
  /ENOENT/i,
  /(api[_ -]?key|token|secret|credential|credentials)[^\n]{0,40}(missing|not set|undefined|empty|invalid|required|未设置|缺失)/i,
  /(401|403)[^\n]{0,20}(unauthor|forbidden|invalid)/i,
  /unauthorized|forbidden|invalid api key|invalid[_ -]?token/i,
  /quota|rate limit|too many requests|insufficient|exceeded|余额|额度|欠费/i,
  /ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|getaddrinfo|socket hang up|fetch failed|network/i,
  /dashscope|ark\.cn-beijing|volces\.com|bailian|aliyuncs/i,   // 外部服务域名（多半是没 key / 没网）
  /please (log ?in|sign ?in|authenticate)|not logged ?in|登录|未登录|重新登录/i
]
const COMMAND_MISSING = [/missing script/i]

// ★ 八·S2（§14.2）："真代码错"的**正面特征**（只在 env 表全不中之后才用）。
//   为什么要有它：旧版默认分支"认不出 = 代码类"，会把**没覆盖的环境故障**（磁盘满/证书过期/代理挂…）
//   派去"修"（重试→急救，真烧额度）。拆成两出口后：认得出的代码错照旧派修，认不出的**报给人**。
const CODE_PATTERNS = [
  /error TS\d+/i,                                                          // tsc 编译错（`src/x.ts(1,2): error TS2322: …`）
  /AssertionError|Assertion failed/i,
  /\b(?:SyntaxError|TypeError|ReferenceError|RangeError)\b/,
  /expected [^\n]{0,80}(?:to (?:be|equal|match|contain|throw)|received)/i,  // vitest/chai 断言行
  /(?:Test Files|Tests)\s+\d+\s+failed|(?:^|\]\s*)FAIL\s+\S/m              // 测试失败标记/汇总（含 smoke 的 `[x] FAIL` 与行首 `FAIL ⑥`）
]

/** 判定一次 AC/门禁失败是"环境类 / 代码类 / 未知"；返回 { cls, env, code, unknown, why }。
 *  ★ 2026-10-09 八·S2：三态 —— unknown＝"两张表都没认出来"，**不派修、报给人**（旧版默认当代码类）。 */
function classifyFailure (text) {
  const t = String(text ?? '')
  for (const re of COMMAND_MISSING) if (re.test(t)) return { cls: 'env', env: true, code: false, unknown: false, why: `命令/脚本不存在（${(t.match(re) ?? [''])[0]}）—— 要人来补，不是代码错` }
  for (const re of ENV_PATTERNS) {
    const m = t.match(re)
    if (m) return { cls: 'env', env: true, code: false, unknown: false, why: `外部条件不满足（命中「${m[0].slice(0, 40)}」）—— 要人来补（key/账号/网络/额度），不是代码错` }
  }
  for (const re of CODE_PATTERNS) {
    if (re.test(t)) return { cls: 'code', env: false, code: true, unknown: false, why: null }
  }
  return { cls: 'unknown', env: false, code: false, unknown: true, why: '机器没认出是哪类（环境特征、代码特征都没命中）—— 先别当代码错修，报给人看证据' }
}

/** 把"要人处理"的事写进 `<项目>\_crew\halt.json`（看板读它出红灯；同 id 不重复堆）。 */
const HALT_FILE = () => join(PROJECT, '_crew', 'halt.json')
/**
 * **批号兜底**（2026-10-26 修）：批号是"这一批任务的指纹"，理论上一定有值；
 * 但实测出现过 `REVIEW-da39a3ee5e6b` —— `da39a3ee5e6b` 正是 **SHA-1("")** 的前 12 位，
 * 说明批号是在**空输入**下算出来的。这种人最危险：**看起来像正经 ID，实际什么都没绑定**。
 *
 * 口径：批号为空 / 等于空哈希 ⇒ 写成 `<stamp>-unbound`，并**明确说"没绑上"**，
 * 绝不让一个"像哈希"的假 ID 混进待办清单。
 */
function safeBatchTag (tag, stamp) {
  const t = String(tag ?? '').trim()
  const emptyHash = /^da39a3ee5e6b/i.test(t) || /^(e3b0c44298fc|d41d8cd98f00)/i.test(t) // sha1('') / sha256('') / md5('')
  if (!t || emptyHash) {
    console.warn('  ⚠️ 批号为空（或等于空内容哈希）⇒ 待办 id 用 `' + stamp + '-unbound`，别产出假指纹')
    return String(stamp) + '-unbound'
  }
  return t
}

function addHalt (item) {
  try {
    mkdirSync(join(PROJECT, '_crew'), { recursive: true })
    let list = []
    try { list = JSON.parse(readFileSync(HALT_FILE(), 'utf8')) } catch { list = [] }
    if (!Array.isArray(list)) list = []
    const key = `${item.id}|${item.kind}`
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19)
    const i = list.findIndex(x => `${x.id}|${x.kind}` === key)
    const rec = { ...item, at: now, seen: (i >= 0 ? (list[i].seen ?? 1) + 1 : 1) }
    if (i >= 0) list[i] = rec; else list.push(rec)
    writeFileSync(HALT_FILE(), JSON.stringify(list.slice(-40), null, 2), 'utf8')
    log(`  🔴 已记进待你处理的清单：${item.id}（${item.kind}）—— ${String(item.why ?? '').slice(0, 90)}`)
  } catch (e) { log(`  ⚠️ 待处理清单写不进去（不影响流程）：${String(e?.message ?? e)}`) }
}

/**
 * ★ 2026-10-06 新增：**销账** —— 红灯修好之后，把对应条目从"待你处理"里拿掉。
 *
 * 为什么必须补：`halt.json` 原来只能加不能减 ⇒ 一旦记过一条，**看板就永远挂着红灯**，
 * 哪怕后面已经修好（实测：审核员把 `smoke:proactive` 修到全绿之后，那条"审核也没解决"还挂在那儿）。
 * 假红灯比没有红灯更坏 —— 用户会学会无视它（"狼来了"）。所以成功路径要主动清。
 */
function resolveHalt (id, why = '') {
  try {
    const f = HALT_FILE()
    if (!existsSync(f)) return 0
    let list = JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
    if (!Array.isArray(list)) return 0
    const before = list.length
    // 按 id 前缀匹配（红灯条目可能带 kind 后缀，例 `REVIEW-<stamp>` 与 `T35`）
    const kept = list.filter(x => !(String(x.id) === String(id) || String(x.id).startsWith(String(id))))
    if (kept.length !== before) {
      writeFileSync(f, JSON.stringify(kept, null, 2), 'utf8')
      log(`  ✅ 已从"待你处理"清单销账：${id}${why ? `（${why}）` : ''}（${before - kept.length} 条）`)
    }
    return before - kept.length
  } catch { return 0 }
}

// ---------------------------------------------------------------- 放审核员动手前的"后悔药"快照
//
// ★ 2026-10-06 新增（B 方案审出来的真问题）：审核员**现在有权改代码**，而这个项目**不用 git**
//   ⇒ "改坏了"原来没有任何回退手段（用户原话的意思：不能让修理工空手进金库）。
//   所以放它动手前先把**可能被它碰的目录**整份复制一份（零 token、零外网、本地文件复制）。
//   还原：`node 文件指纹.mjs restore --project <项目> --id <该备份id>`
//   ⚠️ 只复制**明确列出的目录**（不整树），并排除 node_modules/.git/dist/_crew。
function backupBeforeReview (dirs) {
  // ★ 2026-10-27 修（真跑当场抓到的 bug，不是本次改动引入的）：这里原来自己写了一段清洗，
  //   过滤条件是 **`d.includes('/')`** —— 要求路径里必须有分隔符。于是根目录交付物
  //   （`index.html` / `gate.json` / `启动-背单词.vbs` / `tests`）全被丢掉 ⇒ `clean` 恒空 ⇒
  //   每轮都打「没有可备份的目录 → 跳过」，**审核前的后悔药一次都没吃上**，而审核员有全权写权。
  //   现在清洗搬进 `_审核备份范围.mjs` 的 `backupTargets()`（纯函数、有单测），只挡"整盘/整树"。
  const clean = backupTargets(dirs)
  // ★ 2026-10-06 修（三方交叉验证共同指出的"死保护"）：返回值必须有**明确的成败语义**，
  //   否则调用方的 `if (backup && backup.failed)` 永远为假（原来失败返回 `null`、成功对象里没有 `failed` 字段
  //   ⇒ "备份失败就不放审核员进场"这层 fail-closed **是死代码**）。
  //   现在：成功 `{ok:true,...}` / 失败 `{ok:false,reason}` / **没有可备份的范围** `{ok:true,skipped:true}`。
  if (!clean.length) { log('  [快照] 没有可备份的目录（本轮审核没有明确改动范围）→ 跳过（不算失败）'); return { ok: true, skipped: true } }
  const r = spawnSync(NODE, [FINGERPRINT, 'backup', '--project', PROJECT, '--id', `pre-review-${stamp}`, '--paths', clean.join(',')],
    { encoding: 'utf8', maxBuffer: 16 << 20, windowsHide: true })
  const out = String(r.stdout ?? '').trim()
  if (r.status !== 0) {
    const reason = out.split(/\r?\n/).filter(Boolean).pop() ?? `exit=${r.status}`
    log(`  ⚠️ [快照] 备份**失败**：${reason}`)
    return { ok: false, reason, dirs: clean }
  }
  log(`  [快照] ${out.split(/\r?\n/)[0]}`)
  return { ok: true, id: `pre-review-${stamp}`, dirs: clean, at: new Date().toISOString() }
}

// ---------------------------------------------------------------- 可执行 AC 的机器判定
//
// ★ 2026-10-05 新增（用户拍板的三条改造之一）。这是本工作台**第一次**让机器去判"活到底验过没有"。
//
// 背景：任务行的 `验收:` 一直只是一句中文；编排收活只看信封（退出码 / is_error / ctx / 指纹），
//   于是"完成后它自己说绿"就等于绿 —— 没有任何独立环节复核。现在改成两步：
//     ① 信封判定（判"它干完没有"）；
//     ② **AC 机判**（判"交付物真的达标没有"）—— 由 `台账.mjs ac` 真跑卡里写死的那条命令。
//   两条都过才允许进 review；AC 红了 → **不进 done**，打包回给大脑（含原话，供它重派）。
//   代价：多花几秒、不花 token（命令本身就是 coder 交活前跑过的那一条）。
// 没有可执行 AC 的任务：**放行但在收据里标 `machineVerified:false`**（诚实标注，不假装验过）。
const ACABLE = ['ok', 'rescued', 'rescue-uncertain', 'ctx-full-reviewed']
function verifyAcceptance (t) {
  const r = spawnSync(NODE, [LEDGER_JS, 'ac', '--project', PROJECT, '--id', t.id, '--json'],
    { encoding: 'utf8', maxBuffer: 32 << 20, timeout: 15 * 60_000, windowsHide: true })
  const txt = String(r.stdout ?? '').trim()
  // `--json` 模式下台账会把最后一行 JSON 打出来（前面可能有别的行）→ 取最后一段能解析的 JSON
  let j = null
  try { j = JSON.parse(txt) } catch {
    const m = txt.match(/\{[\s\S]*\}\s*$/)
    if (m) { try { j = JSON.parse(m[0]) } catch {} }
  }
  if (!j) return { ok: false, machineVerified: false, crashed: true, reason: `AC 机判跑不起来（exit=${r.status}）：${String(r.stderr ?? '').trim().slice(-200)}` }
  return j
}


// ---------------------------------------------------------------- AC 机判（终审）
//
// ★ 2026-10-06 从主循环里**提取成函数**并**挪到重试/急救之后**（三方交叉验证共同指出的后门）。
//   为什么必须是函数 + 必须晚于重试/急救：见主循环里那段"结构性修正"注释。
//   口径（与原来完全一致，只是时机变了）：
//     · 只在 `ACABLE`（真的被收下的 verdict）上跑；
//     · 机判**跑不起来** → fail-closed（不算过 + 写"待你处理"）；
//     · 没有可执行 AC → 放行但标 `machineVerified:false`（诚实标注）；
//     · 红了 → 先分**环境类 / 代码类**：环境类不派修复（只有人能补）、代码类不许进 done。
//   返回 `{ v, acResult }`（`v` 可能被改写；`acResult` 进收据）。
/** 凭据类（只有这三样才允许等人 —— 见 §5.4）：缺 key / 要注册 / 要付款。 */
const CRED_PATTERNS = [
  /api[_ ]?key/i, /apikey/i, /unauthorized|401/i, /invalid[_ ]token/i,
  /未登录|登录态|请先登录/, /注册|sign ?up|register/i,
  /余额不足|欠费|付费|订阅|subscription|payment|billing/i,
  /缺少.{0,6}(key|密钥|token)|no such env.*key/i
]
function credentialLike (text) { return CRED_PATTERNS.some((re) => re.test(String(text ?? ''))) }

/**
 * AC 红了之后的诊断（§4）：证据包 + 对账 + 阶梯第 0 级 —— **只做判断，不做动作**。
 * 动作（返工 / 裁判审 / 环境卡）在 §5.3 的四步链里执行；这一步的产出进收据。
 */
/** 从失败原话里认"缺哪个工具/包"（认不出就 null —— 不猜）。 */
function gapOf (text) {
  const s = String(text ?? '')
  let m = /No module named ['"]([\w.-]+)['"]/.exec(s)
  if (m) return { tool: 'python:' + m[1], kind: 'package' }
  m = /Cannot find module ['"]([^'"]+)['"]/.exec(s)
  if (m) return { tool: 'node:' + m[1], kind: 'package' }
  m = /['"]([^'"\s]{2,40})['"]\s*(?:不是内部或外部命令|is not recognized as)/i.exec(s)
  if (m) return { tool: m[1], kind: 'tool' }
  m = /(?:^|\s)([a-z][\w.-]{1,30}): command not found/im.exec(s)
  if (m) return { tool: m[1], kind: 'tool' }
  if (/Cannot connect to the Docker daemon|docker daemon is not running/i.test(s)) return { tool: 'docker', kind: 'tool' }
  return null
}

/** 合并写环境缺口（按 tool 去重；同一条不重复堆）。 */
function writeEnvGap ({ tool, kind, evidence, needsBy }) {
  try {
    const p = join(PROJECT, '_crew', '环境缺口.json')
    let j = { items: [] }
    try { j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch {}
    if (!Array.isArray(j.items)) j.items = []
    const hit = j.items.find((x) => x.tool === tool && x.state !== 'resolved')
    if (hit) {
      hit.needsBy = [...new Set([...(hit.needsBy ?? []), ...(needsBy ?? [])])]
      hit.evidence = String(evidence ?? hit.evidence ?? '').slice(0, 200)
    } else {
      j.items.push({ tool, kind, state: 'missing', needsBy: needsBy ?? [], evidence: String(evidence ?? '').slice(0, 200), at: new Date().toISOString() })
    }
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(j, null, 2), 'utf8')
    log(`  📦 环境缺口已记：${tool}（用户看板"待你处理"之外的那张 ENV 卡清单）`)
  } catch (e) { log(`  ⚠️ 环境缺口写不进去：${String(e?.message ?? e).slice(0, 100)}`) }
}

function diagnoseAc ({ t, acResult, call }) {
  try {
    let outText = ''
    try { outText = call?.outJson ? readFileSync(call.outJson, 'utf8') : '' } catch {}
    const selfTests = selfTestsOf(outText)
    const claims = parseRan(outText)
    const check = (acResult?.checks ?? [])[0] ?? {}
    const cmd = check.cmd ?? null
    const exit = Number.isFinite(acResult?.exitCode) ? acResult.exitCode : 1
    const stdout = (acResult?.checks ?? []).map((c) => c.tail ?? '').join('\n')
    const evidence = buildEvidence({ card: t.id, role: t.role, acCmd: cmd, acExit: exit, stdout, stderr: '', cwd: PROJECT, selfTests, claims })
    const rec = reconcile({ acCmd: cmd, acExit: exit, selfTests, claims })
    const attr = attribute({ stdout, stderr: '' })
    const next = actionForReconcile(rec.kind).next
    log(`  🧭 对账：${t.id} → ${rec.kind}（${rec.why}）⇒ 下一步 ${next}` + (attr.level === 0 ? `（症状库命中：${attr.zh}）` : ''))
    // ★ 2026-10-24（§5.4）：工作区缺口 ⇒ 落盘，交给大脑派 ENV 卡（不换实现、不叫人）
    if (attr.kind === 'env-workspace') {
      const gap = gapOf(stdout)
      if (gap) writeEnvGap({ tool: gap.tool, kind: gap.kind, evidence: String(stdout).slice(-200), needsBy: [t.id] })
      else log(`  ⚠️ 认出是工作区缺口但认不出缺哪个工具（不猜）—— 原文：${String(stdout).slice(-160)}`)
    }

    return { reconcile: rec.kind, why: rec.why, next, level: attr.level, signature: attr.hit, evidence }
  } catch (e) {
    log(`  ⚠️ ${t.id} 对账跑不起来（不影响收活）：${String(e?.message ?? e).slice(0, 120)}`)
    return null
  }
}

/**
 * 四步链（施工文档 20261024 §5.3）—— AC 红了之后**真的去修**，而不是只报告。
 *
 *   ① coder 自己修 1 次（续**自己的**会话）
 *   ② 还红 → 急救 1 次（换模型；新会话）
 *   ③ 急救失败 → 再修 1 次（续**急救自己的**会话 —— 谁做的返给谁）
 *   ④ 还红 → 裁判审（第三方判：卡写错了 / 验收太严 / 活真没干成）
 *
 * 三条硬规矩（§5.3）：
 *   1. 续会话返回给做它的人；③ 只续急救的会话（原 coder 的上下文已过时）
 *   2. 每次返工都要带**新东西**（本轮 AC 的失败点 + 上一轮 diff），否则就是原地重播
 *   3. 终点是裁判审，不是人
 *
 * 预算：每卡每轮最多 1 次急救（`§5.3` A 方案）；返工状态落 `_crew\返工\<卡>.json`（跨轮次也记得住）。
 */

/** 三段式返工提示（§5.3「每次返工给什么提示词」）—— 模板写死，别让模型自由发挥。 */
function reworkHint ({ acCmd, failTail, diffText, who }) {
  const whoLine = who === 'rescue'
    ? '上一轮是**急救**改的（不是你）。它的改动在下面；这次只补它没覆盖的部分，**别把它推翻重来**。'
    : '下面是你自己上一轮改的东西。'
  return [
    '## ⛔ 上一轮没过验收（这是返工，不是新任务）',
    `你上一轮改完之后，验收命令 \`${acCmd ?? '(未知)'}\` **红了**。原话（末尾几行）：`,
    '```',
    String(failTail ?? '').slice(-1200) || '(没有输出)',
    '```',
    whoLine,
    diffText ? `上一轮改了这些文件：\n${diffText}` : '',
    '',
    '## 这次只做三件事',
    '1. **只改**让上面那条断言变红的那个地方；不许顺手重构、不许加功能；',
    '2. **⛔ 不许动验收脚本**（改了验收不算过，会被标"验收被动过"并必审）；',
    `3. 改完**自己跑一遍** \`${acCmd ?? '卡里那条自测'}\`，把命令和退出码登记成一行：`,
    '   `ran: {"cmd":"<命令原文>","exit":<退出码>,"cwd":"<项目根>"}`',
    '',
    '如果这条红根本不是代码问题（缺工具/缺 key/环境不通），**别改代码**——直接在报告里写"环境类：缺 XXX"并停手。'
  ].filter(Boolean).join('\n')
}

function reworkStatePath (id) {
  return join(PROJECT, '_crew', '返工', `${String(id).replace(/[\\/:*?"<>|]/g, '_')}.json`)
}

function readReworkState (id) {
  try { return JSON.parse(readFileSync(reworkStatePath(id), 'utf8').replace(/^\uFEFF/, '')) } catch { return { count: 0 } }
}

function writeReworkState (id, st) {
  try {
    const p = reworkStatePath(id)
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(st, null, 2), 'utf8')
  } catch (e) { log(`  ⚠️ 返工状态写不进去（不影响流程）：${String(e?.message ?? e).slice(0, 100)}`) }
}

/** 跑一次 AC，返回 {ok, cmd, exit, tail}。 */
function acOnce (t) {
  const r = verifyAcceptance(t)
  const check = (r?.checks ?? [])[0] ?? {}
  const tail = (r?.checks ?? []).map((c) => c.tail ?? '').join('\n')
  return { ok: r?.ok === true, cmd: check.cmd ?? null, exit: r?.exitCode ?? (r?.ok ? 0 : 1), tail, raw: r }
}

/**
 * 四步链主函数。**返回最终判决与 AC 结果**，由调用方决定状态。
 * @returns {Promise<{v:object, acResult:any, did:string[]}>}
 */
async function runReworkChain ({ t, v, call, taskDir, acResult, diag }) {
  const did = []
  const kind = diag?.reconcile ?? 'unknown'
  const isRepairable = kind === 'real-fail' || kind === 'derelict'
  const st = readReworkState(t.id)

  // 不是"真没做对" ⇒ 不返工，直接裁判审（§5.3：conflict/misreport 不许自己洗）
  if (!isRepairable) {
    log(`  🧑‍⚖️ ${t.id} 对账=${kind} ⇒ **不返工**，直接裁判审`)
    return { v, acResult, did }
  }
  if ((st.count ?? 0) >= 2) {
    log(`  ⏹ ${t.id} 返工预算已用完（已 ${st.count} 轮）⇒ 不再自派，交裁判审`)
    return { v, acResult, did }
  }

  const MAX = 2
  let lastSession = call?.sessionId ?? null
  let lastAcTail = ''
  let lastSelf = 'coder'
  let cur = { v, call, ac: acResult }

  // ① 自己修 → ② 急救 → ③ 续急救再修
  for (let round = 1; round <= MAX; round++) {
    const attempt = round === 1 ? 'rework' : 'rework2'
    const hint = reworkHint({
      acCmd: diag?.evidence?.ac?.cmd, failTail: diag?.evidence?.ac?.stdoutTail,
      diffText: null, who: lastSelf
    })
    log(`  🔧 ${t.id} 第 ${round} 轮返工（续 ${lastSelf} 的会话 ${String(lastSession ?? '').slice(0, 12)}…）`)
    let c
    try {
      const tt = lastSelf === 'rescue' ? { ...t, role: 'rescue' } : t
      c = await callCrew(tt, taskDir, { attempt, retryHint: hint, resumeSessionId: lastSession })
    } catch (e) {
      log(`  ⚠️ 返工调用失败：${String(e?.message ?? e).slice(0, 120)}`)
      break
    }
    did.push(attempt)
    REWORKS.push({ task: t.id, noDelta: false, at: new Date().toISOString() })
    st.count = (st.count ?? 0) + 1
    st.lastAt = new Date().toISOString()
    writeReworkState(t.id, st)
    if (EXECUTE) recordCrew(tt, c)

    const nv = judge(c)
    const ac = acOnce(t)
    lastAcTail = ac.tail
    cur = { v: nv, call: c, ac: ac.raw }
    if (ac.ok) {
      log(`  ✅ ${t.id} 返工后 AC 绿 → 进待审（**重点审**：这是修回来的）`)
      return { v: nv, acResult: ac.raw, did }
    }
    log(`  ↻ ${t.id} 返工后仍红（${String(ac.tail.split('\n').pop() ?? '').slice(0, 80)}）`)
    lastSession = c?.sessionId ?? lastSession
    lastSelf = 'coder'

    // ② 第 1 轮返工失败 ⇒ 拉急救（每卡只给 1 次）
    if (round === 1 && !st.rescueUsed) {
      st.rescueUsed = true; writeReworkState(t.id, st)
      log(`  🚑 ${t.id} 自己修不动 → 急救 1 次`)
      let rc
      try {
        rc = await callCrew({ ...t, role: 'rescue' }, taskDir, {
          attempt: 'rescue', retryHint: `上一个 ${t.role} 反复改这个任务仍未过验收。你是急救：直接在主树定位并修好，别重复它踩过的路。`
        })
      } catch (e) { log(`  ⚠️ 急救调用失败：${String(e?.message ?? e).slice(0, 120)}`); break }
      did.push('rescue')
      if (EXECUTE) recordCrew({ ...t, role: 'rescue' }, rc)
      const rv = judge(rc)
      const rac = acOnce(t)
      cur = { v: rv, call: rc, ac: rac.raw }
      if (rac.ok) { log(`  ✅ ${t.id} 急救后 AC 绿 → 进待审（**重点审**）`); return { v: rv, acResult: rac.raw, did } }
      log(`  ↻ ${t.id} 急救后仍红`)
      lastSession = rc?.sessionId ?? lastSession
      lastSelf = 'rescue'
    }
  }

  // 4 judge (S5.3): third party decides which layer is wrong - does NOT fix code
  try {
    const acTail = String(lastAcTail || diag?.evidence?.ac?.stdoutTail || '').slice(-1000)
    const hint = [
      '## 你是裁判审（不是修理工，禁止改代码）',
      '这张卡经过多轮返工仍然是红的。只回答一个问题：问题出在哪一层。',
      '可执行验收命令：' + String(diag?.evidence?.ac?.cmd ?? '(未知)'),
      '验收输出末尾：',
      '---',
      acTail || '(没有输出)',
      '---',
      '返工链已经跑过：' + did.join(' -> '),
      '',
      '只输出一行，三选一，不要解释：',
      'CARD-WRONG      卡与验收互相矛盾，或卡本身写错了',
      'AC-TOO-STRICT   活够用了，是验收写得太严',
      'WORK-NOT-DONE   卡没问题，活确实没干成'
    ].join('\n')
    const jc = await callCrew({ ...t, role: 'reviewer' }, taskDir, { attempt: 'judge', retryHint: hint })
    did.push('judge')
    if (EXECUTE) recordCrew({ ...t, role: 'reviewer' }, jc)
    let jtext = ''
    try { jtext = readFileSync(jc.outJson, 'utf8') } catch {}
    const jm = /(CARD-WRONG|AC-TOO-STRICT|WORK-NOT-DONE)/i.exec(jtext)
    const map = { 'CARD-WRONG': 'card-wrong', 'AC-TOO-STRICT': 'ac-too-strict', 'WORK-NOT-DONE': 'work-not-done' }
    const jverdict = jm ? map[jm[1].toUpperCase()] : 'work-not-done'
    const jp = join(PROJECT, '_crew', '裁决', t.id + '.json')
    mkdirSync(dirname(jp), { recursive: true })
    writeFileSync(jp, JSON.stringify({ card: t.id, verdict: jverdict, why: jm ? 'judge returned' : 'judge gave no verdict', evidence: { ac: diag?.evidence?.ac ?? null, did }, at: new Date().toISOString() }, null, 2), 'utf8')
    log('  JUDGE ' + t.id + ' -> ' + jverdict + ' (_crew/裁决/' + t.id + '.json)')
  } catch (e) {
    log('  WARN judge failed: ' + String(e?.message ?? e).slice(0, 120))
  }

  return { v: cur.v, acResult: cur.ac, did }
}

function runAcceptanceGate (t, v) {
  if (!EXECUTE || !ACABLE.includes(v.verdict)) return { v, acResult: null }
  const acResult = verifyAcceptance(t)
  if (acResult.crashed) {
    log(`  ⛔ ${t.id} AC 机判**跑不起来** → fail-closed（不许静默放行）：${acResult.reason}`)
    addHalt({ id: t.id, kind: '环境类（AC 机判崩溃）', why: acResult.reason, source: 'AC 机判（终审）', role: t.role,
      hint: '先手动跑 `台账.mjs ac --project <项目> --id <ID>` 看哪一步坏；修好前这条任务不放行' })
    return { v: { verdict: 'ac-red', retry: false, ctx: v.ctx ?? null, denials: v.denials ?? 0,
      action: `AC 机判跑不起来（fail-closed）：${acResult.reason}` }, acResult }
  }
  if (acResult.machineVerified === false) {
    log(`  ⚠️ ${t.id} AC **未机器验证**：${acResult.reason ?? '这条任务没有可执行 AC（只有中文验收标准）'}`)
    return { v, acResult }
  }
  if (acResult.machineVerified === false) {
    // ★ 2026-10-21（通用化②）：原来这里是"诚实标注后放行"——诚实没错，但**等于没验**。
    //   实测事故：chaojimaliao 的 T1-03 验收红了仍被收下（因为先没写成可执行 AC），靠人眼才发现。
    //   现在由项目声明闸门：requireAC=true ⇒ 没 AC 不许进 done；默认仍放行（老项目零影响）。
    if (REQUIRE_AC) {
      log(`  ⛔ ${t.id} 没有可执行验收 → 项目要求 requireAC ⇒ **不许进 done**`)
      addHalt({ id: t.id, kind: '代码类（缺可执行验收）', role: t.role, source: 'AC 机判（终审）',
        why: '这张卡没有可执行 AC —— 机器无法验证交付物（只有中文验收标准）',
        hint: '把验收写成 `` `命令` → 期望 `` 或裸命令（如 `python tests\\x.py`）；确要放行就在项目根 gate.json 里去掉 requireAC' })
      return { v: { verdict: 'ac-missing', retry: false, ctx: v.ctx ?? null, denials: v.denials ?? 0,
        action: '任务卡没有可执行验收 → **不许进 done**（项目要求 requireAC）' }, acResult }
    }
    log(`  ⚠️ ${t.id} 没有可执行验收 → **未机器验证**（放行；收据标 machineVerified:false）`)
    return { v, acResult }
  }
  if (acResult.ok === false) {
    const first = (acResult.failures ?? [])[0] ?? '（没给原因）'
    const cls = classifyFailure([first, ...(acResult.checks ?? []).map(c => c.tail ?? '')].join('\n'))
    if (cls.env) {
      // 用户拍板第 1 条：环境类**不算过**、但**不派审核员去修**（它修不了，纯烧 token）→ 记进"待你处理"，别的任务照跑
      log(`  🔴 ${t.id} AC 红了，但判定是**环境类**（不是代码错）→ 不派修复，记进待你处理清单`)
      addHalt({ id: t.id, kind: '环境类', why: cls.why, detail: first.slice(0, 240), source: 'AC 机判（终审）', role: t.role })
      const cred = credentialLike([first, ...(acResult.checks ?? []).map(c => c.tail ?? '')].join('\n'))
      const verdict = cred ? 'ac-env-credential' : 'ac-env-workspace'
      return { v: { verdict, retry: false, ctx: v.ctx ?? null, denials: v.denials ?? 0,
        action: cred
          ? `AC 红了但**缺凭据**（${cls.why}）→ 不算过、**只有你能补**；其它任务照常继续`
          : `AC 红了但**工作区缺东西**（${cls.why}）→ 不算过、**派 ENV 卡去装**（不是等你）` }, acResult }
    }
    if (cls.unknown) {
      // ★ 八·S2：两表都没认出来 —— **不当代码错、也不派修**，原样交人（等见着新特征再回补两表）
      log(`  🔴 ${t.id} AC 红了，但**没认出是哪类**（环境/代码特征都没命中）→ 先不派修复，记进待你处理清单`)
      addHalt({ id: t.id, kind: '未知类（机器没认出）', why: cls.why, detail: first.slice(0, 240), source: 'AC 机判（终审）', role: t.role,
        hint: '机器两表都没认出：先人工看这条红是真环境故障还是漏网的代码错；若是环境类（磁盘满/证书/代理…）把特征补进 编排.mjs 的 ENV_PATTERNS' })
      return { v: { verdict: 'ac-unknown', retry: false, ctx: v.ctx ?? null, denials: v.denials ?? 0,
        action: `AC 红了但**没认出是哪类**（既不像环境类、也不像代码错）→ **先不派修复**、留给你看证据；其它任务照常继续` }, acResult }
    }
    log(`  ⛔ ${t.id} AC 机判**红灯**（代码类）→ 不进 review：${first}`)
    return { v: { verdict: 'ac-red', retry: false, ctx: v.ctx ?? null, denials: v.denials ?? 0,
      action: `AC 机判红灯（\`${(acResult.checks ?? [])[0]?.cmd ?? '?'}\`）→ **不许进 done**；原话：${first}` }, acResult }
  }
  log(`  ✅ ${t.id} AC 机判通过（${(acResult.checks ?? []).length} 条命令）`)
  return { v, acResult }
}

// ---------------------------------------------------------------- 记账

/**
 * ★ 2026-10-23（施工文档 D14）：**上下文占用 = 纯 prompt ÷ 模型窗口**。
 * 分子 = 未缓存 input ＋ 缓存读 ＋ 缓存写（**不含输出**；与 DSH 的 `pressureTokens` 同一定义）；
 * 分母 = `_crew\模型能力.json` 的 `contextWindow`（拿不到就 null，**不编数**）。
 * ⚠️ 不用 `totalTokens`：那个含输出，跨载体不可比（输出占比各不同），也和 DSH 面板对不上。
 */
function d14Of (call, model) {
  const u = call?.usageRaw
  if (!u || typeof u !== 'object') return null
  const num = (v) => (typeof v === 'number' && Number.isFinite(v)) ? v : (v === null || v === undefined || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null))
  const input = num(u.input ?? u.input_tokens ?? u.prompt_tokens ?? u.inputTokens ?? u.promptTokens)
  if (input === null) return null
  const cr = num(u.cacheRead ?? u.cache_read_input_tokens) ?? 0
  const cw = num(u.cacheWrite ?? u.cache_creation_input_tokens) ?? 0
  const promptTokens = input + cr + cw
  let ctxWindow = null
  try { ctxWindow = capacityOf(model)?.contextWindow ?? null } catch { ctxWindow = null }
  const { ctxPct } = contextPct(promptTokens, ctxWindow)
  return { promptTokens, ctxWindow, ctxPct, basis: 'prompt+cache/registry' }
}

function recordCrew (t, call, opts = {}) {  // ⚠️ 模型名与档位**从 agents.json 读**，不再在代码里硬编码。
  //    原来这里是 `/^reviewer/.test(role) ? 'Qwen3.8-Max' : ...` —— 那是"同一份事实散在多处"，
  //    换了模型这行不会变 → **账本记的模型名是假的**，实验无法归因（跟"规则漂移"同一个病）。
  // ★ 2026-10-16（任务分级）：**必须带上级号再解析** —— 否则账本记的是 `prefer` 的模型，
  //   而这一跑实际用的是"该级模型"（实测差别：prefer=flash，L2 级=pro）⇒ 账目归因失真。
  const r = resolveRole(t.role || 'coder-a', AGENTS_CFG, t.level ? { level: t.level } : {})
  // ★ 2026-10-23（D3）：降档重发那一次，账本要记**实际用的档位**，否则归因又失真（同 b219 级号那条教训）。
  const effortUsed = opts.effort && opts.effort !== r.effort ? opts.effort : r.effort
  const args = [LEDGER, 'add', '--role', t.role || 'coder-a', '--task', t.id,
    '--model', r.model ?? '(未指定)', '--effort', effortUsed ?? '(未指定)']
  if (t.level) args.push('--level', String(t.level))          // ★ 账本记级号（看板/实验要按级归因）
  // 顺带记 agent 名，便于以后换 agent 后按 agent 归因
  if (r.agentName) args.push('--note', `编排 ${stamp} · agent=${r.agentName}${opts.effort && opts.effort !== r.effort ? ` · 撞顶降档 ${r.effort}→${opts.effort}` : ''}${call.thinkingOverflow ? ' · thinkingOverflow' : ''}`)
  // ★ 2026-10-23（施工文档 D14）：**上下文占用 = 纯 prompt ÷ 模型窗口**（与 DSH 面板同款口径）。
  //   分子 = 未缓存 input + 缓存读 + 缓存写（**不含输出**）；分母 = `_crew\模型能力.json` 的 contextWindow。
  //   拿不到窗口就写 null —— **不编数**（§8 / D14「不做原样估」）。
  const d14 = d14Of(call, r.model)
  if (d14) {
    if (d14.promptTokens !== null) args.push('--prompt-tokens', String(d14.promptTokens))
    if (d14.ctxWindow !== null) args.push('--ctx-window', String(d14.ctxWindow))
    if (d14.ctxPct !== null) args.push('--ctx-pct', String(d14.ctxPct))
    if (d14.basis) args.push('--ctx-basis', d14.basis)
  }
  if (call.thinkingOverflow) args.push('--thinking-overflow', 'true')
  if (call.outJson && existsSync(call.outJson)) args.push('--envelope', call.outJson)
  // ★ 2026-10-07 修（**时长一直没记下来的根因**）：原来这行在最下面的 `else` 分支里 ——
  //   也就是"**只有没有信封（崩了/被杀）那一次**"才把编排自己量到的 `tookMs` 传下去；
  //   而正常成功那次只传 `--envelope`，时长指望信封里的 `durationMs`，可**信封里根本没有这个字段**
  //   （实测：`T35.out.json` 292 行 JSONL 里没有任何 `dur*`/`took*`/`*ms` 键）。
  //   ⇒ 结果 `_crew\ledger.json` 65 条调用 `durationMs` **全是 null**，"哪次该跑多久"这个数**从来没被记下来**。
  //   ⇒ 现在**两种分支都传**；`工量账本.mjs` 的取值顺序是 `--duration-ms` > 信封，所以它是权威值。
  //   （这也是 进度.md 里"超时点/时长未统计"的直接原因。）
  if (!(call.outJson && existsSync(call.outJson))) args.push('--ok', String(call.ok === true))
  if (call.tookMs) args.push('--duration-ms', String(call.tookMs))
  spawnSync(NODE, args, { encoding: 'utf8', stdio: 'inherit' })
}

// ---------------------------------------------------------------- ★ D6 同轮内自动重派

/**
 * 施工文档 D23（**取代** 20261022 D6 的那套写法）：把判决对应的**建议动作**送到大脑眼前。
 *
 * 为什么推翻上一版的"硬上限"：
 *   ① 上一版写 `回大脑.json` —— 实测**没有任何东西读它**（大脑读的是 `verdict.json` 和 stdout）；
 *   ② 上一版的重派上限靠 `--replay-of` 参数 —— 它是**可选**的，不带就绕过 ⇒ 是"假上限"。
 * 现在只做两件事（都是大脑**必然会看到**的）：
 *   ① 收据里每条带 `nextAction` / `suggest`（机器可读）；
 *   ② 汇总区打一行 `❗ 需你处置：T1 改卡重派（…）`。
 * 不做"同轮次数"计数：机器数不清"什么算一轮"，而且编排已经替它试过"重试 1 次 + 急救 1 次"。
 */
const ACTION_ZH = { retry: '重试', rescue: '急救', resume: '续跑', 'edit-card': '改卡重派', 'wait-user': '等你处置', none: '不用管' }

function adviseFor (t, v) {
  const nextAction = nextOf(v?.verdict)
  const suggest = suggestOf(v?.verdict)
  if (nextAction && nextAction !== 'none' && nextAction !== 'wait-user') {
    log(`  ❗ 需你处置：${t.id} 判 ${v.verdict} → ${ACTION_ZH[nextAction] ?? nextAction}${suggest ? '（' + suggest + '）' : ''}`)
  }
  return { nextAction, suggest }
}

function setStatus (id, status) {  const r = spawnSync(NODE, [join(HERE, '台账.mjs'), 'set', '--project', PROJECT, '--id', id, '--status', status], { encoding: 'utf8' })
  if (r.status !== 0) log(`  ⚠️ 改状态失败 ${id}→${status}：${(r.stderr || '').trim().slice(0, 200)}`)
  else log(`  ${id} → ${status}`)
}

// ---------------------------------------------------------------- 单实例锁
//
// 只有真跑（--execute）才抢锁：演练是只读的，不该互相挡。
// 锁是**和"换新会话"共用**的 —— 那两个脚本都会建会话/改状态/记账，同时跑会状态错乱且难查。
let LOCK = null
// ★ 2026-10-23（施工文档 D23）：`--replay-of` **已废弃** —— 它是可选参数，不带就绕过，从来不是"硬上限"。
//   现在明着拒（不静默接受），并告诉他正确做法：改卡后直接 `--only-task` 重派。
if (has('replay-of')) {
  console.error('[编排] ⛔ `--replay-of` 已废弃（D23）：它当年只是"可选计数"，不带就绕过了。')
  console.error('        正确做法：改完卡直接 `--execute --only-task <卡号>` 重派；编排已在收据里给 nextAction。')
  process.exit(2)
}
if (EXECUTE) {
  LOCK = acquireLock(LOCK_FILE, `编排.mjs --project ${PROJECT}${WAVE ? ` --wave ${WAVE}` : ''}`)
  if (!LOCK.ok) {
    console.error(`[编排] ⛔ 拒绝开跑：${LOCK.reason}`)
    console.error('   → 等它跑完，或确认那是残留死锁再删：' + LOCK_FILE)
    const h = readLock(LOCK_FILE)
    if (h) console.error('   占锁者：' + JSON.stringify(h))
    process.exit(4)
  }
  log(`已占单实例锁（pid ${process.pid}）`)
  // ★ 2026-10-07：开跑前清掉**上一轮被强杀时遗留**的"正在跑"登记 —— 不清的话看板会一直亮着
  //   某个早就不在的角色（它只认 pid 存活，遗留记录的 pid 早就没了，其实也会被判"没在跑"；
  //   这里清一遍是为了**不留垃圾**，且此刻已持有单实例锁，动它是安全的）。
  clearStaleRunning()
}

// ---------------------------------------------------------------- 主流程

log(`项目：${PROJECT}`)
log(`模式：${EXECUTE ? '**真跑（花额度）**' : '演练（不调班组）'}　每批上限 ${MAX}　**并行上限 ${PAR}**（**同一载体不并行**；文件白名单重叠也自动降级串行）　超时 ${TIMEOUT_MIN} 分钟`)
// ★ 2026-10-24（§11.2 B）：参数来源说清楚 —— 不然"采纳了到底生效没有"永远只能靠猜。
log(`参数来源：超时 ${TIMEOUT_MIN} 分 ← ${TMO_T.src}　并行 ${PAR} ← ${PAR_T.src}　（优先级：命令行 > _crew\\调参\\当前.json > 代码默认）`)
if (WAVE) log(`只跑波次：${WAVE}`)
log(`运行目录：${RUNDIR}`)

const taskDir = join(RUNDIR, 'tasks')
mkdirSync(taskDir, { recursive: true })

const gate = accountGate()
// 三态打印：✅ 明确可用 / ⏭️ 登录态未知（放行但警告）/ ❌ 明确不可用（停手）
log(`账号闸门：${gate.ok ? '✅ 通过' : (gate.unknown ? '⏭️ **登录态未知**（放行，但别把它当"验过"）' : '❌ 未通过 —— ' + (gate.detail?.reasons?.join('；') ?? '未知'))}`)
if (gate.keyCheck?.summary) log(`　 钥匙：${gate.keyCheck.summary}`)
if (!gate.ok && !gate.unknown) {
  log('**整轮停手**（§5.4 账号类故障：三角色同账号，换人没用）')
  writeFileSync(join(RUNDIR, 'verdict.json'), JSON.stringify({ stamp, stopped: 'account', detail: gate.detail }, null, 2), 'utf8')
  process.exit(2)
}
if (gate.unknown) {
  log('　 → 说明：只有 Qoder 有统一的登录态接口，其余载体查不了登录 —— **这是"不知道"，不是"通过"**；')
  log('　　  真要确认可用性：跑 `额度检测.mjs`（会真打各家的 /models）。')
}

const queueAll = readyTasks()

// —— 准入四道门：把不满足 SOP 前置条件的任务**挡在派活之前** ——
const allowed = []
const blocked = []
for (const t of queueAll) {
  const g = admissionGates(t)
  if (g.problems.length === 0) {
    allowed.push({ ...t, track: g.track })
    for (const w of g.warnings) log(`  ⚠️ ${t.id} ${w}`)
  } else {
    blocked.push({ id: t.id, role: t.role, problems: g.problems })
  }
}
if (blocked.length) {
  log('—— 准入未通过（不派活）——')
  for (const b of blocked) { log(`  ⛔ ${b.id}（${b.role}）`); for (const pr of b.problems) log(`       ${pr}`) }
  if (FORCE) {
    log('  ⚠️⚠️ --force：**强行放行**上面这些任务（我明确知道在绕过 SOP 的哪道门）')
    for (const b of blocked) allowed.push({ ...queueAll.find(t => t.id === b.id), track: null })
  } else {
    log('  → 补齐上面的东西再跑；确实要绕过就加 --force（会打警告并留痕）')
  }
}
// ★ 2026-10-05：`--only-task <ID>` —— 只跑这一条（演练 / 验审核员 / 单个返工）。
//   注意它**不过滤准入**（门照走：不满足 SOP 前置照样拦），只是把队列缩成一条。
// ★ 2026-10-05：**复审模式** —— 传入的是一条已经进 review 的任务时，**只跑审核链**：
//   不重新派 coder（那会白烧一份额度重跑一遍同样的活），直接 门禁 + 审核员。
// ★ 2026-10-06 修（我自己用错一次，实测当场浪费了一份 coder 额度）：
//   `--review-only` 原来只跳过**审校段那半**（`fresh` 判定），**没有跳过任务队列** ——
//   于是我发 `--review-only` 想"只审不干活"时，它照样把待办任务派出去跑了。
//   正确语义：**`--review-only` = 本次不派任何活**（队列清空），只跑门禁 + 拉审核员。
//   要"派活 + 审"就用不加它的普通调用；要"只跑某一条"用 `--only-task <ID>`。
let reviewOnly = REVIEW_ONLY
let queue = allowed
if (REVIEW_ONLY && ONLY_TASK) log(`  ℹ️ 同时给了 --review-only 与 --only-task：以 --only-task 为准（那条会自己决定走不走复审）`)
if (REVIEW_ONLY && !ONLY_TASK) {
  queue = []
  log('★ --review-only：本次**不派任何活**（队列已清空），只跑门禁 + 拉审核员')
}
if (ONLY_TASK) {
  // ① 首选"现在能开工"的那条（pending/ready 且依赖已 done）；
  // ② 其次允许"**已经进 review 的任务**"（返工 / 复审 / 演练都用它）——
  //    注意 `台账 ready` 只给"能开工"的，**看不到 review 状态**，所以这里要直接读状态表。
  //    ⚠️ 踩过：第一版用 `台账 list` 的行正则抠状态，列宽一变就抠不到 → 静默判"不在可处理范围"。
  //    改用与审校同一套 `statusRows()`（它就在上面，解析口径只有一处）。
  let one = allowed.find(t => t.id === ONLY_TASK)
  let st = one ? (one.status ?? 'ready') : null
  if (!one) {
    const rows = statusRows()
    const ids = rows.rows ?? []
    const hit = ids.find(r => r.id === ONLY_TASK)
    if (!hit) {
      log(`⛔ --only-task ${ONLY_TASK}：台账里没有这个 ID（或用它读状态失败：${rows.error ?? '—'}）`)
      process.exit(3)
    }
    if (hit.status !== 'review') {
      log(`⛔ --only-task ${ONLY_TASK}：状态是 ${hit.status} —— 只接受"能开工（pending/ready）"或"已进 review"的任务`)
      process.exit(3)
    }
    st = hit.status
    reviewOnly = true          // ★ 已进 review → 只跑审核链，不再派 coder
    one = { id: hit.id, role: hit.role ?? 'reviewer', wave: hit.wave ?? null, goal: hit.goal ?? '（复审）',
      deliverables: [], accept: [], files: [], depends: [], track: null, status: hit.status }
    log(`  ℹ️ ${ONLY_TASK} 在 review 状态 → 走**复审模式**（不派活，只跑门禁 + 拉审核员）`)
  }
  const gate = blocked.find(b => b.id === ONLY_TASK)
  if (gate?.problems?.length) log(`  ⚠️ ${ONLY_TASK} 没通过准入门（${gate.problems.join('；')}）—— --only-task 下仍然放行，但记进收据`)
  queue = reviewOnly ? [] : [{ ...one, track: one.track ?? null, gateProblems: gate?.problems ?? null }]
  if (!reviewOnly) log(`★ --only-task ${ONLY_TASK}：本次只处理这一条（状态 ${st}）`)
}
log(`可开工任务：${queue.length ? queue.map(t => `${t.id}(${t.role})`).join('、') : '（没有）'}`)
// ★ 2026-10-03 修：**这里原来直接 `process.exit`** —— 于是"所有任务都已进 review、队列为空"时，
//   ⑥ 审校 与收尾段（收据 / AUDIT）**整段被跳过** → **"自动拉审核员"永远触发不了**。
//   分批按 `--wave` 派活时最明显：每次 `--wave` 按设计都不触发审校（`WAVE===null` 才触发），
//   而最后那次全量跑又因为"没有可开工任务"提前退出 —— 两头都堵死，审核永远轮不到。
//   现在改成：**允许空队列继续往下走**，让审校与收尾段照常执行；退出码在收尾处统一给。
const queueEmpty = queue.length === 0

const results = []
const running = new Set()
let aborted = null

// ⚠️ 2026-10-04 更正（原来这里写的是"受控并行…用分批实现同时最多 MAX 个班组"——**那句话是错的**）：
//   **分批 ≠ 同时**。下面批内仍是 `for` 逐个 `callCrew`，而 `callCrew` 用 `spawnSync` **阻塞**，
//   所以**同一批里的任务是一个跑完再跑下一个**，墙钟时间与串行相同。
//   ⇒ 现在的准确说法：**"分批派活"（每批上限 MAX，默认 5）**，它只决定日志分组与一次塞几个，
//     **不是并发数**。要真并行需要改成 async spawn + Promise.all，且必须先解决
//     `分工表.md` §4 的共享文件"波内串行提交（a 先 b 后）"约束 —— 别只把 spawnSync 换掉就上（见 进度.md §11）。
// ★ 2026-10-05：**真并发分组** —— 把分工表 §4 的"波内串行提交"变成代码保证。
//   规则：**文件白名单互不重叠**的任务才允许同组并行；有交集（或没写文件清单）→ 自动串行。
//   这样"共享文件（app.ts 挂载行 / migrations/）a 先 b 后"不靠人记 —— 白名单一撞就降级。
const pathsOf = (t) => (Array.isArray(t.files) && t.files.length ? t.files : (t.deliverables ?? []))
  .filter(x => typeof x === 'string' && /[\\/]|\.[a-zA-Z0-9]{1,6}$/.test(x))
  .map(x => String(x).replace(/\\/g, '/').toLowerCase().replace(/\/+$/, ''))
const overlaps = (a, b) => {
  if (!a.length || !b.length) return true                 // 没写清单 → 保守当冲突（宁可串行）
  return a.some(x => b.some(y => x === y || x.startsWith(y + '/') || y.startsWith(x + '/')))
}
/** 这个任务跑在哪个**载体**上（`coder-a` → `pi`）。读 `_crew\agents.json`，不写死名单。 */
const carrierOf = (t) => {
  try { return String(resolveRole(t.role, AGENTS_CFG)?.agentName ?? t.role) } catch { return String(t.role) }
}
/** 班组里**所有 coder 角色**用到的载体（去重）—— 用来判"这一批有没有人在白等"。 */
const coderCarriers = () => {
  try {
    const roles = Object.keys(AGENTS_CFG?.roles ?? {}).filter(r => /^coder/i.test(r))
    return [...new Set(roles.map(r => carrierOf({ role: r })))]
  } catch { return [] }
}
/**
 * ★ b211（2026-10-20 用户拍板）· **点名**（只报、不改队列）：
 *   用户原话："大脑侧尽可能的均等拆卡（两个载体两个 coder 就是为了加速）；编排这里需要当成点名。"
 *   ① 每批一行 `[点名]`：每个 coder 载体**各几张卡**、谁空着；
 *   ② 偏斜时列出**可挪的卡号**（同批里没人依赖它的那些）——只列，不挪；
 *   ③ 只提醒、**绝不改 `TASKS.md` 的角色**：模块归属/载体能力只有大脑知道，机器改卡会破"一个模块一家"。
 *   判据就一条（不发明新数）：某载体这一批 ≥2 张，且另一个 coder 载体这一批 **0 张**。
 */
/* ★ b211：显示名**从 `_crew\carriers.json` 的 `displayName` 读**（⑧ 条：全仓不许有"一行里 ≥2 个载体名"的名单）。
   读不到就原样打载体键，**不写死任何名字**。 */
const CARRIERS_DECL = (() => { try { return JSON.parse(readFileSync(join(HERE, '..', '_crew', 'carriers.json'), 'utf8')).carriers ?? {} } catch { return {} } })()
const CARRIER_ZH = (c) => String(CARRIERS_DECL?.[c]?.displayName ?? c)
function rollCallOf (batch) {
  const per = new Map()                                  // carrier → [task,...]
  for (const t of batch) {
    const c = carrierOf(t)
    if (!per.has(c)) per.set(c, [])
    per.get(c).push(t)
  }
  const idle = coderCarriers().filter(c => !per.has(c))
  const heavy = [...per.entries()].filter(([, arr]) => arr.length >= 2)
  // 可挪的卡：同批里**没有任何别的任务依赖它**（depends 里没出现它的 id）
  const depended = new Set()
  for (const t of batch) for (const d of (t.depends ?? [])) depended.add(String(d))
  const candidates = heavy.flatMap(([, arr]) => arr.filter(t => !depended.has(String(t.id))).map(t => String(t.id)))
  return { per, idle, heavy, candidates }
}
function logRollCall (batch) {
  const r = rollCallOf(batch)
  const who = [...r.per.entries()].map(([c, arr]) => CARRIER_ZH(c) + ' ' + arr.length + ' 张').join(' · ')
  if (!r.heavy.length || !r.idle.length) {
    log(`[点名] ${who} ⇒ ✅ 两个载体都有活`)
    return r
  }
  log(`[点名] ${who} ⇒ ⚠️ **人为串行**：${r.idle.map(CARRIER_ZH).join('、')} 这一批空着`)
  if (r.candidates.length) {
    log(`       可挪：${r.candidates.slice(0, 4).join('、')}${r.candidates.length > 4 ? ' 等 ' + r.candidates.length + ' 张' : ''}` +
      `（挪一张给 ${CARRIER_ZH(r.idle[0])}，同波文件不重叠就能并行 —— 《班组须知-细则》§27a；**编排不改你的卡**）`)
  }
  return r
}
function parallelGroups (batch) {
  const groups = []
  for (const t of batch) {
    const mine = pathsOf(t)
    const carrier = carrierOf(t)
    let placed = false
    for (const g of groups) {
      if (g.length >= PAR) continue
      // ★ b210（2026-10-20 用户拍板）：**同一个载体不许同时跑两个**。
      //   一个载体＝一个进程/一条会话/一个 cwd ⇒ 同载体并行会抢会话、抢额度。
      //   实测证据：2026-10-19 通宵跑的 W4「T10、T11 都是 coder-a」被判"同组真并行"，
      //   两个 Pi 进程在同一个 cwd 里同时干活（当时侥幸没出事）。
      //   **允许的是不同载体并行**（coder-a 的 Pi 与 coder-b 的 OpenCode）—— 那本来就是设计。
      if (g.some(m => carrierOf(m) === carrier)) continue
      if (g.every(m => !overlaps(mine, pathsOf(m)))) { g.push(t); placed = true; break }
    }
    if (!placed) groups.push([t])
  }
  return groups
}

/** 一个任务的**首轮尝试**：只跑载体，**不写任何共享状态**（不改 TASKS.md、不记账）→ 可安全并发。 */
async function attemptFirst (t) {
  log(`▶ ${t.id}（${t.role}）${t.goal}`)
  return { t, call: await callCrew(t, taskDir, { skipBefore: true, deferAfter: true }) }
}

/* ★ b211 点名累计器：跨批次记住"谁空过、有哪些卡可挪、跑了几组并行"（只报，不改队列） */
const rollAcc = { wavesTotal: 0, wavesParallel: 0, idleSeen: new Set(), candidates: new Set() }

for (let i = 0; i < queue.length; i += MAX) {
  const batch = queue.slice(i, i + MAX)
  const groups = parallelGroups(batch)
  const plan = groups.map(g => `[${g.map(t => t.id).join('、')}]`).join(groups.length > 1 ? ' ‖ ' : ' → ')
  log(`—— 批次 ${Math.floor(i / MAX) + 1}：${batch.map(t => t.id).join('、')}　并行上限 ${PAR}　计划：${plan}${groups.some(g => g.length > 1) ? '（同组**真并行**）' : ''} ——`)
  rollAcc.wavesTotal += groups.length
  rollAcc.wavesParallel += groups.filter(g => g.length > 1).length
  const rc = logRollCall(batch)
  for (const c of rc.idle) rollAcc.idleSeen.add(c)
  for (const id of rc.candidates) rollAcc.candidates.add(id)

  for (const g of groups) {
    if (aborted) break
    // ① 串行：改状态（**台账写入不能并发**，否则丢更新）+ 整组**统一先拍 before**
    //    （否则并发组里后启动那位会把先启动的产物算进自己的 before → 误报"越界"）
    for (const t of g) {
      if (EXECUTE) setStatus(t.id, 'doing')
      fingerprintSnap(t.id, 'before')
    }
    // ② 并行：只跑载体
    const pairs = g.length > 1 ? await Promise.all(g.map(t => attemptFirst(t))) : [await attemptFirst(g[0])]
    // ③ 串行收尾：留痕归属 → 判定 → 记账 → 重试/急救 → 状态
    for (const { t, call: c0 } of pairs) {
      if (aborted) break
      // ★ b211：**同批别人的产出不算你越界** —— 并发组的 before 是整组一起拍的，跑完两边都多了文件；
      //   若不剔除，S1 会把 coder-b 建的 b.txt 记成"真越界"（实测：冒烟跑里两边各有 1 处假越界）。
      const sib = g.filter(m => String(m.id) !== String(t.id)).flatMap(m => pathsOf(m))
      let call = afterSnapshot(c0, t, sib, { sharedSnapshot: g.length > 1 })      // 整组跑完才拍 after；按**本任务白名单**归属 → 准确
      let v = judge(call)

      // ── ★ 2026-10-23（施工文档 D3）：**撞顶 ⇒ 降一档重发，且只降一次** ────────────────
      //   为什么不是"重试"：撞顶不是偶发失败，是**输出预算被思考吃光**（正文 0、工具 0）；
      //   原样重发只会再撞一次（一样花钱）。降一档 = 少想一点、把预算留给正文。
      //   为什么只降一次：降档会掉质量（§13 D3 明确"不做第二次降档"），仍撞顶就 blocked 报人。
      let autoRecorded = false
      if (EXECUTE && v.verdict === 'thinking-overflow') {
        const curEffort = resolveRole(t.role, AGENTS_CFG)?.effort ?? null
        const lower = lowerEffort(curEffort)
        if (EXECUTE) { recordCrew(t, call); autoRecorded = true }
        if (!lower) {
          log(`  ⛔ ${t.id} 撞顶，但档位 ${curEffort || '（未设/认不出）'} 已无处可降 ⇒ 不降档，标 blocked 报人`)
          v = { ...v, verdict: 'thinking-overflow-final', retry: false,
            action: `撞顶且**无法再降档**（当前 ${curEffort || '未设'}）⇒ 不自动重发：这张卡的输出预算不够用，请缩范围/拆卡，或把档位调低后重派。${v.action}` }
        } else {
          log(`  🔽 ${t.id} 撞顶 → **降一档重发**（${curEffort} → ${lower}，仅此一次）`)
          call = await callCrew(t, taskDir, {
            attempt: 'downgrade',
            effort: lower,
            retryHint: `上一次该任务**撞到了输出上限**（正文 0 字、工具调用 0 次，说明预算全花在思考上）。` +
              `这次已把思考档位降一档（${curEffort} → ${lower}）。请**少绕弯路、尽早动手写**：先落盘最小可用版本，再补细节；` +
              `别在开场做长篇推理。若一次写不完，分成几次工具调用落盘。`
          })
          v = judge(call)
          if (EXECUTE) recordCrew({ ...t }, call, { effort: lower })
          if (v.verdict === 'thinking-overflow') {
            v = { ...v, verdict: 'thinking-overflow-final', retry: false,
              action: `降一档（${curEffort}→${lower}）后**仍然撞顶** ⇒ 不再降档（防止把质量磨没）：这张卡的输出预算确实不够，请拆卡/缩范围。${v.action}` }
          }
        }
      }

    // ★ 2026-10-07（用户口径）：**"全因切换" + "没额度一次就换、其他先试 2 次"**。
    //   · 额度/账号类（`account` ⇒ quota）⇒ 引擎**立刻推进**（再试也没用）；
    //   · 其他原因 ⇒ 引擎先回 `soft`（同一格只给第 1 次）⇒ 这里**同一格再试一次**；
    //     第 2 次还失败 ⇒ 引擎真推进，这时才换家/换模型。
    const FAIL_OK = OK_VERDICTS.slice()   // ★ D20：从矩阵派生（同一份口径，不再各写一份）
    // ★ 2026-10-23（D3）：**撞顶不换家** —— 换一家模型还是撞顶（同款预算），只会白烧另一个网关；
    //   而且换家引擎的 `soft` 会给它一个"再试 1 次"，同档位重发必然再撞（实测：3 次调用全撞）。
    // ★ 同一处还修了一个**自相矛盾的旧行为**：`timeout` / `denied` 的 action 明写"**不自动重试**"，
    //   但旧代码照样过换家引擎 → 拿到 `soft` → 又跑一整趟（实测：一次 90 分钟收尾后又白跑 90 分钟）。
    // ★ D20：哪些判决允许换家，写成矩阵里的 `failover` 字段（正面口径），不再用一条"反着写"的正则。
    if (EXECUTE && failoverAllowed(v.verdict) && FAIL_OK.indexOf(String(v.verdict)) === -1 && !v.retry) {
      try {
        const reason = v.verdict === 'account' ? 'quota' : String(v.verdict || 'call-failed')
        const adv = failoverAdvance(t.role || 'coder-a', reason)
        if (adv.ok) {
          v = { verdict: 'quota-switched', retry: true, failover: adv,
            action: '★**切换**（' + reason + '）→ 已切到 ' + (adv.to || '（自有订阅）') + '/' + adv.toModel + '，同通道重试一次' }
          log('  🔀 ' + t.id + ' ' + reason + ' → 切换到 ' + (adv.to || '（自有订阅）') + ' / ' + adv.toModel + '，重试一次')
        } else if (adv.soft) {
          v = Object.assign({}, v, { retry: true, action: String(v.action || '') + '　·　★' + reason + ' 非额度类 ⇒ 同一格再试 1 次（共 2 次）' })
          log('  ↻ ' + t.id + ' ' + reason + '（非额度类）→ 同一格再试 1 次（不换家、不换模型）')
        } else {
          log('  ⛔ ' + t.id + ' 链条走完（' + adv.why + '）→ 整轮停手')
        }
      } catch (e) { log('  ⚠️ ' + t.id + ' 切换失败（已忽略）：' + String((e && e.message) || e)) }
    }
    // ★ 2026-10-03：**每次真调各记一次账，而且当场记**。
    //   两个坑叠在一起才需要这样写：① 延后统一记 → 重试/急救会覆盖同一份 out.json，
    //   记账读到的是最后那份信封（失败被记成成功）；② 只记最后一次 → 第一次调用被整个吞掉。
    //   当场记（读的是本次尝试自己的 `<cardId>.out.json`）+ 每次都记（失败也记，§6.4）= 一次不多一次不少。
    if (EXECUTE && !autoRecorded) recordCrew(t, call)

    // ── AC 机判（**已挪到"终审"**：重试与急救都做完之后才跑）────────────────────
    //    ★★ 2026-10-06 结构性修正（三方交叉验证共同指出）：原来 AC 就写在这个位置 ——
    //    也就是夹在"首轮判定"之后、**重试（下面 `if (EXECUTE && v.retry)`）与急救之前**。后果：
    //      · 首轮失败 → 重试成功 ⇒ 那时 `v.verdict` 还是失败态，AC **整段被跳过**，任务**没验过就进 review**；
    //      · 急救救回来的任务同理（`rescued` 本来就在 ACABLE 白名单里，却永远轮不到它跑）。
    //    现在只留变量声明在这儿（收据要用），**判定本体在 `runAcceptanceGate()`，调用点在重试/急救之后**。
    let acResult = null

    // ── ★ 2026-10-05 新增：**AC 机判**（"做完"与"验过"分开的那一刀）────────────
    //    ★★ 2026-10-06 结构性修正（三方交叉验证共同指出）：**AC 机判必须跑在"最终判定"上**。
    //    原来它夹在"首轮判定"之后、**重试（下面 :781）与急救（:796）之前** —— 后果是：
    //      · 首轮失败 → 重试成功 ⇒ 那时 `v.verdict` 还是失败态，AC **整段被跳过**，任务**没验过就进 review**；
    //      · 急救救回来的任务同理（`rescued` 明明在 ACABLE 白名单里，却永远轮不到它跑）。
    //    现在：AC 只在**最后**跑一次（调用点见下面 `AC 机判（终审）` 那段），
    //    只对"最终确实被收下"的 verdict 生效 —— 语义正确，而且不会重复跑。
    //    ⚠️ 这一行以上是**原来的位置**，注释保留是为了让后来人看懂"为什么挪走了"。

    // 偶发 → 同通道重试 1 次（§5.4）
    // ⚠️ 原来的做法是**把一模一样的指令再发一遍** —— 但偶发失败多是"上下文相关"的
    //    （限流 / 网络抖 / 那一下抽风），原样重放大概率**再失败一次**，而失败照样花额度。
    //    所以重试时**换 prompt**：把上次的失败原因摘要塞进这一次的任务说明里。
    if (EXECUTE && v.retry) {
      // ★ 2026-10-05 修：retryHint 不再逐字拼接上次失败的原始报错文本——
      //   实测（T18）：回执会大量回显该文本（引用/思考里 33 处触发词），把失败词喂回判定面引发连锁误判。
      //   改为通用表述＋"先查产物再续做"（重试方实测常发现上一轮其实已把活干完，例：T5/T18）。
      // ★ b219（施工文档 L5）：**能续就续** —— 上一趟拿到 sessionId 且该载体有续跑口 ⇒ 传下去接着干。
      //   两条例外：① 内容被拦（filtered）**不许续**（续跑会把被拦内容再发一遍）；② 载体无续跑口（sessionFlag=null）。
      const canResume = v.verdict !== 'filtered' && Boolean(call.sessionId) && Boolean(resolveRole(t.role, AGENTS_CFG)?.sessionFlag)
      // ★ 2026-10-26（限流拆分）：**限流要先等，不能立刻重打**。
      //   实测：本机 490 个 DSH 会话 2745 次重试里 RATE_LIMIT 占 73%（TRANSPORT 550 / TIMEOUT 173），
      //   服务端明明在节流，立刻重发只会再 429 一次、把重试额度烧光。
      //   等多久：服务端给了 Retry-After 就听它的；没给就 20s 起、翻倍、封顶 60s（带抖动，防并行卡同时醒）。
      //   等的时间**留痕**：进日志 ＋ 进判决 `action`（`v.action` → `results` → run-verdict 落盘）。
      //   ⚠️ 刻意**不新增收据字段**：收据 schema 动一次要连带状态库迁移，为一行等待时间不值当。
      let rateWaitMs = 0
      if (v.verdict === 'rate-limit') {
        const plan = waitPlan(`${call.error ?? ''} ${call.stderrTail ?? ''}`, 1, { baseMs: RATE_BACKOFF_BASE_MS, capMs: RATE_BACKOFF_CAP_MS })
        rateWaitMs = plan.ms
        log(`  ⏳ ${t.id} 被限流 → 退避 ${(plan.ms / 1000).toFixed(1)}s 后同通道重试（依据：${plan.source === 'retry-after' ? '服务端 Retry-After' : '默认指数退避'}）`)
        if (rateWaitMs > 0) await new Promise((r) => setTimeout(r, rateWaitMs))
      }
      log(`  ↻ ${t.id} 判定 ${v.verdict}（${v.action}）→ 同通道重试 1 次${canResume ? '，**续上一趟的会话**' : '，**新会话**（换 prompt）'}${rateWaitMs ? `（已退避 ${(rateWaitMs / 1000).toFixed(1)}s）` : ''}`)
      call = await callCrew(t, taskDir, {
        retryHint: `上一次该任务的调用未能正常收尾。动工前先检查交付物是否已经落盘：已完成的部分不要重做，只补齐缺口并复验（跑验收命令、对照任务卡逐条核）。`,
        attempt: 'retry',
        resumeSessionId: canResume ? call.sessionId : null
      })
      v = judge(call)
      if (EXECUTE) recordCrew(t, call)   // ★ 重试也是一次真调（花钱），当场记
      // ★ 2026-10-26：退避过还被限流 ≠ 传输断 —— 前者换通道有效（`rate-limit-final` 允许换家），
      //   后者换模型没用（`flaky-twice` 明确不许换模型）。两条路必须分开，不能都并进 flaky-twice。
      if (v.verdict === 'rate-limit') {
        v = { verdict: 'rate-limit-final', action: `退避 ${(rateWaitMs / 1000).toFixed(1)}s 重试后**仍被限流** → 换同款模型的下一个 API（不换模型）`, retry: false }
      } else if (v.retry) {
        v = { verdict: 'flaky-twice', action: '同通道重试后仍失败 → 换通道（留给下一轮，或人工指派）', retry: false }
      }
    }

    // ── ② 急救（rescue）：**只在"干活的搞不定"时自动上** ────────────────────
    // 依据 `_crew\agents.json` 的 rescue 触发说明 + 用户拍板（2026-10-01）。
    // 为什么不能对所有失败都拉起急救：账号类/权限类**换人也解决不了**（白烧最强模型的额度）。
    //   所以只对"编码本身搞不定"（重试后仍失败）触发，而且**每任务只上 1 次**。
    if (EXECUTE && RESCUE_ON && RESCUE_ABLE.includes(v.verdict)) {
      log(`  🚑 ${t.id} 判定 ${v.verdict}（干活的搞不定）→ **自动拉起急救（rescue）**`)
      const before = v.verdict
      const rescueCall = await callCrew({ ...t, role: 'rescue' }, taskDir, {
        attempt: 'rescue',
        retryHint: `上一个${t.role}做这个任务连续失败（判定 ${before}：${String(v.action || '').slice(0, 100)}）。你是急救，请直接在主树定位并解决，别重复它踩过的路。`
      })
      const rv = judge(rescueCall)
      if (EXECUTE) recordCrew({ ...t, role: 'rescue' }, rescueCall)   // ★ 急救按 **rescue 角色**当场记（原来还会被下面按原角色再记一遍 = 重复计费）
      call = rescueCall
      // ★ 2026-10-05 新增 `rescue-uncertain`（用户拍板）：
      //   实测 T8 的急救**明明干完了**（信封 `is_error:false`、6 个文件落盘、迁移+单测全绿），
      //   却因为"Qoder 进程退出码≠0"被上面的 `if (call.ok !== true)` 判成 flaky →
      //   急救不重试 → `rescue-failed` → 标 blocked（活干完了却停住，还得人来捞）。
      //   判定依据不用再看信封（那是"信谁"的问题），改看**事实**：① 指纹显示**真有产物落盘**
      //   ② 而且**不是被掐断的**（timedOut/signal）。两条都满足 → 进"待审 + 要重点核"，而不是 blocked。
      const produced = ((rescueCall.fingerprint?.added ?? 0) + (rescueCall.fingerprint?.changed ?? 0)) > 0
      const hardKilled = rescueCall.timedOut === true || rescueCall.signal != null
      v = rv.verdict === 'ok'
        ? { verdict: 'rescued', action: `急救已解决（原判定 ${before}）`, retry: false, ctx: rv.ctx ?? null, denials: 0 }
        : (produced && !hardKilled
            ? { verdict: 'rescue-uncertain', action: `急救**疑似已干完**（有产物落盘、未被掐断），但判定为 ${rv.verdict}（exit=${rescueCall.exitCode}）→ 进待审 + 请重点核交付物`, retry: false, ctx: rv.ctx ?? null, denials: 0 }
            : { verdict: 'rescue-failed', action: `急救也没解决（原判定 ${before}）→ 标 blocked + 待裁决`, retry: false, ctx: rv.ctx ?? null, denials: 0 })
      log(`     急救结果：${v.verdict} — ${v.action}`)
    }

    // ── AC 机判（**终审**：重试与急救都做完之后才跑，见 `runAcceptanceGate` 上方注释）────
    {
      const g = runAcceptanceGate(t, v)
      v = g.v
      acResult = g.acResult
    }

    // ★ 2026-10-23（D23）：判决 → **建议动作**（机器可读的 nextAction ＋ 一句人话），进收据、也打到屏幕上
    const adv = adviseFor(t, v)

    // ★ 2026-10-03 修：收据里必须带**指纹差异结论** —— `02-产物与规格.md` 的目录树写着
//   `verdict.json ← 每轮收据（**含指纹差异结论**）`，但 `results.push` 从来没把这个字段带进去
//   （callCrew 里算了却没落到收据）→ 事后回溯"这轮到底改了哪些文件"只能去翻指纹目录。
results.push({ task: t.id, role: t.role, goal: t.goal, verdict: v.verdict, policy: v.policy ?? null, action: v.action, why: v.why ?? null, ctx: v.ctx ?? null, denials: v.denials ?? 0, outJson: call.outJson ?? null,
  // ★ D23：大脑下一步该干什么（`edit-card` = 改卡重派；`resume` = 续跑；`none` = 不用管）
  nextAction: adv.nextAction, suggest: adv.suggest,
  // ★ b219（2026-10-22）：**续跑/拆分经济要的三个字段** —— 会话号（续跑用）、上下文峰值（拆分用）、开工时刻（端到端 R5 用）
  sessionId: v.sessionId ?? call.sessionId ?? null, ctxPeak: v.ctxPeak ?? null, startedAt: call.startedAt ?? null, endedAt: call.endedAt ?? null,
  // ★ b200（M6-6）：原片的三个数（存在性/大小/最后修改）—— 大脑历史上真用过的就是这个粒度
  outFileMeta: outFileMeta(call.outJson),
  fingerprintId: call.fingerprintId ?? null, fingerprint: call.fingerprint ?? null, outOfScope: call.outOfScope ?? [],
  // ★ b197（M6-10 第 3 件）：越界**带类型**进收据 —— 「白名单缺项」与「真越界」是两件事，收据里分得开才谈得上对症。
  outOfScopeKind: call.outOfScopeKind ?? { whitelistGap: [], realOverreach: [] },
  whitelistEmpty: !!call.whitelistEmpty,
  // ★ 2026-10-05：AC 机判结果也进收据 —— 「验过没有」从此是可回查的硬事实，不是一句自述。
  ac: acResult ? { machineVerified: acResult.machineVerified, ok: acResult.ok, checks: (acResult.checks ?? []).map(c => ({ cmd: c.cmd, ok: c.ok, tookSec: c.tookSec, why: c.why })), reason: acResult.reason ?? null } : null,
  // ★ 2026-10-24（施工文档 20261024 §4）：对账结论进收据 —— 「谁的错误」从此可回查（real-fail/derelict/conflict/misreport/unknown）
  acDiagnosis: v.acDiagnosis ? { reconcile: v.acDiagnosis.reconcile, why: v.acDiagnosis.why, next: v.acDiagnosis.next, level: v.acDiagnosis.level, signature: v.acDiagnosis.signature ?? null } : null,
  // ★ 2026-10-05：把"怎么死的"落进收据 —— 否则事后分不清"被超时掐断"还是"自己崩"（T8/T26 就是这么查不出来的）
  exitCode: call.exitCode ?? null, signal: call.signal ?? null, timedOut: call.timedOut ?? null, tookMs: call.tookMs ?? null })

    // ★ 2026-10-23（D23）：建议动作已经在上面 `adviseFor` 里打过一行；这里不再写"回大脑.json"（那文件没人读）。

    if (EXECUTE) {
      // ★ 2026-10-03 修：`rescued` 与 `ok` 一样是**收活**（急救把活干完了），要进 `review`。
      //   原来只认 `ok`，于是"急救已解决"的任务被标 `blocked` —— 报告上看着像卡住，
      //   而且 `blocked` 会让"模块全 Done 才拉审核员"的门永远不成立（解决了却没人审）。
      // ★ b200：`ctx-full-reviewed` 这个判决**已经不再产生**（上下文占用不再参与判决，见 judge() 里 b200 那段），
      //   改成看 `needsReview` 标记 —— 满上下文**且有产物**时，判决仍是 ok，但**照样进待审**（请重点核交付物）。
      if (v.verdict === 'ok' || v.verdict === 'rescued' || v.verdict === 'rescue-uncertain' || v.verdict === 'ctx-full-reviewed') {
        setStatus(t.id, 'review')
        if (v.verdict === 'rescued') log(`  ✅ ${t.id} 由急救解决 → 进待审（**建议重点审**：它是被救回来的）`)
        if (v.verdict === 'rescue-uncertain') log(`  ⚠️ ${t.id} 急救疑似已干完 → 进待审（**必须核交付物**：它没被判定为 ok，只是有产物落盘）`)
        if (v.verdict === 'ctx-full-reviewed' || v.needsReview === true) log(`  ⚠️ ${t.id} 上下文写满但有产物 → 进待审（**必须核交付物**：可能漏了后半段要求；判定仍算 ok，只是要人/审核员多看一眼）`)
      } else if (v.verdict === 'ac-red' || v.verdict === 'ac-env' || v.verdict === 'ac-env-workspace' || v.verdict === 'ac-env-credential' || v.verdict === 'ac-unknown') {
        // ★ 2026-10-24（施工文档 20261024 §4）：AC 红了**先对账** —— 把"为什么红"落成证据（零 token），
        //   结果挂到判决上（收据可见）。动作（返工 / 裁判审 / 环境卡）见 §5.3 四步链。
        const diag = diagnoseAc({ t, acResult, call })
        if (diag) {
          v = { ...v, acDiagnosis: diag }
          // ★ push 在本行之前（早于 diagnose）⇒ 回填最后一条，否则收据里恒 null
          const last = results[results.length - 1]
          if (last && last.task === t.id) last.acDiagnosis = { reconcile: diag.reconcile, why: diag.why, next: diag.next, level: diag.level, signature: diag.signature ?? null }
        }

        // ★ 2026-10-24（§5.3）：能修的**真的去修**（四步链）；修不动才兜底标 blocked
        let chain = null
        if (EXECUTE && diag && diag.next === 'rework' && REWORK_ON) {
          // 状态机：--only-task 只接受 pending/ready/review ⇒ 返工前先把 blocked 改回 pending（留痕）
          setStatus(t.id, 'pending')
          log(`  🔁 ${t.id} 进入返工链（对账=${diag.reconcile}）—— 先把状态改回 pending（留痕）`)
          chain = await runReworkChain({ t, v, call, taskDir, acResult, diag })
          v = chain.v; acResult = chain.acResult
          if (chain.did.length) log(`  📊 ${t.id} 返工链跑了：${chain.did.join(' → ')}`)
        }

        SELF_HEAL.red += 1
        const acGreen = acResult && acResult.ok === true
        if (acGreen && chain && chain.did && chain.did.length) SELF_HEAL.healed += 1
        if (acGreen) { setStatus(t.id, 'review'); log('  OK ' + t.id + ' 返工后 AC 绿 -> 进待审') }
        else {
          setStatus(t.id, 'blocked')
          log(`  ⛔ ${t.id} 标 blocked（${v.verdict}）：${v.action}` + (diag ? ` ｜ 对账=${diag.reconcile} → ${diag.next}` : ''))
        }
      } else { setStatus(t.id, 'blocked'); log(`  ⛔ ${t.id} 标 blocked：AC 仍红（${String(acResult?.checks?.[0]?.why ?? '见收据').slice(0, 80)}）`) }
    }

    if (v.verdict === 'account') { aborted = 'account'; log('**整轮停手**：账号类故障'); break }
    }                        // ← 收尾循环（pairs）结束
    if (aborted) break       // ← 退出并发组
  }                          // ← 并发组循环（groups）结束
  if (aborted) break         // ← 退出批次
}                            // ← 批次循环结束

/* ★ b211 点名结算：本轮每个载体几张卡、花了多少墙钟、并行组/串行组各几组、谁空过。
   落进收据 `rollcall`（看板/审计可查），日志打一行给人看。**只报不改**。 */
const rollcall = (() => {
  const byRole = {}
  const byCarrier = {}
  const msByCarrier = {}
  for (const r of results) {
    const role = String(r.role ?? '?')
    byRole[role] = (byRole[role] ?? 0) + 1
    let c = role
    try { c = String(resolveRole(role, AGENTS_CFG)?.agentName ?? role) } catch {}
    byCarrier[c] = (byCarrier[c] ?? 0) + 1
    msByCarrier[c] = (msByCarrier[c] ?? 0) + Number(r.tookMs ?? 0)
  }
  const vals = Object.values(byCarrier)
  const skew = vals.length > 1 ? Math.max(...vals) - Math.min(...vals) : (vals[0] ?? 0)
  return {
    byCarrier, byRole,
    minutesByCarrier: Object.fromEntries(Object.entries(msByCarrier).map(([c, ms]) => [c, +(ms / 60000).toFixed(1)])),
    waves: { total: rollAcc.wavesTotal, parallel: rollAcc.wavesParallel, serial: rollAcc.wavesTotal - rollAcc.wavesParallel },
    idleCarriers: [...rollAcc.idleSeen],
    skew,
    moveCandidates: [...rollAcc.candidates].slice(0, 12),
    note: '只报不改：队列角色由大脑定（《班组须知-细则》§27a：整卡交替、不劈模块）'
  }
})()
if (results.length) {
  const per = Object.entries(rollcall.byCarrier).map(([c, n]) => {
    const m = rollcall.minutesByCarrier[c] ?? 0
    return CARRIER_ZH(c) + ' ' + n + ' 张' + (m > 0 ? ' / ' + m.toFixed(1) + ' 分' : '')
  }).join(' · ')
  log(`[点名·结算] 本轮 ${results.length} 张：${per}　并行组 ${rollcall.waves.parallel} / 串行组 ${rollcall.waves.serial}` +
    (rollcall.skew >= 2 ? `　⚠️ 偏斜 ${rollcall.skew} 张` : '') +
    (rollcall.idleCarriers.length ? `（${rollcall.idleCarriers.map(CARRIER_ZH).join('、')} 空过）` : '') +
    (EXECUTE ? '' : '　（演练：没调班组，没有墙钟）'))
}

const verdict = {
  stamp, project: PROJECT, execute: EXECUTE, wave: WAVE, maxConcurrency: MAX, parallelism: PAR,   // 字段名 maxConcurrency 保留（兼容读取方）；它的语义 = **每批上限**；真并发看 parallelism
  // ★ b219（2026-10-22）：**整轮起止**（端到端 R5 的唯一数据源；以前收据只有 stamp，算不出"这轮花了多久"）
  startedAt: RUN_STARTED_AT, endedAt: null,
  aborted, results, blocked, review: null,
  rework: REWORKS, selfHeal: SELF_HEAL,
  rollcall,                                    // ★ b211：点名（每载体几张、谁空过、可挪的卡）—— 只报不改
  note: EXECUTE ? '真跑已执行：状态已回填 TASKS.md，工量已回填账本' : '演练：未调用班组、未改 TASKS.md 状态、未记账'
}

// ---------------------------------------------------------------- ⑥ 审校（2026-10-05 重构）
//
// 依据（**用户 2026-10-05 拍板的三条改造**，这里是与旧版最大的不同）：
//   ① 大脑不跑测试   → 全量测试由**零 token 的 `门禁.mjs`** 跑，大脑只读摘要；
//   ② 审核员跑测试 + 改 bug → 它读门禁摘要、修红、复跑到绿（`--permission-mode acceptEdits`）；
//   ③ coder 只跑一条最简命令 → 卡里写死，禁跑全仓。
//
// 触发口径改了（旧口径有实证漏洞）：原来只在"**全部** pending 清空 + `WAVE===null`"时触发一次
//   ⇒ 按 `--wave` 分批派活时条件永远不成立（波 3 的审核就这么整个漏掉，`AUDIT.md` 有记录）。
//   现在改成**按波**：只要"当前没有 pending/doing"就认为这一波做完了 → 跑门禁 → 拉审核员；
//   并用 `_crew\review-stamp.json` 记"这一波的审核已经跑过"，**同一批任务不重复审**（不烧重复的钱）。
function statusRows (waveFilter) {
  // ⚠️ 踩过：`台账 list` **不支持 --json**（只有 `ready` 支持），照 ready 写会 JSON.parse 抛错 →
  //    被 catch 吞掉 → **审核触发永远静默跳过**。所以这里解析人读输出：`   [x] T1  W1  coder-a  done   目标`。
  // ★ 2026-10-27：解析搬进 `_审核一次.mjs` 的 `parseLedgerRows()` —— 原来这里的字符类**漏了 `r`**，
  //   于是所有 `[r]`（ready）行被整行丢弃 ⇒ 带 ready 卡的项目被判"做完了" ⇒ 在没做完的项目上
  //   触发项目周期唯一的那次终审（真跑探针当场抓到）。搬出来才测得了"七个标记逐个过一遍"。
  try {
    const out = execFileSync(NODE, [join(HERE, '台账.mjs'), 'list', '--project', PROJECT], { encoding: 'utf8', maxBuffer: 8 << 20 })
    const rows = parseLedgerRows(out)
    // ★ 2026-10-06 止血（审计实锤）：brain.md 与本函数上方注释都说"按波审"，代码却按**全项目**判
    //    settled —— `--wave` 分批跑时条件永远不成立（波 3 漏审的根）。现在：给了 --wave 就只看那一波。
    const scoped = waveFilter ? rows.filter(r => String(r.wave).toUpperCase() === String(waveFilter).toUpperCase()) : rows
    // ★ 2026-10-27（审核一次制）：**`ready` 也必须算"没做完"** —— 原来是 `['pending','doing']`，
    //   漏了 `ready`（已排好队、还没开工）⇒ "项目还有活没干"被判成 `allSettled` ⇒
    //   拿半成品去触发**项目周期唯一的那一次审核**。判据与 `_审核一次.mjs` 的 OPEN_STATUSES 同一口径。
    const pend = scoped.filter(r => OPEN_STATUSES.includes(r.status))
    const inReview = scoped.filter(r => r.status === 'review')
    const done = scoped.filter(r => r.status === 'done')
    const blockedRows = scoped.filter(r => r.status === 'blocked')
    // 这一波的指纹 = **本批全部任务 ID**（排序后哈希）——任务集一变，指纹就变 ⇒ 该再审一次。
    // ★ 2026-10-26 修（根因）：原来种子只取 `done.map(id)`，而卡片正常会停在 `review`（done=0，
    //   本函数上方 2473 的注释自己就写着这件事）⇒ `sha1('')` = da39a3ee5e6b，导致：
    //   ① 待办里出现"像哈希的假 ID"；② **所有 done=[] 的批次共享同一个 tag** ⇒ sameTag 误判成同一批
    //   ⇒ 审核轮次上限会跨波次累计，不同波被提前刹车。现在种子取本批全量任务 id；
    //   一个都没有时**明确写 unbound**，绝不产出"看起来像指纹"的空哈希。
    DONE_IDS = done.map(r => r.id)
    const tagSeed = scoped.map(r => r.id).sort().join(',')
    const tag = tagSeed ? createHash('sha1').update(tagSeed).digest('hex').slice(0, 12) : 'unbound'
    return { total: rows.length, scopeTotal: scoped.length, pending: pend.length, inReview: inReview.length, done: done.length, blocked: blockedRows.length, tag, allSettled: scoped.length > 0 && pend.length === 0, rows, scoped }
  } catch (e) {
    return { error: String(e?.message ?? e), allSettled: false }
  }
}

/** 取若干任务的"交付:"列 —— 审核改动白名单的数据源。
 *  历史：2026-10-06 止血（原字段从未产出→白名单恒空）；当时改成"读 TASKS.md 原文按行抽"。
 *  ★ 2026-10-09 八·S5：**不再猜散文，改读 TASKS.md 的机器区段**（`台账.mjs` 维护的唯一写口）。
 *    读不到/坏了 ⇒ stderr 出声 + **抛错（fail-closed）** —— 白名单缺项＝指纹护栏失效，宁可停下。 */
function deliverablesOf (ids) {
  const want = new Set(ids)
  const r = spawnSync(NODE, [join(HERE, '台账.mjs'), 'machine', '--project', PROJECT, '--json'], { encoding: 'utf8', maxBuffer: 16 << 20 })
  if (r.status !== 0) {
    const why = String(r.stderr || r.stdout || '').trim().slice(-300)
    console.error(`[编排] ⚠️ deliverablesOf：TASKS.md 机器区段读不到（台账 machine exit=${r.status}）：${why}`)
    throw new Error(`TASKS.md 机器区段读不到 —— 先跑 \`node _unattended\\台账.mjs machine --fix --project "${PROJECT}"\` 重建，再重试`)
  }
  let j = null
  try { j = JSON.parse(String(r.stdout ?? '').replace(/^\uFEFF/, '')) } catch (e) {
    console.error(`[编排] ⚠️ deliverablesOf：machine --json 输出解析失败：${String(e?.message ?? e)}`)
    throw new Error('machine --json 输出不可解析（见上方 stderr）')
  }
  const out = []
  for (const [id, t] of Object.entries(j.tasks ?? {})) {
    if (!want.has(id)) continue
    if (Array.isArray(t?.deliverables)) out.push(...t.deliverables.map(String))
  }
  return out
}

const STAMP_FILE = join(PROJECT, '_crew', 'review-stamp.json')
const BOARD_STATUS = join(PROJECT, '_crew', 'gate-status.json')
function readStamp () { try { return JSON.parse(readFileSync(STAMP_FILE, 'utf8')) } catch { return null } }
function writeStamp (o) { try { mkdirSync(join(PROJECT, '_crew'), { recursive: true }); writeFileSync(STAMP_FILE, JSON.stringify(o, null, 2), 'utf8') } catch {} }

/**
 * ★ 2026-10-16（任务分级 L1–L4，KB 重构\任务分级-施工文档.md §3 ③ / §7-6）：
 *   本波**最浅的那一级** —— 用来决定「门禁 scope」与「拉不拉审核员」。
 *   数据源＝本轮 `runs\<戳>\{tasks,review}\*.dispatch.json` 的 `levelGate` 字段（派活写的，机器可读）。
 *   口径：**只要本波还有一张 L3/L4 的卡，就按最重的那张走**（取最深级 ⇒ 不会因为一张 L1 就把全量省掉）。
 *   读不到任何级号（老卡 / 没标级）⇒ 返回 null ⇒ **一律按今天的行为**（全量门禁 ＋ 拉审核员）。
 */
function waveLevel () {
  const scan = (dir) => {
    let out = []
    try { out = readdirSync(dir).filter(f => /\.dispatch\.json$/i.test(f)).map(f => join(dir, f)) } catch { return [] }
    return out
  }
  // ★ 测试缝（与 `_lock.mjs` 的 `DSH_LOCK_FILE` 同款纪律）：探针可用 `DSH_WAVE_LEVEL_RUNS` 指向**假 runs 根目录**验分级判定，
  //   不必去动真项目。不设它时路径一字不差（`<项目>\_crew\runs`）。
  const runsRoot = process.env.DSH_WAVE_LEVEL_RUNS ?? join(PROJECT, '_crew', 'runs')
  const levels = []
  for (const p of [...scan(join(runsRoot, 'tasks')), ...scan(join(runsRoot, 'review'))]) {
    try {
      const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
      if (j?.level) levels.push({ level: String(j.level), gate: String(j.levelGate ?? 'full') })
    } catch { /* 读不动那份就当它没标级（不猜） */ }
  }
  if (!levels.length) return { any: false, level: null, gate: 'full', count: 0 }
  const rank = { L1: 0, L2: 1, L3: 2, L4: 3 }
  const deepest = levels.reduce((a, b) => (rank[b.level] ?? 3) > (rank[a.level] ?? 3) ? b : a)
  return { any: true, level: deepest.level, gate: deepest.gate, count: levels.length, all: levels }
}

/**
 * ★ 2026-10-23（施工文档 D8 / D9）：**"手"由编排来跑** —— 有可运行物就玩一遍，把证据交给审核员看。
 *
 * 为什么这样分（D8 三条硬事实）：游戏是自绘窗口，UI Automation 树是空的 ⇒ MCP"手"认不出控件；
 *   而 playtest 走像素/指标那条路，15–20 秒就能出 `metrics.json` + `frames/` + `defects`。
 *
 * **不分类产品**：项目根写 `playtest.json` 才算"有可运行物"，没写就如实记"未声明/未试玩"（D9 判定表最后一行）。
 *   `{ "exe": "dist\\game.exe", "title": "格斗", "keys": "enter@2,a@5,right@7:0.8", "seconds": 18 }`
 *   `exe` 可省（只录已有窗口，由人先起好）。
 * 失败**不算过、也不算拦**：记进 `verdict.review.playtest`，由审核员按 D9 判。
 */
function runPlaytest () {
  const cfgFile = join(PROJECT, 'playtest.json')
  if (!existsSync(cfgFile)) return { ok: false, skipped: true, why: '项目没声明 `playtest.json` ⇒ 未试玩（D9 判定表：通过，注明"未试玩"）' }
  let cfg = null
  try { cfg = JSON.parse(readFileSync(cfgFile, 'utf8').replace(/^\uFEFF/, '')) } catch (e) { return { ok: false, why: 'playtest.json 读不出来：' + String(e?.message ?? e) } }
  if (!cfg?.title) return { ok: false, why: 'playtest.json 缺 `title`（窗口标题子串）⇒ 不猜，跳过' }
  const out = join(RUNDIR, 'playtest')
  mkdirSync(out, { recursive: true })
  const py = process.env.DSH_PYTHON ?? 'python'
  const args = [join(HERE, 'playtest', 'playtest.py'), 'run', '--title', String(cfg.title), '--out', out,
    '--seconds', String(Number(cfg.seconds ?? 18)), '--keys', String(cfg.keys ?? '')]
  if (cfg.exe) args.push('--exe', String(cfg.exe))
  if (cfg.video) args.push('--video')
  if (cfg.kill) args.push('--kill')
  log(`  [试玩] 跑一次：${cfg.title}（${Number(cfg.seconds ?? 18)} 秒）→ ${out}`)
  const r = spawnSync(py, args, { encoding: 'utf8', maxBuffer: 16 << 20, timeout: 180_000, windowsHide: true, cwd: PROJECT })
  const metricsFile = join(out, 'metrics.json')
  const defectsFile = join(out, 'defects.json')
  const readJ = (f) => { try { return JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, '')) } catch { return null } }
  const metrics = readJ(metricsFile)
  const defects = readJ(defectsFile)
  const ok = r.status === 0 && Boolean(metrics)
  const line = ok
    ? `试玩完成：${Array.isArray(defects) ? defects.length : (defects?.defects?.length ?? '?')} 条缺陷 · 指标见 metrics.json`
    : `试玩没跑成（exit=${r.status}）：${String(r.stderr ?? r.stdout ?? '').trim().split('\n').slice(-1)[0]?.slice(0, 160) ?? ''}`
  log(`  [试玩] ${line}`)
  return { ok, line, out, metricsFile: existsSync(metricsFile) ? metricsFile : null, defectsFile: existsSync(defectsFile) ? defectsFile : null, frames: join(out, 'frames'), metrics, defects }
}

/**
 * ★ 2026-10-23（施工文档 D7 门禁联动）：**本轮有没有人工放行**（`--waive`）。
 * 口径照 D7：波次收尾时若有放行 ⇒ `gate-result.json` 挂一条 warning 并计数（`waived: N`）——**不阻断，但看得见**。
 */
function waiversInRun () {
  const f = join(PROJECT, '_crew', 'waivers.jsonl')
  if (!existsSync(f)) return []
  try {
    return readFileSync(f, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
      .filter(w => String(w.at ?? '') >= RUN_STARTED_AT)
  } catch { return [] }
}

/** 跑一次门禁（零 token），并把"给看板看的那一行"写下来（用户只认这一行）。 */function runGate (by, scope = [], quick = false) {
  // ★ 六·S3：不再往命令行塞 --by（"不再信命令行文本"）——身份走**环境注入**（门禁侧 env 优先）。
  const args = [GATE, '--project', PROJECT]
  if (scope.length) args.push('--only', scope.join(','))
  // ★ 2026-10-16（任务分级）：L1/L2 只跑 `--quick`（构建＋全仓单测；12 条冒烟约 146 秒是 L3/L4 才要的）
  if (quick && !scope.length) args.push('--quick')
  const r = spawnSync(NODE, args, { encoding: 'utf8', maxBuffer: 32 << 20, timeout: 60 * 60_000, windowsHide: true, env: { ...process.env, DSH_GATE_RANBY: by } })
  let j = null
  try { j = JSON.parse(readFileSync(join(PROJECT, '_crew', 'gate', 'gate-result.json'), 'utf8')) } catch {}
  // ★ 2026-10-21（通用化④）：摘要串**不许再出现 `（undefined）`** —— 门禁给的字段名不止一种
  //   （全绿有 summaryText；"找不到 package.json"那种只有 reason），取不到就说"未知原因"。
  const st = j ? (j.summaryText ?? j.reason ?? (j.failures?.[0] ? String(j.failures[0]).slice(0, 70) : '未知原因')) : null
  const line = !j ? '❌ 门禁跑不起来（看 _crew\\gate\\latest.log）'
    : (j.degraded ? `⚠️ 没有测试入口（跳过：${j.reason ?? st}）`
      : (j.ok ? `✅ 全绿（${st} · ${j.ranAt}）`
              : `❌ 红了（${st}）${j.failures?.[0] ? '：' + String(j.failures[0]).slice(0, 70) : ''}`))
  try {
    writeFileSync(BOARD_STATUS, JSON.stringify({
      at: j?.ranAt ?? new Date().toISOString(), by, ok: j?.ok ?? false, summaryText: j?.summaryText ?? '（跑不起来）',
      failures: j?.failures ?? [], line, hint: j?.hint ?? null, sawRed: true
    }, null, 2), 'utf8')
  } catch {}
  log(`  [门禁] ${line}`)
  return { result: j, exitCode: r.status, line }
}

if (EXECUTE && !aborted && REVIEW_ON) {
  // ★ 2026-10-27（审核一次制）：**判据从"这一波"改成"整个项目"** ——
  //   用户的硬指标是「全量审核（含端到端 / 试玩）在整个项目周期只做 1 次」。
  //   传 null ⇒ `statusRows` 返回全项目行；`--wave` 只留在日志里，**不再参与审核判据**
  //   （原来按波判 ⇒ 波多的项目要审很多次，且跨波集成错误永远等到最后一波才暴露）。
  const st = statusRows(null)
  const stamp0 = readStamp()
  // 项目周期 1 次：项目级 `fullReviewDone`，**永不按波复位**。
  //   原来 `rounds` 绑在波指纹 `tag` 上（`sameTag ? rounds : 0`）⇒ 换一波就归零 ⇒ 等于没有上限
  //   （实测 beidanci 的 stamp 写着 `rounds: 5, maxRounds: 2`）。判据/计数全在 `_审核一次.mjs`。
  const forceReview = reviewOnly || FORCE_REVIEW
  // ★ 2026-10-27：`--review-rounds` **不再起作用**（已改项目周期 1 次）。
  //   但它不能**静默失效** —— 给了就得说一句，否则"表里 A、代码 B"。
  if (opt('review-rounds') !== null) log(`  ℹ️ --review-rounds 已不再适用（项目周期只审 1 次）；要重审请用 --force-review`)
  const plan = reviewPlan({ rows: st.rows ?? [], stamp: stamp0, force: forceReview })
  const fresh = plan.act === 'review'
  if (plan.act === 'used') {
    // ⚠️ 老 stamp 只有 `verdict`（=**调用成功没有**），没有 `decision`（=**审核结论**）。
    //   把 `verdict:'ok'` 当成"审核通过"读，正是历史上 `review.ok` 那个老病
    //   （"这一趟跑通了"被当成"审过了"）。所以：认不出 decision 就如实 unknown，
    //   **不自行判罚也不自行放行** —— 放不放行由 `交付门` 按锚点判。
    const prior = String(stamp0?.decision ?? 'unknown')
    log(`—— ⑥ 审校：**项目周期审核已用（1/1）**（当时结论 ${prior}）→ 不再自动审 ——`)
    verdict.review = { skipped: true, reason: plan.reason, detail: plan.detail,
      fullReviewDone: true, priorDecision: prior, at: stamp0?.at ?? null, reviewId: stamp0?.reviewId ?? null }
    if (prior === 'blocked' || prior === 'reject') {
      // ★ 用户口径（2026-10-27）：「1 次不行，就交由大脑来决断调度」——
      //   工具**不再自动拉第 2 次**，也不再提示 `--force-review`
      //   （那个逃生口正是 beidanci 跑到 5 轮的原因：上限写着 2、实际 5）。
      addHalt({
        id: `REVIEW-${safeBatchTag(st.tag, stamp)}`, kind: '代码类（项目周期审核已用，未通过）',
        why: `项目周期那次全量审核结论是「${prior}」，之后不会再自动审（1/1）→ 交大脑调度：派 coder 修 / 改卡 / 回滚`,
        detail: String(stamp0?.gate ?? '').slice(0, 240), source: '审核段', role: 'reviewer',
        hint: '看该轮 `_crew\\runs\\<戳>\\review\\` 下的报告与问题清单，由大脑决定下一步（工具不再自动重审）'
      })
    }
  } else if (!fresh) {
    // 没到终审条件：如实写"未到"，**不许假装审过**（未知 ≠ 绿）。
    log(`—— ⑥ 审校：还没到终审条件（${plan.reason}）→ 不拉审核员 ——`)
    const gate = runGate(`编排 ${stamp}（项目周期·中途）`)
    verdict.review = { skipped: true, reason: plan.reason, detail: plan.detail,
      gate: { line: gate.line, ok: gate.result?.ok ?? null }, gateOk: gate.result?.ok === true }
  } else {
    log(`—— ⑥ 审校：**项目周期终审（1/1）**：${plan.reason}（done ${st.done} / 待审 ${st.inReview} / 阻塞 ${st.blocked}）→ 先跑门禁，再拉审核员 ——`)
    // ① 门禁：**全量测试的唯一执行者**（零 token）。大脑不跑、coder 不跑，就它跑。
    // ★ 2026-10-16（任务分级）：L1/L2 走 `--quick`（构建＋全仓单测）；L3/L4 与"没标级"维持全量。
    const wl = waveLevel()
    const quickGate = wl.any && (wl.level === 'L1' || wl.level === 'L2')
    // ★ L1（《任务分级》§3 ③ gate＝`ac`）：**不单跑门禁** —— 只跑卡里那条可执行 AC（AC 机器判在 `台账.mjs ac`，结果落 `_crew\gate\ac-*.json`）。
    //   为什么要这样：L1 是"改常量/文案/断言"，跑一遍构建＋全仓单测（~10 秒起）对它是纯固定开销；
    //   而"照真实路径的可执行 AC"这条底线**不许砍**（§5 第 1 条护栏）。L2 及以上一律照跑（只把冒烟换成 --quick）。
    const skipGate = wl.any && wl.level === 'L1' && !FORCE_REVIEW
    if (wl.any) log(`  [分级] 本波最深一级＝${wl.level}（${wl.count} 份派活回执）⇒ ${skipGate ? 'L1 不单跑门禁（只跑卡里那条可执行 AC）' : `门禁 ${quickGate ? '--quick（构建＋全仓单测）' : '全量'}`}、${quickGate ? '不拉审核员' : '拉审核员'}`)
    const gate = skipGate
      ? { result: null, exitCode: null, line: '（L1：按分级不单跑门禁，只跑卡里那条可执行 AC）' }
      : runGate(`编排 ${stamp}（波次 ${WAVE ?? '全部'}）`, [], quickGate)
    // ★ D7：本轮有人工放行 ⇒ 在门禁那一行挂 warning 并计数（不阻断，但看得见）
    {
      const ws = waiversInRun()
      if (ws.length) {
        const names = [...new Set(ws.map(w => String(w.task ?? '?')))]
        const warn = `⚠️ 本轮有 ${ws.length} 处**人工放行**（无绿收据就进 done）：${names.slice(0, 5).join('、')}${names.length > 5 ? ' 等' : ''} —— 明细 \`_crew\\waivers.jsonl\``
        log(`  [门禁] ${warn}`)
        verdict.waived = { count: ws.length, tasks: names, items: ws.slice(0, 20) }
        try {
          const b = JSON.parse(readFileSync(BOARD_STATUS, 'utf8').replace(/^\uFEFF/, ''))
          writeFileSync(BOARD_STATUS, JSON.stringify({ ...b, waived: ws.length, waivedTasks: names, warning: warn }, null, 2), 'utf8')
        } catch { /* 门禁状态文件不在就别写（不编） */ }
      }
    }
    // ★ 2026-10-16（任务分级）：**L1/L2 不拉审核员**（《任务分级》§5：L2 砍冒烟与审核，但"照真实路径的可执行 AC"不许砍）。
    //   判据＝本波最深一级；**读不到级号一律照旧拉**（fail-safe：老卡行为一字不变）。
    //   逃生口＝`--force-review`（复用现成那个"明确要求再审一次"的开关）。
      const skipReview = quickGate && !FORCE_REVIEW
      // ★ b219（施工文档 L5 · 跳审三红线）：
      //   ① 跳过**不加轮次**（rounds 原样写回）——否则一轮"没审"的波白吃一次审核预算；
      //   ② 只有 `gate.result?.ok === true` 才算"绿"；`gate.result` 为 null（如 L1 不单跑门禁）**不许当绿**；
      //   ③ 老卡/无标签卡 **fail-open**：本波有任何一份卡没标级，就不许跳（宁可多审一轮，不放过裸奔条款）。
      const gateGreen = gate.result?.ok === true
      const unlabeled = (() => {
        try {
          const runsRoot = process.env.DSH_WAVE_LEVEL_RUNS ?? join(PROJECT, '_crew', 'runs')
          let n = 0
          for (const dir of [join(runsRoot, 'tasks'), join(runsRoot, 'review')]) {
            let files = []
            try { files = readdirSync(dir).filter(f => /\.dispatch\.json$/i.test(f)) } catch { continue }
            for (const f of files) {
              try { const j = JSON.parse(readFileSync(join(dir, f), 'utf8').replace(/^\uFEFF/, '')); if (!j?.level) n++ } catch { n++ }
            }
          }
          return n
        } catch { return 1 }
      })()
      const skipByLevel = skipReview && unlabeled === 0
      if (skipReview) {
        if (unlabeled > 0) log(`  [分级] ⚠️ 本波有 ${unlabeled} 份卡没标级（无标签老卡）⇒ **不跳审核**（fail-open：宁可多审一轮）`)
        else if (!gateGreen) log(`  [分级] ⚠️ 门禁结果不是"绿"（${gate.result == null ? '这一波没单跑门禁' : '门禁红了'}）⇒ 跳过审核**不等于绿**，如实记下`)
        else log(`  [分级] ${wl.level} 级按《任务分级》§3③ **不拉审核员**（要审就加 --force-review）`)
      }
      if (skipByLevel) {
        verdict.review = { skipped: true, reason: `本波最深一级＝${wl.level}（L1/L2 按分级不拉审核员）`,
          gate: gate.line, gateOk: gateGreen, level: wl.level, unlabeledCards: 0,
          hint: '门禁结果与指纹仍在；确要审一轮：`编排.mjs --project <项目> --review-only --force-review`' }
        writeStamp({ schema: 2, tag: st.tag, at: new Date().toISOString(), reviewId: null, gate: gate.line,
          verdict: 'level-skip-review', fullReviewDone: false, decision: null, gateStamp: null, gateSnapshotId: null })
      }
      if (!skipByLevel) {
    // ② 审核员：读门禁摘要 → 修红 → 复跑 → 出报告（这是它 2026-10-05 起的新职责）
    // ★ 2026-10-23（D8/D9）：**审核不自己摸键鼠** —— "玩"由编排跑 playtest，审核员只看证据。
    const PT = runPlaytest()
    const gateLine = gate.line
    const reviewTask = {
      id: `REVIEW-${stamp}`, role: 'reviewer',
      goal: `**项目周期终审（整个项目只此 1 次）**：门禁已跑完（${gateLine}）${gate.result?.ok === false ? '，把红修到绿，改完只复跑红的那一条' : '，做静态复核 + 跨模块端到端核对'}；重点是**条款审计**与**探索性试用**，出人话报告`,
      accept: [
        // ★ 2026-10-27（审核一次制 · 砍重复）：① 改写。
        //   原来第 1 条就是「**先跑门禁**：`${GATE_CMD}`」—— 等于**命令它重跑一遍**；
        //   同一段又写"不要重跑"，自相矛盾。实测它照第一条做了（beidanci 报告 §9 命令清单第 4 条）。
        '**门禁已由编排跑完，你不要再跑**：摘要已随本卡给你（卡上的 `gate` 段），直接读',
        // ② 保留：它仍有写权（本轮不动），改了就必须有证据
        '**只有你真改了代码**，才有「红→绿」：把红的那一条单独复跑，贴原话与结果（没改就不用编）',
        // ③ 拆：事实归机器，判断归模型
        '**改动的文件清单由编排填**（文件指纹已算）；你只写「为什么改」和「改了哪几行」',
        // ★ b219（施工文档 L7）：审核不只读代码 —— ① 条款审计（④ 保留，唯一不可替代）
        '**条款审计**：逐条核 E1（呈现）/E3（人判）类验收条款，每条给「有证据 / 裸奔（没人验）」结论，裸奔的列出来',
        // ⑤ 保留：一次性 → 自由发挥才是价值（可复现性在"只跑一次"下价值为零）
        '**探索性试用**：以真实用户身份把入口走通（**怎么试由你定**，不许照抄断言），交记录表（入口 / 我做了什么 / 预期 / 实际 / 证据）；**核心路径不通 ⇒ 一票否决**；产物落在本次 `review/试用/` 下，**不进项目的回归套件**',
        // ★ 2026-10-26（真项目 E2E 当场抓到）：`交付门` 要求报告里有 REVIEW-DECISION 机器块，
        //   但**提示词里从来没写过这件事** ⇒ 审核员老实写人话报告，交付门永远 unknown、永远不放行。
        // ★ 2026-10-27（审核一次制）⑥ 改写：**decision/why 是判断，归你；锚点是事实，归机器**。
        //   原来要求"从 gate-result.json 里原样抄 gateStamp/snapshotId" —— 抄错一个字 ⇒ 交付门 unknown
        //   ⇒ 只能再审一次 ⇒ **自己制造重审**。现在留空，由编排用刚跑的那次门禁覆写。
        '**报告最后必须有机器块**（原样这个形状，`gateStamp` / `snapshotId` 留空即可）：',
        '<!-- REVIEW-DECISION {"schema":1,"decision":"pass|blocked","why":"一句话理由","gateStamp":"","snapshotId":"","reviewId":"<本卡 ID>"} -->',
        '　· `decision` 只认 pass / blocked；**非 pass 时 why 必填**（没理由的阻断不可信）',
        '　· `gateStamp` / `snapshotId` **留空就好** —— 编排会用**它自己刚跑的那次门禁**覆写这两个值',
        '　· 缺这个块 ⇒ 交付门判 unknown，**不会放行**（等于这轮白审）',
        // ⑦ 删除：抄"绿几步 / 红几步 / 时间戳" —— 编排手上就有，模型抄一遍是纯重复。
        //    留下的是"引用"（引用才能证明它真读了门禁结果，机器判 `review-unverified` 要用）。
        '**回执里引用门禁结果**：写出 `_crew/gate/gate-result.json` 的路径即可，**数字不用抄**（编排填）',
        // ★ 2026-10-23（D8/D9）：编排已经跑过一遍 playtest —— 审核员**只看证据**，不自己摸键鼠
        PT.skipped
          ? `**试玩证据**：本轮${PT.why}`
          : (PT.ok
              ? `**试玩证据**：编排已跑 playtest（${PT.line}）—— 看 \`${PT.metricsFile}\` 与 \`${PT.defectsFile ?? join(PT.out, 'defects.json')}\`、抽 \`${PT.frames}\` 里的帧；**结论必须挂在这些证据上**，只读代码下"能玩"⇒ 打回`
              : `**试玩证据**：编排跑了但没跑成（${PT.line}）—— 这本身记一条缺陷「声称可跑但起不来」，**不许静默跳过**`),
        '报告末尾一句人话总结'
      ],
      deliverables: ['审核报告', '试用记录（_crew/runs/<stamp>/review/试用/）'], wave: null, track: null,
      // ★ 2026-10-05：**改动白名单**交给审核员自约束（`派活.mjs` 把它写进卡）。
      //   口径：本波被审任务的交付物目录（审核员只该在这些路径里修 bug）。
      //   越界由文件指纹抓 —— 它现在有权写文件，这份清单就是"四条护栏"的第①条。
      //   ★ 2026-10-06 止血：数据源从"statusRows 的 r.deliverables（从来没人产出 → 恒空）"
      //   换成 deliverablesOf()（直接读台账原文的"交付:"列），白名单从此是真数据。
      // ★ 2026-10-26 修（真项目当场抓到 whitelistEmpty）：原来这里要求交付物**必须带目录分隔符**
      //   （`/[\\/]/`），于是根目录下的交付物（`index.html`、`启动-背单词.vbs`）被整条丢掉；
      //   要是这一波没有 done 卡或交付物全在根目录 ⇒ 白名单为空 ⇒ 越界永远归不了因。
      //   现在：带目录的取所在目录，根目录文件**保留文件名本身**（匹配器两种都认）。
      // ★ 2026-10-26：折算逻辑抽到 `_审核白名单.mjs`（根目录交付物不再被丢），这里只负责取"这一波 done 卡的交付物"。
      files: reviewWhitelist(deliverablesOf((st.scoped ?? st.rows ?? []).filter(r => r.status === 'done').map(r => r.id))),
      // 门禁现场（摘要 + 完整输出路径）必须随卡一起给它 —— 否则它得自己再跑一遍才知道红在哪
      gate: gate.result ? { summaryText: gate.result.summaryText, failures: gate.result.failures ?? [], logPath: join(PROJECT, '_crew', 'gate', 'latest.log') } : null,
      // ★ D8/D9：试玩证据（编排跑的；审核员只看不摸）
      playtest: { skipped: !!PT.skipped, ok: PT.ok === true, line: PT.line ?? PT.why ?? null, dir: PT.out ?? null,
        metricsFile: PT.metricsFile ?? null, defectsFile: PT.defectsFile ?? null, frames: PT.frames ?? null },
      // ★ 2026-10-23（D8）：**"手"** —— 项目根写了 `_crew\mcp.json` 才给审核载体挂 MCP（`--mcp-config`）。
      //   没写 ⇒ 不加这个参数（默认零影响）。MCP 提供什么由那个文件决定（例 `dsh-computer-use-win`）。
      mcpConfig: existsSync(join(PROJECT, '_crew', 'mcp.json')) ? join(PROJECT, '_crew', 'mcp.json') : null
    }
    const rdir = join(RUNDIR, 'review'); mkdirSync(rdir, { recursive: true })
    // ①b **后悔药**：放它动手前先把"可能被它碰的目录"整份复制一份（★2026-10-06，本项目不用 git）
    // ★ 2026-10-26：不再假设项目里有 server/* —— 只备份**真实存在**的目录
    const reviewScope = reviewBackupScope({ project: PROJECT, files: reviewTask.files ?? [] })
    const backup = backupBeforeReview(reviewScope)
    // ★ 2026-10-06 修（"死保护"）：判据改成**明确的失败语义** `ok === false`
    //   （原来判 `backup.failed`，而失败时返回的是 `null`、成功对象没有 `failed` 字段 ⇒ 永远为假）。
    //   语义：成功 → 放行；**失败 → fail-closed 不放人**；没有可备份范围（skipped）→ 不算失败，放行。
    if (backup && backup.ok === false) {
      // 审核员**有全权写权**、项目**不用 git** —— 动手前的快照是唯一"后悔药"。
      // 快照失败 = 没有后悔药 → **不放人进场**（fail-closed）：宁可这轮不审，也不给"改坏无副本"开洞。
      log(`  ⛔ [快照] 备份失败 → 本次**不放审核员动手**（fail-closed）：${backup.reason}`)
      addHalt({ id: reviewTask.id, kind: '环境类（审核也没救）',
        why: `审核前快照备份失败 → 已 fail-closed 停手，审核未执行：${backup.reason}`,
        source: '审核段', role: 'reviewer', hint: '先手动跑 `文件指纹.mjs backup --project <项目> --paths server/src` 验证可用，再用 --review-only 补审' })
      verdict.review = { skipped: true, reason: '审核前快照备份失败（fail-closed，不放行）', detail: backup.reason }
    } else {
    if (backup && backup.id) reviewTask.backup = backup
    const call = await callCrew(reviewTask, rdir)
    const v = judge(call)
    // ★ 2026-10-03 补（账目缺口）：**审核员那一趟也必须进账本**。
    //   原来这里只有 callCrew + judge —— 实测账本（`_crew\ledger.json`）与探针账本里**一条
    //   `REVIEW-*.out.json` 都没有**，而真审核信封就躺在 `_crew\runs\<stamp>\review\REVIEW-<stamp>.out.json`
    //   （最大的那份 341111 字节 = 341 KB，`workspaces\_演练3\_crew\runs\2026-10-03T05-10-05\review\`）：
    //   审核员这次**真调、真花额度**，账目却凭空少一趟 —— 违反"账本是每次调用的唯一落点"（§2.6）。
    //   写法照抄上面三处（首次 :404 / 重试 :415 / 急救 :431）：包在 `if (EXECUTE)` 里、当场记、
    //   读的是本次尝试自己的信封（去重键就是这份 envelope，见 工量账本.mjs cmdAdd）。
    if (EXECUTE) recordCrew(reviewTask, call)
    // ★ 2026-10-06 用户拍板第 1/2 条：**审核员也没解决的，要交到用户手上**（红→绿没拿到就别装绿）。
    //   三种情形写进"待你处理"清单：① 门禁还是红的 ② 审核那趟本身失败（没信封/被拒）
    //   ③ 门禁复跑又红了（说明它改了但没修好）。**不重复烧**：同一批同一原因只累加 seen 次数。
    const gateStillRed = !(gate.result?.ok === true)
    const reviewBad = !(v.verdict === 'ok')
    if (reviewBad || gateStillRed) {
      const why = reviewBad
        ? `审核员这一趟没跑成（判定 ${v.verdict}）：${String(v.action ?? '').slice(0, 120)}`
        : `门禁仍是红的：${String(gate.result?.failures?.[0] ?? '').slice(0, 140)}`
      // 先分类：环境类 = 你自己能解决的（补 key/续费/注册）；未知 = 机器没认出（也交人）；其余 = 代码类
      const cls = classifyFailure([why, ...(gate.result?.failures ?? [])].join('\n'))
      addHalt({
        id: reviewTask.id,
        kind: cls.env ? '环境类（审核也没救）' : (cls.unknown ? '未知类（审核也没解决）' : '代码类（审核/急救没解决）'),
        why: cls.env ? cls.why : why, detail: (gate.result?.failures ?? []).slice(0, 5).join(' | ').slice(0, 400),
        source: '审核段', role: 'reviewer',
        hint: cls.env ? '这类要人补外部条件（key/账号/网络/额度），不是代码错'
          : cls.unknown ? '机器没认出：人工看是环境故障还是代码错；若是环境类请把特征补进 编排.mjs 的 ENV_PATTERNS'
            : '代码类：大脑先定夺；大脑定不了才交你'
      })
    } else {
      log('  ✅ 门禁复跑为绿 → 这一波没有欠账')
      // ★ 2026-10-06：**销账** —— 这一轮审核真的把红修绿了，就把"待你处理"里对应条目拿掉。
      //   不销的话看板会永远挂着一条已经解决的红灯（实测过），久了没人再信那个红灯。
      const cleaned = resolveHalt(reviewTask.id, '审核员已把门禁修到全绿')
      if (cleaned) log(`  （顺手销掉 ${cleaned} 条已解决的红灯）`)
      for (const r of results) if (r.verdict === 'ok') resolveHalt(r.task)
    }
    // ★ 2026-10-26（§一）：把"审核员这一趟调用成功了没有"和"审核结论是什么"分开。
    //   `callOk` = 这一趟调用本身成功（原 `review.ok` 的真实含义）；
    //   `decision` = 审核报告末尾机器块里的结论（缺块/格式错 ⇒ unknown，**不得放行**）。
    //   交付门只读 `decision` + 机器块，绝不读 `callOk` 当放行依据。
    const reviewReport = findReviewReport(PROJECT)
    // ★ 2026-10-27（审核一次制）⑥：**锚点由机器给**（事实归机器、判断归模型）。
    //   `anchorsOptional:true` ⇒ 模型只负责 `decision` / `why`；
    //   `gateStamp` / `snapshotId` 缺失或抄错，一律用**编排刚跑的那次门禁**覆写。
    //   为什么必须改：抄错一个字符 ⇒ 交付门 `review:snapshot-mismatch` / `unknown` ⇒ 不放行
    //   ⇒ 只能再审一次 —— 这是**自己制造重审**，而这两个值编排手上就有。
    const machineStamp = gate.result?.stamp ?? null
    const machineSnapshotId = gate.result?.snapshot?.snapshotId ?? null
    const judgedLoose = reviewReport?.path && existsSync(reviewReport.path)
      ? judgeReview(readFileSync(reviewReport.path, 'utf8'), { anchorsOptional: true })
      : { decision: 'unknown', conflict: false, why: '找不到审核报告', block: { ok: false, why: '找不到审核报告', decision: 'unknown', gateStamp: null, snapshotId: null, blockers: [], reviewId: null } }
    const anchors = planAnchors({
      block: judgedLoose.block, gateStamp: machineStamp, snapshotId: machineSnapshotId, reviewId: reviewTask.id
    })
    if (anchors.needRewrite && reviewReport?.path) {
      // 只改写**锚点**（机器真值），`decision` / `why` / `blockers` 仍是审核员的原话 —— 不篡改判断。
      try {
        const fixed = upsertReviewBlock(readFileSync(reviewReport.path, 'utf8'), buildReviewBlock({
          decision: anchors.block.decision, gateStamp: anchors.block.gateStamp,
          snapshotId: anchors.block.snapshotId, blockers: anchors.block.blockers,
          reviewId: anchors.block.reviewId, at: new Date().toISOString()
        }))
        writeFileSync(reviewReport.path, fixed, 'utf8')
        log(`  [锚点] 机器块 gateStamp/snapshotId 已改写成机器真值（${anchors.source}）`)
      } catch (e) {
        log(`  ⚠️ [锚点] 改写机器块失败（按不确定处理）：${String(e?.message ?? e).slice(0, 120)}`)
      }
    }
    const decision = anchors.decision
    const decisionWhy = anchors.why ?? judgedLoose.why ?? null
    verdict.review = { callOk: v.verdict === 'ok', verdict: v.verdict, action: v.action,
      // ★ 2026-10-26：审核结论机器化的三个字段（交付门消费；缺块一律 unknown）
      // ★ 2026-10-27：锚点改为**机器真值**，并标明来源（machine-same / machine-override / none）
      decision, decisionConflict: judgedLoose.conflict === true,
      decisionWhy,
      anchorSource: anchors.source, anchorsMissing: judgedLoose.block?.anchorsMissing === true,
      reviewId: judgedLoose.block?.reviewId ?? reviewTask.id,
      snapshotId: machineSnapshotId,
      gateStamp: machineStamp,
      reportPath: reviewReport?.path ?? null,
      reportSha: reviewReport?.path && existsSync(reviewReport.path) ? reviewReportSha(readFileSync(reviewReport.path, 'utf8')) : null,
      // ★ 2026-10-23（D8/D9）：这一轮**试玩有没有跑、跑成什么样**（审核员看的证据就是它）
      playtest: { skipped: !!PT.skipped, ok: PT.ok === true, line: PT.line ?? PT.why ?? null, dir: PT.out ?? null,
        metricsFile: PT.metricsFile ?? null, defectsFile: PT.defectsFile ?? null, frames: PT.frames ?? null }, outJson: call.outJson ?? null,
      // ★ 2026-10-05：门禁结果进收据 —— "这一波全量测试是什么结论"从此是硬事实（以前只有审核员一句话）
      gate: { line: gate.line, ok: gate.result?.ok ?? null, summaryText: gate.result?.summaryText ?? null, failures: gate.result?.failures ?? [] },
      // 审核那一趟也要留指纹：**它现在有权改文件了**（2026-10-05 起），所以这份差异比以前更重要 ——
      // 它正是"审核员到底动了哪些文件、有没有越界"的唯一机器证据。
      fingerprintId: call.fingerprintId ?? null, fingerprint: call.fingerprint ?? null, outOfScope: call.outOfScope ?? [],
      // ★ b200（M6-6）：审核那一趟的原片元数据也进收据（同一把尺子）
      outFileMeta: outFileMeta(call.outJson),
      // ★ b197（M6-10 第 3 件）：审核那一趟的越界也带类型
      outOfScopeKind: call.outOfScopeKind ?? { whitelistGap: [], realOverreach: [] }, whitelistEmpty: !!call.whitelistEmpty }
    log(`  审核员：${v.verdict} — ${v.action}`)
    log(`  → 结论 decision=${decision}（锚点来源 ${anchors.source}）；**放行与否由交付门按锚点判**`)
    // ★ 2026-10-27（审核一次制）：**项目周期 1 次用掉了就写死**，永不复位。
    //   原来写的是 `rounds: reviewPassed ? 0 : rounds + 1`：绑在波指纹 `tag` 上、换波还归零
    //   （实测 beidanci 出现 `rounds: 5 / maxRounds: 2, verdict: ok` —— 上限写着 2、实际跑到 5）。
    const reviewPassed = v.verdict === 'ok' && decision === 'pass' && judgedLoose.conflict !== true
    writeStamp({
      schema: 2, tag: st.tag, at: new Date().toISOString(), reviewId: reviewTask.id,
      gate: gate.line, verdict: v.verdict, decision,
      gateStamp: machineStamp, gateSnapshotId: machineSnapshotId,
      // ① 审了就是用了（1/1）；② 分级跳过走的是上面另一条道，不会到这
      fullReviewDone: true, passed: reviewPassed
    })
    } // ← 结束"审核流程"主体（备份失败时走上面的 fail-closed 分支，不进场）
    } // ← 结束 skipReview 的 else
  }   // ← 结束"项目周期终审"这条道（plan.act === 'review'）
}

verdict.endedAt = new Date().toISOString()   // ★ b219：整轮终点（R5 端到端 = endedAt - startedAt）
verdict.purpose = PURPOSE                    // ★ 2026-10-24（§12.5）：这一轮是 real 还是 drill

// 先落一次盘：下一步的"入库"要读这个 `verdict.json`（它按收据推样本）。
writeFileSync(join(RUNDIR, 'verdict.json'), JSON.stringify(verdict, null, 2), 'utf8')
VERDICT_WRITTEN = true

// ★ 2026-10-24（施工文档 §12）：**每轮收尾自动入库**（幂等、0 token）。
//   必须排在调参**之前** —— 调参读的是样本库，先入库它才看得到这一轮。
if (EXECUTE && !aborted) {
  try {
    const r = spawnSync(NODE, [join(HERE, '样本库.mjs'), 'ingest', '--project', PROJECT, '--json'],
      { encoding: 'utf8', maxBuffer: 8 << 20, timeout: 60_000, windowsHide: true })
    let j = null
    try { j = JSON.parse(String(r.stdout ?? '')) } catch {}
    const one = j?.res?.[0] ?? null
    if (r.status === 0 && one) {
      log(`  [样本] 新入 ${one.added} 条 · 已在库 ${one.skipped} · 拒收 ${one.rejected}`)
      verdict.samples = { ok: true, added: one.added, skipped: one.skipped, rejected: one.rejected }
    } else verdict.samples = { ok: false, why: String(r.stderr ?? '').slice(-200) }
  } catch (e) { verdict.samples = { ok: false, why: String(e?.message ?? e).slice(0, 160) } }
}

// ★ 2026-10-23（施工文档 D18）：**波次收尾跑一次调参器**（0 token，回放历史），建议进 `_crew\调参\`。
//   只在真跑时做（演练没有新数据）；失败了不影响收据（它只是建议）。
if (EXECUTE && !aborted) {
  try {
    const r = spawnSync(NODE, [join(HERE, '调参.mjs'), '--project', PROJECT], { encoding: 'utf8', maxBuffer: 8 << 20, timeout: 60_000, windowsHide: true })
    const first = String(r.stdout ?? '').split(/\r?\n/).find(l => l.includes('建议已生成')) ?? ''
    if (r.status === 0) {
      log(`  [调参] ${first.trim() || '建议已生成'}`)
      verdict.advisor = { ok: true, line: first.trim() }
    } else verdict.advisor = { ok: false, why: String(r.stderr ?? '').slice(-200) }
  } catch (e) { verdict.advisor = { ok: false, why: String(e?.message ?? e).slice(0, 160) } }
}

// 再落一次盘：这次带上 samples / advisor（第一版已经给入库与调参读过了）。
writeFileSync(join(RUNDIR, 'verdict.json'), JSON.stringify(verdict, null, 2), 'utf8')

// ---------------------------------------------------------------- 收尾：AUDIT.md 追加一行
// ★ 2026-10-03 补：`02-产物与规格.md` 写着 `<项目>\AUDIT.md ← 收尾追加一行`，
//   但**全仓没有任何脚本写它**（实测：跑完整轮之后 AUDIT.md 根本不存在）→ 审计流水等于空的。
//   口径：一轮真跑一行，只记"可核对的硬事实"（任务成败、指纹增删改、审核结论、收据路径），不写叙事。
if (EXECUTE) {
  try {
    const auditPath = join(PROJECT, 'AUDIT.md')
    if (!existsSync(auditPath)) writeFileSync(auditPath, '# 审计流水\n\n> 每轮**真跑**追加一行，由 `编排.mjs` 自动写；只记可核对的硬事实，不写叙事。\n> 每轮收据在 `_crew\\runs\\<时间戳>\\verdict.json`。\n\n', 'utf8')
    // ★ 2026-10-21（越界台账）：AUDIT 那一行也按三档报（卡欠账／有理由／无理由），不再只会说"真越界"。
    const OSUM = summarizeOverreach(RUN_RECORDS)
    const fpAgg = results.reduce((a, r) => ({
      added: a.added + (r.fingerprint?.added ?? 0),
      changed: a.changed + (r.fingerprint?.changed ?? 0),
      removed: a.removed + (r.fingerprint?.removed ?? 0),
      oos: a.oos + ((r.outOfScope ?? []).length),
      // ★ b197（M6-5 · C 通道）：**口径违规也进 AUDIT 那一行** —— 判据①的"长牙"最便宜的半边：
      //   `policy` 本来就写进收据了，只是**没人把它汇成一行可扫的数**（用户每周扫 AUDIT 才看得出"偶发还是常态化"）。
      pol: a.pol + (r.policy ? 1 : 0),
      polOver: a.polOver + (r.policy === 'review-overreach' ? 1 : 0),
      polUnver: a.polUnver + (r.policy === 'review-unverified' ? 1 : 0),
      polBudget: a.polBudget + (r.policy === 'review-over-budget' ? 1 : 0),
      // ★ b197（M6-10 第 4 件）：越界**分两种**进 AUDIT 那一行 —— 真越界与"白名单没写全"不是一个严重度，
      //   混在一起看，等于每周扫流水时看不出"是执行者手长，还是我们的卡没写全"。
      gap: a.gap + ((r.outOfScopeKind?.whitelistGap ?? []).length),
      real: a.real + ((r.outOfScopeKind?.realOverreach ?? []).length),
      noWl: a.noWl + (r.whitelistEmpty ? 1 : 0)
    }), { added: 0, changed: 0, removed: 0, oos: 0, gap: 0, real: 0, noWl: 0, pol: 0, polOver: 0, polUnver: 0, polBudget: 0 })
    const okN = results.filter(r => r.verdict === 'ok' || r.verdict === 'rescued').length
    const badN = results.length - okN
    // ★ 2026-10-26（§一「审核结论机器化」）：`review.ok` 这个名字被删了 ——
    //   它原来只表示"审核员这一趟**调用成功**"，却被人当"审核通过"读。现在分两个：
    //   `callOk`＝调用是否成功；`decision`＝报告机器块里的真结论（缺块一律 unknown）。
    const rv = verdict.review
      ? (verdict.review.skipped ? '未触发' : `${verdict.review.callOk ? '调用ok' : '调用失败'}/${verdict.review.decision ?? 'unknown'}`)
      : '未触发'
    // ★ b88（新问题稿 E 条）：这一行同时自证"**本轮之外**有没有人无收据地动过源码" ——
    //   窗口＝本轮起点（`stamp`，UTC）⇒ 覆盖集合正好是"本轮收据这一批"，多出来的就是别人动的。
    //   为什么写进同一行：`AUDIT.md` 是"每轮一行"的流水，用户每周扫一遍就能看出"偶发还是常态化"（原话口径）。
    let noReceiptBit = ''
    try {
      const nr = spawnSync(NODE, [join(HERE, '无收据改动.mjs'), '--project', PROJECT, '--since', stamp, '--json'],
        { encoding: 'utf8', maxBuffer: 32 << 20, timeout: 120000, windowsHide: true })
      if (nr.status === 0 || nr.status === 2 || nr.status === 3) {
        const j = JSON.parse(String(nr.stdout ?? '').replace(/^\uFEFF/, ''))
        const n = j.counts?.unclaimedOpen ?? 0
        noReceiptBit = n === 0
          ? ' · 收据外改动 0 ✅'
          : ` · 收据外改动 ${n} ⛔ ${(j.files ?? []).slice(0, 3).map((f) => f.path).join('、')}${(j.files ?? []).length > 3 ? ' …' : ''}`
      }
    } catch { /* 算不出来就不写这半句（**不编数字**） */ }
    appendFileSync(auditPath, `- \`${stamp}\` · 真跑 · ${WAVE ? `波次 ${WAVE}` : '全部波次'} · 任务 ${results.length}（ok ${okN} / 其余 ${badN}）`
      + ` · 准入拦下 ${blocked.length} · 指纹 +${fpAgg.added} ~${fpAgg.changed} -${fpAgg.removed}`
      + `${fpAgg.oos ? ` ⚠️越界 ${fpAgg.oos}（卡欠账 ${fpAgg.gap} / 有理由 ${OSUM.justified} / 无理由 ${OSUM.unjustified} / 真越界 ${fpAgg.real}${OSUM.unattributed ? ` / 查不到写入者 ${OSUM.unattributed}` : ''}）` : ''}`
      + `${fpAgg.noWl ? ` ⚠️${fpAgg.noWl} 条任务白名单为空（归不了因）` : ''}`
      + `${fpAgg.pol ? ` ⚠️口径违规 ${fpAgg.pol} 条（跑全量 ${fpAgg.polOver} / 未引门禁 ${fpAgg.polUnver} / 超预算 ${fpAgg.polBudget}）` : ' · 口径违规 0 ✅'}`
      + ` · 审核 ${rv}${aborted ? ` · **整轮停手（${aborted}）**` : ''} · **来源 班组**（本轮收据）${noReceiptBit} · 收据 \`_crew/runs/${stamp}/verdict.json\`\n`, 'utf8')
    log(`  [审计] 已追加一行 → ${auditPath}`)
  } catch (e) {
    log(`  ⚠️ AUDIT.md 追加失败（不影响收活）：${String(e?.message ?? e)}`)
  }
}

log('—— 汇总 ——')
for (const r of results) log(`  ${r.task.padEnd(8)} ${String(r.verdict).padEnd(12)} ${r.action}${r.ctx !== null ? `（ctx=${r.ctx}）` : ''}${r.denials ? `（denials=${r.denials}）` : ''}`)
log(`收据：${join(RUNDIR, 'verdict.json')}`)
if (!EXECUTE) log('**这是演练**：要真跑加 --execute（会花额度、会改 TASKS.md 状态）')
LOCK?.release()
// 退出码：准入拦下过任务、且这轮本来就没活可干 → 3（原来的语义）；否则 0。
// ⚠️ 放到**收尾之后**再给码 —— 不能在队列为空时提前 exit（那会跳过审校与审计，见上面那段注释）。
if (queueEmpty && blocked.length) process.exitCode = 3