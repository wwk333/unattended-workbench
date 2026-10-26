/**
 * 新面板 · **服务端**（批 1「管理页搬家」· 总表 §十 B 案）
 *
 * ## 这是什么
 *
 * 一个**独立于 DSH** 的小服务：`http://127.0.0.1:19450`。
 * 页面上搬的是现看板的管理功能（表1 模型商/额度 · 职位表 · ①干活 职位模型/切换链 ·
 * ②管API 钥匙/优先级/添加/检测 · 跑一轮），**不动 DSH、与旧看板双轨并行**。
 *
 * ## 三条设计口径（别改）
 *
 * ① **口径只有一个源**：格式化/口径代码**不在本文件**，而是从
 *    `sidebar-plugin\lib\client.js` 的 `CORE-BEGIN/END` 标记区里**现取**，
 *    并逐字节比对 `面板\core.js`；不一致 ⇒ **拒绝启动**（宁可不开，也不许两边显示不一样）。
 *    页面用 `<script src="/core.js">` 拿同一段（经典脚本，不是 ESM —— 宿主与浏览器都这么加载）。
 * ② **管理逻辑复用现成的**：钥匙/模型/额度这些写操作走 `额度面板.mjs` 的 `handle()`
 *    （本就可独立复用），**不重写一套**；命令行与界面做的是同一件事。
 * ③ **跑一轮 = 同一条路**：spawn 的就是 `编排.mjs --project <项目> --execute`
 *    （与看板上的「▶ 开始」、与命令行**完全同一条路**，不是第二套实现）；
 *    输出落 `<项目>\_crew\panel-run.log`，**绝不接管道**（本工作台老坑）。
 *
 * ## 环境变量
 *
 * | 变量 | 默认 | 说明 |
 * |---|---|---|
 * | `DSH_PANEL_PORT` | 19450 | 监听端口 |
 * | `DSH_PANEL_HOST` | 127.0.0.1 | 只监听本机（不要改成 0.0.0.0） |
 * | `DSH_BOARD_DATA` | `<工作台根>\_crew\board-data.json` | 看板数据文件 |
 * | `DSH_BOARD_TTL_SEC` | 10 | 数据过期秒数（过期就后台刷一次，**不阻塞响应**） |
 * | `DSH_NODE_EXE` | 桌面端自带 node | 跑子脚本用的 node |
 */
