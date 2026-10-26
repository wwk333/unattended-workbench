#!/usr/bin/env node
/**
 * 干净导出 —— 把工作台导出成一个"别人能直接跑起来"的目录。
 *
 * 红线（一条都不许松）：
 *   1. **允许清单**，不是黑名单：只有 `ALLOW` 里认得的东西才会被导出；其余一律跳过。
 *   2. 密钥、`.env`、token、会话目录、`_crew/state/*.db`、`backup/`、`logs/`、`evidence/` **永不导出**。
 *   3. 导出前必须 `node --check` 全过；有一个不过就整体失败（不产出半成品）。
 *   4. 产出 `export-manifest.json`：每个文件的 sha256 + 总数；再跑一次能核对（幂等）。
 *   5. 目标目录必须**空或不存在**；不覆盖、不合并（防"把干净目录搞脏"）。
 *   6. ★2026-10-27（开源准备 W1）：**还要证明"没少带"** ——
 *      只证明"没多带"的体检是假绿：它报 ✅，而包里缺 26 个必需件、还漏了 35 个历史文件（实测）。
 *      所以 `--doctor` 现在查四件事：语法 / 敏感内容 / **缺件与悬空引用** / 扩展名覆盖。
 *
 * 三档结论（不是两档）：
 *   🔴 red    = 有害（语法错、**真密钥命中**）⇒ **不许导**
 *   🟡 yellow = 不完整（缺必需件、引用悬空、扩展名漏配、本机路径残留）⇒ **能导，但不许发**
 *   🟢 green  = 可导且可发
 *   ⚠️ 退出码：green=0，red=3，yellow=0（加 `--strict` 才把 yellow 当失败）。
 *      默认不因 yellow 失败，是为了让"导出"这个动作在开发期照常可用；**发布闸必须用 `--strict`**。
 *
 * 用法：
 *   node scripts/export-open.mjs --to <dir> [--json] [--force]
 *   node scripts/export-open.mjs --doctor [--json] [--strict]   # 只体检，不导出
 *   node scripts/export-open.mjs --verify <dir>                  # 核对已有导出的 manifest
 *   node scripts/export-open.mjs --baseline                      # 把当前"已知可接受"的引用写进基线
 */

import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = fileURLToPath(new URL('.', import.meta.url))
export const WORKBENCH = resolve(HERE, '..')
export const MANIFEST = 'export-manifest.json'
/** 已知可接受的"引用不到"（外部依赖、文档举例）。人工维护，只许变少不许变多。 */
export const BASELINE_FILE = join(HERE, '_导出缺件基线.txt')

/** ✅ 允许导出（相对工作台根）。**只认这些**。 */
export const ALLOW = Object.freeze([
  // 程序层：真代码与真配置
  '_unattended/**/*.mjs',
  '_unattended/**/*.json',
  '_unattended/**/*.md',
  '_unattended/**/*.js',
  '_unattended/**/*.html',
  '_unattended/**/*.css',
  // ★W1：这七类是**功能件**，以前被"只认六种扩展名"静默丢掉（实测 17 个）：
  //   cordis.patch.yml（bridge 插件自己的 patch）· preset-*.yml（预设）· protected-paths-narrow.ts（pi 扩展）
  //   · playtest.py（编排会调）· board.ico（面板图标）· 会话体检.cjs · 启动/回滚 .cmd/.ps1
  '_unattended/**/*.cjs',
  '_unattended/**/*.cmd',
  '_unattended/**/*.ps1',
  '_unattended/**/*.yml',
  '_unattended/**/*.ts',
  '_unattended/**/*.ico',
  '_unattended/**/*.py',
  // 契约定型
  'contracts/*.schema.json',
  'contracts/*.md',
  // 测试（包里要能自己跑）
  'tests/*.mjs',
  // 最小样例
  'examples/demo/**/*.mjs',
  'examples/demo/**/*.json',
  'examples/demo/**/*.md',
  // 工具
  'scripts/*.mjs',
  'scripts/*.txt',
  // 根：用户唯一要读的东西 + 合规件（★W1：这些以前根本没写进清单，缺了也不报）
  'README.md',
  '开始.md',
  'LICENSE',
  'SECURITY.md',
  'THIRD-PARTY.md',
  'CHANGELOG.md',
  'KNOWN_ISSUES.md',
  'setup.mjs',
  'doctor.mjs',
  'uninstall.mjs',
  'uninstall.mjs',
  'gate.json',
  // 用户文档
  'docs/**/*.md',
  // 配置示例（真配置永不进包）
  'config/*.example.json',
  'config/*.example.txt'
])

