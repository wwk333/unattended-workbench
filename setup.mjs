#!/usr/bin/env node
/**
 * setup —— **一句话复刻**的总入口（开源准备 P0 / D25）
 *
 * 用户只干两件事：**登录**、**给钥匙**。其余能机器干的，这里全干。
 *
 * 四个子命令：
 *   --check   [--json]  只查。**默认命令**。零花费、不改任何东西。
 *   --apply             修。只修"能确定怎么修"的，修不了的原样报出来。**幂等**：连跑两次第二次零改动。
 *   --connect[--yes]    真连一次：对每个角色发一次最小哑调用（`_角色自检.mjs`）。**要花钱，必须带 --yes**。
 *   --report            给 doctor / 人看的汇总。
 *
 * 纪律（和本项目别处一致）：
 *   · **不静默**：缺什么就说缺什么，说清"打开哪个文件填什么"。
 *   · **不猜**：不知道该写什么值就停下问，不拿一个"看起来像"的默认值顶上。
 *   · **不覆盖**：已有的配置/数据一律不动（除非是空的骨架目录）。
 *   · **账要清**：动过系统状态（计划任务 / 插件 / env）就写进 `_crew\install-manifest.json`。
 *
 * 用法：
 *   node setup.mjs                  # = --check
 *   node setup.mjs --apply
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, copyFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

import {
  WORKSPACE, CONFIG_DIR, MAP_FILE, MAP, MAP_SOURCE, loadMap,
  AGENTS, DSH_ROOT, NODE_BIN, DSH_EXE, DSH_HOME, VAULT, KB, BACKUP_ROOT, HOME_DIR, PROJECTS_ROOT
} from './_unattended/_路径.mjs'
import { expand, loadConfig, maskSecrets } from './_unattended/_agents-config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const CREW = join(WORKSPACE, '_crew')
const MANIFEST = join(CREW, 'install-manifest.json')
const UN = join(WORKSPACE, '_unattended')

const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }

const R = { ok: 0, fixed: 0, todo: 0, warn: 0 }
const ITEMS = []

/** 一条检查/修复。`fix` 返回 true 表示"这次真改了"；返回字符串表示"改不了，这是原因"。 */
function item (id, name, { level = 'must', check, fix = null, hint = null, value = null }) {
  const it = { id, name, level, state: 'unknown', detail: null, hint, value }
  return {
    ...it,
    run (apply) {
      let cur
      try { cur = check() } catch (e) { cur = { ok: false, detail: String(e?.message ?? e) } }
      if (cur?.ok) { this.state = 'ok'; this.detail = cur.detail ?? null; R.ok++; return }
      this.detail = cur?.detail ?? '缺失'
      if (apply && typeof fix === 'function') {
        let r
        try { r = fix() } catch (e) { r = String(e?.message ?? e) }
        if (r === true) { this.state = 'fixed'; R.fixed++; return }
        if (typeof r === 'string') this.detail = r
      }
      this.state = level === 'must' ? 'todo' : 'warn'
      // ⚠️ 两档分开数：`must` 缺 = 装不起来（退出码非零）；`warn` 缺 = 能跑但功能少（不拦）
      if (level === 'must') R.todo++
      else R.warn++
    }
  }
}

// ─────────────────────────────────────────────────────────────── 检查项

const dirOk = (p) => ({ ok: existsSync(p), detail: p })
const fileOk = (p) => ({ ok: existsSync(p), detail: p })

