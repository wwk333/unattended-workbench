#!/usr/bin/env node
/**
 * 派活（dispatch）—— 无人值守模式 · 第 2 步准备件
 *
 * 干什么：把「任务卡」+「相关坑原文」拼成一份可以直接喂给外部班组的东西，并给出命令行。
 *         规则出处：**任务卡必须带的段落 + 四条护栏写在本脚本里**（`roleTestBlock`）；
 *         人工参考原文在 `_crew\派活模板.md`（★ 2026-10-07 更正：本脚本**并不读**那个文件，
 *         旧注释写"规则唯一出处 = 派活模板.md"是假的 —— 那会让两边各自漂移）。
 *         角色/载体/模型/档位一律现读 `_crew\agents.json`（`_agents-config.mjs` 解析）。
 *
 * 它**不做**什么：不调用班组（不花 token、不花额度）。要真派活由大脑看完收据后再执行打印出的命令。
 *                 这样"拼任务卡"和"真开工"是两件事，不会误派。
 *
 * 用法：
 *   node 派活.mjs --task T12 --role coder-a --goal "实现登录模块" \
 *        --deliverables "src/auth/login.ts;src/auth/types.ts" \
 *        --contract "login(user,pass): Promise<Token>" \
 *        --accept "npm test -- auth 全绿;导出 login" \
 *        --pitfall-keywords "PowerShell,编码,worktree" \
 *        --project "<工作台根>\workspaces\demo" --worktree task-T12
 *
 * 产出（全部落到项目目录的 `_crew\` 下，或 --out 指定）：
 *   _crew\tasks\<TASK>.md          任务卡（含"相关坑"原文段落）
 *   _crew\tasks\<TASK>.prompt.txt  直接喂给班组的任务正文
 *   _crew\tasks\<TASK>.dispatch.json 收据（命令行 / 命中坑 / 角色参数）
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, resolveRole, buildInvocation, levelPresetOf } from './_agents-config.mjs'
import { parseExecAC } from './_验收.mjs'
// ★ 2026-10-23（施工文档 D5）：**卡生成时**的静态验收校验（<50ms、不跑脚本、不调模型）
import { validateAccept, scriptOf } from './_静态AC.mjs'
// ★ 2026-10-23（施工文档 W2 下发 / D14）：模型能力（上下文/最大输出）—— 卡头要让"能力未知"显式可见
import { capacityOf } from './模型能力.mjs'
// ★ 2026-10-19（b192 · 施工文档 §四 D2）：卡片面数条数**必须与全文面共用同一把尺子** ⇒
//   一律走 `_条数体检.mjs`（口径只写死在那一处；**不许在本脚本里再抄一套**，抄了就会漂成两个数）。
import { countRules } from './_条数体检.mjs'
// ★ 2026-10-26（DEVIATIONS D-11 第一步）：把**派活内核的预检**真正接进发卡路径。
//   只接 `preflight`，不动发卡/收活主流程；查的是"库里能确定的事实"：未销 halt + 本卡编码预算。
//   库里读不到就**跳过并说明**（不对基础设施 fail-closed），不当成"检查通过"。
import { preflight } from './_派活内核.mjs'
import { openDb, listTasks, listHalts, budgetUsed as budgetUsedOf, normProject } from './_状态库.mjs'
import { DEFAULT_DB } from './_状态常量.mjs'
import { NODE_BIN as NODE_P, VAULT as VAULT_P } from './_路径.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, '..')

const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
function opt (n, d = null) { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
// 分隔符同时支持 `;` `；` `,` `，`。
// ⚠️ 实测踩过：原来只认 `;`，于是 `--pitfall-keywords "PowerShell,乱码"` 被当成
//    **一个**关键词，找坑永远 0 命中（而收据里看着还挺正常，最容易糊过去的那种错）。
const list = (n) => (opt(n) ?? '').split(/[;；,，]/).map(s => s.trim()).filter(Boolean)

const VAULT = process.env.DSH_PITFALL_VAULT ?? VAULT_P

// ---------------------------------------------------------------- 班组配置（**唯一改的地方：_crew\agents.json**）

// 原来这里硬编码了"Qoder CLI 路径 + 每个角色用哪个模型"。
// 用户明确要求："以后还会增加其他 agent，比如审核我不用 Qoder CLI，你要留口子。"
// → 现在全部读 `_crew\agents.json`：换 agent / 换模型 / 加新 agent 都只改那份 JSON。
const { cfg: AGENTS_CFG, source: AGENTS_SRC, warnings: AGENTS_WARN } = loadConfig()

/** 兼容旧写法：把角色解析成 { model, effort, extra } 供本文件其余部分使用。
 *  ★ 2026-10-16（任务分级）：多一个 `level` —— 有级号时，`resolveRole` 会走**级覆盖层**
 *    （缺级/该级没配模型 ⇒ 当场抛错，**不静默走 prefer**）。 */
function roleParams (roleName, level = null) {
  const res = resolveRole(roleName, AGENTS_CFG, level ? { level } : {})
  const inv = buildInvocation(res, '<PROMPT>', { worktreeName: res.worktree ? `task-<ID>` : null, cwd: '<CWD>' })
  // 从 argv 里去掉 node/entry 与最后的占位 prompt，剩下的就是"角色参数"
  const extra = inv.args.slice(0, -1)
  return { res, model: res.model, effort: res.effort, extra, agentName: res.agentName, level: res.level ?? null, modelSource: res.modelSource }
}
const KNOWN_ROLES = Object.keys(AGENTS_CFG.roles)

// ---------------------------------------------------------------- 找相关坑（零 token，纯本地扫）

const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules'])

function mdFiles (dir, out = []) {
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) mdFiles(join(dir, e.name), out) }
    else if (e.isFile() && /\.md$/i.test(e.name) && !e.name.startsWith('_')) out.push(join(dir, e.name))
  }
  return out
}

