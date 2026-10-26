/**
 * 自重启助手（面板「重启」按钮的执行体）
 *
 * 为什么要单独一个进程：正在跑的服务**不能自己重启自己** ——
 * 它得先退出（释放 19450），新进程才能占上端口。所以由它 spawn 本助手（detached），
 * 本助手等旧 pid 消失后再拉起 `service.mjs`，最后自己退出。
 *
 * 用法（由 service.mjs 调）：
 *   node _self-restart.mjs --pid <旧pid> --service <service.mjs 绝对路径> --port <端口> [--wait-ms 30000]
 *
 * 纪律：
 * - **只等不杀**：不主动 kill 旧进程（那是它自己的事），只等它退出；超时就把失败写进日志并放弃。
 * - 拉起时用与父进程相同的 node，`detached + stdio:'ignore'`，不弹窗（windowsHide）。
 * - 全过程写 `_crew/面板重启.log`，出问题能查。
 */

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const LOG = join(resolve(HERE, '..', '..'), '_crew', '面板重启.log')

function log (msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  try { mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, line + '\n', 'utf8') } catch {}
  console.log(line)
}

const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }

const oldPid = Number(opt('pid', 0)) || 0
const service = opt('service', join(HERE, 'service.mjs'))
const port = Number(opt('port', 19450))
const waitMs = Number(opt('wait-ms', 30000))

const alive = (pid) => {
  if (!pid) return false
  try { process.kill(pid, 0); return true } catch { return false }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

log(`重启开始：等旧进程 pid=${oldPid} 退出（最多 ${waitMs}ms），随后拉起 ${service}（端口 ${port}）`)

const t0 = Date.now()
while (alive(oldPid) && Date.now() - t0 < waitMs) await sleep(200)

if (alive(oldPid)) {
  log(`❌ 超时：旧进程 pid=${oldPid} 还活着 ⇒ 放弃自动拉起（请手动 stop/start）`)
  process.exit(3)
}
log(`旧进程已退出（等了 ${Date.now() - t0}ms）⇒ 拉起新进程`)

try {
  const child = spawn(process.execPath, [service], {
    cwd: HERE,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: { ...process.env, DSH_PANEL_PORT: String(port), DSH_PANEL_RESTARTED_BY: 'button' }
  })
  child.unref()
  log(`✅ 已拉起新进程 pid=${child.pid}`)
  process.exit(0)
} catch (e) {
  log(`❌ 拉起失败：${String(e?.message ?? e)}`)
  process.exit(4)
}
