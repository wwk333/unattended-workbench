#!/usr/bin/env node
/**
 * 宿主 Web 端口/地址 —— **唯一来源**（别再各处写 19387）。
 *
 * 为什么需要（2026-10-17 升级 0.2.1 的硬要求）：
 *   0.2.0-rc.2 的桌面端在宿主里写死 `--port 19387`（asar: dsh-desktop-host/lib/index.js）；
 *   0.2.1 的 release note 明说「桌面端默认使用系统分配的端口，避免 Windows 保留端口范围
 *   导致应用无法启动」⇒ 端口改成**每次启动随机**，写死 19387 的地方会全部误判
 *   （看板说"宿主没起"、验证脚本找错口）。
 *
 * 解析顺序（先便宜后贵，全部只读）：
 *   ① 显式：环境变量 `DSH_PORT`；或 `DSH_WEB_URL`（宿主自己注入的，如 http://127.0.0.1:19387）
 *   ② 缓存：`_crew\运行时\宿主端口.json`（记了 pid；pid 还活着且口还在听 ⇒ 直接用）
 *   ③ 现探测：拿所有 `DeepSeek Harness.exe` 进程的 LISTENING 口，排除我们自己的口
 *      （19390 换会话桥 / 19400 MCP 中转 / 19420 路由网关 / 19450 面板），
 *      逐个 `GET /` 看回的是不是 DSH 页面 ⇒ 命中即写缓存
 *   ④ 兜底：19387（旧口径，只为"一个都探不到"时不至于崩）
 *
 * ⚠️ 只读 + 只写一个缓存 JSON；不调模型、不改配置。
 * 用法：`node _宿主端口.mjs` 打印当前判定结果（排障用）。
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const CACHE = join(ROOT, '_crew', '运行时', '宿主端口.json')

/** 我们自己进程占的口 —— 探测时必须排除，否则会把桥/面板当成宿主。 */
const IGNORE_PORTS = new Set([
  Number(process.env.DSH_SWAP_PORT ?? 19390), // 换会话桥（dsh-crew-bridge）
  19400, // _mcp中转.mjs
  19420, // 路由网关.mjs
  Number(process.env.DSH_PANEL_PORT ?? 19450) // 面板 service.mjs
])

const OLD_DEFAULT = 19387

/** 从环境变量拿（宿主给子进程注入了 DSH_WEB_URL）。 */
function fromEnv () {
  const p = process.env.DSH_PORT
  if (p && Number.isFinite(Number(p))) return Number(p)
  const u = process.env.DSH_WEB_URL
  if (u) {
    try {
      const parsed = new URL(u)
      const port = Number(parsed.port || (parsed.protocol === 'https:' ? 443 : 80))
      if (Number.isFinite(port) && port > 0) return port
    } catch { /* 形如 127.0.0.1:19387 的裸串再试一次 */ }
    const m = String(u).match(/:(\d{2,5})\b/)
    if (m) return Number(m[1])
  }
  return null
}

/** 读缓存（只在 pid 还活着、口还在听时才算数）。 */
function fromCache () {
  try {
    if (!existsSync(CACHE)) return null
    const j = JSON.parse(readFileSync(CACHE, 'utf8'))
    const port = Number(j.port)
    if (!Number.isFinite(port) || port <= 0) return null
    if (j.pid && !isPidAlive(j.pid)) return null
    if (!isListening(port)) return null
    return port
  } catch { return null }
}

function isPidAlive (pid) {
  try {
    execFileSync('tasklist', ['/fi', `pid eq ${Number(pid)}`, '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 5000 })
    return true
  } catch { return false }
}

/** 某端口当前是否 LISTENING（netstat 读表，约 60ms）。 */
export function isListening (port) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    const re = new RegExp(`:${Number(port)}\\s+\\S+\\s+LISTENING`, 'i')
    return re.test(out)
  } catch { return false }
}

/** 桌面端所有进程 pid（主进程 + 各 helper 都在里面；宿主 web 就是其中之一）。 */
function dshPids () {
  try {
    const out = execFileSync('tasklist', ['/fi', 'imagename eq DeepSeek Harness.exe', '/fo', 'csv', '/nh'], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    const pids = new Set()
    for (const line of out.split(/\r?\n/)) {
      if (!line.includes('"')) continue
      const cols = line.split('","').map(s => s.replace(/^"|"$/g, ''))
      const pid = Number(cols[1])
      if (Number.isFinite(pid) && pid > 0) pids.add(pid)
    }
    return pids
  } catch { return new Set() }
}

/** 这些 pid 正在听的口。 */
function listeningPortsOf (pids) {
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', windowsHide: true, timeout: 8000 })
    const ports = new Set()
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i)
      if (!m) continue
      const port = Number(m[1]); const pid = Number(m[2])
      if (pids.has(pid) && !IGNORE_PORTS.has(port) && port > 1024) ports.add(port)
    }
    return [...ports]
  } catch { return [] }
}

/** 这个口回的是不是 DSH 的页面（curl 探，约 40ms/口）。 */
function looksLikeDsh (port) {
  try {
    // ⚠️ 宿主根口**未带 token 时回 401**，正文是 `dsh web authentication required; …`
    //    （2026-10-17 实测）。所以"像 DSH"要认这行，不能只认 HTML。
    const body = execFileSync('curl.exe', ['-s', '-m', '1.2', `http://127.0.0.1:${port}/`], { encoding: 'utf8', windowsHide: true, timeout: 4000 })
    return /dsh web authentication|authentication required|DeepSeek|dsh-app|__DSH_BOOT__|<div id="root"/i.test(body)
  } catch { return false }
}

function writeCache (port) {
  try {
    const pids = [...dshPids()]
    mkdirSync(dirname(CACHE), { recursive: true })
    writeFileSync(CACHE, JSON.stringify({ port, pid: pids[0] ?? null, at: new Date().toISOString() }, null, 2), 'utf8')
  } catch { /* 缓存写不了不影响判定 */ }
}

/** 同步判定宿主端口（全项目唯一入口）。 */
export function hostPortSync () {
  const env = fromEnv()
  if (env) return env
  const cached = fromCache()
  if (cached) return cached
  const ports = listeningPortsOf(dshPids())
  for (const port of ports) {
    if (looksLikeDsh(port)) { writeCache(port); return port }
  }
  // 探不到内容也别直接回旧的：只要有一个候选口就先用它（大概率就是）
  if (ports.length === 1) { writeCache(ports[0]); return ports[0] }
  return OLD_DEFAULT
}

/** 宿主根地址（带尾斜杠，等价原来的 `http://127.0.0.1:19387/`）。 */
export function hostUrlSync () {
  return `http://127.0.0.1:${hostPortSync()}/`
}

/** CLI：打印判定过程（排障用）。 */
if (import.meta.main) {
  const env = fromEnv()
  console.log('① 环境变量:', env ?? '（无）')
  console.log('② 缓存文件:', CACHE, existsSync(CACHE) ? '存在' : '不存在')
  const pids = [...dshPids()]
  console.log('③ 桌面端 pid:', pids.join(', ') || '（没在跑）')
  console.log('④ 候选口:', listeningPortsOf(new Set(pids)).join(', ') || '（无）')
  const port = hostPortSync()
  console.log('⇒ 宿主端口 =', port, ' 地址 =', hostUrlSync())
  console.log('   / 探活 =', looksLikeDsh(port) ? '✅ 是 DSH 页面' : '❌ 没探到（端口可能不对）')
}
