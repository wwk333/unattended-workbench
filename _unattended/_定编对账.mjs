#!/usr/bin/env node
/**
 * 定编对账 —— 把 `_crew\agents.json`（**配置真值**）与文档里的定编表（**文档真值**）逐项比。
 *
 * 为什么要机器比：这类漂移**不报错、只误导** —— 文档写着"reviewer 只读"，配置里换了参数，
 * 后面所有人都按文档以为它是只读的。人工核对每改一次要重看两张表，机器一秒。
 *
 * 比对范围（★ 2026-10-03 扩大）：
 *   ① 知识库 `01-架构.md` —— 定编表（唯一权威展示面）；
 *   ② `<工作台根>\文档\无人值守模式-方案.md` —— **这家的名册曾漂移过** → 一起比，防再次静默漂移。
 *   给 `--doc <路径>` 时**只比那一份**（排障 / 只改一份文档时用）。
 *
 * 用法：node _定编对账.mjs [--doc <路径>] [--json] [--fix]
 * 退出码：0 全对；1 有**硬**漂移（载体/档位/关键参数 —— **配置为准，文档要改**）；
 *         2 只有**模型**软漂移（**不拦起飞** —— 模型由用户在看板上定，跑 `--fix` 把文档对齐即可）
 *
 * ★ 2026-10-07 分档（用户："模型是不能定死的，肯定是由我来决定的，我不能每次在看板换不同的模型，都要报错吧？"）：
 *   硬项 = 载体 / 档位 / 关键参数（权限、信任边界）——**这些漂了会骗人**，必须拦。
 *   软项 = **模型** —— 用户随时会在看板上调，拿它拦起飞是错的；只提示 + `--fix` 自动改文档。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// ★ 2026-10-18（b122 · 十三 S4）：「网关能不能自动推」的唯一出处＝`_crew\carriers.json`，走 `_载体属性.mjs` 读。
import { gatewaySourceOf } from './_载体属性.mjs'
import { KB as KB_FROM_MAP } from './_路径.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, '..')
// ⚠️ 知识库路径是**本机值**（库文档里只用占位符，真值在 `文档\本机映射表.md`）。
//    这里允许 --doc / DSH_KB_DOC 覆盖；没给就按本机默认值找。
// ★ 2026-10-27（开源开工 W2）：默认文档路径从 `_路径.mjs` 的知识库推，不再写死盘符。
const docDefault = process.env.DSH_KB_DOC ?? (KB_FROM_MAP ? join(KB_FROM_MAP, '项目：多agent协同工作台', '01-架构.md') : null)

const argv = process.argv.slice(2)
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : def }
const JSON_OUT = argv.includes('--json')
const HAS_DOC_OPT = argv.includes('--doc')
// ★ 2026-10-07 新增：`--fix` = 把文档的**模型**字面量对齐配置（见文件末尾）
const FIX = argv.includes('--fix')

// 配置真值
const cfg = JSON.parse(readFileSync(join(WORKSPACE, '_crew', 'agents.json'), 'utf8').replace(/^\uFEFF/, ''))

// 「载体显示名」对「配置里的 agent id」——文档用中文名，配置用 id，必须显式映射（否则比不了）
const CARRIER_LABEL = { pi: 'Pi', opencode: 'OpenCode', codebuddy: 'CodeBuddy', messenger: 'DSH headless', qoder: 'Qoder', qwencode: 'Qwen Code' }

// 定编表第一格的**角色写法**可能带中文别名（例：`| 急救（rescue） |`）→ 归一化后映射回配置里的角色键。
// 不做这一层的话 `rescue` 会被判成"文档里没有这个角色" = **假漂移**（表其实是对的，只是写法不同）。
const CELL_ALIAS = { 急救: 'rescue' }
const normCell = (s) => String(s).replace(/\*\*/g, '').replace(/[（(][^）)]*[）)]/g, '').trim()

