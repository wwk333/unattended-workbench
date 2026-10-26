/**
 * 契约/画像 —— **Pi profile 按"载体 + API + 模型"命名**（施工文档 §零.4 / §五）
 *
 * 一条 profile 长这样：
 *   { "name": "coder-a-heavy", "carrier": "pi", "provider": "ark", "model": "deepseek-v4.1-flash",
 *     "contextPct": 100, "compactionPct": 70 }
 *
 * 命名规则（本文件是唯一实现）：
 *   · 结构键 `carrier|provider|model` —— 作用域是"载体 + API + 模型"，三者任一不同就是**不同** profile；
 *   · 同一载体同一时间只跑一个任务（`maxConcurrent=1`）；不同 profile 要**排队**，
 *     只在两个 attempt 之间切配置，绝不并发写 `models.json/settings.json`；
 *   · 角色/级模型只**引用** profile 名，不各写一份 Pi 配置。
 *
 * 本文件只管"名字、作用域、并发资格"；派生值（reserve/maxTokens/trigger）在 §五 阶段落地到
 * `_unattended/_能力.mjs`，这里不重复算 —— 一份事实只许一处实现。
 */

export const PROFILE_KEY_SEP = '|'
export const DEFAULT_CONTEXT_PCT = 100
// ★ 2026-10-26（用户拍板，D-09 结案）：**不分重/轻任务**，默认就用 60% 的最大上下文。
//   原默认 70% ⇒ 1M 窗口只留 300K 输出，还要再减 4096 安全边距 ⇒ 变成 295,904，
//   和文档"重任务至少 300K"打架。改 60% ⇒ 留 400,000，够用且不用再分重/轻。
export const DEFAULT_COMPACTION_PCT = 60
export const ALLOWED_CONTEXT_PCT = Object.freeze([30, 60, 100])
export const ALLOWED_COMPACTION_PCT = Object.freeze([50, 60, 70, 80])
/** 同一载体并发上限：文档明写 1（未来要并行必须每 attempt 独立 PI_CODING_AGENT_DIR，当前不做） */
export const CARRIER_MAX_CONCURRENT = Object.freeze({ pi: 1, opencode: 1, codebuddy: 1, qwencode: 1, codewhale: 1, codex: 1 })

export class ProfileError extends Error {
  constructor (why, detail) {
    super(`[profile] ${why}${detail ? `（${detail}）` : ''}`)
    this.name = 'ProfileError'
    this.code = 'E_PROFILE'
  }
}

function norm (v) {
  return String(v ?? '').trim()
}

/** 结构键：`carrier|provider|model` —— 全系统唯一写法 */
export function profileKey ({ carrier, provider, model }) {
  const c = norm(carrier)
  const p = norm(provider)
  const m = norm(model)
  if (!c) throw new ProfileError('profile 缺载体 carrier')
  if (!p) throw new ProfileError('profile 缺 API provider（同一模型不同 API 各算一份能力）')
  if (!m) throw new ProfileError('profile 缺模型 model')
  if ([c, p, m].some(x => x.includes(PROFILE_KEY_SEP))) {
    throw new ProfileError('载体/API/模型里不许含分隔符 `|`', `${c}|${p}|${m}`)
  }
  return [c, p, m].join(PROFILE_KEY_SEP)
}

/** 反解结构键 */
export function parseProfileKey (key) {
  const parts = String(key ?? '').split(PROFILE_KEY_SEP)
  if (parts.length !== 3 || parts.some(x => !x)) {
    throw new ProfileError(`profile key 必须是 carrier${PROFILE_KEY_SEP}provider${PROFILE_KEY_SEP}model`, String(key))
  }
  return { carrier: parts[0], provider: parts[1], model: parts[2] }
}

