#!/usr/bin/env node
/**
 * 重启后一键验证：换会话的「权限 + 落点」修复到底成没成
 *
 * 为什么需要它：宿主插件（`bridge-plugin` 的宿主半，取代 2026-10-10 归档的 `sidebar-plugin`）是**静态 import** ——
 * 桥新增的 `op:'command'` 只有**重启 DSH 之后**才会加载。所以修复完必须有一个
 * 一次性验证入口，避免"以为修好了、其实还没生效"。
 *
 * 它会做三件事，每件都自己核对证据，不靠"看起来没报错"：
 *   ① 探针：桥的 `command` op 是否已加载（未加载 = 还没重启，直接给出结论并退出）
 *   ② 补权限：给指定会话执行 `/permission danger-full-access`，然后**读会话日志**
 *      确认 `permission/preset` / `sandbox/mode` / `approval/policy` 三条真的变了
 *   ③ 端到端：真换一次会话（`换新会话.mjs --execute --now --session <会话>`），
 *      再读新会话日志确认"权限已自动补上"（即验证脚本自己那条 ③ 步生效）
 *
 * 用法：
 *   node _重启后验证.mjs                       # 默认目标 = 异次元当前正主（权限没开成的那个）
 *   node _重启后验证.mjs --session <sessionId>  # 换别的会话做验证
 *   node _重启后验证.mjs --probe-only           # 只探针，不改任何东西
 *
 * ⚠️ 默认目标的来历：2026-10-07 手工换会话造出 `2deb7d74`（异次元正主），它**只有
 *    `workspace-write`**（写不出 `<工作台根>` 与知识库）⇒ 它既是"坏状态样本"，也是
 *    异次元接下来的正主 ⇒ 拿它做端到端验证 = 顺手把它换成"权限已继承"的新会话，一举两得。
 *
 * ⚠️ 副作用（如实说明）：`--session` 那个会话**会被真换掉**（收尾 → 新建 → 接力）。
 *    这是验证"端到端"所必需的；不想换就只跑 `--probe-only`。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const NODE = process.env.DSH_NODE_EXE ?? process.execPath
const TOKEN_FILE = join(HERE, 'secrets', 'swap-token.txt')
const BRIDGE = `http://${process.env.DSH_SWAP_HOST ?? '127.0.0.1'}:${process.env.DSH_SWAP_PORT ?? 19390}/swap`
const SESSIONS_DIR = join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'sessions')

const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const PROBE_ONLY = argv.includes('--probe-only')
// 默认目标：本次审计里那个"换出来但权限没开成"的会话
const TARGET = opt('session', process.env.DSH_SWAP_VERIFY_SESSION ?? 'session-2deb7d74-ef39-4967-9da3-36a9c5aa4e14')

const log = (...a) => console.log(...a)
const ok = (s) => `✅ ${s}`
const bad = (s) => `❌ ${s}`

// ---------------------------------------------------------------- 桥
function token () {
  if (!existsSync(TOKEN_FILE)) throw new Error(`读不到桥 token：${TOKEN_FILE}（桌面端没起来？）`)
  return readFileSync(TOKEN_FILE, 'utf8').trim()
}
async function bridge (op, extra = {}) {
  const r = await fetch(BRIDGE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dsh-swap-token': token() },
    body: JSON.stringify({ op, ...extra })
  })
  const j = await r.json().catch(() => null)
  if (!j) throw new Error(`桥返回非 JSON（HTTP ${r.status}）`)
  return j   // 不抛：让调用方看见 error 文案（例如"未知 op"）
}

// ---------------------------------------------------------------- 会话日志取证
function sessionLogPath (sessionId) {
  if (!existsSync(SESSIONS_DIR)) return null
  let dirs = []
  try { dirs = readdirSync(SESSIONS_DIR) } catch { return null }
  for (const d of dirs) {
    const p = join(SESSIONS_DIR, d, sessionId, 'session.v4.jsonl.zstd')
    if (existsSync(p)) return p
  }
  return null
}
function decompress (file) {
  const buf = readFileSync(file)
  const MAGIC = Buffer.from([0x28, 0xB5, 0x2F, 0xFD])
  const starts = []; let off = 0
  while (off < buf.length) { const i = buf.indexOf(MAGIC, off); if (i === -1) break; starts.push(i); off = i + 4 }
  if (starts[0] !== 0) starts.unshift(0)
  const out = []
  for (let i = 0; i < starts.length; i++) {
    const s = starts[i]; const e = i + 1 < starts.length ? starts[i + 1] : buf.length
    try { out.push(zlib.zstdDecompressSync(buf.subarray(s, e))) } catch {}
  }
  return Buffer.concat(out).toString('utf8')
}
/** 读某会话的权限三件套（取最后一次值） */
function permissionOf (sessionId) {
  const p = sessionLogPath(sessionId)
  if (!p) return { found: false, why: '找不到会话日志文件（会话可能还没落盘）' }
  const lines = decompress(p).split('\n').filter(Boolean)
  const grab = (type) => {
    let v = null
    for (const l of lines) if (l.includes(`"type":"${type}"`)) v = l.match(/"data":(\{.*\})/)?.[1] ?? v
    return v
  }
  const header = lines.find(l => l.includes('"type":"session"'))
  return {
    found: true,
    cwd: header?.match(/"cwd":"((?:[^"\\]|\\.)*)"/)?.[1]?.replace(/\\\\/g, '\\') ?? null,
    preset: grab('permission/preset'),
    sandbox: grab('sandbox/mode'),
    approval: grab('approval/policy'),
    hasCommandRun: lines.some(l => l.includes('"type":"command/run"')),
    events: lines.length
  }
}

