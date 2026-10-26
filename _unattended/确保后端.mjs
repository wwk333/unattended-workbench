#!/usr/bin/env node
/**
 * 确保「后端 / 开发服务器」在跑 —— **长命资源 D：结构性收口**
 *
 * ## 它治什么病（2026-10-13 实况）
 * 有人在会话里敲了 `npm run dev`（`<示例项目>`，听 3000）⇒ **那个进程归"会话"**，
 * 换会话之后它还在跑、DSH 右上角显示"1 个后台任务运行中 · 48 分 5 秒"，**新会话看不见也停不掉**。
 * 结构性修法：**这类东西不再在会话里手敲**，一律走本脚本 —— detached ＋ 无窗口 ＋ 探活 ＋
 * **登记进 `_crew\服务登记.json`** ⇒ 它归**工作台**（或显式指定的会话），不归"随手敲它的那个终端"。
 *
 * ## 用法
 *   node 确保后端.mjs --project <示例项目>                 # 没在跑就拉起（默认端口 3000、默认命令 `npm run dev`）
 *   node 确保后端.mjs --project <项目> --port 3000 --cmd "npm run dev"
 *   node 确保后端.mjs --project <项目> --probe                    # 只查不启动
 *   node 确保后端.mjs --project <项目> --stop                     # 停掉（杀端口属主那棵进程树）＋ 下架登记
 *   node 确保后端.mjs --project <项目> --wait 60                  # 拉起后最多等 60 秒（默认 30）
 *   · `--owner <会话id>`：谁的活（默认＝环境里的 `DSH_SESSION_ID`，没有就"工作台"）。
 *     写会话id ⇒ **换会话时会被交接**（接管/停掉，见 `登记服务.mjs handover`）；写"工作台" ⇒ 永不交接。
 *   · `--json`：最后一行机器可读（面板/看护用）。
 *
 * ## 口径（与 `确保工具服务.mjs` / `确保路由.mjs` 同一套，别另造）
 *   · **探活＝真连一次 TCP**（不是"看端口在不在列表里"，更不是读命令行）—— 连上才算在跑。
 *   · **幂等**：已经在听就**绝不**再 spawn 第二个（两个 dev server 抢端口＝互相覆盖日志）。
 *   · **无窗口**：`detached + windowsHide + stdio ignore`，输出自己重定向进
 *     `<项目>\_crew\backend-<端口>.log`（这也正是当年那个孤儿在写的那个文件）。
 *   · **登记**：只有"确认在听"才登记成"该活着"；起不来就登记成 `stopped` 并如实报错（不让灯一直红着）。
 *   · **fail-soft**：登记失败只告警，绝不影响起服务这件事本身。
 */
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { down, portOwner, up } from './登记服务.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const AS_JSON = argv.includes('--json')
const PROBE_ONLY = argv.includes('--probe')
const STOP = argv.includes('--stop')

const PROJECT = opt('project') ? resolve(opt('project')) : null
const PORT = Number(opt('port', 3000))
const CMD = String(opt('cmd', 'npm run dev'))
const WAIT_SEC = Number(opt('wait', 30))
/** 谁的活：默认跟着"发起它的那个会话"（这样换会话时才有东西可交接）；没有会话上下文就归工作台。 */
const OWNER = String(opt('owner') ?? process.env.DSH_LONG_LIVE_OWNER ?? process.env.DSH_SESSION_ID ?? '工作台')

const log = (s) => { if (!AS_JSON) console.log(s) }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 真连一次 TCP：连上＝在跑。**不读命令行、不看散文。** */
function portListening (port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let s
    const done = (v) => { try { s?.destroy() } catch {}; resolve(v) }
    try { s = net.connect({ host: '127.0.0.1', port }) } catch { return resolve(false) }
    s.setTimeout(timeoutMs)
    s.once('connect', () => done(true))
    s.once('timeout', () => done(false))
    s.once('error', () => done(false))
  })
}

if (!PROJECT || !existsSync(PROJECT)) {
  const msg = PROJECT ? `项目目录不存在：${PROJECT}` : '缺 --project <项目目录>'
  if (AS_JSON) process.stdout.write(JSON.stringify({ ok: false, state: 'red', why: msg }) + '\n')
  else console.log('用法：node 确保后端.mjs --project <项目目录> [--port 3000] [--cmd "npm run dev"] [--probe|--stop]')
  process.exit(1)
}

const NAME = `后端:${basename(PROJECT)}:${PORT}`
const LOG_DIR = join(PROJECT, '_crew')
const LOG_FILE = join(LOG_DIR, `backend-${PORT}.log`)
const result = { name: NAME, project: PROJECT, port: PORT, owner: OWNER, cmd: CMD, logFile: LOG_FILE }

