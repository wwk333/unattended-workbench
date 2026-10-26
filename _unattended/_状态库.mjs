/**
 * 状态库 —— C 状态服务的**唯一持久层**（施工文档 §三）
 *
 * 一句话：task / run / attempt / halt / rework / event 六类事实，只有这个文件能写。
 * `TASKS.md`、看板、HANDOFF 都是**生成视图**（`_TASKS生成.mjs` / `看板数据.mjs` / `交付门.mjs`）。
 *
 * ## 为什么是 SQLite 单文件
 * 文档明写 C 形态：**独立状态机服务 + SQLite 单文件数据库**，本机 loopback HTTP，
 * 不引 MySQL/Postgres。Node v24 自带 `node:sqlite`（`DatabaseSync`），所以**零第三方依赖**。
 *
 * ## 四条硬纪律（每条都对应一次真实事故）
 * 1. **run 开工第一件事就写**。进程被 SIGKILL / job_kill 时捕不到信号，
 *    下次启动靠 `heal()` 发现"pid 已死/超期"改成 `aborted`，原因写 `unknown-external-termination`。
 *    ⛔ 绝不补写 `completed`。
 * 2. **状态值只走 `契约/枚举.mjs`**。`attempt=blocked`、`run=done` 这类跨层复用在这里就被拒。
 * 3. **乐观并发**：所有状态变更都带 `expectedVersion`，`UPDATE ... WHERE version=?` 影响 0 行就是 409，
 *    调用方重读重试。**丢更新 = 0**。
 * 4. **幂等键**：同一 `Idempotency-Key` 重放只返回第一次的结果，不重复落库（网络重试会真的重发）。
 *
 * ## 怎么测
 * `tests/阶段1-状态库.test.mjs`（库层）、`tests/阶段1-状态服务.test.mjs`（HTTP 层）。
 * 用的是临时数据库，不碰 `_crew/state/crew.db`。
 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { assertState, assertTransition, isValidState, ENUMS } from './契约/枚举.mjs'

export const DB_SCHEMA = 2 // 2：attempts 加 ctx_peak / compactions / first_compaction_tokens（§七）
/** 每卡每个 run 最多 6 次编码调用（§六）；审核/裁判不计入 */
export const CODING_BUDGET = 6
/** attempt 只允许这四种（另一个表达在契约/枚举.mjs，这里只用来拼 SQL 约束） */
export const ATTEMPT_STATES = ENUMS.attempt
export const RUN_STATES = ENUMS.run
export const TASK_STATES = ENUMS.task

export class StateDbError extends Error {
  constructor (code, msg, detail) {
    super(`[状态库] ${msg}${detail ? `（${detail}）` : ''}`)
    this.name = 'StateDbError'
    this.code = code
    this.detail = detail ?? null
  }
}

/** 冲突：版本不对 / 迁移非法 / 状态值跨层复用 */
export class ConflictError extends StateDbError {
  constructor (msg, detail) { super('E_CONFLICT', msg, detail); this.name = 'ConflictError'; this.httpStatus = 409 }
}
/** 找不到 */
export class NotFoundError extends StateDbError {
  constructor (msg, detail) { super('E_NOT_FOUND', msg, detail); this.name = 'NotFoundError'; this.httpStatus = 404 }
}
/** 请求本身错（含枚举违规） */
export class BadRequestError extends StateDbError {
  constructor (msg, detail) { super('E_BAD_REQUEST', msg, detail); this.name = 'BadRequestError'; this.httpStatus = 400 }
}

