#!/usr/bin/env node
/**
 * 安装「无人值守」preset —— 无人值守模式 · 第 3 步
 *
 * 一次只改一处、可回滚：备份 → 只追加一节 patch → 预检 → （可选）重启验证。
 *
 * ⚠️ 三条实测教训（都写进代码了，别再踩）：
 *   1. **`plan-mode` 的 `section` 是必填的多行正文**，缺了会
 *      `PlanModeConfig needs a non-empty 'section'` → preset 激活失败（broken）。
 *      而**broken 的 preset 会被客户端的模式 chip 过滤掉**
 *      （客户端源码 `presets.filter(p => p.broken === void 0)`）——
 *      所以现象是"装载成功但 chip 里看不到"，不是没装载。
 *   2. **别手抄那段正文**：它含单引号/破折号/长句，手拼进 YAML 会踩
 *      `can not read a block mapping entry; a multiline key may not be an implicit key`。
 *      正确做法是从发运件 `standard.patch.yml` 里**原样抠出来**（本脚本就这么干）。
 *   3. YAML 缩进错会被预检抓住并自动回滚 —— 这正是预检存在的意义。
 *
 * 用法：
 *   node 安装preset.mjs                # 演练：打印要追加多少行，不写文件
 *   node 安装preset.mjs --apply         # 真装（备份 + 只追加 + 预检，失败自动回滚）
 *   node 安装preset.mjs --rollback      # 还原到最近一次 desktop-before-preset-* 备份
 *   node 安装preset.mjs --apply --no-skills   # 不写 customSkillDirs（用于逐步定位问题）
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { CLI_JS as CLI_JS_P, DSH_EXE as DSH_EXE_P, NODE_BIN, need } from './_路径.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const NODE = process.env.DSH_NODE_EXE ?? need('专用 node（DSH 自带）', NODE_BIN)
const ELECTRON = process.env.DSH_ELECTRON_EXE ?? need('DSH 主程序', DSH_EXE_P)
const CLI_JS = process.env.DSH_CLI_JS ?? need('DSH headless 入口', CLI_JS_P)
const SHIPPED_STANDARD = 'D:/dsh桌面端/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'
const DSH_HOME = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const PROFILE_DIR = join(DSH_HOME, 'profiles', 'desktop')
const PATCH_FILE = join(PROFILE_DIR, 'cordis.patch.yml')
const BACKUP_ROOT = join(HERE, 'backup')
const LOG_DIR = join(HERE, 'logs')
const ROLES_FILE = join(HERE, 'roles', 'brain.md')
const SKILLS_DIR = 'D:/obsidian/知识库/AI知识库/人机协作SOP-唯一源/skills'

const argv = process.argv.slice(2)
const APPLY = argv.includes('--apply')
const ROLLBACK = argv.includes('--rollback')
const WITH_SKILLS = !argv.includes('--no-skills')
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const log = (...a) => console.log('[preset]', ...a)

// ------------------------------------------------------------------ 抠发运件的 plan-mode 节

function extractShippedPlanMode () {
  const script = `
const fs = require('fs');
const lines = fs.readFileSync(${JSON.stringify(SHIPPED_STANDARD)}, 'utf8').split(/\\r?\\n/);
const start = lines.findIndex(l => /- id: plan-mode\\s*$/.test(l));
if (start < 0) { process.stdout.write(''); process.exit(0); }
const baseIndent = lines[start].length - lines[start].trimStart().length;
let end = start + 1;
while (end < lines.length) {
  const l = lines[end];
  if (l.trim() === '') { end++; continue; }
  const ind = l.length - l.trimStart().length;
  if (ind <= baseIndent) break;
  end++;
}
while (end > start && lines[end - 1].trim() === '') end--;
process.stdout.write(lines.slice(start, end).join('\\n'));
`
  let text = ''
  try {
    text = execFileSync(ELECTRON, ['--expose-internals', '-e', script], {
      encoding: 'utf8', timeout: 60_000, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    }) ?? ''
  } catch (e) {
    log(`  ⚠️ 抠发运件 plan-mode 失败：${String(e?.message ?? e).slice(0, 100)}`)
    return null
  }
  text = text.replace(/\s+$/, '')
  if (!text) { log('  ⚠️ 发运件里没找到 plan-mode 节 → 本次不装 plan-mode'); return null }

  // 发运件里 `- id: plan-mode` 缩进 14；我们生成的树里同样要 14。
  const ls = text.split('\n')
  const base = ls[0].length - ls[0].trimStart().length
  const shift = 14 - base
  return ls.map(l => (shift === 0 ? l : shift > 0 ? ' '.repeat(shift) + l : l.slice(-shift))).join('\n')
}

// ------------------------------------------------------------------ 抠发运件的 preset-standard 整体

/**
 * 把发运件 `standard.patch.yml` 里 `- id: preset-standard` 那一节**整体原样抠出来**。
 *
 * 为什么整体照抄而不是自己写：
 *   实测连续踩了三次"简化"的坑 —— plan-mode 需要非空 section、
 *   tool-fs-search 需要 sampleOverCapGlobResults、tool-todo 需要 allowParallelInProgress，
 *   全是**必填**。自己"精简"等于制造 broken（而 broken 的 preset 会被模式 chip 过滤，
 *   表现是"看不到"，很容易误判成没装载）。
 *   ⟹ **发运件怎么写就怎么抄，只改 persona。**
 *
 * @returns 已对齐到 14 空格缩进的整节文本；抠不到返回 null。
 */
