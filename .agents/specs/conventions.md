# InkFlow 项目目录约定（约定大于配置）

> **依据**：[ADR-0005](../adrs/0005-files-first-with-derived-index.md)（文件真相 + 派生索引）、[ADR-0006](../adrs/0006-workspace-contract-v2.md)（九目录 / 四态门禁 / catalog / 向导）、[ADR-0007](../adrs/0007-plugin-shared-library.md)（共享库字段与 `.gitignore`）、[ADR-0008](../adrs/0008-panel-data-channel.md)（面板通道）。
> **依赖**：[data-model.md](data-model.md)（字段字典与不变量）、[architecture.md](architecture.md)（模块边界）。
> **相关 ADR**：0004（loopback 加固，继承）、0006（目录与门禁，修改 0005 条款）、0007、0008。
> **状态**：活跃。本文是插件的唯一契约来源；代码里的 `src/host/conventions.ts` 必须与本文逐字一致。契约已定而尚未落地的部分见 §9。

## 1. 什么算一个 InkFlow 项目

**一部小说 = 一个 git 仓库 = 一个项目根目录 = 一个会话工作区。** 门禁每次判定产出**四态之一**，按下列顺序判定、命中即停（[ADR-0006](../adrs/0006-workspace-contract-v2.md) D2）：

| # | 状态 | 条件（按序） | 业务工具 | 允许的写操作 |
|---|---|---|---|---|
| 1 | `needs-newer-plugin` | `inkflow.json` 可解析且 `schemaVersion` **高于**插件支持上限 | 拒绝（只读） | **无**：不改 meta、不重建索引、不「修复」 |
| 2 | `usable` | 是 git 仓库 + 九个内容目录与 `index/` 齐全（每项含 `.gitkeep`；`index/` 缺失见放宽条款）+ `inkflow.json` 可解析且版本 ≤ 上限 | 正常 | 正常 |
| 3 | `needs-repair` | 未达 1/2，但书目录**有 `inkflow.json`（哪怕不可解析）或已有任一内容目录（InkFlow 布局）** | 拒绝 | 仅修复向导（只补缺失项，不覆盖） |
| 4 | `needs-setup` | 1/2/3 都不成立 | 拒绝 | 仅初始化向导（只建缺少项） |

三条判据展开：

| # | 判据 | 判定方式 |
|---|---|---|
| G1 | 是 git 仓库 | 根目录存在 `.git`（目录，或 worktree 的 `.git` 文件） |
| G2 | 十项目录齐全 | 九个内容目录 `chapters/ characters/ world/ outlines/ foreshadowing/ timeline/ relations/ facts/ library/` 与派生目录 `index/`，且**每项都带一个 0 字节 `.gitkeep`** |
| G3 | 根元信息可解析 | `inkflow.json` 存在、是 JSON 对象、`schemaVersion` 为整数（读取时容忍 UTF-8 BOM） |

- **缺 `.gitkeep` 等同于结构缺失**：git 不跟踪空目录，clone 后目录会消失，所以「目录在、`.gitkeep` 不在」进 `needs-repair`，由修复向导补一个空文件。除 `.gitkeep` 外，门禁**不**检查目录里有没有内容文件。
- **`needs-newer-plugin` 是终态**：唯一出路是升级插件；旧插件不得以任何「修复」名义改写 meta 或删除索引。
- **repair / setup 的判别信号**是「有 meta（哪怕不可解析）或已有任一内容目录」；单纯有 `.git` 不算——任何源码仓库都有 `.git`，曾因此把普通仓库误判成「待修复的书」。
- **唯一放宽**：`index/` 是派生物。当其余九项 + git + meta 全部满足而**仅 `index/` 目录缺失**时，门禁静默创建 `index/` 与 `index/.gitkeep` 并在结果里标 `indexDirRecreated: true`。这是判定路径上唯一的写操作。
- **fail-closed**：非 `usable` 时业务工具一律拒绝，并返回结构化清单而不是一句错误——`state`、`root`、`checks`（`git` / `dirs` / `keeps` / `meta` 逐项布尔）、`missing[]`、`actions[]`（动作类型 + 目标路径 + 原因）、`readOnly`。拒绝路径**零写盘**（唯一例外是上面的 `index/` 放宽）。
- **向导**：`needs-setup` 与 `needs-repair` 走同一套两段式流程（§6.3）——`plan` 只读列出将创建/补齐的项，`apply` 需显式确认后只执行清单里的动作；`git init` 边界见 §6.4。

## 2. 目录树

```
<book-root>/                     ← git 仓库根，项目根
├── inkflow.json                 ← 项目元信息（唯一配置入口）
├── .gitignore                   ← 见 §3.7 的必需行
├── .openviking/                 ← 语义检索的 peer 配置（可选，见 §9；私有层不入库）
│   ├── config.json              ← 团队层（可提交）
│   └── config.local.json        ← 机器私有层（.gitignore）
├── chapters/                    ← 正文
│   ├── .gitkeep
│   ├── index.json               ← 卷章 catalog（派生投影，入库，见 §3.8）
│   └── vol-01/
│       ├── index.json           ← 该卷的章清单（派生投影，入库）
│       └── 0001-<slug>.md
├── characters/                  ← 角色
│   ├── .gitkeep
│   └── <slug>.md
├── world/                       ← 世界观 / 设定库
│   ├── .gitkeep
│   └── <category>/<slug>.md
├── outlines/                    ← 大纲
│   ├── .gitkeep
│   ├── overall.md
│   ├── vol-01.md
│   └── ch-0001.md
├── foreshadowing/               ← 伏笔
│   ├── .gitkeep
│   └── <slug>.md
├── timeline/                    ← 时间线
│   ├── .gitkeep
│   └── <slug>.md
├── relations/                   ← 知识关系
│   ├── .gitkeep
│   └── <slug>.md
├── facts/                       ← 事实账本
│   ├── .gitkeep
│   └── <subject>.md
├── library/                     ← 资料（原始参考材料，任意文件）
│   └── .gitkeep
└── index/                       ← 派生索引（可由文件重建，禁止手改）
    ├── .gitkeep                 ← 入版本控制，保证 clone 后目录存在
    ├── inkflow.db               ← 派生 SQLite（.gitignore）
    ├── .lock                    ← 索引重建锁（.gitignore）
    └── .write.lock              ← 单项目写锁（.gitignore）
```

