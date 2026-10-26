#!/usr/bin/env node
/**
 * 起飞前检查 —— 真跑任何项目**之前**跑一次，回答一个问题：**现在这台工作台能不能起飞**。
 *
 * 为什么单独做一个：真跑要花真额度，而"某个检查昨晚还过、今天因为改了一行就不过了"这种事
 * 只有**跑一遍**才知道。这个脚本把已有的检查器**串成一条**（不复制它们的实现），给一个总判决。
 *
 * 用法：node 起飞前检查.mjs [--with-roles] [--with-session] [--json]
 *   --with-roles    连"角色自检"一起跑（**会真调班组、花额度**，默认不跑）
 *   --with-session  连"会话冒烟"一起跑（**会真新建一个无人值守会话、花一次额度**；升级后必跑）
 *                   ← 2026-10-19 b184 加：0.2.1 升级后 preset 里的 `{{cwd}}` 让新会话**发不出请求**，
 *                     而它**埋了 24 小时**才被发现 —— 因为升级后没人新开过会话。
 * 退出码：0 可以起飞；1 不许起飞（有硬项没过）
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// ★ 2026-10-06：锁文件名的**唯一权威**来自 `_lock.mjs`（别在这里再写一个字面量字符串）
import { LOCK_FILE } from './_lock.mjs'
import { KB as KB_ROOT } from './_路径.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WORKSPACE = resolve(HERE, '..')
const NODE = process.execPath
const argv = process.argv.slice(2)
const JSON_OUT = argv.includes('--json')
const WITH_ROLES = argv.includes('--with-roles')
const WITH_SESSION = argv.includes('--with-session')

const items = []
const add = (name, ok, detail, level = 'error') => items.push({ name, ok, detail, level })

// ── 零 LLM 的确定性检查（默认全跑）
// ⚠️ 2026-10-03 修（实测到的第二次"瞬时硬错"）：**每个子检查器有自己的退出码契约**，
//   `账目对账.mjs` 是 `0=全过 / 1=硬错 / 2=仅警告`。通用 run() 若把"任何非 0"都当硬错，
//   那么对账只要给出**警告级**结论（例：快照过期、期间有别的进程刷新），总闸就误报"⛔ 不许起飞"。
//   所以 run() 必须接受"这个检查器允许的退出码集合"，并把"只命中警告"标成 ⚠️ 而不是 ❌。
function run (name, script, args = [], okCodes = [0], cwd = HERE) {
  const p = join(HERE, script)
  if (!existsSync(p)) { add(name, false, `脚本不存在：${p}`); return null }
  try {
    const out = execFileSync(NODE, [p, ...args], { encoding: 'utf8', maxBuffer: 16 << 20, cwd, windowsHide: true, timeout: 300000 })
    add(name, true, (out.trim().split(/\r?\n/).pop() ?? '').slice(0, 120))
    return out
  } catch (e) {
    const status = e.status ?? null
    const out = String(e.stdout ?? '')
    // 退出码在"允许集合"里 → **不是硬错**（例：对账 exit=2 只代表有警告级项）
    if (okCodes.includes(status)) {
      add(name, true, `exit=${status}（该检查器的"仅警告"档，**不是硬错**）`, 'warn')
      return out
    }
    const tail = String(out || e.message || '').trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ⏐ ')
    add(name, false, `exit=${status ?? '?'}：${tail.slice(0, 220)}`)
    return null
  }
}

// ★ 2026-10-16（b86）修：**这一条漏传了允许退出码集合** —— `_定编对账.mjs` 自己的契约是
//   `0=全过 / 1=硬错 / 2=仅警告`，而这里吃默认的 `[0]` ⇒ 它的"模型软项"（exit=2；脚本末行原文写着
//   **"软项，不拦起飞"**、`01-架构.md` L64 也这么写）被当成**硬错**，总闸报"⛔ 不许起飞"
//   ⇒ **闸与子检查器自己打自己**。兄弟调用 ③（账目对账）与 ④（一致性复验）都传了 `[0, 2]`，只有这条漏了。
//   反向验收（stub exit=2 放行 / stub exit=1 仍拦）见 `动工日志.md` b86。
run('① 定编对账（文档写的人 = 配置里的人）', '_定编对账.mjs', [], [0, 2])
// ★ 2026-10-10 新增 ①b：**兜底与配置必须结构对等** —— 修存量 gap 时实测出的真缺陷：
//   `resolveRole()` 遇到"角色指定的载体没声明"会**静默冒用 defaultAgent 的载体**，而 `agentName` 照旧返回原名字
//   ⇒ **名字报 codebuddy、命令其实是 Pi 的 cli.js**（比换载体更难查）。这道闸盯四件：配置自洽 / 兜底覆盖 / 兜底可用 / 不静默冒用。
run('①b 兜底对账（兜底 ⊇ 角色用到的载体 ＋ 不静默冒用载体）', '_兜底对账.mjs')
// ★ 2026-10-16 新增 ①c（用户明确要求的一条**硬闸**）：**"看板选了档位" ≠ "这个档位真生效"**。
//   档位是按模型声明的白名单（ark/glm-5.3-flash 认 low/high/max；xiaomi 一个都不认），传了不认的值是**硬拒**。
//   这道闸逐角色逐级验一遍：模型声明了档位、但这一级的候选一个都不在它白名单里 ⇒ **红、不许起飞**
//   （那正是"你看板选了狠、实际发出去的是 low 或压根没发"的静默）。模型压根不认档位 ⇒ 只记黄（如实"不传"）。
//   依据：KB `重构\任务分级-施工文档.md` §3.5；退出码 0=过(可带黄)/1=红/2=自己瞎了。
run('①c 档位对账（三档抽象 → 按模型白名单落地；不许"选了却不生效"）', '_档位对账.mjs', ['--json'])
run('② 解析器回归（防假通过的那道闸）', '_解析器自检.mjs')
// ★ 2026-10-09 八·S7（§10-S5）：**不许新增"读散文取状态"**（用正则从人写的文档里抠状态）。
//   存量已登记为例外（含计数+理由）；新增/超数即红。S6 每迁移完一处就回去降数。
run('②b 禁散文自检（八·S7：不许新增"读散文取状态"，存量已登记）', '_禁散文自检.mjs')
// ★ 2026-10-09 五·S8：**同角色两张卡的 STABLE 段必须逐字节相同**（缓存前缀的机械闸；零 token，只跑 派活 --dump-blocks 两次）
run('②c 前缀契约（五·S8：STABLE 逐字节一致 / 无插值 / ≥1200 字）', '_前缀契约自检.mjs', ['--role', 'coder-b'])
// ★ 2026-10-03 新增：**硬约束 4 落地** —— 原来总闸根本没跑"一致性复验"，
//   于是"文档说 A、实机是 B"（例：权威源指向不存在的 `SOP\规则书-v3.md`）能一路漂到接手人手里。
//   它自己的退出码契约：0=全过 / 1=有硬错（指向不存在的文件）/ 2=仅警告 → 用 [0,2] 接，
//   **警告不挡起飞，硬错挡**。
run('④ 一致性复验（文档指向空气 / 过时结论 / 写死可变量）', '_一致性复验.mjs', [], [0, 2])
// ★ 2026-10-05 新增（**真凶级护栏**）：opencode 的 `grep`/`glob` 依赖一个**它自己不带的 ripgrep**，
//   首次用到会去 **GitHub 现下**；国内网络下卡住（实测两次各 ~80 / ~73 秒）→ 该 step 被 **abort** →
//   会话 `idle_outcome=failed` + `time_suspended`（**从不自动恢复**）→ 表现就是"coder-b 跑一半没了"。
//   ⇒ 这里只**检查**是否已就位（`--check` 不写文件）；缺了算**硬错**（静默卡死是本项目最恨的失败模式，
//      而修法只要 1 秒：跑一次 `预置载体依赖.mjs`，从**包内**复制、零外网）。
run('④b 载体外网依赖已预置（opencode 的 ripgrep；缺了会随机掐断 coder-b）', '预置载体依赖.mjs', ['--check'])
const recOut = run('③ 两本账对账（不重复计费 / 不漏记）', '账目对账.mjs', ['--json'], [0, 2])
run('⑤ 解析器与账目检查器自检（有病能报、没病不报）', '账目对账.mjs', ['--selftest'])

// 对账的硬错数单独看一眼（脚本 exit=2 只代表"有警告"，也是能起飞的）
if (recOut) {
  try {
    const j = JSON.parse(recOut)
    add('③b 对账无硬错', j.errors === 0, `硬错 ${j.errors} / 警告 ${j.warnings}（**警告级可以起飞**：例：还没有非 DSH 调用）`, 'warn')
  } catch { add('③b 对账无硬错', false, '对账输出不是 JSON，读不出硬错数') }
}

// ── 现场与工具链（存在性 + 状态，不调模型）
// ⚠️ 2026-10-06 修（三方交叉验证共同指出的"死保护"）：原来这里硬写 `_crew\orchestrator.lock`，
//   而真正的锁是 `_lock.mjs` 的 `_crew\crew.lock`（**全仓没有任何人写 orchestrator.lock**）
//   ⇒ 这一项一直在检查一个不存在的文件，输出恒为"没有锁文件"。
//   现在统一走 `_lock.mjs` 导出的 `LOCK_FILE`（唯一权威）。
const lockFile = LOCK_FILE
if (existsSync(lockFile)) {
  let stale = false
  try {
    const l = JSON.parse(readFileSync(lockFile, 'utf8'))
    const pid = Number(l.pid)
    try { process.kill(pid, 0) } catch { stale = true }
  } catch { stale = true }
  add('⑥ 单实例锁没被占（或残留锁已可清）', stale, stale ? '锁文件残留但进程已不在（编排会自动清）' : '**有活着的编排在跑** → 别同时起第二个', 'warn')
} else add('⑥ 单实例锁没被占', true, '没有锁文件')

const need = [
  ['编排', join(HERE, '编排.mjs')], ['派活', join(HERE, '派活.mjs')], ['台账', join(HERE, '台账.mjs')],
  ['门禁', join(HERE, '门禁.mjs')], ['工量账本', join(HERE, '工量账本.mjs')], ['文件指纹', join(HERE, '文件指纹.mjs')], ['外部用量快照', join(HERE, '外部用量快照.mjs')],
  ['一致性复验', join(HERE, '_一致性复验.mjs')], ['班组配置', join(WORKSPACE, '_crew', 'agents.json')]
]
const missing = need.filter(([, p]) => !existsSync(p)).map(([n]) => n)
add('⑦ 关键件齐全（编排/派活/台账/**门禁**/账本/指纹/快照/一致性复验/班组配置）', missing.length === 0, missing.length ? `缺：${missing.join('、')}` : `共 ${need.length} 件`)

