/**
 * **要害文件判定**（2026-10-26 用户拍板 C）
 *
 * 背景：门禁对 L1/L2 的活自动 `--quick`（只跑 build+unit，跳 12 条冒烟），
 * 而交付门只认全量 ⇒ 小活永远卡 `gate:scope`。
 *
 * 规则（不看级别，看**碰了什么**）：
 *   · 只改文案 / 样式 / 注释 / 文档 ⇒ 半套门禁够用，放行；
 *   · 碰了入口主文件 / 门禁配置 / 依赖清单 / 启动器 / 服务端 ⇒ **必须全量**。
 *
 * 纪律：**放行需要正面证据** —— 查不到"这轮改了什么"就**不许放行**（fail-closed），
 * 因为"不知道改了什么"和"改的都是无害的"是两件事。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** 要害路径（命中任一 ⇒ 必须全量门禁） */
export const HAZARD_PATTERNS = [
  { re: /(^|\/)(gate\.json)$/i, why: '门禁配置本身' },
  { re: /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/i, why: '依赖清单' },
  { re: /(^|\/)(requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|CMakeLists\.txt)$/i, why: '依赖/构建声明' },
  { re: /\.(vbs|cmd|bat|ps1|exe)$/i, why: '启动器 / 可执行脚本' },
  { re: /(^|\/)(index\.html|main\.[a-z]+|app\.[a-z]+|server\.[a-z]+)$/i, why: '入口主文件' },
  { re: /(^|\/)(server|api|backend)\//i, why: '服务端目录' }
]

/** 这个文件是不是要害？返回 `{ hazard:boolean, why:string|null }` */
export function isHazardPath (p) {
  const q = String(p ?? '').replace(/\\/g, '/').replace(/^\.?\//, '')
  if (!q) return { hazard: false, why: null }
  for (const { re, why } of HAZARD_PATTERNS) if (re.test(q)) return { hazard: true, why }
  return { hazard: false, why: null }
}

/**
 * 取**最近一轮**指纹差异里改过的文件。
 * @returns {{ ok:boolean, why:string|null, files:string[], source:string|null }}
 */
export function changedFilesOf ({ project } = {}) {
  if (!project) return { ok: false, why: '没给项目', files: [], source: null }
  const dir = join(project, '_crew', 'fingerprints')
  let names = []
  try {
    names = readdirSync(dir).filter((f) => f.endsWith('.diff.json'))
  } catch { return { ok: false, why: '没有指纹差异目录（这轮没记改了什么）', files: [], source: null } }
  if (!names.length) return { ok: false, why: '指纹差异目录是空的', files: [], source: null }
  const withTime = names.map((f) => {
    let m = 0
    try { m = statSync(join(dir, f)).mtimeMs } catch {}
    return { f, m }
  }).sort((a, b) => b.m - a.m)
  const src = join(dir, withTime[0].f)
  let j = null
  try { j = JSON.parse(readFileSync(src, 'utf8')) } catch { return { ok: false, why: '最近那份指纹差异读不出', files: [], source: src } }
  const files = [...new Set([...(j.changed ?? []), ...(j.added ?? []), ...(j.removed ?? [])])].map((x) => String(x).replace(/\\/g, '/'))
  if (!files.length) return { ok: true, why: null, files: [], source: src }
  return { ok: true, why: null, files, source: src }
}

/**
 * 半套门禁能不能放行。
 * @returns {{ allow:boolean, reason:string, files:string[], hazards:{file:string,why:string}[], source:string|null }}
 */
export function quickScopeVerdict ({ project } = {}) {
  const c = changedFilesOf({ project })
  if (!c.ok) {
    return { allow: false, reason: `查不到这轮改了什么（${c.why}）⇒ 半套门禁不能放行`, files: [], hazards: [], source: c.source }
  }
  const hazards = c.files.map((f) => ({ file: f, why: isHazardPath(f).why })).filter((x) => x.why)
  if (hazards.length) {
    return {
      allow: false,
      reason: `改了要害文件（${hazards.map((h) => h.file + '：' + h.why).join('；')}）⇒ 必须全量门禁`,
      files: c.files,
      hazards,
      source: c.source
    }
  }
  return {
    allow: true,
    reason: `改动的 ${c.files.length} 个文件都不是要害文件 ⇒ 半套门禁够用（按决定 3 放行）`,
    files: c.files,
    hazards: [],
    source: c.source
  }
}
