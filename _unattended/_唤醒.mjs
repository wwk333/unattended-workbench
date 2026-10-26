/**
 * 叫醒大脑（换会话桥）—— **唯一实现**，供 `进度看护.mjs` 与 `编排.mjs`（D4 的 45 分钟唤醒）共用。
 *
 * 三条安全线（缺一条都不发；来自 2026-10-05 用户拍板"开 B"）：
 *   ① 只在**判定为异常/需要人**时调用，绝不用于"顺手问一句"；
 *   ② 调用方负责**去重**（同一件事只叫一次），这里不重复判；
 *   ③ **认不出人就只写文件、不发** —— 绝不猜着发。
 *
 * ★ D27（2026-10-23 拍板）**认人改成五步，从宽到严**（原来只认 cwd，有洞：空会话会顶掉大脑、模式不对也照发）：
 *   1 `cwd === project`（保持现状）
 *   2 **当前模式 = unattended** —— 读法：**扫会话全流取最后一条 `agent-preset/selected`**，
 *     没有才退回首帧的 `agentPreset`（⚠️ 首帧只是**创建时**的值，切模式不回写，直接拿它当"当前模式"就是踩过的坑）；
 *   3 排除 `blank: true`（空会话里没有大脑，投进去等于没叫）；
 *   4 要求 `agentAvailable: true`（关掉/换过的会话投不进）；
 *   5 取 `updatedAt` 最新（多候选兜底）。
 *
 * ★ D27「找不到必须出声」（**不许静默 `ok:false`**）：
 *   认不出人 ⇒ ① `<项目>\_crew\监控账本.jsonl` 记一行（verdict:'wake' / action:'no-brain'），
 *   ② 写 `<项目>\_crew\唤醒状态.json`（看板读它显示"没叫到（原因）"）。发送失败/桥拒绝同样出声。
 *   代价（认）：哪天用**标准模式**驱动流水线会"叫不到"——但它是**出声**而不是错投；真要允许，置
 *   `DSH_WAKE_ALLOW_STANDARD=1`（此时第 2 步放行任何模式，并在唤醒状态里注明）。
 *
 * 通道：换会话桥 `127.0.0.1:19390/swap`（`op:list` 认人 → `op:prompt` 发一句话），
 *   token 在 `_unattended\secrets\swap-token.txt`（与插件、换新会话、看板**四处同步**，少改一处就 token 分裂）。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'

const HERE = dirname(fileURLToPath(import.meta.url))
const WS = resolve(HERE, '..')
export const SWAP_URL = 'http://127.0.0.1:' + (process.env.DSH_BOARD_SWAP_PORT ?? 19390) + '/swap'
export const TOKEN_FILE = join(WS, '_unattended', 'secrets', 'swap-token.txt')
/** 会话转录根目录（与 `面板\工作区.mjs` 同一个环境变量，改一处两边都认）。 */
const SESS_ROOT = process.env.DSH_SESSIONS_DIR ?? join(homedir(), '.dsh', 'sessions')

const norm = (s) => String(s ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

// ── D27 第 2 步：当前模式怎么读（扫全流取末条 `agent-preset/selected`，没有才退回首帧）────────

/** 找这个会话的转录目录（`<sessions>\<组>\<会话名>\`，名字可能是 `session-<id>` 或裸 `<id>`）。 */
export function findSessionDir (sessionId) {
  const id = String(sessionId ?? '').replace(/^session-/, '')
  if (!id) return null
  const names = new Set([id, 'session-' + id, sessionId])
  let groups = []
  try { groups = readdirSync(SESS_ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name) } catch { return null }
  for (const g of groups) {
    let subs = []
    try { subs = readdirSync(join(SESS_ROOT, g), { withFileTypes: true }).filter(x => x.isDirectory()).map(x => x.name) } catch { continue }
    for (const s of subs) if (names.has(s)) return join(SESS_ROOT, g, s)
  }
  return null
}

/** 把一个会话目录里的转录逐行读出来（`.zstd`＝帧拼接，逐帧解、逐帧看，不整份进内存）。 */
function eachTranscriptLine (dir, fn) {
  const cands = ['session.v4.jsonl.zstd', 'session.jsonl', 'session.v4.jsonl']
  for (const name of cands) {
    const file = join(dir, name)
    if (!existsSync(file)) continue
    try {
      const buf = readFileSync(file)
      if (name.endsWith('.zstd')) {
        const offs = []
        for (let i = 0; i + 4 <= buf.length; i++) {
          if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) offs.push(i)
        }
        for (let k = 0; k < offs.length; k++) {
          let part
          try { part = zlib.zstdDecompressSync(buf.subarray(offs[k], k + 1 < offs.length ? offs[k + 1] : buf.length)) } catch { continue }
          for (const line of part.toString('utf8').split(/\r?\n/)) if (line.trim()) fn(line)
        }
      } else {
        for (const line of buf.toString('utf8').split(/\r?\n/)) if (line.trim()) fn(line)
      }
      return true
    } catch { /* 换下一个候选名 */ }
  }
  return false
}

