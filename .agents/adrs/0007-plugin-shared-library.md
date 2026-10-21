# ADR-0007：插件级共享库（复制快照 + `origin` 溯源）

- 状态：**已采纳（2026-10-21）**
- 日期：2026-10-21
- 关系：与 [ADR-0005](0005-files-first-with-derived-index.md)（文件真相）/ [ADR-0006](0006-workspace-contract-v2.md)（工作区契约 v2）并行；只**扩展** ADR-0006 D3 的 `.gitignore` 清单一项（C7），不改二者的目录与门禁条款
- 影响：[S-01 product-scope](../specs/product-scope.md) 的「系列共享设定」（F-P2-04/F-P2-05、PS-I-25）、[S-03 conventions](../specs/conventions.md) 的 `inkflow.json` 字段、[S-04 data-model](../specs/data-model.md) 的实体归属；随 spec 重写一并落地

## 背景

1. 产品差异化②是「系列共享设定 / 同世界观多故事」：同一作者的 2–5 本书共享世界观条目、资料原文与写作片段，且只维护一份（[S-01](../specs/product-scope.md) F-P2-04/F-P2-05）。
2. 硬约束是「一个工作区 = 一部小说 = 一个 git 仓库」（[ADR-0006](0006-workspace-contract-v2.md) D5）。共享内容因此**不能**靠跨工作区写实现——那会同时破坏书的自包含与门禁 fail-closed。
3. 插件已经有一个属于自己的目录：`dataDir` 缺省 `$DSH_HOME/inkflow`（`src/host/config.ts:12-17,38-48`；`DSH_HOME` 缺省 `~/.dsh`），当前只放 `state.json`。
4. 现行 `inkflow.json` 已有 `seriesId` 字段但没有承载物（[S-03](../specs/conventions.md) §3.1）；[S-01](../specs/product-scope.md) PS-I-25 把「系列是 project 属性还是独立实体」留作待拍板，建议默认值是「独立 `series` 表」——但 SQLite 已不是真相源（[ADR-0005](0005-files-first-with-derived-index.md)），"表"这条承载路径不通。
5. 同一条目被复制进多个项目后，必须能回答「它从哪来、还新不新」；否则一次复制就把共享库退化成互不相干的多份副本，共享库只剩"手工复制粘贴"的价值。

## 决策

### C1 位置、结构与身份

共享库固定在插件数据目录下：`$DSH_HOME/inkflow/shared/`（= `dataDir/shared`；`dataDir` 可被插件配置覆盖）。

| 子目录 | 内容 | 文件形态 |
|---|---|---|
| `world/` | 世界观 / 设定条目 | `world/<category>/<slug>.md`（frontmatter 与项目内 `world/` 同构，可直接复制） |
| `library/` | 资料原文 + 资料索引卡 | `library/<slug>.md`（卡片：来源 / 许可 / `sha256`）+ 可选 `library/<slug>.<ext>`（共享库自己持有的原文副本） |
| `snippets/` | 写作片段 / 素材 | `snippets/<slug>.md` |
| `series/` | 系列分组 | `series/<slug>.json` |

- **条目身份**：`entryId` 写在 `.md` 的 frontmatter 或 `series/*.json` 的顶层，形如 `sh-<8 位十六进制>`，创建时生成；**不复用**，重命名/移动目录不改 `entryId`。
- **派生清单**：`shared/index.json`（`{schemaVersion, entries[{entryId, kind, path, sha256, tags, updatedAt}]}`）是**派生投影**：可删可重建（扫四个目录重算 `sha256`），手改会被下一次扫描覆盖。与 ADR-0005「文件是真相、清单是缓存」一致，不引入第二个真相源。
- 共享库目录不存在 = 共享库为空；第一次写入时创建（含 `index.json`）。缺目录**不**拒绝任何业务工具。

### C2 默认「复制快照」

取用共享条目时，默认动作是**复制一份进当前项目**，目标按项目目录契约（[ADR-0006](0006-workspace-contract-v2.md) D1）落位：

| 共享条目 | 项目内落位 |
|---|---|
| `world/…md` | `world/<category>/<slug>.md` |
| `library/*.md`（卡片） | `library/<slug>.md`（连同可选原文副本） |
| `snippets/*.md` | `library/snippets/<slug>.md`（`library/` 是"资料"域，**不新增第十个一级目录**） |
| `series/*.json` | 不落文件；只写 `inkflow.json.seriesId` |

复制是**单向快照**：共享库是来源，项目副本是独立文件（可自由修改）；不存在双向同步（见 C4、C6）。

### C3 `origin` 溯源三字段

复制时在目标条目写入 `origin`：

