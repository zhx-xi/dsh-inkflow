# ADR-0015：一键修复与 6→9 目录迁移（检测/预览/修复三段 + 可回滚备份包）

- 状态：已采纳（2026-10-24）
- 日期：2026-10-24

## 背景

0.3.0 的 #36 要把两件原本靠人做的事变成可执行动作，而它们碰的是**同一本书的全部文件**：

| 需求 | 来源 | 现实约束（已实测的契约） |
|---|---|---|
| 一键修复 | #36 | 问题形状已由 [findings.ts](../../src/host/findings.ts) 定死（X-14）：`code / group / severity / locator / detail / hint / fixable`；`fixable:false` 是**决策**（悬空引用、坏账本行都不该「修」） |
| 6→9 目录迁移 | #36 | 老书与新书的目录名**完全相同**（`chapters/ characters/ world/ outlines/ library/`），差的是**新增**四个目录与 `index/`；内容文件不需要搬家 |
| 回滚包 | [ADR-0012](0012-plugin-private-state-dir.md) | `.inkflow/{trash,backup,audit}` 是唯一私有落点，`backup/` 与 `trash/` **不共享清单格式**（X-10），写只能经 `resolveWriteTarget` |
| 报告 | #33 / #36 | 报告是派生物，落 `.inkflow/audit/`，不入库（D7） |

另外两条已存在的实现事实决定了取舍：

1. 三态门禁允许的写路径只有「九个内容目录 + `index/` + 三条 `.inkflow/` 子路径」，`inkflow.json` 与 `.gitignore` **不是**写目标——它们是脚手架路径（[workspace.ts](../../src/host/workspace.ts)）用直接写处理的。
2. 向导（`inkflow_project_init`）的撤销是**内存里的**：它的动作只创建东西，失败时把这一轮创建的目录/文件删掉即可。迁移不同——它要改两个**已存在**的文件，进程一崩，内存撤销就没了。

## 决策

### D1 检测 / 预览 / 修复是三个可分别运行的阶段

| 阶段 | 入口 | 写盘 |
|---|---|---|
| detect | `detectFindings(root)` / `inkflow_project_repair action: detect` | 无 |
| preview | `planRepair(root)` / `action: preview` | 无（不建目录、不取锁、不追加 `.gitignore`） |
| fix | `applyRepair(root, { confirm: true })` / `action: fix` | 有，且**必须** `confirm: true` |

每条修复是一个**可选中的动作**（`key = kind|path`），`select` 可按动作 key、finding key 或 code 缩小范围；单条动作失败不中止其余动作（每个动作就是一次原子文件写，停在中途反而留下半状态），但整轮结束会**重跑同一套检查**并把仍在的问题列出来。

### D2 「只补不改」的边界（可执行的清单）

允许的动作**只有五种**，其余一律进报告的「未自动修」并给理由：

| 动作 | 做什么 | 为什么算「只补」 |
|---|---|---|
| `patch-frontmatter` | 追加缺失的 `subject:`（`facts/`）与 `kind:`（`relations/`） | 这两个值**读取侧早就在用兜底**（文件名 / `character`），写下来只是让文件说出索引已经假定的事 |
| `derive-foreshadow-status` | 按文件自带的证据字段改写 `status` **一行**（[data-model §3.2.1](../specs/data-model.md) 的状态机） | 状态与证据矛盾时答案唯一：`resolved: true` 或 `resolvedChapter` 非空 → `resolved`；否则 `advancedAt` 非空 → `advanced`；否则 → `planted`。这是把文件自己已经写下的证据翻译成它该有的状态，不是新造事实 |
| `reparent-outline` | 把卷纲/章纲的 `parent:` 指向合法祖先 | 修的是**指针**，不是标题、不是正文 |
| `remove-duplicate` | 删掉后出现的重复关系文件 | 同一 `(source,target,kind)` 只留一条；被删的字节**先**进备份包 |
| `rebuild-catalog` | 重建 `chapters/index.json` 与各卷 catalog | catalog 是 `.md` 的**派生投影**（ADR-0006 D6） |

`derive-foreshadow-status` 是表里唯一会**改写既有值**的动作（前四者都在补缺失或重定向指针），它因此有两条硬边界：

