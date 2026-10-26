#!/usr/bin/env node
/**
 * 保留清理 —— 施工文档 §12.9 的落地：**样本长期留，信封滚动删**。
 *
 * 铁律：**删信封之前，先确认那一轮的样本已经入库**（删证据不删结论）。
 *   · 某一轮在库里一条都没有 ⇒ **跳过**（说明它还没被采样，删了就永远补不回来）。
 *   · 库是空的 ⇒ **直接拒跑**（这种情况下去删信封＝烧掉全部原始证据）。
 *
 * 删什么 / 留什么（默认 `--dry-run`，只报告不删）：
 *   · 信封：`runs\<轮>\tasks\*.out.json` 与 `*.prompt.txt` —— 大件（实测 1.7 MB/卡），**按项目保留最近 `--keep-rounds` 轮**（默认 20）
 *   · **永不删**：`verdict.json`、`*.dispatch.json`、`_crew\样本\`、`TASKS.md`、指纹（另按 30 天）
 *   · 指纹 / 备份：超过 `--keep-days` 天（默认 30）
 *   · 调参建议：只留最近 `--keep-advice` 份（默认 20）
 *
 * 用法：
 *   node 保留清理.mjs [--dry-run] [--apply] [--json] [--keep-rounds 20] [--keep-days 30] [--keep-advice 20]
 * 退出码：0 正常 / 1 有跳过项 / 2 被安全闸拒绝
 */
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { discoverProjects, readAll } from './样本库.mjs'

const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? d) : d }
const has = (n) => argv.includes('--' + n)
const num = (n, d) => { const v = Number(opt(n, d)); return Number.isFinite(v) && v > 0 ? v : d }

const APPLY = has('apply')
const DRY = !APPLY
const KEEP_ROUNDS = num('keep-rounds', 20)
const KEEP_DAYS = num('keep-days', 30)
const KEEP_ADVICE = num('keep-advice', 20)
const asJson = has('json')

const norm = (s) => String(s ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
const mb = (b) => Math.round((b / 1024 / 1024) * 10) / 10

const lib = readAll()
if (!lib.length) {
  console.error('⛔ 拒跑：样本库是空的 —— 这时候删信封＝烧掉全部原始证据。先跑 `样本库.mjs ingest --all`。')
  process.exit(2)
}
// (项目路径规范化, 轮) → 库里有没有这一轮的样本
const have = new Set(lib.map((s) => `${norm(s.path)}|${s.run}`))

const old = Date.now() - KEEP_DAYS * 24 * 3600 * 1000
const report = []

function sizeOf (files) { let b = 0; for (const f of files) { try { b += statSync(f).size } catch {} } return b }

for (const project of discoverProjects()) {
  const runsDir = join(project, '_crew', 'runs')
  const rounds = existsSync(runsDir)
    ? readdirSync(runsDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
    : []
  const cut = Math.max(0, rounds.length - KEEP_ROUNDS)
  const envelopeFiles = []
  const skipped = []
  for (let i = 0; i < cut; i++) {
    const run = rounds[i]
    // 铁律：**没入库的轮次不许删** —— 删了就永远补不回来。
    // 例外：这一轮压根没有 results（空轮/失败轮），没有任何"卡"可采样 ⇒ 删信封是安全的。
    if (!have.has(`${norm(project)}|${run}`)) {
      let empty = false
      try { const v = JSON.parse(readFileSync(join(runsDir, run, 'verdict.json'), 'utf8').replace(/^\uFEFF/, '')); empty = !Array.isArray(v?.results) || v.results.length === 0 } catch { empty = true }
      if (!empty) { skipped.push(run); continue }
    }
    const tasksDir = join(runsDir, run, 'tasks')
    if (!existsSync(tasksDir)) continue
    for (const f of readdirSync(tasksDir)) {
      if (/\.(out\.json|prompt\.txt)$/i.test(f)) envelopeFiles.push(join(tasksDir, f))
    }
  }
  // 指纹：超过 N 天
  const fpDir = join(project, '_crew', 'fingerprints')
  const fpOld = []
  if (existsSync(fpDir)) {
    for (const f of readdirSync(fpDir)) {
      const p = join(fpDir, f)
      try { if (statSync(p).mtimeMs < old) fpOld.push(p) } catch {}
    }
  }
  // 建议：只留最近 N 份（json＋md 成对）
  const tuneDir = join(project, '_crew', '调参')
  const advOld = []
  if (existsSync(tuneDir)) {
    const adv = readdirSync(tuneDir).filter(f => /^建议-.*\.(json|md)$/.test(f)).sort()
    const keepStamps = new Set(adv.filter(f => f.endsWith('.json')).slice(-KEEP_ADVICE).map(f => f.replace(/\.json$/, '')))
    for (const f of adv) if (!keepStamps.has(f.replace(/\.(json|md)$/, ''))) advOld.push(join(tuneDir, f))
  }
  const free = sizeOf(envelopeFiles) + sizeOf(fpOld) + sizeOf(advOld)
  if (!free && !skipped.length) continue
  report.push({
    project: basename(project), path: project,
    rounds: rounds.length, keepRounds: KEEP_ROUNDS, dropRounds: cut - skipped.length, skippedRounds: skipped.length,
    envelopes: envelopeFiles.length, fingerprints: fpOld.length, advice: advOld.length,
    freeMB: mb(free), skippedSample: skipped.slice(0, 3)
  })
  if (APPLY) {
    for (const f of envelopeFiles) { try { rmSync(f, { force: true }) } catch {} }
    for (const f of fpOld) { try { rmSync(f, { force: true }) } catch {} }
    for (const f of advOld) { try { rmSync(f, { force: true }) } catch {} }
  }
}

const totalFree = report.reduce((a, b) => a + b.freeMB, 0)
const totalSkip = report.reduce((a, b) => a + (b.skippedRounds ?? 0), 0)
if (asJson) {
  console.log(JSON.stringify({ ok: true, dryRun: DRY, keep: { rounds: KEEP_ROUNDS, days: KEEP_DAYS, advice: KEEP_ADVICE }, totalFreeMB: totalFree, skippedRounds: totalSkip, report }, null, 2))
  process.exit(totalSkip ? 1 : 0)
}
console.log(`🧹 保留清理${DRY ? '（**dry-run**，没删任何东西；要真删加 --apply）' : '（**已执行删除**）'}`)
console.log(`   规矩：信封保留最近 ${KEEP_ROUNDS} 轮 · 指纹 ${KEEP_DAYS} 天 · 建议留 ${KEEP_ADVICE} 份 · **没入库的轮次一律跳过**`)
for (const r of report) {
  console.log(`   ${r.project}：${r.rounds} 轮 → 删 ${r.dropRounds} 轮的信封（${r.envelopes} 个文件）· 指纹 ${r.fingerprints} · 建议 ${r.advice}　可释放 ${r.freeMB} MB${r.skippedRounds ? `　⚠️ 跳过 ${r.skippedRounds} 轮（未入库：${r.skippedSample.join('、')}…）` : ''}`)
}
console.log(`   合计可释放 **${Math.round(totalFree)} MB**${totalSkip ? `　⚠️ 有 ${totalSkip} 轮因"未入库"被跳过` : ''}`)
process.exit(totalSkip ? 1 : 0)
