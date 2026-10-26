#!/usr/bin/env node
/**
 * 方案体检 · 交付前自查报告（结构 + 数字/表格项）
 *
 * 用法：
 *   node scripts/方案体检.mjs --file "D:\...\策划方案.md"
 *   node scripts/方案体检.mjs --file "..." --json
 *
 * 这是**交付前自查报告**：不叫“闸”、**不拦人**——脚本只报告、点名给作者看，
 * 不替人做交付决定（有没有不过项都算“报告跑完了”）。
 * 它只查“结构/数字/表格有没有缺”，不判“内容对不对”。
 * 内容由 references/方案体检.md 的 15 条人判项兜底。
 *
 * 纪律（是作者的纪律，不是脚本拦人）：未答 ≠ 0 / 矩阵有空格 / 有待定词
 * 这三类命中时，报告写明“这份方案不许交付”——别误读成“可以忽略”。
 *
 * 退出码：0 = 报告跑完了（有没有不过项都算跑完）；2 = 用法/读文件错误。
 * --json：blocking = 有没有“不许交付”级的问题（errors 非空）；reportable: true；
 *        errors / warnings / summary / file 等字段照旧保留。
 */

import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const opt = (name, fallback = null) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const fileArg = opt('--file')
const asJson = args.includes('--json')
if (!fileArg) {
  console.error('用法: node scripts/方案体检.mjs --file <方案.md> [--json]')
  process.exit(2)
}
const file = resolve(fileArg)
if (!existsSync(file)) {
  console.error(`读不到文件: ${file}`)
  process.exit(2)
}
const md = readFileSync(file, 'utf8')
const lines = md.split(/\r?\n/)

const errors = []
const warnings = []
const ok = []
const addError = (code, msg) => errors.push({ code, msg })
const addWarn = (code, msg) => warnings.push({ code, msg })
const addOk = (msg) => ok.push(msg)

// ---------- 小工具 ----------
function section (num) {
  const re = new RegExp(`^##\\s*${num}(?:\\.|\\s|$)`, 'm')
  const m = re.exec(md)
  if (!m) return ''
  const start = m.index
  const rest = md.slice(start + m[0].length)
  const next = /^##\s+\d+/m.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}
function hasHeading (num) {
  return new RegExp(`^##\\s*${num}(?:\\.|\\s|$)`, 'm').test(md)
}
function subSection (text, title) {
  const re = new RegExp(`^###\\s+${title}\\b`, 'm')
  const m = re.exec(text)
  if (!m) return ''
  const rest = text.slice(m.index + m[0].length)
  const next = /^###\s+/m.exec(rest)
  return next ? rest.slice(0, next.index) : rest
}
function countListOrTableRows (text) {
  let n = 0
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t) continue
    if (/^\|/.test(t)) {
      if (/^\|\s*[-: ]+\|/.test(t)) continue // 分隔行
      if (/^\|\s*#?\s*\|/.test(t)) continue // 表头
      n++
    } else if (/^[-*]\s+/.test(t) || /^\d+\.\s+/.test(t)) {
      n++
    }
  }
  return n
}

// ---------- 1. 必需章节 ----------
const required = [
  ['0', '一页结论'],
  ['4', '功能规格'],
  ['5', '产品数据与规则'],
  ['7', '外部依赖与谁办'],
  ['8', '产品形态与约束'],
  ['9', '验收'],
  ['10', '红线'],
  ['11', '分批'],
  ['13', '方案摘要'],
]
for (const [num, name] of required) {
  if (hasHeading(num)) addOk(`§${num} ${name}`)
  else addError('E-SECTION', `缺 §${num} ${name}（大脑会缺一块信息）`)
}

// ---------- 2. F / AC 数量与对应 ----------
const fRe = /^###\s+F(\d+)\b[^\n]*$/gm
const fMatches = [...md.matchAll(fRe)]
if (fMatches.length < 1) {
  addError('E-F-COUNT', `一个功能（F#）都没有；至少要有 1 个用户能感知的功能`)
} else if (fMatches.length < 2) {
  addWarn('W-F-FEW', `只有 ${fMatches.length} 个功能；单功能小工具可以，但要确认没有漏掉"看/改/删"里的关键动作`)
} else {
  addOk(`功能 ${fMatches.length} 个`)
}
const acRe = /^#{3,4}\s+AC(\d+)\.(\d+)\b[^\n]*$/gm
const acMatches = [...md.matchAll(acRe)]
if (acMatches.length < 1) {
  addError('E-AC-COUNT', `一条 AC 都没有；每个 F 至少要 1 条`)
} else if (acMatches.length < 3) {
  addWarn('W-AC-FEW', `只有 ${acMatches.length} 条 AC；单功能小工具可以，但最好把正常/出错各写一条`)
} else {
  addOk(`验收 ${acMatches.length} 条`)
}

