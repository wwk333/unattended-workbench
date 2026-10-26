/**
 * 越界台账 & 广播 —— 2026-10-21（用户口径："越界不是罪，是情报"）
 *
 * 用户的原始口径（照抄，别改写）：
 *   「默认是不允许越界的，但是不强制要求。因为越界了①也许是卡片问题，②也许是必须要越界才能完成任务，
 *     ③还有一种，就是确实是无理由越界了，但是是良性的、没有造成不良影响，而且越界次数较低 —— 这些都是可以理解的范围。
 *     重要的是，越界了别的 AI 是否知道他越界了、改了什么东西。」
 *
 * 所以本模块**不做判罚**（不拦、不扣分、不重派），只做两件事：
 *   ① **记账**：一行一条，落到 `<项目>\_crew\越界.jsonl`（追加，不覆盖）
 *   ② **广播**：把"谁、动了哪些文件、为什么"整理成一段人话，分别递给
 *      依赖卡 / 同批兄弟卡 / 审核员 / AUDIT（见 `briefFor` 的 mode）
 *
 * 分类三档（对应上面①②③）：
 *   · `card-gap`   卡欠账   —— 文件落在这张卡交付物所在目录里 ⇒ 是我们卡没写全，不怪执行者
 *   · `justified`  有理由   —— 明写理由（回执里的 `why:`）⇒ 属于"必须越界才能完成"
 *   · `unjustified` 无理由  —— 没写理由 ⇒ 才是要盯的；次数低仍可接受（台账里能数出次数）
 *
 * ⚠️ 纪律：本模块不读网络、不调模型、不改状态；纯函数 + 追加写一个 jsonl。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { shouldSkipFile, SKIP_DIRS } from './_排除清单.mjs'

/** 这条路径今天还会不会被算越界（工具缓存/编排自写文件等已在排除表里）。 */
export function excludedToday (rel) {
  const p = norm(rel)
  if (shouldSkipFile(p)) return true
  const segs = p.split('/').slice(0, -1)
  return segs.some(s => SKIP_DIRS.has(s))
}

/** 回执里"为什么动了白名单外的文件"的写法：`why:` / `why：` / `为什么:` 都认。 */
const WHY_RE = /^[ \t>*\-]*(?:why|Why|WHY|为什么|理由)[ \t]*[:：][ \t]*(.+)$/m

/** 从一段回执正文里抽第一句理由；没有返回 null（**不编**）。 */
export function extractWhy (text) {
  const s = String(text ?? '')
  const m = WHY_RE.exec(s)
  if (!m) return null
  const why = m[1].trim().replace(/\s+/g, ' ')
  if (!why || why.length < 3) return null
  return why.slice(0, 300)
}

/** 从信封（out.json）尾部抽理由：只读末尾一段，几十 MB 的档案也不整份读。 */
export function whyFromEnvelope (path, tailBytes = 400 * 1024) {
  try {
    const buf = readFileSync(path)
    const tail = buf.subarray(Math.max(0, buf.length - tailBytes)).toString('utf8')
    // 先试图只取"最后一条助手消息"，取不到就整段扫（载体格式五花八门，能抽到就抽）
    return extractWhy(tail)
  } catch { return null }
}

/**
 * 把一张卡的越界判成一档一档的记录。
 * @param {object} p
 * @param {string} p.task 卡号（T1-04）
 * @param {string} p.role 角色（coder-b）
 * @param {string[]} p.paths 越界文件（已剔除同批别人的产物）
 * @param {string[]} p.gapPaths 其中"卡欠账"的那部分（= outOfScopeKind.whitelistGap）
 * @param {string|null} p.why 回执里写的理由
 * @param {string} p.batch 批次戳
 * @param {'this-card'|'unknown'} [p.actor] **谁写的**（D11 第 1 条：有写入者才判）
 * @param {boolean} [p.sharedSnapshot] 这一组是**共用 before 快照**拍出来的（并行组）⇒ 归因天生不可靠
 * @param {object} [p.evidence] 证据（D11 第 4 条：每条越界挂一条可核对的事件，不再只有"路径 + 类型"）
 *
 * ★ 2026-10-23（施工文档 D11）：背景是 10 条越界里**只有 1 条是真的**：
 *   并行卡互相指认 4 条（共用快照）、监控者改的算到卡上 1 条、记账文件自触发 2 条、白名单缺项 3 条。
 *   根因：判定是"这个时间段里文件变了"，但**不知道是谁改的** —— 谁碰巧在跑就算谁的。
 *   ⇒ 现在**拿不到写入者就不指认**：`kind = 'unattributed'`（不计入"真越界"、不广播给下一张卡）。
 */
