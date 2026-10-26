#!/usr/bin/env node
/**
 * DSH 会话体检：扫描所有会话日志，找出会被 V4 校验器拒绝的「空工具身份」等问题。
 *
 * 用法（只读，不改任何文件）：
 *   ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" dsh-session-doctor.cjs [sessionsRoot...]
 * 默认扫描 %USERPROFILE%\.dsh\sessions 与 <盘符>\ 下其它已知会话根。
 *
 * 退出码：0 = 全部健康；1 = 发现需要修复的会话。
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const zlib = require('node:zlib');

const ASAR = 'D:/dsh桌面端/resources/app.asar/dsh/node_modules/@deepseek-ai';
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

// ★★ 2026-10-07 死保护（**由一次真实误判换来，别拆**）：
//   V4 校验器在 **app.asar 内部**，而 **asar 只有 Electron 进程能读** —— 用**普通 node** 跑这个脚本，
//   `require` **必然**失败。原实现把它和"会话真被校验器拒绝"catch 成同一个 `rejected:`，
//   于是"校验器装不上"被当成"**每一个** v4 会话都载入被拒"，还会**无条件建议对它们跑 `--apply`**。
//   实测（2026-10-07）：普通 node 跑出 **137 条假清单**（连"当前正在用的那个会话"都在里面），
//   而**同一脚本按文件头的方式跑**（ELECTRON_RUN_AS_NODE=1）真值是：真故障 **1** 条、空身份 **0** 例。
//   ⇒ 现在**先探一次校验器**：装不上就整轮"判不了"（exit=3），**不列任何待修、不建议 --apply**。
const VALIDATOR = (() => {
  try {
    const V4 = require(`${ASAR}/dsh-session-format-v3-to-v4`);
    const SESSION = require(`${ASAR}/dsh-session`);
    return { V4, SESSION };
  } catch (err) {
    return { error: err };
  }
})();

function decodeSession(file) {
  const buf = fs.readFileSync(file);
  if (!buf.subarray(0, 4).equals(MAGIC)) return buf.toString('utf8');
  const starts = [];
  let offset = 0;
  while (offset < buf.length) {
    const idx = buf.indexOf(MAGIC, offset);
    if (idx === -1) break;
    starts.push(idx);
    offset = idx + 4;
  }
  if (starts.length === 0 || starts[0] !== 0) starts.unshift(0);
  const parts = [];
  for (let i = 0; i < starts.length; i++) {
    const end = i + 1 < starts.length ? starts[i + 1] : buf.length;
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(starts[i], end))); } catch { /* torn frame */ }
  }
  return Buffer.concat(parts).toString('utf8');
}

function findLogs(root, acc = []) {
  let entries = [];
  try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const p = path.join(root, e.name);
    // 修复器留下的备份目录不参与判定，避免把备份本身报成故障。
    if (e.isDirectory() && /^(repair-backup-|\.trash|_backups?$)/.test(e.name)) continue;
    if (e.isDirectory()) findLogs(p, acc);
    else if (e.name.endsWith('.jsonl.zstd')) acc.push(p);
  }
  return acc;
}

function inspect(file) {
  const rows = decodeSession(file).split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const header = rows[0];
  const events = rows.slice(1);
  const problems = [];
  // 预发布格式（v0–v3）由各自的迁移边负责，不能用 V4 校验器判死。
  if (header.version !== 4) {
    return { header, events, problems, loads: `skip: 旧格式 v${header.version}（由 v${header.version}→v4 迁移边接管）`, mtime: fs.statSync(file).mtime };
  }
  for (const event of events) {
    if (event.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) {
        if (block?.type === 'tool-call' && (typeof block.id !== 'string' || block.id.length === 0)) {
          problems.push(`seq ${event.seq}: assistant 工具调用身份为空（name=${JSON.stringify(block.name ?? '')}）`);
        }
      }
    }
    if (event.type === 'tool/call' && (typeof event.data?.callId !== 'string' || event.data.callId.length === 0)) {
      problems.push(`seq ${event.seq}: tool/call 的 callId 为空`);
    }
    if (event.type === 'tool/result') {
      const m = event.data?.message;
      const cid = m?.source?.callId;
      if (typeof m?.toolCallId !== 'string' || m.toolCallId.length === 0 || cid !== m.toolCallId) {
        problems.push(`seq ${event.seq}: tool/result 的 toolCallId 与 source.callId 不一致`);
      }
    }
  }
  let loads = 'unknown';
  if (!VALIDATOR.error) {
    try {
      const { V4, SESSION } = VALIDATOR;
      const { type, ...rest } = header;
      V4.restoreReleasedV4Artifact(
        { header: { ...rest, version: 4 }, events, inheritedEventCount: 0 },
        SESSION.KNOWN_SESSION_EVENT_TYPES,
      );
      loads = 'ok';
    } catch (err) {
      // 到这里才是**真**"校验器拒了它"（校验器本身已确认装得上，见上面的死保护）
      loads = `rejected: ${err.message}`;
    }
  }
  return { header, events, problems, loads, mtime: fs.statSync(file).mtime };
}

