# 待裁决清单（Open Questions）

> **唯一允许频繁更新的规范类文件**。AGENTS.md 不承载易变内容，所有「还没定、等用户拍板」的事项都落在这里。
> 状态流转：`待定` → `已裁决`。已裁决项**不删除**，转入文末「裁决记录」并保留原推断与依据（防止下一轮被改回去）。

## 1. 待定

| # | 问题 | 建议默认值 | 影响面 | 状态 |
|---|---|---|---|---|
| Q1 | OVK 块参数：每块字数、重叠字数、单章块上限 | 800 字/块、100 字重叠（有效步长 700），单章不设上限但超 200 块告警 | 语义检索质量与体积（[ADR-0009](../adrs/0009-ovk-semantic-search.md) P5/P10） | 待定 |
| Q2 | OVK 写入落点：`resources` 还是 peer `memories`；只读策略是否拦 `write` | 先按 `resources` 写项目子树；被拒则语义检索标不可用 | 语义检索可用性（ADR-0009 E6 未验证） | 待定 |
| Q3 | OVK 首建的强制确认阈值（章数 / 体积 / 摘要调用次数） | >200 章或 >5 MB 必须显式确认，否则只建关键词索引 | 首建费用与体积（ADR-0009 P10） | 待定 |
| Q4 | 六维去 AI 味的具体维度与阈值 | 句长分布 / 破折号与省略号密度 / 排比与三段式 / 解释性旁白 / 形容词副词密度 / 段尾套路话 | 质量门禁实现 | 待定 |
| Q5 | 质量门禁条数：6 项还是 7 项（是否含机械校对） | 7 项＝6 条创作规则 + 机械校对（错别字/标点/重复） | 门禁范围与验收 | 待定 |
| Q6 | 平台审稿规则（起点 / 番茄）的来源与首发范围 | 先做 3 条硬规则：字数区间、章末钩子、违禁词表 | 门禁 | 待定 |
| Q7 | 多纪元历法最小可用集 | 纪元年偏移 + 年月日 + 闰规则可配 | 时间线与历法换算 | 待定 |
| Q8 | 知识图谱关系类型集合与校验强度 | 5 类关系（亲缘/师徒/隶属/敌对/位于）+ 孤立/冲突校验 | 关系存储与图谱视图 | 待定 |
| Q9 | 会话疲劳检测的指标与阈值 | 连续 N 轮质量下降 + 上下文占用率 | 写作稳定性 | 待定 |
| Q10 | 项目级文风档案的维度与落点 | 复用 9 轴文风卡；落点 `world/` 或 `library/` 未定（不新增一级目录） | 写作质量 | 待定 |
| Q11 | 性能基线（500 章树、检索、保存、重建） | 先按 [product-scope.md](product-scope.md) §6.3 执行，实测后统一校准 | 各阶段 DoD 阈值 | 待定 |
| Q12 | `inkflow.json.projectId` 的生成归属 | 由共享库落地（#40）时补进初始化向导；可缺省、不参与门禁 | 共享库 `origin.projectId` | 已裁决 → §2 R23 |
| Q13 | frontmatter 键是否允许非 ASCII（如 `作者备注:`） | 仅 ASCII 键（现状），中文键记 `FRONTMATTER_ISSUE`；若要支持需扩展解析器 | frontmatter 契约 | 待定 |
| Q14 | 地图要不要坐标与真实绘图（做则先定写法） | 不做坐标：坐标只能寄生在世界书条目的 body 或 `extra` 里（ADR-0025 D4 不许新增 kind/目录），要先定「坐标系 + 锚点」的写法；第一版是分类清单 + 跳转，已满足 D5-6 | 地图页、世界书条目形状 | 待定 |
| Q15 | 时间线事件的 `place` 要不要接进索引与地图 | 接：给 `timeline_events` 加一列并再 bump 一次 schema，换来「此地发生过哪些事」；不接则 `place` 只作记录（现状态） | 索引 v10、地图、时间线页 | 待定 |

> 已关闭的旧项：Q1（`index/` 缺失自动重建）、Q2/Q3（六目录与四域归属）、Q4（嵌套仓库 ignore）、Q5（init 是否代跑 `git init`）已转入 §2；产品范围里的「七分类树 / 多书 / MCP / 对外 API / 作品库目录」等口径同样在 §2 关闭，不再单列。

