/**
 * 阶段 8 · 契约体检 + 5 个公共 Schema + 干净导出（§八 §九）
 *
 * 重点钉住"体检器自己不许造假红/假绿"：
 *   · 注释里提到旧字段 ⇒ 不算违规（剥注释再扫）
 *   · backup/ 里的历史副本 ⇒ 不算现行违规
 *   · 缺文件 ⇒ unknown（不是绿、也不是红）
 *   · 目标目录非空 ⇒ 拒绝导出（不覆盖不合并）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { validate, assertValid, SchemaError } from '../_unattended/_Schema.mjs'
import {
  runChecks, checkRegistry, checkEnvelopes, checkSchemas, checkReviewOk, checkDoubleWrite,
  checkDeadFields, checkHandoff, stripComments, checkConsumers, PUBLIC_SCHEMAS, CONTRACTS_DIR
} from '../_unattended/契约体检.mjs'
import { allowed, listExportable, doctor, exportTo, verifyExport, ALLOW, DENY } from '../scripts/export-open.mjs'
import { envelope } from '../_unattended/契约/信封.mjs'
import { fixture, cleanup, dump } from './_助手.mjs'
import { UNATTENDED } from './_服务夹具.mjs'
import { WORKBENCH } from '../scripts/export-open.mjs'

// ---------------------------------------------------------------- Schema 校验器

test('5 个公共 Schema 都在，且各自的 example 能过', () => {
  assert.deepEqual([...PUBLIC_SCHEMAS], ['task', 'attempt', 'review', 'release', 'board-data'])
  for (const name of PUBLIC_SCHEMAS) {
    const f = join(CONTRACTS_DIR, `${name}.schema.json`)
    assert.ok(existsSync(f), `缺 ${name}.schema.json`)
    const s = JSON.parse(readFileSync(f, 'utf8'))
    assert.ok(s.$id, `${name} 缺 $id`)
    assert.ok((s.examples ?? []).length > 0, `${name} 没有 example`)
    for (const [i, ex] of s.examples.entries()) {
      const r = validate(s, ex)
      assert.equal(r.ok, true, `${name} example#${i} 不过：${r.errors.join('；')}`)
    }
  }
})

test('校验器：不认识 keyword ⇒ 硬错误（不许静默跳过）', () => {
  const r = validate({ type: 'object', 一个没实现的关键字: 1 }, {})
  assert.equal(r.ok, false)
  assert.match(r.errors.join(''), /未知 keyword/)
})

test('校验器：必填/enum/pattern/not/类型 都真的拦得住', () => {
  const s = JSON.parse(readFileSync(join(CONTRACTS_DIR, 'release.schema.json'), 'utf8'))
  const bad = { schema: 1, kind: 'release-status', at: 'x', source: '交付门.mjs', state: 'done', stale: false, snapshotId: 'nope', blockers: [] }
  const r = validate(s, bad)
  assert.equal(r.ok, false)
  assert.ok(r.errors.some(e => /日期时间/.test(e)), r.errors.join('；'))
  assert.ok(r.errors.some(e => /应是/.test(e)))
  assert.ok(r.errors.some(e => /不匹配/.test(e)))
  assert.throws(() => assertValid(s, bad), SchemaError)
  dump('schema-negative', r.errors.slice(0, 3))
})

test('校验器：review 机器块里出现 ok ⇒ 命中 not（调用成功不是审核结论）', () => {
  const s = JSON.parse(readFileSync(join(CONTRACTS_DIR, 'review.schema.json'), 'utf8'))
  const withOk = { schema: 1, decision: 'pass', gateStamp: 'g', snapshotId: 'sha256:' + 'a'.repeat(64), ok: true }
  assert.equal(validate(s, withOk).ok, false)
  const okOne = { schema: 1, decision: 'pass', gateStamp: 'g', snapshotId: 'sha256:' + 'a'.repeat(64) }
  assert.equal(validate(s, okOne).ok, true)
})

// ---------------------------------------------------------------- 契约体检

test('R1 登记表自检：真实登记表是绿的', () => {
  const r = checkRegistry()
  assert.equal(r.length, 1)
  assert.equal(r[0].ok, true, JSON.stringify(r[0].detail))
})

test('R2 信封：缺文件 ⇒ unknown（既不是绿也不是红）', () => {
  const dir = fixture({})
  try {
    const r = checkEnvelopes({ project: dir })
    assert.ok(r.every(x => x.ok === null), '缺文件必须是未知')
    assert.ok(r.every(x => /文件不存在/.test(String(x.detail))))
  } finally { cleanup(dir) }
})

test('R2 信封：合规 ⇒ 绿；缺 source ⇒ 红', () => {
  const dir = fixture({})
  try {
    mkdirSync(join(dir, '_crew'), { recursive: true })
    writeFileSync(join(dir, '_crew', '看护状态.json'), JSON.stringify(envelope({ kind: 'run-health', source: '进度看护.mjs', state: 'green' })), 'utf8')
    const bad = envelope({ kind: 'wake-status', source: '_唤醒.mjs', state: 'green' })
    delete bad.source
    writeFileSync(join(dir, '_crew', '唤醒状态.json'), JSON.stringify(bad), 'utf8')
    const r = checkEnvelopes({ project: dir })
    assert.equal(r.find(x => /run-health/.test(x.id)).ok, true)
    assert.equal(r.find(x => /wake/.test(x.id)).ok, false)
    assert.match(String(r.find(x => /wake/.test(x.id)).detail), /source/)
  } finally { cleanup(dir) }
})

test('R4 review.ok：注释里提到不算违规（剥注释再扫）', () => {
  assert.equal(stripComments('// review.ok 已改成 callOk\nconst x = 1').includes('review.ok'), false)
  assert.equal(stripComments('/* review.ok */ const y = 2').includes('review.ok'), false)
  const r = checkReviewOk()
  assert.ok(r.every(x => x.ok !== false), `不该报红：${JSON.stringify(r.filter(x => x.ok === false))}`)
})

