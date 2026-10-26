#!/usr/bin/env node
/**
 * 会话流 · **把某角色"跟载体说了什么、载体回了什么"拼成一段会话**（看板 ④ 会话视图的数据生产者）
 *
 * ## 一句话
 * 输入取自 `<项目>\_crew\tasks\<任务>.prompt.txt`（**全文**），
 * 输出取自账本 `calls[].envelope` 指的那份 `.out.json`，
 * 中间用**会话级归一化**（`面板\会话\session.mjs`，六家各一个翻译器）翻成统一条目。
 *
 * ★ 2026-10-11（A4-②）：**账本之外，还补"在跑那一轮"** —— 账本要收活才写，
 *   所以正在跑的一轮原本**在会话里不存在**。现在按编排的 running 登记（pid 活＋没过 deadline）
 *   算出 `<项目>\_crew\runs\<戳>\{tasks,review}\<cardId>.{prompt.txt,out.json}` 直接读，
 *   编排是边收边 append ⇒ **跑着时就能看到内容长出来**（`live:true` 标在那一轮上）。
 *
 * ## 为什么走"读盘"而不是"新落一份会话文件"
 * ① 数据**本来就在盘上**（实测：prompt 6890 字全文、账本 envelope 覆盖 90/104）⇒ 零新增状态、不会漂；
 * ② 面板是**读文件**不是**接管输出** ⇒ **不碰"输出绝不接管道"那条铁律**（见施工文档 §2.3）；
 * ③ 编排已是**增量落盘** ⇒ 正在跑时这份文件会**边跑边长**，"边跑边看"天然成立（消费侧要容忍末行半截）。
 *
 * ## 找不到就如实说（面板老规矩）
 *   · 这一轮没记 `envelope` ⇒ `note: '这一轮没记输出路径'`（老记录，14/104）
 *   · 文件就在盘上、但名字猜不出（prompt 用任务 id、输出用 cardId，两者可能不同）⇒ `note: '没找到输出文件'`
 *
 * 用法：
 *   node 会话流.mjs --role coder-b [--project <项目目录>] [--limit 5] [--json]
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toConversation, SUPPORTED } from './面板/会话/session.mjs'
import { findRunningRecord, inFlightFiles } from './面板/帧数据.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const has = (n) => argv.includes(`--${n}`)

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null } }
const readText = (p) => { try { return readFileSync(p, 'utf8').replace(/^\uFEFF/, '') } catch { return null } }

/** 载体的键（`agents.json` 的 agents 段键）。账本存的是 `role`，要经 `roles` 段换算。 */
function carrierOf (role) {
  const cfg = readJson(join(ROOT, '_crew', 'agents.json')) ?? {}
  const a = cfg.roles?.[role]?.agent ?? cfg.roles?.[role]?.carrier ?? null
  return a ? String(a).toLowerCase() : null
}

/** 当前项目（`_crew\当前项目.txt`；也可以 `--project` 指定）。 */
function currentProject () {
  const p = opt('project', null)
  if (p) return resolve(p)
  const t = readText(join(ROOT, '_crew', '当前项目.txt'))
  return t ? resolve(String(t).trim()) : null
}

function loadCalls () {
  const l = readJson(join(ROOT, '_crew', 'ledger.json')) ?? {}
  return Array.isArray(l.calls) ? l.calls : []
}

/**
 * 把一轮调用**解出**：输入文件、输出文件、载体。
 *
 * ★ 输入怎么找（实测出来的四级，别再用"任务名猜"）：
 *   ① **`<task>.dispatch.json` 的 `files.prompt`** —— 这是**每轮真跑的派活记录**，最权威
 *      （实测 `T35.dispatch.json` 里 `files.{card,prompt,receipt}` ＋ 完整 `command.powershell` 都在）
 *   ② **输出文件隔壁的同名 `.prompt.txt`** —— 实测 review 那类卡的 prompt 就躺在
 *      `_crew\runs\<stamp>\review\<同名>.prompt.txt`（**路径能从 envelope 直接推出来**）
 *   ③ 收据里的 `files.prompt`
 *   ④ `<task>.md` **卡当备胎**（有则用，但标 `fromCard`，因为卡里没有"班组须知"那段前缀）
 *   ⚠️ 别只按 `${task}.prompt.txt` 猜：prompt 用任务 id、输出用 cardId，**两者实测对不上**
 *      （账本 `task=REVIEW-2026-10-07T10-09-36`，而盘上另有 `REV-W12.prompt.txt`）
 */
