/**
 * 项目定位 · 一个地方回答「这次的活到底在哪个目录」 · b209（2026-10-20）
 *
 * ## 为什么要有它
 * 面板的「钉项目」钉的是 **DSH 工作区**（= 你打开会话时选的那个文件夹），而**真正干活的目录**
 * 必须有 `_crew\`（工作台根：runs / running / ledger 代理 / TASKS.md 都在里面）。
 * 两者**可以不是同一个目录** —— 实例：会话开在 `obsidian\…\项目：恋爱军师`（只放策划与项目管理两份 md），
 * 代码在 `<示例项目>`；于是看板/会话/运转链全按"文档目录"去读 ⇒ **一片空白**，看着像"检测不到"。
 *
 * ## 判据（从强到弱，**一条都不许猜**）
 *   ① 目录自己带工作台（`_crew` 目录或 `TASKS.md`）⇒ 就是它（最常见，零成本）。
 *   ② 用户对照表 `_crew\项目映射.json`（"改钉"时自动记一行；也可手改）⇒ 用它。
 *   ③ 账本证据：账本里**最近一条**能反推出项目（`envelope` 落在 `<项目>\_crew\runs\`）且**在窗口内**
 *      ⇒ 用它，并把"依据"（时间 / 那条调用）带出去给人看。
 *   ④ 都不成立 ⇒ 原样返回 ＋ `noWorkbench:true`（调用方**必须把话说明白**，不许静默显示空表）。
 *
 * ⚠️ 关于「会话模式能不能当依据」（用户 2026-10-20 提议）——**实测否掉了**：
 *   · 会话**头**里的 `agentPreset` 只是**建会话那一刻的初值，切模式不回写**（DSH 自己的注释原话：
 *     "Reconstruction reads the `agentPreset` Session projection, **never the header alone**"）⇒ 真正的模式
 *     ＝ 初值 ＋ 转录里的 `agent-preset/selected` 事件。实测那条通宵会话：头写 `standard`，但 **01:48:03
 *     明确选过 `{"agentPreset":"unattended"}`**（唯一一条）⇒ **模式真生效了**（人格也真注入：`You are the BRAIN` ×1）；
 *   · 但**模式给不出代码目录**（它只知道会话开在哪个家）⇒ 定不了路径；
 *   · 另，M6-1 早定了更稳的通用判据：**`system/message` 里有没有注入 `roles\brain.md`**（与模式名/机器/目录无关）。
 *   ⇒ 路径只能靠上面三条硬证据；模式最多当"这是不是项目会话"的旁证。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, renameSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')                       // 工作台根（无人值守\）
export const MAP_FILE = process.env.DSH_PROJECT_MAP
  ? resolve(process.env.DSH_PROJECT_MAP)
  : join(ROOT, '_crew', '项目映射.json')
/** 账本证据的默认新鲜度窗口（小时）—— 超过就**不自动切**，只出红条让人选。 */
export const EVIDENCE_MAX_AGE_H = 24

