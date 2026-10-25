# ADR-0026：私有状态的回收区 `<book>/.inkflow/purged/`（#199 手动清理与还原）与写白名单的第四次扩容

- 状态：已采纳（2026-10-25）
- 日期：2026-10-25

## 背景

0.5.0 人工验收时作者问：「审稿里面有些已经通过或拒绝的，后续是会一直留在里面吗？是不是应该自动去掉或者给个归档功能呢？」（#199 正文）

实测到的现状（样书 `D:\tmp\inkflow-probe\book`）：

| 面 | 落点 | 会不会一直留 | 现有出路 |
|---|---|---|---|
| 审稿运行记录（#46） | `.inkflow/review/<chapterId>/<runId>.json` | 会；面板只看得到最近 `REVIEW_LIST_LIMIT`=20 次 | 无删除、无归档；第 21 次之后既看不见也删不掉 |
| 提案（#45） | `.inkflow/proposals/<proposalId>/` | 会；`applied`/`rolled-back` 与 `open` 混在左栏 | 无删除、无归档 |
| 提取候选（#38） | `.inkflow/candidates/` | 会 | 有 `purge`，但**直删、不可还原** |

三条既有决定挡住了「顺手加个删除按钮」：

1. **回收站（#35）明确拒绝私有状态**：`trash.ts` 对 `.inkflow/` 源返回 `TRASH_SOURCE_NOT_ALLOWED`「the private state directory is not a delete target」。放宽它等于让「插件自己写的东西」与「作者删掉的正文」共用一个清单，而两者的还原语义不同：正文的还原是「把作者的文件放回去」，运行记录的还原是「让面板再看见一条记录」。
2. **运行记录是事实不是缓存**（ADR-0022 D4.5、`REVIEW_FILE_SCHEMA_VERSION` 注释）：自动删会毁掉横评与审计链，因此不能「超出 N 条就淘汰」。
3. **`index/` 不能放**（ADR-0012、ADR-0023）：那目录缺失会被静默重建，且 `index/` 的契约是「除 `.gitkeep` 与 `*.db` 外全是派生物」。

作者的裁决（#199 评论，2026-10-25）：实现方式 = **A**（不自动删；默认折叠 + 手动清理，清理进私有状态自己的回收区、**可还原**）；本期只做 P0（审稿运行记录 + 提案）；提案清理粒度 = 只清已结束，`open` 永不进候选。

## 决策

### D1 新子目录 `.inkflow/purged/`，`PRIVATE_STATE_SUBDIRS` 从七名扩到八名

```
<book>/.inkflow/
  purged/
    index.json                                  # 清单：一次清理一行
    review/<chapterId>/<runId>.json             # 被清理的运行记录，保持它在 .inkflow/ 下的原相对路径
    proposals/<proposalId>/{meta.json,hunks/…}  # 被清理的提案，整目录搬过来
```

判据与 ADR-0023 D1 完全一致（「重建不可再生」的进 `.inkflow/`），外加一条本次特有的：**回收区自己也是私有状态**，因此它的落点同样只能在 `.inkflow/` 内（X-25），写白名单随之从七条子路径扩到八条（`resolveWriteTarget`，`src/host/conventions.ts` 的 `PRIVATE_STATE_SUBDIRS`）。

副本**保持它在 `.inkflow/` 下的原相对路径**（`purged/review/<chapterId>/<runId>.json`）。这不是为了好看，而是为了让「还原到哪」成为清单里的一个事实而不是一个入参：还原目标由 `restoreTargetOf` 从该路径算出，并且只接受 `.inkflow/review/…` 与 `.inkflow/proposals/…`。

### D2 清单逻辑只有一份，与回收站共用（`private-manifest.ts`）

两个清单（`.inkflow/trash/index.json` 与 `.inkflow/purged/index.json`）的差别是「一行代表什么、还原要拒什么」；**相同**的部分恰恰是最容易悄悄坏掉、且两边各自测试都能过的那部分：`schemaVersion` 不符就拒、坏文件**不重建**（重建等于静默忘掉作者可能还要的条目）、缺字段的一行拒整份清单而不是半懂、io 失败码透传、拒绝消息里带文件名。

