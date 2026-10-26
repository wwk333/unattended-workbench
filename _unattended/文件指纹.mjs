#!/usr/bin/env node
/**
 * 文件指纹 —— "不用 git 也能有硬证据"的那套痕迹（`01-架构.md` §6.6 / `02-产物与规格.md` §1）。
 *
 * 干什么：派活前扫一遍项目目录、收活后再扫一遍，出**新增 / 改动 / 删除**三个清单。
 *         纯脚本、零 token、**不进任何 prompt**（只有"越界/多改"的路径清单会在触发条件成立时进审核卡）。
 *
 * 落点：`<项目>\_crew\fingerprints\<ID>.before.json` / `<ID>.after.json` / `<ID>.diff.json`
 *
 * 用法：
 *   node 文件指纹.mjs snap --project <目录> --id <ID> --phase before|after [--json] [--cap 5000]
 *   node 文件指纹.mjs diff --project <目录> --id <ID> [--allow "src/**,tests/**"] [--json]
 *
 * 纪律（照规格，别自己发挥）：
 *   · 记录**相对路径 + 大小 + mtime + sha256**；排除 `node_modules` / `.git` / `dist` / 虚拟环境等；
 *   · **文件数超上限就降级**为"只记大小+mtime"（不哈希）并告警 —— 宁可粗一点，也不能把派活卡在这里；
 *   · 大文件（>8MB）不哈希，只记大小+mtime，并标 `big: true`；
 *   · **不跟随符号链接**（跟随会走出项目边界，指纹就没意义了）。
 */
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const argv = process.argv.slice(2)
const cmd = argv[0]
const has = (n) => argv.includes('--' + n)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }

const PROJECT = opt('project') ? resolve(opt('project')) : null
const ID = opt('id')
const PHASE = opt('phase', 'before')
const CAP = Number(opt('cap') ?? 5000)
const JSON_OUT = has('json')
const ALLOW = (opt('allow') ?? '').split(',').map(s => s.trim()).filter(Boolean)

// ★ b197（M6-10 第 1 件）：排除清单**搬到 `_排除清单.mjs`**（唯一一处定义）——
//   因为"回放验收脚本"要复现同一套规则，抄一份就会漂。这份清单的来龙去脉与红线说明都写在那个文件里。
import { SKIP_DIRS, SKIP_RELS, shouldSkipDir, shouldSkipFile } from './_排除清单.mjs'
const BIG = 8 * 1024 * 1024

if (!cmd || !PROJECT) {
  console.error('用法：文件指纹.mjs snap|diff --project <目录> --id <ID> [--phase before|after] [--allow "src/**"]'
    + ' | backup --project <目录> --id <ID> --paths "路径1,路径2" | restore --project <目录> --id <ID> [--from <备份目录名>] | list --project <目录>')
  process.exit(2)
}
// `snap` / `diff` 必须有 --id（它们按 id 落 before/after/diff 三份文件）；backup/restore/list 各有自己的校验。
if ((cmd === 'snap' || cmd === 'diff') && !ID) { console.error(`[指纹] ${cmd} 需要 --id`); process.exit(2) }
if (!existsSync(PROJECT)) { console.error(`项目目录不存在：${PROJECT}`); process.exit(2) }

const FP_DIR = join(PROJECT, '_crew', 'fingerprints')
mkdirSync(FP_DIR, { recursive: true })
const fileFor = (phase) => join(FP_DIR, `${ID}.${phase}.json`)

function walk (root) {
  const out = []
  const stack = ['']
  while (stack.length) {
    const rel = stack.pop()
    const abs = rel ? join(root, rel) : root
    let entries
    try { entries = readdirSync(abs, { withFileTypes: true }) } catch { continue }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name
      if (e.isSymbolicLink()) continue           // ★ 不跟随符号链接
      if (e.isDirectory()) { if (!shouldSkipDir(e.name, childRel)) stack.push(childRel); continue }
      if (!e.isFile()) continue
      if (shouldSkipFile(childRel)) continue      // ★ b197：编排自己/工具链写的文件（见 SKIP_FILES）
      out.push(childRel)
      if (out.length > CAP * 2) return out       // 早停：已经注定降级，别白扫
    }
  }
  return out
}

