/**
 * 阶段 3（补）· 批号种子的回归锁（2026-10-26）
 *
 * 事故：`tag = sha1(done.map(id).sort().join(','))`。卡片正常停在 `review` ⇒ done=[] ⇒
 * `sha1('')` = `da39a3ee5e6b` ⇒ **所有 done=[] 的批次共享同一批号** ⇒ `sameTag` 恒真 ⇒
 * 审核轮次（2 轮上限）跨波累计 ⇒ 审核明明 ok（stamp 里 `verdict:"ok"`）却被停手。
 * 落盘证据：`_crew/重构施工-20261025/demo-run/_crew/review-stamp.json` 的 `tag` 就是 da39a3ee5e6b。
 *
 * 这条测试是**源码锁**：批号种子必须是本批全量任务 id，且为空时明确 `unbound`。
 * 为什么不做成运行时单测：那段逻辑在 `编排.mjs` 顶层流程里，import 就会跑主流程（会真派活），
 * 所以只能锁源码形状 —— 这是**有意的取舍**，不是偷懒。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { UNATTENDED } from './_服务夹具.mjs'
import { dump } from './_助手.mjs'

const src = readFileSync(join(UNATTENDED, '编排.mjs'), 'utf8')

test('批号种子取本批全量任务 id，不是只取 done', () => {
  assert.match(src, /const tagSeed = scoped\.map\(r => r\.id\)\.sort\(\)\.join\(','\)/)
  // 反例锁：不许再出现"只哈希 done"的写法
  assert.ok(
    !/createHash\('sha1'\)\.update\(done\.map\(r => r\.id\)/.test(src),
    '批号又变回只哈希 done 了 —— done=[] 时会落到 sha1("")，导致跨波误判同一批'
  )
})

test('种子为空时明确写 unbound，不许落成空哈希', () => {
  assert.match(src, /tagSeed \? createHash\('sha1'\)\.update\(tagSeed\)\.digest\('hex'\)\.slice\(0, 12\) : 'unbound'/)
})

test('待办 id 用 safeBatchTag 兜底（假指纹不许进清单）', () => {
  assert.match(src, /REVIEW-\$\{safeBatchTag\(st\.tag, stamp\)\}/)
  assert.match(src, /da39a3ee5e6b/i, 'safeBatchTag 里应当把 sha1("") 当成"空"来识别')
  dump('tag-seed-lock', 'ok')
})
