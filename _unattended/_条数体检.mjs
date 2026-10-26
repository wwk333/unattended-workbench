#!/usr/bin/env node
/**
 * 条数体检 —— **把"条数"的口径写死在脚本里**（零 token、只读、不调模型）
 *
 * 为什么有它：`token优化-施工文档.md` §3.10 一 定的口径是——**把规则文本按 `；` `;` `。` **`换行`** 切句，
 * **含约束标记的片段 = 1 条**。这个口径以前只写在文档里靠人记 ⇒ **同一份 `brain.md` 数出过 80／101／105／106 四个数**。
 * 本脚本是**唯一口径**（D6 固化项）；`派活.mjs` 的卡片面两条指标**必须 import 本模块**，不许自己再写一套。
 *
 * 口径（逐字对应 §3.10 一，改口径 = 改这里一处）：
 *   ① 先剥 HTML 注释（`<!-- … -->`）—— 注释不是给模型看的规矩
 *   ② 按 `；` `;` `。` **以及换行** 切句（⚠️ 少了"换行"这一刀会少数 26 条）
 *   ③ 片段 trim 后**含约束标记**才算候选：`不许｜必须｜只能｜一律｜禁止｜不要｜不得｜严禁｜⛔`
 *   ④ 片段长度 `≥6` 字（默认开；`--min 0` 可关，用于复现文档里的 80／106）
 *   ⑤ 一条 = 一个"要满足的约束"，同 NFScale 的 1 instruction（**同构**）
 *
 * 用法：
 *   node _条数体检.mjs                      # 默认体检 roles\brain.md
 *   node _条数体检.mjs <任意.md>            # 体检指定文件
 *   node _条数体检.mjs --json               # 机器可读
 *   node _条数体检.mjs --min 0              # 关掉"≥6 字"那一刀（应得 106）
 *   node _条数体检.mjs --punct-only         # 只切标点、不切换行（应得 80）
 *
 * ⚠️ 它**不下判决、不设红线**（施工文档 A1：硬线 = 冲突 0 ＋ 重复 0，**条数不是红线**）——
 *    这里只出**全文规模**，用于 token 预算与冲突面讨论。
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, basename } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 约束标记（施工文档 §3.10 一 原样） */
export const MARK = /不许|必须|只能|一律|禁止|不要|不得|严禁|⛔/
/** 切句标点 */
const PUNCT = /[；;。]/

/** 剥 HTML 注释（注释不是给模型看的规矩；B6 给硬规矩补的注释靠这一步排除） */
export function stripComments (text) {
  return String(text).replace(/<!--[\s\S]*?-->/g, '')
}

/**
 * 数条数（唯一口径）。
 * @param {string} text 规则文本
 * @param {{min?:number, splitLines?:boolean}} [opt] min=片段最小字数（默认 6）；splitLines=false ⇒ 只切标点（复现 80）
 * @returns {{count:number, noMin:number, punctOnly:number, segs:string[]}}
 */
export function countRules (text, opt = {}) {
  const min = opt.min ?? 6
  const splitLines = opt.splitLines !== false
  const body = stripComments(text)
  const cut = (s) => splitLines ? s.split(splitLines ? /[；;。\n]/ : PUNCT) : s.split(PUNCT)
  const segs = cut(body).map(x => x.trim()).filter(Boolean)
  const cand = segs.filter(x => MARK.test(x))
  return {
    count: cand.filter(x => x.length >= min).length,
    noMin: cand.length,
    punctOnly: body.split(PUNCT).map(x => x.trim()).filter(x => x && MARK.test(x)).length,
    segs: cand.filter(x => x.length >= min),
  }
}

