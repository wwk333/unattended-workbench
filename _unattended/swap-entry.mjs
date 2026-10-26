#!/usr/bin/env node
/**
 * swap-entry.mjs —— 自启链的 Node 层桥接（**文件名必须纯 ASCII**：启动器写不了中文脚本名）
 *
 * 链路（恢复自 2026-10-03 迁移时"有意未迁入"的那条，见 `_存档\工作台旧文档\_迁移清单.md:77`）：
 *   开机自启 → swap-watch.cmd → swap-entry.mjs → 换新会话.mjs --watch --execute
 *
 * 为什么要有这一层（三件事，脚本自己都不会做）：
 *   ① **等桥**：桌面端换会话桥（127.0.0.1:19390，宿主插件 dsh-board-sidebar 提供）要 DSH 起来才有，
 *      开机自启时十有八九还没起来 → 这里最多等 90 秒，等到才往下走。
 *   ② **单实例锁**：`换新会话.mjs` 的看守循环自己**没有** pid 锁，两个启动器都点会跑两份
 *      → 这里用 `logs\swap-watch.lock`（写 pid + 存活探测）保证只跑一个。
 *   ③ **保活**：子进程退出（异常/被杀）就记一行日志、等 30 秒拉起来，免得又回到"没人看着"的老问题。
 *
 * 用法：
 *   node swap-entry.mjs --probe        # **只读体检**：验 token / 桥 / 锁，并干跑一轮换新会话判定，不换
 *   node swap-entry.mjs                # 默认 = --watch --execute（真看守）
 *   node swap-entry.mjs --watch        # 同上；缺 --execute 会**自动补上**（B 方案的本意就是真换）
 *   node swap-entry.mjs --watch --dry  # 想要"只看不换"的看守：明确加 --dry，保留 dry-run
 *   其余参数原样透传给 换新会话.mjs（--soft/--hard/--interval/--session…）
 *
 * 日志：子进程 stdout/stderr → `logs\swap-watch.log`（换新会话自己还写 `logs\swap.log`）
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, '换新会话.mjs')
const LOCK = join(HERE, 'logs', 'swap-watch.lock')
const OUT = join(HERE, 'logs', 'swap-watch.log')
const TOKEN_FILE = process.env.DSH_SWAP_TOKEN_FILE ?? join(HERE, 'secrets', 'swap-token.txt')
const BRIDGE = `http://127.0.0.1:${process.env.DSH_SWAP_PORT ?? 19390}/swap`
const BRIDGE_WAIT_MS = Number(process.env.DSH_SWAP_WAIT_MS ?? 90_000)
const RESTART_DELAY_MS = 30_000

const argv = process.argv.slice(2)
const PROBE = argv.includes('--probe')
const DRY = argv.includes('--dry')

const ts = () => new Date().toISOString().replace('T', ' ').slice(0, 19)
const log = (...a) => { const s = `[${ts()}] ${a.join(' ')}`; try { mkdirSync(dirname(OUT), { recursive: true }); appendFileSync(OUT, s + '\n', 'utf8') } catch {}; console.log(s) }
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// ---------------------------------------------------------------- 锁
function pidAlive (pid) {
  try { process.kill(pid, 0); return true } catch (e) { return e?.code === 'EPERM' }
}
function readLock () {
  try { const j = JSON.parse(readFileSync(LOCK, 'utf8')); return Number.isFinite(j?.pid) ? j : null } catch { return null }
}
/** 拿锁；返回 true=拿到，false=别人持有 */
function acquireLock () {
  mkdirSync(dirname(LOCK), { recursive: true })
  const cur = readLock()
  if (cur && cur.pid !== process.pid && pidAlive(cur.pid)) return false
  if (cur) { try { unlinkSync(LOCK) } catch {} }          // 死锁残留 → 清掉
  writeFileSync(LOCK, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), argv }), 'utf8')
  return true
}
function releaseLock () {
  const cur = readLock()
  if (cur?.pid === process.pid) { try { unlinkSync(LOCK) } catch {} }
}
process.on('SIGINT', () => { releaseLock(); process.exit(0) })
process.on('SIGTERM', () => { releaseLock(); process.exit(0) })

// ---------------------------------------------------------------- 桥
async function bridgePing () {
  if (!existsSync(TOKEN_FILE)) return { ok: false, why: `读不到桥 token：${TOKEN_FILE}` }
  const token = readFileSync(TOKEN_FILE, 'utf8').trim()
  try {
    const r = await fetch(BRIDGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-dsh-swap-token': token },
      body: JSON.stringify({ op: 'ping' }),
      signal: AbortSignal.timeout(4000)
    })
    const j = await r.json().catch(() => null)
    if (r.status === 401) return { ok: false, why: '桥拒绝（401）：token 不对或插件重启后换了 token' }
    if (!j?.ok) return { ok: false, why: `桥返回异常（HTTP ${r.status}）` }
    return { ok: true, service: j.service, version: j.version }
  } catch (e) { return { ok: false, why: `连不上 ${BRIDGE}：${e?.message ?? e}` } }
}
async function waitBridge (ms) {
  const t0 = Date.now()
  let last = null
  while (Date.now() - t0 < ms) {
    last = await bridgePing()
    if (last.ok) return last
    await sleep(3000)
  }
  return last ?? { ok: false, why: '未探测' }
}

