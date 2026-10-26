#!/usr/bin/env node
/**
 * 交付门 —— **交付放行的单一真相**（施工文档 §一）
 *
 * 它只做一件事：把"能不能交付"变成一份机器可判的文件（`_crew/release-status.json`），
 * 并把它投影成 `HANDOFF.md` 的生成块。它**不写业务代码、不改任务 done、不替代状态机**。
 *
 * ## 为什么必须有它（真事）
 * 原来"门禁绿 / 审核调用成功 / 审核通过 / 用户验收 / 已交付"五个词混着用：
 * `review.ok=true` 只表示审核员这一趟调用成功了，报告正文却可能写着"打回"；
 * `HANDOFF.md` 还能手写"已交付"；而**同一份代码在审核后又被改过**，旧审核照样被引用 ——
 * 因为没有任何一处能机器回答"这是不是同一份代码"。所以这里把放行绑到**同一个 snapshotId**。
 *
 * ## 状态语义（严格照 §一）
 *   blocked  证据不齐 / 审核未过 / 快照不一致 / 门禁降级 / 未销 halt / 缺 E2E
 *   ready    机器放行，等用户验收
 *   accepted **只有用户明确说"验收通过"**后由大脑记录（大脑不得自批：`--accept` 必须带 `--by`）
 *   rejected 用户明确不通过
 *   stale    验收后代码/契约/审核报告又变了
 *
 * ## 用法
 *   node 交付门.mjs --project <P>                    # 判定 + 写 release-status.json 与 HANDOFF 生成块
 *   node 交付门.mjs --project <P> --check            # 只判定，不写任何文件
 *   node 交付门.mjs --project <P> --json             # 机器可读
 *   node 交付门.mjs --project <P> --accept --by "用户"   # 记录用户验收通过
 *   node 交付门.mjs --project <P> --reject --by "用户" --why "打回原因"
 *   node 交付门.mjs --project <P> --review <审核报告路径>  # 指定报告（默认自动找最新）
 *
 * ## 退出码
 *   0 ready/accepted · 2 blocked · 3 rejected · 4 stale · 5 用法错
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { quickScopeVerdict } from './_要害文件.mjs'
import { basename, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { computeSnapshot } from './契约/快照.mjs'
import { judgeReview, reviewReportSha, findReviewReport } from './契约/审核.mjs'
import { readJsonSafe } from './契约/读.mjs'
import { inspectEntryEvidence, resolveEvidencePath } from './契约/入口.mjs'
import { validateEnvelope } from './契约/信封.mjs'
import { assertState } from './契约/枚举.mjs'
import { readGateJson } from './_门禁入口.mjs'
import { StateClient, StateUnavailable } from './_状态客户端.mjs'

const HERE = fileURLToPath(new URL('.', import.meta.url))

export const RELEASE_KIND = 'release-status'
export const HANDOFF_BEGIN = '<!-- RELEASE-BLOCK'
export const HANDOFF_END = '<!-- /RELEASE-BLOCK -->'

const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const has = n => argv.includes('--' + n)

/** 人写的状态行（会被停用并留原话，不直接删） */
const HANDWRITTEN_STATUS = /(已交付|已验收|验收通过|交付完成|已上线|可直接交付)/

/** `--by` 是不是"大脑自己"（自批必须拒） */
const AI_ACTOR = /大脑|brain|agent|dsh|assistant|ai|模型|agent/i

// ---------------------------------------------------------------- 证据读取
// （找审核报告的实现已搬到 `契约/审核.mjs` 的 `findReviewReport` —— 编排也要用，不能有两份）

