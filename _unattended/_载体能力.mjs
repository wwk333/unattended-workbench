/**
 * 载体能力表 —— **一个载体到底能用哪些模型**（2026-10-07「治本」件）。
 *
 * 为什么要有它：面板的模型清单是"各家声明的模型的**并集**"，但 ——
 *   **能选到 ≠ 这个载体能用**。每个载体的网关来源不同：
 *   · `pi`        → **档案** `cordis.patch.yml` 的 `llm-pi-ai.providers.*`
 *   · `messenger` → **路由表** `_coder路由表.json` 的 route（DSH headless 专用口）
 *   · `opencode`  → 它自己的 `config\opencode\opencode.json`
 *   · `codebuddy` → **它自己的 `models.json`**（一条模型一个 url；由「同步载体模型」按 ② 的已选写进去），模型名只认它自己那套 `custom-local:*`
 *   · `qoder`     → 自己的登录态 `~/.qoder-cn`，模型只认 `--list-models` 那 25 个（自定义条目**要按 UUID 的 modelID 选**）
 *   · `qwencode`  → **它自己的 `settings.json` 的 `modelProviders`**（由「同步载体模型」按 ② 的已选写进去；支持 `customHeaders`）⇒ ② 里勾的家都能用、模型写**裸名**（无前缀）
 *   ⇒ 实测踩到：给 Qoder 的急救选了 `ark/deepseek-v4.1-flash`（火山的名字）—— **一派就废**，而且面板不报错。
 *
 * 口径：**能列全的就列全**（pi / messenger / opencode / qoder）；
 *       **列不全的就说清并只许自由填**（codebuddy），**绝不假装清单是全的**。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { AGENTS, NODE_BIN, WORKSPACE } from './_agents-config.mjs'
import { discoverProviders, discoverProfileProviders, resolveKey } from './额度钥匙.mjs'
// ★ 2026-10-12（b37）：**"Pi 能用哪些家"要问 Pi 自己** —— 那两个函数在 `同步载体模型.mjs` 里
//   （`piListModels` 跑一次 `--list-models`；`selection` 是 ② 的已选）。它是 ESM、且**不反向 import 本模块** ⇒ 无环。
import { piListModels, piSelection, piHomeForCarrier, ownEntries } from './同步载体模型.mjs'
// ★ 2026-10-12：「这家在这个载体上叫什么」＝**唯一实现**（`_家名.mjs`）。面板写配置与这里校验必须同一口径。
import { carrierNameOf, canonOfCarrierName } from './_家名.mjs'

export const NATIVE_CACHE = join(WORKSPACE, '_unattended', '_载体模型表.json')
const TTL_MS = 12 * 3600 * 1000

/**
 * 模型名的**语义备注** —— ★ 2026-10-07 **用户亲口说明**，只记他说的与实测到的，不猜。
 *
 * ⚠️⚠️ **必须按载体分开记，绝不能跨家套用** —— 用户原话：
 *   「qoder 虽然没有 V4.1，但是实际上 **V4flash 就是 V4.1flash**，因为它会自动路由到 V4.1flash；
 *     但是**有的 api，他 V4 就是 V4，不是 V4.1**」
 *   ⇒ 同一个字样在不同家**可能指不同的模型**；同名同义这种事**只对具体那一家成立**。
 *   所以这张表的结构是 `{ 载体: { 模型名: {short, long} } }`，**没有全局别名规则**。
 */
export const MODEL_NOTES = {
  qoder: {
    'DeepSeek-Flash': {
      short: '会自动路由到 V4.1-Flash',
      long: 'Qoder 会把 `DeepSeek-Flash` **自动路由到 DeepSeek-V4.1-Flash** ⇒ 它清单里没有"V4.1"这个名字也能用到 V4.1。（★ 用户 2026-10-07 亲口说明；⚠️ **别的家不要照套** —— 它们的 V4 就是 V4，不是 V4.1）'
    },
    'DeepSeek-V4.1-Flash': {
      short: '自定义条目（按 UUID 传）',
      long: '这是 Qoder 的**自定义条目**（实际按 UUID 的 modelID 传）。它与上面那个"自动路由的 `DeepSeek-Flash`"是**两个不同入口** —— 用哪个由你定（要不要只留一条，也由你定）。'
    }
  }
  // 其它载体：**故意留空** —— 没有实测/用户口径支撑的同义关系，就不写（宁缺勿猜）
}

