#!/usr/bin/env node
/**
 * 路由网关（v1 最小版）—— 载体不再直连各家，先打到它，由它转发。
 *
 *   GET  /health                  → {ok, port, homes, hits}（面板那颗灯就读它）
 *   ANY  /<家>/<其余路径>          → 那家的 baseURL ＋ 补该家要求的头 ＋ 换成该家的钥匙 → **流式原样透传**
 *
 * ## 用户口径（2026-10-12）
 * "做B可以，但是怕唯一源混淆了…必须要有把握" ＋ "这个B最小版要绑定在班组看板里最好，
 *  这样班组看板打开，同时路由也跟着起来，黑框要隐藏，和 看板 工具服务 一样" ＋ 失败策略走 A（**失败要响，不静默回落**）。
 *
 * ## 唯一源：本网关**零配置**（这条是硬约束，不是口号）
 *   · 有哪几家 / 地址 / 要什么头 → **每次请求现读** `_coder路由表.json`（② 的口径，唯一源；mtime 缓存）
 *   · 钥匙 → `额度钥匙.mjs` 的**三层解析**（唯一源），**每请求现解**、不落盘、不缓存成文件
 *   · 用哪一家 → **派活侧**（我们的代码）决定，写在路径第一段；网关**不猜、不参与选型**
 *   · 模型清单 → **网关根本不看**（请求体原样透传）⇒ 它不解释模型，就不可能和 ② 分叉
 *   · 写盘 → **只写自己的日志**（`logs\路由网关.log`），**绝不写任何配置**
 *
 * ## 刻意不做（留给 v2，避免和现有账本变成"两份账"）
 *   记账、协议翻译（OpenAI↔Anthropic）、重试/故障转移、限流。
 *
 * ## 起法
 *   node 路由网关.mjs [--port 19420]     （端口也可用环境变量 `DSH_ROUTER_PORT`）
 *   一般不用手起：面板起来时会顺带把它拉起来（`确保路由.mjs`），黑框隐藏，和工具服务一样。
 */
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { discoverProviders, resolveKey } from './额度钥匙.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, '..')
const LOG_DIR = join(WORKSPACE, '_unattended', 'logs')
const LOG = join(LOG_DIR, '路由网关.log')

const argv = process.argv.slice(2)
const opt = (f, d) => { const i = argv.indexOf('--' + f); return i >= 0 ? argv[i + 1] : d }
const PORT = Number(opt('port', process.env.DSH_ROUTER_PORT ?? 19420))
const HOST = '127.0.0.1'          // ★ 只绑本机（钥匙集中在这个进程里，绝不对外）

const hits = {}                    // 家 → 转发次数（只给自己看，用于"真走过网关"的验收）
const lastSession = {}             // 家 → 最近一次真正发出去的会话号（b51；探针靠它验"没被固定串覆盖"）
const t0 = Date.now()

/** 一行日志：**绝不出现钥匙**（只记 家/方法/路径/状态/耗时/字节）。 */
function logline (s) {
  try { mkdirSync(LOG_DIR, { recursive: true }); appendFileSync(LOG, s + '\n', 'utf8') } catch {}
}

/** 这家该用哪种鉴权头：anthropic 族用 `x-api-key`，其余用 `Authorization: Bearer`。 */
function authHeaders (prov, key) {
  const api = String(prov?.api ?? '')
  if (/anthropic/i.test(api)) return { 'x-api-key': key, 'anthropic-version': '2023-06-01' }
  return { Authorization: 'Bearer ' + key }
}