/** 登记（fail-soft）：**只有确认在听才登记成"该活着"**。 */
async function register (expect, note, pid) {
  try {
    const p = pid ?? await portOwner(PORT)
    up({ name: NAME, kind: 'http', port: PORT, pid: p, logFile: LOG_FILE, ensure: '确保后端.mjs', owner: OWNER, expect, note })
    return p
  } catch (e) { log('⚠️ 登记失败（不影响起服务）：' + String(e?.message ?? e)); return null }
}

// ── 停：杀"端口属主"那棵进程树 ＋ 下架登记（**只杀这个端口上的那个**，不滥杀）
if (STOP) {
  const pid = await portOwner(PORT)
  let killed = false
  if (pid) { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15000, windowsHide: true, stdio: 'ignore' }); killed = true } catch {} }
  try { down(NAME, { note: `确保后端 --stop（killed=${killed}）` }) } catch {}
  result.stopped = { pid, killed }
  result.state = 'red'
  result.ok = true
  if (AS_JSON) process.stdout.write(JSON.stringify(result) + '\n')
  else log(pid ? `已停 ${NAME}（pid ${pid}${killed ? '，进程树已杀' : '，杀失败'}）` : `${NAME}：${PORT} 本来就没人在听`)
  process.exit(0)
}

const before = await portListening(PORT)
if (before) {
  const pid = await portOwner(PORT)
  const isOurs = await probeOurs(pid)
  result.state = 'green'; result.ok = true; result.started = false; result.wasRunning = true; result.pid = pid
  if (!PROBE_ONLY) result.registeredPid = await register('running', `已在跑（${PORT}）—— 由"确保后端"确认并登记${isOurs ? '' : '（⚠️ 这个端口上跑的**不是**本脚本起的那条命令，可能是别人起的，留意）'}`)
  if (AS_JSON) process.stdout.write(JSON.stringify(result) + '\n')
  else log(`已在跑（${PORT} 在听，pid ${pid ?? '?'}）→ 不重复启动${PROBE_ONLY ? '（--probe：只查不登记）' : '；已登记'}`)
  process.exit(0)
}

if (PROBE_ONLY) {
  result.state = 'red'; result.ok = false; result.why = `${PORT} 没人听（后端没在跑）`
  if (AS_JSON) process.stdout.write(JSON.stringify(result) + '\n')
  else log(result.why)
  process.exit(1)
}

// ── 起：detached ＋ 无窗口 ＋ 输出重定向进 `<项目>\_crew\backend-<端口>.log`
//
// ⚠️ **2026-10-16 实测定下的写法**（三条路都真跑过，别改回去）：
//   · `spawn('cmd.exe', ['/c', '<命令> >> 日志 2>&1'], { detached:true, stdio:'ignore' })`
//     ⇒ **什么都不发生**：cmd 起了、日志**连文件都不建**（detached 下 cmd 的执行被架空）。
//   · `spawn('cmd.exe', [...], { detached:true, stdio:['ignore', fd, fd] })`
//     ⇒ 文件建了但**永远是空的**（detached 的子进程拿不到父进程给的 fd）。
//   · `spawn(..., { detached:false, stdio:['ignore', fd, fd] }).unref()`
//     ⇒ 有输出，但**父进程一退它就死**（实测：父退出后端口就没了）—— 那就不是"长命资源"了。
//   ✅ **能用的是这个**：写一个**批处理包一层**（重定向写在批处理里），再用
//     `cmd /d /s /c start /b "" <批处理>` ＋ `detached:true` 起它 —— 实测**父进程退出后仍在听**、
//     日志也照写（`start /b` 不弹新窗口；再叠 `windowsHide` 双保险）。
log(`没探到（${PORT} 没人听）→ 拉起：${CMD}（cwd=${PROJECT}，日志 ${LOG_FILE}）`)
try { mkdirSync(LOG_DIR, { recursive: true }) } catch {}
const WRAPPER = join(LOG_DIR, `backend-${PORT}.cmd`)
/**
 * ⚠️ **2026-10-16 实测逮到的 bug（就在异次元这种中文项目根上）**：批处理与 `start` 的**命令行里不许出现非 ASCII**：
 *   · `spawn('cmd.exe', ['/c','start','/b','""','<示例项目>\\_crew\\backend-3000.cmd'])` ⇒ **静默什么都不发生**
 *     （`start` 按 OEM 码页解析命令行，中文路径被读花 → 找不到文件 → 而 stdio 是 ignore ⇒ 连报错都看不见）。
 *     ASCII 路径（`%TEMP%` 那种）**看不出这个问题** —— 所以夹具跑绿不代表真项目能起（这正是本条的教训）。
 *   · 修法有两条，一起用：① **命令行只给相对路径**（`_crew\backend-3000.cmd`，cwd 由 Node 的 `spawn cwd` 给，
 *     Node 传 Unicode 路径没问题）；② **批处理内容也只用 ASCII**（日志写相对路径 `_crew\backend-3000.log`）。
 *     批处理的 `cd /d "<中文路径>"` 能不能读对**取决于调用方的码页**（实测：UTF-8 控制台下能、GBK 下不能）⇒ 不用它。
 */