/**
 * 这个会话的**当前模式**。
 * @returns {{mode:string|null, source:'stream-last-selected'|'stream-first-frame'|'projection'|'unknown'}}
 */
export function currentModeOf (item) {
  const dir = findSessionDir(item?.sessionId)
  if (dir) {
    let firstPreset = null
    let lastSelected = null
    let sawFirst = false
    eachTranscriptLine(dir, (line) => {
      if (!sawFirst) {
        sawFirst = true
        const m = line.match(/"agentPreset"\s*:\s*"([^"]*)"/)
        if (m) firstPreset = m[1]
      }
      if (line.includes('agent-preset/selected')) {
        const m = line.match(/"agentPreset"\s*:\s*"([^"]*)"/)
        if (m) lastSelected = m[1]
      }
    })
    if (lastSelected != null) return { mode: lastSelected, source: 'stream-last-selected' }
    if (sawFirst) return { mode: firstPreset, source: 'stream-first-frame' }
  }
  const p = item?.projections?.values?.agentPreset ?? null
  return { mode: p, source: p ? 'projection' : 'unknown' }
}

// ── D27 五步认人（纯函数，方便夹具回放）────────────────────────────────────

/**
 * 从桥的会话列表里挑出"大脑"。
 * @returns {{ok:true, target:object, mode:object} | {ok:false, why:string, step:number, seen?:object}}
 */
/** 换会话交接记录里的 oldSession 集合（换掉的旧会话，永远不当大脑）。读不到 ⇒ 空集，不报错。 */
export function handedOverIds (project) {
  const out = new Set()
  try {
    const j = JSON.parse(readFileSync(join(project, '_crew', '换会话交接.json'), 'utf8').replace(/^\uFEFF/, ''))
    for (const r of (Array.isArray(j?.records) ? j.records : [])) {
      if (r?.oldSession) out.add(String(r.oldSession))
    }
  } catch { /* 没有这份文件很正常：从没换过会话 */ }
  return out
}

export function pickBrain (items, project, { allowModeStandard = process.env.DSH_WAKE_ALLOW_STANDARD === '1' } = {}) {
  const want = norm(project)
  const cands = (Array.isArray(items) ? items : []).filter(s => norm(s.cwd) === want)
  const seen = { cwd: cands.length, mode: 0, alive: 0, available: 0 }
  if (!cands.length) return { ok: false, step: 1, seen, why: `没叫到（没有 cwd=${project} 的会话）` }

  // 步 2：当前模式 = unattended（读末条 agent-preset/selected，没切过就用初值）
  const withMode = cands.map(s => ({ s, m: currentModeOf(s) }))
  let inMode = withMode.filter(x => x.m.mode === 'unattended' || (allowModeStandard && x.m.mode))
  seen.mode = inMode.length
  if (!inMode.length) {
    const modes = [...new Set(withMode.map(x => `${String(x.s.sessionId).slice(0, 12)}…=${x.m.mode ?? '未知'}(${x.m.source})`))].join('、')
    return { ok: false, step: 2, seen, why: `没叫到（模式不符：${allowModeStandard ? '一个都读不出模式' : `这些会话不是 unattended —— ${modes}`}）` }
  }

  // 步 2.5（2026-10-25 实测新增）：换会话交接里 oldSession 一律排除。
  //   为什么不能靠归档表：真机实测 swapOnce 全程没有归档动作（换前换后 archivedSessionIds 一字未变），
  //   只有侧栏删会话才写归档表 ⇒ 换完一轮旧会话还在候选里，会被误当大脑。
  const handed = handedOverIds(project)
  const notHanded = inMode.filter(x => !handed.has(String(x.s.sessionId)))
  seen.handedOver = handed.size
  if (!notHanded.length) return { ok: false, step: 2.5, seen, why: '没叫到（同模式的会话都在交接记录里被换掉了）' }
  inMode = notHanded

  // 步 3：排除空会话（顶层 `blank` 优先；没有才看投影里的 sessionListMetadata）
  const isBlank = (s) => (s?.blank != null ? s.blank === true : s?.projections?.values?.sessionListMetadata?.blank === true)
  const alive = inMode.filter(x => !isBlank(x.s))
  seen.alive = alive.length
  if (!alive.length) return { ok: false, step: 3, seen, why: '没叫到（同模式的会话都是空会话 blank —— 空会话里没有大脑）' }

  // 步 4：要求 agentAvailable
  const avail = alive.filter(x => x.s.agentAvailable === true)
  seen.available = avail.length
  if (!avail.length) return { ok: false, step: 4, seen, why: '没叫到（没有 agentAvailable 的会话 —— 都关掉/换过了）' }

  // 步 5：updatedAt 最新
  // 步 5 全序（2026-10-25）：running 优先 → updatedAt → sessionId（兜底，保证永远选出一个、不并列）
  const target = avail.sort((a, b) =>
    (Number(b.s.running === true) - Number(a.s.running === true)) ||
    ((b.s.updatedAt ?? 0) - (a.s.updatedAt ?? 0)) ||
    String(a.s.sessionId).localeCompare(String(b.s.sessionId))
  )[0]
  return { ok: true, target: target.s, mode: target.m }
}