/** ⛔ 永不导出（即使落在允许目录里也要拦）。**顺序无关，先 DENY 后 ALLOW**。 */
export const DENY = Object.freeze([
  /(^|\/)secrets?\//i,
  /(^|\/)\.env(\..*)?$/i,
  /(^|\/)\.git\//i,
  /(^|\/)backup\//i,
  /(^|\/)logs?\//i,
  /(^|\/)evidence\//i,
  // ★W1：整个 `_crew\` 是数据层，任何层级都不许进包（含 examples/demo/_crew —— 见 D21）
  /(^|\/)_crew\//i,
  /(^|\/)_crew\/.*\.(db|db-wal|db-shm)$/i,
  /(^|\/)_crew\/.*账本.*\.jsonl$/i,
  /(^|\/)node_modules\//i,
  /(^|\/)\.trash\//i,
  /(^|\/)swap-token\.txt$/i,
  // ★W1：本机死档案 + 缓存（以前只靠 .gitignore 挡，导出根本不看 .gitignore）
  /(^|\/)history-from-E\//i,
  /(^|\/)__pycache__\//i,
  // ★W1：手工备份一律不进包（`.bak-xxx` 这类扩展名本来也匹配不上 ALLOW，这里是第二道闸）
  /\.(?:bak|orig|before|pre-rollback)(?:[-.]|$)/i,
  // ★W3（D27）：角色规矩的**渲染稿**不随包（它含本机真路径）。包里发的是 `*.template.md`，
  //   由 `_渲染角色.mjs` 在安装时渲染。见 GENERATED。
  /(^|\/)roles\/(?:brain|班组须知|班组须知-细则)\.md$/i,
  // ⚠️ 这里**故意不再有** `/会话\//` 这条：它是任意层级匹配，会把 `_unattended\面板\会话\` 一并杀掉
  //    （实测丢掉 9 个文件，面板的会话功能在包里直接死掉）。`_crew\会话` 已由上一条 `_crew/` 挡住。
])

/**
 * 🔁 生成件：**安装时由脚本生成**，所以"工作台里有、包里没有"是**对的**，不算缺件。
 * 只放"确实有渲染器/生成器"的东西 —— 别拿它当"漏带的遮羞布"。
 */
export const GENERATED = Object.freeze([
  '_unattended/roles/brain.md',
  '_unattended/roles/班组须知.md',
  '_unattended/roles/班组须知-细则.md'
])

/** 📦 必需件：少一个就不算"能给别人"的包。**缺了必须报红字**，不许静默。 */
export const REQUIRED = Object.freeze([
  'README.md',
  'LICENSE',
  '开始.md',
  'setup.mjs',
  'doctor.mjs',
  'SECURITY.md',
  'THIRD-PARTY.md',
  'docs/快速开始.md',
  'docs/术语表.md',
  'examples/demo/gate.json',
  'tests/跑测试.mjs',
  '_unattended/门禁.mjs',
  '_unattended/bridge-plugin/cordis.patch.yml',
  '_unattended/preset-无人值守.draft.yml'
])

/**
 * 🔑 真密钥特征 —— 命中就是 **red**，不许导。
 * 只收"高置信、几乎不可能出现在说明文档里"的形状；宽的（如任意 UUID）会淹没真信号。
 */
