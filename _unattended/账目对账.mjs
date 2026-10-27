#!/usr/bin/env node
/**
 * 账目对账 —— 把"**两本账绝不重复**"（§6.4）从一句纪律变成**机器可查**的五项检查。
 *
 * 背景：我们有两本账，分工写死在文档里但**没人能自动验**：
 *   ① **DSH 自己的调用** → cost-meter 自动计量（`<DSH_HOME>\storages\cost-meter\ledger.json`）
 *   ② **非 DSH 载体**（Pi / OpenCode / CodeBuddy / Qoder）→ 我们写 `external_usage.json` 快照喂给它
 * 两本账一旦重叠就是**重复计费**；快照漏写就是**看不见的钱**。这个脚本把两件事都验掉。
 *
 * 用法：
 *   node 账目对账.mjs            # 人看
 *   node 账目对账.mjs --json     # 机器看（给编排/门禁吃）
 * 退出码：0 = 全过；1 = 有硬错（漏记/重复/带密钥/DSH 账本被我们改过）；2 = 只有警告（快照过期等）
 *
 * ⚠️ 设计取舍：**不复制**快照的聚合逻辑，而是**让 外部用量快照.mjs 现算一份到临时文件**再逐字段比
 *    —— 遵循"只写一份实现"；顺带证明那个脚本是**确定性**的（同输入同输出）。
 */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, '..')
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const SNAPSHOT = resolve(process.env.DSH_EXTERNAL_USAGE ?? join(DSH_HOME, 'storages', 'cost-meter', 'external_usage.json'))
// ★ 2026-10-03 修（竞态）：DSH 自己的账本**由 cost-meter 随每次调用随时写**（实证：我两次读数之间
//   只发生了"我自己这一轮推理"，它就 calls 1346→1347、sha 变了、mtime 前进）。
//   所以**不能**拿它的 sha256 做"跑前=跑后"断言 —— 正好有 DSH 调用落进那个窗口就报**假错**。
//   改成：① 需要比"脚本有没有动它"时，只看**目录里除 ledger.json 之外**有没有变化（对 DSH 自己的持续写入免疫）；
//        ② 对它本身只做**单调性**断言（calls 不许变少）—— 并发增长是正常的，减少才是我们弄坏了它。
//   允许 `--dsh-ledger` 覆盖，便于把检查指向副本做隔离验证。
const argOf = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i >= 0 ? process.argv[i + 1] : d }
const DSH_LEDGER = resolve(argOf('dsh-ledger', join(DSH_HOME, 'storages', 'cost-meter', 'ledger.json')))
const OUR_LEDGER = argOf('our-ledger') ? resolve(argOf('our-ledger')) : resolve(WORKSPACE, process.env.DSH_LEDGER ?? '_crew/ledger.json')
const SNAP_SCRIPT = join(HERE, '外部用量快照.mjs')

const argv = process.argv.slice(2)
const JSON_OUT = argv.includes('--json')
const results = []
const add = (level, id, ok, detail) => results.push({ level, id, ok, detail })

