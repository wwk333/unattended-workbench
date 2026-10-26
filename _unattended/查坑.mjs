#!/usr/bin/env node
/**
 * 查坑 —— **遇到报错/异常时的第一跳**（0.2 秒、零 token、只读）
 *
 * 为什么有它（用户 2026-10-05 定调）：
 *   坑库的价值 = **一次查中，就省掉 AI 反复试错的一大串 token**。所以"遇到问题先查库"要变成
 *   **一条命令**，而不是让模型自己去翻文件。
 *
 * ⚠️ **它只是"索引前的手段"，绝不代替索引**（用户原话）：
 *   字面匹配**一定会漏**（措辞不同 / 只回前 N 条 / 没有语义 / 症状 vs 现象），所以：
 *   **每一跳都必须说出"我可能漏了 → 下一步去哪"**，本脚本把这条路打在输出里（命中时也打）。
 *
 * 三跳（所有角色统一，见 `roles\brain.md` 的「坑库」一节）：
 *   ① 本脚本  →  ② 扫 `_索引.md` 的标题行（一行一条，**不读正文**）  →  ③ grep 全库（最全）
 *
 * 用法：
 *   node 查坑.mjs "docker,镜像"            # 按关键词查（逗号/空格/分号都行）
 *   node 查坑.mjs "刚体" --limit 12        # 多给几条
 *   node 查坑.mjs --topics                 # 看有哪些主题（换词用）
 *   node 查坑.mjs --recent 10              # 看最新 10 条（没有关键词时用）
 *   node 查坑.mjs "x" --topic Docker·部署   # 只在某主题里查
 *   node 查坑.mjs "x" --json               # 机器可读
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_VAULT, findPitfalls, TOPIC_ORDER } from './_坑库.mjs'

const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const num = (n, d) => { const v = opt(n); if (v == null) return d; const x = Number(v); return Number.isFinite(x) ? x : d }

const VAULT = opt('vault', process.env.DSH_PITFALL_VAULT ?? DEFAULT_VAULT)
const LIMIT = num('limit', 8)
const AS_JSON = has('json')
const TOPICS = has('topics')
const RECENT = num('recent', 0)
// 位置参数（去掉 --xxx 和它的值）当关键词
const positional = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) { if (argv[i + 1] && !argv[i + 1].startsWith('--')) i++; continue }
  positional.push(argv[i])
}
const KEYWORDS = positional.join(' ').split(/[,，;；\s]+/).map(s => s.trim()).filter(Boolean)
const TOPIC_FILTER = opt('topic', null)

/**
 * ★W3（D20）：**空库不是错误**。
 *   以前这里 `exit 2`：新人第一次遇错来查库，第一跳就红 —— 规矩第 21 条（遇错先查坑）当场作废。
 *   现在：库不存在 / 是空的 ⇒ 回 0 条 + **教他怎么记第一条**，退出码 0。
 *   ⚠️ 但"读不到"（目录在、权限坏/编码坏）仍然是**硬错** exit 2 —— 那是故障，不是空库。
 */
const VAULT_EXISTS = Boolean(VAULT) && existsSync(VAULT)
if (!VAULT_EXISTS) {
  const why = VAULT ? `坑库还没建：${VAULT}` : '还没配坑库（config\\本机映射.json 的「坑库」或环境变量 DSH_PITFALL_VAULT）'
  if (AS_JSON) {
    console.log(JSON.stringify({ schema: 1, kind: 'pitfall-query', at: new Date().toISOString(), source: '查坑.mjs', state: 'empty', hits: [], why, howToFirst: HOW_TO_FIRST() }, null, 2))
  } else {
    console.log(`ℹ️ ${why}`)
    console.log('   这不是错误：**空库也能开工**，只是查不到历史教训。')
    console.log(HOW_TO_FIRST())
  }
  process.exit(0)
}

const pf = findPitfalls(KEYWORDS, VAULT)
if (!pf.ok) { console.error(`❌ 读不到坑库（${pf.reason}）`); process.exit(2) }

/** 空库时教人记第一条 —— 一段能直接抄的四段式 */
function HOW_TO_FIRST () {
  return [
    '',
    '怎么记第一条坑（四段式，AI 会帮你合并与建索引）：',
    '  在坑库目录建一个 `YYYY-MM-DD 一句话标题.md`，正文四段：',
    '    现象｜报错原文（**原样贴，别翻译**）',
    '    根因｜为什么会这样（不是"因为代码写错了"，要具体到哪一行/哪个前提）',
    '    对策｜下次怎么一次做对（可执行的一句话）',
    '    证据｜哪条命令/哪个日志证明它对',
    '  然后跑 `node _unattended\\索引生成器.mjs` 重算索引。'
  ].join('\n')
}

