#!/usr/bin/env node
/**
 * 看板数据生产者 —— 生成 `_crew\board-data.json`，给 `dsh-board-sidebar` 面板渲染。
 *
 * 为什么需要它：老家那套采集器（`看板采集器.mjs` + 额度读取器 + 计划任务）**没迁过来**，
 * 面板读不到文件 → 空白（看着像坏了，其实插件是好的）。本脚本从**已有真数据**生成，拿不到就明说。
 *
 * 字段口径**按面板源码反推**（`sidebar-plugin\lib\index.js`，**该插件已归档**：`_unattended\backup\retired-sidebar-plugin-20261010-011033\`；现役面板在 `_unattended\面板\`）：
 *   roster.ok 必须 true，且每个角色键名是 **role**（不是 id）；brain 要 found/state/lastWriteSecAgo；
 *   account 要 ok/reasons；ledgerTask 要 found/total/done/doing[].id/ready[].id/reason；
 *   quota.data 要 usedPercent/remaining/total；ledger 要 todayCalls/todayPitfalls。
 *
 * ★ 2026-10-03 新增（用户指定原型）：面板改成**两张表**
 *   `providers[]` = 表1 模型商（API来源）· 额度 / 调用次数 / token用量
 *        —— **三列各自独立判断有无**：有数据显示、没有留 `—`（用户 2026-10-03 定稿的长期口径，
 *           取代早先"每行只填一个、按优先级降档"的临时做法）；
 *   `crew[]`      = 表2 职位 · agent · 当前使用模型 · 状态（状态后跟次数）
 *        —— 状态由**派活回执 mtime / 账本回执**算出来，不再是写死的 `idle`；
 *           「当前使用模型」列带思考强度后缀（形如 `... · 思考 max`，没有档位写 `思考 —`）；
 *           末尾额外一行 = **DSH 本体（大脑）**，agent 写 `DSH`；
 *   `crewByProject[].consumption[]` = **表3 职位 · 消耗**（用户新增）
 *        —— **跟随项目**（与表2 同一口径），每行只填一个：token 用量（本项目） > 调用次数（本项目）；额度档已去掉（额度看表1）；
 *           额度那一档是**厂商级**（文案已标"厂商口径"），token/次数是本项目内该角色的。
 *   旧块（host/quota/ledger/ledgerTask/brain/account/roster/scheduler）**全部保留**。
 *
 * 用法：node 看板数据.mjs [--project <项目目录>] [--quiet]
 * ⚠️ 只读 + 只写这一个 JSON；不改配置、不调模型、不花钱。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync, renameSync } from 'node:fs'
// ★ 2026-10-26（修假绿）：七个健康源统一读取（缺文件/缺信封 ⇒ unknown，不当绿）
import { readHealthSources, describeHealth } from './_健康源.mjs'
// ★ 2026-10-26：`readJsonSafe` 早就该在这引 —— 上面 overview 那段第一版**没引**，
//   于是 try/catch 把 `ReferenceError: readJsonSafe is not defined` 吞成了 `null`，
//   表现是"契约那盏灯显示未体检"（看着像没跑过，其实是代码少了一行 import）。
import { readJsonSafe } from './契约/读.mjs'
// ★ 2026-10-26（§十）：任务唯一来源＝C 状态库（TASKS.md 只做对照）
import { taskSource } from './_看板任务源.mjs'
import { execSync, spawnSync } from 'node:child_process'   // ★ 2026-10-07：只看"载体进程在不在跑"（修看板盲区）用 execSync；b92 起 spawnSync 用于"可开工几条"
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// ★ 2026-10-11：大脑"在跑/停着"的判据（最近的轮次标记）—— **与面板读取路径同一处实现**，别处不重写。
import { turnStateOf } from './面板/大脑会话.mjs'
// ★ b197（施工文档 §四 D7）：规矩文件现状（**规则类红灯**）—— 判据只在 `面板\规矩面板.mjs`，
//   与"保存时那条自检"同源（页面上的红绿与它一致，UI 不许再写一套）。
import { rulesView } from './面板/规矩面板.mjs'
// ★ 2026-10-17（升 0.2.1）：宿主端口改成系统分配 ⇒ 统一从 `_宿主端口.mjs` 取，别再写死 19387。
import { hostPortSync, hostUrlSync } from './_宿主端口.mjs'
// ★ b209（2026-10-20）：项目定位（钉住的目录可能不是工作台根）—— 判据只在 `面板\项目定位.mjs` 一处。
import { locateProject } from './面板/项目定位.mjs'
// ★ 2026-10-23（施工文档 §14）：每载体上次使用的模型能力（上下文/最大输出）——查注册表，不猜
import { capacityOf } from './模型能力.mjs'
import { VAULT } from './_路径.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const OUT = resolve(process.env.DSH_BOARD_DATA ?? join(ROOT, '_crew', 'board-data.json'))
const HOME = process.env.USERPROFILE ?? ''
const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : d }
const quiet = argv.includes('--quiet')
const log = (...a) => { if (!quiet) console.log(...a) }
const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null } }

/* ── 班组定编（唯一权威 = _crew\agents.json）─────────────────────────── */
const crewCfg = readJson(join(ROOT, '_crew', 'agents.json')) ?? { roles: {} }
const roles = Object.entries(crewCfg.roles ?? {}).map(([role, v]) => ({
  role,                                  // ⚠️ 面板读的是 role
  agent: v.agent ?? null,
  model: v.model ?? v.prefer?.model ?? null,
  effort: v.effort ?? v.prefer?.effort ?? null,
  state: 'idle'                          // 静态生成只能是 idle；真跑时由编排回填 running/error
}))
const roster = { ok: roles.length > 0, roles, brain: { model: null, note: '大脑模型 = profile 的 agent-default-model' } }

/* ── 大脑模型 + 思考强度（读生效 profile 配置）──────────────────────── */
/** 大脑的思考强度（`agent-default-model.reasoningEffort`）。读不到留 null → 表2 显示 `思考 —`。 */
let brainEffort = null
try {
  const patch = readFileSync(join(HOME, '.dsh', 'profiles', 'desktop', 'cordis.patch.yml'), 'utf8')
  // 先切出 `- id: agent-default-model` 那一块，再在块内**逐字段各抓一次**。
  // ⚠️ 别写成一条正则一次抓三个字段：惰性量词会互相牵制，实测只抓到前两个。
  const block = patch.match(/- id: agent-default-model[\s\S]*?(?=\n\s*-\s*(?:id:|insert:)|\s*$)/)
  const b = block ? block[0] : ''
  const pv = b.match(/\bprovider:\s*(\S+)/)
  const md = b.match(/\bmodel:\s*(\S+)/)
  const ef = b.match(/\breasoningEffort:\s*(\S+)/)
  if (pv && md) roster.brain.model = `${pv[1]}/${md[1]}`
  if (ef) brainEffort = ef[1]
  roster.brain.effort = brainEffort      // 也放进 roster，排查时一眼能看到
} catch { /* 读不到留 null */ }

/* ── 大脑：找最近的会话日志（面板要 found/state/lastWriteSecAgo）─────── */
/**
 * ★ 2026-10-05：DSH 的 `sessions\<目录名>` **就是 cwd 的编码**（实测：
 *   `<示例项目>` → `--D-xiangmu-~5F02~6B21~5143--`；`~XXXX` = 该字符的 UTF-16 码位、大写十六进制）。
 *   所以能**按项目路径直接算出目录名**，精确取"本项目的会话" —— 这是"看板跟随会话"的地基
 *   （原来取**全局最新**，实测被一次测试用的一次性会话抢走，"大脑"那行就指错人、消耗也对不上）。
 */
function encodeSessionDir (cwd) {
  const enc = (s) => { let o = ''; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); o += c > 127 ? '~' + c.toString(16).toUpperCase().padStart(4, '0') : s[i] } return o }
  const segs = String(cwd).split(/[\\/]+/).filter(Boolean).map(s => s.replace(/:$/, ''))
  return '--' + segs.map(enc).join('-') + '--'
}
const SESS_ROOT = join(HOME, '.dsh', 'sessions')

// ★ 2026-10-07 修（用户："看板是不是又挂了，上下文 10.9% 根本不对"）——
//   **根因：拿"会话目录"的 mtime 当"会话活跃度"**。
//   目录 mtime 只在**增删文件**时才变；一个会话持续往同一个 `session.v4.jsonl.zstd` 里写，
//   目录 mtime 会一直停在上次增删的时刻。实测（异次元）：真主会话
//   `session-3d5d4b0c` 的**转录文件** mtime = 13:48（正在写、2.2MB），而**目录** mtime
//   还停在**两天前** 10-05 19:43 ⇒ 它被当成"老会话"淘汰，看板改挑了一个早结束的
//   子代会话（355KB，02:33）⇒ 表现为"大脑显示停着 / 上下文与消耗都不是本会话的"。
//   ⇒ 口径改成：**新鲜度＝转录文件自身的 mtime**；目录 mtime 只在没有转录文件时兜底。
const SESSION_TRANSCRIPT_NAMES = ['session.v4.jsonl.zstd', 'session.jsonl', 'session.v4.jsonl']
/**
 * ★ 大脑"干着"的判定窗口（秒）—— **2026-10-11 用户拍板：180 → 10**。
 *
 * 为什么敢收到 10：实测那台会话转录**只在真干活时写**（采样 60 秒、0 次变化，没有后台心跳）
 *   ⇒ 10 秒窗口不会变成"永远在跑"。
 * ⚠️ **代价（如实）**：模型"想很久才吐第一个字"、或跑长命令期间不写盘 ⇒ 超过 10 秒没动静就会显示"停着"，
 *   然后下一次写盘又变回"干着" ⇒ **可能有轻微闪烁**（用户要的是"及时"，这个代价他认）。
 * ⚠️ **必须与 `面板\service.mjs` 的 `BRAIN_RUNNING_WINDOW_SEC` 保持一致**（那边读取时会按当前时刻重算）。
 * 想改回去/改成别的：设环境变量 `DSH_BRAIN_WINDOW_SEC`，别只改一头。
 */
const BRAIN_RUNNING_WINDOW_SEC = Number.isFinite(Number(process.env.DSH_BRAIN_WINDOW_SEC))
  ? Number(process.env.DSH_BRAIN_WINDOW_SEC)
  : 10
/** 读某个会话的 {mtimeMs, size, hasTranscript}：优先转录文件，读不到才退回目录 mtime。 */
function sessionMtimeSize (entryPath) {
  let dirM = 0
  try { dirM = statSync(entryPath).mtimeMs } catch { return null }
  for (const cand of SESSION_TRANSCRIPT_NAMES) {
    try {
      const st = statSync(join(entryPath, cand))
      return { mtimeMs: st.mtimeMs, size: st.size, hasTranscript: true }
    } catch { /* 换下一个候选名 */ }
  }
  return { mtimeMs: dirM, size: 0, hasTranscript: false }
}

/** ★ 2026-10-11：大脑候选＝**真源名单**（`~\.dsh\storages\workspace.json` 里该工作区的 `sessionIds`，
 *  去掉 `global.archivedSessionIds`＝侧栏的"删除"）。真源里没这个工作区 ⇒ `ok:false`（调用方退回按 cwd 目录挑并标注）。
 *  用 `USERPROFILE` 拼路径，避免引入新 import。 */
function workspaceSessionIds (projectPath) {
  const nz = (x) => String(x ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  try {
    const store = process.env.DSH_WORKSPACE_STORE ??
      join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'storages', 'workspace.json')
    const w = JSON.parse(readFileSync(store, 'utf8'))
    const arch = new Set((w?.global?.archivedSessionIds ?? []).map((x) => String(x).replace(/^session-/, '')))
    for (const v of Object.values(w?.tables?.workspaces ?? {})) {
      if (nz(v?.path) !== nz(projectPath)) continue
      return { ok: true, ids: (v.sessionIds ?? []).map((x) => String(x).replace(/^session-/, '')).filter((id) => !arch.has(id)) }
    }
    return { ok: false, why: '真源里没有这个工作区' }
  } catch (e) { return { ok: false, why: '读 workspace.json 失败：' + String((e && e.message) || e).slice(0, 80) } }
}

/** 某个 sessions 目录下**最新的**那份会话日志（读不到返回 null）。 */
function newestSessionIn (dir) {
  let newest = null
  try {
    for (const s of readdirSync(dir)) {
      const f = join(dir, s)
      const ms = sessionMtimeSize(f)
      if (!ms) continue
      const m = ms.mtimeMs
      if (!newest || m > newest.m) newest = { m, p: f }
    }
  } catch { /* 目录不存在 */ }
  return newest
}

/**
 * ★ 2026-10-05 修：在"本项目的所有会话"里挑**真大脑** —— 不是"最新那个"，而是**干活最多那个**。
 *
 * 为什么必须改（实测踩到）：同一个项目目录下会有**好几个会话** —— 一次性测试会话、子会话、
 * 真正跑了几百轮的大脑。原来只取 `newestSessionIn`（最新）→ 被**用完就丢的短会话**抢走。
 * 实测：异次元目录下有 3 个会话，挑中了 `3d5d4b0c`（**没有任何占用数据**、cost-meter 里也查不到）
 * 而不是真大脑 `dd095ce6`（**51.0%**、1.44 亿 tok、$38.60）。症状就是"看板像没更新"。
 *
 * 判据（**本地即可判，不依赖换会话桥**）：**转录文件最大** —— 大脑跑几百轮，文件比一次性会话大一个量级；
 * 并列时取 mtime 较新的。返回 `{ p, m, size, id, n }` 或 null。
 */
function pickBrainSessionIn (dir) {
  const list = []
  try {
    for (const s of readdirSync(dir)) {
      const f = join(dir, s)
      let isDir = false
      try { isDir = statSync(f).isDirectory() } catch { continue }
      if (!isDir) continue                                   // 只认会话目录（同名的 0KB 标记文件跳过）
      const ms = sessionMtimeSize(f)
      if (!ms) continue
      list.push({ p: f, m: ms.mtimeMs, size: ms.size, hasTranscript: ms.hasTranscript, id: s.replace(/^session-/, ''), n: list.length + 1 })
    }
  } catch { return null }
  if (!list.length) return null
  // ★ 2026-10-07 第二次修（用户："看板又挂了"；实测看板显示 4.4%/44K，而 DSH 自己显示 20%/197K）：
  //   "最新 × 最大"名次和**仍会被"刚建的空壳会话"抢走** —— 因为两者名次和打平时按**最新**取胜，
  //   而刚建的会话永远最新。⇒ 先按**纯相对**判据（**中位数**，不是任何固定阈值）筛掉"明显偏小"的候选：
  //   只留 `size >= 候选中位数` 的；筛完为空则退回全体（保底）。
  //   然后在这批"有分量"的候选里按「最新写入 × 转录大小」名次和取，平局取最新。
  //   ★ 2026-10-07 补：先只留**有转录文件**的会话（没有转录＝空壳/尚未开始），再按大小中位数筛。
  const _withT = list.filter(x => x.hasTranscript)
  const _base = _withT.length ? _withT : list
  const _sizes = _base.map(x => x.size).sort((a, b) => a - b)
  const _mid = _sizes.length % 2 === 1
    ? _sizes[(_sizes.length - 1) / 2]
    : (_sizes[_sizes.length / 2 - 1] + _sizes[_sizes.length / 2]) / 2
  const _cand = _base.filter(x => x.size >= _mid)
  const pool = _cand.length ? _cand : _base
  const rankBy = (arr, key) => new Map([...arr].sort((a, b) => b[key] - a[key]).map((x, i) => [x.p, i]))
  const rM = rankBy(pool, 'm')
  const rS = rankBy(pool, 'size')
  pool.sort((a, b) => (rM.get(a.p) + rS.get(a.p)) - (rM.get(b.p) + rS.get(b.p)) || (b.m - a.m))
  return pool[0]
}
let brain = { found: false, state: 'stopped', lastWriteSecAgo: null, model: roster.brain.model, note: '找不到会话日志' }
try {
  let newest = null
  for (const d of readdirSync(SESS_ROOT)) {
    const dp = join(SESS_ROOT, d)
    try { if (!statSync(dp).isDirectory()) continue } catch { continue }
    const n = newestSessionIn(dp)
    if (n && (!newest || n.m > newest.m)) newest = n            // 兜底：全局最新（下面会被"本项目"覆盖）
  }
  if (newest) {
    const sec = Math.round((Date.now() - newest.m) / 1000)
    brain = { found: true, state: sec < BRAIN_RUNNING_WINDOW_SEC ? 'running' : 'idle', lastWriteSecAgo: sec, model: roster.brain.model, sessionPath: newest.p, scope: 'global-newest' }
  }
} catch { /* 保留 note */ }

/* ── 账号是否可用（凭据文件在不在；拿不到就明说）───────────────────── */
const credFile = join(HOME, '.dsh', '.credentials.yaml')
const account = existsSync(credFile)
  ? { ok: true, reasons: [], source: credFile }
  : { ok: false, reasons: [`读不到凭据文件（${credFile}）`] }

/* ── 账目：今日调用 + 今日新增坑 ────────────────────────────────────── */
const today = new Date().toISOString().slice(0, 10)
/** 班组账本路径。与 `工量账本.mjs` / `外部用量快照.mjs` 同一约定：可用 `DSH_LEDGER` 覆盖
 *  （相对则相对工作台根解析）—— 自检/复算时换一本账，不动真账。 */
const LEDGER = process.env.DSH_LEDGER
  ? resolve(ROOT, process.env.DSH_LEDGER)
  : join(ROOT, '_crew', 'ledger.json')
const ledgerDoc = readJson(LEDGER) ?? {}
const ledgerCalls = Array.isArray(ledgerDoc.calls) ? ledgerDoc.calls : []
/** ★ b193（M6-7「速度量具」）：四个数由 `工量账本.mjs speed --write` 算好落 `_crew\速度量具.json`，
 *  看板**只读缓存**（本文件是每次刷新都跑的，不能自己去递归扫 68 个 runs 目录）。
 *  ⚠️ 读不到/过期 ⇒ **显示"未跑"**，绝不编 0（0 会被当成"并行度真的 0"）。 */
const SPEED = (() => {
  try {
    const p = process.env.DSH_SPEED_CACHE ? resolve(ROOT, process.env.DSH_SPEED_CACHE) : join(ROOT, '_crew', '速度量具.json')
    if (!existsSync(p)) return { available: false, why: '还没跑过：`node _unattended\\工量账本.mjs speed --write`' }
    const j = readJson(p)
    if (!j) return { available: false, why: '缓存读不出来（文件坏了？）' }
    const ageH = j.at ? +((Date.now() - Date.parse(j.at)) / 3600000).toFixed(1) : null
    return {
      available: true, at: j.at ?? null, ageHours: ageH, stale: ageH != null && ageH > 24,
      secPerTurn: j.secPerTurn ?? null,
      waves: j.waves ? {
        count: j.waves.count,
        sumWallHours: j.waves.sumWallHours ?? null,
        gaps: j.waves.gaps?.['按文件时间'] ?? null,
        parallelismMultiCard: j.waves.parallelismRangeMultiCard ?? null,
        windowFrom: j.waves.windowFrom ?? null, windowTo: j.waves.windowTo ?? null,
      } : null,
    }
  } catch (e) { return { available: false, why: '读速度缓存出错：' + String(e?.message ?? e) } }
})()
const todayCalls = ledgerCalls.filter(c => String(c.at ?? '').startsWith(today) || c.date === today).length
let todayPitfalls = 0
try {
  const kb = process.env.KB_ROOT ?? VAULT
  if (existsSync(kb)) todayPitfalls = readdirSync(kb).filter(f => f.startsWith(today) && f.endsWith('.md')).length
} catch { /* 0 */ }

