#!/usr/bin/env node
/**
 * 禁散文自检 —— 八·S7（§10-S5）：**不许新增"读散文取状态"的代码**
 *   （＝用正则从人写的文档里抠状态：TASKS.md 的行、复选框、`·` 分隔段、`① ② ③` 小节…）。
 *
 * 为什么立这道闸：同一个坑已经散在多个脚本里（同一份 TASKS.md 被四方各解析各的，见 `脚本优化` §6.2）。
 * 方向是"把语义搬进机器区段"（八·S5 起）＋"认不出的不丢、有告警"（八·S6），所以这里**钉死**：
 *   · 既有写法 → 登记在 REGISTRY（**含实测计数与理由**）＝存量免罪牌；
 *   · **新增/超数 → exit 1**（报文件＋行号＋样例，别想悄悄再加一条正则）。
 *   ⚠️ REGISTRY 不是永久许可：**S6 每迁移完一处，就把那处删掉/降数**（只许降，不随便升）。
 *
 * 检测口径（保守，尽量只抓"代码里出现，不在注释里"）：
 *   · 先剥注释（行首 // 与 *、行内 // 之后不算）；
 *   · 一行要**同时**满足两条才算：① 出现"散文特征字符"（SMELLS）② 同一行有**解析动作**
 *     （`.match(` / `.test(` / `.exec(` / `.split(` / `new RegExp(` / 正则字面量 `/^` `/\s`）
 *     —— 这样"展示文案里带 · / ①"不误伤，抓的是"真的在拿正则从散文里取东西"；
 *   · 本文件自己写了这些特征字符 —— **跳过自身**，否则自伤。
 *
 * 用法：
 *   node _禁散文自检.mjs            # 检查（exit 0=干净；1=有未登记/超数；2=环境错）
 *   node _禁散文自检.mjs --report   # 只打印各文件计数（给 REGISTRY 更新用）
 * 挂点：`起飞前检查.mjs` 第 ②′ 项（跑它 = 每次起飞都过这道闸）。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SELF = getSelf()
function getSelf () { try { return fileURLToPath(import.meta.url).split(/[\\/]/).pop() } catch { return '_禁散文自检.mjs' } }

/** 特征（名字用于报告；正则在"剥完注释的代码部分"上跑）。 */
const SMELLS = [
  { name: '圈号①', re: /[\u2460-\u246e\u24ea]/ },              // ①-⑮ …
  { name: '复选框字符类', re: /\[\s*[xXr>?!\-✓✔]\s*\]/ },      // [x] / [ ] / [r>?!-] 的字符类
  { name: '中圆点·', re: /\u00b7/ },                            // 任务行/坑库的 `·` 分隔
  { name: '任务字段名', re: /(?:轨道|依赖|交付|验收)\s*[:：]/ },  // 轨道:/依赖:/交付:/验收:
  { name: '未识别标记', re: /未识别/ },                          // `## ⚠️ 未识别` 一类
  { name: '空格@空格定位', re: /\\s@\\s/ }                       // 靠"含 @ 的格子"定位列（§7-3）
]

/** 存量登记：文件名 → { allow: 实测计数（2026-10-09 冻结）, why: 为什么现在允许 }。
 *  ⚠️ 只许降数：任何**新增**的"读散文取状态"行会让实测 > 登记 ⇒ 直接红（这就是闸的意义）。
 *     八·S6 每迁移一处存量为"未识别/机器区段"写法，就回来把这里的数降掉或整条删掉。 */
const REGISTRY = {
  // ★ 2026-10-26 补登 7 → 9：2026-10-16 加"任务分级"时 `normalizeTaskLine` 多了 `级:` 段摘出（398）
  //   与 依赖/交付/验收 三个存在性探测（400-402）—— 当时漏登，起飞前检查 ②b 自此一直红。
  //   **它们只修格式/探字段，不取语义**：全角冒号→半角、中圆点空格归一、缺段补齐到 7 段；
  //   真正的"取状态"仍只有 `LINE_RE` 那一条严格正则。按实测 9 登记（不再留一个永远红的数）。
  '台账.mjs': { allow: 9, why: 'TASKS.md 行的**权威读写方**（LINE_RE/归一/字段测试）；八·S5 起兼机器区段写方。2026-10-26 补登 2 行：`级:` 段摘出 ＋ 依赖/交付/验收存在性探测（只修格式，不取语义）' },
  // ★ 2026-10-26 新增登记：**一次性迁移脚本** —— 把"还没有机器区段的年代"的老 `TASKS.md` 导进 C 状态库。
  //   它先试机器区段，读不到才退到行正则；退路是必需的（实测迁移 `_演练8` 时，只按区段导入会把
  //   "目标"和"验收命令"丢成空）。只读不写、只跑一次；不登记就等于"新增读散文"。
  '_迁移状态.mjs': { allow: 1, why: '一次性迁移：老 TASKS.md（无机器区段年代）→ C 状态库；优先机器区段，找不到才退到行正则（实测这条退路必需）' },
  '_坑库.mjs': { allow: 6, why: '坑库 ①②③④ 小节/对策抽取（叠正则的现存写法）+ S6 新加的 hasSections 探测行' },
  '_定编对账.mjs': { allow: 2, why: '定编表靠"含 @ 的格子"定位模型列（§7-3 已知脆弱点，待改造）' },
  '派活.mjs': { allow: 2, why: '坑原文四段抽取（extractSections 读 ①②③④ 小节）' },
  '_重启后验证.mjs': { allow: 1, why: '从另一脚本的中文输出里挑关键行（§7-2 已知脆弱点）' },
  'backlog转台账.mjs': { allow: 1, why: 'backlog → TASKS.md 转换的行解析（已加"认不出不丢+告警"，正则仍在）' },
  '起飞前检查.mjs': { allow: 1, why: '⑨ 数 TASKS.md 复选框行' },
  '门禁.mjs': { allow: 1, why: '摘 FAIL 行的圈号用例标记（⑥⑦…）—— 属输出摘要，非状态源' },
  '额度面板.mjs': { allow: 1, why: '探测"用户把密钥填进了网址格"（含 sk- 判断；圈号来自其提示文案）' },
  // ★ b202 登记：**它读的不是人写散文，是结构化转录**
  //   `_原片读取体检.mjs` 只从 `session.v4.jsonl.zstd`（JSONL）里取 `tool/call` 记录的 `data.arguments`
  //   （= 工具入参），再用正则判断"这条命令是 `> 重定向写`、还是读内容 / 只取元数据 / 只记路径"。
  //   命中的那两行操作的都是**机器数据**，不是散文；b202 已把它原来"扫助手正文统计提及"的那段**删掉**（那才真算读散文）。
  '_原片读取体检.mjs': { allow: 2, why: '解析 tool/call 的 arguments（机器数据）判"写 / 读内容 / 只取元数据 / 只记路径"；不读人写散文' }
  // ★ 2026-10-09 八·S6 迁移后已降数/删除：体检.mjs（改读机器区段，0 行）、编排.mjs（deliverablesOf 改机器区段，0 行）
}

