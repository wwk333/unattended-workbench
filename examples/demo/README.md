# demo · 最小可跑项目（入口 E2E 的样板）

这个目录是**无人值守系统的开工样板**：一个带真实入口、真实产物、真实入口验收的最小项目。
它同时是 §二「通用入口验收协议」的可执行样例 —— 换项目只换适配器，内核不动。

## 它有什么

```text
examples/demo/
  gate.json                    入口配置（唯一）：unit 步骤 + kind:"e2e" 步骤 + snapshot 范围
  src/convert.mjs              真实入口：node src/convert.mjs in.txt out.txt（真的写产物）
  tests/unit.mjs               单测：6 条断言，零依赖
  tests/entry-acceptance.mjs   入口验收适配器：跑真实命令 → 逐条断言 → 写统一证据
  _crew/                       运行现场（不进仓库）：gate-result / entry-evidence / release-status
```

## 一条命令验证

```powershell
# ① 全量测试（含入口 E2E）—— 唯一执行者，零 token
node ..\..\_unattended\门禁.mjs --project <这个目录>

# ② 交付门（读上面的产物 + 审核报告机器块，判能不能放行）
node ..\..\_unattended\交付门.mjs --project <这个目录>

# ③ 用户验收（只有人能写 accepted）
node ..\..\_unattended\交付门.mjs --project <这个目录> --accept --by "用户"
```

期望：

| 命令 | 期望 |
|---|---|
| 门禁 | `✅ 全绿（单测 过）`，退出码 0，`gate-result.json` 里有 `snapshot.snapshotId` 与 `e2e.ok:true` |
| 交付门（无审核报告） | `⛔ 阻断`，`review:missing`，退出码 2 |
| 交付门（有审核 pass 机器块） | `🟡 可交付（等用户验收）`，退出码 0 |
| `--accept --by 用户` | `✅ 已验收`；之后改一字节再跑 ⇒ `⚠️ 已过期`，退出码 4 |

## 入口验收为什么这么写

`tests/entry-acceptance.mjs` 做三件事，一件都不能省：

1. **跑真实命令**（不是调内部函数）—— 证明接线通；
2. **逐条断言真实产物**（E1 退出码 / E2 内容 / E3 业务字段）—— 证明结果对；
3. **写统一证据**（`schema/kind/snapshotId/at/source/state/ok/checks/artifacts`）—— 证明内核能机器复核。

⚠️ 只写 `{"ok":true}` 的适配器会被门禁判红（"只写 ok:true 而没有真实产物，就是橡皮章"）。
这条负向路径是实测过的：把 `writeFileSync` 去掉后，门禁输出

```
❌ entry  entry: state="red" / ok 不为 true / checks[1]（E2）ok 不为 true /
          artifacts 为空：只写 ok:true 而没有真实产物，就是橡皮章
```

## 边界（不要冒充）

入口 E2E 只证明"真实入口能走通关键路径"。手感、音质、整局体验这类**仍由用户最终验收**，
机器不得冒充（§二「边界」）。

---

## ⚠️ 现在这份 demo 的交付门是 \locked\（这是**对的**，不是坏了）

2026-10-26 重跑了一次门禁，于是：

- 门禁 stamp 变成 \2026-10-26-01-59-10\；
- 而当时的审核报告绑的还是旧 stamp \2026-10-26-00-22-42\；
- 交付门判定：\eview:gate-stamp-mismatch\ ⇒ \locked\。

这正是 §一 要的效果：**重跑门禁就让旧审核失效**（否则"门禁红了但拿旧审核放行"会一直存在）。

### 想把它救回"可交付/已验收"？

需要**重新走一遍审核**（不能我自批 —— 文档明写"大脑不得自批放行"）：

1. 生成/更新审核报告（机器块里写 \decision: pass\ 并绑**当前** gateStamp 与 snapshotId）；
2. 再跑 \
ode _unattended\\交付门.mjs --project examples\\demo\ 看是否 \eady\；
3. 用户验收后：\
ode _unattended\\交付门.mjs --project examples\\demo --accept --by "用户"\。

或者只当它是**演练夹具**，不追求 green —— 它的作用就是演示"红的时候说得清为什么红"。