/** 按关键词给坑打分：命中文件名 +3、tags +2、正文 +1（出现多次按次数计）。 */
function findPitfalls (keywords) {
  if (!existsSync(VAULT)) return { ok: false, reason: `库根不存在：${VAULT}`, hits: [] }
  const kws = keywords.map(k => k.trim()).filter(Boolean)
  const all = mdFiles(VAULT)
  const hits = []
  for (const f of all) {
    let text = ''
    try { text = readFileSync(f, 'utf8') } catch { continue }
    const name = basename(f)
    let score = 0
    const which = []
    if (kws.length === 0) { score = 0.1 }            // 没给关键词：全都算弱相关，让大脑自己挑
    for (const k of kws) {
      const re = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      const inName = re.test(name) ? 1 : 0
      const n = (text.match(re) ?? []).length
      if (inName) { score += 3; which.push(k + '(文件名)') }
      if (n > 0) { score += 2 + Math.min(n, 3); which.push(k + '×' + n) }
    }
    if (score > 0) {
      const st = statSync(f)
      // ★ 2026-10-05（用户拍板"甲"）：**强 / 弱相关分开** —— 只给"真相关"的配**全文**，其余只列**标题**。
      //   为什么改（实测）：一张任务卡把 **5 条坑全文**塞进去 = **4.0 KB（占卡片 41%）**，
      //   而**任务本身只有 0.5 KB（5%）**；那 5 条里还有 **2 条与任务无关**
      //   （例：任务是"工程初始化"，却嵌了"额度读缓存vs读SDK""压缩和换会话互相抵消"）。
      //   ⇒ 真问题是"**匹配太宽**"（噪音 2.3 KB），不是"卡片太长"。
      //   判据：**强** = 命中文件名 / 命中 ≥2 个不同关键词 / 单关键词在正文出现 ≥3 次；
      //         其余算**弱**（只给标题，载体想要细节自己去读——**不藏**）。
      const kwHit = [...new Set(which.map(w => w.split(/[×(（]/)[0].trim()))].filter(Boolean)
      const inNameHit = which.some(w => w.includes('(文件名)'))
      const bodyHits = which.filter(w => /×/.test(w)).reduce((s, w) => s + Number((w.match(/×(\d+)/) ?? [])[1] ?? 0), 0)
      const strong = inNameHit || kwHit.length >= 2 || bodyHits >= 3
      hits.push({
        file: name, rel: f.slice(VAULT.length + 1).replace(/\\/g, '/'), score, which,
        strong, kwHit, inNameHit, bodyHits,
        bytes: st.size, text: st.size <= 20000 ? text : text.slice(0, 20000),
        // 只取四段正文，喂给班组的原文不要带我的说明
        body: extractSections(text)
      })
    }
  }
  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
  return { ok: true, hits, total: all.length }
}

/** 抽「① 现象 / ② 根因 / ③ 对策 / ④ 证据」四段（取不到就退回全文，但截断）。 */
function extractSections (text) {
  const m = text.match(/##\s*①[\s\S]*?(?=\n##\s|$)/)
  if (!m) return text.split(/\r?\n/).slice(0, 40).join('\n').trim()
  const keep = ['①', '②', '③', '④']
  const out = []
  for (const mark of keep) {
    const re = new RegExp(`##\\s*${mark}[\\s\\S]*?(?=\\n##\\s*[①②③④]|$)`)
    const hit = text.match(re)
    if (hit) out.push(hit[0].trim())
  }
  return out.join('\n\n')
}

// ---------------------------------------------------------------- 组装

const TASK = opt('task')
if (!TASK) {
  console.error('用法见文件头。至少要给 --task <TASK-ID>。')
  process.exit(1)
}

const ROLE = opt('role', 'coder-a')
if (!KNOWN_ROLES.includes(ROLE)) { console.error(`未知角色：${ROLE}（可用：${KNOWN_ROLES.join(' / ')}）—— 可用角色在 _crew\\agents.json 的 roles 里定义`); process.exit(1) }
// ★ 2026-10-16（任务分级 L1–L4）：工单级号 —— **卡片形态 / 门禁 scope / 拉不拉审核员**的唯一来源。
//   口径（KB 重构\任务分级-施工文档.md §4）：工单只写**一个数**（L1–L4），单项覆盖写在 `+` 后面（例 `L3+full`）。
//   没写 ⇒ 一个字都不改（＝今天的行为，天然可关）；写了但那一级没配模型 ⇒ `resolveRole` 当场报错（fail-closed）。
const LEVEL = (() => {
  const raw = opt('level', null)
  if (raw === null || raw === undefined || String(raw).trim() === '') return null
  const m = /^L?([1-4])(?:\+([A-Za-z]+))?$/.exec(String(raw).trim().toUpperCase())
  if (!m) {
    console.error(`[派活] ❌ 级号不合法：--level ${raw}（只认 L1 / L2 / L3 / L4，单项覆盖写在 + 后面，例 L3+full）—— 拒绝出卡`)
    process.exit(1)
  }
  return { key: 'L' + m[1], over: m[2] ? m[2].toLowerCase() : null, raw: String(raw).trim() }
})()
const P = roleParams(ROLE, LEVEL?.key ?? null)
if (AGENTS_WARN.length) for (const w of AGENTS_WARN) console.error(`[派活] ⚠️ agents.json：${w}`)

const PROJECT = resolve(opt('project', WORKSPACE))
const OUTDIR = resolve(opt('out', join(PROJECT, '_crew', 'tasks')))
// ★ 2026-10-26（D11-PREFLIGHT）：发卡前的**机器预检**（唯一判据在 _派活内核.preflight）。
const PREFLIGHT = (() => {
  const checks = []
  let openHalts = []
  let used = 0
  let doneFromDb = []
  try {
    const db = openDb({ dbPath: process.env.DSH_STATE_DB ?? DEFAULT_DB, readonly: true })
    try {
      // ⚠️ 库里 project 的存法**不统一**：`resolve()` 给的是反斜杠，手工/测试常常是正斜杠，
      //   两边大小写也可能不同。只按一种形式查会**查不到自己的 halt**（实测踩到：halt 明明开着，
      //   预检却放行）。所以三种写法都试，取并集；合并预算时按 attemptId 去重。
      // ★ 2026-10-26：还要加上 **normProject()** 的形态（库里的 key 是 `d:/...`：小写盘符 + 正斜杠）。
      //   少了它，`listTasks(db,{project})` 永远查不到 —— 依赖判定就会误报"依赖未完成"。
      const cands = [...new Set([PROJECT, PROJECT.replace(/\\/g, '/'), PROJECT.replace(/\//g, '\\'), normProject(PROJECT)])]
      for (const p of cands) {
        try { openHalts = openHalts.concat(listHalts(db, { project: p, status: 'open' }) ?? []) } catch {}
      }
      const seen = new Set()
      openHalts = openHalts.filter((h) => (seen.has(h.haltId) ? false : (seen.add(h.haltId), true)))
      used = Math.max(0, ...cands.map((p) => { try { return Number(budgetUsedOf(db, { project: p, taskId: TASK })) || 0 } catch { return 0 } }))
      // ★ 2026-10-26 修（真项目 T2 连跑五次都判「依赖未完成：T1」，而 T1 明明已经 done）：
      //   依赖判定靠 `--done`，而**编排从来没传**它 ⇒ 只要卡片有依赖就永远派不出去。
      //   补两层：① 编排开始传 --done；② 这里**没有就自己查库**（派活本来就握着库连接，别指望上游一定记得传）。
      for (const p of cands) {
        try { doneFromDb = doneFromDb.concat(listTasks(db, { project: p, status: 'done' }).map((t) => t.id)) } catch {}
      }
      doneFromDb = [...new Set(doneFromDb)]
    } finally { try { db.close() } catch {} }
    checks.push('halt', 'budget')
  } catch (e) {
    console.error(`[派活] ⚠️ 预检跳过（状态库读不到：${String(e?.message ?? e).slice(0, 80)}）—— 不当成检查通过`)
  }
  if (!checks.length) return { ok: true, skipped: true, checks: [] }
  const rolePool = list('role-pool')
  const r = preflight({
    task: { id: TASK, role: ROLE, rolePool, depends: list('depends'), status: opt('status', null) ?? undefined },
    openHalts,
    budgetUsed: used,
    doneTaskIds: new Set([...list('done'), ...doneFromDb]),
    rolePool
  })
  return { ...r, checks, used }
})()
if (!PREFLIGHT.ok) {
  console.error(`[派活] ❌ 预检不过（${PREFLIGHT.verdict}）：${PREFLIGHT.why} —— **拒绝出卡**`)
  process.exit(9)
}
if (!PREFLIGHT.skipped) console.error(`[派活] ✓ 预检通过（查了 ${PREFLIGHT.checks.join('/')}；本卡已用编码预算 ${PREFLIGHT.used}/6）`)
// ⚠️ 2026-10-02 修：原来只按"角色名以 coder 开头"就给 worktree 名，
//    于是 coder-b（在 agents.json 里 `worktree: false` —— 因为 DSH headless 没有 --worktree）
//    的任务卡仍写着"worktree task-XXX"，而那个目录**根本不存在**。
//    实测后果：coder-b 真跑时发现目录不存在，只能自己按 dispatch 的 cwd 纠正，
//    并在交付报告里专门说明这个差异（它做对了，但**卡片在骗人**，属于"配置与产出不一致"）。
//    现在以 `agents.json` 的 `resolved.worktree` 为准：它说 false，卡片就不写 worktree。
const WORKTREE = opt('worktree', (ROLE.startsWith('coder') && P.res.worktree) ? `task-${TASK}` : null)
const CWD = opt('cwd', PROJECT)
const GOAL = opt('goal', '（未填目标）')
const DELIVERABLES = list('deliverables')
const CONTRACT = list('contract')
const ACCEPT = list('accept')
const WHITELIST = list('files')   // ★ 2026-10-06 止血：审核工单的"改动白名单"（编排把 reviewTask.files 传进来）—— agents.json 护栏①宣称"写死在卡里"，实际从没渲染过，现在补上
const BOUNDARY = list('boundary')
const KEYWORDS_GIVEN = list('pitfall-keywords')

// ★ 2026-10-18（路径猜模块）：**没写 `--module` 时**，从「交付物」路径里找**已存在的**模块文件。
//   规则：按路径段从左到右，取**第一个**与 `roles\modules\<段>.md` 同名的段；
//        所有交付物只猜出**同一个**模块才用；猜不出 ⇒ 不带；猜出多个 ⇒ **不猜**（打 ⚠️ 并记进收据），绝不瞎带。
//   为什么这样够用：台账/编排本来就把 `--deliverables` 递进来（`编排.mjs` pfArgs 里有），
//   所以自动跑也能带模块块，**不用动台账行格式**（那是"一行字不能错"的东西）。
//   只在 L3/L4 生效（与 MODULE 的口径一致）：L1/L2 的卡一个字都不加。
const MODULE_EXPLICIT = opt('module', null)
const MODULE_GUESS = (() => {
  if (MODULE_EXPLICIT) return { state: 'off' }                       // 显式优先，不猜
  if (!(LEVEL && (LEVEL.key === 'L3' || LEVEL.key === 'L4'))) return { state: 'off' }
  let names = []
  try { names = readdirSync(join(HERE, 'roles', 'modules')).filter(f => f.endsWith('.md') && !f.startsWith('_')).map(f => f.slice(0, -3)) } catch { return { state: 'no-dir' } }
  if (!names.length) return { state: 'no-modules' }
  const hits = new Set()
  const from = new Map()
  for (const d of DELIVERABLES) {
    for (const seg of String(d).split(/[\\/]+/)) {
      if (names.includes(seg)) { hits.add(seg); if (!from.has(seg)) from.set(seg, String(d)); break }
    }
  }
  if (hits.size === 0) return { state: 'none' }
  if (hits.size > 1) {
    const list = [...hits]
    console.error(`[派活] ⚠️ 交付物路径对上多个模块（${list.join(' / ')}）⇒ 不猜：本卡**不带**模块块。要带就显式 \`--module <名>\`。`)
    return { state: 'ambiguous', names: list }
  }
  const name = [...hits][0]
  return { state: 'one', name, from: from.get(name) }
})()
const MODULE_RAW = MODULE_EXPLICIT ?? (MODULE_GUESS.state === 'one' ? MODULE_GUESS.name : null)

// ★ 2026-10-18（七 v2 · S2）：**模块边界内联** —— 只在 L3/L4 的卡上、拼在 STABLE 末尾。
//   为什么只 L3/L4：400 字在 L1 的 slim 卡（约 732 字）上是 +55%，在 8–12KB 的大卡上是 +3~5%
//   （依据 `重构总表` §7.2 D1）。为什么放**末尾**：缓存按**前缀**匹配 ⇒ 公共头照旧命中，
//   只有尾巴分叉，不是"裂成 N 条缓存线"（§7.2 D2）。
//   fail-closed：写了 MODULE 但文件不存在 / 超 400 字 / 含 `${` 字面 ⇒ **拒绝出卡**，不许静默当没写。
//   回滚：不写 `--module`、也没有同名模块文件 ⇒ 一个字节都不变（`stableBlock` 与从前逐字节相同）。
const MODULE = (() => {
  const raw = MODULE_RAW
  if (raw === null || raw === undefined || String(raw).trim() === '') return null
  const name = String(raw).trim().replace(/\.md$/i, '')
  if (!/^[^\\/:*?"<>|\s][^"\\/:*?"<>|]*$/.test(name)) {
    console.error(`[派活] ❌ 模块名不合法：--module ${raw}（写模块文件名、不带 .md；不许带路径分隔符/引号）—— 拒绝出卡`)
    process.exit(1)
  }
  const lv = LEVEL?.key ?? null
  if (lv !== 'L3' && lv !== 'L4') {
    console.error(`[派活] ❌ --module ${name} 只能用在本级 **L3/L4** 的卡上（当前级号：${lv ?? '未标级'}）。\n        L1/L2 的卡不带模块块（400 字占小卡一半以上）—— 要么标 L3/L4，要么去掉 --module。`)
    process.exit(1)
  }
  const rel = `roles\\modules\\${name}.md`
  let text
  try { text = readFileSync(join(HERE, 'roles', 'modules', name + '.md'), 'utf8') } catch {
    console.error(`[派活] ❌ 找不到模块说明：${rel} —— 拒绝出卡。\n        照 roles\\modules\\_模板.md 写一份（≤400 字）再来；不想带模块边界就不写 --module。`)
    process.exit(1)
  }
  const body = String(text).trim()
  if (!body) { console.error(`[派活] ❌ 模块说明是空文件：${rel} —— 拒绝出卡`); process.exit(1) }
  if (body.includes('${')) { console.error(`[派活] ❌ 模块说明里不许出现 \`\${...}\` 字面（STABLE 段禁插值）：${rel} —— 拒绝出卡`); process.exit(1) }
  if (body.length > 400) {
    console.error(`[派活] ❌ 模块说明超 400 字（实测 ${body.length} 字）：${rel} —— 拒绝出卡。\n        这里只写"这个模块的边界与专属坑"，通用编程常识不属于这里。`)
    process.exit(1)
  }
  return { name, body, chars: body.length, rel }
})()

/**
 * ★ 2026-10-05 修：**没给坑关键词时，自动从任务本身推** —— 不能再"随便挑 5 条"。
 *
 * 为什么必须修（实测踩到，比"匹配太宽"严重得多）：
 *   `编排.mjs` 只在**它自己被传了** `--pitfall-keywords` 时才往下传；那轮真跑没传
 *   ⇒ 每张卡的 `keywords` 都是 `[]` ⇒ `findPitfalls` 里走 `kws.length === 0` 分支
 *   ⇒ **所有坑同分 0.1**，再按文件名排序取前 5 条 = **等于随便挑**。
 *   实测 T1（任务是"工程初始化"）嵌到的 5 条是 `2026-10-01 别精简…/测试打到别的实例…/多行正文…/
 *   数据源选错…/压缩和换会话…` —— 全是同一天的文件名开头，其中 2 条与任务无关。
 *   ⇒ 所以光"收紧匹配"没用（关键词本来是空的），**得先把关键词补上**。
 *
 * 推导口径（**确定性、零 token、可从收据复核**）：从「交付物路径 + 目标 + 验收」里抠词
 *   —— 交付物按路径段拆（`server/src/modules/account/service.ts` → `account`、`service`），
 *   目标/验收抠英文技术词（`vitest`、`docker`、`jwt`…），去掉通用词，按出现次数取前 8 个。
 */
function autoKeywords () {
  const STOP = new Set(['src', 'app', 'lib', 'dist', 'build', 'node_modules', 'test', 'tests', 'spec', 'specs',
    'index', 'main', 'server', 'client', 'common', 'utils', 'util', 'types', 'type', 'config', 'conf',
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'you', 'not', 'are', 'was', 'has', 'have',
    'ts', 'tsx', 'js', 'mjs', 'cjs', 'json', 'md', 'yml', 'yaml', 'txt', 'lock', 'env', 'example',
    'npm', 'npx', 'run', 'cmd', 'echo', 'http', 'https', 'true', 'false', 'null', 'undefined', 'string', 'number'])
  const bag = new Map()
  const push = (w) => {
    const k = String(w).toLowerCase().replace(/^[^a-z0-9\u4e00-\u9fa5]+|[^a-z0-9\u4e00-\u9fa5]+$/g, '')
    if (k.length < 3 || STOP.has(k)) return
    bag.set(k, (bag.get(k) ?? 0) + 1)
  }
  for (const d of DELIVERABLES) for (const seg of String(d).split(/[\\/]/)) push(seg.replace(/\.[a-z0-9]+$/i, ''))
  for (const s of [GOAL, ...ACCEPT, ...CONTRACT]) {
    for (const m of (String(s).match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) ?? [])) push(m.replace(/[._-]+$/, ''))
  }
  return [...bag.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0])).map(([k]) => k).slice(0, 8)
}
const KEYWORDS = KEYWORDS_GIVEN.length ? KEYWORDS_GIVEN : autoKeywords()
const KEYWORDS_SOURCE = KEYWORDS_GIVEN.length ? '命令行 --pitfall-keywords' : '★ 自动推导（交付物路径 + 目标 + 验收；原来这里是空的 → 会随便挑 5 条）'
const WAVE = opt('wave', null)
// ★ 2026-10-18（调研库 S4）：`--research "词,词"` ⇒ 调 `查调研.mjs`（零 token）取**命中行**，进 **VOLATILE** 段。
//   为什么不进 STABLE：命中行每卡不同，进 STABLE 会把缓存前缀打散（与"五·三段式"正面冲突）。
//   不写 `--research` ⇒ 卡片一个字节都不变（天然可关）。
const RESEARCH = (() => {
  const ws = list('research')
  if (!ws.length) return null
  const r = spawnSync(process.execPath, [join(HERE, '查调研.mjs'), '--project', PROJECT, '--json', '--max', '12', ...ws], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  let j = null
  try { j = JSON.parse(r.stdout) } catch {}
  if (!j) { console.error(`[派活] ⚠️ 查调研 调用失败（本卡不带命中行）：${String(r.stderr || '').trim().slice(0, 200)}`); return { words: ws, total: 0, hits: [], error: true } }
  return { words: ws, total: j.total ?? 0, hits: Array.isArray(j.hits) ? j.hits : [], skip: j.skip || null }
})()

const TRACK = opt('track', null)          // SOP ①：轨道 A/B/C/D/E（头部可见，便于事后追责）

// ★ 2026-10-18（调研库 S6）：**调研卡的白名单自动带 `文档/调研/**`** —— 否则"补资料"那一步会被文件指纹判成越界
//   （白名单为空 ⇒ 越界判定恒为空数组 ⇒ 看着没事，其实是**没在保护**）。只在带了 `--research` 时加，别的一字不变。
if (RESEARCH && !WHITELIST.includes('文档/调研/**')) WHITELIST.push('文档/调研/**')
const DEPENDS = opt('depends', '无')
const REVIEW_QUESTION = opt('review-question', null)   // 审核员专用：多问一句

const pf = findPitfalls(KEYWORDS)
// ★ 2026-10-05（用户拍板"甲"）：**强相关配全文、弱相关只列标题**。
//   `--max-pitfalls` 保留兼容（给了就当"全文条数上限"用）；默认：全文 3 条、标题 8 条。
const MAX_STRONG = Number(opt('max-pitfalls', opt('max-strong', 3)))
const MAX_WEAK = Number(opt('max-weak', 8))
const strongAll = pf.ok ? pf.hits.filter(h => h.strong) : []
const weakAll = pf.ok ? pf.hits.filter(h => !h.strong) : []
const topHits = strongAll.slice(0, MAX_STRONG)          // 全文（兼容旧名：收据里仍叫 embedded）
const weakHits = weakAll.slice(0, MAX_WEAK)             // 只列标题
const droppedStrong = Math.max(0, strongAll.length - topHits.length)

// ---------------------------------------------------------------- 班组须知（现读规则源，不生成副本）
//
// 为什么这么做（用户问"同步器一定需要吗"）：
//   给 coder / 审核员传规则有两条路 —— ① 生成 3 份 AGENTS.md（要手动或定时同步，会漂）
//   ② **每张任务卡现读规则源、内联这一节**（零手动、永不漂）。
//   选 ②。规则源**自 b195 起是 `roles\班组须知.md`**（原来是 `roles\brain.md` 里 CREW-BRIEF 之间那段）。
//   这也是 SOP v3.0 §一"落地方式1：核心≤50行"的正解 —— 任务卡本身就是给外部 agent 的规则载体。
// ★ b195（M6-3 D1）为什么搬出来：这段的**读者是班组**，而 brain.md 是**大脑 persona、每轮请求全文重发**
//   ⇒ 留在 persona 里等于每轮白付 814 token。搬出后**卡一个字不变**（有自证：段逐字节相同）。
function crewBrief () {
  const NEW = join(HERE, 'roles', '班组须知.md')
  const OLD = join(HERE, 'roles', 'brain.md')
  const src = existsSync(NEW) ? NEW : OLD
  if (src === OLD) console.error('[派活] ⚠️ 没找到 roles\\班组须知.md ⇒ **回退**读 brain.md 的旧标记（b195 之前的形态）')
  try {
    const md = readFileSync(src, 'utf8')
    const m = md.match(/<!--\s*CREW-BRIEF:BEGIN\s*-->([\s\S]*?)<!--\s*CREW-BRIEF:END\s*-->/)
    if (!m) return { ok: false, reason: `${src} 里找不到 CREW-BRIEF 标记` }
    // 标记块里前面几行是"给人看的说明"（标题 + 引用注），只取【硬禁止】起的规则正文，
    // 免得把解释也塞进任务卡（实测第一版就是这样，卡片里多了一段废话）。
    const raw = m[1].trim()
    const k = raw.indexOf('【硬禁止】')
    const body = k >= 0 ? raw.slice(k).trim() : raw
    const lines = body.split(/\r?\n/).length
    return { ok: true, body, lines, from: src }
  } catch (e) {
    return { ok: false, reason: String(e?.message ?? e) }
  }
}

const CB = crewBrief()
if (!CB.ok) console.error(`[派活] ⚠️ 班组须知读取失败（卡片会缺规则）：${CB.reason}`)
const crewBriefBlock = CB.ok
  ? `## 👷 班组须知（规则，必须遵守）\n\n${CB.body}\n\n`
  : `## 👷 班组须知（规则，必须遵守）\n\n⚠️ **本节读取失败（${CB.reason}）** —— 先去找大脑确认规则，别猜着干。\n\n`

// ---------------------------------------------------------------- 卡内指纹锚（六·S2 / 做法二·软层）
//
// 干什么：把「交付物」里**现存文件**的 sha256（前 12 位）附在卡尾 —— 干活的人动手前先核对
//   "这文件跟我上次读到的是不是同一份"，把"改到别人刚改过的过期内容"从**事后发现**提前到**动手前**。
// 口径：`roles\brain.md` 的「六·改前拦截」两条硬规矩（改前校验 / 改后自证）的**班组侧落地载体
//   就是这一块** —— 改那边的措辞必须同步这里，反之亦然（与 roleTestBlock 的 S6 双写绑定同款纪律）。
// ⚠️ 五（三段式）落地前先放卡尾（＝本卡独有区）；它落地后随 volatile 内容自然归位。
// 回滚：整块是纯增量；注释掉 anchorBlock 的使用点即回到今天的行为。
function sha256Of (abs) {
  try { return createHash('sha256').update(readFileSync(abs)).digest('hex') } catch { return null }
}
function fileAnchorBlock () {
  const rows = []
  const notes = []
  for (const d of DELIVERABLES) {
    const raw = String(d).trim().replace(/^`+|`+$/g, '')
    if (!raw) continue
    // 解析顺序：先按项目根（台账「交付:」的通行写法），再按工作目录（CWD 相对的写法）
    let abs = resolve(PROJECT, raw)
    if (!existsSync(abs)) abs = resolve(CWD, raw)
    let st = null
    try { st = statSync(abs) } catch {}
    if (!st) { notes.push(`\`${raw}\` ＝ 尚不存在（新建或未找到，无指纹可锚）`); continue }
    if (st.isDirectory()) { notes.push(`\`${raw}\` ＝ 目录（不逐文件铺开）`); continue }
    const h = sha256Of(abs)
    if (!h) { notes.push(`\`${raw}\` ＝ 读不出（无指纹）`); continue }
    const rel = relative(PROJECT, abs).replace(/\\/g, '/')
    rows.push(`- \`${rel}\`　sha256:${h.slice(0, 12)}`)
  }
  if (!rows.length) return '' // 交付物全是新建/没有 → 整块不出（天然可关，行为与今天一致）
  return `【文件指纹锚（本卡独有 · 动手前先核对）】
下面是你「交付物」里**现存文件**的 sha256（前 12 位）：
${rows.join('\n')}
${notes.length ? `（${notes.join('；')}）\n` : ''}**硬规矩（改前）**：动手前先重算你要改的文件的指纹、和上面核一遍 —— **不一致 ＝ 这文件在你上次读过之后被改过：先重读，再动手，别按记忆改**。
**硬规矩（改后）**：交活时回执里**附上你改动文件的当前指纹**；与上面不符的，必须说明为什么。
（工具：MCP \`fingerprint_check\`（挂了就用它）；命令行参考：\`certutil -hashfile "<文件>" SHA256\`）
`
}
const anchorBlock = fileAnchorBlock()

// 「相关坑」段落（★ 2026-10-05 按用户拍板"甲"改写：**强相关配全文、弱相关只列标题、末尾给兜底**）
//   口径：**不藏任何东西** —— 弱相关的坑也以"标题 + 命中理由"出现，载体觉得沾边就自己按路径去读；
//   末尾再点明"全库多少条 + 索引在哪"，避免它误以为"没坑"。
const pitfallBlock = (() => {
  if (!pf.ok) return `⚠️ 坑库读不到（${pf.reason}）—— 本次按"无相关老坑"处理，但**记进台账**（可能意味着库根配错了）。`
  if (!topHits.length && !weakHits.length) {
    return '本次无相关老坑（派活脚本按关键词 [' + (KEYWORDS.join('、') || '空') + '] 扫了 `' + VAULT
      + '`，' + pf.total + ' 篇里 0 命中）。'
  }
  const parts = []
  if (topHits.length) {
    parts.push('### 🎯 强相关（**原文已附** —— 这几条必须读）\n')
    parts.push(topHits.map((h, i) => `── 坑 ${i + 1}：《${h.file}》　（命中：${h.which.join('、')}）\n${h.body}`).join('\n\n'))
  }
  if (weakHits.length) {
    parts.push((parts.length ? '\n' : '') + '### 📎 相关度较低（**只给标题** —— 觉得沾边就自己去读那条）\n')
    parts.push(weakHits.map(h => `─ 《${h.file}》　（命中：${h.which.join('、')}）`).join('\n'))
  }
  if (droppedStrong) parts.push(`\n（另有 ${droppedStrong} 条强相关没展开，避免卡片过长 —— 按下面三跳自己查。）`)
  parts.push(`\n### 🗂 这张卡没列全 —— 没列到**不等于没坑**，按三跳查（用户 2026-10-05 定稿，**所有角色都走这个流程**）
坑库共 **${pf.total}** 篇，本次关键词命中 **${pf.hits.length}** 篇（上面已列 ${topHits.length + weakHits.length} 篇）。

1. **先跑脚本**（0.2 秒、不花钱）—— 用你**报错原文 / 模块名 / 工具名**当关键词：
   \`node ${join(HERE, '查坑.mjs')} "<关键词,关键词>"\`
   命中 → 打开那条坑照它的「③ 对策」做，**别自己硬试**。
2. **没命中就扫索引标题**（一行一条 —— **只扫「现象 + 对策」，不要读正文**）：
   \`${VAULT}\\_索引.md\` —— 看着像的，再打开那一条。
3. **还不像就全库搜你的报错原文**（内容匹配，最全）：
   用 Grep 搜 \`${VAULT}\`，关键词取报错里的 2–3 个词。

⚠️ 第 1 跳是**字面匹配，一定会漏**（措辞不同 / 只回前 N 条 / 没有语义）—— **"查不到"≠"库里没有"**，必须往下走。
⚠️ **前三跳都没有 → 那就是条真新坑**：回执里交 \`pit: 现象 | 根因 | 对策 | 证据（文件:行）\`（**⛔ 别自己写库** —— 坑库在项目外，写了是越界、而且不在监控里；**落库由大脑统一做**）。`)
  return parts.join('\n')
})()

// ────────────────────────────────────────────────────────────────────────────────────────
// ★ 2026-10-16（任务分级 L1–L4）：四级预设包（KB 重构\任务分级-施工文档.md §3）
//   ② 参考规模：写进卡尾**只作参考**（★ b201：原来写成"步数预算 ≤N 步、超了停手写回执"＝**限额**，
//      与 M6-2 的定稿冲突 —— M6-2 实测"同样 25 轮花费差一个数量级 ⇒ **步数不是成本代理**"，
//      判决权只给三条独立信号：空转／无产物／墙钟）。④ 卡片形态：slim＝目标行原文 ＋ 改成什么 ＋ 1 条命令 ＋ 白名单。
//   ⚠️ 默认形状（机制落地、用户还没配自定义包时）：L1 = 10 步/ac/slim ｜ L2 = 30 步/quick/std ｜ L3 = 60 步/full/std ｜ L4 = 不限/full/full。
//      用户若在 agents.json 的**全局 levels 段**配了同名字段，以配置为准（`levelPresetOf` 只校验合法性，不改写用户的值）。
//   ⚠️ 本块必须在【任务正文】拼装**之前**（它在 prompt 里）；放后面会 "Cannot access before initialization"（实测踩过）。
// ────────────────────────────────────────────────────────────────────────────────────────
const LEVEL_BUDGET = { L1: 10, L2: 30, L3: 60, L4: null }
const LEVEL_DEFAULT_GATE = { L1: 'ac', L2: 'quick', L3: 'full', L4: 'full' }
const LEVEL_DEFAULT_SHAPE = { L1: 'slim', L2: 'std', L3: 'std', L4: 'full' }
const preset = (kind, dflt) => {
  const p = levelPresetOf(kind, AGENTS_CFG, LEVEL?.key)
  return (LEVEL?.over && kind === 'shape' && ['slim', 'std', 'full'].includes(LEVEL.over))
    ? LEVEL.over                                     // `L2+full` 这种单项覆盖（形态）
    : (LEVEL ? (p.value ?? dflt) : null)
}
const LEVEL_SHAPE = LEVEL ? preset('shape', LEVEL_DEFAULT_SHAPE[LEVEL.key]) : 'std'
const LEVEL_GATE = LEVEL ? (LEVEL.over && ['ac', 'quick', 'full'].includes(LEVEL.over) ? LEVEL.over : preset('gate', LEVEL_DEFAULT_GATE[LEVEL.key])) : 'full'
const LEVEL_STEPS = LEVEL ? (LEVEL_BUDGET[LEVEL.key] ?? null) : null

const roleLine = `${ROLE}（模型 ${P.model}，--reasoning-effort ${P.effort}${LEVEL ? `，级 ${LEVEL.key}` : ''}${P.extra.includes('--disallowed-tools') ? '，写工具已禁用' : ''}）`

// ★ 2026-10-23（施工文档 W2 下发 / §8 兜底表）：**卡头写清"这个模型能吃多少"**。
//   为什么必须上卡：T1-01 #1 的 8.6 分钟空转就是"输出预算 16384 被思考吃光"，而卡上一个字都没提；
//   能力已知时写实数（载体已按它配置），未知时**显式告警**（§8：不许静默落 16384）。
const CAP = (() => { try { return capacityOf(P.model) } catch { return null } })()
const CAP_LINE = CAP && CAP.found
  ? `上下文 ${CAP.contextWindow ? Number(CAP.contextWindow).toLocaleString('en-US') : '未知'} / 最大输出 ${CAP.maxOutputTokens ? Number(CAP.maxOutputTokens).toLocaleString('en-US') : '未知'}（来源 ${CAP.source}${CAP.stale ? '，**已过期**' : ''}）`
  : '⚠️ **未知** —— 本模型不在能力注册表里，载体只能用它自己的兜底值（pi 16384 / opencode、codebuddy 各自的默认），**很可能被截断**；跑 `模型能力.mjs refresh` 或手填'

// ---------------------------------------------------------------- 测试分工（2026-10-05 用户拍板）
//
// 三条改造（用户原话）：① 大脑不跑测试；② 审核员跑测试 + 改 bug；③ coder 不跑全量，只跑一条最简命令。
// 落到卡片上就是下面两段 —— **当场把"你不该跑全量"写死进卡**，因为 coder 天然会想"跑一遍全仓确认"
// （实测它就是这么烧掉最多 token 的：每条任务跑一次 570 条用例，输出全进它自己的上下文）。

// ★ 2026-10-21（通用化①）：卡上的"可执行自测命令"判定**改成和台账同一套口径**（`_验收.mjs`）。
//   原来这里自带一条只认反引号+箭头的正则 ⇒ 台账认得的裸命令，卡里却说"没有可执行 AC"，
//   两张嘴各说一套（实测就发生过：卡叫 coder 自己看着办，机器那边其实能跑）。
const execACs = ACCEPT.map(a => parseExecAC(a)).filter(Boolean)
const isExecAC = (entry) => !!parseExecAC(entry)
const isReviewer = /^review/.test(ROLE)
const isCoder = /^coder-/.test(ROLE)

/**
 * 门禁命令（与本工作台的 `门禁.mjs` 同一个口径）。
 * ★ 2026-10-27（审核一次制）：**不再注入审核卡** —— 原来把它整段写进审核员的卡（「本卡门禁命令」段
 *   + 第 1 条「先跑门禁」），等于**命令它重跑一遍**；而同一段又写"不要重跑"，自相矛盾。
 *   实测它照第一条做了（`beidanci` 报告 §9 命令清单第 4 条就是门禁）。
 *   保留这个常量是因为它仍是"门禁怎么跑"的**唯一书写口径**（人查/文档引用都用它），但卡面上不再出现。
 */
const GATE_CMD = `node "${join(HERE, '门禁.mjs')}" --project "${PROJECT}"`

// ★ 2026-10-09（SOP 收口·S6 双写绑定）：口径＝规则书 §二附「测试归属」——改那边必须同步这里（反之亦然）。
const roleTestBlock = isCoder
  ? `【测试：只跑这一条，**不许跑全量**（2026-10-05 用户拍板，省 token）】
${execACs.length
    ? execACs.map(a => `- 交给你的自测命令：\`${a.cmd}\`${a.expect ? `　→ 输出里必须出现「${a.expect}」` : '　→ 退出码必须为 0'}`).join('\n')
    : '- ⚠️ 这张卡**没有写可执行的自测命令**（验收标准只有中文）→ 本级视为"未机器验证"，你仍需跑一条**最小的**自测（本模块单测或本模块冒烟之一），并在回执里写清"怎么跑的＋看到什么"。'}
- ⛔ **不要跑全仓测试**（\`npm test\` / 全量冒烟）：那是**门禁脚本的活（零 token）**；审核员也只**判读**它的结果、不重跑。你跑了纯属白烧 token（本工作台实测这是最贵的一笔开销）。
- ⛔ 不要为了"确认没影响别的模块"去跑别人的测试 —— **跨模块回归由门禁脚本在收尾统一跑**。
- ✅ 回执里把**命令原文 + 关键输出几行**贴出来即可（不要贴几百行）。
- ★ **必须登记 \`ran:\`（2026-10-23 起：机器会拿它对账）**：上面那条自测跑完，在回执里写一行
  \`ran: {"cmd":"<命令原文>","exit":<退出码>,"cwd":"<项目根>"}\`（跑了几条写几行）。
  **不是可选的**：编排会把它跟工具记录对账 —— 写着 0 但实际红 = **谎报**（直接交审核，不给返工机会）；压根没登记 = **失职**。`

  : isReviewer
    ? `【测试：**全量由门禁跑**（零 token、机器签字方），**你不要跑**；只有你真改了代码，才复跑「红的那一条」（★ 2026-10-27 审核一次制：全量审核+端到端+试玩 **整个项目周期只做 1 次**，所以这一次的力气该花在条款审计与探索性试用上，不是重跑机器已经跑过的东西）】
· **审查维度按规则书 §二⑥「七个审查维度」逐条出表**（逐条 ✅/❌/⚠️＋证据；规则书＝本机知识库 \`人机协作SOP-唯一源\` 下的 v3.0 规则书）。
0. **改动白名单**（四条护栏①）：只许改下面这些路径，越界由文件指纹当场抓${WHITELIST.length ? '：' : '（⚠️ 本工单没带清单 → 按门禁红的文件所属模块自律）'}：
${WHITELIST.length ? WHITELIST.map(w => `   · ${w}`).join('\n') : '   · （未提供）'}
1. **门禁已经由编排跑完了，你不要再跑**：
   · 摘要（挂了的用例名 + 红/绿数字）**已随本卡给你**（卡上的 \`gate\` 段），直接读；原始输出在 \`_crew\\gate\\latest.log\`，只在摘要不够时才翻。
   · ⛔ **不要跑 \`门禁.mjs\`**：那是编排的活，重跑 = 纯重复，机器会判你 \`review-rerun-gate\`（越界留痕，和跑 \`npm test\` 同一档）。
   · ✅ 唯一例外：**你真改了代码** —— 只跑 \`--only build,unit\`（约 10 秒）确认编译与单测，再把**红的那一条**单独复跑贴证据（要的是这一条的红→绿，**不是全量**）。（⚠️ 别写 \`--only build,test\`：旧写法会静默跳过单测报假绿，已修复为 test≡unit 别名，但仍统一用 build,unit）
   · 若**怀疑门禁假绿**（例：数字不合理、该红却没红）：先在本报告里**写一行理由**，再**只重跑单条用例**（不是整个 scope）。
2b. **省 token 二条硬规矩**（★ 2026-10-07 用户拍板 —— 实测那趟 483 万 token 就栽在这几处）：
   · **同一个文件最多读 1 次**（要再看就翻你自己前面贴过的片段）；
   · **每条命令的输出只贴 ≤40 行**（用 tail / grep 截断，只留该看的几行）。
2c. **回执格式（★ 2026-10-07：机器会读，缺了会被判"未验 / 越界"）**——报告末尾必须有两样：
   · **门禁结果引用**：写出 \`_crew\\gate\\gate-result.json\` 的**路径**即可（★ 2026-10-27：绿几步/红几步/时间戳**不用抄**了，编排会填）；
   · **跑过的命令清单**：本次真跑过的**每条命令原文**（一行一条，含 \`--only build,unit\`、以及你复跑的那条用例）。
   · ⛔ **清单里出现全量命令会被判越界**（\`npm test\` / \`npm run test\`；★ 2026-10-27 起 \`门禁.mjs\` 也算）—— 全量只有门禁跑（零 token）。
2. **先分类，再决定动不动手**（★ 2026-10-06 用户口径）：
   · **代码类**（编译错 / 断言不成立 / 逻辑写错）→ **你修**。
   · **环境类**（**没 API key**、账号没注册、额度用完、网络不通、外部服务不可用、脚本或命令根本不存在）→
     ⛔ **不要动手修**（那不是代码错，你修不了，只会白烧额度）→ **报告里写一句"这是环境类，需要人补 XXX"并停手**。
     编排会把它记进"待用户处理"清单（看板出红灯），**不是你的活**。
3. **改动范围（★ 2026-10-06 放宽）**：为了修一个 bug，**可以出本模块**去改别的模块的代码；但守两条硬线：
   · **绝不碰** \`CONTRACT.md\` / \`PROJECT_BLUEPRINT.md\`（含 \`CONTRACT-*.md\`）—— 需要改契约时，在报告里点名
     "**涉及哪条 C 编号 / 建议怎么改**"，由**大脑定夺**；大脑定不了才交用户。**不许自己改契约。**
   · **不许加功能、不许顺手重构** —— 只修让它红的那一处；出模块要写清"为什么非改这里不可"。
4. **每修一个 bug，必须补一条回归测试**（★ 2026-10-06：这是"考生出卷"问题的最低成本缓解 ——
   只修不补，同类 bug 下次还会回来）。补不了就在报告里说明为什么。
5. **报告末尾必须有两样**：
   · **改动清单**：**文件清单由编排填**（文件指纹已经算过，不必你逐个列）；你写「为什么改」和「改了哪几行」；
   · **红→绿证据**：哪条命令原来红（原话）→ 改完复跑的同一条命令 → 什么结果（**没复跑不算修好**；本轮没改代码就写"0 改动"）。
   再加一句**人话总结**（用户只看这一句）。
6. **上限：同类问题最多修 2 轮**（★ 2026-10-06 用户拍板）—— 两轮还不绿就停手写报告"我修了 2 轮仍未绿，
   剩下的是 XXX"，不要一直改下去（每轮都花钱；剩下的由大脑定夺，定不了交用户）。`
    : `【测试：本角色不跑全量测试】全量由门禁脚本跑、审核员判读（2026-10-05 用户拍板）。你只做本任务范围内的事。`

// ---------------------------------------------------------------- 五·S2 roleTestBlock 拆两半（2026-10-09）
//   stable 半＝规则本身（同角色每张卡逐字节一样，进缓存）；volatile 半＝按卡填的命令/白名单。
//   ⚠️ **card 侧仍用整块 roleTestBlock**（人读顺序不变）；
//   双写绑定：口径＝规则书 §二附「测试归属」，改那边必须同步这里。
const roleTestStable = isCoder
  ? `【测试：只跑这一条，**不许跑全量**（2026-10-05 用户拍板，省 token）】
- ⛔ **不要跑全仓测试**（\`npm test\` / 全量冒烟）：那是**门禁脚本的活（零 token）**；审核员也只**判读**它的结果、不重跑。你跑了纯属白烧 token（本工作台实测这是最贵的一笔开销）。
- ⛔ 不要为了"确认没影响别的模块"去跑别人的测试 —— **跨模块回归由门禁脚本在收尾统一跑**。
- ✅ 回执里把**命令原文 + 关键输出几行**贴出来即可（不要贴几百行）。
- ✅ 本卡的**自测命令在文末「本卡自测命令」段**（按卡给；没有就按"最小自测"口径自查并写清怎么跑的）。`
  : isReviewer
    ? `【测试：**全量由门禁跑**（零 token、机器签字方）；你负责**判读 + 只复跑红的那条**，且可以修 bug（★ 2026-10-07 用户拍板：省 token 的主刀是"回合数与重复读"，不是"要不要跑全量"）】
· **审查维度按规则书 §二⑥「七个审查维度」逐条出表**（逐条 ✅/❌/⚠️＋证据；规则书＝本机知识库 \`人机协作SOP-唯一源\` 下的 v3.0 规则书）。
· 本卡的**改动白名单在文末「本卡改动白名单」段**（按卡给）。
1. **门禁已经由编排跑完了，你不要再跑**：摘要（挂了的用例名 + 红/绿数字）**已随本卡给你**（卡上的 \`gate\` 段），直接读。
   原始输出在 \`_crew\\gate\\latest.log\`，只在摘要不够时才翻。
   · ⛔ **不要跑 \`门禁.mjs\`**：那是编排的活，重跑 = 纯重复，机器会判你 \`review-rerun-gate\`（越界留痕，和跑 \`npm test\` 同一档）。
   · ✅ 唯一例外：**你真改了代码** —— 只跑 \`--only build,unit\`（约 10 秒）确认编译与单测，再把**红的那一条**单独复跑贴证据（要的是这一条的红→绿，**不是全量**）。（⚠️ 别写 \`--only build,test\`：旧写法会静默跳过单测报假绿，已修复为 test≡unit 别名，但仍统一用 build,unit）
   · 若**怀疑门禁假绿**（例：数字不合理、该红却没红）：先在本报告里**写一行理由**，再**只重跑单条用例**（不是整个 scope）。
2b. **省 token 二条硬规矩**（★ 2026-10-07 用户拍板 —— 实测那趟 483 万 token 就栽在这几处）：
   · **同一个文件最多读 1 次**（要再看就翻你自己前面贴过的片段）；
   · **每条命令的输出只贴 ≤40 行**（用 tail / grep 截断，只留该看的几行）。
2c. **回执格式（★ 2026-10-07：机器会读，缺了会被判"未验 / 越界"）**——报告末尾必须有两样：
   · **门禁结果引用**：写出 \`_crew\\gate\\gate-result.json\` 的**路径**即可（★ 2026-10-27：绿几步/红几步/时间戳**不用抄**了，编排会填）；
   · **跑过的命令清单**：本次真跑过的**每条命令原文**（一行一条，含 \`--only build,unit\`、以及你复跑的那条用例）。
   · ⛔ **清单里出现全量命令会被判越界**（\`npm test\` / \`npm run test\`；★ 2026-10-27 起 \`门禁.mjs\` 也算）—— 全量只有门禁跑（零 token）。
2. **先分类，再决定动不动手**（★ 2026-10-06 用户口径）：
   · **代码类**（编译错 / 断言不成立 / 逻辑写错）→ **你修**。
   · **环境类**（**没 API key**、账号没注册、额度用完、网络不通、外部服务不可用、脚本或命令根本不存在）→
     ⛔ **不要动手修**（那不是代码错，你修不了，只会白烧额度）→ **报告里写一句"这是环境类，需要人补 XXX"并停手**。
     编排会把它记进"待用户处理"清单（看板出红灯），**不是你的活**。
3. **改动范围（★ 2026-10-06 放宽）**：为了修一个 bug，**可以出本模块**去改别的模块的代码；但守两条硬线：
   · **绝不碰** \`CONTRACT.md\` / \`PROJECT_BLUEPRINT.md\`（含 \`CONTRACT-*.md\`）—— 需要改契约时，在报告里点名
     "**涉及哪条 C 编号 / 建议怎么改**"，由**大脑定夺**；大脑定不了才交用户。**不许自己改契约。**
   · **不许加功能、不许顺手重构** —— 只修让它红的那一处；出模块要写清"为什么非改这里不可"。
4. **每修一个 bug，必须补一条回归测试**（★ 2026-10-06：这是"考生出卷"问题的最低成本缓解 ——
   只修不补，同类 bug 下次还会回来）。补不了就在报告里说明为什么。
5. **报告末尾必须有两样**：
   · **改动清单**：**文件清单由编排填**（文件指纹已经算过，不必你逐个列）；你写「为什么改」和「改了哪几行」；
   · **红→绿证据**：哪条命令原来红（原话）→ 改完复跑的同一条命令 → 什么结果（**没复跑不算修好**；本轮没改代码就写"0 改动"）。
   再加一句**人话总结**（用户只看这一句）。
6. **上限：同类问题最多修 2 轮**（★ 2026-10-06 用户拍板）—— 两轮还不绿就停手写报告"我修了 2 轮仍未绿，
   剩下的是 XXX"，不要一直改下去（每轮都花钱；剩下的由大脑定夺，定不了交用户）。`
    : `【测试：本角色不跑全量测试】全量由门禁脚本跑、审核员判读（2026-10-05 用户拍板）。你只做本任务范围内的事。`

const roleTestVolatile = isCoder
  ? `【本卡自测命令（按卡给）】
${execACs.length
    ? execACs.map(a => `- 交给你的自测命令：\`${a.cmd}\`${a.expect ? `　→ 输出里必须出现「${a.expect}」` : '　→ 退出码必须为 0'}`).join('\n')
    : '- ⚠️ 这张卡**没有写可执行的自测命令**（验收标准只有中文）→ 本级视为"未机器验证"，你仍需跑一条**最小的**自测（本模块单测或本模块冒烟之一），并在回执里写清"怎么跑的＋看到什么"。'}`
  : isReviewer
    ? `【本卡改动白名单（按卡给 · 四条护栏①）】
0. 只许改下面这些路径，越界由文件指纹当场抓${WHITELIST.length ? '：' : '（⚠️ 本工单没带清单 → 按门禁红的文件所属模块自律）'}：
${WHITELIST.length ? WHITELIST.map(w => `   · ${w}`).join('\n') : '   · （未提供）'}`
    : ''

// ---------------------------------------------------------------- 五·S3 pitfallBlock 拆两半（2026-10-09）
//   stable 半＝三跳固定流程＋四步硬要求（删掉"坑库共 N 篇 / 命中 M 篇"这类会漂的数字）；
//   volatile 半＝本卡命中的坑原文/标题＋统计数字。
//   ⚠️ **card 侧仍用整块 pitfallBlock**（人读顺序不变：先命中、后三跳）。
const pitfallStable = `【动工前必须先看坑 — 硬要求】
（本卡命中的坑在文末「本卡命中的坑」段：强相关附**原文**必读、低相关只给**标题**）
1. **先读命中段**，然后走下面固定的三跳 —— 三跳是**兜底流程，每张卡都一样**：
### 🗂 查库三跳（固定流程 · 所有角色都走）
1. **先跑脚本**（0.2 秒、不花钱）—— 用你**报错原文 / 模块名 / 工具名**当关键词：
   \`node ${join(HERE, '查坑.mjs')} "<关键词,关键词>"\`
   命中 → 打开那条坑照它的「③ 对策」做，**别自己硬试**。
2. **没命中就扫索引标题**（一行一条 —— **只扫「现象 + 对策」，不要读正文**）：
   \`${VAULT}\\_索引.md\` —— 看着像的，再打开那一条。
3. **还不像就全库搜你的报错原文**（内容匹配，最全）：用 Grep 搜 \`${VAULT}\`，关键词取报错里的 2–3 个词。

⚠️ 第 1 跳是**字面匹配，一定会漏**（措辞不同 / 只回前 N 条 / 没有语义）—— **"查不到"≠"库里没有"**，必须往下走。
⚠️ **前三跳都没有 → 那就是条真新坑**：回执里交 \`pit: 现象 | 根因 | 对策 | 证据（文件:行）\`（**⛔ 别自己写库** —— 坑库在项目外，写了是越界、而且不在监控里；**落库由大脑统一做**）。
2. **遇到任何报错/异常/卡住，先按上面三跳查库（脚本 → 索引标题 → 全库搜），再决定怎么改** —— 坑库里都是别人真踩过的，**查中一次就省掉你反复试错的一大串来回**。
3. **动工前先回报三句话**（不回不动工）：
   ① 我读了哪几条；② 它们对本次任务的具体影响；③ 我打算怎么避开。
4. 动工中若踩到**新坑**：**别自己写库**（坑库在项目外：写了是越界、而且不在监控里），回执里交 \`pit: 现象 | 根因 | 对策 | 证据（文件:行）\`，**由大脑统一落库**（三跳都查不到的那种，才是真新坑）。`

const pitfallVolatile = `【本卡命中的坑（按关键词自动匹配）】
${!pf.ok
    ? `⚠️ 坑库读不到（${pf.reason}）—— 本次按"无相关老坑"处理，但**记进台账**（可能意味着库根配错了）。`
    : (!topHits.length && !weakHits.length
      ? `本次无相关老坑（派活脚本按关键词 [${KEYWORDS.join('、') || '空'}] 扫了 \`${VAULT}\`，${pf.total} 篇里 0 命中）。`
      : `（统计：坑库共 ${pf.total} 篇 · 关键词命中 ${pf.hits.length} 篇 · 已列 ${topHits.length + weakHits.length} 篇${droppedStrong ? ` · 另 ${droppedStrong} 条强相关未展开` : ''}）
${topHits.length ? `### 🎯 强相关（**原文已附** —— 这几条必须读）\n${topHits.map((h, i) => `── 坑 ${i + 1}：《${h.file}》　（命中：${h.which.join('、')}）\n${h.body}`).join('\n\n')}` : ''}${weakHits.length ? `

### 📎 相关度较低（**只给标题** —— 觉得沾边就自己去读那条）
${weakHits.map(h => `─ 《${h.file}》　（命中：${h.which.join('、')}）`).join('\n')}` : ''}`)}`

// ---------------------------------------------------------------- 五·S1 三段式前缀契约（2026-10-09）
//   STABLE＝同角色任意两卡**逐字节相同**（缓存前缀全靠它）；SEMI＝同角色/同项目基本不变；
//   VOLATILE＝每张卡独有，全部赶到卡尾（任务号、目标、交付物、契约、验收、白名单、坑命中、指纹锚…）。
//   只改 **prompt** 的拼装；card 模板原样保留（人读顺序不变）。
//   后续：S2 把 roleTest 稳定半段搬进 STABLE、S3 搬 pitfall 三跳 —— 每搬一件跑一次 _前缀契约自检.mjs。
//   纪律：往 STABLE 加内容前先问"是不是每张卡都一样"，加完跑自检（飞前 ②c 已挂）。

// ---------------------------------------------------------------- 四·S2 角色技能包（2026-10-09）
//   按 ROLE 内联 roles\skills\<file>.md（coder-a/coder-b 共用 coder.md）→ 进 STABLE 段；
//   同角色逐字节恒定（缓存前缀）；读不到 ⇒ 拒绝出卡（fail-closed，防残缺卡）。
const SKILL_FILE = { 'coder-a': 'coder.md', 'coder-b': 'coder.md', reviewer: 'reviewer.md', researcher: 'researcher.md', rescue: 'rescue.md' }
const roleSkillsBlock = (() => {
  const f = SKILL_FILE[ROLE]
  if (!f) { console.error(`[派活] ❌ 四·S2：角色 ${ROLE} 未登记技能文件（roles\\skills\\）`); process.exit(1) }
  try {
    const t = readFileSync(join(HERE, 'roles', 'skills', f), 'utf8').trim()
    if (!t) throw new Error('文件为空')
    return t
  } catch (e) {
    console.error(`[派活] ❌ 四·S2：读不到角色技能文件 roles\\skills\\${f}（${e.message}）—— 拒绝出卡`)
    process.exit(1)
  }
})()

const DEFAULT_BOUNDARY = [
  '只改"交付物"里列出的路径',
  '不要 commit（worktree 里的 .git 是指针文件；集成与提交由大脑在主树做）'
]

// ★ 2026-10-18（七 v2）：STABLE 拆成 **公共头（stableHead）＋ 模块块（moduleBlock）＋ 管道尾**。
//   模块块为空时，拼出来的字符串与改造前**逐字节相同**（铁判据：sha 仍 550e9e42a0f9）。
//   `stableHead` 是"跨模块不变的公共前缀"——`--dump-blocks` 会单独打印它，供 `_前缀契约自检` 断言。
const stableHead = `${crewBriefBlock}
${roleSkillsBlock}
${roleTestStable}
${pitfallStable}
【边界（不许做）】
${DEFAULT_BOUNDARY.map(b => '- ' + b).join('\n')}
`
const moduleBlock = MODULE ? `【本模块边界（${MODULE.name}）】\n${MODULE.body}\n` : ''
const stableBlock = `${stableHead}${moduleBlock}【输出绝不接管道】管道（|）会导致 exit 42、零输出。`

const semiBlock = `【角色】${roleLine}
【项目】${PROJECT}
【工作目录】${WORKTREE ? 'worktree ' + WORKTREE + '（' + CWD + ' 下）' : CWD}${WAVE ? '\n【波次】' + WAVE : ''}`

// 调研命中行（S4）：四句固定语 ＋ 命中行；没有 `--research` 时**整块是空字符串**（卡片逐字节不变）
const researchBlock = !RESEARCH ? '' : `

