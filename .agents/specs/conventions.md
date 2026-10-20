# InkFlow 项目目录约定（约定大于配置）

> 状态：**已定（用户拍板 2026-10-21）**。本文是插件的唯一契约来源；代码里的 `src/host/conventions.ts` 必须与本文逐字一致。
> 决策依据：[ADR-0005](../adrs/0005-files-first-with-derived-index.md)。

## 1. 什么算一个 InkFlow 项目

**一部小说 = 一个 git 仓库 = 一个项目根目录。** 插件只在满足以下**全部**条件时工作：

| # | 条件 | 判定方式 |
|---|---|---|
| G1 | 目录是 git 仓库 | 根目录存在 `.git`（目录，或 worktree 的 `.git` 文件） |
| G2 | 六个目录同时存在 | `chapters/`、`characters/`、`world/`、`outlines/`、`index/`、`library/` |
| G3 | 根元信息可解析 | `inkflow.json` 存在且 `schemaVersion` 为整数（缺失时按「待初始化」处理，业务工具拒绝） |

不满足 → 业务工具返回 `NOT_AN_INKFLOW_PROJECT`，并列出**缺哪一条**（不猜、不兜底、不在随机目录建库）。

> **`index/` 的例外（唯一）**：它是派生物。G2 检查时若**仅** `index/` 缺失而其余五项齐备，插件会自动创建 `index/` 并在返回里标注 `indexDirRecreated: true`——否则「误删索引目录 = 插件永久失效」。这一条是对 G2 的唯一放宽，需用户确认（见 §8）。

## 2. 目录树

```
<book-root>/                     ← git 仓库根，项目根
├── inkflow.json                 ← 项目元信息（唯一配置入口）
├── .gitignore                   ← 至少忽略 index/*.db*
├── chapters/                    ← 正文
│   └── vol-01/0001-<slug>.md
├── characters/                  ← 角色
│   └── <slug>.md
├── world/                       ← 世界观 / 设定库
│   └── <category>/<slug>.md
├── outlines/                    ← 大纲
│   ├── overall.md
│   ├── vol-01.md
│   └── ch-0001.md
├── index/                       ← 派生索引（可由文件重建，禁止手改）
│   ├── .gitkeep                 ← 入版本控制，保证 clone 后目录存在
│   └── inkflow.db               ← 派生 SQLite（.gitignore）
└── library/                     ← 资料（原始参考材料，任意文件）
```

目录名**固定英文**，不提供改名配置。理由：门禁靠目录名自证身份；一旦可配置，就必须有注册表/配置文件，回到「配置地狱」。

## 3. 文件格式

### 3.1 `inkflow.json`（项目元信息）

```json
{
  "schemaVersion": 1,
  "title": "蜀山",
  "author": "zhx-xi",
  "seriesId": null,
  "createdAt": "2026-10-21T06:40:00.000Z"
}
```

- `schemaVersion`：**文件契约**版本。升级只增不改；读不懂的高版本 → 拒绝写入（只读提示），不静默降级。
- 其余字段可缺省；缺省即为「未填」，不编默认值。

### 3.2 正文 `chapters/**/*.md`

```markdown
---
id: 6f1c2c1e-...        # 可选；缺省用相对路径生成稳定 id
title: 第一章 入山
volume: vol-01          # 可选；缺省取所在目录名
seq: 1                  # 可选；缺省取文件名前导数字
status: draft           # draft | revised | final
pov: 主角                # 可选
---

正文第一段……
```

- **正文就是 Markdown 正文**（frontmatter 之后），不加任何包装标记。
- 字数由插件派生（非空白字符数），不写回文件——避免 AI 与插件互相改字数字段。
- 章号派生规则：`seq`（显式）> 文件名前导数字 > 文件名排序；**删章不重排**，允许空号。

### 3.3 角色 `characters/<slug>.md`

```markdown
---
id: ...
name: 清音
aliases: [青音, 清音仙子]
group: 门派
role: 主角
firstAppearance: 1      # 章号
---
角色卡正文（性格/外貌/动机…自由格式）
```

### 3.4 世界观 / 设定库 `world/<category>/<slug>.md`