/** 按 `## ` 级标题分节（行数 = 本行到下一个 `##` 的前一行；**分节合计 540 ≠ 整文件 546**，见 §3.10 一 b192 口径补） */
export function splitSections (text) {
  const lines = String(text).split('\n')
  const idx = []
  lines.forEach((ln, i) => { if (/^##\s/.test(ln)) idx.push(i) })
  return idx.map((from, k) => {
    const to = k + 1 < idx.length ? idx[k + 1] : lines.length
    const body = lines.slice(from, to).join('\n')
    return { title: lines[from].replace(/^##\s*/, '').trim(), lines: to - from, from: from + 1, to, body }
  })
}

/** 取 `<!-- CREW-BRIEF:BEGIN -->` … `<!-- CREW-BRIEF:END -->` 之间那段（**卡片面**：`派活.mjs:329` 现读内联的就是这一段）
 *  ⚠️ 它 **≠** `## 👷 班组须知` 那一整个 `##` 节 —— 那一节到下一个 `##` 为止（含底稿快照／自驱闭环／执行器故障处置），
 *  **只有本函数取的这一段会进卡**。b192 复检按代码口径更正（原文档把"节"当成"卡片面"）。 */
export function crewBrief (text) {
  const m = /<!--\s*CREW-BRIEF:BEGIN\s*-->([\s\S]*?)<!--\s*CREW-BRIEF:END\s*-->/.exec(String(text))
  return m ? m[1] : null
}

// ------------------------------------------------------------------ CLI
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  const argv = process.argv.slice(2)
  const has = (n) => argv.includes('--' + n)
  const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
  const file = argv.find(a => !a.startsWith('--')) ?? join(HERE, 'roles', 'brain.md')
  if (!existsSync(file)) { console.error('❌ 找不到文件：' + file); process.exit(2) }
  const text = readFileSync(file, 'utf8')
  const min = opt('min') === null ? 6 : Number(opt('min'))
  const lines = text.split('\n').length
  const byChars = (() => { let n = 0; for (const ch of text) n++; return n })()

  const all = countRules(text, { min })
  const secs = splitSections(text).map(s => ({ ...s, n: countRules(s.body, { min }).count }))
  const brief = crewBrief(text)
  const briefN = brief ? countRules(brief, { min }).count : null
  const briefLines = brief ? brief.split('\n').length : null

  const out = {
    file, lines, chars: byChars, bytes: Buffer.byteLength(text, 'utf8'),
    convention: { min, splitLines: true, mark: String(MARK), stripComments: true },
    rules: { count: all.count, noMin: all.noMin, punctOnly: all.punctOnly },
    sections: secs.map(s => ({ title: s.title, from: s.from, to: s.to, lines: s.lines, rules: s.n })),
    cardFace: brief ? { lines: briefLines, rules: briefN } : null,
  }
  if (has('json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0) }

  console.log(`📏 条数体检 · ${basename(file)}`)
  console.log(`   ${byChars} 字符 · ${out.bytes} 字节 · ${lines} 行`)
  console.log(`   口径：剥 HTML 注释 → 切 \`；;。\` ＋ **换行** → 含约束标记 → 片段 ≥${min} 字 ＝ 1 条`)
  console.log('')
  console.log('【全文规模】（⚠️ 不是红线、不是遵循率依据 —— 施工文档 A1）')
  console.log(`   条数                ${String(all.count).padStart(5)}`)
  console.log(`   同一文本 · 不切"换行"  ${String(all.punctOnly).padStart(5)}   （复现文档里的 80）`)
  console.log(`   同一文本 · 不限字数    ${String(all.noMin).padStart(5)}   （复现文档里的 106）`)
  console.log('')
  console.log('【分节】（行数 = 本节跨度；**分节合计 ≠ 整文件行数**，差的 = H1 与首节前空行）')
  let sumL = 0, sumN = 0
  for (const s of secs) {
    sumL += s.lines; sumN += s.n
    console.log(`   ${String(s.n).padStart(3)} 条 ／ ${String(s.lines).padStart(4)} 行   L${s.from}-${s.to}  ${s.title.slice(0, 44)}`)
  }
  console.log(`   ${String(sumN).padStart(3)} 条 ／ ${String(sumL).padStart(4)} 行   ← 分节合计（整文件 ${lines} 行）`)
  console.log('')
  if (brief) {
    console.log('【卡片面】（`<!-- CREW-BRIEF -->` 那段 = 每张卡都内联的规矩）')
    console.log(`   ${String(briefN).padStart(3)} 条 ／ ${String(briefLines).padStart(4)} 行`)
    console.log(`   ⇒ 砍卡片面 N 条，全文自动减 N 条（卡片面 ⊂ 全文面，见 §3.10 二）`)
  } else {
    console.log('【卡片面】⚠️ 没找到 `<!-- CREW-BRIEF -->` … `<!-- CREW-BRIEF:END -->` 标记（跳过）')
  }
  console.log('')
  console.log('👉 下一步（若要看"该不该少"）：**冲突 0 ＋ 重复 0** 才是硬线 —— 走 D5 的异源 AI 判，不靠这个数。')
}