| 情形 | 处置 | 为什么 |
|---|---|---|
| `resolved: false` 且有 `resolvedChapter` | **不推导**，进「未自动修」并说明两字段互相矛盾 | 写 `resolved` 治不好 I-21 的第②条（`resolved: false` 仍与它矛盾），写 `planted` 又否认了那一章：任何选择都是猜 |
| `resolved: true` 但缺 `resolvedChapter` | **不推导**，进「未自动修」并说明要先补章 | 写 `status: resolved` 会消掉 I-21 却立刻报出 `FORESHADOW_RESOLVED_WITHOUT_CHAPTER`（I-09）：拿一条问题换另一条 |
| `status` 与证据已经一致 | 不产生动作（**零写入**） | 幂等：一本书修过一遍，第二遍不该再有动作 |

它只由 `FORESHADOW_TRANSITION_INVALID` 触发；`FORESHADOW_RESOLVED_WITHOUT_CHAPTER` 不触发它——把 `status` 降级成 `planted` 虽能让 I-09 不再报，但那是**抹掉作者声明的回收**，属于明令不做的那一类。

三条**明令不做**：不改正文、标题、`id`；不把非法枚举值「改正」（`kind: 知识` 要人决定）；`fixable:false` 的码一个都不碰。

### D3 检测不新造判定

`detectFindings()` = `scanProject()`（结构/账本/伏笔/时间线）+ `validateCatalog()`（catalog 投影）的 `validation_issues`，只做「改形 + 排序 + 去重」。域模块判过的东西不再判第二遍；报告的排序用 `compareFindings`（group → severity → locator），两次跑同一本书的顺序必须一致。

### D4 迁移 = 只增目录 + 只动两个元数据文件

老书的迁移动作集合固定为：`git-init`（没有 `.git` 时）、`create-dir`/`create-gitkeep`（缺的目录与空标记）、`append-gitignore`（缺的派生索引忽略行，**只追加**）、`write-meta`（`schemaVersion` 低于当前唯一来源时，**只改这一个字段**，其余键原样保留）。内容文件（`chapters/**.md`、`world/**.md`、……）一个字节都不动，也不需要搬家——目录名本来就没变。

`git init` 边界沿用 ADR-0006 D4：不 `add`、不 `commit`、不配远端与身份。

### D5 备份包 `<book>/.inkflow/backup/<stamp>/`（机器读，一次性）

```
.inkflow/backup/20261024T015500123Z/
  manifest.json   # schemaVersion / kind / createdAt / sealed / steps / dirs / files[] / kept[]
  files/…         # 受影响文件的原字节，按原相对路径存放
```

四条可检验的性质：

1. **先写清单再改**：开包时写 `sealed:false` 的清单，跑完再盖章 `sealed:true`。中途崩溃留下的是「可读的日志 + 未完成」，而不是猜。
2. **拷贝当场校验**：读完写、写后回读比对；非 UTF-8 源直接拒（`io.ts` 是文本写，回不来）。
3. **条目三型**：`created`（本轮新建，回滚删除）/ `modified`（原有，回滚按原字节写回）/ `removed`（本轮删除，回滚复原）。每个条目都记 `after` 摘要，回滚**先验当前字节**再覆盖——作者在这之后改过的文件是 `BACKUP_CONFLICT`，新文本赢。
4. **`.git` 不撤销**：空仓库不是数据，删 `.git` 是插件里唯一可能毁掉历史的动作；清单的 `kept` 明确记录「这里故意不动」。

### D6 迁移失败**不**自动回滚，而是留 partial + 包 + 显式 rollback

失败返回 `{ ok:false, partial:true, backup }`：已完成的步骤留在盘上，`partial:true` 说清楚，回滚由 `action: rollback` 重放清单完成。理由：迁移的第一步就可能改 `inkflow.json`，而「撤销」必须能跨进程重放——内存撤销在崩溃面前等于没有。向导相反（只创建、内存撤销够用），两者不矛盾：**能内存撤销的就内存撤销，改了已存在文件的就落盘撤销**。

### D7 报告是派生物

`fix` / `apply` / `rollback` 各写一份 `<book>/.inkflow/audit/{repair,migrate}-<stamp>.md`：修复前的问题表、本次动作表、未自动修的原因表、重跑检测的差值、回滚入口。报告**不入库**（DROP 到 gitignore 的 `.inkflow/`），删掉只丢一次渲染。