【调研库（命中行已附 · 共 ${RESEARCH.total} 条${RESEARCH.total > RESEARCH.hits.length ? `，只附前 ${RESEARCH.hits.length} 条` : ''}）】
${RESEARCH.hits.length
  ? RESEARCH.hits.map(h => `- [${h.drawer}] ${h.path}${h.note ? ` —— ${h.note}` : ''}`).join('\n')
  : '- （0 条命中：**库里没有**，不等于"没有这个事实"）'}
- 1) 命中行：直接按上面的路径读原文，**不用翻整份索引**。
- 2) 要扩展查询：\`node _unattended\\查调研.mjs --project "<项目>" <词...>\`（零 token）。
- 3) 仍未命中 ⇒ 回执里写「缺料清单」（词 ＋ 为什么缺 ＋ 期望哪一屉）；**⛔ 不许上网、不许整目录读、不许编**。
- 4) 命中带 ⚠过期 的行 ⇒ **先复抓那一份**再引用（比 sha256：没变就刷新日期）。`

// ★ b197（施工文档 §四 M6-10 第 4 件 · D 通道）：**上一轮同类任务真越界过哪些文件** —— 由 `编排.mjs`
//   从收据的 `outOfScopeKind.realOverreach` 取出来、像 `--files` 那样传进来 ⇒ 渲染进 VOLATILE。
//   为什么只传"真越界"：`whitelistGap` 是**我们卡没写全**，让下一张卡背这个锅是甩锅（那一类该去补白名单）。
const OUT_OF_SCOPE = (opt('out-of-scope') ?? '').split(/[;,]/).map(s => s.trim()).filter(Boolean)
const overreachVolatile = OUT_OF_SCOPE.length
  ? `\n【⚠️ 上一轮同类任务**真越界**过这些文件（这轮别重犯）】\n${OUT_OF_SCOPE.map(p => '- `' + p + '`').join('\n')}\n- 它们的**不在**你这张卡的白名单里 ⇒ 要动：**停下写回执问大脑**，不许自己扩范围；不动也请在回执里说一句"回避了"。\n`
  : ''
