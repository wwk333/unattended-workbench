/**
 * 事件流监控（D4 / D12）—— "**它在不在干活**"，不是"进程活着没有"。
 *
 * 为什么必须新写这一支（施工文档 D12 的真实问题）：
 *   看板的绿灯只证明**进程活着**。T1-01 #1 绿灯、进程活着、**8.6 分钟一个文件没写**（在思考里写代码），
 *   然后被 16384 截断 —— 8.6 分钟根本到不了 90 分钟超时，**现有超时和灯都抓不到它**。
 *
 * 判据取**事件流**（施工文档 D4 明写：不是文件时间）：
 *   `进度看护.mjs` 看的是 `runs/` 目录有没有新文件 —— 长任务在跑时目录本来就是安静的，8 分钟就假报。
 *   这里盯的是载体自己**边跑边写**的 `out.json`：只要它在**调工具**，这个文件就一直在长；
 *   而"只在想、不动手"（T1-01 #1 那种）**不长工具事件** ⇒ 这正是我们要抓的信号。
 *
 * 时间轴（同一个时钟 = 最后一次**有进展**）：
 *   10 分钟 🟡 只显示 ｜ 30 分钟 🔴 + 机械三查 ｜ 45 分钟 主动唤醒一次（批量）｜ 90 分钟 收尾（由编排的超时逻辑执行）
 *
 * ⚠️ 边界：本模块**不做判决**（不杀进程、不改台账），只出状态 + 叫一次人。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { wakeBrain } from './_唤醒.mjs'
import { capacityOf } from './模型能力.mjs'

/**
 * 载体"在调工具"的痕迹（各家事件名不同，**只认结构**，不认自由文字）。
 *
 * ★ 2026-10-27 修（真跑当场抓到的假黄灯）：原来只认**字段名形**（`"tool_use": {...}`），
 *   而 codebuddy 把工具类型写在 `type` 的**值**里 —— `{"type":"tool_use", "name":"Bash", ...}`。
 *   于是：一次真跑调了 **67 次工具**，监控数出来 **0 次** ⇒ 10 分钟准时黄灯、30 分钟红灯、
 *   45 分钟就会**真去唤醒大脑（花钱）**。灯在说谎，而"会撒谎的灯"比没有灯更坏（人会学会无视它）。
 *   证据（`beidanci/_crew/runs/2026-10-26T17-25-29/review/*.out.json`）：
 *     旧判据命中 **0** 行；`"type":"tool_use"` 出现 **67** 次 —— 和账本的 `toolCalls: 67` 正好一致。
 *
 * 两种形状都认，且**只认"调用开始"那一类**（不认 `tool_result`），理由有两条：
 *   ① 一次调用只算 1 次，`events` 才和账本的工具调用数对得上（codebuddy 的 `tool_result` 也是 67 次，
 *      两个都算就成了 134，翻倍的数字比没有数字更误导）；
 *   ② `_scan` 里还有一条"**同一调用 ≥5 次 ⇒ 判循环**"，它拿 `"name":"…"` 当指纹。
 *      结果行没有 `name`、只能退化用"前 80 字"当 key ⇒ 一堆结果行会撞成同一个 key ⇒ **假循环**。
 *
 * ⚠️ 旧的字段名形**一个字没动**：pi 那类载体照旧命中（真样本回归：14 行），别顺手"统一"掉。
 */
export const TOOL_EVENT_KEY = /"(?:tool_execution_start|tool_execution_end|tool_use|tool_call|tool_calls|function_call|tool_result|step_start|patch)"\s*:/
export const TOOL_EVENT_VALUE = /"type"\s*:\s*"(?:tool_use|tool_call|tool_calls|function_call|tool_execution_start)"/

/** 这一行是不是"在调工具"。@param {string} line @returns {boolean} */
export function isToolEvent (line) {
  const s = String(line ?? '')
  if (!s) return false
  return TOOL_EVENT_KEY.test(s) || TOOL_EVENT_VALUE.test(s)
}

