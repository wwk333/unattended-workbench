/**
 * A（让回合数可见）· 验收脚本（零 token，可反复跑）
 *
 * 四段：
 *   ① 口径：三种信封族各取一次，并**反向验"不双计/不编 0"**
 *   ② 端到端：真信封 → 解析器 → 账本口（`readEnvelope` 那条路）→ 落盘
 *   ③ 看板：真数据里大脑行带回合数；职位行用**临时账本**受控验（不碰真账本）
 *   ④ 纪律：拿不到就是 `null`（不是 0）
 *
 * 为什么要有它：这一项以前**没人验**（`numTurns` 恒 null 没人发现）。
 */
import { readFileSync, writeFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseCarrierOutput } from './_agents-config.mjs'
import { WORKSPACE } from './_路径.mjs'

// ★ 2026-10-27（开源准备 W2）：工作台根从 `_路径.mjs` 推（= 本文件的上一级），不再写死盘符。
const ROOT = WORKSPACE
const U = join(ROOT, '_unattended')
let fails = 0
const ok = (c, m) => { console.log((c ? '✅ ' : '❌ ') + m); if (!c) fails++ }
const info = (m) => console.log('   ' + m)

console.log('\n① 口径（三种信封族 ＋ 不双计/不编 0）')
{
  // OpenCode：一步＝一个 step_finish；step_start 不算步
  const s = '{"type":"step_start"}\n{"type":"step_finish","part":{"tokens":{"input":1}}}\n'
    + '{"type":"step_finish","part":{"tokens":{"input":1}}}\n{"type":"step_start"}'
  const r = parseCarrierOutput(s, '')
  ok(r.numTurns === 2, `OpenCode：2 个 step_finish + 2 个 step_start ⇒ 回合 ${r.numTurns}（期望 2，step_start 不算）`)

  // Pi：message_end 与同一 message 的 turn_end 只算一步
  const p = '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"a"}],"stopReason":"stop","usage":{"input":1}}}\n'
    + '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"a"}],"stopReason":"stop","usage":{"input":1}}}'
  const r2 = parseCarrierOutput(p, '')
  ok(r2.numTurns === 1, `Pi：message_end ＋ 重复 turn_end ⇒ 回合 ${r2.numTurns}（期望 1，不双计）`)

  // 载体自报优先
  const q = '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"a"}],"stopReason":"stop","usage":{"input":1}}}\n'
    + '{"type":"agent_settled","num_turns":9}'
  ok(parseCarrierOutput(q, '').numTurns === 9, '载体自报 num_turns ⇒ 以它为准（9）')

  // 数组族（CodeBuddy/Qwen）
  const a = '[{"type":"message","role":"assistant","content":[{"type":"text","text":"OK"}]},'
    + '{"type":"result","subtype":"success","is_error":false,"result":"DONE","num_turns":7,"usage":{"input_tokens":1}}]'
  ok(parseCarrierOutput(a, '').numTurns === 7, '数组族 num_turns ⇒ 7')

  // 拿不到 ⇒ null（不编 0）
  const n = '{"type":"result","subtype":"completed","is_error":false,"result":"OK","usage":{"input_tokens":1}}'
  const rn = parseCarrierOutput(n, '')
  ok(rn.numTurns === null && rn.numTurns !== 0, `拿不到 ⇒ ${JSON.stringify(rn.numTurns)}（**不是 0**）`)
}

console.log('\n② 端到端：真信封 → 解析器 → 账本 → 落盘')
const tmpDir = mkdtempSync(join(tmpdir(), 'rounds-'))
const ledgerCopy = join(tmpDir, 'ledger.json')
copyFileSync(join(ROOT, '_crew', 'ledger.json'), ledgerCopy)
{
  const realEnv = join(ROOT, '_probe', 'role-skills', 's9', 'S9-SKILL-1.out.json')
  const r = parseCarrierOutput(readFileSync(realEnv, 'utf8'), '')
  ok(r.numTurns > 0, `真信封（OpenCode 族）解析出回合数 ${r.numTurns}`)

  const run = spawnSync(process.execPath, [join(U, '工量账本.mjs'), 'add', '--role', 'coder-b',
    '--task', 'A-VERIFY', '--envelope', realEnv, '--force'],
    { encoding: 'utf8', env: { ...process.env, DSH_LEDGER: ledgerCopy }, windowsHide: true })
  ok(run.status === 0, `账本 add 退出码 ${run.status}`)
  const j = JSON.parse(readFileSync(ledgerCopy, 'utf8'))
  const rec = j.calls[j.calls.length - 1]
  ok(rec.numTurns === r.numTurns, `落盘记录 numTurns=${rec.numTurns}（与解析器一致 ${r.numTurns}）`)
  const list = spawnSync(process.execPath, [join(U, '工量账本.mjs'), 'list', '--n', '1'],
    { encoding: 'utf8', env: { ...process.env, DSH_LEDGER: ledgerCopy }, windowsHide: true })
  ok(/turns=\d+/.test(list.stdout), `账本 list 看得见回合数（${(list.stdout.match(/turns=\S+/) || [''])[0]}）`)
}

