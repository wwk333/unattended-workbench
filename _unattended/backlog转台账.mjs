#!/usr/bin/env node
/**
 * backlog → 台账（`TASKS.md`）**单向转换器** —— 用户 2026-10-05 拍板 A′。
 *
 * 为什么有它（分工）：
 *   · `backlog/`（npm 的 backlog 工具维护）= **给人看的任务板**（里程碑 / 归档 / 决策 / 文档，好看、能追）;
 *   · `TASKS.md` = **给机器看的**（一行一条；台账/编排/看板/体检 四个脚本**只认它**）;
 *   · 这个脚本负责把 backlog 里**新增**的任务补进 `TASKS.md` → **不用两处手抄**。
 *
 * ★ 三条安全口径（别改）：
 *   ① **单向、只读 backlog**：绝不回写 backlog；
 *   ② **已有行一个字都不动**（`TASKS.md` 的**状态以机器为准** —— 编排随时在改状态；覆盖它 = 抹掉进度）；
 *      `--fill` 才补**空字段**，且**绝不改状态字符**；
 *   ③ **不删行**：`TASKS.md` 里有、backlog 里没有的（孤立行）**原样保留**并报告。
 *
 * 用法：
 *   node backlog转台账.mjs --project "<项目目录>" [--dry-run] [--fill]
 *   （`--dry-run` = 只说要改什么、不落盘；默认写，但**写前自动备份** `TASKS.md`）
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const has = (n) => argv.includes('--' + n)
const P = opt('project')
const DRY = has('dry-run')
const FILL = has('fill')
if (!P) { console.error('用法：backlog转台账.mjs --project "<项目目录>" [--dry-run] [--fill]'); process.exit(2) }
if (!existsSync(P)) { console.error('项目目录不存在：' + P); process.exit(2) }

const TASKS = join(P, 'TASKS.md')
const BACKLOG = join(P, 'backlog')
/** ★ 状态字符**照抄** `台账.mjs` 的 `STATUS_MARK`（单一实现，别各写一套）。 */
const MARK = { pending: ' ', ready: 'r', doing: '>', review: '?', done: 'x', blocked: '!', dropped: '-' }
const LINE_RE = /^- \[(.)\]\s+(\S+)\s+·\s*([^·]*)\s*·\s*([^·]*)\s*·\s*([^·]*)\s*·\s*依赖:([^·]*)\s*·\s*交付:([^·]*)\s*·\s*验收:(.*)$/

