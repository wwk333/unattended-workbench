#!/usr/bin/env node
/**
 * 确保「工具服务」（本机 MCP 工具，19400）在跑 —— **随 DSH**，幂等自愈。
 *
 * ## 为什么是它、为什么归 DSH
 *
 * 19400 提供三个本机工具（查坑 / 核指纹 / 读门禁），**只有 DSH 的 MCP 客户端在用它们** ⇒
 * 语义上就该**跟 DSH 同生共死**（用户 2026-10-11 拍板："改成随 DSH"）。
 * 原先是登录计划任务 `DSH-MCP-Proxy` 起的 —— 那条链的毛病是"登录才起一次、死了不复活"，
 * 而且它以交互式身份跑 node ⇒ **带一个黑框**。两者都在这次改掉了。
 *
 * ✅ **2026-10-11 实跑验证通过**：重启 DSH ⇒ 本脚本被插件调起 ⇒ 19400 就绪、看板灯转绿。
 *
 * ## 谁调它
 *   ① `dsh-crew-bridge` 插件启动时（与 `ensurePanel()` 同一个模式、同一处，别另造一套）
 *   ② 看板顶部「工具服务 ●」红灯时点击（手动拉起）
 *   ③ 人手动跑
 *
 * ## 用法
 *   node 确保工具服务.mjs            # 检查 + 拉起（幂等，跑几次都行）
 *   node 确保工具服务.mjs --probe    # 只查不启动
 *   node 确保工具服务.mjs --json     # 机器可读（看板用）：{"ok":true,"state":"green"|"red",...}
 *   node 确保工具服务.mjs --stop     # 停掉（杀进程）
 *
 * ## 口径（照抄 `确保看守.mjs` 与插件的 `ensurePanel()`，它们踩过的坑都在注释里）
 *   · **探活用 HTTP 真发一次 `tools/list`**，不是"探进程命令行" —— 后者是本工作台**明令禁止**的
 *     "读散文取状态"（八·S7）；也不只看端口：端口被别的东西占了，探活会失败 ⇒ 如实报红，不去抢。
 *   · **幂等**：活着就**绝不** spawn 第二个（端口会打架、日志互相覆盖）。
 *   · **无窗口**：`windowsHide: true` ＋ `stdio: 'ignore'`（日志由服务自己写文件）。
 *   · **fail-soft**：起不来只告警一行，绝不抛给调用方（看板/插件都不许被它拖垮）。
 *
 * ⚠️ **一个如实记下的限**：本脚本的落盘日志**只覆盖"手动/看板拉起"这条路**——
 *   2026-10-11 重启 DSH 那次**插件调它**的调用，在 `logs\确保工具服务.log` 里**没留下记录**
 *   （功能是好的：19400 起来了、灯绿了；**只是日志没记上**）。
 *   已定：**不追了**（用户 2026-10-11 选 A）—— 等它下次真出问题、有现场时再一起修。
 *   ⇒ **别把这份日志当成"插件那条路一定被记下了"**。
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// ★ b88（长命资源 A）：**起完就登记**（登记册只由 `登记服务.mjs` 写，这里只是调用它的 `up()`）。
import { down, portOwner, up } from './登记服务.mjs'
// ★ b91「谁动谁叫」：我刚动过服务 ⇒ 顺手**叫一声**长命资源巡检（不等待、失败就算了；兜底＝看护每 30 分钟核一次）
import { pokeInspection } from './长命资源巡检.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVICE = process.env.DSH_TOOL_SERVICE ?? join(HERE, '_mcp中转.mjs')
const PORT = Number(process.env.DSH_TOOL_PORT ?? 19400)
const LOG = join(HERE, 'logs', '确保工具服务.log')
const NODE_EXE = process.env.DSH_NODE_EXE ?? process.execPath

const argv = process.argv.slice(2)
const PROBE_ONLY = argv.includes('--probe')
const AS_JSON = argv.includes('--json')
const STOP = argv.includes('--stop')

/** 谁的资源：**默认"工作台"**（随 DSH 的东西不归某个会话 ⇒ 换会话不用交接）。 */
const OWNER = process.env.DSH_LONG_LIVE_OWNER ?? '工作台'

/** 登记（fail-soft：登记失败**绝不许**拖垮"确保"本身 —— 它才是保命的那条）。 */
async function register (pid) {
  try {
    const p = pid ?? await portOwner(PORT)
    up({ name: '工具服务', kind: 'http', port: PORT, pid: p, logFile: LOG, ensure: '确保工具服务.mjs', owner: OWNER, note: '随 DSH：插件调起（`dsh-crew-bridge`）或看板红灯手动拉起' })
    pokeInspection('事件:工具服务')   // ★ b91：刚登记完 ⇒ 让状态文件当场变新
    return p
  } catch (e) { log('⚠️ 登记失败（不影响服务）：' + String(e?.message ?? e)); return null }
}

