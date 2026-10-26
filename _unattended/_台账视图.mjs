/**
 * 台账视图 —— `TASKS.md` 的**唯一渲染器**（施工文档 §三「TASKS.md 是生成视图」/ §八.7）
 *
 * ## 为什么把它从 `台账.mjs` 里摘出来
 * 以前 `TASKS.md` 由 `台账.mjs` 的 `writeTasks()` 直接拼、直接写，所以它是**第二个状态源**：
 * 人改一行、脚本改一行，库里和纸上立刻不一致，而且没有任何一处能机器回答"哪个才是真的"。
 *
 * 现在的分工：
 *   · **真相** = C 状态库（`_crew/state/crew.db`）；
 *   · **视图** = 本文件渲染的 `TASKS.md`（带 `<!-- MACHINE -->` 机器区段，含 `generatedFrom` + `snapshotId`）；
 *   · 写文件的人只有两处：`台账.mjs`（先落库、再渲染）与 `_TASKS生成.mjs`（从库重渲染/自愈）。
 *
 * ## 三条不能丢的旧行为（都是从真实数据事故里换来的）
 * 1. **认不出的行原样保留**在"未识别"区 —— 绝不因为一次 `set` 就物理删掉手写的卡；
 * 2. **机器区段的 JSON 里 `-->` 必须转义**成 `\u003e`，否则区段提前收口；
 * 3. `srcHash` 用"定稿正文"算，用来判"正文后来被人动过没有"。
 *
 * 本文件是**纯模块**（没有顶层副作用），能被入口脚本 import 而不触发任何命令。
 */

import { createHash } from 'node:crypto'

export const STATUSES = Object.freeze(['pending', 'ready', 'doing', 'review', 'done', 'blocked', 'dropped'])
export const STATUS_MARK = Object.freeze({ pending: ' ', ready: 'r', doing: '>', review: '?', done: 'x', blocked: '!', dropped: '-' })

export const nowText = () => new Date().toISOString().replace('T', ' ').slice(0, 19)

const MACHINE_RE = /<!--\s*MACHINE\b[\s\S]*?-->/g
const MACHINE_RE_LAST = /<!--\s*MACHINE\b[\s\S]*?-->/g
export const sha1 = (s) => createHash('sha1').update(String(s)).digest('hex')

/**
 * 找**真正的**机器区段。
 * ★ 2026-10-26 修（实测抓到的坑）：模板抬头里有一句"机器区段（`<!-- MACHINE … -->`）在文件末尾"，
 *   原来用**第一个**匹配 ⇒ 抓到的就是那句说明里的半截（`…`），JSON 解析必然失败。
 *   口径：区段**永远在文件末尾** ⇒ 取**最后一个**能解析成 `kind:"tasks"` 的块。
 * @returns {{ found:boolean, start:number, end:number, data:object|null, why:string|null, raw:string|null }}
 */
export function findMachineBlock (text) {
  const s = String(text ?? '')
  const hits = [...s.matchAll(MACHINE_RE_LAST)]
  if (!hits.length) return { found: false, start: -1, end: -1, data: null, why: '机器区段不存在（TASKS.md 末尾没有 <!-- MACHINE … -->）', raw: null }
  for (let i = hits.length - 1; i >= 0; i--) {
    const raw = hits[i][0]
    try {
      const data = JSON.parse(raw.replace(/^<!--\s*MACHINE\b/, '').replace(/-->$/, '').trim())
      if (data && typeof data === 'object' && data.kind === 'tasks') {
        return { found: true, start: hits[i].index, end: hits[i].index + raw.length, data, why: null, raw }
      }
    } catch { /* 试更靠前的那个 */ }
  }
  const last = hits[hits.length - 1]
  return { found: false, start: last.index, end: last.index + last[0].length, data: null, why: '机器区段 JSON 解析失败或形状不对（kind 应为 "tasks"）', raw: last[0] }
}

/** 摘掉机器区段（读任何"正文逻辑"之前都要先过它，免得区段内容混进正文判断） */
export const stripMachine = (text) => {
  const s = String(text ?? '')
  const b = findMachineBlock(s)
  if (!b.found && b.start < 0) return s.replace(/\s+$/, '') + '\n'
  return (s.slice(0, b.start) + s.slice(b.end)).replace(/\s+$/, '') + '\n'
}

