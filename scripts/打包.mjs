#!/usr/bin/env node
/**
 * 打包 —— 出**瘦包**与**胖包**两个 zip（W6）
 *
 * 瘦包：程序 + 示例 + 文档 + 载体钉版清单（载体在线装）
 * 胖包：瘦包 + `agents\`（4 个载体的 `node_modules` 与 `opencode.exe`，**离线可用**）
 *
 * 纪律：
 *   · 打之前**必须**过 `export-open --doctor --strict`（泄露/缺件/盘符 任一项不为 0 就不打）
 *   · 胖包只带**许可允许**的东西：`@tencent-ai/sandbox-cli*` 是 `UNLICENSED`，**永不带**（D24）
 *   · `codex` / `qoder` 没角色用，不带（D26）—— 别为了"看起来全"白加 486 MB
 *   · 产出后打印 SHA256 与体积；同时写进 `dist\SHA256SUMS.txt`
 *
 * 用法：
 *   node scripts/打包.mjs --slim --out dist
 *   node scripts/打包.mjs --fat  --agents <载体根，例：一个放 CLI 的目录> --out dist
 */
import { existsSync, mkdirSync, readdirSync, cpSync, rmSync, statSync, writeFileSync, appendFileSync, readFileSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'

// ⚠️ 必须用 fileURLToPath：`new URL(import.meta.url).pathname` 是**百分号编码**的，
//    中文目录名会变成 `%E6%97%A0…`，拼出来的路径根本不存在（实测把这个脚本坑过一次）。
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }

/** 胖包里**不许带**的（许可或"没角色用"） */
const FAT_SKIP = [
  'node_modules/@tencent-ai/sandbox-cli-win32-x64',
  'node_modules/@openai/codex-win32-x64',
  'node_modules/@openai/codex',
  'node_modules/@qodercn-ai',
  'opencode/opencode.exe.bak-2.0.21'
]
const FAT_KEEP_EXTRA = ['package.json', 'package-lock.json', 'opencode/opencode.exe']

const log = (...a) => console.log('[打包]', ...a)

function runExport (dest) {
  if (existsSync(dest)) rmSync(dest, { recursive: true, force: true })
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'export-open.mjs'), '--to', dest], { encoding: 'utf8', windowsHide: true })
  if (r.status !== 0) { console.error(String(r.stderr || r.stdout).slice(-800)); throw new Error('导出失败') }
  return dest
}

function checkStrict () {
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'export-open.mjs'), '--doctor', '--strict', '--json'], { encoding: 'utf8', windowsHide: true })
  let d = null
  try { d = JSON.parse(String(r.stdout ?? '')) } catch {}
  if (!d) throw new Error('体检没给出 JSON（先跑一次 --doctor 看看）')
  const bad = d.state !== 'green' || !d.ok
  if (bad) {
    console.error(`[打包] ❌ 体检不是 green（state=${d.state}，缺件 ${d.counts.gaps}，本机痕迹 ${d.counts.pathHits}，密钥 ${d.counts.secrets}）`)
    console.error('[打包] 发布闸不放行：先修到 ✅ 可导可发 再打包。')
    process.exit(3)
  }
  log(`体检 ✅ 可导可发（${d.counts.files} 文件）`)
}

/** 把 `agents\` 里的 4 个载体复制过去（跳过 FAT_SKIP） */
function copyAgents (agentsRoot, dest) {
  const dst = join(dest, 'agents')
  mkdirSync(dst, { recursive: true })
  for (const f of FAT_KEEP_EXTRA) {
    const src = join(agentsRoot, ...f.split('/'))
    if (!existsSync(src)) { log(`⚠️ 缺 ${f}（跳过）`); continue }
    mkdirSync(dirname(join(dst, ...f.split('/'))), { recursive: true })
    cpSync(src, join(dst, ...f.split('/')))
  }
  const nmSrc = join(agentsRoot, 'node_modules')
  const nmDst = join(dst, 'node_modules')
  let copied = 0
  const walk = (rel) => {
    const src = join(nmSrc, ...rel.split('/'))
    for (const e of readdirSync(src, { withFileTypes: true })) {
      const r = rel ? rel + '/' + e.name : e.name
      if (FAT_SKIP.some(s => ('node_modules/' + r) === s || ('node_modules/' + r).startsWith(s + '/'))) continue
      const s = join(nmSrc, ...r.split('/'))
      const d = join(nmDst, ...r.split('/'))
      if (e.isDirectory()) { mkdirSync(d, { recursive: true }); walk(r); continue }
      if (!e.isFile()) continue
      mkdirSync(dirname(d), { recursive: true })
      cpSync(s, d)
      copied++
    }
  }
  walk('')
  // 把 `agents/package.json` 的依赖改成"**包里真有的那几个**"，
  // 并把不带的原因写进去 —— 否则用户 `cd agents && npm i` 会去补 codex/qoder/sandbox-cli。
  try {
    const pjPath = join(dst, 'package.json')
    const pj = JSON.parse(readFileSync(pjPath, 'utf8'))
    const keep = Object.keys(pj.dependencies ?? {}).filter(k =>
      !k.startsWith('@openai/codex') && !k.startsWith('@qodercn-ai/') && !k.startsWith('@tencent-ai/sandbox-cli'))
    pj.dependencies = Object.fromEntries(keep.map(k => [k, pj.dependencies[k]]))
    pj._随包带了什么 = keep
    pj._没带什么 = {
      '@openai/codex': '当前无角色使用（省 416 MB）',
      '@qodercn-ai/qoderclicn': '当前无角色使用（省 70 MB）',
      '@tencent-ai/sandbox-cli-win32-x64': '它自己声明 license=UNLICENSED，不能随包分发；只是 codebuddy 的可选依赖'
    }
    pj._opencode = '不在 npm 依赖里：本是 opencode/opencode.exe，来源 @opencode/cli-windows-x64@2.0.26（MIT）'
    writeFileSync(pjPath, JSON.stringify(pj, null, 2) + '\n', 'utf8')
  } catch (e) { log(`⚠️ 改 agents/package.json 失败（不影响运行）：${String(e?.message ?? e)}`) }
  return copied
}

