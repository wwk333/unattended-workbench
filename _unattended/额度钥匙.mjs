#!/usr/bin/env node
/**
 * 额度钥匙 —— 密钥存取（**按协议 · 供应商不写死**，见 KB `08-额度兜底与切换协议.md`）
 *
 * 协议要点：
 *   P1 供应商 = **档案里已声明的那份 providers**（`cordis.patch.yml` 的 `llm-pi-ai`），本脚本只引用名字；
 *   P5 密钥**永不进仓库**：环境变量 > 本机密钥库（`~\.dsh\unattended-keys.json`）；
 *      日志/界面/看板**只出现标签 + 后 4 位**。
 *
 * 用法：
 *   node 额度钥匙.mjs providers            # 列出"档案里声明了哪些供应商"（发现，不写死）
 *   node 额度钥匙.mjs list                 # 供应商 / 标签 / 来源(env|file) / 掩码 / 优先级
 *   node 额度钥匙.mjs set <供应商> <标签> <密钥>
 *   node 额度钥匙.mjs rm  <供应商> <标签>
 *   node 额度钥匙.mjs resolve <供应商> [序号]   # 只把密钥值打到 stdout（供编排调用）
 *   node 额度钥匙.mjs where                # 密钥库路径 + **安全自检**（不许在工作台/仓库内）
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const WORKSPACE = pathResolve(HERE, '..')                       // 工作台根（无人值守）
export const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
export const KEY_STORE = process.env.DSH_UNATTENDED_KEYS || join(DSH_HOME, 'unattended-keys.json')
export const STRUCT_FILE = join(WORKSPACE, '_crew', '额度兜底.json')

// ---------------------------------------------------------------- 供应商发现（P1：不写死）
/** 找到档案 patch（`llm-pi-ai` 所在的那份 `cordis.patch.yml`）。 */
export function findProfilePatch () {
  const root = join(DSH_HOME, 'profiles')
  if (!existsSync(root)) return null
  for (const p of readdirSync(root)) {
    const f = join(root, p, 'cordis.patch.yml')
    try { if (readFileSync(f, 'utf8').includes('llm-pi-ai')) return f } catch {}
  }
  return null
}

/** ★ 2026-10-05（用户口径）：**以载体的路由表名字为准** ——
 *  `_coder路由表.json` 是供应商的**唯一权威**（名字 / baseURL / apiKeyEnv / api / models）。
 *  档案里的 `llm-pi-ai.providers` 只用来**补齐**（并按 `apiKeyEnv` 认成"同一家的另一种叫法"）。
 *  好处：① 名字只有一套（`aliyun` 而不是 `qwen-token-plan-cn`）；② **aliyun 有了 baseURL → 能探测了**。 */
export function readRoutingTable () {
  const j = readJson(join(WORKSPACE, '_unattended', '_coder路由表.json'), null)
  const out = {}
  if (!j) return out
  for (const [k, v] of Object.entries(j)) {
    if (k === '_说明' || !v || typeof v !== 'object') continue
    out[k] = {
      baseURL: v.baseURL ?? null,
      apiKeyEnv: v.apiKeyEnv ?? v.envField ?? null,
      api: v.api ?? null,
      // ★ 2026-10-12（b38）：**这家要求推理请求带的额外请求头**（数据驱动，代码不写死厂商名）。
      //   实测起因：`ocgo`（opencode zen/go）的 `/models` 探测是 200，但 `POST /chat/completions` 回
      //   `400 {"type":"error","error":{"type":"MissingSessionID",...}}` —— 补上
      //   `x-opencode-session: <ASCII>` 立刻 200 并真出补全。⇒ 这类"网关要求的头"必须能一路带下去
      //   （检测的真调用 / 调研员生成给 DSH 的配置 / 同步进载体清单），否则就是"检测绿、真跑红"的假绿。
      headers: (v.headers && typeof v.headers === 'object') ? v.headers : null,
      note: v.说明 ?? '',                                   // ★ 用来认出"是不是面板添加的"
      // ★ 2026-10-10（用户口径，**opt-in**）：「获取模型」拉回来的清单**默认全不选**，
      //   由用户自己勾需要的 —— 因为有的家清单上百个，"一个个剔除"根本没法用。
      //   字段口径：`keep === false` = 没勾；**没写 `keep` = 选**（兼容旧数据，
      //   所以升级后**已有配置一个模型都不会掉**，只影响升级后新拉的）。
      //   ⚠️ 过滤**只写在这一处** —— 全库消费者（额度切换 / 额度检测 / 看板数据 / 载体能力 / 账号自检）
      //      都经 `discoverProviders()` 拿模型清单，所以这里过滤等于全链路生效。
      models: Array.isArray(v.models)
        ? v.models.filter(m => !(m && typeof m === 'object' && m.keep === false)).map(m => m.id ?? m)
        : Object.keys(v.models ?? {}),
      // 没勾上的名字（给界面画"未选 M 个"用；不进任何选模型的下拉）
      unkeptModels: Array.isArray(v.models)
        ? v.models.filter(m => m && typeof m === 'object' && m.keep === false).map(m => m.id ?? m).filter(Boolean)
        : [],
      source: 'routing'
    }
  }
  return out
}

