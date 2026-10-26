/**
 * 阶段 10 · 开源导出（W1：白名单导出要证明"没多带"**也**证明"没少带"）
 *
 * 为什么单开一个文件：`export-open.mjs` 以前只查"有没有多带"，所以它报 ✅ 而包里
 * 缺 26 个功能件、还漏了 35 个历史文件（2026-10-27 实测）。这些回归必须钉住，
 * 否则下一次"顺手删一条 DENY / 少写一个扩展名"没人会发现。
 *
 * 钉住的六件事：
 *   1. 功能件的扩展名（yml/ts/cmd/ps1/cjs/ico/py）**必须进包** —— 以前全丢
 *   2. `面板\会话\` **必须进包** —— 以前被 `会话/` 这条任意层级 DENY 误杀
 *   3. `history-from-E` / `_crew` / 手工备份 **必须不进包**
 *   4. REQUIRED 里的每个文件都得被 ALLOW 收下（"清单说要有" ≠ "真会导"）
 *   5. 敏感扫描：假 key 必须抓、`${CRED:X}` 占位符不许误报
 *   6. 判断"少没少带"只看程序层集合，不猜引用（猜引用会报一堆假警，最后被人关掉）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ALLOW, DENY, REQUIRED, SECRET_PATTERNS, PATH_PATTERNS,
  allowed, doctor, findGaps, layerFiles, extensionCoverage, scanContent, stripComments, WORKBENCH
} from '../scripts/export-open.mjs'

const tmp = () => mkdtempSync(join(tmpdir(), 'exp-'))
const put = (dir, rel, text) => {
  const p = join(dir, ...rel.split('/'))
  mkdirSync(join(p, '..'), { recursive: true })
  writeFileSync(p, text, 'utf8')
  return p
}
// `doctor()` 要对 200+ 个脚本跑 `node --check`（约 9 秒）。这里只算一次，别让两个用例各跑一遍。
let _doc = null
const DOC = () => (_doc ??= doctor(WORKBENCH))

// ---------------------------------------------------------------- 允许 / 拒绝

test('功能件的扩展名必须进包（以前只认六种，实测丢 17 个）', () => {
  const must = [
    '_unattended/bridge-plugin/cordis.patch.yml',
    '_unattended/preset-无人值守.draft.yml',
    '_unattended/pi-ext/protected-paths-narrow.ts',
    '_unattended/playtest/playtest.py',
    '_unattended/面板/board.ico',
    '_unattended/会话体检.cjs',
    '_unattended/swap-watch.cmd',
    '_unattended/_rollback.ps1'
  ]
  for (const p of must) assert.equal(allowed(p), true, `${p} 必须进包`)
})

test('面板的会话模块必须进包（`会话/` 那条 DENY 曾经把它整段杀掉）', () => {
  for (const p of [
    '_unattended/面板/会话/brain.mjs',
    '_unattended/面板/会话/session.mjs',
    '_unattended/面板/会话/_工具.mjs',
    '_unattended/面板/会话/carriers/pi.mjs'
  ]) assert.equal(allowed(p), true, `${p} 必须进包`)
})

test('该挡死的一条都不许松', () => {
  const mustNot = [
    '_unattended/secrets/swap-token.txt',
    '_unattended/secrets/dashscope-key.txt',
    '_unattended/history-from-E/进度.md',
    '_unattended/history-from-E/_crew-snapshot/ledger.json',
    '_unattended/backup/编排.mjs.old',
    '_unattended/logs/x.log',
    '_crew/agents.json',
    '_crew/gate/gate-result.json',
    'examples/demo/_crew/gate/gate-result.json',
    '_unattended/编排.mjs.bak-清账-20261025-191430',
    '_unattended/_agents-config.mjs.bak-xiaomikey-1791312644243',
    '_unattended/__pycache__/x.pyc',
    'swap-token.txt',
    '.env'
  ]
  for (const p of mustNot) assert.equal(allowed(p), false, `${p} 绝不该进包`)
})

test('REQUIRED 里的每一项都得被 ALLOW 收下（否则"清单有"也导不出来）', () => {
  assert.ok(REQUIRED.length >= 10)
  for (const p of REQUIRED) assert.equal(allowed(p), true, `REQUIRED 里的 ${p} 不在 ALLOW 里`)
})

// ---------------------------------------------------------------- 少没少带

test('"少没少带"只看程序层集合：backup/logs/secrets/__pycache__ 不算程序层', () => {
  const files = layerFiles(WORKBENCH)
  assert.ok(files.length > 100, `程序层文件太少：${files.length}`)
  for (const bad of ['/backup/', '/logs/', '/secrets/', '/__pycache__/', '/history-from-E/']) {
    assert.ok(!files.some(f => f.includes(bad)), `layerFiles 不该包含 ${bad}`)
  }
  assert.ok(!files.some(f => /\.bak[-.]/i.test(f)), 'layerFiles 不该包含手工备份')
})

test('真工作台的缺件里不许有"程序层少带"（有就是 ALLOW 又漏了）', () => {
  const gaps = findGaps(WORKBENCH)
  const missingLayer = gaps.filter(g => g.kind === '程序层少带')
  assert.deepEqual(missingLayer.slice(0, 8), [], `程序层少带：${missingLayer.map(g => g.file).join(', ')}`)
})

test('扩展名覆盖：真工作台不该有"漏配"（新增扩展名时必须同步 ALLOW）', () => {
  const cov = extensionCoverage(WORKBENCH)
  assert.deepEqual(cov, [], `疑似漏配：${cov.map(c => `${c.ext}×${c.count}`).join(', ')}`)
})

test('剥注释：注释里写 import 不算引用', () => {
  const t = stripComments("import x from './_助手.mjs'\n// import y from './nope.mjs'\n/* import z from './nope2.mjs' */\n")
  assert.match(t, /_助手\.mjs/)
  assert.doesNotMatch(t, /nope\.mjs/)
  assert.doesNotMatch(t, /nope2\.mjs/)
  // `http://` 不许被当成行注释
  assert.match(stripComments("const u = 'http://127.0.0.1:1/x'"), /http:\/\/127/)
})

