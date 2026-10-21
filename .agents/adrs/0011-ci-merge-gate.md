# ADR-0011：合并前 CI 门禁由分支保护强制，并由仓库内脚本可验证

**状态**：已采纳（2026-10-22）
**相关**：[ADR-0008](0008-panel-data-channel.md) 的通道纪律不涉及本节；本节约束**工程流程**。

## 背景

`.agents/constitution/engineering-discipline.md` §9 早已要求「CI 绿才能合」，`.github/workflows/ci.yml` 也早就跑 5 个 job。但 2026-10-21 实测分支保护配置时发现，这条纪律在机制上是空的：

| 项 | 当时的值 | 后果 |
|---|---|---|
| `enforce_admins.enabled` | `false` | **管理员可以绕过 required checks 直接合并**——`#7` 那类「本地 check 红着就合」的事故路径依旧存在 |
| `required_status_checks.strict` | `false` | 分支不必与 `main` 同步，旧基线上跑绿即可合；合进 `main` 的代码从未在任何一次 CI 里被验证过 |
| `required_conversation_resolution.enabled` | `false` | 评审意见没解决也能合 |
| required contexts | 值是对的 | 但只存在于网页设置里，仓库内**没有任何断言**：改一次设置页、或在新 owner 下重建仓库，门禁静默失效而所有文档仍在承诺它 |

## 决策

1. **分支保护配置是门禁，不是口令**：`main` 要求 `strict: true`、`enforce_admins: true`、禁 force push、禁删分支、`required_conversation_resolution: true`，并且 required contexts 覆盖 lint、两个平台的单测、docs、package。
2. **期望值只有一处**：`scripts/branch-protection-rules.mjs` 的 `EXPECTED` / `REQUIRED_CONTEXTS`；文档只指向它，不复制清单。
3. **可验证**：`scripts/branch-protection.mjs check` 只读拉取配置并逐项比对，接在 `pnpm run check` 末端（`--tolerant`：拿不到结论时打印 `SKIP …（未验证）` 并 exit 0；**读到了但不符仍 exit 1**）。`apply` 是唯一写入口，幂等、写后回读、并保留已开启的评审要求。
4. **触发面**：`pull_request`（面向 `main`）是合并前门禁；`push: main` 验证真正落地的 squash commit；`merge_group` 为 merge queue 预留（未启用时零成本）。
5. **唯一应急出口**：CI 自身坏在 `main` 上导致所有 check 永久 pending 时，可临时 `DELETE …/branches/main/protection`，修完立刻 `apply` + `check` 证明恢复，并在 issue 留痕。这是「不可绕过」与「永远卡死」之间的取舍，选前者。

## 备选与取舍

| 备选 | 为什么不选 |
|---|---|
| 只写纪律（原状） | 已经有反例：`#7` 在本地 check 红时被合并，才补出 `#58` 的 hotfix。纪律没有机制承载时，坏一次就重来一次 |
| 只设 `enforce_admins`，不设 `strict` | 省掉每次并行 PR 的 rebase 成本，但「旧基线跑绿」等于没验证；本项目 0.1.0 阶段并行 3–4 单，成本可控，宁可多 rebase |
| 在 CI 里跑一个只读 job 检查保护配置 | public 仓库的 `GITHUB_TOKEN` 没有 admin 读权限（private 仓库更拿不到），该 job 只能永远 skip。所以检测放在本地 `check` 链上 |
| 自建一个 pre-merge 机器人（`pull_request_review` + 服务端） | 需要常驻服务与 token，单人本地优先项目不划算；GitHub 原生能力已经够 |
| 用 GitHub Rulesets 替代 branch protection | 能力重叠，但 2026-10 实测 `rulesets` 为空、且 `branches/{branch}/protection` 是插件与文档已依赖的读取面；换实现要重写验证脚本与文档，收益不抵成本 |

## 后果

**正面**：门禁从「承诺」变成「配置 + 可执行断言」；配置漂移会在下一次 `pnpm run check` 里被点名（缺哪一项、为什么）。

**负面**：管理员的合并捷径没有了——CI 挂住时只能走应急出口；`strict` 让并行 PR 每次合并后都要 `update-branch --rebase` 并重跑 5 个 check（windows runner 偶发十余分钟）。

**风险**：
- **平台依赖**：分支保护需要 public 仓库或付费账户；转 private 会 403，`check` 只能 SKIP，漂移检测静默消失。转换前必须确认账号能力。
- **`apply` 是整对象 PUT**：`PUT /protection` 会替换整个配置，所以凡本门禁不拥有的字段都必须显式带过去（已实现：保留已开启的评审要求）。新增自定义设置时要同步这条纪律。
- **应急出口被滥用**：DELETE 保护后若不立刻 `apply`，门禁就是关的；因此要求当场留痕并回读证明。

## 验证

- `node scripts/branch-protection.mjs check` 在正确配置下 PASS；临时删掉一个 required context 后 FAIL 并点名（2026-10-22 现场做过，见 issue #93 评论）。
- `tests/branch-protection.test.js` 覆盖纯函数的每条反例；`tests/branch-protection-cli.test.js` 覆盖退出码（tolerant + 无 gh → 0；读到不符 → 1；`--dry-run` 不发请求）。
- `pnpm.cmd run check` 全绿，且末端的 `branch-protection` 一行给出 PASS 或 `SKIP …（未验证）`。
