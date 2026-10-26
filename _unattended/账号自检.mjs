#!/usr/bin/env node
/**
 * 账号自检（pre-flight）—— 无人值守模式 · 第 2 步
 *
 * 干什么：派活**之前**先确认班组账号可用。零 LLM、零额度消耗（只跑 `status -o json`）。
 * 为什么必须做：三个角色**同一个账号**，账号一挂就是"三通道同时停摆"，换人没用
 *               （方案 §5.4 账号类故障 / §11 验收清单第 1 条）。
 *
 * 判据（都来自 CLI 自己的返回，不猜）：
 *   logged_in=false        → 账号类故障，**停手告警**
 *   version 变了            → 记下来（CLI 升级可能改参数，可能影响派活）
 *   allow_byok / user_type  → 只记账，不当故障
 *
 * 用法：
 *   node 账号自检.mjs                  # 人看
 *   node 账号自检.mjs --json           # 机器看（给看板/脚本吃）
 *   node 账号自检.mjs --out _crew/account.json
 *
 * 退出码：0 = 可用；2 = 不可用（**失败不吞**，让看板与派活脚本能拦住）
 */

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, resolveRole, envFor } from './_agents-config.mjs'
// ★ 2026-10-18（b122 · 十三 S3）：「谁吃自家订阅」的唯一出处＝`_crew\carriers.json`，走 `_载体属性.mjs` 读。
import { ownsSubscriptionOf } from './_载体属性.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, '..')
/** 跑本套内部脚本用的 node（与其它脚本同一写法；**不是**载体的 node）。 */
const NODE_FOR_SELF = process.env.DSH_NODE_EXE ?? process.execPath

const argv = process.argv.slice(2)
const AS_JSON = argv.includes('--json')
const oi = argv.indexOf('--out')
const OUT = oi >= 0 ? argv[oi + 1] : null

// 班组程序从 `_crew\agents.json` 读（换 agent 只改那份 JSON）。
// 本检查只支持"能跑 `status -o json` 报登录态"的 agent；generic agent 会走"跳过检查"分支。
const { cfg: AGENTS_CFG, source: AGENTS_SRC, warnings: AGENTS_WARN } = loadConfig()
const AGENT_NAME = process.env.DSH_AGENT ?? AGENTS_CFG.defaultAgent
const RESOLVED = resolveRole('coder-a', AGENTS_CFG)   // 借 coder-a 拿到 agent 定义
const AGENT = AGENTS_CFG.agents[AGENT_NAME] ?? RESOLVED.agent
const NODE = AGENT.node ?? process.env.DSH_NODE_EXE ?? null
const ENTRY = AGENT.entry ?? null
const canStatus = (AGENT.kind ?? 'generic') === 'qoder'

const result = {
  schema: 1,
  checkedAt: new Date().toISOString(),
  ok: false,
  reasons: [],
  agent: { name: AGENT_NAME, kind: AGENT.kind ?? 'generic', source: AGENTS_SRC, supportsStatusCheck: canStatus },
  warnings: AGENTS_WARN,
  cli: { node: NODE, entry: ENTRY, entryExists: ENTRY ? existsSync(ENTRY) : null }
}

/**
 * ★ 2026-10-06 新增：**能查的那部分查掉** —— "每个角色要用的那把钥匙在不在"。
 *
 * 为什么加它：`canStatus` 只对 Qoder 为真（它是唯一有 `status -o json` 的载体），
 * 于是 coder-a / coder-b / reviewer / researcher 的账号面**从来没被检查过**，
 * 而"跳过"又被当成"通过" ⇒ 账号闸门恒绿。钥匙存在性是**确定性、零成本、不联网**的检查，
 * 正好补上这一格（真·额度/登录探活仍归 `额度检测.mjs`，那要联网，不放在起飞前的总闸里）。
 */