function sha256 (abs) {
  try { return createHash('sha256').update(readFileSync(abs)).digest('hex') } catch { return null }
}

function snap () {
  const started = Date.now()
  const rels = walk(PROJECT).sort()
  const degraded = rels.length > CAP
  const keep = degraded ? rels.slice(0, CAP) : rels
  /** @type {Record<string, {size:number, mtimeMs:number, sha256?:string, big?:boolean}>} */
  const files = {}
  for (const rel of keep) {
    const abs = join(PROJECT, rel)
    let st
    try { st = statSync(abs) } catch { continue }
    const item = { size: st.size, mtimeMs: Math.round(st.mtimeMs) }
    if (!degraded && st.size <= BIG) { const h = sha256(abs); if (h) item.sha256 = h; else item.big = true }
    else if (st.size > BIG) item.big = true
    files[rel] = item
  }
  const doc = { project: PROJECT, id: ID, phase: PHASE, at: new Date().toISOString(),
    degraded, cap: CAP, scannedFiles: rels.length, kept: keep.length, tookMs: Date.now() - started, files }
  const out = fileFor(PHASE)
  writeFileSync(out, JSON.stringify(doc, null, 1), 'utf8')
  if (JSON_OUT) process.stdout.write(JSON.stringify(doc, null, 2) + '\n')
  else {
    console.log(`[指纹] ${PHASE} 快照 → ${out}`)
    console.log(`[指纹] 扫描 ${rels.length} 个文件（保留 ${keep.length}）/ ${doc.tookMs}ms${degraded ? '  ⚠️ 超上限已降级为"只记大小+mtime"' : ''}`)
  }
  if (degraded) console.log(`[指纹] ⚠️ 文件数 ${rels.length} > 上限 ${CAP} → 本次不哈希（指纹变粗，但派活不被卡住）`)
}

/** 极简 glob：只支持 `*`（不跨 `/`）与 `**`（跨 `/`）。够用，且不引依赖。
 *
 *  ★ 2026-10-06 修（三方交叉验证共同指出的"死保护"之一）：
 *    原来 `--allow "server/src"`（**目录**）被转成 `^server/src$` —— **精确匹配**，
 *    目录里的任何文件都不匹配 ⇒ **每一个正常改动都会被判"越界"**。
 *    而本工作台给审核员的白名单恰恰全是目录（`server/src`、`server/test`…），
 *    所以"越界当场抓"这条保护**方向对、实现坏**：正常修复全被误报成越界，久了就没人再看越界。
 *    现在：**没写通配符、且不像文件的条目 → 当目录，自动补 `/**`**。
 */
function globToRe (g) {
  let pat = String(g).trim().replace(/\\/g, '/')
  if (!/[*?]/.test(pat) && !/\.[a-z0-9]+$/i.test(pat)) pat = pat.replace(/\/+$/, '') + '/**'
  const esc = pat.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  return new RegExp('^' + esc.replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '$')
}
const allowRes = ALLOW.map(globToRe)

