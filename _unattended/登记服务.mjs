#!/usr/bin/env node
/**
 * 长命资源登记册 —— **唯一写入口**（`_crew\服务登记.json`）
 *
 * ## 它治什么病（2026-10-13 实况，不是推演）
 * 换新会话后，旧会话起的 `npm run dev` 还在跑（pid 94080→83712→102696→45684，听 3000，
 * 日志写 `异次元\_crew\backend-3000.log`），DSH 右上角显示"1 个后台任务运行中 · 48 分 5 秒" ——
 * **没人知道它是谁的、该不该停**。根因：这些长命东西的归属挂在"会话"上，而会话是短暂的。
 * 方案见 `重构\长命资源归属与换会话交接 -施工文档.md`（A 登记册 / B 换会话交接 / C 看护＋一颗灯 / D 收口）。
 *
 * ## 铁律（写这个文件之前先读这三条）
 * 1. **只许这个文件写登记册**。别的脚本要登记/下架，**调用这里的函数**（`import` 后用 `up()` / `down()`），
 *    ⛔ 不许自己 `writeFileSync('_crew\服务登记.json')` —— 否则又是"同一个事实抄成几份"（口径必然分叉）。
 * 2. **看护不擅自杀**。`verify()` 只报告；要停谁，必须显式 `down()` 或 `handover({ stop:[...] })`（留痕）。
 * 3. **判据要机器可判**：pid 是否活（`process.kill(pid,0)`）· 端口属主是否等于登记的 pid
 *    （`Get-NetTCPConnection` 的 `OwningProcess`）· 有没有**未登记的监听进程**（孤儿）。**不读散文**。
 *
 * ## 用法（CLI）
 *   node 登记服务.mjs up --name 工具服务 --kind http --port 19400 --pid 1234 --ensure 确保工具服务.mjs
 *   node 登记服务.mjs down --name 工具服务
 *   node 登记服务.mjs list   [--json]
 *   node 登记服务.mjs verify [--json]          # 绿/黄/红 ＋ 逐个点名
 *   node 登记服务.mjs handover --from <旧会话id> --to <新会话id> [--stop 名字1,名字2] [--json]
 *   node 登记服务.mjs --selftest               # 自带反向验收（用临时登记册，不碰真的）
 *   · `--file <路径>` 可换登记册位置（探针用）；`--quiet` 少说话
 *
 * ## 状态口径（面板那颗「长命资源 ●」与看护同一口径）
 *   · **green**  登记的都一致（pid 活着、端口属主对得上）
 *   · **yellow** 有**孤儿**（未登记的监听进程）**或**端口属主与登记不符 —— 点名是谁、听哪个端口
 *   · **red**    有登记为"该活着"的项**已经死了**
 *   ⚠️ 三个状态**不互相吞**：yellow 不会被说成 green，`unknown`（探不到）也不假装红。
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
// ★ b91「谁动谁叫」：那声"叫"在独立小文件里（避免与 `长命资源巡检.mjs` 成环；见 _叫巡检.mjs 头注）
import { pokeInspection } from './_叫巡检.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WS = resolve(HERE, '..')                      // 工作台根（无人值守）
const CREW = join(WS, '_crew')

/** 登记册落点（探针可用 `--file` 换掉；**模块内只有这一处写**）。
 *  ★ 2026-10-16：也认环境变量 `DSH_SERVICE_REG` —— 让**别的脚本**（例：`确保后端.mjs`）被探针调用时
 *    也能把登记写进临时册，而不是污染真的 `_crew\服务登记.json`（探针改用它做反向验收）。 */
let FILE = process.env.DSH_SERVICE_REG ? resolve(process.env.DSH_SERVICE_REG) : join(CREW, '服务登记.json')
export function setRegistryFile (p) { FILE = resolve(p) }
/** 交接留痕落点（同上：探针/自检可换到临时目录，**别把假记录写进真台账**）。 */
let HANDOVER_FILE = join(CREW, '换会话交接.json')
export function setHandoverFile (p) { HANDOVER_FILE = resolve(p) }