// ── ⑦b 工作台自动备份（2026-10-18 用户拍板）
//   为什么固定进闸：工作台住在安装目录里，**桌面端更新会把整个目录改名后删除**
//   （2026-10-17 真实丢了工作台+agents，靠 MFT 才捞回一半）⇒ 没有近期备份就不该放心开跑。
//   ⚠️ warn 级：**不改退出码**（备份没到期 ≠ 这轮不能干活），但会在起飞报告里明晃晃写着。
try {
  const st = JSON.parse(readFileSync(join(WORKSPACE, '_crew', '备份状态.json'), 'utf8'))
  const ageH = (Date.now() - Date.parse(st.at)) / 3600000
  if (!Number.isFinite(ageH)) add('⑦b 工作台自动备份（防"更新把安装目录删掉"）', false, '备份状态文件里的时间读不出来', 'warn')
  else if (ageH <= 24) add('⑦b 工作台自动备份（防"更新把安装目录删掉"）', true, `${ageH.toFixed(1)} 小时前备过：${st.files ?? '?'} 文件 / ${st.mb ?? '?'} MB → ${st.target}`)
  else add('⑦b 工作台自动备份（防"更新把安装目录删掉"）', false, `最近一次备份在 ${ageH.toFixed(0)} 小时前（>24h）→ 看护循环是不是没在跑？`, 'warn')
} catch {
  add('⑦b 工作台自动备份（防"更新把安装目录删掉"）', false, '还没有备份状态 → 手动跑一次 `_unattended\\备份-工作台.mjs`', 'warn')
}

