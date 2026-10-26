/**
 * 调度 —— **软写域 + DAG + 角色池**（施工文档 §四）
 *
 * ## 为什么要有它（真事）
 * 32/32 张卡都带 `游戏.html`、`_crew/shots/`，任意两卡写域都有交集 ⇒ 自动串行，并行率为 0；
 * `SCOPE_NOISE` 只在越界归因用、不参与调度；同一载体不能并行但只提醒不改派；`--wave` 成了全局调度屏障
 * （前一波 review 不完，后面独立的卡也干等）。结论：**恢复真实并行，同时允许良性越界**。
 *
 * ## 三类边界（§四 那张表）
 * | 类型 | 处理 |
 * |---|---|
 * | 共享产物/噪音（构建产物、截图、日志、`.obsidian`、`_crew` 证据） | 不算越界，不参与写域冲突 |
 * | 良性越界（顺手改相邻模块、补依赖） | 允许、记录原因、**不阻断**、不要求用户审批 |
 * | 有害越界（并发同文件覆盖、删无关文件、碰密钥/CI/代理配置、把门禁搞红） | 记录、复核、必要时返工 |
 *
 * ## 铁律
 * 1. `writes` 是**调度提示**，不是硬授权白名单。缺 `writes` 标 `unknown-scope`，**默认仍可并行**。
 * 2. 显式 `writes: []` ＝ 不写文件（与 `null`＝未知 不同）。
 * 3. **已知**同文件冲突必须串行 —— 那不是洁癖，是两个进程同时写一个文件会真的坏。
 * 4. `wave` 只是**展示标签**，不是全局屏障。
 * 5. 策略是**项目级**的（`gate.json#policy` / `_crew/策略.json`），内核不硬编码 `SCOPE_NOISE`。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { canRunConcurrently, maxConcurrentOf } from './契约/画像.mjs'

/**
 * 默认策略（**项目可覆盖**）。这里的每一条都来自实测踩过的噪音，不是拍脑袋：
 * 越界台账那 40 条里 39 条是 `_crew/logs` 与 `.obsidian` 造成的误报。
 */
export const DEFAULT_POLICY = Object.freeze({
  /** 共享产物 / 噪音：不算越界，也不参与写域冲突 */
  sharedOutputs: Object.freeze([
    '^证据/',
    '^_crew/gate/',
    '^_crew/backup/',
    '^_crew/fingerprints/',
    '^_crew/shots/',
    '^fingerprints/',
    '^_crew/actions\\.jsonl$',
    '^_crew/越界\\.jsonl$',
    '^_crew/监控账本\\.jsonl$',
    '^_crew/waivers\\.jsonl$',
    '^_crew/看护(状态|告警)\\.json$',
    '^_crew/logs/',
    '^_crew/runs/',
    '^\\.pi/',
    '^\\.obsidian/',
    '\\.log$',
    '^_crew/(调参|ledger|board-data|同轮重派)'
  ]),
  /** 有害越界：碰这些就必须复核 */
  harmful: Object.freeze([
    '^secrets/',
    '(^|/)\\.env(\\.|$)',
    '^(\\.github|CI|ci)/',
    '^_unattended/',
    '(^|/)agents\\.json$',
    '(^|/)models\\.json$',
    '(^|/)settings\\.json$'
  ]),
  /** 共享资源容量（端口/构建目录/单例服务）；缺省视为 1（独占） */
  resources: Object.freeze({})
})

export class ScheduleError extends Error {
  constructor (code, msg, detail) {
    super(`[调度] ${msg}${detail ? `（${detail}）` : ''}`)
    this.name = 'ScheduleError'
    this.code = code
    this.detail = detail ?? null
  }
}

const toPosix = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim()

function compile (list) {
  return (Array.isArray(list) ? list : []).map(re => (re instanceof RegExp ? re : new RegExp(String(re), 'i')))
}

/**
 * 读项目策略：`gate.json#policy` 优先，其次 `_crew/策略.json`，都没有就用默认。
 * @returns {{ sharedOutputs:RegExp[], harmful:RegExp[], resources:object, source:string }}
 */