所以把这段抽成 `src/host/private-manifest.ts`，`trash.ts` 与 `private-purge.ts` 各自只提供 `parse` 与拒绝码（`TRASH_MANIFEST_INVALID` / `PURGE_MANIFEST_INVALID`）、`label`、`brokenHint`。副作用是 `trash.ts` 从 649 行降到 583 行，它那条 `OVER_CAP_BUDGET` 预算条目随之删除（守卫的第 10 条要求「回到 600 以内就必须删条目」）。

### D3 可清理对象 = 单条运行记录、单张**已结束**提案；`open` 永不进候选

- 审稿运行记录：`.inkflow/review/<chapterId>/<runId>.json`（单文件）。
- 提案：`.inkflow/proposals/<proposalId>/`（整目录），且 `meta.status` 必须是 `applied` 或 `rolled-back`；`open` 一律以 `PURGE_OPEN_PROPOSAL` 拒（用例挡住，见验证）。
- 本期**不含**（#199 P1，另开单）：提取候选 `purge` 改可还原、批量作业记录与 `series-*`/`audit-*`/`repair-*` 时间戳文件的保留策略。

### D4 清理要 `confirm: true`，并在 `.inkflow/audit/` 留一条删除记录

与 `trash/purge`、`candidates/purge` 同款二次确认。删除记录落 `.inkflow/audit/purge-<stamp>.md`（人类可读，与 `audit-*.md`/`repair-*.md` 同类），内容包括：删了什么（kind + target + 每个文件的相对路径）、何时（UTC）、多少字节（逐文件 + 合计）、**谁**（通道来源 + `sessionId`）。所以事后能回答「谁删的」，而不只是「删过」。

### D5 还原走 `writeTextAtomic`，还原目标只允许落在 `.inkflow/{review,proposals}` 之内

- 写入只能经 `io.ts`（data-safety §2 的单一写入口），`verbatim: true` 保留原有行尾/BOM。
- `restoreTargetOf(path)` 是唯一目标判定：先 `plainRelativePath`（拒 `..`、绝对路径、空段、盘符），再要求首段 ∈ `{review, proposals}`。清单读取时对每一行跑同一判定，因此手改 `index.json` 也不能把还原变成任意写。
- 还原**不覆盖**：目标位置已有文件 → `PURGE_TARGET_EXISTS` 且零写入（作者的现有文件优先，与 `trash.ts` 的 `RESTORE_TARGET_EXISTS` 同一纪律）。

### D6 `trash.ts` 对 `.inkflow/` 源的禁令保持不变

不放宽、不开分支。理由：回收站的清单行 `originalPath` 是**项目相对路径**且拒绝私有状态（`readEntry` 里 `isPrivateStatePath` 那条），这正是它把「作者的文件」与「插件的状态」分开的机制；为 #199 开一条 `.inkflow/` 分支会让这一条判定在两个方向上各说一次，而私有状态已经有自己的清单与自己的还原判定。

### D7 工具面：**不新增 `inkflow_*` 工具**，只做 `GET /purged` + 两个 POST + 面板

判断依据是既有形状而不是偏好：

- `trash`（#35）是「域模块 + 通道模块 + 三条路由」，**没有工具**——回收站是作者的维护动作，不是模型的创作动作；
- `inkflow_extract_purge`（#38）有工具，是因为候选队列本来就是模型在推、模型要自己收尾；
- #199 的清理对象是**作者要留哪些历史**，模型无从判断（删错一次就是证据链缺口），因此照 `trash` 的形状做：通道 + 路由 + 面板，工具面数量不变（仍 **70 = 51 内置 + 19 域**，`check-tool-names.mjs` 双向对拍维持原状）。

## 备选与取舍