## 2. 裁决记录（22 条）

> 「原推断」＝裁决前文档/实现里的主张；「处置」＝✅ 确认（推断被采纳）/ ✏️ 修正（推断被改写）。
> 「用户原话 / 依据」列：**只有 ADR 正文或本文件历史记录中留存的逐字原话才写成引文**；其余记 ADR 决策号与要点，不伪造出处（D4）。

| # | 原推断 | 处置 | 用户原话 / 依据 |
|---|---|---|---|
| R1 | 存储以 **SQLite 单库为唯一真相源**，文件系统只存导入原文与导出物（ADR-0002；S-01 旧 §6.4） | ✏️ 修正为**文件真相 + SQLite 派生索引** | 「我选择 B，文件真相+sqlite派生索引，这样后续插件升级不影响现存项目，并且不需要考虑数据库迁移」（ADR-0005） |
| R2 | 升级走 `PRAGMA user_version` + 顺序迁移、可前滚可重放；变更日志/防复活靠自建 `change_log` + `rev/updated_at/device_id` + `deleted_at` tombstone | ✏️ 修正：**不写数据库迁移**（schema 不符删库重建）；版本历史 = git commit，回滚 = `git revert`，不再有 outbox/tombstone | [ADR-0005](../adrs/0005-files-first-with-derived-index.md) D1–D3 |
| R3 | 每个小说**六个英文目录**（chapters/characters/world/outlines/library + index）；伏笔/时间线/关系/账本作为 `world/`、`outlines/` 的子目录 | ✏️ 修正为**九个内容目录 + `index/`（十项）**：`foreshadowing/`、`timeline/`、`relations/`、`facts/` 各自一级；目录名固定英文、不可配置 | [ADR-0006](../adrs/0006-workspace-contract-v2.md) D1（取代原 Q2/Q3）；旧六目录口径作废 |
| R4 | 只有 `index/` 带 `.gitkeep` 兜底空目录；内容目录为空时 `git clone` 后消失无补救 | ✏️ 修正：**十个必需目录各带 0 字节 `.gitkeep`**；目录在但 `.gitkeep` 不在**等于结构缺失**，进 `needs-repair` | [ADR-0006](../adrs/0006-workspace-contract-v2.md) D1 |
| R5 | 门禁是**布尔** `usable: true/false` + 单一错误码 `NOT_AN_INKFLOW_PROJECT` | ✏️ 修正为**四态**：`needs-newer-plugin` → `usable` → `needs-repair` → `needs-setup`，按序命中即停；fail-closed，返回 `state`/`checks`/`missing`/`actions` 结构化清单 | [ADR-0006](../adrs/0006-workspace-contract-v2.md) D2 |
| R6 | `index/` 缺失按「缺目录」拒绝，误删索引目录即永久失效 | ✅ 确认**自动重建**：其余九项 + git + meta 齐全而仅 `index/` 缺失时，静默创建 `index/` 与 `.gitkeep` 并标 `indexDirRecreated: true`；这是判定路径上唯一的写操作 | [ADR-0006](../adrs/0006-workspace-contract-v2.md) D2（原 Q1/Q5 关闭） |
| R7 | 新书初始化 = 一次静默创建；`git init` 由用户自己跑（原 Q5 建议「不代跑」） | ✏️ 修正为**plan（只读）→ apply（`confirm: true`）两段式**；只补缺失项、不覆盖；`git init` 是唯一允许的 git 写操作，不做 `add`/`commit`/`remote`/身份/submodule；父级已有仓库时提示外层 `.gitignore` 由用户改 | [ADR-0006](../adrs/0006-workspace-contract-v2.md) D3/D4 |
| R8 | **多书**管理 + 项目列表 + `state.json.lastProjectRoot` 作为第三解析来源；跨书跳转方便 | ✏️ 修正为**一个工作区 = 一部小说 = 一个 git 仓库**；解析只有「显式 `projectRoot`」与「会话工作目录向上找」两个来源；`lastProjectRoot` 仅展示、不作解析来源；取消全局注册表 | [ADR-0006](../adrs/0006-workspace-contract-v2.md) D5 |
| R9 | 卷章归属靠**路径猜**：卷目录名 + frontmatter `volume` 推导，没有可审阅的卷章清单 | ✏️ 修正为 `chapters/index.json`（卷 + 散章）与 `chapters/<vol>/index.json`（卷内章）**入库的派生投影**；`volumeId`（`vol-NN`）稳定，章 frontmatter 用 `volumeId` 记录归属；catalog 不是门禁必需项 | [ADR-0006](../adrs/0006-workspace-contract-v2.md) D6 |
| R10 | 系列共享 = **模板项目 + 只读引用 + 显式同步 + 批量回滚**；共享内容放在每本书内部（或 submodule 引用同一目录） | ✏️ 修正为**插件级共享库** `$DSH_HOME/inkflow/shared/{world,library,snippets,series}/`；默认动作是**复制快照**进当前项目，书保持自包含；不做跨工作区写 | [ADR-0007](../adrs/0007-plugin-shared-library.md) C1–C3 |
| R11 | 复制即可用，不需要回答「副本从哪来、还新不新」 | ✏️ 修正：副本写 `origin{projectId,entryId,contentHash}`；`inkflow.json` 增可选 `projectId`（**不参与门禁**）；`contentHash` 不符标 **stale**，但**不自动改** | [ADR-0007](../adrs/0007-plugin-shared-library.md) C3 |
| R12 | 共享条目可以**引用**（不复制）以省磁盘、保持单一真相，任何域都可引用 | ✏️ 收窄：引用**只允许 `library/` 原文**；引用卡片只读（`REFERENCE_READONLY`），UI 明示「本项目不自包含」（`selfContained:false`）；`world/`/`snippets/`/`series/` 禁止引用 | [ADR-0007](../adrs/0007-plugin-shared-library.md) C4 |
| R13 | 系列是独立实体：**独立 `series` 表**（多书对一系列，原 PS-I-25） | ✏️ 修正为共享库 `series/<slug>.json` 分组 + 项目侧只有 `inkflow.json.seriesId`；一条目可属多系列；不复制系列文件 | [ADR-0007](../adrs/0007-plugin-shared-library.md) C5（PS-I-25 关闭） |
| R14 | 共享设定应**双向同步 / 同世界观完全同步**（原 F-P2-05、A-25），冲突时自动收敛 | ✏️ 修正为**单向快照 + stale 列表 + 显式「更新快照」**；不做反向推送、批量回滚、跨工作区自动同步（F-P2-05 按此改口径） | [ADR-0007](../adrs/0007-plugin-shared-library.md) C2/C6 |
| R15 | `.openviking/` 配置整体入库或整体忽略，没有分层 | ✅ 确认分层：`config.json`（团队层）入库、`config.local.json`（机器私有 peer）进项目 `.gitignore`；向导缺该行时列为可执行动作，**不自动改写**已有 `.gitignore` | [ADR-0007](../adrs/0007-plugin-shared-library.md) C7 |
| R16 | 面板入口 = `sidebar.panellist` 图标 + `main` 整页工作台（两处注册，id/key 必须一致） | ✏️ 修正为**只留 `conversation.view`**（session 作用域，`order: 40`）；撤掉两处 root 插槽——root 作用域拿不到会话，只能靠「上次打开的书」 | [ADR-0008](../adrs/0008-panel-data-channel.md) D1 |
| R17 | 面板数据走**对外 HTTP API** `/inkflow/api/*`：可版本化、出 OpenAPI、给第三方/其他 agent 调用 | ✏️ 修正为**私有内部通道** `/inkflow/internal/*`，**不是 API**：不版本化、不文档化、不承诺兼容；`/inkflow/api/*` 一律 404；方法逐路由声明（读 GET / 写 POST+JSON） | [ADR-0008](../adrs/0008-panel-data-channel.md) D2/D3 |
| R18 | 面板可让 Client 传 `root`/`path`，或用 `state.json.lastProjectRoot` 兜底，保证「总有点东西可显示」 | ✏️ 修正：Client **只传 `sessionId`**；Host 用 `workspaceRegistry` → `workingDirectory` 解析；`root`/`path`/`cwd` 出现在 query/body 即 400 且不触达文件系统；解析失败返回 `NO_SESSION_CONTEXT` | [ADR-0008](../adrs/0008-panel-data-channel.md) D4 |
| R19 | 保留 **MCP 双通道**（插件内工具 + MCP server，工具集差 = 0，原 F-P2-09）+ 对外 API；另配「操作 skills」教 agent 用工具 | ✏️ 删除 MCP 双通道与对外 API：插件形态是嵌入 DSH 的单机工作台，没有第二个消费者；远程同步走每书 git remote / 对象存储；技能只保留 5 个**写作工艺** skill，不做操作 skills；F-P2-09 改为「面板私有通道」 | [ADR-0008](../adrs/0008-panel-data-channel.md) 背景 8 + 取舍表；[ADR-0006](../adrs/0006-workspace-contract-v2.md) D5 |
| R20 | 语义检索应**自研 embedding + 向量表**（`sqlite-vec` 或纯 JS 余弦），把能力握在自己手里 | ✏️ 修正为**复用 OpenViking**：InkFlow 不自研 embedding/向量库，不新增运行时依赖；只负责「哪本书的哪些内容、怎么写进去、召回后怎么定位」 | [ADR-0009](../adrs/0009-ovk-semantic-search.md) P1 |
| R21 | 删章可以直接映射 `forget`；检索返回的 `abstract` 可当正文/引用原文用；每次重建「先 forget 再重建」 | ✏️ 修正：**删章不调用 `forget`**（它是永久物理删除）——文件进回收站 + 块覆盖为 tombstone + 召回过滤；`forget` 只在用户显式「清理已删除章节的语义条目」时执行；`abstract` 不是正文，定位必须回文件；重建 = 同路径覆盖 + 孤儿清理 | [ADR-0009](../adrs/0009-ovk-semantic-search.md) P5–P8 |
| R22 | 总估工 123–175 人日（逐项）/ 125–185 人日（规格口径）；issue 里程碑纪律未固化 | ✅ 确认里程碑纪律 + ✏️ 修正估工口径：**122–162 人日**（净开发 99–130 + 缓冲 23–32；旧 123–175 / 125–185 作废）；每个 issue 必须挂**当前里程碑**，过程中新发现的缺陷/补充分项也挂当前里程碑，仓库不允许无里程碑 issue | 2026-10-21 设计评审口径；[engineering-discipline](../constitution/engineering-discipline.md) §4 |
| R23 | `projectId` 何时生成、缺失怎么办未定 | ✅ 确认：**初始化向导写入** `inkflow.json`（uuid v4），既有书缺失即保持缺失（`origin.projectId` 可为 `null`）；不参与门禁、不作解析来源 | [ADR-0018](../adrs/0018-settings-backup-diagnostics.md) D7 |

