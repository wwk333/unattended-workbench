#!/usr/bin/env node
/**
 * 坑库索引生成器 —— 无人值守模式 · 第 1 步 ⑥
 *
 * 干什么：扫 `<知识库>\坑\` 下所有 `*.md`，按 `_索引.md` 里写明的规则
 *         重新生成 `_索引.md`。**零 token、纯本地、只写这一个文件**。
 *
 * 规则（照抄 `_索引.md` 自己的「生成说明」，不另立规矩）：
 *   1. 跳过 `_` 开头的文件（`_模板` / `_索引` / `_约定`）与 `.obsidian` / `.trash` / `.git`
 *   2. 读 frontmatter 的 tags / date / severity / status；标题取一级标题，取不到就用文件名
 *   3. 按 tags 里除 `踩坑` 外的**第一个标签**分组；没标签的进「未分类」
 *   4. 「最近 10 条」按 date 倒序，同日期按文件名字典序倒序
 *   5. 计数：总数、今日新增、本周新增、status=待定、severity=卡死
 *   6. **frontmatter 读不懂不跳过、不静默略过** → 归「未分类」并标 `(frontmatter 解析失败)`
 *
 * 用法：
 *   node 索引生成器.mjs               # 生成并写回 _索引.md
 *   node 索引生成器.mjs --dry-run      # 只打印，不写文件
 *   node 索引生成器.mjs --vault <路径> # 换库根
 */

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
// ★ 2026-10-05：主题分类与「一句话对策」抽到共享模块 —— `派活.mjs` / `查坑.mjs` / 本脚本
//   **必须是同一套口径**（本项目踩过"同一个东西两套口径"的坑）。见 `_坑库.mjs` 顶部说明。
import { classifyTopic, oneLineFix, TOPIC_ORDER } from './_坑库.mjs'
import { NODE_BIN as NODE_P, VAULT as VAULT_P } from './_路径.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
const DRY = argv.includes('--dry-run')
const vi = argv.indexOf('--vault')
const VAULT = vi >= 0 ? resolve(argv[vi + 1]) : VAULT_P
const INDEX = join(VAULT, '_索引.md')

if (!existsSync(VAULT)) {
  console.error(`[索引] ❌ 库根不存在：${VAULT}`)
  process.exit(2)
}

// ---------------------------------------------------------------- 读库

const SELF = new Set(['_索引.md', '_模板.md', '_约定.md'])
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules'])

function listMarkdown (dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      listMarkdown(join(dir, e.name), out)
    } else if (e.isFile() && /\.md$/i.test(e.name)) {
      if (dirname(join(dir, e.name)) === VAULT && SELF.has(e.name)) continue
      if (e.name.startsWith('_')) continue          // 规则 1：跳过下划线开头的
      out.push(join(dir, e.name))
    }
  }
  return out
}

/** 极简 frontmatter 解析：只认顶层 `key: value`（够用；数组形式 `[a, b]` 也认）。 */
function parseFrontmatter (text) {
  if (!text.startsWith('---')) return { ok: false, fm: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end < 0) return { ok: false, fm: {}, body: text }
  const raw = text.slice(3, end)
  const fm = {}
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line.trim())
    if (!m) continue
    let v = m[2].trim()
    if (v.startsWith('[') && v.endsWith(']')) {
      v = v.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    } else {
      v = v.replace(/^["']|["']$/g, '')
    }
    fm[m[1]] = v
  }
  return { ok: true, fm, body: text.slice(end + 4) }
}

function firstHeading (body) {
  const m = /^#\s+(.+)$/m.exec(body ?? '')
  return m ? m[1].trim() : null
}

const files = listMarkdown(VAULT).sort()
const entries = []
const broken = []

