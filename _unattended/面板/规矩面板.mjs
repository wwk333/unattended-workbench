/**
 * 规矩面板 —— 看板「✏️ 改规矩」页的服务端（**只做读 / 改 ＋ 自检**，不做别的）。
 * ★ b197（施工文档 §四 D7 四项）：
 *   ① **红灯分两类**（规则类／任务类）—— 这一页只处理**规则类**：规矩文件自己的问题；
 *   ② **改前自动备份**；③ **改后必跑体检，不过则红灯不灭**（不过就整体回滚，红灯留着）；
 *   ④ **给 diff 对照表**（改前→改后一行一条）。
 *
 * 纪律（照 `载体面板.mjs` 那套，四步缺一不可）：**备份 → 写 → 自检 → 不过就回滚**。
 *   自检＝`_条数体检.mjs` 跑通（条数不是 0）＋ **文件专属硬断言**（锚点/占位符/围栏/标记）＋
 *   改了 `班组须知.md` 时再跑 `_前缀契约自检.mjs`（它是"卡里真内联了这段"的唯一证据）。
 *   ⚠️ 判据**只此一处**（页面上的红绿与这里同源，别在 UI 里再写一套）。
 *
 * ⚠️ 只允许改**这三份工作台自己的规矩文件**（别的一律拒绝）—— 排白名单，不排黑名单。
 */
import { copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { countRules, crewBrief, stripComments } from '../_条数体检.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const UNATTENDED = resolve(HERE, '..');
const ROLES = join(UNATTENDED, 'roles');
const NODE = process.env.DSH_NODE_EXE ?? process.execPath;

/** 允许编辑的三份（键 → 文件）。**排白名单**：不在表里的一律拒绝。 */
const FILES = {
  brain: { path: join(ROLES, 'brain.md'), title: '大脑常驻规矩（每轮全文注入）', effect: '改完**要重启桌面端**才生效（persona 在加载 profile 时求值一次）' },
  'crew-brief': { path: join(ROLES, '班组须知.md'), title: '班组卡片面（每张卡内联）', effect: '改完**下一张卡就生效**，不用重启（`派活.mjs` 每次派活现读）' },
  detail: { path: join(ROLES, '班组须知-细则.md'), title: '条件性规矩全文（按需读）', effect: '**不进 persona**：只有大脑去读它时才起作用，改完立刻可读' }
};

const backup = (file, op) => {
  const dst = `${file}.bak-${op}-${Date.now()}`
  try { copyFileSync(file, dst); return dst } catch { return null }
};

/** 文件专属硬断言 —— 这些是"改坏了会静默出事"的地方，逐条守。 */
function assertions (key, text) {
  const bad = [];
  if (key === 'brain') {
    if (!text.startsWith('You are the BRAIN')) bad.push('首行锚点丢了（`You are the BRAIN…` 是版本判定的锚，规矩版本体检／注入体检都靠它）');
    if (!text.includes('{{model}}')) bad.push('`{{model}}` 占位符丢了（宿主注册的模板变量，丢了 persona 组装会失败）');
    const vars = [...text.matchAll(/\{\{([a-zA-Z_][\w]*)\}\}/g)].map(m => m[1]);
    const extra = [...new Set(vars)].filter(v => !['provider', 'model'].includes(v));
    if (extra.length) bad.push(`有宿主没注册的模板变量：${extra.join(', ')}（起飞前检查 ⑪ 会红）`);
    if ((text.match(/^```/gm) ?? []).length % 2) bad.push('代码围栏是奇数（少了一个 ```）');
    if (text.length < 800) bad.push(`太短了（${text.length} 字符）—— 常驻规矩不像只有这么点`);
  }
  if (key === 'crew-brief') {
    if (!/<!--\s*CREW-BRIEF:BEGIN\s*-->/.test(text) || !/<!--\s*CREW-BRIEF:END\s*-->/.test(text)) bad.push('`CREW-BRIEF` 起止标记不全（`派活.mjs` 靠它抠卡片面，缺了整张卡就没有规则）');
    const body = String(crewBrief(text) ?? '');
    if (!body.trim()) bad.push('标记之间抠不出内容');
    else if (!body.includes('【硬禁止】')) bad.push('卡片面里没有【硬禁止】段（`派活.mjs` 是从这里开始截的）');
  }
  if (key === 'detail') {
    if (text.length < 2000) bad.push(`太短了（${text.length} 字符）—— 细则本该是"条件性规矩的全文"，短成这样像是被覆盖了`);
  }
  if ((text.match(/<!--/g) ?? []).length !== (text.match(/-->/g) ?? []).length) bad.push('HTML 注释没配平（`<!--` 与 `-->` 数量不等）');
  return bad;
}

/** 跑一次体检（**唯一判据源**）：条数体检 ＋ （改了卡片面时）前缀契约自检。 */
function selfCheck (key, text) {
  const rows = [];
  const cn = countRules(stripComments(text));
  rows.push({ id: '条数体检', ok: cn.count > 0, detail: `${cn.count} 条（不限字数 ${cn.noMin} · 只切标点 ${cn.punctOnly}）` });
  const bad = assertions(key, text);
  rows.push({ id: '文件专属断言', ok: bad.length === 0, detail: bad.length ? bad.join('；') : '锚点/占位符/围栏/标记 全过' });
  if (key === 'crew-brief') {
    const r = spawnSync(NODE, [join(UNATTENDED, '_前缀契约自检.mjs'), '--role', 'coder-b'], { encoding: 'utf8', maxBuffer: 16 << 20, timeout: 120000, cwd: UNATTENDED });
    const out = String(r.stdout ?? '') + String(r.stderr ?? '');
    const ok = r.status === 0 && /全过/.test(out);
    rows.push({ id: '前缀契约自检（卡里真内联了这段？）', ok, detail: (out.match(/[^\n]*全过[^\n]*/) ?? out.split('\n').filter(Boolean).slice(-1))[0]?.trim().slice(0, 200) ?? '' });
  }
  return { ok: rows.every(x => x.ok), rows };
}

/** 逐行 diff（**改前 → 改后**，一行一条；口径：先剥掉行尾空白再比，纯空白变动不算改动）。 */
export function lineDiff (before, after) {
  const a = before.split('\n').map(s => s.replace(/\s+$/, ''));
  const b = after.split('\n').map(s => s.replace(/\s+$/, ''));
  // 简单 LCS（文件只有几百行，够用且零依赖）
  const n = a.length; const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = []; let i = 0; let j = 0; let ln = 1;
  while (i < n && j < m) {
    if (a[i] === b[j]) { i++; j++; ln++; continue }
    if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ op: '-', ln, text: a[i] }); i++; ln++ }
    else { out.push({ op: '+', ln, text: b[j] }); j++ }
  }
  while (i < n) { out.push({ op: '-', ln, text: a[i++] }); ln++ }
  while (j < m) out.push({ op: '+', ln, text: b[j++] });
  return { rows: out.slice(0, 400), added: out.filter(x => x.op === '+').length, removed: out.filter(x => x.op === '-').length, truncated: out.length > 400 };
}

/** 页面用：三份文件的现状 ＋ **它改了要不要重启**（D7 的"立刻生效 vs 要重启"）。 */
export function rulesView () {
  const fs = [];
  for (const [key, f] of Object.entries(FILES)) {
    const r = { key, title: f.title, effect: f.effect, path: f.path, exists: existsSync(f.path), editable: true };
    try {
      const st = statSync(f.path);
      const text = readFileSync(f.path, 'utf8');
      r.chars = text.length; r.lines = text.split('\n').length; r.mtime = new Date(st.mtimeMs).toISOString();
      r.rules = countRules(stripComments(text)).count;
      r.comments = (text.match(/<!--[\s\S]*?-->/g) ?? []).length;
      r.injectedChars = stripComments(text).length;   // 注入时注释会被剥掉 ⇒ 这才是"真进上下文"的长度
      r.assert = assertions(key, text);
      r.ok = r.assert.length === 0;
    } catch (e) { r.ok = false; r.assert = [String(e?.message ?? e)] }
    fs.push(r);
  }
  return { available: true, files: fs, note: '规则类红灯在这一页处理：改前自动备份、改后必跑体检，不过就整体回滚（红灯不灭）。' };
}

/**
 * 增/改。返回 `{ ok, diff, selfCheck, backup, rolledBack }`。
 * **不过就回滚**：把备份拷回去，红灯留着 —— 宁可"这次没改成"，也不留一个自检过不了的规矩文件。
 */
export function rulesAction (op, p = {}) {
  const key = String(p.key ?? '');
  const f = FILES[key];
  if (!f) return { ok: false, error: `不在白名单里的文件：${key || '(空)'}（只允许 brain / crew-brief / detail）` };
  if (!existsSync(f.path)) return { ok: false, error: `文件不存在：${f.path}` };
  if (op === 'read') return { ok: true, key, path: f.path, content: readFileSync(f.path, 'utf8') };
  if (op !== 'save') return { ok: false, error: `不认识的 op：${op}（只认 read / save / check）` };
  if (typeof p.content !== 'string') return { ok: false, error: 'save 要带 content' };

  const before = readFileSync(f.path, 'utf8');
  const after = p.content.replace(/\r\n/g, '\n');
  if (before === after) return { ok: true, noop: true, msg: '内容没变，什么都没做', selfCheck: selfCheck(key, after) };

  const bk = backup(f.path, 'rulespanel');            // ② 改前自动备份
  writeFileSync(f.path, after, 'utf8');               // 写
  const check = selfCheck(key, after);                // ③ 改后必跑体检
  const diff = lineDiff(before, after);
  if (!check.ok) {                                    // 不过 ⇒ 回滚，红灯不灭
    if (bk) { try { copyFileSync(bk, f.path) } catch { } }
    return { ok: false, rolledBack: true, error: '体检没过 ⇒ **已整体回滚**（文件还原成改前那份；红灯不灭）', selfCheck: check, diff, backup: bk };
  }
  return { ok: true, selfCheck: check, diff, backup: bk, needRestart: key === 'brain', effect: f.effect, msg: key === 'brain' ? '已保存；**要重启桌面端才生效**' : '已保存；下一张卡/下一次读就生效' };
}

export { FILES as RULE_FILES };