import { createServer } from 'node:http'
// ★ 2026-10-26（§十「三层权限」）：所有写路由的统一闸门（状态区只读/配置区审计/操作区命令）
import { guardWrite, recordAfter } from './权限闸.mjs'
import { appendFileSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handle as quotaHandle } from '../额度面板.mjs'
import { buildFrames } from './帧数据.mjs'
import { frameAction } from './帧动作.mjs'
import { listWorkspaces, pinProject } from './工作区.mjs'
import { brainTurnState } from './大脑会话.mjs'
// ★ b123：「载体」页（用户 2026-10-18）—— 载体的增/改/删 ＋ 自检；写盘纪律在那边，这里只转手。
import { carriersView, carriersAction } from './载体面板.mjs'
// ★ b126：「外壳」（桌面/开始菜单快捷方式）—— 首启问一句的提示条用；判据全在 `_unattended\装外壳.mjs`。
import { shellStatus, shellAction } from './外壳面板.mjs'
// ★ b197（施工文档 §四 D7）：**规矩面板** —— 看板上直接改规矩文件（备份→写→自检→不过回滚＋diff 对照）
import { rulesView, rulesAction } from './规矩面板.mjs'
// ★ b131：「运转链」页 —— 把无人值守里几乎每次都跑的件摆成电路图，**电流＝真证据**（判据在 `链路面板.mjs`）
import { chainView, chainDetail } from './链路面板.mjs'
// ★ b88：长命资源登记册（**唯一写入口**是 `_unattended\登记服务.mjs`；这里只是"看 ＋ 拉起 ＋ 自己登记"）
// ★ b91：**判据改成问 `长命资源巡检.mjs`**（那个跑一次就退的工具）——面板不再直接跑 verify，避免重复打那个电话。
import { portOwner as longlivePortOwner, up as longliveUp } from '../登记服务.mjs'
// ★ b91「谁动谁叫」：面板起网关/自己起来时叫一声长命资源巡检（不等待、失败就算了；判据仍只有一处）
import { pokeInspection } from '../长命资源巡检.mjs'
import { NODE_BIN, need } from '../_路径.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))                 // = _unattended\面板
const UNATTENDED = resolve(HERE, '..')                               // = _unattended
const ROOT = resolve(UNATTENDED, '..')                               // = 工作台根（无人值守\）
const CLIENT_JS = join(UNATTENDED, 'sidebar-plugin', 'lib', 'client.js')
const CORE_JS = join(HERE, 'core.js')
const ORCH_FILE = join(UNATTENDED, '编排.mjs')
const DATA_FILE = process.env.DSH_BOARD_DATA ?? join(ROOT, '_crew', 'board-data.json')
const PRODUCER_FILE = join(UNATTENDED, '看板数据.mjs')
const PORT = Number(process.env.DSH_PANEL_PORT ?? 19450)
const HOST = process.env.DSH_PANEL_HOST ?? '127.0.0.1'
// ★ b218（2026-10-22 用户："重算周期降成 10 秒"）：默认 60 → **10 秒**（生产者实测约 1 秒/次 ⇒ 约 10% 单核）。
//   仍是 stale-while-revalidate：过期只**后台**刷，不阻塞响应。
const TTL_SEC = Number.isFinite(Number(process.env.DSH_BOARD_TTL_SEC)) ? Number(process.env.DSH_BOARD_TTL_SEC) : 10
// ★W2：DSH 自带的专用 node 只是**优先项**，不是硬依赖 —— 载体入口都是 .js，
//   用"正在跑本服务的这个 node"（process.execPath）同样能跑。硬 `need()` 会害得
//   没装 config 的机器连面板都起不来（实测：导出包里就是这条把面板打死）。
const NODE_EXE = process.env.DSH_NODE_EXE ?? NODE_BIN ?? process.execPath
// ★ b209（2026-10-20，用户："看板不显示子 agent 干活过程了好像检查不到"／"运转链只能看到几个灯亮"）：
//   ① 新建 `面板\项目定位.mjs` —— **钉住的目录可能不是工作台根**（会话开在文档目录、代码在别处）；判据四条：
//      自己带 `_crew` ／ 项目对照表 `_crew\项目映射.json` ／ 账本证据（24 小时内、`envelope` 反推）／ 明说没有。
//   ② 看板数据、`/session.json`（会话视图）、运转链**三道口同源**（原来会话视图不传项目，直接读钉子）。
//   ③ 链页顶上加同一条明白话 ＋「改钉并记住」（顺手把"文档目录→代码目录"记进对照表）。
//   ④ 链页刷新 **2 秒 → 1 秒**（服务端缓存 1200ms → 800ms，免得 1 秒轮询拿到同一份）；
//      电流发光加强（常亮的线自带双层 drop-shadow、线加粗、点更密）。
const BUILD_TAG = 'panel@2026-10-22-b218'   // ★ b218（2026-10-22，用户："运转链要实时反应谁干活、谁给谁传了什么"）：每条线新增「最近一次真实传递」（lastEvent / whyEvent：谁→谁、传了什么、多久以前、证据来源）；发卡证据改用 runs\<轮>\tasks\<卡>.dispatch.json 的 mtime（跨转录窗口，修掉"窗口内没发卡"与"编排在跑"自相矛盾）；链路页 tooltip 与侧栏显示"最近一次"。b204（2026-10-19，用户"动工吧"）：**「运转链」页真装上了** —— ① `链路面板.mjs` 按《链路可视化-施工文档》定稿口径重写：**电流＝段常亮（串联连通）＋事件闪＋余辉**（15s/90s/10min 三档），用电器**四态**（干活中/待命/断电/出错，"未知"单列），**一个脚本一格**（闸门族 26 个按文件名动态发现）＋常驻 6，格子大小＝一次活能干多久（**实测用时**定档，测不到按最小档不猜），开盒五块（状态卡/内部零件/**最近一次结果**/**出错现场**/源码摘录）；② `/chain.json` 加 `?full=1`（元件排带上次结果；页面 2 秒轮询用它）；③ 新建 `面板\链路页.js`（原生 DOM＋手写 SVG：闭环电路图＋流动的点＋点击看 why＋元件排＋抽屉＋`#chain` 深链），`index.html` 加一行、`页面.js` 挂真页（替掉占位页）、`页面.css` 追加样式；④ **只在本页可见时轮询**（切走就停）。b131（同日）先把服务端立起来（只读聚合 ＋ 两条只读路由）。b130（2026-10-18，用户两条口径："① 展开按钮这里要精确，而不是鼠标点着一行都展开收缩 ② 红框的位置加一个选择日期的，可以选择范围去看 token 用量，起始日期+结束日期"）：管理页**表1**改成**自搭头** —— ① 不再用原生 `<details>/<summary>`（summary 的激活行为对**它内部任何后代**都生效 ⇒ 点这一行任意位置都收放，而日期框就挂在同一行上、点它必然误触；`pointer-events` 挡不住冒泡）⇒ 头改成普通 `div` ＋ 只认自己的箭头 `span`，**只有箭头能收放**；② 头部右端加**日期范围**（起始 / 结束 ＋ 「全期」复位），**只筛「调用次数 / token 用量」两列**（额度 / 钥匙是厂商级快照，与日期无关），**两个框都空＝全期 ⇒ 与改动前逐字节一致**；范围存 `localStorage`、只重画表体（不碰输入框、不丢焦点、不跳滚动）。数据侧：`看板数据.mjs` 的 `bumpVendor` **多带一份 `byDay`**（按天分项，原始数字）—— **全期口径一个字未改**，界面不筛日期时根本不读它。b126（2026-10-18，用户："你做一个自动新建快捷方式的脚本，然后绑定 dsh桌面端启动器……为了给其他用户用，开源，开箱即用"）：「外壳」＝**装机器**（`_unattended\装外壳.mjs`，幂等/可体检/可卸载）＋ 插件启动钩子（`--autostart`）＋ **看板顶上"首启问一句"提示条**（`/shell.json`、`/shell-action`）。b125（2026-10-18，用户："把这个移动到 API 按钮里，不要放在看板的设置里了"）：「API 额度 / 职位模型」整块**从「设置」页搬到「API」页** —— 只换宿主页（唯一实现仍是 `额度面板.mjs`，判据/写盘/quiet 名单/滚动恢复一个字没动）；顶栏「API」不再进占位页；占位页只剩「运转链」。b124（2026-10-18，用户："不能弄成独立的页面吗？非得弄成网页吗？我想要单独的窗口" ⇒ 澄清"我的意思是看板"）：看板**作为独立窗口**用起来 —— ① `/favicon.ico` 原来**硬返 204**，于是 Edge `--app` 窗口顶着通用图标 ⇒ 现在把 `board.ico` 接上（＋ `index.html` 补 `<link rel="icon">`）；② 桌面补上「班组看板」快捷方式（README 第 19 行早就写着"双击桌面上的「班组看板」"，但**快捷方式从来不存在**）。**没有新运行时**：仍是 Edge `--app`（项目口径：不引框架/不加运行时）。b123（2026-10-18，用户："看板的 API 左边加一个按钮…载体插拔化可以在面板增删配置"）：① 顶栏新增「载体」页（在 API 左边）—— 载体的增/改/删 ＋ 现场自检；写盘纪律＝备份→写→自检→**不过就整体回滚**；② 翻译器改成**按目录动态发现**（`面板\_翻译器.mjs` ＋ 顶层 await）⇒ 加载体不再改 `adapters\index.mjs` / `会话\session.mjs`（那两个原来是"一行一家"的静态表，而每行只有一个载体名、又没引号，**审计脚本抓不到**）；③ 载体的**显示名**从 `_crew\carriers.json` 的 `displayName` 读（`帧数据/帧动作` 里那两张写死的名字表删掉）；④ 公共小工具抽成叶子 `会话\_工具.mjs`（否则动态发现会形成 `session.mjs → carriers → session.mjs` 死锁环 —— 实测 unsettled top-level await、exit 13）。b88（2026-10-16）：「长命资源 ●」那颗灯 —— 登记册核对的**孤儿/属主/死活**三态 ＋ 点一下重查（死了且有 `ensure` 的项才拉起，**从不杀谁**）；面板自身也自登记。b84（2026-10-14，口径更正 —— 用户："真正的意思是**写代码的人不审代码**"）：**剔除旧口径"角色之间模型名必须两两不同"**。① `_agents-config.mjs` 的 `loadConfig()` 那条检查由"任一角色重名就警告"改成**写审分离检查**（写方 `coder-*` / `researcher` / `rescue` × 审、修方 `reviewer` / `rescue`；**两个 coder 同模型不再报警** —— 现状就是同的，旧警告属误报），角色名按 `/^coder/` 约定推导、**不写死名单**；② `额度面板.mjs` 两处"模型名重复"提示（native 分支 ＋ 非 DSH 分支）同步改成写审分离，公共判据抽成模块级 `isWriterRole` / `isCheckerRole` / `clashesWith`；③ 反向验收：把两个 coder 临时改成 reviewer 的模型 ⇒ **两条警告如期报出**，还原后 `agents.json` sha256 逐字节一致；正常配置下**零误报**。b83（2026-10-14，用户拍板"插话＝暂停+继续（杀+续）"）：① **「继续」＝插话**（吃消息框那句话，带进同一条会话续跑）——它本来就已经吃 `text`，这轮补齐的是**杀前抓"它动过的文件"指纹**并把它拼进续跑指令（你的话在前、核对块在后）；② **「发送」＝新会话新派活**（不带续跑旗标 ⇒ 全新会话、不接前文），旧的 `op:'interject'`（发送＝插话预览、**永不执行**）**整段删除**；③ **每格能力由服务端给**（`帧数据.mjs` 的 `capsOf()` **读 `_crew\agents.json`** 判 —— 不写死角色名）⇒ 前端按能力**置灰＋悬停一句说明**，**按钮一个都不删**（用户口径："无效的按钮要保留，防止后续更新"）：messenger 无 `sessionFlag` ⇒「继续」灰、大脑 ⇒「继续」灰（它就是这条会话本身）而「发送」是**真插话**（宿主 steer，与子 agent 的"新会话"不是一回事）；④ 手指纹**只扫"它动过的那几个文件"**（从会话流抠路径 ＋ 逐文件 size/mtime/sha256），**不扫全项目** —— 全项目快照会拖慢掐断、还会混进别人的改动；⑤ ★ 修一个真 bug：`parseCarrierOutput` 遇"整段只有一行 JSON"会把**单个事件**当"单信封"，OpenCode 的 `type:text/part.text/sessionID` 取不到正文与会话号**却仍报 ok** ⇒ 账本收据没会话号 ⇒ **下次续不上**（插话指令短 ⇒ 常只回一行 ⇒ 必踩）；已加回归用例 ㉚/㉛。b73＝**「继续」真执行**（用户拍板"直接花费 token 去做小测试"）：面板那个「继续」原来是**只预览**；现在**两段** —— 点一次＝预览（照真配置拼命令、**不 spawn**，老判据仍成立），**再点一次＝真续跑**（前端带 `execute:true`）。真跑照 `编排.mjs` 同一套路落文件（`runs\<戳>\tasks\<cardId>.{prompt.txt,out.json,err.txt}` ＋ `running\<cardId>.json`）⇒ 面板那格**立刻**显示"在跑"、会话视图边走边读；收活后**删登记 ＋ 补一条账本**（否则"跑完反而从会话里看不见"）。三条硬闸：**正在跑 ⇒ 拒**（不许同一会话两个进程）· 载体没 `sessionFlag` ⇒ 拒 · 会话不在盘上 ⇒ 拒。★★ 真跑撞出一个坑并已修：**续跑进程的 cwd 必须＝会话自己的 cwd** —— Pi 的会话按 cwd 归属，用错它会问 `Fork this session into current directory? [y/N]`，非交互没人回答 ⇒ **当场退出、0 字节**（实测 2 秒、账本记成 ok=false）；权威来源＝会话文件**首行**的 `cwd` 字段。b67＝**只升号＋重启，把跑的那版追上来**（b54–b66 一直没生效）。
/**
 * 大脑"在跑"的判定窗口（秒）—— **必须与 `看板数据.mjs` 的 `BRAIN_RUNNING_WINDOW_SEC` 一致**。
 * 生产者在生成时写死状态，本服务**读取时按当前时刻重算**（见 `freshBrainState`），所以窗口也在这儿留一份。
 * ★ 2026-10-11 用户拍板 **180 → 10**（实测会话转录只在真干活时写、无后台心跳，所以 10 秒不会"永远在跑"）。
 */
const BRAIN_RUNNING_WINDOW_SEC = Number.isFinite(Number(process.env.DSH_BRAIN_WINDOW_SEC))
  ? Number(process.env.DSH_BRAIN_WINDOW_SEC)
  : 10
/** DSH 的会话落盘根（`~\.dsh\sessions`）—— 重算大脑状态要按它找转录文件的真 mtime。 */
const SESS_ROOT = process.env.DSH_SESSIONS_DIR ?? join(homedir(), '.dsh', 'sessions')
/** 日志：**自己写文件**，不靠启动器重定向。
 *  为什么：`Start-Process -RedirectStandardOutput` 会留下句柄，把调用它的那个
 *  PowerShell 会话/后台任务**拖住不返回**（踩过：`panel.ps1` 第二次调用挂死）。
 *  所以启动器**不重定向**，服务自己往 `panel.out.log` 追加。 */
const LOG_FILE = join(HERE, 'panel.out.log')
function log (msg) {
  const line = `[${new Date().toISOString().slice(0, 19).replace('T', ' ')}] ${msg}`
  try { appendFileSync(LOG_FILE, line + '\n', 'utf8') } catch {}
  try { console.log(line) } catch {}
}

/* =============================================================================
 *  ① 共享逻辑核心：**源就是 `面板\core.js` 自己**（C 解耦，2026-10-10）
 *
 *  为什么改：原来这一段是"从 `sidebar-plugin\lib\client.js` 里抠出来、再与 core.js 比"，
 *  于是**面板运行时要依赖旧看板插件的文件**（那个插件已经停用、迟早要归档）。
 *  现在反过来：**以 core.js 为源**；如果旧看板那份还在（未归档），就顺手校一下两边一致，
 *  **不一致只告警、不拦启动**（旧件已经不参与运行，它的对错不该拖住面板）。
 * ========================================================================== */
