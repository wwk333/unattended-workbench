#!/usr/bin/env node
/**
 * 工量账本（crew ledger）—— 无人值守模式 · 第 1 步
 *
 * 干什么：把**每一次班组（Qoder CLI）调用**的可测事实落盘成 `_crew\ledger.json`。
 *         这是我们自己的账，不依赖任何外部接口 —— 所以额度读不到时它能顶上（方案 §6.2）。
 *
 * 记录的字段（全部来自 `-p -o json` 信封或我们的调用参数）：
 *   角色 / 模型 / 调用次数 / 时长 duration_ms / 轮次 num_turns /
 *   上下文占用 context_usage_ratio / 成败 is_error·stop_reason /
 *   permission_denials 条数 / session_id
 *
 * 子命令：
 *   add        追加一条调用记录（参数见下）；带 `--envelope` 时**同一份信封只记一次**，要重复记加 `--force`
 *   stats      汇总（今日调用次数、按角色、按模型、成败、坑数）
 *   list       最近 N 条
 *   init       建账本（已存在则不动）
 *
 * 用法示例：
 *   node 工量账本.mjs add --role coder-a --model DeepSeek-V4-Flash --ok true \
 *        --duration-ms 11300 --num-turns 3 --context-usage 0.166 --denials 0 \
 *        --session-id abc --task "T12 登录模块" --envelope out.json
 *
 *   node 工量账本.mjs stats
 */

import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// ★ 2026-10-03：**复用唯一那份解析器**。原来这里自己 JSON.parse 整段 —— 那只认单信封，
//   于是 Pi / OpenCode 的 JSONL 事件流读不出任何字段（账本里 usage 恒 null、ok 恒 null），
//   外部用量快照的 token 也就永远是 0。违反"只写一份解析器"这条纪律，代价是账目失真。
import { parseCarrierOutput } from './_agents-config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, '..')
const LEDGER = resolve(WORKSPACE, process.env.DSH_LEDGER ?? '_crew/ledger.json')
/** ★ b193（M6-7）：速度量具的结果落这里，**看板只读它**（看板不能自己去递归扫 68 个 runs 目录）。
 *  过期判定交给读方：同一个 `at` 字段就是时点。 */
const SPEED_CACHE = resolve(WORKSPACE, process.env.DSH_SPEED_CACHE ?? '_crew/速度量具.json')
const SCHEMA = 1

// ---------------------------------------------------------------- 读写

function load () {
  if (!existsSync(LEDGER)) {
    return { schema: SCHEMA, createdAt: new Date().toISOString(), calls: [], pitfalls: [], notes: [] }
  }
  try {
    const j = JSON.parse(readFileSync(LEDGER, 'utf8'))
    j.calls ??= []
    j.pitfalls ??= []
    j.notes ??= []
    return j
  } catch (e) {
    // 账本坏了不能静默重置 —— 那会丢账。改成"另存坏账 + 重新开始"，并留下证据。
    const bad = LEDGER.replace(/\.json$/, `-corrupt-${Date.now()}.json`)
    renameSync(LEDGER, bad)
    return { schema: SCHEMA, createdAt: new Date().toISOString(), calls: [], pitfalls: [], notes: [],
             recoveredFrom: bad, recoveredReason: String(e?.message ?? e) }
  }
}

function save (j) {
  if (!existsSync(dirname(LEDGER))) mkdirSync(dirname(LEDGER), { recursive: true })
  j.updatedAt = new Date().toISOString()
  // 原子写：先写临时文件再换名，避免读到写了一半的账本
  const tmp = LEDGER + '.tmp'
  writeFileSync(tmp, JSON.stringify(j, null, 2), 'utf8')
  renameSync(tmp, LEDGER)
}

// ---------------------------------------------------------------- 参数

