#!/usr/bin/env node
/**
 * 留痕看护（D10）—— **不拦权限，只记账**。
 *
 * 前提（用户口径）：**大脑是最高权限，不限制它写任何东西**；
 *   要解决的只是"它说改回去了、实际没改"这类**对不上账**的情况。
 *
 * 两类写入分开记（施工文档 D10 表）：
 *   · **本职写入**：坑库（`知识库\AI知识库\坑\`）、HANDOFF / AUDIT / 台账 / 任务卡 —— **记录，不算异常**
 *   · **需报备写入**：`策划方案.md`、`项目管理.md`、契约、给用户的说明文档 —— **记录 + 快照 + 报告单列一节**
 *
 * 机制：只看**用户区文本**（.md/.txt/.json/.yaml），不看代码/图片；每 2 秒查 mtime+大小；
 *   变了就把**变之前那一版**落盘 + 记一条 `actions.jsonl`。
 *
 * 存储与上限（防无限膨胀）：
 *   `_crew\backup\userdocs\<哈希前8位>\<原路径>`（按内容去重，回到原样只占一份）
 *   每文件最多 5 个版本 / 保留 30 天 / 总量 200 MB（超了从最旧的删）/ 单文件 > 2 MB 只记哈希不存快照
 *
 * ⚠️ 归因只写"疑似"：看护只看得到文件变了，看不到谁改的；`actor_hint` 按时间窗关联当时活跃的会话/载体，
 *   **不写成定论**（昨天"记到 T1-01 卡头上"就是硬归因翻车）。
 *
 * 用法：
 *   node 留痕看护.mjs --project <项目> [--once] [--interval 2]
 *   node 留痕看护.mjs --project <项目> --report      # 人话一页（按"需报备/本职"分节）
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WS = resolve(HERE, '..')
const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const has = (n) => argv.includes('--' + n)

const PROJECT = resolve(opt('project', process.env.DSH_ACTIVE_PROJECT ?? WS))
const INTERVAL = Math.max(1, Number(opt('interval', 2)))
const CREW = join(PROJECT, '_crew')
const BACKUP = join(CREW, 'backup', 'userdocs')
const ACTIONS = join(CREW, 'actions.jsonl')
const INDEX = join(CREW, '留痕索引.json')

const LIMITS = { perFile: 5, keepDays: 30, totalMB: 200, maxSnapshotMB: 2 }

/** 只看用户区文本（代码/图片/依赖不动）。 */
const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml)$/i
/** 不看的目录（工具缓存 / 依赖 / 编排自己的记录）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.obsidian', '.trash', '.next', '__pycache__', '.venv', 'venv'])
/** 本职写入（规矩书写明所有角色都必须写）→ 记录，不算异常。 */
const DUTY_PATTERNS = [
  /(^|[\\/])HANDOFF\.md$/i, /(^|[\\/])AUDIT\.md$/i, /(^|[\\/])TASKS\.md$/i, /(^|[\\/])TASKS-.*\.md$/i,
  /(^|[\\/])进度\.md$/i, /^_crew[\\/]/i, /^证据[\\/]/i,
  /知识库[\\/]AI知识库[\\/]坑[\\/]/i, /[\\/]坑[\\/]/
]
/** 需报备写入（改了要说一声的那类）。 */
const NOTIFY_PATTERNS = [/策划方案/i, /项目管理/i, /CONTRACT.*\.md$/i, /PROJECT_BLUEPRINT\.md$/i, /分工表\.md$/i, /契约.*\.md$/i]

function classify (rel) {
  const r = String(rel).replace(/\\/g, '/')
  for (const re of NOTIFY_PATTERNS) if (re.test(r)) return 'notify'
  for (const re of DUTY_PATTERNS) if (re.test(r)) return 'duty'
  return 'other'
}

const sha = (buf) => createHash('sha256').update(buf).digest('hex')
const readJson = (p, d = null) => { try { return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) } catch { return d } }
const writeJson = (p, o) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, JSON.stringify(o, null, 2) + '\n', 'utf8') }