function zipDir (dir, zipPath) {
  if (existsSync(zipPath)) rmSync(zipPath, { force: true })
  mkdirSync(dirname(zipPath), { recursive: true })
  // bsdtar：`-a` 按扩展名选格式（.zip），`-C` 换根并只打包里面的内容（不带外层目录名）
  const r = spawnSync('tar', ['-a', '-c', '-f', zipPath, '-C', dir, '.'], { encoding: 'utf8', windowsHide: true, timeout: 30 * 60_000 })
  if (r.status !== 0) throw new Error(`tar 失败：${String(r.stderr ?? '').slice(-400)}`)
  return zipPath
}

const sha256 = (p) => createHash('sha256').update(readFileSync(p)).digest('hex')

const ver = (() => {
  try { return JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version } catch { return '0.1.0' }
})()

const main = () => {
  const outDir = resolve(opt('out', 'dist'))
  mkdirSync(outDir, { recursive: true })
  checkStrict()

  const wantSlim = has('slim') || !has('fat')
  const wantFat = has('fat')
  const sums = []

  if (wantSlim) {
    const stage = join(outDir, '.stage-slim')
    log('导出瘦包……')
    runExport(stage)
    const zip = join(outDir, `wuyunshou-v${ver}.zip`)
    log('压缩……')
    zipDir(stage, zip)
    rmSync(stage, { recursive: true, force: true })
    sums.push({ file: basename(zip), size: statSync(zip).size, sha: sha256(zip) })
  }

  if (wantFat) {
    const agentsRoot = opt('agents')
    if (!agentsRoot || !existsSync(agentsRoot)) { console.error('[打包] --fat 需要 --agents <载体根>（放 pi/codebuddy/qwen/opencode 的那个目录）'); process.exit(2) }
    const stage = join(outDir, '.stage-fat')
    log('导出瘦包部分……')
    runExport(stage)
    log('复制载体（skipped: sandbox-cli / codex / qoder）……')
    const n = copyAgents(agentsRoot, stage)
    log(`复制完成：${n} 个文件`)
    const zip = join(outDir, `wuyunshou-v${ver}-offline.zip`)
    log('压缩（大，耐心等）……')
    zipDir(stage, zip)
    rmSync(stage, { recursive: true, force: true })
    sums.push({ file: basename(zip), size: statSync(zip).size, sha: sha256(zip) })
  }

  // 清单**合并**而不是覆盖：分开跑 `--slim` 与 `--fat` 时，两行都要在
  const sumsFile = join(outDir, 'SHA256SUMS.txt')
  const prev = existsSync(sumsFile)
    ? readFileSync(sumsFile, 'utf8').split(/\r?\n/).filter(Boolean).map(l => l.trim().split(/\s+/)[1]).filter(Boolean)
    : []
  const byName = new Map()
  for (const name of prev) {
    const p = join(outDir, name)
    if (existsSync(p)) byName.set(name, `${sha256(p)}  ${name}  (${(statSync(p).size / 1048576).toFixed(1)} MB)`)
  }
  for (const s of sums) byName.set(s.file, `${s.sha}  ${s.file}  (${(s.size / 1048576).toFixed(1)} MB)`)
  const lines = [...byName.values()]
  writeFileSync(sumsFile, lines.join('\n') + '\n', 'utf8')
  console.log('\n[打包] 完成：')
  for (const l of lines) console.log('  ' + l)
  console.log(`[打包] 清单：${sumsFile}`)
}

main()