/* ── 当前项目 + 任务账目 ────────────────────────────────────────────── */
const pointer = join(ROOT, '_crew', '当前项目.txt')
let proj = opt('project', null)
/** 当前项目是从哪儿来的（表2 要标注"这是哪个项目"，所以来源也要记下来）。 */
let projSource = proj ? '命令行 --project' : null
// ★ 2026-10-05（B 方案配套）：**`--project` 必须校验存在性** ——
//   宿主半已经把 `?project=<会话 cwd>` 透传进来，而"路径写错/已删除/打错字"都会被当成当前项目，
//   于是看板会一本正经地显示一个**不存在的项目**（实测：`--project <不存在>` 原来照收）。
//   现在：不是真实目录 → 忽略它、留一行告警，然后**退到指针文件**（钉子仍是最高优先级手段）。
let projRejected = null
if (proj) {
  let ok = false
  try { ok = statSync(proj).isDirectory() } catch { ok = false }
  if (!ok) { projRejected = proj; proj = null; projSource = null }
}
// ★ 2026-10-06 修（用户看板实测当场发现）：**指针文件必须压过"跟随会话"** ——
//   文档一直写着"`_crew\当前项目.txt` / `--project` 是**手动钉住**，优先级高于会话工作区"，
//   但代码是反的：`--project` 先写进 `proj`，指针只在**没有** `--project` 时才生效
//   ⇒ 客户端每次带着会话 cwd 来取数，就把钉住的项目**顶掉**了。
//   实测症状：`当前项目.txt` 里明明写着 `<示例项目>`，看板却显示"项目：无人值守"
//   （= 大脑会话的工作区），于是「🔴 待你处理」「测试」两行读的都是**错项目**的文件。
//   现在：**有指针就以指针为准**（它本来就是"显式钉住"那根救命绳）；没有指针才跟随会话。
if (existsSync(pointer)) {
  const pinned = readFileSync(pointer, 'utf8').trim().split(/\r?\n/)[0].trim()
  if (pinned) {
    if (proj && resolve(pinned) !== resolve(proj)) {
      console.warn(`[看板] 指针文件钉住了 ${pinned} → 覆盖会话工作区 ${proj}（想跟随会话就清空 _crew\\当前项目.txt）`)
    }
    proj = pinned
    projSource = `指针文件 ${pointer}（钉住优先，覆盖会话工作区）`
  }
}
if (projRejected) console.warn(`[看板] 忽略 --project（不是真实目录）：${projRejected}${proj ? `　→ 退回 ${projSource}` : ''}`)
/* ★ b209（2026-10-20 · 通宵跑「恋爱军师」实测事故）：**钉住的目录可能不是工作台根**。
 *   事故现场：会话开在 `…\项目：恋爱军师`（里面只有 `策划方案.md` / `项目管理.md`），
 *   而代码与 runs 在 `<示例项目>\_crew`；原来这里直接 `resolve(proj)` 去读 TASKS/runs/会话目录
 *   ⇒ 表2、表3、会话视图、运转链**全空**，看着像"看板检测不到子 agent"。
 *   判据只在 `面板\项目定位.mjs` 一处：① 自己带 `_crew` ② 项目对照表 ③ 账本证据（24h 内）④ 明说没有。
 *   ⚠️ 只换"读哪个目录"；`projSource` 与钉子原文都留着（页面要把"你钉的是 A、实际读的是 B"说清楚）。 */
const projLoc = proj ? locateProject(proj, { calls: ledgerCalls }) : null
const projPin = projLoc?.input ?? null
if (projLoc?.path && proj && resolve(projLoc.path) !== resolve(proj)) {
  console.warn(`[看板] 钉住的 ${proj} 不是工作台根 ⇒ 按${projLoc.by === 'map' ? '项目对照表' : '账本证据'}读 ${projLoc.path}`)
  proj = projLoc.path
}
// ★ 2026-10-26（§十「看板任务从 C 读；TASKS 只对照」）：任务状态**只从 C 状态服务读**。
//   TASKS.md 已降级为生成视图 —— 这里只拿它做对照，不一致就给 stale（页面显示过期），
//   **不切回文件**；C 服务不可用就如实报"读不到"（红/未知），也不退回 TASKS.md。
let ledgerTask = { found: false, total: 0, done: 0, doing: [], ready: [], reason: '未设置当前项目', source: 'none', stale: false, byStatus: {}, tasks: [], view: null }
if (proj) {
  try {
    const src = await taskSource({ project: resolve(proj) })
    ledgerTask = { ...src, reason: src.source === 'state-service' ? `当前项目：${resolve(proj)}` : src.staleWhy }
  } catch (e) {
    ledgerTask = { ...ledgerTask, stale: true, staleWhy: `读任务源异常：${String(e?.message ?? e)}` }
  }
}

/* ── 额度（火山；arkcli 只给百分比，绝对值读不到 —— 如实标注）────────── */
/** 窗口标签 → 中文（快照里是 session/weekly/monthly）。 */
const PERIOD_ZH = { session: '本会话', weekly: '本周', monthly: '本月' }
/** 额度快照 → provider key 的对应表：表1 靠它把「额度」归并到厂商那一行。
 *  目前**只有火山 coding-plan 一家有快照**（见 QUOTA_SNAPSHOT 注释）。 */
const QUOTA_VENDOR = { 'volcengine-coding-plan': 'ark' }
/** 产出的表1 用：provider key → 该厂商的额度口径（一个厂商只取**一个**口径）。 */
const quotaByVendor = new Map()
let quota = { ok: false, reason: '读不到额度快照（先跑 网关额度快照.mjs）' }
const q = readJson(join(ROOT, '_crew', '网关额度', 'volcengine-coding-plan.json'))
if (q?.periods?.length) {
  const monthly = q.periods.find(p => p.label === 'monthly') ?? q.periods[0]
  const weekly = q.periods.find(p => p.label === 'weekly')
  const used = Number(monthly.percent)
  quota = {
    ok: true,
    data: {
      usedPercent: used,
      remaining: `${(100 - used).toFixed(2)}%`,   // 官方只给百分比，不伪装成绝对积分
      total: '100%',
      period: monthly.label, resetAt: monthly.resetAt,
      weeklyPercent: weekly ? Number(weekly.percent) : null,
      source: q.source, fetchedAt: q.fetchedAt
    }
  }
  // ★ 用户规则：一个厂商有多个额度口径时**只显示一个**并标明口径 → 固定取本月，
  //   口径名由客户端拼成「剩余：91.50%（本月）」。其它口径仍在 quota 块里（不删）。
  quotaByVendor.set(QUOTA_VENDOR['volcengine-coding-plan'] ?? 'ark', {
    period: monthly.label,
    periodLabel: PERIOD_ZH[monthly.label] ?? monthly.label,
    usedPercent: used,
    remainingPercent: Number((100 - used).toFixed(2)),
    resetAt: monthly.resetAt
  })
}

/* ═══ ★ 2026-10-05（用户口径）：**看板与"实际用的 API"对齐** ═══════════════════════════════════
 *  表1 的 provider key 是 **DSH 那边的名字**（例 `qwen-token-plan-cn`），而额度系统一律用
 *  **载体路由表的权威名**（`aliyun`）—— 两套名字靠 `discoverProviders()` 给的 `alias` 配对（**唯一的桥**）。
 *  这里做两件事：① **名字对齐**（表1 显示权威名，同时保留 DSH 名字做对照）；
 *                ② 补「**钥匙**」列（哪几把 / 掩码 / 来源 / 可用状态 —— 数据来自 `额度状态.json`）；
 *  另外给职位行补「**实际走哪家**」（额度兜底可能已把它换到别家 + 是否被切走过）。
 *  ⚠️ 一律**只读**；读不到就留 `—`（协议 P3：**查不到不估算**）。
 *  ⚠️ 用 `await import()` + try/catch：额度系统万一出问题，**看板照常出**（只是少那两列）。 */
let _quota = { QV: { ok: '✅可用', 'invalid-key': '❌钥匙无效', quota: '⚠️没额度', 'rate-limited': '⏳被限流', 'no-probe': '❓无法探测', network: '🌐连不上', error: '❌探测出错', missing: '➖缺钥匙' }, state: {} }
try {
  const { discoverProviders, loadSecrets, loadStruct, mask, resolveKey, loadBlocked } = await import('./额度钥匙.mjs')
  const { pick } = await import('./额度切换.mjs')
  const { runCli } = await import('./额度面板.mjs')
  const provs = discoverProviders(); const sec = loadSecrets(); const str = loadStruct()
  let state = readJson(join(ROOT, '_crew', '额度状态.json'), {})
  const canonOf = (key) => {
    if (!key) return null
    if (provs[key]) return key
    const hit = Object.entries(provs).find(([, v]) => (v.alias ?? []).includes(key))
    return hit ? hit[0] : null
  }
  const ofProvider = (key) => {
    const canon = canonOf(key)
    if (!canon) return null
    const declared = (str.keys?.[canon] ?? []).slice().sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    const n = Math.max(declared.length, (sec.providers?.[canon] ?? []).length)
    const keys = []
    for (let i = 0; i < n; i++) {
      const r = resolveKey(canon, i, str, sec, provs)
      const st = (state.providers?.[canon] ?? []).find(x => x.idx === i) ?? null
      keys.push({ label: declared[i]?.label ?? ('#' + (i + 1)), mask: r ? mask(r.key) : null, source: r?.source ?? null, verdict: st?.verdict ?? null })
    }
    const vs = keys.map(k => k.verdict).filter(Boolean)
    const bad = vs.find(x => ['quota', 'invalid-key', 'rate-limited'].includes(x))
    return {
      canonical: canon, dshKey: key === canon ? null : key, keys,
      verdict: vs.includes('ok') ? 'ok' : (bad ?? (vs[0] ?? null)),
      baseURL: provs[canon]?.baseURL ?? null, models: provs[canon]?.models ?? []
    }
  }
  _quota = {
    ..._quota, canonOf, ofProvider, state, provs, pick, loadBlocked, resolveKey,
    keysText: (q) => (q?.keys?.length
      // ⚠️ 没探测过的**必须写「未检测」**（用户反馈："只显示了一家可用" —— 留空会被当成"不可用"）
      ? q.keys.map(k => `${k.label} ${k.mask ?? '（缺）'} ${k.verdict ? (_quota.QV[k.verdict] ?? k.verdict) : '未检测'}`).join('　+　')
      : null),
    actualOf: (role) => { try { const p = pick(role); return p.ok ? { provider: p.provider, model: p.model, idx: p.idx, keySource: p.keySource ?? null } : null } catch { return null } }
  }
  // ★ 2026-10-05（**用户反馈**："他只显示了一家可用，明明不止一家"）：
  //   原因：**只有探测过的家才有状态**，没探过的留空 → 看着像"不可用"，其实只是"没查过"（是**显示缺陷**）。
  //   对策：① 没探过的行**明确写「未检测」**（下面 `keysText` 里拼）；② **惰性补探** ——
  //   凡"**有钥匙、有探测地址、但从没探过**"的家，本次后台**补探一次**
  //   （**零 token 请求**，每家一个；最多补 `MAX_LAZY` 家、单个 6 秒超时，避免拖慢看板刷新）；
  //   **探过就记进 `额度状态.json`，以后不再重复探**（不是每次刷新都打网络）。
  //   仍然只读语义：探测**只更新状态文件**，不改任何配置。
  const MAX_LAZY = 2
  const unprobed = []
  for (const canon of Object.keys(provs)) {
    if ((state.providers?.[canon] ?? []).length) continue              // 探过 → 不重复
    const n = Math.max((str.keys?.[canon] ?? []).length, (sec.providers?.[canon] ?? []).length)
    if (n <= 0) continue                                              // 没钥匙 → 探了也是"缺钥匙"
    if (!provs[canon]?.baseURL) continue                              // 没地址 → 探不了（协议 P2）
    unprobed.push(canon)
  }
  if (unprobed.length) {
    const todo = unprobed.slice(0, MAX_LAZY)
    console.log(`[看板] 补探 ${todo.length} 家（没探过的：${todo.join('、')}${unprobed.length > todo.length ? `；本次只补 ${MAX_LAZY} 家，其余下次` : ''}）—— 每把钥匙一个零 token 请求`)
    for (const canon of todo) { try { await runCli('额度检测.mjs', ['--provider', canon, '--timeout', '6000'], null, 30_000) } catch {} }
    state = readJson(join(ROOT, '_crew', '额度状态.json'), {})         // 探完重新读，下面的表1 才拿得到新状态
    _quota.state = state
  }
} catch (e) { console.warn('[看板] 额度系统这次没读上（看板照常出，只是少"钥匙/实际走哪家"两处）：' + String(e?.message ?? e)) }

/* ═══ 表1「模型商（API来源）」：额度 / 调用次数 / token 用量 —— 三列各自独立判断有无 ═══════════════
 *
 * 用户定稿口径（2026-10-03，**长期**）：**三列各自独立判断有无** —— 有数据的都显示，
 * 没有的留 `—`。（早先那版"每行只填一个指标、按 额度 > token > 次数 降档"已被用户推翻，
 * 别退回去。）
 *
 * 三路数据源（按 provider key 合并去重）：
 *   ① **DSH cost-meter 账本** `%USERPROFILE%\.dsh\storages\cost-meter\ledger.json`
 *      → `days.<日期>.byProviderModel["<provider>:<model>"]` —— 这才是**真正的按厂商/模型分项**
 *        （`_crew\ledger.json` 里**没有**这个字段，见文件尾交付说明）。
 *   ② **班组账本** `_crew\ledger.json` 的 `calls[]`：非 DSH 载体（Pi/OpenCode/CodeBuddy/Qoder）
 *      的调用，按 `model` 的 `provider/model` 前缀归并到同一个厂商 key。
 *      ⚠️ **跳过 DSH 自己的载体**（messenger/dsh）—— 那些已经被 cost-meter 计量过，
 *         再并进来就是重复计数（同 `外部用量快照.mjs` 的纪律①）。
 *   ③ **额度快照** `_crew\网关额度\*.json`（目前只有火山 coding-plan，见上）。
 *
 * ⚠️ 阿里 token plan **本机拿不到额度数值**（多方实测结论，别再去试登录）：
 *    · `bl usage token-plan`（百炼 CLI，本机已装已登录）在 5-hour / 1-week 两栏都只回
 *      "The ... limit may be unlimited; verify in the Bailian Token Plan console."——**没有数字**；
 *    · cost-meter 的 gateway-quota 适配器只覆盖 antigravity / claude / codex / kimi / xai / workbuddy；
 *    · `dsh-cost-meter\lib\aliyun-balance.js` 需要 RAM AccessKey/Secret（本机 OpenAPI 未配置）。
 *    ⇒ 按降档规则：阿里那行显示 **token 用量**（不写 `—`，也不是估算）。
 */
const CM_LEDGER = process.env.DSH_COST_METER_LEDGER ?? join(HOME, '.dsh', 'storages', 'cost-meter', 'ledger.json')
/** 厂商 key → 人看得懂的名字（key 就是 cost-meter / ledger 里的 provider 前缀）。 */
const VENDOR_NAME = {
  'qwen-token-plan-cn': '阿里 token plan',
  ark: '火山 coding plan',
  'deepseek-account': 'DeepSeek（deepseek-account）',
  'deepseek-official': 'DeepSeek（deepseek-official）',
  qoder: 'Qoder 订阅'
}
/** 载体 → 厂商 key。**只写没有歧义的**：opencode 上同时挂了 coder-b（火山）和
 *  researcher（阿里）、codebuddy 走 `custom-local:` —— 它们的归属要靠每次调用的
 *  `model` 前缀判，不在这里猜。 */
const CARRIER_VENDOR = { pi: 'qwen-token-plan-cn', qoder: 'qoder', qwencode: 'ark' }
/** DSH 自己跑的载体：用量已在 cost-meter 里，**不许**再从班组账本并一次。 */
const DSH_CARRIERS = new Set(['messenger', 'dsh'])
const num = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0 }
const fmtTok = (n) => n >= 1e8 ? `${(n / 1e8).toFixed(2)} 亿` : n >= 1e4 ? `${(n / 1e4).toFixed(1)} 万` : String(n)
const agentOfRole = (role) => crewCfg.roles?.[role]?.agent ?? crewCfg.defaultAgent ?? null
const usageTokens = (u) => {
  if (!u) return 0
  const total = num(u.totalTokens)
  if (total) return total
  return num(u.inputTokens) + num(u.outputTokens) + num(u.cacheReadInputTokens) +
    num(u.cacheCreationInputTokens) + num(u.reasoningTokens)
}

const vendors = new Map()
/* ★ b130（2026-10-18 · 用户：「红框的位置加一个选择日期的，可以选择范围去看 token 用量，起始日期+结束日期」）：
 *   表1 原来只有**全期累计**一个口径。为了能在界面上按日期段看，这里**额外多带一份按天的分项**
 *   `byDay = { 'YYYY-MM-DD': { tokens, calls } }`（**原始数字**，格式化留给界面）。
 *   ⚠️ **口径零变化**：`tokens` / `calls` 仍是全期累计（逐字节等同改动前）；`byDay` 只是**多带一份**，
 *      界面不筛日期时**根本不看它** ⇒ 老行为不受影响。
 *   ⚠️ `byDay` 的日期键＝来源里的那一天：cost-meter 用它的 `days` 键；班组账本用 `c.date`（缺了取 `at` 前 10 位）。 */
function bumpVendor (key, add) {
  if (!key) return
  const v = vendors.get(key) ?? { key, name: VENDOR_NAME[key] ?? key, tokens: 0, calls: 0, days: new Set(), sources: new Set(), byDay: {} }
  v.tokens += add.tokens ?? 0
  v.calls += add.calls ?? 0
  if (add.day) {
    v.days.add(add.day)
    const d = v.byDay[add.day] ?? (v.byDay[add.day] = { tokens: 0, calls: 0 })
    d.tokens += add.tokens ?? 0
    d.calls += add.calls ?? 0
  }
  if (add.source) v.sources.add(add.source)
  vendors.set(key, v)
}

/* ① cost-meter：按厂商/模型分项（DSH 自己这一侧） */
const cm = readJson(CM_LEDGER)
const cmDays = cm?.days && typeof cm.days === 'object' ? cm.days : {}
for (const [day, d] of Object.entries(cmDays)) {
  for (const [pm, v] of Object.entries(d?.byProviderModel ?? {})) {
    const key = String(pm).split(':')[0]
    bumpVendor(key, {
      tokens: num(v.input) + num(v.output) + num(v.cacheRead) + num(v.cacheWrite) + num(v.reasoning),
      calls: num(v.calls),
      day,
      source: 'cost-meter'
    })
  }
}

/* ② 班组账本：非 DSH 载体（按 model 的 provider 前缀归并，跳过 DSH 自己的载体） */
let ledgerSkippedDsh = 0
for (const c of ledgerCalls) {
  const agent = agentOfRole(c.role)
  if (DSH_CARRIERS.has(agent)) { ledgerSkippedDsh++; continue }
  const m = String(c.model ?? '').match(/^([A-Za-z0-9._-]+)[/:](.+)$/)
  const key = m ? m[1] : (CARRIER_VENDOR[agent] ?? (agent ? `载体：${agent}` : null))
  bumpVendor(key, {
    tokens: usageTokens(c.usage),
    calls: 1,
    day: typeof c.date === 'string' ? c.date : String(c.at ?? '').slice(0, 10),
    source: '班组账本'
  })
}

