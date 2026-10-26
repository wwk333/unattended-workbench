/**
 * 门禁的**测试入口解析器** —— 2026-10-21 通用化改造（第④件）
 *
 * 为什么要有它：原门禁只认 `<cwd>\package.json`（`门禁.mjs:176/296`），拿不到就判红。
 *   于是任何非 Node 项目（Python/Go/Rust/Make…）的门禁**永远是红的**——
 *   实测：chaojimaliao（Python + pygame）从第一轮红到最后，靠大脑额外开一张卡
 *   给它套了个 `package.json` 壳才变绿，白花了 12 万 token。
 *
 * 口径（三层，越靠前越优先）：
 *   ① **显式 `gate.json`**（项目根或 cwd）—— 想让门禁怎么跑就怎么写，**覆盖一切探测**；
 *   ② **npm**：`package.json` 有白名单脚本 ⇒ 交回 `门禁.mjs` 走原来的 npm 路（零改动）；
 *   ③ **自动探测**：pyproject/pytest.ini/tests → pytest；go.mod → go test；Cargo.toml → cargo test；
 *      Makefile 有 test 目标 → make test。
 *   都没有 ⇒ `source:'none'`，门禁应当**诚实降级**（`ok:true, degraded:true`，摘要写"没有测试入口"），
 *   **不许判红**——"这个项目没配测试"是事实，不是故障；红会让人去修一个不存在的东西。
 *
 * 纪律：本模块**只做解析**，不执行任何东西；执行仍在 `门禁.mjs`（不接管道、不 shell）。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const PY_TESTS = ['tests', 'test']
const runners = {
  python: { exe: 'python', args: ['-m', 'pytest', '-q'], kind: 'unit', name: 'pytest' },
  go: { exe: 'go', args: ['test', './...'], kind: 'unit', name: 'go test' },
  cargo: { exe: 'cargo', args: ['test'], kind: 'unit', name: 'cargo test' },
  make: { exe: 'make', args: ['test'], kind: 'unit', name: 'make test' },
  dotnet: { exe: 'dotnet', args: ['test'], kind: 'unit', name: 'dotnet test' },
}

/** 读 `gate.json`（项目根优先，其次 cwd）。坏文件不吞：返回 {error} 让门禁如实报。 */
export function readGateJson (project, cwd) {
  const cands = [join(project, 'gate.json')]
  if (cwd && cwd !== project) cands.push(join(cwd, 'gate.json'))
  for (const p of cands) {
    if (!existsSync(p)) continue
    try {
      const j = JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
      return { path: p, data: j }
    } catch (e) {
      return { path: p, error: `gate.json 解析失败：${String(e?.message ?? e)}` }
    }
  }
  return null
}

/** 把 gate.json 的 steps 归一成 [{kind,name,exe,args,evidence,required,timeoutSec}]；cmd 字符串按空格切（不借 shell）。 */
export function stepsFromGateJson (data) {
  const raw = Array.isArray(data?.steps) ? data.steps : []
  const steps = []
  for (const s of raw) {
    if (!s) continue
    const kind = String(s.kind ?? 'unit')
    // ★ 2026-10-26（§二）：`kind:"e2e"` 的步骤要带上 `evidence` / `required` / `timeoutSec`，
    //   内核靠它们去校验入口证据（不看这三项就没法判"证据在不在、是不是这条命令产出的"）。
    const extra = {
      evidence: s.evidence === undefined ? undefined : String(s.evidence),
      required: s.required === undefined ? undefined : s.required === true,
      timeoutSec: Number.isFinite(Number(s.timeoutSec)) ? Number(s.timeoutSec) : undefined
    }
    if (s.exe) {
      steps.push({ kind, name: String(s.name ?? s.exe), exe: String(s.exe), args: (s.args ?? []).map(String), ...extra })
      continue
    }
    const cmd = String(s.cmd ?? s.command ?? '').trim()
    if (!cmd) continue
    const [exe, ...args] = cmd.split(/\s+/)
    steps.push({ kind, name: String(s.name ?? exe), exe, args, ...extra })
  }
  return steps
}

