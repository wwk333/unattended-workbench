/**
 * **审核一次制**（2026-10-27 施工文档「审核一次制 · 砍审核重复」）
 *
 * 用户的硬指标：**全量审核（含端到端 / 试玩）在整个项目周期只做 1 次。**
 * 这里只放**纯函数**（I/O 全部留在 `编排.mjs`），三个职责：
 *
 *   ① `countBy` / `openRows` / `isSettled` —— "项目做完了没有"的**唯一判据**
 *   ② `reviewPlan` / `isUsed`        —— 这一次审核该不该拉、是不是已经用掉了
 *   ③ `planAnchors`                  —— 机器块里的 `gateStamp` / `snapshotId` 由**编排**给
 *
 * 为什么 ① 要单独抽出来：
 *   原来 `statusRows()` 里判 settled 用的是 `['pending','doing']` —— **漏了 `ready`**。
 *   `ready` 是"已排好队、还没开工"，漏掉它 ⇒ "项目还有活没干"被判成"做完了" ⇒
 *   拿半成品去触发终审。改成全项目判据后这个洞会变得很危险，所以单独用测试钉住。
 *
 * 为什么 ③ 要机器给锚点：
 *   抄错一个字符 ⇒ 交付门判 `review:snapshot-mismatch` / `unknown` ⇒ 不放行 ⇒ 只能再审一次
 *   ⇒ **自己制造重审**。而这两个值编排手上就有（它刚跑完门禁）。
 *   口径：`decision` / `why` 是**判断**，归模型；`gateStamp` / `snapshotId` 是**事实**，归机器。
 */

/** 这些状态都算"项目还没干完" */
export const OPEN_STATUSES = Object.freeze(['pending', 'ready', 'doing'])
export const OPEN_ZH = Object.freeze({ pending: '待做', ready: '待开工', doing: '在做' })

/**
 * 台账行的标记 → 状态（`台账.mjs` 文件头那张表的**唯一副本**）。
 * 空格=pending  r=ready  >=doing  ?=review  x=done  !=blocked  -=dropped
 */
export const LEDGER_MARKERS = Object.freeze({
  ' ': 'pending', r: 'ready', '>': 'doing', '?': 'review', x: 'done', '!': 'blocked', '-': 'dropped'
})

/**
 * 解析 `台账.mjs list` 的**人读输出**（`   [x] T1  W1  coder-a  done  目标`）。
 *
 * ★ 2026-10-27 真跑当场抓到的 bug（**不是本次改动引入的**）：
 *   标记的字符类里**漏了 `r`**（原来写的是 `[ x>?x!\-]`）⇒ **所有 `[r]`（ready）行被整行丢弃** ⇒
 *   带 ready 卡的项目被判成"做完了" ⇒ 在**没做完**的项目上触发项目周期**唯一的那一次**终审，
 *   审完还写 `fullReviewDone:true`，于是这个项目**再也审不了**了。
 *   最坏的地方是它**完全静默**：不抛错、不告警，只是 `rows` 少几行。
 *   探针实测：7 个标记里 6 个认、唯独 `[r]` 整行丢弃。
 *
 * 为什么搬到这里：解析正则只有被单测**按七个标记逐个过一遍**钉住，
 * 才不会哪天又少一个字母（而少一个字母的代价是"在没做完的项目上把唯一一次审核烧掉"）。
 *
 * @param {string} text `台账.mjs list` 的标准输出
 * @returns {Array<{id:string,wave:string,role:string,status:string,goal:string}>}
 */
export function parseLedgerRows (text) {
  const re = /^\s*\[([ xr>?!-])\]\s+(\S+)\s+(\S+)\s+(\S+)\s+(\w+)\s*(.*)$/
  return String(text ?? '').split(/\r?\n/)
    .map(l => l.match(re))
    .filter(Boolean)
    .map(m => ({ id: m[2], wave: m[3], role: m[4], status: m[5], goal: (m[6] ?? '').trim() }))
}

/** 按状态计数（不认识的 status 只计入 total，不瞎归类） */
export function countBy (rows) {
  const c = { total: 0, pending: 0, ready: 0, doing: 0, review: 0, done: 0, blocked: 0, dropped: 0 }
  for (const r of Array.isArray(rows) ? rows : []) {
    const s = String(r?.status ?? '')
    if (Object.prototype.hasOwnProperty.call(c, s)) c[s] += 1
    c.total += 1
  }
  return c
}

