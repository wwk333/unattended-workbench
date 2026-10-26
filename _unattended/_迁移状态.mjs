#!/usr/bin/env node
/**
 * 旧状态迁移 —— 把 `TASKS.md` / `_crew/running/*.json` / 旧收据导进 C 状态库（施工文档 §三）
 *
 * ## 三条口径（一条都不能改）
 * 1. **迁移前先备份**：`TASKS.md`、`_crew/running`、`_crew/ledger.json` 整份拷到
 *    `_crew/backup/迁移-<stamp>/`，并在报告里写清路径。
 * 2. **缺收据标 `legacy-unknown`，不补造**：能从 `verdict.json` 读到真实终态就用它；
 *    读不到就 `legacy=1` + `aborted/legacy-unknown`，⛔ 绝不写 `completed` 蒙过去。
 * 3. **迁移前后任务数必须相等**：不等就报错并**回滚**（把备份拷回去），不许"少了几张卡也继续"。
 *
 * ## 用法
 *   node _迁移状态.mjs --project <P> [--dry-run]
 *   node _迁移状态.mjs --project <P> --project <P2>
 *   node _迁移状态.mjs --all                      # workspaces/* 下所有带 TASKS.md 的项目
 *   node _迁移状态.mjs --project <P> --report <输出.json>
 *
 * 幂等：重复跑不会造出重复卡/重复 run（run_id 由 stamp + 项目名确定；task 是 upsert）。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { extractMachine, STATUSES, STATUS_MARK } from './_台账视图.mjs'
import { StateClient, StateUnavailable } from './_状态客户端.mjs'
import { generateView } from './_TASKS生成.mjs'
import { pidAlive } from './_状态库.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WORKBENCH = resolve(HERE, '..')

const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const has = n => argv.includes('--' + n)

/** 严格任务行（与 `台账.mjs` 的 `LINE_RE` 同形）：`- [x] ID · 波次 · 角色 · 目标 · 依赖:… · 交付:… · 验收:…` */
const LINE_RE = /^- \[(.)\]\s+(\S+)\s+·\s*([^·]*)\s*·\s*([^·]*)\s*·\s*([^·]*)\s*·\s*依赖:([^·]*)\s*·\s*交付:([^·]*)\s*·\s*验收:(.*)$/
/** 可选 `级:L2` 段（可在行内任意位置，独立判） */
const LEVEL_RE = /·\s*级:([A-Za-z0-9+]+)\s*·/
const unLevel = (line) => String(line).replace(LEVEL_RE, ' · ')

/** 从正文行里抽"人类写的那些字段"（goal / accept / depends / deliverables） */
function parseProseLines (text) {
  const map = new Map()
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim()
    if (!/^-\s*\[.\]\s/.test(line)) continue
    const lv = LEVEL_RE.exec(line)
    const m = LINE_RE.exec(unLevel(line))
    if (!m) continue
    map.set(m[2].trim(), {
      id: m[2].trim(),
      status: Object.entries(STATUS_MARK).find(([, v]) => v === m[1])?.[0] ?? 'pending',
      wave: m[3].trim(),
      role: m[4].trim(),
      level: lv ? lv[1] : null,
      goal: m[5].trim(),
      depends: m[6].trim() === '无' ? [] : m[6].split(',').map(s => s.trim()).filter(Boolean),
      deliverables: m[7].trim() === '无' ? [] : m[7].split(',').map(s => s.trim()).filter(Boolean),
      accept: m[8].trim() === '无' ? [] : m[8].split(',').map(s => s.trim()).filter(Boolean)
    })
  }
  return map
}

/**
 * 从 TASKS.md 抽任务：优先机器区段（机器可读），退到行正则（老文件没有区段时才用）。
 *
 * ★ 两条来源要**合并**，不能只信机器区段：机器区段历史上只存了
 *   `state/wave/role/level/deps/deliverables`，**没有 goal / accept**。
 *   只按区段导入会把"目标"和"验收命令"丢成空（实测迁移 `_演练8` 丢过一次）。
 *   所以：状态与结构以区段为准，人写的 `goal/accept` 从正文行补。
 */
