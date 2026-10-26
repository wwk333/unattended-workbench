#!/usr/bin/env node
/**
 * uninstall —— 照着安装账逐条回滚
 *
 * 纪律（和 setup 对称）：
 *   · **只删账上记过的**。没记过的东西一律不碰 —— 宁可留一点，也不误删别人的。
 *   · **保留** `config\`（用户的配置）、`_crew\`（用户的数据）、用户自己的项目目录。
 *   · **坑库默认不删**（删了等于忘掉所有教训）；要删必须单独 `--purge-vault` 明确要求。
 *   · 先干跑。`--dry` 会把"将要删什么"列全，不真删。
 *
 * 用法：
 *   node uninstall.mjs --dry       # 只看要删什么
 *   node uninstall.mjs             # 真删（会二次确认）
 *   node uninstall.mjs --yes       # 不确认（脚本/自动化用）
 *   node uninstall.mjs --purge-vault   # 连坑库一起删（危险，单独开关）
 */
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

import { WORKSPACE, CONFIG_DIR, VAULT } from './_unattended/_路径.mjs'

const CREW = join(WORKSPACE, '_crew')
const MANIFEST = join(CREW, 'install-manifest.json')
const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)

/** 一律不删（哪怕账上记过） */
const KEEP = [CONFIG_DIR, CREW, join(WORKSPACE, 'agents')]

function loadManifest () {
  if (!existsSync(MANIFEST)) return { events: [] }
  try { return JSON.parse(readFileSync(MANIFEST, 'utf8')) } catch { return { events: [], broken: true } }
}

/** 从账里还原"我们建过哪些目录"（setup 只记 id，这里按 id 映射回路径） */
function targetsOf (man) {
  const fixed = new Set(man.events?.flatMap(e => e.fixed ?? []) ?? [])
  const out = []
  if (fixed.has('crew')) out.push({ id: 'crew', path: join(CREW, 'gate'), kind: 'dir' })
  return out
}

async function confirm (q) {
  if (has('yes')) return true
  if (!process.stdin.isTTY) return false
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const a = await rl.question(`${q}（输入 yes 继续）：`)
  rl.close()
  return /^yes$/i.test(a.trim())
}

const main = async () => {
  const dry = has('dry')
  const man = loadManifest()
  console.log(`\n[uninstall] 工作台：${WORKSPACE}`)
  if (man.broken) console.log('  ⚠️ install-manifest.json 坏了 ⇒ 只能做"安全的那部分"（逐步列给你看）')

  // ① 计划任务
  const task = join(WORKSPACE, '_unattended', '计划任务.mjs')
  let taskState = '未装/未建'
  if (existsSync(task)) {
    const r = spawnSync(process.execPath, [task, '--status'], { encoding: 'utf8', windowsHide: true })
    try { taskState = JSON.parse(String(r.stdout ?? '{}')).exists ? '在册（要删）' : '不在册' } catch { taskState = '查不到' }
  }
  console.log(`  · 计划任务：${taskState}`)

  // ② 我们建过的东西
  const targets = targetsOf(man)
  console.log(`  · 账上记录的生成物：${targets.length} 项`)
  for (const t of targets) console.log(`      - ${t.path}${existsSync(t.path) ? '' : '（已不存在）'}`)

  // ③ 永远保留的
  console.log('  · **保留**：config\\（你的配置）、_crew\\（你的数据：台账/门禁/账本）、你的项目目录')
  if (VAULT) console.log(`  · 坑库：${VAULT}　${has('purge-vault') ? '**将被删除**（--purge-vault）' : '保留（要删加 --purge-vault）'}`)

  if (dry) { console.log('\n[uninstall] --dry：什么都没删。\n'); return 0 }

  if (!await confirm('\n以上是要回滚的内容，确认继续？')) {
    console.log('[uninstall] 已取消（没有做任何修改）')
    return 2
  }

  // ④ 删计划任务
  if (existsSync(task) && taskState.startsWith('在册')) {
    const r = spawnSync(process.execPath, [task, '--uninstall'], { stdio: 'inherit', windowsHide: true })
    console.log(`  ${r.status === 0 ? '✅' : '❌'} 计划任务`)
  }

  // ⑤ 删账上的生成物（避开 KEEP）
  for (const t of targets) {
    if (!existsSync(t.path)) continue
    if (KEEP.some(k => t.path.toLowerCase().startsWith(k.toLowerCase()))) { console.log(`  ⏭ 跳过（保留）：${t.path}`); continue }
    try { rmSync(t.path, { recursive: true, force: true }); console.log(`  ✅ 已删 ${t.path}`) } catch (e) { console.log(`  ❌ 删不掉 ${t.path}：${String(e?.message ?? e)}`) }
  }

  if (has('purge-vault') && VAULT && existsSync(VAULT)) {
    const ok = await confirm(`确定连坑库一起删？${VAULT}`)
    if (ok) { rmSync(VAULT, { recursive: true, force: true }); console.log(`  ✅ 已删坑库 ${VAULT}`) } else console.log('  ⏭ 坑库保留')
  }

  console.log('\n[uninstall] 完成。')
  console.log('  你的 config\\ 与 _crew\\ 还在（里面有你的配置、台账、账本）。')
  console.log('  这一层目录现在可以整个删掉了 —— 删之前确认里面没有你还想要的东西。\n')
  return 0
}

process.exit(await main())
