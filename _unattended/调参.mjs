#!/usr/bin/env node
/**
 * 调参（D18 / D19）—— **只出建议、只写证据，改不改由你点**（模式 A）。
 *
 * 为什么要有它（施工文档 D18）：那几个门槛（无进展多久叫醒、看板几点变红、超时多少、并行几个、重试几次）
 *   一直是**人拍的**，而每跑完一波历史数据里其实都留着"当时要是调成 X 会怎样"的答案。
 *   这一支把这些答案算出来摆到看板上 —— **零 token**、纯回放、不改任何生效值。
 *
 * 边界（D18 / D19 定死，代码里硬拦）：
 *   · 样本门槛：**少于 20 张卡不出建议**（不然一张卡的巧合就能改掉全班的门槛）；
 *   · 单次幅度：最多 ±10（分钟类）/ ±1（计数类）；
 *   · 取值区间：参数表里 `min`/`max` 硬夹，越界只写建议、不给采纳按钮；
 *   · C 类（锁 staleMs / 备份周期 / 能力缓存 TTL / 权限白名单）**永不自动调**，本脚本连算都不算。
 *   · **观察类 `observations[]`**（施工文档 §5.5/§6）：只让你知道，**不改参数、没有采纳按钮**；
 *     id 只许 `rework-nodelta` / `selfheal-low` / `ac-unknown-high` 三个（判据见 `buildObservations`）。
 *
 * 证据落哪里（D18 指定）：`<项目>\_crew\调参\`
 *   建议-<stamp>.json   机器可读（候选网格 + 每个候选的误报/漏报 + 样本清单）
 *   建议-<stamp>.md     人话一页（现状 / 建议 / 为什么 / 回放表）
 *   当前.json           当前生效参数
 *   变更.jsonl          每次采纳/忽略：时间、旧值→新值、依据文件、操作者
 *
 * 用法：
 *   node 调参.mjs --project <项目>                  # 生成一份建议（波次收尾时由编排调用）
 *   node 调参.mjs --project <项目> --latest --json  # 给看板：最新建议 + 当前值
 *   node 调参.mjs --project <项目> --accept         # 采纳（写 当前.json + 变更.jsonl）
 *   node 调参.mjs --project <项目> --ignore --reason "…"
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// ★ 2026-10-24（施工文档 §12.10）：样本源改成三层 —— 本项目现收据 → 样本库同项目 → 样本库跨项目。
//   库在**工作台根**（不随项目删），所以项目删了历史还在。
import { readAll as readLib, countable as libCountable } from './样本库.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const WS = resolve(HERE, '..')
const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const has = (n) => argv.includes('--' + n)

const PROJECT = resolve(opt('project', process.env.DSH_ACTIVE_PROJECT ?? WS))
const DIR = join(PROJECT, '_crew', '调参')
const TABLE = join(DIR, '参数表.json')
const CURRENT = join(DIR, '当前.json')
const LOG = join(DIR, '变更.jsonl')

const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return d } }
const writeJson = (p, o) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(o, null, 2) + '\n', 'utf8') }
const pct = (a, b) => (b ? Math.round((a / b) * 1000) / 10 : null)
/** 路径归一（比对项目身份用：反斜杠→斜杠、去尾斜杠、小写）。 */
const norm = (s) => String(s ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

/** D19 的第一批 5 个参数（登记表的**初始内容**；以后加参数＝加一行，不改代码）。
 *  ★ 2026-10-24（施工文档 §11.2 A/B）：加 `wired` —— **这个参数现在到底会不会生效**。
 *     A 条把三个没接线的标了 false；B 条把 `timeout_min` / `parallel` **接上了**（编排真读 `当前.json`），
 *     所以这两个改回 true；`retries` 还没接（编排里是一次写死的重试），等 C 重新定义。 */
export const DEFAULT_TABLE = [
  { id: 'N', now: 45, min: 30, max: 90, step: 5, unit: '分钟', metric: 'false_wake + missed', evidence: ['ledger.json', '看护告警.json'], owner: 'brain', mode: 'A', label: '无进展唤醒', wired: true },
  { id: 'lamp', now: { yellow: 10, red: 30 }, min: 5, max: 45, step: 5, unit: '分钟', metric: 'signal_delay', evidence: ['看护状态.json'], owner: 'brain', mode: 'A', label: '看板灯（黄/红）', wired: true },
  { id: 'timeout_min', now: 90, min: 60, max: 90, step: 10, unit: '分钟', metric: 'early_kill_rate', evidence: ['verdict.json', 'fingerprints'], owner: 'brain', mode: 'A', label: '单卡硬超时', wired: true },
  { id: 'parallel', now: 2, min: 1, max: 4, step: 1, unit: '个', metric: 'conflict_rate', evidence: ['越界.jsonl', 'verdict.json'], owner: 'brain', mode: 'A', label: '并行宽度 P', wired: true },
  { id: 'retries', now: 2, min: 1, max: 3, step: 1, unit: '次', metric: 'retry_success_rate', evidence: ['ledger.json'], owner: 'brain', mode: 'A', label: '失败重试次数', wired: false }
]
/** ★ 2026-10-24（施工文档 §11.2 C）：**一参数一样本一门槛**（废掉原来"统一 20 张卡"）。
 *  为什么必须拆：`timeout_min` 要看"跑满的卡"、`parallel` 要看"并行批次"、`N` 要看"调用次数" ——
 *  拿同一个 `max(cards, ledger)` 去卡五个参数，等于拿体温计量身高（§11.1 第 2 条）。
 *  门槛怎么定：按"这个参数要估的比例，分母得有多少次才算得稳"倒推 —— 20~30 次是这类小样本判据的常用下限，
 *  不是统计推导出来的精确值；**改了就在这里改，别散在函数里**。 */
const SAMPLE_MIN = { N: 30, timeout_min: 20, parallel: 20, retries: 10 }
const SAMPLE_MIN_DEFAULT = 20      // 还没定义门槛的新参数兜底
/** Wilson 95% 区间的 z 值（比例区间；小样本不用正态近似）。 */
const WILSON_Z = 1.96
const MAX_DELTA_MIN = 10           // 分钟类单次最多 ±10
const MAX_DELTA_CNT = 1            // 计数类单次最多 ±1

/** ★ 2026-10-24（§11.2 A/B）：老 `参数表.json` 里没有 `wired` ⇒ 按 id 从 DEFAULT_TABLE 补齐。
 *  ⚠️ **`wired` 一律以代码为准**（它是"编排读不读这个参数"的事实，不是项目偏好）——
 *     文件里那份只是**给看板读的缓存**（看板不 import 本模块）。接线/拆线改 DEFAULT_TABLE 即可。 */
function normalizeTable (rows) {
  const def = new Map(DEFAULT_TABLE.map(p => [p.id, p]))
  return rows.map(r => {
    const d = def.get(r?.id)
    return d ? { ...d, ...r, wired: d.wired } : r
  })
}
function loadTable () {
  const t = readJson(TABLE, null)
  if (Array.isArray(t) && t.length) {
    const norm = normalizeTable(t)
    // 落盘条件：**缺字段 或 与代码不一致**（幂等；用户手改过的 now/min/max 原样保留）
    const stale = t.some(r => DEFAULT_TABLE.some(d => d.id === r?.id && d.wired !== r.wired))
    if (stale) { try { writeJson(TABLE, norm) } catch {} }
    return norm
  }
  writeJson(TABLE, DEFAULT_TABLE)
  return DEFAULT_TABLE
}
function loadCurrent () {
  const c = readJson(CURRENT, null)
  if (c && typeof c === 'object') return c
  const t = loadTable()
  const seed = { at: new Date().toISOString(), N: 45, lamp: { yellow: 10, red: 30 }, timeout_min: 90, parallel: 2, retries: 2 }
  for (const p of t) if (p.id in seed || p.id !== 'lamp') seed[p.id] = p.now
  writeJson(CURRENT, seed)
  return seed
}

/**
 * 回放素材：
 *   · 每次**真调用**（账本）：时长、成败 —— 用来评"唤不唤醒 / 重试值不值"；
 *   · 每张**卡**（收据）：判决、耗时、有没有产物 —— 用来评"超时是不是杀早了 / 并行有没有撞车"；
 *   · **收据新字段**（施工文档 §5.5/§6 的契约，老收据没有 ⇒ 读成 undefined，不报错、不补写历史）：
 *     `reconcile` / `reworkCount` / `rework[{task,noDelta,at}]` / `selfHeal{red,healed}` / `deferredJudges[]`
 *     —— 喂给 observations（观察类，见 `buildObservations`）。
 */
export function loadHistory (project = PROJECT) {
  // ★ 2026-10-24（§11.2 C）：账本里**没有项目字段**，但每条都有 `envelope`（形如
  //   `<盘符>\…\项目\_crew\runs\<戳>\tasks\T1.out.json`）⇒ 从路径反推它属于哪个项目。
  //   这样 `N` / `retries` 就能优先用**本项目**的调用，而不是拿全工作台的账本冒充（§11.1 第 2 条）。
  const normP = (s) => String(s ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const projOf = (env) => { const m = String(env ?? '').replace(/\\/g, '/').match(/^(.*?)\/_crew\/runs\//i); return m ? normP(m[1]) : null }
  const projKey = normP(project)
  const ledger = []
  try {
    const j = readJson(join(WS, '_crew', 'ledger.json'), { calls: [] })
    for (const c of (j.calls ?? [])) {
      const dur = Number(c.durationMs)
      if (!Number.isFinite(dur) || dur <= 0) continue
      ledger.push({ at: c.at, role: c.role, task: c.task, minutes: dur / 60000, ok: c.ok === true, envelope: c.envelope ?? null, p: projOf(c.envelope) })
    }
  } catch { /* 没账本就只用收据 */ }
  const cards = []
  const signals = {
    rework: [],            // [{task, noDelta, at, run}]
    selfHealRed: 0,        // 所有 AC 红（分母）
    selfHealHealed: 0,     // 编排自己修好的（分子）
    acUnknown: 0,          // AC 判决里 ac-unknown 的条数
    acTotal: 0,            // AC 判决总数（含 unknown）
    deferredJudges: []
  }
  try {
    const runs = join(project, '_crew', 'runs')
    for (const d of readdirSync(runs, { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name).sort().slice(-40)) {
      const v = readJson(join(runs, d, 'verdict.json'), null)
      if (!v) continue
      for (const r of (v.results ?? [])) {
        const took = Number(r.tookMs)
        const verdict = String(r.verdict ?? '')
        if (/^ac-/.test(verdict)) {
          signals.acTotal++
          if (verdict === 'ac-unknown') signals.acUnknown++
        }
        cards.push({
          run: d, task: r.task, verdict,
          minutes: Number.isFinite(took) && took > 0 ? took / 60000 : null,
          produced: ((r.fingerprint?.added ?? 0) + (r.fingerprint?.changed ?? 0)) > 0,
          outOfScope: (r.outOfScope ?? []).length,
          attributed: (r.outOfScopeKind?.realOverreach ?? []).length
        })
      }
      // 契约新字段（顶层；老收据没有 ⇒ 全部 undefined，静默跳过）
      for (const rw of (Array.isArray(v.rework) ? v.rework : [])) {
        signals.rework.push({ task: rw?.task ?? '?', noDelta: rw?.noDelta === true, at: rw?.at ?? null, run: d })
      }
      if (v.selfHeal && typeof v.selfHeal === 'object') {
        signals.selfHealRed += Number(v.selfHeal.red) || 0
        signals.selfHealHealed += Number(v.selfHeal.healed) || 0
      }
      if (Array.isArray(v.deferredJudges)) signals.deferredJudges.push(...v.deferredJudges.map(x => ({ ...x, run: d })))
    }
  } catch { /* 没 runs 目录就只用账本 */ }
  // ★ §12.10：样本库（跨项目、跨删除）—— 只取"能进统计"的（purpose=real ＋ 有收据 ＋ 有旁证）
  let libMine = []; let libAll = []
  try {
    libAll = readLib().filter(libCountable)
    libMine = libAll.filter(s => norm(s.path) === projKey)
  } catch { /* 库读不到就当没有（不阻塞调参） */ }
  return { ledger, cards, signals, projKey, libMine, libAll }
}

/**
 * ★ 施工文档 §5.5/§6（D 条）：**observations[] 观察类**（跟数值调参分开）——
 *   只让你知道，**不改参数**、**没有采纳按钮**（`canAccept:false` 写死）。id 只许三个：
 *   · `rework-nodelta`   —— M ≥ 2 且 noDelta 占比 ≥ 50%（返工在空转）
 *   · `selfheal-low`     —— N ≥ 5 且自愈率 < 30%（分母＝所有 AC 红，分子＝编排自己修好的）
 *   · `ac-unknown-high`  —— AC 判决里 ac-unknown 占比 ≥ 30% 且 ≥ 3 条（阈值：施工文档没写死，
 *                            这里按“占比 + 最小样本”双条件定，防 2 条里 1 条 unknown 就报警；改这行即可调）
 */
export function buildObservations (hist = { rework: [], selfHealRed: 0, selfHealHealed: 0, acUnknown: 0, acTotal: 0 }) {
  const s = hist.signals ?? hist
  const out = []
  // ① 返工空转
  const M = (s.rework ?? []).length
  const noDelta = (s.rework ?? []).filter(r => r.noDelta).length
  if (M >= 2 && noDelta / M >= 0.5) {
    out.push({
      id: 'rework-nodelta', label: '返工在空转',
      text: `本波返工 ${M} 次，其中 ${noDelta} 次没带新东西`,
      why: '返工提示词可能没写清失败点（模型在重放旧指令）',
      evidence: (s.rework ?? []).map(r => `_crew\\runs\\${r.run}\\verdict.json#rework`).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join('；'),
      canAccept: false
    })
  }
  // ② 自愈率偏低
  const N = Number(s.selfHealRed) || 0
  const healed = Number(s.selfHealHealed) || 0
  const rate = N ? Math.round((healed / N) * 1000) / 10 : null
  if (N >= 5 && rate != null && rate < 30) {
    out.push({
      id: 'selfheal-low', label: '自愈率偏低',
      text: `自愈率 ${rate}%（${healed}/${N}，分母＝所有 AC 红）`,
      why: '先看特征库有没有跟上（SIGNATURES 太少？），再看返工提示词是不是没写清失败点',
      evidence: '收据 verdict.json#selfHeal（最近 40 波合计）',
      canAccept: false
    })
  }
  // ③ ac-unknown 占比高
  const u = Number(s.acUnknown) || 0
  const t = Number(s.acTotal) || 0
  const upct = t ? Math.round((u / t) * 1000) / 10 : null
  if (t > 0 && u >= 3 && upct >= 30) {
    out.push({
      id: 'ac-unknown-high', label: '机器认不出的失败偏多',
      text: `AC 判决里 ac-unknown 占 ${upct}%（${u}/${t}）`,
      why: '认不出要走诊断阶梯；占比高多半是证据包/ASSERT 输出没按规矩写，先看最近几条 ac-unknown 的原文',
      evidence: '收据 verdict.json#results（verdict=ac-unknown）',
      canAccept: false
    })
  }
  return out
}

const OK_VERDICTS = /^(ok|rescued|rescue-uncertain|ctx-full-reviewed)$/

/** 比例的点估计 ＋ 95% Wilson 区间（小样本下比 ±1.96√(p(1-p)/n) 靠谱，不会出负数/超 1）。
 *  ★ §11.2 C：判据要给"区间"，不能只给一个点 —— 3 张卡里 1 张失败，不等于"失败率 33%"。 */
function wilson (x, n, z = WILSON_Z) {
  if (!n) return { p: null, lo: null, hi: null, n: 0 }
  const p = x / n
  const d = 1 + (z * z) / n
  const c = p + (z * z) / (2 * n)
  const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))
  return { p, lo: Math.max(0, (c - half) / d), hi: Math.min(1, (c + half) / d), n }
}
const pctOf = (w) => (w.p == null ? null : Math.round(w.p * 1000) / 10)
const pctLo = (w) => (w.lo == null ? null : Math.round(w.lo * 1000) / 10)
const pctHi = (w) => (w.hi == null ? null : Math.round(w.hi * 1000) / 10)

/** 样本库一行 → 判据要的"卡"形状。 */
const libToCard = (s) => ({
  run: s.run, task: s.task,
  minutes: s.tookMin == null ? null : Number(s.tookMin),
  produced: s.produced === true,
  verdict: String(s.verdict ?? ''),
  attributed: Number(s.attributed) > 0 ? 1 : 0,
  censored: s.censored === true,
  fromLib: true
})

/**
 * ★ §12.10：**三层样本源**（卡级）。
 *   ① 本项目现有收据（最相关）→ ② 样本库同项目（项目删了也还在）→ ③ 样本库跨项目（同角色同模型，行为可比）
 *   规则：①② 够门槛就只用它；不够且**本项目已有底子**（`BORROW_MIN_LOCAL`）才并入 ③，并标明借了多少。
 *   ⚠️ 能不能借是**分参数**的：耗时主要看载体/模型（可借）；**撞车取决于项目结构（不许借）**。
 */
const BORROW_MIN_LOCAL = 5
function poolOf (hist, min, { borrow = true } = {}) {
  const live = (hist.cards ?? []).filter(c => c.minutes != null)
  const mineLib = (hist.libMine ?? []).map(libToCard).filter(c => c.minutes != null)
  const others = (hist.libAll ?? []).filter(s => norm(s.path) !== hist.projKey).map(libToCard).filter(c => c.minutes != null)
  const mine = [...live, ...mineLib]
  if (mine.length >= min) return { pool: mine, src: '本项目', borrowed: 0, enough: true }
  if (!borrow) return { pool: mine, src: '本项目', borrowed: 0, enough: false }
  // 借的前提：本项目自己已经有几张卡（否则"给一个还没跑起来的项目改参数"就是之前那个毛病）
  if (mine.length < BORROW_MIN_LOCAL) return { pool: mine, src: '本项目（太少，不借）', borrowed: 0, enough: false }
  const both = [...mine, ...others]
  return { pool: both, src: others.length ? '跨项目（借）' : '本项目', borrowed: both.length - mine.length, enough: both.length >= min }
}

/** ① N（无进展唤醒）：回放"如果在 N 分钟就叫醒，会误叫几次、会漏几次"，并给 95% 区间。
 *  样本＝**账本里的有效调用次数**（不是卡数）。 */
function scoreN (table, current, hist) {
  const p = table.find(x => x.id === 'N')
  // ★ C：**先用本项目的调用**；本项目不够门槛才借全工作台的账本，并在样本里写明借了多少条。
  const mine = hist.ledger.filter(c => c.p && hist.projKey && c.p === hist.projKey)
  const useMine = mine.length >= SAMPLE_MIN.N
  const pool = useMine ? mine : hist.ledger
  const n = pool.length
  const cands = []
  for (let v = p.min; v <= p.max; v += p.step) {
    let falseWake = 0; let missed = 0; let trueWake = 0
    for (const c of pool) {
      const finishedOk = c.ok === true
      if (finishedOk && c.minutes >= v) falseWake++                      // 叫了，但人家本来就会正常收活
      if (!finishedOk && c.minutes >= v) trueWake++                       // 叫了，而且它确实没成
      if (!finishedOk && c.minutes < v) missed++                          // 没叫，最后失败了
    }
    const fw = wilson(falseWake, n); const ms = wilson(missed, n)
    // 漏报权重 > 误报（D19 原话），2:1
    const score = missed * 2 + falseWake
    cands.push({ value: v, score, falseWake, missed, trueWake,
      note: `误叫 ${falseWake} / 漏叫 ${missed}` + (n ? `（95% 区间：误叫 ${Math.round(fw.lo * n)}–${Math.round(fw.hi * n)} · 漏叫 ${Math.round(ms.lo * n)}–${Math.round(ms.hi * n)}）` : '') })
  }
  return { id: 'N', cands, unit: p.unit, allowDelta: MAX_DELTA_MIN,
    evidence: { calls: n, myCalls: mine.length, borrowed: useMine ? 0 : n - mine.length },
    sample: { n, min: SAMPLE_MIN.N, unit: useMine ? '次调用（本项目）' : `次调用（借全工作台 ${n - mine.length} 条）`, why: '唤醒要靠看护回放，单位是"调用次数"不是"卡数"' } }
}

/** ② 单卡超时（★ C 换判据）：**只在"跑满被掐但其实已交付"时抬**。
 *  旧判据是"耗时接近阈值的卡数 × 系数"⇒ 单调偏好，有 1 张卡就往 90 顶（§11.1 第 3 条）。
 *  新判据（目标：少误杀 > 省钱 > 省墙钟）：
 *    · **抬**：`killedButDelivered > 0` ⇒ 目标 = P90 耗时 × 1.2，向上取整到 step，单次 ≤ ±10；
 *    · **降**：证据要很强才动（P95 ≤ 上限一半 且 一次超时都没有 且 样本 ≥ 门槛×1.5）—— 省墙钟排最后；
 *    · 其余 ⇒ **不动**。 */
function scoreTimeout (table, current, hist) {
  const p = table.find(x => x.id === 'timeout_min')
  const now = Number(current.timeout_min ?? p.now)
  const { pool, src, borrowed, enough } = poolOf(hist, SAMPLE_MIN.timeout_min)
  // ★ §12.6 删失：耗时分布**只用正常收工的卡** —— 超时卡的 tookMs ≈ 上限，真实耗时是"至少这么多"
  const normal = pool.filter(c => c.minutes != null && c.censored !== true)
  const censoredCards = pool.filter(c => c.censored === true || /timeout/i.test(c.verdict))
  const early = censoredCards.filter(c => c.produced)
  const n = normal.length
  const mins = normal.map(c => c.minutes).sort((a, b) => a - b)
  const q = (r) => (mins.length ? mins[Math.min(mins.length - 1, Math.floor(r * mins.length))] : null)
  const p90 = q(0.9); const p95 = q(0.95)
  const cands = []
  for (let v = p.min; v <= p.max; v += p.step) cands.push({ value: v, score: Math.abs(v - now), note: '（仅供对照，不建议按网格选）' })
  let advice = now
  let note = `证据不足：正常收工的卡 ${n} 张（门槛 ${SAMPLE_MIN.timeout_min}，来源 ${src}）⇒ 维持 ${now}`
  if (enough && n >= SAMPLE_MIN.timeout_min) {
    if (early.length > 0 && p95 != null) {
      // 目标 = max(P95_正常 × 1.2, 当前上限 × 1.15)，向上取整到 step，单次 ≤ +10
      const want = Math.ceil(Math.max(p95 * 1.2, now * 1.15) / p.step) * p.step
      const ideal = Math.min(p.max, Math.max(now, want))
      advice = now + Math.max(0, Math.min(MAX_DELTA_MIN, ideal - now))
      note = `有 ${early.length} 张跑满被掐但其实已交付（P95_正常 ${p95.toFixed(1)} 分）⇒ 目标 ${ideal}` +
        (ideal === now ? '（已在现值，不动）'
          : ideal - now > MAX_DELTA_MIN ? `，但单次最多 +${MAX_DELTA_MIN} ⇒ 这次先到 ${advice}` : ` ⇒ ${advice}`)
    } else if (censoredCards.length === 0 && p95 != null && p95 <= now * 0.5 && n >= SAMPLE_MIN.timeout_min * 1.5) {
      advice = Math.max(p.min, now - p.step)
      note = `零超时、P95_正常 ${p95.toFixed(1)} 分不到上限一半、${n} 张卡 ⇒ 降一档（省钱/省墙钟排最后，证据要强才动）`
    } else {
      note = `样本够但**没有"杀早了"的证据**（超时 ${censoredCards.length} 张、已交付 ${early.length} 张，P90_正常 ${p90 == null ? '?' : p90.toFixed(1)} 分）⇒ 维持 ${now}`
    }
  }
  return { id: 'timeout_min', cands, unit: p.unit, allowDelta: MAX_DELTA_MIN, adviceHint: advice, note,
    evidence: { cards: pool.length, normal: n, censored: censoredCards.length, killedButDelivered: early.length, earlyKillRate: pctOf(wilson(early.length, censoredCards.length)), p90: p90 == null ? null : Math.round(p90 * 10) / 10, p95: p95 == null ? null : Math.round(p95 * 10) / 10, src },
    sample: { n, min: SAMPLE_MIN.timeout_min, unit: `张正常收工的卡${borrowed ? `（借 ${borrowed}）` : ''}`, why: '超时要看"跑满的卡"；算分布时超时卡是删失值' } }
}

/** ③ 并行宽度（★ C 换判据）：**只在真撞车时降，没撞车不主动升**。
 *  旧判据 = 撞车率×档位×10 + (max−档位)×3 ⇒ 没撞车就直接建议 4 档（§11.1 第 3 条）。
 *  新判据（宁慢不乱）：至少**2 个不同轮次**里发生过"真撞车"（有写入者的越界）⇒ 降一档；
 *  否则维持 —— "省墙钟"排在最后，不能拿"可能撞车"去换"快"。 */
function scoreParallel (table, current, hist) {
  const p = table.find(x => x.id === 'parallel')
  const now = Number(current.parallel ?? p.now)
  const { pool, src, borrowed, enough } = poolOf(hist, SAMPLE_MIN.parallel, { borrow: false })
  const n = pool.length
  const conflicts = pool.filter(c => c.attributed > 0)
  const runs = new Set(conflicts.map(c => c.run))
  const w = wilson(conflicts.length, n)
  const cands = []
  for (let v = p.min; v <= p.max; v += p.step) cands.push({ value: v, score: Math.abs(v - now), note: '（仅供对照，不建议按网格选）' })
  let advice = now
  let note = `证据不足：有耗时的卡 ${n} 张（门槛 ${SAMPLE_MIN.parallel}）⇒ 维持 ${now}（**撞车取决于项目结构，不跨项目借**）`
  if (enough && n >= SAMPLE_MIN.parallel) {
    if (runs.size >= 2) {
      advice = Math.max(p.min, now - 1)
      note = `真撞车出现在 ${runs.size} 个不同轮次（${conflicts.length} 张，撞车率 ${pctOf(w)}%，95% 区间 ${pctLo(w)}–${pctHi(w)}%）⇒ 降一档`
    } else {
      note = `撞车 ${conflicts.length} 张 / ${runs.size} 个轮次（不够 2 轮）⇒ **不升不降**：省墙钟排最后，宁慢不乱`
    }
  }
  return { id: 'parallel', cands, unit: p.unit, allowDelta: MAX_DELTA_CNT, adviceHint: advice, note,
    evidence: { cards: n, conflicts: conflicts.length, conflictRuns: runs.size, conflictRate: pctOf(w), ciLo: pctLo(w), ciHi: pctHi(w), src },
    sample: { n, min: SAMPLE_MIN.parallel, unit: `张有耗时的卡${borrowed ? `（借 ${borrowed}）` : ''}`, why: '并行要看"真撞车发生在几个轮次"，不是卡的总数' } }
}

/** ④ 重试次数（★ C）：只用"第 2 次尝试成功率"的**区间**；**不主动降**（降重试＝多一点失败风险）。
 *  目前 `wired:false`（编排里是一次写死的重试），所以这条只作观察，不给采纳按钮。 */
function scoreRetries (table, current, hist) {
  const p = table.find(x => x.id === 'retries')
  const now = Number(current.retries ?? p.now)
  // ★ C：同上 —— 先本项目的调用，不够才借全工作台
  const mine = hist.ledger.filter(c => c.p && hist.projKey && c.p === hist.projKey)
  const pool = mine.length >= SAMPLE_MIN.retries ? mine : hist.ledger
  const borrowed = pool !== mine
  const byTask = new Map()
  for (const c of pool) {
    const k = String(c.task ?? '?')
    const arr = byTask.get(k) ?? []
    arr.push(c); byTask.set(k, arr)
  }
  let firstFail = 0; let secondOk = 0
  for (const [, arr] of byTask) {
    if (arr.length < 2) continue
    firstFail++
    if (arr[arr.length - 1].ok) secondOk++
  }
  const w = wilson(secondOk, firstFail)
  const cands = []
  for (let v = p.min; v <= p.max; v += p.step) cands.push({ value: v, score: Math.abs(v - now), note: '（仅供对照）' })
  let advice = now
  let note = `证据不足：重试过的卡 ${firstFail} 张（门槛 ${SAMPLE_MIN.retries}）⇒ 维持 ${now}`
  if (firstFail >= SAMPLE_MIN.retries) {
    if (secondOk === 0) { advice = p.min; note = `重试 ${firstFail} 张、第二次一次没成（95% 区间 0–${pctHi(w)}%）⇒ 建议压到最小` }
    else note = `第二次成功 ${secondOk}/${firstFail}（${pctOf(w)}%，95% 区间 ${pctLo(w)}–${pctHi(w)}%）⇒ 维持 ${now}（**不主动降**）`
  }
  return { id: 'retries', cands, unit: p.unit, allowDelta: MAX_DELTA_CNT, adviceHint: advice, note,
    evidence: { retriedCards: firstFail, secondSucceeded: secondOk, retrySuccessRate: pctOf(w), ciLo: pctLo(w), ciHi: pctHi(w), myCalls: mine.length, borrowed: borrowed ? pool.length - mine.length : 0 },
    sample: { n: firstFail, min: SAMPLE_MIN.retries, unit: borrowed ? `张重试过的卡（借全工作台）` : '张重试过的卡（本项目）', why: '重试成功率只能拿"重试过的卡"算' } }
}

function clampToDelta (nowVal, bestVal, allowDelta) {
  if (typeof nowVal === 'number' && typeof bestVal === 'number') {
    const d = bestVal - nowVal
    const lim = allowDelta
    return nowVal + Math.max(-lim, Math.min(lim, d))
  }
  return bestVal
}

/** 生成一份建议（不写盘）。
 *  ★ 2026-10-24（§11.2 C）：**判据改成"规矩 + 区间"，不再"网格里挑最小分"**。
 *   · `adviceHint`：算分函数直接给结论（抬/降/不动），`buildAdvice` 只做幅度夹取；
 *   · `sample`：**每个参数自己的样本与门槛**（`r.sample`），不再是全局统一 20；
 *   · `enough`：逐条判 —— 样本不够的那一条**不给采纳按钮**，但**照样显示**（说清"还差多少"）；
 *   · `lamp` **没有算分函数** ⇒ 它不会再进建议（证据是设计偏好，不是数据；`_监控.mjs` 仍照常读 `当前.json`）。 */
export function buildAdvice (project = PROJECT) {
  const table = loadTable()
  const current = loadCurrent()
  const hist = loadHistory(project)
  const sample = Math.max(hist.cards.length, hist.ledger.length)   // 只留给"数据池"显示
  const scorers = { N: scoreN, timeout_min: scoreTimeout, parallel: scoreParallel, retries: scoreRetries }
  const out = []
  for (const p of table) {
    const fn = scorers[p.id]
    if (!fn) continue                                    // 没有算分函数 ⇒ 这个参数不进建议（lamp 就是）
    const r = fn(table, current, hist)
    if (!r?.cands?.length) continue
    const nowVal = current[p.id] ?? p.now
    let target, best, note
    if (r.adviceHint != null) {
      // 规矩给的结论（不做网格搜索）
      target = r.adviceHint
      best = { value: target, score: null, note: r.note ?? '' }
      note = r.note ?? ''
      // 幅度夹取（分钟类 ±10 / 计数类 ±1）—— 规矩自己已经夹过，这里再兜一次，防以后改坏
      if (typeof nowVal === 'number' && typeof target === 'number') {
        target = nowVal + Math.max(-r.allowDelta, Math.min(r.allowDelta, target - nowVal))
      }
    } else {
      const bestScore = Math.min(...r.cands.map(c => c.score))
      const pick = r.cands.filter(c => c.score === bestScore).sort((a, b) => {
        const da = Math.abs((typeof a.value === 'number' ? a.value : 0) - (typeof nowVal === 'number' ? nowVal : 0))
        const db = Math.abs((typeof b.value === 'number' ? b.value : 0) - (typeof nowVal === 'number' ? nowVal : 0))
        return da - db
      })[0]
      target = clampToDelta(typeof nowVal === 'number' ? nowVal : 0, pick.value, r.allowDelta)
      best = pick; note = pick.note
    }
    const changed = JSON.stringify(target) !== JSON.stringify(nowVal)
    const inRange = typeof target === 'number' ? (target >= p.min && target <= p.max) : true
    const smp = r.sample ?? { n: sample, min: SAMPLE_MIN_DEFAULT, unit: '张卡', why: '' }
    out.push({
      id: p.id, label: p.label ?? p.id, now: nowVal, best: best.value, advice: target,
      changed, inRange, wired: p.wired !== false,
      sample: smp.n, sampleMin: smp.min, sampleUnit: smp.unit ?? null, sampleWhy: smp.why ?? null,
      enough: smp.n >= smp.min,
      unit: p.unit, metric: p.metric,
      score: best.score, note,
      candidates: r.cands.slice(0, 24),
      evidence: r.evidence ?? null,
      why: explain(p, nowVal, target, best, r, smp)
    })
  }
  const enoughAny = out.some(x => x.enough)
  return {
    at: new Date().toISOString(),
    project, sample,
    sampleEnough: enoughAny,
    sampleMin: SAMPLE_MIN_DEFAULT,
    // ★ §11.2 A/C：`cards`（本项目收据）与 `ledger`（**全工作台**账本）分开报 —— 合成一个数会骗人。
    //   每个参数**自己的门槛**在 `items[].sampleMin`；这里只报"数据池有多大"。
    sampleProgress: { n: sample, min: SAMPLE_MIN_DEFAULT, enough: enoughAny, cards: hist.cards.length, ledger: hist.ledger.length, lib: (hist.libAll ?? []).length, libMine: (hist.libMine ?? []).length },
    sampleMinBy: SAMPLE_MIN,
    items: out,
    // ★ 观察类（§5.5/§6）：跟 items 平级；面板在 items 之后渲染，**没有采纳按钮**
    observations: buildObservations(hist),
    changes: out.filter(x => x.changed && x.inRange && x.enough)
  }
}

function explain (p, nowVal, target, best, r, smp) {
  const fmt = (v) => (typeof v === 'object' ? `黄 ${v.yellow} / 红 ${v.red}` : String(v)) + (p.unit ? ' ' + p.unit : '')
  const parts = [`现在 ${fmt(nowVal)} → 建议 ${fmt(target)}：${best.note || ''}`]
  if (smp) parts.push(`样本 ${smp.n}/${smp.min} ${smp.unit || ''}${smp.n >= smp.min ? '（够）' : '（不够，先不给采纳）'}`)
  if (r.evidence) {
    for (const [k, v] of Object.entries(r.evidence)) if (v != null) parts.push(`${k}=${v}`)
  }
  return parts.join('；')
}

function mdPage (adv) {
  const L = []
  L.push(`# 调参建议 ${String(adv.at).slice(0, 19).replace('T', ' ')}`)
  L.push('')
  L.push(`> 数据池：本项目收据 ${adv.sampleProgress?.cards ?? '?'} 张 · 全工作台账本 ${adv.sampleProgress?.ledger ?? '?'} 次调用（**每个参数自己的门槛不同**，见下表"样本"列）`)
  L.push('> 模式 A：**只看不改**。系统只出建议与证据，改不改由你点。')
  L.push('')
  L.push('| 参数 | 现在 | 建议 | 样本（这个参数自己的门槛） | 为什么 | 值得改吗 |')
  L.push('|---|---|---|---|---|---|')
  for (const x of adv.items) {
    const smp = `${x.sample ?? '?'} / ${x.sampleMin ?? '?'} ${x.sampleUnit || ''} ${x.enough ? '✅' : '⛔ 不够'}`
    L.push(`| ${x.label} | ${typeof x.now === 'object' ? `黄 ${x.now.yellow} / 红 ${x.now.red}` : x.now + (x.unit ? ' ' + x.unit : '')} | ${typeof x.advice === 'object' ? `黄 ${x.advice.yellow} / 红 ${x.advice.red}` : x.advice + (x.unit ? ' ' + x.unit : '')} | ${smp} | ${x.why} | ${x.changed ? (x.inRange ? (x.enough === false ? '有变化（样本不够，不给采纳）' : '**有变化**') : '越界（只建议，不显示采纳）') : '无变化'} |`)
  }
  L.push('')
  if (!adv.changes.length) L.push('**这次没有值得改的参数**（候选与现值同分，或样本不够）。')
  L.push('')
  if (adv.observations?.length) {
    L.push('## 观察项（不改参数，只让你知道）')
    for (const o of adv.observations) {
      L.push('')
      L.push(`- **${o.label}**（\`${o.id}\`）：${o.text}`)
      L.push(`  - 为什么：${o.why}`)
      L.push(`  - 证据：${o.evidence}`)
    }
    L.push('')
  }
  L.push('## 回放明细')
  for (const x of adv.items) {
    if (!x.candidates?.length) continue
    L.push('')
    L.push(`### ${x.label}（${x.id}）`)
    L.push('')
    L.push('| 候选 | 分 | 说明 |')
    L.push('|---|---|---|')
    for (const c of x.candidates.slice(0, 12)) L.push(`| ${typeof c.value === 'object' ? `黄 ${c.value.yellow} / 红 ${c.value.red}` : c.value} | ${c.score} | ${c.note ?? ''} |`)
  }
  L.push('')
  L.push('> 证据目录：`_crew\\调参\\`（`当前.json` 是生效值，`变更.jsonl` 是你每次采纳/忽略的记录）')
  return L.join('\n') + '\n'
}

/** 生成并落盘；返回 {json, md, file, advice}。 */
export function generate (project = PROJECT) {
  const adv = buildAdvice(project)
  const stamp = String(adv.at).replace(/[:.]/g, '-').slice(0, 19)
  const jf = join(DIR, `建议-${stamp}.json`)
  const mf = join(DIR, `建议-${stamp}.md`)
  writeJson(jf, adv)
  writeFileSync(mf, mdPage(adv), 'utf8')
  return { advice: adv, json: jf, md: mf, stamp }
}

/** 最新一份建议（看板用）＋ 当前值 ＋ 唤醒状态（D27 的"看板'没叫到（原因）'"借这口子送上去）。 */
export function latest (project = PROJECT) {
  try { loadTable() } catch { /* 只为触发老表的 `wired` 迁移；失败不影响读数 */ }
  const current = loadCurrent()
  let best = null
  try {
    for (const f of readdirSync(DIR).filter(x => /^建议-.*\.json$/.test(x)).sort().reverse()) {
      const j = readJson(join(DIR, f), null)
      if (!j) continue
      best = { ...j, file: join(DIR, f), mdFile: join(DIR, f.replace(/\.json$/, '.md')) }
      break
    }
  } catch { /* 没建议 */ }
  // ★ D27：`_唤醒.mjs` 找不到大脑时写 `_crew\唤醒状态.json`（ok:false + "没叫到（原因）"）。
  //   看板数据.mjs 不在本次改动范围 ⇒ 借调参这个"看板读数口"把它带上去，面板照常显示。
  const wake = readJson(join(project, '_crew', '唤醒状态.json'), null)
  // ★ 2026-10-24（§11.2 A）：**样本进度也带上** —— 还没有建议文件时，看板要能说"已攒 X / 20"，
  //   不能像原来那样整格不显示（用户看到的就是"这块没了"，而不是"还在攒"）。
  let sampleProgress = null
  try {
    const h = loadHistory(project)
    const n = Math.max(h.cards.length, h.ledger.length)
    sampleProgress = { n, min: SAMPLE_MIN_DEFAULT, enough: n >= SAMPLE_MIN_DEFAULT, cards: h.cards.length, ledger: h.ledger.length }
  } catch { sampleProgress = null }
  return { at: new Date().toISOString(), project, current, latest: best, wake, sampleProgress }
}

/** 采纳：写 当前.json + 追加 变更.jsonl（只写"有变化"的那几条）。 */
export function accept (project = PROJECT, { by = '你', file = null } = {}) {
  const L = latest(project)
  if (!L.latest) return { ok: false, error: '还没有任何建议' }
  if (!L.latest.sampleEnough) return { ok: false, error: `样本不够（每个参数有自己的门槛，见 items[].sampleN/sampleMin）—— 不出采纳按钮，也不许采纳` }
  const cur = { ...L.current }
  const applied = []
  for (const x of L.latest.items) {
    if (!x.changed) continue
    if (!x.inRange) continue
    if (x.wired === false) continue        // ★ §11.2 A：没接线的参数**不许被采纳**（点了也没用，还会让 变更.jsonl 说谎）
    if (x.enough === false) continue       // ★ §11.2 C：这个参数**自己的**样本不够 ⇒ 不许采纳（门槛逐参数不同）
    cur[x.id] = x.advice
    applied.push({ id: x.id, from: x.now, to: x.advice })
  }
  if (!applied.length) return { ok: false, error: '这份建议里没有"可采纳"的变化' }
  cur.at = new Date().toISOString()
  writeJson(CURRENT, cur)
  for (const a of applied) {
    try {
      appendFileSync(LOG, JSON.stringify({ at: cur.at, op: 'accept', id: a.id, from: a.from, to: a.to, evidence: file ?? L.latest.file, by }) + '\n', 'utf8')
    } catch {}
  }
  return { ok: true, applied, current: cur, file: CURRENT }
}

/** 忽略：只追加 变更.jsonl（记"看过、不改"）。 */
export function ignore (project = PROJECT, { by = '你', reason = null } = {}) {
  const L = latest(project)
  if (!L.latest) return { ok: false, error: '还没有任何建议' }
  const at = new Date().toISOString()
  const items = (L.latest.items ?? []).filter(x => x.changed)
  for (const x of items) {
    try {
      appendFileSync(LOG, JSON.stringify({ at, op: 'ignore', id: x.id, from: x.now, to: x.now, advice: x.advice, evidence: L.latest.file, by, reason }) + '\n', 'utf8')
    } catch {}
  }
  return { ok: true, ignored: items.map(x => x.id), file: LOG }
}

// ── CLI ──
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  if (has('latest')) {
    const r = latest(PROJECT)
    if (has('json')) console.log(JSON.stringify(r, null, 2))
    else console.log(r.latest ? `最新建议：${r.latest.file}` : '（还没有建议）')
  } else if (has('accept')) {
    const r = accept(PROJECT, { by: opt('by', '你'), file: opt('file', null) })
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 2)
  } else if (has('ignore')) {
    const r = ignore(PROJECT, { by: opt('by', '你'), reason: opt('reason', null) })
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 2)
  } else {
    const r = generate(PROJECT)
    console.log(`✅ 建议已生成：${r.json}`)
    console.log(`   人话一页：${r.md}`)
    console.log(`   数据池：本项目收据 ${r.advice.sampleProgress?.cards ?? '?'} 张 · 全工作台账本 ${r.advice.sampleProgress?.ledger ?? '?'} 次调用（每个参数自己的门槛见建议文件）`)
    for (const x of r.advice.items) {
      const f = (v) => (typeof v === 'object' ? `黄${v.yellow}/红${v.red}` : v)
      console.log(`   ${String(x.label).padEnd(12)} 现在 ${String(f(x.now)).padEnd(12)} → 建议 ${String(f(x.advice)).padEnd(12)} ${x.changed ? (x.inRange ? '★有变化' : '（越界）') : '无变化'}　${x.why.slice(0, 60)}`)
    }
    for (const o of (r.advice.observations ?? [])) {
      console.log(`   [观察] ${o.label}：${o.text}　（不改参数，只让你知道）`)
    }
  }
}