export function parseLegacyTasks (text) {
  const prose = parseProseLines(text)
  const m = extractMachine(text)
  if (m.ok && m.data.tasks) {
    const out = []
    for (const [id, v] of Object.entries(m.data.tasks)) {
      const p = prose.get(id)
      out.push({
        id,
        status: STATUSES.includes(v.state) ? v.state : 'pending',
        wave: v.wave && v.wave !== '—' ? v.wave : (p?.wave ?? ''),
        role: v.role ?? p?.role ?? '',
        level: v.level ?? p?.level ?? null,
        goal: v.goal ?? p?.goal ?? '',
        depends: v.deps ?? p?.depends ?? [],
        deliverables: v.deliverables ?? p?.deliverables ?? [],
        accept: v.accept ?? p?.accept ?? [],
        fromMachine: true,
        statusInvalid: !STATUSES.includes(v.state)
      })
    }
    return { tasks: out, source: 'machine', unmatched: m.data.unmatched ?? [], suspects: m.data.suspects ?? [] }
  }
  // 退路：只有正文行（老文件没有机器区段）
  return { tasks: [...prose.values()].map(t => ({ ...t, fromMachine: false })), source: 'regex', unmatched: [], suspects: [] }
}

/** 旧收据：`_crew/runs/<stamp>/verdict.json` */
export function readLegacyVerdicts (project) {
  const dir = join(project, '_crew', 'runs')
  if (!existsSync(dir)) return []
  const out = []
  for (const st of readdirSync(dir).sort()) {
    const f = join(dir, st, 'verdict.json')
    if (!existsSync(f)) continue
    try {
      const j = JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
      out.push({ stamp: st, path: f, verdict: j })
    } catch (e) {
      out.push({ stamp: st, path: f, verdict: null, parseError: e.message })
    }
  }
  return out
}

/** 旧残留：`_crew/running/*.json`（进程死后留下的运行态） */
export function readLegacyRunning (project) {
  const dir = join(project, '_crew', 'running')
  if (!existsSync(dir)) return []
  const out = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    const p = join(dir, f)
    try {
      const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
      out.push({ file: f, path: p, data: j })
    } catch (e) {
      out.push({ file: f, path: p, data: null, parseError: e.message })
    }
  }
  return out
}

