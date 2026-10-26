@echo off & chcp 65001 >nul & echo 正在灌原文 + 回填 规模/指纹/抓取，稍等几秒… & "{{NODE}}" "%~dp0剖析.mjs" %* & echo. & echo —— 跑完了，上面每一行就是结果。 & pause
