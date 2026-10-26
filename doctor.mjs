#!/usr/bin/env node
/**
 * doctor —— 「不舒服」的时候照一下（D9）
 *
 * 和 `setup` 的分工：
 *   · `setup` 管**装机**（还没装/装不全）；`doctor` 管**出院体检**（装完了，但怀疑哪不对）。
 *   · **复用同一套检查**（`setup.mjs` 的 `CHECKS`），不另写一套口径 ——
 *     本项目已经踩过三次"同一个东西两套口径"的坑（对账/额度/看板）。
 *   doctor 只多做两件事：**配置能不能解析（带行号列号）** 和 **端口占没占**。
 *
 * 三档结论（**不许模棱两可**）：
 *   ✅ 可起飞     —— must 全绿
 *   ⚠️ 能跑但有限制 —— must 全绿、warn 有缺（比如某个载体没装）
 *   ❌ 还差 N 项  —— must 有缺（**退出码非零**）
 *
 * 用法：
 *   node doctor.mjs            # 人看
 *   node doctor.mjs --json     # 机器看
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'

import { run } from './setup.mjs'
import { WORKSPACE, CONFIG_DIR } from './_unattended/_路径.mjs'

/** 这些口本机/用户机上常驻。**只报占用，不杀进程**（纪律：不许杀共享服务）。 */
const PORTS = [19387, 19390, 19400, 19420, 19450, 19460]

/** 把 `JSON.parse` 的报错翻成"第几行第几列"，并指出那个位置附近是什么 */
function parseWithPosition (file) {
  let text
  try { text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '') } catch (e) {
    return { ok: false, why: `读不了：${String(e?.message ?? e)}` }
  }
  try {
    JSON.parse(text)
    return { ok: true }
  } catch (e) {
    const msg = String(e?.message ?? e)
    const m = msg.match(/position (\d+)/)
    if (!m) return { ok: false, why: msg }
    const pos = Number(m[1])
    const before = text.slice(0, pos)
    const line = before.split('\n').length
    const col = pos - before.lastIndexOf('\n')
    const lineText = text.split('\n')[line - 1] ?? ''
    return { ok: false, line, col, why: `${msg}（第 ${line} 行第 ${col} 列）`, near: lineText.slice(0, 160) }
  }
}

/** 端口探活：能连上就是"有东西在听"（不判断是谁，也不杀） */
function portBusy (port, timeoutMs = 400) {
  return new Promise((res) => {
    const s = createServer()
    s.once('error', () => res(true))
    s.once('listening', () => s.close(() => res(false)))
    s.listen(port, '127.0.0.1')
    setTimeout(() => { try { s.close() } catch {} ; res(null) }, timeoutMs)
  })
}

function checkConfigs () {
  const out = []
  let files = []
  try { files = readdirSync(CONFIG_DIR).filter(f => f.endsWith('.json') && !/\.example\./i.test(f)) } catch { return out }
  for (const f of files) {
    const r = parseWithPosition(join(CONFIG_DIR, f))
    out.push({ file: join(CONFIG_DIR, f), ...r })
  }
  return out
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const json = process.argv.includes('--json')
  const setup = run(false)
  const configs = checkConfigs()
  const badConfig = configs.filter(c => !c.ok)
  const ports = []
  for (const p of PORTS) ports.push({ port: p, busy: await portBusy(p) })

  const must = setup.items.filter(i => i.level === 'must' && i.state !== 'ok')
  const warn = setup.items.filter(i => i.level !== 'must' && i.state !== 'ok')
  const state = (must.length || badConfig.length) ? 'red' : (warn.length ? 'yellow' : 'green')

  const body = {
    schema: 1,
    kind: 'doctor',
    at: new Date().toISOString(),
    source: 'doctor.mjs',
    state,
    workspace: WORKSPACE,
    counts: { must: must.length, warn: warn.length, badConfig: badConfig.length, portsBusy: ports.filter(p => p.busy).length },
    setup,
    configs,
    ports
  }

  if (json) {
    console.log(JSON.stringify(body, null, 2))
    process.exit(state === 'green' ? 0 : (state === 'yellow' ? 0 : 3))
  }

  const mark = { ok: '✅', fixed: '🔧', todo: '❌', warn: '⚠️', unknown: '❔' }
  console.log(`\n[doctor] 工作台：${WORKSPACE}`)
  for (const it of setup.items) {
    console.log(`  ${mark[it.state] ?? '❔'} ${it.name}　${it.detail ?? ''}`)
    if (it.state === 'todo' && it.hint) console.log(`      → ${it.hint}`)
  }
  if (configs.length) {
    console.log('\n  配置可解析：')
    for (const c of configs) {
      console.log(`    ${c.ok ? '✅' : '❌'} ${c.file}`)
      if (!c.ok) {
        console.log(`        ${c.why}`)
        if (c.near) console.log(`        ${c.near}`)
      }
    }
  }
  const busy = ports.filter(p => p.busy).map(p => p.port)
  if (busy.length) console.log(`\n  端口在听：${busy.join(', ')}（正常：这些是本系统的常驻口；换机器时被别的东西占着要改配置）`)

  const head = state === 'green' ? '✅ 可起飞' : (state === 'yellow' ? `⚠️ 能跑但有限制（${warn.length} 项可选未就绪）` : `❌ 还差 ${must.length + badConfig.length} 项`)
  console.log(`\n[doctor] ${head}`)
  if (state !== 'green') console.log('[doctor] 想让机器自己修能修的：node setup.mjs --apply')
  process.exit(state === 'red' ? 3 : 0)
}
