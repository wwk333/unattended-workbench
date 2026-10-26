/**
 * 契约/枚举 —— **四套状态枚举，禁止复用**（施工文档 §零.2）
 *
 * 为什么单独一个文件：这四套值是全系统的"词表"。以前 `done` 既指任务完成、又被人当"验收通过"用，
 * `blocked` 被写进 attempt 收据，`completed` 和 `accepted` 混着念 —— 结果同一件事三个说法。
 * 现在把词表冻结在一处，任何写状态的地方都必须 import 这里的 `assertState()`，不许自己拼字符串。
 *
 * 铁律：
 *   · task     = 任务生命周期：pending / ready / doing / review / done / blocked / dropped
 *   · run      = 一次编排运行：running / completed / aborted / failed
 *   · attempt  = 一次载体调用：running / completed / failed / aborted
 *   · release  = 交付放行：blocked / ready / accepted / rejected / stale
 *   · `blocked` 只属 task / release；**不属于** run / attempt
 *   · `done`（任务完成）≠ `accepted`（用户验收）≠ `completed`（run/attempt 正常收口）
 */

/** 四套枚举（顺序即状态机大致走向，消费方不要依赖顺序做判断） */
export const ENUMS = Object.freeze({
  task: Object.freeze(['pending', 'ready', 'doing', 'review', 'done', 'blocked', 'dropped']),
  run: Object.freeze(['running', 'completed', 'aborted', 'failed']),
  attempt: Object.freeze(['running', 'completed', 'failed', 'aborted']),
  release: Object.freeze(['blocked', 'ready', 'accepted', 'rejected', 'stale'])
})

/** 允许出现 `blocked` 的两层（其余层出现即契约违规） */
export const BLOCKED_OWNERS = Object.freeze(['task', 'release'])

/** 各层的终态：到了就不再有出边 */
export const TERMINAL = Object.freeze({
  task: Object.freeze(['done', 'dropped']),
  run: Object.freeze(['completed', 'aborted', 'failed']),
  attempt: Object.freeze(['completed', 'failed', 'aborted']),
  release: Object.freeze([]) // release 没有真终态：accepted 之后代码变了还会 stale
})

/**
 * 合法迁移表。未列出的 (from → to) 一律拒绝。
 * `doing → pending` 是 §三 的 doing 残留自愈（不带这条，自愈就只能删文件了）。
 */
export const TRANSITIONS = Object.freeze({
  task: Object.freeze({
    pending: ['ready', 'blocked', 'dropped'],
    ready: ['doing', 'blocked', 'dropped', 'pending'],
    doing: ['review', 'blocked', 'pending', 'dropped'],
    review: ['done', 'blocked', 'doing', 'dropped'],
    done: ['review', 'blocked'],
    blocked: ['ready', 'pending', 'dropped'],
    dropped: ['pending', 'ready']
  }),
  run: Object.freeze({
    running: ['completed', 'aborted', 'failed'],
    completed: [],
    aborted: [],
    failed: []
  }),
  attempt: Object.freeze({
    running: ['completed', 'failed', 'aborted'],
    completed: [],
    failed: [],
    aborted: []
  }),
  release: Object.freeze({
    blocked: ['ready', 'rejected'],
    ready: ['accepted', 'rejected', 'blocked', 'stale'],
    accepted: ['stale'],
    rejected: ['blocked', 'ready', 'stale'],
    stale: ['blocked', 'ready', 'rejected']
  })
})

/** `unknown` 是一个**合法的观测值**，但永远不是一个合法状态值 —— 它不是任何一套枚举成员 */
export const UNKNOWN = 'unknown'

export class StateError extends Error {
  constructor (kind, value, why) {
    super(`[枚举] ${why}（kind=${kind} value=${JSON.stringify(value)}）`)
    this.name = 'StateError'
    this.kind = kind
    this.value = value
    this.code = 'E_STATE'
  }
}