/** 从 gate-result 里拿入口 E2E 结论（新字段优先，旧字段兼容） */
export function e2eOfGate (gate, project) {
  if (!gate) return { declared: false, ok: false, why: '没有门禁结果，无法判断入口 E2E', evidence: [] }
  if (gate.e2e === null) {
    return { declared: false, ok: false, why: '项目 gate.json 没声明 kind:"e2e" 步骤（§二：必过入口验收缺失即红）', evidence: [] }
  }
  if (gate.e2e && typeof gate.e2e === 'object') {
    return {
      declared: true,
      ok: gate.e2e.ok === true,
      why: gate.e2e.ok === true ? null : '门禁里的入口 E2E 没通过',
      steps: gate.e2e.steps ?? [],
      evidence: gate.e2e.evidence ?? []
    }
  }
  return { declared: false, ok: false, why: '门禁结果里没有 e2e 段（旧格式）—— 入口验收缺证据即红', evidence: [] }
}

// ---------------------------------------------------------------- 判定

/**
 * 纯函数式判定（不写文件、不联网） —— 便于测试与复算。
 * @param {object} o
 * @returns {{ state:string, blockers:string[], details:object }}
 */
export function decide ({
  gate = null,
  gateEnvelopeOk = false,
  currentSnapshotId = null,
  review = null,
  reviewReport = null,
  e2e = null,
  openHalts = [],
  stateServiceOk = true,
  stateServiceWhy = null,
  previous = null,
  handoffDrift = null,
  entryEvidenceMissing = false,
  project = null
} = {}) {
  const blockers = []

  // ---- 门禁
  let gateScopeNote = null
  if (!gate) blockers.push('gate:missing（没有 _crew/gate/gate-result.json）')
  else {
    if (!gateEnvelopeOk) blockers.push('gate:envelope（门禁产物缺 schema/at/source/state 信封）')
    if (gate.ok !== true) blockers.push(`gate:red（${gate.summaryText ?? '红'}）`)
    if (gate.degraded === true) blockers.push('gate:degraded（降级不得放行）')
    // ★ 2026-10-26（用户拍板 C）：半套门禁**不一定拦** —— 看这一轮碰了什么。
    //   只改文案/样式/注释 ⇒ 放行；碰了入口主文件/依赖/启动器/门禁配置 ⇒ 必须全量。
    //   纪律：**放行要有正面证据**（查得到改了哪些文件且都不是要害），查不到就照旧拦。
    if (gate.scope && gate.scope !== 'all') {
      const qv = quickScopeVerdict({ project })
      if (qv.allow) {
        gateScopeNote = qv.reason
      } else {
        blockers.push(`gate:scope（只跑了 ${gate.scope}，不是全量；${qv.reason}）`)
      }
    }
    const sid = gate.snapshot?.snapshotId ?? null
    if (!sid) blockers.push('gate:snapshot-legacy（旧门禁产物没有 snapshotId，不能证明它跑的是这份代码）')
    else if (currentSnapshotId && sid !== currentSnapshotId) blockers.push(`gate:snapshot-mismatch（门禁 ${sid} ≠ 当前 ${currentSnapshotId}）`)
    if (gate.snapshot?.degraded === true) blockers.push('gate:snapshot-degraded（文件太多被降级，快照不完整）')
  }

  // ---- 入口 E2E
  if (!e2e || !e2e.declared) blockers.push(`e2e:missing（${e2e?.why ?? '没有入口验收'}）`)
  else if (!e2e.ok) blockers.push(`e2e:red（${e2e.why ?? '入口验收没过'}）`)
  if (entryEvidenceMissing) blockers.push('e2e:evidence-missing（声明的入口证据文件不在盘上）')

  // ---- 审核
  if (!reviewReport || !reviewReport.path) blockers.push('review:missing（找不到审核报告）')
  else if (review?.decision === 'unknown') blockers.push(`review:unknown（${review.why ?? '缺机器块'}）`)
  else {
    if (review?.conflict) blockers.push(`review:prose-conflict（${review.why}）`)
    else if (review?.decision !== 'pass') blockers.push(`review:${review.decision}（审核未通过）`)
    const rsid = review?.block?.snapshotId ?? null
    if (rsid && currentSnapshotId && rsid !== currentSnapshotId) blockers.push(`review:snapshot-mismatch（审核 ${rsid} ≠ 当前 ${currentSnapshotId}）`)
    const gs = review?.block?.gateStamp ?? null
    if (gs && gate?.stamp && gs !== gate.stamp) blockers.push(`review:gate-stamp-mismatch（审核绑的是门禁 ${gs}，当前是 ${gate.stamp}）`)
  }
  // 报告哈希：只在**验收之后**变动才算问题 —— 那时状态转 `stale`（§一：验收后审核报告又变 ⇒ 重新验收）。
  // 验收前重写报告是正常流程（补机器块、改结论），不该变成永久阻断；那由上面的 decision 判定兜住。

  // ---- halt / 状态服务
  if (!stateServiceOk) blockers.push(`state:unavailable（${stateServiceWhy ?? 'C 状态服务不可用'} —— fail-closed）`)
  if (openHalts.length) blockers.push(`halt:open（${openHalts.length} 条未销：${openHalts.slice(0, 3).map(h => h.reason).join('；')}）`)

  // ---- HANDOFF 漂移
  if (handoffDrift) blockers.push(`handoff:drift（${handoffDrift}）`)

  // ---- 状态
  let state
  if (previous?.state === 'accepted') {
    const sameSnapshot = previous.snapshotId && currentSnapshotId && previous.snapshotId === currentSnapshotId
    const sameReview = !previous?.review?.reportSha || !reviewReport?.sha || previous.review.reportSha === reviewReport.sha
    if (sameSnapshot && sameReview) state = 'accepted'
    else state = 'stale'
  } else if (previous?.state === 'rejected' && previous.snapshotId && previous.snapshotId === currentSnapshotId && blockers.length === 0) {
    state = 'rejected'
  } else if (blockers.length === 0) {
    state = 'ready'
  } else {
    state = 'blocked'
  }
  return { state, blockers, details: { gateStamp: gate?.stamp ?? null, gateSnapshotId: gate?.snapshot?.snapshotId ?? null } }
}