export function loadNativeCache () { try { return JSON.parse(readFileSync(NATIVE_CACHE, 'utf8')) } catch { return {} } }

/** 跑一次 Qoder 的 `--list-models`（**零成本元数据**，不发对话请求），解析成 [{label,value,custom}]。
 *  `value` 才是要传给 `-m` 的东西：**具名条目=名字本身；自定义条目=它的 UUID（modelID）**。 */
export function fetchQoderModels (timeoutMs = 25_000) {
  let cfg
  try { cfg = JSON.parse(readFileSync(join(WORKSPACE, '_crew', 'agents.json'), 'utf8')) } catch { return null }
  const entry = cfg?.agents?.qoder?.entry
  if (!entry) return null
  const real = String(entry).replace(/\$\{AGENTS\}/g, AGENTS).replace(/\$\{NODE\}/g, NODE_BIN)
  if (!existsSync(real)) return null
  let out = ''
  try {
    out = execFileSync(NODE_BIN, [real, '--list-models'], { encoding: 'utf8', timeout: timeoutMs, env: { ...process.env, CI: '' } })
  } catch (e) { out = String(e?.stdout ?? '') }
  const models = []
  for (const raw of String(out).split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || /^MODEL$/i.test(line)) continue
    const m = line.match(/^(.*?)\s*\(([0-9a-fA-F-]{8,})\)$/)          // 自定义条目：名字 (UUID)
    if (m) models.push({ label: m[1].trim(), value: m[2].trim(), custom: true })
    else models.push({ label: line, value: line, custom: false })
  }
  return models.length ? models : null
}

/** 保证缓存新鲜（默认 12h 内不重复跑 CLI）。force=true 时强制刷新。 */
export function ensureNative (force = false) {
  const c = loadNativeCache()
  const q = c.qoder
  if (!force && q && Date.parse(q.at) && Date.now() - Date.parse(q.at) < TTL_MS && Array.isArray(q.models) && q.models.length) return c
  const models = fetchQoderModels()
  if (models) {
    c.qoder = { at: new Date().toISOString(), models }
    try { writeFileSync(NATIVE_CACHE, JSON.stringify(c, null, 2), 'utf8') } catch {}
  }
  return c
}

/** OpenCode 声明的家（读它自己的配置；读不到返回 null —— **不假装**） */
export function opencodeProviders () {
  try {
    const cfg = JSON.parse(readFileSync(join(WORKSPACE, '_crew', 'agents.json'), 'utf8'))
    const p = String(cfg?.agents?.opencode?.env?.OPENCODE_CONFIG ?? '').replace(/\$\{AGENTS\}/g, AGENTS)
    if (!p || !existsSync(p)) return null
    const j = JSON.parse(readFileSync(p, 'utf8'))
    const keys = Object.keys(j.provider ?? j.providers ?? {})
    return keys.length ? keys : null
  } catch { return null }
}

/**
 * ★★ 2026-10-12（b37 · 用户口径："我需要 pi 的模型选择下拉要和班组看板同步，其他的载体也是"）——
 *   **Pi 能用哪些家，问 Pi 自己**（`pi --list-models`），不再拿 DSH 档案当它的清单。
 *
 * 实测（2026-10-12）：Pi **自带** `xiaomi`(6) / `xiaomi-token-plan-cn`(4) / `qwen-token-plan-cn`(20)；
 *   **不认识** `ark` / `SiliconFlow` / `ocgo` / `u2` —— 而档案里声明着 `ark`/`u2`（那是给 DSH 桌面端看的）
 *   ⇒ 以前面板给 coder-a 摆的是**假选项**（账本 47 次里 ark 0 次、u2 0 次，正好印证）。
 * `--list-models` **按钥匙过滤**（没钥匙的家不列）⇒ 这里先把 ② 里那些家的钥匙按 `apiKeyEnv` 注入再问，
 *   拿到的就是"**它现在真能用的全部**"（② 里勾的模型由 `同步载体模型.mjs` 写进它的 `models.json`）。
 * 问不到 Pi 就返回 `null` ⇒ 调用方**回落档案**（零影响）。12 小时缓存（与 Qoder 那份共用一个缓存文件）。
 */