/** 走一遍项目，列出用户区文本文件（跳过依赖/缓存）。 */
function walk (root, out = [], depth = 0) {
  if (depth > 6) return out
  let ents = []
  try { ents = readdirSync(root, { withFileTypes: true }) } catch { return out }
  for (const e of ents) {
    if (e.name.startsWith('.') && e.name !== '.' && !/^\.env$/i.test(e.name)) {
      if (SKIP_DIRS.has(e.name)) continue
    }
    const p = join(root, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue
      if (e.name === 'backup' && root.replace(/\\/g, '/').endsWith('_crew')) continue
      walk(p, out, depth + 1)
    } else if (TEXT_EXT.test(e.name)) {
      out.push(p)
    }
  }
  return out
}

function snapshotPath (hash, rel) {
  return join(BACKUP, hash.slice(0, 8), rel.replace(/^[\\/]+/, ''))
}

/** 清理：每文件最多 5 版 / 30 天 / 总 200MB（超了从最旧的删）。 */
function prune (index) {
  const now = Date.now()
  let total = 0
  const all = []
  for (const [rel, ent] of Object.entries(index.files ?? {})) {
    ent.versions = (ent.versions ?? []).filter(v => {
      const age = (now - Date.parse(v.at ?? '')) / 86400000
      if (Number.isFinite(age) && age > LIMITS.keepDays) { try { rmSync(v.snapshot, { force: true }) } catch {} ; return false }
      return true
    }).slice(-LIMITS.perFile)
    for (const v of ent.versions) { try { total += statSync(v.snapshot).size } catch {} ; all.push({ rel, v }) }
  }
  if (total > LIMITS.totalMB * 1024 * 1024) {
    all.sort((a, b) => String(a.v.at).localeCompare(String(b.v.at)))
    for (const x of all) {
      if (total <= LIMITS.totalMB * 1024 * 1024) break
      let sz = 0
      try { sz = statSync(x.v.snapshot).size } catch { continue }
      try { rmSync(x.v.snapshot, { force: true }) } catch { continue }
      total -= sz
      const ent = index.files[x.rel]
      if (ent) ent.versions = ent.versions.filter(v => v.snapshot !== x.v.snapshot)
    }
  }
  return { totalBytes: total }
}

/** 一条留痕（D10 里那条样例的形状）。 */
function record ({ rel, beforeHash, afterHash, delta, snapshot, kind, actorHint, bytes }) {
  const rec = {
    at: new Date().toISOString(),
    path: rel.replace(/\\/g, '/'),
    before: beforeHash,
    after: afterHash,
    delta,
    snapshot: snapshot ? relative(PROJECT, snapshot).replace(/\\/g, '/') : null,
    bytes,
    kind,                                        // duty / notify / other
    actor_hint: actorHint ?? null,
    note: kind === 'notify' ? '需报备写入：记录 + 快照，报告里单列一节' : (kind === 'duty' ? '本职写入：记录即可，不算异常' : '其它文本：记录')
  }
  try {
    mkdirSync(CREW, { recursive: true })
    appendFileSync(ACTIONS, JSON.stringify(rec) + '\n', 'utf8')
  } catch {}
  return rec
}

/** 归因只写"疑似"：看 `_crew\running\*.json` 与账本最近 15 分钟里谁在跑。 */
function actorHint (project) {  const now = Date.now()
  const bits = []
  try {
    const dir = join(project, '_crew', 'running')
    for (const f of readdirSync(dir).filter(x => x.endsWith('.json'))) {
      const j = readJson(join(dir, f), null)
      if (!j) continue
      bits.push(`${j.role ?? '?'}/${j.cardId ?? '?'}（pid ${j.childPid ?? '?'}，${j.startedAt ?? '?'} 起）`)
    }
  } catch {}
  try {
    const led = readJson(join(WS, '_crew', 'ledger.json'), { calls: [] })
    for (const c of (led.calls ?? []).slice(-6)) {
      const t = Date.parse(c.at ?? '')
      if (Number.isFinite(t) && now - t < 15 * 60000) bits.push(`${c.role ?? '?'}/${c.task ?? '?'}（${c.at}）`)
    }
  } catch {}
  return bits.length ? `疑似：${bits.slice(0, 3).join('、')}（按时间窗关联，**不是定论**）` : null
}

