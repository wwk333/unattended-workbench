/**
 * 契约/写方 —— **一层一个写方，每个写方有消费方**（施工文档 §零.3 / §零.8 / §八.1）
 *
 * 三件事：
 *   ① 登记表校验：ID 唯一、同一 `authority` 只能有一个 `writer`、每条 fact 至少一个 `consumer`；
 *   ② `unknown/stale` 不得被消费方当绿（`unknownIsGreen` 必须为 false）；
 *   ③ 无消费方字段清单（`DEAD_FIELDS`）—— 文档 §八.4 明写"直接禁"，契约体检读它。
 *
 * 为什么不是纯文档：登记表写成文档就会"只登记不消费"。这里让登记表是**机器可读 JSON**，
 * 校验逻辑在这一个文件里，`契约体检.mjs`（§八）只是它的 CLI 皮 —— 判据只有一处。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** `_unattended/` 根（本文件在 `_unattended/契约/` 下） */
export const UNATTENDED_ROOT = resolve(HERE, '..')
/** 核心契约登记表的唯一位置（§八「唯一出处」） */
export const CORE_CONTRACT_PATH = join(UNATTENDED_ROOT, '_核心契约.json')

export const KINDS = Object.freeze(['fact', 'view', 'contract'])
export const ON_MISSING = Object.freeze(['blocked', 'red', 'unknown', 'allow', 'fail-closed', 'not-applicable'])
export const ON_STALE = Object.freeze(['blocked', 'red', 'unknown', 'allow', 'not-applicable'])

/**
 * **已拍板要删的字段**（§八.4 / §十「没有消费方就删」）。
 * `check` 允许两种判据：
 *   · `files` + `pattern`：这些文件里再出现即失败；
 *   · `assert`：自定义函数（体检时给行/文本，返回 null 表示没问题，返回字符串表示违规原因）。
 */
