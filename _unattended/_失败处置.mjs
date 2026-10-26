/**
 * 失败处置矩阵（施工文档 D20）—— **唯一真源**。
 *
 * 为什么要有这个文件（2026-10-23 复盘）：
 *   ① 撞顶（`thinking-overflow-final`）当时**不在 `RESCUE_ABLE` 里** ⇒ 降档还撞就直接判死，
 *      连"换个更强的模型试试"都没试 —— 判决与动作两处写着，新判决接不进老动作；
 *   ② `_crew\agents.json` 里那张「失败处置」表**没有任何代码读**（全仓 grep = 0 处），
 *      改它的人以为行为变了，其实没变；
 *   ③ "建议大脑做什么"只有一句人话，没有机器可读的落点。
 *
 * 所以把 `判决 → 编排自动干什么 → 还不够时建议大脑干什么` 收成这一张表，
 * 三个消费方（`judge` 的 action 文案 / `RESCUE_ABLE` / `FAIL_OK` 与换家判定）都从它派生。
 *
 * 字段
 *   verdict  判决名（与 `编排.mjs` 的 `judge()` 返回值一一对应）
 *   zh       人话（拼进 action，不再各处手写）
 *   auto     编排自动做什么：`downgrade` 降一档 ／ `rescue` 拉急救 ／ `hold` 不动等 ／ `abort` 整轮停手
 *   failover 还允不允许**换家**（额度切换引擎）；默认 false，只有老行为确实是"换家有可能好"的才 true
 *   next     建议大脑的下一步：`retry` ／ `rescue` ／ `resume` 续跑 ／ `edit-card` 改卡 ／ `wait-user` ／ `none`
 *   suggest  给人看的一句话（没有就不编）
 *   note     补充说明（拼进 action 尾巴）
 *
 * ⚠️ 加新判决的顺序：**先在这里加一行**，否则 `起飞前检查` 会红（故意这么设计：让"新判决没人管"不可能悄悄发生）。
 */

/** 「收下了」的判决：这单已经有着落，编排不再对它做任何自动动作（也不换家）。 */
export const OK_VERDICTS = ['ok', 'dry-run', 'quota-switched', 'rescued', 'ctx-full-reviewed']

