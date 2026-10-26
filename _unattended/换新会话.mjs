#!/usr/bin/env node
/**
 * 自动换新会话（无人值守版）—— 大脑上下文到点就收尾 → 开新会话 → 接力
 *
 * 为什么需要它（三条事实，前两条来自工作台实测、第三条本轮在 0.2.0 上验证）：
 *   1. **只有大脑会涨上下文** —— 班组（Qoder CLI）每次派活新起进程、用完即退，天然不累积。
 *   2. **goal 绑死在会话上、不能继承** → 新会话必须由脚本发一条 prompt，让大脑自己**重建 goal**。
 *   3. **大脑自己没有"开新会话"的工具** → 只能由外部脚本调**宿主 RPC**。
 *
 * 本轮在 0.2.0 桌面端实测通过的 RPC（权威契约来自 `sessionController` 服务签名）：
 *   session/list    { cursor? } → { items: SessionSummary[] }
 *                   SessionSummary 里有 running / blank / cwd / agentAvailable /
 *                   projections.values.contextPressure{pressureTokens,projectedTokens,contextWindow}
 *                   ＋ goal{goal.phase,roundsStarted} ＋ tokenUsage ＋ sessionStats
 *   session/create  { workspaceId?, cwd?, sessionId?, agentPreset? } → { sessionId, agentPreset? }
 *   session/prompt  { requestId, sessionId, mode:'queue'|'steer', content:[{type:'text',text}] } → { accepted:true }
 *   session/cancel  { sessionId } → { accepted:true }
 *   （信封：POST /api/<method>，body {type:'client-request',rpcId,method,payload:{args:{request}}}
 *     鉴权：GET /?token=<启动日志里的 token> 收 Set-Cookie，之后 /api 只认 cookie）
 *
 * ⚠️ **默认 --dry-run**：只报告"该不该换、会怎么做"，**不真换**。
 *    真换会把当前会话掐断（新话题接着干），必须显式 `--execute`。
 *
 * 用法：
 *   node 换新会话.mjs                  # 干跑一次：读出占用与判定，不动作
 *   node 换新会话.mjs --json            # 机器可读
 *   node 换新会话.mjs --execute         # 真换（若到阈值）
 *   node 换新会话.mjs --execute --now    # 不看阈值，立刻换一遍（手动测试用）
 *   node 换新会话.mjs --watch            # 常驻看守（默认 60 秒一轮，到点自动换）
 *   node 换新会话.mjs --soft 0.7 --hard 0.85
 *   node 换新会话.mjs --execute --now --permission danger-full-access   # 权限（默认值就是它）
 *   node 换新会话.mjs --execute --permission ''                          # 不设权限（保留 workspace-write）
 *   node 换新会话.mjs --execute --wait-coders 600                       # 等 coder 干完的超时（默认 300s）
 *
 * ⚠️ **换会话不继承权限**（2026-10-07 实测 + 官方口径）：`session/create` 只吃 deployment 的
 *    `permission.defaultPreset`（= `workspace-write`/`ask`），**源会话的 `danger-full-access` 传不过来**。
 *    所以本脚本在"建完会话"与"发接力指令"之间**必须**补一条 `/permission <preset>`
 *    （`--permission`，默认 `danger-full-access`），否则新会话写不出 cwd 以外的文件
 *    （而接力指令偏偏要它写 `<工作台根>\进度.md` 与知识库）。
 *
 * ⚠️ **换会话会甩掉正在跑的 coder**（2026-10-07 用户指出）：原版直接收尾换人，coder-a/coder-b
 *    的回执没人收。现在收尾之前**先等 coder 干完**（查 `<项目>\_crew\running\` 有没有锁文件），
 *    等到 `--wait-coders`（默认 300s）为止；到时还没干完就照换，但把"甩掉了谁"写进日志和账本。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, resolveRole } from './_agents-config.mjs'
import { acquireLock, LOCK_FILE } from './_lock.mjs'
// ★ b90：收尾核验（"这具会话是不是归档" ＋ "收尾到底发生没有"）——判据只有一处，见那个文件的头注
import { readArchivedSessionIds, transcriptOf, wrapVerdict } from './交接核验.mjs'
import { readTranscriptTail } from './面板/大脑会话.mjs'
// ★ b91「谁动谁叫」：换会话交接完 ⇒ 叫一声长命资源巡检（owner 刚换过，状态文件要当场变新）
import { pokeInspection } from './长命资源巡检.mjs'
// ★ 2026-10-17（升 0.2.1）：宿主端口不再固定 19387（桌面端改成系统分配端口）⇒ 统一入口
import { hostPortSync } from './_宿主端口.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, '..')
const LOG = join(HERE, 'logs', 'swap.log')

const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
function opt (n, d = null) { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const num = (n, d) => { const v = opt(n); if (v == null) return d; const x = Number(v); return Number.isFinite(x) ? x : d }

const HOST = opt('host', '127.0.0.1')
const PORT = Number(opt('port', process.env.DSH_PORT ?? hostPortSync()))
const SOFT = num('soft', 0.60)   // ★ 2026-10-07 用户调低：65% → 60%（更早开始换——**60% 就已经会换**，
                                 //   不是"准备"；唯一的闸是"有 coder 在跑"⇒ 那轮不换、60s 后再看。见 L539-595）
const HARD = num('hard', 0.75)  // ≥75% ⇒ **不再等**（waitForCoders 超时 300s→120s，到点照换）
const EXECUTE = has('execute')
const NOW = has('now')
const WATCH = has('watch')
const AS_JSON = has('json')
const INTERVAL_SEC = num('interval', 60)
const WAIT_IDLE_SEC = num('wait-idle', 180)
const NEW_PRESET = opt('preset', process.env.DSH_SWAP_PRESET ?? 'unattended')
const SESSION_ID = opt('session', null)      // 想盯的会话；不给就自动挑"大脑"
const WAIT_CODERS_SEC = num('wait-coders', 300)   // ★ 等 coder 干完的超时（默认 5 分钟）
const WAIT_CODERS_POLL_SEC = num('wait-coders-poll', 10)  // 轮询间隔
const GRACE_PERIOD_SEC = num('grace-period', 120)  // ★ 宽限期：刚派出去的任务至少等这么久再决定换不换
const SWAP_COOLDOWN_SEC = num('cooldown', 120)    // ★ 换完之后的冷却期（防 60s 循环刷会话）
// ★ 2026-10-07 修（用户实测指出）：
//   `sessionController.create()` **不接受权限参数** —— 它只吃 deployment 的
//   `permission.defaultPreset`（= `workspace-write` + `approval:ask`）。
//   实测证据：旧会话 `3d5d4b0c` 日志里有
//     `command/run {name:'permission', args:' danger-full-access'}` → `permission/preset{danger-full-access}`
//     → `sandbox/mode{danger-full-access}` + `approval/policy{never}`
//   而换出来的新会话 `2deb7d74` 只有 `permission/preset{workspace-write}` + `approval/policy{ask}`
//   ⇒ **换会话不继承权限**：新会话被钉在 workspace-write，写不出 cwd 以外的文件
//     （而接力指令要它写 `<工作台根>\进度.md` 与知识库 ⇒ 必然失败）。
//   权威口径（app.asar 内 `@deepseek-ai/dsh-permission-presets` 文档）：
//     "Session creation reads `defaultPreset`… Later settings changes never alter an existing session."
//     "Users switch through the `/permission` command: a bare invocation reports the current preset…"
//   ⇒ 唯一可行修法：**建完会话后，主动给新会话发 `/permission <preset>`**，再发接力指令。
const PERMISSION = opt('permission', process.env.DSH_SWAP_PERMISSION ?? 'danger-full-access')
const PERMISSION_SETTLE_MS = num('permission-settle', 1500)
/**
 * ★ b90：**归档会话换不得** —— 归档的语义就是"连唤醒都挡"：DSH 的 `agent/pre-step` 对归档会话直接
 * `reject` ⇒ 一轮被判 `blocked` ⇒ 收尾指令**投递成功也会被丢掉**（2026-10-16 实测：投递 → turn 起 →
 * 15ms 后 `turn/end{blocked}`）。所以：① 自动挑"大脑"时**跳过归档**；② 显式点名一具归档会话 ⇒ **拒绝换**。
 * `--allow-archived` 是留给"就是要拿归档会话做实验"的逃生口（会如实把核验不过写进日志/留痕）。
 */