/** 取一份文本里 `CORE-BEGIN:`/`CORE-END:` 标记之间的那段（剔除标记行）。
 *  ⚠️ 标记行**必须带冒号**（`CORE-BEGIN:`）—— 这样"说明注释"才能留在标记**之外**。
 *  （踩过两次：标记后跟了 4 行说明 ⇒ 多 314 字；标记行带缩进 ⇒ 多 4 个空格。两次都被自校拦住。） */
export function extractCore (text) {
  const b = text.indexOf('// ══ CORE-BEGIN:')
  const e = text.indexOf('// ══ CORE-END:')
  if (b < 0 || e < b) throw new Error('找不到 CORE-BEGIN:/CORE-END: 标记（共享逻辑核心）')
  return text.slice(text.indexOf('\n', b) + 1, e)
}

/** 面板自己的那份核心（**唯一源**）。 */
const coreFile = readFileSync(CORE_JS, 'utf8')
const coreText = extractCore(coreFile)
if (!coreText.includes('__DSH_BOARD_CORE')) {
  const bad = '[面板] ⛔ `面板\\core.js` 的标记区里没有挂载点（__DSH_BOARD_CORE）—— 拒绝启动。'
  log(bad); console.error(bad); process.exit(1)
}
// 旧看板那份（如果还在）：**只告警**。它已不参与运行。
try {
  if (existsSync(CLIENT_JS)) {
    const legacy = extractCore(readFileSync(CLIENT_JS, 'utf8'))
    if (legacy !== coreText) {
      log(`[面板] ⚠️ 旧看板（已停用的 sidebar-plugin\\lib\\client.js）里的核心段与 core.js 不一致` +
        `（${legacy.length} vs ${coreText.length} 字）—— 不影响本面板；` +
        '要同步就跑 `node _probe\\panel-b1\\_patch-core2.mjs`，或直接归档那个目录。')
    }
  }
} catch (e) {
  log('[面板] （旧看板核心段没读到，跳过比对：' + String(e?.message ?? e).slice(0, 80) + '）')
}

/* =============================================================================
 *  ② 看板数据：读文件 + 「过期就后台刷一次」（stale-while-revalidate）
 * ========================================================================== */
let refreshInFlight = false
let lastFailAt = 0
let lastProject = null

function maybeRefresh (wantProject) {
  if (refreshInFlight) return false
  const norm = (s) => String(s ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  const project = (() => {
    const v = String(wantProject ?? '').trim()
    if (!v) return null
    try { return statSync(v).isDirectory() ? v : null } catch { return null }
  })()
  const changed = Boolean(project) && norm(project) !== norm(lastProject)
  if (Date.now() - lastFailAt < TTL_SEC * 1000 && !changed) return false
  let ageSec = Infinity
  try { ageSec = (Date.now() - statSync(DATA_FILE).mtimeMs) / 1000 } catch { ageSec = Infinity }
  if (ageSec < TTL_SEC && !changed) return false
  if (!existsSync(PRODUCER_FILE)) {
    console.warn(`[面板] 看板数据过期但找不到生产者：${PRODUCER_FILE}`)
    lastFailAt = Date.now()
    return false
  }
  refreshInFlight = true
  const release = () => { refreshInFlight = false }
  try {
    const args = [PRODUCER_FILE, '--quiet']
    if (project) args.push('--project', project)
    const child = spawn(NODE_EXE, args, { cwd: dirname(PRODUCER_FILE), detached: true, windowsHide: true, stdio: 'ignore' })
    child.once('error', (e) => { console.warn('[面板] 后台刷新失败（接口照常返回旧数据）：' + String(e?.message ?? e)); lastFailAt = Date.now(); release() })
    child.once('exit', release)
    child.unref()
    lastProject = project ?? lastProject
  } catch (e) { lastFailAt = Date.now(); release() }
  try { const t = setTimeout(release, 120000); t.unref?.() } catch {}
  return true
}

function readBoardData () {
  try {
    const d = JSON.parse(readFileSync(DATA_FILE, 'utf8').replace(/^\uFEFF/, ''))
    freshBrainState(d)
    return { ok: true, generatedAt: new Date().toISOString(), source: DATA_FILE, data: d }
  } catch (e) {
    return {
      ok: false,
      generatedAt: new Date().toISOString(),
      source: DATA_FILE,
      reason: `读不到看板数据（${String(e?.code ?? e?.message ?? e)}）`,
      hint: '手动跑一次 `node _unattended\\看板数据.mjs` 即可（之后由本服务按 TTL 自动刷）'
    }
  }
}

/**
 * ★ 2026-10-11（用户报障："我刚刚没给你发消息的时候，状态也是在跑，是不是同步时间太长了"）：
 * `看板数据.mjs` 把**大脑状态**在生成那一刻就写死了（`brainRow.state` / `stateReason` 里那句"…秒前"）——
 * 而数据有 **60 秒 TTL**，这 60 秒里面板反复读同一份 ⇒ **状态和那句相对时间都是陈旧的**。
 * ⇒ 读取时**按当前时刻重算**：拿会话转录文件的**真 mtime** 现场算年龄，再定状态。
 * 这样"在跑"的寿命 = 判定窗口本身（下面那个常量），不再额外叠那 60 秒。
 *
 * ⚠️ 三个坑（我都踩过，别再踩）：
 *   ① `brainRow` **没有 `sessionPath` / `found` 字段**（实测键列表里没有）⇒ 路径得**自己算**：
 *      用 `projectPath` 按 DSH 的目录编码规则算出 sessions 目录名（同 `看板数据.mjs` 的 `encodeSessionDir`）。
 *   ② **必须按"转录文件的 mtime"挑最新那条** —— 目录 mtime 只在增删文件时变（实测差 4.5 小时：目录停在旧时刻、
 *      转录却刚写过）⇒ 拿目录 mtime 算会把"刚在写"判成"停着"。且要**限定在真源名单内**、**排掉空会话**，
 *      否则会挑到别的会话（与生产者同一套口径，见 `看板数据.mjs` 的大脑袋块）。
 *   ③ 只改**展示口径**（`state` / `stateReason` / `roundsText`），**不动**其它字段；
 *      取不到就原样返回（宁可不改，也不编一个数）。
 */
function freshBrainState (d) {
  try {
    const br = d?.brainRow
    if (!br) return
    const pj = String(br.projectPath ?? d?.currentProject?.path ?? '').trim()
    if (!pj) return
    /* ★ 2026-10-11（用户报障："**状态也不匹配，明明应该是绿灯**"）——**判据换掉**：
     *   老判据＝"转录文件最后写入多少秒前（窗口 10s）"，而**模型思考期间一个事件都不写**
     *   （用户看到 DSH 那边"深度求索中，用时 2分31秒"，面板却报"空闲"）。
     *   新判据＝**最近的轮次标记**（`turn/start` ⇒ 在跑；`turn/end` ⇒ 停着），见 `大脑会话.mjs` 的 `turnStateOf`。
     *   ⚠️ 它是**同步**的（只读转录尾巴往回几帧，实测 4ms）⇒ 这条读取路径**不必改成 async**。
     *   ⚠️ 它自己知道"哪条是大脑"（`brainRow.sessionPath`，2026-10-11 补的字段）——**不在这里重挑一遍**。 */
    const bt = brainTurnState()
    if (bt.ok) {
      br.state = bt.running ? 'running' : 'idle'
      br.stateReason = (bt.running ? '干着' : '停着') + '：' + bt.why
      if (bt.ageSec != null) br.lastWriteSecAgo = bt.ageSec
      if (typeof br.roundsText === 'string' && br.roundsText.includes('·')) {
        br.roundsText = br.roundsText.replace(/^\S+/, bt.running ? '干着' : '停着')
      }
      d.brainRowFreshAt = new Date().toISOString()
      d.brainStateJudge = '轮次标记（turn/start｜turn/end）'
      return
    }
    /* ② 退回老判据（"转录最后写入"窗口）—— 把**为什么退回**如实记下（不许假装新判据生效了） */
    const dir = join(SESS_ROOT, encodeSessionDir(pj))
    let cands = []
    try {
      const ids = workspaceSessionIds(pj)          // 真源名单（去归档）；拿不到就退化成"目录内全部"
      for (const s of readdirSync(dir)) {
        const p = join(dir, s)
        const ms = transcriptMtimeSize(p)
        if (!ms) continue
        const id = String(s).replace(/^session-/, '')
        if (ids && !ids.includes(id)) continue
        if (ms.size <= 0) continue                  // 空转录不算（与生产者一致）
        cands.push({ m: ms.mtimeMs })
      }
    } catch { /* 目录不在 → 原样返回 */ }
    if (!cands.length) return
    cands.sort((a, b) => b.m - a.m)                // 最新写入的那条＝大脑
    const sec = Math.round((Date.now() - cands[0].m) / 1000)
    const running = sec < BRAIN_RUNNING_WINDOW_SEC
    br.state = running ? 'running' : 'idle'
    br.stateReason = `${running ? '干着' : '停着'}：会话日志最后写入 ${sec}s 前（**退回**老判据，窗口 ${BRAIN_RUNNING_WINDOW_SEC}s —— 新判据看不出：${String(bt.why).slice(0, 80)}）`
    br.lastWriteSecAgo = sec
    if (typeof br.roundsText === 'string' && br.roundsText.includes('·')) {
      br.roundsText = br.roundsText.replace(/^\S+/, running ? '干着' : '停着')
    }
    d.brainRowFreshAt = new Date().toISOString()
    d.brainStateJudge = '退回：转录最后写入窗口（' + String(bt.why).slice(0, 60) + '）'
  } catch { /* 重算失败 → 保留原样 */ }
}

/** 读某条会话的转录 {mtimeMs,size}：**优先转录文件**（目录 mtime 只在增删文件时变，会骗人）。与生产者同口径。 */
function transcriptMtimeSize (entryPath) {
  for (const name of ['session.v4.jsonl.zstd', 'session.jsonl', 'session.v4.jsonl']) {
    try { const st = statSync(join(entryPath, name)); return { mtimeMs: st.mtimeMs, size: st.size } } catch { /* 试下一个 */ }
  }
  return null
}

/** 某工作区的会话 id 名单（真源 `workspace.json` 的 sessionIds 去归档）。取不到返回 null（调用方退化）。 */
function workspaceSessionIds (projectPath) {
  try {
    const store = process.env.DSH_WORKSPACE_STORE ?? join(homedir(), '.dsh', 'storages', 'workspace.json')
    const w = JSON.parse(readFileSync(store, 'utf8').replace(/^\uFEFF/, ''))
    const arch = new Set((w?.global?.archivedSessionIds ?? []).map((x) => String(x).replace(/^session-/, '')))
    const nz = (x) => String(x ?? '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase()
    const hit = Object.values(w?.tables?.workspaces ?? {}).find((v) => nz(v?.path) === nz(projectPath))
    if (!hit) return null
    return (hit.sessionIds ?? []).map((x) => String(x).replace(/^session-/, '')).filter((id) => !arch.has(id))
  } catch { return null }
}

/** DSH 的 `sessions\<目录名>` ＝ cwd 的编码（`~XXXX` = 该字符 UTF-16 码位、大写十六进制）。与 `看板数据.mjs` 同一套。 */
function encodeSessionDir (cwd) {
  const enc = (s) => { let o = ''; for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); o += c > 127 ? '~' + c.toString(16).toUpperCase().padStart(4, '0') : s[i] } return o }
  const segs = String(cwd).split(/[\\/]+/).filter(Boolean).map((s) => s.replace(/:$/, ''))
  return '--' + segs.map(enc).join('-') + '--'
}

