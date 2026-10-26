/**
 * 翻译器选择器：载体键（`_crew\agents.json` 里 agents 段的键）→ 对应 adapter。
 * 未支持的载体 ⇒ 空数组（上层显示"该载体暂无翻译器"）。
 *
 * ★ 2026-10-18（b123）**改成动态发现**：这里原来是 6 行静态 import ＋ `const MAP = {...}` 枚举
 *   ⇒ **加一个载体仍要改这个文件**（而每行只有一个载体名、又没加引号，
 *   `_probe\_载体可插拔性审计.mjs` 那个"一行里 ≥2 个载体名"的扫描**抓不到它** —— 实测审计报 0 处，
 *   缺口却在）。现在实现搬进 `../_翻译器.mjs`（扫目录 ＋ 顶层 await 预装 ＋ 运行时可 `ensureShape`），
 *   **加载体只多一个翻译器文件**。本文件保留原路径与原导出名 —— 上层（`帧数据.mjs`）一个字不用改。
 */
export { toEvents, ADAPTER_SUPPORTED as SUPPORTED, ensureShape, translatorFilesOf, LOAD_ERRORS } from '../_翻译器.mjs'
