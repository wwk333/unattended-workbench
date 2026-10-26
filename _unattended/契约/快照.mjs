/**
 * 契约/快照 —— **全系统唯一的 snapshotId**（施工文档 §零.1）
 *
 * 一句话：门禁、审核报告机器块、run/done 收据、release-status、入口 E2E 证据，
 * 五处必须写**同一个** `snapshotId`，由这一个文件算出来。谁都不许自己再算一份。
 *
 * 为什么（真事）：以前门禁写 `stamp`、审核写自己的 `gateStamp`、HANDOFF 手写"已交付" ——
 * 同一份代码在审核后又被改过，旧审核照样被引用，因为**没有任何一处能机器回答"这是不是同一份代码"**。
 *
 * 口径（照 §一「唯一出处」）：
 *   · 快照范围由项目 `gate.json` 的 `snapshot` 段**唯一声明**：
 *       { "snapshot": { "include": ["src/**", "tests/**", "package.json"], "exclude": ["docs/**"] } }
 *     不配 `snapshot` 就用默认范围（项目根，排除 `_crew` 与工具链噪音目录）；
 *   · 默认排除：`_crew`、`HANDOFF*`、`AUDIT*`、`TASKS.md` 等**证据与报告**，
 *     以及 `node_modules/.git/dist/...`（与 `_排除清单.mjs` **同一份定义**，不再抄第二份）；
 *   · 每个受管文件取 `sha256` 前 12 位（与门禁 `manifest` 完全同口径）；
 *   · `snapshotId = "sha256:" + sha256(按路径排序的 "path\0hash\n" 拼接)`；
 *   · `manifestHash` 是同一个值去掉 `sha256:` 前缀（给 `gate/history.jsonl` 用）。
 *
 * 旧收据怎么办：§三 明写"旧缺收据只能标 legacy-unknown，不能补造"。
 * 所以 `snapshotIdFromGateResult()` 对没有 `snapshot` 段的旧 `gate-result.json` **返回 null + 原因**，
 * 消费方（交付门）必须据此判 blocked —— 不许拿老 `stamp` 冒充快照。
 */

import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import {
  SKIP_DIRS as NOISE_SKIP_DIRS,
  SKIP_RELS as NOISE_SKIP_RELS,
  SKIP_FILES as NOISE_SKIP_FILES
} from '../_排除清单.mjs'

/** 快照永远不看的项目根级目录：`_crew` 是运行现场（收据/日志/截图/备份），不是代码 */
export const SNAPSHOT_ROOT_SKIP_DIRS = Object.freeze(['_crew'])

/** 快照默认排除的相对路径前缀（文档：排除 _crew、HANDOFF/AUDIT/TASKS 等证据与报告） */
export const SNAPSHOT_DEFAULT_EXCLUDE_RELS = Object.freeze([
  '_crew',
  '_review_out',
  '_qc_evidence',
  'evidence' // 交付证据目录：它是证据，不是被测代码
])

/** 快照默认排除的文件（与 `_排除清单.mjs` 的 SKIP_FILES 合并后生效） */
export const SNAPSHOT_DEFAULT_EXCLUDE_FILES = Object.freeze([
  'HANDOFF.md',
  'AUDIT.md',
  'TASKS.md',
  '待裁决.md',
  '分工表.md',
  // ★ 2026-10-26（§一）：**报告与放行产物本身不是被测代码**。
  //   它们是被"快照"判定的对象，若自己进快照，写一次报告就换一次 snapshotId ⇒
  //   审核一跑完就把自己刚绑定的快照弄失效（自锁死循环）。所以显式排除。
  '审核报告.md',
  'release-status.json',
  'export-manifest.json'
])

const DEFAULT_CAP = 5000
const DEFAULT_BIG = 8 * 1024 * 1024

export class SnapshotError extends Error {
  constructor (why, detail) {
    super(`[快照] ${why}${detail ? `（${detail}）` : ''}`)
    this.name = 'SnapshotError'
    this.code = 'E_SNAPSHOT'
  }
}

