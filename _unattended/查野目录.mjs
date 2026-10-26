#!/usr/bin/env node
/**
 * 查野目录 —— 抓「Obsidian vault 路径写重了一层」留下的嵌套树（★ 2026-10-19 b188）。
 *
 * 背景：obsidian_* 工具的相对路径根＝vaultPath（本机 = <知识库>），
 * 但它的父目录**也叫"知识库"** ⇒ 顺手写成 `知识库/AI知识库/x.md` 时，插件里三处
 * `mkdir(..., {recursive:true})` 会把缺的目录**静默建出来** ⇒ 内容落进嵌套树，没人发现。
 * 同一个坑 2026-10-18 与 10-19 各踩一次（前者残留见 `_crew\backup\stray-AI知识库-20261018-012445`）。
 *
 * 判据（跟 `打obsidian路径护栏.mjs` 的运行时护栏同一套）：
 *   vault 内某个目录的相对路径满足 —— 首段 === vault 目录名，或（首段 === 父目录名 且 次段 === vault 目录名）
 *
 * 用法：
 *   node 查野目录.mjs              # 报告（发现即 exit 2）
 *   node 查野目录.mjs --quarantine # 报告 + 移到 _crew\backup\stray-<名>-<时间戳>
 *   node 查野目录.mjs --json
 * · vault 根自动从 %APPDATA%\obsidian\obsidian.json 里"当前打开"的库读（可用 DSH_VAULT 覆盖）
 * 零 token、只读（除非 --quarantine）。
 */
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'
import { WORKSPACE } from './_路径.mjs'

const BACKUP_ROOT = process.env.DSH_BACKUP ?? (WORKSPACE ? join(WORKSPACE, '_crew', 'backup') : null)
const QUARANTINE = process.argv.includes('--quarantine')
const AS_JSON = process.argv.includes('--json')

function vaultFromAppConfig () {
  const p = join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'obsidian', 'obsidian.json')
  if (!existsSync(p)) return null
  try {
    const cfg = JSON.parse(readFileSync(p, 'utf8'))
    const list = Object.values(cfg.vaults ?? {})
    return (list.find(v => v.open) ?? list[0])?.path ?? null
  } catch { return null }
}

const VAULT = process.env.DSH_VAULT ?? vaultFromAppConfig()
if (!VAULT || !existsSync(VAULT)) {
  if (AS_JSON) console.log(JSON.stringify({ ok: true, skipped: 'no-vault' }))
  else console.log('（找不到 vault，跳过）')
  process.exit(0)
}
const VAULT_NAME = basename(VAULT)
const PARENT_NAME = basename(dirname(VAULT))
const SKIP = new Set(['.obsidian', '.trash', '.git', 'node_modules'])

function walk (dir, depth, out) {
  if (depth > 3) return out
  let ents = []
  try { ents = readdirSync(dir) } catch { return out }
  for (const e of ents) {
    if (SKIP.has(e)) continue
    const p = join(dir, e)
    let st; try { st = statSync(p) } catch { continue }
    if (!st.isDirectory()) continue
    const segs = relative(VAULT, p).split(/[\\/]/).filter(Boolean)
    const hit = segs[0] === VAULT_NAME || (segs[0] === PARENT_NAME && (segs.length === 1 || segs[1] === VAULT_NAME))
    let files = 0
    try { files = countFiles(p, 0) } catch {}
    out.push({ path: p, rel: segs.join('/'), hit, files, mtime: st.mtime.toISOString() })
    walk(p, depth + 1, out)
  }
  return out
}
function countFiles (dir, n) {
  if (n > 6) return 0
  let c = 0
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    try { statSync(p).isDirectory() ? (c += countFiles(p, n + 1)) : c++ } catch {}
  }
  return c
}

const all = walk(VAULT, 1, [])
const bad = all.filter(d => d.hit)

if (QUARANTINE && bad.length) {
  const ts = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
  for (const d of bad) {
    const dest = join(BACKUP_ROOT, `stray-${d.rel.replace(/[\\/]/g, '-')}-${ts}`)
    try { mkdirSync(dirname(dest), { recursive: true }); renameSync(d.path, dest); d.moved = dest } catch (e) { d.moveErr = String(e.message) }
  }
}

if (AS_JSON) console.log(JSON.stringify({ ok: bad.length === 0, vault: VAULT, vaultName: VAULT_NAME, parentName: PARENT_NAME, dirs: all.length, suspicious: bad }, null, 1))
else {
  console.log(`vault=${VAULT}`)
  console.log(`判据=首段为 "${VAULT_NAME}" 或 "${PARENT_NAME}/${VAULT_NAME}"（vault 内共 ${all.length} 个目录，深度≤3）`)
  if (!bad.length) console.log('✅ 没有野目录')
  else {
    console.log(`❌ 发现 ${bad.length} 个疑似野目录：`)
    for (const d of bad) console.log(`   - ${d.rel}   文件 ${d.files} 个   mtime ${d.mtime.slice(0, 16)}` + (d.moved ? `   → 已移到 ${d.moved}` : d.moveErr ? `   ⚠️ 移动失败 ${d.moveErr}` : ''))
    if (!QUARANTINE) console.log('   （加 --quarantine 可移到 _crew\\backup）')
  }
}
process.exit(bad.length ? 2 : 0)
