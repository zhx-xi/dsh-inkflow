# dsh-inkflow 数据模型（文件真相 + 派生索引）

> **依据**：[ADR-0005](../adrs/0005-files-first-with-derived-index.md)（文件真相 / 派生索引 / 不写迁移）、[ADR-0006](../adrs/0006-workspace-contract-v2.md)（九目录 / 卷章 catalog）、[ADR-0007](../adrs/0007-plugin-shared-library.md)（共享库 / `origin`）、[ADR-0009](../adrs/0009-ovk-semantic-search.md)（语义检索）。
> **依赖**：[conventions.md](conventions.md)（目录、文件格式、门禁、写入纪律）。
> **相关 ADR**：0005、0006、0007、0009。
> **状态**：活跃（v3）。本文只描述**数据形状**与**不变量**；未实现的表/字段在 §4.2 与 §7 显式标注。

## 1. 一句话

**真相 = 项目 git 仓库里的 Markdown/JSON 文件；索引 = `index/inkflow.db`，随时可删可重建；卷章 catalog 是入库的结构投影。**
因此没有数据库迁移，也没有「插件升级改坏存量项目」：升级只改解析器与索引 schema 版本，索引直接重建。

三层分工：

| 层 | 位置 | 进 git | 承载 |
|---|---|---|---|
| 真相 | 九个内容目录 + `inkflow.json` | ✅ | 正文、设定、关系、账本 |
| 结构投影 | `chapters/index.json`、`chapters/<vol>/index.json` | ✅ | 卷章清单（可 `git diff` 审阅，[ADR-0006](../adrs/0006-workspace-contract-v2.md) D6） |
| 派生缓存 | `index/inkflow.db`、`index/audit/`、`index/extraction/`、`index/proposals/` | ❌ | 检索、校验结果、临时件 |

**唯一双向约束**：投影和缓存都可以由真相重建；反过来用手改投影/缓存来改数据不成立（会被下一次重建覆盖）。

## 2. 实体 → 文件位置（22 个业务实体组）

| # | 实体组 | 位置 | 形态 | 说明 |
|---|---|---|---|---|
| 1 | 项目（book） | `inkflow.json` | JSON | 唯一元信息文件（`schemaVersion` / `title` / `author` / `projectId` / `seriesId`，见 [conventions.md](conventions.md) §3.1） |
| 2 | 卷 volume | `chapters/index.json` 的 `volumes[]` + 卷大纲节点 | JSON + MD | 卷的稳定身份是 `volumeId`（`vol-NN`）；卷标题/顺序的文学内容在大纲 `kind: volume` 节点 |
| 3 | 章 chapter | `chapters/**/<seq>-<slug>.md` | MD + frontmatter | 正文即 body；章归属由 frontmatter `volume`（值=volumeId）决定；`id` 是建档时生成的 uuid |
| 4 | 章版本 | git 提交历史 | git | 不建 `chapter_versions`；版本 = commit |
| 5 | 大纲节点 outline | `outlines/*.md` | MD + frontmatter | `kind: overall\|volume\|chapter`，`parent` 挂接 |
| 6 | 情节点 plot_point | 大纲文件正文的列表项 | MD 列表 | 结构化语法未定；当前自由文本 |
| 7 | 故事线 arc | `outlines/arcs/<slug>.md` | MD + frontmatter | 【未实现】 |
| 8 | 世界观树 world_setting | `world/<category>/<slug>.md` | MD + frontmatter | 目录即分类；`parent` 建树 |
| 9 | 世界书词条 worldbook | `world/**` 的 frontmatter 字段 | 复用 | `keywords` / `always` / `priority` |
| 10 | 角色 character | `characters/<slug>.md` | MD + frontmatter | `name` 项目内唯一（索引校验） |
| 11 | 角色分组 group | 角色 frontmatter `group` | 字段 | 独立分组文件【未实现】 |
| 12 | 角色关系 relation | `relations/<slug>.md` | MD + frontmatter | 一级目录（[ADR-0006](../adrs/0006-workspace-contract-v2.md) D1），见 §3.3 |
| 13 | 角色语言基因 voice | 角色 frontmatter + body 段 | MD | 字段名与结构未定 |
| 14 | 角色状态 state | 角色 frontmatter `states`（按章） | JSON 片段 | 结构未定 |
| 15 | 伏笔 foreshadowing | `foreshadowing/<slug>.md` | MD + frontmatter | 一级目录，见 §3.2 |
| 16 | 时间线事件 timeline_event | `timeline/<slug>.md` | MD + frontmatter | 一级目录，见 §3.4 |
| 17 | 知识关系 knowledge_relation | `relations/<slug>.md` | MD + frontmatter | 与 #12 共用目录，按 `kind` 区分 |
| 18 | 事实账本 facts_ledger | `facts/<subject>.md` | MD + frontmatter | 一级目录，见 §3.5 |
| 19 | 场景契约 scene_contract | `outlines/scenes/<chapter>.md` | MD + frontmatter | 【未实现】 |
| 20 | 提案 / 修订 proposal | `index/proposals/` | JSON | 派生临时件；接受后才写正文并 git commit |
| 21 | 审计运行 audit_run | `index/audit/<timestamp>.json` | JSON | 派生物，可删 |
| 22 | 提取暂存 extraction_staging | `index/extraction/<run>.json` | JSON | 派生物；确认后才生成实体文件 |