// ── `--selftest`：**验证这个检查器自己有没有牙**（没有它，一个"永远返回全过"的检查器比没有更糟）
//    做法：造两个已知有病的夹具，各跑一次自己（子进程），断言必须 exit=1 且命中预期检查项。
if (argv.includes('--selftest')) {
  const { mkdirSync, writeFileSync } = await import('node:fs')
  const { spawnSync: sp } = await import('node:child_process')
  const dir = mkdtempSync(join(tmpdir(), 'acct-self-'))
  const day = new Date().toISOString().slice(0, 10)
  const ledger = join(dir, 'ledger.json')
  writeFileSync(ledger, JSON.stringify({ schema: 1, calls: [
    { at: `${day}T06:00:00.000Z`, date: day, role: 'coder-b', model: 'glm-5.3-flash', ok: true, usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 5 } },
    { at: `${day}T06:01:00.000Z`, date: day, role: 'researcher', model: 'qwen3.8-max', ok: true, usage: { inputTokens: 7, outputTokens: 3, cacheReadInputTokens: 0 } }
  ] }), 'utf8')
  const bad = join(dir, 'bad.json')
  writeFileSync(bad, JSON.stringify({ fetchedAt: new Date().toISOString(), note: 'ark-deadbeef-1234-5678-90ab-cdef01234567',
    sources: [ { source: 'DSH', days: { [day]: { input: 7, output: 3, cached: 0, calls: 1, costUsd: 0 } } },
               { source: 'OpenCode', days: { [day]: { input: 100, output: 20, cached: 5, calls: 1, costUsd: 0 } } } ] }), 'utf8')
  const run = (env, extra = []) => {
    const rr = sp(process.execPath, [fileURLToPath(import.meta.url), '--json', ...extra],
      { encoding: 'utf8', maxBuffer: 8 << 20, windowsHide: true, env: { ...process.env, ...env } })
    let j = null; try { j = JSON.parse(rr.stdout) } catch {}
    return { code: rr.status, failed: (j?.checks ?? []).filter(c => !c.ok).map(c => c.id), errors: j?.errors ?? null }
  }
  const cases = [
    { name: '混进 DSH 来源 + 像密钥的串（期望命中 C2 / C5）', env: { DSH_LEDGER: ledger, DSH_EXTERNAL_USAGE: bad }, want: ['C2', 'C5'] },
    { name: '漏记：有外部调用但快照不存在（期望命中 C1）', env: { DSH_LEDGER: ledger, DSH_EXTERNAL_USAGE: join(dir, 'nope.json') }, want: ['C1'] }
  ]
  let bad_ = 0
  for (const c of cases) {
    const got = run(c.env)
    const hit = c.want.every(w => got.failed.some(f => f.startsWith(w)))
    if (got.code !== 1 || !hit) bad_++
    console.log(`${got.code === 1 && hit ? '✅' : '❌'} ${c.name}\n     exit=${got.code}（应 1）　命中失败项：${got.failed.join(' / ') || '（无）'}　期望含：${c.want.join(' / ')}`)
  }
  const okRun = run({ DSH_LEDGER: join(dir, 'empty.json'), DSH_EXTERNAL_USAGE: join(dir, 'none.json') })
  const okClean = okRun.errors === 0
  console.log(`${okClean ? '✅' : '❌'} 反例对照：空账本 + 无快照 → 不该报**硬错**（exit=${okRun.code}，硬错=${okRun.errors}；失败项里允许只有"⚠️ 警告"）`)
  if (!okClean) bad_++
  // ★ 竞态回归（2026-10-03 抓到的假错）：DSH 自己的账本**随时在被 cost-meter 写**（实证：我两次读数之间
  //   只发生了"我自己这一轮推理"，它就 calls +1、sha 变了）。旧 C3 拿它的 sha256 比跑前跑后 → 有 DSH 调用
  //   落进窗口就**假报硬错**。这里对**副本**模拟"账本内容被改"，断言 C3/C3c 不再因此报错（旧逻辑在此必挂）。
  const copy = join(dir, 'dsh-ledger-copy.json')
  writeFileSync(copy, JSON.stringify({ days: { '2026-10-03': { calls: 5, input: 1, output: 1 } } }), 'utf8')
  const beforeCopy = run({ DSH_LEDGER: ledger, DSH_EXTERNAL_USAGE: bad }, ['--dsh-ledger', copy])
  writeFileSync(copy, JSON.stringify({ days: { '2026-10-03': { calls: 7, input: 2, output: 2 } } }), 'utf8')   // 模拟被别人追加
  const afterCopy = run({ DSH_LEDGER: ledger, DSH_EXTERNAL_USAGE: bad }, ['--dsh-ledger', copy])
  const raceSafe = !afterCopy.failed.some(id => id.startsWith('C3') && !id.startsWith('C3b'))
  console.log(`${raceSafe ? '✅' : '❌'} 竞态回归：DSH 账本内容被外部改动（calls 5→7）→ **不该**触发 C3/C3c 硬错`
    + `\n     改动前失败项：${beforeCopy.failed.join(' / ') || '（无）'}\n     改动后失败项：${afterCopy.failed.join(' / ') || '（无）'}`)
  if (!raceSafe) bad_++
  rmSync(dir, { recursive: true, force: true })
  console.log(bad_ === 0 ? '\n✅ 检查器自检通过（有病能报、没病不报）' : `\n❌ 检查器自检失败 ${bad_} 项`)
  process.exit(bad_ === 0 ? 0 : 1)
}