/** 还没干完的卡（pending / ready / doing） */
export function openRows (rows) {
  return (Array.isArray(rows) ? rows : []).filter(r => OPEN_STATUSES.includes(String(r?.status ?? '')))
}

/** 项目做完了没有：**有卡**且**没有 pending/ready/doing** */
export function isSettled (rows) {
  const list = Array.isArray(rows) ? rows : []
  if (!list.length) return false            // 一张卡都没有 ≠ 做完了（不能拿空项目去审）
  return openRows(list).length === 0
}

/**
 * 这一次是不是已经用掉了（项目级，绝不按波复位）。
 *
 * ★ 读时兼容（**不改老文件**）：2026-10-27 之前写的 stamp 只有 `reviewId` / `verdict` / `rounds`，
 *   没有 `fullReviewDone`。有 `reviewId` 且 `verdict` 不是分级跳过 ⇒ 认定"确实审过"。
 *   不这么认，就会给老项目**凭空多审一次**（beidanci 那种单次 18 分钟），正是这次要消灭的浪费。
 *   反过来也不能只看 `verdict`：`level-skip-review` 是"没审"，不能被当成"审过"。
 * @param {object|null} stamp `_crew/review-stamp.json` 的内容
 */
export function isUsed (stamp) {
  if (!stamp || typeof stamp !== 'object') return false
  if (stamp.fullReviewDone === true) return true
  if (stamp.fullReviewDone === false) return false     // 新 schema 明确写了"没审过"
  const v = String(stamp.verdict ?? '')
  if (!v || v === 'level-skip-review') return false
  return Boolean(stamp.reviewId)
}

/**
 * 这一次审核该不该拉。
 * @returns {{act:'not-ready'|'used'|'review', reason:string, detail:object}}
 */
export function reviewPlan ({ rows, stamp = null, force = false } = {}) {
  const c = countBy(rows)
  const open = openRows(rows)
  const detail = { ...c, open: open.length, openIds: open.slice(0, 8).map(r => String(r?.id ?? '?')) }

  if (!c.total) return { act: 'not-ready', reason: '项目里一张卡都没有（不能拿空项目去审）', detail }
  if (open.length) {
    const parts = OPEN_STATUSES
      .filter(s => c[s] > 0)
      .map(s => `${OPEN_ZH[s]} ${c[s]}`)
    return { act: 'not-ready', reason: `项目还没做完（还有 ${parts.join(' / ')}）`, detail }
  }
  if (c.review + c.done === 0) return { act: 'not-ready', reason: '没有可审的卡（done 与 review 都是 0）', detail }
  if (isUsed(stamp) && !force) return { act: 'used', reason: '项目周期审核已用（1/1）', detail }
  return {
    act: 'review',
    reason: isUsed(stamp) ? '显式复审（覆盖 1/1 上限）' : '项目周期首审（1/1）',
    detail
  }
}

/**
 * 机器块锚点：算最终 `decision`，并决定要不要把锚点**改写成机器真值**。
 *
 * 铁律（宁可判 unknown，也不伪造）：
 *   ① 机器块不合法（缺 decision / JSON 坏 / 压根没有块）⇒ `unknown`，**不补 decision**
 *   ② 机器锚点缺失 ⇒ `unknown`，**不得放行**（证明不了"审的是哪份代码"）
 *   ③ 锚点不一致（含模型留空）⇒ 用机器的覆写；`decision` / `why` 仍归模型
 *
 * @param {object} o
 * @param {object|null} o.block      `parseReviewDecision(text, { anchorsOptional: true })` 的结果
 * @param {string|null} o.gateStamp  编排刚跑那次门禁的 `stamp`
 * @param {string|null} o.snapshotId 同上：门禁结果的 `snapshot.snapshotId`
 * @param {string|null} [o.reviewId]
 * @returns {{decision:string, needRewrite:boolean, block:object|null, why:string|null, source:string}}
 */