// ★ 2026-10-21（越界台账 · 广播）：编排现成写好的"人话"（含谁、哪张卡、为什么），原样插进卡里。
//   与上面那段路径清单不冲突：清单是"别重犯"，这段是"知情人是谁"。
const SCOPE_BRIEF = String(opt('scope-brief') ?? '').trim()
const scopeBriefVolatile = SCOPE_BRIEF ? `\n${SCOPE_BRIEF}\n` : ''

// ★ b197（施工文档 §四 M6-4 · 第 1／2／3／5 条）：**把"这次干什么"和"一条打包命令"写进 VOLATILE**。
//   为什么：实测一张卡 88–92% 的篇幅在讲通用规矩，只有 8–12% 在讲"这次到底干什么"
//   ⇒ 审核员只能自己翻、coder 只能自己 grep。机械验证缺口：本脚本原来 grep「体检.mjs」**0 命中**
//   —— 那条"一条命令拿全状态"的口径**只写给大脑，从没写给载体**。
//   ⚠️ 纪律：**只动 VOLATILE 段**（不动 STABLE/SEMI ⇒ 前缀契约与缓存前缀不变）。
const contractNumbered = CONTRACT.length
  ? CONTRACT.map((c, i) => `- [C${i + 1}] ${c}`).join('\n')
  : '- （未填；若你发现契约有缺口，停手并报告，不要自行发明）';