/** 档案里声明的供应商（`llm-pi-ai.providers`）——**只作为补齐/别名来源**，名字不以此为准。 */
export function discoverProfileProviders (patchFile = findProfilePatch()) {
  const out = {}
  if (!patchFile || !existsSync(patchFile)) return out
  const lines = readFileSync(patchFile, 'utf8').split(/\r?\n/)
  const i0 = lines.findIndex(l => /^\s*-\s*id:\s*llm-pi-ai\s*$/.test(l))
  if (i0 < 0) return out
  // 找到该插件块里的 `providers:`（缩进），再收集比它深一级的 `名字:` 行
  // ⚠️ 从 i0+1 开始扫（否则第一行就是 `- id: llm-pi-ai`，会被"遇到下一个插件就停"的条件立刻 break）
  let base = -1
  let i = i0 + 1
  for (; i < lines.length; i++) {
    const m = /^(\s*)providers:\s*$/.exec(lines[i])
    if (m) { base = m[1].length; break }
    if (/^\s*-\s*id:\s*\S/.test(lines[i])) return out          // 还没找到就到了下一个插件 → 这插件没有 providers
  }
  if (base < 0) return out
  let cur = null
  let inModels = false
  for (i = i + 1; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) continue
    const indent = line.length - line.trimStart().length
    if (indent <= base) break                                   // 出块
    const nameM = new RegExp(`^\\s{${base + 2}}([A-Za-z0-9_.\\-]+):\\s*$`).exec(line)
    if (nameM) { cur = nameM[1]; inModels = false; out[cur] = { apiKeyEnv: null, baseURL: null, api: null, models: [] }; continue }
    if (!cur) continue
    // ★ 2026-10-07 修（用户实测："我加了小米的 API，为什么选不了 MiMo？"）：
    //   以前这里**只读 apiKeyEnv / baseURL / api 三样**（原注释还写着"更深的属于 models[] 里的字段，别误抓"）——
    //   于是**只存在于档案、没写进路由表的家**（例：`xiaomi`）`models` 恒为空 ⇒ 它的模型永远进不了
    //   「职位模型」下拉（`额度面板.mjs` 的 `allModels` 是各家的并集）。
    //   现在把档案里声明的模型 id 也读进来。**路由表仍是权威**：两边都有这家时以路由表为准（见 discoverProviders）。
    if (new RegExp(`^\\s{${base + 4}}models:\\s*$`).test(line)) { inModels = true; continue }
    if (inModels) {
      const idm = /^\s*-\s*id:\s*(.+?)\s*$/.exec(line)
      if (idm) { out[cur].models.push(idm[1].replace(/^["']|["']$/g, '')); continue }
      // ⚠️ 出 models 块时**必须落下去**继续按普通键处理 —— 档案里 `apiKeyEnv` 常写在 models **之后**
      //   （实测：`qwen-token-plan-cn` 就是这样）。这里若 `continue`，那一行会被跳过 ⇒
      //   `apiKeyEnv` 读不到 ⇒ `discoverProviders` 的"同 apiKeyEnv 即同一家"合并失效
      //   ⇒ 面板会**多出一行重复的家**（我第一版就踩了这个，已修）。
      if (indent <= base + 4 && !/^\s*-/.test(line)) inModels = false
      else continue
    }
    // 只认**正好深两级**的键（更深的属于 models[] 里的字段，别误抓）
    const kv = new RegExp(`^\\s{${base + 4}}([A-Za-z]+):\\s*(.+?)\\s*$`).exec(line)
    if (kv && (kv[1] === 'apiKeyEnv' || kv[1] === 'baseURL' || kv[1] === 'api')) out[cur][kv[1]] = kv[2].replace(/^["']|["']$/g, '')
  }
  return out
}

/**
 * 供应商总表 = **路由表（权威名字）** + 档案补齐。
 * 档案里 `apiKeyEnv` 与路由表某家相同的 → 认成**同一家**（记进 `alias`，不重复列）。
 */
/**
 * ★ 2026-10-07（用户口径）：**停用某个家** —— 在 `_coder路由表.json` 那家的条目上加 `"停用": true`
 *   （或 `"disabled": true`）即可，**一处声明、全链路生效**：面板下拉、切换链、编排的钥匙闸门都走这个函数。
 *   为什么需要它：像阿里这种"**钥匙有效、但额度用光**"的家，零 token 探测**看不出额度**
 *   ⇒ 光靠"没钥匙"表达不了"别再用它"，必须有一个**显式、可随时改回**的开关。
 *   ⚠️ 停用 ≠ 删除：路由表里的声明（baseURL / apiKeyEnv / models）**一个字都不动**，去掉标记即完全恢复。
 */
export function discoverProviders (patchFile = findProfilePatch()) {
  const out = discoverProvidersRaw(patchFile)
  // ⚠️ **必须直读路由表**：`discoverProvidersRaw` 会把**档案**里的同名/别名条目合并进来，
  //   合并时只取它认识的字段（baseURL/apiKeyEnv/models…）⇒ "停用"会被丢掉（实测踩过）。
  //   OFF_RAW = 路由表里被标了"停用"的家名 + 它们的别名。
  const OFF_RAW = (() => {
    try {
      const f = join(WORKSPACE, '_unattended', '_coder路由表.json')
      const j = JSON.parse(readFileSync(f, 'utf8').replace(/^\uFEFF/, ''))
      const names = []
      for (const [n, v] of Object.entries(j)) {
        if (!v || typeof v !== "object") continue
        if (v.停用 === true || v.disabled === true) { names.push(n); for (const a of (v.alias ?? [])) names.push(a) }
      }
      return names
    } catch { return [] }
  })()
  for (const n of OFF_RAW) delete out[n]
  for (const key of Object.keys(out)) {
    const v = out[key]
    if (v && (v.停用 === true || v.disabled === true)) delete out[key]
  }
  return out
}

function discoverProvidersRaw (patchFile = findProfilePatch()) {
  const routing = readRoutingTable()
  const profile = discoverProfileProviders(patchFile)
  const out = { ...routing }
  for (const [n, v] of Object.entries(profile)) {
    const canon = Object.entries(routing).find(([, r]) => r.apiKeyEnv && v.apiKeyEnv && r.apiKeyEnv === v.apiKeyEnv)?.[0]
    if (canon) {
      out[canon].alias = out[canon].alias ? [...new Set([...out[canon].alias, n])] : [n]
      if (!out[canon].baseURL && v.baseURL) out[canon].baseURL = v.baseURL
      continue
    }
    out[n] = { ...v, source: 'profile' }        // 只存在于档案、路由表里没有的 → 照实列出
  }
  return out
}
export function readJson (f, dflt) { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return dflt } }

/** ★ 路由表路径（**供应商的唯一权威**）。新增厂商就写这里 —— 面板会自动出现它。 */
export const ROUTING_FILE = join(WORKSPACE, '_unattended', '_coder路由表.json')

/**
 * ★ 2026-10-10 新增：**网址归一化 —— 唯一的规则就在这里**。
 *
 * ## 为什么要有它（用户实测："我点不了添加"+ 拼成 `/models/models`）
 * 用户从文档/控制台**复制的是完整接口地址**（`https://opencode.ai/inference/v1/models`），
 * 而「网址」这格要的是**基址**。全代码库有 **4 处**会在基址后面拼 `/models`
 * （`额度检测.mjs:80`、`额度检测.mjs:98`、`额度面板.mjs:200`、`额度钥匙` 的探测链）——
 * 若在每个拼接点各打一个补丁，就是"**两处口径不同步**"的老病根（前端按钮那个 bug 正是这么来的）。
 * ⇒ 所以**只在"网址落库"那一刻归一一次**（`addProvider` / `面板 saveKey`），下游全都拿到干净基址。
 *
 * ## 规则（**保守**：只砍已知的"接口尾巴"，绝不乱猜）
 * 1. 去首尾空白、去掉末尾所有 `/`；
 * 2. 若带协议（`http(s)://`）且路径**恰好以**已知接口尾巴结尾 → 砍掉它；
 *    - `/models`、`/chat/completions`、`/completions`、`/responses`、`/embeddings`
 *      （`/models` 是实测踩到的那个；其余同类尾巴顺手一起治）
 * 3. **只砍一层**（`…/v1/models/models` → `…/v1`，不是砍成一半又留一半）；
 * 4. **没有协议**的字符串**原样返回** —— 那种情况由调用方去报"必须 http(s):// 开头"的错，
 *    别在这里悄悄改成一个它本来就非法的东西。
 *
 * ⚠️ 副作用（**已知且有界**）：真有哪家的基址**本身就以 `/models` 结尾**，会被砍掉。
 *    本工作台所有已声明的家（ark / aliyun / SiliconFlow / xiaomi / u2）都是"基址 + 拼 /models"，
 *    所以此约定与全库一致；真出现例外，就在那家的探测规格里显式写 `probe.byProvider.<家>.path` 覆盖。
 */
export const URL_ENDPOINT_TAILS = ['/models', '/chat/completions', '/completions', '/responses', '/embeddings']

export function normalizeBaseURL (raw) {
  const s = String(raw ?? '').trim()
  if (!s) return s
  let u = s.replace(/\/+$/, '')                       // 规则 1：去末尾斜杠
  if (!/^https?:\/\//i.test(u)) return u              // 规则 4：没协议 → 原样（让调用方报错）
  for (const tail of URL_ENDPOINT_TAILS) {            // 规则 2 + 3：只砍一层已知尾巴
    if (u.toLowerCase().endsWith(tail)) { u = u.slice(0, -tail.length).replace(/\/+$/, ''); break }
  }
  return u
}

/** 归一化是否**真的改变了**输入（用来只在改动时回显，避免刷屏）。 */
export function urlWasNormalized (raw) { return normalizeBaseURL(raw) !== String(raw ?? '').trim() }

/**
 * **新增一个供应商**（协议 P1：供应商不写死，靠"声明"）。
 * 写进 `_coder路由表.json`（**先备份**）→ 面板与切换链立刻能看到它。
 * 为什么写这里、不另开一份清单：**供应商只能有一个权威来源**，否则又是"两套口径"。
 */
export function addProvider ({ name, baseURL = null, apiKeyEnv = null, api = 'openai-completions', models = [], note = '' } = {}) {
  if (!name || !/^[A-Za-z0-9_.\-]+$/.test(name)) return { ok: false, error: '供应商名不合法（只允许字母/数字/._-）' }
  // ★ 2026-10-10：**先归一化再校验**（用户粘贴的是完整接口地址，如 `…/v1/models`）。
  //   顺序很重要：归一化把尾巴砍掉之后才做 http(s):// 校验，报错信息才对得上用户的输入。
  const rawURL = baseURL
  const cleanURL = baseURL ? normalizeBaseURL(baseURL) : null
  // ★ 2026-10-05 新加（**用户实测踩到**）：有人把**密钥**粘进了「网址」那格 —— 于是拿 `sk-xxx` 当网址去请求，
  //   探测 13ms 就 error，看着像"密钥不对"，其实**网址是错的**。这里直接拦下来，并说清该填哪一格。
  if (cleanURL && !/^https?:\/\//i.test(cleanURL)) {
    return {
      ok: false,
      error: /^sk-/i.test(cleanURL)
        ? '「网址」那格填的像是**密钥**（sk- 开头）—— 密钥请填第 ③ 格；② 这格要填网址，例：https://api.siliconflow.cn/v1'
        : '「网址」那格必须 http:// 或 https:// 开头（例：https://api.siliconflow.cn/v1）'
    }
  }
  if (name === '_说明') return { ok: false, error: '这个名字是保留的' }
  // ★ 用户不该被"环境变量名"这种词绊住：**没给就自动生成**（`openai` → `OPENAI_API_KEY`）。
  //   它只在"用环境变量 / 项目凭据库"时才用到；**直接在这里填钥匙**的话根本不需要它。
  const autoEnv = String(name).toUpperCase().replace(/[^A-Z0-9]/g, '_') + '_API_KEY'
  const env = apiKeyEnv || autoEnv
  const j = readJson(ROUTING_FILE, null)
  if (!j) return { ok: false, error: '读不到路由表：' + ROUTING_FILE }
  if (j[name]) return { ok: false, error: '这家已经在路由表里了：' + name + '（直接给它填钥匙即可）' }
  try { writeFileSync(ROUTING_FILE + '.bak-addprovider-' + Date.now(), readFileSync(ROUTING_FILE)) } catch {}
  j[name] = {
    说明: note || '（由「API 额度」面板添加）',
    api,
    ...(cleanURL ? { baseURL: cleanURL } : {}),
    apiKeyEnv: env, envField: env,
    models: (Array.isArray(models) ? models : []).map(m => ({ id: String(m).trim() })).filter(m => m.id)
  }
  writeFileSync(ROUTING_FILE, JSON.stringify(j, null, 2), 'utf8')
  return {
    ok: true, name, autoEnv: apiKeyEnv ? null : env,
    // 回显归一化结果（只在真改了的时候带出来）—— 让用户看见"我粘的"和"存下的"不是一回事
    baseURL: cleanURL,
    normalized: cleanURL !== (rawURL == null ? null : String(rawURL).trim()) ? { from: String(rawURL).trim(), to: cleanURL } : null,
    note: '已写进路由表（有备份）；面板现在可以给它填钥匙了'
  }
}

/** 删掉一个供应商（同样先备份）。**只删路由表里的声明**，不动已有钥匙。 */
export function removeProvider (name) {
  const j = readJson(ROUTING_FILE, null)
  if (!j) return { ok: false, error: '读不到路由表' }
  if (!j[name]) return { ok: false, error: '路由表里没有这家：' + name }
  try { writeFileSync(ROUTING_FILE + '.bak-rmprovider-' + Date.now(), readFileSync(ROUTING_FILE)) } catch {}
  delete j[name]
  writeFileSync(ROUTING_FILE, JSON.stringify(j, null, 2), 'utf8')
  return { ok: true, name }
}

export function loadStruct () {
  const j = readJson(STRUCT_FILE, null)
  if (j) return j
  // ★ 2026-10-07：**默认值里不再写 `switch` 段** —— 旧字段 `switch.on/neverOn` 是"三条才切"的旧口径，
  //   与现行**全因**口径矛盾，且全代码库无人读取（死配置，会误导人）。现行口径以 `额度切换.mjs` 为准。
  return { version: 1, keys: {}, probe: { default: { kind: 'openai-models', timeoutMs: 8000, treat: { 200: 'ok', 401: 'invalid-key', 402: 'quota', 403: 'quota', 429: 'rate-limited' } }, byProvider: {} }, roles: {}, providerOrder: ['ark', 'xiaomi', 'aliyun', 'SiliconFlow'] }
}

export function loadSecrets () { return readJson(KEY_STORE, { version: 1, providers: {} }) }

export function saveSecrets (j) {
  mkdirSync(dirname(KEY_STORE), { recursive: true })
  writeFileSync(KEY_STORE, JSON.stringify(j, null, 2), 'utf8')
  try {  // 尽力收紧权限（Windows：只留当前用户；失败不致命，但会警告）
    if (process.platform === 'win32') {
      execFileSync('icacls', [KEY_STORE, '/inheritance:r', '/grant:r', `${process.env.USERNAME}:F`], { stdio: 'ignore' })
    } else { chmodSync(KEY_STORE, 0o600) }
  } catch { console.warn('[钥匙] ⚠️ 没能收紧文件权限（不影响使用，但请确认这文件只有你能读）') }
}

/** 掩码：**只出后 4 位**（协议 P5 —— 日志/界面/看板都不许出现完整密钥）。 */
export function mask (k) {
  const s = String(k ?? '')
  if (s.length <= 4) return '••••'
  return '••••' + s.slice(-4)
}

/** 环境变量名：① 供应商声明的 apiKeyEnv（第一把）② `UNATTENDED_KEY_<供应商>_<序号>`。 */
export function envNames (provider, idx = 0, apiKeyEnv = null) {
  const up = String(provider).toUpperCase().replace(/[^A-Z0-9]/g, '_')
  const names = []
  if (idx === 0 && apiKeyEnv) names.push(apiKeyEnv)
  names.push(`UNATTENDED_KEY_${up}_${idx + 1}`)
  names.push(`UNATTENDED_KEY_${up}`)
  return names
}

/** ★ 项目**已有**的凭据库（`~\.dsh\.credentials.yaml`）—— 密钥解析的**第三层**。
 *  为什么要有这一层：本项目原来的 Key 就存在这里（`${CRED:NAME}` 机制）。
 *  **不重填 Key 也能用**（兼容既有部署），同时新填的 Key（第二层）优先于它。
 *  ⚠️ 这里**不 import `_agents-config.mjs`**（那会形成循环：它要 import 本模块的兄弟）。
 *     照同样的极简格式自己读一份即可。 */
export const CRED_FILE = process.env.DSH_CREDENTIALS || join(DSH_HOME, '.credentials.yaml')
let _credCache = null
export function credFromProjectFile (name) {
  if (_credCache === null) {
    _credCache = {}
    try {
      for (const line of readFileSync(CRED_FILE, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*["']?([^"'\r\n]+?)["']?\s*$/.exec(line)
        if (m) _credCache[m[1]] = m[2].trim()
      }
    } catch { /* 读不到就当空 */ }
  }
  return _credCache[name] ?? ''
}

/**
 * 解析某个供应商的第 idx 把钥匙。**三层顺序（协议 P5）**：
 *   ① 环境变量（供应商声明的 `apiKeyEnv` / `UNATTENDED_KEY_*`）
 *   ② 本机密钥库 `~\.dsh\unattended-keys.json`（新填的，**开源时导出用**）
 *   ③ **项目凭据库** `~\.dsh\.credentials.yaml`（本项目原有，兼容既有部署）
 * 返回 `{ key, source, label }` 或 `null`。
 */
/**
 * ★ 2026-10-10（用户实测："删了还在"）—— **屏蔽名单**。
 *
 * ## 为什么需要它
 * 钥匙解析是**三层**：① 环境变量 ② 本机密钥库 ③ 你原来的凭据库（`cred:`）。
 * 面板的「删」只能删**第②层**。删完第②层空了，`resolveKey` 就**回落到第③层**，
 * 于是那一行**又出现了**（用户看到的就是"删了还在"）——
 * 实测：`opencode-go` 密钥库已是 0 把，但解析到 `source=cred:OPENCODE_GO_API_KEY`。
 *
 * ⇒ 光删不够，必须能**明确表示"这家/这把我不用了"**，挡住下层回落。
 *    名单写在结构文件（`_crew\额度兜底.json`，**不含密钥、可进仓库**）的 `blocked` 段：
 *      `blocked: { "<供应商>": ["<标签>", ...] }`
 *
 * ## 只挡一层，不搞连坐
 * 只屏蔽**指定标签**。若这家还有别的层提供同一把（例如第①层环境变量），**照样会解析出来**
 * —— 因为环境变量是"外部注入"的，你在这台机器上删不掉它，硬屏蔽只会让人困惑。
 * 界面会**说清**挡住的是哪一层（`blockedFrom`）。
 */
export function loadBlocked () {
  const st = readJson(STRUCT_FILE, null)
  return (st && st.blocked && typeof st.blocked === 'object') ? st.blocked : {}
}
export function isBlocked (provider, label) {
  const b = loadBlocked()[provider]
  return Array.isArray(b) && b.indexOf(String(label)) !== -1
}
/** 候选标签（同一个槽位可能被叫不同的名字，见 `resolveKey` 的注释）。 */
export function labelCandidates (provider, idx = 0, struct = null) {
  const st = struct ?? loadStruct()
  const out = []
  const d = st.keys?.[provider]?.[idx]?.label
  if (d) out.push(String(d))
  const s = readJson(KEY_STORE, {}).providers?.[provider]?.[idx]?.label
  if (s) out.push(String(s))
  out.push('#' + (idx + 1))
  return [...new Set(out)]
}
/** 写屏蔽名单（`on=true` 加进去，`false` 移出来）。结构文件**先备份**。 */
export function setBlocked (provider, label, on) {
  const st = readJson(STRUCT_FILE, null)
  if (!st) return { ok: false, error: '读不到结构文件：' + STRUCT_FILE }
  st.blocked = (st.blocked && typeof st.blocked === 'object') ? st.blocked : {}
  const arr = Array.isArray(st.blocked[provider]) ? st.blocked[provider] : []
  const has = arr.indexOf(String(label)) !== -1
  if (on && !has) arr.push(String(label))
  if (!on && has) arr.splice(arr.indexOf(String(label)), 1)
  st.blocked[provider] = arr
  // 空数组就删掉那个键，别留噪音
  for (const k of Object.keys(st.blocked)) if (!st.blocked[k] || !st.blocked[k].length) delete st.blocked[k]
  try { writeFileSync(STRUCT_FILE + '.bak-blocked-' + Date.now(), readFileSync(STRUCT_FILE)) } catch {}
  writeFileSync(STRUCT_FILE, JSON.stringify(st, null, 2), 'utf8')
  return { ok: true, blocked: st.blocked }
}

/** 内层：原始三层解析（**不看屏蔽名单**）—— 供 `resolveKey` 调用与界面显示"下层还有没有"。 */
function resolveKeyRaw (provider, idx = 0, struct = loadStruct(), secrets = loadSecrets(), providers = discoverProviders()) {
  const label = struct.keys?.[provider]?.[idx]?.label ?? secrets.providers?.[provider]?.[idx]?.label ?? `#${idx + 1}`
  const names = envNames(provider, idx, providers[provider]?.apiKeyEnv)
  for (const n of names) if (process.env[n]) return { key: process.env[n], source: 'env:' + n, label }
  const k = secrets.providers?.[provider]?.[idx]?.key
  if (k) return { key: k, source: 'file', label: secrets.providers[provider][idx].label ?? label }
  for (const n of names) { const v = credFromProjectFile(n); if (v) return { key: v, source: 'cred:' + n, label } }
  return null
}

/**
 * 解析某家第 idx 把钥匙 —— **屏蔽名单优先**：这个槽位被屏蔽就一律返回 `null`
 * （这样"删了"才真的等于"不再使用"，不会被下层顶回来）。
 *
 * ⚠️ 为什么要判**多个候选标签**（2026-10-10 实测踩到）：
 *   删掉密钥库那条之后，`loadStruct().keys` 里**也没有**这条声明了 ⇒ `resolveKey` 算出的标签
 *   会从 `主号` 变成 `#1`。若只按 `主号` 记屏蔽，就**键对不上、屏蔽失效**（表现仍是"删了还在"）。
 *   ⇒ 同一槽位的所有叫法（声明的 label / 密钥库的 label / `#N`）**任一命中即屏蔽**。
 */
export function resolveKey (provider, idx = 0, struct = loadStruct(), secrets = loadSecrets(), providers = discoverProviders()) {
  const st = struct ?? loadStruct()
  if (labelCandidates(provider, idx, st).some((l) => isBlocked(provider, l))) return null
  return resolveKeyRaw(provider, idx, st, secrets, providers)
}

/**
 * 界面用：这把钥匙**为什么还在**。
 * 返回 `null` = 没被屏蔽；否则说明它被屏蔽了、以及下层是否仍有来源。
 */
export function blockedInfo (provider, idx = 0, struct = loadStruct(), secrets = loadSecrets(), providers = discoverProviders()) {
  const st = struct ?? loadStruct()
  const cands = labelCandidates(provider, idx, st)
  const hit = cands.find((l) => isBlocked(provider, l))
  if (!hit) return null
  const raw = resolveKeyRaw(provider, idx, st, secrets, providers)
  return { label: hit, candidates: cands, underlying: raw ? raw.source : null, key: raw ? raw.key : null }
}


// ---------------------------------------------------------------- CLI
const argv = process.argv.slice(2)
const cmd = argv[0]

function ensureStruct () {
  if (!existsSync(STRUCT_FILE)) {
    mkdirSync(dirname(STRUCT_FILE), { recursive: true })
    writeFileSync(STRUCT_FILE, JSON.stringify(loadStruct(), null, 2), 'utf8')
    console.log('[钥匙] 已生成结构文件（不含密钥）：' + STRUCT_FILE)
  }
}

function cmdProviders () {
  const p = discoverProviders()
  const names = Object.keys(p)
  if (!names.length) { console.log('（路由表/档案里都没发现供应商 —— 检查 `_coder路由表.json`）'); return }
  console.log('供应商（' + names.length + ' 家 · **名字以载体路由表 `_coder路由表.json` 为准**）：')
  for (const n of names) {
    const v = p[n]
    console.log('  ' + n.padEnd(14) + ' [' + (v.source === 'routing' ? '路由表' : '仅档案') + '] apiKeyEnv=' + (v.apiKeyEnv ?? '—').padEnd(32) +
      ' 模型 ' + String((v.models ?? []).length).padStart(2) + ' 个')
    console.log('  ' + ' '.repeat(14) + ' baseURL=' + (v.baseURL ?? '—（**没地址 → 无法探测**）'))
    if (v.alias?.length) console.log('  ' + ' '.repeat(14) + ' ↳ 档案里的另一种叫法：' + v.alias.join(', ') + '（靠 apiKeyEnv 自动配对）')
  }
}

function cmdList () {
  const struct = loadStruct(), secrets = loadSecrets(), prov = discoverProviders()
  const names = [...new Set([...Object.keys(prov), ...Object.keys(struct.keys ?? {}), ...Object.keys(secrets.providers ?? {})])].sort()
  console.log('供应商（' + names.length + ' 家）· 钥匙（只显示掩码）')
  for (const n of names) {
    const declared = (struct.keys?.[n] ?? []).slice().sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    const cnt = Math.max(declared.length, (secrets.providers?.[n] ?? []).length)
    console.log('  ── ' + n + (prov[n] ? '' : '  ⚠️（档案里没声明，只在密钥库/结构里有）'))
    if (!cnt) { console.log('        （还没配钥匙）'); continue }
    for (let i = 0; i < cnt; i++) {
      const r = resolveKey(n, i, struct, secrets, prov)
      console.log('       ' + String(i + 1).padStart(2) + '. ' + ((declared[i]?.label ?? secrets.providers?.[n]?.[i]?.label) ?? '#').padEnd(10) +
        '  ' + (r ? mask(r.key) : '（缺）').padEnd(10) + '  来源=' + (r ? r.source : '无') + '  优先级=' + (declared[i]?.priority ?? i + 1))
    }
  }
}

function cmdSet () {
  let [, provider, label, key] = argv
  if (!provider || !label || !key) { console.error('用法：额度钥匙.mjs set <供应商> <标签> <密钥|->　（用 `-` 表示从 stdin 读，**别把密钥放进命令行**）'); process.exit(2) }
  // ★ 密钥可以从 **stdin** 读（`set <供应商> <标签> -`）—— 面板/脚本都走这条，
  //   避免密钥出现在进程命令行里（`ps`/任务管理器能看到）。
  if (key === '-') {
    try { key = readFileSync(0, 'utf8').trim() } catch { key = '' }
    if (!key) { console.error('从 stdin 没读到密钥'); process.exit(2) }
  }
  const secrets = loadSecrets()
  secrets.providers = secrets.providers ?? {}
  secrets.providers[provider] = secrets.providers[provider] ?? []
  const at = secrets.providers[provider].findIndex(x => x.label === label)
  if (at >= 0) secrets.providers[provider][at].key = key; else secrets.providers[provider].push({ label, key })
  saveSecrets(secrets)
  // 同步结构文件里的"标签 + 优先级"（结构文件不含密钥，可以进仓库）
  ensureStruct()
  const struct = loadStruct()
  struct.keys = struct.keys ?? {}
  struct.keys[provider] = struct.keys[provider] ?? []
  if (!struct.keys[provider].some(x => x.label === label)) struct.keys[provider].push({ label, priority: struct.keys[provider].length + 1 })
  writeFileSync(STRUCT_FILE, JSON.stringify(struct, null, 2), 'utf8')
  // ★ 2026-10-12（b36 · 用户口径："我已经删了，就应该不存在了" + 回头路）：
  //   **重新添加同名钥匙 ＝ 这家回来了** ⇒ 顺手把「删」留下的屏蔽清掉。
  //   ⚠️ 必须清**这个槽位的全部候选标签**（`主号` / `#1` …）：`resolveKey` 的判据是
  //      "任一候选命中即挡"（见 `labelCandidates` 的注释）—— 只清一个的话新钥匙照样取不到，
  //      表现就是"我重新加了，它还说没钥匙"（这个坑我在这里一次清干净）。
  const idx = secrets.providers[provider].findIndex(x => x.label === label)
  const cl = unblockSlot(provider, idx)
  console.log('✅ 已保存：' + provider + ' / ' + label + ' = ' + mask(key) + '（密钥在 ' + KEY_STORE + '，不在仓库里）'
    + (cl.cleared.length ? '　·　顺手**解除了这家之前的屏蔽**（' + cl.cleared.join('、') + '）⇒ 它现在又能用了' : '')
    + (cl.error ? '　·　⚠️ 屏蔽没清掉：' + cl.error : ''))
}

/**
 * ★ 2026-10-12：清掉某个槽位的**全部**屏蔽标签（`set` 用它＝"重新添加就回来"）。
 * 返回 `{ cleared: [...], error? }`。
 */
function unblockSlot (provider, idx) {
  const before = loadBlocked()[provider] ?? []
  if (!before.length) return { cleared: [] }
  const cands = labelCandidates(provider, idx, loadStruct())      // 这个槽位的全部叫法（主号 / #1 …）
  const hit = cands.filter(l => before.includes(l))
  if (!hit.length) return { cleared: [] }
  for (const l of hit) {
    const r = setBlocked(provider, l, false)
    if (r.ok === false) return { cleared: hit, error: r.error }
  }
  return { cleared: hit }
}

function cmdRm () {
  const [, provider, label] = argv
  const secrets = loadSecrets()
  const arr = secrets.providers?.[provider] ?? []
  const before = arr.length
  secrets.providers[provider] = arr.filter(x => x.label !== label)
  saveSecrets(secrets)
  const struct = loadStruct()
  if (struct.keys?.[provider]) struct.keys[provider] = struct.keys[provider].filter(x => x.label !== label)
  writeFileSync(STRUCT_FILE, JSON.stringify(struct, null, 2), 'utf8')
  console.log((before === (secrets.providers[provider]?.length ?? 0) ? '（本来就没有）' : '✅ 已删除') + '：' + provider + ' / ' + label)
}

function cmdResolve () {
  const [, provider, idxRaw] = argv
  const r = resolveKey(provider, Number(idxRaw ?? 0) || 0)
  if (!r) { console.error('缺钥匙：' + provider + ' #' + (idxRaw ?? 1)); process.exit(3) }
  process.stdout.write(r.key)
}

function cmdWhere () {
  console.log('密钥库     : ' + KEY_STORE)
  console.log('结构文件   : ' + STRUCT_FILE + '（**不含密钥**，可以进仓库）')
  console.log('档案 patch : ' + (findProfilePatch() ?? '没找到'))
  const inside = pathResolve(KEY_STORE).toLowerCase().startsWith(pathResolve(WORKSPACE).toLowerCase())
  console.log('安全自检   : ' + (inside
    ? '❌ 密钥库在**工作台目录里**！开源前会被打包出去 —— 请改到用户目录（默认就是 ~\\.dsh）'
    : '✅ 密钥库在工作台目录之外（不在仓库里）'))
  console.log('存在吗     : ' + (existsSync(KEY_STORE) ? '是（' + statSync(KEY_STORE).size + ' 字节）' : '否（还没配过钥匙）'))
}

/** 调整某个供应商下钥匙的优先级（按传入的标签顺序重写 priority）。 */
function cmdPriority () {
  const [, provider, orderRaw] = argv
  if (!provider || !orderRaw) { console.error('用法：额度钥匙.mjs priority <供应商> <标签1,标签2,...>'); process.exit(2) }
  const order = String(orderRaw).split(',').map(s => s.trim()).filter(Boolean)
  const struct = loadStruct()
  const arr = struct.keys?.[provider] ?? []
  if (!arr.length) { console.error('该供应商还没有钥匙：' + provider); process.exit(2) }
  // 按 order 重排：order 里没提到的排在后面（保持原有相对顺序）
  const rank = new Map(order.map((l, i) => [l, i]))
  arr.sort((a, b) => (rank.get(a.label) ?? 999) - (rank.get(b.label) ?? 999))
  arr.forEach((x, i) => { x.priority = i + 1 })
  struct.keys[provider] = arr
  writeFileSync(STRUCT_FILE, JSON.stringify(struct, null, 2), 'utf8')
  console.log('✅ 优先级已更新：' + provider + ' → ' + arr.map(x => x.priority + '.' + x.label).join(' , '))
}

// ⚠️ **只有"直接跑本文件"时才执行命令行** —— 否则别的脚本 `import` 它（如 `额度检测.mjs`）
//    会把这段"用法帮助"当成输出混进对方的 stdout（踩过：检测结果里多出一段用法文字）。
const IS_MAIN = (() => {
  const entry = process.argv[1]
  if (!entry) return false
  try { return pathResolve(entry) === pathResolve(fileURLToPath(import.meta.url)) } catch { return false }
})()

if (IS_MAIN) switch (cmd) {
  case 'providers': cmdProviders(); break
  case 'list': cmdList(); break
  case 'set': cmdSet(); break
  case 'rm': cmdRm(); break
  case 'priority': cmdPriority(); break
  case 'resolve': cmdResolve(); break
  case 'where': cmdWhere(); break
  default:
    console.log('额度钥匙 —— 用法：')
    console.log('  node 额度钥匙.mjs providers | list | where')
    console.log('  node 额度钥匙.mjs set <供应商> <标签> <密钥>')
    console.log('  node 额度钥匙.mjs rm  <供应商> <标签>')
    console.log('  node 额度钥匙.mjs resolve <供应商> [序号]')
    console.log('协议见 KB `08-额度兜底与切换协议.md`（供应商不写死，全部动态发现）')
}