// 每个 F 里要提到 AC，且至少有一条同号 AC
const acMajors = new Set(acMatches.map(m => Number(m[1])))
for (const m of fMatches) {
  const fnum = Number(m[1])
  const start = m.index
  const rest = md.slice(start)
  const next = /^###\s+F\d+\b/m.exec(rest.slice(m[0].length))
  const block = next ? rest.slice(0, m[0].length + next.index) : rest
  // 只看 F 标题行，不扫正文：正文里"以后做"是范围说明，不是"这个 F 可以没有 AC"
  const deferred = /下一版|本版不做|暂不做/.test(m[0])
  if (!/AC\d+\.\d+/.test(block)) {
    if (deferred) addWarn('W-F-DEFERRED', `F${fnum} 标了"下一版/不做"但没有 AC；排到那一版时必须补`)
    else addError('E-F-AC', `F${fnum} 没写对应的 AC 编号（§9 里要有）`)
  }
  if (!acMajors.has(fnum)) {
    if (deferred) addWarn('W-F-DEFERRED', `F${fnum} 没有同号的 AC${fnum}.x（已标下一版/不做，可暂时没有）`)
    else addError('E-F-AC', `F${fnum} 没有同号的 AC${fnum}.x`)
  }
}

// 每条 AC 的六件套
const acKeys = [
  ['给定', /给定/],
  ['当', /当[^\n]{0,8}[:：]/],
  ['应该', /应该/],
  ['具体例子', /具体例子|例子[^\n]{0,6}[:：]/],
  ['什么算失败', /什么算失败|失败[^\n]{0,6}[:：]/],
  ['怎么验证', /怎么验证|验证[^\n]{0,6}[:：]/],
]
for (const m of acMatches) {
  const start = m.index
  const rest = md.slice(start)
  // 截到下一个任意 ##/###/#### 标题（否则 §9.2 的字段会被算进最后一条 AC）
  const next = /^#{2,4}\s+/m.exec(rest.slice(m[0].length))
  const block = next ? rest.slice(0, m[0].length + next.index) : rest
  const miss = acKeys.filter(([, re]) => !re.test(block)).map(([k]) => k)
  if (miss.length) addError('E-AC-KEY', `AC${m[1]}.${m[2]} 缺：${miss.join('、')}`)
}

// ---------- 3. 2.2 不做清单 ----------
const s2 = section('2')
if (s2) {
  const notDo = subSection(s2, '2\\.2')
  const body = notDo || s2
  const n = countListOrTableRows(body)
  if (n < 3) addError('E-NO-DO', `§2.2「不做什么」只有 ${n} 条；至少 3 条`)
  else addOk(`不做什么 ${n} 条`)
}

// ---------- 4. 红线 ----------
const s10 = section('10')
if (s10) {
  const redLines = (s10.match(/^\s*(?:\d+\.|[-*])\s*⚠️/gm) ?? []).length
  if (redLines < 3) addError('E-REDLINE', `§10 只有 ${redLines} 条带 ⚠️ 的红线；至少 3 条`)
  else addOk(`红线 ${redLines} 条`)
}

// ---------- 5. W1 ----------
const s11 = section('11')
if (s11) {
  if (!/\bW1\b/.test(s11)) addError('E-W1', '§11 没有 W1（第一版要做什么）')
  else addOk('W1')
}

// ---------- 5.1 数据/规则是否太薄 ----------
const s5 = section('5')
if (s5) {
  const n = countListOrTableRows(s5)
  if (n < 6) addWarn('W-DATA-THIN', `§5 产品数据只有 ${n} 行实质内容；大脑聊数据/权限时会缺料（技术类可由大脑补，但产品概念别太少）`)
  else addOk(`产品数据 ${n} 行`)
}

