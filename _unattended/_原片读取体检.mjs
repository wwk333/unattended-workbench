/**
 * 原片读取体检 —— 「**大脑到底读没读过载体的原始信封（`out.json`）**」的机器判据（零 token）。
 * ★ b202（施工文档 §四 M6-6 的收尾）：b144 给了"一次都没读过"的结论，b191 只复测了**文件数**、没复测"读没读过"
 *   ⇒ 这里补一个**可复跑**的证据面。
 *
 * ⚠️ 第一版判据太松（把"正文里提到 out.json"、以及含 grep/Read 字样的散文都算成"读" ⇒ 报了 366 处、
 *    75 个会话，全是假的）。现在**只认工具入参**，并按下面三层细分 —— "提到"永远不算"读"：
 *
 *   ① **写**：命令里 `>` 后面跟着 `xxx.out.json`（派活/编排本来就重定向写它）⇒ 不算读；
 *   ② **读**：**读类工具**（Read／fs_read／read_file／Get-Content／cat／head／tail／jq）的**入参路径**
 *      以 `.out.json` 结尾，或 **shell 类工具**的命令里有"**不带 `>` 的** `.out.json` 裸 token"；
 *   ③ **搜**：搜索类工具（grep／rg／Select-String）里出现 out.json ⇒ 只是"按名字找过"，单独计；
 *   ④ **提**：助手正文里出现 ⇒ 只是"谈到它"，单独计。
 *
 * 用法：node _原片读取体检.mjs [--days 30] [--list 8] [--json]
 */
import fs from 'node:fs';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d };
const DAYS = Number(opt('days', 30));
const JSON_OUT = argv.includes('--json');
const LIMIT = Number(opt('list', 8));

const SESS_ROOT = process.env.DSH_SESSIONS ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', '.dsh', 'sessions');
const NAME_RE = /out\.json/i;

function readSession (file) {
  const buf = fs.readFileSync(file);
  const offs = [];
  for (let i = 0; i + 3 < buf.length; i++) if (buf[i] === 0x28 && buf[i + 1] === 0xB5 && buf[i + 2] === 0x2F && buf[i + 3] === 0xFD) offs.push(i);
  const recs = [];
  for (let k = 0; k < offs.length; k++) {
    const end = k + 1 < offs.length ? offs[k + 1] : buf.length;
    let t = '';
    try { t = zlib.zstdDecompressSync(buf.subarray(offs[k], end)).toString('utf8') } catch { continue }
    for (const L of t.split(/\r?\n/)) { if (L[0] !== '{') continue; try { recs.push(JSON.parse(L)) } catch { } }
  }
  return recs;
}

/** 工具名 → 类别（各家命名不一，按语义归三类）。 */
function kindOf (name) {
  const n = String(name ?? '').toLowerCase().replace(/^(mcp_|functions?[._])/, '');
  if (/^(read|read_file|readfile|fs_read|view|open|get-content|get_content|cat|head|tail|jq)$/.test(n)) return 'read'
  if (/(grep|rg|search|select-string|select_string|glob)/.test(n)) return 'search'
  if (/(bash|shell|exec|run|pwsh|powershell|terminal|command)/.test(n)) return 'shell'
  return 'other'
}

/** 从工具入参里挑出"路径"与"命令"两类字符串（入参常常是 JSON 字符串，尽量解）。
 *  ⚠️ 第一版这里有个坑：入参**不是合法 JSON**（很多 shell 工具直接传纯命令串）时，我把它塞进 `__raw`，
 *     而后面的键名白名单里没有 `__raw` ⇒ **整条命令被丢掉了** ⇒ 读/写全漏（实测报了"入参 0 个"，明显不对）。 */
function stringsOf (raw) {
  const paths = []; const cmds = [];
  let v = raw;
  if (typeof v === 'string') {
    try { v = JSON.parse(v) } catch { cmds.push(raw) }   // ← 纯命令串：**直接当命令**，别丢
  }
  if (v && v.__raw) cmds.push(String(v.__raw));
  ;(function walk (o) {
    if (o == null) return;
    if (typeof o === 'string') { if (/\S/.test(o)) cmds.push(o); return }
    if (Array.isArray(o)) { for (const x of o) walk(x); return }
    if (typeof o !== 'object') return;
    for (const [k, x] of Object.entries(o)) {
      if (/^(path|file_path|filepath|file|target|filename|abs_path)$/i.test(k) && typeof x === 'string') paths.push(x);
      else if (/^(command|cmd|script|input|code)$/i.test(k) && typeof x === 'string') cmds.push(x);
      else if (x && typeof x === 'object') walk(x);
    }
  })(v);
  return { paths, cmds };
}