for (const f of files) {
  const st = statSync(f)
  let text = ''
  try { text = readFileSync(f, 'utf8') } catch { broken.push({ file: basename(f), why: '读不出内容' }); continue }
  const { ok, fm, body } = parseFrontmatter(text)
  const tags = Array.isArray(fm.tags) ? fm.tags : (fm.tags ? [String(fm.tags)] : [])
  // ★ 2026-10-05：主题改用**共享分类器**（`_坑库.mjs`）—— 因为实测 75 条坑的 tags 全是
  //   `[踩坑, 无人值守]`，按标签分组只有一个桶（等于没主题）。分类器口径：显式 `topic:` → 非默认标签 → 标题关键词。
  const heading = firstHeading(body)
  const title = heading ?? basename(f, '.md')
  const topic = classifyTopic(title, tags)

  entries.push({
    file: basename(f),
    rel: f.slice(VAULT.length + 1).replace(/\\/g, '/'),
    title,
    topic,
    // ★ 2026-10-05：**一句话对策**（取正文 ③ 的第一句）—— 索引里最有用的一列：
    //   它最接近"你遇到问题时的说法"（工具名/报错码/命令），是第 ① 跳字面命中率的关键。
    fix: oneLineFix(text),
    date: typeof fm.date === 'string' ? fm.date : null,
    severity: typeof fm.severity === 'string' ? fm.severity : null,
    status: typeof fm.status === 'string' ? fm.status : null,
    source: typeof fm.source === 'string' ? fm.source : null,
    bytes: st.size,
    mtime: st.mtime.toISOString(),
    fmOk: ok,
    empty: st.size === 0      // 空文件也如实列出（库里就有一个 0 字节的 坑.md）
  })
  if (!ok) broken.push({ file: basename(f), why: 'frontmatter 解析失败（无 --- 头或缺结束 ---）' })
}

// ---------------------------------------------------------------- 统计

const now = new Date()
const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
const weekAgo = new Date(now.getTime() - 7 * 86400_000)
const byTopic = new Map()
for (const e of entries) {
  if (!byTopic.has(e.topic)) byTopic.set(e.topic, [])
  byTopic.get(e.topic).push(e)
}
const recent = [...entries].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || b.file.localeCompare(a.file)).slice(0, 10)
const counts = {
  total: entries.length,
  today: entries.filter(e => e.date === todayKey).length,
  week: entries.filter(e => e.date && Date.parse(e.date) >= weekAgo).length,
  pending: entries.filter(e => e.status === '待定').length,
  fatal: entries.filter(e => e.severity === '卡死').length,
  empty: entries.filter(e => e.empty).length
}

// ---------------------------------------------------------------- 路径脱敏

/**
 * 生成的索引里**不出现本机绝对路径**：前缀换成占位符，**后面的相对部分原样保留**
 * （坑的复现细节、命令参数都不能丢）。只换前缀，不动其它任何字符。
 *   工作台根   → `<工作台根>`
 *   用户目录   → `<用户目录>`（任意 <盘符>:\\Users\\<名字> 都换 —— **不认具体用户名**，
 *                否则这个"脱敏规则"自己就是一份用户名泄露）
 *   DSH 安装根 → `<DSH根>`（兜底：本脚本「生成说明」里的 node.exe 在 DSH 安装根下）
 * 分隔符（\ 或 /）与盘符大小写都认。
 */
const ABS_RULES = [
  [/[A-Z]:[\\/]dsh桌面端[\\/]无人值守/gi, '<工作台根>'],
  [/[A-Z]:[\\/]Users[\\/][^\\/\s]+/gi, '<用户目录>'],
  [/[A-Z]:[\\/]dsh桌面端/gi, '<DSH根>']
]

function scrub (s) {
  let out = s
  for (const [re, ph] of ABS_RULES) out = out.replace(re, ph)
  return out
}

// ---------------------------------------------------------------- 生成

