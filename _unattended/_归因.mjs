/**
 * 越界归因 —— 2026-10-21 通用化改造（第③⑤件）
 *
 * 两个老问题，同一个根：
 *   ③ **并行串台**：指纹是"开工拍一张、收工拍一张"，同批次并行时**隔壁写的文件会算到你头上**。
 *      实测：chaojimaliao 的 T1-04（栗子怪）被记了 17 条"真越界"，逐条看全是 T1-05（画面）的
 *      `assets/sprites/*.png`、`assets/tiles/*.png`、`证据/w1_1-1.png` —— 一个都不是它写的。
 *      当时的补丁（编排.mjs 的 `siblingPaths`）只能剔除"别人**声明过**的那个文件"，剔除不了
 *      "别人**生成**的一堆文件"。
 *   ⑤ **卡欠账**：任务卡的"交付:"列普遍写不全（实测一批 36 处越界里有 16 处是"卡没写全"），
 *      于是"越界"这个指标一半是假警报。
 *
 * 现在的口径（两条，通用）：
 *   · **目录级声明**：交付物可以写成目录（`src/render/` 或 `src/render/**`）⇒ 该目录下全部算它的；
 *   · **同级剔除**：同一个并行批里，别人声明过的**目录**（以及文件所在目录）里的文件，
 *     **不记到我头上**——同批同目录本来就说不清是谁写的，宁可不算，也不冤枉。
 *
 * 纪律：本模块是**纯函数**，不碰文件系统；所有判定都要能被单元测试直接调。
 */

/** 统一成"正斜杠 + 去掉开头 ./"的相对路径。 */
export function normPath (p) {
  return String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').trim()
}

/** 是不是"目录级"声明：`a/b/` 或 `a/b/**`。 */
export function isDirEntry (p) {
  const q = normPath(p)
  return /\/\*\*$/.test(q) || /\/$/.test(q)
}

/** 目录声明的"前缀"（不含结尾斜杠）；不是目录声明返回 null。 */
export function dirPrefix (p) {
  const q = normPath(p)
  if (!isDirEntry(q)) return null
  const cut = q.replace(/\/\*\*$/, '').replace(/\/+$/, '')
  return cut || null
}

/** 文件声明的"所在目录"（`a/b/c.ts` → `a/b`）；没有目录层返回 null。 */
export function parentDir (p) {
  const q = normPath(p)
  if (isDirEntry(q)) return dirPrefix(q)
  const i = q.lastIndexOf('/')
  return i > 0 ? q.slice(0, i) : null
}

/**
 * 建一个匹配器：`{exact:Set<文件>, prefixes:Set<目录>}`
 *   exact    —— 逐字声明的文件
 *   prefixes —— 目录声明（`x/`）+ 每个文件声明所在目录（`a/b/c.ts` → `a/b`）
 * 选项 `{ filesOnly: true }` 时**不把文件的父目录升格为前缀**（只认显式目录声明）——
 *   给"同级剔除"用：同批别人**明说要一个目录**时，才把整目录让给他。
 */
export function mkMatcher (entries, { filesOnly = false } = {}) {
  const exact = new Set()
  const prefixes = new Set()
  for (const e of Array.isArray(entries) ? entries : []) {
    const q = normPath(e)
    if (!q) continue
    if (isDirEntry(q)) { const d = dirPrefix(q); if (d) prefixes.add(d); continue }
    // 带扩展名/像文件的才进 exact；"src/core" 这种不带斜杠也不带扩展名的，按目录看
    if (/\.[A-Za-z0-9]{1,8}$/.test(q)) {
      exact.add(q)
      if (!filesOnly) { const d = parentDir(q); if (d) prefixes.add(d) }
    } else {
      prefixes.add(q)
    }
  }
  return { exact, prefixes }
}

/** 这一条路径被匹配器覆盖了吗。 */
export function covered (p, matcher) {
  const q = normPath(p)
  if (!q) return false
  if (matcher.exact.has(q)) return true
  for (const d of matcher.prefixes) if (q === d || q.startsWith(d + '/')) return true
  return false
}

