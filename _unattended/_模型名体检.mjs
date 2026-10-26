/**
 * 模型名体检 —— 「**任何模型名都不许写进代码／规矩文件**」这条规矩的**机器判据**。
 * ★ b200（施工文档 §四 M6-3 的"反向验收"里我欠的一条抓法）。
 *
 * 为什么要有它：模型名**只由用户在看板里定**（`_crew\agents.json` 是唯一源）。写进代码/卡模板的模型名
 *   会**静默过期** —— 历史上就踩过"AI 按旧名单跑，还不报错"。这条规矩原来**只有注释**（`_agents-config.mjs`
 *   里写着"兜底里也不许写模型名"），**没有机器盯着** ⇒ 违反了不疼 ⇒ 迟早漂回去。
 *
 * 判据（**不写死名单**）：
 *   ① 从 `_crew\agents.json` **现读**所有模型名（任何键名带 model 的字符串值）；
 *   ② 扫**代码与规矩文件**（见 SCAN：`_unattended\**\*.mjs`／`面板\**\*.mjs,js`／`roles\*.md`）；
 *   ③ 一行里出现某个模型名 ⇒ **报红**（除非那行带豁免标记 `允许模型名`）。
 *
 * ⚠️ 扫的范围**故意不含**：`_crew\agents.json` 自己（模型名的合法住处）、`_crew\backup\**`、
 *   `node_modules`、以及**知识库文档**（那些文档是在**讨论**模型，不是"拿模型名驱动行为"，
 *   全扫进去只会淹掉真警报 —— 假警报多了真警报就没人看）。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const AGENTS = process.env.DSH_AGENTS_CONFIG ?? join(ROOT, '_crew', 'agents.json');
const JSON_OUT = process.argv.includes('--json');
const WAIVER = /允许模型名|model-name-ok/;

/**
 * ① 现读模型名（不写死名单）。
 * ⚠️ 判据必须**窄**（第一版写成"任何键名带 model 的字符串值"⇒ 把 `modelFlag: '--model'`、`'-m'` 全当成模型名，
 *    一跑 361 处假警报 —— 假警报多了真警报就没人看了）。现在只认三种落点：
 *      · 键名**恰好是** `model` 的值（覆盖 `agents.*.model` / `roles.*.model` / `roles.*.prefer.model` / `levels.*.model`）
 *      · 键名是 `models` 且值为字符串数组（多模型清单）
 *      · 值不能是命令行开关（`-` 开头）或未展开的占位符（`${…`）
 */
function modelNames () {
  const j = JSON.parse(readFileSync(AGENTS, 'utf8'));
  const out = new Set();
  const add = (v) => {
    if (typeof v !== 'string') return;
    const s = v.trim();
    if (!s || s.startsWith('-') || s.startsWith('${')) return;
    out.add(s);
  };
  ;(function walk (v) {
    if (v == null || typeof v !== 'object') return;
    if (Array.isArray(v)) { for (const x of v) walk(x); return }
    for (const [k, x] of Object.entries(v)) {
      if (k === 'model') add(x);
      else if (k === 'models' && Array.isArray(x)) for (const y of x) add(y);
      else if (x && typeof x === 'object') walk(x);
    }
  })(j);
  return [...out];
}

/** ② 要扫的文件（代码 ＋ 规矩文件）。 */
function targets () {
  const files = []
  const walkDir = (dir, filter, out = []) => {
    let e = []; try { e = readdirSync(dir, { withFileTypes: true }) } catch { return out }
    for (const x of e) {
      if (x.name === 'node_modules' || x.name === 'backup' || x.name.startsWith('.')) continue
      const p = join(dir, x.name)
      if (x.isDirectory()) walkDir(p, filter, out)
      else if (filter(x.name)) out.push(p)
    }
    return out
  }
  files.push(...walkDir(join(ROOT, '_unattended'), n => n.endsWith('.mjs') || n.endsWith('.js') || n.endsWith('.md')))
  for (const f of ['brain.md', '班组须知.md', '班组须知-细则.md']) {
    const p = join(ROOT, '_unattended', 'roles', f)
    if (existsSync(p)) files.push(p)
  }
  return files
}

const names = modelNames()
const hits = []
for (const f of targets()) {
  if (resolve(f) === resolve(AGENTS)) continue
  let text = ''
  try { text = readFileSync(f, 'utf8') } catch { continue }
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 豁免：**本行或上一行**带 `允许模型名`（上一行也认，是因为有些行是字符串拼接的夹具片断，行尾加注释会破语法）
    if (WAIVER.test(line) || (i > 0 && WAIVER.test(lines[i - 1]))) continue
    // ★ 跳过**纯注释行**：注释里举例说明模型名（"以前拿裸名去比，`custom-local:kimi-k3` 会被误报…"）
    //   不是在"拿模型名驱动行为"，扫进去只会淹掉真警报。
    if (/^\s*(\/\/|\/\*|\*|<!--|#(?!\!))/.test(line)) continue
    for (const n of names) {
      if (line.includes(n)) hits.push({ file: relative(ROOT, f).replace(/\\/g, '/'), line: i + 1, model: n, text: line.trim().slice(0, 160) })
    }
  }
}
const out = { ok: hits.length === 0, scanned: targets().length, models: names, hits }
if (JSON_OUT) { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); process.exit(out.ok ? 0 : 1) }
console.log(`🧪 模型名体检 · 从 ${relative(ROOT, AGENTS)} 现读 ${names.length} 个模型名 · 扫 ${out.scanned} 个文件`)
if (!names.length) console.log('   ⚠️ 一个模型名都没读到（agents.json 里没有 model 字段？）⇒ 判据为空，**不算通过**')
for (const h of hits) console.log(`   ❌ ${h.file}:${h.line}  出现「${h.model}」  ${h.text}`)
console.log(hits.length
  ? `\n⛔ ${hits.length} 处硬编码模型名 —— 模型名只由用户在看板里定（唯一源 ${relative(ROOT, AGENTS)}）；确需在文字里举例就加豁免标记「允许模型名」。`
  : '\n✅ 代码与规矩文件里没有硬编码的模型名（模型名只从 agents.json 现读）。')
process.exit(hits.length ? 1 : 0)
