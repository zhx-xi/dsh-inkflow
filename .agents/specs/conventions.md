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
| 3 | `needs-repair` | 未达 1/2，但书目录**有 `inkflow.json`（哪怕不可解析）或有 `.git`** | 拒绝 | 仅修复向导（只补缺失项，不覆盖） |
| 4 | `needs-setup` | 1/2/3 都不成立 | 拒绝 | 仅初始化向导（只建缺少项） |

三条判据展开：

| # | 判据 | 判定方式 |
|---|---|---|
| G1 | 是 git 仓库 | 根目录存在 `.git`（目录，或 worktree 的 `.git` 文件） |
| G2 | 十项目录齐全 | 九个内容目录 `chapters/ characters/ world/ outlines/ foreshadowing/ timeline/ relations/ facts/ library/` 与派生目录 `index/`，且**每项都带一个 0 字节 `.gitkeep`** |
| G3 | 根元信息可解析 | `inkflow.json` 存在、是 JSON 对象、`schemaVersion` 为整数（读取时容忍 UTF-8 BOM） |

- **缺 `.gitkeep` 等同于结构缺失**：git 不跟踪空目录，clone 后目录会消失，所以「目录在、`.gitkeep` 不在」进 `needs-repair`，由修复向导补一个空文件。除 `.gitkeep` 外，门禁**不**检查目录里有没有内容文件。
- **`needs-newer-plugin` 是终态**：唯一出路是升级插件；旧插件不得以任何「修复」名义改写 meta 或删除索引。
- **repair / setup 的判别信号**是「有 meta 或有 `.git`」，不是「有任一目录」——目录可能是用户手工先建的，也不说明书已经成立。
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
id: 6f1c2c1e-...        # 可选；缺省用相对路径生成稳定 id
title: 第一章 入山
volumeId: vol-01        # 可选；卷归属由 volumeId 决定（不靠目录名推导）
seq: 1                  # 可选；缺省取文件名前导数字
status: draft           # draft | revised | final
pov: 主角                # 可选
---

正文第一段……
```

- **正文就是 Markdown 正文**（frontmatter 之后），不加任何包装标记。
- **卷归属用 `volumeId`**（[ADR-0006](../adrs/0006-workspace-contract-v2.md) D6）：`vol-NN` 稳定标识，改卷目录的 slug 不改归属；卷目录名 `vol-NN-<slug>` 只用于定位文件。目录名不再参与归属推导。
- **frontmatter 解析规则**（实现见 `src/host/frontmatter.ts`）：`#` 只有在引号外、且前面是行首或空白时才算注释；结束符必须是独立成行的 `---`（`----`、`--- x` 不算）；首块内不含任何 `key:` 行时判为「无 frontmatter」，正文优先——宁可丢元数据，也不吞正文。
- **写回规则**：只做**行级补丁**（只替换目标 key 所在行及其块列表项），未知字段、行内注释、键序、引号风格原样保留；原子写盘由调用方负责（临时文件 + rename）。
- 字数由插件派生（非空白字符数），不写回文件——避免 AI 与插件互相改字数字段。
- 章号派生规则：`seq`（显式）> 文件名前导数字 > 文件名排序；**删章不重排**，允许空号。
- 【未实现】现行解析器（`KNOWN_FRONTMATTER`）用 `volume` 字段存 `volumeId`（字段名不变），catalog 已按此实现（#15）。

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
- **不写派生量**（字数、状态统计、更新时间）：统计由索引派生，写进 catalog 只会让 AI 与插件互相改同一字段。
- `volumeId` 形如 `vol-NN`（两位起，超过 99 自然扩展），**稳定不复用**；卷目录名 `vol-NN-<slug>` 的 slug 可改。
- 编码 UTF-8 无 BOM、LF；写入走「临时文件 + rename」原子替换。
- **读写分工**：读路径不写盘（缺失/漂移时返回 `catalogStale: true` 并以 `.md` 为准）；写路径在写入时重建受影响的 catalog 并标 `catalogRebuilt: true`；另提供显式重建动作。
- **不是门禁必需项**：删掉 catalog 不改变四态判定（重建即可），避免「删一个投影文件 = 项目损坏」。
- 与 `index/` 的边界：catalog 入库、只含结构；`index/` 不入库、整库可删。

**实现状态**：catalog 尚未落地（无读写、无校验、无重建），归 #15；卷归属仍按目录名推导（见 §3.2）。

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

## 4. 索引（派生层）

