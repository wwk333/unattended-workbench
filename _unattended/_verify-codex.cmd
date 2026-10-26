@echo off
rem ============================================================
rem  Codex carrier verification launcher.
rem  Why a .cmd: the execution policy blocks .ps1 in a normal
rem  console ("running scripts is disabled on this system").
rem  A .cmd is not subject to the execution policy, and it starts
rem  PowerShell with -ExecutionPolicy Bypass for this run only.
rem  ASCII-only content on purpose (console codepage safety).
rem ============================================================
chcp 65001 >nul
setlocal
rem --- Re-add BOM check: the .ps1 MUST be UTF-8 with BOM, otherwise PowerShell 5.1
rem     reads it as GBK, splits Chinese strings and dies with parse errors.
rem     (Editing tools silently strip the BOM, so we verify it here every run.)
set "PSFILE=%~dp0_verify-codex.ps1"
for /f "tokens=1,2,3" %%a in ('powershell -NoProfile -Command "$b=[IO.File]::ReadAllBytes('%PSFILE%'); ($b[0..2]|%%{'{0:X2}' -f $_}) -join ' '"') do set "BOMCHK=%%a %%b %%c"
if not "%BOMCHK%"=="EF BB BF" (
  echo [warn] .ps1 lost its UTF-8 BOM -- fixing it now...
  powershell -NoProfile -Command "$t=[Text.Encoding]::UTF8.GetString([IO.File]::ReadAllBytes('%PSFILE%')); if($t[0] -eq [char]0xFEFF){$t=$t.Substring(1)}; [IO.File]::WriteAllText('%PSFILE%',$t,[Text.UTF8Encoding]::new($true))"
)
set "PS=powershell.exe"
where pwsh >nul 2>nul && set "PS=pwsh.exe"
"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%PSFILE%"
set RC=%ERRORLEVEL%
echo.
echo [exit code: %RC%]
pause
endlocal
