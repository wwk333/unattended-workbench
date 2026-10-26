/**
 * 角色模型自检 —— 对 `_crew\agents.json` 里的角色**逐个发一次哑调用**，验"名字在册 ≠ 参数真被接受"。
 *
 * 为什么必须有它：换模型/换档位/换网关之后，配置里写的名字**可能根本不被接受**
 * （实测踩过：档位表没写全会报 UNSUPPORTED_REASONING_EFFORT；网关不认 developer 角色会 400）。
 * 只有真发一次请求、读回信封，才算验过。
 *
 * 用法：
 *   node _角色自检.mjs                    # 跑全部角色
 *   node _角色自检.mjs --only reviewer    # 只跑某几个（逗号分隔）
 *   node _角色自检.mjs --dry              # 只打印将要发的命令，不发请求（零花费）
 *
 * 口径：**只花一次最小请求的钱**（prompt 是"只回复OK"，档位照配置来）。
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, resolveRole, buildInvocation, envFor, parseCarrierOutput } from './_agents-config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUTDIR = join(HERE, 'logs', '_角色自检')
mkdirSync(OUTDIR, { recursive: true })

const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }
const DRY = has('dry')
const ONLY = (opt('only') ?? '').split(/[,;，]/).map(s => s.trim()).filter(Boolean)

const { cfg, source, warnings } = loadConfig()
console.log(`班组配置：${source}`)
for (const w of warnings) console.log(`  ⚠️ ${w}`)

const ROLES = Object.keys(cfg.roles).filter(r => !ONLY.length || ONLY.includes(r))
if (!ROLES.length) { console.error(`--only 没匹配到角色；可用：${Object.keys(cfg.roles).join(' / ')}`); process.exit(1) }

const PROMPT = '只回复两个字：OK'
let bad = 0
const summary = []

for (const role of ROLES) {
  const res = resolveRole(role, cfg)
  const inv = buildInvocation(res, PROMPT, { cwd: OUTDIR })
  const label = `${role}（${res.agentName}${res.route ? '·' + res.route : ''} / ${res.model} @ ${res.effort}）`
  console.log(`\n===== ${label} =====`)
  console.log(`命令：${inv.argvForDisplay.join(' ')}`)

  if (DRY) { summary.push({ role, ok: null, note: 'dry-run' }); continue }

  const started = Date.now()
  const r = spawnSync(inv.exe, inv.argv, {
    encoding: 'utf8', maxBuffer: 32 << 20, timeout: 10 * 60 * 1000,
    cwd: OUTDIR, env: envFor(res, process.env), windowsHide: true
  })
  const took = Date.now() - started
  const out = r.stdout ?? ''
  const env = parseCarrierOutput(out, r.stderr)   // ★ 单信封 / JSON 数组 / JSONL 都认；stdout 空时看 stderr 定性

  const errTail = (r.stderr ?? '').trim().slice(-260).replace(/\s+/g, ' ')
  const isErr = env.isError === true
  // ★ 2026-10-06 补（三方交叉验证指出：`方案.md:187` 宣称本自检读 `permission_denials`，实际从来没读）：
  //   被拒条目的意义和"跑失败"不同 —— 它说明**这个角色的权限面被卡住**（例：审核员曾被 plan 模式拒 Bash，
  //   于是"能跑测试"这条能力**名存实亡**，而自检照样报"通过"）。
  //   现在的口径：**有被拒条目也算不通过**（`denials` 一票否决），并在汇总里显式标出来。
  const denials = Array.isArray(env.permissionDenials) ? env.permissionDenials.length : 0
  const ok = r.status === 0 && !isErr && denials === 0
  if (!ok) bad++

  console.log(`exit=${r.status}  耗时=${(took / 1000).toFixed(1)}s  ${ok ? '✅ 通过' : '❌ 未通过'}${denials ? `　⚠️ 权限被拒 ${denials} 条` : ''}`)
  console.log(`信封[${env.kind}]：is_error=${env.isError} stop_reason=${env.stopReason} result=${JSON.stringify(String(env.result).slice(0, 60))}`)
  if (env.usage) console.log(`用量：${JSON.stringify(env.usage)}`)
  if (env.toolCalls) console.log(`工具调用：${env.toolCalls} 次`)
  if (env.credits !== undefined) console.log(`credits/cost：${env.credits}`)
  if (env.error) console.log(`⚠️ 报错：${env.error}`)
  if (env.kind === 'unknown') console.log(`（stdout 前 160 字）：${out.slice(0, 160).replace(/\s+/g, ' ')}`)
  if (errTail) console.log(`stderr 末：${errTail}`)
  writeFileSync(join(OUTDIR, `${role}.out.json`), out || '(空)', 'utf8')
  writeFileSync(join(OUTDIR, `${role}.err.txt`), r.stderr ?? '', 'utf8')
  summary.push({ role, ok, took: (took / 1000).toFixed(1), model: res.model, effort: res.effort, agent: res.agentName, route: res.route ?? null, denials })
}

console.log('\n===== 汇总 =====')
for (const s of summary) {
  console.log(`  ${s.role.padEnd(12)} ${s.ok === null ? '（dry-run）' : s.ok ? '✅' : '❌'}  ${s.agent}${s.route ? '·' + s.route : ''}  ${s.model} @ ${s.effort}${s.took ? '  ' + s.took + 's' : ''}${s.denials ? `  ⚠️ 权限被拒 ${s.denials} 条` : ''}`)
}
console.log(bad === 0 ? '\n全部通过（含"没有被权限拒绝"这项）。' : `\n有 ${bad} 个角色未通过 —— 换模型/档位之前别开工。`)
console.log('口径：**被拒条目（permission_denials）一票否决** —— 它不是"跑失败"，而是"这个角色的权限面被卡住"（例：审核员被拒 Bash ⇒ "能跑测试"名存实亡）。')
process.exit(bad === 0 ? 0 : 1)
