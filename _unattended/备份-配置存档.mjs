#!/usr/bin/env node
/**
 * 配置存档（archiver）— 无人值守模式 第 0 步 0.1 的产出物之一。
 *
 * 用途：在动 desktop profile 之前，留下"改之前长什么样"的铁证。
 *
 * 为什么不是简单跑一句 `dsh --profile desktop --dump-config`：
 *   桌面端（Electron）独占管理 `desktop` 这个 profile，官方 CLI 对它一律硬拦：
 *     error: profile "desktop" is managed exclusively by the Electron application
 *   （证据：<dsh 安装目录>/node_modules/@deepseek-ai/dsh/lib/bin.js 第 29 行）
 *   所以本脚本改用「0.2.0 发运的 web profile 作为基线」+「--patch 叠加 desktop 的
 *   cordis.patch.yml」来得到等价的存档；这同时顺带找回了方案 §15.1 防线 5 的
 *   "改前预检"能力（改完 patch 后重跑本脚本，它会在 stderr 里报 entry not found 之类硬错）。
 *
 * 关键：必须用【桌面端自带】的 CLI（版本与在跑的桌面端一致），不要用工作台老 CLI。
 *
 * 用法：
 *   & '<DSH根>\resources\runtime\cli\bin\dsh.cmd' `
 *       '<工作台根>\_unattended\备份-配置存档.mjs' [标签]
 *
 * 产出（全部落在 _unattended\backup\config-archive-<时间戳>[-标签]\）：
 *   00-说明.md           本次存档的说明与命令原文
 *   01-profile-files.txt desktop profile 各文件的 SHA256 / 大小 / mtime
 *   02-dump-baseline.yml 0.2.0 发运 web profile 的合成树（基线）
 *   03-dump-with-desktop-patch.yml  基线 + desktop patch 层（= desktop 的等价存档）
 *   04-dump.stderr.txt   上面两条命令的 stderr（预检信息在这里）
 *   05-cli-info.txt      CLI 版本 / DSH_HOME / 主机 / 时间
 */

import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CLI_CMD, CLI_JS as CLI_JS_P, DSH_EXE as DSH_EXE_P, NODE_BIN, need } from './_路径.mjs'

// ---------------------------------------------------------------- 常量与路径

const HERE = dirname(fileURLToPath(import.meta.url))          // …\_unattended
const WORKSPACE = resolve(HERE, '..')                          // 体系根（`<根>\_unattended\..` = `<根>`）

const DSH_HOME = process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '', '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', 'desktop')
const PATCH_FILE = join(PROFILE_DIR, 'cordis.patch.yml')

const CLI = process.env.DSH_CLI ?? need('DSH 自带的 dsh.cmd', CLI_CMD)
/**
 * 怎么调 CLI —— 三条路，按可靠性优先自动选：
 *
 *   A. electron  ：`DeepSeek Harness.exe` + `ELECTRON_RUN_AS_NODE=1` + app.asar 里的 cli.js
 *                  —— **默认走这条**。注意：args 里只有 ASCII，中文路径（脚本自身）
 *                     是"谁来跑我"的问题，不经过这里，所以没有编码风险。
 *   B. cmd-exe   ：`cmd.exe /d /s /c` 调 dsh.cmd —— **实测会把中文路径传成乱码**（本机实测失败），
 *                  只在 A 不可用时保留为兜底，且不要给它带中文的参数。
 *   C. cmd-shell ：直接 spawn .cmd 且 shell:true —— 最后的兜底（Node 24 会发 DEP0190 告警）。
 *
 * 关键事实（实测）：普通 node **看不见 app.asar 内部**（existsSync=false / ENOENT），
 * 所以 A 路必须用 Electron 二进制，不能用它旁边的 node.exe。
 */
const ELECTRON_EXE = process.env.DSH_ELECTRON_EXE ?? need('DSH 主程序', DSH_EXE_P)
const CLI_JS = process.env.DSH_CLI_JS ??
  need('DSH headless 入口', CLI_JS_P)
const CMD_EXE = process.env.DSH_CMD_EXE ?? 'C:\\Windows\\System32\\cmd.exe'

/**
 * 走法选择：环境变量 `DSH_CLI_VIA=electron|cmd-exe|cmd-shell` 可强制；
 * 默认 electron（Electron exe 是普通文件，existsSync 可靠）。
 */
