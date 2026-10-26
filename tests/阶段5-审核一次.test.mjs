/**
 * 阶段5 —— **审核一次制 / 砍审核重复**（2026-10-27 施工文档）
 *
 * 锁死四件事（都是本次改动里"最容易悄悄退回去"的地方）：
 *   ① 判据是**整个项目**做完，且 `ready` 也算没做完（原代码漏了 ready）
 *   ② 次数是**项目级 1 次**，换波不归零；用完就 `used`，不再自动审
 *   ③ 卡面上**不再出现门禁命令**（原来等于"命令它重跑一遍"，同一段又写"不要重跑"）
 *   ④ 机器块锚点**由编排给**（模型只给 decision/why），且拿不到锚点时必须 unknown → 不放行
 *
 * 为什么这些要用测试钉：它们全是"表里 A、代码 B"的高发区 ——
 *   文案改了代码没改、代码改了文案没改、或者过几个月有人"顺手把门禁命令加回去"。
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  OPEN_STATUSES, countBy, openRows, isSettled, isUsed, reviewPlan, planAnchors, reviewPolicyOf,
  parseLedgerRows, LEDGER_MARKERS
} from '../_unattended/_审核一次.mjs'
import { parseReviewDecision, judgeReview } from '../_unattended/契约/审核.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..')
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8').replace(/^\uFEFF/, '')

const card = (id, status, wave = 'W1') => ({ id, status, wave, role: 'coder-a' })
const allDone = () => [card('T1', 'done'), card('T2', 'review'), card('T3', 'blocked')]

// ---------------------------------------------------------------- ① 判据

test('① ready 也算"没做完"（原代码只认 pending/doing，是个洞）', () => {
  assert.deepEqual([...OPEN_STATUSES], ['pending', 'ready', 'doing'])
  for (const s of OPEN_STATUSES) {
    assert.equal(isSettled([card('T1', 'done'), card('T2', s)]), false, `${s} 必须算没做完`)
  }
})

test('① 只剩 done/review/blocked/dropped 才算做完', () => {
  assert.equal(isSettled(allDone()), true)
  assert.equal(isSettled([card('T1', 'dropped')]), true)
})

test('① 空项目 ≠ 做完（不能拿空项目去审）', () => {
  assert.equal(isSettled([]), false)
  assert.equal(isSettled(null), false)
})

test('① countBy 不认识的 status 只计入 total，不瞎归类', () => {
  const c = countBy([card('T1', 'done'), card('T2', 'weird-status')])
  assert.equal(c.total, 2)
  assert.equal(c.done, 1)
  assert.equal(c.weird, undefined)
})

test('① openRows 只挑 pending/ready/doing', () => {
  const rows = [card('T1', 'pending'), card('T2', 'ready'), card('T3', 'done'), card('T4', 'doing')]
  assert.deepEqual(openRows(rows).map(r => r.id), ['T1', 'T2', 'T4'])
})

// ---------------------------------------------------------------- ①b 台账行解析

test('① b 七个标记必须**逐个**认（`r` 漏过一次，代价是把唯一一次审核烧在没做完的项目上）', () => {
  const cases = [
    ['[ ] T1 W1 coder-a pending 还没开始', 'pending'],
    ['[r] T2 W1 coder-a ready 已排队', 'ready'],
    ['[>] T3 W1 coder-a doing 在做', 'doing'],
    ['[?] T4 W1 coder-a review 待审', 'review'],
    ['[x] T5 W1 coder-a done 完了', 'done'],
    ['[!] T6 W1 coder-a blocked 卡住', 'blocked'],
    ['[-] T7 W1 coder-a dropped 放弃', 'dropped']
  ]
  for (const [line, want] of cases) {
    const rows = parseLedgerRows(line)
    assert.equal(rows.length, 1, `这行不该被丢弃：${line}`)
    assert.equal(rows[0].status, want)
    assert.equal(rows[0].id, line.slice(4, 6).trim())
  }
})

test('① b 真实 `台账 list` 那种列宽不齐的行也能认（[r] 那行原本就是对齐最差的）', () => {
  const text = [
    '   [-] T-样例1    W1   coder-a   dropped   照这行的形状写你的任务卡',
    '   [r] T1       W1   coder-a   ready     建 index.html',
    '   [x] T3       W1   coder-b   done      建启动器',
    '   [?] T2       W2   coder-a   review    等:T1(ready)  换 500 词'
  ].join('\r\n')
  const rows = parseLedgerRows(text)
  assert.deepEqual(rows.map(r => r.status), ['dropped', 'ready', 'done', 'review'])
  assert.equal(rows[1].id, 'T1')
  assert.equal(rows[3].goal, '等:T1(ready)  换 500 词')
})

test('① b 不认识的标记不认（集合是封闭的，宁可不解析也不瞎猜状态）', () => {
  assert.deepEqual(parseLedgerRows('[z] T9 W1 coder-a zzz 未知'), [])
  assert.deepEqual(parseLedgerRows('  随便一行不带标记'), [])
  assert.deepEqual(parseLedgerRows(''), [])
})

test('① b 解析 → 判据 的整条链：有 ready 卡就不许终审（这才是那个 bug 的真后果）', () => {
  const rows = parseLedgerRows([
    '   [r] T1       W1   coder-a   ready     还没开工',
    '   [x] T3       W1   coder-b   done      做完了',
    '   [?] T2       W2   coder-a   review    待审'
  ].join('\n'))
  assert.equal(isSettled(rows), false)
  const p = reviewPlan({ rows, stamp: null })
  assert.equal(p.act, 'not-ready')
  assert.match(p.reason, /待开工 1/)
})

test('① b 编排必须用同一份解析器（不许再自己写一份正则）', () => {
  const src = read('_unattended/编排.mjs')
  assert.match(src, /const rows = parseLedgerRows\(out\)/)
  assert.equal(/\[ x>\?x!\\-\]/.test(src), false, '旧字符类（漏 r）不许回来')
})

// ---------------------------------------------------------------- ② 次数

test('② 项目做完 + 没审过 ⇒ review（项目周期首审 1/1）', () => {
  const p = reviewPlan({ rows: allDone(), stamp: null })
  assert.equal(p.act, 'review')
  assert.match(p.reason, /1\/1/)
})

test('② 换波不归零：老 stamp 里 tag 不同也照样 used（这是 beidanci 跑到 5 轮的根因）', () => {
  const stamp = { tag: '完全不同的一批', reviewId: 'REVIEW-x', verdict: 'ok', rounds: 5, maxRounds: 2 }
  const p = reviewPlan({ rows: allDone(), stamp })
  assert.equal(p.act, 'used')
})

test('② fullReviewDone 是硬标记：为 false 时还能审，为 true 时不再审', () => {
  const rows = allDone()
  assert.equal(reviewPlan({ rows, stamp: { fullReviewDone: false } }).act, 'review')
  assert.equal(reviewPlan({ rows, stamp: { fullReviewDone: true, decision: 'pass' } }).act, 'used')
})

test('② --force-review 能覆盖 1/1（但只有显式给才覆盖）', () => {
  const stamp = { fullReviewDone: true, decision: 'blocked' }
  assert.equal(reviewPlan({ rows: allDone(), stamp }).act, 'used')
  assert.equal(reviewPlan({ rows: allDone(), stamp, force: true }).act, 'review')
})

test('② 没做完就不审（不是"没做完也审"，也不是"忘了写"）', () => {
  const p = reviewPlan({ rows: [card('T1', 'done'), card('T2', 'ready')], stamp: null })
  assert.equal(p.act, 'not-ready')
  assert.match(p.reason, /待开工 1/)
  assert.deepEqual(p.detail.openIds, ['T2'])
})

test('② 一张可审的卡都没有（done+review=0）⇒ 不审', () => {
  const p = reviewPlan({ rows: [card('T1', 'blocked'), card('T2', 'dropped')], stamp: null })
  assert.equal(p.act, 'not-ready')
})

test('② isUsed 读时兼容老 stamp：有 reviewId 且 verdict 非分级跳过 ⇒ 已审过', () => {
  assert.equal(isUsed({ reviewId: 'REVIEW-1', verdict: 'ok' }), true)
  assert.equal(isUsed({ reviewId: 'REVIEW-1', verdict: 'flaky' }), true)
  // 分级跳过 = 没审，不许被当成审过
  assert.equal(isUsed({ reviewId: null, verdict: 'level-skip-review' }), false)
  assert.equal(isUsed({ verdict: 'ok' }), false)
  assert.equal(isUsed(null), false)
  assert.equal(isUsed({}), false)
})

test('② 老 stamp 的 verdict:"ok" 不许被当成"审核通过"（调用成功 ≠ 审过）', () => {
  const src = read('_unattended/编排.mjs')
  // 真跑暴露过的坑：prior 回落到 verdict ⇒ 老项目 `verdict:'ok'` 被当 pass；
  // 而 'ok' 只表示"这一趟调用成功"，历史上 `review.ok` 就是被这么误读的。
  assert.equal(/stamp0\?\.verdict/.test(src), false, 'prior 不许回落到 verdict')
  assert.match(src, /const prior = String\(stamp0\?\.decision \?\? 'unknown'\)/)
  // 只有明确的否决才发 halt；unknown 不自行判罚（放不放行归交付门）
  assert.match(src, /prior === 'blocked' \|\| prior === 'reject'/)
})

// ---------------------------------------------------------------- ③ 卡面

test('③ 卡面不再出现「本卡门禁命令」段（删掉它，等于不再命令它重跑）', () => {
  const src = read('_unattended/派活.mjs')
  assert.equal(src.includes('【本卡门禁命令'), false)
  // 常量还在（口径唯一），但**不许再被插值进任何卡**
  assert.match(src, /const GATE_CMD = /)
  assert.equal(/\$\{GATE_CMD\}/.test(src), false, 'GATE_CMD 不许再插进卡面')
})

test('③ "先跑门禁"这句命令式文案必须消失（改成"已经跑完了"）', () => {
  const src = read('_unattended/派活.mjs')
  assert.equal(src.includes('**先跑门禁**'), false)
  assert.match(src, /门禁已经由编排跑完了/)
})

test('③ 越界名单要覆盖"重跑门禁"（原来只认 npm test，门禁.mjs 溜过去了）', () => {
  const src = read('_unattended/_审核一次.mjs')
  assert.match(src, /review-rerun-gate/)
  assert.match(src, /门禁\\\.mjs/)
  assert.match(src, /没有跑/)
  // 判据必须真的被 judge() 用上，否则"规矩"只是文本
  assert.match(read('_unattended/编排.mjs'), /reviewPolicyOf\(\{ body:/)
})

// ---- 行为：卡上的规矩会不会真响（这是"长牙"的本体，光有静态断言不算） ----

test('③ 回执里跑了 `门禁.mjs` ⇒ review-rerun-gate（真跑踩到的那个漏网）', () => {
  const r = reviewPolicyOf({ body: '跑过的命令：\n1. node "<工作台根>/_unattended/门禁.mjs" --project "X:/x"\n2. cat gate-result.json', toolCalls: 5 })
  assert.equal(r.policy, 'review-rerun-gate')
})

test('③ 回执里写"我没有跑门禁.mjs" ⇒ 不算违规（否定词护栏，宁可漏判）', () => {
  const r = reviewPolicyOf({ body: '按要求我**没有跑** 门禁.mjs；依据：_crew/gate/gate-result.json', toolCalls: 5 })
  assert.equal(r.policy, null)
})

test('③ 跑了 `npm test` ⇒ review-overreach（优先级高于门禁那条）', () => {
  const r = reviewPolicyOf({ body: '我跑了 npm test，另外 门禁.mjs 也跑了，见 gate-result.json', toolCalls: 5 })
  assert.equal(r.policy, 'review-overreach')
})

test('③ 全量命令写在否定句里 ⇒ 不算违规', () => {
  const r = reviewPolicyOf({ body: '卡上说不要跑 npm test，所以没跑；依据 gate-result.json', toolCalls: 5 })
  assert.equal(r.policy, null)
})

test('③ 没引用 gate-result.json ⇒ review-unverified', () => {
  const r = reviewPolicyOf({ body: '我审完了，一切正常。', toolCalls: 3 })
  assert.equal(r.policy, 'review-unverified')
})

test('③ 工具调用 > 25 ⇒ review-over-budget（软提示，不改判决语义）', () => {
  const r = reviewPolicyOf({ body: '依据 gate-result.json，绿 4 步 / 红 0 步', toolCalls: 62 })
  assert.equal(r.policy, 'review-over-budget')
  assert.match(r.action, /62/)
})

test('③ 干净回执 ⇒ policy 为 null，action 是"收活"', () => {
  const r = reviewPolicyOf({ body: '依据 _crew/gate/gate-result.json（绿 4 / 红 0），结论 pass', toolCalls: 8 })
  assert.equal(r.policy, null)
  assert.equal(r.action, '收活')
})

// ---------------------------------------------------------------- ④ 锚点

const goodBlock = (over = {}) => ({
  ok: true, decision: 'pass', gateStamp: '', snapshotId: '', blockers: [],
  reviewId: 'REVIEW-1', why: '看着行', anchorsMissing: true, ...over
})

test('④ 模型留空锚点 ⇒ 用机器真值覆写，decision 仍是模型的', () => {
  const r = planAnchors({ block: goodBlock(), gateStamp: 'G1', snapshotId: 'sha256:A', reviewId: 'REVIEW-1' })
  assert.equal(r.decision, 'pass')
  assert.equal(r.needRewrite, true)
  assert.equal(r.source, 'machine-override')
  assert.equal(r.block.gateStamp, 'G1')
  assert.equal(r.block.snapshotId, 'sha256:A')
})

test('④ 模型抄错锚点 ⇒ 同样被机器覆写（这就是"抄错 ⇒ unknown ⇒ 重审"的病根）', () => {
  const r = planAnchors({
    block: goodBlock({ gateStamp: '抄错了', snapshotId: 'sha256:WRONG', anchorsMissing: false }),
    gateStamp: 'G1', snapshotId: 'sha256:A'
  })
  assert.equal(r.needRewrite, true)
  assert.equal(r.block.gateStamp, 'G1')
  assert.equal(r.block.snapshotId, 'sha256:A')
})

test('④ 锚点本来就对 ⇒ 不改写（别白改人家的报告）', () => {
  const r = planAnchors({
    block: goodBlock({ gateStamp: 'G1', snapshotId: 'sha256:A', anchorsMissing: false }),
    gateStamp: 'G1', snapshotId: 'sha256:A'
  })
  assert.equal(r.needRewrite, false)
  assert.equal(r.source, 'machine-same')
})

test('④ 拿不到机器锚点 ⇒ 一律 unknown（不许拿模型的抄写当放行依据）', () => {
  const r = planAnchors({ block: goodBlock(), gateStamp: null, snapshotId: null })
  assert.equal(r.decision, 'unknown')
  assert.equal(r.needRewrite, false)
  assert.match(r.why, /锚点/)
})

test('④ 机器块本身不合法 ⇒ unknown，且不伪造 decision', () => {
  const r = planAnchors({ block: { ok: false, why: '没有机器块' }, gateStamp: 'G1', snapshotId: 'sha256:A' })
  assert.equal(r.decision, 'unknown')
  assert.equal(r.block, null)
  assert.match(r.why, /没有机器块/)
})

test('④ 契约层：默认严格（缺锚点 ⇒ 不可用），anchorsOptional 时才放行给编排覆写', () => {
  const text = '结论\n<!-- REVIEW-DECISION {"schema":1,"decision":"pass","why":"行","gateStamp":"","snapshotId":""} -->'
  const strict = parseReviewDecision(text)
  assert.equal(strict.ok, false)
  assert.match(strict.why, /gateStamp/)
  const loose = parseReviewDecision(text, { anchorsOptional: true })
  assert.equal(loose.ok, true)
  assert.equal(loose.decision, 'pass')
  assert.equal(loose.anchorsMissing, true)
  assert.equal(loose.gateStamp, null)
})

test('④ 契约层：judgeReview 也认 anchorsOptional（否则编排拿不到 decision）', () => {
  const text = '<!-- REVIEW-DECISION {"schema":1,"decision":"blocked","why":"核心路径不通","gateStamp":"","snapshotId":""} -->'
  assert.equal(judgeReview(text).decision, 'unknown')
  const j = judgeReview(text, { anchorsOptional: true })
  assert.equal(j.decision, 'blocked')
  assert.equal(j.why, '核心路径不通')
})

// ---------------------------------------------------------------- 静态锁：接线没断

test('⑤ 编排确实接上了这三件事（判据/计数/锚点），不是只写了模块没调用', () => {
  const src = read('_unattended/编排.mjs')
  assert.match(src, /import \{[^}]*reviewPlan[^}]*\} from '\.\/_审核一次\.mjs'/)
  assert.match(src, /reviewPlan\(\{ rows: st\.rows/)
  assert.match(src, /planAnchors\(\{/)
  // 注意：judgeReview 的参数里还套着 readFileSync(...)，所以不能用 [^)]* —— 那会卡在内层右括号。
  assert.match(src, /judgeReview\([\s\S]{0,160}?anchorsOptional: true/)
  // 旧的"按轮次"判据必须彻底消失
  assert.equal(/const MAX_ROUNDS/.test(src), false)
  assert.equal(/roundsLeft/.test(src), false)
  // 审核段必须是全项目（statusRows(null)），不是那一波
  assert.match(src, /const st = statusRows\(null\)/)
})

test('⑤ statusRows 的 settled 判据用统一常量（代码里不再手写 pending/doing）', () => {
  const src = read('_unattended/编排.mjs')
  assert.match(src, /const pend = scoped\.filter\(r => OPEN_STATUSES\.includes\(r\.status\)\)/)
  // 只看**代码行**：注释里保留"原来是这样"的历史说明是允许的（那段历史正是这条改动的依据）
  const codeOnly = src.split(/\r?\n/)
    .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n')
  assert.equal(/\[\s*'pending'\s*,\s*'doing'\s*\]/.test(codeOnly), false, '代码里不许再手写 pending/doing')
})