// ── 出声（D27：找不到必须出声，不许静默 ok:false）──────────────────────────

/** 监控账本一行 ＋ `唤醒状态.json`（看板读后者显示"没叫到（原因）"）。 */
export function speakWake (project, { ok, why, sessionId = null, step = null, seen = null }) {
  const at = new Date().toISOString()
  // ★ 2026-10-26（§零.6 统一信封）：补 `kind/source/stale/state`。
  //   `state`：叫到了=green；没叫到=**red**（no-brain 是红灯，不许静默、更不许绿）。
  const state = {
    schema: 1,
    kind: 'wake-status',
    source: '_唤醒.mjs',
    stale: false,
    at,
    project,
    state: ok ? 'green' : 'red',
    ok: !!ok,
    why,
    sessionId,
    step,
    seen
  }
  try {
    mkdirSync(join(project, '_crew'), { recursive: true })
    appendFileSync(join(project, '_crew', '监控账本.jsonl'),
      JSON.stringify({ at, verdict: 'wake', action: ok ? 'wake-brain' : 'no-brain', detail: { project, why, sessionId } }) + '\n', 'utf8')
  } catch { /* 账本写不进也不吞掉下面那份 */ }
  try {
    mkdirSync(join(project, '_crew'), { recursive: true })
    const tmp = join(project, '_crew', '唤醒状态.json.tmp')
    writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    renameSync(tmp, join(project, '_crew', '唤醒状态.json'))
  } catch { /* 状态文件写不进也别把账本那行吞掉 */ }
  return state
}

/**
 * 给"大脑"那个会话发一条消息（队列投递）。
 * @returns {Promise<{ok:boolean, why:string, sessionId?:string, step?:number}>}
 */
export async function wakeBrain (project, text, { timeoutMs = 8000 } = {}) {
  if (process.env.DSH_WATCH_NOTIFY === '0' || process.env.DSH_BOARD_WATCH_NOTIFY === '0') {
    return { ok: false, why: '（已关自动叫醒：DSH_BOARD_WATCH_NOTIFY=0）' }
  }
  if (!project) return { ok: false, why: '（没给项目 ⇒ 认不出大脑，跳过）' }
  const fail = (why, extra = {}) => {
    const spoken = speakWake(project, { ok: false, why, ...extra })
    return { ok: false, why: `${why} —— 已记监控账本＋唤醒状态（看板显示"没叫到"）`, spoken, ...extra }
  }
  if (!existsSync(TOKEN_FILE)) return fail('没叫到（没有桥 token 文件，发不出去）')
  const token = readFileSync(TOKEN_FILE, 'utf8').trim()
  const post = async (body) => {
    const r = await fetch(SWAP_URL, {
      method: 'POST',
      headers: { 'x-dsh-swap-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs)
    })
    return await r.json()
  }
  let list
  try { list = await post({ op: 'list' }) } catch (e) { return fail(`没叫到（桥连不上：${String(e?.message ?? e).slice(0, 80)}）`) }
  const items = list?.value?.items ?? list?.value ?? []
  if (!Array.isArray(items) || !items.length) return fail('没叫到（桥返回的会话列表读不出来）')

  // ★ D27 五步认人
  const pick = pickBrain(items, project)
  if (!pick.ok) return fail(pick.why, { step: pick.step, seen: pick.seen })

  try {
    const res = await post({ op: 'prompt', sessionId: pick.target.sessionId, mode: 'queue', text })
    if (!res?.ok) return fail(`没发出去（桥拒绝：${res?.error ?? '未知'}）`)
    const why = `✅ 已叫醒大脑（${String(pick.target.sessionId).slice(0, 20)}…，队列投递；模式=${pick.mode.mode ?? '?'}）`
    speakWake(project, { ok: true, why, sessionId: pick.target.sessionId })
    return { ok: true, why, sessionId: pick.target.sessionId }
  } catch (e) { return fail(`没发出去（发送失败：${String(e?.message ?? e).slice(0, 80)}）`) }
}

/** 大脑会话列表里有没有"认得出的大脑"（只读探测，用来在面板/日志里说"认不认得出人"）。 */
export async function findBrainSession (project) {
  if (!project || !existsSync(TOKEN_FILE)) return null
  try {
    const token = readFileSync(TOKEN_FILE, 'utf8').trim()
    const r = await fetch(SWAP_URL, {
      method: 'POST', headers: { 'x-dsh-swap-token': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'list' }), signal: AbortSignal.timeout(5000)
    })
    const list = await r.json()
    const items = list?.value?.items ?? list?.value ?? []
    const pick = pickBrain(items, project)
    return pick.ok ? pick.target : null
  } catch { return null }
}
