#!/usr/bin/env node
/**
 * 额度面板 —— 看板里那一块「⚙️ API 额度」的**逻辑层**（宿主半调它；协议见 KB `08-额度兜底与切换协议.md`）
 *
 * 设计原则（三条）：
 *   ① **不重造**：写操作（存/删/调优先级/检测/复位）一律**调已经测好的 CLI**（`额度钥匙.mjs` /
 *      `额度检测.mjs` / `额度切换.mjs`）—— 保证"面板做的"和"命令行做的"**是同一件事**；
 *   ② **密钥不进命令行**：存密钥时用 `set <供应商> <标签> -` 走 **stdin**（`ps`/任务管理器看不到）；
 *   ③ **永不回显完整密钥**：只出 `••••后4位`（走 `额度钥匙.mjs` 的 `mask`）。
 *
 * 用法（命令行自测）：
 *   node 额度面板.mjs list [--json]
 *   node 额度面板.mjs set <供应商> <标签> <密钥>        # 密钥也可用 `-` 走 stdin
 *   node 额度面板.mjs rm <供应商> <标签>
 *   node 额度面板.mjs priority <供应商> <标签1,标签2>
 *   node 额度面板.mjs check [<供应商>]
 *   node 额度面板.mjs reset
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CRED_FILE, KEY_STORE, STRUCT_FILE, WORKSPACE, addProvider, blockedInfo, discoverProfileProviders, discoverProviders, labelCandidates, loadBlocked, loadSecrets, loadStruct, mask, normalizeBaseURL, removeProvider, resolveKey, setBlocked } from './额度钥匙.mjs'
// ★ 2026-10-05：面板要展示"每个职位的模型 + 依次换哪几家 API" → 直接复用切换链的实现（**单一实现**）
import { chainFor, splitModel } from './额度切换.mjs'
// ★ 2026-10-07「治本」：**能选到 ≠ 这个载体能用** —— 载体的网关来源各不同（档案/路由表/opencode.json/自有清单），
//   所以在界面按载体过滤下拉、并在写入时拦明显用不了的。见 `_载体能力.mjs`。
import { capabilityFor, checkModel, ensureNative, forgetPiHomes } from './_载体能力.mjs'
// ★ 2026-10-16（§3.5 三档抽象）：档位落地/候选取值的唯一实现（同一份给 起飞前检查 用）
import { effortChoices, resolveEffort, ensureDecl, EFFORT_TIERS, DEFAULT_EFFORT_TIERS } from './_档位.mjs'
// ★ 2026-10-12：「这家在这个载体上叫什么」＝**唯一实现**（与运行时 `_agents-config.mjs` 同一份）。
//   起因（用户报障）：面板漏了 `perCarrier` ⇒ 给 coder-a（Pi）写 `xiaomi/…`（按量计费口），
//   而运行时拼的是 `xiaomi-token-plan-cn/…`（套餐口）⇒ 选完就是 401（"选了也没用"）。
import { carrierNameOf, canonOfCarrierName } from './_家名.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const NODE = process.env.DSH_NODE_EXE || process.execPath || 'node'
const STATE_FILE = join(WORKSPACE, '_crew', '额度状态.json')
/** 读角色配置（`_crew\agents.json`）——面板要按"职位"展示模型与换 API 顺序。 */
function readAgentsJson () { return readJson(join(WORKSPACE, '_crew', 'agents.json'), { roles: {} }) }
const VERDICT_ZH = { ok: '✅ 可用', 'invalid-key': '❌ 钥匙无效', quota: '⚠️ 没额度', 'rate-limited': '⏳ 被限流', 'no-probe': '❓ 无法探测', network: '🌐 连不上', error: '❌ 探测出错', missing: '➖ 缺钥匙' }

// ★ 2026-10-14 口径改（用户原话："真正的意思是**写代码的人不审代码**"）：
//   旧口径"角色之间模型名必须两两不同"已剔除 —— **两个 coder 之间同模型不算违规**。
//   真约束＝**写这份产出的模型 ≠ 审它/修它的模型**：
//     写方：coder-* / researcher（reviewer 审的是整波产出）／ rescue（它修 coder 的产出，修完仍由 reviewer 审）
//     审、修方：reviewer（审）／ rescue（修）
const isWriterRole = r => /^coder/.test(r) || r === 'researcher' || r === 'rescue'
const isCheckerRole = r => r === 'reviewer' || r === 'rescue'
/** 两个角色是否构成"写 × 审/修"冲突对（写×写、审×审都不算）。 */
const clashesWith = (a, b) => (isWriterRole(a) && isCheckerRole(b)) || (isCheckerRole(a) && isWriterRole(b))

