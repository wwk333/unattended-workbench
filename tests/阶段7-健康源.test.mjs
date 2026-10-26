/**
 * 阶段 7（补）· 健康源统一读取 —— **修掉"硬编码 sources ⇒ 假绿"**
 *
 * §十：board-data 是缓存视图，必须带 `sources[]` 与 `stale`，且**缺文件/缺信封不许当绿**。
 * 这里逐条钉住灯位映射与"缺即未知"。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { readHealthSources, releaseLamp, gateLamp, describeHealth, SOURCE_DEFS, WORKBENCH } from '../_unattended/_健康源.mjs'
import { envelope } from '../_unattended/契约/信封.mjs'
import { fixture, cleanup, dump } from './_助手.mjs'
import { UNATTENDED } from './_服务夹具.mjs'

function put (dir, rel, obj) {
  const p = join(dir, rel)
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2), 'utf8')
}

test('七个源都在表里，写方各不同（四份健康 + 交付 + 门禁 + 契约）', () => {
  assert.equal(SOURCE_DEFS.length, 7)
  const ids = SOURCE_DEFS.map(s => s.id)
  for (const id of ['run-health', 'card-health', 'longlive', 'wake', 'release', 'gate', 'contract']) assert.ok(ids.includes(id), `缺 ${id}`)
  const writers = SOURCE_DEFS.map(s => s.writer)
  assert.equal(new Set(writers).size, writers.length, '每个源必须只有一个写方（不许同名双写）')
  dump('health-defs', SOURCE_DEFS.map(s => `${s.id}←${s.writer}`))
})

test('交付状态词 → 灯：只有 accepted 是绿；ready 是黄；blocked/rejected/stale 是红', () => {
  assert.equal(releaseLamp('accepted'), 'green')
  assert.equal(releaseLamp('ready'), 'yellow')
  for (const s of ['blocked', 'rejected', 'stale']) assert.equal(releaseLamp(s), 'red')
  assert.equal(releaseLamp('nonsense'), 'unknown')
  assert.equal(releaseLamp(undefined), 'unknown')
})

test('门禁产物 → 灯：ok 且非 degraded 才绿；degraded 只算未知', () => {
  assert.equal(gateLamp({ ok: true }), 'green')
  assert.equal(gateLamp({ ok: true, degraded: true }), 'unknown')
  assert.equal(gateLamp({ ok: false }), 'red')
  assert.equal(gateLamp(null), 'unknown')
})

test('缺文件 ⇒ unknown（不是绿、也不是红）', () => {
  const dir = fixture({})
  try {
    const h = readHealthSources({ project: dir, workbench: dir })
    assert.equal(h.sources.length, 7)
    for (const s of h.sources) {
      assert.equal(s.exists, false)
      assert.equal(s.state, 'unknown', `${s.id} 缺文件应 unknown`)
      assert.equal(s.stale, false)
    }
    assert.equal(h.summary.unknown, 7)
    assert.equal(h.allGreen, false)
    assert.match(describeHealth(h), /未知 7/)
    dump('health-missing', h.summary)
  } finally { cleanup(dir) }
})

test('合规信封 ⇒ 按 state 出灯；stale:true ⇒ 不算绿且汇总 stale', () => {
  const dir = fixture({})
  try {
    put(dir, '_crew/看护状态.json', envelope({ kind: 'run-health', source: '进度看护.mjs', state: 'green' }))
    put(dir, '_crew/卡片看护.json', envelope({ kind: 'card-health', source: '_监控.mjs', state: 'red' }))
    put(dir, '_crew/唤醒状态.json', envelope({ kind: 'wake-status', source: '_唤醒.mjs', state: 'green' }))
    put(dir, '_crew/长命资源状态.json', envelope({ kind: 'longlive-status', source: '长命资源巡检.mjs', state: 'green' }))
    put(dir, '_crew/release-status.json', { ...envelope({ kind: 'release-status', source: '交付门.mjs', state: 'ready' }), state: 'ready' })
    put(dir, '_crew/gate/gate-result.json', { ...envelope({ kind: 'gate-result', source: '门禁.mjs', state: 'green' }), ok: true })
    put(dir, '_crew/gate/contract-check.json', { ...envelope({ kind: 'contract-check', source: '契约体检.mjs', state: 'green' }), ok: true })

    const h = readHealthSources({ project: dir, workbench: dir })
    const by = Object.fromEntries(h.sources.map(s => [s.id, s]))
    assert.equal(by['run-health'].state, 'green')
    assert.equal(by['card-health'].state, 'red')
    assert.equal(by['wake'].state, 'green')
    assert.equal(by['longlive'].state, 'green')
    assert.equal(by['release'].state, 'yellow', 'ready 只是等你验收，不是绿')
    assert.equal(by['gate'].state, 'green')
    assert.equal(by['contract'].state, 'green')
    assert.equal(h.stale, false)
    assert.equal(h.summary.red, 1)
    assert.deepEqual(h.redIds, ['card-health'])
    dump('health-lights', h.summary)
  } finally { cleanup(dir) }
})

test('stale:true 的源不算绿（汇总 stale=true）', () => {
  const dir = fixture({})
  try {
    put(dir, '_crew/看护状态.json', envelope({ kind: 'run-health', source: '进度看护.mjs', state: 'green', stale: true }))
    const h = readHealthSources({ project: dir, workbench: dir })
    const s = h.sources.find(x => x.id === 'run-health')
    assert.equal(s.stale, true)
    assert.equal(s.state, 'unknown', 'stale 的源不许当绿')
    assert.equal(h.stale, true)
  } finally { cleanup(dir) }
})

test('坏 JSON ⇒ unknown，不当绿', () => {
  const dir = fixture({})
  try {
    mkdirSync(join(dir, '_crew'), { recursive: true })
    writeFileSync(join(dir, '_crew', '看护状态.json'), '{坏', 'utf8')
    const h = readHealthSources({ project: dir, workbench: dir })
    assert.equal(h.sources.find(s => s.id === 'run-health').state, 'unknown')
  } finally { cleanup(dir) }
})

test('没有项目 ⇒ 项目级源全 unknown（不假装读了）', () => {
  const dir = fixture({})
  try {
    const h = readHealthSources({ project: null, workbench: dir })
    const proj = h.sources.filter(s => SOURCE_DEFS.find(d => d.id === s.id).level === 'project')
    assert.ok(proj.every(s => s.state === 'unknown' && /没有项目/.test(s.why)))
  } finally { cleanup(dir) }
})

test('board-data 不再硬编码 sources（假绿已修）', () => {
  const board = readFileSync(join(UNATTENDED, '看板数据.mjs'), 'utf8')
  assert.match(board, /readHealthSources\(/)
  assert.ok(!/state: 'read', stale: false/.test(board), '仍有硬编码的 read/false')
  assert.match(board, /data\.health =/, 'board-data 必须带 health 汇总')
})

// ★W2（D22）：这条断言"真实工作台里有长命资源状态"，包里没有那份数据 ⇒ 明说跳过
const LONGLIVE_REAL = join(WORKBENCH, '_crew', '长命资源状态.json')
// ⚠️ 只认**跑测试之前就存在**的那份：并行跑的"面板"用例会现写一份真产物，
//    那份不算"真实工作台"（否则同一条用例第一遍红、第二遍绿，纯看时序）
const _T0 = Date.now()
function preexisting (p) {
  try { return existsSync(p) && statSync(p).mtimeMs < _T0 } catch { return false }
}
const SKIP_NO_LONGLIVE = preexisting(LONGLIVE_REAL) ? false : '需要**跑测试之前就存在**的 _crew/长命资源状态.json（开源包里不带运行时数据）'
test('真实工作台：长命资源与看护状态的信封现在是合规的（本轮真修过）', { skip: SKIP_NO_LONGLIVE }, () => {
  const h = readHealthSources({ project: WORKBENCH, workbench: WORKBENCH })
  const longlive = h.sources.find(s => s.id === 'longlive')
  assert.equal(longlive.exists, true, '长命资源状态.json 应存在')
  assert.notEqual(longlive.state, 'unknown', '长命资源应有明确灯位（信封已补全）')
  dump('real-health', h.sources.map(s => `${s.id}=${s.state}`))
})

test('写方在读方之外的根（run 健康就是这样）⇒ 挑**信封合格**的那份，并写明读了哪个文件', () => {
  const proj = fixture({})
  const wb = fixture({})
  try {
    // 项目里留一份**旧格式**（没 source）⇒ 不合格
    mkdirSync(join(proj, '_crew'), { recursive: true })
    writeFileSync(join(proj, '_crew', '看护状态.json'), JSON.stringify({ schema: 1, at: new Date().toISOString(), state: 'green' }), 'utf8')
    // 工作台里是新的、合格的
    mkdirSync(join(wb, '_crew'), { recursive: true })
    writeFileSync(join(wb, '_crew', '看护状态.json'), JSON.stringify(envelope({ kind: 'run-health', source: '进度看护.mjs', state: 'green' })), 'utf8')
    const h = readHealthSources({ project: proj, workbench: wb })
    const r = h.sources.find(s => s.id === 'run-health')
    assert.equal(r.state, 'green', '应挑合格的那份（工作台），而不是死认项目路径')
    assert.match(r.file, /_crew[\\/]看护状态\.json$/)
    assert.ok(r.file.startsWith(wb), `应读工作台那份，实际 ${r.file}`)
  } finally { cleanup(proj); cleanup(wb) }
})

test('写方改名后，读方必须跟着改（链路面板读 卡片看护.json，不是 看护状态.json）', () => {
  const chain = readFileSync(join(UNATTENDED, '面板', '链路面板.mjs'), 'utf8')
  // 唯一读法：卡片看护.json
  assert.match(chain, /readFileSync\(join\(proj\.path, '_crew', '卡片看护\.json'\)/)
  // 不许再按旧名读（注释里提到不算 —— 剥注释后断言）
  const code = chain.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1')
  assert.ok(!/readFileSync\(join\(proj\.path, '_crew', '看护状态\.json'\)/.test(code), '链路面板还在读旧的 看护状态.json')
  // 提示语也要说清楚来源与刷新节奏（不编"实时"）
  assert.match(chain, /近实时（卡片看护\.json，约 10 秒刷新）/)
})