const ALLOW_ARCHIVED = has('allow-archived')
const ARCHIVED = readArchivedSessionIds()          // Set | **null**（null ＝ 没读到 ⇒ 如实说"没能核对"）
const WRAP_WAIT_SEC = num('wrap-wait', 180)        // 等"收尾真的发生"的上限
const PROGRESS_FILE = join(WORKSPACE, '进度.md')

const log = (...a) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${a.join(' ')}`
  try { mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, line + '\n', 'utf8') } catch {}
  if (!AS_JSON) console.log(line)
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------- host 交互
//
// ⚠️ 桌面端**不能**直连：它的鉴权 token 只在 Electron 壳与内置窗口之间流转
//    （实测 `GET /` 与 `/api/*` 一律 401，启动日志里也没有 token；
//      而 CLI 起的实例会打印 `dsh web: …?token=…`，所以工作台那套脚本在这边不适用）。
//
// 解法：桌面端**加载了我的宿主插件** `dsh-board-sidebar`，它在 Host 进程内开了个
//       **只监听 127.0.0.1** 的小口子（`POST http://127.0.0.1:19390/swap`），
//       带 `x-dsh-swap-token` 头即可调 sessionController（list/create/prompt/cancel）。
//       token 在 `_unattended\secrets\swap-token.txt`，由插件自己生成。
//
// ★ 2026-10-07：token 文件从 `_unattended\swap-token.txt` **挪进 `secrets\`**（口径见
//   `secrets\README-密钥怎么放.md`）。**四处必须同时改**（插件 `bridge-plugin\lib\index.js`
//   + 本文件 + `进度看护.mjs` + `看板数据.mjs`），少改一处 = 插件落一个 token、脚本读另一个 → 全 401。

const BRIDGE = `http://${opt('bridge-host', '127.0.0.1')}:${Number(opt('bridge-port', process.env.DSH_SWAP_PORT ?? 19390))}/swap`
const SWAP_TOKEN_FILE = process.env.DSH_SWAP_TOKEN_FILE ?? join(HERE, 'secrets', 'swap-token.txt')

let SWAP_TOKEN = null
let rpcSeq = 0

function readSwapToken () {
  if (!existsSync(SWAP_TOKEN_FILE)) {
    throw new Error(`读不到桥的 token：${SWAP_TOKEN_FILE}\n`
      + '  → 说明桌面端的桥插件还没起来。检查：\n'
      + '    1) 桌面端是否**重启过**（插件是启动时加载的，加完必须重启一次）\n'
      + '    2) 插件是否装载：看桌面端起没起、或跑一次 _unattended\\安装preset.mjs 的预检逻辑\n'
      + '    3) 端口 19390 是否被占（插件会只在日志里报一行，不影响界面）')
  }
  return readFileSync(SWAP_TOKEN_FILE, 'utf8').trim()
}

async function bridge (op, extra = {}) {
  if (!SWAP_TOKEN) SWAP_TOKEN = readSwapToken()
  let r
  try {
    r = await fetch(BRIDGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-dsh-swap-token': SWAP_TOKEN },
      body: JSON.stringify({ op, ...extra })
    })
  } catch (e) {
    throw new Error(`连不上换会话桥（${BRIDGE}）：${e?.message ?? e}\n`
      + '  → 桥由宿主插件 dsh-board-sidebar 提供，**桌面端重启一次**才会起来。\n'
      + '    确认：① 桌面端已重启；② 插件装载了（cordis.patch.yml 里有 board-sidebar 那节）；\n'
      + '          ③ 端口 19390 没被别的程序占用。')
  }
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch {}
  if (r.status === 401) throw new Error('桥拒绝：token 不对（可能插件重启后换了 token，重读 swap-token.txt）')
  if (!j) throw new Error(`桥返回非 JSON（HTTP ${r.status}）：${t.slice(0, 200)}`)
  if (!j.ok) throw new Error(`桥执行 ${op} 失败：${j.error ?? JSON.stringify(j).slice(0, 200)}`)
  return j.value
}
/** 与 bridge() 相同的鉴权/错误处理，但**返回整封响应**（含 `_workspace` 这类顶层字段）。 */
async function bridgeRaw (op, extra = {}) {
  if (!SWAP_TOKEN) SWAP_TOKEN = readSwapToken()
  const r = await fetch(BRIDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dsh-swap-token': SWAP_TOKEN },
    body: JSON.stringify({ op, ...extra })
  })
  const t = await r.text()
  let j = null
  try { j = JSON.parse(t) } catch {}
  if (r.status === 401) throw new Error('桥拒绝：token 不对（重读 swap-token.txt）')
  if (!j) throw new Error(`桥返回非 JSON（HTTP ${r.status}）：${t.slice(0, 200)}`)
  if (!j.ok) throw new Error(`桥执行 ${op} 失败：${j.error ?? JSON.stringify(j).slice(0, 200)}`)
  return j
}

