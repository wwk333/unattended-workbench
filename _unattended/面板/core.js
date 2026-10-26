/**
 * 班组看板 · **共享逻辑核心**（★ 批 1 建立；C 解耦后**它就是唯一的源**）
 *
 * ## 为什么有这个文件
 *
 * 「管理页搬家」（总表 §十 / B 案）要新面板与旧看板**显示同一套口径**。
 * 如果两边各写一份格式化逻辑，早晚会漂（这正是本项目踩过的坑类）。
 * 所以把**纯逻辑**（不碰 DOM、不碰 React）集中到这里，**一个源**：
 *
 *   · **本文件 ＝ 源**。`面板\service.mjs` **直接读本文件**（下面 `CORE-BEGIN:`/`CORE-END:` 之间那段），
 *     拼进页面给浏览器用（`/core.js`）。**面板不再依赖 `sidebar-plugin\`**（C 解耦，2026-10-10）。
 *   · 旧看板（`sidebar-plugin\lib\client.js`，**已停用并归档**）里内联的那一段，
 *     由 `_probe\panel-b1\_patch-core2.mjs` 从**本文件标记区**生成 —— 两边逐字节一致（脚本自带自校）。
 *   · 这两段**必须逐字节一致**：`面板\service.mjs` 启动时自校，不一致就**拒绝启动**
 *     （宁可不开，也不许两边显示不同的口径）。
 *
 * ⚠️ **改这一份就够了**。改完请跑：
 *    `node _probe\panel-b1\_verify-client.mjs` · `node _probe\panel-b1\_verify-page.mjs`（面板页面）
 *    · `node _unattended\换家后验证.mjs`
 *
 * ## 形态为什么是经典脚本（不是 ESM）
 *
 * 实测（`asar` 内 `dsh-client-modules/lib/client.js` L451）：
 * 宿主加载 client bundle 用的是 **"same-origin external classic script"**
 * （`document.createElement("script")` + `src`），**不是** `type="module"`。
 * 所以插件侧的共享代码**只能**是经典脚本 + 全局命名空间，不能用 `import`。
 *
 * ## 纪律
 *
 * · **纯函数**：不改文件、不发请求、无副作用（可零成本单测）。
 * · 文案/口径**改这里就两边一起变**；谁在别处另写一份，就是新的漂移源。
 */