const isDirEntryLocal = (p) => /\/\*\*$/.test(String(p)) || /[\\/]$/.test(String(p))
const filesBlock = (() => {
  const wl = [...new Set([...DELIVERABLES, ...WHITELIST])];
  if (!wl.length) return '- （本卡没写文件清单 ⇒ **按交付物所在模块自律**，越界必须写 why）';
  return wl.map(p => `- \`${p}\`${isDirEntryLocal(p) ? '（**目录级**：该目录下全部文件都算你的）' : ''}`).join('\n')
    + '\n- ⚠️ **只许动上面这些**（含同目录下的配套测试文件）；清单外的要动 ⇒ **停下写回执问**，越界要写 `why:`。';
})();
const checklistVolatile = `【本卡涉及的文件（白名单 · 只许动这些）】\n${filesBlock}\n`;
const statusCmdVolatile = `【一条命令拿全状态（别一条条拼 pwsh）】\n- \`node "${join(HERE, '体检.mjs')}" --project "${PROJECT}" --json\` ⇒ 一次拿到：轨道／级号／指纹／门禁摘要／文件清单（输出是 JSON，直接吃）。\n`;
// a／c 两条**由编排按需传入**（没有就一个字都不加 ⇒ 卡片逐字节不变，天然可关）
const PREV_WAVE = opt('prev')            // a：上一波是谁干的、干成什么样（审给核员看）
const REWORK = opt('rework')             // c：上一轮审核提了什么还没改（重做卡用）
// ★ b197（施工文档 §四 M6-5 · D 通道）：上一轮**同角色**的审核口径违规 ⇒ 一行压力（不重做本轮）
const POLICY_NOTE = opt('policy-note')
const policyVolatile = POLICY_NOTE ? `\n【⚠️ 上一轮本角色的审核口径违规（M6-5 · 只在下一张卡施压）】\n${POLICY_NOTE}\n` : '';
const prevVolatile = PREV_WAVE ? `\n【上一波是谁干的、干成什么样（a）】\n${PREV_WAVE}\n` : '';
const reworkVolatile = REWORK ? `\n【上一轮审核提了什么还没改（c）】\n${REWORK}\n` : '';

