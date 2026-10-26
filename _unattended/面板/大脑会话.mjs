/**
 * 大脑会话 · **读"大脑（DSH 自己）"这一格的会话，并往它里面投话**（2026-10-11）
 *
 * ## 为什么要有它（和五职位那套不是一条链）
 * 五个职位走编排：派活 → 载体子进程 → `<task>.prompt.txt` ＋ `<task>.out.json` → 班组账本。
 * **大脑不走编排**：它是 DSH 自己的会话，话在 **DSH 转录**里
 *   `~\.dsh\sessions\<cwd 编码>\session-<id>\session.v4.jsonl.zstd`（zstd 帧拼接，解出来是 JSONL）。
 * ⇒ 面板要"看见大脑这一格"，只能**读 DSH 的转录**；要"插话"，只能**请宿主帮忙投**（见下）。
 *
 * ## 两件事分别靠什么
 *   ① **读**：`看板数据.mjs` 已经把"哪条会话是大脑"挑好了（本项目目录内、真源名单内、最近写入），
 *      并把 `brainRow.sessionId / sessionPath` 给了出来 ⇒ **这里不自己再挑一遍**（两处口径必漂）。
 *      只解**尾巴若干帧**（实测：全解 137ms，尾 3 帧 ≈0ms）⇒ 面板每 15 秒轮询撑得住。
 *   ② **写**：`POST http://127.0.0.1:19390/swap`（`dsh-crew-bridge` 插件，跑在宿主进程里）
 *      的 `op:'prompt'` —— 宿主 `sessionController.prompt({sessionId, mode, content})`。
 *      **为什么必须借宿主**：桌面端的鉴权 token 只在 Electron 壳里流转，外部脚本拿不到；
 *      只有跑在宿主里的插件够得着那个服务（这条在 `bridge-plugin\lib\index.js` 头注里写着）。
 *
 * ## `mode` 的真值（**从 asar 里查的，不是猜的**）
 *   `@deepseek-ai/dsh-api-session-controller/lib/client.js`：
 *     `@param mode - queue appends after the current turn; steer interrupts it.`
 *     `const placement = this.running ? input.mode === "steer" ? "steering" : "queued" : "transcript"`
 *     `lib/index.js: if (request.mode === "steer") agent.steer(message); else agent.followup(message);`
 *   ⇒ 合法值只有 **`queue`** 与 **`steer`**；用户 2026-10-11 拍板要"打断并入" ⇒ **`steer`**。
 *   ⚠️ 它只在"正在跑"时才谈得上打断：没在跑时两种 mode 都落到 `transcript`（＝一条普通消息）⇒ **永远发 steer 是安全的**。
 *
 * ## 纪律
 *   · **只读**转录；投话**只经桥**，绝不自己写 DSH 的文件
 *   · 桥不在 / token 不对 / 会话没定位到 ⇒ **如实报错**，绝不假装投出去了
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import zlib from 'node:zlib'
import { toConversation } from './会话/brain.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const BOARD_DATA = process.env.DSH_BOARD_DATA ?? join(ROOT, '_crew', 'board-data.json')
const SWAP_TOKEN_FILE = process.env.DSH_SWAP_TOKEN_FILE ?? join(HERE, '..', 'secrets', 'swap-token.txt')
const BRIDGE = process.env.DSH_SWAP_URL ?? `http://127.0.0.1:${Number(process.env.DSH_SWAP_PORT ?? 19390)}/swap`
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
/** 只扫文件**末尾**这么多字节来找 zstd 帧（帧均 ~1.6KB ⇒ 60 帧 ≈ 100KB，1MB 足够宽裕）。 */
const TAIL_WINDOW = 1 << 20

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null } }

