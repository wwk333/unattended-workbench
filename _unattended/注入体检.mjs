#!/usr/bin/env node
/**
 * 注入体检 —— **量"大脑每次请求被塞了什么"**（零成本、只读、不调模型）
 *
 * ★ 2026-10-19（b192 · 施工文档 §四 A4）**就地改造四件事**（原来是量具自己的毛病，不是注入的毛病）：
 *   ① **换掉 `chars/2.6`** —— 那是拍脑袋常数，而且当年一边按"字节"除、一边按"字符"除，**成分全错**。
 *      现在：**有真分词器就数真 token；没有就如实写"未测"**，**不再编一个数出来**。
 *      启用真分词器：`set DSH_TOKENIZER_JSON=<tokenizer.json 路径>`，或放到 `_crew\vendor\deepseek-tokenizer.json`。
 *   ② **选样**改成「**最近 N 天内**（默认 7）**最大的转录**」，并**打印 mtime 与年龄** ——
 *      原来是"转录最大的那个"，在本项目里永远命中 10-07 那个两周前的老会话（⇒ 量到的是两周前的注入）。
 *   ③ **补 skills 统计** —— skills 不在 `system/message`，在 `user/message` 的一条 `<system-reminder>` 里，原来整块漏掉。
 *   ④ **版本判定** —— 原来只验 `sysText.includes(brainMd.slice(0,40))`（**前 40 字符 = 假绿灯**）。
 *      改成"**行覆盖 ≥98% ＝ 与当前 brain.md 同版**"，口径与 `规矩版本体检.mjs` **完全一致**（那边是逐会话实证）。
 *   顺手：**路径全派生**（不再写死 `<工作台根>\_unattended`）＋ **六种 smell 里能机械判的四条**（§3.9）。
 *
 * 用法：
 *   node 注入体检.mjs --project '<示例项目>'      # 该项目"最近 N 天内最大的"会话（同看板口径）
 *   node 注入体检.mjs --project <路径> --days 14         # 放宽选样窗口
 *   node 注入体检.mjs --session <会话id前缀>
 *   node 注入体检.mjs --project <路径> --json
 *
 * 退出码：0 正常 / 2 找不到会话
 * ⚠️ 退出码**不表达"注入好不好"** —— 这是量具，不是闸门（闸门在 `起飞前检查.mjs`）。
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { KB as KB_ROOT } from './_路径.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESS_ROOT = join(DSH_HOME, 'sessions')
const BRAIN_MD = process.env.DSH_BRAIN_MD ?? join(HERE, 'roles', 'brain.md')
const CFG = join(DSH_HOME, 'profiles', 'desktop', 'cordis.patch.yml')
/** 知识库根（`重构\…` / `坑\…` 这类引用是相对它写的）—— 与 `派活.mjs` 同一个环境变量，别各写各的。
 *  ⚠️ 默认值写死本机路径 = **通用性债**（施工文档 §五 记账里有这一条，开源前要一起收）。 */
const VAULT = process.env.DSH_VAULT ?? process.env.DSH_PITFALL_VAULT?.replace(/[\\/]坑[\\/]?$/, '') ?? KB_ROOT
/** persona 段的首尾锚（与 `规矩版本体检.mjs` 同一口径，改一处必须改两处） */
const ANCHOR = 'You are the BRAIN'
const SUFFIX_ANCHOR = 'Your working directory is'
const LINE_MIN = 20          // ≥20 字符的非空行才算"基准行"（同上）

const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const AS_JSON = argv.includes('--json')
const PROJECT = opt('project')
const SESSION = opt('session')
const DAYS = Number(opt('days', 7)) || 7

/** cwd → 会话目录名（DSH 口径：非 ASCII 转 `~` + UTF-16 码位大写十六进制；
 *  ⚠️ **连续的分隔符会并成一个 `-`** —— 实测 `<示例项目>` → `--D-xiangmu-~5F02~6B21~5143--`） */