export const MATRIX = [
  { verdict: 'flaky',
    zh: '偶发失败（无信封 / 信封读不出 / 传输断）',
    // ★ 2026-10-26（§六）：传输类**不换家**。同载体、能续会话就续，只重试 1 次。
    auto: 'retry', failover: false, next: 'none',
    suggest: null,
    note: '同通道重试 1 次（换 prompt、能续会话就续）；还不行就归到 flaky-twice' },

  { verdict: 'thinking-overflow',
    zh: '撞顶（想太多：正文 0 字、工具 0 次）',
    auto: 'downgrade', failover: false, next: 'none',
    suggest: null,
    note: '降档只降一次；再撞就进下一行' },

  { verdict: 'thinking-overflow-final',
    zh: '降档后仍然撞顶',
    auto: 'rescue', failover: false, next: 'none',
    suggest: '急救也不行 ⇒ 拆卡 / 缩范围（把工作量砍到能装进输出预算）',
    note: '换模型是这个问题**唯一还能自动试**的一步' },

  { verdict: 'timeout',
    zh: '跑满超时被收尾掐断',
    auto: 'hold', failover: false, next: 'resume',
    suggest: '续跑（同一会话，收据里有 sessionId）或拆小',
    note: '产物已保留；续跑比重派一张新卡便宜得多' },

  { verdict: 'flaky-twice',
    zh: '同通道重试 1 次后仍失败',
    // ★ 2026-10-26（§六 删/并/退）：**删除 `flaky-twice` 的模型切换资格**。
    //   传输类问题换模型没用（换的是模型，坏的是通道）。已经是"重试过一次"了 ⇒ 停手、交人/改卡。
    auto: 'hold', failover: false, next: 'edit-card',
    suggest: '换通道/换会话可以，但**不要再换模型**；连着两次断说明不是模型的问题',
    note: '原有"急救+换家"链条已按 §六 收窄' },

  // ★ 2026-10-26（限流拆分）：原来 429 被并进 `account`（额度/限流/坏 key 一行），
  //   一次限流就"整轮停手"或"立刻换 API"。实测本机 490 个 DSH 会话 2745 次重试里
  //   **RATE_LIMIT 占 73%**（TRANSPORT 550 / TIMEOUT 173）—— 限流是**等一等就好**的抖动，
  //   不是账号故障。所以拆成两行：先退避重试（这一行），仍被限流才换 API（下一行）。
  //   判定规则见 `_退避.mjs` 的 `classifyRetryableFailure()`（纯函数，有单测）。
  { verdict: 'rate-limit',
    zh: '限流（429 / RATE_LIMIT / too many requests）',
    auto: 'retry', failover: false, next: 'none',
    suggest: null,
    note: '退避后**同通道**重试 1 次：服务端给了 Retry-After 就听它的，否则 20s 起、翻倍、封顶 60s 带抖动；不换家、不换模型' },

  { verdict: 'rate-limit-final',
    zh: '退避重试后仍被限流',
    auto: 'api-switch', failover: true, next: 'wait-user',
    suggest: '换**同款模型**的下一个 API（仍不换模型）；一家全挂就停这个角色，其他角色继续',
    note: '限流持续说明这条通道在节流 ⇒ 换通道比继续等有效；仍限定 same-model' },

  { verdict: 'input-error',
    zh: '卡 / 派活本身有问题',
    // ★ 2026-10-26（§六 删/并/退）：**删除 `input-error` 的 rescue/failover**。
    //   卡写错了，换多强的模型都修不好 —— 只会把钱烧在一个不该启动的调用上。
    //   所以这里的动作是"改卡重派"，而且**不产生模型调用**（preflight 就该拦住）。
    auto: 'edit-card', failover: false, next: 'edit-card',
    suggest: '改卡重派（不需要也不允许急救/换模型）',
    note: '§六：input-error/quota/env/权限/timeout/filtered/代码红 —— 都不急救' },

  { verdict: 'ac-red',
    zh: '验收机判红了',
    auto: 'hold', failover: false, next: 'edit-card',
    suggest: '改卡或返工（收据里有红的原话与命令）',
    note: '红灯不许进 review（已有）' },

  { verdict: 'ac-env',
    zh: '环境类（旧判决名，新代码请用下面两个）',
    auto: 'hold', failover: false, next: 'wait-user',
    suggest: null,
    note: '保留只为兼容老收据；新代码一律用 ac-env-workspace / ac-env-credential' },

  // ★ 2026-10-23（§5.1）：环境类拆两类 —— 只有"要身份"的才等人，缺工具的自己派卡去装
  { verdict: 'ac-env-workspace',
    zh: '环境类·工作区缺口（缺包 / 缺工具 / 命令不存在）',
    auto: 'hold', failover: false, next: 'env-card',
    suggest: '派一张 ENV-<工具> 卡去装；装完记 pending-reboot 或直接重派原卡',
    note: '"要管理员"不是障碍（大脑就是管理员），别报人' },

  { verdict: 'ac-env-credential',
    zh: '环境类·凭据缺失（缺 key / 要注册 / 要付款）',
    auto: 'hold', failover: false, next: 'wait-user',
    suggest: null,
    note: '这是全系统**唯一**允许当场搁置等人的三种事' },

  { verdict: 'ac-unknown',
    zh: '机器认不出的失败（第 0 级没命中）',
    auto: 'hold', failover: false, next: 'diagnose',
    suggest: '走诊断阶梯：先看证据包，判不出再上诊断卡（每波 ≤1 次），不许直接报人',
    note: '原来直接 wait-user —— 会把人当排障工' },

  { verdict: 'ac-missing',
    zh: '任务卡没有可执行验收（项目要求 requireAC）',
    auto: 'hold', failover: false, next: 'edit-card',
    suggest: '给这张卡补一条**能跑的**验收命令（或把项目改成不要求 AC）',
    note: '不许进 done（已有）' },

  { verdict: 'level-skip-review',
    zh: '按分级跳过审核（L1/L2，不是失败）',
    auto: 'none', failover: false, next: 'none',
    suggest: null,
    note: '记进做轮标记用，不用处置' },

  { verdict: 'denied',
    zh: '权限被拒',
    auto: 'hold', failover: false, next: 'edit-card',
    suggest: '改卡的权限 / 白名单',
    note: '被拒条目一票否决（已有）' },

  { verdict: 'filtered',
    zh: '内容被拦',
    auto: 'hold', failover: false, next: 'retry',
    suggest: '换新会话重试 1 次（别续会话，会把被拦内容再发一遍）',
    note: '已有' },

  { verdict: 'account',
    zh: '额度 / 限流 / 坏 key',
    // ★ 2026-10-26（§六 / §零.7）：额度类**只换同款模型的下一个 API**，绝不自动换模型。
    //   `failover:true` 只表示"允许走额度切换引擎"，引擎内部必须限定 same-model（见 API_SWITCH_VERDICTS）。
    auto: 'api-switch', failover: true, next: 'wait-user',
    suggest: '同款模型换下一个 API；一家全挂就停这个角色，其他角色继续',
    note: '没有同款模型的可用 API 时才停这个角色（不换模型）' },

  // ───────────── 2026-10-26（§六）新增：原表缺的三类 ─────────────

  { verdict: 'no-start',
    zh: '启动失败 / 120 秒无首个事件（no ack）',
    auto: 'retry', failover: false, next: 'none',
    suggest: '杀进程树，同载体重试 1 次；仍失败 ⇒ blocked',
    note: '不能续会话（它压根没起来），所以是冷重试而不是 resume' },

  { verdict: 'capability',
    zh: '能力不足（窗口/输出不够、压缩风暴、明显卡在能力边界）',
    auto: 'rescue', failover: false, next: 'none',
    suggest: '能力路由到满足要求的模型/API 1 次；没有就拆卡',
    note: '**急救只留给这一类**：reason=capability-escalation，每卡最多 1 次，计入 6 次预算' },

  { verdict: 'budget-exhausted',
    zh: '每卡每 run 的 6 次编码调用用完',
    auto: 'abort', failover: false, next: 'wait-user',
    suggest: 'blocked，附已试路径和下一步（拆卡 / 缩范围 / 人工接手）',
    note: '预算耗尽≠可以无限试；也不许靠新 run 偷偷续命' },

  { verdict: 'kill-intent',
    zh: '大脑主动掐（有 kill-intent.json）',
    auto: 'none', failover: false, next: 'resume',
    suggest: '保留产物/会话，标 aborted-by-brain；下次优先 resume',
    note: '不判 flaky、不算模型失败（§六「掐进程协议」）' }
]

