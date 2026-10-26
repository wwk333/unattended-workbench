/**
 * 运转链（链路可视化）· 客户端整页
 * ★ b204：按《链路可视化-施工文档》施工。**只读**：只拉 `/chain.json`（2 秒一次）与 `/chain-detail?id=`，
 *   不写任何文件、不跑任何脚本、不调模型。
 *
 * 图怎么读（用户口径，别改）：
 *   · **用电器**＝几乎每次都运转的件（方框）；**电流**＝活流过的那条通路。
 *   · 亮着且有点在流动的那几段＝活现在经过的路＝**链路**；暗的段＝**断的**（不是坏了，是没活）。
 *   · 每条线都能点：点一下看它**为什么通／为什么断**（判据原句，不是编的）。
 *   · 主干上「闸」那个方框 = 元件排的入口（一个脚本一格，格子大小＝一次活能干多久）。
 *
 * 实现纪律：原生 DOM ＋ 手写 SVG（不引框架、不加运行时）；轮询只在页面可见时跑。
 * ⚠️ 方框里的字**必须裁**：SVG 的 `<text>` 不会换行也不会自动省略 ⇒ 先按估算宽度截（`fit`），
 *    外层再加 `<clipPath>` 兜底（两道，缺一道就会出现"字冲出方框"——b204 第一版就是）。
 */
