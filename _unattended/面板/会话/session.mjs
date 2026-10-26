/**
 * 会话级归一化 · **把各载体的输出翻成"一段对话"**（看板 ④ 会话视图的底座）
 *
 * ## 与 `adapters\` 的分工（两个契约，别混）
 *   `adapters\`         —— 出 `{ kind, text }` **事件行**，给"最近动态"用（只取尾部 3 条，形状已冻结在跑）
 *   `session.mjs`（本件）—— 出 `{ role, kind, text, tool?, input?, ts? }` **会话条目**，给"像自己开一个会话"用
 *   ⇒ **刻意不改那 6 个 adapter**：它们在生产里跑着，改形状有回归风险；而会话视图要的字段更多
 *     （`user` / 工具入参 / 时间戳），本就是另一个契约。
 *
 * ## 条目契约
 *   `role`：`'user'`（派活/系统提醒）| `'assistant'`（载体自己说的）
 *   `kind`：`'text'` 正文 | `'thinking'` 思考 | `'tool_use'` 工具调用 | `'tool_result'` 工具结果 | `'status'` 机制行 | `'error'`
 *   其余：`tool`（工具名）、`input`（入参摘要）、`ts`（ISO 字符串，有才带）
 *
 * ## 纪律
 *   · 认不出的行/类型**跳过、绝不抛错**（展示层；判定不靠这里）
 *   · 进行中的文件（末行半截）**照样吃** —— 逐行 parse + try/catch（`_probe\_A4流式实验.mjs` 实测适配器已具备）
 *   · 只读文本、**不落任何新格式**（会话是"读出来的视图"，不是第五份状态）
 *
 * ★ 2026-10-18（b123）：**载体分派改成动态发现** —— 原来是 6 行静态 import ＋ `MAP = {...}` 枚举
 *   ⇒ **加一个载体得改这个文件**。实现搬进 `../_翻译器.mjs`（扫 `carriers\` 目录、顶层 await 预装）。
 *   ⚠️ 两个坑，改这里前先读：
 *     ① `brain.mjs` 在 `会话\` 而不在 `会话\carriers\` ⇒ **不会被当成载体翻译器**（大脑不是载体）。
 *     ② **本文件不能被子翻译器 import**：那会形成 `本件 →（await）→ carriers\x.mjs →（import）→ 本件` 的
 *        死锁环（实测 unsettled top-level await、exit 13）。所以公共小工具都在**叶子** `_工具.mjs` 里，
 *        6 个 carriers 直接 import 它；本文件只是**再导出**它们（对老调用方零改动）。
 */
import { toConversation as dispatch, SUPPORTED as SESSION_SUPPORTED } from '../_翻译器.mjs'

/** 支持列表（**活数组**：`会话流.mjs` 持有它做 `.includes()`，运行时可增长）。 */
export const SUPPORTED = SESSION_SUPPORTED

/**
 * @param {string} carrier 载体键（`_crew\agents.json` 的 agents 段键）
 * @param {string} text 载体输出原文（完整或**进行中**）
 * @returns {Array<{role:string,kind:string,text:string,tool?:string,input?:string,ts?:string}>}
 */
export function toConversation (carrier, text) {
  return dispatch(carrier, text)
}

// ── 公共小工具：唯一实现在叶子 `_工具.mjs`，这里原样再导出（老调用方一个都不用改）──────
export { BLOCK_MAX, eachJsonLine, readWholeJson, readEvents, cut, tsOf, argLine } from './_工具.mjs'
