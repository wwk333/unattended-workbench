/**
 * dsh-crew-bridge —— 班组换会话桥（仅 host 半，无界面）。
 *
 * 来源：退役的 dsh-board-sidebar 宿主侧桥代码（19390）。工作台 2026-10-10 把桥
 * 从 sidebar 搬到独立插件；本文件是升级事故后按退役备份重建的 host-only 版本。
 *
 * 只做两件事：
 *   1. GET  /board  —— 只读看板数据（不带 token，只 bind 127.0.0.1）
 *   2. POST /swap   —— token 鉴权的换会话/工作区操作
 */
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'

/**
 * ★ 2026-10-18（b127）：**路径全部改成"按插件自身位置推导"**
 *   用户口径：*"把插件里写死的绝对路径统一改成'按自身位置推导'"*。
 *
 * ## 为什么必须改
 *   这些常量原来全是 `<工作台根>\\...` **写死的绝对路径** —— 开源用户把工作台装到别的盘（或改个目录名），
 *   整条"后台链"就**全部失效**：工具服务、面板、看守一个都起不来。
 *   而症状是"**界面好好的、后台全哑**"（插件本身是宿主按配置里的绝对路径加载的，所以它还能跑）
 *   ⇒ 这是最难查的一类故障。开箱即用的前提就是**不认盘符**。
 *
 * ## 推导基线
 *   本文件 ＝ `<工作台>\_unattended\bridge-plugin\lib\index.js`
 *   ⇒ 上两级 ＝ `_unattended`；再上一级 ＝ **工作台根**。（`apply()` 是宿主加载进来的，`import.meta.url` 一定准。）
 *   ⚠️ 环境变量**仍然优先**（`DSH_*`）—— 探针/测试可以把任何一条指到临时目录去造现场。
 */
const LIB_DIR = dirname(fileURLToPath(import.meta.url))
const UNATTENDED_DIR = resolve(LIB_DIR, '..', '..')
const WORKSPACE_DIR = resolve(UNATTENDED_DIR, '..')
/** 环境变量优先，否则按工作台位置拼。 */
const at = (envName, ...parts) => process.env[envName] ?? join(...parts)

export const name = 'dsh-crew-bridge'

