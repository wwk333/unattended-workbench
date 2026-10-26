// 解析器回归测试：四种真实输出各喂一次，看归一化结果对不对（这是防"假通过"的那道闸）
import { parseCarrierOutput } from './_agents-config.mjs'

const cases = [
  ['① DSH/Qoder 单信封（成功）', '{"type":"result","subtype":"completed","is_error":false,"result":"OK","usage":{"input_tokens":10}}', ''],
  ['② DSH/Qoder 单信封（没写 is_error 字段）', '{"type":"result","subtype":"completed","result":"OK"}', ''],
  ['③ Qoder 报错信封', '{"type":"result","subtype":"error","is_error":true,"result":"boom"}', ''],
  ['④ Pi JSONL（成功）', '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"OK"}],"usage":{"input":99}}}\n{"type":"agent_settled"}', ''],
  ['⑤ OpenCode 报错对象（额度）', '{"type":"error","error":{"type":"provider.quota","message":"exceeded the 5-hour usage quota","status":429}}', ''],
  ['⑥ OpenCode JSONL（文本在 text 事件里）', '{"type":"step_start"}\n{"type":"text","part":{"text":"OK"}}', ''],
  ['⑦ CodeBuddy JSON 数组（成功）', '[{"type":"message","role":"assistant","content":[{"type":"text","text":"OK"}]},{"type":"result","subtype":"success","is_error":false,"result":"DONE","usage":{"input_tokens":26971},"permission_denials":[]}]', ''],
  ['⑧ CodeBuddy 静默失败（stdout 空 + stderr 有 429）', '', '429 You have exceeded the 5-hour usage quota. It will reset at 04:49'],
  ['⑨ 全空', '', ''],
  // ★ 2026-10-03 新增（真跑撞出来的两个**假通过**盲区 + 用量累加口径）：
  //   ⑩ 多行 JSONL：失败只在末条 message_end 的 errorMessage 上，事件流里**没有** type:"error"
  ['⑩ Pi JSONL 失败（失败只在末条 message_end 的 errorMessage 上）',
    '{"type":"message_start"}\n{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"x"}],"stopReason":"error","errorMessage":"400 data: data_inspection_failed"}}\n{"type":"agent_settled"}', ''],
  //   ⑪ **单行** JSONL 会走"单信封"分支 —— 同一套判据必须在那边也生效（回归测试抓到的第二个盲区）
  ['⑪ Pi 单行 message_end 失败（单行走单信封分支，判据必须同样生效）',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"x"}],"stopReason":"error","errorMessage":"400 data: data_inspection_failed"}}', ''],
  //   ⑫ 用量**按 message_end 累加**；turn_end 带的是同一条 message → 双计就会变成 30/10
  ['⑫ Pi JSONL 用量累加（两步 + 一条重复的 turn_end，不该双计）',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"a"}],"stopReason":"toolUse","usage":{"input":10,"output":2,"cacheRead":100}}}\n'
    + '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"b"}],"stopReason":"stop","usage":{"input":5,"output":3,"cacheRead":200}}}\n'
    + '{"type":"turn_end","message":{"role":"assistant","content":[{"type":"text","text":"b"}],"stopReason":"stop","usage":{"input":5,"output":3,"cacheRead":200}}}',
    '', { input: 15, output: 5, cacheRead: 300 }],
  // ★ 2026-10-05 新增（**看板表3「消耗」把 coder-b 少报约 1500 倍** 的真 bug）：
  //   opencode 的用量来自 `step_finish.part.tokens`，原来写的是 `usage = {...usage, ...part.tokens}`
  //   —— **覆盖式**，每个 step 盖掉上一个 → 账本只记到**最后一步**（实测 T8：input 2061，真实 ~15 万）。
  //   而且它的形状是 `tokens.cache.read/write`（**嵌套**），账本字段是 `cacheReadInputTokens` → 也没接上。
  //   本用例钉死：**跨 step 累加 + 嵌套 cache 拍平**（两步合计 input 15 / output 5 / cacheRead 300 / cacheWrite 5 / reasoning 5）。
  ['⑬ OpenCode JSONL 用量累加（两步 step_finish + 嵌套 cache，不该只剩最后一步）',
    '{"type":"step_start"}\n'
    + '{"type":"step_finish","part":{"tokens":{"input":10,"output":2,"reasoning":1,"cache":{"read":100,"write":5}}}}\n'
    + '{"type":"text","part":{"text":"OK"}}\n'
    + '{"type":"step_finish","part":{"tokens":{"input":5,"output":3,"reasoning":4,"cache":{"read":200,"write":0}}}}',
    '', { input: 15, output: 5, cacheRead: 300, cacheWrite: 5, reasoning: 5 }],
  // ★ 2026-10-09 新增（rescue 换 Qwen Code）：`-o json` 输出 = **JSON 数组、末元素 type:"result"**（与 CodeBuddy 同族；★ S3 真跑已核：形状/字段全对）
  ['⑭ Qwen Code JSON 数组（成功，末元素 type:"result"）',
    '[{"type":"system","subtype":"init"},{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK"}]}},{"type":"result","subtype":"success","is_error":false,"result":"OK","usage":{"input_tokens":123,"output_tokens":4}}]', ''],
  // ★ 2026-10-09 新增（CodeWhale 备案）：真跑样本在 _probe\upgrade-check\codewhale-stream.jsonl
  ['⑮ CodeWhale JSONL（exec-stream 族：content/turn_usage/metadata/done）',
    '{"type":"content","content":"OK","schema_version":1,"schema":"codewhale.exec-stream"}\n'
    + '{"type":"turn_usage","turn":1,"input_tokens":13754,"output_tokens":2,"reasoning_tokens":0,"prompt_cache_hit_tokens":0,"prompt_cache_miss_tokens":13754,"duration_ms":42,"schema_version":1,"schema":"codewhale.exec-stream"}\n'
    + '{"type":"metadata","meta":{"receipt_kind":"terminal","provider":"volcengine","model":"deepseek-v4-pro","status":"completed","termination_reason":"resolved"},"schema_version":1,"schema":"codewhale.exec-stream"}\n'
    + '{"type":"done","schema_version":1,"schema":"codewhale.exec-stream"}',
    '', { input: 13754, output: 2 }],
  // ★ 五·S7（2026-10-09）新增 ⑯⑰⑱ —— 钉死"账本瞎的根"与 null/0 纪律（分篇 §5.4）：
  //   ⑯ 嵌套命中拍平（S5 解析器出口 ＋ S6 账本兜底两层都要能读到）
  ['⑯ 单信封·嵌套命中拍平（prompt_tokens_details.cached_tokens → cacheRead）',
    '{"type":"result","subtype":"completed","is_error":false,"result":"OK","usage":{"input_tokens":500,"prompt_tokens_details":{"cached_tokens":1234,"cache_creation_tokens":6}}}', '',
    { cacheRead: 1234, cacheWrite: 6 }],
  //   ⑰ 嵌套 0 ＝ 真没命中（必须记 0，不许被 null 顶掉）；缺的字段 ＝ null（不许编 0）
  ['⑰ 单信封·嵌套 0＝真没命中、缺字段＝null',
    '{"type":"result","subtype":"completed","is_error":false,"result":"OK","usage":{"input_tokens":500,"prompt_tokens_details":{"cached_tokens":0}}}', '',
    { cacheRead: 0, cacheWrite: null }],
  //   ⑱ 整个缓存字段缺席 ＝ null（"没这字段"，不是 0）
  ['⑱ 单信封·整段缓存字段缺席＝null',
    '{"type":"result","subtype":"completed","is_error":false,"result":"OK","usage":{"input_tokens":500}}', '',
    { cacheRead: null }],
  // ★ A（2026-10-10）新增 ⑲⑳㉑㉒㉓ —— 钉死「回合数」这条口径（它以前**没人验**，恒 null 也没人发现）：
  //   步数口径＝"模型被调了几次"；载体自报优先，没有就数事件；取不到＝**null**（不编 0）。
  ['⑲ 回合数·数组族（CodeBuddy/Qwen）：末元素带 num_turns',
    '[{"type":"message","role":"assistant","content":[{"type":"text","text":"OK"}]},{"type":"result","subtype":"success","is_error":false,"result":"DONE","num_turns":7,"usage":{"input_tokens":10}}]', '',
    null, 7],
  ['⑳ 回合数·单信封：num_turns',
    '{"type":"result","subtype":"completed","is_error":false,"result":"OK","num_turns":3,"usage":{"input_tokens":10}}', '',
    null, 3],
  ['㉑ 回合数·JSONL 载体没自报 ⇒ 数 assistant 的 message_end（两条＝2）',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"a"}],"stopReason":"toolUse","usage":{"input":1}}}\n'
    + '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"b"}],"stopReason":"stop","usage":{"input":1}}}', '',
    null, 2],
  ['㉒ 回合数·JSONL 载体自报 num_turns ⇒ 以它为准（不数事件）',
    '{"type":"message_end","message":{"role":"assistant","content":[{"type":"text","text":"a"}],"stopReason":"stop","usage":{"input":1}}}\n'
    + '{"type":"agent_settled","num_turns":9}', '',
    null, 9],
  ['㉓ 回合数·拿不到就是 null（不是 0）',
    '{"type":"result","subtype":"completed","is_error":false,"result":"OK","usage":{"input_tokens":10}}', '',
    null, null],
  //   ★ ㉔ 真信封抓出来的漏：OpenCode **不发 message_end**，只数 message_end 会得到 0。
  //     口径：OpenCode 的一步 ＝ 一个 `step_finish`（两步 ⇒ 2）。
  ['㉔ 回合数·OpenCode 族（不发 message_end，按 step_finish 数）',
    '{"type":"step_start"}\n'
    + '{"type":"step_finish","part":{"tokens":{"input":10,"output":1}}}\n'
    + '{"type":"text","part":{"text":"OK"}}\n'
    + '{"type":"step_finish","part":{"tokens":{"input":5,"output":1}}}', '',
    null, 2],
  // ★★ b71（2026-10-13）新增 ㉕–㉙ —— **Claude 式 `stream-json`**（CodeBuddy / Qwen Code 切过去之后的形状）。
  //   为什么必须有这几条：切格式前实测**现有解析器 `ok=true` 却正文 0 字、usage=null**（静默丢正文与 token 账）。
  //   真样本：`_probe\stream-json\{rescue,reviewer}.stream-json.jsonl`（下面按原样缩样）。
  //   ① 事件序列 `system/init → (stream_event) → assistant×N → result/success`
  ['㉕ Claude 式 stream-json·Qwen Code（成功；正文与用量都取得到）',
    '{"type":"system","subtype":"init","session_id":"a196059c-d7ed-465c-aa6f-88a301776ca6","model":"deepseek-v4.1-flash"}\n'
    + '{"type":"stream_event","event":{"type":"goal_state"}}\n'
    + '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK"}],"usage":{"input_tokens":20462,"output_tokens":2,"cache_read_input_tokens":2048}}}\n'
    + '{"type":"result","subtype":"success","session_id":"a196059c-d7ed-465c-aa6f-88a301776ca6","is_error":false,"num_turns":1,"result":"OK","usage":{"input_tokens":26401,"output_tokens":93,"cache_read_input_tokens":25472,"total_tokens":26494},"permission_denials":[]}', '',
    { input_tokens: 26401, output_tokens: 93, cacheRead: 25472 }, 1, 0, 'OK'],
  //   ② CodeBuddy：**思考块在先、正文在后** ⇒ 正文不许被思考顶掉（真样本里 content[0] 就是 thinking）
  ['㉖ Claude 式 stream-json·CodeBuddy（思考块在先，正文不能被它顶掉）',   // 允许模型名：下面那行是**解析器夹具样本**（真样本照抄，不是派活配置）
    '{"type":"system","subtype":"init","session_id":"01a135f1","model":"custom-local:kimi-k3"}\n'
    + '{"type":"system","subtype":"status"}\n'
    + '{"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"User asks to reply only OK"}]}}\n'
    + '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"OK"}],"usage":{"input_tokens":23559,"output_tokens":32,"cache_read_input_tokens":1280}}}\n'
    + '{"type":"result","subtype":"success","is_error":false,"result":"OK","num_turns":3,"total_cost_usd":0,"usage":{"input_tokens":23559,"output_tokens":45,"cache_creation_input_tokens":0,"cache_read_input_tokens":23552},"permission_denials":[]}', '',
    { input_tokens: 23559, output_tokens: 45, cacheRead: 23552, cacheWrite: 0 }, 3, 0, 'OK'],
  //   ③ 失败：`result` 行 `is_error:true` ⇒ 必须判失败，且**正文＝报错原文**（不许当成"做完了"）
  ['㉗ Claude 式 stream-json·失败（result 行 is_error=true）',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"partial"}]}}\n'
    + '{"type":"result","subtype":"error_during_execution","is_error":true,"result":"429 upstream unavailable","num_turns":2,"usage":{"input_tokens":10,"output_tokens":1},"permission_denials":[]}', '',
    null, 2, 0, '429 upstream unavailable'],
  //   ④ **不许双计**：assistant 上带 per-message usage、result 带全程累计 ⇒ 只认 result（100+150 就是错的）
  ['㉘ Claude 式 stream-json·用量不双计（assistant 逐条 + result 累计 ⇒ 只认 result）',
    '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"a"}],"usage":{"input_tokens":100,"output_tokens":5}}}\n'
    + '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"b"}],"usage":{"input_tokens":100,"output_tokens":5}}}\n'
    + '{"type":"result","subtype":"success","is_error":false,"result":"b","num_turns":2,"usage":{"input_tokens":150,"output_tokens":9}}', '',
    { input_tokens: 150, output_tokens: 9 }, 2],
  //   ⑤ `permission_denials` 必须带出去 —— JSONL 出口原来**恒为 `[]`**（"被拒条目一票否决"那条口径要用它）
  ['㉙ Claude 式 stream-json·permission_denials 要带出来（JSONL 出口原来恒为 空）',
    '{"type":"result","subtype":"success","is_error":false,"result":"OK","num_turns":1,"usage":{"input_tokens":10},"permission_denials":[{"tool_name":"Bash","tool_use_id":"t1"}]}', '',
    null, 1, 1],
  // ★★ 2026-10-14 新增 ㉚ —— **单行输出＝单个事件**（真跑逮到的真 bug，样本是 OpenCode 的真实输出）。
  //   旧行为：整段只有一个 JSON 对象 ⇒ 走"单信封"分支，而那一支只认 `result`/`message.content`/`session_id`
  //   ⇒ **正文取不到、会话号取不到，却仍返回 `ok:true`**（静默假通过）。
  //   后果正好打在「插话」上：插话指令短 ⇒ 载体常只回一行 ⇒ 账本收据没会话号 ⇒ **下次续不上**。
  ['㉚ 单行事件·OpenCode 的 `text` 事件（正文与 sessionID 都要取到；旧版恒为空/null）',
    '{"type":"text","timestamp":1791988566311,"sessionID":"ses_ec528971effeCc57da6SO98M2I","part":{"id":"prt_x","sessionID":"ses_ec528971effeCc57da6SO98M2I","messageID":"msg_x","type":"text","text":"紫色河马","time":{"start":1,"end":2}}}', '',
    undefined, undefined, undefined, '紫色河马'],
  //   同理：单行的 `step_finish`（OpenCode 的用量就在这一条里）⇒ 也要落到 JSONL 分支才取得到
  ['㉛ 单行事件·OpenCode 的 `step_finish`（用量要取到；旧版当信封 ⇒ 用量丢）',
    '{"type":"step_finish","timestamp":1,"sessionID":"ses_ec528971effeCc57da6SO98M2I","part":{"type":"step-finish","tokens":{"input":120,"output":8,"reasoning":3,"cache":{"read":40,"write":0}},"cost":0}}', '',
    { input: 120, output: 8, cacheRead: 40 }]
]

