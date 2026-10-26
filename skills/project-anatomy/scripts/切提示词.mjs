#!/usr/bin/env node
/**
 * 切提示词.mjs —— 把库内提示词正本里的《项目剖析文档》那两条切进本 skill
 *
 * 为什么要有它：SKILL.md 旁边那份 `references\生成提示词.md` 是**快照**。
 * 提示词的正本永远在库内 `AI优化\提示词.md`（用户维护的地方）；
 * 改完正本**跑一次这个**，快照就同步了 —— 不要手抄，手抄必然漂。
 *
 * 用法：node 切提示词.mjs [--src "<正本路径>"] [--out "<快照路径>"]
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'

const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }

const SRC = resolve(opt('src', '{{知识库}}/AI优化/提示词.md'))
const OUT = resolve(opt('out', '{{知识库}}/人机协作SOP-唯一源/skills/project-anatomy/references/生成提示词.md'))

if (!existsSync(SRC)) { console.error('✗ 提示词正本不存在：' + SRC); process.exit(2) }
const text = readFileSync(SRC, 'utf8').replace(/^\uFEFF/, '')
const lines = text.split(/\r?\n/)
const i1 = lines.findIndex((l) => l.startsWith('1.《项目剖析文档》'))
const i2 = lines.findIndex((l) => l.startsWith('2.《项目剖析文档》'))
if (i1 < 0) { console.error('✗ 正本里找不到「1.《项目剖析文档》生成提示词」那一节'); process.exit(2) }

const head = lines.slice(i1, i2 > 0 ? i2 : lines.length).join('\n').trimEnd()
const exp = i2 > 0 ? lines.slice(i2).join('\n').trimEnd() : ''
const out = [
  '# 生成提示词（可直接整段发给别的 AI）',
  '',
  '> 出处：库内 `AI优化\\提示词.md`（本文件是从它**切**出来的快照，不是手抄）。',
  '> 要改提示词 → 改正本 → 跑 `node scripts\\切提示词.mjs` 重切，别在这里手改。',
  '> 用法：把 `<项目目录>`、`<库路径>` 换成真值，整段复制。',
  '',
  head,
  '',
  '---',
  '',
  exp,
  ''
].join('\n')

writeFileSync(OUT, out, 'utf8')
console.log('✅ 已重切 →', OUT)
console.log('   来源 =', SRC)
console.log('   行数 =', out.split('\n').length)