九个内容目录各自是一级目录、**互不嵌套**：伏笔、时间线、知识关系、事实账本不再挂在 `world/`、`outlines/` 之下，域归属由目录自证，门禁与工具都不必猜层级。

目录名**固定英文**，不提供改名配置。理由：门禁靠目录名自证身份；一旦可配置，就必须有注册表/配置文件，回到「配置地狱」。

## 3. 文件格式

### 3.1 `inkflow.json`（项目元信息）

```json
{
  "schemaVersion": 1,
  "title": "蜀山",
  "author": "zhx-xi",
  "projectId": "8b1f3a6e-2c4d-4e7a-9f10-5b6c7d8e9f01",
  "seriesId": null,
  "createdAt": "2026-10-21T06:40:00.000Z"
}
```

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `schemaVersion` | int | ✅ | **文件契约**版本。升级只增不改；读不懂的高版本 → 拒绝写入（只读提示），不静默降级 |
| `title` / `author` | string | — | 显示用；缺省即「未填」，不编默认值 |
| `projectId` | UUID string | — | 项目身份（[ADR-0007](../adrs/0007-plugin-shared-library.md) C3）：初始化向导生成、随仓库走。**可选，不参与门禁**——缺失合法，只让共享库副本的 `origin.projectId` 为 `null` |
| `seriesId` | string \| null | — | 指向共享库 `series/<slug>.json` 的 `seriesId`（[ADR-0007](../adrs/0007-plugin-shared-library.md) C5）；不复制系列文件 |
| `createdAt` | ISO 8601 | — | 生成时间，仅展示 |

**实现状态**：向导当前只写 `schemaVersion` / `title` / `author` / `createdAt`（`src/host/workspace.ts` 的 `metaBody`）；`projectId` 的生成尚未落地（归 #40，共享库需要它区分来源）。

### 3.2 正文 `chapters/**/*.md`

```markdown
---
id: 6f1c2c1e-...        # 建章时由插件生成的 uuid（randomUUID），改名/移卷不变
title: 第一章 入山
volume: vol-01          # 可选；卷归属由它（= volumeId）决定，不靠目录名推导
seq: 1                  # 可选；缺省取文件名前导数字
status: draft           # draft | revised | final
pov: 主角                # 可选
---

正文第一段……
```

