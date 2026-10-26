/**
 * 链路面板 —— 看板「运转链」页的服务端（**只读**：不跑脚本、不写文件、不调模型、零 token）。
 * ★ b204：按《链路可视化-施工文档》定稿口径重写（旧版是 b131 的"每根线各自找证据"）。
 *
 * 口径（一句话）：**用电器＝几乎每次都运转的件；电流＝活流过的那条通路。**
 *   · **段常亮**：活在哪一段，那一段就通电（**串联连通** —— 子 agent 在跑，则"大脑→派活→编排→载体"整段带电）。
 *   · **事件闪**：一次工具调用／一次收活／信封显著增长 ⇒ 对应线闪一下。
 *   · **余辉**：线刚通电后留影子（15 秒强／90 秒中／10 分钟淡；更老＝灰线静止，**不装亮**）。
 *   · 用电器**四态**：干活中／待命／断电／出错（"未知"单列，**不并进断电**）。
 *
 * 三条纪律：
 *   ① **不许编电流**：每条线带电都要给得出证据（`whyLive` ＝ 此刻为什么通着；`why` ＝ 余辉是哪来的）。
 *   ② **判据只有一处**：大脑在跑用 `大脑会话.mjs`；子 agent 在跑用编排登记的 childPid（与看板同源）；
 *      工具服务用 `/relay.json`（service.mjs 递进来）；常驻件用长命资源登记册。这一页只归拢，不另立标准。
 *   ③ **窗口摊开说**：转录只读尾巴 60 帧（≈最近 8 分钟）⇒ 页面明写覆盖多少分钟；窗口外的老账一律
 *      "窗口内没看到"，**不许写成"没发生过"**（b144 那次结论翻车的教训）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
// ★ 2026-10-26（§十「角色抽屉加 attempt/恢复」）：attempt 的**唯一真源**是 C 状态库，
//   抽屉里读它（只读、打不开就如实说"读不到"，不编一条出来）。
import { openDb, listAttempts, attemptDigest } from '../_状态库.mjs'
import { DEFAULT_DB } from '../_状态常量.mjs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brainTurnState, readBoardBrain, readTranscriptTail, resolveTranscript } from './大脑会话.mjs'
import { inFlightFiles, pidAlive } from './帧数据.mjs'
import { countRules, stripComments } from '../_条数体检.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const UNATT = resolve(HERE, '..')
const WORK = resolve(UNATT, '..')
const CREW = join(WORK, '_crew')
const ROLES = join(UNATT, 'roles')

const BOARD = process.env.DSH_BOARD_DATA ?? join(CREW, 'board-data.json')
/** 看板数据的"新鲜"窗口 = 面板的刷新周期（`DSH_BOARD_TTL_SEC`，默认 60 秒）＋ 5 秒余量。
 *  ★ b209：`账本→看板`、`看板→你` 两段的证据是**这份文件的 mtime**（不是转录事件）——
 *  但它是**按 TTL 重算**的，不是每 1 秒重算，所以窗口必须跟 TTL 对齐，不然会一直判"暗"。 */
const BOARD_TTL_SEC = Number(process.env.DSH_BOARD_TTL_SEC) || 10   // ★ b218：与 service.mjs 的 TTL 对齐（60→10）
const BOARD_FRESH_SEC = BOARD_TTL_SEC + 5
const LEDGER = process.env.DSH_LEDGER ? resolve(WORK, process.env.DSH_LEDGER) : join(CREW, 'ledger.json')
const LONGLIVE = join(CREW, '长命资源状态.json')

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null } }
const statOf = (p) => {
  try {
    const st = statSync(p)
    return { exists: true, size: st.size, mtime: st.mtimeMs, ageSec: Math.max(0, Math.round((Date.now() - st.mtimeMs) / 1000)) }
  } catch { return { exists: false, size: 0, mtime: null, ageSec: null } }
}
const readText = (p) => { try { return readFileSync(p, 'utf8') } catch { return null } }
/** 字数/行数**缓存 60 秒**：这页每 2 秒重建一次，而 `full` 模式要把 26 个脚本全读一遍字数 ——
 *  不缓存的话每刷多花 ~40ms（实测重建 44ms）。缓存只存"字数/行数"这两个不常变的东西，
 *  `statOf` 那类时间戳**照旧每次现取**（免得"改于 X 前"变成 60 秒前的旧话）。 */
const _textCache = new Map()
function textStats (p) {
  const hit = _textCache.get(p)
  if (hit && Date.now() - hit.at < 60000) return hit
  const t = readText(p)
  const val = { at: Date.now(), chars: t == null ? null : t.length, lines: t == null ? null : t.split('\n').length }
  if (t != null) _textCache.set(p, val)
  return val
}
const clip = (s, n = 120) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n) + '…' : t }
const secText = (s) => s == null ? '—' : (s < 60 ? s + ' 秒' : (s < 3600 ? (s / 60).toFixed(1) + ' 分钟' : (s / 3600).toFixed(1) + ' 小时'))
const msOf = (v) => { const t = Date.parse(String(v ?? '')); return Number.isFinite(t) ? t : null }
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }
const pk = (n) => num(n).toLocaleString('en-US')
const ageOf = (atMs) => (atMs ? Math.max(0, Math.round((Date.now() - atMs) / 1000)) : null)
const fresh = (atMs, sec) => Boolean(atMs) && (Date.now() - atMs) / 1000 <= sec

/* ── 四态（词表只此一处，客户端按 state 上色，不再自己写一套）── */
const STATES = { busy: '干活中', standby: '待命', off: '断电', error: '出错', unknown: '未知' }

/* ── 余辉三档（用户拍板：15 秒强／90 秒中／10 分钟淡）── */
const GLOW_SEC = [15, 90, 600]
function glowOf (atMs) {
  if (!atMs) return 0
  const s = (Date.now() - atMs) / 1000
  if (s <= GLOW_SEC[0]) return 3
  if (s <= GLOW_SEC[1]) return 2
  if (s <= GLOW_SEC[2]) return 1
  return 0
}

/* ── 格子大小 ＝ 一次活能干多久（实测优先，测不到按族归小档 —— 不猜）── */
const SIZE_ZH = { big: '大件（一次活数分钟以上）', mid: '中件（秒级～分钟级）', small: '小件（一闪而过）' }
const sizeByDur = (sec) => sec == null ? null : (sec >= 60 ? 'big' : (sec >= 3 ? 'mid' : 'small'))

/* ── 名录：脚本按名字**动态发现**（加一个体检脚本不必改这里）── */
const RE_GATE = /(体检|自检|门禁|复验|指纹|检查|验收|对账|冒烟)/
const RE_CARE = /(看护|确保|巡检|看守|守护)/
let _names = { at: 0, all: [], gate: [], care: [] }
function names () {
  if (_names.all.length && Date.now() - _names.at < 60000) return _names
  let all = []
  try { all = readdirSync(UNATT).filter((f) => f.endsWith('.mjs')) } catch { all = [] }
  _names = { at: Date.now(), all, gate: all.filter((f) => RE_GATE.test(f)), care: all.filter((f) => RE_CARE.test(f)) }
  return _names
}
function scriptIn (cmd) {
  const s = String(cmd ?? '')
  for (const f of names().all) if (s.includes(f)) return f
  return null
}
function flagsOf (cmd) { const m = String(cmd ?? '').match(/--[a-zA-Z][\w-]*/g); return m ? m.join(' ') : '' }

/* ── 转录尾巴（缓存 1.2 秒）── */
const TAIL_FRAMES = 60
/** 宿主自己投喂的"输入"（不是用户说的话）：它们也以 `user/message` 落转录，**不能算"你发话"**。 */
const RE_HOST_INPUT = /^(Time sampled|Current runtime context|Elapsed since|<system-reminder|The available skill catalog)/
let _tx = { at: 0, val: null }

/**
 * **整条会话的累计用量**（用户 2026-10-26 口径：「本会话 token」＝这个 session 一共烧了多少）。
 *
 * 三个坑（都踩过，别再踩）：
 *  ① 传进来的常常是**会话目录**不是文件 ⇒ 先 resolveTranscript 解析出真正的转录文件；
 *  ② 转录是 **zstd 帧拼接**（session.v4.jsonl.zstd）⇒ 直接按 utf8 读出来是二进制垃圾，
 *    JSON.parse 全失败、steps 永远 0。必须用 zlib.zstdDecompressSync 一帧一帧解；
 *  ③ 整个文件可能几十 MB ⇒ 按 (path, mtime, size) 缓存 5 秒，且只对含 "usage" 的行 parse。
 *
 * 拿不到就返回 {ok:false, why}（页面显示 — + 原因），**绝不按轮数估算**。
 */
// zstd 帧魔数（与 大脑会话.mjs 里那个同值；那边没导出，这里自己定义一份，别去改它的导出面）
const ZSTD_MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
let _su = { key: null, at: 0, val: null }
function sessionUsage (sessionPathOrDir) {
  const fail = (why) => ({ ok: false, why, steps: 0, inTok: 0, outTok: 0, cacheTok: 0, total: 0 })
  if (!sessionPathOrDir) return fail('没有会话路径')
  let file = sessionPathOrDir
  try {
    if (statSync(file).isDirectory()) file = resolveTranscript(sessionPathOrDir)
  } catch { return fail('会话路径不存在') }
  if (!file) return fail('会话目录里没有转录文件')

  let st = null
  try { st = statSync(file) } catch { return fail('转录文件读不到') }
  const key = file + '|' + st.mtimeMs + '|' + st.size
  if (_su.key === key && Date.now() - _su.at < 5000) return _su.val

  let buf = null
  try { buf = readFileSync(file) } catch { return fail('转录文件读不出') }
  let text = ''
  if (buf.length >= 4 && buf[0] === 0x28 && buf[1] === 0xB5 && buf[2] === 0x2F && buf[3] === 0xFD) {
    const offs = []
    let o = 0
    while (o < buf.length) { const k = buf.indexOf(ZSTD_MAGIC, o); if (k === -1) break; offs.push(k); o = k + 4 }
    const parts = []
    for (let n = 0; n < offs.length; n++) {
      const s0 = offs[n]
      const e0 = n + 1 < offs.length ? offs[n + 1] : buf.length
      try { parts.push(zstdDecompressSync(buf.subarray(s0, e0))) } catch { /* 正在写的末帧可能半截，跳过 */ }
    }
    if (!parts.length) return fail('转录里有 ' + offs.length + ' 个 zstd 帧，一个都没解开')
    text = Buffer.concat(parts).toString('utf8')
  } else {
    text = buf.toString('utf8')
  }

  let steps = 0
  let inTok = 0
  let outTok = 0
  let cacheTok = 0
  let frames = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line || line.indexOf('"usage"') === -1) continue
    let j = null
    try { j = JSON.parse(line) } catch { continue }
    frames++
    if (j && j.type === 'assistant/message') {
      const u = j.data && j.data.usage
      if (u) { steps++; inTok += num(u.inputTokens); outTok += num(u.outputTokens); cacheTok += num(u.cacheReadTokens) }
    }
  }
  const val = { ok: true, why: null, steps, inTok, outTok, cacheTok, total: inTok + outTok, coveredFrames: frames, file, bytes: st.size }
  _su = { key, at: Date.now(), val }
  return val
}