function extractShippedPresetStandard () {
  const script = `
const fs = require('fs');
const lines = fs.readFileSync(${JSON.stringify(SHIPPED_STANDARD)}, 'utf8').split(/\\r?\\n/);
const start = lines.findIndex(l => /- id: preset-standard\\s*$/.test(l));
if (start < 0) { process.stdout.write(''); process.exit(0); }
const baseIndent = lines[start].length - lines[start].trimStart().length;
let end = start + 1;
// 往后走到"缩进 <= baseIndent 的下一个列表项"或文件末尾
while (end < lines.length) {
  const l = lines[end];
  if (l.trim() === '') { end++; continue; }
  const ind = l.length - l.trimStart().length;
  if (ind <= baseIndent && /^-/.test(l.trimStart())) break;
  end++;
}
while (end > start && lines[end - 1].trim() === '') end--;
// 去掉开头的注释行（如果有）
let s = start;
while (s < end && /^\\s*#/.test(lines[s])) s++;
process.stdout.write(lines.slice(s, end).join('\\n'));
`
  let text = ''
  try {
    text = execFileSync(ELECTRON, ['--expose-internals', '-e', script], {
      encoding: 'utf8', timeout: 60_000, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }
    }) ?? ''
  } catch (e) {
    log(`  ⚠️ 抠 preset-standard 失败：${String(e?.message ?? e).slice(0, 120)}`)
    return null
  }
  text = text.replace(/\s+$/, '')
  return text || null
}