const nowIso = () => new Date().toISOString()
const str = (s) => String(s ?? '')
/** 让 powershell 子进程**按 UTF-8 输出**（否则中文路径回来是乱码，比对必然不中）。 */
const PS_UTF8 = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; $OutputEncoding=[Text.Encoding]::UTF8; '

/* ───────────────────────── 读写（唯一写入口） ───────────────────────── */

export function readRegistry () {
  try {
    const j = JSON.parse(readFileSync(FILE, 'utf8'))
    if (!Array.isArray(j.items)) return { schema: 1, updatedAt: null, items: [] }
    return { schema: j.schema ?? 1, updatedAt: j.updatedAt ?? null, items: j.items }
  } catch { return { schema: 1, updatedAt: null, items: [] } }
}

/** 写登记册：**先留一份上一版 `.bak`，再原子替换**（tmp → rename），避免写一半被打断留半截 JSON。 */
function writeRegistry (reg) {
  mkdirSync(dirname(FILE), { recursive: true })
  try { if (existsSync(FILE)) copyFileSync(FILE, FILE + '.bak') } catch {}
  const tmp = FILE + '.tmp'
  writeFileSync(tmp, JSON.stringify({ ...reg, schema: reg.schema ?? 1, updatedAt: nowIso() }, null, 2) + '\n', 'utf8')
  renameSync(tmp, FILE)
}

/* ───────────────────────── 机器事实（pid / 监听口） ───────────────────────── */

/** pid 还活着吗（`process.kill(pid,0)` —— 只探测，不发信号）。 */
export function pidAlive (pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try { process.kill(n, 0); return true } catch { return false }
}

function psJson (script, timeoutMs = 20000) {
  // ⚠️ 踩过的坑（2026-10-16 实测）：powershell 子进程默认按**控制台码页**输出，
  //    命令行里带中文路径会变成 `<DSH根>\…` ⇒ 拿它跟工作台路径比**永远不相等**
  //    （表现为"孤儿一个都报不出来"）。所以**先钉 UTF-8 输出编码**再跑。
  const out = execFileSync('powershell', ['-NoProfile', '-Command', PS_UTF8 + script], { encoding: 'utf8', timeout: timeoutMs, windowsHide: true })
  const t = str(out).trim()
  if (!t) return null
  try { return JSON.parse(t) } catch { return null }
}

/** 本机**所有正在监听**的口：`[{port,pid,name,cmd}]`（结构化取，不读散文）。 */
export function listeningPorts () {
  const ps = [
    '$ps=@{};',
    'Get-CimInstance Win32_Process | ForEach-Object { $ps[[int]$_.ProcessId] = $_ };',
    '$r = Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | ForEach-Object {',
    '  $p = $ps[[int]$_.OwningProcess];',
    '  [pscustomobject]@{ port=[int]$_.LocalPort; pid=[int]$_.OwningProcess; name=[string]$p.Name; cmd=[string]$p.CommandLine }',
    '};',
    'if ($null -eq $r) { "[]" } else { ConvertTo-Json -Compress -InputObject @($r) }'
  ].join(' ')
  const j = psJson(ps)
  const arr = Array.isArray(j) ? j : (j ? [j] : [])
  // 同一个口可能同时有 IPv4/IPv6 两条（LocalAddress 不同）⇒ 按 port 去重（保留第一个）
  const byPort = new Map()
  for (const x of arr) { if (!byPort.has(Number(x.port))) byPort.set(Number(x.port), { port: Number(x.port), pid: Number(x.pid), name: str(x.name), cmd: str(x.cmd) }) }
  return [...byPort.values()]
}

/** 端口属主 pid（没人听 ⇒ null）。 */
export function portOwner (port) {
  const p = Number(port)
  if (!Number.isFinite(p) || p <= 0) return null
  const ps = `$c = Get-NetTCPConnection -LocalPort ${p} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if ($c) { [int]$c.OwningProcess } else { "" }`
  try {
    const out = str(execFileSync('powershell', ['-NoProfile', '-Command', PS_UTF8 + ps], { encoding: 'utf8', timeout: 15000, windowsHide: true })).trim()
    return out ? Number(out) : null
  } catch { return null }
}

