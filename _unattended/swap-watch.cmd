@echo off
rem ============================================================
rem swap-watch.cmd - swap watcher launcher (ASCII name on purpose)
rem Chain: swap-watch.cmd -> swap-entry.mjs -> 换新会话.mjs --watch --execute
rem (launcher must be ASCII: it cannot carry a Chinese script name)
rem
rem   swap-watch.cmd            start the real watcher (watch + execute)
rem   swap-watch.cmd --probe    read-only chain check (no session swap)
rem   swap-watch.cmd --watch --dry   watch-only, never swaps
rem ============================================================
setlocal
set "HERE=%~dp0"
set "ARGS=%*"
if "%ARGS%"=="" set "ARGS=--watch --execute"

set "NODE=node"
where node >nul 2>nul
if errorlevel 1 if exist "%ProgramFiles%\nodejs\node.exe" set "NODE=%ProgramFiles%\nodejs\node.exe"

"%NODE%" "%HERE%swap-entry.mjs" %ARGS%
set "RC=%ERRORLEVEL%"
if not "%RC%"=="0" echo [swap-watch] exited with code %RC% (see logs\swap-watch.log)
endlocal & exit /b %RC%