/** 一段文本里有多少次工具调用（逐行判；给测试与"事后核账"用）。 */
export function countToolEvents (text) {
  return String(text ?? '').split(/\r?\n/).filter(l => isToolEvent(l)).length
}

/**
 * ★ D26：从一行事件里抠"这次请求的**输入**有多大"（含缓存命中段）。
 * 三家字段名不同：pi `input + cacheRead`；codebuddy `input_tokens + cache_*_input_tokens`；
 * opencode `prompt_tokens`。**只认含 usage/token 的行**，避免把工具参数里的 `"input"` 当用量。
 */
export function inputTokensOf (line) {
  if (!/usage|token/i.test(line)) return null
  const g = (re) => { const m = re.exec(line); return m ? Number(m[1]) : null }
  const base = g(/"input_tokens"\s*:\s*(\d+)/) ?? g(/"prompt_tokens"\s*:\s*(\d+)/) ?? g(/"input"\s*:\s*(\d+)/)
  if (base == null || !Number.isFinite(base)) return null
  const cache = (g(/"cache_creation_input_tokens"\s*:\s*(\d+)/) ?? 0) +
                (g(/"cacheRead"\s*:\s*(\d+)/) ?? g(/"cache_read_input_tokens"\s*:\s*(\d+)/) ?? 0)
  return base + cache
}

/**
 * 默认阈值。
 * ★ 2026-10-26（§七 删/并/退）：**删掉 `closeMin`** —— 它是死字段：
 *   没有任何消费方（阈值以 §六 的 timeout 为准），留着只会让人以为它还在管收尾。
 */
/**
 * 「产物在长吗？」—— 取**窗口起点那条采样**跟最新值比。
 *
 * 早先判据是 `lastSize > 0`（"曾经有字节"），于是"卡住了但日志还在刷"永远算有进展，
 * 这正是 §七 要治的假进展。现在：窗口内最早那条采样（不足窗口就用最早那条）与最新值比较，
 * `delta > 0` 才算长；采样不足 2 条 ⇒ 明说"无法判断"（不猜）。
 *
 * @param {{at:number,size:number}[]} samples 采样（按时间升序）
 * @param {number} now 现在
 * @param {number} windowMs 观察窗口（默认 10 分钟）
 * @param {number} [fallbackSize] 没有采样时的兜底值（首轮）
 * @returns {{ grew:boolean, delta:number, why:string }}
 */
export function grewSince (samples, now, windowMs = 10 * 60_000, fallbackSize = 0) {
  const list = (Array.isArray(samples) ? samples : []).filter(s => s && Number.isFinite(s.size))
  if (!list.length) return { grew: false, delta: 0, why: `还没有采样（当前 ${fallbackSize} 字节，不足以判断在长）` }
  const latest = list[list.length - 1]
  if (list.length < 2) return { grew: false, delta: 0, why: `只有 1 个采样（${latest.size} 字节），无法判断增量` }
  const inWindow = list.filter(s => now - s.at <= windowMs)
  const ref = inWindow.length ? inWindow[0] : list[0]
  if (ref === latest) return { grew: false, delta: 0, why: `窗口内只有 1 个采样（${latest.size} 字节），无法判断增量` }
  const delta = Number(latest.size) - Number(ref.size)
  return delta > 0
    ? { grew: true, delta, why: `近 ${Math.round(windowMs / 60000)} 分钟 +${delta} 字节` }
    : { grew: false, delta, why: `近 ${Math.round(windowMs / 60000)} 分钟没长（停在 ${latest.size} 字节）` }
}

export const DEFAULT_THRESHOLDS = { yellowMin: 10, redMin: 30, wakeMin: 45, wakeCap: 3 }

/**
 * 从 `_crew\调参\当前.json` 读生效阈值（D18 落地后由人采纳；读不到就用默认）。
 * ⚠️ 只客气地覆盖三个：黄/红/唤醒；收尾超时跟 §六 的 `--timeout-min` 走，不从这里来。
 */