let bad = 0
for (const [name, out, err, expectUsage, expectTurns, expectDenials, expectText] of cases) {
  const r = parseCarrierOutput(out, err)
  const ok = r.isError === true ? '应失败' : '应成功'
  let mark = (r.isError === true) === (name.includes('报错') || name.includes('失败') || name.includes('全空')) ? '✅' : '❌'
  if (expectUsage) {
    const u = r.usage ?? {}
    // ★ 2026-10-05：改成"期望里写了哪几个字段就比哪几个"（原来只比 input/output/cacheRead，
    //   新增的 cacheWrite / reasoning 用例比不到）
    const same = Object.entries(expectUsage).every(([k, v]) => u[k] === v)
    if (!same) mark = '❌'
  }
  // ★ A：回合数用例 —— 显式写了就比（null 也是期望值："拿不到就不许编"）
  if (expectTurns !== undefined) {
    const got = r.numTurns ?? null
    if (got !== expectTurns) mark = '❌'
  }
  // ★ b71：被拒条目数（显式写了就比）—— "被拒条目一票否决"那条口径要有机器判据
  if (expectDenials !== undefined) {
    const got = Array.isArray(r.permissionDenials) ? r.permissionDenials.length : -1
    if (got !== expectDenials) mark = '❌'
  }
  // ★ b71：正文（显式写了就比）—— 切格式最容易出的错就是"正文被思考顶掉 / 只剩报错原文"
  if (expectText !== undefined && String(r.result ?? '') !== expectText) mark = '❌'
  if (mark === '❌') bad++
  console.log(`${mark} ${name}`)
  console.log(`     kind=${r.kind}  isError=${r.isError} (${typeof r.isError})  ${ok}  result=${JSON.stringify(r.result)}`)
  if (expectUsage) console.log(`     用量=${JSON.stringify(r.usage)}  期望 ${JSON.stringify(expectUsage)}`)
  if (expectTurns !== undefined) console.log(`     回合数=${JSON.stringify(r.numTurns ?? null)}  期望 ${JSON.stringify(expectTurns)}`)
  if (expectDenials !== undefined) console.log(`     被拒条目=${(r.permissionDenials || []).length}  期望 ${expectDenials}`)
  if (expectText !== undefined && String(r.result ?? '') !== expectText) console.log(`     正文=❌ ${JSON.stringify(String(r.result ?? '').slice(0, 120))}  期望 ${JSON.stringify(expectText.slice(0, 120))}`)
  if (r.error) console.log(`     error=${String(r.error).slice(0, 90)}`)
  if (r.permissionDenials.length) console.log(`     denials=${r.permissionDenials.length}`)
}
console.log(bad === 0 ? '\n✅ 解析器回归测试全部符合预期' : `\n❌ 有 ${bad} 条不符合预期 —— 必须修`)

// ★★ 2026-10-06 装牙（三方交叉验证共同指出的"死保护"）：
//   本文件原来**一处 process.exit 都没有** —— 不管挂几条，退出码恒为 0。
//   而 `起飞前检查.mjs` 第 ② 项正是靠退出码判它过不过（"防假通过的那道闸"）⇒ **那道闸永远通过**。
//   现在：有不过就 exit 1（能被总闸拦住），全过 exit 0。
//   ⚠️ 和它同族的坑：其它自检（`_一致性复验` / `_定编对账` / `账目对账`）本来就有退出码契约，
//      别再让任何**检查器**退回"只打印不表态"的写法 —— 那种闸等于没装。
process.exit(bad === 0 ? 0 : 1)