/** 把抠出来的 standard 节改写成本模式：换 id / name / order / persona。 */
function adaptStandard (block, personaBlock) {
  const ls = block.split('\n')
  const out = []
  for (let i = 0; i < ls.length; i++) {
    const l = ls[i]
    // 外层 Loader 条目 id：顺手改成 unattended 形状（便于在 dump 里一眼认出；
    // 注意它**不是** preset 身份，身份是下面那行 `id: unattended`）
    if (/^(\s*)- id: preset-standard\s*$/.test(l)) { out.push(l.replace('preset-standard', 'preset-unattended')); continue }
    if (/^\s+id: standard\s*$/.test(l)) {
      // ⚠️ 必须在 `id` 后补 `name` 与 `description`。
      //    实测踩过：发运件 standard **自己不写 name**（它靠 UI 内置名「标准」），
      //    所以我照抄出来的节里没有 name → **chip 显示裸 id（unattended）**、卡上"暂无描述"。
      //    照抄 ≠ 完整：内置 preset 靠 UI 表意，自定义 preset 必须自己写。
      const pad = l.match(/^(\s*)/)[1]
      out.push(`${pad}id: unattended`)
      out.push(`${pad}name: 无人值守`)
      out.push(`${pad}description: 一个大脑 + 可复用异源班组（载体可插拔：Pi / OpenCode / CodeBuddy / Qwen Code 等）：先看坑、两个 coder 并行、审核员异源只读复核`)
      continue
    }
    if (/^\s+order: 1\s*$/.test(l)) { out.push(l.replace('order: 1', 'order: 5')); continue }
    // persona：把整个 persona 条目替换成我们自己的（含规则内嵌）
    if (/^\s+- id: persona\s*$/.test(l)) {
      const ind = l.length - l.trimStart().length
      const pad = ' '.repeat(ind)
      out.push(`${pad}- id: persona`)
      out.push(`${pad}  name: '@deepseek-ai/dsh-persona'`)
      out.push(`${pad}  config:`)
      out.push(`${pad}    prefix: ${personaBlock}`)
      // ⚠️ 2026-10-18 修复：**不再写 suffix**。新版宿主（0.2.1）的 persona 渲染器只注册
      //    provider / model；`{{cwd}}` 未注册 ⇒ 组装提示词时**直接抛错**：
      //      unknown prompt variable "{{cwd}}" in section "deployment:persona-suffix";
      //      registered variables: provider, model
      //    ⇒ 会话在发出任何模型请求之前就失败（表现为「本轮运行失败」，大脑根本起不来）。
      //    宿主自带文档原话：「Remove the `Your working directory is {{cwd}}.` clause from
      //    home, profile, or invocation `personaSuffix` settings and preset `suffix` fields」；
      //    发运件 `preset-standard` 自己也没有 suffix。工作目录由宿主的 working-directory
      //    服务以**不做插值**的用户上下文提供，不需要我们在 suffix 里重复。
      // 跳过发运件里 persona 的后续行（直到下一个同级列表项）
      let j = i + 1
      while (j < ls.length) {
        const l2 = ls[j]
        if (l2.trim() === '') { j++; continue }
        const ind2 = l2.length - l2.trimStart().length
        if (ind2 <= ind && /^-/.test(l2.trimStart())) break
        j++
      }
      i = j - 1
      continue
    }
    // `name: 标准` 之类的显示名（若有）单独处理：
    out.push(l)
  }
  let text = out.join('\n')
  // 顶上补一段说明
  const header = [
    '# =============================================================================',
    `#  「无人值守」preset —— 由 安装preset.mjs 生成于 ${stamp}`,
    '#  做法：**整体照抄发运件 preset-standard，只替换 persona**。',
    '#        原因：自己"精简"配置会踩必填项（section / sampleOverCapGlobResults /',
    '#        allowParallelInInitProgress 等）→ preset broken → 被模式 chip 过滤掉。',
    '#  纪律：**不改 default / selectedDefault**；回滚 = 安装preset.mjs --rollback。',
    '# ============================================================================='
  ].join('\n')
  return `${header}\n- insert:\n${text.split('\n').map(l => '    ' + l).join('\n')}\n`
}

// ------------------------------------------------------------------ 生成 preset 一节