const BUILD_TAG = 'crew-bridge@2026-10-18-b127'
// ★ 2026-10-18（用户要求补回）：**插件自己的落盘日志**。
//   为什么必须有：`console.*` 在宿主里**不一定落盘** —— 2026-10-11 重启排查时
//   `logs\crew-bridge.log` 一个字都没有，只能靠猜（那次「桥到底有没有 apply」靠 19390 端口反推）。
//   日志路径固定在工作台 `_unattended\logs\crew-bridge.log`（随备份一起走）。
//   ★ b127：改成**按插件位置推导**（原来写死 `<工作台根>\...`）。
const LOG_FILE = at('DSH_BRIDGE_LOG', UNATTENDED_DIR, 'logs', 'crew-bridge.log')
function rlog (s) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`
  try { mkdirSync(dirname(LOG_FILE), { recursive: true }); appendFileSync(LOG_FILE, line + '\n', 'utf8') } catch {}
  console.log('[dsh-crew-bridge] ' + s)
}
rlog(`module loaded: ${BUILD_TAG}`)

const SWAP_PORT = Number(process.env.DSH_SWAP_PORT ?? 19390)
// ── ★ b127：**下面这些原来全是写死的 `<工作台根>\...`，现在一律按工作台位置推导** ──────────
const SWAP_TOKEN_FILE = at('DSH_SWAP_TOKEN_FILE', UNATTENDED_DIR, 'secrets', 'swap-token.txt')
const DATA_FILE = at('DSH_BOARD_DATA', WORKSPACE_DIR, '_crew', 'board-data.json')
const PRODUCER_FILE = at('DSH_BOARD_PRODUCER', UNATTENDED_DIR, '看板数据.mjs')
const ENSURE_SCRIPT = at('DSH_ENSURE_WATCH', UNATTENDED_DIR, '确保看守.mjs')
const TOOL_ENSURE = at('DSH_ENSURE_TOOLS', UNATTENDED_DIR, '确保工具服务.mjs')
const PANEL_DIR = at('DSH_PANEL_DIR', UNATTENDED_DIR, '面板')
const PANEL_SERVICE = join(PANEL_DIR, 'service.mjs')
// ★ b126：外壳装机（桌面/开始菜单快捷方式）—— 只跑 `--autostart` 那一档（首启只记「待问」、一个都不建）。
const SHELL_ENSURE = at('DSH_SHELL_ENSURE', UNATTENDED_DIR, '装外壳.mjs')
const SHELL_LOG = at('DSH_SHELL_LOG', UNATTENDED_DIR, 'logs', '装外壳.log')
const TTL_SEC = 60

/**
 * ★ b127：**它要的 node 在哪** —— 原来写死 `<DSH根>\\resources\\runtime\\...\\node.exe`，
 *   开源用户桌面端装在别处（或版本不同、目录结构变）就 spawn 不起来。
 *   按可靠性依次找（**每一步都验存在**，绝不返回一个不存在的路径去 spawn）：
 *     ① 环境变量 `DSH_NODE_EXE`（显式指定最优先）
 *     ② `<resources>\runtime\primary-runtime\dependencies\node\bin\node.exe`
 *        —— Electron 的 `process.resourcesPath` 就指 `<桌面端>\resources`
 *     ③ 从 `process.execPath` 往上推同一个相对路径（`process.resourcesPath` 拿不到时的退路）
 *     ④ 宿主自己就是 node 本体（非 Electron 宿主）⇒ 用 `process.execPath`
 *     ⑤ 都找不到 ⇒ `node`（交给 PATH —— 开源用户通常自己装了 node）
 *   ⚠️ **不许**在没验存在的情况下用 `process.execPath`：DSH 是 Electron，execPath 是**桌面端 exe**，
 *      拿它去跑 `.mjs` 会**又启动一个 DSH**（不是"报个错"那么轻）。
 */
function pickNodeExe () {
  const env = process.env.DSH_NODE_EXE
  if (env && existsSync(env)) return env
  const rel = join('runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
  const cands = []
  if (process.resourcesPath) cands.push(join(process.resourcesPath, rel))
  cands.push(join(dirname(process.execPath), 'resources', rel))
  for (const c of cands) if (existsSync(c)) return c
  if (/^node(\.exe)?$/i.test(process.execPath.split(/[\\/]/).pop() ?? '')) return process.execPath
  return 'node'
}
const NODE_EXE = pickNodeExe()

/** 给探针/自检看的**推导结果**（`_probe\_插件路径验收.mjs` 逐条核存在性）。 */
export const PATHS = {
  LIB_DIR, UNATTENDED_DIR, WORKSPACE_DIR, NODE_EXE,
  LOG_FILE, SWAP_TOKEN_FILE, DATA_FILE, PRODUCER_FILE,
  ENSURE_SCRIPT, TOOL_ENSURE, PANEL_DIR, PANEL_SERVICE, SHELL_ENSURE, SHELL_LOG
}

let refreshInFlight = false
let __server = null
export { __server }

function readOrCreateSwapToken () {
  try {
    if (existsSync(SWAP_TOKEN_FILE)) {
      const t = readFileSync(SWAP_TOKEN_FILE, 'utf8').trim()
      if (t) return t
    }
    const t = randomBytes(24).toString('hex')
    mkdirSync(dirname(SWAP_TOKEN_FILE), { recursive: true })
    writeFileSync(SWAP_TOKEN_FILE, t, 'utf8')
    return t
  } catch {
    return 'ephemeral-' + randomBytes(8).toString('hex')
  }
}

function readBody (req) {
  return new Promise((resolve, reject) => {
    let s = ''
    req.on('data', (c) => { s += c; if (s.length > (1 << 20)) { reject(new Error('body 过大')); req.destroy() } })
    req.on('end', () => resolve(s))
    req.on('error', reject)
  })
}

function readBoardData () {
  try {
    const raw = readFileSync(DATA_FILE, 'utf8')
    const d = JSON.parse(raw.replace(/^\uFEFF/, ''))
    return { ok: true, host: 'dsh-crew-bridge', generatedAt: new Date().toISOString(), source: DATA_FILE, data: d }
  } catch (e) {
    return {
      ok: false,
      host: 'dsh-crew-bridge',
      generatedAt: new Date().toISOString(),
      source: DATA_FILE,
      reason: `读不到看板数据（${String(e?.code ?? e?.message ?? e)}）`,
      hint: '还没有看板数据文件 —— 手动跑一次 `node _unattended\\看板数据.mjs` 即可'
    }
  }
}

function maybeRefreshBoardData (wantProject) {
  if (refreshInFlight) return false
  let ageSec = Infinity
  try { ageSec = (Date.now() - statSync(DATA_FILE).mtimeMs) / 1000 } catch { ageSec = Infinity }
  if (ageSec < TTL_SEC) return false
  if (!existsSync(PRODUCER_FILE)) return false
  refreshInFlight = true
  const release = () => { refreshInFlight = false }
  try {
    const args = [PRODUCER_FILE, '--quiet']
    const project = String(wantProject ?? '').trim()
    if (project) {
      try { if (statSync(project).isDirectory()) args.push('--project', project) } catch {}
    }
    const child = spawn(NODE_EXE, args, {
      cwd: dirname(PRODUCER_FILE), detached: true, windowsHide: true, stdio: 'ignore'
    })
    child.once('error', release)
    child.once('exit', release)
    child.unref()
    try { const t = setTimeout(release, 120000); t.unref?.() } catch {}
    return true
  } catch {
    release()
    return false
  }
}

function startSwapBridge (ctx) {
  const token = readOrCreateSwapToken()
  const send = (res, code, obj) => {
    try { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)) } catch {}
  }
  const server = createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && String(req.url).startsWith('/board')) {
        try {
          const u = new URL(String(req.url), 'http://127.0.0.1')
          maybeRefreshBoardData(u.searchParams.get('project'))
        } catch {}
        return send(res, 200, readBoardData())
      }
      if (req.method !== 'POST' || !String(req.url).startsWith('/swap')) return send(res, 404, { ok: false, error: 'not-found' })
      if (req.headers['x-dsh-swap-token'] !== token) return send(res, 401, { ok: false, error: 'unauthorized' })
      const req2 = JSON.parse((await readBody(req)) || '{}')
      rlog('swap op=' + String(req2.op) + (req2.sessionId ? ' session=' + String(req2.sessionId).slice(-8) : ''))
      const sc = ctx.get('sessionController')
      if (!sc) return send(res, 503, { ok: false, error: 'sessionController 不可用' })

      switch (req2.op) {
        case 'ping':
          return send(res, 200, { ok: true, host: 'dsh-crew-bridge', service: 'dsh-swap-bridge', version: 1 })
        case 'list':
          return send(res, 200, { ok: true, value: await sc.list({}, undefined) })
        case 'create': {
          const wr = ctx.get('workspaceRegistry')
          let wsId = req2.workspaceId ?? null
          let wsResolved = null
          if (!wsId && wr && req2.cwd) {
            try {
              wsResolved = await wr.resolveByPath(req2.cwd)
              if (wsResolved?.id) wsId = wsResolved.id
            } catch {}
          }
          const payload = wsId
            ? { agentPreset: req2.agentPreset, workspaceId: wsId }
            : { agentPreset: req2.agentPreset, cwd: req2.cwd }
          const created = await sc.create(payload)
          return send(res, 200, {
            ok: true,
            value: created,
            _workspace: wsResolved ? { id: wsResolved.id, path: wsResolved.path, title: wsResolved.title } : null,
            _passed: wsId ? 'workspaceId' : 'cwd'
          })
        }
        case 'prompt': {
          const ac = new AbortController()
          return send(res, 200, {
            ok: true,
            value: await sc.prompt({
              requestId: req2.requestId ?? `swap-${Date.now()}`,
              sessionId: req2.sessionId,
              mode: req2.mode ?? 'queue',
              content: Array.isArray(req2.content) ? req2.content : [{ type: 'text', text: String(req2.text ?? '') }]
            }, ac.signal)
          })
        }
        case 'cancel': {
          const ac = new AbortController()
          return send(res, 200, { ok: true, value: await sc.cancel({ sessionId: req2.sessionId }, ac.signal) })
        }
        case 'command': {
          const cmds = ctx.get('commands')
          if (!cmds) return send(res, 503, { ok: false, error: 'commands 服务不可用' })
          const line = String(req2.line ?? '')
          if (!line.trim()) return send(res, 400, { ok: false, error: '缺少 line' })
          const resolved = await sc.resolveAgent(req2.sessionId)
          if (resolved?.error) return send(res, 409, { ok: false, error: `resolveAgent 失败：${JSON.stringify(resolved.error)}` })
          const ac = new AbortController()
          const result = await cmds.execute(resolved.agent, line.trim(), [], ac.signal)
          return send(res, 200, { ok: true, value: result ?? null })
        }
        case 'workspace': {
          const wr = ctx.get('workspaceRegistry')
          if (!wr) return send(res, 503, { ok: false, error: 'workspaceRegistry 不可用' })
          const action = String(req2.action ?? 'list')
          if (action === 'list') {
            return send(res, 200, { ok: true, value: (wr.list() ?? []).map(w => ({ id: w.id, path: w.path, title: w.title })) })
          }
          if (action === 'resolve') {
            const w = await wr.resolveByPath(String(req2.path ?? ''))
            return send(res, 200, { ok: true, value: w ? { id: w.id, path: w.path, title: w.title } : null })
          }
          if (action === 'assign') {
            const wc = ctx.get('workspaceController')
            if (!wc) return send(res, 503, { ok: false, error: 'workspaceController 不可用' })
            const target = req2.workspaceId ?? (req2.path ? (await wr.resolveByPath(String(req2.path)))?.id : null)
            if (!target) return send(res, 400, { ok: false, error: '缺少 workspaceId（或 path 查不到）' })
            if (!req2.sessionId) return send(res, 400, { ok: false, error: '缺少 sessionId' })
            const v = await wc.insertSessionBefore({ workspaceId: target, sessionId: req2.sessionId })
            return send(res, 200, { ok: true, value: v })
          }
          return send(res, 400, { ok: false, error: `未知 workspace action：${action}` })
        }
        default:
          return send(res, 400, { ok: false, error: `未知 op：${String(req2.op)}` })
      }
    } catch (e) {
      rlog('swap 异常: ' + String(e?.message ?? e))
      return send(res, 500, { ok: false, error: String(e?.message ?? e) })
    }
  })
  server.on('error', (e) => {
    rlog('换会话桥启动失败（不影响界面）：' + String(e?.message ?? e))
  })
  server.listen(SWAP_PORT, '127.0.0.1', () => {
    rlog(`换会话桥已就绪：http://127.0.0.1:${SWAP_PORT}/swap（token 在 ${SWAP_TOKEN_FILE}）`)
    if (SWAP_PORT === 19390 && existsSync(ENSURE_SCRIPT)) {
      try {
        const child = spawn(NODE_EXE, [ENSURE_SCRIPT], { detached: true, stdio: 'ignore', windowsHide: true })
        child.unref()
        rlog(`已自动拉起看守（确保看守.mjs pid=${child.pid}）`)
      } catch (e) {
        rlog('自动拉起看守失败（不影响界面）：' + String(e?.message ?? e))
      }
    }
    if (SWAP_PORT === 19390) {
      setTimeout(() => {
        try { ensureSideServices() } catch {}
      }, 1500).unref?.()
    }
  })
  __server = server
  return server
}

