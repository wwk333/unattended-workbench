/**
 * 阶段 3 · 静态 AC 的第一张卡例外（§六「第一张卡的静态 AC 例外」）
 *
 * 死锁场景：项目第一张卡的任务就是"创建测试脚本"，而静态校验判据①要求脚本必须存在
 * ⇒ 这张卡永远被 exit 3 挡死，谁也开不了工。
 * 口径：脚本在本卡交付物里 ⇒ `AC_PENDING_CREATE` 放行；不在 ⇒ 仍然 exit 3。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { validateAccept, scriptOf } from '../_unattended/_静态AC.mjs'
import { fixture, cleanup, dump } from './_助手.mjs'

const BT = '`' // 反引号（避免在字符串里写反引号把文件搞乱）

function ac (cmd, expect = '全过') {
  return `${BT}${cmd}${BT} → ${expect}`
}

test('脚本不存在、也不在交付物 ⇒ 仍然挡下（不启动模型）', () => {
  const dir = fixture({})
  try {
    const r = validateAccept({ accept: [ac('node tests/new.mjs')], project: dir })
    assert.equal(r.ok, false)
    assert.equal(r.blocked.length, 1)
    assert.equal(r.pendingCreate.length, 0)
    assert.match(r.blocked[0].why, /脚本不存在/)
    dump('ac-blocked', r.blocked)
  } finally { cleanup(dir) }
})

test('脚本不存在、但**在本卡交付物里** ⇒ AC_PENDING_CREATE 放行', () => {
  const dir = fixture({})
  try {
    const r = validateAccept({ accept: [ac('node tests/new.mjs')], project: dir, deliverables: ['tests/new.mjs'] })
    assert.equal(r.ok, true, JSON.stringify(r.blocked))
    assert.equal(r.blocked.length, 0)
    assert.equal(r.pendingCreate.length, 1)
    assert.equal(r.pendingCreate[0].script, 'tests/new.mjs')
    assert.match(r.pendingCreate[0].why, /完成时必须真实存在且通过/)
    dump('ac-pending', r.pendingCreate)
  } finally { cleanup(dir) }
})

test('交付物里写的是 ./ 或反斜杠形式也要认（路径归一）', () => {
  const dir = fixture({})
  try {
    for (const d of ['./tests/new.mjs', 'tests\\new.mjs']) {
      const r = validateAccept({ accept: [ac('node tests/new.mjs')], project: dir, deliverables: [d] })
      assert.equal(r.pendingCreate.length, 1, `交付物写法 ${d} 没被认出来`)
    }
  } finally { cleanup(dir) }
})

test('脚本已存在 ⇒ 不再走 pending（照旧查期望串）', () => {
  const dir = fixture({ 'tests/ok.mjs': 'console.log("全过")\n' })
  try {
    const r = validateAccept({ accept: [ac('node tests/ok.mjs')], project: dir, deliverables: ['tests/ok.mjs'] })
    assert.equal(r.pendingCreate.length, 0)
    assert.equal(r.checked, 1)
    assert.equal(r.ok, true)
  } finally { cleanup(dir) }
})

test('期望串在脚本里完全没有出处 ⇒ 仍挡（与 pending 无关）', () => {
  const dir = fixture({ 'tests/ok.mjs': 'console.log("别的")\n' })
  try {
    const r = validateAccept({ accept: [ac('node tests/ok.mjs', '21 条全 PASS')], project: dir })
    assert.equal(r.ok, false)
    assert.match(r.blocked[0].why, /找不到出处/)
  } finally { cleanup(dir) }
})

test('负向：反引号不成对仍挡（格式坏优先于 pending）', () => {
  const dir = fixture({})
  try {
    const r = validateAccept({ accept: [`${BT}node tests/new.mjs → 全过`], project: dir, deliverables: ['tests/new.mjs'] })
    assert.equal(r.ok, false)
    assert.match(r.blocked[0].why, /反引号不成对/)
  } finally { cleanup(dir) }
})

test('scriptOf：认得跑器+脚本路径；认不出就返回 null（不误杀）', () => {
  assert.equal(scriptOf('node tests/a.mjs'), 'tests/a.mjs')
  assert.equal(scriptOf('python tests/t.py'), 'tests/t.py')
  assert.equal(scriptOf('python -m pytest'), null)
  assert.equal(scriptOf('node -e "x"'), null)
  assert.equal(scriptOf('npm test'), null)
  assert.equal(scriptOf('node tests/a.mjs | tee out.txt'), null)
})
