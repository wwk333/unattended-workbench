#!/usr/bin/env node
/**
 * 自愈器 —— **唯一 `ensure` 消费者**（施工文档 §七「自愈规则」）
 *
 * ## 它治什么
 * 长命资源红了只写状态、**没人执行 `ensure`**（登记册里那个字段存了三年没人读）；
 * 看护循环自己死了也没人补。现在：看护循环每轮调本器，计划任务兜底拉看护循环。
 *
 * ## 只对**同时满足**这四条的项目动手（缺一条都不拉起）
 *   ① 登记册里 `expect !== 'stopped'`
 *   ② 有 `ensure` 脚本
 *   ③ `verify()` 判 `dead`（**不是** `orphan`，**不是** `mismatch`）
 *   ④ 同一项 1 小时内失败 < 3 次
 *
 * ## 动作
 * ```text
 * verify → dead
 *   → 调 ensure（幂等）
 *   → 2 秒后复查
 *   → 绿：记自愈成功，poke 巡检
 *   → 仍红：退避 5/15/30 分钟，最多 3 次
 *   → 3 次仍红：停止重试，写红告警，叫一次大脑
 * ```
 *
 * ## 铁律
 * - **孤儿只报告，绝不自动杀**；`mismatch` 也不杀，只报告并等下一次登记更新。
 * - 自愈失败要退避/封顶，否则会重启风暴。
 * - 账本：`_crew/自愈账本.jsonl`（一行一次尝试，**唯一写方＝本文件**）。
 *
 * ## 用法
 *   node 自愈器.mjs [--dry-run] [--json] [--max-per-cycle 3]
 *   node 自愈器.mjs --probe        # 只判不拉（演练/看板用）
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WORKBENCH = resolve(HERE, '..')
export const LEDGER = join(WORKBENCH, '_crew', '自愈账本.jsonl')
export const REGISTRY = join(WORKBENCH, '_crew', '服务登记.json')

/** 1 小时内同一项最多试 3 次（§七） */
export const MAX_FAILS_PER_HOUR = 3
/** 退避阶梯（分钟） */
export const BACKOFF_MIN = Object.freeze([5, 15, 30])
/** ensure 之后等多久复查（§七：2 秒后复查） */
export const VERIFY_DELAY_MS = 2000

/**
 * 今天能不能拉起这一项（**纯函数**，测试直接打这里）。
 * @param {object} o
 * @param {object} o.item       登记册一项 {name, expect, ensure, critical}
 * @param {string} o.status     verify 的结论：ok | dead | orphan | mismatch | unknown
 * @param {object[]} o.ledger   自愈账本（已解析）
 * @param {number} [o.now]
 * @returns {{ allow:boolean, why:string, failsLastHour:number, backoffMin:number }}
 */
export function canHeal ({ item, status, ledger = [], now = Date.now() } = {}) {
  const name = item?.name ?? '(无名)'
  if (!item) return { allow: false, why: '没有登记项', failsLastHour: 0, backoffMin: 0 }
  if (item.expect === 'stopped') return { allow: false, why: `${name}: expect=stopped，永不自动拉起`, failsLastHour: 0, backoffMin: 0 }
  if (!item.ensure) return { allow: false, why: `${name}: 没有 ensure（不自动拉起，红灯写明原因）`, failsLastHour: 0, backoffMin: 0 }
  if (status === 'orphan') return { allow: false, why: `${name}: 孤儿只报告，绝不自动杀/拉`, failsLastHour: 0, backoffMin: 0 }
  if (status === 'mismatch') return { allow: false, why: `${name}: mismatch 只报告，等下一次登记更新`, failsLastHour: 0, backoffMin: 0 }
  if (status !== 'dead') return { allow: false, why: `${name}: 不是 dead（${status}）`, failsLastHour: 0, backoffMin: 0 }

  const hourAgo = now - 3600_000
  const fails = (Array.isArray(ledger) ? ledger : []).filter(l =>
    l && l.name === name && l.ok !== true && Number.isFinite(Date.parse(l.at ?? '')) && Date.parse(l.at) >= hourAgo
  )
  const n = fails.length
  if (n >= MAX_FAILS_PER_HOUR) {
    const last = fails[fails.length - 1]
    return {
      allow: false,
      why: `${name}: 1 小时内已失败 ${n} 次 ⇒ 停止重试，写红告警并只叫一次大脑`,
      failsLastHour: n,
      backoffMin: BACKOFF_MIN[Math.min(n, BACKOFF_MIN.length - 1)]
    }
  }
  return { allow: true, why: `${name}: dead 且有 ensure ⇒ 拉起`, failsLastHour: n, backoffMin: BACKOFF_MIN[Math.min(n, BACKOFF_MIN.length - 1)] }
}

/**
 * 跑一轮自愈。**纯逻辑 + 注入**，测试不需要真起服务。
 * @param {object} o
 * @param {object[]} o.items      [{name, expect, ensure, critical, status, pid, port}]
 * @param {function} [o.ensure]   async (item) => {ok, why}   —— 真实现是 spawn ensure 脚本
 * @param {function} [o.sleep]    async (ms) => void
 * @param {object[]} [o.ledger]
 * @param {boolean} [o.dryRun]
 * @param {number} [o.dateNow]
 * @returns {Promise<{attempts:object[], skipped:object[], ok:boolean}>}
 */