function buildSection () {
  const indent = (t, n) => t.split(/\r?\n/).map(l => ' '.repeat(n) + l).join('\n')
  // ⚠️ persona 用 **readFileSync 直读** brain.md，**不再内嵌副本**。
  //
  // 理由（用户 2026-09-26 拍板、写在 SOP\配置文件底稿.md 里的规矩）：
  //   「大脑运行时规则的唯一源 = roles\brain.md —— 大脑预设 persona 已 readFileSync 直读它，
  //     所以这里不再保留正文（消灭最后一处手抄副本）」。
  //
  // 🔴 **绝对别用 `require`**（2026-10-01 真踩，用户从 preset 卡片上看到：
  //    `persona (@deepseek-ai/dsh-persona): require is not defined`）
  //    `!!js` 的求值器是 `new Function("ctx","expr",'with(ctx){return eval(expr)}')`，
  //    而 cordis-plugin-loader **是 ESM** —— 编译期 `require` 是自由变量，运行时在 ESM 作用域解析 → 不存在。
  //    （我当初看到模块作用域里有 `const require = createRequire(import.meta.url)` 就下了结论，
  //      **漏了"整个文件是 ESM"**；而且我用"桥能列会话"当证据 —— 那只证明插件加载了，
  //      **根本没验 persona 的内容**，是个假阳性。）
  //    ✅ 正确写法：`globalThis.process.getBuiltinModule('fs')` —— Node 内置、ESM 下可用，实测能读到文件。
  //
  // ★ 2026-10-19（b192 · 施工文档 §四 M6-3 B6）：**注入前剥掉 HTML 注释**。
  //   为什么：B6 要给"因踩坑而加的"硬规矩补一行"为什么"（藏在 `<!-- -->` 里），那是**给人和以后的 AI 看的**，
  //   不该每轮都付费。persona 是**直读全文**注入的，DSH **不会自动剥注释** ⇒ 必须在这儿剥。
  //   ⚠️ 模板字面量里要写 `\\s\\S`：`\s` 不是合法转义，直接写会被吃掉反斜杠 ⇒ 生成的表达式变成 /<!---->/ 这个空正则。
  //   ⚠️ 顺序纪律：**这一步先生效，再往 brain.md 写注释**（否则注释会先进上下文、白花 token 一轮）。
  const personaBlock = `!!js globalThis.process.getBuiltinModule('fs').readFileSync('${ROLES_FILE.replace(/\\/g, '/')}', 'utf8').replace(/<!--[\\s\\S]*?-->/g,'')`
  const personaText = existsSync(ROLES_FILE)
    ? readFileSync(ROLES_FILE, 'utf8')
    : 'You are a coding agent powered by the {{model}} model.'
  // `--inline-persona`：退路 —— 万一 `!!js` 读文件在宿主里不可用，就把正文内嵌回去。
  // 代价是"规则改完要重装 preset"（会有漂移风险），所以**只在直读确实不行时用**。
  const useInline = argv.includes('--inline-persona')
  const personaBlockFinal = useInline ? `|-\n${indent(personaText.replace(/\s+$/, ''), 16)}` : personaBlock
  if (useInline) log('⚠️ --inline-persona：本次把规则正文内嵌进 preset（退路模式，改规则要重装）')

  // ============ 首选路径：整体照抄发运件 preset-standard，只替换 persona ============
  // 这条路最稳：发运件的每个 config 都是它能加载的前提，我不去"精简"它。
  const shipped = extractShippedPresetStandard()
  if (shipped) {
    log('✓ 已从发运件抠到 preset-standard 整节（照抄 + 只替换 persona）')
    let section = adaptStandard(shipped, personaBlockFinal)
    if (WITH_SKILLS && existsSync(SKILLS_DIR)) {
      // 在 skill-filesystem 条目下补 customSkillDirs（额外加分项，不覆盖已有 config）
      const ls = section.split('\n')
      const i = ls.findIndex(l => /- id: skill-filesystem\s*$/.test(l))
      if (i >= 0) {
        const ind = ls[i].length - ls[i].trimStart().length
        const pad = ' '.repeat(ind)
        const dirs = `${pad}  config:\n${pad}    customSkillDirs:\n${pad}      - '${SKILLS_DIR.replace(/\\/g, '/')}'`
        ls.splice(i + 2, 0, dirs)   // i+1 是 name: 行
        section = ls.join('\n')
      }
    }
    return section
  }
  log('⚠️ 抠发运件失败 → 退回手工拼装（更容易 broken，请留意设置页的失败原因）')

  const planEntry = extractShippedPlanMode()
  const planBlock = planEntry
    ? ['          - id: planning',
       '            name: cordis:group',
       '            group: true',
       '            isolate:',
       '              planMode: true',
       '            config:',
       planEntry,
       ''].join('\n')
    : ''

  const skillsBlock = (WITH_SKILLS && existsSync(SKILLS_DIR))
    ? ['            config:',
       '              customSkillDirs:',
       `                - '${SKILLS_DIR.replace(/\\/g, '/')}'`].join('\n')
    : null

  const L = []
  L.push('# =============================================================================')
  L.push(`#  「无人值守」preset（由 安装preset.mjs 生成于 ${stamp}）`)
  L.push('#')
  L.push('#  纪律：')
  L.push('#    · **不改 default / selectedDefault** —— 新模式只是 chip 里多一个可选项。')
  L.push('#    · 只追加这一节 → 回滚 = 删掉这一节，或跑 安装preset.mjs --rollback。')
  L.push('#    · preset 只对**空白会话**生效；**激活失败（broken）的 preset 会被 chip 过滤掉**，')
  L.push('#      只能在「设置 → Agent Preset」里看到并带失败原因。')
  L.push('# =============================================================================')
  L.push('- insert:')
  L.push('    - id: preset-unattended')
  L.push("      name: '@deepseek-ai/dsh-agent-preset'")
  L.push('      config:')
  L.push('        id: unattended')
  L.push('        name: 无人值守')
  L.push('        order: 5')
  L.push('        plugins:')
  L.push('          - id: persona')
  L.push("            name: '@deepseek-ai/dsh-persona'")
  L.push('            config:')
  L.push(`              prefix: ${personaBlockFinal}`)
  // ⚠️ 2026-10-18 修复：同上——**不写 suffix**（`{{cwd}}` 已不被宿主注册，会炸在提示词组装阶段）
  L.push('          - id: agent-instructions')
  L.push("            name: '@deepseek-ai/dsh-agent-instructions'")
  L.push('            config:')
  L.push('              maxBytes: 65536')
  if (planBlock) L.push(planBlock.replace(/\n$/, ''))
  L.push('          - id: tool-bash')
  L.push("            name: '@deepseek-ai/dsh-tool-bash'")
  L.push("            disabled: !!js process.platform === 'win32'")
  L.push('          - id: tool-pwsh')
  L.push("            name: '@deepseek-ai/dsh-tool-pwsh'")
  L.push("            disabled: !!js process.platform !== 'win32'")
  L.push('          - id: tool-fs')
  L.push("            name: '@deepseek-ai/dsh-tool-fs'")
  L.push('          - id: tool-fs-search')
  L.push("            name: '@deepseek-ai/dsh-tool-fs-search'")
  // ⚠️ 必填（实测踩过，用户截图给出原文）：
  //    `$.sampleOverCapGlobResults missing required value` → broken → 被 chip 过滤。
  L.push('            config:')
  L.push('              sampleOverCapGlobResults: false')
  L.push('          - id: tool-jobs')
  L.push("            name: '@deepseek-ai/dsh-tool-jobs'")
  L.push('          - id: skill-filesystem')
  L.push("            name: '@deepseek-ai/dsh-skill-filesystem'")
  if (skillsBlock) L.push(skillsBlock)
  L.push('          - id: tool-skill')
  L.push("            name: '@deepseek-ai/dsh-tool-skill'")
  L.push('          - id: present')
  L.push("            name: '@deepseek-ai/dsh-tool-present'")
  L.push('          - id: command-goal')
  L.push("            name: '@deepseek-ai/dsh-command-goal'")
  L.push('          - id: tool-goal')
  L.push("            name: '@deepseek-ai/dsh-tool-goal'")
  L.push('          - id: tool-todo')
  L.push("            name: '@deepseek-ai/dsh-tool-todo'")
  // ⚠️ 必填（实测踩过，用户截图给出原文）：
  //    `$.allowParallelInProgress missing required value` → broken → 被 chip 过滤。
  L.push('            config:')
  L.push('              allowParallelInProgress: true')
  L.push('          - id: compaction')
  L.push('            name: cordis:group')
  L.push('            group: true')
  L.push('            isolate:')
  L.push('              compaction: true')
  L.push('              toolResultPruner: true')
  L.push('            config:')
  L.push('              - id: compaction-basic')
  L.push("                name: '@deepseek-ai/dsh-compaction-basic'")
  L.push('              - id: command-compact')
  L.push("                name: '@deepseek-ai/dsh-command-compact'")
  L.push('              - id: tool-result-pruner')
  L.push("                name: '@deepseek-ai/dsh-compaction-tool-result-pruner'")
  L.push('          - id: delegation')
  L.push('            name: cordis:group')
  L.push('            group: true')
  L.push('            isolate:')
  L.push('              workflowEngine: true')
  L.push('            config:')
  L.push('              - id: tool-subagent-control')
  L.push("                name: '@deepseek-ai/dsh-tool-subagent-control'")
  L.push('              - id: tool-subagent-list-agents')
  L.push("                name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'")
  L.push('              - id: tool-subagent')
  L.push("                name: '@deepseek-ai/dsh-tool-subagent'")
  L.push('                config:')
  L.push('                  provider: spawn')
  L.push('                  toolName: subagent')
  L.push('                  backgroundMode: continuable')
  L.push('              - id: tool-subagent-fork')
  L.push("                name: '@deepseek-ai/dsh-tool-subagent'")
  L.push('                config:')
  L.push('                  provider: fork')
  L.push('                  toolName: subagent_fork')
  L.push('                  backgroundMode: continuable')
  L.push('              - id: workflow-ptc')
  L.push("                name: '@deepseek-ai/dsh-workflow-ptc'")
  L.push('                config:')
  L.push('                  provider: spawn')
  L.push('              - id: tool-workflow')
  L.push("                name: '@deepseek-ai/dsh-tool-workflow'")
  L.push('          - id: tool-ask-user')
  L.push("            name: '@deepseek-ai/dsh-tool-ask-user'")
  L.push('          - id: tool-web')
  L.push("            name: '@deepseek-ai/dsh-tool-web'")
  L.push('            config:')
  L.push('              fetch: true')
  L.push('')
  return L.join('\n')
}