// ── ⑦c 知识库没有嵌套 stray 树（★ 2026-10-18 新增；坑库 `2026-10-18 obsidian_append多写一层AI知识库…`）
//   为什么进闸：`obsidian_append` 的 path **相对 vault 根**，再多写一层 `AI知识库/` 就会**静默**写进
//   `<vault>\AI知识库\…`（工具会自动建目录、且不报错）⇒ 真笔记一行没动，库里却多出一份旧版副本，搜索先搜到它。
//   2026-10-16 首现；b26 删过一次，之后又被同样写法重建 4 次 ⇒ **光删不治写法会复发**，所以固化成硬闸。
//   ⚠️ 硬项：这棵树在 = "写了但没落地"，与"探针绿、用户却看到旧版"同族，必须拦。
const VAULT = process.env.DSH_VAULT ?? KB_ROOT
const STRAY_VAULT = join(VAULT, 'AI知识库')
add('⑦c 知识库没有嵌套 stray 树（obsidian_append 多写一层 AI知识库）', !existsSync(STRAY_VAULT),
  existsSync(STRAY_VAULT)
    ? `发现 ${STRAY_VAULT} —— 有 append 用了 "AI知识库/…" 多一层的 path ⇒ 真笔记没更新，内容落在这儿`
    : '没有嵌套 AI知识库 目录')

// ── ⑦d 调研库体检（★ 2026-10-18 · 调研库 S9；**黄级、不拦起飞**）
//   为什么黄级：库烂了（空抽屉／未登记／索引旧／过期条目）不影响"今天能不能开工"，
//   但会影响"引用的资料是不是旧的" ⇒ 该看见，不该拦。
//   没有钉住的项目 / 项目没建库 ⇒ 明确"跳过"（**不建库是正常状态**，不该红）。
const PROJ_PTR = join(WORKSPACE, '_crew', '当前项目.txt')
const PROJ_PIN = (() => { try { return readFileSync(PROJ_PTR, 'utf8').trim() } catch { return '' } })()
if (!PROJ_PIN) add('⑦d 调研库体检（有库才跑；黄级不拦）', true, '没有钉住的项目 → 跳过', 'info')
else if (!existsSync(join(PROJ_PIN, '文档', '调研'))) add('⑦d 调研库体检（有库才跑；黄级不拦）', true, '该项目没有调研库 → 跳过', 'info')
else run('⑦d 调研库体检（有库才跑；黄级不拦）', '调研体检.mjs', ['--project', PROJ_PIN, '--json'], [0, 2])

// ── ⑦e 载体声明自检（★ 2026-10-18 · 十三 S7 —— "加减载体真的零代码改动吗"）
//   为什么要进起飞闸：这一项的判据①就是"全仓不许再出现'一行里列了 ≥2 个载体名'的名单"。
//   它原来只活在 `_probe\_载体可插拔性审计.mjs` 里（**得有人记得手动跑**）；进了闸才是常驻的。
//   反面：2026-10-11 实测过漏改一处的后果 —— rescue 的裸模型被"照名字"认到阿里头上 ⇒ 假警报 `❌ 1 家没钥匙：aliyun`。
run('⑦e 载体声明自检（十三 S7：加减载体零代码改动 / 声明与 agents.json 双向绑定）', '_载体声明自检.mjs')