export function classifyRecords ({ task, role, paths, gapPaths = [], why = null, batch = '', actor = 'unknown', sharedSnapshot = false, evidence = null, claim = null, claimDetail = null }) {
  const gap = new Set((gapPaths ?? []).map(norm))
  const unattributed = actor !== 'this-card'
  return (paths ?? []).map(p => {
    const attrs = {
      at: new Date().toISOString(),
      batch: String(batch || ''),
      task: String(task || ''),
      role: String(role || ''),
      path: norm(p),
      // ★ D11 第 1 条：**有写入者才判**
      actor: unattributed ? 'unknown' : 'this-card',
      attribution: unattributed ? 'no-actor' : (sharedSnapshot ? 'shared-snapshot' : 'own-session'),
      // ★ D22：认领依据 —— `tool-call`（载体事件流里有写它那一次）／`trace`（留痕记录）／`none`（认不出）
      claim: String(claim ?? (unattributed ? 'none' : 'tool-call')),
      kind: gap.has(norm(p)) ? 'card-gap'
        : (unattributed ? 'unattributed'
          : (why ? 'justified' : 'unjustified')),
      why: gap.has(norm(p)) ? null : (why ?? null),
      // ★ D11 第 4 条：**记录必须带证据**
      evidence: evidence ? { ...evidence, path: norm(p) } : null
    }
    if (claimDetail && typeof claimDetail === 'object') {
      // claimDetail 可以是"单条"（直接挂上），也可以是 **路径 → 依据** 的映射（按路径取）
      const keyed = claimDetail[norm(p)]
      const one = (keyed && typeof keyed === 'object' && (keyed.claim || keyed.tool || keyed.actorHint)) ? keyed : null
      if (one) attrs.claimDetail = one
      else if (!Object.keys(claimDetail).length) attrs.claimDetail = null
    }
    return attrs
  })
}

