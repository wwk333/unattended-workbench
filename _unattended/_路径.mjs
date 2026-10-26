/**
 * 路径的唯一权威源（开源准备 W2）
 *
 * 为什么要有这个文件：在这之前，"DSH 装在哪、工作台在哪、坑库在哪"被**写死**在几十个脚本里
 * （实测：导出后仍有 34 个文件含盘符、73 处）。那既是泄露（把作者的机器布局发给所有人），
 * 也是隐患（用户装到别的盘，整条链一起失效）。
 *
 * 解析顺序（**每一层都写下出处，不许悄悄兜底**）：
 *   ① 环境变量（给 CI / 临时覆盖用）
 *   ② `config\本机映射.json`（安装时由 setup 探测生成；**唯一允许写绝对路径的地方**）
 *   ③ 从本文件位置推导（工作台根、包内 `agents\`、同级的 `..\agents`）
 *   ④ 都没有 ⇒ 返回 `null`，并在**真正用到的那一刻**由 `need()` 抛错
 *
 * 为什么不是"导入时就抛"：很多脚本（`--help`、纯文本处理）根本不需要 DSH。
 * 一导入就炸，等于把一个可选依赖变成硬启动依赖 —— 那是另一种"无脑加负担"。
 * 但**用到就必须有**，所以 `need()` 一定会抛，且错误里写清"缺哪个键、去哪个文件填"。
 *
 * 用法：
 *   import { WORKSPACE, DSH_ROOT, AGENTS, NODE_BIN, VAULT, need } from './_路径.mjs'
 *   const exe = need('dshExe', DSH_EXE)      // 拿不到就抛，带人话
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `_unattended\` 自己 */
export const HERE = dirname(fileURLToPath(import.meta.url))
/** 工作台根（包内 = 解压根）。**永远由本文件位置推出**，不受配置影响。 */
export const WORKSPACE = resolve(HERE, '..')
export const CONFIG_DIR = join(WORKSPACE, 'config')
export const MAP_FILE = process.env.DSH_MAP_FILE ?? join(CONFIG_DIR, '本机映射.json')

const HOME = process.env.USERPROFILE ?? process.env.HOME ?? null

/** 读本机映射；读不到/坏了一律返回 `{}` + 一条原因（不抛，让 `need()` 去抛） */
export function loadMap (file = MAP_FILE) {
  if (!existsSync(file)) return { map: {}, source: null, why: `没有 ${file}` }
  try {
    const raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '') // PowerShell 写文件会带 BOM
    return { map: JSON.parse(raw), source: file, why: null }
  } catch (e) {
    return { map: {}, source: file, why: `${file} 解析失败：${String(e?.message ?? e)}` }
  }
}

const { map: MAP, source: MAP_SOURCE } = loadMap()
export { MAP, MAP_SOURCE }

/**
 * 从映射里取一个键（容忍中文键与英文别名两种写法）。
 * ⚠️ 两条纪律（都踩过）：
 *   ① 模板里的 `<...>` 是**占位符，不是值** —— 当成"没配"，否则会真的去 mkdir 一个叫 `<坑库目录…>` 的目录；
 *   ② 值里允许写 `%USERPROFILE%` 这种环境变量，取的时候要展开。
 */
function expandEnv (v) {
  return String(v).replace(/%([A-Za-z0-9_()]+)%/g, (all, name) => process.env[name] ?? all)
}

function pick (...keys) {
  for (const k of keys) {
    const raw = MAP?.[k]
    if (typeof raw !== 'string') continue
    const v = raw.trim()
    if (!v) continue
    if (v.startsWith('<')) continue            // `<...>` = 占位符，没配
    const e = expandEnv(v)
    if (e.includes('%')) continue              // 有没展开的变量 ⇒ 也不算配好
    return e
  }
  return null
}

const firstExist = (...ps) => ps.find(p => { try { return p && existsSync(p) } catch { return false } }) ?? null

/**
 * DSH 安装根。**没有任何"猜一个盘符"的兜底**：
 * 环境变量 → 映射 → 包内/同级的 `dsh桌面端` 目录（**真的存在 `resources\runtime` 才算数**）。
 */
const looksLikeDsh = (p) => Boolean(p) && existsSync(join(p, 'resources', 'runtime'))

export const DSH_ROOT = (() => {
  if (looksLikeDsh(process.env.DSH_APP_ROOT)) return process.env.DSH_APP_ROOT
  const fromMap = pick('DSH根', 'dshRoot')
  if (looksLikeDsh(fromMap)) return fromMap
  for (const c of [join(WORKSPACE, 'dsh桌面端'), resolve(WORKSPACE, '..', 'dsh桌面端')]) {
    if (looksLikeDsh(c)) return c
  }
  return null
})()