## 3. 邻接口径（不单独占裁决条目）

| 事项 | 处置 | 出处 |
|---|---|---|
| 资料库「七分类树」 | ✏️ 修正为**九内容目录 + 派生 `index/`**（分类由一级目录自证，不再有第二套分类树） | [ADR-0006](../adrs/0006-workspace-contract-v2.md) D1 |
| 作品库目录（`~/Documents/dsh-inkflow-library`）作为数据落点 | ✏️ 作废：书的落点就是用户自己的 git 仓库；插件只保留 `$DSH_HOME/inkflow/` 放 `state.json` 与共享库 | [ADR-0005](../adrs/0005-files-first-with-derived-index.md) D1 |
| `inkflow_project_init` 是否需要确认 | ✅ 需要：`confirm: true`；apply 只执行 plan 列出的动作 | [ADR-0006](../adrs/0006-workspace-contract-v2.md) D3 |
| 章版本 / 内容修订历史 | ✅ 用 git 提交历史，不建 `chapter_versions` 表 | [ADR-0005](../adrs/0005-files-first-with-derived-index.md) D1 |
| 中文检索分词 | ✅ FTS5 `trigram`（≥3 字）+ 2 字 `LIKE` 兜底 | [ADR-0005](../adrs/0005-files-first-with-derived-index.md) 后果表 |
| 面板对外鉴权/兼容承诺 | ✏️ 不承诺：私有通道无版本化；loopback 加固继承 [ADR-0004](../adrs/0004-loopback-http.md) | [ADR-0008](../adrs/0008-panel-data-channel.md) D2/D3 |