export function loadPolicy (project) {
  const pick = (obj, src) => ({
    sharedOutputs: compile(obj?.sharedOutputs ?? DEFAULT_POLICY.sharedOutputs),
    harmful: compile(obj?.harmful ?? DEFAULT_POLICY.harmful),
    resources: { ...DEFAULT_POLICY.resources, ...(obj?.resources ?? {}) },
    source: src
  })
  if (!project) return pick(null, 'default(§四)')
  const gate = join(project, 'gate.json')
  try {
    if (existsSync(gate)) {
      const j = JSON.parse(readFileSync(gate, 'utf8').replace(/^\uFEFF/, ''))
      if (j?.policy) return pick(j.policy, 'gate.json#policy')
    }
  } catch { /* 坏 gate.json 由门禁报，这里不吞错也不中断 */ }
  const own = join(project, '_crew', '策略.json')
  try {
    if (existsSync(own)) {
      const j = JSON.parse(readFileSync(own, 'utf8').replace(/^\uFEFF/, ''))
      return pick(j, '_crew/策略.json')
    }
  } catch { /* 同上 */ }
  return pick(null, 'default(§四)')
}

/** 是不是共享产物/噪音（不算越界，也不参与写域冲突） */
export function isSharedOutput (p, policy = loadPolicy(null)) {
  const n = toPosix(p)
  return (policy.sharedOutputs ?? []).some(re => re.test(n))
}

/** 是不是有害越界 */
export function isHarmful (p, policy = loadPolicy(null)) {
  const n = toPosix(p)
  return (policy.harmful ?? []).some(re => re.test(n))
}

/**
 * 一张卡的**写域**：`null` = unknown-scope（仍可并行）；`[]` = 明确不写文件。
 *
 * ★ 2026-10-26（§四 实测口径）：只摘掉"**目录级**共享产物"（如 `_crew/shots/`），
 *   **不摘精确文件**（如 `_crew/shots/T1/a.png`）。理由：
 *   · 32 张卡都写 `_crew/shots/` 这种目录声明 ⇒ 摘掉，否则任意两卡都"冲突"，并行率为 0（正是要治的病）；
 *   · 但两张卡写**同一个具体文件**是真会坏的，必须继续算冲突（§四：「两个进程同时写一个文件会真的坏」）。
 *   判据：目录级 = 以 `/` 结尾，或没有文件扩展名。
 */
export function effectiveWrites (task, policy = loadPolicy(null)) {
  const raw = task?.writes
  if (raw === undefined || raw === null) return null
  const list = (Array.isArray(raw) ? raw : []).map(toPosix).filter(Boolean)
  if (!list.length) return []
  return list.filter(p => {
    if (!isSharedOutput(p, policy)) return true
    return !isDirLike(p) // 精确文件照样参与冲突判定
  })
}

/** 目录级声明（`a/b/` 或没有扩展名） */
export function isDirLike (p) {
  const s = toPosix(p)
  return s.endsWith('/') || !/\.[a-z0-9]{1,8}$/i.test(s)
}

/**
 * 两张卡的写域冲不冲突。
 * @returns {{ conflict:boolean, files:string[], unknown:boolean }}
 */
export function writesConflict (a, b, policy = loadPolicy(null)) {
  const wa = effectiveWrites(a, policy)
  const wb = effectiveWrites(b, policy)
  const unknown = wa === null || wb === null
  if (unknown) return { conflict: false, files: [], unknown: true } // 未知写域不挡（软约束）
  const set = new Set(wa)
  const files = wb.filter(p => set.has(p))
  return { conflict: files.length > 0, files, unknown: false }
}

/** 共享资源需求（端口/构建目录/单例服务） */
export function resourceNeeds (task) {
  return Array.isArray(task?.resources) ? task.resources.map(String) : []
}

/**
 * 越界归因（§四 三类边界）。**只看事实，不猜动机**。
 * @param {object} o
 * @param {string[]} o.declaredWrites  卡上声明的写域
 * @param {string[]} o.actual          指纹里真实变动的路径
 * @returns {{ noise:string[], benign:string[], harmful:string[], declared:string[], unknownScope:boolean }}
 */
export function classifyOverreach ({ declaredWrites = null, actual = [] }, policy = loadPolicy(null)) {
  const out = { noise: [], benign: [], harmful: [], declared: [], unknownScope: declaredWrites === null || declaredWrites === undefined }
  const decl = new Set((Array.isArray(declaredWrites) ? declaredWrites : []).map(toPosix))
  for (const p of actual.map(toPosix)) {
    if (decl.has(p)) { out.declared.push(p); continue }
    if (isSharedOutput(p, policy)) { out.noise.push(p); continue }
    if (isHarmful(p, policy)) { out.harmful.push(p); continue }
    out.benign.push(p) // 良性越界：允许、记录，不阻断
  }
  return out
}