/** glob → 正则（只支持 `**` / `*` / `?`，够用了：范围声明不该复杂） */
export function globToRe (glob) {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      re += '.*'
      i++
      if (glob[i + 1] === '/') i++
    } else if (c === '*') re += '[^/]*'
    else if (c === '?') re += '[^/]'
    else if ('\\^$.|+()[]{}'.includes(c)) re += '\\' + c
    else re += c
  }
  return new RegExp('^' + re + '$')
}

function toPosix (p) {
  return String(p).replace(/\\/g, '/')
}

/**
 * 解析快照范围。
 * @param {object} o
 * @param {object|null} o.gate 已解析的 gate.json（可 null）
 * @returns {{ include: string[]|null, exclude: string[], source: string, declared: boolean }}
 */
export function resolveScope ({ gate = null } = {}) {
  const cfg = gate && typeof gate === 'object' ? gate.snapshot : null
  const declared = cfg && typeof cfg === 'object'
  const include = declared && Array.isArray(cfg.include) && cfg.include.length ? cfg.include.map(toPosix) : null
  const extraExclude = declared && Array.isArray(cfg.exclude) ? cfg.exclude.map(toPosix) : []
  return {
    include,
    exclude: [...new Set([...SNAPSHOT_DEFAULT_EXCLUDE_RELS, ...extraExclude])],
    source: declared ? 'gate.json#snapshot' : 'default(§一)',
    declared: Boolean(declared)
  }
}

function isExcluded (rel, scope) {
  const p = toPosix(rel)
  for (const ex of scope.exclude) {
    if (p === ex || p.startsWith(ex.replace(/\/$/, '') + '/')) return true
  }
  if (SNAPSHOT_DEFAULT_EXCLUDE_FILES.some(f => p === f || p.startsWith(f.replace(/\.md$/, '')))) {
    if (SNAPSHOT_DEFAULT_EXCLUDE_FILES.includes(p)) return true
    if (/^HANDOFF/.test(p) || /^AUDIT/.test(p)) return true
  }
  if (NOISE_SKIP_FILES.some(re => re.test(p))) return true
  for (const pre of NOISE_SKIP_RELS) if (p === pre || p.startsWith(pre + '/')) return true
  return false
}

function included (rel, scope) {
  if (!scope.include) return true
  const p = toPosix(rel)
  return scope.include.some(g => globToRe(g).test(p))
}

/**
 * 扫一遍项目，出 manifest。
 * @returns {{ files: Record<string,string>, count: number, degraded: boolean, bigSkipped: number, scope: object }}
 */
export function buildManifest ({ project, scope, cap = DEFAULT_CAP, big = DEFAULT_BIG }) {
  if (!project) throw new SnapshotError('buildManifest 缺 project')
  const files = {}
  let count = 0
  let degraded = false
  let bigSkipped = 0
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    const abs = rel ? join(project, rel) : project
    let entries
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) continue // 不跟随符号链接：跟随会走出项目边界，快照就没有边界了
      if (e.isDirectory()) {
        if (SNAPSHOT_ROOT_SKIP_DIRS.includes(childRel.split('/')[0])) continue
        if (NOISE_SKIP_DIRS.has(e.name)) continue
        if (isExcluded(childRel, scope)) continue
        stack.push(childRel)
        continue
      }
      if (!e.isFile()) continue
      if (isExcluded(childRel, scope)) continue
      if (!included(childRel, scope)) continue
      if (count >= cap) { degraded = true; break }
      let st
      try { st = statSync(join(project, childRel)) } catch { continue }
      if (st.size > big) { bigSkipped++; continue }
      let h
      try { h = createHash('sha256').update(readFileSync(join(project, childRel))).digest('hex') } catch { continue }
      files[childRel] = h.slice(0, 12)
      count++
    }
    if (degraded) break
  }
  return { files, count, degraded, bigSkipped, scope }
}

/**
 * 从 manifest 算**唯一** snapshotId。
 * 排序后拼接，保证"同内容⇒同 id"，与文件系统遍历顺序无关。
 */
export function snapshotIdOfManifest (files) {
  if (!files || typeof files !== 'object') throw new SnapshotError('snapshotIdOfManifest 需要 manifest 对象')
  const keys = Object.keys(files).sort()
  const h = createHash('sha256')
  for (const k of keys) h.update(`${k}\0${files[k]}\n`)
  return h.digest('hex')
}