export function fetchPiHomes (force = false) {
  const c = loadNativeCache()
  const hit = c.pi
  if (!force && hit && Date.parse(hit.at) && Date.now() - Date.parse(hit.at) < TTL_MS && hit.homes && Object.keys(hit.homes).length) return hit.homes
  let homes = null
  try {
    const env = {}
    for (const h of piSelection()) {
      const keyEnv = piHomeForCarrier(h).keyEnv
      const k = resolveKey(h.canon, 0, undefined, undefined, discoverProviders())
      if (keyEnv && k?.key) env[keyEnv] = k.key
    }
    const r = piListModels(env)
    if (r.ok && Object.keys(r.homes).length) homes = r.homes
  } catch { /* 问不到就算了（回落档案） */ }
  if (homes) {
    c.pi = { at: new Date().toISOString(), homes }
    try { writeFileSync(NATIVE_CACHE, JSON.stringify(c, null, 2), 'utf8') } catch {}
  }
  return homes
}

/** 同步进 Pi 的清单之后**必须清掉这份缓存**，否则下拉还是旧的（"我明明勾了，怎么还没出现"）。 */
export function forgetPiHomes () {
  try {
    const c = loadNativeCache()
    if (c.pi) { delete c.pi; writeFileSync(NATIVE_CACHE, JSON.stringify(c, null, 2), 'utf8') }
  } catch {}
}
function reachOf (allowed, agentId) {
  if (!Array.isArray(allowed) || !allowed.length) return []
  const out = []
  const seen = new Set()
  for (const n of allowed) {
    const canon = canonOfCarrierName(n, agentId)
    if (seen.has(canon)) continue
    seen.add(canon)
    out.push({ canon, name: carrierNameOf(canon, agentId) })
  }
  return out
}
const withReach = (cap, agentId) => (cap.mode === 'providers' ? { ...cap, reach: reachOf(cap.allowed, agentId) } : cap)

/**
 * ★ b39：**② 里勾选的模型名**（全部家的并集）。
 *   为什么要有它：`prefixed` 模式（CodeBuddy / Qwen Code）现在读"载体自己的清单"当真相，
 *   而那份清单是**合并**出来的（它手写的老条目留着）⇒ 直接拿去当候选会把**② 里没勾的**也摆出来
 *   （实测：rescue 候选 13 个 > ② 已选 12 个，其中 `deepseek-v4-pro` 是它配置里的老条目）。
 *   口径不变：**候选 = ② 已选 ∩ 这个载体够得着的**。
 */
/**
 * ★ b42：**这个载体被环境变量钉死在哪一家**（从 `_crew\agents.json` 的 `env` 里认 baseURL，
 *   再按路由表反查权威名）。用于"端点是钉死的"载体（目前＝Qwen Code 的 `OPENAI_BASE_URL`）：
 *   它们**只有那一家真能用**，主选就不该摆别家的模型（摆了就是假可用）。
 */
