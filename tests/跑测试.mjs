/**
 * 跑测试 + 留证据 —— 零依赖，不引测试框架。
 *
 * 用法：
 *   node tests/跑测试.mjs                                  # 跑 tests/ 下全部 *.test.mjs
 *   node tests/跑测试.mjs --grep 阶段0                      # 只跑文件名含"阶段0"的
 *   node tests/跑测试.mjs --out <证据目录> --tag 阶段0       # 把命令、输出、退出码、耗时落盘
 *   node tests/跑测试.mjs --file tests/阶段0-枚举.test.mjs   # 只跑一个文件
 *
 * 纪律：证据必须带**命令原文 + 退出码 + 耗时**。只贴"通过了"三个字不算证据。
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')

const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const has = n => argv.includes('--' + n)

const outDir = opt('out')
const tag = opt('tag', 'tests')
const grep = opt('grep')
const oneFile = opt('file')
const timeoutSec = Number(opt('timeout', '600'))

let files
if (oneFile) files = [resolve(ROOT, oneFile)]
else {
  files = readdirSync(HERE)
    .filter(f => f.endsWith('.test.mjs'))
    .filter(f => !grep || f.includes(grep))
    .sort()
    .map(f => join(HERE, f))
}
if (!files.length) {
  console.error(`[跑测试] 没找到测试文件（grep=${grep ?? '-'}）`)
  process.exit(2)
}

const startedAt = new Date().toISOString()
const t0 = Date.now()
const args = ['--test', ...files]
const cmdLine = `node --test ${files.map(f => f.replace(ROOT + '\\', '').replace(ROOT + '/', '')).join(' ')}`
console.log(`[跑测试] ${cmdLine}`)

const r = spawnSync(process.execPath, args, {
  cwd: ROOT,
  encoding: 'utf8',
  timeout: timeoutSec * 1000,
  maxBuffer: 64 * 1024 * 1024,
  env: { ...process.env, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '' }
})
const elapsedMs = Date.now() - t0
const stdout = r.stdout ?? ''
const stderr = r.stderr ?? ''
const exitCode = r.status ?? (r.signal ? 1 : 0)

// node --test 的摘要行：ℹ tests N / ℹ pass N / ℹ fail N
const pick = (label) => {
  const m = stdout.match(new RegExp(`^ℹ ${label} (\\d+)$`, 'm'))
  return m ? Number(m[1]) : null
}
const summary = { tests: pick('tests'), pass: pick('pass'), fail: pick('fail'), cancelled: pick('cancelled'), skipped: pick('skipped') }

const failedNames = [...stdout.matchAll(/^✖ (.+?) \([\d.]+ms\)$/gm)].map(m => m[1])

const result = {
  schema: 1,
  kind: 'test-run',
  at: new Date().toISOString(),
  startedAt,
  source: 'tests/跑测试.mjs',
  state: exitCode === 0 ? 'green' : 'red',
  stale: false,
  tag,
  cmd: cmdLine,
  files: files.length,
  exitCode,
  signal: r.signal ?? null,
  timedOut: r.error?.code === 'ETIMEDOUT',
  elapsedMs,
  summary,
  failed: failedNames
}

if (outDir) {
  const dir = resolve(ROOT, outDir)
  mkdirSync(dir, { recursive: true })
  const stamp = result.at.replace(/[:.]/g, '-')
  const base = join(dir, `${tag}-${stamp}`)
  writeFileSync(base + '.log', `$ ${cmdLine}\n\nexit=${exitCode} elapsedMs=${elapsedMs}\n\n--- stdout ---\n${stdout}\n--- stderr ---\n${stderr}`, 'utf8')
  writeFileSync(base + '.json', JSON.stringify(result, null, 2), 'utf8')
  console.log(`[证据] ${base}.json / .log`)
}

console.log(`[跑测试] exit=${exitCode} tests=${summary.tests} pass=${summary.pass} fail=${summary.fail} elapsed=${elapsedMs}ms`)
if (exitCode !== 0) {
  console.log(stdout.split('\n').filter(l => /^(✖|not ok|ℹ fail)/.test(l)).join('\n'))
  if (stderr.trim()) console.error(stderr.trim().split('\n').slice(-20).join('\n'))
}
process.exit(exitCode)