/** 便利封装：manifest → { snapshotId, manifestHash } */
export function snapshotIdFromManifest (files) {
  const hex = snapshotIdOfManifest(files)
  return { snapshotId: `sha256:${hex}`, manifestHash: hex }
}

/**
 * 算项目**当前**快照（含范围解析）。
 * @returns {{ snapshotId, manifestHash, count, degraded, bigSkipped, scope, at, files }}
 */
export function computeSnapshot ({ project, gate = null, cap, big }) {
  const scope = resolveScope({ gate })
  const m = buildManifest({ project, scope, cap, big })
  const { snapshotId, manifestHash } = snapshotIdFromManifest(m.files)
  return {
    snapshotId,
    manifestHash,
    count: m.count,
    degraded: m.degraded,
    bigSkipped: m.bigSkipped,
    scope,
    at: new Date().toISOString(),
    files: m.files
  }
}

/**
 * 从已有 `gate-result.json` 反推快照。
 * ★ 新格式（含 `snapshot` 段）⇒ 直接用；旧格式 ⇒ `{ ok:false, reason:'legacy-no-snapshot' }`，
 *   **不补造**（§三「旧缺收据只能标 legacy-unknown，不能补造」）。
 */
export function snapshotIdFromGateResult (gateResult) {
  if (!gateResult || typeof gateResult !== 'object') {
    return { ok: false, reason: 'no-gate-result', snapshotId: null, manifestHash: null }
  }
  if (gateResult.snapshot && typeof gateResult.snapshot === 'object' && typeof gateResult.snapshot.snapshotId === 'string') {
    return {
      ok: true,
      reason: null,
      snapshotId: gateResult.snapshot.snapshotId,
      manifestHash: gateResult.snapshot.manifestHash ?? String(gateResult.snapshot.snapshotId).replace(/^sha256:/, ''),
      degraded: gateResult.snapshot.degraded === true,
      count: gateResult.snapshot.count ?? null
    }
  }
  // 旧格式：有 manifest 但没声明范围 —— 不能假设它等于当前快照
  return {
    ok: false,
    reason: gateResult.manifest ? 'legacy-no-snapshot' : 'legacy-no-manifest',
    snapshotId: null,
    manifestHash: null
  }
}

/** 旧字段 `snapshot`（字符串或对象）→ 统一迁移成 `snapshotId`（§零.1「旧的 snapshot 统一迁移为 snapshotId」） */
export function migrateSnapshotField (obj) {
  if (!obj || typeof obj !== 'object') return obj
  const out = { ...obj }
  const hadLegacy = Object.hasOwn(out, 'snapshot')
  delete out.snapshot // 旧字段一律清理：留着就是第二份快照来源
  if (typeof out.snapshotId === 'string' && out.snapshotId) return out
  if (!hadLegacy) return obj
  const legacy = obj.snapshot
  let id = null
  if (typeof legacy === 'string' && legacy) id = legacy.startsWith('sha256:') ? legacy : `sha256:${legacy}`
  else if (legacy && typeof legacy === 'object' && typeof legacy.snapshotId === 'string') id = legacy.snapshotId
  else if (legacy && typeof legacy === 'object' && typeof legacy.id === 'string') id = legacy.id
  if (!id) return hadLegacy ? out : obj
  out.snapshotId = id
  return out
}

/** 相对路径工具（消费方要"哪个文件把快照改了"，别自己拼路径） */
export function diffManifests (a = {}, b = {}) {
  const changed = []
  const added = []
  const removed = []
  for (const k of Object.keys(b)) {
    if (!Object.hasOwn(a, k)) added.push(k)
    else if (a[k] !== b[k]) changed.push(k)
  }
  for (const k of Object.keys(a)) if (!Object.hasOwn(b, k)) removed.push(k)
  changed.sort(); added.sort(); removed.sort()
  return { changed, added, removed }
}

/** 给证据/日志用的一句话 */
export function describeSnapshot (s) {
  if (!s || !s.snapshotId) return 'snapshot=unknown'
  return `snapshot=${s.snapshotId} files=${s.count ?? '?'}${s.degraded ? ' degraded' : ''}${s.scope?.declared ? ` scope=${s.scope.source}` : ''}`
}