// ---------------------------------------------------------------- HANDOFF 投影

/** 生成块（人读 + 机器读同一份） */
export function renderHandoffBlock (release) {
  const zh = { blocked: '⛔ 阻断', ready: '🟡 可交付（等你验收）', accepted: '✅ 已验收', rejected: '❌ 已打回', stale: '⚠️ 已过期（代码/证据又变了）' }[release.state] ?? release.state
  const lines = [
    `${HANDOFF_BEGIN} ${JSON.stringify({ schema: 1, kind: 'release-block', generatedFrom: '_crew/release-status.json', snapshotId: release.snapshotId, state: release.state, at: release.at, source: '交付门.mjs' })} -->`,
    '',
    `## 交付状态（机器生成 · 不要手改）`,
    '',
    `- **${zh}**`,
    `- 快照：\`${release.snapshotId ?? 'unknown'}\``,
    `- 门禁：${release.gate ? `${release.gate.ok ? '绿' : '红'} · stamp=${release.gate.stamp ?? '—'} · scope=${release.gate.scope ?? '—'}${release.gate.degraded ? ' · **degraded**' : ''}` : '（缺）'}`,
    `- 审核：${release.review ? `${release.review.decision}${release.review.conflict ? '（正文冲突）' : ''} · ${release.review.reviewId ?? '—'}` : '（缺机器块）'}`,
    `- 入口 E2E：${release.e2e ? (release.e2e.ok ? '1/1 通过' : '**未通过**') : '（缺）'}`,
    release.blockers?.length ? `- 阻断项（${release.blockers.length}）：` : '- 阻断项：无',
    ...(release.blockers ?? []).map(b => `  - ${b}`),
    release.waivers?.length ? `- 例外（waiver，${release.waivers.length}）：` : null,
    ...(release.waivers ?? []).map(w => `  - ${w.by}：${w.why}`),
    '',
    `> 本块由 \`交付门.mjs\` 生成，源是 \`_crew/release-status.json\`。手改本块 ⇒ 体检失败（与源不一致）。`,
    HANDOFF_END
  ].filter(x => x !== null)
  return lines.join('\n')
}

/**
 * 把生成块写进 HANDOFF。
 * ★ 手写的"已交付/已验收"行会被**停用**（整段变成 HTML 注释，原话保留），不是直接删 ——
 *   删了就没法追责"当初谁写的"；注释掉则权威消失而事实可查。
 */
