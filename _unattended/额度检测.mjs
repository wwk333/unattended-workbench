#!/usr/bin/env node
/**
 * 额度检测 —— 按协议探测"这把钥匙现在能不能用"（**供应商不写死**，见 KB `08-额度兜底与切换协议.md`）
 *
 * 协议要点：
 *   P2 **探测是"声明的"**：默认按 OpenAI 兼容打 `GET {baseURL}/models`；供应商可覆盖；
 *      **连 baseURL 都没声明 → 老实报 `no-probe`（无法探测），绝不假装可用**；
 *   P3 **额度查不到就是 `—`，绝不估算**；
 *   P5 密钥只出现**标签 + 后 4 位**（走 `额度钥匙.mjs` 的掩码）。
 *   ★ **只打一个零 token 的探测请求** —— 绝不为了探测去发付费的对话请求。
 *
 * 用法：
 *   node 额度检测.mjs --all                 # 所有供应商、所有钥匙
 *   node 额度检测.mjs --provider ark        # 只测一家
 *   node 额度检测.mjs --provider ark --json # 机器可读
 *   node 额度检测.mjs --all --no-save       # 只打印，不写 额度状态.json
 *
 * 结果写 `_crew\额度状态.json`（谁 / 什么时候 / 什么状态 / HTTP 码 / 延迟）→ **看板读它**。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { WORKSPACE, discoverProviders, loadSecrets, loadStruct, mask, resolveKey, STRUCT_FILE } from './额度钥匙.mjs'

const STATE_FILE = join(WORKSPACE, '_crew', '额度状态.json')
const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }

const ONLY = opt('provider')
const ALL = has('all') || !ONLY
const AS_JSON = has('json')
const SAVE = !has('no-save')
const TIMEOUT = Number(opt('timeout', 0)) || 0

const VERDICT_ZH = {
  ok: '✅ 可用',
  'invalid-key': '❌ 钥匙无效',
  quota: '⚠️ 没额度',
  'rate-limited': '⏳ 被限流',
  'no-probe': '❓ 无法探测',
  network: '🌐 连不上',
  error: '❌ 探测出错'
}

/** 把 `{key}` / `{baseURL}` 占位符填上（协议里允许在 url/headers 里用）。 */
const fill = (s, ctx) => String(s ?? '').replace(/\{(\w+)\}/g, (_, k) => ctx[k] ?? '')

/** 合并出这一家的探测规格（协议 P2：供应商覆盖 > 全局默认）。 */
function probeSpec (provider, providers, struct) {
  const def = struct.probe?.default ?? { kind: 'openai-models', timeoutMs: 8000, treat: { 200: 'ok', 401: 'invalid-key', 402: 'quota', 403: 'quota', 429: 'rate-limited' } }
  const own = struct.probe?.byProvider?.[provider] ?? {}
  const spec = { ...def, ...own }
  const base = own.baseURL ?? providers[provider]?.baseURL ?? null
  if (spec.kind === 'openai-models' && !base) spec.kind = 'none'      // ★ 没地址就别假装能探（P2）
  return { ...spec, baseURL: base }
}

/**
 * 探一把钥匙。返回 `{ verdict, httpCode, ms, detail }`。
 * **只发一个零 token 的请求**；任何异常都归到 `network` / `error`，不吞。
 */
