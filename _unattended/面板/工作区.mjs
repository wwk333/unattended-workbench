/**
 * 工作区（= DSH 会话的工作目录）发现与"钉住" · 2026-10-10
 *
 * 为什么有它：用户口径（2026-10-10）——
 *   "看板顶部弄一个选择工作区的东西…做项目时要先选工作区，让 DSH 的工作区和看板对齐，我在看板上手动钉。"
 *   "一个工作区通常只有一个大脑在运行（也许有其它会话，但一定只有一个在跑）⇒ 可以据此定位大脑。"
 *
 * 数据从哪来（**实测结论，不是猜**）：
 *   · DSH profile 里**没有**工作区清单文件（只有 cordis/pnpm 配置）⇒ 用不了它；
 *   · 会话目录名 `--D-xiangmu-~5F02~6B21~5143--` 是 cwd 的**有损编码**（反斜杠变成 `-`，
 *     而路径里本来就可能带 `-`，如 `_t2-verify`）⇒ **不能反解**；
 *   · 但**每条会话的 header 里写着真 cwd**（`{"type":"session",…,"cwd":"<示例项目>"}`）⇒ 权威来源。
 *     文件是多段 zstd 帧拼接，**取第一帧**即可拿到 header（不必解全部）。
 *
 * 口径：
 *   · 工作区 = cwd 去重（大小写与斜杠统一后再比）；
 *   · "在跑" = 该工作区**最新一次会话写入**在 RUNNING_WINDOW_SEC 秒内（用户口径：一个工作区只会有一个在跑的会话）；
 *   · 取不到就如实标 `unknown`，**不猜**。
 */
import { readFileSync, readdirSync, statSync, writeFileSync, existsSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { zstdDecompressSync } from 'node:zlib'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { turnStateOf } from './大脑会话.mjs'   // ★ 判"在跑"的真判据（与大脑那盏灯**同一处实现**）

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')                    // 工作台根
const POINTER = join(ROOT, '_crew', '当前项目.txt')
const SESS_ROOT = process.env.DSH_SESSIONS_DIR ?? join(homedir(), '.dsh', 'sessions')
/**
 * 工作区"在跑"的判定窗口（秒）。
 * ★ 2026-10-11 用户拍板 **180 → 10** —— 与大脑那个窗口**必须同值**：
 *   两者测的是**同一个事实**（"最新一次会话写入有多新"），不一致就会自相矛盾
 *   （大脑说"停着"、顶栏那个点却说在跑）。
 * ⚠️ 同值的三处：本文件 · `看板数据.mjs` 的 `BRAIN_RUNNING_WINDOW_SEC` · `面板\service.mjs` 的同名常量。
 *   改就三处一起改（或用 `DSH_BRAIN_WINDOW_SEC` 环境变量统一覆盖）。
 */
const RUNNING_WINDOW_SEC = Number.isFinite(Number(process.env.DSH_BRAIN_WINDOW_SEC))
  ? Number(process.env.DSH_BRAIN_WINDOW_SEC)
  : 10
const CACHE_MS = 60000
/**
 * ★ 「空会话」的字节上限（**小于它就当空会话、侧栏不显示、看板也不算**）。
 *
 * 为什么是 2KB 而不是"大于 0"：zstd 流自带文件头 ⇒ **空会话也有几百字节**，
 * 实测空会话落在 **332〜1213 B**、真会话**从 ~10KB 起**，中间没有重叠 ⇒ 取 2KB 稳稳落在空档里。
 * （2026-10-11 用户报障："工作区里没会话，看板还显示 1 个" —— 那个是 `596277f5`，1108 B。）
 */
const EMPTY_SESSION_MAX_BYTES = 2048

const norm = (p) => String(p ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()

/** 从会话文件里抠 header 的 cwd（只解第一帧，快）。 */
function cwdOfSession (file) {
  try {
    const buf = readFileSync(file)
    let p = -1
    for (let i = 0; i < Math.min(buf.length - 4, 1 << 20); i++) {
      if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) { p = i; break }
    }
    if (p < 0) return null
    const txt = zstdDecompressSync(buf.subarray(p, Math.min(buf.length, p + 20000))).toString('utf8')
    const m = txt.match(/"cwd"\s*:\s*"((?:[^"\\]|\\.)*)"/)
    if (!m) return null
    return m[1].replace(/\\\\/g, '\\').replace(/\\"/g, '"')
  } catch { return null }
}