function encodeDir (p) {
  const mapped = String(p).replace(/[^A-Za-z0-9]/g, ch => ch.codePointAt(0) > 0x7f ? '~' + ch.codePointAt(0).toString(16).toUpperCase() : '-')
  return '--' + mapped.replace(/-+/g, '-') + '--'
}

/** 解 zstd 分帧的转录，返回解析后的记录数组 */
function readSession (dir) {
  const buf = readFileSync(join(dir, 'session.v4.jsonl.zstd'))
  const offs = []
  for (let i = 0; i + 3 < buf.length; i++) if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) offs.push(i)
  const out = []
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length
    let text = ''
    try { text = zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8') } catch { continue }
    for (const line of text.split(/\r?\n/)) { if (line[0] !== '{') continue; try { out.push(JSON.parse(line)) } catch {} }
  }
  return out
}

// ---------------------------------------------------------------- 真分词器（可选）
const TOKEN_ITEMS = []
const wantTokens = (key, text) => { TOKEN_ITEMS.push([key, String(text ?? '')]); return key }
function tokenizerFile () {
  const cands = [
    process.env.DSH_TOKENIZER_JSON,
    join(ROOT, '_crew', 'vendor', 'deepseek-tokenizer.json'),
    join(HERE, 'vendor', 'deepseek-tokenizer.json'),
    join(HERE, 'deepseek-tokenizer.json'),
  ].filter(Boolean)
  return cands.find(p => existsSync(p)) ?? null
}
function countTokens () {
  if (!TOKEN_ITEMS.length) return { mode: 'none', reason: '没有要数的文本', counts: {} }
  const file = tokenizerFile()
  if (!file) return { mode: 'none', reason: '没找到 tokenizer.json（设 DSH_TOKENIZER_JSON，或放到 _crew\\vendor\\deepseek-tokenizer.json）', counts: {} }
  const py = process.env.DSH_PYTHON ?? 'python'
  const src = [
    'import sys,json',
    'from tokenizers import Tokenizer',
    'tk=Tokenizer.from_file(sys.argv[1])',
    'items=json.loads(sys.stdin.buffer.read().decode("utf-8"))',
    'print(json.dumps({k: len(tk.encode(v, add_special_tokens=False).ids) for k,v in items.items()}))',
  ].join('\n')
  const input = JSON.stringify(Object.fromEntries(TOKEN_ITEMS))
  // ⚠️ 必须 `-X utf8` ＋ `sys.stdin.buffer`：Windows 上 Python 的 stdin 默认按 cp936 解码，
  //    直接 `json.load(sys.stdin)` 会把 UTF-8 的中文读成乱码 ⇒ `JSONDecodeError`（b192 实测踩过）。
  const r = spawnSync(py, ['-X', 'utf8', '-c', src, file], { input, encoding: 'utf8', maxBuffer: 64 << 20 })
  if (r.status === 0 && r.stdout.trim().startsWith('{')) {
    return { mode: 'real', via: `${py} + tokenizers + ${basename(file)}`, counts: JSON.parse(r.stdout) }
  }
  const err = String(r.stderr ?? '').split('\n').map(s => s.trim()).filter(Boolean).pop() ?? `exit ${r.status}`
  return { mode: 'none', reason: `分词器跑不起来：${err}`, counts: {} }
}

