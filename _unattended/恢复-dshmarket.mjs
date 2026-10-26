#!/usr/bin/env node
/**
 * 恢复 dshmarket → 1.66.35（2026-10-18 事故后遗留的 4 个禁用插件之一）。
 *
 * 为什么要是「独立脚本」：装插件必须完全退出 DSH，而 DSH 一死，会话里的一切都没了。
 * 所以本脚本用 WMI 起成**无父进程**，自己扛过 DSH 被杀，做完事再把 DSH 拉起来。
 *
 * 步骤：等 DELAY 秒 → 杀 DSH → 备份 patch/package.json → plugin add dshmarket@1.66.35
 *      → 校验装上的版本 → 从 patch 删掉「dsh-market: disabled」→ 起 DSH
 *      → 等桥 /board 通 → 查 crash 日志 → 跑起飞前检查 → 写结果
 * 失败（装不上 / 起不来 / 有 dshmarket 的 crash）→ **自动回滚** patch 并重启，结果里如实写。
 *
 * 用法：node 恢复-dshmarket.mjs [--delay 秒]   （默认 90 秒，留时间给人看最后的提示）
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, copyFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import { CLI_JS as CLI_JS_P, DSH_EXE as DSH_EXE_P, NODE_BIN as NODE_P, WORKSPACE as WS_P, need } from './_路径.mjs'

const EXE = need('DSH 主程序', DSH_EXE_P)
const CLI = need('DSH headless 入口', CLI_JS_P)
const NODE = need('专用 node（DSH 自带）', NODE_P)
const WS = WS_P
const PROFILE = join(homedir(), '.dsh', 'profiles', 'desktop')
const PATCH = join(PROFILE, 'cordis.patch.yml')
const PKGJSON = join(PROFILE, 'package.json')
const RESULT = join(WS, '_crew', '插件恢复结果.json')
const LOGDIR = join(WS, '_unattended', 'logs')
const LOG = join(LOGDIR, '插件恢复-dshmarket.log')
const CRASHDIR = join(process.env.APPDATA ?? '', '@deepseek-ai', 'dsh-desktop', 'logs')
const TARGET = 'dshmarket@1.66.35'
const PATCH_ID = 'dsh-market'
const DELAY = Number((process.argv.find((a) => a.startsWith('--delay'))?.split('=')[1]) ?? 90)

mkdirSync(LOGDIR, { recursive: true })
const t0 = Date.now()
function log (s) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`
  try { writeFileSync(LOG, line + '\n', { flag: 'a' }) } catch {}
  console.log(line)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function httpOK (url) {
  try {
    const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), 4000)
    const r = await fetch(url, { signal: ac.signal }); clearTimeout(tm)
    return r.status
  } catch { return 0 }
}

function dshPids () {
  // 用 tasklist 的 CSV 输出数：taskkill 的过滤输出没有稳定的 PID 行，解析会漏。
  const r = spawnSync('tasklist', ['/FI', 'IMAGENAME eq DeepSeek Harness.exe', '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true })
  return String(r.stdout ?? '').split(/\r?\n/).filter((l) => /^"DeepSeek Harness\.exe"/i.test(l.trim()))
}

async function killDSH () {
  spawnSync('taskkill', ['/F', '/IM', 'DeepSeek Harness.exe'], { encoding: 'utf8', windowsHide: true })
  for (let i = 0; i < 20; i++) {
    if (dshPids().length === 0) return true
    await sleep(500)
  }
  return false
}

async function startDSH () {
  // 已经有一只在跑（比如探针意外把 GUI 拉起来了）就别再起第二只
  if (dshPids().length === 0) {
    const p = spawn(EXE, [], { detached: true, stdio: 'ignore', windowsHide: false })
    p.unref()
  }
  // 就绪判据：桥 /board 通（比"有窗口"更硬）；最多等 180s
  for (let i = 0; i < 60; i++) {
    await sleep(3000)
    if (await httpOK('http://127.0.0.1:19390/board') === 200) return true
  }
  return false
}

function newestCrash () {
  try {
    const fs = readdirSync(CRASHDIR).filter((f) => f.endsWith('.log')).map((f) => join(CRASHDIR, f))
    if (!fs.length) return null
    fs.sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    return fs[0]
  } catch { return null }
}

function runPreflight () {
  const r = spawnSync(NODE, ['起飞前检查.mjs'], { cwd: join(WS, '_unattended'), encoding: 'utf8', windowsHide: true, timeout: 15 * 60_000, maxBuffer: 8 << 20 })
  const out = String(r.stdout ?? '') + String(r.stderr ?? '')
  return { exit: r.status, tail: out.trim().split('\n').slice(-6).join('\n') }
}

function writeResult (o) {
  const body = { at: new Date().toISOString(), target: TARGET, ...o }
  try { writeFileSync(RESULT, JSON.stringify(body, null, 2), 'utf8') } catch (e) { log('结果写不进：' + e.message) }
  log('结果 → ' + RESULT)
  return body
}

async function main () {
  log(`启动：${TARGET}，${DELAY}s 后开始（此刻 DSH 仍在跑，可继续用）`)
  await sleep(DELAY * 1000)

  const before = { pids: dshPids().length, bridge: await httpOK('http://127.0.0.1:19390/board') }
  log(`改前：DSH 进程 ${before.pids} 个，桥 ${before.bridge}`)

  // 1) 备份（含"当前"patch，此时 persona 路径已修好）
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const bk = join(WS, '_crew', 'backup', `插件恢复-dshmarket-${stamp}`)
  mkdirSync(bk, { recursive: true })
  const patchBefore = readFileSync(PATCH, 'utf8')
  const pkgBefore = readFileSync(PKGJSON, 'utf8')
  writeFileSync(join(bk, 'cordis.patch.yml'), patchBefore, 'utf8')
  writeFileSync(join(bk, 'package.json'), pkgBefore, 'utf8')
  log(`备份 → ${bk}`)

  // 2) 杀 DSH
  if (!(await killDSH())) {
    log('❌ DSH 杀不掉，放弃（未做任何修改）')
    writeResult({ ok: false, stage: 'kill', note: '进程杀不掉', backupDir: bk })
    return
  }
  await sleep(6000)
  log('DSH 已退出')

  // 2b) 先验 CLI 能 headless 跑（跑不起来就收兵，一个文件都不改）
  const probe = spawnSync(EXE, ['--expose-internals', CLI, 'plugin', '--help'], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 90_000,
    maxBuffer: 8 << 20
  })
  const probeOut = (String(probe.stdout ?? '') + String(probe.stderr ?? '')).trim()
  log(`CLI 探针：exit=${probe.status} ${probeOut.slice(0, 300) || '（无输出）'}`)
  if (probe.status !== 0 || probeOut.length < 10) {
    log('❌ CLI 起不来（大概率 ELECTRON_RUN_AS_NODE 没生效）→ 不改任何文件，把 DSH 起回去')
    const up = await startDSH()
    writeResult({ ok: false, stage: 'cli', probeExit: probe.status, probeOut: probeOut.slice(0, 1000), backupDir: bk, dshUp: up })
    return
  }

  // 3) 装插件
  log(`执行：plugin add ${TARGET}`)
  const add = spawnSync(EXE, ['--expose-internals', CLI, 'plugin', '--profile', 'desktop', 'add', TARGET], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    windowsHide: true,
    timeout: 15 * 60_000,
    maxBuffer: 16 << 20
  })
  const addOut = (String(add.stdout ?? '') + String(add.stderr ?? '')).trim()
  log(`plugin add 退出码 ${add.status}：${addOut.slice(-600) || '（无输出）'}`)

  const pkgAfter = existsSync(PKGJSON) ? readFileSync(PKGJSON, 'utf8') : ''
  const installed = existsSync(join(PROFILE, 'node_modules', 'dshmarket', 'package.json'))
    ? JSON.parse(readFileSync(join(PROFILE, 'node_modules', 'dshmarket', 'package.json'), 'utf8')).version
    : null
  log(`package.json 期望 1.66.35；node_modules 实际 ${installed}`)

  if (add.status !== 0 || installed !== '1.66.35') {
    log('❌ 安装没成功 → 回滚 patch 并重启 DSH')
    const pre = runPreflight()
    const up = await startDSH()
    writeResult({ ok: false, stage: 'install', addExit: add.status, addOut: addOut.slice(-1500), installed, backupDir: bk, dshUp: up, preflightExit: pre.exit })
    return
  }

  // 4) 删掉 patch 里的 disabled（只删 dsh-market 那两行）
  const re = new RegExp(`- id: ${PATCH_ID}\\r?\\n  disabled: true\\r?\\n`)
  const hits = (patchBefore.match(re) ?? []).length
  if (hits !== 1) {
    log(`⚠️ patch 里 dsh-market disabled 命中 ${hits} 次（应为 1）→ 保守起见不改 patch，直接重启并报告`)
    const up = await startDSH()
    writeResult({ ok: false, stage: 'patch', hits, installed, backupDir: bk, dshUp: up })
    return
  }
  writeFileSync(PATCH, patchBefore.replace(re, ''), 'utf8')
  log('已从 patch 删除 dsh-market 的 disabled 行')

  // 5) 起 DSH（失败 = 回滚）
  let up = await startDSH()
  log(`DSH 启动：${up ? '桥已通' : '❌ 180s 内桥未通'}`)

  const crash = newestCrash()
  const crashText = crash ? readFileSync(crash, 'utf8') : ''
  const badCrash = /dshmarket|dsh-market/i.test(crashText) && /incompatible|error|failed|throw/i.test(crashText)

  if (!up || badCrash) {
    log(`❌ 启动异常（badCrash=${badCrash}）→ 回滚：恢复 patch 的 disabled 行并重启`)
    await killDSH(); await sleep(3000)
    writeFileSync(PATCH, patchBefore, 'utf8')
    up = await startDSH()
    const pre = up ? runPreflight() : { exit: null, tail: '' }
    writeResult({ ok: false, stage: 'boot', dshUp: up, badCrash, crashFile: crash, crashTail: crashText.slice(-1200), backupDir: bk, preflightExit: pre.exit, preflightTail: pre.tail })
    return
  }

  // 6) 自检
  const bd = await httpOK('http://127.0.0.1:19390/board')
  const pre = runPreflight()
  log(`桥 ${bd}；起飞前检查 exit=${pre.exit}`)
  writeResult({
    ok: pre.exit === 0 && bd === 200,
    stage: 'done',
    installed,
    bridge: bd,
    preflightExit: pre.exit,
    preflightTail: pre.tail,
    crashFile: crash,
    backupDir: bk,
    seconds: Math.round((Date.now() - t0) / 1000)
  })
}

main().catch((e) => {
  log('❌ 未捕获异常：' + String(e?.stack ?? e).slice(0, 1200))
  try { writeResult({ ok: false, stage: 'exception', error: String(e?.message ?? e) }) } catch {}
  process.exit(1)
})