系统/检索类（不计入 22 组）：

| 实体 | 位置 | 形态 | 说明 |
|---|---|---|---|
| 资料 library | `library/**` | 任意文件 | 索引只登记路径/大小；卡片见 §3.6 |
| 卷章 catalog | `chapters/index.json`、`chapters/<vol-dir>/index.json` | JSON | 结构投影，入库（§3.1） |
| 插件设置 app_settings | `$DSH_HOME/inkflow/state.json` | JSON | 只存 `lastProjectRoot` 一类机器状态，不存作品数据；**不作项目解析来源** |
| 变更日志 change_log | git 历史 | git | 不自建 outbox：git 就是变更日志 |
| 共享库条目 | `$DSH_HOME/inkflow/shared/{world,library,snippets,series}/` | MD/JSON | 插件级，不属于任何书的仓库（[ADR-0007](../adrs/0007-plugin-shared-library.md) C1） |
| 语义检索块 | OVK 服务端（按 peer 命名空间） | 外部 | 块 `{chapterId, seq, blockIndex, contentHash, deleted}`，见 [ADR-0009](../adrs/0009-ovk-semantic-search.md) P5 |

## 3. 字段字典

### 3.1 通用 frontmatter 字段

| 字段 | 类型 | 适用 | 语义 |
|---|---|---|---|
| `id` | string | 全部 | 稳定标识。章：建章时由插件写入 uuid（`randomUUID()`），**改名与移卷都不变**，引用一律用它；其余实体：缺省用相对路径（改名即换 id，建议显式写） |
| `title` | string | 章/世界观/大纲/伏笔/时间线/关系 | 显示名；章改标题会同时改文件名（`NNNN-<新 slug>.md`） |
| `name` | string | 角色 | 角色名（唯一性按归一化 name 判定） |
| `aliases` | string[] | 角色 | 别名（索引用于提及扫描） |
| `volume` | string | 章 | 卷归属，值就是稳定 `vol-NN`（[conventions.md](conventions.md) §3.2），**不从目录名推导**；移出卷时整行删除 |
| `seq` | int | 章 | 卷内序号；缺省取文件名前导数字。建章缺省 = 同卷（或散章）最大 `seq` + 1；删章不重排 |
| `status` | enum | 章 | `draft` / `revised` / `final`；伏笔/提案另有自己的状态枚举 |
| `kind` | enum | 大纲/关系 | 大纲：`overall` / `volume` / `chapter`；关系：见 §3.3 |
| `parent` | string | 世界观/大纲 | 上级 id（树结构） |
| `category` | string | 世界观 | 分类名，应与所在目录一致（不一致以 `category` 为准并告警） |
| `keywords` / `always` / `priority` | string[] / bool / int | 世界观 | 世界书触发词、常驻注入、优先级 |
| `group` / `role` / `pov` / `firstAppearance` | string/int | 角色/章 | 创作辅助字段 |
| `origin` | object | 共享库副本 | `{projectId, entryId, contentHash}` 来源证据（§3.7） |

未知字段：**保留在文件里，索引忽略**——加字段不需要改插件，也不会因为插件旧而丢用户数据。