// ── ⑦f 外壳体检（★ 2026-10-18 · b126 —— "桌面/开始菜单快捷方式还在不在、指得对不对"）
//   用户口径：*"检查桌面是否有快捷方式，没有就建立一个……给其他用户用，开源，开箱即用"*。
//   **黄级**（`[0,2]`）：没建/没表态/用户卸载过都是**正常状态**，不该拦起飞；
//   只有"该在却不在 / 指错了"才退 2（＝黄，看得见但不拦），判据全在 `装外壳.mjs --check` 那一档。
run('⑦f 外壳体检（桌面/开始菜单快捷方式：在不在、指得对不对）', '装外壳.mjs', ['--check'], [0, 2])

// ── ⑨ 目标项目的「可开工」对账（★ 2026-10-07 新增，见 进度.md §24.7）
//   **为什么必须有这一项**：收尾时断点上写着"今晚可开跑：`编排.mjs --execute`"，而那条命令其实
//   **空转** —— 2026-10-06 真实发生：`T35` 是 `blocked`，而 `T36→T37→T38/T39→T40→T41` 是
//   **一条线性依赖链** ⇒ 六条待办**一条都开不了工**（原话 `可开工任务：（没有）`）。
//   根因是"**待办 > 0**"被当成了"**能开工 > 0**"。这一项把那个对账**固定在起飞闸里**，
//   谁想真跑都得先看见"可开工几条"。
//   ⚠️ 它**不是硬项**：某个项目被依赖卡住 ≠ 这台工作台不能起飞 ⇒ warn 级，**不改退出码**。
//   ⚠️ 判据的**唯一实现**仍是 `台账.mjs ready`，这里只调它 —— **绝不重写依赖判定**
//      （重写就会像 `[?]`/`[!]` 那两次一样悄悄漂移）。
try {
  const ptr = join(WORKSPACE, '_crew', '当前项目.txt')
  const pj = existsSync(ptr) ? readFileSync(ptr, 'utf8').trim() : ''
  const tf = pj ? [join(pj, 'TASKS.md'), join(pj, '_crew', 'TASKS.md')].find(f => existsSync(f)) : null
  if (!tf) {
    add('⑨ 目标项目「可开工」对账（防"断点写了开跑命令却跑不动"）', true, '没有钉住的项目（或它没有 TASKS.md）→ 跳过', 'info')
  } else {
    let ready = null
    try {
      const out = execFileSync(NODE, [join(HERE, '台账.mjs'), 'ready', '--project', pj, '--json'],
        { encoding: 'utf8', maxBuffer: 8 << 20, windowsHide: true, timeout: 60000 })
      const arr = JSON.parse(String(out ?? '[]').replace(/^\uFEFF/, ''))   // ⚠️ 剥 BOM（老坑）
      if (Array.isArray(arr)) ready = arr
    } catch { /* 算不出来就如实报"算不出来"，不报假数 */ }
    const rows = readFileSync(tf, 'utf8').split(/\r?\n/).filter(l => /^\s*[-*]\s*\[[ xXr>?!\-]\]\s*\S/.test(l))
    const open = rows.filter(l => /^\s*[-*]\s*\[[ r>]\]/.test(l)).length      // 待办 / 就绪 / 在做
    const review = rows.filter(l => /^\s*[-*]\s*\[[?]\]/.test(l)).length
    const blk = rows.filter(l => /^\s*[-*]\s*\[!\]/.test(l))
      .map(l => (l.match(/^\s*[-*]\s*\[[^\]]\]\s*(\S+)/) ?? [])[1]).filter(Boolean)
    const nm = pj.split(/[\\/]/).filter(Boolean).pop()
    const NAME = '⑨ 目标项目「可开工」对账（防"断点写了开跑命令却跑不动"）'
    if (ready === null) add(NAME, false, `读不出「${nm}」的可开工集合（台账.mjs ready 失败）→ 别凭"待办几条"就开跑`, 'warn')
    else if (ready.length > 0) add(NAME, true, `「${nm}」**可开工 ${ready.length} 条**：${ready.map(t => t.id).slice(0, 8).join('/')}`)
    else if (open > 0) add(NAME, false, `「${nm}」待办 ${open} 条但**一条都开不了工**${blk.length ? `（blocked：${blk.join('、')}）` : '（依赖未满足）'} ⇒ **现在 --execute 是空转**，先解依赖`, 'warn')
    else if (review > 0) add(NAME, true, `「${nm}」没有可开工的编码任务，但有 ${review} 条**待审** ⇒ 要审走 \`--review-only\``, 'warn')
    else add(NAME, true, `「${nm}」台账已清空，没有可开工的`, 'info')
  }
} catch (e) {
  add('⑨ 目标项目「可开工」对账（防"断点写了开跑命令却跑不动"）', false, `检查失败：${String(e?.message ?? e).slice(0, 120)}`, 'warn')
}