export function planAnchors ({ block, gateStamp, snapshotId, reviewId = null } = {}) {
  const b = block && typeof block === 'object' ? block : null
  if (!b || b.ok !== true) {
    return {
      decision: 'unknown', needRewrite: false, block: null, source: 'none',
      why: String(b?.why ?? '审核报告里没有可用的 REVIEW-DECISION 机器块（decision/why 是判断，必须由模型给）')
    }
  }
  if (!gateStamp || !snapshotId) {
    return {
      decision: 'unknown', needRewrite: false, block: null, source: 'none',
      why: '编排没拿到门禁锚点（gateStamp / snapshotId）⇒ 本轮结论不得放行'
    }
  }
  const same = b.gateStamp === gateStamp && b.snapshotId === snapshotId
  if (same) {
    return { decision: String(b.decision), needRewrite: false, block: null, why: b.why ?? null, source: 'machine-same' }
  }
  return {
    decision: String(b.decision),
    needRewrite: true,
    block: {
      decision: String(b.decision),
      gateStamp,
      snapshotId,
      blockers: Array.isArray(b.blockers) ? b.blockers.map(String) : [],
      reviewId: b.reviewId ?? reviewId ?? null
    },
    why: b.why ?? null,
    source: 'machine-override'
  }
}

/**
 * 审核员的**口径违规**判定（卡上规矩"长牙"的那一颗牙）。
 *
 * ★ 2026-10-27 从 `编排.mjs` 的 `judge()` 里搬出来 —— 搬的理由只有一个：**它测得了**。
 *   这段规矩的价值全在"会不会真的响"；留在 2000 行的 `judge()` 里就只能靠人读代码，
 *   而它恰恰是"文案说禁止、代码没拦"的高发区（`门禁.mjs` 那条就是这么漏掉的）。
 *
 * 口径（**宁可漏判、不可误判**）：
 *   ① `npm test` / `npm run test` ⇒ `review-overreach`（全量该由门禁跑）
 *   ② `门禁.mjs` ⇒ `review-rerun-gate`（★ 2026-10-27 新增：原来只认 ①，而卡上给的命令正是它）
 *   ③ 没引用 `gate-result.json` ⇒ `review-unverified`
 *   ④ 工具调用 > 25 ⇒ `review-over-budget`（软，只提示）
 *   ⚠️ 违规 ≠ 调用失败：**不改判决**（否则会触发额度切换、白烧另一个网关）。
 *
 * 否定词护栏：回执里写"我**没有**跑门禁.mjs"不算违规 —— 它是在引用卡上的禁令。
 *
 * @param {{body?:string, toolCalls?:number}} o `body` = 回执正文（`env.result`）
 * @returns {{policy:string|null, action:string}}
 */
export function reviewPolicyOf ({ body = '', toolCalls = 0 } = {}) {
  const text = String(body ?? '')
  // 否定词：出现"不要/没跑/未跑…"且紧跟着那条命令 ⇒ 认为它在引用禁令，不算违规
  const NEG = '(不要|不许|别跑|禁止|没跑|未跑|不跑|没有跑)'
  const npmTest = /\bnpm\s+(run\s+)?test\b/.test(text) &&
    !new RegExp(`${NEG}[^\\n]{0,14}npm\\s+(run\\s+)?test`).test(text)
  // ⚠️ 不要写 `\b门禁\.mjs\b` —— **中文不是正则的"单词字符"**，`\b` 在中文字符与 `/` 之间不成立，
  //    那条正则**永远匹配不上**（真跑前被本条的行为测试当场抓出来）。文件名就用裸串。
  const rerunGate = /门禁\.mjs/.test(text) &&
    !new RegExp(`${NEG}[^\\n]{0,14}门禁\\.mjs`).test(text)
  const citesGate = /gate-result\.json/.test(text)
  const tc = Number(toolCalls ?? 0)

  if (npmTest) {
    return { policy: 'review-overreach', action: '收活（⚠️ **审核口径违规**：回执里出现 `npm test` 全量命令）—— 全量该由门禁（零 token）跑，你不重跑；下轮按「判读门禁结果 + 只复跑红的那条」' }
  }
  if (rerunGate) {
    return { policy: 'review-rerun-gate', action: '收活（⚠️ **审核口径违规**：回执里出现 `门禁.mjs` —— 门禁由编排跑，你不要重跑）—— 直接读 `_crew\\gate\\gate-result.json` 的摘要；只有你真改了代码，才复跑**红的那一条**' }
  }
  if (!citesGate) {
    return { policy: 'review-unverified', action: '收活（⚠️ **审核未验**：回执没引用门禁结果文件 `_crew\\gate\\gate-result.json`）—— 引用路径 + 摘要数字即可，不必自己复现一遍' }
  }
  return {
    policy: tc > 25 ? 'review-over-budget' : null,
    action: tc > 25 ? `收活（⚠️ 本次工具调用 ${tc} 次 > 25：注意回合数与重复读 —— 实测这是最贵的一项）` : '收活'
  }
}