### 3.2 伏笔 `foreshadowing/<slug>.md`

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `title` | string | ✅ | 伏笔名 |
| `status` | enum | ✅ | `planted`（已埋）/ `advanced`（已推进）/ `resolved`（已回收）/ `overdue`（超期） |
| `plantedAt` | string | ✅ | 埋设位置：章 id 或 `chapterId#charRange` |
| `advancedAt` | string[] | — | 推进位置列表，按时间顺序 |
| `resolved` | bool | — | 是否已回收；`true` 时 `resolvedChapter` 必填（I-09，现行实现校验） |
| `resolvedChapter` | string | — | 回收所在章 id；`resolved: true` 时必填 |
| `dueBy` | string | — | 期望回收的章 id 或卷 id；超期判定输入 |
| `linkedEntities` | string[] | — | 相关角色/世界观条目 id |
| `notes` | string | — | 自由备注 |

状态机只允许 `planted → advanced → resolved` 的推进，以及任一未终态 → `overdue`；`resolved` 是终态（非法流转拒绝，见 [product-scope.md](product-scope.md) A-06）。

### 3.3 关系 `relations/<slug>.md`

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `kind` | enum | — | `character`（角色关系，缺省）/ `knowledge`（知识图谱关系）；非法值降级为 `character` 并报 `FRONTMATTER_ISSUE` |
| `source` / `target` | string | ✅ | 两端实体 id（各恰一个，跨 kind 解析；见 I-08 的 `RELATION_ENDPOINT`） |
| `title` | string | — | 可读标签（如「清音 → 白鹤掌门」）；缺省时由两端推导，仅用于展示与 `entities.title` |
| `dir` | enum | — | `directed`（缺省）/ `undirected`；读写统一用 `dir`，读时兼容旧字段 `direction` |
| `since` / `until` | string | — | 关系成立 / 失效的叙事位置（章节 id 或世界内时间） |
| `chapter` | string | — | 该关系首次成立的章（用于按章回看） |

**字段口径的三处变更是 #27 定的**（改 spec 后再改代码，S1）：
- `relation`（关系类型，如 `师徒`）、`weight`、`evidence` **未实现**：关系类型集合在 [open-questions.md](open-questions.md) Q8 未裁决，先把未定项写进文件会制造第二套真相。在裁决之前用自由文本 `title` 承载「这层关系叫什么」。
- `direction` → `dir`：两个字段读时都接受，写时只写 `dir`。
- 新增 `chapter`：与 [conventions.md](conventions.md) 的 `relations/` 契约一致，`since`/`until` 只表达抽象位置。

孤立 / 冲突的**校验强度**仍待定（Q8 的另一半），当前只做三件事：端点必须存在、禁止自环、同 `(source, target, kind)` 不许重复。

### 3.4 时间线事件 `timeline/<slug>.md`

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `title` | string | ✅ | 事件名 |
| `worldTime` | object | ✅ | 世界内时间：`{era, year, month, day, precision}`；`precision` ∈ `era`/`year`/`month`/`day` |
| `narrativeOrder` | number | — | 叙事顺序（书内出现次序），可与 `worldTime` 不一致 |
| `chapterId` | string | — | 关联章 |
| `participants` | string[] | — | 参与角色 id |
| `place` | string | — | 地点（世界观条目 id） |
| `status` | enum | — | `confirmed`（缺省）/ `pending`（时间未定，进待确认区） |
| `calendar` | string | — | 历法 id（多纪元历法落地后使用） |

`worldTime` 与 `narrativeOrder` 是两条独立排序轴（双时间轴）；`status: pending` 的事件不参与时间轴排序，只出现在待确认区。

### 3.5 事实账本 `facts/<subject>.md`

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `subject` | string | ✅ | 事实主体（角色/物品/地点 id） |
| `attribute` | string | ✅ | 事实维度（年龄/境界/持有物/生死…） |
| `value` | string | ✅ | 当前值 |
| `since` / `until` | string | — | 生效/失效位置（章 id） |
| `chapterId` | string | — | 登记该事实的章 |
| `source` | enum | — | `text`（正文推导）/ `manual`（人工登记）/ `extract`（提取采纳） |
| `conflictsWith` | string[] | — | 冲突事实的文件 id 或行锚 |

账本按「主体」一文件（`facts/<subject>.md`），文件内每条事实一个列表项或一张表行；跨章校验的输入是同一 `subject + attribute` 的多个 `since` 区段。

### 3.6 资料卡片 `library/<slug>.md`

