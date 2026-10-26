#!/usr/bin/env node
/**
 * 知识索引 —— 大模型知识库的索引生成器（零 token）。
 *
 * 生成三样东西（**只有这三样是脚本写的，其余全是人手写**）：
 *   `_索引.md`          一级索引：一行一个抽屉（抽屉 | 条目数 | 最新时点 | 一句话）
 *   `索引\<抽屉>.md`     二级索引：一行一条（标题（专业注释） · 关键词 · 时点 · 状态 · [[文件名]]）
 *   `_最近更新.md`       按文件 mtime 倒排 20 条（给人"回来看看"的理由）
 *
 * 外加一节**体检**（写进 `_索引.md` 末尾）：
 *   ① 缺机器块 ② 缺时点 ③ 过复核日 ④ 状态=有争议/已过期 ⑤ 标题不合规（H1 后没有括号注释行）
 *
 * 约定见 `<库>\_约定.md`。用法：
 *   node 知识索引.mjs            # 生成
 *   node 知识索引.mjs --check    # 只体检不写盘（有问题 exit 2）
 *   node 知识索引.mjs --json
 * · 库根可用 DSH_KB 覆盖，默认 <知识库>\大模型知识库
 * 铁律：**库不存在 ⇒ 静默退出 0**（不建库不影响任何现有流程）。
 */
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { KB as KB_ROOT } from './_路径.mjs'

const KB = process.env.DSH_KB ?? (KB_ROOT ? join(KB_ROOT, '大模型知识库') : null)
const DRAWERS = ['主题', '知识', '事实卡', '来源']
const CHECK_ONLY = process.argv.includes('--check')
const AS_JSON = process.argv.includes('--json')

if (!existsSync(KB)) {
  if (AS_JSON) console.log(JSON.stringify({ ok: true, skipped: 'no-kb', kb: KB }))
  else console.log('（没有知识库，跳过） ' + KB)
  process.exit(0)
}

const today = new Date()
const daysBetween = (a, b) => Math.round((b - a) / 86400000)