// ══ CORE-BEGIN:
;(function () {
  'use strict'

  /** 表格里「这一列没有数」的占位（用户口径：缺失一律 `—`，绝不编数字）。 */
  const DASH = '—'

  /** 秒数 → 「N 秒前 / N 分钟前 / N 小时前」。
   *  ★ b201：**秒数只保留一位小数** —— 原来直接拼原始浮点，实测顶栏出现过
   *    「41.98899999999995 秒前」（`(now - t)/1000` 的浮点误差）。一分钟内都按一位小数显示。 */
  function agoText (sec) {
    if (sec == null || isNaN(sec)) return '?'
    if (sec < 0) sec = 0
    if (sec < 60) {
      const v = Math.round(Number(sec) * 10) / 10
      if (v < 60) return v.toFixed(1) + ' 秒前'      // 59.99 四舍五入到 60 ⇒ 落到下一档，不显示"60.0 秒前"
    }
    if (sec < 3600) {
      const m = Math.round(sec / 60)
      if (m < 60) return m + ' 分钟前'                // 3599 ⇒ 60 分钟 ⇒ 落到下一档，不显示"60 分钟前"
    }
    return Math.round(sec / 3600) + ' 小时前'
  }

  /** ISO 时间 → 本地可读时间。 */
  function dateText (iso) {
    try { return iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—' } catch (e) { return '—' }
  }

  /** ISO 时间 → 距今秒数（拿不到就 null）。 */
  function secAgoOf (iso) {
    if (!iso) return null
    const t = new Date(iso).getTime()
    return isNaN(t) ? null : Math.round((Date.now() - t) / 1000)
  }

  /** 空值统一成可渲染文本。 */
  function txt (v) {
    return v == null || v === '' ? '?' : String(v)
  }

  /** 剩余额度百分比 → 配色档（越高越安全）。 */
  function quotaTone (remaining) {
    const n = Number(remaining)
    if (!isFinite(n)) return 'n'
    return n >= 50 ? 'g' : n >= 20 ? 'o' : 'r'
  }

  /** 角色状态 → 配色档 + 中文。
   *  `unassigned` = **未派活**（该角色在本项目里一次都没上过；次数是确定的 0，不是"拿不到"）
   *  —— 刻意**不写**「停着」（那意味着"跑过、现在停了"，会被误读），也**不写** `—`
   *  （`—` 只留给"数据拿不到"）。未知（null）才落到 `—`+不点灯，那只是兜底分支。 */
  const STATE_TONE = { running: 'g', error: 'r', idle: 'n', stopped: 'n', unassigned: 'n' }
  const STATE_ZH = { running: '干着', error: '报错', idle: '停着', stopped: '未运行', unassigned: '未派活' }

  /** 消耗那一格（取自数据端 `consumption[]`，按职位名索引；查不到就给 `—` 并写明原因）。 */
  function consCellFor (c, consMap) {
    const row = (consMap || {})[(c && c.role) || '']
    if (!row) {
      return { text: DASH, tone: 'n', title: '本项目内该职位没有消耗记录（不是坏了）—— 口径：本项目 token 用量优先，其次调用次数；额度是厂商级 → 看表1' }
    }
    return {
      text: txt(row.displayText),
      tone: row.metric === 'none' ? 'n' : null,
      title: txt(row.metricLabel) + ' · ' + txt(row.detail)
    }
  }

  /**
   * 「职位表」一行的数据（不含任何渲染概念）：职位 / agent / 模型 / 状态 / 消耗。
   * 渲染层负责把它画成 `<td>`；**口径与拆分规则都在这里**，两边不许各写一遍。
   * 返回 5 格，每格 = `{ text, tone?, dot?, title? }`（`dot` = 状态列前面那个小圆点）。
   */
  function crewCells (c, consMap) {
    c = c || {}
    const tone = STATE_TONE[c.state] || 'n'
    const tips = [
      c.modelSource ? '模型来源：' + c.modelSource : null,
      c.modelNote ? c.modelNote : null,
      c.effortSource && c.modelSource !== c.effortSource ? '档位来源：' + c.effortSource : null,
      c.lastAttemptAt ? '最近派活 ' + dateText(c.lastAttemptAt) : null,
      c.countNote ? c.countNote : null,
      c.callsSource && c.callsSource.indexOf('—') !== 0 ? c.callsSource : null
    ].filter(Boolean).join(' · ')
    return [
      { text: txt(c.role), title: c.stateReason || undefined },
      { text: txt(c.agent) },
      { text: c.modelText ? String(c.modelText) : DASH, title: tips || undefined },
      c.state
        ? { text: txt(c.roundsText), tone: tone, dot: tone, title: c.stateReason || undefined }
        : { text: DASH, tone: 'n', title: c.stateReason || undefined },
      // ★ 2026-10-05 合并（用户："看板重复内容太多"）：**消耗并入本表最后一列**
      consCellFor(c, consMap)
    ]
  }

  /**
   * 「表1 模型商」一行的数据：模型商 / 钥匙 / 额度 / 调用次数 / token 用量。
   * 三列**各自独立判断有无**：有数据就显示，没有的留 `—`（用户 2026-10-03 定稿口径）。
   */
  function providerCells (p) {
    p = p || {}
    const detail = p.detail || undefined
    const kv = p.quotaVerdict
    return [
      // ★ 2026-10-12（用户口径）：被「删」的家**只剩历史用量** —— 账不删，但要说清它已经不用了，
      //   否则一行"1499 次调用"看着像还在跑。
      { text: txt(p.name) + (p.deleted ? '（已删 · 只剩历史用量）' : (p.declaredOnly ? '（还没用过）' : '')), title: detail },
      { text: p.quotaKeysText ? String(p.quotaKeysText) : DASH, tone: kv === 'ok' ? 'g' : (kv ? 'r' : 'n'), title: detail },
      p.quotaText
        ? { text: String(p.quotaText), tone: quotaTone(p.quota && p.quota.remainingPercent), title: detail }
        : { text: DASH, tone: 'n', title: detail },
      p.callsText ? { text: String(p.callsText), title: detail } : { text: DASH, tone: 'n', title: detail },
      p.tokensText ? { text: String(p.tokensText), title: detail } : { text: DASH, tone: 'n', title: detail }
    ]
  }

  /** 路径归一（`\`→`/`、去尾斜杠、小写）——项目匹配用。 */
  function normPath (p) { return String(p == null ? '' : p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase() }

  /** 在 `crewByProject[]` 里按路径找项目：先**完全相同**，否则**最长前缀**（工作区在项目目录里也算）。 */
  function matchProject (want, list) {
    if (!want) return null
    const w = normPath(want)
    if (!w) return null
    let exact = null
    let prefix = null
    for (let i = 0; i < (list || []).length; i++) {
      const p = list[i]
      const np = normPath(p.path)
      if (!np) continue
      if (np === w) { exact = p; break }
      if (w.indexOf(np + '/') === 0 && (!prefix || np.length > normPath(prefix.path).length)) prefix = p
    }
    return exact || prefix
  }

  /** 把 `crewByProject[].consumption[]` 按职位名建索引（职位表最后一列用）。 */
  function consumptionIndex (target) {
    const out = {}
    ;((target && target.consumption) || []).forEach(function (r) { if (r && r.role) out[r.role] = r })
    return out
  }

  /**
   * 模型搜索的**粗匹配**打分（★ 2026-10-07 用户要求：模型一多就没法选）。
   *   不区分大小写 · 可只写片段 · 可略掉 `/ - . _ :` 与空格 · 词序随意 · 允许"跳字母"但全程最多跳 2 个
   *   （不加这个限制会乱命中：`mimo` 命中 `Tongyi-MAI/Z-Image-Turbo`）。
   * 返回 3（连续命中）/ 3（多词全中）/ 2（松散命中）/ 1（空查询）/ 0（不命中）。
   */
  function modelScore (model, q) {
    const norm = function (x) { return String(x).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '') }
    const hay = norm(model)
    const t = norm(q)
    if (!t) return 1
    if (hay.indexOf(t) !== -1) return 3
    const toks = String(q).toLowerCase().split(/[\s/\-_.:,]+/).map(norm).filter(Boolean)
    if (toks.length > 1 && toks.every(function (x) { return hay.indexOf(x) !== -1 })) return 3
    let i = 0
    let gaps = 0
    let last = -1
    for (let k = 0; k < hay.length && i < t.length; k++) {
      if (hay[k] !== t[i]) continue
      if (last >= 0 && k - last > 1) gaps += (k - last - 1)
      last = k; i++
    }
    return (i === t.length && gaps <= 2) ? 2 : 0
  }

  globalThis.__DSH_BOARD_CORE = {
    DASH,
    agoText,
    dateText,
    secAgoOf,
    txt,
    quotaTone,
    STATE_TONE,
    STATE_ZH,
    crewCells,
    consCellFor,
    providerCells,
    normPath,
    matchProject,
    consumptionIndex,
    modelScore
  }
})()
// ══ CORE-END:
