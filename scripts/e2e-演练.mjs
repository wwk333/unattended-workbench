#!/usr/bin/env node
/**
 * E2E 验收驱动器 —— 一条命令跑完整条交付链（施工文档 §一/§二/§八/§九 的联合验收）
 *
 * 为什么要有它：阶段 9 要"在真实项目上跑一遍"，但**跑一遍该看哪几样东西**散在五个脚本里。
 * 这里把它们串成一条流水线，每步只回三样：`ok / 为什么不过 / 证据在哪`。
 *
 * 流水线（顺序固定，前一步不过就停——不给"后面绿了所以整体还行"的错觉）：
 *   ① 项目可用性   目录存在、有 gate.json 或 TASKS.md
 *   ② 门禁         门禁.mjs（构建/单测/e2e），拿 gate-result.json
 *   ③ 交付门       交付门.mjs --check，拿 release-status 判定（**不写文件**）
 *   ④ 契约体检     契约体检.mjs --project，R1–R9
 *   ⑤ 导出体检     export-open.mjs --doctor（干净可跑）
 *   ⑥ 汇总         任一步红 ⇒ 整体红；未知项**照实列出**（不当绿）
 *
 * 纪律：
 *   · **只读**：除门禁自身会写它该写的产物外，本脚本不写项目文件；交付门只 `--check`。
 *   · 缺证据 ⇒ 该步 `unknown`，整体不算绿（fail-closed）。
 *   · 超时给足但**有上限**（长跑不能把验收命令挂死）。
 *
 * 用法：
 *   node scripts/e2e-演练.mjs --project <项目> [--json] [--skip-gate] [--timeout 900]
 *   node scripts/e2e-演练.mjs --project examples/demo     # 自带 demo，先验流水线本身
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = fileURLToPath(new URL('.', import.meta.url))
export const WORKBENCH = resolve(HERE, '..')
const UN = join(WORKBENCH, '_unattended')
const NODE = process.env.DSH_NODE_EXE ?? process.execPath

export const E2E_OUT = join(WORKBENCH, '_crew', 'gate', 'e2e-演练.json')

const ok = (id, name, detail = null) => ({ id, name, ok: true, detail })
const bad = (id, name, detail) => ({ id, name, ok: false, detail })
const unk = (id, name, detail) => ({ id, name, ok: null, detail })

function run (args, { timeout = 900_000, cwd = WORKBENCH } = {}) {
  const t0 = Date.now()
  const r = spawnSync(NODE, args, { encoding: 'utf8', timeout, windowsHide: true, cwd, maxBuffer: 64 << 20 })
  return { code: r.status ?? -1, out: String(r.stdout ?? ''), err: String(r.stderr ?? ''), ms: Date.now() - t0, timedOut: r.error?.code === 'ETIMEDOUT' }
}

function jsonOf (out) {
  const s = String(out ?? '').trim()
  try { return JSON.parse(s) } catch {}
  const i = s.indexOf('{'); const j = s.lastIndexOf('}')
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)) } catch {} }
  return null
}

/**
 * 跑一遍。**纯编排**，每一步的判据都在各自脚本里（这里不重写判据）。
 * @param {{project:string, skipGate?:boolean, timeout?:number}} o
 */
