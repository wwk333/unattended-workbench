/**
 * 载体面板 —— 看板「载体」页的服务端（**只做增 / 改 / 删 ＋ 自检**，不做别的）。
 *
 * ## 用户口径（2026-10-18）
 *   *"看板的 API 左边加一个按钮，加一个『载体』，我希望载体插拔化可以在面板进行增删配置。"*
 *
 * ## 三条纪律（写这个文件前先读）
 * 1. **每次写盘 = 备份 ＋ 写 ＋ 自检 ＋ 不过就回滚**。四步缺一不可：
 *    备份走 `.<op>-<时间戳>` 内联副本（与 `额度面板.mjs` 同一套路）；
 *    自检跑 `_载体声明自检.mjs --json`（就是起飞前检查 ⑦e 那条），**红了立刻把两份文件还原** ——
 *    宁可"这次没改成"，也不要留一个自检过不了的配置在工作台上。
 * 2. **删一家要考虑牵连**：还被角色绑着（或在 `defaultAgent` 上）⇒ **拒绝**，先说清"先改绑"。
 * 3. **语义在声明（`_crew\carriers.json`）、物理在 `_crew\agents.json`**（b122 定的分工）。
 *    新增载体 = 声明一条 ＋ agents 段一条（从"模板载体"照抄）＋ 两个翻译器文件（也从模板拷）。
 *    ⚠️ 翻译器**不存在"凭空造一个"这回事** —— 输出格式是那家 CLI 说了算，所以模板是必填的。
 *
 * ★ 需要的进程内能力：`._翻译器.mjs` 的 `ensureShape()`（写完新翻译器**当场能用**，不必重启面板）。
 */
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expand } from '../_agents-config.mjs'
import { ensureShape, translatorFilesOf } from './_翻译器.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))              // = _unattended\面板
const UNATTENDED = resolve(HERE, '..')
const ROOT = resolve(UNATTENDED, '..')
const CARRIERS_FILE = join(ROOT, '_crew', 'carriers.json')
const AGENTS_FILE = join(ROOT, '_crew', 'agents.json')
const SELFCHECK = join(UNATTENDED, '_载体声明自检.mjs')
const ADAPTER_DIR = join(HERE, 'adapters')
const SESSION_DIR = join(HERE, '会话', 'carriers')

const GATEWAY_SOURCES = ['model', 'route', 'own']
const ID_RE = /^[a-z][a-z0-9-]{1,23}$/                     // 与"载体键"的既有用法一致（小写、可带连字符）

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
const writeJson = (p, o) => writeFileSync(p, JSON.stringify(o, null, 2), 'utf8')
/** 内联备份（照 `额度面板.mjs` 的 `.bak-<op>-<时间戳>` 套路；失败不拦主流程）。 */
const backup = (file, op) => { try { copyFileSync(file, `${file}.bak-${op}-${Date.now()}`) } catch {} }

/** 跑自检并解析 `--json`（**唯一判据源** —— 页面显示的红绿与起飞闸同源，不另写一套判定）。 */
export function selfCheck () {
  const r = spawnSync(process.execPath, [SELFCHECK, '--json'], { cwd: UNATTENDED, encoding: 'utf8', timeout: 120000, windowsHide: true })
  const out = String(r.stdout ?? '')
  try {
    const j = JSON.parse(out.slice(out.indexOf('{')))
    return { ok: !!j.ok, bad: j.bad ?? [], rows: j.rows ?? [], ids: j.ids ?? [] }
  } catch {
    return { ok: false, bad: ['自检没跑出 JSON：' + (String(r.stderr ?? '').trim() || out.trim() || `exit=${r.status}`)], rows: [], ids: [] }
  }
}

/** 页面要看的全部数据（**只读**）。 */
export function carriersView () {
  const ca = readJson(CARRIERS_FILE)
  const ag = readJson(AGENTS_FILE)
  const reg = ca?.carriers ?? {}
  const agents = ag?.agents ?? {}
  const roles = ag?.roles ?? {}

  const bind = {}
  for (const [role, r] of Object.entries(roles)) {
    const a = r?.agent
    if (!a) continue
    ;(bind[a] = bind[a] ?? []).push(role)
  }

  const carriers = Object.keys(reg).map((id) => {
    const d = reg[id] ?? {}
    const shape = d.shape == null ? null : String(d.shape)
    const files = shape ? translatorFilesOf(shape) : { adapter: false, session: false }
    const a = agents[id]
    const entry = a?.entry ? String(expand(a.entry)) : null
    return {
      id,
      displayName: (typeof d.displayName === 'string' && d.displayName.trim()) ? d.displayName.trim() : id,
      shape,
      gatewaySource: d.gatewaySource ?? null,
      ownsSubscription: d.ownsSubscription === true,
      needsModelBindingKey: d.needsModelBindingKey === true,
      备案: d.备案 === true,
      备注: typeof d.备注 === 'string' ? d.备注 : '',
      在agents段: !!a,
      entry,
      entry就位: entry ? existsSync(entry) : false,
      sessionFlag: a?.sessionFlag ?? null,
      envKeys: a?.env && typeof a.env === 'object' ? Object.keys(a.env) : [],
      绑定角色: bind[id] ?? [],
      翻译器: files,
    }
  })

  return {
    ok: true,
    file: CARRIERS_FILE,
    agentsFile: AGENTS_FILE,
    defaultAgent: ag?.defaultAgent ?? null,
    roles: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, v?.agent ?? null])),
    carriers,
    templates: carriers.filter((c) => c.在agents段).map((c) => c.id),
    shapes: [...new Set(carriers.map((c) => c.shape).filter(Boolean))],
    形态可选: GATEWAY_SOURCES,
    selfCheck: selfCheck(),
  }
}