// ---------------------------------------------------------------- 挑会话
let dir = null
let pickNote = ''
if (SESSION) {
  for (const d of readdirSync(SESS_ROOT)) {
    const sub = join(SESS_ROOT, d)
    for (const s of readdirSync(sub)) if (s.includes(SESSION)) dir = join(sub, s)
  }
} else if (PROJECT) {
  const sd = join(SESS_ROOT, encodeDir(PROJECT))
  if (existsSync(sd)) {
    const cands = readdirSync(sd).map(s => join(sd, s))
      .map(p => ({ p, f: join(p, 'session.v4.jsonl.zstd') }))
      .filter(x => existsSync(x.f))
      .map(x => ({ ...x, st: statSync(x.f) }))
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)
    const cutoff = Date.now() - DAYS * 86400_000
    const within = cands.filter(x => x.st.mtimeMs >= cutoff)
    const pool = within.length ? within : cands
    const best = pool.slice().sort((a, b) => b.st.size - a.st.size)[0]
    dir = best ? best.p : null
    pickNote = !cands.length ? ''
      : within.length
        ? `最近 ${DAYS} 天内 ${within.length} 个，取其中最大的`
        : `⚠️ 最近 ${DAYS} 天内没有该项目的转录 ⇒ **退回"最新那个"**（已 ${((Date.now() - best.st.mtimeMs) / 86400_000).toFixed(1)} 天）—— 量出来的是**那天**的注入，不是今天的`
  }
}
if (!dir) {
  console.error('❌ 找不到会话（用 --project <项目目录> 或 --session <id前缀>）')
  if (PROJECT) {
    console.error('   按规则算出的目录名：' + encodeDir(PROJECT))
    console.error('   现有会话目录（前 8 个，供核对）：')
    for (const d of readdirSync(SESS_ROOT).slice(0, 8)) console.error('     ' + d)
  }
  process.exit(2)
}
const sessStat = statSync(join(dir, 'session.v4.jsonl.zstd'))
const sessMtime = new Date(sessStat.mtimeMs)
const sessAgeDays = (Date.now() - sessStat.mtimeMs) / 86400_000

const recs = readSession(dir)
const kb = (n) => (n / 1024).toFixed(1) + ' KB'
const hdrs = recs.filter(r => r.type === 'request/header')
const header = hdrs[hdrs.length - 1]?.data?.header ?? {}
const tools = header.tools ?? []
// ⚠️ system/message 可能有**多条**：一条是**宿主系统提示**、一条是**persona（brain.md 注入的那份）**。
//    老写法 `.pop()` 只取最后一条 ⇒ 把"宿主提示"整块漏掉、把 persona 当成了"系统提示合计"（b192 更正）。
const sysTexts = recs.filter(r => r.type === 'system/message')
  .map(r => (r.data?.message?.content ?? []).map(c => c.text ?? '').join('\n'))
const sysText = sysTexts.join('\n')
const personaRec = sysTexts.find(t => t.includes(ANCHOR)) ?? ''
const brainMd = existsSync(BRAIN_MD) ? readFileSync(BRAIN_MD, 'utf8') : ''
const agentsMdPath = PROJECT ? join(PROJECT, 'AGENTS.md') : null
const agentsMd = agentsMdPath && existsSync(agentsMdPath) ? statSync(agentsMdPath).size : 0