// ------------------------------------------------------------------ 预检

function precheck (patchPath) {
  const r = spawnSync(ELECTRON, ['--expose-internals', CLI_JS, '--profile', 'web', '--dump-config', '--patch', patchPath],
    { encoding: 'utf8', maxBuffer: 64 << 20, timeout: 180_000, windowsHide: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  const out = r.stdout ?? ''
  const errs = (r.stderr ?? '').split(/\r?\n/).map(s => s.trim())
    .filter(s => s && !/^dsh\.cmd :|CategoryInfo|FullyQualified|^\+|^所在位置|^Node\.js v/.test(s))
  mkdirSync(BACKUP_ROOT, { recursive: true })
  const dump = join(BACKUP_ROOT, `dump-preset-precheck-${stamp}.yml`)
  writeFileSync(dump, out, 'utf8')
  // ⚠️ 判据要认**两种**写法：
  //    外层 Loader 条目 id 保持 `preset-*` 的形状就够了（`- id: preset-…`），
  //    真正的 preset 身份是里层的 `id: unattended`。
  //    实测踩过：只匹配 `preset-unattended` 会把"照抄发运件、外层 id 仍是 preset-standard"
  //    误判成"没装进去"→ 白回滚了一次。**宁可认宽一点，也不要误判。**
  const hasPreset = /id:\s*preset-[\w-]+/.test(out) && /id:\s*unattended\b/.test(out)
  return { exit: r.status, lines: out.split(/\r?\n/).length, errors: errs, dump, hasPreset }
}

// ------------------------------------------------------------------ 备份 / 回滚

function backupProfile (tag) {
  const paths = [join(BACKUP_ROOT, `desktop-before-preset-${tag}`), join(homedir(), '.dsh', '_backups', `desktop-before-preset-${tag}`)]
  for (const t of paths) {
    mkdirSync(t, { recursive: true })
    for (const f of readdirSync(PROFILE_DIR)) {
      const s = join(PROFILE_DIR, f)
      if (statSync(s).isFile()) copyFileSync(s, join(t, f))
    }
  }
  return paths
}

/**
 * 从一份 patch 文本里抠出 `- insert:` 块（返回 [{anchor, block}]，block 含该 insert 的全部行）。
 * 用于回滚时的**保守合并**。 */
function extractInsertBlocks (text) {
  const lines = text.split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    if (!/^-\s*insert:\s*$/.test(lines[i])) continue
    let j = i + 1
    while (j < lines.length && /^\s+\S/.test(lines[j])) j++
    const block = lines.slice(i, j).join('\n')
    const idm = block.match(/^\s*-\s*id:\s*(\S+)/m)
    out.push({ anchor: idm ? idm[1] : `(无id@${i + 1})`, block })
  }
  return out
}

function rollback () {
  // ★ b195 修：备份**写在两个根**（`backupProfile()` 同时写 `_unattended\backup` 与 `~\.dsh\_backups`），
  //   而这里原来**只读一个根** ⇒ 备份明明存在却报"没有可用备份"（实测踩到，当时只能绕过脚本手工改）。
  //   现在两根都扫、按名字取最新。
  const roots = [BACKUP_ROOT, join(homedir(), '.dsh', '_backups')].filter(r => existsSync(r))
  if (!roots.length) { console.error('[preset] 没有备份目录（找过：' + [BACKUP_ROOT, join(homedir(), '.dsh', '_backups')].join(' / ') + '）'); process.exit(1) }
  const cands = []
  for (const r of roots) for (const n of readdirSync(r)) if (n.startsWith('desktop-before-preset-')) cands.push({ root: r, name: n })
  cands.sort((a, b) => (a.name < b.name ? 1 : -1))          // 名字里带时间戳 ⇒ 倒序即最新在前
  if (!cands.length) { console.error('[preset] 没有可用备份（找过：' + roots.join(' / ') + '）'); process.exit(1) }
  const src = join(cands[0].root, cands[0].name)
  console.log(`[preset] 用备份：${src}（共找到 ${cands.length} 份，跨 ${roots.length} 个根）`)
  // ★ b195 加一道安全阀：备份可能很旧（实测最新一份是 18 天前的）—— 回滚会把 profile **整段退回**，
  //   这期间的改动全丢。旧了就先把话说死，别让"随手回滚"变成一个静默事故。
  const ageDays = (Date.now() - statSync(src).mtimeMs) / 86400_000
  if (ageDays > 7) {
    console.log(`[preset] ⚠️⚠️ 这份备份已 **${ageDays.toFixed(0)} 天** —— 回滚会把 profile 退回那时，**这期间的改动全丢**。`)
    console.log('[preset]     真要回滚：先确认这段时间的 profile 改动都不需要（或先手工备份当前 profile 到别处）。')
  }
  const pre = join(BACKUP_ROOT, `pre-rollback-${stamp}`)
  mkdirSync(pre, { recursive: true })
  for (const f of readdirSync(PROFILE_DIR)) if (statSync(join(PROFILE_DIR, f)).isFile()) copyFileSync(join(PROFILE_DIR, f), join(pre, f))

  // ⚠️ 坑（2026-10-01 真踩过）：这里原来是**整文件覆盖**，用一个可能很旧的备份回滚，
  //    结果把**后来新增的别的节**一起抹掉了 —— 实测把我加的另一节 `board-sidebar` 删了，
  //    还连带把 package.json 的依赖也清了。回滚只想撤掉 preset，不该动别人的东西。
  //    所以现在对 cordis.patch.yml 做**保守合并**：先照备份还原，再把
  //    「当前有、备份没有」的其它 insert 块补回去（只补 insert，不动别的）。
  let restored = 0, kept = 0
  for (const f of readdirSync(src)) {
    if (!statSync(join(src, f)).isFile()) continue
    const target = join(PROFILE_DIR, f)
    if (f === 'cordis.patch.yml' && existsSync(target)) {
      const before = readFileSync(target, 'utf8')
      const after = readFileSync(join(src, f), 'utf8')
      const have = new Set(extractInsertBlocks(after).map(b => b.anchor))
      const extra = extractInsertBlocks(before).filter(b => !have.has(b.anchor))
      if (extra.length) {
        const merged = after.replace(/\s+$/, '') + '\n\n' + extra.map(b => b.block).join('\n\n') + '\n'
        writeFileSync(target, merged, 'utf8')
        log(`已回滚 cordis.patch.yml，并保留 ${extra.length} 个备份里没有的 insert 节：${extra.map(b => b.anchor).join(', ')}`)
        kept += extra.length
      } else {
        copyFileSync(join(src, f), target)
      }
    } else {
      copyFileSync(join(src, f), target)
    }
    restored++
  }
  log(`已回滚 ${restored} 个文件 ← ${bks[0]}`)
  if (kept) log(`（保守合并：保留了 ${kept} 个不属于本 preset 的新增节）`)
  log(`回滚前状态另存：${pre}`)
  log('⚠️ 需重启桌面端才生效')
}

// ------------------------------------------------------------------ 主流程

if (ROLLBACK) { rollback(); process.exit(0) }

log(`preset 里的路径按本目录算：${HERE}`)
log(`persona 来源：${existsSync(ROLES_FILE) ? ROLES_FILE : '（缺 roles\\brain.md → 退化默认）'}`)
log(`skills：${WITH_SKILLS && existsSync(SKILLS_DIR) ? SKILLS_DIR : '（不写 customSkillDirs）'}`)
const section = buildSection()
if (!/section: \|/.test(section) && /planning/.test(section)) log('  ⚠️ plan-mode 节里没看到 section，可能有问题')
if (/id: planning/.test(section)) log('✓ 已从发运件抠到 plan-mode 节（含必填 section 正文）')
else log('⚠️ 本次不含 plan-mode 组')

if (!existsSync(PATCH_FILE)) { console.error(`[preset] 找不到：${PATCH_FILE}`); process.exit(1) }
const before = readFileSync(PATCH_FILE, 'utf8')
if (before.includes('preset-unattended')) { console.error('[preset] profile 里已有 preset-unattended（先 --rollback）'); process.exit(1) }
const after = before.replace(/\s*$/, '\n') + section
log(`将追加 ${section.split('\n').length} 行 → ${PATCH_FILE}`)

if (!APPLY) {
  log('**演练**：未写任何文件（加 --apply 真装）')
  process.exit(0)
}

const [bk, bkOut] = backupProfile(stamp)
log(`① 已备份 → ${bk}`)
log(`          → ${bkOut}（工作区外镜像）`)
writeFileSync(PATCH_FILE, after, 'utf8')
log(`② 已追加（${Buffer.byteLength(before)} → ${Buffer.byteLength(after)} 字节）`)
const pc = precheck(PATCH_FILE)
log(`③ 预检：exit=${pc.exit}　${pc.lines} 行　preset 条目=${pc.hasPreset ? '有' : '没有！'}`)
for (const e of pc.errors.slice(0, 3)) log(`   stderr: ${e.slice(0, 300)}`)
if (pc.exit !== 0 || !pc.hasPreset) {
  log('❌ 预检不通过 → 自动回滚')
  rollback()
  process.exit(1)
}
mkdirSync(LOG_DIR, { recursive: true })
writeFileSync(join(LOG_DIR, `preset-install-${stamp}.json`), JSON.stringify({
  stamp, patchFile: PATCH_FILE, backup: bk, backupOutside: bkOut, bytes: Buffer.byteLength(after),
  precheck: { exit: pc.exit, lines: pc.lines, dump: pc.dump },
  hasPlanMode: /id: planning/.test(section), hasSkills: Boolean(WITH_SKILLS && existsSync(SKILLS_DIR))
}, null, 2), 'utf8')
log('')
log('✅ 装好了。**还差一步**：重启桌面端 → 新开**空白会话** → chip 里选「无人值守」。')
log('   没有的话去「设置 → Agent Preset」看它是不是 broken（那里会写失败原因）。')
log('   出事：node 安装preset.mjs --rollback')