// ★ b219（2026-10-22 施工文档 L4）：**热启动块** —— 拆卡/续跑时把"上一张卡干到哪了"预置进卡。
//   纪律（硬）：**只能进 VOLATILE**。STABLE 段必须逐字节跨卡一致（含 `${` 拒卡），
//   热启动逐卡不同，进 STABLE 会把缓存前缀打散 ⇒ 直接撞 `_前缀契约自检` 的红线。
//   内容来源：编排算好写成 JSON（文件树 / 已冻结接口签名 / 上卡摘要 / 相关文件 / 最近一次测试）。
const HOTSTART = opt('hotstart')
const hotstartVolatile = (() => {
  if (!HOTSTART) return ''
  let doc = null
  try { doc = JSON.parse(readFileSync(HOTSTART, 'utf8').replace(/^\uFEFF/, '')) } catch { return `\n【⚠️ 热启动块读不出来（${HOTSTART}）】忽略它，按卡正常开工。\n` }
  const lines = []
  const push = (title, val) => {
    const arr = Array.isArray(val) ? val : (val ? [val] : [])
    if (!arr.length) return
    lines.push(`### ${title}`, ...arr.map((x) => '- ' + String(x)))
  }
  push('现有文件树（两层，别重复造）', doc.tree)
  push('已冻结的接口签名（**必须照这个写，不许改**）', doc.signatures)
  push('上一张卡干到哪了（摘要）', doc.lastSummary)
  push('相关文件（路径 — 一句话职责）', doc.files)
  push('最近一次测试命令与结果', doc.lastTest)
  if (doc.mustNotTouch?.length) lines.push('### 不要碰', ...doc.mustNotTouch.map((x) => '- ' + String(x)))
  return lines.length ? `\n【热启动：不用重新摸清现状，照这个直接干】\n${lines.join('\n')}\n` : ''
})()
const volatileBlock = `【任务】${TASK}　依赖：${DEPENDS}
${hotstartVolatile}

【目标】
${GOAL}

【交付物（精确到路径；写目录如 src/render/ 表示整目录都归你）】
${DELIVERABLES.length ? DELIVERABLES.map(d => '- ' + d + (isDirEntryLocal(d) ? '（目录级）' : '')).join('\n') : '- （未填）'}

【接口契约（必须严格遵守，不许改）】
${contractNumbered}

${checklistVolatile}${statusCmdVolatile}

【验收标准（硬条件）】
${ACCEPT.length ? ACCEPT.map(a => '- [ ] ' + a).join('\n') : '- （未填）'}

${roleTestVolatile ? roleTestVolatile + '\n' : ''}${pitfallVolatile}
${BOUNDARY.length ? `\n【本卡附加边界（工单自带）】\n${BOUNDARY.map(b => '- ' + b).join('\n')}\n` : ''}${REVIEW_QUESTION ? `\n【复核时多问一句】${REVIEW_QUESTION}\n` : ''}
${anchorBlock}${researchBlock}${prevVolatile}${reworkVolatile}${policyVolatile}${overreachVolatile}${scopeBriefVolatile}`

const prompt = [
  stableBlock,
  semiBlock,
  (LEVEL ? `【任务分级】本卡＝**${LEVEL.key}**（${LEVEL.raw}）· 形态 ${LEVEL_SHAPE} · 门禁 ${LEVEL_GATE}${LEVEL_STEPS ? ` · **参考规模 ≈${LEVEL_STEPS} 步**（**不是限额**：只是让你估这张卡多大；真做超了**不用请示**，以"空转/无产物/墙钟"为准 —— M6-2 定稿）` : ' · 规模不限'}\n` : ''),
  volatileBlock
].filter(Boolean).join('\n')