function resolveCall (call, project) {
  const tasksDir = project ? join(project, '_crew', 'tasks') : null
  const task = String(call.task ?? '')
  const out = { task, at: call.at ?? null, carrier: carrierOf(call.role), promptFile: null, outFile: null, fromCard: false, note: null, filesNote: null }

  const disp = tasksDir && task ? readJson(join(tasksDir, `${task}.dispatch.json`)) : null

  // ② 输出：账本记的 envelope 优先（它才是**当轮真的那份**）；找不到再按 cardId 猜
  const env = typeof call.envelope === 'string' ? call.envelope : null
  if (env && existsSync(env)) out.outFile = env
  else if (tasksDir && task) {
    const guess = join(tasksDir, `${task}.out.json`)
    if (existsSync(guess)) out.outFile = guess
  }
  if (!out.outFile) out.note = env ? '这一轮记了输出路径，但文件不在了' : '这一轮没记输出路径'

  // ① 输入（四级）
  const cands = []
  if (disp?.files?.prompt) cands.push({ p: String(disp.files.prompt), how: 'dispatch.json' })
  if (out.outFile) cands.push({ p: out.outFile.replace(/\.out\.json$/i, '.prompt.txt'), how: '输出隔壁' })
  if (tasksDir && task) cands.push({ p: join(tasksDir, `${task}.prompt.txt`), how: '任务名' })
  const rc = tasksDir && task ? readJson(join(tasksDir, `${task}.receipt.json`)) : null
  if (rc?.files?.prompt) cands.push({ p: String(rc.files.prompt), how: '收据' })
  const hit = cands.find((c) => existsSync(c.p))
  if (hit) { out.promptFile = hit.p; out.promptHow = hit.how } else {
    // ④ 卡当备胎（如实标明：卡里没有"班组须知"前缀）
    const card = disp?.files?.card ?? (tasksDir && task ? join(tasksDir, `${task}.md`) : null)
    if (card && existsSync(card)) { out.promptFile = card; out.fromCard = true; out.promptHow = '卡（备胎）' }
  }
  if (!out.promptFile) out.filesNote = '没找到派活原文'
  else if (out.fromCard) out.filesNote = '用**卡**当输入备胎（卡里没有"班组须知"那段前缀）'
  return out
}

/**
 * 在跑那一轮**是不是已经就是账本最后一条**了（收活瞬间两边都在 ⇒ 别显示两遍）。
 * 判据用**路径相等优先、任务名兜底** —— 判据要能核对，不能靠"看起来像"。
 */
export function sameAsLastLedgerCall (call, live, files) {
  if (!call || !live) return false
  if (files?.outFile && call.envelope &&
      String(call.envelope).replace(/\\/g, '/').toLowerCase() === String(files.outFile).replace(/\\/g, '/').toLowerCase()) return true
  return call.task != null && live.task != null && String(call.task) === String(live.task)
}

/** 列表模式：某个角色最近 N 轮（给面板画"会话列表"用）。 */
export function listSessions (role, { project = null, limit = 5 } = {}) {
  const pj = project ? resolve(project) : currentProject()
  const calls = loadCalls().filter((c) => String(c.role) === String(role))
  const picked = calls.slice(-Math.max(1, limit))
  return { role, carrier: carrierOf(role), project: pj, total: calls.length, calls: picked.map((c) => resolveCall(c, pj)) }
}

/** 完整会话：把某角色最近 N 轮拼成一段（正序，时间早的在前）。 */
export function buildSession (role, { project = null, limit = 5, kinds = null, mergeRetries = true } = {}) {
  const info = listSessions(role, { project, limit })
  const carrier = info.carrier
  const supported = SUPPORTED.includes(String(carrier ?? ''))
  const entries = []
  const groups = []                    // ★ b61：先按"每次账本调用"收拢，再按连续同名 task 归并
  for (const c of info.calls) {
    const head = []
    // 输入：派活原文（权威来源；即使载体自己也回吐 user 消息，也以这份为准）
    const prompt = c.promptFile ? readText(c.promptFile) : null
    if (prompt != null) head.push({ role: 'user', kind: 'text', text: prompt, ts: null, source: c.fromCard ? '卡（备胎）' : 'prompt.txt', how: c.promptHow ?? null, task: c.task })
    // 输出：载体回吐的流
    let body = []
    if (c.outFile) {
      const text = readText(c.outFile)
      if (text != null) {
        if (supported) body = toConversation(carrier, text).map((e) => ({ ...e, task: c.task, source: 'out.json' }))
        else body = [{ role: 'assistant', kind: 'status', text: '该载体（' + String(carrier) + '）暂无会话翻译器', task: c.task, source: 'out.json' }]
      }
    }
    const round = [...head, ...body]
    groups.push({
      task: c.task,
      header: { kind: 'round', task: c.task, at: c.at, carrier, files: { prompt: c.promptFile, out: c.outFile }, note: [c.note, c.filesNote].filter(Boolean).join(' · ') || null },
      body: round.length ? round : [],
      emptyNote: round.length ? null : '这一轮啥也读不到（见 note）'
    })
  }
  // ── ★★ b61（A · 用户口径："不堆积，但不是裁剪原文" ＋ "信息是串流，不能打乱顺序"）──────────
  //   **同一 task 的连续多次尝试（重试）折成一处**：一个轮头（记 attempts）＋ 一行 `重试 ×N`（内含前几次的条目）
  //   ＋ **最后一次尝试的条目原样、原序**。重试在时间上连续 ⇒ **折叠位置不动、展开后顺序＝原文顺序**。
  //   ⚠️ 只归并**连续**的同名 task（中间夹了别的 task 就不动）；**不删任何条目**（前几次仍可展开看到）。
  if (!mergeRetries) {                     // ★ b62：对照路径（未归并）—— 只给探针用来做"保序逐条比对"
    for (const g of groups) {
      entries.push(g.header)
      if (g.emptyNote) entries.push({ kind: 'status', text: g.emptyNote })
      else entries.push(...g.body)
    }
    groups.length = 0
  }
  for (let gi = 0; gi < groups.length;) {
    let gj = gi
    while (gj + 1 < groups.length && String(groups[gj + 1].task) === String(groups[gi].task)) gj++
    const g = groups[gi]
    const last = groups[gj]
    const retries = gj - gi
    entries.push({ ...last.header, attempts: retries + 1, retries })
    if (retries > 0) {
      const items = []
      for (let k = gi; k < gj; k++) { items.push(groups[k].header); if (groups[k].emptyNote) items.push({ kind: 'status', text: groups[k].emptyNote }); items.push(...groups[k].body) }
      entries.push({ kind: 'fold', of: 'retry', count: retries, task: last.task, items })
    }
    if (last.emptyNote) entries.push({ kind: 'round', task: last.task, at: last.header.at, carrier, files: last.header.files, note: last.emptyNote })
    else entries.push(...last.body)
    gi = gj + 1
  }
  // ── ★ 2026-10-11（A4-②）**在跑那一轮**：账本还没这条，但文件已经在长了 ──────────────
  // 病根：账本 `calls[]` 是**收活那一刻**才写 ⇒ 只读账本的话，**正在跑的一轮在会话里根本不存在**
  //   （施工文档 ④ 那条"面板读文件多半只在跑完才读"说的就是它）。
  // 修法：用编排的 running 登记（`<项目>\_crew\running\<cardId>.json`，口径＝pid 活＋没过 deadline，
  //   与看板灯**同一个判据**）算出这一轮的文件路径直接读；编排是**边收边 append** ⇒ 读到的就是活的。
  // ⚠️ 只在"账本里还没有这一轮"时补，否则收活瞬间会显示两遍（判据见 `sameAsLastLedgerCall`）。
  let liveInfo = null
  {
    const rec = findRunningRecord(role)
    if (rec) {
      const files = inFlightFiles(rec.project, rec.run, rec.cardId)
      const last = info.calls[info.calls.length - 1] ?? null
      if (!sameAsLastLedgerCall(last, rec, files)) {
        const head = []
        const prompt = files.promptFile ? readText(files.promptFile) : null
        if (prompt != null) {
          head.push({ role: 'user', kind: 'text', text: prompt, ts: null, source: 'prompt.txt（在跑）', how: 'running 登记算出的路径', task: rec.task })
        }
        const raw = files.outFile ? readText(files.outFile) : null
        let body = []
        if (raw != null) {
          if (supported) body = toConversation(carrier, raw).map((e) => ({ ...e, task: rec.task, source: 'out.json（在跑）' }))
          else body = [{ role: 'assistant', kind: 'status', text: '该载体（' + String(carrier) + '）暂无会话翻译器', task: rec.task, source: 'out.json（在跑）' }]
        }
        const note = [
          raw == null ? '这轮的输出文件还没落地（载体的第一块还没吐出来）' : null,
          files.found ? null : '（按 running 登记算出的路径暂不存在）'
        ].filter(Boolean).join(' · ') || null
        entries.push({
          kind: 'round', task: rec.task, at: rec.startedAt, carrier, live: true,
          files: { prompt: files.promptFile, out: files.outFile }, note
        })
        if (head.length || body.length) entries.push(...head, ...body)
        else entries.push({
          role: 'assistant', kind: 'status', task: rec.task, source: 'out.json（在跑）',
          text: '还在跑，暂时没有可显示的条目（这家载体可能要到跑完才吐整段，见施工文档 §6.5③）'
        })
        liveInfo = {
          task: rec.task, cardId: rec.cardId, childPid: rec.childPid, startedAt: rec.startedAt ?? null,
          run: rec.run ?? null, project: rec.project ?? null,
          outFile: files.outFile, promptFile: files.promptFile,
          outBytes: raw != null ? Buffer.byteLength(raw, 'utf8') : 0
        }
      }
    }
  }
  const filtered = kinds ? entries.filter((e) => e.kind === 'round' || kinds.includes(e.kind)) : entries
  return { ok: true, role, carrier, supported, project: info.project, total: info.total, rounds: info.calls.length, entries: filtered, live: liveInfo }
}