/**
 * 看板数据里那条大脑会话（**唯一口径**：与大脑格的模型/上下文占用同源）。
 * ⚠️ 不在这里"再挑一次会话" —— 挑的规则只有一处（`看板数据.mjs` 的 `hit`），否则两处必漂。
 * ⚠️ 实测（2026-10-11）：`brainRow.sessionPath` 是**会话目录**（`…\session-<id>`），
 *   **不是**转录文件本身 —— 我第一版直接 statSync 它，拿到的是"目录、0 字节"⇒ 报"转录文件是空的"。
 *   所以这里统一解析成**真文件**（目录 ⇒ 依次试三个候选名；已是文件就用它）。
 */
export function readBoardBrain () {
  const b = readJson(BOARD_DATA)
  if (!b) return { ok: false, why: '读不到看板数据（' + BOARD_DATA + '）—— 先跑一次 看板数据.mjs' }
  const r = b.brainRow ?? null
  if (!r) return { ok: false, why: '看板数据里没有 brainRow' }
  if (!r.sessionPath) {
    return {
      ok: false,
      why: r.sessionScope === 'undetermined'
        ? '当前工作区未定（没有钉住）⇒ 不知道哪条会话是"大脑"'
        : '看板数据里没有大脑会话路径（brainRow.sessionPath 为空）—— 先跑一次 看板数据.mjs',
      sessionScope: r.sessionScope ?? null
    }
  }
  try { statSync(r.sessionPath) } catch { return { ok: false, why: '大脑会话路径不存在：' + r.sessionPath } }
  const file = resolveTranscript(r.sessionPath)
  if (!file) return { ok: false, why: '这个会话目录里没有转录文件（试过 session.v4.jsonl.zstd / session.jsonl / session.v4.jsonl）：' + r.sessionPath }
  return {
    ok: true,
    sessionId: r.sessionId ?? null,
    sessionDir: r.sessionPath,
    sessionPath: file,
    state: r.state ?? null,
    contextText: r.contextText ?? null,
    contextNote: r.contextNote ?? null,
    modelText: r.modelText ?? null,
    scopeNote: r.scopeNote ?? null
  }
}

/**
 * 只解**尾巴若干帧**（zstd 帧拼接 ⇒ 不必全解）。
 * 返回 `{ ok, text, framesTried, framesOk, windowBytes, fileBytes }`。
 * ⚠️ 正在写的**末帧可能半截**（物理必然）⇒ 解不开的**跳过**，并把 `framesTried/framesOk` 如实报出来。
 */
export function readTranscriptTail (file, frames = 60) {
  let fileBytes = 0
  try { fileBytes = statSync(file).size } catch { return { ok: false, why: '读不到转录文件：' + file } }
  if (!fileBytes) return { ok: false, why: '转录文件是空的（0 字节）' }
  const windowBytes = Math.min(fileBytes, TAIL_WINDOW)
  const from = fileBytes - windowBytes
  let buf
  try {
    const fd = openSync(file, 'r')
    try { buf = Buffer.alloc(windowBytes); readSync(fd, buf, 0, windowBytes, from) } finally { closeSync(fd) }
  } catch (e) { return { ok: false, why: '读转录文件失败：' + String(e?.message ?? e) } }

  const offs = []
  let o = 0
  while (o < buf.length) { const i = buf.indexOf(ZSTD_MAGIC, o); if (i === -1) break; offs.push(i); o = i + 4 }
  if (!offs.length) return { ok: false, why: '这个文件里没有 zstd 帧（不是转录文件？）' }

  const parts = []
  let tried = 0
  for (let k = offs.length - 1; k >= 0 && parts.length < frames; k--) {
    const s = offs[k]
    const e = k + 1 < offs.length ? offs[k + 1] : buf.length
    tried++
    try { parts.unshift(zlib.zstdDecompressSync(buf.subarray(s, e))) } catch { /* 半截帧/假魔数：跳过 */ }
  }
  const text = Buffer.concat(parts).toString('utf8')
  return { ok: true, text, framesTried: tried, framesOk: parts.length, windowBytes, fileBytes }
}