function transcript () {
  if (_tx.val && Date.now() - _tx.at < 1200) return _tx.val
  const bad = (why, sessionPath) => ({ ok: false, why, sessionPath: sessionPath ?? null, calls: [], results: new Map(), jobs: new Map(), usage: null, inputs: [], compactions: [], framesOk: 0, spanMin: null, lastAt: null })
  const bb = readBoardBrain()
  if (!bb.ok) return (_tx = { at: Date.now(), val: bad(bb.why) }).val
  const t = readTranscriptTail(bb.sessionPath, TAIL_FRAMES)
  if (!t.ok) return (_tx = { at: Date.now(), val: bad(t.why, bb.sessionPath) }).val
  const records = []
  for (const line of String(t.text).split(/\r?\n/)) {
    const s = line.trim()
    if (!s) continue
    try { const j = JSON.parse(s); if (j && typeof j === 'object') records.push(j) } catch {}
  }
  const calls = []
  const results = new Map()
  const jobs = new Map()
  const inputs = []
  const compactions = []
  const usage = { steps: 0, inTok: 0, outTok: 0, cacheTok: 0, lastAt: null, model: null }
  for (const r of records) {
    if (r.type === 'tool/call') {
      calls.push({ at: Number(r.time) || null, name: String(r.data?.name ?? '?'), args: String(r.data?.arguments ?? ''), callId: r.data?.callId ?? null })
    } else if (r.type === 'tool/result') {
      const m = r.data?.message ?? {}
      const txt = (Array.isArray(m.content) ? m.content : []).map((c) => String(c?.text ?? '')).join(' ')
      results.set(m.toolCallId ?? m.source?.callId ?? '?', { at: Number(r.time) || null, isError: m.isError === true, text: clip(txt, 700), path: r.data?.meta?.path ?? null, op: r.data?.meta?.operation ?? null })
    } else if (r.type === 'job/registered' || r.type === 'job/settled') {
      const d = r.data ?? {}
      const id = String(d.jobId ?? '?')
      const cur = jobs.get(id) ?? {}
      if (r.type === 'job/registered') Object.assign(cur, { startedAt: Number(d.startedAt) || null, label: clip(d.label, 200), kind: d.kind })
      else Object.assign(cur, { finishedAt: Number(d.finishedAt) || null, status: d.status ?? null, detail: clip(d.detail, 80) })
      jobs.set(id, cur)
    } else if (r.type === 'user/message') {
      const txt = (Array.isArray(r.data?.content) ? r.data.content : []).map((c) => String(c?.text ?? '')).join(' ')
      if (txt && !RE_HOST_INPUT.test(txt.trim())) inputs.push({ at: Number(r.time) || null, text: clip(txt, 160) })
    } else if (r.type === 'compaction/start') {
      compactions.push(Number(r.time) || null)
    } else if (r.type === 'assistant/message') {
      const u = r.data?.usage
      if (u) {
        usage.steps++
        usage.inTok += num(u.inputTokens)
        usage.outTok += num(u.outputTokens)
        usage.cacheTok += num(u.cacheReadTokens)
        usage.lastAt = Number(r.time) || usage.lastAt
        usage.model = r.data?.message?.source?.model ?? usage.model
      }
    }
  }
  const times = records.map((r) => Number(r.time)).filter((n) => Number.isFinite(n) && n > 0)
  const val = {
    ok: true, why: null, sessionPath: bb.sessionPath, sessionId: bb.sessionId, calls, results, jobs, usage, inputs, compactions,
    framesOk: t.framesOk, framesTried: t.framesTried, fileBytes: t.fileBytes,
    spanMin: times.length ? Math.max(1, Math.round((Math.max(...times) - Math.min(...times)) / 60000)) : null,
    lastAt: times.length ? Math.max(...times) : null
  }
  _tx = { at: Date.now(), val }
  return val
}

/* ── 一次工具调用归到哪个"用电器"（脚本按名录归并**记住是哪个脚本**）── */
const RE_MCP = /^(mcp__|pitfall_search$|fingerprint_check$|gate_summary$)/
const RE_READ = /^(read|glob|grep|read_image|list_mcp_resources)$/
const RE_WRITE = /^(write|edit|obsidian_write|obsidian_append|obsidian_set_property)$/
const RE_AGENT = /^(subagent|subagent_fork|task|agent)$/
const RE_RULEFILE = /(brain\.md|班组须知|细则\.md)/
const NODE_OF_SCRIPT = {
  '派活.mjs': { node: 'dispatch', edge: 'brain>dispatch', what: '发卡' },
  '编排.mjs': { node: 'orch', edge: 'dispatch>orch', what: '调度' },
  '看板数据.mjs': { node: 'board', edge: 'ledger>board', what: '生成看板数据' },
  '工量账本.mjs': { node: 'ledger', edge: 'outbox>ledger', what: '落账' }
}
function classifyCall (c) {
  const name = String(c.name ?? '?')
  let args = {}
  try { args = JSON.parse(String(c.args ?? '{}')) } catch { args = {} }
  if (/^(pwsh|bash|shell|cmd)$/.test(name)) {
    const cmd = String(args.command ?? '')
    const script = scriptIn(cmd)
    const fl = flagsOf(cmd)
    if (script) {
      const hit = NODE_OF_SCRIPT[script]
      if (hit) return { node: hit.node, edge: hit.edge, what: hit.what, text: script + (fl ? ' ' + fl : ''), script }
      if (names().gate.includes(script)) return { node: 'checks', edge: 'checks>brain', what: '体检/门禁', text: script + (fl ? ' ' + fl : ''), script }
      if (names().care.includes(script)) return { node: 'services', edge: null, what: '看护/常驻', text: script, script }
      return { node: 'brain', edge: null, what: '脚本', text: script, script }
    }
    return { node: 'brain', edge: null, what: '跑命令', text: clip(args.description || cmd, 110) }
  }
  if (RE_MCP.test(name)) return { node: 'tools', edge: 'tools>brain', what: '用工具', text: name.replace(/^mcp__[^_]*__/, '') + (args.keywords ? '（' + clip(args.keywords, 40) + '）' : '') }
  if (RE_READ.test(name)) {
    const p = String(args.file_path ?? args.path ?? args.pattern ?? '')
    if (RE_RULEFILE.test(p)) return { node: 'rules', edge: 'rules>brain', what: '读规矩', text: basename(p) }
    return { node: 'brain', edge: null, what: '读', text: clip(basename(p) || p, 80) }
  }
  if (RE_WRITE.test(name)) {
    const p = String(args.file_path ?? args.path ?? '')
    const isRule = RE_RULEFILE.test(p)
    return { node: isRule ? 'rules' : 'brain', edge: isRule ? 'rules>brain' : null, what: '写', text: clip(basename(p) || p, 80) }
  }
  if (RE_AGENT.test(name)) return { node: 'carrier', edge: 'orch>carrier', what: '子 agent', text: clip(args.description || args.prompt, 90) }
  // ⚠️ 这几个是**大脑自己的动作**（整理清单/把东西交给你看），不是"你发话" ⇒ 归 brain。
  //    归错会把 `you>brain` 那条线点亮成假电流（b204 自验逮到过）。
  if (name === 'present' || name === 'todo_write' || name === 'ask_user_question') return { node: 'brain', edge: null, what: '整理/交付', text: clip(args.description || name, 80) }
  return { node: 'brain', edge: null, what: name, text: '' }
}

/** 转录 → 事件流。每条带：元件／**是哪个脚本**／用时／退出码／结果原文（抽屉③④要用）。 */
function eventsFromTranscript () {
  const t = transcript()
  const out = []
  if (!t.ok) return { out, why: t.why }
  for (const c of t.calls) {
    const k = classifyCall(c)
    const res = c.callId ? t.results.get(c.callId) : null
    const job = [...t.jobs.values()].find((j) => j.startedAt && c.at && Math.abs(j.startedAt - c.at) < 3000)
    const dur = job?.finishedAt && job?.startedAt ? (job.finishedAt - job.startedAt) / 1000 : null
    const exit = (() => { const m = String(job?.detail ?? '').match(/exit code:\s*(-?\d+)/); return m ? Number(m[1]) : null })()
    const bad = res?.isError === true || (exit != null && exit !== 0)
    const bits = []
    if (k.text) bits.push(k.text)
    if (dur != null) bits.push('用时 ' + dur.toFixed(1) + 's')
    if (exit != null) bits.push('exit ' + exit)
    else if (job?.detail) bits.push(job.detail)
    else if (res?.isError) bits.push('工具报错')
    out.push({
      at: c.at, node: k.node, edge: k.edge, what: k.what, script: k.script ?? null,
      text: bits.join(' · ') || k.what, tone: bad ? 'err' : 'ok', dur, exit, out: res?.text ? clip(res.text, 700) : null
    })
  }
  for (const u of t.inputs) out.push({ at: u.at, node: 'you', edge: 'you>brain', what: '你发话', text: u.text, tone: 'ok', dur: null, exit: null, out: null })
  for (const c of t.compactions) out.push({ at: c, node: 'brain', edge: null, what: '压缩上下文', text: '上下文满了 ⇒ 自动压缩（"该换会话"的信号之一）', tone: 'warn', dur: null, exit: null, out: null })
  return { out, why: null }
}

/* ── 在跑登记（编排写的：`<项目>\_crew\running\<cardId>.json`）── */
function runningRecords (projectPath) {
  const dir = join(projectPath ?? '', '_crew', 'running')
  let files = []
  try { files = readdirSync(dir).filter((f) => f.endsWith('.json')) } catch { return [] }
  const out = []
  for (const f of files) {
    const rec = readJson(join(dir, f))
    if (!rec) continue
    const alivePid = pidAlive(rec.childPid)
    const inTime = !rec.deadlineMs || Date.now() <= rec.deadlineMs
    out.push({ file: join(dir, f), alive: alivePid && inTime, pidAlive: alivePid, inTime, ...rec })
  }
  return out
}

/**
 * ★ b218（2026-10-22 用户："运转链要实时反应谁干活、谁给谁传了什么"）：
 *   最近一次「发卡」的**真证据**——`<项目>\_crew\runs\<轮>\tasks\<卡>.dispatch.json` 的写入时间。
 *   为什么不用转录：转录只覆盖最近约 4 分钟（TAIL_FRAMES），窗口外的发卡会被显示成"窗口内没发卡"，
 *   和"编排正在跑"自相矛盾。文件 mtime 是跨窗口的硬证据。
 */
/**
 * ★ 2026-10-23（施工文档 D15）：**审核那一环**的真证据 —— `<项目>\_crew\runs\<轮>\verdict.json` 的 `review` 段。
 * 为什么要它：跳审是**省钱动作**，不显示就没人知道省了多少，也没人知道"该审的有没有被漏"。
 *   （三红线早就在编排里了，但看板看不到"这一波跳过了审核"。）
 * 取最近 6 轮里**最新的一份带 review 的收据**（没有 review 字段的老收据跳过，不猜）。
 */
function lastReviewState (projectPath) {
  const runs = join(projectPath ?? '', '_crew', 'runs')
  let dirs = []
  try { dirs = readdirSync(runs).sort().reverse().slice(0, 6) } catch { return null }
  for (const d of dirs) {
    const v = readJson(join(runs, d, 'verdict.json'))
    if (!v || !v.review) continue
    const r = v.review
    return {
      run: d, at: Date.parse(v.endedAt ?? '') || statOf(join(runs, d, 'verdict.json')).mtime,
      skipped: !!r.skipped,
      reason: r.reason ?? null,
      rounds: Number(r.rounds ?? 0),
      maxRounds: Number(r.maxRounds ?? 0) || null,
      ok: r.ok ?? null,
      verdict: r.verdict ?? null,
      level: r.level ?? null,
      gate: r.gate?.line ?? r.gate ?? null,
      file: join(runs, d, 'verdict.json')
    }
  }
  return null
}

function lastDispatchCard (projectPath) {
  const runs = join(projectPath ?? '', '_crew', 'runs')
  let best = null
  let dirs = []
  try { dirs = readdirSync(runs).sort().slice(-6) } catch { return null }
  for (const d of dirs) {
    const td = join(runs, d, 'tasks')
    let files = []
    try { files = readdirSync(td) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.dispatch.json')) continue
      const p = join(td, f)
      const st = statOf(p)
      if (!st.exists) continue
      if (!best || st.mtime > best.at) best = { at: st.mtime, card: f.replace(/\.dispatch\.json$/, ''), run: d, file: p }
    }
  }
  return best
}

/* ── 主回路 16 个（拓扑／名字／尺寸在这里；几何在客户端）── */
/* ★ 2026-10-23（施工文档 D26）：**载体那一格拆成 5 个用电器** —— 原来"一个框里塞 5 行"，
   看不出每个 agent 跟其他原件的关系。现在每个角色各占一格，各带自己的灯与上下文。
   注意：**连线 id 仍是 `orch>carrier` / `carrier>outbox` / `tools>carrier`**（逻辑线 15 条不变），
   `carrier` 从此是"5 个角色的合计"（只出现在连线文案与事件里，不再是一个方框）。 */