function log (s) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`
  // ⚠️ 写日志用**具名导入**的 appendFileSync —— `确保看守.mjs` 曾在这里写过 `require('node:fs')`，
  //    而那是 ESM 文件、`require` 不存在，异常又被 `catch {}` 吞掉 ⇒ **日志从第一天起就没写成功过**。
  //
  // ⚠️ **2026-10-11 改口径**：原来是 `if (!AS_JSON) 写日志`，而插件调的正是 `--json` ⇒ 那条路不落盘。
  //    现在**一律写文件**（`console` 仍只在非 `--json` 时打）。
  //    ❗**但别据此以为"插件那条路一定被记下了"**：2026-10-11 那次重启 DSH，插件调它的记录**没有出现在日志里**
  //      （功能正常、只是日志没记上）。已定**不追**（用户选 A）—— 见文件头的"一个如实记下的限"。
  try { mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, line + '\n', 'utf8') } catch {}
  if (!AS_JSON) console.log(line)
}

/** 探活：真发一次 `tools/list`；**只有回 200 且带 tools 才算活着**。 */
async function alive (timeoutMs = 1500) {
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), timeoutMs)
    const r = await fetch(`http://127.0.0.1:${PORT}/LocalTools/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
      signal: ac.signal
    })
    clearTimeout(t)
    if (!r.ok) return { ok: false, why: 'HTTP ' + r.status }
    const j = await r.json().catch(() => null)
    const tools = (j?.result?.tools ?? []).map((x) => x.name)
    return tools.length ? { ok: true, tools } : { ok: false, why: '应答里没有工具' }
  } catch (e) {
    return { ok: false, why: String(e?.name === 'AbortError' ? '超时' : (e?.message ?? e)) }
  }
}

/** 停掉（杀掉占 19400 的进程）。只杀**命令行里带本服务文件名**的那个，避免误伤占端口的别的程序。 */
async function stop () {
  try {
    const { execSync } = await import('node:child_process')
    const out = execSync(
      'powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | ' +
      'Where-Object { $_.CommandLine -match \'_mcp中转\' } | Select-Object -ExpandProperty ProcessId"',
      { encoding: 'utf8', timeout: 8000, windowsHide: true }
    )
    const pids = out.trim().split('\n').map((s) => s.trim()).filter(Boolean)
    for (const pid of pids) { try { process.kill(Number(pid), 'SIGKILL') } catch {} }
    return { ok: true, killed: pids }
  } catch (e) { return { ok: false, error: String(e?.message ?? e) } }
}

const result = { port: PORT, service: SERVICE }

if (STOP) {
  const r = await stop()
  result.stopped = r
  try { down('工具服务', { note: `--stop 停掉（killed=${JSON.stringify(r.killed ?? [])}）` }) } catch (e) { log('⚠️ 下架登记失败：' + String(e?.message ?? e)) }
  if (AS_JSON) process.stdout.write(JSON.stringify({ ...result, state: 'red', ok: true }) + '\n')
  else log(`已停：${JSON.stringify(r)}`)
  process.exit(0)
}

const before = await alive()
if (before.ok) {
  result.state = 'green'; result.tools = before.tools; result.started = false; result.wasRunning = true
  if (!PROBE_ONLY) { result.registeredPid = await register(); log(`已在跑（${PORT}），工具 ${before.tools.length} 个 → 不重复启动`) }
} else if (PROBE_ONLY) {
  result.state = 'red'; result.why = before.why; result.ok = false; result.wasRunning = false
} else {
  if (!existsSync(SERVICE)) {
    result.state = 'red'; result.why = '找不到服务文件：' + SERVICE; result.ok = false
    log('⚠️ ' + result.why)
  } else {
    log(`没探到（${before.why}）→ 拉起 ${SERVICE}`)
    try {
      const child = spawn(NODE_EXE, [SERVICE, '--port', String(PORT)], {
        cwd: dirname(SERVICE),
        detached: true,
        windowsHide: true,          // ★ 无窗口（这就是"黑框隐藏"的做法）
        stdio: 'ignore',            // 日志由服务自己写
        env: { ...process.env, DSH_TOOL_PORT: String(PORT) }
      })
      child.once('error', (e) => log('拉起失败（不影响调用方）：' + String(e?.message ?? e)))
      child.unref()
      result.pid = child.pid
      result.started = true
      // 「嘴上说成功不算」—— 1.5 秒后**复查一次**，把结论写进日志
      await new Promise((r) => setTimeout(r, 1500))
      const after = await alive()
      result.state = after.ok ? 'green' : 'red'
      result.tools = after.tools ?? null
      if (!after.ok) result.why = '拉起后复查仍未应答：' + after.why
      log(after.ok ? `✅ 复查：在跑（工具 ${after.tools.length} 个）` : `⚠️ 复查：${after.why}`)
      // 登记（只有**复查也确认在跑**才登记成"该活着"，否则登记成 stopped ⇒ 免得那颗灯红着不放）
      if (after.ok) { result.registeredPid = await register(child.pid); pokeInspection('事件:工具服务(新起)') }
      else { try { up({ name: '工具服务', kind: 'http', port: PORT, pid: null, logFile: LOG, ensure: '确保工具服务.mjs', owner: OWNER, expect: 'stopped', note: '拉起后复查未通过（未登记为"该活着"）' }) } catch {} }
    } catch (e) {
      result.state = 'red'; result.why = String(e?.message ?? e); result.ok = false
      log('⚠️ 拉起异常：' + result.why)
    }
  }
}

if (AS_JSON) process.stdout.write(JSON.stringify(result) + '\n')
process.exit(result.state === 'green' ? 0 : 1)