(function () {
  'use strict'
  var C = window.__DSH_BOARD_CORE || {}
  var CHAIN_MS = 1000
  var DETAIL_MS = 1000
  var NS = 'http://www.w3.org/2000/svg'

  /* ── 几何（viewBox 1200×440）：主回路一行 → 常驻两件在中带 → 回流一行；
        ★ 2026-10-23（D26）：载体那一格拆成 **2 列 × 3 行共 5 个方框**，右侧上下两条"总线"把它们
        并进同一条主干（逻辑线仍是 3 条，框到总线之间是装饰性的细线，不参与通电判定）。
        改坐标只改这里；渲染里不许再写死数字。 ── */
  var BOX = {
    rules: { x: 16, y: 40, w: 160, h: 86 },
    brain: { x: 216, y: 40, w: 180, h: 86 },
    dispatch: { x: 436, y: 40, w: 160, h: 86 },
    orch: { x: 636, y: 40, w: 160, h: 86 },
    /* 5 个载体：左列 836..996，右列 1004..1164；三行 y=16/112/208，h=88。
       高度从 76 加到 88：上下文那行（第二行指标）不再被卡片底边吃掉。 */
    'coder-a': { x: 836, y: 16, w: 160, h: 88 },
    'coder-b': { x: 836, y: 112, w: 160, h: 88 },
    reviewer: { x: 836, y: 208, w: 160, h: 88 },
    researcher: { x: 1004, y: 16, w: 160, h: 88 },
    rescue: { x: 1004, y: 112, w: 160, h: 88 },
    checks: { x: 216, y: 170, w: 240, h: 76 },
    review: { x: 466, y: 170, w: 160, h: 76 },
    tools: { x: 636, y: 170, w: 184, h: 76 },
    /* 回流一行整体下移 40px，让红框/画布真正向下扩展，而不是只把字往上挤 */
    you: { x: 16, y: 330, w: 240, h: 84 },
    board: { x: 296, y: 330, w: 240, h: 84 },
    ledger: { x: 576, y: 330, w: 240, h: 84 },
    outbox: { x: 856, y: 330, w: 240, h: 84 }
  }
  /* 总线：右侧两条竖线（x=826 / x=1172）＋ 上下两条横线，把 5 个载体并到主干上 */
  var BUS = {
    left: 826, right: 1172, top: 8, bottom: 300,
    stubY: [60, 156, 252]          // 三行方框的竖向中点
  }
  /* 连线：折线点位（每条自己算好，别让渲染去猜） */
  var WIRE = {
    'rules>brain': [[176, 83], [216, 83]],
    'brain>dispatch': [[396, 83], [436, 83]],
    'dispatch>orch': [[596, 83], [636, 83]],
    'orch>carrier': [[796, 83], [BUS.left, 83]],
    'carrier>outbox': [[976, BUS.bottom], [976, 330]],
    'outbox>ledger': [[856, 372], [816, 372]],
    'ledger>board': [[576, 372], [536, 372]],
    'board>you': [[296, 372], [256, 372]],
    /* 你看板 → 大脑：从左下竖着上去，再横过去接大脑底边 */
    'you>brain': [[136, 330], [136, 150], [270, 150], [270, 126]],
    /* 闸 → 大脑：短竖线直上（闸就在大脑下方） */
    'checks>brain': [[336, 170], [336, 126]],
    /* 闸 → 编排：从闸顶绕到中带上沿（y=155）再上去，避开新加的「审核」框 */
    'checks>orch': [[446, 170], [446, 155], [616, 155], [616, 140], [660, 140], [660, 126]],
    /* 闸 → 审核 → 看板（D15：审核是链上一环） */
    'checks>review': [[456, 208], [466, 208]],
    'review>board': [[546, 246], [546, 280], [400, 280], [400, 330]],
    /* 工具 → 大脑：从工具顶上出来，走 y=150 那条空走廊横到大脑 */
    'tools>brain': [[656, 170], [656, 150], [310, 150], [310, 126]],
    /* 工具 → 载体：从工具右侧出来，接到左总线 */
    'tools>carrier': [[820, 208], [BUS.left, 208]]
  }

  var S = { on: false, mounted: false, timer: 0, detailTimer: 0, data: null, err: null, at: 0, sel: null, detail: null, detailErr: null, whyId: null, prevFlash: {},
    // ★ D25：电流日志的展开状态**存在这里**（module 级），绝不进 DOM —— 那一片每秒重建，存在 DOM 上必然被刷掉
    eventsOpen: false, lastEvents: null }

  /* ── 小工具 ── */
  function h (tag, attrs, kids) {
    var el = document.createElement(tag)
    if (attrs) for (var k in attrs) {
      var v = attrs[k]
      if (v == null || v === false) continue
      if (k === 'class') el.className = String(v)
      else if (k === 'text') el.textContent = String(v)
      else if (k === 'style' && typeof v === 'object') { for (var s in v) el.style[s] = v[s] }
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
      else if (v === true) el.setAttribute(k, '')
      else el.setAttribute(k, String(v))
    }
    if (kids) (Array.isArray(kids) ? kids : [kids]).forEach(function (c) { if (c != null) el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c) })
    return el
  }
  function sv (tag, attrs) {
    var el = document.createElementNS(NS, tag)
    if (attrs) for (var k in attrs) if (attrs[k] != null) el.setAttribute(k, String(attrs[k]))
    return el
  }
  function agoText (sec) { return (sec == null) ? '—' : (C.agoText ? C.agoText(sec) : (sec < 60 ? sec + ' 秒前' : Math.round(sec / 60) + ' 分钟前')) }
  /** 服务端文案里带 markdown 强调（`**…**`）—— 界面上要剥掉，别把星号画给人看。 */
  function plain (s) { return String(s == null ? '' : s).replace(/\*\*/g, '').replace(/`/g, '') }
  /** 按**估算宽度**截字（中日韩按 1.0×字号，西文按 0.55×），超了加省略号。 */
  function fit (s, maxPx, fontPx) {
    s = plain(s)
    var w = 0
    var out = ''
    for (var i = 0; i < s.length; i++) {
      var ch = s[i]
      var cw = /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? fontPx : fontPx * 0.55
      if (w + cw > maxPx - fontPx) { return out + '…' }
      w += cw
      out += ch
    }
    return out
  }

  /* ── 结构（只建一次）── */
  var refs = {}
  function build (root) {
    root.innerHTML = ''
    var chips = h('div', { class: 'chain-chips' })
    // ★ 第二条看板：把"当前上下文占用"和"转录窗口累计"分开。
    //   原来只有一条"窗口用量"＝转录尾巴里 60 帧的输入+输出累计，容易被误读成"当前窗口快满了"。
    var subchips = h('div', { class: 'chain-chips chain-subchips' })
    var head = h('div', { class: 'chain-head' }, [
      h('div', { class: 'chain-title' }, [
        h('b', { text: '运转链' }),
        h('span', { class: 'dim tiny', text: '　电流＝活流过的那条通路：亮着有流动的点＝链路正通着；暗＝断（不是坏了，是没活）' })
      ]),
      chips,
      subchips
    ])
    var stamp = h('span', { class: 'chain-stamp', text: '还没同步' })
    var stageHead = h('div', { class: 'chain-stage-head' }, [
      stamp,
      h('span', { class: 'chain-legend' }, [
        legitem('busy', '干活中'), legitem('standby', '待命'), legitem('off', '断电'), legitem('error', '出错'),
        h('span', { class: 'chain-legend-sep' }),
        h('span', { class: 'tiny' }, [h('span', { class: 'lg-line' }), ' 数据流']),
        h('span', { class: 'tiny' }, [h('span', { class: 'lg-line dash' }), ' 供给']),
        h('span', { class: 'chain-legend-sep' }),
        h('a', { class: 'dim tiny', href: '/chain.json?full=1', target: '_blank', text: '原始数据' })
      ])
    ])
    var svg = sv('svg', { viewBox: '0 0 1200 440', preserveAspectRatio: 'xMidYMid meet', class: 'chain-svg' })
    var why = h('div', { class: 'chain-why' }, [h('span', { class: 'dim tiny', text: '点任意一条线，看它为什么通／为什么断（判据原句，不是编的）；点方框看内部零件。' })])
    var stage = h('div', { class: 'card chain-stage' }, [stageHead, svg, why])
    var partsBox = h('div', { class: 'chain-parts' })
    var partsCount = h('span', { class: 'dim tiny', text: '' })
    var partsCard = h('div', { class: 'card' }, [
      h('h3', {}, [h('span', { text: '元件排 —— 一个脚本一格（格子大小＝一次活能干多久）' }), partsCount]),
      partsBox
    ])
    var eventsBox = h('div', { class: 'chain-events' })
    // ★ D25：表头**只建一次**、整行可点；收起时表体是空的（不白建 40 行 DOM）
    var eventsSum = h('span', { class: 'dim tiny', text: '　最近 40 条' })
    var eventsHead = h('div', { class: 'chain-events-head', role: 'button', tabindex: '0' }, [
      h('span', { class: 'chain-events-arrow', text: '▸' }),
      h('span', { class: 'chain-events-title', text: '电流日志' }),
      eventsSum
    ])
    eventsHead.addEventListener('click', function () { toggleEvents() })
    eventsHead.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleEvents() }
    })
    var eventsCard = h('div', { class: 'card' }, [eventsHead, eventsBox])
    var drawer = h('aside', { class: 'chain-drawer' })
    var main = h('div', { class: 'chain-main' }, [stage, partsCard, eventsCard])
    var body = h('div', { class: 'chain-body' }, [main, drawer])
    // ★ b209：钉住的目录 ≠ 工作台根时，这条道上也要把话说清楚（不只在看板页说）
    var pinNote = h('div', { class: 'pin-banner', style: { display: 'none' } })
    root.appendChild(head); root.appendChild(pinNote); root.appendChild(body)
    refs = { root: root, chips: chips, subchips: subchips, stamp: stamp, svg: svg, why: why, parts: partsBox, partsCount: partsCount, events: eventsBox, eventsHead: eventsHead, eventsSum: eventsSum, drawer: drawer, body: body, pinNote: pinNote }
    drawWires()
    drawNodes()
    S.mounted = true
  }
  function legitem (state, text) { return h('span', { class: 'chain-legitem' }, [h('span', { class: 'lamp lamp-' + state }), h('span', { class: 'tiny', text: text })]) }

  /* ── 线（先画，垫在方框下面）── */
  var wireEls = {}
  function drawWires () {
    var g = sv('g', { class: 'wires' })
    /* ★ D26：载体总线（装饰）——把 5 个方框并到同一条主干上。
       它不是"线"，不参与通电判定、不能点（点它没有判据可讲，会误导）。 */
    var busD = [
      'M' + BUS.left + ',' + BUS.top + ' L' + BUS.left + ',' + BUS.bottom,
      'M' + BUS.right + ',' + BUS.top + ' L' + BUS.right + ',' + BUS.bottom,
      'M' + BUS.left + ',' + BUS.top + ' L' + BUS.right + ',' + BUS.top,
      'M' + BUS.left + ',' + BUS.bottom + ' L' + BUS.right + ',' + BUS.bottom
    ]
    // 每行方框到两边总线的短接头
    var rows = [['coder-a', 'coder-b', 'reviewer'], ['researcher', 'rescue']]
    BUS.stubY.forEach(function (y, i) {
      if (rows[0][i]) busD.push('M' + BUS.left + ',' + y + ' L' + (BOX[rows[0][i]].x) + ',' + y)
      if (rows[1][i]) busD.push('M' + (BOX[rows[1][i]].x + BOX[rows[1][i]].w) + ',' + y + ' L' + BUS.right + ',' + y)
    })
    var bus = sv('path', { d: busD.join(' '), class: 'wire-base bus-line' })
    g.appendChild(bus)
    Object.keys(WIRE).forEach(function (id) {
      var d = WIRE[id].map(function (p, i) { return (i ? 'L' : 'M') + p[0] + ',' + p[1] }).join(' ')
      var base = sv('path', { d: d, class: 'wire-base', 'data-id': id })
      var live = sv('path', { d: d, class: 'wire-live', 'data-id': id })
      var hit = sv('path', { d: d, class: 'wire-hit', 'data-id': id })
      hit.addEventListener('click', function () { showWhy(id) })
      wireEls[id] = { base: base, live: live, hit: hit }
      g.appendChild(base); g.appendChild(live); g.appendChild(hit)
    })
    refs.svg.appendChild(g)
  }

  /* ── 方框（只建一次，之后只改文字与 class）── */
  var nodeEls = {}
  function drawNodes () {
    var defs = sv('defs')
    var g = sv('g', { class: 'nodes' })
    Object.keys(BOX).forEach(function (id) {
      var b = BOX[id]
      // 文字裁剪路径（兜底：估算截字之外再加一道，绝不冲出方框）
      var cp = sv('clipPath', { id: 'clip-' + id })
      cp.appendChild(sv('rect', { x: b.x + 8, y: b.y + 4, width: b.w - 14, height: b.h - 8 }))
      defs.appendChild(cp)
      var grp = sv('g', { class: 'cn', 'data-id': id, tabindex: '0', role: 'button' })
      grp.appendChild(sv('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 9, class: 'cn-box' }))
      grp.appendChild(sv('rect', { x: b.x, y: b.y, width: 4, height: b.h, rx: 2, class: 'cn-bar' }))
      var texts = sv('g', { 'clip-path': 'url(#clip-' + id + ')' })
      var lamp = sv('circle', { cx: b.x + 16, cy: b.y + 18, r: 4.6, class: 'cn-lamp' })
      var name = sv('text', { x: b.x + 28, y: b.y + 22.5, class: 'cn-name' })
      var state = sv('text', { x: b.x + 14, y: b.y + 42, class: 'cn-state' })
      var met = sv('text', { x: b.x + 14, y: b.y + 58, class: 'cn-metric' })
      var met2 = sv('text', { x: b.x + 14, y: b.y + 72, class: 'cn-metric2' })
      texts.appendChild(name); texts.appendChild(state); texts.appendChild(met); texts.appendChild(met2)
      grp.appendChild(lamp); grp.appendChild(texts)
      grp.addEventListener('click', function () { open(id) })
      grp.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(id) } })
      grp.addEventListener('mouseenter', function () { hover(id) })
      nodeEls[id] = { grp: grp, lamp: lamp, name: name, state: state, met: met, met2: met2, box: b }
      g.appendChild(grp)
    })
    // 元件排不再画箭头（b204 第一版画在 y=246 正好指进"你看板"那一行，容易看错方向）——
    // 改成：点「闸」＝开它的抽屉 ＋ 把下面的元件排滚进视野（见 open()）。
    refs.svg.appendChild(defs); refs.svg.appendChild(g)
  }

  /* ── 四态 → class（唯一上色处）── */
  var STATE_CLASS = { busy: 'st-busy', standby: 'st-standby', off: 'st-off', error: 'st-error', unknown: 'st-unknown' }

  function paint (v) {
    S.data = v; S.at = Date.now(); S.err = null
    var spanMin = v.window && v.window.spanMin
    refs.stamp.textContent = '同步于刚才' + (spanMin ? ' · 证据覆盖约 ' + spanMin + ' 分钟' : '')
    refs.stamp.title = plain((v.window && v.window.note) || '')
    refs.chips.innerHTML = ''
    if (refs.subchips) refs.subchips.innerHTML = ''
    var m = v.meter || {}
    refs.chips.appendChild(chip('有活？', v.work && v.work.hasWork ? '有' : '没有', plain(v.work ? v.work.why : ''), v.work && v.work.hasWork ? 'on' : 'off'))
    refs.chips.appendChild(chip('通电段', String(m.liveEdges || 0) + ' / ' + (v.edges ? v.edges.length : 0), plain((v.work && (v.work.liveSegments || []).join('　')) || ''), m.liveEdges ? 'on' : 'off'))
    refs.chips.appendChild(chip('干活中', String(m.busyNodes || 0) + ' 个', '', m.busyNodes ? 'on' : 'off'))
    refs.chips.appendChild(chip('事件 / 分钟', String(m.events1min || 0), '', 'info'))
    // ★ 窗口占用只认 DSH 会话投影的 contextPressure；拿不到就如实 —，不拿转录累计冒充。
    refs.chips.appendChild(chip('上下文占用', m.contextPercent == null ? '—' : (m.contextPercent + '%'), (m.contextText || '拿不到 DSH 会话投影的 contextPressure') + (m.contextNote ? '　·　' + m.contextNote : ''), m.contextLevel === 'danger' ? 'danger' : (m.contextLevel === 'warn' ? 'warn' : 'info')))
    refs.chips.appendChild(chip('今日调用', String(m.todayCalls || 0), '', 'info'))
    refs.chips.appendChild(chip('元件', String(m.partsTotal || 0) + ' 个', v.project && v.project.name ? ('项目：' + v.project.name) : '没钉工作区', 'info'))
    if (refs.subchips) {
      var winTok = (m.windowIn || 0) + (m.windowOut || 0)
      refs.subchips.appendChild(chip('本窗 token', winTok.toLocaleString('en-US'), '转录尾巴累计：输入 ' + (m.windowIn || 0).toLocaleString('en-US') + ' / 输出 ' + (m.windowOut || 0).toLocaleString('en-US') + ' / 缓存读 ' + (m.windowCache || 0).toLocaleString('en-US') + ' · ' + (m.windowSteps || 0) + ' 次调用 · 覆盖约 ' + (m.windowSpanMin || '?') + ' 分钟', 'info'))
      refs.subchips.appendChild(chip('本窗调用', String(m.windowSteps || 0) + ' 次', '只是转录窗口里的调用次数，不是全期', 'info'))
      if (m.contextSoft != null && m.contextHard != null) {
        refs.subchips.appendChild(chip('换会话线', Math.round(m.contextSoft * 100) + '% 起换 / ' + Math.round(m.contextHard * 100) + '% 不等', 'DSH 原生会话投影门槛；与 换新会话.mjs 同口径', 'info'))
      }
      refs.subchips.appendChild(chip('证据窗口', (m.windowSpanMin || '?') + ' 分钟', '只覆盖大脑会话转录尾巴 ' + (v.window && v.window.frames ? v.window.frames : 60) + ' 帧；窗口外不装成发生过', 'info'))
    }
    paintPinNote(v.project || {})

    ;(v.nodes || []).forEach(function (n) {
      var el = nodeEls[n.id]; if (!el) return
      var b = el.box
      el.grp.setAttribute('class', 'cn ' + (STATE_CLASS[n.state] || 'st-unknown'))
      el.lamp.setAttribute('class', 'cn-lamp')
      el.name.textContent = fit(n.label, b.w - 34, 13)
      // ★ D26：5 个载体各是一个普通方框（各有自己的 metrics：卡 / 上下文），不再有"一格塞 5 行"的特例
      el.state.textContent = fit(n.stateZh + ' · ' + n.stateText, b.w - 26, 10.5)
      var ms = n.metrics || []
      el.met.textContent = fit(ms[0] ? (ms[0].k + ' ' + ms[0].v) : '', b.w - 26, 9.5)
      el.met2.textContent = fit(ms[1] ? (ms[1].k + ' ' + ms[1].v) : '', b.w - 26, 9.5)
      el.met2.style.display = ms[1] ? '' : 'none'
      el.grp.setAttribute('title', plain(n.label + '（' + n.stateZh + '）\n' + n.stateText + '\n— ' + (n.why || '') + '\n'
        + (n.metrics || []).map(function (x) { return '· ' + x.k + '：' + x.v + (x.hint ? '（' + x.hint + '）' : '') }).join('\n') + '\n\n点开看内部零件'))
    })

    ;(v.edges || []).forEach(function (e) {
      var el = wireEls[e.id]; if (!el) return
      var live = !!e.live
      var lvl = e.level || 0
      el.base.setAttribute('class', 'wire-base' + (e.kind === 'supply' ? ' dash' : '') + (live ? ' warm' : ''))
      // ⚠️ `lvl` 不论通不通都要挂：不通但有余辉（15s/90s/10min）的线要**看得见是个影子**（静态亮点），
      //    只有 `on` 才让它流动 —— "余辉＝静电，常亮＝在流"，这两件事在界面上必须分得出来。
      el.live.setAttribute('class', 'wire-live lvl' + lvl + (live ? ' on' : '') + (e.kind === 'supply' ? ' dash' : ''))
      if (live) el.live.style.animationDuration = (lvl >= 3 ? 0.55 : lvl === 2 ? 0.9 : 1.5) + 's'
      else el.live.style.animationDuration = ''
      el.hit.setAttribute('title', plain((e.fromLabel || e.from) + ' → ' + (e.toLabel || e.to) + '\n' + (e.live ? '【通着电】' : '【断】') + ' ' + (e.whyLive || '') + '\n\n最近一次：' + (e.whyEvent || '没有记录') + '\n\n余辉：' + (e.why || '')))
      var stamp = String((e.at || 0) + ':' + lvl)
      if (e.at && S.prevFlash[e.id] !== stamp) {
        S.prevFlash[e.id] = stamp
        if (lvl >= 2) {
          el.live.classList.remove('flash')
          void el.live.getBoundingClientRect()      // 强制回流，动画才会重放
          el.live.classList.add('flash')
          setTimeout(function () { el.live.classList.remove('flash') }, 1300)
        }
      }
      if (S.whyId === e.id) showWhy(e.id, true)
    })

    paintParts(v.parts || [], v.residentsOther || null)
    paintEvents(v.events || [])
    if (S.sel) renderDrawer()
  }

  function chip (k, v, hint, tone) {
    return h('span', { class: 'chip chain-chip tone-' + (tone || 'info'), title: plain(hint || '') }, [
      h('span', { class: 'dim tiny', text: k + ' ' }), h('b', { text: String(v) })
    ])
  }

  /* ★ b209：钉住的目录 ≠ 工作台根 ⇒ 顶上一条明白话 ＋「改钉」（顺手记进项目对照表）。
     为什么在链页也要：用户看"为什么不亮"就在这一页，只让我去别的页看提示等于没提示。 */
  function paintPinNote (pj) {
    var box = refs.pinNote
    if (!box) return
    if (!pj.banner) { box.style.display = 'none'; return }
    box.style.display = ''
    box.className = 'pin-banner' + (pj.noWorkbench ? ' bad' : '')
    box.innerHTML = ''
    box.appendChild(h('div', { class: 'pb-txt', text: plain(pj.banner) }))
    if (pj.noWorkbench || pj.resolvedBy === 'ledger') {
      var btn = h('button', { class: 'pb-btn', text: '改钉到「' + String(pj.name || '') + '」并记住' })
      btn.addEventListener('click', function () {
        btn.disabled = true
        btn.textContent = '钉着…'
        fetch('/pin', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ path: pj.path, rememberFrom: pj.pinPath })
        }).then(function (r) { return r.json() }).then(function (j) {
          if (j && j.ok) location.reload()
          else { btn.disabled = false; btn.textContent = '钉失败：' + String((j && j.error) || '看服务端日志') }
        }).catch(function () { btn.disabled = false; btn.textContent = '钉失败（网络）' })
      })
      box.appendChild(btn)
    }
  }



  function paintParts (parts, others) {
    refs.parts.innerHTML = ''
    // ★ b211：只数**工作台级**常驻件；登记册里项目/会话级的另外如实说一句（不进电路图）
    var nsOther = others && others.count ? Number(others.count) : 0
    refs.partsCount.textContent = '　共 ' + parts.length + ' 个（闸门族 ' + parts.filter(function (p) { return p.group === 'gate' }).length + ' ＋ 常驻 ' + parts.filter(function (p) { return p.group === 'resident' }).length + '）' +
      (nsOther ? '　·　另有 ' + nsOther + ' 个项目/会话级长命资源不在本页（' + String((others.names || []).join('、')) + '）' : '')
    parts.forEach(function (p) {
      var age = p.lastAt ? Math.round((Date.now() - p.lastAt) / 1000) : null
      var title = plain(p.name + '（' + (p.stateZh || '') + ' · ' + (p.size || '') + '）\n' + (p.stateText || '')
        + (p.lastAt ? '\n最近一次：' + agoText(age) + (p.lastDur != null ? ' · 用时 ' + p.lastDur.toFixed(1) + 's' : '') + (p.lastExit != null ? ' · exit ' + p.lastExit : '') : '\n窗口内没跑过（不等于没跑过）')
        + (p.lastText ? '\n' + p.lastText : '')
        + (p.sizeWhy ? '\n格子大小：' + p.sizeWhy : '')
        + '\n\n点开看内部零件')
      var btn = h('button', {
        class: 'cpart size-' + (p.size || 'small') + ' ' + (STATE_CLASS[p.state] || 'st-unknown') + (p.group === 'resident' ? ' resident' : ''),
        title: title,
        onclick: function () { open(p.detailId || p.id) }
      }, [
        h('span', { class: 'cpart-lamp' }),
        h('span', { class: 'cpart-txt' }, [
          h('span', { class: 'cpart-name', text: String(p.name).replace(/\.mjs$/, '').replace(/\.cjs$/, '') }),
          p.size === 'small' ? null : h('span', { class: 'cpart-sub', text: age != null ? agoText(age) : (p.stateText || '') })
        ])
      ])
      refs.parts.appendChild(btn)
    })
  }

  /* ── 电流日志（D25：默认收起；展开状态放 S，跨刷新不丢）── */
  function paintEvents (events) {
    S.lastEvents = events || []
    var recent = S.lastEvents.filter(function (e) { return Date.now() - e.at < 60000 }).length
    if (refs.eventsSum) {
      refs.eventsSum.textContent = '　最近 ' + S.lastEvents.length + ' 条' +
        (recent ? ' · 其中 ' + recent + ' 条在最近 1 分钟' : '') +
        '（转录＋账本；窗口外的老账不显示，也不假装没发生）'
    }
    renderEvents()
  }
  function renderEvents () {
    if (!refs.events) return
    refs.events.innerHTML = ''
    var arrow = refs.eventsHead && refs.eventsHead.querySelector('.chain-events-arrow')
    if (arrow) arrow.textContent = S.eventsOpen ? '▾' : '▸'
    if (!S.eventsOpen) return                    // 收起 ⇒ 一行 DOM 都不建
    var events = S.lastEvents || []
    refs.events.appendChild(h('table', { class: 'tbl tiny chain-tbl' }, [
      h('thead', {}, [h('tr', {}, ['时间', '用电器', '动作', '内容', '结果'].map(function (x) { return h('th', { text: x }) }))]),
      h('tbody', {}, events.map(function (e) {
        var t = new Date(e.at)
        var hhmmss = String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0') + ':' + String(t.getSeconds()).padStart(2, '0')
        return h('tr', { class: e.tone === 'err' ? 'row-err' : '' }, [
          h('td', { class: 'dim', text: hhmmss }),
          h('td', { text: labelOf(e.node) }),
          h('td', { text: e.what || '' }),
          h('td', { title: plain(e.text + (e.out ? '\n\n' + e.out : '')), text: plain(clipText(e.text, 110)) }),
          h('td', { text: e.tone === 'err' ? '❌' : (e.tone === 'warn' ? '⚠️' : '✅') })
        ])
      }))
    ]))
  }
  function toggleEvents () {
    S.eventsOpen = !S.eventsOpen
    renderEvents()
  }
  function labelOf (id) {
    var map = { rules: '常驻规矩', brain: '大脑', dispatch: '派活', orch: '编排', carrier: '载体', checks: '闸', review: '审核', tools: '工具服务', outbox: '回收', ledger: '账本', board: '看板数据', you: '你看板', services: '看护/常驻',
      'coder-a': 'coder-a', 'coder-b': 'coder-b', reviewer: 'reviewer', researcher: 'researcher', rescue: 'rescue' }
    return map[id] || String(id || '')
  }
  function clipText (s, n) { s = plain(s); return s.length > n ? s.slice(0, n) + '…' : s }

  /* ── 为什么通/断 ── */
  function showWhy (id, silent) {
    var v = S.data; if (!v) return
    var e = (v.edges || []).filter(function (x) { return x.id === id })[0]
    if (!e) return
    S.whyId = id
    refs.why.innerHTML = ''
    refs.why.appendChild(h('span', { class: 'chain-why-id' }, [
      h('b', { text: e.from + ' → ' + e.to }),
      h('span', { class: 'badge ' + (e.live ? 'ok' : 'off'), text: e.live ? '通着电' : '断' }),
      h('span', { class: 'dim tiny', text: '　' + (e.kind === 'supply' ? '供给线' : '数据流') + ' · 余辉 L' + (e.level || 0) })
    ]))
    refs.why.appendChild(h('div', { class: 'chain-why-main', text: plain(e.whyLive || '') }))
    // ★ b218：这条线"最近一次真实传递"——谁 → 谁、传了什么、多久以前
    refs.why.appendChild(h('div', { class: 'chain-why-main', text: plain('最近一次：' + (e.whyEvent || '没有记录')) }))
    refs.why.appendChild(h('div', { class: 'dim tiny', text: plain(e.why || '') }))
    if (!silent) refs.why.scrollIntoView({ block: 'nearest' })
  }
  function hover (id) { if (!S.whyId || S.whyId === id) showWhy(id, true) }

  /* ── 开盒（抽屉）── */
  function open (id) {
    S.sel = id; S.detail = null; S.detailErr = null
    refs.body.classList.add('with-drawer')
    renderDrawer()
    fetchDetail()
    // 点「闸」＝同时把下面的元件排滚进视野（用户口径："点闸＝展开那一排"）
    if (id === 'checks' && refs.parts) { try { refs.parts.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) } catch (e) {} }
  }
  function close () {
    S.sel = null; S.detail = null
    refs.body.classList.remove('with-drawer')
    refs.drawer.innerHTML = ''
    if (S.detailTimer) { clearInterval(S.detailTimer); S.detailTimer = 0 }
  }
  function fetchDetail () {
    if (!S.sel) return
    var id = S.sel
    fetch('/chain-detail?id=' + encodeURIComponent(id) + '&t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.json() })
      .then(function (j) { if (S.sel !== id) return; S.detail = j; renderDrawer() })
      .catch(function (e) { if (S.sel !== id) return; S.detailErr = String((e && e.message) || e); renderDrawer() })
  }
  function renderDrawer () {
    if (!S.sel) return
    var d = S.detail
    refs.drawer.innerHTML = ''
    refs.drawer.appendChild(h('div', { class: 'chain-drawer-head' }, [
      h('b', { text: plain(d ? d.title : '读内部零件…') }),
      h('button', { class: 'btn chain-close', text: '✕', title: '关掉（Esc）', onclick: close })
    ]))
    if (d && d.sub) refs.drawer.appendChild(h('div', { class: 'dim tiny', text: plain(d.sub) }))
    if (S.detailErr) refs.drawer.appendChild(h('div', { class: 'chain-err', text: '读不到：' + S.detailErr }))
    if (!d) return
    if (!d.ok) { refs.drawer.appendChild(h('div', { class: 'chain-err', text: plain(d.error || '读不到这一个用电器') })); return }
    if (d.chips && d.chips.length) {
      refs.drawer.appendChild(h('div', { class: 'chain-dchips' }, d.chips.map(function (c) {
        return h('span', { class: 'chip chain-chip', title: plain(c.hint || ''), }, [h('span', { class: 'dim tiny', text: c.k + ' ' }), h('b', { text: String(c.v) })])
      })))
    }
    // ★ 2026-10-26（§十「角色抽屉加 attempt/恢复」）：这个角色最近几次尝试。
    //   状态只认 attempt.state；`completed` 但缺 endedAt ⇒ 标出来（§十：缺证据不许当已完成）。
    //   读不到就明说"读不到"，**不显示一张空表假装没失败过**。
    if (d.attemptsWhy) refs.drawer.appendChild(h('div', { class: 'chain-err', text: d.attemptsWhy }))
    if (Array.isArray(d.attempts) && d.attempts.length) {
      refs.drawer.appendChild(h('div', { class: 'chain-sec-title', text: '最近尝试（' + d.attempts.length + ' 次，来自 C 状态库）' }))
      refs.drawer.appendChild(h('div', { class: 'chain-rows' }, d.attempts.map(function (a) {
        var tone = a.state === 'running' ? 'tone-warn' : (a.state === 'completed' ? '' : 'tone-danger')
        return h('div', { class: 'chain-row', title: (a.why || '') + (a.routeMismatch ? '｜route-mismatch' : '') },
          [
            h('span', { class: 'dim tiny ts', text: a.startedAt ? new Date(a.startedAt).toLocaleTimeString('zh-CN', { hour12: false }) : '—' }),
            h('span', { class: 'chip ' + tone, text: a.state }),
            h('span', { text: ' ' + (a.kind || '?') + ' · ' + (a.taskId || '?') + (a.budget ? ' · 预算' + a.budget : '') }),
            a.routeMismatch ? h('b', { class: 'dp-warn', text: ' · route-mismatch' }) : null,
            a.missing ? h('b', { class: 'dp-bad', text: ' · ' + a.missing }) : null
          ].filter(Boolean))
      })))
    } else if (!d.attemptsWhy && Array.isArray(d.attempts)) {
      refs.drawer.appendChild(h('div', { class: 'dim tiny', text: '这个角色还没有 attempt 记录（还没跑过）' }))
    }
    if (d.parts && d.parts.length) {
      refs.drawer.appendChild(h('div', { class: 'chain-sec-title', text: '内部零件 / 结果 / 出错现场' }))
      refs.drawer.appendChild(h('table', { class: 'tbl tiny chain-ptbl' }, [
        h('tbody', {}, d.parts.map(function (p) {
          return h('tr', {}, [
            h('td', { class: 'pk', text: p.name }),
            h('td', {}, [h('div', { class: 'pv', text: plain(String(p.value == null ? '—' : p.value)) }), p.detail ? h('div', { class: 'pd dim', text: plain(p.detail) }) : null])
          ])
        }))
      ]))
    }
    if (d.rows && d.rows.length) {
      refs.drawer.appendChild(h('div', { class: 'chain-sec-title', text: plain(d.rowsTitle || '最近记录') }))
      refs.drawer.appendChild(h('div', { class: 'chain-rows' }, d.rows.map(function (r) {
        return h('div', { class: 'chain-row' }, [
          r.at ? h('span', { class: 'dim tiny ts', text: new Date(r.at).toLocaleTimeString('zh-CN', { hour12: false }) }) : null,
          h('span', { text: plain(String(r.text == null ? '' : r.text)) })
        ])
      })))
    }
    if (d.code) {
      refs.drawer.appendChild(h('div', { class: 'chain-sec-title', text: '源码摘录（' + (d.code.total || '?') + ' 行 · ' + (d.code.chars || '?') + ' 字符）' }))
      refs.drawer.appendChild(h('div', { class: 'dim tiny', text: '文件头（作者自述，前 ' + (d.code.head || []).length + ' 行）' }))
      refs.drawer.appendChild(h('pre', { class: 'chain-code' }, d.code.head.map(function (l) {
        return h('div', { class: 'cl' }, [h('span', { class: 'cln', text: String(l.n) }), h('span', { text: l.text })])
      })))
      if (d.code.members && d.code.members.length) {
        refs.drawer.appendChild(h('div', { class: 'dim tiny', text: '骨架（函数/常量声明，带行号 —— 想看哪段按行号去文件里看）' }))
        refs.drawer.appendChild(h('pre', { class: 'chain-code' }, d.code.members.map(function (l) {
          return h('div', { class: 'cl' }, [h('span', { class: 'cln', text: String(l.n) }), h('span', { text: l.text })])
        })))
      }
    }
    if (d.note) refs.drawer.appendChild(h('div', { class: 'chain-note dim tiny', text: plain(d.note) }))
  }

  /* ── 轮询 ── */
  function poll () {
    if (!S.on || document.hidden) return
    fetch('/chain.json?full=1&t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json() })
      .then(function (j) { if (j && j.ok) paint(j); else throw new Error((j && j.error) || '数据不 ok') })
      .catch(function (e) {
        S.err = String((e && e.message) || e)
        if (refs.stamp) refs.stamp.textContent = '读不到 /chain.json：' + S.err
      })
  }
  function tickStamp () {
    if (!refs.stamp || S.err) return
    if (!S.at) { refs.stamp.textContent = '还没同步'; return }
    var sec = Math.round((Date.now() - S.at) / 100) / 10
    refs.stamp.textContent = '同步于 ' + agoText(sec) + (S.data && S.data.window && S.data.window.spanMin ? ' · 证据覆盖约 ' + S.data.window.spanMin + ' 分钟' : '')
  }

  /* ── 生命周期：进页才轮，切走就停 ── */
  function enter () {
    if (!S.mounted) return
    S.on = true
    poll()
    if (S.timer) clearInterval(S.timer)
    S.timer = setInterval(poll, CHAIN_MS)
    if (S.detailTimer) clearInterval(S.detailTimer)
    S.detailTimer = setInterval(function () { if (S.sel && !document.hidden) fetchDetail() }, DETAIL_MS)
    // 深链：`#chain/brain`、`#chain/script:起飞前检查.mjs` —— 直接开那个用电器的抽屉（刷新也不丢）
    var m = String(location.hash || '').match(/^#chain\/(.+)$/)
    if (m) { try { open(decodeURIComponent(m[1])) } catch (e) {} }
  }
  function leave () {
    S.on = false
    if (S.timer) { clearInterval(S.timer); S.timer = 0 }
    if (S.detailTimer) { clearInterval(S.detailTimer); S.detailTimer = 0 }
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { if (S.timer) { clearInterval(S.timer); S.timer = 0 } }
    else if (S.on) { poll(); if (!S.timer) S.timer = setInterval(poll, CHAIN_MS) }
  })
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && S.sel) close() })
  setInterval(tickStamp, 200)

  window.__DSH_CHAIN = {
    mount: function (el) { if (!S.mounted) build(el) },
    enter: enter,
    leave: leave,
    open: function (id) { open(id) },
    isOn: function () { return S.on },
    // ★ 测试钩子（无浏览器冒烟用）：喂一份真 chain.json、按一下折叠、读回状态。
    //   只给探针用；页面自己的运行路径不经过这里。
    __test: {
      paint: function (v) { paint(v) },
      toggleEvents: function () { toggleEvents() },
      eventsOpen: function () { return S.eventsOpen },
      eventRowCount: function () { return refs.events ? refs.events.children.length : -1 },
      summary: function () { return refs.eventsSum ? refs.eventsSum.textContent : '' },
      arrow: function () {
        var a = refs.eventsHead && refs.eventsHead.querySelector('.chain-events-arrow')
        return a ? a.textContent : ''
      }
    }
  }
})()