function parseNote (file) {
  const raw = readFileSync(file, 'utf8')
  const lines = raw.split(/\r?\n/)
  let h1 = '', gloss = ''
  for (let i = 0; i < lines.length; i++) {
    if (!h1 && /^#\s+\S/.test(lines[i])) {
      h1 = lines[i].replace(/^#\s+/, '').trim()
      const nx = (lines[i + 1] ?? '').trim()
      if (/^[（(].*[)）]$/.test(nx)) gloss = nx
      break
    }
  }
  const block = raw.match(/<!--\s*🤖([\s\S]*?)-->/)
  const fields = {}
  if (block) {
    const body = block[1]
    for (const key of ['关键词', '结论', '适用', '时点', '落库', '复核', '置信', '状态', '证据']) {
      const m = body.match(new RegExp(key + '\\s*[=：]\\s*([^|\\n]+)'))
      if (m) fields[key] = m[1].trim()
    }
    // 「适用=… | 时点=… | 复核=…」这种一行多字段：上面的正则吃不到行尾以外的，逐段再扫一遍
    for (const seg of body.split('|')) {
      const m = seg.match(/^\s*([^=：\n]+?)\s*[=：]\s*([\s\S]+?)\s*$/)
      if (m && !fields[m[1].trim()] && ['适用', '时点', '落库', '复核', '置信', '状态'].includes(m[1].trim())) {
        fields[m[1].trim()] = m[2].replace(/-->/, '').trim()
      }
    }
  }
  const st = statSync(file)
  return { file, h1, gloss, fields, mtime: st.mtime, size: st.size, hasBlock: !!block }
}

const notes = []
for (const d of DRAWERS) {
  const dir = join(KB, d)
  if (!existsSync(dir)) continue
  for (const n of readdirSync(dir)) {
    if (!n.endsWith('.md')) continue
    // ★ 2026-10-19 b188 补：**不许再跳过 `_` 开头的文件** —— 那等于给体检留盲区（夹具/临时件会静默隐身）。
    //   下划线件照收进索引，但额外报一条灰：提醒它要么删、要么改名。
    try { notes.push({ drawer: d, name: n, ...parseNote(join(dir, n)) }) } catch (e) { notes.push({ drawer: d, name: n, error: String(e) }) }
  }
}

const problems = []
for (const n of notes) {
  if (n.error) { problems.push({ level: '红', kind: '读不了', name: n.name, why: n.error }); continue }
  if (!n.hasBlock) problems.push({ level: '红', kind: '缺机器块', name: n.name, why: '文末没有 <!-- 🤖 … -->，AI 检索不到' })
  if (n.name.startsWith('_')) problems.push({ level: '灰', kind: '下划线文件', name: n.name, why: '抽屉里不该有 `_` 开头的文件（临时/夹具）—— 确认后删掉或改名' })
  if (!n.fields['时点']) problems.push({ level: '红', kind: '缺时点', name: n.name, why: '铁律二：必须带时点' })
  if (!n.gloss) problems.push({ level: '黄', kind: '标题不合规', name: n.name, why: 'H1 下一行应为括号专业注释' })
  const due = n.fields['复核']
  if (due && /^\d{4}-\d{2}-\d{2}$/.test(due)) {
    const d = new Date(due + 'T00:00:00+08:00')
    if (d < today) problems.push({ level: '黄', kind: '过复核日', name: n.name, why: '复核日 ' + due + '（已过 ' + daysBetween(d, today) + ' 天）⇒ 按 _约定 §四：**没新结论就顺延**（改 复核= ＋ 正文加一行"已复核，结论未变"）；**有新结论就写新卡并删旧卡**' })
    else if (daysBetween(today, d) <= 14) problems.push({ level: '灰', kind: '快到复核日', name: n.name, why: '复核日 ' + due })
  } else problems.push({ level: '黄', kind: '缺复核日', name: n.name, why: '复核=' + (due ?? '（空）') + '，应为 YYYY-MM-DD ＝ 落库日 + 3 个月' })
  const stt = n.fields['状态']
  if (stt && !['有效', '有争议'].includes(stt)) problems.push({ level: '黄', kind: '状态取值越界', name: n.name, why: '状态=' + stt + '（只允许 有效／有争议 —— 过期不留档，见 _约定 §四）' })
  else if (stt === '有争议') problems.push({ level: '灰', kind: '有争议', name: n.name, why: n.fields['结论'] ?? '' })
}
notes.sort((a, b) => b.mtime - a.mtime)
const newest = (arr) => arr.length ? arr.map(x => x.fields['时点'] ?? '').filter(Boolean).sort().pop() ?? '—' : '—'
const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(0, 16)

const HEAD = '> ⚠️ **本文件由脚本零 token 生成，请勿手改**（手改会在下次生成时被覆盖）。\\n> 生成：`node ' + join(HERE, '知识索引.mjs') + '` ｜ 约定见 `_约定.md`\\n\\n'

// 一级索引
let idx = '# 大模型知识库 · 索引\n\n' + HEAD
idx += '**生成时间**：' + now + '（+8）\n**条目总数**：' + notes.length + '\n\n'
idx += '## 怎么用（三跳）\n\n1. 先看 `_开始这里.md`（人）或本页抽屉表（AI）\n2. 进 `索引\\<抽屉>.md` 扫一行一条\n3. 还不中 ⇒ 全库 grep 关键词\n\n'
idx += '## 抽屉\n\n| 抽屉 | 条目 | 最新时点 | 这个抽屉装什么 |\n|---|---|---|---|\n'
const DRAWER_DESC = { 主题: '人读的主线，一篇 5 分钟', 知识: '一条一个结论的卡片', 事实卡: '硬参数快照（会过期最快）', 来源: '论文/文档一行摘要' }
for (const d of DRAWERS) {
  const arr = notes.filter(n => n.drawer === d)
  idx += `| **${d}** | ${arr.length} | ${newest(arr)} | ${DRAWER_DESC[d] ?? ''} |\n`
}

// 二级索引
mkdirSync(join(KB, '索引'), { recursive: true })
for (const d of DRAWERS) {
  const arr = notes.filter(n => n.drawer === d)
  let s = `# ${d} · 一行一条\n\n` + HEAD
  if (!arr.length) s += '（空）\n'
  for (const n of arr) {
    const kw = (n.fields['关键词'] ?? '').split(',').slice(0, 6).join(',')
    s += `- **${n.h1 || n.name}**${n.gloss ? '　' + n.gloss : ''}\n`
    s += `  ` + [kw && '关键词：' + kw, n.fields['时点'] && '时点：' + n.fields['时点'], n.fields['置信'] && '置信：' + n.fields['置信'], n.fields['状态'] && '状态：' + n.fields['状态']].filter(Boolean).join(' ｜ ') + ` ｜ [[${n.name.replace(/\.md$/, '')}]]\n`
  }
  writeFileSync(join(KB, '索引', d + '.md'), s, 'utf8')
}

// 最近更新
let recent = '# 最近更新（最近 20 条）\n\n' + HEAD
for (const n of notes.slice(0, 20)) {
  recent += `- \`${n.mtime.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }).slice(5, 16)}\` **${n.h1 || n.name}**${n.gloss ? '　' + n.gloss : ''}\n`
  if (n.fields['结论']) recent += `  > ${n.fields['结论']}\n`
}
writeFileSync(join(KB, '_最近更新.md'), recent, 'utf8')

// 体检写回一级索引
idx += '\n## 体检（' + problems.length + ' 项）\n\n'
if (!problems.length) idx += '✅ 全绿：没有缺时点、没有过复核日、没有缺机器块。\n'
else {
  idx += '| 级别 | 问题 | 条目 | 说明 |\n|---|---|---|---|\n'
  for (const p of problems) idx += `| ${p.level} | ${p.kind} | ${p.name} | ${p.why} |\n`
}
writeFileSync(join(KB, '_索引.md'), idx, 'utf8')

if (AS_JSON) console.log(JSON.stringify({ ok: problems.filter(p => p.level === '红').length === 0, notes: notes.length, problems }, null, 1))
else {
  console.log('知识库=' + KB)
  console.log('条目=' + notes.length + '（' + DRAWERS.map(d => d + ' ' + notes.filter(n => n.drawer === d).length).join(' / ') + '）')
  console.log('体检=' + problems.length + ' 项：' + (problems.map(p => p.level + '·' + p.kind).join('；') || '全绿'))
  if (CHECK_ONLY) console.log('（--check：未写盘）')
}
process.exit(problems.some(p => p.level === '红') && CHECK_ONLY ? 2 : 0)
