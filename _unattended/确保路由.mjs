#!/usr/bin/env node
/**
 * 确保「路由网关」在跑 —— 面板起来时顺带把它拉起来（**黑框隐藏**，和工具服务一个套路）。
 *
 *   node 确保路由.mjs --probe    只查，不起（面板那颗灯轮询用）
 *   node 确保路由.mjs            查不到就**后台拉起**（detached + windowsHide ⇒ 不留黑框、不随本脚本退出）
 *   两态都往 stdout 打**最后一行 JSON**：`{state:'green'|'red', port, homes, hits, why}`
 *
 * ## 为什么要有它（用户口径）
 * "这个B最小版要绑定在班组看板里最好，这样班组看板打开，同时路由也跟着起来，黑框要隐藏，和 看板 工具服务 一样"。
 * ## 唯一源
 * 本脚本**不存任何配置**：它只做"探活 + 需要就拉起"，配置全在 `_coder路由表.json` / 密钥库。
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// ★ b88（长命资源 A）：起完就登记（唯一写入口＝`登记服务.mjs`；这里只是调它）。
import { portOwner, up } from './登记服务.mjs'
// ★ b91「谁动谁叫」：网关起来了 ⇒ 叫一声巡检（不等待、失败就算了）
import { pokeInspection } from './长命资源巡检.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, '..')
const GATEWAY = join(HERE, '路由网关.mjs')
const NODE_EXE = process.env.DSH_NODE_EXE ?? process.execPath
const PORT = Number(process.env.DSH_ROUTER_PORT ?? 19420)
const PROBE_ONLY = process.argv.includes('--probe')
/** 谁的资源：网关**跟着班组看板**（面板拉起）⇒ 归工作台，不归某个会话。 */
const OWNER = process.env.DSH_LONG_LIVE_OWNER ?? '工作台'

/** 登记（fail-soft：登记失败不许影响"确保"本身）。 */
async function register (pid) {
  try {
    const p = pid ?? await portOwner(PORT)
    up({ name: '路由网关', kind: 'http', port: PORT, pid: p, logFile: join(WORKSPACE, '_unattended', 'logs', '路由网关.log'), ensure: '确保路由.mjs', owner: OWNER, note: '跟着班组看板起来（面板拉起，黑框隐藏）' })
    pokeInspection('事件:路由网关')   // ★ b91
  } catch (e) { console.log(JSON.stringify({ warn: '登记失败（不影响网关）：' + String(e?.message ?? e) })) }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function health (timeoutMs = 2500) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/health`, { signal: AbortSignal.timeout(timeoutMs) })
    if (!r.ok) return null
    return await r.json()
  } catch { return null }
}

async function main () {
  let h = await health()
  let spawnedPid = null
  if (!h && !PROBE_ONLY) {
    try {
      mkdirSync(join(WORKSPACE, '_unattended', 'logs'), { recursive: true })
      // ★ 和面板/工具服务一样：detached + windowsHide ⇒ **没有黑框**，且不随本脚本退出
      const child = spawn(NODE_EXE, [GATEWAY, '--port', String(PORT)], {
        cwd: HERE, detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore']
      })
      child.unref()
      spawnedPid = child.pid
      for (let i = 0; i < 20 && !h; i++) { await sleep(250); h = await health() }   // 最多等 5 秒
    } catch (e) {
      console.log(JSON.stringify({ state: 'red', port: PORT, why: '拉不起来：' + String(e?.message ?? e) }))
      process.exitCode = 0
      return
    }
  }
  if (!h) {
    console.log(JSON.stringify({ state: 'red', port: PORT, why: existsSync(GATEWAY) ? '网关没在跑（19420 没人听）' : '找不到 路由网关.mjs' }))
    return
  }
  if (!PROBE_ONLY) await register(spawnedPid)   // 只在"真查/真拉"这条路登记；`--probe` 是只读的
  console.log(JSON.stringify({ state: 'green', port: h.port ?? PORT, homes: h.homes ?? [], hits: h.hits ?? {}, uptimeSec: h.uptimeSec ?? null }))
}

await main()
