#!/usr/bin/env node
/**
 * 载体体检（carrier check）—— **M6-8 的第一步**：把"载体每次上手被灌了什么"量成一串数，
 * 并回答"这些 skill 最近 30 天**真被调用过几次**"。
 *
 * 为什么有它（施工文档 §四 M6-8 · 执行顺序 b160／b189 拍板）：**先只体检、不卸** ——
 * 因为"卸不卸"的判断依据**正是这一步产出的三个数**：
 *   ① **占比**：skills 占载体系统提示多少（实测 coder-a 的 Pi 里是 21,500 / 26,599 字节 ≈ 80.8%）
 *   ② **30 天真实调用**：那 26 条 `arkcli-*` / 4 条 `pi-lens-*` 到底被调用过几次
 *   ③ **样本量**：以上结论建立在多少份信封、多少次工具调用、什么时间窗上
 *
 * ★ 一条铁律（b189 试出来的坑，别再踩）：判"用过没有"**绝不能全文 grep** ——
 *   注入进提示的那份技能清单**本身就是一份命令清单**（一份 6 行的 Pi 会话里 `arkcli` 出现 17 次、
 *   全在注入块；30 天窗口朴素 grep 命中 32/32 份会话）。
 *   ⇒ 本脚本只看 **工具调用节点**（各家信封里的 `toolCall` / `tool_use` 节点）**的入参**，并与 `tool_result` 交叉确认。
 *
 * 用法：
 *   node 载体体检.mjs                      # 默认：抓包件 _probe\pi\out.json ＋ 已知根里最近 30 天的信封
 *   node 载体体检.mjs --capture <out.json> # 换一份载体抓包（UTF-16LE / UTF-8 都认）
 *   node 载体体检.mjs --days 7             # 收窄时间窗
 *   node 载体体检.mjs --no-usage           # 只量注入层，不扫信封（秒出）
 *   node 载体体检.mjs --json
 *
 * ⚠️ 它**只报数、不下判决、不删任何东西**（卸载动作要用户点头，见 M6-8"处置"）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { PROJECTS_ROOT, WORKSPACE } from './_路径.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const AS_JSON = argv.includes('--json')
const DAYS = Number(opt('days', 30)) || 30
const SCAN = !argv.includes('--no-usage')
const CAPTURE = opt('capture', join(ROOT, '_probe', 'pi', 'out.json'))
const ROOTS = (opt('roots') ?? [PROJECTS_ROOT, WORKSPACE].filter(Boolean).join(',')).split(',')

// ---------------------------------------------------------------- 编码容错读文本
function readTextAuto (p) {
  const buf = readFileSync(p)
  if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) return buf.toString('utf16le').replace(/^\uFEFF/, '')
  if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) { const b = Buffer.from(buf); b.swap16(); return b.toString('utf16le') }
  const head = buf.slice(0, 400)
  if (head.includes(0)) return buf.toString('utf16le').replace(/^\uFEFF/, '')
  return buf.toString('utf8').replace(/^\uFEFF/, '')
}

// ---------------------------------------------------------------- 真分词器（可选，与 注入体检.mjs 同一套判据）
function tokenizerFile () {
  return [process.env.DSH_TOKENIZER_JSON, join(ROOT, '_crew', 'vendor', 'deepseek-tokenizer.json'), join(HERE, 'vendor', 'deepseek-tokenizer.json')].filter(Boolean).find(p => existsSync(p)) ?? null
}
function countTokens (items) {
  const file = tokenizerFile()
  if (!file || !items.length) return { mode: 'none', reason: file ? '没有要数的文本' : '没找到 tokenizer.json', counts: {} }
  const py = process.env.DSH_PYTHON ?? 'python'
  const src = [
    'import sys,json',
    'from tokenizers import Tokenizer',
    'tk=Tokenizer.from_file(sys.argv[1])',
    'items=json.loads(sys.stdin.buffer.read().decode("utf-8"))',
    'print(json.dumps({k: len(tk.encode(v, add_special_tokens=False).ids) for k,v in items.items()}))',
  ].join('\n')
  const r = spawnSync(py, ['-X', 'utf8', '-c', src, file], { input: JSON.stringify(Object.fromEntries(items)), encoding: 'utf8', maxBuffer: 64 << 20 })
  if (r.status === 0 && String(r.stdout).trim().startsWith('{')) return { mode: 'real', via: `${py} + tokenizers + ${basename(file)}`, counts: JSON.parse(r.stdout) }
  return { mode: 'none', reason: String(r.stderr ?? '').split('\n').map(s => s.trim()).filter(Boolean).pop() ?? `exit ${r.status}`, counts: {} }
}

// ---------------------------------------------------------------- ① 注入层：抓包件的系统提示分节
const out = { at: new Date().toISOString(), capture: null, injection: null, usage: null }

if (existsSync(CAPTURE)) {
  const st = statSync(CAPTURE)
  const text = readTextAuto(CAPTURE)
  // ★ 抓包件的**内容时间**比 mtime 可信：mtime 会被"搬家/复制/瘦身"整批改写（实测这份 mtime 是 10-17、
  //   内容却是 10-02 的会话）。所以两样都报，判决时以内容时间为准。
  let contentAt = null, contentCwd = null
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue
    try { const o = JSON.parse(line); if (o.type === 'session') { contentAt = o.timestamp ?? null; contentCwd = o.cwd ?? null; break } } catch { }
  }
  let sections = null, sysChars = 0, picks = 0
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('"sections"') || !line.includes('"system"')) continue
    try {
      const o = JSON.parse(line)
      const msg = o.message ?? o.messages?.[0]
      if (msg?.role === 'system' && msg.sections) { sections = msg.sections; picks++ }
    } catch { /* 非 JSON 行跳过 */ }
  }
  const cap = { file: CAPTURE, mtime: new Date(st.mtimeMs).toISOString(), ageDays: +((Date.now() - st.mtimeMs) / 86400_000).toFixed(1), contentAt, contentCwd, picks }
  if (sections) {
    const rows = Object.entries(sections).map(([k, v]) => ({ key: k, chars: String(v).length, bytes: Buffer.byteLength(String(v), 'utf8') }))
    for (const r of rows) sysChars += r.chars
    const evals = rows.map(r => [`sec_${r.key}`, String(sections[r.key])])
    const tok = countTokens(evals)
    for (const r of rows) r.tokens = tok.mode === 'real' ? tok.counts[`sec_${r.key}`] ?? null : null
    const total = rows.reduce((a, r) => a + (r.tokens ?? 0), 0)
    const totalChars = rows.reduce((a, r) => a + r.chars, 0)
    for (const r of rows) { r.share = total ? +(r.tokens / total * 100).toFixed(1) : +(r.chars / totalChars * 100).toFixed(1) }
    rows.sort((a, b) => b.chars - a.chars)
    cap.sections = rows
    cap.totalChars = totalChars
    cap.totalBytes = rows.reduce((a, r) => a + r.bytes, 0)
    cap.totalTokens = tok.mode === 'real' ? total : null
    cap.tokenMode = tok.mode
    cap.tokenVia = tok.via ?? tok.reason ?? null
    cap.sectionCount = rows.length
    // skills 一节里到底有哪些技能（按前缀分类 —— 这决定"能不能整块卸"）
    // ⚠️ 两种格式都认：Pi 是 `<skill><name>x</name>…` 的 XML 风；Pi 之外/旧版是 markdown 列表 `- \`name\`：`
    const sk = rows.find(r => r.key === 'skills')
    if (sk) {
      const body = String(sections.skills)
      const xml = [...body.matchAll(/<name>([^<]{2,80})<\/name>/g)].map(m => m[1].trim())
      const md = [...body.matchAll(/(?:^|\n)\s*[-*]\s*`?([a-z0-9][\w.-]{2,})`?\s*[:：]/g)].map(m => m[1])
      const names = xml.length >= md.length ? xml : md
      cap.skillsList = {
        format: xml.length ? '<skill><name>' : 'markdown 列表',
        entries: names.length,
        arkcli: names.filter(n => n.startsWith('arkcli')).length,
        piLens: names.filter(n => n.startsWith('pi-lens')).length,
        other: names.filter(n => !n.startsWith('arkcli') && !n.startsWith('pi-lens')),
      }
    }
  } else cap.error = '这份抓包里没找到 role=system 且带 sections 的记录'
  out.capture = cap
} else out.capture = { file: CAPTURE, error: '抓包件不存在' }

