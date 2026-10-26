/**
 * 阶段 1（补）· 项目路径归一（2026-10-26 demo 真跑当场抓到的 bug）
 *
 * 现象：`台账 add --project "<相对路径>"` 写进去的 key 与 `编排` 的绝对路径**不是同一个 key**
 * ⇒ 每张卡改状态都 StateRejected / 404，**状态永远推不动**。
 *
 * 修法：唯一一处 `normProject()`；客户端（body + query）与服务端（readBody）都在出口/入口归一，
 * 再加一次幂等迁移把老数据统一过来。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normProject, openDb, migrate, migrateProjectKeys, upsertTask, listTasks } from '../_unattended/_状态库.mjs'
import { startService } from './_服务夹具.mjs'
import { StateClient } from '../_unattended/_状态客户端.mjs'
import { dump } from './_助手.mjs'

// ★W2：夹具路径**运行时从 cwd 算**，文件里一个字面盘符都不留（验收 A4/A5）
const REL_PART = '_crew/重构施工-20261025/demo-run'
const ABS = process.cwd().replace(/\\/g, '/') + '/' + REL_PART
const WIN_FORM = process.cwd() + '\\_crew\\重构施工-20261025\\demo-run'

test('三种写法归一到同一个 key（绝对 / 相对 / 反斜杠+尾斜杠 / 大写盘符）', () => {
  const forms = [
    ABS,
    WIN_FORM,
    ABS + '/',
    '_crew\\重构施工-20261025\\demo-run'
  ]
  const set = new Set(forms.map(normProject))
  assert.equal(set.size, 1, `归一后不唯一：${[...set].join(' | ')}`)
  // ⚠️ 归一**只**小写盘符与斜杠，不整体 toLowerCase —— 目录名里的 `W2` 这种大小写必须保留
  assert.equal([...set][0], ABS.replace(/^[A-Z]:/, m => m.toLowerCase()))
  dump('normProject', [...set])
})

test('null/空串不炸（返回 null，不是 "null" 字符串）', () => {
  assert.equal(normProject(null), null)
  assert.equal(normProject(''), null)
  assert.equal(normProject('   '), null)
})

test('幂等：归一再归一不变', () => {
  const once = normProject(ABS)
  assert.equal(normProject(once), once)
})

test('迁移函数把老 key 统一过来，且可重复执行', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-norm-'))
  try {
    const db = openDb({ dbPath: join(dir, 'crew.db') })
    migrate(db)
    // 故意写一个"反斜杠 + 大写盘符"的旧 key
    const legacy = WIN_FORM
    upsertTask(db, { project: legacy, id: 'T1', wave: 'W1', role: 'coder-a', goal: 'g' })
    assert.equal(listTasks(db, { project: legacy }).length, 1)

    const r1 = migrateProjectKeys(db)
    assert.ok(r1.updated >= 1, `应至少更新 1 行，实际 ${r1.updated}`)
    assert.equal(listTasks(db, { project: normProject(ABS) }).length, 1, '归一后应能用新 key 查到')

    const r2 = migrateProjectKeys(db)
    assert.equal(r2.updated, 0, '第二次迁移不该再更新（幂等）')
    db.close()
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('走真服务：相对路径写的卡，绝对路径能读、能推进状态（demo 真跑那条 bug 的回归）', async () => {
  const svc = await startService()
  const c = new StateClient({ port: svc.port })
  try {
    const REL = '_crew\\重构施工-20261025\\demo-run'
    await c.upsertTask({ project: REL, id: 'N1', wave: 'W1', role: 'coder-a', goal: 'g' })
    const byAbs = await c.tasks(ABS)
    const byRel = await c.tasks(REL)
    assert.equal(byAbs.length, 1, '绝对路径应读得到（出口/入口都归一了）')
    assert.equal(byRel.length, 1)
    assert.equal(byAbs[0].id, byRel[0].id)

    const t = byAbs[0]
    const moved = await c.setTaskStatus({ project: ABS, id: 'N1', to: 'ready', expectedVersion: t.version })
    assert.equal(moved.status, 'ready', '状态应真被推进（原来这里必然 StateRejected）')
    assert.equal(moved.version, t.version + 1)
    dump('norm-e2e', { status: moved.status, version: moved.version })
  } finally { await svc.stop() }
})
