// 把知识库的坑库索引同步进 Obsidian 项目目录（保证两处同源，不手抄）。
// 源：<知识库>\坑\_索引.md（由 索引生成器.mjs 零 token 生成）
// 目标：<知识库>\项目：多agent协同工作台\05-踩坑全库索引.md
import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KB as KB_FROM_MAP, VAULT as VAULT_FROM_MAP } from './_路径.mjs'

// ★ 2026-10-27（开源准备 W2）：两处路径都从 `_路径.mjs` 取（配置优先），不再写死本机盘符。
const KB = KB_FROM_MAP ?? (VAULT_FROM_MAP ? join(VAULT_FROM_MAP, '..') : null)
if (!KB) {
  console.error('❌ 不知道知识库在哪：去 config\\本机映射.json 填「知识库」（或设 DSH_KB）。')
  process.exit(1)
}
const SRC = join(KB, '坑', '_索引.md')
const DST = join(KB, '项目：多agent协同工作台', '05-踩坑全库索引.md')

if (!existsSync(SRC)) { console.error(`❌ 源不存在：${SRC}（先跑 _unattended\\索引生成器.mjs）`); process.exit(1) }

const body = readFileSync(SRC, 'utf8').replace(/^\uFEFF/, '')
const header = [
  '# 踩坑全库索引（本项目）',
  '',
  '> 本文件是**同步副本**：内容来自知识库 `坑\\_索引.md`，由脚本生成，**不要手改**。',
  '> 为什么要在这儿放一份：项目文档要能**自带**"我们踩过哪些坑"的全景，',
  '> 而不是让人再跑去知识库翻。**改动请改知识库那条坑文件，然后重跑索引生成器 + 本同步脚本。**',
  '> 各条坑的正文在：`<知识库>\\坑\\`',
  '',
  '---',
  '',
  ''
].join('\n')

writeFileSync(DST, header + body, 'utf8')
console.log(`✅ 已同步：${DST}`)
// ★ 2026-10-03 起**不再往知识库写 .bak**：知识库要'只留现状'，而每次同步都在权威目录里落一份原始副本 = 永久垃圾。
//   要比对就直接看源（`坑\_索引.md`）与目标这份，别在权威目录堆副本。
console.log(`   源 ${body.length} 字符 → 目标 ${readFileSync(DST, 'utf8').length} 字符`)
