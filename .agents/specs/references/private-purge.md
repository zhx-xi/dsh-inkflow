# 私有状态回收区（`.inkflow/purged/`，#199）

> 依据：[ADR-0026](../../adrs/0026-private-purge-area.md)。本文件是 [S-03 conventions.md](../conventions.md) §3.11 的细分契约（该节只定「住在哪、谁不许碰」）。

## 1. 为什么不是回收站

`trash/`（#35）**拒绝**`.inkflow/` 源：`trashFile` 对私有状态返回 `TRASH_SOURCE_NOT_ALLOWED`。那不是疏漏，而是把「作者删掉的正文」与「插件写的记录」分成两类损失——前者要能把作者的文件放回原处，后者只是让面板再看见一条记录。放宽它会逼着同一套判定在两个方向上各说一次，因此私有状态有自己的回收区与自己的清单（ADR-0026 D6）。

## 2. 落点与形状

```
<book>/.inkflow/purged/
  index.json                                  # 清单：一次清理一行
  review/<chapterId>/<runId>.json             # 被清理的运行记录（单文件）
  proposals/<proposalId>/{meta.json,hunks/…}  # 被清理的提案（整目录）
```

副本保持它在 `.inkflow/` 下的**原相对路径**，因此「还原到哪」是清单里的一个事实，不是调用方的一个入参。

清单行（`schemaVersion: 1`）：

| 字段 | 说明 |
|---|---|
| `id` | uuid，面板与路由寻址用 |
| `kind` | `review-run` \| `proposal` |
| `target` | 读者本来怎么称呼它：`<chapterId>/<runId>` 或 `<proposalId>` |
| `label` | 一行人话（面板直接打印，不重新推导身份） |
| `deletedAt` | ISO 8601（UTC） |
| `bytes` | `files[].bytes` 之和 |
| `sha256` | 文件表摘要（`digestOfFiles`：按 `path\0sha256` 排序后 sha256） |
| `reason` | 本版只写 `author_cleanup` |
| `files[]` | 每个文件 `{path, bytes, sha256}`；`path` 是私有状态相对路径 |

清单读取与回收站共用 `src/host/private-manifest.ts`（`schemaVersion` 不符就拒、坏文件**不重建**、缺字段的一行拒整份、io 失败码透传）。一个**没有文件**的行视为不可还原，直接拒读——不列一条承诺不了的记录。

## 3. 可清理对象

| 对象 | 前置条件 | 拒绝码 |
|---|---|---|
| 单条审稿运行记录 | `.inkflow/review/<chapterId>/<runId>.json` 存在 | `PURGE_TARGET_NOT_FOUND` |
| 单张提案 | `meta.status` ∈ {`applied`, `rolled-back`} | `PURGE_OPEN_PROPOSAL`（`open` 永不进候选） |

两者都要 `confirm: true`（否则 `CONFIRM_REQUIRED`，零写入）。清理是**搬移**：源文件消失 → `purged/` 有副本 → 清单多一行 → `.inkflow/audit/purge-<stamp>.md` 留一条记录（删了什么 / 何时 / 逐文件字节 / 通道来源与 `sessionId`）。**内容目录零变化**是验收判据：清理前后 `chapters/**/*.md` 的指纹必须一致。

## 4. 还原

- 目标由 `restoreTargetOf` 从 `files[].path` 算出：先 `plainRelativePath`（拒 `..`、绝对路径、盘符、空段），再要求首段 ∈ `{review, proposals}`；清单读取时对每一行跑同一判定，手改清单也不能把还原变成任意写。
- 写入只经 `io.ts` 的 `writeTextAtomic`（`verbatim: true`，保留原行尾与 BOM），并在写后复核 `sha256` 与清单一致；不一致则删掉半写文件并以 `PURGE_RESTORE_MISMATCH` 拒绝。
- 目标已存在 → `PURGE_TARGET_EXISTS` 且零写入（作者现有文件优先，与回收站的 `RESTORE_TARGET_EXISTS` 同一纪律）。
- 还原成功后该行离开清单、`purged/` 里的副本删除、空目录清理。

## 5. 不在范围内

- 提取候选的 `purge` 改可还原（#199 P1）；
- 批量作业记录与 `series-*` / `audit-*` / `repair-*` 时间戳文件的保留策略（#199 P1）；
- 自动按条数/体积淘汰（ADR-0026 的备选表已否掉：运行记录是事实，静默丢证据不可接受）。