- 引擎：`node:sqlite`（宿主 Node 24 内置，无原生依赖）。
- 索引 schema 版本存在 `PRAGMA user_version`；与代码期望不一致 → **删库重建**，不做 ALTER 迁移。
- 每次重建 = 清空 + 重扫 + 事务提交；文件名/结构变化由「重建」消化，因此**永远没有数据库迁移问题**。
- 索引内容（v1）：`meta`、`files`、`chapters`、`characters`、`world_entries`、`outline_nodes`、`library_files`、`validation_issues`、`chapters_fts`（FTS5 trigram）。
- 全文检索：trigram 命中 ≥3 字；2 字查询走 `LIKE` 兜底（ADR-0005）。
- 校验器在重建后运行：duplicate id / 缺 `overall` / 卷中卷 / 角色名重复 / 悬空 `parent` / 非 `.md` 章文件 / frontmatter 不可解析 → 记入 `validation_issues` 并返回，**不阻断索引可用**（只读仍可用，写入类工具再拦）。
- 索引内容（v2，规划）：覆盖九个内容目录的全部实体（伏笔/时间线/关系/账本/资料卡）+ `entity_mentions` + 全实体 FTS + catalog 一致性校验。**未实现**，归 #22 / #23；v2 落地时 `INDEX_SCHEMA_VERSION` 递增并删库重建（不写 ALTER）。

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
| 不静默覆盖 | 改写既有正文必须走「提案 → 用户确认」（提案制归 M19，尚未实现）；当前无写正文工具 |
| 删除可回溯 | 删文件交给 git（`git rm` 后可 `git revert`）；插件不物理删正文 |
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

| 规则 | 说明 |
|---|---|
| 路径 | `/inkflow/internal/<域>`；信封 `{ok:true,value}` / `{ok:false,error:{code}}` |
| 方法 | **逐路由声明**：读路由只 GET；写路由只 POST，且必须 `Content-Type: application/json`（否则 415）、请求体必须是对象 |
| 会话来源 | Client 只传 `sessionId`；Host 依次用 ①`workspaceRegistry` 的 `sessionIds → Workspace.path` ②`workingDirectory.get(sessions.get(id))` 解析；都失败 → HTTP 200 + `ok:false` + `NO_SESSION_CONTEXT`，**零写盘** |
| 路径参数 | `root` / `path` / `cwd` 出现在 query 或 body → 400 `unexpected-path-param`，且不触达文件系统 |
| 加固 | 继承 [ADR-0004](../adrs/0004-loopback-http.md)：`Host` 必须 loopback；`Origin` 存在时必须 loopback（写路由强制要求存在）；无 CORS 头；`no-store` + `nosniff`；未知路径 404 |
| 与门禁一致 | 解析出的根仍过四态门禁；非 `usable` 返回同一份结构化清单，面板不自己兜底 |

**实现状态**：`/inkflow/internal/*` 尚未落地（归 #18），客户端入口仍是 `sidebar.panellist` + `main`（归 #17 改为 `conversation.view`）。当前构建的 `/inkflow/api/status`、`/inkflow/api/chapters` 一律返回 `200 + ok:false + NO_SESSION_CONTEXT`，且不读查询串、不读插件状态、不创建任何文件——这是过渡期的 fail-closed 占位，不在 ADR-0008 的目标契约内。

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
| 卷章 catalog（`chapters/index.json`）与 `volumeId` | 无读写/校验/重建；卷归属仍按目录名推导 | #15 |
| `.gitignore` 的 `index/.lock`、`index/.write.lock`、`.openviking/config.local.json` 三行 | 向导只写前三行 `index/*.db*` | #15 / #40 / #41 |
| `inkflow.json.projectId` | 向导不生成；字段可缺省 | #40 |
| 索引 v2（九目录全实体 + `entity_mentions` + 全实体 FTS） | 索引 v1 只覆盖章/角色/世界观/大纲/资料路径 | #22 / #23 |
| 面板入口 `conversation.view` | Client 仍注册 `sidebar.panellist` + `main` | #17 |
| `/inkflow/internal/*` 私有通道与 `sessionId` 解析 | 只有 `/inkflow/api/*` 的 fail-closed 占位 | #18 |
| 插件级共享库（`$DSH_HOME/inkflow/shared/`、复制快照、`origin`） | 未实现 | #40 |
| OVK 语义检索（peer 只读、按章重建、降级 FTS5） | 未实现；当前只有 FTS5 | #41 |
| 旧库 ETL（43 表 → 文件树） | 未实现 | #51 |