/** 一条命令里 out.json 是"被写"还是"被读"（按 shell 分段看 `>`）。 */
function shellVerdict (cmd) {
  let sawRead = null; let sawWrite = null; let sawMeta = null; let sawPathVar = null
  for (const seg of String(cmd).split(/[\n;]|&&|\|\|/)) {
    const m = seg.match(/[^\s"'|]*out\.json[^\s"']*/ig)
    if (!m) continue
    for (const tok of m) {
      const idx = seg.indexOf(tok)
      const before = seg.slice(Math.max(0, idx - 2), idx)
      if (/>\s*$/.test(before)) { sawWrite = tok; continue }
      // ★ b202 分三档（实测样本里三种都真实存在，混在一起看会得出相反结论）：
      //   · 读内容：readFileSync / Get-Content / cat / head / tail / require( / jq / JSON.parse
      if (/(readFileSync|Get-Content|cat\b|head\b|tail\b|require\s*\(|jq\b|JSON\.parse|StreamReader)/i.test(seg)) { sawRead = seg.trim().slice(0, 200); continue }
      //   · 只取元数据：列目录 / 取属性 / 测存在 —— **这正是 M6-6 要补进收据的三个数**
      if (/(Get-ChildItem|Get-Item|Test-Path|Select-Object|Length|LastWriteTime|\bstat\b|\bls\b|\bdir\b|Resolve-Path)/i.test(seg)) { sawMeta = seg.trim().slice(0, 200); continue }
      //   · 只是把路径赋给变量（这句看不出读没读）
      sawPathVar = seg.trim().slice(0, 200)
    }
  }
  return { read: sawRead, write: sawWrite, meta: sawMeta, pathVar: sawPathVar }
}

const files = [];
(function walkDir (d) {
  let e = []; try { e = fs.readdirSync(d, { withFileTypes: true }) } catch { return }
  for (const x of e) { const p = join(d, x.name); if (x.isDirectory()) walkDir(p); else if (x.name === 'session.v4.jsonl.zstd') files.push(p) }
})(SESS_ROOT);

const cutoff = Date.now() - DAYS * 86400_000;
const reads = []; const writes = []; const searches = []; const mentions = []; const metas = []; const pathVars = [];
let scanned = 0; const sessionsWithName = new Set();

for (const f of files) {
  let st; try { st = fs.statSync(f) } catch { continue }
  if (st.mtimeMs < cutoff) continue;
  scanned++;
  const sid = basename(dirname(f));
  let recs; try { recs = readSession(f) } catch { continue }
  for (const rec of recs) {
    const at = rec.time ? new Date(rec.time).toISOString() : new Date(st.mtimeMs).toISOString();
    /** 处理一条工具调用（⭐ 判据核心：只看**入参**，正文只算"提及"）。 */
    const checkCall = (name, args) => {
      const { paths, cmds } = stringsOf(args);
      if (![...paths, ...cmds].some(s => NAME_RE.test(s))) return;
      sessionsWithName.add(sid);
      const k = kindOf(name);
      const hitPath = paths.find(p => /out\.json\s*$/i.test(String(p).trim()));
      if (k === 'read' && hitPath) { reads.push({ sid, at, tool: name, why: '读类工具的路径就是 out.json', sample: hitPath }); return }
      if (k === 'shell') {
        for (const cmd of cmds) {
          const v = shellVerdict(cmd);
          if (v.read) reads.push({ sid, at, tool: name, why: 'shell 里读了内容（不带 > 重定向）', sample: v.read });
          else if (v.meta) metas.push({ sid, at, tool: name, sample: v.meta });
          else if (v.pathVar) pathVars.push({ sid, at, tool: name, sample: v.pathVar });
          if (v.write) writes.push({ sid, at, tool: name, sample: v.write });
        }
        return;
      }
      if (k === 'search') { searches.push({ sid, at, tool: name, sample: [...paths, ...cmds].find(s => NAME_RE.test(s))?.slice(0, 160) }); return }
      // 其它工具（bash 之外的 read 类没带路径等）：保守算"提及"
      mentions.push({ sid, at, sample: String([...paths, ...cmds].find(s => NAME_RE.test(s)) ?? '').slice(0, 160) });
    };
    // ★ 真形状（b202 实测）：`{type:'tool/call', data:{name, arguments}}` —— **在外层判 type**
    if (rec.type === 'tool/call' && rec.data) checkCall(rec.data.name, rec.data.arguments ?? rec.data.input);
    // ★ 只看**工具调用**（b202 定稿）：原来还扫助手正文统计"提及"数 —— 那既非本判据所需，
    //   又让它被 `_禁散文自检.mjs` 判成"读散文取状态"（它读的该是**结构化转录 + 工具入参**，不是人写散文）。
    if (rec.type === 'tool/result' && rec.data) {
      // 工具结果里出现 out.json 字样只是"回显"，**不计入任何一档**（降噪）
      continue
    }
    const walk = (o, depth = 0) => {
      if (!o || typeof o !== 'object' || depth > 6) return;
      if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return }
      // 其它载体的形状（保留兼容；DSH 自己走上面的 tool/call 分支）
      if (Array.isArray(o.tool_calls)) for (const t of o.tool_calls) checkCall(t?.function?.name ?? t?.name, t?.function?.arguments ?? t?.arguments ?? t?.input);
      if (o.type === 'tool_use' || o.type === 'tool_call') checkCall(o.name ?? o?.function?.name, o.input ?? o.arguments);
      if (o.function_call) checkCall(o.function_call?.name, o.function_call?.arguments);
      // ⚠️ **不扫助手正文**（b202）：本判据只认"工具入参"，正文里的字样既不算读、也不是状态来源。
      for (const v of Object.values(o)) if (v && typeof v === 'object') walk(v, depth + 1);
    };
    walk(rec.data ?? rec);
  }
}

const uniqReadSessions = [...new Set(reads.map(x => x.sid))];
const out = {
  ok: reads.length === 0, days: DAYS, scanned,
  sessionsMentioningName: sessionsWithName.size,
  counts: { read: reads.length, readSessions: uniqReadSessions.length, write: writes.length, search: searches.length, mention: mentions.length },
  readSessions: uniqReadSessions,
  reads: reads.slice(0, LIMIT), searches: searches.slice(0, 3), mentions: mentions.slice(0, 3)
};
if (JSON_OUT) { process.stdout.write(JSON.stringify(out, null, 2) + '\n'); process.exit(out.ok ? 0 : 1) }

console.log(`🔬 原片读取体检 · 最近 ${DAYS} 天扫了 ${scanned} 个会话`);
console.log(`   入参里出现过 \`out.json\` 名字的会话：**${sessionsWithName.size}** 个`);
console.log(`   计数：**读 ${reads.length}**（${uniqReadSessions.length} 会话） / 写 ${writes.length}（正常：派活本来就重定向写它） / 搜 ${searches.length}（按名字找过） / 正文提及 ${mentions.length}`);
if (!reads.length) {
  console.log(`\n✅ **没有一次"读原片"的痕迹** ⇒ 「大脑历史上没读过原始信封」在最近 ${DAYS} 天里**成立**。`);
} else {
  console.log(`\n⚠️ **有 ${reads.length} 处真"读原片"**：`);
  for (const r of out.reads) console.log(`   · ${r.at.slice(0, 19)} ${r.sid}　${r.tool}　${r.why}\n     ${String(r.sample).replace(/\s+/g, ' ').slice(0, 170)}`);
}
if (searches.length) {
  console.log(`\n（${searches.length} 处"按名字搜过"—— 不算读，但值得知道：）`);
  for (const r of out.searches) console.log(`   · ${r.at.slice(0, 19)} ${r.sid}　${r.tool}\n     ${String(r.sample).replace(/\s+/g, ' ').slice(0, 150)}`);
}
// ⚠️ 这是**报告**不是门禁：找到"读过"说明的是**旧结论不成立**，不是"系统坏了下班"。
//    所以**永远 exit 0**（要当门禁用就加 --strict，那时再把 exit 1 打开）。
process.exit(argv.includes('--strict') ? (out.ok ? 0 : 1) : 0);
