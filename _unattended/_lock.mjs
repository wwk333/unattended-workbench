/**
 * 单实例锁 —— 防止"换新会话"和"编排"同时动手。
 *
 * 为什么需要：这两个脚本都会**建会话 / 改 TASKS.md 状态 / 记账**。
 * 同时跑会状态错乱，而且错得很隐蔽 —— 事后从日志里看不出是谁先动的手。
 *
 * 判定"锁是不是活的"要小心：**不能只看文件在不在**（进程被强杀会留下死锁文件）。
 * 所以锁文件里写 PID，拿 `process.kill(pid, 0)` 探活；探不到就当死锁并清理。
 * 另外带时间戳兜底：超过 `staleMs` 一律视为死锁（防 PID 被复用后误判为"有人占着"）。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const DEFAULT_STALE_MS = 2 * 60 * 60 * 1000   // 2 小时没动静就认为锁死了
/** 心跳间隔（毫秒）：跑长任务时定期把锁文件的 mtime 往前推，避免"还活着却被当死锁抢走"。 */
const HEARTBEAT_MS = 60 * 1000

function alive (pid) {
  try { process.kill(pid, 0); return true } catch { return false }
}

/**
 * 抢锁。
 *
 * ★ 2026-10-06 重写（三方交叉验证共同指出：原来 `exists → unlink → write` **三步非原子**，
 *   两个进程同时启动会互相击穿 = TOCTOU）：
 *   现在用 **`openSync(path,'wx')`** —— "不存在才创建"是**文件系统级的原子操作**，
 *   抢到的那个进程赢，另一个立刻拿到 `EEXIST`。这是唯一不需要额外依赖的正确做法。
 *   另外：**判断死锁看两处时间** —— 锁里记的 `startedAtMs` 与**锁文件自身的 mtime**
 *   （跑长任务时 `release.heartbeat()` 会推 mtime，见下），两者都超过 `staleMs` 才算死锁。
 *
 * @returns {{ ok: true, release: Function } | { ok: false, holder: object|null, reason: string }}
 */
export function acquireLock (lockFile, who, opts = {}) {
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS
  const now = Date.now()
  mkdirSync(dirname(lockFile), { recursive: true })

  const me = { who, pid: process.pid, startedAt: new Date().toISOString(), startedAtMs: now }
  const payload = JSON.stringify(me, null, 2)

  /** 原子抢锁：成功返回 fd；EEXIST 返回 null；其它错误抛出去。 */
  const tryCreate = () => {
    try { return openSync(lockFile, 'wx') } catch (e) {
      if (e?.code === 'EEXIST') return null
      throw e
    }
  }

  let fd = tryCreate()
  if (fd === null) {
    // 有人占着：看看是死是活
    let holder = null
    try { holder = JSON.parse(readFileSync(lockFile, 'utf8')) } catch { holder = null }
    let mtimeMs = 0
    try { mtimeMs = statSync(lockFile).mtimeMs } catch { mtimeMs = 0 }
    const started = holder?.startedAtMs ?? 0
    const freshByFile = mtimeMs > 0 && (now - mtimeMs) <= staleMs       // 文件还在被心跳推 = 活着
    const dead = !holder?.pid || !alive(holder.pid) || (now - started > staleMs && !freshByFile)
    if (!dead) {
      return {
        ok: false, holder,
        reason: `已有任务在跑：${holder.who ?? '(未知)'}（pid ${holder.pid}，起于 ${holder.startedAt ?? '?'}）`
      }
    }
    // 死锁：清掉再抢（清完仍走原子创建；万一被别人先抢到，这次就老实认输）
    try { unlinkSync(lockFile) } catch {}
    fd = tryCreate()
    if (fd === null) return { ok: false, holder: null, reason: '清理死锁后又被别人抢先拿到锁（并发启动）' }
  }

  try {
    writeSync(fd, payload)
  } catch (e) {
    try { closeSync(fd) } catch {}
    try { unlinkSync(lockFile) } catch {}
    return { ok: false, holder: null, reason: `写锁文件失败：${String(e?.message ?? e)}` }
  } finally {
    try { closeSync(fd) } catch {}
  }

  let released = false
  // 心跳：把锁文件 mtime 往前推（内容不动），让"死锁判定"能区分"长任务在跑"与"进程早没了"。
  const hb = setInterval(() => {
    if (released) return
    try { writeFileSync(lockFile, payload, 'utf8') } catch {}
  }, HEARTBEAT_MS)
  hb.unref?.()

  const release = () => {
    if (released) return
    released = true
    try { clearInterval(hb) } catch {}
    try {
      const cur = JSON.parse(readFileSync(lockFile, 'utf8'))
      if (cur?.pid === process.pid) unlinkSync(lockFile)   // 只删自己的锁
    } catch {}
  }
  // 正常退出、异常退出、被 Ctrl+C 都要放锁
  process.on('exit', release)
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { release(); process.exit(0) })

  return { ok: true, release }
}

export function readLock (lockFile) {
  try { return JSON.parse(readFileSync(lockFile, 'utf8')) } catch { return null }
}

// ★ 2026-10-03 迁移修正：锁文件原来写死在旧家（<旧家>\_crew\crew.lock）。
//   不改的话，旧家一删**单实例锁就失效**（两个编排脚本可能同时动手改状态/记账）。
//   现在由脚本自身位置推导（`_lock.mjs` 在 `<根>\_unattended\`，锁放 `<根>\_crew\`）。
//
// ⚠️⚠️ 2026-10-06 命名统一（三方交叉验证共同指出的"死保护"）：
//   这个常量是**唯一权威**（`_crew\crew.lock`）。而 `起飞前检查.mjs` 与
//   `sidebar-plugin\lib\index.js` 原来各自硬写 `_crew\orchestrator.lock` —— **全仓没有任何人写那个文件**，
//   于是"预检锁检查"和"看板的『编排在跑』"**永远看不到锁**（恒报"没有锁文件"）。
//  三处已统一到 `LOCK_FILE`；**别再写第二个名字**（要改就改这里）。
// ★ 2026-10-16（b91）：加一个**测试缝** `DSH_LOCK_FILE` —— 让探针能在**临时锁文件**上验"卡死/跑死"判据，
//   而不必去动真的 `_crew\crew.lock`（那会把正在跑的看护循环引去"叫醒大脑"＝**真花钱**）。
//   与 `登记服务.mjs` 的 `DSH_SERVICE_REG`、`长命资源巡检.mjs` 的 `DSH_LONGLIVE_STATUS_FILE` 同一套路。
//   不设这个环境变量时，行为与从前**一字不差**。
export const LOCK_FILE = process.env.DSH_LOCK_FILE
  ? resolve(process.env.DSH_LOCK_FILE)
  : resolve(import.meta.dirname, '..', '_crew', 'crew.lock')
/** 旧名（只用于**读**：清理历史残留的死锁文件；新代码一律用 `LOCK_FILE`）。 */
export const LEGACY_LOCK_NAMES = ['orchestrator.lock']