export function extractMachine (text) {
  const b = findMachineBlock(text)
  if (!b.found) return { ok: false, why: b.why ?? '机器区段读不出' }
  return { ok: true, data: b.data }
}

/**
 * 机器区段的数据体。
 * ★ 新增 `generatedFrom` 与 `snapshotId`（§八.7「状态文档必须带 generatedFrom 和 snapshotId，否则视为 stale」）。
 *   老消费方只读 `tasks/unmatched/suspects/srcHash`，加字段不破坏它们。
 */
export function machineDoc (tasks, unmatched, prose, suspects = [], { name = null, generatedFrom = '_crew/state/crew.db', snapshotId = null } = {}) {
  const map = {}
  for (const t of tasks) {
    map[t.id] = {
      state: t.status,
      wave: t.wave || '—',
      role: t.role,
      level: t.level ?? null,
      deps: t.depends,
      deliverables: t.deliverables,
      assignedRole: t.assignedRole ?? null,
      rolePool: t.rolePool ?? [],
      writes: t.writes ?? null,
      legacy: t.legacy === true
    }
  }
  return {
    schema: 1,
    kind: 'tasks',
    project: name,
    at: nowText(),
    atIso: new Date().toISOString(),
    generatedFrom,
    snapshotId,
    srcHash: sha1(prose),
    tasks: map,
    unmatched: unmatched.slice(0, 200),
    suspects: suspects.slice(0, 50)
  }
}

/** 认不出的行写回时的统一抬头（人一眼能看懂"这些没被机器认下"） */
export const UNMATCHED_HEAD = '## ⚠️ 未识别（机器没认下的任务行 · 别删，改格式就能被认回）'

/** 一条任务 → 一行 Markdown（形状与历史完全一致，人眼熟悉、正则也认） */
export function formatLine (t) {
  const dep = t.depends?.length ? t.depends.join(',') : '无'
  const del = t.deliverables?.length ? t.deliverables.join(',') : '无'
  const acc = t.accept?.length ? t.accept.join(',') : '无'
  const lv = t.level ? ` · 级:${t.level}` : ''
  return `- [${STATUS_MARK[t.status]}] ${t.id} · ${t.wave || '—'} · ${t.role}${lv} · ${t.goal} · 依赖:${dep} · 交付:${del} · 验收:${acc}`
}

/**
 * 渲染整份 `TASKS.md`。
 *
 * @param {object} o
 * @param {object[]} o.tasks        当前任务（**来自状态库**）
 * @param {string|null} o.prevText  上一次的文件内容（用来沿用抬头/波次汇总、保住未识别行）
 * @param {string|null} o.headerText 显式抬头（init/--force 时用）
 * @param {string} o.name           项目名（写进机器区段）
 * @param {string[]} o.unmatched    解析器给出的未识别行
 * @param {string[]} o.suspects     像卡但没写勾选框的行
 * @param {string} [o.template]     没有任何旧文件时用的模板（含 `## 任务` 与 `## 波次汇总` 两段）
 * @param {string|null} [o.snapshotId] 生成时的快照
 * @returns {{ full: string, prose: string, block: string, doc: object }}
 */
