// 进度看护（零 LLM · 纯只读 · 幂等）—— 2026-10-05 用户拍板
//
// 干什么：每隔几分钟看一眼"**下面的人到底写完没、还是卡住了**"，**不经过大模型、不花 token**。
//   ① `_crew\crew.lock` 里有编排在跑吗？那个 pid 还活着吗？
//   ② 该项目的**最新一轮** `_crew\runs\<stamp>\` 里，**多久没有新文件**了？
//   ③ 班组账本里属于该项目的调用有没有新增？
//   → 结论写 `_crew\看护状态.json`；只在**异常**（卡住 / 跑死了）时往 `_crew\看护告警.json` 追加一条。
//
// 为什么要有它：大脑自己去"查一下"要 **≈$0.1/次**（每次都要重发整个上下文），
//   实测为"等"烧了 83 次 ≈ $5–7。看进度这件事**不该由大模型干**。
//
// 为什么状态要落文件：看板（`看板数据.mjs`）要读它出一行 —— 你不用问大脑，扫一眼就知道。
//
// 用法：
//   node 进度看护.mjs [--project <项目>] [--stall-min 100] [--quiet]
//   · 不给 --project 时：先看"锁里此刻在跑的那个项目"（最权威），再退到 `_crew\当前项目.txt`（钉住）
//   · `--stall-min`：多少分钟没新文件算"卡住"（**默认 100 —— 必须大于"编排的保护性超时"**；
//     2026-10-07 编排上限由 45 → 90 分钟（用户拍板），故此处同步 50 → 100，否则长任务会被误报"卡住"）
//     ⚠️ 2026-10-05 自查修正（**用户问"1 小时兜底 vs 15 分钟超时"时问出来的**）：
//       原来默认 **8 分钟是错的**：一轮任务**在跑的时候 run 目录本来就是安静的** ——
//       派活时写完 `dispatch/prompt/md`，之后要到**收活**才写 `out.json`，中间几十页都没落盘。
//       所以"8 分钟没新文件"在**正常长任务**里**必然发生** → 全是假告警（看护就成"狼来了"）。
//     正确口径：**超过"保护性超时(45) + 缓冲"还没新文件**，才说明**连超时都没生效** = 真出事；
//       正常长任务（≤45 分钟）一律 `running`，不吵人。
// 退出码：0 = 正常/在跑；**3 = 有异常（卡住或跑死了）** —— 便于被计划任务/看板当信号用。
//
// ⚠️ 边界：本脚本**只读**项目与账本，只写自己那两个文件（`看护状态.json` / `看护告警.json`）。
//    不调任何模型、不改 TASKS/指纹/账本。
//    **自动叫醒大脑：用户 2026-10-05 拍板"开 B"** —— 见文末 `wakeBrain()` 的三条安全线（只在异常时 / 同异常只叫一次 / 认不出人就只写文件不发）。
//    关掉：`--no-notify` 或 `DSH_BOARD_WATCH_NOTIFY=0`。
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// ★ b91：锁文件路径的唯一权威（顺带带来测试缝 `DSH_LOCK_FILE`；见下面 LOCK_FILE 那段注释）
import { LOCK_FILE as LOCK_FILE_FROM_LOCK_MODULE } from './_lock.mjs'
// ★ 2026-10-26（§七）：run 卡住阈值跟级别走（唯一出处＝_派活内核 的 LEVEL_STALL_MIN）
import { stallMinOf } from './_派活内核.mjs'
// ★ 2026-10-26（§七）：唤醒**只有这一个发送方**（与 `_监控.mjs` 同一份实现）
import { wakeBrain as wake } from './_唤醒.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WS = resolve(HERE, '..')                       // 工作台根 = 无人值守
const CREW = join(WS, '_crew')
const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const QUIET = argv.includes('--quiet')
// ★ 2026-10-26（§七）：不再固定 100 —— 阈值跟级别走（L1 30 / L2 55 / L3 100 / L4 160）。
//   `--stall-min` 仍然最高优先（人显式说了算）；不知道级别就用兜底并在输出里写明"没级别"。
const STALL_OVERRIDE = opt('stall-min', null)
const STATE_FILE = join(CREW, '看护状态.json')
const ALERT_FILE = join(CREW, '看护告警.json')
// ★ b91：锁文件路径**从唯一权威处拿**（`_lock.mjs` 的 `LOCK_FILE`）——
//   原来这里自己 `join(CREW,'crew.lock')` 写了一遍，正是"同一个事实两处各写一份"的老毛病；
//   而且 `_lock.mjs` 现在带一个**测试缝**（`DSH_LOCK_FILE`），探针能在**临时锁**上验"卡住/跑死"判据，
//   不必去动真的锁（那会把正在跑的看护循环引去"叫醒大脑"＝真花钱）。不设环境变量时路径一字不差。
const LOCK_FILE = LOCK_FILE_FROM_LOCK_MODULE
const POINTER = join(CREW, '当前项目.txt')