/** 急救链跑完后的三个结果（不是 `judge()` 返回的，是编排合成的）——也给它下一动作。 */
const RESCUE_OUTCOMES = {
  rescued: { next: 'none', zh: '急救已解决', suggest: null },
  'rescue-uncertain': { next: 'none', zh: '急救疑似干完（有产物、没被掐断）', suggest: '重点核交付物' },
  'rescue-failed': { next: 'edit-card', zh: '急救也没解决', suggest: '拆卡 / 缩范围，或人工接手' }
}

const BY = new Map(MATRIX.map((m) => [m.verdict, m]))

/** 查一行（查不到返回 null —— 调用方要自己决定怎么办，别在这里编）。 */
export function forVerdict (verdict) {
  return BY.get(String(verdict ?? '')) ?? null
}

export function autoOf (verdict) {
  return forVerdict(verdict)?.auto ?? (OK_VERDICTS.includes(String(verdict)) ? 'none' : null)
}

/** 建议大脑的下一步（`none` = 机器自己会处理完，`wait-user` = 等人，不是等大脑）。 */
export function nextOf (verdict) {
  const v = String(verdict ?? '')
  const m = BY.get(v)
  if (m) return m.next ?? 'wait-user'
  if (RESCUE_OUTCOMES[v]) return RESCUE_OUTCOMES[v].next
  return OK_VERDICTS.includes(v) ? 'none' : 'wait-user'
}

/** 给人看的一句建议（没有就 null，**不编**）。 */
export function suggestOf (verdict) {
  const v = String(verdict ?? '')
  const m = BY.get(v)
  if (m) return m.suggest ?? null
  return RESCUE_OUTCOMES[v]?.suggest ?? null
}

