/**
 * 班组配置加载器 —— **唯一需要改的地方就是 `_crew\agents.json`**。
 *
 * 为什么要单独抽出来：原来 `派活.mjs` / `编排.mjs` / `账号自检.mjs` 各自硬编码了
 * "CLI 路径 + 每个角色用哪个模型"。这样一旦要**换审核 agent** 就得改好几处，很容易漏。
 *
 * ★ 2026-10-03 改造（都是为了"能随包搬给别人 + 模型不写死"）：
 *   ① **路径占位符**：`${WORKSPACE}` / `${AGENTS}` / `${NODE}` / `${DSH_ROOT}` / `${DSH_HOME}`
 *      —— `agents.json` 里不再写盘符，运行时按"本文件在哪"推导。
 *   ② **凭据占位符**：`${CRED:变量名}` —— 运行时从 `<DSH_HOME>\.credentials.yaml` **现读**，
 *      注入子进程环境，**不落盘**；打印/自检时**打码**（只显示长度）。
 *   ③ **prefer / fallback**：角色的模型是"**优先使用**"而非写死；可被任务级 `--model/--effort` 覆盖。
 *   ④ **extraArgs / effortArgs**：角色级附加参数（例：审核员 `-s read-only`；
 *      Codex 的档位得写成 `-c model_reasoning_effort=<档位>` 两个 token）。
 */

import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// ★ 2026-10-16（思考档位三档抽象）：档位落地的**唯一实现**（读档案白名单 → 档→候选→具体值）。
//   放在**最前面**（模块级 import 提前到这里）：`levelsOf()` 一上来就要用它，放在 300 行之后是 TDZ 雷。
//   无环：`_档位.mjs` 只 import 本模块的 `DSH_HOME`，不 import 本模块的函数。
import { resolveEffort as resolveEffortValue, EFFORT_TIERS, DEFAULT_EFFORT_TIERS } from './_档位.mjs'

// ★ 2026-10-27（开源准备 W2）：**取址的唯一源改成 `_路径.mjs`**。
//   以前这里写死了两个'盘符 + 目录名'的绝对路径，既是泄露也是隐患：用户装到别的盘就找不到 DSH。
//   现在的顺序：环境变量 → `config\本机映射.json` → 从本文件位置推导 → null（用到时才抛，见 `_路径.mjs` 的 need()）。
import {
  WORKSPACE as WS_SRC,
  DSH_ROOT as DSH_APP_SRC,
  AGENTS as AGENTS_SRC,
  NODE_BIN as NODE_SRC,
  DSH_HOME as DSH_HOME_SRC,
  CRED_FILE as CRED_SRC
} from './_路径.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = WS_SRC
/** ⚠️ 老语义保留：这里是"工作台的**上一级**"，不是 DSH 安装根（DSH 安装根叫 `APP_ROOT`）。 */
const DSH_ROOT = resolve(WORKSPACE, '..')
const AGENTS = AGENTS_SRC ?? resolve(DSH_ROOT, 'agents')
/**
 * DSH 安装根。**没有任何写死盘符的兜底**：只认"真的存在 `resources\runtime`"的那一层。
 * 找不到就是 null —— 由调用方在真正需要时给出人话错误（`_路径.mjs` 的 `need()`）。
 */
const APP_ROOT = DSH_APP_SRC ?? (() => {
  for (const c of [resolve(DSH_ROOT, '桌面端'), resolve(DSH_ROOT, 'dsh桌面端')]) {
    try { if (existsSync(join(c, 'resources', 'runtime'))) return c } catch {}
  }
  return null
})()
const NODE_BIN = NODE_SRC ??
  (APP_ROOT ? resolve(APP_ROOT, 'resources/runtime/primary-runtime/dependencies/node/bin/node.exe') : null)
const DSH_HOME = DSH_HOME_SRC ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh')
const CRED_FILE = CRED_SRC ?? join(DSH_HOME, '.credentials.yaml')

/**
 * 班组配置的位置。
 * ★W2（开源准备）：**新布局放 `config\agents.json`**（配置层，人写），
 *   但**认老布局** `_crew\agents.json`（数据层，本机现在就是它）——两个都找，
 *   否则在本机上会误报"没有配置"，或者逼着搬家。
 */
export const CONFIG_FILE = process.env.DSH_AGENTS_CONFIG ??
  [join(WORKSPACE, 'config', 'agents.json'), resolve(WORKSPACE, '_crew/agents.json')].find(p => { try { return existsSync(p) } catch { return false } }) ??
  join(WORKSPACE, 'config', 'agents.json')

/** 占位符 → 真值（`${CRED:NAME}` 单独处理，见 credValue） */
export const PLACEHOLDERS = {
  WORKSPACE,
  DSH_ROOT,
  AGENTS,
  NODE: NODE_BIN,
  DSH_HOME,
  USERPROFILE: process.env.USERPROFILE ?? '',
  HOME: process.env.USERPROFILE ?? process.env.HOME ?? ''
}

let _credCache = null
/** 从凭据库现读一个变量（只读、不落盘、不打印）。读不到返回 ''。 */
export function credValue (name) {
  if (_credCache === null) {
    _credCache = {}
    try {
      const text = readFileSync(CRED_FILE, 'utf8').replace(/^\uFEFF/, '')
      for (const line of text.split(/\r?\n/)) {
        const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*["']?([^"'\r\n]+?)["']?\s*$/)
        if (m) _credCache[m[1]] = m[2].trim()
      }
    } catch { /* 读不到就当空，由调用方报错 */ }
  }
  return _credCache[name] ?? ''
}

/** 把 `${XXX}` / `${CRED:NAME}` 换成真值。只认已知键；不认识的**原样留着**（宁可露出 ${FOO}，也不要静默变空）。 */
export function expand (v) {
  if (typeof v !== 'string') return v
  return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*(?::[A-Za-z0-9_]+)?)\}/g, (m, k) => {
    if (k.startsWith('CRED:')) return credValue(k.slice(5))
    return k in PLACEHOLDERS ? PLACEHOLDERS[k] : m
  })
}

/** 给"要打印出来给人看"的场景用：把凭据值打码。 */
export function maskSecrets (s) {
  if (typeof s !== 'string') return s
  return s.replace(/\$\{CRED:([A-Za-z0-9_]+)\}/g, (m, n) => {
    const v = credValue(n)
    return v ? `<${n}:${v.length}位>` : `<${n}:缺失!>`
  })
}

/** 兜底默认值：JSON 读不到时也要能跑（宁可跑默认，也不要因为配置文件坏了就全瘫）。
 *  ⚠️ 兜底值必须与 `_crew\agents.json` **同步**（不同步的后果是"静默失效"）。
 *  ★ 2026-10-10：**导出给闸用** —— `_兜底对账.mjs`（挂 起飞前检查 ①b）逐条比对
 *    "兜底里描述的载体 ⊇ 角色用到的载体"，把"两个源结构不对等"变成会报红的一道闸。 */
export const FALLBACK = {
  defaultAgent: 'messenger',
  // ★ 2026-10-09 八·S1（重构总表 §八）：**删掉了每个载体的 `timeoutMin`** —— 实测它是**死字段**
  //   （全项目零消费点；"不同角色不同超时"这个能力系统层面不存在）。真值＝`编排.mjs` 的
  //   `--timeout-min`（默认 **90**）／`coder-b-dsh.mjs` 20／`台账.mjs` 10 —— 别往这里加回来。
  agents: {
    messenger: {
      kind: 'generic', node: '${NODE}', entry: '${WORKSPACE}\\_unattended\\coder-b-dsh.mjs',
      printArgs: [], modelFlag: '--model', effortFlag: '--effort', routeFlag: '--route', dirFlag: '--cwd',
      sessionFlag: null,          // ★ 2026-10-10 T3：这家**没有续跑口**（一次性 spawnSync）—— 如实声明 null，别拼假命令
      envClear: []
    },
    opencode: {
      kind: 'generic', entry: '${AGENTS}\\opencode\\opencode.exe',
      printArgs: ['run', '--standalone', '--format', 'json', '--auto', '--thinking'],   // ★ 2026-10-10：+`--thinking`（否则只有思考 token 数、没有正文）
      modelFlag: '--model', sessionFlag: '--session',                                    // ★ 续跑＝软续（不存在则新建），回执要标注
      env: { OPENCODE_CONFIG: '${AGENTS}\\config\\opencode\\opencode.json', QWEN_TOKEN_PLAN_CN_API_KEY: '${CRED:QWEN_TOKEN_PLAN_CN_API_KEY}', ARK_API_KEY: '${CRED:ARK_API_KEY}' },
      envClear: ['CI']
    },
    pi: {
      kind: 'generic', node: '${NODE}', entry: '${AGENTS}\\node_modules\\@earendil-works\\pi-coding-agent\\dist\\bundle\\cli.js',
      printArgs: ['-p', '--mode', 'json'],                                               // ★ 2026-10-10：**摘掉 `--no-session`**（它让会话不落盘 ⇒ 续跑不可能）；安全性＝源码证实默认走"新建会话"
      modelFlag: '--model', effortFlag: '--thinking', sessionFlag: '--session',           // ★ 续跑＝`--session`（找不到会响亮报错，不是 `--session-id` 的"悄悄新建"）
      env: { QWEN_TOKEN_PLAN_CN_API_KEY: '${CRED:QWEN_TOKEN_PLAN_CN_API_KEY}', XIAOMI_API_KEY: '${CRED:XIAOMI_API_KEY}' },
      envClear: ['CI']
    },
    qwencode: {
      kind: 'generic', node: '${NODE}', entry: '${AGENTS}\\node_modules\\@qwen-code\\qwen-code\\cli-entry.js',
      printArgs: ['--output-format', 'json', '--yolo', '--auth-type', 'openai'], modelFlag: '--model',
      sessionFlag: '--resume',     // ★ 2026-10-10 T3：`-r/--resume <id>`（⚠️ 一旦关掉 `--chat-recording`，continue/resume 都会失效）
      env: { OPENAI_BASE_URL: 'https://ark.cn-beijing.volces.com/api/coding/v3', OPENAI_API_KEY: '${CRED:ARK_API_KEY}', QWEN_CODE_SUPPRESS_YOLO_WARNING: '1' },
      envClear: ['CI']
    },
    // ★ 2026-10-10 补（存量 gap）：**原先这里没有 codebuddy** —— 而 `_crew\agents.json` 的
    //   `roles.reviewer.agent` 就是 `codebuddy`。今天还没炸，只因为 `FALLBACK.roles` 是空的（先响亮报"没有这个角色"）；
    //   但只要有人给兜底填角色、或走"agents.json 解析成功但漏声明某个载体"那条路，就会**静默冒用 defaultAgent 的载体**
    //   （实测：`agentName` 仍报 codebuddy、`entry` 已经是 Pi 的 cli.js ⇒ **名字对、命令错**）。
    //   ⇒ 现在两处都修：这里补齐 ＋ `resolveRole()` 找不到载体一律**响亮报错**（不再冒用）＋ `_兜底对账.mjs` 装闸。
    codebuddy: {
      kind: 'generic', node: '${NODE}', entry: '${AGENTS}\\node_modules\\@tencent-ai\\codebuddy-code\\bin\\codebuddy',
      printArgs: ['-p', '--output-format', 'json'], modelFlag: '--model', effortFlag: '--effort', sessionFlag: '--resume',
      env: {
        CODEBUDDY_BASE_URL: 'https://ark.cn-beijing.volces.com/api/coding/v3',
        CODEBUDDY_API_KEY: '${CRED:ARK_API_KEY}',
        CODEBUDDY_CONFIG_DIR: '${AGENTS}\\config\\codebuddy',
        CODEBUDDY_FORCE_HEADLESS_BUNDLE: '1',
        CODEBUDDY_INTERNET_ENVIRONMENT: 'internal'
      },
      envClear: ['CI']
    }
  },
  // ★ 2026-10-16（任务分级 L1–L4）：**兜底里也不许写模型名**（用户口径："任何模型名不许写死进代码/文档"）。
  //   所以这里只声明"有哪四级"（形状），模型一律留空 ⇒ `levelsOf` 会说"没配"（fail-closed），
  //   与上面 roles 留空同一条纪律：**绝不用一个可能过期的模型名替用户做决定**。
  levels: { L1: {}, L2: {}, L3: {}, L4: {} },
  // ★ 2026-10-07（用户口径："关于角色使用的模型，**千万不要写死**，因为我会通过看板更换模型"）：
  //   **角色模型绝不内置默认值**。原来这里写着 coder-a/coder-b 的旧模型（还配了过期的 `messenger` 载体），
  //   配置读不到/解析失败时会**静默拿它顶上** —— 那正是"写死 + 悄悄用过期值"（开源审计的 S2 就是这条）。
  //   现在留空：**没配置就报错**（`resolveRole` 会说"没有这个角色"，`loadConfig` 也带 ⚠️ 警告），
  //   **绝不用一个可能过期的模型名替用户做决定**。
  //   ⚠️ 上面 `agents`（载体"形状"）**保留** —— 那描述的是"怎么起这个程序"，不是模型，不会因看板换模型而过期。
  roles: {}
}