// ── ⑩ 规矩版本（★ 2026-10-19 b184 新增；起因：10-18 23:45 大脑起不来 + 20 小时脱节）
//   **零 token 的机械判据，不是"记得重启"这种口头纪律。**
//   为什么必须有：宿主在**加载 profile 时**用 `!!js readFileSync(...)` 一次性求值 persona
//   （实测两次指纹：23:24:48 启动 → brain.md atime 23:24:50；00:01:11 启动 → atime 00:01:14），
//   之后改 brain.md **对已在跑的进程毫无影响** ⇒ 改完不重启 = 改了等于没改，
//   而且**看不出来**（10-18 00:55 改的那版，到 01:10 还在跑的会话里只有 81.2% 行重合）。
//   ⚠️ 反过来也有假红：文件刚改完还没重启 = 这正是要报的那种状态，**该红**。
const BRAIN_MD = process.env.DSH_BRAIN_MD ?? join(HERE, 'roles', 'brain.md')
const fmtTime = (ms) => new Date(ms).toLocaleString('zh-CN', { hour12: false })
function appStartMs () {
  // 进程名可用 DSH_APP_PROC 覆盖（开源到别的机器/改名时不改代码）
  const names = (process.env.DSH_APP_PROC ?? 'DeepSeek Harness,DeepSeek,electron').split(',').map(s => s.trim()).filter(Boolean)
  try {
    const cmd = `$p = Get-Process -Name @(${names.map(n => `'${n}'`).join(',')}) -ErrorAction SilentlyContinue | Sort-Object StartTime | Select-Object -First 1; if ($p) { $p.StartTime.ToFileTimeUtc() }`
    const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd],
      { encoding: 'utf8', windowsHide: true, timeout: 20000 }).trim()
    const ft = Number(out)
    if (!Number.isFinite(ft) || ft <= 0) return null
    return ft / 10000 - 11644473600000   // FILETIME(1601, 100ns) → epoch ms
  } catch { return null }
}
{
  const NAME = '⑩ 规矩版本（brain.md 改完要重启才生效：mtime 必须早于进程启动）'
  if (!existsSync(BRAIN_MD)) add(NAME, false, `找不到 ${BRAIN_MD}`)
  else {
    const bm = statSync(BRAIN_MD).mtimeMs
    const st = appStartMs()
    if (st === null) {
      add(NAME, true, `拿不到桌面端进程启动时间（没在跑 / 非 Windows / 进程名不同 → 用 DSH_APP_PROC 指定）→ **跳过**；要逐会话核对跑 \`规矩版本体检.mjs\``, 'info')
    } else if (bm > st + 2000) {
      add(NAME, false, `brain.md 改于 ${fmtTime(bm)}，而桌面端 ${fmtTime(st)} 才启动 ⇒ **本进程内存里是旧规矩**，重启桌面端才生效（要确认每个会话跑的是哪版：\`规矩版本体检.mjs\`）`)
    } else {
      add(NAME, true, `brain.md ${fmtTime(bm)} 早于进程启动 ${fmtTime(st)} ⇒ 已加载这一版`)
    }
  }
}

// ── ⑪ persona 模板变量白名单（★ 2026-10-19 b184 新增；就是 10-18 23:45 那次「本轮运行失败」的根因）
//   宿主渲染 persona 的 `prefix` / `suffix` 时只认识它**注册过**的变量（0.2.1 起只有 provider / model）。
//   不认识 ⇒ **组装提示词时直接抛错**，会话连一个模型请求都发不出去：
//     unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix"; registered variables: provider, model
//   宿主自带文档的原话：「the loop does not register it, so unresolved references **fail prompt assembly
//   before any model request**」⇒ 这不是降级，是**整轮失败**，而报错只在点开那个会话时才看得见。
//   起因：`安装preset.mjs` 从旧版发运件抄了 `suffix: Your working directory is {{cwd}}.`，
//   旧版宿主注册 cwd、0.2.1 不再注册 ⇒ 升级后**第一张新建的无人值守会话**就炸（埋了 24 小时才被发现）。
//   ⚠️ 白名单可用 DSH_PROMPT_VARS 覆盖（宿主升级后若新增变量，改环境变量即可，不必改代码）。
const DSH_HOME_ = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE_YML = join(DSH_HOME_, 'profiles', process.env.DSH_PROFILE ?? 'desktop', 'cordis.patch.yml')
const ALLOWED_VARS = new Set((process.env.DSH_PROMPT_VARS ?? 'provider,model').split(',').map(s => s.trim()).filter(Boolean))
function scanTemplateVars (file) {
  if (!existsSync(file)) return null
  const bad = []
  readFileSync(file, 'utf8').split(/\r?\n/).forEach((l, i) => {
    const t = l.trim()
    // 跳过：YAML 注释（写了不生效）、`!!js` 表达式行（那是 JS，不是模板）
    if (!t || t.startsWith('#') || t.includes('!!js')) return
    for (const m of l.matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)) if (!ALLOWED_VARS.has(m[1])) bad.push(`L${i + 1} {{${m[1]}}}`)
  })
  return bad
}
{
  const NAME = `⑪ persona 模板变量都在宿主注册表里（{{…}} ⊆ {${[...ALLOWED_VARS].join(', ')}}）`
  const live = scanTemplateVars(PROFILE_YML)
  // 工程里的草稿也可能被装进 profile ⇒ 一起扫，但只记黄（不是活配置）
  let drafts = []
  try {
    for (const f of readdirSync(HERE)) {
      if (!/^preset-.*\.ya?ml$/.test(f)) continue
      const bad = scanTemplateVars(join(HERE, f))
      if (bad && bad.length) drafts.push(`${f}（${bad.join('、')}）`)
    }
  } catch { /* 目录读不了就不报，别把闸自己搞红 */ }
  if (live === null) add(NAME, true, `没找到 profile：${PROFILE_YML} → 跳过`, 'info')
  else if (live.length) add(NAME, false, `**${PROFILE_YML} 里有宿主不认识的变量：${live.join('、')}** ⇒ 下次新建这个 preset 的会话会**在发请求前就失败**（unknown prompt variable）；删掉那一行（或清空 suffix）即可`)
  else if (drafts.length) add(NAME, false, `活配置干净，但工程里的草稿带着同一颗雷（装进去就炸）：${drafts.join('；')}`, 'warn')
  else add(NAME, true, `活配置与 ${readdirSync(HERE).filter(f => /^preset-.*\.ya?ml$/.test(f)).length} 个草稿都没有白名单外的变量`)
}