function keyCheck () {
  try {
    const roles = Object.entries(AGENTS_CFG.roles ?? {})
    const keysCli = join(HERE, '额度钥匙.mjs')

    // ① 先拿"权威供应商名 + 别名"：**直读路由表**（`额度钥匙.mjs providers` 只有人读输出，没有 --json；
    //    而路由表是它的唯一权威源，读它等价且更稳）。模型串里的前缀**不是**权威名
    //    （例：`qwen-token-plan-cn` 是 `aliyun` 的别名、`custom-local:kimi-k3` 实际走 `ark`）。
    const tablePath = join(HERE, '_coder路由表.json')
    let provs = []
    try {
      const t = JSON.parse(readFileSync(tablePath, 'utf8'))
      // ⚠️ 路由表是**扁平**的：顶级键就是各家名字（`ark` / `aliyun` / `SiliconFlow` …），
      //    没有 `providers` 这一层（我第一版按嵌套读 → 永远取不到，白名单直接空掉）。
      //    `_说明` 是文档字段，跳过。
      provs = Object.entries(t)
        .filter(([k, v]) => k !== '_说明' && v && typeof v === 'object')
        .map(([name, v]) => ({
          name,
          apiKeyEnv: v.apiKeyEnv ?? null,
          // ⚠️ `models` 是**对象数组**（`{id,name,contextWindow,…}`），不是字符串数组 ——
          //    第一版直接 `String(m)` 得到 "[object Object]"，于是模型名一个也匹配不上。
          models: (Array.isArray(v.models) ? v.models : []).map(m => String(m?.id ?? m?.name ?? m)).filter(Boolean),
          aliases: [name, v.alias, ...(Array.isArray(v.aliases) ? v.aliases : [])].filter(Boolean)
        }))
    } catch { provs = [] }
    if (!provs.length) return { note: `取不到供应商表（读 ${tablePath} 失败）`, skipped: true }

    /** 角色模型串 → 权威供应商名。**按优先级**（顺序很重要，实测踩过）：
     *   ① **前缀匹配**（`qwen-token-plan-cn/x` → 那家的别名是 `qwen-token-plan-cn`）
     *   ② **靠 agent 的 apiKeyEnv 配对**（本工作台自己的口径；能认 `custom-local:*` 这种无前缀的）
     *   ③ 模型 id 命中（**放最后**：同一个模型可能多家都有，例 `deepseek-v4.1-flash` 阿里与火山都在列，
     *      先比 id 会把 coder-a 误算到 ark —— 实测踩过，所以它只能当兜底）
     */
    const canonOf = (modelStr, roleName) => {
      const s = String(modelStr ?? '').toLowerCase()
      // ① 前缀
      for (const p of provs) {
        if (p.aliases.map(x => String(x).toLowerCase()).some(n => s.startsWith(n + '/'))) return p.name
      }
      // ② apiKeyEnv 配对
      try {
        const res = resolveRole(roleName, AGENTS_CFG)
        const envNames = Object.values(res.agent?.env ?? {}).map(v => String(v).replace(/^\$\{CRED:|\}$/g, ''))
        const hit = provs.find(p => p.apiKeyEnv && envNames.includes(p.apiKeyEnv))
        if (hit) return hit.name
      } catch {}
      // ③ 模型 id 兜底
      for (const p of provs) if (p.models.some(m => s.includes(String(m).toLowerCase()))) return p.name
      return null
    }

    const per = []
    // ★ 2026-10-07（修假警报）：**自有订阅的载体不查我们的钥匙** —— Qoder / CodeBuddy / Codex 吃自家登录态
    //   （或端点被环境变量钉死），我们的 provider 表对它们**没意义**。
    //   不跳过的后果（实测）：rescue 的裸模型 `Qwen3.8-Flash` 会被"照名字"认到**阿里**头上
    //   ⇒ 报出 `❌ 1 家没钥匙：aliyun` 这种**假警报**（阿里根本没被任何角色用到）。
    // ★ 2026-10-18（b122 · 十三 S3）：**名单从"抄一份"改成"读声明"** —— 原来这里 `const OWNS_SUB = [...]`
    //   是手抄 `_载体属性.OWNS_SUBSCRIPTION` 的，两处不同步就是上面那种假警报的温床。
    //   现在唯一出处＝`_crew\carriers.json`；**没声明的载体**由 `ownsSubscriptionOf()` 直接抛错（不静默当默认）。
    for (const [role, r] of roles) {
      if (ownsSubscriptionOf(String(r?.agent ?? ''))) continue
      const model = String(r?.prefer?.model ?? r?.model ?? '')
      per.push({ role, model, provider: canonOf(model, role) })
    }
    const needed = [...new Set(per.map(x => x.provider).filter(Boolean))]
    const unknown = per.filter(x => !x.provider)

    const ok = [], missing = []
    for (const p of needed) {
      const rr = spawnSync(NODE_FOR_SELF, [keysCli, 'resolve', p], { encoding: 'utf8', timeout: 60_000, windowsHide: true })
      const v = String(rr.stdout ?? '').trim()
      if (rr.status === 0 && v) ok.push(p); else missing.push(p)
    }
    return {
      note: '只查"角色要用的那把钥匙在不在"（确定性、不联网）；真探活走 `额度检测.mjs`',
      perRole: per, ok, missing, unknownProviders: unknown.map(x => `${x.role}(${x.model})`),
      summary: missing.length
        ? `❌ ${missing.length} 家没钥匙：${missing.join('、')}`
        : (unknown.length
            ? `⚠️ ${unknown.length} 个角色的供应商认不出：${unknown.map(x => x.role).join('、')}`
            : `✅ ${ok.length} 家角色钥匙都在（${ok.join('、')}）`)
    }
  } catch (e) {
    return { note: '钥匙检查本身出错（不影响其它项）', error: String(e?.message ?? e) }
  }
}