/** 跑一个 CLI 子进程（可选把 stdin 喂进去）。**绝不把密钥写进 argv。** */
export function runCli (script, args, stdin = null, timeoutMs = 60_000) {
  return new Promise((resolve) => {
    const p = spawn(NODE, [join(HERE, script), ...args], { cwd: WORKSPACE, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    const t = setTimeout(() => { try { p.kill() } catch {} }, timeoutMs)
    p.stdout.on('data', d => { out += d })
    p.stderr.on('data', d => { err += d })
    p.on('close', code => { clearTimeout(t); resolve({ code, stdout: out, stderr: err }) })
    p.on('error', e => { clearTimeout(t); resolve({ code: -1, stdout: out, stderr: String(e?.message ?? e) }) })
    if (stdin != null) { try { p.stdin.write(stdin); p.stdin.end() } catch {} } else { try { p.stdin.end() } catch {} }
  })
}

function readJson (f, dflt) { try { return JSON.parse(readFileSync(f, 'utf8')) } catch { return dflt } }

/**
 * 界面送来的模型值是**限定值**（`家/模型`，下拉的 value 就是这么给的）还是裸名/手动填？
 * 判据＝分隔符前面那段**是不是这个载体认的家名**（`custom-local:` 这类载体私有前缀**不算**，
 *   它属于"载体自己的写法"，由 prefixed/native 那条路处理）。
 * 返回 `{ provider: 权威名|null, bare }`。认不出就当裸名 —— **绝不瞎拆**。
 */
function splitIncomingModel (agentId, value, provs) {
  const s = String(value ?? '')
  const i = s.search(/[\/:]/)
  if (i <= 0) return { provider: null, bare: s }
  const p = s.slice(0, i)
  const rest = s.slice(i + 1)
  const canon = canonOfCarrierName(p, agentId, { routing: provs })
  const known = (canon !== p) || Boolean(provs[p])
  if (!known) return { provider: null, bare: s }
  return { provider: provs[canon] ? canon : p, bare: rest }
}

/** 面板要展示的一切（**全部动态**；供应商来自路由表/档案，不是写死的）。 */
export function listView () {
  const providers = discoverProviders()
  const struct = loadStruct()
  const secrets = loadSecrets()
  const state = readJson(STATE_FILE, {})
  const rows = []
  for (const name of Object.keys(providers).sort()) {
    const v = providers[name]
    const declared = (struct.keys?.[name] ?? []).slice().sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99))
    // ★ 2026-10-07 修：以前 `count` **只数「声明」和「密钥库」**，不认 `resolveKey` 自己的通道
    //   ⇒ 钥匙只来自**环境变量 / 凭据库**（`cred:…`）的家会被显示成"**没钥匙**"、`configured=false`，
    //   而实际上 `resolveKey` 取得到（实测：阿里的钥匙来自 `cred:QWEN_TOKEN_PLAN_CN_API_KEY`，
    //   用户删掉的只是**密钥库**那条）。**面板必须说真话** ⇒ 第 0 把能解析出来就至少算 1 把。
    const resolved0 = resolveKey(name, 0, struct, secrets, providers)
    // ★ 屏蔽名单里的名字也要占一个槽位（否则"删了"之后行为空、界面连"已屏蔽"都没处显示）
    const blockedList = (struct.blocked?.[name] ?? []).filter(Boolean)
    const count = Math.max(declared.length, (secrets.providers?.[name] ?? []).length, resolved0 ? 1 : 0, blockedList.length)
    const keys = []
    for (let i = 0; i < count; i++) {
      const r = resolveKey(name, i, struct, secrets, providers)
      const st = (state.providers?.[name] ?? []).find(x => x.idx === i) ?? null
      const label = declared[i]?.label ?? secrets.providers?.[name]?.[i]?.label ?? blockedList[i] ?? '#' + (i + 1)
      // 这把"看着没钥匙"是不是因为我们主动屏蔽了？是的话把**下层来源**也说清（界面要如实显示）
      const binfo = blockedInfo(name, i, struct, secrets, providers)
      keys.push({
        idx: i,
        label,
        priority: declared[i]?.priority ?? i + 1,
        mask: r ? mask(r.key) : null,
        source: r?.source ?? null,          // env:… / file / cred:…
        blocked: Boolean(binfo),
        blockedFrom: binfo ? binfo.underlying : null,   // 挡住的是哪一层（env:… / file / cred:…）
        verdict: st?.verdict ?? null,
        verdictZh: st ? (VERDICT_ZH[st.verdict] ?? st.verdict) : '（未检测）',
        httpCode: st?.httpCode ?? null,
        checkedAt: state.checkedAt ?? null
      })
    }
    rows.push({
      name, source: v.source, alias: v.alias ?? [], baseURL: v.baseURL ?? null, apiKeyEnv: v.apiKeyEnv ?? null,
      models: (v.models ?? []).length,
      // ★ 2026-10-10（用户实测："没有 kimi-k3"）：可选清单必须是**并集** ——
      //   接口的 `/models` **不等于套餐能调的口径**（实测 `kimi-k3` 不在接口清单里、但真发推理返回 200）。
      //   所以要把**名字**也带出去，让界面把"只有路由表有"的那些也列进可搜可选的清单。
      //   ⚠️ 这两个字段必须**显式列出** —— 这个对象是逐字段挑的，没列到的会静默丢掉（踩过）。
      keptNames: v.models ?? [],
      unkeptModels: v.unkeptModels ?? [],
      keys,
      // ★ 2026-10-05（用户要求"简单点"）：**只列"你配过的"** ——
      //   ① 在**密钥库**里存过钥匙的；② 或**面板添加的**供应商（路由表里 说明 写着"面板添加"）。
      //   为什么：用**老凭据库**在跑的厂商（aliyun/ark…）本来就能用，摆一排空的粘贴框只会让人困惑；
      //   要给它们换/补钥匙时，在上面「添加」里填同一个名字即可（**密钥库优先于老凭据**）。
      // ★ 2026-10-07 修：`configured` 也**别只看密钥库** —— 钥匙在凭据库（`cred:…`）也算"配过"，
      //   否则会出现"面板说没配、可它其实能跑"的自相矛盾（阿里的钥匙就是这么被误判的）。
      configured: keys.some(k => k.mask) || (secrets.providers?.[name]?.length ?? 0) > 0 || /面板添加/.test(String(v.note ?? '')),
      panelAdded: /面板添加/.test(String(v.note ?? '')),
      usable: keys.some(k => k.verdict === 'ok') || keys.every(k => !k.verdict)
    })
  }
  // ★ 2026-10-12（用户口径，b36）：**「删」= 这家整个从面板消失** ——
  //   原话："opencode-go 我已经删了，就应该不存在了，而不是还能显示"。
  //   口径：**每一把钥匙都被屏蔽**的家 ＝ 你删掉的家 ⇒ **不进 `providers`**（于是 ① 的候选、
  //   ② 的钥匙管理、"另有 N 家…"那句、切换链、已选总和**全都不再提它**）。
  //   ⚠️ 只屏蔽了**一部分**钥匙的家**照旧显示**（它还有能用的钥匙，那一行要留着给「解除」）。
  //   ★ 回头路＝**重新添加同名钥匙**（`额度钥匙.mjs set` 会顺手解除这个槽位的屏蔽，见那边的注释）。
  //   ⚠️ 判据**不能**写成"每一把 keys 都被屏蔽"：`keys` 里那个"合成出来的空槽位"（由屏蔽名单长度撑出来的）
  //      没有 blocked 标记 ⇒ 删完照样"有一个槽位没被屏蔽"、整家还是显示（探针 ⑤ 当场逮住）。
  //      真判据＝**一把都解析不到钥匙 且 屏蔽名单里确实有这家**（屏蔽名单只因你按过「删」才存在）。
  const blockedMap = loadBlocked()
  const deleted = rows.filter(r => !r.keys.some(k => k.mask) && (blockedMap[r.name] ?? []).length).map(r => r.name)
  if (deleted.length) {
    for (const n of deleted) delete providers[n]
    for (let i = rows.length - 1; i >= 0; i--) if (deleted.includes(rows[i].name)) rows.splice(i, 1)
  }
  const fo = state.failover ?? {}
  const insideRepo = KEY_STORE.toLowerCase().startsWith(WORKSPACE.toLowerCase())
  // ★ 2026-10-05（用户口径）：**"优先级" = 先试哪一家** —— 按 `providerOrder` 给供应商行排序，
  //   并把顺序回传给界面（界面画序号 + ↑↓）。没设过就保持原顺序（零行为变化）。
  const pOrder = Array.isArray(struct.providerOrder) ? struct.providerOrder : []
  const prank = (n) => { const i = pOrder.indexOf(n); return i === -1 ? 999 : i }
  rows.sort((a, b) => prank(a.name) - prank(b.name))
  // ★ 2026-10-05（**用户口径**）：**按"职位"看** —— 职位 + 本体 + 选定的模型，外加"这个模型依次换哪几家 API"。
  //   规则：**模型定了就只换 API**（`chainFor` 已只自动追加"同款模型"的其它家），
  //   某家**没有这个模型就跳过**（`chainFor` 里按 `v.models` 过滤掉了），**角色模型不换**。
  const agents = readAgentsJson()
  // ★ 2026-10-07「治本」：**能选到 ≠ 这个载体能用**。给每个职位带上"它载体的能用的模型"，
  //   让界面**按载体过滤下拉**、写入时**拦住明显用不了的**（见下面 `case 'roleModel'`）。
  // ★ 2026-10-07：**没钥匙的家不进下拉**。起因：用户把阿里的额度用光后删了它（`keys` 已空），
  //   但路由表**仍声明**着 `aliyun`/`qwen-token-plan-cn` ⇒ 下拉里还会摆出 `qwen3.8-flash` 这类模型，
  //   一选就是"没钥匙的家"（跑不起来）。**能选到就该能用**，所以按"有没有解析出钥匙"过滤。
  // ★ 2026-10-12：**"没钥匙"要能说清是哪一种**（无钥匙 / 停用）。被"删"的家已在上面整家隐藏 ⇒
  //   这里只会有 `ok` / `nokey` 两种；`blocked` 这个取值留着只为兼容老前端。
  const keyless = []
  const providerState = {}
  for (const [k] of Object.entries(providers)) {
    const ks = (rows.find(r => r.name === k)?.keys ?? [])
    const has = ks.some(x => x.mask)
    const blocked = ks.some(x => x.blocked)
    providerState[k] = has ? 'ok' : (blocked ? 'blocked' : 'nokey')
    if (!has) keyless.push(k)
  }
  const modelsByProvider = {}
  for (const [k, v] of Object.entries(providers)) {
    if (keyless.includes(k)) continue
    const ms = v.models ?? []
    modelsByProvider[k] = [...new Set([...(modelsByProvider[k] ?? []), ...ms])]
    for (const a of (v.alias ?? [])) modelsByProvider[a] = [...new Set([...(modelsByProvider[a] ?? []), ...ms])]
  }
  // ★ 2026-10-12（用户口径："这里的模型应该为 API 已经选择的模型总和"）：
  //   `allModels` 改成**「② 已选」的总和**（只算能用的家）—— 以前它把**没钥匙的家**也并进来
  //   （例：档案里声明 10 个模型的 `opencode-go`），于是兜底清单里会出现"② 里根本没选、也跑不了"的名字。
  const allModels = [...new Set(Object.entries(providers).filter(([k]) => !keyless.includes(k)).flatMap(([, v]) => v.models ?? []))].sort()
  const capMemo = {}
  const capOf = (agent) => {
    if (agent in capMemo) return capMemo[agent]
    const c = capabilityFor(agent)
    return (capMemo[agent] = {
      mode: c.mode, allowed: c.allowed ?? null, how: c.how, notes: c.notes ?? null,
      prefix: c.prefix ?? null, base: c.base ?? null,
      // ⚠️ 这个对象是**逐字段挑的**：没列到的会**静默丢掉**（这文件自己的注释就警告过，我又踩了一次 ——
      //   b39 新加的 `entries` 漏在这里 ⇒ 界面把 跨多家 的每条模型都算成 `ark`）。
      entries: c.entries ?? null,
      // ★ b40（用户口径）：这家载体**换不了家**（＝不支持自定义 API 的额外要求，例：Qwen Code 带不了
      //   `x-opencode-session` 这种头 ⇒ 要头的那家必 400）⇒ 界面在"备选"那里如实写一句，别假装能换。
      customApi: c.customApi !== false,
      customApiWhy: c.customApiWhy ?? null,
      // ★ 2026-10-12：`reach` = 这个载体**自己认的家名**（`perCarrier` 优先）—— 下拉的值要用它当前缀，
      //   与运行时 `_agents-config.mjs` 拼命令行时用的是同一个名字。
      reach: c.reach ?? null,
      native: c.models ? c.models.map(m => ({ label: m.label, value: m.value, custom: !!m.custom })) : null
    })
  }
  ensureNative(false)   // 惰性：缓存过期就顺手抓一次 Qoder 自有清单（零成本元数据；12h 内不重复抓）

  /**
   * ★★ 2026-10-12（用户报障："选不了模型，选了也没用"＋"这里的模型应该为 API 已经选择的模型总和"）——
   *   **候选清单在这里算（服务端，唯一实现）**，值一律是 `家/模型`。
   *
   * 三个必须同时成立的口径：
   *   ① 候选 = 「② 已选」∩「这个载体够得着的家」——
   *      够不着的家**不假装能选**（选了它也认不出：2026-10-07 那次"给 Qoder 选火山模型"的教训）。
   *   ② 值带家名。以前给**裸模型名**，而写入口要求 `家/模型` ⇒ **第一次点选必被拦**
   *      （"这个载体要带供应商前缀"），得再点一次同一条才走"强制写入" —— 这就是"选不了模型"。
   *   ③ 家名用**这个载体认的写法**（`perCarrier`）。同一个模型名在两家都有时**各占一格**
   *      （以前按裸名去重，`deepseek-v4.1-flash` 来自 ark 还是 ocgo **没得选**）。
   */
  const selectedTotal = (() => {
    const s = new Set()
    for (const [k, v] of Object.entries(providers)) if (!keyless.includes(k)) for (const m of (v.models ?? [])) s.add(k + '|' + m)
    return s.size
  })()
  const optMemo = {}
  const optionsOf = (agent) => {
    const a = String(agent ?? '')
    if (a in optMemo) return optMemo[a]
    const cap = capOf(a)
    const out = []
    if (cap.mode === 'providers') {
      for (const rr of (cap.reach ?? [])) {
        if (keyless.includes(rr.canon)) continue
        for (const m of (providers[rr.canon]?.models ?? [])) {
          out.push({ value: rr.name + '/' + m, label: m, bare: m, provider: rr.canon, providerName: rr.name })
        }
      }
    } else if (cap.mode === 'prefixed') {
      // ★ b39：`prefixed` 模式现在也可能**跨多家**（CodeBuddy 的 `models.json` 一条模型一个 url；
      //   Qwen Code 的 `modelProviders` 每模型一个 baseUrl）⇒ 优先用载体**自己清单**里的 `entries`
      //   （每条带它真实属于哪家），只有老后端/读不到时才回落到"整批都算 ark"。
      const es = Array.isArray(cap.entries) && cap.entries.length
        ? cap.entries
        : (cap.base ?? []).map((m) => ({ bare: m, canon: 'ark' }))
      for (const e of es) {
        // ★ b47（方法 A）：值用**载体自己的选择器**（Qwen Code ⇒ `家/模型`；CodeBuddy ⇒ `custom-local:` 前缀）。
        //   家的区分由**传输层**表达（Qwen 派活时把它拆成 `--openai-base-url`）⇒ **同名跨家不再冲突**，
        //   所以 b46 那套"重复的标成不可选"**不需要了**（撤销）。
        out.push({
          value: e.sel ?? (String(cap.prefix) + e.bare), label: e.bare, bare: e.bare,
          provider: e.canon ?? null,
          providerName: e.canon ? carrierNameOf(e.canon, a) : (cap.prefix || null)
        })
      }
    } else if (cap.mode === 'native') {
      for (const x of (cap.native ?? [])) {
        const nt = (cap.notes && (cap.notes[x.label] || cap.notes[x.value])) || null
        out.push({ value: x.value, label: x.label, bare: x.value, provider: null, providerName: null, custom: !!x.custom, note: nt })
      }
    }
    optMemo[a] = out
    return out
  }
  const roleRows = Object.entries(agents.roles ?? {}).map(([role, r]) => {
    const full = String(r.prefer?.model ?? '')
    // ⚠️ 两种写法都要认：`供应商/模型`（阿里、火山）和 `供应商:模型`（custom-local:kimi-k3）——
    //   用切换链里同一个 `splitModel`（**单一实现**），别在这儿再写一遍解析。
    const model = splitModel(full, r.route ?? null).model
    let hops = []
    try { hops = chainFor(role, struct, providers, agents).filter(h => h.model === model) } catch {}
    const cap = capOf(r.agent ?? null)
    // ★ 2026-10-07：**只有"按家走"的载体才有切换链**。Qoder/CodeBuddy 的模型来自它们自己的 CLI/订阅，
    //   我们的 provider 表对它们没意义 —— 以前却会给 rescue 算出一条 `1.ark`（因为 `DeepSeek-V4-Pro`
    //   被"大小写不敏感地在路由表里找到了"）⇒ **假链**，看着像"急救走火山"。现在明确不给。
    // ★ 2026-10-07（用户要求）：**备选模型**也要能在同一行里选（可以选"空"）⇒ 视图带上它的裸名
    const fbRaw = (r.fallback ?? [])[0]?.model ? String(r.fallback[0].model) : ''
    const fallback = fbRaw ? splitModel(fbRaw, r.route ?? null).model : null
    const inChain = cap.mode === 'providers'
    // ★ 2026-10-12：现用值**原样报出去**（含前缀/载体私有写法），并说清它为什么不在候选里 ——
    //   以前统一写"这载体可能不认"，实测对 `custom-local:kimi-k3`（真能跑）就是**假警报**。
    const opts = optionsOf(r.agent ?? null)
    const current = full || model
    const inList = opts.some(o => o.value === current)
    let why = null
    if (!inList) {
      const sp = splitModel(current, r.route ?? null)
      const canon = sp.provider ? canonOfCarrierName(sp.provider, r.agent ?? null, { routing: providers }) : null
      // 「这个载体够不着这家」＝家名不认识 / 不是它声明的家（两条都归到这里，界面话术一样）
      const reach = new Set((cap.reach ?? []).map(x => x.canon))
      const known = sp.provider ? (reach.size ? reach.has(canon) : Boolean(providers[canon])) : false
      if (sp.provider && !known) why = 'unknown-provider'
      else if (canon && keyless.includes(canon)) why = 'no-key'
      else if (!opts.some(o => (o.bare || o.value) === sp.model)) why = 'not-selected'   // 候选里根本没这个名字
      else why = 'unknown-provider'                                                       // 名字有，但写法/家名对不上
    }
    const missing = Object.keys(providers).filter(k => !keyless.includes(k) && (providers[k].models ?? []).length && !opts.some(o => o.provider === k))
    // ★ 2026-10-16（任务分级 L1–L4）：**级模型也要在看板里选** —— 这是用户口径"每级用什么模型＝我在看板里定"的落点。
    //   界面只负责画：这里把「四级各自现在配着什么 / 是不是必填 / 值从哪来」算好报出去（判据与 `_agents-config.mjs` 同一口径）。
    const lvCfg = (() => { try { return readAgentsJson() } catch { return { roles: {} } } })()
    const lvRole = lvCfg.roles?.[role] ?? {}
    const lvGlobal = lvCfg.levels ?? {}
    const LEVELS = ['L1', 'L2', 'L3', 'L4']
    const levelInfo = LEVELS.map(L => {
      const per = lvRole.levels?.[L] ?? null
      const g = lvGlobal[L] ?? {}
      const m = String(per?.model ?? g.model ?? '').trim() || null
      const tier = String(per?.effortTier ?? g.effortTier ?? '').trim() || null
      // ★ 2026-10-16（§3.5 三档抽象）：档位落地 = 按**这个模型自己的白名单**取第一个支持的。
      //   这里把"三个抽象档各自落到哪个具体值"算好给界面（界面只画，不再自己猜）。
      // ⚠️ 家名要按 `_家名.mjs` 归一到**档案里的家名**（`xiaomi-token-plan-cn` → `xiaomi`），
      //   否则档案里明明有的模型会被判成"查不到档位"（实测：L1–L3 三格全空）。
      //   注意：**不能把路由表塞进 options**（那会让它反查不到别名口径），与 `_agents-config.mjs` 的做法保持一致。
      const homeOfModel = (mm) => {
        const raw = String(mm).split(/[\/:]/)[0]
        try { return canonOfCarrierName(raw, null, {}) ?? raw } catch { return raw }
      }
      // ★ 2026-10-16（用户：为什么 ocgo 不支持选档位？）：**按这个角色走哪条路**取来源 ——
      //   `messenger`（DSH headless）的配置是 `coder-b-dsh.mjs` 按**路由表**现生成的 ⇒ 看路由表；
      //   其余载体读 DSH 档案。两处都查不到 ⇒ 按 DSH 默认口径放行（标"未核实"），**不置灰**。
      const via = (r.agent === 'messenger') ? 'messenger' : 'carrier'
      const choices = m ? effortChoices(homeOfModel(m), m, via) : { known: false, values: [], why: '这级还没选模型' }
      const tiers = (lvCfg.levels?.effortTiers) ?? DEFAULT_EFFORT_TIERS
      const tierMap = {}
      for (const t of EFFORT_TIERS) {
        const res = m ? resolveEffort(homeOfModel(m), m, t, tiers, { via }) : null
        tierMap[t] = res ? { resolved: res.resolved, status: res.status, why: res.why } : null
      }
      return {
        level: L,
        model: m,
        modelRaw: m ? splitModel(String(m), r.route ?? null).model : null,
        effort: String(per?.effort ?? g.effort ?? '').trim() || null,   // 读兼容：老写法（具体值）
        effortTier: tier,                                                // ★ 写入口：省/中/狠
        effortTiers: EFFORT_TIERS,
        effortChoices: choices,                                          // 这个模型自己认哪些具体档位
        effortTierMap: tierMap,                                          // 省/中/狠 各自会落成什么
        from: per?.model ? 'roles.levels' : (g.model ? '全局 levels' : '未配'),
        shape: { steps: g.steps ?? null, gate: g.gate ?? null, shape: g.shape ?? null, 一句话: g['一句话'] ?? null },
        mustSet: !m,
        why: m ? null : '这一级没配模型 ⇒ 派这一级的卡会**当场报错**（不会静默走默认档）'
      }
    })
    return {
      role, agent: r.agent ?? null, model, effort: r.prefer?.effort ?? null, preferRaw: full,
      levels: levelInfo,
      levelOptions: opts,
      fallback, fallbackRaw: fbRaw || null,
      providers: inChain ? hops.map((h, i) => ({ rank: i + 1, provider: h.provider, auto: !!h.auto })) : [],
      onlyOne: inChain ? hops.length <= 1 : false,
      // ★ b53（用户："动一下这里，这里肯定是不对的"）：prefixed 载体（CodeBuddy / Qwen Code）**已经走路由网关**，
      //   ② 里那些家它都能用（要换就在左边下拉里选那一家）⇒ 老话术"自有清单/自有订阅、要换得先换载体"**已作废**。
      //   但"额度用完自动依次换"那条链**还没为它们接上**（目前只有 providers 模式的载体在自动链里）—— 这句必须如实说。
      chainNA: inChain ? null : (new Set((cap.entries ?? []).map(e => e.canon).filter(Boolean)).size >= 2
        ? '走**路由网关**：② 里这几家它都能用（要换就在左边下拉里选那一家）；⚠️ **"额度用完自动依次换"还没为这个载体接上**（目前只有 providers 模式的载体在自动链里）'
        : '自有清单 / 自有订阅 —— **不在"额度用完依次换"的切换链里**（要换得先换载体）'),
      cap,
      // ★ 2026-10-12：候选清单 ＋ 现用值状态 ＋ 口径（界面只负责画，不再自己算）
      modelOptions: opts,
      modelCurrent: current,
      modelCurrentInList: inList,
      modelCurrentWhy: why,
      scope: { reachable: opts.length, selectedTotal, missing }
    }
  })
  return {
    ok: true, at: new Date().toISOString(),
    providers: rows,
    providerOrder: pOrder,
    roles: roleRows,
    allModels,
    // ★ 2026-10-07：给界面按"载体能用哪些家"过滤下拉用（模型 → 它属于哪家）；**没钥匙的家已剔除**
    modelsByProvider,
    keylessProviders: keyless,
    // ★ 2026-10-12：每家为什么不可用（`ok` / `nokey` 真没钥匙）—— ② 页那句要说真话。
    //   被"删"的家**整家不在这里出现**（见上面 `deleted`）。
    providerState,
    blockedHidden: deleted,
    selectedTotal,
    failover: { at: fo.at ?? null, roles: fo.roles ?? {} },
    store: {
      keyStore: KEY_STORE, structFile: STRUCT_FILE, credFile: CRED_FILE,
      keyStoreExists: existsSync(KEY_STORE), safeOutsideRepo: !insideRepo,
      note: insideRepo ? '❌ 密钥库在工作台目录里（开源前会被打包出去）' : '✅ 密钥库在工作台目录之外（不进仓库）'
    }
  }
}