export const SECRET_PATTERNS = Object.freeze([
  ['私钥块', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ['OpenAI/DeepSeek 风格 sk-', /\bsk-[A-Za-z0-9_-]{20,}/],
  ['GitHub PAT', /\bghp_[A-Za-z0-9]{20,}/],
  ['AWS AKIA', /\bAKIA[0-9A-Z]{16}\b/],
  ['Bearer 长串', /\bBearer\s+[A-Za-z0-9._~+/-]{24,}=*/],
  ['key 字段带长值', /"(?:api[_-]?key|apikey|access[_-]?token|client[_-]?secret)"\s*:\s*"(?!\$\{|<|YOUR|xxx)[A-Za-z0-9._~+/-]{16,}"/i]
])

/**
 * 🏠 本机痕迹 —— 命中是 **yellow**（不是密钥，但会暴露"这是谁的电脑"）。
 * 用户口径：**不能泄露我电脑的信息**。所以盘符、用户名、家目录都在这一类。
 */
export const PATH_PATTERNS = Object.freeze([
  ['Windows 用户名路径', /[A-Za-z]:\\{1,2}Users\\{1,2}[A-Za-z0-9._-]+/i],
  // ⚠️ 这条不许写成连续的字面量：否则本文件自己会命中自己（体检器把自己搞红，我踩过一次）
  ['本机用户名', new RegExp('\\b' + 'Admin' + 'istrator' + '\\b')],
  // ⚠️ 反斜杠要写成 `\\{1,2}`（两个）：代码里的路径是转义形式，只按一个扫会漏一半。
  //    只写 `\\` 会漏掉一半 —— 我第一版就漏了，扫出来 10 处，实际 20 处。
  ['盘符路径', /\b[A-Za-z]:\\{1,2}[A-Za-z0-9_\u4e00-\u9fa5]/]
])

/**
 * 这些"盘符"是**每台 Windows 都一样的标准位置**，不带任何"这是谁的机器"的信息。
 * 扫描时放过它们，否则会逼着把 `Program Files` 这种常量也改掉（纯属自找麻烦）。
 */
export const HARMLESS_PATH = Object.freeze([
  // `\\{1,2}`：源码里写的是"系统目录 + 两个反斜杠"的转义形式，只认一个会漏一半
  /^[A-Za-z]:\\{1,2}(?:Program Files(?: \(x86\))?|Windows|ProgramData)\b/i
])

const globToRe = (g) => {
  const s = g
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*\//g, '\u0000')
    .replace(/\*\*/g, '.*')
    .replace(/\*/g, '[^/]*')
    .replace(/\u0000/g, '(?:.*/)?')
  return new RegExp('^' + s + '$', 'i')
}
const ALLOW_RE = ALLOW.map(globToRe)

export function allowed (rel) {
  const p = String(rel).replace(/\\/g, '/')
  if (DENY.some(re => re.test(p))) return false
  return ALLOW_RE.some(re => re.test(p))
}

/** 递归列出工作台里"能导出"的文件（相对路径，posix 风格） */
export function listExportable (root = WORKBENCH) {
  const out = []
  const walk = (dir) => {
    let entries = []
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name === '.git' || e.name === '.trash') continue
      const p = join(dir, e.name)
      const rel = relative(root, p).split(sep).join('/')
      if (e.isDirectory()) { if (!DENY.some(re => re.test(rel + '/'))) walk(p); continue }
      if (!statSync(p).isFile()) continue
      if (allowed(rel)) out.push(rel)
    }
  }
  walk(root)
  return out.sort()
}