/** "这一行在解析"的动作特征（与 SMELLS 同时命中才算）。 */
const LOOKS_PARSING = /\.(?:match|test|exec|split)\(|new RegExp\(|\/\^|\/\\s/
/** 路径切分 `.split(/[\\/]/)` 不算"解析散文"（遍地都是，先中和掉再判）。 */
const PATH_SPLIT = /\.split\(\s*\/\[\\\\\/\]\/\s*\)/g

function stripComment (line) {
  const s = line.trim()
  if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) return ''
  const i = line.indexOf('//')
  return i >= 0 ? line.slice(0, i) : line
}

function scanFile (filePath) {
  const text = readFileSync(filePath, 'utf8')
  const lines = text.split(/\r?\n/)
  const hits = []
  for (let i = 0; i < lines.length; i++) {
    const code = stripComment(lines[i])
    if (!code.trim()) continue
    const scrubbed = code.replace(PATH_SPLIT, '__PATHSPLIT__')
    if (!LOOKS_PARSING.test(scrubbed)) continue
    const kinds = SMELLS.filter(s => s.re.test(code)).map(s => s.name)
    if (kinds.length) hits.push({ line: i + 1, kinds, sample: code.trim().slice(0, 100) })
  }
  return hits
}

const files = readdirSync(HERE).filter(f => /\.(mjs|cjs)$/i.test(f) && f !== SELF).sort()
const report = process.argv.includes('--report')

let total = 0
const result = new Map()
for (const f of files) {
  let hits = []
  try { hits = scanFile(join(HERE, f)) } catch (e) { console.error(`[禁散文] ⚠️ 读不了 ${f}：${String(e?.message ?? e)}`) }
  total += hits.length
  result.set(f, hits)
}

if (report) {
  console.log(`[禁散文] --report：扫描 ${files.length} 个脚本，命中 ${total} 行\n`)
  for (const [f, hits] of [...result.entries()].filter(([, h]) => h.length).sort((a, b) => b[1].length - a[1].length)) {
    const kinds = {}
    for (const h of hits) for (const k of h.kinds) kinds[k] = (kinds[k] ?? 0) + 1
    console.log(`${String(hits.length).padStart(3)} 行  ${f}　（${Object.entries(kinds).map(([k, n]) => k + '×' + n).join(' ')}）`)
    for (const h of hits) console.log(`      ${f}:${h.line} [${h.kinds.join(',')}] ${h.sample}`)
  }
  process.exit(0)
}

// ── 检查：未登记 / 超数 → 红
let bad = 0
const details = []
for (const [f, hits] of result.entries()) {
  const reg = REGISTRY[f]
  if (!hits.length) continue
  if (!reg) { bad++; details.push(`❌ ${f}：**没有登记**却有 ${hits.length} 行"读散文取状态"（新增的？要么删掉走机器区段，要么在 _禁散文自检.mjs 的 REGISTRY 里登记理由）`); continue }
  if (hits.length > reg.allow) {
    bad++
    details.push(`❌ ${f}：登记 ${reg.allow} 行、实测 ${hits.length} 行（**新增了 ${hits.length - reg.allow} 行**）—— 先看这里：`)
    for (const h of hits.slice(0, 6)) details.push(`      ${f}:${h.line} [${h.kinds.join(',')}] ${h.sample}`)
  }
}
// 顺带提示：登记数下调（迁移完的样子）
const lower = []
for (const [f, reg] of Object.entries(REGISTRY)) {
  const hits = result.get(f) ?? []
  if (reg.allow > 0 && hits.length < reg.allow) lower.push(`${f}：登记 ${reg.allow} → 实测 ${hits.length}（可把登记数降下来）`)
}

console.log(`[禁散文] 扫描 ${files.length} 个活脚本：命中 ${total} 行（已登记 ${Object.keys(REGISTRY).length} 个文件）`)
if (lower.length) { console.log('[禁散文] ℹ️ 可以顺手降数：'); for (const l of lower) console.log('    ' + l) }
if (bad) {
  console.error(`[禁散文] ❌ 有 ${bad} 个文件未被登记/超数：`)
  for (const d of details) console.error('    ' + d)
  console.error('[禁散文] 口径：机器要的状态请走"机器区段/结构化产物"；真需要解析人写文本 → 先登记理由再写。')
  process.exit(1)
}
console.log('[禁散文] ✅ 无新增（存量都已登记）')
process.exit(0)
