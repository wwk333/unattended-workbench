// 一致性复验：扫"应当已对齐"的文档，看还剩多少**硬过时**表述 + **指向空气的引用**。
// 只读；只报"哪个文件、第几行、命中什么"，不改任何文件。
//
// ★ 2026-10-03 扩写（起因：一次真实漏检）——原来只有 7 条"换载体类"旧账正则，
//   而实际漂移是另外几类：**引用不存在的文件**（`SOP\规则书-v3.md`）、
//   **过时结论**（"看板管线没迁、数据未就绪"、"不含任何盘符/整包可搬"）、
//   **环境变量名写错**（`OPENCODE_CONFIG_DIR`，真名 `OPENCODE_CONFIG`）、**写死的可变量数字**（篇数/标签数/调用次数）。
//   后三类全是"照它干第一步就错"的，所以本脚本现在按三类查：
//     ① 旧账正则（原样保留）
//     ② **路径存在性**：文档里写死的路径，逐条到实机看在不在（这才是"指向空气"的真检测）
//     ③ **可变量 lint**：写死的计数/金额、文档提到的环境变量在实机配置里是否存在
//
// 退出码契约（照本项目惯例）：**0 = 全过 / 1 = 有硬错 / 2 = 仅警告**
//   硬错 = 指向不存在的文件（这类必须修）；警告 = 过时短语、历史提及、写死的可变量（人工看一眼即可）。
//   `起飞前检查.mjs` 用 [0,2] 接它 → **警告不挡起飞，硬错挡**。
import { readFileSync, existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { KB as KB_FROM_MAP } from './_路径.mjs'

const HOME = resolve(import.meta.dirname, '..')                // <工作台根>（本文件在 _unattended\ 下）
const UNATTENDED = join(HOME, '_unattended')
const DOCS = join(HOME, '文档')
const DSH_ROOT = resolve(HOME, '..')                          // <DSH根>
const DSH_HOME = join(process.env.USERPROFILE ?? homedir(), '.dsh')
const KB = process.env.DSH_KB ?? KB_FROM_MAP ?? '**未配置**'   // ★W2：从 config\本机映射.json 来，不再写死盘符
const OB = join(KB, '项目：多agent协同工作台')

const TARGETS = [
  join(OB, '00-策划方案.md'),        // ★ 2026-10-03 起：唯一权威（为什么做/断点/路线/待定）
  join(OB, '01-架构.md'),            // ★ 唯一权威（分层/角色矩阵/机制/前置条件）
  join(OB, 'README.md'),
  join(OB, '01-项目管理文档.md'),    // 历史规格：已被 00/01 取代，仅追溯用（带标注的命中属正常）
  join(OB, '02-产物与规格.md'),
  join(OB, '03-一句话复刻提示词.md'),
  join(OB, '04-部署验收清单.md'),
  join(OB, '05-踩坑全库索引.md'),    // 由 `_同步坑库索引.mjs` 生成；命中计数类属正常
  join(DOCS, '多agent工作台说明.txt'),
  join(DOCS, '无人值守模式-方案.md'),
  join(DOCS, '落地方案.md'),
  join(DOCS, '无人值守模式-开工指令.md'),
  join(DOCS, '本机映射表.md'),       // ★ 唯一写绝对路径的地方，更要查（它指错路最致命）
  join(HOME, '进度.md'),
  join(HOME, '体系说明.md'),
  join(HOME, '_crew', '派活模板.md'),
  join(HOME, '_crew', 'agents.json'),
  join(UNATTENDED, '_coder路由表.json')
]

// ── ① 旧账正则（这些词本身不一定错：历史段落里合法，所以只报"待确认"）
const PATTERNS = [
  { name: 'coder 用 Qoder（旧）', re: /coder-[ab][^\n]{0,40}(qoder|Qoder)/i },
  { name: 'coder 用 DeepSeek-V4-Flash（旧）', re: /(编程\s*A\s*\/?\s*B|coder-[ab])[^\n]{0,40}DeepSeek-V4-Flash/ },
  { name: '编程用 GLM-5.3-Flash@max（旧）', re: /编程\s*A\/B[^\n]{0,20}GLM-5\.3-Flash/ },
  { name: '审核员=Qwen3.8-Max（旧）', re: /审核员[^\n]{0,30}Qwen3\.8-Max/ },
  { name: 'coder 各开 worktree（旧）', re: /coder[^\n]{0,30}--worktree/ },
  { name: '三通道同账号（旧）', re: /三通道同(一个)?账号/ },
  { name: 'rescue 自动拉起「未实现」（旧说法）', re: /rescue[^\n]{0,40}(还没实现|未实现|没有实现)/ },
  // ★ 2026-10-03 新增：实测踩过的过时结论（带"更正/历史/已作废"字样的行属正常）
  { name: '旧看板管线"没迁/数据未就绪"（已作废）', re: /看板(数据)?管线(没迁|未迁)|显示"数据未就绪"|数据未就绪/ },
  { name: '"不含任何盘符 / 整包可搬"（说法不准）', re: /不含任何盘符|整包可搬|搬盘也能跑/ },
  { name: '"同步规则.cmd"（旧家脚本，新家没有）', re: /同步规则\.(cmd|mjs)/ },
  { name: '规则书路径写成 SOP\\规则书-v3.md（不存在）', re: /SOP\\规则书-v3\.md/ },
  { name: 'OPENCODE_CONFIG_DIR（真名 OPENCODE_CONFIG）', re: /OPENCODE_CONFIG_DIR/ }
]

// ── ② 路径存在性：这些是"历史/已作废"提及，命中降级为警告（不算硬错）
const HISTORICAL = [
  '01-项目管理文档.md', '多agent工作台说明.txt', '落地方案.md',
  '看板采集器.mjs', '额度读取器-SDK.mjs', '_register-board-task.ps1',
  '同步规则.cmd', '同步规则.mjs', '看板采集器'
]
// 项目级 / 运行期 / 已作废的路径：本来就不在工作台里，不查（否则全是假阳性）
const RUNTIME_SKIP = [
  '_crew\\runs', '_crew\\fingerprints', '_crew\\当前项目.txt', '_crew\\orchestrator.lock',
  'DSH\\', '.trash', 'Microsoft.PowerShell_profile.ps1', 'backup\\', 'history-from-E\\',
  '_rollback.ps1', 'workspaces\\'
]
// 只查"有扩展名的文件 + 首段是这些真实目录"的路径（挡掉 npm 包名 / 模型名 provider/model / 字段表 a/b/c）
const EXT_OK = /\.(mjs|js|json|yml|yaml|md|ts|cmd|ps1|txt|exe)$/i
const FIRST_OK = new Set(['_unattended', '文档', '_crew', 'SOP', 'roles', 'pi-ext', 'sidebar-plugin', 'agents', 'resources', '_存档'])
const CREW_OK = /^_crew\\(agents\.json|ledger\.json|board-data\.json|派活模板\.md|网关额度\\|[^\\]*\.synced\.json)/

// 占位符 → 真值：只认 `<工作台根>\文档\本机映射表.md` 那张表（文档里唯一写绝对路径的地方）
function loadPlaceholders () {
  const map = {
    '<工作台根>': HOME, '<DSH_HOME>': DSH_HOME, '<AGENTS>': join(DSH_ROOT, 'agents'), '<知识库>': KB, '<DSH根>': DSH_ROOT
  }
  const f = join(DOCS, '本机映射表.md')
  if (!existsSync(f)) return map
  for (const line of readFileSync(f, 'utf8').split(/\r?\n/)) {
    if (!line.startsWith('|')) continue
    const cells = line.split('|').map(s => s.trim())
    if (cells.length < 4) continue
    const key = (cells[1].match(/<([^>]+)>/) ?? [])[1]
    const val = (cells[2].match(/`([^`]+)`/) ?? [])[1]
    if (key && val && !map[`<${key}>`]) map[`<${key}>`] = val
  }
  return map
}
const PH = loadPlaceholders()

// 相对路径的候选根（按"文档里最可能指哪"排序）
const ROOTS = [
  HOME, UNATTENDED, DOCS, join(HOME, '_crew'), ...(KB ? [join(KB, '人机协作SOP-唯一源')] : []),
  join(UNATTENDED, 'sidebar-plugin', 'lib'), DSH_HOME, DSH_ROOT, KB, join(KB, '坑')
]

function exists (p) {
  try { return existsSync(p) } catch { return false }
}
/** 把一个文档里写的路径解析成"实机上到底在不在"。返回 {ok, resolved} 或 null（= 不像路径，不查） */
function probePath (raw) {
  let t = raw.trim()
  // 去掉尾部标点/行号/括号说明
  t = t.replace(/[:：]\d+(-\d+)?$/, '').replace(/[。，,；;）)]+$/, '').trim()
  if (!t || t.length < 3) return null
  // 占位符 / 示例 / 说明 / 命令行参数 / 字段表 / 环境变量赋值 → 不查
  if (/[<>{}*[\]]|\$\{|…|\s|=/.test(t)) return null
  if (/^([a-z]+:\/\/|~|%|\/)/i.test(t)) return null
  if (!t.includes('\\')) return null                       // ★ 必须带反斜杠：npm 包名 / 模型名(provider/model) / 字段表全用正斜杠
  if (!EXT_OK.test(t.replace(/[\\/]+$/, ''))) return null  // ★ 必须像文件（带已知扩展名）
  if (RUNTIME_SKIP.some(s => t.includes(s))) return null    // 项目级 / 运行期 / 已作废

  const clean = t.replace(/[\\/]+$/, '')
  // 展开已知占位符
  let expanded = clean
  for (const [k, v] of Object.entries(PH)) expanded = expanded.replaceAll(k, v)

  const isAbs = /^[A-Za-z]:\\/.test(expanded)
  if (!isAbs) {
    const first = clean.split('\\')[0]
    if (!FIRST_OK.has(first)) return null                  // ★ 首段必须是工作台里真实存在的顶层目录
    if (first === '_crew' && !CREW_OK.test(clean)) return null
  }

  if (isAbs) {
    const p = expanded.replace(/\//g, '\\')
    return { ok: exists(p), resolved: p }
  }
  for (const r of ROOTS) {
    const p = join(r, clean)
    if (exists(p)) return { ok: true, resolved: p }
  }
  return { ok: false, resolved: join(ROOTS[0], clean) }
}

// ── --selftest：**有病能报、没病不报**（照本项目各检查器的惯例）
//   正例：真路径不许报、死链必须报；反例：npm 包名 / 模型名 / 字段表 / 参数表 / 项目级运行期目录 —— 都不该被当成"指向空气"。
if (process.argv.includes('--selftest')) {
  const cases = [
    ['真路径不报（正值）', join(KB, '人机协作SOP-唯一源', 'SOP工作流程-AI协作规则书-v3.0.md'), false],
    ['死链必须报（★这条是本次扩写的起因）', 'SOP\\规则书-v3.md', true],
    ['npm 包名不算路径', '@michengai/dsh-code-review@0.1.10', false],
    ['字段表不算路径', 'found/state/lastWriteSecAgo', false],
    ['参数表不算路径', '--model/--effort', false],
    ['模型名不算路径', 'qwen-token-plan-cn/deepseek-v4.1-flash', false],
    ['项目级运行期目录不查', '_crew\\runs\\', false],
    ['占位符示例不查', '<工作台根>\\_unattended\\roles\\brain.md', false]
  ]
  let bad = 0
  for (const [name, s, shouldFail] of cases) {
    const r = probePath(s)
    const flagged = !!(r && !r.ok)
    const okay = flagged === shouldFail
    if (!okay) bad++
    console.log(`${okay ? '✅' : '❌'} ${name}：\`${s}\` → ${r ? (r.ok ? '存在' : '判为缺失') : '不当作路径'}`)
  }
  console.log(bad === 0 ? '\n✅ 自检通过（有病能报、没病不报）' : `\n❌ 自检失败 ${bad} 例`)
  // 端到端一例：**正常叙述**里的一句死链，走一遍与主循环相同的判定，必须被判成硬错
  const synthetic = '| 规则唯一源 | `SOP\\规则书-v3.md` |'
  let hit = 0
  const markedLine = /更正|原写|已作废|作废|历史|旧家|曾经|已删/.test(synthetic)
  for (const m of synthetic.matchAll(/`([^`\n]{3,160})`/g)) {
    const r = probePath(m[1]); if (r && !r.ok && !markedLine) hit++
  }
  const e2e = hit === 1
  console.log(`${e2e ? '✅' : '❌'} 端到端：正常叙述里的死链被判硬错（命中 ${hit} 处，期望 1）`)
  process.exit(bad || !e2e ? 1 : 0)
}

/** ③ 可变量 lint：写死的计数/金额 + 文档提到但实机配置里没有的环境变量名 */
const VAR_LINTS = [
  { name: '写死的篇数/标签数（会过期）', re: /\*\*\d+\s*(篇|个标签)\*\*|\d+\s*篇\*\*、\s*`?obsidian_tags/ },
  { name: '写死的调用次数/金额（会过期）', re: /共\s*\d+\s*次调用|≈\s*\$\d+\.\d{2,}/ }
]
function envNamesInMachine () {
  const out = new Set()
  const files = [join(HOME, '_crew', 'agents.json'), join(UNATTENDED, '_coder路由表.json')]
  for (const f of files) if (existsSync(f)) {
    for (const m of readFileSync(f, 'utf8').matchAll(/[A-Z][A-Z0-9_]{4,}/g)) out.add(m[0])
  }
  return out
}
const MACHINE_ENV = envNamesInMachine()
const ENV_LIKE = /\b([A-Z][A-Z0-9]+_(?:CONFIG_DIR|CONFIG|BASE_URL|API_KEY|TOKEN|DIR|HOME|PROFILE|ENV|URL|PATH))\b/g

