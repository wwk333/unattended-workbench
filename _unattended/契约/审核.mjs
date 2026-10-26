/**
 * 契约/审核 —— **审核结论机器块**的唯一解析器（施工文档 §一「审核结论机器化」）
 *
 * 审核报告末尾固定机器块：
 * ```html
 * <!-- REVIEW-DECISION {"schema":1,"decision":"pass|reject|blocked","gateStamp":"…","snapshotId":"sha256:…","blockers":[]} -->
 * ```
 *
 * 为什么要机器块：`review.ok=true` 原来只表示"审核员这一趟调用成功"，
 * 但报告正文可能写着"打回"——于是同一份报告有两个相反结论，谁都可以挑对自己有利的那个读。
 * 现在**放行只认机器块**，`review-stamp.json` 只做防重复审核缓存。
 *
 * 三条铁律：
 * 1. 缺块 / 格式错 / 旧报告无块 ⇒ `decision:"unknown"`，**不得放行**；
 * 2. 机器块与正文相反（正文写"打回"、机器块写 `pass`）⇒ `conflict:true`，**阻断**；
 * 3. `snapshotId` 与当前代码快照不一致 ⇒ 旧审核作废（交付门判 blocked/stale）。
 */

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

export const REVIEW_DECISIONS = Object.freeze(['pass', 'reject', 'blocked'])

/** 正文里算"否决"的词（只留强词，别把"上一次被打回"也算进来 —— 见 BALANCED 排除） */
export const PROSE_REJECT_WORDS = Object.freeze(['打回', '不通过', '未通过', '驳回', '拒绝放行', '不可放行', '不得放行'])
/** 这些词出现在同一行里，说明它在讲历史，不算本轮结论 */
export const PROSE_HISTORY_WORDS = Object.freeze(['上一轮', '上次', '此前', '历史', '曾经', '之前那一版', '上版'])

const BLOCK_RE = /<!--\s*REVIEW-DECISION\b([\s\S]*?)-->/

export class ReviewError extends Error {
  constructor (why, detail) {
    super(`[审核] ${why}${detail ? `（${detail}）` : ''}`)
    this.name = 'ReviewError'
    this.code = 'E_REVIEW'
  }
}

/**
 * 解析审核报告。
 *
 * ★ 2026-10-27（审核一次制）：`anchorsOptional` —— **锚点由编排给**时用。
 *   原来 `gateStamp` / `snapshotId` 缺失一律判"机器块不合规 ⇒ unknown"，
 *   于是审核员抄错一个字 ⇒ 交付门 unknown ⇒ 只能再审一次（**自己制造重审**）。
 *   现在 `编排.mjs` 传 `anchorsOptional:true`：只要能拿到 `decision` / `why`（判断），
 *   锚点由机器用**它刚跑的那次门禁**覆写（见 `_审核一次.mjs` 的 `planAnchors`）。
 *
 *   ⚠️ 默认仍然是**严格**的（`false`）——`交付门.mjs` 与我方生成器不走这条口子，
 *   免得"锚点缺失"被悄悄放过（那等于假绿）。
 *
 * @param {string} text 报告全文
 * @param {{anchorsOptional?:boolean}} [o]
 * @returns {{ ok:boolean, why:string|null, decision:string, schema:number|null,
 *             gateStamp:string|null, snapshotId:string|null, anchorsMissing:boolean,
 *             blockers:string[], reviewId:string|null, at:string|null, blockRaw:string|null }}
 */
