# 安全口径

> **一句话**：**钥匙不进包、不进库、不进日志。** 你给的钥匙只落在你自己的家目录里。

## 一、钥匙该放哪（只有一个地方）

```text
%USERPROFILE%\.dsh\.credentials.yaml      ← 唯一落点（DSH 自己的凭据库）
```

程序里**只允许**出现变量名：`${CRED:ARK_API_KEY}` 这种占位符，运行时现读、打印打码（`••••f031`）。

**不允许**出现的写法：

| 禁止 | 为什么 |
|---|---|
| 任何 `sk-…` / `Bearer …` / 长串十六进制 | 一进仓库就等于公开 |
| `_unattended\secrets\` 下的**真实** key 文件 | 那目录是历史遗留，新装不要往里放 |
| 把 key 写进 `config\agents.json` | 那是配置，会被复制、会被读、会被贴到 issue 里 |

## 二、本包怎么保证不带你东西

发布前跑一条命令，机器自己扫（`scripts/export-open.mjs --doctor`）：

| 扫什么 | 判据 |
|---|---|
| 真密钥 | `sk-` / `ghp_` / `AKIA` / `-----BEGIN … PRIVATE KEY-----` / `Bearer <长串>` ⇒ 命中即**不许导出** |
| 本机身份 | 任何「用户目录 \ 某个用户名」形式的路径、用户名、盘符路径 ⇒ 必须为 **0**（系统目录等标准位置除外） |
| 不该发的东西 | `secrets\` / `backup\` / `logs\` / `_crew\`（运行时数据）/ `history-from-E\` ⇒ 结构性挡掉 |
| 密钥文件 | `swap-token.txt` 由**安装时随机生成**，我们不存任何人的 token |

**你也能自己验**：

```powershell
node scripts\export-open.mjs --doctor --strict
```

## 三、它会动你系统里的什么（全记在账上）

`setup.mjs --apply` 只做这些，**每一条都会写进 `_crew\install-manifest.json`**：

- 建 `config\`（映射 / 配置 / 桥 token）
- 建 `_crew\` 的空目录骨架
- 渲染 `roles\*.md`（把占位符换成本机路径）
- 生成坑库骨架（如果你还没配）
- 装 DSH 预设与 bridge 插件（**可选**，会改 `~\.dsh\profiles\desktop\`）

**它不会**：写注册表、改系统 PATH、装驱动、动你的用户目录里其它东西。

## 四、卸载

```powershell
node uninstall.mjs
```

读 `_crew\install-manifest.json` 逐条回滚：删程序层、注销计划任务、卸插件。
**保留** `config\`（你的）与你的项目目录。**坑库默认不删** —— 删了等于忘掉所有教训，要删会单独问你一次。

## 五、发现漏洞怎么办

**不要开 public issue。** 发到维护者的邮箱（见仓库主页联系方式），或开一个只写"安全问题，请私聊我"的 issue 让我联系你。

## 六、已知的信任边界（说清楚，不装）

- 载体 CLI 以 **`--permission-mode bypassPermissions`** 之类的全权模式运行（不这样它们跑不了命令）。
  所以护栏不是"权限"，是**白名单 + 文件指纹 + 收据**：改了白名单外的文件，会当场列进收据。
- 审核员也**有权写文件**（能修小 bug）。它的产出会写进 `_crew\runs\*\review\`，可复查。
- 这套东西的设计前提是**你信自己的机器**。它不是多租户沙箱。
