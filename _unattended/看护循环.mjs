#!/usr/bin/env node
/**
 * 看护循环 —— 每 5 分钟跑一次 `进度看护.mjs`（零 token、只读、幂等）
 *
 * 为什么需要它：`进度看护.mjs` 是**一次性**脚本（跑完就退），但它的职责是"持续盯：
 * 编排进程还活着吗 / 有没有新产物 / 账本有没有新增 / 卡住了就叫醒大脑"。
 * 没有循环 = 只在有人手动跑的那一刻看一眼 = "自动叫醒"形同虚设。
 *
 * 本脚本是那条循环：每 `--interval` 秒（默认 300 = 5 分钟）跑一次，异常时才叫醒（去重在进度看护内部）。
 *
 * 用法：
 *   node 看护循环.mjs                    # 常驻循环（默认 300s 一轮）
 *   node 看护循环.mjs --interval 60      # 改轮询间隔
 *   node 看护循环.mjs --once             # 只跑一轮就退（等于直接跑 进度看护.mjs）
 *
 * 谁调它：
 *   ① `确保看守.mjs`（一键启动所有看守）
 *   ② 侧边栏插件启动时自动拉起
 */
import { spawnSync, spawn } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WATCHDOG = join(HERE, '进度看护.mjs')
// ★ 2026-10-18（用户拍板）：工作台住在安装目录里，桌面端更新会整目录改名+删除
//   ⇒ 每轮顺手调一次「备份-工作台.mjs --if-due」（它自己判距上次是否 ≥1h，不到就直接退）。
const BACKUP = join(HERE, '备份-工作台.mjs')
// ★ 2026-10-24（施工文档 §12.8）：样本补扫（幂等）—— 兜"编排收尾前崩了"与"旧版本跑的那几轮"。
const SCAN = join(HERE, '样本补扫.mjs')
// ★ 2026-10-26（§七「一个看护循环」）：长命资源巡检 + 自愈器**都挂在这一条循环上**。
//   以前是四套看护各跑各的、`ensure` 字段存了没人读；现在巡检只报、自愈器只拉，二者都在这里被调一次。
const LONGLIVE = join(HERE, '长命资源巡检.mjs')
const HEALER = join(HERE, '自愈器.mjs')
const SCAN_EVERY_MS = 30 * 60 * 1000
let lastScan = 0
const NODE = process.env.DSH_NODE_EXE ?? process.execPath

const argv = process.argv.slice(2)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const INTERVAL_SEC = Number(opt('interval', 300))
const ONCE = argv.includes('--once')

const log = (s) => console.log(`[看护循环 ${new Date().toISOString().slice(11, 19)}] ${s}`)

function runOnce () {
  // ⚠️ `windowsHide: true` 必须有：这是**每 5 分钟**跑一次的路径，少了它 Windows 会给
  //    子进程分配控制台窗口 ⇒ 用户看到「黑框一闪而过」（2026-10-10 实测报障）。
  const r = spawnSync(NODE, [WATCHDOG, '--quiet'], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
  const code = r.status ?? -1
  // 进度看护的退出码：0=正常 3=异常（卡住/跑死）
  if (code === 3) log('⚠️ 看护判定异常（卡住/跑死）→ 已按规则叫醒大脑（去重在进度看护内部）')
  else if (code !== 0) log(`⚠️ 看护退出码 ${code}（可能报错）：${(r.stderr ?? '').slice(0, 200)}`)

  // ★ 2026-10-26（§七）：**唯一周期看护**里依次做三件事 ——
  //   ① 进度看护（run 健康，写 `<项目>\_crew\看护状态.json`）
  //   ② 长命资源巡检（服务健康，写 `_crew\长命资源状态.json`，唯一写方）
  //   ③ 自愈器（**唯一 ensure 消费者**：只拉起 expect:running + 有 ensure 的 dead 项，孤儿不杀）
  //   ⚠️ ③ 必须排在 ② 之后：巡检新鲜了，自愈器读到的才是"这一轮"的判断，不是三小时前的。
  try {
    const lv = spawnSync(NODE, [LONGLIVE, '--by', '看护循环', '--if-stale', '600'], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
    if (lv.status !== 0 && lv.status !== null) log(`⚠️ 长命资源巡检退出码 ${lv.status}：${String(lv.stderr ?? '').slice(0, 160)}`)
  } catch (e) { log(`⚠️ 长命资源巡检没跑起来：${e.message}`) }
  try {
    const hl = spawnSync(NODE, [HEALER, '--json'], { encoding: 'utf8', timeout: 180_000, windowsHide: true })
    let j = null
    try { j = JSON.parse(String(hl.stdout ?? '')) } catch {}
    if (j?.dispatchGate?.allowNewDispatch === false) {
      log(`⛔ ${j.dispatchGate.why}`)
    } else if ((j?.attempts ?? []).length) {
      log(`🩹 自愈：${j.attempts.map(a => `${a.name}=${a.ok ? '绿' : '仍红'}`).join('、')}`)
    }
    if (hl.status !== 0 && hl.status !== null) log(`⚠️ 自愈器退出码 ${hl.status}：${String(hl.stderr ?? '').slice(0, 160)}`)
  } catch (e) { log(`⚠️ 自愈器没跑起来：${e.message}`) }

  // 备份兜底：`--if-due` 自带 1 小时节流，不到点会立刻退（≈30ms），不会拖慢这一轮。
  try {
    const b = spawnSync(NODE, [BACKUP, '--if-due'], { encoding: 'utf8', timeout: 120_000, windowsHide: true })
    if (b.status !== 0) log(`⚠️ 备份失败（退出码 ${b.status}）：${(b.stderr ?? '').slice(0, 200)}`)
  } catch (e) { log(`⚠️ 备份没跑起来：${e.message}`) }

  // ★ 2026-10-24（§12.8）：样本补扫 —— 每轮都扫太浪费（库越大越慢）⇒ 30 分钟节流；
  //   **只有真补到东西才吭声**（不刷屏）。
  if (Date.now() - lastScan >= SCAN_EVERY_MS) {
    lastScan = Date.now()
    try {
      const s = spawnSync(NODE, [SCAN, '--json'], { encoding: 'utf8', timeout: 180_000, windowsHide: true })
      let j = null
      try { j = JSON.parse(String(s.stdout ?? '')) } catch {}
      const added = (j?.projects ?? []).reduce((a, b) => a + (b.added ?? 0), 0)
      if (added > 0) log(`📦 样本补扫：新入 ${added} 条（库共 ${j?.stats?.total ?? '?'} 条）`)
      else if (s.status !== 0) log(`⚠️ 样本补扫异常（退出码 ${s.status}）：${String(s.stderr ?? '').slice(0, 200)}`)
    } catch (e) { log(`⚠️ 样本补扫没跑起来：${e.message}`) }
  }
}

if (ONCE) {
  runOnce()
  process.exit(0)
}

log(`启动：每 ${INTERVAL_SEC}s 跑一次 进度看护.mjs（零 token、只读）`)
while (true) {
  try { runOnce() } catch (e) { log(`❌ 本轮异常：${e.message}`) }
  await new Promise(r => setTimeout(r, INTERVAL_SEC * 1000))
}