export function parseReviewDecision (text, { anchorsOptional = false } = {}) {
  const empty = {
    ok: false, why: null, decision: 'unknown', schema: null, gateStamp: null,
    snapshotId: null, anchorsMissing: false, blockers: [], reviewId: null, at: null, blockRaw: null
  }
  if (typeof text !== 'string' || !text.trim()) return { ...empty, why: '审核报告是空的' }
  const m = BLOCK_RE.exec(text)
  if (!m) return { ...empty, why: '审核报告里没有 REVIEW-DECISION 机器块（旧报告一律 unknown，不得放行）' }
  let data
  try {
    data = JSON.parse(m[1].trim())
  } catch (e) {
    return { ...empty, blockRaw: m[0], why: `机器块不是合法 JSON：${String(e.message).slice(0, 120)}` }
  }
  if (!data || typeof data !== 'object') return { ...empty, blockRaw: m[0], why: '机器块不是对象' }
  const bad = []
  if (data.schema !== 1) bad.push(`schema=${JSON.stringify(data.schema)}（只认 1）`)
  if (!REVIEW_DECISIONS.includes(data.decision)) bad.push(`decision=${JSON.stringify(data.decision)}（只认 ${REVIEW_DECISIONS.join('/')}）`)
  const noGateStamp = typeof data.gateStamp !== 'string' || !data.gateStamp
  const noSnapshot = typeof data.snapshotId !== 'string' || !data.snapshotId
  const anchorsMissing = noGateStamp || noSnapshot
  // ★ 2026-10-27：严格模式（默认）下锚点仍然是硬要求；`anchorsOptional` 时交给编排覆写
  if (!anchorsOptional) {
    if (noGateStamp) bad.push('缺 gateStamp（审核必须绑定它跑的哪一份门禁）')
    if (noSnapshot) bad.push('缺 snapshotId（审核必须绑定它看的是哪一份代码）')
  }
  if (data.blockers !== undefined && !Array.isArray(data.blockers)) bad.push('blockers 必须是数组')
  if (bad.length) return { ...empty, anchorsMissing, blockRaw: m[0], why: `机器块不合规：${bad.join('；')}` }

  return {
    ok: true,
    // ★ 2026-10-26：原来写死 null ⇒ 审核员写的 why **全被吞掉**，
    //   verdict 里就成「阻断但没理由」（demo 真跑第三次当场看到 decisionWhy: null）。
    // ★ 2026-10-26：审核员的理由**不一定叫 why**。真报告里用的是 `blockers: ["...","..."]`
    //   （拿真实报告复判当场看到：机器块有 3 条 blockers，我们只认 why ⇒ 结论变成"没理由"）。
    //   口径：why 优先；没有 why 就把 blockers 用「；」拼起来；两者都没有才是真的没理由。
    why: (typeof data.why === 'string' && data.why.trim())
      ? data.why.trim()
      : (Array.isArray(data.blockers) && data.blockers.length
          ? data.blockers.map((x) => String(x ?? '').trim()).filter(Boolean).join('；')
          : null),
    decision: data.decision,
    schema: data.schema,
    gateStamp: noGateStamp ? null : data.gateStamp,
    snapshotId: noSnapshot ? null : data.snapshotId,
    anchorsMissing,
    blockers: Array.isArray(data.blockers) ? data.blockers.map(String) : [],
    reviewId: typeof data.reviewId === 'string' ? data.reviewId : null,
    at: typeof data.at === 'string' ? data.at : null,
    blockRaw: m[0]
  }
}

/** 正文里有没有"否决"的话（排除讲历史的那种行） */
export function proseReject (text) {
  const hits = []
  const lines = String(text ?? '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (PROSE_HISTORY_WORDS.some(w => line.includes(w))) continue
    const hit = PROSE_REJECT_WORDS.find(w => line.includes(w))
    if (hit) hits.push({ line: i + 1, word: hit, text: line.trim().slice(0, 160) })
  }
  return hits
}

/**
 * 综合判定：机器块 + 正文是否自相矛盾。
 * @param {string} text
 * @param {{anchorsOptional?:boolean}} [o] 见 `parseReviewDecision`（默认严格）
 * @returns {{ decision:string, ok:boolean, conflict:boolean, why:string|null, proseHits:object[], block:object }}
 */
export function judgeReview (text, { anchorsOptional = false } = {}) {
  const block = parseReviewDecision(text, { anchorsOptional })
  const hits = proseReject(text)
  const conflict = block.ok && block.decision === 'pass' && hits.length > 0
  let why = block.why
  if (conflict) why = `机器块写 pass，但正文有否决表述（第 ${hits[0].line} 行「${hits[0].text}」）—— 冲突即阻断`
  // ★ 2026-10-26（demo 真跑第三次当场抓到）：审核报告写了 `decision: blocked` 却**没写 why**，
  //   一路透传到 verdict 就成了「阻断，但没理由」（`decisionWhy: null`）——
  //   这正是我们一直在防的"结论没有证据"。无理由的阻断**不可信**，必须点出来。
  if (!why && block.ok && block.decision && block.decision !== 'pass') {
    why = `机器块写了 ${block.decision} 但**没写 why** —— 没有理由的阻断不可信（请让审核员补一条 why）`
  }
  return {
    decision: block.ok ? block.decision : 'unknown',
    ok: block.ok && block.decision === 'pass' && !conflict,
    conflict,
    why,
    proseHits: hits,
    block
  }
}