/** ★ 2026-10-05：**这家没声明模型时，从它的接口抓一次模型列表**（写进路由表，先备份）。
 *  为什么需要：**切换链只把"声明了同一款模型"的家排进来** —— 模型列表是空的家**永远进不了链**，
 *  而用户完全不知道为什么（实测痛点）。抓一次是**零 token** 的（就是 `GET /models`）。
 *  返回抓到的个数（没抓/失败 → null，**不报错、不拦流程**）。 */
async function fillModelsIfEmpty (name, baseURL, key) {
  if (!name || !baseURL || !key) return null
  try {
    const rt = join(WORKSPACE, '_unattended', '_coder路由表.json')
    const j = readJson(rt, null)
    if (!j) return null
    // ★ 2026-10-07 修（用户实测："我加了小米的 API，为什么选不了 MiMo？"）：
    //   以前这里是 `if (!j || !j[name] || …) return null` —— **一声不吭就放弃**。
    //   而"面板新加的家"**常常不在路由表里**（`saveKey` 见它已在档案里就不调 `addProvider`）⇒
    //   兜底恰好对**新家**失效、用户完全不知道为什么。现在把"为什么没抓"回传，界面如实说清。
    if (!j[name]) return { why: 'not-in-routing' }
    if ((j[name].models ?? []).length) return { why: 'already-has-models' }
    const r = await fetch(String(baseURL).replace(/\/+$/, '') + '/models', {
      headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(12_000)
    })
    if (r.status !== 200) return { why: 'http-' + r.status }
    const js = await r.json().catch(() => null)
    const ids = (js?.data ?? js?.models ?? []).map(m => m.id ?? m.name ?? m).filter(Boolean).slice(0, 300)
    if (!ids.length) return { why: 'empty-list' }
    try { writeFileSync(rt + '.bak-models-' + Date.now(), readFileSync(rt)) } catch {}
    j[name].models = ids.map(id => ({ id }))
    writeFileSync(rt, JSON.stringify(j, null, 2), 'utf8')
    return { count: ids.length }
  } catch { return { why: 'fetch-failed' } }
}

/** 统一入口：宿主半的 `POST /api-keys` 直接调它。**密钥只从 payload 进，绝不回显。** */
/**
 * ★★ 2026-10-12（b37 · 用户口径："难道不能我看板点击直接同步去配置载体的模型列表吗？"）——
 *   把「② 已选」同步进**各载体自己**的模型清单（目前是 Pi 的 `~/.pi/agent/models.json`；
 *   `同步载体模型.mjs` 会跳过 Pi 自带的家、密钥只写 `${环境变量}` 引用、并有备份）。
 *   失败**不拦主流程**（用户在 ② 的操作照常算成功），但把话带出去（绝不静默）。
 */
async function syncCarriers () {
  try {
    const r = await runCli('同步载体模型.mjs', [], null, 90_000)
    // 同步之后**清掉"Pi 能用哪些家"的缓存** —— 否则下拉还是旧的（"我明明勾了怎么还没出现"）
    try { forgetPiHomes() } catch {}
    // ⚠️ **只读结构化那一行**（`<!--同步结果-->` + JSON）—— 别去解析上面给人看的中文说明
    //    （起飞前检查的「禁散文自检」就是管这个的：机器要的状态走结构化产物）
    const m = /<!--同步结果-->(\{.*\})/.exec(String(r.stdout ?? ''))
    if (!m) return (r.code === 0 ? '同步脚本没回结构化结果' : '同步失败（退出码 ' + r.code + '）')
    const j = JSON.parse(m[1])
    const parts = []
    if (Array.isArray(j.declared) && j.declared.length) parts.push('声明 ' + j.declared.map((d) => d.name + '(' + d.models + ')').join('、'))
    else parts.push('没有要声明的家')
    if (j.skippedBuiltin?.length) parts.push('跳过它自带的 ' + j.skippedBuiltin.join('、'))
    if (j.removed?.length) parts.push('清掉已不在②里的 ' + j.removed.join('、'))
    if (j.wrote) parts.push('已写入 Pi 的 models.json（密钥只写 ${环境变量} 引用）')
    else if (!parts.length) parts.push('没变化')
    return parts.join('；')
  } catch (e) {
    return '同步出错（已忽略，不影响你刚才这步）：' + String((e && e.message) || e).slice(0, 120)
  }
}