// 「下一步」那段——**命中时也要打**（命中的可能不是最对的那条）
const NEXT_STEPS = () => [
  '⚠️ 这些都不对？**别以为库里没有** —— 按顺序再来两步（用户定稿的三跳流程）：',
  `   ② 扫索引标题（一行一条，**只扫标题/对策，别读正文**）：`,
  `      read  ${join(VAULT, '_索引.md')}`,
  `   ③ 全库搜你的**报错原文**（内容匹配，最全）：`,
  `      grep  "<报错原文里的 2–3 个词>"  ${VAULT}`,
  '   换词也可以：`node 查坑.mjs --topics` 看有哪些主题 · `--recent 10` 看最新坑'
]

let hits = TOPIC_FILTER ? pf.hits.filter(h => h.topic === TOPIC_FILTER) : pf.hits
hits = TOPIC_FILTER ? hits : hits.slice(0, LIMIT)

if (AS_JSON) {
  console.log(JSON.stringify({
    query: KEYWORDS, vault: VAULT, scanned: pf.total, hitCount: pf.hits.length, topic: TOPIC_FILTER ?? null,
    // ★ 八·S6：格式认不出的（四段式/对策取不到）如实带出 —— 不丢、不静默
    unparsed: pf.unparsed ?? [],
    hits: hits.map(h => ({ file: h.file, path: h.path, title: h.title, date: h.date, topic: h.topic, severity: h.severity, status: h.status, fix: h.fix, score: h.score, strong: h.strong, why: h.which })),
    nextSteps: ['扫索引标题：' + join(VAULT, '_索引.md'), 'grep 全库：' + VAULT]
  }, null, 2))
  process.exit(0)
}

const line = (s = '') => console.log(s)

// ★ 八·S6：坑库同款"认不出的不丢＋有告警" —— 四段式/对策取不出的文件列出来（已按全文兜底、没丢）
const warnUnparsed = () => {
  const u = pf.unparsed ?? []
  if (!u.length) return
  line(`⚠️ 另有 ${u.length} 篇**没按四段式写**（已按全文兜底、没丢；建议照 \`_约定.md\` 补齐）：`)
  for (const x of u.slice(0, 6)) line(`   ${x.file} —— ${x.why}`)
  if (u.length > 6) line(`   …还有 ${u.length - 6} 篇`)
  line('')
}

// --topics：主题分布（帮着换词）
if (TOPICS) {
  const by = new Map()
  for (const h of pf.hits.length ? pf.hits : []) by.set(h.topic, (by.get(h.topic) ?? 0) + 1)
  line(`🗂 坑库主题分布（共 ${pf.total} 条；下面数字是"本次关键词命中"数，便于你判断该往哪查）`)
  for (const t of TOPIC_ORDER) if (by.get(t)) line(`   ${t.padEnd(16)} ${by.get(t)}`)
  line('')
  line('提示：把主题名当关键词再查一次，例如 `查坑.mjs "Docker,镜像"`。')
  process.exit(0)
}

// --recent：看最新
if (RECENT) {
  const all = findPitfalls(['的'], VAULT).hits        // 用一个几乎必然命中的词把全库拉出来
  const byDate = all.sort((a, b) => String(b.date).localeCompare(String(a.date)) || b.file.localeCompare(a.file)).slice(0, RECENT)
  line(`📌 最新 ${byDate.length} 条坑（共 ${pf.total} 条）`)
  for (const h of byDate) {
    line(`   ${h.date ?? '—'}  ${h.title.slice(0, 70)}`)
    if (h.fix) line(`        对策：${h.fix}`)
    line(`        文件：${h.file}`)
  }
  line('')
  warnUnparsed()
  for (const s of NEXT_STEPS()) line(s)
  process.exit(0)
}

// 主路径：按关键词查
line(`🕳 查坑 「${KEYWORDS.join(', ') || '（没给关键词）'}」 · **命中 ${pf.hits.length} 条**（共扫 ${pf.total} 条 · ${VAULT}）`)
line('')

if (!pf.hits.length) {
  line('❌ 没命中 —— **但这不等于"库里没有"**：措辞不一样就匹配不到（"Docker Hub 直连被墙" vs "镜像拉取超时"）。')
  line('   所以**先别自己硬试**，按下面两步走一遍（通常 10 秒内就有结论）：')
  line('')
} else {
  for (const [i, h] of hits.entries()) {
    line(` ${String(i + 1).padStart(2)}. ${h.strong ? '🎯强' : '· 弱'} ${String(h.score).padStart(3)} 分  ${h.date ?? '—'}  ${h.title.slice(0, 62)}`)
    line(`     ${h.topic ? '[' + h.topic + '] ' : ''}${h.severity ? h.severity + ' · ' : ''}${h.status ?? ''}`.trimEnd())
    if (h.fix) line(`     对策：${h.fix}`)
    line(`     文件：${h.file}`)
  }
  line('')
}
warnUnparsed()
for (const s of NEXT_STEPS()) line(s)