/**
 * **从 from 走到 to 的合法路径**（BFS 最短），返回中间要经过的状态数组（不含 from，含 to）。
 *
 * 为什么需要它（2026-10-26 真项目 beidanci 首跑当场卡住）：
 * 状态机要求 `pending → ready → doing`，但台账/编排都是**一步到位**写 `doing`，
 * 于是服务端回 `非法状态迁移：pending → doing` ⇒ **第一张卡永远推不动**。
 * 修法不是放宽状态机（那会毁掉"必须先 ready 才能开工"的护栏），而是**让调用方自己走完路径**。
 *
 * 不可达返回 `null`（调用方据此报错，别静默改成别的状态）。
 */
export function transitionPath (kind, from, to) {
  if (from === to) return []
  const table = TRANSITIONS[kind]
  if (!table) return null
  const prev = new Map([[from, null]])
  const q = [from]
  while (q.length) {
    const cur = q.shift()
    for (const next of table[cur] ?? []) {
      if (prev.has(next)) continue
      prev.set(next, cur)
      if (next === to) {
        const path = [to]
        let p = cur
        while (p !== null && p !== undefined) { path.unshift(p); p = prev.get(p) }
        return path.slice(1)   // 去掉 from
      }
      q.push(next)
    }
  }
  return null
}

export function isKind (kind) {
  return Object.hasOwn(ENUMS, kind)
}

/** 是否合法状态值（不抛，给校验器用） */
export function isValidState (kind, value) {
  if (!isKind(kind)) return false
  return typeof value === 'string' && ENUMS[kind].includes(value)
}

/** 断言合法，否则抛 StateError。所有写方在落库前必须过这一关。 */
export function assertState (kind, value) {
  if (!isKind(kind)) throw new StateError(kind, value, `不认识的层：${kind}（只有 task/run/attempt/release）`)
  if (typeof value !== 'string') throw new StateError(kind, value, '状态必须是字符串')
  if (value === UNKNOWN) {
    throw new StateError(kind, value, '`unknown` 是观测值，不是状态值：观测层写 unknown，状态层不许写')
  }
  if (value === 'blocked' && !BLOCKED_OWNERS.includes(kind)) {
    throw new StateError(kind, value, '`blocked` 只属于 task/release，run/attempt 不许写 blocked')
  }
  if (!ENUMS[kind].includes(value)) {
    // 这条最容易踩：把别的层的枚举值抄过来（run=done / attempt=blocked / release=completed）
    const owners = Object.entries(ENUMS).filter(([, list]) => list.includes(value)).map(([k]) => k)
    const hint = owners.length ? `；该值属于 ${owners.join('/')} 层，不能用于 ${kind}` : ''
    throw new StateError(kind, value, `不是 ${kind} 的合法值${hint}`)
  }
  return value
}

/** 迁移是否合法（不抛） */
export function canTransition (kind, from, to) {
  if (!isKind(kind)) return false
  if (!isValidState(kind, from) || !isValidState(kind, to)) return false
  return (TRANSITIONS[kind][from] ?? []).includes(to)
}

/** 断言迁移合法，否则抛 StateError */
export function assertTransition (kind, from, to) {
  assertState(kind, from)
  assertState(kind, to)
  if (from === to) throw new StateError(kind, `${from}→${to}`, '同值迁移不是状态变更，调用方搞错了')
  if (!canTransition(kind, from, to)) {
    throw new StateError(kind, `${from}→${to}`, `非法迁移：${kind} 的 ${from} 不许直接到 ${to}`)
  }
  return to
}

export function isTerminal (kind, value) {
  return isKind(kind) && (TERMINAL[kind] ?? []).includes(value)
}

/**
 * 跨层同义混淆防护：`done` / `accepted` / `completed` 是三个不同事实。
 * 看板/交付门/审核文案里凡是要说"完事了"的地方，调这里拿准确措辞，不许自己写。
 */
export function completionWord (kind, value) {
  if (kind === 'task' && value === 'done') return 'done（任务完成）'
  if (kind === 'attempt' && value === 'completed') return 'completed（本次调用正常收口）'
  if (kind === 'run' && value === 'completed') return 'completed（本轮编排正常收口）'
  if (kind === 'release' && value === 'accepted') return 'accepted（用户已验收）'
  return `${kind}=${value}`
}
