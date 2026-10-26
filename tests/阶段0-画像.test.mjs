/**
 * 阶段 0 · Pi profile 按「载体 + API + 模型」命名，同一载体 maxConcurrent=1（§零.4）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  profileKey, parseProfileKey, normalizeProfile, indexProfiles, profileOf,
  maxConcurrentOf, canRunConcurrently, assertConfigWriteAllowed,
  DEFAULT_CONTEXT_PCT, DEFAULT_COMPACTION_PCT, ALLOWED_CONTEXT_PCT, ALLOWED_COMPACTION_PCT, ProfileError
} from '../_unattended/契约/画像.mjs'
import { dump } from './_助手.mjs'

test('结构键 = 载体|API|模型，三者任一不同就是不同 profile', () => {
  const k1 = profileKey({ carrier: 'pi', provider: 'ark', model: 'deepseek-v4.1-flash' })
  const k2 = profileKey({ carrier: 'pi', provider: 'ocgo', model: 'deepseek-v4.1-flash' })
  const k3 = profileKey({ carrier: 'opencode', provider: 'ark', model: 'deepseek-v4.1-flash' })
  assert.equal(k1, 'pi|ark|deepseek-v4.1-flash')
  assert.equal(new Set([k1, k2, k3]).size, 3)
  assert.deepEqual(parseProfileKey(k1), { carrier: 'pi', provider: 'ark', model: 'deepseek-v4.1-flash' })
  dump('profile-keys', [k1, k2, k3])
})

test('负向：缺任一维 / key 含分隔符 / 反解不对 都要抛', () => {
  assert.throws(() => profileKey({ carrier: 'pi', provider: 'ark' }), /缺模型/)
  assert.throws(() => profileKey({ carrier: 'pi', model: 'm' }), /缺 API/)
  assert.throws(() => profileKey({ provider: 'ark', model: 'm' }), /缺载体/)
  assert.throws(() => profileKey({ carrier: 'pi|x', provider: 'ark', model: 'm' }), /分隔符/)
  assert.throws(() => parseProfileKey('pi|ark'), ProfileError)
  assert.throws(() => parseProfileKey(''), ProfileError)
})

test('默认值：上下文 100% + 压缩阈值 60%（用户 2026-10-26 拍板，不分重/轻任务）', () => {
  assert.equal(DEFAULT_CONTEXT_PCT, 100)
  assert.equal(DEFAULT_COMPACTION_PCT, 60)
  const p = normalizeProfile({ carrier: 'pi', provider: 'ark', model: 'm', name: 'coder-a-heavy' })
  assert.equal(p.contextPct, 100)
  assert.equal(p.compactionPct, 60)
  assert.equal(p.key, 'pi|ark|m')
  assert.equal(p.name, 'coder-a-heavy')
  assert.equal(p.schema, 1)
  assert.equal(p.kind, 'model-profile')
  dump('profile-default', p)
})

test('面板只给这几档，别的值一律拒', () => {
  assert.deepEqual([...ALLOWED_CONTEXT_PCT], [30, 60, 100])
  assert.deepEqual([...ALLOWED_COMPACTION_PCT], [50, 60, 70, 80])
  for (const pct of [30, 60, 100]) {
    assert.equal(normalizeProfile({ carrier: 'pi', provider: 'a', model: 'm', contextPct: pct }).contextPct, pct)
  }
  assert.throws(() => normalizeProfile({ carrier: 'pi', provider: 'a', model: 'm', contextPct: 55 }), /上下文比例/)
  assert.throws(() => normalizeProfile({ carrier: 'pi', provider: 'a', model: 'm', compactionPct: 90 }), /压缩阈值/)
})

test('作用域唯一：同一 carrier|provider|model 登记两份必须失败', () => {
  const dup = [
    { name: 'a', carrier: 'pi', provider: 'ark', model: 'm' },
    { name: 'b', carrier: 'pi', provider: 'ark', model: 'm', contextPct: 60 }
  ]
  assert.throws(() => indexProfiles(dup), /登记了两份/)
  const ok = indexProfiles([
    { name: 'a', carrier: 'pi', provider: 'ark', model: 'm' },
    { name: 'b', carrier: 'pi', provider: 'ocgo', model: 'm', contextPct: 60 }
  ])
  assert.equal(ok.list.length, 2)
  // 名字重复也要拒（角色只引用名字，重名就等于指错）
  assert.throws(() => indexProfiles([
    { name: 'same', carrier: 'pi', provider: 'ark', model: 'm' },
    { name: 'same', carrier: 'pi', provider: 'ocgo', model: 'm' }
  ]), /重名/)
})

test('取 profile：取不到就抛，绝不静默退回 Pi 默认 128K/16K', () => {
  const profiles = [{ name: 'heavy', carrier: 'pi', provider: 'ark', model: 'm' }]
  assert.equal(profileOf(profiles, { carrier: 'pi', provider: 'ark', model: 'm' }).name, 'heavy')
  assert.throws(() => profileOf(profiles, { carrier: 'pi', provider: 'ocgo', model: 'm' }), /不许退回 Pi 默认/)
})

test('同一载体 maxConcurrent=1：同一载体两个 attempt 不许并行', () => {
  assert.equal(maxConcurrentOf('pi'), 1)
  assert.equal(maxConcurrentOf('opencode'), 1)
  assert.equal(maxConcurrentOf('没登记的载体'), 1) // 保守：宁可排队
  const same = canRunConcurrently({ carrier: 'pi', key: 'pi|ark|m' }, { carrier: 'pi', key: 'pi|ocgo|m' })
  assert.equal(same.ok, false)
  assert.match(same.reason, /同一载体 pi 不许并行/)
  const diff = canRunConcurrently({ carrier: 'pi' }, { carrier: 'opencode' })
  assert.equal(diff.ok, true)
  assert.equal(canRunConcurrently(null, {}).ok, false)
})

test('配置写入只能在两个 attempt 之间：有 attempt 在跑就拒', () => {
  assert.equal(assertConfigWriteAllowed({ carrier: 'pi', runningAttempts: 0 }), true)
  assert.throws(() => assertConfigWriteAllowed({ carrier: 'pi', runningAttempts: 1 }), /不许并发写 models\.json/)
  dump('config-write-guard', ['runningAttempts=0 → 允许', 'runningAttempts=1 → 拒'])
})
