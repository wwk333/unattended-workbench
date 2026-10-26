/**
 * 阶段 7（补）· 顶栏「重启」按钮 + 自检灯（用户 2026-10-26 要求）
 *
 * 绿灯＝磁盘代码与运行中一致；黄灯＝磁盘更新了（该重启）。
 * 这里**不真重启**（会打断正在用的面板），只验：自检口形状、重启口只收 POST、权限分区、
 * 前端按钮位置与三态、服务端是 spawn 助手而不是自杀。
 *
 * ⚠️ 用**独立端口**起一个真面板实例（19452），不碰 19450 那个你在用的。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { regionOfRoute } from '../_unattended/契约/权限.mjs'
import { UNATTENDED } from './_服务夹具.mjs'
import { dump } from './_助手.mjs'

const PANEL = join(UNATTENDED, '面板')
const PORT = 19452

function startPanel () {
  const p = spawn(process.execPath, [join(PANEL, 'service.mjs')], {
    cwd: PANEL,
    // ★ 2026-10-26：**测试实例绝不能写真的登记册** —— 上一轮它把 19452 写进 `_crew\服务登记.json`，
    //   覆盖了真看板那条登记，导致「长命资源」灯变红（红得"有据"，但依据是错记录）。
    // ★W5（污染根治）：面板启动会**顺手跑一次长命资源巡检**，默认写 `_crew\长命资源状态.json` ——
    //   于是"真产物"类断言第一遍红、第二遍绿（纯看并行时序）。这里把它的落点也重定向到 TEMP。
    env: {
      ...process.env,
      DSH_PANEL_PORT: String(PORT),
      DSH_SERVICE_REG: join(process.env.TEMP || '.', 'dsh-test-registry-' + process.pid + '.json'),
      DSH_LONGLIVE_STATUS_FILE: join(process.env.TEMP || '.', 'dsh-test-longlive-' + process.pid + '.json')
    },
    stdio: 'ignore',
    windowsHide: true
  })
  const stop = () => { try { p.kill('SIGKILL') } catch {} }
  return { p, stop }
}

// ★W2：冷目录首次启动（空 _crew、FS 无缓存）实测能超过 15 秒 ⇒ 给到 30 秒，不降低断言强度
async function waitUp (ms = 30000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/panel-self.json`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) return await r.json()
    } catch {}
    await new Promise(r => setTimeout(r, 250))
  }
  throw new Error('面板没起来')
}

test('自检口：形状对，needRestart 是布尔、state 与它一致', async () => {
  const { stop } = startPanel()
  try {
    const r = await waitUp()
    assert.equal(r.schema, 1)
    assert.equal(r.kind, 'panel-self')
    assert.equal(r.source, 'service.mjs')
    assert.equal(typeof r.needRestart, 'boolean')
    assert.equal(r.state, r.needRestart ? 'yellow' : 'green')
    assert.ok(Number(r.pid) > 0)
    assert.ok(Array.isArray(r.newer))
    assert.ok(r.bootFiles >= 10, `启动时统计的文件太少：${r.bootFiles}`)
    if (r.needRestart) assert.match(String(r.why), /点「重启」生效/)
    dump('panel-self', { state: r.state, bootFiles: r.bootFiles, pid: r.pid })
  } finally { stop() }
})

test('重启口：GET 必须 405（不许误触），POST 走权限闸', async () => {
  const { stop } = startPanel()
  try {
    await waitUp()
    const g = await fetch(`http://127.0.0.1:${PORT}/panel-restart`)
    assert.equal(g.status, 405)
    const b = await g.json()
    assert.match(String(b.error), /只接受 POST/)
  } finally { stop() }
})

test('权限表：重启属操作区，自检属状态区', () => {
  assert.equal(regionOfRoute('/panel-restart').id, 'action')
  assert.equal(regionOfRoute('/panel-self.json').id, 'status')
})

test('前端：按钮在「载体」左边，三态样式齐', () => {
  const js = readFileSync(join(PANEL, '页面.js'), 'utf8')
  const css = readFileSync(join(PANEL, '页面.css'), 'utf8')
  assert.match(js, /var restartBtn = h\('button'/)
  assert.match(js, /var restartLamp = h\('i', \{ class: 'rs-lamp rs-unknown'/)
  assert.match(js, /\[restartBtn, navBtns\.carrier, navBtns\.api, navBtns\.chain, navBtns\.manage, buildTagEl\]/)
  for (const k of ['green', 'yellow', 'unknown']) assert.ok(css.includes(`.rs-lamp.rs-${k}`), `CSS 缺 .rs-lamp.rs-${k}`)
  assert.match(js, /fetch\('\/panel-restart', \{ method: 'POST'/)
  assert.match(js, /j\.pid !== oldPid/)
})

test('服务端：重启是 spawn 助手（不是自杀），助手存在且语法可用', () => {
  const svc = readFileSync(join(PANEL, 'service.mjs'), 'utf8')
  assert.match(svc, /_self-restart\.mjs/)
  assert.match(svc, /detached: true/)
  assert.match(svc, /setTimeout\(\(\) => process\.exit\(0\), 1500\)/)
  const helper = join(PANEL, '_self-restart.mjs')
  assert.ok(existsSync(helper))
  const h = readFileSync(helper, 'utf8')
  assert.match(h, /只等不杀/)
  assert.match(h, /spawn\(process\.execPath, \[service\]/)
})