/** 是否存在该生态的标记文件（cwd 优先，其次项目根）。 */
function anyExists (dirs, names) {
  for (const d of dirs) for (const n of names) if (existsSync(join(d, n))) return join(d, n)
  return null
}

/**
 * 解析出 plan：`{source, steps, degraded, note, gateJsonPath}`
 *   source: 'gate.json' | 'npm' | 'python' | 'go' | 'cargo' | 'make' | 'dotnet' | 'none'
 *   npm 时 steps 为空数组（调用方继续用原有 npm 逻辑，零行为变化）。
 */
export function resolvePlan ({ project, cwd }) {
  const dirs = [cwd, project].filter(Boolean).filter((d, i, a) => a.indexOf(d) === i)

  const gj = readGateJson(project, cwd)
  // ★ 2026-10-21 实测教训：`gate.json` 只写开关（如 `{"requireAC":true}`）**不是错误** ——
  //   早先的写法会直接判 exit 2（"gate.json 里没有可执行 steps"），等于"想开个闸门，反而把门禁弄红"。
  //   现在的口径：能解析就解析；steps 为空 ⇒ **只当开关用，继续往下探测**。
  if (gj?.error) return { source: 'gate.json', steps: [], degraded: false, note: gj.error, gateJsonPath: gj.path, error: true }
  const requireAC = !!gj?.data?.requireAC
  const gateJsonPath = gj?.path ?? null
  if (gj?.data) {
    const steps = stepsFromGateJson(gj.data)
    if (steps.length) return { source: 'gate.json', steps, degraded: false, gateJsonPath, note: null, requireAC }
  }

  if (anyExists(dirs, ['package.json'])) return { source: 'npm', steps: [], degraded: false, note: null, requireAC, gateJsonPath }

  const pyMarker = anyExists(dirs, ['pyproject.toml', 'pytest.ini', 'setup.cfg', 'tox.ini', 'requirements.txt'])
  // ★ 2026-10-26 修（假环境）：原来"有 tests/ 目录"就当 Python 项目 ⇒ 一个 Node 项目只要有个
  //   `tests/` 文件夹就被判成"pytest 没装"（实测发生在工作台根：它有 `tests/*.mjs`）。
  //   现判据：`tests/` 里**得有 .py 文件**才算 Python 测试根。
  const pyTests = dirs.some(d => PY_TESTS.some(t => {
    const dir = join(d, t)
    if (!existsSync(dir)) return false
    try { return readdirSync(dir).some(f => /\.py$/i.test(f)) } catch { return false }
  }))
  if (pyMarker || pyTests) return { source: 'python', steps: [runners.python], degraded: false, note: pyMarker ?? 'tests/*.py', requireAC, gateJsonPath }
  if (anyExists(dirs, ['go.mod'])) return { source: 'go', steps: [runners.go], degraded: false, note: 'go.mod', requireAC, gateJsonPath }
  if (anyExists(dirs, ['Cargo.toml'])) return { source: 'cargo', steps: [runners.cargo], degraded: false, note: 'Cargo.toml', requireAC, gateJsonPath }
  if (anyExists(dirs, ['*.sln', '*.csproj']) || dirs.some(d => { try { return readdirSync(d).some(f => /\.(sln|csproj)$/i.test(f)) } catch { return false } })) {
    return { source: 'dotnet', steps: [runners.dotnet], degraded: false, note: '*.sln/*.csproj', requireAC, gateJsonPath }
  }
  const mk = anyExists(dirs, ['Makefile', 'makefile', 'GNUmakefile'])
  if (mk) {
    try {
      const txt = readFileSync(mk, 'utf8')
      if (/^test\s*:/m.test(txt)) return { source: 'make', steps: [runners.make], degraded: false, note: 'Makefile 有 test 目标', requireAC, gateJsonPath }
    } catch {}
  }
  return { source: 'none', steps: [], degraded: true, note: '没有找到测试入口（没有 package.json / pytest 标记 / go.mod / Cargo.toml / Makefile.test）', requireAC, gateJsonPath }
}
