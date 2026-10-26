#!/usr/bin/env node
/**
 * 体检 —— 一个命令查完「任务 / 角色 / 账目 / 消耗 / 额度 / 看护 / 上下文占用 / 断点」，只回十几行。
 *
 * 为什么要有它（★ 2026-10-05 用户拍板第 1 条）：
 *   大脑过去看状态是**一条条拼 `pwsh`**：实测一个项目 453 次请求里，`pwsh` 268 次 + `job_output` 80 次
 *   = **69% 的调用都是"看一眼 / 等一下"**。每一次都要把**整段上下文重发一遍**（平均 31 万 token）
 *   → 又慢又容易出错。
 *   这个脚本把"看一眼"**合成一次**：本地跑、**零 token**、毫秒级，一次把结论说完。
 *
 * ⚠️ 它**只读**：不改任何文件、不建会话、不调模型、不花 token（唯一副作用 = 顺手刷新 `board-data.json`）。
 *
 * 用法：
 *   node 体检.mjs                      # 体检"当前项目"（--project / 指针文件 / 跟随，与看板同一口径）
 *   node 体检.mjs --project <项目目录>  # 指定项目
 *   node 体检.mjs --json               # 机器可读（给大脑自己判断用）
 *   node 体检.mjs --no-refresh         # 不刷新，直接读现有的 board-data.json（更快）
 */

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const BOARD = resolve(process.env.DSH_BOARD_DATA ?? join(ROOT, '_crew', 'board-data.json'))
const argv = process.argv.slice(2)
const opt = (n) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? null : null }
const has = (n) => argv.includes('--' + n)
const AS_JSON = has('json')
const NO_REFRESH = has('no-refresh')
const PROJ = opt('project')

const t0 = Date.now()
const log = (...a) => { if (!AS_JSON) console.log(...a) }

// ---------------------------------------------------------------- ① 刷新数据（默认做，除非 --no-refresh）
let refreshNote = '（未刷新，读现有数据）'
if (!NO_REFRESH) {
  const r = spawnSync(process.execPath, [join(HERE, '看板数据.mjs'), ...(PROJ ? ['--project', PROJ] : []), '--quiet'], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000, windowsHide: true
  })
  refreshNote = r.status === 0 ? '（已刷新）' : `（刷新失败 exit=${r.status}：${String(r.stderr ?? '').trim().split('\n').pop()?.slice(0, 60) ?? '?'}）`
}

let d = null
try { d = JSON.parse(readFileSync(BOARD, 'utf8')) } catch (e) {
  console.error(`❌ 读不到看板数据：${BOARD}\n   ${e?.message ?? e}`)
  process.exit(2)
}

// ---------------------------------------------------------------- ② 当前项目 & 角色状态
const cur = d.currentProject ?? {}
const projPath = cur.set ? cur.path : null
const projName = cur.set ? (cur.name ?? projPath) : '（未定）'
const crewRow = (d.crewByProject ?? []).find(x => projPath && resolve(x.path ?? '') === resolve(projPath)) ?? null
const roles = crewRow?.roles ?? []
const zh = { running: '在跑', idle: '停着', error: '出错', unassigned: '未派活' }
const roleBits = roles.map(r => {
  const st = zh[r.state] ?? (r.state ?? '—')
  // ★ 2026-10-07：带上**正在干的那条任务**（来自 pid 存活的登记，见 看板数据.mjs 的 liveRunningIn）——
  //   原来读 `r.currentTask`（数据端从来不下发这个字段）⇒ 这一格永远是空的。
  const t = (r.live?.task ?? r.currentTask) ? `(${r.live?.task ?? r.currentTask})` : ''
  return `${r.role} ${st}${t}`
})
const brain = d.brainRow ?? {}

