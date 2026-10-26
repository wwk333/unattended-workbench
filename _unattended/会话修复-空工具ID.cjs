#!/usr/bin/env node
/**
 * DSH 会话修复器：修复「空的工具调用身份」导致 session v4 拒绝加载的问题。
 *
 * 症状：`format v4 tool/result at seq N requires toolCallId matching its tool source`
 *      或加载时 `tool call id requires a nonempty string`
 * 成因：模型/网关在 block-end 里给出 `id: ""`、`name: ""` 的伪工具调用，
 *      空身份进入 tool/call，之后工具结果无法通过 V4 的身份一致性校验，会话永久卡死。
 *
 * 做法（保守，只动必要的字段）：
 *   1. 为空的 assistant 工具调用合成一个可辨识的调用 id（synthetic-call-N-<uuid>）；
 *   2. 同步改写 tool/call 的 callId；
 *   3. 追加 DSH 自己认可的 `TOOL_NOT_STARTED` 修复结果（"advertised" 生命周期只接受这一种，
 *      见 v3-to-v4 relationships 的 isExactToolNotStartedRepair）；
 *   4. 追加 step/end + turn/end 收尾；
 *   5. 用 DSH 自己的 restoreReleasedV4Artifact 校验通过后才发布，否则不写任何文件。
 *
 * 用法：
 *   预览（不写盘）： ELECTRON_RUN_AS_NODE=1 "DeepSeek Harness.exe" dsh-fix-empty-toolid.cjs <session.v4.jsonl.zstd>
 *   应用修复：       ... dsh-fix-empty-toolid.cjs <session.v4.jsonl.zstd> --apply
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

// ★W7：DSH 根不再写死（各人装在不同的盘）—— 取 config\本机映射.json 的「DSH根」
const _dshRoot = (() => {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config', '本机映射.json'), 'utf8'));
    const v = m && m['DSH根'];
    if (typeof v === 'string' && v && !v.startsWith('<')) return v;
  } catch {}
  return process.env.DSH_APP_ROOT || '';
})();
if (!_dshRoot) { console.error('❌ 不知道 DSH 装在哪：填 config\\本机映射.json 的「DSH根」（或设 DSH_APP_ROOT）'); process.exit(2); }
const ASAR = path.join(_dshRoot, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai');
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const NOT_STARTED_TEXT = 'The tool call was interrupted before the Harness recorded it as started. Retry it if it is still needed.';
const OK = (s) => console.log('  ' + s);
const BAD = (s) => console.log('  !! ' + s);

function loadDsh() {
  const V4 = require(`${ASAR}/dsh-session-format-v3-to-v4`);
  const SESSION = require(`${ASAR}/dsh-session`);
  return { V4, SESSION };
}

function decodeSession(file) {
  const buf = fs.readFileSync(file);
  if (!buf.subarray(0, 4).equals(MAGIC)) return { text: buf.toString('utf8'), compressed: false, buf };
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
    parts.push(zlib.zstdDecompressSync(buf.subarray(starts[i], end)));
  }
  return { text: Buffer.concat(parts).toString('utf8'), compressed: true, buf };
}

/** DSH 要求第一帧只包含 header 行。 */
function encodeSession(text) {
  const end = text.indexOf('\n') + 1;
  const options = { params: { [zlib.constants.ZSTD_c_checksumFlag]: 1 } };
  return Buffer.concat(
    [text.slice(0, end), text.slice(end)].filter(Boolean).map((part) => zlib.zstdCompressSync(part, options)),
  );
}

function validate(text, known) {
  const rows = text.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const { type, ...header } = rows[0];
  const artifact = { header: { ...header, version: 4 }, events: rows.slice(1), inheritedEventCount: 0 };
  const V4 = require(`${ASAR}/dsh-session-format-v3-to-v4`);
  V4.restoreReleasedV4Artifact(artifact, known);
  return rows.length - 1;
}