const log = (s) => { if (!QUIET) console.log(s) }
const now = () => new Date()
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')) } catch { return null } }
const mins = (ms) => Math.round((ms / 60000) * 10) / 10

// ── 找项目：**锁里"此刻在跑"的最权威** > --project > 指针文件
//   ⚠️ 2026-10-05 自测抓到的第一个 bug：原来把"指针文件"排在锁前面 →
//   实验在 `_演练9` 里跑，看护却去盯"钉住的 `异次元`"，报了个 49.5 分钟没进展的**假告警**。
//   正确口径：**有锁时，"在跑的项目"就是锁里那个**；没锁时，才是"你要盯的项目"。
function findProject () {
  const lk = readJson(LOCK_FILE)
  const m = String(lk?.who ?? '').match(/--project\s+("[^"]+"|\S+)/)
  if (m) {
    const v = m[1].replace(/^"|"$/g, '')
    if (existsSync(v)) return { project: resolve(v), from: '锁文件（此刻在跑的那个）' }
  }
  const p = opt('project')
  if (p && existsSync(p)) return { project: resolve(p), from: '命令行 --project' }
  if (existsSync(POINTER)) {
    const v = readFileSync(POINTER, 'utf8').trim().split(/\r?\n/)[0].trim()
    if (v && existsSync(v)) return { project: resolve(v), from: '指针文件 当前项目.txt' }
  }
  return { project: null, from: '（没有）' }
}

// ── ① 锁 + pid 是否活着
function lockInfo () {
  if (!existsSync(LOCK_FILE)) return { present: false }
  const lk = readJson(LOCK_FILE) ?? {}
  const pid = Number(lk.pid)
  let alive = false
  try { process.kill(pid, 0); alive = true } catch { alive = false }
  return { present: true, who: lk.who ?? null, pid, startedAt: lk.startedAt ?? null, alive }
}

// ── ② 最新一轮 + 最近有没有新文件（递归看 mtime）
function runFreshness (project) {
  const runs = join(project, '_crew', 'runs')
  if (!existsSync(runs)) return { stamp: null, newestMs: null, noProgressMin: null, files: 0 }
  const stamps = readdirSync(runs, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort()
  const stamp = stamps.length ? stamps[stamps.length - 1] : null
  if (!stamp) return { stamp: null, newestMs: null, noProgressMin: null, files: 0 }
  let newest = 0; let files = 0
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else { files++; const m = statSync(p).mtimeMs; if (m > newest) newest = m }
    }
  }
  try { walk(join(runs, stamp)) } catch {}
  return { stamp, newestMs: newest || null, noProgressMin: newest ? mins(Date.now() - newest) : null, files }
}

// ── ③ 账本里属于该项目的调用数（靠 envelope 路径反推，与看板同口径）
function ledgerFor (project) {
  const L = readJson(join(CREW, 'ledger.json'))
  if (!L?.calls) return { calls: 0, lastAt: null }
  const norm = (s) => String(s ?? '').replace(/\\/g, '/').toLowerCase()
  const pj = norm(project)
  const hit = L.calls.filter(c => norm(c.envelope).startsWith(pj + '/'))
  return { calls: hit.length, lastAt: hit.length ? hit[hit.length - 1].at : null }
}