const L = []
L.push('# 踩坑索引')
L.push('')
L.push('> ⚠️ **本文件由脚本零 token 生成，请勿手改**（手改会在下次生成时被覆盖）。')
L.push('> 生成方式见本文件末尾「生成说明」。坑的写法见 `_约定.md`，模板见 `_模板.md`。')
L.push('')
// ★ 2026-10-03 修：原来写的是 `now.toISOString()`（那是 **UTC**）却标着"本地时区"→ 显示时间比本机**少 8 小时**
//   （实测：文件 mtime 20:17，索引里写 12:17）。改成显式格式化本地时间，标签才不撒谎。
const pad2 = (n) => String(n).padStart(2, '0')
const tzHours = -now.getTimezoneOffset() / 60
const localStamp = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())} ${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
L.push(`**生成时间**：${localStamp}（本地时区 ${tzHours >= 0 ? '+' : ''}${tzHours}）`)
L.push(`**坑总数**：${counts.total}`)
L.push('')
L.push('---')
L.push('')
// ★ 2026-10-05 改（用户定稿）：**"按主题分组"从"一格塞一堆链接"改成"一行一条、能扫"**。
//   为什么改（实测）：老写法把 75 条坑的链接全塞进**同一格**（因为所有坑的 tags 都是 `[踩坑, 无人值守]`
//   → 按标签分组只有一个桶），人和 AI 都没法"扫一眼"。而三跳流程的第 ② 跳**就是靠扫这个标题行**。
//   现在：按**主题**分组（主题由 `_坑库.mjs` 的 `classifyTopic` 判：显式 topic → 非默认标签 → 标题关键词），
//   每条**一行**：`日期 · 现象 · **对策一句话** · severity · 文件名` —— **只扫这一行，不读正文**。
L.push('## 怎么用（三跳 —— 遇到问题按这个顺序，别一上来就翻正文）')
L.push('')
L.push('1. **先跑脚本**（0.2 秒、零 token）：`node 查坑.mjs "<报错关键词 / 模块名>"`')
L.push('2. **没命中就来扫本页标题**（一行一条 —— **只扫「现象 + 对策」，不要读正文**）；看着像的，再打开那一条。')
L.push('3. **还不像** 就全库搜你的**报错原文**（内容匹配，最全）：')
L.push('   `grep "<报错原文里的 2–3 个词>" "' + (VAULT_P ?? '<坑库>') + '"`')
L.push('')
L.push('> ⚠️ 第 1 跳是**字面匹配，一定会漏**（措辞不同 / 只回前 N 条 / 没有语义）—— **"没查到"不等于"库里没有"**，必须往下走。')
L.push('')
L.push('---')
L.push('')
L.push('## 按主题（一行一条 · 只扫标题，别读正文）')
L.push('')
if (entries.length === 0) {
  L.push('（还没有坑）')
} else {
  const topicOrder = TOPIC_ORDER.filter(t => byTopic.has(t)).concat([...byTopic.keys()].filter(t => !TOPIC_ORDER.includes(t)))
  for (const topic of topicOrder) {
    const list = byTopic.get(topic)
    if (!list?.length) continue
    L.push(`### ${topic}（${list.length}）`)
    L.push('')
    for (const e of [...list].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')) || a.file.localeCompare(b.file))) {
      const flags = []
      if (!e.fmOk) flags.push('frontmatter 解析失败')
      if (e.empty) flags.push('空文件')
      // ★ 八·S6：取不到「③ 对策」= 这一行对第②跳没用 —— 标出来（不丢、不静默）
      if (!e.fix && !e.empty) flags.push('对策取不到（看文件四段式）')
      const fix = e.fix ? ` · **对策**：${e.fix}` : ''
      L.push(`- \`${e.date ?? '—'}\` · ${e.title}${fix} · ${e.severity ?? '—'}${flags.length ? ' · ⚠️ ' + flags.join('；') : ''} · \`${e.file}\``)
    }
    L.push('')
  }
}
L.push('')
L.push('---')
L.push('')
L.push('## 最近 10 条')
L.push('')
L.push('| 日期 | 现象 | severity | status | 文件 |')
L.push('|---|---|---|---|---|')
if (recent.length === 0) {
  L.push('| — | （还没有坑） | — | — | — |')
} else {
  for (const e of recent) {
    L.push(`| ${e.date ?? '—'} | ${e.title} | ${e.severity ?? '—'} | ${e.status ?? '—'} | \`${e.rel}\` |`)
  }
}
L.push('')
L.push('---')
L.push('')
L.push('## 计数')
L.push('')
L.push('| 维度 | 数字 |')
L.push('|---|---|')
L.push(`| 坑总数 | ${counts.total} |`)
L.push(`| 今日新增 | ${counts.today} |`)
L.push(`| 本周新增 | ${counts.week} |`)
L.push(`| status = 待定 | ${counts.pending} |`)
L.push(`| severity = 卡死 | ${counts.fatal} |`)
L.push(`| 空文件（待填或待删） | ${counts.empty} |`)
L.push('')
L.push('---')
L.push('')
L.push('## 生成说明')
L.push('')
L.push('**目标**：这个索引要能被脚本**零 token** 重建 —— 它只读本目录下的 Markdown，不改任何别的东西。')
L.push('')
L.push('**生成规则（实测可实现）**')
L.push('')
L.push('1. 扫库根下所有 `*.md`，**跳过**下划线开头的文件（`_模板.md` / `_索引.md` / `_约定.md`）与 `.obsidian` / `.trash` / `.git` / `node_modules`。')
L.push('2. 每个文件读 frontmatter 的 `tags` / `date` / `severity` / `status`，标题取一级标题（取不到用文件名）。')
L.push('3. **按 `tags` 里除 `踩坑` 外的第一个标签分组**；没有标签的进「未分类」。')
L.push('4. 「最近 10 条」按 `date` 倒序（同日期按文件名字典序倒序）。')
L.push('5. 「计数」统计总数、今日（= 生成日期）新增、本周新增、`status: 待定`、`severity: 卡死`、空文件数。')
L.push('6. 整个文件重写，**开头固定插入本页顶端那两行警告**。')
L.push('')
L.push('**怎么跑**')
L.push('')
L.push('```powershell')
L.push(`& '${NODE_P ?? '(未配置专用 node)'}' '${join(HERE, '索引生成器.mjs')}'`)
L.push('```')
L.push('')
L.push('**落点与触发**')
L.push('')
L.push('- 脚本：`' + join(HERE, '索引生成器.mjs') + '`')
L.push('- 触发：① 每次「本波次结束、坑已入库」时由大脑主动跑一次；② 可选：由看板的计划任务顺带跑（同一个计划任务里加一行）。')
L.push('- **失败处理**：读不懂 frontmatter 的文件**不跳过、不报错**，归「未分类」并标 `(frontmatter 解析失败)` —— 宁可见到脏数据，也不要静默漏掉一条坑。')
L.push('')

// ★ 八·S6：坑库的"认不出的不丢＋有告警" —— 对策一句话取不到的文件，生成时点名（索引行里也会带 ⚠️ 标）
const noFixList = entries.filter(e => !e.fix && !e.empty)
if (noFixList.length) console.error(`[索引] ⚠️ ${noFixList.length} 篇取不到「③ 对策」一句话（已照常入索引、没丢；建议补齐四段式）：${noFixList.slice(0, 6).map(e => e.file).join('、')}${noFixList.length > 6 ? ' …' : ''}`)

const text = scrub(L.join('\n'))

if (DRY) {
  process.stdout.write(text)
  console.error(`\n[索引] dry-run：识别到 ${entries.length} 个坑文件（空文件 ${counts.empty}），未写盘`)
} else {
  writeFileSync(INDEX, text, 'utf8')
  console.log(`[索引] 已写 ${INDEX}`)
  console.log(`[索引] 坑 ${counts.total} 条（今日 +${counts.today}、本周 +${counts.week}、待定 ${counts.pending}、卡死 ${counts.fatal}、空文件 ${counts.empty}）`)
  if (broken.length) {
    console.log(`[索引] ⚠️ 有 ${broken.length} 个文件 frontmatter 读不懂（已归「未分类」并标注，未略过）：`)
    for (const b of broken) console.log(`        ${b.file} —— ${b.why}`)
  }
}