`library/` 里可放任意文件；对需要被检索/引用的资料，另写一张卡片：

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `title` | string | ✅ | 资料名 |
| `source` | string | — | 来源（URL / 书名 / 口述） |
| `license` | string | — | 许可；缺省 `unknown`（[ADR-0007](../adrs/0007-plugin-shared-library.md) 风险表） |
| `sha256` | string | — | 原文副本的哈希（有副本时） |
| `mode` | enum | — | `copy`（缺省）/ `reference`（引用共享库原文，只读，[ADR-0007](../adrs/0007-plugin-shared-library.md) C4） |
| `origin` | object | — | 来自共享库时的溯源（§3.7） |

### 3.7 共享库副本的 `origin`

| 字段 | 类型 | 语义 |
|---|---|---|
| `projectId` | string \| null | 复制发生时项目的 `inkflow.json.projectId`；老项目缺失时为 `null` |
| `entryId` | string | 共享库条目 id（`sh-<8 位十六进制>`） |
| `contentHash` | string | **复制那一刻**共享条目的 `sha256` |

`origin` 是来源证据，不是同步指针；`contentHash` 与共享库当前内容不一致 → 副本标 stale，但**不自动改**。

## 4. 派生索引（`index/inkflow.db`）

### 4.1 v5（现行，`PRAGMA user_version = 5`）

| 表 | 主键 | 主要内容 | 用途 |
|---|---|---|---|
| `meta` | key | builtAt / root / indexSchemaVersion / fileCount / entityCount | 索引元信息（`builtAt` 只作诊断，**不作新鲜度判据**，见下） |
| `files` | path | dir / kind / size / mtime | 全量文件清单，**同时是新鲜度对拍基线** |
| `entities` | (kind, id) | path / title / name_key / category / parent / order_index / status / keywords / aliases | 跨类统一投影：九分类树、跨类 id 冲突、提及定位（X-1） |
| `entities_fts` | (virtual) | entity_key / title / aliases / keywords，`tokenize='trigram'` | 全实体检索（X-3）；1–2 字走 `LIKE` 兜底 |
| `chapters` | id | path / seq / title / volume / status / word_count | 章列表、字数统计 |
| `characters` | id | path / name / name_key / group_name / role / pov / first_appearance / aliases / voice | 角色查询、重名校验、角色卡（#25） |
| `character_states` | `<cardId>#<chapter>` | path / character_id / chapter / status | 「第 N 章时他在什么状态」（#25） |
| `world_entries` | id | path / title / category / parent / keywords / always / priority | 世界观树、世界书关键词（#26） |
| `outline_nodes` | id | path / kind / title / parent / order_index / plot_point_count / plot_points | 大纲树与不变量校验；`plot_points` 是解析后的正文列表项（JSON `[{text, arc?}]`） |
| `relations` | id | path / title / relation_kind / source / target / direction / since / until / chapter | 关系图谱查询与校验（#27） |
| `timeline_events` | id | path / title / world_time / narrative_order / chapter / participants / status | 双轴排序、待确认区、冲突检测（#28） |
| `library_files` | path | size / mtime | 资料登记 |
| `validation_issues` | seq | code / path / detail | 重建时发现的不变量问题 |
| `chapters_fts` | (virtual) | chapter_id / title / body，`tokenize='trigram'` | 章正文全文检索（≥3 字命中；1–2 字走 `LIKE` 兜底） |

**表归谁建（X-2）**：`chapters`/`chapters_fts`、`characters`、`world_entries`、`outline_nodes` 由各自的域模块提供 DDL 与写入（[`src/host/domains/`](../../src/host/domains/)）；`meta`、`files`、`library_files`、`validation_issues`、`entities`、`entities_fts` 由索引构建与接缝层提供。没有一张表在两处创建。

**`entities` 主键是复合的 `(kind, id)`，不是单列 `id`**：不同内容目录是不同表、各有自己的主键，所以两个 kind 可以合法地共用一个 id —— 这种冲突由 I-04 报 `DUPLICATE_ID`，**两行都保留**（`(kind, id)` 足以表示）。单列主键会把这种既有合法状态判成不可表示。

**`files` 是新鲜度的对拍基线**（`checkIndexFreshness`，契约见 [conventions.md §4.0](conventions.md)）：

