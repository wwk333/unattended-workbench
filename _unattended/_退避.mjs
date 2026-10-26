/**
 * 限流识别 + 退避（2026-10-26）—— **纯函数，可单测**。
 *
 * 为什么单开一个文件：
 *   实测（本机 490 个 DSH 会话、2745 次 `llm/retry`）失败码分布：
 *     RATE_LIMIT × 2009（73%） ／ TRANSPORT × 550 ／ TIMEOUT × 173 ／ SERVER × 13
 *   而 `judge()` 原来把 `429` 和 `401/403/quota` 归成一类（`account`）——
 *   一次限流就被当"账号坏了"：要么整轮停手，要么立刻换 API（烧掉一个还能用的家）。
 *   **限流的正解是"等一等再打"**，它和"没额度/坏 key"不是一回事。
 *
 * 为什么不写在 `_失败处置.mjs`：那张表是"判决 → 动作"的**数据**，
 *   这里放"怎么认出来 + 等多久"的**算法**。混在一起会让表越来越难读。
 *
 * ⚠️ 这里的判定只吃**失败证据面**（env.error / stderrTail），
 *   绝不吃回执正文 —— 否则 coder 在代码里写个 429 常量表就会被误判（2026-10-04 踩过）。
 */

/** 限流特征（**先判**：`rate limit exceeded` 同时命中 account 的 `exceeded`，必须先归限流） */
const RATE_LIMIT_RES = [
  /\b429\b/,
  /\brate[\s_-]?limit(ed|ing)?\b/i,
  /\btoo many requests\b/i,
  /限流|请求(过于|太)频繁|触发频率限制/,
]

/** 账号/额度特征（这些"等"没用，只能换 API 或换 key） */
const ACCOUNT_RES = [
  /\b401\b/,
  /\b403\b/,
  /\bunauthori[sz]ed\b/i,
  /\bforbidden\b/i,
  /\bquota\b/i,
  /\binsufficient\b/i,
  /\bexceeded\b/i,
  /\binvalid api key\b/i,
  /\bauthentication\b/i,
  /额度|余额不足|欠费|无可用额度/,
]

/**
 * 失败证据面 → 判决名。
 * @returns {'rate-limit'|'account'|null} null = 不归这两类（交给 flaky / 其它分支）
 */
export function classifyRetryableFailure (blob) {
  const s = String(blob ?? '')
  if (!s.trim()) return null
  for (const re of RATE_LIMIT_RES) if (re.test(s)) return 'rate-limit'
  for (const re of ACCOUNT_RES) if (re.test(s)) return 'account'
  return null
}

/** 只要"是不是限流"（调用方不想关心 account 时用） */
export function isRateLimit (blob) {
  return classifyRetryableFailure(blob) === 'rate-limit'
}

/**
 * 从报错原文里抠服务端给的等待时间（Retry-After）。
 * 认：`retry after 5` / `Retry-After: 5` / `retry_after=5` / `retry after 5s|500ms` / `请在 30 秒后重试`
 * 不认就算了（返回 null，调用方用默认退避）—— **不猜**。
 * @returns {number|null} 毫秒；夹在 [0, capMs]
 */
export function parseRetryAfterMs (blob, { capMs = 120_000 } = {}) {
  const s = String(blob ?? '')
  if (!s) return null
  const pats = [
    /retry[\s_-]*after[\s:：=]*(\d+(?:\.\d+)?)\s*(ms|milliseconds?|毫秒)/i,
    /retry[\s_-]*after[\s:：=]*(\d+(?:\.\d+)?)\s*(s|sec|secs|seconds?|秒)?/i,
    /(\d+(?:\.\d+)?)\s*秒(?:后|之后)?(?:再|重)?试/,
  ]
  for (const re of pats) {
    const m = s.match(re)
    if (!m) continue
    const n = Number(m[1])
    if (!Number.isFinite(n) || n < 0) continue
    const unit = String(m[2] ?? '').toLowerCase()
    const ms = /^(ms|millisecond)/.test(unit) ? n : n * 1000
    return Math.max(0, Math.min(capMs, Math.round(ms)))
  }
  return null
}

/**
 * 退避时长：第 1 次等 base，之后翻倍，封顶 cap；带比例抖动（防并行卡同时醒过来再撞限流）。
 * @param {number} attempt 1 起（1 = 第一次退避）
 */
export function backoffDelayMs (attempt, { baseMs = 20_000, capMs = 60_000, jitterRatio = 0.2, rng = Math.random } = {}) {
  const n = Math.max(1, Math.floor(Number(attempt) || 1))
  const raw = Math.min(capMs, baseMs * 2 ** (n - 1))
  const j = Math.max(0, Math.min(1, Number(jitterRatio) || 0))
  if (j === 0) return Math.round(raw)
  // 抖动只往下减，保证"最多等 raw"，不会超出上限
  const down = raw * j * Number(rng() || 0)
  return Math.max(0, Math.round(raw - down))
}

/**
 * 这一趟该等多久：服务端给了 Retry-After 就听它的，否则走默认退避。
 * @returns {{ ms: number, source: 'retry-after'|'backoff' }}
 */
export function waitPlan (blob, attempt, opts = {}) {
  const raft = parseRetryAfterMs(blob, opts)
  if (raft != null) return { ms: raft, source: 'retry-after' }
  return { ms: backoffDelayMs(attempt, opts), source: 'backoff' }
}