export function thresholdsFrom (project, fallback = DEFAULT_THRESHOLDS) {
  try {
    const j = JSON.parse(readFileSync(join(project, '_crew', '调参', '当前.json'), 'utf8').replace(/^\uFEFF/, ''))
    const t = { ...fallback }
    const lamp = j?.lamp ?? {}
    if (Number(lamp.yellow) > 0) t.yellowMin = Number(lamp.yellow)
    if (Number(lamp.red) > 0) t.redMin = Number(lamp.red)
    if (Number(j?.N) > 0) t.wakeMin = Number(j.N)
    return t
  } catch { return fallback }
}

export class Monitor {
  /**
   * @param {object} o
   * @param {string} o.project  项目根
   * @param {Function} o.log    编排的日志函数
   * @param {number} o.intervalMs 轮询间隔（默认 10 秒；**零 token**、只读小文件）
   */
  constructor ({ project, log = () => {}, intervalMs = 10_000, thresholds = DEFAULT_THRESHOLDS }) {
    this.project = project
    this.log = log
    this.intervalMs = intervalMs
    this.th = { ...thresholds }
    this.cards = new Map()          // cardId → 状态
    this.timer = null
    this.wavesWoken = 0             // 本波已唤醒次数（护栏 5：每波封顶 3 次）
    // ★ 2026-10-26（§七「状态文件各归各」）：原来 `_监控` 也写 `_crew\看护状态.json` ——
    //   和 `进度看护.mjs` **同名双写**（两个写方、两份结论，看板读到哪份看运气）。
    //   现在各归各：卡片健康写 `卡片看护.json`，run 健康才是 `看护状态.json`（写方＝进度看护）。
    this.stateFile = join(project, '_crew', '卡片看护.json')
    this.alertFile = join(project, '_crew', '看护告警.json')
    this.ledgerFile = join(project, '_crew', '监控账本.jsonl')
  }

  /** 登记一张卡开跑。 */
  register ({ cardId, task, role, outFile, model = null, silent = false }) {
    let ctxWindow = null
    try { ctxWindow = model ? (capacityOf(model)?.contextWindow ?? null) : null } catch { ctxWindow = null }
    this.cards.set(cardId, {
      cardId, task, role, outFile, model, silent,
      startedAtMs: Date.now(),
      lastToolAtMs: null,
      lastSize: 0,
      readOffset: 0,
      events: 0,
      // ★ D26：上下文占用要能**边跑边看**（给链路面板的"实时"那一档）
      promptTokens: 0, ctxWindow, ctxPct: null,
      repeat: new Map(),             // 调用指纹 → 次数（机械三查③）
      level: 'green',                // green / yellow / red
      woke: false,
      closed: false,
      note: null
    })
  }

  unregister (cardId) {
    const c = this.cards.get(cardId)
    if (c) c.closed = true
    this.cards.delete(cardId)
  }

  start () {
    if (this.timer) return
    this.timer = setInterval(() => { try { this.tick() } catch { /* 监控自己坏了也不许影响派活 */ } }, this.intervalMs)
    this.timer.unref?.()
  }

  stop () {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    try { this.writeState() } catch {}
  }