/* ───────────────────────── 登记 / 下架 ───────────────────────── */

/** 登记或更新一项（按 `name` 认人）。**调用方可以是任何脚本，写的人只有这一个文件。** */
export function up (item) {
  const name = str(item?.name).trim()
  if (!name) throw new Error('up() 缺 name')
  const reg = readRegistry()
  const old = reg.items.find((x) => x.name === name)
  const merged = {
    name,
    kind: str(item.kind ?? old?.kind ?? 'process'),          // http | process
    port: item.port == null ? (old?.port ?? null) : Number(item.port),
    pid: item.pid == null ? (old?.pid ?? null) : Number(item.pid),
    logFile: item.logFile ?? old?.logFile ?? null,
    ensure: item.ensure ?? old?.ensure ?? null,               // 用哪个脚本"确保"它（红时点灯可拉起）
    owner: str(item.owner ?? old?.owner ?? '工作台'),          // 工作台 ｜ 会话id（换会话时要交接的就是它）
    startedBy: str(item.startedBy ?? old?.startedBy ?? item.owner ?? '工作台'),
    startedAt: old?.startedAt ?? nowIso(),
    updatedAt: nowIso(),
    expect: str(item.expect ?? old?.expect ?? 'running'),     // running | stopped
    // ★ 2026-10-25（§七「critical 分级」）：critical 资源死了要**停新派活**，非 critical 只黄灯。
    //   字段原来没有 ⇒ 看护/自愈器无法区分"C 状态服务挂了"和"样本补扫挂了"。默认 false，向后兼容。
    critical: item.critical === undefined ? (old?.critical === true) : item.critical === true,
    note: item.note ?? old?.note ?? null
  }
  reg.items = [...reg.items.filter((x) => x.name !== name), merged].sort((a, b) => str(a.name).localeCompare(str(b.name)))
  writeRegistry(reg)
  return merged
}

/** 下架/标记停止（**不杀进程** —— 杀是调用方的事，且要留痕）。 */
export function down (name, extra = {}) {
  const reg = readRegistry()
  const it = reg.items.find((x) => x.name === str(name))
  if (!it) return null
  it.expect = 'stopped'
  it.state = 'stopped'
  it.stoppedAt = nowIso()
  it.updatedAt = nowIso()
  if (extra.note) it.note = extra.note
  it.pid = extra.keepPid ? it.pid : null
  writeRegistry(reg)
  return it
}

/** 彻底删掉一条登记（项目没了、载体拆了才用；正常"停"用 `down()`）。 */
export function forget (name) {
  const reg = readRegistry()
  const before = reg.items.length
  reg.items = reg.items.filter((x) => x.name !== str(name))
  writeRegistry(reg)
  return { removed: before - reg.items.length }
}

export function listItems () { return readRegistry().items }

/* ───────────────────────── 核对（C：看护 ＋ 那颗灯的判据） ───────────────────────── */

/** 探针可注入一个假的监听表（用来做"反向验收"，不必真起进程）。 */
let LISTEN_OVERRIDE = null
export function setListenOverride (fnOrNull) { LISTEN_OVERRIDE = fnOrNull }

/** 这个监听进程"算我们的"吗 —— 只认**命令行里带工作台路径或 `_crew\`** 的，
 *  免得把系统服务、别的软件全报成孤儿（保守：宁可漏报，不制造噪音）。 */
function looksOurs (cmd) {
  const c = str(cmd)
  if (!c) return false
  if (c.includes(WS) || c.includes(WS.replace(/\\/g, '/'))) return true
  // 兜底（不依赖中文路径编码）：我们的脚本都住在 `_crew\` / `_unattended\` / `_probe\` 下面
  return /(_crew|_unattended|_probe)[\\/]/i.test(c)
}

