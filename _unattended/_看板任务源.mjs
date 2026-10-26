/**
 * 看板任务源 —— **任务从 C 状态库里读**（施工文档 §十「看板任务从 C 读；TASKS 只对照」）
 *
 * 为什么要单列一层：`TASKS.md` 上线后只是**生成视图**。看板如果继续读它，
 * 就变成"库说 A、纸说 B"的双真相 —— 而这正是这次重构要消灭的东西。
 *
 * 纪律（照 §十「唯一出处与读取纪律」）：
 * 1. 任务状态**只从 C 状态服务读**；
 * 2. `TASKS.md` 只做**对照**：不一致时给 `stale:true` + 原因，页面显示 stale，**不切回文件**；
 * 3. C 服务不可用 ⇒ `source:'unavailable'`、`stale:true`、任务区红/未知，
 *    ⛔ **绝不退回 `TASKS.md`**（否则又是双真相）。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { StateClient, StateUnavailable } from './_状态客户端.mjs'
import { extractMachine } from './_台账视图.mjs'

/** 状态 → 计数（与看板原有字段对齐，页面不用大改） */
const MARKS = { done: 'x', doing: '>', review: '?', ready: 'r', blocked: '!', dropped: '-', pending: ' ' }

function emptyResult (why) {
  return {
    found: false,
    source: 'unavailable',
    stale: true,
    staleWhy: why,
    total: 0,
    done: 0,
    doing: [],
    ready: [],
    byStatus: {},
    tasks: [],
    view: { found: false, total: 0, mismatches: [], why }
  }
}

/**
 * 读任务（库为准 + 视图对照）。
 * @param {object} o
 * @param {string} o.project
 * @param {object} [o.client]
 * @returns {Promise<object>} 形状与看板原有 `ledgerTask` 兼容，另加 source/stale/tasks/byStatus
 */
export async function taskSource ({ project, client = null } = {}) {
  if (!project) return emptyResult('未设置当前项目')
  // ⚠️ 超时给短一点（1.5 秒）：看板刷新是**同步等它**的，C 服务真挂了也不该让页面卡 5 秒
  const c = client ?? new StateClient({ ensure: false, timeoutMs: 1500 })
  let rows
  try {
    await c.requireReady()
    rows = await c.tasks(project)
  } catch (e) {
    // fail-closed：如实报"读不到"，**不退回 TASKS.md**
    return emptyResult(e instanceof StateUnavailable
      ? `C 状态服务不可用：${e.message}（任务区按未知显示，不退回 TASKS.md）`
      : `读任务失败：${String(e?.message ?? e)}`)
  }

  const byStatus = {}
  for (const t of rows) byStatus[t.status] = (byStatus[t.status] ?? 0) + 1
  const tasks = rows.map(t => ({
    id: t.id,
    status: t.status,
    mark: MARKS[t.status] ?? ' ',
    wave: t.wave ?? null,
    role: t.assignedRole ?? t.role ?? null,
    rolePool: t.rolePool ?? [],
    goal: t.goal ?? null,
    writes: t.writes,
    depends: t.depends ?? [],
    legacy: t.legacy === true,
    version: t.version
  }))

  // 视图对照（只报告，不改判）
  const view = { found: false, total: 0, mismatches: [], why: null }
  const tasksFile = join(resolve(project), 'TASKS.md')
  if (!existsSync(tasksFile)) {
    view.why = '没有 TASKS.md（视图缺失，不影响任务状态：库才是真相）'
  } else {
    let text = ''
    try { text = readFileSync(tasksFile, 'utf8') } catch { text = '' }
    const m = extractMachine(text)
    if (!m.ok) {
      view.why = `TASKS.md 机器区段读不出：${m.why}`
    } else {
      view.found = true
      view.total = Object.keys(m.data.tasks ?? {}).length
      for (const t of tasks) {
        const v = m.data.tasks?.[t.id]
        if (!v) view.mismatches.push({ id: t.id, field: 'missing-in-view', db: t.status, view: null })
        else if (v.state !== t.status) view.mismatches.push({ id: t.id, field: 'status', db: t.status, view: v.state })
      }
      for (const id of Object.keys(m.data.tasks ?? {})) {
        if (!rows.some(t => t.id === id)) view.mismatches.push({ id, field: 'extra-in-view', db: null, view: m.data.tasks[id].state })
      }
    }
  }

  const stale = view.mismatches.length > 0 || (!view.found && view.why && /读不出/.test(view.why))
  return {
    found: true,
    source: 'state-service',
    stale,
    staleWhy: view.mismatches.length
      ? `TASKS.md 与状态库有 ${view.mismatches.length} 处不一致（视图过期，**以库为准**）`
      : (stale ? view.why : null),
    total: rows.length,
    done: byStatus.done ?? 0,
    doing: tasks.filter(t => t.status === 'doing').map(t => ({ id: t.id })),
    ready: tasks.filter(t => t.status === 'ready' || t.status === 'pending').map(t => ({ id: t.id })),
    byStatus,
    tasks,
    view
  }
}