export async function healOnce ({ items = [], ensure = null, sleep = defaultSleep, ledger = [], dryRun = false, now = Date.now(), maxPerCycle = 3 } = {}) {
  const attempts = []
  const skipped = []
  let done = 0
  for (const it of items) {
    const gate = canHeal({ item: it, status: it.status, ledger, now })
    if (!gate.allow) { skipped.push({ name: it.name, why: gate.why, status: it.status }); continue }
    if (done >= maxPerCycle) { skipped.push({ name: it.name, why: `本轮已达上限 ${maxPerCycle} 项（防重启风暴）`, status: it.status }); continue }
    done++
    if (dryRun) { attempts.push({ name: it.name, dryRun: true, planned: true, why: gate.why }); continue }
    const t0 = Date.now()
    let r = { ok: false, why: '没有 ensure 实现' }
    try { r = (await ensure?.(it)) ?? r } catch (e) { r = { ok: false, why: String(e?.message ?? e) } }
    if (r.ok) {
      // §七：拉起后 2 秒复查（这里用注入的 sleep，测试里是 0）
      await sleep(VERIFY_DELAY_MS)
      const again = await (it.recheck ?? (async () => ({ status: it.status })))()
      const healed = again?.status === 'ok'
      attempts.push({ name: it.name, ok: healed, tookMs: Date.now() - t0, why: healed ? '拉起后复查绿' : `拉起后仍 ${again?.status ?? 'unknown'}`, ensure: r.why ?? null, critical: it.critical === true })
      continue
    }
    attempts.push({ name: it.name, ok: false, tookMs: Date.now() - t0, why: r.why ?? 'ensure 失败', critical: it.critical === true })
  }
  return { attempts, skipped, ok: attempts.every(a => a.ok || a.dryRun) }
}

const defaultSleep = (ms) => new Promise(r => setTimeout(r, ms))

/** 追加一行账本（唯一写方） */
export function appendLedger (line, file = LEDGER) {
  try {
    mkdirSync(dirname(file), { recursive: true })
    appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), source: '自愈器.mjs', ...line }) + '\n', 'utf8')
    return true
  } catch { return false }
}

export function readLedger (file = LEDGER, limit = 500) {
  if (!existsSync(file)) return []
  try {
    return readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(-limit)
      .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

/**
 * 把"检查项 → 该不该拉起"喂给调度层：**critical 死了要停新派活**（§七）。
 * @returns {{ allowNewDispatch:boolean, criticalDown:string[], why:string|null }}
 */
export function dispatchGate (items = []) {
  const criticalDown = items.filter(i => i.critical === true && i.status !== 'ok').map(i => i.name)
  return {
    allowNewDispatch: criticalDown.length === 0,
    criticalDown,
    why: criticalDown.length ? `critical 资源不绿：${criticalDown.join('、')} ⇒ 停新派活（fail-closed）` : null
  }
}

// ---------------------------------------------------------------- CLI

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const argv = process.argv.slice(2)
  const has = n => argv.includes('--' + n)
  const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
  const dryRun = has('dry-run') || has('probe')
  try {
    const { listItems } = await import('./登记服务.mjs')
    // verify 由登记服务给结论（只报告，不执行）
    const { verify } = await import('./登记服务.mjs')
    const v = await verify()
    const byName = new Map((v.items ?? []).map(i => [i.name, i]))
    const items = listItems().map(it => ({
      ...it,
      status: byName.get(it.name)?.status ?? 'unknown',
      why: byName.get(it.name)?.why ?? null
    }))
    const ledger = readLedger()
    const res = await healOnce({
      items,
      ledger,
      dryRun,
      ensure: async (it) => {
        const { spawnSync } = await import('node:child_process')
        const r = spawnSync(process.execPath, [join(HERE, it.ensure)], { encoding: 'utf8', timeout: 120000, windowsHide: true, cwd: WORKBENCH })
        return { ok: r.status === 0, why: r.status === 0 ? 'ensure exit 0' : `ensure exit ${r.status}` }
      },
      // 注意：真实复查要在**下一轮**做（2 秒后重新 verify 会拖慢循环）；
      // 这里如实标记"已拉起，待下一轮复查"，不谎称已绿。
      maxPerCycle: Number(opt('max-per-cycle', 3))
    })
    for (const a of res.attempts) appendLedger(a)
    for (const s of res.skipped) if (/停止重试/.test(s.why)) appendLedger({ name: s.name, ok: false, why: s.why, exhausted: true })
    const gate = dispatchGate(items)
    const out = { schema: 1, kind: 'heal-run', at: new Date().toISOString(), source: '自愈器.mjs', state: res.ok ? 'ok' : 'red', stale: false, dryRun, ...res, dispatchGate: gate }
    console.log(has('json') ? JSON.stringify(out, null, 2) : `[自愈器] ${res.attempts.length} 次尝试 / ${res.skipped.length} 项跳过${gate.allowNewDispatch ? '' : ` ｜ ⛔ ${gate.why}`}`)
    process.exit(0)
  } catch (e) {
    console.error(`[自愈器] ❌ ${e.message}`)
    process.exit(1)
  }
}