/** 载体根：映射 → 包内 `agents\` → 工作台同级 `..\agents` → null */
export const AGENTS = (() => {
  const env = process.env.DSH_AGENTS_DIR
  if (env) return env
  const fromMap = pick('agents', '载体根')
  if (fromMap) return fromMap
  return firstExist(join(WORKSPACE, 'agents'), resolve(WORKSPACE, '..', 'agents'))
})()

/** 专用 node（DSH 自带 runtime）；也可用 DSH_NODE_EXE 覆盖 */
export const NODE_BIN = process.env.DSH_NODE_EXE ??
  (DSH_ROOT ? join(DSH_ROOT, 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe') : null)

/** DSH 桌面端主程序 */
export const DSH_EXE = process.env.DSH_ELECTRON_EXE ??
  (DSH_ROOT ? join(DSH_ROOT, 'DeepSeek Harness.exe') : null)

/** DSH headless 入口（在 asar 里，只能被 Electron 当 node 跑） */
export const CLI_JS = process.env.DSH_CLI_JS ??
  (DSH_ROOT ? join(DSH_ROOT, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js') : null)

/** DSH 自带的 dsh.cmd */
export const CLI_CMD = process.env.DSH_CLI ??
  (DSH_ROOT ? join(DSH_ROOT, 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd') : null)

export const DSH_HOME = process.env.DSH_HOME ?? (HOME ? join(HOME, '.dsh') : null)
export const CRED_FILE = process.env.DSH_CREDENTIALS ?? (DSH_HOME ? join(DSH_HOME, '.credentials.yaml') : null)

/** 坑库（用户级资产，装在项目外） */
export const VAULT = process.env.DSH_PITFALL_VAULT ?? pick('坑库', 'vault') ?? null
/** 知识库根（坑库的上级；部分脚本要） */
export const KB = process.env.DSH_KB ?? pick('知识库', 'kb') ?? null
/** 备份落点 */
export const BACKUP_ROOT = process.env.DSH_BACKUP_ROOT ?? pick('备份根', 'backupRoot') ?? null
/** 用户自己的项目根（看板/编排的"当前项目"由它派生，不在这里写死） */
export const PROJECTS_ROOT = process.env.DSH_PROJECTS_ROOT ?? pick('项目根', 'projectsRoot') ?? null
/** 用户栏本身（不含 \Users\ 的那层） */
export const HOME_DIR = HOME

/**
 * 拿不到就抛。**错误里必须写清"缺什么 + 去哪填"**，否则用户只会看到一句英文堆栈。
 * @param {string} key   人话名字（"DSH 安装根"）
 * @param {string|null} v 值
 * @param {string} [hint] 补充提示
 */
export function need (key, v, hint = '') {
  if (v) return v
  throw new Error(
    `缺「${key}」。去 ${MAP_FILE} 填，或用环境变量覆盖。` +
    (hint ? `（${hint}）` : '') +
    `\n  ⇒ 映射文件现在${MAP_SOURCE ? '在：' + MAP_SOURCE : '不存在，跑一次 setup（node setup.mjs --apply）会生成'}`
  )
}

/** 体检用：把每个键的"值 / 出处 / 是否缺"摊开，给人看也机器可读 */
export function report () {
  const pickSrc = (envName, mapKeys, derived) => {
    if (envName && process.env[envName]) return { from: `env ${envName}` }
    if (mapKeys.some(k => typeof MAP?.[k] === 'string' && MAP[k].trim())) return { from: `config ${mapKeys[0]}` }
    if (derived) return { from: '从本文件位置推导' }
    return { from: null }
  }
  const items = [
    ['工作台根', WORKSPACE, { from: '从本文件位置推导' }],
    ['DSH 安装根', DSH_ROOT, pickSrc('DSH_APP_ROOT', ['DSH根', 'dshRoot'], DSH_ROOT)],
    ['载体根', AGENTS, pickSrc('DSH_AGENTS_DIR', ['agents', '载体根'], AGENTS)],
    ['专用 node', NODE_BIN, pickSrc('DSH_NODE_EXE', [], NODE_BIN)],
    ['DSH 主程序', DSH_EXE, pickSrc('DSH_ELECTRON_EXE', [], DSH_EXE)],
    ['DSH headless', CLI_JS, pickSrc('DSH_CLI_JS', [], CLI_JS)],
    ['DSH 家目录', DSH_HOME, pickSrc('DSH_HOME', [], DSH_HOME)],
    ['坑库', VAULT, pickSrc('DSH_PITFALL_VAULT', ['坑库', 'vault'], VAULT)],
    ['知识库', KB, pickSrc('DSH_KB', ['知识库', 'kb'], KB)],
    ['备份根', BACKUP_ROOT, pickSrc('DSH_BACKUP_ROOT', ['备份根', 'backupRoot'], BACKUP_ROOT)]
  ]
  return {
    mapFile: MAP_FILE,
    mapExists: Boolean(MAP_SOURCE),
    mapWhy: loadMap().why,
    items: items.map(([name, value, src]) => ({ name, value: value ?? null, from: src.from, exists: value ? existsSync(value) : false }))
  }
}