if (NODE && !existsSync(NODE)) result.reasons.push(`找不到 node：${NODE}`)
if (ENTRY && !existsSync(ENTRY)) result.reasons.push(`找不到 CLI 入口：${ENTRY}`)
// ⚠️ 2026-10-06：**没替换的占位符**（`${NODE}` / `${AGENTS}` 这种）不是真原因，别塞进 reasons 里当结论。
//   实例：默认 agent 是 pi，`DSH_AGENT` 没设时 NODE/ENTRY 会是字面占位符 → 旧输出里出现
//   "找不到 node：${NODE}"（看着像故障，其实只是「借 coder-a 拿 agent 定义」这条路没走通）。
result.reasons = result.reasons.filter(r => !/\$\{/.test(r))

if (!canStatus) {
  // 其它 agent 没有统一的登录态查询接口 → **不假装检查过**，明确说"跳过"。
  // ★★ 2026-10-06 改（三方交叉验证共同指出）：原来这里 `ok = true` —— 于是**账号闸门恒绿**
  //   （实测：`账号自检.mjs --json` 输出 `ok:true` 而 reasons 里写着"跳过账号自检"），
  //   `编排.mjs` 的"账号类故障整轮停手"因此**永远不会触发**。
  //   现在：**"不知道"不许报 ok**（`ok:false` + `unknown:true`），由调用方决定怎么处置；
  //   同时把它**能查的那部分查掉** —— "这个角色要用的钥匙在不在"是确定性的、零成本、不需要网络。
  result.skipped = true
  result.unknown = true
  result.reasons.push(`agent "${AGENT_NAME}"（kind=${AGENT.kind ?? 'generic'}）没有统一的 status 接口 → **登录态未知**（不是"可用"）`)
  result.ok = false
  result.unknown = true
  result.keyCheck = keyCheck()
} else if (existsSync(NODE) && existsSync(ENTRY)) {
  let raw = null; let err = null
  try {
    // ⚠️ 输出**绝不接管道**（实测接管道会 exit 42、零输出）——这里用 execFileSync 直接收 stdout，等价于 `1> 文件`
    raw = execFileSync(NODE, [ENTRY, 'status', '-o', 'json'], {
      encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout: 60_000,
      env: envFor({ agent: AGENT }, process.env)   // 按配置清环境变量（如 CI）
    })
  } catch (e) {
    err = e
    raw = e?.stdout ?? null
  }

  if (raw) {
    try {
      const j = JSON.parse(raw)
      result.account = {
        logged_in: j.logged_in ?? null,
        version: j.version ?? null,
        account_type: j.account_type ?? null,
        user_type: j.user_type ?? null,
        username: j.username ?? null,
        login_method: j.login_method ?? null,
        auth_source: j.auth_source ?? null,
        allow_byok: j.allow_byok ?? null
      }
      result.ok = j.logged_in === true
      if (!result.ok) result.reasons.push('logged_in=false → **账号类故障，停手告警**（三角色同账号，换人没用）')
    } catch (e) {
      result.reasons.push('status 返回的不是合法 JSON：' + String(e?.message ?? e))
      result.rawHead = String(raw).slice(0, 300)
    }
  } else {
    result.reasons.push('status 执行失败：' + String(err?.message ?? '无输出'))
  }
}

result.summary = result.skipped
  ? `⏭️ 登录态**未知**（agent「${result.agent.name}」没有统一 status 接口）${result.keyCheck?.summary ? '　·　' + result.keyCheck.summary : ''}`
  : result.ok
    ? `✅ 账号可用：${result.account?.username ?? '?'}（${result.account?.user_type ?? '?'}，CLI ${result.account?.version ?? '?'}）`
    : `❌ 账号不可用：${result.reasons.join('；')}`

const text = JSON.stringify(result, null, 2)
if (OUT) {
  const abs = resolve(WORKSPACE, OUT)
  if (!existsSync(dirname(abs))) mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, text, 'utf8')
}

if (AS_JSON) process.stdout.write(text + '\n')
else { console.log(result.summary); if (!result.ok) for (const r of result.reasons) console.log('   · ' + r) }

// 退出码：0 = 明确可用；**3 = 登录态未知**（不是失败，但调用方不许当"通过"）；2 = 明确不可用。
process.exit(result.ok ? 0 : (result.unknown ? 3 : 2))
