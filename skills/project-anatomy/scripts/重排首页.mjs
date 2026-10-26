#!/usr/bin/env node
/**
 * 重排首页.mjs —— 《项目剖析文档》首页生成器（通用，所有项目共用）
 *
 * 干什么：扫库里每个「项目剖析」夹，按**真实文件列表**重写它的 `00-总目录.md`。
 *   · 页数、分组、每组的双链，全部从文件名现算 ⇒ 首页永远跟得上，不用手维护
 *   · 只保留/读取旧首页 frontmatter 里的 `项目根`，其余整页重写
 *   · 分组按页名前缀：规则· / 配置· / 脚本· / 界面· / 文档· / 数据·
 *
 * 用法：node 重排首页.mjs [--vault "{{知识库}}"] [--dry]
 * 退出码：0 正常；2 环境错
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }

const VAULT = resolve(opt('vault') ?? process.env.DSH_KNOWLEDGE_VAULT ?? '{{知识库_JS}}')
const DRY = has('dry')
const BOOK_DIR = '项目剖析'
const SKIP = new Set(['.trash', '.obsidian', 'node_modules', '.git', '.剖析备份'])
const GROUPS = [
  ['规则', '规则·'],
  ['配置', '配置·'],
  ['脚本', '脚本·'],
  ['界面', '界面·'],
  ['文档', '文档·'],
  ['数据', '数据·']
]
const SPECIAL = ['整体怎么转', '疑点总表']   // 单独列在"先读"

function findBookDirs (root) {
  const out = []
  const walk = (dir) => {
    let items = []
    try { items = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      if (!it.isDirectory()) continue
      if (SKIP.has(it.name) || it.name.startsWith('.')) continue
      const full = join(dir, it.name)
      if (it.name === BOOK_DIR) { out.push(full); continue }
      walk(full)
    }
  }
  walk(root)
  return out
}

function projectRootOf (indexPath) {
  if (!existsSync(indexPath)) return null
  const text = readFileSync(indexPath, 'utf8').replace(/^\uFEFF/, '')
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!m) return null
  const k = m[1].match(/^项目根[ \t]*:[ \t]*(.*)$/m)
  return k ? k[1].trim().replace(/^["']|["']$/g, '') : null
}

let books = 0
for (const book of findBookDirs(VAULT)) {
  const names = readdirSync(book).filter((n) => n.toLowerCase().endsWith('.md')).map((n) => n.replace(/\.md$/, ''))
  const special = SPECIAL.filter((s) => names.includes(s))
  const grouped = GROUPS.map(([label, prefix]) => [label, names.filter((n) => n.startsWith(prefix)).sort()])
  const indexed = grouped.reduce((a, [, arr]) => a + arr.length, 0)
  const total = names.length

  const oldIndex = join(book, '00-总目录.md')
  const root = projectRootOf(oldIndex) ?? '<项目目录>'
  let tags = '[项目剖析]'
  if (existsSync(oldIndex)) {
    const t = readFileSync(oldIndex, 'utf8').replace(/^\uFEFF/, '').match(/^tags[ \t]*:[ \t]*(.*)$/m)
    if (t) tags = t[1].trim()
  }
  const L = []
  L.push('---')
  L.push(`tags: ${tags}`)
  L.push(`项目根: ${root}`)
  L.push('---')
  L.push('')
  L.push('# 项目剖析')
  L.push('')
  L.push(`**现在共 ${total} 页**：先读 ${special.length} 页 + 一物一页 ${indexed} 页。`)
  L.push('')
  L.push('## 先读')
  L.push(`- [[整体怎么转]] —— 整个项目怎么转：流程、组成、钱和上下文从哪漏、现在卡在哪`)
  L.push(`- [[疑点总表]] —— 现状可证的疑点汇总（分六类，末尾有"最该先动的"清单）`)
  L.push('- 本页 —— 全量导航')
  L.push('')
  L.push('## 怎么读')
  L.push('每页固定六问：**这是什么 / 干什么用 / 谁在用它 / 花了什么 / 为什么这么做 / 疑点**。')
  L.push('数字都标出处：①实机（文件:行 / 实测）②坑库或历史备份 ③仅文档说法（未实测）。')
  L.push('')
  L.push('## 页头的 `规模` / `指纹` / `抓取` 与页内原文')
  L.push('这三样由通用工具灌，**AI 一个字都不许手抄**：')
  L.push('- `_工具\\剖析.cmd` —— 灌原文 + 回填三个字段')
  L.push('- `_工具\\剖析-体检.cmd` —— 只体检不改（列出「未灌 / 过期 / 孤儿 / 缺标记」）')
  L.push('换项目只改首页第一行的 `项目根`。')
  L.push('')
  L.push(`## 全量索引（${indexed} 页）`)
  for (const [label, arr] of grouped) {
    L.push('')
    L.push(`### ${label}（${arr.length} 页）`)
    for (const n of arr) {
      const m = n.match(/（(.+)）$/)
      L.push(`- [[${n}]]${m ? ' —— ' + m[1] : ''}`)
    }
  }
  L.push('')
  L.push(`> 本页由 skill \`project-anatomy\` 的 \`scripts\\重排首页.mjs\`（或双击 \`_工具\\重排首页.cmd\`）按真实文件列表生成；别手改索引那一节。`)
  L.push('')

  const out = join(book, '00-总目录.md')
  if (DRY) { console.log(`将写：${out}（${total} 页）`); continue }
  writeFileSync(out, L.join('\n'), 'utf8')
  console.log(`✅ ${out}：共 ${total} 页（先读 ${special.length} + 索引 ${indexed}）`)
  books++
}
if (!books && !DRY) { console.error('没找到任何「项目剖析」夹'); process.exit(2) }