const WS_STORE = process.env.DSH_WORKSPACE_STORE ?? join(homedir(), '.dsh', 'storages', 'workspace.json')

/** ★ 2026-10-11（用户当场纠正）：**真源是 DSH 自己的 `workspace.json`，不是磁盘痕迹**。
 *   之前的错：扫 `~\.dsh\sessions\*` 的所有 cwd 当工作区 ⇒ 冒出 16 个（含 `dsh-preset-test`、
 *   `_角色自检`、Temp 目录、**用户已删掉的**），而侧栏只有 3 个（异次元 / 无人值守 / 未分组）。
 *   根因一句话：**磁盘永远留着历史痕迹，侧栏是筛选后的投影**。
 *   现在：结构**通用地**抠出"确实存在的目录"（数组/对象/嵌套都吃，不假设 shape）；
 *   读不到就**如实说取不到**，**绝不回退到磁盘痕迹**（否则又变成"看着像、其实不是"）。 */
function readWorkspacePaths () {
  let raw
  try { raw = JSON.parse(readFileSync(WS_STORE, 'utf8')) }
  catch (e) { return { ok: false, error: '读不到/解析失败 ' + WS_STORE + '：' + String((e && e.message) || e), paths: [] } }
  const out = []
  const seen = new Set()
  const looksPath = (s) => /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\')
  const walk = (v, depth = 0) => {
    if (depth > 8) return
    if (typeof v === 'string') {
      if (looksPath(v) && existsSync(v) && !seen.has(norm(v))) { seen.add(norm(v)); out.push(v) }
      return
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, depth + 1); return }
    if (v && typeof v === 'object') { for (const x of Object.values(v)) walk(x, depth + 1) }
  }
  walk(raw)
  // ★ 2026-10-11：**真源里每个工作区自带会话名单** —— `tables.workspaces[id] = {path,title,sessionIds,…}`。
  //   ⇒ "某工作区有几个会话"该数**这份名单**（去掉 `global.archivedSessionIds`＝侧栏的"删除"），
  //   **不是**按 cwd 字符串比（那是错的：cwd 相同但归"未分组"的旧会话会被算进来 —— 实测异次元 cwd 6 条、侧栏只 1 条）。
  const byPath = new Map()
  const tables = raw?.tables?.workspaces ?? {}
  for (const [id, v] of Object.entries(tables)) {
    const p = v && typeof v === 'object' ? (v.path ?? v.rootPath ?? v.folder ?? null) : (typeof v === 'string' ? v : null)
    if (!p || !existsSync(p)) continue
    byPath.set(norm(p), {
      id,
      title: (v && v.title) || String(p).split(/[\\/]/).filter(Boolean).pop() || p,
      sessionIds: Array.isArray(v?.sessionIds) ? v.sessionIds.map((x) => String(x).replace(/^session-/, '')) : []
    })
  }
  const archived = new Set((raw?.global?.archivedSessionIds ?? []).map((x) => String(x).replace(/^session-/, '')))
  return { ok: true, paths: out, store: WS_STORE, archived, byPath }
}

let cache = { at: 0, val: null }

/**
 * 这个工作区"在跑"吗。
 *
 * ★ 2026-10-11（用户报障："**状态也不匹配，明明应该是绿灯**"）：老口径＝"最新一次会话写入 < 窗口(10s)"，
 *   而**模型思考期间一个事件都不写** ⇒ 正在干活时下拉里却显示"N 分钟前"。
 *   新口径：**钉住的那个工作区**用**轮次标记**判（`turnStateOf`，与大脑那盏灯同一处实现）；
 *   其余工作区仍用"最后写入"窗口 —— 轮次标记要读转录（每个工作区一次读盘），
 *   **只在钉住那条上花这个代价**（界面上也只有它会被你盯着看）。
 */
function runningOf (p, hit, now, pinnedPath) {
  if (!hit || !hit.lastMs) return false
  const isPinned = Boolean(pinnedPath) && norm(p) === norm(pinnedPath)
  // ★ 2026-10-11（用户截图实测自相矛盾：**下拉写"在跑"、大脑那格写"空闲"**）：**钉住那条只认轮次标记**。
  //   原来的顺序是"最后写入 ≤ 窗口 ⇒ 先短路成在跑"，而大脑那盏灯只认 `turn/start｜turn/end`
  //   ⇒ 一轮**刚收尾的头 10 秒**两处必然打架（纪律是"这两处必须同判据"）。读不出轮次标记（老会话）才退回窗口。
  if (isPinned && hit.lastDir) {
    const ts = turnStateOf(hit.lastDir)
    if (ts.ok) return Boolean(ts.running)
  }
  if ((now - hit.lastMs) / 1000 <= RUNNING_WINDOW_SEC) return true
  if (!isPinned || !hit.lastDir) return false
  const ts = turnStateOf(hit.lastDir)
  return ts.ok ? Boolean(ts.running) : false
}