function main() {
  const roots = process.argv.slice(2);
  if (roots.length === 0) {
    roots.push(path.join(os.homedir(), '.dsh', 'sessions'));
    for (const extra of ['D:/dsh桌面端/workspaces', 'E:/多agent工作台']) if (fs.existsSync(extra)) roots.push(extra);
  }

  // ★★ 死保护：校验器装不上 ⇒ **整轮判不了**，绝不退化成"每个会话都有问题"（见文件上部说明）。
  if (VALIDATOR.error) {
    console.log('⛔ 判不了：V4 校验器装不上 —— ' + VALIDATOR.error.message);
    console.log('');
    console.log('   原因：校验器在 app.asar 内部，而 asar **只有 Electron 进程能读**（普通 node 读不了）。');
    console.log('   ⇒ 必须按本文件头写的方式跑：');
    console.log('     cmd /c "set ELECTRON_RUN_AS_NODE=1&& \\"<DSH根>\\DeepSeek Harness.exe\\" \\"<本文件路径>\\""');
    console.log('');
    console.log('   ⚠️ 用普通 node 跑会把**每一个** v4 会话都误报成"载入被拒"，并建议对它们跑');
    console.log('      `会话修复-空工具ID.cjs --apply` —— **那是会真改文件的**，千万不要照做。');
    console.log('      （实测 2026-10-07：普通 node 出 137 条假清单，真值只有 1 条、且不是空身份问题。）');
    process.exitCode = 3;   // 独立退出码：3 = 判不了（**不是** 0"全健康"，也**不是** 1"有待修"）
    return;
  }

  const logs = roots.flatMap((r) => findLogs(r)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  console.log(`扫描 ${logs.length} 个会话日志（根：${roots.join(', ')}）\n`);
  let emptyId = 0;      // ★ 真需要修：查出"空身份"这类（本工具治得了）
  let rejected = 0;     // ★ 载入被拒，但**不是**空身份问题（本工具**治不了**，别乱建议 --apply）
  let skipped = 0;
  for (const log of logs) {
    let result;
    try { result = inspect(log); } catch (err) { console.log(`?? 无法解析 ${log}: ${err.message}`); continue; }
    if (result.loads.startsWith('skip:')) { skipped++; continue; }
    const hasEmptyId = result.problems.length > 0;
    const isRejected = result.loads.startsWith('rejected:');
    if (!hasEmptyId && !isRejected) continue;          // 健康

    console.log(`=== ${result.header.id}  (${result.events.length} 事件, 最后写于 ${result.mtime.toLocaleString('zh-CN')})`);
    console.log(`    载入: ${result.loads}`);
    for (const p of result.problems.slice(0, 5)) console.log(`    - ${p}`);
    console.log(`    文件: ${log}`);
    // ★ 建议必须**对症**：只有真查出空身份时才推荐这个修复器（它只治这一类）。
    if (hasEmptyId) {
      emptyId++;
      console.log(`    修复: 先备份，再运行 会话修复-空工具ID.cjs "<文件>" --apply（**它只治"空身份"这一类**）\n`);
    } else {
      rejected++;
      console.log(`    ⚠️ **本工具治不了它**：没有"空身份"问题，是校验器自己拒的（原因见上面的 \`载入:\` 行）。`);
      console.log(`       别对它跑 会话修复-空工具ID.cjs --apply —— 那会白改文件。要修得按这个原因单独分析。\n`);
    }
  }
  const bits = [];
  if (emptyId) bits.push(`**空身份待修 ${emptyId} 个**（会话修复-空工具ID.cjs 可治）`);
  if (rejected) bits.push(`载入被拒 ${rejected} 个（**不是**空身份问题，本工具治不了）`);
  if (bits.length === 0) console.log(`全部 v4 会话均可正常载入。${skipped ? `（跳过 ${skipped} 个旧格式会话）` : ''}`);
  else console.log(`发现：${bits.join('；')}。${skipped ? `（另有 ${skipped} 个旧格式会话未判定）` : ''}`);
  process.exitCode = (emptyId + rejected) === 0 ? 0 : 1;
}

main();
