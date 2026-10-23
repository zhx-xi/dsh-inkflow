# 改名与影响面（conventions.md §5.6 的细则）

> **依据**：[ADR-0014](../../adrs/0014-entity-id-pinning.md)（改名＝id 钉住）、[roadmap](../roadmap.md) X-15。
> **状态**：活跃。本文件是 [conventions.md](../conventions.md) §5.6 的展开（该文件受 800 行上限约束，S6）。

改设定前先看影响面，改名**只写一次**（[ADR-0014](../../adrs/0014-entity-id-pinning.md)，roadmap X-15）：

| 项 | 契约 |
|---|---|
| 影响清单 | `GET /inkflow/internal/impact?kind=&id=`（`id` 省略时按 `title` 模糊匹配，多命中回候选）列五处：①提及它的章（`entity_mentions`，带章标题与出现次数）②以它为端点的关系 ③时间线里它参与或作为地点的事件 ④账本里以它为主体的条目 ⑤伏笔 `linkedEntities` 关联项，外加总计数。**只读、零写盘**：不 `ensureIndex`、不写 `state.json`、不碰真相文件 |
| 改名的文件效应 | 在同一目录内换文件名 + 把**旧 id** 写进新文件 frontmatter 的 `id`；引用方（关系 `source`/`target`、时间线 `participants`/`place`、账本 `subject`、伏笔 `linkedEntities`、`entity_mentions.entity_key`）**一个都不改**。**只改显示名不动文件名、也不写 `id`**——钉 id 的判据是「目标路径 ≠ 当前路径」，否则文件会声称自己改过名（ADR-0014 §4） |
| 索引效应 | 重建后 `entities` 行的 `id` 不变、`path` 更新；`entity_mentions` 命中条数不变。id 与路径不一致是合法状态（I-20 `ID_PATH_DIVERGED`，info、不阻断） |
| 预览与拒绝同一套码 | `GET /impact?slug=&newTitle=` 回 `rename.blockers[]`，**空＝可执行**；非空时给的码与写路由 400/409 的码逐字相同：`KIND_NOT_RENAMEABLE` / `SLUG_INVALID` / `TITLE_INVALID` / `RENAME_NO_CHANGE` / `TARGET_EXISTS`。`SLUG_INVALID` 的判据＝①不以点开头（点开头条目两个扫描器都跳过，写进去就只剩 git 能救）②不含路径分隔符/控制字节 ③过 `io.ts` 的段校验（`con`/`nul`/`COM1` 等保留名、末尾点或空格、单段 >255）。`TITLE_INVALID` ＝显示名含换行（frontmatter 一个名字只占一行） |
| 拒绝 | 目标已存在 → `409 TARGET_EXISTS`（**计划时**与**锁内**各查一次：外部编辑器不持锁，预览之后可能有文件落到目标名上）；基线不符 → `409 FILE_CHANGED`（两者都零写入）；`facts` 不参与改名（文件名即主体，主体改名等账本口径定案，见 #32）。io 层兜底仍可能返回 `400 PATH_INVALID`/`PATH_TOO_LONG`/`PATH_RESERVED`（预览已用同一规则拦下，属双保险）、`409 PROJECT_BUSY`；新文件写成后旧文件删不掉 → `500` + `rolledBack`（新文件已撤回，旧文件仍在原处） |
| 取消零写入 | 只生成清单、不执行（关掉对话框）→ 项目树全量 hash 与 `sha256` 不变 |
| 重复改名 | 沿用文件里已有的 `id`，不再生成新的；只有「改名」写 `id`，新建实体不钉 |
| 参数同名不同键 | 预览用 `newTitle`（GET query），执行用 `title`（POST body）——前者是「打算起的名字」，后者与设定库编辑器的字段名对齐；两者都是**显示名**，文件名只由 `slug` 决定 |

**验证**：`node --test tests/impact.test.js tests/identity.test.js`。