async function probe (provider, idx, key, providers, struct) {
  const spec = probeSpec(provider, providers, struct)
  const t0 = Date.now()
  if (spec.kind === 'none') {
    return { verdict: 'no-probe', httpCode: null, ms: 0, detail: '这家没声明 baseURL / 探测方式 → 无法探测（协议允许：不假装可用）。要启用：在 `_crew\\额度兜底.json` 的 `probe.byProvider.' + provider + '` 里声明 baseURL 或 { kind, url }' }
  }
  const treat = spec.treat ?? {}
  const timeout = (TIMEOUT || spec.timeoutMs || 8000)
  try {
    let url, init
    if (spec.kind === 'http-json') {
      const ctx = { key, baseURL: spec.baseURL ?? '', provider }
      url = fill(spec.url, ctx)
      const headers = {}
      for (const [k, v] of Object.entries(spec.headers ?? {})) headers[k] = fill(v, ctx)
      init = { method: spec.method ?? 'GET', headers }
    } else { // openai-models（默认）
      url = String(spec.baseURL).replace(/\/+$/, '') + (spec.path ?? '/models')
      init = { method: 'GET', headers: { Authorization: 'Bearer ' + key, Accept: 'application/json' } }
    }
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeout) })
    const ms = Date.now() - t0
    let verdict = treat[String(res.status)] ?? (res.status >= 200 && res.status < 300 ? 'ok' : 'error')
    // 有些网关用 200 包一个错误体 → 允许规格里声明"看正文判"（可选，不强求）
    if (spec.bodyMustInclude) {
      let body = ''
      try { body = await res.text() } catch {}
      if (!body.includes(spec.bodyMustInclude)) verdict = 'invalid-key'
    }
    // ★ 2026-10-07（用户拍板③）：**`/models` 200 不代表能干活** —— 实测踩过（小米那次 /models 判绿、真调用 401）。
    //   所以 `/models` 判 ok 时，**再发一次最小 chat 请求**（max_tokens=1）核对；真调用若给出
    //   鉴权/配额/限流类结论，**以真调用为准**（覆写 verdict），证据挂 `real*` 字段上，看板/收据可回查。
    //   真调用遇到**网络类**异常**不覆写**（避免把"我们这边网断"误判成"这家废了"）。
    let realInfo = null
    if (verdict === 'ok') {
      const base = String(spec.baseURL ?? '').replace(/\/+$/, '')
      const model = (providers?.[provider]?.models ?? []).map(String)[0]
      if (base && model) {
        try {
          const cr = await fetch(base + '/chat/completions', {
            method: 'POST',
            // ★ 2026-10-12（b38）：**把这家要求的额外头带上**（路由表的 `headers`，另加探测档里的 headers）。
            //   没有它，`ocgo` 这种"网关要 session 头"的家会 400 ⇒ 被真调用判成不可用（假红）。
            headers: { ...(providers?.[provider]?.headers ?? {}), ...(spec.headers ?? {}), Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
            body: JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }),
            signal: AbortSignal.timeout(timeout)
          })
          const real = treat[String(cr.status)] ?? (cr.status >= 200 && cr.status < 300 ? 'ok' : 'error')
          realInfo = { real, realHttp: cr.status, realModel: model }
          if (real !== 'ok' && ['invalid-key', 'quota', 'rate-limited'].includes(real)) {
            return { verdict: real, httpCode: cr.status, ms: Date.now() - t0,
              detail: '真调用(' + model + ') ' + cr.status + ' → ' + real + '（/models 却是 ' + verdict + ' ⇒ 以真调用为准）', ...realInfo }
          }
        } catch (e2) { realInfo = { real: 'network', realHttp: null, realModel: model } }
      }
    }
    return { verdict, httpCode: res.status, ms, detail: url.replace(/\/\/[^/]+/, m => m), ...(realInfo ?? {}) }
  } catch (e) {
    const ms = Date.now() - t0
    const msg = String((e && (e.cause?.code || e.name || e.message)) || e)
    const network = /ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|TimeoutError|abort/i.test(msg)
    return { verdict: network ? 'network' : 'error', httpCode: null, ms, detail: msg }
  }
}

// ---------------------------------------------------------------- 主流程
const providers = discoverProviders()
const struct = loadStruct()
const secrets = loadSecrets()

// 没配过钥匙时，也把结构文件落盘（让用户能看到/改协议旋钮）
if (!existsSync(STRUCT_FILE)) { mkdirSync(dirname(STRUCT_FILE), { recursive: true }); writeFileSync(STRUCT_FILE, JSON.stringify(struct, null, 2), 'utf8') }

const names = [...new Set([...Object.keys(providers), ...Object.keys(struct.keys ?? {}), ...Object.keys(secrets.providers ?? {})])]
  .filter(n => ALL || n === ONLY).sort()

if (!names.length) { console.error('没有可检测的供应商（`--provider <名>` 指定一家，或先在档案/密钥库里配置）'); process.exit(2) }