function diff () {
  const bPath = fileFor('before'); const aPath = fileFor('after')
  if (!existsSync(bPath) || !existsSync(aPath)) {
    console.error(`缺快照：${existsSync(bPath) ? '' : bPath + ' '}${existsSync(aPath) ? '' : aPath}`)
    process.exit(2)
  }
  const b = JSON.parse(readFileSync(bPath, 'utf8'))
  const a = JSON.parse(readFileSync(aPath, 'utf8'))
  const added = []; const changed = []; const removed = []
  for (const [rel, f] of Object.entries(a.files)) {
    const prev = b.files[rel]
    if (!prev) { added.push(rel); continue }
    // 有哈希比哈希；降级时（没哈希）比 size+mtime —— 口径要说清，否则会"看起来没改动"
    const same = (prev.sha256 && f.sha256) ? prev.sha256 === f.sha256 : (prev.size === f.size && prev.mtimeMs === f.mtimeMs)
    if (!same) changed.push(rel)
  }
  for (const rel of Object.keys(b.files)) if (!a.files[rel]) removed.push(rel)
  const sortRel = (x) => x.sort()
  // ★ 2026-10-06 修（第二处死保护）：**删除也要判越界**。
  //   原来只把 `added + changed` 拿去和白名单比 —— 而"删掉一个不该删的文件"恰恰是
  //   审核员/载体最容易造成**不可逆损坏**的动作（本项目不用 git、没有后悔药）。
  //   现在 `removed` 一并进越界清单；收据里 `counts.outOfScope` 也会跟着变大（编排据此告警）。
  const outOfScope = allowRes.length
    ? [...added, ...changed, ...removed].filter(rel => !allowRes.some(re => re.test(rel))).sort()
    : []
  const doc = {
    project: PROJECT, id: ID, at: new Date().toISOString(),
    before: bPath, after: aPath,
    degraded: Boolean(b.degraded || a.degraded),
    hashCompared: !(b.degraded || a.degraded),
    counts: { scannedBefore: b.scannedFiles, scannedAfter: a.scannedFiles, added: added.length, changed: changed.length, removed: removed.length, outOfScope: outOfScope.length },
    added: sortRel(added), changed: sortRel(changed), removed: sortRel(removed),
    allowed: ALLOW, outOfScope
  }
  const out = join(FP_DIR, `${ID}.diff.json`)
  writeFileSync(out, JSON.stringify(doc, null, 1), 'utf8')
  if (JSON_OUT) process.stdout.write(JSON.stringify(doc, null, 2) + '\n')
  else {
    console.log(`[指纹] 差异 → ${out}`)
    console.log(`[指纹] 新增 ${added.length} / 改动 ${changed.length} / 删除 ${removed.length}${doc.hashCompared ? '（比对 sha256）' : '（**降级比对**：只比大小+mtime）'}`)
    const show = (label, list) => { if (list.length) { console.log(`  ${label}：`); for (const r of list.slice(0, 20)) console.log(`    ${r}`); if (list.length > 20) console.log(`    …还有 ${list.length - 20} 条`) } }
    show('新增', doc.added); show('改动', doc.changed); show('删除', doc.removed)
    if (outOfScope.length) console.log(`  ⚠️ 越界（不在 --allow 白名单里）：${outOfScope.slice(0, 20).join(' / ')}`)
  }
  // 触发条件（§6.6）：改动文件数 > 5 或出现任务卡外路径 → 调用方据此决定要不要进审核卡
  const trigger = changed.length + added.length + removed.length > 5 || outOfScope.length > 0
  if (!JSON_OUT) console.log(`[指纹] 进审核卡的触发条件：${trigger ? '★ 成立（改动>5 或 有越界）' : '不成立'}`)
  process.exit(0)
}

// ---------------------------------------------------------------- 快照 / 还原（★ 2026-10-06 新增）
//
// 为什么要有它（B 方案审出来的真问题，用户 2026-10-05 定"不用 git"）：
//   **审核员现在有权改代码了** —— 而"改坏了"没有任何后悔药。用户原话的意思是：
//   修理工不能空手进金库。所以放它动手**之前**先拍一份**内容级**备份（不是哈希，是真副本），
//   出事了整份还原。**零 token、零外网**，只在本地复制文件。
//
// 用法：
//   node 文件指纹.mjs backup  --project <目录> --id <ID> --paths "server/src/a.ts,server/src/modules/b"
//   node 文件指纹.mjs restore --project <目录> --id <ID>            # 还原该 id 最近一次备份
//   node 文件指纹.mjs restore --project <目录> --id <ID> --from <备份目录名>
//   node 文件指纹.mjs list    --project <目录>
//
// 落点：`<项目>\_crew\backups\<ID>-<时间戳>\`（+ `manifest.json` 记原始相对路径）
// 纪律：① 只复制**明确列出的路径**（文件或目录），绝不整树复制（那会把 node_modules 也搬走）；
//       ② 排除 `node_modules` / `.git` / `dist` / `_crew`（备份自己别备份自己）；
//       ③ 单文件 >8MB 跳过并记进 manifest（免得把打包产物搬进来）；
//       ④ 还原是**覆盖式**：备份里有几份就覆盖几份，不动备份里没有的文件（免得误删别人刚写的）。
const BK_DIR = () => join(PROJECT, '_crew', 'backups')
// ⚠️ 排除表**复用上面那份 SKIP_DIRS**（原来我在备份段又声明了一遍 → `SyntaxError: already declared`；
//    这正是"同一份事实写两处"的老毛病，合并成一处）。
const MAX_BYTES = 8 << 20