export const CHECKS = [
  // ① 配置：唯一允许写绝对路径的地方
  item('map', '本机映射（config\\本机映射.json）', {
    check: () => ({ ok: Boolean(MAP_SOURCE), detail: MAP_SOURCE ?? `没有 ${MAP_FILE}` }),
    hint: '它决定 DSH 装在哪、载体在哪、坑库在哪。--apply 会探测生成。',
    fix: () => {
      mkdirSync(CONFIG_DIR, { recursive: true })
      const guess = detect()
      // ⚠️ 探测不到 DSH 也**照写**：先把知道的那几项落盘，让后面的步骤能继续；
      //    缺的那一项留着空，--check 会一直报它，等用户装完 DSH 再跑一次就自动补上。
      writeFileSync(MAP_FILE, JSON.stringify(guess, null, 2) + '\n', 'utf8')
      return true
    }
  }),
  item('agents.json', '班组配置（config\\agents.json）', {
    check: () => {
      // ⚠️ 老布局把班组配置放在 `_crew\agents.json`（数据层）。新布局要求放 `config\`。
      //    两个都认 —— 否则在本机上会报一个假"缺"。
      const p = [join(CONFIG_DIR, 'agents.json'), join(CREW, 'agents.json')].find(f => existsSync(f))
      return p ? { ok: true, detail: p } : { ok: false, detail: `没有 ${join(CONFIG_DIR, 'agents.json')}` }
    },
    hint: '从 config\\agents.example.json 复制一份，然后在看板里选模型。',
    fix: () => {
      if (existsSync(join(CREW, 'agents.json'))) return true // 老布局已在用，不动它
      const src = join(CONFIG_DIR, 'agents.example.json')
      const dst = join(CONFIG_DIR, 'agents.json')
      if (!existsSync(src)) return '缺 config\\agents.example.json（包里应该带，缺了说明包不完整）'
      copyFileSync(src, dst)
      return true
    }
  }),
  item('swap-token', '换会话桥 token（config\\swap-token.txt）', {
    check: () => {
      const p = [join(CONFIG_DIR, 'swap-token.txt'), join(UN, 'secrets', 'swap-token.txt')].find(f => existsSync(f))
      return p ? { ok: true, detail: p } : { ok: false, detail: `没有 ${join(CONFIG_DIR, 'swap-token.txt')}` }
    },
    hint: '安装时随机生成，**我们不存任何人的钥匙**。',
    fix: () => {
      if (existsSync(join(UN, 'secrets', 'swap-token.txt'))) return true // 老布局，不动
      mkdirSync(CONFIG_DIR, { recursive: true })
      writeFileSync(join(CONFIG_DIR, 'swap-token.txt'), randomBytes(24).toString('hex') + '\n', 'utf8')
      return true
    }
  }),

  // ② 环境
  item('dsh', 'DSH 安装根', {
    check: () => ({ ok: Boolean(DSH_ROOT) && existsSync(join(DSH_ROOT, 'resources', 'runtime')), detail: DSH_ROOT ?? '探测不到' }),
    hint: 'DSH 需自己装（不可分发）。装了之后 --apply 会重新探测。'
  }),
  item('dsh-home', 'DSH 家目录（~/.dsh）', {
    check: () => dirOk(DSH_HOME ?? ''),
    hint: '登录过 DSH 才会有。没登录就先登录。'
  }),
  item('node', '专用 node（DSH 自带 runtime）', {
    check: () => ({ ok: Boolean(NODE_BIN) && existsSync(NODE_BIN), detail: NODE_BIN ?? '探测不到' }),
    hint: '装 DSH 就会带。没有也没关系，脚本会退回用系统 node。'
  }),

  // ③ 数据骨架（程序自己会建）
  item('crew', '数据目录骨架（_crew\\）', {
    check: () => ({ ok: ['gate', 'runs', 'state', 'backup'].every(d => existsSync(join(CREW, d))), detail: CREW }),
    hint: '运行时产物都放这儿；升级与卸载都不碰它。',
    fix: () => {
      for (const d of ['gate', 'runs', 'state', 'backup', 'tasks', 'running']) mkdirSync(join(CREW, d), { recursive: true })
      // ⚠️ **只建目录，不造数据文件**：`board-data.json` / `ledger.json` 由程序第一次真跑时生成。
      //    在这儿塞一个空壳，会让"未知"冒充成"有数据"（踩过：包里的 stub 让 5 条真产物断言误跑）。
      return true
    }
  }),

  // ④ 载体
  ...['pi', 'opencode', 'codebuddy', 'qwencode'].map((name) => item(`carrier-${name}`, `载体：${name}`, {
    level: 'warn',
    check: () => checkCarrier(name),
    hint: '胖包会自带 agents\\；瘦包用 npm 装（见 README）。'
  })),
  item('ripgrep', 'opencode 的 ripgrep（预置依赖）', {
    level: 'warn',
    check: () => {
      const p = process.env.预置 ?? null
      const target = join(HOME_DIR ?? '', '.cache', 'opencode', 'bin', 'rg.exe')
      return { ok: Boolean(HOME_DIR) && existsSync(target), detail: target }
    },
    hint: '不预置的话，opencode 第一次用 grep 会去 GitHub 现下，卡住就把整步 abort 掉。',
    fix: () => {
      const r = spawnSync(process.execPath, [join(UN, '预置载体依赖.mjs')], { encoding: 'utf8', windowsHide: true })
      const out = String(r.stdout ?? '') + String(r.stderr ?? '')
      if (r.status === 0) return true
      return out.trim().split('\n')[0] || `预置失败（exit ${r.status}）`
    }
  }),

  // ⑤ 坑库（用户级资产；没有就是空库，不是错）
  item('vault', '坑库目录', {
    level: 'warn',
    check: () => ({ ok: Boolean(VAULT) && existsSync(VAULT), detail: VAULT ?? '未配置（空库也能跑，只是查不到历史坑）' }),
    hint: '装一次全项目共用；删它等于忘掉所有教训。',
    fix: () => {
      const target = VAULT ?? join(CREW, '..', '坑库')
      mkdirSync(target, { recursive: true })
      const idx = join(target, '_索引.md')
      if (!existsSync(idx)) writeFileSync(idx, '# 坑库索引\n\n> 空库。第一条坑这样记：见 `说明.md`。\n', 'utf8')
      const readme = join(target, '说明.md')
      if (!existsSync(readme)) writeFileSync(readme, '# 这个目录是什么\n\n每次踩坑记一条（现象 / 根因 / 对策 / 证据），AI 会帮你合并与建索引。\n', 'utf8')
      // ⚠️ 建完要**写回映射**，否则下一轮 check 还是"未配置"（实测：建了不记，永远 ⚠️）
      rememberVault(target)
      return true
    }
  }),

  // ⑤ 角色规矩（模板 → 渲染稿；大脑运行时直读渲染稿）
  item('roles', '角色规矩（roles\\*.md 渲染稿）', {
    check: () => {
      const tpls = ['brain', '班组须知', '班组须知-细则']
      const missing = tpls.filter(n => !existsSync(join(UN, 'roles', n + '.template.md')) && !existsSync(join(UN, 'roles', n + '.md')))
      if (missing.length) return { ok: false, detail: `缺 ${missing.join('、')}（模板与渲染稿都没有 ⇒ 包不完整）` }
      const noOut = tpls.filter(n => existsSync(join(UN, 'roles', n + '.template.md')) && !existsSync(join(UN, 'roles', n + '.md')))
      return noOut.length
        ? { ok: false, detail: `还没渲染：${noOut.join('、')}` }
        : { ok: true, detail: join(UN, 'roles') }
    },
    hint: '包里带的是模板（含占位符），安装时要按本机路径渲染成 .md —— 大脑运行时直读这份。',
    fix: () => {
      const r = spawnSync(process.execPath, [join(UN, '_渲染角色.mjs')], { encoding: 'utf8', windowsHide: true })
      const out = String(r.stdout ?? '') + String(r.stderr ?? '')
      if (r.status === 0) return true
      return out.trim().split('\n').slice(-2).join(' ') || `渲染失败（exit ${r.status}）`
    }
  }),

  // ⑥ 技能（策划）：包里是**模板**，装到 ~/.dsh/skills 之前渲染一次
  item('skills', '策划技能已装到 ~/.dsh/skills', {
    check: () => {
      const dest = DSH_HOME ? join(DSH_HOME, 'skills') : null
      if (!dest) return { ok: false, detail: 'DSH 家目录没解析出来（先装 DSH 并登录一次）' }
      const need = ['idea-to-plan']
      const missing = need.filter(n => !existsSync(join(dest, n, 'SKILL.md')))
      return missing.length
        ? { ok: false, detail: `缺 ${missing.join('、')}（共 ${dest}）` }
        : { ok: true, detail: dest }
    },
    hint: '不装技能，大脑就没有「帮我把想法写成策划方案」的能力 —— 这是产品的入口功能之一。',
    fix: () => {
      const r = spawnSync(process.execPath, [join(UN, '_安装技能.mjs')], { encoding: 'utf8', windowsHide: true })
      const out = String(r.stdout ?? '') + String(r.stderr ?? '')
      if (r.status === 0) return true
      return out.trim().split('\n').slice(-2).join(' ') || `安装失败（exit ${r.status}）`
    }
  }),

  // ⑦ 看护计划任务：看护循环自己也会死，而"发现它死了"的角色就是它自己
  //    ⇒ 只能靠系统级定时器兜底（每 5 分钟拉一次，已在跑就秒退）
  item('supervisor', '看护计划任务（每 5 分钟兜底）', {
    level: 'warn',
    check: () => {
      const r = spawnSync(process.execPath, [join(UN, '计划任务.mjs'), '--status'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
      let j = null
      try { j = JSON.parse(String(r.stdout ?? '')) } catch {}
      if (!j) return { ok: false, detail: '查不到（schtasks 不可用，或这台机器不是 Windows）' }
      if (!j.exists) return { ok: false, detail: '还没建（看板/看护死了没人拉起来）' }
      if (j.enabled === false) return { ok: false, detail: `在册但被**禁用**了：${j.name}（存在不等于会跑）` }
      return { ok: true, detail: `在册且启用：${j.name}` }
    },
    hint: '看护循环自己也会死，而"发现它死了"的角色就是它自己 —— 只能靠系统级定时器兜底。不装也能手动跑，但就不叫"无人值守"了。',
    fix: () => {
      const r = spawnSync(process.execPath, [join(UN, '计划任务.mjs'), '--install'], { encoding: 'utf8', windowsHide: true, timeout: 120_000 })
      if (r.status === 0) return true
      const out = (String(r.stdout ?? '') + String(r.stderr ?? '')).trim().split('\n').slice(-2).join(' ')
      return out || '建不上（可能被企业策略拦，见 KNOWN_ISSUES 第 8 条）'
    }
  }),

  // ⑧ Obsidian（可选）：装了 dsh-obsidian 插件就顺手打一道路径护栏
  //    没装插件时**不是错**，本项显示为"可选未做"，不拦起飞
  item('obsidian', 'Obsidian 插件护栏（可选）', {
    level: 'warn',
    check: () => {
      const r = spawnSync(process.execPath, [join(UN, '打obsidian路径护栏.mjs'), '--check'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
      const out = String(r.stdout ?? '') + String(r.stderr ?? '')
      if (/跳过|没装/.test(out)) return { ok: false, detail: '没装 dsh-obsidian 插件（可选：装了才能在会话里读写笔记）' }
      if (r.status === 0) return { ok: true, detail: '护栏已打' }
      return { ok: false, detail: '装了插件，但护栏没打（路径可能越出 vault）' }
    },
    hint: '在 Obsidian 里看项目文档是**可选**的：不装也能用，项目文件夹本身就能打开。',
    fix: () => {
      const r = spawnSync(process.execPath, [join(UN, '打obsidian路径护栏.mjs')], { encoding: 'utf8', windowsHide: true, timeout: 60_000 })
      return r.status === 0 ? true : '打不上（看它自己的输出）'
    }
  }),

  // ⑨ 凭据（人做，脚本只查）
  item('cred', 'API 钥匙（~/.dsh/.credentials.yaml）', {
    check: () => {
      const p = join(DSH_HOME ?? '', '.credentials.yaml')
      if (!existsSync(p)) return { ok: false, detail: `没有 ${p}` }
      const t = readFileSync(p, 'utf8')
      const names = [...new Set([...t.matchAll(/^\s*([A-Z0-9_]+_API_KEY|DEEPSEEK_API_KEY)\s*:/gm)].map(m => m[1]))]
      return { ok: names.length > 0, detail: names.length ? `有 ${names.length} 把：${names.join(', ')}` : '文件在，但没找到 *_API_KEY' }
    },
    hint: '**这一步只能人来**（登录 / 给钥匙）。不替用户填、不替用户登录。'
  })
]

/** 把刚建出来的路径写回 `config\本机映射.json`（幂等：值一样就不写） */
function rememberVault (vaultPath) {
  try {
    const cur = existsSync(MAP_FILE) ? JSON.parse(readFileSync(MAP_FILE, 'utf8').replace(/^\uFEFF/, '')) : {}
    if (cur['坑库'] === vaultPath) return
    cur['坑库'] = vaultPath
    mkdirSync(CONFIG_DIR, { recursive: true })
    writeFileSync(MAP_FILE, JSON.stringify(cur, null, 2) + '\n', 'utf8')
  } catch { /* 记不上也不该让安装失败：check 下一轮会再说一遍 */ }
}

function detect () {
  const guess = {
    _说明: '本机映射（由 setup 探测生成）。唯一允许写绝对路径的地方。',
    'DSH根': DSH_ROOT ?? '',
    // ⚠️ 只在**真的存在**时才写：以前无条件写 `WORKSPACE\agents`，于是没有载体的机器上
    //    映射里留了一条"看着像真的、其实不存在"的路径（隔离测试里被载体检查原样打印出来了）。
    agents: (AGENTS && existsSync(AGENTS)) ? AGENTS : '',
    '坑库': VAULT ?? '',
    '知识库': KB ?? '',
    '备份根': BACKUP_ROOT ?? '',
    // 默认放 用户目录\xiangmu：策划技能要在这里建项目文件夹，留空会让它照着占位符建
    '项目根': PROJECTS_ROOT ?? (HOME_DIR ? join(HOME_DIR, 'xiangmu') : '')
  }
  return guess
}

/** 载体在不在：按 **expand() 之后的真实路径** 判（踩过假红：拿没展开的占位符去 existsSync） */
function checkCarrier (name) {
  // 载体根都没就位 ⇒ 直接说这件事，别把一条"展开出来的假路径"当结论打印给人看
  if (!AGENTS || !existsSync(AGENTS)) {
    return { ok: false, detail: '载体根（agents\\）还没就位 —— 胖包自带；瘦包用 npm 装（见 docs\\快速开始.md）' }
  }
  const { cfg } = loadConfig()
  const a = cfg?.agents?.[name]
  if (!a) return { ok: false, detail: `agents.json 里没有声明「${name}」` }
  let entry
  try { entry = expand(a.entry) } catch (e) { return { ok: false, detail: `占位符展开失败：${String(e?.message ?? e)}` } }
  if (!entry || entry.includes('${')) return { ok: false, detail: `入口还带占位符：${entry}` }
  return { ok: existsSync(entry), detail: entry }
}

// ─────────────────────────────────────────────────────────────── 跑

export function run (apply) {
  // 计数器是模块级的（给 CLI 用）；被 `doctor` 之类的模块调用时，每次都要清零，否则会累加
  R.ok = R.fixed = R.todo = R.warn = 0
  for (const c of CHECKS) c.run(apply)
  return {
    at: new Date().toISOString(),
    workspace: WORKSPACE,
    apply,
    counts: { ...R, total: CHECKS.length },
    items: CHECKS.map(({ id, name, level, state, detail, hint }) => ({ id, name, level, state, detail, hint }))
  }
}

function printHuman (res) {
  const mark = { ok: '✅', fixed: '🔧', todo: '❌', warn: '⚠️', unknown: '❔' }
  console.log(`\n[setup] 工作台：${res.workspace}　${res.apply ? '（已尝试修复）' : '（只查不改）'}`)
  for (const it of res.items) {
    console.log(`  ${mark[it.state] ?? '❔'} ${it.name}　${it.detail ?? ''}`)
    if (it.state === 'todo' && it.hint) console.log(`      → ${it.hint}`)
  }
  const { ok, fixed, todo, warn, total } = res.counts
  console.log(`\n[setup] ${ok} 就绪 / ${fixed} 已修 / ${todo} 待办 / ${warn} 可选未做（共 ${total} 项）`)
  if (todo && !res.apply) console.log('[setup] 想让它自己修：node setup.mjs --apply')
  if (todo) console.log('[setup] 需要人做的只有「登录 / 给钥匙」这一类，其余的 --apply 会自己干。')
}

function writeManifest (res) {
  mkdirSync(CREW, { recursive: true })
  const rec = []
  if (existsSync(MANIFEST)) { try { rec.push(...JSON.parse(readFileSync(MANIFEST, 'utf8')).events) } catch {} }
  rec.push({ at: res.at, apply: res.apply, fixed: res.items.filter(i => i.state === 'fixed').map(i => i.id) })
  writeFileSync(MANIFEST, JSON.stringify({ schema: 1, kind: 'install-manifest', workspace: WORKSPACE, events: rec }, null, 2) + '\n', 'utf8')
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  if (has('connect')) {
    if (!has('yes')) {
      console.error('[setup] --connect 会**真的发请求**（每个角色一次最小调用，花钱）。确认请加 --yes。')
      process.exit(2)
    }
    const r = spawnSync(process.execPath, [join(UN, '_角色自检.mjs')], { stdio: 'inherit', windowsHide: true })
    process.exit(r.status ?? 1)
  }
  const apply = has('apply')
  const res = run(apply)
  if (apply) writeManifest(res)
  if (has('json')) console.log(JSON.stringify(res, null, 2))
  else printHuman(res)
  // 只查模式：还有待办就以非零退出，方便脚本/大脑判断
  process.exit(res.counts.todo > 0 ? (apply ? 3 : 1) : 0)
}
