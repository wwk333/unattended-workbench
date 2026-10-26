@echo off
rem Stop the board panel (batch 1) -- just double-click this file.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0panel.ps1" -Stop %*
echo.
pause