/* =============================================================================
 *  ③ 跑一轮（与看板上的「▶ 开始/■ 停」同一条路）
 *
 *  锁名的唯一权威 = `_lock.mjs` 的 `LOCK_FILE` = `<项目>\_crew\crew.lock`
 *  （旧看板踩过：以前读 `orchestrator.lock`，全仓没人写那个名字 ⇒ 恒显示"没在跑"）
 * ========================================================================== */
function alivePid (pid) {
  const n = Number(pid)
  if (!Number.isFinite(n) || n <= 0) return false
  try { process.kill(n, 0); return true } catch { return false }
}

function readLockOf (project) {
  try {
    const l = JSON.parse(readFileSync(join(project, '_crew', 'crew.lock'), 'utf8'))
    return { ...l, alive: alivePid(l.pid) }
  } catch { return null }
}

function resolveRunProject (hint) {
  const cands = []
  if (hint) cands.push(hint)
  try { cands.push(String(readFileSync(join(ROOT, '_crew', '当前项目.txt'), 'utf8')).trim()) } catch {}
  try { const d = JSON.parse(readFileSync(DATA_FILE, 'utf8')); if (d?.currentProject?.path) cands.push(String(d.currentProject.path)) } catch {}
  for (const c of cands) {
    const v = String(c ?? '').trim()
    if (!v) continue
    try { if (statSync(v).isDirectory()) return v } catch {}
  }
  return null
}

function runControl (op, hintProject) {
  const project = resolveRunProject(hintProject)
  if (!project) return { ok: false, error: '认不出要跑哪个项目：面板没给、_crew\\当前项目.txt 没有、看板数据里也没有' }
  const lock = readLockOf(project)
  const running = Boolean(lock?.alive)
  const logFile = join(project, '_crew', 'panel-run.log')

  if (op === 'status') return { ok: true, running, pid: running ? lock.pid : null, project, log: logFile, orch: ORCH_FILE }

  if (op === 'stop') {
    if (!running) return { ok: false, running: false, error: '现在没有在跑的编排（锁文件里没有活着的进程）', project }
    try {
      process.kill(Number(lock.pid))
      return { ok: true, running: false, stopped: lock.pid, project, note: '已发出停止信号；它的子进程（载体）会随之结束' }
    } catch (e) { return { ok: false, running: true, error: `停不下来：${String(e?.message ?? e)}（可能要人工看进程）`, project } }
  }

  if (op === 'start') {
    if (running) return { ok: false, running: true, error: `已经有一个编排在跑（pid ${lock.pid}）—— 编排自己会拒绝起第二个`, pid: lock.pid, project }
    if (!existsSync(ORCH_FILE)) return { ok: false, error: `找不到编排脚本：${ORCH_FILE}` }
    try {
      mkdirSync(join(project, '_crew'), { recursive: true })
      const out = openSync(logFile, 'a')
      const child = spawn(NODE_EXE, [ORCH_FILE, '--project', project, '--execute'], {
        cwd: dirname(ORCH_FILE),
        detached: true,
        windowsHide: true,
        stdio: ['ignore', out, out]      // ⚠️ 输出落文件，绝不接管道
      })
      child.once('error', () => {})
      child.unref()
      return { ok: true, running: true, pid: child.pid, project, log: logFile, note: '已启动（跑完这一轮它自己会跑门禁 + 拉审核员）' }
    } catch (e) { return { ok: false, error: `启动失败：${String(e?.message ?? e)}` } }
  }

  return { ok: false, error: `未知操作：${op}（可用 start / stop / status）` }
}

/* =============================================================================
 *  ③b 工具服务（19400）—— **只是"看状态 + 能拉起"**，生命周期归 DSH（用户 2026-10-11 拍板）
 *
 *  口径：面板**不负责**它的生死（那是 `dsh-crew-bridge` 插件随 DSH 自启的事）；
 *        这里只做两件：① 探活出灯 ② 红灯时点一下能把它拉起来。
 *  ⚠️ 探活＝**调 `确保工具服务.mjs --probe --json`**（单一实现，别在面板里再写一套探活 —— 会漂）。
 *     它会有 ~120ms 的 node 启动开销 ⇒ **加 5 秒缓存**（页面 15 秒轮询，别每次都 spawn）。
 * ========================================================================== */
const TOOL_PORT = Number(process.env.DSH_TOOL_PORT ?? 19400)
const ENSURE_TOOL = process.env.DSH_ENSURE_TOOL ?? join(HERE, '..', '确保工具服务.mjs')
let toolCache = { at: 0, val: null }

/** 跑一次「确保工具服务」：`probe` 只查、否则查不到就拉起。 */
function toolServiceRun (probe) {
  return new Promise((resolve) => {
    const args = [ENSURE_TOOL, '--json']
    if (probe) args.push('--probe')
    let out = '', err = ''
    let child
    try {
      child = spawn(NODE_EXE, args, { cwd: dirname(ENSURE_TOOL), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return resolve({ state: 'red', why: String(e?.message ?? e), ok: false })
    }
    const t = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 9000)
    child.stdout?.on('data', (c) => { out += c.toString('utf8') })
    child.stderr?.on('data', (c) => { err += c.toString('utf8') })
    child.on('error', (e) => { clearTimeout(t); resolve({ state: 'red', why: String(e?.message ?? e), ok: false }) })
    child.on('close', () => {
      clearTimeout(t)
      let j = null
      try { j = JSON.parse(String(out).trim().split('\n').pop() || 'null') } catch {}
      resolve(j ?? { state: 'red', why: (err || out || '没拿到探活结果').slice(0, 200), ok: false })
    })
  })
}

/**
 * ★★ b48（方法 B · 用户口径："这个B最小版要绑定在班组看板里最好，这样班组看板打开，同时路由也跟着起来，
 *   黑框要隐藏，和 看板 工具服务 一样"）——**路由网关**的探活/拉起，套路与「工具服务」完全一致：
 *   面板被轮询 `/health` 时顺手探一次；没起来就 **detached + windowsHide** 拉起来（**没有黑框**、不随面板退出而死）。
 *   ⚠️ 失败策略＝**A（失败要响）**：网关不在时**不回落直连**，让载体直接失败并在回话里写清原因。
 */
const ROUTER_PORT = Number(process.env.DSH_ROUTER_PORT ?? 19420)
let routerCache = { at: 0, val: null }
async function routerStatus (force = false) {
  if (!force && routerCache.val && Date.now() - routerCache.at < 5000) return { ...routerCache.val, cached: true }
  const probe = async () => {
    try { const r = await fetch(`http://127.0.0.1:${ROUTER_PORT}/health`, { signal: AbortSignal.timeout(2000) }); return r.ok ? await r.json() : null } catch { return null }
  }
  let h = await probe()
  if (!h) {   // 没起来 ⇒ 拉起来（隐藏窗口，和工具服务一样）
    try {
      const gw = join(HERE, '..', '路由网关.mjs')
      const c = spawn(NODE_EXE, [gw, '--port', String(ROUTER_PORT)], { cwd: dirname(gw), detached: true, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] })
      c.unref()
      for (let i = 0; i < 16 && !h; i++) { await new Promise((r) => setTimeout(r, 250)); h = await probe() }
    } catch (e) { h = null }
  }
  const val = h
    ? { ok: true, state: 'green', port: h.port ?? ROUTER_PORT, homes: h.homes ?? [], hits: h.hits ?? {}, uptimeSec: h.uptimeSec ?? null, at: new Date().toISOString() }
    : { ok: true, state: 'red', port: ROUTER_PORT, why: '路由网关没在跑（' + ROUTER_PORT + ' 没人听）—— 走网关的载体（Qwen Code）现在会**直接失败**，不回落直连', at: new Date().toISOString() }
  routerCache = { at: Date.now(), val }
  // ★ b88：网关**是面板拉起来的**（见上）⇒ 这里顺手把它登记进长命资源册（写的人仍是 `登记服务.mjs`）。
  if (h) {
    try { longliveUp({ name: '路由网关', kind: 'http', port: ROUTER_PORT, pid: await longlivePortOwner(ROUTER_PORT), logFile: join(UNATTENDED, 'logs', '路由网关.log'), ensure: '确保路由.mjs', owner: '工作台', note: '跟着班组看板起来（面板探活/拉起时登记）' }) } catch {}
    pokeInspection('事件:面板(网关)')   // ★ b91「谁动谁叫」：刚登记完网关 ⇒ 叫一声巡检（不等待）
  }
  return val
}

