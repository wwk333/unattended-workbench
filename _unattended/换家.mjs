/**
 * 批 3「换家」：把换会话桥从旧看板插件搬到新插件 —— **只改配置，不重启**（重启由人工挑时机）
 *
 * 干什么（默认 `--dry`，只打印不落盘）：
 *   ① 给 profile 的 `package.json` 加依赖：`"dsh-crew-bridge": "file:…\\_unattended\\bridge-plugin"`
 *   ② 从 `dsh.profile.bundles` 里**摘掉** `dsh-board-sidebar`、**追加** `dsh-crew-bridge`
 *   ③ 建 junction：`<profile>\node_modules\dsh-crew-bridge` → `…\_unattended\bridge-plugin`
 *      （照抄现役插件的装法：`node_modules\dsh-board-sidebar` 就是个 junction ⇒ **不用跑 pnpm、不联网**）
 *   ④ 改前把每个被改的文件**逐字节备份**到 `<profile>\_backup-batch3-<时间戳>\`
 *
 * 用法：
 *   node _unattended\换家.mjs --dry        # 只看要改什么（默认）
 *   node _unattended\换家.mjs --apply      # 真改（改完**必须重启 DSH** 才生效）
 *   node _unattended\换家.mjs --rollback   # 从最近的备份还原（配置＋junction）
 *
 * ⚠️ 三条硬口径：
 *   · **19390 只能有一个主人** ⇒ 换家必须在**同一次重启**里完成（新插件上、旧插件撤）。
 *   · 桥**不能停**：摘掉旧插件前，新插件必须已经在 bundles 里（本脚本一次改完）。
 *   · 旧插件**不是删掉**，只是从 bundles 里摘掉（想回退＝把它加回去）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, readdirSync, statSync, lstatSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(dirname(fileURLToPath(import.meta.url)))          // = 工作台根
const PROFILE = process.env.DSH_PROFILE_DIR ?? join(process.env.USERPROFILE ?? '', '.dsh', 'profiles', 'desktop')
const PKG = join(PROFILE, 'package.json')
const NODE_MODULES = join(PROFILE, 'node_modules')
const BRIDGE_DIR = join(HERE, '_unattended', 'bridge-plugin')
const BRIDGE_NAME = 'dsh-crew-bridge'
const OLD_NAME = 'dsh-board-sidebar'
const OLD_DEP_SPEC = `file:${join(HERE, '_unattended', 'sidebar-plugin')}`
const NEW_DEP_SPEC = `file:${BRIDGE_DIR}`
const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--rollback') ? 'rollback' : 'dry'

const log = (...a) => console.log(...a)

function readJson (p) { return JSON.parse(readFileSync(p, 'utf8')) }

/** 最近的批 3 备份目录（回滚用）。 */
function latestBackup () {
  if (!existsSync(PROFILE)) return null
  const dirs = readdirSync(PROFILE).filter((n) => n.startsWith('_backup-batch3-')).sort()
  return dirs.length ? join(PROFILE, dirs[dirs.length - 1]) : null
}

