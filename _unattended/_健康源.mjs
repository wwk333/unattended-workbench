/**
 * 健康源 —— 把"四份健康 + 交付 + 门禁 + 契约体检"读成**一个可判真假的清单**（施工文档 §十 / §七）
 *
 * 为什么必须单独一轮：看板顶部那五个灯（交付 / 门禁+E2E / 任务 / 健康 / 契约）
 * 如果各自 `state === 'green'` 就算绿，就会出现"文件不存在也显示绿"（实测踩过）。
 * 这里统一走 `契约/信封.mjs` 的 `healthOf()`：**缺文件/缺信封/unknown/stale 一律 unknown，不当绿**。
 *
 * 纪律：
 * · 每个源都是**只读**，不在这里写任何文件；
 * · 缺文件 = `unknown` + 写明缺哪个文件（不是绿、也不是红 —— 红会把"还没生成"说成"坏了"）；
 * · `release-status` 的状态词是 blocked/ready/accepted/rejected/stale，要**映射**成灯（不硬套 green）。
 */

import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { healthOf, validateEnvelope } from './契约/信封.mjs'
import { readJsonSafe } from './契约/读.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
export const WORKBENCH = resolve(HERE, '..')

/** 七个源（四份健康 + 交付 + 门禁 + 契约体检）；`level` 说明它挂在哪个目录下 */
export const SOURCE_DEFS = Object.freeze([
  // ★ 2026-10-26 修（实测抓到的**永久未知**）：`进度看护.mjs` 把状态写在**工作台**的 `_crew/`（`const CREW = join(WS,'_crew')`），
  //   而这里原来只按**项目**目录找 ⇒ 钉住的是真实项目时，看板上的 run 健康**永远是 unknown**，
  //   明明看护在跑、状态文件也有内容。现在项目优先、找不到退回工作台，并在 `file` 里写明实际读的是哪份。
  { id: 'run-health', label: 'run 健康', writer: '进度看护.mjs', level: 'project', rel: ['_crew', '看护状态.json'], fallbackLevel: 'workbench' },
  { id: 'card-health', label: '卡片健康', writer: '_监控.mjs', level: 'project', rel: ['_crew', '卡片看护.json'] },
  { id: 'longlive', label: '长命资源', writer: '长命资源巡检.mjs', level: 'workbench', rel: ['_crew', '长命资源状态.json'] },
  { id: 'wake', label: '唤醒结果', writer: '_唤醒.mjs', level: 'project', rel: ['_crew', '唤醒状态.json'] },
  { id: 'release', label: '交付放行', writer: '交付门.mjs', level: 'project', rel: ['_crew', 'release-status.json'] },
  { id: 'gate', label: '门禁', writer: '门禁.mjs', level: 'project', rel: ['_crew', 'gate', 'gate-result.json'] },
  { id: 'contract', label: '契约体检', writer: '契约体检.mjs', level: 'workbench', rel: ['_crew', 'gate', 'contract-check.json'] }
])

/** 交付状态词 → 灯。accepted 才是绿；ready 只是"等你验收"（黄）；blocked/rejected/stale 红 */
export function releaseLamp (state) {
  if (state === 'accepted') return 'green'
  if (state === 'ready') return 'yellow'
  if (state === 'blocked' || state === 'rejected' || state === 'stale') return 'red'
  return 'unknown'
}

/** 门禁产物 → 灯：ok 且非 degraded 才绿；degraded 只算未知（不许冒充绿） */
export function gateLamp (obj) {
  if (!obj || typeof obj !== 'object') return 'unknown'
  if (obj.degraded === true) return 'unknown'
  if (obj.ok === true) return 'green'
  return 'red'
}

