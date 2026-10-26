/**
 * 阶段 0 · 看板三层权限（§零.5 / §十）
 * 正向：配置区走网关 + 审计能过；操作区走命令能过；
 * 负向：状态区任何写、配置区直写、操作区直改文件 —— 全部拒绝。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  ROUTES, REGIONS, CONFIG_AUDIT_FIELDS, COMMAND_ROUTES,
  regionOfRoute, checkWrite, assertAllowed, assertAudit, auditRecord, commandRouteOf, PermissionError
} from '../_unattended/契约/权限.mjs'
import { dump } from './_助手.mjs'

test('三个区域各按文档的权限口径定义', () => {
  assert.equal(REGIONS.status.permission, 'read-only')
  assert.equal(REGIONS.config.permission, 'write-via-gateway')
  assert.equal(REGIONS.action.permission, 'write-via-command')
  dump('regions', REGIONS)
})

test('状态区：所有写意图一律拒绝（哪怕写的是"配置"）', () => {
  const statusRoutes = Object.entries(ROUTES).filter(([, r]) => r === 'status').map(([k]) => k)
  assert.ok(statusRoutes.includes('/board-data.json'))
  for (const route of statusRoutes) {
    for (const intent of ['write-direct', 'write-gateway', 'write-command']) {
      const r = checkWrite(route, intent)
      assert.equal(r.ok, false, `${route} 在 ${intent} 下不该允许写`)
      assert.equal(r.region, 'status')
      assert.match(r.reason, /状态区只读/)
    }
    assert.equal(checkWrite(route, 'read').ok, true)
  }
  dump('status-routes-readonly', statusRoutes)
})

test('配置区：直写拒绝，走网关则要求审计字段', () => {
  const configRoutes = Object.entries(ROUTES).filter(([, r]) => r === 'config').map(([k]) => k)
  assert.ok(configRoutes.includes('/api-tune'))
  for (const route of configRoutes) {
    assert.equal(checkWrite(route, 'write-direct').ok, false, `${route} 不许直写`)
    assert.equal(checkWrite(route, 'write-command').ok, false, `${route} 不是操作区`)
    const gw = checkWrite(route, 'write-gateway')
    assert.equal(gw.ok, true)
    assert.equal(gw.auditRequired, true)
  }
  dump('config-routes', configRoutes)
})

test('操作区：直写拒绝，走命令则标记 commandRequired', () => {
  const actionRoutes = Object.entries(ROUTES).filter(([, r]) => r === 'action').map(([k]) => k)
  assert.ok(actionRoutes.includes('/brain-say'))
  for (const route of actionRoutes) {
    assert.equal(checkWrite(route, 'write-direct').ok, false)
    const c = checkWrite(route, 'write-command')
    assert.equal(c.ok, true)
    assert.equal(c.commandRequired, true)
  }
})

test('不认识的路径按最保守处理（当状态区，只读）', () => {
  assert.equal(regionOfRoute('/who-knows').id, 'status')
  assert.equal(regionOfRoute('/').id, 'status')
  assert.equal(checkWrite('/who-knows', 'write-direct').ok, false)
  assert.equal(regionOfRoute('/api-tune?x=1').id, 'config')
})

test('审计字段必须是 who/what/before/after/at 五个，少一个就拒', () => {
  const full = { who: '用户', what: 'api-tune contextPct', before: 100, after: 60, at: new Date().toISOString() }
  assert.equal(assertAudit(full), true)
  for (const k of CONFIG_AUDIT_FIELDS) {
    const clone = { ...full }
    delete clone[k]
    assert.throws(() => assertAudit(clone), PermissionError, `缺 ${k} 应拒`)
  }
  assert.throws(() => assertAudit({ ...full, at: '刚才' }), /不是可解析时间/)
  assert.throws(() => assertAudit(null), PermissionError)
})

test('assertAllowed：配置区漏审计 ⇒ 拒；补齐才放行', () => {
  const route = '/carriers-action'
  assert.throws(() => assertAllowed(route, 'write-gateway', { api: 'pi' }), PermissionError)
  const audit = { who: '用户', what: 'carriers+pi', before: null, after: { maxConcurrent: 1 }, at: new Date().toISOString() }
  assert.equal(assertAllowed(route, 'write-gateway', audit).auditRequired, true)
  assert.throws(() => assertAllowed('/board-data.json', 'write-direct'), /状态区只读/)
  assert.throws(() => assertAllowed('/brain-say', 'write-direct'), /必须走 C 服务命令/)
  assert.equal(assertAllowed('/brain-say', 'write-command').commandRequired, true)
})

test('auditRecord 产出的就是配置网关要落的那一行', () => {
  const rec = auditRecord({ who: '用户', what: 'modelProfile:pi|ark|deepseek-v4.1-flash', before: { contextPct: 100 }, after: { contextPct: 60 } })
  assert.equal(rec.schema, 1)
  assert.equal(rec.kind, 'config-audit')
  assert.equal(rec.source, '面板/service.mjs')
  for (const k of CONFIG_AUDIT_FIELDS) assert.ok(Object.hasOwn(rec, k), `审计缺 ${k}`)
  dump('audit-record', rec)
})

test('操作区命令必须先登记（新加操作不许绕过这张表）', () => {
  assert.equal(commandRouteOf('brain-say').path, '/v1/command')
  assert.equal(commandRouteOf('brain-say').op, 'send')
  assert.equal(commandRouteOf('brain-stop').op, 'stop')
  assert.equal(commandRouteOf('continue').op, 'resume')
  assert.throws(() => commandRouteOf('rm -rf'), PermissionError)
  for (const [name, c] of Object.entries(COMMAND_ROUTES)) {
    assert.equal(c.method, 'POST', `${name} 必须是 POST`)
    assert.ok(c.path.startsWith('/v1/'), `${name} 必须走 C 服务 /v1/ 口`)
  }
})
