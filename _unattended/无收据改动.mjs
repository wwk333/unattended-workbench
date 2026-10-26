#!/usr/bin/env node
/**
 * 无收据改动 —— **"违反规则不产生任何信号"的解药**（新问题 A · 零 token 机器检测器）
 *
 * ## 它治什么病（2026-10-12 实况，不是推演）
 * `roles\brain.md` 早写着「写文件的活不许用 `subagent` 代替」，当晚被违反 6 次：`_crew\runs\` **当天 0 条**
 * （没走编排 ⇒ 无任务卡、无回执、无指纹、无门禁），而看板、账本、门禁**全是绿的** ——
 * **"违反了规则"这件事本身不产生任何可观测信号**。现在靠"人写规则 ＋ 台账拦 done"，**不是机器扫**。
 *
 * ## 判据（一句话）
 * **窗口期内，项目里被动过、却没有任何一轮收据/指纹覆盖的文件 —— 就是"无收据改动"。**
 *   · **窗口** ＝ 最近 `--limit` 轮编排的起点（默认最近 1 轮；`--since` 可显式指定）。
 *   · **有收据**（＝"你声明过"）＝ 每轮 `verdict.json` 里每个任务的 `fingerprintId`
 *     → `_crew\fingerprints\<id>.diff.json` 的 `added/changed/removed`；再加收据里的 `outOfScope`
 *     （**已登记的越界**也算"有留痕"）。
 *   · **实际动过** ＝ `文件指纹.mjs scan`（**同一套排除表**，见那边的 SKIP_DIRS/SKIP_RELS）里
 *     `mtime ≥ 窗口起点` 的文件。
 *   · 差集 ⇒ 报出来。**只看、不改、不杀**。
 *
 * ## 用法
 *   node 无收据改动.mjs [--project <目录>] [--limit 1] [--since 2026-10-12T20:00-00] [--json] [--hash] [--fallback-hours 24] [--no-fallback]
 *   · 不给 `--project`：读 `_crew\当前项目.txt`（与看护/体检同一口径）。
 *   · **一轮收据都没有**（`_crew\runs` 空）⇒ **不再"算不出来"**，取最近 `--fallback-hours` 小时（默认 24）
 *     当窗口 —— **那正是最该报警的情形**（2026-10-24 夜跑：5 个文件被动过、0 轮收据，
 *     而这里说"无法定窗口"，于是看板/门禁/体检全绿）。`--no-fallback` 回到老行为（直接 exit 1）。
 *   · `--include-crew`：**别开**（除非在查编排自己）。默认排除 `_crew\` 整个目录 —— 它是编排的记账与日志，
 *     不是"班组交付物"；不排除的话日志天天在写，报出来全是噪音，信号就被淹了。
 *   · `--hash`：逐字节比（+10 秒/2000 文件）。默认只比 `size+mtime`（与 `文件指纹.mjs diff` 降级时同口径）。
 *
 * ## 退出码
 *   `0` ＝ 干净（无收据改动 0 个）｜ `2` ＝ 有，但**全都已豁免**（黄）｜ `3` ＝ 有且未豁免（红）｜ `1` ＝ 用法/环境错
 *   ⚠️ 黄/红**都不是"出错"**，是"得有人看一眼"；`体检.mjs` 与 `门禁.mjs` 都会把它带进结论。
 *
 * ## 豁免（"确有例外"必须有留痕，不能靠嘴）
 *   `<项目>\_crew\无收据改动-豁免.json`：`{ "files": [ { "path": "a/b.ts", "why": "…", "at": "…" } ] }`
 *   —— 命中即从**红**降为**黄**，并在输出里如实写"已豁免 N 个（附原因）"。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WS = resolve(HERE, '..')
const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const has = (n) => argv.includes('--' + n)
const AS_JSON = has('json')

const log = (s) => { if (!AS_JSON) console.log(s) }
const die = (msg) => {
  if (AS_JSON) process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n')
  else console.error('❌ ' + msg)
  process.exit(1)
}

/** 项目：`--project` > `_crew\当前项目.txt`（与看护/体检同一口径，别再发明第三种）。 */
function resolveProject () {
  const p = opt('project')
  if (p) { const r = resolve(p); return existsSync(r) ? r : die('项目目录不存在：' + r) }
  const ptr = join(WS, '_crew', '当前项目.txt')
  if (existsSync(ptr)) {
    const v = readFileSync(ptr, 'utf8').trim().split(/\r?\n/)[0].trim()
    if (v && existsSync(v)) return resolve(v)
  }
  return die('没说项目，也读不到 _crew\\当前项目.txt —— 用 --project <目录>')
}
const PROJECT = resolveProject()