const nz = (p) => String(p ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/** 这个目录**自己**是不是工作台根（`_crew` 目录或 `TASKS.md`）。 */
export function hasWorkbench (p) {
  if (!p) return false
  try { if (statSync(p).isDirectory() !== true) return false } catch { return false }
  return existsSync(join(p, '_crew')) || existsSync(join(p, 'TASKS.md'))
}

/** 读对照表（缺文件/坏文件 ⇒ 空表，不抛）。 */
export function readMap () {
  try {
    const d = JSON.parse(readFileSync(MAP_FILE, 'utf8').replace(/^\uFEFF/, ''))
    const map = d && typeof d === 'object' ? (d.map && typeof d.map === 'object' ? d.map : d) : {}
    const out = {}
    for (const [k, v] of Object.entries(map)) {
      if (k === 'at' || k === 'note' || k === 'map') continue
      if (typeof v === 'string' && v.trim()) out[nz(k)] = String(v).trim()
    }
    return { ok: true, map: out, file: MAP_FILE }
  } catch (e) {
    return { ok: !existsSync(MAP_FILE), map: {}, file: MAP_FILE, error: e ? String(e.message || e) : null }
  }
}

/** 记一行「文档目录 → 代码目录」（幂等；不动别的行）。 */
export function saveMapEntry (docPath, codePath) {
  if (!docPath || !codePath) return { ok: false, error: '两个路径都要有' }
  const cur = readMap()
  const map = { ...cur.map, [nz(docPath)]: String(codePath).trim() }
  const doc = {
    note: '文档目录 → 代码目录（面板点「改钉」时自动记；也可以手改这一行）。键＝你钉住的目录，值＝带 _crew 的工作台根。',
    at: new Date().toISOString(),
    map
  }
  try {
    mkdirSync(dirname(MAP_FILE), { recursive: true })
    const tmp = MAP_FILE + '.tmp'
    writeFileSync(tmp, JSON.stringify(doc, null, 2) + '\n', 'utf8')
    renameSync(tmp, MAP_FILE)
    return { ok: true, file: MAP_FILE, map }
  } catch (e) { return { ok: false, error: String(e?.message || e) } }
}

/** 账本里**最近一条**能反推出项目根（`envelope` 落在 `<项目>\_crew\runs\`）的调用。 */
export function latestLedgerProject (calls = []) {
  for (let i = calls.length - 1; i >= 0; i--) {
    const c = calls[i]
    const m = String(c?.envelope ?? '').match(/^(.*?)[\\/]_crew[\\/]runs[\\/]/i)
    if (!m) continue
    const p = resolve(m[1])
    const at = Date.parse(String(c.at ?? ''))
    if (!Number.isFinite(at)) continue
    return { project: p, at, role: c.role ?? null, task: c.task ?? null }
  }
  return null
}

const szTime = (ms) => {
  const d = new Date(ms)
  const p2 = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}`
}

/**
 * 定位：给一个"钉住的目录 / 会话工作区"，返回**真该读哪个目录**。
 * @returns {{input:string|null,path:string|null,by:'self'|'map'|'ledger'|'none'|'pinned',noWorkbench:boolean,
 *            evidenceAt?:number,banner?:string|null,note?:string}}
 */
export function locateProject (input, { calls = [], maxAgeH = EVIDENCE_MAX_AGE_H, now = Date.now() } = {}) {
  if (!input) return { input: null, path: null, by: 'none', noWorkbench: false, pinExists: null, reason: 'unpinned', banner: null, note: '没钉项目（跟随会话）' }
  let abs
  try { abs = resolve(String(input).trim()) } catch { abs = String(input).trim() }

  // ① 自己就是工作台根
  if (hasWorkbench(abs)) return { input: abs, path: abs, by: 'self', noWorkbench: false, banner: null, note: '钉的就是工作台根' }

  // ①b ★ 2026-10-25：用户选的往往是**工作区**（项目在它下面一层）⇒ 向下找 ≤2 层的 _crew\TASKS.md。
  //   为什么放在对照表之前：对照表是"文档目录 → 代码目录"的跨盘映射（恋爱军师那种），
  //   而"项目就在工作区里"是最常见的情况，应该先认。找不到才走映射。
  try {
    const hits = []
    const scan = (dir, depth) => {
      if (depth > 2) return
      let ents = []
      try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return }
      for (const d of ents) {
        if (!d.isDirectory()) continue
        if (d.name === 'node_modules' || d.name === '.git') continue
        const p = join(dir, d.name)
        if (hasWorkbench(p)) hits.push(p)
        else scan(p, depth + 1)
      }
    }
    scan(abs, 0)
    if (hits.length) {
      const mtimeOf = (p) => { try { return statSync(join(p, '_crew', 'TASKS.md')).mtimeMs } catch { return 0 } }
      const pick = hits.length === 1 ? hits[0] : hits.slice().sort((a, b) => mtimeOf(b) - mtimeOf(a))[0]
      return {
        input: abs, path: pick, by: 'subdir', noWorkbench: false, pinExists: true,
        banner: hits.length === 1
          ? `钉的是工作区，已自动跟随里面的项目「${baseName(pick)}」`
          : `工作区下有 ${hits.length} 个项目（${hits.map((h) => baseName(h)).join('、')}），已按最近活动选「${baseName(pick)}」`,
        note: '工作区 → 子项目（向下找 ≤2 层）'
      }
    }
  } catch { /* 扫不动就走后面的判据 */ }

  // ② 对照表
  const m = readMap().map[nz(abs)]
  if (m && hasWorkbench(m)) {
    return {
      input: abs, path: resolve(m), by: 'map', noWorkbench: false,
      banner: `钉的是「${baseName(abs)}」（没有工作台）→ 实际显示「${baseName(m)}」（依据：项目对照表 _crew\\项目映射.json）`,
      note: '按项目对照表换算'
    }
  }

  // ③ 账本证据（只在窗口内、且真带工作台时才认）
  const ev = latestLedgerProject(calls)
  if (ev && ev.project && (now - ev.at) / 3600000 <= maxAgeH && hasWorkbench(ev.project) && nz(ev.project) !== nz(abs)) {
    return {
      input: abs, path: ev.project, by: 'ledger', noWorkbench: false, evidenceAt: ev.at,
      banner: `钉的是「${baseName(abs)}」（没有工作台）→ 实际显示「${baseName(ev.project)}」（依据：账本最后一条 ${szTime(ev.at)} 在它那儿，${ev.role ?? '?'}／${ev.task ?? '?'}）`,
      note: '按账本证据换算'
    }
  }

  // ④ 没有任何证据 ⇒ 明说
  const hint = ev && wb(ev.project)
    ? `账本里最后一次真跑是「${baseName(ev.project)}」（${szTime(ev.at)}，已超过 ${maxAgeH} 小时，不自动切）`
    : '账本里也没有任何能反推出项目的调用'
  // ★ 2026-10-24（D28）：分两种 —— 目录根本不在（钉错了/盘没插）vs 目录在但没 _crew（这目录还没开工）
  let pinExists = null
  try { pinExists = existsSync(abs) } catch { pinExists = null }
  const reason = pinExists === false ? 'missing' : 'no-workbench'
  return {
    input: abs, path: abs, by: 'none', noWorkbench: true, pinExists, reason,
    banner: pinExists === false
      ? `钉的「${baseName(abs)}」**目录不存在**（钉错了，或那个盘没插上）⇒ 看板读不到活；${hint}。请改钉。`
      : `钉的「${baseName(abs)}」里没有 _crew／TASKS.md ⇒ 看板读不到活；${hint}。请钉一个工作台根，或点「改钉」。`,
    note: pinExists === false ? '钉的项目目录不存在' : '目录在，但没有工作台'
  }
}

const wb = (p) => hasWorkbench(p)
const baseName = (p) => String(p ?? '').replace(/\\+$/, '').split(/[\\/]/).filter(Boolean).pop() ?? String(p ?? '')
