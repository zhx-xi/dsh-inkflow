# dsh-inkflow 数据模型（SQLite · node:sqlite）

> **一句话**：SQLite 是唯一真相源；所有业务实体统一 `TEXT UUID` 主键 + `rev` / `device_id` / `deleted_at`，每次业务写在同一事务里追加 `change_log`；Markdown / JSON 只作为 git 备份导出物；同步能力用 `change_log` + `sync_state` 预留接口，第一阶段不实现服务端。

| 项 | 值 |
|---|---|
| 文档版本 | v0.1（P0 设计稿，待评审） |
| 日期 | 2026-10-21 |
| 作者 | docs-data（数据模型设计者） |
| 权威输入 | Lead 任务规格：22 个实体组 + 硬性设计约定 |
| 交付范围 | 仅本文件：表结构、不变量、索引、FTS、迁移、同步预留；不含实现代码 |
| 下游消费者 | 仓储层 / 迁移脚本 / FTS 检索 / 同步端口 / 测试 |
| 规模假设 | 单项目 ≤ 3000 章、≤ 2 万设定条目、≤ 2000 角色、≤ 5000 伏笔；单库 ≤ 5 GB；单进程单用户 |

## 目录

- [1. 范围、约束与来源](#1-范围约束与来源)
- [2. 全局约定](#2-全局约定)
- [3. 表总览](#3-表总览)
- [4. 核心创作域：项目 / 卷 / 章 / 大纲](#4-核心创作域项目--卷--章--大纲)
- [5. 设定域：分类 / 世界观树 / 世界书](#5-设定域分类--世界观树--世界书)
- [6. 角色域](#6-角色域)
- [7. 剧情与知识域](#7-剧情与知识域)
- [8. AI 工作流域](#8-ai-工作流域)
- [9. 辅助域：地图 / 设置](#9-辅助域地图--设置)
- [10. 同步预留：change_log / sync_state](#10-同步预留change_log--sync_state)
- [11. 全文检索（FTS5）](#11-全文检索fts5)
- [12. 不变量与强制手段矩阵](#12-不变量与强制手段矩阵)
- [13. 枚举字典](#13-枚举字典)
- [14. JSON 列清单](#14-json-列清单)
- [15. 索引清单](#15-索引清单)
- [16. 迁移与演化策略](#16-迁移与演化策略)
- [17. 旧 InkFlow 坑位对照](#17-旧-inkflow-坑位对照)
- [18. 【推断】清单](#18-推断清单)
- [19. 待拍板问题](#19-待拍板问题)
- [20. 验收清单](#20-验收清单)

## 标记约定

| 标记 | 含义 | 处理方式 |
|---|---|---|
| 【已定】 | Lead 任务规格 / 项目背景里明确要求，实现不得偏离 | 本文只做落地设计 |
| 【推断】 | 本文补充的设计选择，编号 `INF-xx` | 理由与替代方案集中在 [§18](#18-推断清单)，由 Lead 裁决 |
| （无标记） | 表内常规实现细节（列顺序、命名等），不构成独立设计决策 | 可随实现微调 |

> 标注粒度：一张表若整体只有一个来源，就在该节标题下统一标注一次；同一节混有【已定】与【推断】时逐条标注。**任何未被标为【已定】的数值、默认值、枚举扩展项，一律视为【推断】**。

## 决策摘要（一屏版）

| # | 决策 | 取值 | 标记 |
|---|---|---|---|
| D1 | 主键 | `TEXT` UUID v7，应用层生成 | 【已定：统一 id 策略】/【推断：选 v7】INF-01 |
| D2 | 时间格式 | `TEXT` ISO-8601 UTC 毫秒 `…Z`，只存 UTC | 【已定：仅存 UTC】/【推断：选 ISO 字符串】INF-02 |
| D3 | 版本与设备 | 所有业务表 `rev INTEGER` + `device_id TEXT` + `deleted_at TEXT` | 【已定】 |
| D4 | 删除 | 软删 `deleted_at`（tombstone 语义）+ `change_log.op='delete'`；硬删仅 purge | 【已定：tombstone】 |
| D5 | 项目内引用 | `(project_id, x_id)` 复合外键 → 父表 `UNIQUE(project_id, id)` | 【推断】INF-04 |
| D6 | 世界观根 | 每项目恰 1 条根；`id = projects.id`，由 `projects` 插入触发器创建，禁止删/迁根 | 【已定：每项目恰 1 根】/【推断：实现手法】INF-05 |
| D7 | 知识关系 | 8 类实体 × 源/目标 = 16 个可空类型化 FK + `CHECK` 恰一非空 + 生成列 `source_kind/source_id` | 【已定：禁止多态无 FK】/【推断：排布方式】INF-06 |
| D8 | JSON | `*_json` 列存 `TEXT`，`CHECK(json_valid(...))`；正文/大文本用普通 `TEXT` | 【已定】 |
| D9 | 索引 | 所有运行时索引显式 `CREATE INDEX`；软删表用 partial index | 【已定】 |
| D10 | 枚举 | 状态/类型一律 `CHECK` 约束，取值全列于 [§13](#13-枚举字典) | 【已定】 |
| D11 | FTS5 | 章节：独立 FTS 表 + 物化源表 `chapter_index`；世界书：external content 表 | 【已定：要 FTS5】/【推断：选型】INF-08 |
| D12 | 迁移 | `schema_migrations` + `PRAGMA user_version` 顺序迁移，DDL 幂等，禁止 `ensure_*` 补丁式 | 【已定】 |
| D13 | 同步 | `change_log`（append-only outbox）+ `sync_state`（游标）；第一阶段只落库不联网 | 【已定】 |
| D14 | 章节号 | 不落库；`seq_in_volume` + 卷序号由视图派生全书章号，删章不重排 | 【已定：需写明派生规则】/【推断：具体规则】INF-07 |

**目录说明**：本文所有 `sql` 代码块按出现顺序拼接即为初始迁移 `migrations/0001_init.sql` 的候选内容（第 1–11 节；第 13 节起为字典/清单，不是 DDL）。

---

## 1. 范围、约束与来源

### 1.1 覆盖范围（22 个实体组，全部落地）

projects(books)、volumes、chapters（含版本/草稿/状态）、outlines（overall/volume/chapter + plot_points + story_arcs）、world_settings（树 + 分类真 FK）、worldbook_entries、characters、character_groups、character_relations、character_voice、character_states、foreshadowings、timeline_events、knowledge_relations、facts_ledger、scene_contracts、proposals/revisions、audit_runs、extraction_staging、maps/map_pins、app_settings、change_log。

> 实体组与物理表不是 1:1（例如 `chapters` 组含 `chapter_versions`，`outlines` 组含 `outline_plot_points`/`story_arcs`）。**未新增业务实体**；新增的只有系统/字典/检索辅助表（`schema_migrations`、`entity_kinds`、`sync_state`、`chapter_index`、2 张 FTS 表），见 [§3.1](#31-实体组--物理表映射) 的显式说明。

### 1.2 明确不在本文件范围

| 项 | 说明 |
|---|---|
| 同步服务端 / HTTP 协议实现 | 只预留字段、表与端口形状（§10） |
| 导出文件格式细节 | 只约定"导出是真相源的派生物，不反向写库"（§10.5） |
| 检索 UI / 排序权重调参 | 只给 FTS 表结构与查询口径 |
| 多用户权限 / 账号体系 | 第一阶段本地单用户，不做 `user_id` |
| 旧 InkFlow 数据库迁移 | 只读参考；新库不导入旧数据（§17 只做坑位规避） |

### 1.3 技术约束（【已定】，来自项目背景）

| 约束 | 对设计的影响 |
|---|---|
| 存储用 `node:sqlite`（DSH 宿主 Node v24 内置），**不用 better-sqlite3** | 不依赖任何第三方扩展；只用 SQLite 原生能力（FK / CHECK / 生成列 / FTS5 / JSON1） |
| 纯 TypeScript | 无 ORM 代码生成；DDL 以 SQL 文本随插件分发 |
| SQLite 为真相源 | 所有写路径先写库再派生导出；导出失败不回滚业务写 |
| 第一阶段本地单用户 | 不做权限表；`device_id` 先用于同步预留与审计，不做鉴权 |
| 预留同步：`rev` / `updated_at` / `device_id` + `change_log` + tombstone | 见 §2.3、§10 |
| 已知旧库坑 | 见 §17，逐条有对应设计动作 |

### 1.4 规模假设（【推断】INF-16，用于索引取舍）

| 维度 | 假设上限 | 依据 |
|---|---|---|
| 单项目章节 | 3000 | 旧 InkFlow 单项目 520 章、蜀山 168 章；留一个量级余量 |
| 单项目设定/词条 | 20 000 | 蜀山实测世界观 439 + 知识关系 136；留足余量 |
| 单项目角色 | 2000 | 蜀山 60 角色 |
| 单项目伏笔 | 5000 | 蜀山 203 伏笔（3 章可产 27 条，长书会更多） |
| 正文总字数 | 2000 万字 | 3000 章 × 平均 6000 字 |
| 单库文件 | ≤ 5 GB | SQLite 单库舒适区；超过则按项目分库（不在本期） |
| 并发 | 单进程、少量连接 | DSH 插件内一个写连接 + 若干只读连接 |

> 该规模下"每表 2–4 个索引 + 复合外键唯一索引"的写放大可忽略，因此优先用 DB 级约束换正确性。

### 1.5 设计原则（【推断】INF-17）

1. **能进 DB 的约束不进应用层**：先在 FK / UNIQUE / CHECK / 触发器里能表达的全部表达，应用层只兜 DB 表达不了的（跨行、跨表计数、章节号派生）。
2. **可推导的字段不冗余存储**：章号、全书统计不落库；确需缓存的（`word_count`）标注"派生缓存，非真相源"。
3. **枚举集中**：所有枚举在 §13 一张表里可见，扩展必须走迁移。
4. **删除可恢复、可同步**：软删 + change_log，不做静默物理删除（purge 是显式维护命令）。
5. **单一写入协议**：仓储层统一负责 `rev+1` / `updated_at` / `device_id` / `change_log`，禁止业务代码各自拼 UPDATE。

---

## 2. 全局约定

### 2.1 主键与 ID 策略

| 项 | 决策 | 标记 |
|---|---|---|
| 主键类型 | `TEXT`，UUID v7 小写 36 字符（`8-4-4-4-12`） | 【已定：统一 TEXT UUID】/【推断：v7 而非 v4】INF-01 |
| 生成位置 | 应用层（TS）生成后写入；DB 不生成（SQLite 无 UUID 函数） | 【推断】 |
| 选 v7 理由 | 前缀含毫秒时间戳 → B-tree 插入局部性好、天然近似创建时间排序、导出/日志可读 | 【推断】 |
| 替代方案 | UUID v4：Node `crypto.randomUUID()` 内置零成本，但完全随机、索引分裂多，且无法按 id 近似排序 | 【推断】 |
| 例外（非 UUID） | `schema_migrations.version`（整数）、`entity_kinds.kind`（稳定文本键）、`sync_state.peer_id`（文本）、`change_log.seq`（`INTEGER PRIMARY KEY AUTOINCREMENT`）、`chapter_index.ci_id`（整数，给 FTS 做稳定 rowid） | 【推断】 |
| 根世界观条目 id | **复用所属项目的 id**（触发器里无法生成 UUID v7；根条目每项目恰 1 条，跨表复用安全） | 【推断】INF-05 |
| FTS 虚拟表 | 无业务主键；行身份通过 `content_rowid` / 物化源表映射 | — |
| 禁止 | `INTEGER AUTOINCREMENT` 作业务主键；用业务字段（章号/卷号/角色名）作主键 | 【推断】 |

### 2.2 时间格式（二选一：选 ISO-8601 UTC 字符串）

| 项 | 决策 | 标记 |
|---|---|---|
| 存储格式 | `TEXT`，ISO-8601 UTC 毫秒定长：`2026-10-21T06:04:22.123Z`（24 字符） | 【推断】INF-02 |
| 时区 | **只存 UTC**；显示层按用户时区转换 | 【已定：用户全局规范"仅存 UTC"】 |
| 默认值 | `DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))` | 【推断】 |
| 选择理由 | 定长 → 字典序 = 时间序，可直接 `BETWEEN`/`ORDER BY`；人读友好；与旧 InkFlow HTTP 端点 `Z` 后缀口径一致 | 【推断】 |
| 替代方案 | `INTEGER` epoch ms：更小更快，但可读性差、导出需转换、跨语言易误当秒 | 【推断】 |
| 写入方式 | 仓储层显式写 `updated_at`（不用 DB 触发器），保证与 `rev`/`device_id` 原子同步 | 【推断】 |
| 排序纪律 | 业务排序不依赖时间戳精度；同步/增量以 `change_log.seq` 为准，不以时间戳为准 | 【推断】 |

### 2.3 rev / device_id / 软删（tombstone）

| 列/机制 | 类型/取值 | 规则 | 标记 |
|---|---|---|---|
| `rev` | `INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1)` | 每次业务写 `rev = rev + 1`；乐观锁 `UPDATE … WHERE id=? AND rev=?`；冲突则重读后重试/合并 | 【已定：需要 rev】 |
| `device_id` | `TEXT NOT NULL` | 写入来源设备：首次启动生成 UUID v7 存 `app_settings`（`key='device_id'`）；同步 LWW 裁决用 `(updated_at, device_id)` 字典序 | 【已定：需要 device_id】/【推断：LWW 规则细节】INF-10 |
| `deleted_at` | `TEXT NULL`（UTC ISO） | 软删 = 置时间 + `rev+1` + change_log `op='delete'`（payload 存删前最后快照）；所有业务查询默认 `deleted_at IS NULL`；**所有唯一索引都带 `WHERE deleted_at IS NULL`** | 【已定：删除用 tombstone】/【推断：用列而非独立表】INF-03 |
| 软删 vs 唯一约束 | — | 软删后同名实体可重建（唯一索引只覆盖活跃行） | 【推断】 |
| 级联软删 | — | **软删不触发外键动作**（行还在）；项目软删时由应用层事务递归打 `deleted_at`（卷→章→版本…），或仅项目级软删、子表按 `project.deleted_at` 过滤（推荐后者，见 §4.1 说明） | 【推断】 |
| 硬删（purge） | — | 仅维护命令/测试：先软删项目，再 `DELETE FROM projects WHERE id=?`，FK `ON DELETE CASCADE` 清子表；根条目保护触发器在项目已软删时放行 | 【推断】INF-05 |

> **为什么不建独立 tombstone 表**：软删列让"读"保持单表过滤、可直接恢复；同步所需 tombstone 语义由 `change_log.op='delete'` 承载（对端拿到整行最后快照 + 删除时间即可重放）。独立 tombstone 表会让每次查询都多一次 anti-join，收益只在"主表不含删行"，本地单用户场景不成立。替代方案见 INF-03。

### 2.4 JSON 列约定

| 项 | 约定 | 标记 |
|---|---|---|
| 命名 | 后缀 `_json`（如 `settings_json`、`beats_json`） | 【推断】 |
| 存储 | `TEXT`（SQLite 无原生 JSON 类型）；默认 `'{}'` 或 `'[]'` | 【已定：JSON 大字段用 TEXT】 |
| 校验 | `CHECK (json_valid(col))`（可空列写 `col IS NULL OR json_valid(col)`） | 【推断】 |
| 索引 | 默认不建；确需查询的字段（标题、关键词、正文）落普通列，**不进 JSON** | 【推断】 |
| 大文本 | 章节正文、词条正文、Markdown 细纲、大纲内容用普通 `TEXT`，**不要包 JSON**（避免二次转义与 `length()` 失真） | 【推断】 |
| 版本 | 不引 JSONB/二进制格式；`json_extract` 可用但不作为查询主路径 | 【推断】 |

### 2.5 布尔与数值

| 类型 | 表示 | 示例 |
|---|---|---|
| 布尔 | `INTEGER NOT NULL DEFAULT 0 CHECK (col IN (0,1))` | `worldbook_entries.always`、`is_root` |
| 评分/权重 | `INTEGER` 0–100 或 1–5，带 `CHECK` | `priority`、`strength`、`importance`、`confidence` |
| 时间倍率 | `REAL > 0` | `timeline_events.era_scale` |
| 字数 | `INTEGER >= 0`（派生缓存时需注明） | `word_count` |

### 2.6 外键策略

| 策略 | 规则 | 标记 |
|---|---|---|
| 强制开启 | 每个连接执行 `PRAGMA foreign_keys = ON`（SQLite 默认 OFF，必须显式） | 【推断】 |
| `ON DELETE CASCADE` | 纯从属表：`chapter_versions`、`outline_plot_points`、`character_group_members`、`character_voice`、`character_states`、`map_pins`、`world_settings`（子树）、`outlines`（子节点） | 【推断】 |
| `ON DELETE RESTRICT` | 被引用的字典/分类（如 `world_setting_categories` 被世界观条目引用） | 【推断】 |
| `ON DELETE SET NULL` | 可空引用：章节引用（`first_appearance_chapter_id` 等）、`arc_id`、`audit_run_id` | 【推断】 |
| **同项目复合外键**（本项目特有） | 子表引用父表时写 `(project_id, x_id) REFERENCES 父表(project_id, id)`，父表声明 `UNIQUE(project_id, id)`。子列 NULL 时（MATCH SIMPLE）不校验，因此可空外键天然兼容 | 【推断】INF-04 |
| 复合外键的收益 | 从 DB 层杜绝"跨项目引用"（旧库 `project_id` int 代理键 + 软删留下 32/106 僵尸项目，跨项目脏引用难查） | 【推断】 |
| 复合外键的代价 | 每个父表多一个 `(project_id, id)` 唯一索引；本规模下写放大可忽略 | 【推断】 |
| 少数例外 | 不带 `project_id` 的派生表（`chapter_versions`）或被全局 id 引用的表（`proposals`/`revisions`/`audit_runs` 的部分引用）用单列 FK，项目一致性由应用层校验并在代码评审 checklist 里列明 | 【推断】 |

### 2.7 索引策略

| 规则 | 说明 | 标记 |
|---|---|---|
| 显式建索引 | SQLite 只为 PK / UNIQUE 自动建索引，**FK 子列不会自动建**；所有运行时需要的索引必须写 `CREATE INDEX` | 【已定】 |
| 软删表 | 一律 partial index：`… WHERE deleted_at IS NULL`；查询也必须带同样条件才能命中 | 【推断】 |
| 列序 | 等值列在前、范围/排序列在后；项目级列表用 `(project_id, status, updated_at)` | 【推断】 |
| 数量控制 | 业务表 ≤ 4 个普通索引；追加日志表只建 2–3 个 | 【推断】 |
| `ANALYZE` | 每次迁移后 + 关闭连接前 `PRAGMA optimize`；测试里跑 `ANALYZE` | 【推断】 |

### 2.8 命名规范

| 对象 | 前缀/风格 | 示例 |
|---|---|---|
| 表 | 小写复数 snake_case | `worldbook_entries` |
| 列 | 小写 snake_case；JSON 后缀 `_json`；bool `is_*`/动词 | `is_root`、`metadata_json` |
| 普通索引 | `ix_` | `ix_chapters_project_status` |
| 唯一索引 | `ux_` | `ux_characters_project_name` |
| 触发器 | `trg_` | `trg_projects_insert_root` |
| 视图 | `v_` | `v_chapter_numbering` |
| FTS / 检索辅助 | `fts_` / `*_index` | `fts_chapters`、`chapter_index` |

### 2.9 PRAGMA / 连接配置

| PRAGMA | 值 | 理由 |
|---|---|---|
| `journal_mode` | `WAL` | 读写不互斥、崩溃恢复好；导出/备份时读不阻塞写 |
| `foreign_keys` | `ON` | 强制外键（每次连接都要设） |
| `synchronous` | `NORMAL` | WAL 下性能/耐久平衡（本地单机可接受掉电丢最后若干秒） |
| `busy_timeout` | `5000` | 宿主并发连接时等待而非立刻 `SQLITE_BUSY` |
| `temp_store` | `MEMORY` | 临时排序/索引在内存 |
| `cache_size` | `-16000`（≈16 MB） | 本地库足够 |
| `wal_autocheckpoint` | `1000`（默认） | 配合导出进程避免 WAL 无限增长 |
| `recursive_triggers` | `OFF`（默认） | 本设计的触发器不依赖递归；保持默认避免意外级联 |
| 迁移后 | `PRAGMA foreign_key_check; PRAGMA integrity_check;` | 迁移门禁 |

### 2.10 启动能力探针（迁移前必跑）

| 能力 | 探针 | 实测结果（2026-10-21，见 `docs/tech-spike.md` §5） | 失败处理 |
|---|---|---|---|
| SQLite 版本 | `SELECT sqlite_version()` | **宿主 `node:sqlite` = 3.53.4**（DSH 自带 Node v24.21.0）；开发机 Node v24.16.0 = 3.53.0。要求 ≥ 3.40 | 低于 3.40 拒绝启动 |
| JSON1 | `SELECT json_valid('{}')` 返回 1 | **可用**（`CHECK (json_valid(...))` 全量成立） | 拒绝启动 |
| 生成列 | `CREATE TABLE t(a INT, b INT GENERATED ALWAYS AS (a*2) STORED)` | **`GENERATED ALWAYS AS … VIRTUAL` 实测可用**；`STORED` 自 SQLite 3.31 起支持，宿主 3.53.4 满足（实现时仍按本条探针验证） | 拒绝启动（`knowledge_relations` 依赖） |
| FTS5 + trigram | `CREATE VIRTUAL TABLE temp.f USING fts5(x, tokenize='trigram')` | **可用**；3 字词命中、2 字词不命中；默认 `unicode61` 中文按整段切词不命中 → 中文必须 trigram（§11.1 的 2 字限制已实测确认） | 降级：关闭 FTS，检索退化为 `LIKE`，记 `capabilities.fts5=false` |
| 复合外键 `(a,b) REFERENCES p(a,b)` | 建父表 `UNIQUE(a,b)` + 子表复合 FK，插入跨项目行应被拒 | **真实生效**（INF-04 的复合外键方案已验证） | 拒绝启动（大量同项目校验依赖） |
| 部分索引 | `CREATE UNIQUE INDEX … WHERE deleted_at IS NULL` | **可用**（软删 + 唯一约束方案成立） | 拒绝启动 |
| 外键强制 | `PRAGMA foreign_keys` 返回 1 | 可用（连接级开关，每次连接必须设置） | 拒绝启动 |

> 结论：宿主 SQLite **3.53.4 已实测**满足本文全部依赖（JSON1 / 生成列 / 复合外键 / 部分索引 / FTS5 trigram）。开发机 3.53.0 与宿主 3.53.4 小版本不同，涉及 SQLite 行为的结论**以宿主为准**（证据：`docs/tech-spike.md` §5）。FTS 仍按可降级模块设计，探针失败时退回 `LIKE`。

### 2.11 追加型表的例外（【推断】INF-09）

`change_log`、`revisions` 是审计/同步日志，**不设** `updated_at` / `rev` / `deleted_at`：

| 表 | 允许 | 禁止 | 理由 |
|---|---|---|---|
| `change_log` | INSERT；按保留期 DELETE | UPDATE（触发器 `RAISE(ABORT)`） | 篡改日志会破坏同步幂等与审计链 |
| `revisions` | INSERT | UPDATE（触发器 `RAISE(ABORT)`） | 修订历史必须不可变 |

其余所有业务表统一带 `rev` / `updated_at` / `device_id` / `deleted_at`，无例外。

---

## 3. 表总览

### 3.1 实体组 → 物理表映射

| # | 实体组（Lead 清单） | 物理表 | 说明 |
|---|---|---|---|
| 1 | projects(books) | `projects` | 作品/项目根 |
| 2 | volumes | `volumes` | 卷 |
| 3 | chapters（含版本/草稿/状态） | `chapters`、`chapter_versions` | 章元数据 + 正文版本（草稿/定稿） |
| 4 | outlines（overall/volume/chapter + plot_points + story_arcs） | `outlines`、`outline_plot_points`、`story_arcs` | 大纲树 + 情节点 + 故事线 |
| 5 | world_settings（树 + category 真 FK） | `world_setting_categories`、`world_settings` | 分类字典 + 世界观树 |
| 6 | worldbook_entries | `worldbook_entries` | 世界书/词条/触发注入 |
| 7 | characters | `characters` | 角色 |
| 8 | character_groups | `character_groups`、`character_group_members` | 分组树 + 成员关系 |
| 9 | character_relations | `character_relations` | 角色间关系边 |
| 10 | character_voice（语言基因） | `character_voice` | 1:1 语言基因 |
| 11 | character_states | `character_states` | 按章时点快照 |
| 12 | foreshadowings | `foreshadowings` | 伏笔 |
| 13 | timeline_events | `timeline_events` | 时间线事件 |
| 14 | knowledge_relations | `knowledge_relations` | 类型化知识图谱边 |
| 15 | facts_ledger | `facts_ledger` | 事实账本（设定一致性判定用） |
| 16 | scene_contracts | `scene_contracts` | 场景契约（写作前置约束） |
| 17 | proposals/revisions | `proposals`、`revisions` | AI/人工提议 + 修订历史 |
| 18 | audit_runs | `audit_runs` | 审计/一致性检查运行记录 |
| 19 | extraction_staging | `extraction_staging` | 抽取暂存区（待人工采纳） |
| 20 | maps/map_pins | `maps`、`map_pins` | 地图 + 图钉 |
| 21 | app_settings | `app_settings` | 应用/项目级键值设置 |
| 22 | change_log | `change_log` | 变更日志（outbox） |

**辅助表（非业务实体，新增）**：`schema_migrations`（迁移版本）、`entity_kinds`（跨表多态 kind 字典）、`sync_state`（同步游标）、`chapter_index`（章节 FTS 物化检索源）、`fts_chapters`、`fts_worldbook_entries`（FTS5 虚拟表）。

> 合计 **35 张物理表**（含 2 张 FTS5 虚拟表、4 张辅助表）+ **2 个视图**。

### 3.2 表清单

| 表 | 域 | 用途（一句话） | 追加型 |
|---|---|---|---|
| `schema_migrations` | 系统 | 迁移版本与校验和 | 是 |
| `entity_kinds` | 系统 | 跨表 `target_kind`/`entity_kind` 的合法取值字典 | — |
| `projects` | 核心 | 作品/项目根，一切数据的归属 | — |
| `volumes` | 核心 | 卷（书名下的分卷） | — |
| `chapters` | 核心 | 章元数据（卷归属、卷内序号、工作流状态、当前版本指针） | — |
| `chapter_versions` | 核心 | 章节正文版本（草稿/候选/定稿/被取代） | — |
| `outlines` | 核心 | 大纲树节点（整体/卷/章） | — |
| `outline_plot_points` | 核心 | 大纲节点下的情节点（有序） | — |
| `story_arcs` | 核心 | 故事线（主线/支线/感情线等） | — |
| `world_setting_categories` | 设定 | 世界观条目分类字典（真 FK 目标） | — |
| `world_settings` | 设定 | 世界观树（根 + 分类 + 父节点） | — |
| `worldbook_entries` | 设定 | 世界书/词条（关键词、优先级、always、触发注入） | — |
| `characters` | 角色 | 角色主档 | — |
| `character_groups` | 角色 | 角色分组树（门派/家族/小队） | — |
| `character_group_members` | 角色 | 角色-分组多对多成员关系 | — |
| `character_relations` | 角色 | 角色间关系边 | — |
| `character_voice` | 角色 | 语言基因（语气/口头禅/禁忌词/台词样本） | — |
| `character_states` | 角色 | 角色在指定章时点的状态快照 | — |
| `foreshadowings` | 剧情 | 伏笔（埋设/强化/回收） | — |
| `timeline_events` | 剧情 | 时间线事件（纪元/倍率/刻度/叙事位） | — |
| `knowledge_relations` | 剧情 | 类型化知识图谱边（源/目标各恰一实体） | — |
| `facts_ledger` | 剧情 | 事实账本（抽取出的可判定事实） | — |
| `scene_contracts` | 剧情 | 场景契约（目标/参与者/约束/验收） | — |
| `proposals` | AI | AI/审计/用户提议的变更（待采纳） | — |
| `revisions` | AI | 已发生修订的不可变历史 | 是 |
| `audit_runs` | AI | 审计运行记录（findings/metrics） | — |
| `extraction_staging` | AI | 抽取结果暂存（人工采纳/拒绝） | — |
| `maps` | 辅助 | 地图 | — |
| `map_pins` | 辅助 | 地图图钉（可绑设定/角色/章节/伏笔） | — |
| `app_settings` | 辅助 | 应用级/项目级键值设置 | — |
| `change_log` | 同步 | 变更日志（append-only outbox） | 是 |
| `sync_state` | 同步 | 各同步对端游标 | — |
| `chapter_index` | 检索 | 章节 FTS 物化检索源（稳定 rowid + 当前正文） | — |
| `fts_chapters` | 检索 | 章节标题/正文全文索引（FTS5） | — |
| `fts_worldbook_entries` | 检索 | 世界书标题/关键词/正文全文索引（FTS5） | — |

### 3.3 视图

| 视图 | 用途 |
|---|---|
| `v_chapter_numbering` | 派生全书章号（`ROW_NUMBER()` 按卷序 + 卷内序号），并给出默认显示标题 |
| `v_active_projects` | 未删项目 + 卷/章/字数汇总（替代把统计冗余进主表） |

### 3.4 DDL 执行顺序（迁移 0001 内部）

1. `PRAGMA`（仅连接级，由 runner 执行，不写进迁移文件）→ 2. 系统表（`schema_migrations` / `entity_kinds` + 字典种子）→ 3. 核心表（`projects` / `volumes` / `chapters` / `chapter_versions` / `outlines` / `outline_plot_points` / `story_arcs`）→ 4. 设定表 → 5. 角色表 → 6. 剧情/知识表 → 7. AI 工作表 → 8. 辅助表 → 9. 同步表 → 10. FTS 物化表 + FTS 虚拟表 + 触发器 → 11. 视图 → 12. 索引（各节随表给出，按出现顺序）→ 13. `PRAGMA foreign_key_check` / `integrity_check`。

> SQLite 允许 `CREATE TABLE` 里引用尚未创建的表（外键在 DML 时解析），因此正文按"表 → 索引 → 触发器"分段即可；FTS 触发器统一放在 §11，避免章节正文两个来源表的触发器与建表顺序纠缠。

### 3.5 系统表与视图 DDL

**`entity_kinds`**：`proposals` / `revisions` / `audit_runs` / `extraction_staging` 的 `target_kind` / `entity_kind` 外键目标（跨表多态 `kind` 的统一字典），必须先于这些表创建。**`v_active_projects`**：项目列表页的聚合视图（统计替代把计数冗余进主表）。

```sql
-- ===== 3.5 entity_kinds（跨表 kind 字典）=====
CREATE TABLE IF NOT EXISTS entity_kinds (
  kind        TEXT PRIMARY KEY CHECK (kind IN (
    'project','volume','chapter','chapter_version','outline','plot_point','story_arc',
    'world_setting_category','world_setting','worldbook_entry',
    'character','character_group','character_relation','character_voice','character_state',
    'foreshadowing','timeline_event','knowledge_relation','fact','scene_contract',
    'map','map_pin','proposal','app_setting'
  )),
  description TEXT NOT NULL DEFAULT ''
);

INSERT OR IGNORE INTO entity_kinds(kind, description) VALUES
  ('project','项目/作品'),
  ('volume','卷'),
  ('chapter','章'),
  ('chapter_version','章节正文版本'),
  ('outline','大纲节点'),
  ('plot_point','情节点'),
  ('story_arc','故事线'),
  ('world_setting_category','世界观分类'),
  ('world_setting','世界观条目'),
  ('worldbook_entry','世界书/词条'),
  ('character','角色'),
  ('character_group','角色分组'),
  ('character_relation','角色关系'),
  ('character_voice','语言基因'),
  ('character_state','角色状态快照'),
  ('foreshadowing','伏笔'),
  ('timeline_event','时间线事件'),
  ('knowledge_relation','知识关系'),
  ('fact','事实'),
  ('scene_contract','场景契约'),
  ('map','地图'),
  ('map_pin','地图图钉'),
  ('proposal','变更提议'),
  ('app_setting','应用/项目设置');

-- ===== 3.5 v_active_projects（活跃项目 + 汇总）=====
CREATE VIEW IF NOT EXISTS v_active_projects AS
SELECT
  p.id,
  p.name,
  p.genre,
  p.status,
  (SELECT COUNT(*) FROM volumes v
    WHERE v.project_id = p.id AND v.deleted_at IS NULL)                AS volume_count,
  (SELECT COUNT(*) FROM chapters c
    WHERE c.project_id = p.id AND c.deleted_at IS NULL)                AS chapter_count,
  (SELECT COALESCE(SUM(c.word_count), 0) FROM chapters c
    WHERE c.project_id = p.id AND c.deleted_at IS NULL)                AS word_count,
  p.created_at,
  p.updated_at,
  p.rev,
  p.device_id
FROM projects p
WHERE p.deleted_at IS NULL;
```

> 说明：`v_active_projects` 的统计依赖 `chapters.word_count`（派生缓存，§4.3.1）；若缓存未及时刷新，视图数字会滞后，但不会写错数据。需要对账时用 `length(content)` 重算（§20.3）。

---

## 4. 核心创作域：项目 / 卷 / 章 / 大纲

> 本节所有表：`rev` / `updated_at` / `device_id` / `deleted_at` 为统一列（§2.3），列定义表中不再逐一解释，只在有特殊语义时说明。
> 本节设计来源：表与字段【已定】（Lead 实体清单）；具体列与约束【推断】（INF-04 / INF-07 / INF-12）。

### 4.1 projects（作品/项目）

**用途**：一切数据的归属根；项目状态（启停/归档）与写作级配置。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `name` | TEXT | NOT NULL，`CHECK (length(trim(name)) > 0)` | 书名；**不强制项目内唯一**（作者可建同名试验稿）【推断】 |
| `genre` | TEXT | NOT NULL DEFAULT `''` | 体裁自由文本（如「武侠+仙侠」），不设枚举，避免限死混类【推断】 |
| `status` | TEXT | NOT NULL DEFAULT `'active'`，`CHECK IN ('active','archived')` | 归档 ≠ 删除；归档项目默认不出现在最近列表 |
| `summary` | TEXT | NOT NULL DEFAULT `''` | 一句话简介 |
| `author_note` | TEXT | NOT NULL DEFAULT `''` | 作者备忘（不进上下文） |
| `settings_json` | TEXT | NOT NULL DEFAULT `'{}'`，`CHECK json_valid` | **JSON**：写作参数（默认字数、文风、禁词表、默认管线、模型覆盖） |
| `cover_ref` | TEXT | NULL | 封面图片相对路径（不存 BLOB）【推断】 |
| `created_at` / `updated_at` | TEXT | NOT NULL，UTC ISO-8601 默认 now | §2.2 |
| `rev` | INTEGER | NOT NULL DEFAULT 1，`CHECK >= 1` | §2.3 |
| `device_id` | TEXT | NOT NULL | §2.3 |
| `deleted_at` | TEXT | NULL | 软删时间；项目软删**只写这一列** |

**索引**

| 索引 | 列 | 用途 |
|---|---|---|
| `ix_projects_status` | `(status, updated_at) WHERE deleted_at IS NULL` | 项目列表（活跃在前，按最近更新） |

**外键**：无（根表）。

```sql
-- ===== 4.1 projects =====
CREATE TABLE IF NOT EXISTS projects (
  id            TEXT    PRIMARY KEY,
  name          TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  genre         TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  summary       TEXT    NOT NULL DEFAULT '',
  author_note   TEXT    NOT NULL DEFAULT '',
  settings_json TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(settings_json)),
  cover_ref     TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev           INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id     TEXT    NOT NULL,
  deleted_at    TEXT
);
CREATE INDEX IF NOT EXISTS ix_projects_status
  ON projects(status, updated_at) WHERE deleted_at IS NULL;
```

**项目软删规则（【推断】INF-03）**：软删项目**只写 `projects.deleted_at`**（O(1)，可瞬间恢复），子表不打标。所有读取入口（仓储层）统一以 `JOIN projects p ON p.id = x.project_id AND p.deleted_at IS NULL` 过滤；`v_active_projects` 视图供列表页使用。代价：单表直查（如按 `chapter_id` 读取）也必须经过仓储层的项目态校验，代码评审需检查。

### 4.2 volumes（卷）

**用途**：作品的分卷；卷序号决定全书章号的排序。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `index_no` | INTEGER | NOT NULL，`CHECK >= 1` | 卷序号（项目内唯一、建议连续） |
| `title` | TEXT | NOT NULL，`CHECK (length(trim(title)) > 0)` | 卷名 |
| `subtitle` | TEXT | NOT NULL DEFAULT `''` | 副标题/卷题记 |
| `summary` | TEXT | NOT NULL DEFAULT `''` | 卷简介（进上下文） |
| `word_target` | INTEGER | NULL，`CHECK > 0` | 目标字数 |
| `status` | TEXT | NOT NULL DEFAULT `'planned'`，`CHECK IN ('planned','writing','done','archived')` | 卷状态 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**索引**

| 索引 | 列 | 用途 |
|---|---|---|
| `UNIQUE (project_id, id)`（表内约束） | — | 供子表复合外键 `(project_id, volume_id)` 引用（INF-04） |
| `ux_volumes_project_index` | `(project_id, index_no) WHERE deleted_at IS NULL` | 卷序唯一 + 卷列表 |

**外键**：`project_id → projects(id) ON DELETE CASCADE`。

**卷序调整**：`index_no` 有唯一约束，交换两卷序号不能直接 UPDATE。规则【推断】：事务内先全项目 `index_no = index_no + 1000`（腾出空档），再按目标顺序重赋 1..N；重排同时 `rev+1` 并逐卷写 `change_log`。

```sql
-- ===== 4.2 volumes =====
CREATE TABLE IF NOT EXISTS volumes (
  id          TEXT    PRIMARY KEY,
  project_id  TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  index_no    INTEGER NOT NULL CHECK (index_no >= 1),
  title       TEXT    NOT NULL CHECK (length(trim(title)) > 0),
  subtitle    TEXT    NOT NULL DEFAULT '',
  summary     TEXT    NOT NULL DEFAULT '',
  word_target INTEGER CHECK (word_target IS NULL OR word_target > 0),
  status      TEXT    NOT NULL DEFAULT 'planned'
                     CHECK (status IN ('planned','writing','done','archived')),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev         INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id   TEXT    NOT NULL,
  deleted_at  TEXT,
  UNIQUE (project_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_volumes_project_index
  ON volumes(project_id, index_no) WHERE deleted_at IS NULL;
```

### 4.3 chapters（章）与 chapter_versions（正文版本）

**用途**：`chapters` 存章元数据与工作流状态；`chapter_versions` 存正文的每个版本（草稿/候选/定稿/被取代），正文唯一真相源在版本表。

#### 4.3.1 chapters 列定义

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `volume_id` | TEXT | NOT NULL | 所属卷（复合 FK，见下） |
| `seq_in_volume` | INTEGER | NOT NULL，`CHECK >= 1` | **卷内序号**（1 起）；全书章号由视图派生（§4.3.3） |
| `title` | TEXT | NOT NULL，`CHECK (length(trim(title)) > 0)` | 章名 |
| `label` | TEXT | NULL，`CHECK (label IS NULL OR length(trim(label)) > 0)` | 显示号覆盖（如「楔子」「后记」） |
| `status` | TEXT | NOT NULL DEFAULT `'planned'`，`CHECK IN ('planned','drafting','review','final','published','archived')` | 章工作流状态（§4.3.2） |
| `current_version_id` | TEXT | NULL，FK→`chapter_versions(id)` `ON DELETE SET NULL` | 当前采用/展示的版本指针 |
| `word_count` | INTEGER | NOT NULL DEFAULT 0，`CHECK >= 0` | **派生缓存**（当前版本字数，非真相源） |
| `summary` | TEXT | NOT NULL DEFAULT `''` | 章摘要（可 AI 生成，供上下文压缩） |
| `notes` | TEXT | NOT NULL DEFAULT `''` | 作者备注 |
| `target_words` | INTEGER | NULL，`CHECK > 0` | 目标字数 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**约束**：`UNIQUE (project_id, id)`（供复合 FK）；`CHECK (label IS NULL OR length(trim(label)) > 0)`。

**索引**

| 索引 | 列 | 用途 |
|---|---|---|
| `ux_chapters_volume_seq` | `(volume_id, seq_in_volume) WHERE deleted_at IS NULL` | 卷内序号唯一 |
| `ix_chapters_project_status` | `(project_id, status, updated_at) WHERE deleted_at IS NULL` | 章列表 / 待处理列表 |
| `ix_chapters_current_version` | `(current_version_id) WHERE current_version_id IS NOT NULL` | 版本删除时定位引用（FK 子列显式索引） |

**外键**

| 外键 | 引用 | 删除行为 | 作用 |
|---|---|---|---|
| `project_id` | `projects(id)` | CASCADE | 项目硬删级联 |
| `(project_id, volume_id)` | `volumes(project_id, id)` | CASCADE | **同项目复合外键**：章不可能挂到别的项目的卷 |
| `current_version_id` | `chapter_versions(id)` | SET NULL | 版本硬删时摘指针 |

> 循环引用说明：`chapters.current_version_id` ↔ `chapter_versions.chapter_id` 是循环 FK，SQLite 允许建表顺序任意、DML 时解析。创建流程必须是「先 INSERT chapter（`current_version_id=NULL`）→ INSERT version → UPDATE chapter 指向版本」，三步在同一事务内。

```sql
-- ===== 4.3 chapters =====
CREATE TABLE IF NOT EXISTS chapters (
  id                 TEXT    PRIMARY KEY,
  project_id         TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  volume_id          TEXT    NOT NULL,
  seq_in_volume      INTEGER NOT NULL CHECK (seq_in_volume >= 1),
  title              TEXT    NOT NULL CHECK (length(trim(title)) > 0),
  label              TEXT    CHECK (label IS NULL OR length(trim(label)) > 0),
  status             TEXT    NOT NULL DEFAULT 'planned'
                     CHECK (status IN ('planned','drafting','review','final','published','archived')),
  current_version_id TEXT,
  word_count         INTEGER NOT NULL DEFAULT 0 CHECK (word_count >= 0),
  summary            TEXT    NOT NULL DEFAULT '',
  notes              TEXT    NOT NULL DEFAULT '',
  target_words       INTEGER CHECK (target_words IS NULL OR target_words > 0),
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev                INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id          TEXT    NOT NULL,
  deleted_at         TEXT,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, volume_id) REFERENCES volumes(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (current_version_id) REFERENCES chapter_versions(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_chapters_volume_seq
  ON chapters(volume_id, seq_in_volume) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_chapters_project_status
  ON chapters(project_id, status, updated_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_chapters_current_version
  ON chapters(current_version_id) WHERE current_version_id IS NOT NULL;
```

#### 4.3.2 章状态 × 版本状态（【推断】INF-12）

| 场景 | `chapters.status` | `chapter_versions.status` | `current_version_id` |
|---|---|---|---|
| 只有大纲、无正文 | `planned` | 无版本 | NULL |
| AI/人工写草稿中 | `drafting` | `draft`（可多版） | 指向当前草稿 |
| 提交待审 | `review` | `candidate` | 指向候选版 |
| 定稿但未发布 | `final` | `final`（旧版置 `superseded`） | 指向 final |
| 已发布/已导出 | `published` | `final` | 指向 final |
| 归档 | `archived` | 不变 | 不变 |

- 版本流转由仓储层在事务内完成：新版本 `INSERT` → 旧 `final` 改 `superseded` → 更新 `chapters.current_version_id` / `word_count` / `status`，每步 `rev+1` 并写 `change_log`。
- **不允许**直接 `DELETE` 版本；删除章节才级联删版本（硬删），软删章节保留版本以便恢复。

#### 4.3.3 章节号派生规则（【已定：必须写明】/【推断：规则内容】INF-07）

| 概念 | 定义 | 是否落库 |
|---|---|---|
| 卷序号 | `volumes.index_no`（项目内唯一，1 起） | 是 |
| 卷内章序 | `chapters.seq_in_volume`（卷内唯一，1 起） | 是 |
| **全书章号** | `ROW_NUMBER() OVER (ORDER BY v.index_no, c.seq_in_volume)`（仅未删章） | **否**（视图 `v_chapter_numbering` 派生） |
| 默认显示标题 | `label` 非空则用 `label`；否则 `第{全书章号}章`；卷内导航可与 `第{seq_in_volume}章` 组合显示 | 否（前端派生） |
| 删章 | 保留空号（如 1,2,4），**不自动重排**，避免正文/大纲/伏笔的引用因重排而漂移 | — |
| 重排（显式命令） | 事务内先 `seq_in_volume = seq_in_volume + 100000` 腾空档，再按目标顺序重赋 1..N；重排不动章 id | — |
| 草稿章占号 | 占号（`planned`/`drafting` 也参与编号），防止「写到一半发现号对不上」 | — |
| 未分卷 | **不允许**；`volume_id NOT NULL`，未分卷场景由应用层先建默认卷「第一卷」【推断】 | — |
| 跨卷章号 | 由卷序 + 卷内序共同决定；卷序调整后全书章号自动变化（视图重算） | — |

视图 DDL（与 §3.3 一致，末尾统一给出）：

```sql
CREATE VIEW IF NOT EXISTS v_chapter_numbering AS
SELECT
  c.project_id,
  c.volume_id,
  v.index_no            AS volume_no,
  c.id                  AS chapter_id,
  c.seq_in_volume,
  ROW_NUMBER() OVER (PARTITION BY c.project_id
                     ORDER BY v.index_no, c.seq_in_volume) AS global_no,
  COALESCE(c.label, '第' || ROW_NUMBER() OVER (PARTITION BY c.project_id
                                               ORDER BY v.index_no, c.seq_in_volume) || '章') AS display_title
FROM chapters c
JOIN volumes v ON v.id = c.volume_id AND v.deleted_at IS NULL
WHERE c.deleted_at IS NULL;
```

> `ROW_NUMBER()` 需要 SQLite ≥ 3.25（node:sqlite 满足）；窗口函数在视图里可用。**注意**：视图不保证排序，调用方需 `ORDER BY global_no`。

#### 4.3.4 chapter_versions 列定义

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `chapter_id` | TEXT | NOT NULL，FK→`chapters(id)` CASCADE | 所属章 |
| `version_no` | INTEGER | NOT NULL，`CHECK >= 1` | 章内版本号（1 起，单调增） |
| `content` | TEXT | NOT NULL DEFAULT `''` | 正文（Markdown）；**唯一真相源** |
| `content_sha256` | TEXT | NULL | 正文哈希（去重/同步快速比较用）【推断】 |
| `word_count` | INTEGER | NOT NULL DEFAULT 0，`CHECK >= 0` | 派生缓存（写 content 时同事务重算） |
| `status` | TEXT | NOT NULL DEFAULT `'draft'`，`CHECK IN ('draft','candidate','final','superseded')` | 版本状态 |
| `source` | TEXT | NOT NULL DEFAULT `'human'`，`CHECK IN ('human','ai','ai_revised','import','migration')` | 版本来源 |
| `summary` | TEXT | NOT NULL DEFAULT `''` | 改动说明（AI 管道/审校自动填） |
| `derived_from_version_id` | TEXT | NULL，FK 自表 `ON DELETE SET NULL` | 派生自哪一版（修订链） |
| `proposal_id` | TEXT | NULL，FK→`proposals(id)` `ON DELETE SET NULL` | 该版本由哪条提议生成 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**索引**

| 索引 | 列 | 用途 |
|---|---|---|
| `ux_chapter_versions_no` | `(chapter_id, version_no) WHERE deleted_at IS NULL` | 版本号唯一 |
| `ix_chapter_versions_status` | `(chapter_id, status) WHERE deleted_at IS NULL` | 查当前草稿/定稿 |
| `ix_chapter_versions_proposal` | `(proposal_id) WHERE proposal_id IS NOT NULL` | 由提议反查版本 |

**外键**：`chapter_id → chapters(id) CASCADE`；`derived_from_version_id → chapter_versions(id) SET NULL`；`proposal_id → proposals(id) SET NULL`（`proposals` 在 §8 建表，SQLite 允许前向引用）。

```sql
-- ===== 4.3 chapter_versions =====
CREATE TABLE IF NOT EXISTS chapter_versions (
  id                      TEXT    PRIMARY KEY,
  chapter_id              TEXT    NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
  version_no              INTEGER NOT NULL CHECK (version_no >= 1),
  content                 TEXT    NOT NULL DEFAULT '',
  content_sha256          TEXT,
  word_count              INTEGER NOT NULL DEFAULT 0 CHECK (word_count >= 0),
  status                  TEXT    NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft','candidate','final','superseded')),
  source                  TEXT    NOT NULL DEFAULT 'human'
                          CHECK (source IN ('human','ai','ai_revised','import','migration')),
  summary                 TEXT    NOT NULL DEFAULT '',
  derived_from_version_id TEXT REFERENCES chapter_versions(id) ON DELETE SET NULL,
  proposal_id             TEXT REFERENCES proposals(id) ON DELETE SET NULL,
  created_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at              TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev                     INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id               TEXT    NOT NULL,
  deleted_at              TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_chapter_versions_no
  ON chapter_versions(chapter_id, version_no) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_chapter_versions_status
  ON chapter_versions(chapter_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_chapter_versions_proposal
  ON chapter_versions(proposal_id) WHERE proposal_id IS NOT NULL;
```

> `chapter_versions` 不带 `project_id`（通过 `chapter_id` 归属），因此它是 [§2.6](#26-外键策略) 里"少数例外"之一：项目一致性由应用层保证。**不要**为了复合 FK 再冗余一个 `project_id`，那会引入两处真相。

### 4.4 outlines（大纲树）

**用途**：整体大纲 / 卷大纲 / 章大纲组成的大纲树；节点下挂情节点（§4.5），故事线独立成表（§4.6）。

**树规则（【已定：卷大纲只能挂整体大纲下，不支持卷中卷】）**

| 规则 | 落地手段 |
|---|---|
| 每项目**恰 1 条** `kind='overall'` | 部分唯一索引 `ux_outlines_project_overall`（至多 1 条）+ 应用层创建项目时自动建（至少 1 条，见 §12） |
| `overall` 必须无父、无卷、无章 | `CHECK` |
| `kind='volume'` 必须挂 `overall`（**禁止卷中卷**） | `CHECK`（`volume_id NOT NULL`）+ 触发器 `trg_outlines_parent_kind_*` 校验父节点 kind |
| `kind='chapter'` 可挂 `overall` 或 `volume` | 触发器 |
| 章大纲与章一一对应 | 部分唯一索引 `ux_outlines_chapter`；`chapter_id` 可空（先写大纲、后建章），绑定后 `rev+1` |
| 卷大纲与卷一一对应 | `volume_id` 必填 + 应用层确保一卷一大纲（DB 层未加唯一，见 INF-12 备注） |
| 排序 | `sort_index`（同级内从小到大），`parent_id + sort_index` 建索引 |
| 删除 | 软删子树需应用层事务递归；硬删父节点由 FK CASCADE 清子节点 |

#### 4.4.1 outlines 列定义

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `kind` | TEXT | NOT NULL，`CHECK IN ('overall','volume','chapter')` | 节点层级 |
| `parent_id` | TEXT | NULL | 父节点（复合 FK） |
| `volume_id` | TEXT | NULL | `kind='volume'` 时必填 |
| `chapter_id` | TEXT | NULL | `kind='chapter'` 时绑定章（可空） |
| `title` | TEXT | NOT NULL，非空 | 节点标题 |
| `summary` | TEXT | NOT NULL DEFAULT `''` | 一句话概要（进上下文） |
| `content` | TEXT | NOT NULL DEFAULT `''` | 细纲正文（Markdown，可长） |
| `sort_index` | INTEGER | NOT NULL DEFAULT 0 | 同级排序 |
| `status` | TEXT | NOT NULL DEFAULT `'planned'`，`CHECK IN ('planned','active','done','archived')` | 大纲节点状态 |
| `metadata_json` | TEXT | NOT NULL DEFAULT `'{}'`，`CHECK json_valid` | **JSON**：节奏/情绪/冲突强度等扩展字段 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**索引 / 外键**

| 对象 | 定义 | 用途 |
|---|---|---|
| `UNIQUE (project_id, id)` | 表内约束 | 供复合 FK 引用 |
| `ux_outlines_project_overall` | `(project_id) WHERE kind='overall' AND deleted_at IS NULL` | 每项目至多 1 条整体大纲 |
| `ux_outlines_chapter` | `(chapter_id) WHERE kind='chapter' AND chapter_id IS NOT NULL AND deleted_at IS NULL` | 一章至多 1 条章大纲 |
| `ix_outlines_tree` | `(project_id, parent_id, sort_index) WHERE deleted_at IS NULL` | 树加载 |
| `ix_outlines_volume` | `(project_id, volume_id) WHERE volume_id IS NOT NULL AND deleted_at IS NULL` | 按卷取大纲 |
| FK `(project_id, parent_id)` | `outlines(project_id, id)` CASCADE | 同项目父节点 |
| FK `(project_id, volume_id)` | `volumes(project_id, id)` CASCADE | 同项目卷 |
| FK `(project_id, chapter_id)` | `chapters(project_id, id)` SET NULL | 同项目章 |

```sql
-- ===== 4.4 outlines =====
CREATE TABLE IF NOT EXISTS outlines (
  id            TEXT    PRIMARY KEY,
  project_id    TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT    NOT NULL CHECK (kind IN ('overall','volume','chapter')),
  parent_id     TEXT,
  volume_id     TEXT,
  chapter_id    TEXT,
  title         TEXT    NOT NULL CHECK (length(trim(title)) > 0),
  summary       TEXT    NOT NULL DEFAULT '',
  content       TEXT    NOT NULL DEFAULT '',
  sort_index    INTEGER NOT NULL DEFAULT 0,
  status        TEXT    NOT NULL DEFAULT 'planned'
                        CHECK (status IN ('planned','active','done','archived')),
  metadata_json TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev           INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id     TEXT    NOT NULL,
  deleted_at    TEXT,
  UNIQUE (project_id, id),
  CHECK (
       (kind = 'overall' AND parent_id IS NULL AND volume_id IS NULL AND chapter_id IS NULL)
    OR (kind = 'volume'  AND parent_id IS NOT NULL AND volume_id IS NOT NULL AND chapter_id IS NULL)
    OR (kind = 'chapter' AND parent_id IS NOT NULL)
  ),
  FOREIGN KEY (project_id, parent_id) REFERENCES outlines(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, volume_id) REFERENCES volumes(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, chapter_id) REFERENCES chapters(project_id, id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_outlines_project_overall
  ON outlines(project_id) WHERE kind = 'overall' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_outlines_chapter
  ON outlines(chapter_id) WHERE kind = 'chapter' AND chapter_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_outlines_tree
  ON outlines(project_id, parent_id, sort_index) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_outlines_volume
  ON outlines(project_id, volume_id) WHERE volume_id IS NOT NULL AND deleted_at IS NULL;

-- 卷大纲只能挂 overall；章大纲只能挂 overall 或 volume（禁卷中卷）
CREATE TRIGGER IF NOT EXISTS trg_outlines_parent_kind_bi
BEFORE INSERT ON outlines
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM outlines p
    WHERE p.id = NEW.parent_id
      AND p.project_id = NEW.project_id
      AND p.deleted_at IS NULL
      AND ((NEW.kind = 'volume'  AND p.kind = 'overall')
        OR (NEW.kind = 'chapter' AND p.kind IN ('overall','volume')))
  ) THEN RAISE(ABORT, 'invalid outline parent (volume must hang under overall; chapter under overall/volume)') END;
END;

CREATE TRIGGER IF NOT EXISTS trg_outlines_parent_kind_bu
BEFORE UPDATE OF parent_id, kind, project_id ON outlines
WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM outlines p
    WHERE p.id = NEW.parent_id
      AND p.project_id = NEW.project_id
      AND p.deleted_at IS NULL
      AND ((NEW.kind = 'volume'  AND p.kind = 'overall')
        OR (NEW.kind = 'chapter' AND p.kind IN ('overall','volume')))
  ) THEN RAISE(ABORT, 'invalid outline parent (volume must hang under overall; chapter under overall/volume)') END;
END;
```

> 触发器只校验父节点 kind；"每项目恰 1 条 overall" 的"至少 1 条"由应用层创建项目时保证（与世界观根不同，这里没有用触发器自动建，因为整体大纲需要标题/正文，自动建空壳反而会造成垃圾数据）【推断】。

### 4.5 outline_plot_points（情节点）

**用途**：大纲节点下的有序情节点（设定、转折、高潮、回收），可挂故事线。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `outline_id` | TEXT | NOT NULL | 所属大纲节点（复合 FK） |
| `seq` | INTEGER | NOT NULL，`CHECK >= 1` | 节点内顺序 |
| `kind` | TEXT | NOT NULL DEFAULT `'beat'`，`CHECK IN ('setup','beat','turn','climax','payoff','note')` | 情节点类型 |
| `content` | TEXT | NOT NULL DEFAULT `''` | 内容 |
| `arc_id` | TEXT | NULL | 所属故事线（复合 FK，可空） |
| `status` | TEXT | NOT NULL DEFAULT `'planned'`，`CHECK IN ('planned','done','cut')` | 状态 |
| `chapter_hint` | TEXT | NOT NULL DEFAULT `''` | 预估落点（如「卷二第 8 章」），文本不解析 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**索引 / 外键**：`UNIQUE (project_id, id)`；`ux_plot_points_outline_seq (outline_id, seq) WHERE deleted_at IS NULL`；`ix_plot_points_arc (arc_id) WHERE arc_id IS NOT NULL AND deleted_at IS NULL`；FK `(project_id, outline_id) → outlines(project_id,id) CASCADE`、`(project_id, arc_id) → story_arcs(project_id,id) SET NULL`。

```sql
-- ===== 4.5 outline_plot_points =====
CREATE TABLE IF NOT EXISTS outline_plot_points (
  id           TEXT    PRIMARY KEY,
  project_id   TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  outline_id   TEXT    NOT NULL,
  seq          INTEGER NOT NULL CHECK (seq >= 1),
  kind         TEXT    NOT NULL DEFAULT 'beat'
               CHECK (kind IN ('setup','beat','turn','climax','payoff','note')),
  content      TEXT    NOT NULL DEFAULT '',
  arc_id       TEXT,
  status       TEXT    NOT NULL DEFAULT 'planned' CHECK (status IN ('planned','done','cut')),
  chapter_hint TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev          INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id    TEXT    NOT NULL,
  deleted_at   TEXT,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, outline_id) REFERENCES outlines(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, arc_id) REFERENCES story_arcs(project_id, id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_plot_points_outline_seq
  ON outline_plot_points(outline_id, seq) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_plot_points_arc
  ON outline_plot_points(arc_id) WHERE arc_id IS NOT NULL AND deleted_at IS NULL;
```

### 4.6 story_arcs（故事线）

**用途**：跨卷/跨章的叙事线（主线、支线、感情线、悬疑线），承载"这条线现在到哪了"。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `name` | TEXT | NOT NULL，非空 | 线名 |
| `kind` | TEXT | NOT NULL DEFAULT `'sub'`，`CHECK IN ('main','sub','romance','mystery','growth','other')` | 线类型 |
| `status` | TEXT | NOT NULL DEFAULT `'planned'`，`CHECK IN ('planned','active','resolved','abandoned')` | 线状态 |
| `summary` | TEXT | NOT NULL DEFAULT `''` | 线概要 |
| `start_outline_id` | TEXT | NULL | 起点大纲节点（复合 FK） |
| `end_outline_id` | TEXT | NULL | 终点大纲节点（复合 FK） |
| `milestones_json` | TEXT | NOT NULL DEFAULT `'[]'`，`CHECK json_valid` | **JSON**：里程碑数组（`{name, chapter_id?, note}`） |
| `order_index` | INTEGER | NOT NULL DEFAULT 0 | 列表排序 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**索引 / 外键**：`UNIQUE (project_id, id)`；`ux_story_arcs_name (project_id, name) WHERE deleted_at IS NULL`；`ix_story_arcs_status (project_id, status) WHERE deleted_at IS NULL`；FK `(project_id, start_outline_id/end_outline_id) → outlines(project_id,id) SET NULL`。

```sql
-- ===== 4.6 story_arcs =====
CREATE TABLE IF NOT EXISTS story_arcs (
  id               TEXT    PRIMARY KEY,
  project_id       TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name             TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  kind             TEXT    NOT NULL DEFAULT 'sub'
                   CHECK (kind IN ('main','sub','romance','mystery','growth','other')),
  status           TEXT    NOT NULL DEFAULT 'planned'
                   CHECK (status IN ('planned','active','resolved','abandoned')),
  summary          TEXT    NOT NULL DEFAULT '',
  start_outline_id TEXT,
  end_outline_id   TEXT,
  milestones_json  TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(milestones_json)),
  order_index      INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev              INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id        TEXT    NOT NULL,
  deleted_at       TEXT,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, start_outline_id) REFERENCES outlines(project_id, id) ON DELETE SET NULL,
  FOREIGN KEY (project_id, end_outline_id)   REFERENCES outlines(project_id, id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_story_arcs_name
  ON story_arcs(project_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_story_arcs_status
  ON story_arcs(project_id, status) WHERE deleted_at IS NULL;
```

---

## 5. 设定域：分类 / 世界观树 / 世界书

> 旧库两个坑在这里修掉：① `world_settings.category` 是字符串名（改名/改分类无法追溯）→ 本节改为 **`category_id` 真 FK**；② 每项目恰 1 条世界观根（旧库不变量）→ **部分唯一索引 + 触发器自动建根**。

### 5.1 world_setting_categories（世界观分类字典）

**用途**：世界观条目的分类字典（真 FK 目标），替代旧库"分类名当字符串存"；供非根条目强制归类。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 分类按项目隔离（作者可自定义分类，不污染其他书）【推断】 |
| `key` | TEXT | NOT NULL，非空 | 稳定文本键（ASCII，如 `geography`/`faction`/`power_system`），用于导入导出与内置分类识别 |
| `name` | TEXT | NOT NULL，非空 | 显示名（如「地理」「势力」） |
| `parent_id` | TEXT | NULL | 分类树（允许二级分类，如「功法体系/剑修」） |
| `sort_index` | INTEGER | NOT NULL DEFAULT 0 | 同级排序 |
| `description` | TEXT | NOT NULL DEFAULT `''` | 分类说明（可进上下文） |
| `is_builtin` | INTEGER | NOT NULL DEFAULT 0，`CHECK IN (0,1)` | 是否内置分类（内置不可删，只可改名） |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**内置分类种子（【推断】INF-13）**

| `key` | `name` | 说明 |
|---|---|---|
| `geography` | 地理 | 区域、山川、城池 |
| `faction` | 势力 | 门派、国家、组织 |
| `power_system` | 力量体系 | 境界、功法、灵气规则 |
| `item` | 物品 | 法宝、丹药、信物 |
| `race` | 种族 | 人族/妖族/仙族等 |
| `history` | 历史 | 纪元、大战、传说 |
| `rule` | 规则 | 世界硬规则（禁忌、契约、天地法则） |
| `custom` | 其他 | 兜底 |

> 种子在**应用层建项目事务内**插入（触发器无法生成 UUID v7）；内置分类 `is_builtin=1`，删除保护在应用层（DB 层不写触发器，避免与 purge 交互复杂）【推断】。

**索引 / 外键**：`UNIQUE (project_id, id)`；`ux_wsc_project_key (project_id, key) WHERE deleted_at IS NULL`；`ux_wsc_project_name (project_id, name) WHERE deleted_at IS NULL`；`ix_wsc_parent (project_id, parent_id, sort_index) WHERE deleted_at IS NULL`；FK `(project_id, parent_id) → world_setting_categories(project_id,id) CASCADE`。

```sql
-- ===== 5.1 world_setting_categories =====
CREATE TABLE IF NOT EXISTS world_setting_categories (
  id          TEXT    PRIMARY KEY,
  project_id  TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key         TEXT    NOT NULL CHECK (length(trim(key)) > 0),
  name        TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  parent_id   TEXT,
  sort_index  INTEGER NOT NULL DEFAULT 0,
  description TEXT    NOT NULL DEFAULT '',
  is_builtin  INTEGER NOT NULL DEFAULT 0 CHECK (is_builtin IN (0,1)),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev         INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id   TEXT    NOT NULL,
  deleted_at  TEXT,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, parent_id) REFERENCES world_setting_categories(project_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_wsc_project_key
  ON world_setting_categories(project_id, key) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_wsc_project_name
  ON world_setting_categories(project_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_wsc_parent
  ON world_setting_categories(project_id, parent_id, sort_index) WHERE deleted_at IS NULL;
```

### 5.2 world_settings（世界观树）

**用途**：世界观条目的树（整体世界观根 → 分类 → 条目 → 子条目），是上下文注入与一致性检查的主要设定来源。

**树与根规则（【已定】：每项目恰 1 条根）**

| 规则 | 落地手段 | 强制层级 |
|---|---|---|
| 每项目**至多 1 条**根（`is_root=1`） | 部分唯一索引 `ux_world_settings_root` | DB（UNIQUE） |
| 每项目**至少 1 条**根 | 触发器 `trg_projects_insert_root`：插入项目时自动建根 | DB（触发器） |
| 根不得被删（软删/硬删） | 触发器 `trg_world_settings_root_guard_*` | DB（触发器） |
| 根不得有父、不得有分类 | `CHECK` | DB（CHECK） |
| 非根必须有父、必须有分类 | `CHECK` | DB（CHECK） |
| 根 id = 项目 id | 触发器写入约定（INF-05） | DB 约定 |
| 分类必须存在且同项目 | 复合 FK `(project_id, category_id)` | DB（FK） |
| 父节点必须同项目 | 复合 FK `(project_id, parent_id)` | DB（FK） |
| 同父下标题唯一 | 表达式唯一索引 `ux_world_settings_sibling_title` | DB（UNIQUE） |

#### 5.2.1 world_settings 列定义

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7；根条目 = `projects.id` |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `category_id` | TEXT | NULL | 非根必填；复合 FK→分类 |
| `parent_id` | TEXT | NULL | 非根必填；复合 FK→自身 |
| `is_root` | INTEGER | NOT NULL DEFAULT 0，`CHECK IN (0,1)` | 是否根；根条目由触发器建，业务代码不得改 |
| `title` | TEXT | NOT NULL，非空 | 条目标题（如「苍山」「青云门」） |
| `subtitle` | TEXT | NOT NULL DEFAULT `''` | 副标题/别名 |
| `content` | TEXT | NOT NULL DEFAULT `''` | 正文（Markdown，设定详情） |
| `summary` | TEXT | NOT NULL DEFAULT `''` | 一句话摘要（进上下文压缩） |
| `sort_index` | INTEGER | NOT NULL DEFAULT 0 | 同级排序 |
| `tags_json` | TEXT | NOT NULL DEFAULT `'[]'`，`CHECK json_valid` | **JSON**：标签数组（跨分类检索用） |
| `status` | TEXT | NOT NULL DEFAULT `'active'`，`CHECK IN ('active','archived')` | 归档不参与注入 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**CHECK 约束**

```sql
CHECK (
     (is_root = 1 AND parent_id IS NULL AND category_id IS NULL)
  OR (is_root = 0 AND parent_id IS NOT NULL AND category_id IS NOT NULL)
)
```

**索引 / 外键**

| 对象 | 定义 | 用途 |
|---|---|---|
| `UNIQUE (project_id, id)` | 表内约束 | 复合 FK 目标 |
| `ux_world_settings_root` | `(project_id) WHERE is_root=1 AND deleted_at IS NULL` | 每项目至多 1 根 |
| `ux_world_settings_sibling_title` | `(project_id, COALESCE(parent_id,''), title) WHERE deleted_at IS NULL` | 同父下标题唯一（根只有 1 条，不影响） |
| `ix_world_settings_cat` | `(project_id, category_id, sort_index) WHERE deleted_at IS NULL` | 按分类列条目 |
| `ix_world_settings_parent` | `(project_id, parent_id, sort_index) WHERE deleted_at IS NULL` | 树加载 |
| FK `(project_id, category_id)` | `world_setting_categories(project_id,id)` **RESTRICT** | 分类被引用时不可硬删 |
| FK `(project_id, parent_id)` | `world_settings(project_id,id)` **CASCADE** | 父硬删级联子树 |

#### 5.2.2 DDL 与根保护触发器

```sql
-- ===== 5.2 world_settings =====
CREATE TABLE IF NOT EXISTS world_settings (
  id          TEXT    PRIMARY KEY,
  project_id  TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  category_id TEXT,
  parent_id   TEXT,
  is_root     INTEGER NOT NULL DEFAULT 0 CHECK (is_root IN (0,1)),
  title       TEXT    NOT NULL CHECK (length(trim(title)) > 0),
  subtitle    TEXT    NOT NULL DEFAULT '',
  content     TEXT    NOT NULL DEFAULT '',
  summary     TEXT    NOT NULL DEFAULT '',
  sort_index  INTEGER NOT NULL DEFAULT 0,
  tags_json   TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(tags_json)),
  status      TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev         INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id   TEXT    NOT NULL,
  deleted_at  TEXT,
  UNIQUE (project_id, id),
  CHECK (
       (is_root = 1 AND parent_id IS NULL AND category_id IS NULL)
    OR (is_root = 0 AND parent_id IS NOT NULL AND category_id IS NOT NULL)
  ),
  FOREIGN KEY (project_id, category_id) REFERENCES world_setting_categories(project_id, id) ON DELETE RESTRICT,
  FOREIGN KEY (project_id, parent_id)   REFERENCES world_settings(project_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_world_settings_root
  ON world_settings(project_id) WHERE is_root = 1 AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_world_settings_sibling_title
  ON world_settings(project_id, COALESCE(parent_id, ''), title) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_world_settings_cat
  ON world_settings(project_id, category_id, sort_index) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_world_settings_parent
  ON world_settings(project_id, parent_id, sort_index) WHERE deleted_at IS NULL;

-- 插入项目时自动建唯一根条目（id 复用 project.id；无法在触发器里生成 UUID v7）
CREATE TRIGGER IF NOT EXISTS trg_projects_insert_root
AFTER INSERT ON projects
BEGIN
  INSERT INTO world_settings (
    id, project_id, category_id, parent_id, is_root, title, subtitle, content, summary,
    sort_index, tags_json, status, created_at, updated_at, rev, device_id, deleted_at
  ) VALUES (
    NEW.id, NEW.id, NULL, NULL, 1, '世界观', '', '', '',
    0, '[]', 'active',
    strftime('%Y-%m-%dT%H:%M:%fZ','now'), strftime('%Y-%m-%dT%H:%M:%fZ','now'),
    1, NEW.device_id, NULL
  );
END;

-- 根条目软删保护
CREATE TRIGGER IF NOT EXISTS trg_world_settings_root_guard_softdel
BEFORE UPDATE OF deleted_at ON world_settings
WHEN OLD.is_root = 1 AND NEW.deleted_at IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'root world setting must not be soft-deleted');
END;

-- 根条目硬删保护（项目仍活跃时禁止；项目已软删 ⇒ purge 放行）
CREATE TRIGGER IF NOT EXISTS trg_world_settings_root_guard_del
BEFORE DELETE ON world_settings
WHEN OLD.is_root = 1
 AND EXISTS (SELECT 1 FROM projects p WHERE p.id = OLD.project_id AND p.deleted_at IS NULL)
BEGIN
  SELECT RAISE(ABORT, 'root world setting must not be deleted while project is active');
END;

-- 根条目身份不可变（不能改 is_root / parent / category / project）
CREATE TRIGGER IF NOT EXISTS trg_world_settings_root_guard_mut
BEFORE UPDATE OF is_root, parent_id, category_id, project_id ON world_settings
WHEN OLD.is_root = 1
 AND (NEW.is_root <> 1 OR NEW.parent_id IS NOT NULL OR NEW.category_id IS NOT NULL OR NEW.project_id <> OLD.project_id)
BEGIN
  SELECT RAISE(ABORT, 'root world setting identity is immutable');
END;
```

> **purge 顺序**（【推断】INF-05）：① `UPDATE projects SET deleted_at=now, rev=rev+1` 软删项目 → ② 事务内 `DELETE FROM projects WHERE id=?`，FK CASCADE 删子表；此时根保护触发器检查到项目 `deleted_at IS NOT NULL` 而放行。若跳过步骤 ①，根触发器会阻止硬删——这是有意的安全阀。

> 触发器 `trg_projects_insert_root` 依赖 `world_settings` 表已存在，因此**迁移里必须先建 `world_settings` 再建该触发器**（§3.4 执行顺序已保证：本节触发器晚于 §4 的 `projects` 建表）。

### 5.3 worldbook_entries（世界书/词条）

**用途**：统一的「世界书 / lorebook / 词条」——按关键词/优先级/always 在写作时触发注入，是上下文构建的检索层（与世界观树互补：树负责组织，词条负责按需注入）。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `world_setting_id` | TEXT | NULL | 可选：关联世界观树节点（复合 FK，见下） |
| `character_id` | TEXT | NULL | 可选：关联角色（复合 FK）；与 `world_setting_id` **互斥** |
| `title` | TEXT | NOT NULL，非空 | 词条名 |
| `entry_type` | TEXT | NOT NULL DEFAULT `'lore'`，`CHECK IN ('lore','character','item','location','event','rule','organization','other')` | 词条类型（用于筛选与展示） |
| `keywords` | TEXT | NOT NULL DEFAULT `''` | **空格分隔的小写关键词**（如 `苍山 灵气 洞天`）；不用 JSON，因为要直接喂 FTS/触发匹配（INF-14） |
| `priority` | INTEGER | NOT NULL DEFAULT 50，`CHECK BETWEEN 0 AND 100` | 注入优先级（数值大优先；同级按 `order_index`） |
| `always` | INTEGER | NOT NULL DEFAULT 0，`CHECK IN (0,1)` | 是否常驻注入（与 `trigger_mode='always'` 必须一致） |
| `trigger_mode` | TEXT | NOT NULL DEFAULT `'keywords'`，`CHECK IN ('keywords','always','never')` | 触发方式 |
| `content` | TEXT | NOT NULL DEFAULT `''` | 词条正文（Markdown） |
| `token_budget` | INTEGER | NULL，`CHECK > 0` | 注入时的 token 预算上限（超预算截断） |
| `position` | TEXT | NOT NULL DEFAULT `'before_context'`，`CHECK IN ('before_context','after_context','in_chapter','system')` | 注入位置 |
| `order_index` | INTEGER | NOT NULL DEFAULT 0 | 同优先级内排序 |
| `enabled` | INTEGER | NOT NULL DEFAULT 1，`CHECK IN (0,1)` | 停用不参与注入/检索 |
| `source` | TEXT | NOT NULL DEFAULT `'manual'`，`CHECK IN ('manual','ai','extraction','import','migration')` | 来源 |
| `metadata_json` | TEXT | NOT NULL DEFAULT `'{}'`，`CHECK json_valid` | **JSON**：扩展字段（如递归深度、排除标签） |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**约束与触发注入语义**

| 规则 | 实现 |
|---|---|
| `always=1` 必须 `trigger_mode='always'` | `CHECK ((always = 1 AND trigger_mode = 'always') OR (always = 0 AND trigger_mode IN ('keywords','never')))` |
| 一条词条最多关联一个实体 | `CHECK (world_setting_id IS NULL OR character_id IS NULL)` |
| 触发匹配 | 应用层：对当前上下文文本做小写化，按 `keywords` 空格分词匹配（CJK 允许子串命中）；`trigger_mode='always'` 无条件注入；`never` 只能手动引用 |
| 注入排序 | `enabled=1 AND (always=1 OR 命中关键词)` → `priority DESC, order_index ASC, updated_at DESC` |
| 预算控制 | 累计 `token_budget`（未设则用项目级默认），超额截断并记录到上下文诊断 |
| FTS | 由 §11.2 的 external content FTS 表覆盖 `title` / `keywords` / `content` |

**索引 / 外键**

| 对象 | 定义 | 用途 |
|---|---|---|
| `UNIQUE (project_id, id)` | 表内约束 | 复合 FK 目标 |
| `ux_worldbook_project_title` | `(project_id, title) WHERE deleted_at IS NULL` | 词条名项目内唯一 |
| `ix_worldbook_trigger` | `(project_id, enabled, trigger_mode, priority DESC) WHERE deleted_at IS NULL` | 注入候选集 |
| `ix_worldbook_setting` | `(project_id, world_setting_id) WHERE world_setting_id IS NOT NULL AND deleted_at IS NULL` | 按设定反查词条 |
| FK `(project_id, world_setting_id)` | `world_settings(project_id,id)` SET NULL | 同项目设定 |
| FK `(project_id, character_id)` | `characters(project_id,id)` SET NULL | 同项目角色 |

```sql
-- ===== 5.3 worldbook_entries =====
CREATE TABLE IF NOT EXISTS worldbook_entries (
  id                TEXT    PRIMARY KEY,
  project_id        TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  world_setting_id  TEXT,
  character_id      TEXT,
  title             TEXT    NOT NULL CHECK (length(trim(title)) > 0),
  entry_type        TEXT    NOT NULL DEFAULT 'lore'
                    CHECK (entry_type IN ('lore','character','item','location','event','rule','organization','other')),
  keywords          TEXT    NOT NULL DEFAULT '',
  priority          INTEGER NOT NULL DEFAULT 50 CHECK (priority BETWEEN 0 AND 100),
  always            INTEGER NOT NULL DEFAULT 0 CHECK (always IN (0,1)),
  trigger_mode      TEXT    NOT NULL DEFAULT 'keywords'
                    CHECK (trigger_mode IN ('keywords','always','never')),
  content           TEXT    NOT NULL DEFAULT '',
  token_budget      INTEGER CHECK (token_budget IS NULL OR token_budget > 0),
  position          TEXT    NOT NULL DEFAULT 'before_context'
                    CHECK (position IN ('before_context','after_context','in_chapter','system')),
  order_index       INTEGER NOT NULL DEFAULT 0,
  enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  source            TEXT    NOT NULL DEFAULT 'manual'
                    CHECK (source IN ('manual','ai','extraction','import','migration')),
  metadata_json     TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev               INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id         TEXT    NOT NULL,
  deleted_at        TEXT,
  UNIQUE (project_id, id),
  CHECK ((always = 1 AND trigger_mode = 'always') OR (always = 0 AND trigger_mode IN ('keywords','never'))),
  CHECK (world_setting_id IS NULL OR character_id IS NULL),
  FOREIGN KEY (project_id, world_setting_id) REFERENCES world_settings(project_id, id) ON DELETE SET NULL,
  FOREIGN KEY (project_id, character_id)     REFERENCES characters(project_id, id)   ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_worldbook_project_title
  ON worldbook_entries(project_id, title) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_worldbook_trigger
  ON worldbook_entries(project_id, enabled, trigger_mode, priority DESC) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_worldbook_setting
  ON worldbook_entries(project_id, world_setting_id)
  WHERE world_setting_id IS NOT NULL AND deleted_at IS NULL;
```

---

## 6. 角色域

### 6.1 characters（角色主档）

**用途**：角色主档；名字是项目内唯一标识，语言基因/状态/关系分别落在 §6.4–§6.6。

**名字规则（【已定：角色名项目内唯一】/【推断：归一化手法】INF-11）**

| 规则 | 落地手段 |
|---|---|
| 项目内角色名唯一（仅活跃行） | 唯一索引 `ux_characters_project_name` 建在 `name_key` 上 |
| `name_key` 归一化 | 应用层：`trim` → 全角转半角 → 大小写折叠 → 删除零宽/空白字符；CJK **不做**繁简/异体归并（避免误合并不同角色） |
| 别名 | `alias`（主要别名，便于展示）+ `alias_json`（JSON 数组，多个称谓）；别名不参与唯一性校验 |
| 同名不同人 | 用限定名区分（如「张三（镖师）」），**不**允许两条同名活跃角色（唯一索引会拒绝） |
| 改名 | 只改 `name`/`name_key`/`alias*`，实体 id 不变；历史称谓写 `alias_json` |

**列定义**

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `name` | TEXT | NOT NULL，非空 | 角色名（展示用） |
| `name_key` | TEXT | NOT NULL，非空 | 归一化名（唯一索引目标） |
| `alias` | TEXT | NOT NULL DEFAULT `''` | 主要别名（如「清音仙子」） |
| `alias_json` | TEXT | NOT NULL DEFAULT `'[]'`，`CHECK json_valid` | **JSON**：全部别名数组 |
| `role_type` | TEXT | NOT NULL DEFAULT `'supporting'`，`CHECK IN ('protagonist','deuteragonist','antagonist','supporting','minor','narrator','cameo')` | 角色定位 |
| `role_rank` | INTEGER | NOT NULL DEFAULT 100，`CHECK >= 0` | 重要度排序（越小越核心；对应旧库 `extra.role_rank`） |
| `status` | TEXT | NOT NULL DEFAULT `'active'`，`CHECK IN ('active','dead','missing','sealed','retired')` | 全局状态（按章时点状态见 §6.6） |
| `gender` | TEXT | NOT NULL DEFAULT `''` | 性别（自由文本，容纳非人角色） |
| `age_text` | TEXT | NOT NULL DEFAULT `''` | 年龄文本（允许「十六七岁」「三百余岁」，不存数值） |
| `appearance` | TEXT | NOT NULL DEFAULT `''` | 外貌 |
| `personality` | TEXT | NOT NULL DEFAULT `''` | 性格 |
| `background` | TEXT | NOT NULL DEFAULT `''` | 背景 |
| `motivation` | TEXT | NOT NULL DEFAULT `''` | 动机/目标 |
| `abilities` | TEXT | NOT NULL DEFAULT `''` | 能力概览（详细按章状态见 §6.6） |
| `first_appearance_chapter_id` | TEXT | NULL | 首次出场章（复合 FK SET NULL） |
| `attributes_json` | TEXT | NOT NULL DEFAULT `'{}'`，`CHECK json_valid` | **JSON**：扩展属性（种族、势力倾向、口头禅标记等） |
| `notes` | TEXT | NOT NULL DEFAULT `''` | 作者备注 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**索引 / 外键**：`UNIQUE (project_id, id)`；`ux_characters_project_name (project_id, name_key) WHERE deleted_at IS NULL`；`ix_characters_rank (project_id, role_type, role_rank) WHERE deleted_at IS NULL`；`ix_characters_first_appearance (first_appearance_chapter_id) WHERE first_appearance_chapter_id IS NOT NULL`；FK `(project_id, first_appearance_chapter_id) → chapters(project_id,id) SET NULL`。

```sql
-- ===== 6.1 characters =====
CREATE TABLE IF NOT EXISTS characters (
  id                          TEXT    PRIMARY KEY,
  project_id                  TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name                        TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  name_key                    TEXT    NOT NULL CHECK (length(trim(name_key)) > 0),
  alias                       TEXT    NOT NULL DEFAULT '',
  alias_json                  TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(alias_json)),
  role_type                   TEXT    NOT NULL DEFAULT 'supporting'
                              CHECK (role_type IN ('protagonist','deuteragonist','antagonist','supporting','minor','narrator','cameo')),
  role_rank                   INTEGER NOT NULL DEFAULT 100 CHECK (role_rank >= 0),
  status                      TEXT    NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active','dead','missing','sealed','retired')),
  gender                      TEXT    NOT NULL DEFAULT '',
  age_text                    TEXT    NOT NULL DEFAULT '',
  appearance                  TEXT    NOT NULL DEFAULT '',
  personality                 TEXT    NOT NULL DEFAULT '',
  background                  TEXT    NOT NULL DEFAULT '',
  motivation                  TEXT    NOT NULL DEFAULT '',
  abilities                   TEXT    NOT NULL DEFAULT '',
  first_appearance_chapter_id TEXT,
  attributes_json             TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(attributes_json)),
  notes                       TEXT    NOT NULL DEFAULT '',
  created_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev                         INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id                   TEXT    NOT NULL,
  deleted_at                  TEXT,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, first_appearance_chapter_id)
    REFERENCES chapters(project_id, id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_characters_project_name
  ON characters(project_id, name_key) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_characters_rank
  ON characters(project_id, role_type, role_rank) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_characters_first_appearance
  ON characters(first_appearance_chapter_id)
  WHERE first_appearance_chapter_id IS NOT NULL;
```

### 6.2 character_groups（角色分组）与 character_group_members（成员）

**用途**：分组树（门派/家族/小队）；成员表承载多对多 + 加入/退出章节。

#### character_groups

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `name` | TEXT | NOT NULL，非空 | 分组名 |
| `kind` | TEXT | NOT NULL DEFAULT `'other'`，`CHECK IN ('faction','family','team','sect','organization','other')` | 分组类型 |
| `parent_id` | TEXT | NULL | 分组树（复合 FK） |
| `description` | TEXT | NOT NULL DEFAULT `''` | 描述 |
| `color` | TEXT | NULL | UI 颜色（`#RRGGBB`，应用层校验） |
| `sort_index` | INTEGER | NOT NULL DEFAULT 0 | 同级排序 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

索引/外键：`UNIQUE (project_id,id)`；`ux_char_groups_name (project_id,name) WHERE deleted_at IS NULL`；`ix_char_groups_parent (project_id,parent_id,sort_index) WHERE deleted_at IS NULL`；FK `(project_id,parent_id) → character_groups(project_id,id) CASCADE`。

#### character_group_members

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `group_id` | TEXT | NOT NULL | 分组（复合 FK） |
| `character_id` | TEXT | NOT NULL | 角色（复合 FK） |
| `role_in_group` | TEXT | NOT NULL DEFAULT `''` | 组内身份（掌门/长老/弟子） |
| `is_primary` | INTEGER | NOT NULL DEFAULT 0，`CHECK IN (0,1)` | 是否主分组（一人可多组，主组唯一由应用层保证） |
| `joined_chapter_id` | TEXT | NULL | 加入章（复合 FK SET NULL） |
| `left_chapter_id` | TEXT | NULL | 退出章（复合 FK SET NULL） |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

索引/外键：`UNIQUE (project_id,id)`；`ux_cgm_group_char (group_id,character_id) WHERE deleted_at IS NULL`；`ix_cgm_character (character_id) WHERE deleted_at IS NULL`；FK `(project_id,group_id) → character_groups(project_id,id) CASCADE`、`(project_id,character_id) → characters(project_id,id) CASCADE`、`joined/left_chapter_id → chapters(project_id,id) SET NULL`。

```sql
-- ===== 6.2 character_groups =====
CREATE TABLE IF NOT EXISTS character_groups (
  id          TEXT    PRIMARY KEY,
  project_id  TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name        TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  kind        TEXT    NOT NULL DEFAULT 'other'
              CHECK (kind IN ('faction','family','team','sect','organization','other')),
  parent_id   TEXT,
  description TEXT    NOT NULL DEFAULT '',
  color       TEXT,
  sort_index  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev         INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id   TEXT    NOT NULL,
  deleted_at  TEXT,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, parent_id) REFERENCES character_groups(project_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_char_groups_name
  ON character_groups(project_id, name) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_char_groups_parent
  ON character_groups(project_id, parent_id, sort_index) WHERE deleted_at IS NULL;

-- ===== 6.2 character_group_members =====
CREATE TABLE IF NOT EXISTS character_group_members (
  id                TEXT    PRIMARY KEY,
  project_id        TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  group_id          TEXT    NOT NULL,
  character_id      TEXT    NOT NULL,
  role_in_group     TEXT    NOT NULL DEFAULT '',
  is_primary        INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  joined_chapter_id TEXT,
  left_chapter_id   TEXT,
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev               INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id         TEXT    NOT NULL,
  deleted_at        TEXT,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, group_id)          REFERENCES character_groups(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, character_id)      REFERENCES characters(project_id, id)       ON DELETE CASCADE,
  FOREIGN KEY (project_id, joined_chapter_id) REFERENCES chapters(project_id, id)         ON DELETE SET NULL,
  FOREIGN KEY (project_id, left_chapter_id)   REFERENCES chapters(project_id, id)         ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_cgm_group_char
  ON character_group_members(group_id, character_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_cgm_character
  ON character_group_members(character_id) WHERE deleted_at IS NULL;
```

### 6.3 character_relations（角色关系边）

**用途**：角色之间的有向/对称关系边（师徒、父子、仇敌、盟友），带强度与起止章节。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `from_character_id` | TEXT | NOT NULL | 关系主体（复合 FK） |
| `to_character_id` | TEXT | NOT NULL | 关系客体（复合 FK） |
| `relation_type` | TEXT | NOT NULL，`CHECK IN ('family','master_disciple','friend','enemy','ally','rival','lover','subordinate','mentor','colleague','other')` | 关系类型 |
| `relation_label` | TEXT | NOT NULL DEFAULT `''` | 具体称谓（父子/结拜/宿敌），给 `other` 或细分用 |
| `strength` | INTEGER | NOT NULL DEFAULT 50，`CHECK BETWEEN 0 AND 100` | 强度（影响注入权重与冲突检测） |
| `direction` | TEXT | NOT NULL DEFAULT `'directed'`，`CHECK IN ('directed','mutual')` | 有向/对称 |
| `status` | TEXT | NOT NULL DEFAULT `'active'`，`CHECK IN ('active','ended','broken')` | 关系状态 |
| `since_chapter_id` | TEXT | NULL | 起始章（复合 FK SET NULL） |
| `until_chapter_id` | TEXT | NULL | 终止章（复合 FK SET NULL） |
| `note` | TEXT | NOT NULL DEFAULT `''` | 备注 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**规则**：`CHECK (from_character_id <> to_character_id)`；同一对角色同一关系类型唯一（部分唯一索引）；**对称关系只存一条**且规范化为"较小 id 在前"，`direction='mutual'`，应用层负责归一（避免 A→B 与 B→A 双写）【推断】。

索引/外键：`UNIQUE (project_id,id)`；`ux_char_relations_edge (project_id,from_character_id,to_character_id,relation_type) WHERE deleted_at IS NULL`；`ix_char_relations_to (to_character_id) WHERE deleted_at IS NULL`；FK 全部复合：两端角色 CASCADE，起止章 SET NULL。

```sql
-- ===== 6.3 character_relations =====
CREATE TABLE IF NOT EXISTS character_relations (
  id                TEXT    PRIMARY KEY,
  project_id        TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_character_id TEXT    NOT NULL,
  to_character_id   TEXT    NOT NULL,
  relation_type     TEXT    NOT NULL
                    CHECK (relation_type IN ('family','master_disciple','friend','enemy','ally','rival','lover','subordinate','mentor','colleague','other')),
  relation_label    TEXT    NOT NULL DEFAULT '',
  strength          INTEGER NOT NULL DEFAULT 50 CHECK (strength BETWEEN 0 AND 100),
  direction         TEXT    NOT NULL DEFAULT 'directed' CHECK (direction IN ('directed','mutual')),
  status            TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','ended','broken')),
  since_chapter_id  TEXT,
  until_chapter_id  TEXT,
  note              TEXT    NOT NULL DEFAULT '',
  created_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at        TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev               INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id         TEXT    NOT NULL,
  deleted_at        TEXT,
  UNIQUE (project_id, id),
  CHECK (from_character_id <> to_character_id),
  FOREIGN KEY (project_id, from_character_id) REFERENCES characters(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, to_character_id)   REFERENCES characters(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, since_chapter_id)  REFERENCES chapters(project_id, id)   ON DELETE SET NULL,
  FOREIGN KEY (project_id, until_chapter_id)  REFERENCES chapters(project_id, id)   ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_char_relations_edge
  ON character_relations(project_id, from_character_id, to_character_id, relation_type)
  WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_char_relations_to
  ON character_relations(to_character_id) WHERE deleted_at IS NULL;
```

### 6.4 character_voice（语言基因）

**用途**：一个角色的语言基因（语气、语域、句式、口头禅、禁忌词、称呼方式、代表台词），供写作注入与文风一致性检查。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `character_id` | TEXT | NOT NULL | 角色（1:1，复合 FK） |
| `tone` | TEXT | NOT NULL DEFAULT `''` | 语气基调（如「冷淡、克制」） |
| `register` | TEXT | NOT NULL DEFAULT `''` | 语域/身份语言档次（如「江湖粗豪」「世家文雅」） |
| `sentence_style` | TEXT | NOT NULL DEFAULT `''` | 句式偏好（长短句、是否用文言词） |
| `vocabulary` | TEXT | NOT NULL DEFAULT `''` | 常用词汇/专业术语 |
| `verbal_tics` | TEXT | NOT NULL DEFAULT `''` | 口头禅/习惯性说法 |
| `taboo_words` | TEXT | NOT NULL DEFAULT `''` | 禁忌词（该角色绝不说的话） |
| `address_forms_json` | TEXT | NOT NULL DEFAULT `'{}'`，`CHECK json_valid` | **JSON**：称呼映射（`{对师父: "师尊", 对仇人: 直呼其名}`） |
| `sample_lines_json` | TEXT | NOT NULL DEFAULT `'[]'`，`CHECK json_valid` | **JSON**：代表台词数组（few-shot 用） |
| `formality` | INTEGER | NOT NULL DEFAULT 50，`CHECK BETWEEN 0 AND 100` | 正式度（0 极口语，100 极书面） |
| `dialect` | TEXT | NOT NULL DEFAULT `''` | 方言/口音标记 |
| `notes` | TEXT | NOT NULL DEFAULT `''` | 备注 |
| `updated_by_chapter_id` | TEXT | NULL | 最近一次因哪一章调整（复合 FK SET NULL） |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

> 1:1 关系（`UNIQUE(character_id) WHERE deleted_at IS NULL`）【推断】；语言基因的演进历史走 `revisions` 表快照，不在此表留多版本（避免"当前版本"指针与多行并存）。

索引/外键：`UNIQUE (project_id,id)`；`ux_character_voice_character (character_id) WHERE deleted_at IS NULL`；`ix_character_voice_chapter (updated_by_chapter_id)`；FK `(project_id,character_id) → characters CASCADE`、`(project_id,updated_by_chapter_id) → chapters SET NULL`。

```sql
-- ===== 6.4 character_voice =====
CREATE TABLE IF NOT EXISTS character_voice (
  id                    TEXT    PRIMARY KEY,
  project_id            TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  character_id          TEXT    NOT NULL,
  tone                  TEXT    NOT NULL DEFAULT '',
  register              TEXT    NOT NULL DEFAULT '',
  sentence_style        TEXT    NOT NULL DEFAULT '',
  vocabulary            TEXT    NOT NULL DEFAULT '',
  verbal_tics           TEXT    NOT NULL DEFAULT '',
  taboo_words           TEXT    NOT NULL DEFAULT '',
  address_forms_json    TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(address_forms_json)),
  sample_lines_json     TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(sample_lines_json)),
  formality             INTEGER NOT NULL DEFAULT 50 CHECK (formality BETWEEN 0 AND 100),
  dialect               TEXT    NOT NULL DEFAULT '',
  notes                 TEXT    NOT NULL DEFAULT '',
  updated_by_chapter_id TEXT,
  created_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev                   INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id             TEXT    NOT NULL,
  deleted_at            TEXT,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, character_id)          REFERENCES characters(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, updated_by_chapter_id) REFERENCES chapters(project_id, id)   ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_character_voice_character
  ON character_voice(character_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_character_voice_chapter
  ON character_voice(updated_by_chapter_id)
  WHERE updated_by_chapter_id IS NOT NULL;
```

### 6.5 character_states（角色状态快照）

**用途**：角色在某个章节时点的状态（位置、身心、境界、持有物、已知信息），支撑"第 N 章时这个角色是什么状态"的一致性判定。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `character_id` | TEXT | NOT NULL | 角色（复合 FK） |
| `chapter_id` | TEXT | NOT NULL | 状态时点（章节；复合 FK） |
| `location_setting_id` | TEXT | NULL | 所在位置（复合 FK→世界观） |
| `physical_state` | TEXT | NOT NULL DEFAULT `''` | 身体状态（重伤/中毒/正常） |
| `mental_state` | TEXT | NOT NULL DEFAULT `''` | 心理状态 |
| `cultivation` | TEXT | NOT NULL DEFAULT `''` | 境界/修为（仙侠；自由文本） |
| `abilities_json` | TEXT | NOT NULL DEFAULT `'[]'`，`CHECK json_valid` | **JSON**：此章可用能力/底牌 |
| `possessions_json` | TEXT | NOT NULL DEFAULT `'[]'`，`CHECK json_valid` | **JSON**：持有物 |
| `knowledge_json` | TEXT | NOT NULL DEFAULT `'[]'`，`CHECK json_valid` | **JSON**：该角色此刻已知的关键信息（防"未卜先知"） |
| `status` | TEXT | NOT NULL DEFAULT `'active'`，`CHECK IN ('active','dead','missing','sealed','retired','unknown')` | 该时点状态 |
| `flags_json` | TEXT | NOT NULL DEFAULT `'{}'`，`CHECK json_valid` | **JSON**：布尔标记（失忆/入魔/伪装） |
| `notes` | TEXT | NOT NULL DEFAULT `''` | 备注 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**规则**：`UNIQUE (character_id, chapter_id) WHERE deleted_at IS NULL`（一个角色一章一条快照）；"第 N 章时的状态" = 取该角色章序 ≤ N 的最新一条（应用层 SQL 或后续视图 `v_character_state_at`，本期不建视图）。

索引/外键：`UNIQUE (project_id,id)`；`ux_character_states_point (character_id, chapter_id) WHERE deleted_at IS NULL`；`ix_character_states_chapter (chapter_id) WHERE deleted_at IS NULL`；FK 复合：角色/章 CASCADE，位置 SET NULL。

```sql
-- ===== 6.5 character_states =====
CREATE TABLE IF NOT EXISTS character_states (
  id                  TEXT    PRIMARY KEY,
  project_id          TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  character_id        TEXT    NOT NULL,
  chapter_id          TEXT    NOT NULL,
  location_setting_id TEXT,
  physical_state      TEXT    NOT NULL DEFAULT '',
  mental_state        TEXT    NOT NULL DEFAULT '',
  cultivation         TEXT    NOT NULL DEFAULT '',
  abilities_json      TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(abilities_json)),
  possessions_json    TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(possessions_json)),
  knowledge_json      TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(knowledge_json)),
  status              TEXT    NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active','dead','missing','sealed','retired','unknown')),
  flags_json          TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(flags_json)),
  notes               TEXT    NOT NULL DEFAULT '',
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev                 INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id           TEXT    NOT NULL,
  deleted_at          TEXT,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, character_id)        REFERENCES characters(project_id, id)     ON DELETE CASCADE,
  FOREIGN KEY (project_id, chapter_id)          REFERENCES chapters(project_id, id)       ON DELETE CASCADE,
  FOREIGN KEY (project_id, location_setting_id) REFERENCES world_settings(project_id, id)  ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_character_states_point
  ON character_states(character_id, chapter_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_character_states_chapter
  ON character_states(chapter_id) WHERE deleted_at IS NULL;
```

---

## 7. 剧情与知识域

### 7.1 foreshadowings（伏笔）

**用途**：伏笔的埋设/强化/回收全生命周期，带重要度与预期回收章。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `title` | TEXT | NOT NULL，非空 | 伏笔名 |
| `description` | TEXT | NOT NULL DEFAULT `''` | 伏笔内容（读者看到的线索） |
| `category` | TEXT | NOT NULL DEFAULT `''` | 自由分类（信物/身世/预言/势力） |
| `status` | TEXT | NOT NULL DEFAULT `'planned'`，`CHECK IN ('planned','planted','reinforced','resolved','abandoned')` | 生命周期 |
| `importance` | INTEGER | NOT NULL DEFAULT 3，`CHECK BETWEEN 1 AND 5` | 重要度（影响审计与注入） |
| `planted_chapter_id` | TEXT | NULL | 埋设章（复合 FK SET NULL） |
| `resolved_chapter_id` | TEXT | NULL | 实际回收章（复合 FK SET NULL） |
| `planned_resolve_chapter_id` | TEXT | NULL | 计划回收章（复合 FK SET NULL） |
| `payoff_summary` | TEXT | NOT NULL DEFAULT `''` | 回收方式说明 |
| `arc_id` | TEXT | NULL | 所属故事线（复合 FK SET NULL） |
| `notes` | TEXT | NOT NULL DEFAULT `''` | 备注 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**状态一致性 CHECK（DB 强制）**

```sql
CHECK (status <> 'resolved' OR resolved_chapter_id IS NOT NULL),
CHECK (status NOT IN ('planted','reinforced','resolved') OR planted_chapter_id IS NOT NULL)
```

> 说明：章节**软删**不会触发 `SET NULL`（行仍在），因此 CHECK 仍成立；查询展示时由应用层判断章节是否已隐藏。若需要"章节软删即清引用"，走显式维护逻辑，不靠 FK。

索引/外键：`UNIQUE (project_id,id)`；`ux_foreshadow_project_title (project_id,title) WHERE deleted_at IS NULL`；`ix_foreshadow_status (project_id,status,planned_resolve_chapter_id) WHERE deleted_at IS NULL`；`ix_foreshadow_resolve (resolved_chapter_id) WHERE resolved_chapter_id IS NOT NULL`；FK 复合：各章 SET NULL，`arc_id → story_arcs SET NULL`。

```sql
-- ===== 7.1 foreshadowings =====
CREATE TABLE IF NOT EXISTS foreshadowings (
  id                       TEXT    PRIMARY KEY,
  project_id               TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title                    TEXT    NOT NULL CHECK (length(trim(title)) > 0),
  description              TEXT    NOT NULL DEFAULT '',
  category                 TEXT    NOT NULL DEFAULT '',
  status                   TEXT    NOT NULL DEFAULT 'planned'
                           CHECK (status IN ('planned','planted','reinforced','resolved','abandoned')),
  importance               INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  planted_chapter_id       TEXT,
  resolved_chapter_id      TEXT,
  planned_resolve_chapter_id TEXT,
  payoff_summary           TEXT    NOT NULL DEFAULT '',
  arc_id                   TEXT,
  notes                    TEXT    NOT NULL DEFAULT '',
  created_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at               TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev                      INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id                TEXT    NOT NULL,
  deleted_at               TEXT,
  UNIQUE (project_id, id),
  CHECK (status <> 'resolved' OR resolved_chapter_id IS NOT NULL),
  CHECK (status NOT IN ('planted','reinforced','resolved') OR planted_chapter_id IS NOT NULL),
  FOREIGN KEY (project_id, planted_chapter_id)         REFERENCES chapters(project_id, id)    ON DELETE SET NULL,
  FOREIGN KEY (project_id, resolved_chapter_id)        REFERENCES chapters(project_id, id)    ON DELETE SET NULL,
  FOREIGN KEY (project_id, planned_resolve_chapter_id) REFERENCES chapters(project_id, id)    ON DELETE SET NULL,
  FOREIGN KEY (project_id, arc_id)                     REFERENCES story_arcs(project_id, id)  ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_foreshadow_project_title
  ON foreshadowings(project_id, title) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_foreshadow_status
  ON foreshadowings(project_id, status, planned_resolve_chapter_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_foreshadow_resolve
  ON foreshadowings(resolved_chapter_id) WHERE resolved_chapter_id IS NOT NULL;
```

### 7.2 timeline_events（时间线事件）

**用途**：世界钟与叙事序双轨时间线；支持多纪元、纪元倍率换算（如「凡界 60 年 = 修仙界 30 年」）、人类可读显示与插叙/倒叙的叙事位。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `title` | TEXT | NOT NULL，非空 | 事件名 |
| `description` | TEXT | NOT NULL DEFAULT `''` | 事件描述 |
| `era` | TEXT | NOT NULL DEFAULT `''` | 纪元/时间线名（如「大衍历」「修仙界正历」） |
| `era_order` | INTEGER | NOT NULL DEFAULT 0 | 纪元全局排序（应用层维护；跨纪元排序主键） |
| `era_scale` | REAL | NOT NULL DEFAULT 1.0，`CHECK > 0` | **纪元倍率**：该纪元时间相对基准的换算系数（世界的钟可不同速） |
| `time_value` | REAL | NOT NULL DEFAULT 0 | 该纪元内的刻度值（如 312.0 = 第 312 年；允许小数表示年内位置） |
| `unit` | TEXT | NOT NULL DEFAULT `'day'`，`CHECK IN ('era','year','month','day','hour','minute','instant')` | `time_value` 的单位 |
| `display` | TEXT | NOT NULL DEFAULT `''` | 人类可读时间（「大衍历三一二年春」），展示优先用它 |
| `narrative_position` | INTEGER | NOT NULL DEFAULT 0 | 叙事排序位（章内/全书叙事顺序；插叙、倒叙用） |
| `chapter_id` | TEXT | NULL | 关联章（复合 FK SET NULL） |
| `event_type` | TEXT | NOT NULL DEFAULT `'main'`，`CHECK IN ('backstory','main','side','flashback','prophecy')` | 事件类型 |
| `importance` | INTEGER | NOT NULL DEFAULT 3，`CHECK BETWEEN 1 AND 5` | 重要度 |
| `participants_json` | TEXT | NOT NULL DEFAULT `'[]'`，`CHECK json_valid` | **JSON**：参与角色 id 数组（不建连接表，量小且仅供展示）【推断】 |
| `status` | TEXT | NOT NULL DEFAULT `'canon'`，`CHECK IN ('canon','draft','disputed')` | 正史/草稿/存疑 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**排序规则（【已定：需要 era/era_scale/time_value/unit/display/narrative_position 字段】/【推断：语义】INF-15）**

| 排序目的 | 排序键 |
|---|---|
| 世界钟（客观时间） | `era_order ASC, time_value ASC`（跨纪元换算 = `era_scale` 加权，应用层实现） |
| 叙事顺序（读者视角） | `narrative_position ASC`（同值再按 `era_order, time_value`） |
| 同章内顺序 | `chapter_id` 章号 + `narrative_position` |

索引/外键：`UNIQUE (project_id,id)`；`ix_timeline_world_clock (project_id,era_order,era,time_value) WHERE deleted_at IS NULL`；`ix_timeline_narrative (project_id,narrative_position) WHERE deleted_at IS NULL`；`ix_timeline_chapter (chapter_id) WHERE chapter_id IS NOT NULL AND deleted_at IS NULL`；FK `(project_id,chapter_id) → chapters(project_id,id) SET NULL`。

```sql
-- ===== 7.2 timeline_events =====
CREATE TABLE IF NOT EXISTS timeline_events (
  id                 TEXT    PRIMARY KEY,
  project_id         TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title              TEXT    NOT NULL CHECK (length(trim(title)) > 0),
  description        TEXT    NOT NULL DEFAULT '',
  era                TEXT    NOT NULL DEFAULT '',
  era_order          INTEGER NOT NULL DEFAULT 0,
  era_scale          REAL    NOT NULL DEFAULT 1.0 CHECK (era_scale > 0),
  time_value         REAL    NOT NULL DEFAULT 0,
  unit               TEXT    NOT NULL DEFAULT 'day'
                     CHECK (unit IN ('era','year','month','day','hour','minute','instant')),
  display            TEXT    NOT NULL DEFAULT '',
  narrative_position INTEGER NOT NULL DEFAULT 0,
  chapter_id         TEXT,
  event_type         TEXT    NOT NULL DEFAULT 'main'
                     CHECK (event_type IN ('backstory','main','side','flashback','prophecy')),
  importance         INTEGER NOT NULL DEFAULT 3 CHECK (importance BETWEEN 1 AND 5),
  participants_json  TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(participants_json)),
  status             TEXT    NOT NULL DEFAULT 'canon'
                     CHECK (status IN ('canon','draft','disputed')),
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev                INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id          TEXT    NOT NULL,
  deleted_at         TEXT,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, chapter_id) REFERENCES chapters(project_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS ix_timeline_world_clock
  ON timeline_events(project_id, era_order, era, time_value) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_timeline_narrative
  ON timeline_events(project_id, narrative_position) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_timeline_chapter
  ON timeline_events(chapter_id) WHERE chapter_id IS NOT NULL AND deleted_at IS NULL;
```

### 7.3 knowledge_relations（类型化知识关系）

**用途**：设定/角色/章节/伏笔等实体之间的类型化关系边（引用、预示、归属、冲突…），是上下文组装与一致性审计的图谱层。**旧库用 `(source_type, source_id)` 多态且无 FK，本节改为 16 个可空类型化 FK + 恰好一个非空约束**（【已定：禁止多态无 FK】/【推断：排布】INF-06）。

**支持的实体类型（每侧 8 类，源/目标对称）**

| 类型 kind | FK 列（源） | FK 列（目标） |
|---|---|---|
| character | `source_character_id` | `target_character_id` |
| world_setting | `source_world_setting_id` | `target_world_setting_id` |
| worldbook_entry | `source_worldbook_entry_id` | `target_worldbook_entry_id` |
| foreshadowing | `source_foreshadowing_id` | `target_foreshadowing_id` |
| timeline_event | `source_timeline_event_id` | `target_timeline_event_id` |
| outline | `source_outline_id` | `target_outline_id` |
| fact | `source_fact_id` | `target_fact_id` |
| chapter | `source_chapter_id` | `target_chapter_id` |

**列定义（省略 16 个 FK 列的重复说明）**

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `relation_type` | TEXT | NOT NULL，`CHECK IN ('references','foreshadows','resolves','belongs_to','located_in','member_of','owns','allies_with','conflicts_with','causes','precedes','follows','related_to','derived_from','contradicts','supports')` | 关系类型（语义见下表） |
| `source_*`（8 列） | TEXT | NULL | 源实体；**恰好一列非空** |
| `target_*`（8 列） | TEXT | NULL | 目标实体；**恰好一列非空** |
| `source_kind` | TEXT | 生成列（STORED） | 源类型标签，供索引/查询 |
| `source_id` | TEXT | 生成列（STORED） | 源实体 id（8 列 `COALESCE`） |
| `target_kind` | TEXT | 生成列（STORED） | 目标类型标签 |
| `target_id` | TEXT | 生成列（STORED） | 目标实体 id |
| `confidence` | INTEGER | NOT NULL DEFAULT 100，`CHECK BETWEEN 0 AND 100` | 置信度（AI 抽取 < 100） |
| `status` | TEXT | NOT NULL DEFAULT `'active'`，`CHECK IN ('active','proposed','retracted')` | 关系状态 |
| `note` | TEXT | NOT NULL DEFAULT `''` | 说明（为什么认为存在该关系） |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**关系类型语义（应用层按 (source_kind, target_kind) 允许矩阵校验）**

| relation_type | 语义 | 典型源 → 目标 |
|---|---|---|
| `references` | 提及/引用 | 任意 → 任意 |
| `foreshadows` | 埋设伏笔 | chapter/world_setting/worldbook_entry → foreshadowing |
| `resolves` | 回收伏笔 | chapter/foreshadowing → foreshadowing |
| `belongs_to` | 归属 | character/worldbook_entry/world_setting → world_setting/character_group |
| `located_in` | 位于 | character/timeline_event/worldbook_entry → world_setting |
| `member_of` | 成员 | character → world_setting（势力）/character_group |
| `owns` | 持有 | character → world_setting（物品）/worldbook_entry |
| `allies_with` / `conflicts_with` | 同盟/对立 | character/world_setting → 同类 |
| `causes` / `precedes` / `follows` | 因果/时序 | timeline_event/chapter/outline → 同类 |
| `related_to` | 泛关联（兜底） | 任意 → 任意 |
| `derived_from` | 派生/改编 | worldbook_entry/world_setting/fact → 同类 |
| `contradicts` | 矛盾（审计发现） | 任意 → 任意 |
| `supports` | 佐证 | fact/worldbook_entry → fact |

**为什么用"生成列 + 2 个索引"而不是 16 个索引（【推断】）**

- 16 个可空 FK 列各自建 partial index 需要 16 个索引；改用 `source_kind/source_id`、`target_kind/target_id` 两个 STORED 生成列后，只需 2 个复合索引即可覆盖"任意实体反查关系"的查询，且 FK 仍逐列生效。
- 生成列需要 SQLite ≥ 3.31（启动探针 §2.10 已要求 ≥ 3.40）。
- 唯一性：`(project_id, relation_type, source_kind, source_id, target_kind, target_id)` 唯一索引防止重复边（生成列参与唯一索引）。

**索引 / 外键**

| 对象 | 定义 | 用途 |
|---|---|---|
| `UNIQUE (project_id, id)` | 表内约束 | 复合 FK 目标 |
| `ix_kr_source` | `(source_kind, source_id) WHERE deleted_at IS NULL` | 实体反查出边 |
| `ix_kr_target` | `(target_kind, target_id) WHERE deleted_at IS NULL` | 实体反查入边 |
| `ix_kr_project_type` | `(project_id, relation_type) WHERE deleted_at IS NULL` | 按类型统计/审计 |
| `ux_kr_edge` | `(project_id, relation_type, source_kind, source_id, target_kind, target_id) WHERE deleted_at IS NULL` | 去重 |
| 16 × FK | `(project_id, source_*/target_*) → 对应表(project_id,id) CASCADE` | 类型化引用完整性 |

> 自环（同一实体指向自身）无法用跨列 CHECK 表达（SQLite 不能比较 8 个可空列是否指向同一实体），由应用层校验并在测试里覆盖（§20）。允许 `related_to` 自指的可通过开关放宽，默认禁止。

```sql
-- ===== 7.3 knowledge_relations =====
CREATE TABLE IF NOT EXISTS knowledge_relations (
  id                        TEXT    PRIMARY KEY,
  project_id                TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  relation_type             TEXT    NOT NULL CHECK (relation_type IN (
                              'references','foreshadows','resolves','belongs_to','located_in','member_of','owns',
                              'allies_with','conflicts_with','causes','precedes','follows','related_to',
                              'derived_from','contradicts','supports')),
  source_character_id       TEXT,
  source_world_setting_id   TEXT,
  source_worldbook_entry_id TEXT,
  source_foreshadowing_id   TEXT,
  source_timeline_event_id  TEXT,
  source_outline_id         TEXT,
  source_fact_id            TEXT,
  source_chapter_id         TEXT,
  target_character_id       TEXT,
  target_world_setting_id   TEXT,
  target_worldbook_entry_id TEXT,
  target_foreshadowing_id   TEXT,
  target_timeline_event_id  TEXT,
  target_outline_id         TEXT,
  target_fact_id            TEXT,
  target_chapter_id         TEXT,
  source_kind TEXT GENERATED ALWAYS AS (
    CASE
      WHEN source_character_id       IS NOT NULL THEN 'character'
      WHEN source_world_setting_id   IS NOT NULL THEN 'world_setting'
      WHEN source_worldbook_entry_id IS NOT NULL THEN 'worldbook_entry'
      WHEN source_foreshadowing_id   IS NOT NULL THEN 'foreshadowing'
      WHEN source_timeline_event_id  IS NOT NULL THEN 'timeline_event'
      WHEN source_outline_id         IS NOT NULL THEN 'outline'
      WHEN source_fact_id            IS NOT NULL THEN 'fact'
      WHEN source_chapter_id         IS NOT NULL THEN 'chapter'
    END) STORED,
  source_id TEXT GENERATED ALWAYS AS (
    COALESCE(source_character_id, source_world_setting_id, source_worldbook_entry_id,
             source_foreshadowing_id, source_timeline_event_id, source_outline_id,
             source_fact_id, source_chapter_id)) STORED,
  target_kind TEXT GENERATED ALWAYS AS (
    CASE
      WHEN target_character_id       IS NOT NULL THEN 'character'
      WHEN target_world_setting_id   IS NOT NULL THEN 'world_setting'
      WHEN target_worldbook_entry_id IS NOT NULL THEN 'worldbook_entry'
      WHEN target_foreshadowing_id   IS NOT NULL THEN 'foreshadowing'
      WHEN target_timeline_event_id  IS NOT NULL THEN 'timeline_event'
      WHEN target_outline_id         IS NOT NULL THEN 'outline'
      WHEN target_fact_id            IS NOT NULL THEN 'fact'
      WHEN target_chapter_id         IS NOT NULL THEN 'chapter'
    END) STORED,
  target_id TEXT GENERATED ALWAYS AS (
    COALESCE(target_character_id, target_world_setting_id, target_worldbook_entry_id,
             target_foreshadowing_id, target_timeline_event_id, target_outline_id,
             target_fact_id, target_chapter_id)) STORED,
  confidence INTEGER NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
  status     TEXT    NOT NULL DEFAULT 'active' CHECK (status IN ('active','proposed','retracted')),
  note       TEXT    NOT NULL DEFAULT '',
  created_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev        INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id  TEXT    NOT NULL,
  deleted_at TEXT,
  UNIQUE (project_id, id),
  CHECK ((source_character_id IS NOT NULL)
       + (source_world_setting_id IS NOT NULL)
       + (source_worldbook_entry_id IS NOT NULL)
       + (source_foreshadowing_id IS NOT NULL)
       + (source_timeline_event_id IS NOT NULL)
       + (source_outline_id IS NOT NULL)
       + (source_fact_id IS NOT NULL)
       + (source_chapter_id IS NOT NULL) = 1),
  CHECK ((target_character_id IS NOT NULL)
       + (target_world_setting_id IS NOT NULL)
       + (target_worldbook_entry_id IS NOT NULL)
       + (target_foreshadowing_id IS NOT NULL)
       + (target_timeline_event_id IS NOT NULL)
       + (target_outline_id IS NOT NULL)
       + (target_fact_id IS NOT NULL)
       + (target_chapter_id IS NOT NULL) = 1),
  FOREIGN KEY (project_id, source_character_id)       REFERENCES characters(project_id, id)        ON DELETE CASCADE,
  FOREIGN KEY (project_id, source_world_setting_id)   REFERENCES world_settings(project_id, id)    ON DELETE CASCADE,
  FOREIGN KEY (project_id, source_worldbook_entry_id) REFERENCES worldbook_entries(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, source_foreshadowing_id)   REFERENCES foreshadowings(project_id, id)    ON DELETE CASCADE,
  FOREIGN KEY (project_id, source_timeline_event_id)  REFERENCES timeline_events(project_id, id)   ON DELETE CASCADE,
  FOREIGN KEY (project_id, source_outline_id)         REFERENCES outlines(project_id, id)          ON DELETE CASCADE,
  FOREIGN KEY (project_id, source_fact_id)            REFERENCES facts_ledger(project_id, id)      ON DELETE CASCADE,
  FOREIGN KEY (project_id, source_chapter_id)         REFERENCES chapters(project_id, id)          ON DELETE CASCADE,
  FOREIGN KEY (project_id, target_character_id)       REFERENCES characters(project_id, id)        ON DELETE CASCADE,
  FOREIGN KEY (project_id, target_world_setting_id)   REFERENCES world_settings(project_id, id)    ON DELETE CASCADE,
  FOREIGN KEY (project_id, target_worldbook_entry_id) REFERENCES worldbook_entries(project_id, id) ON DELETE CASCADE,
  FOREIGN KEY (project_id, target_foreshadowing_id)   REFERENCES foreshadowings(project_id, id)    ON DELETE CASCADE,
  FOREIGN KEY (project_id, target_timeline_event_id)  REFERENCES timeline_events(project_id, id)   ON DELETE CASCADE,
  FOREIGN KEY (project_id, target_outline_id)         REFERENCES outlines(project_id, id)          ON DELETE CASCADE,
  FOREIGN KEY (project_id, target_fact_id)            REFERENCES facts_ledger(project_id, id)      ON DELETE CASCADE,
  FOREIGN KEY (project_id, target_chapter_id)         REFERENCES chapters(project_id, id)          ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ix_kr_source
  ON knowledge_relations(source_kind, source_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_kr_target
  ON knowledge_relations(target_kind, target_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_kr_project_type
  ON knowledge_relations(project_id, relation_type) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_kr_edge
  ON knowledge_relations(project_id, relation_type, source_kind, source_id, target_kind, target_id)
  WHERE deleted_at IS NULL;
```

> 说明：`knowledge_relations` 引用 `facts_ledger`，而 `facts_ledger` 在本节稍后建表 —— SQLite 允许**前向引用**（FK 在 DML 时解析）。迁移时按 §3.4 顺序建完所有表再做种子 INSERT 即可。

### 7.4 facts_ledger（事实账本）

**用途**：从正文/设定中抽取出的**可判定事实**（年龄、状态、位置、归属、能力…），用于冲突检测：同一个 `(subject, predicate)` 出现互斥值时标记 `conflict`。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `chapter_id` | TEXT | NULL | 事实来源章（复合 FK SET NULL） |
| `subject_kind` | TEXT | NOT NULL，`CHECK IN ('character','world_setting','worldbook_entry','foreshadowing','timeline_event','organization','place','item','other')` | 主体类型 |
| `subject_id` | TEXT | NOT NULL | 主体 id（**多态**，应用层校验；见下方限制说明） |
| `predicate` | TEXT | NOT NULL，非空 | 谓词（`age`/`status`/`location`/`ownership`/`ability`/自定义） |
| `value_text` | TEXT | NOT NULL DEFAULT `''` | 值的文本表示（人读、展示用） |
| `value_json` | TEXT | NULL，`CHECK (value_json IS NULL OR json_valid(value_json))` | **JSON**：结构化值（数值/数组/对象） |
| `confidence` | INTEGER | NOT NULL DEFAULT 100，`CHECK BETWEEN 0 AND 100` | 置信度 |
| `status` | TEXT | NOT NULL DEFAULT `'proposed'`，`CHECK IN ('proposed','canon','conflict','superseded')` | 状态（`canon` 才能作为写作约束） |
| `source_quote` | TEXT | NOT NULL DEFAULT `''` | 原文引用（取证用） |
| `effective_from_chapter_id` | TEXT | NULL | 从哪章起生效（复合 FK SET NULL） |
| `superseded_by_id` | TEXT | NULL | 被哪条事实取代（自表 FK SET NULL） |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**限制说明（【推断】INF-06 的取舍）**：`subject_id` 是唯一保留的多态列——事实的主体可能是"组织/地点/物品"等尚未独立成表的对象，硬拆 8 列会让本表过宽且收益低；改为**应用层白名单校验 + 测试覆盖**（§20）。若要全库零多态，可按 `knowledge_relations` 的方式扩成类型化 FK（迁移成本：加 8 列 + 回填）。

索引/外键：`UNIQUE (project_id,id)`；`ix_facts_subject (project_id,subject_kind,subject_id,status) WHERE deleted_at IS NULL`；`ix_facts_chapter (chapter_id) WHERE deleted_at IS NULL`；`ix_facts_predicate (project_id,predicate) WHERE deleted_at IS NULL`；FK 复合：来源/生效章 SET NULL；`superseded_by_id → facts_ledger(id) SET NULL`；`CHECK (superseded_by_id IS NULL OR superseded_by_id <> id)`。

```sql
-- ===== 7.4 facts_ledger =====
CREATE TABLE IF NOT EXISTS facts_ledger (
  id                         TEXT    PRIMARY KEY,
  project_id                 TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id                 TEXT,
  subject_kind               TEXT    NOT NULL
                             CHECK (subject_kind IN ('character','world_setting','worldbook_entry','foreshadowing','timeline_event','organization','place','item','other')),
  subject_id                 TEXT    NOT NULL CHECK (length(trim(subject_id)) > 0),
  predicate                  TEXT    NOT NULL CHECK (length(trim(predicate)) > 0),
  value_text                 TEXT    NOT NULL DEFAULT '',
  value_json                 TEXT    CHECK (value_json IS NULL OR json_valid(value_json)),
  confidence                 INTEGER NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
  status                     TEXT    NOT NULL DEFAULT 'proposed'
                             CHECK (status IN ('proposed','canon','conflict','superseded')),
  source_quote               TEXT    NOT NULL DEFAULT '',
  effective_from_chapter_id  TEXT,
  superseded_by_id           TEXT,
  created_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                 TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev                        INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id                  TEXT    NOT NULL,
  deleted_at                 TEXT,
  UNIQUE (project_id, id),
  CHECK (superseded_by_id IS NULL OR superseded_by_id <> id),
  FOREIGN KEY (project_id, chapter_id)                REFERENCES chapters(project_id, id) ON DELETE SET NULL,
  FOREIGN KEY (project_id, effective_from_chapter_id) REFERENCES chapters(project_id, id) ON DELETE SET NULL,
  FOREIGN KEY (superseded_by_id)                      REFERENCES facts_ledger(id)         ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS ix_facts_subject
  ON facts_ledger(project_id, subject_kind, subject_id, status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_facts_chapter
  ON facts_ledger(chapter_id) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_facts_predicate
  ON facts_ledger(project_id, predicate) WHERE deleted_at IS NULL;
```

### 7.5 scene_contracts（场景契约）

**用途**：写作前置的"场景宪法"——目标、POV、参与者、地点、节拍、硬约束、必须处理的伏笔、字数与验收状态；写作后可用它判定"这场戏是否兑现"。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `chapter_id` | TEXT | NOT NULL | 所属章（复合 FK） |
| `version` | INTEGER | NOT NULL DEFAULT 1，`CHECK >= 1` | 契约版本（锁定后新版本递增） |
| `title` | TEXT | NOT NULL DEFAULT `''` | 场景名 |
| `objective` | TEXT | NOT NULL DEFAULT `''` | 场景目标（这一场必须完成什么） |
| `pov_character_id` | TEXT | NULL | 视角角色（复合 FK SET NULL） |
| `location_setting_id` | TEXT | NULL | 地点（复合 FK SET NULL） |
| `participants_json` | TEXT | NOT NULL DEFAULT `'[]'`，`CHECK json_valid` | **JSON**：参与者角色 id 数组 |
| `beats_json` | TEXT | NOT NULL DEFAULT `'[]'`，`CHECK json_valid` | **JSON**：场景节拍（开场/发展/转折/收束） |
| `constraints_json` | TEXT | NOT NULL DEFAULT `'{}'`，`CHECK json_valid` | **JSON**：硬约束（禁忌、必须遵守的设定、语言要求） |
| `required_foreshadowing_ids_json` | TEXT | NOT NULL DEFAULT `'[]'`，`CHECK json_valid` | **JSON**：本场必须处理的伏笔 id（应用层校验存在性） |
| `forbidden_json` | TEXT | NOT NULL DEFAULT `'[]'`，`CHECK json_valid` | **JSON**：禁止事项（不得写死某人/不得出现某物） |
| `target_words` | INTEGER | NULL，`CHECK > 0` | 目标字数 |
| `tone` | TEXT | NOT NULL DEFAULT `''` | 情绪基调 |
| `status` | TEXT | NOT NULL DEFAULT `'draft'`，`CHECK IN ('draft','locked','fulfilled','failed','cancelled')` | 状态（`locked` 后才允许生成正文） |
| `locked_at` | TEXT | NULL | 锁定时间 |
| `generated_chapter_version_id` | TEXT | NULL，FK→`chapter_versions(id)` SET NULL | 兑现该契约的正文版本 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**规则**：`UNIQUE (chapter_id, version) WHERE deleted_at IS NULL`；一章可有多版契约，仅一版可 `locked`/`fulfilled`（应用层保证，DB 不强制）；`status='locked'` 后字段冻结（应用层；或后续加触发器）。

索引/外键：`UNIQUE (project_id,id)`；`ux_scene_contract_version (chapter_id,version) WHERE deleted_at IS NULL`；`ix_scene_contract_status (project_id,status) WHERE deleted_at IS NULL`；FK 复合：章 CASCADE，POV/地点 SET NULL，`generated_chapter_version_id → chapter_versions(id) SET NULL`。

```sql
-- ===== 7.5 scene_contracts =====
CREATE TABLE IF NOT EXISTS scene_contracts (
  id                             TEXT    PRIMARY KEY,
  project_id                     TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id                     TEXT    NOT NULL,
  version                        INTEGER NOT NULL DEFAULT 1 CHECK (version >= 1),
  title                          TEXT    NOT NULL DEFAULT '',
  objective                      TEXT    NOT NULL DEFAULT '',
  pov_character_id               TEXT,
  location_setting_id            TEXT,
  participants_json              TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(participants_json)),
  beats_json                     TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(beats_json)),
  constraints_json               TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(constraints_json)),
  required_foreshadowing_ids_json TEXT   NOT NULL DEFAULT '[]' CHECK (json_valid(required_foreshadowing_ids_json)),
  forbidden_json                 TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(forbidden_json)),
  target_words                   INTEGER CHECK (target_words IS NULL OR target_words > 0),
  tone                           TEXT    NOT NULL DEFAULT '',
  status                         TEXT    NOT NULL DEFAULT 'draft'
                                 CHECK (status IN ('draft','locked','fulfilled','failed','cancelled')),
  locked_at                      TEXT,
  generated_chapter_version_id   TEXT REFERENCES chapter_versions(id) ON DELETE SET NULL,
  created_at                     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at                     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev                            INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id                      TEXT    NOT NULL,
  deleted_at                     TEXT,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, chapter_id)          REFERENCES chapters(project_id, id)       ON DELETE CASCADE,
  FOREIGN KEY (project_id, pov_character_id)    REFERENCES characters(project_id, id)     ON DELETE SET NULL,
  FOREIGN KEY (project_id, location_setting_id) REFERENCES world_settings(project_id, id)  ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_scene_contract_version
  ON scene_contracts(chapter_id, version) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_scene_contract_status
  ON scene_contracts(project_id, status) WHERE deleted_at IS NULL;
```

---

## 8. AI 工作流域

### 8.1 proposals（变更提议）

**用途**：AI / 审计 / 用户提出的**待采纳变更**（改写章节、调整设定、合并角色…）；采纳后按提议改写业务表并生成 `revisions` 记录。提议本身是"候选真相"，不直接进正文。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `target_kind` | TEXT | NOT NULL，FK→`entity_kinds(kind)` RESTRICT | 目标实体类型 |
| `target_id` | TEXT | NULL | 目标实体 id；NULL = 新建实体（如新建伏笔） |
| `base_rev` | INTEGER | NULL，`CHECK >= 1` | 提议基于的目标 `rev`（应用时校验是否已被他处改动） |
| `payload_json` | TEXT | NOT NULL，`CHECK json_valid` | **JSON**：变更内容（按 `patch_format` 解释） |
| `patch_format` | TEXT | NOT NULL DEFAULT `'json_patch'`，`CHECK IN ('json_patch','full_replace','markdown','sql')` | 变更表达方式 |
| `rationale` | TEXT | NOT NULL DEFAULT `''` | 为什么提议（模型/审计的解释） |
| `source` | TEXT | NOT NULL DEFAULT `'ai'`，`CHECK IN ('ai','audit','user','import','extraction')` | 提议来源 |
| `audit_run_id` | TEXT | NULL，FK→`audit_runs(id)` SET NULL | 若由审计发现生成 |
| `status` | TEXT | NOT NULL DEFAULT `'pending'`，`CHECK IN ('pending','accepted','rejected','applied','superseded','expired')` | 生命周期 |
| `decided_at` | TEXT | NULL | 决策时间 |
| `decided_by` | TEXT | NULL | 决策者（用户标识/规则名） |
| `decision_note` | TEXT | NOT NULL DEFAULT `''` | 决策备注 |
| `applied_revision_id` | TEXT | NULL，FK→`revisions(id)` SET NULL | 采纳后生成的修订记录 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**生命周期与副作用**

| 状态 | 含义 | 副作用 |
|---|---|---|
| `pending` | 待决策 | 只读；可被 `superseded` |
| `accepted` | 已批准但未应用 | 应用事务成功后才置 `applied` |
| `rejected` | 已拒绝 | 保留原因，供模型少走弯路 |
| `applied` | 已写入业务表 | 必须挂 `applied_revision_id` |
| `superseded` | 被更新的提议取代 | 不删除，保留审计 |
| `expired` | 超出时效（如 base_rev 已落后） | 应用层在应用前检查 `base_rev` |

**应用事务（必须在一个事务内完成）**：① 校验 `base_rev` 与目标状态 → ② 按 `payload_json` 更新目标业务表（`rev+1`、`updated_at`、`device_id`）→ ③ 写 `revisions`（含前/后快照）→ ④ 更新 proposal 状态与 `applied_revision_id` → ⑤ 写 `change_log`（目标实体 + proposal 所在表各一条）→ ⑥ COMMIT。

索引/外键：`UNIQUE (project_id,id)`；`ix_proposals_project_status (project_id,status,created_at) WHERE deleted_at IS NULL`；`ix_proposals_target (target_kind,target_id) WHERE target_id IS NOT NULL`；FK `target_kind → entity_kinds(kind)`、`audit_run_id → audit_runs(id) SET NULL`、`applied_revision_id → revisions(id) SET NULL`；`CHECK (target_id IS NULL OR target_kind IS NOT NULL)` 由 `target_kind NOT NULL` 直接保证。

```sql
-- ===== 8.1 proposals =====
CREATE TABLE IF NOT EXISTS proposals (
  id                  TEXT    PRIMARY KEY,
  project_id          TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_kind         TEXT    NOT NULL REFERENCES entity_kinds(kind) ON DELETE RESTRICT,
  target_id           TEXT,
  base_rev            INTEGER CHECK (base_rev IS NULL OR base_rev >= 1),
  payload_json        TEXT    NOT NULL CHECK (json_valid(payload_json)),
  patch_format        TEXT    NOT NULL DEFAULT 'json_patch'
                      CHECK (patch_format IN ('json_patch','full_replace','markdown','sql')),
  rationale           TEXT    NOT NULL DEFAULT '',
  source              TEXT    NOT NULL DEFAULT 'ai'
                      CHECK (source IN ('ai','audit','user','import','extraction')),
  audit_run_id        TEXT,
  status              TEXT    NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','accepted','rejected','applied','superseded','expired')),
  decided_at          TEXT,
  decided_by          TEXT,
  decision_note       TEXT    NOT NULL DEFAULT '',
  applied_revision_id TEXT,
  created_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev                 INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id           TEXT    NOT NULL,
  deleted_at          TEXT,
  UNIQUE (project_id, id),
  CHECK (status <> 'applied' OR applied_revision_id IS NOT NULL),
  FOREIGN KEY (audit_run_id)        REFERENCES audit_runs(id) ON DELETE SET NULL,
  FOREIGN KEY (applied_revision_id) REFERENCES revisions(id)  ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS ix_proposals_project_status
  ON proposals(project_id, status, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_proposals_target
  ON proposals(target_kind, target_id) WHERE target_id IS NOT NULL;
```

### 8.2 revisions（修订历史）

**用途**：已发生变更的**不可变**审计历史（谁/哪个设备/什么来源/前后内容），与 `chapter_versions`（正文本体）互补：正文大文本只存版本表，`revisions` 存元数据级前后快照（不重复存正文，避免双份膨胀）。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `target_kind` | TEXT | NOT NULL，FK→`entity_kinds(kind)` RESTRICT | 目标实体类型 |
| `target_id` | TEXT | NOT NULL | 目标实体 id |
| `rev_no` | INTEGER | NOT NULL，`CHECK >= 1` | 目标实体的第几次修订（与 `rev` 对应） |
| `change_kind` | TEXT | NOT NULL，`CHECK IN ('create','update','delete','restore','merge')` | 变更种类 |
| `snapshot_json` | TEXT | NULL，`CHECK (snapshot_json IS NULL OR json_valid(snapshot_json))` | **JSON**：变更后整行快照（delete 存删除前快照） |
| `patch_json` | TEXT | NULL，`CHECK (patch_json IS NULL OR json_valid(patch_json))` | **JSON**：字段级变更（`{列: 新值}`） |
| `summary` | TEXT | NOT NULL DEFAULT `''` | 人读摘要（「把赵横境界改为后天巅峰」） |
| `source` | TEXT | NOT NULL DEFAULT `'human'`，`CHECK IN ('human','ai','audit','import','migration','sync')` | 变更来源 |
| `proposal_id` | TEXT | NULL，FK→`proposals(id)` SET NULL | 由哪条提议触发 |
| `chapter_version_id` | TEXT | NULL，FK→`chapter_versions(id)` SET NULL | 正文变更指向的版本（正文本身不复制进来） |
| `created_at` | TEXT | NOT NULL，UTC ISO 默认 now | 追加型：无 `updated_at` |
| `device_id` | TEXT | NOT NULL | 写入设备 |

**约束**：`UNIQUE (project_id, id)`；`CHECK (change_kind <> 'delete' OR snapshot_json IS NOT NULL)`；`CHECK (snapshot_json IS NOT NULL OR patch_json IS NOT NULL)`；`ux_revisions_target_rev (project_id,target_kind,target_id,rev_no)`；触发器 `trg_revisions_no_update` 禁止 UPDATE。

```sql
-- ===== 8.2 revisions =====
CREATE TABLE IF NOT EXISTS revisions (
  id                 TEXT    PRIMARY KEY,
  project_id         TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  target_kind        TEXT    NOT NULL REFERENCES entity_kinds(kind) ON DELETE RESTRICT,
  target_id          TEXT    NOT NULL CHECK (length(trim(target_id)) > 0),
  rev_no             INTEGER NOT NULL CHECK (rev_no >= 1),
  change_kind        TEXT    NOT NULL
                     CHECK (change_kind IN ('create','update','delete','restore','merge')),
  snapshot_json      TEXT    CHECK (snapshot_json IS NULL OR json_valid(snapshot_json)),
  patch_json         TEXT    CHECK (patch_json IS NULL OR json_valid(patch_json)),
  summary            TEXT    NOT NULL DEFAULT '',
  source             TEXT    NOT NULL DEFAULT 'human'
                     CHECK (source IN ('human','ai','audit','import','migration','sync')),
  proposal_id        TEXT REFERENCES proposals(id)        ON DELETE SET NULL,
  chapter_version_id TEXT REFERENCES chapter_versions(id) ON DELETE SET NULL,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  device_id          TEXT    NOT NULL,
  UNIQUE (project_id, id),
  CHECK (change_kind <> 'delete' OR snapshot_json IS NOT NULL),
  CHECK (snapshot_json IS NOT NULL OR patch_json IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_revisions_target_rev
  ON revisions(project_id, target_kind, target_id, rev_no);
CREATE INDEX IF NOT EXISTS ix_revisions_project_time
  ON revisions(project_id, created_at);
CREATE INDEX IF NOT EXISTS ix_revisions_target
  ON revisions(target_kind, target_id, created_at);

CREATE TRIGGER IF NOT EXISTS trg_revisions_no_update
BEFORE UPDATE ON revisions
BEGIN
  SELECT RAISE(ABORT, 'revisions is append-only');
END;
```

### 8.3 audit_runs（审计运行）

**用途**：一次一致性/质量审计（项目级、卷级、章级、单实体级、抽取级）的运行记录，含 findings 与指标。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `scope` | TEXT | NOT NULL，`CHECK IN ('project','volume','chapter','entity','extraction')` | 审计范围 |
| `target_kind` | TEXT | NULL，FK→`entity_kinds(kind)` RESTRICT | scope=entity 时的实体类型 |
| `target_id` | TEXT | NULL | scope=entity 时的实体 id |
| `rule_set` | TEXT | NOT NULL DEFAULT `'builtin:consistency-v1'` | 规则集标识（可扩展） |
| `model` | TEXT | NOT NULL DEFAULT `''` | 使用的模型（空 = 纯规则审计） |
| `status` | TEXT | NOT NULL DEFAULT `'queued'`，`CHECK IN ('queued','running','succeeded','failed','cancelled')` | 运行状态 |
| `findings_json` | TEXT | NOT NULL DEFAULT `'[]'`，`CHECK json_valid` | **JSON**：发现列表（`{severity,code,message,entity_kind,entity_id,chapter_id}`） |
| `metrics_json` | TEXT | NOT NULL DEFAULT `'{}'`，`CHECK json_valid` | **JSON**：指标（计数、耗时、token 用量） |
| `error_text` | TEXT | NOT NULL DEFAULT `''` | 失败原因 |
| `started_at` / `finished_at` | TEXT | NULL | 实际起止 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**约束**：`UNIQUE (project_id,id)`；scope 与目标的组合 CHECK：

```sql
CHECK (
     (scope = 'entity' AND target_kind IS NOT NULL AND target_id IS NOT NULL)
  OR (scope IN ('volume','chapter') AND target_id IS NOT NULL)
  OR (scope IN ('project','extraction') AND target_kind IS NULL AND target_id IS NULL)
)
```

索引：`ix_audit_runs_project (project_id,status,created_at) WHERE deleted_at IS NULL`；`ix_audit_runs_target (target_kind,target_id)`。

```sql
-- ===== 8.3 audit_runs =====
CREATE TABLE IF NOT EXISTS audit_runs (
  id            TEXT    PRIMARY KEY,
  project_id    TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  scope         TEXT    NOT NULL CHECK (scope IN ('project','volume','chapter','entity','extraction')),
  target_kind   TEXT    REFERENCES entity_kinds(kind) ON DELETE RESTRICT,
  target_id     TEXT,
  rule_set      TEXT    NOT NULL DEFAULT 'builtin:consistency-v1',
  model         TEXT    NOT NULL DEFAULT '',
  status        TEXT    NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued','running','succeeded','failed','cancelled')),
  findings_json TEXT    NOT NULL DEFAULT '[]' CHECK (json_valid(findings_json)),
  metrics_json  TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(metrics_json)),
  error_text    TEXT    NOT NULL DEFAULT '',
  started_at    TEXT,
  finished_at   TEXT,
  created_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev           INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id     TEXT    NOT NULL,
  deleted_at    TEXT,
  UNIQUE (project_id, id),
  CHECK (
       (scope = 'entity' AND target_kind IS NOT NULL AND target_id IS NOT NULL)
    OR (scope IN ('volume','chapter') AND target_id IS NOT NULL)
    OR (scope IN ('project','extraction') AND target_kind IS NULL AND target_id IS NULL)
  )
);
CREATE INDEX IF NOT EXISTS ix_audit_runs_project
  ON audit_runs(project_id, status, created_at) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_audit_runs_target
  ON audit_runs(target_kind, target_id) WHERE deleted_at IS NULL;
```

### 8.4 extraction_staging（抽取暂存区）

**用途**：从正文/设定中抽取出的候选实体与关系**先进暂存区**，人工/规则确认后再合并进正式表（避免 AI 抽取直接污染真相源）。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `chapter_id` | TEXT | NULL，FK→`chapters` SET NULL | 抽取来源章 |
| `source_kind` | TEXT | NOT NULL DEFAULT `'llm'`，`CHECK IN ('llm','rule','import')` | 抽取方式（LLM / 规则 / 导入） |
| `entity_kind` | TEXT | NOT NULL，FK→`entity_kinds(kind)` RESTRICT | 候选实体类型 |
| `payload_json` | TEXT | NOT NULL，`CHECK json_valid` | **JSON**：候选实体字段 |
| `normalized_json` | TEXT | NULL，`CHECK (normalized_json IS NULL OR json_valid(normalized_json))` | **JSON**：归一化后的字段（去重/对齐用） |
| `confidence` | INTEGER | NOT NULL DEFAULT 100，`CHECK BETWEEN 0 AND 100` | 置信度 |
| `status` | TEXT | NOT NULL DEFAULT `'pending'`，`CHECK IN ('pending','accepted','rejected','merged','conflict')` | 暂存状态 |
| `target_kind` | TEXT | NULL，FK→`entity_kinds(kind)` RESTRICT | 采纳/合并目标类型 |
| `target_id` | TEXT | NULL | 采纳/合并目标 id |
| `merge_strategy` | TEXT | NULL，`CHECK (merge_strategy IS NULL OR merge_strategy IN ('append','replace','skip','manual'))` | 合并策略 |
| `reviewed_at` | TEXT | NULL | 审阅时间 |
| `review_note` | TEXT | NOT NULL DEFAULT `''` | 审阅备注 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

索引/外键：`UNIQUE (project_id,id)`；`ix_extraction_status (project_id,status,entity_kind) WHERE deleted_at IS NULL`；`ix_extraction_chapter (chapter_id) WHERE chapter_id IS NOT NULL`；FK `(project_id,chapter_id) → chapters SET NULL`，`entity_kind/target_kind → entity_kinds(kind)`；`CHECK (target_id IS NULL OR target_kind IS NOT NULL)`。

```sql
-- ===== 8.4 extraction_staging =====
CREATE TABLE IF NOT EXISTS extraction_staging (
  id              TEXT    PRIMARY KEY,
  project_id      TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  chapter_id      TEXT,
  source_kind     TEXT    NOT NULL DEFAULT 'llm' CHECK (source_kind IN ('llm','rule','import')),
  entity_kind     TEXT    NOT NULL REFERENCES entity_kinds(kind) ON DELETE RESTRICT,
  payload_json    TEXT    NOT NULL CHECK (json_valid(payload_json)),
  normalized_json TEXT    CHECK (normalized_json IS NULL OR json_valid(normalized_json)),
  confidence      INTEGER NOT NULL DEFAULT 100 CHECK (confidence BETWEEN 0 AND 100),
  status          TEXT    NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','accepted','rejected','merged','conflict')),
  target_kind     TEXT    REFERENCES entity_kinds(kind) ON DELETE RESTRICT,
  target_id       TEXT,
  merge_strategy  TEXT    CHECK (merge_strategy IS NULL OR merge_strategy IN ('append','replace','skip','manual')),
  reviewed_at     TEXT,
  review_note     TEXT    NOT NULL DEFAULT '',
  created_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev             INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id       TEXT    NOT NULL,
  deleted_at      TEXT,
  UNIQUE (project_id, id),
  CHECK (target_id IS NULL OR target_kind IS NOT NULL),
  FOREIGN KEY (project_id, chapter_id) REFERENCES chapters(project_id, id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS ix_extraction_status
  ON extraction_staging(project_id, status, entity_kind) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS ix_extraction_chapter
  ON extraction_staging(chapter_id) WHERE chapter_id IS NOT NULL;
```

---

## 9. 辅助域：地图 / 设置

### 9.1 maps（地图）

**用途**：作品的世界地图/区域图/建筑图；图钉落在 `map_pins`。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目 |
| `name` | TEXT | NOT NULL，非空 | 地图名 |
| `kind` | TEXT | NOT NULL DEFAULT `'custom'`，`CHECK IN ('world','region','city','building','dungeon','custom')` | 地图类型 |
| `world_setting_id` | TEXT | NULL | 对应世界观条目（复合 FK SET NULL） |
| `background_ref` | TEXT | NULL | 背景图相对路径（文件系统，不存 BLOB）【推断】 |
| `width` / `height` | INTEGER | NULL，`CHECK > 0` | 像素尺寸（用于坐标换算） |
| `scale_json` | TEXT | NOT NULL DEFAULT `'{}'`，`CHECK json_valid` | **JSON**：比例尺/图例配置 |
| `description` | TEXT | NOT NULL DEFAULT `''` | 说明 |
| `sort_index` | INTEGER | NOT NULL DEFAULT 0 | 列表排序 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

### 9.2 map_pins（地图图钉）

**用途**：地图上的标记点，可绑定到设定/角色/章节/伏笔/事件之一（至多一个）。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `project_id` | TEXT | NOT NULL，FK→`projects(id)` CASCADE | 所属项目（供复合 FK） |
| `map_id` | TEXT | NOT NULL | 所属地图（复合 FK） |
| `x` / `y` | REAL | NOT NULL，`CHECK BETWEEN 0 AND 1` | **归一化坐标**（与图片分辨率解耦）【推断】 |
| `pin_kind` | TEXT | NOT NULL DEFAULT `'location'`，`CHECK IN ('location','character','event','foreshadowing','note','other')` | 图钉类型 |
| `label` | TEXT | NOT NULL DEFAULT `''` | 显示标签 |
| `world_setting_id` / `character_id` / `chapter_id` / `foreshadowing_id` / `timeline_event_id` | TEXT | NULL | 绑定目标（至多一个） |
| `note` | TEXT | NOT NULL DEFAULT `''` | 备注 |
| `order_index` | INTEGER | NOT NULL DEFAULT 0 | 同地图内排序 |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**约束**：`CHECK ((world_setting_id IS NOT NULL) + (character_id IS NOT NULL) + (chapter_id IS NOT NULL) + (foreshadowing_id IS NOT NULL) + (timeline_event_id IS NOT NULL) <= 1)`；索引 `ix_map_pins_map (map_id,order_index) WHERE deleted_at IS NULL`。

```sql
-- ===== 9.1 maps =====
CREATE TABLE IF NOT EXISTS maps (
  id               TEXT    PRIMARY KEY,
  project_id       TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name             TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  kind             TEXT    NOT NULL DEFAULT 'custom'
                   CHECK (kind IN ('world','region','city','building','dungeon','custom')),
  world_setting_id TEXT,
  background_ref   TEXT,
  width            INTEGER CHECK (width IS NULL OR width > 0),
  height           INTEGER CHECK (height IS NULL OR height > 0),
  scale_json       TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(scale_json)),
  description      TEXT    NOT NULL DEFAULT '',
  sort_index       INTEGER NOT NULL DEFAULT 0,
  created_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev              INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id        TEXT    NOT NULL,
  deleted_at       TEXT,
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, world_setting_id) REFERENCES world_settings(project_id, id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_maps_project_name
  ON maps(project_id, name) WHERE deleted_at IS NULL;

-- ===== 9.2 map_pins =====
CREATE TABLE IF NOT EXISTS map_pins (
  id                 TEXT    PRIMARY KEY,
  project_id         TEXT    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  map_id             TEXT    NOT NULL,
  x                  REAL    NOT NULL CHECK (x BETWEEN 0 AND 1),
  y                  REAL    NOT NULL CHECK (y BETWEEN 0 AND 1),
  pin_kind           TEXT    NOT NULL DEFAULT 'location'
                     CHECK (pin_kind IN ('location','character','event','foreshadowing','note','other')),
  label              TEXT    NOT NULL DEFAULT '',
  world_setting_id   TEXT,
  character_id       TEXT,
  chapter_id         TEXT,
  foreshadowing_id   TEXT,
  timeline_event_id  TEXT,
  note               TEXT    NOT NULL DEFAULT '',
  order_index        INTEGER NOT NULL DEFAULT 0,
  created_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at         TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev                INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id          TEXT    NOT NULL,
  deleted_at         TEXT,
  UNIQUE (project_id, id),
  CHECK ((world_setting_id IS NOT NULL)
       + (character_id IS NOT NULL)
       + (chapter_id IS NOT NULL)
       + (foreshadowing_id IS NOT NULL)
       + (timeline_event_id IS NOT NULL) <= 1),
  FOREIGN KEY (project_id, map_id)             REFERENCES maps(project_id, id)            ON DELETE CASCADE,
  FOREIGN KEY (project_id, world_setting_id)   REFERENCES world_settings(project_id, id)   ON DELETE SET NULL,
  FOREIGN KEY (project_id, character_id)       REFERENCES characters(project_id, id)       ON DELETE SET NULL,
  FOREIGN KEY (project_id, chapter_id)         REFERENCES chapters(project_id, id)         ON DELETE SET NULL,
  FOREIGN KEY (project_id, foreshadowing_id)   REFERENCES foreshadowings(project_id, id)   ON DELETE SET NULL,
  FOREIGN KEY (project_id, timeline_event_id)  REFERENCES timeline_events(project_id, id)  ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS ix_map_pins_map
  ON map_pins(map_id, order_index) WHERE deleted_at IS NULL;
```

### 9.3 app_settings（应用/项目设置）

**用途**：键值配置（应用级 + 项目级覆盖）：`device_id`、UI 偏好、写作默认参数、导出/同步开关等。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `id` | TEXT | PK | UUID v7 |
| `scope` | TEXT | NOT NULL DEFAULT `'app'`，`CHECK IN ('app','project')` | 作用域 |
| `project_id` | TEXT | NULL，FK→`projects(id)` CASCADE | scope=project 时必填 |
| `key` | TEXT | NOT NULL，非空 | 键（点分命名，如 `writing.default_model`） |
| `value_json` | TEXT | NOT NULL，`CHECK json_valid` | **JSON**：值（字符串/数字/布尔/对象统一 JSON 承载） |
| `created_at` / `updated_at` / `rev` / `device_id` / `deleted_at` | — | — | §2.2 / §2.3 |

**约束**：`CHECK ((scope='app' AND project_id IS NULL) OR (scope='project' AND project_id IS NOT NULL))`；唯一性用两条部分唯一索引（`app` 级 `(key)`、`project` 级 `(project_id,key)`）。

**已知键（【推断】INF-18）**

| key | scope | 值类型 | 用途 |
|---|---|---|---|
| `device_id` | app | string | 本设备 UUID v7（写入 `device_id` 列的来源） |
| `db.schema_version_seen` | app | number | 首次启动时看到的 schema 版本（升级提示） |
| `ui.theme` / `ui.locale` | app | string | 界面偏好 |
| `writing.default_model` | app/project | string | 默认模型 |
| `writing.default_target_words` | app/project | number | 默认章目标字数 |
| `writing.style_profile` | app/project | object | 文风参数（赛道/句长/禁词） |
| `context.token_budget` | app/project | object | 上下文预算分配 |
| `export.watermark.seq` | app | number | 最近成功导出到的 `change_log.seq`（冗余于 `sync_state`，便于诊断） |
| `capabilities.fts5` | app | boolean | 启动探针结果（false 时检索降级） |

```sql
-- ===== 9.3 app_settings =====
CREATE TABLE IF NOT EXISTS app_settings (
  id          TEXT    PRIMARY KEY,
  scope       TEXT    NOT NULL DEFAULT 'app' CHECK (scope IN ('app','project')),
  project_id  TEXT    REFERENCES projects(id) ON DELETE CASCADE,
  key         TEXT    NOT NULL CHECK (length(trim(key)) > 0),
  value_json  TEXT    NOT NULL CHECK (json_valid(value_json)),
  created_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  rev         INTEGER NOT NULL DEFAULT 1 CHECK (rev >= 1),
  device_id   TEXT    NOT NULL,
  deleted_at  TEXT,
  CHECK ((scope = 'app' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_app_settings_app
  ON app_settings(key) WHERE scope = 'app' AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ux_app_settings_project
  ON app_settings(project_id, key) WHERE scope = 'project' AND deleted_at IS NULL;
```

---

## 10. 同步预留：change_log / sync_state

> 第一阶段**不实现任何网络同步**：本节只保证"未来加同步不需要改表结构"。所有写路径从第一天起就写 `change_log`，即使暂时只有本机消费者（导出器）。

### 10.1 change_log（变更日志 / outbox）

**用途**：append-only 的变更流水，是导出与未来增量同步的唯一增量来源。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `seq` | INTEGER | PK AUTOINCREMENT | 单调递增，**同步游标的唯一依据**（不用时间戳） |
| `project_id` | TEXT | NULL | 所属项目（应用级设置变更可空） |
| `entity_table` | TEXT | NOT NULL，非空 | 物理表名（白名单见下；**DB 无法 FK 到表名**，应用层校验） |
| `entity_id` | TEXT | NOT NULL | 实体主键 |
| `op` | TEXT | NOT NULL，`CHECK IN ('insert','update','delete')` | 操作（delete = tombstone） |
| `rev` | INTEGER | NOT NULL，`CHECK >= 1` | 变更后实体的 `rev`（幂等/冲突判定） |
| `device_id` | TEXT | NOT NULL | 写入设备 |
| `changed_at` | TEXT | NOT NULL，UTC ISO 默认 now | 变更时间（仅供展示/清理，不用于排序） |
| `payload_mode` | TEXT | NOT NULL DEFAULT `'snapshot'`，`CHECK IN ('snapshot','patch')` | 载荷模式 |
| `payload_json` | TEXT | NOT NULL，`CHECK json_valid` | **JSON**：`snapshot` = 变更后整行（delete 为删除前整行）；`patch` = `{列:新值}` |
| `meta_json` | TEXT | NOT NULL DEFAULT `'{}'`，`CHECK json_valid` | **JSON**：附加信息（来源客户端、冲突标记） |

**`entity_table` 白名单**（应用层常量，与 §3.2 业务表名一致）：`projects`、`volumes`、`chapters`、`chapter_versions`、`outlines`、`outline_plot_points`、`story_arcs`、`world_setting_categories`、`world_settings`、`worldbook_entries`、`characters`、`character_groups`、`character_group_members`、`character_relations`、`character_voice`、`character_states`、`foreshadowings`、`timeline_events`、`knowledge_relations`、`facts_ledger`、`scene_contracts`、`proposals`、`revisions`、`audit_runs`、`extraction_staging`、`maps`、`map_pins`、`app_settings`。FTS/派生表（`chapter_index`、`fts_*`）与 `change_log` 自身**不写**日志（派生数据可重建）。

**默认 `snapshot` 的理由（【推断】INF-19）**：并发冲突合并时整行快照可直接做 last-write-wins / 字段级三方合并；`patch` 在乱序、重放、部分字段并发时难以保证可重放。代价是日志体积大 → 通过保留期清理（§10.4）控制。

**索引**：`ix_change_log_entity (entity_table, entity_id, seq)`；`ix_change_log_project (project_id, seq) WHERE project_id IS NOT NULL`；`ix_change_log_changed_at (changed_at)`；触发器 `trg_change_log_no_update` 禁止 UPDATE（保留 DELETE 供保留期清理）。

```sql
-- ===== 10.1 change_log =====
CREATE TABLE IF NOT EXISTS change_log (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   TEXT,
  entity_table TEXT    NOT NULL CHECK (length(trim(entity_table)) > 0),
  entity_id    TEXT    NOT NULL CHECK (length(trim(entity_id)) > 0),
  op           TEXT    NOT NULL CHECK (op IN ('insert','update','delete')),
  rev          INTEGER NOT NULL CHECK (rev >= 1),
  device_id    TEXT    NOT NULL,
  changed_at   TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  payload_mode TEXT    NOT NULL DEFAULT 'snapshot' CHECK (payload_mode IN ('snapshot','patch')),
  payload_json TEXT    NOT NULL CHECK (json_valid(payload_json)),
  meta_json    TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json))
);
CREATE INDEX IF NOT EXISTS ix_change_log_entity
  ON change_log(entity_table, entity_id, seq);
CREATE INDEX IF NOT EXISTS ix_change_log_project
  ON change_log(project_id, seq) WHERE project_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_change_log_changed_at
  ON change_log(changed_at);

CREATE TRIGGER IF NOT EXISTS trg_change_log_no_update
BEFORE UPDATE ON change_log
BEGIN
  SELECT RAISE(ABORT, 'change_log is append-only');
END;
```

### 10.2 sync_state（同步游标）

**用途**：每个同步对端/导出消费者的进度游标；第一阶段至少有 `peer_id='local-export'`（Markdown/JSON 导出器）。

| 列 | 类型 | 约束/默认 | 说明 |
|---|---|---|---|
| `peer_id` | TEXT | PK | 对端标识：`local-export` / `server:<url>` / 其他 `device_id` |
| `local_device_id` | TEXT | NOT NULL | 本机设备 id（冗余便于诊断） |
| `push_cursor` | INTEGER | NOT NULL DEFAULT 0，`CHECK >= 0` | 已成功推送给该对端的最大 `change_log.seq` |
| `pull_cursor` | INTEGER | NOT NULL DEFAULT 0，`CHECK >= 0` | 已从该对端应用的最大远端游标 |
| `last_synced_at` | TEXT | NULL | 最近成功同步时间 |
| `last_error` | TEXT | NOT NULL DEFAULT `''` | 最近失败原因（空 = 正常） |
| `meta_json` | TEXT | NOT NULL DEFAULT `'{}'`，`CHECK json_valid` | **JSON**：对端能力/压缩/冲突统计 |
| `updated_at` | TEXT | NOT NULL，UTC ISO 默认 now | 追加语义的游标表，仅 UPDATE 这两个游标 |

```sql
-- ===== 10.2 sync_state =====
CREATE TABLE IF NOT EXISTS sync_state (
  peer_id         TEXT    PRIMARY KEY,
  local_device_id TEXT    NOT NULL,
  push_cursor     INTEGER NOT NULL DEFAULT 0 CHECK (push_cursor >= 0),
  pull_cursor     INTEGER NOT NULL DEFAULT 0 CHECK (pull_cursor >= 0),
  last_synced_at  TEXT,
  last_error      TEXT    NOT NULL DEFAULT '',
  meta_json       TEXT    NOT NULL DEFAULT '{}' CHECK (json_valid(meta_json)),
  updated_at      TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
```

### 10.3 写入协议（每个业务变更的事务模板）

**规则**：业务写与 `change_log` 必须同事务提交；`rev`/`updated_at`/`device_id` 由仓储层统一赋值；任何绕过仓储层的裸 UPDATE 视为 bug（代码评审 + lint 规则）。

```sql
-- 统一写事务模板（示意，非实际可执行脚本）
BEGIN IMMEDIATE;
-- 1) 读当前 rev（乐观锁）
--    SELECT rev FROM characters WHERE id = :id;
-- 2) 更新业务行（rev 比对失败则回滚重试）
UPDATE characters
   SET name = :name,
       updated_at = :now_iso,
       rev = rev + 1,
       device_id = :device_id
 WHERE id = :id AND rev = :base_rev AND deleted_at IS NULL;
-- 3) 追加变更日志（payload = 变更后整行）
INSERT INTO change_log (project_id, entity_table, entity_id, op, rev, device_id, payload_mode, payload_json)
VALUES (:project_id, 'characters', :id, 'update', :base_rev + 1, :device_id, 'snapshot', :row_json);
COMMIT;
```

### 10.4 导出与保留期（【推断】）

| 项 | 规则 |
|---|---|
| 导出 watermark | 导出器以 `peer_id='local-export'` 的 `push_cursor` 为水位：只导出 `seq > push_cursor` 的项目；导出成功（文件落盘 + git commit 可选）后再推进游标 |
| 导出物 | Markdown/JSON 是**派生物**：允许删除重建，**不得反向写库** |
| 日志保留 | 每对端游标推进后，可清理 `seq <= MIN(push_cursor) AND changed_at < now-180d` 的行（保留期可配置）；清理前把被清段落归档为 JSONL（可选） |
| 游标回退 | 游标永不回退；文件损坏时用"全量导出 + 重置该 peer 的游标为 0"重建 |
| 远端对端 | 第一阶段不实现；字段/游标已就绪 |

### 10.5 同步端口（预留形状，不实现）

未来 `SyncPort` 只需读写本节两张表 + 一张业务表（应用变更），接口形状示意：

```ts
// 设计示意（不落实现代码；仅为接口契约）
interface SyncPort {
  readonly peerId: string;                       // 对应 sync_state.peer_id
  pull(cursor: number): Promise<{ changes: ChangeLogRow[]; nextCursor: number }>;
  push(changes: ChangeLogRow[], cursor: number): Promise<{ ackedCursor: number }>;
  // 冲突裁决：基于 (updated_at, device_id) 的 LWW；落败版本写 revisions 留存
}
```

**冲突裁决规则（【推断】INF-10）**

| 本地状态 | 远端事件 | 处理 |
|---|---|---|
| 已软删 | 远端 `delete` | 幂等跳过 |
| 活跃 | 远端 `delete`，且 `local.rev <= remote.rev` | 本地软删（tombstone 胜） |
| 活跃 | 远端 `delete`，且 `local.rev > remote.rev` | 保留本地，`meta_json` 记 `conflict`，进人工队列 |
| 活跃 | 远端 `insert/update` | 比较 `(updated_at, device_id)` 字典序，新者胜；落败方写 `revisions` 快照 |
| 无记录 | 远端 `insert/update` | 直接插入 |
| 有记录 | 远端 `insert`（同 id） | 视为 update 走 LWW |

> 说明：LWW 不适用于结构化冲突（如两人同时改同一角色不同字段），二期可升级为字段级三方合并；本期只要求"不丢数据、可追溯"（落败快照进 `revisions`）。

---

## 11. 全文检索（FTS5）

> 【已定：需要 FTS5 覆盖 chapters 正文与 worldbook_entries】。本节选型与实现【推断】INF-08。

### 11.1 选型决策

| 索引对象 | 方案 | 理由 | 替代方案（未选） |
|---|---|---|---|
| `chapters` 正文 | **独立 FTS5 表 + `chapter_index` 物化检索源** | 正文在 `chapter_versions`，标题在 `chapters`，FTS external content 只能映射单表；物化源提供稳定整数 rowid（`ci_id`），独立 FTS 表以 `rowid=ci_id` 精确增删改 | external content 指向 `chapter_versions`（缺标题、版本历史会进索引） |
| `worldbook_entries` | **external content**（`content='worldbook_entries'`） | 单表即真相源，`title/keywords/content` 三列都在；省一份正文冗余；标准触发器模式 | 独立表（多一份正文） |
| 分词器 | `tokenize='trigram'` | 中文无空格：`unicode61` 会把整句 CJK 当一个 token；trigram 支持任意 ≥3 字子串检索，天然适配中文；无需应用层预分词 | ① `unicode61` + 应用层 `Intl.Segmenter` 预分词（召回可控但需双写、查询侧同构，复杂度高）② contentless（无法取回原文） |
| 降级 | FTS5/trigram 探针失败 → `LIKE '%kw%'` 扫描 `chapter_index` / `worldbook_entries` | 本地单库 ≤5GB、单项目 ≤2000 万字，`LIKE` 可接受（秒级）；能力标记写 `app_settings['capabilities.fts5']` | 无 |

**trigram 的已知限制**：`MATCH` 查询串需 ≥3 个字符；2 字中文词（如「苍山」）应走 `LIKE` 兜底或查询改写为 3 字（如「苍山」→「苍山」+ 相邻字）。UI 层需按此提示，不承诺 2 字全文检索。

### 11.2 章节检索（物化源 + 独立 FTS + 触发器）

**结构**：`chapter_index`（每章一行，稳定 `ci_id`，存当前正文快照）← 由 `chapters` / `chapter_versions` 上的触发器维护 → `fts_chapters`（独立 FTS 表，`rowid = ci_id`）← 由 `chapter_index` 上的标准触发器维护。

> 为什么不直接让触发器写 FTS：删改时需要"旧值"才能正确更新 FTS；两层结构让 FTS 触发器只关心 `chapter_index` 的增删改，章节侧触发器只关心"当前正文是什么"，职责清晰且可重建（重建 = 清空 `chapter_index` 后重灌）。

```sql
-- ===== 11.2 章节 FTS =====
-- 物化检索源：每章一行；ci_id 稳定（不随 VACUUM 变化，因为它是 INTEGER PRIMARY KEY）
CREATE TABLE IF NOT EXISTS chapter_index (
  ci_id      INTEGER PRIMARY KEY,
  chapter_id TEXT    NOT NULL UNIQUE,
  project_id TEXT    NOT NULL,
  title      TEXT    NOT NULL DEFAULT '',
  body       TEXT    NOT NULL DEFAULT ''
);

CREATE VIRTUAL TABLE IF NOT EXISTS fts_chapters USING fts5(
  title,
  body,
  content        = 'chapter_index',
  content_rowid  = 'ci_id',
  tokenize       = 'trigram'
);

-- chapter_index → FTS（标准 external content 三触发器）
CREATE TRIGGER IF NOT EXISTS trg_chapter_index_ai AFTER INSERT ON chapter_index
BEGIN
  INSERT INTO fts_chapters(rowid, title, body) VALUES (new.ci_id, new.title, new.body);
END;

CREATE TRIGGER IF NOT EXISTS trg_chapter_index_ad AFTER DELETE ON chapter_index
BEGIN
  INSERT INTO fts_chapters(fts_chapters, rowid, title, body)
  VALUES ('delete', old.ci_id, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS trg_chapter_index_au AFTER UPDATE ON chapter_index
BEGIN
  INSERT INTO fts_chapters(fts_chapters, rowid, title, body)
  VALUES ('delete', old.ci_id, old.title, old.body);
  INSERT INTO fts_chapters(rowid, title, body)
  VALUES (new.ci_id, new.title, new.body);
END;

-- chapters / chapter_versions → chapter_index（只维护"当前正文"）
CREATE TRIGGER IF NOT EXISTS trg_chapters_index_ai AFTER INSERT ON chapters
BEGIN
  INSERT INTO chapter_index(chapter_id, project_id, title, body)
  VALUES (new.id, new.project_id, new.title,
          COALESCE((SELECT content FROM chapter_versions WHERE id = new.current_version_id), ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_chapters_index_au AFTER UPDATE OF title, project_id, current_version_id ON chapters
WHEN new.deleted_at IS NULL
BEGIN
  INSERT INTO chapter_index(chapter_id, project_id, title, body)
  VALUES (new.id, new.project_id, new.title,
          COALESCE((SELECT content FROM chapter_versions WHERE id = new.current_version_id), ''))
  ON CONFLICT(chapter_id) DO UPDATE SET
    project_id = excluded.project_id,
    title      = excluded.title,
    body       = excluded.body;
END;

CREATE TRIGGER IF NOT EXISTS trg_chapters_index_softdel AFTER UPDATE OF deleted_at ON chapters
WHEN new.deleted_at IS NOT NULL
BEGIN
  DELETE FROM chapter_index WHERE chapter_id = new.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_chapters_index_restore AFTER UPDATE OF deleted_at ON chapters
WHEN new.deleted_at IS NULL AND old.deleted_at IS NOT NULL
BEGIN
  INSERT INTO chapter_index(chapter_id, project_id, title, body)
  VALUES (new.id, new.project_id, new.title,
          COALESCE((SELECT content FROM chapter_versions WHERE id = new.current_version_id), ''))
  ON CONFLICT(chapter_id) DO UPDATE SET
    project_id = excluded.project_id,
    title      = excluded.title,
    body       = excluded.body;
END;

CREATE TRIGGER IF NOT EXISTS trg_cv_index_sync AFTER INSERT ON chapter_versions
BEGIN
  UPDATE chapter_index
     SET body = new.content
   WHERE chapter_id = new.chapter_id
     AND new.id = (SELECT current_version_id FROM chapters WHERE id = new.chapter_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_cv_index_resync AFTER UPDATE OF content ON chapter_versions
BEGIN
  UPDATE chapter_index
     SET body = new.content
   WHERE chapter_id = new.chapter_id
     AND new.id = (SELECT current_version_id FROM chapters WHERE id = new.chapter_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_cv_index_remove AFTER DELETE ON chapter_versions
BEGIN
  UPDATE chapter_index
     SET body = ''
   WHERE chapter_id = old.chapter_id
     AND old.id = (SELECT current_version_id FROM chapters WHERE id = old.chapter_id);
END;
```

**维护纪律**：业务代码**不直接写** `chapter_index` 与 `fts_chapters`；仅在维护命令里重建（§11.5）。`chapter_index` 是派生表，可随时丢弃重建。

### 11.3 世界书检索（external content）

```sql
-- ===== 11.3 世界书 FTS（external content，rowid 即 worldbook_entries.rowid）=====
CREATE VIRTUAL TABLE IF NOT EXISTS fts_worldbook_entries USING fts5(
  title,
  keywords,
  content   = 'worldbook_entries',
  tokenize  = 'trigram'
);

CREATE TRIGGER IF NOT EXISTS trg_wb_fts_ai AFTER INSERT ON worldbook_entries
BEGIN
  INSERT INTO fts_worldbook_entries(rowid, title, keywords, content)
  VALUES (new.rowid, new.title, new.keywords, new.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_wb_fts_ad AFTER DELETE ON worldbook_entries
BEGIN
  INSERT INTO fts_worldbook_entries(fts_worldbook_entries, rowid, title, keywords, content)
  VALUES ('delete', old.rowid, old.title, old.keywords, old.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_wb_fts_au AFTER UPDATE OF title, keywords, content ON worldbook_entries
BEGIN
  INSERT INTO fts_worldbook_entries(fts_worldbook_entries, rowid, title, keywords, content)
  VALUES ('delete', old.rowid, old.title, old.keywords, old.content);
  INSERT INTO fts_worldbook_entries(rowid, title, keywords, content)
  VALUES (new.rowid, new.title, new.keywords, new.content);
END;

-- 软删从索引中摘除；恢复时重灌
CREATE TRIGGER IF NOT EXISTS trg_wb_fts_softdel AFTER UPDATE OF deleted_at ON worldbook_entries
WHEN new.deleted_at IS NOT NULL
BEGIN
  INSERT INTO fts_worldbook_entries(fts_worldbook_entries, rowid, title, keywords, content)
  VALUES ('delete', old.rowid, old.title, old.keywords, old.content);
END;

CREATE TRIGGER IF NOT EXISTS trg_wb_fts_restore AFTER UPDATE OF deleted_at ON worldbook_entries
WHEN new.deleted_at IS NULL AND old.deleted_at IS NOT NULL
BEGIN
  INSERT INTO fts_worldbook_entries(rowid, title, keywords, content)
  VALUES (new.rowid, new.title, new.keywords, new.content);
END;
```

> 外键与 FTS 的关系：`worldbook_entries` 的 rowid 是隐式 rowid；**禁止普通 `VACUUM`**（可能重排非 `INTEGER PRIMARY KEY` 表的 rowid，会让 external content 失配）。维护用 `VACUUM INTO`（拷贝，不改源库）或 `PRAGMA incremental_vacuum`。若必须 `VACUUM`，之后执行 §11.5 的 FTS `rebuild`。

### 11.4 查询示例

```sql
-- 章节检索：命中标题/正文，按相关度排序（标题权重更高），限定项目
SELECT ci.chapter_id, ci.title,
       snippet(fts_chapters, 1, '[', ']', '……', 24) AS hit,
       bm25(fts_chapters, 5.0, 1.0)                 AS rank
FROM fts_chapters
JOIN chapter_index ci ON ci.ci_id = fts_chapters.rowid
WHERE fts_chapters MATCH :query           -- :query 为 ≥3 字符的检索串（trigram 限制）
  AND ci.project_id = :project_id
ORDER BY rank
LIMIT 20;

-- 世界书检索：按词条优先级 + 相关度排序
SELECT we.id, we.title, we.priority,
       snippet(fts_worldbook_entries, 2, '[', ']', '……', 24) AS hit,
       bm25(fts_worldbook_entries, 5.0, 3.0, 1.0)            AS rank
FROM fts_worldbook_entries
JOIN worldbook_entries we ON we.rowid = fts_worldbook_entries.rowid
WHERE fts_worldbook_entries MATCH :query
  AND we.project_id = :project_id
  AND we.deleted_at IS NULL
  AND we.enabled = 1
ORDER BY we.priority DESC, rank
LIMIT 20;
```

### 11.5 重建与健康检查（维护命令）

```sql
-- 1) 重建章节物化源（派生表，可先清空）
DELETE FROM chapter_index;
INSERT INTO chapter_index (chapter_id, project_id, title, body)
SELECT c.id, c.project_id, c.title, COALESCE(v.content, '')
FROM chapters c
LEFT JOIN chapter_versions v ON v.id = c.current_version_id
WHERE c.deleted_at IS NULL;

-- 2) 重建 FTS 索引（external content 表的 rebuild 命令）
INSERT INTO fts_chapters(fts_chapters) VALUES('rebuild');
INSERT INTO fts_worldbook_entries(fts_worldbook_entries) VALUES('rebuild');

-- 3) 一致性检查（不一致会报错，被维护命令捕获）
INSERT INTO fts_worldbook_entries(fts_worldbook_entries) VALUES('integrity-check');
```

| 维护项 | 频率 | 说明 |
|---|---|---|
| `PRAGMA optimize` | 每次关闭写连接前 | 让 SQLite 更新统计 |
| `ANALYZE` | 迁移后 + 每万次写 | 优化器需要 |
| FTS `rebuild` | 迁移/怀疑失配/普通 VACUUM 后 | 本地 3000 章预计 < 2 s |
| `PRAGMA integrity_check` | 启动可选（默认只在迁移/测试跑） | 库级健康 |
| FTS `integrity-check` | 启动可选 / 测试 | 索引与内容表一致性 |

---

## 12. 不变量与强制手段矩阵

> 图例：**FK** 外键、**UNIQUE** 唯一索引、**CHECK** 列/行级检查、**TRG** 触发器、**APP** 只能应用层校验。带 ⚠️ 的是"DB 无法完全强制"的缺口，必须在仓储层 + 测试里兜住（§20）。

| # | 不变量 | 强制手段 | 落地位置 | 缺口/备注 |
|---|---|---|---|---|
| I-01 | 业务主键统一 `TEXT` UUID v7、非空唯一 | **UNIQUE**（PK） | 全部表 | 生成器正确性由 APP 保证（单测覆盖 v7 版本位/时间位） |
| I-02 | 每项目**恰 1 条**世界观根 | **UNIQUE**（至多 1）+ **TRG**（至少 1） | `ux_world_settings_root`、`trg_projects_insert_root` | 触发器建根；项目创建必须同事务（否则 app 崩溃会留下无根项目）⚠️ |
| I-03 | 根条目无父、无分类；非根必须有父、有分类 | **CHECK** | `world_settings` 行级 CHECK | 无 |
| I-04 | 根条目不可删（软删/硬删）、身份不可变 | **TRG** | `trg_world_settings_root_guard_*` | purge 需先软删项目（§5.2 顺序） |
| I-05 | 世界观分类必须存在且同项目 | **FK**（复合） | `(project_id, category_id)` | 无 |
| I-06 | 同父下世界观标题唯一 | **UNIQUE**（表达式索引） | `ux_world_settings_sibling_title` | 仅活跃行 |
| I-07 | 每项目至多 1 条整体大纲 | **UNIQUE** | `ux_outlines_project_overall` | "至少 1 条"是 APP（创建项目时建）⚠️ |
| I-08 | 卷大纲只挂整体大纲；章大纲挂整体/卷（禁卷中卷） | **CHECK** + **TRG** | `outlines` CHECK + `trg_outlines_parent_kind_*` | 无 |
| I-09 | 章大纲与章一对一 | **UNIQUE** | `ux_outlines_chapter` | 未绑章时 `chapter_id NULL`，唯一索引不覆盖 |
| I-10 | 章必须属于本项目下的卷 | **FK**（复合） | `(project_id, volume_id)` | 无 |
| I-11 | 卷内章序号唯一 | **UNIQUE** | `ux_chapters_volume_seq` | 重排需两阶段偏移 |
| I-12 | 章节号派生（不落库、删章不重排） | **APP** | 视图 `v_chapter_numbering` | DB 无列可校验；重排命令在 APP ⚠️ |
| I-13 | 角色名项目内唯一（归一化后） | **UNIQUE** | `ux_characters_project_name(name_key)` | `name_key` 归一化由 APP 保证 ⚠️ |
| I-14 | 角色关系两端不同、同类型不重复 | **CHECK** / **UNIQUE** | `character_relations` | 对称关系"只存一条"由 APP 归一 ⚠️ |
| I-15 | 一人一分组一条成员 | **UNIQUE** | `ux_cgm_group_char` | 主分组唯一是 APP ⚠️ |
| I-16 | 角色语言基因 1:1 | **UNIQUE** | `ux_character_voice_character` | 无 |
| I-17 | 角色状态按章唯一 | **UNIQUE** | `ux_character_states_point` | 无 |
| I-18 | 伏笔状态与章节字段一致 | **CHECK** | `foreshadowings` 两条 CHECK | 软删章节不触发 SET NULL，语义仍成立 |
| I-19 | 场景契约版本唯一、仅一版兑现 | **UNIQUE** | `ux_scene_contract_version` | "仅一版 locked/fulfilled"是 APP ⚠️ |
| I-20 | 地图图钉至多绑一个目标 | **CHECK** | `map_pins` 列相加 `<= 1` | 无 |
| I-21 | 知识关系两端各**恰 1** 个类型化实体 | **FK ×16** + **CHECK** | `knowledge_relations` | 自环（同一实体）只能 APP 校验 ⚠️ |
| I-22 | 知识关系无重复边 | **UNIQUE**（生成列） | `ux_kr_edge` | 无 |
| I-23 | 所有 JSON 列合法 | **CHECK** | 全部 `*_json` 列 | 内部结构（必填键）由 APP ⚠️ |
| I-24 | 软删行不参与唯一、不参与查询 | **UNIQUE**（partial）+ **APP** | 全部唯一索引 | 查询必须带 `deleted_at IS NULL`，无 DB 强制 ⚠️ |
| I-25 | `rev` 每次写 +1、冲突检测 | **APP**（仓储层） | 全部更新路径 | DB 只有 `CHECK (rev >= 1)` ⚠️ |
| I-26 | 业务写与 `change_log` 同事务 | **APP** | 仓储层 | 无 DB 强制（可用测试审计）⚠️ |
| I-27 | 日志表不可 UPDATE | **TRG** | `trg_change_log_no_update`、`trg_revisions_no_update` | DELETE 保留给保留期清理 |
| I-28 | 项目软删后子表不可见 | **APP** | 仓储层统一 join 项目态 | 单表直查需靠评审/测试 ⚠️ |
| I-29 | 分类被引用时不可硬删 | **FK RESTRICT** | `world_settings.category_id` | 软删分类不受限（APP 管理） |
| I-30 | 正文唯一真相源是 `chapter_versions.content` | **APP** | 仓储层 | `chapters` 不设正文列（结构性保证） |
| I-31 | `change_log.entity_table` 合法 | **APP** 白名单 | §10.1 白名单常量 | SQLite 无法 FK 到表名 ⚠️ |
| I-32 | 多态 `target_id`/`subject_id` 指向存在实体 | **APP** | proposals/revisions/audit/extraction/facts | 跨表存在性无法 FK ⚠️ |
| I-33 | `app_settings` scope 与 project_id 一致 | **CHECK** | `app_settings` | 无 |
| I-34 | 时间线字段类型与倍率合法 | **CHECK** | `timeline_events` | 跨纪元换算语义是 APP ⚠️ |
| I-35 | 图钉坐标归一化 | **CHECK** | `map_pins.x/y BETWEEN 0 AND 1` | 无 |

### 12.1 SQLite 的能力边界（哪些"只能应用层"）

| 限制 | 影响的约束 | 兜底方式 |
|---|---|---|
| 无法 FK 到"表名"（动态表名） | `change_log.entity_table`、多态 `target_id` | 应用层白名单 + 单测 |
| CHECK 不能跨行/跨表聚合 | "至少 1 条根/整体大纲"、"仅一版 locked 契约" | 触发器建根 + 应用层 + 测试 |
| 生成列/CHECK 不能比较 8 个可空列是否同指一实体 | 知识关系自环 | 应用层校验 |
| 部分唯一索引只能是"至多"语义 | "恰 1 条"的至少方 | 触发器或应用层建 |
| 无 UUID 函数 | 主键生成 | TS 生成 v7 |
| FK 默认关闭、无自动索引 | 外键/索引 | 每连接 PRAGMA + 显式 CREATE INDEX |
| 触发器不感知"业务语义"（如 rev+1） | rev/updated_at/device_id | 仓储层统一写入 |

---

## 13. 枚举字典

> 所有 `CHECK` 的取值全集；扩展枚举必须**走迁移**（不能只改代码），并同步更新本表。`entity_kinds.kind` 是跨表 kind 字典（见 §3.5）。

### 13.1 状态类

| 表.列 | 取值 | 说明 |
|---|---|---|
| `projects.status` | `active` / `archived` | 活跃 / 归档 |
| `volumes.status` | `planned` / `writing` / `done` / `archived` | 卷进度 |
| `chapters.status` | `planned` / `drafting` / `review` / `final` / `published` / `archived` | 章工作流 |
| `chapter_versions.status` | `draft` / `candidate` / `final` / `superseded` | 版本状态 |
| `chapter_versions.source` | `human` / `ai` / `ai_revised` / `import` / `migration` | 版本来源 |
| `outlines.status` | `planned` / `active` / `done` / `archived` | 大纲节点 |
| `outline_plot_points.status` | `planned` / `done` / `cut` | 情节点 |
| `story_arcs.status` | `planned` / `active` / `resolved` / `abandoned` | 故事线 |
| `world_settings.status` | `active` / `archived` | 世界观条目 |
| `characters.status` | `active` / `dead` / `missing` / `sealed` / `retired` | 角色全局状态 |
| `character_states.status` | `active` / `dead` / `missing` / `sealed` / `retired` / `unknown` | 按章时点状态 |
| `character_relations.status` | `active` / `ended` / `broken` | 关系状态 |
| `foreshadowings.status` | `planned` / `planted` / `reinforced` / `resolved` / `abandoned` | 伏笔生命周期 |
| `timeline_events.status` | `canon` / `draft` / `disputed` | 正史/草稿/存疑 |
| `knowledge_relations.status` | `active` / `proposed` / `retracted` | 关系状态 |
| `facts_ledger.status` | `proposed` / `canon` / `conflict` / `superseded` | 事实状态 |
| `scene_contracts.status` | `draft` / `locked` / `fulfilled` / `failed` / `cancelled` | 场景契约 |
| `proposals.status` | `pending` / `accepted` / `rejected` / `applied` / `superseded` / `expired` | 提议生命周期 |
| `audit_runs.status` | `queued` / `running` / `succeeded` / `failed` / `cancelled` | 审计运行 |
| `extraction_staging.status` | `pending` / `accepted` / `rejected` / `merged` / `conflict` | 抽取暂存 |
| `maps.status`（无） | — | 地图无状态列（用软删） |

### 13.2 类型/分类类

| 表.列 | 取值 | 说明 |
|---|---|---|
| `outlines.kind` | `overall` / `volume` / `chapter` | 大纲层级 |
| `outline_plot_points.kind` | `setup` / `beat` / `turn` / `climax` / `payoff` / `note` | 情节点类型 |
| `story_arcs.kind` | `main` / `sub` / `romance` / `mystery` / `growth` / `other` | 故事线类型 |
| `worldbook_entries.entry_type` | `lore` / `character` / `item` / `location` / `event` / `rule` / `organization` / `other` | 词条类型 |
| `worldbook_entries.trigger_mode` | `keywords` / `always` / `never` | 触发方式（与 `always` 列联动） |
| `worldbook_entries.position` | `before_context` / `after_context` / `in_chapter` / `system` | 注入位置 |
| `worldbook_entries.source` | `manual` / `ai` / `extraction` / `import` / `migration` | 词条来源 |
| `characters.role_type` | `protagonist` / `deuteragonist` / `antagonist` / `supporting` / `minor` / `narrator` / `cameo` | 角色定位 |
| `character_groups.kind` | `faction` / `family` / `team` / `sect` / `organization` / `other` | 分组类型 |
| `character_relations.relation_type` | `family` / `master_disciple` / `friend` / `enemy` / `ally` / `rival` / `lover` / `subordinate` / `mentor` / `colleague` / `other` | 角色关系 |
| `character_relations.direction` | `directed` / `mutual` | 有向/对称 |
| `timeline_events.unit` | `era` / `year` / `month` / `day` / `hour` / `minute` / `instant` | 刻度单位 |
| `timeline_events.event_type` | `backstory` / `main` / `side` / `flashback` / `prophecy` | 事件类型 |
| `knowledge_relations.relation_type` | `references` / `foreshadows` / `resolves` / `belongs_to` / `located_in` / `member_of` / `owns` / `allies_with` / `conflicts_with` / `causes` / `precedes` / `follows` / `related_to` / `derived_from` / `contradicts` / `supports` | 知识关系（语义见 §7.3） |
| `facts_ledger.subject_kind` | `character` / `world_setting` / `worldbook_entry` / `foreshadowing` / `timeline_event` / `organization` / `place` / `item` / `other` | 事实主体 |
| `proposals.patch_format` | `json_patch` / `full_replace` / `markdown` / `sql` | 变更表达 |
| `proposals.source` | `ai` / `audit` / `user` / `import` / `extraction` | 提议来源 |
| `revisions.change_kind` | `create` / `update` / `delete` / `restore` / `merge` | 变更种类 |
| `revisions.source` | `human` / `ai` / `audit` / `import` / `migration` / `sync` | 变更来源 |
| `audit_runs.scope` | `project` / `volume` / `chapter` / `entity` / `extraction` | 审计范围 |
| `extraction_staging.source_kind` | `llm` / `rule` / `import` | 抽取方式 |
| `extraction_staging.merge_strategy` | `append` / `replace` / `skip` / `manual` | 合并策略 |
| `maps.kind` | `world` / `region` / `city` / `building` / `dungeon` / `custom` | 地图类型 |
| `map_pins.pin_kind` | `location` / `character` / `event` / `foreshadowing` / `note` / `other` | 图钉类型 |
| `app_settings.scope` | `app` / `project` | 设置作用域 |
| `change_log.op` | `insert` / `update` / `delete` | 变更操作 |
| `change_log.payload_mode` | `snapshot` / `patch` | 载荷模式 |

### 13.3 数值范围

| 表.列 | 范围/默认 | 说明 |
|---|---|---|
| `worldbook_entries.priority` | 0–100，默认 50 | 数值大优先 |
| `worldbook_entries.always` | 0/1，默认 0 | 与 `trigger_mode='always'` 必须一致 |
| `worldbook_entries.enabled` | 0/1，默认 1 | 停用即退出注入/检索 |
| `characters.role_rank` | ≥0，默认 100 | 越小越核心 |
| `character_relations.strength` | 0–100，默认 50 | 关系强度 |
| `character_voice.formality` | 0–100，默认 50 | 正式度 |
| `foreshadowings.importance` | 1–5，默认 3 | 伏笔重要度 |
| `timeline_events.importance` | 1–5，默认 3 | 事件重要度 |
| `timeline_events.era_scale` | >0，默认 1.0 | 纪元倍率 |
| `facts_ledger.confidence` | 0–100，默认 100 | 事实置信度 |
| `knowledge_relations.confidence` | 0–100，默认 100 | 关系置信度 |
| `extraction_staging.confidence` | 0–100，默认 100 | 抽取置信度 |
| `map_pins.x` / `y` | 0–1 | 归一化坐标 |
| `word_count` / `target_words` | ≥0 / >0 | 字数（`word_count` 为派生缓存） |

### 13.4 entity_kinds（跨表 kind 字典）

| kind | 中文 | kind | 中文 |
|---|---|---|---|
| `project` | 项目 | `chapter_version` | 章节版本 |
| `volume` | 卷 | `outline` | 大纲节点 |
| `chapter` | 章 | `plot_point` | 情节点 |
| `story_arc` | 故事线 | `world_setting_category` | 世界观分类 |
| `world_setting` | 世界观条目 | `worldbook_entry` | 世界书词条 |
| `character` | 角色 | `character_group` | 角色分组 |
| `character_relation` | 角色关系 | `character_voice` | 语言基因 |
| `character_state` | 角色状态 | `foreshadowing` | 伏笔 |
| `timeline_event` | 时间线事件 | `knowledge_relation` | 知识关系 |
| `fact` | 事实 | `scene_contract` | 场景契约 |
| `map` | 地图 | `map_pin` | 图钉 |
| `proposal` | 提议 | `app_setting` | 应用设置 |

---

## 14. JSON 列清单

> 全部为 `TEXT` + `CHECK (json_valid(...))`；默认 `{}` 或 `[]`。**列名以 `_json` 结尾**，实现层统一序列化/反序列化（禁止把 JSON 字符串再包一层字符串）。

| 表 | 列 | 默认 | 结构说明 |
|---|---|---|---|
| `projects` | `settings_json` | `{}` | 写作参数：`{default_model?, target_words?, style?, banned_words[]?, pipeline?}` |
| `outlines` | `metadata_json` | `{}` | 节点扩展：`{pace, tension, mood, tags[]}` |
| `story_arcs` | `milestones_json` | `[]` | `[{name, chapter_id?, note?}]` |
| `world_settings` | `tags_json` | `[]` | `["地理","山川"]` |
| `worldbook_entries` | `metadata_json` | `{}` | `{recursion_depth?, exclude_tags[]?, notes?}` |
| `characters` | `alias_json` | `[]` | `["清音","清音仙子"]` |
| `characters` | `attributes_json` | `{}` | 扩展属性（种族、倾向、标记位） |
| `character_voice` | `address_forms_json` | `{}` | `{"师尊":"师父","仇人":"直呼其名"}` |
| `character_voice` | `sample_lines_json` | `[]` | `["台词1","台词2"]` |
| `character_states` | `abilities_json` / `possessions_json` / `knowledge_json` | `[]` | 字符串数组（能力名/物品名/信息名） |
| `character_states` | `flags_json` | `{}` | `{amnesia:true, possessed:false}` |
| `timeline_events` | `participants_json` | `[]` | 角色 id 数组 |
| `facts_ledger` | `value_json` | `NULL` | 结构化值（数值/数组/对象） |
| `scene_contracts` | `participants_json` / `required_foreshadowing_ids_json` / `forbidden_json` | `[]` | 字符串/id 数组 |
| `scene_contracts` | `beats_json` | `[]` | `[{beat:"开场", content:"..."}]` |
| `scene_contracts` | `constraints_json` | `{}` | `{must:[], must_not:[], style:{}}` |
| `proposals` | `payload_json` | 必填 | 依 `patch_format`：JSON Patch / 整行 / Markdown / SQL |
| `revisions` | `snapshot_json` / `patch_json` | `NULL` | 整行快照 / `{列:新值}` |
| `audit_runs` | `findings_json` | `[]` | `[{severity, code, message, entity_kind?, entity_id?, chapter_id?}]` |
| `audit_runs` | `metrics_json` | `{}` | `{checked, findings, duration_ms, tokens}` |
| `extraction_staging` | `payload_json` / `normalized_json` | 必填 / `NULL` | 候选实体 / 归一化后候选 |
| `maps` | `scale_json` | `{}` | `{ratio, unit, legend:{}}` |
| `app_settings` | `value_json` | 必填 | 任意 JSON 值（含字符串） |
| `sync_state` | `meta_json` | `{}` | 对端能力/统计 |
| `change_log` | `payload_json` | 必填 | snapshot 整行 / patch 字段映射 |
| `change_log` | `meta_json` | `{}` | `{client?, conflict?: true}` |

---

## 15. 索引清单

> 完整 DDL 见各节代码块；此表用于评审"是否每个外键/查询都有索引"。SQLite **不会**为外键子列自动建索引（§2.7）。

| 表 | 索引 | 列 | 用途 |
|---|---|---|---|
| projects | `ix_projects_status` | `(status, updated_at)` | 项目列表 |
| volumes | `ux_volumes_project_index` | `(project_id, index_no)` | 卷序唯一/列表 |
| chapters | `ux_chapters_volume_seq` | `(volume_id, seq_in_volume)` | 卷内序号唯一 |
| chapters | `ix_chapters_project_status` | `(project_id, status, updated_at)` | 章列表/待办 |
| chapters | `ix_chapters_current_version` | `(current_version_id)` | 版本引用定位 |
| chapter_versions | `ux_chapter_versions_no` | `(chapter_id, version_no)` | 版本号唯一 |
| chapter_versions | `ix_chapter_versions_status` | `(chapter_id, status)` | 当前草稿/定稿 |
| chapter_versions | `ix_chapter_versions_proposal` | `(proposal_id)` | 提议反查版本 |
| outlines | `ux_outlines_project_overall` | `(project_id)` | 恰一整体大纲 |
| outlines | `ux_outlines_chapter` | `(chapter_id)` | 章大纲唯一 |
| outlines | `ix_outlines_tree` | `(project_id, parent_id, sort_index)` | 树加载 |
| outlines | `ix_outlines_volume` | `(project_id, volume_id)` | 按卷取大纲 |
| outline_plot_points | `ux_plot_points_outline_seq` | `(outline_id, seq)` | 节点内顺序 |
| outline_plot_points | `ix_plot_points_arc` | `(arc_id)` | 按故事线取点 |
| story_arcs | `ux_story_arcs_name` | `(project_id, name)` | 线名唯一 |
| story_arcs | `ix_story_arcs_status` | `(project_id, status)` | 线列表 |
| world_setting_categories | `ux_wsc_project_key` / `ux_wsc_project_name` | `(project_id, key)` / `(project_id, name)` | 分类唯一 |
| world_setting_categories | `ix_wsc_parent` | `(project_id, parent_id, sort_index)` | 分类树 |
| world_settings | `ux_world_settings_root` | `(project_id)` | 恰一世界观根 |
| world_settings | `ux_world_settings_sibling_title` | `(project_id, COALESCE(parent_id,''), title)` | 同级标题唯一 |
| world_settings | `ix_world_settings_cat` / `ix_world_settings_parent` | `(project_id, category_id, sort_index)` / `(project_id, parent_id, sort_index)` | 分类/树加载 |
| worldbook_entries | `ux_worldbook_project_title` | `(project_id, title)` | 词条名唯一 |
| worldbook_entries | `ix_worldbook_trigger` | `(project_id, enabled, trigger_mode, priority DESC)` | 注入候选集 |
| worldbook_entries | `ix_worldbook_setting` | `(project_id, world_setting_id)` | 设定反查词条 |
| characters | `ux_characters_project_name` | `(project_id, name_key)` | 角色名唯一 |
| characters | `ix_characters_rank` | `(project_id, role_type, role_rank)` | 角色列表 |
| characters | `ix_characters_first_appearance` | `(first_appearance_chapter_id)` | 引用定位 |
| character_groups | `ux_char_groups_name` / `ix_char_groups_parent` | `(project_id, name)` / `(project_id, parent_id, sort_index)` | 分组树 |
| character_group_members | `ux_cgm_group_char` / `ix_cgm_character` | `(group_id, character_id)` / `(character_id)` | 成员唯一/反查 |
| character_relations | `ux_char_relations_edge` / `ix_char_relations_to` | `(project_id,from,to,relation_type)` / `(to_character_id)` | 边唯一/入边 |
| character_voice | `ux_character_voice_character` / `ix_character_voice_chapter` | `(character_id)` / `(updated_by_chapter_id)` | 1:1 |
| character_states | `ux_character_states_point` / `ix_character_states_chapter` | `(character_id, chapter_id)` / `(chapter_id)` | 时点唯一/按章查 |
| foreshadowings | `ux_foreshadow_project_title` / `ix_foreshadow_status` / `ix_foreshadow_resolve` | 见 §7.1 | 伏笔列表/回收跟踪 |
| timeline_events | `ix_timeline_world_clock` / `ix_timeline_narrative` / `ix_timeline_chapter` | 见 §7.2 | 双轨排序 |
| knowledge_relations | `ix_kr_source` / `ix_kr_target` / `ix_kr_project_type` / `ux_kr_edge` | 生成列/项目/类型/唯一 | 图谱查询与去重 |
| facts_ledger | `ix_facts_subject` / `ix_facts_chapter` / `ix_facts_predicate` | 见 §7.4 | 冲突检测 |
| scene_contracts | `ux_scene_contract_version` / `ix_scene_contract_status` | `(chapter_id, version)` / `(project_id, status)` | 契约版本/待写队列 |
| proposals | `ix_proposals_project_status` / `ix_proposals_target` | 见 §8.1 | 待决策列表 |
| revisions | `ux_revisions_target_rev` / `ix_revisions_project_time` / `ix_revisions_target` | 见 §8.2 | 修订链 |
| audit_runs | `ix_audit_runs_project` / `ix_audit_runs_target` | 见 §8.3 | 审计历史 |
| extraction_staging | `ix_extraction_status` / `ix_extraction_chapter` | 见 §8.4 | 暂存队列 |
| maps | `ux_maps_project_name` | `(project_id, name)` | 地图名唯一 |
| map_pins | `ix_map_pins_map` | `(map_id, order_index)` | 图钉列表 |
| app_settings | `ux_app_settings_app` / `ux_app_settings_project` | `(key)` / `(project_id, key)` | 键唯一 |
| change_log | `ix_change_log_entity` / `ix_change_log_project` / `ix_change_log_changed_at` | 见 §10.1 | 增量读取/清理 |
| chapter_index | PK + `UNIQUE(chapter_id)` | — | FTS rowid 映射 |

**复合外键附加索引**：所有 `UNIQUE (project_id, id)` 表内约束都是复合 FK 的父键索引（volumes/chapters/outlines/world_setting_categories/world_settings/worldbook_entries/characters/character_groups/story_arcs/foreshadowings/timeline_events/facts_ledger/maps），§2.6 已说明这是有意付出的写放大。

---

## 16. 迁移与演化策略

> 【已定：`schema_version` / 幂等 DDL / 版本表 + 顺序迁移，禁止 ensure_* 式不可重放迁移】。本节细化 SQLite 落地方式。

### 16.1 版本表与镜像

```sql
-- ===== 16.1 schema_migrations =====
CREATE TABLE IF NOT EXISTS schema_migrations (
  version     INTEGER PRIMARY KEY,
  name        TEXT    NOT NULL CHECK (length(trim(name)) > 0),
  checksum    TEXT    NOT NULL CHECK (length(checksum) = 64),   -- sha256 hex
  applied_at  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0)
);
```

- 同时维护 `PRAGMA user_version = MAX(version)`（快速读取，无需查表）。
- 启动时 `user_version` 与 `MAX(schema_migrations.version)` **必须一致**，不一致视为损坏/半迁移，拒绝启动并提示恢复备份。

### 16.2 迁移文件与顺序

| 规则 | 内容 |
|---|---|
| 目录 | `migrations/0001_init.sql`、`0002_…sql`……（编号 4 位，递增） |
| 执行方式 | 严格按版本顺序；**禁止跳版**；已应用版本不再执行（幂等 DDL 只是兜底，不是门禁） |
| 原子性 | 每个迁移 = 一个事务（SQLite DDL 可事务）；失败整版回滚 |
| 校验和 | 执行前计算 `sha256(file)` 与 `schema_migrations.checksum` 比对，不一致拒绝（防止手改历史迁移） |
| 并发 | 启动时用文件锁（`migrations.lock`）或 DSH 插件生命周期单例保证只跑一次 |
| 种子数据 | 系统字典（`entity_kinds`）放 0001；内置分类种子由应用层在建项目时插入（§5.1） |
| 初始版本 | v1 = 本文 §1–§11 全部 DDL（按 §3.4 顺序拼装） |

### 16.3 迁移 runner（步骤，不写实现代码）

| 步骤 | 动作 | 失败处理 |
|---|---|---|
| 1 | 打开连接，设 `journal_mode=WAL`、`foreign_keys=ON`、`busy_timeout` | 失败即退出 |
| 2 | 能力探针（§2.10） | 缺 JSON1/生成列 → 退出；缺 FTS5 → 降级标记 |
| 3 | 读 `PRAGMA user_version`、比对 `schema_migrations` | 不一致 → 退出并提示备份 |
| 4 | 对每个待应用版本：校验 sha256 → `BEGIN` → 执行 SQL → `INSERT INTO schema_migrations` → `PRAGMA user_version` → `COMMIT` | 任一失败 `ROLLBACK`，保留备份，报错版本号 |
| 5 | 迁移后 `PRAGMA foreign_key_check`（结果必须为空）→ `PRAGMA integrity_check` | 有输出 → 回滚到备份并报错 |
| 6 | FTS 可用时 `INSERT INTO fts_*(fts_*) VALUES('rebuild')` | 失败 → 记录并降级 |
| 7 | `ANALYZE`，记录 `duration_ms` | 非致命 |

### 16.4 幂等 DDL 约定

| 约定 | 说明 |
|---|---|
| 一律 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` / `CREATE TRIGGER IF NOT EXISTS` / `CREATE VIEW IF NOT EXISTS` / `CREATE VIRTUAL TABLE IF NOT EXISTS` | 重复执行不报错，便于恢复/测试 |
| 触发器/视图重建 | 迁移中先 `DROP TRIGGER/VIEW IF EXISTS` 再建，避免旧定义残留 |
| 幂等 ≠ 自动补列 | **禁止**"启动时逐列探测缺列再 ALTER"的 ensure_* 模式；结构变更必须写成显式迁移版本 |
| 默认值 | 新增 NOT NULL 列必须给 DEFAULT（SQLite 限制），或走表重建 |

### 16.5 禁止 ensure_* 式迁移（旧库教训）

旧库有 52 个 `ensure_*` 迁移函数，靠"逐列探测 + 补丁"在启动时改结构，导致：不可重放、顺序不可知、无法审计、失败半途难以恢复。新库规则：

1. 只有一个入口：按版本执行迁移文件。
2. 代码里**不允许出现** `PRAGMA table_info` 驱动的 DDL 分支（除测试/诊断工具）。
3. 任何结构变更必须新增 `000N_*.sql` + 更新 §13/§14/§15 文档。

### 16.6 破坏性变更（SQLite ALTER 能力有限）

SQLite 不支持 `DROP COLUMN`（旧版）/改约束/改类型，需表重建。标准 12 步（【推断】）：

| 步 | 动作 |
|---|---|
| 1 | `PRAGMA foreign_keys=OFF`（**事务外**执行） |
| 2 | `BEGIN` |
| 3 | `CREATE TABLE x_new (…目标结构…)` |
| 4 | `INSERT INTO x_new (列…) SELECT 列… FROM x`（显式列名，禁止 `SELECT *`） |
| 5 | `DROP TABLE x` |
| 6 | `ALTER TABLE x_new RENAME TO x` |
| 7 | 重建该表的索引/触发器/视图 |
| 8 | `PRAGMA foreign_key_check`（应为空） |
| 9 | `COMMIT` |
| 10 | `PRAGMA foreign_keys=ON` |
| 11 | 涉及 FTS → `rebuild`；否则跳过 |
| 12 | `PRAGMA integrity_check` |

> 表重建会改变 rowid（`worldbook_entries` 的 external content FTS 依赖 rowid）→ **重建后必须 FTS rebuild**（§11.5）。

### 16.7 备份

| 时机 | 方式 | 保留 |
|---|---|---|
| 每次迁移前 | `VACUUM INTO 'backups/pre-migrate-v<from>-to-<to>-<ts>.sqlite'`（不改源库、不重排 rowid） | 最近 5 份 |
| 用户手动导出 | Markdown/JSON 到数据目录 `exports/` | 用户管理 |
| 迁移失败 | 不自动回滚文件，保留备份 + 报错日志，提示用备份覆盖 | — |

### 16.8 迁移 ↔ 插件版本映射（计划）

| 插件版本 | schema 版本 | 内容 |
|---|---|---|
| P0 | v1 | 本文全部表 + 索引 + 触发器 + FTS |
| P1 | v2 | 按功能增列（如角色关系权重细分、场景契约锁定触发器） |
| P2 | v3+ | 同步相关（`sync_state` 扩展、冲突队列表） |

### 16.9 迁移测试门禁

| 用例 | 通过标准 |
|---|---|
| 空库 → v1 | 执行成功；`foreign_key_check` 空；`integrity_check` ok |
| 重复执行 v1 | 无报错、无结构变化（`schema_migrations` 仍 1 行） |
| 篡改历史迁移 | checksum 不符 → 拒绝启动 |
| v(N-1) → vN | 升级后数据完整（逐表 COUNT 对账） |
| 迁移中断（模拟失败） | 回滚到迁移前状态；备份可用 |
| 表重建（破坏性迁移） | `foreign_key_check` 空、FTS `integrity-check` 通过 |

---

## 17. 旧 InkFlow 坑位对照

> 旧库只读参考、不迁移；下表是"旧库已知坑 → 新库设计动作"，用于评审时逐条确认。

| 旧库问题 | 旧库表现 | 新库设计 | 强制层级 |
|---|---|---|---|
| `knowledge_relations` 用 `(source_type, source_id)` 多态、无 FK | 悬空引用；按 source_id 查询无索引 | 16 个类型化可空 FK + `CHECK` 恰一非空 + 生成列 `source_kind/source_id` + 2 个索引 | DB（FK/CHECK/UNIQUE） |
| `world_settings.category` 存字符串名而非分类 id | 分类改名/删除后关系断裂 | `category_id` → `world_setting_categories(project_id,id)` 复合 FK（RESTRICT） | DB（FK） |
| 实体表 `project_id` 是 int 代理键，对外 API 用 uuid | 内外 id 两套、易错配 | 全库 `TEXT` UUID；`project_id` 即项目 uuid；跨项目引用用复合 FK 拦 | DB（PK/FK） |
| 32/106 项目软删（约 30%）成僵尸数据 | 统计/列表/导出混入软删 | 软删列 + 全量 partial index + 默认查询过滤 + `v_active_projects`；purge 显式命令 | DB（partial index）+ APP（查询纪律） |
| 11 条引用不变量未真正生效（uuid 非空唯一、每项目 1 世界观根、角色名唯一…） | API 层偶尔漏校验即脏数据 | §12 矩阵逐条落到 FK/UNIQUE/CHECK/TRG；做不到的列明缺口并配测试 | DB + APP |
| 52 个 `ensure_*` 迁移不可重放 | 启动时改结构、不可审计 | `schema_migrations` + 顺序迁移 + checksum + 幂等 DDL；禁 ensure_* | DB/流程 |
| 章节号/卷号散落、删章后引用漂移 | 大纲/伏笔按章号引用会错位 | 章号由 `seq_in_volume` + 卷序派生（视图），不落库；删章不重排；引用走 `chapter_id` 外键而非章号 | DB（FK）+ APP（派生） |
| 大纲树"卷中卷"未约束 | 层级失控 | `kind` + 父节点 kind 触发器 + 唯一索引 | DB（TRG/UNIQUE） |

---

## 18. 【推断】清单

> 以下均为 Lead 规格未明确、由本文补充的设计选择。**需要 Lead/作者裁决**；每条给出理由与替代方案，便于快速否决而不推翻整体结构。

| 编号 | 推断内容 | 理由 | 替代方案 | 若否决的影响面 |
|---|---|---|---|---|
| INF-01 | 主键用 UUID **v7**（而非 v4） | 时间有序、索引局部性好、可近似按创建排序 | v4（`crypto.randomUUID()` 零实现成本）；需自实现约 20 行 v7 生成器 | 影响 id 生成器与索引；表结构不变 |
| INF-02 | 时间用 ISO-8601 UTC 毫秒**字符串**（而非 epoch ms 整数） | 可读、字典序=时间序、与旧端点 `Z` 口径一致；只存 UTC 是用户既定规范 | INTEGER epoch ms（更省空间） | 全部时间列类型；迁移需重写列 |
| INF-03 | 删除用 `deleted_at` 列（而非独立 tombstone 表）；项目软删只写项目行 | 单表过滤、可恢复、tombstone 语义由 change_log 承载 | 独立 tombstone 表（查询需 anti-join）；或项目软删时递归打标 | 全部表的删除/查询路径 |
| INF-04 | 跨表引用统一用 `(project_id, x_id)` 复合外键 + 父表 `UNIQUE(project_id,id)` | 从 DB 层杜绝跨项目脏引用（旧库软删项目后跨项目残留） | 单列 FK + 应用层校验（更轻，但重演旧库问题） | 所有父表多一个唯一索引、所有子表 FK 写法 |
| INF-05 | 世界观根由 `projects` 插入触发器自动建，根 id = 项目 id；根禁止删/迁 | 触发器无法生成 UUID，复用项目 id 合规；"恰 1"可 DB 强制 | 应用层建根 + 启动自检（更灵活，但可漏） | 项目创建流程、purge 顺序 |
| INF-06 | 知识关系用 16 个可空 FK + 生成列；事实账本 `subject_id` 保留多态 | 关系是图谱查询核心，值得宽表；事实主体类型未收敛成表，先应用层校验 | 知识关系拆连接表（投影干净但需多表 UNION）；事实也扩成 16 列 | §7.3 / §7.4 结构 |
| INF-07 | 章节号不落库，由 `seq_in_volume` + 卷序视图派生；删章不重排；未分卷不允许 | 避免重排导致引用漂移（旧库坑）；派生规则单一来源 | 落库 `chapter_number` + 重排命令维护 | 章节号相关查询、大纲/伏笔引用方式 |
| INF-08 | FTS：章节用独立表 + `chapter_index` 物化源；世界书用 external content；分词器 trigram；能力缺失降级 LIKE | 正文跨两表、external content 无法直接映射；trigram 适配中文无空格；node:sqlite 不能注册自定义分词器 | chapters 改用 external content 指向版本表（缺标题）；或用 `unicode61` + `Intl.Segmenter` 预分词（复杂） | 仅检索模块，不影响业务表 |
| INF-09 | `change_log` / `revisions` 作为追加型表，不设 `updated_at`/`rev`/`deleted_at` | 审计日志不可改写；UPDATE/软删语义无意义 | 全表统一带四列（语义混乱、易被误改） | 日志表结构 |
| INF-10 | 同步冲突用 `(updated_at, device_id)` LWW；落败版本写 `revisions` | 简单、可追溯、不丢数据；本地单用户阶段够用 | 字段级三方合并（二期）；或按实体类型定制规则 | 同步协议（本期不实现） |
| INF-11 | 角色名唯一建在归一化 `name_key` 上（trim/全角/大小写/零宽）；CJK 不做繁简合并 | 防止「张三 」「张三」绕过唯一约束；不做繁简避免误合并 | 用 `COLLATE NOCASE` 索引（对中文无效）；或只存原名 | 角色表结构 + 导入清洗 |
| INF-12 | 章/版本状态机（§4.3.2）、整体大纲至少 1 条由应用层建、卷大纲唯一由应用层保证 | 状态流转与业务动作绑定，DB 强制成本高 | 全部落触发器（复杂、难维护） | 业务流程 |
| INF-13 | 内置分类 8 类（地理/势力/力量体系/物品/种族/历史/规则/其他），按项目插入 | 覆盖常见设定类型；项目隔离允许自定义 | 全局分类（跨项目共享，改名影响面大） | 分类种子与项目创建流程 |
| INF-14 | 世界书 `keywords` 用空格分隔小写文本（非 JSON） | 直接喂 FTS/触发匹配，无解析成本 | JSON 数组（结构化好，但检索/匹配需解析） | 词条表一列 + 匹配代码 |
| INF-15 | `era_scale` = 纪元倍率（跨纪元换算系数），`time_value` = 该纪元刻度值（REAL） | 支持「凡界 60 年 = 修仙界 30 年」这类多时钟设定 | `era_scale` 表示精度层级（year/month/day），换算另建表 | 时间线语义；需作者确认 |
| INF-16 | 规模假设（≤3000 章/≤2 万设定/≤5GB/单进程） | 决定索引与约束取舍 | 更大规模需分库/归档策略 | 索引策略、FTS 取舍 |
| INF-17 | 五条设计原则（DB 约束优先、可推导不冗余、枚举集中、软删可恢复、单一写入协议） | 降低实现分歧 | — | 全局 |
| INF-18 | `app_settings` 已知键清单（device_id / ui.* / writing.* / export.watermark.seq / capabilities.fts5） | 避免键名散落 | 由 UI 实现自由定义 | 设置模块 |
| INF-19 | `change_log.payload_mode` 默认 `snapshot`（整行） | 同步/合并可直接用整行；patch 乱序难重放 | patch（体积小） | 日志体积与同步实现 |

---

## 19. 待拍板问题

| # | 问题 | 本文默认取值 | 影响面 | 建议裁决人 |
|---|---|---|---|---|
| Q1 | 主键 v7 vs v4？ | v7 | ID 生成器、索引 | Lead |
| Q2 | 时间字符串 vs epoch ms？ | ISO-8601 UTC 字符串 | 所有时间列/导出 | Lead |
| Q3 | 章节是否允许"未分卷"（当前 `volume_id NOT NULL`） | 不允许，应用层建默认卷 | 章节表、章号规则 | 作者/Lead |
| Q4 | `era_scale` 语义 = 纪元倍率（INF-15）是否符合《蜀山》这类多时钟设定？ | 倍率 | 时间线模块 + 抽取提示词 | 作者 |
| Q5 | 知识关系类型清单（16 种）是否覆盖创作需要？ | 16 种 | 图谱/审计规则 | Lead/作者 |
| Q6 | 世界书关键词空格分隔（INF-14）是否可接受？ | 接受 | 词条导入/匹配 | Lead |
| Q7 | `facts_ledger.subject_id` 保留多态是否可接受（INF-06）？ | 接受，应用层校验 | 事实抽取/校验 | Lead |
| Q8 | FTS 能力是否可用（node:sqlite 的 FTS5/trigram/JSON1/生成列/复合外键）？ | **已裁决：实测通过**（宿主 SQLite 3.53.4；`docs/tech-spike.md` §5），检索按 trigram（≥3 字）+ 2 字 `LIKE` 兜底 | 无（探针保留为启动自检） | 已关闭（留作回归探针） |
| Q9 | 项目软删只打项目行、子表靠过滤（INF-03）是否接受？ | 接受 | 仓储层读取纪律 | Lead |
| Q10 | `chapter_versions` / `revisions` 边界：正文只进版本表、revisions 不存正文 | 按本文 | 存储体积、审计 | Lead |

---

## 20. 验收清单

> 以下每条都可在实现后写成自动化测试；标 [P0] 的为必须通过项。
>
> **本地验证快照（2026-10-21）**：本文 33 个含 `CREATE` 的 SQL 块已在空库按文档顺序用 `node:sqlite`（SQLite 3.53.0，与宿主 3.53.4 同线）执行，**0 失败**；26 项冒烟断言全部通过（项目插入自动建根、根禁删/禁软删、跨项目复合 FK 拒绝、卷中卷拒绝、角色重名拒绝、知识关系恰一非空 + 生成列 + 去重、追加表禁 UPDATE、FTS 正文入索引 + 3 字命中 / 2 字不命中 + 软删摘除）。宿主 3.53.4 的完整能力证据见 `docs/tech-spike.md` §5。

### 20.1 DDL 与迁移

- [ ] [P0] 空库执行 §1–§11 全部 DDL 成功（`sqlite3` / `node:sqlite` 双环境）
- [ ] [P0] `PRAGMA foreign_key_check` 无输出；`PRAGMA integrity_check` 返回 `ok`
- [ ] [P0] 重复执行迁移无报错、`schema_migrations` 不重复插入
- [ ] [P0] 篡改迁移文件 checksum → 启动拒绝
- [ ] [P0] 代码库中不存在 `ensure_*` 式结构补丁（grep 门禁）
- [ ] [P0] 全库无裸 UPDATE 绕过仓储层（lint/评审门禁）

### 20.2 不变量（对应 §12）

- [ ] [P0] 插入项目 → 自动生成 1 条世界观根（id = 项目 id、`is_root=1`、`category_id NULL`）
- [ ] [P0] 再插第 2 条根 → UNIQUE 拒绝
- [ ] [P0] 软删根 / 硬删根（项目活跃）→ 触发器拒绝
- [ ] [P0] 项目软删后硬删项目 → 根随 CASCADE 删除成功（purge 顺序）
- [ ] [P0] 非根世界观缺 `parent_id` 或缺 `category_id` → CHECK 拒绝
- [ ] [P0] 跨项目卷挂章 → 复合 FK 拒绝
- [ ] [P0] 卷大纲挂到卷大纲下（卷中卷）→ 触发器拒绝
- [ ] [P0] 每项目第 2 条 `overall` 大纲 → UNIQUE 拒绝
- [ ] [P0] 同名角色（含前后空格/全角差异）→ 归一化后 UNIQUE 拒绝
- [ ] [P0] 知识关系源/目标都为空或都非空 → CHECK 拒绝
- [ ] [P0] 知识关系重复边（同类型同源同目标）→ UNIQUE 拒绝
- [ ] [P0] 知识关系自环 → 应用层拒绝（单测）
- [ ] [P0] `resolved` 伏笔缺 `resolved_chapter_id` → CHECK 拒绝
- [ ] [P0] 图钉同时绑两个目标 → CHECK 拒绝
- [ ] [P0] `app_settings` scope 与 project_id 不匹配 → CHECK 拒绝
- [ ] [P0] 对 `change_log` / `revisions` UPDATE → 触发器拒绝
- [ ] [P0] 所有 `*_json` 列写入非法 JSON → CHECK 拒绝

### 20.3 章号与版本

- [ ] [P0] `v_chapter_numbering` 对 2 卷 × 若干章给出连续全书章号；删中间章后保留断档
- [ ] [P0] 调整卷序后全书章号随视图变化、章 id 不变
- [ ] [P0] 每章仅 1 条 `final` 版本 + 历史版本 `superseded`
- [ ] [P0] `chapters.word_count` 与当前版本字数一致（仓储层重算后校验）

### 20.4 FTS

- [ ] [P0] 插入/更新/软删/恢复章节后，FTS 检索结果同步（旧词不再命中、新词命中、软删不命中）
- [ ] [P0] 世界书词条同样四态同步
- [ ] [P0] FTS `integrity-check` 通过；`rebuild` 幂等
- [ ] [P1] 中文 ≥3 字查询命中；2 字查询走 LIKE 兜底（行为符合 §11.1 限制说明）
- [ ] [P1] 3000 章规模下：`rebuild` < 5 s、单次检索 P95 < 100 ms（本机 SSD 参考值）

### 20.5 同步预留

- [ ] [P0] 每一次业务写（含软删）都产生 1 条 `change_log`，`rev` 与业务行一致
- [ ] [P0] `change_log.seq` 单调；删除行 `op='delete'` 且 payload 含删前快照
- [ ] [P0] 导出器按 `sync_state('local-export').push_cursor` 增量导出并可推进游标
- [ ] [P0] `sync_state` 游标只增不减；损坏恢复路径有测试

### 20.6 文档一致性

- [ ] [P0] §13 枚举与 DDL 中所有 `CHECK` 取值逐项一致（脚本比对）
- [ ] [P0] §14 JSON 清单与 DDL 中 `json_valid` 列一一对应（脚本比对）
- [ ] [P0] §15 索引清单与 DDL `CREATE INDEX` 一一对应（脚本比对）
- [ ] [P0] §18 推断清单无遗漏（正文出现的 `INF-xx` 均有条目）

---

## 附：推断清单速查（INF-01 – INF-19）

> 完整理由与替代方案见 [§18](#18-推断清单)。**全部 19 条推断均需 Lead/作者裁决（§19 Q1–Q10）后才可冻结为 v1 迁移。**

| 编号 | 一句话 | 所在章节 |
|---|---|---|
| INF-01 | 主键用 UUID v7（时间有序） | §2.1 |
| INF-02 | 时间存 ISO-8601 UTC 毫秒字符串 | §2.2 |
| INF-03 | 软删用 `deleted_at` 列；项目软删只写项目行 | §2.3 |
| INF-04 | 跨表引用用 `(project_id, x_id)` 复合外键 | §2.6 |
| INF-05 | 世界观根由触发器建、根 id = 项目 id、禁止删/迁 | §5.2 |
| INF-06 | 知识关系 16 列类型化 FK + 生成列；事实账本保留多态 `subject_id` | §7.3 / §7.4 |
| INF-07 | 章节号由 `seq_in_volume` + 卷序视图派生，删章不重排 | §4.3.3 |
| INF-08 | 章节独立 FTS + `chapter_index` 物化源；世界书 external content；trigram | §11 |
| INF-09 | `change_log` / `revisions` 为追加型表，不设 rev/deleted_at | §2.11 |
| INF-10 | 同步冲突 `(updated_at, device_id)` LWW + 落败快照 | §10.5 |
| INF-11 | 角色名唯一建在归一化 `name_key` 上 | §6.1 |
| INF-12 | 章/版本状态机与"至少 1 条根/整体大纲"由应用层保证 | §4.3.2 / §4.4 |
| INF-13 | 内置世界观分类 8 类、按项目插入 | §5.1 |
| INF-14 | 世界书关键词用空格分隔文本 | §5.3 |
| INF-15 | `era_scale` = 纪元倍率、`time_value` = 纪元内刻度 | §7.2 |
| INF-16 | 规模假设（≤3000 章 / ≤2 万设定 / ≤5GB / 单进程） | §1.4 |
| INF-17 | 五条设计原则（DB 约束优先等） | §1.5 |
| INF-18 | `app_settings` 已知键清单 | §9.3 |
| INF-19 | `change_log.payload_mode` 默认 `snapshot` | §10.1 |

---

*（全文完）本文为 v0.1 设计稿：全部 DDL 按 §3.4 顺序拼接（系统字典 §3.5 最前，`schema_migrations` 见 §16.1）即为 `migrations/0001_init.sql` 候选内容；宿主 SQLite 3.53.4 的能力已实测（`docs/tech-spike.md` §5）。实现前请先裁决 §19 的 Q1–Q10。*


