/**
 * 阶段 2（补）· 半套门禁放行规则（2026-10-26 用户拍板 C）
 *
 * 背景：门禁对 L1/L2 自动 `--quick`（跳 12 条冒烟），交付门只认全量 ⇒ 小活永远卡 `gate:scope`。
 * 规则：不看级别，看**碰了什么** —— 只改文案/样式/注释放行；碰入口/依赖/启动器/门禁配置必须全量。
 * 纪律：**放行要有正面证据**，查不到改了什么就照旧拦（fail-closed）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { isHazardPath, changedFilesOf, quickScopeVerdict } from '../_unattended/_要害文件.mjs'
import { dump } from './_助手.mjs'

test('要害文件：入口 / 依赖 / 启动器 / 门禁配置 / 服务端', () => {
  for (const p of ['index.html', 'gate.json', 'package.json', 'pnpm-lock.yaml', '启动-背单词.vbs', 'server/api/x.ts', 'main.mjs']) {
    assert.equal(isHazardPath(p).hazard, true, `应判要害：${p}`)
  }
})

test('无害文件：文案 / 样式 / 文档 / 普通源码', () => {
  for (const p of ['src/style.css', 'README.md', 'docs/a.md', 'src/util/format.mjs', '词表说明.txt']) {
    assert.equal(isHazardPath(p).hazard, false, `不该判要害：${p}`)
  }
})

test('反斜杠路径也能认（Windows 写出来的）', () => {
  assert.equal(isHazardPath('server\\api\\x.ts').hazard, true)
  assert.equal(isHazardPath('src\\style.css').hazard, false)
})

test('查不到指纹差异 ⇒ 不放行（fail-closed，不是"默认安全"）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-scope-'))
  try {
    const v = quickScopeVerdict({ project: dir })
    assert.equal(v.allow, false)
    assert.match(v.reason, /查不到这轮改了什么/)
    dump('scope-nofp', v.reason)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('只有无害改动 ⇒ 放行；含一处要害 ⇒ 拦并点名', () => {
  const dir = mkdtempSync(join(tmpdir(), 'crew-scope2-'))
  try {
    const fp = join(dir, '_crew', 'fingerprints')
    mkdirSync(fp, { recursive: true })
    writeFileSync(join(fp, 'T1.diff.json'), JSON.stringify({ changed: ['src/style.css', 'README.md'], added: [], removed: [] }), 'utf8')
    const ok = quickScopeVerdict({ project: dir })
    assert.equal(ok.allow, true, ok.reason)
    assert.equal(ok.hazards.length, 0)

    writeFileSync(join(fp, 'T1.diff.json'), JSON.stringify({ changed: ['src/style.css', 'index.html'], added: [], removed: [] }), 'utf8')
    const bad = quickScopeVerdict({ project: dir })
    assert.equal(bad.allow, false)
    assert.match(bad.reason, /index\.html/)
    assert.equal(bad.hazards.length, 1)
    dump('scope-hazard', bad.reason)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
