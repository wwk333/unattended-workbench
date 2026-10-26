/**
 * 静态验收校验（D5）—— 卡生成时做，**不跑脚本、不调模型**，目标 < 50ms。
 *
 * 为什么要有它（实测代价）：今天的 AC 事故 ≈ 16 分钟（全程 10%），大头不是"跑红的卡"，
 *   而是"等大脑下一轮"（每回环 1.7–1.8 分钟）。静态校验能把"注定要红的卡"**挡在派活之前** ⇒ 不产生那一轮。
 *
 * 三条判据（全部静态，宁漏勿误杀）：
 *   ① **路径存在**：`python <路径>` 这类"跑器 + 脚本路径"的命令，脚本文件必须真在；
 *   ② **期望串有出处**：卡上写的期望串（`→ 输出里必须出现「21 条全 PASS」`），
 *      它的**具体碎片**必须在脚本源码里找得到（找不到 ⇒ 这条验收永远是红的）；
 *   ③ **认不出就放过**：带管道/多命令/认不出跑器的，一律跳过 —— 绝不误杀（防"为了拦坏卡把好卡也拦了"）。
 *
 * 挡下之后：调用方（`派活.mjs`）**不出卡**，退出码 3 ⇒ 编排判 `input-error` 退回大脑（D6 同轮重派）。
 */
import { existsSync, readFileSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseExecAC } from './_验收.mjs'

/** 这些跑器的"第一个参数"按脚本路径理解（其余跑器不猜）。 */
const SCRIPT_RUNNERS = new Set(['python', 'python3', 'py', 'node', 'bash', 'sh', 'pwsh', 'powershell', 'cmd', 'ruby', 'php', 'Rscript', 'tsx', 'ts-node'])
const SCRIPT_EXT = /\.(py|js|mjs|cjs|ts|tsx|sh|ps1|cmd|bat|rb|php|r)$/i

/** 多命令 / 管道 / 重定向 ⇒ 静态解析不可靠 ⇒ 放过（判据③）。 */
function tooComplicated (cmd) {
  return /[|;&><\n]|\$\s*\(|`/.test(cmd.replace(/`/g, ''))
}