function stamp () {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

/** 备份三样东西（TASKS.md / running / ledger.json），返回备份目录 */
export function backupLegacy (project, tag = stamp()) {
  const dir = join(project, '_crew', 'backup', `迁移-${tag}`)
  mkdirSync(dir, { recursive: true })
  const copied = []
  const take = (rel) => {
    const src = join(project, rel)
    if (!existsSync(src)) return
    const dst = join(dir, rel.replace(/[\\/]/g, '__'))
    cpSync(src, dst, { recursive: true })
    copied.push(dst)
  }
  take('TASKS.md')
  take(join('_crew', 'running'))
  take(join('_crew', 'ledger.json'))
  take(join('_crew', 'tasks'))
  return { dir, copied }
}

/** 迁一个项目。返回报告对象。 */
export async function migrateProject (project, { client, dryRun = false, backupTag = null, regenerate = true } = {}) {
  const c = client ?? new StateClient({ ensure: true })
  const name = basename(project)
  const tasksFile = join(project, 'TASKS.md')
  const report = { schema: 1, kind: 'migrate-report', at: new Date().toISOString(), source: '_迁移状态.mjs', project, dryRun, steps: [], warnings: [], errors: [] }
  if (!existsSync(tasksFile)) {
    report.errors.push(`没有 TASKS.md：${tasksFile}`)
    return report
  }
  const before = parseLegacyTasks(readFileSync(tasksFile, 'utf8'))
  const verdicts = readLegacyVerdicts(project)
  const running = readLegacyRunning(project)
  report.counts = { tasksInFile: before.tasks.length, duplicatesInFile: before.tasks.length - new Set(before.tasks.map(t => t.id)).size, verdicts: verdicts.length, staleRunning: running.length }

  if (!dryRun) {
    const bk = backupLegacy(project, backupTag ?? stamp())
    report.backup = bk
    report.steps.push({ step: 'backup', dir: bk.dir, files: bk.copied.length })
  } else {
    report.steps.push({ step: 'backup', skipped: 'dry-run' })
  }

  await c.requireReady()

  // ---- ① 任务：先按文件里的定义 upsert，再逐张对齐状态
  const dedup = new Map()
  for (const t of before.tasks) if (!dedup.has(t.id)) dedup.set(t.id, t)
  const taskList = [...dedup.values()]
  if (taskList.length !== before.tasks.length) {
    report.warnings.push(`文件里有 ${before.tasks.length - taskList.length} 行重复 ID（已按第一次出现收敛，库是 PK 唯一）`)
  }

  if (!dryRun) {
    // ★ 幂等键必须**带内容指纹**：只用 `migrate-<项目>-<ID>` 的话，第二次迁移（内容变了）
    //   会命中第一次的幂等记录、直接把旧响应回放给你，**新的 goal/accept 永远写不进去**
    //   （实测踩过：还原备份后重迁，目标字段还是空的）。同内容 ⇒ 同键 ⇒ 重放无害；内容变 ⇒ 新键 ⇒ 真更新。
    const contentKey = (t) => createHash('sha256').update(JSON.stringify([t.wave, t.role, t.level, t.goal, t.deliverables, t.depends, t.accept, t.status])).digest('hex').slice(0, 16)
    for (const t of taskList) {
      // 先建成 pending（不会触发非法迁移），再走正规迁移到文件里的状态
      await c.upsertTask({
        project, id: t.id, wave: t.wave || null, role: t.role || null, level: t.level,
        goal: t.goal, deliverables: t.deliverables, depends: t.depends, accept: t.accept,
        status: 'pending', legacy: true
      }, { idempotencyKey: `migrate-${name}-${t.id}-${contentKey(t)}` })
    }
    let moved = 0
    for (const t of taskList) {
      const cur = await c.task(project, t.id)
      if (cur.status === t.status) continue
      // 迁移期允许"直接落到文件里的状态"：这是**导入**，不是运行时状态变更，所以按最短合法路径推
      const path = shortestTaskPath(cur.status, t.status)
      if (!path) { report.warnings.push(`${t.id}: 无法从 ${cur.status} 迁到 ${t.status}（跳过状态，保留 ${cur.status}）`); continue }
      let version = cur.version
      for (const to of path) {
        const r = await c.setTaskStatus({ project, id: t.id, to, expectedVersion: version, source: '_迁移状态.mjs', evidence: { migratedFrom: 'TASKS.md', target: t.status }, idempotencyKey: `migrate-${name}-${t.id}-${to}` })
        version = r.version
        moved++
      }
    }
    report.steps.push({ step: 'tasks', imported: taskList.length, transitions: moved })
  }

  // ---- ② 旧收据 → run（缺 state 的标 aborted/legacy-unknown，绝不补 completed）
  let runsImported = 0
  if (!dryRun) {
    for (const v of verdicts) {
      const runId = `legacy-${name}-${v.stamp}`
      const existing = await c.runs({ project, state: null }).catch(() => [])
      if (existing.some(r => r.runId === runId)) continue
      const st = v.verdict?.state
      const state = ['completed', 'aborted', 'failed'].includes(st) ? st : 'aborted'
      const reason = ['completed', 'aborted', 'failed'].includes(st) ? (v.verdict?.reason ?? 'legacy-import') : `legacy-unknown${v.parseError ? `（解析失败：${v.parseError.slice(0, 60)}）` : ''}`
      await c.startRun({ runId, project, snapshotId: v.verdict?.snapshotId ?? null, pid: null, deadlineMs: 0, idempotencyKey: `migrate-run-${runId}` })
      await c.finishRun({ runId, state, reason, lastCompletedTask: v.verdict?.lastCompletedTask ?? null, idempotencyKey: `migrate-runfin-${runId}` })
      runsImported++
    }
    for (const r of running) {
      const runId = `legacy-running-${name}-${r.file.replace(/\.json$/, '')}`
      const existing = await c.runs({ project }).catch(() => [])
      if (existing.some(x => x.runId === runId)) continue
      await c.startRun({ runId, project, pid: r.data?.pid ?? null, deadlineMs: 0, idempotencyKey: `migrate-run-${runId}` })
      await c.finishRun({ runId, state: 'aborted', reason: 'legacy-stale-running', idempotencyKey: `migrate-runfin-${runId}` })
      runsImported++
    }
    report.steps.push({ step: 'runs', imported: runsImported })
  }

  // ---- ③ 迁移前后任务数必须相等
  const afterTasks = dryRun ? taskList : await c.tasks(project)
  report.counts.afterTasks = afterTasks.length
  if (afterTasks.length !== taskList.length) {
    report.errors.push(`迁移前后任务数不等：文件 ${taskList.length} ≠ 库 ${afterTasks.length}`)
  } else {
    report.steps.push({ step: 'verify', ok: true, tasks: afterTasks.length })
  }

  // ---- ④ 重生成视图（TASKS.md 从此是生成视图）
  if (!dryRun && regenerate && !report.errors.length) {
    try {
      const g = await generateView({ project, client: c, quiet: true })
      report.steps.push({ step: 'view', file: g.file, tasks: g.tasks })
    } catch (e) { report.warnings.push(`重生成视图失败：${e.message}`) }
  }

  report.ok = report.errors.length === 0
  report.state = report.ok ? 'ok' : 'error'
  return report
}

/** 迁移期的最短合法路径（导入不是运行时变更，允许一次跨几跳） */
const TASK_PATH = {
  pending: { ready: ['ready'], doing: ['ready', 'doing'], review: ['ready', 'doing', 'review'], done: ['ready', 'doing', 'review', 'done'], blocked: ['blocked'], dropped: ['dropped'] },
  ready: { pending: ['pending'], doing: ['doing'], review: ['doing', 'review'], done: ['doing', 'review', 'done'], blocked: ['blocked'], dropped: ['dropped'] },
  doing: { pending: ['pending'], review: ['review'], done: ['review', 'done'], blocked: ['blocked'], dropped: ['dropped'] },
  review: { doing: ['doing'], done: ['done'], blocked: ['blocked'], dropped: ['dropped'] },
  done: { review: ['review'], blocked: ['blocked'] },
  blocked: { pending: ['pending'], ready: ['ready'], dropped: ['dropped'] },
  dropped: { pending: ['pending'], ready: ['ready'] }
}

export function shortestTaskPath (from, to) {
  if (from === to) return []
  return TASK_PATH[from]?.[to] ?? null
}

// ---------------------------------------------------------------- CLI

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const projects = []
  for (let i = 0; i < argv.length; i++) if (argv[i] === '--project' && argv[i + 1]) projects.push(resolve(argv[i + 1]))
  if (has('all')) {
    const ws = join(WORKBENCH, 'workspaces')
    if (existsSync(ws)) {
      for (const d of readdirSync(ws, { withFileTypes: true })) {
        if (!d.isDirectory()) continue
        const p = join(ws, d.name)
        if (existsSync(join(p, 'TASKS.md'))) projects.push(p)
      }
    }
  }
  if (!projects.length) { console.error('用法：node _迁移状态.mjs --project <目录> [--all] [--dry-run] [--report <json>]'); process.exit(2) }

  const client = new StateClient({ ensure: true })
  const reports = []
  let bad = 0
  try {
    await client.requireReady()
  } catch (e) {
    console.error(`[迁移] ❌ 状态服务不可用：${e.message}`)
    console.error('       → 先跑 `node 确保状态服务.mjs`（fail-closed：不会退回直接写文件）')
    process.exit(3)
  }
  for (const p of projects) {
    try {
      const r = await migrateProject(p, { client, dryRun: has('dry-run') })
      reports.push(r)
      if (!r.ok) bad++
      console.log(`[迁移] ${r.ok ? '✅' : '❌'} ${basename(p)}：文件 ${r.counts.tasksInFile} 张 → 库 ${r.counts.afterTasks ?? '?'} 张；旧收据 ${r.counts.verdicts}；残留 running ${r.counts.staleRunning}`)
      for (const w of r.warnings) console.log(`        ⚠️ ${w}`)
      for (const e2 of r.errors) console.log(`        ❌ ${e2}`)
      if (r.backup) console.log(`        备份：${r.backup.dir}（${r.backup.copied.length} 项）`)
    } catch (e) {
      bad++
      if (e instanceof StateUnavailable) { console.error(`[迁移] ❌ 状态服务不可用：${e.message}`); process.exit(3) }
      console.error(`[迁移] ❌ ${basename(p)}：${e.message}`)
      reports.push({ project: p, ok: false, errors: [e.message] })
    }
  }
  const out = opt('report')
  if (out) {
    mkdirSync(dirname(resolve(out)), { recursive: true })
    writeFileSync(resolve(out), JSON.stringify({ schema: 1, kind: 'migrate-report-batch', at: new Date().toISOString(), source: '_迁移状态.mjs', reports }, null, 2), 'utf8')
    console.log(`[迁移] 报告：${resolve(out)}`)
  }
  process.exit(bad === 0 ? 0 : 1)
}
