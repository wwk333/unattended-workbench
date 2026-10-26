/**
 * 看板权限闸 —— **三层权限的唯一执行点**（施工文档 §零.5 / §十「三层权限」）
 *
 *     状态区：只读            任务表、运转链、健康灯、交付/门禁/审核状态
 *     配置区：可写，走配置网关  API 额度、职位模型、载体、profile、设置（每次留审计）
 *     操作区：可写，但走 C 命令 发送、继续、停止（每次进 C 服务事件流）
 *
 * 为什么要单独一层：`service.mjs` 是个 978 行的 if 链，"哪个口能写"原本只能靠读代码知道。
 * 所有写路由原来只过一道 `guardLocal()`（只验来源是本机）—— **本机就能改任何东西**。
 * 现在每个写路由都过这里：先判区域，再判意图；状态区直接 403，配置区补审计，操作区补命令事件。
 *
 * 纪律：
 *   · 判据只有 `契约/权限.mjs` 一张表（这里不另写一份）；
 *   · 配置区审计写 `_crew/配置审计.jsonl`，一行一次，**who/what/before/after/at 五段齐全**；
 *   · 操作区命令镜像进 C 服务事件流（`/v1/command`），失败不阻断原操作但会在审计里留痕；
 *   · **fail-open 只允许一种**：审计落盘失败不能挡住用户的配置操作（先记内存告警），
 *     但"状态区写"永远 403 —— 那是纪律，不是便利。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkWrite, regionOfRoute, regionOfPath, CONFIG_AUDIT_FIELDS, REGIONS } from '../契约/权限.mjs'
import { DEFAULT_PORT } from '../_状态常量.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const CREW = resolve(HERE, '..', '..', '_crew')

/** 配置区每条路由实际改的那个文件（审计的 before/after 从这里读；读不到就是 null，不编） */
export const CONFIG_FILES = Object.freeze({
  '/api-tune': join(CREW, '调参', '当前.json'),
  '/carriers-action': join(CREW, 'carriers.json'),
  '/rules-action': join(CREW, '规矩版本.json'),
  '/api-keys': join(CREW, '额度状态.json'),
  '/pin': join(CREW, '当前项目.txt'),
  '/relay-action': join(CREW, 'relay.json'),
  '/shell-action': join(CREW, '外壳状态.json')
})

/** 操作区路由 → C 服务命令 op（未登记的一律不镜像，但要能看出"没登记"） */
export const ACTION_OPS = Object.freeze({
  '/brain-say': 'send',
  '/brain-stop': 'stop',
  '/frame-action': 'frame',
  '/longlive-action': 'ensure',
  '/run': 'run'
})

export const AUDIT_LOG = join(CREW, '配置审计.jsonl')

function readTarget (file) {
  if (!file || !existsSync(file)) return null
  try {
    const raw = readFileSync(file, 'utf8')
    try { return JSON.parse(raw) } catch { return raw.slice(0, 4000) }
  } catch { return null }
}

/** 写一条配置审计（唯一格式，五段齐全） */
export function recordConfigAudit (rec, logFile = AUDIT_LOG) {
  // ★ 判"缺"要判**落到纸上的那一行**，不是调用方传进来的裸对象：
  //   `who` 默认"面板用户"、`at` 默认现在，这两个都有默认值；`before/after` 读不到时**如实写 null**（不编）。
  //   真正算"不完整"的只有：连 `what`（改了什么）都说不出来。
  const omitted = CONFIG_AUDIT_FIELDS.filter(k => rec?.[k] === undefined)
  const line = {
    schema: 1,
    kind: 'config-audit',
    at: rec?.at ?? new Date().toISOString(),
    source: '面板/权限闸.mjs',
    state: rec?.what ? 'ok' : 'incomplete',
    stale: false,
    who: rec?.who ?? '面板用户',
    what: rec?.what ?? '(未写)',
    before: rec?.before ?? null,
    after: rec?.after ?? null,
    via: rec?.via ?? '面板配置区',
    route: rec?.route ?? null,
    note: rec?.note ?? (omitted.length ? `调用方未提供：${omitted.join(',')}（已用默认值/null）` : null)
  }
  const missing = CONFIG_AUDIT_FIELDS.filter(k => line[k] === undefined)
  if (missing.length) { line.state = 'incomplete'; line.note = `缺审计字段：${missing.join(',')}` }
  try {
    mkdirSync(dirname(logFile), { recursive: true })
    appendFileSync(logFile, JSON.stringify(line) + '\n', 'utf8')
    return line
  } catch {
    // fail-open（只这一种）：审计写不进去不能挡住用户的配置操作，但要把事实说出来
    console.error('[权限闸] ⚠️ 配置审计落盘失败（配置本身已放行）')
    return line
  }
}