const listSessions = async () => (await bridge('list')).items ?? []
// ★ 2026-10-07（第三条缺陷：「新会话没起在异次元下面」）：
//   `session/create` 的 `workspaceId` 与 `cwd` 是**两个独立字段** —— 只传 `cwd` 时
//   文件系统对、但**侧栏分组仍是「未分组」**。桥的 `create` 现在会自动按 cwd
//   解析工作区并把 `workspaceId` 一起传进去（见 bridge-plugin\lib\index.js），
//   这里把桥回的 `_workspace` 一并取回来**打日志**，事后能核对"起在哪个分组"。
const createSession = async (agentPreset, cwd) => {
  const full = await bridgeRaw('create', { agentPreset, cwd })
  return { ...(full.value ?? {}), _workspace: full._workspace ?? null, _passed: full._passed ?? null }
}
const sendPrompt = (sessionId, text, mode = 'queue') =>
  bridge('prompt', { requestId: `swap-${Date.now()}`, sessionId, mode, text })
const cancelSession = (sessionId) => bridge('cancel', { sessionId })
// ★ 2026-10-07：人类命令（`/permission` 等）**不能走 prompt**（实测：只会变成一条普通
//   `user/message`，日志里没有 `command/run` ⇒ 权限一个字都没变）。
//   必须走宿主 `ctx.commands.execute()` —— 桥为此新增了 `op:'command'`（见 bridge-plugin\lib\index.js）。
const runCommand = (sessionId, line) => bridge('command', { sessionId, line })

// ---------------------------------------------------------------- 判定

/** 从 SessionSummary 里算出上下文占用比。 */
function pressureOf (it) {
  const cp = it?.projections?.values?.contextPressure
  if (!cp || !cp.contextWindow) return null
  const used = cp.projectedTokens ?? cp.pressureTokens
  if (!Number.isFinite(used)) return null
  return { ratio: used / cp.contextWindow, used, window: cp.contextWindow, pressureTokens: cp.pressureTokens ?? null, projectedTokens: cp.projectedTokens ?? null }
}

/**
 * 挑"大脑"会话。
 *
 * ★ 2026-10-07 修（用户报 BUG："一直在新建会话"）：
 *   原版只看"有没有 goal 字段"（`i?.projections?.values?.goal`），
 *   **paused / complete 的 goal 也算** ⇒ 换掉的旧会话（goal=paused、占用 78%）
 *   永远赢过新会话（goal=active、占用 0%）⇒ **每 60 秒换一次，无限刷会话**。
 *
 *   修法：**只挑 `goal.phase === 'active'` 的会话**（真正在干活的大脑）。
 *   如果没有 active 的，才回退到"有 goal 的"（处理 brain 手动 pause 但还在干活的情况）。
 *   再没有才回退到所有非 blank 会话。
 *
 *   排序：每层内按占用**从大到小**（优先换快满的那个）。
 */