/** 把一条 profile 规整成登记形态（补默认值、校验枚举、算结构键） */
export function normalizeProfile (p) {
  if (!p || typeof p !== 'object') throw new ProfileError('profile 必须是对象')
  const carrier = norm(p.carrier)
  const provider = norm(p.provider)
  const model = norm(p.model)
  const key = profileKey({ carrier, provider, model })
  const contextPct = p.contextPct === undefined || p.contextPct === null ? DEFAULT_CONTEXT_PCT : Number(p.contextPct)
  const compactionPct = p.compactionPct === undefined || p.compactionPct === null ? DEFAULT_COMPACTION_PCT : Number(p.compactionPct)
  if (!ALLOWED_CONTEXT_PCT.includes(contextPct)) {
    throw new ProfileError(`上下文比例只允许 ${ALLOWED_CONTEXT_PCT.join('/')}%`, String(contextPct))
  }
  if (!ALLOWED_COMPACTION_PCT.includes(compactionPct)) {
    throw new ProfileError(`压缩阈值只允许 ${ALLOWED_COMPACTION_PCT.join('/')}%`, String(compactionPct))
  }
  const name = norm(p.name) || key
  return {
    schema: 1,
    kind: 'model-profile',
    at: p.at ?? new Date().toISOString(),
    source: p.source ?? '契约/画像.mjs',
    state: p.state ?? 'active',
    stale: p.stale === true,
    name,
    key,
    carrier,
    provider,
    model,
    contextPct,
    compactionPct
  }
}

/** 从 agents.json 的 modelProfiles 段建索引；结构键重复即失败（一个作用域只能有一份） */
export function indexProfiles (profiles) {
  const list = Array.isArray(profiles) ? profiles : Object.values(profiles ?? {})
  const byKey = new Map()
  const byName = new Map()
  for (const raw of list) {
    const p = normalizeProfile(raw)
    if (byKey.has(p.key)) throw new ProfileError('同一 carrier|provider|model 登记了两份 profile', p.key)
    byKey.set(p.key, p)
    if (byName.has(p.name)) throw new ProfileError('profile 重名', p.name)
    byName.set(p.name, p)
  }
  return { byKey, byName, list: [...byKey.values()] }
}

/** 按"载体 + API + 模型"取 profile；取不到就抛（不许静默走默认 128K/16K） */
export function profileOf (profiles, { carrier, provider, model }) {
  const idx = profiles instanceof Map ? { byKey: profiles } : indexProfiles(profiles)
  const key = profileKey({ carrier, provider, model })
  const p = idx.byKey.get(key)
  if (!p) throw new ProfileError('该作用域没有 profile —— 不许退回 Pi 默认 128K/16K', key)
  return p
}

/** 载体的并发名额（文档：同一载体 maxConcurrent=1） */
export function maxConcurrentOf (carrier) {
  const c = norm(carrier)
  const v = CARRIER_MAX_CONCURRENT[c]
  return Number.isFinite(v) ? v : 1 // 未登记的载体一律按 1：宁可排队，不许悄悄并行写配置
}

/**
 * 能不能同时开工两个 attempt？
 * @returns {{ ok: boolean, reason: string|null }}
 */
export function canRunConcurrently (a, b) {
  if (!a || !b) return { ok: false, reason: '缺 attempt' }
  const ca = norm(a.carrier)
  const cb = norm(b.carrier)
  if (ca && ca === cb) {
    return { ok: false, reason: `同一载体 ${ca} 不许并行（maxConcurrent=${maxConcurrentOf(ca)}）；不同 profile 排队，在两次 attempt 之间切配置` }
  }
  return { ok: true, reason: null }
}

/**
 * 切 profile 的顺序守卫：同一载体上，配置写入**只能发生在两个 attempt 之间**。
 * 传入"该载体当前正在跑的 attempt 数"，>0 就不许写。
 */
export function assertConfigWriteAllowed ({ carrier, runningAttempts = 0 }) {
  if (runningAttempts > 0) {
    throw new ProfileError(
      `载体 ${carrier} 还有 ${runningAttempts} 个 attempt 在跑，不许并发写 models.json/settings.json`,
      '配置写入只能发生在两个 attempt 之间'
    )
  }
  return true
}
