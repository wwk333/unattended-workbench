/**
 * 可执行验收（executable AC）的**唯一解析口径** —— 2026-10-21 通用化改造（第①件）
 *
 * 为什么抽出来单开一个模块：
 *   `台账.mjs` 里原来只有一条正则（反引号 + `→`），而"大脑写卡"从来不会按那个形状写，
 *   于是全盘 75 份收据里只有 12 份真的让机器跑过验收 —— 剩下的都是 `machineVerified:false` 静默放行
 *   （实测事故：chaojimaliao 的 T1-03 验收红了，任务照样进 done，靠人眼发现才补了一张卡）。
 *
 * 这里的口径分两层，**读宽容、写规范**：
 *   · 读（`parseExecAC`）：先认规范形状，再**保守地**认"裸命令"——宁可判"认不出"，
 *     也不许把一句中文当成命令去跑（跑错了比不跑更危险）。
 *   · 写（`canonicalizeAccept`）：`台账 add/set` 落盘前把能认出的裸命令改写成规范形状，
 *     新卡从此自带可执行 AC；老卡不重写（读的时候宽容即可，不偷偷改别人的台账）。
 *
 * 白的判据（三条，缺一不可）：
 *   ① 第一个词必须是**已知跑器**（npm/pytest/go/cargo… 见 AC_CMD_HEAD）——不是通用 shell；
 *   ② 句子不许有"自由的"中文碎词（`npm run test 五条全绿` 里的 `五条全绿`）——
 *      但**路径里的中文是合法的**（`python tests\自测_w1.py` 必须放行，这是本工作台的日常）；
 *   ③ 不许含句读（`。`、`；`）——那是叙述不是命令。
 */

/** 已知跑器：出现在**命令第一位**才认。加新生态时只改这一行（通用，不分项目）。 */
export const AC_CMD_HEAD = new Set([
  'npm', 'npx', 'pnpm', 'pnpx', 'yarn', 'bun', 'deno', 'node', 'tsx', 'ts-node', 'vitest', 'jest',
  'python', 'python3', 'py', 'pytest', 'pip', 'uv', 'poetry', 'pipenv', 'tox',
  'go', 'cargo', 'rustc', 'make', 'cmake', 'ninja',
  'dotnet', 'msbuild', 'mvn', 'mvnw', 'gradle', 'gradlew', 'java', 'javac',
  'pwsh', 'powershell', 'bash', 'sh', 'zsh', 'cmd',
  'ruby', 'bundle', 'rake', 'php', 'composer', 'julia', 'Rscript', 'R',
])

const BACKTICK_RE = /^`([^`]+)`\s*(?:=>|→)\s*(.*)$/
const BACKTICK_PLAIN_RE = /^`([^`]+)`\s*$/

/**
 * ★ b219（2026-10-22 用户拍板"技术栈要进方案、卡要带证据等级"）：
 *   **标签与命令分离**——验收条款可以带证据等级（E1/E2/E3）或旧称（【机器】/【人】/【呈现】），
 *   标签放行首或行尾都认；剥掉标签后命令必须**原样**符合规范形状。
 *   为什么必须剥：本文件是全系统唯一 AC 解析口，锚点在行首（`^` 反引号 / 第一个词是已知跑器），
 *   标签一前置就全盘失配 ⇒ machineVerified:false 静默放行（比不解析更危险）。
 *   ⚠️ 只认**短标签**（≤12 字、E1–E3 带冒号、括号内 ≤6 字）——剥不掉就返回 null，绝不猜。
 */
const LABEL_HEAD = /^(?:\s*(?:【[^】\n]{1,12}】|\[[^\]\n]{1,12}\]|E[1-3]\s*[:：]|（[^）\n]{1,6}）|\([^)\n]{1,6}\)))+\s*/
const LABEL_TAIL = /\s*(?:【[^】\n]{1,12}】|\[[^\]\n]{1,12}\]|（E[1-3][^）\n]{0,8}）|\(E[1-3][^)\n]{0,8}\))\s*$/

/** 剥掉行首/行尾的标签：返回 { lead, body }（lead 原样保留，落盘时再拼回去）。 */
export function stripLabels (entry) {
  const raw = String(entry ?? '')
  const lead = raw.match(LABEL_HEAD)?.[0] ?? ''
  let body = raw.slice(lead.length)
  body = body.replace(LABEL_TAIL, '')
  return { lead, body }
}

/** 句尾的中文"期望标记"——只摘这些，别的一律不动（保守）。 */
const TAIL_EXPECT = [
  /^([\s\S]*?)\s*(?:=>|→)\s*([\s\S]+)$/,
  /^([\s\S]*?)\s*[，,]?\s*(?:退出码|返回码|exit\s*code)\s*(?:必须为|必须|应为|应为|为|=)?\s*0\s*$/i,
  /^([\s\S]*?)\s*[，,]?\s*(?:全部通过|全绿|全PASS|都通过)\s*$/i,
]

