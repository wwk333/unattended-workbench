/**
 * 测试助手 —— 建临时夹具、读证据、别碰生产 `_crew`。
 *
 * 纪律（全仓测试共用）：
 *   · 每个用例自己在 `os.tmpdir()` 下建目录，用例结束删掉；**绝不写 `<工作台根>\_crew`**；
 *   · 断言用 `node:assert/strict`，失败就让进程非零退出（门禁读退出码）；
 *   · 需要"看一眼真的产物"时用 `dump()`，把 JSON 打进 stdout —— 证据靠输出，不靠人记忆。
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

/** 建一个临时项目目录；传入 `{ 'a/b.txt': '内容' }` 一并写盘 */
export function fixture (files = {}, prefix = 'crew-test-') {
  const root = mkdtempSync(join(tmpdir(), prefix))
  writeFiles(root, files)
  return root
}

export function writeFiles (root, files = {}) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel)
    mkdirSync(dirname(abs), { recursive: true })
    const body = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
    writeFileSync(abs, body, 'utf8')
  }
  return root
}

export function cleanup (root) {
  if (!root) return
  try { rmSync(root, { recursive: true, force: true }) } catch {}
}

export function readJson (abs) {
  return JSON.parse(readFileSync(abs, 'utf8'))
}

export function has (abs) {
  return existsSync(abs)
}

/** 证据输出：`node --test` 会把它留在 stdout，收集脚本直接落盘 */
export function dump (label, value) {
  const body = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  console.log(`\n----- EVIDENCE ${label} -----\n${body}\n----- /EVIDENCE ${label} -----`)
  return value
}

/** 造一份"新格式"gate-result（含 snapshot 段） */
export function gateResultWithSnapshot ({ snapshotId = 'sha256:abc', ok = true, degraded = false, scope = 'all', stamp = '2026-10-25-00-00-00' } = {}) {
  return {
    schema: 1,
    kind: 'gate-result',
    at: new Date().toISOString(),
    source: '门禁.mjs',
    state: ok ? 'green' : 'red',
    stale: false,
    project: 'X:/fixture',
    stamp,
    scope,
    ok,
    degraded,
    summaryText: ok ? '单测 1/1' : '单测 0/1',
    snapshot: { snapshotId, manifestHash: String(snapshotId).replace(/^sha256:/, ''), count: 1, degraded: false }
  }
}