// ---------------------------------------------------------------- ② 真实调用：只认工具调用节点的入参
function walk (dir, depth, acc) {
  if (depth > 6) return
  let ents = []
  try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of ents) {
    const p = join(dir, e.name)
    if (e.isDirectory()) {
      if (/^(node_modules|\.git|backup|backups|_存档|__pycache__|dist|build)$/i.test(e.name)) continue
      walk(p, depth + 1, acc)
    } else if (e.name.endsWith('.out.json')) {
      try { const s = statSync(p); acc.push({ p, size: s.size, mtimeMs: s.mtimeMs }) } catch { }
    }
  }
}
/** 从任意 JSON 节点里递归找工具调用（各家键名不同：`input` / `arguments` 都收 —— 同 `面板\帧动作.mjs` 的做法）
 *  ⚠️ 必须带 `id`：同一次调用会在 `message_start` / `message_end` / `agent_end` **多条记录里各出现一次**
 *  ⇒ 不去重就把"388 事件"当成"388 次调用"（b193 第一版就差点这么报）。 */
function collectToolCalls (node, acc, depth = 0) {
  if (!node || depth > 14) return
  if (Array.isArray(node)) { for (const x of node) collectToolCalls(x, acc, depth + 1); return }
  if (typeof node !== 'object') return
  const t = node.type ?? ''
  const args = node.input ?? node.arguments ?? node.args
  if (args && typeof args === 'object' && (t === 'tool_use' || t === 'toolCall' || t === 'tool_call' || (t === '' && node.name))) {
    acc.push({ id: node.id ?? null, name: String(node.name ?? node.tool ?? ''), args: JSON.stringify(args) })
    return
  }
  if (node.part && (node.part.tool || node.part.type === 'tool')) {
    const p = node.part
    acc.push({ id: p.id ?? p.callID ?? p.callId ?? null, name: String(p.tool ?? p.name ?? ''), args: JSON.stringify(p.state?.input ?? p.input ?? {}) })
    return
  }
  if (t === 'tool_use' && node.part) return
  for (const v of Object.values(node)) collectToolCalls(v, acc, depth + 1)
}