test('R5 同名双写：两个文件都写同一个状态文件 ⇒ 红；单文件 `.tmp+rename` 不算双写', () => {
  const dir = fixture({})
  try {
    writeFileSync(join(dir, 'a.mjs'), `writeFileSync(join(p,'_crew','看护状态.json'), 'x')`, 'utf8')
    writeFileSync(join(dir, 'b.mjs'), `writeFileSync(join(p,'_crew','看护状态.json'), 'y')`, 'utf8')
    let r = checkDoubleWrite([dir])
    assert.ok(r.some(x => x.ok === false), '两个写方应报红')

    // 场景二：只剩一个文件，且它是「写 .tmp 再原子 rename」——这是**同一个写方**，不该报红
    writeFileSync(join(dir, 'a.mjs'), `const s = '别的文件'`, 'utf8')
    writeFileSync(join(dir, 'b.mjs'), `writeFileSync(tmp, 'y'); renameSync(tmp, join(p,'_crew','看护状态.json'))`, 'utf8')
    r = checkDoubleWrite([dir])
    assert.ok(!r.some(x => x.ok === false), `不该报红：${JSON.stringify(r.filter(x => x.ok === false))}`)
  } finally { cleanup(dir) }
})

test('R6 契约：缺 schema ⇒ 红；schema 坏 ⇒ 红', () => {
  const dir = fixture({})
  try {
    const r = checkSchemas({ dir })
    assert.equal(r.filter(x => x.ok === false).length, PUBLIC_SCHEMAS.length)
    writeFileSync(join(dir, 'task.schema.json'), '{坏', 'utf8')
    assert.ok(checkSchemas({ dir }).some(x => /不是合法 JSON/.test(String(x.detail))))
  } finally { cleanup(dir) }
})

test('R7 HANDOFF：机器块存在 ⇒ 手写行被投影，不红；没机器块又有手写 ⇒ 红', () => {
  const dir = fixture({})
  try {
    mkdirSync(join(dir, '_crew'), { recursive: true })
    writeFileSync(join(dir, 'HANDOFF.md'), '已交付：v1\n', 'utf8')
    let r = checkHandoff({ project: dir })
    assert.ok(r.some(x => x.ok === false), '没有机器块又有手写状态 ⇒ 应报红')
    writeFileSync(join(dir, 'HANDOFF.md'), '<!-- RELEASE-BLOCK\n{}\n<!-- /RELEASE-BLOCK -->\n<!-- 已交付：v1 -->\n', 'utf8')
    r = checkHandoff({ project: dir })
    assert.ok(r.every(x => x.ok !== false), '手写行已在注释里 ⇒ 不算红')
  } finally { cleanup(dir) }
})

test('R9 死字段：DEAD_FIELDS 是数组，按字段名扫、跳过 backup/', () => {
  const dir = fixture({})
  try {
    writeFileSync(join(dir, '编排.mjs'), 'const SCOPE_NOISE = [/x/]\n', 'utf8')
    mkdirSync(join(dir, 'backup'), { recursive: true })
    writeFileSync(join(dir, 'backup', '编排.mjs'), 'const closeMin = 90\n', 'utf8')
    const r = checkDeadFields([dir])
    // 只扫声明的文件；backup 不扫；注释不算
    assert.ok(Array.isArray(r))
    assert.ok(!r.some(x => /backup/.test(JSON.stringify(x.detail ?? ''))), 'backup 里的旧写法不许算现行违规')
  } finally { cleanup(dir) }
})