/** 哪些操作会改动「② 已选 / 钥匙」⇒ 改完顺手同步进载体清单。 */
const SYNC_AFTER = new Set(['modelKeep', 'modelBulk', 'fetchModels', 'set', 'saveKey', 'rm', 'keyUnblock'])

// ════════════════════════════════════════════════════════════════════════════════════════════
// ★ 2026-10-16（任务分级 L1–L4）：**级模型也在看板里定**（用户口径："每级用什么模型＝我在这里定"）
//   通道＝复用 `roleModel`，payload 多一个可选 `level`（L1..L4）：
//     · 带 level ⇒ 写 `roles.<角色>.levels.<级>.model`（**不是** prefer.model）
//     · 不带   ⇒ 一个字都不改（＝今天的行为，天然可关）
//   与前缀那条同一套把关：载体能力闸（checkModel）＋ 写审分离（逐级比）。
//   依据＝KB `重构\任务分级-施工文档.md` §4 规矩 2 / §6 ③；**这里不写死任何模型名**。
// ════════════════════════════════════════════════════════════════════════════════════════════
const LEVEL_KEYS = ['L1', 'L2', 'L3', 'L4']
const normLevel = (v) => {
  const s = String(v ?? '').trim().toUpperCase()
  const m = /^L?([1-4])(?:\+.*)?$/.exec(s)
  return m ? 'L' + m[1] : null
}
/** 把"某一级的思考档位"写进配置（写**抽象档名**，不写具体值）；返回人话一段。 */
function writeLevelEffortTier (j, f, role, r, LEVEL, tier) {
  const t = String(tier ?? '').trim()
  if (!EFFORT_TIERS.includes(t)) return { ok: false, error: `档位只认 ${EFFORT_TIERS.join(' / ')}（收到 "${tier}"）` }
  const cur = r.levels?.[LEVEL] ?? {}
  if (!cur.model) return { ok: false, error: `「${LEVEL}」还没选模型 —— 先选模型再选档位（档位是"落到这个模型上"的，没模型就无处落地）` }
  // 落地预演：这个抽象档在这个模型上会变成什么（当场把结论告诉用户，别让他以后自己猜）
  const home = String(cur.model).split('/')[0]
  const via = (r.agent === 'messenger') ? 'messenger' : 'carrier'
  const res = resolveEffort(home, cur.model, t, undefined, { via })
  try { writeFileSync(f + '.bak-roleLevelEffort-' + Date.now(), readFileSync(f)) } catch {}
  r.levels[LEVEL] = { ...cur, effortTier: t }
  writeFileSync(f, JSON.stringify(j, null, 2), 'utf8')
  const land = res.resolved
    ? `落成 **${res.resolved}**（${res.status === 'ok' ? '这个模型就认它' : '降级：' + (res.why ?? '')}）`
    : (res.status === 'unsupported'
        ? `⚠️ **这个模型一个档位都不认** ⇒ 真派活时**不传档位**（载体按自己默认跑）：${res.why ?? ''}`
        : `⚠️ **未核实**（档案里查不到这个模型）⇒ 真派活时不传档位：${res.why ?? ''}`)
  return { ok: true, output: `已把「${role}」的 **${LEVEL} 档位**设为「**${t}**」　·　${land}　·　写在 agents.json 的 roles.${role}.levels.${LEVEL}.effortTier（**不写具体值**）` }
}

/** 逐级写审分离：把"某一级"的模型与审/修方的（该级 or 缺省）模型比一遍。 */
function levelClashNotes (roles, role, LEVEL, bareModel, val) {
  const bare = (m) => String(m ?? '').split(/[\/:]/).pop()
  const notes = []
  for (const [k2, v2] of Object.entries(roles ?? {})) {
    if (k2 === role) continue
    if (!clashesWith(role, k2)) continue
    const other = bare(v2.levels?.[LEVEL]?.model ?? v2.prefer?.model ?? v2.model)
    if (other && other === bareModel) notes.push(`⚠️ 这一级「${LEVEL}」上「${role}」与「${k2}」**同一个模型**（${val}）—— 破"写代码的人不审代码"（级模型也受这条硬约束管），请给其中一个换一款`)
  }
  return notes
}

export async function handle (op, payload = {}) {
  const res = await handleInner(op, payload)
  if (SYNC_AFTER.has(op) && res && res.ok !== false) {
    const note = await syncCarriers()
    res.output = String(res.output ?? '') + '　·　🔄 **载体清单**：' + note
  }
  return res
}

