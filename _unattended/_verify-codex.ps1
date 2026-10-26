# 复验 Codex 载体（在【普通终端】里跑：双击 _verify-codex.cmd，或用 README 里那行命令）
#
# 为什么要普通终端：Codex 0.155 的 `exec` 默认要连本机一个 app-server 守护进程，
#   那套 IPC 在 DSH 的沙箱会话里初始化失败（failed to initialize in-process app-server client: 拒绝访问）。
#   属"边界问题"，不是配置错。
#
# ★ 2026-10-03 修：原来用 `& exe ... 1> f 2> f`，而 Codex 会往 stderr 打 WARNING
#   （"could not create PATH aliases: 拒绝访问"）—— PowerShell 5.1 在
#   $ErrorActionPreference='Stop' 下**把原生程序的 stderr 当成终止性错误**，脚本当场就死了。
#   现在改用 Start-Process 显式重定向：PowerShell 完全不碰 stderr，只取退出码。
#   （Prompt 里含空格 → PS 5.1 的 -ArgumentList 不会自动加引号，所以这里手工包一层双引号。）

$ErrorActionPreference = 'Continue'   # ⚠️ 不能用 Stop：原生程序的 stderr 会把它变成终止错误

$workbench = Split-Path $PSScriptRoot -Parent                     # ...\无人值守\_unattended → ...\无人值守
$dshRoot   = Split-Path $workbench -Parent                        # ...\dsh桌面端
$agents    = Join-Path $dshRoot 'agents'
$codex     = Join-Path $agents 'node_modules\@openai\codex\bin\codex.js'
$node      = Join-Path $dshRoot 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
$cfgHome   = Join-Path $agents 'config\codex'
$wd        = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\_probe\codex-verify'))
$cred      = Join-Path $env:USERPROFILE '.dsh\.credentials.yaml'

Write-Host '===== Codex 载体复验 =====' -ForegroundColor Cyan
Write-Host ("codex 入口 : " + $codex)
Write-Host ("node       : " + $node)
Write-Host ("CODEX_HOME : " + $cfgHome)
Write-Host ("工作目录   : " + $wd)
Write-Host ''

foreach ($chk in @($codex, $cfgHome, $node, $cred)) {
  if (-not (Test-Path $chk)) { Write-Host ("❌ 找不到：" + $chk) -ForegroundColor Red; exit 1 }
}

# ── 读 key（现读、不打印） ────────────────────────────────────────────────
$yaml = Get-Content $cred -Raw -Encoding UTF8
$m = [regex]::Match($yaml, '(?m)^\s*ARK_API_KEY\s*:\s*["'']?([^"''\r\n]+)')
if (-not $m.Success) { Write-Host "❌ 凭据库里没有 ARK_API_KEY" -ForegroundColor Red; exit 1 }
$env:ARK_API_KEY = $m.Groups[1].Value.Trim()
$env:CODEX_HOME  = $cfgHome
Write-Host ("ARK_API_KEY : 已注入（长度 " + $env:ARK_API_KEY.Length + "，未打印）")
Write-Host ''

New-Item -ItemType Directory -Path $wd -Force | Out-Null

$models = @('kimi-k3', 'glm-5.3')      # ① 优先 ② 备选
$passed = $null

foreach ($model in $models) {
  Write-Host ("========== 试模型：" + $model + " ==========") -ForegroundColor Yellow
  Remove-Item (Join-Path $wd '*') -Force -ErrorAction SilentlyContinue
  $outFile = Join-Path $wd 'out.txt'
  $errFile = Join-Path $wd 'err.txt'

  $prompt  = '在当前工作目录创建一个文件 probe.txt，内容写一行：codex-OK。做完只回复两个字：DONE'
  $argList = @(
    $codex, 'exec', '--skip-git-repo-check',
    '-C', $wd,
    '-s', 'workspace-write',
    '-m', $model,
    ('"' + $prompt + '"')          # ← 含空格，PS 5.1 不会自动加引号，手工包
  )

  # ★ 两个防线（2026-10-03 加：实测它会卡住不动）：
  #   ① 空 stdin —— Codex 会打印 "Reading additional input from stdin..." 然后**等输入**；
  #      给它一个空文件，立刻 EOF，它就不用等了。
  #   ② 自己轮询超时 —— Start-Process -Wait 没有超时，卡住就无限等；超时杀掉并说清结论。
  $emptyIn = Join-Path $wd 'stdin.empty'
  Set-Content -Path $emptyIn -Value '' -Encoding ASCII
  $timeoutSec = 180

  Write-Host ("（正在跑，最多等 " + $timeoutSec + " 秒；卡住会自动收场）")
  $sw = [Diagnostics.Stopwatch]::StartNew()
  $proc = Start-Process -FilePath $node -ArgumentList $argList -NoNewWindow -PassThru `
            -WorkingDirectory $wd -RedirectStandardOutput $outFile -RedirectStandardError $errFile `
            -RedirectStandardInput $emptyIn
  $timedOut = $false
  if ($proc.WaitForExit($timeoutSec * 1000)) {
    [void]$proc.WaitForExit()      # ★ PS 5.1 的坑：带超时的 WaitForExit 之后 ExitCode 是空的；
                                   #   必须再调一次**无参** WaitForExit() 才会填上（实测：不带=空，带了=9/11/13）
  } else {
    $timedOut = $true
    Write-Host ("⏱ 超过 " + $timeoutSec + "s 未结束 → 杀掉（多半是在等 stdin，或网关侧卡住）") -ForegroundColor Red
    try { $proc.Kill() } catch {}
    Start-Sleep -Seconds 2
  }
  $sw.Stop()

  $exitShown = if ($timedOut) { 'timeout' } else { $proc.ExitCode }
  Write-Host ("exit=" + $exitShown + "  耗时=" + [math]::Round($sw.Elapsed.TotalSeconds,1) + "s")
  $probe = Join-Path $wd 'probe.txt'
  if (Test-Path $probe) {
    Write-Host ("✅ 通过：probe.txt 真的生成了，内容 = " + (Get-Content $probe -Raw -Encoding UTF8).Trim()) -ForegroundColor Green
    $passed = $model
    break
  }
  Write-Host '❌ 未通过：probe.txt 没生成' -ForegroundColor Red
  Write-Host '--- stdout（末 12 行） ---'
  Get-Content $outFile -Tail 12 -ErrorAction SilentlyContinue
  Write-Host '--- stderr（末 12 行） ---'
  Get-Content $errFile -Tail 12 -ErrorAction SilentlyContinue
  Write-Host ''
}

Write-Host ''
if ($passed) {
  Write-Host ("===== 结论：Codex 可用，模型用「" + $passed + "」 =====") -ForegroundColor Green
  Write-Host '把这一行告诉我：不一致我就改 agents.json 里 reviewer 的优先模型。'
} else {
  Write-Host '===== 结论：Codex 在你终端里也不通 → 审核员改走「换载体不换脑子」：' -ForegroundColor Red
  Write-Host '      opencode + --agent reviewer-ro（只读）+ ark/kimi-k3' -ForegroundColor Red
  Write-Host '把上面两段 stdout/stderr 贴给我，我据此改配置。'
}
Write-Host ''
Write-Host ("现场留档：" + $wd)
