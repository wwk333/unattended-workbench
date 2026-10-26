/**
 * 契约/权限 —— **看板三层权限**（施工文档 §零.5 / §十「三层权限」）
 *
 *   ┌ 状态区：只读            任务表、运转链、健康灯、交付/门禁/审核状态
 *   ├ 配置区：可写，走配置网关  API 额度、职位模型、载体、profile、设置（每次留审计）
 *   └ 操作区：可写，但走 C 命令 发送、继续、停止
 *
 * 为什么要有这个文件：看板是 72KB 的 `service.mjs` + 224KB 的 `页面.js`，
 * 里面"哪个口能写"原本是**看代码才知道**的事。现在把它变成一张机器可查的表：
 * 页面/服务/体检共用一份判据，测试可以逐条断言"状态区写不进去"。
 *
 * 铁律：
 *   · 状态区**不写任何事实**（不写任务/交付/健康/配置）；
 *   · 配置区只写配置，且必须留 `who / what / before / after / at`；
 *   · 操作区只发 C 状态服务命令，**不直接写 running/ledger/TASKS**。
 */

export const REGIONS = Object.freeze({
  status: Object.freeze({ id: 'status', zh: '状态区', permission: 'read-only' }),
  config: Object.freeze({ id: 'config', zh: '配置区', permission: 'write-via-gateway' }),
  action: Object.freeze({ id: 'action', zh: '操作区', permission: 'write-via-command' })
})

/** 一次写请求可能带的三类意图 */
export const INTENTS = Object.freeze(['read', 'write-direct', 'write-gateway', 'write-command'])

/** 配置区每次写必须留的审计字段（§十：who / what / before / after / at） */
export const CONFIG_AUDIT_FIELDS = Object.freeze(['who', 'what', 'before', 'after', 'at'])

/** 操作区命令必须落进 C 服务事件流（不许绕过去改文件） */
export const ACTION_COMMANDS = Object.freeze(['brain-say', 'brain-stop', 'frame-action', 'continue', 'stop', 'send'])

/**
 * 面板路由 → 区域。**唯一一张表**；`service.mjs` 与测试都从这里读，不许各写一份。
 * 路径省略 query，匹配用精确路径（前缀匹配只有 `/api/state` 这类整族）。
 */
export const ROUTES = Object.freeze({
  // ---- 状态区（只读） ----
  '/board-data.json': 'status',
  '/board': 'status',
  '/core.js': 'status',
  '/chain.json': 'status',
  '/chain-detail': 'status',
  '/frames.json': 'status',
  '/session.json': 'status',
  '/brain-session.json': 'status',
  '/longlive.json': 'status',
  '/no-receipt.json': 'status',
  '/carriers.json': 'status',
  '/rules.json': 'status',
  '/router.json': 'status',
  '/relay.json': 'status',
  '/shell.json': 'status',
  '/workspaces': 'status',
  '/health': 'status',
  // ★ 2026-10-26：面板自检（只读）与自重启（操作）
  '/panel-self.json': 'status',
  // ---- 配置区（走配置网关 + 审计） ----
  '/api-tune': 'config',
  '/api-keys': 'config',
  '/carriers-action': 'config',
  '/rules-action': 'config',
  '/relay-action': 'config',
  '/shell-action': 'config',
  '/pin': 'config',
  // ---- 操作区（走 C 服务命令） ----
  '/brain-say': 'action',
  '/brain-stop': 'action',
  '/frame-action': 'action',
  '/longlive-action': 'action',
  // ★ 2026-10-26：「跑一轮」是**操作**，不是配置、更不是状态 —— 不登记就会被当成状态区而拒绝
  '/run': 'action',
  '/panel-restart': 'action'
})

export class PermissionError extends Error {
  constructor (why, detail) {
    super(`[看板权限] ${why}${detail ? `（${detail}）` : ''}`)
    this.name = 'PermissionError'
    this.code = 'E_PERMISSION'
    this.detail = detail ?? null
  }
}

