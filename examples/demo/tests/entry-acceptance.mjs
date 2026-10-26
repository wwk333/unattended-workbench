#!/usr/bin/env node
/**
 * demo 项目的**入口验收适配器**（施工文档 §二）
 *
 * 它证明的是"从**真实入口**走通至少一个用户核心任务"：
 *   ① 跑真实命令 `node src/convert.mjs in.txt out.txt`；
 *   ② 读真实产物、逐条断言内容；
 *   ③ 把结论写成统一证据 `_crew/gate/entry-evidence.json`（带 snapshotId）。
 *
 * 内核只认这份证据。所以这里**必须有 checks 且逐条为真、必须有真实产物** ——
 * 只写 `ok:true` 的适配器会被门禁判红（那叫橡皮章）。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = resolve(HERE, '..')
const WORKBENCH = resolve(PROJECT, '..', '..')
const GATE_DIR = join(PROJECT, '_crew', 'gate')
const TMP = join(GATE_DIR, 'entry-tmp')

// 快照必须与门禁算的是**同一个**（唯一实现，绝不自己算第二份）
const { computeSnapshot } = await import('file://' + join(WORKBENCH, '_unattended', '契约', '快照.mjs').replace(/\\/g, '/'))
const { readGateJson } = await import('file://' + join(WORKBENCH, '_unattended', '_门禁入口.mjs').replace(/\\/g, '/'))

const gate = readGateJson(PROJECT, PROJECT)
const snap = computeSnapshot({ project: PROJECT, gate: gate?.data ?? null })

mkdirSync(TMP, { recursive: true })
const input = join(TMP, 'in.txt')
const output = join(GATE_DIR, 'entry-output.txt')
writeFileSync(input, 'alpha\nbeta\ngamma\n', 'utf8')
try { rmSync(output, { force: true }) } catch {}

const checks = []
let exitCode = null
let stdout = ''
let stderr = ''

// E1：真实命令能跑通
try {
  stdout = execFileSync(process.execPath, [join(PROJECT, 'src', 'convert.mjs'), input, output], { encoding: 'utf8', timeout: 60000 })
  exitCode = 0
  checks.push({ id: 'E1', ok: true, detail: `真实命令退出码 0（${stdout.trim().slice(0, 80)}）` })
} catch (e) {
  exitCode = e.status ?? -1
  stderr = String(e.stderr ?? e.message ?? '')
  checks.push({ id: 'E1', ok: false, detail: `真实命令失败（exit=${exitCode}）：${stderr.slice(0, 120)}` })
}

// E2：产物真的在、且内容对
let produced = ''
if (existsSync(output)) produced = readFileSync(output, 'utf8')
const want = '1: alpha\n2: beta\n3: gamma\n'
checks.push({
  id: 'E2',
  ok: produced.includes(want),
  detail: produced.includes(want) ? '产物内容与期望逐行一致' : `产物内容不符：${JSON.stringify(produced.slice(0, 80))}`
})

// E3：行数统计对（真实业务字段，不是"跑通就算"）
checks.push({
  id: 'E3',
  ok: produced.includes('# 共 3 行'),
  detail: produced.includes('# 共 3 行') ? '统计行数=3 正确' : '统计行数不对'
})

const ok = checks.every(c => c.ok)
const evidence = {
  schema: 1,
  kind: 'entry',
  snapshotId: snap.snapshotId,
  at: new Date().toISOString(),
  source: 'examples/demo/tests/entry-acceptance.mjs',
  state: ok ? 'green' : 'red',
  ok,
  entry: 'cli:node src/convert.mjs in.txt out.txt',
  checks,
  artifacts: existsSync(output) ? ['_crew/gate/entry-output.txt'] : [],
  durationMs: null,
  stale: false
}
mkdirSync(GATE_DIR, { recursive: true })
writeFileSync(join(GATE_DIR, 'entry-evidence.json'), JSON.stringify(evidence, null, 2), 'utf8')
console.log(`[entry] ${ok ? '✅ 通过' : '❌ 失败'} ${checks.map(c => `${c.id}=${c.ok ? 'ok' : 'RED'}`).join(' ')}`)
process.exit(ok ? 0 : 1)