// ── ⑫ 会话冒烟（★ 2026-10-19 b184）：**升级后"新建一个会话还能不能起来"**
//   事故：0.2.1 起宿主不再注册 `{{cwd}}`，而 preset 里还留着 `suffix: …{{cwd}}.` ⇒ 新会话
//   **在提示词组装阶段就炸**（本轮运行失败，连模型请求都没发出去）。它埋了 24 小时才被发现，
//   因为升级后**没有新开过**无人值守会话 —— 老会话用的还是早先组装好的提示词。
//   ⇒ 这一步不能靠"我记得点一下"：`会话冒烟.mjs` 走宿主本地桥 `create + prompt`，6~7 秒出结论。
//   ⚠️ 默认**不跑**：它会**真留一个会话**在界面里、并花一次额度（实测 ≈2.9 万 input token）。
//      升级后 / 改了 preset 或 profile 之后，跑 `起飞前检查.mjs --with-session`。
if (WITH_SESSION) run('⑫ 会话冒烟（真新建一个无人值守会话并确认它活着；会花一次额度）', '会话冒烟.mjs', [], [0])
else add('⑫ 会话冒烟', true, '**跳过**（默认不跑；升级后或改了 preset／profile 之后加 `--with-session` —— 会真新建一个会话、花一次额度）', 'info')

// ── ⑬ 野目录（★ 2026-10-19 b188）：Obsidian 路径写重了一层留下的**嵌套树**
//   事故：`obsidian_*` 工具的相对路径根＝vaultPath（`<知识库>`），但它的**父目录也叫"知识库"**
//   ⇒ 顺手写成 `知识库/AI知识库/x.md` 时，插件里三处 `mkdir(..., {recursive:true})` 会**静默**把目录建出来，
//   内容落进 `<vault>\知识库\AI知识库\x.md`，**不报错**。同一个坑 10-18 与 10-19 各踩一次。
//   已加两道：① 运行时护栏（`打obsidian路径护栏.mjs` 打进 dsh-obsidian，重写路径即拦下，**重启 DSH 后生效**）
//              ② 本步兜底扫描（零 token，0.2 秒；发现即 ❌，`查野目录.mjs --quarantine` 可移走）
run('⑬ 野目录（vault 内有没有"路径写重一层"留下的嵌套树）', '查野目录.mjs', [], [0])

// ── ⑭ 模型名硬编码（★ 2026-10-19 b200）：规矩「**任何模型名不许写进代码/规矩文件**」的**机器判据**。
//   为什么要有它：模型名**只由用户在看板里定**（唯一源 `_crew\agents.json`）；写进代码/卡模板的模型名会
//   **静默过期**（历史上踩过"AI 按旧名单跑，还不报错"）。这条规矩原来**只有注释**（`_agents-config.mjs`
//   里写着"兜底里也不许写模型名"）⇒ 违反了不疼 ⇒ 迟早漂回去。判据不写死名单：**从 agents.json 现读**。
//   豁免：那一行（或上一行）带 `允许模型名` —— 夹具样本、解析器回归样本用它。
run('⑭ 模型名硬编码（代码/规矩文件里不许出现模型名；豁免标记「允许模型名」）', '_模型名体检.mjs', [], [0])