### D8 锁的粒度：每次写各自取锁 + 可核验的回滚，而不是「整个迁移持一把锁」

`applyRepair` / `applyMigration` **不**用一个 `withProjectWriteLock` 包住整轮：

| 选择 | 理由 |
|---|---|
| 每个动作一次原子写（`writeTextAtomic` 自带写锁 + 临时文件 rename） | 一轮修复可能有十几个动作，迁移要建目录、改两个元数据文件；整轮持锁会把面板与其他会话挡在 `PROJECT_BUSY` 外面几十秒，而失败恢复并不因此更简单 |
| 失败**不**自动回滚（D6），改由备份包撤销 | 中途失败时，「已经写成的东西」是可以逐项核验的（每个动作自己是一次原子写），而「自动撤销」需要一段能跨进程重放的反向脚本——那正是 D6 拒绝的东西 |
| 回滚**逐文件核对**改后摘要（`BACKUP_CONFLICT`） | 没有一把长锁保护，就必须假设「这期间有人动过文件」：回滚先验 `after` 摘要，只覆盖没被改过的文件，冲突的文件报出来让人决定 |

代价：一轮动作之间没有互斥，两个会话同时对同一本书跑修复会互相踩（各自的动作仍是原子的，坏的是「两个计划基于同一份旧视图」）。对策是**入口**：两个工具都要求 `confirm: true`，且 `preview` 与 `apply` 不在同一个动作里完成——重跑 `detect` 是免费的，报告里也写明「计划可能已过期，重跑一次再确认」。

### D9 写锁住在 `index/`：报告口径与回滚清理都要认这件事

`io.ts` 的项目写锁文件是 `<book>/index/.write.lock`，取锁时 `mkdirSync(index)`。于是「派生目录 `index/` 由谁创建」有一个与迁移无关的事实：**任何一次走 `io.ts` 的写都会顺手建出 `index/`**——包括迁移自己（备份包清单、每个 `stageFile`、审计报告）。

两个后果，都在 `migrate.ts` 里收口：

| 症状 | 处置 |
|---|---|
| `plan` 列 N 步、`apply` 报 N-1 步，缺的是 `create-dir index` | 执行前先快照「计划要建、此刻确实不存在」的目录集合；`create-dir` 到达时目录已存在且**为空**，就认定是本轮自己的副作用：照常计入 `applied` 并写进备份包的 `dirs`（回滚才收得掉）。非空则维持「已就位」的跳过语义——别人填进去的目录不认领 |
| `rollback` 后空 `index/` 残留 | 回滚后用清单里的 `dirs` 再扫一遍：空的删掉；非空（例如门禁重建的 `index/inkflow.db`）**保留并在报告里写明「派生物保留」**。因为最后那份审计报告本身也要取锁，这次清扫必须放在报告写完之后，作为整轮最后一个动作 |

取舍：不把 `index/` 从计划里删掉（那是「十项目录各带 `.gitkeep`」的约定，删了等于把一次迁移交给门禁去自愈），也不搬 `io.ts` 的锁位置（锁是全局约定，为一个工具的评价口径搬它不划算）。代价是「本轮新建且为空」这条判据要求精确：判据是**执行前的快照**，不是「现在是不是空的」。

## 备选与取舍

