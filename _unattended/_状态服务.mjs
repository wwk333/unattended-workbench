#!/usr/bin/env node
/**
 * C 状态服务 —— 独立状态机服务（施工文档 §三）
 *
 * 形态：本机 loopback HTTP + 一个 SQLite 单文件库（`_crew/state/crew.db`）。
 * 不引数据库服务器，不引第三方依赖（`node:sqlite` 是 Node v24 自带的）。
 *
 * ## 它凭什么存在
 * 以前"任务状态"散在 `TASKS.md`（人也能改）、`_crew/running/*.json`（进程一死就残留）、
 * `编排.mjs` 的内存变量（`REWORKS`）三处：**同一件事三个说法**，而且进程被 kill 时
 * 连一份收据都没有（7 个 run 缺 `verdict.json` 是真事）。文档 §三 的结论是：
 * 状态权威收归一个服务，开工第一件事就写收据。
 *
 * ## 消费方（谁在用这个服务）
 * - `编排.mjs`：唯一推进状态的角色（读 ready / 写 run / 写 attempt）；
 * - `台账.mjs`：done 门校验（读 run 终态 + attempt 收据）；
 * - `交付门.mjs`：读 run 终态、review pass、快照；
 * - `TASKS.md 生成器`：把库导成生成视图；
 * - 看板/体检：只读；
 * - 自愈器：`ensure=确保状态服务.mjs`。
 *
 * ## 铁律
 * 1. 服务不可用 ⇒ **fail-closed**，绝不偷偷退回文件双写（客户端 `_状态客户端.mjs` 负责这一步）。
 * 2. 状态值只走 `契约/枚举.mjs`；`attempt=blocked` / `run=done` 在这里就是 400。
 * 3. 所有变更带 `expectedVersion`；冲突回 409，不静默覆盖。
 * 4. `Idempotency-Key` 重放只返回第一次的结果。
 *
 * ## 用法
 *   node _状态服务.mjs [--port 19460] [--db <路径>] [--quiet]
 *   node _状态服务.mjs --probe        # 只打 /health 看活没活（不起服务）
 */

import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  openDb, dbInfo, heal, logEvent, listEvents,
  upsertTask, getTask, findTask, listTasks, setTaskStatus, assignRole, readyTasks,
  startRun, getRun, listRuns, finishRun, heartbeat, updateRunProgress,
  startAttempt, getAttempt, listAttempts, finishAttempt, budgetUsed,
  openHalt, getHalt, listHalts, closeHalt, addRework, listReworks,
  auditDb, CODING_BUDGET, BadRequestError, ConflictError, NotFoundError
} from './_状态库.mjs'
import { DEFAULT_PORT, DEFAULT_DB, SERVICE_NAME as TAG } from './_状态常量.mjs'
import { normProject } from './_状态库.mjs'

const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const has = n => argv.includes('--' + n)

const PORT = Number(opt('port', process.env.DSH_CREW_STATE_PORT ?? DEFAULT_PORT))
const DB_PATH = resolve(opt('db', process.env.DSH_CREW_STATE_DB ?? DEFAULT_DB))
const QUIET = has('quiet')
const HEAL_MS = Number(opt('heal-interval', 60_000))

if (has('probe')) {
  const r = await fetch(`http://127.0.0.1:${Number(opt('port', DEFAULT_PORT))}/health`).then(x => x.json()).catch(() => null)
  if (r?.ok) { console.log(JSON.stringify(r, null, 2)); process.exit(0) }
  console.error('[状态服务] probe：没活')
  process.exit(1)
}

const db = openDb({ dbPath: DB_PATH })
const startedAt = new Date().toISOString()

// ---- 启动即自愈：上一次被强杀的 run / 卡住的 doing 在这里收口（§三「doing 自愈」）
const bootHeal = heal(db)
if (!QUIET && (bootHeal.runs.length || bootHeal.tasks.length)) {
  console.log(`[${TAG}] 启动自愈：run ${bootHeal.runs.length} 个改 aborted，doing ${bootHeal.tasks.length} 张回 pending`)
}

// ---------------------------------------------------------------- 响应工具

function envelopeOf (kind, state, extra = {}) {
  return { schema: 1, kind, at: new Date().toISOString(), source: TAG, state, stale: false, ...extra }
}

function send (res, status, body) {
  const text = JSON.stringify(body, null, 1)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text), 'cache-control': 'no-store' })
  res.end(text)
}

