/**
 * 批 3 换家后验证（零 token）：**一条命令看结果**
 *
 * 用法：`node _unattended\换家后验证.mjs`
 * 换家（`换家.mjs --apply` ＋ 重启 DSH）之后跑它，逐条打印：
 *   ① 桥是不是**新插件**在提供（ping 会回 `host: dsh-crew-bridge`）
 *   ② 旧插件是否真的撤了（打包产物 `lib/client.js` 的 mtime **早于**本次进程启动时刻）
 *   ③ 新面板（19450）三个口通不通
 *   ④ 看守还在不在（看护循环/换会话看守的进程）
 *
 * 判据全部是**只读取证**，不改任何东西；任一条不合格就 exit 1。
 */
import { readFileSync, statSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
// ★ 2026-10-17（升 0.2.1）：宿主端口改成系统分配 ⇒ 不再写死 19387
import { hostPortSync } from './_宿主端口.mjs'
import { WORKSPACE } from './_路径.mjs'

/** 工作台根（本文件在 `_unattended\` 下 ⇒ 上一级）。 */
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)))

const SEP = '─'.repeat(60)
let fails = 0
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++ }
const info = (m) => console.log('   ' + m)

const TOKEN_FILE = join(WORKSPACE, '_unattended', 'secrets', 'swap-token.txt')
const CLIENT_JS = join(WORKSPACE, '_unattended', 'sidebar-plugin', 'lib', 'client.js')
const PANEL = process.env.DSH_PANEL_BASE ?? 'http://127.0.0.1:19450'

console.log(SEP)
console.log('批 3 换家后验证')
console.log(SEP)

// ① 桥是谁在做
console.log('\n① 换会话桥（19390）')
let token = ''
try { token = readFileSync(TOKEN_FILE, 'utf8').trim() } catch (e) { info('读不到 token 文件：' + TOKEN_FILE) }
const bridge = async (op, extra = {}) => {
  const r = await fetch('http://127.0.0.1:19390/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-dsh-swap-token': token },
    body: JSON.stringify({ op, ...extra })
  })
  let j = null
  try { j = await r.json() } catch {}
  return { status: r.status, j }
}
try {
  const r = await bridge('ping')
  ok(r.status === 200 && r.j?.ok === true, `桥在（HTTP ${r.status}）`)
  if (r.j?.host) {
    ok(r.j.host === 'dsh-crew-bridge', `桥的主人 = ${r.j.host}${r.j.host === 'dsh-crew-bridge' ? '（新插件 ✅）' : '（**还是旧插件** ⇒ 换家没生效/没重启）'}`)
  } else {
    info('（桥没报 host 字段 —— 可能是旧版桥：旧实现只回 service/version，这本身说明**旧插件还在提供桥**）')
    ok(false, '桥没有报新插件的 host 标识')
  }
  // ★ 硬判据：`list` 走的就是 `ctx.get('sessionController')` —— **端口通 ≠ 换会话能用**。
  //   宿主服务没接上时桥会回 503「sessionController 不可用」，只看端口会得到"假绿"。
  const l = await bridge('list')
  const hasSc = l.status === 200 && l.j?.ok === true
  const n = Array.isArray(l.j?.value) ? l.j.value.length : '?'
  ok(hasSc, `sessionController 可用（list → HTTP ${l.status}${hasSc ? '，会话数 ' + n : '：' + JSON.stringify(l.j?.error ?? l.j)}）`)
} catch (e) {
  ok(false, '桥连不上：' + String(e?.message ?? e) + '（DSH 没起？桥没起来？）')
}

// ② 旧插件撤了没
//   · 目录还在 ⇒ 看它的产物 mtime 是否早于本次 DSH 启动（旁证：没被加载）
//   · 目录已归档（C 阶段做过）⇒ 那更是"撤了"的直接证据
console.log('\n② 旧看板插件是否已撤')
if (!existsSync(CLIENT_JS)) {
  ok(true, '旧插件目录**已归档**（源文件不在原位）⇒ 不可能再被加载')
} else {
  try {
    const hostPid = Number(execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-NetTCPConnection -State Listen -LocalPort ${hostPortSync()} -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess`], { encoding: 'utf8' }).trim())
    const started = Number(execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-Process -Id ${hostPid} -ErrorAction SilentlyContinue).StartTime.ToFileTimeUtc()`], { encoding: 'utf8' }).trim())
    const startMs = started / 10000 - 11644473600000
    const cjs = statSync(CLIENT_JS).mtimeMs
    info(`DSH 宿主 pid=${hostPid} 启动于 ${new Date(startMs).toLocaleString('zh-CN')}`)
    info(`旧插件产物 client.js mtime = ${new Date(cjs).toLocaleString('zh-CN')}`)
    if (cjs > startMs) ok(false, '旧插件产物在 DSH 启动**之后**被读过（说明它仍在被加载）⇒ 换家没生效')
    else ok(true, '旧插件产物早于本次启动 ⇒ 与"已撤"一致（旁证；直接证据看右侧栏标签页是否消失）')
  } catch (e) {
    info('（宿主进程探测失败，跳过这一条：' + String(e?.message ?? e).slice(0, 80) + '）')
  }
}

// ③ 面板
console.log('\n③ 新面板（19450）')
for (const [p, method] of [['/health', 'GET'], ['/', 'GET'], ['/board-data.json', 'GET'], ['/core.js', 'GET'], ['/run', 'POST']]) {
  try {
    const r = await fetch(PANEL + p, method === 'POST'
      ? { method, headers: { 'Content-Type': 'application/json' }, body: '{"op":"status"}' }
      : {})
    ok(r.status === 200, `${method} ${p} → ${r.status}`)
  } catch (e) { ok(false, `${method} ${p} → 失败 ${String(e?.message ?? e)}`) }
}

// ④ 看守
// ⚠️ 判据**不能**去正则匹配进程命令行取状态（那正是"读散文取状态"，会被 起飞前检查 ②b 拦下）。
//    改看**结构化产物**：看护循环每跑一次都会刷新这两个 JSON —— 用它们的新鲜度证明"看守在跑"。
console.log('\n④ 看守（换会话看守 ＋ 看护循环）')
const WATCH_ARTIFACTS = [
  join(ROOT, '_crew', '看护状态.json'),
  join(ROOT, '_crew', '看护告警.json')
]
let fresh = 0
for (const f of WATCH_ARTIFACTS) {
  try {
    const st = statSync(f)
    const ageMin = (Date.now() - st.mtimeMs) / 60000
    info(`${f.replace(ROOT, '<根>')}：${ageMin.toFixed(1)} 分钟前被写过`)
    if (ageMin <= 20) fresh++          // 看护循环每 5 分钟一轮 ⇒ 20 分钟内有写入＝它在跑
  } catch (e) { info(`${f.replace(ROOT, '<根>')}：读不到（${String(e?.code ?? e)}）`) }
}
ok(fresh > 0, `看守在跑（看护产物 20 分钟内有更新：${fresh}/${WATCH_ARTIFACTS.length} 个）`)

console.log('\n' + SEP)
console.log(fails ? `❌ ${fails} 项不合格 —— 见上面逐条；要退就：node _unattended\\换家.mjs --rollback 然后重启 DSH` : '✅ 换家结果：全部合格')
console.log(SEP)
process.exit(fails ? 1 : 0)