// ── ⑮ 运转链页数据（★ b204）：看板「运转链」页的**数据面**能不能生成。
//   为什么值得占一项：那一页是**只读聚合**（转录＋账本＋running 登记＋长命资源册），任何一路读崩了
//   页面就只剩"读不到 /chain.json"——而它平时没人盯着。这里**只调 `chainView()`**（不跑页面、不写盘），
//   断言：12 个用电器 / 15 条线 / 元件排 ≥ 20 个 / 每条线都有 why（没理由的线＝编的）。
//   ★ 2026-10-23（施工文档 D15）：多了「审核」这一环（`review` 节点 ＋ `checks>review`、`review>board` 两条线）
//     ⇒ 计数从 11/13 变成 **12/15**。改拓扑就要同步改这里（否则起飞前检查会拦）。
//   ★ 2026-10-23（施工文档 D26）：载体那一格拆成 **5 个用电器**（coder-a / coder-b / reviewer / researcher / rescue）
//     ⇒ 用电器 12 → **16**；三条逻辑线（`orch>carrier` / `carrier>outbox` / `tools>carrier`）**不变**，仍是 15 条。
//   ⚠️ 失败只用 'warn' 级：那一页坏了不该拦住别人起飞（它是"看"的，不是"跑"的）。
try {
  const { chainView } = await import('./面板/链路面板.mjs')
  const v = chainView({})
  const noWhy = (v.edges ?? []).filter((e) => !e.whyLive || !e.why).length
  const bads = []
  const NODES_WANT = 16
  const EDGES_WANT = 15
  if (!v.ok) bads.push('chainView 返回 ok:false')
  if ((v.nodes ?? []).length !== NODES_WANT) bads.push('用电器 ' + (v.nodes ?? []).length + ' 个（应为 ' + NODES_WANT + '）')
  if ((v.edges ?? []).length !== EDGES_WANT) bads.push('连线 ' + (v.edges ?? []).length + ' 条（应为 ' + EDGES_WANT + '）')
  // D26：5 个载体必须**各自**是一个用电器（不是又塞回一个"载体进程"大框）
  const wantRoles = ['coder-a', 'coder-b', 'reviewer', 'researcher', 'rescue']
  const gotIds = new Set((v.nodes ?? []).map((n) => n.id))
  const missing = wantRoles.filter((r) => !gotIds.has(r))
  if (missing.length) bads.push('载体用电器缺：' + missing.join('、'))
  if ((v.parts ?? []).length < 20) bads.push('元件排只有 ' + (v.parts ?? []).length + ' 个（应 ≥20）')
  if (noWhy) bads.push(noWhy + ' 条线讲不出 why（那就是编的）')
  add('⑮ 运转链页数据（只读聚合：16 用电器 / 15 线 / 5 个载体各一格 / 每条线都有 why）', bads.length === 0,
    bads.length ? bads.join('；') : ('用电器 ' + v.nodes.length + ' 个 · 连线 ' + v.edges.length + ' 条（通电 ' + v.edges.filter((e) => e.live).length + '）· 载体 5 格 · 元件排 ' + v.parts.length + ' 个（闸门族 ' + v.parts.filter((p) => p.group === 'gate').length + ' ＋ 常驻 ' + v.parts.filter((p) => p.group === 'resident').length + '）· 证据窗口约 ' + (v.window?.spanMin ?? '?') + ' 分钟'), 'warn')
} catch (e) {
  add('⑮ 运转链页数据', false, '跑不起来：' + String(e?.message ?? e).slice(0, 200), 'warn')
}

// ── ⑯ 失败处置矩阵（★ D20）：`judge()` 里出现过的**每个判决**都必须在 `_失败处置.mjs` 里有一行。
//   为什么值得占一项：撞顶那次就是"新判决接不进老动作"—— 判决写在 `judge` 里，动作写在另一个数组里，
//   两边谁也不知道谁。这一项让"加了判决却忘了给动作"**立刻变红**，不可能悄悄过去。
//   ★ 施工文档 §8.1 影响面（2026-10-23）：`ac-env` 拆成 `ac-env-workspace` / `ac-env-credential`
//   ⇒ 矩阵**必须**有这两行（硬错，不补就飞不起来）—— 这里把这两个名字并进"必须覆盖"的集合，
//   就算 `编排.mjs` 还没改完、源码里搜不到它们，也照查不误。
try {
  const { missingFrom, rescueAble } = await import('./_失败处置.mjs')
  const src = readFileSync(join(HERE, '编排.mjs'), 'utf8')
  // 从源码里抠 `verdict: 'xxx'` 与 `verdict = 'xxx'`（judge 与各处合成判决都算）
  const seen = new Set()
  for (const m of src.matchAll(/verdict\s*[:=]\s*'([a-z][a-z-]*)'/g)) seen.add(m[1])
  const REQUIRED_ROWS = ['ac-env-workspace', 'ac-env-credential']   // §8.1：矩阵这两行是硬要求
  for (const r of REQUIRED_ROWS) seen.add(r)
  const miss = missingFrom([...seen])
  add('⑯ 失败处置矩阵（每个判决都有"自动动作 + 建议动作"；含 ac-env-workspace / ac-env-credential 两行）', miss.length === 0,
    miss.length
      ? ('这些判决没在矩阵里：' + miss.join('、') + '（新判决必须先进 `_unattended\\_失败处置.mjs`；§8.1 的两行是硬错）')
      : ('判决 ' + seen.size + ' 个全覆盖（含 ac-env-workspace / ac-env-credential）；急救名单＝' + rescueAble().join('、')),
    'error')
} catch (e) {
  add('⑯ 失败处置矩阵', false, '跑不起来：' + String(e?.message ?? e).slice(0, 200), 'error')
}