/** 校验一条声明（**在写盘之前**跑；返回错误数组，空＝过）。 */
function validateDecl (id, d) {
  const bad = []
  if (!ID_RE.test(id)) bad.push(`载体名「${id}」不合规：只许小写字母开头、后接小写字母/数字/连字符，共 2–24 位`)
  if (d.displayName != null && (typeof d.displayName !== 'string' || !d.displayName.trim())) bad.push('显示名不能是空白')
  if (d.shape != null && !/^[a-z][a-z0-9-]*$/.test(String(d.shape))) bad.push(`shape「${d.shape}」不合规`)
  if (!GATEWAY_SOURCES.includes(d.gatewaySource)) bad.push(`gatewaySource 只许 ${GATEWAY_SOURCES.join(' / ')}，收到 ${JSON.stringify(d.gatewaySource)}`)
  if (typeof d.ownsSubscription !== 'boolean') bad.push('ownsSubscription 必须是 true/false')
  if (typeof d.needsModelBindingKey !== 'boolean') bad.push('needsModelBindingKey 必须是 true/false')
  return bad
}

/** 写两份文件，自检不过就**整体回滚**（含新增的翻译器文件）。 */
async function writeAndVerify (decls, agentsPatch, newTranslators = []) {
  const bakCa = readFileSync(CARRIERS_FILE)
  const bakAg = readFileSync(AGENTS_FILE)
  const ca = readJson(CARRIERS_FILE)
  const ag = readJson(AGENTS_FILE)

  ca.carriers = decls
  if (agentsPatch) agentsPatch(ag)

  backup(CARRIERS_FILE, 'carriers')
  backup(AGENTS_FILE, 'agents')
  writeJson(CARRIERS_FILE, ca)
  writeJson(AGENTS_FILE, ag)

  const check = selfCheck()
  if (!check.ok) {
    // 回滚：两份 json 还原 ＋ 删掉这次新造的翻译器文件（**只删这次新建的**）
    writeFileSync(CARRIERS_FILE, bakCa)
    writeFileSync(AGENTS_FILE, bakAg)
    for (const f of newTranslators) { try { rmSync(f, { force: true }) } catch {} }
    return { ok: false, error: '自检没过，**已整体回滚**（工作台没被改坏）', selfCheck: check }
  }
  // 新翻译器当场生效（同一张 Map ⇒ 同步路径也立刻看得到）
  for (const f of newTranslators) await ensureShape(f.replace(/^.*[\\/]/, '').replace(/\.mjs$/, ''))
  return { ok: true, selfCheck: check }
}

/**
 * 增 / 改 / 删。`op` ∈ `add` | `update` | `delete` | `check`。
 * @returns {Promise<{ok:boolean, error?:string, msg?:string, selfCheck?:object}>}
 */