function pickBrain (items) {
  // ★ b90：**排除已归档会话** —— 归档的会话收不了尾（DSH 拒它的每一步），挑中它=白换一次。
  const isArchived = (id) => Boolean(ARCHIVED && ARCHIVED.has(String(id)))
  const cands = items.filter(i => !i.blank && !i.origin && !i.parentSessionId && !isArchived(i.sessionId))
  const phase = (i) => i?.projections?.values?.goal?.goal?.phase ?? null
  const active = cands.filter(i => phase(i) === 'active')
  const withGoal = cands.filter(i => i?.projections?.values?.goal)
  // 优先级：active goal > 任何 goal > 全部
  const pool = active.length ? active : (withGoal.length ? withGoal : cands)
  return pool
    .map(i => ({ it: i, p: pressureOf(i) }))
    .sort((a, b) => (b.p?.used ?? 0) - (a.p?.used ?? 0))[0] ?? null
}

// ---------------------------------------------------------------- 换会话流程

const WRAP_PROMPT = (p) => `【系统：上下文即将到点，请收尾】
你的上下文已用到 ${(p.ratio * 100).toFixed(1)}%（soft ${(SOFT * 100).toFixed(0)}% / hard ${(HARD * 100).toFixed(0)}%）。接下来会开一个**新会话**接力，本会话即将停止。

现在只做四件事，不要开新工作：
1. **暂停你的 goal**（调 \`update_goal\` action=pause）—— 不暂停的话换会话脚本会反复挑中你、无限刷新会话（实测踩过）；
2. 把当前进度**写进** \`${WORKSPACE}\\进度.md\` 的「当前断点」（做到哪、下一步、卡在哪、怎么回滚）。⚠️ **本文只留"现状与断点"**；历史过程已搬去 \`${WORKSPACE}\\文档\\进度-历史留痕.md\`，要写历史请写那边；
3. 这一轮踩到的**新坑**：按四段式（现象/根因/对策/证据）写进 \`<知识库>\\坑\\\`，然后跑 \`索引生成器.mjs\` 重算索引；
4. 回复一句话：「已收尾，可以换会话」，然后就**停下**。`

const HANDOVER_PROMPT = (oldTitle, p, coderWait) => `你是「无人值守模式」的大脑，接手一个**新会话**（上一个会话上下文用到 ${(p.ratio * 100).toFixed(1)}% 已收尾）。

【第一步：先自己把目标建回来】
上个会话的 goal 里有开工目标。**先读** \`${WORKSPACE}\\进度.md\` 的「当前断点」（★ 只讲现状；历史过程在 \`文档\\进度-历史留痕.md\`，需要查"当时为什么这么改"再去那份），
看清楚：做到哪一步、下一步是什么、卡在哪、怎么回滚。然后调 \`create_goal\` **重建目标**
（objective 就照**当前断点**写，例："继续按 \`<工作台根>\\进度.md\` 的当前断点推进无人值守工作台：先解当前卡点，严格顺序，每步先备份、一次只改一处、改完真启动验证"；★ 2026-10-07 更正：旧模板写的是"按 方案.md §9 落地路线**继续施工**" —— 施工期早已走完，照那个写会得到过期目标）。
${coderWait && coderWait.cards > 0 ? `
⚠️ **上一个会话换人时有 ${coderWait.cards} 个 coder 还在跑、被甩掉了**。先查 \`<项目>\\_crew\\runs\\swap-interruption.json\`（中断收据，记了"甩掉了谁"），
再查 \`<项目>\\_crew\\runs\\<时间戳>\\tasks\\\` 下对应的 \`.out.json\` 与 \`.err.txt\`，**手动收活并判定**，把结果写进台账。
` : ''}
【第二步：按断点接着干】
- 施工顺序**不能换**；每完成一个子步就更新「当前断点」；
- 碰配置前先备份；施工类操作**在会话里逐步报一行**，不要走手机；
- 需要我拍板的事（真派班组 / 推手机 / 改我的文档）**停下来问**，不要自己决定。