/**
 * 把"会话目录或转录文件"统一解析成**真转录文件**（目录 ⇒ 依次试三个候选名）。
 * ⚠️ 实测（2026-10-11）：`brainRow.sessionPath` 是**会话目录**，不是文件本身。
 */
export function resolveTranscript (sessionPath) {
  if (!sessionPath) return null
  let st = null
  try { st = statSync(sessionPath) } catch { return null }
  if (!st.isDirectory()) return sessionPath
  const cands = ['session.v4.jsonl.zstd', 'session.jsonl', 'session.v4.jsonl']
  return cands.map((c) => join(sessionPath, c)).find((p) => { try { return statSync(p).isFile() } catch { return false } }) ?? null
}

/** 一轮没写收尾记录、且静默超过这么久 ⇒ 判为"停着（可能被中断）"，不再永恒亮灯。 */
const STALE_TURN_SEC = 3600

/**
 * 从文件末尾**往回**找最近的轮次标记（`turn/start` / `turn/end`），**逐帧解、找到即停**。
 *
 * ⚠️ 为什么不能"只看固定帧数"（我第一版就是这么错的）：一"轮"里的帧数**没有上限** ——
 *   实测那一刻，最近的轮次标记离尾巴 **45 帧**（一轮刚开始），而长轮次几百上千帧都有。
 *   固定看 40 帧 ⇒ **看不出** ⇒ 退回老判据 ⇒ 灯又灭（用户报的就是这个）。
 *
 * 代价：实测往回 46 帧 **4ms**（窗口 512KB 起，找不到才放大到 4MB / 16MB）。
 */
export function lastTurnMarker (file, { windows = [1 << 19, 1 << 22, 1 << 24] } = {}) {
  let size = 0
  try { size = statSync(file).size } catch { return { ok: false, why: '读不到转录文件：' + file } }
  if (!size) return { ok: false, why: '转录文件是空的（0 字节）' }
  for (const win of windows) {
    const w = Math.min(size, win)
    let buf = null
    try {
      const fd = openSync(file, 'r')
      try { buf = Buffer.alloc(w); readSync(fd, buf, 0, w, size - w) } finally { closeSync(fd) }
    } catch (e) { return { ok: false, why: '读转录文件失败：' + String(e?.message ?? e) } }
    const offs = []
    let o = 0
    while (o < buf.length) { const i = buf.indexOf(ZSTD_MAGIC, o); if (i === -1) break; offs.push(i); o = i + 4 }
    for (let k = offs.length - 1; k >= 0; k--) {
      const s = offs[k]
      const e = k + 1 < offs.length ? offs[k + 1] : buf.length
      let text = ''
      try { text = zlib.zstdDecompressSync(buf.subarray(s, e)).toString('utf8') } catch { continue }
      const lines = text.split(/\r?\n/)
      for (let li = lines.length - 1; li >= 0; li--) {          // 帧内也从后往前
        const line = lines[li]
        if (!line.includes('turn/')) continue
        let j = null
        try { j = JSON.parse(line) } catch { continue }
        if (j.type === 'turn/start' || j.type === 'turn/end') {
          return {
            ok: true, type: j.type, turn: j.data?.turn ?? null, seq: Number(j.seq ?? 0),
            time: Number(j.time) || null, framesWalked: offs.length - 1 - k, windowBytes: w
          }
        }
      }
    }
    if (w >= size) break                                        // 已经读到文件头，再放大没意义
  }
  return { ok: false, why: '整个转录里都没有轮次标记（turn/start｜turn/end）' }
}