export function renderTasksView ({ tasks, prevText = null, headerText = null, name = null, unmatched = [], suspects = [], template = '', snapshotId = null, generatedFrom = '_crew/state/crew.db' }) {
  const prev = prevText !== null ? stripMachine(prevText) : null
  const base = prev ?? template
  const head = headerText ?? ((base.split('## 任务')[0] ?? '') + '## 任务\n')
  // 旧文件里 `## 波次汇总` 前缀可能被拼过两遍（历史 bug），这里顺手自愈
  const tailRest = (base.split('## 波次汇总')[1] ?? '').replace(/^(?:#+\s*波次汇总\s*)+/, '')
  const tail = '## 波次汇总' + tailRest
  const body = tasks.length
    ? tasks.map(formatLine).join('\n') + '\n'
    : '<!-- 还没有任务：用 台账.mjs add 加 -->\n'

  // ★ 保命：`## 任务` 区段里任何"机器认不出"的非任务行，原样搬进"未识别"区。
  //   这一段是幂等的（上一轮搬进去的行也在区段里 ⇒ 会再次被收集，不会越写越多）。
  const region = (base.split('## 任务')[1] ?? '').split('## 波次汇总')[0]
  const regionKept = region.split(/\r?\n/).map(s => s.trim())
    .filter(l => l && !/^<!--/.test(l) && !/^>/.test(l) && l !== UNMATCHED_HEAD && !/^-\s*\[.\]/.test(l))
    .map(l => l.replace(/(?:\s*<!--\s*⚠️\s*未识别\s*-->)+$/, '').trim())
    .filter(Boolean)
  const kept = [...new Set([...unmatched, ...regionKept])]
  const unmatchBlock = kept.length
    ? '\n' + UNMATCHED_HEAD + '\n\n'
      + '> 这些行**机器认不出**（多半是手写/粘贴时格式偏了：段间少了空格、用了全角冒号、或漏了 `验收:` 段）。\n'
      + '> 它们**不影响上面正常任务**；改回标准形状（`- [ ] T9 · W1 · coder-a · 目标 · 依赖:无 · 交付:a.ts · 验收:跑通`）就会被认回。\n\n'
      + kept.map(l => l + '  <!-- ⚠️ 未识别 -->').join('\n') + '\n'
    : ''

  const prose = (head + '\n' + body + unmatchBlock + '\n' + tail).replace(/\s+$/, '') + '\n'
  const doc = machineDoc(tasks, kept, prose, suspects, { name, generatedFrom, snapshotId })
  // JSON 里的 `-->` 一律写成 `\u003e`（JSON.parse 会还原）：区段用 `-->` 收口，数据里冒出它就提前截断
  const block = `<!-- MACHINE\n${JSON.stringify(doc).replace(/-->/g, '--\\u003e')}\n-->`
  return { full: prose + '\n' + block + '\n', prose, block, doc, kept }
}

/**
 * 一致性判定：文件里的机器区段 vs 状态库里的任务。
 * 返回 `{ ok, reason, mismatches[] }` —— 体检/看板用它显示 `stale`，**不自己复算**。
 */
export function compareView (fileText, dbTasks, { project = null } = {}) {
  const m = extractMachine(fileText)
  if (!m.ok) return { ok: false, reason: m.why, mismatches: [] }
  if (project && m.data.project && m.data.project !== project.split(/[\\/]/).pop()) {
    return { ok: false, reason: `机器区段的 project（${m.data.project}）与当前项目不符`, mismatches: [] }
  }
  const proseNow = stripMachine(fileText)
  if (m.data.srcHash && m.data.srcHash !== sha1(proseNow)) {
    return { ok: false, reason: '正文被手改过（srcHash 对不上）', mismatches: [] }
  }
  if (!m.data.generatedFrom) {
    return { ok: false, reason: '机器区段缺 generatedFrom ⇒ 视为 stale（§八.7）', mismatches: [] }
  }
  const mismatches = []
  const seen = new Set()
  for (const t of dbTasks) {
    seen.add(t.id)
    const v = m.data.tasks?.[t.id]
    if (!v) { mismatches.push({ id: t.id, field: 'missing-in-view', db: t.status, view: null }); continue }
    if (v.state !== t.status) mismatches.push({ id: t.id, field: 'status', db: t.status, view: v.state })
    const a = [...(t.deliverables ?? [])].sort().join(',')
    const b = [...(v.deliverables ?? [])].sort().join(',')
    if (a !== b) mismatches.push({ id: t.id, field: 'deliverables', db: t.deliverables, view: v.deliverables })
  }
  for (const id of Object.keys(m.data.tasks ?? {})) {
    if (!seen.has(id)) mismatches.push({ id, field: 'extra-in-view', db: null, view: m.data.tasks[id].state })
  }
  return { ok: mismatches.length === 0, reason: mismatches.length ? `视图与状态库有 ${mismatches.length} 处不一致` : null, mismatches }
}
