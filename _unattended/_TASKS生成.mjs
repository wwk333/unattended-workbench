#!/usr/bin/env node
/**
 * TASKS.md 生成器 —— 把 C 状态库导成生成视图（施工文档 §三 / §八.7）
 *
 * **唯一真相是库，不是文件。** 这个脚本两种用法：
 *   ① 被 `台账.mjs` 调用（`syncTasksToState()`）：先把变更落库，再渲染文件；
 *   ② 自己跑（`--write`）：从库重渲染，用来自愈"被手改坏"的视图。
 *
 * 用法：
 *   node _TASKS生成.mjs --project <P> --write            # 库 ⇒ TASKS.md
 *   node _TASKS生成.mjs --project <P> --check            # 视图与库是否一致（不一致 exit 1）
 *   node _TASKS生成.mjs --project <P> --print            # 只打印，不写
 *   node _TASKS生成.mjs --project <P> --check --json     # 机器可读
 *
 * 铁律：
 *   · 服务不可用 ⇒ **fail-closed**（exit 3），不退回"直接写文件"（那就又是两个真相）；
 *   · 渲染只有 `_台账视图.mjs` 一处实现，本文件只管"从库取数 + 落盘"。
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs'
import { transitionPath } from './契约/枚举.mjs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { renderTasksView, compareView, stripMachine } from './_台账视图.mjs'
import { StateClient, StateUnavailable, StateRejected } from './_状态客户端.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))

export const EMPTY_TEMPLATE = `# 任务台账（生成视图 · 由 C 状态库导出）

> ⚠️ 本文件是**生成视图**：状态真相在 \`_crew/state/crew.db\`（C 状态服务）。
> 手改这里不会改状态；下次生成会被覆盖。要改状态用 \`台账.mjs set\` 或状态服务 API。
> 机器区段（\`<!-- MACHINE … -->\`）在文件末尾，只由生成器写。

## 任务

<!-- 还没有任务：用 台账.mjs add 加 -->

## 波次汇总

> 生成时自动汇总；这里留给人看。
`

/** 台账形态（`台账.mjs` 的 task 对象）→ 状态服务的入参 */
export function toStateTask (project, t) {
  return {
    project,
    id: t.id,
    wave: t.wave || null,
    role: t.role || null,
    level: t.level ?? null,
    goal: t.goal ?? null,
    deliverables: t.deliverables ?? [],
    depends: t.depends ?? [],
    accept: t.accept ?? [],
    writes: t.writes === undefined ? undefined : t.writes,
    resources: t.resources ?? [],
    rolePool: t.rolePool ?? [],
    status: t.status ?? 'pending'
  }
}

/** 状态库的 task 行 → 台账形态（渲染器吃这个） */
export function fromStateTask (row) {
  return {
    id: row.id,
    status: row.status,
    wave: row.wave ?? '',
    role: row.role ?? '',
    level: row.level ?? null,
    goal: row.goal ?? '',
    depends: row.depends ?? [],
    deliverables: row.deliverables ?? [],
    accept: row.accept ?? [],
    writes: row.writes,
    resources: row.resources ?? [],
    rolePool: row.rolePool ?? [],
    assignedRole: row.assignedRole ?? null,
    legacy: row.legacy === true
  }
}

/**
 * 把一批台账任务**落库**（这是 `台账.mjs` 写文件之前的必经一步）。
 * 返回库里回读到的行（渲染请用它们，不要用入参 —— 那样才叫"文件是库的投影"）。
 *
 * @throws {StateUnavailable} 服务不在 ⇒ 调用方必须停手（fail-closed）
 */
export async function syncTasksToState ({ project, tasks, client = null }) {
  const c = client ?? new StateClient({ ensure: true })
  await c.requireReady()
  const existing = new Map((await c.tasks(project)).map(t => [t.id, t]))
  for (const t of tasks) {
    const payload = toStateTask(project, t)
    const cur = existing.get(t.id)
    if (!cur) {
      await c.upsertTask(payload, { idempotencyKey: `upsert-${project}-${t.id}-${Date.now()}` })
      existing.set(t.id, await c.task(project, t.id))
      continue
    }
    // 定义字段先更新（这会把 version +1），状态再用**新** version 改
    const fresh = await c.upsertTask(payload, { idempotencyKey: `upsert-${project}-${t.id}-${Date.now()}` })
    if (fresh.status !== t.status) {
      // ★ 2026-10-26：状态机要求 pending→ready→doing，**一步到位会被服务端拒**（真项目首跑就卡在这）。
      //   这里按合法路径分步走；不可达仍然抛错，不许偷偷改成别的状态。
      const path = transitionPath('task', fresh.status, t.status)
      if (!path) {
        throw new StateRejected(409, `非法状态迁移：${fresh.status} → ${t.status}（找不到合法路径）`, 'transitionPath', { from: fresh.status, to: t.status })
      }
      let ver = fresh.version
      for (const step of path) {
        const moved = await c.setTaskStatus({
          project,
          id: t.id,
          to: step,
          expectedVersion: ver,
          source: '台账.mjs',
          idempotencyKey: `sync-${project}-${t.id}-${ver}-${step}`
        })
        ver = moved?.version ?? ver + 1
      }
    }
  }
  return (await c.tasks(project)).map(fromStateTask)
}