export function projectHandoff (text, release) {
  const block = renderHandoffBlock(release)
  let body = String(text ?? '')
  const beginIdx = body.indexOf(HANDOFF_BEGIN)
  const endIdx = body.indexOf(HANDOFF_END)
  if (beginIdx >= 0 && endIdx > beginIdx) {
    body = body.slice(0, beginIdx) + block + body.slice(endIdx + HANDOFF_END.length)
  } else {
    body = body.replace(/\s*$/, '') + '\n\n' + block + '\n'
  }
  // 停用块外的手写状态行
  const lines = body.split(/\r?\n/)
  let inBlock = false
  const out = []
  let disabled = 0
  for (const line of lines) {
    if (line.startsWith(HANDOFF_BEGIN)) { inBlock = true; out.push(line); continue }
    if (line.startsWith(HANDOFF_END)) { inBlock = false; out.push(line); continue }
    if (!inBlock && HANDWRITTEN_STATUS.test(line) && !/^\s*<!--/.test(line)) {
      out.push(`<!-- 手写状态已停用（改为读 release-status 生成块）：${line.replace(/-->/g, '--\\u003e').trim()} -->`)
      disabled++
      continue
    }
    out.push(line)
  }
  return { text: out.join('\n'), disabled }
}

// ---------------------------------------------------------------- 主流程

