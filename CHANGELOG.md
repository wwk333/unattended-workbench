# 变更记录

> 只记**用户能感知的**变化。内部重构不写在这儿（那在开发文档里）。

## v0.1.0 — 预览版（2026-10-27）

**第一次发布。** 打包成"别人能自己装起来"的样子。

### 新增

- `setup.mjs` —— 装机入口。`--check` 只查不改 / `--apply` 能修就修 / `--connect` 真连一次（要显式 `--yes`）
- `doctor.mjs` —— 体检。三档结论：✅ 可起飞 / ⚠️ 能跑但有限制 / ❌ 还差 N 项
- `uninstall.mjs` —— 照安装账逐条回滚（保留你的配置与项目）
- `开始.md` —— 你唯一要读的东西：两段提示词，粘进 DSH 就行
- `config\` 层 —— **唯一允许写绝对路径的地方**。`本机映射.json` 由 `setup` 探测生成
- 载体**随包携带**（胖包）：pi / codebuddy / qwen-code / opencode，版本钉死
- `roles\*.template.md` + 渲染器 —— 角色规矩按本机路径渲染，模板随包走

### 改了什么（对老用户）

- 班组配置从 `_crew\agents.json` 迁到 `config\agents.json`；**老位置仍然认**，不用手动搬
- 桥 token 从 `_unattended\secrets\swap-token.txt` 迁到 `config\swap-token.txt`；同样兼容老位置
- 所有脚本不再写死本机路径，改从 `config\本机映射.json` / 环境变量 / 自身位置推导

### 已知问题

见 [`KNOWN_ISSUES.md`](KNOWN_ISSUES.md)。**最要紧的一条**：只支持 Windows，且 DSH 要自己装。