/**
 * 排一次调度。
 *
 * @param {object} o
 * @param {object[]} o.tasks        候选卡（pending/ready）
 * @param {object[]} [o.running]    已经在跑的卡（它们的写域也算占用）
 * @param {Set<string>|string[]} [o.doneIds] 已完成卡 ID
 * @param {object[]} [o.carriers]   [{name, maxConcurrent}]；缺省按「每卡自己一个载体」算
 * @param {object} [o.roleCarrier]  角色→载体映射（`agents.json` 里那份）。**不传就不做载体约束**
 * @param {string[]} [o.roleAvailable] 可用角色
 * @param {object} [o.policy]
 * @returns {{ batches:object[], queue:string[], skipped:object[], stats:object }}
 */
export function planSchedule ({ tasks = [], running = [], doneIds = [], carriers = null, roleCarrier = null, roleAvailable = null, policy = loadPolicy(null) } = {}) {
  const done = new Set(Array.isArray(doneIds) ? doneIds : [...(doneIds ?? [])])
  const skipped = []
  const candidates = []
  for (const t of tasks) {
    if (!t?.id) { skipped.push({ id: null, why: '没有 id' }); continue }
    const deps = t.depends ?? []
    const missing = deps.filter(d => !done.has(d))
    if (missing.length) { skipped.push({ id: t.id, why: `依赖未完成：${missing.join(',')}` }); continue }
    const status = t.status ?? 'pending'
    if (!['pending', 'ready'].includes(status)) { skipped.push({ id: t.id, why: `状态 ${status} 不可派` }); continue }
    if (roleAvailable && !roleFits(t, roleAvailable)) { skipped.push({ id: t.id, why: '角色池里没有可用角色' }); continue }
    candidates.push(t)
  }

  // 已在跑的占用：写域 + 载体 + 共享资源
  const busyWrites = new Set()
  const carrierOfTask = (t) => {
    const role = t?.assignedRole ?? t?.role ?? null
    // ★ 载体是"角色→载体映射"的属性，**不是角色本身**（把 role 当 carrier 会把同角色的卡全串起来）
    return (roleCarrier && role ? roleCarrier[role] : null) ?? t?.carrier ?? null
  }
  for (const r of running) {
    for (const p of effectiveWrites(r, policy) ?? []) busyWrites.add(p)
  }
  const carrierBusy = new Map()
  for (const r of running) {
    const c = carrierOfTask(r)
    if (c) carrierBusy.set(c, (carrierBusy.get(c) ?? 0) + 1)
  }
  const resourceBusy = new Map()
  for (const r of running) for (const res of resourceNeeds(r)) resourceBusy.set(res, (resourceBusy.get(res) ?? 0) + 1)

  // 热点文件统计（并行率的真实瓶颈，交给 HANDOFF/看板显示）
  const hotspot = new Map()
  for (const t of candidates) for (const p of effectiveWrites(t, policy) ?? []) hotspot.set(p, (hotspot.get(p) ?? 0) + 1)

  const batches = []
  const queue = []
  const pendingPhaseReasons = []
  const newBatch = () => ({ index: batches.length + 1, tasks: [], writes: new Set(), carriers: new Map(), resources: new Map(), reasons: [] })

  /**
   * 能不能把 `t` 放进这一批。
   * ★ 三条约束都查，包括**已在跑的占用**（`busyWrites`/`carrierBusy`/`resourceBusy`）——
   *   早先版本只在新批次上复查写域，把"和正在跑的卡撞文件"当成放行，实测会并发写同一个文件。
   */
  const whyNot = (batch, t) => {
    const w = effectiveWrites(t, policy)
    const carrier = carrierOfTask(t)
    const wanted = resourceNeeds(t)
    if (w && w.length) {
      const hit = w.filter(p => batch.writes.has(p) || busyWrites.has(p))
      if (hit.length) return `write-conflict：${hit.slice(0, 3).join(',')}${hit.some(p => busyWrites.has(p)) ? '（与正在跑的卡撞文件）' : ''}`
    }
    if (carrier) {
      const used = (batch.carriers.get(carrier) ?? 0) + (carrierBusy.get(carrier) ?? 0)
      const max = carriersOf(carriers).get(carrier) ?? maxConcurrentOf(carrier)
      if (used >= max) return `carrier-busy：${carrier}（${used}/${max}）`
    }
    for (const res of wanted) {
      const used = (batch.resources.get(res) ?? 0) + (resourceBusy.get(res) ?? 0)
      const cap = Number(policy.resources?.[res] ?? 1)
      if (used >= cap) return `resource-busy：${res}（${used}/${cap}）`
    }
    return null
  }

  const place = (batch, t) => {
    const w = effectiveWrites(t, policy)
    const carrier = carrierOfTask(t)
    batch.tasks.push(t.id)
    for (const p of w ?? []) batch.writes.add(p)
    if (carrier) batch.carriers.set(carrier, (batch.carriers.get(carrier) ?? 0) + 1)
    for (const res of resourceNeeds(t)) batch.resources.set(res, (batch.resources.get(res) ?? 0) + 1)
    queue.push(t.id)
  }

  // 轮次式：每轮往"当前批"里尽量多塞；一张都塞不下就说明这批到头了，换下一批。
  // 这样并行宽度是**最优**的（不是"按顺序遇到冲突就换批"，那会把后面的卡白白推到下一批）。
  let pending = [...candidates]
  let guard = 0
  while (pending.length) {
    if (++guard > 10_000) throw new ScheduleError('E_LOOP', '调度循环超过 10000 轮（内部错误）')
    const batch = newBatch()
    batches.push(batch)
    const remain = []
    for (const t of pending) {
      const why = whyNot(batch, t)
      if (why) { remain.push({ t, why }); continue }
      place(batch, t)
    }
    if (!batch.tasks.length) {
      // 空批次都放不下一张 ⇒ 是**已在跑的占用**（它不会自己消失）挡住了第一张，如实跳过并说明
      const first = remain[0]
      skipped.push({ id: first.t.id, why: first.why })
      pending = remain.slice(1).map(x => x.t)
      batches.pop()
      continue
    }
    const nextPending = remain.map(x => x.t)
    // 没排上的卡为什么没进这一批 —— 记在**下一批**的 reasons 上（人读"这批为什么被推迟"）
    pending = nextPending
    if (pending.length) {
      const nextReasons = remain.map(x => `${x.t.id}: ${x.why}`)
      pendingPhaseReasons.push(nextReasons)
    }
  }

  // 去掉空批次（免得看板出现"0 张卡的一波"）
  const real = batches.filter(b => b.tasks.length).map((b, i) => ({
    index: i + 1,
    tasks: b.tasks,
    writeDomains: [...b.writes].sort(),
    carriers: [...b.carriers.keys()],
    resources: [...b.resources.keys()],
    reasons: pendingPhaseReasons[i] ?? []
  }))

  const serialReasons = {}
  for (const b of real) for (const r of b.reasons) {
    const [id, ...rest] = r.split(': ')
    serialReasons[id] = rest.join(': ')
  }
  return {
    batches: real,
    queue,
    skipped,
    stats: {
      candidates: candidates.length,
      scheduled: queue.length,
      batches: real.length,
      parallelWidth: real.length ? Math.max(...real.map(b => b.tasks.length)) : 0,
      hotspotFiles: [...hotspot.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([file, n]) => ({ file, tasks: n })),
      serialReasons,
      unknownScope: candidates.filter(t => effectiveWrites(t, policy) === null).map(t => t.id)
    }
  }
}

function carriersOf (carriers) {
  const m = new Map()
  for (const c of Array.isArray(carriers) ? carriers : []) {
    if (c?.name) m.set(String(c.name), Number(c.maxConcurrent ?? 1))
  }
  return m
}

function roleFits (task, available) {
  const pool = Array.isArray(task.rolePool) ? task.rolePool.filter(Boolean) : []
  if (task.assignedRole && (pool.length === 0 || pool.includes(task.assignedRole))) return available.includes(task.assignedRole)
  if (!pool.length) return !task.role || available.includes(task.role)
  return pool.some(r => available.includes(r))
}

/**
 * 同一载体能不能并行（把 §零.4 的口径暴露给调度/看板，避免各处各写一遍）。
 */
export function carrierParallelOk (a, b) {
  return canRunConcurrently(a, b)
}