// ---- skills（③ 原来整块漏掉：它在 user/message 的 <system-reminder> 里）
// ⚠️ 两个实测口径（b192）：① 该块**只在部分会话里出现**（10-13 那批老转录就没有）⇒ 找不到要如实写"本会话没有"，
//    不能当成"0 token"；② 技能清单是 `<available_skills>` 里的 `- \`名字\`: 说明` 列表，**名字里带连字符**。
const reminders = []
for (const r of recs) {
  if (r.type !== 'user/message') continue
  for (const c of r.data?.content ?? []) {
    const t = c.text ?? ''
    if (!t.includes('<system-reminder>')) continue
    for (const m of t.matchAll(/<system-reminder>([\s\S]*?)<\/system-reminder>/g)) reminders.push(m[1])
    if (!t.includes('</system-reminder>')) { const i = t.indexOf('<system-reminder>'); if (i >= 0) reminders.push(t.slice(i)) }
  }
}
const skillBlocks = reminders.filter(t => /<available_skills>|skills? are available|可用技能|技能清单/i.test(t))
const skillsText = skillBlocks.length ? skillBlocks[skillBlocks.length - 1] : ''
const skillNames = [...skillsText.matchAll(/(?:^|\n)\s*[-*]\s*`([^`\n]{2,80})`\s*[:：]/g)].map(m => m[1])
const skillChars = skillsText.length || (skillBlocks.length ? skillBlocks[0].length : 0)

// ---- 版本判定（④ 前 40 字符 → 行覆盖 ≥98%，口径同 规矩版本体检.mjs）
// ★ b195：基准行用**剥掉 HTML 注释**的那一版 —— 注入 persona 时会剥注释（profile 里的 `.replace`），
//   拿原文当基准 ⇒ 注释行永远对不上 ⇒ 覆盖率假跌（实测同版会话报 78.6%）。
const brainLines = brainMd.replace(/<!--[\s\S]*?-->/g, '').split('\n').map(x => x.replace(/\s+$/, '')).filter(x => x.trim().length >= LINE_MIN)
const brainSet = new Set(brainLines)
const pi = personaRec.indexOf(ANCHOR)
const pj = pi >= 0 ? personaRec.indexOf(SUFFIX_ANCHOR, pi) : -1
const personaText = pi >= 0 ? personaRec.slice(pi, pj > 0 ? pj : personaRec.length) : ''
const hostText = sysTexts.filter(t => t !== personaRec).join('\n')
const personaLines = personaText.split('\n').map(x => x.replace(/\s+$/, '')).filter(x => x.trim().length >= LINE_MIN)
const matched = personaLines.filter(l => brainSet.has(l)).length
const lineCoverage = brainLines.length ? +(100 * matched / brainLines.length).toFixed(1) : 0
const sameVersion = brainLines.length > 0 && lineCoverage >= 98
const injected = pi >= 0

// ---- 版本判定要用**最新那个会话**（b192）：量大的是"注入结构"，最新的是"现在到底跑的哪一版"。
//      只拿"最近 N 天内最大的那个"判版本，会判到一个几天前的老会话上（实测 10-13 那批只有 73.4%）。
function coverageOf (sessionDir) {
  try {
    const rs = readSession(sessionDir)
    const t = rs.filter(r => r.type === 'system/message')
      .map(r => (r.data?.message?.content ?? []).map(c => c.text ?? '').join('\n'))
      .find(x => x.includes(ANCHOR))
    if (!t) return null
    const i = t.indexOf(ANCHOR)
    const j = t.indexOf(SUFFIX_ANCHOR, i)
    const pt = t.slice(i, j > 0 ? j : t.length)
    const pl = pt.split('\n').map(x => x.replace(/\s+$/, '')).filter(x => x.trim().length >= LINE_MIN)
    const mt = pl.filter(l => brainSet.has(l)).length
    return { coverage: brainLines.length ? +(100 * mt / brainLines.length).toFixed(1) : 0, chars: pt.length }
  } catch { return null }
}
let newest = null
if (PROJECT) {
  const sd = join(SESS_ROOT, encodeDir(PROJECT))
  if (existsSync(sd)) {
    newest = readdirSync(sd).map(s => ({ p: join(sd, s), f: join(sd, s, 'session.v4.jsonl.zstd') }))
      .filter(x => existsSync(x.f))
      .map(x => ({ ...x, st: statSync(x.f) }))
      .sort((a, b) => b.st.mtimeMs - a.st.mtimeMs)[0] ?? null
  }
}
const newestCov = newest ? coverageOf(newest.p) : null
const newestAgeDays = newest ? +((Date.now() - newest.st.mtimeMs) / 86400_000).toFixed(1) : null

// 版本判定的**权威来源**是 `规矩版本体检.mjs`（它扫全库、逐会话比对，并落 `_crew\规矩版本.json`）。
// 缓存新鲜（≤24h）就直接用 —— 避免这里再扫一遍全库（DRY ＋ 快）；没有/过期才退回"读最新那个会话"。
let verCache = null
let verCacheStale = false
try {
  const j = JSON.parse(readFileSync(join(ROOT, '_crew', '规矩版本.json'), 'utf8'))
  if (j?.at && Date.now() - j.at < 86400_000 && j.newest) {
    // ★ b195 修：缓存只在"**brain.md 从那以后没改过**"时才可信 —— 否则它判的是**上一版**。
    //   实测踩过：刚把 brain.md 换掉，注入体检还在报"✅ 同版 99.7%"（把旧结论贴到新文件上）。
    const curM = existsSync(BRAIN_MD) ? statSync(BRAIN_MD).mtimeMs : 0
    const cacheM = j.brainMd?.mtime ? Date.parse(j.brainMd.mtime) : null
    if (cacheM == null || curM <= cacheM + 1000) {
      verCache = { session: j.newest.session, mtime: j.newest.mtime, coverage: j.newest.covOfCurrent, code: j.verdict?.code ?? null, at: j.at }
    } else verCacheStale = true
  }
} catch { /* 没有缓存就走自算 */ }

// ---- 工具家族
const toolBytes = Buffer.byteLength(JSON.stringify(tools), 'utf8')
const fam = {}
for (const t of tools) {
  const key = t.name.startsWith('mcp_connector') ? 'mcp_connector_*（MCP 连接器管理）'
    : t.name.includes('__') ? t.name.split('__').slice(0, 2).join('__') + '__*'
      : t.name
  fam[key] = (fam[key] ?? 0) + Buffer.byteLength(JSON.stringify(t), 'utf8')
}
const families = Object.entries(fam).sort((a, b) => b[1] - a[1])

// ---- 六种 smell（§3.9；**只做能机械判的**，判不了的如实写"交 LLM / 不适用"）
const smells = []
{
  const n = brainMd.split('\n').length
  smells.push({ id: 1, name: 'Context Bloat', verdict: n >= 200 ? '命中' : '未命中', basis: `brain.md ${n} 行（官方线 ≥200 行；**只是报黄参考，不是硬闸** —— §3.9-3）` })
}
{
  const hits = [...brainMd.matchAll(/(?:^|\n)\s*[-*]?\s*(?:命名规范|缩进|import 顺序|行长|行宽|eslint|prettier|lint|格式化|代码风格)/g)].map(m => m[0].trim())
  smells.push({ id: 3, name: 'Lint Leakage', verdict: hits.length ? '疑似命中（启发式）' : '未命中（启发式）', basis: hits.length ? `命中 ${hits.length} 处：${[...new Set(hits)].slice(0, 5).join(' / ')}` : 'brain.md 里没有 linter/formatter 会查的那类规则（命名/缩进/import 顺序/行长/通用风格）' })
}
{
  const inline = skillNames.length >= 3 || /SKILL\.md/.test(brainMd)
  smells.push({ id: 2, name: 'Skill Leakage', verdict: inline ? '命中' : '未命中', basis: inline ? `brain.md 里疑似内联技能包（${skillNames.length} 条）` : 'brain.md 不内联技能包；**但注入层里有**（见下「skills」那节，那是 M6-8 的事，不是这个文件的 smell）' })
}
{
  const refs = new Set()
  for (const m of brainMd.matchAll(/`([^`\n]{3,160})`/g)) {
    const s = m[1]
    if (/[<>*?]/.test(s) || /\$\{/.test(s)) continue
    if (/\\|\//.test(s) && /[A-Za-z]:\\|^_|\\/.test(s)) refs.add(s)
  }
  const dead = []
  const resolveCands = (raw) => {
    let s = String(raw).trim()
    // `node <盘符>\…\x.mjs verify` / `node _unattended\长命资源巡检.mjs` 这种"命令行"型引用：
    // 把**路径那一段**抠出来再判（否则整串当然不存在 = 假红 —— b192 第一版就是这么误报的）。
    const m = /([A-Za-z]:[\\/][^\s"'`]*|[^\s"'`]*[\\/][^\s"'`]*)/.exec(s)
    if (m) s = m[1].replace(/[，。；、]+$/, '')
    if (/^[A-Za-z]:[\\/]/.test(s)) return [s]
    return [join(ROOT, s), join(HERE, s), join(ROOT, '_crew', s), ...(VAULT ? [join(VAULT, s), join(VAULT, '项目：多agent协同工作台', s)] : [])]
  }
  for (const r of refs) {
    const cands = resolveCands(r)
    const ok = cands.some(p => { try { statSync(p); return true } catch { return false } })
    if (!ok) dead.push({ ref: r, tried: cands })
  }
  smells.push({ id: 4, name: 'Blind References', verdict: dead.length ? `命中 ${dead.length} 条（引用的路径不存在）` : '未命中', basis: dead.length ? dead.slice(0, 6).map(d => d.ref).join(' ／ ') : `扫了 ${refs.size} 条路径型引用，全部存在（**这一条我们用文件系统判，不用 LLM** —— §3.9-1）`, dead })
}
smells.push({ id: 5, name: 'Init Fossilization', verdict: '不适用', basis: '原文判据＝"该文件只有 1 次提交"，需要 git 历史；brain.md 在频繁修改 ⇒ 按判据不命中，**不设体检项**（§3.9-2）' })
smells.push({ id: 6, name: 'Conflicting Instructions', verdict: '未判', basis: '**需要 LLM 读全文判**（D5：异源 AI 干活 → 大脑出提示词 → 用户终审）；机械判抓不到"换说法"（实测 bigram 只抓到 2 对）' })

// ---- 数 token（一次性批量，找不到分词器就全 null）
wantTokens('tools', JSON.stringify(tools))
wantTokens('host', hostText)
wantTokens('brain', brainMd)
wantTokens('skills', skillsText)
if (agentsMd) wantTokens('agents', 'x'.repeat(agentsMd))   // 只在有 AGENTS.md 时才数
const tokenResult = countTokens()
const tk = (k) => (tokenResult.mode === 'real' ? tokenResult.counts[k] ?? null : null)
// ⚠️ 合计**一律用字节**：原来写 `sysText.length + toolBytes + agentsMd` 是"字符＋字节"混加（和 chars/2.6 同族的错）。
//    块 = persona（按 brain.md 全文那份算）＋ 宿主系统提示 ＋ 工具目录 ＋ skills ＋ AGENTS.md；
//    **不含**每次请求的固定模板（工具调用格式/会话模板，≈1,000–1,500 token）。
const hostBytes = Buffer.byteLength(hostText, 'utf8')
const brainBytes = Buffer.byteLength(brainMd, 'utf8')
const skillsBytes = Buffer.byteLength(skillsText, 'utf8')
const totalBytes = brainBytes + hostBytes + toolBytes + skillsBytes + agentsMd

const out = {
  session: basename(dir),
  sessionMtime: sessMtime.toISOString(),
  sessionAgeDays: +sessAgeDays.toFixed(1),
  pickNote,
  records: recs.length,
  requestsSeen: hdrs.length,
  tokens: { mode: tokenResult.mode, via: tokenResult.via ?? null, reason: tokenResult.reason ?? null, counts: tokenResult.counts },
  systemPromptChars: sysText.length,
  systemPromptTokens: tokenResult.mode === 'real' ? (tk('host') ?? 0) + (tk('brain') ?? 0) : null,
  hostPromptChars: hostText.length,
  hostPromptTokens: tk('host'),
  systemRecords: sysTexts.length,
  brainMdChars: brainMd.length,
  brainMdBytes: brainBytes,
  brainMdLines: brainMd.split('\n').length,
  brainMdTokens: tk('brain'),
  personaInSession: { chars: personaText.length, tokens: tokenResult.mode === 'real' ? tk('brain') : null, note: '会话里那份的规模（与"当前文件"同版时才等于 brainMdChars）' },
  persona: { injected, anchorFound: injected, personaChars: personaText.length, lineCoverage, sameVersion, basis: '行覆盖 ≥98% ＝ 同版（口径同 规矩版本体检.mjs）' },
  version: {
    source: verCache ? 'cache' : 'scan',
    cacheStale: verCacheStale,
    sampleCoverage: lineCoverage,
    newestSession: verCache?.session ?? (newest ? basename(newest.p) : null),
    newestAgeDays,
    newestCoverage: verCache?.coverage ?? (newestCov?.coverage ?? null),
    verdict: (verCache?.coverage ?? newestCov?.coverage ?? null) === null ? '判不了'
      : ((verCache?.coverage ?? newestCov.coverage) >= 98 ? '同版' : '不是当前版'),
    hint: '判据取**最新那个会话**（不是"最大的那个"）：最大的是结构样本，最新的是"现在跑的哪一版"；权威脚本＝规矩版本体检.mjs（缓存 _crew\\规矩版本.json）',
  },
  brainMdInPrompt: injected,                       // 兼容旧字段名（语义＝"persona 段在 system 里"）
  skills: { blocks: skillBlocks.length, chars: skillChars, tokens: tk('skills'), names: skillNames.length, sample: skillNames.slice(0, 8) },
  tools: { count: tools.length, bytes: toolBytes, tokens: tk('tools'), top: families.slice(0, 8) },
  agentsMdBytes: agentsMd,
  fixedPrefixBytes: totalBytes,
  fixedPrefixTokens: tokenResult.mode === 'real' ? (tk('host') ?? 0) + (tk('brain') ?? 0) + (tk('tools') ?? 0) + (tk('skills') ?? 0) + (tk('agents') ?? 0) : null,
  fixedPrefixNote: '块合计，**不含**每次请求的固定模板（工具调用格式／会话模板 ≈1,000–1,500 token）',
  smells
}

if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); process.exit(0) }

const T = (v, w = 6) => tokenResult.mode === 'real' ? String(v ?? '?').padStart(w) : ' 未测'.padStart(w)
const dayTag = sessAgeDays > DAYS ? '⚠️ ' : ''
console.log(`🔬 注入体检 · 会话 ${out.session}`)
console.log(`   转录 mtime ${sessMtime.toISOString().slice(0, 16)}Z（**${out.sessionAgeDays} 天前**）${dayTag}${pickNote ? ' · 选样：' + pickNote : ''}`)
console.log(`   记录 ${out.records} 条 · 转录里的请求头 ${out.requestsSeen} 个（转录只留一部分头，真实请求数看 cost-meter）`)
console.log(`   分词器：${tokenResult.mode === 'real' ? '✅ 真分词器（' + tokenResult.via + '）' : '➖ 未启用 ⇒ **token 一列全部空着，不编数**（' + tokenResult.reason + '）'}`)
console.log('')
console.log('【每次请求都要重发的固定前缀】')
console.log(`  ① persona（roles\\brain.md 全文）  ${String(brainMd.length).padStart(7)} 字符 ${String(brainBytes).padStart(7)} 字节 ～ ${T(out.brainMdTokens)} token`)
const ver = out.version.cacheStale
  ? '⚠️ **有缓存但它比 brain.md 旧**（那份缓存是上一版的结论）⇒ **本次判不了**，去跑一次 `规矩版本体检.mjs` 再回来看'
  : out.version.source === 'cache'
    ? `${out.version.verdict === '同版' ? '✅ **同版**' : '⚠️ **不是当前版**'}（行覆盖 ${out.version.newestCoverage}% · 最新会话 ${String(out.version.newestSession ?? '').slice(0, 18)}… · ${newestAgeDays} 天前 · **取自 \`_crew\\规矩版本.json\` 缓存**，权威脚本是 \`规矩版本体检.mjs\`）`
    : !newestCov ? '➖ 判不了（没有带 persona 段的最新会话）—— 跑一次 `规矩版本体检.mjs` 就有缓存了'
      : newestCov.coverage >= 98
        ? `✅ 与当前 brain.md **同版**（最新会话 ${String(out.version.newestSession ?? '').slice(0, 18)}… 行覆盖 ${newestCov.coverage}% · ${newestAgeDays} 天前）`
        : `⚠️ **不是当前版**（最新会话行覆盖只有 ${newestCov.coverage}%，阈值 98% · ${newestAgeDays} 天前）⇒ 那会话跑的是**它启动那一刻**的 brain.md —— 改完没重启桌面端？`
console.log(`     ↳ 版本判定：${ver}`)
console.log(`       （选样会话自己的行覆盖 ${lineCoverage}% —— 只作参考，**版本以最新会话为准**）`)
console.log(`  ② 宿主系统提示（不含 persona）    ${String(hostText.length).padStart(7)} 字符 ～ ${T(out.hostPromptTokens)} token   ${sysTexts.length > 1 ? `（system 段共 ${sysTexts.length} 条：宿主 + persona）` : ''}`)
console.log(`  ③ 工具目录 ${String(tools.count ?? tools.length).padStart(3)} 个                  ${String(toolBytes).padStart(7)} 字节 ～ ${T(out.tools.tokens)} token`)
console.log(`  ④ skills（system-reminder）        ${String(skillChars).padStart(7)} 字符 ～ ${T(out.skills.tokens)} token   ${out.skills.blocks ? `（${out.skills.names} 条技能 · ★ 原来整块漏统计）` : '（**本会话没有** skills 块 —— 老转录里没有，不是 0 token）'}`)
console.log(`  ⑤ 项目 AGENTS.md                  ${String(agentsMd).padStart(7)} 字节 ～ ${agentsMd ? T(tk('agents')) : '    0'} token   ${agentsMd ? '' : '（该项目没有 AGENTS.md）'}`)
console.log(`  ───────────────────────────────────────────────────────────`)
console.log(`  合计固定前缀                      ${String(totalBytes).padStart(7)} 字节 ～ ${T(out.fixedPrefixTokens)} token / 每次请求（不含固定模板 ≈1,000–1,500）`)
console.log('')
console.log('【工具目录里谁最占地方】')
for (const [k, v] of families.slice(0, 8)) console.log(`  ${k.padEnd(34)} ${kb(v).padStart(9)}   ${String(Math.round(v / toolBytes * 100)).padStart(3)}%`)
console.log('')
console.log('【六种配置味道（§3.9 · 只判能机械判的）】')
for (const s of smells) console.log(`  ${String(s.id).padStart(2)}. ${s.name.padEnd(24)} ${s.verdict.padEnd(18)} ${s.basis}`)
console.log('')
console.log('【上下文管理的旋钮（从配置现读）】')
try {
  const cfg = readFileSync(CFG, 'utf8')
  const off = (id) => new RegExp(`- id: ${id}\\n\\s+name: [^\\n]+\\n\\s+disabled: true`).test(cfg)
  console.log(`  会话压缩 compaction-basic      ${off('compaction-basic') ? '关 ❌（用户口径：压缩丢细节）' : '开'}`)
  console.log(`  /compact 命令 command-compact  ${off('command-compact') ? '关' : '开'}`)
  const pruner = /thresholdChars:\s*(\d+)\s*\n\s*headChars:\s*(\d+)\s*\n\s*tailChars:\s*(\d+)/.exec(cfg)
  console.log(`  工具输出裁剪 tool-result-pruner  ${off('tool-result-pruner') ? '关' : '开 ✅'}${pruner ? `（超 ${pruner[1]} 字符 → 留头 ${pruner[2]} + 尾 ${pruner[3]}）` : ''}`)
} catch { console.log('  ⚠️ 读配置失败：' + CFG) }
console.log('  换新会话阈值                   软 60% / 硬 75%（执行者自启链：DSH 插件 → 确保看守.mjs → swap-entry.mjs → 换新会话.mjs --watch --execute；实测该看守进程在跑）')
console.log('')
console.log('👉 优化顺序（见 KB `07-大脑内部机制-注入与上下文.md`）：**先砍轮次 → 再换会话 → 最后才动前缀**')