const sha = (p) => existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null
const readJson = (p) => existsSync(p) ? JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, '')) : null

// ── C1/C2：让快照脚本现算一份，与线上那份比；并检查"只有外部载体"
const tmpDir = mkdtempSync(join(tmpdir(), 'acct-'))
const tmpOut = join(tmpDir, 'external_usage.recompute.json')
// ★W12c（2026-10-27）：**对账不能被"活的账本"误伤**。
//   实测：起飞前检查跑 ⑤ 之前刚做了角色自检（真调用 ⇒ 我们账本新增一条），
//   于是"现算的快照"和"线上快照"必然对不上 ⇒ C1/C2/C2b 全红 ⇒ 挡起飞。
//   这不是账错了，是**在拿移动的靶子做断言**。做法：记下前后指纹，期间被写过就说明本次不作数。
const _ourSha0 = existsSync(OUR_LEDGER) ? createHash('sha256').update(readFileSync(OUR_LEDGER)).digest('hex') : null
const _snapSha0 = existsSync(SNAPSHOT) ? createHash('sha256').update(readFileSync(SNAPSHOT)).digest('hex') : null
const r = spawnSync(process.execPath, [SNAP_SCRIPT, '--ledger', OUR_LEDGER, '--out', tmpOut, '--write'],
  { encoding: 'utf8', maxBuffer: 8 << 20, windowsHide: true })
const recomputed = r.status === 0 ? readJson(tmpOut) : null
const live = readJson(SNAPSHOT)
// ★ 线上快照的**原始字节只读一次**：C5 要拿它验密钥。为什么强调——
//   第一版 C3 里我让快照脚本 `--write` 到**线上路径**，等于"对账顺手把线上文件重写了一遍"，
//   于是 C5 读到的是被覆盖后的内容 → **假密钥验不出来**（负向用例实测抓到的）。
//   对账必须是**只读动作**：任何"写"都只写临时文件。
const liveText = existsSync(SNAPSHOT) ? readFileSync(SNAPSHOT, 'utf8') : null

const EXTERNAL_SOURCES = new Set(['Pi', 'OpenCode', 'CodeBuddy', 'Qoder', 'Qwen Code'])
const DSH_AGENTS = new Set(['messenger', 'dsh'])

if (r.status === 3) {
  add('warn', 'C1 快照可复算', false, `我们的账本里还没有非 DSH 调用 → 快照不该存在（线上存在=${Boolean(live)}）`)
} else if (r.status !== 0) {
  add('error', 'C1 快照可复算', false, `快照脚本失败：exit=${r.status} ${String(r.stderr ?? '').trim().slice(-160)}`)
} else if (!live) {
  add('error', 'C1 快照可复算', false, `线上快照不存在，但我们的账本里有非 DSH 调用（**漏记**）`)
} else {
  const strip = (s) => JSON.stringify((s?.sources ?? []).map(x => ({ source: x.source, days: x.days })).sort((a, b) => a.source.localeCompare(b.source)))
  const same = strip(recomputed) === strip(live)
  add('error', 'C1 快照可复算（线上 = 用现账本重算）', same, same
    ? `来源 ${recomputed.sources.length} 个、逐日数值一致`
    : `不一致（线上可能是旧的/被手改）\n     线上：${strip(live).slice(0, 300)}\n     重算：${strip(recomputed).slice(0, 300)}`)
}