// ---------------------------------------------------------------- 建库 / 迁移

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS tasks (
  project      TEXT NOT NULL,
  id           TEXT NOT NULL,
  wave         TEXT,
  role         TEXT,
  role_pool    TEXT,              -- JSON 数组
  assigned_role TEXT,             -- 角色池选定后粘住（§六）
  level        TEXT,
  goal         TEXT,
  deliverables TEXT,              -- JSON 数组
  depends      TEXT,              -- JSON 数组
  accept       TEXT,              -- JSON 数组（AC 命令）
  writes       TEXT,              -- JSON 数组；NULL = unknown-scope
  resources    TEXT,              -- JSON 数组
  status       TEXT NOT NULL,
  snapshot_id  TEXT,
  legacy       INTEGER NOT NULL DEFAULT 0,   -- 1 = 从旧文件迁移、缺运行收据（legacy-unknown）
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  version      INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (project, id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks (project, status);

CREATE TABLE IF NOT EXISTS runs (
  run_id       TEXT PRIMARY KEY,
  project      TEXT NOT NULL,
  snapshot_id  TEXT,
  state        TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  heartbeat_at TEXT,
  pid          INTEGER,
  deadline_ms  INTEGER NOT NULL DEFAULT 0,
  inflight     TEXT,              -- JSON 数组
  results      TEXT,              -- JSON 数组
  rework       TEXT,              -- JSON 数组
  reason       TEXT,
  last_completed_task TEXT,
  legacy       INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_runs_state ON runs (state);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs (project, state);

CREATE TABLE IF NOT EXISTS attempts (
  attempt_id   TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  project      TEXT,
  task_id      TEXT NOT NULL,
  attempt_kind TEXT NOT NULL,     -- initial|retry|capability|rescue|rework|judge|resume
  role         TEXT,
  carrier      TEXT,
  requested    TEXT,              -- JSON {provider,model}
  selected     TEXT,              -- JSON
  actual       TEXT,              -- JSON（从事件流回读）
  state        TEXT NOT NULL,
  started_at   TEXT NOT NULL,
  ended_at     TEXT,
  session_id   TEXT,
  pid          INTEGER,
  timeout_min  INTEGER,
  prompt_hash  TEXT,
  card_hash    TEXT,
  writes       TEXT,
  resources    TEXT,
  env_keys     TEXT,              -- JSON 数组，只写变量名不写值
  failure      TEXT,              -- JSON {verdict, classify, reason}
  budget_used  INTEGER NOT NULL DEFAULT 1,
  reason       TEXT,              -- aborted-by-brain / unknown-external-termination ...
  legacy       INTEGER NOT NULL DEFAULT 0,
  version      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_attempts_run ON attempts (run_id);
CREATE INDEX IF NOT EXISTS idx_attempts_task ON attempts (project, task_id, started_at);

CREATE TABLE IF NOT EXISTS halts (
  halt_id      TEXT PRIMARY KEY,
  project      TEXT NOT NULL,
  subject      TEXT,              -- 卡 ID / run ID / 服务名
  reason       TEXT NOT NULL,
  evidence     TEXT,              -- JSON
  status       TEXT NOT NULL DEFAULT 'open',   -- open|closed
  created_at   TEXT NOT NULL,
  closed_at    TEXT,
  closed_by    TEXT,
  close_evidence TEXT,
  version      INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_halts_open ON halts (project, status);

CREATE TABLE IF NOT EXISTS reworks (
  rework_id    TEXT PRIMARY KEY,
  project      TEXT,
  task_id      TEXT,
  run_id       TEXT,
  attempt_id   TEXT,
  round        INTEGER,
  reason       TEXT,
  evidence     TEXT,
  at           TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reworks_task ON reworks (project, task_id, at);

CREATE TABLE IF NOT EXISTS events (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  project      TEXT,
  kind         TEXT NOT NULL,     -- task-status|run-start|run-end|attempt-start|attempt-end|heal|halt|rework|command
  subject      TEXT,
  at           TEXT NOT NULL,
  source       TEXT,
  payload      TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_project ON events (project, seq);

CREATE TABLE IF NOT EXISTS idempotency (
  key          TEXT PRIMARY KEY,
  endpoint     TEXT,
  status_code  INTEGER,
  response     TEXT,
  at           TEXT NOT NULL
);
`

/**
 * 开库。`dbPath === ':memory:'` 给测试用。
 * WAL + synchronous=NORMAL：崩溃后不会留半条事务，单进程内读写毫秒级。
 */
export function openDb ({ dbPath, readonly = false } = {}) {
  if (!dbPath) throw new StateDbError('E_NO_PATH', 'openDb 缺 dbPath')
  if (dbPath !== ':memory:') mkdirSync(dirname(dbPath), { recursive: true })
  const db = new DatabaseSync(dbPath, { readOnly: readonly })
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA busy_timeout = 5000;')
  db.exec('PRAGMA foreign_keys = ON;')
  if (!readonly) migrate(db)
  return db
}

/** 后加列的清单（老库升级用；`ALTER TABLE` 幂等由 PRAGMA 判定保证） */
const ADDED_COLUMNS = [
  ['attempts', 'ctx_peak', 'INTEGER'],
  ['attempts', 'compactions', 'INTEGER'],
  ['attempts', 'first_compaction_tokens', 'INTEGER']
]

function ensureColumns (db) {
  for (const [table, col, type] of ADDED_COLUMNS) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`)
  }
}

export function migrate (db) {
  db.exec(DDL)
  ensureColumns(db)
  const cur = db.prepare('SELECT v FROM meta WHERE k = ?').get('schema_version')
  if (!cur) {
    db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('schema_version', String(DB_SCHEMA))
    db.prepare('INSERT INTO meta (k, v) VALUES (?, ?)').run('created_at', new Date().toISOString())
  } else if (Number(cur.v) > DB_SCHEMA) {
    throw new StateDbError('E_SCHEMA_NEWER', `数据库 schema 版本 ${cur.v} 比本程序（${DB_SCHEMA}）新，拒绝降级读写`)
  }
  return DB_SCHEMA
}

export function dbInfo (db) {
  const get = (k) => db.prepare('SELECT v FROM meta WHERE k = ?').get(k)?.v ?? null
  const count = (sql) => {
    try { return db.prepare(sql).get()?.n ?? 0 } catch { return null }
  }
  return {
    schemaVersion: Number(get('schema_version') ?? 0),
    createdAt: get('created_at'),
    tasks: count('SELECT COUNT(*) AS n FROM tasks'),
    runs: count('SELECT COUNT(*) AS n FROM runs'),
    attempts: count('SELECT COUNT(*) AS n FROM attempts'),
    openHalts: count("SELECT COUNT(*) AS n FROM halts WHERE status = 'open'")
  }
}

/**
 * **项目路径归一** —— 同一个项目必须永远得到同一个 key。
 *
 * 起因（2026-10-26 demo 真跑当场抓到）：`台账 add --project "_crew\\...\\demo-run"` 传的是**相对路径**，
 * 而 `编排` 传的是 `resolve()` 后的**绝对路径** ⇒ 库里成了两个 key ⇒
 * 每张卡改状态都 404 / StateRejected，**状态永远推不动**。
 *
 * 归一规则（越简单越好，别搞花样）：
 *   ① 反斜杠 → 正斜杠；② 去掉结尾的 /；③ 尽量绝对化（能 resolve 就 resolve）；
 *   ④ 盘符统一小写（`D:` 与 `d:/` 是同一个盘）。
 * ⚠️ 路径**中间的**大小写不动 —— Windows 不区分，但改了会让人对不上自己在哪。
 */
export function normProject (p) {
  if (p === null || p === undefined) return null
  const raw = String(p).trim()
  if (!raw) return null
  let s = raw.replace(/\\/g, '/').replace(/\/+$/, '')
  try { s = resolve(s).replace(/\\/g, '/') } catch { /* 解析不了就保留原样（下面还会去尾斜杠） */ }
  s = s.replace(/^([A-Za-z]):/, (_m, x) => x.toLowerCase() + ':')
  return s
}

/**
 * 把库里**已经写成别的形状**的项目路径统一过来（一次性迁移，幂等）。
 * 逐行算新值，能更新就更新；同一张表里如果新 key 已存在（重复行）就跳过并记账，
 * **绝不删数据**。
 */
export function migrateProjectKeys (db) {
  const tables = [
    ['tasks', 'project'], ['runs', 'project'], ['attempts', 'project'],
    ['halts', 'project'], ['reworks', 'project'], ['events', 'project']
  ]
  const out = { updated: 0, skipped: [] }
  for (const [table, col] of tables) {
    let rows = []
    try { rows = db.prepare(`SELECT DISTINCT ${col} AS p FROM ${table} WHERE ${col} IS NOT NULL`).all() } catch { continue }
    for (const r of rows) {
      const from = r.p
      const to = normProject(from)
      if (!to || to === from) continue
      try {
        const n = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(to, from).changes
        out.updated += Number(n) || 0
      } catch (e) {
        out.skipped.push(`${table}: ${from} → ${to}（${String(e?.message ?? e).slice(0, 60)}）`)
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- 小工具// ---------------------------------------------------------------- 小工具

/** 事务包装：异常必回滚，绝不把半条状态留在库里 */
export function tx (db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const out = fn()
    db.exec('COMMIT')
    return out
  } catch (e) {
    try { db.exec('ROLLBACK') } catch {}
    throw e
  }
}

const J = (v) => (v === undefined || v === null ? null : JSON.stringify(v))
const P = (v, dflt = null) => {
  if (v === null || v === undefined) return dflt
  try { return JSON.parse(v) } catch { return dflt }
}
const nowIso = (now) => new Date(now ?? Date.now()).toISOString()

export function logEvent (db, { project = null, kind, subject = null, at = null, source = null, payload = null }) {
  if (!kind) throw new BadRequestError('事件缺 kind')
  db.prepare('INSERT INTO events (project, kind, subject, at, source, payload) VALUES (?,?,?,?,?,?)')
    .run(project, kind, subject, nowIso(at), source, J(payload))
}

export function listEvents (db, { project = null, since = 0, limit = 200 } = {}) {
  const rows = project
    ? db.prepare('SELECT * FROM events WHERE project = ? AND seq > ? ORDER BY seq LIMIT ?').all(project, since, limit)
    : db.prepare('SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?').all(since, limit)
  return rows.map(r => ({ ...r, payload: P(r.payload) }))
}

/** 幂等：命中就直接回放第一次的响应，不再执行 */
export function idemGet (db, key) {
  if (!key) return null
  const row = db.prepare('SELECT * FROM idempotency WHERE key = ?').get(key)
  if (!row) return null
  return { statusCode: row.status_code, body: P(row.response, {}), at: row.at }
}

export function idemPut (db, key, endpoint, statusCode, body) {
  if (!key) return
  db.prepare('INSERT OR REPLACE INTO idempotency (key, endpoint, status_code, response, at) VALUES (?,?,?,?,?)')
    .run(key, endpoint, statusCode, JSON.stringify(body), nowIso())
}

// ---------------------------------------------------------------- task

const TASK_FIELDS = ['wave', 'role', 'level', 'goal', 'deliverables', 'depends', 'accept', 'writes', 'resources', 'role_pool', 'assigned_role', 'snapshot_id', 'legacy']

function taskRow (r) {
  return {
    project: r.project,
    id: r.id,
    wave: r.wave,
    role: r.role,
    rolePool: P(r.role_pool, []),
    assignedRole: r.assigned_role,
    level: r.level,
    goal: r.goal,
    deliverables: P(r.deliverables, []),
    depends: P(r.depends, []),
    accept: P(r.accept, []),
    writes: P(r.writes, null),         // null 与 [] 不同：null = unknown-scope；[] = 明确不写文件
    resources: P(r.resources, []),
    status: r.status,
    snapshotId: r.snapshot_id,
    legacy: r.legacy === 1,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    version: r.version
  }
}

/** 新增/更新一张卡的**定义**（状态不在这里改，走 setTaskStatus） */
export function upsertTask (db, { project, id, status = 'pending', ...rest }) {
  if (!project) throw new BadRequestError('缺 project')
  if (!id) throw new BadRequestError('缺 task id')
  assertState('task', status)
  const at = nowIso()
  const existing = db.prepare('SELECT * FROM tasks WHERE project = ? AND id = ?').get(project, id)
  if (!existing) {
    db.prepare(`INSERT INTO tasks (project,id,wave,role,level,goal,deliverables,depends,accept,writes,resources,role_pool,assigned_role,snapshot_id,status,legacy,created_at,updated_at,version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,1)`).run(
      project, id, rest.wave ?? null, rest.role ?? null, rest.level ?? null, rest.goal ?? null,
      J(rest.deliverables ?? []), J(rest.depends ?? []), J(rest.accept ?? []),
      rest.writes === undefined ? null : J(rest.writes),
      J(rest.resources ?? []), J(rest.rolePool ?? rest.role_pool ?? []), rest.assignedRole ?? rest.assigned_role ?? null,
      rest.snapshotId ?? rest.snapshot_id ?? null, status, rest.legacy ? 1 : 0, at, at
    )
    logEvent(db, { project, kind: 'task-create', subject: id, source: '状态库', payload: { status } })
  } else {
    const sets = []
    const vals = []
    const map = {
      wave: a => a,
      role: a => a,
      level: a => a,
      goal: a => a,
      deliverables: J,
      depends: J,
      accept: J,
      writes: J,
      resources: J,
      role_pool: a => J(a ?? []),
      assigned_role: a => a,
      snapshot_id: a => a
    }
    const incoming = {
      wave: rest.wave, role: rest.role, level: rest.level, goal: rest.goal,
      deliverables: rest.deliverables, depends: rest.depends, accept: rest.accept,
      writes: rest.writes, resources: rest.resources,
      role_pool: rest.rolePool ?? rest.role_pool,
      assigned_role: rest.assignedRole ?? rest.assigned_role,
      snapshot_id: rest.snapshotId ?? rest.snapshot_id
    }
    for (const k of Object.keys(map)) {
      if (incoming[k] === undefined) continue
      sets.push(`${k} = ?`)
      vals.push(map[k](incoming[k]))
    }
    if (sets.length) {
      sets.push('updated_at = ?'); vals.push(at)
      sets.push('version = version + 1')
      vals.push(project, id)
      db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE project = ? AND id = ?`).run(...vals)
    }
  }
  return getTask(db, project, id)
}

export function getTask (db, project, id) {
  const r = db.prepare('SELECT * FROM tasks WHERE project = ? AND id = ?').get(project, id)
  if (!r) throw new NotFoundError(`没有这张卡：${project} / ${id}`)
  return taskRow(r)
}

export function findTask (db, project, id) {
  const r = db.prepare('SELECT * FROM tasks WHERE project = ? AND id = ?').get(project, id)
  return r ? taskRow(r) : null
}

export function listTasks (db, { project, status = null } = {}) {
  if (!project) throw new BadRequestError('listTasks 缺 project')
  const rows = status
    ? db.prepare('SELECT * FROM tasks WHERE project = ? AND status = ? ORDER BY wave, id').all(project, status)
    : db.prepare('SELECT * FROM tasks WHERE project = ? ORDER BY wave, id').all(project)
  return rows.map(taskRow)
}

/**
 * 改任务状态 —— **唯一入口**。
 * @param {object} o
 * @param {number} o.expectedVersion 必填：不带版本就没法发现"两个人同时改一张卡"
 */
export function setTaskStatus (db, { project, id, from = null, to, expectedVersion, evidence = null, source = null }) {
  if (!project) throw new BadRequestError('缺 project')
  assertState('task', to)
  if (!Number.isInteger(expectedVersion)) {
    throw new BadRequestError('改状态必须带 expectedVersion（防止并发丢更新）', String(expectedVersion))
  }
  return tx(db, () => {
    const cur = db.prepare('SELECT * FROM tasks WHERE project = ? AND id = ?').get(project, id)
    if (!cur) throw new NotFoundError(`没有这张卡：${project} / ${id}`)
    if (from && cur.status !== from) {
      throw new ConflictError(`卡的当前状态是 ${cur.status}，不是调用方以为的 ${from}`, `${project}/${id}`)
    }
    if (cur.status === to) throw new ConflictError(`卡已经是 ${to}，不需要再改`, `${project}/${id}`)
    try {
      assertTransition('task', cur.status, to)
    } catch (e) {
      throw new ConflictError(`非法状态迁移：${cur.status} → ${to}`, e.message)
    }
    const at = nowIso()
    const r = db.prepare('UPDATE tasks SET status = ?, updated_at = ?, version = version + 1, snapshot_id = COALESCE(?, snapshot_id) WHERE project = ? AND id = ? AND version = ?')
      .run(to, at, evidence?.snapshotId ?? null, project, id, expectedVersion)
    if (r.changes === 0) {
      throw new ConflictError('版本冲突：这张卡刚被别人改过，请重读再试', `${project}/${id} expected=${expectedVersion} current=${cur.version}`)
    }
    logEvent(db, { project, kind: 'task-status', subject: id, source, payload: { from: cur.status, to, evidence, version: expectedVersion + 1 } })
    return taskRow(db.prepare('SELECT * FROM tasks WHERE project = ? AND id = ?').get(project, id))
  })
}

/** 绑定角色池选定的角色（粘性）：本任务后续重试/返工默认用它 */
export function assignRole (db, { project, id, role, expectedVersion = null }) {
  if (!role) throw new BadRequestError('assignRole 缺 role')
  return tx(db, () => {
    const cur = db.prepare('SELECT * FROM tasks WHERE project = ? AND id = ?').get(project, id)
    if (!cur) throw new NotFoundError(`没有这张卡：${project} / ${id}`)
    if (expectedVersion !== null && cur.version !== expectedVersion) {
      throw new ConflictError('版本冲突', `${project}/${id} expected=${expectedVersion} current=${cur.version}`)
    }
    db.prepare('UPDATE tasks SET assigned_role = ?, updated_at = ?, version = version + 1 WHERE project = ? AND id = ?')
      .run(role, nowIso(), project, id)
    logEvent(db, { project, kind: 'task-assign', subject: id, payload: { role } })
    return taskRow(db.prepare('SELECT * FROM tasks WHERE project = ? AND id = ?').get(project, id))
  })
}

/** 依赖已完成的卡（= 台账 ready 的口径：depends 全 done；没有 depends 视为满足） */
export function readyTasks (db, { project, limit = 50 } = {}) {
  const all = listTasks(db, { project })
  const byId = new Map(all.map(t => [t.id, t]))
  const out = []
  for (const t of all) {
    if (t.status !== 'pending' && t.status !== 'ready') continue
    const blocked = t.depends.filter(d => {
      const dep = byId.get(d)
      return !dep || dep.status !== 'done'
    })
    if (!blocked.length) out.push({ ...t, unblockedBy: [] })
    if (out.length >= limit) break
  }
  return out
}

// ---------------------------------------------------------------- run

export const RUN_SELECT = 'SELECT * FROM runs'

function runRow (r) {
  if (!r) return null
  return {
    runId: r.run_id,
    project: r.project,
    snapshotId: r.snapshot_id,
    state: r.state,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    heartbeatAt: r.heartbeat_at,
    pid: r.pid,
    deadlineMs: r.deadline_ms,
    inflight: P(r.inflight, []),
    results: P(r.results, []),
    rework: P(r.rework, []),
    reason: r.reason,
    lastCompletedTask: r.last_completed_task,
    legacy: r.legacy === 1,
    version: r.version
  }
}

/**
 * **开工第一件事**：写 run 收据。写不进去就不许开工（fail-closed）。
 */
export function startRun (db, { runId, project, snapshotId = null, pid = null, deadlineMs = 0, at = null }) {
  if (!runId) throw new BadRequestError('startRun 缺 runId')
  if (!project) throw new BadRequestError('startRun 缺 project')
  const t = nowIso(at)
  const exists = db.prepare('SELECT run_id FROM runs WHERE run_id = ?').get(runId)
  if (exists) throw new ConflictError(`runId 已存在：${runId}`, 'runId 必须唯一')
  tx(db, () => {
    db.prepare(`INSERT INTO runs (run_id,project,snapshot_id,state,started_at,heartbeat_at,pid,deadline_ms,inflight,results,rework,legacy,version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,0,1)`)
      .run(runId, project, snapshotId, 'running', t, t, pid, deadlineMs, J([]), J([]), J([]))
    logEvent(db, { project, kind: 'run-start', subject: runId, payload: { snapshotId, pid, deadlineMs } })
  })
  return getRun(db, runId)
}

export function getRun (db, runId) {
  const r = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId)
  if (!r) throw new NotFoundError(`没有这个 run：${runId}`)
  return runRow(r)
}

export function listRuns (db, { project = null, state = null, limit = 50 } = {}) {
  const sql = ['SELECT * FROM runs WHERE 1=1']
  const vals = []
  if (project) { sql.push('AND project = ?'); vals.push(project) }
  if (state) { sql.push('AND state = ?'); vals.push(state) }
  sql.push('ORDER BY started_at DESC LIMIT ?'); vals.push(limit)
  return db.prepare(sql.join(' ')).all(...vals).map(runRow)
}

/** 心跳：客户端每隔一会儿拍一下；不用它判活也可以，但超期判死要用它 */
export function heartbeat (db, { runId, at = null }) {
  const r = db.prepare('UPDATE runs SET heartbeat_at = ? WHERE run_id = ? AND state = ?').run(nowIso(at), runId, 'running')
  if (r.changes === 0) throw new ConflictError(`run 不在 running，不能拍心跳：${runId}`)
  return true
}

/** 记录本轮在跑的卡（inflight）与已完成结果 */
export function updateRunProgress (db, { runId, inflight, results, rework }) {
  return tx(db, () => {
    const r = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId)
    if (!r) throw new NotFoundError(`没有这个 run：${runId}`)
    if (r.state !== 'running') throw new ConflictError(`run 已 ${r.state}，不许再改进度`, runId)
    db.prepare('UPDATE runs SET inflight = COALESCE(?, inflight), results = COALESCE(?, results), rework = COALESCE(?, rework), heartbeat_at = ?, version = version + 1 WHERE run_id = ?')
      .run(inflight === undefined ? null : J(inflight), results === undefined ? null : J(results), rework === undefined ? null : J(rework), nowIso(), runId)
    return runRow(db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId))
  })
}

/**
 * 收口一个 run。**只允许 running → completed/aborted/failed**；
 * 重复收口会 409（不是"静默成功" —— 那样会掩盖两条收据）。
 */
export function finishRun (db, { runId, state, reason = null, lastCompletedTask = null, endedAt = null }) {
  assertState('run', state)
  if (state === 'running') throw new BadRequestError('finishRun 不能用 running 收口')
  return tx(db, () => {
    const r = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId)
    if (!r) throw new NotFoundError(`没有这个 run：${runId}`)
    if (r.state !== 'running') throw new ConflictError(`run 已经是 ${r.state}，不许再收口成 ${state}`, runId)
    if (r.state !== state) assertTransition('run', r.state, state)
    const at = nowIso(endedAt)
    db.prepare('UPDATE runs SET state = ?, ended_at = ?, reason = ?, last_completed_task = COALESCE(?, last_completed_task), version = version + 1 WHERE run_id = ?')
      .run(state, at, reason, lastCompletedTask, runId)
    // 收口时把它名下还 running 的 attempt 一起收口，绝不留下"跑完了但 attempt 还在 running"的孤儿
    const orphans = db.prepare('SELECT attempt_id FROM attempts WHERE run_id = ? AND state = ?').all(runId, 'running')
    for (const a of orphans) {
      db.prepare('UPDATE attempts SET state = ?, ended_at = ?, reason = ?, version = version + 1 WHERE attempt_id = ?')
        .run(state === 'completed' ? 'aborted' : 'aborted', at, `run-${state}`, a.attempt_id)
      logEvent(db, { project: r.project, kind: 'attempt-end', subject: a.attempt_id, payload: { state: 'aborted', reason: `run-${state}`, healed: true } })
    }
    logEvent(db, { project: r.project, kind: 'run-end', subject: runId, payload: { state, reason, lastCompletedTask } })
    return runRow(db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId))
  })
}

// ---------------------------------------------------------------- attempt

function attemptRow (r) {
  if (!r) return null
  return {
    attemptId: r.attempt_id,
    runId: r.run_id,
    project: r.project,
    taskId: r.task_id,
    attemptKind: r.attempt_kind,
    role: r.role,
    carrier: r.carrier,
    requested: P(r.requested),
    selected: P(r.selected),
    actual: P(r.actual),
    state: r.state,
    startedAt: r.started_at,
    endedAt: r.ended_at,
    sessionId: r.session_id,
    pid: r.pid,
    timeoutMin: r.timeout_min,
    promptHash: r.prompt_hash,
    cardHash: r.card_hash,
    writes: P(r.writes, []),
    resources: P(r.resources, []),
    envKeysInjected: P(r.env_keys, []),
    failure: P(r.failure),
    budgetUsed: r.budget_used,
    ctxPeak: r.ctx_peak ?? null,
    compactions: r.compactions ?? null,
    firstCompactionTokens: r.first_compaction_tokens ?? null,
    reason: r.reason,
    legacy: r.legacy === 1,
    version: r.version
  }
}

const ATTEMPT_KINDS = ['initial', 'retry', 'capability', 'rescue', 'rework', 'judge', 'resume']

/**
 * 开工一个 attempt。**6 次编码预算在这里卡**：含首派/重试/能力换路/急救/返工；
 * judge/审核不计入（`attemptKind === 'judge'` 时 budget_used 记 0）。
 */
export function startAttempt (db, { attemptId, runId, project = null, taskId, attemptKind = 'initial', role = null, carrier = null, requested = null, selected = null, pid = null, timeoutMin = null, promptHash = null, cardHash = null, writes = [], resources = [], envKeysInjected = [], at = null }) {
  if (!attemptId) throw new BadRequestError('startAttempt 缺 attemptId')
  if (!runId) throw new BadRequestError('startAttempt 缺 runId')
  if (!taskId) throw new BadRequestError('startAttempt 缺 taskId')
  if (!ATTEMPT_KINDS.includes(attemptKind)) throw new BadRequestError(`attemptKind 非法：${attemptKind}（只允许 ${ATTEMPT_KINDS.join('/')}）`)
  const t = nowIso(at)
  return tx(db, () => {
    const run = db.prepare('SELECT * FROM runs WHERE run_id = ?').get(runId)
    if (!run) throw new NotFoundError(`没有这个 run：${runId}`)
    if (run.state !== 'running') throw new ConflictError(`run 已 ${run.state}，不许再开工 attempt`, runId)
    const counted = attemptKind !== 'judge'
    if (counted) {
      const used = budgetUsed(db, { runId, taskId })
      if (used >= CODING_BUDGET) {
        throw new ConflictError(`这张卡在这个 run 里的 ${CODING_BUDGET} 次编码调用已用完`, `${taskId} used=${used}`)
      }
    }
    db.prepare(`INSERT INTO attempts (attempt_id,run_id,project,task_id,attempt_kind,role,carrier,requested,selected,state,started_at,pid,timeout_min,prompt_hash,card_hash,writes,resources,env_keys,budget_used,legacy,version)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,1)`).run(
      attemptId, runId, project ?? run.project, taskId, attemptKind, role, carrier,
      J(requested), J(selected), 'running', t, pid, timeoutMin, promptHash, cardHash,
      J(writes), J(resources), J(envKeysInjected), counted ? 1 : 0
    )
    logEvent(db, { project: project ?? run.project, kind: 'attempt-start', subject: attemptId, payload: { runId, taskId, attemptKind, role, carrier, requested, selected } })
    return attemptRow(db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId))
  })
}

export function getAttempt (db, attemptId) {
  const r = db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId)
  if (!r) throw new NotFoundError(`没有这个 attempt：${attemptId}`)
  return attemptRow(r)
}

export function listAttempts (db, { runId = null, project = null, taskId = null, state = null, role = null, limit = 100 } = {}) {
  const sql = ['SELECT * FROM attempts WHERE 1=1']
  const vals = []
  if (runId) { sql.push('AND run_id = ?'); vals.push(runId) }
  if (project) { sql.push('AND project = ?'); vals.push(project) }
  if (taskId) { sql.push('AND task_id = ?'); vals.push(taskId) }
  if (state) { sql.push('AND state = ?'); vals.push(state) }
  // ★ 2026-10-26（§十「角色抽屉加 attempt」）：按**角色**查 —— 看板抽屉要的是"这个角色最近几次尝试"
  if (role) { sql.push('AND role = ?'); vals.push(role) }
  sql.push('ORDER BY started_at DESC LIMIT ?'); vals.push(limit)
  return db.prepare(sql.join(' ')).all(...vals).map(attemptRow)
}

/**
 * 一次尝试的**给人看**摘要（看板抽屉用）。**缺字段就说缺**，不补默认值（§十：缺 attempt 不许显示 completed）。
 * @returns {Array<{id,taskId,runId,kind,state,role,carrier,startedAt,endedAt,verdict,why,budget,routeMismatch}>}
 */
export function attemptDigest (attempts = []) {
  return (Array.isArray(attempts) ? attempts : []).map(a => {
    const req = a.requested ?? null
    const sel = a.selected ?? null
    const act = a.actual ?? null
    const drift = act && (sel ?? req) && (
      (sel && req && (sel.provider !== req.provider || sel.model !== req.model)) ||
      (act && (sel ?? req) && (act.provider !== (sel ?? req).provider || act.model !== (sel ?? req).model))
    )
    return {
      id: a.attemptId,
      taskId: a.taskId,
      runId: a.runId,
      kind: a.attemptKind,
      state: a.state,
      role: a.role ?? null,
      carrier: a.carrier ?? null,
      startedAt: a.startedAt ?? null,
      endedAt: a.endedAt ?? null,
      verdict: a.failure?.verdict ?? null,
      why: a.failure?.why ?? a.failure?.reason ?? a.reason ?? null,
      budget: a.budgetUsed ?? 0,
      ctxPeak: a.ctxPeak ?? null,
      compactions: a.compactions ?? null,
      firstCompactionTokens: a.firstCompactionTokens ?? null,
      routeMismatch: Boolean(drift),
      missing: a.state === 'completed' && !a.endedAt ? '缺 endedAt（不许当已完成看）' : null
    }
  })
}

/** 已有多少次**编码**调用（judge 不算，§六） */
export function budgetUsed (db, { runId = null, project = null, taskId = null }) {
  const sql = ['SELECT COALESCE(SUM(budget_used),0) AS n FROM attempts WHERE 1=1']
  const vals = []
  if (runId) { sql.push('AND run_id = ?'); vals.push(runId) }
  if (project) { sql.push('AND project = ?'); vals.push(project) }
  if (taskId) { sql.push('AND task_id = ?'); vals.push(taskId) }
  return db.prepare(sql.join(' ')).get(...vals).n
}

/** 收口 attempt：只允许 running → completed/failed/aborted（blocked 在这里是违规，会被枚举拒） */
export function finishAttempt (db, { attemptId, state, failure = null, actual = null, sessionId = null, reason = null, endedAt = null, ctxPeak = null, compactions = null, firstCompactionTokens = null }) {
  assertState('attempt', state)
  if (state === 'running') throw new BadRequestError('finishAttempt 不能用 running 收口')
  return tx(db, () => {
    const r = db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId)
    if (!r) throw new NotFoundError(`没有这个 attempt：${attemptId}`)
    if (r.state !== 'running') throw new ConflictError(`attempt 已经是 ${r.state}，不许再收口成 ${state}`, attemptId)
    assertTransition('attempt', r.state, state)
    // ★ 2026-10-26（§七）：`ctxPeak/compactions/firstCompactionTokens` **只有调用方给了才写**。
    //   没给就是 NULL —— 宁可留空（看板显示"未实测"），也不补一个看起来合理的数字。
    db.prepare('UPDATE attempts SET state = ?, ended_at = ?, failure = ?, actual = COALESCE(?, actual), session_id = COALESCE(?, session_id), reason = ?, ctx_peak = COALESCE(?, ctx_peak), compactions = COALESCE(?, compactions), first_compaction_tokens = COALESCE(?, first_compaction_tokens), version = version + 1 WHERE attempt_id = ?')
      .run(state, nowIso(endedAt), J(failure), J(actual), sessionId, reason,
        Number.isFinite(ctxPeak) ? Number(ctxPeak) : null,
        Number.isFinite(compactions) ? Number(compactions) : null,
        Number.isFinite(firstCompactionTokens) ? Number(firstCompactionTokens) : null,
        attemptId)
    logEvent(db, { project: r.project, kind: 'attempt-end', subject: attemptId, payload: { state, failure, actual, reason } })
    return attemptRow(db.prepare('SELECT * FROM attempts WHERE attempt_id = ?').get(attemptId))
  })
}

// ---------------------------------------------------------------- halt

function haltRow (r) {
  return {
    haltId: r.halt_id, project: r.project, subject: r.subject, reason: r.reason,
    evidence: P(r.evidence), status: r.status, createdAt: r.created_at,
    closedAt: r.closed_at, closedBy: r.closed_by, closeEvidence: P(r.close_evidence), version: r.version
  }
}

/** 开一条 halt。原因必须给（"先挂着"就是后来没人销的那种） */
export function openHalt (db, { haltId, project, subject = null, reason, evidence = null, at = null }) {
  if (!project) throw new BadRequestError('openHalt 缺 project')
  if (!reason) throw new BadRequestError('openHalt 缺 reason（没有原因的 halt 永远销不掉）')
  const id = haltId ?? `halt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  tx(db, () => {
    db.prepare('INSERT INTO halts (halt_id,project,subject,reason,evidence,status,created_at,version) VALUES (?,?,?,?,?,?,?,1)')
      .run(id, project, subject, reason, J(evidence), 'open', nowIso(at))
    logEvent(db, { project, kind: 'halt-open', subject: subject ?? id, payload: { haltId: id, reason } })
  })
  return getHalt(db, id)
}

export function getHalt (db, haltId) {
  const r = db.prepare('SELECT * FROM halts WHERE halt_id = ?').get(haltId)
  if (!r) throw new NotFoundError(`没有这条 halt：${haltId}`)
  return haltRow(r)
}

export function listHalts (db, { project, status = null } = {}) {
  if (!project) throw new BadRequestError('listHalts 缺 project')
  const rows = status
    ? db.prepare('SELECT * FROM halts WHERE project = ? AND status = ? ORDER BY created_at').all(project, status)
    : db.prepare('SELECT * FROM halts WHERE project = ? ORDER BY created_at').all(project)
  return rows.map(haltRow)
}

/**
 * 销账。**必须给理由匹配的证据**（§三：门禁红→同范围后续绿；某卡 AC 红→同卡 AC 绿且审核 pass …）。
 * 匹配不上就保持 open —— 这里不猜。
 */
export function closeHalt (db, { haltId, by, evidence = null, matched = false }) {
  return tx(db, () => {
    const r = db.prepare('SELECT * FROM halts WHERE halt_id = ?').get(haltId)
    if (!r) throw new NotFoundError(`没有这条 halt：${haltId}`)
    if (r.status === 'closed') throw new ConflictError('halt 已经销过', haltId)
    if (!by) throw new BadRequestError('销账必须写明是谁/哪条证据销的（by）')
    if (matched !== true) throw new ConflictError('销账证据与 halt 原因不匹配 ⇒ 保持 open（匹配不上不许销）', haltId)
    db.prepare('UPDATE halts SET status = ?, closed_at = ?, closed_by = ?, close_evidence = ?, version = version + 1 WHERE halt_id = ?')
      .run('closed', nowIso(), by, J(evidence), haltId)
    logEvent(db, { project: r.project, kind: 'halt-close', subject: r.subject ?? haltId, payload: { by, evidence } })
    return haltRow(db.prepare('SELECT * FROM halts WHERE halt_id = ?').get(haltId))
  })
}

// ---------------------------------------------------------------- rework

/** rework 每次发生即落库（原来只在内存 REWORKS 里，进程一死就没了） */
export function addRework (db, { project, taskId, runId = null, attemptId = null, round = null, reason = null, evidence = null, at = null }) {
  const id = `rw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  tx(db, () => {
    db.prepare('INSERT INTO reworks (rework_id,project,task_id,run_id,attempt_id,round,reason,evidence,at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run(id, project, taskId, runId, attemptId, round, reason, J(evidence), nowIso(at))
    logEvent(db, { project, kind: 'rework', subject: taskId, payload: { id, runId, attemptId, round, reason } })
  })
  return db.prepare('SELECT * FROM reworks WHERE rework_id = ?').get(id)
}

export function listReworks (db, { project, taskId = null } = {}) {
  if (!project) throw new BadRequestError('listReworks 缺 project')
  const rows = taskId
    ? db.prepare('SELECT * FROM reworks WHERE project = ? AND task_id = ? ORDER BY at').all(project, taskId)
    : db.prepare('SELECT * FROM reworks WHERE project = ? ORDER BY at').all(project)
  return rows.map(r => ({ ...r, evidence: P(r.evidence) }))
}

// ---------------------------------------------------------------- 自愈

/** pid 是否活着（Windows 上 EPERM 也算活：进程在，只是没权限） */
export function pidAlive (pid) {
  if (!pid || !Number.isInteger(pid)) return null
  try { process.kill(pid, 0); return true } catch (e) { return e.code === 'EPERM' }
}

/**
 * 自愈：**跑一次就退**，但每次启动和每轮看护都跑。
 *
 * 两件事：
 *   ① run 级：`state=running` 但 pid 已死 / 超过 deadline ⇒ 改 `aborted`，原因写
 *      `unknown-external-termination` 或 `deadline-exceeded`。⛔ 不编 completed。
 *   ② doing 级：任务 `doing` 但没有活着的 running attempt ⇒ 回 `pending` + recovery 事件。
 *      这就是"不靠人删 running 文件、不靠人改状态"。
 *
 * @returns {{ runs: object[], tasks: object[], at: string }}
 */
export function heal (db, { now = Date.now(), isAlive = pidAlive, project = null } = {}) {
  const at = nowIso(now)
  const healedRuns = []
  const healedTasks = []
  tx(db, () => {
    const runs = project
      ? db.prepare('SELECT * FROM runs WHERE state = ? AND project = ?').all('running', project)
      : db.prepare('SELECT * FROM runs WHERE state = ?').all('running')
    for (const r of runs) {
      let reason = null
      const alive = isAlive(r.pid)
      if (alive === false) reason = 'unknown-external-termination'
      else if (r.deadline_ms > 0 && now - Date.parse(r.started_at) > r.deadline_ms) reason = 'deadline-exceeded'
      else if (r.heartbeat_at && r.deadline_ms > 0 && now - Date.parse(r.heartbeat_at) > r.deadline_ms) reason = 'deadline-exceeded'
      if (!reason) continue
      db.prepare('UPDATE runs SET state = ?, ended_at = ?, reason = ?, version = version + 1 WHERE run_id = ? AND state = ?')
        .run('aborted', at, reason, r.run_id, 'running')
      for (const a of db.prepare('SELECT attempt_id FROM attempts WHERE run_id = ? AND state = ?').all(r.run_id, 'running')) {
        db.prepare('UPDATE attempts SET state = ?, ended_at = ?, reason = ?, version = version + 1 WHERE attempt_id = ?')
          .run('aborted', at, reason, a.attempt_id)
        logEvent(db, { project: r.project, kind: 'attempt-end', subject: a.attempt_id, payload: { state: 'aborted', reason, healed: true } })
      }
      logEvent(db, { project: r.project, kind: 'heal', subject: r.run_id, payload: { scope: 'run', state: 'aborted', reason } })
      healedRuns.push({ runId: r.run_id, project: r.project, reason })
    }

    const doing = project
      ? db.prepare('SELECT * FROM tasks WHERE status = ? AND project = ?').all('doing', project)
      : db.prepare('SELECT * FROM tasks WHERE status = ?').all('doing')
    for (const t of doing) {
      const live = db.prepare("SELECT * FROM attempts WHERE project = ? AND task_id = ? AND state = 'running'").all(t.project, t.id)
      const anyAlive = live.some(a => isAlive(a.pid) !== false)
      if (anyAlive) continue // 真有活在跑，保留
      for (const a of live) {
        db.prepare('UPDATE attempts SET state = ?, ended_at = ?, reason = ?, version = version + 1 WHERE attempt_id = ?')
          .run('aborted', at, 'no-live-process', a.attempt_id)
        logEvent(db, { project: t.project, kind: 'attempt-end', subject: a.attempt_id, payload: { state: 'aborted', reason: 'no-live-process', healed: true } })
      }
      db.prepare('UPDATE tasks SET status = ?, updated_at = ?, version = version + 1 WHERE project = ? AND id = ? AND status = ?')
        .run('pending', at, t.project, t.id, 'doing')
      logEvent(db, { project: t.project, kind: 'heal', subject: t.id, payload: { scope: 'task', from: 'doing', to: 'pending', reason: 'doing-no-live-attempt', attempts: live.map(a => a.attempt_id) } })
      healedTasks.push({ project: t.project, id: t.id, reason: 'doing-no-live-attempt' })
    }
  })
  return { runs: healedRuns, tasks: healedTasks, at }
}

/** 门禁式体检：库里有没有"看起来绿其实不可能绿"的东西（交付门/体检共用） */
export function auditDb (db, { project }) {
  if (!project) throw new BadRequestError('auditDb 缺 project')
  const problems = []
  const tasks = listTasks(db, { project })
  const byId = new Map(tasks.map(t => [t.id, t]))
  for (const t of tasks) {
    if (t.status === 'done') {
      const done = db.prepare("SELECT attempt_id FROM attempts WHERE project = ? AND task_id = ? AND state = 'completed'").all(project, t.id)
      if (!done.length) problems.push({ code: 'done-without-attempt', taskId: t.id, msg: '卡是 done 但没有任何 completed 的 attempt 收据（不得显示完成）' })
    }
    for (const d of t.depends) {
      if (!byId.has(d)) problems.push({ code: 'dangling-dependency', taskId: t.id, msg: `依赖的卡不存在：${d}` })
    }
  }
  const openHalts = listHalts(db, { project, status: 'open' })
  const runningRuns = listRuns(db, { project, state: 'running' })
  for (const r of runningRuns) {
    if (!r.endedAt && r.deadlineMs > 0 && Date.now() - Date.parse(r.startedAt) > r.deadlineMs) {
      problems.push({ code: 'run-over-deadline', runId: r.runId, msg: `run 超过 deadline 还在 running（应被 heal 成 aborted）` })
    }
  }
  return { ok: problems.length === 0, project, problems, counts: { tasks: tasks.length, openHalts: openHalts.length, runningRuns: runningRuns.length }, byStatus: countBy(tasks, 'status') }
}

function countBy (list, key) {
  const out = {}
  for (const x of list) out[x[key]] = (out[x[key]] ?? 0) + 1
  return out
}

export { isValidState, ENUMS }
