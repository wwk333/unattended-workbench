#!/usr/bin/env node
/**
 * demo 项目的真实入口：`node src/convert.mjs <输入> <输出>`
 *
 * 刻意做成"有真实产物"的小工具 —— 入口验收要能证明"命令真跑了、产物真对"，
 * 而不是只回一句 ok:true。
 */

import { readFileSync, writeFileSync } from 'node:fs'

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  console.error('用法：node src/convert.mjs <输入.txt> <输出.txt>')
  process.exit(2)
}

const text = readFileSync(input, 'utf8')
// 真实业务：把每行转成"序号: 内容"，并统计行数
const lines = text.split(/\r?\n/).filter(l => l.length > 0)
const out = lines.map((l, i) => `${i + 1}: ${l}`).join('\n') + `\n# 共 ${lines.length} 行\n`
writeFileSync(output, out, 'utf8')
console.log(`[convert] ${lines.length} 行 → ${output}`)
