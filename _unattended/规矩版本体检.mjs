#!/usr/bin/env node
/**
 * 规矩版本体检 —— 回答一个问题：**最近这些大脑会话，跑的是不是当前这版 brain.md？**
 *
 * 为什么有它（2026-10-19 b184，起因是一次真实事故）：
 *   宿主在**加载 profile 时**用 `!!js readFileSync(...)` 把 persona **一次性**求值（不是每轮读盘）。
 *   所以 brain.md 改完不重启 = **改了等于没改**，而且**看不出来**：
 *     实测 10-18 00:55 改的那版，到 10-18 01:10 还在跑的会话里只有 **81.2%** 的行能对上；
 *     真正加载到新版是 10-19 00:01 那次重启之后（**99.7%**）。
 *   `起飞前检查.mjs ⑩` 只能判"文件 vs 进程启动时间"（粗判、零成本）；
 *   本脚本是**逐会话的实证**：直接读每个会话的 `system/message`，与当前 brain.md 做行比对。
 *
 * 判据（口径固定，别改）：
 *   取 brain.md 里 **≥20 字符的非空行** 作基准行；把会话 `system/message` 里从
 *   `You are the BRAIN` 起、到 `Your working directory is` 之前那段当 persona 段；
 *   统计「基准行在 persona 段里逐字出现」的比例。
 *   ⚠️ **≥98% = 同一版**。留 2% 余量是因为转录里存的是**处理过的文本**：
 *     `{{model}}` 这类占位符会被替换、空白可能被归一 ⇒ 逐字比对天生有噪声（实测 99.7% 那一次
 *     唯一对不上的就是 `{{model}}` 那行）。
 *
 * 用法：
 *   node 规矩版本体检.mjs            # 最新 10 个会话 + 判定（默认）
 *   node 规矩版本体检.mjs --all      # 全部带 persona 的会话
 *   node 规矩版本体检.mjs --top 20   # 看最新 20 个
 *   node 规矩版本体检.mjs --json     # 给机器吃
 *
 * 退出码：0 = 最新那个会话就是当前版 / 2 = 不是（常见原因：改完没重启）/ 1 = 判不了（没会话/没文件）
 *
 * ⚠️ 写动作只有一个：把结果落成 `_crew\规矩版本.json`（给看板「🧭 规矩版本」那一格读）。
 *    加 `--no-cache` 就是纯只读。扫全库可能 5–10 秒（要解 zstd 多帧）。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESS_ROOT = join(DSH_HOME, 'sessions')
const BRAIN_MD = process.env.DSH_BRAIN_MD ?? join(HERE, 'roles', 'brain.md')
/** 缓存落点：看板「🧭 规矩版本」一格直接读它（看板不能自己去解 10MB 转录）。 */
const CACHE = process.env.DSH_RULES_CACHE ?? join(ROOT, '_crew', '规矩版本.json')

const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? d) : d }
const AS_JSON = argv.includes('--json')
const ALL = argv.includes('--all')
const NO_CACHE = argv.includes('--no-cache')
const TOP = ALL ? Infinity : Math.max(1, Number(opt('top', 10)))
const ANCHOR = 'You are the BRAIN'
const SUFFIX_ANCHOR = 'Your working directory is'

if (!existsSync(BRAIN_MD)) { console.error(`❌ 找不到 brain.md：${BRAIN_MD}`); process.exit(1) }
const brain = readFileSync(BRAIN_MD, 'utf8')
// ★ b195：**基准行必须用"剥掉 HTML 注释"的那一版** —— 因为注入 persona 时会剥注释
//   （`安装preset.mjs`／profile 里的 `.replace(/<!--[\s\S]*?-->/g,'')`）。
//   用原文当基准 ⇒ 注释行永远对不上 ⇒ 覆盖率假跌（实测：真同版的会话报 78.6%）。
const brainStripped = brain.replace(/<!--[\s\S]*?-->/g, '')
const brainLines = brainStripped.split('\n').map(s => s.replace(/\s+$/, '')).filter(s => s.trim().length >= 20)
if (!brainLines.length) { console.error('❌ brain.md 里没有 ≥20 字符的基准行，口径失效'); process.exit(1) }