const server = createServer(async (req, res) => {
  const started = Date.now()
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')

  // ── 健康口（面板那颗灯 + 验收都读它）────────────────────────────
  if (url.pathname === '/health') {
    let homes = []
    try { homes = Object.keys(discoverProviders()) } catch {}
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: true, port: PORT, uptimeSec: Math.round((Date.now() - t0) / 1000), homes, hits, lastSession, sessionMode: String(process.env.DSH_ROUTER_SESSION ?? 'passthrough') }))
    return
  }

  // ── 转发：/<家>/<其余> ────────────────────────────────────────
  const seg = url.pathname.split('/').filter(Boolean)
  const home = seg.shift()
  let provs = {}
  try { provs = discoverProviders() } catch {}
  const prov = home ? provs[home] : null
  if (!home || !prov || !prov.baseURL) {
    // ★ 失败要响（用户拍板 A）：不认识的家**明确报错**，绝不静默当直连
    res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: '路由网关不认识的「家」：' + (home ?? '(空)'), homes: Object.keys(provs), hint: '路径第一段必须是路由表里的家名，例：/' + (Object.keys(provs)[0] ?? 'ark') + '/v1/chat/completions' }))
    logline([new Date().toISOString(), 'REJECT', home ?? '-', req.method, url.pathname, 404, (Date.now() - started) + 'ms'].join('\t'))
    return
  }

  // 钥匙：**每请求现解**（唯一源），拿不到就明确 401（不猜、不回落）
  const k = resolveKey(home, 0, undefined, undefined, provs)
  if (!k?.key) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: '路由网关解析不到「' + home + '」的钥匙（环境变量/密钥库/凭据库三处都没有）' }))
    logline([new Date().toISOString(), 'NOKEY', home, req.method, url.pathname, 401, (Date.now() - started) + 'ms'].join('\t'))
    return
  }

  const upstream = String(prov.baseURL).replace(/\/+$/, '') + '/' + seg.join('/') + (url.search || '')
  // 客户端自带的鉴权头一律**丢掉**（钥匙由网关给，载体不需要拿钥匙）；其余头原样带过去
  const headers = {}
  for (const [hk, hv] of Object.entries(req.headers)) {
    if (['host', 'authorization', 'x-api-key', 'connection', 'content-length', 'accept-encoding'].includes(hk.toLowerCase())) continue
    headers[hk] = hv
  }
  Object.assign(headers, prov.headers ?? {}, authHeaders(prov, k.key))

  // ── ★★ b51：**会话号**（用户拍板"直接去做"）────────────────────────────────
  //   厂商（OpenCode Go 文档）要求："每个会话发一个稳定的 session id 到 `x-opencode-session`，
  //   以便优化路由与 prompt 缓存"。而我们以前是**用固定串覆盖掉**载体自己发的号 —— 那等于把
  //   所有会话搅成一个。现在的口径（数据驱动，代码里不写厂商名）：
  //     ① 载体自己发了会话号（Pi / Codex / Claude Code 等**都按官方建议发**）⇒ **原样放行，绝不覆盖**；
  //     ② 派活侧显式给了 `x-dsh-session` / `x-dsh-run` ⇒ 用它（这是"同一次跑一个号"的正解，
  //        需要编排层将来把 runId 带上；不带就自动落到 ③）；
  //     ③ 都没有 ⇒ 用路由表里那个值（现状，固定串）。
  //   开关：`DSH_ROUTER_SESSION=passthrough`（默认，① ② ③）/ `off`（完全不注入）/ `fixed`（永远用路由表的值）。
  const sessMode = String(process.env.DSH_ROUTER_SESSION ?? 'passthrough')
  const SESS_KEYS = ['x-opencode-session', 'x-session-id', 'x-dsh-session', 'x-dsh-run']
  const clientSess = SESS_KEYS.map((k) => req.headers[k]).find((v) => typeof v === 'string' && v.trim())
  const headerSess = Object.entries(prov.headers ?? {}).find(([k]) => /session/i.test(k))?.[1]
  // ⚠️ 路由表里的值可能是**模板**（`${session}` / `${session_id}` / `auto`）—— 那是"由网关决定"的意思，
  //   绝不许把模板字面量原样发出去（第一版就发了 `${session}` 出去，虽然不致命但很脏）。
  //   没有客户端号、也没人给 runId 时，退化成"**每个家一个稳定号**"（比"所有家共用一个"更贴近官方口径；
  //   真正的"一跑一个号"要等编排层把 runId 带上 —— 已在日志里记为待办）。
  const isTemplate = (v) => !v || /\$\{|^auto$/i.test(String(v))
  const sessVal = sessMode === 'off' ? null
    : (sessMode === 'fixed' ? (isTemplate(headerSess) ? 'dsh-' + home : headerSess)
      : (clientSess ? String(clientSess) : (isTemplate(headerSess) ? 'dsh-' + home : headerSess)))
  for (const [hk] of Object.entries(prov.headers ?? {})) if (/session/i.test(hk)) delete headers[hk]   // 先清掉模板值
  if (sessVal) {
    // ⚠️ 头值必须 ASCII（实测：中文会让 Node 抛 `Cannot convert argument to a ByteString`）
    const clean = String(sessVal).replace(/[^\x20-\x7E]/g, '-').slice(0, 120)
    for (const [hk] of Object.entries(prov.headers ?? {})) if (/session/i.test(hk)) headers[hk] = clean
    lastSession[home] = clean
  }
  // ── User-Agent：厂商明确要求"用自己的 UA 标识自己，别用通用库名"。载体的 UA 保留（它才是真客户端），
  //   只在后面缀上我们这一层，便于他们区分"这是经网关转发的 coding agent 流量"。 ──
  const ua = String(headers['user-agent'] ?? '')
  if (!/dsh-router/.test(ua)) headers['user-agent'] = (ua ? ua + ' ' : '') + 'dsh-router/1.0'

  const ac = new AbortController()
  req.on('aborted', () => { try { ac.abort() } catch {} })
  try {
    const up = await fetch(upstream, {
      method: req.method,
      headers,
      body: (req.method === 'GET' || req.method === 'HEAD') ? undefined : req,
      duplex: 'half',
      signal: ac.signal
    })
    const out = {}
    for (const [hk, hv] of up.headers.entries()) {
      if (['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(hk.toLowerCase())) continue
      out[hk] = hv
    }
    res.writeHead(up.status, out)
    let bytes = 0
    // ★ 流式原样透传（不缓冲）：SSE / 工具调用 / 长回答都不受影响
    for await (const chunk of up.body) { bytes += chunk.length; if (!res.write(chunk)) await new Promise((r) => res.once('drain', r)) }
    res.end()
    hits[home] = (hits[home] ?? 0) + 1
    logline([new Date().toISOString(), 'OK', home, req.method, url.pathname, up.status, (Date.now() - started) + 'ms', bytes + 'B'].join('\t'))
  } catch (e) {
    if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, error: '网关转发失败：' + String(e?.message ?? e), home })) }
    logline([new Date().toISOString(), 'FAIL', home, req.method, url.pathname, String(e?.message ?? e).slice(0, 120), (Date.now() - started) + 'ms'].join('\t'))
  }
})

server.listen(PORT, HOST, () => {
  console.log(`路由网关 listening on http://${HOST}:${PORT}/  (health: /health)`)
  logline([new Date().toISOString(), 'START', 'port=' + PORT].join('\t'))
})
server.on('error', (e) => { console.error('路由网关起不来：' + String(e?.message ?? e)); process.exitCode = 1 })