// ── 判定
const { project, from } = findProject()
const lock = lockInfo()
const fresh = project ? runFreshness(project) : { stamp: null, newestMs: null, noProgressMin: null, files: 0 }
const led = project ? ledgerFor(project) : { calls: 0, lastAt: null }

let state, stateZh, detail
// ★ 2026-10-26（§七）：阈值按这轮的级别算（级别来自锁文件；没有就兜底并写明）
const STALL = stallMinOf(lock?.level ?? null, STALL_OVERRIDE)
if (!lock.present) {
  state = 'idle'; stateZh = '没在跑'; detail = '没有锁文件 → 当前没有编排在跑'
} else if (!lock.alive) {
  state = 'dead'; stateZh = '跑死了'; detail = `锁还在但 pid ${lock.pid} 已不在（残留锁或进程被杀）`
} else if (fresh.noProgressMin === null) {
  state = 'running'; stateZh = '在跑（刚起步）'; detail = `pid ${lock.pid} 活着，但最新一轮还没有产物`
} else if (fresh.noProgressMin > STALL.min) {
  state = 'stalled'; stateZh = `已 ${fresh.noProgressMin} 分钟没进展`; detail = `pid ${lock.pid} 活着，但最新一轮 ${fresh.stamp} 超过 ${STALL_MIN} 分钟没有新文件`
} else {
  state = 'running'; stateZh = '在跑'; detail = `pid ${lock.pid} 活着，最新一轮 ${fresh.noProgressMin} 分钟前还有新文件`
}

// ── ④ 长命资源：**只读那张纸**（★ b91 轻分离）
//   原来这里内联跑 `verify()`（起一个 PowerShell 问监听表，实测 0.72 秒 —— 占了看护一圈 96% 的时间）。
//   现在把那件慢活搬进 `长命资源巡检.mjs`（跑一次就退、且是 `_crew\长命资源状态.json` 的**唯一写方**）：
//     · 平时：这里只**读文件**（1ms）；
//     · 只有"那张纸超过 30 分钟没更新"时，才顺手叫一次巡检真核（兜底，防悄悄漂移）；
//     · "谁动服务谁叫"（确保脚本/换会话/面板/登记）负责**当场准**。
//   ⚠️ 三条纪律不变：① **只报告，绝不杀谁**；② **不进异常判据（不参与退出码）**——孤儿常是别人起的
//      开发服务器，为它叫醒大脑一次 ≈$0.1 不值当；③ 结论**只写在状态文件里**，看护状态.json **不再抄一份**
//      （同一件事只许一个说法；看板/体检去读 `d.longlive`，那是直读状态文件）。
const LL_STALE_MIN = Number(process.env.DSH_LONGLIVE_STALE_MIN ?? 30)
let longlive = null
try {
  const LL = await import('./长命资源巡检.mjs')
  let st = LL.readStatus()
  const age = LL.statusAgeMin(st)
  if (!st || age == null || age > LL_STALE_MIN) {
    try { st = LL.refreshStatus({ by: '看护兜底' }) } catch (e) { st = st ? { ...st, staleErr: String(e?.message ?? e) } : null }
  }
  const age2 = LL.statusAgeMin(st)
  longlive = st
    ? { state: st.state, verdict: st.verdict, counts: st.counts, at: st.at, ageMin: age2, checkedBy: st.checkedBy,
        orphans: st.orphans ?? [], dead: st.dead ?? [], mismatch: st.mismatch ?? [],
        note: '真值在 `_crew\\长命资源状态.json`（唯一写方＝巡检）；这里只是**本次读到的那份**＋新鲜度。看护只读不杀。' }
    : { state: 'unknown', why: '既没有状态文件、现核也失败', note: '如实报未知，不假装绿' }
} catch (e) { longlive = { state: 'unknown', why: String(e?.message ?? e), note: '核对本身失败 —— 如实报未知，不假装绿' } }

