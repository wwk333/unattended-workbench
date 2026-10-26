/**
 * 工具服务（本机 MCP 工具）—— 无人值守自己的 MCP 工具，**纯本机、不转发任何上游**。
 *
 *   http://127.0.0.1:19400/LocalTools/mcp
 *   三个工具：`pitfall_search` 查坑 ／ `fingerprint_check` 核指纹 ／ `gate_summary` 读门禁
 *   —— 口径＝《小优化》做法二/四（重构总表 §六·S1、§四·S4）。
 *
 * ## ★ 2026-10-11 瘦身（用户拍板："把 19400 瘦成纯本机工具服务器，彻底跟百炼脱钩"）
 *
 * 本文件原来是「**百炼 MCP 本地中转**」：把 `dashscope` 的三个服务（EnhancedSearch / WebFetch /
 * VerticalSearch）从本机转发出去。那三个服务**已于 2026-10-07 废弃**（用户拍板，配置里 `disabled: true`），
 * 于是这个进程**净在为三个本机工具当底座** ⇒ 本次把转发那半段**整段删掉**：
 *   · 删了 `UPSTREAM`（`https://dashscope.aliyuncs.com/api/v1/mcps`）与白名单 `ALLOWED`；
 *   · 删了「其余请求原样转发」那段（含 SSE/header 透传与 502 兜底）；
 *   · **仍保留**「`server/discover` → 回 404」这一条 —— 理由与坑见下（对本机工具无害，且是唯一的 DSH 兼容点）。
 *
 * ## 历史（为什么当初会有"中转"这东西，别再重新踩）
 *
 * - DSH 的 `dsh-mcp-client` **硬编码** `versionNegotiation: { mode: "auto" }`，配置层没有入口能改；
 *   `mode: "auto"` 会先发 `server/discover` 探新协议。
 * - 而 2025-era 的 MCP 服务端对 `server/discover` **回 HTTP 500**；SDK 的 `classifyHttpError` 里
 *   **5xx = 硬失败**（`EraNegotiationFailed`），**只有非 5xx 才回退 legacy** ⇒ 服务全部"连不上"。
 * - 当初的解法就是**把这一个请求拦下、回 404** ⇒ 触发 legacy 回退；其余原样转发。
 *   （选"独立进程打补丁"而不是改 `app.asar`：改 asar 有升级覆盖风险，这个随时可关、不碰 DSH 本体。）
 *
 * ## 生命周期（★ 2026-10-11 改：**随 DSH**，不再由登录计划任务起）
 *
 *   DSH 启动 → `dsh-crew-bridge` 插件调 `确保工具服务.mjs`（幂等探活＋拉起，`windowsHide` 无窗口）
 *   看板顶部「工具服务 ●」＝**看状态 ＋ 红灯时手动拉起**（它**不负责**生命周期）
 *   ⚠️ 原计划任务 `DSH-MCP-Proxy`（登录自启）**已停用并禁用** —— 不停的话它会跟 DSH 抢 19400。
 *
 *   ✅ **2026-10-11 实跑验证**：重启 DSH ⇒ 本服务被自动拉起（01:30:06）、看板灯转绿。
 */

import { createServer } from 'node:http'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

const argv = process.argv.slice(2)
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const PORT = Number(opt('port', 19400))
// ★ 2026-10-11 瘦身：`UPSTREAM`（dashscope）与白名单 `ALLOWED` **已删** —— 本服务不再转发任何上游。

const log = (...a) => console.log(`[工具服务 ${new Date().toISOString().slice(11, 19)}]`, ...a)