// ---------------------------------------------------------------- 泄露扫描

// ⚠️ 下面这些"假密钥"**必须拆开拼**：整串写在这个文件里，体检器会扫到它自己，
//    于是真工作台一跑就红（我第一次就踩了）。这不是洁癖 —— 这是"体检器不能把自己搞红"。
const J = (...a) => a.join('')

test('真密钥形状必须被抓到', () => {
  const dir = tmp()
  try {
    put(dir, 'a.mjs', [
      `const a = '${J('sk-', 'abcdefghijklmnopqrstuvwxyz0123')}'`,
      `const b = '${J('ghp_', 'abcdefghijklmnopqrstuvwxyz')}'`,
      `const c = '${J('AKIA', 'IOSFODNN7EXAMPLE')}'`,
      `const d = '${J('-----BEGIN ', 'RSA PRIVATE KEY-----')}'`,
      `const e = '${J('Authorization: Bearer ', 'abcdefghijklmnopqrstuvwxyz012345')}'`
    ].join('\n'))
    const r = scanContent(dir, ['a.mjs'])
    const kinds = new Set(r.secrets.map(s => s.kind))
    assert.ok(kinds.size >= 4, `只抓到 ${[...kinds].join(',')}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('占位符不算密钥（${CRED:X} / <YOUR_KEY> / xxx）', () => {
  const dir = tmp()
  try {
    put(dir, 'b.json', JSON.stringify({ apiKey: '${CRED:ARK_API_KEY}', other: '<YOUR_KEY_HERE>' }))
    const r = scanContent(dir, ['b.json'])
    assert.deepEqual(r.secrets, [], JSON.stringify(r.secrets))
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('本机痕迹（用户名 / 盘符）要被单独报出来', () => {
  const dir = tmp()
  try {
    put(dir, 'c.md', `路径是 ${J('C:', '\\Users\\zhangsan\\Desktop')}`)
    const r = scanContent(dir, ['c.md'])
    assert.ok(r.paths.some(p => p.kind === 'Windows 用户名路径'), JSON.stringify(r.paths))
    assert.equal(r.secrets.length, 0, '本机痕迹不是密钥，不许混为一谈')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('真工作台当前零密钥（有命中就是真出事，不许放行）', () => {
  const d = DOC()
  assert.deepEqual(d.secrets, [], JSON.stringify(d.secrets.slice(0, 5)))
})

// ---------------------------------------------------------------- 三档结论

test('体检结论是三档、字段齐全，且 ok 仍然只表示"能不能安全导出"', () => {
  const d = DOC()
  assert.ok(['green', 'yellow', 'red'].includes(d.state), d.state)
  for (const k of ['files', 'mjs', 'syntaxErrors', 'secrets', 'gaps', 'warns', 'pathHits']) {
    assert.equal(typeof d.counts[k], 'number', `counts.${k} 必须是数字`)
  }
  // 兼容老字段：阶段 8 与 e2e-演练 在读它
  assert.deepEqual(d.denied, [])
  assert.equal(d.counts.denied, 0)
  assert.equal(d.ok, d.counts.syntaxErrors === 0 && d.counts.secrets === 0)
  assert.ok(Array.isArray(d.gaps) && Array.isArray(d.warns) && Array.isArray(d.pathHits))
})

test('模式表本身没写坏（每条都是 [名字, 正则]）', () => {
  for (const [name, re] of [...SECRET_PATTERNS, ...PATH_PATTERNS]) {
    assert.equal(typeof name, 'string')
    assert.ok(name.length > 0)
    assert.ok(re instanceof RegExp, `${name} 不是正则`)
  }
  assert.ok(ALLOW.length >= 20 && DENY.length >= 10)
})

// ---------------------------------------------------------------- A14 空坑库

test('空坑库：查坑必须 exit 0 并教"怎么记第一条"（不许第一跳就红）', () => {
  const dir = tmp()
  try {
    const r = spawnSync(process.execPath, [join(WORKBENCH, '_unattended', '查坑.mjs'), '随便查'], {
      encoding: 'utf8', windowsHide: true, timeout: 60_000,
      env: { ...process.env, DSH_PITFALL_VAULT: join(dir, '不存在的库') }
    })
    assert.equal(r.status, 0, `空库不该报错：exit=${r.status} stderr=${String(r.stderr).slice(0, 200)}`)
    assert.match(String(r.stdout), /怎么记第一条/)
    assert.match(String(r.stdout), /四段式|现象/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('空坑库 --topics 也不许炸', () => {
  const dir = tmp()
  try {
    const r = spawnSync(process.execPath, [join(WORKBENCH, '_unattended', '查坑.mjs'), '--topics'], {
      encoding: 'utf8', windowsHide: true, timeout: 60_000,
      env: { ...process.env, DSH_PITFALL_VAULT: join(dir, '不存在的库') }
    })
    assert.equal(r.status, 0, `exit=${r.status} stderr=${String(r.stderr).slice(0, 200)}`)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
