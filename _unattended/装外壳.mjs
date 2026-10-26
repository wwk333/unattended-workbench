#!/usr/bin/env node
/**
 * 装外壳 —— **用户看得见的"入口"装机器**（幂等 · 可体检 · 可卸载）。★ b126（2026-10-18）
 *
 * ## 用户口径
 *   *"你做一个自动新建快捷方式的脚本，然后绑定 dsh桌面端启动器，启动 dsh 就运行脚本，检查桌面是否有快捷方式，
 *     没有就建立一个……这个主要是为了到时候给其他用户用的，因为最终要开源，需要用户开箱即用。"*
 *   ＋ 拍板三条：**① 首启问一句 ② 删了补回一次、`--uninstall` 之后永不再建 ③ 做整套"外壳"**。
 *
 * ## 为什么不"跑一次就永不再跑"（这是本文件存在理由）
 *   快捷方式**会指错**：工作台一搬家（本机就搬过：`<DSH根>\无人值守` → `<工作台根>`），
 *   `.lnk` 里写死的**目标/图标绝对路径**当场失效 ⇒ 桌面上留一个**点了没反应**的图标，比不建更糟。
 *   ⇒ 正确形态＝**幂等体检**：每次 DSH 启动看一眼，只在"没有 / 指错"时动手，正常就 **0 动作**（不重写、不刷桌面）。
 *
 * ## 五档行为（`--autostart` 是插件在 DSH 启动时调的那档）
 *   `--check`      只体检，**不写任何东西**；有问题退 **2**（黄，不拦），好着退 0
 *   `--autostart`  无标记 ⇒ **只记"待问"，一个快捷方式都不建**；已同意 ⇒ 缺了就补（记补回次数）；已卸载/已拒绝 ⇒ 0 动作
 *   `--install`    真建（幂等）；用户在看板上点「建立」之后走这条
 *   `--dismiss`    记下"不用了"，以后不再问也不建
 *   `--uninstall`  只删**我们建的**（按状态里记的路径 ＋ 逐项核对目标），然后**永不再建**
 *
 * ## 开源场景的五个坑（都在这儿处理了）
 *   ① 桌面可能被 OneDrive/组策略重定向 ⇒ 一律问系统要 `[Environment]::GetFolderPath('Desktop')`，
 *      **取不到就不建**并如实报（绝不瞎写 `Public\Desktop`）
 *   ② 用户可能没装 Edge（只有 Chrome / 都没有）⇒ 探测 Edge → Chrome → 其它 Chromium；
 *      都没有 ⇒ 退化成 `.url`（能用，但**只能用浏览器打开**，状态里如实标注）
 *   ③ 绝对路径会随搬家失效 ⇒ 状态里存"我们写的目标"，每次体检比对
 *   ④ 杀软/COM 可能被拦 ⇒ 失败**出声**（不假装成功）
 *   ⑤ 往桌面丢图标容易招人烦 ⇒ 默认**只建一个**桌面图标 ＋ 两个开始菜单项；给 `--uninstall`；**首启先问**
 *
 * 用法：`node _unattended\装外壳.mjs [--check|--autostart|--install|--dismiss|--uninstall] [--json]`
 * 退出码：0 = 正常（check：体检通过）｜2 = check 发现该修的（黄）｜1 = 出了错 ｜3 = 用法错
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))          // = _unattended
const ROOT = resolve(HERE, '..')                              // = 工作台根
const PANEL_DIR = join(HERE, '面板')
const BOARD_CMD = join(PANEL_DIR, 'start-board.cmd')
const BOARD_ICO = join(PANEL_DIR, 'board.ico')
const STATE_FILE = join(ROOT, '_crew', '外壳状态.json')
const SELF = fileURLToPath(import.meta.url)

const argv = process.argv.slice(2)
const has = (f) => argv.includes('--' + f)
const JSON_OUT = has('json')
const NAME_BOARD = '班组看板'
const NAME_UNINSTALL = '无人值守 · 卸载外壳'

// ── 跑一段 PowerShell（**用 -EncodedCommand**：免临时文件、免 BOM 与引号地狱，中文也稳）────────
function ps (script, timeout = 60000) {
  const enc = Buffer.from(script, 'utf16le').toString('base64')
  const r = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc],
    { encoding: 'utf8', timeout, windowsHide: true })
  return { ok: r.status === 0, out: String(r.stdout ?? '').trim(), err: String(r.stderr ?? '').trim(), status: r.status }
}

// ── 状态 ─────────────────────────────────────────────────────────────────────
function readState () {
  try {
    const j = JSON.parse(readFileSync(STATE_FILE, 'utf8').replace(/^\uFEFF/, ''))
    return { schema: 1, 用户选择: null, 已卸载: false, 待问: false, 建过: {}, 补回次数: 0, ...j }
  } catch {
    return { schema: 1, 用户选择: null, 已卸载: false, 待问: false, 建过: {}, 补回次数: 0 }
  }
}
function writeState (st) {
  st.updatedAt = new Date().toISOString()
  try { writeFileSync(STATE_FILE, JSON.stringify(st, null, 2), 'utf8'); return true } catch (e) { console.error('❌ 状态写不进去：' + String(e?.message ?? e)); return false }
}

// ── 环境探测 ─────────────────────────────────────────────────────────────────
/** 系统认的桌面／开始菜单目录（**必须问系统**：可能被 OneDrive / 组策略重定向）。 */
function folders () {
  const r = ps(`$d=[Environment]::GetFolderPath('Desktop');$p=[Environment]::GetFolderPath('Programs');` +
    `[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;` +
    `ConvertTo-Json @{desktop=$d;programs=$p} -Compress`)
  try { const j = JSON.parse(r.out); return { desktop: j.desktop || null, programs: j.programs || null } } catch { return { desktop: null, programs: null } }
}
/** 找一个能吃 `--app` 的 Chromium 系浏览器（Edge → Chrome → 其它）。 */
function findBrowser () {
  const pf = process.env['ProgramFiles'] ?? 'C:\\Program Files'
  const pf86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  const la = process.env['LOCALAPPDATA'] ?? ''
  const cands = [
    ['Edge', join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['Edge', join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe')],
    ['Chrome', join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Chrome', join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe')],
    ['Chrome', join(la, 'Google', 'Chrome', 'Application', 'chrome.exe')]
  ]
  for (const [name, p] of cands) if (p && existsSync(p)) return { name, exe: p }
  return null
}
const PANEL_URL = `http://127.0.0.1:${process.env.DSH_PANEL_PORT ?? 19450}/`

// ── 建 / 读 / 删快捷方式（全走 PowerShell，路径由状态记）──────────────────────
const q = (s) => String(s ?? '').replace(/'/g, "''")   // 单引号转义（PS 单引号字符串）

/** @returns {{ok:boolean, err?:string}} */
function makeLnk (opts) {
  const { path, target, args, wd, icon, style, desc } = opts
  const r = ps(`$ErrorActionPreference='Stop'
try {
  $s = New-Object -ComObject WScript.Shell
  $v = $s.CreateShortcut('${q(path)}')
  $v.TargetPath = '${q(target)}'
  $v.Arguments = '${q(args)}'
  $v.WorkingDirectory = '${q(wd)}'
  ${icon ? `$v.IconLocation = '${q(icon)}'` : ''}
  $v.WindowStyle = ${Number(style ?? 1)}
  $v.Description = '${q(desc)}'
  $v.Save()
  'ok'
} catch { 'ERR ' + $_.Exception.Message }`)
  if (!r.ok || r.out.startsWith('ERR')) return { ok: false, err: (r.out || r.err || 'unknown').slice(0, 300) }
  return { ok: true }
}
/** 读回一个 .lnk 的关键字段（体检"指得对不对"就靠它）。 */
function readLnk (path) {
  const r = ps(`try {
  $s = New-Object -ComObject WScript.Shell
  $v = $s.CreateShortcut('${q(path)}')
  [Console]::OutputEncoding=[System.Text.Encoding]::UTF8
  ConvertTo-Json @{target=$v.TargetPath;args=$v.Arguments;icon=$v.IconLocation;wd=$v.WorkingDirectory} -Compress
} catch { 'ERR' }`)
  try { const j = JSON.parse(r.out); return j && j.target ? j : null } catch { return null }
}
function delFile (path) { try { ps(`Remove-Item -LiteralPath '${q(path)}' -Force -ErrorAction SilentlyContinue`); return true } catch { return false } }

/**
 * 这个已存在的文件**像不像我们建的**？（★ 2026-10-18 实测撞出来的隐患）
 *   场景：用户自己在同一路径放了个同名快捷方式（指向记事本/计算器…）——
 *   如果补回逻辑"看见指向不对就重写"，就会**把用户自己的文件覆盖掉**。
 *   ⇒ 认人的口径：**目标必须是 cmd.exe，且参数里带着我们的脚本名**。
 *   这样两种正常情况都认得出来：① 現役的（参数＝现路径）② 搬家后变旧的（参数＝旧路径，仍是 start-board.cmd）
 *   —— 而指向别的东西的，一律**不认识、不动**。
 */
function looksOurs (e, actual) {
  if (!actual) return false
  const t = String(actual.target ?? '').toLowerCase()
  const a = String(actual.args ?? '')
  if (!t.endsWith('cmd.exe')) return false
  const marks = e.kind === 'url' ? [] : (e.id === '开始菜单-卸载' ? ['装外壳.mjs'] : ['start-board.cmd'])
  return marks.every((m) => a.includes(m))
}
/** 写一个 `.url`（没有 Chromium 时的降级入口）。 */
function makeUrl (path, url) {
  const body = `[InternetShortcut]\r\nURL=${url}\r\nIconFile=${BOARD_ICO}\r\nIconIndex=0\r\n`
  try { writeFileSync(path, body, 'utf8'); return { ok: true } } catch (e) { return { ok: false, err: String(e?.message ?? e) } }
}

/** 三个入口的"应该有"的样子（**一处定义**，建 / 体检 / 卸载都读它）。 */
function plan (foldersHere, browser) {
  const nodeExe = (() => { try { return process.execPath } catch { return 'node.exe' } })()
  const out = []
  // ① 桌面＋开始菜单：看板（独立窗口）
  const boardDesc = '无人值守 · 班组看板（独立窗口，不用开浏览器）'
  const entries = []
  if (foldersHere.desktop) entries.push({ id: '桌面-看板', path: join(foldersHere.desktop, NAME_BOARD + (browser ? '.lnk' : '.url')) })
  if (foldersHere.programs) entries.push({ id: '开始菜单-看板', path: join(foldersHere.programs, NAME_BOARD + (browser ? '.lnk' : '.url')) })
  for (const e of entries) {
    out.push(browser
      ? { ...e, kind: 'lnk', target: join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe'), args: `/c "${BOARD_CMD}"`, wd: PANEL_DIR, icon: BOARD_ICO + ',0', style: 7, desc: boardDesc }
      : { ...e, kind: 'url', url: PANEL_URL, desc: boardDesc })
  }
  // ② 开始菜单：卸载
  if (foldersHere.programs) {
    out.push({
      id: '开始菜单-卸载', kind: 'lnk', path: join(foldersHere.programs, NAME_UNINSTALL + '.lnk'),
      target: join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'cmd.exe'),
      args: `/c ""${nodeExe}" "${SELF}" --uninstall & echo. & pause"`,
      wd: HERE, icon: BOARD_ICO + ',0', style: 1, desc: '无人值守 · 卸载外壳（只删本工具建的快捷方式，不动工作台本身）'
    })
  }
  return out
}

/** 体检：每一项"在不在 / 指得对不对"。 */
function inspect (st, entries) {
  const rows = []
  for (const e of entries) {
    const built = st.建过?.[e.id]
    const exists = existsSync(e.path)
    let ok = exists, why = exists ? '' : '不在'
    let actual = null
    if (exists && e.kind === 'lnk') {
      actual = readLnk(e.path)
      if (!actual) { ok = false; why = '读不出（可能不是快捷方式）' }
      else if (e.id !== '开始菜单-卸载') {   // 卸载项的参数里带本机 node 绝对路径，不参与"指错了"比对
        const sameTarget = String(actual.target).toLowerCase() === String(e.target).toLowerCase()
        const sameArgs = String(actual.args) === String(e.args)
        const sameIcon = String(actual.icon ?? '').toLowerCase().startsWith(String(BOARD_ICO).toLowerCase())
        if (!sameTarget || !sameArgs || !sameIcon) { ok = false; why = '指向不对（目标/参数/图标与现在的工作台路径对不上）' }
      }
    }
    rows.push({ id: e.id, path: e.path, kind: e.kind, 应该有: !!built || st.用户选择 === '同意', 在: exists, ok, why, 实录: actual })
  }
  return rows
}

// ── 主流程 ───────────────────────────────────────────────────────────────────
const st = readState()
const fj = folders()
const browser = findBrowser()
const entries = plan(fj, browser)
const wantAction = has('check') ? 'check' : has('autostart') ? 'autostart' : has('install') ? 'install' : has('dismiss') ? 'dismiss' : has('uninstall') ? 'uninstall' : null
if (!wantAction) {
  console.error('用法：node 装外壳.mjs [--check|--autostart|--install|--dismiss|--uninstall] [--json]')
  process.exit(3)
}

const report = {
  action: wantAction, 状态文件: STATE_FILE,
  用户选择: st.用户选择, 已卸载: !!st.已卸载, 待问: !!st.待问, 补回次数: st.补回次数 ?? 0,
  桌面: fj.desktop, 开始菜单: fj.programs,
  浏览器: browser ? { 名字: browser.name, 路径: browser.exe } : null,
  降级: browser ? null : '没找到 Edge/Chrome ⇒ 桌面入口退化成 .url（能用，但**只能用浏览器打开**，没有独立窗口）',
  入口: [], 动作: [], 问题: []
}

// ── check：只体检 ────────────────────────────────────────────────────────────
if (wantAction === 'check') {
  const rows = inspect(st, entries)
  report.入口 = rows
  const 该有的 = rows.filter((r) => r.应该有)
  const 坏的 = 该有的.filter((r) => !r.ok)
  if (st.已卸载) report.问题.push('用户跑过 --uninstall ⇒ 永久不再建（这是**正常状态**，不是问题）')
  else if (st.用户选择 === '不用了') report.问题.push('用户选了「不用了」⇒ 不建（正常状态）')
  else if (st.用户选择 === null) report.问题.push('还没问过用户（首启问一句）⇒ 现在**还没建**，看板上会显示那条提示')
  else if (坏的.length) report.问题.push(`${坏的.length} 个入口该在却不在/指错了：` + 坏的.map((r) => r.id + '（' + r.why + '）').join('、'))
  else if (!rows.some((r) => r.ok)) report.问题.push('用户同意了，但一个入口都没建起来')
  const red = report.问题.filter((s) => !/正常状态/.test(s) && !/还没问过/.test(s)).length > 0
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2))
  else {
    console.log('=== 外壳体检 ===')
    console.log('  状态文件：' + STATE_FILE)
    console.log('  桌面：' + (fj.desktop ?? '❌ 取不到'))  ; console.log('  开始菜单：' + (fj.programs ?? '❌ 取不到'))
    console.log('  浏览器：' + (browser ? browser.name + '（' + browser.exe + '）' : '❌ 没找到 ⇒ 只能用 .url 降级'))
    console.log('  用户选择：' + (st.用户选择 ?? '（还没问）') + (st.已卸载 ? ' · 已卸载' : '') + ' · 补回 ' + (st.补回次数 ?? 0) + ' 次')
    for (const r of report.入口) console.log('  ' + (r.ok ? '✅' : '⚪') + ' ' + r.id + ' → ' + r.path + (r.why ? '  ⚠️ ' + r.why : ''))
    for (const s of report.问题) console.log('  · ' + s)
  }
  process.exit(red ? 2 : 0)
}