/** 报告指纹：交付门用它判"审核后报告有没有被改过" */
export function reviewReportSha (text) {
  return 'sha256:' + createHash('sha256').update(String(text ?? '')).digest('hex')
}

/**
 * 给审核员用的机器块模板（写进"审核报告末尾"的固定形状）。
 * 交付门/测试共用同一个生成器，避免手写出格式漂移。
 */
export function buildReviewBlock ({ decision, gateStamp, snapshotId, blockers = [], reviewId = null, at = new Date().toISOString() }) {
  if (!REVIEW_DECISIONS.includes(decision)) throw new ReviewError(`decision 非法：${decision}`)
  if (!gateStamp) throw new ReviewError('缺 gateStamp')
  if (!snapshotId) throw new ReviewError('缺 snapshotId')
  const data = { schema: 1, decision, gateStamp, snapshotId, blockers, at }
  if (reviewId) data.reviewId = reviewId
  return `<!-- REVIEW-DECISION ${JSON.stringify(data)} -->`
}

/** 把机器块插到报告末尾（已有块就替换 —— 一份报告只许一个结论） */
export function upsertReviewBlock (text, block) {
  const body = String(text ?? '')
  if (BLOCK_RE.test(body)) return body.replace(BLOCK_RE, block)
  return body.replace(/\s*$/, '') + '\n\n' + block + '\n'
}

/**
 * 找审核报告（**唯一实现**，`交付门.mjs` 与 `编排.mjs` 共用）。
 * 顺序：`<project>/_crew/runs/<最新>/review/*.md` → 项目根 `审核报告.md`；按 mtime 取最新。
 */
export function findReviewReport (project, explicit = null) {
  if (explicit) {
    const p = resolve(project, explicit)
    return existsSync(p) ? { path: p, source: 'explicit' } : { path: p, missing: true, source: 'explicit' }
  }
  const root = join(project, '审核报告.md')
  const runs = join(project, '_crew', 'runs')
  const cands = []
  if (existsSync(runs)) {
    let stamps = []
    try { stamps = readdirSync(runs, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().reverse() } catch {}
    for (const st of stamps.slice(0, 5)) {
      const rdir = join(runs, st, 'review')
      if (!existsSync(rdir)) continue
      let files = []
      try { files = readdirSync(rdir).filter(f => f.endsWith('.md')) } catch {}
      for (const f of files) {
        const p = join(rdir, f)
        let mtime = 0
        try { mtime = statSync(p).mtimeMs } catch {}
        cands.push({ path: p, stamp: st, mtime, source: `runs/${st}/review/${f}` })
      }
    }
  }
  if (existsSync(root)) {
    let mtime = 0
    try { mtime = statSync(root).mtimeMs } catch {}
    cands.push({ path: root, stamp: null, mtime, source: '项目根 审核报告.md' })
  }
  if (!cands.length) return { path: null, missing: true, source: null }
  // ★ 口径（确定、可预测）：**run 内的报告优先**（编排就是在 `_crew/runs/<stamp>/review/` 让审核员落的），
  //   只有在没有任何 run 内报告时才退回项目根的 `审核报告.md`。
  //   为什么不按 mtime 混排：实测夹具里三份报告同一毫秒落盘，mtime 抖一下就随机挑到根目录那份 ——
  //   "谁更新"在跨来源时不可靠，而"哪一份是正式落点"是确定的。
  const inRuns = cands.filter(c => c.stamp)
  if (inRuns.length) {
    inRuns.sort((a, b) => String(b.stamp).localeCompare(String(a.stamp)) || b.mtime - a.mtime)
    return inRuns[0]
  }
  return cands[0]
}
