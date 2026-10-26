#!/usr/bin/env node
/**
 * 坑库 · 共享逻辑（打分 / 四段抽取 / 一句话对策 / 自动关键词 / 主题分类）
 *
 * ⚠️ **为什么单独抽一份**：`派活.mjs`（拼任务卡时挑坑）与 `查坑.mjs`（遇到问题按关键词查库）
 *    **必须用同一套打分** —— 否则"卡片说相关的"和"查坑查出来的"会不一致，
 *    而本项目已经踩过"同一个东西两套口径"的坑（对账、额度、看板都各踩过一次）。
 *    所以：**这里是唯一实现**，两边都 import 它。
 *
 * 打分规则（沿用原 `派活.mjs`，**不改**，免得行为漂）：
 *   命中**文件名** +3 · 命中 **tags** +2 · 命中**正文** +2+min(次数,3)；
 *   **强相关** = 命中文件名 / 命中 ≥2 个不同关键词 / 单关键词正文出现 ≥3 次；其余算弱相关。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
// ★ 2026-10-27（开源准备 W2）：坑库路径不再写死本机盘符。
//   顺序：显式参数（`--vault`）→ `DSH_PITFALL_VAULT` → `config\本机映射.json` 的「坑库」→ null。
//   都没有时**不是报错，而是按空库处理**（新人第一次就能用，见 D20 与 `查坑.mjs`）。
import { VAULT as VAULT_FROM_MAP } from './_路径.mjs'

export const DEFAULT_VAULT = process.env.DSH_PITFALL_VAULT ?? VAULT_FROM_MAP ?? null
export const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'node_modules'])

/** 递归找库里的 `.md`（跳过 `_` 开头与忽略目录）。 */
export function mdFiles (dir, out = []) {
  let entries = []
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entries) {
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) mdFiles(join(dir, e.name), out) } else if (e.isFile() && /\.md$/i.test(e.name) && !e.name.startsWith('_')) out.push(join(dir, e.name))
  }
  return out
}

/** 抽「① 现象 / ② 根因 / ③ 对策 / ④ 证据」四段（取不到就退回全文，但截断）。
 *  ⚠️ **坑库里有两种写法**（实测）：
 *    形式 A（标题式，老坑/大脑写的）：`## ① 现象` + 换行正文
 *    形式 B（加粗行内式，coder 写的）：`**① 现象**：正文…`
 *  两种都必须认 —— 否则形式 B 会"取不到"而退化成"整篇原文"（卡片里会混进 frontmatter 噪音）。 */
export function extractSections (text) {
  const grab = (mark) => {
    const a = text.match(new RegExp(`##\\s*${mark}[\\s\\S]*?(?=\\n##\\s*[①②③④]|$)`))
    if (a) return a[0].trim()
    const b = text.match(new RegExp(`\\*\\*\\s*${mark}[^*]*\\*\\*\\s*[：:]?[\\s\\S]*?(?=\\n\\*\\*\\s*[①②③④]|$)`))
    if (b) return b[0].trim()
    return ''
  }
  const out = ['①', '②', '③', '④'].map(grab).filter(Boolean)
  if (out.length) return out.join('\n\n')
  return text.split(/\r?\n/).slice(0, 40).join('\n').trim()
}

/** ★ 八·S6（照台账"未识别"范式）：认不认得出四段式（`## ①…` 标题式 / `**① …**` 行内式，两种都算）。
 *  认不出**也照样兜底返回**（不丢），但 `findPitfalls` 会把这类文件点进 `unparsed` —— 有告警。 */
export function hasSections (text) {
  return /##\s*[①②③④]/.test(text) || /\*\*\s*[①②③④]/.test(text)
}

/** `③ 对策` 的**第一句**（索引里最有价值的那一列：最接近"你遇到问题时的说法"）。
 *  同样**两种写法都认**（见 `extractSections` 的说明）。 */