/**
 * 把"越界清单"分成两类（口径与 编排.mjs 原版一致，只是复用同一套匹配器）：
 *   · whitelistGap（卡欠账）—— 落在自己声明的目录里，或就是自己声明的文件 ⇒ 卡没写全；
 *   · realOverreach（真越界）—— 落在自己声明的范围之外 ⇒ 这才该报给人看。
 */
/**
 * **机制文件**：班组自己写的账，永远不是"交付物"，也永远不该算成谁越界。
 *
 * 2026-10-26（demo 真跑第三次当场看到）：越界清单里那条是 `_crew/卡片看护.json` ——
 * 它是我方 `_监控.mjs` 每 10 秒刷一次的健康文件，跟审核员**一点关系没有**。
 * 结果审核报告里出现「contract:C2（机制文件被计改动，口径不通）」，一条**假越界**把整轮判死。
 *
 * 口径：`_crew/`（台账/门禁/指纹/看护/调参/runs…）、`.git/`、`node_modules/`、`.obsidian/`
 * 一律先摘出来，单独归到 `infra`，**不进越界统计**。
 */
export const INFRA_RE = /^(?:_crew|\.git|node_modules|\.obsidian|\.dsh)\//

export function isInfraPath (p) {
  return INFRA_RE.test(normPath(p))
}

/** 把一批路径拆成 { infra, rest } —— 调用方要单独交代机制文件时才用得上。 */
export function splitInfra (paths) {
  const infra = []; const rest = []
  for (const p of Array.isArray(paths) ? paths : []) (isInfraPath(p) ? infra : rest).push(normPath(p))
  return { infra, rest }
}

export function classifyOutOfScope (paths, allowed) {
  const m = mkMatcher(allowed)
  const whitelistGap = []; const realOverreach = []; const infra = []
  for (const p of paths) {
    // ★ 2026-10-26：机制文件（_crew/** 等）先摘出去 —— 它们是我方自己写的账，
    //   算成"越界"会造出假越界（实测把整轮审核判死过）。
    if (isInfraPath(p)) { infra.push(normPath(p)); continue }
    ;(covered(p, m) ? whitelistGap : realOverreach).push(normPath(p))
  }
  return { whitelistGap, realOverreach, infra }
}

/**
 * 同批剔除：从"我的越界清单"里摘掉**别人声明过的东西**。
 *
 * 规则（比"逐字匹配"宽一档，但不会把真问题吞掉）：
 *   · 别人**逐字声明**的文件 ⇒ 一定不是我的（剔除）；
 *   · 别人声明过的**目录**（含"他那边文件所在的目录"）里的文件 ⇒ 也大概率不是我写的（剔除），
 *     **除非那个目录我自己也声明了** —— 两边都在同一个目录里干活时，归因本来就是猜，
 *     宁可保留（当作可能的真越界）也不替谁背锅。
 */
export function deductSiblings (paths, siblingEntries, myEntries = []) {
  const sib = mkMatcher(siblingEntries)
  // 别人**显式写的目录**（`assets/sprites/`）是无歧义的：整块让给他，不看我自己声明了什么。
  const sibExplicitDirs = new Set((Array.isArray(siblingEntries) ? siblingEntries : [])
    .filter(isDirEntry).map(dirPrefix).filter(Boolean))
  const underExplicit = (q) => [...sibExplicitDirs].some(d => q === d || q.startsWith(d + '/'))
  // 没给"我自己声明了什么" ⇒ 只按上面两条最硬的判据（逐字 + 显式目录），不推断父目录
  const mine = myEntries.length ? mkMatcher(myEntries) : null
  const kept = []; const dropped = []
  for (const p of paths) {
    const q = normPath(p)
    const drop = sib.exact.has(q) || underExplicit(q) || (!!mine && covered(q, sib) && !covered(q, mine))
    ;(drop ? dropped : kept).push(q)
  }
  return { kept, dropped }
}