/**
 * 核对现状。返回 `{state, items[], orphans[], dead[], mismatch[], counts, at}`。
 * · `state`：red（有该活的登记项死了）> yellow（孤儿 / 端口属主不符）> green
 * ⚠️ 只报告，**绝不杀谁**。
 */
export function verify (opts = {}) {
  const reg = readRegistry()
  let listen = []
  try { listen = LISTEN_OVERRIDE ? LISTEN_OVERRIDE() : listeningPorts() } catch { listen = [] }
  const byPort = new Map(listen.map((x) => [Number(x.port), x]))

  const items = []
  const dead = []
  const mismatch = []
  for (const it of reg.items) {
    const row = { name: it.name, kind: it.kind, port: it.port, pid: it.pid, owner: it.owner, expect: it.expect, ensure: it.ensure ?? null, status: 'ok', why: null }
    if (it.expect === 'stopped') { row.status = 'stopped'; row.why = '登记为"已停"'; items.push(row); continue }
    if (it.pid) { if (pidAlive(it.pid)) { row.alive = true } else { row.alive = false; row.status = 'dead'; row.why = `登记的 pid ${it.pid} 已不在` } }
    if (it.port) {
      const l = byPort.get(Number(it.port))
      if (!l) { if (row.status === 'ok') { row.status = 'dead' } row.why = (row.why ? row.why + '；' : '') + `端口 ${it.port} 没人听` }
      else if (it.pid && Number(l.pid) !== Number(it.pid)) {
        row.status = row.status === 'dead' ? 'dead' : 'mismatch'
        row.why = (row.why ? row.why + '；' : '') + `端口 ${it.port} 的属主是 pid ${l.pid}（登记 ${it.pid}）`
      } else if (!it.pid) { row.pid = l.pid; row.alive = true }
    }
    if (row.status === 'dead') dead.push(row)
    else if (row.status === 'mismatch') mismatch.push(row)
    items.push(row)
  }

  const regPorts = new Set(reg.items.map((x) => Number(x.port)).filter(Boolean))
  const regPids = new Set(reg.items.map((x) => Number(x.pid)).filter(Boolean))
  const orphans = listen
    .filter((l) => !regPorts.has(Number(l.port)) && !regPids.has(Number(l.pid)) && looksOurs(l.cmd))
    .map((l) => ({ port: l.port, pid: l.pid, name: l.name, cmd: str(l.cmd).slice(0, 200) }))
    .sort((a, b) => a.port - b.port)

  const state = dead.length ? 'red' : ((orphans.length || mismatch.length) ? 'yellow' : 'green')
  return {
    state,
    at: nowIso(),
    items,
    dead,
    mismatch,
    orphans,
    counts: { registered: reg.items.length, running: reg.items.filter((x) => x.expect !== 'stopped').length, dead: dead.length, mismatch: mismatch.length, orphans: orphans.length },
    registry: FILE
  }
}

/** 一行中文结论（面板悬停 / 看护日志共用，避免两处各写一套话）。 */
export function verdictZh (v) {
  if (v.state === 'green') return `一致（登记 ${v.counts.running} 项在册，孤儿 0）`
  if (v.state === 'red') return `有 ${v.counts.dead} 项该活着却死了：` + v.dead.map((x) => x.name).join('、')
  const bits = []
  if (v.orphans.length) bits.push(`孤儿 ${v.orphans.length} 个：` + v.orphans.map((o) => `pid ${o.pid} 听 ${o.port}`).join('、'))
  if (v.mismatch.length) bits.push(`属主不符 ${v.mismatch.length} 项：` + v.mismatch.map((x) => x.name).join('、'))
  return bits.join('；')
}

/* ───────────────────────── B：换会话＝一次资源交接（必须留痕） ───────────────────────── */

function killTree (pid) {
  try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { timeout: 15000, windowsHide: true, stdio: 'ignore' }); return true } catch { return false }
}