/* 产出表1 的行：**三列各自独立判断有无**（有数据的都显示，没有的留 `—`）
 *
 * ★ 2026-10-03 用户改口径（**长期口径，别再退回"每行只填一个"**）：
 *   之前的「优先级降档：额度 > token > 次数，只显示一个」被推翻。
 *   现在 额度 / 调用次数 / token用量 **三列并列**，谁有数据谁显示，互不挤占。
 *   · 额度：只有火山有快照 → 其余厂商该列 `—`；
 *   · 调用次数：cost-meter 的 `byProviderModel[<provider>:<model>].calls` 按 provider 求和
 *     （**全期累计**，与 token 用量同口径；不含"今日"这个第二口径，避免同列两个口径）；
 *   · token 用量：同源求和（含 cacheRead，与班组账本 `usage.totalTokens` 同口径）。
 */
const providers = []
for (const v of vendors.values()) {
  const qp = quotaByVendor.get(v.key)
  const days = v.days.size
  const sources = [...v.sources].join(' + ')
  const why = []
  if (!qp) why.push(`额度：本机没有 ${v.name} 的额度快照（只有火山 coding-plan 一家有）`)
  if (v.tokens <= 0) why.push('token 用量：cost-meter 与班组账本里都没有它的分项')
  if (v.calls <= 0) why.push('调用次数：同上（没有分项就没有次数）')
  // ★ 2026-10-05：额度系统那一侧（权威名 + 钥匙 + 可用状态）
  const qq = _quota.ofProvider ? _quota.ofProvider(v.key) : null
  const keysText = qq && _quota.keysText ? _quota.keysText(qq) : null
  providers.push({
    key: v.key,
    // 名字对齐：**以载体的路由表为准**（`aliyun`），DSH 那边的名字放括号里做对照
    name: qq ? (qq.dshKey ? `${qq.canonical}（${qq.dshKey}）` : qq.canonical) : v.name,
    rawName: v.name,
    canonical: qq?.canonical ?? null,
    quotaKeys: qq?.keys ?? null,
    quotaKeysText: keysText,
    quotaVerdict: qq?.verdict ?? null,
    quotaVerdictText: qq?.verdict ? (_quota.QV[qq.verdict] ?? qq.verdict) : null,
    quota: qp ?? null,
    quotaText: qp ? `剩余：${qp.remainingPercent}%（${qp.periodLabel}）` : null,
    calls: v.calls,
    callsText: v.calls > 0 ? `${v.calls}` : null,
    tokens: v.tokens,
    tokensText: v.tokens > 0 ? fmtTok(v.tokens) : null,
    days,
    sources,
    // ★ b130：按天分项（原始数字）—— 界面用它算"日期范围"内的合计；不筛日期时用不到
    byDay: v.byDay,
    detail: [
      qq ? `额度系统口径：权威名 ${qq.canonical}${qq.dshKey ? `（DSH 里叫 ${qq.dshKey}）` : ''} · 钥匙 ${keysText || '（还没配）'}` +
        (qq.baseURL ? ` · 探测地址 ${qq.baseURL}` : ' · **没声明地址 → 无法探测**') : '额度系统里没有这家（不归它管 → 钥匙列留 `—`）',
      qp ? `额度口径 = ${qp.periodLabel}（已用 ${qp.usedPercent}% · ${qp.resetAt ?? '刷新时间未知'} 刷新）` : null,
      `调用次数口径 = 全期累计 ${days || '?'} 天（cost-meter 分项按 provider 求和${sources.includes('班组账本') ? ' + 班组账本次数' : ''}）`,
      `token 口径 = 全期累计 ${days || '?'} 天（含 cacheRead，与班组账本 usage.totalTokens 同口径）`,
      `按天分项：${Object.keys(v.byDay).length} 天（★ b130 起带出，供界面按日期范围看）`,
      `来源：${sources || '无'}`,
      why.length ? `留 — 的原因：${why.join('；')}` : null
    ].filter(Boolean).join(' · ')
  })
}
/* 编制里在用、但**一个数都没有**的厂商也占一行（三列全 `—`，不编数） */
for (const r of roles) {
  const key = CARRIER_VENDOR[r.agent]
  if (!key || vendors.has(key)) continue
  const qq = _quota.ofProvider ? _quota.ofProvider(key) : null
  providers.push({
    key, name: qq ? (qq.dshKey ? `${qq.canonical}（${qq.dshKey}）` : qq.canonical) : (VENDOR_NAME[key] ?? key),
    rawName: VENDOR_NAME[key] ?? key,
    canonical: qq?.canonical ?? null,
    quotaKeys: qq?.keys ?? null,
    quotaKeysText: qq && _quota.keysText ? _quota.keysText(qq) : null,
    quotaVerdict: qq?.verdict ?? null,
    quotaVerdictText: qq?.verdict ? (_quota.QV[qq.verdict] ?? qq.verdict) : null,
    quota: null, quotaText: null,
    calls: 0, callsText: null,
    tokens: 0, tokensText: null,
    days: 0, sources: '',
    byDay: {},                                 // ★ b130：没有用量 ⇒ 按天分项也空（界面筛日期时两列显示 —）
    detail: `载体 ${r.agent}（角色 ${r.role}）目前没有任何用量记录：cost-meter 与班组账本里都没有它的分项；` +
      '额度无快照、token/次数无记录 → 用量两列是「—」' +
      (qq ? `；但额度系统里有它（权威名 ${qq.canonical}，钥匙 ${(_quota.keysText && _quota.keysText(qq)) || '（还没配）'}）` : '')
  })
}
/* ★ 2026-10-05（**用户实测反馈**："我在面板填了 SiliconFlow，为什么看板上没有这个厂商？"）：
 *   表1 的行原来只来自**用量数据**（cost-meter 有过调用的厂商 + 编制里在用的载体厂商）——
 *   于是"**刚在面板配好、但还没被任何角色调用过**"的厂商**在表上看不见** → 用户**无法确认自己配上了没有**。
 *   补：**凡是额度系统里已声明的供应商，即使零用量也占一行**（钥匙列照常显示；用量两列留 `—`，**不编数**）。
 *   标 `declaredOnly` 让前端能提示"还没用过"，排序时沉到有数据的行下面。 */
{
  const have = new Set(providers.map(p => p.canonical ?? p.key))
  for (const canon of Object.keys(_quota.provs ?? {})) {
    if (have.has(canon)) continue
    const qq = _quota.ofProvider ? _quota.ofProvider(canon) : null
    if (!qq) continue
    const keysText = _quota.keysText ? _quota.keysText(qq) : null
    // 没配钥匙、也没地址的家不必占行（表上只留"真配过/声明过"的）
    if (!keysText && !qq.baseURL) continue
    providers.push({
      key: canon,
      name: qq.dshKey ? `${qq.canonical}（${qq.dshKey}）` : qq.canonical,
      rawName: qq.canonical,
      canonical: qq.canonical,
      quotaKeys: qq.keys ?? null,
      quotaKeysText: keysText,
      quotaVerdict: qq.verdict ?? null,
      quotaVerdictText: qq.verdict ? (_quota.QV[qq.verdict] ?? qq.verdict) : null,
      quota: null, quotaText: null,
      calls: 0, callsText: null,
      tokens: 0, tokensText: null,
      days: 0, sources: '',
      byDay: {},                               // ★ b130：同上（零用量 ⇒ 按天分项空）
      declaredOnly: true,
      detail: `**额度系统里已声明**（权威名 ${qq.canonical}${qq.dshKey ? `，DSH 里叫 ${qq.dshKey}` : ''}）` +
        ` · 钥匙 ${keysText || '（还没配）'}` + (qq.baseURL ? ` · 探测地址 ${qq.baseURL}` : ' · **没声明地址 → 无法探测**') +
        ` · 模型 ${(qq.models ?? []).length} 个` +
        ' —— 但 **cost-meter 与班组账本里还没有它的用量记录**（**从没被任何角色调用过**）→ 用量两列留 `—`（**不编数**）'
    })
  }
}

/* ★ 2026-10-12（用户口径："删了就应该不存在了" + 表1 只标一句）：被「删」的家在表1 往往**还有历史用量**，
 *   于是它会以"一堆调用次数"的样子留在表上，看着像还在用。**账不能删**，但要如实标出来。
 *   判据与面板一致：**屏蔽名单里有它 且 一把钥匙都解析不到** ⇒ 已删。 */
try {
  const bl = _quota.loadBlocked ? _quota.loadBlocked() : {}
  for (const p of providers) {
    const canon = p.canonical ?? p.key
    if (!canon || p.deleted) continue
    if ((bl[canon] ?? []).length && !_quota.resolveKey(canon)) p.deleted = true
  }
} catch { /* 标不上就不标，看板照常出 */ }

/* 排序：有额度口径的排最前（信息量最大）→ 有数据的 → **零用量的（declaredOnly）沉底**，其余按 token 用量降序 → 次数降序 → 名字 */
providers.sort((a, b) =>
  (b.quota ? 1 : 0) - (a.quota ? 1 : 0) ||
  (a.declaredOnly ? 1 : 0) - (b.declaredOnly ? 1 : 0) ||
  b.tokens - a.tokens ||
  b.calls - a.calls ||
  String(a.name).localeCompare(String(b.name), 'zh'))

/* ═══ 表2「班组」：**项目 × 角色**（职位 / agent / 当前使用模型 / 状态 + 次数）═════
 *
 * ★ 2026-10-03 用户第 4 处改动（很关键）：**状态必须限定在"某个项目"里**。
 *   用户原话大意："我开两个项目，其中一个停了、另一个还在干，那到底显示的是哪里的状态？"
 *   → 全局把两个项目合成一条"最新事件"根本没法解释，所以这里**按项目分别算**：
 *     ① `crewByProject[]` = 每个项目的「每人一行」状态矩阵（**数据层给全矩阵**）；
 *     ② `currentProject`  = 当前项目标记（`--project` 或 `_crew\当前项目.txt`）；
 *     ③ `brainRow`        = 大脑（**会话级，不属于任何项目**），单独一块、不混进项目行。
 *   呈现层再决定怎么显示。用户已拍板形态③：
 *     · 设了当前项目 → 只显示它（并在表里标明项目名）；
 *     · 没设 → 自动列出**近 N 分钟有活动**的项目（活动 = 有回执，或账本里有属于它的调用）；
 *     · 一个活跃项目都没有 → 显示「无活跃项目」。
 *   兼容三种形态（数据不用改，只改渲染）：
 *     ① 只列活跃项目 → `crewByProject.filter(p => p.recentActivity)`
 *     ② 只显示当前项目 → `crewByProject.find(p => p.isCurrent)`（当前项目保证在列表里）
 *     ③ 二选一 → 看 `currentProject.set`
 *
 * 计数口径（用户允许三选一，这里选**尝试次数**）：
 *   **一次尝试 = 一份派活回执** —— `<项目>\_crew\runs\<stamp>\tasks\<任务>.dispatch.json`
 *   （审核员的在 `...\review\REVIEW-*.dispatch.json`）。回执是编排在派活那一刻写的，
 *   一次尝试恰好一份；`-retry` / `-rescue` 各算一次（它们确实又调了一次模型）。
 *   样例：`workspaces\_演练8\_crew\runs\2026-10-03T05-46-50\review\REVIEW-….dispatch.json`
 *   → `role=reviewer`、`command.agent=codebuddy`、`model=custom-local:kimi-k3`。
 *
 * 状态判据（**逐项目**）：
 *
 *   ★★ 2026-10-07 重写（**用户当场问"审核员为什么还绿着"**）—— 原来**只看时钟**，两个方向都错：
 *     旧口径 = 把「派活回执 mtime ∪ 账本 calls[].at」合成时间线取最新，距今 ≤ N 分钟 → `running`。
 *     问题是**回执写在派活那一刻、账本写在收活那一刻** ⇒ 一条任务**飞行途中一个事件都不落**：
 *       · **假绿灯**：干完之后还会再亮 N 分钟（实测 reviewer 23:43:45 收工，到 23:58:45 才变色；
 *         用户在 23:58 问的就是这个）。
 *       · **假停着**（更严重）：实测 `<示例项目>` **47 次尝试里 21 次（45%）时长超过 15 分钟**，
 *         这些任务平均有 **13.3 分钟**"明明在干却显示停着"，最坏 `T35`（54.5 分钟）误报 **39.5 分钟**。
 *         根因是那段注释里的依据早就过期且**写反了**：它说"`agents.json` 里 `timeoutMin: 20`，
 *         N<20 才不会误判成已停" —— 而 `timeoutMin` 是**无人消费的死字段**（2026-10-09 已标废弃，
 *         见重构总表 §八·S1），`编排.mjs` 的保护超时实为 **90**；且 `N < 超时` 恰恰**会**把长任务误判成已停。
 *
 *   **新口径（唯一权威 = pid 存活）**：
 *     · `running` = **编排登记了"正在跑"且那个子进程 pid 还活着**
 *       （来源：`<项目>\_crew\running\<cardId>.json`，编排在 spawn 成功那一刻写、收活立刻删；
 *        判活要**同时**满足 pid 存活 + 没过该次尝试自己的 `deadlineMs`，后者防 pid 被复用）。
 *       —— 这与面板「▶ 干活/停」按钮、`_lock.mjs` 是**同一套真假标准**（都是 `process.kill(pid,0)`）。
 *     · `error` = 最近 N 分钟内最后一条是**失败调用**（N 只用来判"最近"，不再用来判"在跑"）。
 *     · `idle` = 有记录、但既没在跑、最近也不是失败 → 「停着」。
 *     · `unassigned` = 该项目该角色一条记录都没有。
 *   ⚠️ 账本调用**没有 project 字段**，靠 `envelope` 路径反推（`<项目>\_crew\runs\...`）；
 *      推不出来的记进 `crewMeta.ledgerCallsUnattributed`，**不计入任何项目**（宁缺勿错）。
 *   N = 15 分钟，只服务于上面的 `error` 判定；环境变量 `DSH_BOARD_RUNNING_MIN` 可覆盖。
 *
 * ★ 2026-10-03 用户拍板（第 4 处改动的收口，**长期口径**）：
 *   ① **列项目口径 = 本自然日**（本地 00:00 起）——"今天有过活动的项目"都列出来。
 *      活动 = 该项目 `_crew\runs\` 有回执，**或**账本里有**归属该项目**的调用。
 *      （早先按"近 15 分钟"筛会有一个必然副作用：入选项目一定有人在干，"一个停着一个在干"
 *        两个项目永远没法同时在表里 —— 这正是用户担心的那种多项目场景。改成自然日后天然成立。）
 *      环境变量 `DSH_BOARD_PROJECT_WINDOW_MIN=<分钟>` 可退回"近 N 分钟"口径（默认不用它）。
 *   ② **每个项目下只列"有记录的角色"**：该角色在这个项目里**至少有 1 份回执或 1 条归属它的
 *      账本调用**才列，否则**不列**（不再出现 `停着 · 0 次` 这种空占位行）。
 *      ⚠️ **"有记录"包括失败调用**：合成场景里 coder-b 0 份回执但有 1 条失败账本调用 → `报错`，
 *      它**必须被列出来**（就是靠"有记录"这条进来的）。
 *   ③ 项目本身也是靠"有活动"入选的，所以"一个记录角色都没有"理论上不发生；真出现
 *      （例如回执里的角色不在 `_crew\agents.json` 编制表里）→ **整个项目不列**，
 *      原因记在 `crewMeta.droppedProjects`（组标题下空空如也只会让人以为坏了）。
 */
const RUNS_WINDOW_MIN = Number(process.env.DSH_BOARD_RUNNING_MIN ?? 15)
/** 列项目口径：默认「本自然日」；给了 `DSH_BOARD_PROJECT_WINDOW_MIN` 就退回「近 N 分钟」。 */
const PROJECT_WINDOW_MIN = process.env.DSH_BOARD_PROJECT_WINDOW_MIN
  ? Number(process.env.DSH_BOARD_PROJECT_WINDOW_MIN)
  : null
/** 本自然日的起点（**本地时区 00:00**，不是 UTC —— 用户看的是本地"今天"）。 */
const TODAY_START_MS = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() })()
const PROJECT_SCOPE_LABEL = PROJECT_WINDOW_MIN == null
  ? `本自然日（${new Date(TODAY_START_MS).toLocaleDateString('zh-CN')} 00:00 起）`
  : `近 ${PROJECT_WINDOW_MIN} 分钟`
const STATE_ZH = { running: '干着', idle: '停着', error: '报错', stopped: '未运行', unassigned: '未派活' }
const projNameOf = (p) => String(p).replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop() ?? String(p)
const projKey = (p) => String(p ?? '').replace(/[\\/]+$/, '').toLowerCase()

