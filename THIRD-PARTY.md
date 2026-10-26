# 第三方组件与许可

> **一句话**：本项目自己是 Apache-2.0；**随包带的载体 CLI 是别人的东西**，原样分发、没有改动。
> 下面每一行都是**从实物里读出来的**（`package.json` 的 `license` 字段或目录里的 LICENSE 文件），不是抄的。

## 一、随包携带的载体（胖包 `*-offline.zip`）

| 组件 | 版本 | 许可 | 依据（实测） | 怎么用 |
|---|---|---|---|---|
| `@earendil-works/pi-coding-agent`（含 `pi-ai` `pi-tui` `pi-mcp` `pi-agent-core` `pi-codemode` `chord` `pi-telemetry`） | 1.1.0 | **MIT** | `package.json` 的 `license` 字段 | 原样随包 |
| `@tencent-ai/codebuddy-code` | 2.163.0 | **MIT** | 目录内 `LICENSE.txt`（腾讯 2023 的 MIT 正文） | 原样随包 |
| `@qwen-code/qwen-code` | 0.25.0 | **Apache-2.0** | 目录内 `LICENSE` | 原样随包 |
| `@opencode/cli-windows-x64`（提供 `opencode.exe`） | 2.0.26 | **MIT** | `npm view @opencode/cli-windows-x64@2.0.26 license` | 原样随包 |

**MIT / Apache-2.0 都要求保留版权与许可声明** —— 所以上面这些组件的 `LICENSE` / `LICENSE.txt` 文件**必须跟着一起发**，不要删。

## 二、**不**随包的组件（重要）

| 组件 | 为什么不发 |
|---|---|
| `@tencent-ai/sandbox-cli-win32-x64` | 它自己声明 `"license": "UNLICENSED"` ⇒ **不发**。它只是 codebuddy 的 `optionalDependency`，缺了只少沙箱功能 |
| `@openai/codex` / `@qodercn-ai/qoderclicn` | 许可干净（Apache-2.0），但**当前没有角色使用**，v0.1 不带（省 486 MB） |
| DeepSeek Harness（DSH）本体 | 体积 234.9 MB + 许可不明 ⇒ 用户自装 |
| `models.dev` 模型清单（`_unattended/数据/models.dev.json`） | 第三方公开元数据，**已随包**；如上游要求署名请提 issue |

## 三、本项目自己的代码

- 主体：**Apache-2.0**（见根目录 `LICENSE`）。
- `_unattended/pi-ext/protected-paths-narrow.ts` —— **本项目自写**，不是 Pi 官方示例的派生。
  它只是"替代"官方示例实现同样的目的（窄版写保护），判定逻辑（按路径段而不是子串）是自己写的。

## 四、上游接口可能变

这些 CLI 会自己升级。本项目**钉死版本**（`agents/package.json`），因为
"名字在册 ≠ 参数真被接受" —— 换版本必须重跑一次角色自检才算数（`node setup.mjs --connect --yes`）。

如果你自己升级了某个载体然后发现参数不认了：那不是本项目坏了，是上游改了接口。请开 issue 并附上版本号。
