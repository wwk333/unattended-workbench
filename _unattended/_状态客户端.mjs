/**
 * 状态客户端 —— 编排/台账/交付门/看板 **只许通过它**读写 C 状态服务（施工文档 §三）
 *
 * ## 三条它负责的事（别的文件都不用再想）
 * 1. **诚实**：所有响应都过 `契约/信封.mjs` 的校验；服务回的东西缺信封就当**不可用**处理，
 *    不许"读到一个大概像 JSON 的东西就往下走"。
 * 2. **fail-closed**：服务不在 ⇒ 抛 `StateUnavailable`。调用方**必须**据此停手，
 *    ⛔ 绝不偷偷退回文件双写（那正是文档删掉的那条路）。
 * 3. **快速复活**：`ensure: true` 时先踢一脚 `确保状态服务.mjs`（幂等，已在跑就秒退），
 *    再在 `recoveryBudgetMs`（默认 5 秒）内重试 —— 对应 §七「活跃客户端发现服务不可用要立即调 ensure 并重试，目标 ≤5 秒恢复」。
 */

import { spawn } from 'node:child_process'
import { normProject } from './_状态库.mjs'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateEnvelope } from './契约/信封.mjs'
import { DEFAULT_PORT } from './_状态常量.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/**
 * 连接池：**本进程内复用**（keep-alive）。
 * ★ 为什么不用全局 `fetch`：实测 undici 的 fetch 每跳约 14.9ms（1000 次 14.9 秒），
 *   同样的服务用 `node:http` + keepAlive Agent 是 **0.52ms/次**（300 次 157ms）。
 *   状态写入是编排的关键路径，差这十几毫秒会被放大到每个 attempt 上，所以这里用 http 原生实现。
 */
const AGENT = new http.Agent({ keepAlive: true, maxSockets: 16, keepAliveMsecs: 15_000 })

export class StateError extends Error {
  constructor (code, message, detail) {
    super(`[状态客户端] ${message}${detail ? `（${detail}）` : ''}`)
    this.name = 'StateError'
    this.code = code
    this.detail = detail ?? null
  }
}

/** 服务不可用：**必须 fail-closed**，不许退回文件双写 */
export class StateUnavailable extends StateError {
  constructor (message, detail) { super('E_STATE_UNAVAILABLE', message, detail); this.name = 'StateUnavailable' }
}

/** 服务回的业务错误（4xx/409）：调用方按状态码决定重试还是停手 */
export class StateRejected extends StateError {
  constructor (status, message, detail, payload) {
    super(`E_STATE_${status}`, message, detail)
    this.name = 'StateRejected'
    this.status = status
    this.payload = payload ?? null
    this.conflict = status === 409
    this.notFound = status === 404
    this.badRequest = status === 400
  }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))

export class StateClient {
  constructor ({ port = Number(process.env.DSH_CREW_STATE_PORT ?? DEFAULT_PORT), host = '127.0.0.1', timeoutMs = 8000, ensure = false, recoveryBudgetMs = 5000, log = null } = {}) {
    this.base = `http://${host}:${port}`
    this.port = port
    this.host = host
    this.timeoutMs = timeoutMs
    this.ensure = ensure
    this.recoveryBudgetMs = recoveryBudgetMs
    this.log = log
  }

  url (path) { return this.base + path }

  /** 起一次 ensure（幂等）：detached，不阻塞调用方 */
  kickEnsure () {
    try {
      const child = spawn(process.execPath, [join(HERE, '确保状态服务.mjs')], {
        cwd: join(HERE, '..'),
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      })
      child.unref()
      return true
    } catch (e) {
      this.log?.(`[状态客户端] ensure 起不来：${e.message}`)
      return false
    }
  }

  /**
   * 一次底层调用。网络层失败按 `retry` 处理；业务 4xx 直接抛 StateRejected（不重试，避免重复写）。
   */
  async call (method, path, { body = null, idempotencyKey = null, retries = 2 } = {}) {
    const startedAt = Date.now()
    let attempt = 0
    let lastErr = null
    let kickedEnsure = false
    while (attempt <= retries) {
      attempt++
      try {
        const { status, payload } = await this.request(method, path, body, idempotencyKey)
        if (status >= 400) {
          const msg = payload?.error?.message ?? `HTTP ${status}`
          throw new StateRejected(status, msg, `${method} ${path}`, payload)
        }
        const v = validateEnvelope(payload)
        if (!v.ok) {
          throw new StateUnavailable('服务回了不合规的响应（缺信封）', `${method} ${path} missing=${v.missing.join(',')} bad=${v.bad.join(';')}`)
        }
        return { ...payload, _elapsedMs: Date.now() - startedAt, _attempts: attempt }
      } catch (e) {
        if (e instanceof StateRejected) throw e
        lastErr = e
        const code = e.cause?.code ?? e.code
        const isNet = code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'ETIMEDOUT' || e.name === 'AbortError' || e.timeout === true
        if (!isNet) throw e
        if (this.ensure && !kickedEnsure && Date.now() - startedAt < this.recoveryBudgetMs) {
          kickedEnsure = true
          this.log?.(`[状态客户端] ${path} 连不上，踢 ensure 复活服务`)
          this.kickEnsure()
        }
        if (attempt > retries) break
        await sleep(Math.min(200 * attempt, 600))
      }
    }
    throw new StateUnavailable(`${method} ${path} 连不上状态服务（fail-closed：不退回文件双写）`, lastErr?.cause?.code ?? lastErr?.code ?? lastErr?.message ?? 'unknown')
  }