function backup (stamp) {
  const dir = join(PROFILE, `_backup-batch3-${stamp}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json.before'), readFileSync(PKG))
  const jl = join(NODE_MODULES, BRIDGE_NAME)
  writeFileSync(join(dir, 'junction-existed.txt'), existsSync(jl) ? 'yes' : 'no', 'utf8')
  log(`  [备份] ${dir}`)
  return dir
}

function ensureJunction () {
  const link = join(NODE_MODULES, BRIDGE_NAME)
  if (existsSync(link)) { log(`  [junction] 已存在，跳过：${link}`); return }
  mkdirSync(NODE_MODULES, { recursive: true })
  try {
    symlinkSync(BRIDGE_DIR, link, 'junction')
    log(`  [junction] 建好（symlink junction）：${link} → ${BRIDGE_DIR}`)
  } catch (e) {
    // 退路：cmd 的 mklink /J（不依赖权限）
    execFileSync('cmd', ['/c', 'mklink', '/J', link, BRIDGE_DIR], { stdio: 'inherit' })
    log(`  [junction] 建好（mklink /J）：${link} → ${BRIDGE_DIR}`)
  }
}

function removeJunction () {
  const link = join(NODE_MODULES, BRIDGE_NAME)
  if (!existsSync(link)) { log(`  [junction] 本来就没有`); return }
  const st = lstatSync(link)
  if (!st.isSymbolicLink() && !st.isDirectory()) { log(`  [junction] 不是 junction/目录，**不动**：${link}`); return }
  try {
    // 只删链接本身：junction 用 rmdir 删（rmSync recursive 会顺着删目标里的东西 —— 危险，绝不用）
    rmSync(link, { recursive: false, force: true })
    log(`  [junction] 已删链接（目标目录未动）：${link}`)
  } catch (e) {
    log(`  [junction] 删链接失败（可能得手工删）：${String(e?.message ?? e)}`)
  }
}

log(`批 3 换家 · 模式=${mode}`)
log(`  profile = ${PROFILE}`)
log(`  新插件  = ${BRIDGE_DIR}`)

/** 增量配置内容：只改第 ① ② 两处（junction 由调用方决定要不要建）。 */
function editedPkg (pkg, { dropOld, addNew }) {
  const out = JSON.parse(JSON.stringify(pkg))
  const deps = out.dependencies ?? (out.dependencies = {})
  if (addNew) deps[BRIDGE_NAME] = NEW_DEP_SPEC
  const bundles = out?.dsh?.profile?.bundles
  let nb = bundles.filter((b) => !(dropOld && b === OLD_NAME))
  if (addNew && !nb.includes(BRIDGE_NAME)) nb.push(BRIDGE_NAME)
  out.dsh.profile.bundles = nb
  return out
}

if (!existsSync(PKG)) { console.error('找不到 profile 的 package.json：' + PKG); process.exit(1) }
if (!existsSync(join(BRIDGE_DIR, 'package.json'))) { console.error('新插件不完整（缺 package.json）：' + BRIDGE_DIR); process.exit(1) }

if (mode === 'rollback') {
  const dir = latestBackup()
  if (!dir) { console.error('没有找到任何 _backup-batch3-* 备份，无法回滚'); process.exit(1) }
  log(`  用备份：${dir}`)
  writeFileSync(PKG, readFileSync(join(dir, 'package.json.before')))
  log('  [还原] package.json')
  const hadJ = readFileSync(join(dir, 'junction-existed.txt'), 'utf8').trim() === 'yes'
  if (!hadJ) removeJunction()
  log('\n回滚完成。**重启 DSH** 后旧看板插件会照旧加载（桥仍由它提供）。')
  process.exit(0)
}

let pkg
try { pkg = readJson(PKG) } catch (e) { console.error('package.json 不是合法 JSON：' + String(e?.message ?? e)); process.exit(1) }
const deps = pkg.dependencies ?? {}
const bundles = pkg?.dsh?.profile?.bundles
if (!Array.isArray(bundles)) { console.error('package.json 里没有 dsh.profile.bundles（形状不对，停手）'); process.exit(1) }

/** 三种模式（`--apply` 之外的两种是**两阶段**，更稳）：
 *   --apply     一次改完（摘旧 ＋ 上新 ＋ junction），随后**重启** ⇒ 桥直接换主人
 *   --retire    只**摘旧**（旧看板插件从 bundles 去掉）⇒ 重启后右侧栏标签页消失、**19390 暂时没人监听**
 *   --install   只**上新**（新桥插件进 bundles ＋ junction）⇒ 重启后桥由新插件提供 */
const retireOnly = process.argv.includes('--retire')
const installOnly = process.argv.includes('--install')
const plan = retireOnly
  ? { dropOld: true, addNew: false, junc: false }
  : installOnly
    ? { dropOld: false, addNew: true, junc: true }
    : { dropOld: true, addNew: true, junc: true }
const stageName = retireOnly ? '阶段 A：摘旧（旧看板插件撤下）' : installOnly ? '阶段 B：上新（新桥插件上岗）' : '一步到位（摘旧 ＋ 上新）'

log(`\n计划：${stageName}`)
log(`  ① dependencies["${BRIDGE_NAME}"] = ${plan.addNew ? JSON.stringify(NEW_DEP_SPEC) : '（本次不动）'}`)
log(`     （现况：${JSON.stringify(deps[BRIDGE_NAME] ?? null)}）`)
log(`  ② bundles：${plan.dropOld ? `去掉 "${OLD_NAME}"` : ''}${plan.dropOld && plan.addNew ? '、' : ''}${plan.addNew ? `加 "${BRIDGE_NAME}"` : ''}`)
log(`     现况 = ${JSON.stringify(bundles)}`)
if (plan.junc) {
  log(`  ③ junction：<profile>\\node_modules\\${BRIDGE_NAME} → ${BRIDGE_DIR}`)
  log(`     现况 = ${existsSync(join(NODE_MODULES, BRIDGE_NAME)) ? '已存在' : '不存在'}`)
}

if (mode === 'dry') {
  log('\n（--dry：什么都没改。加 --apply / --retire / --install 才落盘）')
  process.exit(0)
}

const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
log('')
backup(stamp)
const next = editedPkg(pkg, plan)
writeFileSync(PKG, JSON.stringify(next, null, 2) + '\n', 'utf8')
log('  [写入] package.json')
if (plan.junc) ensureJunction()

if (retireOnly) {
  log('\n【阶段 A 完成】旧看板插件已从 bundles 摘掉。**还没生效** —— 重启 DSH 后：')
  log('   · 右侧栏「班组看板」标签页会消失')
  log('   · ⚠️ 19390（换会话桥）会**暂时没人监听** —— 这是**预期**的中间态，下一步马上补上')
  log('   下一步：node _unattended\\换家.mjs --install --apply  （再重启一次，桥由新插件上岗）')
} else if (installOnly) {
  log('\n【阶段 B 完成】新桥插件已进 bundles。**还没生效** —— 重启 DSH 后：')
  log('   · 19390 由 **dsh-crew-bridge** 提供（跑 `node _unattended\\换家后验证.mjs` 看它的 host 标识）')
  log('   · 看护拉手也由它负责（它会幂等调 `确保看守.mjs`）')
} else {
  log('\n【一步到位完成】⚠️ 重启前请确认：**新插件能加载**（否则重启后 19390 会空着）。')
  log('   求稳就走两阶段：--retire 先摘、重启、验完再 --install。')
}
log('\n重启 DSH 之后：node _unattended\\换家后验证.mjs')
log('回滚：node _unattended\\换家.mjs --rollback 然后重启 DSH')
void resolve
