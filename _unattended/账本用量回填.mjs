// 账本用量回填（一次性迁移工具）—— 2026-10-05
//
// 为什么需要它：`_agents-config.mjs` 的 JSONL 解析曾对 **OpenCode** 的 `step_finish` 用量
//   **覆盖式赋值**（每个 step 盖掉上一个）→ 账本里 coder-b 每次调用只记到**最后一步**的 token
//   （实测少报约 **1500 倍**：3.5 万 vs 真实 5240 万），看板表3「消耗」因此严重失真。
//   解析器 **已修**（改成逐步累加 + 拍平 `cache.read/write`），但**历史条目记的是旧数** —— 本工具按
//   信封**重算并回填** `calls[].usage`（其余字段一律不动）。
//
// 用法：
//   node 账本用量回填.mjs            # 演练：只报"会改几条、各角色前后合计"，**不写文件**
//   node 账本用量回填.mjs --apply    # 真填：先备份 ledger.json，再原子替换
// 退出码：0 = 正常；3 = 有信封读不出来（会列出来，不静默跳过）
import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseCarrierOutput } from './_agents-config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WS = resolve(HERE, '..')
const LEDGER = join(WS, '_crew', 'ledger.json')
const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? process.env.HOME ?? homedir(), '.dsh')
const SNAP = process.env.DSH_EXTERNAL_USAGE ?? join(DSH_HOME, 'storages', 'cost-meter', 'external_usage.json')
const APPLY = process.argv.includes('--apply')

const sum = (u) => u ? ((u.inputTokens ?? 0) + (u.outputTokens ?? 0) + (u.cacheReadInputTokens ?? 0) + (u.cacheCreationInputTokens ?? 0) + (u.reasoningTokens ?? 0)) : 0

const L = JSON.parse(readFileSync(LEDGER, 'utf8'))
const calls = L.calls ?? []
const before = {}, after = {}
let changed = 0, unreadable = 0, noEnv = 0

for (const c of calls) {
  const r = c.role ?? '(无)'
  before[r] = (before[r] ?? 0) + sum(c.usage)
  let env = null
  if (c.envelope && existsSync(c.envelope)) {
    try {
      const raw = readFileSync(c.envelope, 'utf8')
      const errPath = String(c.envelope).replace(/\.out\.json$/, '.err.txt')
      env = parseCarrierOutput(raw, existsSync(errPath) ? readFileSync(errPath, 'utf8') : '')
    } catch { env = null }
  } else noEnv++
  if (!env) {
    unreadable++
    console.log(`  ⚠️ 读不出信封：${c.role ?? '?'} / ${c.task ?? '?'} / ${c.envelope ?? '(无路径)'}`)
    after[r] = (after[r] ?? 0) + sum(c.usage)
    continue
  }
  const u = env.usage ?? null
  const nu = u ? {
    inputTokens: u.input ?? null, outputTokens: u.output ?? null,
    cacheReadInputTokens: u.cacheRead ?? null, cacheCreationInputTokens: u.cacheWrite ?? null,
    reasoningTokens: u.reasoning ?? null, totalTokens: u.totalTokens ?? null,
    contextUsageRatio: u.context_usage_ratio ?? u.contextUsageRatio ?? c.usage?.contextUsageRatio ?? null
  } : c.usage
  if (JSON.stringify(nu) !== JSON.stringify(c.usage)) { changed++; if (APPLY) c.usage = nu }
  after[r] = (after[r] ?? 0) + sum(nu)
}

console.log(`账本 ${calls.length} 条 | 需要改 ${changed} 条 | 读不出信封 ${unreadable} 条 | 本来就没信封 ${noEnv} 条`)
console.log('\n角色            回填前            回填后')
for (const r of Object.keys({ ...before, ...after }).sort()) {
  console.log('  ' + r.padEnd(12) + String(before[r] ?? 0).padStart(14) + String(after[r] ?? 0).padStart(18))
}
if (!APPLY) {
  console.log('\n（演练，没写文件。要真填加 --apply）')
  process.exit(unreadable ? 3 : 0)
}
const bak = LEDGER + '.before-usage-backfill-' + new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
copyFileSync(LEDGER, bak)
L.calls = calls
const tmp = LEDGER + '.tmp'
writeFileSync(tmp, JSON.stringify(L, null, 2), 'utf8')
renameSync(tmp, LEDGER)
console.log(`\n✅ 已回填（备份：${bak}）`)

// ★ 2026-10-05：**必须顺手刷新"外部用量快照"** —— 否则账本改了、快照还是旧数，
//   `起飞前检查 ③ 两本账对账` 会直接报硬错 C1（实测就是这么被拦下的，说明那道闸有效）。
//   （快照是喂 cost-meter 的；它是"账本的投影"，账本一变就得跟着变。）
try {
  // ⚠️ 2026-10-05 踩过：`外部用量快照.mjs` **默认是干跑**，必须传 `--write` 才落盘 ——
  //   我第一版没传 → 它 exit=0、我却报了"✅ 已同步刷新"，实际快照一个字没改
  //   （`起飞前检查 ③ 两本账对账` 照样报 C1；这就是"拼得出 ≠ 运行时生效"）。
  //   现在：**真传 --write，并且写完回读 `fetchedAt` 验一遍**才敢说成功。
  const before = (() => { try { return JSON.parse(readFileSync(SNAP, 'utf8')).fetchedAt } catch { return null } })()
  const r = spawnSync(process.execPath, [join(HERE, '外部用量快照.mjs'), '--write'], { encoding: 'utf8' })
  const after = (() => { try { return JSON.parse(readFileSync(SNAP, 'utf8')).fetchedAt } catch { return null } })()
  if (r.status === 0 && after && after !== before) console.log(`✅ 外部用量快照已真正刷新（fetchedAt ${before ?? '(无)'} → ${after}）`)
  else console.log(`⚠️ 外部用量快照**没有**刷新（exit=${r.status}，fetchedAt ${before ?? '(无)'} → ${after ?? '(读不到)'}）\n` +
    `   → 请手动跑：node _unattended\\外部用量快照.mjs --write\n   → 不修好，起飞前检查 ③ 两本账对账 会报硬错 C1\n   ${String(r.stderr ?? '').trim().slice(-200)}`)
} catch (e) {
  console.log(`⚠️ 外部用量快照刷新失败：${String(e?.message ?? e)}\n   → 请手动跑：node _unattended\\外部用量快照.mjs --write`)
}
process.exit(unreadable ? 3 : 0)