/** 路径 → 区域；不认识的路径按**最保守**处理：状态区（只读） */
export function regionOfRoute (route) {
  const p = String(route ?? '').split('?')[0]
  if (Object.hasOwn(ROUTES, p)) return REGIONS[ROUTES[p]]
  for (const [prefix, region] of Object.entries(ROUTES)) {
    if (prefix.length > 1 && p.startsWith(prefix + '/')) return REGIONS[region]
  }
  return REGIONS.status
}

export const regionOfPath = regionOfRoute

/**
 * 判一次写请求能不能做。**不抛**，返回结构化结论（服务端要回 4xx 并写审计）。
 * @returns {{ ok: boolean, region: string, reason: string|null, auditRequired: boolean, commandRequired: boolean }}
 */
export function checkWrite (route, intent = 'write-direct', payload = null) {
  const region = regionOfRoute(route)
  const base = { ok: false, region: region.id, reason: null, auditRequired: false, commandRequired: false }
  if (intent === 'read') return { ...base, ok: true }

  if (region.id === 'status') {
    return { ...base, reason: `状态区只读：${route} 不许 ${intent}` }
  }
  if (region.id === 'config') {
    if (intent !== 'write-gateway') {
      return { ...base, reason: `配置区必须走配置网关（当前 ${intent}）：${route}` }
    }
    return { ...base, ok: true, auditRequired: true }
  }
  if (region.id === 'action') {
    if (intent !== 'write-command') {
      return { ...base, reason: `操作区必须走 C 服务命令（当前 ${intent}）：${route}` }
    }
    return { ...base, ok: true, commandRequired: true }
  }
  return { ...base, reason: `不认识的区域：${region.id}` }
}

/** 断言允许（服务端入口用；失败抛 PermissionError，调用方统一转 403） */
export function assertAllowed (route, intent, payload = null) {
  const r = checkWrite(route, intent, payload)
  if (!r.ok) throw new PermissionError(r.reason, `route=${route} intent=${intent}`)
  if (r.auditRequired) assertAudit(payload)
  return r
}

/** 配置区审计字段校验（缺一个就不许写） */
export function assertAudit (audit) {
  const missing = CONFIG_AUDIT_FIELDS.filter(k => !audit || !Object.hasOwn(audit, k) || audit[k] === undefined)
  if (missing.length) {
    throw new PermissionError('配置区写操作缺审计字段', `缺 ${missing.join(',')}（who/what/before/after/at 全要）`)
  }
  if (typeof audit.at === 'string' && !Number.isFinite(Date.parse(audit.at))) {
    throw new PermissionError('审计 at 不是可解析时间', String(audit.at))
  }
  return true
}

/** 生成一条审计记录（配置网关写日志的唯一格式） */
export function auditRecord ({ who, what, before, after, at = new Date().toISOString(), via = '面板配置区', note = null }) {
  const rec = { schema: 1, kind: 'config-audit', who, what, before, after, at, source: '面板/service.mjs', via, note }
  assertAudit(rec)
  if (!rec.source) throw new PermissionError('审计记录必须带 source')
  return rec
}

/**
 * 操作区命令 → 应调的 C 服务端点。**不在面板里直接改文件**。
 * 未列出的命令一律拒绝（"新加一个操作"必须先在这里登记）。
 */
export const COMMAND_ROUTES = Object.freeze({
  'brain-say': { method: 'POST', path: '/v1/command', op: 'send' },
  'brain-stop': { method: 'POST', path: '/v1/command', op: 'stop' },
  'continue': { method: 'POST', path: '/v1/command', op: 'resume' },
  'send': { method: 'POST', path: '/v1/command', op: 'send' },
  'stop': { method: 'POST', path: '/v1/command', op: 'stop' },
  'frame-action': { method: 'POST', path: '/v1/command', op: 'frame' }
})

export function commandRouteOf (name) {
  const c = COMMAND_ROUTES[name]
  if (!c) throw new PermissionError(`操作区命令未登记：${name}`, `先把它加进 COMMAND_ROUTES，再在面板里用`)
  return c
}