const WRAPPER_REL = relative(PROJECT, WRAPPER).replace(/\//g, '\\')
const LOG_REL = relative(PROJECT, LOG_FILE).replace(/\//g, '\\')
try {
  const banner = [
    '@echo off',
    `rem generated by the "ensure backend" script in _unattended at ${new Date().toISOString()} -- do not edit; re-run it to change the command`,
    'rem ASCII ONLY on purpose: cmd.exe reads .cmd in the OEM codepage, so any non-ASCII here can be garbled',
    'rem (measured 2026-10-16: a Chinese project path made "start" silently do nothing). cwd comes from spawn(cwd).',
    `${CMD} > "${LOG_REL}" 2>&1`
  ]
  writeFileSync(WRAPPER, banner.join('\r\n') + '\r\n', 'utf8')
} catch (e) {
  result.state = 'red'; result.ok = false; result.why = '写批处理包一层失败：' + String(e?.message ?? e)
  if (AS_JSON) process.stdout.write(JSON.stringify(result) + '\n')
  else log('❌ ' + result.why)
  process.exit(1)
}
let child
try {
  // ⚠️⚠️ **2026-10-16 实测第二修（用户看到"一堆黑框"）**：**不许用 `start`**！
  //   `spawn('cmd.exe', ['/d','/s','/c','start','/b','""',WRAPPER_REL], …)` 实测的后果是：
  //   `start` 运行 .cmd 时用的是 **`cmd /K`**（不是 `/C`）⇒ 每个后端都开一个**可见控制台**、
  //   而且跑完还**停在提示符上不关**（一次实测留了 6 个黑框，用户直接截图过来）。
  //   `/b` 只保证"不新开窗口跑命令"，管不住 `start` 自己给 .cmd 配的那个控制台。
  //   ⇒ 正确写法：**直接 `cmd /d /s /c <批处理>`**（`/c` ⇒ 跑完就退），再叠
  //     `detached: true`（活过本进程）＋ `windowsHide: true`（CREATE_NO_WINDOW ⇒ 没有可见窗口）。
  child = spawn('cmd.exe', ['/d', '/s', '/c', WRAPPER_REL], {
    cwd: PROJECT, detached: true, windowsHide: true, stdio: 'ignore', env: { ...process.env }
  })
  child.once('error', (e) => log('拉起失败（不影响调用方）：' + String(e?.message ?? e)))
  child.unref()
  result.spawnPid = child.pid
  result.wrapper = WRAPPER
  result.started = true
} catch (e) {
  result.state = 'red'; result.ok = false; result.why = '拉起异常：' + String(e?.message ?? e)
  if (AS_JSON) process.stdout.write(JSON.stringify(result) + '\n')
  else log('❌ ' + result.why)
  process.exit(1)
}

// 等它真的听上（**嘴上说成功不算**）：默认最多 30 秒
let ok = false
const t0 = Date.now()
while ((Date.now() - t0) / 1000 < WAIT_SEC) {
  await sleep(500)
  if (await portListening(PORT)) { ok = true; break }
}
result.waitedSec = Math.round((Date.now() - t0) / 1000)
if (ok) {
  result.state = 'green'; result.ok = true
  result.pid = await register('running', `由"确保后端"拉起（${result.waitedSec}s 后探到在听）`, await portOwner(PORT))
  log(`✅ ${result.waitedSec}s 后探到在听（pid ${result.pid ?? '?'}）—— 已登记，归 ${OWNER}`)
} else {
  result.state = 'red'; result.ok = false
  result.why = `拉起后 ${WAIT_SEC}s 内 ${PORT} 仍没人听 —— 看日志：${LOG_FILE}`
  await register('stopped', `拉起后 ${WAIT_SEC}s 未探到在听（未登记为"该活着"）`, null)
  log('⚠️ ' + result.why)
}

if (AS_JSON) process.stdout.write(JSON.stringify(result) + '\n')
process.exit(ok ? 0 : 1)

/** 这个端口上跑的到底是不是"我们这条命令"起的 —— 只用于**提醒**，不参与判活。 */
async function probeOurs (pid) {
  if (!pid) return true
  try {
    const { listeningPorts } = await import('./登记服务.mjs')
    const l = listeningPorts().find((x) => Number(x.port) === PORT)
    if (!l) return true
    return /npm|node|tsx|vite|next|pnpm|yarn/i.test(String(l.cmd ?? ''))
  } catch { return true }
}