// —— 五·S4 派活期断言（单次运行能兜的三样；"两张卡逐字节一致"由 _前缀契约自检.mjs 跨运行兜）——
const STABLE_MIN_CHARS = 1200
if (!stableBlock.trim()) {
  console.error('[派活] ❌ 五·S4：STABLE 段为空 —— 拒绝出卡（拼装坏了）。')
  process.exit(1)
}
if (stableBlock.length < STABLE_MIN_CHARS) {
  console.error(`[派活] ❌ 五·S4：STABLE 段仅 ${stableBlock.length} 字（阈值 ${STABLE_MIN_CHARS}）—— 缓存前缀不达标，拒绝出卡（补内容或在自检 EXEMPT 登记豁免＋理由）。`)
  process.exit(1)
}
if (stableBlock.includes('${')) {
  console.error('[派活] ❌ 五·S4：STABLE 段含字面 `${`（未解析插值/误写）—— 拒绝出卡。')
  process.exit(1)
}

// —— ★ 2026-10-19（b192 · 施工文档 §四 D2 / D3）：**卡片面两条指标** ——
//
// 口径（与全文面**共用同一把尺子**，数条数一律走 `_条数体检.mjs`）：
//   ① **内联条数** ＝ 这张卡真正内联的规矩条数（`CB.body` ⇒ `<!-- CREW-BRIEF:BEGIN -->` 里【硬禁止】起那段）
//      —— **提示线**：只显示、不拦，用来看趋势（它不是红线，A1 已否掉"条数红线"）。
//   ② **本卡独有占比** ＝ `VOLATILE ÷ 四段合计字符` —— **红线 ≥20%**（b139 实测现状 8–12% ＝病根）。
// 为什么不下判决（D3 定的）：**不做"一超线就降级卡"** —— 红灯时**照常出完整卡**，只打一行告警；
//   "降级"要等红灯挂过 **3 个波次 / 24 小时**仍未处理才谈（那半边在看板/编排，尚未做）。
// 回滚：删掉本块 ＋ `import { countRules }` 两处即回到今天的行为（纯增量、不动卡内容）。
const RULE_N = countRules(CB.ok ? CB.body : '').count
const CARD_TOTAL_CHARS = stableHead.length + stableBlock.length + semiBlock.length + volatileBlock.length
const OWN_PCT = CARD_TOTAL_CHARS ? (volatileBlock.length / CARD_TOTAL_CHARS * 100) : 0
const OWN_RED = OWN_PCT < 20
const CARD_METRICS = {
  task: TASK, role: ROLE,
  inlineRules: RULE_N, inlineRulesNote: '提示线（不是红线）',
  cardFaceFrom: CB.ok ? CB.from : null,
  volatileChars: volatileBlock.length, totalChars: CARD_TOTAL_CHARS,
  ownPct: Number(OWN_PCT.toFixed(1)), ownRedLine: 20, ownRed: OWN_RED
}
console.error(`[派活] 📏 卡片面 ${TASK}：内联条数 ${RULE_N}（提示线） · 本卡独有占比 ${CARD_METRICS.ownPct}%（红线 ≥20%${OWN_RED ? ' ⇒ 🔴 低于红线 —— 照常出卡，只告警（D3）' : ' ✓'}）`)

// —— 五·S8 采样出口：--dump-blocks 1 → 打印三段＋sha256＋字数后直接退出（零副作用：不写任何卡文件）——
if (opt('dump-blocks', null) !== null) {
  const seg = (name, text) => {
    const sha = createHash('sha256').update(text).digest('hex').slice(0, 12)
    console.log(`===${name}=== sha256:${sha} chars:${text.length}`)
    console.log(text)
  }
  // ⚠️ 这一行必须在第一段**之前**：`_前缀契约自检.mjs` 的解析正则要求每段后面紧跟
  //    `===(STABLE_HEAD|STABLE|SEMI|VOLATILE|END)===`，插在中间会把上一段吃掉。
  console.log('===CARD_METRICS=== ' + JSON.stringify(CARD_METRICS))
  seg('STABLE_HEAD', stableHead)
  seg('STABLE', stableBlock)
  seg('SEMI', semiBlock)
  seg('VOLATILE', volatileBlock)
  console.log('===END===')
  process.exit(0)
}

// ────────────────────────────────────────────────────────────────────────────────────────
// ★ 2026-10-16（任务分级）：**slim 卡片形态**（L1 的默认形态，也可用 `L2+slim` 单点覆盖）。

const card = `# 任务卡 ${TASK}

- 轨道：${TRACK ?? '（未定 —— 按 SOP ①：没定轨道不许开工）'}
- 角色：${roleLine}
- **模型能力（这个模型能吃多少）**：${CAP_LINE}
- 工作目录 / worktree：${WORKTREE ?? '（无，直接在主树）'}
- 项目：${PROJECT}
- 波次：${WAVE ?? '—'}
- 依赖：${DEPENDS}
- 契约：${CONTRACT.length ? CONTRACT.join('、') : '（未列 —— 按 SOP ③：契约没冻结不许派活）'}
- **级号（任务分级 L1–L4）**：${LEVEL ? `${LEVEL.key}（${LEVEL.raw}）· 卡片形态 ${LEVEL_SHAPE} · 门禁 ${LEVEL_GATE}${LEVEL_STEPS ? ` · 参考规模 ≈${LEVEL_STEPS} 步（非限额）` : ' · 规模不限'} · 模型来源 ${P.modelSource}` : '（未标级 —— 按默认档跑；标级＝工单写 `LEVEL: L1..L4`）'}
- 生成时间：${new Date().toISOString()}

## 目标

${GOAL}

## 交付物

${DELIVERABLES.length ? DELIVERABLES.map(d => '- `' + d + '`').join('\n') : '- （未填）'}

## 接口契约

${CONTRACT.length ? CONTRACT.map(c => '- ' + c).join('\n') : '- （未填）'}

## 验收标准

${ACCEPT.length ? ACCEPT.map(a => '- [ ] ' + a).join('\n') : '- （未填）'}

${roleTestBlock}
## 相关坑（必须带）

${pitfallBlock}

${crewBriefBlock}
## 边界

${(BOUNDARY.length ? BOUNDARY : [
  '只改"交付物"里列出的路径',
  '不要 commit（worktree 里的 .git 是指针文件；集成与提交由大脑在主树做）'
]).map(b => '- ' + b).join('\n')}
${REVIEW_QUESTION ? `\n## 复核时多问一句\n\n${REVIEW_QUESTION}\n` : ''}
${anchorBlock ? '\n' + anchorBlock : ''}`

// ────────────────────────────────────────────────────────────────────────────────────────
// ★ 2026-10-16（任务分级）：**slim 卡片形态**（L1 的默认形态，也可用 `L2+slim` 单点覆盖）。
//   口径（文档 §3 ④）：`slim` ＝ 目标行原文 ＋ 改成什么 ＋ **1 条命令** ＋ 白名单 —— **不带班组须知/坑库背景**。
//   为什么值得（实测）：一次"改一个常量"的卡也跑了 35 分钟，而审核员只占 2–9 分钟、门禁 2.7 分钟
//   ⇒ 省时间的主刀是**减步数（少找信息）**，不是砍验证。所以 slim 砍的是"找信息与固定开销"。
//   ⚠️ **它砍不掉的东西**（砍了就违反《任务分级》§5 的底线）：文件白名单 ＋ 文件指纹 ＋ **一条可执行 AC**。
//   ⚠️ 代价如实记：slim **故意不带**「班组须知（规则）」与坑库三跳 —— 这是用户拍板的设计取舍（L1 是机械改）。
//     要那两块就别用 slim（`L1+std` 即可）；回滚＝清掉级号或改成 std。
// ────────────────────────────────────────────────────────────────────────────────────────
const WHITELIST_CARD = DELIVERABLES.length ? DELIVERABLES : WHITELIST
const slimCard = `# 任务卡 ${TASK}（**${LEVEL ? LEVEL.key : '未标级'}·slim** —— 机械改，别扩大范围）

- 角色：${roleLine}
- 模型能力：${CAP_LINE}
- 工作目录：${WORKTREE ?? '（无，直接在主树）'}
- 项目：${PROJECT}

## 目标（原文）

${GOAL}

## 交付物 / 白名单（只许动这些）

${WHITELIST_CARD.length ? WHITELIST_CARD.map(d => '- `' + d + '`').join('\n') : '- （未填 —— 那就**停下来报告**，不许自己挑文件改）'}

${CONTRACT.length ? `## 接口契约（不许改）\n\n${CONTRACT.map(c => '- ' + c).join('\n')}\n` : ''}
## 验收标准（硬条件 · **这一条不许省**）

${ACCEPT.length ? ACCEPT.map(a => '- [ ] ' + a).join('\n') : '- （未填 —— 停下来报告：没有验收标准就不许开工）'}

${execACs.length ? `## 本卡自测命令（**只跑这一条**）\n\n${execACs.map(a => `- \`${a.cmd}\`${a.expect ? `　→ 输出里必须出现「${a.expect}」` : '　→ 退出码必须为 0'}`).join('\n')}\n` : ''}
## 边界（硬线）

${(BOUNDARY.length ? BOUNDARY : DEFAULT_BOUNDARY).map(b => '- ' + b).join('\n')}
- ⛔ **不新增任何逻辑/分支/函数**（这级是"改已有的值/文案/断言"）—— 发现这活比想象大 ⇒ **停手写回执请求升级**，不许硬做。
- ⛔ 不许碰 \`CONTRACT.md\` / \`PROJECT_BLUEPRINT.md\`（要改就在回执里点名，由大脑定夺）。
- ⛔ **不要跑全仓测试**（那是零 token 门禁的活）；本卡只跑上面那条自测命令。
- ⚠️ **动了白名单以外的文件 ⇒ 必须在回执里补一行理由**：\`why: <为什么非动它不可>\`（**没写＝违规**）。
  机器会把越界分两种：**落在你交付物同目录**的＝"卡没写全"（无害，但要说）；**落在别处的**＝真越界（会被报给用户）。
- ✅ 回执：**改动清单 + 那条命令的输出几行**（≤40 行），末尾一句人话总结。
- 📄 完整背景（班组须知 / 相关坑三跳）在 \`${join(OUTDIR, TASK + '.md')}\` 那份全卡里；本卡没带不等于没有规则。
${anchorBlock ? '\n' + anchorBlock : ''}`
const cardBody = (LEVEL && LEVEL_SHAPE === 'slim') ? slimCard : card

// ---------------------------------------------------------------- 命令行

function buildCommand () {
  // 参数**全部来自 _crew\agents.json**（换 agent / 换模型只改那份 JSON）
  const inv = buildInvocation(P.res, '<PROMPT 内容由 $prompt 传入>', {
    worktreeName: P.res.worktree ? WORKTREE : null,
    cwd: CWD,
    addDirs: []
  })
  const argsNoPrompt = inv.args.slice(0, -1)          // 去掉占位 prompt
  const promptPath = join(OUTDIR, `${TASK}.prompt.txt`)
  const quote = (x) => (/\s/.test(x) ? `"${x}"` : x)
  const psLines = [
    `# WARNING: preview only. Running this file directly fails with "No API key" - the key is`,
    `# injected by the orchestrator at spawn time. To really run: 编排.mjs --project <P> --execute`,
    `$env:DSH_QUOTA_STALE_HOURS = '${process.env.DSH_QUOTA_STALE_HOURS ?? 24}'`,
    `$env:DSH_GATE_RANBY = '${ROLE}'`,   // ★ 六·S3：门禁 ranBy 由环境注入（载体照卡跑门禁时＝本角色；不再用 --by 文本）
    `# agent = ${P.agentName}（来自 ${AGENTS_SRC}）`,
    `$exe = '${inv.exe}'`,
    `$prompt = Get-Content -Raw -Encoding UTF8 '${promptPath}'`,
    `& $exe ${inv.argv.slice(0, -1).concat(['$prompt']).map(quote).join(' ')} 1> '${join(OUTDIR, TASK + '.out.json')}' 2> '${join(OUTDIR, TASK + '.err.txt')}'`,
    `$code = $LASTEXITCODE`,
    `# 回填账本（**必须带退出码**：否则崩了也记成成功 —— 实测抓到过 0 秒 0 token 的假账）`,
    `& '${process.env.DSH_NODE_EXE ?? NODE_P ?? '(未配置专用 node)'}' '${join(WORKSPACE, '_unattended', '工量账本.mjs')}' add --role ${ROLE} --task ${TASK} --envelope '${join(OUTDIR, TASK + '.out.json')}' --ok $(if ($code -eq 0) { 'true' } else { 'false' })`
  ]
  return { args: argsNoPrompt, agent: P.agentName, exe: inv.exe, argv: inv.argvForDisplay, powershell: psLines.join('\n') }
}