// ── C2：快照里**只能有非 DSH 载体**（DSH 自己的调用已被自动计量，写进来就是重复计费）
if (live) {
  const bad = (live.sources ?? []).filter(s => !EXTERNAL_SOURCES.has(s.source)).map(s => s.source)
  add('error', 'C2 不重复计费（快照只含外部载体）', bad.length === 0,
    bad.length ? `出现不该有的来源：${bad.join(', ')}` : `来源 ${live.sources.map(s => s.source).join(' / ')}（全部是外部载体）`)
}
// ── C2b：我们账本里的 DSH 载体调用**必须被跳过**
const our = readJson(OUR_LEDGER)
if (our?.calls?.length) {
  const cfgPath = join(WORKSPACE, '_crew', 'agents.json')
  const cfg = readJson(cfgPath) ?? { roles: {}, agents: {}, defaultAgent: 'messenger' }
  const dshCalls = our.calls.filter(c => DSH_AGENTS.has(cfg.roles?.[c.role]?.agent ?? cfg.defaultAgent))
  const extCalls = our.calls.filter(c => !DSH_AGENTS.has(cfg.roles?.[c.role]?.agent ?? cfg.defaultAgent))
  const snapCalls = live ? (live.sources ?? []).reduce((n, s) => n + Object.values(s.days ?? {}).reduce((m, d) => m + (d.calls ?? 0), 0), 0) : 0
  add('error', 'C2b 账本 → 快照条数守恒（外部调用全进、DSH 调用不进）', snapCalls === extCalls.length,
    `我们账本 ${our.calls.length} 条 = 外部 ${extCalls.length} + DSH ${dshCalls.length}；快照里 ${snapCalls} 条`)
} else {
  add('warn', 'C2b 账本 → 快照条数守恒', false, '我们的账本为空（还没有真调用），跳过')
}

// ── C3：**写快照不许动 cost-meter 目录**（除 DSH 自己的 ledger.json —— 它随时在被写，不能算我们头上）
//   ⚠️ 这里原来是 `sha(DSH 账本) 跑前 = 跑后` —— 实测**有竞态**（见文件头那段：DSH 自己一直在写它）。
const cmDir = join(DSH_HOME, 'storages', 'cost-meter')
const dirSig = () => existsSync(cmDir)
  ? readdirSync(cmDir).filter(n => n !== 'ledger.json').map(n => { try { const s = statSync(join(cmDir, n)); return `${n}:${s.size}` } catch { return `${n}:?` } }).sort().join(',')
  : '(目录不存在)'
const callsOf = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')).days ? Object.values(JSON.parse(readFileSync(p, 'utf8')).days).reduce((n, d) => n + (d.calls ?? 0), 0) : null } catch { return null } }
const beforeSig = dirSig()
const beforeCalls = callsOf(DSH_LEDGER)
const tmpOut2 = join(tmpDir, 'external_usage.c3.json')
const r2 = spawnSync(process.execPath, [SNAP_SCRIPT, '--out', tmpOut2, '--write'], { encoding: 'utf8', maxBuffer: 8 << 20, windowsHide: true })
const afterSig = dirSig()
const afterCalls = callsOf(DSH_LEDGER)
add('error', 'C3 写快照不动 cost-meter 目录（除 DSH 自己的 ledger.json）', beforeSig === afterSig,
  beforeSig === afterSig ? '目录里其它文件前后一致（ledger.json 由 DSH 自己持续写，已排除）' : `有变化：${beforeSig} → ${afterSig}`)