- 每行 `(path, size, mtime)` 描述建库那一刻该文件的字节数与 mtime；`mtime` 与磁盘 `stat.mtime.toISOString()` **同源同精度**（毫秒），因此比较是字符串相等，不需要额外列，也不需要改 schema。
- 对拍方式：一次 `readdir`+`stat`（与建索引同一个 `walkProjectFiles`）得到磁盘视图，与 `files` 全表比对 → 新增 / 删除 / `size` 变 / `mtime` 变 都算 `stale`。**不读文件内容、不算 hash**，所以 3000 文件量级仍是几十毫秒。
- 为什么 `meta.builtAt` 不够：删文件不会抬高任何 mtime，一删一增的「等量替换」也骗得过时间戳。`builtAt` 仅用于诊断输出。
- 索引 schema 不变（仍是 `user_version = 1`）：加入新鲜度不需要新列。若将来把内容 hash 也存进 `files`（用于「同 size 同 mtime 但内容被替换」这种极端情形），那是一次 `INDEX_SCHEMA_VERSION` 递增 + 删库重建，不写 ALTER。

- 版本不符 → **删库重建**，不做 `ALTER`。
- 重建：清空 → 全量扫描 → 事务写入 → 校验；`index/` 里除 `.gitkeep` 外全部是派生物。
- 中文检索实测：SQLite 3.53.4 + FTS5 `trigram`，3 字命中、2 字不命中（证据在对应 PR 评论，不入库）。
- `chapters_fts.body` 存的是 `parseMarkdown` 的 `body`，**frontmatter 已剥离**：检索片段因此不可能带出 `id` / `status` / 备注等元数据。
- 检索契约（`searchChapters` / `inkflow_chapter_search`，边界与错误码见 [conventions.md §4.1](conventions.md)）：
  - **2 字边界**：trigram 以 3 字为一个 token，1–2 字查询 `MATCH` 返回 0 行且不报错，因此 1–2 字（或含短词的组合查询）走 `body LIKE '%q%'`，按 `seq` / 文件排序；≥3 字走 `MATCH`，按 `rank`（bm25）排序。
  - 查询按 FTS5 短语转义（内部 `"` → `""`），`-` `*` `OR` `NEAR(` 都当字面文本；LIKE 分支转义 `%` `_` `\`。
  - 短片段取命中词前后各 40 字（连续空白折叠），**不返回命中偏移的字符位置**；`chapterId` 是 `chapters.id`，`file` 是项目内相对路径。
  - 索引缺失 / `user_version` 不符 → `INDEX_UNAVAILABLE`（读路径零写盘）；重建只由 `ensureIndex` 决定并执行一次（[conventions.md §4.0](conventions.md)）。

### 4.2 v2 里尚未落地的表

`entities`、`entities_fts` 与四个既有域表已在 §4.1 落地；下表是 v2 剩余部分，尚未实现。

| 表 | 用途 | 状态 |
|---|---|---|
| `foreshadowings` | 状态机查询、超期列表 | 未实现（#31） |
| `timeline_events` | 双轴排序、待确认区 | 未实现（#28） |
| `relations` | 关系图谱查询、孤立/冲突校验 | 未实现（#27） |
| `facts` | 账本跨章查询 | 未实现（#32） |
| `entity_mentions` | 别名/名称正文扫描、影响面、掉线检测（`entity_key` = `kind:id` 指向 `entities`） | 未实现（#29） |
| `chapters_catalog` | catalog 与 `.md` 一致性快照 | 未实现（#15 已交付 catalog 的读写与校验，未建快照表） |
| `semantic_blocks` | OVK 块的本地定位副本（uri → 章/字符区间） | 未实现（#41） |

**v3 = v2 + `outline_nodes` 两列**（`plot_point_count` / `plot_points`）**+ `world_entries` 三列**（`keywords` / `always` / `priority`）；**v4 = v3 + `characters` 四列**（`pov` / `first_appearance` / `aliases` / `voice`）**+ `character_states` 表**。**新增表或列都不写 `ALTER`**：`INDEX_SCHEMA_VERSION` 递增即删库重建（ADR-0005）。每个域单在自己的 `schema()` 里声明表，索引只执行注册表（roadmap §2.1 X-2）。

## 5. 不变量与强制手段

不变量靠「写入校验（工具侧）+ 重建校验（索引侧）」双重保障；每条都必须在重建校验里有对应 code，作为「代码没兜住」的第二道网。

| # | 不变量 | 写入时 | 重建时 code |
|---|---|---|---|
| I-01 | 每项目恰 1 条 `overall` 大纲 | 拒绝第二份 | `OUTLINE_NO_OVERALL` / `OUTLINE_MULTIPLE_OVERALL` |
| I-02 | 卷大纲必须挂 overall；禁止卷中卷；**三层为上限**（`chapter` 可挂 overall 或 volume，不可挂 chapter） | 拒绝 | `OUTLINE_VOLUME_PARENT` / `OUTLINE_VOLUME_IN_VOLUME` / `OUTLINE_CHAPTER_IN_CHAPTER` |
| I-03 | 角色名项目内唯一（归一化） | 拒绝 | `CHARACTER_NAME_DUPLICATE` |
| I-04 | 同一 kind 内 id 唯一（域表主键）；**跨 kind 同 id 只报不丢**（不同表各有主键，投影的 `(kind, id)` 可表示） | 重建时保留首个并报 issue；写入时同 kind 拒绝（#24 接上写入侧后生效） | `DUPLICATE_ID` |
| I-05 | `parent` 必须指向存在条目 | 拒绝 | `DANGLING_PARENT` |
| I-06 | 章状态取值合法 | 拒绝 | 非法值降级为 `draft`（不阻断） |
| I-07 | 正文文件必须是 `.md` | 拒绝 | `CHAPTER_NOT_MARKDOWN` |
| I-08 | 树/图引用完整：世界观根唯一、非根必须有 `parent` + `category`；**扁平分类书**（全部条目在 `world/<category>/` 且都不写 `parent`）允许无根；关系两端各恰一个实体且都存在 | 拒绝 | `WORLD_ROOT_MISSING` / `WORLD_ROOT_MULTIPLE` / `WORLD_CATEGORY_REQUIRED`；`RELATION_ENDPOINT` / `RELATION_SELF_LOOP` / `RELATION_DUPLICATE`（#27 落地） |
| I-09 | 伏笔 `resolved: true` 必须带 `resolvedChapter` | 拒绝 | `FORESHADOW_RESOLVED_WITHOUT_CHAPTER` |
| I-10 | frontmatter / JSON 可解析 | 写入前序列化 | `FRONTMATTER_ISSUE` |
| I-11 | catalog 与 `.md` 一致（结构投影不漂移） | 写入时重建受影响的 catalog | `CATALOG_STALE` |
| I-12 | 同一章不得同时出现在两个卷或两条 catalog 项 | 拒绝 | `CATALOG_DUPLICATE` |
| I-13 | 卷目录名与 `volumeId` / 卷大纲一致 | 拒绝 | `VOLUME_DIR_MISMATCH` |
| I-14 | catalog 引用的章文件必须存在 | 拒绝 | `CHAPTER_FILE_MISSING` |
| I-15 | `entities` 投影与各域表同源：同一行事实在两张表里的 `id` / `path` / `title` / `name_key` 必须一致（由同一次 scan、同一事务产出；投影主键为 `(kind, id)`） | 同一 scan 产出，无独立写入 | `ENTITIES_DRIFT` |

**与旧设计的差异**：不再有 FK / CHECK / 触发器；UNIQUE 只对「索引内可判定的键」有效。I-11–I-14 由 `src/host/catalog.ts` 的 `validateCatalog` 在 catalog 层与非阻塞方式报告（写入侧工具在级联时重建、把 `SEQ_CONFLICT` / `VOLUME_EXISTS` 前移到拒绝）。

## 6. 2.0 同步为什么更容易了

旧设计需要 outbox / 版本向量 / tombstone 才能同步（SQLite 变更不可读）。文件真相下：

| 旧需求 | 文件方案 |
|---|---|
| change_log 表 | `git log`（自带 author/time/diff） |
| tombstone 防复活 | git 删除提交（可 revert） |
| 冲突检测 | git merge 冲突（同一文件） |
| 增量传输 | 传输 commit 范围 / 文件 diff |
| 备份 | 每书一个 git remote |

因此 2.0 服务端只需「git 远端 / 对象存储 + 认证」，不需要自定义变更日志协议。

## 7. 未实现清单（数据层）

| 契约 | 现状 | 归属 |
|---|---|---|
| 索引 v2（伏笔/时间线/关系/账本/提及/全实体 FTS） | 未落地 | #22 / #23 |
| 故事线 / 场景契约 / 角色分组独立文件 | 未落地 | 对应功能 issue |
| 共享库与 `origin` 溯源 | 未落地 | #40 |
| OVK 语义块与 `semantic_blocks` | 未落地 | #41 |
| 伏笔/时间线/关系/账本的字段字典 | 本文已定；**尚无解析器与校验器** | #31 / #27 / #28 / #32 |