// ── dismiss：用户说不要 ──────────────────────────────────────────────────────
if (wantAction === 'dismiss') {
  st.用户选择 = '不用了'; st.待问 = false
  writeState(st)
  report.动作.push('已记下「不用了」——以后不再问、不再建')
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2)); else console.log('✅ ' + report.动作[0])
  process.exit(0)
}

// ── uninstall：只删我们建的，然后永不再建 ────────────────────────────────────
if (wantAction === 'uninstall') {
  const built = st.建过 ?? {}
  let n = 0, skipped = 0
  for (const [id, rec] of Object.entries(built)) {
    if (!rec?.path || !existsSync(rec.path)) continue
    // ⚠️ 删之前**核对**：这个文件现在还是不是我们建的那个（防止用户自己后来在同一个位置放了个同名快捷方式）
    const actual = rec.kind === 'lnk' ? readLnk(rec.path) : null
    const mine = rec.kind === 'url' ? true : (actual && String(actual.target).toLowerCase() === String(rec.target).toLowerCase())
    if (!mine) { skipped++; report.问题.push(`${id}：${rec.path} 现在**不是我们建的那个**（目标对不上）⇒ 没删`); continue }
    if (delFile(rec.path)) { n++; report.动作.push('已删 ' + id + ' → ' + rec.path) }
    else report.问题.push('删不掉：' + rec.path)
  }
  if (skipped === 0) { st.建过 = {}; st.已卸载 = true; st.用户选择 = '不用了'; st.待问 = false; writeState(st) }
  report.动作.push(st.已卸载
    ? '已记为「卸载过」—— **以后 DSH 启动不会再建**（想再要就跑一次 --install）'
    : `有 ${skipped} 个是**别人建的同名文件**（没删）⇒ 这次**不标记「卸载过」**（否则那个文件还在、我们却不管了）`)
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2))
  else { console.log('=== 卸载外壳 ==='); report.动作.forEach((s) => console.log('  ✅ ' + s)); report.问题.forEach((s) => console.log('  ⚠️ ' + s)) }
  process.exit(0)
}

