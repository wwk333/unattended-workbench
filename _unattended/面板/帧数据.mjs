/**
 * 看板页数据（只读聚合）· 2026-10-10 ·「看」的便宜档 ＋ 翻译器接入
 *
 * 六格＝大脑＋5 职位。**不重算判定，能取现成字段就取现成的**：
 *   `_crew\board-data.json` —— 状态（pid 判活口径，看板数据.mjs 已算好）/ 模型 / 额度
 *   `_crew\ledger.json`     —— 最近调用（时间 / 任务 / 结果 / 回合）
 *   `adapters\`             —— 把"最近一次输出（信封）"尾部翻成事件行（最近动态）
 * 输出：{ ok, at, project:{name,path,pinned}, frames:[{ role, carrier, state, stateZh, tone,
 *        modelText, quotaTitle, live, recent:[{kind,text}] }] }
 * 口径：取不到如实"没有"（—/空），不猜、不编（面板老规矩）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { toEvents } from './adapters/index.mjs'
// ★ b123：显示名改从**载体声明**读（`_crew\carriers.json` 的 `displayName`）—— 原来这里写死一张 `pi→'Pi'` 的表，
//   加一个载体就得改面板代码。缺声明 ⇒ 回落裸 id（不编、不猜）。
import { carrierDisplayNameOf } from '../_载体属性.mjs'
import { brainTurnState } from './大脑会话.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')                 // 工作台根
const ROLES = ['coder-a', 'coder-b', 'reviewer', 'researcher', 'rescue']
const STATE_ZH = {
  running: ['在跑', 'on'],
  idle: ['空闲', 'off'],
  error: ['上次出错', 'err'],
  unassigned: ['没干过', 'off']
}

function readJson (p) { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null } }

/**
 * ★★ 2026-10-14（用户拍板）**每格的"能力"** —— 前端据此**置灰按钮 ＋ 悬停一句说明**。
 *
 * 为什么放服务端：判据是**配置**（`_crew\agents.json` 里这个角色的载体有没有 `sessionFlag`），
 *   浏览器读不到配置。**读配置、不写死角色名** ⇒ 以后换载体/加角色**自动对**，UI 不用改
 *   （这就是用户要的"无效的按钮要保留，防止后续更新"）。
 *
 * 三个动作的口径（2026-10-14 定稿）：
 *   · **暂停** ＝ 杀进程（大脑＝让宿主停掉当前那一轮，走 `/brain-stop`）
 *   · **继续** ＝ **插话**：带会话框里那句话、**续同一条会话**（杀+续）⇒ 需要载体有续跑口
 *   · **发送** ＝ **新会话新派活**（全新会话、不接前文）⇒ 不需要续跑口
 */