| 字段 | 含义 | 缺省 |
|---|---|---|
| `projectId` | 复制发生时项目 id（`inkflow.json.projectId`） | 无法确定时 `null`（尚未生成 id 的老项目） |
| `entryId` | 共享条目 id | 必填 |
| `contentHash` | **复制那一刻**共享条目的 `sha256` | 必填 |

- `origin` 是**来源证据，不是同步指针**：记录"复制时的来源与版本"，写入后不随共享库变化自动更新。
- 新增可选字段 `inkflow.json.projectId`（UUID，初始化向导生成、随仓库走）：没有它无法区分"哪个项目复制了这条"。该字段**不参与门禁判定**（缺失合法），只让 `origin.projectId` 为 `null`。
- 资料原文副本（`library/<slug>.<ext>`）的来源由同一张卡片上的 `origin` 表达；**不给二进制文件写 sidecar**。
- `contentHash` 与共享库当前内容不一致 → 该副本是 **stale**（可列出、可显式「更新快照」），但**不自动改**：自动改等于未经同意覆盖作者已经改过的正文。

### C4 引用模式只允许 `library/` 原文

- 唯一例外：`library/` 的**原文**可以不复制、只引用——落一张 `mode: reference` 的卡片，`origin` 记录共享库侧 `sha256`（无 `contentHash`），正文为空。
- 引用卡片在项目内**只读**：任何写入返回 `REFERENCE_READONLY`；要改先执行「转为复制快照」（显式动作，写内容并置 `mode: copy`）。
- UI 必须明示「**本项目不自包含**」：引用条目标记 + 面板顶部一行说明；汇总类接口返回 `selfContained: false` 与被引用条目清单。
- `world/`、`snippets/`、`series/` **不允许**引用模式：设定被引用就等于"书的设定不在书里"，与自包含目标正面冲突。

### C5 系列 = 共享库分组

- `series/<slug>.json`：`{schemaVersion, seriesId, title, description, entryIds[], createdAt}`；`seriesId` 形如 `se-<8 位十六进制>`。
- 项目侧只有 `inkflow.json.seriesId`（字符串或 `null`）指向它；**不复制系列文件**。
- 一条共享条目可属于多个系列（`entryIds` 多对多）；系列没有第二条真相。
- 取代 [S-01](../specs/product-scope.md) PS-I-25 的「独立 `series` 表（多书对一系列）」建议默认值：表口径随 ADR-0005 的 SQLite 退役一并作废，改为共享库里的 `series/*.json`。

### C6 删除与级联边界

- **删除项目不删共享库**：删书（或用户直接删目录）时共享库不做任何清理。共享条目可能被其他书引用，且"删一本书"不该有跨仓库副作用。
- **删除共享库条目不删项目副本**：副本是独立文件，来源消失后照旧可用（stale 检查报"来源不存在"）；引用卡片则失效并标 `missing`，**不静默删文件**。
- 不提供反向推送/批量回滚到共享库：共享库没有"推送"方向。

### C7 机器私有配置不入库

- `.openviking/config.local.json`（语义检索的 peer 私有层，见 [ADR-0009](0009-ovk-semantic-search.md)）进**项目** `.gitignore`：它按机器填写，入库会让协作者/其他机器继承错误的 peer——语义检索会把 A 书的内容写进 B 书的命名空间。
- `.openviking/config.json`（团队层，可提交）**不**忽略。
- 落点是初始化 / 修复向导生成的 `.gitignore`（[ADR-0006](0006-workspace-contract-v2.md) D3 已列 `index/*.db` 等三项）：本 ADR 只**追加**这一行，不改 D3 其余内容。已存在但缺该行的 `.gitignore` → 列为可执行动作，**不自动改写**。

## 备选与取舍

| 方案 | 优点 | 代价 | 为什么没选 |
|---|---|---|---|
| 共享库放在**每本书内部**（如 `library/shared/`），跨书用 git submodule 引用同一目录 | 书自包含；一份内容多处可见 | submodule 把书的版本指针绑在外层仓库，回滚与协作都变重；同内容在 N 本书里仍各存一份 | ADR-0006 D4 已否决"把书的版本指针绑进外层仓库"的同类做法；且"一次维护、多书取用"正是共享库存在的理由，项目内副本做不到 |
| 共享库用**全局 SQLite**（沿用旧 InkFlow 的 `data_dir` 库） | 查询、去重、stale 判定都方便 | 与 ADR-0005「文件真相」冲突；无 git 审阅；备份与同步要另写一套 | 共享库是作者可读可改的资料，不是缓存；一旦成真相就要迁移 |
| **引用优先**（默认不复制，需要时再落地） | 省磁盘、单一真相 | 书 clone 到另一台机器就丢内容，「这本书能独立带走」的承诺失效 | 自包含是首要目标，省磁盘与单一真相是次要收益；原文已留引用出口（C4） |
| **双向同步**（改共享库自动回写项目，或反向） | 不用手动更新 | 跨工作区写入，违反 ADR-0006 D5；冲突时无法判定以谁为准 | 单向快照 + stale 列表 + 显式「更新快照」满足需求，且没有隐式写 |
| 系列用 **tags**（不建 `series/`） | 一条目可属多系列，无新实体 | 没有系列级元数据（标题、描述、顺序、是否完结），`inkflow.json.seriesId` 无处可指 | 多系列归属用 `entryIds` 也能表达；系列需要名字与描述这类元数据 |
| `origin` 只记 `entryId`（不记 hash） | 字段更少 | 无法判断副本是否落后于来源 | stale 判定本身就是本方案的主要价值之一 |
| 二进制原文也写 `origin`（sidecar `.origin.json`） | 覆盖全部条目类型 | 每份资料多一个文件，移动/清理容易只搬半边 | 卡片与原文成对已足够表达来源，sidecar 让 `library/` 目录噪声翻倍 |