export function pinnedCanonOf (agent) {
  try {
    const cfg = JSON.parse(readFileSync(process.env.DSH_AGENTS_CONFIG ?? join(WORKSPACE, '_crew', 'agents.json'), 'utf8').replace(/^\uFEFF/, ''))
    const env = cfg?.agents?.[agent]?.env ?? {}
    const norms = Object.entries(env)
      .filter(([k]) => /BASE_?URL$/i.test(k))
      .map(([, v]) => String(v).replace(/\$\{[^}]+\}/g, '').replace(/\/+$/, '').toLowerCase())
      .filter(Boolean)
    const provs = discoverProviders()
    for (const [canon, v] of Object.entries(provs)) {
      const u = String(v.baseURL ?? '').replace(/\/+$/, '').toLowerCase()
      if (u && norms.some((n) => u === n || u.startsWith(n) || n.startsWith(u))) return canon
    }
  } catch { /* 认不出来就返回 null（调用方回落"全列"） */ }
  return null
}

function selectedBares () {
  const s = new Set()
  try { for (const h of piSelection()) for (const m of (h.models ?? [])) s.add(m) } catch {}
  return s
}

/** 这个载体的能力：`mode` = providers（按家过滤）/ native（它自己的清单）/ free（只能自由填） */
export function capabilityFor (agentId) {
  const prof = Object.keys(discoverProfileProviders())
  const route = Object.keys(discoverProviders())
  if (agentId === 'pi') {
    // ★ 2026-10-12（b37）：**问 Pi 自己**（它自带谁、② 里勾的又同步进去了谁）⇒ 下拉/校验/看板同一份。
    //   问不到（没装/超时）才回落档案 —— 回落时 how 里如实写"这是档案、不是 Pi 自己的清单"。
    const pi = fetchPiHomes(false)
    if (pi) {
      return withReach({
        mode: 'providers', allowed: Object.keys(pi), piModels: pi,
        how: 'Pi 自己的 `pi --list-models`（实测它只认这些家；② 里勾的模型由「同步载体模型」写进它的 `~/.pi/agent/models.json`）'
      }, agentId)
    }
    return withReach({ mode: 'providers', allowed: prof, how: '⚠️ 问不到 Pi 自己的清单（回落档案 `cordis.patch.yml`）—— 这份是**给 DSH 桌面端看的**，Pi 可能不认其中某些家' }, agentId)
  }
  if (agentId === 'messenger') return withReach({ mode: 'providers', allowed: route, how: 'DSH headless（调研员）走**路由表** `_coder路由表.json` 的 route' }, agentId)
  if (agentId === 'opencode') { const oc = opencodeProviders(); return withReach({ mode: 'providers', allowed: oc, how: oc ? 'OpenCode 走它自己的 `config\\opencode\\opencode.json`（已声明：' + oc.join('、') + '）' : 'OpenCode 的 provider 配置**读不到**（找不到或没声明）' }, agentId) }
  if (agentId === 'codebuddy') {
    // ★ 2026-10-12（b39）：**真相＝它自己的 `models.json`**（一条模型一个 url，由「同步载体模型」按 ② 的已选写进去）。
    //   以前这里**写死"火山 ark 那批"** ⇒ 同步进它清单的其它家（ocgo / SiliconFlow / xiaomi / u2）**下拉里根本不给选**。
    const mine = ownEntries('codebuddy').filter((x) => selectedBares().has(x.bare))
    if (mine.length) return { mode: 'prefixed', prefix: 'custom-local:', base: mine.map((x) => x.bare), entries: mine, how: 'CodeBuddy 走它自己的 `models.json`（一条模型一个 url；由「同步载体模型」按 ② 的已选同步进去）' }
    const arks = (discoverProviders().ark?.models) ?? []
    return { mode: 'prefixed', prefix: 'custom-local:', base: arks, how: '⚠️ 读不到它自己的 `models.json` ⇒ **暂时**按火山（ark）那批列；去 ② 勾一下模型会自动同步清单' }
  }
  // ★ 2026-10-07 的旧结论（"CodeBuddy 只能吃火山 ark 那批"）**已在 b39 作废**：
  //   真跑实验证明它的 `models.json` 是"一条模型一个 url"、`CODEBUDDY_BASE_URL` 不覆盖 per-model url
  //   ⇒ 上面那段改成"读它自己的清单"。历史注释留在 `同步载体模型.mjs` 的对应段里备查。
  if (agentId === 'qoder') { const c = loadNativeCache(); return { mode: 'native', models: c.qoder?.models ?? null, notes: MODEL_NOTES.qoder ?? null, how: 'Qoder 用**自己的登录态**（`~/.qoder-cn`），模型只认它 `--list-models` 里那些（自定义条目要按 modelID 选）' } }
  if (agentId === 'qwencode') {
    // ★ b42（用户口径："qwencode 应该说的是这个载体，为什么还能选其他的 API 模型？"）——
    //   b40/b41 我把它标成"不支持自定义 API"却**照样把别家的模型摆进主选** ⇒ 那是**我自己造的假可用**。
    //   **真跑量的边界**（2026-10-12）：rescue → `zai-org/GLM-5.3-Flash`(SiliconFlow) **401**、
    //   `mimo-v2.6-flash`(xiaomi) **401 Invalid API Key**、`deepseek-v4-pro`(ark) **✅**（账本 4 次实跑也是它）。
    //   ⇒ 它的端点是**环境变量钉死**的（`OPENAI_BASE_URL`＝火山 ark）⇒ **只有那一家真能用**。
    //   ⇒ 主选只列**那一家**的模型；别家的如实进 `missing`（"够不着"），不装作能选。
    // ★ b43（**推翻 b42**）：b42 我因为它选别家一直 401 就"只留钉死那一家"——**那个结论是错的**。
    //   401 的真因是**我们自己没喂钥匙**：它 `settings.json` 里每条路由从 `process.env[envKey]` 读
    //   （`SILICONFLOW_API_KEY` / `XIAOMI_API_KEY`…），而派活时 `envFor` 只注入了钉死那家的 `OPENAI_API_KEY`。
    //   修掉之后**真跑验过**：`zai-org/GLM-5.3-Flash`(SiliconFlow) ✅、`mimo-v2.6-flash`(xiaomi) ✅。
    //   ⇒ 它**能用别家**；**唯一真用不了的是"要求自定义请求头"的家**（ocgo：它的 `ModelConfig` 带不了头，必 400）
    //   —— 所以这里只按 `headers` 排除，不再按"钉死哪一家"排除。
    // ★★ b44（**再次推翻我自己**，用户直觉对）：Qwen Code 的 `modelProviders` **支持自定义请求头** ——
    //   官方 schema `generationConfig.customHeaders`（`docs/configuration/model-providers.md` 有例子）。
    //   上一版我只看 schema 摘要、没看全文档，就断言"它带不了头"⇒ 跳过 ocgo、还把它标成"换不了家"——**全错**。
    //   现在同步里写 `generationConfig.customHeaders`，**真跑验过**：rescue → `step-5-preview-free`(ocgo) ✅、
    //   `longcat-2.5-preview-free`(ocgo) ✅、`zai-org/GLM-5.3-Flash`(SiliconFlow) ✅、`mimo-v2.6-flash`(xiaomi) ✅。
    //   ⇒ 不再排除任何家；`customApi` 也不再置 false（那是我误判的产物）。
    const own = ownEntries('qwencode')
    return {
      mode: 'prefixed', prefix: '', base: own.map((x) => x.bare), entries: own,
      customApi: true,
      how: own.length
        ? 'Qwen Code 走它自己的 `settings.json` 的 `modelProviders`（每模型可绑各自 `baseUrl`、要的头写 `generationConfig.customHeaders`；钥匙按它写的 `envKey` 喂）——**写裸名**'
        : '⚠️ 读不到它的 `modelProviders` ⇒ 去 ② 勾一下模型会自动同步清单'
    }
  }
  return { mode: 'free', how: '这个载体的模型来源我还不知道 ⇒ 只能自由填，填前请自己确认它能认' }
}

