# 无人值守 · 多 agent 协同工作台

[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/platform-Windows-0078D6.svg)](#)
[![Release](https://img.shields.io/github/v/release/wwk333/unattended-workbench?label=release)](https://github.com/wwk333/unattended-workbench/releases)
[![Node](https://img.shields.io/badge/node-24.x-339933.svg)](https://nodejs.org)
[![Tests](https://img.shields.io/badge/tests-458%20passing-2ea44f.svg)](#)

> 一个人 + 一群 AI，把活干完并且**能被机器验收**。
> 你出需求，大脑拆活派给几个"班组"AI 去写，写完全量测试 + 独立审核，红了自动打回重修，绿了才交给你。

**一句话上手**：解压 → 打开 DSH → 把 [`开始.md`](开始.md) 里那段话粘进去。

---

## 30 秒懂它是什么

不是一个"更聪明的提示词"，是一套**带验收的流水线**：

| 你看到的 | 底下是什么 |
|---|---|
| 大脑（Brain） | 你的 DSH 会话。它只做三件事：拆活、派活、看结果 |
| 班组 | 几个独立的 CLI agent（pi / opencode / codebuddy / qwen-code），**各干各的活**，互相不看对方的上下文 |
| 门禁 | 一条命令跑完全量测试，**机器签字**，不是模型说"我觉得可以" |
| 审核 | 另一个模型读门禁摘要 + API 证据，给出 pass / reject |
| 交付门 | 门禁绿 + 审核 pass + 用户验收，三者齐了才算"能交" |
| 台账 / 看板 | 每条卡在第几步、花了多少、卡在哪，全部落盘可查 |

**为什么要有它**：让 AI 写代码不难，难的是**它说完成的时候你敢信**。这套东西存在的全部意义，就是把"敢信"变成一条可复现的命令。

---

## 它要什么（三样，缺一样都跑不起来）

| # | 需要 | 谁提供 |
|---|---|---|
| 1 | **DSH**（DeepSeek Harness 桌面端，Windows） | 你自己装。**不可分发**（体积 + 许可） |
| 2 | **载体 CLI**（至少一个 coder + 一个 reviewer） | 胖包自带 4 个；瘦包用 npm 装 |
| 3 | **API 钥匙**（至少一把，填进 `~/.dsh/.credentials.yaml`） | 你自己给。**我们不代持任何人的钥匙** |

> 一把火山方舟（ARK）的钥匙就能点亮 opencode / codebuddy / qwen-code 三家；
> pi 另需一把（小米或 Qwen token plan）。具体见 [`docs/快速开始.md`](docs/快速开始.md)。

---

## 五步

```text
① 解压          →  ② 粘一句提示词      →  ③ 它自己查/装/连
                                        ↓ 只在"登录 / 给钥匙"时停一次
④ 绿灯（node doctor.mjs）              →  ⑤ 说一句"帮我写个 XX 的策划"
```

`setup.mjs` 会把能修的全修掉，修不了的**说清缺什么、去哪填**；`doctor.mjs` 随时体检。

---

## 目录长什么样

```text
开始.md             ← 你要读的就这一个
setup.mjs           ← 装（--check / --apply / --connect）
doctor.mjs          ← 体检
uninstall.mjs       ← 卸（照着安装账逐条回滚）
_unattended\        ← 程序层：所有脚本、规则、面板、插件
config\             ← 配置层：**唯一允许写绝对路径的地方**（你的，不进包）
_crew\              ← 数据层：台账、门禁、运行记录（升级与卸载都不碰）
agents\             ← 载体 CLI（胖包自带）
docs\  examples\    ← 文档与最小样例
```

**三层分得很死**：升级只覆盖程序层，你的配置和数据一律不碰。

---

## 现在是什么状态（说清楚，不含糊）

- **预览版**：核心链路（派活 → 门禁 → 审核 → 交付门）已在本机跑通多轮，全量测试 456 条。
- **只支持 Windows**：依赖 `schtasks`、盘符、`.cmd`。
- **没有安装器**：解压即用，不写注册表。
- **不替你登录、不替你给钥匙、不替你装 DSH**：这三件只能人做。
- 已知问题见 [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md)；安全口径见 [`SECURITY.md`](SECURITY.md)。

---

## 许可与第三方

本项目 **Apache-2.0**（见 [`LICENSE`](LICENSE)）。
随包携带的载体 CLI 各有各的许可，逐条列在 [`THIRD-PARTY.md`](THIRD-PARTY.md) 里 —— **发的是原样，没有改动，也没有重新打包**。

---

## 一句话

> **它不承诺"AI 不会错"，它承诺"错了会被拦住，并且拦得下来说得出为什么"。**