export const DEAD_FIELDS = Object.freeze([
  {
    id: 'dead.review.ok',
    field: 'review.ok',
    why: '`review.ok` 只表示"审核员调用成功"，被当成"审核通过"用过。放行只认 review.decision／审核报告机器块。',
    files: ['门禁.mjs', '编排.mjs', '交付门.mjs'],
    pattern: /review\s*\.\s*ok\b(?!\s*[:=]\s*false)/,
    allowCallOk: 'review.callOk'
  },
  {
    id: 'dead.closeMin',
    field: 'closeMin',
    why: '`_监控.mjs` 的 closeMin 没有任何消费方（阈值以 §六 timeout 为准）。',
    files: ['_监控.mjs'],
    pattern: /\bcloseMin\b/
  },
  {
    id: 'dead.requestMaxTokens',
    field: 'requestMaxTokens',
    why: '不设置用户级 requestMaxTokens；maxTokens 是派生字段（§五）。',
    files: ['_agents-config.mjs', '调参.mjs', '同步载体模型.mjs'],
    pattern: /\brequestMaxTokens\b/
  },
  {
    id: 'dead.scope-noise-hardcoded',
    field: 'SCOPE_NOISE(硬编码)',
    why: '内核不许硬编码 SCOPE_NOISE，改读项目策略（§四 删/并/退）。',
    files: ['编排.mjs', '_越界.mjs'],
    pattern: /\bSCOPE_NOISE\s*=\s*[[{]/
  },
  {
    id: 'dead.duplicate-wakebrain',
    field: 'wakeBrain(第二份实现)',
    why: '`进度看护.mjs` 自己实现过一份 wakeBrain；唤醒只留 `_唤醒.mjs` 一个入口（§七）。',
    files: ['进度看护.mjs'],
    pattern: /\bfunction\s+wakeBrain\b/
  },
  {
    id: 'dead.failover-idx-permanent',
    field: 'failover.idx(永久粘住)',
    why: '删除永久粘住的 failover.idx，按健康状态重算或加 TTL（§五）。',
    files: ['额度切换.mjs', '路由网关.mjs'],
    pattern: /failover\s*\.\s*idx\s*=(?!=)/
  }
])

/** 三条硬规则的错误码，稳定给测试断言用 */
export const REGISTRY_ERRORS = Object.freeze({
  ID_DUP: 'registry.id-dup',
  NO_WRITER: 'registry.no-writer',
  MULTI_WRITER: 'registry.multi-writer',
  NO_CONSUMER: 'registry.no-consumer',
  UNKNOWN_GREEN: 'registry.unknown-is-green',
  BAD_KIND: 'registry.bad-kind',
  BAD_ON_MISSING: 'registry.bad-on-missing',
  BAD_ON_STALE: 'registry.bad-on-stale',
  BAD_ID: 'registry.bad-id',
  CONSUMER_SELF: 'registry.consumer-is-writer'
})

export class RegistryError extends Error {
  constructor (errors) {
    super(`[契约登记] ${errors.length} 条违规：\n  - ` + errors.map(e => `${e.code}: ${e.msg}`).join('\n  - '))
    this.name = 'RegistryError'
    this.code = 'E_REGISTRY'
    this.errors = errors
  }
}

/** 读登记表（核心 + 可选项目层；按 ID 合并，重复 ID 直接失败） */
export function loadRegistry ({ corePath = CORE_CONTRACT_PATH, projectPath = null } = {}) {
  const layers = []
  for (const [path, layer] of [[corePath, 'core'], [projectPath, 'project']]) {
    if (!path || !existsSync(path)) continue
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    layers.push({ layer, path, registry: raw })
  }
  if (!layers.length) throw new RegistryError([{ code: 'registry.missing', msg: `找不到登记表：${corePath}` }])
  const items = []
  const seen = new Map()
  const errors = []
  for (const { layer, path, registry } of layers) {
    const list = Array.isArray(registry.items) ? registry.items : []
    for (const it of list) {
      const id = it?.id
      if (typeof id !== 'string' || !id.trim()) {
        errors.push({ code: REGISTRY_ERRORS.BAD_ID, msg: `${path} 有一条登记缺 id`, layer })
        continue
      }
      if (seen.has(id)) {
        errors.push({ code: REGISTRY_ERRORS.ID_DUP, msg: `ID 重复：${id}（${seen.get(id)} 与 ${layer}）`, layer })
        continue
      }
      seen.set(id, layer)
      items.push({ ...it, _layer: layer })
    }
  }
  if (errors.length) throw new RegistryError(errors)
  return { schema: 1, layers: layers.map(l => ({ layer: l.layer, path: l.path })), items }
}

/** 唯一 writer 索引：authority → writer */
export function writerIndex (registry) {
  const idx = new Map()
  for (const it of registry.items ?? []) {
    if (typeof it.authority !== 'string') continue
    if (!idx.has(it.authority)) idx.set(it.authority, [])
    idx.get(it.authority).push(it.writer ?? null)
  }
  return idx
}

/** 消费方索引：writer → [factId...]（用来发现"写了没人看"） */
export function consumerIndex (registry) {
  const idx = new Map()
  for (const it of registry.items ?? []) {
    for (const c of it.consumers ?? []) {
      if (!idx.has(c)) idx.set(c, [])
      idx.get(c).push(it.id)
    }
  }
  return idx
}

/**
 * 校验登记表。返回 `{ ok, errors[], warnings[] }`，不抛（体检要列全部问题）。
 */
export function validateRegistry (registry) {
  const errors = []
  const warnings = []
  const items = registry.items ?? []
  if (!items.length) errors.push({ code: 'registry.empty', msg: '登记表是空的：没有任何事实被登记' })

  const ids = new Set()
  const byAuthority = new Map()
  for (const it of items) {
    const id = it.id
    if (typeof id !== 'string' || !/^[a-z][\w.-]*$/i.test(id)) {
      errors.push({ code: REGISTRY_ERRORS.BAD_ID, msg: `ID 必须是非空标识符：${JSON.stringify(id)}`, id })
      continue
    }
    if (ids.has(id)) errors.push({ code: REGISTRY_ERRORS.ID_DUP, msg: `ID 重复：${id}`, id })
    ids.add(id)

    if (!KINDS.includes(it.kind)) {
      errors.push({ code: REGISTRY_ERRORS.BAD_KIND, msg: `${id}: kind 必须是 ${KINDS.join('/')}，实际 ${JSON.stringify(it.kind)}`, id })
    }
    if (typeof it.authority !== 'string' || !it.authority.trim()) {
      errors.push({ code: REGISTRY_ERRORS.BAD_ID, msg: `${id}: 缺 authority（唯一出处）`, id })
    }
    if (typeof it.writer !== 'string' || !it.writer.trim()) {
      errors.push({ code: REGISTRY_ERRORS.NO_WRITER, msg: `${id}: 缺 writer —— 一层一个写方，不许没写方`, id })
    }
    if (/\s(and|和|与|＋|\+)\s/i.test(it.writer ?? '')) {
      errors.push({ code: REGISTRY_ERRORS.MULTI_WRITER, msg: `${id}: writer 只能有一个，实际写了多个：${it.writer}`, id })
    }

    const consumers = Array.isArray(it.consumers) ? it.consumers.filter(c => typeof c === 'string' && c.trim()) : []
    if (!consumers.length) {
      errors.push({ code: REGISTRY_ERRORS.NO_CONSUMER, msg: `${id}: 没有消费者 —— 没有消费方的字段必须删除（§零.8）`, id })
    }
    if (consumers.length === 1 && consumers[0] === it.writer) {
      errors.push({ code: REGISTRY_ERRORS.CONSUMER_SELF, msg: `${id}: 唯一消费者就是写方自己 —— 那等于没人看`, id })
    }

    if (it.onMissing !== undefined && !ON_MISSING.includes(it.onMissing)) {
      errors.push({ code: REGISTRY_ERRORS.BAD_ON_MISSING, msg: `${id}: onMissing 非法：${JSON.stringify(it.onMissing)}`, id })
    }
    if (it.onStale !== undefined && !ON_STALE.includes(it.onStale)) {
      errors.push({ code: REGISTRY_ERRORS.BAD_ON_STALE, msg: `${id}: onStale 非法：${JSON.stringify(it.onStale)}`, id })
    }
    if (it.unknownIsGreen === true) {
      errors.push({ code: REGISTRY_ERRORS.UNKNOWN_GREEN, msg: `${id}: unknownIsGreen=true —— unknown 一律不得当绿（用户硬约束 2）`, id })
    }
    if (it.kind === 'fact') {
      if (it.onMissing === undefined) errors.push({ code: REGISTRY_ERRORS.BAD_ON_MISSING, msg: `${id}: fact 必须声明 onMissing`, id })
      if (it.onStale === undefined) errors.push({ code: REGISTRY_ERRORS.BAD_ON_STALE, msg: `${id}: fact 必须声明 onStale`, id })
      if (it.unknownIsGreen === undefined) errors.push({ code: REGISTRY_ERRORS.UNKNOWN_GREEN, msg: `${id}: fact 必须显式写 unknownIsGreen:false`, id })
    }

    if (typeof it.authority === 'string') {
      if (!byAuthority.has(it.authority)) byAuthority.set(it.authority, [])
      byAuthority.get(it.authority).push(it)
    }
  }

  for (const [authority, list] of byAuthority) {
    const writers = [...new Set(list.map(x => x.writer))]
    if (writers.length > 1) {
      errors.push({
        code: REGISTRY_ERRORS.MULTI_WRITER,
        msg: `同一 authority 有 ${writers.length} 个写方：${authority} ← ${writers.join(' / ')}（${list.map(x => x.id).join(',')}）`
      })
    }
  }

  // 视图必须能指出它从哪生成；否则就是第二真相
  for (const it of items) {
    if (it.kind !== 'view') continue
    if (!it.generatedFrom) warnings.push({ id: it.id, code: 'registry.view-no-source', msg: `${it.id}: 视图没写 generatedFrom，消费方无法判断新鲜度` })
  }

  return { ok: errors.length === 0, errors, warnings }
}

/** 断言登记表合法（施工/体检/测试用） */
export function assertRegistry (registry) {
  const r = validateRegistry(registry)
  if (!r.ok) throw new RegistryError(r.errors)
  return r
}

/** 在登记表里找一条事实（消费方用；找不到就是契约缺失，不许"大概猜"） */
export function factOf (registry, id) {
  const it = (registry.items ?? []).find(x => x.id === id)
  if (!it) throw new RegistryError([{ code: 'registry.unknown-fact', msg: `登记表里没有 ${id}` }])
  return it
}

/** 唯一写方断言：某事实只能由登记的 writer 写 */
export function assertWriter (registry, factId, who) {
  const it = factOf(registry, factId)
  if (it.writer !== who) {
    throw new RegistryError([{
      code: REGISTRY_ERRORS.MULTI_WRITER,
      msg: `${factId} 的唯一写方是 ${it.writer}，${who} 不许写`
    }])
  }
  return true
}