if (SCAN) {
  const files = []
  for (const r of ROOTS) if (existsSync(r)) walk(r, 0, files)
  const cut = Date.now() - DAYS * 86400_000
  const inWindow = files.filter(f => f.mtimeMs >= cut)
  const stat = { filesAll: files.length, filesInWindow: inWindow.length, bytesInWindow: inWindow.reduce((a, f) => a + f.size, 0), toolCalls: 0, toolCallEvents: 0, byName: {}, skills: { 'arkcli-*': 0, 'pi-lens-*': 0 }, hits: [], unparsed: 0, skippedBig: 0, oldest: null, newest: null, dedupe: '按 tool call id 去重（同一调用会在 message_start/end、agent_end 里各出现一次）' }
  for (const f of inWindow) {
    if (f.size > 40 * 1024 * 1024) { stat.skippedBig++; continue }
    stat.oldest = stat.oldest === null ? f.mtimeMs : Math.min(stat.oldest, f.mtimeMs)
    stat.newest = stat.newest === null ? f.mtimeMs : Math.max(stat.newest, f.mtimeMs)
    let text = ''
    try { text = readTextAuto(f.p) } catch { stat.unparsed++; continue }
    const seen = new Set()          // ★ 每份信封内按 tool call id 去重
    for (const line of text.split(/\r?\n/)) {
      if (!line.includes('toolCall') && !line.includes('tool_use')) continue
      let o = null
      try { o = JSON.parse(line) } catch { stat.unparsed++; continue }
      const acc = []
      collectToolCalls(o, acc)
      for (const c of acc) {
        stat.toolCallEvents++
        const key = c.id ? 'id:' + c.id : 'h:' + c.name + '|' + c.args
        if (seen.has(key)) continue
        seen.add(key)
        stat.toolCalls++
        stat.byName[c.name || '(无名)'] = (stat.byName[c.name || '(无名)'] || 0) + 1
        if (/^lens/i.test(c.name) || /pi-lens/i.test(c.args)) { stat.skills['pi-lens-*']++; stat.hits.push({ file: basename(f.p), tool: c.name, args: c.args.slice(0, 120), kind: 'pi-lens' }) }
        else if (/\barkcli\b/.test(c.args)) { stat.skills['arkcli-*']++; stat.hits.push({ file: basename(f.p), tool: c.name, args: c.args.slice(0, 120), kind: 'arkcli' }) }
      }
    }
  }
  stat.oldest = stat.oldest ? new Date(stat.oldest).toISOString().slice(0, 16) : null
  stat.newest = stat.newest ? new Date(stat.newest).toISOString().slice(0, 16) : null
  stat.byNameTop = Object.entries(stat.byName).sort((a, b) => b[1] - a[1]).slice(0, 12)
  delete stat.byName
  out.usage = stat
}

if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); process.exit(0) }