/** 在**一份文档**里找每个角色的那一行并逐项比。返回 checks[] */
function checkDoc (docPath) {
  const docLines = readFileSync(docPath, 'utf8').split(/\r?\n/)
  // 文档真值：定编表每行 `| <角色> | **<载体>** | <网关> | <模型> | …`
  const docRow = {}
  for (const l of docLines) {
    const m = l.match(/^\|\s*([^|]+?)\s*\|(.*)$/)
    if (!m) continue
    const cell = normCell(m[1])
    const role = cfg.roles?.[cell] ? cell : CELL_ALIAS[cell]
    // 取**第一条**命中：定编表在正文里，后面同名的行多半是别的表（例：角色默认参数表）
    if (role && cfg.roles?.[role] && !(role in docRow)) docRow[role] = m[2]
  }

  const checks = []
  // ★ 2026-10-07（用户原话："模型是不能定死的，肯定是由我来决定的，我不能每次在看板换不同的模型，都要报错吧？"）
  //   ⇒ **把"模型"这一项从硬项降为软项**。理由：模型是用户随时会在看板上调的东西（面板就是给他调的），
  //     拿它**拦住起飞**是错的。硬项只留"**会骗人**"的那种 —— **载体 / 档位 / 关键参数（权限、信任边界）**：
  //     这些一漂，别人照文档以为它有那个能力（例：文档写 reviewer 只读、配置里已放开跑命令）。
  //   软项（模型）**仍然报**，但只算警告；`--fix` 能把文档改成与配置一致（配置永远是权威）。
  const add = (role, what, ok, detail, soft = false) => checks.push({ role, what, ok, detail, soft })

  for (const [role, v] of Object.entries(cfg.roles ?? {})) {
    const row = docRow[role]
    if (!row) { add(role, '文档里有这个角色', false, '定编表里找不到该行'); continue }
    add(role, '文档里有这个角色', true, '定编表命中')

    const label = CARRIER_LABEL[v.agent]
    add(role, `载体 = ${label ?? v.agent}`, Boolean(label) && row.includes(label), `配置 agent=${v.agent}；文档行含「${label}」=${row.includes(label)}`)

    const model = String(v.model ?? v.prefer?.model ?? '')
    const short = model.includes('/') ? model.split('/').pop() : model.replace(/^custom-local:/, '')
    add(role, `模型含 ${short}`, row.includes(short), `配置 model=${model}（**软项**：你在看板上换模型不算错，只提示；跑 \`--fix\` 自动对齐文档）`, true)

    // ★ 2026-10-06 修（三方交叉验证共同指出的"空转闸门"）：
    //   原来读 `v.effort`，而 `agents.json` 里 5 个角色的档位全在 **`prefer.effort`**（`v.effort` 恒 undefined）
    //   ⇒ 这一项**从来没比过**（"档位漂移"扫不出来）。现在两处都认，缺失才跳过。
    // ★ b72（2026-10-13）**再修一次**：`if (effort)` 仍然是**静默跳过** —— 实测把 researcher 的档位清空后
    //   总项数 **46 → 44**，少的那两项就是被悄悄跳过的。而档位是**硬项**（"会骗人"那一类）：
    //   配置既然没给档位，文档那格就**不许**还写着档位（否则读文档的人以为它跑在 max 上）。
    //   ⇒ 改成**两态都查**：有档位比档位；没档位比"文档也没写档位"。
    //   判法：文档这一行里出现 `@ <档位>` 这种写法就算"写了档位"（本库定编表就是这个约定）。
    const effort = v.effort ?? v.prefer?.effort ?? null
    if (effort) {
      add(role, `档位 = ${effort}`, row.includes(effort), `配置 effort=${effort}（来源 ${v.effort ? 'roles.effort' : 'roles.prefer.effort'}）`)
    } else {
      // ★ 2026-10-16（b87）修：**允许档位被反引号/星号包着** —— 原来 `@\s*\**\s*` 看不见 `@ \`max\``，
      //   于是"配置没给档位、文档却写着 max"这种漂移**扫不出来**（`文档\无人值守模式-方案.md` 的 researcher
      //   行就是这么漏的：它是**人眼**读出来的，不是这道闸抓的）。
      const m = /@\s*[`*\s]*(minimal|low|medium|high|xhigh|max)\b/i.exec(row)
      add(role, '档位 = 未设（配置里没给档位）', !m,
        m ? `文档写着档位「${m[1]}」，而配置里**没有档位** —— 配置为准，改文档（或把档位补回配置）` : '文档也没写档位 ✓')
    }

    const args = v.extraArgs ?? []
    for (const key of args) {
      if (!key.startsWith('--')) continue
      const pair = args[args.indexOf(key) + 1]
      const frag = pair && !pair.startsWith('--') ? `${key} ${pair}` : key
      // 只对"有语义的关键参数"硬要求文档写明（`--approve` 也要，它是信任边界）
      add(role, `关键参数 ${frag}`, row.includes(frag), `配置 extraArgs=${JSON.stringify(args)}`)
    }

    // ★ 2026-10-16（b93）新增：**逐级比对**（任务分级）。`roles.<角色>.levels` 是**可选段**：
    //   整段缺 = 这个角色**没启用分级** ⇒ 一条都不出（这就是"行为与改前一字不差"的实现方式：
    //   判断放在最前，没有 levels 的配置连循环都进不去）。级号只认 L1/L2/L3/L4。
    //   为什么**每一级各出一项**：四级可以各挂不同模型，合成一项就只能报"有级漂了"、报不出**哪一级**漂了；
    //   而派活是按级取模型的，定位不到级等于没报。
    //   分档沿用上面那条既有口径（见 L64-68 的★注释）：**模型一律软项**（用户在看板里随时会换级模型），
    //   但"级号写错"和"声明了级却没给模型"是**配置自身的坏件**（不是用户选择），派活时会当场炸 ⇒ 硬项。
    const levels = v.levels
    if (levels && typeof levels === 'object') {
      const LEVELS = ['L1', 'L2', 'L3', 'L4']
      // 不认识的级号 ⇒ **硬项**：派活按 L1..L4 取模型，写错级号＝那一级**根本取不到**（配了等于没配，还骗人）。
      for (const k of Object.keys(levels)) {
        if (!LEVELS.includes(k)) {
          add(role, `levels 里有个不认识级号 "${k}"`, false,
            `配置 levels 的键只认 ${LEVELS.join(' / ')}；写成「${k}」时派这一级取不到模型（= 配了等于没配）`)
        }
      }
      for (const lv of LEVELS) {
        if (!(lv in levels)) continue   // 没声明这一级 = 这个角色没启用它，**不是漂移**，不出项
        const lvModel = String(levels[lv]?.model ?? '')
        if (!lvModel) {
          // 声明了级、却没给 model ⇒ **硬项**：派这一级会把空模型发下去，当场报错 ⇒ 必须拦（这不是"用户的选择"）。
          add(role, `级 ${lv} 模型**没配**（声明了级却没给 model ⇒ 派这一级会当场报错）`, false,
            `配置 levels.${lv}=${JSON.stringify(levels[lv] ?? null)} 里没有 model`)
          continue
        }
        // 尾段 = 模型名按 `/` **或** `:` 切开后的最后一段（`custom-local:kimi-k3` → `kimi-k3`；
        //   为什么两种分隔符都要切：`/` 是"家/模型"，`:` 是 CodeBuddy 载体的 `custom-local:<名>` 语法，
        //   文档那一格写的是**裸尾段**，不切就问不出对。）
        const lvTail = lvModel.split(/[/:]/).pop()
        add(role, `级 ${lv} 模型含 ${lvTail}`, row.includes(lvTail),
          `配置 levels.${lv}.model=${lvModel}（**软项**：级模型由用户在看板里定，只提示）`, true)
      }
    }
  }

  // 反向：文档里有、配置里没有的角色（删角色容易忘改文档）
  // ⚠️ 2026-10-06 说明：`docRow` 是**对象**（role → 该行剩余内容），所以这里遍历它的键是对的；
  //    审计报告曾把这一段判成"死代码"，实际不是 —— 它只在"文档写了某个角色、agents.json 里没有"时才报。
  for (const role of Object.keys(docRow)) {
    if (!cfg.roles?.[role]) add(role, '配置里有这个角色（反向查）', false, '文档写了但 agents.json 里没有')
  }

  return checks
}

// 比对范围：--doc 只比那一份；否则比默认两份（第二份不存在就跳过并说明）
const EXTRA_DOCS = [join(WORKSPACE, '文档', '无人值守模式-方案.md')]
const docs = HAS_DOC_OPT
  ? [opt('doc', docDefault)]
  : [opt('doc', docDefault), ...EXTRA_DOCS.filter(existsSync)]

// 家 → 中文显示名（**只列已知的**：遇到不认识的家就**不动那一格**，宁可不改也不瞎写）
const PROVIDER_ZH = {
  ark: '火山', aliyun: '阿里', 'qwen-token-plan-cn': '阿里', xiaomi: '小米',
  SiliconFlow: '硅基流动', unisound: '云知声', u2: '云知声', qoder: 'Qoder', 'custom-local': '火山'
}
const ZH_NAMES = [...new Set(Object.values(PROVIDER_ZH))]

// ── `--fix`：把文档"定编表那一行"改成与配置一致（**先备份**）
//    口径：**配置是权威、文档是它的投影**。改两样：
//      ① **模型字面量**（软项 —— 用户随时在看板上换）
//      ② 「路由/网关」「额度来源」这类**中文叙述格里的家名**（只改"整格就是它/以它开头"，以及反引号里的家名字面量）
//    **不动**载体 / 档位 / 关键参数（硬项：那是能力边界，改错更要命），也**不动句子中间的叙述**。
//    为什么要机器改：用户会在看板上随时换模型，靠人手抄必然漏（2026-10-07 就是这么红的）。
function fixDocs (docList) {
  const changed = []
  const normCell = (s) => String(s).replace(/\*\*/g, '').replace(/[（(][^）)]*[）)]/g, '').trim()
  for (const d of docList) {
    if (!existsSync(d)) continue
    const lines = readFileSync(d, 'utf8').split(/\r?\n/)
    let hit = 0
    for (const [role, v] of Object.entries(cfg.roles ?? {})) {
      const model = String(v.model ?? v.prefer?.model ?? '')
      const short = model.includes('/') ? model.split('/').pop() : model.replace(/^custom-local:/, '')
      // ★ 2026-10-16（b87）修：**找行口径必须与 `checkDoc` 逐字一致** —— `checkDoc` 只按"第一格＝角色名"取
      //   **第一条**命中（见上面 L54-61），而这里原来多要求一个 `/\s@\s/` ⇒ 档位写成 `**@ 未设档位**` 的行
      //   （`@` 前是 `*` 不是空格）**fixer 根本找不到** ⇒ 工具打印"跑 `--fix` 自动对齐"、跑了却回"无需改动"
      //   ＝**静默不修**（实测：KB `01-架构.md` 的 researcher 行）。
      const idx = lines.findIndex(l => {
        const m = l.match(/^\|\s*([^|]+?)\s*\|(.*)$/)
        return m && (normCell(m[1]) === role || CELL_ALIAS[normCell(m[1])] === role)
      })
      if (idx < 0) continue
      const cells = lines[idx].split('|')
      // 模型格 = **「反引号字面量 ＋ 紧跟档位标记 `@`」的那一格**
      //   ★b87：原来要求 `/\s@\s/`，漏掉 `**@ 未设档位**` 这种写法；但**不能**放宽成"含 @ 且有反引号"——
      //   实测会把 coder-a 的**载体格**（`**Pi**（\`<载体>\node_modules\@earendil-works\pi-coding-agent\`）`
      //   里的 `@earendil-works` 当成档位标记）误判成模型格，**把载体格里的路径替换成模型名**（当场改坏一行，已还原）。
      //   判据钉死：**反引号字面量之后（允许空格/星号）必须紧跟 `@`** —— 载体格的路径后面是 `）`，不会命中。
      const ci = cells.findIndex(c => /`[^`]+`\s*[*\s]*@/.test(c))
      if (ci < 0) continue
      const mt = cells[ci].match(/`([^`]+)`/)
      if (mt) {
        const old = mt[1]
        // 保留每份文档自己的写法（带不带供应商前缀）—— 但 **`家:模型` 这种不能省**：
        // `custom-local:kimi-k3` 里的 `custom-local:` 不是"供应商前缀"（那栏本来就另列了"火山"），
        // 而是 **CodeBuddy 载体语法的一部分**（它自己的 `models.json` 里一条模型一个 url；
        // ★ 2026-10-13 更正：旧话"端点被 `CODEBUDDY_BASE_URL` 钉死在火山"**已作废**，见 b39/b43）——
        // 省成裸 `kimi-k3` 会让读到的人照着写错（载体不认）。★ 2026-10-07 修。
        const want = model.includes(':') ? model : ((old.includes('/') || old.includes(':')) ? model : short)
        if (old !== want) {
          cells[ci] = cells[ci].replace('`' + old + '`', '`' + want + '`')
          changed.push(d.split(/[\\/]/).pop() + ' · ' + role + ' 模型：' + old + ' → ' + want)
          hit++
        }
      }
      // ② 「路由/网关」与「额度来源」这类**中文叙述格**也跟着换（★ 2026-10-07 加）
      //    口径：**只改"整格就是这个家名 / 以它开头"的格**（例：`阿里`、`阿里 token plan（…）`），
      //    以及格里**反引号包着的家名字面量**（例：`qwen-token-plan-cn`）；
      //    **句子中间提到某家**的叙述一律不碰（那种改了容易误伤别的意思）。
      //    ⚠️ **只对"网关能从模型/路由推出来"的载体做**：`pi` / `opencode`（按 provider 前缀）、
      //    `messenger`（按 `route`）。**`qoder` / `codebuddy` 不做** —— 它们的模型来自**自己的 CLI / 订阅**
      //    （Qoder 只认它自己那十几个具名模型；CodeBuddy 用 `custom-local:*`），
      //    光看模型前缀会把网关推错（我第一版就把 rescue 的 `Qoder` 误改成了 `火山`，已回滚）。
      // ★ 2026-10-18（b122 · 十三 S4）：**改读声明** —— 原来是 `GW_FROM_MODEL = new Set([...])` 硬编码名单
      //   ＋ 行内再判一次 `v.agent === 'messenger'`；现在统一走 `gatewaySourceOf()`：
      //     `model` ⇒ 按模型前缀推 · `route` ⇒ 按角色上的 route · `own` ⇒ **不许推**（下面打印为什么不动）。
      const gws = gatewaySourceOf(v.agent)
      const gwKey = gws === 'route' ? (v.route ?? null) : (gws === 'model' && model.includes('/') ? model.split('/')[0] : null)
      const gwZh = gwKey ? (PROVIDER_ZH[gwKey] ?? null) : null
      if (gwZh && gws !== 'own') {
        for (let k = 0; k < cells.length; k++) {
          if (k === ci) continue                                // 模型格已处理
          let cell = cells[k]
          const t = cell.replace(/\*\*/g, '').trim()
          const hitZh = ZH_NAMES.find(z => z !== gwZh && (t === z || t.startsWith(z + ' ') || t.startsWith(z + '　') || t.startsWith(z + '（') || t.startsWith(z + '(')))
          if (hitZh) { cell = cell.replace(hitZh, gwZh); changed.push(d.split(/[\\/]/).pop() + ' · ' + role + ' 网关格：' + hitZh + ' → ' + gwZh) }
          for (const tok of (cell.match(/`[^`]+`/g) ?? [])) {
            const inner = tok.slice(1, -1)
            if (PROVIDER_ZH[inner] && inner !== gwKey) {
              cell = cell.split(tok).join('`' + gwKey + '`')
              changed.push(d.split(/[\\/]/).pop() + ' · ' + role + ' 家名字面量：' + inner + ' → ' + gwKey)
            }
          }
          if (cell !== cells[k]) { cells[k] = cell; hit++ }
        }
      } else if (gws === 'own') {
        console.log(`  ⏭️ ${role}（载体 ${v.agent}）的网关格**没动** —— 声明里 \`gatewaySource=own\`（模型来自它自己的 CLI/订阅），不许从模型前缀推；网关要改请人工确认`)
      }
      lines[idx] = cells.join('|')
    }
    if (hit) {
      try { writeFileSync(d + '.bak-fix-' + Date.now(), readFileSync(d)) } catch {}
      writeFileSync(d, lines.join('\n'), 'utf8')
    }
  }
  return changed
}
if (FIX) {
  const changed = fixDocs(docs)
  console.log(changed.length
    ? '🔧 `--fix`：已把文档里的模型字面量对齐到配置（原文备份为 `.bak-fix-<时间戳>`）：\n  - ' + changed.join('\n  - ')
    : '🔧 `--fix`：文档本来就是配置的样子，无需改动')
  console.log('')
  // ★ 2026-10-16（b93）：`--fix` **不为级模型改文档** —— 定编表每行只有**一个**模型格，装不下 L1..L4 四级；
  //   硬塞进去会把那一格写成四不像，而且下一跑 fixer 会把它当作"整角色模型"再改一次（＝自己踩自己）。
  //   所以这里**只提示一句**：级模型以 `agents.json` 为准，对账只报不改。**不改任何既有 --fix 行为。**
  const leveled = Object.entries(cfg.roles ?? {}).filter(([, v]) => v?.levels && typeof v.levels === 'object' && Object.keys(v.levels).length)
  if (leveled.length) {
    console.log(`⏭️ \`--fix\` **不动级模型**：定编表每行只有一个模型格，装不下 L1..L4 —— 这些角色配了 levels（${leveled.map(([r]) => r).join(' / ')}），级模型请以 \`agents.json\` 为准（对账只提示，不改文档）。\n`)
  }
}

const results = docs.map(d => (existsSync(d) ? { doc: d, missing: false, checks: checkDoc(d) } : { doc: d, missing: true, checks: [] }))
const allChecks = results.flatMap(r => r.checks)
const bad = allChecks.filter(c => !c.ok)
const badHard = bad.filter(c => !c.soft)          // 硬项：载体 / 档位 / 关键参数 —— **拦住起飞**
const badSoft = bad.filter(c => c.soft)           // 软项：模型 —— 只提示（用户随时会在看板上换）

if (JSON_OUT) {
  process.stdout.write(JSON.stringify({
    docs,
    roles: Object.keys(cfg.roles ?? {}),
    total: allChecks.length,
    failed: bad.length,
    failedHard: badHard.length,
    failedSoft: badSoft.length,
    results: results.map(r => ({
      doc: r.doc, missing: r.missing, total: r.checks.length,
      failed: r.checks.filter(c => !c.ok).length,
      failedHard: r.checks.filter(c => !c.ok && !c.soft).length,
      checks: r.checks
    }))
  }, null, 2) + '\n')
} else {
  console.log(`配置：${join(WORKSPACE, '_crew', 'agents.json')}`)
  for (const r of results) {
    if (r.missing) { console.log(`\n### (缺文件) ${r.doc} —— 跳过`); continue }
    const rh = r.checks.filter(c => !c.ok && !c.soft).length
    const rs = r.checks.filter(c => !c.ok && c.soft).length
    console.log(`\n### 文档：${r.doc}`)
    let last = null
    for (const c of r.checks) {
      if (c.role !== last) { console.log(`【${c.role}】`); last = c.role }
      console.log(`  ${c.ok ? '✅' : (c.soft ? '⚠️' : '❌')} ${c.what}\n       ${c.detail}`)
    }
    console.log(rh ? `  → ❌ ${rh} 项**硬**漂移（**配置为准，去改文档**）`
      : (rs ? `  → ⚠️ ${rs} 项是模型（软项，不拦起飞；跑 \`--fix\` 自动对齐）` : '  → ✅ 该文档与配置一致'))
  }
  console.log(`\n共 ${docs.length} 份文档 / ${allChecks.length} 项：` + (badHard.length
    ? `❌ ${badHard.length} 项**硬**漂移（载体/档位/参数 —— **配置为准，去改文档**）`
    : (badSoft.length
      ? `✅ 硬项全对；⚠️ ${badSoft.length} 项**模型**与文档不同（**软项，不拦起飞** —— 模型由用户定，跑 \`_定编对账.mjs --fix\` 可把文档对齐）`
      : '✅ 配置与文档完全一致')))
}
// 退出码：0 全对 · 1 有**硬**漂移（拦起飞）· 2 只有**模型**软漂移（不拦）
process.exit(badHard.length ? 1 : (badSoft.length ? 2 : 0))