/** 列工作区：`{path, name, sessions, lastSecAgo, running}`，按最近活动排。 */export function listWorkspaces (force = false) {
  if (!force && cache.val && Date.now() - cache.at < CACHE_MS) return cache.val
  const store = readWorkspacePaths()          // ★ 真源（工作区清单 ＋ 已归档会话 id）
  const archived = store.archived ?? new Set()
  const byCwd = new Map()
  const idxById = new Map()                   // ★ sessionId → {dir,tBytes,mtimeMs}（用来排"空会话"，阈值见 EMPTY_SESSION_MAX_BYTES）
  let dirs = []
  try { dirs = readdirSync(SESS_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { dirs = [] }
  for (const d of dirs) {
    let subs = []
    try { subs = readdirSync(join(SESS_ROOT, d), { withFileTypes: true }).filter((x) => x.isDirectory()).map((x) => x.name) } catch { continue }
    for (const s of subs) {
      if (archived.has(String(s).replace(/^session-/, ''))) continue   // ★ 归档的（＝侧栏已删）不算
      const dir = join(SESS_ROOT, d, s)
      // ⚠️ 2026-10-11 修（同一个坑第三次踩）：**活跃度必须用"转录文件的 mtime"** ——
      //   目录 mtime 只在**增删文件**时才变；会话持续往同一个 `session.v4.jsonl.zstd` 里写时，
      //   目录 mtime 会一直停在上次增删的时刻 ⇒ 实测差 **4.5 小时**（接口说大脑"6 秒前"、
      //   这里却说"无人值守 16366 秒前"）。
      //   口径与 `看板数据.mjs` 的 `sessionMtimeSize()` **一致**：优先转录文件，读不到才退回目录 mtime。
      let mtimeMs = 0
      let tBytes = 0
      let hasTranscript = false
      for (const cand of ['session.v4.jsonl.zstd', 'session.jsonl', 'session.v4.jsonl']) {
        try { const st = statSync(join(dir, cand)); mtimeMs = st.mtimeMs; tBytes = st.size; hasTranscript = true; break } catch { /* 换下一个候选名 */ }
      }
      if (!hasTranscript) {
        try { mtimeMs = statSync(dir).mtimeMs } catch { continue }   // 没有转录文件才退回目录 mtime
      }
      const cwd = cwdOfSession(join(dir, 'session.v4.jsonl.zstd')) ?? cwdOfSession(join(dir, 'session.jsonl'))
      if (!cwd) continue
      // ★ 2026-10-11：`tBytes` 用来排除**空会话**（判据演进见文件头 `EMPTY_SESSION_MAX_BYTES`）。
      idxById.set(String(s).replace(/^session-/, ''), { dir, tBytes, mtimeMs })
      const k = norm(cwd)
      const cur = byCwd.get(k) ?? { path: cwd, sessions: 0, lastMs: 0, lastDir: null }
      cur.sessions += 1
      if (mtimeMs > cur.lastMs) { cur.lastMs = mtimeMs; cur.lastDir = dir }   // ★ 记住最新那条的目录（判"在跑"要读它）
      byCwd.set(k, cur)
    }
  }
  const now = Date.now()
  const pinnedNow = readPinned()          // ★ 先读一次：判"在跑"要看"是不是钉住那条"（别每个工作区都读文件）
  // ★ 真源＝workspace.json；磁盘扫描只用来**补统计**（会话数/最近活动/在跑，**已排除归档的**），**不用来造工作区**。
  const ws = store
  if (!ws.ok) return { ok: false, error: ws.error, list: [], pinned: readPinned(), source: WS_STORE, sourceNote: '取不到真源，不回退磁盘痕迹' }
  const list = ws.paths.map((p) => {
    const meta = ws.byPath ? ws.byPath.get(norm(p)) : null
    const hit = byCwd.get(norm(p))
    // ★ "几个会话" ＝ 真源名单里的会话数（**去掉归档**）——与侧栏逐个数对齐；
    const listed = meta ? meta.sessionIds.filter((id) => !archived.has(id)) : null
    // ★ 再排掉"空会话"（侧栏不显示这种）。阈值 2KB —— 理由见上面 `tBytes` 处（空 ≤1.3KB、真 ≥10KB）。
    const usable = listed ? listed.filter((id) => { const e = idxById.get(id); return e ? e.tBytes >= EMPTY_SESSION_MAX_BYTES : false }) : null
    const emptyDropped = listed && usable ? listed.length - usable.length : null
    // ★ 2026-10-12（**探针 ⑤ 当场逮住的口径分叉**）：**"最近活动"必须跟"会话数"用同一个集合**。
    //   原来活跃度直接吃磁盘扫描（该 cwd 下**全部**未归档会话），而会话数只认真源名单 ⇒
    //   一个**不在名单里**的会话在写时（实测＝大脑开的 subagent 会话），下拉说"在跑"、大脑那格说"停着"
    //   ——实测 **工作区 1s / 大脑 112s（差 111 秒）**。纪律是"这两处必须同判据"（见 handoff）。
    //   名单取不到（`usable` 为 null）⇒ 照旧退回磁盘扫描，**不假装知道**。
    let actMs = hit ? hit.lastMs : 0
    let actDir = hit ? hit.lastDir : null
    if (usable) {
      actMs = 0; actDir = null
      for (const id of usable) {
        const e = idxById.get(id)
        if (e && e.mtimeMs > actMs) { actMs = e.mtimeMs; actDir = e.dir }
      }
    }
    return {
      path: p,
      name: (meta && meta.title) || String(p).split(/[\\/]/).filter(Boolean).pop() || p,
      workspaceId: meta ? meta.id : null,
      listedTotal: meta ? meta.sessionIds.length : null,
      archivedInList: meta ? meta.sessionIds.filter((id) => archived.has(id)).length : null,
      emptyDropped,
      sessions: usable ? usable.length : (hit ? hit.sessions : 0),
      sessionsSource: usable ? '真源 sessionIds（去归档、去空会话 <2KB）' : '磁盘扫描（真源里没有这份名单）',
      lastMs: actMs,
      lastSecAgo: actMs ? Math.round((now - actMs) / 1000) : null,
      running: runningOf(p, { lastMs: actMs, lastDir: actDir }, now, pinnedNow),
      activitySource: usable ? '真源名单内最新写入（与会话数同一个集合）' : '磁盘扫描（真源里没有这份名单）'
    }
  })
  const pinned = pinnedNow
  const val = {
    ok: true, at: new Date().toISOString(), source: WS_STORE,
    sourceNote: '真源＝DSH workspace.json（磁盘痕迹只补统计，不参与"有哪些工作区"）',
    skippedFromDisk: [...byCwd.keys()].filter((k) => !ws.paths.some((p) => norm(p) === k)).length,
    pinned, list
  }
  cache = { at: now, val }
  return val
}

/** 当前钉住的项目（读 `_crew\当前项目.txt` 首行；空/无 = 跟随会话）。 */
export function readPinned () {
  try {
    if (!existsSync(POINTER)) return null
    const t = readFileSync(POINTER, 'utf8').trim().split(/\r?\n/)[0].trim()
    return t || null
  } catch { return null }
}

/** 钉住 / 清钉：写 `_crew\当前项目.txt`，然后**带 --project 重生成看板数据**（让板子立刻跟上）。 */
export function pinProject (path) {
  const before = readPinned()
  try {
    writeFileSync(POINTER, path ? String(path) : '', 'utf8')
  } catch (e) { return { ok: false, error: '写指针失败：' + String((e && e.message) || e) } }
  // 重生成（带项目 ⇒ currentProject.set = true；清钉 ⇒ 走"跟随会话"）
  const args = [join(ROOT, '_unattended', '看板数据.mjs')]
  if (path) args.push('--project', String(path))
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 120000, cwd: ROOT })
  cache = { at: 0, val: null }
  return {
    ok: r.status === 0,
    before, after: path ?? null,
    regenerated: r.status === 0,
    note: r.status === 0
      ? (path ? `已钉住 ${path}（看板数据已按它重生成）` : '已清钉 → 跟随会话工作区（看板数据已重生成）')
      : ('看板数据重生成失败：' + String((r.stderr || r.stdout || '')).trim().slice(0, 160))
  }
}