export function loadConfig () {
  if (!existsSync(CONFIG_FILE)) return { cfg: FALLBACK, source: '(内置兜底：找不到 _crew\\agents.json)', warnings: [`找不到配置文件：${CONFIG_FILE}`] }
  try {
    // ⚠️ **必须自己剥 BOM**：PowerShell 的 `Set-Content -Encoding UTF8` 会写 UTF-8 BOM，
    //    而 JSON.parse 见到 BOM 直接报 `Unexpected token ''` → 静默用兜底（实测踩过）。
    const buf = readFileSync(CONFIG_FILE)
    let text
    if (buf.length >= 2 && buf[0] === 0xFF && buf[1] === 0xFE) text = buf.subarray(2).toString('utf16le')
    else if (buf.length >= 2 && buf[0] === 0xFE && buf[1] === 0xFF) {
      const s = Buffer.from(buf.subarray(2)); if (s.length % 2) s.subarray(0, s.length - 1); s.swap16()
      text = s.toString('utf16le')
    } else {
      text = buf.toString('utf8')
      if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)
    }
    const raw = JSON.parse(text)
    const warnings = []
    if (!raw.agents?.[raw.defaultAgent]) warnings.push(`defaultAgent "${raw.defaultAgent}" 不在 agents 里`)
    const modelOf = new Map()
    for (const [name, role] of Object.entries(raw.roles ?? {})) {
      if (role.agent && !raw.agents?.[role.agent]) warnings.push(`角色 ${name} 指定的 agent "${role.agent}" 不存在`)
      const m = role.prefer?.model ?? role.model
      if (!m) warnings.push(`角色 ${name} 既没有 prefer.model 也没有 model`)
      else modelOf.set(name, m)
      // 凭据占位符在配置里出现 → 检查凭据库有没有这个变量
      for (const hit of JSON.stringify(role).matchAll(/\$\{CRED:([A-Za-z0-9_]+)\}/g)) {
        if (!credValue(hit[1])) warnings.push(`角色 ${name} 需要的凭据 ${hit[1]} 在凭据库里找不到`)
      }
    }
    // ★ 2026-10-14 口径改（用户原话："真正的意思是**写代码的人不审代码**"）：
    //   剔除旧检查"角色之间模型名必须两两不同"（任一重名就警告 —— 那条口径是错的，已从文档/规则书剔除）。
    //   真约束＝**写这份产出的模型 ≠ 审它/修它的模型**：
    //     写方：coder-* / researcher（reviewer 审的是整波产出）／ rescue（它修 coder 的产出，修完仍由 reviewer 审）
    //     审/修方：reviewer（审）／ rescue（修）
    //   ⇒ **两个 coder 之间同模型不算违规**（现状就是同的）。
    //   角色名按约定推导（/^coder/ 覆盖将来新增的 coder-c），不写死具体名单。
    const isWriterRole = r => /^coder/.test(r) || r === 'researcher' || r === 'rescue'
    const CHECKER_VERB = { reviewer: '审', rescue: '修' }
    for (const w of Object.keys(raw.roles ?? {}).filter(isWriterRole)) {
      for (const [c, verb] of Object.entries(CHECKER_VERB)) {
        if (w === c) continue
        const mw = modelOf.get(w), mc = modelOf.get(c)
        if (mw && mc && mw === mc) warnings.push(`⚠️ 破写审分离：${w}（写）与 ${c}（${verb}）都在用 "${mw}" —— 写代码的人不审代码，必须换掉其中一个`)
      }
    }
    // ★ 2026-10-16（任务分级 L1–L4）：**逐级**三条（依据 KB 重构\任务分级-施工文档.md §6 ③）。
    //   为什么必须逐级：《小优化》§4.3 那三条冲突，加了级之后"每个角色会有多个模型"——
    //   只按 prefer 比一次 ⇒ **某级的模型撞上 reviewer** 就静默漏检（文档点名的那个例子）。
    const levelWarn = []
    for (const [name, role] of Object.entries(raw.roles ?? {})) {
      const lv = role.levels
      if (lv === undefined || lv === null) continue
      if (typeof lv !== 'object' || Array.isArray(lv)) { levelWarn.push(`角色 ${name} 的 levels 不是对象`); continue }
      for (const k of Object.keys(lv)) {
        if (!TASK_LEVELS.includes(String(k).toUpperCase())) { levelWarn.push(`角色 ${name} 的 levels 里有个不认识级号 "${k}"（只认 ${TASK_LEVELS.join(' / ')}）`); continue }
        const e = lv[k] ?? {}
        if (!String(e.model ?? '').trim()) levelWarn.push(`角色 ${name} 的 levels.${String(k).toUpperCase()} **声明了但没给 model** —— 派这一级的卡会当场报错（不许静默走 prefer）`)
      }
    }
    if (raw.levels !== undefined && raw.levels !== null) {
      const g = raw.levels
      if (typeof g !== 'object' || Array.isArray(g)) levelWarn.push('全局 levels 段不是对象')
      else for (const k of Object.keys(g)) {
      // ⚠️ 文档注记键（`说明` / `_开头的`）**和 `effortTiers`（三档候选串）**都不是级号 —— 配置里本来就允许它们，
      //   别把注记/配置键报成"不认识级号"（实测：加 `effortTiers` 后立刻被这条误报）。
      if (k === '说明' || k === 'effortTiers' || k.startsWith('_')) continue
        if (!TASK_LEVELS.includes(String(k).toUpperCase())) { levelWarn.push(`全局 levels 里有个不认识级号 "${k}"`); continue }
        const e = g[k] ?? {}
        if (e.steps !== undefined && !LEVEL_STEPS.includes(String(e.steps))) levelWarn.push(`全局 levels.${k}.steps＝"${e.steps}" 不是合法值（只认 ${LEVEL_STEPS.join(' / ')}）`)
        if (e.gate !== undefined && !LEVEL_GATE.includes(String(e.gate))) levelWarn.push(`全局 levels.${k}.gate＝"${e.gate}" 不是合法值（只认 ${LEVEL_GATE.join(' / ')}）`)
        if (e.shape !== undefined && !LEVEL_SHAPE.includes(String(e.shape))) levelWarn.push(`全局 levels.${k}.shape＝"${e.shape}" 不是合法值（只认 ${LEVEL_SHAPE.join(' / ')}）`)
      }
    }
    // ★ 2026-10-16：**写审分离逐级** —— 不只比 prefer，还要比每一级（含"写方的某级 ＝ 审方"）。
    //   模型名比较前按 `/` 与 `:` 取尾段（`xiaomi-token-plan-cn/mimo-v2.6-flash` ≡ `mimo-v2.6-flash`）。
    const bare = (m) => String(m ?? '').split(/[\/:]/).pop()
    for (const lvKey of TASK_LEVELS) {
      const at = (r) => bare(r?.levels?.[lvKey]?.model ?? r?.prefer?.model ?? r?.model)
      for (const w of Object.keys(raw.roles ?? {}).filter(isWriterRole)) {
        for (const [c, verb] of Object.entries(CHECKER_VERB)) {
          if (w === c) continue
          const mw = at(raw.roles?.[w]), mc = at(raw.roles?.[c])
          if (mw && mc && mw === mc) {
            levelWarn.push(`⚠️ 破写审分离（${lvKey} 级）：${w}（写）与 ${c}（${verb}）在这一级都是 "${mw}" —— 写代码的人不审代码，换掉其中一个`)
          }
        }
      }
    }
    for (const w of levelWarn) warnings.push(w)
    // ★ b198：**只扫"真会被替换的字段"，跳过说明字段** —— 原来一句 `JSON.stringify(raw)` 把整份配置（含
    //   `notes`／`…注` 那些又长又详细的说明文字）全扫了 ⇒ **说明里"举例提到"的占位符会被当成真占位符报**。
    //   实测：`agents.json` 的 codebuddy 段 `notes` 里为了解释"models.json 的 apiKey 写的是 ${CODEBUDDY_API_KEY}
    //   这个环境引用"，把占位符当例子写在说明里 ⇒ 每次派活都报"未知占位符 CODEBUDDY_API_KEY"（**虚警**；
    //   真链路是好的：env 里 `CODEBUDDY_API_KEY: "${CRED:ARK_API_KEY}"`，而 ARK_API_KEY 在凭据库里）。
    //   假警报多了，真警报就没人看了 —— 所以这里必须只扫"会被替换的地方"。
    const EXPLANATION_KEY = /^(notes?|.*注)$/i
    const substitutedText = []
    ;(function collect (v, key) {
      if (v == null) return
      if (typeof v === 'string') { if (!EXPLANATION_KEY.test(key)) substitutedText.push(v); return }
      if (Array.isArray(v)) { for (const x of v) collect(x, key); return }
      if (typeof v === 'object') { for (const [k, x] of Object.entries(v)) collect(x, k) }
    })(raw, '')
    const unknown = new Set()
    for (const m of substitutedText.join('\n').matchAll(/\$\{([A-Za-z_][A-Za-z0-9_:]*)\}/g)) {
      if (!m[1].startsWith('CRED:') && !(m[1] in PLACEHOLDERS) && m[1] !== 'EFFORT') unknown.add(m[1])
    }
    if (unknown.size) warnings.push(`配置里有未知占位符（不会被替换）：${[...unknown].join(', ')}`)
    const merged = {
      defaultAgent: raw.defaultAgent ?? FALLBACK.defaultAgent,
      agents: { ...FALLBACK.agents, ...(raw.agents ?? {}) },
      roles: { ...FALLBACK.roles, ...(raw.roles ?? {}) },
      // ★ 2026-10-16（任务分级）：全局预设包也要跟着合过来 —— 原来这里只合 agents/roles，
      //   漏了 `levels` ⇒ `levelPresetOf()` 永远读不到用户配的 gate/shape/steps（静默退回默认值）。
      levels: { ...(FALLBACK.levels ?? {}), ...(raw.levels ?? {}) }
    }
    return { cfg: merged, source: CONFIG_FILE, warnings, raw }
  } catch (e) {
    return { cfg: FALLBACK, source: `${CONFIG_FILE}（解析失败，已用兜底）`, warnings: [`配置文件解析失败：${String(e?.message ?? e)}`] }
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// ★ 2026-10-16（任务分级 L1–L4）：四级梯子 —— 「级覆盖层」
//   依据＝KB `重构\任务分级-施工文档.md`（用户拍板定稿）。**这里只实现机制，不装任何模型名。**
//   形状（写在哪）：`_crew\agents.json` 的 `roles.<角色>.levels.<L1..L4> = { model, effort }`
//                  ＋ 可选全局预设包 `levels.<L1..L4> = { steps, gate, shape }`（纯文字，机判靠下面的形状断言）
//   优先级：**任务级 --model/--effort（最高）> 级（本层）> role.prefer > role.model（旧）**
//   缺级/缺模型 ⇒ **响亮报错、绝不静默走默认**（用户口径：某级没配就报错）。见文档 §4 规矩 2。
// ════════════════════════════════════════════════════════════════════════════════════════

/** 四级梯子的级号（唯一源）。顺序＝由轻到重，`LEVEL_MIN/MAX` 用它比大小。 */
export const TASK_LEVELS = ['L1', 'L2', 'L3', 'L4']

/** 全局预设包里三维度各自的合法取值（文档 §3）。**校验而不是静默接受拼错的值**。 */
const LEVEL_STEPS = ['不限', '≤10', '≤30', '≤60']
const LEVEL_GATE = ['ac', 'quick', 'full']
const LEVEL_SHAPE = ['slim', 'std', 'full']

/** 归一一个级号（`l2` / `2` / `L2+full` → `L2`）；不合法返回 null（**不猜**）。 */
export function normalizeLevel (v) {
  if (v === null || v === undefined || v === '') return null
  const s = String(v).trim().toUpperCase()
  const m = /^L?([1-4])(?:\+.*)?$/.exec(s)          // 单项覆盖写在 `+` 后面（例 `L3+full`），级号本身只认 L1..L4
  return m ? 'L' + m[1] : null
}

/** 级的"重量"序（用于比大小：取一批卡的**最深一级**、判"要不要拉审核员"）。非法返回 null。 */
export function levelRank (v) { return TASK_LEVELS.indexOf(normalizeLevel(v)) }

/** 全局预设包（`levels` 段）里某一维度的声明；没配/拼错 ⇒ 返回 null 并给一句 why（**不静默归一成默认**）。 */
export function levelPresetOf (kind, cfg, lv) {
  const L = normalizeLevel(lv)
  const p = L ? (cfg?.levels ?? {})[L] : null
  const raw = p?.[kind]
  const list = kind === 'steps' ? LEVEL_STEPS : (kind === 'gate' ? LEVEL_GATE : (kind === 'shape' ? LEVEL_SHAPE : null))
  if (!list) return { value: null, why: `未知维度 ${kind}（只认 steps / gate / shape）` }
  if (raw === undefined || raw === null || raw === '') {
    // 该级的该维度没配 ⇒ 回落**该维度的最保守值**（这正是机制落地后、用户还没配自定义包时的正常状态）
    const dflt = kind === 'gate' ? 'full' : (kind === 'shape' ? 'std' : null)
    return { value: dflt, why: `${L ?? lv} 的 ${kind} 没在 agents.json 的 levels 段配 ⇒ 取最保守值 ${dflt ?? '（无）'}` }
  }
  if (!list.includes(String(raw))) return { value: null, why: `${L ?? lv} 的 ${kind}＝"${raw}" 不是合法值（只认 ${list.join(' / ')}）—— 不静默接受` }
  return { value: String(raw) }
}

/**
 * 取某角色某一级的模型（**唯一出处＝agents.json 的 levels 段 ＋ 可选全局预设包**）。
 * 返回 { model, effort, missing, why }；`missing:true` ⇒ 调用方必须报错（fail-closed）。
 */
export function levelsOf (roleName, cfg, lv) {
  const L = normalizeLevel(lv)
  if (!L) return { level: null, model: null, effort: null, missing: true, why: `级号不合法：${JSON.stringify(lv)}（只认 ${TASK_LEVELS.join(' / ')}，可选单项覆盖写在 + 后面）` }
  const role = cfg?.roles?.[roleName]
  const global = cfg?.levels?.[L]
  const per = role?.levels?.[L]
  // 全局预设包给了模型 ⇒ 它就是这一级的默认（按角色再覆盖）；全局没给模型、角色也没给 ⇒ 没配
  const model = String(per?.model ?? global?.model ?? '').trim() || null
  // ★ 2026-10-16（§3.5 三档抽象）：`effortTier`（省/中/狠）是**写入口**；`effort`（具体值）只作**读兼容**。
  const effortTier = String(per?.effortTier ?? global?.effortTier ?? '').trim() || null
  const effortRaw = String(per?.effort ?? global?.effort ?? '').trim() || null
  if (!model) {
    return { level: L, model: null, effort: null, missing: true,
      why: `「${L}」这一级的模型**没配**（_crew\\agents.json 的 roles.${roleName}.levels.${L}.model，或全局 levels.${L}.model —— 两处都是空的）` +
           ` —— 级模型一律在**看板**里定；这里**绝不静默走 prefer 默认档**（用户口径：《任务分级》§4 规矩 2）` }
  }
  // ⚠️ 载体能力闸（"这个载体自己认不认这个模型名"）**不在这里做** —— 那个模块与这里互相 import，
  //   在热路径上做等于给每次派活加一次循环依赖风险。它由 `起飞前检查.mjs` 的
  //   「级模型过载体能力闸」那条自检**离线逐级核**（同一个 `checkModel`，失败拦起飞）。
  //
  // ★ 2026-10-16（§3.5 三档抽象）：这一级配的是**抽象档（省/中/狠）**时，落地要按**这个模型自己的白名单**挑具体值：
  //     · 该档首选就支持 ⇒ status=ok；降级取到别的 ⇒ status=degraded（**要留痕**）；
  //     · 模型一个档位都没声明（例 xiaomi）⇒ status=unsupported，`effort=null`（**不传**，载体按自己默认跑）；
  //     · 档案里查不到这个模型 ⇒ status=unknown，`effort=null`（**未核实**，不猜也不拦）。
  //   老写法（直接写 `effort: "max"`）**仍兼容**：它只当作"一个候选"，照样过一遍白名单。
  const tiers = cfg?.levels?.effortTiers ?? DEFAULT_EFFORT_TIERS
  // ⚠️ 载体的"家名"写法与档案里的家名**不一定一样**（例：Pi 写 `xiaomi-token-plan-cn`，档案里是 `xiaomi`）——
  //   直接拿前缀去查档案会永远"查不到"（实测：L2 那条报"档案里没有这家"）。⇒ 先归一，再查。
  const homeOf = (m) => {
    const raw = String(m).split(/[\/:]/)[0]
    try { return canonOfCarrierName(raw, null, {}) ?? raw } catch { return raw }
  }
  // ★ 2026-10-16：档位来源**按这个角色走哪条路**定（messenger 走我们生成的路由表 patch；其余走 DSH 档案）
  const via = (role?.agent === 'messenger') ? 'messenger' : 'carrier'
  let effortOut = effortRaw
  let effortInfo = null
  if (effortTier && EFFORT_TIERS.includes(effortTier)) {
    effortInfo = resolveEffortValue(homeOf(model), model, effortTier, tiers, { via })
    effortOut = effortInfo.resolved
  } else if (effortRaw) {
    // 读兼容：把具体值也过一遍白名单（模型不认就如实降级/不传 —— 与抽象档同一口径）
    effortInfo = resolveEffortValue(homeOf(model), model, effortRaw, { [effortRaw]: [effortRaw] }, { via })
    if (effortInfo.status === 'unsupported') effortOut = null
    else if (!effortInfo.resolved) effortOut = effortRaw
  }
  return { level: L, model, effort: effortOut, effortTier: effortTier ?? null, effortInfo, missing: false, warn: null, why: null }
}

/** 取角色的 levels 段（没有 ⇒ 空对象）。 */
export function roleLevels (cfg, roleName) { return cfg?.roles?.[roleName]?.levels ?? {} }

/**
 * 取某个角色的完整解析结果。
 * @param opts.model / opts.effort —— **任务级覆盖**（优先级最高）。
 * @param opts.level —— **任务分级 L1..L4**（★ 2026-10-16 新增）；给了就必须配好，否则**报错**。
 *        优先级：任务级覆盖 > 级 > role.prefer > role.model（旧字段，兼容）
 */
// ★ 2026-10-05 额度兜底接线：**派活前先问"这一轮该走哪家"**（协议见 KB `08-额度兜底与切换协议.md`）。
//   这两个模块只依赖 fs，不会反向 import 本模块 → **无循环依赖**。
import { pick as quotaPick } from './额度切换.mjs'
import { discoverProviders as quotaProviders, resolveKey as resolveQuotaKey } from './额度钥匙.mjs'
// ★ 2026-10-12：「这家在这个载体上叫什么」抽成**唯一实现**（`_家名.mjs`）——
//   原来面板侧自己写了一份（且漏了 `perCarrier`）⇒ 面板写进去 `xiaomi/…`，
//   而运行侧这里拼的是 `xiaomi-token-plan-cn/…`（Pi/OpenCode 的套餐口）＝**两个口径**。
import { carrierNameOf, carrierKeyEnvOf, canonOfCarrierName } from './_家名.mjs'
// ★ b43：载体**自己配置里那条模型路由**要哪个钥匙变量/走哪一家（无环：那个模块不 import 本模块）
import { carrierModelBinding } from './同步载体模型.mjs'
// ★ 2026-10-18（b122 · 十三 S4b）：「这个载体要不要按它自己配置里的绑定补钥匙」的唯一出处＝
//   `_crew\carriers.json` 的 `needsModelBindingKey`（原来是行内写死载体名）。无环：那个模块只 import node 内置。
import { needsModelBindingKeyOf } from './_载体属性.mjs'

export function resolveRole (roleName, cfg, opts = {}) {
  // ★ 2026-10-07（用户口径："关于角色使用的模型，**千万不要写死**，因为我会通过看板更换模型，
  //   应该是随看板选择而改变的"）：
  //   原来这里是 `cfg.roles[roleName] ?? cfg.roles['coder-a']` —— **角色名写错/不存在时会悄悄冒用 coder-a**
  //   （连它的模型一起冒用）⇒ 等于"用一个写死的角色替你决定模型"。
  //   **现在找不到就响亮报错**，并列出可用角色名；**绝不冒用别人的模型、也不给角色模型留内置默认值**。
  const role = cfg.roles?.[roleName]
  if (!role) {
    const have = Object.keys(cfg.roles ?? {})
    throw new Error(
      `没有这个角色：${roleName}` +
      (have.length ? `（配置里只有：${have.join('、')}）` : '（配置里一个角色都没有 —— 检查 _crew\\agents.json 读没读到、有没有 roles 段）') +
      ' —— 角色与模型一律以 `_crew\\agents.json`（看板改的那份）为准；代码不猜、也不冒用别的角色'
    )
  }
  const agentName = role.agent ?? cfg.defaultAgent
  // ★ 2026-10-07：`route` 变成**可变** —— 调研员（DSH headless）换家时它必须跟着跳板走（见下面 failover 段）
  let roleRoute = role.route ?? null
  // ★ 2026-10-10（存量 gap 修根因）：**找不到载体就响亮报错，绝不冒用 defaultAgent**。
  //   原来这里是 `cfg.agents[agentName] ?? cfg.agents[cfg.defaultAgent] ?? {}` ——
  //   实测后果（故意删掉 agents.codebuddy、roles.reviewer 仍指着它）：
  //     `resolveRole('reviewer')` 回来 `agentName='codebuddy'`，但 `agent.entry` 已经是 **Pi 的 cli.js**
  //     ⇒ **名字对、命令错**（日志/回执写着 CodeBuddy，实际跑的是 Pi）——比"换成 messenger"更难查。
  //   这里与上面"没有这个角色"同一个口径：**不猜、也不冒用别人的东西**。
  if (!cfg.agents?.[agentName]) {
    const have = Object.keys(cfg.agents ?? {})
    throw new Error(
      `角色 ${roleName} 指定的载体 "${agentName}" 在 agents 里**不存在**（现有：${have.length ? have.join('、') : '一个都没有'}）` +
      ` —— 载体声明一律以 \`_crew\\agents.json\` 的 agents 段为准；**代码不冒用 defaultAgent（${cfg.defaultAgent ?? '?'}）的载体**（那会变成"名字对、命令错"）`
    )
  }
  const agent = cfg.agents[agentName]
  const prefer = role.prefer ?? (role.model ? { model: role.model, effort: role.effort } : {})
  // ★ 2026-10-16（任务分级）：**级覆盖层**插在"任务级覆盖"与 `prefer` 之间。
  //   `opts.level` 为空 ⇒ 一个字都不改（＝今天的行为，天然可关）。
  //   给了级号但那一级没配模型 ⇒ **响亮报错**（用户口径：某级没配就报错，不许静默走默认）。
  let levelInfo = null
  if (opts.level !== undefined && opts.level !== null && opts.level !== '') {
    levelInfo = levelsOf(roleName, cfg, opts.level)
    if (levelInfo.missing) {
      throw new Error(
        `任务分级：${levelInfo.why ?? `级 ${opts.level} 没配`}` +
        `　—— 级模型只能由**看板**写进 \`_crew\\agents.json\` 的 roles.${roleName}.levels.<级>；` +
        `**代码里不写死模型名、也不会拿 prefer 顶上**（依据 KB 重构\\任务分级-施工文档.md §4 规矩 2）`
      )
    }
  }
  let model = opts.model ?? levelInfo?.model ?? prefer.model ?? null
  // ★ 2026-10-16（§3.5）：级的 `effort` 是**三态**，不能用 `??` 串起来：
  //    · 级**没配档位**（null）⇒ 才回落到 `prefer.effort`（＝今天的行为）；
  //    · 级**配了**但落地是 `null`（这家不认档位 / 未核实）⇒ **必须就是 null**（＝不传），
  //      绝不能回落主选的 max —— 那会把"这家不支持档位"变成"悄悄换成 max"，正是这次要堵的静默。
  let effort
  if (opts.effort) effort = opts.effort
  else if (levelInfo && (levelInfo.effortTier || levelInfo.effortInfo)) effort = levelInfo.effort
  else effort = levelInfo?.effort ?? prefer.effort ?? role.effort ?? null
  let modelSource = (opts.model || opts.effort)
    ? 'task-override'
    : (levelInfo ? 'level-override' : (role.prefer ? 'prefer' : 'role.model'))
  if (levelInfo && modelSource === 'task-override') modelSource = 'task-override+level'   // 级也在场（如实标）
  // ★ 2026-10-05 额度兜底（三条硬约束）：
  //   ① **任务级 `--model` 优先**（显式指定的绝不覆盖）；② 引擎出错**绝不影响主流程**（try/catch 兜住）；
  //   ③ 全线无可用时**不静默照跑** —— 在 `failover` 里如实标记，编排可以据此停手并回大脑。
  let failover = null
  //   ★ 2026-10-16（任务分级）连带修：**级模型等同于"用户显式指定"** —— 原来这里只判 `!opts.model`，
  //     于是 `--level L2` 时 `opts.model` 为空 ⇒ 兜底引擎**把级模型顶掉了**（实测：四级全被换成 prefer 的 flash）。
  //     这与《任务分级》规矩 4「额度兜底不越级」直接冲突 ⇒ 级在场时也**不进兜底**（只换 API、不换模型那条链不动）。
  if (opts.quotaFailover !== false && !opts.model && !levelInfo?.model) {
    try {
      const p = quotaPick(roleName)
      const routing = quotaProviders()
      // 权威名 → **载体认的名字**（例：`aliyun` → `qwen-token-plan-cn`，因为 pi 的命令行就是这么写的）
      // ★ 2026-10-07：先看**这家在"这个载体"上的名字**（`perCarrier`，数据驱动），再回落全局 alias，最后才是权威名。
      // ★ 2026-10-12：整条规则搬进 `_家名.mjs`（**面板写配置时用的是同一份**）。
      const carrierName = (canon) => carrierNameOf(canon, agentName, { routing })
      if (p.ok && (p.provider || p.model)) {
        // ★ 关键：**选中的还是"它自己的首选"（idx=0）时，一个字都不改** ——
        //   否则会把 `custom-local:kimi-k3` 这类规范化成 `ark/kimi-k3`，或把裸模型名加上供应商前缀，
        //   而载体可能不认那个前缀 → **干净状态下也会改行为**（踩过）。
        if (p.idx > 0) {
          // ★ 2026-10-07：跳板可能**没有 provider**（载体自有订阅：Qoder / CodeBuddy）⇒ 用**裸模型名**，
          //   **绝不拿 null 拼前缀**（那会写出 `null/Qwen3.8-Flash` 这种废字符串）。
          const to = p.provider ? (carrierName(p.provider) + '/' + p.model) : p.model
          // ★ 2026-10-07：**调研员（DSH headless）吃 `--route`** —— 换家时 `route` 必须跟着走，
          //   否则会拿"旧家的 route + 新家的模型"去跑（`coder-b-dsh.mjs` 会 UNKNOWN_MODEL）。
          if (agentName === 'messenger' && p.provider) roleRoute = p.provider
          if (to !== model) failover = { provider: p.provider, from: model, to, why: p.why, keySource: p.keySource, at: new Date().toISOString() }
          model = to
          effort = p.effort ?? effort
          if (failover) modelSource = 'quota-failover'
        }
      } else if (p.tried?.length) {
        failover = { provider: null, blocked: true, why: p.reason, tried: p.tried.map(t => t.provider + ':' + (t.usable ? 'ok' : '✗')) }
      }
    } catch (e) { failover = { provider: null, blocked: false, why: '兜底引擎出错（已忽略，照原配置跑）：' + String((e && e.message) || e) } }
  }
  return {
    roleName,
    role,
    agentName,
    agent,
    model,
    effort,
    modelSource,
    level: levelInfo?.level ?? null,          // ★ 任务分级：本次实跑的级号（没标级＝null）
    levelModel: levelInfo?.model ?? null,     // 该级配的模型（便于看板/账本核对"显示 max、实际跑 L1"）
    // ★ 2026-10-16（§3.5）：档位如实记两样 —— `effortTier`＝你在看板选的那个抽象档；
    //   `effort`＝真发出去的具体值（null ＝ 没发）。`effortInfo.status` 说明为什么没发。
    effortTier: levelInfo?.effortTier ?? null,
    effortInfo: levelInfo?.effortInfo ?? null,
    failover,
    prefer: { model: prefer.model ?? null, effort: prefer.effort ?? null },
    fallback: Array.isArray(role.fallback) ? role.fallback : [],
    route: roleRoute,
    worktree: role.worktree === true,
    denyTools: role.denyTools ?? [],
    allowTools: role.allowTools ?? null,
    extraArgs: Array.isArray(role.extraArgs) ? role.extraArgs : [],
    reviewQuestion: role['复核时多问一句'] ?? null
  }
}

/** 判断一个入口该不该用 node 起：扩展名**或** shebang。
 *  为什么加 shebang 判断：CodeBuddy 的入口叫 `bin\codebuddy`，**没有扩展名**，
 *  但第一行是 `#!/usr/bin/env node`。只看扩展名会把它当 exe 直接 spawn → Windows 上必失败。 */
function isNodeScript (p) {
  if (!p) return false
  if (/\.(mjs|cjs|js)$/i.test(p)) return true
  try {
    const fd = openSync(p, 'r')
    try {
      const buf = Buffer.alloc(64)
      const n = readSync(fd, buf, 0, 64, 0)
      const head = buf.subarray(0, n).toString('utf8')
      return head.startsWith('#!') && /node/i.test(head)
    } finally { closeSync(fd) }
  } catch { return false }
}

/** 组装"跑这个 agent 用哪条命令"。 */
export function buildInvocation (resolved, promptText, opts = {}) {
  const a = resolved.agent
  const args = []
  if (Array.isArray(a.printArgs)) args.push(...a.printArgs.map(x => expand(x)))
  // ★ b47 实测**方法 A 不通，已回退**（证据留在注释里，别再走一遍）：
  //   ① 传 `--openai-base-url` **不优先于配置里的路由** —— `ark/step-5-preview-free`（ark 没有这个模型）
  //      居然打到了 **ocgo**（报的是 opencode 的 `MissingSessionID`）⇒ 说明模型仍按 `modelProviders` 的路由解析；
  //   ② Qwen Code 自己给了提示原文："**is field to modelProviders.ark[].generationConfig for that model
  //      if you want it to apply**" ⇒ `settings.model.generationConfig` 那一层**在这里不生效**，头必须写在
  //      **该家该模型的 `modelProviders[<家>][].generationConfig.customHeaders`**（我们本来就是这么写的 ✓）。
  //   ⇒ 现在只做一件安全的事：**把 `家/` 前缀剥掉**（`家/模型` 是我们面板的统一写法，但 API 只认裸名）。
  // ★ b72（2026-10-13）：**改数据驱动** —— 原来这里写死 `resolved.agentName === 'qwencode'`，
  //   结果 **messenger（DSH headless）漏了**：它的 `--model` 同样只吃裸名（家由 `--route` 给），
  //   而面板把模型统一写成 `家/模型` ⇒ 真跑直接 `dsh: UNKNOWN_MODEL: pi-ai provider "xiaomi" has no
  //   configured model "xiaomi/mimo-v2.6-flash"`（**调研员整个跑不起来**，坑库 2026-10-04 记过同一条，
  //   当时只补了"改两处"的人工规矩、代码没修全）。现在看 `agents.json` 的 `modelArgBare` 标记，
  //   同一件事不再各写一遍、也不再往代码里写载体名。
  let modelArg = resolved.model
  if (a.modelArgBare && resolved.model) {
    const m = /^([^/:]+)[/:](.+)$/.exec(String(resolved.model))
    if (m) modelArg = m[2]
  }
  if (modelArg && a.modelFlag) args.push(a.modelFlag, modelArg)
  // 推理强度：优先用 effortArgs 模板（两个 token 的写法，例：-c model_reasoning_effort=max），否则用 effortFlag
  if (resolved.effort) {
    if (Array.isArray(a.effortArgs) && a.effortArgs.length) {
      for (const t of a.effortArgs) args.push(expand(String(t).replaceAll('${EFFORT}', resolved.effort)))
    } else if (a.effortFlag) {
      args.push(a.effortFlag, resolved.effort)
    }
  }
  if (resolved.route && a.routeFlag) args.push(a.routeFlag, resolved.route)
  if (a.permissionMode) args.push('--permission-mode', a.permissionMode)
  if (resolved.denyTools?.length && a.denyToolsFlag) args.push(a.denyToolsFlag, resolved.denyTools.join(','))
  if (resolved.allowTools?.length && a.allowToolsFlag) args.push(a.allowToolsFlag, resolved.allowTools.join(','))
  for (const x of resolved.extraArgs ?? []) args.push(...String(x).split(/\s+/).filter(Boolean))
  if (opts.worktreeName && resolved.worktree && a.worktreeFlag) args.push(a.worktreeFlag, opts.worktreeName)
  else if (opts.cwd && a.dirFlag) args.push(a.dirFlag, opts.cwd)
  for (const d of opts.addDirs ?? []) if (a.extraDirFlag) args.push(a.extraDirFlag, d)
  if (opts.resumeSessionId && a.sessionFlag) args.push(a.sessionFlag, opts.resumeSessionId)
  // ★ 2026-10-23（施工文档 D8）：**"手"由 MCP 提供** —— 审核载体自己挂 `dsh-computer-use-win`（CodeBuddy 的口子是 `--mcp-config`）。
  //   口径：**只有调用方真给了配置文件才加**（`opts.mcpConfig`）⇒ 没装 MCP 的机器上这条**完全惰性**，不会把审核弄挂。
  if (opts.mcpConfig && a.mcpConfigFlag) args.push(a.mcpConfigFlag, opts.mcpConfig)
  args.push(promptText)

  const entry = expand(a.entry ?? '')
  const node = expand(a.node ?? '')
  const isJs = isNodeScript(entry)
  const exe = node && isJs ? node : (entry || node)
  const argv = node && isJs ? [entry, ...args] : args
  return { exe, args, argv, argvForDisplay: [exe, ...argv] }
}

/**
 * 跑这个 agent 时要不要清掉/注入环境变量。
 *   envClear：清掉（例：CI）
 *   env：按需注入（例：CODEX_HOME 指到包内配置；API key 用 `${CRED:名字}` 从凭据库现读）
 */
/**
 * ★ 2026-10-07（用户拍板①）：**同一个家，在不同载体上"名字"和"钥匙变量"可能不同**。
 *   实测：Pi / OpenCode 内置**两个**小米 provider ——
 *     `xiaomi`               → 按量计费口（`api.xiaomimimo.com`）
 *     `xiaomi-token-plan-cn` → 套餐口（`token-plan-cn.xiaomimimo.com`）
 *   而我们手上的是**套餐钥匙** ⇒ 拼成 `xiaomi/…` 就会打到**错的口** ⇒ **401**（昨晚在 Pi 和 OpenCode 上各实测一次）。
 *   而 DSH（messenger/researcher）档案里的 `xiaomi` **本来就是套餐口** ⇒ 它必须保持 `xiaomi` 不变。
 *   ⚠️ 所以**不能**给路由表加"全局 alias"（那会把 messenger 也改成 token-plan 名，反而弄坏调研员）。
 *   ⇒ 映射写成**数据**（`_unattended\_coder路由表.json` 里那家的 `perCarrier`），**代码不写死任何厂商名**。
 *   查不到就返回 null，调用方回落到老行为（零影响）。
 * ★ 2026-10-12：实现搬进 `_家名.mjs`（`perCarrierOf`）——**面板那一侧也要用同一条**，别再各写一份。
 */

export function envFor (resolved, base = process.env) {
  const env = { ...base }
  for (const k of resolved.agent.envClear ?? []) env[k] = ''
  const extra = resolved.agent.env
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      env[k] = expand(String(v ?? ''))
        .replaceAll('{dsHome}', resolve(WORKSPACE, '_arkhome'))
        .replaceAll('{ws}', WORKSPACE)
    }
  }
  // ★ 2026-10-05 额度兜底：**切了供应商就必须同时给它那家的钥匙** ——
  //   实测缺口：`agents.pi.env` 只配了阿里那家（QWEN_TOKEN_PLAN_CN_API_KEY），切到 `ark` 后
  //   pi 手里没有 `ARK_API_KEY` → **必然鉴权失败**（等于没切）。这里按"路由表的 apiKeyEnv +
  //   三层密钥解析（环境变量 > 本机密钥库 > 项目凭据库）"把钥匙补进这次调用的环境里。
  //   只覆盖**这一次调用**（不改 agents.json、不落盘），所以不影响其它载体/其它角色。
  if (resolved.failover?.provider) {
    try {
      const providers = quotaProviders()
      const p = providers[resolved.failover.provider]
      const k = resolveQuotaKey(resolved.failover.provider, 0, undefined, undefined, providers)
      // ★ 2026-10-07：注入的**变量名**也可能按载体不同（Pi/OpenCode 的套餐口要 `XIAOMI_TOKEN_PLAN_CN_API_KEY`，
      //   DSH 的 `xiaomi` 要 `XIAOMI_API_KEY`）⇒ 先查 `perCarrier[载体].keyEnv`，查不到才回落路由表的 apiKeyEnv。
      const envName = carrierKeyEnvOf(resolved.failover.provider, String(resolved.agentName ?? '')) ?? p?.apiKeyEnv
      if (envName && k?.key) env[envName] = k.key
    } catch { /* 补钥匙失败不拦主流程：载体会用自己的报错说明问题 */ }
  }
  // ★ 2026-10-12（b37）：**"当前模型那一家的钥匙"也要注入** —— 原来只在"额度兜底切了家"时注入，
  //   于是"在一家没有静态钥匙的家上选模型"（例：给 Pi 选 `ark/…`，而 `agents.pi.env` 里没有 `ARK_API_KEY`）
  //   会在**干净状态下**必鉴权失败 —— 这又是"选了没用"的一种形态。
  //   口径：能定位到"当前模型属于哪家"就注入那家的钥匙（变量名按**这个载体认的写法**，
  //   查不到回落路由表的 `apiKeyEnv`）；拿不到就什么都不做（绝不瞎写）。
  try {
    const providers = quotaProviders()
    // ⚠️ 这里必须用 **`resolved.model`**（本函数没有 `model` 变量）—— 我第一版写成裸 `model`，
    //    ReferenceError 被下面的 catch 吞掉 ⇒ **静默不注入**，真跑一次才逮住（Pi 报 "无模型可用"）。
    const provName = String(resolved.model ?? '').split(/[\/:]/)[0]
    const canon = provName ? canonOfCarrierName(provName, String(resolved.agentName ?? '')) : null
    if (canon && providers[canon]) {
      const envName = carrierKeyEnvOf(canon, String(resolved.agentName ?? '')) ?? providers[canon].apiKeyEnv
      const k = resolveQuotaKey(canon, 0, undefined, undefined, providers)
      if (envName && k?.key) env[envName] = k.key
      // ★ b47：Qwen Code 走**运行时模型**（`--auth-type openai` ＋ `--openai-base-url`）⇒ 它按 openai 的
      //   **默认环境变量 `OPENAI_API_KEY`** 取钥匙；而 `agents.json` 里静态钉的是火山那把 ⇒
      //   必须**用当前这家覆盖掉**，否则"选了别家却拿火山的钥匙去鉴权"＝401（这正是 b43 那个坑的同类）。
      if (String(resolved.agentName ?? '') === 'qwencode' && k?.key) env.OPENAI_API_KEY = k.key
    }
  } catch { /* 同上：不拦主流程 */ }
  // ★ 2026-10-12（b43）：**"载体自己配置里那条路由要哪个钥匙变量"也要喂上**。
  //   起因：rescue（Qwen Code）选别家的模型一直 401 —— 查实四家钥匙都好（`/models` 全 200），
  //   但派活时 `envFor` 只注入了"钉死那一家"的 `OPENAI_API_KEY`，而它 `settings.json` 里
  //   那几条路由要的是 `SILICONFLOW_API_KEY` / `XIAOMI_API_KEY`（Qwen Code 从 `process.env[envKey]` 读）
  //   ⇒ 路由没钥匙 ⇒ 401。这里按"它自己配置里这条模型绑的是哪家/哪个变量"补上。
  try {
    // ★ 2026-10-18（b122 · 十三 S4b）：**载体名不再写死在这里** —— 改读声明的 `needsModelBindingKey`
    //   （原来写的是 `agentName === 'codebuddy' || agentName === 'qwencode'` ⇒ 加一个同类载体就要改代码）。
    if (needsModelBindingKeyOf(resolved.agentName)) {   // ⚠️ 是 `resolved.agentName`（本函数没有裸 agentName）
      const b = carrierModelBinding(resolved.agentName, resolved.model)
      if (b?.envKey && b?.canon) {
        const k = resolveQuotaKey(b.canon, 0, undefined, undefined, quotaProviders())
        if (k?.key) env[b.envKey] = k.key
      }
    }
  } catch { /* 同上：不拦主流程 */ }
  return env
}

