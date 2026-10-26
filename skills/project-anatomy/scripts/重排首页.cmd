@echo off & chcp 65001 >nul & echo 按真实文件列表重排首页 00-总目录.md… & "{{NODE}}" "%~dp0重排首页.mjs" %* & echo. & echo —— 跑完了。 & pause