/** 极简 YAML 头解析（只处理这种结构：`k: v` / `k:` + `- item` 缩进列表 / `k: []`）。 */
function head (text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)
  if (!m) return {}
  const out = {}; let cur = null
  for (const raw of m[1].split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '')
    if (!line.trim() || line.trim().startsWith('#')) continue
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line)
    if (kv && !line.startsWith(' ')) {
      const k = kv[1], v = kv[2].trim()
      if (v === '' ) { out[k] = []; cur = k }
      else if (v === '[]') { out[k] = []; cur = null }
      else { out[k] = v.replace(/^["']|["']$/g, ''); cur = null }
      continue
    }
    const li = /^\s*-\s*(.*)$/.exec(line)
    if (li && cur) out[cur].push(li[1].trim().replace(/^["']|["']$/g, ''))
  }
  return out
}

/** backlog 的 status → 台账的状态名（对不上就 pending + 警告）。 */
function statusOf (s) {
  const t = String(s ?? '').trim().toLowerCase()
  if (!t || /^(to ?do|new|backlog|open|pending)$/.test(t)) return 'pending'
  if (/^(ready)$/.test(t)) return 'ready'
  if (/^(in ?progress|doing|active|started)$/.test(t)) return 'doing'
  if (/^(review|in ?review|testing)$/.test(t)) return 'review'
  if (/^(done|complete[d]?|closed|finished)$/.test(t)) return 'done'
  if (/^(blocked|on ?hold|stuck)$/.test(t)) return 'blocked'
  if (/^(dropped|cancell?ed|wontfix)$/.test(t)) return 'dropped'
  return 'pending'
}

/** `TASK-8` / `T8` → `T8`（台账里依赖与 ID 都用短号）。 */
const shortId = (s) => {
  const m = /(\d+)\s*$/.exec(String(s ?? ''))
  return m ? 'T' + m[1] : String(s ?? '').trim()
}

/** 里程碑 `m-1` → 波次 `W2`（优先用里程碑标题里的 `w<N>`，与现有台账一致）。 */
function waveOf (milestone) {
  if (!milestone) return '—'
  const dir = join(BACKLOG, 'milestones')
  if (existsSync(dir)) {
    const f = readdirSync(dir).find(n => n.toLowerCase().startsWith(String(milestone).toLowerCase() + ' -') || n.toLowerCase().startsWith(String(milestone).toLowerCase() + '-'))
    if (f) { const w = /w\s*(\d+)/i.exec(f); if (w) return 'W' + w[1] }
  }
  const n = /(\d+)\s*$/.exec(String(milestone))
  return n ? 'W' + (Number(n[1]) + 1) : String(milestone)
}

/** ★ 字段清洗（**必须有**）：台账格式**用 `·` 当分隔符** —— 任何字段里出现 `·` 都会把格式撑破、
 *  机器就整条读不出来（实测：backlog 标题爱写 `刀1·工程初始化` → 生成后 `台账.mjs list` 报"没有任务"）。
 *  顺手清掉 HTML 注释、勾选框标记、`#1` 序号，压平空白。 */
function clean (s, max = 300) {
  return String(s ?? '')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/[·•]/g, '-')
    .replace(/^\s*[-*]\s*/gm, ' ')
    .replace(/\[[ xX>?r!-]\]/g, ' ')
    .replace(/#\d+\s*/g, '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
}

// ── ① 读 backlog 任务（tasks/ 与 completed/；archive 是历史归档，默认不看）
const files = []
for (const sub of ['tasks', 'completed']) {
  const d = join(BACKLOG, sub)
  if (!existsSync(d)) continue
  for (const n of readdirSync(d)) if (n.toLowerCase().endsWith('.md')) files.push(join(d, n))
}
if (!files.length) { console.log('backlog 里没有任务文件（' + BACKLOG + '\\tasks）→ 什么都不做'); process.exit(0) }

const fromBacklog = []
for (const f of files) {
  const text = readFileSync(f, 'utf8')
  const h = head(text)
  const title = String(h.title ?? '').trim()
  const id = shortId(title.match(/^T\d+/)?.[0] ?? h.id ?? f)
  // ★ 八·S6 连带修：assignee 是**字符串**时，原写法 `(h.assignee[0] ?? h.assignee)` 取到的是
  //   **首字母**（实测把 coder-a 写成 `c`）—— 先归一成 roleRaw，再统一剥 `@`。
  const roleRaw = Array.isArray(h.assignee) ? h.assignee[0] : h.assignee
  const role = roleRaw ? String(roleRaw).replace(/^@/, '') : ''
  // 验收/交付：先看正文有没有这两段（backlog 的头部里没有这两个字段）
  const accBody = /(?:^|\n)#{2,3}\s*(?:验收标准|Acceptance[^\n]*)\s*\n+([\s\S]*?)(?=\n#{2,3}\s|\s*$)/i.exec(text)?.[1]
  const delBody = /(?:^|\n)#{2,3}\s*(?:交付物|Deliverables?[^\n]*)\s*\n+([\s\S]*?)(?=\n#{2,3}\s|\s*$)/i.exec(text)?.[1]
  fromBacklog.push({
    id, file: f, backlogId: clean(h.id, 40),
    status: statusOf(h.status), role: clean(role, 24), wave: clean(waveOf(h.milestone), 12),
    goal: clean((title.replace(/^T\d+\s*/, '') || title), 160) + (h.id ? '=backlog ' + clean(h.id, 40) : ''),
    deps: (Array.isArray(h.dependencies) ? h.dependencies : []).map(shortId).filter(Boolean),
    ord: Number(h.ordinal ?? 0),
    delBody: clean(delBody), accBody: clean(accBody)
  })
}

// ── ② 读现有 TASKS.md
if (!existsSync(TASKS)) { console.error('没有 TASKS.md：' + TASKS + '（先跑 台账.mjs init 建一份）'); process.exit(2) }
const lines = readFileSync(TASKS, 'utf8').split(/\r?\n/)
const existing = new Map()      // 短 ID → { i, fields }
// ★ 八·S6（照台账"未识别"范式）：**长得像任务行、但认不出**的行单独挑出来 ——
//   不丢（本脚本从不删行）、不静默（下面会点名报警）、更**不许被当成"不存在"重复追加**（见合并段的 hold 判断）。
const unknown = []
lines.forEach((l, i) => {
  const t = l.trim()
  if (!/^-\s*\[.\]/.test(t)) return
  const m = LINE_RE.exec(t)
  if (m) { existing.set(m[2].trim(), { i, mark: m[1], wave: m[3].trim(), role: m[4].trim(), goal: m[5].trim(), deps: m[6].trim(), del: m[7].trim(), acc: m[8].trim() }); return }
  unknown.push({ i, id: (t.match(/^-\s*\[.\]\s*(\S+)/) ?? [])[1] ?? '(读不出ID)', line: t.slice(0, 110) })
})
const unknownIds = new Set(unknown.map(u => u.id))

// ── ③ 合并：新增的追加；已有的默认不动（--fill 只补空字段，绝不改状态）
const added = [], filled = [], skipped = [], held = [], warnRole = [], warnAcc = []
const mkLine = (mark, t, role, dep, del, acc) =>
  `- [${mark}] ${t.id} · ${t.wave} · ${role} · ${t.goal} · 依赖:${dep} · 交付:${del} · 验收:${acc}`
for (const t of fromBacklog.sort((a, b) => a.ord - b.ord)) {
  const cur = existing.get(t.id)
  const mark = MARK[t.status]
  const role = t.role || '?'
  if (!t.role) warnRole.push(t.id)
  const dep = t.deps.length ? t.deps.join(',') : '无'
  if (!cur) {
    // ★ 八·S6：台账里"疑似已有但认不出"的 ID —— 先不重复加（格式修回来再重跑），并记进 held 报警
    if (unknownIds.has(t.id)) { held.push(t.id); continue }
    const del = t.delBody || '无'
    const acc = t.accBody || '无'
    if (acc === '无') warnAcc.push(t.id)
    added.push({ id: t.id, line: mkLine(mark, t, role, dep, del, acc) })
  } else {
    if (!FILL) { skipped.push(t.id); continue }
    const del = cur.del === '无' || !cur.del ? (t.delBody || cur.del || '无') : cur.del
    const acc = cur.acc === '无' || !cur.acc ? (t.accBody || cur.acc || '无') : cur.acc
    if (del !== cur.del || acc !== cur.acc) {
      // ⚠️ 补字段时**沿用原有那一行的其余字段**（尤其状态字符 `cur.mark`），只换交付/验收
      filled.push({ id: t.id, line: mkLine(cur.mark, { id: t.id, wave: cur.wave, goal: cur.goal }, cur.role, cur.deps, del, acc) })
    } else skipped.push(t.id)
  }
}
const orphan = [...existing.keys()].filter(id => !fromBacklog.some(t => t.id === id))

// ── ④ 落盘（写前备份）
console.log(`【backlog → 台账】项目：${P}`)
console.log(`  backlog 任务 ${fromBacklog.length} 条 · 台账现有 ${existing.size} 条`)
console.log(`  → 新增 ${added.length} 条${added.length ? '：' + added.map(x => x.id).join(', ') : ''}`)
if (FILL) console.log(`  → 补字段 ${filled.length} 条${filled.length ? '：' + filled.map(x => x.id).join(', ') : ''}`)
console.log(`  → 已有跳过 ${skipped.length} 条（**状态以机器为准，一个字都不动**${FILL ? '，只补了空字段' : ''}）`)
console.log(`  → 台账里孤立 ${orphan.length} 条（backlog 里没有对应任务）**原样保留**：${orphan.slice(0, 8).join(', ')}${orphan.length > 8 ? ' …' : ''}`)
if (unknown.length) {
  console.log(`  ⚠️ 台账里有 ${unknown.length} 行**认不出**（已原样保留、没删；**不会**被当新任务重复加）：`)
  for (const u of unknown.slice(0, 5)) console.log(`      ${u.id} ｜ ${u.line}`)
  if (unknown.length > 5) console.log(`      …还有 ${unknown.length - 5} 行（见 TASKS.md 的"未识别"区提示）`)
  console.log(`      → 按标准形状修回（\`- [ ] T9 · W1 · coder-a · 目标 · 依赖:无 · 交付:a.ts · 验收:跑通\`）就能被认回`)
}
if (held.length) console.log(`  ⚠️ 其中 ${held.length} 条 backlog 任务疑似已存在（ID 命中"认不出"行）→ **本次跳过、不追加**：${held.join(', ')} —— 先修那行格式再重跑`)
if (warnRole.length) console.log(`  ⚠️ ${warnRole.length} 条没写负责人（assignee 空）→ 先填 '?'：${warnRole.slice(0, 6).join(', ')} —— 派活前必须补上`)
if (warnAcc.length) console.log(`  ⚠️ ${warnAcc.length} 条**没有验收标准**（backlog 里没写、台账里也没有）→ 写成 '无'：${warnAcc.slice(0, 6).join(', ')} —— ⛔ 按 SOP"任务没有 AC 不许派活"，派它之前先补`)
if (!added.length && !filled.length) { console.log('  ✅ 没有要改的（台账已与 backlog 对齐）'); process.exit(0) }
if (DRY) { console.log('  （--dry-run：只报告，不落盘）'); process.exit(0) }

const backup = TASKS + '.bak-backlog-' + Date.now()
try { copyFileSync(TASKS, backup); console.log('  备份：' + backup) } catch (e) { console.error('备份失败，已中止：' + e.message); process.exit(1) }
let out = lines.slice()
for (const f of filled) out[existing.get(f.id).i] = f.line
if (added.length) {
  // ★ 八·S6 连带修：原来"追到文件最尾"—— 现在文件尾部是**机器区段的地盘**（S5），
  //   而且追在 `## 波次汇总` 之后会让同一行同时落进"正文"和"尾部"（重复）。改为**插到
  //   `## 波次汇总` 之前**（没有这个标题才退回文件尾）。
  while (out.length && out[out.length - 1].trim() === '') out.pop()
  const idx = out.findIndex(l => /^##\s*波次汇总/.test(l.trim()))
  const at = idx >= 0 ? idx : out.length
  out.splice(at, 0, ...added.map(x => x.line), '')
}
out = out.map(l => /^>\s*最后更新：/.test(l.trim()) ? '> 最后更新：' + new Date().toISOString().replace('T', ' ').slice(0, 19) : l)
mkdirSync(dirname(TASKS), { recursive: true })
writeFileSync(TASKS, out.join('\n'), 'utf8')
console.log(`  ✅ 已写 ${TASKS}（新增 ${added.length} / 补 ${filled.length}）`)

// ★ 八·S5/S6：本脚本写的是"正文"，**机器区段随后刷新** —— 读方只认机器区段，不刷新它就成过期数据。
try {
  const r = spawnSync(process.execPath, [join(HERE, '台账.mjs'), 'machine', '--fix', '--project', P], { encoding: 'utf8', maxBuffer: 16 << 20, windowsHide: true })
  if (r.status !== 0) console.error(`  ⚠️ 机器区段刷新失败（exit=${r.status}）：${String(r.stderr ?? '').trim().split('\n')[0] ?? '?'} —— 下次读它会自动重建`)
  else console.log('  机器区段已刷新（台账.mjs machine --fix）')
} catch (e) { console.error(`  ⚠️ 机器区段刷新起不来：${String(e?.message ?? e).slice(0, 120)} —— 下次读它会自动重建`) }