export function sha256File (file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

// ────────────────────────────────────────────────────────────── 体检用的四把尺子

const TEXT_EXT = new Set(['.mjs', '.js', '.cjs', '.json', '.md', '.html', '.css', '.cmd', '.ps1', '.yml', '.yaml', '.ts', '.py', '.txt', '.jsonl'])
const readText = (p) => {
  try {
    if (statSync(p).size > 4 * 1024 * 1024) return null
    return readFileSync(p, 'utf8')
  } catch { return null }
}

/**
 * ① 敏感内容：真密钥（red）+ 本机痕迹（yellow）
 *
 * ⚠️ 必须**逐条列全**，不能"每个文件每类只报第一条"：我第一版就是这么写的，
 *    结果同一文件里第二处路径被第一条盖住，看着"只剩 10 处"，实际还有十几处藏在后面。
 *    一般 `file:line` 才好改。单文件封顶 `MAX_PER_FILE` 条，防一份大日志刷屏。
 */
const MAX_PER_FILE = 40
const lineOf = (t, idx) => t.slice(0, idx).split('\n').length

export function scanContent (root = WORKBENCH, files = listExportable(root)) {
  const secrets = []
  const paths = []
  for (const rel of files) {
    if (!TEXT_EXT.has(extname(rel).toLowerCase())) continue
    const t = readText(join(root, ...rel.split('/')))
    if (t === null) continue
    for (const [kind, re] of SECRET_PATTERNS) {
      let n = 0
      for (const m of t.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
        if (++n > MAX_PER_FILE) break
        secrets.push({ file: rel, line: lineOf(t, m.index), kind, sample: String(m[0]).slice(0, 24) + '…' })
      }
    }
    for (const [kind, re] of PATH_PATTERNS) {
      let n = 0
      for (const m of t.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'))) {
        // 标准位置（系统目录 / 程序目录）不算"本机信息"，放过
        if (HARMLESS_PATH.some(h => h.test(t.slice(m.index, m.index + 80)))) continue
        if (++n > MAX_PER_FILE) break
        paths.push({ file: rel, line: lineOf(t, m.index), kind, sample: String(m[0]).slice(0, 48) })
      }
    }
  }
  return { secrets, paths }
}

/**
 * ② 缺件 + 悬空引用。**只看两件事，别的一律不管**（宁可少报，也不要报一堆假警被人关掉）：
 *   (a) 程序层有、包里没有 —— 直接比集合，不猜引用。这一条就能抓住 M1（丢 17 个）与 L2（丢 9 个）。
 *   (b) 相对 import 解析不到 —— 硬伤，装上也跑不起来。
 */
const LAYER_ROOTS = Object.freeze(['_unattended', 'scripts', 'contracts', 'tests', 'examples/demo', 'docs', 'config'])
const SKIP_DIRS = /^(backup|backups|logs|secrets|history-from-E|__pycache__|node_modules|_crew|_tmp)$/i
/** 这些是运行期产物，本来就不进包（不是"缺件"） */
const RUNTIME_EXT = new Set(['.log', '.jsonl', '.pyc'])
const isBackup = (p) => /\.(?:bak|orig|before|pre-rollback)(?:[-.]|$)/i.test(p)

/** 程序层里"本该进包"的文件（相对路径）。**这是判"少没少带"的唯一口径。** */
export function layerFiles (root = WORKBENCH) {
  const out = []
  for (const r of LAYER_ROOTS) {
    const abs = join(root, ...r.split('/'))
    if (!existsSync(abs)) continue
    const walk = (d) => {
      let es = []
      try { es = readdirSync(d, { withFileTypes: true }) } catch { return }
      for (const e of es) {
        const p = join(d, e.name)
        if (e.isDirectory()) { if (!SKIP_DIRS.test(e.name)) walk(p); continue }
        const rel = relative(root, p).split(sep).join('/')
        if (isBackup(rel)) continue
        if (RUNTIME_EXT.has(extname(e.name).toLowerCase())) continue
        out.push(rel)
      }
    }
    walk(abs)
  }
  return out.sort()
}

/** 粗剥注释（只为"找真 import"，不追求完美）：块注释整段去掉，行注释去掉 `//` 之后 */
export function stripComments (t) {
  return String(t)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split(/\r?\n/)
    .map(line => {
      const i = line.indexOf('//')
      if (i < 0) return line
      // 别把 `http://` 当注释
      if (i > 0 && line[i - 1] === ':') return line
      return line.slice(0, i)
    })
    .join('\n')
}

export function findGaps (root = WORKBENCH, files = listExportable(root)) {
  const out = []
  // 2.1 必需件
  for (const rel of REQUIRED) {
    const abs = join(root, ...rel.split('/'))
    if (!existsSync(abs)) out.push({ kind: '缺必需件', file: rel, why: '文件不存在' })
    else if (!allowed(rel)) out.push({ kind: '缺必需件', file: rel, why: '文件在，但没被 ALLOW 收进来' })
  }
  // 2.2 程序层：有、但没进包
  const exported = new Set(files)
  const generated = new Set(GENERATED)
  for (const rel of layerFiles(root)) {
    if (exported.has(rel)) continue
    // 生成件本来就该"有但没进包"（安装时渲染），不算缺
    if (generated.has(rel)) continue
    // config\ 下的真配置是"人的东西"，本来就只发 .example.*
    if (/^config\//.test(rel) && !/\.example\./.test(rel)) continue
    out.push({ kind: '程序层少带', file: rel, why: extname(rel).toLowerCase() + ' 不在 ALLOW 里' })
  }
  // 2.3 相对 import 解析不到
  const baseline = loadBaseline()
  for (const rel of files) {
    if (extname(rel).toLowerCase() !== '.mjs' && extname(rel).toLowerCase() !== '.js') continue
    const raw = readText(join(root, ...rel.split('/')))
    if (raw === null) continue
    const t = stripComments(raw)
    for (const m of t.matchAll(/(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"\n]+)['"]/g)) {
      const spec = m[1]
      if (spec.includes('<') || spec.includes('${')) continue
      const target = resolve(dirname(join(root, ...rel.split('/'))), spec.replace(/\\/g, '/'))
      const cand = [target, target + '.mjs', target + '.js', join(target, 'index.mjs')]
      if (cand.some(p => existsSync(p))) continue
      if (baseline.has(basename(spec))) continue
      out.push({ kind: '引用悬空', file: rel, why: spec })
    }
  }
  return out
}

/**
 * ③ 扩展名覆盖：活树里出现的扩展名，ALLOW 里必须"这一种要么认、要么显式说明不要"。
 * 只扫 `_unattended`（程序层），因为它是扩展名最多的地方。
 */
export function extensionCoverage (root = WORKBENCH) {
  const IGNORE = new Set(['', '.pyc', '.log', '.jsonl', '.txt', '.sample', '.map', '.woff', '.woff2', '.ttf', '.png', '.jpg', '.jpeg', '.gif', '.svg', '.zip'])
  const allowExt = new Set(ALLOW.filter(a => a.includes('*')).map(a => extname(a.replace(/\*/g, 'x'))).filter(Boolean))
  const dir = join(root, '_unattended')
  if (!existsSync(dir)) return []
  const counts = new Map()
  const samples = new Map()
  const walk = (d) => {
    let es = []
    try { es = readdirSync(d, { withFileTypes: true }) } catch { return }
    for (const e of es) {
      if (e.name === '__pycache__' || e.name === 'node_modules') continue
      const p = join(d, e.name)
      if (e.isDirectory()) { if (!/^(backup|logs|history-from-E)$/i.test(e.name)) walk(p); continue }
      const ext = extname(e.name).toLowerCase()
      if (/\.bak/i.test(e.name)) continue
      counts.set(ext, (counts.get(ext) || 0) + 1)
      if (!samples.has(ext)) samples.set(ext, new Set())
      if (samples.get(ext).size < 3) samples.get(ext).add(e.name)
    }
  }
  walk(dir)
  const out = []
  for (const [ext, n] of counts) {
    if (allowExt.has(ext) || IGNORE.has(ext)) continue
    out.push({ ext: ext || '(无扩展名)', count: n, files: [...(samples.get(ext) || [])] })
  }
  return out.sort((a, b) => b.count - a.count)
}

export function loadBaseline (file = BASELINE_FILE) {
  try {
    return new Set(readFileSync(file, 'utf8').split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith('#')))
  } catch { return new Set() }
}

// ────────────────────────────────────────────────────────────────────── doctor

/** 导出前体检：语法 / 敏感 / 缺件 / 扩展名覆盖 */
export function doctor (root = WORKBENCH) {
  const files = listExportable(root)
  const mjs = files.filter(f => f.endsWith('.mjs'))
  const syntax = []
  for (const rel of mjs) {
    const r = spawnSync(process.execPath, ['--check', join(root, rel)], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    if (r.status !== 0) syntax.push({ file: rel, why: String(r.stderr ?? '').split('\n').slice(0, 3).join(' ') })
  }
  const { secrets, paths } = scanContent(root, files)
  const gaps = findGaps(root, files)
  const warns = extensionCoverage(root)
  const fatal = syntax.length + secrets.length
  const state = fatal ? 'red' : ((gaps.length || warns.length || paths.length) ? 'yellow' : 'green')
  return {
    schema: 2,
    kind: 'export-doctor',
    at: new Date().toISOString(),
    source: 'scripts/export-open.mjs',
    state,
    stale: false,
    // ⚠️ ok 的语义保持 v1 不变：**能不能安全导出**。缺件/路径是"能不能发"，走 state。
    ok: fatal === 0 && files.length > 0,
    counts: {
      files: files.length,
      mjs: mjs.length,
      syntaxErrors: syntax.length,
      secrets: secrets.length,
      gaps: gaps.length,
      warns: warns.length,
      pathHits: paths.length,
      // 兼容 v1 的字段名（老测试与 e2e 在读它）
      denied: 0
    },
    syntaxErrors: syntax,
    secrets,
    gaps,
    warns,
    pathHits: paths,
    denied: []
  }
}

// ────────────────────────────────────────────────────────────────────── 导出

/** 真导出 */
export function exportTo (to, { root = WORKBENCH, force = false } = {}) {
  const dest = resolve(to)
  if (existsSync(dest)) {
    const empty = readdirSync(dest).length === 0
    if (!empty && !force) return { ok: false, why: `目标目录非空：${dest}（不覆盖、不合并；确要用 --force）` }
    if (!empty && force) rmSync(dest, { recursive: true, force: true })
  }
  mkdirSync(dest, { recursive: true })
  const doc = doctor(root)
  if (!doc.ok) {
    return {
      ok: false,
      why: '体检没过（语法错或真密钥命中），不导出（不产出半成品）',
      doctor: doc
    }
  }
  const files = listExportable(root)
  const manifest = []
  for (const rel of files) {
    const src = join(root, ...rel.split('/'))
    const dst = join(dest, ...rel.split('/'))
    mkdirSync(dirname(dst), { recursive: true })
    cpSync(src, dst)
    manifest.push({ path: rel, sha256: sha256File(dst), bytes: statSync(dst).size })
  }
  const snap = createHash('sha256').update(manifest.map(m => `${m.path}\0${m.sha256.slice(0, 12)}\n`).sort().join('')).digest('hex')
  const body = {
    schema: 2,
    kind: 'export-manifest',
    at: new Date().toISOString(),
    source: 'scripts/export-open.mjs',
    state: doc.state,
    stale: false,
    snapshotId: `sha256:${snap}`,
    counts: { files: manifest.length, gaps: doc.gaps.length, warns: doc.warns.length, pathHits: doc.pathHits.length },
    files: manifest
  }
  writeFileSync(join(dest, MANIFEST), JSON.stringify(body, null, 2) + '\n', 'utf8')
  return { ok: true, to: dest, count: manifest.length, snapshotId: body.snapshotId, state: doc.state, gaps: doc.gaps, warns: doc.warns, pathHits: doc.pathHits }
}

/** 核对已有导出（幂等/没被改过） */
export function verifyExport (dir) {
  const dest = resolve(dir)
  const mf = join(dest, MANIFEST)
  if (!existsSync(mf)) return { ok: false, why: `没有 ${MANIFEST}` }
  const body = JSON.parse(readFileSync(mf, 'utf8'))
  const bad = []
  for (const f of body.files ?? []) {
    const p = join(dest, ...String(f.path).split('/'))
    if (!existsSync(p)) { bad.push(`${f.path}: 缺失`); continue }
    const h = sha256File(p)
    if (h !== f.sha256) bad.push(`${f.path}: 内容变了`)
  }
  return { ok: bad.length === 0, files: (body.files ?? []).length, bad, snapshotId: body.snapshotId }
}

/** 把当前缺口里"确实是外部依赖/文档举例"的写进基线（人工复核后再跑一次） */
export function writeBaseline (root = WORKBENCH, names = null) {
  const gaps = findGaps(root)
  const set = names ? new Set(names) : new Set(gaps.map(g => basename(String(g.why).split('（')[0].trim())))
  const header = [
    '# 已知可接受的"引用不到" —— 人工复核过：要么是外部程序（npm.cmd / arkcli.cmd），',
    '# 要么是文档里的举例路径（src/a.ts）。**只许变少，不许变多。**',
    '# 生成：node scripts/export-open.mjs --baseline'
  ]
  writeFileSync(BASELINE_FILE, header.join('\n') + '\n' + [...set].sort().join('\n') + '\n', 'utf8')
  return { file: BASELINE_FILE, count: set.size }
}

// ────────────────────────────────────────────────────────────────────── main

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const a = process.argv.slice(2)
  const has = n => a.includes('--' + n)
  const opt = (n, d = null) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] ?? d : d }
  const brief = (d) => {
    const tag = d.state === 'green' ? '✅ 可导可发' : (d.state === 'red' ? '🔴 有害，不许导' : '🟡 能导，但不许发')
    console.log(`[导出体检] ${tag}　文件 ${d.counts.files} / mjs ${d.counts.mjs}` +
      ` / 语法错 ${d.counts.syntaxErrors} / 密钥 ${d.counts.secrets}` +
      ` / 缺件 ${d.counts.gaps} / 漏配 ${d.counts.warns} / 本机痕迹 ${d.counts.pathHits}`)
    for (const e of d.syntaxErrors) console.log(`  ✗ 语法 ${e.file}: ${e.why}`)
    for (const e of d.secrets) console.log(`  ✗ 密钥 ${e.file}:${e.line ?? '?'}［${e.kind}］${e.sample}`)
    for (const e of d.gaps.slice(0, 30)) console.log(`  ✗ ${e.kind}　${e.file}　${e.why}`)
    for (const e of d.warns.slice(0, 15)) console.log(`  ⚠ 扩展名漏配 ${e.ext} ×${e.count}（${e.files.join(', ')}）`)
    for (const e of d.pathHits.slice(0, 60)) console.log(`  ⚠ 本机痕迹 ${e.file}:${e.line ?? '?'}［${e.kind}］${e.sample}`)
  }
  try {
    if (has('baseline')) {
      const r = writeBaseline()
      console.log(`[基线] ✅ 写入 ${r.count} 条 → ${r.file}`)
      process.exit(0)
    }
    if (has('doctor')) {
      const d = doctor()
      if (has('json')) console.log(JSON.stringify(d, null, 2))
      else brief(d)
      if (!d.ok) process.exit(3)
      process.exit(has('strict') && d.state !== 'green' ? 4 : 0)
    }
    if (has('verify')) {
      const v = verifyExport(opt('verify'))
      console.log(has('json') ? JSON.stringify(v, null, 2) : `[导出核对] ${v.ok ? '✅ 一致' : '❌ 不一致'}（${v.files ?? 0} 个文件）`)
      for (const b of v.bad ?? []) console.log(`  ✗ ${b}`)
      process.exit(v.ok ? 0 : 3)
    }
    const to = opt('to')
    if (!to) { console.error('用法：export-open.mjs --to <dir> | --doctor [--strict] | --verify <dir> | --baseline'); process.exit(2) }
    const r = exportTo(to, { force: has('force') })
    if (!r.ok) {
      console.error(`[导出] ❌ ${r.why}`)
      if (r.doctor) for (const e of [...r.doctor.syntaxErrors, ...r.doctor.secrets]) console.error(`  ✗ ${e.file}: ${e.why ?? e.kind}`)
      process.exit(3)
    }
    console.log(`[导出] ✅ ${r.count} 个文件 → ${r.to}`)
    console.log(`[导出]    snapshotId ${r.snapshotId}　状态 ${r.state}`)
    if (r.gaps?.length) console.log(`[导出]   ⚠️ 缺件 ${r.gaps.length}（发布前必须为 0，跑 --doctor 看明细）`)
    if (r.warns?.length) console.log(`[导出]   ⚠️ 扩展名漏配 ${r.warns.length}`)
    if (r.pathHits?.length) console.log(`[导出]   ⚠️ 本机痕迹 ${r.pathHits.length}（发布前必须为 0）`)
    process.exit(0)
  } catch (e) {
    console.error(`[导出] ❌ ${e?.stack ?? e}`)
    process.exit(1)
  }
}