| 方案 | 优点 | 代价 | 为什么没选 |
|---|---|---|---|
| 备份包复用回收站格式 | 少一个模块 | 回收站按 entry id 逐条恢复、且**拒绝覆盖**任何现有文件；批量撤销要「写回 N 个 + 删除 N 个 + 验证当前字节」 | X-10 已定两者不共享清单格式：语义不同，共享会逼一方迁就另一方 |
| 迁移沿用向导的内存撤销 | 代码复用 | 撤销随进程消失；迁移要改**已存在**的文件 | 崩溃后留半迁移状态且无人能撤——比 partial + 包更糟 |
| 修复直接把非法枚举值改正（`kind: 知识` → `knowledge`） | 「一键」更像一键 | 改的是作者的文本，且值的选择是猜测 | 与 data-model §5 的「拒绝而不是降级」一致：写侧拒绝，修复侧也只补不猜 |
| 删除重复关系时保留「名字最像的那条」 | 更符合直觉 | 没有可判定的规则（文件名 vs 端点 basename vs 修改时间） | 取「索引保留第一条（路径序）」这一条**确定**规则，动作 detail 里点名保留者，删除的字节进备份包可回滚 |
| 迁移复用 `applyWorkspace()` 一把过 | 零新代码 | 拿不到 per-step journal、没有 `schemaVersion` 升级、没有备份包 | 迁移是 #36 的交付，`applied/skipped` 与 dry-run 的**集合相等**是验收项 |
| 把 `.inkflow/` 加进 `REQUIRED_GITIGNORE_LINES` | ignore 行「自动」有了 | 门禁会给一本从不删东西的书永久列一条修复动作 | ADR-0012 #2 已定：由首次使用者 append-only 追加 |
| 顺手加一个迁移面板页 | 可视化 | 本单的验收面是工具与报告；面板要重启 DSH 才能验 | 留到有具体 UI 需求时再加（`PANEL_TABS` 一行 + 页组件一处登记即可，X-12） |

## 后果

| 收益 | 代价与对策 |
|---|---|
| 修复/迁移都能**先看后做**，且失败可撤销到字节级 | 多一个 `.inkflow/backup/` 目录：ADR-0012 已让它不进 git、不参与门禁、不进索引 |
| 「不能自动修」变成报告里的一条**理由**，而不是静默跳过 | 报告会变长：只列前 N 条明细 + 全量在表格里 |
| 迁移对老书是「只增」，可随时回滚，内容零风险 | `inkflow.json` 写入会去掉 BOM（`readMeta` 读时就剥），属唯一一处字节级归一 |
| catalog 重建让两处漂移一次修好 | 重建只碰 `.md` 的投影；`.md` 自身从不被修复改写 |
| `.inkflow/` ignore 行由 `ensurePrivateStateIgnored()` 追加后**不随回滚删除** | 有意：备份包还在盘上，删掉忽略行会让它突然出现在 `git status` |
| 根级元数据（`inkflow.json`、`.gitignore`）不在写白名单里 | 回滚时走脚手架同一扇门（直接写）；白名单不为它们放宽（那会让任何调用方都能改 meta） |

## 验证

- `tests/repair.test.js`：一本书带齐每个问题类各一处 → detect 全列出；preview 前后 `hashTree()`（含 mtime）一致；fix 需 `confirm`；fix 后重跑检查证明可修类**全部消失**、不可修类带理由存活；**逐文件 sha256** 证明只有动作点名的文件变了；`select` 只跑一条；rollback 还原到字节一致（`.gitignore` 的 `.inkflow/` 行除外，见上表）。
- `tests/migrate.test.js`：`plan` 零写盘；**dry-run 动作集合 == applied 集合**（逐项比较，不比数量）；`chapters/**.md`、`world/**.md` 迁移前后字节不变；成功回滚后逐文件字节一致且 `.git` 保留；把 `timeline` 预先做成普通文件制造中途失败 → `partial:true` + `sealed:false` 清单 → 回滚后除 `.gitignore` 的 `.inkflow/` 行外与执行前一致；执行后改过的文件让 rollback 报 `BACKUP_CONFLICT` 且不覆盖。
- `tests/tool-schema.test.js`：工具面 26 → 28（两个新工具），域工具仍 14。
- `tests/domain-registry.test.js` / `tests/contract.test.js`：内建面 12 → 14，名字与 surface hash 同步。
- `tests/findings.test.js`：**未新增**任何 code（本单不新增不变量，只消费既有目录），双向对拍保持绿。
- `tests/foreshadow-status-repair.test.js`（见 D2）：三档推导各一条（`planted`+`advancedAt` → `advanced`、`resolvedChapter` → `resolved`、空 `advancedAt` → `planted`）；**逐字节**断言「补丁后的全文 == 原文只换 `status` 那一行」；一致的文件零动作、零写入、不开备份包；两种互相矛盾的证据不推导且带理由存活；推导出来的写受备份包覆盖、回滚后字节一致。
- `tests/migrate.test.js`（见 D9）：缺 `index/` 的老书 `plan.length == applied.length` **且逐项同序**；回滚后空 `index/` 不再残留；`index/` 里有 `inkflow.db` 时保留并在 `kept` 里说明。
- `npm run check` 全绿。