  /** 只读地把新增的字节读出来，找"调工具"的痕迹。 */
  _scan (c) {
    if (!c.outFile || !existsSync(c.outFile)) return
    let size = 0
    try { size = statSync(c.outFile).size } catch { return }
    // ★ 2026-10-26（§七「产物字节不再增长 ⇒ grew=false」）：每扫一次记一个采样点。
    //   原来只有一个 `lastSize`，判据是 `> 0`（"曾经有字节"）—— 文件不再长也一直算"有产物"，
    //   于是"卡住在写日志刷字节"这种事永远看不出来。现在按**近 10 分钟的增量**判。
    c.sizeSamples = (Array.isArray(c.sizeSamples) ? c.sizeSamples : []).concat([{ at: Date.now(), size }]).slice(-80)
    if (size <= c.readOffset) { c.prevSize = c.lastSize; c.lastSize = size; return }
    let chunk = ''
    try {
      const buf = readFileSync(c.outFile)
      chunk = buf.subarray(c.readOffset, Math.min(size, c.readOffset + (2 << 20))).toString('utf8')
    } catch { return }
    c.readOffset = Math.min(size, c.readOffset + (2 << 20))
    c.prevSize = c.lastSize
    c.lastSize = size
    if (!chunk) return
    // 一行一条事件：只认结构字段（`"type":"tool_..."` 之类），不认自由文字里的"工具"两个字
    for (const line of chunk.split(/\r?\n/)) {
      if (!line.trim()) continue
      // ★ D26：上下文占用（每次请求的输入 token，取本轮**峰值**）——与"有没有在动"无关，先算
      const u = inputTokensOf(line)
      if (u != null && u > (c.promptTokens ?? 0)) {
        c.promptTokens = u
        if (c.ctxWindow > 0) c.ctxPct = Math.min(100, Math.round((u / c.ctxWindow) * 1000) / 10)
      }
      if (!isToolEvent(line)) continue
      c.events++
      c.lastToolAtMs = Date.now()
      // ③ 重复同一调用 ≥5 次：拿"工具名 + 参数前 80 字"当指纹
      const m = /"(?:name|tool|tool_name)"\s*:\s*"([^"]{1,60})"/.exec(line)
      const key = m ? m[1] : line.slice(0, 80)
      c.repeat.set(key, (c.repeat.get(key) ?? 0) + 1)
    }
  }

  /** 一次巡检：算无进展分钟数 → 变色 → 30 分钟机械三查 → 45 分钟批量唤醒。 */
  tick () {
    const now = Date.now()
    const dueWake = []
    for (const c of this.cards.values()) {
      this._scan(c)
      const ref = c.lastToolAtMs ?? c.startedAtMs
      const idleMin = Math.round(((now - ref) / 60000) * 10) / 10
      const totalMin = Math.round(((now - c.startedAtMs) / 60000) * 10) / 10
      c.idleMin = idleMin
      c.totalMin = totalMin
      const level = idleMin >= this.th.redMin ? 'red' : (idleMin >= this.th.yellowMin ? 'yellow' : 'green')
      if (level !== c.level) {
        c.level = level
        this.log(`  [监控] ${c.cardId} → ${level === 'red' ? '🔴 红灯' : level === 'yellow' ? '🟡 黄灯' : '🟢 绿'}（${idleMin} 分钟没有工具事件，工具事件共 ${c.events} 次）`)
        this.record({ at: new Date(now).toISOString(), cardId: c.cardId, verdict: 'progress', action: 'lamp', idleMin, level })
      }
      // 30 分钟机械三查（零成本；判出循环就标记，降档由编排在下次派活时落实）
      // ★ 2026-10-26（§七「`check` 修正」）：原来 `c.checked = true` 是**永久缓存** ——
      //   红的那一次算完就再也不重算了，人看到的可能是一小时前的结论。
      //   现在：`check` 带 `at`；超过 2 个监控周期就重算；红灯期间每 5 分钟重算一次。
      const checkStaleMs = Math.max(5 * 60_000, this.intervalMs * 2)
      const checkAge = c.check?.at ? now - Date.parse(c.check.at) : Infinity
      const shouldCheck = level === 'red' && (!c.check || !Number.isFinite(checkAge) || checkAge > checkStaleMs)
      if (shouldCheck) {
        c.check = { ...this._mechanicalCheck(c, now), at: new Date(now).toISOString() }
        this.log(`  [监控] ${c.cardId} 机械三查：${c.check.summary}`)
        this.record({ at: new Date(now).toISOString(), cardId: c.cardId, verdict: c.check.verdict, action: c.check.action, detail: c.check })
      }
      if (level === 'green') c.check = null // 恢复绿之后旧结论作废（不显示过期红）
      // 45 分钟主动唤醒（批量，同一波封顶 3 次）
      if (idleMin >= this.th.wakeMin && !c.woke) { c.woke = true; dueWake.push(c) }
    }
    if (dueWake.length) this._wakeBatch(dueWake)
    this.writeState()
  }

  /**
   * 机械三查（零成本）—— 施工文档 D4：
   *   ① 最近 10 分钟有没有新的**工具调用事件**；
   *   ② 落盘有没有动静（**改动口径**：这里用 out.json 的字节增长当"还在动"的弱信号，
   *      因为真按指纹判要扫全项目，长任务期间代价不可接受；见 `改动报告.md` 的偏离说明）；
   *   ③ 有没有**重复同一调用 ≥5 次** ⇒ 判循环，降一档（D3 的姊妹动作）。
   */
  _mechanicalCheck (c, now) {
    const recent = c.lastToolAtMs && (now - c.lastToolAtMs) <= 10 * 60000
    // ★ 2026-10-26（§七）：`grew` 从"曾经有字节"改成"**近 10 分钟真的在长**"。
    //   原来 `(c.lastSize ?? 0) > 0` —— 只要文件有过内容就永远算"有产物"，
    //   于是"卡住了但日志还在刷字节"这种最典型的假进展看不出来。
    const gi = grewSince(c.sizeSamples, now, 10 * 60_000, c.lastSize)
    const grew = gi.grew
    const repeats = [...c.repeat.entries()].filter(([, n]) => n >= 5).sort((a, b) => b[1] - a[1]).slice(0, 3)
    const loop = repeats.length > 0
    const verdict = loop ? 'loop' : (recent ? 'progress' : 'stalled')
    const action = loop ? 'downgrade' : (recent ? 'continue' : 'hold')
    const summary = `①最近10分钟工具事件 ${recent ? '有' : '**无**'}　②产物字节 ${grew ? `有（+${gi.delta}）` : `**无**（${gi.why}）`}　③重复调用 ≥5 次 ${loop ? `**有**（${repeats.map(([k, n]) => `${k}×${n}`).join('、')}）` : '无'} ⇒ ${loop ? '判**循环**，下次派活降一档' : recent ? '还在干活' : '真停了（等 45 分钟那次唤醒）'}`
    return { verdict, action, repeats: repeats.map(([k, n]) => ({ call: k, n })), recent, summary, grew, grewDelta: gi.delta }
  }

  /** 45 分钟：**一条消息列出本波所有卡住的卡**（护栏 1-5）。 */
  async _wakeBatch (cards) {
    if (this.wavesWoken >= this.th.wakeCap) {
      this.log(`  [监控] ⚠️ 本波唤醒已达上限 ${this.th.wakeCap} 次 ⇒ 不再叫（护栏 5）`)
      this.record({ at: new Date().toISOString(), verdict: 'wake', action: 'suppressed', detail: { cap: this.th.wakeCap } })
      return
    }
    // 护栏 4：与 100 分钟告警**共用去重键**（同一个 key 只叫一次）
    const keys = cards.map(c => `wake|${c.cardId}|${Math.floor((c.lastToolAtMs ?? c.startedAtMs) / 60000)}`)
    const A = (() => { try { return JSON.parse(readFileSync(this.alertFile, 'utf8')) } catch { return { schema: 1, alerts: [] } } })()
    const seen = new Set((A.alerts ?? []).map(a => a.fingerprint))
    const fresh = cards.filter((c, i) => !seen.has(keys[i]))
    if (!fresh.length) {
      this.log('  [监控] 这几张卡的唤醒已经叫过（去重键命中）⇒ 不重复叫')
      return
    }
    const lines = fresh.map(c => `· ${c.cardId}（${c.role}）：**${c.totalMin} 分钟没进展**（工具事件 ${c.events} 次，最后一次 ${c.idleMin} 分钟前）${c.check ? `｜三查：${c.check.summary}` : ''}`)
    // 护栏 3：带 TTL —— 过期只"看"不"办"
    const ttl = new Date(Date.now() + 60 * 60000).toISOString().slice(11, 16)
    const text = [
      '【编排·45 分钟无进展】以下卡在跑但**事件流停了**（不是进程死了）：',
      ...lines,
      `项目：${this.project}`,
      `请你在**这一轮内**处置：① 判循环 ⇒ 改卡/降档重发；② 判任务太大 ⇒ 拆卡；③ 判卡写错了 ⇒ 按上面的证据改卡重派。`,
      `**有效期到 ${ttl}**（UTC+8）——过期的消息请只当参考，不要照做。`
    ].join('\n')
    const r = await wakeBrain(this.project, text).catch(e => ({ ok: false, why: String(e?.message ?? e) }))
    this.wavesWoken++
    this.log(`  [监控] 45 分钟批量唤醒（${fresh.length} 张）：${r.why}`)
    try {
      A.alerts = [...(A.alerts ?? []), ...fresh.map((c, i) => ({ at: new Date().toISOString(), fingerprint: keys[cards.indexOf(c)], kind: 'no-progress-wake', cardId: c.cardId, task: c.task, idleMin: c.idleMin, woke: r.why }))].slice(-80)
      A.updatedAt = new Date().toISOString()
      mkdirSync(join(this.project, '_crew'), { recursive: true })
      writeFileSync(this.alertFile, JSON.stringify(A, null, 2) + '\n', 'utf8')
    } catch {}
    this.record({ at: new Date().toISOString(), verdict: 'wake', action: 'wake-brain', detail: { cards: fresh.map(c => c.cardId), woke: r.why } })
  }

  record (ev) {
    try {
      mkdirSync(join(this.project, '_crew'), { recursive: true })
      appendFileSync(this.ledgerFile, JSON.stringify(ev) + '\n', 'utf8')
    } catch {}
  }

  /** 给大脑看的**一屏**（D4："每次醒来先读一屏 `_crew\看护状态.json`"，读它几百 token）。 */
  writeState () {
    const cards = [...this.cards.values()]
    const rows = cards.map(c => ({
      card: c.cardId, task: c.task, role: c.role, model: c.model,
      minutes: c.totalMin ?? 0,
      idleMin: c.idleMin ?? 0,
      lastToolSecAgo: c.lastToolAtMs ? Math.round((Date.now() - c.lastToolAtMs) / 1000) : null,
      // ★ D26：链路面板要按卡片显示"上下文用了多少"（实时档就吃这三个字段）
      promptTokens: c.promptTokens ?? null,
      ctxWindow: c.ctxWindow ?? null,
      ctxPct: c.ctxPct ?? null,
      level: c.level, events: c.events, check: c.check?.summary ?? null, woke: c.woke
    }))
    const body = {
      // ★ 2026-10-26（§零.6 统一信封 + §七「四份健康各归各」）：
      //   这份是**卡片健康**，写 `卡片看护.json`；`state` 用绿/黄/红词表；缺信封看板只能判 unknown。
      schema: 1,
      kind: 'card-health',
      source: '_监控.mjs',
      stale: false,
      at: new Date().toISOString(),
      project: this.project,
      state: rows.some(r => r.level === 'red') ? 'red' : (rows.some(r => r.level === 'yellow') ? 'yellow' : (rows.length ? 'green' : 'unknown')),
      thresholds: this.th,
      summary: {
        running: rows.length,
        green: rows.filter(r => r.level === 'green').length,
        yellow: rows.filter(r => r.level === 'yellow').length,
        red: rows.filter(r => r.level === 'red').length
      },
      cards: rows,
      // 给"人/大脑读的一屏"（零解析成本）
      screen: rows.length
        ? '在跑：' + rows.map(r => `${r.card}（${r.minutes} 分钟，最后工具事件 ${r.lastToolSecAgo ?? '—'} 秒前）${r.level === 'red' ? '🔴' : r.level === 'yellow' ? '🟡' : '✅'}`).join('\n      ') +
          '\n异常：' + (rows.filter(r => r.level === 'red').length ? rows.filter(r => r.level === 'red').map(r => `${r.card} 已 ${r.idleMin} 分钟没有工具事件`).join('；') : '无')
        : '在跑：（无）\n异常：无',
      note: '判据是**载体事件流里的工具调用**，不是 runs 目录的文件时间（D4 明确：长任务在跑时目录本来就是安静的）。'
    }
    try {
      mkdirSync(join(this.project, '_crew'), { recursive: true })
      writeFileSync(this.stateFile, JSON.stringify(body, null, 2) + '\n', 'utf8')
    } catch {}
    return body
  }
}