const ok = (res, kind, data) => send(res, 200, envelopeOf(kind, 'ok', { ok: true, data }))
/** 错误 → HTTP 状态码。枚举违规（`契约/枚举.mjs` 的 StateError，code=E_STATE）是**调用方的错**，必须是 400 而不是 500。 */
function statusOf (err) {
  if (err?.httpStatus) return err.httpStatus
  if (err instanceof BadRequestError) return 400
  if (err instanceof ConflictError) return 409
  if (err instanceof NotFoundError) return 404
  if (err?.code === 'E_STATE' || err?.name === 'StateError') return 400
  return 500
}
function fail (res, err) {
  send(res, statusOf(err), envelopeOf('error', 'error', { ok: false, error: { code: err.code ?? 'E_INTERNAL', message: err.message, detail: err.detail ?? null } }))
}

function readBody (req, limit = 4 * 1024 * 1024) {
  return new Promise((res2, rej) => {
    let size = 0
    const chunks = []
    req.on('data', c => {
      size += c.length
      if (size > limit) { rej(new BadRequestError('请求体过大', `${size}B`)); req.destroy(); return }
      chunks.push(c)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (!raw) return res2({})
      try {
        const j = JSON.parse(raw)
        // ★ 2026-10-26：入口也归一 —— 客户端版本不一致时也不能把同一个项目写成两个 key
        if (j && typeof j === 'object' && Object.hasOwn(j, 'project')) j.project = normProject(j.project)
        res2(j)
      } catch (e) { rej(new BadRequestError('请求体不是合法 JSON', e.message)) }
    })
    req.on('error', rej)
  })
}

/**
 * 幂等包装：同一 key 重放只回放第一次的结果，不重复落库。
 *
 * ★ 返回**永远是完整信封** `{status, body}`：调用方统一 `send(res, out.status, out.body)`。
 *   早先版本在"带 key 的新请求"上返回了 `{replayed,status,body}` 包装，结果 `data` 变成了包装对象
 *   （实测把 `data.status===200` 当成任务状态读，deliverables 全看不出来）—— 这类"形状不一致"最容易养出假绿。
 */
async function withIdem (req, body, kind, fn) {
  const key = req.headers['idempotency-key'] ?? body?.idempotencyKey ?? null
  if (!key) return { status: 200, body: envelopeOf(kind, 'ok', { ok: true, data: fn() }) }
  const { idemGet, idemPut } = await import('./_状态库.mjs')
  const hit = idemGet(db, key)
  if (hit) return { status: hit.statusCode, body: hit.body, replayed: true }
  const payload = envelopeOf(kind, 'ok', { ok: true, data: fn() })
  idemPut(db, key, kind, 200, payload)
  return { status: 200, body: payload }
}

// ---------------------------------------------------------------- 路由

const ROUTES = []
/** 注册一条路由：`pattern` 支持 `:param` 片段 */
function route (method, pattern, handler) {
  const segs = pattern.split('/').filter(Boolean)
  ROUTES.push({ method, segs, handler, pattern })
}
function match (method, pathSegs) {
  for (const r of ROUTES) {
    if (r.method !== method) continue
    if (r.segs.length !== pathSegs.length) continue
    const params = {}
    let okMatch = true
    for (let i = 0; i < r.segs.length; i++) {
      const s = r.segs[i]
      if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(pathSegs[i])
      else if (s !== pathSegs[i]) { okMatch = false; break }
    }
    if (okMatch) return { r, params }
  }
  return null
}

// ---- 健康（critical 资源；看护/自愈器靠它判活）
route('GET', '/health', ({ res }) => {
  const info = dbInfo(db)
  let writeOk = true
  let writeError = null
  try {
    // 真写一次性能够用的探针：health 自己不许是"假绿"（库只读/锁死时要能看出来）
    db.prepare('INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)').run('health_probe', new Date().toISOString())
  } catch (e) { writeOk = false; writeError = e.message }
  send(res, writeOk ? 200 : 503, envelopeOf('health', writeOk ? 'ok' : 'red', {
    ok: writeOk,
    pid: process.pid,
    port: PORT,
    startedAt,
    uptimeMs: Date.now() - Date.parse(startedAt),
    db: { path: DB_PATH, exists: existsSync(DB_PATH), ...info, writeOk, writeError },
    budget: { codingPerTaskPerRun: CODING_BUDGET },
    source: TAG
  }))
})

route('GET', '/v1/db', ({ res }) => ok(res, 'db-info', { path: DB_PATH, ...dbInfo(db) }))