/**
 * 交接：把 `owner === from` 的长命资源交给新会话。
 * · **默认接管**（改 owner=新会话，记"谁在何时接的"）；
 * · `stop:[名字]` 里的显式**停掉**（杀进程树 ＋ 记 `state=stopped`）—— **只有点名的才杀**；
 * · 产出 `_crew\换会话交接.json`（保留最近 50 笔）。
 * 判据（文档原话）：换会话后，登记册里**不存在** `owner=旧会话` 且 `expect=running` 的项。
 */
export function handover ({ from, to, stop = [], reason = '换会话', wrap = null } = {}) {
  const fromId = str(from)
  const toId = str(to)
  if (!fromId || !toId) throw new Error('handover() 缺 from/to')
  const stopSet = new Set((Array.isArray(stop) ? stop : [stop]).map((s) => str(s).trim()).filter(Boolean))
  const reg = readRegistry()
  const took = []
  const stopped = []
  for (const it of reg.items) {
    if (str(it.owner) !== fromId) continue
    if (it.expect === 'stopped') continue
    if (stopSet.has(it.name)) {
      const killed = it.pid ? killTree(it.pid) : false
      it.expect = 'stopped'; it.state = 'stopped'; it.stoppedAt = nowIso(); it.updatedAt = nowIso()
      it.note = `换会话停掉（kill=${killed}）：${reason}`
      stopped.push({ name: it.name, pid: it.pid, killed })
    } else {
      it.owner = toId; it.tookOverAt = nowIso(); it.updatedAt = nowIso()
      it.note = `换会话接管：${fromId} → ${toId}`
      took.push({ name: it.name, pid: it.pid, port: it.port })
    }
  }
  writeRegistry(reg)

  const rec = { at: nowIso(), reason, oldSession: fromId, newSession: toId, took, stopped,
    // ★ b90：把"旧会话到底收尾了没有"一起留痕（判据在 `交接核验.mjs`）——交接文件不能只记"资源归谁"，
    //   还要记"**新会话能不能接得上**"：旧会话没写断点/没收尾时，这里必须看得见。
    wrap: wrap ? { ok: Boolean(wrap.ok), level: wrap.level ?? null, why: String(wrap.why ?? ''), facts: wrap.facts ?? null } : null,
    rule: '默认接管；只有点名的才停（看护/交接都不擅自杀）。换会话后不允许再存在 owner=旧会话 且 expect=running 的项。' }
  let H = { schema: 1, updatedAt: null, records: [] }
  try { const j = JSON.parse(readFileSync(HANDOVER_FILE, 'utf8')); if (Array.isArray(j.records)) H = j } catch {}
  H.records = [...H.records, rec].slice(-50)
  H.updatedAt = rec.at
  mkdirSync(dirname(HANDOVER_FILE), { recursive: true })
  writeFileSync(HANDOVER_FILE, JSON.stringify(H, null, 2) + '\n', 'utf8')

  // 判据自检：交接后不许还剩"旧会话 owner 且 expect=running"
  const leftover = readRegistry().items.filter((x) => str(x.owner) === fromId && x.expect !== 'stopped').map((x) => x.name)
  return { ok: leftover.length === 0, ...rec, leftover, file: HANDOVER_FILE }
}

/* ───────────────────────── 自带反向验收（--selftest） ───────────────────────── */