/** 工具服务状态（带 5 秒缓存）。`force` ＝ 绕过缓存（点了灯之后要立刻看到真结果）。 */
async function toolServiceStatus (force = false) {
  if (!force && toolCache.val && Date.now() - toolCache.at < 5000) return { ...toolCache.val, cached: true }
  const j = await toolServiceRun(true)
  const val = { ok: true, port: TOOL_PORT, state: j.state === 'green' ? 'green' : 'red', tools: j.tools ?? null, why: j.why ?? null, at: new Date().toISOString() }
  toolCache = { at: Date.now(), val }
  return val
}

/**
 * ★★ b88（长命资源 C）／b91（轻分离）：**「长命资源 ●」那颗灯的判据** —— 登记册里的项是不是还对得上现实，
 *   以及**有没有未登记的监听进程（孤儿）**。
 *   · 绿＝登记的都一致；**黄＝有孤儿或端口属主不符**（点名是谁、听哪个口）；红＝登记为"该活着"的死了。
 *   · 判据仍然只有一处：`登记服务.mjs` 的 `verify()`（pid 活性 ＋ 端口属主 ＋ 孤儿）。
 *   · ⚠️ **b91 起面板不自己跑 verify**，改问 `长命资源巡检.mjs`（那个"跑一次就退"的工具，且是状态文件的唯一写方）：
 *     默认 `--if-stale 60`（一分钟内刚核过就直接用它 ⇒ 面板不再跟着 15 秒轮询重复打那个 0.72 秒的电话）；
 *     点灯/`force` 才 `--force` 真核。这样**面板、看护、看板、体检读的是同一份结论**。
 *   · ⚠️ 面板**不擅自杀谁**（杀是交接/显式 `down` 的事，要留痕）—— 这里只"看 ＋ 拉起死了的"。
 */
const LONGLIVE_CACHE_MS = 10000
let longliveCache = { at: 0, val: null }
async function longliveStatus (force = false) {
  if (!force && longliveCache.val && Date.now() - longliveCache.at < LONGLIVE_CACHE_MS) return { ...longliveCache.val, cached: true }
  const args = [join(UNATTENDED, '长命资源巡检.mjs'), '--json', '--quiet', '--by', '面板']
  if (force) args.push('--force'); else args.push('--if-stale', '60')
  const r = await runNode(args, 90000)
  let v = null
  const raw = String(r.out ?? '').replace(/^\uFEFF/, '').trim()
  try { v = JSON.parse(raw) } catch { try { v = JSON.parse(raw.split('\n').pop()) } catch {} }
  if (!v) v = { state: 'unknown', at: new Date().toISOString(), items: [], dead: [], mismatch: [], orphans: [], counts: {}, why: (String(r.err ?? '').trim().split('\n').filter(Boolean).pop() ?? ('exit=' + r.code)).slice(0, 160) }
  const val = { ok: v.state === 'green', ...v, at2: new Date().toISOString() }
  longliveCache = { at: Date.now(), val }
  return val
}

/** 跑一个"确保"脚本并等它结束（收法与 `toolServiceRun` 同一套：**输出不接管道**）。 */
function runEnsureScript (script, timeoutMs = 60000) {
  return runNode([script], timeoutMs)
}

/** 跑一个 node 脚本、收回它的 stdout/stderr 与退出码（**绝不接管道**：管道会 exit 42 / 零输出）。 */
function runNode (args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    let out = '', err = ''
    let child
    try { child = spawn(NODE_EXE, args, { cwd: dirname(args[0]), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }) }
    catch (e) { return resolve({ code: -1, out: '', err: String(e?.message ?? e) }) }
    const t = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, timeoutMs)
    child.stdout?.on('data', (c) => { out += c.toString('utf8') })
    child.stderr?.on('data', (c) => { err += c.toString('utf8') })
    child.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out, err: String(e?.message ?? e) }) })
    child.on('close', (code) => { clearTimeout(t); resolve({ code, out, err }) })
  })
}

/**
 * ★ b88（新问题稿 D 条）：**看板固定一块「🧾 收据外改动」** —— 与「🔴 待你处理」并列。
 *   治的病：2026-10-12 大脑绕过班组改了 6 个文件，`_crew\runs\` 当天 0 条 ⇒ 无卡/无回执/无门禁，
 *   而**看板、账本、门禁全是绿的** —— "违反了规则"这件事**不产生任何可观测信号**。
 *   判据全在 `_unattended\无收据改动.mjs`（面板**不自己判**，免得两套口径）。
 *   · 绿＝窗口内被动过的代码都有收据｜黄＝有但全豁免｜红＝有未豁免的｜灰＝算不出来（**未知≠红**）。
 *   · 60 秒缓存：它要扫一遍项目（~60ms，只比 size+mtime），别跟着 15 秒轮询空跑。
 */
const NO_RECEIPT_CACHE_MS = 60000
let noReceiptCache = { at: 0, val: null, key: '' }
async function noReceiptStatus (force = false, project = null) {
  const key = String(project ?? '')
  if (!force && noReceiptCache.val && noReceiptCache.key === key && Date.now() - noReceiptCache.at < NO_RECEIPT_CACHE_MS) return { ...noReceiptCache.val, cached: true }
  const args = [join(UNATTENDED, '无收据改动.mjs'), '--json']
  if (project) args.push('--project', project)
  const r = await runNode(args, 120000)
  let val
  if (r.code === 0 || r.code === 2 || r.code === 3) {
    // ⚠️ 解析口径：`无收据改动.mjs --json` 是**美化过的多行 JSON** ⇒ **必须先试整段**，
    //    取"最后一行"只会拿到一个 `}`（b88 实测踩到：端点回 unknown"Unexpected token '}'"）。
    const raw = String(r.out).replace(/^\uFEFF/, '').trim()
    let j = null
    try { j = JSON.parse(raw) } catch { try { j = JSON.parse(raw.split('\n').pop()) } catch {} }
    val = j ? { ok: j.state === 'green', ...j } : { ok: false, state: 'unknown', why: '输出解析失败（既不是整段 JSON，也不是单行 JSON）' }
  } else {
    const why = String(r.err).trim().split('\n').filter(Boolean).pop() ?? `exit=${r.code}`
    val = { ok: false, state: 'unknown', why: why.slice(0, 200) }
  }
  noReceiptCache = { at: Date.now(), val, key }
  return val
}

/** 点那颗灯：**只做两件事** —— 重查 ＋ 把"登记为该活着却死了、且有 `ensure` 脚本"的项拉起来。**不杀任何东西**。 */
async function longliveAction () {
  const before = await longliveStatus(true)
  const revived = []
  for (const d of before.dead ?? []) {
    if (!d.ensure) { revived.push({ name: d.name, ok: false, why: '登记里没写 ensure 脚本 ⇒ 不知道该怎么拉起（手工处理）' }); continue }
    const script = join(UNATTENDED, d.ensure)
    if (!existsSync(script)) { revived.push({ name: d.name, ok: false, why: `ensure 脚本不存在：${script}` }); continue }
    try {
      const out = await runEnsureScript(script)
      const last = String(out?.out ?? '').trim().split('\n').pop() ?? ''
      revived.push({ name: d.name, ok: true, tail: last.slice(0, 200) })
    } catch (e) { revived.push({ name: d.name, ok: false, why: String(e?.message ?? e) }) }
  }
  longliveCache = { at: 0, val: null }
  const after = await longliveStatus(true)
  return { ok: after.state !== 'red', state: after.state, verdict: after.verdict, orphans: after.orphans, dead: after.dead, mismatch: after.mismatch, revived, kept: '孤儿一律**只报告、不擅自杀**（要停谁：`登记服务.mjs down --name <名>` 或换会话交接时点名）' }
}

/* =============================================================================
 *  ④ HTTP
 * ========================================================================== */
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'          // ★ b124：桌面窗口（Edge `--app`）的图标走这个口
}
const json = (res, code, obj) => {
  try {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(obj))
  } catch {}
}
/**
 * 写请求被权限闸拒绝时的统一回应（§十：状态区只读 / 配置区必须走网关 / 操作区必须走命令）。
 * 这里**不再回 200 + 假成功** —— 拒绝就要看得见。
 */