console.log('\n③ 看板（真数据 + 临时账本受控验职位行）')
{
  // 真数据：大脑行应带回合数（账本里历史有 4 条 numTurns）
  const board = spawnSync(process.execPath, [join(U, '看板数据.mjs'), '--quiet'], { encoding: 'utf8', windowsHide: true })
  ok(board.status === 0, '看板数据生成成功')
  const b = JSON.parse(readFileSync(join(ROOT, '_crew', 'board-data.json'), 'utf8'))
  const brainText = b.brainRow?.consumptionText ?? ''
  ok(/回合/.test(brainText) || b.brainRow?.turns == null, `大脑行消耗文案：${brainText}`)

  // 受控：复制一条真实的**本工作区**记录，只改 numTurns ⇒ 职位行应合计出来
  // ★ 2026-10-13 修：原来写死"异次元 coder-a"当模板 —— 而本板的 `crewByProject` **只渲染本工作区的项目**
  //   （`看板数据.mjs` 的 `RUNS_PROJECTS` ＝ `ROOT\_crew\runs` ＋ `workspaces\*`，**不含 `<示例项目>`**）
  //   ⇒ 那条模板被加进去之后**落不到任何渲染出来的行上**，本节**自写下来就一直是红的**（不在套件里，没人发现）。
  //   改成"按 envelope 落在本工作区里的记录"取模板。
  const j = JSON.parse(readFileSync(join(ROOT, '_crew', 'ledger.json'), 'utf8'))
  const tpl = j.calls.find((c) => c.role && String(c.envelope ?? '').toLowerCase().startsWith(ROOT.toLowerCase()))
  if (!tpl) { ok(false, '找不到可用的模板记录（envelope 落在本工作区里的那条）') } else {
    j.calls.push({ ...tpl, numTurns: 7, at: '2026-10-10T02:00:00.000Z', task: 'A-VERIFY-7' },
      { ...tpl, numTurns: 5, at: '2026-10-10T02:05:00.000Z', task: 'A-VERIFY-5' })
    const tmpLedger = join(tmpDir, 'ledger-board.json')
    writeFileSync(tmpLedger, JSON.stringify(j), 'utf8')
    // 看板数据认 DSH_LEDGER；它会把 board-data.json 写给面板看 —— 先备份真件，用完还原
    const realBoard = join(ROOT, '_crew', 'board-data.json')
    const backup = readFileSync(realBoard)
    const r = spawnSync(process.execPath, [join(U, '看板数据.mjs'), '--quiet'],
      { encoding: 'utf8', env: { ...process.env, DSH_LEDGER: tmpLedger }, windowsHide: true })
    const bb = JSON.parse(readFileSync(realBoard, 'utf8'))
    let hit = null
    for (const p of (bb.crewByProject || [])) for (const rr of (p.roles || [])) if (rr.turns != null) hit = { ...rr, project: p.project }
    ok(Boolean(hit), `临时账本下职位行合计出回合数：${hit ? hit.project + ' / ' + hit.role + ' = ' + hit.turns + '（期望 12）' : '没找到'}`)
    ok(hit?.turns === 12, `合计值 = ${hit?.turns}（期望 12 ⇒ 7+5 两个信封都被算上）`)
    writeFileSync(realBoard, backup)     // 还原真数据
    info('已还原真 board-data.json（临时账本只影响那一次）')
    void r
  }
}

rmSync(tmpDir, { recursive: true, force: true })
console.log('\n' + (fails ? `❌ A 验收：${fails} 项不达标` : '✅ A 验收：全部通过'))
process.exit(fails ? 1 : 0)
