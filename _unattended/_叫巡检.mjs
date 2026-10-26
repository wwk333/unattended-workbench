#!/usr/bin/env node
/**
 * 「谁动谁叫」的那声叫 —— **叫一声就走**（b91 · 轻分离的驱动端）
 *
 * ## 为什么单独一个小文件
 * 需要叫它的人有 6 处（`确保工具服务` / `确保路由` / `确保看守` / 面板起网关 / 面板启动 / 换会话交接 /
 * 登记册 CLI 的 up|down）。而 `长命资源巡检.mjs` 自己 import 了 `登记服务.mjs` 的 `verify()` ——
 * 若让 `登记服务.mjs` 反过来 import 巡检，就成了**环**（ESM 能活，但别给自己埋雷）。
 * 所以把这声"叫"独立出来：**两边都只 import 这个小文件**，既不成环，也不会两处各写一份 spawn。
 *
 * ## 分寸（两条）
 * ① **不等待**：`detached` ＋ `stdio:'ignore'` ＋ `unref()` —— 那个真核要起一次 PowerShell（≈0.72 秒），
 *    绝不能拖慢调用方（面板起网关、确保脚本、换会话都是前台路径）。
 * ② **fail-soft**：叫不动就算了 —— 兜底还在（看护每 30 分钟会核一次）。
 */
import { spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const INSPECT = join(HERE, '长命资源巡检.mjs')

/** 叫一声长命资源巡检（不等待）。`by` 会记进状态文件（"这次是谁叫的"）。 */
export function pokeInspection (by = '事件') {
  try {
    const c = spawn(process.execPath, [INSPECT, '--force', '--quiet', '--by', by], {
      detached: true, stdio: 'ignore', windowsHide: true
    })
    c.once('error', () => {})
    c.unref()
    return true
  } catch { return false }
}
