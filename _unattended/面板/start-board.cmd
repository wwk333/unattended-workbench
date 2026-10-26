@echo off
REM ============================================================
REM  Board panel as a standalone desktop window (Edge --app).
REM  Route 1 of the "desktop board" plan: zero new runtime,
REM  reuses the SAME page/actions as the browser version.
REM
REM  ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less
REM  UTF-8 as ANSI(GBK), so any non-ASCII here would break parsing.
REM  All Chinese text lives in service.mjs / page source.
REM
REM  What it does:
REM    1) ensure the panel service is up (panel.ps1 is idempotent)
REM    2) open http://127.0.0.1:19450/ in Edge's app mode
REM       (no address bar, own profile -> own taskbar icon)
REM ============================================================
setlocal
set "HERE=%~dp0"
set "URL=http://127.0.0.1:19450/"
set "PROFILE=%LOCALAPPDATA%\dsh-board-edge"
set "EDGE=%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=msedge.exe"

REM 1) panel up? (panel.ps1 reports and starts it if needed)
powershell -NoProfile -ExecutionPolicy Bypass -File "%HERE%panel.ps1" >nul 2>&1

REM 2) app window (size is remembered by the profile after first run)
start "" "%EDGE%" --app=%URL% --user-data-dir="%PROFILE%" --window-size=1500,950 --no-first-run --no-default-browser-check
endlocal