// ---------------------------------------------------------------- ③ 任务台账
//   ⚠️ 真实格式是**列表**不是表格（踩过：按表格 `| T1 |` 解析 → 永远 0 条）：
//      `- [x] T1 · W1 · coder-a · 刀1-… · 依赖:无 · 交付:… · 验收:…`
let tasks = null
if (projPath) {
  const cands = [join(projPath, 'TASKS.md'), join(projPath, '_crew', 'TASKS.md')]
  const tf = cands.find(p => existsSync(p))
  if (tf) {
    // ★ 八·S6：不再拿正则数 TASKS.md 的复选框（历史两刀：[?]/[!] 漏计 ⇒ 总数少报）——
    //   改读**机器区段**（`台账.mjs` 唯一写口，状态的真值）。读不到/坏了 ⇒ **出声**（下面任务行会点名，
    //   原来 `catch {}` 静默成"—"，总数少报还看不出来）；认不出的行由台账保留在"未识别"区并进
    //   机器数据（`unmatched`）—— 这里照实报出来（不丢）。
    const r = spawnSync(process.execPath, [join(HERE, '台账.mjs'), 'machine', '--project', projPath, '--json'],
      { encoding: 'utf8', maxBuffer: 16 << 20, timeout: 30000, windowsHide: true })
    let m = null; let mErr = null
    if (r.status === 0) { try { m = JSON.parse(String(r.stdout ?? '').replace(/^\uFEFF/, '')) } catch (e) { mErr = `输出解析失败：${String(e?.message ?? e)}` } }
    else mErr = String(r.stderr ?? '').trim().split('\n')[0] || `台账 machine exit=${r.status}`
    if (m && m.kind === 'tasks') {
      const all = Object.values(m.tasks ?? {})
      const cnt = (st) => all.filter(t => t.state === st).length
      const done = cnt('done'); const doing = cnt('doing'); const review = cnt('review'); const blocked = cnt('blocked')
      tasks = {
        file: tf, total: all.length, done, doing, todo: all.length - done - doing - review - blocked,
        review, blocked,
        blockedIds: Object.entries(m.tasks ?? {}).filter(([, t]) => t.state === 'blocked').map(([id]) => id),
        waves: [...new Set(all.map(t => t.wave).filter(w => w && w !== '—'))],
        mtime: statSync(tf).mtime,
        unmatched: (m.unmatched ?? []).length, machineAt: m.at ?? null
      }
    } else {
      tasks = { file: tf, error: mErr ?? '机器区段读不到', mtime: statSync(tf).mtime }
    }
  }
}

// ---------------------------------------------------------------- ③b 「现在能开工」的有几个（★ 2026-10-07 新增，见 进度.md §24.7）
//   **这是"断点写错"的根因，必须单独算**：
//     `待办 > 0` **不等于**"能开工 > 0"。实测 `<示例项目>`：台账 6 条待办（T36–T41），
//     但 `T35` 是 `blocked`，而 `T36→T37→T38/T39→T40→T41` 是**一条线性依赖链**
//     ⇒ **一条都开不了工**。而收尾时没人跑演练，于是断点里写下了
//       "今晚可开跑：`编排.mjs --execute`" —— 那条命令跑下去是**空转**（原话 `可开工任务：（没有）`），
//       白写一轮收据、还挡住了真正该做的"先解 T35"。
//   口径（已写进 §24.7）：**收尾/写断点前必须跑一次演练对账**。这里把它固化成一行，
//     让"待办 N 条 / 可开工 0 条"这种自相矛盾**不可能看不见**。
//   ⚠️ 依赖判定的**唯一实现**在 `台账.mjs ready`，这里只调它、**绝不重写一遍**
//     （重写就会像 `[?]`/`[!]` 那两次一样悄悄漂移）。
let readyList = null
if (projPath) {
  try {
    const r = spawnSync(process.execPath, [join(HERE, '台账.mjs'), 'ready', '--project', projPath, '--json'],
      { encoding: 'utf8', maxBuffer: 8 << 20, timeout: 30000, windowsHide: true })
    if (r.status === 0) {
      const arr = JSON.parse(String(r.stdout ?? '[]').replace(/^\uFEFF/, ''))   // ⚠️ 剥 BOM（老坑）
      if (Array.isArray(arr)) readyList = arr
    }
  } catch { /* 算不出来就写 —（不报假数）*/ }
}
/** "待办有、可开工零" —— 这就是那个必须喊出来的自相矛盾。 */
const gated = !!(tasks && !tasks.error && readyList && tasks.todo > 0 && readyList.length === 0)

