#!/usr/bin/env node
/**
 * 长命资源巡检 —— **跑一次就退**的小工具（轻分离 · 2026-10-16 b91）
 *
 * ## 它为什么存在（一句话）
 * 原来"核长命资源"这件事写在 `进度看护.mjs` 里：**看护每 5 分钟巡一趟楼，每趟还要打一次电话**
 * （起一个 PowerShell 去问"本机哪些端口在听"）—— 实测那一趟 0.73 秒里 **0.72 秒都是这个电话**。
 * 现在把这件慢活摘出来：**谁动服务谁叫它一次（当场准）＋ 看护每 30 分钟兜底叫一次（防漂移）**。
 * ⇒ 看护那趟回到"纯读文件"（几毫秒），而"发现卡死 / 叫醒大脑"**一点不变**。
 *
 * ## 铁律（三条）
 * 1. **它是 `_crew\长命资源状态.json` 的唯一写方**。别人（看护/看板/体检/面板）**只读**。
 *    为什么：同一个事实只许有一个说法（本项目栽过"两处各写一份"很多次）。
 * 2. **跑一次就退**：它**不是**常驻进程、**不登记**进登记册（登记册只管"该活着的长命资源"）。
 * 3. **判据不在这儿**：结论由 `登记服务.mjs` 的 `verify()` 给（pid 活性 ＋ 端口属主 ＋ 孤儿），
 *    本文件只负责"什么时候去问、把答案落在哪张纸上"。
 *
 * ## 用法
 *   node 长命资源巡检.mjs                     # 需要就真核（默认：状态文件超过 30 分钟才真核）
 *   node 长命资源巡检.mjs --force             # 不管新旧，立刻真核（起/停服务后的"谁动谁叫"用这个）
 *   node 长命资源巡检.mjs --if-stale 600      # 换一个"多久算旧"（秒）；0 ＝ 永远真核
 *   node 长命资源巡检.mjs --by 看护兜底        # 在状态文件里记下"这次是谁叫的"
 *   node 长命资源巡检.mjs --json              # 机器可读（多一行 JSON）
 *   node 长命资源巡检.mjs --no-write          # 只读：不落盘（纯查询用）
 *   退出码：0=绿 / 2=黄 / 3=红（与 `登记服务.mjs verify` 同口径，可当闸用）｜ 1=用法或环境错
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { verify, verdictZh } from './登记服务.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WS = resolve(HERE, '..')
const CREW = join(WS, '_crew')
const FILE = join(CREW, '长命资源状态.json')
/**
 * 那张纸在哪 —— 默认 `_crew\长命资源状态.json`；`DSH_LONGLIVE_STATUS_FILE` 可覆盖（**探针专用**，
 * 免得验收要动真文件；与 `登记服务.mjs` 的 `DSH_SERVICE_REG` 同一套路）。
 */
export const statusFile = () => process.env.DSH_LONGLIVE_STATUS_FILE || FILE
/** 状态文件多久算旧（秒）。默认 30 分钟 —— "谁动谁叫"负责当场准，这个只管兜底防漂移。 */
export const STALE_SEC_DEFAULT = 1800

const nowIso = () => new Date().toISOString()