/* ── CLI（人看的形态）────────────────────────────────────────────── */
const ROLE_ZH = { 'coder-a': 'coder-a', 'coder-b': 'coder-b', reviewer: 'reviewer', researcher: 'researcher', rescue: 'rescue', brain: '大脑' }

function main () {
  const role = opt('role', null)
  if (!role) {
    console.log('用法：node 会话流.mjs --role <角色> [--project <目录>] [--limit 5] [--json]')
    console.log('角色：' + Object.keys(ROLE_ZH).join(' / '))
    console.log('支持的载体：' + SUPPORTED.join(', '))
    process.exit(2)
  }
  const limit = Number(opt('limit', 5)) || 5
  const s = buildSession(role, { limit })
  if (has('json')) { process.stdout.write(JSON.stringify(s, null, 2) + '\n'); return }
  console.log(`══ 会话 · ${role}${ROLE_ZH[role] && ROLE_ZH[role] !== role ? '（' + ROLE_ZH[role] + '）' : ''} · 载体 ${s.carrier ?? '?'} · 项目 ${s.project ?? '（还没选工作区）'}`)
  console.log(`   账本里这个角色共 ${s.total} 轮，本次取最近 ${s.rounds} 轮 · 翻译器 ${s.supported ? '有' : '**没有**'} · 条目 ${s.entries.length}`)
  if (!s.project) console.log('   ⚠️ 没选工作区/没给 --project ⇒ 找不到派活原文（输入会缺）')
  const KZ = { text: '正文', thinking: '思考', tool_use: '工具', tool_result: '结果', status: '机制', error: '错误' }
  for (const e of s.entries) {
    if (e.kind === 'round') {
      console.log('\n' + '─'.repeat(78))
      console.log('【第 ' + (s.entries.filter((x) => x.kind === 'round').indexOf(e) + 1) + ' 轮】' + e.task + '   ' + (e.at ?? '') + (e.note ? '   ⚠️ ' + e.note : ''))
      continue
    }
    const who = e.role === 'user' ? '👤 用户' : '🤖 助手'
    const tag = KZ[e.kind] ?? e.kind
    const head = e.kind === 'tool_use' ? `${who} · ${tag} · ${e.tool ?? ''} ${String(e.input ?? '').slice(0, 120)}` : `${who} · ${tag}`
    console.log('\n' + head)
    const body = String(e.text ?? '').split('\n').map((l) => '   ' + l).join('\n')
    if (body.trim()) console.log(body)
  }
  console.log('\n' + '─'.repeat(78))
  console.log(`条数统计：` + JSON.stringify(s.entries.filter((e) => e.kind !== 'round').reduce((a, e) => { a[e.kind] = (a[e.kind] || 0) + 1; return a }, {})))
}

if (import.meta.url === 'file://' + process.argv[1].replace(/\\/g, '/') || process.argv[1]?.endsWith('会话流.mjs')) main()
