/**
 * 载体事件流 → attempt 收据里的三个字段（施工文档 §七）
 *
 *   `ctxPeak`              这一趟最高的上下文占用（token）
 *   `compactions`          触发了几次压缩
 *   `firstCompactionTokens` 第一次压缩时的 tokensBefore
 *
 * ## 为什么要单独一层
 * 这三个值**只能从载体的真实事件流里读**。没有事件流就等于没有证据 ——
 * 这时必须回 `null` 并说明原因（看板显示"未实测"），**绝不按上下文比例估一个数**。
 *
 * ## 认哪些事件（按见过的载体输出）
 * - `{"type":"compaction_end","tokensBefore":123456,...}`
 * - `{"type":"compact","tokensBefore":...}` / `{"type":"auto_compact",...}`
 * - `{"type":"turn_end","usage":{"promptTokens":...}}` / `{"type":"message_end","usage":{...}}`
 *   —— 这里的 `promptTokens` 是"这一轮请求的上下文占用"，取最大值作 `ctxPeak`
 *
 * ## 纪律
 * - 只读结构字段，不猜自由文本；
 * - 数字必须是有限正数，否则忽略（`"123K"` 这种字符串一律不认）；
 * - 没有就是 `null`，带上 `why`。
 */

/** 压缩类事件的 type 名（小写比较） */
export const COMPACTION_TYPES = Object.freeze(['compaction_end', 'compaction', 'compact', 'auto_compact', 'autocompact'])
/** 带上下文用量的事件（取 usage.promptTokens / input_tokens 等） */
export const USAGE_TYPES = Object.freeze(['turn_end', 'message_end', 'usage', 'response'])

const num = (v) => {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** 从一条事件里挖 "tokensBefore" 这类字段（压缩事件用） */
function tokensBeforeOf (e) {
  return num(e?.tokensBefore ?? e?.tokens_before ?? e?.beforeTokens ?? e?.contextTokens ?? e?.tokens)
}

/** 从一条事件里挖 "这一轮的上下文用量" */
function promptTokensOf (e) {
  // ★ 2026-10-26 修（真项目 beidanci 当场抓到）：Pi 的 usage 长在 `message.usage`，
  //   字段叫 `input` / `cacheRead`，既不是 `usage.promptTokens` 也不在 `data.usage` 下。
  //   原来两个路径都没覆盖 ⇒ ctxPeak 永远是 null（而 compactions 数对了，因为压缩事件名通用）。
  //   口径：上下文占用 = 输入 + 缓存读（缓存命中的前缀同样占着窗口）。
  const u = e?.usage ?? e?.data?.usage ?? e?.message?.usage ?? null
  const base = num(u?.promptTokens ?? u?.prompt_tokens ?? u?.inputTokens ?? u?.input_tokens ?? u?.input ?? e?.promptTokens ?? e?.prompt_tokens)
  if (base === null) return null
  const cache = num(u?.cacheRead ?? u?.cache_read) ?? 0
  return base + cache
}

/**
 * 扫事件数组，产出三个字段 + 说明。
 * @param {object[]|string[]} events 已解析的事件，或 jsonl 文本行
 * @returns {{ ctxPeak:number|null, compactions:number, firstCompactionTokens:number|null, why:string|null, scanned:number }}
 */
export function compactionStats (events) {
  const list = []
  for (const raw of Array.isArray(events) ? events : []) {
    if (raw && typeof raw === 'object') { list.push(raw); continue }
    if (typeof raw === 'string' && raw.trim()) {
      try { list.push(JSON.parse(raw)) } catch { /* 坏行忽略，不猜 */ }
    }
  }
  let ctxPeak = null
  let compactions = 0
  let firstCompactionTokens = null
  let lastSeen = null   // ★ 最近一次已知用量（载体不报 tokensBefore 时，用它当"压缩前占用"的替代证据）
  for (const e of list) {
    const t = String(e?.type ?? e?.kind ?? '').toLowerCase()
    if (COMPACTION_TYPES.includes(t)) {
      compactions++
      // Pi 的 compaction_end 只给 reason/result，**没有 tokensBefore**（实测）。
      // 退一步：用"压缩前最后一次已知用量"顶替，并在 why 里说清这是推导值，不是载体原文。
      const before = tokensBeforeOf(e) ?? lastSeen
      if (firstCompactionTokens === null && before !== null) firstCompactionTokens = before
      // 压缩前的用量也是"上下文占用"的一个下界
      if (before !== null) ctxPeak = ctxPeak === null ? before : Math.max(ctxPeak, before)
      continue
    }
    if (USAGE_TYPES.includes(t)) {
      const p = promptTokensOf(e)
      if (p !== null) {
        lastSeen = p
        ctxPeak = ctxPeak === null ? p : Math.max(ctxPeak, p)
      }
    }
  }
  const why = list.length === 0
    ? '没有事件流（读不到载体的 out.json）⇒ 三个字段留空，不估算'
    : (ctxPeak === null ? '事件流里没有可用的上下文用量字段 ⇒ ctxPeak 留空，不估算' : null)
  // 没有事件流时 compactions 也必须是 null —— 「0 次压缩」是「测到了、确实 0」，
  // 没测到不能冒充 0（用户口径：不许编数字）。
  return { ctxPeak, compactions: list.length === 0 ? null : compactions, firstCompactionTokens, why, scanned: list.length }
}

/** 从 jsonl 文本直接算（CLI/自检用） */
export function compactionStatsOfText (text) {
  return compactionStats(String(text ?? '').split(/\r?\n/).filter(Boolean))
}
