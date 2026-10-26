#!/usr/bin/env node
/**
 * 角色规矩的**渲染器**（开源准备 W3 / D27）
 *
 * 为什么需要它：
 *   `roles\brain.md` 里写着带盘符的绝对路径（`node "<工作台根>\_unattended\编排.mjs"` 这种）——
 *   它既是泄露（把作者的机器布局发给所有人），也是隐患（用户装到别的盘，脑子照原路径敲命令，全是"文件不存在"）。
 *   但**不能**直接在里面写 `{{WORKBENCH}}`：大脑是**运行时直读**这个文件的
 *   （实证：`~\.dsh\profiles\desktop\cordis.patch.yml` 的 persona 是一段
 *    `!!js ... readFileSync('<工作台根>/_unattended/roles/brain.md')`），
 *   写占位符 ⇒ 下一轮大脑就照着占位符敲命令。
 *
 * 所以拆成两层：
 *   · `roles\<名>.template.md` —— **模板**，含 `{{WORKBENCH}}` / `{{KB}}`，**随包发**
 *   · `roles\<名>.md`          —— **渲染稿**，本机真路径，**不随包发**（由本脚本生成）
 *
 * 幂等：内容一样就不写（`--dry` 只报不写）。
 *
 * 用法：
 *   node _渲染角色.mjs            # 渲染（只在内容变了时写）
 *   node _渲染角色.mjs --dry      # 只报差异
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { HERE, WORKSPACE, KB, DSH_ROOT, HOME_DIR } from './_路径.mjs'

export const ROLES_DIR = join(HERE, 'roles')
export const TPL_SUFFIX = '.template.md'

/** 模板里能用的占位符。取不到的值不猜，渲染成 `<...>` 让人一眼看见。 */
export function tokens () {
  return {
    WORKBENCH: WORKSPACE,
    KB: KB ?? '<知识库>',
    DSH根: DSH_ROOT ?? '<DSH根>',
    DSHROOT: DSH_ROOT ?? '<DSH根>',
    HOME: HOME_DIR ?? '<用户目录>',
    坑库: (KB ? join(KB, '坑') : null) ?? '<坑库>'
  }
}

export function renderText (text, tk = tokens()) {
  return String(text).replace(/\{\{\s*([A-Za-z\u4e00-\u9fa5]+)\s*\}\}/g, (all, key) =>
    Object.hasOwn(tk, key) ? tk[key] : all)
}

/** 列出所有模板（相对 roles 目录的文件名） */
export function listTemplates () {
  let es = []
  try { es = readdirSync(ROLES_DIR) } catch { return [] }
  return es.filter(f => f.endsWith(TPL_SUFFIX)).sort()
}

/**
 * 渲染全部。返回 `[{ name, out, changed, skipped }]`
 * `changed=false` 表示内容一样（幂等：第二次跑什么都不写）
 */
export function renderAll ({ dry = false } = {}) {
  const tk = tokens()
  const out = []
  for (const tpl of listTemplates()) {
    const outName = tpl.slice(0, -TPL_SUFFIX.length) + '.md'
    const tplPath = join(ROLES_DIR, tpl)
    const outPath = join(ROLES_DIR, outName)
    const body = renderText(readFileSync(tplPath, 'utf8'), tk)
    const prev = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null
    const changed = prev !== body
    if (changed && !dry) writeFileSync(outPath, body, 'utf8')
    out.push({ name: outName, out: outPath, changed, skipped: !changed })
  }
  return out
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  const dry = process.argv.includes('--dry')
  const rs = renderAll({ dry })
  if (!rs.length) {
    console.error(`[渲染角色] ❌ ${ROLES_DIR} 里一个 ${TPL_SUFFIX} 都没有 —— 包不完整（模板应随包发）`)
    process.exit(2)
  }
  for (const r of rs) console.log(`  ${r.changed ? (dry ? '要改' : '已写') : '未变'}  ${r.name}`)
  console.log(`[渲染角色] ${rs.filter(r => r.changed).length}/${rs.length} 个有变化${dry ? '（--dry，没写）' : ''}`)
  process.exit(0)
}