## 后果

### 正面

- 系列设定一次维护、多书取用；每本书仍是可独立 clone 的仓库（默认模式）。
- 来源可追溯：`origin.entryId` + `contentHash` 能回答"这条从哪来、是否落后"。
- 共享库是纯文件（Markdown/JSON），用户可直接编辑，也可自行 `git init` 单独版本化（插件**不**代跑 git 命令，ADR-0006 D4）。

### 负面

- 磁盘重复：N 本书 = N 份副本。
- 共享库不在任何书的仓库里 → 它自己的备份与历史不在书的 `git log` 中，需要用户自建（插件只提示）。
- stale 需要用户主动看；不看就一直是复制那一刻的内容。

### 风险

| 风险 | 触发条件 | 对策 |
|---|---|---|
| 自包含性被引用模式破坏 | 在 `library/` 上选了引用 | UI 明示「本项目不自包含」+ 汇总接口返回 `selfContained: false` + 引用卡片只读；`world/`/`snippets/`/`series/` 禁止引用 |
| 双写漂移（副本与来源各改各的） | 作者在两边同时改 | 明确共享库是来源、项目副本独立；`contentHash` 不一致列为 stale，更新只能显式触发 |
| 许可 / 隐私 | 把第三方文本或未发布设定放进共享库，再复制到别的书 | `library/` 卡片强制 `license` 字段（缺省 `unknown`）；共享库是**插件级**目录（同机所有书可见），首次加入时 UI 提示"这是跨书共享" |
| `origin.projectId` 为 `null` | 复制发生在 `projectId` 生成之前 | 允许 `null`；stale 判定不依赖 `projectId`，只在"按项目统计来源"时降级 |
| `.gitignore` 被手改回去 | 用户重排 `.gitignore` | 初始化 / 修复向导把该行作为**可检查项**（缺则列入动作），不自动改写 |

## 验证

文档门禁（本次即可执行）：

```bash
node scripts/check-links.mjs
pnpm.cmd run check
```

期望：`links ok: N relative link(s) across M markdown file(s)`；`check`（typecheck + lint + build + test + links + docs + guards + package）全绿。

行为判据（**验收判据，不是现状陈述**；用例落在 `tests/`，实测证据贴对应 PR 评论、不入库，见 [AGENTS.md](../../AGENTS.md) §9.5 D7）：

| # | 场景 | 期望（判据） |
|---|---|---|
| V1 | 从共享库复制一条 `world/` 条目 | 项目内出现 `world/<category>/<slug>.md`；frontmatter 含 `origin.{projectId,entryId,contentHash}`；共享库文件 hash 前后一致 |
| V2 | 删除项目目录 | 共享库 `index.json` 与全部条目 hash 前后一致 |
| V3 | 改共享库条目正文后再打开项目 | 项目副本内容不变；stale 列表含该 `entryId`（`contentHash` 不匹配） |
| V4 | 对一条 `library/` 原文选「引用」 | 项目内只有卡片、无原文副本；汇总返回 `selfContained:false`；写卡片返回 `REFERENCE_READONLY` 且文件 hash 前后一致 |
| V5 | 删除共享库条目 | 已复制的项目副本仍在且可读；引用卡片变 `missing`，不删文件 |
| V6 | `inkflow.json.seriesId` 指向不存在的系列 | 读操作返回"系列不存在"，不写盘、不改 `seriesId` |
| V7 | 项目 `.gitignore` 检查 | `git check-ignore .openviking/config.local.json` 命中；`.openviking/config.json` 不命中 |
| V8 | `shared/index.json` 被删除或手改 | 下一次扫描重建出与文件一致的清单；手改不生效 |
| V9 | 文档门禁 | `check-links` 0 断链；`pnpm.cmd run check` 全绿 |