/** 取某个 agent 注入的环境变量（供自检/演练打印；**凭据一律打码**）。 */
export function envOverridesOf (resolved) {
  const out = {}
  const extra = resolved.agent?.env
  if (extra && typeof extra === 'object') {
    for (const [k, v] of Object.entries(extra)) {
      const raw = String(v ?? '')
      if (/\$\{CRED:/.test(raw)) { out[k] = maskSecrets(raw); continue }
      out[k] = expand(raw).replaceAll('{dsHome}', resolve(WORKSPACE, '_arkhome')).replaceAll('{ws}', WORKSPACE)
    }
  }
  return out
}

/** 这个角色要用到的凭据变量名（供自检核对"key 在不在"，不读值）。 */
export function credNamesOf (resolved) {
  const names = new Set()
  for (const m of JSON.stringify(resolved.agent?.env ?? {}).matchAll(/\$\{CRED:([A-Za-z0-9_]+)\}/g)) names.add(m[1])
  return [...names]
}

/**
 * ★ 解析载体输出，**收口成一封统一信封** —— 让记账/判定逻辑只写一份（自检与编排共用）。
 *
 * 两族输出（2026-10-03 实测确认）：
 *   ① 单信封：整段就是一个 JSON（Qoder `-p -o json`、DSH headless）
 *   ② JSONL 事件流：一行一个事件
 *      · Pi `--mode json`：… → message_end / turn_end（`message.content[].text` 是最终文本、
 *        `message.usage` 给 token；`agent_end` 是整个会话，别拿它当结果）
 *      · OpenCode `run --format json`：step_start / tool_use / step_finish / **text**（`part.text` 是最终文本、
 *        `step_finish.part` 给 tokens 与 cost）
 * 返回统一字段：{ kind, ok, isError, result, stopReason, usage, model, provider, sessionId, permissionDenials, toolCalls, error }
 */
export function parseCarrierOutput (stdout, stderr) {
  const text = String(stdout ?? '').replace(/^\uFEFF/, '')
  const errText = String(stderr ?? '').replace(/^\uFEFF/, '').trim()
  const errTail = errText ? errText.slice(-300) : ''
  const base = {
    kind: 'unknown', ok: false, isError: true, result: '', stopReason: null, usage: null,
    model: null, provider: null, sessionId: null, permissionDenials: [], toolCalls: 0,
    // ★ A（2026-10-10）：**回合数**（模型被调了几次）。取不到＝null（"没这字段"≠0）。
    //   为什么单开一个字段而不复用 usage.steps：steps 只在 JSONL 分支有值，
    //   而数组/单信封（CodeBuddy·Qwen 一族）本来就带 num_turns —— 统一到一处，账本只认 numTurns。
    numTurns: null,
    // ★ b219（2026-10-22）：**上下文峰值**（按回合取 max，不取末值）。
    //   为什么要它：末值只能说明"收尾时剩多少"，看不出"这一卡最高顶到多少"——
    //   拆分经济（G5 的 >60% 必拆 / <15% 下次合并）靠的正是峰值。取不到＝null（不编 0）。
    ctxPeak: null,
    credits: undefined, error: null, events: 0, stderrTail: errTail
  }
  // ★ 2026-10-03：stdout 为空时**必须看 stderr** —— 实测 CodeBuddy 遇额度/网关错误时
  //   **exit=0 + stdout 空 + 把 429 写进 stderr**（静默失败）。不看 stderr 就只能报个"解析失败"。
  if (!text.trim()) {
    return { ...base, kind: errTail ? 'stderr-only' : 'unknown', error: errTail ? `stdout 为空；stderr：${errTail}` : 'stdout 为空' }
  }

  /** 回合数取值：`num_turns` / `numTurns` / `usage.num_turns`；取不到＝**null**（不编 0）。
   *  三条出口（数组 / 单信封 / JSONL）共用这一个口径，免得各写各的。 */
  function pickTurns (o) {
    if (!o || typeof o !== 'object') return null
    const cands = [o.num_turns, o.numTurns, o.turns, o.usage?.num_turns, o.usage?.numTurns]
    for (const v of cands) {
      const n = Number(v)
      if (Number.isFinite(n) && n >= 0) return n
    }
    return null
  }

  // ★ 五·S5（2026-10-09）：把**嵌套**的缓存命中/写入拍平成 usage.cacheRead / usage.cacheWrite。
  //   有些信封把命中数放在 usage.prompt_tokens_details.cached_tokens（**对象**）里，而账本/看板
  //   只扫**顶层数字** ⇒ 见对象就跳过 ⇒ 命中数永远读成"没这字段"（账本瞎的根）。
  //   纪律：顶层已有就以顶层为准（0＝真没命中，`??` 不会把 0 顶掉）；全都没有＝null（**不许编 0**）。
  /** ★ b219：取"数字或 null"（`0` 是合法值，`??` 不会把它顶掉；非数字一律 null，不编 0）。 */
  const numOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null))
  const noteCtxPeak = (u, acc) => {
    const v = numOrNull(u?.context_usage_ratio ?? u?.contextUsageRatio)
    if (v === null) return acc
    return acc === null ? v : Math.max(acc, v)
  }

  function flattenUsage (u) {
    if (!u || typeof u !== 'object' || Array.isArray(u)) return u
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
    const d = (u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object') ? u.prompt_tokens_details
      : (u.promptTokensDetails && typeof u.promptTokensDetails === 'object' ? u.promptTokensDetails : null)
    const topCr = num(u.cacheRead ?? u.cache_read_input_tokens ?? u.cacheReadInputTokens ?? null)
    const topCw = num(u.cacheWrite ?? u.cache_creation_input_tokens ?? u.cacheCreationInputTokens ?? null)
    const detCr = d ? num(d.cached_tokens ?? d.cachedTokens ?? d.cache_read_tokens ?? null) : null
    const detCw = d ? num(d.cache_creation_tokens ?? d.cacheCreationTokens ?? d.cache_write_tokens ?? null) : null
    return { ...u, cacheRead: topCr ?? detCr, cacheWrite: topCw ?? detCw }
  }

  // ① 单信封 / JSON 数组
  try {
    const j = JSON.parse(text)
    // ★ 2026-10-14 修（**真 bug**，逐家真跑时逮到）：整段**只有一个 JSON 对象**时，这里原来一律当"单信封"。
    //   但载体**只回一行**时会吐**单个事件**（实测 OpenCode：`{"type":"text","part":{"text":"紫色河马"},"sessionID":"…"}`）
    //   —— 它不是信封：正文在 `part.text`、会话号在 `sessionID`（**大写 ID**），而这一支只认
    //   `j.result` / `j.message.content` / `j.session_id` ⇒ **正文空、会话号 null，却仍然返回 `ok:true`**（静默假通过）。
    //   ⚠️ 后果正好打在「插话」上：插话指令通常很短 ⇒ 载体常常**只回一行** ⇒ 面板收活时账本收据**没会话号**
    //   ⇒ **下一次就续不上了**（链断在这儿）。
    //   修法：认出"这是事件、不是信封"就**主动退出这一支**，让下面那个 **JSONL 分支**去处理
    //   （那一支本来就正确处理 OpenCode 的 `text` / `step_finish`，也取 `sessionID`）。
    const envelopeMarkers = ('result' in j) || ('is_error' in j) || ('session_id' in j) || ('subtype' in j) ||
      (j.message && typeof j.message === 'object') || j.type === 'result' || j.type === 'error'
    const eventShaped = (j.part && typeof j.part === 'object') || (typeof j.sessionID === 'string') ||
      (typeof j.type === 'string' && !envelopeMarkers)
    if (!Array.isArray(j) && !envelopeMarkers && eventShaped) {
      throw new Error('单个对象是**事件**形状（有 part / sessionID / type），不是信封 ⇒ 交给 JSONL 分支')
    }
    // ★ CodeBuddy 的形态：整段是一个**数组**，末元素是 `{type:"result", is_error, result, usage, permission_denials, total_cost_usd}`。
    //   若不单独处理，会被当成"没有 is_error 的对象" → 空结果也算通过（典型的**假通过**）。
    if (Array.isArray(j)) {
      const rev = [...j].reverse()
      const res = rev.find(x => x && x.type === 'result') ?? rev.find(x => x && x.role === 'assistant')
      if (!res) return { ...base, kind: 'json-array', error: `JSON 数组里没有 result / assistant 元素（元素 ${j.length} 个）` }
      const txt = typeof res.result === 'string'
        ? res.result
        : (Array.isArray(res.content) ? res.content.map(c => c?.text ?? '').join('') : '')
      const isErr = res.is_error === true || (res.type !== 'result' && res.status && res.status !== 'success')
      const u1 = flattenUsage(res.usage)
      return {
        ...base, kind: 'json-array', ok: !isErr, isError: isErr, result: String(txt ?? ''),
        stopReason: res.subtype ?? res.status ?? null, usage: u1,
        ctxPeak: numOrNull(u1?.context_usage_ratio ?? u1?.contextUsageRatio),
        sessionId: res.session_id ?? res.sessionId ?? null,
        numTurns: pickTurns(res),
        permissionDenials: Array.isArray(res.permission_denials) ? res.permission_denials : [],
        credits: res.total_cost_usd, events: j.length
      }
    }
    // 单个"错误对象"（OpenCode 报错时就是一行 {"type":"error","error":{...}}）→ 必须当失败，且把话说出来
    // ⚠️ 必须 Boolean() 收口：`j.error && ...` 在 j.error 缺失时返回的是 **undefined** 而不是 false，
    //    会让 isError 变成 undefined（回归测试抓到的：单信封没写 is_error 字段时 isError=undefined）。
    // ★ 2026-10-03 补（回归测试抓到的**第二个盲区**）：JSONL **只有一行**时，整段会被当成"单信封"，
    //   于是 JSONL 分支里那两条判据（errorMessage / stopReason）**根本不会执行** ——
    //   一次快速失败（开头就 400/429）正好只会留下一条 message_end，就又成了假通过。
    //   所以把同一套判据在**单对象分支**里也做一遍。
    const msgLike = (j.message && typeof j.message === 'object' && !Array.isArray(j.message)) ? j.message : null
    const msgErr = msgLike && msgLike.role === 'assistant'
      ? (msgLike.errorMessage ? String(msgLike.errorMessage).slice(0, 300)
        : (/^(error|aborted|refusal|content_filter)$/i.test(String(msgLike.stopReason ?? '')) ? `stopReason=${msgLike.stopReason}` : null))
      : null
    const oneErr = j.is_error === true || j.type === 'error' ||
      (Boolean(j.error) && j.type !== 'tool_use' && j.type !== 'step_finish') || Boolean(msgErr)
    // 结果文本：单信封用 `result`；message 形状的（Pi 的单行 message_end）取 content 里的 text
    const textOf = (m) => Array.isArray(m?.content)
      ? m.content.filter(c => c?.type === 'text').map(c => c.text ?? '').join('')
      : (typeof m?.content === 'string' ? m.content : '')
    const resultText = typeof j.result === 'string' ? j.result
      : (msgLike ? textOf(msgLike) : (typeof j.message === 'string' ? j.message : ''))
    return {
      ...base, kind: oneErr ? (j.error || j.is_error === true ? 'error-object' : 'envelope') : 'envelope', ok: !oneErr, isError: oneErr,
      result: String(resultText ?? ''),
      stopReason: j.stop_reason ?? j.subtype ?? msgLike?.stopReason ?? null,
      usage: flattenUsage(j.usage ?? msgLike?.usage ?? null), model: j.model ?? msgLike?.model ?? null,
      provider: j.provider ?? msgLike?.provider ?? null,
      sessionId: j.session_id ?? null, numTurns: pickTurns(j), credits: j.total_credits,
      permissionDenials: Array.isArray(j.permission_denials) ? j.permission_denials : [],
      error: oneErr ? String(msgErr ?? JSON.stringify(j.error ?? j)).slice(0, 300) : null
    }
  } catch { /* 不是单信封，继续按 JSONL 试 */ }

  // ② JSONL
  const events = []
  let badLines = 0
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t[0] !== '{') continue
    try { events.push(JSON.parse(t)) } catch { badLines++ }
  }
  if (!events.length) return { ...base, error: `无法解析输出（非单信封，也非 JSONL；无法解析的行 ${badLines}）` }

  let result = '', usage = null, model = null, provider = null, sessionId = null
  let stopReason = null, toolCalls = 0, err = null, credits
  let ctxPeak = null   // ★ b219：按回合取上下文峰值（末值只能看"收尾剩多少"）
  let ctxLast = null   // ★ b219：最后一回合的占比（补进 usage，保持 `编排` 读 ctx 的旧口径）
  // ★ 2026-10-05 修（T18 实测误判）：Pi 会在流里写**中间态 error 事件**（如 "Request timed out"），
  //   随后 CLI 内建 auto-retry 成功续跑、任务正常收尾（末尾有 agent_end/agent_settled）。
  //   原来任何 type:error 事件都直接置 err → 明明做完了被判 flaky，重试白烧一次额度（还引发回执回显触发词的连锁误判）。
  //   口径：**流级 error 只有在"其后没有任务级成功终态"时才算失败**；message 级 errorMessage/stopReason=error 仍优先（2026-10-03 的假通过修复不回归）。
  let streamErr = null, streamErrIdx = -1, settledIdx = -1, evIdx = 0, msgErrIdx = -1
  // ★ 2026-10-03：JSONL 的用量要**累加**，不能"后一条覆盖前一条"。
  //   实测（`_演练3` 那份真 Pi 转录）：一次任务 25 个 assistant 回合，最后一条是 **400 失败**、
  //   usage 全 0 —— 原来 `usage = m.usage` 一路覆盖，结果整轮记成 **0 token**（账目失真）。
  //   ⚠️ **只在 `message_end` 上累加**：Pi 的 `turn_end` 带的是**同一条** message 的 usage，
  //   两边都加等于双计（实测两边合计完全相同：input 98383 / output 21908 / cacheRead 1113984）。
  const usageSum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  let usageSteps = 0
  // ★ A（2026-10-10）：**回合数**＝"模型被调了几次"。各族各有一个步数标记，**别只认一族**：
  //   · Pi        → `message_end`（assistant 的）
  //   · OpenCode  → `step_finish`（它**不发 message_end** —— 只认 message_end 会数成 0，
  //                  真信封 `S9-SKILL-1.out.json` 就是这么被抓出来的）
  //   · CodeWhale → `turn_usage`
  //   载体若**自报** `num_turns` 则优先（那是它自己认的数，比我们数事件权威）。
  let assistantTurns = 0
  let explicitTurns = null
  // ★ b71（2026-10-13）：**Claude 式 `stream-json`**（CodeBuddy / Qwen Code 切过去之后的形状）。
  //   真样本：`_probe\stream-json\{rescue,reviewer}.stream-json.jsonl`；事件序列
  //   `system/init → (stream_event) → assistant×N → result/success`。
  //   ⚠️ 它与**数组族同源同字段**（差的只是外层包装：数组 vs 一行一个）⇒ 判据与 `json-array` 分支对齐；
  //      但**用量只认 `result` 那一行**（它已是全程累计）—— assistant 上的 per-message usage 只做兜底，
  //      两者相加就双计（与 Pi 的 `turn_end`/`message_end` 是同一个坑）。
  let ccResult = null
  let ccTurns = 0
  let ccUsageSteps = 0
  const ccUsageSum = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  const denials = []
  for (const e of events) {
    if (e.type === 'error' || (e.error && e.type !== 'tool_use')) { streamErr = JSON.stringify(e.error ?? e).slice(0, 300); streamErrIdx = evIdx }
    if (e.type === 'agent_end' || e.type === 'agent_settled') settledIdx = evIdx
    if (e.type === 'tool_use') toolCalls++
    // ★ b219：每条事件都看一眼上下文占比——**末值**留给 `usage.context_usage_ratio`（沿用旧口径），
    //   **峰值**单独记 `ctxPeak`（拆分经济要用峰值；取不到＝null，不编 0）
    {
      const v = numOrNull(e.usage?.context_usage_ratio ?? e.usage?.contextUsageRatio ??
        e.part?.usage?.context_usage_ratio ?? e.message?.usage?.context_usage_ratio)
      if (v !== null) { ctxLast = v; ctxPeak = ctxPeak === null ? v : Math.max(ctxPeak, v) }
    }
    if (e.sessionID) sessionId = e.sessionID
    if (e.type === 'session' && e.id) sessionId = e.id
    if (e.type === 'message_end' || e.type === 'turn_end') {
      const m = e.message ?? {}
      if (m.role === 'assistant') {
        // ★ A（2026-10-10）：**只数 `message_end`**！Pi 的 `turn_end` 带的是**同一条** message
        //   （与上面用量累加同一个道理）⇒ 两边都数会把一步算成两步。
        //   抓法：`_回合验收.mjs` 的反向用例（message_end ＋ 重复 turn_end 必须仍是 1）。
        if (e.type === 'message_end') assistantTurns++
        const txt = Array.isArray(m.content)
          ? m.content.filter(c => c?.type === 'text').map(c => c.text ?? '').join('')
          : (typeof m.content === 'string' ? m.content : '')
        if (txt) result = txt
        if (e.type === 'message_end' && m.usage) {
          usageSteps++
          for (const k of Object.keys(usageSum)) { const v = Number(m.usage[k]); if (Number.isFinite(v)) usageSum[k] += v }
        }
        if (m.model) model = m.model
        if (m.provider) provider = m.provider
        if (m.stopReason) stopReason = m.stopReason
        // ★ 2026-10-03 修（**实测撞出来的假通过**，证据：`_演练3` 那份 5.5MB 真 Pi 转录）：
        //   Pi 的失败**不在顶层** —— 最后一个 assistant message 上写 `stopReason:"error"` +
        //   `errorMessage:"400 data: … data_inspection_failed"`，而事件流里**一条 `type:"error"` 都没有**。
        //   原来只认 `e.type==='error'` / 顶层 `e.error` → 整轮 400 失败被判成 `ok 收活`、任务进 review。
        //   口径：先看 `errorMessage`（最直接），再看 `stopReason` 是否落在"明确是错"的那几个值上
        //   —— **不要反过来写成白名单**（"不在正常集合里就算错"会把 toolUse / maxTokens 这类误判成失败）。
        // ★ 2026-10-05 补充：message 级错误也可能是**中间态**（CLI auto-retry 前的失败回合，T18 实测两处）——
        //   记 msgErrIdx，收尾时若"其后出现 agent_end/agent_settled 且最后一条 assistant stopReason=stop"则清除。
        //   _演练3 场景（最后一条 message 就是 error、无成功终态）不受影响，不会回归假通过。
        if (m.errorMessage) { err = String(m.errorMessage).slice(0, 300); msgErrIdx = evIdx }
        else if (/^(error|aborted|refusal|content_filter)$/i.test(String(m.stopReason ?? ''))) { err = `stopReason=${m.stopReason}`; msgErrIdx = evIdx }
      }
    }
    if (e.type === 'text' && e.part?.text) result = e.part.text       // OpenCode 的最终文本
    if (e.type === 'step_finish' && e.part) {
      // ★ A（2026-10-10）：OpenCode 的一步 ＝ 一个 `step_finish`（它不发 message_end）
      assistantTurns++
      // OpenCode 走这条（它不发 message_end，两族互不重叠，不会双计）
      // ★ 2026-10-05 修（**看板表3「消耗」把 coder-b 少报约 1500 倍**的根因）：
      //   原来 `usage = { ...(usage ?? {}), ...e.part.tokens }` 是**覆盖式** —— 每个 step 把上一个盖掉，
      //   最后只剩**最后一步**的数字（实测账本里 T8 记成 input 2061 / output 41，真实是 ~15 万 / ~17K）。
      //   而且 opencode 的形状是 `tokens:{input,output,reasoning,cache:{read,write}}`（**cache 是嵌套的**），
      //   账本/快照字段却是 `cacheReadInputTokens` → 也没接上（所以 cacheRead 恒 null）。
      //   改为：**逐步累加 + 把嵌套 cache 拍平**，与 Pi 的 `usageSum` 用同一套字段和同一个 totalTokens 口径。
      const t = e.part.tokens
      if (t) {
        const add = {
          input: Number(t.input) || 0,
          output: Number(t.output) || 0,
          reasoning: Number(t.reasoning) || 0,
          cacheRead: Number(t.cache?.read ?? t.cacheRead) || 0,
          cacheWrite: Number(t.cache?.write ?? t.cacheWrite) || 0
        }
        if (add.input || add.output || add.reasoning || add.cacheRead || add.cacheWrite) {
          usageSteps++
          for (const k of Object.keys(usageSum)) usageSum[k] += add[k]
        }
      }
      if (e.part.cost != null) credits = e.part.cost
    }
    // ★ 2026-10-09 新增（CodeWhale 备案）：`codewhale exec --output-format stream-json` 一族 ——
    //   schema="codewhale.exec-stream"：content(最终文本) / turn_usage(用量) / session_capture / metadata(状态) / done。
    //   ⚠️ 首个真实样本 prompt_cache_hit_tokens=0、miss==input ⇒ "hit 与 input 是否重叠"未实测；
    //   正式接入前需复测，过了再按"input 记总量、hit 另记 cacheRead"接线（样本见 _probe\upgrade-check\codewhale-stream.jsonl）。
    if (e.schema === 'codewhale.exec-stream') {
      if (e.type === 'content' && typeof e.content === 'string' && !e.saved_session_id) result = e.content
      else if (e.type === 'turn_usage') {
        // ★ A（2026-10-10）：CodeWhale 的一步 ＝ 一个 `turn_usage`
        assistantTurns++
        usageSteps++
        usageSum.input += Number(e.input_tokens) || 0
        usageSum.output += Number(e.output_tokens) || 0
        usageSum.reasoning += Number(e.reasoning_tokens) || 0
        usageSum.cacheRead += Number(e.prompt_cache_hit_tokens) || 0
      } else if (e.type === 'metadata' && e.meta) {
        if (e.meta.model) model = e.meta.model
        if (e.meta.provider) provider = e.meta.provider
        stopReason = e.meta.termination_reason ?? e.meta.status ?? stopReason
        if (e.meta.status && e.meta.status !== 'completed') err = `status=${e.meta.status}`
      } else if (e.type === 'session_capture' && e.saved_session_id) sessionId = e.saved_session_id
    }
    // ★ b71：Claude 式 `stream-json` 的三个事件（真样本见上）。**不碰**上面那几族的状态，互不重叠。
    if (e.type === 'system' && e.subtype === 'init') {
      if (e.session_id) sessionId = e.session_id
      if (e.model) model = e.model
    }
    if (e.type === 'assistant' && e.message && typeof e.message === 'object' && e.message.role === 'assistant') {
      ccTurns++
      for (const c of e.message.content || []) {
        if (!c || typeof c !== 'object') continue
        if (c.type === 'text' && c.text) result = c.text   // 末条非空为准（与 Pi 的 message_end 同口径）
        else if (c.type === 'tool_use') toolCalls++
      }
      const u = e.message.usage
      if (u) {
        const add = {
          input: Number(u.input_tokens) || 0, output: Number(u.output_tokens) || 0,
          cacheRead: Number(u.cache_read_input_tokens) || 0, cacheWrite: Number(u.cache_creation_input_tokens) || 0,
          reasoning: Number(u.reasoning_tokens) || 0
        }
        if (add.input || add.output || add.cacheRead || add.cacheWrite || add.reasoning) {
          ccUsageSteps++
          for (const k of Object.keys(ccUsageSum)) ccUsageSum[k] += add[k]
        }
      }
      // 与 Pi 同款的两条失败判据（errorMessage 最直接；stopReason 只认"明确是错"的那几个值）
      if (e.message.errorMessage) { err = String(e.message.errorMessage).slice(0, 300); msgErrIdx = evIdx }
      else if (/^(error|aborted|refusal|content_filter)$/i.test(String(e.message.stopReason ?? ''))) { err = `stopReason=${e.message.stopReason}`; msgErrIdx = evIdx }
    }
    if (e.type === 'result') {
      ccResult = e
      if (typeof e.result === 'string' && e.result) result = e.result   // 它是权威终稿（含报错原文）
      if (e.session_id) sessionId = e.session_id
      if (e.is_error === true) { err = String(e.result ?? 'is_error').slice(0, 300); msgErrIdx = evIdx }
      else if (/^error/i.test(String(e.subtype ?? ''))) { err = `subtype=${e.subtype}`; msgErrIdx = evIdx }
      for (const d of (Array.isArray(e.permission_denials) ? e.permission_denials : [])) denials.push(d)
      if (e.total_cost_usd != null) credits = e.total_cost_usd
    }
    if (explicitTurns === null) { const t = pickTurns(e); if (t !== null) explicitTurns = t }
    evIdx++
  }
  // ★ 流级 error 的取舍（2026-10-05）：message 级 err 优先；流级 error 只有"其后没有成功终态"才算失败
  //   message 级中间态错误（auto-retry 前的失败回合）：其后有 agent_end/agent_settled 且最后一条 assistant stopReason=stop → 清除
  if (err && msgErrIdx >= 0 && settledIdx > msgErrIdx && String(stopReason).toLowerCase() === 'stop') err = null
  if (!err && streamErr && !(settledIdx > streamErrIdx)) err = streamErr
  if (usageSteps) {
    usage = { ...usageSum, steps: usageSteps,
      totalTokens: usageSum.input + usageSum.output + usageSum.cacheRead + usageSum.cacheWrite + usageSum.reasoning }
  }
  // ★ b71：Claude 式 stream-json 的用量**只认 `result` 那一行**（全程累计）；
  //   没有 result 行（跑一半被杀）才回落到"assistant 逐条累加"。
  if (ccResult && ccResult.usage) {
    usage = flattenUsage(ccResult.usage)
  } else if (ccUsageSteps) {
    usage = { ...ccUsageSum, steps: ccUsageSteps,
      totalTokens: ccUsageSum.input + ccUsageSum.output + ccUsageSum.cacheRead + ccUsageSum.cacheWrite + ccUsageSum.reasoning }
  }
  return {
    ...base, kind: 'jsonl', ok: !err, isError: !!err, result,
    usage: (ctxLast !== null && usage && usage.context_usage_ratio == null) ? { ...usage, context_usage_ratio: ctxLast } : usage,
    model, provider,
    ctxPeak: ctxPeak ?? numOrNull(usage?.context_usage_ratio),
    sessionId, stopReason: stopReason ?? (ccResult ? (ccResult.subtype ?? null) : null),
    toolCalls, credits, error: err, events: events.length,
    // ★ b71：JSONL 出口原来**恒为 `[]`**（`...base` 带下来的）—— Claude 式的 `permission_denials`
    //   是有内容的（"被拒条目一票否决"那条口径要用它），所以这里如实带出去。
    permissionDenials: denials.length ? denials : base.permissionDenials,
    // 载体自报优先；没自报就用我们数出来的（一条都没有 ⇒ null，不编 0）
    numTurns: explicitTurns !== null ? explicitTurns : (assistantTurns > 0 ? assistantTurns : (ccTurns > 0 ? ccTurns : null))
  }
}

export { WORKSPACE, DSH_ROOT, AGENTS, NODE_BIN, DSH_HOME, CRED_FILE, HERE }