// ---------------------------------------------------------------- ④ 进度断点（进度.md 的「## 当前断点」小节）
//   ⚠️ 该小节真实格式是**「项 / 值」表格**（踩过：直接取第一行 → 报出表头「项 | 值」）。
//      按行名优先挑「下一步（最要紧）」→「做到哪一步」→ 第一行数据行，这才是有用的那句。
let breakpoint = null
try {
  const lines = readFileSync(join(ROOT, '进度.md'), 'utf8').split(/\r?\n/)
  const start = lines.findIndex(l => /^#{2,3}\s*当前断点/.test(l))
  if (start >= 0) {
    const rest = lines.slice(start + 1)
    const end = rest.findIndex(l => /^#{2,3} /.test(l))
    const body = end >= 0 ? rest.slice(0, end) : rest
    const rows = body.map(l => l.match(/^\|\s*\*{0,2}([^|*]+?)\*{0,2}\s*\|\s*(.+?)\s*\|?\s*$/))
      .filter(Boolean).map(m => ({ k: m[1].trim(), v: m[2].trim() }))
      .filter(r => !/^-+$/.test(r.k) && !/^-+$/.test(r.v))
    const pick = rows.find(r => /下一步/.test(r.k)) ?? rows.find(r => /做到哪/.test(r.k)) ?? rows[0]
    const prose = body.map(l => l.trim()).filter(l => l && !l.startsWith('|'))
    if (pick) breakpoint = `${pick.k}：${pick.v.replace(/[`*]/g, '').replace(/\s+/g, ' ').slice(0, 150)}`
    else if (prose.length) breakpoint = prose[0].slice(0, 150)
    else breakpoint = '（小节是空的 → 该写了）'
  } else {
    breakpoint = '（进度.md 里没有「## 当前断点」小节 → 该建了）'
  }
} catch { breakpoint = '（读不到 进度.md）' }

// ---------------------------------------------------------------- ⑤ 额度 / 消耗
//   额度行只列**有数的**家：原来 7 家全列（6 家是 `—`），一行太长、噪音多。
const quotaAll = (d.providers ?? []).map(p => ({ name: p.name, text: p.quotaText ?? '—' }))
const quotaBits = quotaAll.filter(q => q.text && q.text !== '—').map(q => `${q.name} ${q.text}`)
const quotaEmpty = quotaAll.filter(q => !q.text || q.text === '—').length
const ctx = d.context ?? {}
const watch = d.watch ?? {}
const STATE_ZH = { running: '在跑', idle: '停着', stopped: '没在跑', stalled: '卡住', dead: '跑死了' }

// ---------------------------------------------------------------- ⑤b 门禁（测试）那一行
//   ★ 2026-10-05 新增：**用户只认这一行**（他看不懂测试输出）。
//   数据来自 `<项目>\_crew\gate-status.json`（编排每跑一次门禁就写一次，见 编排.mjs 的 runGate）。
//   没有它 = 这一波还没跑过门禁（不是失败）。**红了就把"红在哪"的第一条一起带出来**。
let gate = null
if (projPath) {
  try {
    const gf = join(projPath, '_crew', 'gate-status.json')
    if (existsSync(gf)) {
      // ⚠️ 剥 BOM：PowerShell 写的 JSON 带 BOM，`JSON.parse` 会抛（本工作台老坑，这里照剥）
      const g = JSON.parse(readFileSync(gf, 'utf8').replace(/^\uFEFF/, ''))
      gate = { ...g, mtime: statSync(gf).mtime }
    }
  } catch { /* 读不到就当没跑过 */ }
}
const gateText = gate
  ? `${gate.ok ? '✅' : '❌'} ${gate.summaryText ?? ''}${gate.ok ? '' : (gate.failures?.[0] ? ` · 红在：${String(gate.failures[0]).slice(0, 70)}` : '')}　（${String(gate.at ?? '').replace('T', ' ').slice(0, 16)} 跑的）`
  : '—（这一波还没跑过门禁；真跑一次编排就会跑）'

// ---------------------------------------------------------------- ⑤c 「待你处理」（★ 2026-10-06 用户第 1/2 条）
//   环境类（没 key / 账号 / 额度 / 网络）与"审核+急救也没解决"的条目 ⇒ 只有人能办。
//   **它们不拖住别的任务**，所以这里只报"有几件、哪几件"，大脑据此决定"继续跑别的"还是"停下叫人"。
let haltList = []
if (projPath) {
  try {
    const hf = join(projPath, '_crew', 'halt.json')
    if (existsSync(hf)) {
      const a = JSON.parse(readFileSync(hf, 'utf8').replace(/^\uFEFF/, ''))   // ⚠️ 剥 BOM（老坑）
      if (Array.isArray(a)) haltList = a
    }
  } catch { /* 读不到 = 没有 */ }
}
const haltText = haltList.length
  ? `${haltList.length} 件待你处理：` + haltList.slice(-4).map(x => `${x.id}[${x.kind}]`).join(' · ')
  : '—（没有要你出手的事）'

// ---------------------------------------------------------------- ⑤d 「收据外改动」（★ b88 · 新问题稿 A 条）
//   治的病：2026-10-12 大脑绕过班组、用 subagent 改了 6 个文件，而 `_crew\runs\` **当天 0 条**
//   ⇒ 无任务卡、无回执、无指纹、无门禁 —— **违反规则这件事不产生任何可观测信号**，
//   看板/账本/门禁**全是绿的**。这一行就是那个信号（判据全在 `无收据改动.mjs`，这里只消费结论）。
let noReceipt = null
if (projPath) {
  try {
    const r = spawnSync(process.execPath, [join(HERE, '无收据改动.mjs'), '--project', projPath, '--json'],
      { encoding: 'utf8', maxBuffer: 32 << 20, timeout: 120000, windowsHide: true })
    if (r.status === 0 || r.status === 2 || r.status === 3) {
      const j = JSON.parse(String(r.stdout ?? '').replace(/^\uFEFF/, ''))
      noReceipt = {
        state: j.state,
        count: j.counts?.unclaimedOpen ?? null,
        exempt: j.counts?.exempt ?? 0,
        files: (j.files ?? []).map(f => f.path),
        windowFrom: j.window?.fromLocal ?? null
      }
    } else {
      const err = String(r.stderr ?? '').trim().split('\n').filter(Boolean).pop() ?? `exit=${r.status}`
      // 「一轮收据都还没有」不是错误，是**最强的那条信号**（有活干过却没有轮次）—— 照实说清
      noReceipt = { state: 'none', why: /还没有任何一轮收据/.test(err) ? '本项目还没有一轮收据（有活干过却无轮次 ⇒ 这本身就是信号）' : err.slice(0, 160) }
    }
  } catch (e) { noReceipt = { state: 'unknown', why: String(e?.message ?? e).slice(0, 160) } }
}
const noReceiptText = !noReceipt
  ? '—（本项目没定项目，没算）'
  : noReceipt.state === 'green' ? `✅ 0 个（窗口 ${String(noReceipt.windowFrom ?? '?').slice(5, 16)} 起）`
    : noReceipt.state === 'yellow' ? `⚠️ ${noReceipt.count} 个，**全部已豁免**`
      : noReceipt.state === 'red' ? `⛔ ${noReceipt.count} 个**没有收据的改动**：${(noReceipt.files ?? []).slice(0, 3).join('、')}${(noReceipt.files ?? []).length > 3 ? ' …' : ''}（窗口 ${String(noReceipt.windowFrom ?? '?').slice(5, 16)} 起）`
        : `—（算不出来：${noReceipt.why}）`

// ---------------------------------------------------------------- ⑤e 长命资源 ＋ 最近一次换会话（★ b91 · C）
//   两份都**直读真值文件**（看板数据已带过来）：`长命资源状态.json`（写方＝长命资源巡检.mjs）与
//   `换会话交接.json`（写方＝登记服务 handover）。零成本（不跑 PowerShell），且**自带新鲜度**——
//   这一条是刻意加的：本项目反复栽在"拿旧结论当现状"上。
const ll = d.longlive ?? null
const sw = d.swap ?? null
/** 交接单里的 `at` 是 **UTC**（ISO）——给人看必须转本地（否则"下午 3 点"会显示成"早上 7 点"）。 */
const atLocal = (iso) => {
  const t = new Date(iso)
  if (!Number.isFinite(t.getTime())) return String(iso ?? '?')
  const p = (n) => String(n).padStart(2, '0')
  return `${t.getFullYear()}-${p(t.getMonth() + 1)}-${p(t.getDate())} ${p(t.getHours())}:${p(t.getMinutes())}`
}
const llText = ll
  ? `${ll.state === 'green' ? '✅' : (ll.state === 'red' ? '⛔' : '⚠️')} ${ll.verdict}（${ll.ageMin != null ? ll.ageMin + ' 分钟前核的' : '?'}，${ll.checkedBy ?? '?'} 叫的）`
  : '—（还没核过：`_crew\\长命资源状态.json` 不存在；叫一次：`node _unattended\\长命资源巡检.mjs`）'
const swText = !sw ? '—（还没有换会话记录）'
  : sw.hasWrap === false ? `❓ ${atLocal(sw.at)} 那次记录在 b90 之前（当时还没做收尾核验）`
    : sw.wrapOk === true ? `✅ 收尾了（${atLocal(sw.at)} 换的${sw.ageMin != null ? '，' + sw.ageMin + ' 分钟前' : ''}）`
      : `${sw.wrapLevel === 'warn' ? '⚠️ 旧会话没照收尾做' : '⛔ 旧会话**没收尾**'}（${atLocal(sw.at)} 换的）—— ${String(sw.wrapWhy ?? '').slice(0, 70)}`

// ---------------------------------------------------------------- ⑥ 输出
const report = {
  at: new Date().toISOString(),
  tookMs: Date.now() - t0,
  project: { name: projName, path: projPath, source: cur.source ?? null },
  tasks,
  // ★ 2026-10-07：「能开工几条」是**独立于"待办几条"的一等事实**（§24.7 的教训）——
  //   机器读的调用方（大脑 / 看板）必须能直接拿到它，而不是照旧把 `todo` 当"能开工"用。
  ready: readyList
    ? { count: readyList.length, ids: readyList.map(t => t.id), gated }
    : { count: null, note: '算不出来（台账或依赖图读不了）', gated: null },
  roles,
  brain: { state: brain.state ?? null, tokens: brain.tokens ?? null, cost: brain.cost ?? null, model: brain.model ?? null },
  context: ctx.found ? { percent: ctx.percent, level: ctx.level, text: ctx.text } : { note: ctx.note ?? '—' },
  watch: { state: watch.stateZh ?? null, noProgressMin: watch.progress?.noProgressMin ?? null, note: watch.detail ?? null },
  gate: gate ? { ok: gate.ok, summaryText: gate.summaryText ?? null, failures: gate.failures ?? [], at: gate.at ?? null, line: gate.line ?? null } : null,
  // ★ b88：「收据外改动」＝**绿之外还有人动过源码吗**（大脑终审 / 用户扫一眼都要它）
  noReceipt,
  // ★ b91：长命资源状态 ＋ 最近一次换会话的收尾结论（都直读真值文件，**自带新鲜度**）
  longlive: ll ? { state: ll.state, verdict: ll.verdict, ageMin: ll.ageMin ?? null, checkedBy: ll.checkedBy ?? null, counts: ll.counts ?? null } : null,
  swap: sw ? { at: sw.at, oldSession: sw.oldSession, newSession: sw.newSession, hasWrap: sw.hasWrap, wrapOk: sw.wrapOk, wrapLevel: sw.wrapLevel, wrapWhy: sw.wrapWhy, took: sw.took, stopped: sw.stopped, ageMin: sw.ageMin } : null,
  halt: haltList.map(x => ({ id: x.id, kind: x.kind, why: x.why, hint: x.hint, seen: x.seen ?? 1 })),
  quota: quotaBits,
  ledger: d.ledger ?? null,
  breakpoint,
  note: '体检 = 只读、零 token，不改任何文件'
}

if (AS_JSON) { console.log(JSON.stringify(report, null, 2)); process.exit(0) }

const Y = (n) => n == null ? '—' : n
log(`🩺 体检 ${refreshNote} · 耗时 ${(report.tookMs / 1000).toFixed(1)}s · 只读零 token`)
log(`项目   ${projName}${projPath && projName !== projPath ? '　' + projPath : ''}`)
log(`口径   ${cur.source ?? '—'}${cur.set ? '' : '（没定项目 → 只报大脑那一层）'}`)
if (tasks?.error) log(`任务   ⚠️ **机器区段读不到**：${String(tasks.error).slice(0, 110)} → 先跑 \`node _unattended\\台账.mjs machine --fix --project "${projPath}"\` 重建`)
else if (tasks) log(`任务   ✅${tasks.done} 完成 · ⬜${tasks.todo} 待办${tasks.doing ? ` · 🔄${tasks.doing} 在做` : ''} · 共 ${tasks.total} 条${tasks.waves?.length ? ` · 波次 ${tasks.waves.join('/')}` : ''}${tasks.unmatched ? ` · ⚠️ 未识别 ${tasks.unmatched} 行（已保留在 TASKS.md"未识别"区）` : ''}`)
else log('任务   —（没找到 <项目>\\TASKS.md 或 <项目>\\_crew\\TASKS.md）')
// ★「待办 N 条 ≠ 能开工 N 条」——这一行专门把那个自相矛盾摆出来（见 ③b / §24.7）
if (tasks && !tasks.error && readyList) {
  log(gated
    ? `开工   ⛔ **一条都开不了工**（${tasks.todo} 条待办全被卡：${tasks.blockedIds?.length ? 'blocked ' + tasks.blockedIds.join('、') : '依赖未满足'}）→ 现在跑 --execute 是**空转**`
    : `开工   ✅ 可开工 ${readyList.length} 条${readyList.length ? '：' + readyList.map(t => t.id).slice(0, 8).join('/') + (readyList.length > 8 ? ' …' : '') : ''}`)
}
log(`角色   ${roleBits.length ? roleBits.join(' · ') : '—（本项目没有派活记录）'}`)
log(`大脑   ${STATE_ZH[brain.state] ?? Y(brain.state)} · ${Y(brain.tokens ? (brain.tokens / 1e8).toFixed(2) + ' 亿 tok' : null)} · ${Y(brain.cost != null ? '$' + Number(brain.cost).toFixed(2) : null)} · ${Y(brain.model)}`)
log(`占用   上下文 ${ctx.found ? ctx.text + (ctx.level === 'danger' ? ' 🔴 快撑爆' : ctx.level === 'warn' ? ' ⚠ 注意' : '') : '—（' + (ctx.note ?? '') + '）'}`)
log(`测试   ${gateText}`)
log(`收据   ${noReceiptText}`)
log(`资源   ${llText}`)
log(`交接   ${swText}`)
log(`调研   ${d.research ? d.research.line : '—（没有调研库；不建库不影响任何流程）'}`)
log(`待办   ${haltText}`)
log(`看护   ${Y(watch.stateZh)}${watch.progress?.noProgressMin != null ? '（' + watch.progress.noProgressMin + ' 分钟无新文件）' : ''}${watch.detail ? ' · ' + watch.detail : ''}`)
log(`额度   ${quotaBits.length ? quotaBits.join(' · ') : '—'}${quotaEmpty ? `（另 ${quotaEmpty} 家无数据）` : ''}`)
if (d.ledger) log(`账目   今日调用 ${Y(d.ledger.todayCalls)} 次 · 今日新增坑 ${Y(d.ledger.todayPitfalls ?? d.ledger.today)} 条`)
if (breakpoint) log(`断点   ${breakpoint}`)
log(`👉 下一步：${(() => {
  if (!cur.set) return '先钉项目（--project <目录> 或写 _crew\\当前项目.txt）'
  if (tasks?.error) return '先修 TASKS.md 的机器区段：`node _unattended\\台账.mjs machine --fix --project "<项目>"`（见上面"任务"行）'
  // ★ 2026-10-07 修（**本条即 §24.7 的根因**）：原来是 `tasks.todo > 0` 就建议 `--execute`，
  //   而"有 6 条待办"和"能开 6 条工"是两件事 —— 实测六条**全被一条 blocked 卡死**。
  //   现在先问 `台账.mjs ready`（唯一权威），**可开工 0 条时绝不再推荐 --execute**。
  if (gated) return `⛔ ${tasks.todo} 条待办**一条都开不了工**${tasks.blockedIds?.length ? `（blocked：${tasks.blockedIds.join('、')}）` : '（依赖未满足）'} → 先解依赖；**别跑 --execute（那是空转）**`
  if (tasks && tasks.todo > 0) return `可开工 ${readyList ? readyList.length : '?'} 条 → 编排.mjs --project <目录> --execute`
  if (tasks && tasks.todo === 0) return '台账已清空 → 回去拆下一波的任务（或收尾）'
  return '看 进度.md 的断点那一行'
})()}`)
