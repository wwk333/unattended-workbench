#!/usr/bin/env node
/**
 * 外部用量快照 —— 把**非 DSH 载体**的调用汇总成 `dsh-cost-meter` 认的快照格式。
 *
 * 落点：`<DSH_HOME>\storages\cost-meter\external_usage.json`（**不是**我们的目录）
 * 规格：见 `02-产物与规格.md` §2.6；字段校验口径照 cost-meter 的 `lib/external-usage.js`
 *       （我们逐行读过它的 validate，不是照 README 猜的）。
 *
 * 用法：
 *   node 外部用量快照.mjs                 # 干跑：只打印将要写的内容（默认，绝不误写）
 *   node 外部用量快照.mjs --write         # 真写（原子替换）
 *   node 外部用量快照.mjs --ledger <路径> # 换一本账（排查/复算用；默认 _crew\ledger.json）
 *   node 外部用量快照.mjs --out <路径>    # 换落点（测试用）
 *
 * ⚠️ 四条纪律（都来自 02-产物与规格.md §2.6，别自己发挥）：
 *   ① **只写非 DSH 载体** —— DSH 自己的调用已被 cost-meter 自动计量，写进来就是**重复计费**；
 *   ② 每次**整份替换**（不允许追加增量）；先写同目录临时文件再**原子改名**；
 *   ③ `source` 用稳定来源名（这里 = **载体名**，不是模型名）；
 *   ④ 文件里**不许出现密钥**（本脚本只搬运数字）。
 *
 * ★ 关于 `costUsd`（重要，别误读）：
 *   cost-meter 的日汇总模式**强制要求** `costUsd` 是 ≥0 的有限数（校验不过整份快照会被丢弃）。
 *   而我们这四个载体走的是**套餐计费**（阿里 token plan / 火山 coding plan / Qoder 订阅），
 *   **每次调用的边际美元根本读不到** —— 所以这里写 **0**，语义是"**读不到**"，不是"免费"。
 *   真正能拿到金额的只有 DSH 那一侧（cost-meter 自动计量）。口径见 `00-策划方案.md` §6：
 *   **拿不到就明说拿不到，禁止估算**。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')

const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }

// ⚠️ 必须与 `工量账本.mjs` **读同一本账**：它用 `resolve(WORKSPACE, process.env.DSH_LEDGER ?? '_crew/ledger.json')`，
//    这里同理 —— 否则父进程写 A 账、子进程读 B 账，会出现"报告成功了但快照没变"这种静默不一致。
const LEDGER = resolve(opt('ledger') ?? (process.env.DSH_LEDGER ? resolve(WORKSPACE, process.env.DSH_LEDGER) : join(WORKSPACE, '_crew', 'ledger.json')))
// ★ 2026-10-07 修（实测踩到）：`DSH_EXTERNAL_USAGE` 原来用 `resolve(...)` 直接解，**相对路径按 CWD 算**，
//   而 `DSH_LEDGER` 明确定义为"相对工作区"（上面那行）—— 两个同族的隔离开关行为不一致，
//   演练时给了相对路径就会落到 `_unattended\_probe\...`（目录不存在 → 直接抛，看着像护栏坏了）。
//   现在：**显式 `--out` 按 CWD**（命令行本来就该这样），**env 相对路径按工作区**（与 DSH_LEDGER 对齐）。
const envOut = process.env.DSH_EXTERNAL_USAGE
const OUT = resolve(
  opt('out') ??
  (envOut ? (isAbsolute(envOut) ? envOut : join(WORKSPACE, envOut)) : join(DSH_HOME, 'storages', 'cost-meter', 'external_usage.json'))
)
const MAX_DAYS = Number(opt('days') ?? 90)
const WRITE = has('write')

/** 载体名 → 快照里的稳定来源名。**不在这里的载体一律跳过**（含 DSH 自己的 messenger）。 */
const SOURCE_OF = { pi: 'Pi', opencode: 'OpenCode', codebuddy: 'CodeBuddy', qoder: 'Qoder', qwencode: 'Qwen Code' }

const cfgPath = resolve(WORKSPACE, '_crew', 'agents.json')
const cfg = existsSync(cfgPath) ? JSON.parse(readFileSync(cfgPath, 'utf8').replace(/^\uFEFF/, '')) : { roles: {}, agents: {}, defaultAgent: 'messenger' }

function agentOfRole (role) {
  return cfg.roles?.[role]?.agent ?? cfg.defaultAgent ?? 'messenger'
}

/** 计数必须是"非负安全整数"（cost-meter 校验很严，一个小数点就整份作废）。 */
const int = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? Math.min(Math.round(n), 1e12) : 0 }

