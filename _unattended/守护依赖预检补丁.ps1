<#
  守护依赖预检补丁 — 消除桌面端「启动区问题」误报（幂等）

  背景（2026-10-05 排查结论）
  ------------------------------------------------------------------
  dsh-my-guardian@0.4.4 的依赖预检只用 existsSync 探真实路径：
      插件内层 node_modules → profile node_modules → $DSH_HOME/profiles/node_modules
  而 DSH 桌面端并不把宿主包装进 profile：289 个 @deepseek-ai/*（cordis、
  dsh-credentials、dsh-tools …）全部打包在
      <安装目录>\resources\app.asar\dsh\node_modules
  并由 dsh-app-boot 的 profile 模块路由器（包装 Module._resolveFilename）在运行期
  路由给插件。asar 是文件，existsSync 看不见 → 凡声明宿主 peer 的插件都被判
  「缺少依赖」。示例：dsh-cost-meter 真的 import '@deepseek-ai/dsh-credentials'
  且加载成功（fiberPhase=active），却仍被报缺依赖。

  危害不止面板误报：mount.js:100 的挂载前预检一旦失败就按 failureType
  'dependency' 记失败 → 隔离 → 连续失败冻结。也就是说候选区里任何声明宿主 peer
  的插件都会被误伤，这正是守护的本职工作。

  另外 react / react-dom 由浏览器端 Web 外壳注入，宿主 node_modules 里根本没有，
  同类探针永远判缺 —— 按「客户端运行时依赖」降级为提示，不再阻塞。

  本补丁做三件事
  ------------------------------------------------------------------
  1. 新增 resolveViaLiveResolver()：先问进程内真实解析器（宿主进程里能命中
     app.asar 的打包副本），子进程无路由器时自动跳过。
  2. 新增 hostModuleRoots()/resolveInHostRoots()：从 process.resourcesPath 推出
        resources\app.asar\dsh\node_modules
        resources\app.asar.unpacked\dsh\node_modules
     直接探测（Electron 的 fs 已打补丁，asar 路径 existsSync/readFileSync 可用）。
  3. react/react-dom 归入 CLIENT_RUNTIME_PEERS，只出提示、不判缺失。

  幂等：文件里已有补丁标记即跳过；上游改了结构（锚点找不到）则拒绝写入并退出 2。
  升级 dsh-my-guardian 后重跑本脚本即可。

  用法
  ------------------------------------------------------------------
      pwsh -File _unattended\守护依赖预检补丁.ps1
      pwsh -File _unattended\守护依赖预检补丁.ps1 -Profile <profile目录>
      pwsh -File _unattended\守护依赖预检补丁.ps1 -Restore   # 从最新备份还原
#>
[CmdletBinding()]
param(
  [string]$Profile = $(if ($env:DSH_PROFILE_DIR) { $env:DSH_PROFILE_DIR } else { Join-Path $env:USERPROFILE '.dsh\profiles\desktop' }),
  [string]$BackupDir = (Join-Path (Split-Path -Parent $PSScriptRoot) '_unattended\backup'),
  [switch]$Restore
)

$ErrorActionPreference = 'Stop'
$MARKER = '[LOCAL PATCH'
$PKG_DIR = Join-Path $Profile 'node_modules\dsh-my-guardian'
$FILE = Join-Path $PKG_DIR 'lib\dep-precheck.js'

function Fail([string]$Message, [int]$Code) {
  Write-Host "[守护补丁] $Message" -ForegroundColor Red
  exit $Code
}
function Info([string]$Message) { Write-Host "[守护补丁] $Message" }
function Ok([string]$Message) { Write-Host "[守护补丁] $Message" -ForegroundColor Green }

if (-not (Test-Path -LiteralPath $PKG_DIR)) { Fail "未找到 dsh-my-guardian：$PKG_DIR" 1 }
if (-not (Test-Path -LiteralPath $FILE)) { Fail "未找到预检文件：$FILE" 1 }
if (-not (Test-Path -LiteralPath $BackupDir)) { New-Item -ItemType Directory -Path $BackupDir -Force | Out-Null }

# ---- 版本号（仅用于备份文件名） ------------------------------------------------
$version = 'unknown'
$pkgJson = Join-Path $PKG_DIR 'package.json'
if (Test-Path -LiteralPath $pkgJson) {
  try { $version = (Get-Content -LiteralPath $pkgJson -Raw | ConvertFrom-Json).version } catch { }
}

# ---- 还原 ----------------------------------------------------------------------
if ($Restore) {
  $latest = Get-ChildItem -LiteralPath $BackupDir -Filter 'dsh-my-guardian-*-dep-precheck.js.orig-*' -File |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $latest) { Fail "备份目录里没有 dep-precheck.js 备份：$BackupDir" 1 }
  Copy-Item -LiteralPath $latest.FullName -Destination $FILE -Force
  Ok "已还原：$($latest.Name)"
  Info "还原后仍需重启 DSH 才会重算启动预检。"
  exit 0
}

$text = [IO.File]::ReadAllText($FILE)
$nl = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }

# ---- 幂等：已打过就跳过 --------------------------------------------------------
if ($text.Contains($MARKER)) {
  Ok "已打过补丁（幂等跳过）。当前文件：$FILE"
  Info "如需重算面板，重启 DSH；如需还原，加 -Restore。"
  exit 0
}

# ---- 锚点（上游结构） ----------------------------------------------------------
$oldImports = @(
  "import { existsSync, readFileSync } from 'node:fs';",
  "import { join } from 'node:path';",
  "import { satisfies } from './dep-version.js';"
) -join $nl

$oldResolve = @(
  '// Resolve a dependency from the plugin''s nested node_modules, the profile',
  '// node_modules (hoisted installs), or the profiles-root node_modules where the',
  '// harness installs its host-provided @deepseek-ai/* packages. The pre-check',
  '// previously stopped at the profile dir, so every plugin declaring a host',
  '// package as a peer was reported as missing even though Node resolves it by',
  '// walking up to $DSH_HOME/profiles/node_modules. Returns the dir or null.',
  'function resolveDependencyDir(profileDir, pluginDir, dep) {',
  '    const base = basePackage(dep);',
  '    const nested = pluginDir === null ? null : findModuleDir(join(pluginDir, ''node_modules''), base);',
  '    if (nested !== null)',
  '        return nested;',
  '    const inProfile = findModuleDir(join(profileDir, ''node_modules''), base);',
  '    if (inProfile !== null)',
  '        return inProfile;',
  '    return findModuleDir(join(profileDir, ''..'', ''node_modules''), base);',
  '}'
) -join $nl

$oldExamine = @(
  'function examinePeer(dep, range, optional, pluginDir, profileDir) {',
  '    const depDir = resolveDependencyDir(profileDir, pluginDir, dep);'
) -join $nl

foreach ($pair in @(
    @{ Name = 'import 段'; Text = $oldImports },
    @{ Name = 'resolveDependencyDir'; Text = $oldResolve },
    @{ Name = 'examinePeer'; Text = $oldExamine })) {
  if (-not $text.Contains($pair.Text)) {
    Fail "锚点未命中（$($pair.Name)）——上游文件结构已变化，可能已修复或重构。未做任何修改。" 2
  }
}

# ---- 备份 + 断开 pnpm 硬链接 ---------------------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$backupPath = Join-Path $BackupDir "dsh-my-guardian-$version-dep-precheck.js.orig-$stamp"
Copy-Item -LiteralPath $FILE -Destination $backupPath -Force
Info "已备份：$backupPath"

# node_modules 里的文件常与 pnpm store 硬链接（nlink=2）。直接改写会连带改坏
# store 副本、导致后续 pnpm 完整性校验失败，因此换成新 inode 再改。
$swap = "$FILE.patchswap"
Copy-Item -LiteralPath $FILE -Destination $swap -Force
Remove-Item -LiteralPath $FILE -Force
Move-Item -LiteralPath $swap -Destination $FILE
$links = (fsutil hardlink list $FILE | Measure-Object).Count
Info "硬链接已断开（剩余路径数：$links）"

# ---- 三处替换 ------------------------------------------------------------------
$newImports = @(
  "import { existsSync, readFileSync } from 'node:fs';",
  "import { dirname, join } from 'node:path';",
  "import { createRequire } from 'node:module';",
  "import { satisfies } from './dep-version.js';"
) -join $nl

$newResolve = @(
  '// ---------------------------------------------------------------------------',
  '// [LOCAL PATCH — desktop host roots] The DSH desktop app does NOT install host',
  '// packages under $DSH_HOME/profiles/node_modules: every @deepseek-ai/* package',
  '// (cordis, dsh-credentials, dsh-tools, ...) ships inside',
  '// <install>/resources/app.asar/dsh/node_modules and is routed to profile',
  '// plugins by the app-boot profile module router (a Module._resolveFilename',
  '// wrapper), not by directory lookup. The plain path probes below can therefore',
  '// never see them, which made every desktop profile plugin declaring a host peer',
  '// show up as "缺少依赖" in the startup pre-check (false positive: the very same',
  '// imports load fine at runtime). Resolve the packaged roots instead — Electron''s',
  '// patched fs makes existsSync/readFileSync work on asar paths.',
  '// ---------------------------------------------------------------------------',
  'function hostModuleRoots() {',
  '    const roots = [];',
  '    const resources = process.resourcesPath;',
  '    if (typeof resources === ''string'' && resources !== '''') {',
  '        roots.push(join(resources, ''app.asar'', ''dsh'', ''node_modules''));',
  '        roots.push(join(resources, ''app.asar.unpacked'', ''dsh'', ''node_modules''));',
  '    }',
  '    return roots;',
  '}',
  '// Peers provided by the browser-side client runtime instead of by Node: a web',
  '// client plugin imports ''react'' bare and the web shell injects it. The package',
  '// is deliberately absent from the host''s node_modules, so a directory lookup',
  '// always reports it missing. Treat these as advisory, never as blocking.',
  'const CLIENT_RUNTIME_PEERS = new Set([''react'', ''react-dom'']);',
  'function isClientRuntimePeer(dep) {',
  '    return CLIENT_RUNTIME_PEERS.has(basePackage(dep));',
  '}',
  '// Ask the live resolver first: inside the harness process the app-boot profile',
  '// router maps a plugin''s bare host imports to the packaged copies, so this is',
  '// the most faithful answer available. A plain subprocess has no router and',
  '// simply falls through to the directory probes.',
  'function resolveViaLiveResolver(profileDir, pluginDir, base) {',
  '    const anchor = pluginDir !== null ? join(pluginDir, ''package.json'') : join(profileDir, ''package.json'');',
  '    try {',
  '        const liveRequire = createRequire(anchor);',
  '        const hit = liveRequire.resolve(base);',
  '        for (let dir = dirname(hit), i = 0; i < 16; i++) {',
  '            const manifest = readPackageJson(dir);',
  '            if (manifest !== null && manifest.name === base)',
  '                return dir;',
  '            const parent = dirname(dir);',
  '            if (parent === dir)',
  '                break;',
  '            dir = parent;',
  '        }',
  '    }',
  '    catch {',
  '        // Not resolvable from here (no profile router in this process).',
  '    }',
  '    return null;',
  '}',
  '// Probe the packaged host roots (asar included) for one package.',
  'function resolveInHostRoots(base) {',
  '    for (const root of hostModuleRoots()) {',
  '        const dir = findModuleDir(root, base);',
  '        if (dir !== null)',
  '            return dir;',
  '    }',
  '    return null;',
  '}',
  $oldResolve.Split($nl)[0],
  $oldResolve.Split($nl)[1],
  $oldResolve.Split($nl)[2],
  $oldResolve.Split($nl)[3],
  $oldResolve.Split($nl)[4],
  $oldResolve.Split($nl)[5],
  'function resolveDependencyDir(profileDir, pluginDir, dep) {',
  '    const base = basePackage(dep);',
  '    const viaResolver = resolveViaLiveResolver(profileDir, pluginDir, base);',
  '    if (viaResolver !== null)',
  '        return viaResolver;',
  '    const nested = pluginDir === null ? null : findModuleDir(join(pluginDir, ''node_modules''), base);',
  '    if (nested !== null)',
  '        return nested;',
  '    const inProfile = findModuleDir(join(profileDir, ''node_modules''), base);',
  '    if (inProfile !== null)',
  '        return inProfile;',
  '    const inHostRoot = resolveInHostRoots(base);',
  '    if (inHostRoot !== null)',
  '        return inHostRoot;',
  '    return findModuleDir(join(profileDir, ''..'', ''node_modules''), base);',
  '}'
) -join $nl

$newExamine = @(
  'function examinePeer(dep, range, optional, pluginDir, profileDir) {',
  '    // Client-runtime peers are injected by the web shell in the browser and are',
  '    // never present in the host''s node_modules: advisory only, never blocking.',
  '    if (isClientRuntimePeer(dep))',
  '        return { kind: ''warn'', message: `客户端运行时依赖 ${dep}（由 Web 外壳注入，无需安装）` };',
  '    const depDir = resolveDependencyDir(profileDir, pluginDir, dep);'
) -join $nl

$new = $text.Replace($oldImports, $newImports).Replace($oldResolve, $newResolve).Replace($oldExamine, $newExamine)

if ($new -eq $text) { Fail '三处替换均未生效（内容未变化）。未写入。' 3 }

[IO.File]::WriteAllText($FILE, $new, (New-Object Text.UTF8Encoding($false)))

# ---- 自检 ----------------------------------------------------------------------
$verify = [IO.File]::ReadAllText($FILE)
if (-not $verify.Contains($MARKER)) { Fail '写入后未看到补丁标记，请用 -Restore 还原。' 4 }
if (-not $verify.Contains('hostModuleRoots') -or -not $verify.Contains('CLIENT_RUNTIME_PEERS')) {
  Fail '写入后缺少关键符号，请用 -Restore 还原。' 4
}

Ok "补丁完成：$FILE"
Info "重启 DSH 后守护会重算启动预检，面板「启动区问题」应归零。"
Info "卸载/回退：pwsh -File 守护依赖预检补丁.ps1 -Restore"
