#!/usr/bin/env node
/**
 * 剖析.mjs（v2）—— 《项目剖析文档》通用机器区工具（**写一次，所有项目共用**，不许每个项目各写一份）
 *
 * 干什么：
 *   1 扫库里所有名为「项目剖析」的文件夹；
 *   2 每册 `00-总目录.md` 的 frontmatter 读 `项目根`；
 *   3 每页 frontmatter 读 `源文件`（相对项目根，也可写绝对路径）；
 *   4 把源文件内容灌进 <!-- AUTO:BEGIN --> 与 <!-- AUTO:END --> 之间；
 *   5 回填该页 frontmatter 的 `规模`（行数+字节）/ `指纹`（sha256 前 12 位）/ `抓取`（当天日期）。
 *
 * 安全底线：
 *   · 只动 AUTO 区 与 那三个 frontmatter 字段；**绝不碰**人话区与「我的批注」区；
 *   · 写前先备份到该册的 `.剖析备份\`（Obsidian 不显示点开头目录），再"写临时文件 + 改名"落地，避免写到一半崩成半截页；
 *   · 疑似密钥（路径含 secrets / key / token / 凭据 / 密钥）**默认不灌原文**，只在页面里留一行说明；
 *   · 任何一页出错只跳过那一页，不终止整轮。
 *
 * 用法：
 *   剖析.cmd                      # 灌原文 + 回填三个字段（= node 剖析.mjs）
 *   剖析.cmd --check              # 只体检不改：未灌 / 过期 / 孤儿 / AUTO 缺失，一次列清
 *   剖析.cmd --dry                # 只打印将要处理什么（含"这页有没有 AUTO 标记"），不写
 *   node 剖析.mjs --vault "{{知识库}}"
 *
 * 退出码：0 = 正常；1 = 有问题（--check 发现未灌/过期/孤儿；普通模式发现孤儿或整轮没灌成）；2 = 环境错。
 */

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

const argv = process.argv.slice(2)
const has = (n) => argv.includes('--' + n)
const opt = (n, d = null) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] ?? d : d }