const argv = process.argv.slice(2)
const cmd = argv[0] ?? 'stats'
function opt (name, dflt = undefined) {
  const i = argv.indexOf('--' + name)
  return i >= 0 ? argv[i + 1] : dflt
}
function num (name) {
  const v = opt(name)
  if (v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}
function bool (name) {
  const v = opt(name)
  if (v === undefined) return null
  return v === true || v === 'true' || v === '1' || v === 'yes'
}

/**
 * 布尔开关，**裸 `--flag`（后面不跟值）也认**。
 *
 * ⚠️ 不能直接用 `bool()`：`opt()` 取的是"名字后面那个值"，所以裸 `--force` 放在结尾、或后面紧跟
 *    另一个 `--xxx` 时，取到的是 undefined / `--xxx` → 开关**静默失效**（想覆盖却覆盖不了，最难查）。
 *    这里退回"看 argv 里有没有这个名字"。显式写 `--force false` 仍算**关**（免得想关却关不掉）。
 */
function flag (name) {
  const v = opt(name)
  if (v === true || v === 'true' || v === '1' || v === 'yes') return true
  if (v === 'false' || v === '0' || v === 'no') return false
  return argv.includes('--' + name)
}

/**
 * 去重键：**规范化后的 envelope 路径**。
 *
 * 为什么它能当唯一键（已核对现场）：编排里"每次尝试各写一份 `<cardId>.out.json`"，
 *   `cardId = opts.attempt ? \`${t.id}-${opts.attempt}\` : t.id` —— 实测文件名：
 *   首次 `T5.out.json` / 重试 `T5-retry.out.json` / 急救 `T5-rescue.out.json`（同趟同任务三份并存），
 *   审核 `review\REVIEW-<stamp>.out.json`（一趟一份）。**不同的真调天然是不同路径** →
 *   用路径去重不会把两次尝试记成一次。
 *
 * 规范化：`resolve()` 抹平相对路径与 `..`（账本里存的是绝对路径）；
 *   Windows 文件系统**大小写不敏感** → 在 win32 上一并折成小写，免得同一文件两种写法算成两份。
 */
function envelopeKey (p) {
  if (!p) return null
  const k = resolve(String(p))
  return process.platform === 'win32' ? k.toLowerCase() : k
}

function todayKey (d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 读 JSON 文件，**自动识别编码**。
 *
 * ⚠️ 实测踩过（2026-10-01）：PowerShell 5.1 的 `1> out.json` 重定向**默认写 UTF-16LE（带 BOM）**，
 *    于是 Qoder 的信封文件里每个字符之间夹一个 `0x00` 字节，`JSON.parse` 直接报
 *    `Unexpected token`。而方案 §5.5 又要求"输出绝不接管道，一律 `1> 文件`" ——
 *    正好会撞上。所以这里必须自己认编码，不能假设 UTF-8。
 */
function readTextAuto (path) {
  const b = readFileSync(path)
  let text
  if (b.length >= 2 && b[0] === 0xFF && b[1] === 0xFE) text = b.subarray(2).toString('utf16le')
  else if (b.length >= 2 && b[0] === 0xFE && b[1] === 0xFF) {
    // UTF-16BE：手动换字节序再按 UTF-16LE 解
    const swapped = Buffer.from(b.subarray(2))
    if (swapped.length % 2) swapped.subarray(0, swapped.length - 1)
    swapped.swap16()
    text = swapped.toString('utf16le')
  } else {
    text = b.toString('utf8')
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1)     // UTF-8 BOM
  }
  return text
}

function readJsonAuto (path) { return JSON.parse(readTextAuto(path)) }

/** 把解析器的 usage（各族形状不同）**归一**成账本/快照用的那套字段名。
 *
 * ★★ 2026-10-06 修（三方交叉验证共同指出，我也实测坐实）：**原来只认 camelCase** ——
 *   而 CodeBuddy 与 Qoder 的信封给的是 **snake_case**（`input_tokens` / `output_tokens` / …；
 *   本项目自己的解析器用例 `_解析器自检.mjs` 第 ①③⑦ 条就写着 `{"input_tokens":10}`）。
 *   后果（实测真账本 64 条）：`reviewer` **5 次调用全记 0 token**、`rescue` **3 次全记 0**，
 *   而 0 还被当成真值写进"外部用量快照"与看板 —— 三/五个角色的消耗列**一直是假的**。
 *   现在：**两套命名都认**（snake_case 与 camelCase），并且 `totalTokens` 缺了就**用分项相加兜底**
 *   （有 input/output 却 total=null 的，同样会让看板显示 0）。
 */
function mapUsage (u) {
  if (!u || typeof u !== 'object') return null
  // 归一化键名：驼峰 ↔ 下划线，让下面只需列一套
  const norm = {}
  for (const [k, v] of Object.entries(u)) {
    if (typeof v !== 'number') continue
    const camel = k.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
    if (norm[camel] === undefined) norm[camel] = v
  }
  const pick = (...names) => { for (const n of names) if (typeof norm[n] === 'number') return norm[n]; return null }
  // ★ 五·S6（2026-10-09）：pick 只吃**顶层数字键**，而有些信封把命中放在 usage.prompt_tokens_details
  //   （**对象**）里 —— 上面的 norm 会把它整个跳过 ⇒ 这里补一层**嵌套兜底**。
  //   null＝信封没给这个字段；0＝真没命中 —— 两者绝不许互换（取不到就 null，**不许记 0**）。
  const det = (u.prompt_tokens_details && typeof u.prompt_tokens_details === 'object') ? u.prompt_tokens_details
    : (u.promptTokensDetails && typeof u.promptTokensDetails === 'object' ? u.promptTokensDetails : null)
  const fromDet = (...names) => { if (!det) return null; for (const n of names) if (typeof det[n] === 'number') return det[n]; return null }
  const input = pick('inputTokens', 'input', 'promptTokens', 'prompt')
  const output = pick('outputTokens', 'output', 'completionTokens', 'completion')
  const cacheRead = pick('cacheReadInputTokens', 'cacheRead', 'cached', 'cacheReadTokens')
    ?? fromDet('cached_tokens', 'cachedTokens', 'cache_read_tokens')
  const cacheWrite = pick('cacheCreationInputTokens', 'cacheWrite', 'cacheWriteTokens')
    ?? fromDet('cache_creation_tokens', 'cacheCreationTokens', 'cache_write_tokens')
  const reasoning = pick('reasoningTokens', 'reasoning')
  const out = {
    inputTokens: input,
    outputTokens: output,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
    reasoningTokens: reasoning,
    // totalTokens：优先信信封自己的；没有就**按分项相加**（缓存读也算进去，与解析器口径一致）
    totalTokens: pick('totalTokens', 'total')
      ?? ((input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0) + (reasoning ?? 0) || null),
    contextUsageRatio: pick('contextUsageRatio', 'context_usage_ratio')
  }
  // 全是 null 就当没有（别往账本里塞一个空壳对象）
  return Object.values(out).some(v => v !== null) ? out : null
}

/**
 * ★ 2026-10-19（b193 · M6-7「速度量具」）：**秒/回合** 与它的**口径名**。
 *
 * 为什么必须连口径名一起记（M6-7 第 3 条）：六家载体的"回合"**数的不是同一件事** ——
 *   Pi 数 `turn_start`、OpenCode 数 `step_start`、Claude 系 CLI 只有自报 `num_turns`（**＝消息条数**）。
 *   不把口径名写进账本 ⇒ 半年后没人知道这一列在数什么，又会拿三个不同的分母横着比（§3.6 就是这么错的）。
 * 口径：`den` 的优先级 = `turn_start` > `step_start` > `num_turns`（**按信封内容判，不按角色名猜**）。
 */
function countTurns (raw) {
  const n = (re) => (String(raw).match(re) || []).length
  const turnStart = n(/"type"\s*:\s*"turn_start"/g)
  const stepStart = n(/"type"\s*:\s*"step_start"/g)
  const numTurns = (() => { const m = /"num_turns"\s*:\s*(\d+)/.exec(String(raw)); return m ? +m[1] : null })()
  const kind = turnStart > 0 ? 'Pi:turn_start' : stepStart > 0 ? 'OpenCode:step_start' : numTurns ? 'ClaudeCLI:num_turns(=消息条数)' : null
  const den = turnStart > 0 ? turnStart : stepStart > 0 ? stepStart : numTurns
  return { turnsKind: kind, turnsDen: den ?? null, turnStart, stepStart, numTurns }
}

/** 从载体输出文件里补字段 —— ★ 复用**唯一那份**解析器（单信封 / JSON 数组 / JSONL 都认）。
 * ⚠️ 实测（2026-10-03）：原来自己 `JSON.parse` 整段 → Pi/OpenCode 的 JSONL 一律读不出，
 *    于是账本记成 `ok=null`、usage 全空，外部用量快照的 token 恒为 0。
 */
function readEnvelope (path) {
  if (!path || !existsSync(path)) return null
  try {
    const raw = readTextAuto(path)
    const errPath = path.replace(/\.out\.json$/i, '.err.txt')
    const env = parseCarrierOutput(raw, existsSync(errPath) ? readFileSync(errPath, 'utf8') : '')
    const t = countTurns(raw)                       // ★ b193：秒/回合 的分母（带口径名）
    return {
      isError: env.isError,
      subtype: env.stopReason ?? null,
      stopReason: env.stopReason ?? null,
      // ★ A（2026-10-10）：这里原来**硬编码 `numTurns: null`** —— 解析器就算取到了回合数，
      //   过这一关也被丢掉（当时解析器也没取，所以两头都断，谁都没发现）。
      //   现在两头都接上：解析器给 `env.numTurns`，这里透传；取不到仍是 null（不编 0）。
      numTurns: env.numTurns ?? t.numTurns ?? null,
      turnsKind: t.turnsKind,
      turnsDen: t.turnsDen,
      contextUsageRatio: env.usage?.context_usage_ratio ?? env.usage?.contextUsageRatio ?? null,
      denials: Array.isArray(env.permissionDenials) ? env.permissionDenials.length : 0,
      sessionId: env.sessionId ?? null,
      model: env.model ?? null,
      totalCredits: env.credits ?? null,
      totalCostUsd: env.credits ?? null,
      toolCalls: env.toolCalls ?? 0,
      envelopeKind: env.kind,
      usage: mapUsage(env.usage)
    }
  } catch { return null }
}

// ---------------------------------------------------------------- 子命令

function cmdInit () {
  const j = load()
  save(j)
  console.log(`[账本] 已就绪：${LEDGER}`)
  console.log(`[账本] 现有调用 ${j.calls.length} 条，坑 ${j.pitfalls.length} 条`)
}

function cmdAdd () {
  const j = load()
  const envelopeArg = opt('envelope')
  const key = envelopeKey(envelopeArg)
  // ★ 2026-10-03 补：**同一份信封只记一次**（唯一键 = 规范化后的 envelope 路径）。
  //   为什么需要：信封文件是"一次真调"的凭据，而同一份凭据被 add 两次就会把**一次真调记成多次**
  //   （重复记账：同一趟被记两遍 / 手工补记时又记一遍）→ 次数与额度口径虚高。
  //   `--force` 是出口："我确实知道自己在重复记这一份"。
  //   ⚠️ 边界（有意为之）：**没有 envelope 的调用不去重** —— `--ok/--duration-ms` 那条退化路径
  //      没有稳定唯一键，若强行按 role+task 去重，会把"同一任务的多趟真调"合并成一条 = **少记**，
  //      比重复记更糟（账目宁可多一条可疑，不可少一条真调）。
  if (key && !flag('force')) {
    const dup = j.calls.find(c => envelopeKey(c.envelope) === key)
    if (dup) {
      console.log(`[账本] already recorded：这份信封已经记过账了（${dup.at} ${dup.role} / ${dup.task ?? '?'}），跳过`)
      console.log(`[账本] 累计 ${j.calls.length} 次调用，坑 ${j.pitfalls.length} 条`)
      console.log('[账本] 确实要再记一条（例如手工补记）：加 --force')
      return
    }
  }
  const env = readEnvelope(envelopeArg)
  const record = {
    at: new Date().toISOString(),
    date: todayKey(),
    role: opt('role', 'unknown'),
    model: opt('model', env?.model ?? null),
    // ⚠️ 档位（high / max …）必须记 —— 不记就无法按档位归因，实验做不了。
    //    （起因：原先只记 role/model/credits，记不了档位 ⇒ 做不了"按档位归因"的实验。）
    effort: opt('effort', env?.effort ?? null),
    // ★ 2026-10-16（任务分级 L1–L4）：台账里记**级号** —— 用户口径"账本/看板要能看见这次是哪一级"
    //   （防"看板显示 max、实际跑 L1"这种静默过期）。`--level` 优先；没给就从**派活收据**里现读
    //   （`<task>.dispatch.json` 的 `level`）—— 读不到＝null（**不编**）。
    level: opt('level', null) ?? (() => {
      // 口径：① `--level` 显式给的优先；② 否则从**派活收据**现读（`<项目>\_crew\tasks\<task>.dispatch.json`，
      //   找不到再扫最近 3 轮 `runs\<戳>\{tasks,review}\<task>.dispatch.json`）；③ 都没有＝null（**不编**）。
      try {
        const t = String(opt('task', null) ?? '').replace(/[\\/]/g, '').trim()
        if (!t) return null
        // 项目根：`--project` 优先（手工跑卡时收据在**项目**的 `_crew\tasks` 下，不在工作台里 ——
        //   实测踩过：不带 --project 时这条查找恒落空 ⇒ 级号记成 null）。缺省仍是工作台（编排/看板那条路）。
        const proj = opt('project', null)
        const roots = [proj ? join(resolve(proj), '_crew', 'tasks') : null, join(WORKSPACE, '_crew', 'tasks')].filter(Boolean)
        try {
          const runs = join(proj ? resolve(proj) : WORKSPACE, '_crew', 'runs')
          for (const s of readdirSync(runs, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort().slice(-3)) {
            roots.push(join(runs, s, 'tasks'), join(runs, s, 'review'))
          }
        } catch { /* 没有 runs 目录就只找直接那份 */ }
        for (const d of roots) {
          const p = join(d, t + '.dispatch.json')
          if (!existsSync(p)) continue
          const j2 = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
          if (j2?.level) return j2.level
        }
      } catch { /* 读不到就不记（不猜） */ }
      return null
    })(),
    task: opt('task', null),
    ok: bool('ok') ?? (env?.isError === null || env?.isError === undefined ? null : !env.isError),
    durationMs: num('duration-ms') ?? env?.durationMs ?? null,
    numTurns: num('num-turns') ?? env?.numTurns ?? null,
    // ★ b193（M6-7）：**秒/回合**及其口径名。两个都算不出来就都留 null（**不编**）。
    turnsKind: env?.turnsKind ?? null,
    turnsDen: env?.turnsDen ?? null,
    secPerTurn: (() => {
      const ms = num('duration-ms') ?? env?.durationMs ?? null
      const d = env?.turnsDen ?? null
      return ms && d ? +(ms / 1000 / d).toFixed(2) : null
    })(),
    contextUsageRatio: num('context-usage') ?? env?.contextUsageRatio ?? null,
    denials: num('denials') ?? env?.denials ?? null,
    credits: num('credits') ?? env?.totalCredits ?? null,
    durationApiMs: env?.durationApiMs ?? null,
    usage: env?.usage ?? null,
    isError: env?.isError ?? null,
    subtype: env?.subtype ?? null,
    stopReason: env?.stopReason ?? null,
    sessionId: opt('session-id', env?.sessionId ?? null),
    retryOf: opt('retry-of', null),
    switchFrom: opt('switch-from', null),
    // ★ 2026-10-24（施工文档 §8-5）：对账与返工 —— 各自 null 就是"没发生"，不许编。
    //   reconcile：real-fail / derelict / conflict / misreport / unknown（判序见 `_诊断.mjs`）
    //   acFingerprint：命令+脚本内容哈希；**验收被改过 ⇒ 变**（重派的卡据此判"不算过"）
    //   reworkCount：这是第几轮返工（0/1/2，见 §5.3 四步链）
    reconcile: opt('reconcile', null),
    acFingerprint: opt('ac-fingerprint', env?.acFingerprint ?? null),
    reworkCount: num('rework-count'),
    // ★ 2026-10-23（施工文档 D14）：**上下文占用**三兄弟 —— 分子/分母/百分比，**各自为 null 就是不编数**。
    //   口径：`promptTokens` = 未缓存 input + 缓存读 + 缓存写（不含输出）；`ctxWindow` 来自 `_crew\模型能力.json`。
    promptTokens: num('prompt-tokens'),
    ctxWindow: num('ctx-window'),
    ctxPct: num('ctx-pct'),
    ctxBasis: opt('ctx-basis', null),
    // ★ 2026-10-23（施工文档 D3）：撞顶标记（以后能统计"哪些模型容易想爆"）
    thinkingOverflow: bool('thinking-overflow') ?? null,
    note: opt('note', null),
    envelope: opt('envelope', null)
  }
  if (bool('pitfall')) {
    record.pitfall = true
    j.pitfalls.push({ at: record.at, date: record.date, role: record.role, task: record.task, note: record.note })
  }
  j.calls.push(record)
  save(j)
  console.log(`[账本] +1 调用：${record.role} / ${record.model ?? '?'} / ${record.ok === true ? '成功' : record.ok === false ? '失败' : '未知'} / ${record.durationMs ?? '?'}ms`)
  console.log(`[账本] 累计 ${j.calls.length} 次调用，坑 ${j.pitfalls.length} 条`)
  refreshExternalUsage()
}

/**
 * 收活后顺手刷新**外部用量快照**（喂 cost-meter；只写非 DSH 载体）。
 *
 * 为什么挂在记账这一处：账本是"每次调用"的唯一落点，挂这里就不会漏（挂编排里会漏掉重试/手工调用）。
 * ★ **非致命**：快照写失败绝不能影响账本 —— 账本才是唯一真账（口径见 02-产物与规格.md §2.6）。
 */
function refreshExternalUsage () {
  const script = join(HERE, '外部用量快照.mjs')
  if (!existsSync(script)) return
  try {
    const r = spawnSync(process.execPath, [script, '--write'], { encoding: 'utf8', maxBuffer: 8 << 20, timeout: 30_000, windowsHide: true })
    if (r.status === 0) console.log('[账本] 外部用量快照已刷新（非 DSH 载体 → cost-meter）')
    // exit=3 = 子进程"有意跳过"（本账里还没有非 DSH 调用）。**不能当成成功** —— 那只会有个假信号。
    else if (r.status === 3) console.log('[账本] 外部用量快照：本账还没有非 DSH 调用，跳过（未写文件）')
    // ★ 2026-10-07：exit=4 = 子进程**死保护生效**（账本隔离了、落点没隔离 ⇒ 拒绝污染真库）。
    //   这不是错误，是"演练时**故意**没写" —— 所以给一句人看得懂的话，别只丢个 exit 码。
    else if (r.status === 4) console.log('[账本] 外部用量快照：**已按死保护跳过**（账本隔离了但落点没隔离，拒绝污染 cost-meter 真库；演练请同时设 DSH_EXTERNAL_USAGE）')
    else console.log(`[账本] ⚠️ 外部用量快照未刷新（exit=${r.status}）：${String(r.stderr ?? '').trim().slice(-200)}`)
  } catch (e) {
    console.log(`[账本] ⚠️ 外部用量快照未刷新：${String(e?.message ?? e)}`)
  }
}

function cmdStats () {
  const j = load()
  const t = todayKey()
  const calls = j.calls
  const today = calls.filter(c => c.date === t)
  const by = (key) => {
    const m = new Map()
    for (const c of calls) {
      const k = c[key] ?? '(未知)'
      const s = m.get(k) ?? { n: 0, ok: 0, fail: 0, ms: 0, turns: 0, ctxMax: 0, denials: 0 }
      s.n++
      if (c.ok === true) s.ok++
      if (c.ok === false) s.fail++
      s.ms += Number(c.durationMs) || 0
      s.turns += Number(c.numTurns) || 0
      s.ctxMax = Math.max(s.ctxMax, Number(c.contextUsageRatio) || 0)
      s.denials += Number(c.denials) || 0
      m.set(k, s)
    }
    return Object.fromEntries([...m.entries()].sort((a, b) => b[1].n - a[1].n))
  }
  const out = {
    ledger: LEDGER,
    schema: j.schema ?? SCHEMA,
    totalCalls: calls.length,
    todayCalls: today.length,
    todayPitfalls: j.pitfalls.filter(p => p.date === t).length,
    totalPitfalls: j.pitfalls.length,
    todayOk: today.filter(c => c.ok === true).length,
    todayFail: today.filter(c => c.ok === false).length,
    todayDenials: today.reduce((a, c) => a + (Number(c.denials) || 0), 0),
    todayMs: today.reduce((a, c) => a + (Number(c.durationMs) || 0), 0),
    lastCallAt: calls.length ? calls[calls.length - 1].at : null,
    byRole: by('role'),
    byModel: by('model'),
    updatedAt: j.updatedAt ?? null,
    recoveredFrom: j.recoveredFrom ?? null
  }
  if (cmd === 'stats') {
    process.stdout.write(JSON.stringify(out, null, 2) + '\n')
  }
  return out
}

function cmdList () {
  const j = load()
  const n = num('n') ?? 10
  const rows = j.calls.slice(-n)
  if (rows.length === 0) { console.log('（账本里还没有调用记录）'); return }
  for (const c of rows) {
    console.log(`${c.at}  ${String(c.role).padEnd(10)} ${String(c.level ?? '—').padEnd(4)} ${String(c.model ?? '?').padEnd(20)} ${c.ok === true ? '✓' : c.ok === false ? '✗' : '?'}  ${String(c.durationMs ?? '?').padStart(7)}ms  turns=${c.numTurns ?? '?'}  ctx=${c.contextUsageRatio ?? '?'}  denials=${c.denials ?? '?'}  ${c.task ?? ''}`)
  }
}

/**
 * speed —— ★ b193（M6-7「速度量具」）：**四个数一次算完**。纯计算、零 token、**只读不写**。
 *
 *   ① **秒/回合**（按"模型 ｜ 分母口径"分组 —— **跨家不可比**，所以不给"全体中位"当结论）
 *   ② **本波墙钟**   ③ **收活 → 下一波派活的空档**   ④ **实际并行度**（Σ单卡耗时 ÷ 墙钟）
 *
 * 波次口径（写死在这里，别处不许再定义一套）：
 *   **一个波次 = 一个 `runs\<戳>` 目录**；墙钟取该目录内文件 mtime 的**最早 → 最晚**；
 *   空档 = 相邻两波"上一波最晚 → 下一波最早"的差；并行度 = 该波账本行的 `durationMs` 之和 ÷ 墙钟。
 *   ⚠️ 秒/回合 与 墙钟/空档/并行度 是**两套不同的分母**（前者按家分，后者按波次），别混着解释。
 */
function cmdSpeed () {
  const j = load()
  const rows = j.calls
  const t0 = Date.now()

  // ---- ① 秒/回合
  const per = []
  for (const r of rows) {
    if (!(Number(r.durationMs) > 0)) continue
    let kind = r.turnsKind ?? null
    let den = r.turnsDen ?? null
    let sec = r.secPerTurn ?? null
    if ((!kind || !den) && r.envelope && existsSync(r.envelope)) {
      try {
        const t = countTurns(readTextAuto(r.envelope))
        kind = kind ?? t.turnsKind
        den = den ?? t.turnsDen
      } catch { /* 信封没了就留 null */ }
    }
    if (sec == null && den) sec = +(r.durationMs / 1000 / den).toFixed(2)
    per.push({ role: r.role, model: r.model ?? '(空)', task: r.task ?? '', at: r.at, kind, den, sec })
  }
  const groups = {}
  for (const r of per) { if (r.sec == null) continue; const k = `${r.model} ｜ ${r.kind}`; (groups[k] ||= []).push(r.sec) }
  const med = (a) => { const b = [...a].sort((x, y) => x - y); const m = b.length >> 1; return b.length % 2 ? b[m] : +((b[m - 1] + b[m]) / 2).toFixed(2) }
  const secGroups = Object.entries(groups).map(([k, v]) => ({ group: k, n: v.length, median: med(v), min: Math.min(...v), max: Math.max(...v) })).sort((a, b) => b.n - a.n)

  // ---- ②③④ 波次
  const waves = new Map()
  const projOfRun = (p) => { const m = /^(.*?)[\\/]_crew[\\/]runs[\\/]([^\\/]+)/.exec(String(p ?? '')); return m ? { root: m[1], stamp: m[2] } : null }
  /** 波次的**权威来源 ＝ `<项目>\_crew\runs\<戳>` 目录**（M6-7："空档/墙钟直接读现有文件时间戳"）。
   *  ⚠️ 从账本行反推会**少波次**（没有调用记录的波次就消失）—— b193 第一版这么算得 38 波，实际 64 波。
   *  项目根从账本信封路径里提取；`--project <dir>` 可指定只看一个。 */
  const projRoots = new Set()
  if (opt('project')) projRoots.add(resolve(opt('project')))
  for (const r of rows) { const m = projOfRun(r.envelope); if (m) projRoots.add(m.root) }
  for (const root of projRoots) {
    const runsDir = join(root, '_crew', 'runs')
    if (!existsSync(runsDir)) continue
    for (const e of readdirSync(runsDir, { withFileTypes: true })) {
      if (!e.isDirectory()) continue
      waves.set(root + '|' + e.name, { project: root, stamp: e.name, dir: join(runsDir, e.name), rows: [] })
    }
  }
  // 把账本行挂回波次（按 项目 + 戳）
  for (const r of rows) {
    const m = projOfRun(r.envelope)
    if (!m) continue
    const W = waves.get(m.root + '|' + m.stamp)
    if (W) W.rows.push(r)
  }
  /** 递归取一个目录里所有文件的 mtime（runs\<戳>\ 下面只有 tasks/ 与 review/ 两个子目录 —— 
   *  ⚠️ 只 `isFile()` 过滤会把整个波次判成"没有文件 ⇒ 没有墙钟"，b193 第一版就踩了这个坑）
   *  ⚠️⚠️ 更狠的一个坑（同轮踩到）：**空 `catch {}` 会把 `ReferenceError` 一起吞掉** ——
   *     当时 `statSync` 忘了 import，于是每个波次都"没有文件"，而输出上只看到"0 个波次"，看不出是代码错。
   *     ⇒ 这里改成**把异常计数带出来**（`scanErrors`），有错就打印。 */
  let scanErrors = 0
  function fileMtimes (dir, depth = 0, acc = []) {
    if (depth > 3) return acc
    let ents = []
    try { ents = readdirSync(dir, { withFileTypes: true }) } catch { return acc }
    for (const e of ents) {
      const p = join(dir, e.name)
      if (e.isDirectory()) fileMtimes(p, depth + 1, acc)
      else { try { acc.push(statSync(p).mtimeMs) } catch (err) { scanErrors++; if (scanErrors === 1) console.error('[账本] ⚠️ 取文件时间戳失败（第一个）：' + err.message) } }
    }
    return acc
  }
  for (const W of waves.values()) {
    const ms = fileMtimes(W.dir)
    if (ms.length) { W.firstMs = Math.min(...ms); W.lastMs = Math.max(...ms) }
    const cardMs = W.rows.reduce((a, r) => a + (Number(r.durationMs) || 0), 0)
    // 兜底口径：用账本行的 [at − durationMs, at] 区间（信封没了时还能算）
    const iv = W.rows.filter(r => Number(r.durationMs) > 0).map(r => [Date.parse(r.at) - r.durationMs, Date.parse(r.at)])
    const rowFirst = iv.length ? Math.min(...iv.map(x => x[0])) : null
    const rowLast = iv.length ? Math.max(...iv.map(x => x[1])) : null
    W.cardCount = W.rows.length
    W.cardMs = cardMs
    W.wallMsByDir = W.firstMs && W.lastMs ? W.lastMs - W.firstMs : null
    W.wallMsByRows = rowFirst && rowLast ? rowLast - rowFirst : null
    // 口径 B：目录名里的"开始戳" → 目录里最晚文件（b191 说的"批次目录时间戳窗口"更像这一种）
    const byName = Date.parse(W.stamp.replace('T', ' ').replace(/(\d{2})-(\d{2})-(\d{2})$/, '$1:$2:$3'))
    W.wallMsByName = Number.isFinite(byName) && W.lastMs ? W.lastMs - byName : null
    W.parallelismByDir = W.wallMsByDir ? +(cardMs / W.wallMsByDir).toFixed(3) : null
    W.parallelismByRows = W.wallMsByRows ? +(cardMs / W.wallMsByRows).toFixed(3) : null
    W.parallelismByName = W.wallMsByName ? +(cardMs / W.wallMsByName).toFixed(3) : null
  }
  const list = [...waves.values()].filter(w => w.firstMs).sort((a, b) => a.firstMs - b.firstMs)
  const gaps = []
  for (let i = 1; i < list.length; i++) {
    const g = list[i].firstMs - list[i - 1].lastMs
    gaps.push({ from: list[i - 1].stamp, to: list[i].stamp, gapMs: g, gapMin: +(g / 60000).toFixed(1) })
  }
  const h = (ms) => +(ms / 3600000).toFixed(2)
  const wall = list.map(w => w.wallMsByDir).filter(x => x != null)
  /** 三种墙钟口径各算一遍（b191 的 22.92h 是拿"批次目录时间戳窗口"算的 —— 这里三种都摆出来对账） */
  const sum = (arr) => +(arr.reduce((a, x) => a + (x ?? 0), 0) / 3600000).toFixed(3)
  const gapsOf = (key, useFirst) => {
    const seq = list.filter(w => w[key] != null).sort((a, b) => a[useFirst] - b[useFirst])
    const out2 = []
    for (let i = 1; i < seq.length; i++) {
      const prevEnd = useFirst === 'firstMs' ? seq[i - 1].firstMs + seq[i - 1][key] : seq[i - 1].lastMs
      const curStart = seq[i][useFirst]
      out2.push(+(curStart - prevEnd) / 60000)
    }
    return out2
  }
  const out = {
    at: new Date().toISOString(), ledger: LEDGER, calls: rows.length,
    wavesDebug: { 波次总数: waves.size, 有文件时间戳的: list.length, 前三个: [...waves.values()].slice(0, 3).map(w => ({ stamp: w.stamp, dir: w.dir, firstMs: w.firstMs ?? null, rows: w.rows.length })) },
    secPerTurn: { computed: per.filter(p => p.sec != null).length, canNot: per.filter(p => p.sec == null).length, groups: secGroups },
    waves: {
      count: list.length,
      windowFrom: list.length ? new Date(list[0].firstMs).toISOString() : null,
      windowTo: list.length ? new Date(list[list.length - 1].lastMs).toISOString() : null,
      sumWallHours: {
        '按目录内文件最早→最晚': sum(list.map(w => w.wallMsByDir)),
        '按目录名开始戳→最晚文件': sum(list.map(w => w.wallMsByName)),
        '按账本卡片区间': sum(list.map(w => w.wallMsByRows)),
      },
      gaps: {
        '按文件时间': (() => { const g = gapsOf('wallMsByDir', 'firstMs'); return { segments: g.length, sumHours: +(g.reduce((a, x) => a + x, 0) / 60).toFixed(2), over24h: g.filter(x => x > 1440).length, over24hHours: +(g.filter(x => x > 1440).reduce((a, x) => a + x, 0) / 60).toFixed(2), between10and30min: g.filter(x => x >= 10 && x <= 30).length } })(),
      },
      parallelismRange: (() => { const v = list.map(w => w.parallelismByDir).filter(x => x != null); return v.length ? [Math.min(...v), Math.max(...v)] : null })(),
      /** ★ 并行度只在**同一波有多张卡**时才有意义 —— "这波没卡/只发了一张" 算出来是 0，
       *  混进区间会把 0 说成"并行度下限"，误导（b193 第一版就报成 0～1）。 */
      parallelismRangeMultiCard: (() => { const v = list.filter(w => w.cardCount > 1 && w.cardMs > 0).map(w => w.parallelismByDir).filter(x => x != null); return v.length ? [Math.min(...v), Math.max(...v), v.length] : null })(),
      /** 另一个口径：墙钟用**账本卡片区间**（[at − durationMs, at] 的并集）—— 
       *  它才能看出"同一波里两张卡是串着跑的"（串行时 并集 ≫ Σ单卡 ⇒ 并行度 <1）。 */
      parallelismRangeMultiCardByRows: (() => { const v = list.filter(w => w.cardCount > 1 && w.cardMs > 0).map(w => w.parallelismByRows).filter(x => x != null); return v.length ? [Math.min(...v), Math.max(...v), v.length] : null })(),
      parallelismRangeByName: (() => { const v = list.map(w => w.parallelismByName).filter(x => x != null); return v.length ? [Math.min(...v), Math.max(...v)] : null })(),
      parallelismUnder1: list.filter(w => w.parallelismByDir != null && w.parallelismByDir < 1).length,
      multiCardWaves: list.filter(w => w.cardCount > 1).length,
      top: list.map(w => ({ stamp: w.stamp, cards: w.cardCount, wallMin: w.wallMsByDir ? +(w.wallMsByDir / 60000).toFixed(1) : null, cardMin: +(w.cardMs / 60000).toFixed(1), par: w.parallelismByDir })).slice(-12),
    },
    ms: Date.now() - t0,
  }
  if (argv.includes('--json')) { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); if (argv.includes('--write')) { writeFileSync(SPEED_CACHE, JSON.stringify(out, null, 2), 'utf8'); console.log(`[账本] 速度缓存已写：${SPEED_CACHE}`) } return out }
  console.log(`📐 速度量具（b193 · M6-7）· 账本 ${rows.length} 条 · 用时 ${out.ms}ms · **只读**`)
  console.log('')
  console.log('【① 秒/回合】（⚠️ 分母**按家分**：Pi=turn_start／OpenCode=step_start／Claude 系=num_turns＝消息条数 ⇒ **跨家不可比**）')
  console.log(`   能算 ${out.secPerTurn.computed} 条 ／ 算不了 ${out.secPerTurn.canNot} 条（无 durationMs 或信封没了）`)
  for (const g of secGroups) console.log(`   ${String(g.n).padStart(3)} 条  中位 ${String(g.median).padStart(6)}s  区间 ${g.min}–${g.max}  ${g.group}`)
  console.log('')
  console.log('【②③④ 波次】（波次＝`runs\\<戳>` 目录）')
  const w = out.waves
  console.log(`   ${w.count} 个波次（其中多卡波次 ${w.multiCardWaves} 个）· 窗口 ${w.windowFrom?.slice(0, 16)} → ${w.windowTo?.slice(0, 16)}`)
  console.log(`   **② 墙钟**（三种口径都摆出来，对账用）：`)
  for (const [k, v] of Object.entries(w.sumWallHours)) console.log(`        ${k.padEnd(22)} **${v} h**`)
  console.log(`   **③ 空档**：${w.gaps.按文件时间.segments} 段 · Σ **${w.gaps.按文件时间.sumHours} h**（跨天＝>24h 的 ${w.gaps.按文件时间.over24h} 段占 ${w.gaps.按文件时间.over24hHours} h；10–30 分钟 **${w.gaps.按文件时间.between10and30min} 次**）`)
  const pm = w.parallelismRangeMultiCard
  console.log(`   **④ 并行度**：**${pm ? pm[0] + ' ～ ' + pm[1] : '—'}**（只统计**同波 ≥2 张卡**的 ${pm ? pm[2] : 0} 个波次 —— 单卡/空波算出来是 0，混进去会误导；<1 的部分＝门禁＋审核＋空隙）`)
  console.log(`      （全部波次含 0 的区间：${w.parallelismRange?.[0]}～${w.parallelismRange?.[1]}；<1 的波次 ${w.parallelismUnder1}／${w.count}）`)
  console.log('   最近 12 波：' + w.top.map(x => `${x.stamp.slice(5, 16)}(卡${x.cards} 墙${x.wallMin}分 并${x.par})`).join(' · '))
  if (argv.includes('--write')) {
    writeFileSync(SPEED_CACHE, JSON.stringify(out, null, 2), 'utf8')
    console.log(`\n[账本] 速度缓存已写：${SPEED_CACHE}（看板读它；删掉/过期 ⇒ 看板显示"未跑"）`)
  }
  return out
}

/**
 * backfill-speed —— 给 b193 之前记的老行补 `turnsKind` / `turnsDen` / `secPerTurn`（**只补空字段，不改已有值**）。
 * 为什么要它：量具是这一轮才加的，老行没有那三列；不补，"秒/回合"一列历史上就是空的。
 */
function cmdBackfillSpeed () {
  const j = load()
  let filled = 0, skipped = 0
  for (const r of j.calls) {
    if (r.turnsKind && r.turnsDen && r.secPerTurn != null) { skipped++; continue }
    if (!r.envelope || !existsSync(r.envelope)) { skipped++; continue }
    try {
      const t = countTurns(readTextAuto(r.envelope))
      r.turnsKind ??= t.turnsKind
      r.turnsDen ??= t.turnsDen
      if (r.secPerTurn == null && r.durationMs && t.turnsDen) r.secPerTurn = +(r.durationMs / 1000 / t.turnsDen).toFixed(2)
      r.numTurns ??= t.numTurns ?? null
      filled++
    } catch { skipped++ }
  }
  // 备份（这是改**真账本**，必须留一份能回去的）
  const bak = LEDGER.replace(/\.json$/, `.before-speed-backfill-${Date.now()}.json`)
  copyFileSync(LEDGER, bak)
  save(j)
  console.log(`[账本] speed 回填：补了 ${filled} 条，跳过 ${skipped} 条`)
  console.log(`[账本] 备份：${bak}`)
}

// ---------------------------------------------------------------- 入口

switch (cmd) {
  case 'init': cmdInit(); break
  case 'add': cmdAdd(); break
  case 'stats': cmdStats(); break
  case 'list': cmdList(); break
  case 'speed': cmdSpeed(); break
  case 'backfill-speed': cmdBackfillSpeed(); break
  default:
    console.error(`未知子命令：${cmd}（可用：init / add / stats / list / speed / backfill-speed）`)
    process.exitCode = 1
}
