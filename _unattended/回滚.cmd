@echo off
rem ===========================================================================
rem  Rollback launcher for the unattended-mode desktop profile.
rem  Chinese file name is intentional; this file itself stays ASCII-ONLY.
rem
rem  WHY ASCII-ONLY: cmd.exe reads .cmd files in the OEM code page, so any
rem  non-ASCII text written here gets garbled AND can be executed as a command.
rem  (Measured the hard way: a Chinese comment line ran and failed.)
rem  All non-ASCII output is produced by _rollback.ps1 instead.
rem
rem  WHAT IT DOES: restores the desktop profile from the newest backup.
rem  It must work when DSH itself cannot start: no dsh, no plugins, no network.
rem  All paths are derived from this file's own location - never typed out.
rem
rem  USAGE:
rem    double-click            -> list backups, restore the newest one
rem    rollback.cmd --list     -> list backups only, change nothing
rem    rollback.cmd --from DIR -> restore from a specific backup directory
rem    rollback.cmd -DryRun    -> say what it would do, change nothing
rem ===========================================================================
setlocal
set "ROOT=%~dp0"
set "ROOT=%ROOT:~0,-1%"

powershell -NoProfile -ExecutionPolicy Bypass -File "%ROOT%\_rollback.ps1" %*
set "CODE=%ERRORLEVEL%"

echo.
if "%CODE%"=="0" (echo [rollback] DONE) else (echo [rollback] FAILED - see messages above)
echo.
rem  NOTE: dry-run is the DEFAULT now. Real restore needs: _rollback.ps1 -Apply
rem  (and -Force when targets are newer than the archive). Exit code 4 = refused
rem  because restoring would drop newer changes. All Chinese output comes from
rem  _rollback.ps1 - this file stays ASCII-only on purpose (see header).
if "%CODE%"=="4" echo  [rollback] REFUSED: that would drop newer changes. Use -Apply -Force if you really mean it.
echo Press any key to close this window...
pause >nul
exit /b %CODE%