function dayKeyOf (call) {
  if (typeof call.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(call.date)) return call.date
  const t = Date.parse(call.at ?? '')
  if (!Number.isFinite(t)) return null
  const d = new Date(t)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

const ledger = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8').replace(/^\uFEFF/, '')) : { calls: [] }
const calls = Array.isArray(ledger.calls) ? ledger.calls : []

/** 按来源 → 日期聚合。保留历史日期（整份替换，不追加）。 */
const bySource = new Map()
let skippedDsh = 0; let skippedUnknown = 0
for (const c of calls) {
  const agent = agentOfRole(c.role)
  const source = SOURCE_OF[agent]
  if (!source) { if (agent === 'messenger' || agent === 'dsh') skippedDsh++; else skippedUnknown++; continue }
  const date = dayKeyOf(c)
  if (!date) continue
  const days = bySource.get(source) ?? new Map()
  const day = days.get(date) ?? { input: 0, output: 0, cached: 0, calls: 0, costUsd: 0 }
  day.input += int(c.usage?.inputTokens)
  day.output += int(c.usage?.outputTokens)
  day.cached += int(c.usage?.cacheReadInputTokens)
  day.calls += 1
  days.set(date, day)
  bySource.set(source, days)
}

const sources = []
for (const [source, days] of bySource) {
  const keys = [...days.keys()].sort().reverse().slice(0, MAX_DAYS)
  const out = {}
  for (const k of keys) {
    const d = days.get(k)
    out[k] = { input: d.input, output: d.output, cached: d.cached, calls: d.calls, costUsd: 0 }
  }
  sources.push({ source, days: out })
}

console.log(`[快照] 账本：${LEDGER}（${calls.length} 次调用）`)
console.log(`[快照] 分来源：${sources.map(s => `${s.source}=${Object.keys(s.days).length}天`).join(' / ') || '（无）'}`)
if (skippedDsh) console.log(`[快照] 已跳过 DSH 自己的调用 ${skippedDsh} 次（写进来会重复计费）`)
if (skippedUnknown) console.log(`[快照] 已跳过无法归类的角色 ${skippedUnknown} 次（角色不在 agents.json 里？）`)

if (sources.length === 0) {
  // 快照规范要求至少 1 个来源；写一份空的就是无效文件，会被 cost-meter 整个忽略 —— 所以宁可不写。
  // ★ 用**独立退出码 3** 表示"有意跳过"：否则调用方只看 exit=0 会误报"已刷新"（实测踩过）。
  console.log('[快照] 非 DSH 载体还没有任何调用记录 → 不写文件（避免写出一份无效快照）')
  process.exit(3)
}

// ★★ 2026-10-07 新增死保护（**由一次真实事故换来**，别拆）：
//   **"用隔离账本跑出来的快照，绝不许写进真的 cost-meter 库"。**
//   事故经过：零成本桩演练（`_probe\stub-carrier.mjs`）为了"不污染真账本"设了
//     `DSH_LEDGER=_probe/ledger.e2e.json`，但**没设 `DSH_EXTERNAL_USAGE`**；
//     而 `工量账本.mjs add` 收活后会自动用 `--write` 刷新快照 ⇒ 于是拿**临时账本**
//     算出一份快照、**原子替换掉了** `~\.dsh\storages\cost-meter\external_usage.json`（真库）
//     ⇒ 紧接着"两本账对账"的 C1/C2/C2b/C5 **全红**（快照与真账本对不上）。
//   判据：**账本是隔离的（`DSH_LEDGER` 或 `--ledger`）、而落点没显式给（`--out` / `DSH_EXTERNAL_USAGE`）**
//     ⇒ **拒绝写**（exit=4），并说清两条出路。干跑（不带 `--write`）**永远放行**（看，不改）。
const ledgerIsolated = !!process.env.DSH_LEDGER || !!opt('ledger')
const outExplicit = !!opt('out') || !!process.env.DSH_EXTERNAL_USAGE
if (WRITE && ledgerIsolated && !outExplicit) {
  console.error('[快照] ⛔ 拒绝写：**账本是隔离的**（DSH_LEDGER / --ledger）而**落点没显式给**。')
  console.error(`         隔离账本：${LEDGER}`)
  console.error(`         默认落点：${OUT}  ← 这是 **cost-meter 的真库**，用临时账本算出来的数写进去会让账目对不上`)
  console.error('  两条出路：① 演练请**一起**隔离落点：DSH_EXTERNAL_USAGE=<临时文件>；')
  console.error('            ② 只是想重算真库：不要传 DSH_LEDGER/--ledger（用真账本 _crew\\ledger.json）。')
  process.exit(4)
}

const snapshot = { fetchedAt: new Date().toISOString(), sources }
const text = JSON.stringify(snapshot, null, 2)

if (!WRITE) {
  console.log('[快照] 干跑（没有 --write，不落盘）。将要写入的内容：')
  console.log(text)
  process.exit(0)
}

// 原子替换：先写同目录临时文件，再改名（cost-meter 读到写了一半的文件会整份忽略）
// ★ 2026-10-07：先确保目录存在 —— 落点被 `--out`/`DSH_EXTERNAL_USAGE` 换到临时目录时它可能还不存在，
//   否则 `writeFileSync` 直接抛（实测踩到：看着像"护栏坏了"，其实是目录没建）。
mkdirSync(dirname(OUT), { recursive: true })
const tmp = OUT + '.tmp'
writeFileSync(tmp, text, 'utf8')
renameSync(tmp, OUT)
console.log(`[快照] ✅ 已原子替换：${OUT}（${Buffer.byteLength(text)} B / ${sources.length} 个来源）`)