/**
 * ★ 2026-10-11（用户报障："**状态也不匹配，明明应该是绿灯**"）——**大脑"在跑"的真判据**。
 *
 * 病根：老判据是"**转录文件最后写入多少秒前**（窗口 10 秒）"，而**模型思考期间一个事件都不写**
 *   （用户看到 DSH 那边"深度求索中，用时 2分31秒"，面板却已经报"空闲"）
 *   ⇒ 只要一次 LLM 调用超过 10 秒，灯就灭 —— 而那正是"它在真干活"的时候。
 *
 * 新判据：**最近的轮次标记是哪个** ——
 *   · 最近一个是 `turn/start` ⇒ **正在跑**（思考多久都算在跑）
 *   · 最近一个是 `turn/end` ⇒ 停着
 *   ⚠️ 兜底：如果"最近是 turn/start"但转录已静默 > 1 小时 ⇒ 判停着（DSH 被强杀会留下悬空的 `turn/start`，
 *      不然那盏灯会**永恒亮着**）。这一条是**防悬挂**，不是判活。
 *
 * 返回 `{ ok, running, why, ageSec, dangling? }`；`ok:false` ＝ 看不出（调用方退回老判据，**不编**）。
 */
export function turnStateOf (sessionPath, opts) {
  const file = resolveTranscript(sessionPath)
  if (!file) return { ok: false, why: '找不到转录文件：' + String(sessionPath ?? '（空）') }
  let mtimeMs = 0
  try { mtimeMs = statSync(file).mtimeMs } catch {}
  const ageSec = mtimeMs ? Math.round((Date.now() - mtimeMs) / 1000) : null
  const m = lastTurnMarker(file, opts)
  if (!m.ok) return { ok: false, why: m.why, ageSec }
  const tailNote = '转录静默 ' + ageSec + 's（**思考期间不写事件，所以不看这个**）'
  if (m.type === 'turn/end') {
    return { ok: true, running: false, ageSec, turn: m.turn, why: '最近一个轮次标记是 turn/end（第 ' + m.turn + ' 轮已收尾）· ' + tailNote }
  }
  if (ageSec != null && ageSec > STALE_TURN_SEC) {
    return { ok: true, running: false, dangling: true, ageSec, turn: m.turn, why: '最近是 turn/start（第 ' + m.turn + ' 轮）但转录已静默 ' + Math.round(ageSec / 60) + ' 分钟 ⇒ 判停着（可能被中断）' }
  }
  return { ok: true, running: true, ageSec, turn: m.turn, why: '最近一个轮次标记是 turn/start（第 ' + m.turn + ' 轮还没收尾）· ' + tailNote }
}

/** 同上，但**自己去拿"哪条是大脑"**（口径同 `readBoardBrain`：一处挑、别处不重挑）。 */
export function brainTurnState (opts) {
  const b = readBoardBrain()
  if (!b.ok) return { ok: false, why: b.why }
  return turnStateOf(b.sessionPath, opts)
}

/* ── 桥（投话）────────────────────────────────────────────────────────── */

function readSwapToken () {
  try { const t = readFileSync(SWAP_TOKEN_FILE, 'utf8').trim(); return t || null } catch { return null }
}

async function bridgeCall (op, extra = {}, timeoutMs = 15000) {
  const token = readSwapToken()
  if (!token) return { ok: false, why: '读不到换会话桥的 token（' + SWAP_TOKEN_FILE + '）' }
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetch(BRIDGE, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-dsh-swap-token': token },
      body: JSON.stringify({ op, ...extra }),
      signal: ac.signal
    })
    const text = await r.text()
    if (r.status === 401) return { ok: false, why: '桥拒绝：token 不对（插件重启后会换 token，重读 swap-token.txt）' }
    let j = null
    try { j = JSON.parse(text) } catch {}
    if (!j) return { ok: false, why: '桥返回非 JSON（HTTP ' + r.status + '）：' + text.slice(0, 200) }
    if (!j.ok) return { ok: false, why: '桥执行 ' + op + ' 失败：' + String(j.error ?? JSON.stringify(j).slice(0, 200)) }
    return { ok: true, value: j.value, raw: j }
  } catch (e) {
    return { ok: false, why: '连不上换会话桥（' + BRIDGE + '）：' + String(e?.name === 'AbortError' ? '超时' : (e?.message ?? e)) }
  } finally { clearTimeout(t) }
}