function readBody (req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

// ---------------------------------------------------------------- 本机工具（LocalTools）
//
// 为什么放在这个中转里：一句话 —— DSH/载体要挂 MCP，就得有一个"在听的"HTTP 端点；
// 19400 这个进程已经在了、已经解决了"让客户端回退 legacy"那套坑，所以本机工具搭它的车。
// 语义出处：《重构\小优化-施工文档.md》§3.2（做法二·工具层拦）与 §4.4（做法四）。

const LOCAL_SVC = 'LocalTools'

/** 文件 sha256（读不到返回 null）。 */
function sha256Of (abs) {
  try { return createHash('sha256').update(readFileSync(abs)).digest('hex') } catch { return null }
}

/**
 * fingerprint_check —— 动手前自查 / 改后自证。
 * 入参：{ project?, expect?: {路径: sha256(可用前 12 位)}, files?: [路径] }
 *   · expect 给了就逐条比对，**任一不符 ⇒ ok:false + changed 清单**；
 *   · files 只回当前指纹（改后自证用）。
 * 路径一律**相对 project**（不传 project 就用环境变量 DSH_ACTIVE_PROJECT）。
 */
function fingerprintCheck (args = {}) {
  const project = resolve(String(args.project ?? process.env.DSH_ACTIVE_PROJECT ?? ''))
  if (!project || !existsSync(project)) {
    return { ok: false, error: '拿不到项目目录：请传 project=<绝对路径>，或先设环境变量 DSH_ACTIVE_PROJECT' }
  }
  const expect = (args.expect && typeof args.expect === 'object' && !Array.isArray(args.expect)) ? args.expect : {}
  const files = Array.isArray(args.files) ? args.files.map(String) : []
  const paths = [...new Set([...Object.keys(expect), ...files])]
  if (!paths.length) {
    return { ok: false, error: '至少要给 expect 或 files（例：{"project":"<项目>","expect":{"server/src/a.ts":"ab12cd34ef56"}}）' }
  }
  const changed = []
  const current = {}
  for (const rel of paths) {
    const h = sha256Of(resolve(project, rel))
    if (h) current[rel] = h.slice(0, 12)
    if (!Object.prototype.hasOwnProperty.call(expect, rel)) continue
    const want = String(expect[rel]).trim().toLowerCase().replace(/^sha256[:：]?/, '')
    const hit = Boolean(h) && h.toLowerCase().startsWith(want)
    if (!hit) changed.push({ path: rel, expected: String(expect[rel]), actual: h ? h.slice(0, 12) : null, why: h ? 'mismatch' : 'missing' })
  }
  return { ok: changed.length === 0, checked: paths.length, changed, current }
}

/**
 * gate_summary —— 门禁摘要（零 token）。读目标项目的 gate 产物：
 *   <项目>\_crew\gate\gate-result.json（门禁结果）+ <项目>\_crew\gate-status.json（编排侧状态）。
 * 口径：全量证据 = 引用它，reviewer 不重跑全量（§二附「测试归属」）。
 */
function gateSummary (args = {}) {
  const project = resolve(String(args.project ?? process.env.DSH_ACTIVE_PROJECT ?? ''))
  if (!project || !existsSync(project)) {
    return { ok: false, error: '拿不到项目目录：请传 project=<绝对路径>，或先设环境变量 DSH_ACTIVE_PROJECT' }
  }
  const resultPath = join(project, '_crew', 'gate', 'gate-result.json')
  const statusPath = join(project, '_crew', 'gate-status.json')
  if (!existsSync(resultPath)) {
    return { ok: false, error: `该项目还没跑过门禁（缺 ${resultPath}）—— 全量由门禁脚本跑；先触发门禁再引用` }
  }
  let j
  try { j = JSON.parse(readFileSync(resultPath, 'utf8')) } catch (e) {
    return { ok: false, error: `门禁结果读不动（${resultPath}）：${String(e?.message ?? e)}` }
  }
  const steps = Array.isArray(j.steps) ? j.steps : []
  const failedSteps = steps.filter(s => s && s.ok === false).map(s => ({
    name: s.name ?? null,
    kind: s.kind ?? null,
    exitCode: s.exitCode ?? null,
    failures: Array.isArray(s.failures) ? s.failures.slice(0, 20) : []
  }))
  let status = null
  if (existsSync(statusPath)) { try { status = JSON.parse(readFileSync(statusPath, 'utf8')) } catch {} }
  return {
    ok: j.ok === true,
    summary: j.summaryText ?? null,
    project: j.project ?? project,
    ranAt: j.ranAt ?? null,
    stamp: j.stamp ?? null,
    ranBy: j.ranBy ?? null,
    scope: j.scope ?? null,
    manifestCount: j.inputs?.manifestCount ?? null,
    failedSteps,
    failures: Array.isArray(j.failures) ? j.failures.slice(0, 30) : [],
    hint: j.hint ?? null,
    status
  }
}

/**
 * pitfall_search —— 三跳查库第①跳（包 查坑.mjs；0.2 秒、零 token、只读）。
 * 入参：{ keywords（必填，逗号/空格分隔）, limit?, topic? }
 * 注意：第①跳是**字面匹配一定会漏** —— "查不到"≠"库里没有"，按三跳继续往后走。
 */
function pitfallSearch (args = {}) {
  const kw = String(args.keywords ?? '').trim()
  if (!kw) return { ok: false, error: '给个关键词（报错原文里的 2–3 个词，逗号分隔），例：{"keywords":"docker,镜像"}' }
  const lim = Number(args.limit)
  const a = [join(HERE, '查坑.mjs'), kw, '--limit', String(Number.isFinite(lim) ? Math.max(1, Math.min(30, lim)) : 8)]
  if (args.topic) a.push('--topic', String(args.topic))
  const r = spawnSync(process.execPath, a, { encoding: 'utf8', timeout: 20000, windowsHide: true })
  const out = String(r.stdout ?? '')
  const err = String(r.stderr ?? '')
  return {
    ok: r.status === 0,
    exitCode: r.status,
    text: out.length > 6000 ? out.slice(0, 6000) + '\n…（截断；要看全 → 直接跑 查坑.mjs）' : out,
    error: r.status === 0 ? null : (err.slice(-400) || `exit=${r.status}`)
  }
}

const LOCAL_TOOLS = {
  fingerprint_check: {
    description: '文件指纹核对（动手前自查 / 改后自证）。传 expect={路径:sha256} 逐条比对，任一不符返回 ok:false + changed 清单；只传 files=[…] 回当前指纹。路径相对 project（默认取环境变量 DSH_ACTIVE_PROJECT）。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目根目录（绝对路径）；不传则用环境变量 DSH_ACTIVE_PROJECT' },
        files: { type: 'array', items: { type: 'string' }, description: '要算当前指纹的文件（相对 project）' },
        expect: { type: 'object', additionalProperties: { type: 'string' }, description: '路径 → sha256（可只用前 12 位），逐条比对' }
      }
    },
    run: fingerprintCheck
  },
  gate_summary: {
    description: '门禁摘要（零 token）：读目标项目 _crew\\gate\\gate-result.json 与 _crew\\gate-status.json，回 ok / 汇总行 / 挂掉的步骤与用例名 / ranBy / stamp。全量证据＝引用它，别自己重跑全量。',
    inputSchema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: '项目根目录（绝对路径）；不传则用环境变量 DSH_ACTIVE_PROJECT' }
      }
    },
    run: gateSummary
  },
  pitfall_search: {
    description: '查坑库（三跳第①跳；0.2 秒、零 token）：按报错原文里的 2–3 个词回命中条目与对策。①跳是字面匹配、一定会漏——没命中再走②扫索引标题、③全库搜。',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'string', description: '关键词（逗号/空格分隔），例："docker,镜像"' },
        limit: { type: 'number', description: '最多回几条（默认 8，上限 30）' },
        topic: { type: 'string', description: '可选：只在某主题里查' }
      },
      required: ['keywords']
    },
    run: pitfallSearch
  }
}

