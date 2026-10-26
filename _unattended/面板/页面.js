/**
 * 新面板 · **页面脚本**（批 1「管理页搬家」＋ 2026-10-10「看板页」壳）
 *
 * 它搬的是现看板（`sidebar-plugin\lib\client.js`）的管理功能，**口径与旧看板一致**：
 * 格式化/口径全部走 `/core.js`（= `client.js` 标记区里那一段，服务端启动时逐字节自校过）。
 *
 * 与旧看板的**唯一差别**（有意为之，批 1 记录在案）：
 *   · 旧看板跟着"当前会话工作区"（`props.sessionId` → `useSessions.cwd`）；
 *     面板是独立页（没有会话上下文）⇒ 跟 `_crew\当前项目.txt` 那个钉子 / `?project=` 查询串。
 *   · 旧看板用 React；本页用原生 DOM（面板要独立于 DSH，不引框架 —— 引一个框架就多一个漂移源）。
 *   · 「⚙️ API 额度」区的**模型搜索打分**复用 core 的 `modelScore`（旧看板里那份是局部实现，
 *     语义相同、未搬动 —— 逐项核对见 `面板\README.md`）。
 */
/* global __DSH_BOARD_CORE */
(function () {
  'use strict'
  var C = window.__DSH_BOARD_CORE
  var DATA_URL = '/board-data.json'
  var REFRESH_MS = 60000
  var TICK_MS = 10000

  /* ── 小工具：原生 DOM 构造 ───────────────────────────────────────────── */
  function h (tag, attrs, kids) {
    var el = document.createElement(tag)
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k]
        if (v == null || v === false) continue
        if (k === 'class') el.className = String(v)
        else if (k === 'text') el.textContent = String(v)
        else if (k === 'html') el.innerHTML = String(v)
        else if (k === 'style' && typeof v === 'object') { for (var s in v) el.style[s] = v[s] }
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
        else if (v === true) el.setAttribute(k, '')
        else el.setAttribute(k, String(v))
      }
    }
    append(el, kids)
    // ★★ 2026-10-12 修（真浏览器核对当场逮住）——**`<select>` 的"当前选中"必须用属性（property）设，
    //   不能靠 `setAttribute('value', …)`**：`value` 这个 attribute 对 `<select>` **没有选择语义**，
    //   而上面那段又是在**子节点（`<option>`）还没挂上之前**设的 ⇒ 真实浏览器里
    //   **下拉永远显示第一个选项**（＝界面在**谎报现用模型**；这正是用户报的"选不了/选了没用"观感的来源之一）。
    //   ⚠️ 桩 DOM 抓不到它（桩里 `value` 是反射属性）—— 所以这条是**真浏览器**逮住的，见日志。
    if (el.tagName === 'SELECT' && attrs && attrs.value != null) el.value = String(attrs.value)
    return el
  }
  function append (el, kids) {
    if (kids == null || kids === false) return
    if (Array.isArray(kids)) { kids.forEach(function (k) { append(el, k) }); return }
    el.appendChild(typeof kids === 'object' && kids.nodeType ? kids : document.createTextNode(String(kids)))
  }
  function clear (el) { while (el.firstChild) el.removeChild(el.firstChild) }

  /** 一格（core 给的是 `{ text, tone, dot, title }`）→ `<td>`。 */
  function cell (spec) {
    var s = (spec && typeof spec === 'object') ? spec : { text: spec }
    var td = h('td', { class: s.tone ? s.tone : null, title: s.title || null })
    if (s.dot) td.appendChild(h('span', { class: 'dot ' + s.dot }))
    td.appendChild(document.createTextNode(s.node != null ? s.node : String(s.text == null ? '' : s.text)))
    return td
  }
  /** `{ group: { text, title } }` → 跨列的组标题行。 */
  function groupRow (g, cols) {
    var tr = h('tr', { class: 'grp' })
    tr.appendChild(h('td', { colspan: String(cols), title: g.title || null, text: g.text }))
    return tr
  }
  /** 一张表（与旧看板同形：`head` 表头、`rows` 里是格子数组或组标题行，`numFrom` 起右对齐）。 */
  function table (head, rows, numFrom) {
    var nf = numFrom == null ? 1 : numFrom
    var thead = h('thead', null, h('tr', null, head.map(function (t, i) {
      return h('th', { class: i >= nf ? 'num' : null, text: t })
    })))
    var tbody = h('tbody', null, rows.map(function (row) {
      if (row && row.group) return groupRow(row.group, head.length)
      return h('tr', null, row.map(function (c, i) {
        var td = cell(c)
        if (i >= nf) td.classList.add('num')
        else if (i === 0) td.classList.add('who')
        return td
      }))
    }))
    return h('table', { class: 'tbl' }, [thead, tbody])
  }
  function card (title, kids, note) {
    return h('section', { class: 'card' }, [title ? h('h3', { text: title }) : null, note ? h('div', { class: 'dim tiny', text: note }) : null].concat(kids || []))
  }

  /* ── 头部：数据新鲜度 + 刷新 ─────────────────────────────────────────── */
  var state = { snap: null, busy: false, editHold: false }
  var stampEl = h('span', { class: 'stamp' })
  var refreshBtn = h('button', { class: 'btn', text: '刷新', onclick: function () { load({ manual: true }) } })

  /**
   * ★ 2026-10-10 修（用户实测："过一段时间会跳一下，正在填 API 就被刷掉了"）：
   *   根因 —— `load()` 每 `REFRESH_MS`（60s）跑一次，拿到数据后调 `render()`，
   *   而 `render()` 是 **`clear(body)` 全量重建** ⇒ 用户正在填的「＋ 添加」三个框、
   *   以及每把钥匙的粘贴框，**连同 `st.drafts` 里的半截输入一起被抹掉**。
   *
   *   对策（三层，缺一层都还会丢）：
   *     ① **焦点在输入框里就整轮不取数**（`isEditing()`）—— 最省事，且不浪费一次 HTTP；
   *     ② 万一还是走到了 `render()`（例如 `call()` 回来时用户正瞄着输入框），
   *        `render()` 里**再拦一道**：正在编辑就**认旧快照、不重建 DOM**（宁可看旧数，不丢输入）；
   *     ③ 顶栏时间戳**如实说明"暂缓自动刷新"**，否则用户以为面板坏了。
   *   为什么用"焦点"当判据而不是"drafts 非空"：焦点能覆盖"刚点进来、一个字还没打完"，
   *   而且失焦后自动补刷一次（`editHold`），不会让数据永久停在旧值。
   */
  function isEditing () {
    try {
      var el = document.activeElement
      if (el) {
        var tag = String(el.tagName || '').toUpperCase()
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable === true) return true
        // ⚠️ 这里**故意不把 BUTTON 算进来**：点过任何按钮焦点都会留在按钮上 ⇒
        //    那会把自动刷新**永久冻住**（实测：收工后仍不恢复）。真正要挡的是下面这条"模型面板开着"。
      }
      // ★ 2026-10-10 补（用户实测："选择模型的时候貌似也会被页面刷新，会被打断"）：
      //   **模型面板展开着就一律不刷** —— 用户正在"看清单/选模型"这个动作里，
      //   此时焦点可能哪儿都不在（鼠标悬停、正在读）。重建会把它收起来、进度丢掉。
      //   （实测复现：section 身份 138→225、面板被收起；加这条后 138→138、仍展开。）
      var q = quotaSectionEl()
      if (q && q.__qc) {
        var st = q.__qc()
        if (st && st.modelOpen) return true
      }
      return false
    } catch (e) { return false }
  }

  /** 拿到额度面板 section 元素（`quotaSection()` 返回的那个），用来读它的内部状态。 */
  function quotaSectionEl () {
    try {
      var secs = document.querySelectorAll('section')
      for (var i = 0; i < secs.length; i++) {
        var t = String(secs[i].textContent || '')
        if (t.indexOf('API 额度') !== -1) return secs[i]
      }
    } catch (e) {}
    return null
  }

  function stampText () {
    var B = state.snap
    if (!B || !B.data) return state.busy ? '取数中…' : ''
    var sec = C.secAgoOf(B.data.collectedAt)
    if (sec == null) return ''
    return '数据 ' + C.agoText(sec) + (state.editHold ? '　·　✏️ 正在填表，暂缓自动刷新（离开输入框后自动补刷）' : '')
  }
  /* ── ★ 2026-10-26（用户要求）：顶栏「重启」按钮 + 一盏灯 ─────────────────────
   *   绿＝磁盘上的代码和正在跑的一致（不用管）
   *   黄＝磁盘上的代码比启动时新（**该重启**了，点了就自重启）
   *   灰＝查不到自检口（服务端是旧版 / 没起来）—— 不假装绿。
   *   自重启由服务端 `_self-restart.mjs` 干：等服务退出再拉起，前端只需轮询"pid 变了"再刷新。 */
  var restartLamp = h('i', { class: 'rs-lamp rs-unknown', title: '自检中…' })
  var restartBtn = h('button', {
    class: 'btn top-btn rs-btn',
    title: '重启看板服务（改了服务端代码后点这个）',
    onclick: function () { doRestart() }
  }, [restartLamp, h('span', { text: '重启' })])

  var selfState = { needRestart: null, pid: null, busy: false, at: 0 }

  function paintSelfLamp () {
    var lamp = selfState.needRestart === true ? 'yellow' : (selfState.needRestart === false ? 'green' : 'unknown')
    restartLamp.className = 'rs-lamp rs-' + lamp
    var why = selfState.needRestart === true
      ? ('代码已更新，需要重启：' + (selfState.newer || []).join('、'))
      : (selfState.needRestart === false ? '代码与运行中一致（不用重启）' : '查不到自检口（服务端可能是旧版）')
    restartLamp.title = why
    restartBtn.title = why + '（点一下 = 自重启，约 3 秒；会短暂断开）'
  }

  function loadSelf () {
    return fetch('/panel-self.json', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        selfState.needRestart = j && typeof j.needRestart === 'boolean' ? j.needRestart : null
        selfState.pid = j && j.pid ? j.pid : null
        selfState.newer = (j && j.newer) || []
        selfState.at = Date.now()
        paintSelfLamp()
        return selfState
      })
      .catch(function () { selfState.needRestart = null; paintSelfLamp(); return selfState })
  }

  function doRestart () {
    if (selfState.busy) return
    if (selfState.needRestart === false && !window.confirm('代码和运行中一致，一般不用重启。\n真要重启吗？（约 3 秒不可用）')) return
    selfState.busy = true
    var oldPid = selfState.pid
    restartBtn.disabled = true
    restartLamp.className = 'rs-lamp rs-unknown'
    restartLamp.title = '正在重启…'
    fetch('/panel-restart', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '服务端拒绝重启')
        return waitBack(oldPid, 20000)
      })
      .then(function () { location.reload() })
      .catch(function (e) {
        selfState.busy = false
        restartBtn.disabled = false
        restartLamp.title = '重启失败：' + String((e && e.message) || e)
        alert('重启失败：' + String((e && e.message) || e) + '\n可以手动 stop-panel.cmd / start-panel.cmd。')
      })
  }

  /** 等新进程起来（pid 变了，或至少端口又能应答） */
  function waitBack (oldPid, timeoutMs) {
    var t0 = Date.now()
    return new Promise(function (resolve, reject) {
      var tick = function () {
        fetch('/panel-self.json', { cache: 'no-store' })
          .then(function (r) { return r.json() })
          .then(function (j) {
            if (j && j.pid && j.pid !== oldPid) return resolve(j)
            if (Date.now() - t0 > timeoutMs) return reject(new Error('等太久还没起来'))
            setTimeout(tick, 400)
          })
          .catch(function () {
            if (Date.now() - t0 > timeoutMs) return reject(new Error('服务没回来'))
            setTimeout(tick, 400)
          })
      }
      setTimeout(tick, 600)
    })
  }

  function paintStamp () { stampEl.textContent = stampText(); refreshBtn.disabled = state.busy; refreshBtn.textContent = state.busy ? '刷新中…' : '刷新'; paintOverview(); paintDispatch(); loadSelf() }

  /* ── ★ 2026-10-26（§十「顶部总览」）：交付 / 门禁+E2E / 任务 / 健康 / 契约 五项一眼看全 ──────
   *   纪律：每盏灯都来自 board-data 的 `overview.items`（那五个源在服务端统一读过）；
   *        `unknown` 显示灰灯 + "未知"，**绝不显示绿**（缺证据 ≠ 通过）。
   *   为什么挂在 `paintStamp()` 里而不是 `render()` 里：`render()` 是 `clear(body)` 全量重建，
   *        总览条在 body 之外（常驻），重建时不该被清掉。 */
  var overviewEl = h('div', { class: 'overview' })
  function paintOverview () {
    // ⚠️ 服务返回的是信封：真数据在 `.data` 里（与 renderAll(B.data || {}) 同一口径）
    var snap = state.snap && (state.snap.data || state.snap)
    var ov = snap && snap.overview
    clear(overviewEl)
    if (!ov || !ov.items) {
      append(overviewEl, [h('span', { class: 'ov-item ov-unknown', title: '还没有看板数据（或这版服务端没算总览）' }, [h('i', { class: 'ov-dot' }), h('span', { text: '总览：未知' })])])
      return
    }
    ov.items.forEach(function (it) {
      var lamp = it.lamp || 'unknown'
      var zh = { green: '绿', yellow: '黄', red: '红', unknown: '未知' }[lamp] || '未知'
      var el = h('span', {
        class: 'ov-item ov-' + lamp,
        title: (it.label || it.id) + '：' + zh + (it.detail ? '\n' + it.detail : '')
      }, [
        h('i', { class: 'ov-dot' }),
        h('b', { text: it.label || it.id }),
        h('span', { class: 'ov-text', text: ' ' + (it.text || zh) })
      ])
      append(overviewEl, [el])
    })
    if (!ov.allGreen) append(overviewEl, [h('span', { class: 'ov-hint', text: '（有项非绿：悬停看原因）' })])
  }

  /* ── ★ 2026-10-26（§十「调度条加写域/角色池」）：把 `planSchedule()` 的结果画出来 ──────────
   *   以前看板只有"多少张卡在跑"，看不到"**为什么不能并行**"（写域撞了 / 同载体 / 共享资源）。
   *   数据来自 `board-data.scheduler`（服务端调 `_调度.planSchedule()` 算好的），页面不重算。
   *   算不出来 ⇒ 明说"算不出"，**不显示一个假的空计划**。 */
  var dispatchEl = h('div', { class: 'dispatch' })
  function paintDispatch () {
    var snap = state.snap && (state.snap.data || state.snap)
    var s = snap && snap.scheduler
    clear(dispatchEl)
    if (!s) return
    if (!s.ok) {
      append(dispatchEl, [h('span', { class: 'dp-bad', text: '调度：算不出（' + (s.why || '未知') + '）' })])
      return
    }
    var st = s.stats || {}
    var bits = []
    bits.push(h('span', { class: 'dp-k', text: '调度' }))
    bits.push(h('span', { class: 'dp-v', title: '可派 / 已排 / 批数 / 并行宽度', text: ' 可派 ' + (st.candidates ?? 0) + ' · 排 ' + (st.scheduled ?? 0) + ' · 批 ' + (st.batches ?? 0) + ' · 宽 ' + (st.parallelWidth ?? 0) }))
    if (st.unknownScope && st.unknownScope.length) {
      bits.push(h('span', { class: 'dp-warn', title: '这些卡没写 writes（软约束，仍可并行）', text: ' · 未知写域 ' + st.unknownScope.length + ' 张' }))
    }
    if (st.hotspotFiles && st.hotspotFiles.length) {
      var hot = st.hotspotFiles[0]
      bits.push(h('span', { class: 'dp-warn', title: st.hotspotFiles.map(function (x) { return x.file + ' ← ' + x.tasks + ' 张卡' }).join('\n'), text: ' · 热点 ' + hot.file + '（' + hot.tasks + ' 张）' }))
    }
    (s.batches || []).forEach(function (b, i) {
      var title = '批 ' + (b.index || i + 1) + '\n卡：' + (b.tasks || []).join('、') +
        '\n写域：' + ((b.writeDomains || []).join('、') || '（无）') +
        '\n载体：' + ((b.carriers || []).join('、') || '（未映射）') +
        '\n资源：' + ((b.resources || []).join('、') || '（无）')
      bits.push(h('span', { class: 'dp-batch', title: title, text: ' 批' + (b.index || i + 1) + ':' + (b.tasks || []).length }))
    })
    if ((s.skipped || []).length) {
      bits.push(h('span', { class: 'dp-skip', title: s.skipped.map(function (x) { return x.id + '：' + x.why }).join('\n'), text: ' · 未排 ' + s.skipped.length }))
    }
    append(dispatchEl, bits)
  }

  function load (opts) {
    // ① 自动轮询：正在编辑 → 这一轮整个跳过（连取数都不取），并记一笔待补刷。
    //    手动点「刷新」/ 跑一轮后的刷新**不拦** —— 那是用户明确要求，他愿意承担重绘。
    if (!(opts && opts.manual) && isEditing()) {
      state.editHold = true
      paintStamp()
  loadSelf(); setInterval(loadSelf, 30000)
      return Promise.resolve(null)
    }
    state.busy = true
    paintStamp()
    var q = new URLSearchParams(location.search).get('project')
    var url = DATA_URL + '?t=' + Date.now() + (q ? '&project=' + encodeURIComponent(q) : '')
    // ★ 返回 promise（同上）：顶栏「刷新」要等它落地
    return fetch(url, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null })
      .then(function (j) { state.snap = j; state.busy = false; state.editHold = false; render(); paintStamp() })
      .catch(function () { state.snap = state.snap || null; state.busy = false; state.editHold = false; render(); paintStamp() })
  }

  /* ── 主体 ───────────────────────────────────────────────────────────── */
  var body = h('div', { class: 'body' })
  /** ★ b209：看板页顶上那条「钉错目录」的明白话（由 `render()` 在拿到数据后填）。 */
  var boardPinBar = null
  /** ★ D28：看板页顶上第二条 —— 钉的项目 ≠ 本次跑的 project / 钉失效（`fillRunPinBanner` 填）。 */
  var boardD28Bar = null

  /* ── ★ b125（用户 2026-10-18）：**「API 额度 / 职位模型」整块从「设置」页搬到「API」页**
   *   用户原话：*"把这个移动到 API 按钮里，不要放在看板的设置里了"*。
   *   ⚠️ **只是换宿主页**：这块的唯一实现仍是 `额度面板.mjs`（服务端）＋ 本文件的 `quotaSection()`，
   *      判据、写盘路径（`/api-keys`）、quiet 名单、存/恢复滚动**一个字没动**。
   *   ⚠️ 两个页面**各装各的**：`render()` 里 `clear(body)`（设置）之外还要 `renderApi()`（API），
   *      否则切到 API 会看到上一次的残影或空壳。
   *   ⚠️ `quotaSectionEl()` 是**全文档**找那个 `section`（靠标题里的「API 额度」）⇒ 换页不用改它。 */
  var apiBox = h('div', { class: 'body' })
  function renderApi () {
    clear(apiBox)
    var B = state.snap
    // 与「设置」页同一条门槛：数据没到就不装那块（它要读 providers / 角色行）
    if (!B || !B.ok) {
      apiBox.appendChild(card('数据未就绪', [
        h('div', { class: 'o', text: '没有取到 /board-data.json（服务没起，或文件还没生成）。' }),
        h('div', { class: 'dim tiny', text: '点顶栏「刷新」重试；一直不行就跑一次 `node _unattended\\看板数据.mjs`。' })
      ]))
      return
    }
    try { apiBox.appendChild(quotaSection()) } catch (e) {
      apiBox.appendChild(card('⚠️ API 页渲染出错（已捕获，数据没丢）', [
        h('div', { class: 'dim tiny', text: String((e && e.message) || e) })
      ]))
    }
    // ★ 2026-10-23（施工文档 §14）：职位模型编辑器**下方**再加一张「每载体上次使用」表。
    //   目的（用户口径）：遇到"写不动/被截断/只思考不落盘"时，**3 秒内**看出这个载体上次到底跑的哪个模型、能吃多少。
    try { apiBox.appendChild(lastUsedSection()) } catch (e) {
      apiBox.appendChild(card('⚠️ 「上次使用」没渲染出来（不影响其它块）', [
        h('div', { class: 'dim tiny', text: String((e && e.message) || e) })
      ]))
    }
  }

  /**
   * 「每个载体上次使用」—— §14 的表。
   * 只显示 4 个载体（pi / opencode / codebuddy / qwencode）；**大脑与 researcher（messenger）明确排除**
   * （大脑的模型在 roster.brain.model 已有展示；messenger 走 DSH 自己的 cost-meter，不归班组账本）。
   */
  function lastUsedSection () {
    var B = state.snap
    var box = B && B.lastUsedByCarrier
    if (!box || !Array.isArray(box.rows)) return h('span')
    var fmt = function (n) {
      if (n == null) return '—'
      try { return Number(n).toLocaleString('en-US') } catch (e) { return String(n) }
    }
    var when = function (at) {
      if (!at) return '—'
      var d = new Date(at)
      if (isNaN(d.getTime())) return '—'
      var p = function (x) { return (x < 10 ? '0' : '') + x }
      return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }
    var rows = box.rows.map(function (r) {
      var cap = r.capacity
      var cw = cap && cap.contextWindow != null ? fmt(cap.contextWindow) : 'unknown'
      var mo = cap && cap.maxOutputTokens != null ? fmt(cap.maxOutputTokens) : 'unknown'
      if (cap && cap.stale) { cw += '*'; mo += '*' }
      var stateText, stateStyle = null
      if (r.state === 'unused') { stateText = '没用过'; stateStyle = 'color:var(--dim)' }
      else if (r.state === 'ceiling') { stateText = '⚠️ 撞顶'; stateStyle = 'color:var(--r);font-weight:600' }
      else if (r.state === 'unknown-capacity') { stateText = '⚠️ 能力未知'; stateStyle = 'color:var(--o)' }
      else { stateText = '✅' }
      var modelCell = r.model
        ? h('span', { title: '账本里的原样写法：' + r.model, text: r.provider + ' / ' + r.modelId })
        : h('span', { class: 'dim', text: '—' })
      var capCell = function (txt, tip) {
        var unknown = txt === 'unknown'
        return h('span', { title: tip || null, text: txt, style: unknown ? 'color:var(--r)' : null })
      }
      return [
        h('span', { text: r.carrier + (r.role ? '（' + r.role + '）' : '') }),
        modelCell,
        capCell(cw, cap ? ('来源 ' + (cap.source || '?') + '　抓取 ' + String(cap.at || '?').slice(0, 16)) : null),
        capCell(mo, cap ? ('来源 ' + (cap.source || '?') + '　抓取 ' + String(cap.at || '?').slice(0, 16)) : null),
        h('span', { text: when(r.at) }),
        h('span', { text: stateText, style: stateStyle })
      ]
    })
    var tbl = table(['载体', '上次用的模型（家 / 模型）', '上下文', '最大输出', '上次时间', '状态'], rows, 2)
    return card('每个载体上次使用（只留最近一条）', [tbl], '照 `_crew\\ledger.json` 的 calls 取每个载体最新一条；上下文/最大输出查 `_crew\\模型能力.json`。'
      + '`unknown` ＝ 注册表里没有这个模型的能力（**不是 16384**）；数字后的 `*` ＝ 抓取超过 7 天，悬停看抓取时间。')
  }

  /**
   * ★ 2026-10-10 修（用户实测："我点了以后页面自动往上滚了一下"）：
   *   `render()` 是 `clear(body)` **全量重建**，重建后页面高度在中途会变，
   *   浏览器就把视口**弹回顶部** —— 用户点一下「获取模型」，人就被甩回页首。
   *   这里在重建前后**存/恢复滚动位**：window 和每一个可滚动元素都恢复到原位。
   *   ⚠️ 为什么用 `requestAnimationFrame`：同步恢复会被浏览器随后的布局调整再冲掉一次；
   *      放在下一帧能盖住那次调整（实测有效）。恢复后把快照丢掉即可（每帧重置）。
   */
  function captureScroll () {
    var out = [{ el: null, top: (window.pageYOffset || document.documentElement.scrollTop || 0), left: (window.pageXOffset || 0) }]
    try {
      var all = document.querySelectorAll('*')
      for (var i = 0; i < all.length; i++) {
        var e = all[i]
        if ((e.scrollTop || 0) > 0 || (e.scrollLeft || 0) > 0) out.push({ el: e, top: e.scrollTop || 0, left: e.scrollLeft || 0 })
      }
    } catch (err) {}
    return out
  }
  function restoreScroll (snap) {
    var apply = function () {
      for (var i = 0; i < snap.length; i++) {
        var s = snap[i]
        if (!s.el) { try { window.scrollTo(s.left, s.top) } catch (err) {} }
        else { s.el.scrollTop = s.top; s.el.scrollLeft = s.left }
      }
      pendingScroll = null
    }
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply)
    else apply()
  }
  var pendingScroll = null

  /* ── 🧠 大脑建议（只看不改）★ 2026-10-23（施工文档 D18 / §5.5 / §6）────────────────
   *  模式 A：系统只出建议、写证据；**改不改由你点**（采纳写 `当前.json`，忽略只记日志）。
   *  数据来自 `_crew<项目>\调参\建议-<stamp>.json`（编排在波次收尾跑一次，0 token 回放历史）。
   *  ⚠️ 越界的建议（超出参数表允许区间）**不显示采纳按钮** —— 要你手改。
   *  ★ observations（观察项，跟 items **平级**）：在 items **之后**渲染，**不给任何按钮**，
   *    底部灰字"观察项：不改参数，只让你知道"（§5.5 原话；别复用"超出参数表允许区间"那句，会误导）。
   *    来源＝`POST /api-tune {op:'latest'}`（`调参.mjs --latest` 的原样建议 JSON）——
   *    因为 `/board-data.json` 的 `advisor` 投影只搬条目，observations 会被它丢掉。
   *  ★ D27：唤醒结果（"没叫到（原因）"）也从同一口子带上来（`_crew\唤醒状态.json` → 调参 latest 的 wake 字段）。
   *  ★★ 2026-10-24（施工文档 §11.2 A · **这一块不再"自己收起来"**）：
   *    · 原来"没有建议 / 没有观察 / 没有唤醒异常 ⇒ `display:none`"，用户看到的是"这块没了"，以为坏了；
   *    · 现在**永远渲染**，空的时候就说清"已攒 X / 20 张卡（还差 Y）"，并把样本**拆开**报
   *      （本项目收据 vs 全工作台账本 —— 两者是不同池子，合成一个数会骗人）；
   *    · 每条带 `wired`：`false` ＝ 编排还没读这个参数 ⇒ 标「只建议 · 当前不生效」且**不给采纳按钮**
   *      （`调参.mjs` 的 `accept()` 里也硬拦了 —— 页面漏了也采纳不进去）。
   */
  function advisorBox (d) {
    var a = (d && d.advisor) || {}
    var busy = { v: false }
    function send (op) {
      return function () {
        if (busy.v) return
        busy.v = true
        var proj = (state.snap && state.snap.currentProject && state.snap.currentProject.path) || ''
        fetch('/api-tune', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ op: op, project: proj })
        }).then(function (r) { return r.json() }).then(function (j) {
          busy.v = false
          load({ manual: true })
          if (!j || !j.ok) alert((op === 'accept' ? '采纳' : '忽略') + '失败：' + ((j && j.error) || '未知'))
        }).catch(function (e) { busy.v = false; alert('请求失败：' + ((e && e.message) || e)) })
      }
    }
    var fmtV = function (v) { return (v && typeof v === 'object') ? ('黄 ' + v.yellow + ' / 红 ' + v.red) : String(v) }
    // ① 样本进度（异步补精确值；先给一句"读取中" —— ★ §11.2 A：**绝不整格消失**）
    var sampleBox = h('div', { class: 'dim', text: '  数据池：读取中…' })
    // ② 参数现值（还没有建议文件时，也要能说清"哪几个会真生效"）
    var paramLine = h('div', { class: 'dim tiny' })
    if ((a.params || []).length) {
      paramLine.textContent = '  参数现值：' + a.params.map(function (p) {
        return String(p.label || p.id) + ' ' + fmtV(p.now) + (p.wired === false ? '（未接线）' : '')
      }).join(' · ')
    }
    // ③ 建议条目：**未接线 / 样本不够的只提示、不给采纳按钮**（点了没用还骗人）
    var rows = (a.items || []).map(function (x) {
      var kids = [
        h('div', { class: 'o', text: '  ' + String(x.text || (String(x.label || x.id) + ' ' + fmtV(x.now) + ' → ' + fmtV(x.advice))) }),
        h('div', { class: 'dim tiny', text: '  为什么：' + String(x.why || '—') })
      ]
      // ★ §11.2 C：每个参数**自己的**样本与门槛（不再是统一的 20 张卡）
      if (x.sampleMin != null) {
        kids.push(h('div', { class: 'dim tiny', text: '  样本：' + (x.sampleN == null ? '?' : x.sampleN) + ' / ' + x.sampleMin + ' ' + String(x.sampleUnit || '') + (x.enough === false ? '（不够）' : '（够）') }))
      }
      if (x.wired === false) {
        kids.push(h('div', { class: 'dim tiny', text: '  ⚠️ 只建议 · 当前不生效（编排还没读这个参数，接上之前点了也没用）' }))
      } else if (x.canAccept) {
        kids.push(h('div', null, [
          h('button', { class: 'btn tiny', text: '采纳', onclick: send('accept') }),
          h('span', { text: ' ' }),
          h('button', { class: 'btn tiny', text: '忽略', onclick: send('ignore') })
        ]))
      } else if (!x.changed) {
        kids.push(h('div', { class: 'dim tiny', text: '  （保持现值，不用改）' }))
      } else if (x.enough === false) {
        kids.push(h('div', { class: 'dim tiny', text: '  （这个参数的样本不够，先不给采纳按钮）' }))
      } else {
        kids.push(h('div', { class: 'dim tiny', text: '  （超出参数表允许区间 ⇒ 只建议、不提供采纳按钮；要改请手改 当前.json）' }))
      }
      return h('div', { style: 'margin:4px 0' }, kids)
    })
    if (!rows.length) {
      rows.push(h('div', { class: 'dim', text: '  ' + (a.at ? '本轮没有要动的参数（都在现值上）' : '还没有建议 —— 编排跑完一波会自动生成（0 token）') }))
    }
    if (a.more) rows.push(h('div', { class: 'dim tiny', text: '还有 ' + a.more + ' 个参数没摆出来，见证据文件。' }))
    // ④ 观察项 / 唤醒（异步填；**永不给按钮**）
    var obsBox = h('div', { class: 'dim tiny', text: '观察项载入中…' })
    var wakeBox = h('div')
    var foot = h('div', { class: 'dim tiny', text: a.file ? ('证据：' + String(a.file) + (a.mdFile ? '　人话一页：' + String(a.mdFile) : '')) : '  证据：还没有建议文件' })
    var wiredNote = h('div', { class: 'dim tiny', text: '会真生效的：【无进展唤醒】【看板灯】【单卡硬超时】【并行宽度】（编排与看护真读 当前.json）；【失败重试次数】还没接线 ⇒ 那一格不给采纳按钮。单次幅度最多 ±10 分钟 / ±1 档。目标排序：少误杀 > 省钱 > 省墙钟（施工文档 §11）。' })
    var box = card('🧠 大脑建议（只看不改）', [sampleBox, paramLine].concat(rows, [obsBox, wakeBox, foot, wiredNote]), null)
    var proj = (state.snap && state.snap.currentProject && state.snap.currentProject.path) || ''
    fetch('/api-tune', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'latest', project: proj })
    }).then(function (r) { return r.ok ? r.json() : null }).then(function (j) {
      // 数据池：只报"有多大"，**不判断够不够** —— §11.2 C 起每个参数有自己的门槛（写在各条后面）
      var sp = (j && j.sampleProgress) || null
      var cards = (sp && sp.cards != null) ? sp.cards : ((a.sampleCards != null) ? a.sampleCards : null)
      var ledger = (sp && sp.ledger != null) ? sp.ledger : ((a.sampleLedger != null) ? a.sampleLedger : null)
      if (cards == null && ledger == null) sampleBox.textContent = '  数据池：算不出（既没有收据也没有账本）'
      else sampleBox.textContent = '  数据池：本项目收据 ' + (cards == null ? '?' : cards) + ' 张 · 全工作台账本 ' + (ledger == null ? '?' : ledger) + ' 次调用 · 样本库 ' + ((a.sampleLib == null) ? '?' : a.sampleLib) + ' 条（其中本项目 ' + ((a.sampleLibMine == null) ? '?' : a.sampleLibMine) + '）—— 每个参数门槛不同，够不够看各条后面'
      var obs = (j && j.latest && Array.isArray(j.latest.observations)) ? j.latest.observations : []
      clear(obsBox)
      obs.forEach(function (o) {
        obsBox.appendChild(h('div', { style: 'margin:4px 0' }, [
          h('div', { class: 'dim', text: '  ◻ ' + String(o.label || o.id || '观察') + '：' + String(o.text || '') }),
          h('div', { class: 'dim tiny', text: '  为什么：' + String(o.why || '') }),
          h('div', { class: 'dim tiny', text: '  证据：' + String(o.evidence || '') })
        ]))
      })
      if (obs.length) obsBox.appendChild(h('div', { class: 'dim tiny', text: '观察项：不改参数，只让你知道' }))
      else obsBox.textContent = '观察项：暂无（返工≥2且无增量≥50% / AC红≥5且自愈<30% / unknown≥30% 才亮）'
      var w = j && j.wake
      clear(wakeBox)
      if (w && w.ok === false && w.why) {
        wakeBox.appendChild(h('div', { class: 'tiny txt-warn', text: '🔔 叫醒大脑：' + String(w.why) }))
      }
    }).catch(function (e) {
      clear(obsBox)
      obsBox.appendChild(h('div', { class: 'dim tiny', text: '观察项取不到（/api-tune 不通）：' + String((e && e.message) || e) }))
      sampleBox.textContent = '  数据池：取不到（/api-tune 不通）'
    })
    return box
  }

  /* ── 🔴 待你处理（编排写进 <项目>\_crew\halt.json 的条目，原样列出来等人）── */
  function haltSection (d) {
    var halt = Array.isArray(d.halt) ? d.halt : []
    if (!halt.length) return null
    var lines = halt.slice(-6).map(function (x) {
      return h('div', { class: 'tiny' }, [
        '🔴 ' + String(x.id || '?') + '　[' + String(x.kind || '待处理') + ']' + (x.why ? '　' + String(x.why) : '') + ((x.seen && x.seen > 1) ? '　（第 ' + x.seen + ' 次出现）' : ''),
        x.hint ? h('div', { class: 'dim', text: String(x.hint) }) : null
      ])
    })
    return card('🔴 待你处理（' + halt.length + ' 件）', [
      h('div', { class: 'dim tiny', text: '这些不是派活能解决的：环境类（没 key / 账号 / 额度 / 网络）只有你能补；代码类里审核+急救也没解决的，大脑定不了才到这儿。它们不会拖住别的任务。' })
    ].concat(lines))
  }

  function render () {
    // ② 兜底：正在编辑就不重建 DOM（重建 = `clear(body)`，会把用户正填的框连数据一起抹掉）。
    //    宁可显示旧快照，也不丢用户输入 —— 失焦后 60s 内会自然补上。
    if (isEditing()) { state.editHold = true; paintStamp(); return }
    pendingScroll = captureScroll()
    clear(body)
    renderApi()                      // ★ b125：API 页跟着一起重建（两块各自 clear 各自装）
    var B = state.snap
    if (!B) {
      body.appendChild(card('数据未就绪', [
        h('div', { class: 'o', text: '没有取到 /board-data.json（服务没起，或文件还没生成）。' }),
        h('div', { class: 'dim tiny', text: '点右上「刷新」重试；一直不行就跑一次 `node _unattended\\看板数据.mjs`。' })
      ]))
      if (pendingScroll) restoreScroll(pendingScroll)
      return
    }
    if (!B.ok) {
      body.appendChild(card('看板数据不可用', [
        h('div', { class: 'o', text: C.txt(B.reason) }),
        B.hint ? h('div', { class: 'dim tiny', text: B.hint }) : null,
        h('div', { class: 'dim tiny' }, h('code', { text: C.txt(B.source) }))
      ]))
      if (pendingScroll) restoreScroll(pendingScroll)
      return
    }
    try {
      renderAll(B.data || {})
      // ★ b209：看板页顶上也要挂（用户看的是这一页；只放在「设置」等于没提示）
      if (boardPinBar) fillPinBanner(boardPinBar, (B.data || {}).currentProject)
      if (boardD28Bar) fillRunPinBanner(boardD28Bar, (B.data || {}))
    } catch (e) {
      body.appendChild(card('⚠️ 面板渲染出错（已捕获，数据没丢）', [
        h('div', { class: 'dim tiny', text: String((e && e.message) || e) }),
        h('div', { class: 'dim tiny', text: '把这一行原样贴给大脑即可。数据本身在 _crew\\board-data.json。' })
      ]))
    }
    if (pendingScroll) restoreScroll(pendingScroll)
  }

  /* ── ★ b130：表1「只有箭头能收放」＋「右上角日期范围」（用户 2026-10-18 两条口径）──
   *   ① "展开按钮这里，要精确，而不是鼠标点着一行都展开收缩"
   *   ② "红框的位置加一个选择日期的，可以选择范围去看 token 用量，起始日期+结束日期"
   *
   * 为什么**不能**继续用原生 `<details>/<summary>`：`<summary>` 的激活行为对**它内部的任何后代**都生效
   *   ⇒ 点这一行任意位置（含右上角）都会收放；而日期框就挂在同一行上，点它必然误触。
   *   `pointer-events` 也救不了（事件照样冒泡到 summary，激活行为照跑）。
   *   ⇒ 干脆不用 details：头是普通 `div` ＋ 一个只认自己的箭头 `span`，日期框是它的**兄弟**。
   *
   * 日期范围口径：**只筛「调用次数 / token 用量」两列**（它们是按天累积的）；
   *   「额度 / 钥匙」是**厂商级快照**，与日期无关，照旧显示。
   *   两个框都空 = 全期 ⇒ **与改动前逐字节一致**（走 `core.providerCells` 原路）。
   */
  var tkRange = { from: '', to: '' }
  var tkOpen = true                                        // 表1 默认展开（＝改动前的 `open: true`）
  try {
    var _tk = JSON.parse(localStorage.getItem('dsh.tkRange') || 'null')
    if (_tk && typeof _tk === 'object') tkRange = { from: String(_tk.from || ''), to: String(_tk.to || '') }
  } catch (e) { /* 隐私模式 / 存储被禁 ⇒ 退回内存态，不报错、不挡渲染 */ }
  function saveTkRange () { try { localStorage.setItem('dsh.tkRange', JSON.stringify(tkRange)) } catch (e) {} }
  function tkRanged () { return !!(tkRange.from || tkRange.to) }
  /** `'YYYY-MM-DD'` 的字典序 = 时间序 ⇒ 直接比字符串（不用 Date，也就没有时区坑）。 */
  function tkInRange (day) {
    if (tkRange.from && day < tkRange.from) return false
    if (tkRange.to && day > tkRange.to) return false
    return true
  }
  /** ★ 必须与 `看板数据.mjs` 的 `fmtTok` **同一口径**（那边是全期列的唯一实现，这里是范围列的）。 */
  function fmtTokUi (n) {
    return n >= 1e8 ? (n / 1e8).toFixed(2) + ' 亿' : n >= 1e4 ? (n / 1e4).toFixed(1) + ' 万' : String(n)
  }
  /** 一行取「调用次数 / token 用量」：没筛日期 ⇒ 原值原样；筛了 ⇒ 用 `byDay` 现算。 */
  function tkPick (p) {
    if (!tkRanged()) return { calls: p.calls, tokens: p.tokens, ranged: false, missing: false }
    var bd = p && p.byDay
    if (!bd) return { calls: 0, tokens: 0, ranged: true, missing: true }
    var c = 0
    var t = 0
    for (var d in bd) { if (!tkInRange(d)) continue; c += Number(bd[d].calls) || 0; t += Number(bd[d].tokens) || 0 }
    return { calls: c, tokens: t, ranged: true, missing: false }
  }
  /** 表1 一行：前 3 格（模型商 / 钥匙 / 额度）与日期无关，照用 `core.providerCells`；后 2 格按范围换数。 */
  function providerCellsRanged (p) {
    var base = C.providerCells(p)
    var s = tkPick(p)
    if (!s.ranged) return base
    var pre = p.detail ? (p.detail + ' · ') : ''
    var why = s.missing
      ? pre + '⚠️ 这份 board-data.json 里还没有「按天分项」（byDay）⇒ 日期范围算不出来；跑一次 看板数据.mjs 重生成'
      : pre + '口径 = 日期范围 ' + (tkRange.from || '最早') + ' 〜 ' + (tkRange.to || '最新') +
        '（由 byDay 现算；额度 / 钥匙是厂商级快照，不随日期变）'
    return base.slice(0, 3).concat([
      s.calls > 0 ? { text: String(s.calls), title: why } : { text: '—', tone: 'n', title: why },
      s.tokens > 0 ? { text: fmtTokUi(s.tokens), title: why } : { text: '—', tone: 'n', title: why }
    ])
  }
  /** 表1 那张卡：自搭头（只有箭头收放）＋ 右上角日期范围。 */
  function providerCard (providers) {
    var tblBox = h('div')
    var caret = h('span', { class: 'pcard-caret', text: tkOpen ? '▾' : '▸', title: '点这里展开 / 收起（这一行别的地方点了不会动）' })
    var fromI = h('input', { type: 'date', class: 'pcard-date', title: '起始日期（含当天）——留空＝不限' })
    var toI = h('input', { type: 'date', class: 'pcard-date', title: '结束日期（含当天）——留空＝不限' })
    fromI.value = tkRange.from
    toI.value = tkRange.to
    function paintTable () {
      clear(tblBox)
      if (!providers.length) {
        tblBox.appendChild(h('div', { class: 'dim tiny', text: 'board-data.json 里还没有 providers —— 跑一次 看板数据.mjs' }))
        return
      }
      var tag = tkRanged() ? ('（' + (tkRange.from || '起') + ' 〜 ' + (tkRange.to || '今') + '）') : '（全期累计）'
      tblBox.appendChild(table(
        ['模型商（API来源）', '钥匙（可用状态）', '额度', '调用次数' + tag, 'token用量' + tag],
        providers.map(function (p) { return providerCellsRanged(p) }), 2))
      if (tkRanged()) {
        tblBox.appendChild(h('div', { class: 'dim tiny', text:
          '已按日期范围筛选：只筛「调用次数 / token 用量」两列（它们按天累积）；「额度 / 钥匙」是厂商级快照，与日期无关。' +
          '范围存在本机浏览器里（换浏览器 / 清缓存会丢）。' }))
      }
    }
    function applyRange () {
      tkRange.from = fromI.value || ''
      tkRange.to = toI.value || ''
      saveTkRange()
      paintTable()                       // 只重画表体 ⇒ 不碰输入框、不丢焦点、不跳滚动
    }
    caret.addEventListener('click', function (e) {
      e.preventDefault()
      e.stopPropagation()                // 不冒泡 ⇒ 不会连带触发别的监听
      tkOpen = !tkOpen
      caret.textContent = tkOpen ? '▾' : '▸'
      tblBox.style.display = tkOpen ? '' : 'none'
    })
    fromI.addEventListener('change', applyRange)
    toI.addEventListener('change', applyRange)
    var resetBtn = h('button', {
      class: 'btn', style: { fontSize: '11px', padding: '1px 6px' }, text: '全期',
      title: '清掉日期范围（回到全期累计）',
      onclick: function () { fromI.value = ''; toI.value = ''; applyRange() }
    })
    tblBox.style.display = tkOpen ? '' : 'none'
    paintTable()
    return h('section', { class: 'card' }, [
      h('div', { class: 'pcard-head' }, [
        caret,
        h('span', { class: 'pcard-title', text: '模型商 / 额度 / 用量（表1）' }),
        h('span', { class: 'pcard-ctl' }, [
          h('span', { class: 'dim tiny', text: '日期范围' }), fromI,
          h('span', { class: 'dim tiny', text: '〜' }), toI, resetBtn
        ])
      ]),
      tblBox
    ])
  }

  /* ── 🚨 口径违规（★ b197 · 施工文档 §四 M6-5 · C 通道）─────────────────────
   * 用户口径（M6-5 大白话）：**写在卡里、违反了不疼的规矩等于没有**，而且会稀释真规矩的权重。
   * 这一格只回答一件事，**机械判据、没有"应该"**：最近几份收据里，`policy` 判过几条违规
   *   （回执里跑全量 / 没引用门禁结果 / 工具调用超预算）。
   * 判决层一个字都不改（改判决会触发额度切换、白烧另一个网关）⇒ 代价只加在"看得见"与"下一张卡"。
   * ⚠️ 展开状态存 localStorage（render() 每 60 秒全量重建，不存就会被收起来 —— 与 tkRange 同一个坑）。
   */
  var polOpen = false
  try { polOpen = localStorage.getItem('dsh.policy.open') === '1' } catch (e) { /* 隐私模式 ⇒ 内存态 */ }
  function policyBox (d) {
    try { return policyBoxInner(d) } catch (e) {
      return card('🚨 口径违规', [h('div', { class: 'dim tiny', text: '这一格渲染失败（其余照常）：' + String((e && e.message) || e) })])
    }
  }
  function policyBoxInner (d) {
    var r = (d && d.policy) || null
    if (!r) {
      return card('🚨 口径违规', [h('div', { class: 'dim tiny', text: '这份 board-data.json 里还没有 policy 段 —— 跑一次 `node _unattended\\看板数据.mjs` 重生成即可。' })])
    }
    var st = r.state
    var dot = st === 'hit' ? 'r' : st === 'clean' ? 'g' : 'n'
    var head = st === 'hit' ? '上一轮有任务违反了卡上写死的口径' : st === 'clean' ? '口径违规 0' : '判不了（还没扫到收据）'
    var kids = [h('div', { class: 'tiny' }, [
      h('span', { class: 'dot ' + dot }),
      h('span', { class: st === 'hit' ? 'r' : null, text: head })
    ])]
    if (r.note) kids.push(h('div', { class: st === 'hit' ? 'r tiny' : 'dim tiny', text: C.txt(r.note) }))
    var hits = r.hits || []
    if (hits.length) {
      var btn = h('button', { class: 'btn', text: polOpen ? '收起明细 ▲' : '点开看是谁（' + C.txt(hits.length) + ' 条）▼' })
      var det = h('div', { class: 'dim tiny' })
      append(det, polOpen ? hits.slice(0, 30).map(function (x) {
        var name = { 'review-overreach': '回执里跑了全量命令', 'review-unverified': '没引用门禁结果', 'review-over-budget': '工具调用超预算' }[x.policy] || x.policy
        return h('div', { text: C.txt(String(x.stamp || '?')) + '　' + C.txt(String(x.task || x.kind || '?')) + '（' + C.txt(String(x.role || '?')) + '）　' + name + (x.action ? '　— ' + C.txt(String(x.action).slice(0, 80)) : '') })
      }) : null)
      btn.onclick = function () {
        polOpen = !polOpen
        try { localStorage.setItem('dsh.policy.open', polOpen ? '1' : '0') } catch (e) {}
        render()
      }
      kids.push(h('div', { class: 'row' }, [btn]))
      kids.push(det)
    }
    return card('🚨 口径违规（卡上的规矩有没有长牙）', kids,
      '判据：收据 `verdict.json` 里的 `policy` 字段（编排的收活判断层写的）—— 跑全量 / 未引门禁 / 超预算。判决不改，只在**这一格**和**下一张卡**上施加压力。')
  }

  /* ── 🧭 规矩版本（★ 2026-10-19 b184）───────────────────────────────────────
   * 用户口径：「我不知道现在大脑跑的是哪版规矩」。
   * 这一格只回答两件事，**都是机械判据，没有"应该"**：
   *   ① 本进程有没有加载这版 brain.md（红 = 改完没重启，改了等于没改）；
   *   ② 最近一个大脑会话与当前文件对上了多少行（证据来自 `规矩版本体检.mjs` 的缓存）。
   * ⚠️ 展开状态必须存 localStorage：`render()` 每 60 秒 `clear(body)` 全量重建，
   *    不存的话用户点开看证据，下一秒就被收起来（与 `tkRange` 同一个坑、同一种解）。
   */
  var rulesOpen = false
  try { rulesOpen = localStorage.getItem('dsh.rules.open') === '1' } catch (e) { /* 隐私模式 ⇒ 内存态 */ }
  /** 兜底：这一格自己出错**绝不能拖垮整页**（整页重建在 try 里，但一格炸会连累后面所有卡片）。 */
  function rulesBox (d) {
    try { return rulesBoxInner(d) } catch (e) {
      return card('🧭 规矩版本', [h('div', { class: 'dim tiny', text: '这一格渲染失败（其余照常）：' + String((e && e.message) || e) })])
    }
  }
  function rulesBoxInner (d) {
    var r = (d && d.rules) || null
    if (!r) {
      return card('🧭 规矩版本', [
        h('div', { class: 'dim tiny', text: '这份 board-data.json 里还没有 rules 段 —— 跑一次 `node _unattended\\看板数据.mjs` 重生成即可。' })
      ])
    }
    var st = r.state
    var dot = st === 'ok' ? 'g' : st === 'stale' ? 'r' : 'n'
    var headline = st === 'ok'
      ? '本进程加载的就是当前这版 brain.md'
      : st === 'stale'
        ? '本进程内存里是旧规矩 —— 重启桌面端才生效'
        : '判不了（拿不到进程启动时间）'
    var kids = [h('div', { class: 'tiny' }, [
      h('span', { class: 'dot ' + dot }),
      h('span', { class: st === 'stale' ? 'r' : null, text: headline })
    ])]
    if (r.hint) kids.push(h('div', { class: st === 'stale' ? 'r tiny' : 'dim tiny', text: C.txt(r.hint) }))

    /* 一行证据摘要（永远显示；红灯时这一行就是"该怎么办"的依据） */
    /* ⚠️ 时间必须转**本地时区**再显示：后端给的是 ISO(UTC)，直接 slice 会差 8 小时 ——
     *    而这一格的全部意义就是"拿两个时间比大小"，显示成 UTC 等于让人看错 8 小时。 */
    var hm = function (iso) {
      var d = new Date(String(iso || ''))
      if (!iso || isNaN(d.getTime())) return '?'
      var p = function (n) { return (n < 10 ? '0' : '') + n }
      return (d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes())
    }
    var bm = r.brainMd || {}
    var bits = []
    if (bm.mtime) bits.push('brain.md ' + hm(bm.mtime) + (bm.chars ? '（' + C.txt(bm.chars) + ' 字符 / ' + C.txt(bm.lines) + ' 行）' : ''))
    if (r.appStart) bits.push('进程 ' + hm(r.appStart) + ' 启动')
    if (r.cache && r.cache.newest) bits.push('最近大脑会话对上 ' + C.txt(r.cache.newest.covOfCurrent) + '%')
    if (bits.length) kids.push(h('div', { class: 'dim tiny', text: bits.join('　·　') }))

    /* 点开看证据 */
    var btn = h('button', { class: 'btn', text: rulesOpen ? '收起证据 ▲' : '点开看证据 ▼' })
    var det = h('div', { class: 'dim tiny' })
    append(det, rulesOpen ? [
      h('div', { text: 'brain.md：' + C.txt(String(bm.path || '?')) }),
      h('div', { text: 'mtime ' + hm(bm.mtime) + '　chars ' + C.txt(String(bm.chars || '?')) + '　lines ' + C.txt(String(bm.lines || '?')) }),
      h('div', { text: '进程启动 ' + hm(r.appStart) + (r.appStartSource ? '（来源 ' + C.txt(r.appStartSource) + '）' : '') }),
      h('div', { text: r.cache
        ? ('逐会话证据：' + hm(r.cache.at) + ' 跑的；最近会话 ' + C.txt(String((r.cache.newest || {}).session || '?')) + ' 对上 ' + C.txt(String((r.cache.newest || {}).covOfCurrent)) + '%')
        : '逐会话证据：还没跑过 `规矩版本体检.mjs`（跑一次就会落 `_crew\\规矩版本.json`，这里就有数了）' }),
      h('div', { text: '要更准：node _unattended\\规矩版本体检.mjs --top 20　（只读；6 秒；判据 ≥98% = 同一版）' })
    ] : null)
    btn.onclick = function () {
      rulesOpen = !rulesOpen
      try { localStorage.setItem('dsh.rules.open', rulesOpen ? '1' : '0') } catch (e) {}
      render()                       // 走 render 的既有路径（含滚动位置保持），别自己拼 DOM
    }
    kids.push(h('div', { class: 'row' }, [btn]))
    kids.push(det)
    return card('🧭 规矩版本（大脑跑的是不是当前这版）', kids,
      '判据：brain.md 的 mtime 必须早于桌面端进程启动时间 —— 宿主是在**加载 profile 时**一次性把 persona 读进去的，改完不重启等于没改。')
  }

  /* ── ✏️ 改规矩（★ b197 · 施工文档 §四 D7 四项）───────────────────────────────
   * 用户口径（D7）：**所有红/黄必须真的看得见，而且看板上能直接改**。四条要求：
   *   ① **红灯分两类**：**规则类**（规矩文件自己的问题）在这一页处理；**任务类**（越界/口径违规/无收据改动）在别的格。
   *   ② **改前自动备份**；③ **改后必跑体检，不过则红灯不灭**（服务端不过就整体回滚）；④ **diff 对照表**（改前→改后一行一条）。
   * ⚠️ 判据**只在服务端**（`规矩面板.mjs`），这一格只显示它的结论 —— 不许在 UI 里再写一套红绿。
   * ⚠️ 展开状态与"正在编辑哪一份"存 localStorage（render 每 60 秒全量重建）。
   */
  var ruleEditOpen = false
  try { ruleEditOpen = localStorage.getItem('dsh.rules.edit.open') === '1' } catch (e) { /* 隐私模式 */ }
  var ruleEditKey = null       // 正在编辑哪一份（null = 没在编辑）
  var ruleDraft = null         // 草稿内容
  var ruleResult = null        // 上一次保存的结果（自检 + diff）
  var ruleBusy = false
  function rulesEditBox (d) {
    try { return rulesEditBoxInner(d) } catch (e) {
      return card('✏️ 改规矩', [h('div', { class: 'dim tiny', text: '这一格渲染失败（其余照常）：' + String((e && e.message) || e) })])
    }
  }
  function ruleApi (body) {
    return fetch('/rules-action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json() })
  }
  function rulesEditBoxInner (d) {
    var r = (d && d.rulesEdit) || null
    var kids = []
    if (!r || !r.files) {
      kids.push(h('div', { class: 'dim tiny', text: '服务端还没给 rulesEdit 段（重启面板服务后就有）' }))
      return card('✏️ 改规矩（规则类红灯在这儿处理）', kids, '规则类 ≠ 任务类：这一页管"规矩文件自己"，任务类红灯在越界/口径那几格。')
    }
    kids.push(h('div', { class: 'dim tiny', text: r.note || '' }))
    r.files.forEach(function (f) {
      var dot = f.ok ? 'g' : 'r'
      var line = h('div', { class: 'tiny' }, [
        h('span', { class: 'dot ' + dot }),
        h('span', { text: f.title + '　' }),
        h('span', { class: 'dim', text: (f.chars || 0) + ' 字符 / ' + (f.rules || 0) + ' 条 / 注释 ' + (f.comments || 0) + ' 个' })
      ])
      kids.push(line)
      if (f.assert && f.assert.length) kids.push(h('div', { class: 'r tiny', text: '⚠️ ' + f.assert.join('；') }))
      kids.push(h('div', { class: 'dim tiny', text: '改了什么时候生效：' + f.effect }))
      var btn = h('button', { class: 'btn', text: ruleEditKey === f.key ? '收起编辑 ▲' : '编辑 ▼' })
      btn.onclick = function () {
        ruleResult = null
        if (ruleEditKey === f.key) { ruleEditKey = null }
        else {
          ruleEditKey = f.key
          ruleBusy = true
          ruleApi({ op: 'read', key: f.key }).then(function (x) {
            ruleBusy = false
            ruleDraft = x.ok ? x.content : null
            render()
          }).catch(function (e) { ruleBusy = false; ruleDraft = null; render() })
        }
        render()
      }
      kids.push(h('div', { class: 'row' }, [btn]))
      if (ruleEditKey === f.key) {
        if (ruleBusy) kids.push(h('div', { class: 'dim tiny', text: '读取中…' }))
        else if (ruleDraft == null) kids.push(h('div', { class: 'r tiny', text: '读取失败' }))
        else {
          var ta = h('textarea', { class: 'ta', rows: '18', spellcheck: 'false' })
          ta.value = ruleDraft
          ta.oninput = function () { ruleDraft = ta.value }
          kids.push(ta)
          var saveBtn = h('button', { class: 'btn', text: '保存（自动备份＋体检，不过就回滚）' })
          saveBtn.onclick = function () {
            if (ruleBusy) return
            ruleBusy = true
            ruleApi({ op: 'save', key: f.key, content: ta.value }).then(function (x) {
              ruleBusy = false
              ruleResult = x
              render()
            }).catch(function (e) { ruleBusy = false; ruleResult = { ok: false, error: String(e && e.message || e) }; render() })
          }
          kids.push(h('div', { class: 'row' }, [saveBtn, h('span', { class: 'dim tiny', text: '　改前自动备份；不过则整体回滚，红灯不灭' })]))
        }
      }
    })
    if (ruleResult) {
      var rr = ruleResult
      kids.push(h('div', { class: rr.ok ? 'tiny' : 'r tiny' }, [
        h('span', { class: 'dot ' + (rr.ok ? 'g' : 'r') }),
        h('span', { text: rr.ok ? (rr.msg || '已保存') : (rr.error || '没保存成功') })
      ]))
      if (rr.selfCheck && rr.selfCheck.rows) {
        rr.selfCheck.rows.forEach(function (x) {
          kids.push(h('div', { class: x.ok ? 'dim tiny' : 'r tiny', text: (x.ok ? '✅ ' : '❌ ') + x.id + '：' + x.detail }))
        })
      }
      if (rr.diff) {
        kids.push(h('div', { class: 'dim tiny', text: 'diff：+' + rr.diff.added + ' 行 / −' + rr.diff.removed + ' 行' + (rr.diff.truncated ? '（只显示前 400 行）' : '') }))
        var rows = (rr.diff.rows || []).slice(0, 60)
        if (rows.length) {
          var tbl = h('div', { class: 'tiny' })
          rows.forEach(function (x) {
            tbl.appendChild(h('div', { class: x.op === '+' ? 'tiny' : 'dim tiny', text: x.op + ' ' + String(x.ln).padStart(4, ' ') + '  ' + String(x.text).slice(0, 160) }))
          })
          kids.push(tbl)
        }
      }
    }
    return card('✏️ 改规矩（规则类红灯在这儿处理）', kids,
      '四条：① 这一页只管**规则类**红灯（任务类在越界/口径那几格）② 改前自动备份 ③ 改后必跑体检、**不过就整体回滚**（红灯不灭）④ 保存后给 diff 对照。判据只在服务端 `规矩面板.mjs`。')
  }

  function renderAll (d) {
    var providers = d.providers || []
    var crewByProject = d.crewByProject || []
    var currentProject = d.currentProject || {}
    var brainRow = d.brainRow || null
    var cm = d.crewMeta || {}

    // ★ b209：钉住的目录 ≠ 工作台根时，顶上摆一条明白话（与看板页**同一个实现** `fillPinBanner`）
    var pbSet = h('div', { class: 'pin-banner', style: { display: 'none' } })
    if (fillPinBanner(pbSet, currentProject)) body.appendChild(pbSet)
    // ★ D28：钉的项目 ≠ 本次跑的 project ⇒ 顶部 banner 说话；钉失效显式报（同一个实现 `fillRunPinBanner`）
    var pbD28 = h('div', { class: 'pin-banner', style: { display: 'none' } })
    if (fillRunPinBanner(pbD28, d)) body.appendChild(pbD28)

    // ── 表1：模型商 · 钥匙 · 额度 · 调用次数 · token 用量（厂商级）
    //   ★ b130：改成自搭头 —— **只有箭头能收放** ＋ 右上角**日期范围**（起始 / 结束）；见上面 `providerCard`。
    body.appendChild(providerCard(providers))

    // ── 表2：职位表（当前项目 · 固定 5 行 + 大脑一行）────────────────────
    var target = null
    var problem = null
    var modeText
    var realProjects = crewByProject.filter(function (p) { return p.runsDirExists })
    var nameHint = realProjects.length
      ? '本机现有项目：' + realProjects.slice(0, 8).map(function (p) { return p.project }).join(' / ') +
        (realProjects.length > 8 ? ' 等 ' + realProjects.length + ' 个' : '') +
        '（在 `_crew\\当前项目.txt` 里写它的路径即可钉住）'
      : '本机还没有任何项目（工作区下没有 _crew\\runs）。'
    if (currentProject.set) {
      target = C.matchProject(currentProject.path, crewByProject)
      modeText = '口径 = 手动钉住的项目（' + C.txt(currentProject.source) + '）：' + C.txt(currentProject.path) +
        '　·　消耗 = 职位级本项目（token 优先，其次调用次数；额度是厂商级 → 看表1）'
      if (!target) problem = '钉住的项目不在看板清单里（' + C.txt(currentProject.path) + '）。' + nameHint
    } else {
      modeText = '口径 = 没钉项目（面板没有会话上下文，所以不猜）'
      problem = '面板是独立页面、拿不到"当前会话工作区" ⇒ 只跟着 `_crew\\当前项目.txt` 那个钉子走。' + nameHint
    }

    var consByRole = C.consumptionIndex(target && !problem ? target : null)
    if (brainRow && brainRow.role && !consByRole[brainRow.role] && brainRow.consumptionText) {
      consByRole[brainRow.role] = {
        role: brainRow.role, displayText: brainRow.consumptionText, metric: 'tokens',
        metricLabel: '大脑（本项目对应会话）token 用量 · 含 cacheRead',
        detail: '会话级：与当前项目对应的会话在 cost-meter 里的分项合计（含 cacheRead），不等于纯项目成本'
      }
    }
    var rows = []
    if (brainRow) {
      rows.push({ group: { text: '会话级 · 不属于任何项目 —— 大脑（规划）', title: '大脑是 DSH 本体会话，不挂在任何项目下；状态看会话日志写入（窗口 180s）' } })
      rows.push(C.crewCells(brainRow, consByRole))
    }
    if (target && !problem) {
      var bits = []
      if (target.attempts) bits.push('回执 ' + target.attempts + ' 份')
      if (target.ledgerCalls) bits.push('账本调用 ' + target.ledgerCalls + ' 次')
      bits.push(target.lastEventSecAgo == null ? '本项目无任何记录' : '最近活动 ' + C.agoText(target.lastEventSecAgo))
      rows.push({ group: {
        text: (currentProject.set ? '★ 钉住的项目 · ' : '当前会话工作区 · ') + C.txt(target.project) + ' —— ' + bits.join(' · '),
        title: C.txt(target.path) + '\n' + C.txt(target.note)
      } })
      target.roles.forEach(function (c) { rows.push(C.crewCells(c, consByRole)) })
    } else if (problem) {
      rows.push({ group: { text: problem, title: '边界情形：刻意「不回退」去列全部项目，也不铺一片「—」。' } })
    }
    body.appendChild(card(null, [
      crewByProject.length || brainRow
        // ★ 2026-10-12（b36 · 用户拍板 A）：这列**不是"现在配的模型"**，而是**最近一次真跑用的模型**
        //   （数据端优先取回执里的 model，没新回执就退到更早一条 —— 代码注释里记着 coder-b 因此显示过
        //   10-06 的值，比它"上一次真跑"还老 3 天）。列名照实叫，免得跟 ⚙️ 里选的那个混起来。
        ? table(['职位', 'agent', '最近一次实跑用的模型', '状态', '消耗（本项目）'], rows, 4)
        : h('div', { class: 'dim tiny', text: 'board-data.json 里还没有 crewByProject —— 跑一次 看板数据.mjs' })
    ]))
    body.appendChild(h('div', { class: 'foot dim tiny', text: modeText }))

    // ── 页脚一行小字（与旧看板同一批数字）────────────────────────────────
    var lt = d.ledgerTask || {}
    var acct = d.account || {}
    var footBits = [
      '今日调用 ' + C.txt(d.ledger && d.ledger.todayCalls) + ' 次',
      '今日新增坑 ' + C.txt(d.ledger && d.ledger.todayPitfalls) + ' 条',
      '任务 ' + (lt.found ? C.txt(lt.done) + '/' + C.txt(lt.total) + ' 完成' : C.txt(lt.reason || '未设置当前项目')),
      '账号 ' + (acct.ok ? '可用' : C.txt((acct.reasons && acct.reasons[0]) || '不可用')),
      '宿主 ' + ((d.host && d.host.listening) ? '在跑' : '未监听'),
      (d.watch ? ('看护 ' + C.txt(d.watch.stateZh) + ((d.watch.state === 'running' || d.watch.state === 'stalled') && d.watch.progress && d.watch.progress.noProgressMin != null ? '（' + C.txt(d.watch.progress.noProgressMin) + ' 分钟无新文件）' : '')) : null),
      (d.context && d.context.found ? ('上下文 ' + C.txt(d.context.text) + (d.context.percent >= 70 ? ' ⚠' : '')) : null),
      (d.gate ? (d.gate.ok
        ? ('测试 ✅ ' + C.txt(d.gate.summaryText) + (d.gate.at ? '（' + String(d.gate.at).replace('T', ' ').slice(5, 16) + '）' : ''))
        : ('测试 ❌ ' + C.txt(d.gate.summaryText) + (d.gate.failures && d.gate.failures[0] ? '：' + String(d.gate.failures[0]).slice(0, 40) : ''))) : '测试 未跑'),
      cm.runningWindowMin ? '状态窗口 ' + cm.runningWindowMin + ' 分钟' : null
    ]
    body.appendChild(h('div', { class: 'foot dim tiny', text: footBits.filter(Boolean).join(' · ') }))

    // ── 🧭 规矩版本（★ 2026-10-19 b184）：改完 brain.md 没重启，是**看不出来**的失败 ──
    body.appendChild(rulesBox(d))

    // ── 🚨 口径违规（★ b197 · M6-5 · C 通道）：卡上写死的规矩，违反了到底疼不疼 ──
    body.appendChild(policyBox(d))

    // ── ✏️ 改规矩（★ b197 · D7）：规则类红灯看得见 ＋ 页面上直接改（备份/体检/回滚/diff）──
    body.appendChild(rulesEditBox(d))

    // ── 🔁 最近一次换会话（★ b91 · 用户拍板"加那两块"里的 A）──
    //   为什么要有它：换会话是**自动**的（上下文到 60% 就换，常在夜里），而它的失败方式**天生"看着成功"**
    //   （日志还打印"✓ 旧会话已停"）。2026-10-16 真跑实测就撞上过一次：旧会话被归档 ⇒ 收尾指令被宿主播掉
    //   ⇒ 新会话带着**旧断点**继续干，而当时**没有任何地方看得见**。
    //   数据来源：`d.swap`（看板数据**直读** `_crew\换会话交接.json`，不看护的节拍）⇒ 换完 ~1 分钟内就是新的。
    body.appendChild(swapBox(d))

    // ── 🧾 收据外改动（★ b88 · 新问题稿 A/D 条）：**"违反了规则也要留下信号"** ──
    //   治的病：2026-10-12 大脑绕过班组直接改了 6 个文件，`_crew\runs\` 当天 0 条
    //   ⇒ 无任务卡、无回执、无指纹、无门禁，而**看板、账本、门禁全是绿的**。
    //   判据全在 `_unattended\无收据改动.mjs`（窗口＝最近一轮收据起点；比对"实际被动过的代码 ↔ 收据覆盖"）。
    //   ⚠️ 它是**异步**的（要扫一遍项目），所以先把卡片画上、拿到数据再填 —— 不让整个看板等它。
    body.appendChild(noReceiptBox(d))

    // ── 🔴 待你处理（编排写进 <项目>\_crew\halt.json 的条目，原样列出来等人）──
    var haltCard = haltSection(d)
    if (haltCard) body.appendChild(haltCard)

    // ── 🧠 大脑建议（只看不改）★ 2026-10-23（施工文档 D18）：夹在「待你处理」与「▶ 干活」之间 ──
    //   ★ 2026-10-24（§11.2 A）：**不再收起** —— 没有建议时也显示"已攒 X / 20"，否则用户只会以为这块坏了。
    body.appendChild(advisorBox(d))

    // ── ▶ 干活（跑一轮）─────────────────────────────────────────────────
    body.appendChild(runBox(d))
    // ── ⚙️ API 额度 / 职位模型 ⇒ ★ b125 已搬去「API」页（这里**不再**装；见 `renderApi()`）
    //    ⚠️ 别再往这儿加回来：用户明确要求"不要放在看板的设置里了"。
  }

  /* ── 🔁 最近一次换会话（跟「🧾 收据外改动」并列的一块；★ b91）───────────────
   *   一眼说清四件事：**什么时候换的 · 谁换谁 · 资源交了几件 · 旧会话到底收尾了没有**。
   *   四种显示：✅ 收了尾 ／ ⚠️ 跑了但没照收尾做 ／ ⛔ 根本没发生（含"被 blocked"）／ ❓ b90 之前的记录（当时没核过）。
   *   ⚠️ 它**只读**（数据由看板数据直读交接单而来）；"没收尾要主动找你"那件事由**看护写告警**（B），不在这儿。 */
  function swapBox (d) {
    var s = d && d.swap
    if (!s) {
      return card('🔁 最近一次换会话', [h('div', { class: 'dim tiny', text: '还没有换会话的记录（`_crew\\换会话交接.json` 不存在或为空）—— 第一次自动换会话之后这里就有东西了。' })])
    }
    // ⚠️ 交接单里的 `at` 是 **UTC**（ISO）——给人看必须转**本地**，否则"下午 3 点换的"会显示成"早上 7 点"。
    var localZh = function (iso) {
      var t = new Date(iso)
      if (isNaN(t.getTime())) return String(iso || '?')
      var p = function (n) { return String(n).padStart(2, '0') }
      return t.getFullYear() + '-' + p(t.getMonth() + 1) + '-' + p(t.getDate()) + ' ' + p(t.getHours()) + ':' + p(t.getMinutes())
    }
    var when = localZh(s.at)
    var age = (s.ageMin != null) ? ('（' + (s.ageMin < 60 ? s.ageMin + ' 分钟前' : (Math.round(s.ageMin / 60 * 10) / 10) + ' 小时前') + '）') : ''
    var short = function (x) { return String(x || '?').replace(/^session-/, '').slice(0, 8) }
    var verdictLine
    if (s.hasWrap === false) {
      verdictLine = h('div', { class: 'tiny', text: '收尾：❓ b90 之前的记录（当时还没做收尾核验，所以**不知道**收没收）' })
    } else if (s.wrapOk === true) {
      verdictLine = h('div', { class: 'tiny', text: '收尾：✅ 旧会话收了尾（goal 停了／断点写了）' })
    } else if (s.wrapLevel === 'warn') {
      verdictLine = h('div', { class: 'tiny', text: '收尾：⚠️ 旧会话跑了一轮，但**没照收尾做**（goal 还 active、断点没写）⇒ 新会话可能接着旧断点' })
    } else {
      verdictLine = h('div', { class: 'tiny', text: '收尾：⛔ **没发生**（收尾指令被丢掉了）⇒ 新会话读到的是旧断点' })
    }
    var why = (s.hasWrap !== false && s.wrapOk !== true && s.wrapWhy) ? h('div', { class: 'dim tiny', text: '原因：' + String(s.wrapWhy).slice(0, 220) }) : null
    var todo = (s.hasWrap !== false && s.wrapOk !== true)
      ? h('div', { class: 'dim tiny', text: '怎么办：给新会话补一句真实进度；并查一眼那具旧会话是不是**已归档**（归档会话 DSH 会拒绝它的每一步 ⇒ 收尾必然落空）。' })
      : null
    return card('🔁 最近一次换会话' + age, [
      h('div', { class: 'tiny', text: '时间：' + when + '　' + short(s.oldSession) + ' → ' + short(s.newSession) }),
      h('div', { class: 'tiny', text: '资源：接管 ' + ((s.took && s.took.length) || 0) + ' 件' + (((s.took && s.took.length)) ? '（' + s.took.join('、') + '）' : '') + ' · 停 ' + ((s.stopped && s.stopped.length) || 0) + ' 件' }),
      verdictLine, why, todo
    ])
  }

  /* ── 🧾 收据外改动（与 🔴 待你处理 并列的一块；★ b88）─────────────────────
   *   用户口径（重构《新问题》稿 D 条）："看板固定一块「无收据改动」，最近 N 条 + 时间 + 文件路径，
   *   与「🔴 待你处理」并列，用户扫一眼即可抓到"。
   *   数据来自面板服务端 `/no-receipt.json`（它去调 `无收据改动.mjs`，判据不在这儿重写）。 */
  function noReceiptBox (d) {
    var cur = (d && d.currentProject) || {}
    var project = cur.set ? cur.path : ''
    var msg = h('div', { class: 'tiny', text: '正在核…（扫一遍项目，零 token）' })
    var list = h('div', { class: 'tiny' })
    var note = h('div', { class: 'dim tiny', text: '判据：窗口期内被动过、却没有任何一轮派活收据/指纹覆盖的**代码文件**（文档类不算 —— 大脑本来就有权直接写）。' })
    var cardEl = card('🧾 收据外改动', [msg, list, note])
    fetch('/no-receipt.json?t=' + Date.now() + (project ? '&project=' + encodeURIComponent(project) : ''), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { state: 'unknown', why: 'HTTP ' + r.status } })
      .then(function (j) {
        var c = (j && j.counts) || {}
        if (j.state === 'green') {
          msg.textContent = '✅ 0 个 —— 窗口内被动过的代码，都有收据覆盖'
          msg.style.color = ''
        } else if (j.state === 'yellow') {
          msg.textContent = '⚠️ ' + C.txt(c.unclaimedExempt) + ' 个收据外改动，**全部已豁免**（附原因）'
        } else if (j.state === 'red') {
          msg.textContent = '⛔ ' + C.txt(c.unclaimedOpen) + ' 个**没有收据的改动**' + (j.window && j.window.fromLocal ? '（窗口 ' + String(j.window.fromLocal).slice(5, 16) + ' 起）' : '')
          var fs = Array.isArray(j.files) ? j.files : []
          fs.slice(0, 8).forEach(function (f) {
            list.appendChild(h('div', { class: 'tiny', text: '⛔ ' + f.path + '　' + String(f.mtimeLocal || '').slice(5, 16) }))
          })
          if (fs.length > 8) list.appendChild(h('div', { class: 'dim tiny', text: '…（还有 ' + (fs.length - 8) + ' 个）' }))
        } else {
          msg.textContent = '— 算不出来：' + String((j && (j.why || j.error)) || '?')
        }
        if (j.state === 'red' || j.state === 'yellow') {
          note.textContent = '判据：窗口期内被动过、却没有任何一轮派活收据/指纹覆盖的**代码文件**。'
            + '要么走 `派活.mjs` 补一轮，要么写 `<项目>\\_crew\\无收据改动-豁免.json`（带原因）。'
        }
      })
      .catch(function (e) { msg.textContent = '— 取不到：' + String((e && e.message) || e) })
    return cardEl
  }

  /* ── ▶ 干活（与看板上的按钮同一条路：POST /run）──────────────────────
   *   ★ b92（2026-10-16 · 用户贴图问"这里还有用吗"）：这块按钮是真家伙（会花额度、改项目文件），
   *   但当时钉的项目是**工作台自己**、而它没有 `TASKS.md` ⇒ 按下去**只会空转、而且毫无提示**。
   *   现在点之前就把话说清：**可开工 N 条**（口径与 `编排.mjs` 同调 `台账.mjs ready`，见 `看板数据.mjs` 的 `d.work`）；
   *   没有任务单、或 0 条可开工 ⇒ 明说"会空转"，且**得再点一次**才真跑（防误点白烧额度）。 */
  function runBox (d) {
    var cur = d.currentProject || {}
    var project = cur.set ? cur.path : null
    var w = d.work || null
    var empty = Boolean(w && w.ok !== false && (w.hasTasks === false || (w.readyCount | 0) === 0))
    var box = h('section', { class: 'card' })
    var msg = h('div', { class: 'tiny', style: { marginTop: '4px' } })
    var busy = false
    function call (op) {
      busy = true
      msg.textContent = ''
      paint()
      fetch('/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: op, project: project || '' })
      }).then(function (r) { return r.json() }).then(function (j) {
        busy = false
        var tail = j.note || j.error || (op === 'status' ? (j.running ? '在跑' : '没在跑') : '完成')
        msg.textContent = (j.ok ? '✅ ' : '❌ ') + tail + (j.pid ? '（pid ' + j.pid + '）' : '')
        paint()
      }).catch(function (e) { busy = false; msg.textContent = '❌ ' + String((e && e.message) || e); paint() })
    }
    var stopArmed = false
    var startArmed = false
    function btn (label, op, danger) {
      return h('button', {
        class: 'btn' + (danger ? ' danger' : ''),
        disabled: busy,
        text: label,
        onclick: function () {
          if (op === 'stop' && !stopArmed) { stopArmed = true; msg.textContent = '⚠️ 再点一次「真的停」才会停（中途停手，已跑完的任务不会撤销）'; paint(); return }
          // 空转保护：没有任务单 / 可开工 0 条 ⇒ 先提醒，**再点一次**才真跑
          if (op === 'start' && empty && !startArmed) {
            startArmed = true
            msg.textContent = '⚠️ 现在**可开工 0 条**，跑下去只会空转（照样会占额度）。真要跑就再点一次「开始」。'
            paint(); return
          }
          stopArmed = false
          startArmed = false
          call(op)
        }
      })
    }
    /** 「点之前就知道」那一行：可开工几条 / 为什么是 0 / 为什么算不出来。 */
    function workLine () {
      if (!w) return h('div', { class: 'dim tiny', text: '（这份板数据里还没有"可开工几条"—— 刷新一次就有了）' })
      if (w.ok === false) return h('div', { class: 'tiny txt-warn', text: '⚠️ 算不出"可开工几条"：' + String(w.why || '') + '（不影响开始/停止）' })
      if (w.hasTasks === false) return h('div', { class: 'tiny txt-warn', text: '⚠️ ' + String(w.why || '这个项目没有任务单') })
      if ((w.readyCount | 0) > 0) {
        return h('div', { class: 'tiny', text: '✅ ' + w.why + (w.readyIds && w.readyIds.length ? '：' + w.readyIds.join('、') : '') })
      }
      return h('div', { class: 'tiny txt-warn', text: '⚠️ ' + String(w.why || '可开工 0 条 ⇒ 按「开始」是空转') })
    }
    function paint () {
      clear(box)
      append(box, [
        h('div', { class: 'title', text: '▶ 干活' }),
        h('div', { class: 'dim tiny', text: project ? ('项目：' + (cur.name || project)) : '⚠️ 认不出项目：在 `_crew\\当前项目.txt` 里写项目路径（或用面板地址加 `?project=…`）' }),
        h('div', { style: { marginTop: '2px' } }, [workLine()]),
        h('div', { style: { marginTop: '4px', display: 'flex', gap: '6px', flexWrap: 'wrap' } }, [
          btn(busy ? '启动中…' : (empty && startArmed ? '▶ 真的开始' : '▶ 开始（跑一轮）'), 'start'),
          btn(stopArmed ? '■ 真的停' : '■ 停', 'stop', true),
          btn('状态', 'status')
        ]),
        msg,
        h('div', { class: 'dim tiny', style: { marginTop: '4px' }, text: '点它会真跑一轮（花额度、会改项目文件）：派活 → 收活 → 门禁跑全量测试 → 有问题交审核员修 → 跑完看上面那一行「测试」。' })
      ])
    }
    paint()
    return box
  }

  /* ── ⚙️ API 额度 / 职位模型（搬自旧看板的 QuotaPanel；写操作走 /api-keys）── */
  function quotaSection () {
    var st = { open: false, view: null, busy: false, msg: null, drafts: {}, addOpen: false, tab: 'work', modelOpen: null, fetched: {}, msearch: '', mshowUnkept: false }
    var root = h('section', { class: 'card' })
    // ★ 把"内部状态"挂到 section 上 —— `isEditing()` 靠它判断"模型面板是不是开着"
    //   （开了就说明用户正在选模型，此时**不许重绘**：重建会把面板收起来、进度丢掉）。
    root.__qc = function () { return st }
    function set (patch, noPaint) { Object.assign(st, patch); if (!noPaint) paint() }
    function call (op, payload) {
      // ★ 2026-10-10：`fetchModels` / `modelKeep` / `modelBulk` / `rm` **点击瞬间也不许重绘** ——
      //   原来这里是无条件 `set({busy:true})`，而 `set` 默认就 `paint()` ⇒ **点击那一刻整块被重建**：
      //   被点的按钮被销毁 → 它本来握着焦点 → 浏览器为了"把焦点守住"调了一次视口
      //   ⇒ 用户看到的"往上弹一下"**发生在点击瞬间**，跟响应回来无关（我前两轮都改错在响应那一侧）。
      //   这两个 op 改成不重绘（忙态由按钮自身文字体现），其余 op 照旧。
      var quiet = (op === 'fetchModels' || op === 'modelKeep' || op === 'modelBulk' || op === 'rm' || op === 'keyUnblock'
        // ★ 2026-10-16：**级**模型/级档位也算"就地改"——它们只改那一格，整块重绘就是白闪 + 跳一下
        || op === 'roleLevelEffort' || (op === 'roleModel' && payload && payload.level))
      if (quiet) set({ msg: null }, true)
      else set({ busy: true, msg: null })
      return fetch('/api-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ op: op, payload: payload || {} })
      }).then(function (r) { return r.json() }).then(function (j) {
        var verb = { set: '保存钥匙', rm: '删除钥匙', priority: '调整优先级', order: '调整先试顺序', roleModel: '改职位模型', roleFallback: '改备选模型', reset: '复位切换', check: '检测', saveKey: '添加', fetchModels: '获取模型', modelKeep: '选中/取消', modelBulk: '批量选中', keyUnblock: '解除屏蔽' }[op] || op
        // ★「获取模型」要把拉回来的清单**缓存到界面状态**（否则后端回完就没了，用户看不到清单、无从剔除）
        var fetched = st.fetched
        if (op === 'fetchModels' && j.ok && Array.isArray(j.models)) {
          fetched = Object.assign({}, st.fetched)
          fetched[j.name || (payload && payload.name)] = j.models
        }
        var view = j.view || (j.providers ? j : null) || st.view
        // ★ 2026-10-10：`fetchModels` / `modelKeep` / `modelBulk` / `rm` 这四个 op **不许整块重绘** ——
        //   它们由各自的分支**就地改 DOM**（重绘会让页面先变矮再被拉回，用户实测："往上弹一下，很难受"）。
        //   ⚠️ 坑：`set()` 的默认行为就是 `paint()` —— 第一版我在这里 return 了，**它照样重绘**。
        //      所以必须显式 `set({...}, true)`（noPaint）把"改状态"和"重绘"拆开。
        //   状态照收（view 要更新，否则"模型 N 个"这些数是旧的），只是不触发 paint。
        if (op === 'fetchModels' || op === 'modelKeep' || op === 'modelBulk' || op === 'rm' || op === 'keyUnblock'
          // ★ 2026-10-16：级模型 / 级档位同样"不重绘"，由调用方**就地改那一格**（见下级行那两个 onchange）
          || op === 'roleLevelEffort' || (op === 'roleModel' && payload && payload.level)) {
          set({ busy: false, view: view, fetched: fetched, msg: j.ok ? (j.output || ('✅ 已' + verb)) : ('❌ ' + (j.error || '失败')) }, true)
          j.rendered = true          // 告诉调用方：界面已经就地更新过了，别再让它重绘
          return j
        }
        set({
          busy: false,
          view: view,
          fetched: fetched,
          drafts: (op === 'set' || op === 'saveKey') ? {} : st.drafts,
          msg: j.ok ? (op === 'list' ? null : (j.output || ('✅ 已' + verb))) : ('❌ ' + (j.error || '失败'))
        })
        return j
      }).catch(function (e) { set({ busy: false, msg: '❌ ' + String((e && e.message) || e) }) })
    }
    function paint () {
      // ★ 2026-10-16（用户报障："我每次选择分级模型后，页面都会往上跳一下"）：
      //   病根＝**整块重建丢掉滚动位置**。`paint()` 是 `clear(root)` 全量重画，中途高度变了，
      //   浏览器就把视口弹回去（服务端那条返回 `view` ⇒ 前端 `set()` 默认 `paint()`）。
      //   与 2026-10-10「点获取模型就被甩回页首」**同一个病**，那次只修了看板页的 `render()`，
      //   **管理页这块一直没接** ⇒ 现在把同一套存/恢复接到 `paint()` 上（window ＋ 每个可滚动元素）。
      //   ⚠️ 另有第二道：级模型/级档位那几个 op 走"不重绘"（见 `call()` 的 quiet 名单），
      //      两边一起才是"不跳 + 不闪"。这里保留恢复，是为了其余必须重绘的 op 也不再跳。
      var snap = captureScroll()
      try { paintInner() } finally { restoreScroll(snap) }
    }

    function paintInner () {
      clear(root)
      var rows = []
      rows.push(h('div', { class: 'bar' }, [
        h('b', { text: '⚙️ API 额度 / 职位模型' }),
        h('button', {
          class: 'btn',
          text: st.open ? '收起' : '展开',
          onclick: function () {
            // ★ 2026-10-10 修（实测踩到）：**收起整个面板时必须清掉 `modelOpen`**。
            //   否则"模型面板开着"这个标志会留在状态里 ⇒ `isEditing()` 永远为真
            //   ⇒ **自动刷新被永久冻住**（顶栏一直显示"暂缓自动刷新"，而面板根本看不见了）。
            set({ open: !st.open, modelOpen: null })
            if (st.open && !st.view) call('list')
          }
        }),
        st.busy ? h('span', { class: 'dim tiny', text: '处理中…' }) : null
      ]))
      if (!st.open) { append(root, rows); return }
      rows.push(h('div', { style: { display: 'flex', gap: '4px', margin: '4px 0 2px' } }, [
        h('button', { class: 'btn', style: { flex: '1', fontWeight: st.tab === 'work' ? '600' : '400', opacity: st.tab === 'work' ? '1' : '.6' }, text: '① 干活（职位模型 / 切换）', onclick: function () { set({ tab: 'work' }) } }),
        h('button', { class: 'btn', style: { flex: '1', fontWeight: st.tab === 'apis' ? '600' : '400', opacity: st.tab === 'apis' ? '1' : '.6' }, text: '② 管 API / 钥匙', onclick: function () { set({ tab: 'apis' }) } })
      ]))
      var v = st.view
      if (!v) { rows.push(h('div', { class: 'dim tiny', text: '读取中…' })); append(root, rows); return }
      if (st.tab === 'apis') paintApis(rows, v)
      else paintWork(rows, v)
      if (st.msg) rows.push(h('div', { class: 'dim tiny', style: { whiteSpace: 'pre-wrap', maxHeight: '160px', overflow: 'auto' }, text: st.msg }))
      append(root, rows)
    }

    /** ② 管 API / 钥匙：供应商（先试顺序 ↑↓）＋ 每把钥匙 ＋ 添加 ＋ 全局动作。 */
    function paintApis (rows, v) {
      rows.push(h('div', { class: 'dim tiny', text: '密钥存放：' + v.store.keyStore + '　' + v.store.note + '（界面只显示后 4 位；填/改直接写这个文件，不进仓库）' }))
      var cfg = v.providers.filter(function (p) { return p.configured })

      /** 钥匙来源的中文说法（**单一实现** —— 被屏蔽那行与"被屏蔽的家"那段共用）。 */
      var srcZh = function (s) {
        return !s ? '未知来源'
          : s.indexOf('env:') === 0 ? ('环境变量 ' + s.slice(4) + '（本机删不掉）')
            : s.indexOf('cred:') === 0 ? ('你原来的凭据库（' + s.slice(5) + '）')
              : s === 'file' ? '本机密钥库' : s
      }
      /** 某家当前"**没勾上**"的名单 —— **每次现读**（别在闭包里缓存，勾选后就过期了）。 */
      function unkeptNow (name) {
        var pv = ((st.view && st.view.providers) || []).filter(function (x) { return x.name === name })[0]
        // 兼容旧标记 `removed`（早期版本用的字段名）
        var a = (pv && pv.unkeptModels) || []
        var b = (pv && pv.removedModels) || []
        return a.concat(b.filter(function (x) { return a.indexOf(x) === -1 }))
      }

      /**
       * ★★ 2026-10-10（用户实测："没有 kimi-k3"，搜 `ki` 命中 0 个）——
       *   **可选清单必须是并集：接口拉回来的 ∪ 路由表里声明的**。
       *
       * 为什么：接口的 `/models` **不等于套餐能调的口径** —— 实测 `kimi-k3`
       *   ① 不在 ark 接口的 135 个里；② 但**真发推理返回 200**（能调）。
       *   而它就在路由表里。之前 chip 只从"接口清单"出，于是**你根本搜不到它、也就没法选**。
       * ⇒ 并集里带 `only` 标记：只存在于路由表的名字（接口没有它）要在界面上标出来。
       */
      function modelUniverse (name) {
        var got = ((st.fetched || {})[name] || []).slice()
        var pv = ((st.view && st.view.providers) || []).filter(function (x) { return x.name === name })[0]
        if (!pv) return got
        var seen = {}
        got.forEach(function (m) { seen[m] = 1 })
        // 路由表里"已选"的名字，接口没返回的 → 也进清单（带上标记）
        ;(pv.keptNames || []).forEach(function (m) { if (!seen[m]) { seen[m] = 1; got.push(m) } })
        // 未选的也要能搜到（否则"想选回一个接口不列的旧名字"就没有入口）
        unkeptNow(name).forEach(function (m) { if (!seen[m]) { seen[m] = 1; got.push(m) } })
        return got
      }
      /** 清单里有多少个是"接口没有、只有路由表有"的（只算已选那部分，避免噪音）。 */
      function universeNote (name) {
        var pv = ((st.view && st.view.providers) || []).filter(function (x) { return x.name === name })[0]
        if (!pv) return ''
        var got = ((st.fetched || {})[name] || [])
        var onlyN = (pv.keptNames || []).filter(function (m) { return got.indexOf(m) === -1 }).length
        return onlyN ? ('（其中 ' + onlyN + ' 个**接口不返回、只有路由表有**，标了 `仅声明`）') : ''
      }
      /** 分母：清单总数（并集），供"已选 X/Y"用。 */
      function universeTotal (name) { return modelUniverse(name).length }

      /** 搜索框的匹配函数（`*` = 通配，两种模式合一的唯一实现，chip 与后端都用它）。 */      function matchFn (q) {
        var s = String(q == null ? '' : q).trim()
        if (!s) return function () { return true }
        if (s === '*') return function () { return true }
        if (s.indexOf('*') !== -1) {
          var parts = s.split('*').filter(Boolean)
          return function (id) { return parts.every(function (x) { return String(id).indexOf(x) !== -1 }) }
        }
        return function (id) { return String(id).indexOf(s) !== -1 }
      }

      /** ★ 就地按"搜索 + 只看已选"刷新一个家的 chip —— **不重建容器**（重建会让页面抖一下）。 */
      function applyChips (name) {
        var got = modelUniverse(name)
        var box = root.querySelector('[data-models="' + name + '"]')
        if (box) {
          clear(box)
          append(box, modelChips(name, got))
          box.style.display = (got.length && st.modelOpen === name) ? 'flex' : 'none'
        }
        var n = root.querySelector('[data-mnum="' + name + '"]')
        if (n) n.textContent = got.length ? ('可选 ' + got.length + ' 个' + universeNote(name)) : ''
        var hint = root.querySelector('[data-mhint="' + name + '"]')
        if (hint) hint.textContent = got.length ? modelHint(name, got) : '点上面「获取模型 / 选择」→ 拉回接口上的清单 → 用搜索框缩小范围、点「全选匹配」批量勾上'
        // 计数也从权威状态重读（批量操作后要跟上）
        var pv = ((st.view && st.view.providers) || []).filter(function (x) { return x.name === name })[0]
        var c = root.querySelector('[data-mcount="' + name + '"]')
        if (c && pv) {
          c.setAttribute('data-mkept', String(pv.models || 0))
          c.setAttribute('data-mtotal', String(universeTotal(name) || pv.models || 0))
          c.textContent = '已选 ' + (pv.models || 0) + '/' + (universeTotal(name) || pv.models || 0) + ' 个模型'
        }
      }

      /** 搜索框是**共享**的 ⇒ 改一次要刷新所有已经拉过清单的家。 */
      function syncAllChips () { cfg.forEach(function (x) { if ((st.fetched || {})[x.name]) applyChips(x.name) }) }

      /** 一组模型 chip（抽出成函数：初始渲染与**就地更新**共用同一份，避免两处长得不一样）。
       *  ★ opt-in 口径（用户要求）：`－` = 已选，`✕`/删除线 = 未选；**默认全不选**。 */
      function modelChips (name, list) {
        var unkept = unkeptNow(name)
        var hit = matchFn(st.msearch)
        // ★ 2026-10-10 修（用户实测："看板里 ark 没有 kimi-k3，但 API 里确实有"）：
        //   原来"默认只列已选"会把**未选的也藏起来** ⇒ 你**搜了也看不到自己没勾的**。
        //   搜索的意义就是"找出来好勾上"，所以：**一旦有搜索词，就自动把未选的也铺出来**。
        var revealUnkept = st.mshowUnkept || String(st.msearch || '').trim() !== ''
        var avail = (list || []).filter(function (id) { return revealUnkept || unkept.indexOf(id) === -1 })
        var shown = avail.filter(hit)
        // 接口不返回、只有路由表有的（例：`kimi-k3`）—— 标出来，让你知道它的可信度不同
        var gotList = (st.fetched && st.fetched[name]) || []
        var hasFetched = gotList.length > 0
        return shown.map(function (m) {
          var off = unkept.indexOf(m) !== -1
          var only = hasFetched && gotList.indexOf(m) === -1
          return h('button', {
            class: 'btn',
            'data-chip': m,
            // 初始状态必须写进 DOM —— 点击方向**只信这个属性**（见下）
            'data-off': off ? '1' : '0',
            title: (off ? '未选 —— 点一下选中' : '已选 —— 点一下取消') +
              (only ? '　·　⚑ 仅声明：接口的 /models 里没有它，但**实测能调用**（例 kimi-k3）。要确认就真发一次推理。' : '') +
              '（搜 `' + m + '` 能精确过滤到这个）',
            style: { fontSize: '11px', padding: '1px 5px', opacity: off ? '.45' : '1', textDecoration: off ? 'line-through' : 'none' },
            text: (off ? '✕ ' : '－ ') + m + (only ? ' ⚑' : ''),
            onclick: function () {
              // ⚠️ 方向**必须读 DOM 当前值**，不能读闭包里的 `off`：
              //   批量操作（全选匹配/全不选）之后界面状态会变，而闭包里的 `off` 是渲染那一刻的旧值
              //   ⇒ 会出现"点未选的却发出 keep:false"（实测踩到）。`data-off` 才是一直同步的那个。
              toggleChip(this, name, m, this.getAttribute('data-off') === '1')
            }
          })
        })
      }

      /** 就地切换一个 chip（**不重绘**）+ 就地更新计数。
       *  @param toKeep 目标状态：true = 勾上。调用方传的是"点完之后应该变成什么"。 */
      function toggleChip (el, name, m, toKeep) {
        // 注意语义：`data-off === '1'` 表示"当前未选"，点它就是要**选中** ⇒ toKeep=true。
        // 所以调用方传 `data-off === '1'`，这里不再做取反 —— 别在两处各取反一次（会互相抵消）。
        el.setAttribute('data-off', toKeep ? '0' : '1')
        el.textContent = (toKeep ? '－ ' : '✕ ') + m
        el.title = (toKeep ? '已选 —— 点一下取消' : '未选 —— 点一下选中')
        el.style.opacity = toKeep ? '1' : '.45'
        el.style.textDecoration = toKeep ? 'none' : 'line-through'
        bumpCount(name, toKeep ? 1 : -1)
        call('modelKeep', { name: name, model: m, keep: toKeep })
      }

      /** 就地更新「已选 X/Y」计数（带锚点，不重绘）。 */
      function bumpCount (name, delta) {
        var el = root.querySelector('[data-mcount="' + name + '"]')
        if (!el) return
        var kept = Number(el.getAttribute('data-mkept') || 0) + delta
        if (kept < 0) kept = 0
        var total = Number(el.getAttribute('data-mtotal') || 0)
        if (kept > total) kept = total
        el.setAttribute('data-mkept', String(kept))
        el.textContent = '已选 ' + kept + '/' + total + ' 个模型'
      }

      /**
       * ★ 解除屏蔽（用户实测"删了还在"之后必须有的回头路）—— 同样**就地更新，不重绘**。
       */
      function afterUnblock (btnEl, name, label) {
        btnEl.disabled = true
        var row = root.querySelector('[data-krow="' + name + '|' + label + '"]')
        var mark = function (txt) { if (row) { clear(row); append(row, h('span', { class: 'dim tiny', text: txt })) } }
        mark('（正在解除 ' + label + ' …）')
        return call('keyUnblock', { provider: name, label: label }).then(function (j) {
          if (!j || j.ok === false) { mark('❌ 解除失败：' + String((j && j.error) || '未知')); return j }
          mark('✅ 已解除屏蔽「' + label + '」' + String(j.output || '').replace(/^已\*\*解除屏蔽\*\*「[^」]*」/, ''))
          // 本地也把 blocked 标记摘掉，别让下次重建又显示成屏蔽态
          try {
            var provs = (st.view && st.view.providers) || []
            provs.forEach(function (pv) {
              if (pv.name !== name) return
              ;(pv.keys || []).forEach(function (k) { if (k.label === label) { k.blocked = false; k.blockedFrom = null } })
            })
          } catch (e) {}
          return j
        })
      }

      /** 拉取回来后更新清单（内部就是 `applyChips` —— 同一份实现，别写两遍）。 */
      function updateModelList (name) { applyChips(name) }

      /**
       * ★ 删一把钥匙 —— **就地更新，绝不重绘**（用户实测："点删除没用，而且页面会往上滚"）。
       *   三重保障：
       *     ① 先把那一行就地标成"已删"（**立刻可见**，不依赖任何请求回来）——
       *        原来它等 `rm` 成功再整块重绘，重绘那一刻按钮被销毁 ⇒ 页面弹 + 看着像没反应；
       *     ② 成功后**把已删的钥匙从本地视图里摘掉**（`st.view` 的 `p.keys`）——
       *        这样"这家还有几把钥匙"以及以后任何一次重建都**不会把删掉的又显示出来**；
       *     ③ 不调 `list` 重刷（那会重绘）。所以全程 0 次重绘。
       */
      function afterRm (btnEl, name, label) {
        btnEl.disabled = true
        var row = root.querySelector('[data-krow="' + name + '|' + label + '"]')
        var mark = function (txt) { if (row) { clear(row); append(row, h('span', { class: 'dim tiny', text: txt })) } }
        mark('（正在删 ' + label + ' …）')
        return call('rm', { provider: name, label: label }).then(function (j) {
          if (!j || j.ok === false) { mark('❌ 删除失败：' + String((j && j.error) || '未知')); return j }
          mark('✅ 已删「' + label + '」（这家没钥匙了就点「保存」重新粘一把）')
          // ② 本地也摘掉，别让下次重建把它显示回来
          try {
            var provs = (st.view && st.view.providers) || []
            provs.forEach(function (pv) {
              if (pv.name === name && Array.isArray(pv.keys)) pv.keys = pv.keys.filter(function (k) { return k.label !== label })
            })
          } catch (e) {}
          return j
        })
      }

      /** 提示行文案（把"默认全不选 / 搜了会自动铺出未选的 / 怎么批量"说清楚）。 */
      function modelHint (name, got) {
        var unkept = unkeptNow(name).length
        var searching = String(st.msearch || '').trim() !== ''
        var s = '**默认全不选**：先用搜索框筛（支持 `*`，例 `glm*flash`），再点「全选匹配」批量勾上；单个点一下 = 选中/取消。'
        s += searching ? '　·　搜索时**未选的也会铺出来**（`✕` 开头那些就是还没勾的）。' : '　·　只看已选；**搜一下**就会把没勾的也带出来，或点「显示全部」。'
        if ((got || []).length && searching) {
          var hitN = (got || []).filter(matchFn(st.msearch)).length
          s = '搜 `' + st.msearch + '` 命中 ' + hitN + ' 个。' + s
        }
        return s
      }

      function move (from, to) {
        var names = cfg.map(function (x) { return x.name })
        if (to < 0 || to >= names.length) return
        var t = names[from]; names[from] = names[to]; names[to] = t
        call('order', { order: names })
      }

      /** 「清空搜索」按钮（放在 `cfg` 之后定义 —— 它的 onclick 闭包用到 `cfg`）。 */
      var msearchClearBtn = h('button', {
        class: 'btn', text: '×', title: '清空搜索',
        onclick: function () {
          st.msearch = ''
          ;(root.querySelectorAll('input') || []).forEach(function (el) {
            var ph = el.attrs ? (el.attrs.placeholder || '') : (el.placeholder || '')
            if (/搜模型/.test(ph)) el.value = ''
          })
          syncAllChips()
        }
      })

      cfg.forEach(function (p, pi) {
        rows.push(h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '6px', flexWrap: 'wrap' } }, [
          h('span', { class: 'dim tiny', text: String(pi + 1) + '.' }),
          h('b', { text: p.name }),
          (p.alias && p.alias[0] && p.alias[0] !== p.name) ? h('span', { class: 'dim tiny', text: '（档案里叫 ' + p.alias[0] + '）' }) : null,
          h('span', { class: 'dim tiny', text: p.baseURL ? '· ' + String(p.baseURL).replace(/^https?:\/\//, '').slice(0, 42) : '· 没地址（无法探测）' }),
          cfg.length > 1 ? h('span', { style: { display: 'flex', gap: '3px', marginLeft: '4px' } }, [
            h('span', { class: 'dim tiny', text: '先试顺序' }),
            h('button', { class: 'btn', title: '让它更优先（轮不到上一家时才用它）', disabled: pi === 0, text: '↑', onclick: function () { move(pi, pi - 1) } }),
            h('button', { class: 'btn', title: '让它更靠后', disabled: pi === cfg.length - 1, text: '↓', onclick: function () { move(pi, pi + 1) } })
          ]) : null
        ]))
        // ★ 2026-10-10（用户口径，照 DSH 桌面端那个模式）：**「获取模型」和「剔除」分开** ——
        //   先把接口上的清单拉下来看，再逐个剔掉不要的。为什么必须分开：
        //   以前是"自动抓、抓完全存、只在 models 为空时抓"，于是 ① 用户没法主动拉；
        //   ② 拉进来几十个（含套餐根本不提供的、以及别的 API 族的，选了必废）；③ **没有剔除手段**。
        //   剔除 = 在路由表那条模型上打 `removed: true`（**不删**）——删了下次拉取又回来。
        // ★ 2026-10-10（用户口径 · **改成 opt-in**）："有的 api 列表模型太多了，实在没办法一个一个剔除，
        //   改成默认全部剔除、自己手动选需要的 + 加搜索框快速选"。
        //   所以：拉回来的清单**默认全不选**；用搜索框缩小范围 → 「全选匹配」批量勾上。
        //   ⚠️ 这一段里**所有交互都就地改 DOM，一次重绘都不许有** —— 重绘会让页面"弹"一下（用户实测）。
        var unkeptN = unkeptNow(p.name).length
        // ★ 分母用**并集总数**（接口清单 ∪ 路由表声明）—— 否则 `kimi-k3` 这种"接口不列但能调"的
        //   会既不在分子也不在分母，用户根本不知道存在。
        var total = universeTotal(p.name) || p.models || 0
        var mOpen = st.modelOpen === p.name
        rows.push(h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', margin: '1px 0 0 14px', flexWrap: 'wrap' } }, [
          h('span', { class: 'dim tiny', 'data-mcount': p.name, 'data-mkept': String(p.models || 0), 'data-mtotal': String(total), text: '已选 ' + (p.models || 0) + '/' + total + ' 个模型' }),
          h('button', {
            class: 'btn',
            title: '从这个家的接口拉取模型清单（零 token —— 就是 GET {网址}/models）',
            text: mOpen ? '收起' : '获取模型 / 选择',
            onclick: function () {
              // ★ 这个 onclick 里一次重绘都不许有（重绘 ⇒ 被点的按钮被销毁 ⇒ 焦点丢失 ⇒ 视口弹）
              var nowOpen = st.modelOpen !== p.name
              st.modelOpen = nowOpen ? p.name : null
              this.textContent = nowOpen ? '收起' : '获取模型 / 选择'
              var box = root.querySelector('[data-models="' + p.name + '"]')
              var bar = root.querySelector('[data-mbar="' + p.name + '"]')
              var hint = root.querySelector('[data-mhint="' + p.name + '"]')
              var gotN = modelUniverse(p.name).length
              if (bar) bar.style.display = nowOpen ? 'flex' : 'none'
              if (hint) hint.style.display = nowOpen ? '' : 'none'
              if (box) box.style.display = (nowOpen && gotN) ? 'flex' : 'none'
              if (!nowOpen) return
              // ★ 只认**接口拉回来的**那份决定要不要去拉（不能用并集判，否则永远不拉）
              if (((st.fetched || {})[p.name] || []).length) { updateModelList(p.name); return }
              call('fetchModels', { name: p.name }).then(function (j) {
                if (st.modelOpen !== p.name) return
                if (j && j.ok) updateModelList(p.name)
              })
            }
          }),
          h('span', { class: 'dim tiny', 'data-mnum': p.name, text: (st.fetched && st.fetched[p.name]) ? ('可选 ' + universeTotal(p.name) + ' 个' + universeNote(p.name)) : '' })
        ]))
        // 工具条：搜索框 + 批量 + 显示全部（**无条件渲染**，只用 display 控制显隐）
        rows.push(h('div', {
          'data-mbar': p.name,
          style: { display: mOpen ? 'flex' : 'none', alignItems: 'center', gap: '5px', margin: '3px 0 0 14px', flexWrap: 'wrap' }
        }, [
          h('input', {
            placeholder: '搜模型（子串即可；支持 * 通配，例 glm*flash）',
            value: st.msearch,
            style: { flex: '1', minWidth: '150px', font: 'inherit', fontSize: '12px', padding: '1px 5px' },
            oninput: function (e) {
              st.msearch = e.target.value
              // 就地刷新**所有**家的 chip：共享一个搜索框，所见即所筛（不重绘）
              syncAllChips()
            }
          }),
          msearchClearBtn,
          h('button', {
            class: 'btn', text: '全选匹配', title: '把"当前列表里（= 符合搜索）"的模型一次全勾上',
            onclick: function () { call('modelBulk', { name: p.name, match: st.msearch, keep: true }).then(function () { applyChips(p.name) }) }
          }),
          h('button', {
            class: 'btn', text: '取消匹配', title: '把"当前列表里"的模型一次全取消',
            onclick: function () { call('modelBulk', { name: p.name, match: st.msearch, keep: false }).then(function () { applyChips(p.name) }) }
          }),
          h('button', { class: 'btn', text: '全选', title: '不分搜索，这家全部勾上', onclick: function () { call('modelBulk', { name: p.name, match: '', keep: true }).then(function () { applyChips(p.name) }) } }),
          h('button', { class: 'btn', text: '全不选', title: '不分搜索，这家全部取消', onclick: function () { call('modelBulk', { name: p.name, match: '', keep: false }).then(function () { applyChips(p.name) }) } }),
          h('button', {
            class: 'btn',
            text: st.mshowUnkept ? '只看已选' : '显示全部',
            title: '默认只列"已选"的，免得清单太长；点这个把所有未选的也铺出来。⚠️ 一搜索就会自动铺出来（否则你搜不到自己没勾的）',
            onclick: function () {
              st.mshowUnkept = !st.mshowUnkept
              this.textContent = st.mshowUnkept ? '只看已选' : '显示全部'
              syncAllChips()
            }
          })
        ]))
        // ★ 初始渲染也用**并集**（接口清单 ∪ 路由表声明）—— 保证 `kimi-k3` 这类一开始就在列表里
        var uni = modelUniverse(p.name)
        var got0 = uni.length ? uni : null
        rows.push(h('div', { class: 'dim tiny', style: { marginLeft: '14px', display: mOpen ? '' : 'none' }, 'data-mhint': p.name, text: got0 ? modelHint(p.name, got0) : '点上面「获取模型 / 选择」→ 拉回接口上的清单 → 用搜索框缩小范围、点「全选匹配」批量勾上' }))
        rows.push(h('div', {
          'data-models': p.name,
          style: { display: (mOpen && got0) ? 'flex' : 'none', flexWrap: 'wrap', gap: '3px', margin: '2px 0 0 14px', maxHeight: '180px', overflow: 'auto' }
        }, got0 ? modelChips(p.name, got0) : []))
        p.keys.forEach(function (k, i) {
          // ★ 2026-10-10（用户实测："删了还在"）：被**屏蔽**的钥匙要如实显示"已屏蔽 + 挡住了哪一层"，
          //   并给「解除」按钮 —— 否则用户没有回头路，也不知道为什么它删不掉。
          if (k.blocked) {
            rows.push(h('div', { 'data-krow': p.name + '|' + k.label, style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } }, [
              h('span', { class: 'dim tiny', text: '🚫' }),
              h('span', { style: { minWidth: '72px' }, text: k.label }),
              h('span', { class: 'dim tiny', text: '已屏蔽（不再用这把钥匙）' + (k.blockedFrom ? '　·　挡住了：' + srcZh(k.blockedFrom) : '　·　（这一层现在也没钥匙）') }),
              h('button', {
                class: 'btn',
                'data-kunblock': p.name + '|' + k.label,
                title: '解除屏蔽，让这把钥匙重新生效',
                text: '解除',
                onclick: function () { afterUnblock(this, p.name, k.label) }
              })
            ]))
            return
          }
          rows.push(h('div', { 'data-krow': p.name + '|' + k.label, style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px' } }, [
            h('span', { class: 'dim tiny', text: String(k.priority) }),
            h('span', { style: { minWidth: '72px' }, text: k.label }),
            h('code', { text: k.mask || '（缺）' }),
            h('span', { class: 'dim tiny', text: (function (src) {
              if (!src) return '来源 —'
              if (src === 'file') return '存在密钥库'
              if (src.indexOf('env:') === 0) return '来自环境变量'
              if (src.indexOf('cred:') === 0) return '来自你原来的凭据'
              return src
            })(k.source) }),
            h('span', { class: 'dim tiny', title: k.checkedAt || '', text: k.verdictZh }),
            p.keys.length > 1 ? h('button', { class: 'btn', text: '↑', onclick: function () { var o = p.keys.map(function (x) { return x.label }); if (i > 0) { var t = o[i - 1]; o[i - 1] = o[i]; o[i] = t; call('priority', { provider: p.name, order: o }) } } }) : null,
            p.keys.length > 1 ? h('button', { class: 'btn', text: '↓', onclick: function () { var o = p.keys.map(function (x) { return x.label }); if (i < o.length - 1) { var t = o[i + 1]; o[i + 1] = o[i]; o[i] = t; call('priority', { provider: p.name, order: o }) } } }) : null,
            // ★「删」必须就地更新（用户实测："点删除没用，而且页面会往上滚"）——
            //   原来它走 `call('rm')` = 普通重绘路径 ⇒ ① 页面弹一下；② 重绘后看着像没删掉。见 `afterRm()`。
            h('button', {
              class: 'btn',
              'data-kdel': p.name + '|' + k.label,
              text: '删',
              onclick: function () { afterRm(this, p.name, k.label) }
            })
          ]))
        })
        var dk = 'd_' + p.name
        rows.push(h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', marginTop: '3px' } }, [
          h('input', {
            type: 'password',
            placeholder: '粘贴 ' + p.name + ' 的密钥（只显示一次，存下就只剩后 4 位）',
            value: st.drafts[dk] || '',
            style: { flex: '1', minWidth: '140px', font: 'inherit', fontSize: '12px', padding: '2px 6px' },
            oninput: function (e) { st.drafts[dk] = e.target.value; var b = root.querySelector('[data-save="' + dk + '"]'); if (b) b.disabled = !(e.target.value && e.target.value.length >= 8) }
          }),
          h('button', {
            class: 'btn',
            'data-save': dk,
            disabled: !(st.drafts[dk] && st.drafts[dk].length >= 8),
            text: '保存',
            onclick: function () { call('set', { provider: p.name, label: '主号' + (p.keys.length ? '-' + (p.keys.length + 1) : ''), key: st.drafts[dk] }) }
          }),
          h('button', { class: 'btn', text: '检测这家', onclick: function () { call('check', { provider: p.name }) } })
        ]))
      })
      var notCfg = (v.providers || []).filter(function (p) { return !p.configured })
      if (!cfg.length) rows.push(h('div', { class: 'dim tiny', text: '这里只列你配过钥匙的厂商（现在还没有）—— 点下面「＋ 添加」填一家就行。' }))
      // ★ 2026-10-12（b36 · 用户口径："我已经删了，就应该不存在了，而不是还能显示"）：
      //   被「删」的家**整家从面板消失**（服务端就不再带出来）⇒ 这里只可能剩下"真没钥匙"的家。
      //   ⚠️ b35 我在这里加的"被屏蔽的家 ＋ 解除屏蔽"那一段**已删掉**（正是用户不要的那个显示）；
      //      回头路改成**重新添加同名钥匙**（`额度钥匙.mjs set` 会顺手解除这个槽位的屏蔽）。
      var pstate = v.providerState || {}
      if (notCfg.length) rows.push(h('div', { class: 'dim tiny', text: '另有 ' + notCfg.length + ' 家（' + notCfg.map(function (p) { return p.name }).join('、') + '）不在上面的钥匙管理里：' +
        notCfg.map(function (p) {
          var s = pstate[p.name]
          if (s === 'nokey') return p.name + ' = 本机解析不到钥匙 ⇒ 要用它就在下面「＋ 添加」里填同名 + 钥匙'
          return p.name + ' = 在用你原来的凭据跑'
        }).join('；') }))

      // 添加（名字 + 网址 + 密钥）
      rows.push(h('div', { style: { marginTop: '8px' } }, [
        h('button', { class: 'btn', text: st.addOpen ? '× 收起' : '＋ 添加（填名字 + 网址 + 密钥）', onclick: function () { set({ addOpen: !st.addOpen }) } })
      ]))
      if (st.addOpen) {
        rows.push(h('div', { class: 'dim tiny', text: '三个框填完点「添加」就行。已有的厂商也能填同名（会用你这次填的钥匙）；密钥只存本机，界面只显示后 4 位。' }))
        // ★ 2026-10-10 修（用户实测："我点不了添加"）：
        //   原来这里的三个输入框只写 `st.drafts`，**既不重绘也不改 DOM**，而「添加」按钮的
        //   `disabled` 是渲染那一刻算死的静态值 ⇒ 展开面板时 drafts 为空 → 算出 disabled=true
        //   → **之后不管填多少字，这个属性永不重算** ⇒ 按钮全程点不动（用户看到的就是"没反应"）。
        //   修法照抄本文件下面「每把钥匙的保存按钮」那处**已验证的写法**：直接改 DOM，不整块重绘
        //   （重绘会让人正在打字的光标跳掉）。
        //   ⚠️ 禁用条件**只写一处**（就是这个函数）——原来它在按钮上写了一遍，正是"两处不同步"的病根。
        var addReady = function () { return !!(st.drafts._np_name && st.drafts._np_key && st.drafts._np_key.length >= 8) }
        var syncAddBtn = function () { var b = root.querySelector('[data-add="1"]'); if (b) b.disabled = !addReady() }
        ;[['_np_name', '① 名字：随便起个短的（已有的写同名，例：ark）'], ['_np_url', '② 网址：这家的 API 地址（已有的可留空）']].forEach(function (pair) {
          rows.push(h('input', {
            placeholder: pair[1],
            value: st.drafts[pair[0]] || '',
            style: { font: 'inherit', fontSize: '12px', padding: '2px 6px', width: '100%', boxSizing: 'border-box' },
            oninput: function (e) { st.drafts[pair[0]] = e.target.value; syncAddBtn() }
          }))
        })
        rows.push(h('input', {
          type: 'password',
          placeholder: '③ 粘贴密钥（只显示一次，存下就只剩后 4 位）',
          value: st.drafts._np_key || '',
          style: { font: 'inherit', fontSize: '12px', padding: '2px 6px', width: '100%', boxSizing: 'border-box' },
          oninput: function (e) { st.drafts._np_key = e.target.value; syncAddBtn() }
        }))
        rows.push(h('button', {
          class: 'btn',
          'data-add': '1',
          disabled: !addReady(),
          text: '添加',
          onclick: function () { call('saveKey', { name: st.drafts._np_name, baseURL: st.drafts._np_url, key: st.drafts._np_key }) }
        }))
      }

      // 全局动作
      var fo = v.failover || {}
      var switched = Object.keys(fo.roles || {}).filter(function (r) { return fo.roles[r] && fo.roles[r].from })
      rows.push(h('div', { style: { display: 'flex', gap: '6px', marginTop: '8px' } }, [
        h('button', { class: 'btn', text: '检测全部', onclick: function () { call('check', {}) } }),
        h('button', { class: 'btn', text: '复位切换记录', onclick: function () { call('reset', {}) } })
      ]))
      rows.push(h('div', { class: 'dim tiny', text: switched.length
        ? '已切换过的角色：' + switched.map(function (r) { return r + '（从 ' + fo.roles[r].from + ' 切走）' }).join(' · ')
        : '还没有角色被切换过（额度够用时不会切）' }))
      rows.push(h('div', { class: 'dim tiny', text: '规则：只有「没额度 / 钥匙无效 / 被限流」才会自动切下一家；超时、能力类失败绝不切（换家也解决不了）。' }))
    }

    /* ── 「分级」那一行（L1–L4 的模型 ＋ 档位）──
     * ★ 2026-10-16 用户报障："每次选择分级模型后，页面都会往上跳一下"。
     *   根因：这一格的 onchange 走 `roleModel` ⇒ 服务端回 `view` ⇒ `set()` 默认 `paint()`（`clear(root)` 全量重画）
     *   ⇒ 重建期间高度变了、视口被顶回去（与 2026-10-10「点获取模型就被甩回页首」同一个病，那次只修了看板页）。
     *   治法（两道一起，缺一不可）：
     *     ① `call()` 把 **级模型 / 级档位** 加进 quiet 名单 ⇒ 不再整块重绘；
     *     ② 响应回来后**只重建这一行**（`refreshLevelRow` 复用同一个 `buildLevelRow`），
     *        并顺手把 `st.view` 换成新的（`call()` 已经做了）⇒ 下次全量重画时的数也是新的。
     *   ⚠️ 别改成"成功后直接 `paint()`" —— 那就是这次要修的那个跳。
     */
    var lvRowRefs = {}
    /** 级下拉的标签（与主下拉同一口径：有来源就标来源）。 */
    function lvOptLabel (x) {
      var base = x.label || x.value
      if (x.providerName) base = base + ' · ' + x.providerName
      return base
    }
    /** 造"分级"那一行（没有 levels 数据就返回 null）。**唯一实现** —— 全量与就地刷新都用它。 */
    function buildLevelRow (r, manual, mqT) {
      if (!r.levels || !r.levels.length) return null
      var lvRow = h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', marginTop: '2px', flexWrap: 'wrap', paddingLeft: '70px' } }, [
        h('span', { class: 'dim tiny', text: '分级' })
      ])
      lvRow.__lvCtx = { manual: manual, mqT: mqT }
      r.levels.forEach(function (L) {
        var curL = L.model || ''
        var lvOpts = (r.levelOptions || []).slice()
        if (curL && !lvOpts.some(function (x) { return x.value === curL })) lvOpts.unshift({ label: curL, value: curL, stale: true, why: 'unknown-provider' })
        var lvTitle = '任务分级 ' + L.level + (L.shape && L.shape['一句话'] ? '：' + L.shape['一句话'] : '')
          + '\n· 参考规模 ' + (L.shape && L.shape.steps ? L.shape.steps : '—') + ' 步（**不是限额**：只用来估这张卡多大）'
          + ' · 门禁 ' + (L.shape && L.shape.gate ? L.shape.gate : '—')
          + ' · 卡片形态 ' + (L.shape && L.shape.shape ? L.shape.shape : '—')
          + '\n· 现在写在哪：' + L.from + (L.effort ? '（档位 ' + L.effort + '）' : '')
          + (L.why ? '\n⚠️ ' + L.why : '')
        lvRow.appendChild(h('span', { class: 'dim tiny', text: L.level, title: lvTitle }))
        lvRow.appendChild(h('select', {
          value: curL,
          title: lvTitle,
          style: { font: 'inherit', fontSize: '12px', maxWidth: '190px', borderColor: L.mustSet ? '#b04a3a' : null },
          onchange: function (e) {
            var val = e.target.value
            if (!val) return
            var force = Boolean(st.drafts._forceLv && st.drafts._forceLv === L.level + ':' + val)
            call('roleModel', { role: r.role, model: val, level: L.level, manual: Boolean(manual && val === mqT), force: force, provider: (r.providers && r.providers[0] && r.providers[0].provider) || null })
              .then(function (jj) {
                if (jj && jj.ok === false) { st.drafts._forceLv = L.level + ':' + val; return }
                delete st.drafts._forceLv
                refreshLevelRow(r.role, jj && jj.view)        // ★ 就地换这一行（不重绘 ⇒ 不跳）
              })
          }
        }, [h('option', { value: '', text: L.mustSet ? '（必填 · 现在没配）' : '（空 = 不改这一级）' })].concat(lvOpts.map(function (x) {
          return h('option', { value: x.value, disabled: !!x.disabled, title: x.note ? x.note.long : null, text: lvOptLabel(x) })
        }))))
        if (L.mustSet) lvRow.appendChild(h('span', { class: 'dim tiny', style: { color: '#b04a3a' }, title: L.why || '', text: '⚠️必填' }))
        // ── 档位（2026-10-16 §3.5：**三档抽象**，省/中/狠；落地按 DSH 的真实规则算支持集合）──
        var ch = L.effortChoices || { known: false, values: [], why: '' }
        var tierMap = L.effortTierMap || {}
        var anyTier = Object.keys(tierMap).some(function (t) { return tierMap[t] && tierMap[t].resolved })
        var effTx = !ch.values || !ch.values.length
          ? (ch.known === false ? '⚠️查不到它的档位' : '这家不认档位')
          : (L.effortTier && tierMap[L.effortTier] ? (tierMap[L.effortTier].resolved ? ((tierMap[L.effortTier].status === 'degraded' ? '⚠️落成 ' : '→') + tierMap[L.effortTier].resolved) : '⚠️落空') : '未设')
          // ★ 2026-10-16：**未核实**要明说（不拦、也不装精确）—— 用户加的新 API 默认就落在这里
        var effUnverified = ch.assumed ? '　·　未核实（按默认五档）' : ''
        var effTitle = '思考档位（三档抽象）：\n· 省 → ' + ((tierMap['省'] || {}).resolved || '（不支持）')
          + '\n· 中 → ' + ((tierMap['中'] || {}).resolved || '（不支持）')
          + '\n· 狠 → ' + ((tierMap['狠'] || {}).resolved || '（不支持）')
          + '\n落地规则：标准五档（off/minimal/low/medium/high）默认就有，**只有 xhigh/max 要显式声明**；'
          + '按这里的候选取第一个支持的，取不到首选就**如实降级**。'
          + (ch.values && ch.values.length ? '\n它支持：' + ch.values.join(' / ') : '')
          + (ch.why ? '\n⚠️ ' + ch.why : '')
        lvRow.appendChild(h('select', {
          value: L.effortTier || '',
          disabled: !(ch.values && ch.values.length),
          title: effTitle,
          style: { font: 'inherit', fontSize: '12px', maxWidth: '120px', borderColor: (L.effortTier && tierMap[L.effortTier] && !tierMap[L.effortTier].resolved) ? '#b04a3a' : null },
          onchange: function (e) {
            var t = e.target.value
            if (!t) return
            call('roleLevelEffort', { role: r.role, level: L.level, effortTier: t })
              .then(function (jj) { if (jj && jj.ok !== false) refreshLevelRow(r.role, jj && jj.view) })   // ★ 就地换（不跳）
          }
        }, [h('option', { value: '', text: anyTier ? '档位：—' : '档位：（不适用）' })].concat((L.effortTiers || ['省', '中', '狠']).map(function (t) {
          var m2 = tierMap[t] || {}
          return h('option', { value: t, disabled: !m2.resolved, title: m2.why || '', text: t + (m2.resolved ? (' (' + m2.resolved + ')') : '（不支持）') })
        }))))
        lvRow.appendChild(h('span', { class: 'dim tiny', title: effTitle, text: effTx + effUnverified }))
      })
      return lvRow
    }
    /** 用新数据**只替换那一行**（不 `paint()` ⇒ 不跳、不闪）。找不到就什么都不做（下次全量重画自然会对）。 */
    function refreshLevelRow (roleName, view) {
      var old = lvRowRefs[roleName]
      if (!old || !old.parentNode || !view || !view.roles) return
      var rr = view.roles.filter(function (x) { return x.role === roleName })[0]
      if (!rr) return
      var ctx = old.__lvCtx || {}
      var fresh = buildLevelRow(rr, ctx.manual, ctx.mqT)
      if (!fresh) return
      old.parentNode.replaceChild(fresh, old)
      lvRowRefs[roleName] = fresh
    }

    /** ① 干活：职位模型（主 / 备选）＋ 失败切换链。 */
    function paintWork (rows, v) {
      if (!(v.roles && v.roles.length)) { rows.push(h('div', { class: 'dim tiny', text: '没有取到职位清单（view.roles 为空）' })); return }
      rows.push(h('div', { class: 'dim tiny', style: { marginTop: '10px', borderTop: '.5px solid var(--line)', paddingTop: '6px' },
        text: '职位模型（模型定了就只换 API：额度用完 → 按下面顺序依次换，某家没这个模型就跳过；角色模型不换）　·　候选 = 「② 已选」∩ 这个载体够得着的家，每格都带家名（`家/模型`）——**点一次就写入**，不用再点第二次' }))
      var allM = (v.allModels || []).slice()
      /**
       * ★★ 2026-10-12（用户报障："选不了模型，选了也没用"＋"这里的模型应该为 API 已经选择的模型总和"）——
       *   **候选清单改由后端给**（`r.modelOptions`，值一律是 `家/模型`）。界面不再自己拼家名：
       *   拼错就是 401（实测 Pi 上写 `xiaomi/…` ＝按量计费口，而钥匙是套餐的）。
       *   口径：候选 = 「② 已选」∩「这个载体够得着的家」；同一个模型名在两家都有时**各占一格**。
       *   ⚠️ 下面那段旧逻辑只作为**老后端**（没这字段）的兜底 —— 新面板不会走到。
       */
      function modelsForRole (r) {
        if (Array.isArray(r.modelOptions) && r.modelOptions.length) return { list: r.modelOptions, how: (r.cap && r.cap.how) || '' }
        var cap = r.cap || {}
        if (!r.cap) return { list: allM.map(function (m) { return { label: m, value: m } }), how: '（后端没给"这个载体能用哪些模型"，先按全部列）' }
        if (cap.mode === 'prefixed' && cap.prefix) {
          var pbase = cap.base || []
          return pbase.length ? { list: pbase.map(function (m) { return { label: m, value: cap.prefix + m } }), how: cap.how } : { list: [], how: cap.how }
        }
        if (cap.mode === 'native' && cap.native && cap.native.length) {
          return { list: cap.native.map(function (x) {
            var nt = (cap.notes && (cap.notes[x.label] || cap.notes[x.value])) || null
            return { label: x.label, value: x.value, custom: x.custom, note: nt }
          }), how: cap.how }
        }
        if (cap.mode === 'providers' && cap.allowed && cap.allowed.length) {
          var mp = v.modelsByProvider || {}
          var out = []
          var seen = {}
          cap.allowed.forEach(function (prov) {
            (mp[prov] || []).forEach(function (m) { if (seen[m]) return; seen[m] = 1; out.push({ label: m, value: m }) })
          })
          return out.length ? { list: out, how: cap.how } : { list: allM.map(function (m) { return { label: m, value: m } }), how: (cap.how || '') + '（但没取到这几家的模型清单，先按全部列）' }
        }
        return { list: [], how: cap.how || '这个载体的模型来源未知 ⇒ 只能手填' }
      }
      var roleLists = {}
      v.roles.forEach(function (r) { roleLists[r.role] = modelsForRole(r) })
      // ★ 2026-10-12：候选值现在是 `家/模型` ⇒ 搜索要按**裸模型名**匹配（家名不该参与搜索，
      //   否则搜 `ark` 会把 ark 那家的所有模型都捞出来、跟"找某个模型"的意图不符）。
      var union = []
      var searchText = {}
      Object.keys(roleLists).forEach(function (k) {
        roleLists[k].list.forEach(function (x) {
          if (!(x.value in searchText)) { searchText[x.value] = x.bare || x.label || x.value; union.push(x.value) }
        })
      })
      var mq = String(st.drafts._mq || '')
      var mqT = mq.trim()
      var mHits = mq ? union.filter(function (v) { return C.modelScore(searchText[v], mq) > 0 })
        .sort(function (a, b) { return C.modelScore(searchText[b], mq) - C.modelScore(searchText[a], mq) || String(searchText[a]).length - String(searchText[b]).length }) : union
      // 「手动填」只在**真的没这个模型**时出现（搜到一个已选的裸名不算"手动填"）
      var manual = Boolean(mqT) && !union.some(function (v) { return searchText[v] === mqT })
      rows.push(h('div', { style: { display: 'flex', alignItems: 'center', gap: '5px', margin: '4px 0 2px' } }, [
        h('input', {
          placeholder: '搜模型（不用记全名：mimo / v4flash / glm5 …）',
          value: st.drafts._mq || '',
          style: { flex: '1', minWidth: '140px', font: 'inherit', fontSize: '12px', padding: '2px 6px' },
          oninput: function (e) { st.drafts._mq = e.target.value; paint() }
        }),
        mq ? h('button', { class: 'btn', text: '×', onclick: function () { st.drafts._mq = ''; paint() } }) : null,
        h('span', { class: 'dim tiny', text: mq ? ('匹配 ' + mHits.length + '（各职位可选项不同）') : '' })
      ]))
      if ((v.keylessProviders || []).length) {
        // ★ 2026-10-12（b36）：被「删」的家已经**整家不再带出来**（用户口径："删了就应该不存在"）⇒
        //   这里只剩"真解析不到钥匙"的家，如实说清、并给出补救动作（重新添加同名钥匙）。
        rows.push(h('div', { class: 'dim tiny', text: '（这几家现在用不了、已从下拉里去掉：' + v.keylessProviders.map(function (n) {
          return n + '（解析不到钥匙 ⇒ 要用它就在 ② 页「＋ 添加」里填同名 + 钥匙）'
        }).join('、') + '）' }))
      }
      v.roles.forEach(function (r) {
        var rl = roleLists[r.role] || { list: [] }
        // ★ 2026-10-12：现用值**原样显示**（`r.modelCurrent`，含前缀/载体私有写法）——
        //   以前拿"裸名"去比，`custom-local:kimi-k3`（真能跑）会被误报成"这载体可能不认"。
        var whyZh = { 'not-selected': '**不在候选清单里**', 'unknown-provider': '**这个载体不认这个家名**', 'no-key': '**那家没钥匙（或被删过）**' }
        var curVal = r.modelCurrent || r.model
        var opts = rl.list.filter(function (x) { return !mq || mHits.indexOf(x.value) !== -1 })
        if (curVal && !opts.some(function (x) { return x.value === curVal })) opts.unshift({ label: curVal, value: curVal, stale: true, why: r.modelCurrentWhy })
        if (manual) opts.push({ label: mqT, value: mqT, manual: true })
        var fbCur = r.fallbackRaw || r.fallback
        var fbOpts = rl.list.filter(function (x) { return !mq || mHits.indexOf(x.value) !== -1 })
        if (fbCur && !fbOpts.some(function (x) { return x.value === fbCur })) fbOpts.unshift({ label: fbCur, value: fbCur, stale: true, why: r.modelCurrentWhy })
        if (manual) fbOpts.push({ label: mqT, value: mqT, manual: true })
        var seq = (r.providers || []).map(function (p) { return p.rank + '.' + p.provider }).join(' → ')
        // 同一个裸名在**多家都有**时，标签后面缀上家名（否则两个选项看着一模一样、选谁都一样）
        var dupBare = {}
        rl.list.forEach(function (x) { if (x.bare) dupBare[x.bare] = (dupBare[x.bare] || 0) + 1 })
        var optLabel = function (x) {
          var base = x.label || x.value
          // ★ b41（用户问："这个下拉模型，为什么只有 k3 没有来源（API）？"）——
          //   老规则是"**只有同名模型出现在多家时**才标来源"（b35 为消歧设计的）⇒ 结果是
          //   `glm-5.3-flash · ark` 标了来源、而 `kimi-k3`（只火山有）**反而没标** ⇒ 看着像漏了/不知哪来的。
          //   口径改成：**有来源就一律标**（同名多家时更该标 —— 那正是必须看清来源的场合）。
          if (x.providerName) base = base + ' · ' + x.providerName
          return base
        }
        var sc = r.scope || null
        var scTxt = ''
        if (sc && sc.selectedTotal) {
          scTxt = (sc.missing && sc.missing.length)
            ? ('② 已选 ' + sc.selectedTotal + ' 个 · 这个载体够得着 ' + sc.reachable + ' 个（其余在 ' + sc.missing.join('、') + '）')
            : ('② 已选 ' + sc.selectedTotal + ' 个 · 它都够得着')
        }
        rows.push(h('div', { style: { display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', marginTop: '3px', flexWrap: 'wrap' } }, [
          h('span', { style: { minWidth: '70px' }, text: r.role }),
          h('span', { class: 'dim tiny', style: { minWidth: '66px' }, title: rl.how || '', text: '[' + (r.agent || '?') + ']' }),
          // ★★ 2026-10-24（用户："coder-a 为什么能选的比 coder-b 少？"）—— **兜底要看得见**：
          //   以前 `cap.how` 只挂在 tooltip 上 ⇒ pi 的清单一直问不到（`同步载体模型.mjs` 的 node 路径算错，
          //   已修），界面只显示"够得着 6 个"，**没人知道那是"问不到"而不是"它不能"**，白摆了 12 天。
          (rl.cap && /\u26a0/.test(String(rl.cap.how || ''))
            ? h('span', { class: 'dim tiny', style: { color: '#c0392b' }, title: rl.cap.how || '', text: '⚠️ 这份清单是兜底（悬停看原因）' })
            : null),
          h('select', {
            value: curVal,
            title: (rl.how || '这个职位用哪个模型') + '（搜不到就用上面的搜索框手动填）',
            style: { font: 'inherit', fontSize: '12px', maxWidth: '230px' },
            onchange: function (e) {
              var val = e.target.value
              var force = Boolean(st.drafts._force && st.drafts._force === val)
              call('roleModel', { role: r.role, model: val, manual: Boolean(manual && val === mqT), force: force, provider: (r.providers && r.providers[0] && r.providers[0].provider) || null })
                .then(function (jj) { if (jj && jj.ok === false) st.drafts._force = val; else delete st.drafts._force })
            }
          }, opts.map(function (x) {
            var pre = x.manual ? '✍ 手动填：' : (x.stale ? ('⚠️ 现用的（' + (whyZh[x.why] || '它不在上面的候选里') + '）：') : (x.custom ? '（自定义）' : ''))
            var suf = x.note ? (' ⓘ ' + x.note.short) : ''
            return h('option', { value: x.value, disabled: !!x.disabled, title: x.note ? x.note.long : null, text: pre + optLabel(x) + suf })
          })),
          h('span', { class: 'dim tiny', title: (rl.cap && rl.cap.customApi === false) ? (rl.cap.customApiWhy || '这家不支持自定义 API') : '备选模型：主模型失败 → 先换它；它也不行 → 换 API（按「先试顺序」）；到那家后先主后备', text: '备选' }),
          h('select', {
            value: fbCur || '',
            // ★ b40（用户口径）：这家载体**换不了家**（不支持自定义 API 的额外要求）⇒ 备选**如实写这句**、不给选，
            //   但仍把"现在配着的那条"亮出来（⚠️ 现用的）—— 绝不把既有配置藏起来假装没配。
            disabled: !!(rl.cap && rl.cap.customApi === false),
            title: (rl.cap && rl.cap.customApi === false) ? (rl.cap.customApiWhy || '这家不支持自定义 API') : '备选模型：主模型失败 → 先换它；它也不行 → 换 API（按「先试顺序」）；到那家后先主后备',
            style: { font: 'inherit', fontSize: '12px', maxWidth: '190px' },
            onchange: function (e) {
              var val = e.target.value
              var force = Boolean(st.drafts._forceFb && st.drafts._forceFb === val)
              call('roleFallback', { role: r.role, model: val, manual: Boolean(manual && val === mqT), force: force })
                .then(function (jj) { if (jj && jj.ok === false) st.drafts._forceFb = val; else delete st.drafts._forceFb })
            }
          }, (rl.cap && rl.cap.customApi === false)
            ? [h('option', { value: fbCur || '', text: '（不支持自定义 API）' + (fbCur ? ('　⚠️ 现用的：' + fbCur) : '') })]
            : [h('option', { value: '', text: '（空）' })].concat(fbOpts.map(function (x) {
              var pre = x.manual ? '✍ 手动填：' : (x.stale ? '⚠️ 现用的：' : '')
              return h('option', { value: x.value, text: pre + optLabel(x) })
            }))),
          h('span', { class: 'dim tiny', title: scTxt, text: (!rl.list.length ? '（我列不出它自家有哪些模型 ⇒ 用上面的搜索框手填）　' : '') +
            (r.chainNA ? r.chainNA : (r.onlyOne ? '⚠️ 只有 1 家提供这个模型 → 额度用完就真没得换' : ('额度用完依次走：' + seq))) +
            (sc && sc.missing && sc.missing.length ? ('　·　' + scTxt) : '') })
        ]))
        // ★ 2026-10-16（任务分级 L1–L4）：**级模型就在这里选**（用户口径："每级用什么模型＝我在看板里定"）。
        //   为什么另起一行、而不是塞进主下拉：主下拉是"这个职位的默认档"，四级是**四个独立的数** —— 挤一行读不出来。
        //   服务端（额度面板.mjs 的 roleRows）已把"每级现在配着什么 / 值从哪来 / 是不是必填"算好（`r.levels`），界面只负责画。
        var lvRow = buildLevelRow(r, manual, mqT)
        if (lvRow) { lvRowRefs[r.role] = lvRow; rows.push(lvRow) }
      })
    }
    paint()
    return root
  }

  /* ── 看板页（2026-10-10 改版：「看」接真数据 ＋「控」三钮接 /frame-action）──
   * 数据：GET /frames.json（服务端聚合：状态/模型/额度/最近动态；15 秒轮询）
   * 布局：顶栏 ＋ 3×2 六格；每格＝头部（状态灯·职位/载体/状态 ＋ 模型·悬浮额度）
   *       ＋ 中部动态列表 ＋ 底部（消息框＋发送/暂停/继续）。
   * 交互：发送＝插话（预览）· 暂停＝两段确认后真杀（收据落项目）· 继续＝预览。
   * 口径：帧数据取不到就如实显示"没有"，不猜、不编。
   */
  var FRAME_ROLES = ['大脑', 'coder-a', 'coder-b', 'reviewer', 'researcher', 'rescue']
  var FRAMES_MS = 15000
  var boardCells = {}
  var framesSnap = null
  var actionMsg = {}          // role -> 最近一次操作回话（置顶显示）
  /**
   * ★ 2026-10-11（看板 ④ 会话视图）：每格的"中部"可以在两种看法间切：
   *   `list`    ＝ 最近动态（原样，便宜档）
   *   `session` ＝ **会话**（输入＝派活原文，输出＝载体的回答/工具调用，拼成"像自己开的会话"）
   * 口径：会话**只在点开时取一次**（一次可能几百条，不能每 15 秒重取重画）；
   *       跑着时按 `FRAMES_MS` 重取（让新内容长出来）。
   */
  var sessView = {}           // role -> 'list' | 'session'
  var sessData = {}           // role -> { loading, error, data }
  var sessLimit = 1           // 一次取最近几轮（★ 2026-10-12 用户："只显示最近一轮即可" ⇒ 3 → 1：取回来的就是画出去的）
  /* ★ 2026-10-11（用户实测："我点击展开后，间隔几秒他突然就回弹了"）——
   *   根因：会话区**每 15 秒被整块重画**（`paintBoard` 每次 `clear(bodyEl)` 重建 DOM）
   *   ⇒ ① 展开态是**闭包里的局部变量**，重画即丢（回弹）
   *      ② 滚动位置随新 DOM 归零 ⇒ 你看到的是**最旧的**那一段，而不是最新的。
   *   ⇒ 这两份状态必须**存在重画之外**：
   *     `sessOpen`     —— 条目 key -> 已展开（跨重画保留）
   *     `sessScrollTop`—— 非贴底时，重画后要恢复到的滚动位置（不把你甩回顶部） */
  var sessOpen = {}
  var sessScrollTop = {}
  /** 条目的稳定身份（跨重画不变）：种类 ＋ 时间戳 ＋ 任务名 ＋ 正文前 40 字。 */
  function sessKey (e) {
    return String(e.kind || '') + '|' + String(e.ts || '') + '|' + String(e.task || '') + '|' + String(e.text || '').slice(0, 40)
  }

  function evIcon (kind) {
    return kind === 'thinking' ? '…' : kind === 'tool' ? '›' : kind === 'result' ? '↳' : kind === 'error' ? '✗' : kind === 'message' ? '' : '·'
  }
  /* ★ b209（2026-10-20）：**钉住的目录 ≠ 工作台根**时顶上那条明白话 —— 看板页与设置页**共用一个实现**
   *   （判据全在服务端 `面板\项目定位.mjs`；这里只负责把"你钉的是 A、实际读的是 B、依据是什么"摆出来）。
   *   返回 true＝这条要显示。按钮「改钉并记住」＝写钉子 ＋ 顺手把 A→B 记进 `_crew\项目映射.json`。 */
  function fillPinBanner (box, cp) {
    box.innerHTML = ''
    if (!cp || !cp.banner) { box.style.display = 'none'; box.className = 'pin-banner'; return false }
    box.style.display = ''
    box.className = 'pin-banner' + (cp.noWorkbench ? ' bad' : '')
    box.appendChild(h('div', { class: 'pb-txt', text: String(cp.banner) }))
    if (cp.noWorkbench || cp.resolvedBy === 'ledger') {
      box.appendChild(h('button', {
        class: 'pb-btn',
        text: '改钉到「' + String(cp.name || '') + '」并记住',
        onclick: function (ev) {
          var b = ev.target
          b.disabled = true
          b.textContent = '钉着…'
          fetch('/pin', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: cp.path, rememberFrom: cp.pinPath })
          }).then(function (r) { return r.json() }).then(function (j) {
            if (j && j.ok) location.reload()
            else { b.disabled = false; b.textContent = '钉失败：' + String((j && j.error) || '看服务端日志') }
          }).catch(function () { b.disabled = false; b.textContent = '钉失败（网络）' })
        }
      }))
    }
    return true
  }

  /* ★ D28（施工文档 §13）：看板的"钉"与跑的"project"必须同源 —— 现在三套口径互不校验：
   *   看板钉住的项目（`_crew\当前项目.txt`）／唤醒按 `cwd === project` 认人／编排按 `--project` 跑。
   *   ① 钉住的项目 ≠ 本次跑的 project ⇒ 顶部这条 banner **说话**（b209 的机制复用，判据扩成"钉的与跑的不一致"）；
   *   ② 钉的项目失效（目录不存在/读不到）⇒ **显式报"钉失效"**，不许只显示一片空。
   *   ⚠️ 判据只用板数据现有字段（`看板数据.mjs` 不在本次改动范围）：
   *   · "本次跑的 project"＝ `crewByProject` 里最近有活动的那个（**pid 在跑的优先**，其次 lastEventAt 最新且 24h 内）；
   *   · "钉失效"＝ `currentProject.set` 且 `resolvedBy==='none'` 且 `noWorkbench`，且钉的路径不在项目清单里
   *     （板数据分不出"目录不存在"和"目录里没有 _crew"，这里如实写两种可能，不猜）。 */
  function fillRunPinBanner (box, d) {
    box.innerHTML = ''
    var cp = (d && d.currentProject) || {}
    var crew = (d && d.crewByProject) || []
    var nz = function (p) { return String(p || '').replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase() }
    var name = function (p) { return String(p || '').replace(/\\+$/, '').split(/[\\/]/).filter(Boolean).pop() || String(p || '') }
    var known = crew.filter(function (p) { return p && p.runsDirExists })
    // 钉失效：钉了，但读不到任何活（不是项目清单里的任何一个）
    var pinnedKnown = known.some(function (p) { return nz(p.path) === nz(cp.path) || nz(p.path) === nz(cp.pinPath) })
    if (cp.set && cp.noWorkbench && cp.resolvedBy === 'none' && !pinnedKnown) {
      box.style.display = ''
      box.className = 'pin-banner bad'
      box.appendChild(h('div', {
        class: 'pb-txt',
        text: '⚠️ 钉失效：钉的项目「' + String(cp.pinPath || cp.path || '') + '」读不到（目录已不存在，或里面没有 `_crew\\TASKS.md`）⇒ 看板显示不出它。请改钉一个工作台根。'
      }))
      return true
    }
    // 钉 ≠ 本次跑的：谁在跑/最近活动的优先
    var running = known.filter(function (p) { return (p.running | 0) > 0 })
    var cand = running[0] || null
    if (!cand) {
      var recent = known.filter(function (p) { return p.lastEventSecAgo != null && p.lastEventSecAgo <= 24 * 3600 })
        .sort(function (a, b) { return (a.lastEventSecAgo || 0) - (b.lastEventSecAgo || 0) })[0]
      cand = recent || null
    }
    if (!cp.set || !cand) { box.style.display = 'none'; box.className = 'pin-banner'; return false }
    if (nz(cand.path) === nz(cp.path) || nz(cand.path) === nz(cp.pinPath)) { box.style.display = 'none'; box.className = 'pin-banner'; return false }
    box.style.display = ''
    box.className = 'pin-banner'
    box.appendChild(h('div', {
      class: 'pb-txt',
      text: '⚠️ 钉的是「' + String(cp.name || name(cp.path)) + '」，本次跑的是「' + String(cand.project || name(cand.path)) + '」—— ' +
        '看板显示钉的那个，唤醒/编排按 --project 跑的是后者（两处不同源，D28）。要跟着看哪个，改钉对齐一下。'
    }))
    return true
  }

  function buildBoard () {
    var grid = h('div', { class: 'board-grid' })
    var pinBar = h('div', { class: 'pin-banner', style: { display: 'none' } })
    boardPinBar = pinBar
    var d28Bar = h('div', { class: 'pin-banner', style: { display: 'none' } })
    boardD28Bar = d28Bar
    FRAME_ROLES.forEach(function (role) {
      var dot = h('span', { class: 'st-dot st-off' })
      var head1 = h('div', { class: 'frame-line1' }, [dot, h('span', { text: '职位:' + role + '（载入中…）' })])
      var head2 = h('div', { class: 'frame-line2', text: '模型:…' })
      var bodyEl = h('div', { class: 'frame-events' }, h('div', { class: 'dim ev', text: '取数中…' }))
      var input = h('input', { class: 'frame-msg', type: 'text', placeholder: '输入消息…（继续＝插话时填这里）' })
      var btnSend = h('button', { class: 'frame-btn', text: '发送', onclick: function () { doAction(role, 'send', input.value) } })
      var btnPause = h('button', { class: 'frame-btn', text: '暂停', onclick: function () { doAction(role, 'pause') } })
      var btnResume = h('button', { class: 'frame-btn', text: '继续', onclick: function () { doAction(role, 'continue') } })
      // ★「会话」开关：在这格中部切"最近动态 ↔ 真会话"（会话＝输入＋输出拼起来，像自己开的会话）
      //   ★ 2026-10-11（大脑会话视图）：**大脑那格也有**了 —— 但走的是**另一条链**：
      //     它的会话不在班组账本里，而在 **DSH 自己的转录**里（`/brain-session.json`，
      //     哪一条由 `看板数据.mjs` 定）。⚠️ A3 时删掉它是因为"没有路"（死胡同）；现在路有了 ⇒ 给回来。
      //   ⚠️ 按钮**六格都建**（帧数据是异步来的，建的时候还没有 frames）——
      //     "这一格有没有会话"由 `paintBoard()` 每次按帧数据现判：大脑那格取不到 `brainSessionId`
      //     就**禁用并藏起来**（口径不变：没有路就不给点）。
      var isBrain = role === '大脑'
      var btnSess = h('button', {
        class: 'frame-btn frame-btn-sess',
        text: '会话',
        title: isBrain
          ? '看**大脑自己**（DSH 这条会话）说了什么、回了什么 —— 读的是 DSH 的转录，不是班组账本；点一下切过去，再点回最近动态'
          : '看这一格跟载体**说了什么、回了什么**（派活原文当输入、载体的回答与工具调用当输出）——点一下切过去，再点回最近动态',
        onclick: function () { toggleSession(role) }
      })
      boardCells[role] = { head1: head1, head2: head2, dot: dot, bodyEl: bodyEl, input: input, btns: { send: btnSend, pause: btnPause, resume: btnResume, sess: btnSess } }
      grid.appendChild(h('section', { class: 'frame' }, [
        h('div', { class: 'frame-head' }, [
          h('div', { class: 'frame-head-row' }, [head1, btnSess]),
          head2
        ]),
        bodyEl,
        h('div', { class: 'frame-foot' }, [input, btnSend, btnPause, btnResume])
      ]))
    })
    return h('div', { class: 'board-page' }, [shellBar, pinBar, d28Bar, grid])
  }

  /* ── ★ b126：「外壳」提示条（**首启问一句**的落点）────────────────────────────
   *   用户口径：*"检查桌面是否有快捷方式，没有就建立一个……给其他用户用，开源，开箱即用"* ＋ 拍板"**首启问一句**"。
   *   ⚠️ "问"必须问在**用户看得见的地方** —— 插件在后台跑 `--autostart`，那里**没有交互终端**，
   *      所以它只记「待问」，真正的问题显示在**看板顶上这一条**；用户点了才建。
   *   三态：没表态 ⇒ 显示这条 ／ 点了建立 ⇒ 消失 ／ 点了不用 ⇒ 永远不再问（`--uninstall` 同理）。 */
  var shellBar = h('div', { class: 'shell-bar', style: { display: 'none' } })
  function showShellBar (kids) { clear(shellBar); append(shellBar, kids); shellBar.style.display = '' }
  function loadShell () {
    fetch('/shell.json', { cache: 'no-store' }).then(function (r) { return r.json() }).then(function (j) {
      if (!j || !j.ok) { shellBar.style.display = 'none'; return }
      if (j.已卸载 || j.用户选择) { shellBar.style.display = 'none'; return }   // 表过态就不再打扰
      if (!j.待问) { shellBar.style.display = 'none'; return }                   // 插件还没跑过 ⇒ 不主动问
      showShellBar([
        h('span', { text: '要不要在桌面放一个「班组看板」快捷方式？（双击＝独立窗口，不用开浏览器；开始菜单里也会有一个）' }),
        h('button', { class: 'btn', text: '建立', onclick: function () { shellAct('install') } }),
        h('button', { class: 'btn', text: '不用了', onclick: function () { shellAct('dismiss') } })
      ])
    }).catch(function () { shellBar.style.display = 'none' })
  }
  function shellAct (op) {
    showShellBar([h('span', { text: '正在处理…' })])
    fetch('/shell-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: op }) })
      .then(function (r) { return r.json() })
      .then(function (j) {
        var lines = (j && j.动作) || []
        var bad = (j && j.问题) || []
        showShellBar([h('span', { text: (j && j.ok ? '✅ ' : '❌ ') + (lines.join('；') || (j && j.error) || '没回话') + (bad.length ? '　⚠️ ' + bad.join('；') : '') })])
        // ✅ 成功 ⇒ 6 秒后收起（用户已经看见了）；❌ 留着让人看见
        if (j && j.ok) setTimeout(function () { shellBar.style.display = 'none' }, 6000)
      })
      .catch(function (e) { showShellBar([h('span', { text: '❌ ' + String((e && e.message) || e) })]) })
  }

  var pageBoard = buildBoard()

  /* ── 帧渲染 ─────────────────────────────────────────────────────────── */
  function framesOf (role) {
    return (framesSnap && framesSnap.ok !== false && framesSnap.frames)
      ? framesSnap.frames.filter(function (f) { return f.role === role })[0] || null
      : null
  }
  function evRow (r) {
    return h('div', { class: 'ev ev-' + (r.kind || 'status') }, [
      h('span', { class: 'ev-ico', text: evIcon(r.kind) }),
      h('span', { class: 'ev-txt', text: String(r.text || '') })
    ])
  }

  /* ── ④ 会话视图（2026-10-11）：输入＝派活原文，输出＝载体的回答与工具调用 ──────
   * 口径：
   *   · 只读盘（`/session.json` → `会话流.mjs` → `面板\会话\`），**不落新状态**
   *   · 取一次就够（一次几百条）；**在跑**时才跟着帧轮询重取，让新内容长出来
   *   · 长文折叠（免得一屏糊死）；跑着时**自动滚到底**，但**你往上翻就不抢**
   */
  var sessAutoScroll = {}     // role -> 是否贴底（用户往上翻 ⇒ false）

  function toggleSession (role) {
    var to = (sessView[role] === 'session') ? 'list' : 'session'
    sessView[role] = to
    var cb = boardCells[role] && boardCells[role].btns && boardCells[role].btns.sess
    if (cb) cb.classList.toggle('on', to === 'session')
    if (to === 'session' && !sessData[role]) loadSession(role)
    paintBoard()
  }

  /** 取会话。**大脑走另一条链**（`/brain-session.json`：读 DSH 自己的转录），
   *  五个职位走 `/session.json`（账本 envelope ＋ 派活原文）。两条链的**载荷形状不同**，
   *  渲染分开（见 `sessBlocks` 里的分支）—— 别硬凑成一个形状。 */
  function loadSession (role) {
    var prev = (sessData[role] || {}).data || null
    sessData[role] = { loading: true, error: null, data: prev }
    if (!prev) paintBoard()          // 只有**首次**才画"取会话中…"（之后每次轮询都画会闪）
    var u = role === '大脑'
      ? ('/brain-session.json?frames=60&entries=120&t=' + Date.now())
      : ('/session.json?role=' + encodeURIComponent(role) + '&limit=' + sessLimit + '&t=' + Date.now())
    return fetch(u, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { ok: false, error: 'HTTP ' + r.status } })
      .then(function (j) {
        var err = j && j.ok === false ? (j.error || '取数失败') : null
        // ★ 2026-10-11（用户："展开后间隔几秒突然回弹"）：**一模一样就别重画** ——
        //   重画会重建整块 DOM（展开态/滚动位只能靠上面那两份状态兜回来）。能不重画就不重画。
        var same = Boolean(prev) && !err && JSON.stringify(prev) === JSON.stringify(j)
        sessData[role] = { loading: false, error: err, data: j }
        if (!same) paintBoard()
        return same
      })
      .catch(function (e) { sessData[role] = { loading: false, error: String((e && e.message) || e), data: null }; paintBoard() })
  }

  /** 判断滚动容器是否"贴底"（差 24px 内算贴底）—— 决定重画后要不要自动滚。 */
  function bodyNearBottom (el) {
    if (!el) return true
    try { return (el.scrollHeight - el.scrollTop - el.clientHeight) < 24 } catch (e) { return true }
  }

  /** 会话条目的展示形态：谁说的、属于哪一类、工具名与入参。 */  function sessHead (e) {
    var who = e.role === 'user' ? '👤 用户' : '🤖 助手'
    var K = { text: '正文', thinking: '思考', tool_use: '工具', tool_result: '结果', status: '机制', error: '错误' }
    var tag = K[e.kind] || e.kind
    var extra = ''
    if (e.kind === 'tool_use') extra = '　' + String(e.tool || '') + (e.input ? '　' + String(e.input).slice(0, 120) : '')
    else if (e.role === 'user' && e.source) extra = '　（输入来源：' + e.source + '）'
    return who + ' · ' + tag + extra
  }

  /** 长文折叠：默认收起（可点开），并保留换行。
   *
   *  ★ 2026-10-11（用户口径）：**思考块一律默认收起** —— 原话：
   *    "你看板里面直接展开了思考内容，**要做的和会话一样**"。
   *    会话（DSH）那边"思考"是一条**折叠条**，点开才看；而面板原来只看长度
   *    （≤700 字就整段摊开）⇒ 一段 300 字的思考会把窄格子刷满，正文反被挤下去。
   *  ⇒ `opts.collapse` 为真时**不管多长都先收起**，只给**一行预览**（压掉换行、夹到 `opts.limit` 字）。
   *    其余条目照旧（>700 字才收）—— 正文是要读的，思考是"想知道才点开"的。 */
  function sessBody (text, opts, key) {
    var t = String(text == null ? '' : text)
    if (!t.trim()) return null
    var force = Boolean(opts && opts.collapse)
    var limit = force ? (opts.limit || 120) : 700
    var flat = t.replace(/\s+/g, ' ').trim()
    // ⚠️ 本来就"一行以内"的**直接给、不挂按钮** —— 否则会出现"展开思考（4 字）"这种点了没用的按钮
    //   （本项目最恨"能点但没用"）。所以强制收起只对**真会长**的思考块生效。
    if (force && flat.length <= limit) return h('div', { class: 'ss-text', text: t })
    if (!force && t.length <= limit) return h('div', { class: 'ss-text', text: t })
    var preview = force ? (flat.slice(0, limit) + ' …') : (t.slice(0, limit) + '\n…')
    var label = force ? '展开思考（' + t.length + ' 字）' : '展开全部（' + t.length + ' 字）'
    // ★ 展开态**从 `sessOpen` 来**（不是每次重画都从"收起"开始）—— 这就是"回弹"的修法
    var clipped = !(key && sessOpen[key])
    var box = h('div', { class: 'ss-text' + (clipped ? ' ss-clip' : ''), text: clipped ? preview : t })
    var more = h('button', {
      class: 'btn ss-more', text: clipped ? label : '收起',
      onclick: function () {
        clipped = !clipped
        if (key) sessOpen[key] = !clipped      // ★ 记在重画之外
        box.textContent = clipped ? preview : t
        box.classList.toggle('ss-clip', clipped)
        this.textContent = clipped ? label : '收起'
      }
    })
    return h('div', {}, [box, more])
  }

  function sessBlocks (role) {
    var st = sessData[role] || {}
    var out = []
    if (st.loading && !st.data) out.push(h('div', { class: 'dim ev', text: '取会话中…' }))
    if (st.error) out.push(h('div', { class: 'ev ev-error' }, h('span', { class: 'ev-txt', text: '✗ ' + st.error })))
    var d = st.data
    if (!d) return out
    if (d.error) { out.push(h('div', { class: 'ev ev-error' }, h('span', { class: 'ev-txt', text: '✗ ' + d.error }))); return out }

    /* ── 大脑那条链（DSH 自己的转录）：载荷形状与载体那套不同，单独一套头 ────────── */
    if (role === '大脑') {
      var s = d.session || {}
      // ★ b66：原 `slB`/`shownN` 已删 —— 条数不再在这里自己算，改由 `sessMetaSuffix(d.entries)`
      //   **按折叠之后**算（与渲染**同一套规则**，两处各算一遍必漂）。
      out.push(h('div', { class: 'dim ss-meta' }, [
        h('span', {
          title: '会话 ' + String(s.id || '?') + (s.file ? '\n转录：' + s.file : '') + (s.scopeNote ? '\n' + s.scopeNote : ''),
          // ⚠️ 身份（标题 / id）**已挪到固定表头**（见 `paintBoard` 里的 `.brain-sess`）——这里只留数字。
          //    别再把身份画进正文：正文贴底会把它滚出视野，那正是"以为显示的还是上一条会话"的根源。
          //    ⚠️ 大脑链**没有总轮数**（`/brain-session.json` 只解尾巴若干帧）⇒ 只说"只画最近一轮 + 条数"，别编"共 N 轮"。
          // ⚠️ 这一行别再放 🔴 之类的 emoji（2026-10-12 用户当场把它读成"故障红灯"）：
          //   它是**元信息行**，而表头已经有状态灯 ＋「状态:在跑/停着」—— 同一个事实重复一遍只会添乱，
          //   何况 emoji 自带红圈，而这个项目里"红"通常＝报错。（载体那两处 `🔴 正在跑（实时）` 不在此列：
          //   它们只在**真有活在跑**时出现，是另一个信号。）
          text: (s.running === true ? '正在跑' : s.running === false ? '停着' : '在跑与否未知') +
            (s.contextText ? ' · 上下文 ' + s.contextText : '') +
            ' · 尾巴 ' + String((d.tail || {}).framesOk ?? '?') + ' 帧 / 只画最近一轮' + sessMetaSuffix(d.entries)
        }),
        h('button', { class: 'btn', text: '重取', style: { marginLeft: '6px' }, onclick: function () { loadSession(role) } })
      ]))
      pushSessEntries(out, d.entries)
      return out
    }

    if (!d.total && !(d.entries || []).length) {
      out.push(h('div', { class: 'dim ev', text: '账本里这家还没有调用记录（' + String(d.carrier || '?') + '）' }))
      return out
    }
    out.push(h('div', { class: 'dim ss-meta' }, [
      h('span', { text: '载体 ' + String(d.carrier || '?') + (d.supported ? '' : '（**暂无会话翻译器**）') + ' · 账本共 ' + d.total + ' 轮 · 只画最近一轮' + sessMetaSuffix(d.entries) }),
      // ★ 2026-10-11（A4-②）：这一格**此刻真在跑**时如实标出来 —— 内容会边跑边长（每 15 秒重取）。
      d.live ? h('span', { class: 'ss-live', text: '　🔴 正在跑 ' + String(d.live.task || '?') + '（输出 ' + String(d.live.outBytes || 0) + ' 字节，边跑边长）' }) : null,
      h('button', { class: 'btn', text: '重取', style: { marginLeft: '6px' }, onclick: function () { loadSession(role) } })
    ]))
    pushSessEntries(out, d.entries)
    return out
  }
  /** 分轮边界：**载体链**是 `kind:'round'` 那行；**大脑链**没有 round 行 ⇒ 认 `第 N 轮开始` 那条 status。 */
  function isRoundStart (e) {
    return Boolean(e) && (e.kind === 'round' || (e.kind === 'status' && /^第 \d+ 轮开始/.test(String(e.text ?? ''))))
  }
  /** 只保留**最近一轮**：返回 `{list, rounds, baseN}`（`rounds` = 一共认出几轮，`baseN` = 这一轮之前有几轮）。
   *  找不到边界（老会话/空载荷）⇒ **原样返回**，不假装"只有一轮"。 */
  function lastRoundSlice (entries) {
    var all = entries || []
    var starts = []
    for (var i = 0; i < all.length; i++) if (isRoundStart(all[i])) starts.push(i)
    if (!starts.length) return { list: all, rounds: 0, baseN: 0 }
    var from = starts[starts.length - 1]
    return { list: all.slice(from), rounds: starts.length, baseN: starts.length - 1 }
  }
  /** 把会话条目画进 `out`（**两条链共用**：载体那条有 `kind:'round'` 的分轮行，大脑那条没有）。
   *
   *  ★ 2026-10-12（用户拍板 · 报障原话："**这些看板内的消息，太多了，只显示最近一轮即可**"）：
   *    **只画最近一轮** —— 从最后一个分轮边界起（载体＝`kind:'round'`；大脑＝`第 N 轮开始` 的 status）。
   *    为什么切在**渲染层**而不是只把 fetch 的 `limit` 调小：**大脑链根本没有"轮"这个概念**
   *    （`/brain-session.json` 一次给整条会话，实测 58 轮），服务端 limit 治不了它；放这里两条链口径一致。
   *    **载荷照旧完整**（`/brain-session.json`、`/session.json` 都不改）—— 要看更早的，查转录/账本就行。
   *    ⚠️ 轮号要按**全局**算（`baseN + n`），别让它显示成"第 1 轮"（本轮之前有几轮是知道的）。 */
  /** ★★ b60：**保序归并**（用户口径："我要的是不堆积，不是裁剪原文内容" ＋ "信息是串流的，你不能打乱顺序"）。
   *  只把**连续同类**的噪声条目（思考 / 工具 / 工具结果 / 机制）折成一行 `思考 ×12`，
   *  **原地**折叠、**原地**展开（展开后顺序＝原文顺序）；
   *  `text`（正文/结论）与 `user`（派活原文）**一律不折**；**不排序、不分组、不跨条目搬动**。 */
  var FOLDABLE = { thinking: '思考', tool_use: '工具', tool_result: '结果', status: '机制', retry: '重试' }
  function foldRuns (list) {
    var out = [], i = 0
    while (i < list.length) {
      var k = list[i].kind
      if (!FOLDABLE[k]) { out.push(list[i]); i++; continue }
      var j = i
      while (j < list.length && list[j].kind === k) j++
      if (j - i >= 3) out.push({ kind: 'fold', of: k, count: j - i, items: list.slice(i, j) })
      else for (var t = i; t < j; t++) out.push(list[t])
      i = j
    }
    return out
  }
  /** ⚠️ `raw=true` ＝ **已经是片段**（折叠项展开时用）：**不再切轮、不再折叠** ——
   *  否则"折叠项的 items 又是 ≥3 条同类" ⇒ 再折 ⇒ 再展开 ⇒ **无限递归**
   *  （实测报错：`✗ Maximum call stack size exceeded`，用户当场看到）。 */
  /** ★★ b65（D）：元信息行**必须与屏幕一致** —— 数按**折叠之后**算，并**明说**"少的是折起来了、不是删了"
   *  （用户口径："不堆积，但不是裁剪原文"；界面不写清楚 ⇒ 从外面看跟被删掉一模一样）。 */
  function sessFoldStats (entries) {
    var sl = lastRoundSlice(entries)
    var folded = foldRuns(sl.list)
    var folds = folded.filter(function (e) { return e.kind === 'fold' })
    var hidden = folds.reduce(function (n, e) { return n + ((e.items || []).length) }, 0)
    var shown = folded.filter(function (e) { return e.kind !== 'inject' }).length
    return { shown: shown, folds: folds.length, hidden: hidden }
  }
  function sessMetaSuffix (entries) {
    var st = sessFoldStats(entries)
    return '（显示 ' + st.shown + ' 行' + (st.folds ? ' · 已归并 ' + st.folds + ' 处，收起 ' + st.hidden + ' 条（点开可看）' : '') + '）'
  }
  function pushSessEntries (out, entries, raw) {
    var sl = raw ? { baseN: 0, rounds: 0 } : lastRoundSlice(entries)
    var list = raw ? (entries || []) : foldRuns(sl.list)   // ★ b60：保序归并（只在渲染层折，**载荷照旧完整**）
    var n = 0
    list.forEach(function (e) {
      // ★ 2026-10-11（用户拍板：注入的上下文**彻底不显示**）：`kind:'inject'` ＝
      //   `user/message` 里 `source.kind !== 'user'` 的那几条（工作区指令 / 运行时快照 / 几万字技能清单）。
      //   它们原来被当「👤 用户 · 正文」平铺（"把全拼在一起了、不像 DSH 的会话框"）⇒ 这里跳过不画。
      //   载荷里仍在（翻译器留了证据），只是界面不显示。
      if (e.kind === 'inject') return
      // ★ b60：折叠行 —— **原地**一行摘要 ＋ **原地**展开（展开走同一条渲染路径 ⇒ 顺序＝原文顺序）
      if (e.kind === 'fold') {
        var fbody = h('div', { style: { display: 'none' } })
        // ⚠️ 必须画进**数组**再挂到 DOM 上 —— `pushSessEntries` 的第一参数是**数组**（它内部 `out.push`），
        //   第一版我直接传了 DOM 元素 ⇒ 用户当场看到 `✗ out.push is not a function`。
        var fkids = []
        pushSessEntries(fkids, e.items, true)     // ★ raw=true：片段原样画（顺序＝原文顺序，不再折/不再切轮）
        append(fbody, fkids)
        var flabel = h('span', { text: (FOLDABLE[e.of] || e.of) + ' ×' + e.count })
        var fbtn = h('button', { class: 'btn', text: '展开', style: { marginLeft: '6px' }, onclick: function () {
          var on = fbody.style.display === 'none'
          fbody.style.display = on ? '' : 'none'
          fbtn.textContent = on ? '收起' : '展开'
        } })
        out.push(h('div', { class: 'ss-ev ss-' + e.of, style: { opacity: '0.75' } }, [h('div', { class: 'ss-head' }, [flabel, fbtn]), fbody]))
        return
      }
      if (e.kind === 'round') {
        n++
        out.push(h('div', { class: 'ss-round' + (e.live ? ' ss-round-live' : '') }, [
          h('span', { text: '第 ' + (sl.baseN + n) + ' 轮 · ' + String(e.task || '?') + (e.at ? ' · ' + String(e.at).slice(0, 19).replace('T', ' ') : '') }),
          e.live ? h('span', { class: 'ss-live', text: '　🔴 正在跑（实时）' }) : null,
          e.note ? h('span', { class: 'ss-note', text: '　⚠️ ' + e.note }) : null
        ]))
        return
      }
      out.push(h('div', { class: 'ss-ev ss-' + (e.role === 'user' ? 'user' : (e.kind || 'text')) }, [
        h('div', { class: 'ss-head', text: sessHead(e) }),
        // ★ 思考块默认收起（"要做的和会话一样"）—— 见 `sessBody` 的注释；
        //   key 传进去是为了**展开态跨重画保留**（不然每 15 秒回弹一次）
        sessBody(e.text, e.kind === 'thinking' ? { collapse: true, limit: 120 } : null, sessKey(e))
      ]))
    })
    if (!list.length) out.push(h('div', { class: 'dim ev', text: '这一段没有可显示的条目' }))
  }
  function paintBoard () {
    FRAME_ROLES.forEach(function (role) {
      var c = boardCells[role]
      var f = framesOf(role)
      if (!f) {
        clear(c.head1)
        c.head1.appendChild(h('span', { class: 'st-dot st-off' }))
        c.head1.appendChild(h('span', { text: '职位:' + role + '　（取数失败）' }))
        clear(c.bodyEl)
        c.bodyEl.appendChild(h('div', { class: 'dim ev', text: (framesSnap && framesSnap.error) || '还没取到数据（服务没起？）' }))
        c.btns.send.disabled = c.btns.pause.disabled = true
        return
      }
      // 头部
      clear(c.head1)
      c.head1.appendChild(h('span', { class: 'st-dot st-' + (f.tone || 'off') }))
      // ★ 2026-10-11（用户口径）：`状态:xx` 单独成元素，**把"上下文占用 / 停着…"挂成它的悬停详情**
      //   —— 不再铺在正文里（正文只留真正的动态）。鼠标移上去才展开。
      var stDetail = Array.isArray(f.stateDetail) ? f.stateDetail.filter(Boolean) : []
      var stSpan = h('span', {
        class: 'st-state' + (stDetail.length ? ' st-has-detail' : ''),
        title: stDetail.length ? stDetail.join('\n') : '',
        text: '状态:' + f.stateZh
      })
      c.head1.appendChild(h('span', { text: '职位:' + f.role + '　载体:' + f.carrier + '　' }))
      c.head1.appendChild(stSpan)
      if (f.live && f.live.task) c.head1.appendChild(h('span', { text: '（' + f.live.task + '）' }))
      if (stDetail.length) c.head1.appendChild(h('span', { class: 'st-hint', title: stDetail.join('\n'), text: 'ⓘ' }))
      clear(c.head2)
      var modelFull = String(f.modelText || '—')
      // ★ 2026-10-10（用户口径）：① 六格**格式统一**＝`模型:<名字>` ＋ **独立小标**；
      //   ② 名字**不再按字符数截断**（旧的 `>26 就 …` 让名字只占半行就断了）——
      //      改由 CSS 撑满可用宽度、真放不下才出省略号；③ 小标**每格都有**（`MM-DD 实跑` / `未跑过` / `在用`）。
      var mParts = modelFull.split(' ｜ ')
      var modelBadge = f.modelBadge || mParts[1] || ''
      c.head2.appendChild(h('span', {
        class: 'model-name',
        title: '模型全名：' + modelFull + (f.modelNote ? '\n⚠️ ' + f.modelNote : '')
          + (f.modelUsedAt ? '\n凭据时间：' + f.modelUsedAt : '')
          + (f.quotaTitle ? '\n额度 / 钥匙：' + f.quotaTitle : '\n（没有可展示的额度信息）'),
        text: '模型:' + mParts[0]
      }))
      c.head2.appendChild(h('span', { class: 'model-badge', text: modelBadge || '—' }))
      // ★ 2026-10-16（任务分级 L1–L4）：格头显示**这一跑是哪一级**。
      //   为什么必须显示：【防"看板显示 max 档、实际跑 L1"这种静默过期】—— 用户口径见 KB 重构\任务分级-施工文档.md §4 规矩 5。
      //   数据源＝看板数据的 `f.level`（账本/派活回执现读，缺就空 ⇒ 这一格**一个字都不多**）。
      if (f.level) {
        c.head2.appendChild(h('span', {
          class: 'model-badge lv-badge',
          title: '任务分级：' + f.level + '（' + (f.levelSource || '来源未知') + '）· L1 小改 / L2 写代码 / L3 跨模块 / L4 架构',
          text: f.level
        }))
      }
      // ★ 2026-10-11（用户报障："看板顶部选了异次元，这个会话框的内容没变"）：大脑格**"这是哪条会话"必须固定可见**。
      //   原来这行画在 `sessBlocks` 的**正文第一行**，而正文默认贴底 ⇒ 长会话时它早被滚出视野（用户截图里正是如此）
      //   ⇒ "这条会话的内容里提到别的项目"就被误读成"面板显示的还是上一条会话"。
      //   现在：标题钉在**表头**（不随正文滚），完整 id / 转录路径 / 上下文 / 帧数全在悬停里。
      if (f.role === '大脑') {
        var bd0 = (sessData['大脑'] || {}).data || null
        var ss0 = (bd0 && bd0.session) || null
        var inj0 = bd0 ? (bd0.entries || []).filter(function (e) { return e.kind === 'inject' }).length : 0
        c.head2.appendChild(h('span', {
          class: 'brain-sess',
          title: ss0
            ? ('会话 id：' + String(ss0.id || '?') + (ss0.file ? '\n转录：' + ss0.file : '') +
               (ss0.contextText ? '\n上下文 ' + ss0.contextText : '') +
               ((bd0 && bd0.tail) ? '\n尾巴 ' + String(bd0.tail.framesOk ?? '?') + ' 帧 / 显示 ' + String(Math.max(0, Number(bd0.shown ?? 0) - inj0)) + ' 条' : ''))
            : '还没取到大脑会话（点右上角「会话」再看）',
          text: '会话 · ' + (ss0 ? String(ss0.title || (ss0.id ? String(ss0.id).slice(0, 8) + '…' : '?')) : '取会话中…')
        }))
      }
      // 中部：操作回话（置顶）＋ **两种看法**（最近动态 / 会话）
      //   贴底规则：重画前先记"刚才是不是贴底"，重画后**只有贴底才跟着滚**（你往上翻就不抢）
      var wrapOld = c.bodyEl.querySelector('.ss-wrap')
      if (wrapOld) {
        sessAutoScroll[role] = bodyNearBottom(wrapOld)
        sessScrollTop[role] = wrapOld.scrollTop       // ★ 记住位置：非贴底时重画要恢复（别甩回顶部）
      }
      clear(c.bodyEl)
      if (actionMsg[role]) c.bodyEl.appendChild(evRow(actionMsg[role]))
      if (sessView[role] === 'session') {
        var wrap = h('div', { class: 'ss-wrap' }, sessBlocks(role))
        c.bodyEl.appendChild(wrap)
        // ★ 贴底 ⇒ 跟到最新（与 DSH 会话一样）；**你往上翻过 ⇒ 恢复你那个位置**，不抢、也不甩回顶部
        if (sessAutoScroll[role] !== false) wrap.scrollTop = wrap.scrollHeight
        else if (sessScrollTop[role]) wrap.scrollTop = sessScrollTop[role]
        wrap.addEventListener('scroll', function () {
          sessAutoScroll[role] = bodyNearBottom(wrap)
          sessScrollTop[role] = wrap.scrollTop
        })
      } else {
        var rows = f.recent || []
        if (!rows.length) {
          // ★ 2026-10-11：大脑那格**说清"为什么这儿是空的、内容在哪"** —— 别只丢一句"暂无动态"，
          //   那会让人以为"面板没消息"（用户实测就是这么误会的）。
          c.bodyEl.appendChild(h('div', { class: 'dim ev', text: (f.role === '大脑' && f.brainSessionId)
            ? '大脑不记班组账本 ⇒ 这一栏（最近动态）没有东西；它的会话在「会话」里 —— 点右上角那个按钮（默认已开）'
            : '暂无动态' }))
        }
        rows.forEach(function (r) { c.bodyEl.appendChild(evRow(r)) })
      }
      // ★ 2026-10-11（大脑会话视图）：「会话」开关 —— 大脑那格**按帧数据现判**有没有会话可看。
      //   口径不变（A3 定的）：**没有路就不给点**。取不到 `brainSessionId`（例：没钉工作区 ⇒
      //   不知道哪条是大脑）就禁用＋藏起来，并说明为什么 —— 不留"点了只报错"的死胡同。
      if (f.role === '大脑') {
        var hasSess = Boolean(f.brainSessionId)
        c.btns.sess.disabled = !hasSess
        c.btns.sess.style.display = hasSess ? '' : 'none'
        c.btns.sess.title = hasSess
          ? '看**大脑自己**（DSH 这条会话）说了什么、回了什么 —— 读的是 DSH 的转录，不是班组账本'
          : '看不了：' + (f.brainSessionScope === 'undetermined'
            ? '还没钉工作区 ⇒ 不知道哪条会话是"大脑"（先在看板顶栏选一个）'
            : '看板数据里没有大脑会话（brainRow.sessionPath 为空）')
      }
      // 底部按钮。★ 2026-10-11（大脑会话视图）：**大脑那格三钮另有一套口径** ——
      //   · 发送 ＝ **真插话**（经换会话桥投进 DSH 那条会话；用户 2026-10-11 拍板"打断并入"）
      //   · 暂停 ＝ **让宿主停掉当前那一轮**（它的活不是子进程，没有"杀进程"这回事）
      //   · 继续 ＝ 禁用并说明（大脑**就是**这条会话，没有"续一条会话"这回事 ⇒ 死胡同按钮）
      // ★ 2026-10-14：**能力改由服务端给**（`f.caps`，读 `agents.json` 判的）—— 这里只负责按能力置灰＋悬停说明。
      //   口径定稿：**暂停＝杀 ／ 继续＝插话（带消息框内容续同一条会话）／ 发送＝新会话新派活**。
      var cap0 = f.caps || {}
      if (f.role === '大脑') {
        var canSay = Boolean(f.brainSessionId)
        c.btns.send.disabled = !(cap0.send !== false && canSay)
        c.btns.send.title = canSay
          ? (cap0.whySend || '插话：把这句话投进 DSH 这条会话。')
          : '投不了：看板数据里没有大脑会话（先在看板顶栏钉一个工作区）'
        c.btns.pause.disabled = !(cap0.pause !== false && canSay && f.state === 'running')
        c.btns.pause.title = !canSay
          ? '停不了：看板数据里没有大脑会话（先在看板顶栏钉一个工作区）'
          : (f.state === 'running'
            ? '停：让宿主停掉它当前这一轮（＝DSH 那个"停止"；**点两次确认**。会话与排队的话都不会丢）'
            : '没在跑（暂停只对正在跑的那一轮）')
        c.btns.resume.disabled = cap0.resume === false
        c.btns.resume.title = cap0.whyResume || '续不了：大脑**就是**这条会话本身，没有"续一条会话"这回事。'
      } else {
        var running = f.state === 'running'
        c.btns.pause.disabled = !(cap0.pause !== false && running)
        c.btns.pause.title = running ? '真停：杀掉子进程并写中断收据（点两次确认）' : '没在跑（暂停只对正在跑的那一轮）'
        // ★「继续」＝**插话**：把消息框里那句话带进**同一条会话**续跑。**不要求"正在跑"** ——
        //   正常用法就是"先暂停、再继续"（那时它已经不在跑了）；要求 running 会变成点不了。
        var canResume = cap0.resume !== false
        c.btns.resume.disabled = !canResume
        c.btns.resume.title = canResume
          ? '**插话**：把你打在消息框里的话，带进**同一条会话**接着跑（点一次＝预览拼出的命令；再点一次＝真跑）。消息框空着＝按通用「接着干」续跑。'
          : (cap0.whyResume || '续不了：这个载体没有续跑口。')
        // ★「发送」＝**新会话新派活**（不接前文）。正在跑就拦住 —— 同一个角色不开两条。
        c.btns.send.disabled = !(cap0.send !== false) || running
        c.btns.send.title = running
          ? '它现在正在跑 —— 先「暂停」或等它收活（同一个角色不开两条）'
          : '**新会话**派活：起一个新进程、开一条**全新会话**（**不接前文**，也不接刚被杀掉那条的内容）。点一次＝预览；再点一次＝真跑。'
      }
    })
  }

  /* ── 帧取数（15 秒轮询） ─────────────────────────────────────────────── */
  function loadFrames () {
    // ★ 返回 promise（2026-10-10）：顶栏「刷新」要等它落地才把按钮复原 ⇒ 反馈才是真的
    return fetch('/frames.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { ok: false, error: 'HTTP ' + r.status } })
      .then(function (j) { framesSnap = j; paintBoard() })
      .catch(function (e) { framesSnap = { ok: false, error: String((e && e.message) || e) }; paintBoard() })
  }

  /* ── 格动作（发送/暂停/继续 → /frame-action） ─────────────────────────── */
  function doAction (role, op, text) {
    var c = boardCells[role]
    /* ★ 2026-10-11（大脑会话视图）：**大脑的「发送」是真插话**，走另一条接口 ——
     *   `/brain-say` → 换会话桥 → 宿主 `sessionController.prompt({mode:'steer'})`。
     *   口径（用户 2026-10-11 拍板）：**打断并入** —— 它当前这轮会被打断，这句话并进去接着跑。
     *   ⚠️ 这是**面板第一次能对大脑说话** ⇒ 点之前**把要投的原话摊出来确认**（原话＋投给哪条会话）。
     *   ⚠️ 绝不静默投：确认框里取消就什么都不发。 */
    if (role === '大脑' && op === 'send') {
      var say = String(text || '').trim()
      if (!say) { actionMsg[role] = { kind: 'error', text: '⚠️ 先在消息框里打上要投的话' }; paintBoard(); return }
      var bs = (sessData[role] && sessData[role].data && sessData[role].data.session) || {}
      var f0 = framesOf(role) || {}
      var sid = bs.id || f0.brainSessionId || ''
      var who = String(bs.title || (sid ? sid.slice(0, 8) + '…' : '?'))
      if (!confirm('要往【大脑会话 · ' + who + '】里投这句话吗？\n\n' + say +
        '\n\n模式＝打断并入：它当前这轮会被打断，这句话并进去接着跑。')) return
      actionMsg[role] = { kind: 'status', text: '投递中…' }
      paintBoard()
      fetch('/brain-say', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, text: say, mode: 'steer' })
      }).then(function (r) { return r.json() }).then(function (j) {
        if (j.ok === false) actionMsg[role] = { kind: 'error', text: '✗ 投不进去：' + (j.why || j.error || '失败') }
        else { actionMsg[role] = { kind: 'status', text: '✅ ' + String(j.note || '已投出') }; c.input.value = '' }
        paintBoard()
        // 投完把会话视图重取一次（**投出去 → 宿主落进转录 → 界面看到**，中间有几百毫秒到几秒的延迟，
        //   所以隔两个点各刷一次；再往后就靠那个 15 秒轮询兜着）
        setTimeout(function () { if (sessView[role] === 'session') loadSession(role) }, 2500)
        setTimeout(function () { if (sessView[role] === 'session') loadSession(role) }, 7000)
      }).catch(function (e) {
        actionMsg[role] = { kind: 'error', text: '✗ ' + String((e && e.message) || e) }
        paintBoard()
      })
      return
    }
    /* ★ 2026-10-11（用户："**然后会话运行过程中，这个暂停也点不了**"）：**大脑的「暂停」＝让宿主停掉当前这一轮**
     *   走桥的 `op:'cancel'`（宿主 `session.cancel` ＝ DSH 界面那个"停止"按钮干的事）。
     *   ⚠️ 与「发送（steer）」的区别：steer＝打断**并把你这句话并进去**；暂停＝**只停、不带话**。
     *   两段确认照旧（它是真动作、会中断它手上的活）—— 与载体那格同一套手感。 */
    if (role === '大脑' && op === 'pause') {
      if (!c._pauseArmed) {
        c._pauseArmed = true
        actionMsg[role] = { kind: 'error', text: '⚠️ 再点一次「暂停」才真的停（让宿主停掉它当前这一轮；会话与排队的话都不会丢）' }
        paintBoard()
        setTimeout(function () { c._pauseArmed = false }, 5000)
        return
      }
      c._pauseArmed = false
      var bs2 = (sessData[role] && sessData[role].data && sessData[role].data.session) || {}
      var f2 = framesOf(role) || {}
      var sid2 = bs2.id || f2.brainSessionId || ''
      actionMsg[role] = { kind: 'status', text: '停手中…' }
      paintBoard()
      fetch('/brain-stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid2 })
      }).then(function (r) { return r.json() }).then(function (j) {
        actionMsg[role] = j.ok === false
          ? { kind: 'error', text: '✗ 停不了：' + (j.why || j.error || '失败') }
          : { kind: 'status', text: '✅ ' + String(j.note || '已停') }
        paintBoard()
        setTimeout(function () { loadFrames(); if (sessView[role] === 'session') loadSession(role) }, 1500)
        setTimeout(function () { loadFrames(); if (sessView[role] === 'session') loadSession(role) }, 5000)
      }).catch(function (e) {
        actionMsg[role] = { kind: 'error', text: '✗ ' + String((e && e.message) || e) }
        paintBoard()
      })
      return
    }
    if (op === 'pause') {
      if (!c._pauseArmed) {
        c._pauseArmed = true
        actionMsg[role] = { kind: 'error', text: '⚠️ 再点一次「暂停」才真的停（杀子进程＋写中断收据）' }
        paintBoard()
        setTimeout(function () { c._pauseArmed = false }, 5000)
        return
      }
      c._pauseArmed = false
    }    /* ★ b73（2026-10-13）：「继续」＝**两段**（默认只预览，**再点一次才真续跑**）—— 与「暂停」同一套手感。
       为什么不让它一点就跑：它**真起进程、真花钱**；而且既有判据（`_probe\think-recon\_verify-resume-wiring.mjs`
       等）钉的就是"不显式要求不许 spawn" ⇒ 真跑必须由这一下**显式**触发。
       ★ 2026-10-14：「发送」也并为两段 —— 它现在**也是真起进程**（新会话新派活），同一套手感、同一道防误点。 */
    var execContinue = false
    if (op === 'continue' || op === 'send') {
      if (!c._contArmed) {
        c._contArmed = true
        setTimeout(function () { c._contArmed = false }, 10000)   // 10 秒内不点第二次 ⇒ 自动解除
      } else {
        c._contArmed = false
        execContinue = true
      }
    }
    actionMsg[role] = { kind: 'status', text: '提交中…' }
    paintBoard()
    fetch('/frame-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: op, role: role, text: String(text || ''), execute: execContinue })
    }).then(function (r) { return r.json() }).then(function (j) {
      if (j.ok === false) actionMsg[role] = { kind: 'error', text: '✗ ' + (j.error || '失败') }
      else if (j.dry) {
        actionMsg[role] = {
          kind: 'status',
          text: '预览：' + (j.plan || '') + (j.commandShort ? ' ｜ 拟命令（**还没执行**）：' + j.commandShort : '') +
            (op === 'continue' ? '　⇒ **再点一次「继续」就真续跑**（10 秒内有效）'
              : op === 'send' ? '　⇒ **再点一次「发送」就真起新会话**（10 秒内有效）' : '（' + (j.note || '') + '）')
        }
      } else if (j.op === 'continue') {
        actionMsg[role] = { kind: 'status', text: '✅ 已续跑（接着原会话）：pid ' + j.childPid + ' · ' + (j.note || '') }
        // 立刻刷一次（那格要马上显示"在跑"），随后交给常规节奏
        setTimeout(function () { loadFrames(); if (sessView[role] === 'session') loadSession(role) }, 1200)
        setTimeout(function () { loadFrames(); if (sessView[role] === 'session') loadSession(role) }, 4000)
      } else if (j.op === 'send') {
        actionMsg[role] = { kind: 'status', text: '✅ 已派新活（**新会话**，不接前文）：pid ' + j.childPid + ' · ' + (j.note || '') }
        setTimeout(function () { loadFrames(); if (sessView[role] === 'session') loadSession(role) }, 1200)
        setTimeout(function () { loadFrames(); if (sessView[role] === 'session') loadSession(role) }, 4000)
      } else actionMsg[role] = { kind: 'status', text: String(j.note || '完成') }
      if (j.ok !== false && op === 'send') c.input.value = ''
      paintBoard()
      loadFrames()
    }).catch(function (e) {
      actionMsg[role] = { kind: 'error', text: '✗ ' + String((e && e.message) || e) }
      paintBoard()
    })
  }

  /* ── ★★ b123：「载体」页（用户 2026-10-18："看板的 API 左边加一个按钮，加一个『载体』，
   *    我希望载体插拔化可以在面板进行增删配置"）─────────────────────────────────────
   * 一页把"载体插拔化"能做的三件事摆出来：**改 / 增 / 删 ＋ 现场自检**。
   * 三条口径（与服务端 `载体面板.mjs` 一致，界面上也照实说，不含糊）：
   *   ① 写盘纪律＝**备份 → 写 → 自检 → 不过就整体回滚** ⇒ 这里显示的红绿**就是**起飞闸 ⑦e 那条判据
   *      （每次写操作后服务端都会重跑一次并把结果回传），**不是前端自己猜的**。
   *   ② **删**：还被角色绑着 / 是 defaultAgent ⇒ 服务端**直接拒绝**，并告诉你先改绑 —— 不静默连坐。
   *   ③ **增**：必须选一个「模板载体」—— 翻译器（怎么解析那家 CLI 的输出）**造不出来**，只能照抄一家同款的；
   *      新载体的两个翻译器由服务端从模板复制，并写一行"由「载体」页…生成"（删的时候靠这行认它）。
   */
  var pageCarrier = h('div', { class: 'manage-page' })
  var carrierBox = h('div', null)
  pageCarrier.appendChild(carrierBox)
  var carrierState = { data: null, error: null, busy: false, msg: null, openId: null, addOpen: false, draft: {} }

  function loadCarriers () {
    return fetch('/carriers.json', { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || '取不到载体声明')
        carrierState.data = j
        carrierState.error = null
        renderCarriers()
      })
      .catch(function (e) { carrierState.error = String((e && e.message) || e); renderCarriers() })
  }

  /** 增/改/删的统一入口（**写盘永远走服务端**，前端只发意图）。 */
  function carrierAct (op, payload, ask) {
    if (ask && !confirm(ask)) return
    carrierState.busy = true
    carrierState.msg = { ok: true, text: '执行中…' }
    renderCarriers()
    var body = { op: op }
    for (var k in (payload || {})) body[k] = payload[k]
    fetch('/carriers-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json() })
      .then(function (j) {
        carrierState.busy = false
        carrierState.msg = {
          ok: !!(j && j.ok),
          text: (j && (j.ok ? (j.msg || '已保存') : (j.error || '失败'))) || '（服务端没回话）',
          check: (j && j.selfCheck) || null
        }
        if (j && j.ok) { carrierState.openId = null; carrierState.addOpen = false; carrierState.draft = {} }
        return loadCarriers()
      })
      .catch(function (e) {
        carrierState.busy = false
        carrierState.msg = { ok: false, text: '请求失败：' + String((e && e.message) || e) }
        renderCarriers()
      })
  }

  var CINP = { background: 'transparent', border: '.5px solid var(--line)', borderRadius: '6px', color: 'inherit', padding: '3px 6px', fontSize: '12px' }
  function carrierInput (key, val, width, ph) {
    return h('input', {
      value: val == null ? '' : String(val), placeholder: ph || '', style: Object.assign({}, CINP, { width: width || '150px' }),
      oninput: function (ev) { carrierState.draft[key] = ev.target.value }
    })
  }
  function carrierCheck (key, val, label, title) {
    return h('label', { class: 'tiny', title: title || null, style: { marginRight: '12px', whiteSpace: 'nowrap' } }, [
      h('input', { type: 'checkbox', checked: !!val, onchange: function (ev) { carrierState.draft[key] = ev.target.checked } }),
      ' ' + label
    ])
  }
  function carrierLine (text, tone) {
    return h('div', { style: { color: tone === 'bad' ? 'var(--r)' : (tone === 'ok' ? 'var(--g)' : 'inherit'), fontSize: '12px', margin: '6px 0' }, text: text })
  }
  /* ★ b123：**不能复用页面的 `table()`/`cell()`** —— 那两个只认字符串（`cell()` 里是
   *   `document.createTextNode(...)`），塞 DOM 节点进去会渲染成 `[object …]` 或被丢掉。
   *   实测教训：操作列的「改/删」两个按钮**整列空着**，是真浏览器验收探针（`_probe\_载体页UI验收.mjs`）
   *   逮住的 —— 所以这里自建一张小表：格子是 `{ node }` 就 append 真节点，否则当文本。
   */
  function carrierTable (head, rows) {
    var thead = h('thead', null, h('tr', null, head.map(function (t) { return h('th', { text: t }) })))
    var tbody = h('tbody', null, rows.map(function (r) {
      return h('tr', null, r.map(function (c) {
        var isObj = c && typeof c === 'object' && !c.nodeType
        var td = h('td', { class: (isObj && c.tone) || null, title: (isObj && c.title) || null })
        if (c && c.nodeType) td.appendChild(c)
        else if (isObj && c.node) td.appendChild(c.node)
        else td.appendChild(document.createTextNode(isObj ? String(c.text == null ? '' : c.text) : String(c == null ? '' : c)))
        return td
      }))
    }))
    return h('table', { class: 'tbl' }, [thead, tbody])
  }

  function renderCarriers () {
    clear(carrierBox)
    carrierBox.appendChild(h('header', { class: 'head' }, [
      h('b', { text: '载体 · 插拔化' }),
      h('span', { class: 'dim tiny', text: '加/减一个载体＝声明一条 ＋ agents 段一条 ＋ 两个翻译器 —— 这一页替你做这三件事，且每次写盘都重跑自检' }),
      h('a', { class: 'dim tiny', href: '/carriers.json', target: '_blank', text: '原始数据' })
    ]))
    if (carrierState.error) {
      carrierBox.appendChild(card('载体页取不到数据', [
        h('div', { class: 'dim', text: carrierState.error }),
        h('div', { class: 'dim tiny', text: '先确认 _crew\\carriers.json 在、且面板进程读得到它（读不到时脚本侧会直接抛"没有这个载体"）。' })
      ]))
      return
    }
    var d = carrierState.data
    if (!d) { carrierBox.appendChild(h('div', { class: 'dim', text: '读取中…' })); return }

    if (carrierState.msg) {
      var m = carrierState.msg
      carrierBox.appendChild(carrierLine((m.ok ? '✅ ' : '❌ ') + m.text, m.ok ? 'ok' : 'bad'))
    }

    var sc = d.selfCheck || { ok: false, bad: ['自检没有返回'], rows: [] }
    carrierBox.appendChild(card('自检（与「起飞前检查 ⑦e」同一条判据，不另写一套）', [
      carrierLine(sc.ok ? ('✅ 全过（' + (sc.rows || []).length + ' 条）') : ('❌ ' + ((sc.bad || []).length) + ' 条红'), sc.ok ? 'ok' : 'bad'),
      h('div', {
        class: 'dim tiny',
        style: { whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, Consolas, monospace', maxHeight: '150px', overflow: 'auto' },
        text: (sc.rows || []).map(function (r) { return (r.ok ? '✅ ' : '❌ ') + r.label }).join('\n')
      }),
      h('div', { style: { marginTop: '8px' } }, [
        h('button', { class: 'btn', text: carrierState.busy ? '…' : '重跑自检', disabled: carrierState.busy, onclick: function () { carrierAct('check', {}) } })
      ])
    ]))

    // ── 表：每家一行 ──────────────────────────────────────────────────────
    var rows = (d.carriers || []).map(function (c) {
      var tra = c.shape ? ((c.翻译器 && c.翻译器.adapter ? '✅' : '❌') + '/' + (c.翻译器 && c.翻译器.session ? '✅' : '❌')) : '—'
      var st = c.绑定角色.length ? '在编' : (c.备案 ? '备案' : '未绑定')
      return [
        c.id,
        c.displayName,
        { text: st, tone: c.绑定角色.length ? 'on' : 'dim', title: c.备注 || null },
        c.绑定角色.length ? c.绑定角色.join('、') : '—',
        c.shape || '—',
        { text: tra, title: 'adapters/会话 两个翻译器在不在' },
        c.gatewaySource || '—',
        c.ownsSubscription ? '是' : '否',
        c.needsModelBindingKey ? '是' : '否',
        { text: c.在agents段 ? (c.entry就位 ? '✅' : '⚠️ 路径不在') : '—', title: c.entry || '（agents 段里没有它）' },
        { node: h('span', null, [
          h('button', { class: 'btn', text: '改', onclick: function () { carrierState.openId = (carrierState.openId === c.id ? null : c.id); carrierState.draft = {}; renderCarriers() } }),
          ' ',
          h('button', {
            class: 'btn danger', text: '删',
            onclick: function () {
              carrierAct('delete', { id: c.id }, '删除载体「' + c.id + '」？\n\n（声明与 agents 段里的条目会一起删；自动生成的翻译器也删；手写的翻译器留着）')
            }
          })
        ]) }
      ]
    })
    carrierBox.appendChild(card('载体名单（共 ' + (d.carriers || []).length + ' 家）', [
      carrierTable(['载体', '显示名', '状态', '绑定角色', 'shape', '翻译器', '网关', '自有订阅', '补钥匙', 'entry', ''], rows),
      h('div', { class: 'dim tiny', style: { marginTop: '6px' }, text: '「网关」＝ gatewaySource：model（按模型前缀推）/ route（按路由表）/ own（吃自有清单，不许推）。「补钥匙」＝ 派活时要不要按它自己配置里那条绑定补钥匙变量。' })
    ]))

    // ── 改：展开一格 ─────────────────────────────────────────────────────
    if (carrierState.openId) {
      var cur = (d.carriers || []).filter(function (x) { return x.id === carrierState.openId })[0]
      if (cur) {
        var gw = h('select', { style: Object.assign({}, CINP, { width: '120px' }), value: cur.gatewaySource || 'model', onchange: function (ev) { carrierState.draft.gatewaySource = ev.target.value } },
          (d.形态可选 || ['model', 'route', 'own']).map(function (s) { return h('option', { value: s, text: s }) }))
        carrierBox.appendChild(card('改「' + cur.id + '」', [
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center' } }, [
            h('span', { class: 'tiny dim', text: '显示名' }), carrierInput('displayName', cur.displayName, '150px'),
            h('span', { class: 'tiny dim', text: 'shape' }), carrierInput('shape', cur.shape || '', '150px', '空＝面板不显示它的会话'),
            h('span', { class: 'tiny dim', text: '网关' }), gw
          ]),
          h('div', { style: { marginTop: '8px' } }, [
            carrierCheck('ownsSubscription', cur.ownsSubscription, '自有订阅（不进"换 API"轴、不查我们钥匙）'),
            carrierCheck('needsModelBindingKey', cur.needsModelBindingKey, '派活时补绑定钥匙')
          ]),
          h('div', { style: { marginTop: '8px' } }, [h('span', { class: 'tiny dim', text: '备注' }), ' ', carrierInput('备注', cur.备注, '520px')]),
          h('div', { style: { marginTop: '10px' } }, [
            h('button', { class: 'btn', text: '保存', disabled: carrierState.busy, onclick: function () { carrierAct('update', { id: cur.id, patch: carrierState.draft }) } }),
            ' ',
            h('button', { class: 'btn', text: '取消', onclick: function () { carrierState.openId = null; carrierState.draft = {}; renderCarriers() } })
          ])
        ]))
      }
    }

    // ── 增：模板 + 新 id ─────────────────────────────────────────────────
    var tplSel = h('select', { style: Object.assign({}, CINP, { width: '170px' }), onchange: function (ev) { carrierState.draft.template = ev.target.value } },
      [h('option', { value: '', text: '（选一个模板载体）' })].concat((d.templates || []).map(function (t) { return h('option', { value: t, text: t }) })))
    carrierBox.appendChild(card('新增载体', [
      h('div', { class: 'dim tiny', text: '为什么必须选模板：翻译器是"怎么解析那家 CLI 的输出"，**凭空造不出来**。新载体的 entry/args/env 与两个翻译器都会从模板照抄一份，之后你可以逐项改。' }),
      h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '10px', alignItems: 'center', marginTop: '8px' } }, [
        h('span', { class: 'tiny dim', text: '载体名' }), carrierInput('id', '', '140px', '例：pi2（小写）'),
        h('span', { class: 'tiny dim', text: '显示名' }), carrierInput('displayName', '', '150px', '例：Pi（备用）'),
        h('span', { class: 'tiny dim', text: '模板' }), tplSel,
        h('button', {
          class: 'btn', text: '新增', disabled: carrierState.busy,
          onclick: function () {
            var p = carrierState.draft
            carrierAct('add', { id: p.id, displayName: p.displayName, template: p.template },
              '新增载体「' + (p.id || '?') + '」（模板 ' + (p.template || '?') + '）？\n\n会同时：① 写声明 ② 往 agents 段加一条（照抄模板）③ 复制两个翻译器文件。')
          }
        })
      ]),
      h('div', { class: 'dim tiny', style: { marginTop: '6px' }, text: '⚠️ 新增之后请去「设置」页把某个角色改绑到它，并核对 agents 段里的 entry / args / env 是不是这家的真实情况（照抄的仍是模板那家的）。' })
    ]))
  }

  /* ── 顶栏（照稿）＋ 页切换：看板 / 占位页 / 载体页 / API 页 / 运转链 / 管理页 ───── */
  var stubText = h('span', { class: 'dim', text: '' })
  var pageStub = h('div', { class: 'stub-page' }, stubText)
  var stubOwner = 'stub'           // ★ b204：「运转链」有自己的页了 ⇒ 占位页没有主了（保留机制，别删）
  /* ★ b204：「运转链」页（链路可视化）—— 内容由 `链路页.js` 自己建（`window.__DSH_CHAIN`），
     这里只给它一个宿主容器；2 秒轮询由它自己管（**只在本页可见时轮**，切走就停）。 */
  var pageChain = h('div', { class: 'chain-page' })
  var navBtns = {}
  function setNav (name) { for (var k in navBtns) navBtns[k].classList.toggle('on', k === name) }
  function showView (name) {
    pageBoard.style.display = name === 'board' ? '' : 'none'
    pageStub.style.display = name === 'stub' ? '' : 'none'
    pageCarrier.style.display = name === 'carrier' ? '' : 'none'
    pageApi.style.display = name === 'api' ? '' : 'none'
    pageChain.style.display = name === 'chain' ? '' : 'none'
    pageManage.style.display = name === 'manage' ? '' : 'none'
    setNav(name === 'stub' ? stubOwner : name)
    // 运转链：进页才开轮询、走开就停（省 CPU，也让"实时"只服务于正在看的人）
    if (window.__DSH_CHAIN) { if (name === 'chain') window.__DSH_CHAIN.enter(); else window.__DSH_CHAIN.leave() }
    // 深链同步：切走就把 `#chain…` 摘掉（否则刷新会又跳回来）
    if (name !== 'chain' && /^#chain/.test(String(location.hash || ''))) { try { history.replaceState(null, '', location.pathname + location.search) } catch (e) {} }
  }
  function showStub (owner, label) {
    stubOwner = owner
    stubText.textContent = '「' + label + '」页还没装 —— 先占位（内容后续配置）。'
    showView('stub')
  }
  function topBtn (label, onclick) { return h('button', { class: 'top-btn', text: label, onclick: onclick }) }

  /* ── 顶栏「刷新」：一次刷**所有页** ──────────────────────────────────────
   * 用户口径（2026-10-10）："「看板」按钮右边加一个刷新按钮…这个刷新能刷新所有的页面"。
   * 所以它**不跟着当前视图走**：无论你停在看板 / API / 运转链 / 设置，点一下就把
   *   ① 看板帧（`/frames.json`）② 管理页数据（`/board-data.json`）**两路都重取**，
   * 并等**两路都落地**才把按钮复原（反馈才是真的，不是"点了假装刷了"）。
   * ⚠️ 与已有的两个定时器不冲突：看板 15 秒轮询、管理页 REFRESH_MS 轮询照旧；这里是"立刻来一次"。
   */
  var topRefreshBtn = h('button', { class: 'top-btn top-refresh', text: '刷新', title: '刷新所有页（看板 ＋ 管理页）', onclick: function () { refreshAll() } })

  /* ── ★ 工具服务（19400）＝ 名字 + 状态灯，**本身是一个按钮**（用户 2026-10-11 口径）──
   *   绿＝在跑（点一下**问一句**要不要重启 —— 防误点）；红＝不在跑（点一下**拉起**）。
   *   口径：面板**只管"看 + 拉起"**，它的生死归 DSH（`dsh-crew-bridge` 插件随 DSH 自启）。
   *   灯是**真探活**（服务端会真发一次 `tools/list`，不是只看端口 —— 端口活着但假活也能抓到）。 */
  var toolDot = h('span', { class: 'tool-dot tool-off' })
  var toolLabel = h('span', { text: '工具服务' })
  var toolBtn = h('button', {
    class: 'top-btn tool-btn',
    title: '工具服务（本机 MCP 三工具：查坑 / 核指纹 / 读门禁）—— 状态与手动拉起',
    onclick: function () { onToolBtnClick() }
  }, [toolLabel, toolDot])
  var toolState = { state: null, why: null, tools: null, busy: false, at: 0 }

  function paintTool () {
    toolBtn.disabled = toolState.busy
    toolLabel.textContent = toolState.busy ? '工具服务…' : '工具服务'
    var green = toolState.state === 'green'
    var red = toolState.state === 'red'
    // ⚠️ **三态，别把"未知"归一成红**（2026-10-11 修）：原来写的是 `=== 'green' ? 绿 : (red ? 红 : 灰)`，
    //    但赋值那头是 `j.state === 'green' ? 'green' : 'red'` ⇒ **任何非 green 都被塞成红**，
    //    "探活本身失败"与"服务确实没在跑"混成一个红 —— 那就是**报假红灯**。
    toolDot.className = 'tool-dot ' + (green ? 'tool-on' : (red ? 'tool-err' : 'tool-off'))
    var lines = []
    lines.push('状态：' + (green ? '在跑（绿灯）' : (red ? '没在跑（红灯）' : '还没探到（灰灯）')))
    if (toolState.tools && toolState.tools.length) lines.push('工具 ' + toolState.tools.length + ' 个：' + toolState.tools.join(' / '))
    if (toolState.why) lines.push('原因：' + toolState.why)
    lines.push(red ? '点一下 = 把它拉起来' : (green ? '点一下 = 问你要不要重启（防误点）' : '点一下 = 试着把它拉起来'))
    lines.push('（它的生命周期跟着 DSH：DSH 启动时自动拉起；面板只管看状态和手动拉起）')
    toolBtn.title = lines.join('\n')
  }

  function loadTool (force) {
    return fetch('/relay.json' + (force ? '?force=1' : '') + (force ? '&' : '?') + 't=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { state: 'red', why: 'HTTP ' + r.status } })
      .then(function (j) { applyTool(j) })
      .catch(function (e) { toolState.state = 'unknown'; toolState.why = String((e && e.message) || e); toolState.tools = null; paintTool() })
  }

  /** 三态归一：只有明确的 green / red 才认，其余一律 `unknown`（灰灯），**不假装**。 */
  function applyTool (j) {
    var s = j && j.state
    toolState.state = s === 'green' ? 'green' : (s === 'red' ? 'red' : 'unknown')
    toolState.why = (j && j.why) || null
    toolState.tools = (j && j.tools) || null
    toolState.at = Date.now()
    paintTool()
  }

  function onToolBtnClick () {
    if (toolState.busy) return
    // 绿：先问一句（防误点）——用户原话是"红灯的时候我就点击"，绿灯就给个确认
    if (toolState.state === 'green' && !confirm('工具服务正在跑。要重启它吗？\n\n（重启会短暂中断三个本机工具；正常情况不需要点。）')) return
    toolState.busy = true; paintTool()
    fetch('/relay-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ op: 'start' })
    }).then(function (r) { return r.json() }).then(function (j) {
      toolState.busy = false
      actionMsg.__tool = { kind: j.ok ? 'status' : 'error', text: j.ok ? ('工具服务：' + (j.started ? '已拉起 ✅' : '本来就在跑')) : ('工具服务拉起失败：' + (j.why || '?')) }
      return loadTool(true)
    }).catch(function (e) {
      toolState.busy = false
      actionMsg.__tool = { kind: 'error', text: '工具服务操作失败：' + String((e && e.message) || e) }
      paintTool()
    })
  }
  paintTool()

  /* ── ★★ b49：**路由网关（19420）＝ 名字 + 状态灯**，与「工具服务 ●」并排（用户口径：
   *   "这个B最小版要绑定在班组看板里最好，这样班组看板打开，同时路由也跟着起来，黑框要隐藏，和 看板 工具服务 一样"）。
   *   绿＝在跑（走网关的载体能干活）｜红＝没在跑（**走网关的载体现在会直接失败，不回落直连** —— 用户拍板 A）。
   *   点一下：红灯＝拉起；绿灯＝问一句再重启（防误点）。三态归一与工具服务同一口径（未知≠红）。 */
  var routeDot = h('span', { class: 'tool-dot tool-off' })
  var routeLabel = h('span', { text: '路由' })
  var routeBtn = h('button', {
    // ⚠️ 用**独立类名**：探针 `_工具服务灯UI验收.mjs` 是按 `.tool-btn` 抓"工具服务"那颗的，
    //   沿用同一个类名会让它抓到我这颗（b49 实测踩到，14 项红）。
    class: 'top-btn route-btn',
    title: '路由网关（本机 127.0.0.1:19420）—— 按 /<家>/… 转发并补头、换钥匙；状态与手动拉起',
    onclick: function () { onRouteBtnClick() }
  }, [routeLabel, routeDot])
  var routeState = { state: null, why: null, homes: null, hits: null, busy: false, at: 0 }

  function paintRoute () {
    routeBtn.disabled = routeState.busy
    routeLabel.textContent = routeState.busy ? '路由…' : '路由'
    var green = routeState.state === 'green'
    var red = routeState.state === 'red'
    routeDot.className = 'tool-dot ' + (green ? 'tool-on' : (red ? 'tool-err' : 'tool-off'))
    var lines = []
    lines.push('状态：' + (green ? '在跑（绿灯）' : (red ? '没在跑（红灯）' : '还没探到（灰灯）')))
    if (routeState.homes && routeState.homes.length) lines.push('认得的家 ' + routeState.homes.length + ' 个：' + routeState.homes.join(' / '))
    if (routeState.hits && Object.keys(routeState.hits).length) lines.push('已转发：' + Object.keys(routeState.hits).map(function (k) { return k + '×' + routeState.hits[k] }).join('　'))
    if (routeState.why) lines.push('原因：' + routeState.why)
    lines.push(red ? '点一下 = 把它拉起来' : (green ? '点一下 = 问你要不要重启（防误点）' : '点一下 = 试着把它拉起来'))
    lines.push('（它跟着**班组看板**：看板一起来就把它拉起来，黑框隐藏；载体侧 baseUrl 指向它 ⇒ 同名跨家由路径区分）')
    routeBtn.title = lines.join('\n')
  }

  function loadRoute (force) {
    return fetch('/router.json' + (force ? '?force=1&' : '?') + 't=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { state: 'red', why: 'HTTP ' + r.status } })
      .then(function (j) { applyRoute(j) })
      .catch(function (e) { routeState.state = 'unknown'; routeState.why = String((e && e.message) || e); routeState.homes = null; paintRoute() })
  }
  function applyRoute (j) {
    var s = j && j.state
    routeState.state = s === 'green' ? 'green' : (s === 'red' ? 'red' : 'unknown')
    routeState.why = (j && j.why) || null
    routeState.homes = (j && j.homes) || null
    routeState.hits = (j && j.hits) || null
    routeState.at = Date.now()
    paintRoute()
  }
  function onRouteBtnClick () {
    if (routeState.busy) return
    if (routeState.state === 'green' && !confirm('路由网关正在跑。要重启它吗？\n\n（重启会短暂中断走网关的载体；正常情况不需要点。）')) return
    routeState.busy = true; paintRoute()
    // 拉起/重启都走同一个口（`force=1` 会探活，没起来就 detached+windowsHide 拉起来）
    loadRoute(true).then(function () {
      routeState.busy = false
      actionMsg.__route = { kind: routeState.state === 'green' ? 'status' : 'error', text: routeState.state === 'green' ? '路由网关：已就绪 ✅' : ('路由网关起不来：' + (routeState.why || '?')) }
      paintRoute()
    }).catch(function (e) {
      routeState.busy = false
      actionMsg.__route = { kind: 'error', text: '路由网关操作失败：' + String((e && e.message) || e) }
      paintRoute()
    })
  }
  paintRoute()

  /* ── ★★ b88：**长命资源 ●** —— 第三颗灯，与「工具服务 ●」「路由 ●」并排（用户 2026-10-16 拍板做 4）。
   *   治的病：「长命东西的归属挂在会话上」⇒ 换会话后旧会话起的后端还在跑、**没人知道它是谁的**
   *   （2026-10-13 实况：`npm run dev` 听 3000，DSH 右上角"1 个后台任务运行中 · 48 分 5 秒"）。
   *   判据**全在** `_unattended\登记服务.mjs` 的 `verify()`，面板不自己判（免得两套口径）：
   *     绿＝登记的都对得上（pid 活着、端口属主一致）
   *     黄＝**有孤儿**（未登记的监听进程）**或**端口属主与登记不符 —— 悬停里点名"pid X 听 Y"
   *     红＝登记为"该活着"的**已经死了**
   *   点一下＝重查 ＋ 只把"死了且有 `ensure` 脚本"的项拉起来；⚠️ **孤儿只报告、不擅自杀**。
   *   ⚠️ 类名用 `longlive-btn`（别复用 `.tool-btn`）—— 探针 `_工具服务灯UI验收.mjs` 是按 `.tool-btn` 抓那颗的。 */
  var longliveDot = h('span', { class: 'tool-dot tool-off' })
  var longliveLabel = h('span', { text: '长命资源' })
  var longliveBtn = h('button', {
    class: 'top-btn longlive-btn',
    title: '长命资源（登记册 `_crew\\服务登记.json`）—— 谁的、还活着吗、有没有孤儿；点一下重查',
    onclick: function () { onLongliveBtnClick() }
  }, [longliveLabel, longliveDot])
  var longliveState = { state: null, verdict: null, orphans: null, dead: null, mismatch: null, busy: false, at: 0 }

  function paintLonglive () {
    longliveBtn.disabled = longliveState.busy
    longliveLabel.textContent = longliveState.busy ? '长命资源…' : '长命资源'
    var green = longliveState.state === 'green'
    var yellow = longliveState.state === 'yellow'
    var red = longliveState.state === 'red'
    longliveDot.className = 'tool-dot ' + (green ? 'tool-on' : (yellow ? 'tool-warn' : (red ? 'tool-err' : 'tool-off')))
    var lines = []
    lines.push('状态：' + (green ? '一致（绿灯）' : (yellow ? '有孤儿 / 属主不符（黄灯）' : (red ? '有该活着的死了（红灯）' : '还没探到（灰灯）'))))
    if (longliveState.verdict) lines.push(longliveState.verdict)
    if (longliveState.orphans && longliveState.orphans.length) {
      lines.push('孤儿（**未登记**的监听进程）：')
      longliveState.orphans.slice(0, 6).forEach(function (o) { lines.push('  · pid ' + o.pid + ' 听 ' + o.port + '（' + o.name + '）') })
    }
    if (longliveState.dead && longliveState.dead.length) {
      lines.push('该活着却死了：')
      longliveState.dead.slice(0, 6).forEach(function (d) { lines.push('  · ' + d.name + '（' + (d.why || '?') + '）') })
    }
    if (longliveState.mismatch && longliveState.mismatch.length) {
      lines.push('端口属主与登记不符：')
      longliveState.mismatch.slice(0, 6).forEach(function (m) { lines.push('  · ' + m.name + '（' + (m.why || '?') + '）') })
    }
    lines.push(longliveState.busy ? '正在重查…' : '点一下 = 重查 ＋ 拉起"死了且有 ensure 脚本"的项（孤儿只报告，不擅自杀）')
    lines.push('（登记册唯一写入口 = `_unattended\\登记服务.mjs`；看护每 5 分钟也会核一次并写进 `_crew\\看护状态.json`）')
    longliveBtn.title = lines.join('\n')
  }

  function loadLonglive (force) {
    return fetch('/longlive.json' + (force ? '?force=1&' : '?') + 't=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : { state: 'unknown', why: 'HTTP ' + r.status } })
      .then(function (j) { applyLonglive(j) })
      .catch(function (e) { longliveState.state = 'unknown'; longliveState.verdict = String((e && e.message) || e); paintLonglive() })
  }

  function applyLonglive (j) {
    var s = j && j.state
    longliveState.state = (s === 'green' || s === 'yellow' || s === 'red') ? s : 'unknown'
    longliveState.verdict = (j && (j.verdict || j.why)) || null
    longliveState.orphans = (j && j.orphans) || null
    longliveState.dead = (j && j.dead) || null
    longliveState.mismatch = (j && j.mismatch) || null
    longliveState.at = Date.now()
    paintLonglive()
  }

  function onLongliveBtnClick () {
    if (longliveState.busy) return
    var extra = (longliveState.orphans && longliveState.orphans.length) ? ('\n\n（这一下**不会杀**任何进程：孤儿只是报告，要停谁得显式说。）') : ''
    if (!confirm('重查长命资源：核对登记册 ↔ 现实，并把"该活着却死了"的项拉起来。' + extra)) return
    longliveState.busy = true; paintLonglive()
    fetch('/longlive-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ op: 'refresh' }) })
      .then(function (r) { return r.json() })
      .then(function (j) {
        longliveState.busy = false
        var rev = (j && j.revived) || []
        actionMsg.__longlive = {
          kind: j && j.ok ? 'status' : 'error',
          text: j && j.ok
            ? ('长命资源：' + (j.state === 'green' ? '一致 ✅' : ('仍' + (j.verdict || '?'))) + (rev.length ? ('；拉起 ' + rev.length + ' 项：' + rev.map(function (x) { return x.name + (x.ok ? '✅' : '❌') }).join('、')) : ''))
            : ('长命资源：' + ((j && (j.verdict || j.error)) || '?'))
        }
        applyLonglive(j)
      })
      .catch(function (e) {
        longliveState.busy = false
        actionMsg.__longlive = { kind: 'error', text: '长命资源操作失败：' + String((e && e.message) || e) }
        paintLonglive()
      })
  }
  paintLonglive()

  function refreshAll () {
    topRefreshBtn.disabled = true
    topRefreshBtn.textContent = '刷新中…'
    var settle = function () {
      topRefreshBtn.disabled = false
      topRefreshBtn.textContent = '刷新'
      var t = new Date()
      topRefreshBtn.title = '刷新所有页（看板 ＋ 管理页）｜上次刷新 ' + t.toLocaleTimeString('zh-CN', { hour12: false })
    }
    Promise.all([Promise.resolve(loadFrames()), Promise.resolve(load({ manual: true }))]).then(settle, settle)
  }

  navBtns.board = topBtn('看板', function () { showView('board') })
  // ★ b123（用户 2026-10-18）：**「载体」在「API」左边** —— 首次点进来才拉数据（没点就不打扰服务端）。
  navBtns.carrier = topBtn('载体', function () {
    showView('carrier')
    if (!carrierState.data && !carrierState.error) loadCarriers()
  })
  // ★ b125（用户 2026-10-18）：**「API」有自己的页了** —— 「API 额度 / 职位模型」整块从「设置」搬来这里。
  navBtns.api = topBtn('API', function () { showView('api') })
  // ★ b204：**「运转链」是真页了**（原来点它进占位页"还没装"）—— 内容由 `链路页.js` 建，见那边的头注释。
  navBtns.chain = topBtn('运转链', function () { showView('chain'); if (location.hash !== '#chain') { try { history.replaceState(null, '', '#chain') } catch (e) {} } })
  navBtns.manage = topBtn('设置', function () { showView('manage') })

  /* 顶栏右下角**显示当前构建号**（`/health` 的 tag）——
   * 起因（2026-10-10 用户："没看到 B6 在跑"）：面板改过之后，肉眼**没有任何地方**能看出跑的是哪一版，
   * 只能去命令行查 `/health`；而窗口若是改版前开的，看起来和"没生效"一模一样。
   * 口径照旧：取不到就**留空**，不猜。 */
  var buildTagEl = h('span', { class: 'dim tiny build-tag', text: '' })
  fetch('/health', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null })
    .then(function (j) {
      if (!j || !j.tag) return
      buildTagEl.textContent = String(j.tag).replace(/^panel@/, '')
      buildTagEl.title = '面板构建：' + j.tag + '（服务端口 ' + (j.port ?? '?') + '）'
    })
    .catch(function () {})

  /* ── 顶栏中间：**工作区选择器**（2026-10-10 用户口径）────────────────────
   * "做项目要先选工作区；直接让 DSH 的工作区和看板对齐；我在看板顶部可以手动钉。"
   * 选中即写 `_crew\当前项目.txt`（＝**显式钉住**）→ 服务端重生成看板数据 → 这里刷新。
   * ★ 顶部**永远显示当前是「钉住 X」还是「跟随会话」** —— 上次出事就是"钉了但界面上看不出来"。
   */
  var wsSel = h('select', { class: 'ws-sel', title: '选择工作区：选中＝钉住看板显示哪个项目；「跟随会话（不钉）」＝清钉' })
  var wsState = h('span', { class: 'ws-state', text: '工作区…' })
  /* ★ 2026-10-11（用户截图实测："下拉写**在跑**、大脑那格写**空闲**"同框自相矛盾）：
   *   旧实现只在**页面加载**与**切钉后 1.2 秒**各读一次 `/workspaces`，之后再**没有任何刷新**
   *   ⇒ 下拉会一直挂着几十分钟前那一刻的值（而大脑那格是每次读都按当前时刻重算的）。
   *   两层修：
   *     ① **文本本地算活**：`lastSecAgo` 是"取回那一刻"的秒数 ⇒ 加上"取回至今"的秒数再显示，不再冻结；
   *     ② **"在跑"对钉住那条直接用大脑帧的 `state`**（＝ `turnStateOf` 的结论，与大脑那盏灯**同一处判据**）；
   *        其余工作区沿用服务端口径（最后写入窗口 10s，与 `工作区.mjs` 的 `runningOf` 同值）。
   */
  var wsList = []
  var wsPinned = ''
  var wsFetchedAt = 0
  var WS_RUNNING_WINDOW_SEC = 10        // ⚠️ 必须与 `工作区.mjs` 的 `RUNNING_WINDOW_SEC` 同值
  function wsAgeSec (w) {
    if (w.lastSecAgo == null) return null
    return w.lastSecAgo + (Date.now() - wsFetchedAt) / 1000
  }
  function wsRunning (w) {
    if (wsPinned && String(w.path) === String(wsPinned)) {
      var f = framesOf('大脑')           // 钉住那条 === 看板认为的"大脑" ⇒ 直接用它，别另算一套
      if (f) return f.state === 'running'
    }
    var a = wsAgeSec(w)
    return a != null && a <= WS_RUNNING_WINDOW_SEC
  }
  function wsText (w) {
    var a = wsAgeSec(w)
    return w.name + '（' + w.sessions + ' 会话 · ' + (wsRunning(w) ? '在跑' : (a == null ? '—' : C.agoText(a))) + '）'
  }
  function loadWorkspaces () {
    fetch('/workspaces', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null }).then(function (j) {
      if (!j || !j.ok) { wsState.textContent = '工作区列表取不到'; return }
      wsList = j.list || []
      wsPinned = j.pinned || ''
      wsFetchedAt = Date.now()
      clear(wsSel)
      wsSel.appendChild(h('option', { value: '', text: '跟随会话（不钉）' }))
      wsList.forEach(function (w) {
        wsSel.appendChild(h('option', { value: w.path, text: wsText(w) }))
      })
      wsSel.value = wsPinned
      var hit = wsList.find(function (x) { return x.path === wsPinned })
      wsState.textContent = wsPinned ? ('钉住：' + (hit ? hit.name : wsPinned)) : '跟随会话'
    }).catch(function () { wsState.textContent = '工作区列表取不到' })
  }
  /** 只把**文本**按当前时刻重算（不重建 DOM、不打扰服务端）；你正在拉这个下拉时不动它。 */
  function repaintWsTexts () {
    if (!wsList.length) return
    if (document.activeElement === wsSel) return
    var opts = wsSel.options || []            // ⚠️ 桩 DOM（`_probe\_桩DOM.mjs`）不实现 options ⇒ 空数组兜底
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i]
      var w = wsList.find(function (x) { return String(x.path) === String(o.value) })
      if (!w) continue
      var t = wsText(w)
      if (o.text !== t) o.text = t
    }
  }
  setInterval(repaintWsTexts, 5000)
  // ⚠️ 这里**不能**再来一个 `setInterval(..., 60000)`：两件探针（`_自动刷新不冲表单实测` /
  //   `_自动刷新不打断选模型实测`）靠"**捕获那个唯一的 60000ms 定时器回调**"来验"正在编辑 ⇒ 整轮跳过"，
  //   多一个同周期定时器会把它们的捕获打偏（实测：加了之后那两件各红 2 项）。
  //   ⇒ 改挂在**帧轮询节奏**上，内部节流到 ~60 秒（目的只是把"会话数"这类变化捞回来）。
  setInterval(function () { if (Date.now() - wsFetchedAt > 55000) loadWorkspaces() }, FRAMES_MS + 1000)
  wsSel.onchange = function () {
    var want = wsSel.value || ''
    wsState.textContent = '切换中…'
    fetch('/pin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: want || null }) })
      .then(function (r) { return r.json() }).then(function (j) {
        wsState.textContent = j.ok ? (j.after ? '已钉住' : '已改为跟随会话') : ('✗ ' + (j.error || '失败'))
        refreshAll()
        // ★ 2026-10-11（用户报障："看板顶部选了异次元，这个会话框的内容没变"）：切钉成功后**必须立刻重取会话格**
        //   —— 原来只重取帧＋管理页数据（`refreshAll()`），会话格要等下面那个 **15.5 秒**的定时器才换内容
        //   ⇒ 你切完看一眼，看到的是**上一条会话**，自然以为"没生效"。
        //   （服务端此刻已按新项目重生成看板数据，见 `工作区.mjs` 的 `pinProject`。）
        if (j.ok) FRAME_ROLES.forEach(function (r) { if (sessView[r] === 'session') loadSession(r) })
        setTimeout(loadWorkspaces, 1200)
      }).catch(function (e) { wsState.textContent = '✗ ' + String((e && e.message) || e) })
  }
  loadWorkspaces()

  var topbarEl = h('header', { class: 'topbar' }, [
    h('div', { class: 'top-side' }, [navBtns.board, topRefreshBtn, toolBtn, routeBtn, longliveBtn]),
    h('div', { class: 'top-mid' }, [wsSel, wsState]),
    h('div', { class: 'top-side' }, [restartBtn, navBtns.carrier, navBtns.api, navBtns.chain, navBtns.manage, buildTagEl])
  ])

  /* ── 装配：顶栏 ＋ 看板页（默认）＋ 占位页 ＋ 载体页 ＋ API 页 ＋ 管理页 ── */
  var head = h('header', { class: 'head' }, [
    h('b', { text: '班组看板 · 管理页' }),
    stampEl,
    refreshBtn,
    h('a', { class: 'dim tiny', href: '/board-data.json', target: '_blank', text: '原始数据' })
  ])
  // ★ b125：API 页自己的头（不放「刷新」—— 顶栏那个「刷新」已经一次刷所有页）
  var apiHead = h('header', { class: 'head' }, [
    h('b', { text: 'API 额度 / 职位模型' }),
    h('span', { class: 'dim tiny', text: '改完立刻写进 _crew\\agents.json —— 下一次派活就生效（不用重启）' }),
    h('a', { class: 'dim tiny', href: '/board-data.json', target: '_blank', text: '原始数据' })
  ])
  var pageApi = h('div', { class: 'manage-page' }, [apiHead, apiBox])
  var pageManage = h('div', { class: 'manage-page' }, [head, body])
  var rootEl = document.getElementById('app')
  append(rootEl, [topbarEl, pageBoard, pageStub, pageCarrier, pageApi, pageChain, pageManage])
  // ★ 2026-10-26（按用户截图修的）：两条状态条**必须放进 .board-page 里面**。
  //   `.board-page` 是 `height: calc(100vh - 46px)` 的 flex 列，`.board-grid` 靠 `flex:1; min-height:0` 让位
  //   （CSS 里 b126 那段注释说的就是这个坑）。我原来把它们挂在 rootEl 上，多占 ~56px ⇒
  //   底部那排卡的输入框被切到屏幕外，正是截图里看到的"卡片被底边裁掉"。
  try {
    pageBoard.insertBefore(dispatchEl, pageBoard.firstChild)
    pageBoard.insertBefore(overviewEl, pageBoard.firstChild)
  } catch (e) { console.warn('状态条挂载失败', e) }
  // ★ b204：把宿主容器交给「运转链」页（它自己建图、自己轮询；这里只是挂载一次）
  if (window.__DSH_CHAIN) { try { window.__DSH_CHAIN.mount(pageChain) } catch (e) { console.warn('运转链挂载失败', e) } }
  /* ★ b204：深链 `#chain`（或 `#chain/<用电器>` 直接开抽屉）—— 刷新后停在你那一页（截图核对也靠它）。
     ⚠️ 必须**先读 hash 再 showView**：`showView('board')` 里会把 `#chain` 摘掉（那是"切走时清深链"的逻辑），
     先调它就把深链抹了 ⇒ 首页永远停在看板（b204 第一版踩过，截图核对逮到）。 */
  var bootHash = String(location.hash || '').replace(/^#/, '')
  var bootView = (bootHash === 'chain' || bootHash.indexOf('chain/') === 0) ? 'chain' : 'board'
  showView(bootView)
  loadShell()                      // ★ b126：看一眼「外壳」要不要问用户（没表态才显示那条提示）
  // ★ 2026-10-11（用户实测："可是看板会话框没有消息"）：**大脑那格默认就开在「会话」上**。
  //   为什么：它的"最近动态"**永远是空的** —— 大脑不走编排、不产生派活回执，`f.recent` 自然没东西
  //   ⇒ 默认给列表的话，那格永远显示"暂无动态"，而**真内容（它说了什么、回了什么）藏在右上角那个开关后面**。
  //   实测过：`/brain-session.json` 明明有 67 条（用户发的话、我的回复都在），界面上却像"没有消息"。
  //   ⚠️ 只对**大脑**改默认；五个职位那格照旧默认"最近动态"（它们的动态是有的、且便宜）。
  sessView['大脑'] = 'session'
  if (boardCells['大脑'] && boardCells['大脑'].btns.sess) boardCells['大脑'].btns.sess.classList.add('on')
  loadSession('大脑')
  loadFrames()
  setInterval(loadFrames, FRAMES_MS)
  // ★ 会话视图的"长出来"：**只对正在跑、且开着会话的格**重取（没开/没跑就不打扰）。
  //   放在帧轮询之后一点（帧先落地，状态才准）；重取会 paintBoard，所以节流成同一节奏。
  //   ★ 2026-10-11（大脑会话视图）：**大脑那格不按 `state` 卡** —— 它的状态是"转录最后写入
  //     多少秒前（窗口 10s）"，而**读它的代价很小**（只解尾巴 60 帧 ≈ 几毫秒）⇒
  //     只要会话视图开着就跟着重取，不必等它"亮灯"。
  setInterval(function () {
    FRAME_ROLES.forEach(function (role) {
      if (sessView[role] !== 'session') return
      var f = framesOf(role)
      if (!f) return
      if (role !== '大脑' && f.state !== 'running') return
      if (sessData[role] && sessData[role].loading) return
      loadSession(role)
    })
  }, FRAMES_MS + 500)
  paintStamp()
  load()
  setInterval(load, REFRESH_MS)
  setInterval(paintStamp, TICK_MS)
  // ★ 工具服务状态：进页先探一次，然后跟帧同一个节奏（15 秒）重探。
  //   服务端有 5 秒缓存 ⇒ 不会每次轮询都 spawn 一次探活。
  loadTool()
  setInterval(function () { if (!toolState.busy) loadTool() }, FRAMES_MS)
  // ★ b49：路由网关那颗灯跟着同一节奏（15 秒）重探；探活会顺手把它拉起来（看板开着 ⇒ 路由就在）
  loadRoute()
  setInterval(function () { if (!routeState.busy) loadRoute() }, FRAMES_MS)
  // ★ b88：长命资源那颗灯 —— 服务端有 10 秒缓存（`verify()` 要问一次系统监听表），节奏与上面两颗一致。
  loadLonglive()
  setInterval(function () { if (!longliveState.busy) loadLonglive() }, FRAMES_MS)
})()
