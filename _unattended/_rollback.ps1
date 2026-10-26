# 回滚：把 desktop profile 从存档还原（不需要 DSH 能启动）
#
# 为什么有这个脚本：`回滚.cmd` 原来指向一个**不存在的** `_rollback.ps1` —— 点下去必然失败，
# 而它长得却像一个"救命按钮"（一个按不动的按钮比没有更坏）。
# 现在把它补成真的：**纯文件复制**，不依赖 dsh、不依赖网络、不依赖插件 ——
# 因为要用它的时刻，往往是"DSH 已经起不来了"。
#
# ⚠️⚠️ 2026-10-06 事故（用户实测 + 我复盘）：这个脚本第一版**默认执行**，
#   而"最新存档"未必比现在新 —— 我在 21:45 拿它做一次"按钮实测"，
#   就把用户 21:45:15 刚改好的 `cordis.patch.yml`（里面多了一整套 xiaomi 模型商配置）
#   覆盖回了 10-03 的旧存档，用户那边表现为"**我的 xiaomi 模型被删了**"。
#   ⇒ 三条新护栏（别再拆掉）：
#     ① **默认不执行**：不带 `-Apply` 只做干跑（列出会覆盖什么、会不会丢新内容），
#        真还原必须显式 `-Apply`；`回滚.cmd` 双击默认就是"只看不动"。
#     ② **丢新内容就拦**：目标文件的修改时间**比该存档新**，或存档里找不到目标里有的关键词，
#        一律标 ⚠️ 并在没有 `-Force` 时**拒绝执行**。
#     ③ **整份回退永远允许**，但那必须是"人明确要回退"，不该是"某次实测顺手跑出来的"。
#
# 用法：
#   powershell -File _rollback.ps1                     # 干跑：只看会还原什么（安全）
#   powershell -File _rollback.ps1 -Apply              # 真还原（会提示"丢新内容"的风险）
#   powershell -File _rollback.ps1 -Apply -Force       # 明知道会丢新内容也要还原
#   powershell -File _rollback.ps1 -From 20261005      # 只用名字含这段的存档

param(
  [switch]$DryRun,
  [switch]$Apply,
  [switch]$Force,
  [string]$From = ''
)

$ErrorActionPreference = 'Stop'

# 映射表（存档文件名前缀 → 还原到哪）。改这里就等于改还原规则，**只有这一处**。
$MAP = @(
  @{ prefix = 'cordis.patch.yml';                     dest = "$env:USERPROFILE\.dsh\profiles\desktop\cordis.patch.yml" },
  @{ prefix = 'desktop-package.json';                 dest = "$env:USERPROFILE\.dsh\profiles\desktop\package.json" },
  @{ prefix = 'dsh-my-guardian-0.4.4-dep-precheck.js'; dest = "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-my-guardian\lib\dep-precheck.js" }
)

function Say($msg) { Write-Host $msg }

$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$backupDir = Join-Path $here 'backup'

if (-not (Test-Path $backupDir)) { Say "[rollback] 找不到存档目录：$backupDir"; exit 2 }

# 收集候选：只认"某个映射前缀 + .before-*"命名的文件（那就是配置存档的命名法）
$cands = @()
foreach ($m in $MAP) {
  Get-ChildItem $backupDir -File -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -like ($m.prefix + '.before-*') } |
    ForEach-Object { $cands += [pscustomobject]@{ file = $_; prefix = $m.prefix; dest = $m.dest } }
}
if ($From) { $cands = @($cands | Where-Object { $_.file.Name -like ('*' + $From + '*') }) }

if (-not $cands -or $cands.Count -eq 0) {
  Say "[rollback] 没有可还原的存档（$backupDir 里没有 *.before-* 文件，或 -From 没匹配到）"
  exit 3
}

Say "[rollback] 存档目录：$backupDir"
Say "[rollback] 找到 $($cands.Count) 份可还原的存档："
$risky = @()
foreach ($c in $cands) {
  $curLen = -1; $curTime = $null
  if (Test-Path $c.dest) { $it = Get-Item $c.dest; $curLen = $it.Length; $curTime = $it.LastWriteTime }
  $mark = if ($curLen -lt 0) { '目标不存在（会新建）' } else { "当前 $curLen 字节 / $($curTime.ToString('MM-dd HH:mm'))" }
  $c | Add-Member -NotePropertyName curTime -NotePropertyValue $curTime -Force
  # ⚠️ 护栏②：目标比存档**新** → 还原等于把新改动丢掉（这正是 2026-10-06 那次事故的形态）
  $newer = ($curTime -ne $null) -and ($curTime -gt $c.file.LastWriteTime)
  if ($newer) { $risky += $c; $mark += '   ⚠️ 目标比存档新 → 还原会丢掉新改动' }
  Say ("   · {0}  ->  {1}   （{2}）" -f $c.file.Name, $c.dest, $mark)
}

if (-not $Apply) {
  Say ""
  Say "[rollback] 这是**干跑**（默认行为）：什么都没改。"
  if ($risky.Count -gt 0) { Say "[rollback] ⚠️ 其中 $($risky.Count) 份会**丢掉比它更新的改动** —— 确认要回退再加 -Apply（必要时再加 -Force）。" }
  else { Say "[rollback] 要真还原：加 -Apply。" }
  exit 0
}
if ($risky.Count -gt 0 -and -not $Force) {
  Say ""
  Say "[rollback] ⛔ 拒绝执行：上面带 ⚠️ 的那些**会把比存档更新的改动覆盖掉**（2026-10-06 就是这么把用户的 xiaomi 配置弄丢的）。"
  Say "[rollback]    确实要回退就加 -Force；只想挑某一份就加 -From <名字片段>。"
  exit 4
}

# 还原前先把"现在的样子"再留一份（连点两次也不会把备份毁掉）
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$n = 0
foreach ($c in $cands) {
  try {
    if (Test-Path $c.dest) {
      $safety = "$($c.dest).pre-rollback-$stamp"
      Copy-Item $c.dest $safety -Force
      Say "[rollback] 先留一份现状：$safety"
    } else {
      $dir = Split-Path -Parent $c.dest
      if (-not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    }
    Copy-Item $c.file.FullName $c.dest -Force
    Say "[rollback] OK 已还原：$($c.file.Name) -> $($c.dest)"
    $n++
  } catch {
    Say "[rollback] FAIL 还原失败：$($c.file.Name) —— $($_.Exception.Message)"
  }
}

Say ""
Say "[rollback] 完成：还原 $n 份。**接下来要重启一次 DSH**（profile 是启动时读的）。"
Say "[rollback] 想撤销这次回滚：拿上面那份 `.pre-rollback-$stamp` 复制回去即可。"
if ($n -eq 0) { exit 1 }
exit 0
