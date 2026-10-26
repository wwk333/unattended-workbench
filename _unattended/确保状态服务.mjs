#!/usr/bin/env node
/**
 * 确保状态服务在跑 —— C 状态服务的**唯一 ensure 脚本**（施工文档 §三 / §七）
 *
 * 谁调它：
 *   ① 自愈器（`自愈器.mjs`）：登记册里 C 状态服务 dead ⇒ 调本脚本；
 *   ② `_状态客户端.mjs`：活跃客户端发现连不上时先踢一脚（目标 ≤5 秒恢复）；
 *   ③ 人手动跑 / 上线脚本。
 *
 * 铁律：
 *   · **幂等**：已在跑就秒退（exit 0），不重复拉第二个实例（同一状态库只能有一个写者）；
 *   · **不杀谁**：本脚本只负责"拉起来"，不负责停；停机走显式命令并留痕；
 *   · **自证**：起来后必须等 `/health` 真绿才 exit 0，否则 exit 1（自愈器要据此记失败/退避）。
 *
 * 用法：
 *   node 确保状态服务.mjs               # 查 → 不在就拉 → 等 /health 绿
 *   node 确保状态服务.mjs --probe       # 只查，不拉
 *   node 确保状态服务.mjs --wait 10     # 最多等 10 秒（默认 8）
 *   node 确保状态服务.mjs --no-register # 不写登记册（测试/临时端口用）
 */

import { spawn } from 'node:child_process'
import { appendFileSync, mkdirSync, openSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DEFAULT_PORT, DEFAULT_DB, SERVICE_NAME, ENSURE_SCRIPT } from './_状态常量.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WORKBENCH = join(HERE, '..')
const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const has = n => argv.includes('--' + n)

const PORT = Number(opt('port', process.env.DSH_CREW_STATE_PORT ?? DEFAULT_PORT))
const DB_PATH = opt('db', process.env.DSH_CREW_STATE_DB ?? DEFAULT_DB)
const WAIT_SEC = Number(opt('wait', 8))
const LOG = join(HERE, 'logs', '确保状态服务.log')

function logLine (msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  try { mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, line + '\n', 'utf8') } catch {}
  console.log(line)
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

async function probe (timeoutMs = 1200) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: ac.signal })
    const j = await r.json()
    return { ok: r.ok && j?.ok === true && j?.db?.writeOk !== false, body: j, status: r.status }
  } catch (e) {
    return { ok: false, body: null, error: e.code ?? e.message }
  } finally { clearTimeout(t) }
}

async function main () {
  const first = await probe()
  if (first.ok) {
    if (has('probe')) { console.log(JSON.stringify(first.body, null, 2)); process.exit(0) }
    logLine(`已在跑（pid=${first.body.pid} port=${PORT}），秒退`)
    process.exit(0)
  }
  if (has('probe')) {
    console.error(`[${ENSURE_SCRIPT}] probe：没活（${first.error ?? first.status}）`)
    process.exit(1)
  }

  // 端口被别的进程占着：不许硬拉第二个（会两个写者写同一个库）
  const occupied = await new Promise((res) => {
    const s = spawn(process.execPath, ['-e', `const n=require('net');const c=n.createServer();c.once('error',e=>{console.log(e.code);process.exit(0)});c.once('listening',()=>{c.close();console.log('FREE')});c.listen(${PORT},'127.0.0.1')`], { windowsHide: true })
    let out = ''
    s.stdout.on('data', d => { out += d })
    s.on('close', () => res(out.trim()))
  })
  if (occupied === 'EADDRINUSE') {
    logLine(`端口 ${PORT} 被占用，但 /health 不绿 —— 可能是一个卡死的旧实例。不擅自杀，交给自愈器/人。`)
    process.exit(1)
  }

  mkdirSync(dirname(LOG), { recursive: true })
  const out = openSync(LOG, 'a')
  const child = spawn(process.execPath, [join(HERE, '_状态服务.mjs'), '--port', String(PORT), '--db', DB_PATH], {
    cwd: WORKBENCH,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out]
  })
  child.unref()
  logLine(`拉起状态服务 pid=${child.pid} port=${PORT} db=${DB_PATH}`)

  const deadline = Date.now() + WAIT_SEC * 1000
  let last = null
  while (Date.now() < deadline) {
    await sleep(250)
    last = await probe(800)
    if (last.ok) break
  }
  if (!last?.ok) {
    logLine(`拉起后 ${WAIT_SEC} 秒内 /health 仍不绿（${last?.error ?? 'unknown'}）`)
    process.exit(1)
  }

  const tookMs = WAIT_SEC * 1000 - Math.max(0, deadline - Date.now())
  logLine(`就绪 pid=${last.body.pid} 用时≈${tookMs}ms`)

  if (!has('no-register')) {
    try {
      const { up } = await import('./登记服务.mjs')
      up({
        name: SERVICE_NAME,
        kind: 'http',
        port: PORT,
        pid: last.body.pid,
        logFile: LOG,
        ensure: ENSURE_SCRIPT,
        owner: '工作台',
        startedBy: ENSURE_SCRIPT,
        expect: 'running',
        critical: true,
        note: 'C 状态服务（critical）：状态权威；dead ⇒ 停新派活；ensure=确保状态服务.mjs'
      })
      logLine('已登记进 _crew/服务登记.json（critical=true）')
    } catch (e) {
      logLine(`登记失败（不影响服务本身）：${e.message}`)
    }
  }
  process.exit(0)
}

main().catch(e => { logLine(`异常：${e.message}`); process.exit(1) })
