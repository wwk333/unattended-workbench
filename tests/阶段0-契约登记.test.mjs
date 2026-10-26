/**
 * 阶段 0 · 一层一个写方 + 每个写方有消费方（§零.3 / §零.8 / §八.1）
 * 最重要的一条：**真的核心登记表必须过校验** —— 否则契约自己就是假的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  CORE_CONTRACT_PATH, DEAD_FIELDS, REGISTRY_ERRORS,
  loadRegistry, validateRegistry, assertRegistry, writerIndex, consumerIndex, factOf, assertWriter, RegistryError
} from '../_unattended/契约/写方.mjs'
import { fixture, cleanup, dump, readJson } from './_助手.mjs'

test('真实核心契约登记表必须校验通过（这是本阶段的自证）', () => {
  const reg = loadRegistry()
  const r = validateRegistry(reg)
  if (!r.ok) console.error(JSON.stringify(r.errors, null, 2))
  assert.equal(r.ok, true, `核心契约登记表有 ${r.errors.length} 条违规`)
  assert.ok(reg.items.length >= 15, `登记条目太少（${reg.items.length}）`)
  dump('core-registry', {
    layers: reg.layers,
    items: reg.items.length,
    facts: reg.items.filter(i => i.kind === 'fact').length,
    views: reg.items.filter(i => i.kind === 'view').length,
    warnings: r.warnings
  })
})

test('真实登记表里每条 fact 都有 writer / 至少一个外部 consumer / 不许 unknown 当绿', () => {
  const reg = loadRegistry()
  for (const it of reg.items.filter(i => i.kind === 'fact')) {
    assert.equal(typeof it.writer, 'string')
    assert.ok(Array.isArray(it.consumers) && it.consumers.length >= 1, `${it.id} 无消费者`)
    assert.notEqual(it.unknownIsGreen, true, `${it.id} 把 unknown 当绿`)
    assert.ok(['blocked', 'red', 'unknown', 'allow', 'fail-closed', 'not-applicable'].includes(it.onMissing), `${it.id}.onMissing`)
  }
})

test('负向：同一 authority 两个 writer 必须失败', () => {
  const bad = {
    items: [
      { id: 'a.one', kind: 'fact', authority: 'X.json', writer: '甲.mjs', consumers: ['看板'], onMissing: 'blocked', onStale: 'blocked', unknownIsGreen: false },
      { id: 'a.two', kind: 'fact', authority: 'X.json', writer: '乙.mjs', consumers: ['看板'], onMissing: 'blocked', onStale: 'blocked', unknownIsGreen: false }
    ]
  }
  const r = validateRegistry(bad)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.code === REGISTRY_ERRORS.MULTI_WRITER))
  dump('multi-writer-error', r.errors)
})

test('负向：writer 字段里写"多个人"也算多写方', () => {
  const r = validateRegistry({
    items: [{ id: 'a', kind: 'fact', authority: 'X', writer: '甲.mjs 和 乙.mjs', consumers: ['看板'], onMissing: 'blocked', onStale: 'blocked', unknownIsGreen: false }]
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.code === REGISTRY_ERRORS.MULTI_WRITER))
})

test('负向：没有消费者 ⇒ 必须删字段（§零.8）', () => {
  const r = validateRegistry({
    items: [{ id: 'dead.field', kind: 'fact', authority: 'Y.json', writer: '甲.mjs', consumers: [], onMissing: 'blocked', onStale: 'blocked', unknownIsGreen: false }]
  })
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => e.code === REGISTRY_ERRORS.NO_CONSUMER))
})

test('负向：唯一消费者就是写方自己 ⇒ 等于没人看', () => {
  const r = validateRegistry({
    items: [{ id: 'x', kind: 'fact', authority: 'Y', writer: '甲.mjs', consumers: ['甲.mjs'], onMissing: 'blocked', onStale: 'blocked', unknownIsGreen: false }]
  })
  assert.ok(r.errors.some(e => e.code === REGISTRY_ERRORS.CONSUMER_SELF))
})

test('负向：unknownIsGreen=true / 缺 writer / 非法枚举 都要报', () => {
  const r = validateRegistry({
    items: [
      { id: 'p', kind: 'fact', authority: 'P', writer: 'w.mjs', consumers: ['看板'], onMissing: 'blocked', onStale: 'blocked', unknownIsGreen: true },
      { id: 'q', kind: 'fact', authority: 'Q', consumers: ['看板'], onMissing: 'blocked', onStale: 'blocked', unknownIsGreen: false },
      { id: 'r', kind: 'nope', authority: 'R', writer: 'w.mjs', consumers: ['看板'], onMissing: 'blocked', onStale: 'blocked', unknownIsGreen: false },
      { id: 's', kind: 'fact', authority: 'S', writer: 'w.mjs', consumers: ['看板'], onMissing: 'maybe', onStale: 'maybe', unknownIsGreen: false }
    ]
  })
  const codes = r.errors.map(e => e.code)
  assert.ok(codes.includes(REGISTRY_ERRORS.UNKNOWN_GREEN))
  assert.ok(codes.includes(REGISTRY_ERRORS.NO_WRITER))
  assert.ok(codes.includes(REGISTRY_ERRORS.BAD_KIND))
  assert.ok(codes.includes(REGISTRY_ERRORS.BAD_ON_MISSING))
  dump('registry-error-codes', [...new Set(codes)])
})

test('负向：ID 重复、空登记表 都要失败', () => {
  const dup = validateRegistry({
    items: [
      { id: 'same', kind: 'fact', authority: 'A', writer: 'a.mjs', consumers: ['看板'], onMissing: 'blocked', onStale: 'blocked', unknownIsGreen: false },
      { id: 'same', kind: 'fact', authority: 'B', writer: 'b.mjs', consumers: ['看板'], onMissing: 'blocked', onStale: 'blocked', unknownIsGreen: false }
    ]
  })
  assert.ok(dup.errors.some(e => e.code === REGISTRY_ERRORS.ID_DUP))
  const empty = validateRegistry({ items: [] })
  assert.equal(empty.ok, false)
})

test('核心 + 项目两层按 ID 合并，重复 ID 直接失败', () => {
  const dir = fixture({ 'proj/契约.json': { items: [] } })
  try {
    const core = readJson(CORE_CONTRACT_PATH)
    const projectPath = join(dir, 'proj', '契约.json')
    const merged = loadRegistry({ projectPath })
    assert.equal(merged.layers.length, 2)
    assert.equal(merged.items.length, core.items.length)

    writeFileSync(projectPath, JSON.stringify({ items: [{ ...core.items[0] }] }), 'utf8')
    assert.throws(() => loadRegistry({ projectPath }), RegistryError)
  } finally { cleanup(dir) }
})

test('writerIndex / consumerIndex 能回答"谁写这份"和"谁在看"', () => {
  const reg = loadRegistry()
  const wi = writerIndex(reg)
  const ci = consumerIndex(reg)
  assert.deepEqual(wi.get('_crew/release-status.json'), ['交付门.mjs'])
  assert.ok((ci.get('看板数据.mjs') ?? []).length >= 5, '看板应是主要消费方')
  assert.ok(ci.has('HANDOFF.md 生成块'))
  dump('indexes', { authorities: wi.size, consumers: ci.size })
})

test('factOf / assertWriter：写错方直接抛（不是警告）', () => {
  const reg = loadRegistry()
  assert.equal(factOf(reg, 'fact.release-status').writer, '交付门.mjs')
  assert.throws(() => factOf(reg, 'fact.nonexistent'), RegistryError)
  assert.equal(assertWriter(reg, 'fact.release-status', '交付门.mjs'), true)
  assert.throws(() => assertWriter(reg, 'fact.release-status', '_唤醒.mjs'), /唯一写方/)
})

test('assertRegistry 对真实登记表不抛', () => {
  assert.doesNotThrow(() => assertRegistry(loadRegistry()))
})

test('DEAD_FIELDS 已登记文档点名的死字段，且每条都有 why 和判据', () => {
  const ids = DEAD_FIELDS.map(d => d.id)
  for (const must of ['dead.review.ok', 'dead.closeMin', 'dead.requestMaxTokens']) assert.ok(ids.includes(must), `缺 ${must}`)
  for (const d of DEAD_FIELDS) {
    assert.ok(d.why && d.why.length > 10, `${d.id} 没写清为什么删`)
    assert.ok(d.pattern instanceof RegExp, `${d.id} 没有机器判据`)
  }
  dump('dead-fields', DEAD_FIELDS.map(d => d.id))
})
