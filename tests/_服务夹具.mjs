/**
 * 服务夹具 —— 起一个**临时** C 状态服务（临时库、随机端口），用完杀掉。
 *
 * 纪律：绝不连 `_crew/state/crew.db`（那是生产库）。每个用例自己的库、自己的端口。
 */

import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const UNATTENDED = resolve(HERE, '..', '_unattended')

/**
 * 活着夹具的登记 —— **防挂死**。
 * 为什么要有：某个用例在 `try` 之前就抛（比如夹具参数写错），`stop()` 不会执行，
 * 而子进程的 stdout 管道会把**测试进程**钉住不退出（实测：`node --test` 永久挂住、连 `--test-timeout` 都不管用）。
 * 所以：子进程一律 `unref()`，并在 `process.on('exit')` 里兜底杀掉所有还活着的。
 */
const LIVE = new Set()
let hooked = false
function hook () {
  if (hooked) return
  hooked = true
  process.on('exit', () => {
    for (const p of LIVE) { try { p.kill('SIGKILL') } catch {} }
    LIVE.clear()
  })
}

/**
 * @returns {Promise<{port:number, base:string, pid:number, dbPath:string, stop:()=>Promise<void>}>}
 */
export async function startService ({ dbPath = null, timeoutMs = 15000 } = {}) {
  hook()
  const dir = dbPath ? null : mkdtempSync(join(tmpdir(), 'crew-svc-'))
  const db = dbPath ?? join(dir, 'crew.db')
  const proc = spawn(process.execPath, [join(UNATTENDED, '_状态服务.mjs'), '--port', '0', '--db', db], {
    cwd: resolve(UNATTENDED, '..'),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  })
  LIVE.add(proc)
  let out = ''
  let err = ''
  proc.stdout.on('data', d => { out += d })
  proc.stderr.on('data', d => { err += d })

  const port = await new Promise((res, rej) => {
    const t0 = Date.now()
    const tick = setInterval(() => {
      const m = out.match(/READY http:\/\/127\.0\.0\.1:(\d+)/)
      if (m) { clearInterval(tick); res(Number(m[1])); return }
      if (proc.exitCode !== null) { clearInterval(tick); rej(new Error(`服务提前退出 code=${proc.exitCode} stderr=${err}`)) }
      if (Date.now() - t0 > timeoutMs) { clearInterval(tick); rej(new Error(`等服务 READY 超时：${out}${err}`)) }
    }, 25)
  })
  // 拿到端口后就把子进程"脱钩"：它不许把测试进程钉住
  try { proc.stdout.unref?.(); proc.stderr.unref?.() } catch {}
  try { proc.unref() } catch {}

  const stop = async () => {
    if (proc.exitCode === null) {
      try { proc.kill('SIGKILL') } catch {}
      await new Promise(r => { proc.once('exit', r); setTimeout(r, 2000) })
    }
    LIVE.delete(proc)
    if (dir) { try { rmSync(dir, { recursive: true, force: true }) } catch {} }
  }

  return { port, base: `http://127.0.0.1:${port}`, pid: proc.pid, dbPath: db, proc, stop, output: () => out + err, dir }
}

/** 直接打 HTTP（测试要验服务本身，绕开客户端） */
export async function http (base, method, path, body = null, headers = {}) {
  const r = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body === null ? undefined : JSON.stringify(body)
  })
  const text = await r.text()
  let json = null
  try { json = text ? JSON.parse(text) : null } catch {}
  return { status: r.status, json, text }
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms))