export function norm (p) { return String(p ?? '').replace(/\\/g, '/').replace(/^\.\//, '').trim() }

export const KIND_ZH = { 'card-gap': '卡欠账', justified: '有理由', unjustified: '无理由' }

/** 追加进台账（一行一条 jsonl）；同 (batch,task,path) 去重，防同一轮重试重复写。 */
export function appendLedger (projectDir, records, { dedupe = true } = {}) {
  if (!records?.length) return { path: null, added: 0 }
  const p = join(projectDir, '_crew', '越界.jsonl')
  let seen = new Set()
  if (dedupe && existsSync(p)) {
    try {
      // ⚠️ 去 BOM：Windows 上用 PowerShell 手写这个文件会带 BOM，第一行 JSON.parse 会炸（实测）
      for (const line of readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
        if (!line.trim()) continue
        try { const j = JSON.parse(line); seen.add(`${j.batch}|${j.task}|${j.path}`) } catch {}
      }
    } catch {}
  }
  const fresh = records.filter(r => !seen.has(`${r.batch}|${r.task}|${r.path}`))
  if (!fresh.length) return { path: p, added: 0 }
  try {
    mkdirSync(dirname(p), { recursive: true })
    appendFileSync(p, fresh.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8')
    return { path: p, added: fresh.length }
  } catch { return { path: p, added: 0 } }
}

/** 读台账（可按批次/卡过滤；`last` 取最近 N 条）。 */
export function readLedger (projectDir, { batch = null, task = null, last = 0 } = {}) {
  const p = join(projectDir, '_crew', '越界.jsonl')
  if (!existsSync(p)) return []
  const out = []
  try {
    for (const line of readFileSync(p, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
      if (!line.trim()) continue
      let j; try { j = JSON.parse(line) } catch { continue }
      if (batch && j.batch !== batch) continue
      if (task && j.task !== task) continue
      out.push(j)
    }
  } catch { return [] }
  return last > 0 ? out.slice(-last) : out
}

/** 汇总数字（给 AUDIT 一行 / HANDOFF 一句话）。 */
export function summarize (records) {
  const s = { total: 0, gap: 0, justified: 0, unjustified: 0, unattributed: 0 }
  for (const r of records ?? []) {
    s.total++
    if (r.kind === 'card-gap') s.gap++
    else if (r.kind === 'justified') s.justified++
    else if (r.kind === 'unattributed') s.unattributed++   // ★ D11：拿不到写入者 ⇒ 不计入"无理由越界"
    else s.unjustified++
  }
  return s
}

/** 按"卡＋角色"分组（理由是一张卡写一条，不该在每个文件后面重复）。 */
function groupByTask (list) {
  const m = new Map()
  for (const r of list) {
    const k = `${r.task}|${r.role}`
    const g = m.get(k) ?? { task: r.task, role: r.role, whys: new Set(), items: [] }
    g.items.push(r)
    if (r.why) g.whys.add(r.why)
    m.set(k, g)
  }
  return [...m.values()]
}

function renderGroups (list, { maxItems = 8 } = {}) {
  return groupByTask(list).map(g => {
    const shown = g.items.slice(0, maxItems)
    const more = g.items.length > shown.length ? `\n    …还有 ${g.items.length - shown.length} 处` : ''
    const files = shown.map(r => `    - \`${r.path}\`${r.kind === 'card-gap' ? '（卡欠账：在交付物所在目录）' : ''}`).join('\n')
    const why = g.whys.size ? `\n    理由：${[...g.whys].join('；')}` : ''
    return `- **${g.task} / ${g.role}**：${g.items.length} 处${why}\n${files}${more}`
  }).join('\n')
}

/**
 * 生成给某个收件人的一段话。
 *   mode='deps'     依赖卡：同一张卡/依赖任务上轮越界过的文件，提醒别重犯
 *   mode='siblings' 同批兄弟：这一批里**别人**动了哪些白名单外的文件
 *   mode='review'   审核员：本轮越界总览，点名要重点核的
 */
export function briefFor (mode, records) {
  const list = (records ?? []).filter(r => r && r.path)
  if (!list.length) return ''
  // ★ D11：**不指认**的那些（actor 拿不到）不往"下一张卡"和"审核员点名单"里塞 ——
  //   10 条里 9 条是噪音的那一版，正是把它们当成了"这张卡干的"。
  const blamed = list.filter(r => r.kind !== 'unattributed')
  const s = summarize(list)
  if (mode === 'review') {
    const bad = blamed.filter(r => r.kind === 'unjustified')
    const head = `【越界台账（本轮 ${s.total} 处：卡欠账 ${s.gap} / 有理由 ${s.justified} / 无理由 ${s.unjustified}${s.unattributed ? ` / 查不到写入者 ${s.unattributed}（**不指认任何卡**）` : ''}）】`
    const body = renderGroups(list)
    const tail = bad.length
      ? `\n- ⚠️ **无理由越界 ${bad.length} 处**：重点核这几处有没有改坏别人的模块（明细见 \`_crew\\越界.jsonl\`）。`
      : '\n- 无理由越界 0 处。'
    return `\n${head}\n${body}${tail}\n`
  }
  if (!blamed.length) return ''
  if (mode === 'siblings') {
    return `\n【同一批里别人动过这些（白名单外）——你别去碰，也别重复干】\n${renderGroups(blamed, { maxItems: 6 })}\n`
  }
  return `\n【上轮/上游越界过这些文件（不是你这张卡的活）】\n${renderGroups(blamed)}\n- 它们**不在**你的白名单里 ⇒ 要动：**停下写回执问大脑**；不动也请在回执里说一句"回避了"。\n`
}

// ---------------------------------------------------------------- 回放（验收用）
//
// 用法：node _越界.mjs --replay "<项目>" [--limit 5]
// 做的事：把该项目最近 N 份 verdict.json 里的 outOfScope **重新按三档分类**（顺带从 out.json 抽 why），
//        打印一张对照表 + 汇总。用来证明"昨晚那 36 条能不能全被覆盖"。
if (process.argv[1] && /_越界\.mjs$/.test(process.argv[1]) && process.argv.includes('--replay')) {
  const i = process.argv.indexOf('--replay')
  const project = process.argv[i + 1]
  const lim = Number((process.argv.find(a => a.startsWith('--limit=')) ?? '').split('=')[1] || 5)
  const runs = join(project, '_crew', 'runs')
  const stamps = existsSync(runs) ? readdirSync(runs).filter(d => d !== '.').sort().slice(-lim) : []
  let all = []
  let today = []          // 按**今天**的排除表过滤后剩下的（= 现在真会报给人的）
  for (const st of stamps) {
    const vf = join(runs, st, 'verdict.json')
    if (!existsSync(vf)) continue
    let v; try { v = JSON.parse(readFileSync(vf, 'utf8')) } catch { continue }
    for (const r of v.results ?? []) {
      const paths = r.outOfScope ?? []
      if (!paths.length) continue
      const out = join(runs, st, 'tasks', `${r.task}.out.json`)
      const why = existsSync(out) ? whyFromEnvelope(out) : null
      const recs = classifyRecords({ task: r.task, role: r.role, paths, gapPaths: r.outOfScopeKind?.whitelistGap ?? [], why, batch: st })
      all = all.concat(recs)
      today = today.concat(recs.filter(x => !excludedToday(x.path)))
    }
  }
  const s = summarize(all)
  const st2 = summarize(today)
  console.log(`[回放] ${stamps.length} 轮 · 越界 ${s.total} 处 → 卡欠账 ${s.gap} / 有理由 ${s.justified} / 无理由 ${s.unjustified}`)
  console.log(`[回放] 按今天的排除表，只剩 ${st2.total} 处 → 卡欠账 ${st2.gap} / 有理由 ${st2.justified} / 无理由 ${st2.unjustified}`)
  if (s.total !== st2.total) {
    console.log(`[回放] 已排除 ${s.total - st2.total} 处（工具缓存/编排自写文件等）`)
  }
  const byKind = { 'card-gap': [], justified: [], unjustified: [] }
  for (const r of all) byKind[r.kind].push(r)
  for (const k of ['card-gap', 'justified', 'unjustified']) {
    console.log(`\n【${KIND_ZH[k]}】${byKind[k].length} 处`)
    for (const r of byKind[k].slice(0, 8)) console.log(`  ${r.task}  ${r.path}${r.why ? '　理由：' + r.why : ''}`)
    if (byKind[k].length > 8) console.log(`  …还有 ${byKind[k].length - 8} 处（明细在台账）`)
  }
  // 验收判据：每一处都要落进三档之一，且总数等于收据里的越界总数
  const raw = stamps.reduce((n, st) => {
    try { const v = JSON.parse(readFileSync(join(runs, st, 'verdict.json'), 'utf8')); return n + (v.results ?? []).reduce((m, r) => m + (r.outOfScope?.length ?? 0), 0) } catch { return n }
  }, 0)
  const ok = s.total === raw && s.total === s.gap + s.justified + s.unjustified
  console.log(`\n[回放] 收据原始条数 ${raw} ／ 分类后 ${s.total} ⇒ ${ok ? '✅ 全覆盖' : '❌ 有遗漏'}`)
  process.exit(ok ? 0 : 1)
}