// ── ⑰ 特征库条数 / 本周新增（★ 施工文档 §6 飞轮；**信息项，不告警、不拦起飞**）
//   为什么要有：飞轮的闭环是"人工判定 → 写回 SIGNATURES → 下次第 0 级零成本命中"，
//   而"特征库跟没跟上"平时**看不见** —— 只有出事了才知道库太薄。这一项只报数，不判好坏。
//   口径：条数＝`_失败处置.mjs` 的 SIGNATURES 现有条数；本周新增＝`_crew\诊断账本.jsonl` 里
//   最近 7 天**写回过特征库**的行数（字段认 added/writeback/op/kind/来源 里的"新增/写回/人工"标记；
//   认不出标记就如实报 0 + 说明，**不编数**）。
try {
  const { SIGNATURES } = await import('./_失败处置.mjs')
  const total = Array.isArray(SIGNATURES) ? SIGNATURES.length : 0
  let weekNew = 0
  let note = ''
  try {
    const lines = readFileSync(join(WORKSPACE, '_crew', '诊断账本.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean)
    const since = Date.now() - 7 * 24 * 3600000
    for (const l of lines) {
      let e = null
      try { e = JSON.parse(l) } catch { continue }
      const at = Date.parse(e?.at ?? '')
      if (!Number.isFinite(at) || at < since) continue
      const mark = String(e?.added ?? e?.writeback ?? e?.op ?? e?.kind ?? e?.来源 ?? '')
      if (e?.added === true || e?.writeback === true || /新增|写回|人工|manual|signature/i.test(mark)) weekNew++
    }
    if (!lines.length) note = '（还没有诊断账本 ⇒ 本周新增按 0 报）'
    else if (!weekNew) note = '（账本里最近 7 天没有"写回特征库"的标记行；标记字段认不出时也按 0 报，不编数）'
  } catch { note = '（读不到 _crew\\诊断账本.jsonl ⇒ 本周新增按 0 报）' }
  add('⑰ 特征库（信息项，不告警）', true,
    `特征库 ${total} 条 / 本周新增 ${weekNew} 条${note}　—— 依据：_失败处置.mjs SIGNATURES ＋ _crew\\诊断账本.jsonl`, 'info')
} catch (e) {
  add('⑰ 特征库（信息项，不告警）', true, '读不出特征库：' + String(e?.message ?? e).slice(0, 120), 'info')
}

// ── ⑱ pending-reboot 复验（★ 施工文档 §5.4 / §8 落点 11；**能跑了就自动解除，不拦起飞**）
//   场景：环境卡装完要重启才生效 ⇒ 缺口记 `pending-reboot`，其它卡照跑；机器重启后**这一步**复验
//   `X --version`，能跑 ⇒ 标 `resolved` 并提示重派 `needsBy` 里的原卡（**不挂起整波**）。
//   状态只写回 `<项目>\_crew\环境缺口.json` 的那一条（形状照契约：items[{tool,state,needsBy,evidence,at}]）。
try {
  const NAME = '⑱ 环境缺口 pending-reboot（能跑了就自动解除并提示重派；不拦）'
  const gapFile = PROJ_PIN ? join(PROJ_PIN, '_crew', '环境缺口.json') : null
  const gap = gapFile && existsSync(gapFile)
    ? JSON.parse(readFileSync(gapFile, 'utf8').replace(/^\uFEFF/, ''))
    : null
  const items = Array.isArray(gap?.items) ? gap.items : []
  const pend = items.filter(x => x && x.state === 'pending-reboot')
  if (!PROJ_PIN) add(NAME, true, '没有钉住的项目 → 跳过', 'info')
  else if (!pend.length) add(NAME, true, '没有 pending-reboot 的环境缺口 → 跳过', 'info')
  else {
    const toolRuns = (tool) => {
      try {
        execFileSync(tool, ['--version'], { encoding: 'utf8', maxBuffer: 1 << 20, windowsHide: true, timeout: 15000 })
        return true
      } catch {
        try {
          execFileSync(`${tool} --version`, { shell: true, encoding: 'utf8', maxBuffer: 1 << 20, windowsHide: true, timeout: 15000 })
          return true
        } catch { return false }
      }
    }
    const resolved = []
    const still = []
    for (const it of pend) {
      const tool = String(it.tool ?? '').trim()
      if (!tool) { still.push('（缺 tool 名）'); continue }
      if (toolRuns(tool)) {
        it.state = 'resolved'
        it.at = new Date().toISOString()
        it.resolvedBy = '起飞前检查'
        resolved.push(`${tool} → 重派 ${(it.needsBy ?? []).join('、') || '（needsBy 空）'}`)
      } else still.push(tool)
    }
    writeFileSync(gapFile, JSON.stringify(gap, null, 2) + '\n', 'utf8')
    add(NAME, true,
      resolved.length
        ? `已自动解除 ${resolved.length} 条（${resolved.join('；')}）⇒ **提示重派原卡**（needsBy 里那些）`
        : `仍 pending-reboot：${still.join('、')}（X --version 还跑不了）→ 只提醒、不拦，重启后再来这一步`,
      'info')
  }
} catch (e) {
  add('⑱ 环境缺口 pending-reboot', false, '检查失败（不影响其它项）：' + String(e?.message ?? e).slice(0, 140), 'warn')
}

// ── 可选的"角色自检"（**会花额度**）
if (WITH_ROLES) run('⑧ 角色自检（真发一次，花额度）', '_角色自检.mjs', [])
else add('⑧ 角色自检', true, '**跳过**（默认不跑；要跑加 --with-roles，会真调班组花额度）', 'info')

const bad = items.filter(x => x.level === 'error' && !x.ok)
if (JSON_OUT) process.stdout.write(JSON.stringify({ ok: bad.length === 0, failed: bad.length, items }, null, 2) + '\n')
else {
  console.log(`起飞前检查（${new Date().toLocaleString('zh-CN')}）\n`)
  for (const x of items) console.log(`${x.ok ? (x.level === 'info' ? 'ℹ️' : '✅') : x.level === 'warn' ? '⚠️' : '❌'} ${x.name}\n     ${x.detail}`)
  console.log(bad.length === 0
    ? `\n🛫 **可以起飞**${items.some(x => !x.ok) ? '（有警告项，看上面）' : ''} —— 下一步：**先看 ⑨ 的「可开工」数**再决定 \`编排.mjs --project <项目> --execute\`（可开工 0 条时它是**空转**）`
    : `\n⛔ **不许起飞**：${bad.length} 项硬错，先修上面的 ❌`)
}
process.exit(bad.length ? 1 : 0)