```markdown
---
id: ...
title: 白鹤门
category: 门派          # 目录名与 category 应一致，不一致以 category 为准并告警
parent: null            # 上级条目 id 或 path
keywords: [白鹤, 鹤鸣剑]  # 世界书触发词（P1 摘要注入用）
always: false           # 是否常驻注入
---
条目正文
```

### 3.5 大纲 `outlines/*.md`

```markdown
---
id: ...
kind: overall           # overall | volume | chapter
title: 全书总纲
parent: null            # volume 挂 overall；chapter 挂 overall 或 volume
order: 0
---
- 情节点 1
- 情节点 2
```

约束（由索引重建时的校验器检查，而非 DB 外键）：每项目恰 1 条 `overall`；`volume` 的 `parent` 必须是 `overall`；`chapter` 可挂 `overall`/`volume`，**禁止卷中卷**。

### 3.6 资料 `library/**`

任意文件（TXT/MD/PDF/图片）。插件只登记路径与大小，不解析内容（P1 起做导入与提取）。

### 3.7 索引 `index/`

| 文件 | 进 git？ | 说明 |
|---|---|---|
| `index/.gitkeep` | ✅ | 保证 clone 后 `index/` 存在，门禁不误判 |
| `index/inkflow.db` | ❌ | 派生 SQLite（含 `-wal`/`-shm`），可随时删除重建 |

## 4. 索引（派生层）

- 引擎：`node:sqlite`（宿主 Node 24 内置，无原生依赖）。
- 索引 schema 版本存在 `PRAGMA user_version`；与代码期望不一致 → **删库重建**，不做 ALTER 迁移。
- 每次重建 = 清空 + 重扫 + 事务提交；文件名/结构变化由「重建」消化，因此**永远没有数据库迁移问题**。
- 索引内容（v1）：`meta`、`files`、`chapters`、`characters`、`world_entries`、`outline_nodes`、`chapters_fts`（FTS5 trigram）。
- 校验器在重建后运行：duplicate id / 缺 `overall` / 卷中卷 / 角色名重复 / 悬空 `parent` → 记入 `validation_issues` 并返回，**不阻断索引可用**（只读仍可用，写入类工具 P1 再拦）。

## 5. 写入纪律（P1 实现，P0 已定原则）

| 规则 | 说明 |
|---|---|
| 原子替换 | 先写 `<file>.tmp-<pid>-<rand>`，`fsync` 后 `rename` 覆盖；禁止原地截断写入 |
| 只追加审计 | `world/../..` 之外的审计/事件写在 `index/`（派生）或 DSH 会话日志，不污染正文 |
| 不静默覆盖 | 改写既有正文必须走「提案 → 用户确认」（P1 提案制），P0 无写正文工具 |
| 删除可回溯 | 删文件交给 git（`git rm` 后可 `git revert`）；插件不物理删正文 |
| 中文与编码 | 全部 UTF-8（无 BOM），LF 行尾（`.gitattributes`） |

## 6. 门禁返回约定

```json
{
  "ok": false,
  "error": {
    "code": "NOT_AN_INKFLOW_PROJECT",
    "root": "D:\\小说\\某目录",
    "checks": { "git": false, "dirs": { "chapters": true, "characters": false, "...": false }, "meta": false },
    "missing": ["characters", "world", "outlines", "library"],
    "hint": "在项目根运行 inkflow_project_init 或手动补齐目录"
  }
}
```

## 7. 与旧 InkFlow 的关系

旧库（43 表 / 59 万字）不再是真相源；**迁移 = 生成上述文件树**。逐章、逐实体落盘后可直接 `git commit` 审阅，比跨 schema ETL 更容易核对（P4 执行）。

## 8. 待拍板（3 条，含建议默认值）

| # | 问题 | 建议默认 |
|---|---|---|
| C1 | `index/` 缺失时自动重建（§1 的放宽）是否接受？ | 接受（否则误删索引目录即永久失效） |
| C2 | 伏笔 / 时间线 / 知识关系 / 账本 的归属目录 | 伏笔 → `outlines/foreshadowing/`；时间线 → `world/timeline/`；知识关系 → `world/relations.json`；账本 → `world/facts/` |
| C3 | 新书创建是否提供 `inkflow_project_init`（建目录 + meta，不自动 `git init`）？ | 提供，且不代替用户 `git init`（git 身份/远端应由用户决定） |
