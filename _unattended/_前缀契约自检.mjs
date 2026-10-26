// 五·S8 前缀契约自检（零 token）：同角色两张**故意长得很不一样**的卡，
//   STABLE 段必须逐字节相同、无插值、长度达标 —— 缓存命中（五）的机械闸。
// 七·S3（2026-10-18 追加）：模块内联（`MODULE`）四条断言 —— ④同角色同模块相等 · ⑤不同模块时公共头相等 ·
//   ⑥ L1 卡带 `--module` 必须**拒卡** · ⑦ 模块文件 ≤400 字。夹具写完即删，不污染 `roles\modules\`。
// 用法：node _前缀契约自检.mjs [--role coder-b] [--n 2] [--min 1200]
// 原理：跑 `派活.mjs --dump-blocks 1`（不落任何卡文件），比对 STABLE / STABLE_HEAD / SEMI / VOLATILE 的 sha256。
// 飞行挂载：起飞前检查.mjs ②c。
// 反向验收（施工时已做）：往 stableBlock 塞 ${TASK} 或截短 → 必红 → 还原；
//   把模块块塞到 STABLE 中间 → ⑤（STABLE_HEAD 相等）必红 → 还原。
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const argOf = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : d }
const ROLE = argOf('role', 'coder-b')
const N = Number(argOf('n', '2'))
const MIN = Number(argOf('min', '1200'))
const MODDIR = join(HERE, 'roles', 'modules')
const BLOCK_TITLE = '【本模块边界（'

// 短角色豁免表 —— **必须公开**：豁免必须写明理由，每次运行都会打印；无理由不许豁免。
const EXEMPT = {
  // 'researcher': '（示例）crewBrief 正文短于阈值的真实原因 + 补足计划',
}

let bad = 0
const say = (ok, name, extra) => { if (!ok) bad++; console.log(`${ok ? '✅' : '❌'} ${name}${extra ? `　— ${extra}` : ''}`) }
const info = (name) => console.log(`ℹ️ ${name}`)

const outDir = mkdtempSync(join(tmpdir(), 'prefix8-'))
const fixtures = []

// 跑一次 `派活 --dump-blocks 1`，返回四段（STABLE_HEAD 可能不存在 = null）＋ status/stderr
function dump (extra = [], out = outDir) {
  // ⚠️ `extra` 必须排在基础参数**前面**：`派活.mjs` 的 `opt()` 取**第一次出现**，这样夹具能覆盖 task/goal。
  const args = [join(HERE, '派活.mjs'),
    ...extra,
    '--role', ROLE,
    '--goal', '假卡：只回一句 OK（volatile 每卡不同）',
    '--accept', '`echo ok` => ok',
    '--files', 'server/only-this.ts',
    '--boundary', '本卡专属边界',
    '--out', out,
    '--dump-blocks', '1']
  if (!extra.includes('--task')) args.push('--task', `__S8-${ROLE}-${Math.random().toString(36).slice(2, 7)}`)
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', cwd: HERE, maxBuffer: 16 * 1024 * 1024 })
  const segs = {}
  // ⚠️ 终止符必须用 lookahead（(?====...)），否则上一段会把 `===` 吃掉（实测踩过：SEMI 整段漏匹配）
  const re = /===(STABLE_HEAD|STABLE|SEMI|VOLATILE)=== sha256:([0-9a-f]{12}) chars:(\d+)\r?\n([\s\S]*?)\r?\n(?====(?:STABLE_HEAD|STABLE|SEMI|VOLATILE|END)===)/g
  let m
  while ((m = re.exec(r.stdout))) segs[m[1]] = { sha: m[2], chars: Number(m[3]), text: m[4] }
  return { status: r.status, stdout: r.stdout, stderr: r.stderr, segs }
}