function loop () {
  const index = readJson(INDEX, null) ?? { schema: 1, files: {} }
  const seen = new Map()
  for (const p of walk(PROJECT)) {
    let st
    try { st = statSync(p) } catch { continue }
    if (!st.isFile()) continue
    const rel = relative(PROJECT, p)
    seen.set(rel, { size: st.size, mtimeMs: st.mtimeMs })
    const ent = index.files[rel] ?? { hash: null, versions: [], at: null }
    // 首次见：记基线（**同时存一份基线快照** —— 否则第一次改动时"变之前那一版"根本没处可找，
    //   `delta` 与"可还原"两件事都会落空；实测就是这么发现漏了基线的）
    if (!ent.hash) {
      try {
        const buf = readFileSync(p)
        ent.hash = sha(buf)
        ent.at = new Date().toISOString()
        if (buf.length <= LIMITS.maxSnapshotMB * 1024 * 1024) {
          const target = snapshotPath(ent.hash, rel)
          mkdirSync(dirname(target), { recursive: true })
          if (!existsSync(target)) writeFileSync(target, buf)
          ent.versions = [{ at: ent.at, hash: ent.hash, snapshot: target, bytes: buf.length, baseline: true }]
        } else {
          ent.versions = [{ at: ent.at, hash: ent.hash, snapshot: null, bytes: buf.length, baseline: true, note: '超过 2MB：只记哈希，不存快照' }]
        }
      } catch { continue }
      index.files[rel] = ent
      continue
    }
    const cached = index._stat?.[rel]
    if (cached && cached.size === st.size && cached.mtimeMs === st.mtimeMs) continue   // 便宜路径：没变
    let buf = null
    try { buf = readFileSync(p) } catch { continue }
    const h = sha(buf)
    if (h === ent.hash) continue                                                      // 内容回到原样 ⇒ 不记
    const beforeBuf = (() => {
      // 把"变之前那一版"存下来：优先用 index 里最近一份快照；没有就存不了（首次基线除外）
      const last = (ent.versions ?? []).slice(-1)[0]
      if (last?.snapshot && existsSync(last.snapshot)) { try { return readFileSync(last.snapshot) } catch { return null } }
      return null
    })()
    const kind = classify(rel)
    let snapshot = null
    if (st.size <= LIMITS.maxSnapshotMB * 1024 * 1024 && beforeBuf) {
      const target = snapshotPath(ent.hash, rel)
      try {
        mkdirSync(dirname(target), { recursive: true })
        if (!existsSync(target)) writeFileSync(target, beforeBuf)
        snapshot = target
      } catch { snapshot = null }
    }
    const deltaLines = beforeBuf ? countDelta(beforeBuf.toString('utf8'), buf.toString('utf8')) : null
    ent.versions = [...(ent.versions ?? []), { at: new Date().toISOString(), hash: ent.hash, snapshot, bytes: beforeBuf?.length ?? null }].slice(-LIMITS.perFile)
    ent.hash = h
    ent.at = new Date().toISOString()
    index.files[rel] = ent
    record({ rel, beforeHash: ent.versions.slice(-1)[0]?.hash ?? null, afterHash: h, delta: deltaLines, snapshot, kind, actorHint: actorHint(PROJECT), bytes: st.size })
    try { console.log(`[留痕] ${rel} → ${kind === 'notify' ? '**需报备**' : kind === 'duty' ? '本职写入' : '其它'}${deltaLines ? `（${deltaLines}）` : ''}`) } catch {}
  }
  // 记住 stat 快照（便宜路径）；文件消失的条目留着（历史留痕不删）
  index._stat = Object.fromEntries(seen)
  const pr = prune(index)
  index.pruned = { at: new Date().toISOString(), totalBytes: pr.totalBytes }
  writeJson(INDEX, index)
}