// ── autostart：插件在 DSH 启动时调的这一档（**不问、不打扰**）─────────────────
if (wantAction === 'autostart') {
  if (st.已卸载) { report.动作.push('用户卸载过 ⇒ 0 动作'); }
  else if (st.用户选择 === '不用了') { report.动作.push('用户选了「不用了」⇒ 0 动作'); }
  else if (st.用户选择 === null) {
    st.待问 = true; writeState(st)
    report.动作.push('还没问过 ⇒ 只记「待问」，**一个快捷方式都不建**（提示条会出现在看板上）')
  } else {
    // 已同意 ⇒ 体检那些"建过"的：不在 / 指错了就补一次
    const rows = inspect(st, entries.filter((e) => st.建过?.[e.id]))
    const 坏 = rows.filter((r) => !r.ok)
    if (!坏.length) report.动作.push('入口都在、指向也对 ⇒ 0 动作')
    else {
      for (const r of 坏) {
        const e = entries.find((x) => x.id === r.id)
        // ★ 那里**已经有个不是我们建的文件** ⇒ 不认识就不动（绝不覆盖用户自己的东西）
        if (existsSync(e.path) && e.kind === 'lnk' && !looksOurs(e, readLnk(e.path))) {
          report.问题.push(`${r.id}：${e.path} 那里已有文件、**不是我们建的那个** ⇒ 没动它（要我们的入口请先把它挪走/删掉）`)
          continue
        }
        const made = e.kind === 'lnk' ? makeLnk(e) : makeUrl(e.path, e.url)
        if (made.ok) { st.建过[r.id] = { path: e.path, kind: e.kind, target: e.target, args: e.args, icon: e.icon, at: new Date().toISOString() }; report.动作.push('补回 ' + r.id + '（原因：' + r.why + '）') }
        else report.问题.push('补不回来 ' + r.id + '：' + (made.err ?? '?'))
      }
      if (report.动作.some((s) => s.startsWith('补回'))) { st.补回次数 = (st.补回次数 ?? 0) + 1; writeState(st); report.补回次数 = st.补回次数 }
    }
  }
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2))
  else { report.动作.forEach((s) => console.log('  · ' + s)); report.问题.forEach((s) => console.log('  ⚠️ ' + s)) }
  process.exit(report.问题.length ? 1 : 0)
}

