/**
 * 窄版写保护（本项目自用）—— 替代 Pi 官方示例 `examples/extensions/protected-paths.ts`。
 *
 * 为什么要自写：官方版是**子串包含**判定（`path.includes('.env') || '.git/' || 'node_modules/'`），
 *   于是 `.env.example`、`src/config.env.ts` 这类**全都改不动** —— 而 `.env.example` 恰恰是项目里
 *   常见且该由班组维护的文件。无人值守下它只会表现成"任务没做成"，理由仅一句 `Path is protected`。
 *
 * 窄版的判定（**按路径段，不按子串**）：
 *   - 拦：**任一路径段**是 `.git` 或 `node_modules`（整段相等，不是包含）
 *   - 拦：**文件名恰好是** `.env`（exact，不看大小写）
 *   - 放行：`.env.example` / `.env.sample` / `.env.template`（明确的样例文件）
 *   - 其余一律放行
 *
 * 非交互（`-p` 无人值守）下行为与官方一致但更准：**直接 block，不卡住、不询问**（fail-closed）。
 */
export default function protectedPathsNarrow(pi) {
  const SEG_DENY = new Set(['.git', 'node_modules'])
  const FILE_DENY_EXACT = new Set(['.env'])
  const FILE_ALLOW = new Set(['.env.example', '.env.sample', '.env.template'])
  const norm = (p) => String(p ?? '').replace(/\\/g, '/').split('/').filter(Boolean)
  const decide = (rawPath) => {
    const segs = norm(rawPath)
    if (!segs.length) return null
    const base = segs[segs.length - 1].toLowerCase()
    if (FILE_ALLOW.has(base)) return null                       // 样例文件放行
    if (segs.slice(0, -1).some((s) => SEG_DENY.has(s.toLowerCase()))) return { block: true, reason: `路径段受保护（.git / node_modules）：${rawPath}` }
    if (FILE_DENY_EXACT.has(base)) return { block: true, reason: `受保护文件：${rawPath}（要维护样例请用 .env.example）` }
    return null
  }
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'write' && event.toolName !== 'edit') return undefined
    const raw = event.input?.path ?? event.input?.file_path ?? event.input?.filePath
    const verdict = decide(raw)
    if (verdict && ctx?.hasUI) ctx.ui.notify(verdict.reason, 'warning')
    return verdict ?? undefined
  })
}