const VAULT = resolve(opt('vault') ?? process.env.DSH_KNOWLEDGE_VAULT ?? '{{知识库_JS}}')
const CHECK = has('check')
const DRY = has('dry')
const BOOK_DIR = '项目剖析'
const BACKUP_DIR = '.剖析备份'
const SKIP_DIRS = new Set(['.trash', '.obsidian', 'node_modules', '.git', BACKUP_DIR])
const TEXT_EXT = new Set(['.md', '.txt', '.json', '.jsonl', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.csv', '.log', '.html', '.css', '.gitignore'])
const CODE_EXT = new Set(['.mjs', '.cjs', '.js', '.ts', '.tsx', '.cmd', '.bat', '.ps1', '.sh', '.py'])
const MAX_BYTES = 2 * 1024 * 1024
// 疑似密钥：目录叫 secrets、或文件名里带 key/token/secret/credential/凭据/密钥
const SECRET_RE = /(^|[\\/])secrets?([\\/]|$)|(^|[\\/])[^\\/]*(key|token|secret|credential|凭据|密钥)[^\\/]*$/i
const BOM = /^\uFEFF/
const strip = (s) => s.replace(BOM, '')
const today = new Date().toISOString().slice(0, 10)
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
const sha12 = (buf) => createHash('sha256').update(buf).digest('hex').slice(0, 12)
const rel = (p) => p.replace(/\\/g, '/')
const ext = (p) => { const m = p.match(/\.[A-Za-z0-9]+$/); return m ? m[0].toLowerCase() : '' }
/** 给原文套围栏：长度按源文里最长的一串反引号 +1（至少 4 道），保证源文里的 ``` 不会把围栏提前闭合。
 *  围栏之间**一行都不改**——围栏只是册子加的边界，原文还是原文。
 *  为什么要围栏：裸文本灌进去会让源文的标题变成这一页的标题、源文的标签变成这一页的标签、
 *  源文里的双链也真的连出去 ⇒ 读者分不清"哪块是原文、哪块是册子写的话"。 */
function fenceFor (text, lang) {
  const runs = text.match(/`{3,}/g) ?? []
  const n = Math.max(3, ...runs.map((s) => s.length)) + 1
  const f = '`'.repeat(n)
  return `${f}${lang || 'text'}\n${text}\n${f}`
}

function findBookDirs (root) {
  const out = []
  const walk = (dir) => {
    let items = []
    try { items = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const it of items) {
      if (!it.isDirectory()) continue
      if (SKIP_DIRS.has(it.name) || it.name.startsWith('.')) continue
      const full = join(dir, it.name)
      if (it.name === BOOK_DIR) { out.push(full); continue }
      walk(full)
    }
  }
  walk(root)
  return out
}

// ── frontmatter：只读写指定字段，其余原样保留 ───────────────────────────
function splitFm (text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!m) return null
  return { fm: m[1], body: text.slice(m[0].length) }
}
function fmGet (fm, key) {
  const m = fm.match(new RegExp('^' + key + '[ \\t]*:[ \\t]*(.*)$', 'm'))
  return m ? m[1].trim().replace(/^["']|["']$/g, '').trim() : null
}
function fmSet (fm, key, value) {
  const re = new RegExp('^' + key + '[ \\t]*:.*$', 'm')
  if (re.test(fm)) return fm.replace(re, () => `${key}: ${value}`)   // 用函数替换，值里的 $ 不会被当替换模式
  return fm.replace(/\s*$/, '') + `\n${key}: ${value}`
}

function main () {
  if (!existsSync(VAULT)) { console.error(`✗ 库根不存在：${VAULT}（用 --vault 指定）`); process.exit(2) }
  const books = findBookDirs(VAULT)
  if (!books.length) { console.error(`✗ 库里没找到任何名为「${BOOK_DIR}」的文件夹`); process.exit(2) }

  let hasSrc = 0, filled = 0, unchanged = 0, stale = 0, orphan = 0, notFilled = 0, noAuto = 0, noSrcField = 0, errs = 0
  const staleList = [], orphanList = [], notFilledList = [], noAutoList = [], errList = []

  for (const book of books) {
    const indexPath = join(book, '00-总目录.md')
    let projectRoot = null
    if (existsSync(indexPath)) {
      const sp = splitFm(strip(readFileSync(indexPath, 'utf8')))
      projectRoot = sp ? fmGet(sp.fm, '项目根') : null
    }
    if (!projectRoot) { console.log(`⚠ ${rel(book)}：首页没写 项目根，整册跳过`); continue }

    for (const name of readdirSync(book)) {
      if (!name.toLowerCase().endsWith('.md')) continue
      if (name === '00-总目录.md') continue
      const pagePath = join(book, name)
      try {
        const sp = splitFm(strip(readFileSync(pagePath, 'utf8')))
        if (!sp) { noSrcField++; continue }                       // 无 frontmatter：不是本工具的页
        const srcField = fmGet(sp.fm, '源文件')
        if (!srcField) { noSrcField++; continue }                 // 总纲 / 机制页：本来就没有源文件
        hasSrc++

        const srcPath = isAbsolute(srcField) ? srcField : resolve(projectRoot, srcField)
        if (!existsSync(srcPath)) {
          orphan++; orphanList.push(`${name} → ${srcField}`)
          console.log(`✗ 孤儿页  ${name}：源文件不存在 ${srcField}`)
          continue
        }

        const buf = readFileSync(srcPath)
        const sha = sha12(buf)
        const stored = fmGet(sp.fm, '指纹') ?? ''
        const lines = strip(buf.toString('utf8')).split(/\r?\n/).length
        const size = `${lines} 行 / ${buf.length} 字节`
        const skipField = fmGet(sp.fm, '跳过原文')

        // 这页该不该灌原文
        let inject = null
        let verbatim = false          // true = 这段是源文原文（要套围栏）；false = 工具自己写的一句说明
        if (skipField === '是') inject = '（本页按页头 `跳过原文: 是` 跳过原文）'
        else if (SECRET_RE.test(rel(srcField))) inject = '（本页原文被工具按规则跳过：疑似含密钥，不许进库）'
        else if (!TEXT_EXT.has(ext(srcField))) inject = null      // 代码 / 其它类型：非代码不灌，代码也不灌
        else if (buf.length > MAX_BYTES) inject = `（本页原文被工具跳过：文件 ${buf.length} 字节，超过 ${MAX_BYTES} 上限）`
        else {
          const t = strip(buf.toString('utf8'))
          if (/[\uFFFD]/.test(t)) inject = '（本页原文被工具跳过：不是 UTF-8 文本）'
          else { inject = t.replace(/\r?\n/g, '\n').trimEnd(); verbatim = true }
        }

        const isCode = CODE_EXT.has(ext(srcField))
        const autoRe = /(<!--\s*AUTO:BEGIN\s*-->)([\s\S]*)(<!--\s*AUTO:END\s*-->)/   // 贪婪：源文里若也有标记，取最后一个 END
        const hasAuto = autoRe.test(sp.body)

        if (CHECK) {
          if (!stored) { notFilled++; notFilledList.push(name); console.log(`◻ 未灌过  ${name}`) }
          else if (stored !== sha) { stale++; staleList.push(`${name}（页里 ${stored} ≠ 现在 ${sha}）`); console.log(`⚠ 过期    ${name}`) }
          else console.log(`✅ 未过期  ${name}`)
          if (!hasAuto && !isCode) { noAuto++; noAutoList.push(name) }
          continue
        }
        if (DRY) {
          console.log(`将写：${name}（${size}，指纹 ${sha}）原文=${inject === null ? '不灌（代码）' : '灌'} AUTO=${hasAuto ? '有' : '没有'}${stored === sha ? ' [已是最新]' : ''}`)
          continue
        }

        let body = sp.body
        if (hasAuto && inject !== null) {
          const payload = verbatim ? fenceFor(inject, ext(srcField).slice(1) || 'text') : inject
          body = body.replace(autoRe, (_m, a, _b, c) => `${a}\n${payload}\n${c}`)
        }

        let fm = sp.fm
        fm = fmSet(fm, '规模', size)
        fm = fmSet(fm, '指纹', sha)
        fm = fmSet(fm, '抓取', today)
        const next = `---\n${fm}\n---\n${body}`
        if (next === strip(readFileSync(pagePath, 'utf8'))) { unchanged++; console.log(`= 无变化  ${name}`); continue }

        const bkDir = join(book, BACKUP_DIR)
        if (!existsSync(bkDir)) mkdirSync(bkDir, { recursive: true })
        copyFileSync(pagePath, join(bkDir, `${name}.${stamp}.bak`))
        const tmp = pagePath + '.tmp'
        writeFileSync(tmp, next, 'utf8')
        renameSync(tmp, pagePath)
        filled++
        console.log(`✅ 已灌    ${name}：${size}，指纹 ${sha}`)
      } catch (e) {
        errs++; errList.push(`${name}：${e && e.message ? e.message : e}`)
        console.log(`✗ 出错    ${name}：${e && e.message ? e.message : e}`)
      }
    }
  }

  console.log('')
  if (CHECK) {
    console.log(`体检：有源文件 ${hasSrc} 页 · 未灌过 ${notFilled} · 过期 ${stale} · 孤儿 ${orphan} · 缺 AUTO 标记 ${noAuto}（无源文件的页 ${noSrcField} 页不参与）`)
    if (notFilledList.length) console.log('未灌过：\n  ' + notFilledList.join('\n  '))
    if (staleList.length) console.log('过期页：\n  ' + staleList.join('\n  '))
    if (orphanList.length) console.log('孤儿页：\n  ' + orphanList.join('\n  '))
    if (noAutoList.length) console.log('缺 AUTO 标记（非代码页却没有标记，灌不进原文）：\n  ' + noAutoList.join('\n  '))
    const problems = notFilled + stale + orphan + noAuto + errs
    // ★ 判定必须打在 stdout：批处理启动器链尾的 pause 会把退出码吃掉（实测恒 0），
    //   双击的人只看得见屏幕，靠退出码会读成"全一致"（假绿灯）。
    console.log(problems
      ? `❌ 判定：有问题 ${problems} 处（上面按类列了）`
      : '✅ 判定：全一致')
    process.exit(problems ? 1 : 0)
  }
  console.log(`${DRY ? '（演练，未写任何文件）' : '完成'}：已灌 ${filled} 页 · 无变化 ${unchanged} 页 · 孤儿 ${orphan} · 出错 ${errs}`)
  if (errList.length) console.log('出错明细：\n  ' + errList.join('\n  '))
  if (orphanList.length) console.log('孤儿页：\n  ' + orphanList.join('\n  '))
  process.exit((orphan + errs) ? 1 : 0)
}

main()
