<!--
四栏都要填。第 3 栏是硬门禁：没写「参考了谁、借了什么、改了什么」的 PR 视为未完成评审
（.agents/constitution/engineering-discipline.md §8）。参考索引见 issue #60。
证据只写实际跑过的结果；未跑过的检查不要写成通过。
-->

## 变更

- **改了什么**：
- **为什么**（issue / 缺陷 / 决策依据）：
- **用户可见变化**（没有就写「无」）：
- **明确不在本 PR 内**（顺手发现但没做的事）：

## 验证证据

本地（Windows 用 `pnpm.cmd`，Node ≥ 22.12；测试打的是构建产物，改动后先 `pnpm.cmd run build`）：

```text
pnpm.cmd run check
# = typecheck + lint + build + test + check:links + check:docs + check:guards + check:package
```

| 检查项 | 本次实际结果（写数字与摘要，不要只写「通过」） |
|---|---|
| `pnpm.cmd run check` | 例：typecheck 0 error；lint 0 error；build 成功；tests 128 pass / 0 fail；links / docs / guards / package 全绿 |
| 手工验证（涉及面板、门禁或文件 IO 时必填） | 例：重启 DSH 后在会话中调用 `inkflow_chapter_list`，返回 3 卷 12 章；非法目录返回 `NOT_AN_INKFLOW_PROJECT` 并列出缺失项 |
| CI run | <粘贴 run 链接>：lint / test (windows) / test (ubuntu) / docs / package 的结论 |

- [ ] 上表是**本次改动之后**的真实输出（贴的是摘要，不是记忆中的上一次结果）
- 未运行的相关检查及原因：

## 外部参考与取舍

> 只学设计与交互，不搬代码；GPL 项目只读行为。索引见 issue #60（四个参考项目的模块 × 路径 × commit）。

| 参考项目（owner/name @ commit） | 具体文件路径 | 借了什么（设计 / 交互 / 边界处理） | 我们改了什么（为什么不照搬） |
|---|---|---|---|
|  |  |  |  |

- 无外部参考时写：**无**，并给一句理由（例如「纯内部重构，只对齐本仓库既有契约」）。
- 牵涉架构边界、数据格式或对外契约的改动，先落 ADR 再改实现（A1），并在上面写清被取代或被补充的 ADR 编号。

## 关联

- **Closes** #（只在本 PR 确实关闭它时写）
- **依赖**（必须先合入的 PR / issue）：
- **后续**（本 PR 不做、已另开 issue 跟踪的）：
