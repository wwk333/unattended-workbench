#!/usr/bin/env node
/**
 * 确保看守（换会话自动执行者）在跑 —— 一键启动/自愈
 *
 * ★ 2026-10-21（用户拍板）：**唯一正路＝进程模式** —— `dsh-crew-bridge` 插件每次宿主启动时
 *   detached 拉起本脚本，本脚本再拉 `swap-entry.mjs → 换新会话.mjs --watch --execute`。
 *   不再依赖任何"登录时跑一次"的注册项（那条链错过登录就不再响）。
 *
 * 本脚本：查它在不在 → 不在就拉起（幂等，跑几次都行）。
 *
 * 用法：
 *   node 确保看守.mjs           # 检查 + 启动
 *   node 确保看守.mjs --probe   # 只查不启动
 *   node 确保看守.mjs --stop    # 停掉看守（杀进程）
 *
 * 谁调它：
 *   ① brain.md 的「建 goal 前先跑这个」
 *   ② 侧边栏插件启动时自动调
 *   ③ 人手动跑
 *
 * ⚠️ **别把工具服务（19400）塞进来**（2026-10-11 用户拍板）：那个归 `dsh-crew-bridge` 插件随 DSH 自启，
 *   走独立的 `确保工具服务.mjs`。两者**生命周期不同**（看守跟 DSH 插件、工具服务跟 DSH 宿主），别合并。
 */