// ---- task
route('POST', '/v1/tasks', async ({ req, res }) => {
  const body = await readBody(req)
  const out = await withIdem(req, body, 'task-upsert', () => upsertTask(db, body))
  send(res, out.status, out.body)
})
route('GET', '/v1/tasks', ({ res, url }) => {
  const project = url.searchParams.get('project')
  if (!project) throw new BadRequestError('listTasks 缺 project')
  ok(res, 'tasks', { project, tasks: listTasks(db, { project, status: url.searchParams.get('status') }) })
})
route('GET', '/v1/tasks/:id', ({ res, url, params }) => {
  const project = url.searchParams.get('project')
  if (!project) throw new BadRequestError('读单卡缺 project')
  const t = findTask(db, project, params.id)
  if (!t) throw new NotFoundError(`没有这张卡：${project} / ${params.id}`)
  ok(res, 'task', t)
})
route('POST', '/v1/tasks/:id/status', async ({ req, res, params }) => {
  const body = await readBody(req)
  const out = await withIdem(req, body, 'task-status', () => setTaskStatus(db, { ...body, id: body.id ?? params.id }))
  send(res, out.status, out.body)
})
route('POST', '/v1/tasks/:id/assign', async ({ req, res, params }) => {
  const body = await readBody(req)
  const out = await withIdem(req, body, 'task-assign', () => assignRole(db, { ...body, id: body.id ?? params.id }))
  send(res, out.status, out.body)
})
route('GET', '/v1/ready', ({ res, url }) => {
  const project = url.searchParams.get('project')
  if (!project) throw new BadRequestError('ready 缺 project')
  ok(res, 'ready', { project, tasks: readyTasks(db, { project }) })
})

// ---- run
route('POST', '/v1/runs', async ({ req, res }) => {
  const body = await readBody(req)
  const out = await withIdem(req, body, 'run-start', () => startRun(db, body))
  send(res, out.status, out.body)
})
route('GET', '/v1/runs', ({ res, url }) => {
  ok(res, 'runs', { runs: listRuns(db, { project: url.searchParams.get('project'), state: url.searchParams.get('state') }) })
})
route('GET', '/v1/runs/:id', ({ res, params }) => ok(res, 'run', getRun(db, params.id)))
route('POST', '/v1/runs/:id/finish', async ({ req, res, params }) => {
  const body = await readBody(req)
  const out = await withIdem(req, body, 'run-finish', () => finishRun(db, { ...body, runId: body.runId ?? params.id }))
  send(res, out.status, out.body)
})
route('POST', '/v1/runs/:id/heartbeat', async ({ req, res, params }) => {
  const body = await readBody(req)
  heartbeat(db, { runId: params.id, at: body.at })
  ok(res, 'heartbeat', { runId: params.id, at: new Date().toISOString() })
})
route('POST', '/v1/runs/:id/progress', async ({ req, res, params }) => {
  const body = await readBody(req)
  ok(res, 'run', updateRunProgress(db, { ...body, runId: params.id }))
})

// ---- attempt
route('POST', '/v1/attempts', async ({ req, res }) => {
  const body = await readBody(req)
  const out = await withIdem(req, body, 'attempt-start', () => startAttempt(db, body))
  send(res, out.status, out.body)
})
route('GET', '/v1/attempts', ({ res, url }) => {
  ok(res, 'attempts', {
    attempts: listAttempts(db, {
      runId: url.searchParams.get('runId'),
      project: url.searchParams.get('project'),
      taskId: url.searchParams.get('taskId'),
      state: url.searchParams.get('state'),
      limit: Number(url.searchParams.get('limit') ?? 100)
    })
  })
})
route('GET', '/v1/attempts/:id', ({ res, params }) => ok(res, 'attempt', getAttempt(db, params.id)))
route('POST', '/v1/attempts/:id/finish', async ({ req, res, params }) => {
  const body = await readBody(req)
  const out = await withIdem(req, body, 'attempt-finish', () => finishAttempt(db, { ...body, attemptId: body.attemptId ?? params.id }))
  send(res, out.status, out.body)
})
route('GET', '/v1/budget', ({ res, url }) => {
  const runId = url.searchParams.get('runId')
  const taskId = url.searchParams.get('taskId')
  if (!runId || !taskId) throw new BadRequestError('budget 需要 runId 和 taskId')
  const used = budgetUsed(db, { runId, taskId })
  ok(res, 'budget', { runId, taskId, used, limit: CODING_BUDGET, remaining: Math.max(0, CODING_BUDGET - used) })
})

// ---- halt / rework
route('POST', '/v1/halts', async ({ req, res }) => {
  const body = await readBody(req)
  const out = await withIdem(req, body, 'halt-open', () => openHalt(db, body))
  send(res, out.status, out.body)
})
route('GET', '/v1/halts', ({ res, url }) => {
  const project = url.searchParams.get('project')
  if (!project) throw new BadRequestError('halts 缺 project')
  ok(res, 'halts', { project, halts: listHalts(db, { project, status: url.searchParams.get('status') }) })
})
route('GET', '/v1/halts/:id', ({ res, params }) => ok(res, 'halt', getHalt(db, params.id)))
route('POST', '/v1/halts/:id/close', async ({ req, res, params }) => {
  const body = await readBody(req)
  const out = await withIdem(req, body, 'halt-close', () => closeHalt(db, { ...body, haltId: body.haltId ?? params.id }))
  send(res, out.status, out.body)
})
route('POST', '/v1/reworks', async ({ req, res }) => {
  const body = await readBody(req)
  ok(res, 'rework', addRework(db, body))
})
route('GET', '/v1/reworks', ({ res, url }) => {
  const project = url.searchParams.get('project')
  if (!project) throw new BadRequestError('reworks 缺 project')
  ok(res, 'reworks', { project, reworks: listReworks(db, { project, taskId: url.searchParams.get('taskId') }) })
})