const results = {}
const lines = []
lines.push('🔎 额度检测（每把钥匙**只打一个零 token 的探测请求**；供应商全部动态发现，没有写死）')
lines.push('')
for (const provider of names) {
  const declared = (struct.keys?.[provider] ?? []).slice().sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
  const count = Math.max(declared.length, (secrets.providers?.[provider] ?? []).length)
  const baseInfo = providers[provider]?.baseURL ?? '—'
  lines.push('  ── ' + provider + '　(apiKeyEnv=' + (providers[provider]?.apiKeyEnv ?? '—') + ' · baseURL=' + baseInfo + ')')
  results[provider] = []
  if (!count) { lines.push('        （还没配钥匙 —— 用 `额度钥匙.mjs set ' + provider + ' <标签> <密钥>` 配）'); continue }
  for (let i = 0; i < count; i++) {
    const r = resolveKey(provider, i, struct, secrets, providers)
    const label = declared[i]?.label ?? secrets.providers?.[provider]?.[i]?.label ?? '#' + (i + 1)
    if (!r) {
      lines.push('       ' + String(i + 1).padStart(2) + '. ' + label.padEnd(12) + '  （缺钥匙：环境变量/密钥库里都没有）')
      results[provider].push({ idx: i, label, verdict: 'missing', mask: null })
      continue
    }
    const pr = await probe(provider, i, r.key, providers, struct)
    lines.push('       ' + String(i + 1).padStart(2) + '. ' + label.padEnd(12) + '  ' + (VERDICT_ZH[pr.verdict] ?? pr.verdict).padEnd(10) +
      '  ' + mask(r.key) + '  来源=' + r.source + (pr.httpCode ? '  HTTP ' + pr.httpCode : '') + '  ' + pr.ms + 'ms')
    if (pr.verdict === 'no-probe') lines.push('            ↳ ' + pr.detail)
    // ★ 2026-10-07：把"真调用核对"的结果**也打出来 + 落盘**（否则证据在调用方被丢掉，事后查不到）
    if (pr.real) lines.push('            ↳ 真调用核对：' + (VERDICT_ZH[pr.real] ?? pr.real) + (pr.realHttp ? '（HTTP ' + pr.realHttp + '，模型 ' + pr.realModel + '）' : ''))
    results[provider].push({ idx: i, label, verdict: pr.verdict, httpCode: pr.httpCode, ms: pr.ms, source: r.source, mask: mask(r.key), detail: pr.detail,
      real: pr.real ?? null, realHttp: pr.realHttp ?? null, realModel: pr.realModel ?? null })
  }
}
lines.push('')
const flat = Object.values(results).flat()
const okN = flat.filter(x => x.verdict === 'ok').length
const badN = flat.filter(x => ['quota', 'invalid-key', 'rate-limited'].includes(x.verdict)).length
const noProbeN = flat.filter(x => x.verdict === 'no-probe').length
lines.push('  小结：可用 ' + okN + ' 把 · 不可用 ' + badN + ' 把 · 无法探测 ' + noProbeN + ' 家' +
  (badN ? '　→ 这些在切换时会被**跳过**' : '') + (noProbeN ? '　（无法探测 ≠ 不可用，协议 P3：不编数）' : ''))
lines.push('  下一步：能用的会参与切换；状态已写 `' + STATE_FILE + '`（看板读它）')

// ★ 2026-10-05 修：写状态时**必须保留 `failover` 段** —— 否则一探测就把"谁被切走了"抹掉，
//   看板和切换引擎会瞬间失忆（两个脚本共用一个 `额度状态.json`）。
const prevState = (() => { try { return JSON.parse(readFileSync(STATE_FILE, 'utf8')) } catch { return {} } })()
// ★ 2026-10-05 修（**踩坑**）：**必须按家合并**，不能整体替换 `providers` ——
//   原来 `providers: results` 会把"这次没探的家"的记录**抹掉**：探一次 aliyun 就把 ark 的状态清空，
//   于是看板上 ark 变成"未检测"、下一次刷新又去补探 ark（把 aliyun 抹掉）→ **来回乒乓**，永远只绿一个。
//   合并语义：**这次探过的家覆盖自己那份**，没探到的**原样留着**。
const mergedProviders = { ...(prevState.providers ?? {}), ...results }
const allRows = Object.values(mergedProviders).flat()
const SWITCH_VERDICTS = ['quota', 'invalid-key', 'rate-limited']
const out = {
  ...prevState, version: 1, checkedAt: new Date().toISOString(),
  providers: mergedProviders,
  summary: {
    ok: allRows.filter(r => r.verdict === 'ok').length,
    bad: allRows.filter(r => SWITCH_VERDICTS.includes(r.verdict)).length,
    noProbe: allRows.filter(r => r.verdict === 'no-probe').length
  },
  lastRun: { at: new Date().toISOString(), providers: Object.keys(results), ok: okN, bad: badN, noProbe: noProbeN }
}
if (SAVE) { mkdirSync(dirname(STATE_FILE), { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(out, null, 2), 'utf8') }

if (AS_JSON) { console.log(JSON.stringify(out, null, 2)); process.exit(0) }
console.log(lines.join('\n'))