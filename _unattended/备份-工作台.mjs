#!/usr/bin/env node
/**
 * 工作台自动备份 —— 防「桌面端安装器把安装目录整体改名后删除」这类灭顶事故。
 *
 * 背景（2026-10-17 实测）：electron-builder 的安装器对已存在的安装目录是
 *   `改名 .old-{GUID} → 装新版 → 删旧树`。
 *   而工作台一直住在 `<工作台根>` 里 ⇒ 点一次更新，工作台+配置全没。
 *   当时的事故就是这么丢的（见 进度.md 2026-10-17 那段）。
 *
 * 做法（用户 2026-10-18 拍板的口径）：
 *   · 只备**资产**：`_unattended`（脚本+面板+桥）、`_crew`（配置/台账）、`文档`；
 *   · 不备**可再生/会膨胀**的：`_probe`(34MB)、`workspaces`、`logs`、`runs`、`history-from-E`、`node_modules`；
 *   · 每小时一次**增量镜像**到 `<备份根>\latest`（30~35MB 封顶）；
 *   · 每天一次 **zip 快照**（约 8~10MB），留 7 份 ⇒ 稳态 ~100MB；
 *   · 超限保护：备份根目录一旦 > 500MB 就删最旧快照并在日志里明说（绝不静默）。
 *
 * 用法：
 *   node 备份-工作台.mjs            # 立刻备份（镜像 + 当天快照）
 *   node 备份-工作台.mjs --if-due   # 距上次 ≥1 小时才做（给看护循环每 5 分钟调）
 *   node 备份-工作台.mjs --json     # 机器可读（给看板/检查用）
 * 退出码：0 = 备份完成或本来就不需要；1 = 备份失败（读不到源/写不进目标）
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BACKUP_ROOT, need } from './_路径.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WS = resolve(HERE, '..')
const STATE = join(WS, '_crew', '备份状态.json')
const LOGDIR = join(HERE, 'logs')
const LOG = join(LOGDIR, '备份.log')
const ROOT = process.env.DSH_BACKUP_ROOT ?? need('备份落点', BACKUP_ROOT, '去 config\\本机映射.json 填「备份根」')
const LATEST = join(ROOT, 'latest')
const DAILY = join(ROOT, 'daily')
const KEEP = Number(process.env.DSH_BACKUP_KEEP ?? 7)
const MAX_TOTAL_MB = Number(process.env.DSH_BACKUP_MAX_MB ?? 500)
const DUE_SEC = Number(process.env.DSH_BACKUP_DUE_SEC ?? 3600)

const argv = process.argv.slice(2)
const IF_DUE = argv.includes('--if-due')
const AS_JSON = argv.includes('--json')

/** 要备的顶层目录（相对工作台根）。 */
const INCLUDE = ['_unattended', '_crew', '文档']
/** 这些子目录/名字在其中出现就跳过（robocopy 的 /XD 用绝对路径）。 */
const EXCLUDE_DIRS = ['logs', 'runs', 'history-from-E', 'node_modules', '__pycache__', '.git']

function log (s) {
  const line = `[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${s}`
  try { mkdirSync(LOGDIR, { recursive: true }); writeFileSync(LOG, line + '\n', { flag: 'a' }) } catch {}
  if (!AS_JSON) console.log(line)
}

function readState () {
  try { return JSON.parse(readFileSync(STATE, 'utf8')) } catch { return null }
}

function dirSizeMB (p) {
  // 直接走文件系统统计，别去解析 robocopy 的摘要（/BYTES 的输出格式不稳，实测解析成 0）。
  let bytes = 0
  const walk = (dir) => {
    let ents = []
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of ents) {
      const q = join(dir, e.name)
      if (e.isDirectory()) walk(q)
      else { try { bytes += statSync(q).size } catch {} }
    }
  }
  walk(p)
  return bytes
}

function robocopyMirror (src, dst) {
  try { mkdirSync(dst, { recursive: true }) } catch (e) { throw new Error(`建不了目标目录 ${dst}: ${e.message}`) }
  const args = [src, dst, '/MIR', '/R:1', '/W:1', '/NFL', '/NDL', '/NJH', '/NP', '/BYTES', '/XJ']
  for (const d of EXCLUDE_DIRS) args.push('/XD', join(src, d))
  const r = spawnSync('robocopy', args, { encoding: 'utf8', windowsHide: true, timeout: 20 * 60_000, maxBuffer: 32 << 20 })
  if (r.error) throw new Error(`robocopy 起不来: ${r.error.message}`)
  if (r.status === null || r.status >= 8) throw new Error(`robocopy 退出码 ${r.status}：${(r.stdout ?? '').slice(-300)}`)
  return r.stdout ?? ''
}

