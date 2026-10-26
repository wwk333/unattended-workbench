/**
 * 「外壳」面板侧（★ b126）—— 把 `_unattended\装外壳.mjs` 包成两个只读/写口，给看板的提示条用。
 *
 * ⚠️ **判据不在这里**：状态机、幂等、`--uninstall` 之后永不再建、'不认识的文件不许覆盖'、浏览器探测、
 *    桌面路径重定向……**全在 `装外壳.mjs` 里**（唯一实现）。本文件只做三件事：spawn、解析 JSON、转手。
 *    ⇒ 面板与命令行跑的是**同一条链**，不会两套口径。
 */
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))       // = _unattended\面板
const UNATTENDED = resolve(HERE, '..')
const SHELL = join(UNATTENDED, '装外壳.mjs')

function run (args) {
  const r = spawnSync(process.execPath, [SHELL, ...args, '--json'], {
    cwd: UNATTENDED, encoding: 'utf8', timeout: 180000, windowsHide: true
  })
  const out = String(r.stdout ?? '')
  try {
    const j = JSON.parse(out.slice(out.indexOf('{')))
    return { ok: true, ...j }
  } catch {
    return { ok: false, error: (String(r.stderr ?? '').trim() || out.trim() || `exit=${r.status}`).slice(0, 400) }
  }
}

/** 只读状态（`--check` 那一档；**不写任何东西**）。 */
export function shellStatus () { return run(['--check']) }

/** 写操作：`install`（建立）／`dismiss`（不用了）／`uninstall`（卸载）／`recheck`（重查）。 */
export function shellAction (op) {
  const map = { install: '--install', dismiss: '--dismiss', uninstall: '--uninstall', recheck: '--check' }
  const a = map[String(op ?? '')]
  if (!a) return { ok: false, error: `未知操作：${op}（可用 ${Object.keys(map).join(' / ')}）` }
  return run([a])
}
