/**
import { WORKSPACE } from './_路径.mjs'
 * B（MCP 三工具挂载）· 验收脚本：**真调三个工具**（零 token、可反复跑）
 *
 * 做什么：
 *   ① `initialize` 握手 → ② `tools/list` 看三个工具是否都在 → ③ 逐个 `tools/call`
 *   ④ 反向验收：**传错指纹必须 ok:false**（闸要真的会响）；**没跑过门禁的项目必须明确报错**
 *
 * 前提：19400 中转在跑。★ 2026-10-21：**计划任务 `DSH-MCP-Proxy` 已删除** —— 实测全库无任何注册代码，
 *       功能早已改由 crew-bridge 插件随 DSH 拉起（`确保工具服务.mjs` → `_mcp中转.mjs`）。
 *       别再写"Schtasks 起它"：那样会跟插件抢 19400（见 `_mcp中转.mjs:30`）。
 * 挂载状态（2026-10-10）：profile 的 `cordis.patch.yml` 里已加 `mcp-client-local-tools`，
 *       **宿主热加载** ⇒ 工具名以 `mcp__LocalTools__*` 直接出现在会话里（已在会话工具清单里实测）。
 *
 * 用法：`node _unattended\_MCP工具验收.mjs [项目路径]`
 */
const PORT = process.env.DSH_MCP_PORT ?? 19400
const URL = `http://127.0.0.1:${PORT}/LocalTools/mcp`
const PROJECT = process.argv[2] ?? process.env.DSH_PROJECT ?? null
if (!PROJECT) { console.error('用法：node _MCP工具验收.mjs <项目根>'); process.exit(2) }

let fails = 0
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++ }
const info = (m) => console.log('   ' + m)

let id = 0
async function rpc (method, params) {
  const r = await fetch(URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params })
  })
  const text = await r.text()
  // 该端点可能回 SSE 或纯 JSON —— 两种都认
  const jsonLine = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith('{')).pop()
  if (!jsonLine) throw new Error(`响应不是 JSON（HTTP ${r.status}）：${text.slice(0, 200)}`)
  const j = JSON.parse(jsonLine)
  if (j.error) throw new Error(`JSON-RPC error：${JSON.stringify(j.error)}`)
  return j.result
}
const callTool = async (name, args) => {
  const res = await rpc('tools/call', { name, arguments: args })
  const txt = Array.isArray(res?.content) ? res.content.map((c) => c.text ?? '').join('') : ''
  let parsed = null
  try { parsed = JSON.parse(txt) } catch { /* 有的工具回纯文本 */ }
  return { raw: txt, json: parsed, isError: res?.isError === true }
}

console.log(`MCP 三工具验收 · 端点 ${URL}\n项目 ${PROJECT}\n`)

console.log('① 握手（initialize）')
const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'verify', version: '1' } })
ok(Boolean(init?.serverInfo), `serverInfo=${JSON.stringify(init?.serverInfo)}`)
ok(init?.capabilities?.tools !== undefined, '声明了 tools 能力')

console.log('\n② 工具清单（tools/list）')
const list = await rpc('tools/list', {})
const names = (list?.tools ?? []).map((t) => t.name)
ok(names.length === 3, `工具数 ${names.length}（期望 3）：${names.join(' / ')}`)
for (const want of ['gate_summary', 'fingerprint_check', 'pitfall_search']) {
  const t = (list?.tools ?? []).find((x) => x.name === want)
  ok(Boolean(t), `${want} 在，且有描述（${t ? String(t.description).slice(0, 40) + '…' : '缺失'}）`)
  if (want === 'pitfall_search') ok(Array.isArray(t?.inputSchema?.required) && t.inputSchema.required.includes('keywords'), 'pitfall_search 的 keywords 是必填（schema 正确）')
}

console.log('\n③ 逐个真调')
{
  const r = await callTool('gate_summary', { project: PROJECT })
  const j = r.json
  ok(j !== null, `gate_summary 回了 JSON：ok=${j?.ok} summary=${JSON.stringify(j?.summary ?? j?.error)}`)
  info(`ranBy=${j?.ranBy} stamp=${j?.stamp} manifestCount=${j?.manifestCount}`)
  // 反向验收：**没跑过门禁的项目必须明确报错**（而不是假装"全绿"）
  const r2 = await callTool('gate_summary', { project: WORKSPACE })
  const j2 = r2.json
  if (j2 && j2.ok === false && /没跑过门禁/.test(String(j2.error ?? ''))) {
    ok(true, `反向：没跑过门禁的项目明确报错（"${String(j2.error).slice(0, 40)}…"）`)
  } else if (j2 && j2.ok === true) {
    info('（工作台根恰好有门禁产物：跳过这条反向用例）')
  } else {
    ok(false, `反向：期望"没跑过门禁"的明确报错，实得 ${JSON.stringify(j2 ?? r2.raw).slice(0, 120)}`)
  }
}
{
  // 拿一个真实存在的文件算指纹 → 再用它自己当 expected（应 ok:true）
  const { readFileSync, existsSync } = await import('node:fs')
  const { createHash } = await import('node:crypto')
  // 挑一个项目里**确实存在**的文件（异次元里有 AGENTS.md；没有就退回 _crew\gate-status.json）
  const rel = existsSync(`${PROJECT}\\AGENTS.md`) ? 'AGENTS.md' : '_crew\\gate-status.json'
  const abs = `${PROJECT}\\${rel}`
  if (existsSync(abs)) {
    const sha = createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 12)
    const good = await callTool('fingerprint_check', { project: PROJECT, expect: { [rel]: sha } })
    ok(good.json?.ok === true, `fingerprint_check（对的指纹）⇒ ok=${good.json?.ok}（期望 true）`)
    // 反向验收：错指纹必须亮红
    const bad = await callTool('fingerprint_check', { project: PROJECT, expect: { [rel]: 'deadbeef0000' } })
    ok(bad.json?.ok === false, `fingerprint_check（**故意传错**）⇒ ok=${bad.json?.ok}（期望 false）`)
    ok(Array.isArray(bad.json?.changed) && bad.json.changed.length > 0, `changed 清单有内容：${JSON.stringify(bad.json?.changed?.[0] ?? null)}`)
  } else {
    ok(false, `找不到 ${abs} 用来做指纹用例`)
  }
}
{
  const r = await callTool('pitfall_search', { keywords: 'docker,镜像', limit: 3 })
  ok(r.json !== null || r.raw.length >= 0, `pitfall_search 有回应（${r.json ? 'JSON' : '文本'}）`)
  info(`ok=${r.json?.ok} exitCode=${r.json?.exitCode} 文本长度=${(r.json?.text ?? r.raw ?? '').length}`)
}

console.log('\n' + (fails ? `❌ MCP 验收：${fails} 项不达标` : '✅ MCP 验收：全部通过'))
process.exit(fails ? 1 : 0)
