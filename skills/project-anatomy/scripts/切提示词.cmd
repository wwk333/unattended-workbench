@echo off & chcp 65001 >nul & echo 从提示词正本重切 references\生成提示词.md… & "{{NODE}}" "%~dp0切提示词.mjs" %* & echo. & echo —— 跑完了。 & pause