function ensureSideServices () {
  try {
    if (existsSync(TOOL_ENSURE)) {
      const c = spawn(NODE_EXE, [TOOL_ENSURE], { cwd: dirname(TOOL_ENSURE), detached: true, stdio: 'ignore', windowsHide: true })
      c.unref()
      rlog('已自动拉起工具服务（19400）')
    }
  } catch (e) {
    rlog('自动拉起工具服务失败（不影响界面）：' + String(e?.message ?? e))
  }
  try {
    if (existsSync(PANEL_SERVICE)) {
      const c = spawn(NODE_EXE, [PANEL_SERVICE], { cwd: PANEL_DIR, detached: true, stdio: 'ignore', windowsHide: true })
      c.unref()
      rlog('已自动拉起面板（19450）')
    }
  } catch (e) {
    rlog('自动拉起面板失败（不影响界面）：' + String(e?.message ?? e))
  }
  // ★ 2026-10-18（b126）**外壳装机**（桌面/开始菜单快捷方式）—— 幂等：没标记只记「待问」、不建任何东西。
  //   ⚠️ 输出**重定向到日志文件**（不是 stdio:'ignore'）：这条链是"静默后台"，出问题必须留痕（失败要出声）。
  try {
    if (existsSync(SHELL_ENSURE)) {
      mkdirSync(dirname(SHELL_LOG), { recursive: true })
      const fd = openSync(SHELL_LOG, 'a')
      const c = spawn(NODE_EXE, [SHELL_ENSURE, '--autostart'], { cwd: dirname(SHELL_ENSURE), detached: true, stdio: ['ignore', fd, fd], windowsHide: true })
      c.unref()
      rlog('已跑一次外壳体检（装外壳.mjs --autostart）')
    } else {
      rlog('外壳脚本不在（跳过，不影响界面）：' + SHELL_ENSURE)
    }
  } catch (e) {
    rlog('外壳体检失败（不影响界面）：' + String(e?.message ?? e))
  }
}

export function apply (ctx) {
  rlog(`apply() 进入（${BUILD_TAG}）`)
  try {
    startSwapBridge(ctx)
  } catch (e) {
    rlog('换会话桥未能启动（界面不受影响）：' + String(e?.message ?? e))
  }
  rlog('apply() 完成（桥）')
}