/** 把操作区命令镜像进 C 状态服务的事件流（失败不阻断，但要留痕） */
export async function mirrorCommand ({ route, body = {}, project = null, who = '面板用户' }) {
  const op = ACTION_OPS[route]
  if (!op) return { ok: false, why: `操作区路由没登记 op：${route}` }
  const port = Number(process.env.DSH_CREW_STATE_PORT ?? DEFAULT_PORT)
  const payload = JSON.stringify({ op, project, text: body.text ?? body.say ?? null, taskId: body.taskId ?? null, runId: body.runId ?? null })
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/command`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `panel-${route}-${Date.now()}` },
      body: payload,
      signal: AbortSignal.timeout(3000)
    })
    const j = await r.json().catch(() => null)
    return { ok: r.ok && j?.ok === true, why: r.ok ? null : (j?.error?.message ?? `HTTP ${r.status}`), id: j?.data?.id ?? null }
  } catch (e) {
    return { ok: false, why: `C 服务不可达：${String(e?.message ?? e)}` }
  }
}

function sameOriginOk (req) {
  const origin = String(req.headers.origin ?? '')
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return '只允许本机来源调用（Origin 不是 127.0.0.1/localhost）'
  const ra = String(req.socket?.remoteAddress ?? '')
  if (ra && !/^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(ra)) return '只允许本机调用'
  return null
}

/**
 * 写请求统一入口。返回 `{ ok, region, status, error?, audit?, command? }`。
 * 调用方（`service.mjs`）只看 `ok`：false 就 403/405，true 就继续走原来的处理。
 *
 * @param {object} o
 * @param {object} o.req
 * @param {string} o.pathname
 * @param {object} [o.body]      已解析的请求体（还没解析就传 null，审计里 after 记为 null）
 * @param {boolean} [o.mirror]   操作区是否镜像进 C 服务（默认 true）
 */
export async function guardWrite ({ req, res = null, pathname, body = null, mirror = true, auditLog = AUDIT_LOG } = {}) {
  const method = String(req?.method ?? 'GET').toUpperCase()
  if (method === 'GET' || method === 'HEAD') return { ok: true, region: regionOfRoute(pathname).id, readOnly: true }

  const badOrigin = sameOriginOk(req)
  if (badOrigin) return { ok: false, status: 403, region: regionOfRoute(pathname).id, error: badOrigin }

  const region = regionOfRoute(pathname)
  const intent = region.id === 'config' ? 'write-gateway' : region.id === 'action' ? 'write-command' : 'write-direct'
  const verdict = checkWrite(pathname, intent)
  if (!verdict.ok) {
    return { ok: false, status: 403, region: region.id, error: verdict.reason }
  }

  if (region.id === 'config') {
    const file = CONFIG_FILES[pathname] ?? null
    const before = readTarget(file)
    const audit = recordConfigAudit({
      who: String(req.headers['x-dsh-who'] ?? '面板用户'),
      what: `${pathname} ${body?.op ? `(${body.op})` : ''}`.trim(),
      before,
      after: null, // 写完之后由下面的 finish 钩子补一条 after（不在请求中途读，避免读到半截文件）
      route: pathname,
      note: file ? `目标文件：${file}` : '未登记目标文件（after 由 finish 钩子补）'
    }, auditLog)
    // ★ 写**完成后**再补 after：用 res 的 finish 事件，不改任何既有 handler 的代码。
    if (res && typeof res.once === 'function' && file) {
      res.once('finish', () => {
        try { recordAfter({ pathname, auditLog }) } catch {}
      })
    }
    return { ok: true, region: region.id, auditRequired: true, audit, file }
  }

  if (region.id === 'action') {
    const cmd = mirror ? await mirrorCommand({ route: pathname, body: body ?? {}, project: body?.project ?? null }) : { ok: false, why: 'mirror disabled' }
    return { ok: true, region: region.id, commandRequired: true, command: cmd }
  }

  // 状态区：理论上走不到这里（checkWrite 已经拒了），保底再拒一次
  return { ok: false, status: 403, region: region.id, error: `状态区只读：${pathname}` }
}

/** 配置写完之后补一条 after（让审计有"改成了什么"） */
export function recordAfter ({ pathname, auditLog = AUDIT_LOG, who = '面板用户' } = {}) {
  const file = CONFIG_FILES[pathname] ?? null
  return recordConfigAudit({
    who,
    what: `${pathname} (after)`,
    before: null,
    after: readTarget(file),
    route: pathname,
    note: '写后快照'
  }, auditLog)
}

export { REGIONS, regionOfPath }