【上一会话】标题：${oldTitle}`

// ---------------------------------------------------------------- 安全点判定（等 coder 干完）
//
// ★ 2026-10-07 两次补（用户连续指出两个死角）：
//   ① "大脑 68% 了，应该先等 coder 干完还是直接中断？" → 原版直接中断，coder 成果会丢。
//   ② "活刚派出去就到阈值怎么办？" → 原版等 300s 就甩，刚起步的任务必被甩掉。
//
// 修法（三条一起）：
//   A. **软阈值不换**：只有 `ratio >= HARD` 才真的换；软阈值到但有 coder 在跑 → 本轮跳过。
//   B. **宽限期**：刚派出去的任务（`running\` 里文件 < `--grace-period` 秒）至少等它过了宽限期再决定。
//   C. **中断收据**：到时还没干完就照换，但写一份 `swap-interruption.json` 到 `_crew\runs\`，
//      记录"甩掉了谁"，新会话接力后能照着收活。
//
// 判据（只读，零副作用）：
//   ① `<项目>\_crew\running\<cardId>.json` = 有任务在跑（每条含 childPid + deadlineMs）
//   ② `<项目>\_crew\crew.lock` = 编排进程还在跑
//   两者都没有 = 没人在干活，直接过。

/** 只读探一眼"有没有人在干活"（不等、不改）。 */
function peekCoders (cwd) {
  const cards = []
  try {
    for (const f of readdirSync(join(cwd, '_crew', 'running'))) {
      if (!f.endsWith('.json')) continue
      try {
        const st = statSync(join(cwd, '_crew', 'running', f))
        const obj = JSON.parse(readFileSync(join(cwd, '_crew', 'running', f), 'utf8'))
        cards.push({ file: f, pid: obj.childPid ?? null, deadline: obj.deadlineMs ?? null, age: Math.round((Date.now() - st.mtimeMs) / 1000) })
      } catch { cards.push({ file: f, pid: null, deadline: null, age: -1 }) }
    }
  } catch { /* running 目录不存在 = 没人在跑 */ }
  let lock = null
  try { lock = JSON.parse(readFileSync(join(cwd, '_crew', 'crew.lock'), 'utf8')) } catch {}
  return { cards, lock, hasWork: cards.length > 0 || !!lock }
}

/**
 * 等 coder 干完（收尾之前调）。
 * @param {string} cwd   项目目录
 * @param {boolean} hard 是否已经到硬阈值（hard=true 时等待超时更短，到了就照换）
 */
async function waitForCoders (cwd, hard = false) {
  const first = peekCoders(cwd)
  if (!first.hasWork) {
    log(`  ⓪ 没有 coder 在跑（running\\ 为空、crew.lock 不存在）→ 直接收尾`)
    return { waited: 0, cards: 0, lock: false, interrupted: [] }
  }

  // ★ 宽限期：刚派出去的任务至少等它过了 GRACE_PERIOD_SEC 再决定换不换
  const youngest = first.cards.length ? Math.min(...first.cards.map(c => c.age)) : 0
  const graceNeed = first.cards.length && youngest < GRACE_PERIOD_SEC ? GRACE_PERIOD_SEC - youngest : 0
  log(`  ⓪ 发现 ${first.cards.length} 个 coder 在跑${first.lock ? ' + 编排进程活着' : ''} → 等它们干完`)
  for (const c of first.cards) log(`     · ${c.file}（pid=${c.pid ?? '?'}，已跑 ${c.age}s${c.deadline ? `，deadline 还剩 ${Math.round((c.deadline - Date.now()) / 1000)}s` : ''}）`)
  if (graceNeed > 0) log(`     ⏳ 最近的任务才跑了 ${youngest}s < 宽限期 ${GRACE_PERIOD_SEC}s → 至少再等 ${graceNeed}s`)

  // 等待时长：硬阈值用短超时（没余量了），软阈值用长超时
  const maxWait = hard ? Math.min(WAIT_CODERS_SEC, 120) : WAIT_CODERS_SEC
  if (hard) log(`     ⚠️ 已到硬阈值 → 等待超时缩短为 ${maxWait}s（没余量了，到时就照换）`)

  const t0 = Date.now()
  // 先过宽限期
  if (graceNeed > 0) await sleep(Math.min(graceNeed, maxWait) * 1000)
  // 再轮询等干完
  while ((Date.now() - t0) / 1000 < maxWait) {
    await sleep(WAIT_CODERS_POLL_SEC * 1000)
    const now = peekCoders(cwd)
    if (!now.hasWork) {
      log(`     ✓ 全部干完（等了 ${Math.round((Date.now() - t0) / 1000)}s）`)
      return { waited: Math.round((Date.now() - t0) / 1000), cards: 0, lock: false, interrupted: [] }
    }
  }

  // 超时 → 照换，但写中断收据
  const final = peekCoders(cwd)
  log(`     ⚠️ 等了 ${maxWait}s 还没干完：${final.cards.length} 个任务${final.lock ? ' + 编排还在跑' : ''}`)
  for (const c of final.cards) log(`        · ${c.file}（pid=${c.pid ?? '?'}，已跑 ${c.age}s）`)
  log(`     ⇒ **照换**，写中断收据到 \\_crew\\runs\\swap-interruption.json`)

  // 写中断收据（新会话接力后能照着收活）
  try {
    const receipt = {
      schema: 1,
      at: new Date().toISOString(),
      reason: 'session-swap',
      oldSession: null,   // 调用方会补
      interrupted: final.cards.map(c => ({ file: c.file, pid: c.pid, age: c.age, deadline: c.deadline })),
      orchestrationRunning: !!final.lock,
      note: `换会话时有 ${final.cards.length} 个 coder 还在跑，已被甩掉。请新会话检查 \\_crew\\runs\\ 下对应时间戳目录的 tasks\\*.out.json 与 err.txt，手动收活并判定。`
    }
    const { mkdirSync: mk, writeFileSync: wf } = await import('node:fs')
    const runsDir = join(cwd, '_crew', 'runs')
    mk(runsDir, { recursive: true })
    wf(join(runsDir, 'swap-interruption.json'), JSON.stringify(receipt, null, 2), 'utf8')
    log(`     ✓ 中断收据已写：${join(runsDir, 'swap-interruption.json')}`)
  } catch (e) {
    log(`     ⚠️ 中断收据写失败：${e.message}`)
  }

  return { waited: maxWait, cards: final.cards.length, lock: !!final.lock, interrupted: final.cards }
}

async function swapOnce (brain, p, hard = false) {
  const oldId = brain.it.sessionId
  const oldTitle = brain?.it?.projections?.values?.title ?? '(无标题)'
  const cwd = brain.it.cwd ?? WORKSPACE

  log(`—— 开始换会话${hard ? '（已到硬阈值）' : ''} ——`)
  log(`  旧会话：${oldId}（${oldTitle}）占用 ${(p.ratio * 100).toFixed(1)}%`)

  // 单实例锁：换会话要建新会话、发指令 —— 不能和"编排"同时动手（会状态错乱且难查）。
  // 锁只在**真换**时抢；干跑是只读的，不该互相挡。
  const lock = acquireLock(LOCK_FILE, `换新会话.mjs（旧会话 ${oldId.slice(0, 24)}）`)
  if (!lock.ok) {
    log(`  ⛔ 放弃换会话：${lock.reason}`)
    return { skipped: true, reason: lock.reason }
  }

  // ⓪ ★ 先等 coder 干完（2026-10-07 补）—— 不等的话，正在跑的 coder 会被甩掉
  const coderWait = await waitForCoders(cwd, hard)

  // ① 先让旧会话收尾（写台账 + 落库），等它停到 turn 边界
  if (brain.it.running) {
    log(`  旧会话正在跑 → 先 cancel，避免和收尾指令打架`)
    try { await cancelSession(oldId); log('  已发 cancel') } catch (e) { log('  cancel 失败（可能本来就没在跑）：' + e.message) }
    await sleep(2000)
  }
  log(`  ① session/prompt → 旧会话发"收尾"指令`)
  const sendAt = Date.now()
  const transcript = (() => { try { return transcriptOf(oldId) } catch { return null } })()
  await sendPrompt(oldId, WRAP_PROMPT(p))
  log(`     已投递；接下来**核它真的收尾了**（最多 ${WRAP_WAIT_SEC}s）——"本来就 idle"不算通过`)
  // ⚠️ b90 改法（旧写法是 `if (it && !it.running) break`）：一个**本来就 idle** 的会话第一次检查就满足
  //    ⇒ 5 秒就"通过"，而收尾**可能根本没发生**（2026-10-16 实测：投递成功、turn 起、15ms 后被 blocked）。
  //    现在分两段：①a 先等它**动起来**（转录出现新事件 或 running=true）；①b 再等它停到 turn 边界。
  const goalPhaseOf = (list) => list.find(x => x.sessionId === oldId)?.projections?.values?.goal?.goal?.phase ?? null
  const t0 = Date.now()
  let started = false
  while ((Date.now() - t0) / 1000 < Math.min(WRAP_WAIT_SEC, 90)) {
    await sleep(3000)
    const items = await listSessions()
    const it = items.find(x => x.sessionId === oldId)
    if (it?.running) { started = true; break }
    if (transcript) {
      const t = readTranscriptTail(transcript, 200)
      if (t.ok && t.text && t.text.includes('turn/start') && t.text.length > 0) {
        // 转录里出现"本次投递之后"的事件 ⇒ 它真的被叫起来了（用时间戳判，别只看有没有 turn/start）
        const evs = t.text.split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
        if (evs.some((e) => Number(e?.time ?? 0) >= sendAt)) { started = true; break }
      }
    }
  }
  log(started ? `     ✓ 它动了（${Math.round((Date.now() - t0) / 1000)}s）` : `     ⚠️ ${Math.round((Date.now() - t0) / 1000)}s 内没看到它动`)
  const t1 = Date.now()
  while ((Date.now() - t1) / 1000 < WRAP_WAIT_SEC) {
    await sleep(3000)
    const items = await listSessions()
    const it = items.find(x => x.sessionId === oldId)
    if (it && !it.running) { log(`     ✓ 已停到 turn 边界（共等了 ${Math.round((Date.now() - t0) / 1000)}s）`); break }
  }
  // ①c 核证据：判据全在 `交接核验.mjs`（别在这儿再写一遍）。**核验本身失败不许拖住换会话**（fail-soft）。
  let wrap = { ok: false, level: 'warn', why: '（核验没跑起来）', facts: {} }
  try {
    const itemsAfter = await listSessions()
    let progressMtimeMs = 0
    try { progressMtimeMs = statSync(PROGRESS_FILE).mtimeMs } catch {}
    let tailText = ''
    if (transcript) { const t = readTranscriptTail(transcript, 400); if (t.ok) tailText = t.text }
    wrap = wrapVerdict({ text: tailText, goalPhase: goalPhaseOf(itemsAfter), progressMtimeMs, sendAt, waitedSec: Math.round((Date.now() - t0) / 1000) })
    if (!transcript) wrap.why += '（⚠️ 连它的转录文件都没找到 ⇒ 这次只能靠 goal/进度.md 判，结论偏松）'
    log(wrap.ok ? `     ✅ 收尾核验通过：${wrap.why}` : `     ${wrap.level === 'error' ? '❌' : '⚠️'} 收尾核验**没过**：${wrap.why}`)
  } catch (e) {
    wrap = { ok: false, level: 'warn', why: '核验抛错（不影响换会话）：' + String(e?.message ?? e), facts: {} }
    log('     ⚠️ ' + wrap.why)
  }

  // ② 建新会话（preset 用 unattended；cwd 沿用旧的）
  log(`  ② session/create → { agentPreset:'${NEW_PRESET}', cwd:'${cwd}' }`)
  let created
  try {
    created = await createSession(NEW_PRESET, cwd)
  } catch (e) {
    log(`     ⚠️ 带 preset 建会话失败（${e.message}）→ 退回不带 preset 再试`)
    created = await createSession(undefined, cwd)
  }
  const newId = created.sessionId
  log(`     ✓ 新会话：${newId}（preset=${created.agentPreset ?? '(未回填)'}，建会话传了=${created._passed ?? '?'}，工作区分组=${created._workspace ? (created._workspace.title ?? created._workspace.path) : '**未解析到**（会落「未分组」）'}）`)

  // ②b ★ b88：**资源交接**（长命资源 A–E 里的 B）—— 旧会话名下的长命资源（`owner=旧会话`）默认**接管**给新会话；
  //    **只有点名的才停**（`--handover-stop 名字1,名字2`）。产出 `_crew\换会话交接.json`（留痕，最近 50 笔）。
  //    为什么放在这里：`newId` 刚拿到、旧会话已收尾 ⇒ 这是"归属换人"最准的一刻。
  //    ⚠️ fail-soft：交接失败**绝不许**拖住换会话本身（会话该换还得换），但**要出声**，别吞。
  let handoff = null
  try {
    const { handover } = await import('./登记服务.mjs')
    handoff = handover({
      from: oldId, to: newId, reason: '换会话', wrap,
      stop: String(opt('handover-stop', '') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
    })
    log(`  ②b 资源交接：接管 ${handoff.took.length} 件、停掉 ${handoff.stopped.length} 件；残留 ${handoff.leftover.length} 件${handoff.took.length ? '（' + handoff.took.map((t) => t.name).join('、') + '）' : ''}`)
    if (!handoff.ok) log(`     ⚠️ 交接后仍残留 owner=旧会话 且该跑着的项：${handoff.leftover.join('、')}（判据要求必须为 0）`)
    pokeInspection('事件:换会话交接')   // ★ b91：owner 刚换过 ⇒ 让状态文件当场变新（不等待）
  } catch (e) { log(`     ⚠️ 资源交接失败（不影响换会话）：${e?.message ?? e}`) }

  // ③ ★ 先给新会话**把权限调成与大脑一致**（`/permission <preset>`），再发接力指令。
  //    ⚠️ 顺序不能反：接力指令要它写 `<工作台根>\进度.md` 与知识库（都在 cwd 之外），
  //       若此时仍是 `workspace-write`，它会先撞一次写失败（甚至是静默受限）。
  //    ⚠️ 这是 `/permission` 命令，走的就是**用户手敲那条路**：写 `command/run`
  //       → `permission/preset` → `sandbox/mode` + `approval/policy` 三件套。
  if (PERMISSION) {
    log(`  ③ 桥 op:'command' → 新会话设权限：/permission ${PERMISSION}`)
    try {
      const out = await runCommand(newId, `/permission ${PERMISSION}`)
      log(`     ✓ 结果：${JSON.stringify(out)?.slice(0, 200) ?? 'null'}`)
      await sleep(PERMISSION_SETTLE_MS)   // 等 `permission/preset` + `sandbox/mode` + `approval/policy` 三条落盘
    } catch (e) {
      log(`     ⚠️ 设权限失败（新会话可能仍是 workspace-write）：${e.message}`)
    }
  } else {
    log(`  ③ 跳过设权限（--permission 为空）→ 新会话将沿用 defaultPreset=workspace-write`)
  }

  // ④ 给新会话发"接力"指令（含"先重建 goal"）
  log(`  ④ session/prompt → 新会话发"接力"指令`)
  await sendPrompt(newId, HANDOVER_PROMPT(oldTitle, p, coderWait))

  // ⑤ 记账
  try {
    const ledger = join(HERE, '工量账本.mjs')
    await import('node:child_process').then(({ spawnSync }) => spawnSync(process.execPath, [ledger, 'add',
      '--role', 'brain-swap', '--task', `换会话 ${oldId} → ${newId}`,
      '--context-usage', String(p.ratio), '--ok', 'true',
      '--note', `旧占用 ${(p.ratio * 100).toFixed(1)}%，新 preset=${created.agentPreset ?? '?'}，权限=${PERMISSION ?? '(未设)'}，等coder ${coderWait.waited}s/${coderWait.cards}个甩掉，长命资源接管 ${handoff?.took?.length ?? 0} 件/停 ${handoff?.stopped?.length ?? 0} 件，收尾=${wrap.ok ? 'OK' : (wrap.level === 'error' ? '**未发生**' : '不完整')}${wrap.ok ? '' : '（' + String(wrap.why).slice(0, 80) + '）'}`], { stdio: 'ignore' }))
  } catch {}
  lock.release()
  // ★ 写冷却标记（防 60s 循环刷会话）
  try { writeFileSync(join(HERE, 'logs', 'swap-cooldown.json'), JSON.stringify({ at: Date.now(), oldId, newId }), 'utf8') } catch {}
  // ★ b90：**换了 ≠ 交接成功**。收尾没落实就明说（别让"看着成功"糊过去）。
  if (!wrap.ok) {
    log(`⚠️ 这次换会话**完成了，但旧会话没有收尾**：${wrap.why}`)
    log('   ⇒ 新会话会读到**旧断点**（不是这一轮的真实进度）：要么人工补一句给它，要么下次换之前先看这具会话是不是归档/睡着。')
  }
  return { oldId, newId, created, permission: PERMISSION ?? null, coderWait, wrap, handoff: handoff ? { took: handoff.took.length, stopped: handoff.stopped.length, leftover: handoff.leftover } : null }
}

// ---------------------------------------------------------------- 主流程

async function round () {
  const items = await listSessions()
  const picked = SESSION_ID
    ? { it: items.find(i => i.sessionId === SESSION_ID), p: pressureOf(items.find(i => i.sessionId === SESSION_ID)) }
    : pickBrain(items)

  if (!picked?.it) return { verdict: 'no-session', note: '没找到可盯的会话' }
  // ★ b90：显式点名的会话若**已归档** ⇒ 拒绝换（别演一场"看着成功"的戏）。
  if (ARCHIVED && ARCHIVED.has(picked.it.sessionId) && !ALLOW_ARCHIVED) {
    log(`  ⛔ 会话 ${picked.it.sessionId} **已归档**：DSH 的 agent/pre-step 对归档会话直接 reject ⇒ 收尾必然落空`)
    log(`     ⇒ 本轮**不换**（换别具用 --session <id>；确实要拿它做实验：--allow-archived）`)
    process.exitCode = 2   // 让调用方/计划任务也能看出"这次是被拒的"，不是"安静地成功了"
    return { verdict: 'archived-refused', sessionId: picked.it.sessionId, note: '归档会话不能收尾（DSH 拒绝执行它的每一步）' }
  }
  if (ARCHIVED === null) log('  ⚠️ 读不到归档名单（~/.dsh/storages/workspace.json）⇒ 没法核对这具会话是否已归档，照换，但会如实记"未能核对"')
  if (!picked.p) return { verdict: 'no-pressure', sessionId: picked.it.sessionId, note: '这个会话还没有占用数据（可能一轮都没跑过）' }

  const p = picked.p
  const ratio = p.ratio
  const due = NOW || ratio >= SOFT
  const hard = NOW || ratio >= HARD

  // ★ 冷却期（2026-10-07 修 BUG："一直在新建会话"）：刚换完就再挑、再换 → 无限刷。
  //   简单粗暴但有效：换完之后 SWAP_COOLDOWN_SEC 秒内不再换。
  const { readFileSync: rf } = await import('node:fs')
  const cooldownFile = join(HERE, 'logs', 'swap-cooldown.json')
  try {
    const cd = JSON.parse(rf(cooldownFile, 'utf8'))
    const ago = Math.round((Date.now() - cd.at) / 1000)
    if (ago < SWAP_COOLDOWN_SEC && !NOW) {
      log(`  ⏳ 冷却期（${ago}s 前刚换过，冷却 ${SWAP_COOLDOWN_SEC}s）→ 本轮不换`)
      return { verdict: 'cooldown', cooldownAgo: ago, cooldownSec: SWAP_COOLDOWN_SEC, skipped: 'swap-cooldown' }
    }
  } catch { /* 没有冷却文件 = 没换过 */ }
  const out = {
    schema: 1, checkedAt: new Date().toISOString(),
    sessionId: picked.it.sessionId,
    // ★ b90：**归档核对到底成没成**也要给机器看（`--json` 时人话不打，所以不能只靠日志那一行）
    archivedCheck: { known: ARCHIVED !== null, count: ARCHIVED ? ARCHIVED.size : null, thisSessionArchived: Boolean(ARCHIVED?.has(picked.it.sessionId)) },
    title: picked.it?.projections?.values?.title ?? null,
    running: picked.it.running,
    goal: picked.it?.projections?.values?.goal?.goal
      ? { phase: picked.it.projections.values.goal.goal.phase, roundsStarted: picked.it.projections.values.goal.roundsStarted }
      : null,
    pressure: p, thresholds: { soft: SOFT, hard: HARD },
    verdict: due ? (hard ? 'hard-due' : 'soft-due') : 'ok',
    execute: EXECUTE
  }

  if (!AS_JSON) {
    log(`会话 ${out.sessionId}`)
    log(`  标题：${out.title ?? '(无)'}`)
    log(`  占用：${(ratio * 100).toFixed(2)}%  (${p.projectedTokens ?? p.used} / ${p.window})   阈值 soft ${(SOFT * 100).toFixed(0)}% / hard ${(HARD * 100).toFixed(0)}%`)
    log(`  goal：${out.goal ? out.goal.phase + ' · ' + out.goal.roundsStarted + ' 轮' : '(无)'}   运行中：${out.running}`)
    log(`  判定：${out.verdict}`)
  }

  if (!due) return out

  // ★ 软阈值到了但有 coder 在跑 → 不急着换（2026-10-07 补）。
  //   只有到硬阈值（hard）才真的换；软阈值只是"提醒"，可以等 coder 干完。
  //   `--now` 强制换时跳过这个检查（用户明确要换）。
  if (due && !hard && !NOW) {
    const peek = peekCoders(picked.it.cwd ?? WORKSPACE)
    if (peek.hasWork) {
      const youngest = peek.cards.length ? Math.min(...peek.cards.map(c => c.age)) : 0
      log(`  ⏳ 软阈值到了但有 ${peek.cards.length} 个 coder 在跑${peek.lock ? ' + 编排活着' : ''}（最近的跑了 ${youngest}s）→ **本轮不换**，等它们干完或到硬阈值`)
      return { ...out, verdict: 'soft-due-waiting-coders', running: peek.cards.length, skipped: 'soft-threshold-with-coders' }
    }
  }

  if (!EXECUTE) {
    log(`  **dry-run**：到点了，但没给 --execute → 不动作`)
    return out
  }
  const r = await swapOnce(picked, p, hard)
  return { ...out, swapped: r }
}

if (!WATCH) {
  const r = await round().catch(e => ({ verdict: 'error', error: String(e?.message ?? e) }))
  if (AS_JSON) process.stdout.write(JSON.stringify(r, null, 2) + '\n')
  if (r.verdict === 'error') { log('❌ ' + r.error); process.exit(2) }
  // ★ b90：**被拒要有被拒的退出码**（原来无条件 exit(0)，把"归档会话被拒"也报成"安静地成功"）
  process.exit(r.verdict === 'archived-refused' ? 2 : 0)
}

// 常驻看守
log(`看守启动：每 ${INTERVAL_SEC}s 一轮，阈值 soft ${SOFT} / hard ${HARD}，${EXECUTE ? '**会真换**' : 'dry-run'}`)
let stopped = false
process.on('SIGINT', () => { stopped = true; log('收到中断，退出'); process.exit(0) })
while (!stopped) {
  try { await round() } catch (e) { log('❌ 本轮失败：' + String(e?.message ?? e)) }
  await sleep(INTERVAL_SEC * 1000)
}