// ── install：真建（用户在看板上点了「建立」）──────────────────────────────────
if (wantAction === 'install') {
  if (!fj.desktop && !fj.programs) {
    report.问题.push('❌ 桌面与开始菜单目录都取不到 ⇒ **一个都不建**（绝不瞎写到 Public\\Desktop）')
  } else {
    for (const e of entries) {
      // ★ 同一条闸：那里已有文件且**不像我们的** ⇒ 不动它（用户自己放的东西不许覆盖）
      if (existsSync(e.path) && e.kind === 'lnk' && !looksOurs(e, readLnk(e.path))) {
        report.问题.push(`${e.id}：${e.path} 那里已有文件、**不是我们建的那个** ⇒ 没动它`)
        continue
      }
      const made = e.kind === 'lnk' ? makeLnk(e) : makeUrl(e.path, e.url)
      if (made.ok) { st.建过[e.id] = { path: e.path, kind: e.kind, target: e.target, args: e.args, icon: e.icon, at: new Date().toISOString() }; report.动作.push('已建 ' + e.id + ' → ' + e.path) }
      else report.问题.push('建失败 ' + e.id + '：' + (made.err ?? '?') + '（杀软/COM 被拦时就是这条）')
    }
    if (report.动作.length) { st.用户选择 = '同意'; st.已卸载 = false; st.待问 = false; writeState(st) }
  }
  if (JSON_OUT) console.log(JSON.stringify(report, null, 2))
  else { console.log('=== 装外壳 ==='); report.动作.forEach((s) => console.log('  ✅ ' + s)); report.问题.forEach((s) => console.log('  ⚠️ ' + s)) }
  process.exit(report.问题.length ? 1 : 0)
}