let _agentsCache = null
function agentsCfg () {
  if (_agentsCache) return _agentsCache
  _agentsCache = readJson(join(ROOT, '_crew', 'agents.json')) ?? { roles: {}, agents: {} }
  return _agentsCache
}
function capsOf (role) {
  if (role === '大脑') {
    // 大脑：没有子进程 ⇒「暂停」是"让宿主停当前这一轮"（另一条链，已经能用）；
    //       没有"续一条会话"这回事 ⇒「继续」置灰；「发送」是**真插话**（宿主 steer，与子 agent 的"新会话"不是一回事）。
    return {
      pause: true, resume: false, send: true, steer: true,
      whyResume: '续不了：大脑**就是**这条会话本身，没有"续一条会话"这回事。',
      whySend: '插话：把这句话**投进 DSH 这条会话**（走换会话桥，模式＝打断并入 —— 它当前这轮会被打断、这句话并进去接着跑）。**与子 agent 的「发送」不同**：那个是开新会话。'
    }
  }
  const cfg = agentsCfg()
  const agentName = cfg.roles?.[role]?.agent ?? null
  const flag = agentName ? (cfg.agents?.[agentName]?.sessionFlag ?? null) : null
  const carrier = agentName ? carrierDisplayNameOf(agentName) : '这家'
  return {
    pause: true,
    resume: Boolean(flag),
    send: true,
    steer: false,
    whyResume: flag ? null : (carrier + ' 没有续跑口（配置里 sessionFlag 为空）—— 如实续不了、不拼假命令。要用它就走「暂停」＋「发送」（新会话）'),
    whySend: null
  }
}
/** 展示层用：把换行/多余空白压成一行并夹长度（超长标"…"）。← 2026-10-10：防止单条长正文顶破格子 */
function clipLine (s, n) {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}
function norm (s) { return String(s ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() }
export function pidAlive (pid) { try { process.kill(Number(pid), 0); return true } catch { return false } }

/** 扫各项目 `_crew\running\*.json`，找某角色**此刻真在跑**的登记（pid 活 ＋ 未过 deadline 宽限）。 */
export function findRunningRecord (role, dataFile) {
  // ⚠️ 2026-10-11（A4-② 探针踩到的口径不一致）：本函数原来**只认形参**、不认 `DSH_BOARD_DATA`，
  //   而同一个文件里的 `buildFrames` 认 —— 两个读同一份看板数据的人口径不一致（换数据源的探针/工具会读到旧那份）。
  //   现在统一：形参 > `DSH_BOARD_DATA` > 默认路径（env 不设时行为与从前完全一样）。
  const b = readJson(dataFile ?? process.env.DSH_BOARD_DATA ?? join(ROOT, '_crew', 'board-data.json')) ?? {}
  const proj = new Set()
  for (const p of b.crewByProject ?? []) {
    const pp = p.path ?? (p.roles ?? []).find((r) => r.projectPath)?.projectPath   // ⚠️ 项目路径在项目对象的 `path` 上（角色行也有 projectPath 副本）
    if (pp) proj.add(pp)
  }
  try { const cur = String(readFileSync(join(ROOT, '_crew', '当前项目.txt'), 'utf8')).trim(); if (cur) proj.add(cur) } catch {}
  for (const pj of proj) {
    const dir = join(pj, '_crew', 'running')
    if (!existsSync(dir)) continue
    let files = []
    try { files = readdirSync(dir) } catch { continue }
    for (const f of files) {
      if (!f.endsWith('.json')) continue
      const rec = readJson(join(dir, f))
      if (!rec || rec.role !== role) continue
      if (!pidAlive(rec.childPid)) continue
      if (rec.deadlineMs && Date.now() > rec.deadlineMs) continue     // 防 pid 复用（与看板同口径）
      return { ...rec, project: pj, runningFile: join(dir, f) }
    }
  }
  return null
}

/**
 * ★ 2026-10-11（A4-②）**在跑那一轮的落点**（算出来，不猜）。
 *
 * 为什么算得出来：编排的文件名规则是硬的 ——
 *   `RUNDIR = <项目>\_crew\runs\<戳>`，普通任务落在 `RUNDIR\tasks\`、审核落在 `RUNDIR\review\`，
 *   而 `prompt/out/err` 三个文件名**都按 `cardId` 拼**（`编排.mjs`：`cardId = t.id[+'-'+attempt]`）。
 * ⇒ 只要 running 登记里有 `run` ＋ `cardId`，**在跑的输入输出都能算出路径**，不必等账本那种"跑完才记"。
 *
 * ⚠️ 为什么要这个：账本 `calls[].envelope` 是**收活那一刻才写**的 ⇒ 只看账本的话，
 *   **正在跑的那一轮在会话/动态里根本不存在**（这正是 ④ 那条"多半只在跑完才读"的病根）。
 *   老代码这里写的是 `join(项目, '_crew', 'tasks', task + '.out.json')` —— **少了 `runs\<戳>\` 两层**
 *   ⇒ 在跑时永远命中不了，只能退回账本。现在改成算真路径。
 *
 * 两个都不在盘上（刚 spawn、第一块还没吐）⇒ `found:false`，但**仍给出预计路径**，
 * 让调用方如实说"这轮还没输出"，而不是假装有。
 */
export function inFlightFiles (project, run, cardId) {
  if (!project || !run || !cardId) return { found: false, dir: null, outFile: null, promptFile: null }
  for (const sub of ['tasks', 'review']) {
    const dir = join(project, '_crew', 'runs', String(run), sub)
    const outFile = join(dir, `${cardId}.out.json`)
    const promptFile = join(dir, `${cardId}.prompt.txt`)
    if (existsSync(outFile) || existsSync(promptFile)) return { found: true, dir, outFile, promptFile }
  }
  const dir = join(project, '_crew', 'runs', String(run), 'tasks')
  return { found: false, dir, outFile: join(dir, `${cardId}.out.json`), promptFile: join(dir, `${cardId}.prompt.txt`) }
}

let cache = { at: 0, val: null }

export function buildFrames () {
  if (cache.val && Date.now() - cache.at < 5000) return cache.val   // 5 秒内复用（页面轮询去抖）
  const dataFile = process.env.DSH_BOARD_DATA ?? join(ROOT, '_crew', 'board-data.json')
  const b = readJson(dataFile)
  if (!b) return { ok: false, error: '读不到看板数据（_crew\\board-data.json）—— 先跑一次 看板数据.mjs', frames: [] }
  const ledger = readJson(join(ROOT, '_crew', 'ledger.json')) ?? { calls: [] }
  const calls = Array.isArray(ledger.calls) ? ledger.calls : []
  const projects = Array.isArray(b.crewByProject) ? b.crewByProject : []
  const providers = Array.isArray(b.providers) ? b.providers : []

  // 选"看"的项目：**钉住（＝顶栏选的工作区）优先**。
  // ★ 2026-10-10（用户口径："每个项目一个工作区 ⇒ 选工作区＝选项目"）：**删掉"没得跟就挑一个顶上"的兜底**。
  //   原来那行 `target = projects.find(hasRecords) ?? projects[0]` 会把 `_演练8` 那种演练项目
  //   当成"当前项目"显示出来 —— 看着像在跑项目、其实根本没选。现在：**没选就如实说没选**。
  const pinned = Boolean(b.currentProject?.set)
  let target = null
  if (pinned) target = projects.find((p) => norm(p.path) === norm(b.currentProject.path)) ?? null
  const projectUnset = !target

  // 谁在跑（跨项目；running 只可能有一个项目）
  const runningByRole = {}
  for (const p of projects) for (const r of p.roles ?? []) if (r.state === 'running' && r.live) runningByRole[r.role] = { row: r, project: p }

  function quotaTitleOf (row) {
    const vk = row?.vendorKey
    if (!vk) return ''
    const p = providers.find((x) => x.key === vk || x.canonical === vk)
    if (!p) return ''
    return [p.quotaKeysText, p.quotaText].filter(Boolean).join(' · ')
  }

  function recentOf (role, agent, row, running) {
    const out = []
    if (running && row.live) {
      const started = Date.parse(row.live.startedAt)
      const mins = Number.isFinite(started) ? Math.max(0, Math.round((Date.now() - started) / 60000)) : null
      out.push({ kind: 'status', text: '正在跑 ' + String(row.live.task) + (mins != null ? '（已 ' + mins + ' 分钟）' : '') })
    }
    const mine = calls.filter((c) => c.role === role).slice(-3).reverse()
    for (const c of mine) {
      const t = String(c.at ?? '').replace('T', ' ').slice(5, 16)
      const okMark = (c.ok === false || c.isError === true) ? '❌' : '✅'
      out.push({ kind: 'status', text: `${t} · ${String(c.task ?? '?')} · ${okMark}${c.numTurns ? ' ' + c.numTurns + ' 回合' : ''}` })
    }
    const evSrc = (() => {
      // ★ 2026-10-11（A4-②）：**在跑优先读"这一轮真在写的文件"** ——
      //   走 running 登记（pid 活＋没过 deadline）算出 `runs\<戳>\{tasks,review}\<cardId>.out.json`，
      //   它由编排**边收边 append** ⇒ 跑着时就能看到内容在长（旧代码路径算错，这条永远走不到）。
      //   ⚠️ running 登记只有编排派出去的活才有；手动拉起的载体（`liveCarrierProcs` 补的那条）
      //      没有 `run`/`cardId` ⇒ 自然退回账本那份，口径不变。
      if (running && row.live) {
        const rec = findRunningRecord(role, dataFile)
        if (rec) {
          const f = inFlightFiles(rec.project, rec.run, rec.cardId)
          if (f.outFile && existsSync(f.outFile)) return { file: f.outFile, carrier: agent }
        }
      }
      const c = calls.slice(-10).reverse().find((x) => x.role === role && x.envelope && existsSync(x.envelope))
      return c ? { file: c.envelope, carrier: agent } : null
    })()
    if (evSrc) {
      let text = ''
      try { text = readFileSync(evSrc.file, 'utf8') } catch {}
      // ★ 2026-10-10 修（实测踩坑）：**每条动态都要夹长度、并压掉换行** ——
      //   coder-b 那格曾塞进一条 **1379 字的"最终正文"**（带 markdown 的 `###` / `**` / `---`），
      //   配上 CSS 的 `white-space: pre-wrap`，把格子的动态区顶成**一堵墙**（显示像是坏了）。
      //   展示层**不许被单条长文顶破**：这里先压成一行并夹到 160 字（超长标"…"）；CSS 再兜一层行数裁剪。
      for (const e of toEvents(evSrc.carrier, text).slice(-3)) out.push({ kind: e.kind, text: clipLine(e.text, 160) })
    }
    return out.slice(0, 6)
  }

  const frames = []
  // ① 大脑格（会话级）
  {
    const br = b.brainRow ?? null
    const recent = []
    // ★ 2026-10-10：**没选工作区就直说**（删了"挑一个顶上"的兜底之后，这里给用户指路）
    if (projectUnset) recent.push({ kind: 'status', text: '还没选工作区 —— 在看板顶栏「工作区」里选一个' })
    // ★ 2026-10-11（用户口径）：**「上下文占用」与「停着…」不再铺在正文里** ——
    //   "这个，上下文占用，停着… 应该放进「状态：空闲」这里，但是不是挤在一起，
    //    是鼠标移动过去悬停的时候显示"。⇒ 挪成 `stateDetail`（悬停状态才展开）。
    //   原来的理由（2026-10-10：上下文数字要给、且标明是谁的）**不变**，只是改挂到头部。
    const stateDetail = []
    if (br?.contextPercent != null && br?.contextText) {
      const who = br.contextTrust === 'current-project' ? '' : '（⚠️ 宿主投影会话，未必是本项目大脑）'
      stateDetail.push('上下文占用 ' + br.contextText + who)
    } else if (br?.contextText) {
      // ⚠️ 判据不能只看 `contextPercent != null` —— 没有数时 `contextText` 是 **`—`**，
      //   而**真正的解释在 `contextNote`**（例："这个会话还没有占用数据（刚建 / 还没发过请求）"）。
      //   原来漏了它 ⇒ 悬停只看到个 `—`、不知道为什么（实测发现）。悬停正好是放这句的地方。
      stateDetail.push('上下文占用 ' + br.contextText + (br.contextNote ? '　（' + br.contextNote + '）' : ''))
    }
    if (br?.stateReason) stateDetail.push(String(br.stateReason).replace(/\*\*/g, '').slice(0, 200))
    // ★ 2026-10-11（用户报障："**状态也不匹配，明明应该是绿灯**"）——**判据换掉**：
    //   老判据＝"转录文件最后写入几秒前（窗口 10s）"，而**模型思考期间一个事件都不写**
    //   （用户看到 DSH 那边"深度求索中 2分31秒"，面板却报"空闲"）。
    //   新判据＝**这一轮收尾了没有**（转录尾巴里 `turn/start` 与 `turn/end` 的先后）⇒ 思考多久都算在跑。
    //   看不出（尾窗里没有轮次标记）⇒ 退回老判据，并把"用的哪条判据"摊在悬停里（可核对）。
    const bt = brainTurnState()
    const st = bt.ok
      ? (bt.running ? ['在跑', 'on'] : ['空闲', 'off'])
      : (STATE_ZH[br?.state] ?? ['空闲', 'off'])
    stateDetail.unshift('在跑判据：' + (bt.ok ? bt.why : (bt.why || '看不出') + ' ⇒ 退回"转录最后写入"判据：' + String(br?.stateReason ?? '').replace(/\*\*/g, '').slice(0, 80)))
    frames.push({
      role: '大脑', carrier: 'DSH', state: bt.ok ? (bt.running ? 'running' : 'idle') : (br?.state ?? 'idle'), stateZh: st[0], tone: st[1],
      caps: capsOf('大脑'),
      stateDetail: stateDetail,
      modelText: br?.modelText ?? br?.model ?? '—', modelBadge: br?.modelBadge ?? null, quotaTitle: '', live: null, recent: recent.slice(0, 6),
      // ★ 2026-10-11（大脑会话视图）：**这一格的会话身份证** —— 有它，界面才给「会话」开关、
      //   才能往里插话。取自 `看板数据.mjs` 的 `brainRow.sessionId/sessionPath`（唯一口径：
      //   与上面那行"上下文占用/模型"同源）。取不到就 `null`（界面据此**不给**按钮，不留死胡同）。
      brainSessionId: br?.sessionId ?? null,
      brainSessionPath: br?.sessionPath ?? null,
      brainSessionScope: br?.sessionScope ?? null
    })
  }
  // ② 五职位格
  for (const role of ROLES) {
    const live = runningByRole[role]
    const row = live ? live.row : (target ? (target.roles ?? []).find((r) => r.role === role) : null)
    const agent = row?.agent ?? null
    if (!row) {
      frames.push({
        role, carrier: agent ? carrierDisplayNameOf(agent) : '—', state: 'unassigned', stateZh: '没干过', tone: 'off',
        caps: capsOf(role),
        modelText: '—', quotaTitle: '', live: null,
        recent: [{ kind: 'status', text: projectUnset ? '还没选工作区 —— 在看板顶栏「工作区」里选一个' : '这个项目里还没有记录' }]
      })
      continue
    }
    const st = STATE_ZH[row.state] ?? [String(row.state ?? '空闲'), 'off']
    frames.push({
      role,
      carrier: agent ? carrierDisplayNameOf(agent) : '—',
      caps: capsOf(role),
      state: row.state, stateZh: st[0], tone: st[1],
      modelText: row.modelText ?? row.model ?? '—',
      modelBadge: row.modelBadge ?? null,      // ★ 2026-10-10：小标（`MM-DD 实跑` / `未跑过`）——六格格式统一
      modelNote: row.modelNote ?? null,          // ★ 2026-10-10（口径 A）：模型证据的"如实说明"（如"最近一次没记模型"）
      modelUsedAt: row.modelUsedAt ?? null,
      quotaTitle: quotaTitleOf(row),
      live: row.live ? { task: row.live.task, cardId: row.live.cardId, childPid: row.live.childPid, startedAt: row.live.startedAt } : null,
      recent: recentOf(role, agent, row, Boolean(live))
    })
  }

  const val = {
    ok: true,
    at: new Date().toISOString(),
    dataAt: b.collectedAt ?? null,
    projectUnset,                                   // ★ 没选工作区 ⇒ true（界面据此提示，而不是拿别的项目顶）
    project: target ? { name: target.project, path: target.path, pinned } : { name: '', path: '', pinned },
    frames
  }
  cache = { at: Date.now(), val }
  return val
}