// ── ④b 最近一次换会话的"收尾结论"（★ b91 · 用户拍板"加那两块"的 B：**不 ok 就主动留告警**）
//   真值在 `_crew\换会话交接.json`（写方＝`登记服务.mjs` 的 `handover()`）；看护**只读**、只用来报警。
//   ⚠️ 两条分寸：① **b90 之前的老记录没有 `wrap` 字段** ⇒ 不报警（那会儿根本没核，不是"没交接"，别制造假警报）；
//              ② 仍**不进退出码**（看护的异常判据只管"卡住/跑死"，一个字不改）。
let swapRecent = null
try {
  const hf = join(CREW, '换会话交接.json')
  if (existsSync(hf)) {
    const rec = (JSON.parse(readFileSync(hf, 'utf8').replace(/^\uFEFF/, '')).records ?? []).slice(-1)[0] ?? null
    if (rec) {
      const w = rec.wrap ?? null
      swapRecent = {
        at: rec.at, oldSession: rec.oldSession, newSession: rec.newSession,
        took: (rec.took ?? []).length, stopped: (rec.stopped ?? []).length,
        hasWrap: Boolean(w), wrapOk: w ? Boolean(w.ok) : null, wrapLevel: w?.level ?? null, wrapWhy: w?.why ?? null,
        ageMin: Math.round(((Date.now() - Date.parse(rec.at ?? '')) / 60000) * 10) / 10
      }
    }
  }
} catch { /* 读不到就当没有：交接留痕不是看护的主业，别为它报错 */ }

const out = {
  // ★ 2026-10-26（§零.6 统一信封）：原来只有 `schema/at/state`，缺 `kind/source/stale` ——
  //   于是看板的 `healthOf()` 只能判 unknown（**这次它判对了**：缺信封就不许当绿）。
  //   现在补全六段；`state` 用绿/黄/红词表（stalled/dead 视作 red），未知才写 unknown。
  schema: 1,
  kind: 'run-health',
  at: now().toISOString(),
  source: '进度看护.mjs',
  state: ['stalled', 'dead'].includes(state) ? 'red' : (state === 'running' ? 'green' : (state === 'idle' ? 'unknown' : 'unknown')),
  stale: false,
  stateZh, detail,
  project, projectFrom: from,
  stallMin: STALL.min, stallLevel: STALL.level, stallLevelSource: STALL.source, stallWhy: STALL.why,
  lock: { present: lock.present, pid: lock.pid ?? null, alive: lock.alive ?? false, who: lock.who ?? null, startedAt: lock.startedAt ?? null },
  progress: { stamp: fresh.stamp, files: fresh.files, noProgressMin: fresh.noProgressMin },
  ledger: led,
  longlive,
  swap: swapRecent,
  note: '看护=零 token 的旁观者：只看"进程还活着吗 / 有没有新产物 / 账本有没有新增"，不调模型、不改项目文件。'
    + '⚠️ `longlive` / `swap` 这两段是**看护本次读到的那份**（真值分别在 `_crew\\长命资源状态.json` 与 `_crew\\换会话交接.json`；看板/体检读的是那两份**直读**的，别拿这里当唯一源）。'
}
writeFileSync(STATE_FILE, JSON.stringify(out, null, 2) + '\n', 'utf8')