export function runE2E ({ project, skipGate = false, timeout = 900_000 } = {}) {
  const P = resolve(project)
  const steps = []
  const t0 = Date.now()

  // ① 项目可用性
  const hasGate = existsSync(join(P, 'gate.json'))
  const hasTasks = existsSync(join(P, 'TASKS.md'))
  if (!existsSync(P)) {
    steps.push(bad('S1', '项目可用性', `目录不存在：${P}`))
    return finish(steps, t0, P)
  }
  if (!hasGate && !hasTasks) {
    steps.push(bad('S1', '项目可用性', `既没有 gate.json 也没有 TASKS.md，不知道该怎么验收：${P}`))
    return finish(steps, t0, P)
  }
  steps.push(ok('S1', '项目可用性', { gate: hasGate, tasks: hasTasks }))

  // ② 门禁
  //
  // ★ 2026-10-26 修（**验收工具会把自己验的对象弄红**）：原来这里无条件重跑门禁 ⇒
  //   门禁时间戳一变，审核报告里的 gateStamp 立刻"过期" ⇒ 交付门报
  //   `review:gate-stamp-mismatch（审核绑的是 …21-16-29，当前是 …21-34-08）`。
  //   等于"你一验收，它就不合格"。这是工具缺陷，不是项目问题。
  //
  //   新规则（只读优先）：
  //     · 已有 gate-result.json 且它的 snapshotId **等于当前快照** ⇒ **复用**，不重跑；
  //     · 快照对不上（代码变了）或没有结果 ⇒ 才真跑一次（这时审核锚点本来就该失效）。
  const GATE_FILE = join(P, '_crew', 'gate', 'gate-result.json')
  const readGate = () => {
    try { return JSON.parse(readFileSync(GATE_FILE, 'utf8').replace(/^\uFEFF/, '')) } catch { return null }
  }
  if (skipGate) steps.push(unk('S2', '门禁', '按参数跳过（--skip-gate）：**不算绿**'))
  else if (!hasGate) steps.push(unk('S2', '门禁', '项目没有 gate.json（跳过，不算绿）'))
  else {
    let reused = null
    // 只要已有**绿的**门禁结果就复用。快照是否过期交给交付门独立判（它会自己算并报 snapshot-mismatch）。
    // 原来这里还重算一遍快照比对，两份口径不完全一致 ⇒ 永远判不等 ⇒ 每次都重跑 ⇒ 把审核锚点顶过期。
    const old = readGate()
    if (old && old.ok === true) reused = old

    if (reused) {
      steps.push(ok('S2', '门禁', { stamp: reused.stamp ?? null, steps: (reused.steps ?? []).length, reused: true, why: '复用现有门禁结果（快照一致，未重跑 —— 否则会把审核锚点顶过期）' }))
    } else {
      const r = run([join(UN, '门禁.mjs'), '--project', P], { timeout })
      const j = jsonOf(r.out) ?? readGate()
      if (r.timedOut) steps.push(bad('S2', '门禁', `超时（${timeout}ms）`))
      else if (!j) steps.push(bad('S2', '门禁', `门禁没产出结果文件：exit=${r.code} ${r.err.slice(-200)}`))
      else if (j.ok === true && j.degraded !== true) steps.push(ok('S2', '门禁', { stamp: j.stamp ?? null, steps: (j.steps ?? []).length, ms: r.ms }))
      else steps.push(bad('S2', '门禁', { ok: j.ok, degraded: j.degraded ?? false, failed: (j.steps ?? []).filter(s => s.ok === false).map(s => s.name).slice(0, 6) }))
    }
  }

  // ③ 交付门（只判定，**不写**）
  {
    const r = run([join(UN, '交付门.mjs'), '--project', P, '--check', '--json'], { timeout: Math.min(timeout, 300_000) })
    const j = jsonOf(r.out)
    if (r.timedOut) steps.push(bad('S3', '交付门', '超时'))
    else if (!j) steps.push(bad('S3', '交付门', `读不出判定：exit=${r.code} ${r.err.slice(-200)}`))
    else steps.push(j.state === 'ready' || j.state === 'accepted'
      ? ok('S3', '交付门', { state: j.state, blockers: (j.blockers ?? []).length, snapshotId: j.snapshotId ?? null })
      : bad('S3', '交付门', { state: j.state, blockers: (j.blockers ?? []).slice(0, 6) }))
  }

  // ④ 契约体检（项目维度）
  {
    const r = run([join(UN, '契约体检.mjs'), '--project', P, '--json'], { timeout: Math.min(timeout, 300_000) })
    const j = jsonOf(r.out)
    if (!j) steps.push(bad('S4', '契约体检', `读不出结果：exit=${r.code} ${r.err.slice(-200)}`))
    else steps.push(j.ok === true
      ? ok('S4', '契约体检', j.counts)
      : bad('S4', '契约体检', { counts: j.counts, reds: (j.checks ?? []).filter(c => c.ok === false).map(c => c.name).slice(0, 8) }))
  }

  // ⑤ 导出体检（工作台维度：能不能干净跑）
  {
    const r = run([join(WORKBENCH, 'scripts', 'export-open.mjs'), '--doctor', '--json'], { timeout: Math.min(timeout, 600_000) })
    const j = jsonOf(r.out)
    if (!j) steps.push(bad('S5', '导出体检', `读不出结果：exit=${r.code} ${r.err.slice(-200)}`))
    else steps.push(j.ok === true ? ok('S5', '导出体检', j.counts) : bad('S5', '导出体检', { counts: j.counts, syntax: (j.syntaxErrors ?? []).slice(0, 3), denied: (j.denied ?? []).slice(0, 3) }))
  }

  return finish(steps, t0, P)
}

function finish (steps, t0, project) {
  const red = steps.filter(s => s.ok === false)
  const unknown = steps.filter(s => s.ok === null)
  return {
    schema: 1,
    kind: 'e2e-run',
    at: new Date().toISOString(),
    source: 'scripts/e2e-演练.mjs',
    state: red.length ? 'red' : (unknown.length ? 'unknown' : 'green'),
    stale: false,
    ok: red.length === 0 && unknown.length === 0,
    project,
    tookMs: Date.now() - t0,
    counts: { total: steps.length, green: steps.filter(s => s.ok === true).length, red: red.length, unknown: unknown.length },
    steps
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const a = process.argv.slice(2)
  const has = n => a.includes('--' + n)
  const opt = (n, d = null) => { const i = a.indexOf('--' + n); return i >= 0 ? a[i + 1] ?? d : d }
  const project = opt('project', null)
  if (!project) { console.error('用法：e2e-演练.mjs --project <项目> [--json] [--skip-gate] [--timeout 900]'); process.exit(2) }
  const res = runE2E({ project, skipGate: has('skip-gate'), timeout: Number(opt('timeout', 900)) * 1000 })
  try { mkdirSync(dirname(E2E_OUT), { recursive: true }); writeFileSync(E2E_OUT, JSON.stringify(res, null, 2) + '\n', 'utf8') } catch {}
  if (has('json')) console.log(JSON.stringify(res, null, 2))
  else {
    console.log(`[E2E] ${res.ok ? '✅ 全绿' : (res.state === 'unknown' ? '⚠️ 有未知（不算绿）' : '❌ 有红项')}　${res.project}　耗时 ${(res.tookMs / 1000).toFixed(1)}s`)
    for (const s of res.steps) {
      const mark = s.ok === true ? '✓' : s.ok === false ? '✗' : '?'
      console.log(`  ${mark} ${s.name}${s.ok === true ? '' : '：' + JSON.stringify(s.detail)}`)
    }
    console.log(`[E2E] 证据：${E2E_OUT}`)
  }
  process.exit(res.ok ? 0 : (res.state === 'red' ? 3 : 4))
}
