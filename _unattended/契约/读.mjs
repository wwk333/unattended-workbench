/**
 * 契约/读 —— 读 JSON 的小工具（**唯一实现**）
 *
 * 为什么单列一个文件：`JSON.parse(readFileSync(p,'utf8').replace(/^\uFEFF/,''))` 这一串
 * 在仓库里出现过十几次，各写各的就有各的坑（BOM、空文件、注释）。统一成一处：
 * 读不到 / 坏 JSON 一律回 `null`，由调用方判"缺失"，**不许静默当空对象**。
 */

import { existsSync, readFileSync } from 'node:fs'

/** 读 JSON；文件不存在 / 读失败 / 解析失败 ⇒ null（调用方必须自己判缺失） */
export function readJsonSafe (p) {
  if (!p || !existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
}

/** 读文本；读不到 ⇒ null */
export function readTextSafe (p) {
  if (!p || !existsSync(p)) return null
  try { return readFileSync(p, 'utf8') } catch { return null }
}
