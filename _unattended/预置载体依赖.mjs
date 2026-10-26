// 预置载体依赖（零外网 · 幂等 · 只写缓存目录）—— 2026-10-05
//
// 为什么要它（**这是"coder-b 被掐断"的真凶，已用日志+数据库实锤**）：
//   opencode 的 `grep` / `glob` 工具**依赖一个 ripgrep 二进制，但它不从包里带** ——
//   首次用到时会**去 GitHub 现下**：`downloading ripgrep  url=https://github.com/BurntSushi/ripgrep/releases/...`
//   实测本机下了 **4 次**才成功；前两次卡住时（各 ~80 / ~73 秒）**整个 step 被 abort**：
//     `{"type":"error","error":{"type":"aborted","message":"Step interrupted"}}`
//   → 会话 `idle_outcome=failed` 且 `time_suspended` 有值（**从不自动恢复**）
//   → 编排那边就是"coder-b 跑一半没了"（T8 两次、并连累后续任务）。
//   ⚠️ 这跟"额度/账号"无关，也跟"编排超时"无关 —— **纯粹是外网依赖**。
//
// 本脚本干什么：把**包内已有的** rg.exe 复制到 opencode 认的缓存位（默认 `~/.cache/opencode/bin/rg.exe`）。
//   已存在就**什么都不做**（幂等）；找不到任何可用源就 **exit 3 明说**（不猜、不下载）。
//
// 用法：
//   node 预置载体依赖.mjs            # 检查 + 需要时复制
//   node 预置载体依赖.mjs --check    # 只检查不写（起飞前检查用这个）
// 退出码：0 = 就位（含"本来就有"）；3 = 缺且没找到可用源（**不许静默放过**）
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENTS as AGENTS_ROOT, DSH_ROOT as DSH_APP_ROOT } from './_路径.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const WS = resolve(HERE, '..')                             // ...\无人值守（工作台根）
// ★W6：DSH 根与载体根都从 `_路径.mjs` 取（它认配置、认包内 `agents\`、认同级目录）。
//   以前这里 `AGENTS = 上一层\agents` —— 包内形态是 `工作台\agents`，那条路径根本不存在。
const DSH_ROOT = DSH_APP_ROOT ?? ''      // 空 = 没装 DSH；下面 join 出来是相对路径，不会命中
const AGENTS = AGENTS_ROOT ?? ''         // 空 = 没有载体根；同理
const CHECK_ONLY = process.argv.includes('--check')

// ⚠️ 不写死'某个用户目录'：那是拿别人的机器当默认值，开源后就是泄露。
//    取不到就明说退出（本脚本的纪律本来就是"不猜、不下载"）。
const HOME = process.env.USERPROFILE ?? process.env.HOME
if (!HOME) {
  console.log('❌ 拿不到用户目录（USERPROFILE / HOME 都没设）⇒ 不知道该往哪放 ripgrep，不猜。')
  process.exit(3)
}
// opencode 自己用的缓存位（实测日志里就是它：`<用户目录>\.cache\opencode\bin\rg.exe`）
const TARGET = join(HOME, '.cache', 'opencode', 'bin', process.platform === 'win32' ? 'rg.exe' : 'rg')

// 源：**全在包内**（跟着工作台走，不依赖外网、不依赖别人电脑上装了什么）
// ★W6（隔离测试发现的）：`codebuddy-cli` 是**旧目录名**，官方 npm 包里实际在
//   `@tencent-ai/codebuddy-code/vendor/ripgrep/...`；qwen 包里也自带一份。
//   以前找不到这俩 ⇒ 胖包明明自带 rg.exe，却还去 GitHub 现下（正是"coder-b 被掐断"的老病）。
const SOURCES = [
  join(AGENTS, 'node_modules', '@tencent-ai', 'codebuddy-code', 'vendor', 'ripgrep', 'x64-win32', 'rg.exe'),
  join(AGENTS, 'node_modules', '@qwen-code', 'qwen-code', 'vendor', 'ripgrep', 'x64-win32', 'rg.exe'),
  join(AGENTS, 'codebuddy-cli', 'vendor', 'ripgrep', 'x64-win32', 'rg.exe'),
  join(DSH_ROOT, 'resources', 'app.asar.unpacked', 'dsh', 'node_modules', '@vscode', 'ripgrep-win32-x64', 'bin', 'rg.exe'),
  join(AGENTS, 'node_modules', '@qodercn-ai', 'qoderclicn-ripgrep-win32-x64', 'bin', 'rg.exe'),
  join(AGENTS, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex-path', 'rg.exe')
].filter(Boolean)

const ok = (s) => console.log(s)

if (existsSync(TARGET) && statSync(TARGET).size > 100000) {
  ok(`✅ opencode 的 ripgrep 已就位：${TARGET}（${statSync(TARGET).size} 字节）`)
  process.exit(0)
}
if (CHECK_ONLY) {
  console.log(`⚠️ 缺 opencode 的 ripgrep：${TARGET}\n   → 首次用 grep/glob 时它会**去 GitHub 现下**，卡住就会把这一步 abort 掉（"coder-b 被掐断"的真凶）。\n   → 修：跑一次 \`node _unattended\\预置载体依赖.mjs\`（从包内复制，零外网）`)
  process.exit(3)
}
const src = SOURCES.find(p => existsSync(p) && statSync(p).size > 100000)
if (!src) {
  console.log(`❌ 缺 opencode 的 ripgrep，且**包内没找到任何可用源**（不下载、不猜）：\n   目标：${TARGET}\n   找过：\n${SOURCES.map(s => '     ' + s).join('\n')}`)
  process.exit(3)
}
try {
  mkdirSync(dirname(TARGET), { recursive: true })
  copyFileSync(src, TARGET)
  ok(`✅ 已从包内预置：\n   源  ：${src}\n   目标：${TARGET}（${statSync(TARGET).size} 字节）\n   → opencode 以后不会再为 grep/glob 去 GitHub 下载`)
  process.exit(0)
} catch (e) {
  console.log(`❌ 复制失败：${String(e?.message ?? e)}`)
  process.exit(3)
}