/** 扫哪些项目：`<ROOT>` 自己 + `workspaces\*` 里有 runs 目录的 + 当前项目（即使还没有 runs）。 */
const RUNS_PROJECTS = [{ project: ROOT, runsRoot: join(ROOT, '_crew', 'runs') }]
try {
  for (const w of readdirSync(join(ROOT, 'workspaces'))) {
    const p = join(ROOT, 'workspaces', w)
    const rr = join(p, '_crew', 'runs')
    if (existsSync(rr)) RUNS_PROJECTS.push({ project: p, runsRoot: rr })
  }
} catch { /* 没有 workspaces 目录就只有 ROOT 那一处 */ }
const curProjectPath = proj ? resolve(proj) : null
if (curProjectPath && !RUNS_PROJECTS.some(x => projKey(x.project) === projKey(curProjectPath))) {
  RUNS_PROJECTS.push({ project: curProjectPath, runsRoot: join(curProjectPath, '_crew', 'runs') })
}
// ★ 2026-10-05：**把"大脑"从"全局最新"纠正为"本项目的会话"** ——
//   这一改同时解决两件事：① 大脑那行不再指错人（原来会被任意最新会话抢走）
//   ② "看板跟随会话"有了可靠依据（目录名 = cwd 编码，精确匹配，不靠猜）。
//   匹配不到 → 保留全局最新，但**标明 scope='global-newest'**（不冒充本项目大脑）。
if (curProjectPath) {
  // ★ 2026-10-05 修：用 `pickBrainSessionIn`（挑**转录文件最大**=干活最多的那个），
  //   不用 `newestSessionIn`（最新）—— 后者会被一次性短会话抢走（实测挑错人，
  //   症状：上下文那格空着 + 大脑模型退回默认值 + 消耗显示 `—`）。
  // ★ 2026-10-10（用户口径 · 与"模型"同一条纪律）：**大脑＝该工作区最近写入的那条会话** ——
  //   在跑就是它；没在跑就是"上一次那条"。**不再按"转录最大 × 最新"的名次和挑**：
  //   实测钉住异次元后板子显示 **79.2%（792K）＋"68 小时前"**，那属于 **10-07 的老会话**，
  //   而当天 19:54 新开的那条（占用 ~5.7%）才是真大脑 —— 老口径就是被"大文件"骗了。
  // ★ 2026-10-11 再收一层：候选**限定在真源名单里**（`workspace.json` 的 `sessionIds` 去归档、去 0KB 空会话），
  //   否则"cwd 相同但归未分组"的旧会话仍会被挑中。
  const wsDir = join(SESS_ROOT, encodeSessionDir(curProjectPath))
  const wsIds = workspaceSessionIds(curProjectPath)
  const cands = []
  try {
    for (const s of readdirSync(wsDir)) {
      const f = join(wsDir, s)
      const ms = sessionMtimeSize(f)
      if (!ms) continue
      const id = String(s).replace(/^session-/, '')
      if (wsIds.ok && !wsIds.ids.includes(id)) continue
      if (ms.size <= 0) continue                                  // 0 KB 空转录不算（侧栏也不显示）
      cands.push({ p: f, m: ms.mtimeMs, size: ms.size, id })
    }
  } catch { /* 目录不存在 */ }
  // ★★ b57（用户报障："大脑这里的看板会话框里面换了会话以后，这个框里面的会话内容没换过去"）——
  //   **病根**：原来只按"**最近写入**"挑 ⇒ 换会话后**旧会话若还在被写**（收尾/心跳）就继续被挑中，
  //   框里一直显示旧内容（前端是每次重画、不追加 ⇒ 不是前端堆积）。
  //   **修法（第 1 点）**：**先问换会话桥"哪条在跑"**（桥的 `list` 每条带 `running`）⇒ 在跑的那条**优先**；
  //   桥不在 / 没数据 ⇒ **完全回落**原来的"最近写入"（行为不变，不引入新依赖）。
  const nz2 = (x) => String(x ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
  const runningIds = new Set()
  try {
    const tk0 = readFileSync(join(HERE, 'secrets', 'swap-token.txt'), 'utf8').trim()
    const r0 = await fetch('http://127.0.0.1:19390/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-dsh-swap-token': tk0 },
      body: JSON.stringify({ op: 'list' }),
      signal: AbortSignal.timeout(2000)
    })
    const j0 = await r0.json()
    for (const it of (j0?.value?.items ?? [])) {
      if (it?.running !== true) continue
      if (it?.cwd && !nz2(it.cwd).endsWith(nz2(curProjectPath))) continue      // 只认本项目在跑的那条
      runningIds.add(String(it.sessionId ?? '').replace(/^session-/, ''))
    }
  } catch { /* 桥不在 ⇒ 空集，回落老口径 */ }
  // 排除被换掉的旧会话（链式：A→B、B→C ⇒ 只留 C）
  try {
    const _hj = JSON.parse(readFileSync(join(curProjectPath, '_crew', '换会话交接.json'), 'utf8').replace(/^\uFEFF/, ''))
    const _old = new Set(((_hj && _hj.records) || []).map((r) => String(r && r.oldSession || '').replace(/^session-/, '')).filter(Boolean))
    if (_old.size) { for (let _i = cands.length - 1; _i >= 0; _i--) if (_old.has(cands[_i].id)) cands.splice(_i, 1) }
  } catch { /* 从没换过会话 ⇒ 这份文件不存在，正常 */ }

  // ★ 2026-10-25（20261025 施工文档 §2.5 真机实测）：**换会话交接里的 oldSession 一律排除**。
  //   为什么不能靠归档表：实测 swapOnce 全程没有归档动作（换前换后 archivedSessionIds 一字未变），
  //   只有侧栏删会话才写归档表 ⇒ 换完一轮，旧会话还在候选里，会被当成大脑（看板显示旧内容）。
  cands.sort((a, b) => (runningIds.has(b.id) - runningIds.has(a.id)) || (b.m - a.m))
  cands.sort((a, b) => (runningIds.has(b.id) - runningIds.has(a.id)) || (b.m - a.m))
  const nw = cands[0] ?? newestSessionIn(wsDir)
  const nwMs = nw ? sessionMtimeSize(nw.p) : null
  const hit = (nw && nwMs)
    ? {
        p: nw.p, m: nw.m, size: nwMs.size,
        id: nw.id ?? String(nw.p).split(/[\\/]/).filter(Boolean).pop().replace(/^session-/, ''),
        n: null,
        pickedBy: (runningIds.has(nw.id) ? '桥报在跑' : ((Date.now() - nw.m) <= 180000 ? '最近写入（在跑）' : '最近写入（停着）')) + (wsIds.ok ? '·名单内' : '·cwd 目录内（真源没这份名单）') + (runningIds.size ? '·桥在跑名单' + runningIds.size + '条' : '')
      }
    : pickBrainSessionIn(wsDir)
  if (hit) {
    const sec = Math.round((Date.now() - hit.m) / 1000)
    // ★ 2026-10-11（用户报障："**状态也不匹配，明明应该是绿灯**"）——**判据换掉**：
    //   老判据＝"转录文件最后写入 < 窗口(10s)"，而**模型思考期间一个事件都不写**
    //   （用户看到 DSH 那边"深度求索中，用时 2分31秒"，面板却报"空闲"）。
    //   新判据＝**最近的轮次标记**（`turn/start` ⇒ 在跑；`turn/end` ⇒ 停着）——
    //   **与面板读取路径（`帧数据.mjs` / `service.mjs`）同一处判据**（`面板\大脑会话.mjs` 的 `turnStateOf`），别处不重写。
    //   看不出（转录里没有轮次标记）才退回老窗口，并把"用的哪条判据"记下来。
    const ts = turnStateOf(hit.p)
    const running = ts.ok ? ts.running : (sec < BRAIN_RUNNING_WINDOW_SEC)
    brain = { found: true, state: running ? 'running' : 'idle', lastWriteSecAgo: sec, model: roster.brain.model,
      sessionPath: hit.p, sessionId: hit.id, scope: 'current-project',
      stateJudge: ts.ok ? '轮次标记（turn/start｜turn/end）' : '退回：转录最后写入窗口',
      stateWhy: ts.why ?? null,
      scopeNote: `本项目会话（目录名 ${encodeSessionDir(curProjectPath)}；按「${hit.pickedBy || '转录最大'}」挑了 ${String(hit.id).slice(0, 8)}，${Math.round((hit.size || 0) / 1024)} KB）` }
  } else if (brain.found) {
    brain.scopeNote = '⚠️ 没匹配到本项目的会话目录 → 退回"全局最新"（这一行可能不是本项目的大脑）'
  }
} else {
  // ★ 2026-10-10（实测事故）：**当前项目未定**时，原来会保留"全局最新写入的那个会话"当大脑 ⇒
  //   新开的异次元无人值守会话读到 **79.2% / 792K（"上下文快满了，赶紧收尾换会话"）**，
  //   而那其实是**另一条会话（工作台那条）**的数字 ⇒ 判断被假数据带偏。
  //   现在：未定就**明确标 undetermined**，并让上下文占用那一格**不给数字**（见下方 ctxTrusted）。
  brain.scope = 'undetermined'
  brain.scopeNote = '⚠️ 当前项目未定（没有 --project、也没有钉住）⇒ 不清楚哪条会话是"大脑"；上下文占用不给数字（避免拿别条会话的数当自己的）'
}