function listFilesUnder (abs, base, out = []) {
  let st
  try { st = statSync(abs) } catch { return out }
  if (st.isFile()) { out.push(abs); return out }
  if (!st.isDirectory()) return out
  for (const name of readdirSync(abs)) {
    if (SKIP_DIRS.has(name)) continue
    listFilesUnder(join(abs, name), base, out)
  }
  return out
}

function cmdBackup () {
  if (!PROJECT || !ID) { console.error('[指纹] backup 需要 --project 与 --id'); process.exit(2) }
  const raw = opt('paths', '')
  const paths = raw.split(/[,;，；]/).map(s => s.trim()).filter(Boolean)
  if (!paths.length) { console.error('[指纹] backup 需要 --paths "路径1,路径2"（文件或目录都行）'); process.exit(2) }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dir = join(BK_DIR(), `${ID}-${stamp}`)
  const manifest = { project: PROJECT, id: ID, at: new Date().toISOString(), root: dir, requested: paths, copied: [], skipped: [], missing: [], bytes: 0 }
  let n = 0
  for (const rel of paths) {
    const abs = resolve(PROJECT, rel)
    if (!existsSync(abs)) { manifest.missing.push(rel); continue }
    for (const f of listFilesUnder(abs)) {
      const r = relative(PROJECT, f).replace(/\\/g, '/')
      let st; try { st = statSync(f) } catch { continue }
      if (st.size > MAX_BYTES) { manifest.skipped.push({ path: r, why: `>${MAX_BYTES / 1024 / 1024}MB` }); continue }
      const dst = join(dir, 'files', r)
      try {
        mkdirSync(dirname(dst), { recursive: true })
        cpSync(f, dst)
        manifest.copied.push(r); manifest.bytes += st.size; n++
      } catch (e) { manifest.skipped.push({ path: r, why: String(e?.message ?? e).slice(0, 80) }) }
    }
  }
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  console.log(`[指纹] 备份 ${n} 个文件（${(manifest.bytes / 1024).toFixed(0)} KB）→ ${dir}`)
  if (manifest.missing.length) console.log(`  ⚠️ 没找到：${manifest.missing.join(' / ')}`)
  if (manifest.skipped.length) console.log(`  ⚠️ 跳过：${manifest.skipped.map(s => s.path + '(' + s.why + ')').join(' / ')}`)
  if (JSON_OUT) process.stdout.write(JSON.stringify(manifest, null, 2) + '\n')
  process.exit(n > 0 ? 0 : 2)
}

function cmdRestore () {
  if (!PROJECT || !ID) { console.error('[指纹] restore 需要 --project 与 --id'); process.exit(2) }
  const from = opt('from', null)
  let dir = from ? join(BK_DIR(), from) : null
  if (!dir) {
    const all = existsSync(BK_DIR()) ? readdirSync(BK_DIR()).filter(d => d.startsWith(ID + '-')).sort() : []
    if (!all.length) { console.error(`[指纹] 找不到 ${ID} 的备份（${BK_DIR()}）`); process.exit(2) }
    dir = join(BK_DIR(), all[all.length - 1])
  }
  const man = join(dir, 'manifest.json')
  if (!existsSync(man)) { console.error(`[指纹] 备份缺 manifest：${man}`); process.exit(2) }
  const m = JSON.parse(readFileSync(man, 'utf8'))
  let n = 0
  for (const r of m.copied ?? []) {
    const src = join(dir, 'files', r)
    const dst = join(PROJECT, r)
    try { mkdirSync(dirname(dst), { recursive: true }); cpSync(src, dst); n++ } catch (e) { console.error(`  ⚠️ 还原失败 ${r}：${String(e?.message ?? e).slice(0, 80)}`) }
  }
  console.log(`[指纹] 已从备份还原 ${n} 个文件 ← ${dir}`)
  console.log(`[指纹] 备份时间：${m.at}　原始请求路径：${(m.requested ?? []).join(' / ')}`)
  process.exit(0)
}