add('error', 'C3c DSH 账本调用数不减少（**单调性**，对并发增长免疫）', beforeCalls === null || afterCalls === null || afterCalls >= beforeCalls,
  beforeCalls === null ? '读不到调用数（跳过）' : `快照脚本跑前 ${beforeCalls} → 跑后 ${afterCalls}${afterCalls > beforeCalls ? '（期间 DSH 自己又记了账，正常）' : ''}`)
const liveAfter = existsSync(SNAPSHOT) ? readFileSync(SNAPSHOT, 'utf8') : null
// C3b：线上快照在检查期间变了 → **只算警告**（只有真跑在同时进行才会发生；对账自己没有写路径）
add('warn', 'C3b 对账期间线上快照没被别人刷新', liveText === liveAfter,
  liveText === liveAfter ? '线上快照前后逐字节一致' : '**期间有别的进程刷新了它**（多半是同时在真跑）—— 不是对账写的，对账无写路径')

// ── C4：快照新鲜度（cost-meter 超过 24h 会标 stale、暂停偏差提示）
if (live?.fetchedAt) {
  const ageH = (Date.now() - Date.parse(live.fetchedAt)) / 3600000
  add('warn', 'C4 快照新鲜（<24h，否则面板标 stale）', ageH < 24, `fetchedAt=${live.fetchedAt}（${ageH.toFixed(1)} 小时前）`)
}

// ── C5：文件里**不许出现密钥**（§2.6 硬约束 6）—— 用开头读下的原始字节，别重读（会被写覆盖）
if (liveText) {
  const leak = /\bark-[0-9a-f-]{8,}|sk-[A-Za-z0-9._-]{12,}|AKLT[A-Za-z0-9]{8,}/.test(liveText)
  add('error', 'C5 快照里没有密钥', !leak, leak ? '**发现疑似凭据串**' : '未发现 ark-/sk-/AKLT 形态串')
}

rmSync(tmpDir, { recursive: true, force: true })

// ★W12c：期间账本或快照被写过 ⇒ 拿移动的靶子比出来的差异不算错，降级为警告
{
  const ourSha1 = existsSync(OUR_LEDGER) ? createHash('sha256').update(readFileSync(OUR_LEDGER)).digest('hex') : null
  const snapSha1 = existsSync(SNAPSHOT) ? createHash('sha256').update(readFileSync(SNAPSHOT)).digest('hex') : null
  const raced = (ourSha1 !== _ourSha0) || (snapSha1 !== _snapSha0)
  if (raced) {
    for (const x of results) {
      if (!x.ok && x.level === 'error' && /^C(1|2|2b)\b/.test(x.id)) {
        x.level = 'warn'
        x.detail = '（检查期间账本/快照被写入 ⇒ 本次对账不作数，稍后重跑；不是账错了）' + x.detail
      }
    }
    results.push({ level: 'warn', id: 'C0 对账期间账本没被写', ok: false, detail: '期间被写过 —— 本次以"不作数"处理（并发写正常）' })
  }
}

const errors = results.filter(x => x.level === 'error' && !x.ok)
const warns = results.filter(x => x.level === 'warn' && !x.ok)
if (JSON_OUT) {
  process.stdout.write(JSON.stringify({
    snapshot: SNAPSHOT, ourLedger: OUR_LEDGER, dshLedger: DSH_LEDGER,
    ok: errors.length === 0, errors: errors.length, warnings: warns.length, checks: results
  }, null, 2) + '\n')
} else {
  console.log(`对账对象：\n  线上快照 ${SNAPSHOT}\n  我们账本 ${OUR_LEDGER}\n  DSH 账本 ${DSH_LEDGER}\n`)
  for (const x of results) console.log(`${x.ok ? '✅' : x.level === 'error' ? '❌' : '⚠️'} ${x.id}\n     ${x.detail}`)
  console.log(`\n${errors.length === 0 ? '✅ 无硬错' : `❌ ${errors.length} 项硬错`}${warns.length ? `　⚠️ ${warns.length} 项警告` : ''}`)
}
process.exit(errors.length ? 1 : warns.length ? 2 : 0)