const attempts = []
for (const { project, runsRoot } of RUNS_PROJECTS) {
  let stamps = []
  try { stamps = readdirSync(runsRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { continue }
  for (const stamp of stamps) {
    for (const sub of ['tasks', 'review']) {
      const dir = join(runsRoot, stamp, sub)
      let files = []
      try { files = readdirSync(dir) } catch { continue }
      for (const f of files) {
        if (!f.endsWith('.dispatch.json')) continue
        const p = join(dir, f)
        let at = null
        try { at = statSync(p).mtimeMs } catch { continue }
        const doc = readJson(p)
        attempts.push({
          project,
          role: doc?.role ?? null,
          agent: doc?.command?.agent ?? doc?.agent ?? null,
          model: doc?.model ?? null,
          effort: doc?.reasoningEffort ?? doc?.command?.effort ?? null,
          level: doc?.level ?? null,                     // ★ 2026-10-16 任务分级：派活回执里的级号
          at, atIso: new Date(at).toISOString(), path: p
        })
      }
    }
  }
}

/** 账本调用 → 它属于哪个项目（靠 `envelope` 路径反推；推不出返回 null，不硬塞）。 */
function projectOfCall (c) {
  const m = String(c.envelope ?? '').match(/^(.*?)[\\/]_crew[\\/]runs[\\/]/i)
  return m ? resolve(m[1]) : null
}
const ledgerCallsWithProj = ledgerCalls.map(c => ({ c, project: projectOfCall(c) }))
const ledgerCallsUnattributed = ledgerCallsWithProj.filter(x => !x.project).length

/** 「当前使用模型」列的最终文案：模型 + 思考强度（用户要求形如 `... · 思考 max`）。
 *  没有档位的角色写成 `· 思考 —`（**统一带后缀**，列里不会出现"有时有后缀、有时没有"的参差）。 */
const modelCellText = (model, effort) => `${model ?? '—'} · 思考 ${effort || '—'}`

/** 从模型名里取厂商前缀（`ark/glm-5.3-flash` → `ark`；`custom-local:kimi-k3` → `custom-local`；
 *  没有分隔符的裸名如 `qwen3.8-max` / `DeepSeek-V4-Pro` → null）。表3 的额度档靠它判厂商，
 *  **判不出就不走额度档**（不猜厂商）。 */
function vendorKeyOfModel (model) {
  const m = String(model ?? '').match(/^([A-Za-z0-9._-]+)[/:](.+)$/)
  return m ? m[1] : null
}

/** pid 还活着吗 —— 与 `_lock.mjs` / 面板「▶ 干活/停」同一手法（**这是本项目里"在跑"的唯一真假标准**）。 */
function pidAlive (pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/** 进程表（Windows：先试 wmic，失败退 powershell；**取不到就当空** —— 宁缺勿错）。缓存 30 秒。 */
let _procCache = { at: 0, rows: [] }
function procTable () {
  if (Date.now() - _procCache.at < 30_000) return _procCache.rows
  const tries = [
    'wmic process get ProcessId,CommandLine /format:csv',
    'powershell -NoProfile -Command "Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"'
  ]
  let rows = []
  for (const c of tries) {
    try {
      const out = execSync(c, { encoding: 'utf8', timeout: 8000, windowsHide: true })
      if (c.startsWith('wmic')) {
        for (const line of out.split(/\r?\n/)) {
          const m = /,([0-9]+),?(.*)$/.exec(line.trim())
          if (m && m[2]) rows.push({ pid: Number(m[1]), cmd: m[2] })
        }
      } else {
        const j = JSON.parse(out.trim() || '[]')
        for (const p of (Array.isArray(j) ? j : [j])) if (p && p.CommandLine) rows.push({ pid: Number(p.ProcessId), cmd: String(p.CommandLine) })
      }
      if (rows.length) break
    } catch { /* 换下一种 */ }
  }
  _procCache = { at: Date.now(), rows }
  return rows
}

/**
 * ★ 2026-10-07（用户："为什么看板上没人干活" —— 手动拉起的 Qoder 绕过了编排，账本/running 里都没有它）：
 *   **独立信号：载体进程正在跑**。特征串从 `_crew\agents.json` 的 `agents[*].entry` 反推（**不写死厂商名**）：
 *   取 entry 路径里**最后一个像包名/目录名的片段**（跳过 dist/bundle/bin/lib/src/node_modules 这类通用名）。
 *   拿不到进程表 / 拿不到 agents.json ⇒ 返回空（**宁可显示"停着"，也不凭空亮灯**）。
 */
function liveCarrierProcs (roleAgent) {
  let agents = {}
  try {
    agents = JSON.parse(readFileSync(join(HERE, '..', '_crew', 'agents.json'), 'utf8').replace(/^\uFEFF/, '')).agents ?? {}
  } catch { return new Map() }
  const GENERIC = new Set(['dist', 'bundle', 'bin', 'lib', 'src', 'build', 'out', 'node_modules', 'index.js', 'cli.js', 'main.js'])
  const FRAG_START = '$' + '{'          // 占位符（如 ${AGENTS}）不算特征串
  const fragOf = (entry) => {
    const segs = String(entry ?? '').split(/[\\/]+/).filter(Boolean)
    const cand = segs.filter((x) => !GENERIC.has(x.toLowerCase()) && !x.startsWith(FRAG_START))
    const base = segs[segs.length - 1] ?? ''
    const pkg = cand.length >= 2 ? cand[cand.length - 2] : (cand[cand.length - 1] ?? '')
    return [pkg, GENERIC.has(base.toLowerCase()) ? '' : base].filter((x) => x && x.length > 3)
  }
  const rows = procTable()
  if (!rows.length) return new Map()
  const out = new Map()
  for (const [agentId, def] of Object.entries(agents)) {
    const frags = fragOf(def?.entry)
    if (!frags.length) continue
    const hit = rows.find((p) => frags.some((f) => p.cmd.toLowerCase().includes(f.toLowerCase())))
    if (!hit) continue
    for (const [role, r] of Object.entries(roleAgent)) {
      if (r === agentId) out.set(role, { task: null, childPid: hit.pid, startedAt: null, startedAtMs: null, agent: agentId, cardId: null, manual: true })
    }
  }
  return out
}

/**
 * ★ 2026-10-07 新增：**"谁真的在跑"看 pid，不看时钟**。
 *
 * 数据来自编排在**派活 spawn 成功那一刻**写的 `<项目>\_crew\running\<cardId>.json`（收活立刻删）。
 * 一条记录算"在跑"要**同时**满足：
 *   ① `childPid` 还活着；② 没过它自己的 `deadlineMs`（= 该次尝试的保护超时 + 5 分钟宽限，**防 pid 被复用**）。
 * ⚠️ 为什么必须换成这个：旧口径（时间窗）两个方向都会错，实测见文件头「状态判据」那段。
 * ⚠️ 坏文件/读不到 = **当作没在跑**（宁缺勿错：宁可显示"停着"，也不许凭空亮绿灯）。
 */
function liveRunningIn (project) {
  const dir = join(project, '_crew', 'running')
  const out = new Map()   // role -> {task, childPid, startedAt, agent}
  let files = []
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')) } catch { return out }
  for (const f of files) {
    try {
      const j = JSON.parse(readFileSync(join(dir, f), 'utf8').replace(/^\uFEFF/, ''))
      const pid = Number(j.childPid)
      if (!Number.isFinite(pid) || pid <= 0) continue
      const dl = Number(j.deadlineMs)
      if (Number.isFinite(dl) && dl > 0 && Date.now() > dl) continue      // 过期（防 pid 复用）
      if (!pidAlive(pid)) continue
      // 同一角色若有多条（并发/残留），保留**开始最晚**的那条
      const prev = out.get(j.role)
      if (!prev || Number(j.startedAtMs ?? 0) > Number(prev.startedAtMs ?? 0)) {
        out.set(j.role, { task: j.task ?? null, childPid: pid, startedAt: j.startedAt ?? null, startedAtMs: j.startedAtMs ?? null, agent: j.agent ?? null, cardId: j.cardId ?? null })
      }
    } catch { /* 坏文件忽略（当作没在跑） */ }
  }
  // ★ 2026-10-07（用户："看板上没人干活"）：**补一条独立信号** —— 手动拉起的载体（绕过编排）在
  //   `running\` 里没有记录，但它**确实在干活**。没有这条，看板那盏灯会瞎（用户实测报过）。
  //   口径：**只在账本没有它的时候补**（`out.has(role)` 就不覆盖，编排的记录优先 —— 那条更准，带任务名）。
  try {
    const roleAgent = {}
    try {
      const aj = JSON.parse(readFileSync(join(HERE, '..', '_crew', 'agents.json'), 'utf8').replace(/^\uFEFF/, ''))
      for (const [role, r] of Object.entries(aj.roles ?? {})) roleAgent[role] = r.agent
    } catch { /* 拿不到角色表就不做这一步 */ }
    for (const [role, hit] of liveCarrierProcs(roleAgent)) if (!out.has(role)) out.set(role, hit)
  } catch { /* 拿不到进程表 ⇒ 不补（宁缺勿错） */ }
  return out
}

/**
 * 一个项目里一个角色的状态行。**5 个编制角色永远都在**（花名册固定，用户要"知道这个班组有谁"）。
 * 无记录 → `未派活`（**不是** `停着`：停着意味着"跑过、现在停了"，会被误读；
 * 也**不是** `—`：`—` 专门留给"数据拿不到"，而"0 次"是确定的真实值，必须显示 0）。
 *
 * 同一行里还带**表3 的消耗**（用户新增的第三张表）—— 见下面 `consumption` 的注释。
 */
/** `MM-DD`（展示层用：模型证据的日期）。
 *  ⚠️ **按 ISO/UTC 取**（`toISOString().slice(5,10)`），不是本地日 —— 因为看板的"最近动态"行
 *  也是 `at` 里的 ISO 字样（`...replace('T',' ').slice(5,16)`）。两边**必须同口径**，
 *  否则会出现"动态行写 10-06 19:00、模型小标写 10-07 实跑"这种看着自相矛盾的画面。 */
function dayText (ms) { return new Date(ms).toISOString().slice(5, 10) }

function roleRowInProject (project, r, liveByRole = null) {
  const live = liveByRole?.get?.(r.role) ?? null      // ★ 2026-10-07：真在跑（pid 活），见 liveRunningIn
  const mine = attempts
    .filter(a => projKey(a.project) === projKey(project) && a.role === r.role)
    .sort((a, b) => a.at - b.at)
  const mineCalls = ledgerCallsWithProj
    .filter(x => x.project && projKey(x.project) === projKey(project) && x.c.role === r.role)
  const hasRecords = mine.length > 0 || mineCalls.length > 0      // ★ 失败调用也算"有记录"
  const events = [
    ...mine.map(a => ({ at: a.at, kind: 'attempt' })),
    ...mineCalls.map(x => {
      const t = Date.parse(x.c.at ?? '')
      return Number.isFinite(t) ? { at: t, kind: 'call', error: x.c.isError === true || x.c.ok === false } : null
    }).filter(Boolean)
  ].sort((a, b) => a.at - b.at)
  const last = events.length ? events[events.length - 1] : null
  const fresh = !!(last && (Date.now() - last.at) <= RUNS_WINDOW_MIN * 60000)
  // ★ 2026-10-07：`running` **只认 pid 存活**；时间窗退到只服务 `error`（"最近一次是不是失败"）。
  //   旧写法是 `last && fresh ? (error ? 'error' : 'running') : 'idle'` —— 那句 `'running'`
  //   就是"假绿灯 / 假停着"两个 bug 的出处（详见文件头「状态判据」的实测数据）。
  const state = (!hasRecords && !live)
    ? 'unassigned'
    : live ? 'running'
      : ((last && fresh && last.kind === 'call' && last.error) ? 'error' : 'idle')
  const lastAttempt = mine.length ? mine[mine.length - 1] : null
  /* ★ 2026-10-10（用户口径 A：**显示"上一次实跑的"模型＋日期**；在干活时那就是当前这一跑）
   *
   * 旧写法 `lastAttempt?.model ?? r.model` 的毛病：**只认派活回执**。而"没走派活"的运行
   * （实测：2026-10-09 的 S9 缓存验收三次）**不回执、账本又没记 model** ⇒ 显示会**退到更早一条有记录的回执**
   * —— 实测 coder-b 因此显示了 **10-06** 的值，比它"上一次真跑"（10-09）还老 3 天。
   * 看着像"上一次"，其实是"上一次**有记录**的"。
   *
   * 现在：在**账本调用**与**派活回执**两份证据里，**按时间取最新一条带 model 的**，
   * 并把「来源 ＋ 时间」一起带出去（`modelUsedAt` / `modelEvidence`）；
   * 若最新那次调用根本没记模型，另外给一条 `modelNote` 如实说明（不假装它就是最近一次）。
   */
  const callWithModel = [...mineCalls].reverse().find(x => x.c && x.c.model)
  const attemptAt = lastAttempt?.at ?? null
  const callAtMs = callWithModel ? Date.parse(callWithModel.c.at ?? '') : NaN
  const useCall = !!callWithModel && (!lastAttempt || (Number.isFinite(callAtMs) && callAtMs >= attemptAt))
  const model = (useCall ? callWithModel.c.model : lastAttempt?.model) ?? r.model
  const effort = (useCall ? (callWithModel.c.effort ?? r.effort) : lastAttempt?.effort) ?? r.effort
  const modelAt = useCall ? callAtMs : attemptAt
  const modelEvidence = useCall ? '账本' : (lastAttempt ? '派活回执' : '编制表')
  const lastCallAny = mineCalls.length ? mineCalls[mineCalls.length - 1] : null
  const lastCallAnyMs = lastCallAny ? Date.parse(lastCallAny.c.at ?? '') : NaN
  const modelNote = (Number.isFinite(lastCallAnyMs) && Number.isFinite(modelAt) && lastCallAnyMs > modelAt + 60000 && !lastCallAny.c.model)
    ? `最近一次调用（${dayText(lastCallAnyMs)}）**没记下模型**；上面这个是 ${dayText(modelAt)} 那次实跑的`
    : null

  /* ── 表3「消耗」：**两选一（token 用量 > 调用次数）**，全部限定在本项目里 ──
   *
   * · token 用量 = **本项目内该角色**的 token 合计，来源是**班组账本** `_crew\ledger.json` 的
   *   `calls[].usage`（按 role + 归属项目过滤；`usageTokens` 同 `usage.totalTokens` 口径，含 cacheRead）。
   *   ⚠️ cost-meter 账本**没有 role 维度**（只有 provider:model 与 session），所以职位级 token
   *   **只能**来自班组账本 —— 拿不到就是没有，不拿厂商级数字冒充职位级。
   * · 调用次数 = 该角色在本项目内的**派活回执数**（与表2 的"次数"同口径）；
   *   若它 0 份回执但有账本调用（例如只有失败账本记录），用账本调用数顶上（并注明），不显示误导性的 0。
   * · 额度 = **厂商级**（这个角色用的模型属于哪个厂商）；目前只有火山 `ark` 有可展示数值。
   *   ★ 2026-10-03 用户拍板：**表3 去掉额度档** —— 额度是厂商级、**跟不了项目**，而表3 的意义就是
   *   "跟随项目"。（早先按"额度 > token > 次数"实现过，会让 `ark` 那一行在任何项目都显示厂商级额度、
   *   于是那一行就不跟随项目了 → 用户否掉。）额度只在**表1**保留。
   * · 两者都没有 → `—`（**`—` 只表示"拿不到"**：本项目内该职位既无 token 分项、也无调用记录）。
   */
  const tokens = mineCalls.reduce((sum, x) => sum + usageTokens(x.c.usage), 0)
  // ★ A（2026-10-10）：**回合数**（模型被调了几次）—— 取本项目内该角色的账本 `numTurns` 合计。
  //   `null` 不算 0（五·S6 纪律）：全为 null 就是"这一项没有数"，不显示。
  const turnsArr = mineCalls.map(x => Number(x.c.numTurns)).filter(v => Number.isFinite(v) && v > 0)
  const turns = turnsArr.length ? turnsArr.reduce((a, b) => a + b, 0) : null
  const turnsHint = turns === null ? '' : `；回合数 ${turns}（本项目内该角色的 numTurns 合计，取自载体信封步数）`
  const vendorKey = vendorKeyOfModel(model)
  const quotaOfRole = vendorKey ? quotaByVendor.get(vendorKey) : null
  const callsUsed = mine.length > 0 ? mine.length : mineCalls.length
  /** 厂商额度只作**说明**（写进 detail），不参与表3 的指标选择。 */
  const quotaHint = quotaOfRole
    ? `（该厂商在表1 里有额度：剩余 ${quotaOfRole.remainingPercent}%（${quotaOfRole.periodLabel}）—— 但那是厂商级、跟不了项目，表3 按用户口径不用它）`
    : (vendorKey ? `（厂商 ${VENDOR_NAME[vendorKey] ?? vendorKey} 没有可展示的额度数值）` : '（模型前缀判不出厂商）')
  let consumption
  if (tokens > 0) {
    consumption = {
      metric: 'tokens',
      metricLabel: 'token 用量（本项目）',
      displayText: `${fmtTok(tokens)} tok`,
      detail: `token 口径 = 本项目内该角色的班组账本分项合计（含 cacheRead，与 usage.totalTokens 同口径；` +
        `账本调用 ${mineCalls.length} 次${turnsHint}；额度档已从表3 移除${quotaHint}`
    }
  } else if (callsUsed > 0) {
    consumption = {
      metric: 'calls',
      metricLabel: '调用次数（本项目）',
      displayText: `${callsUsed} 次`,
      detail: `调用口径 = 本项目内该角色的派活回执数` + (mine.length === 0 ? `（0 份回执，用归属本项目的账本调用 ${mineCalls.length} 次顶上）` : '') +
        `；该角色在本项目没有 token 分项${turnsHint}；额度档已从表3 移除${quotaHint}`
    }
  } else {
    consumption = {
      metric: 'none',
      metricLabel: '（token 与调用次数都没有）',
      displayText: '—',
      detail: '本项目内该角色没有 token 分项、也没有调用记录' + quotaHint + '；表3 不用额度档，所以这里就是「—」'
    }
  }

  return {
    project: projNameOf(project),
    projectPath: project,
    role: r.role,
    agent: r.agent,
    hasRecords,
    model,
    // ★ 2026-10-05：**实际走哪家**（额度兜底可能已把它换到别家）+ 是否被切走过
    actual: (() => { try { return _quota.actualOf ? _quota.actualOf(r.role) : null } catch { return null } })(),
    switchedFrom: (_quota.state?.failover?.roles?.[r.role]?.from) ?? null,
    switchedAt: (_quota.state?.failover?.roles?.[r.role]?.at) ?? null,
    modelText: modelCellText(model, effort) + (Number.isFinite(modelAt) ? ` ｜ ${dayText(modelAt)} 实跑` : '') + (() => {
      try {
        const a = _quota.actualOf ? _quota.actualOf(r.role) : null
        return (a && a.idx > 0) ? ` → **现走 ${a.provider}**` : ''
      } catch { return '' }
    })(),
    effort: effort ?? null,
    // ★ 2026-10-10：**小标**（六格格式统一用）——有实跑就写 `MM-DD 实跑`，从没跑过就写 `未跑过`。
    modelBadge: Number.isFinite(modelAt) ? `${dayText(modelAt)} 实跑` : '未跑过',
    // ★ 2026-10-10（口径 A）：这两行是"上面那个模型"的**凭据**（哪来的、什么时候的）——
    //   展示层拿它做悬浮说明；`modelNote` 非空时＝"最近一次调用没记模型，别把它当最近一次"。
    modelUsedAt: Number.isFinite(modelAt) ? new Date(modelAt).toISOString() : null,
    modelEvidence,
    modelNote,
    effortSource: effort && useCall ? '最近一次实跑（账本）' : (lastAttempt?.effort ? '最近一次派活' : (r.effort ? 'agents.json' : '无')),
    modelSource: useCall ? '最近一次实跑（账本）' : (lastAttempt?.model ? '最近一次派活回执' : 'agents.json prefer'),
    // ★ 2026-10-16（任务分级 L1–L4，KB 重构\任务分级-施工文档.md §4 规矩 5 / §7-8）：
    //   **级号也要给看板** —— 防"看板显示 max 档、实际跑的是 L1"这种静默过期。
    //   来源优先级：最近一次实跑（账本 calls[].level）> 最近一次派活回执（dispatch 的 level）> null（**不编**）。
    level: (useCall ? (callWithModel?.c?.level ?? null) : null) ?? lastAttempt?.level ?? null,
    levelSource: useCall && callWithModel?.c?.level ? '最近一次实跑（账本）' : (lastAttempt?.level ? '最近一次派活回执（dispatch）' : '（这张卡没标级）'),
    state,
    // ★ 2026-10-07：**真在跑的证据**（pid 存活）—— 机器读的调用方（体检 / 大脑）直接用它，
    //   不必再拿 `state === 'running'` 去猜"它是真在跑还是刚干完"。
    live: live
      ? { task: live.task, cardId: live.cardId, childPid: live.childPid, startedAt: live.startedAt, agent: live.agent }
      : null,
    stateReason: live
      ? `在跑：编排登记了"正在跑"，且那个**子进程 pid ${live.childPid} 仍活着**（任务 ${live.task ?? '?'}${live.startedAt ? `，起于 ${live.startedAt}` : ''}）—— 与面板「▶ 干活/停」同一个判据`
      : (!hasRecords
          ? '未派活：本项目里该角色没有任何派活回执，账本里也没有归属本项目的它的调用 → 「未派活 · 0 次」（已扫完本项目全部回执，0 是确定值，不是拿不到）'
          : (last
              ? `${STATE_ZH[state]}：没有存活的子进程（登记已删或 pid 已退出）→ **不在跑**；本项目最新事件 ${new Date(last.at).toISOString()}（${last.kind === 'attempt' ? '派活回执' : '账本回执'}）`
              : '停着：有记录但时间读不出来（兜底分支）')),
    attempts: mine.length,
    ledgerCalls: mineCalls.length,
    // ★ A（2026-10-10）：本项目内该角色的回合数合计（取不到＝null）；面板可直接用
    turns,
    // 次数口径统一是「派活回执数」（一次尝试 = 一份回执）；若某角色只有账本记录没有回执，
    // 单独说明一句，免得「报错 · 0 次」看着自相矛盾（0 是回执数，报错来自那条账本回执）。
    countNote: (mine.length === 0 && mineCalls.length > 0)
      ? `次数口径 = 派活回执数（0）；另有归属本项目的账本调用 ${mineCalls.length} 次 —— 「${STATE_ZH[state]}」就是它来的`
      : null,
    // ↓ 表3 用
    tokens,
    vendorKey: vendorKey ?? null,
    vendorName: vendorKey ? (VENDOR_NAME[vendorKey] ?? vendorKey) : null,
    consumption,
    lastAttemptAt: lastAttempt?.atIso ?? null,
    roundsText: `${STATE_ZH[state]} · ${mine.length} 次`
  }
}

const crewByProject = RUNS_PROJECTS.map(({ project, runsRoot }) => {
  const mine = attempts.filter(a => projKey(a.project) === projKey(project))
  const calls = ledgerCallsWithProj.filter(x => x.project && projKey(x.project) === projKey(project))
  const projHasRecords = mine.length > 0 || calls.length > 0
  const times = [
    ...mine.map(a => a.at),
    ...calls.map(x => Date.parse(x.c?.at ?? '')).filter(Number.isFinite)
  ]
  const lastAt = times.length ? Math.max(...times) : null
  // 入选口径：默认「本自然日」（本地 00:00 起）；给了 DSH_BOARD_PROJECT_WINDOW_MIN 就是「近 N 分钟」
  const todayActivity = lastAt != null && lastAt >= TODAY_START_MS
  const inWindowActivity = PROJECT_WINDOW_MIN == null
    ? false
    : (lastAt != null && (Date.now() - lastAt) <= PROJECT_WINDOW_MIN * 60000)
  const listed = PROJECT_WINDOW_MIN == null ? todayActivity : inWindowActivity
  // ★ 5 行齐全、顺序 = `_crew\agents.json` 的编制顺序（coder-a、coder-b、reviewer、researcher、rescue），
  //   **绝不按状态或次数重排** —— 花名册要稳定，扫一眼就知道谁在哪。
  //   ★ 2026-10-07：先算出本项目"真在跑"的角色（pid 存活），再逐行判定（见 liveRunningIn）。
  const liveByRole = liveRunningIn(project)
  // ★ 2026-10-07：让"入选"这个标记也**不可能与事实矛盾** —— 有 pid 存活的角色 ⇒ 一定算入选。
  //   ⚠️ 如实说明影响面（**别夸大**）：客户端的表2/表3 显示的是**钉住的那个项目**（`currentProject`），
  //   与 `listed` 无关（见 client.js 的 matchProject 那一段）；`listed/listedFinal` 只用于
  //   ① 本文件的 CLI 日志 ② `crewMeta` 里给出去的信息 ③ 文档 `备用：只列本自然日有活动的项目`
  //   那条筛选配方。所以这条**不是**"修了一个看板看不见项目的 bug"（那不存在），而是把标记本身钉准：
  //   否则会出现"一个角色正在干、而这个项目标着不入选"这种自相矛盾的状态（跨午夜时确实会出现，
  //   因为"本自然日"口径天然会把昨天的活动判为过期）。
  const listedFinal = listed || liveByRole.size > 0
  // 这个标记必须**自洽**：没入选就是 `none`，别在"没入选"时还回一个判据名（那会读成"因今天有活动而入选"）。
  const listedBecause = !listedFinal
    ? 'none'
    : (liveByRole.size > 0
        ? (listed ? 'both' : 'live')
        : (PROJECT_WINDOW_MIN == null ? 'today' : 'window'))
  const rows = roles.map(r => roleRowInProject(project, r, liveByRole))
  return {
    project: projNameOf(project),
    path: project,
    runsRoot,
    isCurrent: !!curProjectPath && projKey(project) === projKey(curProjectPath),
    hasRecords: projHasRecords,
    listed: listedFinal,
    listedBecause,
    todayActivity,
    inWindowActivity,
    // ★ 「是不是项目」的判定依据（客户端拿会话 cwd 来匹配后要用）：
    //   本系统的"项目" = 工作区下有 `_crew\runs` 目录。
    //   靠它能区分两种完全不同的情况：①这个项目还没跑过（仍要列 5 行「未派活 · 0 次」）；
    //   ②这个目录根本不是项目（用户点名的例子：会话工作区 = 工作台根，根下没有 _crew\runs
    //     → 必须提示"当前工作区不是项目"，不许显示 5 行假花名册、也不许回退列全部项目）。
    runsDirExists: existsSync(runsRoot),
    recentActivity: listed,          // 兼容旧字段名（= 上一版口径下是否入选；现在只作信息）
    projectScope: PROJECT_SCOPE_LABEL,
    projectWindowMin: PROJECT_WINDOW_MIN,
    lastEventAt: lastAt == null ? null : new Date(lastAt).toISOString(),
    lastEventSecAgo: lastAt == null ? null : Math.round((Date.now() - lastAt) / 1000),
    attempts: mine.length,
    ledgerCalls: calls.length,
    running: rows.filter(x => x.state === 'running').length,
    errors: rows.filter(x => x.state === 'error').length,
    idle: rows.filter(x => x.state === 'idle').length,
    unassigned: rows.filter(x => x.state === 'unassigned').length,
    roles: rows,
    // ★ 表3「职位消耗」：只把行里已经算好的 `consumption` 投影出来，行序与 `roles` **完全一致**
    //   （花名册固定不重排）。口径 = 本项目；额度那一档是**厂商级**，字段里已标 `metric='quota'`。
    consumption: rows.map(x => ({
      role: x.role,
      metric: x.consumption.metric,
      metricLabel: x.consumption.metricLabel,
      displayText: x.consumption.displayText,
      detail: x.consumption.detail,
      tokens: x.tokens,
      calls: x.attempts > 0 ? x.attempts : x.ledgerCalls,
      vendorKey: x.vendorKey,
      vendorName: x.vendorName
    })),
    consumptionByMetric: {
      tokens: rows.filter(x => x.consumption.metric === 'tokens').length,
      calls: rows.filter(x => x.consumption.metric === 'calls').length,
      none: rows.filter(x => x.consumption.metric === 'none').length
      // 没有 quota 这一档了（用户 2026-10-03 拍板：额度是厂商级、跟不了项目 → 表3 不用）
    },
    note: projHasRecords
      ? `本项目：派活回执 ${mine.length} 份 · 归属本项目的账本调用 ${calls.length} 次 · 5 行编制齐全（未派活的写「未派活 · 0 次」）`
      : `本项目：没有任何派活回执、账本里也没有属于它的调用 → 5 个角色全是「未派活 · 0 次」（它也不会入选，除非设成当前项目）`
  }
})
/** 排序：按**最近活动降序**（在干的项目自然排最前），再按名字。
 *  ⚠️ 只排"项目"这一层；**项目内的 5 行角色绝不重排**（花名册要稳定）。
 *  用户没要求"在干优先"，纯按时间排更可预测；在干的项目活动最新，本来就落最前。 */
crewByProject.sort((a, b) =>
  (b.lastEventAt ? Date.parse(b.lastEventAt) : 0) - (a.lastEventAt ? Date.parse(a.lastEventAt) : 0) ||
  String(a.project).localeCompare(String(b.project), 'zh'))

const currentProject = {
  set: !!curProjectPath,
  path: curProjectPath,
  name: curProjectPath ? projNameOf(curProjectPath) : null,
  source: projSource ?? '未设置（没有 --project，也没有 _crew\\当前项目.txt）',
  note: '呈现层：表2 与表3 共用这一个口径 —— 钉住优先，否则跟随会话工作区',
  // ★ b209：钉住的目录 ≠ 工作台根时，把"钉的是哪个、按什么依据换成了哪个"一并交出去（页面显示、运转链同源）
  pinPath: projPin ?? curProjectPath,
  pinName: projPin ? projNameOf(projPin) : (curProjectPath ? projNameOf(curProjectPath) : null),
  resolvedBy: projLoc?.by ?? (curProjectPath ? 'self' : 'none'),
  noWorkbench: Boolean(projLoc?.noWorkbench),
  evidenceAt: projLoc?.evidenceAt ?? null,
  banner: projLoc?.banner ?? null
}

/* ★ b92（2026-10-16）：**"按下去会不会空转"** —— 面板上「▶ 干活」那块点之前就该知道。
 *
 * 起因（用户贴图问"班组看板这里还有用吗"）：那块按钮是真的（会花额度、会改项目文件），
 * 可当时钉的项目是**工作台自己**、而工作台**没有 TASKS.md** ⇒ 按下去只会空转，**而且没有任何提示**。
 *
 * 口径**只有一处**：`编排.mjs` 自己算"现在能做谁"就是调 `台账.mjs ready --project <p> --json`
 *   （见 `编排.mjs` 的 `readyTasks()`）—— 这里**照调同一条命令**，不另写一套判据。
 * 三种如实回答：① 没有任务单 ⇒ 说明白；② 可开工 N 条 ⇒ 报数（带前几个卡号）；③ 算不出来 ⇒ 说出原因（**不编数字**）。
 */
const work = (() => {
  if (!curProjectPath) return { ok: false, why: '还没钉住项目（在设置里选一个工作区，或写 `_crew\\当前项目.txt`）' }
  const proj = curProjectPath
  const tasksFile = [join(proj, 'TASKS.md'), join(proj, '_crew', 'TASKS.md')].find((f) => existsSync(f)) ?? null
  if (!tasksFile) {
    return {
      ok: true, project: proj, hasTasks: false, readyCount: 0, tasksFile: null,
      why: '这个项目**没有 `TASKS.md` 任务单** ⇒ 按「开始」会空转（编排找不到任何卡），先去设置里换个有任务单的工作区'
    }
  }
  try {
    const r = spawnSync(process.execPath, [join(HERE, '台账.mjs'), 'ready', '--project', proj, '--json'], {
      encoding: 'utf8', timeout: 60000, windowsHide: true
    })
    const raw = String(r.out ?? r.stdout ?? '').replace(/^\uFEFF/, '').trim()
    let ready = null
    try { ready = JSON.parse(raw) } catch { try { ready = JSON.parse(raw.split('\n').pop()) } catch {} }
    if (!Array.isArray(ready)) {
      return { ok: false, project: proj, hasTasks: true, tasksFile, why: '算不出"可开工几条"（台账 ready 的输出读不了：' + (raw.slice(0, 80) || ('exit=' + r.status)) + '）' }
    }
    // 另一半信息：总卡数 / 还没做完几张（解释"0 条"到底是"都干完了"还是"都在等依赖"）
    let total = null; let open = null
    try {
      const m = spawnSync(process.execPath, [join(HERE, '台账.mjs'), 'machine', '--project', proj, '--json'], { encoding: 'utf8', timeout: 60000, windowsHide: true })
      const mj = JSON.parse(String(m.stdout ?? '').replace(/^\uFEFF/, '').trim().split('\n').pop())
      const all = Object.values(mj?.tasks ?? {})
      total = all.length
      open = all.filter((t) => t?.state !== 'done').length
    } catch { /* 拿不到就不说这两个数（绝不编） */ }
    return {
      ok: true, project: proj, hasTasks: true, tasksFile, total, open,
      readyCount: ready.length,
      readyIds: ready.slice(0, 8).map((t) => t?.id ?? t?.task ?? String(t)),
      why: ready.length
        ? `可开工 ${ready.length} 条（依赖都满足、可以马上派活）`
        : (total == null ? '可开工 0 条 ⇒ 按「开始」是**空转**'
          : (open === 0 ? `可开工 0 条 ⇒ 按「开始」是**空转**：${total} 张卡**全做完了**`
            : `可开工 0 条 ⇒ 按「开始」是**空转**：还有 ${open} 张没做完，但它们的依赖还没满足（或状态不是 pending）`)),
      note: '口径只有一处：与 `编排.mjs` 同调 `台账.mjs ready --project <项目> --json`（不另写一套判据）'
    }
  } catch (e) {
    return { ok: false, project: proj, hasTasks: true, tasksFile, why: '算不出来（不影响别的）：' + String(e?.message ?? e) }
  }
})()

/* ═══ 表2 附加一块：**DSH 本体（大脑）** —— 会话级，不属于任何项目 ══════════
 *
 * 用户要求把大脑放进表2，但要**明确标注它的作用域**（别和项目内角色行混淆）。
 *   · agent = `DSH`（本体就是 DSH 会话，不是某个外部载体）；`scope` 标记为 `session`；
 *   · 当前使用模型／思考强度 = 生效 profile 的 `agent-default-model`
 *     （`~\.dsh\profiles\desktop\cordis.patch.yml` → provider/model/reasoningEffort）；
 *   · 状态 = 会话日志写入新鲜度 `brain.state`（`running` = 窗口内有写入 / `idle` = 更久 /
 *     `stopped` = 找不到会话日志）——**与班组角色那套 15 分钟窗口是两个不同信号**，
 *     所以直接用 brain 自己的判据，不套角色窗口、也不按项目算；
 *   · 次数口径 = **本会话调用数**：在 cost-meter 的 `days[*].sessions[]` 里用 `id`
 *     （去掉 `session-` 前缀）匹配大脑会话目录名（`brain.sessionPath` 最后一段）。
 *     实测命中：`85d7a471-…` → `calls`。匹配不到 → `—`（不拿"今日全部 DSH 调用"冒充：
 *     那是所有会话加在一起，跟这一行的身份对不上）。
 */
// ★ 2026-10-05 修：原来**只给 cost-meter 那边去掉了 `session-` 前缀**，这边的目录名还带着前缀
//   → 两边永远不相等 → `brainCalls/brainTokens` 恒 null（所以表3 里既没有大脑、也没有它的消耗）。
//   现在两边都归一。
const brainSessionId = String(brain.sessionPath ?? '').split(/[\\/]/).filter(Boolean).pop()?.replace(/^session-/, '') ?? null

/* ★ 2026-10-05（第 4 条：让"快撑爆"看得见）——**上下文占用率**。
   来源 = DSH **原生**会话投影 `projections.values.contextPressure`（宿主已算好），
   经**换会话桥**的 `list` 只读取回（桥是宿主插件提供的同源通道；token 在 `_unattended\secrets\swap-token.txt`）。
   ★ 2026-10-07：token 文件挪进 `secrets\`（与插件 `bridge-plugin\lib\index.js`、`换新会话.mjs`、
   `进度看护.mjs` **四处同步**；少改一处就 token 分裂 → 全 401）。
   为什么要它：**压缩我们是关着的**（口径：只换会话），所以占用一旦冲到窗口上限会**直接失败**；
   而看板原来完全看不到这个数。桥没跑 / 会话没有占用数据 → 明确写 `—`，**不编数字**。
   ⚠️ 这是**只读**调用，不建会话、不发消息、不花 token。 */
let brainContext = { found: false, note: '换会话桥没在跑（或列表里没有这个会话）→ 拿不到占用率' }
if (brainSessionId) {
  try {
    const tk = readFileSync(join(HERE, 'secrets', 'swap-token.txt'), 'utf8').trim()
    const r = await fetch('http://127.0.0.1:19390/swap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-dsh-swap-token': tk },
      body: JSON.stringify({ op: 'list' }),
      signal: AbortSignal.timeout(2500)
    })
    const j = await r.json()
    const it = (j?.value?.items ?? []).find(x => String(x.sessionId ?? '').replace(/^session-/, '') === brainSessionId)
    const cp = it?.projections?.values?.contextPressure
    const used = cp?.projectedTokens ?? cp?.pressureTokens
    if (cp?.contextWindow && Number.isFinite(used)) {
      const ratio = used / cp.contextWindow
      // ★ b200（用户 2026-10-19 口径）：**门槛只有一份**，取 `换新会话.mjs` 那两个数。
      //   ★ b208（2026-10-20，用户："到底是 75% 换还是 60% 就换，别按字面，去挖"）—— **挖完发现文案是错的**：
      //   `换新会话.mjs` 的真实判据（L539/L540/L577/L582/L595）：
      //     due  = ratio >= 0.60  ⇒ **60% 就已经会换**（不是"开始准备"）；
      //     唯一的闸是"有 coder 在跑" ⇒ 那一轮不换、60s 后下一轮再看（等了就等，干完就换）；
      //     hard = ratio >= 0.75  ⇒ **不再等**（`waitForCoders` 超时从 300s 压到 120s，到点照换）。
      //   所以正确的说法是「60% 起会换（有活先等它干完）／75% 不再等」，不是"60% 起准备 / 75% 该换"。
      //   ⚠️ 它**只着色、不判决**（判决由 `换新会话.mjs` 自己做）；但**文案与颜色必须与那个门槛一致**，
      //   否则看板会给出与真实行为相反的暗示。
      brainContext = {
        found: true, used, window: cp.contextWindow, ratio,
        percent: +(ratio * 100).toFixed(1),
        level: ratio >= 0.75 ? 'danger' : ratio >= 0.60 ? 'warn' : 'ok',
        soft: 0.60, hard: 0.75,
        text: `${(ratio * 100).toFixed(1)}%（${Math.round(used / 1000)}K / ${Math.round(cp.contextWindow / 1000)}K）· 换会话：60% 起就换（有活在跑则先等它干完）／75% 不再等`,
        source: 'DSH 原生会话投影 contextPressure（换会话桥 list · 只读）；门槛与 换新会话.mjs 同一口径'
      }
    } else if (it) {
      brainContext = { found: false, note: '这个会话还没有占用数据（刚建 / 还没发过请求）' }
    }
  } catch (e) {
    brainContext = { found: false, note: '读占用率失败：' + String(e?.message ?? e).slice(0, 80) }
  }
}
let brainCalls = 0
let brainMatched = false            // ★ 跨天合计后不能用 `null` 表示"没匹配到"，另开一个标志
let brainCallsSource = '—（在 cost-meter 的 sessions[] 里没匹配到本会话）'
// ★ 2026-10-05（用户要求"表3 里也要有大脑，也要知道大脑的消耗"）：
//   顺手把**同一个会话行**里的 **token 与费用**也累加起来 —— 原来只取了 `calls`，把 token/cost 白扔了。
//   口径：**与该大脑会话同 id 的 cost-meter 分项跨天合计**（含 cacheRead）；费用取 cost-meter 的 `cost`。
let brainTokens = 0, brainCost = 0
// ★ 2026-10-05（用户要求）：**大脑模型读真身** —— 原来读的是 profile 的 `agent-default-model`（"默认值"），
//   而大脑的模型是**新建会话时在会话框里当场选的**（见 agents.json 的"大脑模型"节）→ 两者会不一致。
//   实测：看板显示 `qwen-token-plan-cn/deepseek-v4.1-flash`，而该会话**实际跑的是 `qwen-token-plan-cn:qwen3.8-max`**。
//   正解：**从 cost-meter 的 `byProviderModel` 取这个会话真正用过的模型**（按调用数最多的那个）。
const brainModelUse = {}          // 'gateway:model' → 调用数
if (brainSessionId) {
  for (const [day, d] of Object.entries(cmDays)) {
    for (const s of (d?.sessions ?? [])) {
      const sid = String(s.id ?? '').replace(/^session-/, '')
      if (sid === brainSessionId) {
        // ★ 2026-10-05 修（实测发现）：这里原来写的是 `brainCalls = num(s.calls)` —— **每天覆盖**，
        //   于是"本会话调用数"只剩**最后一天**（实测显示 315 次，而 10-04 有 142、10-05 有 315，
        //   全期应是 **457**）。token/cost 用的是 `+=`（对的），只有次数用了 `=`。
        //   口径统一成**跨天合计**（与表1 的"全期累计"一致）。
        brainMatched = true
        brainCalls += num(s.calls)
        brainTokens += num(s.input) + num(s.output) + num(s.cacheRead) + num(s.cacheWrite) + num(s.reasoning)
        brainCost += num(s.cost)
        for (const [pm, v] of Object.entries(s.byProviderModel ?? {})) brainModelUse[pm] = (brainModelUse[pm] ?? 0) + num(v.calls)
        brainCallsSource = `本会话调用数（cost-meter sessions[] 跨天合计 · id=${brainSessionId}）`
      }
    }
  }
}
const brainModelActual = Object.entries(brainModelUse).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null
let brainModelActualNote = null
if (brainModelActual) {
  roster.brain.model = brainModelActual            // 覆盖 profile 默认值
  brain.model = brainModelActual
  brain.modelSource = 'cost-meter 实际用量（本会话真用过的模型）'
} else {
  brain.modelSource = 'profile agent-default-model（拿不到本会话实际用量 → 只能显示默认值）'
  brainModelActualNote = '⚠️ 这是 profile 的**默认值**，不一定等于该会话实际用的模型'
}
const brainState = brain.found ? (brain.state ?? 'idle') : 'stopped'
const brainRow = {
  scope: 'session',
  scopeLabel: '会话级 · 不属于任何项目',
  project: null,
  projectPath: null,
  role: '大脑（规划）',
  agent: 'DSH',
  model: roster.brain.model ?? null,
  // ★ 2026-10-05（用户拍板"按你的建议来"）：**模型那一格把口径写在脸上**。
  //   为什么：大脑的模型是"新建会话时当场选的"，而这一格显示的是**本会话调用最多**的那个
  //   （取自 cost-meter；不是"此刻正在用的那个"）。实测过两者不一致的情况（显示 ark、实际 qwen）——
  //   数据没错，但**容易误读**，所以文案前置：拿到实际用量 → `常驻模型：`；只有默认值 → `默认模型（profile）：`。
  // ★ 2026-10-10（用户口径）：**前缀那四个字多余，去掉** —— 六格统一成 `模型:<名字>` ＋（独立小标）。
  //   原来"常驻模型／默认模型（profile）"这个区别，改由 **小标** 承载（`在用` / `默认`），
  //   这样六格的格式才一致、也不用在名字前面挂一长串。
  modelText: modelCellText(roster.brain.model, brainEffort),
  modelBadge: brainModelActual ? '在用' : '默认',
  effort: brainEffort ?? null,
  effortSource: brainEffort ? 'profile agent-default-model' : '无',
  modelSource: brain.modelSource ?? 'profile agent-default-model',
  modelNote: brainModelActual
    ? '口径：本会话**调用最多**的模型（取自 cost-meter 实际用量；**不是**"此刻正在用的那个"，中途可能切过）'
    : (brainModelActualNote ?? '口径：拿不到本会话实际用量 → 显示 profile 默认值，**不一定等于它在用的**'),
  // ★ 2026-10-05（第 4 条）：大脑**上下文占用率**（DSH 原生投影）—— 让"快撑爆"提前看得见
  // ★ 2026-10-10（用户口径："这个上下文也没有"）：**数字要给**，但**必须标明它是谁的** ——
  //   原来两种做法都不可取：① 直接显示（用户会在"会话 A 里看到会话 B 的数字"，实测把新会话吓到"快满了"）
  //   ② 干脆藏起来（结果格子里只剩一个 `—`，用户说"这个上下文也没有"）。
  //   ⇒ 现在：**照给数字**，另带 `contextTrust` 说明来源（本项目会话 / 宿主投影会话 / 无）。
  contextPercent: brainContext.found ? brainContext.percent : null,
  contextUsed: brainContext.found ? brainContext.used : null,
  contextWindow: brainContext.found ? brainContext.window : null,
  contextSoft: brainContext.found ? brainContext.soft : null,
  contextHard: brainContext.found ? brainContext.hard : null,
  contextText: brainContext.found ? brainContext.text : '—',
  contextLevel: brainContext.found ? brainContext.level : null,
  contextTrust: brain.scope === 'current-project' ? 'current-project' : (brainContext.found ? 'host-projection' : 'none'),
  contextNote: brain.scope === 'current-project'
    ? (brainContext.found ? brainContext.source : brainContext.note)
    : (brain.scopeNote || `未定：大脑会话没定位到（scope=${brain.scope}）`),
  state: brainState,
  stateReason: brain.found
    ? `${STATE_ZH[brainState] ?? brainState}：${brain.stateJudge === '轮次标记（turn/start｜turn/end）' ? String(brain.stateWhy ?? '') : '会话日志最后写入 ' + brain.lastWriteSecAgo + 's 前（**退回**老判据，窗口 ' + BRAIN_RUNNING_WINDOW_SEC + 's —— 新判据看不出：' + String(brain.stateWhy ?? '').slice(0, 60) + '）'}`
    : '找不到会话日志（brain.found = false）',
  attempts: brainMatched ? brainCalls : null,   // ⚠️ 与角色那套"派活回执数"不是同一个口径，见上（★ 跨天合计）
  lastAttemptAt: null,
  callsSource: brainCallsSource,
  roundsText: `${STATE_ZH[brainState] ?? brainState} · ${brainMatched ? brainCalls : '—'} 次`,
  // ★ 2026-10-11（大脑会话视图）：把**这条大脑会话的身份证**正经给出来 —— `sessionId` / `sessionPath`。
  //   为什么必须给：面板要读"大脑这格说了什么"，就得知道**读哪一条**；而这条会话的挑选口径
  //   （本项目目录内、真源名单内、最近写入）**只该有一处** —— 就是上面那个 `hit`。
  //   ⚠️ 从前这个 id **只写在 `callsSource` 那句话里**（"…· id=13b6775e-…"）⇒ 面板要拿它就得
  //      **从散文里抠**，正是本项目明令禁止的"读散文取状态"。现在补成正经字段。
  //   取不到就 `null`（如实），**不猜**。
  sessionId: brain.found ? (brain.sessionId ?? null) : null,
  sessionPath: brain.found ? (brain.sessionPath ?? null) : null,
  sessionScope: brain.scope ?? null,
  isBrain: true
}

// ★ 2026-10-05（用户要求"表3 里也要有大脑，也要知道大脑的消耗"）：
//   把**大脑**补进"当前项目"的表3 消耗列。口径写清是**会话级**（与当前项目对应的那个会话），
//   因为它是会话级、不是项目级 —— 同一个会话也可能聊过别的事（诚实标注，别让人当成"纯项目成本"）。
if (brainTokens > 0 || brainMatched) {
  const cur = crewByProject.find(p => p.isCurrent)
  if (cur && Array.isArray(cur.consumption)) {
    cur.consumption.push({
      role: '大脑（规划）',
      isBrain: true,
      scope: 'session',
      metric: brainTokens > 0 ? 'tokens' : 'calls',
      metricLabel: '大脑（本项目对应会话）token 用量 · 含 cacheRead',
      displayText: brainTokens > 0
        ? `${fmtTok(brainTokens)} tok${brainCost > 0 ? ` · $${brainCost.toFixed(2)}` : ''}`
        : `${brainMatched ? brainCalls : 0} 次`,
      detail: `口径：与当前项目对应的大脑会话（id=${brainSessionId ?? '?'}）在 cost-meter 里的分项**跨天合计**（含 cacheRead）；` +
        `费用取 cost-meter 的 cost（provider 有定价时才有）。⚠️ 它是**会话级**、不等于纯项目成本。`
    })
  }
}
brainRow.tokens = brainTokens || null
brainRow.cost = brainCost || null
// ★ A（2026-10-10）：大脑那一行也带回合数（会话级；取不到就不加）
    const brainTurnsArr = ledgerCalls.map(c => Number(c.numTurns)).filter(v => Number.isFinite(v) && v > 0)
    const brainTurns = brainTurnsArr.length ? brainTurnsArr.reduce((a, b) => a + b, 0) : null
    brainRow.consumptionText = brainTokens > 0
      ? `${fmtTok(brainTokens)} tok${brainCost > 0 ? ` · $${brainCost.toFixed(2)}` : ''}${brainTurns !== null ? ` · ${brainTurns} 回合` : ''}`
      : null

/** 向后兼容的**平铺**列表（旧 bundle 只读 `crew[].state`）：大脑行 + 所有项目所有角色行。 */
const crew = [brainRow, ...crewByProject.flatMap(p => p.roles)]

const crewMeta = {
  attemptSource: '派活回执 <项目>\\_crew\\runs\\<stamp>\\{tasks,review}\\*.dispatch.json（一次尝试 = 一份回执）',
  // ★ 2026-10-07：这个数**不再用来判"在跑"**（那已改成 pid 存活）。置 null 是为了让客户端
  //   别再显示页脚那句「状态窗口 15 分钟」——它现在描述的是一个不存在的判据（改了会误导人）。
  //   N 本身还在用，但只服务于 `error`（"最近一次是不是失败调用"），口径见 errorWindowMin。
  runningWindowMin: null,
  errorWindowMin: RUNS_WINDOW_MIN,
  liveSource: 'pid 存活：编排在 spawn 成功那刻写 <项目>\\_crew\\running\\<cardId>.json，收活立刻删；'
    + '算"在跑"要同时满足 ①childPid 活着 ②没过该次尝试自己的 deadlineMs（防 pid 复用）'
    + ' —— 与面板「▶ 干活/停」、_lock.mjs 同一套真假标准',
  projectWindowMin: PROJECT_WINDOW_MIN,          // null = 用「本自然日」口径
  projectScopeLabel: PROJECT_SCOPE_LABEL,
  todayStart: new Date(TODAY_START_MS).toISOString(),
  projectsScanned: RUNS_PROJECTS.map(x => x.project),
  attemptsTotal: attempts.length,
  ledgerCallsTotal: ledgerCalls.length,
  ledgerCallsUnattributed,
  rosterSource: '_crew\\agents.json 的 roles（顺序即表2/表3 的行顺序，**固定不重排**）',
  table3: {
    name: '表3 职位消耗',
    scope: '★ 跟随项目（与表2 同一口径：当前会话工作区 / 钉住的项目）——**不是全局**',
    metricPriority: 'token 用量（本项目） > 调用次数（本项目）（逐行只填一个；metric/metricLabel 显式带在数据里）',
    noQuota: '**表3 不使用额度档**（用户 2026-10-03 拍板）：额度是**厂商级**的、**无法跟随项目**，而表3 的全部意义就是"跟随项目"；额度只在**表1**保留',
    tokensSource: '本项目内该角色的 token 合计 ← 班组账本 _crew\\ledger.json 的 calls[].usage（按 role + 归属项目过滤）；' +
      'cost-meter 账本没有 role 维度，所以职位级 token 只能来自班组账本',
    callsSource: '本项目内该角色的派活回执数（与表2 次数同口径）；0 份回执但有账本调用时用账本调用数顶上并注明',
    dashMeaning: '`—` = 本项目内该职位**既无 token 分项、也无调用记录**（不是"坏了"，是确实没有；不拿厂商级数字填充）',
    brainExcluded: '★ 2026-10-05 更正（用户要求）：**大脑已进表3**（补在当前项目那一列的末尾），标注为「会话级」——' +
      '口径 = 与当前项目对应的那个大脑会话在 cost-meter 里的分项跨天合计（含 cacheRead，附 cost 若 provider 有定价）。' +
      '⚠️ 它是会话级、不等于纯项目成本（同一会话也可能聊过别的事）；早先"不进表3"的规则已作废。' +
      '它的本会话调用数已在表2 那一行给出、阿里分项在表1'
  },
  table1Vs3: '表1 = **厂商级·全期累计**；表3 = **职位级·本项目** —— 两个口径不同，表头都标了 / 页脚也写了',
  projectScoping: '状态**逐项目**算（该项目回执 mtime ∪ 归属该项目的账本 calls[].at），绝不跨项目合并；项目内 5 行编制齐全：无记录的角色写「未派活 · 0 次」（既不是「停着」也不是「—」）',
  displayScope: '★ 当前呈现口径（用户 2026-10-03 定稿）：**跟随当前会话所处的工作区/项目** —— ' +
    '客户端拿 sessionId → useSessions(s => s.byId[sessionId]?.cwd)，再按路径匹配 crewByProject 里的一项；' +
    '`_crew\\当前项目.txt` / `--project` 是**手动钉住**，优先级高于会话工作区。' +
    '（上一版"本自然日列全部项目"已被用户否掉，别退回去；`listed`/`todayActivity` 现在只作信息。）',
  listedFlag: '★ 2026-10-07：`listed` = listedFinal = 「本自然日有过活动」**或**「该项目此刻有 pid 存活的角色」；'
    + '`listedBecause` 说明是哪种（today / window / live / both）。'
    + '⚠️ 它**不影响表2/表3显示哪个项目**（那看 currentProject，见 displayScope），只影响本文件 CLI 日志与下面的备用筛选。',
  shapes: {
    '跟随当前会话工作区 + 手动钉住优先（当前口径）': 'renderer: 先看 currentProject.set，否则用 props.sessionId + useSessions(...).cwd 按路径匹配 crewByProject',
    '备用：只列本自然日有活动的项目': 'renderer: crewByProject.filter(p => p.listed)',
    '备用：只显示钉住的项目': 'renderer: crewByProject.find(p => p.isCurrent)'
  },
  brainRow: {
    role: '大脑（规划）', agent: 'DSH', scope: 'session（不属于任何项目）',
    state: '会话日志新鲜度（brain.state；窗口 ' + BRAIN_RUNNING_WINDOW_SEC + 's）',
    calls: brainCallsSource,
    model: 'profile agent-default-model（provider/model/reasoningEffort）'
  },
  note: '班组角色状态（★ 2026-10-07 改口径）= **running 只认 pid 存活**（编排登记的 childPid 还活着且没过 deadlineMs → 「干着」）；最近 N 分钟内最后一条是失败调用 → error；有记录但不在跑、最近也不失败 → idle（停着）；无任何记录 → unassigned（显示「未派活 · 0 次」）。旧口径「距最近事件 ≤ N 分钟 → running」已废 —— 它**两个方向都错**（干完还亮 N 分钟假绿灯；长任务飞行途中被显示成停着，实测 45% 的尝试超过窗口）。大脑那一行看 brain.state，且不按项目算'
}

/* ── 宿主是否在跑 ──────────────────────────────────────────────────── */
// ★ 2026-10-17：0.2.1 起桌面端端口**每次都可能变**（系统分配）⇒ 现探，不写死。
//   探不到会回 401/200（都算"在跑"），只有连不上才算没起。
const HOST_PORT = hostPortSync()
let listening = false
try {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), 1500)
  const r = await fetch(process.env.DSH_BOARD_HOST ?? hostUrlSync(), { signal: ac.signal })
  clearTimeout(t); listening = r.status < 500
} catch { listening = false }

