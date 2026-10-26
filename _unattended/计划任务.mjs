/**
 * 计划任务 —— 看护循环的**兜底**（施工文档 §七「计划任务保看护循环」）
 *
 * 为什么必须要它：看护循环自己也会死，而它死了之后**没有任何东西会发现"看护死了"**
 * （它本来就是那个"发现别人死了"的角色）。周期看护不能靠自指，只能靠系统级定时器。
 *
 * 口径（照 §七）：
 *   · 任务名 `DSH-Crew-Supervisor`；
 *   · 每 5 分钟隐藏运行 `确保看守.mjs --ensure`；
 *   · 已在跑就秒退，不重复拉；
 *   · 看护循环死了，下一轮计划任务补上；
 *   · **由大脑/安装器创建**，不让用户手动建；
 *   · 不弹黑框、不写用户桌面；安装/卸载都留日志。
 *
 * 纪律：本模块**只做三件事**（建/删/查），不自己跑看护。命令构造是纯函数，可以单测。
 */

import { spawnSync } from 'node:child_process'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WORKBENCH = resolve(HERE, '..')

export const TASK_NAME = 'DSH-Crew-Supervisor'
export const INTERVAL_MIN = 5
export const LOG = join(HERE, 'logs', '计划任务.log')

/** 计划任务要跑的那条命令（**唯一**） */
export function taskCommand ({ node = process.execPath, ensureScript = join(HERE, '确保看守.mjs') } = {}) {
  return `"${node}" "${ensureScript}" --ensure`
}

/**
 * 构造 `schtasks /Create` 的参数（**纯函数**，测试直接断言，不真建）。
 * @returns {string[]}
 */
export function buildCreateArgs ({ node = process.execPath, ensureScript = join(HERE, '确保看守.mjs'), minutes = INTERVAL_MIN } = {}) {
  return [
    '/Create',
    '/TN', TASK_NAME,
    '/TR', taskCommand({ node, ensureScript }),
    '/SC', 'MINUTE',
    '/MO', String(minutes),
    '/F', // 已存在就覆盖（幂等）
    '/RL', 'LIMITED' // 不提权：不需要管理员也能跑
  ]
}

export function buildDeleteArgs () {
  return ['/Delete', '/TN', TASK_NAME, '/F']
}

export function buildQueryArgs () {
  return ['/Query', '/TN', TASK_NAME]
}

/** 从 `schtasks /Query` 的输出判断存不存在 */
export function parseQuery (out) {
  const text = String(out ?? '')
  if (/cannot find|找不到|没有|ERROR:/i.test(text)) return { exists: false, raw: text.slice(0, 200) }
  const exists = new RegExp(TASK_NAME, 'i').test(text)
  return { exists, raw: text.slice(0, 400) }
}

function logLine (msg) {
  const line = `[${new Date().toISOString()}] ${msg}`
  try { mkdirSync(dirname(LOG), { recursive: true }); appendFileSync(LOG, line + '\n', 'utf8') } catch {}
  console.log(line)
  return line
}

function runSchtasks (args) {
  const r = spawnSync('schtasks', args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error?.message ?? null }
}

export function status () {
  const r = runSchtasks(buildQueryArgs())
  const parsed = parseQuery(`${r.stdout}\n${r.stderr}`)
  return { ...parsed, exitCode: r.status, name: TASK_NAME }
}

export function install (opts = {}) {
  if (process.platform !== 'win32') return { ok: false, why: '计划任务只在 Windows 上实现（v1 支持范围就是 Windows）' }
  const args = buildCreateArgs(opts)
  const r = runSchtasks(args)
  const ok = r.status === 0
  logLine(`${ok ? '✅ 已建' : '❌ 建不了'} 计划任务 ${TASK_NAME}（每 ${opts.minutes ?? INTERVAL_MIN} 分钟跑 确保看守.mjs --ensure）${ok ? '' : `：${(r.stderr || r.stdout).slice(0, 200)}`}`)
  if (ok) logLine(`   命令：${taskCommand(opts)}`)
  return { ok, args, exitCode: r.status, stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 400) }
}

export function uninstall () {
  if (process.platform !== 'win32') return { ok: false, why: '计划任务只在 Windows 上实现' }
  const r = runSchtasks(buildDeleteArgs())
  const ok = r.status === 0
  logLine(`${ok ? '✅ 已删' : '❌ 删不掉'} 计划任务 ${TASK_NAME}${ok ? '' : `：${(r.stderr || r.stdout).slice(0, 200)}`}`)
  return { ok, exitCode: r.status, stdout: r.stdout.slice(0, 400), stderr: r.stderr.slice(0, 400) }
}

/** 启动自检用：没有计划任务 ⇒ **红灯**，不许假装绿（§七 断点表现） */
export function selfCheck () {
  const s = status()
  return {
    schema: 1,
    kind: 'scheduler-check',
    at: new Date().toISOString(),
    source: '计划任务.mjs',
    state: s.exists ? 'ok' : 'red',
    stale: false,
    name: TASK_NAME,
    exists: s.exists,
    why: s.exists ? null : `计划任务 ${TASK_NAME} 不存在 ⇒ 看护循环死了没人补（启动自检红灯）`
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const a = process.argv.slice(2)
  const has = (n) => a.includes('--' + n)
  if (has('status')) { console.log(JSON.stringify(selfCheck(), null, 2)); process.exit(selfCheck().exists ? 0 : 1) }
  if (has('install')) { const r = install(); process.exit(r.ok ? 0 : 1) }
  if (has('uninstall')) { const r = uninstall(); process.exit(r.ok ? 0 : 1) }
  console.log('用法：计划任务.mjs --status | --install | --uninstall')
  process.exit(2)
}
