@echo off
rem Start the board panel (batch 1) -- just double-click this file.
rem Script execution is blocked on this machine, so we bypass it for this one run.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0panel.ps1" %*
echo.
pause