/** 解 zstd 多帧转录（与 注入体检.mjs 同一读法；帧魔数 28 B5 2F FD） */
function readSession (file) {
  const buf = readFileSync(file)
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

/** 从会话里取 persona 段（取最后一条 system/message —— 注入体检.mjs 也是 .pop()） */
function personaOf (recs) {
  const sys = recs.filter(r => r.type === 'system/message').pop()
  if (!sys) return null
  const t = (sys.data?.message?.content ?? []).map(c => c.text ?? '').join('\n')
  const i = t.indexOf(ANCHOR)
  if (i < 0) return null
  const j = t.indexOf(SUFFIX_ANCHOR, i)
  const text = t.slice(i, j > 0 ? j : t.length)
  return { sysLen: t.length, text }
}

const rows = []
const set = new Set(brainLines)
/** brain.md 这次的改动时间 —— 两处要用它：① 小会话跳过策略（见下）② 判定"改动之后有没有新会话"。 */
const brainMtimeMs = (() => { try { return statSync(BRAIN_MD).mtimeMs } catch { return null } })()
if (existsSync(SESS_ROOT)) {
  for (const d of readdirSync(SESS_ROOT)) {
    const sub = join(SESS_ROOT, d)
    let entries = []
    try { if (!statSync(sub).isDirectory()) continue; entries = readdirSync(sub) } catch { continue }
    for (const s of entries) {
      const f = join(sub, s, 'session.v4.jsonl.zstd')
      if (!existsSync(f)) continue
      let st
      try { st = statSync(f) } catch { continue }
      // 小会话不可能带完整 persona，跳过省时间 —— **但"改动之后新建的"一律不跳**：
      // 刚建的会话本来就小（实测 `会话冒烟.mjs` 建的那个只有几 KB），跳了就等于"改了永远判不了"（b195 修）。
      const isNewlyCreated = brainMtimeMs != null && st.mtimeMs > brainMtimeMs
      if (st.size < 50_000 && !isNewlyCreated) continue
      let recs
      try { recs = readSession(f) } catch { continue }
      const p = personaOf(recs)
      if (!p) continue
      const pl = p.text.split('\n').map(x => x.replace(/\s+$/, '')).filter(x => x.trim().length >= 20)
      const matched = pl.filter(l => set.has(l)).length
      rows.push({
        session: s,
        cwd: d,
        mtime: new Date(st.mtimeMs).toISOString(),
        // ★ b195：**会话开始时间**（首条记录的时间戳）—— 判"这版改动之后有没有新建过会话"要用它，
        //   不能用 mtime（老会话一直在追加写，mtime 永远很新，会把"改完之后没建过新会话"误报成"没重启"）。
        startMs: (() => {
          const first = recs.find(r => typeof r.time === 'number')
          return first ? first.time : null
        })(),
        sysLen: p.sysLen,
        personaChars: p.text.length,
        personaLines: pl.length,
        matched,
        covOfCurrent: pl.length ? +(100 * matched / brainLines.length).toFixed(1) : 0
      })
    }
  }
}
rows.sort((a, b) => (a.mtime < b.mtime ? 1 : -1))

const same = (r) => r.covOfCurrent >= 98
const newest = rows[0] ?? null
/** 有没有"在 brain.md 这次改动之后**新建**的会话" —— 没有的话，本体检**判不了**（不是"没重启"）。 */
const startedAfterChange = rows.filter(r => r.startMs && brainMtimeMs && r.startMs > brainMtimeMs + 2000)
const verdict = !newest
  ? { code: 1, text: '判不了：没有任何带 persona 的会话（大脑还没跑过？）' }
  : !startedAfterChange.length
    ? { code: 1, text: `判不了：**还没有在 brain.md 这次改动（${new Date(brainMtimeMs).toLocaleString('zh-CN', { hour12: false })}）之后新建过会话** —— 现有 ${rows.length} 个会话都是改动前建的，**它们永远带着旧 persona（这不是故障）**。新建一个会话（或跑 \`会话冒烟.mjs\`）再来看。` }
    : same(startedAfterChange[0])
    ? { code: 0, text: `✅ 最新大脑会话（${newest.session.slice(0, 20)}）跑的就是当前版（${newest.covOfCurrent}%）` }
    : { code: 2, text: `⚠️ 最新大脑会话（${newest.session.slice(0, 20)}）**不是当前版**（只对上 ${newest.covOfCurrent}% 的行）⇒ 改完 brain.md 后还没重启桌面端？` }

/* 落一份缓存给看板（`🧭 规矩版本` 那一格只读它，不解转录）。
 * 这是本脚本唯一的写动作；不想要就加 `--no-cache`。 */
if (!NO_CACHE) {
  try {
    const st = statSync(BRAIN_MD)
    const cache = {
      at: Date.now(),
      brainMd: { path: BRAIN_MD, mtime: new Date(st.mtimeMs).toISOString(), chars: brain.length, baseLines: brainLines.length },
      scanned: rows.length,
      newest: newest ? { session: newest.session, mtime: newest.mtime, personaChars: newest.personaChars, matched: newest.matched, covOfCurrent: newest.covOfCurrent } : null,
      verdict,
      top: rows.slice(0, 5).map(r => ({ session: r.session, mtime: r.mtime, covOfCurrent: r.covOfCurrent }))
    }
    mkdirSync(dirname(CACHE), { recursive: true })
    writeFileSync(CACHE, JSON.stringify(cache, null, 1) + '\n', 'utf8')
  } catch (e) { if (!AS_JSON) console.error('（缓存没写成，不影响判定：' + String(e?.message ?? e).slice(0, 80) + '）') }
}

if (AS_JSON) {
  process.stdout.write(JSON.stringify({
    brainMd: { path: BRAIN_MD, chars: brain.length, baseLines: brainLines.length },
    scanned: rows.length,
    newest: newest ?? null,
    verdict,
    rows: ALL ? rows : rows.slice(0, TOP)
  }, null, 2) + '\n')
} else {
  console.log(`🔬 规矩版本体检 · brain.md = ${brain.length} 字符 / ${brainLines.length} 基准行`)
  console.log(`   扫到带 persona 的会话 ${rows.length} 个（只读；除缓存外不写任何文件）\n`)
  if (rows.length) {
    console.log(`${'最后活动'.padEnd(20)} ${'会话'.padEnd(24)} ${'persona 字符'.padStart(11)}  ${'对上基准行'.padStart(12)}  占当前版`)
    for (const r of rows.slice(0, TOP)) {
      const mark = same(r) ? '✅' : '⚠️'
      console.log(`${r.mtime.replace('T', ' ').slice(0, 19).padEnd(20)} ${r.session.slice(0, 22).padEnd(24)} ${String(r.personaChars).padStart(11)}  ${String(`${r.matched}/${brainLines.length}`).padStart(12)}  ${mark} ${r.covOfCurrent}%`)
    }
  }
  console.log('\n' + verdict.text)
  console.log('判据：≥98% 视为同一版（<2% 是占位符替换/空白归一造成的噪声；实测 99.7% 那次唯一对不上的是 {{model}} 那行）')
}
process.exit(verdict.code)
