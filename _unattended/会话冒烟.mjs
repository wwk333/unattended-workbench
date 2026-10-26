#!/usr/bin/env node
/**
 * 会话冒烟 —— **升级/改配置之后，真的新建一个「无人值守」会话，看它能不能起来。**
 *
 * 为什么必须有它（2026-10-19 b184，事故驱动）：
 *   0.2.1 升级后，`preset-unattended` 的 persona 里还留着 `Your working directory is {{cwd}}.`，
 *   新版宿主不再注册 `cwd` ⇒ **提示词组装阶段直接抛错**，会话连一个模型请求都发不出去
 *   （`unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"`）。
 *   这颗雷**埋了 24 小时**才被发现 —— 因为升级后**没有新开过**无人值守会话（老会话用的是
 *   早先组装好的提示词，一直没事）。⇒ 升级验收里"新建一个会话并确认它活着"这一步，
 *   不能用"我记得点一下"，必须能自动跑。
 *
 * 它做四件事（都通过宿主的本地桥，不碰任何内部 API）：
 *   ① `op:ping`   —— 桥在不在（不在 ⇒ 判不了，退出码 2，不误报）
 *   ② `op:create` —— 按 preset 新建一个会话（先把现有会话 id 记下来，用差集认领新的那个）
 *   ③ `op:prompt` —— 发一句最小的话（默认「升级冒烟：回复 ok」）**逼它走一次提示词组装**
 *   ④ 读那个会话的转录：**有没有 assistant 消息**（有=起来了）；同时盯错误串、并读出首轮输入 token
 *
 * 用法：
 *   node 会话冒烟.mjs                      # 默认 preset=unattended，cwd=当前钉住的项目
 *   node 会话冒烟.mjs --preset standard    # 换 preset
 *   node 会话冒烟.mjs --cwd <示例项目> --text "ok" --timeout 120
 *   node 会话冒烟.mjs --json               # 给机器吃（起飞前检查 ⑫ 就这么调）
 *   node 会话冒烟.mjs --no-create          # 只验最近 N 分钟内新建的那个会话（不新建）
 *
 * 退出码：0 = 起来了 / 1 = 没起来（附错误串）/ 2 = 判不了（桥不在、token 读不到、超时）
 *
 * ⚠️ 副作用（如实交代）：会**真的留下一个会话**在界面里（这是它的目的）；发一句话会花一次额度
 *    （实测约 2.9 万 input token，≈ 一次大脑请求的固定前缀）。不想留就自己归档那个会话。
 * ⚠️ 只读的部分：它**不写**任何文件（不落缓存、不改配置）。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SESS_ROOT = join(DSH_HOME, 'sessions')
const TOKEN_FILE = process.env.DSH_SWAP_TOKEN_FILE ?? join(HERE, 'secrets', 'swap-token.txt')
const BRIDGE = process.env.DSH_SWAP_URL ?? `http://127.0.0.1:${process.env.DSH_SWAP_PORT ?? 19390}/swap`

const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? (argv[i + 1] ?? d) : d }
const AS_JSON = argv.includes('--json')
const NO_CREATE = argv.includes('--no-create')
const PRESET = opt('preset', 'unattended')
const TIMEOUT_S = Math.max(10, Number(opt('timeout', 120)))
const TEXT = opt('text', '升级冒烟：回复 ok')

function pinnedProject () {
  try {
    const p = readFileSync(join(ROOT, '_crew', '当前项目.txt'), 'utf8').replace(/^\uFEFF/, '').trim()
    return p || null
  } catch { return null }
}
const CWD = opt('cwd', pinnedProject() ?? ROOT)

/** cwd → DSH 会话目录名（与 注入体检.mjs / 换新会话.mjs 同一口径） */
function encodeDir (p) {
  const mapped = String(p).replace(/[^A-Za-z0-9]/g, ch => ch.codePointAt(0) > 0x7f ? '~' + ch.codePointAt(0).toString(16).toUpperCase() : '-')
  return '--' + mapped.replace(/-+/g, '-') + '--'
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const out = { preset: PRESET, cwd: CWD, bridge: BRIDGE, sessionId: null, created: false, promptSent: false, elapsedSec: null, firstInputTokens: null, error: null, verdict: null, code: null }

function finish (code, verdict, error = null) {
  out.code = code; out.verdict = verdict; out.error = error
  if (AS_JSON) process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  else {
    console.log(`🔬 会话冒烟 · preset=${PRESET} · cwd=${CWD}`)
    if (out.sessionId) console.log(`   会话 ${out.sessionId}${out.created ? '（本次新建）' : ''}${out.firstInputTokens ? ` · 首轮 input ${out.firstInputTokens} token` : ''}`)
    console.log('\n' + (code === 0 ? '✅ ' : code === 2 ? 'ℹ️ ' : '❌ ') + verdict)
    if (error) console.log('   错误：' + String(error).slice(0, 400))
    if (code !== 0) console.log('   细节：`node _unattended\\会话体检.cjs` 看全库；或点开那个会话看报错')
  }
  process.exit(code)
}

async function post (body) {
  const r = await fetch(BRIDGE, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-dsh-swap-token': TOKEN },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000)
  })
  const j = await r.json().catch(() => ({}))
  if (!r.ok || j.ok === false) throw new Error(`${body.op}: http ${r.status} ${j.error ?? ''}`)
  return j.value ?? j
}

/** 读一个会话的转录（多帧 zstd） */
function readSession (file) {
  const buf = readFileSync(file)
  const offs = []
  for (let i = 0; i + 3 < buf.length; i++) if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) offs.push(i)
  const recs = []
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length
    let text = ''
    try { text = zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8') } catch { continue }
    for (const line of text.split(/\r?\n/)) { if (line[0] !== '{') continue; try { recs.push(JSON.parse(line)) } catch {} }
  }
  return recs
}