const CARRIER_ROLES = ['coder-a', 'coder-b', 'reviewer', 'researcher', 'rescue']
const NODE_DEFS = [
  { id: 'rules', label: '常驻规矩', sub: 'brain.md / 班组须知', kind: 'store', size: 'big' },
  { id: 'brain', label: '大脑', sub: 'DSH 会话（这条）', kind: 'host', size: 'big' },
  { id: 'dispatch', label: '派活.mjs', sub: '把任务发成卡', kind: 'script', size: 'mid' },
  { id: 'orch', label: '编排.mjs', sub: '调度 · 收活', kind: 'orch', size: 'big' },
  { id: 'coder-a', label: 'coder-a', sub: 'pi', kind: 'agent', size: 'mid' },
  { id: 'coder-b', label: 'coder-b', sub: 'opencode', kind: 'agent', size: 'mid' },
  { id: 'reviewer', label: 'reviewer', sub: 'codebuddy', kind: 'agent', size: 'mid' },
  { id: 'researcher', label: 'researcher', sub: 'messenger', kind: 'agent', size: 'mid' },
  { id: 'rescue', label: 'rescue', sub: 'qwencode', kind: 'agent', size: 'mid' },
  { id: 'checks', label: '闸（体检/门禁）', sub: '谁经过谁被检', kind: 'script', size: 'mid' },
  // ★ 2026-10-23（施工文档 D15）：**审核**是链上的一环，摆在 checks 与 outbox 之间
  { id: 'review', label: '审核', sub: '收尾全审一次', kind: 'script', size: 'mid' },
  { id: 'tools', label: '工具服务', sub: 'MCP 19400 · 三工具', kind: 'tool', size: 'mid' },
  { id: 'outbox', label: '回收 out.json', sub: '信封落盘', kind: 'store', size: 'mid' },
  { id: 'ledger', label: '账本', sub: 'ledger.json', kind: 'store', size: 'mid' },
  { id: 'board', label: '看板数据.mjs', sub: 'board-data.json', kind: 'script', size: 'mid' },
  { id: 'you', label: '你看板', sub: '这个窗口', kind: 'sink', size: 'big' }
]
const NODE_LABEL = Object.fromEntries(NODE_DEFS.map((d) => [d.id, d.label]))
// `carrier` 不再是方框，但仍是三条逻辑线的一端与事件归属 ⇒ 给它一个"合计"名（连线文案要用）
NODE_LABEL.carrier = '载体（5 个）'
const NODE_SIZE = Object.fromEntries(NODE_DEFS.map((d) => [d.id, d.size]))
const EDGE_DEFS = [
  { id: 'rules>brain', from: 'rules', to: 'brain', kind: 'flow', label: '每轮注入' },
  { id: 'brain>dispatch', from: 'brain', to: 'dispatch', kind: 'flow', label: '发卡' },
  { id: 'dispatch>orch', from: 'dispatch', to: 'orch', kind: 'flow', label: '开跑' },
  { id: 'orch>carrier', from: 'orch', to: 'carrier', kind: 'flow', label: 'spawn' },
  { id: 'carrier>outbox', from: 'carrier', to: 'outbox', kind: 'flow', label: '吐输出' },
  { id: 'outbox>ledger', from: 'outbox', to: 'ledger', kind: 'flow', label: '收活落账' },
  { id: 'ledger>board', from: 'ledger', to: 'board', kind: 'flow', label: '读账本' },
  { id: 'board>you', from: 'board', to: 'you', kind: 'flow', label: '摆给你看' },
  { id: 'you>brain', from: 'you', to: 'brain', kind: 'flow', label: '你发话' },
  { id: 'checks>brain', from: 'checks', to: 'brain', kind: 'supply', label: '体检结论' },
  { id: 'checks>orch', from: 'checks', to: 'orch', kind: 'supply', label: '门禁把关' },
  // ★ D15：门禁 → 审核 → 看板
  { id: 'checks>review', from: 'checks', to: 'review', kind: 'flow', label: '门禁结论交给审核' },
  { id: 'review>board', from: 'review', to: 'board', kind: 'flow', label: '审核结论' },
  { id: 'tools>brain', from: 'tools', to: 'brain', kind: 'supply', label: '查坑 / 指纹 / 门禁' },
  { id: 'tools>carrier', from: 'tools', to: 'carrier', kind: 'supply', label: '班组工具' }
]

const STATE_ZH_ROLE = { running: '干活中', idle: '待命', error: '出错', unassigned: '没干过' }
const stateOfRole = (s) => s === 'running' ? 'busy' : (s === 'error' ? 'error' : (s === 'idle' ? 'standby' : 'off'))
/** 常驻件的四态（登记册的 status 是"现实核对"的结论；"登记为已停"＝真断电）*/
const stateOfService = (x) => x.status === 'ok' ? 'standby' : (x.expect === 'stopped' ? 'off' : 'error')

