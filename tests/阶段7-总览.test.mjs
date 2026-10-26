/**
 * 阶段 7（补）· 顶部总览（§十 页面层第一项）
 *
 * 五个灯：交付 / 门禁+E2E / 任务 / 健康 / 契约。
 * 钉住的纪律：**每个灯都来自真源，缺源 = unknown，不许显示绿**。
 *
 * 这里测两件事：
 *   ① 真实产物 `_crew/board-data.json` 的 `overview` 形状与"未知不冒充绿"；
 *   ② 页面侧确实把它画出来（源码级断言 + CSS 未知态是虚线圈，不是绿点）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { readHealthSources } from '../_unattended/_健康源.mjs'
import { WORKBENCH } from '../scripts/export-open.mjs'
import { UNATTENDED } from './_服务夹具.mjs'
import { dump } from './_助手.mjs'

const PANEL = join(UNATTENDED, '面板')
const BOARD = join(WORKBENCH, '_crew', 'board-data.json')
// ★W2（D22）：下面 6 条断言的是**真实运行时产物**，包里不带数据 ⇒ 明说跳过，不许静默算过
const _T0 = Date.now()
function boardIsReal () {
  try {
    // 只认**跑测试之前就存在**的那份：并行用例会现写一份，那份不算"真实工作台"
    if (!(existsSync(BOARD) && statSync(BOARD).mtimeMs < _T0)) return false
    return Boolean(JSON.parse(readFileSync(BOARD, 'utf8')).overview)
  } catch { return false }
}
// 判"真产物"而不是"文件在"：空骨架也不算（踩过：setup 建的 stub 让这 5 条误跑）
const SKIP_NO_BOARD = boardIsReal() ? false : '需要真实 _crew/board-data.json（开源包里不带运行时数据）'

test('board-data 的 overview 有且只有五项（交付/门禁+E2E/任务/健康/契约）', { skip: SKIP_NO_BOARD }, () => {
  assert.ok(existsSync(BOARD), '先跑一次 看板数据.mjs')
  const b = JSON.parse(readFileSync(BOARD, 'utf8'))
  assert.ok(b.overview, 'board-data 缺 overview')
  assert.equal(b.overview.kind, 'overview')
  assert.equal(b.overview.source, '看板数据.mjs')
  assert.deepEqual(b.overview.items.map(i => i.id), ['release', 'gate', 'tasks', 'health', 'contract'])
  for (const it of b.overview.items) {
    assert.ok(['green', 'yellow', 'red', 'unknown'].includes(it.lamp), `${it.id} 灯值非法：${it.lamp}`)
    assert.ok(it.label && it.text != null, `${it.id} 缺 label/text`)
  }
  dump('overview', b.overview.items.map(i => `${i.id}=${i.lamp}(${i.text})`))
})

test('未知不许冒充绿：源 unknown ⇒ 该灯 unknown，且 allGreen=false', { skip: SKIP_NO_BOARD }, () => {
  const b = JSON.parse(readFileSync(BOARD, 'utf8'))
  const h = readHealthSources({ project: b.currentProject?.path ?? WORKBENCH, workbench: WORKBENCH })
  for (const it of b.overview.items) {
    if (!['release', 'gate', 'contract'].includes(it.id)) continue
    const src = h.sources.find(s => s.id === it.id)
    if (src?.state === 'unknown') assert.equal(it.lamp, 'unknown', `${it.id} 源未知却显示 ${it.lamp}`)
  }
  if (b.overview.items.some(i => i.lamp !== 'green')) assert.equal(b.overview.allGreen, false)
})

test('健康灯由四份健康汇总：有未知就不是绿', { skip: SKIP_NO_BOARD }, () => {
  const b = JSON.parse(readFileSync(BOARD, 'utf8'))
  const health = b.overview.items.find(i => i.id === 'health')
  const known = b.health?.summary ?? null
  if (known) {
    if (known.unknown) assert.notEqual(health.lamp, 'green', '有未知项时健康灯不许是绿')
    if (known.red) assert.equal(health.lamp, 'red')
  }
})

test('任务灯：C 服务读不到 ⇒ unknown；视图过期 ⇒ yellow（不冒充绿）', { skip: SKIP_NO_BOARD }, () => {
  const b = JSON.parse(readFileSync(BOARD, 'utf8'))
  const t = b.overview.items.find(i => i.id === 'tasks')
  if (b.tasksSource?.state !== 'state-service') assert.equal(t.lamp, 'unknown')
  else if (b.tasksSource.stale) assert.equal(t.lamp, 'yellow')
})

test('页面真的画了总览（源码级断言）', () => {
  const js = readFileSync(join(PANEL, '页面.js'), 'utf8')
  assert.match(js, /var overviewEl = h\('div', \{ class: 'overview' \}\)/)
  assert.match(js, /function paintOverview/)
  assert.match(js, /var ov = snap && snap\.overview/)
  // 必须挂在 paintStamp 里（render() 是 clear(body) 全量重建，总览条不能被清掉）
  assert.match(js, /function paintStamp \(\) \{[^}]*paintOverview\(\)/)
  // 必须插在 topbar 之后、body 之外
  // 状态条必须在 .board-page 内部（否则会把底部那排卡顶出屏幕）
  assert.match(js, /pageBoard\.insertBefore\(overviewEl, pageBoard\.firstChild\)/)
  assert.ok(!/append\(rootEl, \[[^\]]*overviewEl/.test(js), 'overview 不该再直接挂在 rootEl 上')
  // 未知态必须说出来，不能静默
  assert.match(js, /总览：未知/)
})

test('CSS：未知态用虚线圈，不是绿点（视觉上也不许冒充绿）', () => {
  const css = readFileSync(join(PANEL, '页面.css'), 'utf8')
  assert.match(css, /\.ov-green\s+\.ov-dot\s*\{[^}]*#3fb950/)
  assert.match(css, /\.ov-unknown\s+\.ov-dot\s*\{[^}]*dashed/)
  assert.match(css, /\.overview\s*\{/)
})

test('既有实现：ctxPct 超过 100% 显示 —（不编数）', () => {  const src = readFileSync(join(PANEL, '链路面板.mjs'), 'utf8')
  const m = src.match(/const ctxSane = \(pct, used, win\) => \{[\s\S]*?\n\s{2}\}/)
  assert.ok(m, '找不到 ctxSane')
  assert.match(m[0], /p > 100\.5\) return false/, 'ctxPct 超过 100.5% 应判不可信')
  // 真正跑一遍那段判据的等价逻辑（不改源码，只验证口径）
  const sane = (pct, used, win) => {
    if (pct == null) return false
    const p = Number(pct); const u = Number(used); const w = Number(win)
    if (!Number.isFinite(p) || p < 0 || p > 100.5) return false
    if (Number.isFinite(u) && Number.isFinite(w) && w > 0 && u > w * 1.02) return false
    return true
  }
  assert.equal(sane(812.3), false, '812.3% 必须判不可信（账本累计值，不是当前窗口）')
  assert.equal(sane(62.5, 62500, 100000), true)
  assert.equal(sane(62.5, 999999, 100000), false, '用量超过窗口 102% ⇒ 判不可信（数据自相矛盾）')
  assert.equal(sane(null), false)
  dump('ctx-sane', { '812.3': sane(812.3), '62.5': sane(62.5, 62500, 100000) })
})

test('调度条数据：board-data 带 planSchedule 的结果（阶段 5 的第一个真消费方）', { skip: SKIP_NO_BOARD }, () => {
  const b = JSON.parse(readFileSync(BOARD, 'utf8'))
  assert.ok(b.scheduler, 'board-data 缺 scheduler')
  assert.equal(typeof b.scheduler.ok, 'boolean')
  if (b.scheduler.ok) {
    assert.ok(Array.isArray(b.scheduler.batches), 'batches 必须是数组')
    assert.ok(b.scheduler.stats && typeof b.scheduler.stats.parallelWidth === 'number')
    for (const batch of b.scheduler.batches) {
      assert.ok(Array.isArray(batch.tasks) && batch.tasks.length > 0, '不许出现 0 张卡的批次')
      assert.ok(Array.isArray(batch.writeDomains), '每批要带写域（调度条显示用）')
    }
  } else {
    assert.match(String(b.scheduler.why), /算不出调度计划/, '算不出就要说原因，不许假装有计划')
  }
  dump('scheduler-plan', { ok: b.scheduler.ok, batches: b.scheduler.batches.length })
})

test('调度条：页面真的画了「为什么不能并行」（源码级断言）', () => {
  const js = readFileSync(join(PANEL, '页面.js'), 'utf8')
  assert.match(js, /var dispatchEl = h\('div', \{ class: 'dispatch' \}\)/)
  assert.match(js, /function paintDispatch/)
  assert.match(js, /var s = snap && snap\.scheduler/)
  assert.match(js, /function paintStamp \(\) \{[^}]*paintDispatch\(\)/)
  assert.match(js, /pageBoard\.insertBefore\(dispatchEl, pageBoard\.firstChild\)/)
  assert.ok(!/append\(rootEl, \[[^\]]*dispatchEl/.test(js), 'dispatch 不该再直接挂在 rootEl 上')
  // 算不出必须说出来，不许显示假计划
  assert.match(js, /调度：算不出/)
  const css = readFileSync(join(PANEL, '页面.css'), 'utf8')
  assert.match(css, /\.dispatch\s*\{/)
  assert.match(css, /\.dp-warn\s*\{[^}]*#d29922/, '热点/未知写域要用提示色，不是错色')
})

test('角色抽屉：coder-a / coder-b / reviewer 都走「载体」分支（不报"不认识的用电器"）', () => {
  const src = readFileSync(join(PANEL, '链路面板.mjs'), 'utf8')
  // 五个角色的 id 表
  assert.match(src, /const CARRIER_ROLES = \['coder-a', 'coder-b', 'reviewer', 'researcher', 'rescue'\]/)
  // detail 用 CARRIER_ROLES.includes(id) 判分支，而不是逐个 if
  assert.match(src, /const carrierRole = CARRIER_ROLES\.includes\(String\(id\)\) \? String\(id\) : null/)
  assert.match(src, /if \(id === 'carrier' \|\| carrierRole\)/)
  // 兜底那句还在（真不认识的 id 才走到这里）
  assert.match(src, /不认识的用电器/)
})

test('上下文占用：两处都只认 contextPressure，拿不到就显示 —（既有实现，加回归）', { skip: SKIP_NO_BOARD }, () => {
  const page = readFileSync(join(PANEL, '页面.js'), 'utf8')
  // 看板页：显示 contextPressure 的原文；≥70% 打警告
  assert.match(page, /d\.context && d\.context\.found \? \('上下文 ' \+ C\.txt\(d\.context\.text\)/)
  assert.match(page, /d\.context\.percent >= 70/)

  const chain = readFileSync(join(PANEL, '链路页.js'), 'utf8')
  // 运转链：只认 contextPressure，拿不到就 —（不拿转录累计冒充）
  assert.match(chain, /窗口占用只认 DSH 会话投影的 contextPressure/)
  assert.match(chain, /m\.contextPercent == null \? '—'/)

  // board-data 必须真带 percent/text（否则上面两处永远显示 —）
  const b = JSON.parse(readFileSync(BOARD, 'utf8'))
  if (b.context && b.context.found) {
    assert.equal(typeof b.context.percent, 'number')
    assert.equal(typeof b.context.text, 'string')
    dump('context-pressure', { percent: b.context.percent, window: b.context.window })
  }
})

test('总览/调度条必须解包信封（服务返回 {ok,generatedAt,source,data}）', () => {
  const js = readFileSync(join(PANEL, '页面.js'), 'utf8')
  // 两处都要先取 true data
  const hits = (js.match(/state\.snap\.data \|\| state\.snap/g) ?? []).length
  assert.ok(hits >= 2, `解包处太少：${hits}（总览与调度条各要一处）`)
  // 不许再直接读 state.snap.overview / state.snap.scheduler
  assert.ok(!/var ov = state\.snap && state\.snap\.overview/.test(js), '总览还在直接读信封')
  assert.ok(!/var s = state\.snap && state\.snap\.scheduler/.test(js), '调度条还在直接读信封')
})