function main () {
  const prev = readState()
  const now = Date.now()
  if (IF_DUE && prev?.at) {
    const ageSec = (now - Date.parse(prev.at)) / 1000
    if (Number.isFinite(ageSec) && ageSec < DUE_SEC) {
      if (AS_JSON) console.log(JSON.stringify({ ok: true, skipped: true, ageSec: Math.round(ageSec) }))
      return 0
    }
  }

  if (!existsSync(join(WS, '_unattended'))) {
    log(`❌ 源不对：${join(WS, '_unattended')} 不存在`)
    return 1
  }

  let files = 0; let bytes = 0
  try { mkdirSync(ROOT, { recursive: true }) } catch (e) { log(`❌ 建不了备份根 ${ROOT}: ${e.message}`); return 1 }

  for (const rel of INCLUDE) {
    const src = join(WS, rel)
    if (!existsSync(src)) { log(`⚠️ 跳过（不存在）：${rel}`); continue }
    try {
      robocopyMirror(src, join(LATEST, rel))
      bytes += dirSizeMB(src)
      const cnt = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-ChildItem -LiteralPath '${src}' -Recurse -File -Force -ErrorAction SilentlyContinue).Count`], { encoding: 'utf8', windowsHide: true, timeout: 60_000 }).stdout
      files += Number(String(cnt).trim()) || 0
    } catch (e) {
      log(`❌ 镜像失败 ${rel}: ${String(e.message).slice(0, 200)}`)
      return 1
    }
  }

  const mb = Math.round(bytes / 1048576 * 10) / 10
  log(`镜像完成：${files} 个文件 / ${mb} MB → ${LATEST}`)
  if (mb > 200) log(`⚠️ 本次备份 ${mb} MB（>200MB）—— 看看是不是有人往 _unattended/_crew 塞了大文件`)

  // 当天快照（每天一次）
  let dailyPath = null
  try {
    mkdirSync(DAILY, { recursive: true })
    const stamp = new Date().toISOString().slice(0, 10)
    dailyPath = join(DAILY, `工作台-${stamp}.zip`)
    if (!existsSync(dailyPath)) {
      const ps = `Compress-Archive -Path '${LATEST}\\*' -DestinationPath '${dailyPath}' -Force`
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true, timeout: 20 * 60_000 })
      log(`当天快照：${dailyPath}（${Math.round(statSync(dailyPath).size / 1048576 * 10) / 10} MB）`)
    }
  } catch (e) {
    log(`⚠️ 当天快照失败（不影响镜像）：${String(e.message).slice(0, 200)}`)
  }

  // 保留 N 份 + 总量护栏
  let zips = []
  try { zips = readdirSync(DAILY).filter(f => f.endsWith('.zip')).sort() } catch {}
  while (zips.length > KEEP) {
    const old = zips.shift()
    try { unlinkSync(join(DAILY, old)); log(`删旧快照（超过 ${KEEP} 份）：${old}`) } catch {}
  }
  let totalMB = Math.round(dirSizeMB(ROOT) / 1048576 * 10) / 10
  if (totalMB > MAX_TOTAL_MB) {
    log(`⚠️ 备份根已 ${totalMB} MB > ${MAX_TOTAL_MB} MB，按最旧开始删快照`)
    while (totalMB > MAX_TOTAL_MB && zips.length > 1) {
      const old = zips.shift()
      try { unlinkSync(join(DAILY, old)); log(`超限删除：${old}`) } catch {}
      totalMB = Math.round(dirSizeMB(ROOT) / 1048576 * 10) / 10
    }
  }

  const state = {
    at: new Date().toISOString(),
    ok: true,
    source: WS,
    target: LATEST,
    files,
    mb,
    daily: dailyPath,
    dailyCount: zips.length,
    totalMB,
    keep: KEEP
  }
  try { writeFileSync(STATE, JSON.stringify(state, null, 2), 'utf8') } catch {}
  log(`完成：latest=${mb}MB，快照 ${zips.length}/${KEEP} 份，备份根共 ${totalMB}MB`)
  if (AS_JSON) console.log(JSON.stringify(state))
  return 0
}

try { process.exit(main()) } catch (e) { log(`❌ 未捕获异常：${String(e?.stack ?? e).slice(0, 500)}`); process.exit(1) }
