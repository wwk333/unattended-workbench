# Panel launcher (batch 1) -- "board panel / management page".
#
#   .\panel.ps1            start (if already running, only report status)
#   .\panel.ps1 -Stop      stop
#   .\panel.ps1 -Status    status only
#
# Standalone service, default http://127.0.0.1:19450/. Does NOT touch DSH and
# runs side by side with the old sidebar board.
#
# NOTE 1: ASCII-only on purpose -- Windows PowerShell 5.1 reads BOM-less UTF-8
#         as ANSI(GBK), so non-ASCII text in here would break the parser.
#         All Chinese text lives in service.mjs (node reads UTF-8 natively).
# NOTE 2: no output redirection -- the service writes its own panel.out.log.
#         (RedirectStandardOutput used to leave handles behind and hang the
#          calling shell.) Double-click start-panel.cmd / stop-panel.cmd.
param(
  [switch]$Stop,
  [switch]$Status,
  [int]$Port = 19450
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$service = Join-Path $here 'service.mjs'
$log = Join-Path $here 'panel.out.log'

function Get-PanelProc {
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*service.mjs*" }
}
function Test-PanelPort {
  $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
}

if ($Status) {
  $p = Get-PanelProc
  if ($p) { "RUNNING pid=$($p.ProcessId -join ',')  listening=$(Test-PanelPort)  url=http://127.0.0.1:$Port/" }
  else { "NOT RUNNING (listening=$(Test-PanelPort))" }
  return
}

if ($Stop) {
  $p = Get-PanelProc
  if (-not $p) { "Not running; nothing to stop."; return }
  foreach ($x in $p) {
    try { Stop-Process -Id $x.ProcessId -Force; "stopped pid=$($x.ProcessId)" }
    catch { "failed to stop pid=$($x.ProcessId): $($_.Exception.Message)" }
  }
  Start-Sleep -Milliseconds 600
  "listening=$(Test-PanelPort)"
  return
}

if (Get-PanelProc) { "Already running. Use -Status, or -Stop first."; & $MyInvocation.MyCommand.Path -Status; return }

# node: PATH first, then the runtime shipped with the desktop app
#       (<desktop>\resources\runtime\... = up 3 from here: _unattended -> workspace -> desktop)
$nodeExe = 'node.exe'
if (-not (Get-Command 'node.exe' -ErrorAction SilentlyContinue)) {
  $desktop = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $here))
  $cand = Join-Path $desktop 'resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  if (Test-Path $cand) { $nodeExe = $cand }
}

"starting: $nodeExe $service"
"log: $log"
Start-Process -FilePath $nodeExe -ArgumentList @($service) -WorkingDirectory $here -WindowStyle Hidden

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Milliseconds 300
  if (Test-PanelPort) { break }
}
if (Test-PanelPort) {
  "READY: http://127.0.0.1:$Port/"
  try { (Invoke-WebRequest "http://127.0.0.1:$Port/health" -UseBasicParsing -TimeoutSec 8).Content }
  catch { "(health check failed: $($_.Exception.Message))" }
} else {
  "Port $Port did not come up -- see log: $log"
}