const ERR_MARKS = ['unknown prompt variable', 'malformed prompt variable', 'prompt assembly', 'failed to assemble']

let TOKEN = ''
try {
  TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim()
} catch { finish(2, `读不到桥的 token（${TOKEN_FILE}）⇒ 判不了（桥没起？）`) }
if (!TOKEN) finish(2, `token 文件是空的（${TOKEN_FILE}）⇒ 判不了`)

const t0 = Date.now()
try {
  /* ① 桥在不在 */
  try { await post({ op: 'ping' }) } catch (e) { finish(2, `宿主桥连不上（${BRIDGE}）⇒ 判不了（桌面端没起？）`, e.message) }

  /* ② 记下现有会话，再新建 */
  const before = new Set(((await post({ op: 'list' }))?.items ?? []).map(x => x.sessionId))
  if (!NO_CREATE) {
    await post({ op: 'create', agentPreset: PRESET, cwd: CWD })
    out.created = true
    let found = null
    for (let i = 0; i < 20 && !found; i++) {
      await sleep(400)
      const items = ((await post({ op: 'list' }))?.items ?? [])
      found = items.find(x => !before.has(x.sessionId) && String(x.cwd ?? '').toLowerCase() === CWD.toLowerCase()) ?? null
    }
    if (!found) finish(1, '新建后 8 秒内没在会话列表里看到它（create 没生效？）')
    out.sessionId = found.sessionId
  } else {
    const items = ((await post({ op: 'list' }))?.items ?? []).filter(x => String(x.cwd ?? '').toLowerCase() === CWD.toLowerCase())
    const newest = items.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))[0]
    if (!newest) finish(2, '--no-create：这个 cwd 下没有任何会话')
    if ((Date.now() - (newest.updatedAt ?? 0)) > 10 * 60_000) finish(2, '--no-create：最近的会话是 10 分钟前的，不算"刚建的"')
    out.sessionId = newest.sessionId
  }

  /* ③ 发一句最小的话（逼它走一次提示词组装） */
  await post({ op: 'prompt', sessionId: out.sessionId, text: TEXT, mode: 'queue' })
  out.promptSent = true

  /* ④ 等 assistant 消息 / 错误串 */
  const dir = join(SESS_ROOT, encodeDir(CWD), out.sessionId)
  const file = join(dir, 'session.v4.jsonl.zstd')
  const deadline = Date.now() + TIMEOUT_S * 1000
  let lastErr = null
  while (Date.now() < deadline) {
    await sleep(1000)
    if (!existsSync(file)) continue
    let recs = []
    try { recs = readSession(file) } catch { continue }
    const sys = recs.filter(r => r.type === 'system/message').pop()
    if (sys) {
      const st = (sys.data?.message?.content ?? []).map(c => c.text ?? '').join('\n')
      out.systemChars = st.length
      out.hasPersona = st.includes('You are the BRAIN')
    }
    const asst = recs.filter(r => r.type === 'assistant/message')
    const text = JSON.stringify(recs)
    const hit = ERR_MARKS.find(m => text.includes(m))
    if (hit) {
      const m = new RegExp(`[^"]*${hit.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"]*`).exec(text)
      finish(1, `会话**没能起来**：${hit}`, m ? m[0].slice(0, 300) : hit)
    }
    if (asst.length) {
      const u = asst[0]?.data?.usage
      if (u) {
        // ⚠️ 只报 inputTokens 会**严重误导**：新建会话的 persona+tools 往往**整段命中缓存**
        //   （实测新会话 inputTokens=247 / cacheReadTokens=28,288）⇒ 首轮真实 prompt ≈ 2.8 万，
        //   而不是 247。这里把三者加起来报，才是"这一次请求到底吃了多少上下文"。
        const n = (x) => (Number.isFinite(x) ? x : 0)
        out.firstPromptTokens = n(u.inputTokens) + n(u.cacheReadTokens ?? u.cacheReadInputTokens) + n(u.cacheWriteTokens ?? u.cacheCreationInputTokens)
        out.usage = { inputTokens: u.inputTokens ?? null, cacheReadTokens: u.cacheReadTokens ?? u.cacheReadInputTokens ?? null, cacheWriteTokens: u.cacheWriteTokens ?? u.cacheCreationInputTokens ?? null, outputTokens: u.outputTokens ?? null }
      }
      out.elapsedSec = +((Date.now() - t0) / 1000).toFixed(1)
      // ⚠️ 假绿的另一个口子：**会话起来了 ≠ 预设生效**。没带 persona 的会话一样能回话，
      //    那正是这次事故的同款失败（看着正常、其实没加载规矩）。所以 unattended 必须验 persona。
      if (PRESET === 'unattended' && !out.hasPersona) {
        finish(1, `会话能回话，但 **persona 没生效**（system ${out.systemChars ?? '?'} 字符、没有 "You are the BRAIN"）⇒ 预设没加载，别当绿`)
      }
      finish(0, `会话正常起来了（${out.elapsedSec} 秒内拿到 assistant 消息；首轮 prompt 总量 ${out.firstPromptTokens ?? '?'} token = 输入 ${out.usage?.inputTokens ?? '?'} + 缓存读 ${out.usage?.cacheReadTokens ?? '?'}；persona ${out.hasPersona ? '已加载' : '未加载'}）`)
    }
    lastErr = null
  }
  finish(2, `等了 ${TIMEOUT_S} 秒没等到 assistant 消息（也没抓到已知错误串）⇒ 判不了，去点开 ${out.sessionId} 看`, lastErr)
} catch (e) {
  finish(1, '冒烟过程本身出错：' + String(e?.message ?? e).slice(0, 200))
}