function stripQuotes (s) { return String(s ?? '').trim().replace(/^["'`]+|["'`]+$/g, '') }

/** 从命令里取出"脚本路径"；认不出返回 null（放过）。 */
export function scriptOf (cmd) {
  const s = String(cmd ?? '').trim()
  if (!s) return null
  if (tooComplicated(s)) return null
  const parts = s.split(/\s+/)
  const head = String(parts[0] ?? '').toLowerCase()
  if (!SCRIPT_RUNNERS.has(head)) return null
  // 找第一个看着像路径的参数（跳过 `-m` / `-c` / `--flag`）
  for (const raw of parts.slice(1)) {
    const p = stripQuotes(raw)
    if (!p || p.startsWith('-')) {
      if (p === '-m' || p === '-c') return null    // `python -m pytest` / `node -e` ⇒ 没有脚本文件
      continue
    }
    if (/[\\/]/.test(p) || SCRIPT_EXT.test(p)) return p
    return null                                     // 第一个裸词不是路径（例 `node server`）⇒ 放过
  }
  return null
}

/** 路径解析：相对路径按**项目根**再按**当前目录**找（两个都试，宁可多认一条）。 */
function resolvePath (p, project) {
  const cands = []
  if (isAbsolute(p)) cands.push(p)
  else {
    cands.push(resolve(project, p))
    cands.push(resolve(project, p.replace(/^\.?[\\/]/, '')))
  }
  return cands.find(c => { try { return statSync(c).isFile() } catch { return false } }) ?? null
}

/** 期望串里"可以拿去源码里找"的碎片：ASCII 词/数字，长度≥2；中文长句里的数字也算。 */
export function expectTokens (expect) {
  const s = String(expect ?? '')
  if (!s) return []
  const raw = s.match(/[A-Za-z][A-Za-z0-9_./-]{1,}|\d[\d./-]{1,}/g) ?? []
  // 去掉太泛的（PASS/OK/0 之类单独出现没有证明力）
  const WEAK = new Set(['PASS', 'OK', 'TRUE', 'FALSE', 'ALL', 'PASSED', 'SUCCESS', '0', '1'])
  return [...new Set(raw.map(x => x.trim()))].filter(x => x.length >= 2 && !WEAK.has(x.toUpperCase())).slice(0, 6)
}

/**
 * 校验一批验收条目。
 * @returns {{ok:boolean, blocked:Array<{entry:string,why:string}>, checked:number, skipped:number, notes:string[]}}
 */
/**
 * ★ 2026-10-26（§六「第一张卡的静态 AC 例外」）：`deliverables` 让"本卡就是要创建这个脚本"的卡放行。
 *
 * 为什么必须有（实测死锁）：项目第一张卡的任务就是"创建测试脚本"，而静态校验的判据①是"脚本必须存在"
 *   ⇒ 这张卡**永远**被 exit 3 挡在门外，谁也开不了工（D5 死锁）。
 * 口径：
 *   · AC 脚本不存在，但该脚本在**本卡交付物**里 ⇒ 标 `AC_PENDING_CREATE`，允许出卡；
 *   · 不存在且不在交付物里 ⇒ 仍然 blocked（exit 3，不启动模型）；
 *   · 完成时脚本必须真实存在且命令通过，否则仍是 `ac-red`（由收活判定兜，不在这一步）。
 */
export function validateAccept ({ accept = [], project, readFile = null, deliverables = [], allowPendingCreate = true } = {}) {
  const out = { ok: true, blocked: [], pendingCreate: [], checked: 0, skipped: 0, notes: [] }
  const root = resolve(project ?? '.')
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').replace(/^\.?\//, '').trim()
  const deliv = new Set((Array.isArray(deliverables) ? deliverables : []).map(norm))
  const readSrc = (f) => {
    try { return readFile ? readFile(f) : readFileSync(f, 'utf8') } catch { return null }
  }
  for (const entry of (Array.isArray(accept) ? accept : [])) {
    // ⓪ 格式坏：反引号不成对 ⇒ 这条验收连"跑什么/看到什么"都读不出来（实测 T1-10：期望串只剩一个反引号）。
    //    为什么它算 D5 的活：这种条目**永远无法判定**（人读着像有验收，机器一条都跑不了）⇒ 派出去就是白跑一轮。
    const ticks = (String(entry).match(/`/g) ?? []).length
    if (ticks % 2 === 1) {
      out.blocked.push({ entry: String(entry), why: `反引号不成对（${ticks} 个）⇒ 验收条目残缺，机器与人都会读错；补成 \`命令\` → 期望 的形状` })
      out.checked++
      continue
    }
    const ac = parseExecAC(entry)
    if (!ac) { out.skipped++; continue }
    const script = scriptOf(ac.cmd)
    if (!script) { out.skipped++; continue }          // 判据③：认不出 ⇒ 放过
    out.checked++
    const file = resolvePath(script, root)
    if (!file) {
      // ★ 交付物里写着它 ⇒ 这是"要创建"的卡，允许出卡（标 AC_PENDING_CREATE）
      if (allowPendingCreate && (deliv.has(norm(script)) || deliv.has(norm(script).replace(/^.*?([^/]+\/[^/]+)$/, '$1')))) {
        out.pendingCreate.push({ entry: String(entry), script: norm(script), why: 'AC 脚本在本卡交付物里但还不存在 ⇒ AC_PENDING_CREATE（完成时必须真实存在且通过）' })
        continue
      }
      out.blocked.push({ entry: String(entry), why: `脚本不存在：\`${script}\`（按项目根找过 ${join(root, script)}）—— 这条验收永远跑不起来` })
      continue
    }
    const toks = expectTokens(ac.expect)
    if (!toks.length) continue                        // 期望串没有可检索碎片 ⇒ 不判
    const src = readSrc(file)
    if (src === null) continue                        // 读不到源码 ⇒ 放过（不误杀）
    const miss = toks.filter(t => !src.includes(t))
    if (miss.length === toks.length) {
      out.blocked.push({ entry: String(entry), why: `期望串在脚本里找不到出处：${toks.map(t => `「${t}」`).join(' / ')} 都不在 \`${script}\` 里 —— 要求它输出这个，等于要求它做它没做的事` })
    } else if (miss.length) {
      out.notes.push(`期望串里 ${miss.map(t => `「${t}」`).join('')} 没在脚本里找到（其余能找到），**不挡**，但你确认一下`)
    }
  }
  // pendingCreate 不算 blocked：ok 只看 blocked
  out.ok = out.blocked.length === 0
  return out
}

/** 命令行：`node _静态AC.mjs --project <项目> --accept "a;b;c" [--json]` */
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const argv = process.argv.slice(2)
  const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
  const project = opt('project', process.cwd())
  const accept = String(opt('accept', '')).split(/[;；]/).map(s => s.trim()).filter(Boolean)
  const r = validateAccept({ accept, project })
  if (argv.includes('--json')) console.log(JSON.stringify(r, null, 2))
  else {
    console.log(`静态验收校验：检查 ${r.checked} 条 / 放过 ${r.skipped} 条 / 挡下 ${r.blocked.length} 条`)
    for (const b of r.blocked) console.log(`  ⛔ ${b.entry}\n      ${b.why}`)
    for (const n of r.notes) console.log(`  ⚠️ ${n}`)
  }
  process.exit(r.ok ? 0 : 3)
}