try {
  // ---------- 一、基础三断言（五·S8，原有） ----------
  const runs = []
  for (let i = 1; i <= N; i++) {
    // 故意让 VOLATILE 全错开：任务号 / 目标 / 自测命令 / 白名单 / 附加边界 每卡都不同
    const r = dump([
      '--task', `__S8-${ROLE}-${i}`,
      '--goal', `假卡第 ${i} 张：只回一句 OK，不跑命令、不做其它（volatile 互不相同）`,
      '--accept', '`echo ok-' + i + '` => ok-' + i,
      '--files', `server/only-this-${i}.ts`,
      '--boundary', `本卡专属边界第 ${i} 条`])
    if (r.status !== 0) {
      console.log(`❌ 派活 --dump-blocks 第 ${i} 次失败（status=${r.status}）`)
      console.log(String(r.stderr || r.stdout || '').slice(0, 800))
      process.exit(1)
    }
    if (!r.segs.STABLE || !r.segs.SEMI || !r.segs.VOLATILE) {
      console.log(`❌ 解析 dump 段失败（第 ${i} 次）：${r.stdout.slice(0, 300)}`)
      process.exit(1)
    }
    runs.push(r.segs)
  }

  console.log(`===== 前缀契约自检（五·S8 ＋ 七·S3） role=${ROLE} n=${N} =====`)

  // ① 两次 STABLE 逐字节相同（sha 一致 ＋ 重算校验）
  const sha0 = runs[0].STABLE.sha
  const allSame = runs.every(x => x.STABLE.sha === sha0)
  const recompute = runs.every(x => createHash('sha256').update(x.STABLE.text).digest('hex').slice(0, 12) === x.STABLE.sha)
  say(allSame, '① 同角色两卡 STABLE 逐字节相同（sha256 前 12 位）', `sha=${sha0} / ${runs.map(x => x.STABLE.sha).join(' , ')}`)
  say(recompute, '①b sha 与内容重算一致（防解析错位）')

  // ② 无插值字面 ＋ 无"会漂的数字"残留
  const hasDollar = runs.some(x => x.STABLE.text.includes('${'))
  say(!hasDollar, '② STABLE 不含 `${` 字面（未解析插值）')
  const staleNum = runs[0].STABLE.text.match(/坑库共\s*\d|命中\s*\d+\s*篇|共\s*\d+\s*篇里/)
  say(!staleNum, '②b STABLE 无"坑库共 N / 命中 M 篇"类会漂数字', staleNum ? `残留：${staleNum[0]}` : '')

  // ③ 长度达标（短角色须在 EXEMPT 里登记理由 —— 豁免必须公开打印）
  if (EXEMPT[ROLE]) {
    console.log(`✅ ③ 长度豁免：role=${ROLE} — 理由：${EXEMPT[ROLE]}（登记于 EXEMPT 表，公开可查）`)
  } else {
    say(runs[0].STABLE.chars >= MIN, `③ STABLE 长度 ≥ ${MIN} 字`, `实测 ${runs[0].STABLE.chars} 字 ≈ ${Math.round(runs[0].STABLE.chars * 0.8)} token`)
  }

  // ---------- 二、模块内联四断言（七·S3） ----------
  // 夹具：两个 ≤400 字、内容不同的模块说明；名字带 pid 防撞，finally 必删。
  const fa = `__selftest-${process.pid}-a`
  const fb = `__selftest-${process.pid}-b`
  const okDir = existsSync(MODDIR)
  if (!okDir) {
    info('④–⑦ 模块内联断言跳过：`roles\\modules\\` 目录不存在（未启用模块内联）')
  } else {
    const A = `【七·S3 夹具A】只改 server/a.ts；坑：缓存 key 前缀写死在这层。`
    const B = `【七·S3 夹具B】只改 web/b.tsx；别的都不许动。`
    writeFileSync(join(MODDIR, fa + '.md'), A, 'utf8'); fixtures.push(join(MODDIR, fa + '.md'))
    writeFileSync(join(MODDIR, fb + '.md'), B, 'utf8'); fixtures.push(join(MODDIR, fb + '.md'))

    // ④ 同角色 + 同模块 ⇒ STABLE 逐字节相同（两张 volatile 不同的卡）
    const a1 = dump(['--level', 'L3', '--module', fa, '--task', '__S8-MOD-A1'])
    const a2 = dump(['--level', 'L3', '--module', fa, '--task', '__S8-MOD-A2'])
    const b1 = dump(['--level', 'L3', '--module', fb, '--task', '__S8-MOD-B1'])
    if ([a1, a2, b1].some(x => x.status !== 0 || !x.segs.STABLE || !x.segs.STABLE_HEAD)) {
      const lastErr = String(a1.stderr || '').split('\n').filter(Boolean).slice(-1)[0] || ''
      say(false, '④ 同角色同模块 STABLE 相等', `派活失败（status=${[a1.status, a2.status, b1.status].join('/')}）—— 先看 L3 级模型是否已配：${lastErr.slice(0, 120)}`)
    } else {
      say(a1.segs.STABLE.sha === a2.segs.STABLE.sha, '④ 同角色同模块 STABLE 相等（两卡 volatile 不同）', `${a1.segs.STABLE.sha} / ${a2.segs.STABLE.sha}`)
      // ⑤ 不同模块 ⇒ 公共头（模块块之前那截）必须相等
      say(a1.segs.STABLE_HEAD.sha === b1.segs.STABLE_HEAD.sha,
        '⑤ 不同模块时 STABLE_HEAD（公共头）相等 —— 模块块只在尾巴分叉',
        `A=${a1.segs.STABLE_HEAD.sha}(${a1.segs.STABLE_HEAD.chars}字) / B=${b1.segs.STABLE_HEAD.sha}(${b1.segs.STABLE_HEAD.chars}字)`)
      // ⑥ 模块块确实进了 STABLE（标题＋正文都在卡里）
      const aText = a1.segs.STABLE.text
      const hasTitle = aText.includes(BLOCK_TITLE + fa + '）】')
      const hasBody = aText.includes(A)
      say(hasTitle && hasBody, '⑥ 模块块真的进了 STABLE（标题＋正文都在卡里）', hasTitle ? (hasBody ? '' : '标题在、正文不在') : '没找到块标题')
      // ⑥b 块必须**紧接公共头**（＝块起点正好等于 STABLE_HEAD 长度）—— 这是"放末尾"的机械保证。
      //     把块挪到中间 ⇒ 起点变小 ⇒ 本条必红（反向验收就是这么做的）。
      const idx = aText.indexOf(BLOCK_TITLE)
      say(idx === a1.segs.STABLE_HEAD.chars, '⑥b 模块块紧接公共头（＝STABLE_HEAD 长度处开始，即位于末尾）',
        `块起点=${idx} / STABLE_HEAD=${a1.segs.STABLE_HEAD.chars}`)
    }

    // ⑦ L1 卡带 --module ⇒ 必须拒卡（L1/L2 的卡不带模块块）
    const l1 = dump(['--level', 'L1', '--module', fa, '--task', '__S8-MOD-L1'])
    say(l1.status !== 0 && String(l1.stderr).includes('L3/L4'), '⑦ L1 卡带 --module 必须拒卡（fail-closed）', `status=${l1.status}`)
  }

  // ⑧ 模块文件字数 ≤400（跳过 `_` 开头的说明/模板与 `__selftest` 夹具）
  if (okDir) {
    const mods = readdirSync(MODDIR).filter(f => f.endsWith('.md') && !f.startsWith('_') && !f.startsWith('__selftest'))
    const overs = mods.map(f => ({ f, n: readFileSync(join(MODDIR, f), 'utf8').trim().length })).filter(x => x.n > 400)
    say(overs.length === 0, `⑧ 模块文件均 ≤400 字（实有 ${mods.length} 份）`, overs.map(x => `${x.f}=${x.n}字`).join(' , '))
  }

  // 附加信息：两张完整 prompt 的公共前缀（＝真正进缓存的那截）
  const full = runs.map(x => [x.STABLE.text, x.SEMI.text, x.VOLATILE.text].join('\n'))
  let i = 0
  while (i < full[0].length && i < full[1].length && full[0][i] === full[1][i]) i++
  console.log(`ℹ️ 公共前缀＝${i} 字（≈${Math.round(i * 0.8)} token）｜STABLE=${runs[0].STABLE.chars}｜SEMI=${runs[0].SEMI.chars}｜VOLATILE=${runs[0].VOLATILE.chars}（两卡）`)
  console.log('ℹ️ 分叉首行：' + JSON.stringify(full[0].slice(i, i + 60).split('\n')[0]))

  console.log(bad === 0 ? '\n✅ 前缀契约全过（基础三断言 ＋ 模块四断言）' : `\n❌ ${bad} 条不过 —— 不许出卡/起飞`)
} finally {
  for (const f of fixtures) { try { unlinkSync(f) } catch {} }
  try { rmSync(outDir, { recursive: true, force: true }) } catch {}
}
process.exit(bad === 0 ? 0 : 1)