/**
 * ★ b197（施工文档 §四 M6-5 · C 通道）：**口径违规一格** —— 把收据里的 `policy` 显示出来（红灯）。
 *
 * 为什么要有它（M6-5 的大白话）：写在卡里、违反了**不疼**的规矩等于没有，而且会稀释真规矩的权重。
 *   `policy` 的三条判据（回执里跑全量／没引用门禁结果／工具调用 >25）今天**判决层一个字都不改**
 *   （那是刻意的：改判决会触发额度切换、白烧另一个网关）⇒ 代价只能加在**看得见**（这一格）
 *   与**下一张卡**（`编排.mjs` 的 `policyNoteFor()` ⇒ `派活.mjs --policy-note`）这两处。
 * ⚠️ 只读**最近 3 个 stamp** 的 `verdict.json`（本文件每次刷新都跑；不全库递归扫 68 个 runs 目录）。
 * ⚠️ 读不到就如实返回 `available:false`（**绝不编 0**）。
 */
function policySection () {
  const r = { available: false, hits: [], counts: { overreach: 0, unverified: 0, overBudget: 0 }, scanned: 0, note: null }
  try {
    for (const { project, runsRoot } of RUNS_PROJECTS) {
      let stamps = []
      try { stamps = readdirSync(runsRoot, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().reverse().slice(0, 3) } catch { continue }
      for (const stamp of stamps) {
        const j = readJson(join(runsRoot, stamp, 'verdict.json'))
        if (!j) continue
        r.scanned++
        const push = (x, kind) => {
          if (!x?.policy) return
          r.hits.push({ project, stamp, kind, task: x.task ?? null, role: x.role ?? null, policy: x.policy, action: String(x.action ?? '').slice(0, 160) })
          if (x.policy === 'review-overreach') r.counts.overreach++
          else if (x.policy === 'review-unverified') r.counts.unverified++
          else if (x.policy === 'review-over-budget') r.counts.overBudget++
        }
        for (const x of (j.results ?? [])) push(x, 'task')
        push(j.review, 'review')
      }
    }
    r.available = r.scanned > 0
    r.total = r.counts.overreach + r.counts.unverified + r.counts.overBudget
    r.state = !r.available ? 'unknown' : (r.total > 0 ? 'hit' : 'clean')
    r.note = !r.available
      ? '最近 3 份收据没读到（这个项目还没跑过编排？）'
      : (r.total > 0
        ? `最近 ${r.scanned} 份收据里有 ${r.total} 条口径违规：跑全量 ${r.counts.overreach} · 未引门禁 ${r.counts.unverified} · 超预算 ${r.counts.overBudget}`
        : `最近 ${r.scanned} 份收据：口径违规 0 ✅`)
  } catch (e) { r.note = String(e?.message ?? e).slice(0, 160) }
  return r
}

/* ── 🧭 规矩版本（★ 2026-10-19 b184）：**本进程跑的是不是当前这版 brain.md** ──────────
 * 为什么进看板：宿主在**加载 profile 时**用 `!!js readFileSync(...)` 一次性求值 persona
 *   （实测指纹：23:24:48 启动 → brain.md atime 23:24:50；00:01:11 启动 → atime 00:01:14）。
 *   所以 brain.md 改完不重启 = **改了等于没改**，而这件事**看不出来**
 *   （实测脱节：10-18 00:55 改的版，到 10-18 01:10 还在跑的会话里只有 81.2% 行对上）。
 * 判据（零 token、零子进程）：
 *   ① `brain.md.mtime` 必须早于**本进程启动时间**。启动时间取 `~/.dsh/guardian/startup-issues.json`
 *      的 `checkedAt`（**每次启动写一次**；实测进程 00:01:11 起、它 00:01:13 写），拿不到才退回问进程。
 *   ② "逐会话对上了多少行"由 `规矩版本体检.mjs` 算并落 `_crew\规矩版本.json` —— 这里**只读缓存**，
 *      不让看板去解 10MB 转录（面板每 60 秒重建一次，不能拖住它）。缓存 >24h 当作没有。
 */
function rulesSection () {
  const r = { ok: false, state: 'unknown', brainMd: null, appStart: null, appStartSource: null, cache: null, hint: null }
  const brainMd = join(HERE, 'roles', 'brain.md')
  try {
    if (!existsSync(brainMd)) { r.hint = `找不到 ${brainMd} —— 大脑没有规则源`; return r }    const st = statSync(brainMd)
    const txt = readFileSync(brainMd, 'utf8')
    r.brainMd = { path: brainMd, mtime: new Date(st.mtimeMs).toISOString(), chars: txt.length, lines: txt.split('\n').length }
    const dshHome = process.env.DSH_HOME ?? join(HOME, '.dsh')
    const gi = readJson(join(dshHome, 'guardian', 'startup-issues.json'))
    if (gi && Number.isFinite(gi.checkedAt)) { r.appStart = new Date(gi.checkedAt).toISOString(); r.appStartSource = 'guardian/startup-issues.checkedAt' }
    else {
      try {
        const cmd = "$p = Get-Process -Name @('DeepSeek Harness','DeepSeek','electron') -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1; if ($p) { $p.StartTime.ToFileTimeUtc() }"
        const out = execSync(`powershell.exe -NoProfile -NonInteractive -Command "${cmd}"`, { encoding: 'utf8', windowsHide: true, timeout: 15000 }).trim()
        const ft = Number(out)
        if (Number.isFinite(ft) && ft > 0) { r.appStart = new Date(ft / 10000 - 11644473600000).toISOString(); r.appStartSource = 'Get-Process.StartTime' }
      } catch { /* 问不到就如实报"判不了" */ }
    }
    if (!r.appStart) { r.hint = '拿不到进程启动时间 ⇒ 判不了（逐会话证据见 `规矩版本体检.mjs`）'; return r }
    const startMs = Date.parse(r.appStart)
    if (st.mtimeMs <= startMs + 2000) { r.ok = true; r.state = 'ok'; r.hint = 'brain.md 早于进程启动 ⇒ 本进程加载的就是这一版' }
    else {
      r.state = 'stale'
      r.hint = `brain.md 改在进程启动之后（${new Date(st.mtimeMs).toLocaleString('zh-CN', { hour12: false })} > ${new Date(startMs).toLocaleString('zh-CN', { hour12: false })}）⇒ **重启桌面端才生效**`
    }
  } catch (e) { r.hint = String(e?.message ?? e).slice(0, 160) }
  /* ② 逐会话证据（只读缓存；>24h 视为过期） */
  const c = readJson(join(ROOT, '_crew', '规矩版本.json'))
  if (c && Number.isFinite(c.at)) {
    const ageH = (Date.now() - c.at) / 3600000
    r.cache = ageH <= 24
      ? { at: new Date(c.at).toISOString(), ageHours: +ageH.toFixed(1), newest: c.newest ?? null }
      : { at: new Date(c.at).toISOString(), ageHours: +ageH.toFixed(1), newest: null, stale: true }
  }
  return r
}

// ── ★ 2026-10-23（施工文档 §14）：**每个载体上次用的是什么** ────────────────────────
//
// 目的（用户口径）：遇到「写不动 / 被截断 / 只思考不落盘」时，**3 秒内**能看出
//   这个载体上一次实际用的是**哪个模型（带家）**、**上下文多大**、**最大输出多少** ——
//   而不是去翻 models.json 或猜。
//
// 数据来源（§14.4）：账本 `calls[]` 按 `at` 取每个载体的**最大**一条（它带 ok/stopReason/usage），
//   能力两列查 `_crew\模型能力.json`。
// 排除（§14.3）：大脑（DSH 会话）与 researcher（messenger）**不显示**。
/**
 * 哪些载体上这张表 —— **从 `agents.json` 现推**，不写死名单（全仓规矩：一行里不许并列 ≥2 个载体名）。
 * 口径（施工文档 §14.3）：班组里**除研究员的 messenger** 之外，每个角色用的那个载体都上表；
 *   大脑不在这里（它不是载体，模型在 `roster.brain.model` 已展示）。
 */
function carriersForTable () {
  const skipRoles = new Set(['researcher'])
  const out = []
  for (const [role, v] of Object.entries(crewCfg?.roles ?? {})) {
    if (skipRoles.has(role)) continue
    const a = String(v?.agent ?? '').trim()
    if (!a || a === 'messenger') continue
    if (!out.includes(a)) out.push(a)
  }
  return out
}
/**
 * `custom-local:<模型>` 是 **codebuddy 自己的家名**（路由表里没有这家）⇒ 拿它查能力永远 unknown。
 * 这里按它自己配置里的 `vendor` 字段还原成 `<家>/<模型>`（**证据在盘上**：models.json 的每一条都写着 vendor）。
 * 认不出就原样返回（不猜）。
 */
function realModelKey (model) {
  const m = /^custom-local:(.+)$/.exec(String(model ?? ''))
  if (!m) return model
  try {
    const dir = String(crewCfg?.agents?.codebuddy?.env?.CODEBUDDY_CONFIG_DIR ?? '')
      .replace(/\$\{AGENTS\}/g, resolve(ROOT, '..', 'agents'))
      .replace(/\$\{WORKSPACE\}/g, ROOT)
    const cfg = JSON.parse(readFileSync(join(dir, 'models.json'), 'utf8').replace(/^\uFEFF/, ''))
    const e = (cfg.models ?? []).find(x => String(x.id ?? '') === String(model))
    if (e?.vendor) return `${e.vendor}/${m[1]}`
  } catch { /* 读不到就原样（不猜） */ }
  return model
}
function lastUsedByCarrier () {
  const rows = []
  let calls = []
  try { calls = JSON.parse(readFileSync(join(ROOT, '_crew', 'ledger.json'), 'utf8').replace(/^\uFEFF/, ''))?.calls ?? [] } catch { calls = [] }
  const roleToCarrier = {}
  for (const [r, v] of Object.entries(crewCfg?.roles ?? {})) {
    const a = String(v?.agent ?? '')
    if (a) roleToCarrier[r] = a
  }
  // 没有 carrier 字段 ⇒ 靠 agents.json 的 role→agent 映射（§14.9 风险第 1 条：映射缺失时**不显示**，宁缺不错）
  const byCarrier = new Map()
  for (const c of calls) {
    const carrier = roleToCarrier[String(c.role ?? '')]
    if (!carrier) continue
    const t = Date.parse(c.at ?? '')
    if (!Number.isFinite(t)) continue
    const cur = byCarrier.get(carrier)
    if (!cur || t > cur.t) byCarrier.set(carrier, { t, c })
  }
  for (const carrier of carriersForTable()) {
    const hit = byCarrier.get(carrier)
    if (!hit) { rows.push({ carrier, role: null, model: null, provider: null, modelId: null, at: null, ok: null, stopReason: null, capacity: null, state: 'unused' }); continue }
    const c = hit.c
    const model = String(c.model ?? '') || null
    // 模型名两种分隔符（`a/b` 与 `a:b`）都要认，取最后一段为 modelId（§14.9 风险第 3 条）
    const m = model ? /^([^/:]+)[/:](.+)$/.exec(model) : null
    const provider = m ? m[1] : (model ? '?' : null)
    const modelId = m ? m[2] : model
    let cap = null
    try {
      const cp = model ? capacityOf(realModelKey(model)) : null
      if (cp?.found) cap = { contextWindow: cp.contextWindow, maxOutputTokens: cp.maxOutputTokens, source: cp.source, at: cp.at, stale: cp.stale }
    } catch { cap = null }
    rows.push({
      carrier,
      role: String(c.role ?? '') || null,
      model, provider, modelId,
      at: c.at ?? null,
      ok: c.ok ?? null,
      stopReason: c.stopReason ?? null,
      capacity: cap,
      // 状态（§14.5）：撞顶 / 能力未知 / 正常 / 没用过
      state: c.stopReason === 'length' ? 'ceiling' : (cap ? 'ok' : 'unknown-capacity')
    })
  }
  return { schema: 1, rows }
}

const data = {
  collectedAt: new Date().toISOString(),
  host: { listening, port: HOST_PORT },
  // ★ 2026-10-23（施工文档 §14）：面板「API」页那张「每载体上次使用」表
  lastUsedByCarrier: lastUsedByCarrier(),
  quota,
  ledger: { todayCalls, todayPitfalls, today, speed: SPEED },
  ledgerTask,
  /* ★ b92：面板「▶ 干活」那块点之前要看的数（口径与 `编排.mjs` 同一条命令） */
  work,
  /* ★ 2026-10-18（调研库 S9）：调研库一格 —— **直读真值文件**（不调脚本，看板刷新要快）。
     `drawers/entries/misses/overdue` 全从盘上数；**没有库 ⇒ null**（看板整格不显示，绝不编）。 */
  research: (() => {
    try {
      if (!curProjectPath) return null
      const lib = join(curProjectPath, '文档', '调研')
      if (!existsSync(lib)) return null
      const mat = join(lib, '资料')
      let drawers = 0; let entries = 0
      if (existsSync(mat)) {
        const ds = readdirSync(mat, { withFileTypes: true }).filter(e => e.isDirectory())
        drawers = ds.length
        for (const e of ds) entries += readdirSync(join(mat, e.name)).filter(f => !f.startsWith('_')).length
      }
      let overdue = 0
      const src = join(lib, '来源')
      if (existsSync(src)) {
        for (const f of readdirSync(src).filter(x => x.endsWith('.md'))) {
          for (const line of readFileSync(join(src, f), 'utf8').split(/\r?\n/)) {
            if (!line.startsWith('|')) continue
            const c = line.split('|').slice(1, -1).map(x => x.trim())
            if (c.length < 7 || c[0] === '文件') continue
            if (/^\d{4}-\d{2}-\d{2}$/.test(c[5]) && (Date.now() - new Date(c[5] + 'T00:00:00').getTime()) > 30 * 864e5) overdue++
          }
        }
      }
      let misses = 0
      try { misses = readFileSync(join(curProjectPath, '_crew', '缺料.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).length } catch {}
      return { ok: true, drawers, entries, misses, overdue, line: `调研：${drawers} 屉 / ${entries} 条${misses ? ` · 缺料 ${misses}` : ''}${overdue ? ` · 过期 ${overdue}` : ''}` }
    } catch { return null }
  })(),
  // ★ 2026-10-23（施工文档 D18）：面板「待你处理」下面那一格「🧠 大脑建议（只看不改）」
  // ★ 2026-10-24（施工文档 §11.2 A 改造）：**不再返回 null** —— 原来"没有建议 / 没有变化"就让这格消失，
  //   于是用户看到的是"这块没了"，而不是"它在攒样本"。现在**永远给一个对象**：
  //     · `empty:true` ＝ 还没有建议或没有要改的 ⇒ 页面渲染空态（已攒 X / 20）；
  //     · `params[]` 来自 `参数表.json` + `当前.json`（**没有建议文件时也要能说清哪些参数会真生效**）；
  //     · 每条 item 带 `wired`：`false` ＝ 编排还没读这个参数 ⇒ 页面标「只建议 · 当前不生效」且**不给采纳按钮**。
  advisor: (() => {
    const dir = join(curProjectPath ?? ROOT, '_crew', '调参')
    const readJ = (p) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null } }
    const table = readJ(join(dir, '参数表.json'))
    const current = readJ(join(dir, '当前.json')) ?? {}
    const params = (Array.isArray(table) ? table : []).map(p => ({
      id: p.id, label: p.label ?? p.id, unit: p.unit ?? null,
      now: current[p.id] ?? p.now ?? null,
      wired: p.wired !== false
    }))
    let file = null; let j = null
    try {
      const files = existsSync(dir) ? readdirSync(dir).filter(f => /^建议-.*\.json$/.test(f)).sort().reverse() : []
      if (files.length) { file = join(dir, files[0]); j = readJ(file) }
    } catch { /* 读不到就当没有 */ }
    const fmt = (v) => (v && typeof v === 'object' ? `黄 ${v.yellow} / 红 ${v.red}` : String(v))
    const all = (j && Array.isArray(j.items)) ? j.items : []
    // 有变化的那几条排前面；没变化的也留着（页面用"保持现值"一句话带过）
    const ordered = all.slice().sort((x, y) => Number(y.changed === true) - Number(x.changed === true))
    const items = ordered.slice(0, 5).map(x => ({
      id: x.id, label: x.label, now: x.now, advice: x.advice, unit: x.unit,
      changed: x.changed === true, inRange: x.inRange !== false, wired: x.wired !== false,
      // ★ §11.2 C：**逐参数样本**（每个参数门槛不同，不再是一个统一的 20）
      sampleN: x.sample ?? null, sampleMin: x.sampleMin ?? null, sampleUnit: x.sampleUnit ?? null,
      enough: x.enough !== false,
      text: `${x.label} ${fmt(x.now)} → ${fmt(x.advice)}${x.unit ? ' ' + x.unit : ''}`,
      why: String(x.why ?? '').slice(0, 160),
      canAccept: x.wired !== false && x.inRange !== false && x.changed === true && x.enough !== false
    }))
    return {
      ok: true,
      empty: !j || !items.length,
      at: j?.at ?? null,
      sample: j?.sample ?? null,
      sampleMin: j?.sampleMin ?? 20,
      sampleEnough: j?.sampleEnough !== false,
      // ★ §11.2 A：把样本**拆开**摆出来（本项目收据 vs 全工作台账本）—— 一个数会让人误以为"本项目数据够了"
      sampleCards: j?.sampleProgress?.cards ?? null,
      sampleLedger: j?.sampleProgress?.ledger ?? null,
      // ★ §12.10：样本库（跨项目、跨删除）—— 库里有多少条能进统计
      sampleLib: j?.sampleProgress?.lib ?? null,
      sampleLibMine: j?.sampleProgress?.libMine ?? null,
      file,
      mdFile: file ? file.replace(/\.json$/, '.md') : null,
      items, params,
      more: Math.max(0, all.length - items.length),
      current
    }
  })(),
  /* ★ 2026-10-05：进度看护状态（由**零 token** 的 `进度看护.mjs` 写；看板只读它，出一行）。
     它回答的是"下面的人**写完没 / 还是卡住了**"——这件事不该由大脑反复"查一下"（≈$0.1/次）。 */
  watch: (() => { try { return JSON.parse(readFileSync(join(ROOT, '_crew', '看护状态.json'), 'utf8')) } catch { return null } })(),
  /* ★ 2026-10-16（b91 · 用户拍板"加那两块"）：**直读**两份真值文件，好让看板上的两块"新鲜"——
     `longlive` ＝ 长命资源状态（唯一写方 `长命资源巡检.mjs`）· `swap` ＝ 最近一次换会话（写方 `登记服务.mjs` 的 handover）。
     为什么不从 `watch` 里抄：看护现在**30 分钟才兜底核一次长命资源**（那件要起 PowerShell，实测 0.72 秒），
     从它那儿抄会让"你刚亲眼看着换完会话、板上还写着上一次"。直读 ⇒ 换完 ~1 分钟内就是新的。
     ⚠️ 两份都 fail-soft：读不到就给 `null`，看板/体检据此显示"未核/没数据"（**绝不编**）。 */
  longlive: (() => {
    try {
      const j = JSON.parse(readFileSync(join(ROOT, '_crew', '长命资源状态.json'), 'utf8'))
      const t = Date.parse(j.at ?? '')
      return { ...j, ageMin: Number.isFinite(t) ? Math.round(((Date.now() - t) / 60000) * 10) / 10 : null }
    } catch { return null }
  })(),
  swap: (() => {
    try {
      const H = JSON.parse(readFileSync(join(ROOT, '_crew', '换会话交接.json'), 'utf8'))
      const rec = (H.records ?? []).slice(-1)[0] ?? null
      if (!rec) return null
      const t = Date.parse(rec.at ?? '')
      const w = rec.wrap ?? null
      return {
        at: rec.at, oldSession: rec.oldSession, newSession: rec.newSession,
        took: (rec.took ?? []).map((x) => x.name ?? x), stopped: (rec.stopped ?? []).map((x) => x.name ?? x),
        hasWrap: Boolean(w), wrapOk: w ? Boolean(w.ok) : null, wrapLevel: w?.level ?? null, wrapWhy: w?.why ?? null, wrapFacts: w?.facts ?? null,
        ageMin: Number.isFinite(t) ? Math.round(((Date.now() - t) / 60000) * 10) / 10 : null,
        note: '真值文件 `_crew\\换会话交接.json`（写方＝登记服务.mjs handover）；`hasWrap:false` ＝ b90 之前的记录（当时没核过，不是"没交接"）'
      }
    } catch { return null }
  })(),
  /* ★ 2026-10-05（第 4 条）：大脑**上下文占用率**（`brainContext` 在上面已取，见"换会话桥 list"那节）。
     `found:false` 时看 `note` 为什么不给数（桥没跑 / 没这个会话 / 读失败）——**绝不编数字**。 */
  context: brainContext,
  /* ★ 2026-10-05：**测试（门禁）那一行** —— 用户 2026-10-05 拍板："我看不懂测试输出，只认一行"。
     数据由 `编排.mjs` 的 `runGate()` 每次跑完门禁就写 `<项目>\_crew\gate-status.json`；
     这里只做"读回来 + 兜底"，**绝不自己编一个绿**（读不到就是"还没跑过"）。 */
  gate: (() => {
    try {
      if (!curProjectPath) return null
      const f = join(curProjectPath, '_crew', 'gate-status.json')
      if (!existsSync(f)) return null
      const g = JSON.parse(readFileSync(f, 'utf8'))
      return {
        ok: !!g.ok,
        summaryText: g.summaryText ?? '',
        failures: Array.isArray(g.failures) ? g.failures.slice(0, 3) : [],
        at: g.at ?? null,
        line: g.line ?? (g.ok ? `✅ 全绿（${g.summaryText ?? ''}）` : `❌ 红了（${g.summaryText ?? ''}）`)
      }
    } catch { return null }
  })(),
  /* ★ 2026-10-06（用户第 1/2 条口径）：**"待你处理"清单** —— 环境类（没 key / 账号 / 额度 / 网络）
     与"审核 + 急救也没解决"的条目，由 `编排.mjs` 写进 `<项目>\_crew\halt.json`。
     看板只**原样列出来等人**；读不到就是空（那一块整块不显示，**不编内容**）。 */
  halt: (() => {
    try {
      if (!curProjectPath) return []
      const f = join(curProjectPath, '_crew', 'halt.json')
      if (!existsSync(f)) return []
      // ⚠️ 必须**先剥 BOM**：这份文件可能被 PowerShell 写过（`Set-Content -Encoding UTF8` 会带 BOM），
      //    而 `JSON.parse` 见到 BOM 直接抛 → 被 catch 吞掉 → 红灯整块不显示（实测踩过）。
      const a = JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
      return Array.isArray(a) ? a.slice(-20) : []
    } catch { return [] }
  })(),
  /* ★ 面板的**两张表**（客户端 `lib\client.js` 直接渲染这两个数组） */
  providers,                                   // 表1：模型商（API来源）· 额度 / 调用次数 / token用量（三列各自独立）
  crewByProject,                               // 表2 数据层：每项目每人的状态矩阵（兼容三种呈现形态）
  currentProject,                              // 表2 的"当前项目"标记
  brainRow,                                    // 表2 附加块：大脑（会话级，不属于任何项目）
  crew,                                        // 向后兼容的平铺列表（= brainRow + 所有项目所有角色行）
  crewMeta,
  /* ★ 2026-10-19 b184：规矩版本一格（本进程加载的是不是当前这版 brain.md；红灯=要重启） */
  rules: rulesSection(),
  /* ★ b197（施工文档 §四 M6-5 · C 通道）：**口径违规一格** —— 把收据里的 `policy` 显示成红灯。
   * 为什么：`policy`（回执里跑全量／没引用门禁结果／工具调用超预算）今天**零后果**，
   *   事实本来就写进收据 `verdict.json` 了，**只差没人把它显示出来** ⇒ 用户扫一眼就知道"偶发还是常态化"。
   * ⚠️ 只读**最近 3 个 stamp** 的 verdict.json（本文件每次刷新都跑，不全库递归扫 —— 那份纪律见文件头 L234）。 */
  policy: policySection(),
  /* ★ b197（施工文档 §四 D7）：**规则类红灯 ＋ 看板上直接改** —— 三份规矩文件的现状。
   * 四条要求落地在 `面板\规矩面板.mjs`（备份→写→自检→不过回滚＋diff）；这一格只喂数据。 */
  rulesEdit: (() => { try { return rulesView() } catch (e) { return { available: false, error: String(e?.message ?? e).slice(0, 200) } } })(),
  /* ↓ 以下都是**旧块，保留不动**：客户端可能还在用/排查时要看，删了会连带坏 */
  brain, account, roster,
  scheduler: { tasks: [], note: '看板采集器计划任务未注册（老家遗留，未迁）；本脚本手动/编排触发即可' }
}

/* ★ 2026-10-26（§十「board-data 只是缓存视图」）：缓存必须自报家门 ——
 *   `schema` / `generatedAt` / `sources[]` / `stale` 四样缺一不可，
 *   否则消费方（页面/体检）没法判断"这份数据是什么时候、从哪几个源凑出来的、还能不能信"。
 *   `stale`：只要有**任何一个源**标了 stale，整份缓存就标 stale（不许局部过期还当新）。 */
data.schema = data.schema ?? 1
data.kind = data.kind ?? 'board-data'
data.generatedAt = new Date().toISOString()
// ★ 2026-10-26（修假绿）：**真的去读**七个源**，不许硬编码 `'read'/false`。
//   （上一版这里是写死的，页面接上去就是"文件不在也显示绿"—— 那正是要消灭的假绿。）
const HEALTH = readHealthSources({ project: proj ? resolve(proj) : null })
data.sources = HEALTH.sources.map(s => ({ id: s.id, label: s.label, file: s.file, writer: s.writer, state: s.state, stale: s.stale, at: s.at, why: s.why }))
data.health = { summary: HEALTH.summary, allGreen: HEALTH.allGreen, unknownIds: HEALTH.unknownIds, redIds: HEALTH.redIds, line: describeHealth(HEALTH) }
data.tasksSource = { id: 'tasks', state: ledgerTask.source ?? 'unknown', stale: ledgerTask.stale === true, why: ledgerTask.staleWhy ?? null }
data.sources.push(data.tasksSource)
// ★ 2026-10-26：`stale` 必须由**各源汇总**（有一个源明确过期就整份缓存过期），不许硬编码 false。
//   补回来的原因：上一版把这段连带替换掉了，实测 board-data 里 `stale` 变成 undefined ——
//   页面读到 undefined 既不显示"过期"也不显示"新鲜"，正是最难发现的那类假绿。
data.stale = data.sources.some(s => s.stale === true)
data.source = '看板数据.mjs'

/* ★ 2026-10-26（§十「顶部总览」）：五项一眼看全 —— 交付 / 门禁+E2E / 任务 / 健康 / 契约。
 *   每一盏灯都**来自真源**，缺源 = unknown（**不许显示绿**）。
 *   为什么单独算一遍而不是让页面各查各的：页面那侧一分散，就又会出现"这里绿那里红"。 */
{
  const lamp = (id) => HEALTH.sources.find(s => s.id === id)?.state ?? 'unknown'
  const why = (id) => HEALTH.sources.find(s => s.id === id)?.why ?? null
  const taskLamp = data.tasksSource.state !== 'state-service'
    ? 'unknown'
    : (data.tasksSource.stale ? 'yellow' : 'green')
  const srcOf = (id) => HEALTH.sources.find(s => s.id === id) ?? null
  // 读文件时**跟着健康源给的那个路径**读 —— 不许另算一遍路径（那会两处指向不同文件，出现"灯是绿、旁边写着没有这个文件"）
  const readOf = (id) => { const f = srcOf(id)?.file; return f ? readJsonSafe(f) : null }
  const gateObj = readOf('gate')
  const contract = readOf('contract')
  const e2eStep = Array.isArray(gateObj?.steps) ? gateObj.steps.find(s => s.kind === 'e2e' || /e2e/i.test(String(s.name ?? ''))) : null
  data.overview = {
    schema: 1,
    kind: 'overview',
    at: new Date().toISOString(),
    source: '看板数据.mjs',
    items: [
      { id: 'release', label: '交付', lamp: lamp('release'), text: { green: '已验收', yellow: '待验收', red: '未放行', unknown: '未知' }[lamp('release')] ?? '未知', detail: why('release') ?? '见 release-status.json' },
      { id: 'gate', label: '门禁+E2E', lamp: e2eStep ? lamp('gate') : (gateObj ? 'yellow' : lamp('gate')), text: e2eStep ? `E2E ${e2eStep.ok === false ? '红' : '通过'}` : (gateObj ? '无 E2E 步骤' : '未知'), detail: gateObj ? (gateObj.ok === true ? '门禁通过' : '门禁未过') : (why('gate') ?? '没有 gate-result.json') },
      { id: 'tasks', label: '任务', lamp: taskLamp, text: `${ledgerTask.done ?? 0}/${ledgerTask.total ?? 0} 完成`, detail: data.tasksSource.why ?? (ledgerTask.source === 'state-service' ? '来自 C 状态库' : 'C 状态库读不到') },
      { id: 'health', label: '健康', lamp: (HEALTH.summary.red ? 'red' : (HEALTH.summary.unknown ? 'unknown' : (HEALTH.summary.yellow ? 'yellow' : 'green'))), text: describeHealth(HEALTH).replace('健康：', ''), detail: HEALTH.unknownIds.length ? `未知：${HEALTH.unknownIds.join('、')}` : null },
      { id: 'contract', label: '契约', lamp: contract ? (contract.ok === true ? 'green' : 'red') : 'unknown', text: contract ? `绿 ${contract.counts?.green ?? 0}/红 ${contract.counts?.red ?? 0}/未知 ${contract.counts?.unknown ?? 0}` : '未体检', detail: contract ? null : '还没跑 契约体检.mjs' }
    ],
    allGreen: false
  }
  data.overview.allGreen = data.overview.items.every(i => i.lamp === 'green')
}


/* ★ 2026-10-26（§十「调度条加写域/角色池」）：把 `_调度.planSchedule()` 的结果喂给看板。
 *   这也是阶段 5 那个调度内核**第一个真消费方** —— 没有它，`planSchedule` 就只是"写好了没人用"。
 *   失败口径：算不出来就 `ok:false` + 原因（看板显示"调度：算不出"），**不假装有个计划**。 */
{
  try {
    const { planSchedule, loadPolicy } = await import('./_调度.mjs')
    const ready = (ledgerTask.tasks ?? []).filter(t => t.status === 'ready' || t.status === 'pending')
    const running = (ledgerTask.tasks ?? []).filter(t => t.status === 'doing')
    const policy = loadPolicy(proj ? resolve(proj) : ROOT)
    const plan = planSchedule({ tasks: ready, running, policy })
    data.scheduler = {
      ok: true,
      source: '看板数据.mjs←_调度.planSchedule()',
      policySource: policy.source,
      batches: plan.batches,
      queue: plan.queue,
      stats: plan.stats,
      skipped: plan.skipped.slice(0, 20),
      note: 'wave 只是标签；这里给出的是"能并行的批"与串行原因（写域/载体/资源）'
    }
  } catch (e) {
    data.scheduler = { ok: false, source: '看板数据.mjs←_调度.planSchedule()', why: `算不出调度计划：${String(e?.message ?? e)}`, batches: [], queue: [], stats: null, skipped: [] }
  }
}

mkdirSync(dirname(OUT), { recursive: true })
const tmp = OUT + '.tmp'
writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
renameSync(tmp, OUT)   // 原子替换：面板不会读到写了一半的文件

log(`✅ 看板数据已写：${OUT}`)
log(`   表1 模型商 ${providers.length} 行（三列并列，无则 —）：`)
for (const p of providers) {
  log(`     ${p.name.padEnd(30)} 额度=${(p.quotaText ?? '—').padEnd(20)} 调用=${(p.callsText ?? '—').padEnd(6)} token=${p.tokensText ?? '—'}`)
}
log(`   表2/表3 口径：跟随**当前会话工作区**（抓不到就手动钉住）—— 项目清单扫了 ${crewByProject.length} 个（状态窗口 ${RUNS_WINDOW_MIN} 分钟 / 回执 ${attempts.length} 份）`)
log(`     当前项目：${currentProject.set ? `${currentProject.name}（${currentProject.source}）` : '未设置 → 呈现层用会话工作区匹配'}`)
for (const p of crewByProject) {
  const flag = p.isCurrent ? '★当前' : (p.listed ? '入选' : '不入选')
  log(`     [${flag}] ${p.project.padEnd(10)} 回执=${String(p.attempts).padEnd(3)} 在干=${p.running} 报错=${p.errors} 停着=${p.idle} 未派活=${p.unassigned} 最近活动=${p.lastEventSecAgo == null ? '—' : p.lastEventSecAgo + 's 前'}`)
  if (p.listed || p.isCurrent) {
    for (const c of p.roles) log(`         ${c.role.padEnd(11)} ${String(c.agent).padEnd(10)} ${String(c.modelText).padEnd(52)} ${c.roundsText}`)
    log(`         ── 表3 消耗（本项目，token 用量>调用次数（表3 不用额度档））：` + p.consumption.map(x => `${x.role}=[${x.metric}]${x.displayText}`).join(' · '))
  }
}
log(`     会话级（不属于任何项目）：${brainRow.role} · ${brainRow.agent} · ${brainRow.modelText} · ${brainRow.roundsText}`)
log(`   班组 ${roles.length} 人 · 今日调用 ${todayCalls} · 今日新增坑 ${todayPitfalls}`)
log(`   额度：${quota.ok ? `已用 ${quota.data.usedPercent}%（${quota.data.period}）` : quota.reason}`)
log(`   厂商分项：cost-meter ${Object.keys(cmDays).length} 天 / 班组账本 ${ledgerCalls.length} 次（其中 DSH 自己 ${ledgerSkippedDsh} 次已跳过，避免与 cost-meter 重复计数）`)
log(`   任务账目：${ledgerTask.found ? `${ledgerTask.done}/${ledgerTask.total} 完成` : ledgerTask.reason}`)
log(`   大脑：${brain.found ? `${brain.state}（${brain.lastWriteSecAgo}s 前有动静）` : brain.note} · 账号：${account.ok ? '可用' : account.reasons[0]}`)
log(`   宿主监听：${listening ? '在跑' : '未应答'}`)