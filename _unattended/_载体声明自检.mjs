#!/usr/bin/env node
/**
 * 载体声明自检（十三 · S7）—— **"加减一个载体，真的零代码改动吗？"** 的常驻闸。
 *
 * 干什么（九条，全部零 token、不联网、不 spawn 载体）：
 *   ① 声明文件本身：读得到吗 / carriers 段非空吗 / 每条四个字段齐不齐 / `gatewaySource` 取值合法吗
 *   ② **向上绑定**：`agents.json` 里角色用到的载体（含 `defaultAgent`）**必须在声明里**（否则就是"没有这个载体"）
 *   ③ **翻译器**：角色用到的载体 ⇒ `shape` 必须非空；`shape` 非空 ⇒ 两个翻译器文件都得在
 *   ④ **向下绑定**：`agents.json` 的 agents 段里每个键也得在声明里
 *   ⑤ **孤儿**：声明里每条 ⇒ 要么在 agents 段，要么显式标了 `备案: true`
 *   ⑥ **反向（凭空造的载体）**：`usesProviderAxis('liar-xxx')` **必须抛**"没有这个载体"
 *   ⑦ **反向（删一家）**：把声明里的一家删掉（临时现场，不落盘）⇒ 查它**必须抛**
 *   ⑧ **名单只剩一处**：全仓扫"一行里同时出现 ≥2 个载体名"⇒ 必须 **0 处**（＝判据①，从"人工跑审计"变成闸）
 *   ⑨ 声明里的 `shape` 不许有重复（两家共用一个翻译器 = 面板会把两家的会话串起来）
 *   ⑩ **分派必须动态**：`面板\adapters\index.mjs` 与 `面板\会话\session.mjs` 里**不许静态 import 某一家**的翻译器
 *      （★ b123 补：这两个文件原来正是"一行一家"的静态表，而每行只有一个载体名、又没加引号，
 *        第 ⑧ 条那种"一行 ≥2 个名字"的扫描**抓不到** —— 实测审计报 0 处、缺口却在。现在改成扫目录。）
 *
 * 退出码：0 = 全过；1 = 有红。
 * 用法：`node _载体声明自检.mjs` ｜ `--json`
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { CARRIERS_FILE, carrierDeclOrNull, carrierIds, carriersSource, usesProviderAxis } from './_载体属性.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WS = join(HERE, '..')
const JSON_OUT = process.argv.includes('--json')

const bad = []
const rows = []
const add = (label, ok, detail = '') => { rows.push({ label, ok, detail }); if (!ok) bad.push(label + (detail ? ' —— ' + detail : '')) }
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))

// ── ① 声明文件本身 ────────────────────────────────────────────────────────────
const src = carriersSource()
add('① 声明文件读得到（' + CARRIERS_FILE + '）', src.ok, src.error ?? '')
const reg = (() => { try { return readJson(CARRIERS_FILE).carriers ?? {} } catch { return {} } })()
const ids = Object.keys(reg)
add('① 声明里至少有一个载体', ids.length > 0, `现在 ${ids.length} 个：${ids.join('、')}`)
const FIELD_BAD = []
for (const [id, d] of Object.entries(reg)) {
  for (const f of ['shape', 'gatewaySource', 'ownsSubscription', 'needsModelBindingKey']) {
    if (!(f in d)) FIELD_BAD.push(`${id} 缺字段 ${f}`)
  }
  if (!['model', 'route', 'own'].includes(d.gatewaySource)) FIELD_BAD.push(`${id} 的 gatewaySource 取值非法：${JSON.stringify(d.gatewaySource)}`)
  if (typeof d.ownsSubscription !== 'boolean') FIELD_BAD.push(`${id} 的 ownsSubscription 不是布尔`)
  if (typeof d.needsModelBindingKey !== 'boolean') FIELD_BAD.push(`${id} 的 needsModelBindingKey 不是布尔`)
  if (d.shape !== null && typeof d.shape !== 'string') FIELD_BAD.push(`${id} 的 shape 既不是 null 也不是字符串`)
}
add('① 每条声明的字段齐、取值合法', FIELD_BAD.length === 0, FIELD_BAD.join('；'))

// ── 读 agents.json（拿角色绑定与载体段） ──────────────────────────────────────
const AGENTS = join(WS, '_crew', 'agents.json')
let cfg = { agents: {}, roles: {} }
let cfgErr = ''
try { cfg = readJson(AGENTS) } catch (e) { cfgErr = String(e?.message ?? e) }
add('② `_crew\\agents.json` 读得到', !cfgErr, cfgErr)
const roleAgents = [...new Set(Object.values(cfg.roles ?? {}).map((r) => r?.agent).filter(Boolean))]
if (cfg.defaultAgent) roleAgents.push(cfg.defaultAgent)

// ── ② 向上绑定 ────────────────────────────────────────────────────────────────
const undeclared = roleAgents.filter((a) => !ids.includes(a))
add('② 角色用到的载体都在声明里', undeclared.length === 0,
  undeclared.length ? `没有声明：${undeclared.join('、')}（加载体＝声明加一条 ＋ agents 段加一条 ＋ 两个翻译器）` : `用到 ${roleAgents.length} 个：${roleAgents.join('、')}`)

// ── ③ 翻译器 ──────────────────────────────────────────────────────────────────
const SHAPE_BAD = []
for (const a of roleAgents) {
  const d = reg[a]
  if (!d) continue                                     // ② 已经报过
  if (!d.shape) { SHAPE_BAD.push(`${a} 在用但 shape=null（面板显示不了它的会话）`); continue }
  const c1 = join(HERE, '面板', '会话', 'carriers', d.shape + '.mjs')
  const c2 = join(HERE, '面板', 'adapters', d.shape + '.mjs')
  if (!existsSync(c1)) SHAPE_BAD.push(`${a} 的 shape=${d.shape} 缺 \`面板\\会话\\carriers\\${d.shape}.mjs\``)
  if (!existsSync(c2)) SHAPE_BAD.push(`${a} 的 shape=${d.shape} 缺 \`面板\\adapters\\${d.shape}.mjs\``)
}
add('③ 在编载体的 shape 都有翻译器', SHAPE_BAD.length === 0, SHAPE_BAD.join('；'))

// ── ④ 向下绑定 ────────────────────────────────────────────────────────────────
const agentsKeys = Object.keys(cfg.agents ?? {})
const notDeclared = agentsKeys.filter((k) => !ids.includes(k))
add('④ `agents` 段里每个载体也都声明了', notDeclared.length === 0,
  notDeclared.length ? `agents 段有、声明里没有：${notDeclared.join('、')}` : `${agentsKeys.length} 个：${agentsKeys.join('、')}`)

// ── ⑤ 孤儿（声明里没进 agents 段的，必须显式备案） ────────────────────────────
const orphans = ids.filter((id) => !agentsKeys.includes(id) && reg[id]?.备案 !== true)
add('⑤ 声明里的"孤儿"都显式标了 `备案: true`', orphans.length === 0,
  orphans.length ? `既不在 agents 段、也没标备案：${orphans.join('、')}` : ids.filter((id) => !agentsKeys.includes(id)).map((id) => id + '(备案)').join('、') || '（没有孤儿）')

// ── ⑥ 反向：凭空造的载体 ⇒ 必须抛 ─────────────────────────────────────────────
const LIAR = 'liar-' + process.pid
let liarThrew = ''
try { usesProviderAxis(LIAR) } catch (e) { liarThrew = String(e?.message ?? e) }
add('⑥ 反向：凭空造的载体必须抛"没有这个载体"', liarThrew.includes('没有这个载体'), liarThrew || '**没抛**（＝静默当默认，正是判据③要禁的）')

// ── ⑦ 反向：删一家 ⇒ 查它必须抛（临时现场，不落盘进仓） ───────────────────────
let delThrew = ''
let delNote = ''
try {
  const victim = 'pi'
  const slim = { carriers: { ...reg } }
  delete slim.carriers[victim]
  const dir = mkdtempSync(join(tmpdir(), 'carriers-'))
  const f = join(dir, 'carriers.json')
  writeFileSync(f, JSON.stringify(slim), 'utf8')
  const before = process.env.DSH_CARRIERS_FILE
  process.env.DSH_CARRIERS_FILE = f
  // ⚠️ 必须带 query 重新 import：ESM 按 URL 缓存模块，不带 query 会拿到旧实例（env 也读不到新的）
  const mod = await import(pathToFileURL(join(HERE, '_载体属性.mjs')).href + '?probe=' + Date.now())
  try { mod.usesProviderAxis(victim) } catch (e) { delThrew = String(e?.message ?? e) }
  if (before === undefined) delete process.env.DSH_CARRIERS_FILE; else process.env.DSH_CARRIERS_FILE = before
  rmSync(dir, { recursive: true, force: true })
  delNote = `现场＝临时声明（删掉 ${victim}）；已清理`
} catch (e) { delNote = '造现场失败：' + String(e?.message ?? e) }
add('⑦ 反向：声明里删掉一家 ⇒ 查它必须抛', delThrew.includes('没有这个载体'), (delThrew || '**没抛**') + ' ｜ ' + delNote)

// ── ⑧ 名单只剩一处：全仓扫"一行 ≥2 个载体名" ──────────────────────────────────
const hits = []
const walk = (d, depth = 0) => {
  if (depth > 3) return
  let es = []
  try { es = readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const e of es) {
    const p = join(d, e.name)
    if (e.isDirectory()) {
      // 与 `_probe\_载体可插拔性审计.mjs` 同一套排除（backup/_probe/_crew 不算源码）
      if (/node_modules|\.git|backup|_probe|logs|_存档|sessions|storages|\.trash|_crew|面板\\会话/.test(e.name)) continue
      walk(p, depth + 1)
    } else if (/\.(mjs|js|cjs)$/.test(e.name) && statSync(p).size < 900 * 1024) {
      const lines = readFileSync(p, 'utf8').split(/\r?\n/)
      lines.forEach((l, i) => {
        if (/^\s*(\*|\/\/)/.test(l)) return                                  // 注释里提名字不算硬编码
        const found = ids.filter((f) => new RegExp(`['"\`]${f}['"\`]`).test(l))
        if (found.length >= 2) hits.push(`${p.replace(WS + '\\', '')}:${i + 1} → ${l.trim().slice(0, 80)}`)
      })
    }
  }
}
walk(join(WS, '_unattended'))
add('⑧ 全仓没有"一行里 ≥2 个载体名"的名单（＝判据①）', hits.length === 0,
  hits.length ? `${hits.length} 处：\n      ` + hits.slice(0, 6).join('\n      ') : '0 处')

// ── ⑨ shape 不许重复 ─────────────────────────────────────────────────────────
const shapes = ids.map((id) => reg[id]?.shape).filter(Boolean)
const dupShape = shapes.filter((s, i) => shapes.indexOf(s) !== i)
add('⑨ 没有两家共用一个翻译器（shape 不重复）', dupShape.length === 0, dupShape.length ? `重复：${[...new Set(dupShape)].join('、')}` : `${shapes.length} 个 shape`)

// ── ⑩ 分派必须动态（不许回到"一行一家"的静态表） ──────────────────────────────
const STATIC_BAD = []
for (const rel of [['面板', 'adapters', 'index.mjs'], ['面板', '会话', 'session.mjs']]) {
  const f = join(HERE, ...rel)
  let t = ''
  try { t = readFileSync(f, 'utf8') } catch { STATIC_BAD.push(`读不到 ${rel.join('\\')}`); continue }
  for (const id of ids) {
    // 静态 `import/export … from './<载体名>.mjs'`（可带 carriers/ 前缀）＝ "加载体要改这个文件" 的证据
    if (new RegExp(`from\\s+['"][./]*(?:carriers/)?${id}\\.mjs['"]`).test(t)) STATIC_BAD.push(`${rel.join('\\')} 里静态引用了「${id}」的翻译器`)
  }
}
add('⑩ 分派走动态发现（那两个分派文件里不许静态引用某一家）', STATIC_BAD.length === 0,
  STATIC_BAD.length ? STATIC_BAD.join('；') + ' —— 翻译器要按目录扫（见 `面板\\_翻译器.mjs`）' : '两个分派文件都只再导出，不含任何载体名')

// ── 汇总 ─────────────────────────────────────────────────────────────────────
if (JSON_OUT) {
  console.log(JSON.stringify({ ok: bad.length === 0, bad, rows, file: CARRIERS_FILE, ids }, null, 2))
} else {
  console.log('=== 载体声明自检（十三 · S7）· 声明文件：' + CARRIERS_FILE + ' ===\n')
  for (const r of rows) console.log((r.ok ? '✅ ' : '❌ ') + r.label + (r.detail ? '\n     ' + r.detail : ''))
  console.log('')
  console.log(bad.length === 0
    ? `✅ 全过（${rows.length} 条）—— 加/减一个载体只需：声明一条 ＋ agents 段一条 ＋ 两个翻译器，**零核心改动**。`
    : `❌ 有 ${bad.length} 条红。`)
}
process.exit(bad.length === 0 ? 0 : 1)