// ── 叫醒大脑（**用户 2026-10-05 拍板：开 B = 要自动叫醒**）────────────────────
//
// 三条安全线（缺一条都不发）：
//   ① **只在异常时**（`stalled` 卡住 / `dead` 跑死）—— 正常在跑绝不打扰；
//   ② **同一异常只叫一次**（去重键 = `state|pid|stamp`，上面已判）—— 否则每 5 分钟叫一次就变回烧钱轮询（每次叫醒≈$0.1）；
//   ③ **必须确认目标就是"大脑那个会话"**：按 `cwd == 钉住的项目` 认人 —— 认不出就**只写文件、不发**（绝不猜着发）。
// 通道：换会话桥 `127.0.0.1:19390/swap`（`op:list` 认人 → `op:prompt` 发一句话；token 在 `_unattended\secrets\swap-token.txt`）。
// ★ 2026-10-07：token 文件挪进 `secrets\`（与插件 `bridge-plugin\lib\index.js`、`换新会话.mjs`、
//   `看板数据.mjs` **四处同步**；少改一处就 token 分裂 → 全 401）。
// 关掉：`--no-notify` 或 `DSH_BOARD_WATCH_NOTIFY=0`。
const NOTIFY_ON = !(argv.includes('--no-notify') || process.env.DSH_BOARD_WATCH_NOTIFY === '0')
const SWAP = 'http://127.0.0.1:' + (process.env.DSH_BOARD_SWAP_PORT ?? 19390) + '/swap'
const TOKEN_FILE = join(WS, '_unattended', 'secrets', 'swap-token.txt')
const norm = (s) => String(s ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

// ★ 2026-10-26（§七 删/并/退：「删除 `进度看护` 里自己那份 `wakeBrain()`，统一用 `_唤醒.mjs`」）：
//   这里原来是**第二份**唤醒实现（自己读 token、自己挑会话）—— 两份实现就会有两套"认人"规则，
//   实测踩过"空会话顶掉大脑""模式不对也照发"。现在统一走 `_唤醒.mjs`（五步认人 + 找不到就写
//   `唤醒状态.json` 的 no-brain，不静默）。
async function wakeBrain (text) {
  if (!NOTIFY_ON) return '（已关自动叫醒：DSH_BOARD_WATCH_NOTIFY=0）'
  try {
    const r = await wake(this.project, text)
    if (r?.ok) return `✅ 已叫醒大脑（${String(r.sessionId ?? '').slice(0, 20)}…${r.queued ? '，队列投递' : ''}）`
    return `（没叫到：${r?.why ?? '未知'}）`
  } catch (e) { return `（叫醒失败：${String(e?.message ?? e)}）` }
}

// ── 告警：**同一异常只叫一次**（否则每 5 分钟叫一次 = 又变成烧钱的轮询）
const abnormal = state === 'stalled' || state === 'dead'
const fingerprint = `${state}|${lock.pid ?? '-'}|${fresh.stamp ?? '-'}`
if (abnormal) {
  const A = readJson(ALERT_FILE) ?? { schema: 1, alerts: [] }
  const seen = (A.alerts ?? []).some(a => a.fingerprint === fingerprint)
  if (!seen) {
    // ★ 2026-10-05：用户拍板**开 B** —— 这里真的去叫醒大脑（认不出人就只写文件）。
    const text = `【进度看护·自动叫醒】${stateZh}：${detail}\n项目：${project}\n证据：最新一轮 ${fresh.stamp ?? '-'} 已 ${fresh.noProgressMin ?? '?'} 分钟没有新文件；账本本项目 ${led.calls} 次。\n请你查一眼并按第 26 条归因：若是"跑死了"就重新起一轮；若是"卡住"就先摘现场（err.txt / exitCode / timedOut）再决定。`
    let woke = '（未尝试）'
    try { woke = await wakeBrain(text) } catch (e) { woke = `（叫醒失败：${String(e?.message ?? e)}）` }
    A.alerts = [...(A.alerts ?? []), { at: out.at, fingerprint, state, stateZh, project, detail, woke,
      todo: '自动叫醒：**用户 2026-10-05 拍板开 B**（门槛 = 状态判 stalled/dead；同异常只叫一次；只发给 cwd 等于钉住项目的那个会话）。要关：DSH_BOARD_WATCH_NOTIFY=0 或 --no-notify。' }].slice(-50)
    A.updatedAt = out.at
    writeFileSync(ALERT_FILE, JSON.stringify(A, null, 2) + '\n', 'utf8')
    log(`⚠️ 新增告警（去重键 ${fingerprint}）：${stateZh} —— ${detail}`)
    log(`   叫醒结果：${woke}`)
  } else log(`（同一异常已告警过，不重复叫：${fingerprint}）`)
}

// ── 长命资源的告警留痕（★ b88）：**黄/红就记一笔**，同一种脏只记一次（去重键 = 状态 ＋ 名字）。
//    ⚠️ 只写文件，**不叫醒大脑**（理由见上面 ④ 那两条纪律）。看板那颗「长命资源 ●」灯读的是同一套判据。
if (longlive && (longlive.state === 'yellow' || longlive.state === 'red')) {
  const names = [...(longlive.orphans ?? []).map((o) => 'port' + o.port), ...(longlive.dead ?? []).map((d) => d.name), ...(longlive.mismatch ?? []).map((m) => m.name)].join(',')
  const fp = `longlive|${longlive.state}|${names}`
  const A = readJson(ALERT_FILE) ?? { schema: 1, alerts: [] }
  if (!(A.alerts ?? []).some(a => a.fingerprint === fp)) {
    A.alerts = [...(A.alerts ?? []), { at: out.at, fingerprint: fp, kind: 'longlive', state: longlive.state, verdict: longlive.verdict, orphans: longlive.orphans ?? [], dead: longlive.dead ?? [], mismatch: longlive.mismatch ?? [],
      todo: '长命资源与登记册对不上：**看护只报告不杀**。孤儿＝未登记的监听进程（查清是谁的再决定：登记 `登记服务.mjs up`，或停掉）；红灯＝登记为该活着的死了（面板那颗灯点一下会拉起"有 ensure 脚本"的项，或手工跑它的 ensure 脚本）。' }].slice(-50)
    A.updatedAt = out.at
    writeFileSync(ALERT_FILE, JSON.stringify(A, null, 2) + '\n', 'utf8')
    log(`⚠️ 长命资源：${longlive.state} —— ${longlive.verdict}`)
  } else log(`（长命资源同一状态已告警过：${fp}）`)
}

// ── 换会话"没交接上"的告警留痕（★ b91 · B）：**只读交接单，不是 ok 就记一笔**（同一笔只记一次）。
//    为什么要它：换会话是自动的（常在夜里），而这种失败**天生"看着成功"**（日志还打印 ✓ 已停）。
//    分寸：① **b90 之前的老记录没有 `wrap` ⇒ 不报警**（那会儿根本没核过，报了是假警报）；
//          ② 只写文件（**不叫醒大脑**，同 longlive 的理由）；③ **不进退出码**，看护的异常判据一字未改。
if (swapRecent && swapRecent.hasWrap && swapRecent.wrapOk === false) {
  const fp = `swap|${swapRecent.oldSession}|${swapRecent.newSession}|${swapRecent.wrapLevel ?? 'bad'}`
  const A = readJson(ALERT_FILE) ?? { schema: 1, alerts: [] }
  if (!(A.alerts ?? []).some(a => a.fingerprint === fp)) {
    A.alerts = [...(A.alerts ?? []), { at: out.at, fingerprint: fp, kind: 'swap-wrap', level: swapRecent.wrapLevel, oldSession: swapRecent.oldSession, newSession: swapRecent.newSession, why: swapRecent.wrapWhy,
      todo: '换会话**换了但旧会话没交接上**（新会话读到的是旧断点）：① 看交接单 `_crew\\换会话交接.json` 里的 `wrap.why`；② 若是"归档会话"（DSH 会拒绝它的每一步）⇒ 换会话脚本本该拒绝，说明这次是 `--allow-archived` 或名单读不到；③ 人工给新会话补一句真实进度。' }].slice(-50)
    A.updatedAt = out.at
    writeFileSync(ALERT_FILE, JSON.stringify(A, null, 2) + '\n', 'utf8')
    log(`⚠️ 上次换会话**没交接上**（${swapRecent.wrapLevel}）：${String(swapRecent.wrapWhy ?? '').slice(0, 80)}`)
  } else log(`（同一笔换会话未交接已告警过：${fp}）`)
}

log(`[看护] ${stateZh}｜项目 ${project ?? '(未知)'}（来源：${from}）｜最新一轮 ${fresh.stamp ?? '-'}｜${fresh.noProgressMin === null ? '无产物' : fresh.noProgressMin + ' 分钟前有新文件'}｜账本本项目 ${led.calls} 次｜长命资源 ${longlive?.state ?? '?'}${longlive?.ageMin != null ? `（${longlive.ageMin} 分钟前核的）` : ''}`)
process.exit(abnormal ? 3 : 0)