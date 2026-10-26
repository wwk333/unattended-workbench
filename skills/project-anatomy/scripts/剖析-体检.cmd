@echo off & chcp 65001 >nul & echo 只体检、不改任何文件：未灌 / 过期 / 孤儿 / 缺标记，一次列清… & "{{NODE}}" "%~dp0剖析.mjs" --check & echo. & echo —— 跑完了：看上面最后一行「判定」。 & pause