function json403 (res, pathname) {
  return json(res, 403, {
    ok: false,
    error: '该区域不允许这种写操作（状态区只读；配置区走配置网关；操作区走 C 服务命令）',
    route: pathname
  })
}

// ★ 2026-10-26（§十）：`guardLocal()` 已删除 —— 它只做"来源是不是本机"，
//   而本机就能改任何东西正是要治的病。来源检查与区域判定都并进 `权限闸.mjs` 的 `guardWrite()`。
function readBody (req) {
  return new Promise((resolve) => {
    let s = ''
    req.on('data', (d) => { s += d; if (s.length > (1 << 20)) { try { req.destroy() } catch {} resolve(s) } })
    req.on('end', () => resolve(s))
    req.on('error', () => resolve(s))
  })
}
function serveFile (res, full, type) {
  try {
    const body = readFileSync(full)
    res.writeHead(200, { 'Content-Type': type ?? MIME[extname(full)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    res.end(body)
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end('404')
  }
}

/* ══ 2026-10-26（用户要求）：面板自检 —— "磁盘上的代码" 与 "正在跑的代码" 一致吗？
   顶栏那盏灯靠它：绿＝一致；黄＝磁盘更新了（该点「重启」）。
   指纹 = 被 import 的那些文件的 mtimeMs 逐文件对比（service.mjs + 面板目录所有 .mjs + 页面.js/.css + core.js）。
   只比 mtime，不读内容 —— 够快；要精确到字节是体检脚本的事。 */
const PANEL_SELF = (() => {
  const listFiles = () => {
    const out = [join(HERE, 'service.mjs'), join(HERE, '页面.js'), join(HERE, '页面.css'), join(HERE, 'core.js')]
    try { for (const f of readdirSync(HERE)) if (/\.mjs$/.test(f)) out.push(join(HERE, f)) } catch {}
    return out
  }
  const snap = () => {
    const m = new Map()
    for (const f of listFiles()) {
      try { m.set(f, Math.round(statSync(f).mtimeMs)) } catch {}
    }
    return m
  }
  const atBoot = snap()
  return {
    startedAt: new Date().toISOString(),
    pid: process.pid,
    port: PORT,
    bootCount: atBoot.size,
    /** 现算：谁比启动时新 */
    check: () => {
      const now = snap()
      const newer = []
      for (const [f, m] of now) {
        const was = atBoot.get(f)
        if (was !== undefined && m > was) newer.push(f.split(/[\\/]/).pop())
      }
      return {
        needRestart: newer.length > 0,
        newer,
        files: now.size,
        startedAt: new Date().toISOString()
      }
    }
  }
})()

const server = createServer(async (req, res) => {
  let pathname = '/'
  try { pathname = new URL(String(req.url ?? '/'), 'http://127.0.0.1').pathname } catch {}
  const url = (() => { try { return new URL(String(req.url ?? '/'), 'http://127.0.0.1') } catch { return null } })()

  // ── 只读：看板数据（路径照抄旧名 `/board-data.json`，前端 fetch 少改）────────
  if (pathname === '/board-data.json' || pathname === '/board') {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只接受 GET' })
    maybeRefresh(url?.searchParams.get('project'))
    return json(res, 200, readBoardData())
  }

  // ── 共享逻辑核心（经典脚本；与 client.js 标记区逐字节一致，启动时已自校）──
  if (pathname === '/core.js') return serveFile(res, CORE_JS, MIME['.js'])

  // ── 写操作：钥匙 / 职位模型 / 优先级 / 检测（路径照抄旧名）────────────────
  if (pathname === '/api-keys') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只接受 POST' })
    if (!(await guardWrite({ req, res, pathname })).ok) return json403(res, pathname)
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }) }
    try {
      const r = await quotaHandle(String(body.op ?? 'list'), body.payload && typeof body.payload === 'object' ? body.payload : {})
      return json(res, 200, r)
    } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }

  // ── ★ 2026-10-23（施工文档 D18）：调参建议 采纳 / 忽略 ─────────────────────
  //   看板那一格「🧠 大脑建议（只看不改）」的按钮打到这里；真正的写在 `调参.mjs`（面板不自己改参数）。
  if (pathname === '/api-tune') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只接受 POST' })
    if (!(await guardWrite({ req, res, pathname })).ok) return json403(res, pathname)
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }) }
    const op = String(body.op ?? 'latest')
    const proj = String(body.project ?? '').trim() || readBoardData()?.currentProject?.path || ''
    if (!proj) return json(res, 400, { ok: false, error: '没有项目（先在看板上钉一个项目）' })
    const tune = join(dirname(fileURLToPath(import.meta.url)), '..', '调参.mjs')
    const args = [tune, '--project', proj, '--json']
    if (op === 'accept') args.push('--accept')
    else if (op === 'ignore') {
      args.push('--ignore')
      if (body.reason) args.push('--reason', String(body.reason))
    } else args.push('--latest')
    try {
      const r = await runNode(args, 30_000)
      let j = null
      try { j = JSON.parse(String(r.out ?? '').trim()) } catch { j = null }
      if (!j) return json(res, 500, { ok: false, error: '调参脚本没回 JSON：' + String(r.err ?? '').slice(-160) })
      return json(res, 200, j)
    } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }

  // ── 跑一轮：开始 / 停 / 状态 ──────────────────────────────────────────────
  if (pathname === '/run') {    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只接受 POST' })
    if (!(await guardWrite({ req, res, pathname })).ok) return json403(res, pathname)
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { ok: false, error: '请求体不是 JSON' }) }
    return json(res, 200, runControl(String(body.op ?? 'status'), String(body.project ?? '').trim()))
  }

  // ── 工具服务（19400）状态 + 拉起（看板顶部「工具服务 ●」用）────────────────
  //   注意：面板**不管它的生死**（那是插件随 DSH 自启的事）；这里只"看状态 + 红灯时拉起"。
  // ★★ b48：**路由网关（19420）状态 + 拉起**（看板顶部再加一颗「路由 ●」，和「工具服务 ●」并排）。
  //   与工具服务不同的一点：**网关是面板拉起来的**（用户口径"班组看板打开，同时路由也跟着起来"），
  //   黑框隐藏（detached + windowsHide）。失败策略 A：红灯＝走网关的载体直接失败，**不回落直连**。
  if (pathname === '/router.json') {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只接受 GET' })
    try { return json(res, 200, await routerStatus(url?.searchParams.get('force') === '1')) } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  if (pathname === '/relay.json') {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只接受 GET' })
    try { return json(res, 200, await toolServiceStatus(url?.searchParams.get('force') === '1')) } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  // ── ★★ b88：长命资源（登记册的核对结果）—— 看板顶部「长命资源 ●」用 ──────────
  //   绿＝一致｜黄＝有孤儿 / 端口属主不符（点名）｜红＝登记为该活着的死了。判据全在 `登记服务.mjs`。
  if (pathname === '/longlive.json') {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只接受 GET' })
    try { return json(res, 200, await longliveStatus(url?.searchParams.get('force') === '1')) } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  if (pathname === '/longlive-action') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只接受 POST' })
    if (!(await guardWrite({ req, res, pathname })).ok) return json403(res, pathname)
    try { return json(res, 200, await longliveAction()) } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  // ── ★★ b88：**「🧾 收据外改动」**（看板固定一块）—— 判据在 `无收据改动.mjs` ──────────
  if (pathname === '/no-receipt.json') {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只接受 GET' })
    try {
      const pj = String(url?.searchParams.get('project') ?? '').trim() || null
      return json(res, 200, await noReceiptStatus(url?.searchParams.get('force') === '1', pj))
    } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  // ── ★★ b123：**「载体」页**（用户 2026-10-18："看板的 API 左边加一个按钮…载体插拔化可以在面板增删配置"）
  //   只读视图 ＋ 增/改/删；写盘的纪律（备份→写→自检→不过就回滚）全在 `载体面板.mjs` 里，这里只转手。
  if (pathname === '/carriers.json') {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只接受 GET' })
    try { return json(res, 200, carriersView()) } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  // ── ★ b197（施工文档 §四 D7）：**「✏️ 改规矩」** —— 规矩文件（brain/班组须知/细则）在页面上直接改。
  //   四条要求全在 `规矩面板.mjs` 里落地：① 红灯分两类（这一页只管**规则类**）② 改前自动备份
  //   ③ 改后必跑体检、不过就整体回滚（红灯不灭）④ diff 对照表。这里只转手 ＋ 记审计。
  if (pathname === '/rules.json') {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只接受 GET' })
    try { return json(res, 200, rulesView()) } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  // ── ★ b131：**「运转链」页**（用户 2026-10-19：把大脑/coder/脚本/编排/工具摆成电路图，**要看到电流**）
  //   只读两件事：`/chain.json`（电路图每 2 秒同步一次）＋ `/chain-detail?id=`（点开某个用电器的内部零件）。
  //   判据与证据全在 `链路面板.mjs`；这里只转手 ＋ 把**工具服务的探活结论**（`/relay.json` 那套，5 秒缓存）
  //   递进去 —— 免得那一页另立一套"工具服务在不在"的标准（登记册里那句"登记为已停"是过期话）。
  if (pathname === '/chain.json') {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只接受 GET' })
    // ★ b209：**这一页也要把看板数据续上** —— 运转链靠 board-data 判「载体在不在干活」，
    //   而看板数据只有「看板」页在拉；切到运转链以后 60 秒就没人重算，角色状态与"看板"那两段会旧。
    //   （只读、非阻塞；`maybeRefresh` 自己有 TTL，不会每 1 秒都去 spawn。）
    try { maybeRefresh(url?.searchParams.get('project')) } catch {}
    try {
      let tool = null
      try { tool = await toolServiceStatus(false) } catch { tool = null }
      // `?full=1`：元件排**带最近结果**（退出码/用时/输出尾），页面 2 秒轮询用的就是这个；
      // 不带 full 的轻量版给 CLI/别的消费者（少 32 条 lastRun，快一点）。
      return json(res, 200, chainView({ tool, buildTag: BUILD_TAG, full: url?.searchParams.get('full') === '1' }))
    } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  if (pathname === '/chain-detail') {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只接受 GET' })
    try { return json(res, 200, chainDetail(String(url?.searchParams.get('id') ?? ''))) } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  if (pathname === '/rules-action') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只接受 POST' })
    if (!(await guardWrite({ req, res, pathname })).ok) return json403(res, pathname)
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }) }
    const op = String(body.op ?? '')
    try {
      const r = rulesAction(op, body)
      try {
        appendFileSync(join(HERE, 'panel-actions.jsonl'), JSON.stringify({
          at: new Date().toISOString(), by: '面板', op: 'rules-' + op, id: body.key ?? null, ok: r.ok, why: r.ok ? null : r.error,
          added: r.diff?.added ?? null, removed: r.diff?.removed ?? null, rolledBack: !!r.rolledBack
        }) + '\n', 'utf8')
      } catch {}
      return json(res, r.ok ? 200 : 400, r)
    } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  if (pathname === '/carriers-action') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只接受 POST' })
    if (!(await guardWrite({ req, res, pathname })).ok) return json403(res, pathname)
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }) }
    const op = String(body.op ?? '')
    try {
      const r = await carriersAction(op, body)
      // 审计一行（与其它面板动作同一套路：谁在什么时候动了什么）
      try {
        appendFileSync(join(HERE, 'panel-actions.jsonl'), JSON.stringify({
          at: new Date().toISOString(), by: '面板', op: 'carriers-' + op, id: body.id ?? null, ok: r.ok, why: r.ok ? null : r.error
        }) + '\n', 'utf8')
      } catch {}
      return json(res, r.ok ? 200 : 400, r)
    } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  // ── ★★ b126：**「外壳」**（桌面/开始菜单快捷方式）—— 用户口径"启动 DSH 就检查桌面有没有快捷方式"。
  //   判据全在 `_unattended\装外壳.mjs`（唯一实现，见那边的头注释）；这里只转手。
  //   `--autostart` 那一档由 `dsh-crew-bridge` 插件在 DSH 启动时跑（**不是这里**）。
  if (pathname === '/shell.json') {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只接受 GET' })
    try { return json(res, 200, shellStatus()) } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  if (pathname === '/shell-action') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只接受 POST' })
    if (!(await guardWrite({ req, res, pathname })).ok) return json403(res, pathname)
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }) }
    try {
      const r = shellAction(body.op)
      try {
        appendFileSync(join(HERE, 'panel-actions.jsonl'), JSON.stringify({
          at: new Date().toISOString(), by: '面板', op: 'shell-' + String(body.op ?? ''), ok: r.ok, why: r.ok ? null : r.error
        }) + '\n', 'utf8')
      } catch {}
      return json(res, r.ok ? 200 : 400, r)
    } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  if (pathname === '/relay-action') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只接受 POST' })
    if (!(await guardWrite({ req, res, pathname })).ok) return json403(res, pathname)
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }) }
    const op = String(body.op ?? 'start')
    try {
      if (op === 'start') {                       // 拉起（幂等：已在跑就什么都不做）
        const j = await toolServiceRun(false)
        toolCache = { at: 0, val: null }          // 结果不吃缓存，下一问现探
        return json(res, 200, { ok: j.state === 'green', state: j.state === 'green' ? 'green' : 'red', started: Boolean(j.started), why: j.why ?? null })
      }
      return json(res, 400, { ok: false, error: `未知操作：${op}（可用 start）` })
    } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }

  // ── 看板页：帧数据（只读聚合）＋ 格动作（暂停=真杀；继续/插话=预览）────────
  if (pathname === '/frames.json') {
    try { return json(res, 200, buildFrames()) } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  // ── 看板页：**某角色的一段会话**（④ 会话视图 · 只读）──────────────────────
  //   把 `<项目>\_crew\tasks\<任务>.prompt.txt`（输入）与账本 envelope 指的 `.out.json`（输出）
  //   用会话级归一化拼成"像自己开的会话"那一段。**纯读盘、不落新状态**。
  if (pathname === '/session.json') {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只接受 GET' })
    const role = String(url?.searchParams.get('role') ?? '').trim()
    if (!role) return json(res, 400, { ok: false, error: '缺少 role' })
    const limit = Math.min(Math.max(Number(url?.searchParams.get('limit') ?? 3) || 3, 1), 20)
    try {
      const { buildSession } = await import('../会话流.mjs')
      // ★ b209（2026-10-20）：**会话视图必须跟"看板正在显示的那个项目"** —— 原来不传 project，
      //   于是 `会话流.mjs` 退回读 `_crew\当前项目.txt`（钉子）。钉子钉的是**文档目录**时
      //   （`…\项目：恋爱军师`，没有 `_crew`）⇒ 五个角色的会话全空，看着像"看板检测不到子 agent"。
      //   现在：先问看板数据（它已经按 `面板\项目定位.mjs` 换算过），拿不到才让 `会话流` 自己兜底。
      let proj = null
      try { proj = JSON.parse(readFileSync(DATA_FILE, 'utf8').replace(/^\uFEFF/, ''))?.currentProject?.path ?? null } catch {}
      return json(res, 200, buildSession(role, { limit, project: proj }))
    } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  // ── 看板页：**大脑（DSH 自己）那格的会话**（只读 · 2026-10-11）──────────────
  //   ⚠️ 与上面五职位那套**不是一条链**：大脑不走编排、不产生 `prompt.txt`/`.out.json`，
  //      它的话在 **DSH 自己的转录**里（`~\.dsh\sessions\…\session.v4.jsonl.zstd`，zstd 帧拼接）。
  //   **读哪一条由 `看板数据.mjs` 定**（`brainRow.sessionId/sessionPath`）—— 与大脑格的
  //   模型/上下文占用**同一个来源**，不在这里另挑一次（两处口径必漂）。
  if (pathname === '/brain-session.json') {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只接受 GET' })
    const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
    try {
      const { brainSession } = await import('./大脑会话.mjs')
      const frames = clamp(Number(url?.searchParams.get('frames') ?? 60) || 60, 5, 400)
      const entries = clamp(Number(url?.searchParams.get('entries') ?? 120) || 120, 10, 500)
      return json(res, 200, await brainSession({ frames, maxEntries: entries }))
    } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }

  // ── 看板页：**往大脑会话里投一句话**（写 · 只本机 · 经换会话桥）──────────────
  //   为什么必须经桥：桌面端的鉴权 token 只在 Electron 壳里流转，外部进程拿不到；
  //   只有跑在宿主进程里的 `dsh-crew-bridge` 够得着 `sessionController.prompt`。
  //   `mode` 的真值从 asar 里查过（`dsh-api-session-controller`）：**只有 `queue` / `steer`**，
  //   用户 2026-10-11 拍板要"打断并入" ⇒ 默认 `steer`。
  //   ⚠️ 这是**面板第一次能对大脑说话** ⇒ 三道闸：只本机（guardLocal）＋ 桥自己的 token ＋
  //      前端点发送前 confirm（把要投的原话摊给你看）。审计照旧落 `panel-actions.jsonl`。
  if (pathname === '/brain-say') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只接受 POST' })
    if (!(await guardWrite({ req, res, pathname })).ok) return json403(res, pathname)
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }) }
    const wantId = String(body.sessionId ?? '').trim()
    const mode = String(body.mode ?? 'steer').trim()
    try {
      const { sayToBrain, readBoardBrain } = await import('./大脑会话.mjs')
      // 前端把它**正在显示的那条会话**带回来（避免"你看到的"与"投进去的"不是同一条）；
      // 没带就退回看板数据里那条（唯一口径）。
      let sessionId = wantId
      if (!sessionId) {
        const b = readBoardBrain()
        if (!b.ok) return json(res, 400, { ok: false, error: b.why })
        sessionId = b.sessionId
      }
      const r = await sayToBrain({ sessionId, text: String(body.text ?? ''), mode })
      const audit = { at: new Date().toISOString(), by: '面板', op: 'brain-say', sessionId, mode, ok: r.ok, chars: String(body.text ?? '').length, why: r.ok ? null : r.why }
      try { appendFileSync(join(HERE, 'panel-actions.jsonl'), JSON.stringify(audit) + '\n', 'utf8') } catch {}
      log(`[大脑插话] ${r.ok ? '成功' : '失败'} · 会话 ${String(sessionId).slice(0, 12)}… · mode=${mode} · ${String(body.text ?? '').length} 字${r.ok ? '' : ' · ' + r.why}`)
      return json(res, r.ok ? 200 : 400, r)
    } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }

  // ── 看板页：**停掉大脑当前这一轮**（写 · 只本机 · 经换会话桥）──────────────────
  //   用户 2026-10-11："会话运行过程中，这个暂停也点不了" ⇒ 接上桥的 `op:'cancel'`
  //   （宿主 `session.cancel({sessionId})` ＝ DSH 界面那个"停止"按钮干的事）。
  //   ⚠️ 与「发送（steer）」的区别：steer 是**打断并把你这句话并进去**；这里是**只停、不带话**。
  if (pathname === '/brain-stop') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只接受 POST' })
    if (!(await guardWrite({ req, res, pathname })).ok) return json403(res, pathname)
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }) }
    const wantId = String(body.sessionId ?? '').trim()
    try {
      const { stopBrain, readBoardBrain } = await import('./大脑会话.mjs')
      let sessionId = wantId
      if (!sessionId) {
        const b = readBoardBrain()
        if (!b.ok) return json(res, 400, { ok: false, error: b.why })
        sessionId = b.sessionId
      }
      const r = await stopBrain({ sessionId })
      try {
        appendFileSync(join(HERE, 'panel-actions.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), by: '面板', op: 'brain-stop', sessionId, ok: r.ok, why: r.ok ? null : r.why }) + '\n', 'utf8')
      } catch {}
      log(`[大脑暂停] ${r.ok ? '成功' : '失败'} · 会话 ${String(sessionId).slice(0, 12)}…${r.ok ? '' : ' · ' + r.why}`)
      return json(res, r.ok ? 200 : 400, r)
    } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }

  if (pathname === '/frame-action') {    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只接受 POST' })
    if (!(await guardWrite({ req, res, pathname })).ok) return json403(res, pathname)
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }) }
    try {
      return json(res, 200, frameAction({
        op: String(body.op ?? ''),
        role: String(body.role ?? '').trim(),
        text: String(body.text ?? '').trim().slice(0, 3000),
        // ★ b73：「继续」默认只预览；前端**显式**要 `execute:true` 才真 spawn（向后兼容既有判据）
        execute: body.execute === true
      }))
    } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }

  // ★ 2026-10-10（用户口径）：看板顶部「工作区」选择器 —— 列工作区 ＋ 手动钉住。
  //   为什么在面板里做：独立的看板页**拿不到"当前会话工作区"**（老的侧边栏插件当年靠宿主传），
  //   所以把"选哪个工作区"变成**用户显式的一次选择**（写 `_crew\当前项目.txt`），而不是让程序猜。
  if (pathname === '/workspaces') {
    try { return json(res, 200, listWorkspaces(req.url.includes('force=1'))) }
    catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  if (pathname === '/pin') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只接受 POST' })
    if (!(await guardWrite({ req, res, pathname })).ok) return json403(res, pathname)
    let body = {}
    try { body = JSON.parse((await readBody(req)) || '{}') } catch { return json(res, 400, { ok: false, error: '请求体不是合法 JSON' }) }
    const want = body.path == null || String(body.path).trim() === '' ? null : String(body.path).trim()
    try {
      const r = pinProject(want)
      // ★ b209：**"改钉"顺手记住"你原来钉的是哪个"**（`_crew\项目映射.json`）——
      //   下次再钉那个文档目录，`项目定位.mjs` 第②条直接换算，不必再靠账本证据（证据会过期）。
      const from = body.rememberFrom ? String(body.rememberFrom).trim() : null
      // ★ 2026-10-25（20261025 施工文档 §5-6）：**不是工作台就不许写映射**。
      //   原来误点一次"改钉"，那个目录就被永久指到别的项目（本次事故：无人值守测试 → _t_e2e）。
      if (r.ok && want && from && resolve(from) !== resolve(want)) {
        const { hasWorkbench } = await import('./项目定位.mjs')
        if (!hasWorkbench(resolve(want))) {
          r.remembered = { ok: false, skipped: true, error: '改钉目标里没有工作台（没有 _crew 或 TASKS.md）⇒ 不写映射' }
          return json(res, 200, r)
        }
        try {
          const { saveMapEntry } = await import('./项目定位.mjs')
          r.remembered = saveMapEntry(from, want)
        } catch (e) { r.remembered = { ok: false, error: String(e?.message ?? e) } }
      }
      return json(res, 200, r)
    }
    catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  if (pathname === '/health') return json(res, 200, { ok: true, tag: BUILD_TAG, port: PORT, data: DATA_FILE, core: coreFile.length })

  // ★ 2026-10-26（用户要求）：顶栏那盏「重启」灯的自检。只读，不走权限闸。
  if (pathname === '/panel-self.json') {
    if (req.method !== 'GET') return json(res, 405, { ok: false, error: '只接受 GET' })
    try {
      const c = PANEL_SELF.check()
      return json(res, 200, {
        schema: 1,
        kind: 'panel-self',
        source: 'service.mjs',
        state: c.needRestart ? 'yellow' : 'green',
        stale: false,
        ok: true,
        pid: PANEL_SELF.pid,
        port: PANEL_SELF.port,
        startedAt: PANEL_SELF.startedAt,
        checkedAt: c.startedAt,
        bootFiles: PANEL_SELF.bootCount,
        needRestart: c.needRestart,
        newer: c.newer,
        why: c.needRestart ? `磁盘上这些文件比启动时新：${c.newer.join('、')} —— 点「重启」生效` : null
      })
    } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }

  // ★ 2026-10-26：点「重启」= 这个口。走权限闸（操作区），但**不镜子到 C 服务**
  //   （它不是业务命令，是面板自己的生命周期）。
  if (pathname === '/panel-restart') {
    if (req.method !== 'POST') return json(res, 405, { ok: false, error: '只接受 POST' })
    if (!(await guardWrite({ req, res, pathname, mirror: false })).ok) return json403(res, pathname)
    try {
      const helper = join(HERE, '_self-restart.mjs')
      if (!existsSync(helper)) return json(res, 500, { ok: false, error: '没有 _self-restart.mjs' })
      const child = spawn(process.execPath, [helper, '--pid', String(process.pid), '--service', join(HERE, 'service.mjs'), '--port', String(PORT)], {
        cwd: HERE, detached: true, stdio: 'ignore', windowsHide: true
      })
      child.unref()
      console.log(`[面板] 收到自重启请求：助手 pid=${child.pid}，本进程 ${process.pid} 2 秒后退出`)
      // 先回话，再退出 —— 否则前端拿不到 200，会以为按钮坏了
      json(res, 200, { ok: true, restarting: true, pid: process.pid, helperPid: child.pid, at: new Date().toISOString() })
      setTimeout(() => process.exit(0), 1500)
      return
    } catch (e) { return json(res, 500, { ok: false, error: String(e?.message ?? e) }) }
  }
  // ★ b124：图标口 —— 桌面窗口（Edge `--app`）的**窗口图标与任务栏图标**就是它。
  //   原来这里**硬返 204（没有图标）**，于是那个窗口顶着 Edge 的通用图标 ⇒ "看着就是个浏览器"。
  //   文件＝本目录 `board.ico`（合法 ICO：`00 00 01 00 01 00`，经典 BMP 条目）。
  //   ⚠️ 缺文件时**照旧返 204**（不 500）—— 图标没了不影响看板能不能用。
  if (pathname === '/favicon.ico' || pathname === '/board.ico') {
    const ico = join(HERE, 'board.ico')
    if (existsSync(ico)) return serveFile(res, ico, MIME['.ico'])
    res.writeHead(204); return res.end()
  }

  // ── 页面与静态件（只从本目录取，防目录穿越）──────────────────────────────
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end() }
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '')
  const target = resolve(normalize(join(HERE, rel)))
  if (target !== HERE && !target.startsWith(HERE + sep)) { res.writeHead(403); return res.end() }
  return serveFile(res, target)
})

