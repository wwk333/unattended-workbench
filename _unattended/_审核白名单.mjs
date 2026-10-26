/**
 * **审核白名单**（2026-10-26 抽出，为了让 `whitelistEmpty` 那个 bug 能被测试钉住）
 *
 * 背景：编排建审核卡时，把"这一波 done 卡的交付物"折算成白名单，用来判断
 * "审核员改的文件算不算越界"。原来这段是内联的，还要求交付物**必须带目录分隔符**：
 *
 *     .filter(x => /[\\/]/.test(x))          ← 根目录文件（index.html / 启动器.vbs）被整条丢掉
 *     .map(x => dirname(x))                  ← 于是它们连"目录"都贡献不了
 *
 * ⇒ 只要交付物全在项目根、或这一波没有 done 卡，白名单就是空数组，
 *   编排只会打一句"⚠️ 白名单是空的 ⇒ 越界归不了因"，等于越界护栏形同虚设。
 *
 * 现在的口径（也就这么两条，别再复杂化）：
 *   1. **带目录的交付物** → 取它所在的目录（审核员改同目录别的文件不算越界）；
 *   2. **项目根的文件** → 保留文件名本身（不能变成空串，也不能丢）。
 * 去重、限量 12 条（多了没意义，只是提示）。
 */

const LIMIT = 12

export function reviewWhitelist (paths, { limit = LIMIT } = {}) {
  const out = []
  const seen = new Set()
  for (const raw of Array.isArray(paths) ? paths : []) {
    if (typeof raw !== 'string') continue
    const q = raw.trim().replace(/\\/g, '/').replace(/^\.?\//, '')
    if (!q) continue
    const entry = q.includes('/') ? q.split('/').slice(0, -1).join('/') : q
    if (!entry || seen.has(entry)) continue
    seen.add(entry)
    out.push(entry)
    if (out.length >= limit) break
  }
  return out
}
