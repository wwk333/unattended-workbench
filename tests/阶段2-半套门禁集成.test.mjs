/**
 * 阶段 2（补·集成）· 半套门禁"按碰了什么放行"（决定 C）—— 用**真 CLI** 跑一遍
 *
 * 单测（阶段2-半套门禁）只测了 `quickScopeVerdict()` 这个纯函数；
 * 这里补的是**接线**：交付门 CLI 真的会因为它而放行/拦截。
 *
 * 两个用例（同一个临时项目，只改指纹）：
 *   ① 半套门禁 + 只改文案/样式 ⇒ **不该**出现 `gate:scope`
 *   ② 半套门禁 + 改到 index.html ⇒ **必须**出现 `gate:scope`（要害文件）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { UNATTENDED } from './_服务夹具.mjs'
import { dump } from './_助手.mjs'

function mkProject ({ changed }) {
  const p = mkdtempSync(join(tmpdir(), 'crew-halfgate-'))
  mkdirSync(join(p, '_crew', 'gate'), { recursive: true })
  mkdirSync(join(p, '_crew', 'fingerprints'), { recursive: true })
  writeFileSync(join(p, '_crew', 'gate', 'gate-result.json'), JSON.stringify({
    schema: 1,
    kind: 'gate-result',
    at: new Date().toISOString(),
    source: '门禁.mjs',
    state: 'green',
    stale: false,
    ok: true,
    scope: 'build+unit',
    summaryText: '单测 过',
    steps: [{ name: 'unit', ok: true }],
    snapshot: { snapshotId: 'sha256:' + 'a'.repeat(64) }
  }, null, 2), 'utf8')
  writeFileSync(join(p, '_crew', 'fingerprints', 'T1.diff.json'), JSON.stringify({ changed, added: [], removed: [] }), 'utf8')
  return p
}

function runGate (project) {
  const r = spawnSync(process.execPath, [join(UNATTENDED, '交付门.mjs'), '--project', project, '--check'], {
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 << 20
  })
  return String(r.stdout ?? '') + String(r.stderr ?? '')
}

test('半套门禁 + 只改无害文件 ⇒ 不报 gate:scope（决定 C 生效）', () => {
  const p = mkProject({ changed: ['src/style.css', 'README.md'] })
  try {
    const out = runGate(p)
    assert.ok(!/gate:scope/.test(out), `不该报 gate:scope，实际输出：\n${out.slice(0, 600)}`)
    assert.ok(/review:missing|review:unknown|review:blocked/.test(out), '应当仍因"没有审核"而阻断（放行范围仅限门禁深度）')
    dump('half-gate-allow', out.split('\n').filter(l => l.includes('交付门')).slice(0, 2).join(' | '))
  } finally { rmSync(p, { recursive: true, force: true }) }
})

test('半套门禁 + 改到 index.html ⇒ 必须报 gate:scope', () => {
  const p = mkProject({ changed: ['src/style.css', 'index.html'] })
  try {
    const out = runGate(p)
    assert.ok(/gate:scope/.test(out), `改到要害文件必须拦，实际输出：\n${out.slice(0, 600)}`)
    assert.ok(/index\.html/.test(out), '阻断理由里要点名是哪个文件')
    dump('half-gate-block', out.split('\n').filter(l => l.includes('gate:scope')).slice(0, 1).join(' | '))
  } finally { rmSync(p, { recursive: true, force: true }) }
})