/**
 * 收据戳 `2026-10-13T11-36-07` → 毫秒。
 * ⚠️ **这是 UTC**（`编排.mjs` 用 `new Date().toISOString()` 生成；实测该轮目录本地创建时间＝19:36:07，
 * 而戳写 11:36:07 ⇒ 差 8 小时）。按"本地时间"解析会把窗口整整提前 8 小时，多报一堆无关文件 —— 踩过。
 */
function parseStamp (s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2})[-:](\d{2})[-:](\d{2})Z?$/.exec(String(s ?? '').trim())
  if (!m) return null
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]))
}
const norm = (s) => String(s ?? '').replace(/\\/g, '/').replace(/^\.\//, '').toLowerCase()

const RUNS = join(PROJECT, '_crew', 'runs')
const FP_DIR = join(PROJECT, '_crew', 'fingerprints')
const EXEMPT_FILE = join(PROJECT, '_crew', '无收据改动-豁免.json')

// ── ① 窗口：最近 N 轮里最早那轮的起点
// ★ 2026-10-24（施工文档 §10.2 ⑤）：**一轮收据都没有**时**不再"算不出来"** ——
//   那恰恰是最该报警的情形（2026-10-24 夜跑：5 个文件被动过、`_crew\runs` 压根没建，
//   而这里直接 `exit 1` 说"无法定窗口"，于是看板/门禁/体检全是绿的）。
//   兜底取「最近 `--fallback-hours` 小时」（默认 24）；要精确仍可 `--since`；`--no-fallback` 回到老行为。
const LIMIT = Math.max(1, Number(opt('limit', 1)) || 1)
const FB_HOURS = Math.max(1, Number(opt('fallback-hours', 24)) || 24)
let windowAt = parseStamp(opt('since')) /** @type {number|null} */
let windowWhy = windowAt ? '命令行 --since' : null
let NO_RECEIPTS = false
let windowStamps = []
if (!windowAt) {
  const dirs = existsSync(RUNS) ? readdirSync(RUNS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : []
  if (!dirs.length) {
    if (has('no-fallback')) die(`这个项目还没有任何一轮收据（${RUNS} 不存在或为空）⇒ 无法定窗口；真有活干过却没轮次，那本身就是"无收据"的最强信号，请用 --since 指定起点再跑（或去掉 --no-fallback 用兜底窗口）`)
    NO_RECEIPTS = true
    windowAt = Date.now() - FB_HOURS * 3600 * 1000
    windowWhy = `**兜底** —— 本项目一轮收据都没有（${RUNS} 空）⇒ 取最近 ${FB_HOURS} 小时`
  } else {
    windowStamps = dirs.slice(-LIMIT)
    const first = windowStamps[0]
    const vj = join(RUNS, first, 'verdict.json')
    let t = null
    try { t = parseStamp(JSON.parse(readFileSync(vj, 'utf8')).stamp) } catch {}
    if (!t) { try { t = statSync(join(RUNS, first)).mtimeMs } catch {} }
    windowAt = t
    windowWhy = `最近 ${LIMIT} 轮的起点（${first}，戳是 UTC）`
  }
}
if (!windowAt) die('定不出窗口起点')

// ── ② 有收据的（＝"你声明过"）：每轮 verdict 里每个任务的指纹 diff ＋ 已登记越界
const covered = new Set()
const declaredOutOfScope = new Set()
const missingDiffs = []
const runsSeen = []
{
  const dirs = existsSync(RUNS) ? readdirSync(RUNS, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : []
  const want = windowStamps.length ? windowStamps : dirs.filter((d) => { try { return statSync(join(RUNS, d)).mtimeMs >= windowAt } catch { return false } })
  for (const d of want) {
    const vj = join(RUNS, d, 'verdict.json')
    if (!existsSync(vj)) continue
    let v = null
    try { v = JSON.parse(readFileSync(vj, 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
    runsSeen.push({ stamp: v.stamp ?? d, tasks: (v.results ?? []).length })
    for (const r of v.results ?? []) {
      for (const p of r.outOfScope ?? []) declaredOutOfScope.add(norm(p))
      const id = r.fingerprintId ?? r.task
      if (!id) continue
      const dj = join(FP_DIR, `${id}.diff.json`)
      if (!existsSync(dj)) { missingDiffs.push(id); continue }
      try {
        // ⚠️ 剥 BOM：本工作台老坑（PowerShell 写的 JSON 带 BOM，`JSON.parse` 直接抛）——
        //   不剥就会把"读得到"说成"读不到"，收据覆盖数假降（实测踩过：夹具里那份 diff 就带 BOM）。
        const dd = JSON.parse(readFileSync(dj, 'utf8').replace(/^\uFEFF/, ''))
        for (const rel of [...(dd.added ?? []), ...(dd.changed ?? []), ...(dd.removed ?? [])]) covered.add(norm(rel))
      } catch { missingDiffs.push(id) }
    }
  }
}

// ── ②b ★ 2026-10-23（施工文档 D13）：**认领来源补上「窗口内的 diff」**
//
// 为什么必须补（实测 2026-10-22 的假红）：门禁在 **04:35:37** 跑，判 `noReceipt: red`（`src/render/hud.py`），
//   可 `hud.py` 早在 **04:35:18** 就落进 `T1-11.diff.json` 的 `changed` 里了 —— 那一轮的 `verdict.json`
//   要到 **04:43:06** 才写出。于是"门禁跑的时候这一轮的 verdict 还不存在" ⇒ **当前轮所有改动都被判"无收据"**。
// 为什么范围不会变大：verdict 的 `fingerprintId` **指的就是同一份 `<id>.diff.json`** —— 两者范围一模一样，
//   只是把认领的时点从"轮末"提前到"diff 落盘"。
// 三条防护（照施工文档写死）：
//   ① **只认 `at ≥ 窗口起点` 的 diff**（`fingerprints\` 按 id 扁平命名，上一波同 id 的旧 diff 还在 —— 不设这条就会串轮）；
//   ② 未结束的卡没有 diff ⇒ 保持红（方向安全）；
//   ③ diff 里混进别人的改动 —— 改前就有（verdict 指向同一份 diff），要堵靠 D10 的 actor，不在这里。
const claimedByDiff = []
try {
  if (existsSync(FP_DIR)) {
    for (const f of readdirSync(FP_DIR).filter((x) => /\.diff\.json$/i.test(x))) {
      let dd = null
      try { dd = JSON.parse(readFileSync(join(FP_DIR, f), 'utf8').replace(/^\uFEFF/, '')) } catch { continue }
      const at = Date.parse(dd?.at ?? '')
      if (!Number.isFinite(at) || at < windowAt) continue          // 防护①
      const files = [...(dd.added ?? []), ...(dd.changed ?? []), ...(dd.removed ?? [])]
      if (!files.length) continue
      for (const rel of files) covered.add(norm(rel))
      claimedByDiff.push({ diff: f, id: dd.id ?? null, at: dd.at, files: files.length })
    }
  }
} catch { /* 读不到指纹目录 = 没有额外认领（不编） */ }

// ── ③ 豁免（有留痕的例外）—— 命中即从红降黄
const exempt = new Map()
try {
  const e = JSON.parse(readFileSync(EXEMPT_FILE, 'utf8').replace(/^\uFEFF/, ''))
  for (const x of e.files ?? []) if (x?.path) exempt.set(norm(x.path), { why: x.why ?? '（没写原因）', at: x.at ?? null })
} catch { /* 没这个文件 = 没有豁免，正常 */ }

// ── ④ 实际被动过的文件：**复用「文件指纹.mjs scan」**（同一套排除表，别在这儿再写一份）
const scanArgs = [join(HERE, '文件指纹.mjs'), 'scan', '--project', PROJECT, '--json']
if (has('hash')) scanArgs.push('--hash')
const sc = spawnSync(process.execPath, scanArgs, { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 120000, windowsHide: true })
if (sc.status !== 0) die(`扫描失败（exit=${sc.status}）：${String(sc.stderr ?? '').trim().split('\n').slice(-1)[0] ?? '?'}`)
let scan = null
try { scan = JSON.parse(String(sc.stdout ?? '').replace(/^\uFEFF/, '')) } catch (e) { die('扫描输出解析失败：' + (e?.message ?? e)) }

const includeCrew = has('include-crew')
/**
 * 收窄范围（`--scope code|all`，默认 **code**）—— 这是照着「新问题」稿 B 条那套判据做的：
 * **风险在"生产代码被无收据地改掉"，不在"大脑写了文档"**（文档/断点/审计流水本来就是它写的）。
 * 不这么收窄的话，`HANDOFF.md`／`TASKS.md`／`AUDIT.md` 每一轮都会红一次 ⇒ 信号被噪音淹掉（等于没有）。
 * 注意：这是"默认口径"，不是"不许看" —— `--scope all` 就全报。
 */
const SCOPE = String(opt('scope', 'code'))
const CODE_EXT = new Set(['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'go', 'rs', 'java', 'kt', 'kts', 'swift', 'c', 'cc', 'cpp', 'h', 'hpp', 'cs', 'rb', 'php', 'sh', 'ps1', 'cmd', 'bat', 'sql', 'proto', 'json', 'yaml', 'yml', 'toml', 'ini', 'env', 'gradle', 'properties', 'xml', 'html', 'css', 'scss', 'less', 'vue', 'svelte', 'dart', 'mm', 'pl', 'lua'])
/** 工具自己写的、不是"班组交付物"的东西（**有理由的默认项**，都写在输出里，不偷偷排除）。 */
const NOISE_DIRS = [/^\.obsidian\//i, /^\.vscode\//i, /^\.idea\//i, /^\.git\//i]
const NOISE_FILES = [/\.log$/i, /\.tsbuildinfo$/i, /\.db(-shm|-wal)?$/i, /^AUDIT\.md$/i]
function isNoise (rel) {
  const r = String(rel).replace(/\\/g, '/')
  return NOISE_DIRS.some((re) => re.test(r)) || NOISE_FILES.some((re) => re.test(r))
}
const touched = (scan.files ?? []).filter((f) => {
  const rel = String(f.rel).replace(/\\/g, '/')
  if (!includeCrew && /^_crew\//i.test(rel)) return false        // 编排自己的记账与日志：不是班组交付物
  if (isNoise(rel)) return false                                 // 编辑器配置 / 日志 / 编译缓存 / 审计流水
  if (SCOPE === 'code') {
    const ext = (rel.split('.').pop() ?? '').toLowerCase()
    if (!CODE_EXT.has(ext)) return false                         // 文档一类不算（大脑本来就有权直接写）
  }
  return Number(f.mtime) >= windowAt
})

const unclaimed = touched.filter((f) => {
  const n = norm(f.rel)
  return !covered.has(n) && !declaredOutOfScope.has(n)
})
const unclaimedOpen = unclaimed.filter((f) => !exempt.has(norm(f.rel)))
const unclaimedExempt = unclaimed.filter((f) => exempt.has(norm(f.rel)))

// ── ⑤ 结论
const state = unclaimedOpen.length ? 'red' : (unclaimedExempt.length ? 'yellow' : 'green')
const head = unclaimed.length
  ? `⚠️ 无收据改动 ${unclaimed.length} 个` + (unclaimedOpen.length ? `（其中**未豁免 ${unclaimedOpen.length}**）` : '（**全部已豁免**）')
  : '✅ 无收据改动 0 个'
/** 本地时间（**别拿 `toISOString()` 给人看** —— 那是 UTC，比我们早 8 小时，会让人把"今天下午"看成"今天上午"）。 */
const localZh = (ms) => {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}
const out = {
  ok: state === 'green', state, kind: 'no-receipt-changes',
  at: new Date().toISOString(),
  project: PROJECT,
  scope: SCOPE,
  window: { from: new Date(windowAt).toISOString(), fromLocal: localZh(windowAt), why: windowWhy, noReceipts: NO_RECEIPTS, runs: runsSeen },
  counts: {
    touchedSinceWindow: touched.length,
    coveredByReceipts: covered.size,
    declaredOutOfScope: declaredOutOfScope.size,
    claimedByDiff: claimedByDiff.length,
    exempt: unclaimedExempt.length,
    unclaimed: unclaimed.length,
    unclaimedOpen: unclaimedOpen.length,
    scanned: scan.scannedFiles, hashCompared: Boolean(scan.hashed)
  },
  files: unclaimedOpen.map((f) => ({ path: f.rel, mtime: new Date(f.mtime).toISOString(), mtimeLocal: localZh(f.mtime), size: f.size })),
  exemptFiles: unclaimedExempt.map((f) => ({ path: f.rel, why: exempt.get(norm(f.rel))?.why ?? null })),
  missingDiffs,
  note: (NO_RECEIPTS ? '⚠️ 本项目**一轮收据都没有** ⇒ 窗口取兜底值（--fallback-hours），下面这些文件没有任何一轮收据能覆盖它们。' : '')
    + `判据：窗口期内被动过、却没有任何一轮收据/指纹覆盖的文件。scope=${SCOPE}（code＝只看代码/配置；all＝全看）；已排除 _crew\\（unless --include-crew）＋ 编辑器配置(.obsidian/.vscode/.idea)＋ *.log ＋ *.tsbuildinfo ＋ *.db* ＋ AUDIT.md；**只看不改**。`
}
if (AS_JSON) { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); process.exit(state === 'green' ? 0 : (state === 'yellow' ? 2 : 3)) }

log(head)
if (NO_RECEIPTS) log('  ⛔ 本项目**一轮收据都没有**（`_crew\\runs` 不存在或为空）—— 有活干过却没有轮次，这本身就是最强的"无收据"信号')
log(`  窗口：${out.window.fromLocal}（本地）起（${windowWhy}）`)
log(`  扫描：${scan.scannedFiles} 个文件（${scan.hashed ? '逐字节' : 'size+mtime'}）· 窗口内动过 ${touched.length} 个（scope=${SCOPE}）· 收据覆盖 ${covered.size} 个 · 已登记越界 ${declaredOutOfScope.size} 个${unclaimedExempt.length ? ` · 已豁免 ${unclaimedExempt.length} 个` : ''}${claimedByDiff.length ? ` · 窗口内 diff 额外认领 ${claimedByDiff.length} 份` : ''}`)
if (unclaimedOpen.length) for (const f of unclaimedOpen.slice(0, 5)) log(`    ⛔ ${f.rel}　${localZh(f.mtime)}`)
if (unclaimedOpen.length > 5) log(`    …（还有 ${unclaimedOpen.length - 5} 个）`)
if (unclaimedExempt.length) for (const f of unclaimedExempt.slice(0, 5)) log(`    ⚠️（已豁免）${f.rel}　原因：${exempt.get(norm(f.rel))?.why ?? '?'}`)
if (missingDiffs.length) log(`    ⚠️ 有 ${missingDiffs.length} 个任务的指纹 diff 读不到（收据声称跑过、指纹不在）：${missingDiffs.slice(0, 5).join('、')} —— 这部分**覆盖不全**，别当"已覆盖"`)
log(`  ⚠️ 口径：scope=${SCOPE}${SCOPE === 'code' ? '（只算代码/配置；文档类不算——大脑本来就有权直接写）' : '（全算，文档也会报）'}；已排除 \`_crew\\\`、编辑器配置、日志、编译缓存、AUDIT.md`)
process.exit(state === 'green' ? 0 : (state === 'yellow' ? 2 : 3))