export async function carriersAction (op, p = {}) {
  const ca = readJson(CARRIERS_FILE)
  const reg = ca?.carriers ?? {}
  const ag = readJson(AGENTS_FILE)
  const agents = ag?.agents ?? {}
  const roles = ag?.roles ?? {}
  const id = String(p.id ?? '').trim()

  if (op === 'check') return { ok: true, msg: '已重跑自检', selfCheck: selfCheck() }

  if (op === 'update') {
    if (!reg[id]) return { ok: false, error: `没有这个载体：${id}` }
    const next = { ...reg[id] }
    for (const k of ['displayName', 'shape', 'gatewaySource', 'ownsSubscription', 'needsModelBindingKey', '备注']) {
      if (k in (p.patch ?? {})) next[k] = p.patch[k]
    }
    if (next.displayName != null) next.displayName = String(next.displayName).trim()
    if (next.shape === '' ) next.shape = null
    if (next.shape != null) next.shape = String(next.shape)
    const bad = validateDecl(id, next)
    if (bad.length) return { ok: false, error: bad.join('；') }
    // 改了 shape ⇒ 两个翻译器文件必须都在（不然面板显示不了它的会话；自检 ③ 只查"在编"的，这里更严）
    if (next.shape) {
      const f = translatorFilesOf(next.shape)
      if (!f.adapter || !f.session) {
        return { ok: false, error: `shape=${next.shape} 的翻译器不全（adapters：${f.adapter ? '有' : '缺'}／会话：${f.session ? '有' : '缺'}）—— 要么换一个已有的 shape，要么先把两个翻译器文件放好` }
      }
    }
    const decls = { ...reg, [id]: next }
    const r = await writeAndVerify(decls, null)
    return r.ok ? { ...r, msg: `已保存 ${id}` } : r
  }

  if (op === 'delete') {
    if (!reg[id]) return { ok: false, error: `没有这个载体：${id}` }
    const bound = Object.entries(roles).filter(([, r]) => r?.agent === id).map(([k]) => k)
    if (bound.length) return { ok: false, error: `「${id}」还被这些角色绑着：${bound.join('、')} —— 先去「设置」把角色改绑到别的载体，再删` }
    if (ag?.defaultAgent === id) return { ok: false, error: `「${id}」是 defaultAgent —— 先换掉它再删` }
    const decls = { ...reg }
    delete decls[id]
    const del = []
    // 翻译器文件：**只删"这次跟着载体一起自动生成"的那种**（shape 与 id 同名），别人的手写文件一律留着
    if (reg[id]?.shape === id) {
      for (const f of [join(ADAPTER_DIR, id + '.mjs'), join(SESSION_DIR, id + '.mjs')]) {
        if (existsSync(f) && readFileSync(f, 'utf8').includes('由「载体」页从模板载体')) del.push(f)
      }
    }
    const r = await writeAndVerify(decls, (g) => { if (g.agents) delete g.agents[id] })
    if (!r.ok) return r
    for (const f of del) { try { rmSync(f, { force: true }) } catch {} }
    return { ...r, msg: `已删除 ${id}` + (del.length ? `（连同 ${del.length} 个自动生成的翻译器）` : '') }
  }

  if (op === 'add') {
    if (reg[id]) return { ok: false, error: `「${id}」已经在声明里了` }
    if (agents[id]) return { ok: false, error: `「${id}」已经在 agents 段里了` }
    const tpl = String(p.template ?? '').trim()
    if (!tpl) return { ok: false, error: '必须选一个「模板载体」—— 翻译器（怎么解析它的输出）造不出来，只能照抄一家同款的' }
    if (!agents[tpl]) return { ok: false, error: `模板载体「${tpl}」在 agents 段里没有条目` }
    const tplDecl = reg[tpl] ?? {}
    const next = {
      displayName: String(p.displayName ?? id).trim() || id,
      shape: id,                                       // 新载体＝新翻译器（就叫它的名字）
      gatewaySource: p.gatewaySource ?? tplDecl.gatewaySource ?? 'model',
      ownsSubscription: typeof p.ownsSubscription === 'boolean' ? p.ownsSubscription : (tplDecl.ownsSubscription === true),
      needsModelBindingKey: typeof p.needsModelBindingKey === 'boolean' ? p.needsModelBindingKey : (tplDecl.needsModelBindingKey === true),
      备注: String(p.备注 ?? `由「载体」页新增（模板＝${tpl}，${new Date().toISOString().slice(0, 10)}）`),
    }
    const bad = validateDecl(id, next)
    if (bad.length) return { ok: false, error: bad.join('；') }
    // 两个翻译器：从模板拷一份，**加一行出处**（删的时候靠这行认"这是自动生成的"）
    const made = []
    for (const [dir, name] of [[ADAPTER_DIR, 'adapters'], [SESSION_DIR, '会话\\carriers']]) {
      const src = join(dir, tpl + '.mjs')
      const dst = join(dir, id + '.mjs')
      if (!existsSync(src)) return { ok: false, error: `模板「${tpl}」缺翻译器文件：${name}\\${tpl}.mjs` }
      if (existsSync(dst)) return { ok: false, error: `翻译器文件已存在：${name}\\${id}.mjs（换个载体名，或先删掉它）` }
      const head = `// ⚠️ 本文件由「载体」页从模板载体 \`${tpl}\` 复制生成（${new Date().toISOString()}）。\n//    它认得的是 **${tpl} 那家的输出格式** —— 如果这家 CLI 的格式不一样，改这里，别改别处。\n`
      writeFileSync(dst, head + readFileSync(src, 'utf8'), 'utf8')
      made.push(dst)
    }
    const decls = { ...reg, [id]: next }
    const r = await writeAndVerify(decls, (g) => {
      g.agents = g.agents ?? {}
      g.agents[id] = JSON.parse(JSON.stringify(agents[tpl]))
      g.agents[id].说明 = `【${new Date().toISOString().slice(0, 10)} 由「载体」页新增】从模板载体「${tpl}」照抄 —— ⚠️ entry / args / env 还是那家的，按新载体的实际情况改。`
    }, made)
    return r.ok ? { ...r, msg: `已新增 ${id}（模板 ${tpl}；两个翻译器已复制）—— ⚠️ 记得去 agents.json 核一遍 entry / args / env` } : r
  }

  return { ok: false, error: '不认识的操作：' + String(op) }
}