async function handleInner (op, payload = {}) {
  switch (op) {
    // ⚠️ 统一格式：**一律返回 `{ ok, view }`**（踩过：`list` 原来直接返回数据本身 →
    //   前端在等 `j.view` → 界面永远"读取中…"，但请求其实是成功的）。
    case 'list': return { ok: true, view: listView() }
    case 'set': {
      const { provider, label, key, priority } = payload
      if (!provider || !label || !key) return { ok: false, error: '缺参数：provider / label / key' }
      if (key.length < 8) return { ok: false, error: '密钥太短（至少 8 位）—— 确认没粘错' }
      if (!/^[\w.\-:]+$/.test(provider)) return { ok: false, error: '供应商名不合法' }
      const r = await runCli('额度钥匙.mjs', ['set', provider, String(label), '-'], String(key))
      if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || '写入失败').trim().slice(0, 300) }
      if (priority != null) await runCli('额度钥匙.mjs', ['priority', provider, String(label)])
      return { ok: true, view: listView() }
    }
    case 'rm': {
      const { provider, label, idx } = payload
      if (!provider || !label) return { ok: false, error: '缺参数：provider / label' }
      const r = await runCli('额度钥匙.mjs', ['rm', provider, String(label)])
      if (r.code !== 0) return { ok: false, error: (r.stderr || '删除失败').trim().slice(0, 300) }
      // ★ 2026-10-10（用户实测："删了还在"）：**光删密钥库不够** —— 解析是三层
      //   （环境变量 → 密钥库 → 你原来的凭据库），删掉第②层会**回落到第③层**，那一行又出现。
      //   ⇒ 同时把它记进**屏蔽名单**（结构文件 `_crew\额度兜底.json` 的 `blocked`，不含密钥）。
      //   ⚠️ **同一个槽位的所有叫法一起屏蔽**（实测踩到：删掉后声明也没了 ⇒ 标签从 `主号` 变 `#1`，
      //      只按 `主号` 记会**键对不上、屏蔽失效**）。所以把候选标签全记上。
      //   ★ 2026-10-12（b36）修：**不再顺带屏蔽 `cand0`**（第 0 槽位的叫法）—— 那是过宽的：
      //      两家钥匙的家删掉第 2 把 ⇒ `#1` 也被记上 ⇒ **第 1 把也取不到了**（探针 ⑦ 当场逮住）。
      //      要删的那一把自己的全部叫法（含 `#N` 兜底）已经足够覆盖"标签漂移"那个坑。
      const st0 = loadStruct()
      const cands = (idx != null && Number.isFinite(Number(idx))) ? labelCandidates(provider, Number(idx), st0) : labelCandidates(provider, 0, st0)
      for (const l of [...new Set([...cands, String(label)])]) setBlocked(provider, l, true)
      const b = { ok: true }
      // 看下层还有没有来源 —— 有就**如实说清删不掉的是哪一层**，别让用户以为删成功却"又回来了"
      let under = null
      try { under = blockedInfo(provider, 0) } catch {}
      const srcZh = (s) => !s ? null
        : s.indexOf('env:') === 0 ? ('环境变量 ' + s.slice(4) + '（外部注入，本机删不掉）')
          : s.indexOf('cred:') === 0 ? ('你原来的凭据库（' + s.slice(5) + '）')
            : s === 'file' ? '本机密钥库' : s
      return {
        ok: true,
        output: '已删「' + label + '」并**记入屏蔽名单**（这家不再用它）' +
          (under && under.underlying
            ? '　·　⚠️ 注意：这把钥匙**下层还有来源** —— ' + srcZh(under.underlying) +
              '。已挡住不解析；要彻底清掉得去那一层删（环境变量删不了，只能改那个变量）'
            : '') +
          (b && b.ok === false ? '　·　⚠️ 屏蔽名单没写成功：' + b.error : ''),
        view: listView()
      }
    }
    // ★ 解除屏蔽：让某把钥匙**重新生效**（对"删错了"的补救；不动任何文件里的钥匙值）
    //   ⚠️ 必须**对称地**解除——`rm` 屏蔽了那个槽位的**多个候选标签**（`主号` / `#1` …），
    //      这里只解一个的话另一个还挡着 ⇒ 解了等于没解（踩过）。
    case 'keyUnblock': {
      const { provider, label, idx } = payload
      if (!provider || !label) return { ok: false, error: '缺参数：provider / label' }
      const st0 = loadStruct()
      const cand0 = labelCandidates(provider, 0, st0)
      const cands = (idx != null && Number.isFinite(Number(idx))) ? labelCandidates(provider, Number(idx), st0) : cand0
      let anyErr = null
      for (const l of [...new Set([...cands, String(label), ...cand0])]) {
        const r = setBlocked(provider, l, false)
        if (r.ok === false) anyErr = r.error
      }
      if (anyErr) return { ok: false, error: anyErr }
      const back = resolveKey(provider, 0)
      return {
        ok: true,
        output: '已**解除屏蔽**「' + label + '」' + (back ? '　·　它现在又能解析到了（来源 ' + back.source + '）' : '　·　（不过这层没有钥匙，还是解析不到）'),
        view: listView()
      }
    }
    case 'priority': {
      const { provider, order } = payload
      if (!provider || !Array.isArray(order) || !order.length) return { ok: false, error: '缺参数：provider / order[]' }
      const r = await runCli('额度钥匙.mjs', ['priority', provider, order.join(',')])
      if (r.code !== 0) return { ok: false, error: (r.stderr || '调优先级失败').trim().slice(0, 300) }
      return { ok: true, view: listView() }
    }
    // ★ 2026-10-05（用户口径）：**供应商级"先试顺序"** —— 写进 `_crew\额度兜底.json` 的 `providerOrder`。
    //   生效点：切换链里"自动追加的后备"按它排序（**角色自己的首选不变** —— 那是刻意安排的异构）。
    case 'order': {
      const { order } = payload
      if (!Array.isArray(order) || !order.length) return { ok: false, error: '缺参数：order[]（供应商的先后顺序）' }
      const st = loadStruct()
      st.providerOrder = order.map(String)
      writeFileSync(STRUCT_FILE, JSON.stringify(st, null, 2), 'utf8')
      return { ok: true, output: '已保存"先试顺序"：' + st.providerOrder.join(' → ') + '（角色自己的首选不变；它挂了以后按这个顺序顺延）', view: listView() }
    }
    // ★ 2026-10-07（用户要求）：**备选模型也能在看板上选**（同一行第二个下拉；**可以选"空"**）。
    //   写进 `roles.<角色>.fallback`（**先备份**）。语义（用户口径，见 KB `08` §8）：
    //   **主模型失败 → 先换备选模型；备选还不行 → 换 API（按看板的"先试顺序"）；到那家后先主后备。**
    case 'roleFallback': {
      const { role, model, manual, force } = payload
      if (!role) return { ok: false, error: '缺参数：role' }
      const f = join(WORKSPACE, '_crew', 'agents.json')
      const j = readJson(f, null)
      if (!j) return { ok: false, error: '读不到 agents.json' }
      const r = j.roles?.[role]
      if (!r) return { ok: false, error: '没有这个角色：' + role }
      const main = String(r.prefer?.model ?? '')
      // ① 选「空」= 清掉备选（用户明确要求"备选可以选空"）
      if (!model) {
        const had = (r.fallback ?? []).map(x => x.model).join('、')
        try { writeFileSync(f + '.bak-roleFallback-' + Date.now(), readFileSync(f)) } catch {}
        r.fallback = []
        writeFileSync(f, JSON.stringify(j, null, 2), 'utf8')
        return { ok: true, output: `已把「${role}」的备选**清空**` + (had ? `（原：${had}）` : '（本来就没有）') + '　·　出事时只能**换 API**、不能换模型', view: listView() }
      }
      // ② 归一成"载体认的写法"**在下面做**，做完**再**把关（顺序很重要：界面送来的是**裸模型名**，
      //   先校验会被误判成"缺前缀" —— 主模型那条路就是先归一后校验的）。
      const capNow = capabilityFor(r.agent ?? '')
      const notes = []
      let val = model
      if (capNow.mode === 'native') {
        const hit = (capNow.models ?? []).find(m => m.value === model || m.label === model)
        if (hit) val = hit.value
      } else if (capNow.mode === 'providers') {
        // 复用"归一名 + 载体认的名字"那套（与主模型一致，别在这儿再写一遍）
        const provs = discoverProviders()
        // ★ 2026-10-12：家名解析走**唯一实现**（`perCarrier` 优先）；界面送来的是 `家/模型` 限定值 ⇒ 先拆。
        const canonOf = (p) => canonOfCarrierName(p, r.agent ?? '', { routing: provs })
        const carrierName = (canon) => carrierNameOf(canon, r.agent ?? '', { routing: provs })
        const splitIn = splitIncomingModel(r.agent ?? '', model, provs)
        const bareM = splitIn.bare
        const cur = main.split(/[\/:]/)[0]
        const curCanon = provs[canonOf(cur)] ? canonOf(cur) : null
        const keepCur = curCanon ? (provs[curCanon]?.models ?? []).includes(bareM) : false
        const claimed = Object.entries(provs).find(([, v]) => (v.models ?? []).includes(bareM))?.[0]
        // 用户**明确挑了哪一家**（下拉值带家名）⇒ 那家优先，绝不替他改主意；没挑才按老口径回落。
        const picked = splitIn.provider ? canonOf(splitIn.provider) : null
        const canon = picked ?? (keepCur && curCanon ? curCanon : (claimed ?? (manual && curCanon ? curCanon : null)))
        if (!canon) return { ok: false, error: '没有任何 API 声明提供这个模型：' + bareM + '（要强行写入就再选一次同一个 = 强制写入）' }
        // 前缀写法：**家没变就一个字都不改**（`custom-local:` / 别名这类写法必须原样保留）
        val = (((curCanon && canon === curCanon) ? cur : carrierName(canon))) + '/' + bareM
      }
      // ③ 现在 `val` 已经是"载体认的写法"了 ⇒ 再把关（能选到 ≠ 这个载体能用）
      const chk = checkModel(r.agent ?? '', val)
      if (!chk.ok && !force) return { ok: false, error: '这个载体用不了这个模型：' + chk.why + '　（确定要用就再选一次同一个 = 强制写入）' }
      if (chk.warn) notes.push('ℹ️ ' + chk.warn)
      if (String(val).split(/[\/:]/).pop() === main.split(/[\/:]/).pop()) notes.push('⚠️ 备选**和主模型是同一个** ⇒ 等于没有备选')
      const dupR = Object.entries(j.roles ?? {})
        .filter(([k2, v2]) => k2 !== role && String(v2.prefer?.model ?? '').split(/[\/:]/).pop() === String(val).split(/[\/:]/).pop()).map(([k2]) => k2)
      if (dupR.length) notes.push(`⚠️ 备选的模型名与「${dupR.join('、')}」的**主模型同名**（异源独立性打折）`)
      const effort = (r.fallback ?? [])[0]?.effort ?? r.prefer?.effort ?? null
      try { writeFileSync(f + '.bak-roleFallback-' + Date.now(), readFileSync(f)) } catch {}
      r.fallback = [{ model: val, effort }]
      writeFileSync(f, JSON.stringify(j, null, 2), 'utf8')
      try {
        const fx = await runCli('_定编对账.mjs', ['--fix'], null, 30_000)
        const out = String((fx.stdout || '') + (fx.stderr || ''))
        const n = (out.match(/^  - /gm) ?? []).length
        if (fx.code !== 1 && n) notes.push(`✅ **顺手对齐了文档**（${n} 处，原文已备份）`)
      } catch {}
      return { ok: true, output: `已把「${role}」的备选设为 ${val}` + (notes.length ? '　·　' + notes.join('　·　') : ''), view: listView() }
    }
    // ★ 2026-10-05（用户口径）：**给某个职位选模型**（选项来自"API 声明的模型"）。
    //   写进 `_crew\agents.json` 的 `roles.<角色>.prefer.model`（**先备份**）。
    case 'roleModel': {
      const { role, model, effort, manual, provider, force } = payload
      const LEVEL = normLevel(payload.level)      // ★ 任务分级：非空 ⇒ 写 levels.<级>（不带就完全照旧）
      if (!role || !model) return { ok: false, error: '缺参数：role / model' }
      const f = join(WORKSPACE, '_crew', 'agents.json')
      const j = readJson(f, null)
      if (!j) return { ok: false, error: '读不到 agents.json' }
      const r = j.roles?.[role]
      if (!r) return { ok: false, error: '没有这个角色：' + role }
      // ★ 2026-10-07「治本」（用户："走治本"）：**先按载体能力把关** ——
      //   `能选到 ≠ 这个载体能用`。实测踩过两次：给 Qoder 的急救选了火山的模型名（`ark/…`、`qwen-token-plan-cn/…`）。
      //   过不了就**拒写**并说清为什么；确实要用（例：你比我知道得多）就再点一次「仍然写入」（`force:true`）。
      const chk = checkModel(r.agent ?? '', model)
      if (!chk.ok && !force) {
        return { ok: false, error: '这个载体用不了这个模型：' + chk.why + '　（确定要用就再选一次同一个 —— 会强制写入；或换一个它认的名字）' }
      }
      // ══ 2026-10-07「治本」第二步：**载体自有模型** ══════════════════════════════════════
      //   Qoder 那 25 个（含 10 个自定义）与 CodeBuddy 的 `custom-local:*` **不属于任何一家 provider**
      //   ⇒ 它们**原样写、不挂供应商前缀**（Qoder 的自定义条目还要写成它的 **UUID/modelID**）。
      //   走到这里之前 `checkModel` 已经确认"这个载体认它"，所以不需要再找家。
      const capNow = capabilityFor(r.agent ?? '')
      if (capNow.mode === 'native' || capNow.mode === 'free' || capNow.mode === 'prefixed') {
        const hit = capNow.mode === 'native' ? (capNow.models ?? []).find(m => m.value === model || m.label === model) : null
        const val = hit ? hit.value : model
        const n2 = []
        if (hit && hit.custom) n2.push('ℹ️ 这是**自定义条目** ⇒ 已按它的 modelID 写（' + String(val).slice(0, 8) + '…），Qoder 就是这么要求的')
        if (!hit && capNow.mode === 'native') n2.push('ℹ️ 它自家的清单里我没核到这个名字（你点了「仍然写入」）—— 跑起来失败别意外')
        if (chk.warn) n2.push('ℹ️ ' + chk.warn)
        // 写审分离：写这份产出的模型 ≠ 审它/修它的模型（两个 coder 同模型不算违规）
        const dup2 = Object.entries(j.roles ?? {})
          .filter(([k2, v2]) => k2 !== role && String(v2.prefer?.model ?? '').split(/[\/:]/).pop() === val).map(([k2]) => k2)
          .filter(k2 => clashesWith(role, k2))
        if (dup2.length) n2.push(`⚠️ 现在「${role}」与「${dup2.join('、')}」**同一个模型** —— 破"写代码的人不审代码"（写这份产出的模型必须 ≠ 审它/修它的模型）`)
        // ★ 2026-10-16（任务分级）：带 level ⇒ 写 levels.<级>，**不动 prefer**（载体自有模型这条支路）
        if (LEVEL) {
          n2.push(...levelClashNotes(j.roles, role, LEVEL, String(val).split(/[\/:]/).pop(), String(val)))
          try { writeFileSync(f + '.bak-roleLevel-' + Date.now(), readFileSync(f)) } catch {}
          r.levels = { ...(r.levels ?? {}), [LEVEL]: { ...(r.levels?.[LEVEL] ?? {}), model: val, ...(effort ? { effort } : {}) } }
          writeFileSync(f, JSON.stringify(j, null, 2), 'utf8')
          return { ok: true,
            output: `已把「${role}」的 **${LEVEL} 级**模型设为 ${val}（这个载体的自有模型／要求写法）　·　只动了 levels.${LEVEL}，**prefer 没动**`
              + (n2.length ? '　·　' + n2.join('　·　') : ''),
            view: listView() }
        }
        const routeOld2 = r.route ?? null
        if (r.agent === 'messenger' || !r.route) { /* 自有模型载体一般不吃 route；不动 */ }
        try { writeFileSync(f + '.bak-roleModel-' + Date.now(), readFileSync(f)) } catch {}
        r.prefer = { ...(r.prefer ?? {}), model: val, ...(effort ? { effort } : {}) }
        writeFileSync(f, JSON.stringify(j, null, 2), 'utf8')
        // 文档定编表也跟着对齐（模型是软项；配置永远权威）
        try {
          const fx2 = await runCli('_定编对账.mjs', ['--fix'], null, 30_000)
          const out2 = String((fx2.stdout || '') + (fx2.stderr || ''))
          const n3 = (out2.match(/^  - /gm) ?? []).length
          if (fx2.code !== 1 && n3) n2.push(`✅ **顺手对齐了文档**的定编表（${n3} 处，原文已备份）`)
        } catch {}
        return {
          ok: true,
          output: `已把「${role}」的模型设为 ${val}（` + (hit ? '**这个载体的自有模型** ⇒ 不挂供应商前缀'
            : (capNow.mode === 'prefixed' ? '**载体要求的写法**（`' + capNow.prefix + '` 前缀是硬的；端点由环境变量钉死在火山）'
              : '按你要求**原样写入** —— 我没在它自家的清单里核到这个名字')) + '）' + (n2.length ? '　·　' + n2.join('　·　') : ''),
          view: listView()
        }
      }
      const provs = discoverProviders()
      // ⚠️ **踩过的坑（正是用户最在意的那点）**：`agents.json` 里写的是**档案名**（`qwen-token-plan-cn`），
      //   而路由表的权威名是 `aliyun` → 直接 `provs[cur]` 取不到 → 会被误判成"这家没这个模型"
      //   → **把供应商也顺手换掉了**（用户明确要求"只换 API 不换模型"，反了）。
      //   三条口径：① 先把档案名**归一成权威名**再判断；② 命中就**沿用原来那个字符串**（一个字都不改）；
      //   ③ 真要换家时写**载体认的名字**（`perCarrier` 优先，与运行时 `_agents-config.mjs` 同一口径）。
      // ★ 2026-10-12 修（用户报障："选了也没用"）：原来 ③ 走的是 `alias[0]`、**漏了 `perCarrier`**
      //   ⇒ Pi 上会把家名写成 `xiaomi`（按量计费口），而我们的钥匙是套餐的 ⇒ 选完就 401。
      const canonOf = (p) => canonOfCarrierName(p, r.agent ?? '', { routing: provs })
      const carrierName = (canon) => carrierNameOf(canon, r.agent ?? '', { routing: provs })
      // ★ 2026-10-12：界面送来的是 `家/模型` **限定值**（下拉的 value 就是这么给的）⇒ 先拆出裸名与那一家，
      //   否则 `claimed`（谁声明了这个模型）永远找不到 → 报"没有任何 API 声明提供这个模型"（选了没用）。
      const splitIn = splitIncomingModel(r.agent ?? '', model, provs)
      const bare = splitIn.bare
      const cur = String(r.prefer?.model ?? '').split(/[\/:]/)[0]
      // ⚠️ `cur` **不一定是家名**：有的职位 `prefer.model` 不带前缀（实测 researcher = `qwen3.8-flash`）——
      //   那时 `cur` 是模型名，**绝不能拿它当前缀拼**（会写出 `模型名/模型` 甚至 `/模型`）。
      //   所以"当前那家"只有在 `provs` 认得出来时才算数。
      const curCanon = provs[canonOf(cur)] ? canonOf(cur) : null
      const curIsProv = Boolean(curCanon)
      const claimed = Object.entries(provs).find(([, v]) => (v.models ?? []).includes(bare))?.[0]
      const keepCur = curCanon ? (provs[curCanon]?.models ?? []).includes(bare) : false
      // ★ 2026-10-07（用户："我加了小米的 API，为什么选不了 MiMo？"）：
      //   允许**手动填一个本地清单里没有的模型名**（`manual:true`，来自界面的「搜模型 → 手动填」）。
      //   为什么需要：有的家（尤其**面板新加的**）本地没有模型清单 —— 用户明明知道模型名，不该被关在门外。
      //   口径：能确定是哪家就用哪家；确定不了就**沿用这个职位当前那家**
      //   （界面会把切换链的链首 `provider` 报上来；它认得出来才用，否则宁可报错也不瞎拼）。
      // ★ 2026-10-12：**用户明确挑了哪一家**（下拉值带家名）时，那家优先 —— 绝不替他改主意。
      const picked = splitIn.provider ? canonOf(splitIn.provider) : null
      const fallbackProv = picked ?? ((provider && provs[canonOf(provider)]) ? canonOf(provider) : (curIsProv ? curCanon : null))
      const canon = picked ?? (keepCur && curCanon ? curCanon : (claimed ?? (manual ? fallbackProv : null)))
      if (!canon) return { ok: false, error: '没有任何 API 声明提供这个模型：' + bare + '（用界面的「搜模型 → 手动填」可以强行写入；或先用「＋ 添加」把这家 API 加进来）' }
      // 前缀写法：**家没变就一个字都不改**（`custom-local:`/别名这类载体私有写法必须原样保留）；
      //   换家时才用**载体认的名字**（`perCarrier`，例 Pi 上小米＝`xiaomi-token-plan-cn`）。
      const sameHome = Boolean(curCanon && canon === curCanon)
      const newFull = (sameHome ? cur : carrierName(canon)) + '/' + bare
      // ══════════════════════════════════════════════════════════════════════════════════
      // ★ 2026-10-07 新增（用户原话："难道不能，我在看板改，其他的地方一起改了吗？"）
      //   **面板原来只改一个文件**（`agents.json` 的 `prefer.model`）—— 但改一个职位的模型，
      //   有的载体**还依赖别的地方**，不改就白改：
      //   · **DSH headless（`messenger`，就是调研员）吃 `--route`**：它是按
      //     `roles.<角色>.route` 去 `_coder路由表.json` 查路由的（`coder-b-dsh.mjs:94` 查不到就**硬失败**）。
      //     表里没有这家 ⇒ 改了模型也跑不起来（坑库：换researcher模型只改agents.json会UNKNOWN_MODEL）。
      //   · **其它载体（pi / opencode / codebuddy / qoder）不吃这张表**，它们读**档案里的 provider 声明**
      //     ⇒ 只声明在路由表里的家，它们不认识。
      //   所以这里**能自动改的全自动改掉**，不能在只读语义下改的**明确说出来**，绝不静默。
      // ══════════════════════════════════════════════════════════════════════════════════
      const notes = []
      const routeOld = r.route ?? null
      const want = canonOf(canon)
      const pv = provs[want] ?? provs[canon] ?? {}
      const isDsh = r.agent === 'messenger'                       // 只有它吃 --route
      if (isDsh) {
        const rt = join(WORKSPACE, '_unattended', '_coder路由表.json')
        const tabel = readJson(rt, null)
        if (!tabel) notes.push('⚠️ 读不到路由表，没能核对 route')
        else {
          if (!tabel[want]) {
            // 补一条：三样**全部从档案现读**（baseURL / apiKeyEnv / models），缺一样就不猜、只报告
            const miss = [!pv.baseURL && 'baseURL', !pv.apiKeyEnv && 'apiKeyEnv', !(pv.models ?? []).length && 'models'].filter(Boolean)
            if (miss.length) {
              notes.push(`⚠️ 「${want}」不在路由表里，档案里又缺 ${miss.join('、')} ⇒ **补不出来**：调研员用它仍会失败（要在档案里补齐这家，或在「＋ 添加」里把网址填上）`)
            } else {
              try { writeFileSync(rt + '.bak-route-' + Date.now(), readFileSync(rt)) } catch {}
              tabel[want] = {
                说明: '（由「API 额度」面板改职位模型时**自动补齐** —— 这家原来只声明在档案里）',
                api: pv.api ?? 'openai-completions',
                baseURL: pv.baseURL,
                apiKeyEnv: pv.apiKeyEnv, envField: pv.apiKeyEnv,
                models: (pv.models ?? []).map(id => ({ id }))
              }
              writeFileSync(rt, JSON.stringify(tabel, null, 2), 'utf8')
              notes.push(`✅ **顺手补了路由表**：「${want}」（${pv.baseURL} · ${pv.apiKeyEnv} · ${(pv.models ?? []).length} 个模型）`)
            }
          }
          if (tabel[want] && r.route !== want) { r.route = want; notes.push(`✅ **顺手改了 route**：「${role}」${routeOld ? '原 ' + routeOld + ' → ' : ''}${want}`) }
        }
      } else {
        // 非 DSH 载体：它读档案。模型属于"只在路由表里"的家 ⇒ 明确警告（这类我无权改档案）
        const profNames = new Set(Object.keys(discoverProfileProviders()))
        const inProfile = profNames.has(want) || (provs[want]?.alias ?? []).some(a => profNames.has(a))
        if (!inProfile) notes.push(`⚠️ 「${want}」只声明在**路由表**里、档案里没有 ⇒ ${r.agent} 载体读的是档案，**可能不认识它**；要么在档案里补这家，要么给这个职位换一家档案里有的`)
      }
      // 写审分离：写这份产出的模型 ≠ 审它/修它的模型（只警告，不替你改；两个 coder 同模型不算违规）
      const clash = Object.entries(j.roles ?? {})
        .filter(([k2, v2]) => k2 !== role && String(v2.prefer?.model ?? '').split(/[\/:]/).pop() === bare)
        .map(([k2]) => k2)
        .filter(k2 => clashesWith(role, k2))
      if (clash.length) notes.push(`⚠️ 现在「${role}」与「${clash.join('、')}」**同一个模型** —— 破"写代码的人不审代码"（写这份产出的模型必须 ≠ 审它/修它的模型），请给其中一个换一款`)
      if (chk.warn) notes.push('ℹ️ ' + chk.warn)
      if (!chk.ok && force) notes.push('⚠️ 这个模型这个载体**本来用不了**（你点了"仍然写入"）—— 跑起来失败别意外')
      // ★ 2026-10-16（任务分级）：**带 level ⇒ 这一格写进 levels.<级>，不动 prefer**
      if (LEVEL) {
        notes.push(...levelClashNotes(j.roles, role, LEVEL, bare, newFull))
        try { writeFileSync(f + '.bak-roleLevel-' + Date.now(), readFileSync(f)) } catch {}
        r.levels = { ...(r.levels ?? {}), [LEVEL]: { ...(r.levels?.[LEVEL] ?? {}), model: newFull, ...(effort ? { effort } : {}) } }
        writeFileSync(f, JSON.stringify(j, null, 2), 'utf8')
        // ★ 2026-10-16：**第一次用到某个"没登记过的家"时，顺手把它登记进档位声明**（idempotent、不覆盖已有）
        //   这样"看板加 API → 分级不能选档位"这件事从根上不再发生（用户要的通用解）。
        try { ensureDecl(String(newFull).split('/')[0], { models: [bare] }) } catch { /* 登记失败不影响写入 */ }
        return { ok: true,
          output: `已把「${role}」的 **${LEVEL} 级**模型设为 ${newFull}`
            + (sameHome ? '（供应商没变，只换了模型）' : '')
            + `　·　只动了 roles.${role}.levels.${LEVEL}，**默认档 prefer 一个字没动**`
            + (notes.length ? '　·　' + notes.join('　·　') : '')
            + '；某级没配时派活会**当场报错**（不会静默走默认档）',
          view: listView() }
      }
      try { writeFileSync(f + '.bak-roleModel-' + Date.now(), readFileSync(f)) } catch {}
      r.prefer = { ...(r.prefer ?? {}), model: newFull, ...(effort ? { effort } : {}) }
      writeFileSync(f, JSON.stringify(j, null, 2), 'utf8')
      // ★ 2026-10-07（用户："模型是不能定死的…我不能每次在看板换不同的模型，都要报错吧？"）：
      //   文档里那张定编表是**配置的投影** ⇒ 这里**顺手把它对齐**（`_定编对账.mjs --fix`，它会先备份文档）。
      //   于是"在看板换模型"这个动作**永远不会**再让 `起飞前检查` 变红。
      try {
        const fx = await runCli('_定编对账.mjs', ['--fix'], null, 30_000)
        const out = String((fx.stdout || '') + (fx.stderr || ''))
        const n = (out.match(/^  - /gm) ?? []).length
        if (fx.code !== 1 && n) notes.push(`✅ **顺手对齐了文档**的定编表（${n} 处，原文已备份）`)
        else if (fx.code === 1) notes.push('⚠️ 文档定编表还有**硬项**（载体/档位/参数）对不上 —— 那不是模型的事，得看 `_定编对账.mjs` 的输出')
      } catch {}
      return { ok: true, output: '已把「' + role + '」的模型设为 ' + newFull
        + (sameHome ? '（**供应商没变**，只换了模型）'
          : (manual && !claimed ? '（⚠️ 这个模型名**本地没有任何家声明** ⇒ 按"手动填"处理，**供应商沿用当前那家**；填错了模型名不会有任何自动纠正）'
            : (picked ? '（按你选的这家）' : '（这家才有这个模型）')))
        + (notes.length ? '　·　' + notes.join('　·　') : '')
        + '；额度用完时只换 API、不换模型', view: listView() }
    }
    // ══ 2026-10-16（§3.5 三档抽象）：**只改某一级的思考档位**（写抽象档名"省/中/狠"，不动模型）══
    case 'roleLevelEffort': {
      const { role } = payload
      const LEVEL = normLevel(payload.level)
      if (!role || !LEVEL) return { ok: false, error: '缺参数：role / level（L1..L4）' }
      const f = join(WORKSPACE, '_crew', 'agents.json')
      const j = readJson(f, null)
      if (!j) return { ok: false, error: '读不到 agents.json' }
      const r = j.roles?.[role]
      if (!r) return { ok: false, error: '没有这个角色：' + role }
      const res = writeLevelEffortTier(j, f, role, r, LEVEL, payload.effortTier)
      return res.ok ? { ok: true, output: res.output, view: listView() } : res
    }
    case 'check': {
      const args = payload.provider ? ['--provider', payload.provider] : ['--all']
      const r = await runCli('额度检测.mjs', args, null, 180_000)
      return { ok: r.code === 0, output: (r.stdout || r.stderr || '').trim().slice(0, 4000), view: listView() }
    }
    case 'reset': {
      const r = await runCli('额度切换.mjs', payload.role ? ['reset', payload.role] : ['reset'])
      return { ok: r.code === 0, output: (r.stdout || r.stderr || '').trim().slice(0, 500), view: listView() }
    }
    // ★ 2026-10-05（用户要求"玩家每次填入都点添加"）：把「加厂商」和「填钥匙」**合成一步** ——
    //   名字 + 网址 + 密钥 → 一次搞定：① 名字不在路由表就先声明；② 再把密钥存进本机密钥库。
    //   （密钥库**优先于**老凭据库，所以给已存在的厂商填新钥匙 = 覆盖它，正是用户想要的。）
    case 'saveKey': {
      const { name, baseURL, key } = payload
      if (!name || !key) return { ok: false, error: '缺参数：name / key' }
      // ★ 2026-10-10：**先归一化再校验**（用户粘的是完整接口地址 `…/v1/models`，
      //   本格要的是**基址**）。规则只有一处 —— `额度钥匙.mjs` 的 `normalizeBaseURL`。
      //   顺序不能反：先砍尾巴再判 http(s)://，否则 `…/v1/models` 那种会被误判成"不是网址"。
      const rawURL = String(baseURL ?? '').trim()
      const cleanURL = rawURL ? normalizeBaseURL(rawURL) : ''
      // ★ 2026-10-05（用户实测踩到"密钥粘进网址格"）：**两个长串框互相填错，都要拦**。
      if (/:\/\//.test(String(key))) return { ok: false, error: '密钥那格填的像是**网址**（含 ://）—— 网址填第 ② 格，密钥填第 ③ 格' }
      if (/^sk-/i.test(cleanURL)) return { ok: false, error: '「网址」那格填的像是**密钥**（sk- 开头）—— 密钥填第 ③ 格；② 这格要填网址，例：https://api.siliconflow.cn/v1' }
      if (cleanURL && !/^https?:\/\//i.test(cleanURL)) return { ok: false, error: '「网址」那格必须 http:// 或 https:// 开头（例：https://api.siliconflow.cn/v1）' }
      if (key.length < 8) return { ok: false, error: '密钥太短（至少 8 位）—— 确认没粘错' }
      const known = Boolean(discoverProviders()[name])
      if (!known) {
        const a = addProvider({ name, baseURL: cleanURL })
        if (!a.ok) return { ok: false, error: a.error }
      }
      const r = await runCli('额度钥匙.mjs', ['set', name, '主号', '-'], String(key))
      if (r.code !== 0) return { ok: false, error: (r.stderr || '写入失败').trim().slice(0, 300) }
      // ★ 2026-10-05：**没声明模型的家，顺手从接口抓一次**（用户实测痛点：模型列表空 → 这家永远进不了切换链，
      //   而用户不知道为什么）。只在"这家 models 为空"时抓，零 token。
      const got = await fillModelsIfEmpty(name, (cleanURL && /^https?:\/\//i.test(cleanURL)) ? cleanURL : discoverProviders()[name]?.baseURL, key)
      // ★ 2026-10-05（用户要的"**填一个验一个**"）：保存后**立刻探一次**，把结果当场说出来 ——
      //   并把"这三格各存了什么"回显出来（网址 / 密钥掩码 / 模型数），**填错哪格一眼就能看见**。
      let probeZh = '（这次没探到）'
      try {
        const pr = await runCli('额度检测.mjs', ['--provider', name, '--timeout', '10000'], null, 40_000)
        const v = readJson(STATE_FILE, {}).providers?.[name]?.[0]
        probeZh = v ? ((VERDICT_ZH[v.verdict] ?? v.verdict) + (v.httpCode ? '（HTTP ' + v.httpCode + '）' : '')) : '（没拿到结论）'
      } catch {}
      const view = listView()
      const row = view.providers.find(p => p.name === name)
      const k0 = row?.keys?.[0]
      return {
        ok: true,
        output: (known ? ('已给 ' + name + ' 存好钥匙（优先于你原来的凭据）') : ('已新增 ' + name + ' 并存好钥匙'))
          + '　·　**回显**：网址 = ' + (row?.baseURL ?? '（空）') + ' · 密钥 = ' + (k0?.mask ?? '—') + ' · 模型 = ' + (row?.models ?? 0) + ' 个'
          // ★ 2026-10-10：粘了完整接口地址时**明说砍掉了什么** —— 否则用户以为存的是自己粘的那个
          + (cleanURL !== rawURL
            ? `　·　ℹ️ 网址已自动归一：` + '`' + rawURL + '` → `' + cleanURL + '`（这格要**基址**，接口尾巴由程序自己拼）'
            : '')
          + (got && got.count ? `（顺手从接口抓到 ${got.count} 个）` : '')
          + (got && got.why === 'not-in-routing'
            ? '　·　⚠️ 这家**不在路由表里** ⇒ 模型清单只能来自**档案里的声明**（档案里声明了就会出现在下拉里）；档案里也没有的话，用上面「搜模型」框**手动填名字**'
            : '')
          + '　·　**刚检测**：' + probeZh,
        view
      }
    }
    // ★ 2026-10-10（用户口径，照 DSH 桌面端那个模式）：**「获取模型」＝ 拉取**，与「剔除」分开。
    //   为什么要这个按钮（用户原话："dsh桌面端…有一个获取模型按钮，点击以后可以获取模型列表
    //   然后可以剔除不用的模型，我们的这个API池也这样做"）：
    //   以前只有 `fillModelsIfEmpty`（**自动**抓、**只在空时**抓、**抓完全存**）⇒
    //   ① 用户无法主动拉；② 拉进来几十个（含套餐不提供的、以及别的 API 族的，选了必废）；③ **没有剔除手段**。
    case 'fetchModels': {
      const { name } = payload
      if (!name) return { ok: false, error: '缺参数：name' }
      const p = discoverProviders()[name]
      if (!p) return { ok: false, error: '没有这家：' + name + '（先「添加」它，或检查路由表）' }
      const base = p.baseURL
      if (!base) return { ok: false, error: '这家**没声明网址** ⇒ 拉不了模型清单（先在下面「添加」里填网址）' }
      const r = resolveKey(name)
      if (!r) return { ok: false, error: '这家**没钥匙** ⇒ 先在上面给它存一把（拉清单要鉴权）' }
      const url = normalizeBaseURL(base).replace(/\/+$/, '') + '/models'
      // ★ 两族认证头**不一样**（2026-10-10 实测）：绝大多数家吃 `Authorization: Bearer`；
      //   而 Anthropic 那一族（例：opencode-go 的 `messages` 端）**只认 `x-api-key`**，用 Bearer 会
      //   报 `AuthError: Missing API key` —— 看着像钥匙坏了，其实是头用错了。所以**两种都试**。
      const schemes = [
        ['bearer', { Authorization: 'Bearer ' + r.key }],
        ['x-api-key', { 'x-api-key': r.key }]
      ]
      let hit = null
      const tried = []
      for (const [k, headers] of schemes) {
        try {
          const res = await fetch(url, { headers: { 'User-Agent': 'dsh-panel/1.0', ...headers }, signal: AbortSignal.timeout(15_000) })
          tried.push(k + ':' + res.status)
          if (res.status === 200) {
            const js = await res.json().catch(() => null)
            const rows = (js?.data ?? js?.models ?? [])
            // ★ 2026-10-10（用户要求："获取模型列表应该在用户点的时候就应该过滤掉下架的"）：
            //   火山的 `/models` **不按状态过滤** —— 实测它返回 135 个，其中 **83 个 `status:"Shutdown"`（已下线）**
            //   + 17 个 `Retiring`（下线中），真正在用的只有 35 个。这就是"清单又长又没用"的真正来源
            //   （比"旧日期"更本质：旧版本之所以还在，是因为它们大多已 Shutdown）。
            //   ⇒ 拉取时**只留"在用"的**：`status` 里出现 shutdown/retired/offline/deleted 一律丢掉。
            //   ⚠️ **只影响"新拉进来的"** —— 已在路由表里的条目一个字不动（你可能正在用它们，
            //      而且像 `kimi-k3` 这种"接口根本不返回"的名字更不能因为过滤而消失）。
            const isDead = (s) => /shutdown|retir|offline|deleted|deprecat/i.test(String(s ?? ''))
            const alive = []
            const droppedDead = []      // Shutdown / Retired / Deleted：已经调不了了
            const droppedRetiring = []  // Retiring：**还能调但正在下线** —— 也滤掉（你要的是"用了不会失败的清单"），但要如实说清
            for (const m of rows) {
              const id = String(m?.id ?? m?.name ?? m ?? '')
              if (!id) continue
              const st = (m && typeof m === 'object') ? m.status : null
              if (isDead(st)) {
                if (/retir/i.test(String(st))) droppedRetiring.push(id)
                else droppedDead.push(id)
                continue
              }
              alive.push(id)
            }
            hit = {
              scheme: k,
              ids: [...new Set(alive)].slice(0, 500),
              droppedDead: droppedDead.length,
              droppedRetiring: droppedRetiring.length,
              droppedSample: droppedDead.concat(droppedRetiring).slice(0, 4)
            }
            break
          }
        } catch (e) { tried.push(k + ':' + String(e?.name ?? 'err')) }
      }
      if (!hit) {
        return { ok: false, error: '拉不到模型清单：' + url + '\n　两种认证头都试过 → ' + tried.join('、') + '\n　（401=钥匙不对；404=网址不对；连不上=网络/地址问题）' }
      }
      const ids = hit.ids
      if (!ids.length) return { ok: false, error: '接口通了（' + hit.scheme + '）但清单是空的：' + url }
      // 写进路由表：**只合并新 id，绝不复活已剔除的**（用户主动剔掉的不该被拉取又带回来）
      const rt = join(WORKSPACE, '_unattended', '_coder路由表.json')
      const j = readJson(rt, null)
      if (!j) return { ok: false, error: '读不到路由表：' + rt }
      // ★ 2026-10-10 修（用户实测："模型列表还是没出来"，底部报 `这家不在路由表里，写不进去：u2`）：
      //   只**声明在档案里**的家（u2 / opencode-go 就是）**不在路由表里** ⇒ 以前直接放弃，
      //   于是"拉到了清单却写不进去"，界面自然画不出东西。
      //   现在自动**补建一条**（字段先从档案现读，缺两样就不猜、照实报）。
      let created = false
      if (!j[name]) {
        const pv = discoverProfileProviders()[name] ?? {}
        const miss = [!p.baseURL && 'baseURL', !p.apiKeyEnv && 'apiKeyEnv'].filter(Boolean)
        if (miss.length) {
          return {
            ok: false,
            error: '这家**只声明在档案里、还没进路由表**，而档案里也缺 ' + miss.join(' / ') +
              ' ⇒ 补建不了。请在下面「＋ 添加」里填**同名** + 网址，一次补全。'
          }
        }
        try { writeFileSync(rt + '.bak-fetchmodels-' + Date.now(), readFileSync(rt)) } catch {}
        j[name] = {
          说明: '（由「获取模型」补建 —— 原来只声明在档案里）',
          api: p.api ?? pv.api ?? 'openai-completions',
          baseURL: p.baseURL,
          apiKeyEnv: p.apiKeyEnv, envField: p.apiKeyEnv,
          models: []
        }
        created = true
      }
      try { writeFileSync(rt + '.bak-fetchmodels-' + Date.now(), readFileSync(rt)) } catch {}
      const cur = j[name].models
      const arr = Array.isArray(cur) ? cur : Object.keys(cur ?? {}).map(id => ({ id }))
      const has = new Set(arr.map(m => String(m?.id ?? m)))
      let added = 0
      // ★ 2026-10-10（用户口径，opt-in）：**新拉进来的默认"不选"**（`keep:false`）。
      //   为什么：有的家清单上百个，"一个个剔除"根本没法用 ⇒ 改成"默认全不选、自己勾要的"。
      //   ⚠️ **已存在的条目一律不动** —— 所以升级后你之前选好的、以及旧数据（没写 keep）都不会掉。
      for (const id of ids) if (!has.has(id)) { arr.push({ id, keep: false }); has.add(id); added++ }
      j[name].models = arr
      writeFileSync(rt, JSON.stringify(j, null, 2), 'utf8')
      const kept = arr.filter(m => (m && typeof m === 'object') ? m.keep !== false : true).length
      const unkeptN = arr.filter(m => m && typeof m === 'object' && m.keep === false).length
      return {
        ok: true, name, models: ids, added,
        output: '已从接口拿到 **' + ids.length + ' 个**可用模型（用 ' + hit.scheme + ' 认证）' +
          ((hit.droppedDead || hit.droppedRetiring)
            ? '，**已滤掉 ' + (hit.droppedDead + hit.droppedRetiring) + ' 个**' +
              '（' + hit.droppedDead + ' 个已下线' + (hit.droppedRetiring ? ' + ' + hit.droppedRetiring + ' 个下线中' : '') + '；' +
              hit.droppedSample.join('、') + '）'
            : '') +
          ' · 新增 ' + added +
          ' · 这家**已选 ' + kept + ' 个**' + (unkeptN ? '、未选 ' + unkeptN + ' 个' : '') +
          (created ? '　·　✅ 它原来**只声明在档案里**，已顺手**补建进路由表**（有备份）' : '') +
          '　—— 用**搜索框**缩小范围，再点「全选匹配」批量勾上（零 token，只是改声明）',
        view: listView()
      }
    }
    // ★ 选中 / 取消某个模型：**只打标记不删记录** —— 删了下次「获取模型」又会拉回来。
    //   全库的模型清单都经 `discoverProviders()` → `readRoutingTable()`（那一处过滤 `keep === false`），
    //   所以这里打标记 = 「职位模型」下拉、切换链、探测链**全都不再出现它**。
    case 'modelKeep': {
      const { name, model, keep } = payload
      if (!name || !model) return { ok: false, error: '缺参数：name / model' }
      const rt = join(WORKSPACE, '_unattended', '_coder路由表.json')
      const j = readJson(rt, null)
      if (!j || !j[name]) return { ok: false, error: '这家不在路由表里：' + name }
      const arr = Array.isArray(j[name].models) ? j[name].models : []
      const want = String(model)
      let hit = null
      for (const m of arr) {
        const id = String(m?.id ?? m)
        if (id === want) { hit = m; break }
      }
      if (hit === null) {
        // 记录里是裸字符串 `"glm-5.3"` 这种 → 升级成对象才能打标记
        const idx = arr.findIndex(m => String(m) === want)
        if (idx < 0) return { ok: false, error: '这家没有这个模型：' + want }
        arr[idx] = { id: want }
        hit = arr[idx]
      } else if (typeof hit === 'string') {
        const idx = arr.indexOf(hit)
        arr[idx] = { id: want }
        hit = arr[idx]
      }
      try { writeFileSync(rt + '.bak-modelkeep-' + Date.now(), readFileSync(rt)) } catch {}
      if (keep === false) { hit.keep = false; hit.unkeptAt = new Date().toISOString() }
      else { hit.keep = true; delete hit.unkeptAt }
      j[name].models = arr
      writeFileSync(rt, JSON.stringify(j, null, 2), 'utf8')
      const kept = arr.filter(m => (m && typeof m === 'object') ? m.keep !== false : true).length
      return {
        ok: true, name, model: want, keep: keep !== false,
        kept, total: arr.length,
        output: (keep === false ? '已**取消选中** ' : '已**选中** ') + '`' + want + '`（这家已选 ' + kept + '/' + arr.length + '）'
          + '　·　想撤销：再点一次同一个模型；或把路由表那条的 `keep` 改掉',
        view: listView()
      }
    }
    // ★ 2026-10-10（用户要求："有的 api 列表模型太多了，实在没办法一个一个剔除…加一个搜索框可以快速选"）：
    //   **批量选中/取消** —— 按"名字包含 match 的"（`match` 留空 = 全部）。
    //   这是 opt-in 工作流的核心：搜 `glm` → 点「全选匹配」→ 一次勾上一族。
    case 'modelBulk': {
      const { name, match, keep } = payload
      if (!name) return { ok: false, error: '缺参数：name' }
      const rt = join(WORKSPACE, '_unattended', '_coder路由表.json')
      const j = readJson(rt, null)
      if (!j || !j[name]) return { ok: false, error: '这家不在路由表里：' + name }
      const arr = Array.isArray(j[name].models) ? j[name].models : []
      const raw = match == null ? '' : String(match).trim()
      const hit = (id) => !raw || String(id).indexOf(raw) !== -1
      try { writeFileSync(rt + '.bak-modelbulk-' + Date.now(), readFileSync(rt)) } catch {}
      let n = 0
      for (let i = 0; i < arr.length; i++) {
        const m = arr[i]
        const id = String(m && typeof m === 'object' ? m.id : m)
        if (!hit(id)) continue
        if (!m || typeof m !== 'object') arr[i] = { id }
        arr[i].keep = keep === false ? false : true
        if (keep === false) arr[i].unkeptAt = new Date().toISOString()
        else delete arr[i].unkeptAt
        n++
      }
      j[name].models = arr
      writeFileSync(rt, JSON.stringify(j, null, 2), 'utf8')
      const kept = arr.filter(m => (m && typeof m === 'object') ? m.keep !== false : true).length
      return {
        ok: true, name, match: raw, keep: keep !== false, touched: n, kept, total: arr.length,
        output: (keep === false ? '已**取消选中** ' : '已**选中** ') + n + ' 个' +
          (raw ? '（名字含 `' + raw + '`）' : '（全部）') +
          '　·　这家已选 **' + kept + '/' + arr.length + '**',
        view: listView()
      }
    }
    // ★ 2026-10-05 新增：**加别的厂商**（协议 P1：供应商靠"声明"，不写死）
    //   写进路由表 `_coder路由表.json`（先备份）→ 面板立刻出现那一行、可以填钥匙。
    case 'addProvider': {
      const { name, baseURL, apiKeyEnv, models } = payload
      const r = addProvider({ name, baseURL, apiKeyEnv, models: typeof models === 'string' ? models.split(/[,，\s]+/) : models })
      if (!r.ok) return { ok: false, error: r.error }
      // ★ 2026-10-16（用户："别我在看板上加一个 API，分级就不能选档位了"）：**加 API 时顺手登记一条档位能力声明**。
      //   口径＝`default: 'standard'`（DSH 对推理模型的默认五档），并逐模型写一份；**已有的不覆盖**（你手填的精确声明优先）。
      //   这样新家从第一天起就能选三档；`_档位对账` 也只把它记成"未核实·黄"，不会拦起飞。
      let declNote = ''
      try {
        const ms = typeof models === 'string' ? models.split(/[,，\s]+/).filter(Boolean) : (models ?? [])
        const d = ensureDecl(String(name), { models: ms })
        declNote = d.wrote ? '　·　📝 已顺手登记档位能力（default: standard，可在 `_crew\\档位声明.json` 改精确值）' : ''
      } catch (e) { declNote = '　·　⚠️ 档位能力登记失败（不影响加 API）：' + String(e?.message ?? e).slice(0, 80) }
      return { ok: true, output: `已添加「${name}」${declNote}`, view: listView() }
    }
    case 'rmProvider': {
      const r = removeProvider(payload.name)
      return r.ok ? { ok: true, view: listView() } : { ok: false, error: r.error }
    }
    default: return { ok: false, error: '未知操作：' + op + '（可用：list / set / rm / priority / check / reset）' }
  }
}

// ---------------------------------------------------------------- CLI（自测用；被 import 时不执行）
const IS_MAIN = (() => { const e = process.argv[1]; if (!e) return false; try { return e.replace(/\\/g, '/').toLowerCase().endsWith('/额度面板.mjs') } catch { return false } })()
if (IS_MAIN) {
  const [op, a, b, c] = process.argv.slice(2)
  const payload = op === 'set' ? { provider: a, label: b, key: c === '-' ? readFileSync(0, 'utf8').trim() : c }
    : op === 'rm' ? { provider: a, label: b }
      : op === 'priority' ? { provider: a, order: String(b ?? '').split(',').filter(Boolean) }
        : op === 'check' ? { provider: a } : {}
  const r = await handle(op ?? 'list', payload)
  const out = ((op ?? 'list') === 'list' && r.view) ? r.view : r     // CLI 里 list 直接看数据，不套一层
  if (!process.argv.includes('--json') && op === 'check') console.log(r.output)
  else console.log(JSON.stringify(out, null, 2))
}