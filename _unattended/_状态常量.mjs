/**
 * 状态服务的常量 —— 单独一个文件，**不要**从 `_状态服务.mjs` import。
 *
 * 为什么：`_状态服务.mjs` 是**入口脚本**（import 就等于起服务）。客户端只是想知道"默认端口多少"，
 * 一旦从入口脚本拿常量，`import 客户端` 就会顺手把服务起起来 —— 实测会撞端口、也会在测试里泄漏进程。
 * 所以常量抽到这里，服务/客户端/ensure 三方共用一份。
 */

import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))

/** C 状态服务端口（19400 工具 / 19420 路由 / 19450 看板 已占，故选 19460） */
export const DEFAULT_PORT = 19460
/** 单文件库位置（唯一） */
export const DEFAULT_DB = join(HERE, '..', '_crew', 'state', 'crew.db')
export const SERVICE_NAME = 'C 状态服务'
export const ENSURE_SCRIPT = '确保状态服务.mjs'
/** 每卡每个 run 最多 6 次编码调用（§六） */
export const CODING_BUDGET = 6