function hasSentencePunct (s) { return /[。；]/.test(s) }

/** 有没有"自由中文碎词"（整段就是一个中文词，且不含路径符号/扩展名）。 */
function hasFreeChineseToken (s) {
  const toks = String(s).trim().split(/\s+/).filter(Boolean)
  for (const t of toks) {
    const cjk = (t.match(/[\u4e00-\u9fa5]/g) ?? []).length
    if (cjk < 2) continue
    const looksPathy = /[\\/]/.test(t) || /\.[A-Za-z0-9]{1,6}$/.test(t) || /^[-\/]/.test(t)
    if (!looksPathy) return true
  }
  return false
}

/** 把一个候选命令洗干净：摘尾部期望、校验三条判据；不合格返回 null。 */
function tidyCommand (raw) {
  let s = String(raw ?? '').trim().replace(/^[`"']+|[`"']+$/g, '').trim()
  if (!s) return null
  if (hasSentencePunct(s)) return null
  const head = s.split(/\s+/)[0]
  if (!AC_CMD_HEAD.has(String(head).toLowerCase())) return null
  let expect = null
  for (const re of TAIL_EXPECT) {
    const m = re.exec(s)
    if (!m) continue
    if (re === TAIL_EXPECT[0]) {
      s = m[1].trim(); expect = m[2].trim()
    } else {
      s = m[1].trim()
    }
    if (s) break
  }
  if (!s) return null
  if (hasFreeChineseToken(s)) return null
  return { cmd: s, expect: expect || null }
}

/**
 * 解析一条验收条目；认不出返回 null（调用方据此判"未机器验证"，**绝不猜**）。
 * 认的形状：`` `命令` `` / `` `命令` → 期望 `` / 裸的 `python x.py --only T1-03 退出码0`
 * ★ b219：允许标签前置/后置（E1/E2/E3、【机器】/【人】/【呈现】），剥掉后再走原逻辑。
 */
export function parseExecAC (entry) {
  const raw = String(entry ?? '').trim()
  if (!raw) return null
  const s = stripLabels(raw).body.trim()
  if (!s) return null
  const m1 = BACKTICK_RE.exec(s)
  if (m1) {
    const expect = (m1[2] ?? '').trim() || null
    const cmd = m1[1].trim()
    return cmd ? { cmd, expect } : null
  }
  const m2 = BACKTICK_PLAIN_RE.exec(s)
  if (m2) return { cmd: m2[1].trim(), expect: null }
  // ★ b219：**反引号命令后面跟一段说明**也要认（实测卡上常见：「`game.exe` 双击能开」）。
  //   为什么安全：命令被反引号**明确圈住**了，尾段只是说明，不存在"把一句中文当命令跑"的风险；
  //   尾段当"期望"带出去（与 `→` 同义），不丢信息。裸命令（无反引号）仍走 tidyCommand 的严格判据。
  const m3 = /^`([^`]+)`\s*([\s\S]*)$/.exec(s)
  if (m3) {
    const cmd = m3[1].trim()
    const tail = m3[2].trim()
    if (cmd && !/[。；]/.test(tail)) return { cmd, expect: tail || null }
  }
  return tidyCommand(s)
}

/** 落盘前的规范化：能认出的裸命令 → 改写成 `` `命令` `` 或 `` `命令` → 期望 ``；标签原样保留。认不出原样返回。 */
export function canonicalizeAccept (entry) {
  const raw = String(entry ?? '').trim()
  if (!raw) return raw
  const { lead, body } = stripLabels(raw)
  const s = body.trim()
  if (!s) return raw
  if (BACKTICK_RE.test(s) || BACKTICK_PLAIN_RE.test(s)) return lead + s
  const ac = tidyCommand(s)
  if (!ac) return raw
  return lead + (ac.expect ? `\`${ac.cmd}\` → ${ac.expect}` : `\`${ac.cmd}\``)
}

/** 这批验收里有几条是可执行的（0 ＝ 未机器验证）。 */
export function countExecAC (accept) {
  return (Array.isArray(accept) ? accept : []).filter(a => parseExecAC(a)).length
}

/** 把 `--accept "a,b,c"` 切成条目：**反引号内的逗号不算分隔符**（否则命令参数会被切碎）。 */
export function splitAccept (raw) {
  const out = []
  let buf = '', inTick = false
  for (const ch of String(raw ?? '')) {
    if (ch === '`') { inTick = !inTick; buf += ch; continue }
    if (!inTick && /[,;，；]/.test(ch)) { if (buf.trim()) out.push(buf.trim()); buf = ''; continue }
    buf += ch
  }
  if (buf.trim()) out.push(buf.trim())
  return out
}