import { execSync, spawn } from 'node:child_process'
import { existsSync, readFileSync, mkdirSync, writeFileSync, appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// ★ b88（长命资源 A）：看守与看护循环也是长命资源 ⇒ 拉起后登记（唯一写入口＝`登记服务.mjs`）。
import { down, up } from './登记服务.mjs'
// ★ b91「谁动谁叫」：看守/看护起来了 ⇒ 叫一声巡检（不等待、失败就算了）
import { pokeInspection } from './长命资源巡检.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LOG = join(HERE, 'logs', '确保看守.log')
const argv = process.argv.slice(2)
const PROBE = argv.includes('--probe')
const STOP = argv.includes('--stop')
// ★ 2026-10-26（§七「计划任务保看护循环」）：本脚本三个运维开关。
//   `--ensure` 是**计划任务**每 5 分钟调的那个（已在跑就秒退，不重复拉）。
const ENSURE = argv.includes('--ensure')
const TASK_STATUS = argv.includes('--task-status')
const INSTALL_TASK = argv.includes('--install-task')
const UNINSTALL_TASK = argv.includes('--uninstall-task')

if (TASK_STATUS || INSTALL_TASK || UNINSTALL_TASK) {
  const mod = await import('./计划任务.mjs')
  if (TASK_STATUS) { const s = mod.selfCheck(); console.log(JSON.stringify(s, null, 2)); process.exit(s.exists ? 0 : 1) }
  if (INSTALL_TASK) { const r = mod.install(); process.exit(r.ok ? 0 : 1) }
  if (UNINSTALL_TASK) { const r = mod.uninstall(); process.exit(r.ok ? 0 : 1) }
}
/** 谁的资源：看守跟着 **DSH 插件**、看护循环跟着工作台 ⇒ 都归工作台，不归某个会话。 */
const OWNER = process.env.DSH_LONG_LIVE_OWNER ?? '工作台'

/** 登记（fail-soft）。注意这两条**没有端口** —— 判活只看 pid。 */
function register (name, pid, note) {
  try { up({ name, kind: 'process', pid: Number(pid) || null, logFile: LOG, ensure: '确保看守.mjs', owner: OWNER, note }); pokeInspection('事件:' + name) }
  catch (e) { log(`⚠️ 登记 ${name} 失败（不影响它本身）：${String(e?.message ?? e)}`) }
}

const log = (s) => {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`
  // ⚠️ 踩过的坑（2026-10-10）：这里原来写的是 `require('node:fs').appendFileSync(...)` ——
  //    本文件是 **ESM**，`require` 根本不存在（`require is not defined`），而它又被 `catch {}` 吞掉
  //    ⇒ **写日志从第一天起就没成功过**（`logs\确保看守.log` 一直不存在，出问题时查不到任何线索）。
  //    现在用顶部的 `appendFileSync` 具名导入。
  try { mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, line + '\n', 'utf8') } catch {}
  console.log(line)
}

/** 查看守进程在不在（按命令行特征找 node … swap-entry.mjs） */
function isWatcherRunning () {
  try {
    const out = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -match \'swap-entry\' } | Select-Object -ExpandProperty ProcessId"', { encoding: 'utf8', timeout: 8000, windowsHide: true })
    const pids = out.trim().split('\n').filter(Boolean).map(s => s.trim())
    return pids.length > 0 ? pids : []
  } catch { return [] }
}

/** 查看护循环在不在（按命令行特征找 node … 看护循环.mjs） */
function isWatchdogRunning () {
  try {
    const out = execSync('powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name=\'node.exe\'\\" | Where-Object { $_.CommandLine -match \'看护循环\' } | Select-Object -ExpandProperty ProcessId"', { encoding: 'utf8', timeout: 8000, windowsHide: true })
    const pids = out.trim().split('\n').filter(Boolean).map(s => s.trim())
    return pids.length > 0 ? pids : []
  } catch { return [] }
}

if (STOP) {
  const pids = isWatcherRunning()
  for (const pid of pids) {
    try { execSync(`taskkill /pid ${pid} /f`, { timeout: 5000, windowsHide: true }); log(`已杀看守进程 pid=${pid}`) } catch { log(`杀 pid=${pid} 失败（可能已退出）`) }
  }
  try { down('换会话看守', { note: '确保看守 --stop' }) } catch (e) { log(`⚠️ 下架登记失败：${String(e?.message ?? e)}`) }
  log('看守已停')
  process.exit(0)
}

// ── 检查 ──
const pids = isWatcherRunning()
log(`看守进程：${pids.length ? '在跑（pid=' + pids.join(',') + '）' : '不在跑'}`)

if (PROBE) {
  log('--probe：只查不启动')
  process.exit(pids.length > 0 ? 0 : 1)
}

// ── 启动 ──
// ⚠️ 注意：**不能在这里因为"swap-entry 已在跑"就整体退出** —— 看护循环（每 5 分钟一轮）是
//    另一条独立的链，它死了必须能补上。踩过两次同类坑（另一次是"补配置搭在正常跑的便车上"）：
//    "补配置/补另一条链"的动作**不许搭在别的东西正常跑的便车上**。
if (pids.length > 0) {
  log('换会话看守已在跑（不重复启动它）')
  if (!PROBE) register('换会话看守', pids[0], '已在跑（pid 由命令行特征查到）')
} else {
  // ② 直接拉起看守（detached，不随本脚本退出而死）
  log('拉起 swap-entry.mjs（detached）')
  try {
    const child = spawn(process.execPath, [join(HERE, 'swap-entry.mjs')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: HERE
    })
    child.unref()
    log(`✓ 换会话看守已拉起（pid=${child.pid}）`)
    register('换会话看守', child.pid, '由 确保看守.mjs 拉起（detached）')
  } catch (e) {
    log(`❌ 拉起失败：${e.message}`)
    process.exit(1)
  }
}

// ②b 也拉起看护循环（每 5 分钟跑一次 进度看护.mjs，异常时叫醒大脑）
const wd = isWatchdogRunning()
if (!wd.length) {
  log('拉起 看护循环.mjs（detached，每 300s 一轮）')
  try {
    const child2 = spawn(process.execPath, [join(HERE, '看护循环.mjs')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: HERE
    })
    child2.unref()
    log(`✓ 看护循环已拉起（pid=${child2.pid}）`)
    register('看护循环', child2.pid, '由 确保看守.mjs 拉起（每 300s 一轮）')
  } catch (e) {
    log(`⚠️ 看护循环拉起失败（不影响换会话看守）：${e.message}`)
  }
} else {
  log('看护循环已在跑 → 不重复启动')
  register('看护循环', wd[0], '已在跑（pid 由命令行特征查到）')
}

// ③ 再确认一次
await new Promise(r => setTimeout(r, 2000))
const pids2 = isWatcherRunning()
if (pids2.length) {
  log(`✓ 确认在跑（pid=${pids2.join(',')}）`)
} else {
  log('⚠️ 拉起后 2 秒内还没看到进程（可能还在初始化，swap-entry 有等桥逻辑）')
}