server.on('error', (e) => {
  log('[面板] 起不来：' + String(e?.message ?? e))
  if (String(e?.code) === 'EADDRINUSE') log(`       端口 ${PORT} 被占了 —— 是不是已经开着一个面板？（换端口：DSH_PANEL_PORT=19451）`)
  console.error('[面板] 起不来：' + String(e?.message ?? e))
  process.exit(1)
})
server.listen(PORT, HOST, () => {
  log(`[面板] ${BUILD_TAG} 已就绪：http://${HOST}:${PORT}/`)
  log(`[面板] 数据：${DATA_FILE}（TTL ${TTL_SEC}s，过期后台刷）`)
  log(`[面板] 共享核心：${coreText.length} 字（取自 \`面板\\core.js\` 标记区 —— 它就是唯一的源）`)
  // ★ b88：**面板自己也是长命资源**（听 19450、活过会话）⇒ 自登记一条，免得那颗灯把它报成孤儿。
  try {
    longliveUp({
      name: '班组看板', kind: 'http', port: PORT, pid: process.pid, logFile: LOG_FILE,
      ensure: null,   // 面板是 `dsh-crew-bridge` 插件随 DSH 拉起的（`ensurePanel()`）；重启入口在 `面板\start-panel.cmd`
      owner: '工作台', note: '随 DSH：插件拉起（面板启动时自登记）'
    })
  } catch (e) { log('[面板] ⚠️ 长命资源自登记失败（不影响面板）：' + String(e?.message ?? e)) }
  pokeInspection('事件:面板(启动)')   // ★ b91「谁动谁叫」：面板起来了 ⇒ 叫一声巡检（不等待；失败也无所谓，看护 30 分钟兜底）
})