async function selftest () {
  const { mkdtempSync, rmSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const dir = mkdtempSync(join(tmpdir(), 'dengji-'))
  const regFile = join(dir, '服务登记.json')
  const hFile = join(dir, '换会话交接.json')
  setRegistryFile(regFile)
  setHandoverFile(hFile)
  let pass = 0; const bad = []
  const ck = (name, cond, extra = '') => { if (cond) { pass++; console.log(`  ✅ ${name}${extra ? '　' + extra : ''}`) } else { bad.push(name); console.log(`  ❌ ${name}${extra ? '　' + extra : ''}`) } }

  const livePid = process.pid
  up({ name: '甲服务', kind: 'http', port: 19400, pid: livePid, ensure: '确保工具服务.mjs', owner: '工作台' })
  up({ name: '乙服务', kind: 'process', pid: 999999, owner: 'session-OLD' })
  ck('登记两条', readRegistry().items.length === 2)

  // 假监听表：19400 属主＝本进程（登记一致）；3000 是一个"我们的"未登记监听（孤儿）
  setListenOverride(() => ([
    { port: 19400, pid: livePid, name: 'node.exe', cmd: `node ${join(WS, '_unattended', 'x.mjs')}` },
    { port: 3000, pid: 45684, name: 'node.exe', cmd: `tsx watch ${join(WS, 'x')} _crew\\backend-3000.log` },
    { port: 445, pid: 4, name: 'System', cmd: 'System' }
  ]))
  const v1 = verify()
  ck('死的登记项 ⇒ 红', v1.state === 'red', `state=${v1.state}`)
  ck('点名死的那一项', v1.dead.length === 1 && v1.dead[0].name === '乙服务')
  ck('孤儿被点出（3000）', v1.orphans.length === 1 && v1.orphans[0].port === 3000, `orphans=${JSON.stringify(v1.orphans.map((o) => o.port))}`)
  ck('系统进程不算孤儿（445）', !v1.orphans.some((o) => o.port === 445))

  down('乙服务')
  const v2 = verify()
  ck('停掉死项后转黄（仍有孤儿）', v2.state === 'yellow', `state=${v2.state}`)
  setListenOverride(() => ([{ port: 19400, pid: livePid, name: 'node.exe', cmd: `node ${join(WS, '_unattended', 'x.mjs')}` }]))
  ck('孤儿清掉后转绿', verify().state === 'green')
  // ⚠️ 这一则要"登记的 pid **还活着**、但端口属主是别人" —— 否则先撞"死了"那一档（红），测不到 mismatch。
  ck('端口属主不符 ⇒ 黄并点名',
    (() => { up({ name: '丙服务', kind: 'http', port: 19420, pid: livePid }); setListenOverride(() => ([{ port: 19400, pid: livePid, name: 'node.exe', cmd: WS }, { port: 19420, pid: 222222, name: 'node.exe', cmd: WS }])); const v = verify(); return v.state === 'yellow' && v.mismatch.length === 1 && v.mismatch[0].name === '丙服务' })())
  forget('丙服务'); setListenOverride(null)

  // 交接：默认接管、只有点名的才停
  up({ name: '后端:甲', kind: 'http', port: 3100, pid: 999999, owner: 'session-OLD' })
  const h1 = handover({ from: 'session-OLD', to: 'session-NEW' })
  ck('交接：默认接管', h1.took.length === 1 && h1.stopped.length === 0)
  ck('交接后无残留（owner 已换新）', h1.leftover.length === 0)
  ck('旧会话已无 owner=running', readRegistry().items.every((x) => x.owner !== 'session-OLD' || x.expect === 'stopped'))
  ck('交接留痕文件写了（临时目录）', existsSync(hFile))
  ck('不点名的不会被杀（甲 pid 仍是 999999）', readRegistry().items.find((x) => x.name === '后端:甲').pid === 999999)
  up({ name: '后端:乙', kind: 'http', port: 3101, pid: 999999, owner: 'session-NEW2' })
  const h2 = handover({ from: 'session-NEW2', to: 'session-NEW3', stop: ['后端:乙'] })
  ck('点名停掉：记 stopped 且留痕', h2.stopped.length === 1 && readRegistry().items.find((x) => x.name === '后端:乙').expect === 'stopped')

  setRegistryFile(join(CREW, '服务登记.json'))
  try { rmSync(dir, { recursive: true, force: true }) } catch {}
  console.log(`\n[登记服务 · selftest] ${pass}/${pass + bad.length} 通过${bad.length ? '　❌ ' + bad.join('、') : ''}`)
  process.exit(bad.length ? 1 : 0)
}

/* ───────────────────────── CLI ───────────────────────── */

function main () {
  const argv = process.argv.slice(2)
  const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
  const AS_JSON = argv.includes('--json')
  const QUIET = argv.includes('--quiet')
  if (opt('file')) setRegistryFile(opt('file'))
  const cmd = argv.find((a) => !a.startsWith('--') && ['up', 'down', 'forget', 'list', 'verify', 'handover'].includes(a))

  // ⚠️ `--json` ＝ **只出机器可读**（人话一律不打）—— 原来两个都打，消费方 `JSON.parse(stdout)` 直接抛
  //    （探针就踩了：`list --json` 后面还跟一行中文 ⇒ 解析失败 ⇒ 被当成"登记册是空的"）。
  const out = (obj, human) => {
    if (AS_JSON) process.stdout.write(JSON.stringify(obj) + '\n')
    else if (!QUIET && human) console.log(human)
  }

  // ★ b91「谁动谁叫」：登记册**变过** ⇒ 叫一声长命资源巡检（让状态文件当场变新）。
  //   ⚠️ 那声"叫"在独立小文件 `_叫巡检.mjs` 里（**不是**在 `长命资源巡检.mjs` 里）—— 因为巡检 import 本文件的
  //   `verify()`，若让本文件反过来 import 巡检就成环了。只在 CLI 的 up/down 路径上叫，
  //   程序化调用（巡检自己）永远不触发 ⇒ 没有递归。fail-soft：叫不动就算了（看护 30 分钟兜底）。
  const poke = (by) => pokeInspection(by)

  if (cmd === 'up') {
    const it = up({
      name: opt('name'), kind: opt('kind', 'process'), port: opt('port') ? Number(opt('port')) : null,
      pid: opt('pid') ? Number(opt('pid')) : null, logFile: opt('log'), ensure: opt('ensure'),
      owner: opt('owner', '工作台'), startedBy: opt('started-by', opt('owner', '工作台')), note: opt('note')
    })
    out({ ok: true, item: it }, `登记：${it.name}　pid=${it.pid ?? '-'}　port=${it.port ?? '-'}　owner=${it.owner}`)
    poke('事件:登记 ' + it.name)
    return
  }
  if (cmd === 'down') { const it = down(opt('name'), { note: opt('note') }); out({ ok: Boolean(it), item: it }, it ? `已标记停止：${it.name}` : `没有这一项：${opt('name')}`); if (!it) process.exitCode = 1; else poke('事件:停登记 ' + it.name); return }
  if (cmd === 'forget') { const r = forget(opt('name')); out({ ok: r.removed > 0, ...r }, r.removed ? '已删除' : '没有这一项'); return }
  if (cmd === 'list') {
    const items = listItems()
    out({ ok: true, items, file: FILE }, items.length ? items.map((i) => `${i.name}　pid=${i.pid ?? '-'}　port=${i.port ?? '-'}　owner=${i.owner}　expect=${i.expect}`).join('\n') : '（登记册是空的）')
    return
  }
  if (cmd === 'verify') {
    const v = verify()
    out({ ok: v.state === 'green', ...v, verdict: verdictZh(v) }, `【长命资源】${v.state.toUpperCase()}　${verdictZh(v)}\n${v.items.map((i) => `  ${i.status === 'ok' ? '✅' : (i.status === 'stopped' ? '⏹' : '⚠️')} ${i.name}　pid=${i.pid ?? '-'}　port=${i.port ?? '-'}　${i.why ?? ''}`).join('\n')}`)
    process.exit(v.state === 'green' ? 0 : (v.state === 'yellow' ? 2 : 3))
  }
  if (cmd === 'handover') {
    const h = handover({ from: opt('from'), to: opt('to'), stop: str(opt('stop')).split(',').map((s) => s.trim()).filter(Boolean) })
    out(h, `交接：接管 ${h.took.length} 件、停掉 ${h.stopped.length} 件；残留 ${h.leftover.length} 件　→ ${h.file}`)
    process.exit(h.ok ? 0 : 1)
  }
  console.log('用法：node 登记服务.mjs up|down|forget|list|verify|handover …（见文件头注释；--selftest 自带验收）')
  process.exitCode = 1
}

const invokedDirectly = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url
if (invokedDirectly) {
  if (process.argv.includes('--selftest')) await selftest()
  else main()
}