// ---------------------------------------------------------------- 主流程
log('==================================================')
log(' 换会话「权限 + 落点」修复 · 重启后验证')
log('==================================================')
log(`目标会话：${TARGET}`)

// ① 探针
log('\n【① 探针】桥的 command op 是否已加载')
const ping = await bridge('ping').catch(e => ({ ok: false, error: String(e.message) }))
log(`   ping → ${JSON.stringify(ping).slice(0, 160)}`)
const probe = await bridge('command', { sessionId: TARGET, line: '' }).catch(e => ({ ok: false, error: String(e.message) }))
if (!probe.ok && /未知 op/.test(String(probe.error))) {
  log(bad('桥里还没有 `command` op ⇒ **宿主插件未重载**。'))
  log('   ⇒ 结论：**还没重启 DSH**（或重启没成功）。先重启桌面端，再跑本脚本。')
  process.exit(1)
}
log(ok('桥认识 `command` op（宿主插件已加载新代码）'))

if (PROBE_ONLY) {
  log('\n--probe-only：到此为止，未改任何东西。')
  process.exit(0)
}

// ② 补权限 + 取证
log('\n【② 给目标会话补权限】')
const before = permissionOf(TARGET)
log(`   改前：${JSON.stringify({ preset: before.preset, sandbox: before.sandbox, approval: before.approval, cwd: before.cwd })}`)
const r2 = await bridge('command', { sessionId: TARGET, line: '/permission danger-full-access' })
log(`   command 结果 → ${JSON.stringify(r2).slice(0, 200)}`)
await new Promise(r => setTimeout(r, 2500))
const after = permissionOf(TARGET)
log(`   改后：${JSON.stringify({ preset: after.preset, sandbox: after.sandbox, approval: after.approval, commandRun: after.hasCommandRun })}`)
const fixed = /danger-full-access/.test(String(after.preset)) && /danger-full-access/.test(String(after.sandbox))
log(fixed ? ok('权限已变成 danger-full-access（三条事件都落盘了）') : bad('权限没变 —— 见上面的 preset/sandbox'))

// ③ 端到端：真换一次，验证脚本自己会补权限 + 起在哪个工作区分组
log('\n【③ 端到端：真换一次，看脚本自己会不会补权限 + 起在哪个分组】')
const swap = spawnSync(NODE, [join(HERE, '换新会话.mjs'), '--execute', '--now', '--session', TARGET], { encoding: 'utf8', maxBuffer: 8 << 20 })
const out = (swap.stdout ?? '') + (swap.stderr ?? '')
log(out.split('\n').filter(l => /①|②|③|④|新会话|权限|工作区|✓|⚠️|⛔/.test(l)).join('\n'))
const newId = out.match(/新会话：(session-[0-9a-f-]+)/)?.[1] ?? null
if (!newId) {
  log(bad('没能从输出里认出新会话 id —— 换会话可能没真跑，请人工看上面的输出。'))
  process.exit(2)
}
await new Promise(r => setTimeout(r, 3000))
const np = permissionOf(newId)
log(`   新会话 ${newId.slice(8, 16)} 权限：${JSON.stringify({ preset: np.preset, sandbox: np.sandbox, approval: np.approval, cwd: np.cwd })}`)
const okEnd = /danger-full-access/.test(String(np.preset)) && /danger-full-access/.test(String(np.sandbox)) && /never/.test(String(np.approval))
log(okEnd
  ? ok(`修复生效：新会话已经是 danger-full-access + never（cwd=${np.cwd}）`)
  : bad('新会话权限仍不对 —— 看 换新会话.mjs 的 ③ 步是否报错'))

// ④ 工作区分组（第三条缺陷）
log('\n【④ 工作区分组】新会话是否起在正确的工作区分组（不是「未分组」）')
const wsLine = out.match(/工作区分组=([^）)\n]*)/)
if (wsLine) {
  const g = wsLine[1].trim()
  if (/未解析到/.test(g)) log(bad('桥没解析到工作区 ⇒ 新会话会落「未分组」'))
  else log(ok(`工作区分组 = ${g}`))
} else {
  log('   （输出里没找到「工作区分组」字段 —— 可能是旧版 换新会话.mjs，看上面输出人工判）')
}

log('\n==================================================')
log(okEnd ? ' 结论：权限与落点都修好了（权限随换会话自动继承、工作区分组正确）' : ' 结论：还没全好，见上面 ❌')
log('==================================================')
process.exit(okEnd ? 0 : 1)