function main() {
  const args = process.argv.slice(2);
  const apply = args.includes('--apply');
  const file = args.find((a) => !a.startsWith('--'));
  if (!file) {
    console.error('用法: dsh-fix-empty-toolid.cjs <session.v4.jsonl.zstd> [--apply]');
    process.exit(2);
  }
  const { SESSION } = loadDsh();
  const known = SESSION.KNOWN_SESSION_EVENT_TYPES;
  const { text, compressed } = decodeSession(file);
  const lines = text.split('\n').filter((l) => l.trim());
  const rows = lines.map((l) => JSON.parse(l));
  const header = rows[0];
  const events = rows.slice(1);

  console.log(`会话: ${header.id}  cwd=${header.cwd ?? '-'}  事件 ${events.length} 条  ${compressed ? 'zstd' : 'plain'}`);

  const problems = [];
  for (const event of events) {
    if (event.type === 'assistant/message') {
      for (const block of event.data?.message?.content ?? []) {
        if (block?.type === 'tool-call' && (typeof block.id !== 'string' || block.id.length === 0)) {
          problems.push({ seq: event.seq, kind: 'assistant tool-call', block });
        }
      }
    }
    if (event.type === 'tool/call' && (typeof event.data?.callId !== 'string' || event.data.callId.length === 0)) {
      problems.push({ seq: event.seq, kind: 'tool/call', event });
    }
  }

  if (problems.length === 0) {
    OK('没有发现空的工具调用身份。');
    try {
      const n = validate(text, known);
      OK(`DSH 校验通过（${n} 条事件），无需修复。`);
      return;
    } catch (err) {
      BAD(`但 DSH 校验仍然拒绝：${err.message}`);
      process.exit(1);
    }
  }
  for (const p of problems) BAD(`seq ${p.seq} 空身份：${p.kind}`);

  // —— 规划修复 ——
  const repairedLines = lines.slice();
  const newEvents = events.map((e) => e);
  const bySeq = new Map(newEvents.map((e, i) => [e.seq, i]));
  const assigned = [];
  let madeResults = 0;

  const existingCallIds = new Set();
  for (const e of newEvents) {
    if (e.type === 'tool/call' && typeof e.data?.callId === 'string' && e.data.callId) existingCallIds.add(e.data.callId);
    for (const block of e.type === 'assistant/message' ? e.data?.message?.content ?? [] : []) {
      if (block?.type === 'tool-call' && typeof block.id === 'string' && block.id) existingCallIds.add(block.id);
    }
  }
  const freshCallId = (seq) => {
    let callId;
    do callId = `synthetic-call-${seq}-${crypto.randomUUID()}`; while (existingCallIds.has(callId));
    existingCallIds.add(callId);
    return callId;
  };

  // 先处理 assistant 声明（身份由它定义），再让 tool/call 认领同一个 id
  const anonymousBlocks = [];
  for (const p of problems) {
    const event = newEvents[bySeq.get(p.seq)];
    if (event.type !== 'assistant/message') continue;
    for (const block of event.data.message.content) {
      if (block?.type !== 'tool-call' || (typeof block.id === 'string' && block.id.length > 0)) continue;
      const callId = freshCallId(event.seq);
      block.id = callId;
      anonymousBlocks.push({ seq: event.seq, callId, name: block.name, arguments: block.arguments });
      assigned.push({ seq: event.seq, callId });
    }
  }
  const unclaimed = [...anonymousBlocks];
  for (const p of problems) {
    const event = newEvents[bySeq.get(p.seq)];
    if (event.type !== 'tool/call') continue;
    const match =
      unclaimed.find((b) => (b.name ?? '') === (event.data.name ?? '') && (b.arguments ?? '') === (event.data.arguments ?? '')) ??
      unclaimed[0];
    if (!match) {
      BAD(`seq ${p.seq} 的 tool/call 找不到对应的 assistant 声明，拒绝修复。`);
      process.exit(1);
    }
    unclaimed.splice(unclaimed.indexOf(match), 1);
    event.data.callId = match.callId;
    assigned.push({ seq: event.seq, callId: match.callId });

    const hasResult = newEvents.some((e) => e.type === 'tool/result' && e.data?.message?.source?.callId === match.callId);
    if (!hasResult) {
      const seq = Math.max(...newEvents.map((e) => e.seq)) + 1;
      newEvents.push({
        type: 'tool/result',
        seq,
        time: event.time,
        data: {
          turn: event.data.turn,
          step: event.data.step,
          message: {
            id: `interrupted-tool-result-${match.callId}-${seq}`,
            role: 'tool',
            toolCallId: match.callId,
            isError: true,
            source: { kind: 'tool', callId: match.callId },
            content: [{ type: 'text', text: NOT_STARTED_TEXT }],
          },
          error: { name: 'ToolNotStartedError', code: 'TOOL_NOT_STARTED' },
        },
        surfaceOp: 'append',
      });
      madeResults++;
    }
  }

  // —— 收尾：把还开着的 step / turn 闭合 ——
  const last = () => newEvents[newEvents.length - 1];
  let openTurn = null;
  let openStep = null;
  for (const e of newEvents) {
    if (e.type === 'turn/start') { openTurn = e.data.turn; openStep = null; }
    else if (e.type === 'turn/end') { openTurn = null; openStep = null; }
    else if (e.type === 'step/start') openStep = e.data.step;
    else if (e.type === 'step/end') openStep = null;
  }
  const closers = [];
  if (openTurn !== null) {
    let seq = last().seq + 1;
    const time = last().time;
    if (openStep !== null) {
      closers.push({ type: 'step/end', seq: seq++, time, data: { turn: openTurn, step: openStep } });
    }
    closers.push({ type: 'turn/end', seq, time, data: { turn: openTurn, reason: { kind: 'interrupted' } } });
  }
  newEvents.push(...closers);

  const evidence = {
    seq: null,
    time: null,
    data: {
      source: { kind: 'session-repair', tool: 'dsh-fix-empty-toolid' },
      repairedSeqs: assigned.map((a) => a.seq),
      assignedCallIds: assigned.map((a) => a.callId),
      syntheticResults: madeResults,
      closers: closers.map((c) => c.seq),
      originalRows: events.length,
      note: '空的工具调用身份（provider block-end 给出 id:"", name:""）已合成调用 id 并用 TOOL_NOT_STARTED 结果闭合；正文与其余事件未改动。',
    },
  };
  console.log('  计划：');
  for (const a of assigned) OK(`seq ${a.seq} → callId ${a.callId}`);
  OK(`追加 ${madeResults} 条 TOOL_NOT_STARTED 修复结果，${closers.length} 条收尾事件（step/end、turn/end）`);

  const repairedText = [JSON.stringify(header), ...newEvents.map((e) => JSON.stringify(e))].join('\n') + '\n';

  // —— 用 DSH 自己的校验器验证 ——
  try {
    const n = validate(repairedText, known);
    OK(`DSH 校验通过（${n} 条事件）`);
  } catch (err) {
    BAD(`修复后仍被 DSH 拒绝，未写入任何文件：${err.message}`);
    process.exit(1);
  }

  if (!apply) {
    console.log('\n预览模式：未写盘。加 --apply 落地。');
    return;
  }

  const dir = path.dirname(file);
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupDir = path.join(dir, `repair-backup-${stamp}`);
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, path.basename(file));
  fs.copyFileSync(file, backup);
  OK(`原文件已备份：${backup}`);
  OK(`原文件 sha256=${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`);

  const staged = path.join(dir, `.session.v4.jsonl.zstd.repaired-${process.pid}`);
  fs.writeFileSync(staged, compressed ? encodeSession(repairedText) : Buffer.from(repairedText));

  // 再读回校验一次（防止编码环节出错）
  const reread = decodeSession(staged);
  try {
    validate(reread.text, known);
  } catch (err) {
    fs.rmSync(staged, { force: true });
    BAD(`暂存文件回读校验失败，已放弃：${err.message}`);
    process.exit(1);
  }
  fs.renameSync(staged, file);
  OK(`已发布修复后的会话：${file}`);
  OK(`修复后 sha256=${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`);
  console.log('\n下一步：在 DSH 里重新打开这个会话，或让无人值守编排重新接管它。');
}

main();