/* ══ 主视图 ═══════════════════════════════════════════════════════════════ */
const _view = new Map()
export function chainView (opts = {}) {
  const full = opts.full === true
  const key = full ? 'full' : 'lite'
  const hit = _view.get(key)
  if (hit && Date.now() - hit.at < 800) return hit.val

  const b = readJson(BOARD) ?? {}
  const ledgerDoc = readJson(LEDGER) ?? {}
  const calls = Array.isArray(ledgerDoc.calls) ? ledgerDoc.calls : []
  const t = transcript()
  const evs = eventsFromTranscript()
  const proj = (() => {
    const c = b.currentProject ?? {}
    const row = (b.crewByProject ?? []).find((p) => String(p.path) === String(c.path))
    return {
      pinned: Boolean(c.set), path: c.path ?? null, name: c.name ?? (c.path ? basename(String(c.path)) : null), row: row ?? null,
      // ★ b209：钉住的目录 ≠ 工作台根时的换算依据（页面要把话说清楚，不许静默）
      pinPath: c.pinPath ?? null, pinName: c.pinName ?? null, resolvedBy: c.resolvedBy ?? null,
      noWorkbench: c.noWorkbench === true, banner: c.banner ?? null
    }
  })()
  const running = runningRecords(proj.path)
  const liveRecs = running.filter((r) => r.alive)
  const liveRec = liveRecs[0] ?? null
  // ★ b218：跨转录窗口的硬证据——最近一次发卡（文件 mtime）
  const lastDispatch = lastDispatchCard(proj.path)
  const ll = b.longlive ?? readJson(LONGLIVE) ?? {}
  const toolItem = (ll.items ?? []).find((x) => String(x.name) === '工具服务') ?? null
  const toolProbe = opts.tool && typeof opts.tool === 'object' ? opts.tool : null
  const toolOn = toolProbe ? toolProbe.state === 'green' : (toolItem?.status === 'ok')
  const watch = b.watch ?? {}
  const quick = b.ledger ?? {}
  const br = b.brainRow ?? {}
  const todayCalls = num(quick.todayCalls)

  /* ① 事件流：转录 ＋ 账本收活 */
  const events = evs.out.slice()
  for (const c of calls.slice(-8)) {
    const at = msOf(c.at)
    events.push({
      at, node: 'ledger', edge: 'outbox>ledger', what: '收活', script: null,
      text: [c.role, c.task, (c.ok === false || c.isError) ? '❌' : '✅', c.numTurns ? c.numTurns + ' 回合' : null, c.usage?.totalTokens ? pk(c.usage.totalTokens) + ' token' : null].filter(Boolean).join(' · '),
      tone: (c.ok === false || c.isError) ? 'err' : 'ok', dur: c.durationMs ? c.durationMs / 1000 : null, exit: null, out: null
    })
  }
  events.sort((a, z) => (z.at ?? 0) - (a.at ?? 0))
  // `carrier` 是**虚拟合计节点**（D26 拆成 5 个方框后它只活在连线与事件里）⇒ 取 5 个角色里最新的那一条
  const lastEvOf = (id) => {
    if (id !== 'carrier') return events.find((x) => x.node === id) ?? null
    for (const e of events) if (CARRIER_ROLES.includes(e.node)) return e
    return null
  }
  const countOf = (id) => events.filter((x) => x.node === id).length
  const endText = (id) => { const e = lastEvOf(id); return e ? (secText(ageOf(e.at)) + '前 ' + e.what + '（' + clip(e.text, 70) + '）') : '窗口内没动静' }

  /* ② 角色行：看板给状态 ＋ **我自己的 running 登记优先**（免得看板数据还没刷新时两处打架）*/
  const rolesFromBoard = proj.row?.roles ?? []
  const roleRows = rolesFromBoard.map((r) => {
    const rec = liveRecs.find((x) => String(x.role) === String(r.role)) ?? null
    const mine = calls.filter((c) => c.role === r.role)
    const last = mine.length ? mine[mine.length - 1] : null
    const state = rec ? 'running' : (r.state ?? 'unassigned')
    return {
      role: r.role, agent: r.agent ?? rec?.agent ?? null, state, stateZh: STATE_ZH_ROLE[state] ?? '—', tone: stateOfRole(state),
      modelText: r.modelText ?? r.model ?? '—', task: rec?.task ?? r.live?.task ?? null, cardId: rec?.cardId ?? r.live?.cardId ?? null,
      pid: rec?.childPid ?? r.live?.childPid ?? null, startedAt: rec?.startedAt ?? r.live?.startedAt ?? null,
      calls: mine.length, tokens: num(r.tokens), lastAt: last ? msOf(last.at) : msOf(r.lastAttemptAt),
      lastOk: last ? !(last.ok === false || last.isError) : null, why: clip(r.stateReason, 200),
      source: rec ? '编排登记（running）' : '看板数据'
    }
  })
  const carrierOn = roleRows.filter((r) => r.tone === 'busy')

  /* ③ 文件现状 */
  const rulesPath = join(ROLES, 'brain.md')
  const briefPath = join(ROLES, '班组须知.md')
  const detailPath = join(ROLES, '班组须知-细则.md')
  const rulesMd = statOf(rulesPath)
  const briefMd = statOf(briefPath)
  const detailMd = statOf(detailPath)
  const ledgerStat = statOf(LEDGER)
  const boardStat = statOf(BOARD)
  const briefCount = (() => { try { return countRules(stripComments(readFileSync(briefPath, 'utf8'))).count } catch { return null } })()
  const brainCount = (() => { try { return countRules(stripComments(readFileSync(rulesPath, 'utf8'))).count } catch { return null } })()
  const bt = brainTurnState()
  const brainBusy = Boolean(bt.ok && bt.running)

  const obFile = liveRec ? inFlightFiles(proj.path, liveRec.run, liveRec.cardId) : null
  const obStat = obFile?.outFile ? statOf(obFile.outFile) : { exists: false, mtime: null, ageSec: null, size: 0 }
  const lastEnvelope = (() => { for (let i = calls.length - 1; i >= 0; i--) { const e = String(calls[i].envelope ?? ''); if (e) return { file: e, call: calls[i], st: statOf(e) } } return null })()
  const OUTBOX_GROW_SEC = 30
  const outboxGrowing = Boolean(obStat.exists && obStat.ageSec != null && obStat.ageSec <= OUTBOX_GROW_SEC)

  /* ④ ★ 段常亮：活在哪一段（§3.2 的唯一实现）*/
  const dispatchAt = lastEvOf('dispatch')?.at ?? null
  const orchAt = lastEvOf('orch')?.at ?? null
  const boardAt = lastEvOf('board')?.at ?? null
  const ledgerAt = lastEvOf('ledger')?.at ?? null
  const toolAt = lastEvOf('tools')?.at ?? null
  const checksAt = lastEvOf('checks')?.at ?? null
  const carrierBusy = carrierOn.length > 0
  const hasWork = liveRecs.length > 0 || carrierBusy || fresh(dispatchAt, 90) || fresh(orchAt, 90)
  const workWhy = liveRecs.length
    ? '编排登记里 ' + liveRecs.length + ' 个活、childPid 还活着：' + liveRecs.map((r) => (r.role ?? '?') + '/' + (r.cardId ?? '?')).join('、')
    : (carrierBusy
        ? '有子 agent 在干活（' + carrierOn.map((r) => r.role).join('、') + '）'
        : (fresh(dispatchAt, 90) || fresh(orchAt, 90)
            ? '窗口内 ' + secText(Math.min(ageOf(dispatchAt ?? Infinity) ?? 999, ageOf(orchAt ?? Infinity) ?? 999)) + '前刚发过卡/开过跑'
            : '现在没有活（没有 running 登记、也没有发卡/开跑）'))
  const LIVE_WHY = {
    'rules>brain': () => brainBusy ? '大脑正在干活（' + clip(bt.why, 90) + '）⇒ 每轮注入的规矩正通着' : '大脑没在干活 ⇒ 规矩这一刻不注入',
    'brain>dispatch': () => hasWork ? '有活 ⇒ 活是从大脑交出去的：' + workWhy : '没有活 ⇒ 大脑还没把活交出去',
    'dispatch>orch': () => hasWork ? '有活 ⇒ 派活发卡后编排在跑：' + workWhy : '没有活 ⇒ 编排没在跑',
    'orch>carrier': () => hasWork ? (carrierBusy ? '★串联连通：活已经流到子 agent 手上 —— ' + workWhy : '编排在跑（活在路上，子 agent 还没进干活态）') : '没有活 ⇒ 没有子 agent 在跑',
    'carrier>outbox': () => (carrierBusy || outboxGrowing)
      ? (outboxGrowing ? '信封正在长（' + clip(obFile?.outFile ? basename(obFile.outFile) : '', 30) + ' 现在 ' + pk(obStat.size) + ' B，' + secText(obStat.ageSec) + '前写过）' : '子 agent 在跑 ⇒ 边收边写')
      : '没有在跑的活 ⇒ 没有正在长的信封',
    // ★ b209：证据＝看板那个文件的 mtime（按 TTL 重算，默认 60 秒一次），不是转录事件
    'ledger>board': () => boardStat.ageSec != null && boardStat.ageSec <= BOARD_FRESH_SEC
      ? '看板数据 ' + secText(boardStat.ageSec) + '前刚重算（每 ' + Math.round(BOARD_TTL_SEC) + ' 秒必重算一次，重算时读账本）'
      : '看板数据 ' + (boardStat.ageSec == null ? '读不到' : secText(boardStat.ageSec) + '前才写过') + ' ⇒ 超过刷新周期，这一刻没在算',
    'board>you': () => boardStat.ageSec != null && boardStat.ageSec <= BOARD_FRESH_SEC
      ? '你屏幕上这份数据 ' + secText(boardStat.ageSec) + '前刚摆上去（页面每 1 秒问一次）'
      : '看板数据停在 ' + (boardStat.ageSec == null ? '未知' : secText(boardStat.ageSec) + '前') + ' ⇒ 你看到的是旧数',
    'you>brain': () => brainBusy ? '活从你这儿来（你发话/派活）⇒ 大脑正在干这一轮' : '大脑没在干活'
  }
  const liveOf = (id) => {
    switch (id) {
      case 'rules>brain': case 'you>brain': return brainBusy
      case 'brain>dispatch': case 'dispatch>orch': case 'orch>carrier': return hasWork
      case 'carrier>outbox': return carrierBusy || outboxGrowing
      // ★ b209：**看板那两段不是"大脑在转录里跑了脚本"才亮** —— 看板数据由面板按 TTL 重算
      //   （页面在轮询 `/board-data.json`，服务端顺手重算）⇒ 证据是**文件 mtime**，不是转录事件。
      //   原来这两段的判据端是 `board` 节点的转录事件 ⇒ 那一格**几乎永远是暗的**（用户实测就卡在这）。
      case 'ledger>board': case 'board>you': return fresh(boardStat.mtime, BOARD_FRESH_SEC)
      case 'tools>brain': return toolOn && fresh(toolAt, 15)
      default: return false
    }
  }

  /* ⑤ 用电器（四态）*/
  const nodes = []
  const push = (id, o) => {
    const def = NODE_DEFS.find((d) => d.id === id)
    const state = o.state
    nodes.push({ id, label: def.label, sub: def.sub, kind: def.kind, size: def.size, state, stateZh: STATES[state], ...o })
  }
  push('rules', {
    state: rulesMd.exists && briefMd.exists ? 'standby' : 'error',
    stateText: rulesMd.exists ? '在册（底座，不是干活件）' : '缺文件（没有规则源）',
    at: Math.max(rulesMd.mtime ?? 0, briefMd.mtime ?? 0) || null,
    metrics: [
      { k: '常驻', v: (textStats(rulesPath).chars ?? 0) + ' 字', hint: (brainCount ?? '?') + ' 条 —— 每轮全文注入（persona）' },
      { k: '卡面', v: (textStats(briefPath).chars ?? 0) + ' 字', hint: (briefCount ?? '?') + ' 条 —— 每张卡内联' },
      { k: '细则', v: (textStats(detailPath).chars ?? 0) + ' 字', hint: '按需读，不进 persona' },
      { k: '改于', v: secText(rulesMd.ageSec) + '前', hint: '改常驻规矩**要重启桌面端**才生效' }
    ],
    why: '它是**底座/电源**，不判"干活中"：常驻规矩每轮注入（' + (brainCount ?? '?') + ' 条）、卡面每张卡内联（' + (briefCount ?? '?') + ' 条）。'
  })
  push('brain', {
    state: bt.ok ? (bt.running ? 'busy' : 'standby') : 'unknown',
    stateText: bt.ok ? (bt.running ? '在跑第 ' + (bt.turn ?? '?') + ' 轮' : '空闲（这一轮已收尾）') : '看不出（探不出来）',
    at: t.lastAt ?? null,
    metrics: [
      { k: '上下文', v: br.contextText ?? '—', hint: br.contextNote ?? null },
      { k: '模型', v: clip(br.modelText ?? t.usage?.model ?? '—', 60) },
      // ★ 2026-10-26（用户口径）：「本窗 token」＝**这一条会话累计**烧了多少 token，不是"最近 8 分钟"。
      //   `su` 读整份转录；`t.usage` 只有尾巴 60 帧，仅作"窗口内"参考并在提示里写清，两者不混用。
      (() => {
        const su = sessionUsage(t.sessionPath ?? bb.sessionPath)
        if (!su.ok || !su.steps) return { k: '本会话 token', v: '—', hint: (su.why || (su.ok ? '这条会话还没有模型调用记录（0 次）' : '会话转录读不到')) + '（不估算）' }
        return {
          k: '本会话 token',
          v: pk(su.total) + ' token',
          hint: '**整条会话累计**（' + su.steps + ' 次模型调用 · 输入 ' + pk(su.inTok) + ' / 输出 ' + pk(su.outTok) + ' · 缓存读 ' + pk(su.cacheTok) + '）',
        }
      })(),
      { k: '会话', v: clip(String(br.sessionId ?? t.sessionId ?? '—'), 14), hint: t.sessionPath ?? null }
    ],
    why: bt.ok ? bt.why : (bt.why || '看不出（退回看板那盏灯的判据）')
  })
  push('dispatch', {
    // ★ b218：判"在干活"用**跨窗口的文件证据**；转录只作补充（它只覆盖约 4 分钟）
    state: (dispatchAt || lastDispatch) && (glowOf(dispatchAt) >= 2 || (lastDispatch && ageOf(lastDispatch.at) <= 90)) ? 'busy' : 'standby',
    stateText: (lastDispatch && (!dispatchAt || lastDispatch.at > dispatchAt))
      ? ('最近一次发卡 ' + secText(ageOf(lastDispatch.at)) + '前（' + lastDispatch.card + '）')
      : (dispatchAt ? ('最近一次发卡 ' + secText(ageOf(dispatchAt)) + '前') : '没有发卡记录'),
    at: Math.max(dispatchAt ?? 0, lastDispatch?.at ?? 0) || null,
    metrics: [
      { k: '最近发卡', v: lastDispatch ? secText(ageOf(lastDispatch.at)) + '前' : '没有记录', hint: lastDispatch ? (lastDispatch.card + ' · ' + lastDispatch.run + ' · 证据 dispatch.json') : '没找到 dispatch.json' },
      { k: '转录里', v: countOf('dispatch') + ' 次', hint: t.ok ? '覆盖最近约 ' + (t.spanMin ?? '?') + ' 分钟' : (t.why ?? '读不到转录') },
      { k: '模板', v: statOf(join(CREW, '派活模板.md')).exists ? secText(statOf(join(CREW, '派活模板.md')).ageSec) + '前改' : '缺', hint: join(CREW, '派活模板.md') }
    ],
    why: lastDispatch
      ? '证据：`' + basename(lastDispatch.file) + '`（' + secText(ageOf(lastDispatch.at)) + '前写入）' + (dispatchAt && dispatchAt >= lastDispatch.at ? '；转录里也有那次调用：' + clip(lastEvOf('dispatch')?.text, 80) : '')
      : (dispatchAt ? '证据（这条会话的转录）：' + lastEvOf('dispatch').text : '既没有 dispatch.json，转录里也没有派活调用 —— 真的没发过卡')
  })
  push('orch', {
    state: liveRecs.length ? 'busy' : (watch.lock?.alive ? 'busy' : (watch.state === 'error' ? 'error' : 'standby')),
    stateText: liveRecs.length ? ('正在跑 ' + liveRecs.length + ' 个') : String(watch.stateZh ?? '没在跑'),
    at: liveRec ? (liveRec.startedAtMs ?? msOf(liveRec.startedAt)) : orchAt,
    metrics: [
      { k: '登记', v: running.length + ' 条', hint: running.length ? running.map((r) => (r.role ?? '?') + '/' + (r.cardId ?? '?') + (r.alive ? ' 活' : ' 死')).join('、') : '没有 running 登记' },
      { k: '锁', v: watch.lock?.present ? (watch.lock.alive ? '有活着的编排' : '残留锁') : '无锁', hint: watch.lock?.who ?? null },
      { k: '看护', v: String(watch.stateZh ?? '—'), hint: clip(watch.detail, 120) },
      { k: '窗口内', v: countOf('orch') + ' 次', hint: orchAt ? secText(ageOf(orchAt)) + '前 ' + clip(lastEvOf('orch').text, 50) : null }
    ],
    why: liveRecs.length
      ? '**在干活判据**：编排写了 ' + liveRecs.map((r) => 'running\\' + basename(r.file)).join('、') + '，里面那个 childPid ' + liveRecs.map((r) => r.childPid).join('、') + ' 还活着'
      : clip(watch.detail ?? '没有 running 登记 ⇒ 没在干活', 160)
  })
  /* ③ 载体 5 个用电器（D26）：每个角色一格 —— 灯 / 正在跑的卡 / **上下文用了多少**
       上下文两级来源：干活中读 `卡片看护.json`（**近实时**：_监控.mjs 每 10 秒扫一次载体的 out.json，
         从 `usage.promptTokens` 抽出来除以模型窗口 ⇒ `ctxPct`。不是真·实时，但一轮里能看着它涨），
       待命/断电读账本该角色最近一条的 `ctxPct`；两处都没有 ⇒ 显示 `—`（不编数）。 */
  // ★ 2026-10-26 **修我自己造成的回归**：`_监控.mjs` 的卡片健康文件已改名 `卡片看护.json`
  //   （§七「四份健康各归各」），但这里还在读旧名 `看护状态.json` ⇒ 载体上下文**永远**拿不到。
  //   写方改了就必须跟着改读方，否则等于"写了一份没人看的状态"。
  const careState = (() => {
    if (!proj.path) return null
    try { return JSON.parse(readFileSync(join(proj.path, '_crew', '卡片看护.json'), 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
  })()
  const compactTok = (n) => {
    const x = Number(n)
    if (!Number.isFinite(x) || x <= 0) return '—'
    if (x >= 1e6) return (x / 1e6).toFixed(x >= 1e7 ? 0 : 1).replace(/\.0$/, '') + 'M'
    if (x >= 1e3) return Math.round(x / 1e3) + 'K'
    return String(Math.round(x))
  }
  const ctxSane = (pct, used, win) => {
    if (pct == null) return false
    const p = Number(pct), u = Number(used), w = Number(win)
    if (!Number.isFinite(p) || p < 0 || p > 100.5) return false
    if (Number.isFinite(u) && Number.isFinite(w) && w > 0 && u > w * 1.02) return false
    return true
  }
  const ctxOf = (role) => {
    const live = (careState?.cards ?? []).find((c) => String(c.role) === String(role) && c.ctxPct != null)
    if (live) {
      if (!ctxSane(live.ctxPct, live.promptTokens, live.ctxWindow)) {
        return { text: '—', hint: '实时上下文数字不自洽（' + pk(live.promptTokens) + '/' + pk(live.ctxWindow) + '）⇒ 不拿累计值冒充窗口占用' }
      }
      const tail = live.ctxWindow ? ' · ' + compactTok(live.promptTokens) + '/' + compactTok(live.ctxWindow) : ''
      return { text: live.ctxPct + '%' + tail, hint: '近实时（卡片看护.json，约 10 秒刷新）· 完整 ' + pk(live.promptTokens) + '/' + pk(live.ctxWindow) }
    }
    // 账本里的 ctxPct 是历史累计值（cacheRead 会跨轮重复）⇒ 不是当前窗口占用。
    // 只有自洽时才显示，否则宁可 —；待命角色不再拿 812.3% 这种数吓人。
    const mine = calls.filter((c) => c.role === role && c.ctxPct != null)
    const last = mine.length ? mine[mine.length - 1] : null
    if (last && ctxSane(last.ctxPct, last.promptTokens, last.ctxWindow)) {
      const tail = last.ctxWindow ? ' · ' + compactTok(last.promptTokens) + '/' + compactTok(last.ctxWindow) : ''
      return { text: last.ctxPct + '%' + tail, hint: '上次（账本最近一条，仅自洽时显示）· 完整 ' + pk(last.promptTokens) + '/' + pk(last.ctxWindow) }
    }
    return { text: '—', hint: '没有可信的当前上下文；待命不拿账本累计值冒充窗口占用' }
  }
  for (const role of CARRIER_ROLES) {
    const r = roleRows.find((x) => String(x.role) === String(role)) ?? null
    const tone = r?.tone ?? 'off'                       // busy / standby / off / error（与图例同一套词）
    const busy = tone === 'busy'
    const ctx = ctxOf(role)
    push(role, {
      sub: r?.agent ?? (NODE_DEFS.find((d) => d.id === role)?.sub ?? ''),
      state: tone,
      stateText: busy
        ? ('在跑 ' + String(r?.task ?? r?.cardId ?? '?'))
        : (tone === 'error' ? '出错' : (tone === 'standby' ? '待命' : '没干过')),
      at: r?.lastAt ?? null,
      metrics: [
        { k: '卡', v: r?.task ? clip(String(r.task), 16) : '—', hint: r?.cardId ? ('卡号 ' + r.cardId) : null },
        { k: '上下文', v: ctx.text, hint: ctx.hint }
      ],
      why: busy
        ? '判活：编排登记的 childPid 活着 ⇒ 干活中。这一格只看这个角色的状态与上下文，内容去「看板」页那一格。'
        : (r ? ('这个角色现在没跑：' + String(r.why ?? '没有在跑登记') + '。上下文显示的是**最近一次**调用结束时的占用。') : '当前工作区没有这个角色的记录')
    })
  }
  const checkEvs = events.filter((e) => e.node === 'checks')
  push('checks', {
    state: glowOf(checksAt) >= 2 ? 'busy' : (checkEvs.some((e) => e.tone === 'err') ? 'error' : 'standby'),
    stateText: checksAt ? ((checkEvs[0].script ? String(checkEvs[0].script).replace(/\.mjs$/, '') : checkEvs[0].what) + ' · ' + secText(ageOf(checksAt)) + '前') : '窗口内没跑',
    at: checksAt,
    metrics: [
      { k: '闸门名录', v: names().gate.length + ' 个', hint: '按文件名动态发现：' + names().gate.slice(0, 6).join('、') + '…' },
      { k: '窗口内', v: checkEvs.length + ' 次', hint: checkEvs.slice(0, 3).map((e) => e.text).join(' ｜ ') || null },
      { k: '最近一次', v: checkEvs[0] ? (checkEvs[0].tone === 'err' ? '❌ 失败' : '✅ 通过') : '—', hint: checkEvs[0]?.out ? clip(checkEvs[0].out, 120) : null }
    ],
    why: '闸是**并联**的：谁经过谁被检（总闸＝起飞前检查）。一个脚本一格在下面**元件排**里（点闸＝看那一排）。'
  })
  push('tools', {
    state: toolProbe ? (toolOn ? 'standby' : 'off') : (toolItem ? stateOfService(toolItem) : 'unknown'),
    stateText: toolProbe ? (toolOn ? ('在跑（待命）· ' + (toolProbe.tools?.length ?? 0) + ' 个工具') : '没在跑（断电）') : (toolItem?.status === 'ok' ? '在跑（待命）' : '没在跑（断电）'),
    at: toolAt ?? msOf(ll.at),
    metrics: [
      { k: '端口', v: ':' + String(toolProbe?.port ?? toolItem?.port ?? 19400), hint: toolItem?.pid ? '登记 pid ' + toolItem.pid : null },
      { k: '窗口内调用', v: countOf('tools') + ' 次', hint: events.filter((e) => e.node === 'tools').slice(0, 3).map((e) => e.text).join(' ｜ ') || null },
      { k: '最近调用', v: toolAt ? secText(ageOf(toolAt)) + '前' : '窗口内没调用', hint: toolAt ? lastEvOf('tools').text : null }
    ],
    why: toolProbe ? ('探活：' + (toolOn ? '真发了一次 tools/list，通了' : '没通') + (toolProbe.why ? '（' + toolProbe.why + '）' : '')) : (toolItem ? '登记册：' + String(toolItem.why ?? '状态 ok') : '登记册里没有这一项')
  })
  // ★ 2026-10-23（施工文档 D15）：审核那一段 —— 正常"审了 N 轮"，跳过"跳过（L2）"灰灯，没记录"未审"
  const rv = lastReviewState(proj.path)
  const rvState = !rv ? 'unknown' : (rv.skipped ? 'standby' : (rv.ok === false ? 'error' : 'busy'))
  const rvText = !rv ? '未审（没有审核记录）'
    : (rv.skipped
        ? ('跳过' + (rv.level ? '（' + rv.level + '）' : (rv.reason && /轮次/.test(String(rv.reason)) ? '（轮次用尽）' : '')))
        : (rv.ok === false ? ('审了 —— 结论 ' + (rv.verdict ?? '未通过')) : ('审了 ' + (rv.rounds || 1) + ' 轮')))
  push('review', {
    state: rvState,
    stateText: rvText,
    at: rv?.at ?? null,
    metrics: [
      { k: '结论', v: rv ? (rv.skipped ? '跳过' : (rv.ok ? '通过' : '打回/未通过')) : '—', hint: rv?.reason ?? null },
      { k: '轮次', v: rv ? (rv.rounds + (rv.maxRounds ? ' / ' + rv.maxRounds : '')) : '—', hint: rv ? ('收据 ' + rv.run) : null },
      { k: '门禁', v: clip(String(rv?.gate ?? '—'), 40), hint: rv?.file ?? null }
    ],
    why: rv
      ? (rv.skipped
          ? '这一波**没有拉审核员**（' + (rv.reason ?? '原因未写') + '）—— 跳审是省钱动作，所以摆出来让你看见：省了，但也确实没审。'
          : '审核跑过，结论「' + (rv.ok ? '通过' : (rv.verdict ?? '未通过')) + '」；证据在 ' + rv.file)
      : '没有找到带 review 段的收据（老收据不会凭空长出这一段）⇒ 如实显示"未审"'
  })
  push('outbox', {    state: outboxGrowing ? 'busy' : (obFile?.outFile ? 'standby' : (lastEnvelope ? 'standby' : 'off')),
    stateText: outboxGrowing ? ('正在长（' + pk(obStat.size) + ' B）') : (lastEnvelope ? '上一封在盘上' : '没有信封'),
    at: obStat.mtime ?? lastEnvelope?.st.mtime ?? null,
    metrics: [
      { k: '在跑那轮', v: obFile?.outFile ? clip(basename(obFile.outFile), 26) : '—', hint: obFile?.outFile ?? (liveRec ? '登记里没有 run/cardId' : '现在没有在跑的活') },
      { k: '大小', v: obStat.exists ? pk(obStat.size) + ' B' : '—', hint: obStat.exists ? secText(obStat.ageSec) + '前写过' : null },
      { k: '最近一封', v: lastEnvelope ? clip(basename(lastEnvelope.file), 26) : '—', hint: lastEnvelope ? lastEnvelope.call.role + ' · ' + secText(lastEnvelope.st.ageSec) + '前' : null }
    ],
    why: obFile?.outFile ? '编排**边收边 append** ⇒ 这个文件的大小就是电流表（在跑时它一直在长）' : '没有在跑的活 ⇒ 没有正在长的信封'
  })
  push('ledger', {
    state: glowOf(ledgerAt) === 3 ? 'busy' : (calls.length ? 'standby' : 'off'),
    stateText: calls.length ? ('共 ' + calls.length + ' 条调用') : '空账本',
    at: ledgerAt ?? ledgerStat.mtime,
    metrics: [
      { k: '今日', v: todayCalls + ' 次', hint: quick.today ? '账本日期 ' + quick.today : null },
      { k: '文件', v: ledgerStat.exists ? (ledgerStat.size / 1024).toFixed(0) + ' KB' : '缺', hint: LEDGER },
      { k: '写于', v: secText(ledgerStat.ageSec) + '前', hint: '收活那一刻写一条' },
      { k: '窗口内收活', v: countOf('ledger') + ' 条', hint: null }
    ],
    why: '账本是**收活那一刻**才写的 ⇒ 它只能"闪"，不会常亮（正在跑要看 out.json 与 running 登记）。'
  })
  push('board', {
    state: glowOf(boardAt) >= 2 ? 'busy' : (boardStat.exists ? 'standby' : 'error'),
    stateText: boardStat.exists ? ('数据新鲜 · ' + secText(boardStat.ageSec) + '前') : '没有数据',
    at: boardStat.mtime,
    metrics: [
      { k: '采集于', v: secText(boardStat.ageSec) + '前', hint: String(b.collectedAt ?? '') },
      { k: '大小', v: boardStat.exists ? (boardStat.size / 1024).toFixed(0) + ' KB' : '—' },
      { k: '项目', v: proj.name ?? '（没钉工作区）', hint: proj.path },
      { k: '口径', v: String(b.policy?.state ?? '—'), hint: clip(b.policy?.note, 100) }
    ],
    why: '看板数据是**每次刷新现算**的（看板数据.mjs）⇒ 它一闪，你屏幕上就变了。'
  })
  push('you', {
    state: 'busy', stateText: '开着（每 1 秒同步）', at: Date.now(),
    metrics: [
      { k: '同步', v: '每 1 秒', hint: '只读轮询 /chain.json（零 token、不跑脚本、不写盘）' },
      { k: '电流', v: events.filter((e) => (e.at ?? 0) > Date.now() - 60000).length + ' 条 / 分钟', hint: '最近一分钟内的事件条数' },
      { k: '你最近发话', v: (() => { const u = t.inputs[t.inputs.length - 1]; return u ? secText(ageOf(u.at)) + '前' : '窗口内没有' })(), hint: (() => { const u = t.inputs[t.inputs.length - 1]; return u ? u.text : '转录窗口里没有你说的话（宿主提醒不算）' })() }
    ],
    why: '链路的终点，也是下一轮的起点（你一句话就回到大脑）⇒ 它是闭环的收尾那一笔。'
  })

  /* ⑥ 连线：live（段常亮）＋ level（余辉）＋ whyLive/why */
  const SIDE = {
    'rules>brain': 'special', 'brain>dispatch': 'to', 'dispatch>orch': 'to', 'orch>carrier': 'special',
    'carrier>outbox': 'special', 'outbox>ledger': 'to', 'ledger>board': 'to', 'board>you': 'from',
    'you>brain': 'from', 'checks>brain': 'from', 'checks>orch': 'from', 'tools>brain': 'from', 'tools>carrier': 'special'
  }
  /**
   * ★ b218：**每条线的"最近一次真实传递"**（谁 → 谁、传了什么、多久以前）。
   *   老实现只按"有没有活 / 节点最近有没有动静"点灯 ⇒ 三条边一起亮，看不出谁传给谁；
   *   而且转录只覆盖约 4 分钟，窗口外全显示"没发过卡"，和"编排在跑"自相矛盾。
   *   现在每条边都尽量落到**一个硬证据**（文件 mtime / 登记 / 账本 / 转录），带时间和内容摘要。
   */
  const lastCall = calls.length ? calls[calls.length - 1] : null
  const lastInput = Array.isArray(t.inputs) && t.inputs.length ? t.inputs[t.inputs.length - 1] : null
  const pickNewest = (arr) => arr.filter((x) => x && Number.isFinite(x.at)).sort((a, b) => b.at - a.at)[0] ?? null
  const edgeEvidence = (id) => {
    switch (id) {
      case 'rules>brain':
        // 这条线是"每轮注入"的常通线：大脑在跑 ⇒ 证据就是"此刻正在注入"；没跑 ⇒ 只能说规矩文件最后一次改动
        return brainBusy
          ? { at: Date.now(), what: '正在注入（大脑在跑第 ' + (bt.turn ?? '?') + ' 轮）', detail: (brainCount ?? '?') + ' 条常驻 / ' + (briefCount ?? '?') + ' 条卡面', source: '大脑轮次' }
          : (rulesMd?.mtime
              ? { at: rulesMd.mtime, what: '规矩文件最后一次改动', detail: (brainCount ?? '?') + ' 条常驻 / ' + (briefCount ?? '?') + ' 条卡面（大脑没在跑，此刻不注入）', source: '文件 mtime' }
              : null)
      case 'brain>dispatch': {
        const e = lastEvOf('dispatch')
        return pickNewest([
          e ? { at: e.at, what: '大脑派活（转录里那次调用）', detail: clip(e.text, 80), source: '会话转录' } : null,
          lastDispatch ? { at: lastDispatch.at, what: '发出卡 ' + lastDispatch.card, detail: lastDispatch.run, source: 'dispatch.json' } : null
        ])
      }
      case 'dispatch>orch':
        return pickNewest([
          liveRec && (liveRec.startedAtMs ?? msOf(liveRec.startedAt))
            ? { at: liveRec.startedAtMs ?? msOf(liveRec.startedAt), what: '开跑 ' + (liveRec.cardId ?? ''), detail: 'pid ' + (liveRec.childPid ?? '?'), source: 'running 登记' }
            : null,
          lastDispatch ? { at: lastDispatch.at, what: '开跑（发卡触发）', detail: lastDispatch.card, source: 'dispatch.json' } : null
        ])
      case 'orch>carrier':
        return liveRec
          ? { at: liveRec.startedAtMs ?? msOf(liveRec.startedAt) ?? null, what: 'spawn ' + (liveRec.role ?? '?'), detail: 'pid ' + (liveRec.childPid ?? '?') + ' · ' + (liveRec.cardId ?? ''), source: 'running 登记' }
          : null
      case 'carrier>outbox':
        return obStat.exists
          ? { at: obStat.mtime, what: '写信封', detail: basename(obFile?.outFile ?? '') + ' · ' + pk(obStat.size) + ' B', source: 'out.json mtime' }
          : null
      case 'outbox>ledger':
        return lastCall
          ? {
              at: msOf(lastCall.at),
              what: '收活落账',
              detail: [lastCall.role, lastCall.task, lastCall.ok === false || lastCall.isError ? '❌' : '✅', lastCall.usage?.totalTokens ? pk(lastCall.usage.totalTokens) + ' token' : null].filter(Boolean).join(' · '),
              source: '账本'
            }
          : null
      case 'ledger>board':
        return boardStat.mtime ? { at: boardStat.mtime, what: '重算看板数据', detail: 'board-data.json', source: '文件 mtime' } : null
      case 'board>you':
        // 这次响应本身就是"页面刚拉了一次"的证据 ⇒ 用时=现在，比 board-data 的 60 秒重算周期准
        return { at: Date.now(), what: '页面正在拉这次数据', detail: '每秒一次，零 token（这次响应就是证据）', source: '本次请求' }
      case 'you>brain':
        // 转录只覆盖约 4 分钟（60 帧）：窗口外拿不到"你说的话"，但**会话文件的 mtime** 还能给时间
        if (lastInput) return { at: lastInput.at, what: '你发话', detail: clip(lastInput.text, 80), source: '会话转录' }
        {
          const st = t.sessionPath ? statOf(t.sessionPath) : { exists: false }
          if (st.exists && st.mtime) {
            return { at: st.mtime, what: '会话最近一次写入（转录窗口外，看不出是不是你发的）', detail: basename(String(t.sessionPath)), source: '会话文件 mtime' }
          }
        }
        return null
      case 'checks>brain':
      case 'checks>orch': {
        const e = lastEvOf('checks')
        return e ? { at: e.at, what: '跑闸', detail: clip(e.text, 80), source: '会话转录' } : null
      }
      case 'tools>brain': {
        const e = lastEvOf('tools')
        return e ? { at: e.at, what: '调工具', detail: clip(e.text, 80), source: '会话转录' } : null
      }
      case 'tools>carrier':
        return null
      default:
        return null
    }
  }

  const edges = EDGE_DEFS.map((d) => {
    const f = lastEvOf(d.from)
    const tt = lastEvOf(d.to)
    const side = SIDE[d.id] ?? 'both'
    let level = glowOf(side === 'from' ? f?.at : (side === 'to' ? tt?.at : (Math.max(f?.at ?? 0, tt?.at ?? 0) || null)))
    const live = liveOf(d.id)
    if (d.id === 'tools>carrier' && carrierBusy) level = Math.max(level, 1)
    if (live) level = Math.max(level, 2)                       // 常亮的线至少"中档亮"，靠流动的点表达电流
    const why = (side === 'both' ? '两端' : (side === 'to' ? '判据端（' + NODE_LABEL[d.to] + '）' : '判据端（' + NODE_LABEL[d.from] + '）') + '：' + endText(side === 'to' ? d.to : d.from)) +
      '　｜　另一端（' + NODE_LABEL[side === 'to' ? d.from : d.to] + '）：' + endText(side === 'to' ? d.from : d.to)
    const whyLive = live
      ? (LIVE_WHY[d.id] ? LIVE_WHY[d.id]() : '这条线此刻通着电')
      : (LIVE_WHY[d.id] ? LIVE_WHY[d.id]() : (d.kind === 'supply' ? '供给线：这一刻没人用它' : '这一刻没有活经过'))
    // ★ b218：最近一次真实传递（谁 → 谁、传了什么、多久以前）；没有证据就如实 null
    const ev = edgeEvidence(d.id)
    const at = ev?.at ?? (Math.max(f?.at ?? 0, tt?.at ?? 0) || null)
    const lastEvent = ev ? { ...ev, ageSec: ageOf(ev.at), from: d.from, to: d.to, fromLabel: NODE_LABEL[d.from], toLabel: NODE_LABEL[d.to] } : null
    const whyEvent = lastEvent
      ? secText(lastEvent.ageSec) + '前：' + NODE_LABEL[d.from] + ' → ' + NODE_LABEL[d.to] + '　' + lastEvent.what + (lastEvent.detail ? '（' + lastEvent.detail + '）' : '') + '　证据：' + lastEvent.source
      : '窗口内没有这条线的传递记录（**没看到 ≠ 没发生**）'
    return { ...d, live, level, at, ageSec: lastEvent ? lastEvent.ageSec : null, why, whyLive, lastEvent, whyEvent }
  })
  const liveEdges = edges.filter((e) => e.live)

  /* ⑦ 元件排：一个脚本一格（闸门族）＋ 常驻 6（并联元件）*/
  const lastRunOfScript = (name) => {
    const e = events.find((x) => x.script === name)
    return e ? { at: e.at, tone: e.tone, dur: e.dur, exit: e.exit, text: e.text, out: e.out } : null
  }
  const gateParts = names().gate.map((f) => {
    const p = join(UNATT, f)
    const st = statOf(p)
    const lr = lastRunOfScript(f)
    const dur = lr?.dur ?? null
    const size = sizeByDur(dur) ?? 'small'
    const state = lr ? (lr.tone === 'err' ? 'error' : (fresh(lr.at, 10) ? 'busy' : 'standby')) : 'standby'
    return {
      id: 'script:' + f, detailId: 'script:' + f, name: f, group: 'gate', size,
      state, stateZh: STATES[state], stateText: lr ? (lr.tone === 'err' ? '上次失败' : (fresh(lr.at, 10) ? '刚跑完' : '待命')) : '待命（没跑过/不在窗口）',
      path: p, exists: st.exists, bytes: st.size, changedAt: st.mtime, changedAgeSec: st.ageSec,
      lastAt: lr?.at ?? null, lastOk: lr ? lr.tone !== 'err' : null, lastText: lr?.text ?? null,
      lastDur: dur, lastExit: lr?.exit ?? null, sizeWhy: dur != null ? ('实测用时 ' + dur.toFixed(1) + 's') : '窗口内没实测过 ⇒ 按最小档（不猜）'
    }
  })
  /* ★ b211（2026-10-20 用户："运转链里的东西肯定都是无人值守的东西啊，异次元是一个项目里的"）：
   *   长命资源登记册里有**两种属主**（`登记服务.mjs` 的约定）：`owner === '工作台'`＝无人值守自己的常驻件；
   *   `owner === 'session-…'`＝**某个项目/某条会话**的后端（换会话时会交接给它）。
   *   链路页讲的是**无人值守自身的运转** ⇒ **只收工作台级**；项目级的不进链（也不进"常驻 N"的计数），
   *   只在元件排标题上如实说一句"另有 N 个不在本页"。⚠️ 不写死任何项目名/端口。
   */
  const isWorkbenchResident = (x) => String(x?.owner ?? '工作台') === '工作台'
  const llItems = Array.isArray(ll.items) ? ll.items : []
  const residentAll = llItems.filter(isWorkbenchResident)
  const residentOther = llItems.filter((x) => !isWorkbenchResident(x))
  const residentParts = residentAll.map((x) => {
    const name = String(x.name)
    const state = stateOfService(x)
    const size = ({ '班组看板': 'big', '看护循环': 'big' })[name] ?? 'mid'
    return {
      id: 'svc:' + name, detailId: 'svc:' + name, name: name + (x.port && !String(name).includes(':' + x.port) ? ' :' + x.port : ''), group: 'resident', size,
      state, stateZh: STATES[state], stateText: String(x.why ?? (state === 'standby' ? '在跑（待命）' : '登记为已停')),
      path: null, port: x.port ?? null, pid: x.pid ?? null, ensure: x.ensure ?? null,
      lastAt: msOf(ll.at), lastOk: state !== 'error', lastText: String(x.why ?? x.status ?? ''),
      lastDur: null, lastExit: null, sizeWhy: '常驻件（不是"跑一次就退"的脚本）'
    }
  })
  const parts = gateParts.concat(residentParts)
  if (full) for (const p of parts) {
    if (p.group !== 'gate') continue
    const lr = lastRunOfScript(String(p.name))
    p.lastOut = lr?.out ?? null
    const ts = textStats(String(p.path))
    p.lines = ts.lines
    p.chars = ts.chars
  }

  /* ⑧ 常驻资源（抽屉用：带登记册全字段）—— ★ b211：只列工作台级（项目/会话级的不进链路页） */
  const services = residentAll.map((x) => ({
    id: 'svc:' + String(x.name), name: String(x.name), kind: x.kind ?? null, port: x.port ?? null, pid: x.pid ?? null,
    owner: x.owner ?? null, expect: x.expect ?? null, ensure: x.ensure ?? null, status: x.status ?? null, why: x.why ?? null, alive: x.alive === true,
    state: stateOfService(x), stateZh: STATES[stateOfService(x)],
    probe: String(x.name) === '工具服务' && toolProbe ? { state: toolProbe.state, tools: toolProbe.tools ?? null, why: toolProbe.why ?? null } : null
  }))

  // ★ 窗口占用与"转录窗口累计"分开：
  //   · 窗口占用 = 大脑会话投影的 contextPressure（当前上下文 / 窗口），这才是"快不快满"；
  //   · 本窗 token = 转录尾巴里 60 帧的累计调用量，只说明"这段窗口里花了多少"，不是当前占用。
  const ctxShort = br.contextText ? String(br.contextText).split('·')[0].trim() : null
  const meter = {
    todayCalls, todayTokens: num(b.ledger?.todayTokens),
    contextPercent: br.contextPercent ?? null,
    contextUsed: br.contextUsed ?? null,
    contextWindow: br.contextWindow ?? null,
    contextSoft: br.contextSoft ?? null,
    contextHard: br.contextHard ?? null,
    contextText: ctxShort,
    contextFullText: br.contextText ?? null,
    contextLevel: br.contextLevel ?? null,
    contextTrust: br.contextTrust ?? null,
    contextNote: br.contextNote ?? null,
    windowSteps: t.usage?.steps ?? 0, windowIn: t.usage?.inTok ?? 0, windowOut: t.usage?.outTok ?? 0, windowCache: t.usage?.cacheTok ?? 0,
    windowSpanMin: t.spanMin ?? null,
    callsTotal: calls.length,
    busyNodes: nodes.filter((n) => n.state === 'busy').length,
    liveEdges: liveEdges.length,
    events1min: events.filter((e) => (e.at ?? 0) > Date.now() - 60000).length,
    partsTotal: parts.length
  }

  const val = {
    ok: true, at: new Date().toISOString(), ms: Date.now(), buildTag: opts.buildTag ?? null, full,
    project: {
      name: proj.name, path: proj.path, pinned: proj.pinned,
      pinPath: proj.pinPath, pinName: proj.pinName, resolvedBy: proj.resolvedBy,
      noWorkbench: proj.noWorkbench, banner: proj.banner
    },
    states: STATES, sizes: SIZE_ZH,
    window: {
      frames: TAIL_FRAMES, framesOk: t.framesOk ?? 0, spanMin: t.spanMin ?? null, sessionPath: t.sessionPath ?? null, sessionId: t.sessionId ?? null,
      note: t.ok
        ? '电流证据＝这条大脑会话的转录尾巴（最近 ' + (t.framesOk ?? 0) + ' 帧，覆盖约 ' + (t.spanMin ?? '?') + ' 分钟）＋ 账本 ＋ running 登记 ＋ 登记册'
        : '读不到这条会话的转录：' + String(t.why ?? '') + ' ⇒ 只剩账本与文件时间这两路证据'
    },
    work: { hasWork, why: workWhy, liveSegments: liveEdges.map((e) => e.id), runningFiles: running.map((r) => basename(r.file)) },
    meter, nodes, edges, events: events.slice(0, 40), roles: roleRows, parts, services,
    /* ★ b211：登记册里**不属于工作台**的长命资源（项目/会话级）—— 不进本页，只报个数与名字，
       让页面上能写一句"另有 N 个不在本页"（不静默吞掉，也不把别人的后端摆进无人值守的电路图）。 */
    residentsOther: { count: residentOther.length, names: residentOther.map((x) => String(x.name)) },
    scripts: gateParts.map((p) => ({ name: p.name, path: p.path, exists: p.exists, size: p.bytes, ageSec: p.changedAgeSec, node: 'checks' })),
    notes: [
      '这一页**只读**：不跑脚本、不写文件、不调模型（零 token）。',
      '电流＝活流过的那条通路：**段常亮**（串联连通）＋事件闪＋余辉；每条线都能点开看 why。',
      '子 agent 只显示状态 —— 要看它具体干了什么，去「看板」页点开那一格。'
    ]
  }
  _view.set(key, { at: Date.now(), val })
  return val
}

/* ══ 开盒：点一个用电器（或一个小元件），看它的内部零件 / 最近结果 / 出错现场 ══ */
function excerpt (file, { head = 30, maxMembers = 40 } = {}) {
  const txt = readText(file)
  if (txt == null) return null
  const lines = txt.split('\n')
  const headLines = lines.slice(0, head).map((s, i) => ({ n: i + 1, text: clip(s, 160) }))
  const members = []
  for (let i = 0; i < lines.length && members.length < maxMembers; i++) {
    const s = lines[i]
    if (/^\s*(export\s+)?(async\s+)?function\s+\w+|^\s*(export\s+)?const\s+[A-Z][A-Z0-9_]{2,}\s*=/.test(s)) members.push({ n: i + 1, text: clip(s, 150) })
  }
  return { total: lines.length, head: headLines, members, chars: txt.length }
}

export function chainDetail (id, opts = {}) {
  const b = readJson(BOARD) ?? {}
  const t = transcript()
  const evs = eventsFromTranscript().out
  const head = { ok: true, id, at: new Date().toISOString() }
  const part = (name, value, detail, extra) => ({ name, value, detail: detail ?? null, ...(extra ?? {}) })
  const rows = (arr, n = 20) => arr.slice(0, n)
  /** ③最近一次结果 ④出错现场 —— 两块共用同一段构造（没有就说没有，不编）。
   *  ⚠️ `only`：传了脚本名就**只认这个脚本**的记录（脚本抽屉不能用整个闸门族的——那是错的归属）。 */
  const resultBlocks = (node, whatLabel, only) => {
    const pool = only ? evs.filter((e) => e.script === only) : evs.filter((e) => e.node === node)
    const last = pool[0] ?? null
    const lastErr = pool.find((e) => e.tone === 'err') ?? null
    const result = last ? {
      at: last.at, ok: last.tone !== 'err', what: last.what, text: last.text,
      dur: last.dur, exit: last.exit, out: last.out
    } : null
    const error = lastErr ? { at: lastErr.at, what: lastErr.what, text: lastErr.text, exit: lastErr.exit, out: lastErr.out } : null
    return [
      part('最近一次结果' + (whatLabel ? '（' + whatLabel + '）' : ''), result
        ? ((result.ok ? '✅ 成功' : '❌ 失败') + ' · ' + secText(ageOf(result.at)) + '前' + (result.dur != null ? ' · 用时 ' + result.dur.toFixed(1) + 's' : '') + (result.exit != null ? ' · exit ' + result.exit : ''))
        : '窗口内没跑过（不等于没跑过）',
        result ? clip(result.text, 200) : null),
      part('出错现场', error
        ? ('❌ ' + secText(ageOf(error.at)) + '前 · ' + error.what + (error.exit != null ? ' · exit ' + error.exit : ''))
        : '窗口内没看到失败',
        error ? clip(error.out || error.text, 500) : null)
    ]
  }

  /* —— 单个脚本（元件排里点进来的）—— */
  if (String(id).startsWith('script:')) {
    const name = String(id).slice(7)
    const file = join(UNATT, name)
    const st = statOf(file)
    const txt = readText(file)
    const ex = excerpt(file)
    const last = evs.find((e) => e.script === name) ?? null
    const errAll = evs.filter((e) => e.script === name && e.tone === 'err')
    const dur = last?.dur ?? null
    return {
      ...head, title: '小元件：' + name, sub: (names().gate.includes(name) ? '闸门族（体检/门禁）' : '脚本') + ' · ' + (sizeByDur(dur) ?? 'small'),
      box: { lines: txt == null ? null : txt.split('\n').length, chars: txt == null ? null : txt.length },
      chips: [
        { k: '状态', v: last ? (last.tone === 'err' ? '出错' : (fresh(last.at, 10) ? '刚跑完' : '待命')) : '待命' },
        { k: '格子大小', v: sizeByDur(dur) ?? 'small', hint: dur != null ? '实测用时 ' + dur.toFixed(1) + 's' : '窗口内没实测过 ⇒ 最小档' },
        { k: '改于', v: secText(st.ageSec) + '前' }
      ],
      parts: [
        part('文件', file, st.exists ? (pk(st.size) + ' B · ' + (txt ?? '').split('\n').length + ' 行') : '文件不存在'),
        ...resultBlocks('checks', name, name),
        part('它属于哪一族', names().gate.includes(name) ? '闸门族（按文件名动态发现，共 ' + names().gate.length + ' 个）' : '普通脚本', '发现规则：文件名匹配 体检|自检|门禁|复验|指纹|检查|验收|对账|冒烟')
      ],
      rows: rows(evs.filter((e) => e.script === name).map((e) => ({ at: e.at, text: e.text + (e.tone === 'err' ? ' ❌' : ' ✅') })), 20),
      rowsTitle: '窗口内这个脚本跑过的记录',
      code: ex ? { title: '源码摘录', head: ex.head, members: ex.members, total: ex.total, chars: ex.chars } : null,
      note: '只看不改：这里没有任何写操作。要改脚本请走「✏️ 改规矩」或直接编辑文件。'
        + (errAll.length ? '　⚠️ 窗口内失败过 ' + errAll.length + ' 次。' : '')
    }
  }

  /* —— 常驻资源 —— */
  if (String(id).startsWith('svc:')) {
    const name = String(id).slice(4)
    const ll = b.longlive ?? readJson(LONGLIVE) ?? {}
    const item = (ll.items ?? []).find((x) => String(x.name) === name) ?? null
    const st = stateOfService(item ?? {})
    return {
      ...head, title: '常驻资源：' + name, sub: '并联用电器 —— 不在主干上，但主干常常靠它',
      chips: [{ k: '状态', v: STATES[st] }, { k: '端口', v: item?.port ? ':' + item.port : '—' }, { k: 'pid', v: item?.pid ? String(item.pid) : '—' }],
      parts: [
        part('登记册这一行', item ? (String(item.kind ?? '') + ' · 期望 ' + String(item.expect ?? '—') + ' · 属主 ' + String(item.owner ?? '—')) : '没有这一项', item?.why ?? null),
        part('最近一次结果（巡检核对于）', String(ll.at ?? '—'), '结论：' + String(ll.verdict ?? '—')),
        part('出错现场', st === 'error' ? ('❌ ' + String(item?.why ?? '登记为该活着但没活着')) : '这次核对没报错（' + String(item?.status ?? '—') + '）', null),
        part('死了怎么拉起', String(item?.ensure ?? '（没有 ensure，得手工）'), item?.ensure ? join(UNATT, String(item.ensure)) : null),
        part('谁在核', '长命资源巡检（看护循环里）', '判据在 登记服务.mjs：孤儿 / 属主 / 死活三态')
      ],
      rows: rows((ll.items ?? []).map((x) => ({ at: null, text: String(x.name) + ' · ' + String(x.status) + (x.port ? ' :' + x.port : '') + (x.pid ? ' pid ' + x.pid : '') + (x.why ? ' · ' + x.why : '') })), 20),
      rowsTitle: '同一册里的其他项',
      note: '这一栏是**只读**的：面板只管看与拉起，从不杀谁。'
    }
  }

  if (id === 'brain') {
    const brRow = b.brainRow ?? {}
    const bt = brainTurnState()
    return {
      ...head, title: '大脑（DSH 会话）', sub: 'persona ＋ 这条会话的转录；链路的"主机"',
      chips: (function () {
        // ★ 2026-10-26：这条"读不到转录"的兜底分支也要有 token 那格，
        //   否则用户只看到 状态/上下文/模型 三格，会以为"根本没统计"。
        const su = sessionUsage(t.sessionPath ?? brRow.sessionPath ?? null)
        const tokenChip = (su.ok && su.steps)
          ? { k: '本会话 token', v: pk(su.total) + ' token', hint: '**整条会话累计**（' + su.steps + ' 次模型调用 · 输入 ' + pk(su.inTok) + ' / 输出 ' + pk(su.outTok) + ' · 缓存读 ' + pk(su.cacheTok) + '）' }
          : { k: '本会话 token', v: '—', hint: (su.why || (su.ok ? '这条会话还没有模型调用记录（0 次）' : '会话转录读不到')) + '（不估算）' }
        return [
          { k: '状态', v: bt.ok ? (bt.running ? '干活中' : '待命') : '未知' },
          { k: '上下文', v: brRow.contextText ?? '—' },
          tokenChip,
          { k: '模型', v: clip(brRow.modelText, 60) }
        ]
      })(),
      parts: [
        part('常驻规矩（persona）', (readText(join(ROLES, 'brain.md')) ?? '').length + ' 字符', join(ROLES, 'brain.md') + ' —— 每轮全文注入'),
        part('会话', String(brRow.sessionId ?? t.sessionId ?? '—'), t.sessionPath ?? null),
        part('在干活判据', bt.ok ? bt.why : (bt.why ?? '看不出'), '来自 大脑会话.mjs 的 turnStateOf（最近一个轮次标记是 turn/start 还是 turn/end）'),
        part('本窗 token', (t.usage?.steps ?? 0) + ' 次模型调用', t.usage ? ('转录窗口累计，不是当前上下文；输入 ' + pk(t.usage.inTok) + ' · 输出 ' + pk(t.usage.outTok) + ' · 缓存读 ' + pk(t.usage.cacheTok)) : null),
        part('转录窗口', (t.framesOk ?? 0) + ' / ' + TAIL_FRAMES + ' 帧', t.ok ? ('覆盖约 ' + (t.spanMin ?? '?') + ' 分钟 · 文件 ' + Math.round((t.fileBytes ?? 0) / 1024) + ' KB') : String(t.why ?? '')),
        part('上下文压缩', t.compactions.length ? t.compactions.length + ' 次' : '窗口内没有', t.compactions.length ? '转录里出现 compaction/start（上下文满了自动压缩）' : null),
        ...resultBlocks('brain', '大脑这一侧的动作')
      ],
      rows: rows((t.calls ?? []).slice().reverse().map((c) => {
        let a = {}
        try { a = JSON.parse(String(c.args ?? '{}')) } catch {}
        return { at: c.at, text: c.name + ' ' + clip(a.description || a.command || a.file_path || '', 110) }
      }), 20),
      rowsTitle: '最近的工具调用（转录，倒序）',
      note: '**能看到的就是这条会话真干过的事**：工具调用、用量、你的输入，全是从转录里读的原件。'
    }
  }
  if (id === 'rules') {
    const list = (() => {
      try {
        return stripComments(readFileSync(join(ROLES, 'brain.md'), 'utf8')).split('\n')
          .map((l) => l.trim()).filter((l) => /^\d+\./.test(l)).map((l) => clip(l.replace(/^\d+\.\s*/, ''), 130))
      } catch { return [] }
    })()
    const files = [['brain.md', '常驻（每轮全文注入 persona）'], ['班组须知.md', '卡面（每张卡内联）'], ['班组须知-细则.md', '条件性全文（按需读）']]
    return {
      ...head, title: '常驻规矩（三份规则源）', sub: '改规矩＝改这三份；谁进上下文、什么时候进，看每一行的说明',
      chips: [{ k: '常驻条数', v: String(list.length) }, { k: '目录', v: ROLES }],
      parts: files.map(([f, why]) => {
        const st = statOf(join(ROLES, f))
        return part(f, st.exists ? (readText(join(ROLES, f)) ?? '').length + ' 字 · ' + secText(st.ageSec) + '前改' : '缺文件', why + '　' + join(ROLES, f))
      }),
      rows: rows(list.map((x, i) => ({ at: null, text: (i + 1) + '. ' + x })), 30),
      rowsTitle: 'brain.md 里的规矩（逐条，剥掉注释后）',
      note: '改常驻规矩**要重启桌面端**（persona 在加载 profile 时求值一次）；改卡面**下一张卡就生效**。'
    }
  }
  if (id === 'dispatch' || id === 'orch' || id === 'outbox') {
    const projPath = b.currentProject?.path ?? null
    const running = runningRecords(projPath)
    const calls = Array.isArray(readJson(LEDGER)?.calls) ? readJson(LEDGER).calls : []
    const local = evs.filter((e) => e.node === id)
    const title = id === 'dispatch' ? '派活.mjs（发卡）' : id === 'orch' ? '编排.mjs（调度 · 收活）' : '回收 out.json（信封）'
    return {
      ...head, title,
      sub: id === 'outbox' ? '编排边收边 append 的那个文件 —— 它的大小就是电流表' : '证据三路：转录里的调用 ＋ 账本里的收活 ＋ running 登记',
      chips: [{ k: '在跑登记', v: running.filter((r) => r.alive).length + ' / ' + running.length }, { k: '账本调用', v: String(calls.length) }],
      parts: [
        ...(id === 'outbox' ? [] : [part('脚本', join(UNATT, id === 'dispatch' ? '派活.mjs' : '编排.mjs'), id === 'dispatch' ? '把 TASKS 里的活发成一张卡（提示词 ＋ 内联的班组须知）' : 'spawn 载体、边收边写 out.json、收活落账')]),
        ...running.map((r) => part('在跑：' + String(r.role ?? '?'), (r.cardId ?? '?') + (r.alive ? ' · pid ' + r.childPid + ' 活着' : ' · 登记在，但进程已死'), (() => {
          const f = inFlightFiles(projPath, r.run, r.cardId)
          const s = f?.outFile ? statOf(f.outFile) : null
          return f?.outFile ? f.outFile + (s?.exists ? '（' + pk(s.size) + ' B · ' + secText(s.ageSec) + '前写过）' : '（还没落盘）') : null
        })())),
        ...(running.length ? [] : [part('在跑登记', '没有', join(projPath ?? '（没钉工作区）', '_crew', 'running'))]),
        ...resultBlocks(id, title)
      ],
      rows: rows(local.length ? local.map((e) => ({ at: e.at, text: e.text + (e.tone === 'err' ? ' ❌' : ' ✅') })) : calls.slice(-20).reverse().map((c) => ({ at: msOf(c.at), text: String(c.role ?? '?') + ' ' + String(c.task ?? '?') + ' ' + ((c.ok === false) ? '❌' : '✅') + (c.numTurns ? ' ' + c.numTurns + ' 回合' : '') })), 20),
      rowsTitle: local.length ? '窗口内的动作（转录）' : '账本里最近 20 条收活',
      note: '编排的真实性判据是 **pid 判活**（running 登记里的 childPid）；账本只在收活那一刻写 ⇒ 它看不见"正在跑"。'
    }
  }
  const carrierRole = CARRIER_ROLES.includes(String(id)) ? String(id) : null
  if (id === 'carrier' || carrierRole) {
    const allRoles = ((b.crewByProject ?? []).find((p) => String(p.path) === String(b.currentProject?.path))?.roles) ?? []
    const roleRows = carrierRole ? allRoles.filter((r) => String(r.role) === carrierRole) : allRoles
    const calls = Array.isArray(readJson(LEDGER)?.calls) ? readJson(LEDGER).calls : []
    const mineCalls = carrierRole ? calls.filter((c) => String(c.role) === carrierRole) : calls
    // 这个角色最近的 attempt（只读）；读不到就 mark 出来，不假装"没有失败过"
    let attempts = []
    let attemptsWhy = null
    try {
      const db = openDb({ dbPath: process.env.DSH_STATE_DB ?? DEFAULT_DB, readonly: true })
      try {
        const rows = listAttempts(db, { project: String(b.currentProject?.path ?? ''), role: carrierRole, limit: 10 })
        attempts = attemptDigest(rows)
      } finally { try { db.close() } catch {} }
    } catch (e) { attemptsWhy = '读不到 C 状态库：' + String(e?.message ?? e).slice(0, 120) }
    return {
      ...head,
      attempts,
      attemptsWhy,
      title: carrierRole ? ('载体 · ' + carrierRole) : '载体进程（子 agent）',
      sub: carrierRole
        ? '这个角色的状态、模型、最近在跑的卡、最近 20 条收活 —— **只看状态与上下文**'
        : '每个角色一行：谁在干活、跑什么、用的哪家模型 —— **只看状态**',
      chips: carrierRole
        ? [{ k: '角色', v: carrierRole }, { k: '在干活', v: String(roleRows.filter((r) => r.state === 'running').length) }, { k: '账本条数', v: String(mineCalls.length) }]
        : [{ k: '角色', v: String(roleRows.length) }, { k: '在干活', v: String(roleRows.filter((r) => r.state === 'running').length) }],
      parts: roleRows.map((r) => {
        const mine = mineCalls.filter((c) => c.role === r.role)
        const last = mine[mine.length - 1]
        return part(String(r.role), (STATE_ZH_ROLE[r.state] ?? '—') + ' · ' + String(r.agent ?? '—') + (r.live?.childPid ? ' (pid ' + r.live.childPid + ')' : ''), [clip(r.modelText, 70), r.live?.task ? '在跑：' + r.live.task : null, last ? '最近收活 ' + String(last.at ?? '').replace('T', ' ').slice(5, 16) + ' · ' + String(last.task ?? '') + ((last.ok === false) ? ' ❌' : ' ✅') : '账本里没有它的记录'].filter(Boolean).join('　｜　'))
      }),
      rows: rows(mineCalls.slice(-20).reverse().map((c) => ({ at: msOf(c.at), text: String(c.role ?? '?') + ' · ' + String(c.task ?? '?') + ' · ' + ((c.ok === false) ? '❌' : '✅') + (c.numTurns ? ' ' + c.numTurns + ' 回合' : '') + (c.usage?.totalTokens ? ' · ' + pk(c.usage.totalTokens) + ' token' : '') + (c.model ? ' · ' + c.model : '') })), 20),
      rowsTitle: carrierRole ? ('这个角色最近 20 条账本') : '账本里最近 20 条（所有角色）',
      note: carrierRole
        ? '这一格只归拢这个角色的状态；具体对话去「看板」页那一格的「会话」。'
        : '要看某个子 agent 具体说了什么、写到哪 ⇒ 去「看板」页点开它那一格的「会话」。'
    }
  }
  if (id === 'ledger') {
    const doc = readJson(LEDGER) ?? {}
    const calls = Array.isArray(doc.calls) ? doc.calls : []
    return {
      ...head, title: '账本', sub: '收活那一刻写一条；看板、工量账本、额度都读它',
      chips: [{ k: '总条数', v: String(calls.length) }, { k: '今日', v: String(b.ledger?.todayCalls ?? '—') }, { k: '坑', v: String(num(doc.pitfalls?.length)) }],
      parts: [
        part('文件', (statOf(LEDGER).size / 1024).toFixed(0) + ' KB', LEDGER),
        part('今日调用', String(b.ledger?.todayCalls ?? '—') + ' 次', '账本 updatedAt ' + String(doc.updatedAt ?? '—')),
        part('速度量具', b.ledger?.speed ? (b.ledger.speed.stale ? '过期' : '新鲜') : '没有', b.ledger?.speed ? ('算于 ' + String(b.ledger.speed.at ?? '') + ' · 每回合中位 ' + String(b.ledger.speed.secPerTurn?.computed ?? '?')) : null),
        ...resultBlocks('ledger', '收活')
      ],
      rows: rows(calls.slice(-25).reverse().map((c) => ({ at: msOf(c.at), text: String(c.at ?? '').replace('T', ' ').slice(5, 19) + ' · ' + String(c.role ?? '?') + ' · ' + String(c.task ?? '?') + ' · ' + ((c.ok === false) ? '❌' : '✅') + (c.numTurns ? ' ' + c.numTurns + ' 回合' : '') + (c.usage?.totalTokens ? ' · ' + pk(c.usage.totalTokens) + ' token' : '') })), 25),
      rowsTitle: '最近 25 条调用（倒序）',
      note: '⚠️ 账本是**收活才写**的 ⇒ "正在跑"这一列它天生看不出来（要 running 登记）。'
    }
  }
  if (id === 'board') {
    const st = statOf(BOARD)
    return {
      ...head, title: '看板数据.mjs（board-data.json）', sub: '看板所有页的数据源；每刷新一次现算一次',
      chips: [{ k: '采集于', v: secText(st.ageSec) + '前' }, { k: '大小', v: (st.size / 1024).toFixed(0) + ' KB' }, { k: '字段', v: String(Object.keys(b).length) }],
      parts: [
        part('文件', BOARD, '写方＝看板数据.mjs（页面刷新时若缓存过期就重算）'),
        part('顶层字段', String(Object.keys(b).length) + ' 个', Object.keys(b).join('、')),
        ...resultBlocks('board', '生成看板数据')
      ],
      rows: rows(Object.entries(b).slice(0, 30).map(([k, v]) => ({ at: null, text: k + ' = ' + clip(typeof v === 'object' ? JSON.stringify(v) : String(v), 130) })), 30),
      rowsTitle: '顶层字段一览',
      note: '这一页（运转链）**不写**它，只读它 ＋ 转录 ＋ 账本。'
    }
  }
  if (id === 'checks') {
    const local = evs.filter((e) => e.node === 'checks')
    const gate = names().gate
    return {
      ...head, title: '闸（体检 / 门禁）', sub: '并联的闸：谁经过谁被检 —— 一个脚本一格在元件排里（下面那排）',
      chips: [{ k: '名录', v: gate.length + ' 个' }, { k: '窗口内跑过', v: local.length + ' 次' }],
      parts: [
        part('发现规则', '按文件名动态发现', '体检|自检|门禁|复验|指纹|检查|验收|对账|冒烟 ⇒ 共 ' + gate.length + ' 个（加一个脚本，这里自动多一个）'),
        part('总闸', join(UNATT, '起飞前检查.mjs'), '它的产物就是"能不能起飞"：✅ 可以起飞 / ❌ 看第几项'),
        ...resultBlocks('checks', '闸门族'),
        ...gate.slice(0, 12).map((f) => { const s = statOf(join(UNATT, f)); return part(f, s.exists ? (s.size / 1024).toFixed(1) + ' KB' : '缺', '改于 ' + secText(s.ageSec) + '前') })
      ],
      rows: rows(local.map((e) => ({ at: e.at, text: e.text + (e.tone === 'err' ? ' ❌' : ' ✅') })), 20),
      rowsTitle: '窗口内这些闸跑过的记录（转录）',
      note: '每个脚本点开看它自己的**最近一次结果 / 出错现场 / 源码摘录** —— 在下面元件排里点。'
    }
  }
  if (id === 'tools') {
    const ll = b.longlive ?? readJson(LONGLIVE) ?? {}
    const item = (ll.items ?? []).find((x) => String(x.name) === '工具服务') ?? null
    const local = evs.filter((e) => e.node === 'tools')
    return {
      ...head, title: '工具服务（本机 MCP）', sub: '三个零 token 工具：查坑 / 核指纹 / 读门禁',
      chips: [{ k: '登记册', v: item ? String(item.status) : '没有' }, { k: '端口', v: ':' + String(item?.port ?? 19400) }, { k: '窗口内调用', v: local.length + ' 次' }],
      parts: [
        part('登记册那一行', item ? (String(item.status) + (item.pid ? ' · pid ' + item.pid : '') + ' · 期望 ' + String(item.expect ?? '—')) : '没有这一项', item?.why ?? null),
        part('三工具', 'pitfall_search / fingerprint_check / gate_summary', '实现：_unattended\\_mcp中转.mjs（本机 19400）'),
        part('生命周期', '跟 DSH 走', 'DSH 启动时由插件自启；面板只"看状态 + 红灯拉起"，从不杀'),
        ...resultBlocks('tools', '工具调用')
      ],
      rows: rows(local.map((e) => ({ at: e.at, text: e.text + (e.tone === 'err' ? ' ❌' : ' ✅') })), 20),
      rowsTitle: '窗口内调用记录（转录）',
      note: '它是**并联供给**：大脑和班组谁都能用；不用它也不影响主干。'
    }
  }
  if (id === 'you') {
    return {
      ...head, title: '你看板（这个窗口）', sub: '链路的终点，也是下一轮的起点',
      chips: [{ k: '页面', v: '运转链' }, { k: '同步', v: '每 1 秒（只读）' }, { k: '窗口内发话', v: String(t.inputs.length) }],
      parts: [
        part('为什么终点是它', '所有产物最终都被摆到这里给你看', '账本/收据 → 看板数据 → 页面'),
        part('为什么起点也是它', '你一句话（或看板上一个按钮）就回到大脑', '所以这是一条**闭环**，不是流水线'),
        part('转录窗口', (t.framesOk ?? 0) + ' / ' + TAIL_FRAMES + ' 帧', t.ok ? ('覆盖约 ' + (t.spanMin ?? '?') + ' 分钟') : String(t.why ?? ''))
      ],
      rows: rows(t.inputs.slice().reverse().map((u) => ({ at: u.at, text: u.text })), 12),
      rowsTitle: '转录里"你发话"的记录（宿主注入的提醒已剔除）',
      note: '这一页自己不写任何文件 —— 你在这里点开的一切都是只读的。'
    }
  }
  return { ok: false, id, error: '不认识的用电器：' + String(id) }
}

/* ── CLI：`node 链路面板.mjs [--full]` 打一份摘要（核对用，不进页面）── */
const isMain = (() => { try { return process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url)) } catch { return false } })()
if (isMain) {
  // 工具服务的死活**问面板那盏灯**（/relay.json，与页面同源）—— 拿不到就退回登记册，并在输出里说明。
  let tool = null
  try {
    const r = await fetch('http://127.0.0.1:' + (process.env.DSH_PANEL_PORT ?? 19450) + '/relay.json', { signal: AbortSignal.timeout(1500) })
    if (r.ok) tool = await r.json()
  } catch { tool = null }
  const v = chainView({ full: process.argv.includes('--full'), tool })
  console.log('采集于', v.at, '｜项目', v.project.name ?? '（没钉）', '｜', v.window.note)
  console.log('电流表', JSON.stringify(v.meter), '｜工具服务探活', tool ? tool.state : '（没问到 ⇒ 按登记册）')
  console.log('有活？', v.work.hasWork, '｜', clip(v.work.why, 120))
  console.log('通电段', v.work.liveSegments.join('  ') || '（全断）')
  for (const n of v.nodes) console.log(' ●', n.id.padEnd(9), (n.stateZh + '').padEnd(4), n.size.padEnd(6), clip(n.stateText, 30).padEnd(32), '｜', n.metrics.map((m) => m.k + '=' + clip(m.v, 20)).join(' '))
  for (const e of v.edges) console.log(' ~', e.id.padEnd(16), (e.live ? '通' : '断'), 'L' + e.level, e.kind, '｜', clip(e.whyLive, 90))
  console.log('元件排', v.parts.length, '个：', v.parts.map((p) => p.name + '(' + p.size + '/' + p.stateZh + ')').join(' '))
  console.log('事件（最近 8）')
  for (const e of v.events.slice(0, 8)) console.log('  ', new Date(e.at).toLocaleTimeString('zh-CN', { hour12: false }), (e.node + '').padEnd(9), (e.what + '').padEnd(8), clip(e.text, 70))
}
