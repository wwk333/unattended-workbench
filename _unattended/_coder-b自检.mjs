/**
 * coder-a / coder-b 双路验收 —— 走**生产同款**的装配与调用路径（真花额度，任务故意做得很小）。
 *
 * 为什么不用 PowerShell 手拼命令行：实测踩过 —— 把长 prompt 塞进 PowerShell 的
 * `-Command` 字符串里，嵌套引号会直接把整个会话锁死（我为此白等 20 分钟）。
 * 这里全程用 spawnSync(exe, argv) 传参数数组，prompt 作为 argv 末项，与 编排.mjs 完全一致。
 *
 * 用法: node _coder-b自检.mjs [--only coder-a|coder-b]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadConfig, resolveRole, buildInvocation, envFor } from './_agents-config.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUTDIR = join(HERE, 'logs', '_coder自检')
const only = (() => { const i = process.argv.indexOf('--only'); return i >= 0 ? process.argv[i + 1] : null })()

mkdirSync(OUTDIR, { recursive: true })
const { cfg, source, warnings } = loadConfig()
console.log(`班组配置：${source}`)
for (const w of warnings) console.log(`  ⚠️ ${w}`)

const ROLES = ['coder-a', 'coder-b'].filter(r => !only || r === only)
let bad = 0

for (const role of ROLES) {
  const res = resolveRole(role, cfg)
  const proj = join(OUTDIR, role)
  rmSync(proj, { recursive: true, force: true })
  mkdirSync(proj, { recursive: true })

  const marker = `${role}-ok-${Date.now()}`
  const task = [
    `在当前工作目录新建文件 ${role}.txt，只写三行：`,
    `第一行 ${marker}`,
    '第二行 你实际使用的模型名（原样，不要改写）',
    '第三行 你实际使用的推理档位（若你能看到）',
    '然后只回复 DONE。'
  ].join('\n')

  const inv = buildInvocation(res, task, { cwd: proj })
  console.log(`\n===== ${role} =====`)
  console.log(`agent=${res.agentName}  route=${res.route ?? '-'}  model=${res.model}  effort=${res.effort}`)
  console.log(`命令行: ${inv.argvForDisplay.slice(0, -1).join(' ')} "<PROMPT>"`)

  const started = Date.now()
  const r = spawnSync(inv.exe, inv.argv, {
    encoding: 'utf8', maxBuffer: 64 << 20, timeout: 20 * 60 * 1000,
    cwd: proj, env: envFor(res, process.env), windowsHide: true
  })
  const took = Date.now() - started
  const out = r.stdout ?? ''
  let env = null; try { env = JSON.parse(out) } catch {}

  const file = join(proj, `${role}.txt`)
  const fileOk = existsSync(file)
  const fileBody = fileOk ? readFileSync(file, 'utf8').trim() : '(没生成)'
  const markerOk = fileOk && fileBody.includes(marker)
  const ok = r.status === 0 && env?.is_error !== true && markerOk
  if (!ok) bad++

  console.log(`exit=${r.status}  耗时=${(took / 1000).toFixed(1)}s  ${ok ? '✅ 通过' : '❌ 未通过'}`)
  if (env) {
    console.log(`信封: is_error=${env.is_error} stop_reason=${env.stop_reason} provider=${env.provider} model=${env.model} effort=${env.reasoning_effort}`)
    console.log(`usage: ${JSON.stringify(env.usage)}  session=${env.session_id}`)
  } else {
    console.log(`⚠️ stdout 不是 JSON 信封（前 200 字）: ${out.slice(0, 200)}`)
  }
  console.log(`产物 ${role}.txt: ${fileOk ? '有' : '无'}；marker 命中=${markerOk}`)
  if (fileOk) console.log('--- 文件内容 ---\n' + fileBody)
  const st = (r.stderr ?? '').trim()
  if (st) console.log(`stderr 末 200 字: ${st.slice(-200).replace(/\s+/g, ' ')}`)
  writeFileSync(join(OUTDIR, `${role}.envelope.json`), out || '(空)', 'utf8')
}

console.log(`\n===== 汇总：${ROLES.length - bad} / ${ROLES.length} 通过 =====`)
process.exit(bad === 0 ? 0 : 1)