// ---------- 5.2 外部依赖是否只写了"无" ----------
const s7 = section('7')
if (s7) {
  const rows = countListOrTableRows(s7)
  const mentionsExternal = /App|支付|上架|备案|小程序|微信|AI|服务器|域名/.test(md)
  if (rows === 0 && mentionsExternal) {
    addWarn('W-EXT-EMPTY', '方案提到 App/支付/上线/微信/AI 等外部依赖，但 §7 写"无"；确认是真的没有，还是漏查')
  }
  if (rows > 0 && !/来源|查证|未查证|内部判断/.test(s7)) {
    addError('E-EXT-SOURCE', '§7 有外部依赖，但没写来源/查证日期/未查证；不许凭印象')
  }
}

// ---------- 6. 方案摘要 ----------
const s13 = section('13')
const handoffKeys = [
  ['目标', /目标[:：]/],
  ['谁用', /谁用[:：]/],
  ['怎么算做成了', /怎么算做成了[:：]/],
  ['绝对不能做', /绝对不能做[:：]/],
  ['先做', /先做[:：]/],
  ['人工前置', /人工前置[:：]/],
]
if (s13) {
  const miss = handoffKeys.filter(([, re]) => !re.test(s13)).map(([k]) => k)
  if (miss.length) addError('E-HANDOFF', `§13 方案摘要缺：${miss.join('、')}`)
  else addOk('方案摘要 6 行核心字段')
  if (!/调研库[:：]/.test(s13)) addWarn('W-RESEARCH', '§13 没写「调研库：有/无」')
  if (!/产品形态[:：]/.test(s13)) addWarn('W-FORM', '§13 没写「产品形态」')
  if (!/大脑还要问[:：]/.test(s13)) addWarn('W-ASK', '§13 没写「大脑还要问」')
  if (!/\|.*F\d+.*\|/.test(s13)) addWarn('W-INDEX', '§13 没看到 F/AC 索引表')
  const acSet = new Set(acMatches.map(m => `AC${m[1]}.${m[2]}`))
  for (const r of s13.matchAll(/AC(\d+)\.(\d+)/g)) {
    const id = `AC${r[1]}.${r[2]}`
    if (!acSet.has(id)) addError('E-AC-REF', `§13 引用了 ${id}，但 §9 没有这条 AC`)
  }
}

// ---------- 6.1 待问清单 ----------
const s12 = section('12')
if (s12) {
  if (!/^###\s*12\.1/m.test(s12)) {
    addError('E-ASK-LIST', '§12 没有「12.1 大脑可能会问的」；大脑会从零问一遍')
  } else {
    const part = s12.slice(s12.indexOf('### 12.1'))
    const end = part.search(/\*\*假设\*\*/)
    const body = end >= 0 ? part.slice(0, end) : part
    const n = (body.match(/^\|\s*Q\d+/gm) ?? []).length
    if (n < 3) addError('E-ASK-LIST', `§12.1 只有 ${n} 条「大脑可能会问的」；至少 3 条，每条给默认`)
    else addOk(`待问清单 ${n} 条`)
  }
}