- **正文就是 Markdown 正文**（frontmatter 之后），不加任何包装标记。
- **文件名 = `NNNN-<slug>.md`**（散章直接放 `chapters/`，入卷放 `chapters/vol-NN-<slug>/`）；`NNNN` 是补零到 4 位的 `seq`，删章不重排（允许空号）。
- **卷归属用 frontmatter 的 `volume` 字段**（[ADR-0006](../adrs/0006-workspace-contract-v2.md) D6）：值就是 `vol-NN` 稳定标识，改卷目录的 slug 不改归属；目录名只用于定位文件。字段名沿用 `volume`（ADR D6 的 `volumeId` 指语义，不另起字段），解析器与 catalog 都按此实现。
- **`id` 是 uuid 且稳定**：由建章工具 `randomUUID()` 生成并写入文件；工具寻址只认 id 或相对路径，**目录名不是 id**。改名（见下）与移卷都不换 id，因此 `resolvedChapter`、伏笔的 `resolvedChapter` 一类引用不断链。
- **改标题 = 文件名 + frontmatter + catalog 一起改**：`inkflow_chapter_write` 拿到新 `title` 时同步把文件名换成 `<原前缀>-<新 slug>.md`（id/volume/seq 不变），旧路径删除、新旧路径都在同一把写锁内处理，catalog 随之重建。
- **frontmatter 解析规则**（实现见 `src/host/frontmatter.ts`）：`#` 只有在引号外、且前面是行首或空白时才算注释；结束符必须是独立成行的 `---`（`----`、`--- x` 不算）；首块内不含任何 `key:` 行时判为「无 frontmatter」，正文优先——宁可丢元数据，也不吞正文。
- **写回规则**：只做**行级补丁**（只替换目标 key 所在行及其块列表项），未知字段、行内注释、键序、引号风格原样保留；原子写盘由调用方负责（临时文件 + rename）。写 `body` 时只替换 frontmatter 之后的字节，块本身逐字节保留。
- 字数由插件派生（非空白字符数），不写回文件——避免 AI 与插件互相改字数字段。
- 章号派生规则：`seq`（显式）> 文件名前导数字 > 文件名排序；**删章不重排**，允许空号。建章缺省取同卷（或散章集合）最大 `seq` + 1。
- 卷/章增删改的工具、级联与错误码见 §3.10。

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
keywords: [白鹤, 鹤鸣剑]  # 世界书触发词（注入尚未实现）
always: false           # 是否常驻注入
---
条目正文
```

- **根与扁平分类书**：`world/` 第一层、无 `parent` 的条目是「根」，若有根则**恰一条**；全部条目都放在 `world/<category>/` 且都不写 `parent` 的「扁平分类书」**允许没有根**（校验码见 [data-model](data-model.md) §5 I-08）。

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

任意文件（TXT/MD/PDF/图片）。插件只登记路径与大小，不解析内容（导入与提取归 M16，尚未实现）。

### 3.7 `.gitkeep` 与 `index/`

每个必需目录（九个内容目录 + `index/`）都带一个 0 字节的 `.gitkeep` 并**进 git**：git 不跟踪空目录，没有它，`git clone` 之后目录消失，门禁会把结构齐全的书判成缺目录。`.gitkeep` 不参与解析（解析器只认 `*.md`/`*.json`），也不被工具当作内容。

| 文件 | 进 git？ | 说明 |
|---|---|---|
| `<必建目录>/.gitkeep` | ✅ | 十份（九个内容目录 + `index/`），保证 clone 后目录仍在 |
| `chapters/index.json`、`chapters/<vol-dir>/index.json` | ✅ | 卷章 catalog：可审阅的结构投影（§3.8） |
| `index/inkflow.db` | ❌ | 派生 SQLite（含 `-wal`/`-shm`），可随时删除重建 |
| `index/.lock` | ❌ | 索引重建锁（单飞与陈旧判定用） |
| `index/.write.lock` | ❌ | 单项目写锁（§5.3） |
| `.openviking/config.local.json` | ❌ | 语义检索的 peer 私有层：入库会让协作者继承错误的 peer（[ADR-0007](../adrs/0007-plugin-shared-library.md) C7） |
| `.openviking/config.json` | ✅ | 团队层，可提交 |

`.gitignore` 的必需行（初始化 / 修复向导写入，已存在则只补缺失行）：

```gitignore
index/*.db
index/*.db-wal
index/*.db-shm
index/.lock
index/.write.lock
.openviking/config.local.json
```

**实现状态**：向导当前只写前三行（`REQUIRED_GITIGNORE_LINES`）；后三行随 §3.8 catalog、§9 共享库/OVK 一起补，归 #15 / #40 / #41。

### 3.8 卷章 catalog（`chapters/index.json`）

catalog 是**派生结构投影**（[ADR-0006](../adrs/0006-workspace-contract-v2.md) D6）：`.md`（文件名 + frontmatter）是真相，catalog 与真相不一致时以 `.md` 重建并覆盖。

| 文件 | 形状 | 内容 |
|---|---|---|
| `chapters/index.json` | `{ schemaVersion, volumes[], looseChapters[] }` | 卷列表 + 不属于任何卷的散章 |
| `chapters/<vol-dir>/index.json` | `{ schemaVersion, chapters[] }` | 该卷的章清单 |

- 卷项：`{ volumeId, dir, title, order }`；章项：`{ chapterId, file, seq, title }`。
- 卷项 `title` 优先取 `outlines/vol-NN*.md` 的 frontmatter `title`（无则首个 `# ` 标题），再退回目录 slug；`order` 取 `volumeId` 的数字部分。
- **不写派生量**（字数、状态统计、更新时间）：统计由索引派生，写进 catalog 只会让 AI 与插件互相改同一字段。
- `volumeId` 形如 `vol-NN`（两位起，超过 99 自然扩展），**稳定不复用**；卷目录名 `vol-NN-<slug>` 的 slug 可改。
- 编码 UTF-8 无 BOM、LF；写入走「临时文件 + rename」原子替换。
- **读写分工**：读路径不写盘（缺失/漂移时返回 `catalogStale: true` 并以 `.md` 为准）；写路径在写入时重建受影响的 catalog 并标 `catalogRebuilt: true`；另提供显式重建动作。
- **不是门禁必需项**：删掉 catalog 不改变四态判定（重建即可），避免「删一个投影文件 = 项目损坏」。
- 与 `index/` 的边界：catalog 入库、只含结构；`index/` 不入库、整库可删。

**实现状态**：读写/校验/重建已实现（`src/host/catalog.ts`）；卷归属以章 frontmatter 的 `volume`（存 volumeId）为准，目录名只作缺省推导。卷章增删改的工具与级联见 §3.10。

### 3.9 伏笔 `foreshadowing/<slug>.md`

```markdown
---
id: fs-01
title: 断剑
resolved: false          # 是否已回收
resolvedChapter: ch-0001 # resolved: true 时必填：回收所在章 id
---
伏笔正文（埋设位置、回收条件、读者提示强度，自由格式）
```

- `resolved: true` 而缺 `resolvedChapter` → 重建期校验报 `FORESHADOW_RESOLVED_WITHOUT_CHAPTER`，**不阻断索引**（data-model §5 I-09）。
- 章 id 取自章 frontmatter 的 `id`（缺省为章的相对路径），本文件不复制章标题或章号。
- 字段字典（`status` 状态机、`threads`、`characters`）见 [data-model.md §3.2](data-model.md)。

### 3.10 卷章 CRUD（工具、级联与错误码）

卷与章的增删改都走同一个写入口（§5）与同一把写锁：业务规则在 `src/host/chapters.ts`，`tools.ts` 只做门禁、参数收窄与渲染。

| 工具 | 作用 | 写什么 | 成功后的投影 |
|---|---|---|---|
| `inkflow_volume_create` | 建卷 | `chapters/vol-NN-<slug>/` + `.gitkeep` | 两份 catalog + 索引 |
| `inkflow_volume_rename` | 改卷名 | 目录改名（保留 `vol-NN` 前缀） | 两份 catalog + 索引；**章 frontmatter 不动** |
| `inkflow_chapter_create` | 建章 | `chapters/[<卷目录>/]NNNN-<slug>.md`（uuid `id`、`status: draft`、空正文） | 两份 catalog + 索引 |
| `inkflow_chapter_write` | 改标题 / 正文 / 状态 | 目标字段行级补丁；改标题同时改文件名 | 两份 catalog + 索引 |
| `inkflow_chapter_move` | 移卷 / 移出卷 | 移动文件 + 改/删 `volume` | 两份 catalog + 索引 |
| `inkflow_chapter_delete` | 删章 | 删除 `.md` | 两份 catalog + 索引 |

- **id 稳定**：`chapterId` 是建章时 `randomUUID()` 写入 frontmatter 的 uuid；工具寻址只认 id 或 `chapters/**/*.md` 相对路径，**目录名不是 id**（拿卷目录名当 id → `CHAPTER_NOT_FOUND`）。改标题、移卷都不换 id。
- **seq**：建章缺省取同卷（入卷）或散章集合的最大 `seq` + 1；显式 `seq` 必须是正整数，撞号 → `SEQ_CONFLICT`；**移卷跨卷撞号也拒**（catalog 的 `CATALOG_DUPLICATE` 前移到写入侧）。删章不重排。
- **slug**：目录名与文件名里的 slug 由 `title` 归一化得到（NFKC、空白与 Windows 非法字符 → `-`、最长 60 字符）；调用方显式给 `slug` 时按给的来，非法即 `SLUG_INVALID`（空串也算给了）。
- **失败回滚**：多文件级联不是文件系统级事务，所以每一步都可能失败，回滚 = **文件级撤销**（原文写回 / 新文件删除 / 目录改回）+ **catalog 文件按调用前快照逐字节还原**（失败的 rebuild 可能已经写了前几份 catalog），每一步记入 `error.rollback[]`。回滚本身失败 → `ROLLBACK_INCOMPLETE`（同样附步骤）；全部成功 → `CATALOG_REBUILD_FAILED`。
- **卷改名级联**：**投影读取 → 目录改名 → 两份 catalog 重建**全部在同一把项目写锁内（先读后写会让并发写者在旧快照上分配 `seq`/文件名）；派生索引在锁释放后重建（它是缓存，不进事务）。章文件随目录移动，**不改一个字节**。
- **删章可回溯靠 git**：工具物理删除 `.md`（插件不建回收站副本），失败时用内存里的原文原子写回。
- **索引是缓存**：索引重建失败只报 `indexError`，不回滚真相文件——回滚文件去救缓存是反的。
- **路径安全**：所有写入经 `io.ts`（`resolveWriteTarget` / `writeTextAtomic` / `removeProjectFile` / `renameProjectDirectory`），不直接 `fs.writeFileSync` 到项目文件；`chapters/` 以外的路径一律 `FILE_INVALID`。

| code | 含义 |
|---|---|
| `TITLE_REQUIRED` | 卷/章标题缺失，或卷改名既没给 `title` 也没给 `slug` |
| `VOLUME_ID_INVALID` | 不是 `vol-NN`（两位起）；`vol-7` 这类一位数会被拒 |
| `VOLUME_EXISTS` | 该 `volumeId` 已有卷，或目标目录已存在（改名不合并目录） |
| `VOLUME_NOT_FOUND` | 没有该卷 |
| `SLUG_INVALID` | slug 为空 / 含非法字符 / 以点或空格收尾 / 超长 |
| `SEQ_INVALID` | `seq` 不是正整数 |
| `SEQ_CONFLICT` | 同卷（或散章集合）内 `seq` 重复 |
| `CHAPTER_EXISTS` | 目标文件已存在 |
| `CHAPTER_NOT_FOUND` | id 或路径未命中任何章 |
| `CHAPTER_AMBIGUOUS` | 同一 id 命中多个章 |
| `CHAPTER_SELECTOR_REQUIRED` / `CHAPTER_SELECTOR_CONFLICT` | `chapterId` / `file` 二选一：都没给 / 都给了 |
| `FILE_INVALID` | 不是 `chapters/**/*.md` 相对路径 |
| `STATUS_INVALID` | 状态不在 `draft` / `revised` / `final` |
| `CATALOG_REBUILD_FAILED` | 变更后 catalog 写失败，已回滚 |
| `ROLLBACK_INCOMPLETE` | 回滚本身未完成（`error.rollback[]` 逐条列出） |

写层失败码（§5.4 的 `PATH_*` / `PROJECT_BUSY` / `IO_FAILED`）原样透出，便于模型区分「名字不合法」与「另一个会话在写」。

## 4. 索引（派生层）

- 引擎：`node:sqlite`（宿主 Node 24 内置，无原生依赖）。
- 索引 schema 版本存在 `PRAGMA user_version`；与代码期望不一致 → **删库重建**，不做 ALTER 迁移。
- 每次重建 = 清空 + 重扫 + 事务提交；文件名/结构变化由「重建」消化，因此**永远没有数据库迁移问题**。
- 索引内容（v1）：`meta`、`files`、`chapters`、`characters`、`world_entries`、`outline_nodes`、`library_files`、`validation_issues`、`chapters_fts`（FTS5 trigram）。
- 全文检索：trigram 命中 ≥3 字；1–2 字查询走 `LIKE` 兜底（ADR-0005）；契约见 §4.1。
- 校验器在重建后运行：duplicate id / 缺 `overall` / 卷中卷 / 角色名重复 / 悬空 `parent` / 非 `.md` 章文件 / frontmatter 不可解析 → 记入 `validation_issues` 并返回，**不阻断索引可用**（只读仍可用，写入类工具再拦）。
- 索引内容（v2，规划）：覆盖九个内容目录的全部实体（伏笔/时间线/关系/账本/资料卡）+ `entity_mentions` + 全实体 FTS + catalog 一致性校验。**未实现**，归 #23；v2 落地时 `INDEX_SCHEMA_VERSION` 递增并删库重建（不写 ALTER）。

### 4.1 章正文检索（`inkflow_chapter_search` / `searchChapters`）

| 项 | 契约 |
|---|---|
| 工具 | `inkflow_chapter_search`：`{ projectRoot?, query, limit? }`；`query` 必填，项目根与门禁规则同 §6 |
| 查询长度 | 以**折叠空白后的字符数**计：0 → `ok:true` + 空 `items`（`mode` 记为 `like`，未用 FTS）；1–2 → `LIKE`；≥3 → FTS5 `MATCH` |
| 分词 | 按空白切分为多个词；**任一**词短于 3 字 → 整条查询走 `LIKE`（`LIKE ... AND LIKE ...`，每个词都必须出现，不静默丢词）；全部词 ≥3 字 → FTS `AND` |
| 转义 | FTS：每个词包成双引号短语、内部 `"` 写成 `""`，故 `"` `*` `-` `OR` `NEAR(` 一律是字面文本；LIKE：`%` `_` `\` 加反斜杠并用 `ESCAPE '\'` |
| 返回 | `{ ok:true, items:[{ chapterId, file, title, seq?, snippet }], total, mode }`，`mode` 取 `'fts'` 或 `'like'`；`total` 是命中总数（不是页大小），`file` 是项目内相对路径 |
| 排序 | FTS 按 `rank`（bm25，升序）；`LIKE` 按 `seq` 升序、再按 `file`（`seq` 为空排最后） |
| 片段 | 命中词前后各 40 字（`snippet` 选项可改，0 = 不生成）；连续空白折叠为单个空格；截断端加 `…`；**只取正文**，frontmatter 不进片段（索引存的就是 `parsed.body`） |
| 上限 | `limit` 默认 20、上限 100；`query` 超过 200 字符 → `QUERY_INVALID` |
| 只读 | 检索函数**不建库、不修复、不删库**；索引缺失或 `PRAGMA user_version` 不符 → `INDEX_UNAVAILABLE`，项目零变更。懒重建只在工具层做一次（与 §4 的缓存观一致） |

**检索返回码**（与 §6 一样是结构化返回，不抛异常给模型）：

| code | 含义 | 模型下一步 |
|---|---|---|
| `INDEX_UNAVAILABLE` | 索引不存在、`user_version` 不符或无法读取；附 `message`，`hint` 指向重建 | 先 `inkflow_index_rebuild`（工具自身已自动重试过一次）；仍失败则把原因转述给用户 |
| `QUERY_INVALID` | `query` 缺失/空白、超过 200 字符，或（直接调用 `searchChapters` 时）不是字符串 | 换一个 1–200 字的查询；不要重试同一参数 |

## 5. 写入纪律

**单一写入口**：所有落盘都经过 `src/host/io.ts`（路径解析 + 原子替换 + 写锁「三件套」只实现一次）。业务代码不得自行拼接项目内路径，也不得直接调用 `fs.writeFileSync` 写项目文件。

### 5.1 路径解析（`resolveWriteTarget`）

| 规则 | 说明 | 失败码 |
|---|---|---|
| 只接受相对路径 | 相对项目根；绝对路径、盘符相对（`C:x`）、UNC（`\\server\share`）一律拒绝 | `PATH_INVALID` |
| 目录白名单 | 首段必须是九个内容目录之一（`chapters/`、`characters/`、`world/`、`outlines/`、`foreshadowing/`、`timeline/`、`relations/`、`facts/`、`library/`）或派生 `index/`（[ADR-0006](../adrs/0006-workspace-contract-v2.md) D1）；`inkflow.json`、`.git/` 等其余位置不可写 | `PATH_NOT_WRITABLE` |
| 段格式 | 空段、`.`、`..`、控制字符、`< > : " \| ? *`、以点或空格结尾的段一律拒绝（这些名字在 Windows 上会被静默改写） | `PATH_INVALID` |
| 保留设备名 | `CON PRN AUX NUL COM1–9 LPT1–9`（取第一个点前的主干，大小写不敏感） | `PATH_RESERVED` |
| 长度 | 绝对路径 > 240 字符或单段 > 255 字符（给 `.tmp-<pid>-<rand>` 后缀留空间，不依赖机器级长路径开关） | `PATH_TOO_LONG` |
| 链接逃逸 | 目标（含尚不存在的尾部）`realpath` 后必须仍在项目根子树内；junction / 符号链接逃出项目 | `PATH_OUT_OF_SCOPE` |
| 插件文件 | `index/.write.lock`、`index/.lock` 不可作为写目标（会把插件自己的锁写掉） | `PATH_NOT_WRITABLE` |

解析阶段只做 `stat` / `realpath` 读操作，**不建目录、不写文件**；父目录在真正写入时才创建。项目根不存在或不是目录 → `PROJECT_NOT_FOUND`。

### 5.2 原子替换与失败不变量

| 规则 | 说明 |
|---|---|
| 原子替换 | 先写同目录 `<file>.tmp-<pid>-<rand>`，`fsync` 后 `rename` 覆盖；禁止原地截断写入 |
| 失败不落半截 | 写失败时目标文件**字节不变**（sha256 不变）、临时文件删除、写锁释放；错误里带 `tempFile` 供诊断 |
| 崩溃残留可清扫 | 崩溃遗留的 `*.tmp-<pid>-<rand>`（持有者已死或超过 10 分钟）在下次持锁写入时清扫 |
| 编码在写入口规范化 | 写入前剥 BOM、`CRLF`/`CR` → LF（`.gitattributes` 固定 LF）；读取侧仍须容忍 BOM 与 CRLF |
| JSON | `JSON.stringify(value, null, 2)` + 单个结尾 LF；不可序列化（BigInt / 循环引用 / `undefined`）→ `IO_FAILED`，不写半截文件 |
| 不静默覆盖 | 改写既有正文必须走「提案 → 用户确认」（提案制归 M19，尚未实现）；`inkflow_chapter_write` 是显式的改写工具，调用方（模型）须先征得作者同意 |
| 删除可回溯 | `inkflow_chapter_delete` 物理删除 `.md`（插件不建回收站副本）：恢复手段是项目 git 历史；删除前把原文读进内存，catalog 写失败时原子写回 |
| 只追加审计 | 审计/事件写在 `index/`（派生）或 DSH 会话日志，不污染正文 |

### 5.3 单项目写锁

| 规则 | 说明 |
|---|---|
| 锁文件 | `index/.write.lock`（O_EXCL 创建，内容 `{pid, token, startedAt}`）。与索引重建的 `index/.lock` **分开**：重建锁把「本进程 pid」当陈旧（其单飞表已串行化进程内重建），复用它会让写路径误抢锁 |
| 语义 | 单项目单写者；拿不到锁**立即**返回 `PROJECT_BUSY`（不等待、不阻塞工具调用） |
| 陈旧自愈 | pid 已死 / `startedAt` 超过 10 分钟 / 不可解析且超过 10 秒写入宽限 / 本进程遗留（不在锁表里）→ 视为陈旧，删除后重试一次 |
| 释放校验 | 释放前比对 token，只删自己持有的锁；进程内可重入（嵌套写复用同一把锁，最外层释放才删文件） |
| 与重建的关系 | 两把锁保护两个资源（数据文件 / 可重建数据库）；写入是 rename，重建要么读到旧文件要么读到新文件，不需要互相等待 |

### 5.4 写失败返回码一览

| code | 含义 |
|---|---|
| `PATH_INVALID` | 路径形状非法（见 §5.1） |
| `PATH_OUT_OF_SCOPE` | realpath 后落在项目根之外 |
| `PATH_NOT_WRITABLE` | 目录不在白名单内，或目标是插件自己的锁文件 |
| `PATH_RESERVED` | Windows 保留设备名 |
| `PATH_TOO_LONG` | 超过长度上限 |
| `PATH_NOT_FOUND` | 移动/删除的源不存在，或类型不符（如目标是目录） |
| `TARGET_EXISTS` | 移动/改名的目标已存在（永不覆盖、永不合并目录） |
| `PROJECT_NOT_FOUND` | 项目根不存在或不是目录 |
| `PROJECT_BUSY` | 另一会话/进程持有写锁 |
| `IO_FAILED` | 文件系统拒绝（权限、占用、磁盘），附 `errno` |

**验证**：`node --test tests/io-writer.test.js`（实现与契约逐条对拍）。

## 6. 门禁与向导返回约定

非 `usable` 时的拒绝返回（结构化清单，不是异常）：

```json
{
  "ok": false,
  "error": {
    "code": "PROJECT_NEEDS_REPAIR",
    "state": "needs-repair",
    "needsSetup": false,
    "needsRepair": true,
    "readOnly": false,
    "root": "D:\\小说\\某目录",
    "checks": {
      "git": true,
      "dirs": { "chapters": true, "foreshadowing": false, "...": false },
      "keeps": { "chapters": true, "foreshadowing": false, "...": false },
      "meta": true
    },
    "missing": ["foreshadowing", "foreshadowing/.gitkeep"],
    "actions": [
      { "type": "create-dir", "path": "D:\\小说\\某目录\\foreshadowing", "reason": "missing required directory foreshadowing/" },
      { "type": "create-gitkeep", "path": "D:\\小说\\某目录\\foreshadowing\\.gitkeep", "reason": "every required directory carries .gitkeep so a clone keeps it" }
    ],
    "reasons": ["missing directory: foreshadowing/"],
    "hint": "…"
  }
}
```

`missing[]` 是**逐项**清单：`.git`、缺失的目录名、缺失的 `<dir>/.gitkeep`、`inkflow.json`（`needs-newer-plugin` 下 meta 不算缺失，见下）。`actions[].type` ∈ `git-init` / `create-dir` / `create-gitkeep` / `create-meta` / `create-gitignore` / `manual`；`manual` 表示该状态下本插件不能执行，只能由用户升级插件。

**返回码一览**（失败一律结构化返回，不抛异常给模型）：

| code | 含义 | 模型下一步 |
|---|---|---|
| `NOT_AN_INKFLOW_PROJECT` | 状态 `needs-setup`：这里什么都没有；附 `needsSetup: true` | 把 `missing` 转述给用户；用户同意后走 §6.3 的 plan → apply |
| `PROJECT_NEEDS_REPAIR` | 状态 `needs-repair`：书已存在但缺失/损坏；附 `needsRepair: true` | 同上，但只补缺失项，不覆盖既有文件 |
| `PROJECT_NEEDS_NEWER_PLUGIN` | 状态 `needs-newer-plugin`：meta 版本高于本插件；`readOnly: true`，`actions` 只有 `manual` | 让用户升级插件；**不得**修复、重写或重建索引 |
| `PATH_OUT_OF_SCOPE` | 显式路径不在**会话工作区子树**内 | 在会话工作目录内开项目，或先切会话工作目录 |
| `PATH_FORBIDDEN` | 盘符/卷根、家目录本身（或其祖先）、系统与安装目录（`Windows`、`Program Files`、`ProgramData`、宿主可执行目录） | 换工作区内的子目录 |
| `INIT_REQUIRES_CONFIRMATION` | apply 未带 `confirm: true` | 展示 `willCreate` / `actions`；用户同意后以 `confirm: true` 重调 |
| `META_TITLE_REQUIRED` | 需要写 `inkflow.json` 但没给 `title` | 问用户书名后重调（插件不编造标题） |
| `TARGET_NOT_DIRECTORY` | 目标路径存在且不是目录 | 换路径 |
| `GIT_INIT_FAILED` | `git init` 失败（回滚本次半成品） | 装/修好 git 后重试；或用户自己在目标目录 `git init` |
| `APPLY_FAILED` | 应用后仍未 usable（如目录无法创建） | 看 `message` 与 `missing` |
| `NO_SESSION_CONTEXT` | 面板 HTTP 请求无法得知所属会话工作区（见 §6.2） | 改用工具读；不要把面板结果当作项目真相 |

### 6.1 路径作用域（`projectRoot` / `root`）

- **信任锚点只有一个**：会话工作目录（`ctx.get('workingDirectory')`，缺失时降级 `process.cwd()`）。
- 显式路径先 `realpath`（不存在时对最近存在祖先 `realpath` 再拼回剩余段），再做子树判定；判定在**任何写盘之前**（`inspectProject` 的 `index/` 放宽会建目录，向导 apply 会建整棵树并 `git init`）。
- 因此"越界路径"不仅被拒，目标目录**零变更**（mtime/条目不变）。
- 拒绝盘符根与安装目录是硬规则：那里写入会破坏系统或宿主，且绝不可能是用户的书写目录。

### 6.2 面板通道（`/inkflow/internal/*`）

面板与 Host 之间的数据通道是**内部实现**，不是对外 API（[ADR-0008](../adrs/0008-panel-data-channel.md) D2）：不版本化、不提供 OpenAPI、不承诺兼容；`/inkflow/api/*` 一律 404，不留兼容别名。

**路由表**（P0 全部只读；方法在路由表里逐条声明，未声明的动词 → 405 + `Allow` 头）：

| 路由 | 方法 | 参数 | 成功值 `value` | 专属错误码 |
|---|---|---|---|---|
| `/inkflow/internal/status` | GET | `sessionId` | `root`、`label`、`state`、`checks`、`missing`、`actions`、`meta`、`index`（`dbExists`/`schemaMatches`/`builtAt`/`counts`）、`catalog`（`stale`/`volumes`/`chapters`）、`search` | `SESSION_ID_INVALID` |
| `/inkflow/internal/chapters` | GET | `sessionId` | `volumes[]`（`volumeId`/`dir`/`title`/`order`/`chapters[]`）+ `looseChapters[]` + `catalogStale`、`indexBuilt` | — |
| `/inkflow/internal/chapters/:id` | GET | `sessionId`、`:id`＝章节 `id` 或项目相对路径 | `frontmatter`、`body`、`bodyChars`、`hasFrontmatter`、`issues`、`volumeId` | `404 chapter-not-found`（含越出 `chapters/` 的路径） |
| `/inkflow/internal/search?q=` | GET | `sessionId`、`q` | `results[]`（章节元数据）、`searchUnavailable: true`、`searchScope: 'chapter-metadata'` | `400 QUERY_REQUIRED` |

**错误码**（信封 `{ok:true,value}` / `{ok:false,error:{code}}`；失败一律结构化，不抛栈）：

| HTTP | code | 触发条件 |
|---|---|---|
| 400 | `ROOT_PARAM_NOT_ALLOWED` | query 或 body 出现 `root`/`path`/`cwd`/`workspace`/`projectRoot`；附 `reason: 'unexpected-path-param'` 与 `param`/`in`；判定在路由匹配与任何文件 IO 之前 |
| 400 | `SESSION_ID_INVALID` | `sessionId` 形状非法（非 `[A-Za-z0-9._:@-]{1,200}`） |
| 400 | `QUERY_REQUIRED` / `invalid-body` / `invalid-path-encoding` | `/search` 缺 `q`；请求体不是 JSON 对象；`:id` 百分号编码损坏 |
| 403 | `forbidden-host` / `forbidden-origin` / `forbidden-remote` | `Host` 非 loopback；`Origin` 存在但非 loopback；socket 对端地址非 loopback |
| 404 | `not-found` / `chapter-not-found` | 未知路径（含全部 `/inkflow/api/*`）；章节 id 不存在或不在 `chapters/` 内 |
| 405 | `method-not-allowed` | 动词不在该路由声明的 `methods` 内（响带 `Allow`） |
| 413 | `payload-too-large` | 请求体 > 64 KiB（`MAX_INTERNAL_BODY_BYTES`） |
| 200 | `NO_SESSION_CONTEXT` | 缺 `sessionId`，或会话解析不到工作区：`ok:false` + `actions[]`，**零写盘** |
| 200 | `NOT_AN_INKFLOW_PROJECT` / `PROJECT_NEEDS_REPAIR` / `PROJECT_NEEDS_NEWER_PLUGIN` | 解析到目录但四态门禁非 `usable`：附 `state`/`checks`/`missing`/`actions`/`readOnly`，**零写盘** |

**会话来源**：Client 只传 `sessionId`（query `sessionId` 或 header `x-inkflow-session`）；Host 依次用 ①`workspaceRegistry.list()` 中 `sessionIds` 含该会话的 `Workspace.path` ②`workingDirectory.get(sessions.get(id))` ③`Session.header.cwd`；都失败 → `NO_SESSION_CONTEXT`。会话 id 的 `session-` 前缀两种写法都接受（宿主的 `workspace.json` 用 `session-<uuid>`，会话日志头用裸 `<uuid>`）。解析出的目录再 `findProjectRoot` 向上找书（与工具同一套语义）。

**加固**（继承 [ADR-0004](../adrs/0004-loopback-http.md)）：`Host` 必须 loopback；`Origin` 存在时必须 loopback；socket 对端地址非空时必须 loopback；不发 CORS 头；`Cache-Control: no-store` + `X-Content-Type-Options: nosniff`；请求体 ≤64 KiB 且必须是 JSON 对象。

**只读纪律**：通道不重建索引、不修复项目、不写 `state.json`。门禁以 `inspectProject(root, { recreateIndexDir: false })` 判定（关掉 `index/` 的自动放宽），卷章树走 `readCatalog` 的 `.md` 投影，索引只以 `readOnly` 打开，章节文件只读且必须落在 `chapters/` 内。

**写路由（本期没有）**：只允许 POST，必须 `Content-Type: application/json`（否则 415）且必须带 loopback `Origin`（否则 403）；写动作仍由用户确认后触发（[ADR-0006](../adrs/0006-workspace-contract-v2.md) D3），面板不做自动修复。写真相仍只走工具 → `io.ts`。

### 6.3 初始化 / 修复向导（plan → apply）

两段式，两个工具：

| 段 | 工具 | 写盘 | 内容 |
|---|---|---|---|
| plan | `inkflow_project_plan` | **无**（连 `index/` 放宽也不做） | `state`、`checks`、`missing`、`actions[]`、`notices[]`（用户需自己处理的事，如外层仓库的 ignore）、`metaRaw`（坏 meta 原文，超 4096 字符截断并标 `truncated`） |
| apply | `inkflow_project_init` | 需 `confirm: true` | 只执行当前 plan 列出的动作；返回 `created[]` / `updated[]` / `skipped[]` |

- apply 的动作集合 = 调用时重新推导的 plan，只增不改：已存在的目录/文件一律进 `skipped[]`，**不覆盖、不改写、不重排格式**。
- **幂等**：同一状态连续 apply 两次，第二次 `created[]` 为空，`skipped[]` 覆盖上一次创建的全部项。
- **坏 meta 是唯一例外**：`inkflow.json` 存在但不可解析/不可用时，plan 与 apply 的确认轮都返回 `metaRaw`；只有 `confirm: true` 才会重建它（重建需 `title`，否则 `META_TITLE_REQUIRED`）。
- `needs-newer-plugin` 下 apply 直接拒绝（`PROJECT_NEEDS_NEWER_PLUGIN`），零写入。

### 6.4 `git init` 边界

- 向导**可以**执行 `git init`，这是全插件唯一允许的 git 写操作。
- 一律**不做**：`git add`、`git commit`、`git remote add`/改远程、设置 `user.name`/`user.email`、改默认分支或任何 git 配置、`git submodule`。
- 已有 `.git` → plan 不含 `git-init`。
- **父级已有 git 仓库**（书目录本身还没有 `.git`）→ plan 仍含 `git-init`（一部小说 = 一个仓库），并附一条 `notice`：「请在外层仓库的 `.gitignore` 里忽略本书目录」；插件**不代改项目根以外的任何文件**。
- `git init` 失败 → 回滚本次创建的全部半成品（目录、`.gitkeep`、`inkflow.json`、`.git`），返回 `GIT_INIT_FAILED`。
- 不 commit 意味着"向导跑完 = 工作区干净但没有提交"，首次提交由用户审阅后进行。

## 7. 与旧 InkFlow 的关系

旧库（43 表 / 59 万字）不再是真相源；**迁移 = 生成上述文件树**。逐章、逐实体落盘后可直接 `git commit` 审阅，比跨 schema ETL 更容易核对（归 roadmap 的 M/W 波次）。

## 8. 已裁决事项（原 3 条待拍板）

| # | 原问题 | 裁决 |
|---|---|---|
| C1 | `index/` 缺失时自动重建（§1 的放宽）是否接受？ | **采纳**，成为 §1 的唯一放宽（[ADR-0006](../adrs/0006-workspace-contract-v2.md) D2） |
| C2 | 伏笔 / 时间线 / 知识关系 / 账本 的归属目录 | **被取代**：四个域各自独立成一级目录（[ADR-0006](../adrs/0006-workspace-contract-v2.md) D1） |
| C3 | 新书创建是否提供 `inkflow_project_init`？是否代跑 `git init`？ | **被取代**：向导可 `git init`，但不 commit / 不配 remote / 不设身份（[ADR-0006](../adrs/0006-workspace-contract-v2.md) D3/D4） |

## 9. 契约已定但尚未落地的部分

本节只登记**本文已写进契约、实现还没有**的条目；不要把它当成时间表（排期见 [roadmap.md](roadmap.md)）。

| 契约 | 现状 | 落地归属 |
|---|---|---|
| `.gitignore` 的 `index/.lock`、`index/.write.lock`、`.openviking/config.local.json` 三行 | 向导只写前三行 `index/*.db*` | #15 / #40 / #41 |
| `inkflow.json.projectId` | 向导不生成；字段可缺省 | #40 |
| 索引 v2（九目录全实体 + `entity_mentions` + 全实体 FTS） | 索引 v1 只覆盖章/角色/世界观/大纲/资料路径；章正文检索已可用（§4.1） | #23 |
| 面板编辑器与提案制修订 | 面板只有章节树与只读正文预览，写入仍走工具 | #45 |
| 搜索的正文全文检索 | `/search` 只匹配章节元数据，并标 `searchUnavailable: true` | #22 |
| 插件级共享库（`$DSH_HOME/inkflow/shared/`、复制快照、`origin`） | 未实现 | #40 |
| OVK 语义检索（peer 只读、按章重建、降级 FTS5） | 未实现；当前只有 FTS5 | #41 |
| 旧库 ETL（43 表 → 文件树） | 未实现 | #51 |