/** 判决的人话（`judge` 拼 action 用；查不到就回判决名本身）。 */
export function zhOf (verdict) {
  const v = String(verdict ?? '')
  const m = BY.get(v)
  if (m) return m.note ? `${m.zh}（${m.note}）` : m.zh
  if (RESCUE_OUTCOMES[v]) return RESCUE_OUTCOMES[v].zh
  return v
}

/** 该拉急救的判决（原 `RESCUE_ABLE`）。★ 2026-10-26（§六）：只剩能力型 —— 见 `RESCUE_VERDICTS` */
export function rescueAble () {
  return [...RESCUE_VERDICTS]
}

// ─────────────────────────────────────────────────────────────────────────────
// 2026-10-26（§六「急救收窄 / 恢复策略」）：动作权限表
//
// 为什么要单独一层：`auto` 只说"大概干什么"，但"能不能换家 / 能不能换模型 / 算不算预算"
// 是三件独立的事，原来挤在一个 `failover` 布尔里，于是"额度失败自动换模型"就藏进去了。
// 现在拆开，谁都不许再自己拼。
// ─────────────────────────────────────────────────────────────────────────────

/** **急救**只给能力型失败（每卡最多 1 次，reason 固定为 capability-escalation） */
export const RESCUE_VERDICTS = Object.freeze(['capability', 'thinking-overflow-final'])

/** **额度/限流/坏 key** 才允许"换同款模型的下一个 API" */
// ★ 2026-10-26：`rate-limit-final` 也进来（退避重试过还限流 ⇒ 换通道）；
//   `rate-limit`（首跳）**不进来** —— 首跳只许退避重试，不许烧别的家。
export const API_SWITCH_VERDICTS = Object.freeze(['account', 'rate-limit-final'])

/** **只有能力不足**才允许换模型（换到更强的/窗口更大的） */
export const MODEL_SWITCH_VERDICTS = Object.freeze(['capability'])

/** 这些判决**永远不许**急救 / 换模型 / 换家（§六「不急救」清单） */
export const NEVER_RESCUE = Object.freeze([
  'input-error', 'account', 'ac-env-workspace', 'ac-env-credential', 'ac-env',
  'denied', 'timeout', 'filtered', 'ac-red', 'ac-unknown', 'ac-missing',
  'flaky', 'flaky-twice', 'no-start', 'budget-exhausted', 'kill-intent',
  'rate-limit', 'rate-limit-final'
])

/** 急救理由（写进 attempt 收据，机器可查） */
export const RESCUE_REASON = 'capability-escalation'
/** 每卡每次 run 最多编码调用数（§六）—— 与 `_状态库.mjs` 的 CODING_BUDGET 同值，这里给纯函数用 */
export const CODING_BUDGET = 6
/** 每卡最多急救次数（§六） */
export const RESCUE_PER_TASK = 1

/**
 * 这个判决能不能急救？
 * 三重条件：在急救名单里、**不在**永不急救名单里、不是 OK 判决。
 */
export function canRescue (verdict) {
  const v = String(verdict ?? '')
  if (OK_VERDICTS.includes(v)) return false
  if (NEVER_RESCUE.includes(v)) return false
  return RESCUE_VERDICTS.includes(v)
}

/** 能不能换家（= 允许走额度切换引擎；引擎内部必须限定同款模型） */
export function canSwitchApi (verdict) {
  return API_SWITCH_VERDICTS.includes(String(verdict ?? ''))
}

/** 能不能换模型（只有能力型） */
export function canSwitchModel (verdict) {
  return MODEL_SWITCH_VERDICTS.includes(String(verdict ?? ''))
}

/** 这次调用算不算进 6 次预算（judge/审核/裁判不算） */
export function countsBudget ({ verdict = null, attemptKind = null } = {}) {
  if (attemptKind === 'judge') return false
  const v = String(verdict ?? '')
  if (v === 'kill-intent') return false // 大脑主动掐：不算模型失败，也不吃预算
  return true
}

/** 该换家的判决（原来叫 `NO_FAILOVER`，是反着写的；这里给出正面口径）。 */
export function failoverAllowed (verdict) {
  const v = String(verdict ?? '')
  if (OK_VERDICTS.includes(v)) return false
  const m = BY.get(v)
  return m ? m.failover === true : false
}