test('runChecks：真工作台上全绿或明确未知，且**没有假红**', async () => {
  const res = await runChecks({ project: WORKBENCH })
  assert.equal(res.kind, 'contract-check')
  assert.equal(res.schema, 1)
  assert.equal(res.source, '契约体检.mjs')
  assert.equal(res.state, res.counts.red ? 'red' : 'green')
  assert.equal(res.ok, res.counts.red === 0)
  const reds = res.checks.filter(c => c.ok === false)
  assert.deepEqual(reds, [], `不该有红项：${JSON.stringify(reds)}`)
  dump('contract-check', { counts: res.counts, reds: reds.length })
})

// ---------------------------------------------------------------- 干净导出

test('允许清单：只认清单内的，密钥/库/备份一律拦', () => {
  assert.equal(allowed('_unattended/门禁.mjs'), true)
  assert.equal(allowed('contracts/task.schema.json'), true)
  assert.equal(allowed('tests/阶段8-契约.test.mjs'), true)
  for (const bad of ['_unattended/secrets/swap-token.txt', '.env', '_crew/state/crew.db', '_unattended/backup/x.mjs', 'logs/a.log', 'evidence/x.json', 'node_modules/a.js']) {
    assert.equal(allowed(bad), false, `${bad} 不该被导出`)
  }
  assert.ok(ALLOW.length > 5 && DENY.length > 5)
})

test('导出体检：真工作台可干净跑（语法全过、无违规）', () => {
  const d = doctor()
  assert.equal(d.syntaxErrors.length, 0, JSON.stringify(d.syntaxErrors.slice(0, 3)))
  assert.equal(d.denied.length, 0, JSON.stringify(d.denied))
  assert.ok(d.counts.files > 100, `文件太少：${d.counts.files}`)
  dump('export-doctor', d.counts)
})

test('导出：真导一次、能核对、非空目录拒绝覆盖', () => {
  const dst = join(WORKBENCH, '_crew', '重构施工-20261025', '_tmp-export')
  try {
    if (existsSync(dst)) rmRf(dst)
    const r = exportTo(dst)
    assert.equal(r.ok, true, r.why)
    assert.ok(r.count > 100)
    const v = verifyExport(dst)
    assert.equal(v.ok, true, JSON.stringify(v.bad?.slice(0, 3)))
    assert.equal(v.files, r.count)
    // 目录里不该有密钥/库
    const all = readdirSync(dst, { recursive: true }).map(String)
    assert.ok(!all.some(p => /secret|\.env|\.db$|token/i.test(p)), `导出里混进了敏感文件：${all.filter(p => /secret|\.env|\.db$|token/i.test(p)).slice(0, 3)}`)
    // 非空目录拒绝
    const again = exportTo(dst)
    assert.equal(again.ok, false)
    assert.match(again.why, /非空/)
    dump('export', { count: r.count, snapshotId: r.snapshotId })
  } finally { if (existsSync(dst)) rmRf(dst) }
})

function rmRf (p) {
  // ⚠️ ESM 里没有 require（第一版写成 require('node:fs').rmSync 被 catch 吞掉 ⇒ 目录没删掉，
  //    下次跑就撞"目标目录非空"，看着像导出逻辑坏了，其实是测试自己的锅）
  rmSync(p, { recursive: true, force: true })
}

test('R10 写方必须有消费方：只被自己提到的产物 ⇒ 红；被两个文件提到 ⇒ 绿', () => {
  const dir = fixture({})
  try {
    mkdirSync(join(dir, 'scripts'), { recursive: true })
    // ① 只有一个文件提到 ⇒ 没人消费
    writeFileSync(join(dir, 'a.mjs'), "const f = '看护状态.json'", 'utf8')
    let r = checkConsumers(['看护状态.json'], [dir])
    assert.equal(r[0].ok, false, '只被一个文件提到应报红')
    assert.match(String(r[0].detail.why), /写完没人读|没有人提它/)

    // ② 第二个文件也提到（读） ⇒ 有消费方
    writeFileSync(join(dir, 'b.mjs'), "readFileSync(join(p, '_crew', '看护状态.json'))", 'utf8')
    r = checkConsumers(['看护状态.json'], [dir])
    assert.equal(r[0].ok, true, '写方 + 读者都在，应判绿')

    // ③ 整个库都没人提 ⇒ 红（说明清单过期或文件是死产物）
    r = checkConsumers(['不存在的产物.json'], [dir])
    assert.equal(r[0].ok, false)
    assert.match(String(r[0].detail.why), /没有人提它/)
  } finally { cleanup(dir) }
})

test('R10 在真工作台上全绿（九个产物都有写方和读者）', () => {
  const r = checkConsumers()
  assert.equal(r.length, 1)
  assert.equal(r[0].ok, true, JSON.stringify(r[0].detail))
})