const cmd = buildCommand()

// ---------------------------------------------------------------- ★ D5 静态验收校验（派活前挡住"注定要红"的卡）
//
// 口径（施工文档 D5）：三条判据全静态 —— ① 脚本路径存在 ② 期望串在脚本里找得到出处 ③ 认不出就放过。
// 挡下之后：**不出卡、退出码 3** ⇒ 编排判 `input-error` 立刻退回大脑（D6 同轮重派），**不产生那一轮**。
// 逃生口：`--skip-ac-check`（演练/回放老卡时用），会在 stderr 出声。
// ★ 2026-10-26（§六「第一张卡的静态 AC 例外」）：把**本卡交付物**传进去 ——
//   项目第一张卡的任务就是"创建测试脚本"，不认交付物的话它永远被 exit 3 挡死（D5 死锁）。
//   在交付物里 ⇒ 标 `AC_PENDING_CREATE` 放行；不在 ⇒ 照旧 exit 3。
//   （`DELIVERABLES` 是第 186 行就解析好的那个，这里**不要**再声明一次）
const STATIC_AC = validateAccept({ accept: ACCEPT, project: PROJECT, deliverables: DELIVERABLES })
console.error(`[派活] 🔎 静态验收：检查 ${STATIC_AC.checked} 条 / 放过 ${STATIC_AC.skipped} 条 / 挡下 ${STATIC_AC.blocked.length} 条 / 待创建 ${STATIC_AC.pendingCreate.length} 条`)
for (const n of STATIC_AC.notes) console.error(`[派活] ⚠️ ${n}`)
for (const p of STATIC_AC.pendingCreate) console.error(`[派活] 🕓 AC_PENDING_CREATE：\`${p.script}\` 还不存在，但在本卡交付物里 ⇒ 允许出卡（**完成时必须真实存在且通过**）`)
if (!STATIC_AC.ok) {
  for (const b of STATIC_AC.blocked) console.error(`[派活] ⛔ ${b.entry}\n         ${b.why}`)
  if (!has('skip-ac-check')) {
    console.error('[派活] ⛔ 拒绝出卡（D5 静态校验）：上面这些验收**永远过不了**，派出去只会白跑一轮。\n' +
      '       改法：把路径写对 / 把期望串改成脚本真会输出的字样 / 或先补上那个脚本。\n' +
      '       确要硬派：加 --skip-ac-check（会留痕）。')
    process.exit(3)
  }
  console.error('[派活] ⚠️ --skip-ac-check：**明知验收过不了仍然出卡**（已留痕）')
}

// ---------------------------------------------------------------- ★ §4.2 AC 输出契约（ASSERT）＋ AC 指纹
//
// 口径（施工文档 20261024 §4.2，2026-10-23）：验收脚本要按契约打
//   `ASSERT <名字> OK|FAIL <期望>|<实际>`
// 否则机器只拿到退出码，"为什么红"读不出来 ⇒ 对账降级、裁判审无据。
//
// 但老项目的脚本不可能一夜改完（硬挡会一夜全红），所以分两档：
//   · 项目 `<项目>\gate.json`（或 `_crew\gate.json`）写 `"requireAssert": true` ⇒ **硬挡**（exit 3）
//   · 没写 ⇒ **只提醒**，收据里标 `assertionsMissing`（编排据此把 assertions 记空，**不判红**）
const ASSERT_CHECK = (() => {
  const missing = []
  for (const a of ACCEPT) {
    const ac = parseExecAC(a)
    if (!ac) continue
    const p = scriptOf(ac.cmd)
    if (!p) continue
    const abs = isAbsolute(p) ? p : resolve(PROJECT, p.replace(/^\.?[\\/]/, ''))
    let src = ''
    try { src = readFileSync(abs, 'utf8') } catch { continue }
    if (!/^\s*ASSERT\s+\S+\s+(OK|FAIL)/m.test(src)) missing.push({ entry: a, script: p })
  }
  let requireAssert = false
  for (const f of [join(PROJECT, 'gate.json'), join(PROJECT, '_crew', 'gate.json')]) {
    try {
      const g = JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
      if (g?.requireAssert === true || g?.data?.requireAssert === true) requireAssert = true
    } catch { /* 没有就跳过 */ }
  }
  return { missing, requireAssert }
})()

if (ASSERT_CHECK.missing.length) {
  console.error(`[派活] ⚠️ AC 输出契约：${ASSERT_CHECK.missing.length} 条验收的脚本没有打 ASSERT 明细（对账会降级）`)
  for (const m of ASSERT_CHECK.missing.slice(0, 5)) console.error(`         - ${m.script}`)
  if (ASSERT_CHECK.requireAssert) {
    console.error('[派活] ⛔ 项目声明了 requireAssert:true ⇒ 拒绝出卡。\n' +
      '       改法：让脚本按契约打 `ASSERT <名字> OK|FAIL <期望>|<实际>`，或去掉那条声明。')
    process.exit(3)
  }
}

// AC 指纹：命令 + 脚本内容一起哈希（验收被改过 ⇒ 指纹变 ⇒ 重派的卡"不算过"）
const AC_FINGERPRINT = (() => {
  const parts = []
  for (const a of ACCEPT) {
    const ac = parseExecAC(a)
    if (!ac) continue
    parts.push(ac.cmd)
    const p = scriptOf(ac.cmd)
    if (!p) continue
    const abs = isAbsolute(p) ? p : resolve(PROJECT, p.replace(/^\.?[\\/]/, ''))
    try { parts.push(createHash('sha256').update(readFileSync(abs)).digest('hex')) } catch { /* 脚本不在就不进指纹 */ }
  }
  return parts.length ? 'sha256:' + createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 32) : null
})()

// ---------------------------------------------------------------- 落盘

mkdirSync(OUTDIR, { recursive: true })
const cardPath = join(OUTDIR, `${TASK}.md`)
const promptPath = join(OUTDIR, `${TASK}.prompt.txt`)
const receiptPath = join(OUTDIR, `${TASK}.dispatch.json`)
writeFileSync(cardPath, cardBody, 'utf8')
writeFileSync(promptPath, prompt, 'utf8')

const receipt = {
  schema: 1,
  generatedAt: new Date().toISOString(),
  task: TASK,
  role: ROLE,
  roleLine,
  model: P.model,
  reasoningEffort: P.effort,
  // ★ 2026-10-16（任务分级 L1–L4）：级号与它带来的三件事，全部如实落盘（防"看板显示 max、实际跑 L1"）
  level: LEVEL?.key ?? null,
  levelRaw: LEVEL?.raw ?? null,
  levelShape: LEVEL ? LEVEL_SHAPE : null,          // slim / std / full
  levelGate: LEVEL ? LEVEL_GATE : null,            // ac / quick / full —— 门禁.mjs 读这里决定 scope
  levelSteps: LEVEL ? LEVEL_STEPS : null,          // **参考规模**（≤10 / ≤30 / ≤60 / null（不限））—— ★ b201：**不是限额**，全项目零判决消费（只落盘/展示）
  modelSource: P.modelSource ?? null,              // level-override / task-override / prefer / quota-failover
  // ★ 2026-10-23（施工文档 W2 / D14）：这个模型的能力（卡头写的就是它；`unknown` 时两值为 null，**不是 16384**）
  capacity: CAP ? { found: CAP.found, contextWindow: CAP.contextWindow, maxOutputTokens: CAP.maxOutputTokens, source: CAP.source, at: CAP.at, stale: CAP.stale } : null,
  // ★ 2026-10-23（施工文档 D5）：静态验收校验的结论（挡下就不会有这份收据了；这里只为"放过/检查了几条"留痕）
  staticAC: { ok: STATIC_AC.ok, checked: STATIC_AC.checked, skipped: STATIC_AC.skipped, blocked: STATIC_AC.blocked.map(b => b.why), skippedByFlag: has('skip-ac-check') },
  // ★ 2026-10-23（§4.2）：AC 输出契约的落实情况 ＋ AC 指纹（验收被改过 ⇒ 指纹变 ⇒ 重派的卡不算过）
  acContract: { assertionsMissing: ASSERT_CHECK.missing.length, requireAssert: ASSERT_CHECK.requireAssert, scripts: ASSERT_CHECK.missing.map(m => m.script) },
  acFingerprint: AC_FINGERPRINT,
  // ★ 2026-10-18（七 v2 · MODULE / 调研库 S4-S5）：模块边界与调研命中如实落盘（收口判定与审计都读这里）
  module: MODULE ? { name: MODULE.name, chars: MODULE.chars, file: MODULE.rel, source: MODULE_EXPLICIT ? 'explicit' : 'guess' } : null,
  moduleGuess: MODULE_GUESS.state === 'ambiguous' ? { state: 'ambiguous', names: MODULE_GUESS.names } : MODULE_GUESS.state,
  research: RESEARCH ? { words: RESEARCH.words, total: RESEARCH.total, cited: RESEARCH.hits.length, hits: RESEARCH.hits.map(h => ({ drawer: h.drawer, path: h.path })) } : null,
  worktree: WORKTREE,
  cwd: CWD,
  project: PROJECT,
  wave: WAVE,
  depends: DEPENDS,
  pitfallSearch: {
    vault: VAULT,
    ok: pf.ok,
    keywords: KEYWORDS,
    keywordsSource: KEYWORDS_SOURCE,
    scanned: pf.ok ? mdFiles(VAULT).length : 0,
    hits: pf.ok ? pf.hits.map(h => ({ file: h.file, score: h.score, strong: !!h.strong, why: h.which })) : [],
    embedded: topHits.map(h => h.file),                    // 配了**全文**的（强相关）
    listedOnly: weakHits.map(h => h.file),                 // 只列**标题**的（弱相关）
    droppedStrong: droppedStrong,                          // 强相关但超上限没展开的条数
    verdict: pf.ok
      ? (topHits.length || weakHits.length
        ? `全文 ${topHits.length} 条${weakHits.length ? ` + 标题 ${weakHits.length} 条` : ''}${droppedStrong ? `（另有 ${droppedStrong} 条强相关未展开）` : ''}`
        : '本次无相关老坑')
      : '库读不到（按无老坑处理，但要查库根）'
  },
  files: { card: cardPath, prompt: promptPath, receipt: receiptPath },
  command: cmd,
  // ⚠️ 本脚本不会自己跑班组：拼好、给人看、人点头再跑
  nextSteps: [
    '1. 看收据里的 pitfallSearch.verdict 与 files.card（尤其"相关坑"段落）',
    '2. 确认后执行 command.powershell（它会把 stdout 写进 <TASK>.out.json，绝不接管道）',
    '3. 用 工量账本.mjs add --envelope <TASK>.out.json 回填工量'
  ]
}
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2), 'utf8')

console.log(`[派活] 任务卡 → ${cardPath}`)
console.log(`[派活] 任务正文 → ${promptPath}`)
console.log(`[派活] 收据 → ${receiptPath}`)
console.log(`[派活] 角色：${roleLine}`)
console.log(`[派活] 工作目录：${WORKTREE ? 'worktree ' + WORKTREE : CWD}`)
console.log(`[派活] 先看坑：${receipt.pitfallSearch.verdict}${topHits.length ? '（' + topHits.map(h => h.file).join('、') + '）' : ''}`)
console.log(`[派活] **未调用班组**（本脚本只拼卡与命令）。要跑就执行收据里的 command.powershell。`)