/**
 * **宿主认的会话 id 形态**（`session-<uuid>`）—— 这一手是**实测踩出来的**，别省：
 *
 * `看板数据.mjs` 从目录名取 id 时**把 `session-` 前缀剥掉了**（`String(s).replace(/^session-/, '')`），
 * 而宿主 `sessionController` 认的是**带前缀**的那种 —— 桥自己的 `op=list` 返回的就是
 * `session-13b6775e-…`（换会话链一直拿这个去 prompt/cancel，所以它能用）。
 *
 * ⚠️ 症状（2026-10-11 用户实测报的）：面板投话 ⇒ 桥转发 ⇒ 宿主回
 *   `桥执行 prompt 失败：session "13b6775e-7bfa-4187-9227-0465bb7591bf" not found`
 *   —— **不是"会话没打开"，是 id 少了个前缀**。（实测同一条会话在 `op=list` 里
 *   `agentAvailable: true`、`running: true` ⇒ 宿主本来收得了。）
 */
export function hostSessionId (id) {
  const s = String(id ?? '').trim()
  if (!s) return ''
  return /^session-/.test(s) ? s : 'session-' + s
}

/**
 * 往大脑会话里投一句话（**用户口径：打断并入**）。
 * `mode`：`'steer'`＝打断当前这轮并把你这句话并进去；`'queue'`＝等这轮干完再接上。
 * ⚠️ 没在跑时两种 mode 都等于"发一条普通消息"（宿主侧 `placement='transcript'`）⇒ 发 steer 安全。
 */
export async function sayToBrain ({ sessionId, text, mode = 'steer' }) {
  const body = String(text ?? '').trim()
  if (!sessionId) return { ok: false, why: '不知道要投给哪条会话（sessionId 为空）' }
  if (!body) return { ok: false, why: '话是空的' }
  if (body.length > 3000) return { ok: false, why: '话太长（>' + 3000 + ' 字），先精简' }
  if (!['steer', 'queue'].includes(mode)) return { ok: false, why: '未知 mode：' + mode + '（只认 steer / queue）' }
  const to = hostSessionId(sessionId)          // ★ 必须补回 `session-` 前缀（见 hostSessionId 的注释）
  const r = await bridgeCall('prompt', {
    requestId: 'panel-' + Date.now(),
    sessionId: to,
    mode,
    text: body
  })
  if (!r.ok) {
    // 宿主回 not-found 时给一句**有用的**话（别只把宿主的原文丢给人）
    const why = /not found/i.test(String(r.why))
      ? r.why + '　（宿主只认它**已经打开/在跑**的那条会话；这条可能没在 DSH 里开着 —— 也可能是 id 形态不对，见 hostSessionId 注释）'
      : r.why
    return { ok: false, why }
  }
  return {
    ok: true, mode, sessionId: to,
    value: r.value ?? null,
    note: mode === 'steer'
      ? '已按「打断并入」投出：它当前这轮会被打断，这句话并进去接着跑（若它本来没在跑，就是一条普通消息）'
      : '已按「排队」投出：等它当前这轮干完再接上'
  }
}

/**
 * 让宿主**停掉当前这一轮**（＝DSH 界面那个"停止"按钮干的事）。
 *
 * ★ 2026-10-11（用户："**然后会话运行过程中，这个暂停也点不了**"）：b24 时我把大脑那格的「暂停」
 *   **禁用**了，理由是"它的活不是子进程、没有杀进程这回事"—— 那个理由**只对了一半**：
 *   杀子进程确实不适用，但**宿主有它自己的停法**：桥的 `op:'cancel'` → `session.cancel({sessionId})`
 *   （宿主源码注释原文："Stop the active turn while the Host preserves pending inbox work"）。
 *   ⇒ 现在接上它。与「发送（steer）」的区别：
 *     · **插话（steer）**＝打断当前这一轮 **并把你这句话并进去**
 *     · **暂停（cancel）**＝**只停、不带话**（会话与排队的话都还在，不会丢）
 */