const errors = []
const warns = []

for (const f of TARGETS) {
  if (!existsSync(f)) { console.log(`(缺文件) ${f}`); continue }
  const lines = readFileSync(f, 'utf8').split(/\r?\n/)
  const short = f.split('\\').pop()
  lines.forEach((l, i) => {
    const n = i + 1
    const t = l.trim().slice(0, 110)
    for (const p of PATTERNS) if (p.re.test(l)) warns.push(`${short} L${n} [旧账/过时] ${p.name}\n        ${t}`)
    for (const p of VAR_LINTS) if (p.re.test(l)) warns.push(`${short} L${n} [写死可变量] ${p.name}\n        ${t}`)

    // 环境变量名：文档里提到的，实机配置里有没有
    for (const m of l.matchAll(ENV_LIKE)) {
      const v = m[1]
      if (MACHINE_ENV.has(v)) continue
      warns.push(`${short} L${n} [环境变量] 文档提到 \`${v}\`，实机 agents.json / 路由表里找不到\n        ${t}`)
    }

    // 路径存在性：只查反引号里的（正文散落的路径太多噪音）
    // ★ 口径：**一句话里带"更正/原写/已作废/历史"标注的 → 那是在引述旧错，降到警告**；
    //   正常叙述里指向空气 = 硬错（这类"照它干第一步就错"必须修）。
    const marked = /更正|原写|已作废|作废|历史|旧家|曾经|已删/.test(l)
    for (const m of l.matchAll(/`([^`\n]{3,160})`/g)) {
      const r = probePath(m[1])
      if (!r || r.ok) continue
      const isHist = marked || HISTORICAL.some(h => m[1].includes(h))
      const msg = `${short} L${n} [路径不存在${isHist ? '·更正/历史提及' : ''}] \`${m[1].trim()}\`\n        解析到：${r.resolved}`
      if (isHist) warns.push(msg); else errors.push(msg)
    }
  })
}

// ── 输出
if (warns.length) {
  console.log(`\n### ⚠️ 待确认 ${warns.length} 处（**带"历史/更正/已作废"标注的段落属正常**，人工看一眼）`)
  for (const w of warns) console.log('  ' + w)
}
if (errors.length) {
  console.log(`\n### ❌ 硬错 ${errors.length} 处（**指向不存在的文件 —— 照它干第一步就错**，必须修）`)
  for (const e of errors) console.log('  ' + e)
}
console.log(`\n合计：硬错 ${errors.length} 处 / 待确认 ${warns.length} 处（退出码 0=全过 / 1=有硬错 / 2=仅警告）`)
process.exit(errors.length ? 1 : (warns.length ? 2 : 0))