/** 从状态库读成台账形态（渲染/对照用） */
export async function readStateTasks ({ project, client = null }) {
  const c = client ?? new StateClient({ ensure: true })
  await c.requireReady()
  return (await c.tasks(project)).map(fromStateTask)
}

/** 生成并落盘（原子替换：先写临时文件再 rename，别让看板读到半个文件） */
export async function generateView ({ project, client = null, file = null, name = null, template = EMPTY_TEMPLATE, snapshotId = null, quiet = false }) {
  const target = file ?? join(project, 'TASKS.md')
  const prevText = existsSync(target) ? readFileSync(target, 'utf8') : null
  const tasks = await readStateTasks({ project, client })
  const rendered = renderTasksView({
    tasks,
    prevText,
    name: name ?? project.split(/[\\/]/).pop(),
    template,
    snapshotId,
    generatedFrom: '_crew/state/crew.db'
  })
  mkdirSync(dirname(target), { recursive: true })
  const tmp = `${target}.tmp-${process.pid}`
  writeFileSync(tmp, rendered.full, 'utf8')
  renameSync(tmp, target)
  if (!quiet) console.log(`[TASKS生成] 已写 ${target}（${tasks.length} 张卡）`)
  return { file: target, tasks: tasks.length, doc: rendered.doc }
}

/** 对照：文件里的机器区段 vs 状态库 */
export async function checkView ({ project, client = null, file = null }) {
  const target = file ?? join(project, 'TASKS.md')
  if (!existsSync(target)) return { ok: false, reason: `没有 TASKS.md：${target}`, mismatches: [] }
  const text = readFileSync(target, 'utf8')
  const tasks = await readStateTasks({ project, client })
  const r = compareView(text, tasks, { project })
  return { ...r, file: target, tasks: tasks.length }
}

// ---------------------------------------------------------------- CLI

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const argv = process.argv.slice(2)
  const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
  const has = n => argv.includes('--' + n)
  const project = opt('project') ? resolve(opt('project')) : null
  if (!project) { console.error('用法：node _TASKS生成.mjs --project <目录> [--write|--check|--print] [--json]'); process.exit(2) }
  const client = new StateClient({ ensure: true })
  try {
    if (has('check')) {
      const r = await checkView({ project, client })
      if (has('json')) console.log(JSON.stringify(r, null, 2))
      else if (r.ok) console.log('[TASKS生成] 视图与状态库一致')
      else {
        console.error(`[TASKS生成] ❌ ${r.reason}`)
        for (const m of r.mismatches.slice(0, 10)) console.error(`   ${m.id}: ${m.field} 库=${JSON.stringify(m.db)} 视图=${JSON.stringify(m.view)}`)
      }
      process.exit(r.ok ? 0 : 1)
    }
    if (has('print')) {
      const tasks = await readStateTasks({ project, client })
      const target = join(project, 'TASKS.md')
      const prevText = existsSync(target) ? readFileSync(target, 'utf8') : null
      const r = renderTasksView({ tasks, prevText, name: project.split(/[\\/]/).pop(), template: EMPTY_TEMPLATE })
      process.stdout.write(r.full)
      process.exit(0)
    }
    const r = await generateView({ project, client })
    if (has('json')) console.log(JSON.stringify(r, null, 2))
    process.exit(0)
  } catch (e) {
    if (e instanceof StateUnavailable) {
      console.error(`[TASKS生成] ❌ 状态服务不可用：${e.message}`)
      console.error('            → 先跑 `node 确保状态服务.mjs`。**fail-closed**：不会退回直接写文件。')
      process.exit(3)
    }
    console.error(`[TASKS生成] ❌ ${e.message}`)
    process.exit(1)
  }
}
