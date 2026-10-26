/**
 * 阶段 6（补）· 监控判据：**"在不在调工具"到底认什么形状**
 *
 * 事故（2026-10-27 真跑当场抓到）：
 *   审核员一次真跑调了 **67 次工具**，监控数出来 **0 次** ⇒ 10 分钟准时 🟡 黄灯、30 分钟 🔴 红灯、
 *   45 分钟就会**真去唤醒大脑（花钱）**。原因：旧判据只认**字段名形** `"tool_use": {...}`，
 *   而 codebuddy 把工具类型写在 `type` 的**值**里 —— `{"type":"tool_use","name":"Bash",...}`。
 *
 * 这批测试钉三件事：
 *   ① 两种形状都认（codebuddy 的值形 + pi 的字段名形）
 *   ② **只认"调用开始"那一类**：`tool_result` 不算 —— 否则一次调用数成 2 次（67→134），
 *      而且结果行没有 `name` 会退化用"前 80 字"当指纹 ⇒ 撞出一堆假循环
 *   ③ 旧判据**一个字不许动**（pi 那类载体靠它）
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Monitor, TOOL_EVENT_KEY, TOOL_EVENT_VALUE, isToolEvent, countToolEvents } from '../_unattended/_监控.mjs'

// ---- 真实结构切片（字段名与层级照抄 codebuddy / pi 的 out.json，只删了长正文）----
const CB_TOOL_USE = '{"type":"assistant","uuid":"u1","session_id":"s1","message":{"id":"m1","content":[{"type":"tool_use","id":"call_00_x","name":"Bash","input":{"command":"ls"}}],"stop_reason":"tool_use","type":"message","usage":{"input_tokens":198078,"output_tokens":431}},"parent_tool_use_id":null,"__timestamp":"2026-10-26T17:41:54.234Z"}'
const CB_TOOL_RESULT = '{"type":"user","uuid":"u2","message":{"content":[{"type":"tool_result","tool_use_id":"call_00_x","content":[{"type":"text","text":"ok"}]}],"role":"user"}}'
const CB_THINKING = '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"先看看目录","signature":""}],"type":"message"}}'
const PI_KEY_FORM = '{"tool_use":{"id":"t1","name":"read","input":{"path":"a.txt"}}}'
const PI_EXEC_START = '{"type":"tool_execution_start","toolCallId":"call_00_x","toolName":"edit","args":{}}'

test('值形（codebuddy）：`"type":"tool_use"` 必须算一次', () => {
  assert.equal(isToolEvent(CB_TOOL_USE), true)
  assert.equal(TOOL_EVENT_VALUE.test(CB_TOOL_USE), true)
})

test('字段名形（pi）：`"tool_use": {...}` 必须照旧算（旧判据不许被"统一"掉）', () => {
  assert.equal(isToolEvent(PI_KEY_FORM), true)
  assert.equal(TOOL_EVENT_KEY.test(PI_KEY_FORM), true)
})

test('`tool_execution_start` 的值形也算（换一家载体不必再改代码）', () => {
  assert.equal(isToolEvent(PI_EXEC_START), true)
})

test('`tool_result` **不算**：一次调用只许算 1 次（否则 67 会数成 134）', () => {
  assert.equal(isToolEvent(CB_TOOL_RESULT), false, '结果行不算，否则双计')
  assert.equal(TOOL_EVENT_VALUE.test(CB_TOOL_RESULT), false)
})

test('纯思考行、自由文字里的"工具"都不算（只认结构，不认字面）', () => {
  assert.equal(isToolEvent(CB_THINKING), false)
  assert.equal(isToolEvent('我要用工具了，tool_use 一下'), false)
  assert.equal(isToolEvent(''), false)
  assert.equal(isToolEvent(null), false)
  assert.equal(isToolEvent(undefined), false)
})

test('一次调用（start + result 两行）只计 1 次', () => {
  const text = [CB_TOOL_USE, CB_TOOL_RESULT].join('\n')
  assert.equal(countToolEvents(text), 1)
})

test('多种形状混在一份流里，各算各的、不互相吞', () => {
  const text = [CB_TOOL_USE, PI_KEY_FORM, CB_TOOL_RESULT, CB_THINKING, PI_EXEC_START].join('\n')
  assert.equal(countToolEvents(text), 3)   // CB_TOOL_USE + PI_KEY_FORM + PI_EXEC_START
})

// ---- 真样本核账（文件不在盘上就跳过：测试不依赖外部项目）----
const REAL = 'X:/xiangmu/beidanci/_crew/runs/2026-10-26T17-25-29/review/REVIEW-2026-10-26T17-25-29.out.json'
test('真样本：这次审核的工具事件数必须等于账本的 67', { skip: !existsSync(REAL) ? '真样本不在盘上' : false }, () => {
  const n = countToolEvents(readFileSync(REAL, 'utf8'))
  assert.equal(n, 67, `数出来 ${n}，账本记的是 67 —— 对不上就说明判据又漂了`)
})

// ---- 静态锁：接线没断 ----
test('`_scan` 用的是 isToolEvent（不是另写一份正则）', () => {
  const src = readFileSync(new URL('../_unattended/_监控.mjs', import.meta.url), 'utf8')
  assert.match(src, /if \(!isToolEvent\(line\)\) continue/)
  // 旧正则常量必须还在（pi 靠它）
  assert.match(src, /export const TOOL_EVENT_KEY = /)
  assert.match(src, /export const TOOL_EVENT_VALUE = /)
})

// ---- 端到端：Monitor 真的会把"值形"数进 events（不只是正则对了）----
test('Monitor._scan 对 codebuddy 形状能数出事件，并刷新"最后一次动"的时间', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mon-'))
  const out = join(dir, 'card.out.jsonl')
  writeFileSync(out, [CB_TOOL_USE, CB_THINKING, CB_TOOL_RESULT, PI_KEY_FORM].join('\n') + '\n', 'utf8')
  const mon = new Monitor({ project: dir, log: () => {} })
  mon.register({ cardId: 'CARD-1', task: 'T1', role: 'reviewer', outFile: out })
  const c0 = mon.cards.get('CARD-1')
  assert.equal(c0.events, 0)
  assert.equal(c0.lastToolAtMs, null)
  mon._scan(c0)
  assert.equal(c0.events, 2, 'CB_TOOL_USE + PI_KEY_FORM；tool_result 与 thinking 不算')
  assert.ok(c0.lastToolAtMs > 0, '数到事件就要刷新时间，否则灯永远不会变绿')
  // 再扫一次（没有新字节）不应重复计数
  mon._scan(c0)
  assert.equal(c0.events, 2)
})