console.log('🚚 载体体检（M6-8 第一步：**只体检、不卸**）')
console.log('')
console.log('【① 载体每次上手被灌了什么】（读抓包件的 `message.sections`）')
const cap = out.capture
if (cap.error) console.log('   ⚠️ ' + cap.error + '（' + cap.file + '）')
else {
  console.log(`   抓包件 ${cap.file}`)
  console.log(`   **内容时间 ${cap.contentAt ?? '?'}**（会话 cwd=${cap.contentCwd ?? '?'}）· 文件 mtime ${cap.mtime}（mtime 会被搬家/复制整批改写，**判决以内容时间为准**）· 命中 system 段 ${cap.picks} 次 · 分节 ${cap.sectionCount} 节`)
  console.log(`   合计 ${cap.totalChars} 字符 / ${(cap.totalBytes / 1024).toFixed(1)} KB${cap.totalTokens ? ` / **${cap.totalTokens} token**` : '（未启用分词器 ⇒ 不报 token）'}`)
  console.log('   分节：')
  for (const r of cap.sections) console.log(`     ${r.key.padEnd(16)} ${String(r.chars).padStart(7)} 字符  ${String((r.bytes / 1024).toFixed(1)).padStart(7)} KB  ${String(r.share).padStart(5)}%${r.tokens ? `  ${String(r.tokens).padStart(6)} token` : ''}`)
  const sk = cap.sections.find(r => r.key === 'skills')
  if (sk) console.log(`   ⇒ **skills 一节占 ${sk.share}%**（${(sk.bytes / 1024).toFixed(1)} KB${sk.tokens ? ` / ${sk.tokens} token` : ''}）—— 这就是"卸不卸"要看的第一个数`)
  if (cap.skillsList) {
    const L = cap.skillsList
    console.log(`   ⇒ skills 清单共 **${L.entries} 条**：\`arkcli-*\` **${L.arkcli}** 条 ／ \`pi-lens-*\` **${L.piLens}** 条 ／ 其他 ${L.other.length} 条（${L.other.slice(0, 6).join('、')}${L.other.length > 6 ? '…' : ''}）`)
  }
  console.log(`   ⚠️ 这份抓包只有 ${cap.sectionCount} 节 —— 施工文档里那版写的是 **7 节（含 \`project_context\` 1,449）**，全库搜 \`project_context\` **只在文档自己里出现**（抓包件里 0 次）⇒ **那 7 节是拼出来的、没有单一证据文件**（b191 已标，b193 用全库搜索坐实）。`)
  // ★ b195：抓包件是**历史快照** —— 卸/改之后必须**再抓一次**才能看到新数（否则会拿旧数当现值）
  const capAgeDays = cap.contentAt ? (Date.now() - Date.parse(cap.contentAt)) / 86400_000 : null
  if (capAgeDays != null && capAgeDays > 3) {
    console.log(`   ⚠️⚠️ **这份抓包是 ${capAgeDays.toFixed(1)} 天前的历史快照** —— 上表是**当时**的注入层。`)
    console.log(`       卸过 / 改过注入源之后，要**再抓一次载体系统提示**（真跑一趟载体）才能看到新数；` +
      `**别把这份旧数当现值用**。`)
  }
}
console.log('')
console.log('【② 最近 ' + DAYS + ' 天这些 skill 真被调用过几次】（**只看工具调用节点的入参**，不看正文 —— 正文里的清单是注入块，会假阳性）')
const u = out.usage
if (!u) console.log('   （--no-usage：跳过）')
else {
  console.log(`   样本量：信封 **${u.filesInWindow}** 份（库存 ${u.filesAll} 份）· ${(u.bytesInWindow / 1048576).toFixed(1)} MB · 时间窗 **${u.oldest} → ${u.newest}**`)
  console.log(`   工具调用 **${u.toolCalls}** 次（去重后 · 原始事件 ${u.toolCallEvents} 条 ⇒ 同一调用会在多条记录里重复出现）${u.unparsed ? `；另有 ${u.unparsed} 行解析不了` : ''}${u.skippedBig ? `；跳过 ${u.skippedBig} 份 >40MB 信封` : ''}`)
  console.log(`   ★ **arkcli-\\* 真实调用 ${u.skills['arkcli-*']} 次** ／ **pi-lens-\\* 真实调用 ${u.skills['pi-lens-*']} 次**`)
  if (u.byNameTop) console.log(`   工具名 Top：${u.byNameTop.map(([k, v]) => `${k} ${v}`).join(' · ')}`)
  if (u.hits.length) { console.log('   命中明细（前 8 条）：'); for (const h of u.hits.slice(0, 8)) console.log(`     [${h.kind}] ${h.file} ${h.tool} ${h.args}`) }
  console.log('')
  console.log('   ⚠️ 口径：**"没调用" ≠ "没用"** —— 也可能是它被别的入口用了、或这 30 天没干那些活。判决权在你。')
}
console.log('')
console.log('👉 下一步（M6-8）：拿这三个数决定"卸不卸"；要卸走官方口 `arkcli +connect uninstall`（**原地改 SKILL.md 会被覆盖回去**），改前整目录备份到 `_crew\\backup\\`，卸完复验要**再抓一次载体系统提示**看 skills 掉到多少。')
