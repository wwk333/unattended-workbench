#!/usr/bin/env node
/**
 * 样本补扫 —— 把"还没进样本库"的轮次补进去（施工文档 §12.8）。
 *
 * 为什么要单独一支：入库的正常时机是**编排收尾**；但有两种情况会漏 ——
 *   ① 编排跑完、收尾前崩了（或被强杀）；② 那一轮跑在旧版本上（当时还没有入库这一步）。
 * 本脚本幂等：扫所有能找到的项目，按 `proj+run+task` 去重，重复跑不会写重。
 *
 * 用法：
 *   node 样本补扫.mjs [--dry-run] [--json]
 * 退出码：0＝扫完了 / 1＝有项目入库失败（其余继续）
 */
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverProjects, ingestProject, stats } from './样本库.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const dry = argv.includes('--dry-run')
const asJson = argv.includes('--json')

const projects = discoverProjects()
const res = []
let bad = 0
for (const p of projects) {
  try { res.push(ingestProject(p, { dryRun: dry })) } catch (e) { bad++; res.push({ project: p, added: 0, error: String(e?.message ?? e).slice(0, 160) }) }
}
const s = stats()
if (asJson) {
  console.log(JSON.stringify({ ok: bad === 0, dryRun: dry, projects: res, stats: s }, null, 2))
  process.exit(bad ? 1 : 0)
}
console.log(`🔁 样本补扫${dry ? '（dry-run，不写盘）' : ''}：扫了 ${projects.length} 个项目`)
for (const r of res) {
  if (r.error) console.log(`   ⚠️ ${r.project}　${r.error}`)
  else if (r.added || r.rejected) console.log(`   ${r.project}　新入 ${r.added} · 已在库 ${r.skipped} · 拒收 ${r.rejected}`)
}
console.log(`📦 库现况：${s.total} 条（可统计 ${s.countable} · 删失 ${s.censored} · 拒收记录 ${s.rejects}）`)
process.exit(bad ? 1 : 0)
