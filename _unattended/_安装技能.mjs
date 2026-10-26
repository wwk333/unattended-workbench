#!/usr/bin/env node
/**
 * 安装技能：把包里的 `skills\<名>\`（模板）渲染到 `~\.dsh\skills\<名>\`
 *
 * 为什么要渲染，而不是直接软链/直接指过去：
 *   技能正文里写着**项目根**和**工作台根**（`<项目根>\<拼音>\`、`node "<工作台根>\_unattended\调研索引.mjs"`）。
 *   包里发的是占位符模板；如果大脑读到的还是 `{{项目根}}`，它会照着占位符敲命令。
 *   所以：**包内是模板，装到 DSH 之前渲染一次**（和 `roles\*.template.md` 同一套思路，D27）。
 *
 * 幂等：内容一样就不写。`--dry` 只报不写。
 *
 * 用法：
 *   node _安装技能.mjs            # 装到 ~/.dsh/skills
 *   node _安装技能.mjs --dry      # 只报
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HERE, WORKSPACE, DSH_HOME, HOME_DIR, KB, NODE_BIN, PROJECTS_ROOT } from './_路径.mjs'

export const SRC_DIR = join(HERE, '..', 'skills')

export function tokens () {
  return {
    '工作台根': WORKSPACE,
    '知识库': KB ?? '<知识库>',
    // ⚠️ 取不到就落到「用户目录\xiangmu」——绝不能把 `<项目根>` 原样写进装好的技能，
    //    那会让大脑照着占位符去建文件夹（实测差点这么发出去）。
    '项目根': PROJECTS_ROOT ?? (HOME_DIR ? join(HOME_DIR, 'xiangmu') : (() => {
      throw new Error('拿不到「项目根」也拿不到用户目录：请在 config\\本机映射.json 填「项目根」')
    })()),
    // .cmd 里要真 node 的绝对路径；.mjs 里的字符串要**双反斜杠**转义形态，否则 \o 会被 JS 吃掉
    NODE: NODE_BIN ?? 'node',
    '知识库_JS': (KB ?? '<知识库>').replace(/\\/g, '\\\\'),
    WORKBENCH: WORKSPACE,
    KB: KB ?? '<知识库>',
    PROJECTS: PROJECTS_ROOT ?? '<项目根>'
  }
}

export function renderText (text, tk = tokens()) {
  return String(text).replace(/\{\{\s*([A-Za-z0-9_\u4e00-\u9fa5]+)\s*\}\}/g, (all, k) => (Object.hasOwn(tk, k) ? tk[k] : all))
}

/** 包里有哪几个技能 */
export function listSkills () {
  try {
    return readdirSync(SRC_DIR, { withFileTypes: true })
      .filter(e => e.isDirectory() && existsSync(join(SRC_DIR, e.name, 'SKILL.md')))
      .map(e => e.name)
      .sort()
  } catch { return [] }
}

/** 装到哪：`~/.dsh/skills`（DSH 认这个目录） */
export function targetDir () {
  return DSH_HOME ? join(DSH_HOME, 'skills') : null
}

/**
 * 返回 `[{ skill, file, changed }]`
 * `changed=false` 表示内容和目标完全一样（幂等：第二次跑什么都不写）
 */
export function installAll ({ dry = false, dest = null } = {}) {
  const out = []
  const to = dest ?? targetDir()
  if (!to) throw new Error('不知道装到哪：DSH 家目录没解析出来（先装 DSH 并登录一次）')
  const tk = tokens()
  for (const name of listSkills()) {
    const from = join(SRC_DIR, name)
    const walk = (rel) => {
      const srcDir = join(from, ...rel.filter(Boolean))
      for (const e of readdirSync(srcDir, { withFileTypes: true })) {
        const parts = [...rel, e.name]
        const s = join(from, ...parts)
        const d = join(to, name, ...parts)
        if (e.isDirectory()) { walk(parts); continue }
        if (/\.(exe|png|ico|jpg|jpeg|gif)$/i.test(e.name)) {
          mkdirSync(join(d, '..'), { recursive: true })
          if (!existsSync(d) || readFileSync(s).compare(readFileSync(d)) !== 0) { if (!dry) writeFileSync(d, readFileSync(s)); out.push({ skill: name, file: parts.join('/'), changed: true }) }
          else out.push({ skill: name, file: parts.join('/'), changed: false })
          continue
        }
        const body = renderText(readFileSync(s, 'utf8'), tk)
        const prev = existsSync(d) ? readFileSync(d, 'utf8') : null
        const changed = prev !== body
        if (changed && !dry) { mkdirSync(join(d, '..'), { recursive: true }); writeFileSync(d, body, 'utf8') }
        out.push({ skill: name, file: parts.join('/'), changed })
      }
    }
    walk([])
  }
  return out
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const dry = process.argv.includes('--dry')
  const names = listSkills()
  if (!names.length) { console.error(`[安装技能] ❌ ${SRC_DIR} 里一个技能都没有 —— 包不完整`); process.exit(2) }
  let rs
  try { rs = installAll({ dry }) } catch (e) { console.error('[安装技能] ❌ ' + String(e?.message ?? e)); process.exit(2) }
  const changed = rs.filter(r => r.changed)
  for (const n of names) {
    const mine = rs.filter(r => r.skill === n)
    console.log(`  ${mine.some(r => r.changed) ? (dry ? '要更新' : '已装') : '未变'}  ${n}（${mine.length} 个文件）`)
  }
  console.log(`[安装技能] 目标：${targetDir()}`)
  console.log(`[安装技能] ${changed.length} 个文件有变化${dry ? '（--dry，没写）' : ''}`)
  process.exit(0)
}
