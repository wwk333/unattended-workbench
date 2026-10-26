/**
 * 契约/入口 —— **通用入口验收证据**的唯一校验器（施工文档 §二）
 *
 * 内核不写死浏览器/CLI/HTTP；项目写适配器，按统一形状交证据：
 * ```json
 * { "schema":1, "kind":"entry", "snapshotId":"sha256:…", "at":"…", "source":"project-adapter",
 *   "state":"green", "ok":true, "entry":"cli:my-tool convert",
 *   "checks":[{"id":"E1","ok":true,"detail":"真实命令退出码 0"}],
 *   "artifacts":["_crew/gate/entry-output.txt"], "durationMs":1200 }
 * ```
 *
 * 内核校验（缺一条即红）：命令退出码 0、证据存在且可解析、`schema` 匹配、`ok:true`、
 * `checks` 非空且逐条 true、必过步骤不允许 `degraded:true`、`snapshotId` 与本次门禁一致。
 *
 * 为什么还要查 `artifacts` 真在盘上：**只写 `ok:true` 的适配器就是橡皮章**。
 * 证据里声明的每一个产物都必须真存在且非空，否则判红（§二「故意让适配器只返回 ok:true 但无真实产物，必须被抓住」）。
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export const ENTRY_SCHEMA = 1
export const ENTRY_KINDS = Object.freeze(['entry'])

export class EntryError extends Error {
  constructor (why, detail) {
    super(`[入口证据] ${why}${detail ? `（${detail}）` : ''}`)
    this.name = 'EntryError'
    this.code = 'E_ENTRY'
  }
}

/** 证据路径解析：`evidence` 可以是项目相对路径，也可以绝对路径 */
export function resolveEvidencePath (project, evidence) {
  if (!evidence) return null
  return isAbsolute(evidence) ? evidence : join(project, evidence)
}

/**
 * 校验入口证据。
 * @param {object} obj            证据 JSON（已解析）
 * @param {object} o
 * @param {string} o.snapshotId   本次门禁/当前代码的快照（必须与证据一致）
 * @param {string} [o.project]    用于检查 artifacts 真的在盘上
 * @param {boolean} [o.requireArtifacts=true]
 * @returns {{ ok:boolean, errors:string[], warnings:string[], degraded:boolean, checks:object[], artifacts:string[] }}
 */
export function validateEntryEvidence (obj, { snapshotId = null, project = null, requireArtifacts = true } = {}) {
  const errors = []
  const warnings = []
  const out = { ok: false, errors, warnings, degraded: false, checks: [], artifacts: [], entry: null, durationMs: null }

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    errors.push('证据不是 JSON 对象')
    return out
  }
  if (obj.schema !== ENTRY_SCHEMA) errors.push(`schema=${JSON.stringify(obj.schema)}（只认 ${ENTRY_SCHEMA}）`)
  if (!ENTRY_KINDS.includes(obj.kind)) errors.push(`kind=${JSON.stringify(obj.kind)}（只认 "entry"）`)
  if (typeof obj.at !== 'string' || !Number.isFinite(Date.parse(obj.at))) errors.push(`at 不是可解析时间：${JSON.stringify(obj.at)}`)
  if (typeof obj.source !== 'string' || !obj.source.trim()) errors.push('缺 source（哪个适配器产出的）')
  if (obj.stale === true) errors.push('stale=true：证据过期，不得当绿')
  if (obj.state !== undefined && obj.state !== 'green') errors.push(`state=${JSON.stringify(obj.state)}（入口证据只有 state:"green" 才算过）`)
  out.degraded = obj.degraded === true
  if (out.degraded) errors.push('degraded=true：必过步骤不允许降级冒充通过')

  if (obj.ok !== true) errors.push('ok 不为 true')
  if (typeof obj.snapshotId !== 'string' || !obj.snapshotId) {
    errors.push('缺 snapshotId（入口证据必须绑定它跑的是哪一份代码）')
  } else if (snapshotId && obj.snapshotId !== snapshotId) {
    errors.push(`snapshotId 不一致：证据 ${obj.snapshotId} ≠ 本次 ${snapshotId}（旧证据冒充新绿灯）`)
  }

  if (!Array.isArray(obj.checks) || obj.checks.length === 0) {
    errors.push('checks 为空：没有逐条断言的证据不算入口验收')
  } else {
    out.checks = obj.checks
    obj.checks.forEach((c, i) => {
      if (!c || typeof c !== 'object') { errors.push(`checks[${i}] 不是对象`); return }
      if (c.ok !== true) errors.push(`checks[${i}]（${c.id ?? '无 id'}）ok 不为 true`)
      if (typeof c.detail !== 'string' || !c.detail.trim()) errors.push(`checks[${i}]（${c.id ?? '无 id'}）缺 detail（说不出证据等于没验）`)
    })
  }

  if (obj.artifacts !== undefined) {
    if (!Array.isArray(obj.artifacts)) errors.push('artifacts 必须是数组')
    else {
      out.artifacts = obj.artifacts.map(String)
      if (requireArtifacts && out.artifacts.length === 0) {
        errors.push('artifacts 为空：只写 ok:true 而没有真实产物，就是橡皮章')
      }
      if (project) {
        for (const a of out.artifacts) {
          const p = resolveEvidencePath(project, a)
          if (!existsSync(p)) { errors.push(`产物不存在：${a}`); continue }
          try {
            const st = statSync(p)
            if (st.isFile() && st.size === 0) errors.push(`产物是空文件：${a}`)
          } catch (e) { errors.push(`产物读不到：${a}（${e.message}）`) }
        }
      }
    }
  } else if (requireArtifacts) {
    errors.push('缺 artifacts（必须有真实产物）')
  }

  out.entry = typeof obj.entry === 'string' ? obj.entry : null
  out.durationMs = Number.isFinite(obj.durationMs) ? obj.durationMs : null
  out.ok = errors.length === 0
  return out
}

/** 读证据文件并校验（文件缺失/坏 JSON 也算红，不降级） */
export function inspectEntryEvidence (absPath, opts = {}) {
  if (!absPath || !existsSync(absPath)) {
    return { ok: false, errors: [`入口证据文件不存在：${absPath ?? '(未声明 evidence)'}`], warnings: [], degraded: false, checks: [], artifacts: [], raw: null }
  }
  let raw = null
  try {
    raw = JSON.parse(readFileSync(absPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch (e) {
    return { ok: false, errors: [`入口证据不是合法 JSON：${String(e.message).slice(0, 140)}`], warnings: [], degraded: false, checks: [], artifacts: [], raw: null }
  }
  const v = validateEntryEvidence(raw, opts)
  return { ...v, raw }
}
