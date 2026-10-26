# 无人值守

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/wwk333/unattended-workbench?label=release)](https://github.com/wwk333/unattended-workbench/releases)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6.svg)](#)
[![Tests](https://img.shields.io/badge/tests-460-2ea44f.svg)](#)

一个多 agent 开发工作台，跑在 DSH（DeepSeek Harness 桌面端）里。

DSH 那边的大脑收到需求后拆成任务卡，派给几个互相独立的 CLI agent 去写；
写完跑全量测试，再由另一个模型复核，都过了才算完成。

## 开始

解压到一个没有中文和空格的路径，在这个目录里：

```powershell
node setup.mjs --apply
node doctor.mjs
```

`doctor` 说「可起飞」就能用了。然后把 [`开始.md`](开始.md) 里的提示词粘进 DSH。

`--apply` 会自己建配置、装策划技能、注册看护计划任务；做不了的会告诉你缺什么、填到哪。

## 需要什么

- **Windows 10/11**。用了 `schtasks`、盘符和 `.cmd`，别的系统跑不起来
- **DSH**，自己装。体积和许可都不允许分包
- **载体 CLI**：胖包里带了 pi、opencode、codebuddy、qwen-code 四个
- **API 钥匙**，写进 `%USERPROFILE%\.dsh\.credentials.yaml`。一把火山方舟的钥匙能点亮除 pi 以外的三个

具体步骤见 [`docs/快速开始.md`](docs/快速开始.md)。

## 目录

```text
开始.md              用户唯一要读的文件
setup.mjs            安装 / 体检 / 连一次
doctor.mjs           随时体检
uninstall.mjs        卸载，照安装账回滚
_unattended/         程序层：脚本、规则、面板、插件
config/              配置层：唯一允许写绝对路径的地方
_crew/               数据层：台账、门禁、运行记录
agents/              载体 CLI（只有胖包有）
docs/                文档
```

升级只覆盖程序层，`config/` 和 `_crew/` 不动。

## 状态

预览版。核心链路（派活 → 门禁 → 审核 → 交付门）在本机跑过多轮，全量 460 条测试。
没测过的场景列在 [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md)，包括非管理员账户、断网、中文用户名。

三件事只能人做：装 DSH、登录、填 API 钥匙。

## Obsidian（可选）

项目文件夹本身就能当 Obsidian 库用：`打开本地仓库` → 选它。
`.obsidian/` 是 Obsidian 打开时自己生成的，这里不预建。

装了 `dsh-obsidian` 插件的话，可以跑一次 `node _unattended\打obsidian路径护栏.mjs` 加道路径护栏。
没装插件会自动跳过。

## 文档

- [快速开始](docs/快速开始.md)
- [术语表](docs/术语表.md) —— 内部黑话比较多，先看这个不容易懵
- [工具清单](docs/工具清单.md) —— 200 多个脚本里你会手动敲的那十几个
- [安全口径](SECURITY.md)
- [第三方许可](THIRD-PARTY.md)

## 许可

Apache-2.0。随包携带的载体 CLI 是原样分发，各自许可见 [`THIRD-PARTY.md`](THIRD-PARTY.md)。