  /** 最小 HTTP 实现（keep-alive 连接池）；只用来打本机 loopback */
  request (method, path, body, idempotencyKey) {
    // ★ 2026-10-26：项目路径必须在**出口**归一（相对/绝对、正斜杠/反斜杠都算同一个项目）
      const normBody = body && Object.hasOwn(body, 'project') ? { ...body, project: normProject(body.project) } : body
      const payload = normBody === null ? null : Buffer.from(JSON.stringify(normBody), 'utf8')
    const headers = { accept: 'application/json' }
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = payload.length
    }
    // ★ 幂等键里常带项目绝对路径（`C:\...` 或中文）—— 直接塞 header 会 `ERR_INVALID_CHAR`（实测踩过）。
    //   这里统一编码：确定性、可复现，服务端存的也是编码后的串。
    if (idempotencyKey) headers['idempotency-key'] = encodeURIComponent(String(idempotencyKey)).slice(0, 900)
    return new Promise((resolve, reject) => {
      const req = http.request({ host: this.host, port: this.port, path, method, agent: AGENT, headers }, (res) => {
        const chunks = []
        res.on('data', c => chunks.push(c))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try { json = text ? JSON.parse(text) : {} } catch { json = null }
          resolve({ status: res.statusCode ?? 0, payload: json })
        })
      })
      req.setTimeout(this.timeoutMs, () => { const e = new Error('timeout'); e.code = 'ETIMEDOUT'; req.destroy(e) })
      req.on('error', reject)
      if (payload) req.write(payload)
      req.end()
    })
  }

  // ---------------- 读
  async health () { return this.call('GET', '/health', { retries: 2 }) }
  async db () { return this.call('GET', '/v1/db') }
  async tasks (project, status = null) {
    const q = new URLSearchParams({ project: normProject(project), ...(status ? { status } : {}) })
    return (await this.call('GET', `/v1/tasks?${q}`)).data.tasks
  }
  async task (project, id) { return (await this.call('GET', `/v1/tasks/${encodeURIComponent(id)}?project=${encodeURIComponent(normProject(project))}`)).data }
  async ready (project) { return (await this.call('GET', `/v1/ready?project=${encodeURIComponent(project)}`)).data.tasks }
  async runs ({ project = null, state = null } = {}) {
    const q = new URLSearchParams({ ...(project ? { project: normProject(project) } : {}), ...(state ? { state } : {}) })
    return (await this.call('GET', `/v1/runs?${q}`)).data.runs
  }
  async run (runId) { return (await this.call('GET', `/v1/runs/${encodeURIComponent(runId)}`)).data }
  async attempts ({ runId, project = null, taskId = null, state = null, limit = 100 } = {}) {
    const q = new URLSearchParams({ ...(runId ? { runId } : {}), ...(project ? { project: normProject(project) } : {}), ...(taskId ? { taskId } : {}), ...(state ? { state } : {}), limit: String(limit) })
    return (await this.call('GET', `/v1/attempts?${q}`)).data.attempts
  }
  async budget ({ runId, taskId }) {
    const q = new URLSearchParams({ runId, taskId })
    return (await this.call('GET', `/v1/budget?${q}`)).data
  }
  async halts (project, status = 'open') {
    const q = new URLSearchParams({ project: normProject(project), ...(status ? { status } : {}) })
    return (await this.call('GET', `/v1/halts?${q}`)).data.halts
  }
  async reworks (project, taskId = null) {
    const q = new URLSearchParams({ project, ...(taskId ? { taskId } : {}) })
    return (await this.call('GET', `/v1/reworks?${q}`)).data.reworks
  }
  async audit (project) { return (await this.call('GET', `/v1/audit?project=${encodeURIComponent(project)}`)).data }
  async events ({ project = null, since = 0, limit = 200 } = {}) {
    const q = new URLSearchParams({ since: String(since), limit: String(limit), ...(project ? { project } : {}) })
    return (await this.call('GET', `/v1/events?${q}`)).data.events
  }

  // ---------------- 写（统一带幂等键：网络重试不会重复落库）
  async upsertTask (task, { idempotencyKey = null } = {}) {
    return (await this.call('POST', '/v1/tasks', { body: task, idempotencyKey })).data
  }
  async setTaskStatus ({ project, id, from = null, to, expectedVersion, evidence = null, source = null, idempotencyKey = null }) {
    return (await this.call('POST', `/v1/tasks/${encodeURIComponent(id)}/status`, {
      body: { project, from, to, expectedVersion, evidence, source },
      idempotencyKey: idempotencyKey ?? `status-${project}-${id}-${expectedVersion}-${to}`
    })).data
  }
  async assignRole ({ project, id, role, expectedVersion = null, idempotencyKey = null }) {
    return (await this.call('POST', `/v1/tasks/${encodeURIComponent(id)}/assign`, {
      body: { project, role, expectedVersion },
      idempotencyKey: idempotencyKey ?? `assign-${project}-${id}-${role}`
    })).data
  }
  async startRun ({ runId, project, snapshotId = null, pid = null, deadlineMs = 0, idempotencyKey = null }) {
    return (await this.call('POST', '/v1/runs', { body: { runId, project, snapshotId, pid, deadlineMs }, idempotencyKey: idempotencyKey ?? `run-${runId}` })).data
  }
  async finishRun ({ runId, state, reason = null, lastCompletedTask = null, idempotencyKey = null }) {
    return (await this.call('POST', `/v1/runs/${encodeURIComponent(runId)}/finish`, {
      body: { state, reason, lastCompletedTask },
      idempotencyKey: idempotencyKey ?? `run-finish-${runId}`
    })).data
  }
  async heartbeat (runId) { return (await this.call('POST', `/v1/runs/${encodeURIComponent(runId)}/heartbeat`, { body: {} })).data }
  async updateProgress (runId, { inflight, results, rework } = {}) {
    return (await this.call('POST', `/v1/runs/${encodeURIComponent(runId)}/progress`, { body: { inflight, results, rework } })).data
  }
  async startAttempt (a, { idempotencyKey = null } = {}) {
    return (await this.call('POST', '/v1/attempts', { body: a, idempotencyKey: idempotencyKey ?? `attempt-${a.attemptId}` })).data
  }
  async finishAttempt ({ attemptId, state, failure = null, actual = null, sessionId = null, reason = null, ctxPeak = null, compactions = null, firstCompactionTokens = null, idempotencyKey = null }) {
    return (await this.call('POST', `/v1/attempts/${encodeURIComponent(attemptId)}/finish`, {
      body: { state, failure, actual, sessionId, reason, ctxPeak, compactions, firstCompactionTokens },
      idempotencyKey: idempotencyKey ?? `attempt-finish-${attemptId}`
    })).data
  }
  async openHalt (h, { idempotencyKey = null } = {}) {
    return (await this.call('POST', '/v1/halts', { body: h, idempotencyKey })).data
  }
  async closeHalt ({ haltId, by, evidence = null, matched = false, idempotencyKey = null }) {
    return (await this.call('POST', `/v1/halts/${encodeURIComponent(haltId)}/close`, { body: { by, evidence, matched }, idempotencyKey: idempotencyKey ?? `halt-close-${haltId}` })).data
  }
  async addRework (r) { return (await this.call('POST', '/v1/reworks', { body: r })).data }
  async heal ({ project = null, now = null } = {}) { return (await this.call('POST', '/v1/heal', { body: { project, now } })).data }
  async command ({ op, project = null, text = null, taskId = null, runId = null }) {
    return (await this.call('POST', '/v1/command', { body: { op, project, text, taskId, runId } })).data
  }

  /**
   * **开工前必须过这一关**：服务活着我才开工。
   * 服务不在 ⇒ 抛 StateUnavailable，调用方必须停手（fail-closed）。
   */
  async requireReady () {
    try {
      const h = await this.health()
      if (!h.ok || h.db?.writeOk === false) {
        throw new StateUnavailable('状态服务在，但库写不进去（health 不绿）', h.db?.writeError ?? 'writeOk=false')
      }
      return h
    } catch (e) {
      if (e instanceof StateUnavailable) throw e
      throw new StateUnavailable('状态服务不可用：本轮必须 fail-closed，不许退回文件双写', e.message)
    }
  }
}

export function clientFor (opts) { return new StateClient(opts) }

/** 默认单例（进程内共用一条 keep-alive 连接池） */
let SINGLETON = null
export function sharedClient (opts = {}) {
  if (!SINGLETON) SINGLETON = new StateClient(opts)
  return SINGLETON
}
