/**
 * 扫描排除清单（**唯一一处定义**）—— b197（施工文档 §四 M6-10 第 1 件）
 *
 * 为什么要有这个文件：排除清单原来写在 `文件指纹.mjs` 里，而"回放验收脚本"要复现同一套规则 ⇒
 * 只能**抄一份**（抄了就会漂）。现在抽到这里：`文件指纹.mjs` 与 `_回放越界-b197.mjs` **都 import 它**。
 *
 * 三条判据（各管一类，别混）：
 *   · `SKIP_DIRS`  —— **目录名**（任意层级命中）
 *   · `SKIP_RELS`  —— **相对路径前缀**（项目根起算，用 `/` 分隔）
 *   · `SKIP_FILES` —— **文件路径正则**
 *
 * ★ 全部来自 561 条历史越界的实测统计（括号里是命中数），**不是为了"让数字好看"拍的**。
 * ⚠️ **红线一条都没排**（反向验收判据）：`server/src/**` 98 · `server/test/**` 56 · `server/migrations/**` 36 ·
 *   `server/package*` 11 · `server/scripts/**` 5 · `app-ui/src/**` 5 · `server/.env*` 4 · `server/config/**` 2。
 */

/** 目录名（任意层级）—— 依赖/构建/虚拟环境/工具缓存。`edge-profile` 是第三方浏览器缓存（实测 87 条）。
 *  ★ 2026-10-21：补 **Python 侧工具缓存**（`.ruff_cache` / `.pytest_cache` / `.mypy_cache` / `.tox`）——
 *    实测起因：chaojimaliao 首跑 T1-01 的 coder 跑了 `ruff`，落了 7 个 `.ruff_cache/**` 文件，
 *    被算进"真越界 9"里 → 全是噪音。与既有的 `.cache` / `.next` / `.vitest` 同类。 */
export const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', '__pycache__', '.venv', 'venv', 'env',
  '.next', 'coverage', '.dsh-market', '.trash', '.cache', '.vitest', '.expo', 'edge-profile',
  '.ruff_cache', '.pytest_cache', '.mypy_cache', '.tox',
])

/** 相对路径前缀 —— 编排自己的记账/产物落点。 */
export const SKIP_RELS = new Set([
  '_crew/fingerprints',   // 指纹自己的落点（不然"上一份快照"被算成新增）
  '_crew/runs',           // 每轮收据与任务卡
  '_crew/tasks',          // 常驻任务卡
  '_crew/edge-profile',   // 第三方浏览器缓存（87）
  '_crew/gate',           // 门禁产物（12）
  '_crew/running',        // 编排运行态（1）
  // ★ 2026-10-26（demo 真跑第三次当场看到）：这几处是**班组自己每秒/每 10 秒在刷**的账，
  //   被算成"审核员改的"⇒ 造出假越界，把整轮审核判死（实测那条是 _crew/卡片看护.json）。
  '_crew/state',          // 状态库（C 服务）
  '_crew/backups',        // 审核前快照
  '_crew/调参',           // 调参建议（每轮写）
  '_crew/自愈账本',       // 自愈账本（若按目录落）
  '_review_out',          // 审核落点（1）
  'backlog/tasks',        // 任务卡目录（78）
])

/** 文件路径正则 —— 编排/大脑自写的管理文件 ＋ 工具链临时文件。 */
export const SKIP_FILES = [
  /^_crew\/[^/]+\.log$/,                 // 编排日志（16）
  /^_crew\/[^/]+\.md$/,                  // _crew 根下的说明（1）
  /^_crew\/[^/]+\.json$/,                // ★ 2026-10-26：卡片看护/看护状态/长命资源/唤醒… 全是机制文件
  /^_crew\/[^/]+\.jsonl$/,               // 自愈账本之类
  /^_crew\/gate-status\.json$/,          // 门禁状态（2）
  /^TASKS\.md$/,                         // 编排自写（23）
  /^HANDOFF/,                            // 编排自写（11）
  /^(待裁决|分工表|拼接期契约)\.md$/,          // 大脑自写（5）
  // ★ 2026-10-21：人写的"监控/审计"类文档 —— 它们不是 coder 的交付物，也不该算越界。
  //   实测：我自己写的 `监控记录.md` 在 chaojimaliao 首跑里每轮都被记成"真越界"（纯噪音）。
  //   ⚠️ 只排"根目录且名字就是这类"的文件，别把项目自己的 docs 全排掉。
  /^AUDIT\.md$/,                         // 编排每轮追加的审计流水
  /^(监控记录|审计记录|巡检记录)\.md$/,       // 人写的监控/审计文档
  /\.tsbuildinfo$/,                      // TS 增量构建缓存（12）
  /\.db-(shm|wal)$/,                     // sqlite 临时文件（60）
  /^nul(\.|$)/,                          // Windows 空设备被误写成文件（5）
]

/** 目录要不要跳（`rel` 用 `/` 分隔、相对项目根）。 */
export function shouldSkipDir (name, rel) {
  return SKIP_DIRS.has(name) || SKIP_RELS.has(rel)
}

/** 文件要不要跳。 */
export function shouldSkipFile (rel) {
  return SKIP_FILES.some(re => re.test(rel))
}

/** 给回放/体检用：这条越界是不是"我们主动排掉的噪音"（返回命中的规则名，没命中返回 null）。 */
export function exclusionReason (rel) {
  const p = String(rel).replace(/\\/g, '/')
  const last = p.split('/').pop()
  if (SKIP_FILES.some(re => re.test(p))) return 'SKIP_FILES'
  for (const pre of SKIP_RELS) if (p === pre || p.startsWith(pre + '/')) return 'SKIP_RELS:' + pre
  for (const seg of p.split('/').slice(0, -1)) if (SKIP_DIRS.has(seg)) return 'SKIP_DIRS:' + seg
  return null
}