// ---------------------------------------------------------------- 子进程
function buildArgs () {
  const passthru = argv.filter(a => a !== '--probe' && a !== '--dry')
  if (!passthru.includes('--watch')) passthru.push('--watch')
  if (!DRY && !passthru.includes('--execute')) {
    passthru.push('--execute')                           // B 方案：看守必须真换，缺了就补
    log('  （自动补上 --execute：看守默认真换；想要"只看不换"请显式传 --dry）')
  }
  if (DRY && passthru.includes('--execute')) passthru.splice(passthru.indexOf('--execute'), 1)
  return passthru
}
function startChild (args) {
  log(`启动子进程：node 换新会话.mjs ${args.join(' ')}`)
  const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: HERE, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const forward = (buf) => { for (const line of buf.toString('utf8').split(/\r?\n/)) if (line) log('[子]', line) }
  child.stdout.on('data', forward)
  child.stderr.on('data', forward)
  child.on('exit', (code, signal) => log(`子进程退出 code=${code} signal=${signal ?? '-'}`))
  return child
}

// ---------------------------------------------------------------- 主流程
if (PROBE) {
  log('—— --probe 只读体检（不会换会话）——')
  const scriptOk = existsSync(SCRIPT)
  log(`① 脚本：${scriptOk ? 'OK' : '缺失 ' + SCRIPT}`)
  const lock = readLock()
  log(`② 锁：${lock ? (pidAlive(lock.pid) ? `被 pid ${lock.pid} 持有（看守已在跑）` : `残留死锁 pid ${lock.pid}（可删 ${LOCK}）`) : '空闲'}`)
  const ping = await bridgePing()
  log(`③ 桥：${ping.ok ? `OK（${ping.service} v${ping.version}）` : 'FAIL — ' + ping.why}`)
  if (scriptOk) {
    const args = ['--json']                               // 只读干跑一轮判定（无 --execute、无 --watch）
    log(`④ 干跑判定：node 换新会话.mjs ${args.join(' ')}`)
    const code = await new Promise(res => {
      const c = spawn(process.execPath, [SCRIPT, ...args], { cwd: HERE, stdio: 'inherit', windowsHide: true })
      c.on('exit', x => res(x ?? 0))
    })
    log(`⑤ 干跑退出码 ${code}${code === 0 ? '（链路可跑通）' : '（链路有问题，看上面输出）'}`)
    process.exit(code === 0 && ping.ok ? 0 : 2)
  }
  process.exit(2)
}

if (!existsSync(SCRIPT)) { log(`❌ 找不到 ${SCRIPT}`); process.exit(1) }
if (!acquireLock()) { const cur = readLock(); log(`已有看守在跑（pid ${cur?.pid}）→ 本进程退出`); process.exit(0) }

log(`—— 看守启动（等待换会话桥，最多 ${Math.round(BRIDGE_WAIT_MS / 1000)}s 轮询）——`)
let ping = await waitBridge(BRIDGE_WAIT_MS)
if (!ping.ok) {
  // 开机自启常常比 DSH 早：桥还没起来 ≠ 放弃。改成**一直等**（每 15s 一次，每 60s 记一行），
  // 否则"自启了却因为早到 90 秒而死掉"会把 B 方案重新变成没人看守。
  log(`⚠️ ${Math.round(BRIDGE_WAIT_MS / 1000)}s 内没等到桥：${ping.why}`)
  log('   → 转入无限等待（每 15s 重试）。DSH 起来后会自动继续。Ctrl+C 可退出。')
  let waited = BRIDGE_WAIT_MS
  while (!ping.ok) {
    await sleep(15_000)
    waited += 15_000
    ping = await bridgePing()
    if (!ping.ok && waited % 60_000 === 0) log(`   …仍在等桥（已等 ${Math.round(waited / 1000)}s）：${ping.why}`)
  }
}
log(`✓ 桥就绪（${ping.service} v${ping.version}）`)

const args = buildArgs()
let child = startChild(args)
let stopping = false
child.on('exit', async () => {
  if (stopping) return
  log(`看守：${RESTART_DELAY_MS / 1000}s 后重新拉起（保活）…`)
  await sleep(RESTART_DELAY_MS)
  if (stopping) return
  child = startChild(args)
})
const stop = () => { stopping = true; try { child.kill() } catch {}; releaseLock(); process.exit(0) }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
