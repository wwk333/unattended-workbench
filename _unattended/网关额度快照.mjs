#!/usr/bin/env node
/**
 * 网关额度快照 —— 火山 Coding Plan 的**官方口径**额度（不经 cost-meter、不需要 IAM AK/SK）。
 *
 * 为什么有这个脚本（2026-10-03 实测）：
 *   `cost-meter` 读火山套餐额度需要 IAM `AccessKeyID`/`SecretAccessKey`（一直卡在用户没给）；
 *   但**官方 `arkcli` 走 SSO 通道就能读**，而且注明"与火山方舟控制台 1:1"：
 *       arkcli usage plan --product coding-plan     → session / weekly / monthly 三个窗口的已用百分比 + 刷新时间
 *   ⇒ "看不见火山额度"这件事**根本不用等密钥**。本脚本把那三个数落成快照，供报告/对账引用。
 *
 * 用法：node 网关额度快照.mjs [--json]
 * 退出码：0 成功；3 没装 arkcli / 未登录（**明说读不到**，不编数）
 * ⚠️ 只读查询：不发业务请求、不改任何远端状态。
 * ⚠️ 归因前缀按 arkcli-shared 的协议带全（它要求每条子命令都带）。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '..', '_crew', '网关额度', 'volcengine-coding-plan.json')
const ARKCLI = process.env.ARKCLI ?? join(process.env.APPDATA ?? '', 'npm', 'arkcli.cmd')
const json = process.argv.includes('--json')

const env = {
  ...process.env,
  ARKCLI_NO_UPDATE_NOTIFIER: '1',   // 冻结版本：不检查更新、不打印提示、不调度 automatic apply
  ARKCLI_CALLER_TYPE: 'ai_agent',
  ARKCLI_CALLER_NAME: 'dsh',
  ARKCLI_SKILL_NAME: 'arkcli-usage'
}

let raw
try {
  // ⚠️ Node 24 **不能直接 spawn `.cmd`**（安全修复后一律 EINVAL）—— 实测踩到：
  //    `spawnSync('…\\arkcli.cmd', …)` → `EINVAL`。要么 `shell:true`，要么显式走 `cmd.exe /c`。
  //    这里选后者：参数都是简单词，拼串安全，且不引入 shell 解析。
  const isCmd = /\.(cmd|bat)$/i.test(ARKCLI)
  const exe = isCmd ? (process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe') : ARKCLI
  // ⚠️ 别把整条命令拼成一个字符串交给 `cmd /c`：Node 会给它套一层引号并转义内层引号 →
  //    cmd 看到的是 `"\"C:\…\arkcli.cmd\" usage plan …"` 一个词 → 报"不是内部或外部命令"（实测踩到）。
  //    正确做法是**逐参数分开传**（本机 npm 目录无空格，安全）。
  const argv = isCmd
    ? ['/d', '/s', '/c', ARKCLI, 'usage', 'plan', '--product', 'coding-plan']
    : ['usage', 'plan', '--product', 'coding-plan']
  raw = execFileSync(exe, argv, { encoding: 'utf8', env, maxBuffer: 8 << 20, windowsHide: true, timeout: 120000 })
} catch (e) {
  console.error(`读不到（**不编数**）：${String(e?.message ?? e).split('\n')[0]}`)
  console.error(`  提示：装 arkcli（npm i @volcengine/ark-cli -g）或先登录（arkcli auth login）`)
  process.exit(3)
}

let data
try { data = JSON.parse(raw) } catch { console.error('输出不是 JSON，读不到（不编数）'); process.exit(3) }

const item = (data.items ?? []).find(i => i.product === 'coding-plan')
if (!item?.subscribed) { console.error('这个身份下**没有** coding-plan 订阅（不编数）'); process.exit(3) }
const snap = {
  source: 'arkcli usage plan（官方口径，与火山方舟控制台 1:1）',
  authMethod: data.viewer?.auth_method ?? null,
  identity: data.viewer?.user_name ?? null,
  product: 'coding-plan',
  edition: item.edition,
  periods: (item.periods ?? []).map(p => ({ label: p.label, percent: Number(p.percent.toFixed(2)), resetAt: p.reset_at })),
  updatedAt: item.updated_at ?? null,
  fetchedAt: new Date().toISOString(),
  note: 'cost-meter 读火山套餐额度另需 IAM AK/SK；**本快照走官方 CLI 的 SSO 通道，不需要密钥**'
}
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, JSON.stringify(snap, null, 2), 'utf8')

if (json) process.stdout.write(JSON.stringify(snap, null, 2) + '\n')
else {
  const zh = { session: '本会话', weekly: '本周', monthly: '本月' }
  const line = snap.periods.map(p => `${zh[p.label] ?? p.label} ${p.percent}%（${String(p.resetAt).slice(5, 16).replace('T', ' ')} 刷新）`).join(' · ')
  console.log(`火山 coding plan（${snap.edition}）：${line}`)
  console.log(`  身份 ${snap.identity}（${snap.authMethod}）· 快照 → ${OUT}`)
}