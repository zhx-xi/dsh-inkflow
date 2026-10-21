# dsh-inkflow 数据模型（文件真相 + 派生索引）

> 状态：**v2（2026-10-21 架构变更后）**。
> 契约权威：[.agents/specs/conventions.md](conventions.md)（目录/文件格式/门禁）。
> 决策依据：[ADR-0005](../adrs/0005-files-first-with-derived-index.md)。
> 旧版（SQLite 为真相源，35 张物理表 + FK/触发器/迁移）已作废、**不入库**：全文见取代点之前的 git 历史（`git log -- .agents/adrs/0005-*`）。本文只保留「哪些不变量值得保留」的清单。

## 1. 一句话

**真相 = 项目 git 仓库里的 Markdown/JSON 文件；索引 = `index/inkflow.db`，随时可删可重建。**
因此没有「数据库迁移」这个问题，也没有「插件升级改坏存量项目」这个问题：升级只改解析器与索引 schema 版本，索引直接重建。

## 2. 实体 → 文件位置（22 个实体组）

| # | 实体组 | 位置 | 形态 | 说明 |
|---|---|---|---|---|
| 1 | 项目（book） | `inkflow.json` | JSON | 唯一元信息文件（schemaVersion/title/author/seriesId） |
| 2 | 卷 volume | `chapters/<vol-dir>/` + `chapters/index.json` 的卷项 | 目录 + JSON 投影 | 目录名携带 `volumeId`（`vol-NN-<slug>`）；卷的展示信息在大纲 `kind: volume` 节点里，catalog 只记 `title`/`order` |
| 2b | 卷章清单 catalog | `chapters/index.json`、`chapters/<vol-dir>/index.json` | JSON（派生投影） | `.md` 的投影（ADR-0006 D6）：入库、可审阅、不含派生统计 |
| 3 | 章 chapter | `chapters/**/<seq>-<slug>.md` | MD + frontmatter | 正文即 body |
| 4 | 章版本 | git 提交历史 | git | 不建 `chapter_versions` 表；版本 = commit |
| 5 | 大纲节点 outline | `outlines/*.md` | MD + frontmatter | `kind: overall\|volume\|chapter`，`parent` 挂接 |
| 6 | 情节点 plot_point | 大纲文件正文的列表项 | MD 列表 | P1 定义结构化语法（当前自由文本） |
| 7 | 故事线 arc | `outlines/arcs/<slug>.md` | MD + frontmatter | P1 落地 |
| 8 | 世界观树 world_setting | `world/<category>/<slug>.md` | MD + frontmatter | 目录即分类；`parent` 建树 |
| 9 | 世界书词条 worldbook | `world/**` 的 frontmatter 字段 | 复用 | `keywords` / `always` / `priority` |
| 10 | 角色 character | `characters/<slug>.md` | MD + frontmatter | `name` 项目内唯一（索引校验） |
| 11 | 角色分组 group | 角色 frontmatter `group` | 字段 | P1 可升级为 `characters/_groups.json` |
| 12 | 角色关系 relation | `world/relations.json` | JSON | 建议归属（待拍板 C2） |
| 13 | 角色语言基因 voice | 角色 frontmatter + body 段 | MD | P1 定字段 |
| 14 | 角色状态 state | 角色 frontmatter `states`（按章） | JSON 片段 | P1 定字段 |
| 15 | 伏笔 foreshadowing | `foreshadowing/<slug>.md` | MD + frontmatter | 一级目录自证归属（[conventions.md §3.8](conventions.md#38-伏笔-foreshadowingmd)）；`resolved` 必须带 `resolvedChapter` |
| 16 | 时间线事件 timeline_event | `world/timeline/<slug>.md` | MD + frontmatter | 建议归属（待拍板 C2） |
| 17 | 知识关系 knowledge_relation | `world/relations.json` | JSON | 与 #12 共用文件、按 `kind` 区分 |
| 18 | 事实账本 facts_ledger | `world/facts/<subject>.md` | MD + frontmatter | 建议归属（待拍板 C2） |
| 19 | 场景契约 scene_contract | `outlines/scenes/<chapter>.md` | MD + frontmatter | P1 落地 |
| 20 | 提案 / 修订 proposal | `index/proposals/`（派生，非真相） | JSON | 提案是临时件，接受后才写正文并 git commit |
| 21 | 审计运行 audit_run | `index/audit/<timestamp>.json` | JSON | 派生物，可删 |
| 22 | 提取暂存 extraction_staging | `index/extraction/<run>.json` | JSON | 派生物；确认后才生成实体文件 |
| 23 | 地图 map / pin | `world/maps/*.md` + 图片 | MD + 资产 | P2 |
| 24 | 插件设置 app_settings | `~/.dsh/inkflow/state.json` | JSON | 只存 lastProjectRoot，不存作品数据 |
| 25 | 变更日志 change_log | git 历史 | git | 不再自建 outbox：**git 就是变更日志** |
| 26 | 资料 library | `library/**` | 任意文件 | 只索引路径/大小 |

> 「22 个实体组」与原清单一致（2b 是 `.md` 的派生投影，不新增业务实体组）；#23–#26 是系统/检索类，不是业务实体。

## 3. 文件通用字段（frontmatter 字典）

| 字段 | 类型 | 适用 | 语义 |
|---|---|---|---|
| `id` | string | 全部 | 稳定标识；缺省用相对路径（改名即换 id，故建议显式写） |
| `title` | string | 章/世界观/大纲 | 显示名 |
| `name` | string | 角色 | 角色名（唯一性按归一化 name 判定） |
| `aliases` | string[] | 角色 | 别名（P1 索引） |
| `volume` | string | 章 | 卷 id（`volumeId`，如 `vol-01`；不是目录名）；缺省从所在卷目录推导 |
| `seq` | int | 章 | 卷内序号；缺省取文件名前导数字 |
| `status` | enum | 章 | `draft` / `revised` / `final` |
| `kind` | enum | 大纲 | `overall` / `volume` / `chapter` |
| `parent` | string | 世界观/大纲 | 上级 id（树结构） |
| `category` | string | 世界观 | 分类名，应与所在目录一致；缺省取 `world/<category>/` 的目录名，直接放在 `world/` 下的条目没有分类 |
| `keywords` | string[] | 世界观 | 世界书触发词 |
| `always` | bool | 世界观 | 是否常驻注入 |
| `group` / `role` / `pov` / `firstAppearance` | string/int | 角色/章 | 创作辅助字段 |
| `resolved` | bool | 伏笔 | 是否已回收；`true` 时必须同时写 `resolvedChapter`（I-09） |
| `resolvedChapter` | string | 伏笔 | 回收所在章的 id（章 frontmatter 的 `id`） |

未知字段：**保留在文件里，索引忽略**——这样加字段不需要改插件，也不会因为插件旧而丢用户数据。

## 4. 派生索引（`index/inkflow.db`，v1）

| 表 | 主键 | 主要内容 | 用途 |
|---|---|---|---|
| `meta` | key | builtAt / root / indexSchemaVersion / fileCount | 索引元信息 |
| `files` | path | dir / kind / size / mtime | 全量文件清单（增量检测基础） |
| `chapters` | id | path / seq / title / volume / status / word_count | 章列表、字数统计 |
| `characters` | id | path / name / name_key / group_name / role | 角色查询、重名校验 |
| `world_entries` | id | path / title / category / parent | 世界观树 |
| `outline_nodes` | id | path / kind / title / parent / order_index | 大纲树与不变量校验 |
| `library_files` | path | size / mtime | 资料登记 |
| `validation_issues` | seq | code / path / detail | 重建时发现的不变量问题 |
| `chapters_fts` | (virtual) | chapter_id / title / body，`tokenize='trigram'` | 全文检索（中文 ≥3 字；2 字走 LIKE 兜底） |

- 版本：`PRAGMA user_version = 1`；与代码不一致 → **删库重建**，不做 ALTER。
- 重建：清空 → 全量扫描 → 事务写入 → 校验；`index/` 里除 `.gitkeep` 外全部是派生物。
- 中文检索实测依据：宿主 SQLite 3.53.4 + FTS5 `trigram`——3 字命中、2 字不命中（证据见 P0 实测 PR 评论）。

## 5. 不变量与强制手段（从「DB 强制」改为「应用层 + 重建校验」）

| # | 不变量 | 写入时（P1 工具） | 重建时（已实现校验） |
|---|---|---|---|
| I-01 | 每项目恰 1 条 `overall` 大纲 | 拒绝第二份 | `OUTLINE_NO_OVERALL` / `OUTLINE_MULTIPLE_OVERALL` |
| I-02 | 卷大纲必须挂 overall；禁止卷中卷 | 拒绝 | `OUTLINE_VOLUME_PARENT` / `OUTLINE_VOLUME_IN_VOLUME` |
| I-03 | 角色名项目内唯一（归一化） | 拒绝 | `CHARACTER_NAME_DUPLICATE` |
| I-04 | 章 id / 路径不重复 | 拒绝 | `DUPLICATE_ID` |
| I-05 | `parent` 必须指向存在条目 | 拒绝 | `DANGLING_PARENT` |
| I-06 | 章状态取值合法 | 拒绝 | 非法值降级为 `draft`（不阻断） |
| I-07 | 正文文件必须是 `.md` | 拒绝 | `CHAPTER_NOT_MARKDOWN` |
| I-08 | 世界观根唯一、非根必须有 parent + category | 拒绝 | `WORLD_ROOT_MISSING` / `WORLD_ROOT_MULTIPLE` / `WORLD_CATEGORY_REQUIRED` |
| I-09 | 伏笔 resolved 必须带 resolved 章 | 拒绝 | `FORESHADOW_RESOLVED_WITHOUT_CHAPTER` |
| I-10 | JSON 字段可解析 | 写入前序列化 | `FRONTMATTER_ISSUE` |
| I-11 | 同卷 `(volumeId, seq)` 唯一 | 拒绝重号（P1 章写入工具） | `CATALOG_DUPLICATE` |
| I-12 | `looseChapters` 的 `seq` 唯一 | 同上 | `CATALOG_DUPLICATE` |
| I-13 | 卷目录 `dir` 以 `volumeId` 开头且目录存在 | 拒绝建卷（P1） | `VOLUME_DIR_MISMATCH` |
| I-14 | catalog 指向的 `file` 必须存在且是 `.md` | 写入前校验 | `CHAPTER_FILE_MISSING` |

I-11–I-14 由 `validateCatalog` 报码，**不阻断**（同 `validation_issues`）。catalog 与 `.md` 投影不一致另报 `CATALOG_STALE`——那是「该重建了」的漂移信号，不是不变量；重建即修复，不是数据损坏。

「世界观根」= 不带 `parent` 的条目：重建校验要求**恰有一条**（零条 `WORLD_ROOT_MISSING`、多条 `WORLD_ROOT_MULTIPLE`），于是「非根条目必须有 parent」随之成立；非根条目还必须有分类（`category` 字段，或位于 `world/<category>/` 下），否则 `WORLD_CATEGORY_REQUIRED`。判定结果只进 `validation_issues`，不阻断索引。

**与旧设计的差异**：不再有 FK / CHECK / 触发器；UNIQUE 只对「索引内可判定的键」有效。代价是不变量要靠代码纪律兜住——因此每条不变量都必须在重建校验里有对应 code，可作为「代码没兜住」的第二道网。

**验证**：`node --test tests/invariants.test.js`（I-01…I-10 每条一个能 FAIL 的 fixture）与 `node --test tests/index-parity.test.js`（索引集合 == 磁盘集合、预埋 issues == 返回 issues、连续两次 rebuild 幂等）。

## 6. 2.0 同步为什么更容易了

旧设计需要 outbox / 版本向量 / tombstone 才能同步（因为 SQLite 变更不可读）。文件真相下：

| 旧需求 | 文件方案 |
|---|---|
| change_log 表 | `git log`（自带 author/time/diff） |
| tombstone 防复活 | git 删除提交（可 revert） |
| 冲突检测 | git merge 冲突（同一文件） |
| 增量传输 | 传输 commit 范围 / 文件 diff |
| 备份 | 每书一个 git remote |

因此 2.0 服务端只需「git 远端 / 对象存储 + 认证」，不需要自定义变更日志协议。

## 7. 待补（P1 开工前）

1. 「待拍板 C2」的归属目录确定后，补 §2 #12/#15/#16/#17/#18 的字段字典。
2. 情节点 / 故事线 / 场景契约的**结构化语法**（当前为自由文本）。
3. 增量重建策略（当前全量重建；先在 59 万字样本上测耗时再决定是否需要）。
4. 写入器（原子替换 + 提案制）与「写正文必须经审批」的实现细节。