/** 校验：这个模型能不能给这个载体用。返回 { ok, why?, warn? } */
export function checkModel (agentId, model) {
  const cap = capabilityFor(agentId)
  const s = String(model)
  const prov = s.includes('/') ? s.split('/')[0] : (s.includes(':') ? s.split(':')[0] : null)
  if (cap.mode === 'providers') {
    if (!cap.allowed || !cap.allowed.length) return { ok: false, why: cap.how + ' —— **读不到清单**，不敢替你写' }
    if (!prov) return { ok: false, why: `这个载体要**带供应商前缀**（例：\`${(cap.reach?.[0]?.name) || cap.allowed[0]}/<模型>\`）；「${s}」没有前缀，它不知道该走哪家。${cap.how}` }
    // ★ 2026-10-12 修（用户报障："选不了模型，选了也没用"）——
    //   认的必须是**这个载体自己认的写法**（`perCarrier` 优先），而不是路由表里的权威名。
    //   实测两种错都在这里出生：
    //     ① Pi 上小米那家叫 `xiaomi-token-plan-cn`（套餐口）⇒ 以前把**当前真值**判成"它不认识"，
    //        于是**下拉里没有一条能一次点选成功**；
    //     ② 反过来，`xiaomi`（按量计费口）在 Pi 的档案里**确实声明着** ⇒ 以前放行，
    //        写进去就是 401（我们手上是套餐钥匙）。现在**只认载体自己那个名字**。
    const accepted = new Map()                       // **载体自己认的名字** → 权威名
    for (const n of (cap.reach ?? [])) accepted.set(n.name, n.canon)
    if (!accepted.has(prov)) {
      const right = (cap.reach ?? []).filter((x) => x.canon === canonOfCarrierName(prov, agentId)).map((x) => x.name)[0]
      return {
        ok: false,
        why: `${cap.how}，里面**没有「${prov}」** ⇒ 这个载体不认识它。` +
          (right ? `（这家在它上面叫 \`${right}\`，用它）` : '') +
          `已声明的家：${cap.allowed.join('、')}`
      }
    }
    // ★ b37：Pi 那份是**它自己的清单** ⇒ 模型名也顺手核一下（没有就警告：先去 ② 勾上、同步一下就进去了）
    if (cap.piModels) {
      const list = cap.piModels[prov] ?? []
      const bare = s.slice(String(prov).length + 1)
      if (list.length && !list.includes(bare)) return { ok: true, warn: `Pi 自己的清单里现在**没有「${bare}」** —— 去 ② 把它勾上（面板会自动同步进 Pi 的 models.json）` }
    }
    return { ok: true }
  }
  if (cap.mode === 'native') {
    if (!cap.models || !cap.models.length) return { ok: true, warn: '我**没抓到**它自家的清单 ⇒ 放行，但请自己确认这个名字它认' }
    const hit = cap.models.find(m => m.value === s || m.label === s)
    if (hit) return { ok: true, warn: hit.custom ? `这是**自定义条目**，实际会按 modelID（${hit.value.slice(0, 8)}…）传给 Qoder` : undefined }
    return { ok: false, why: `Qoder 的清单里**没有「${s}」** ⇒ 它会拒绝。清单里可用的（前 8 个）：` + cap.models.slice(0, 8).map(m => m.label).join('、') }
  }
  // prefixed：**前缀是硬的、名字是软的**（只有 kimi-k3 实测过 ⇒ 不在基表里只警告，不硬拦）
  if (cap.mode === 'prefixed') {
    if (!s.startsWith(cap.prefix)) return { ok: false, why: `${cap.how} ⇒ 必须写成「${cap.prefix}<火山模型名>」；「${s}」缺前缀，它不会认` }
    const bare = s.slice(cap.prefix.length)
    if (cap.base && cap.base.length && !cap.base.includes(bare)) {
      return { ok: true, warn: `⚠️ 「${bare}」不在火山（ark）声明的模型清单里（${cap.base.join('、')}）—— **未实测**，能不能跑得你自己确认` }
    }
    return { ok: true }
  }
  // free
  if (cap.native && !s.startsWith(cap.native)) return { ok: false, why: `${cap.how} ⇒ 应该是「${cap.native}<名字>」这种形状；「${s}」不像` }
  return { ok: true, warn: cap.native ? undefined : cap.how }
}