// ---------- 7. 产品形态 ----------
const s8 = section('8')
if (s8) {
  const need = ['形态', '谁用', '内网', '离线', '数据敏感度']
  const miss = need.filter(k => !s8.includes(k))
  if (miss.length) addWarn('W-FORM-BASE', `§8 产品形态/约束可能缺：${miss.join('、')}`)
  else addOk('产品形态关键项')
  if (/React|Vue|Node\.js|SQLite|PostgreSQL|Fastify|Express|MySQL|MongoDB/.test(s8)) {
    addWarn('W-TECH-IN-PLAN', '§8 出现了具体技术栈词（框架/数据库）；方案只写产品形态，技术选型留给大脑')
  }
  if (!/^###\s*8\.1/m.test(s8)) addWarn('W-ROUTE', '§8 没有「8.1 现成方案/路线」；没查轮子就写"本次没找"')
}
const s4 = section('4')
if (s4 && /React|Vue|Node\.js|SQLite|PostgreSQL|Fastify|Express|MySQL|MongoDB/.test(s4)) {
  addWarn('W-TECH-IN-PLAN', '§4 功能行为里出现了具体技术栈词；功能规格只写用户看到什么，技术选型留给大脑')
}

// ---------- 8. 占位符 / 旧话术 ----------
const badPhrases = [
  ['E-OLD-TEXT', /以上都不是/],
  ['E-OLD-TEXT', /我说我的/],
  ['E-OLD-TEXT', /你希望花多少|预算多少|A\s*几十块|B\s*几百块/],
]
for (const [code, re] of badPhrases) {
  const hit = re.exec(md)
  if (hit) addError(code, `方案正文出现旧话术「${hit[0]}」——这是这次要删掉的东西；若是在解释/引用，请改成描述而不是原样保留`)
}
const placeholderRe = /【|】|〈|〉|____/
const ph = placeholderRe.exec(md)
if (ph) addError('E-PLACEHOLDER', `还有占位符「${ph[0]}」没填`)
else addOk('无占位符')
if (/YYYY-MM-DD/.test(md)) addWarn('W-DATE-FMT', '出现 YYYY-MM-DD；是占位符就填真实日期，是格式说明就改写成"年-月-日"')
const todoRe = /(?:^|\n)\s*(?:[-*]\s*)?(TODO|XXX)\s*[:：]/
const todo = todoRe.exec(md)
if (todo) addError('E-PLACEHOLDER', `还有未处理的「${todo[1]}」；不是占位就删掉这行，是占位就填掉`)
else if (/\bTODO\b|\bXXX\b/.test(md)) addWarn('W-TODO', '文中出现 TODO/XXX；确认它不是没填的占位符')

// ---------- 10. 交付前自查三件套：缺口数字 / 矩阵空格 / 待定词 ----------
// 这三类命中 = error，报告写明「这份方案不许交付」——这是作者的纪律，
// 不是脚本拦人：脚本只报告、点名给作者看，交不交付由作者定。
// （旧的 W-PENDING“待定 >10 次才提醒”已删掉，被“待定词 = 0”的硬检查取代。）
const NO_DELIVER = '这份方案不许交付'
const splitRow = (t) => t.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map(s => s.trim())

// -- 10.1 矩阵（先解析：缺口数字要拿它的实际格数对账）--
// 标题必须含「元素×维度矩阵」；其后第一张表就是矩阵：第 1 列=元素，其余列=维度。
let matrix = null
const matrixHeading = /^###\s+[^\n]*元素\s*[×x*]\s*维度矩阵[^\n]*$/m.exec(md)
if (matrixHeading) {
  const after = md.slice(matrixHeading.index + matrixHeading[0].length).split(/\r?\n/)
  const tableLines = []
  for (const line of after) {
    const t = line.trim()
    if (!t) { if (tableLines.length) break; else continue }
    if (/^\|/.test(t)) tableLines.push(t)
    else if (tableLines.length) break
  }
  const dataRows = tableLines.slice(1).filter(t => !/^\|(\s*:?-+:?\s*\|)+\s*$/.test(t))
  if (tableLines.length) {
    matrix = { dims: splitRow(tableLines[0]).slice(1), rows: dataRows.map(splitRow) }
  }
}
if (matrix) {
  if (!matrix.dims.length || !matrix.rows.length) {
    addError('E-MATRIX', `「元素×维度矩阵」表不完整（${matrix.rows.length} 个元素 × ${matrix.dims.length} 个维度）；每个格子都要有明确结论`)
  }
  matrix.rows.forEach((cells, ri) => {
    const el = (cells[0] ?? '').trim() || `第${ri + 1}行`
    if (cells.length - 1 !== matrix.dims.length) {
      addError('E-MATRIX', `矩阵第 ${ri + 1} 行（元素「${el}」）列数不对：表头 ${matrix.dims.length} 个维度，这行只有 ${Math.max(0, cells.length - 1)} 格 ⇒ ${NO_DELIVER}`)
    }
    for (let ci = 1; ci <= matrix.dims.length; ci++) {
      const text = (cells[ci] ?? '').trim()
      const dim = (matrix.dims[ci - 1] ?? '').trim() || `维度${ci}`
      if (!text) {
        addError('E-MATRIX', `矩阵第 ${ri + 1} 行（元素「${el}」）第 ${ci} 列（维度「${dim}」）是空格 ⇒ ${NO_DELIVER}（矩阵不许有空格）`)
      } else if (!/问过|本期不做/.test(text)) {
        addError('E-MATRIX', `矩阵第 ${ri + 1} 行（元素「${el}」）第 ${ci} 列（维度「${dim}」）写的是「${text}」，不含「问过/本期不做」⇒ ${NO_DELIVER}`)
      }
    }
  })
}

// -- 10.2 缺口数字（E-GAP）--
// 固定三行写法（脚本按这个解析）：
//   缺口 = 主干 4 ＋ 形态约束 6 ＋ 技术栈 1 ＋ 主线段数 × 3 ＋ 元素数 × 维度数 ＋ 底座 6
//   = 4 + 6 + 1 + 3×3 + 4×8 + 6 = 58 项
//   本次共 58 项，已答 52，本期不做 6，未答 0
const gapRe = /本次共\s*(\d+)\s*项\s*[，,]\s*已答\s*(\d+)\s*[，,]\s*本期不做\s*(\d+)\s*[，,]\s*未答\s*(\d+)/
const gapM = gapRe.exec(md)
const calcRe = /^\s*[=＝]\s*([\d\s+x×*+＋-]*?)[=＝]\s*(\d+)\s*项/m
const calcM = calcRe.exec(md)
if (!gapM) {
  addError('E-GAP', '找不到「本次共 N 项，已答 A，本期不做 B，未答 C」这一行；缺口要一行报清四个数字')
} else {
  const [N, A, B, C] = [Number(gapM[1]), Number(gapM[2]), Number(gapM[3]), Number(gapM[4])]
  if (N !== A + B + C) {
    addError('E-GAP', `缺口数字对不上：本次共 ${N} 项，但 已答 ${A} + 本期不做 ${B} + 未答 ${C} = ${A + B + C} 项（四个数字：${N} / ${A} / ${B} / ${C}）`)
  } else {
    addOk(`缺口数字咬得住：本次共 ${N} = 已答 ${A} + 本期不做 ${B} + 未答 ${C}`)
  }
  if (C !== 0) addError('E-GAP', `未答 ${C} 项 ⇒ ${NO_DELIVER}（缺口没清零）`)
}
if (!calcM) {
  addError('E-GAP', '找不到缺口计算行（形如「= 4 + 6 + 1 + 3×3 + 4×8 + 6 = 58 项」）')
} else if (gapM && Number(calcM[2]) !== Number(gapM[1])) {
  addError('E-GAP', `计算行总数 ${calcM[2]} 项 ≠ 「本次共 ${gapM[1]} 项」（两个数：${calcM[2]} / ${gapM[1]}）`)
}

// 公式里「元素数×维度数」那一项（形如 4×8；× 可写 ×/x/*）要和矩阵实际格数对上
// ⚠️ 公式行要认**准**：宽松正则（只要一行同时含"元素数""维度数"）会被正文抢走——
//   实测：`assets\元素清单.md` 第 4 行「…主线段数、元素数、维度数和清点结果…」先命中，导致定位错项。
//   ⇒ 先要求「缺口 … = … 元素数 … 维度数」；再退一步用宽松正则；都定位不到乘法项时取**最后一个**乘法项
//   （规范式里「元素数×维度数」后面只剩「底座 6」，所以它一定是最后一个乘法项）。
const formulaStrict = /^[^\n]*缺口[^\n]*[=＝][^\n]*元素数[^\n]*维度数[^\n]*$/m.exec(md)
const formulaM = formulaStrict ?? /^[^\n]*元素数[^\n]*维度数[^\n]*$/m.exec(md)
if (!formulaM) addError('E-GAP', '找不到缺口公式行（要含「元素数 × 维度数」那一项）')
if (!matrix) addError('E-GAP', '找不到「元素×维度矩阵」表——矩阵是缺口的一部分（元素数×维度数 要和矩阵格数对上）')
let dimPair = null
if (calcM) {
  const terms = calcM[1].split(/[+＋]/).map(s => s.trim()).filter(Boolean)
  const mults = terms
    .map((t, i) => ({ i, m: /^(\d+)\s*[×x*]\s*(\d+)$/.exec(t) }))
    .filter(x => x.m)
  let hit = null
  if (formulaM) {
    const fIdx = formulaM[0].split(/[+＋]/).findIndex(t => /元素数/.test(t) && /维度数/.test(t))
    hit = mults.find(x => x.i === fIdx) ?? null
  }
  if (!hit && mults.length) hit = mults[mults.length - 1]
  if (hit) dimPair = [Number(hit.m[1]), Number(hit.m[2])]
  else addError('E-GAP', '计算行里找不到「元素数×维度数」那一项（形如 4×8；× 可写 ×/x/*）')
}
if (dimPair && matrix) {
  const [X, Y] = dimPair
  const R = matrix.rows.length
  const D = matrix.dims.length
  const S = R * D
  if (X * Y !== S) {
    addError('E-GAP', `公式写 ${X}×${Y}=${X * Y} 格，矩阵实际 ${R} 行 × ${D} 列 = ${S} 格，对不上（元素数×维度数 要等于矩阵实际格数）`)
  } else {
    addOk(`缺口↔矩阵：公式 ${X}×${Y}=${X * Y} 格 = 矩阵 ${R}×${D}`)
  }
}

// -- 10.3 待定词 = 0（E-PENDING / E-VAGUE）--
const pendingWords = ['待定', '待补', '后续补充', '由执行方判断', '回头再说']
for (const [i, line] of lines.entries()) {
  for (const w of pendingWords) {
    if (line.includes(w)) {
      addError('E-PENDING', `第 ${i + 1} 行出现甩锅词「${w}」⇒ ${NO_DELIVER}（写清默认做法/影响，或标「本期不做」，不许含糊过去）`)
    }
  }
}
const vagueRe = /体验好|流畅|美观|良好|合理|稳定|好用/
for (const m of acMatches) {
  const start = m.index
  const rest = md.slice(start)
  const next = /^#{2,4}\s+/m.exec(rest.slice(m[0].length))
  const block = next ? rest.slice(0, m[0].length + next.index) : rest
  const v = vagueRe.exec(block)
  if (v) {
    addError('E-VAGUE', `AC${m[1]}.${m[2]} 用了不可机判的词「${v[0]}」——换成数值/字样/状态 ⇒ ${NO_DELIVER}`)
  }
}

// ---------- 11. 软提醒 ----------
if (fMatches.length > 15) addWarn('W-F-TOO-MANY', `功能 ${fMatches.length} 个，第一版可能太大；考虑砍到 15 个以内`)
if (acMatches.length < fMatches.length) addWarn('W-AC-FEW', `AC 比功能少（${acMatches.length} < ${fMatches.length}）；每个 F 至少要 1 条`)

// ---------- 输出 ----------
const result = {
  file,
  // 旧的 ok 字段改名 blocking：有没有“不许交付”级的问题（errors 非空）。
  // reportable: true 恒真——报告永远“跑完了”，脚本不拦人、不做交付决定。
  blocking: errors.length > 0,
  reportable: true,
  errors,
  warnings,
  note: '交付前自查报告：只报告、不拦人（脚本不替人做交付决定）。只查方案正文；不查语义，也不覆盖对话记录。',
  summary: {
    sections: required.filter(([n]) => hasHeading(n)).length + '/' + required.length,
    features: fMatches.length,
    acs: acMatches.length,
  },
}
const disciplineCodes = ['E-GAP', 'E-MATRIX', 'E-PENDING', 'E-VAGUE']
const disciplineHits = errors.filter(e => disciplineCodes.includes(e.code))
if (asJson) {
  console.log(JSON.stringify(result, null, 2))
} else {
  console.log(`\n交付前自查报告：${file}`)
  console.log(`结构：${result.summary.sections} 章节 ｜ ${result.summary.features} 功能 ｜ ${result.summary.acs} 条 AC`)
  console.log('（自查报告，不叫闸、不拦人：脚本只报告、点名给作者看，交不交付由作者定）')
  if (ok.length) console.log(`\n通过项：\n- ${ok.join('\n- ')}`)
  if (warnings.length) console.log(`\n提醒（不拦）：\n- ${warnings.map(w => `[${w.code}] ${w.msg}`).join('\n- ')}`)
  if (errors.length) console.log(`\n不过项（点名给作者看）：\n- ${errors.map(e => `[${e.code}] ${e.msg}`).join('\n- ')}`)
  if (disciplineHits.length) {
    console.log(`\n⛔ 按作者纪律：这份方案不许交付（命中 ${disciplineHits.length} 条硬项：未答≠0 / 矩阵有空格 / 有待定词；脚本不拦人，交不交付由你定）`)
  }
  console.log(`\n结论：${errors.length ? `❌ 自查报告点名 ${errors.length} 项不过——按纪律，这份方案不许交付（先补上面点名的项）` : '✅ 自查报告没点名不过项（内容仍需按 15 条人判）'}`)
}
process.exit(0)