/** 行数差（给人看的 `delta`）。 */
function countDelta (a, b) {
  const la = String(a).split(/\r?\n/).length
  const lb = String(b).split(/\r?\n/).length
  const d = lb - la
  if (d === 0) return '行数不变'
  return (d > 0 ? '+' : '') + d + ' 行'
}

/** 人话一页：按"需报备 / 本职 / 其它"分节（D10：报告里单列一节）。 */
function report () {
  const lines = []
  let all = []
  try { all = readFileSync(ACTIONS, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean) } catch { all = [] }
  const notify = all.filter(x => x.kind === 'notify')
  const duty = all.filter(x => x.kind === 'duty')
  const other = all.filter(x => x.kind === 'other')
  lines.push(`# 留痕报告（${PROJECT}）`)
  lines.push('')
  lines.push(`> 共 ${all.length} 条变动记录：**需报备 ${notify.length}** / 本职写入 ${duty.length} / 其它 ${other.length}`)
  lines.push('> 口径：**不拦权限，只记账**。归因写"疑似"，不是定论。')
  lines.push('')
  lines.push('## 一、需报备写入（改了要说一声的那类）')
  if (!notify.length) lines.push('（无）')
  else for (const x of notify.slice(-40)) lines.push(`- \`${x.path}\`　${String(x.at).slice(0, 19).replace('T', ' ')}　${x.delta ?? ''}${x.snapshot ? `　快照 \`${x.snapshot}\`` : ''}${x.actor_hint ? `\n  - ${x.actor_hint}` : ''}`)
  lines.push('')
  lines.push('## 二、本职写入（坑库 / HANDOFF / 台账 / 任务卡 —— 不算异常）')
  if (!duty.length) lines.push('（无）')
  else lines.push(`共 ${duty.length} 次，最近 5 条：` + duty.slice(-5).map(x => `\`${x.path}\``).join('、'))
  lines.push('')
  lines.push(`> 明细：\`${relative(PROJECT, ACTIONS)}\`　快照：\`${relative(PROJECT, BACKUP)}\``)
  return lines.join('\n') + '\n'
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

/**
 * ★ D22：给"越界归属"查一条留痕记录 —— 这个文件在某个时间窗里**谁改过**。
 * 施工文档 D11 原文就是"从 `actions.jsonl` 取 actor"；这一支以前只写不读，现在给越界判定用。
 * @param {string} project 项目根
 * @param {string} relPath 相对路径（对齐 records 里的 `path` 口径：正斜杠）
 * @param {{since?:number, until?:number, windowMs?:number}} opts 时间窗（毫秒时间戳）
 * @returns {{at:string, path:string, kind:string, actor_hint:string|null, snapshot:string|null, delta:any}|null}
 */
export function query (project, relPath, { since = null, until = null, windowMs = 60_000 } = {}) {
  const file = join(project, '_crew', 'actions.jsonl')
  if (!existsSync(file)) return null
  const want = String(relPath ?? '').replace(/\\/g, '/').toLowerCase()
  if (!want) return null
  let rows = []
  try {
    rows = readFileSync(file, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/).filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return null }
  const lo = since != null ? since - windowMs : null
  const hi = until != null ? until + windowMs : null
  let best = null
  for (const r of rows) {
    if (String(r.path ?? '').replace(/\\/g, '/').toLowerCase() !== want) continue
    const t = Date.parse(r.at)
    if (Number.isFinite(t)) {
      if (lo != null && t < lo) continue
      if (hi != null && t > hi) continue
    }
    if (!best || String(r.at) > String(best.at)) best = r
  }
  return best
}

if (isMain) {
  if (has('report')) { process.stdout.write(report()) }
  else if (has('once')) { loop(); console.log(`[留痕] 单次巡检完成（索引 ${relative(PROJECT, INDEX)}）`) }
  else {
    console.log(`[留痕] 开始看护：${PROJECT}（每 ${INTERVAL} 秒一轮；Ctrl+C 停）`)
    loop()
    const t = setInterval(() => { try { loop() } catch (e) { console.log('[留痕] 本轮出错（已忽略）：' + String(e?.message ?? e)) } }, INTERVAL * 1000)
    t.unref?.()
  }
}
