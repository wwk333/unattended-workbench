/**
 * 阶段 2 · 审核结论机器块（§一「审核结论机器化」）
 *
 * 核心：`review.ok` 的歧义必须被消灭 —— 放行只认机器块；缺块/格式错 ⇒ unknown；
 * 正文写"打回"而机器块写 pass ⇒ 冲突 ⇒ 阻断。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  parseReviewDecision, proseReject, judgeReview, reviewReportSha,
  buildReviewBlock, upsertReviewBlock, findReviewReport, REVIEW_DECISIONS
} from '../_unattended/契约/审核.mjs'
import { fixture, cleanup, dump } from './_助手.mjs'

const GOOD = `# 审核报告

结论：通过。

<!-- REVIEW-DECISION {"schema":1,"decision":"pass","gateStamp":"2026-10-25-01-00-00","snapshotId":"sha256:abc","blockers":[],"reviewId":"REVIEW-1"} -->
`

test('机器块：合规 ⇒ pass，字段全解析出来', () => {
  const r = parseReviewDecision(GOOD)
  assert.equal(r.ok, true)
  assert.equal(r.decision, 'pass')
  assert.equal(r.gateStamp, '2026-10-25-01-00-00')
  assert.equal(r.snapshotId, 'sha256:abc')
  assert.deepEqual(r.blockers, [])
  assert.equal(r.reviewId, 'REVIEW-1')
  dump('review-block', r)
})

test('负向：缺块 / 坏 JSON / schema≠1 / decision 非法 / 缺 gateStamp / 缺 snapshotId 全部 unknown', () => {
  const cases = {
    缺块: '# 报告\n\n结论：通过（没有机器块）\n',
    坏JSON: '<!-- REVIEW-DECISION {oops} -->',
    schema2: '<!-- REVIEW-DECISION {"schema":2,"decision":"pass","gateStamp":"g","snapshotId":"s"} -->',
    decision非法: '<!-- REVIEW-DECISION {"schema":1,"decision":"ok","gateStamp":"g","snapshotId":"s"} -->',
    缺gateStamp: '<!-- REVIEW-DECISION {"schema":1,"decision":"pass","snapshotId":"s"} -->',
    缺snapshotId: '<!-- REVIEW-DECISION {"schema":1,"decision":"pass","gateStamp":"g"} -->',
    blockers非数组: '<!-- REVIEW-DECISION {"schema":1,"decision":"pass","gateStamp":"g","snapshotId":"s","blockers":"x"} -->'
  }
  for (const [name, text] of Object.entries(cases)) {
    const r = parseReviewDecision(text)
    assert.equal(r.ok, false, `${name} 应判不合规`)
    assert.equal(r.decision, 'unknown')
    assert.ok(r.why, `${name} 应给原因`)
  }
  assert.equal(parseReviewDecision('').decision, 'unknown')
  assert.equal(parseReviewDecision(null).decision, 'unknown')
  dump('review-bad-blocks', Object.keys(cases))
})

test('decision 只认 pass/reject/blocked', () => {
  assert.deepEqual([...REVIEW_DECISIONS], ['pass', 'reject', 'blocked'])
  for (const d of REVIEW_DECISIONS) {
    const r = parseReviewDecision(`<!-- REVIEW-DECISION {"schema":1,"decision":"${d}","gateStamp":"g","snapshotId":"s"} -->`)
    assert.equal(r.decision, d)
  }
})

test('正文否决词：认得出来，但"讲历史"的行不算', () => {
  const hits = proseReject('这版没问题。\n但上一轮被打回，原因是缺测试。\n结论：本轮仍未通过。')
  assert.equal(hits.length, 1, JSON.stringify(hits))
  assert.equal(hits[0].word, '未通过')
  assert.equal(proseReject('全部通过，可以放行。').length, 0)
  dump('prose-hits', hits)
})

test('冲突：机器块写 pass、正文写"打回" ⇒ conflict 且不得当绿', () => {
  const text = '# 报告\n\n这一版我**打回**：缺少入口 E2E。\n\n<!-- REVIEW-DECISION {"schema":1,"decision":"pass","gateStamp":"g","snapshotId":"s"} -->'
  const j = judgeReview(text)
  assert.equal(j.conflict, true)
  assert.equal(j.ok, false)
  assert.equal(j.decision, 'pass')   // 结论仍如实反映机器块
  assert.match(j.why, /冲突|打回/)
  dump('review-conflict', { conflict: j.conflict, why: j.why })
})

test('judgeReview：只有"机器块 pass + 正文没否决"才算 ok', () => {
  assert.equal(judgeReview(GOOD).ok, true)
  assert.equal(judgeReview('# 无块').ok, false)
  const rejectText = '# 报告\n打回\n\n<!-- REVIEW-DECISION {"schema":1,"decision":"reject","gateStamp":"g","snapshotId":"s"} -->'
  const j = judgeReview(rejectText)
  assert.equal(j.ok, false)
  assert.equal(j.decision, 'reject')
  assert.equal(j.conflict, false)
})

test('buildReviewBlock / upsertReviewBlock：一份报告只许一个结论', () => {
  const b1 = buildReviewBlock({ decision: 'pass', gateStamp: 'g1', snapshotId: 'sha256:1' })
  assert.match(b1, /^<!-- REVIEW-DECISION \{/)
  const once = upsertReviewBlock('# 报告\n', b1)
  const b2 = buildReviewBlock({ decision: 'reject', gateStamp: 'g2', snapshotId: 'sha256:2', blockers: ['缺测试'] })
  const twice = upsertReviewBlock(once, b2)
  assert.equal((twice.match(/REVIEW-DECISION/g) ?? []).length, 1, '出现了两个机器块')
  assert.equal(parseReviewDecision(twice).decision, 'reject')
  assert.throws(() => buildReviewBlock({ decision: 'ok', gateStamp: 'g', snapshotId: 's' }), /decision 非法/)
  assert.throws(() => buildReviewBlock({ decision: 'pass', snapshotId: 's' }), /gateStamp/)
  dump('review-block-build', { reject: parseReviewDecision(twice) })
})

test('报告指纹：内容变一个字节就变', () => {
  const a = reviewReportSha('abc')
  assert.match(a, /^sha256:[0-9a-f]{64}$/)
  assert.notEqual(a, reviewReportSha('abd'))
  assert.equal(a, reviewReportSha('abc'))
})

test('找报告：优先级 runs/<最新>/review/*.md，其次项目根 审核报告.md', () => {
  const dir = fixture({
    '_crew/runs/2026-10-01T00-00-00/review/审核报告.md': '# 旧\n',
    '_crew/runs/2026-10-02T00-00-00/review/审核报告.md': '# 新\n',
    '审核报告.md': '# 根目录\n'
  })
  try {
    const r = findReviewReport(dir)
    assert.ok(r.path.endsWith('审核报告.md'))
    assert.match(r.path.replace(/\\/g, '/'), /2026-10-02T00-00-00/)
    const explicit = findReviewReport(dir, '审核报告.md')
    assert.equal(explicit.source, 'explicit')
    assert.equal(findReviewReport(dir, 'nope.md').missing, true)
    const empty = fixture({})
    assert.equal(findReviewReport(empty).missing, true)
    cleanup(empty)
  } finally { cleanup(dir) }
})
