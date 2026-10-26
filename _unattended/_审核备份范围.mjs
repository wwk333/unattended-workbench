/**
 * 审核前快照的**备份范围**（从 编排.mjs 里拆出来 —— 它是个纯函数，拆出来才测得了）。
 *
 * 2026-10-26 修：原来的写法把 `server/src`、`server/test`、`server/scripts` 当成所有项目都有的目录
 * —— 那是某个真实项目的结构。于是任何没有 `server/` 的项目走到审核必然
 * `审核前快照备份失败 → fail-closed 停手`，审核永远进不去（demo 真跑第二次就卡在这）。
 *
 * 规则：交付物目录优先；常见目录**存在才收**；全都没有 ⇒ 返回空数组（调用方按"跳过，不算失败"处理）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const norm = (d) => String(d ?? '').replace(/\\/g, '/').replace(/^\.?\//, '').replace(/\/+$/, '')

export const CONVENTIONAL_DIRS = ['server/src', 'server/test', 'server/scripts']

export function reviewBackupScope ({ project, files = [], conventional = CONVENTIONAL_DIRS, exists = null } = {}) {
  const has = exists ?? ((p) => { try { return existsSync(p) } catch { return false } })
  // ★ 2026-10-26 修：交付物在**项目根**时（如 index.html / gate.json / 启动器.vbs），
  //   dirname 是空串 ⇒ 原来被 `if (!d) continue` 整条丢掉 ⇒ 备份范围恒空，
  //   编排每轮都打「[快照] 没有可备份的目录」，审核前的"后悔药"实际没吃上。
  //   现在：根目录文件**保留文件名本身**（备份支持单文件），只有真的空才丢。
  const fromFiles = files
    .map((f) => {
      const q = norm(String(f))
      const dir = q.split('/').slice(0, -1).join('/')
      return dir || q
    })
    .filter(Boolean)
  const out = []
  const seen = new Set()
  for (const raw of [...fromFiles, ...conventional.map(norm)]) {
    const d = norm(raw)
    if (!d || seen.has(d)) continue
    seen.add(d)
    if (!project) { out.push(d); continue }
    if (has(join(project, d))) out.push(d)
  }
  return out
}

/**
 * 审核前快照的**真实可备份目标**（把 `reviewBackupScope` 的输出再洗一遍，供 `文件指纹.mjs backup --paths` 用）。
 *
 * ★ 2026-10-27 真跑当场抓到的 bug（不是本次改动引入的）：
 *   这段清洗原来写在 `编排.mjs` 的 `backupBeforeReview` 里，过滤条件是 **`d.includes('/')`**
 *   —— 要求路径里必须有分隔符。于是**根目录的交付物**（`index.html` / `gate.json` /
 *   `启动-背单词.vbs` / `tests`）全被丢掉 ⇒ `clean` 恒空 ⇒ 每轮都打
 *   「[快照] 没有可备份的目录（本轮审核没有明确改动范围）→ 跳过（不算失败）」。
 *   后果：**审核员是有全权写权的，而"放它动手前的后悔药"一次都没吃上**。
 *   这跟 `_审核白名单.mjs` 里那个 `/[\\/]/` 是同一类病（"必须带目录分隔符"）。
 *
 * 该挡的不是"文件"，是"整盘 / 整树"：
 *   ① 空串 / `.` / `..`
 *   ② 盘符开头（`c:` / `c:/` / `c:/xxx`）—— 只挡 `c:` 是挡不住的，必须按前缀判
 *   ③ 绝对路径（`/xxx`）
 *
 * @param {string[]} dirs `reviewBackupScope` 的返回（目录或根层文件名）
 * @returns {string[]} 去重、归一并仍然安全的相对路径
 */
export function backupTargets (dirs) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(dirs) ? dirs : []) {
    if (raw === null || raw === undefined) continue
    const s = String(raw).trim()
    if (!s) continue
    // ⚠️ 必须在 `norm()` **之前**判绝对路径：`norm` 会把开头的 `/` 当"前导分隔符"剥掉，
    //   于是 `/etc/passwd` 会被洗成看起来正常的 `etc/passwd`（单测当场抓到的）。
    if (/^[a-z]:/i.test(s)) continue                      // 盘符：c: / c:/ / c:/xxx
    if (s.startsWith('/') || s.startsWith('\\')) continue // 绝对路径 / UNC
    const d = norm(s)
    if (!d || d === '.' || d === '..') continue
    if (/^[a-z]:/i.test(d) || d.startsWith('/')) continue // 洗一遍再兜一次底
    if (seen.has(d)) continue
    seen.add(d)
    out.push(d)
  }
  return out
}