export async function stopBrain ({ sessionId }) {
  if (!sessionId) return { ok: false, why: '不知道要停哪条会话（sessionId 为空）' }
  const to = hostSessionId(sessionId)          // ★ 同 `sayToBrain`：宿主认带 `session-` 前缀的
  const r = await bridgeCall('cancel', { sessionId: to })
  if (!r.ok) return { ok: false, why: r.why }
  const v = r.value ?? null
  // ⚠️ 桥把**宿主的返回**包在 `value` 里：`value.ok === false` 也是"没停成" ——
  //   只看 HTTP 200 就报成功，是"假装停掉了"（本项目最恨那种假象）。
  const hostOk = v && typeof v === 'object' && 'ok' in v ? Boolean(v.ok) : null
  if (hostOk === false) {
    return { ok: false, sessionId: to, value: v, why: '宿主说没停成：' + JSON.stringify(v).slice(0, 200) }
  }
  return {
    ok: true, sessionId: to, value: v,
    note: '已让宿主停掉当前这一轮（会话与排队的话都还在，不会丢）'
  }
}

/** 桥 `op:list` → 本机会话清单（只读）。`items` 是数组。 */
export async function listBrainSessions () {
  const r = await bridgeCall('list')
  if (!r.ok) return r
  const items = Array.isArray(r.value) ? r.value : (r.value?.items ?? [])
  return { ok: true, items }
}

/** 会话标题（给界面"让你一眼核对是哪条会话"用）。**取不到就 null**，不猜、不挡路。 */
let titleCache = { at: 0, map: null }
export async function brainTitle (sessionId) {
  if (!sessionId) return null
  if (titleCache.map && Date.now() - titleCache.at < 60000) return titleCache.map.get(sessionId) ?? null
  const r = await listBrainSessions()
  if (!r.ok) return null
  const map = new Map()
  for (const it of r.items) {
    const id = String(it.sessionId ?? '').replace(/^session-/, '')
    const v = it.projections?.values ?? {}
    map.set(id, { title: v.title ?? null, running: Boolean(it.running), preset: v.agentPreset ?? null, updatedAt: it.updatedAt ?? null })
  }
  titleCache = { at: Date.now(), map }
  return map.get(sessionId) ?? null
}

/**
 * 服务端主入口：**这一格大脑的会话**（只读）。
 * 返回 `{ ok, session:{id,file,title,running,contextText,modelText,state}, entries:[…], tail:{…} }`
 */
export async function brainSession ({ frames = 60, maxEntries = 120 } = {}) {
  const b = readBoardBrain()
  if (!b.ok) return { ok: false, error: b.why, sessionScope: b.sessionScope ?? null }
  const tail = readTranscriptTail(b.sessionPath, frames)
  if (!tail.ok) return { ok: false, error: tail.why, session: { id: b.sessionId, file: b.sessionPath } }
  let entries = []
  try { entries = toConversation(tail.text) } catch (e) { return { ok: false, error: '翻译转录失败：' + String(e?.message ?? e) } }
  const info = await brainTitle(b.sessionId)
  const cut = entries.length > maxEntries ? entries.slice(-maxEntries) : entries
  return {
    ok: true,
    role: '大脑',
    session: {
      id: b.sessionId, file: b.sessionPath,
      title: info?.title ?? null, running: info?.running ?? null, preset: info?.preset ?? null,
      state: b.state, contextText: b.contextText, modelText: b.modelText, scopeNote: b.scopeNote
    },
    entries: cut,
    shown: cut.length, total: entries.length,
    tail: { framesOk: tail.framesOk, framesTried: tail.framesTried, fileBytes: tail.fileBytes, windowBytes: tail.windowBytes }
  }
}