const FORCED_VIA = process.env.DSH_CLI_VIA ?? ''
const via = FORCED_VIA !== '' ? FORCED_VIA : 'electron'
const usesHostCli = via === 'electron'
const BASELINE_PROFILE = process.env.DSH_BASELINE_PROFILE ?? 'web'

const LABEL = (process.argv[2] ?? '').replace(/[^\w\u4e00-\u9fa5.-]+/g, '_')
const STAMP = timestamp()
const OUT = join(HERE, 'backup', `config-archive-${STAMP}${LABEL ? '-' + LABEL : ''}`)

/** 存档里忽略的冗长噪声行（都无害，留个记录免得下次又困惑）。 */
const NOISE = [
  /^dsh\.cmd : /,                     // PowerShell 把 stderr 包了一层
  /^所在位置 行/, /^\+ /, /^$/,       // 上面那层的续行
  /CategoryInfo|FullyQualifiedErrorId/,
  /^NativeCommandError/
]

// ---------------------------------------------------------------- 小工具

function timestamp () {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

function sha256 (file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function cleanStderr (text) {
  return text
    .split(/\r?\n/)
    .filter((line) => !NOISE.some((re) => re.test(line.trim())))
    .join('\n')
    .trim()
}

/**
 * 写文本档案：**必须带 UTF-8 BOM**。
 * 本脚本实测踩过：无 BOM 的 UTF-8 中文，在 PowerShell 5.1 / 记事本按 GBK 解读时全是乱码，
 * 而"改之前长什么样"这份铁证恰恰是给人看的 —— 乱码就等于没存。
 */
function writeUtf8 (file, text) {
  writeFileSync(file, '\uFEFF' + text, 'utf8')
}

/** 按 cmd.exe 的规矩给一个参数加引号（内部的双引号用 \" 表示）。 */
function cmdQuote (a) {
  return /[\s"]/.test(a) ? '"' + a.replace(/"/g, '\\"') + '"' : a
}

/** 给走法加一句人话注解。 */
function viaNote () {
  if (via === 'electron') return '（A：DeepSeek Harness.exe + ELECTRON_RUN_AS_NODE=1 + host cli.js —— 默认，最可靠）'
  if (via === 'cmd-exe') return '（B：cmd.exe /d /s /c 调 dsh.cmd —— 实测会把中文路径传成乱码，仅兜底）'
  return '（C：直接 spawn .cmd 且 shell:true —— 兜底，Node 24 会发 DEP0190 告警）'
}

/** 统一跑一次 CLI（不落文件），返回 { r, command, via }。 */
function runCli (args) {
  let exe; let spawnArgs; let env; let shell
  if (via === 'electron') {
    exe = ELECTRON_EXE
    spawnArgs = ['--expose-internals', CLI_JS, ...args]
    env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    shell = false
  } else if (via === 'cmd-exe') {
    exe = CMD_EXE
    spawnArgs = ['/d', '/s', '/c', '""' + CLI + '" ' + args.map(cmdQuote).join(' ') + '"']
    env = process.env
    shell = false
  } else {
    exe = CLI
    spawnArgs = args
    env = process.env
    shell = true
  }
  const r = spawnSync(exe, spawnArgs, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    shell,
    windowsHide: true,
    env
  })
  const shown = via === 'cmd-exe'
    ? `${CMD_EXE} ${spawnArgs.map(quote).join(' ')}`
    : [exe, ...spawnArgs].map(quote).join(' ')
  return { r, command: shown, via }
}

function quote (a) {
  return /\s/.test(a) ? JSON.stringify(a) : a
}

/** 跑一次 dump 并把 stdout 写到文件；返回 { code, command, stderr, bytes, lines }。 */
function runDump (outFile, extraArgs) {
  const { r, command, via } = runCli(['--profile', BASELINE_PROFILE, '--dump-config', ...extraArgs])
  const stdout = r.stdout ?? ''
  writeFileSync(outFile, stdout, 'utf8')
  const stderrParts = [cleanStderr(r.stderr ?? '')]
  if (r.error) stderrParts.push(`[spawn error] ${r.error.code ?? ''} ${r.error.message}`)
  if (r.status === null && !r.error) stderrParts.push('[spawn error] status=null（进程未正常启动/被信号终止）')
  return {
    code: r.status,
    command,
    via,
    stderr: stderrParts.filter(Boolean).join('\n').trim(),
    bytes: Buffer.byteLength(stdout),
    lines: stdout === '' ? 0 : stdout.split(/\r?\n/).length
  }
}

// ---------------------------------------------------------------- 主流程

if (!existsSync(PROFILE_DIR)) fail(`找不到 desktop profile 目录：${PROFILE_DIR}`)
if (!existsSync(PATCH_FILE)) fail(`找不到 patch 文件：${PATCH_FILE}`)
if (!existsSync(CLI)) fail(`找不到 CLI：${CLI}`)

mkdirSync(OUT, { recursive: true })

// 1) profile 文件清单 + 哈希
const files = readdirSync(PROFILE_DIR).sort()
const fileLines = [
  `# desktop profile 文件清单`,
  `# 目录 : ${PROFILE_DIR}`,
  `# 时间 : ${new Date().toISOString()}`,
  ``,
  ...files.map((name) => {
    const full = join(PROFILE_DIR, name)
    const st = statSync(full)
    if (st.isDirectory()) return `${'<DIR>'.padEnd(64)}  ${name}`
    return `${sha256(full)}  ${String(st.size).padStart(8)} B  ${st.mtime.toISOString()}  ${name}`
  })
]
writeUtf8(join(OUT, '01-profile-files.txt'), fileLines.join('\n') + '\n')

// 2) 基线 + 叠加 desktop patch 的存档
const base = runDump(join(OUT, '02-dump-baseline.yml'), [])
const withPatch = runDump(join(OUT, '03-dump-with-desktop-patch.yml'), ['--patch', PATCH_FILE])

// 3) 预检信息（stderr）
const stderrText = [
  `# ---- [1] ${BASELINE_PROFILE} 基线 ----`,
  `# 走法   : ${base.via}`,
  `# 命令   : ${base.command}`,
  `# exit   : ${base.code}`,
  `# 输出   : ${base.lines} 行 / ${base.bytes} 字节`,
  base.stderr === '' ? '(stderr 为空)' : base.stderr,
  ``,
  `# ---- [2] 基线 + desktop patch（等价存档 + 改前预检）----`,
  `# 走法   : ${withPatch.via}`,
  `# 命令   : ${withPatch.command}`,
  `# exit   : ${withPatch.code}`,
  `# 输出   : ${withPatch.lines} 行 / ${withPatch.bytes} 字节`,
  withPatch.stderr === '' ? '(stderr 为空)' : withPatch.stderr,
  ``
].join('\n')
writeUtf8(join(OUT, '04-dump.stderr.txt'), stderrText)

// 4) CLI 与主机信息
const ver = runCli(['--version'])
writeUtf8(join(OUT, '05-cli-info.txt'), [
  `cli        = ${CLI}`,
  `cli 走法   = ${ver.via}${viaNote()}`,
  `Electron   = ${usesHostCli ? ELECTRON_EXE : '(未使用)'}`,
  `cli 入口   = ${usesHostCli ? CLI_JS : '(未使用)'}`,
  `强制走法   = ${FORCED_VIA === '' ? '(未设置，自动探测)' : FORCED_VIA}`,
  `探测说明   = asar 外部（Electron exe）用 existsSync 可靠；asar 内部（cli.js）不可见，故不靠探测、`,
  `             直接按走法 A 组装命令。可设 DSH_CLI_VIA=electron|cmd-exe|cmd-shell 强制。`,
  `cli version= ${(ver.r.stdout ?? '').trim()}   (exit ${ver.r.status})`,
  `命令原文   = ${ver.command}`,
  `DSH_HOME   = ${DSH_HOME}`,
  `baseline   = profile "${BASELINE_PROFILE}"（0.2.0 发运件，用来代替被封的 desktop dump）`,
  `patch 文件 = ${PATCH_FILE}`,
  `patch sha256 = ${sha256(PATCH_FILE)}`,
  `host       = ${hostname()}`,
  `node       = ${process.version}`,
  `归档时间   = ${new Date().toISOString()}`,
  `归档目录   = ${OUT}`,
  ``
].join('\n'))

// 5) 说明
writeUtf8(join(OUT, '00-说明.md'), [
  `# 配置存档 ${STAMP}${LABEL ? ' · ' + LABEL : ''}`,
  ``,
  `这就是"改之前长什么样"的铁证。**只读产出，不改任何配置。**`,
  ``,
  `| 文件 | 内容 |`,
  `|---|---|`,
  `| \`01-profile-files.txt\` | desktop profile 每个文件的大小 / mtime / **SHA256** |`,
  `| \`02-dump-baseline.yml\` | ${BASELINE_PROFILE} profile 的合成树（0.2.0 真实合成结果，基线） |`,
  `| \`03-dump-with-desktop-patch.yml\` | 基线 **+ desktop 的 \`cordis.patch.yml\`**（= desktop 的等价存档） |`,
  `| \`04-dump.stderr.txt\` | 上面两条命令的 **exit code 与 stderr**（patch 预检的硬错就在这里） |`,
  `| \`05-cli-info.txt\` | CLI 版本 / DSH_HOME / patch 文件哈希 / 主机 / 时间 |`,
  ``,
  `## 为什么不用 \`--profile desktop --dump-config\``,
  ``,
  '桌面端（Electron）独占管理 `desktop` 这个 profile，官方 CLI 一律硬拦：',
  ``,
  '```text',
  'error: profile "desktop" is managed exclusively by the Electron application',
  '```',
  ``,
  `证据：\`<dsh 安装目录>\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js\` 第 29 行。`,
  ``,
  `## 怎么用（改前预检）`,
  ``,
  '改完 desktop 的 `cordis.patch.yml` 之后、**真启动之前**，重跑一次本脚本；',
  '若 `04-dump.stderr.txt` 里出现 `patch: entry "xxx" not found` 之类，说明 patch 里的目标 id 写错了 —— 这是硬错，必须修掉再启动。',
  ``,
  `## 重跑命令`,
  ``,
  '```powershell',
  `$env:DSH_HOME='${DSH_HOME}'`,
  `& '${NODE_BIN ?? '(未配置专用 node)'}' '${join(HERE, '备份-配置存档.mjs')}' 改前`,
  '```',
  ``,
  `> 跑脚本用**桌面端自带的 node**（\`…\\primary-runtime\\dependencies\\node\\bin\\node.exe\`，v24.21.0）；`,
  `> 调 dsh 则走 \`dsh.cmd\`（本轮实际走法：**${via}**）。`,
  ``,
  `> 四个坑（都实测踩过，别再踩）：`,
  `> 1. **别把 \`.cmd\` 直接交给 Node 24 的 spawn**（必须带 shell，否则 EINVAL / status=null）；`,
  `> 2. **别指望旁边的 \`node.exe\` 能跑 CLI 入口** —— 入口在 \`app.asar\` 里，`,
  `>    普通 node **看不见 asar 内部**（实测 \`existsSync=false\` / ENOENT），必须由 Electron 二进制来跑；`,
  `> 3. **别用 \`dsh.cmd\` 跑你自己的脚本** —— 它只认 dsh 自己的子命令（会报 \`invalid profile name\`）；`,
  `> 4. **中文文本档案必须带 UTF-8 BOM** —— 否则 PowerShell 5.1 按 GBK 解读，全是乱码。`,
  ``
].join('\n'))

// ---------------------------------------------------------------- 结果播报

const ok = base.code === 0 && withPatch.code === 0
console.log(`[存档] 目录        : ${OUT}`)
console.log(`[存档] 基线 dump   : exit=${base.code}  ${base.lines} 行 / ${base.bytes} 字节`)
console.log(`[存档] +patch dump : exit=${withPatch.code}  ${withPatch.lines} 行 / ${withPatch.bytes} 字节`)
console.log(`[存档] patch 哈希  : ${sha256(PATCH_FILE)}`)
if (base.stderr) console.log(`[预检] 基线 stderr : ${base.stderr}`)
if (withPatch.stderr) console.log(`[预检] patch stderr: ${withPatch.stderr}`)
console.log(`[存档] 结论        : ${ok ? '✅ 两条 dump 均 exit 0' : '❌ 有非 0 退出，见 04-dump.stderr.txt'}`)
process.exitCode = ok ? 0 : 1

function fail (message) {
  console.error(`[存档] 失败: ${message}`)
  process.exit(1)
}
