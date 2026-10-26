#!/usr/bin/env node
/**
 * 给 dsh-obsidian 打「vault 路径镜像」护栏（★ 2026-10-19 b188）。
 *
 * 为什么：该插件所有 obsidian_* 操作都过一个 `guardPath(vaultRoot, rel)`；而它只防"逃出 vault"，
 * **不防"把 vault 自己的名字又写了一遍"** —— 而三处 `mkdir(..., {recursive:true})` 会把缺的目录
 * 一路静默建出来 ⇒ 写成 `知识库/AI知识库/x.md` 时，内容会静默落进 <vault>\知识库\AI知识库\x.md。
 *
 * 本脚本是**幂等**的：没打就补，打过了就只报状态。升级 dsh-obsidian 覆盖掉之后，重跑本脚本即可。
 *
 * 用法：
 *   node 打obsidian路径护栏.mjs           # 打/检查
 *   node 打obsidian路径护栏.mjs --check   # 只检查（exit 2 = 护栏不在）
 *   · 路径可用 DSH_OBSIDIAN_PLUGIN 覆盖；逃生开关：DSH_OBSIDIAN_ALLOW_VAULT_MIRROR=1
 */
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const FILE = process.env.DSH_OBSIDIAN_PLUGIN ??
  join(homedir(), '.dsh', 'profiles', 'desktop', 'node_modules', 'dsh-obsidian', 'lib', 'index.js')
const MARK = 'b188 护栏'
const CHECK_ONLY = process.argv.includes('--check')

if (!existsSync(FILE)) { console.log('（没装 dsh-obsidian，跳过） ' + FILE); process.exit(0) }
let src = readFileSync(FILE, 'utf8')

if (src.includes(MARK)) {
  console.log('护栏在：' + FILE)
  process.exit(0)
}
if (CHECK_ONLY) { console.log('❌ 护栏不在：' + FILE); process.exit(2) }

const anchor = `\tif (relative === ".." || relative.startsWith(\`..\${path.sep}\`) || path.isAbsolute(relative)) throw new Error(\`path escapes vault root: \${rel}\`);\n\treturn abs;\n}`
if (!src.includes(anchor)) { console.log('❌ 找不到 guardPath 的锚点，未打补丁（插件版本可能变了）'); process.exit(3) }

const guard = `
// ★ 2026-10-19 b188 护栏：相对路径的根**已经是 vaultPath**，不许再把 vault 自己的名字写进去。
//   背景：本机的 vault = <知识库>，父目录也叫"知识库" ⇒ 顺手写成
//   "知识库/AI知识库/x.md" 时，三处 mkdir(recursive) 会静默建出嵌套树（两天内踩了两次）。
function guardVaultMirror(root, relative, original) {
	if (process.env.DSH_OBSIDIAN_ALLOW_VAULT_MIRROR === "1") return;
	const segs = relative.split(path.sep).filter(Boolean);
	if (!segs.length) return;
	const vaultName = path.basename(root);
	const parentName = path.basename(path.dirname(root));
	const [first, second] = segs;
	const hit = first === vaultName || (first === parentName && (!second || second === vaultName));
	if (!hit) return;
	throw new Error(\`疑似把 vault 路径写重了一层：收到 "\${original}"，但相对路径的根已经是 "\${root}"。\` +
		\`正确写法＝去掉 "\${parentName}/" 与 "\${vaultName}/" 这两层（例：直接写 "大模型知识库/_索引.md"）。\` +
		\`确实要用这个目录名时，设 DSH_OBSIDIAN_ALLOW_VAULT_MIRROR=1。\`);
}
`

const patched = src.replace(anchor,
  `\tif (relative === ".." || relative.startsWith(\`..\${path.sep}\`) || path.isAbsolute(relative)) throw new Error(\`path escapes vault root: \${rel}\`);\n\tguardVaultMirror(root, relative, rel);\n\treturn abs;\n}\n` + guard)

if (patched === src) { console.log('❌ 替换未发生'); process.exit(4) }
copyFileSync(FILE, FILE + '.bak-b188')
writeFileSync(FILE, patched, 'utf8')
console.log('✅ 已打补丁：' + FILE + '（备份 ' + FILE.split('\\').pop() + '.bak-b188）')