async function main () {
  const project = opt('project') ? resolve(opt('project')) : null
  if (!project) { console.error('用法：node 交付门.mjs --project <目录> [--check|--json|--accept --by 谁|--reject --by 谁]'); process.exit(5) }
  if (!existsSync(project)) { console.error(`[交付门] 项目目录不存在：${project}`); process.exit(5) }
  const t0 = Date.now()
  const checkOnly = has('check')
  const jsonOut = has('json')
  const outDir = join(project, '_crew')
  const releasePath = join(outDir, 'release-status.json')
  const handoffPath = join(project, 'HANDOFF.md')

  const previous = readJsonSafe(releasePath)
  const gateJson = readGateJson(project, project)
  const snapshot = computeSnapshot({ project, gate: gateJson?.data ?? null })

  // ---- 门禁
  const gateResultPath = join(outDir, 'gate', 'gate-result.json')
  const gate = readJsonSafe(gateResultPath)
  const gateEnvelope = gate ? validateEnvelope(gate) : { ok: false, missing: [], bad: [] }

  // ---- 审核报告
  const reviewPath = opt('review')
  const found = findReviewReport(project, reviewPath)
  let reviewText = null
  let review = null
  let reviewReport = null
  if (found.path && existsSync(found.path)) {
    reviewText = readFileSync(found.path, 'utf8')
    review = judgeReview(reviewText)
    reviewReport = { path: found.path, source: found.source, sha: reviewReportSha(reviewText), bytes: reviewText.length }
  }

  // ---- 入口证据（单独再查一次盘：门禁可能没写 e2e 段，但证据/声明在）
  const e2e = e2eOfGate(gate, project)
  let entryEvidenceMissing = false
  const declaredEvidence = new Set()
  for (const st of gateJson?.data?.steps ?? []) {
    if (String(st?.kind) === 'e2e' && st?.evidence) declaredEvidence.add(String(st.evidence))
  }
  for (const ev of declaredEvidence) {
    const p = resolveEvidencePath(project, ev)
    if (!existsSync(p)) entryEvidenceMissing = true
    else {
      const v = inspectEntryEvidence(p, { snapshotId: snapshot.snapshotId, project, requireArtifacts: true })
      if (!v.ok && e2e.ok) { e2e.ok = false; e2e.why = `门禁说 e2e 过了，但证据复验不过：${(v.errors ?? [])[0] ?? ''}` }
    }
  }

  // ---- 状态服务（fail-closed：连不上就不许放行）
  const client = new StateClient({ ensure: true })
  let openHalts = []
  let stateServiceOk = true
  let stateServiceWhy = null
  let runs = []
  let audit = null
  try {
    const h = await client.health()
    if (!h.ok || h.db?.writeOk === false) throw new StateUnavailable('health 不绿', h.db?.writeError ?? null)
    openHalts = await client.halts(project, 'open')
    runs = await client.runs({ project })
    audit = await client.audit(project)
  } catch (e) {
    stateServiceOk = false
    stateServiceWhy = e instanceof StateUnavailable ? e.message : String(e.message ?? e)
  }

  // ---- HANDOFF 漂移：生成块与上一份 release-status 不一致
  let handoffDrift = null
  if (existsSync(handoffPath) && previous) {
    const text = readFileSync(handoffPath, 'utf8')
    const m = /<!-- RELEASE-BLOCK (\{[\s\S]*?\}) -->/.exec(text)
    if (m) {
      try {
        const b = JSON.parse(m[1])
        if (b.state !== previous.state || b.snapshotId !== previous.snapshotId) {
          handoffDrift = `HANDOFF 生成块（${b.state}/${b.snapshotId}）与 release-status（${previous.state}/${previous.snapshotId}）不一致`
        }
      } catch { handoffDrift = 'HANDOFF 生成块的 JSON 坏了' }
    } else {
      handoffDrift = 'HANDOFF 里没有生成块（被删或手写覆盖）'
    }
  }

  const verdict = decide({
    project,
    gate, gateEnvelopeOk: gateEnvelope.ok, currentSnapshotId: snapshot.snapshotId,
    review, reviewReport, e2e, openHalts, stateServiceOk, stateServiceWhy,
    previous, handoffDrift, entryEvidenceMissing
  })

  // ---- 用户验收 / 打回（只有人能做；大脑自批直接拒）
  let actor = opt('by')
  let waivers = Array.isArray(previous?.waivers) ? [...previous.waivers] : []
  if (has('accept') || has('reject')) {
    if (!actor) { console.error('[交付门] ❌ --accept/--reject 必须带 --by "<谁>"（大脑不得自批）'); process.exit(5) }
    if (AI_ACTOR.test(actor) && !has('allow-ai-accept')) {
      console.error(`[交付门] ❌ "${actor}" 看起来是 AI/大脑自己 —— accepted 只能由用户明确验收后记录（要强来加 --allow-ai-accept，会留痕）`)
      process.exit(5)
    }
    if (has('accept')) {
      if (verdict.blockers.length) {
        console.error('[交付门] ❌ 还有阻断项，不能验收：')
        for (const b of verdict.blockers) console.error('   - ' + b)
        process.exit(2)
      }
      verdict.state = 'accepted'
    } else {
      verdict.state = 'rejected'
      waivers = waivers // 打回不产生 waiver
    }
  }
  const waive = opt('waive')
  if (waive) {
    if (!actor) { console.error('[交付门] ❌ --waive 必须带 --by "<谁>"（人工例外要留痕）'); process.exit(5) }
    waivers.push({ by: actor, why: waive, at: new Date().toISOString(), snapshotId: snapshot.snapshotId })
  }

  assertState('release', verdict.state)

  // ---- 时间账（只用能测到的数，测不到的写 null）
  const startedAt = runs.length ? runs.map(r => r.startedAt).sort()[0] : null
  const now = new Date()
  const actualMin = startedAt ? Math.round((now - Date.parse(startedAt)) / 60000) : null
  const timing = {
    startedAt,
    readyAt: verdict.state === 'ready' ? now.toISOString() : (previous?.timing?.readyAt ?? null),
    actualMin,
    criticalPathMin: previous?.timing?.criticalPathMin ?? null,
    waitMin: previous?.timing?.waitMin ?? null,
    reworkMin: previous?.timing?.reworkMin ?? null,
    reviewMin: previous?.timing?.reviewMin ?? null,
    measured: actualMin !== null
  }

  const release = {
    schema: 1,
    kind: RELEASE_KIND,
    at: now.toISOString(),
    source: '交付门.mjs',
    state: verdict.state,
    stale: verdict.state === 'stale',
    project,
    snapshotId: snapshot.snapshotId,
    gate: gate
      ? { stamp: gate.stamp ?? null, ok: gate.ok === true, degraded: gate.degraded === true, scope: gate.scope ?? null, snapshotId: gate.snapshot?.snapshotId ?? null, summaryText: gate.summaryText ?? null, envelopeOk: gateEnvelope.ok }
      : null,
    review: reviewReport
      ? {
          reviewId: review?.block?.reviewId ?? basename(reviewReport.path),
          decision: review?.decision ?? 'unknown',
          conflict: review?.conflict ?? false,
          reportSha: reviewReport.sha,
          reportPath: reviewReport.path,
          snapshotId: review?.block?.snapshotId ?? null,
          gateStamp: review?.block?.gateStamp ?? null,
          why: review?.why ?? null
        }
      : { reviewId: null, decision: 'unknown', reportSha: null, why: '找不到审核报告' },
    e2e: e2e.declared ? { ok: e2e.ok === true, evidence: e2e.evidence ?? [], steps: e2e.steps ?? [], why: e2e.why ?? null } : { ok: false, evidence: [], why: e2e.why ?? '未声明' },
    blockers: verdict.blockers,
    waivers,
    acceptedBy: verdict.state === 'accepted' ? actor : (previous?.state === 'accepted' ? (previous.acceptedBy ?? null) : null),
    acceptedAt: verdict.state === 'accepted' ? now.toISOString() : (previous?.acceptedAt ?? null),
    rejectedBy: verdict.state === 'rejected' ? actor : (previous?.state === 'rejected' ? (previous.rejectedBy ?? null) : null),
    rejectedWhy: verdict.state === 'rejected' ? (opt('why') ?? null) : (previous?.rejectedWhy ?? null),
    stateService: { ok: stateServiceOk, why: stateServiceWhy },
    audit: audit ? { ok: audit.ok, problems: audit.problems } : null,
    timing,
    previousSnapshotId: previous?.snapshotId ?? null,
    updatedAt: now.toISOString()
  }

  // ---- 写
  if (!checkOnly) {
    mkdirSync(outDir, { recursive: true })
    const tmp = releasePath + '.tmp-' + process.pid
    writeFileSync(tmp, JSON.stringify(release, null, 2), 'utf8')
    renameSync(tmp, releasePath)
    const prevText = existsSync(handoffPath) ? readFileSync(handoffPath, 'utf8') : `# HANDOFF · ${basename(project)}\n`
    const proj = projectHandoff(prevText, release)
    writeFileSync(handoffPath, proj.text, 'utf8')
    release.handoff = { disabledHandwrittenLines: proj.disabled }
  }

  const tookMs = Date.now() - t0
  if (jsonOut) {
    console.log(JSON.stringify({ ...release, tookMs }, null, 2))
  } else {
    const zh = { blocked: '⛔ 阻断', ready: '🟡 可交付（等用户验收）', accepted: '✅ 已验收', rejected: '❌ 已打回', stale: '⚠️ 已过期' }[release.state]
    console.log(`[交付门] ${zh}　快照=${release.snapshotId ?? 'unknown'}　${tookMs}ms${checkOnly ? '（--check：没写文件）' : ''}`)
    if (release.blockers.length) {
      console.log(`[交付门] 阻断 ${release.blockers.length} 条：`)
      for (const b of release.blockers.slice(0, 12)) console.log('   · ' + b)
    }
    console.log(`[交付门] 门禁=${release.gate ? (release.gate.ok ? '绿' : '红') : '缺'}　审核=${release.review.decision}${release.review.conflict ? '(冲突)' : ''}　E2E=${release.e2e.ok ? '过' : '未过'}`)
    if (!checkOnly) console.log(`[交付门] 已写：${releasePath}`)
  }

  const code = { ready: 0, accepted: 0, blocked: 2, rejected: 3, stale: 4 }[release.state] ?? 2
  process.exit(code)
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) main().catch(e => { console.error(`[交付门] ❌ ${e.message}`); process.exit(1) })