function lampOf (def, obj) {
  if (!obj) return { state: 'unknown', why: '文件不存在或不是合法 JSON' }
  if (def.id === 'release') {
    return { state: releaseLamp(obj.state), why: obj.state === 'ready' ? '机器放行，等用户验收（不是已交付）' : (obj.state === 'stale' ? '验收后证据又变了' : null) }
  }
  if (def.id === 'gate') return { state: gateLamp(obj), why: obj.degraded === true ? 'degraded 不得当绿' : null }
  if (def.id === 'contract') return { state: obj.ok === true ? 'green' : 'red', why: obj.ok === true ? null : '契约体检失败' }
  const h = healthOf(obj)
  return { state: h, why: h === 'unknown' ? '缺信封 / unknown / stale' : null }
}

/**
 * 读全部健康源。
 * @param {object} o
 * @param {string} [o.project] 项目目录（project 级源用）
 * @param {string} [o.workbench] 工作台根（workbench 级源用）
 * @returns {{ sources:object[], stale:boolean, summary:{green:number,yellow:number,red:number,unknown:number}, allGreen:boolean, unknownIds:string[], redIds:string[] }}
 */
export function readHealthSources ({ project = null, workbench = WORKBENCH } = {}) {
  const sources = []
  for (const def of SOURCE_DEFS) {
    const base = def.level === 'project' ? (project ? resolve(project) : null) : resolve(workbench)
    if (!base) {
      sources.push({ id: def.id, label: def.label, writer: def.writer, file: null, exists: false, state: 'unknown', stale: false, at: null, why: '没有项目（未钉住）' })
      continue
    }
    // 候选路径：主根 → 另一个根（run 健康的写方在工作台、读方按项目找，两边都可能有）
    const cands = [join(base, ...def.rel)]
    if (def.fallbackLevel) {
      const alt = def.fallbackLevel === 'project' ? (project ? resolve(project) : null) : resolve(workbench)
      if (alt) cands.push(join(alt, ...def.rel))
    }
    // ★ 挑"**信封合格**的那一份"，都不合格就挑主根那份（并如实报 unknown + 原因）
    //   起因：项目里留着一份**旧格式**看护状态（没 source），按项目优先会一直是 unknown，
    //   而工作台那份是新的、合格的 —— 读方得会挑，而不是死认路径。
    let file = cands[0]
    let obj = null
    let exists = false
    let picked = null
    for (const c of cands) {
      if (!existsSync(c)) continue
      exists = true
      const o = readJsonSafe(c)
      const good = Boolean(o) && validateEnvelope(o).ok
      if (!picked || (good && !picked.good)) { picked = { file: c, obj: o, good }; file = c; obj = o }
      if (good) break
    }
    const lamp = lampOf(def, obj)
    sources.push({
      id: def.id,
      label: def.label,
      writer: def.writer,
      file,
      exists,
      state: lamp.state,
      why: lamp.why ?? (exists && !obj ? 'JSON 读不出' : null),
      stale: obj?.stale === true,
      at: typeof obj?.at === 'string' ? obj.at : null
    })
  }
  const summary = { green: 0, yellow: 0, red: 0, unknown: 0 }
  for (const s of sources) summary[s.state] = (summary[s.state] ?? 0) + 1
  return {
    sources,
    // board-data 的 stale = "有源明确过期"（unknown 不算 stale，但也不算绿）
    stale: sources.some(s => s.stale === true),
    summary,
    allGreen: sources.every(s => s.state === 'green'),
    unknownIds: sources.filter(s => s.state === 'unknown').map(s => s.id),
    redIds: sources.filter(s => s.state === 'red').map(s => s.id)
  }
}

/** 一句话（给看板顶部/日志）：**绝不把 unknown 说成绿** */
export function describeHealth (h) {
  if (!h) return '健康：unknown'
  const { summary } = h
  const parts = []
  if (summary.green) parts.push(`绿 ${summary.green}`)
  if (summary.yellow) parts.push(`黄 ${summary.yellow}`)
  if (summary.red) parts.push(`红 ${summary.red}`)
  if (summary.unknown) parts.push(`未知 ${summary.unknown}`)
  return `健康：${parts.join(' / ') || 'unknown'}${h.unknownIds.length ? `（未知：${h.unknownIds.join('、')}）` : ''}`
}