export function oneLineFix (text, max = 72) {
  const cands = [
    text.match(/##\s*③[^\n]*\n+([\s\S]*?)(?=\n##\s*[①②③④]|\n\*\*[①②③④]|$)/),
    text.match(/\*\*\s*③[^*]*\*\*\s*[：:]\s*([^\n]+)/),
    text.match(/③[^\n]*[：:]\s*([^\n]+)/)
  ]
  for (const m of cands) {
    if (!m) continue
    const s = String(m[1]).split(/\r?\n/)[0]
      .replace(/^\s*[-*>|]\s*/, '').replace(/\*\*/g, '').replace(/`/g, '').trim()
    if (s.length >= 4 && !/^tags:/.test(s)) return s.length > max ? s.slice(0, max - 1) + '…' : s
  }
  return ''
}

/** frontmatter 里取一个字段（极简：只认顶层 `key: value`）。 */
export function fmValue (text, key) {
  const m = text.match(new RegExp('^' + key + ':\\s*(.+)$', 'm'))
  return m ? m[1].replace(/^["']|["']$/g, '').trim() : ''
}

/**
 * 主题分类（**确定性**、可从标题复核）：
 *   ① frontmatter 有 `topic:` → 直接用它；
 *   ② tags 里除 `踩坑/无人值守` 外的第一个标签；
 *   ③ 否则按**标题关键词字典**判（顺序即优先级）。
 * 为什么需要③：实测 75 条坑的 tags 全是 `[踩坑, 无人值守]` → 按标签分组只有**一个桶**，
 *   等于没有主题索引（索引里把 75 个链接塞进一格，人和 AI 都没法扫）。见坑《索引分组退化成一个大桶》。
 */
const TOPIC_RULES = [
  ['PowerShell', /PowerShell|pwsh|BOM|重定向|UTF-16|eprint|退出码|Select-Object/i],
  ['DSH·插件·preset', /preset|插件|loader|DSH|chip|profile|bundle|market|侧边栏|标签页/i],
  ['派活·任务卡', /任务卡|派活|坑关键词|内嵌|接活/i],
  ['编排·看护', /编排|并行|看护|超时|急救|rescue|verdict|maxConcurrency|调度|波次/i],
  ['看板·账目', /看板|board|cost-meter|账本|对账|快照|额度|索引生成|计数/i],
  ['载体·CLI', /opencode|Pi\b|CodeBuddy|Qoder|ripgrep|headless|CLI|ACP|Agent|ArkCLI|arkcli/i],
  ['数据库·迁移', /sqlite|drizzle|迁移|migrate|WAL|schema|vec0|node-gyp|TS7016/i],
  ['Docker·部署', /Docker|docker|compose|镜像|build|nginx/i],
  ['验证纪律', /假阴性|假通过|对照实验|验证|断言|竞态|证据|判据/i],
  ['沙箱·权限', /沙箱|权限|EPERM|ACL|0xC0000142|拒绝访问|sandbox/i],
  ['额度·成本', /额度|token plan|coding plan|AK\/SK|SSO|计费|价格|信用/i],
  ['Obsidian·知识库', /obsidian|库根|vault|笔记|知识库/i],
  ['前端·界面', /React|CSS|渲染|界面|UI|交互/i]
]
export function classifyTopic (title, tags = []) {
  const extra = (tags || []).filter(t => t && t !== '踩坑' && t !== '无人值守' && !/^无人/.test(t))
  if (extra.length) return extra[0]
  for (const [topic, re] of TOPIC_RULES) if (re.test(title)) return topic
  return '其它'
}
export const TOPIC_ORDER = [...TOPIC_RULES.map(r => r[0]), '其它']

/**
 * 按关键词找坑（**唯一实现**）。返回 `{ ok, hits, total, reason? }`。
 * `hits[]` 字段：file / rel / title / date / topic / fix / severity / score / which / strong / body 等。
 */
export function findPitfalls (keywords, vault = DEFAULT_VAULT) {
  const kws = (keywords ?? []).map(k => String(k).trim()).filter(Boolean)
  let all = []
  try { all = mdFiles(vault) } catch { return { ok: false, reason: `库根读不到：${vault}`, hits: [], total: 0 } }
  if (!all.length) return { ok: false, reason: `库根是空的：${vault}`, hits: [], total: 0 }
  const hits = []
  const unparsed = []      // ★ 八·S6：四段式/对策一句话取不出的（已兜底、没丢，但要点名）
  for (const f of all) {
    let text = ''
    try { text = readFileSync(f, 'utf8') } catch { continue }
    const name = basename(f)
    const tagsRaw = fmValue(text, 'tags')
    const tags = tagsRaw.replace(/[[\]]/g, '').split(',').map(s => s.trim()).filter(Boolean)
    const title = (text.match(/^#\s+(.+)$/m) ?? [])[1]?.trim() ?? name.replace(/\.md$/, '')
    let score = 0
    const which = []
    // ⚠️ 没给关键词：**不再**"全都算弱相关取前 N"（那会退化成按文件名随便挑，见坑《派活时坑关键词为空…》）。
    //    现在的行为 = 返回空结果，由调用方决定怎么办（查坑脚本会明确喊"没查到"并给下一步）。
    for (const k of kws) {
      const re = new RegExp(k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi')
      const inName = re.test(name) ? 1 : 0
      const inTags = re.test(tagsRaw) ? 1 : 0
      const n = (text.match(re) ?? []).length
      if (inName) { score += 3; which.push(k + '(文件名)') }
      if (inTags && !inName) { score += 2; which.push(k + '(标签)') }
      if (n > 0) { score += 2 + Math.min(n, 3); which.push(k + '×' + n) }
    }
    if (score > 0) {
      let bytes = 0
      try { bytes = statSync(f).size } catch {}
      const kwHit = [...new Set(which.map(w => w.split(/[×(（]/)[0].trim()))].filter(Boolean)
      const inNameHit = which.some(w => w.includes('(文件名)'))
      const bodyHits = which.filter(w => /×/.test(w)).reduce((s, w) => s + Number((w.match(/×(\d+)/) ?? [])[1] ?? 0), 0)
      const fix = oneLineFix(text)
      const body = extractSections(text)
      // ★ 八·S6：认不出的"不丢＋有告警" —— 兜底返回照旧，这里只登记原因给调用方点名
      const why = []
      if (!hasSections(text)) why.push('四段式认不出（已按全文兜底）')
      if (!fix) why.push('「③ 对策」一句话取不到')
      if (why.length) unparsed.push({ file: name, rel: f.slice(vault.length + 1).replace(/\\/g, '/'), why: why.join('；') })
      hits.push({
        file: name, rel: f.slice(vault.length + 1).replace(/\\/g, '/'), path: f,
        title, date: fmValue(text, 'date'), severity: fmValue(text, 'severity'), status: fmValue(text, 'status'),
        topic: classifyTopic(title, tags), fix,
        score, which, strong: inNameHit || kwHit.length >= 2 || bodyHits >= 3,
        kwHit, inNameHit, bodyHits, bytes,
        text: bytes <= 20000 ? text : text.slice(0, 20000),
        body
      })
    }
  }
  hits.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file))
  return { ok: true, hits, total: all.length, unparsed }
}

/** 没给关键词时**自动推导**（交付物路径 + 目标 + 验收 + 契约）。 */
export function autoKeywords ({ deliverables = [], goal = '', accept = [], contract = [] } = {}) {
  const STOP = new Set(['src', 'app', 'lib', 'dist', 'build', 'node_modules', 'test', 'tests', 'spec', 'specs',
    'index', 'main', 'server', 'client', 'common', 'utils', 'util', 'types', 'type', 'config', 'conf',
    'the', 'and', 'for', 'with', 'from', 'that', 'this', 'you', 'not', 'are', 'was', 'has', 'have',
    'ts', 'tsx', 'js', 'mjs', 'cjs', 'json', 'md', 'yml', 'yaml', 'txt', 'lock', 'env', 'example',
    'npm', 'npx', 'run', 'cmd', 'echo', 'http', 'https', 'true', 'false', 'null', 'undefined', 'string', 'number'])
  const bag = new Map()
  const push = (w) => {
    const k = String(w).toLowerCase().replace(/^[^a-z0-9\u4e00-\u9fa5]+|[^a-z0-9\u4e00-\u9fa5]+$/g, '')
    if (k.length < 3 || STOP.has(k)) return
    bag.set(k, (bag.get(k) ?? 0) + 1)
  }
  for (const d of deliverables) for (const seg of String(d).split(/[\\/]/)) push(seg.replace(/\.[a-z0-9]+$/i, ''))
  for (const s of [goal, ...accept, ...contract]) for (const m of (String(s).match(/[A-Za-z][A-Za-z0-9_.-]{2,}/g) ?? [])) push(m.replace(/[._-]+$/, ''))
  return [...bag.entries()].sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0])).map(([k]) => k).slice(0, 8)
}