// ---- 运维
route('POST', '/v1/heal', async ({ req, res }) => {
  const body = await readBody(req)
  ok(res, 'heal', heal(db, { now: body.now ? Date.parse(body.now) : Date.now(), project: body.project ?? null }))
})
route('GET', '/v1/events', ({ res, url }) => {
  ok(res, 'events', { events: listEvents(db, { project: url.searchParams.get('project'), since: Number(url.searchParams.get('since') ?? 0), limit: Number(url.searchParams.get('limit') ?? 200) }) })
})
route('GET', '/v1/audit', ({ res, url }) => {
  const project = url.searchParams.get('project')
  if (!project) throw new BadRequestError('audit 缺 project')
  const r = auditDb(db, { project })
  send(res, r.ok ? 200 : 200, envelopeOf('audit', r.ok ? 'ok' : 'red', { ok: r.ok, data: r }))
})

// ---- 操作区：面板的操作必须走这里（§十），不直接改文件
route('POST', '/v1/command', async ({ req, res }) => {
  const body = await readBody(req)
  const op = body.op
  if (!op) throw new BadRequestError('command 缺 op')
  const allowed = ['send', 'stop', 'resume', 'frame', 'ensure', 'run']
  if (!allowed.includes(op)) throw new BadRequestError(`操作区命令未登记：${op}（只允许 ${allowed.join('/')}）`)
  const id = `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  logEvent(db, { project: body.project ?? null, kind: 'command', subject: id, source: '面板', payload: { op, text: body.text ?? null, taskId: body.taskId ?? null, runId: body.runId ?? null } })
  ok(res, 'command', { id, op, accepted: true, at: new Date().toISOString() })
})

// ---------------------------------------------------------------- 服务

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`)
  // ★ 2026-10-26：**查询串里的 project 也要归一** —— 否则用 `X:/...` 查不到 `x:/...` 的行
  //   （body 那条路已经在 readBody 里归过了，漏了 query 就会出现"写得进、读不出"）。
  if (url.searchParams.has('project')) url.searchParams.set('project', normProject(url.searchParams.get('project')))
  const segs = url.pathname.split('/').filter(Boolean)
  const hit = match(req.method, segs)
  if (!hit) {
    return send(res, 404, envelopeOf('error', 'error', { ok: false, error: { code: 'E_NO_ROUTE', message: `没有这个端点：${req.method} ${url.pathname}` } }))
  }
  Promise.resolve()
    .then(() => hit.r.handler({ req, res, url, params: hit.params }))
    .catch(err => fail(res, err))
})
server.keepAliveTimeout = 65_000
server.requestTimeout = 30_000
server.headersTimeout = 70_000

function onListenError (err) {
  if (err.code === 'EADDRINUSE') {
    console.error(`[${TAG}] 端口 ${PORT} 已被占用 —— 拒绝起第二个实例（同一状态库只能有一个写者）`)
    process.exit(3)
  }
  console.error(`[${TAG}] 起不来：${err.message}`)
  process.exit(1)
}
server.on('error', onListenError)

server.listen(PORT, '127.0.0.1', () => {
  const actual = server.address().port
  // ★ `--port 0` 时由系统分配；把**真实端口**打出来，测试/ensure 据此连接（别猜）。
  console.log(`[${TAG}] READY http://127.0.0.1:${actual} db=${DB_PATH} pid=${process.pid} port=${actual}`)
})

const healTimer = setInterval(() => {
  try {
    const r = heal(db)
    if (r.runs.length || r.tasks.length) {
      console.log(`[${TAG}] 自愈：run ${r.runs.length} → aborted，doing ${r.tasks.length} → pending`)
    }
  } catch (e) {
    console.error(`[${TAG}] 自愈失败：${e.message}`)
  }
}, HEAL_MS)
healTimer.unref?.()

function shutdown (sig) {
  console.log(`[${TAG}] 收到 ${sig}，收口退出`)
  clearInterval(healTimer)
  server.close(() => { try { db.close() } catch {} ; process.exit(0) })
  setTimeout(() => process.exit(0), 1500).unref?.()
}
process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))

export { server, db }
