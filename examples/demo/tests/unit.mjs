#!/usr/bin/env node
/**
 * demo 项目的单元测试（零依赖，自己数数）。
 * 入口验收证明"整机能走通"，这里证明"单元行为对" —— 两者缺一不可。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT = resolve(HERE, '..')
let pass = 0
let fail = 0
function check (name, cond) {
  if (cond) { pass++; console.log(`  ✅ ${name}`) } else { fail++; console.log(`  ❌ ${name}`) }
}

const dir = mkdtempSync(join(tmpdir(), 'demo-unit-'))
try {
  const input = join(dir, 'in.txt')
  const output = join(dir, 'out.txt')

  // 1. 正常三行
  writeFileSync(input, 'a\nb\nc\n', 'utf8')
  execFileSync(process.execPath, [join(PROJECT, 'src', 'convert.mjs'), input, output], { encoding: 'utf8' })
  const got = readFileSync(output, 'utf8')
  check('三行编号正确', got.startsWith('1: a\n2: b\n3: c\n'))
  check('行数统计正确', got.includes('# 共 3 行'))

  // 2. 空行被忽略
  writeFileSync(input, 'x\n\n\ny\n', 'utf8')
  execFileSync(process.execPath, [join(PROJECT, 'src', 'convert.mjs'), input, output], { encoding: 'utf8' })
  const got2 = readFileSync(output, 'utf8')
  check('空行不计数', got2.includes('# 共 2 行'))
  check('空行不占编号', got2.includes('2: y'))

  // 3. 缺参数 ⇒ 非零退出（不许静默成功）
  let code = 0
  try { execFileSync(process.execPath, [join(PROJECT, 'src', 'convert.mjs')], { encoding: 'utf8', stdio: 'pipe' }) } catch (e) { code = e.status }
  check('缺参数退出码 2', code === 2)
} finally {
  rmSync(dir, { recursive: true, force: true })
}

console.log(`\n单测 ${pass}/${pass + fail}`)
process.exit(fail === 0 ? 0 : 1)