/** 起飞前检查用：这些判决里哪些**没在表里**（返回缺失清单，空 = 全齐）。 */
export function missingFrom (verdicts = []) {
  const known = new Set([...MATRIX.map((m) => m.verdict), ...OK_VERDICTS, ...Object.keys(RESCUE_OUTCOMES)])
  return [...new Set(verdicts.map(String))].filter((v) => v && !known.has(v)).sort()
}

// ─────────────────────────────────────────────────────────────────────────────
// 以下：2026-10-23 施工（§4.3 / §4.4 / §5）—— 症状库 + 对账四分类 + 动作映射
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 症状库（SIGNATURES）—— **第 0 级归因**，零成本。
 *
 * 纪律：这里只放"看了原文就能确定"的模式，**不猜**。命中就给类型，没命中才上证据包/诊断卡。
 * 每条：{ id, kind, re, zh }
 *   kind = 'env-workspace'（工作区缺口，派卡去装）｜'code'（代码问题，返工）
 */
export const SIGNATURES = [
  { id: 'env-package', kind: 'env-workspace', zh: '缺依赖包',
    re: /ModuleNotFoundError|No module named|Cannot find module|npm ERR! 404|Could not find a version/i },
  { id: 'env-tool', kind: 'env-workspace', zh: '缺命令/工具',
    re: /command not found|不是内部或外部命令|无法将.{0,20}识别为|is not recognized as an internal or external/i },
  { id: 'env-docker', kind: 'env-workspace', zh: 'Docker 不可用',
    re: /Cannot connect to the Docker daemon|error during connect|docker: command not found|docker daemon is not running/i },
  { id: 'env-port', kind: 'env-workspace', zh: '端口被占用',
    re: /EADDRINUSE|address already in use|端口.{0,6}占用/i },
  { id: 'env-perm', kind: 'env-workspace', zh: '权限被拒',
    re: /PermissionError|EACCES|Access is denied|拒绝访问|需要管理员/i },
  { id: 'env-network', kind: 'env-workspace', zh: '网络不通',
    re: /ETIMEDOUT|ENOTFOUND|ECONNREFUSED|getaddrinfo|Could not resolve host/i },
  { id: 'code-syntax', kind: 'code', zh: '语法错',
    re: /SyntaxError|IndentationError|Unexpected token|unexpected indent/i },
  { id: 'code-assert', kind: 'code', zh: '断言失败',
    re: /AssertionError|assert.{0,20}failed|期望.{0,20}实际|expected.{0,20}got/i }
]

/** 命中返回 { id, kind, zh }，没命中返回 null（**不猜**）。 */
export function signatureOf (text) {
  const s = String(text ?? '')
  if (!s) return null
  for (const sig of SIGNATURES) if (sig.re.test(s)) return { id: sig.id, kind: sig.kind, zh: sig.zh }
  return null
}

/** 对账结果的五种（`real-fail` / `derelict` / `conflict` / `misreport` / `unknown`）。 */
export const AC_TYPES = ['real-fail', 'derelict', 'conflict', 'misreport', 'unknown']

/**
 * 对账结果 → 下一步动作（脑子：这是"谁修"的分派表，见施工文档 §5）。
 *   real-fail / derelict → rework（续会话补做）
 *   conflict / misreport → audit（交裁判审，查假绿/环境差异/谎报）
 *   unknown              → diagnose（证据包 + 诊断阶梯）
 */
export function actionForReconcile (kind) {
  const k = String(kind ?? '')
  if (k === 'real-fail') return { next: 'rework', zh: '真没做对 → 续会话补做' }
  if (k === 'derelict') return { next: 'rework', zh: '没跑卡里那条 → 续会话补做并要求自测留痕' }
  if (k === 'conflict') return { next: 'audit', zh: '它说绿机器红 → 交裁判审' }
  if (k === 'misreport') return { next: 'audit', zh: '自己红却说绿 → 不返工，交裁判审' }
  return { next: 'diagnose', zh: '认不出 → 证据包 + 诊断阶梯' }
}