| 方案 | 优点 | 代价 | 为什么没选 |
|---|---|---|---|
| 放宽 `trash.ts` 的 `.inkflow/` 禁令，复用回收站 | 零新目录、零新清单 | 回收站的清单行语义（项目相对路径、`originalPath` 即还原目标）与私有状态的还原目标（`.inkflow/{review,proposals}` 闭集）不同；一条判定要在两处各说一次，`readEntry` 里那条 `isPrivateStatePath` 拒绝就得开分支 | 作者裁决明确要求「私有状态有自己的回收区」，且混合会让「删正文」与「清记录」共享一份清单，还原语义随之含糊 |
| 学 `candidates/purge` 直删 | 最少代码 | **不可还原**：删错一条运行记录 = 一次审稿的证据消失（模型不可重放，X-26） | 与作者裁决 A「可还原」直接冲突 |
| 自动保留最近 N 条，超出即删 | 面板与磁盘都省心 | 静默丢证据；与「运行记录是事实」冲突；用户无法预期 | #199 的选项表已否掉（选项 B） |
| 只折叠/只筛选，不提供删除 | 最安全 | 磁盘无界增长，「归档」等于没给 | 选项 C，作者否决 |
| 落 `$DSH_HOME/inkflow/purged/<projectId>/` | 书目录保持纯净 | 不随书走（换机/clone 就找不回）；`inkflow.json.projectId` 仍是可选字段 | 与 ADR-0012 否掉 `$DSH_HOME` 的理由相同 |
| 新增第十一个内容目录 `purged/` | 编辑器里一眼看见 | 要改 `CONTENT_DIRS`、门禁、向导、`.gitkeep` 与 spec | 私有状态不是作品内容（ADR-0012） |
| 给清理动作加 `inkflow_*` 工具 | 模型也能收尾 | 模型无法判断「作者要留哪些历史」，误删即证据缺口 | 见 D7：照 `trash` 的通道形状 |

## 后果

| 收益 | 代价与对策 |
|---|---|
| 「清掉看着烦的」不再等于「永久失去」：清理是搬进 `purged/`，还原逐字节校验 | 多一个私有子目录 + 一份清单；写白名单第四次扩容，用 `tests/private-state.test.js`（精确八名）与 `tests/io-writer.test.js`（八条子路径可写）挡住漂移 |
| 面板首屏不再被历史淹没（审稿页折叠「更早的 N 次运行」、提案页只列 `open`），而历史仍可展开、可选中 | 折叠边界由 Host 的 `foldLimit` 单点给出（#199 的 `GET /review`），面板不复制那个数字 |
| 清单逻辑一份（`private-manifest.ts`），两处清单不会再各自漂 | `trash.ts` 需要一次纯搬移式重构；它降到 583 行，`OVER_CAP_BUDGET` 条目删除 |
| 事后能回答「谁删的」 | 每次清理多一个 Markdown 文件（`.inkflow/audit/purge-<stamp>.md`），与 `series-*`/`repair-*` 同类累计；保留策略仍在 #199 P1 |

## 验证

- `tests/private-state.test.js`：`PRIVATE_STATE_SUBDIRS` **精确等于八名**（含顺序），`privateStateDirRelative('purged')` / `privateStateRelative('purged', …)` 的拼装。
- `tests/io-writer.test.js`：「私有状态只在其八条子目录内可写」逐条可解析，且 `.inkflow/other/x.md`、`.inkflow/trash`（无文件名）、`..` 逃逸仍拒。
- `tests/trash.test.js`（重构后必须原样全绿）：删章 → 副本 + 清单行；还原字节一致；purge 要 `confirm`；`.inkflow/` 不进 `git status`。
- `tests/private-purge.test.js`（#199 新增，先 RED 后 GREEN）：
  - `open` 提案清理被拒（`PURGE_OPEN_PROPOSAL`）且零写入；
  - 已结束提案/单条运行清理后：源文件消失、`purged/` 有副本、`.inkflow/audit/` 有删除记录（含 sessionId 与字节数）；
  - 清理前后 `chapters/**/*.md` 的指纹完全一致（内容目录零变化）；
  - 还原逐字节一致（BOM/CRLF 保留）、目标已存在时零写入、越界 `path`（`..`、绝对路径、`.inkflow/jobs/…`）被拒。