/** 极简 MCP 处理（legacy 2024-11-05 面：initialize / notify / tools.list / tools.call / ping）。 */
function mcpLocal (msg) {
  const { id, method, params } = msg ?? {}
  switch (method) {
    case 'initialize':
      return { jsonrpc: '2.0', id, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'unattended-local-tools', version: '1.0.0' } } }
    case 'ping':
      return { jsonrpc: '2.0', id, result: {} }
    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools: Object.entries(LOCAL_TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })) } }
    case 'tools/call': {
      const t = LOCAL_TOOLS[params?.name]
      if (!t) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${params?.name}` } }
      try {
        const out = t.run(params?.arguments ?? {})
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], isError: false } }
      } catch (e) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `内部错误：${String(e?.message ?? e)}` }], isError: true } }
      }
    }
    default:
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } }
  }
}

const server = createServer(async (req, res) => {
  // ★ 2026-10-11 瘦身后**只剩一个服务**（`LocalTools`）—— 不再有"多服务路由"与上游转发。
  const m = String(req.url).match(/^\/([^/]+)\/mcp/)
  if (!m || m[1] !== LOCAL_SVC) {
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: 'unknown service（本服务只有 ' + LOCAL_SVC + '；百炼转发已于 2026-10-11 摘除）' }))
    return
  }
  const svc = LOCAL_SVC
  const body = await readBody(req)

  let msg = null
  try { msg = JSON.parse(body.toString('utf8')) } catch {}
  const method = msg?.method ?? ''

  // ★ **唯一保留的 DSH 兼容点**（别删）：拦下新协议探测、回 404（非 5xx）→ 让 SDK 回退 legacy。
  //   来历：DSH 的 `dsh-mcp-client` 硬编码 `versionNegotiation.mode = "auto"`（配置层改不了），会先发
  //   `server/discover`；老服务端回 5xx ⇒ SDK 当**硬失败**、不回退。对本机工具**无害**（它也走 legacy），
  //   留着是"万一客户端哪天开始探测"的兜底 —— 删掉它换来的是"省 6 行"，不值得冒这个险。
  if (method === 'server/discover') {
    log(`${svc} 拦下 server/discover → 回 404（让 SDK 回退 legacy）`)
    res.writeHead(404, { 'Content-Type': 'application/json' })
    res.end('{"jsonrpc":"2.0","id":null,"error":{"code":-32601,"message":"Method not found"}}')
    return
  }

  // ── 本机工具：**本地应答，零网络**（这一点有对照实验守着：`_probe\_本机工具不依赖百炼实测.mjs`）──
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end('{"error":"LocalTools 只收 POST JSON-RPC"}')
    return
  }
  // 通知类（如 notifications/initialized）：202、空体
  if (typeof method === 'string' && method.startsWith('notifications/')) {
    log(`${svc} ${method} → 202`)
    res.writeHead(202)
    res.end()
    return
  }
  const out = msg ? mcpLocal(msg) : { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } }
  log(`${svc} ${method || '(no method)'} → ${out.error ? 'error ' + out.error.code : 'ok'}`)
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(out))
})

server.listen(PORT, '127.0.0.1', () => {
  log(`已就绪：http://127.0.0.1:${PORT}/${LOCAL_SVC}/mcp  （纯本机，无上游）`)
  log(`可用工具：${Object.keys(LOCAL_TOOLS).join(' / ')}`)
})