/** 读状态文件（**只读**；读不到/坏了返回 null，绝不猜）。 */
export function readStatus () {
  try { return JSON.parse(readFileSync(statusFile(), 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

/** 这条结论是几分钟前的（没有 at 就返回 null —— 不编数字）。 */
export function statusAgeMin (st) {
  const t = Date.parse(st?.at ?? '')
  if (!Number.isFinite(t)) return null
  return Math.round(((Date.now() - t) / 60000) * 10) / 10
}

/**
 * 真核一次并落盘（**唯一写方**）。返回写进去的那个对象。
 * ⚠️ 调用方要 fail-soft：核不出来**不能**影响调用方的主业（看护/面板/确保脚本都不许被它拖垮）。
 */
export function refreshStatus ({ by = '手动', extra = null } = {}) {
  const t0 = Date.now()
  const v = verify()
  const st = {
    schema: 1, kind: 'longlive-status',
    at: nowIso(),
    // ★ 2026-10-26（§零.6 统一信封）：补 `source`/`stale` —— 缺了它们看板只能判 unknown（这次判对了）
    source: '长命资源巡检.mjs',
    stale: false,
    state: v.state,
    verdict: verdictZh(v),
    counts: v.counts,
    items: v.items,
    orphans: v.orphans ?? [],
    dead: (v.dead ?? []).map((d) => ({ name: d.name, why: d.why })),
    mismatch: (v.mismatch ?? []).map((m) => ({ name: m.name, why: m.why })),
    registry: v.registry,
    checkedBy: by,
    tookMs: Date.now() - t0,
    note: '唯一写方 = 长命资源巡检.mjs；判据 = 登记服务.mjs 的 verify()（pid 活性 ＋ 端口属主 ＋ 孤儿）'
  }
  if (extra) st.extra = extra
  try { mkdirSync(CREW, { recursive: true }); writeFileSync(statusFile(), JSON.stringify(st, null, 2) + '\n', 'utf8') }
  catch (e) { st.writeError = String(e?.message ?? e) }
  return st
}

/** 需要就刷新：状态文件够新就直接用它（省掉那个 0.72 秒的电话）。 */
export function ensureFresh ({ ifStaleSec = STALE_SEC_DEFAULT, by = '调用方' } = {}) {
  const cur = readStatus()
  const age = statusAgeMin(cur)
  if (cur && age != null && age * 60 < ifStaleSec) return { ...cur, cached: true, ageMin: age }
  const st = refreshStatus({ by })
  return { ...st, cached: false, ageMin: 0 }
}

/**
 * ★ "谁动谁叫"那声叫 —— 实现在 `_叫巡检.mjs`（独立小文件，避免与 `登记服务.mjs` 互相 import 成环）。
 * 这里**再导出一次**只是方便："巡检"和"叫巡检"本来就是一件事的两头。
 */
export { pokeInspection } from './_叫巡检.mjs'

// ─────────────────────────────── CLI ───────────────────────────────
const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  const argv = process.argv.slice(2)
  const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
  const has = (n) => argv.includes('--' + n)
  const AS_JSON = has('json')
  const QUIET = has('quiet')
  const FORCE = has('force')
  const NO_WRITE = has('no-write')
  const ifStale = FORCE ? 0 : Number(opt('if-stale', STALE_SEC_DEFAULT))
  const by = String(opt('by', '手动'))
  const log = (s) => { if (!QUIET && !AS_JSON) console.log(s) }

  let out = null
  try {
    if (NO_WRITE) {
      const cur = readStatus()
      out = cur ? { ...cur, cached: true, ageMin: statusAgeMin(cur) } : { schema: 1, kind: 'longlive-status', at: nowIso(), state: 'unknown', verdict: '（还没核过：状态文件不存在，且 --no-write 不许真核）', counts: {}, items: [], orphans: [], dead: [], mismatch: [], checkedBy: by }
    } else {
      out = ensureFresh({ ifStaleSec: ifStale, by })
    }
  } catch (e) {
    if (AS_JSON) process.stdout.write(JSON.stringify({ ok: false, error: String(e?.message ?? e) }) + '\n')
    else console.error('❌ 巡检失败：' + String(e?.message ?? e))
    process.exit(1)
  }

  const age = out.ageMin != null ? out.ageMin : statusAgeMin(out)
  if (AS_JSON) process.stdout.write(JSON.stringify(out) + '\n')
  else {
    log(`【长命资源】${String(out.state).toUpperCase()}　${out.verdict}`)
    log(`  ${out.cached ? `沿用 ${age} 分钟前的核对` : `刚刚真核（${out.tookMs ?? '?'}ms）`}｜叫它的人：${out.checkedBy ?? '?'}｜状态文件：${FILE}`)
  }
  process.exit(out.state === 'green' ? 0 : (out.state === 'yellow' ? 2 : 3))
}