function cmdList () {
  if (!PROJECT) { console.error('[指纹] list 需要 --project'); process.exit(2) }
  const d = BK_DIR()
  if (!existsSync(d)) { console.log('[指纹] 还没有任何备份'); process.exit(0) }
  for (const name of readdirSync(d).sort()) {
    const man = join(d, name, 'manifest.json')
    let info = ''
    try { const m = JSON.parse(readFileSync(man, 'utf8')); info = `${(m.copied ?? []).length} 文件 · ${((m.bytes ?? 0) / 1024).toFixed(0)} KB · id=${m.id}` } catch {}
    console.log(`  ${name}　${info}`)
  }
  process.exit(0)
}

/**
 * ★ b88（2026-10-16）：**只读扫描** —— 把"当前项目有哪些文件、各自 size/mtime/sha256"打出来，
 * **一个文件都不写**（`snap` 会往 `_crew\fingerprints\` 落盘，那是给 before/after 对照用的；
 * 「无收据改动」只是**读一眼现状**，不该污染项目）。
 *
 * 为什么要它、而不是让调用方自己 walk：**"什么算项目文件"只能有一处口径**（SKIP_DIRS / SKIP_RELS /
 * 大文件上限都在这儿）。复制一份到别处 = 两份排除表必然分叉（本项目已经栽过好几次）。
 */
function cmdScan () {
  if (!PROJECT) { console.error('[指纹] scan 需要 --project'); process.exit(2) }
  // ⚠️ **默认不哈希**（实测：2299 个文件哈希一遍 ≈ 10.6 秒）—— 而"哪些文件动过"看 **size+mtime**
  //    就够（`diff` 在降级时也是这个口径）。要逐字节比对再显式加 `--hash`（+10 秒，别在热路径上开）。
  const WANT_HASH = has('hash')
  const started = Date.now()
  const rels = walk(PROJECT).sort()
  const files = []
  let bigSkipped = 0
  let hashed = 0
  for (const rel of rels) {
    const abs = join(PROJECT, rel)
    let st
    try { st = statSync(abs) } catch { continue }
    const item = { rel, size: st.size, mtime: Math.round(st.mtimeMs) }
    if (WANT_HASH) {
      if (st.size <= BIG) { const h = sha256(abs); if (h) { item.sha256 = h; hashed++ } else item.big = true }
      else { item.big = true; bigSkipped++ }
    } else if (st.size > BIG) { item.big = true; bigSkipped++ }
    files.push(item)
  }
  const doc = {
    ok: true, kind: 'fingerprint-scan', project: PROJECT, at: new Date().toISOString(),
    hashed: WANT_HASH, scannedFiles: rels.length, hashCount: hashed, bigSkipped, tookMs: Date.now() - started,
    skip: { dirs: [...SKIP_DIRS], rels: [...SKIP_RELS], bigBytes: BIG },
    files
  }
  if (JSON_OUT) process.stdout.write(JSON.stringify(doc) + '\n')
  else {
    console.log(`[指纹] scan ${PROJECT}：${rels.length} 个文件（${WANT_HASH ? '哈希 ' + hashed : '只比 size+mtime；加 --hash 逐字节'}，跳过 >${BIG / 1024 / 1024}MB ${bigSkipped}）/${doc.tookMs}ms —— **只读，没写任何文件**`)
    for (const f of files.slice(0, 20)) console.log(`  ${f.rel}　${f.size}B　${new Date(f.mtime).toISOString().slice(0, 19)}${f.sha256 ? '　' + f.sha256.slice(0, 12) : ''}`)
    if (files.length > 20) console.log(`  …（共 ${files.length} 个，只列前 20）`)
  }
  process.exit(0)
}

switch (cmd) {
  case 'snap': snap(); break
  case 'diff': diff(); break
  case 'scan': cmdScan(); break
  case 'backup': cmdBackup(); break
  case 'restore': cmdRestore(); break
  case 'list': cmdList(); break
  default: console.error(`未知子命令：${cmd}（可用：snap / diff / scan / backup / restore / list）`); process.exit(2)
}