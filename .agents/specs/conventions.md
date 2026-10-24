# InkFlow 项目目录约定（约定大于配置）

> **依据**：[ADR-0005](../adrs/0005-files-first-with-derived-index.md)（文件真相 + 派生索引）、[ADR-0006](../adrs/0006-workspace-contract-v2.md)（九目录 / 四态门禁 / catalog / 向导）、[ADR-0007](../adrs/0007-plugin-shared-library.md)（共享库字段与 `.gitignore`）、[ADR-0008](../adrs/0008-panel-data-channel.md)（面板通道）。
> **依赖**：[data-model.md](data-model.md)（字段字典与不变量）、[architecture.md](architecture.md)（模块边界）。
> **相关 ADR**：0004（loopback 加固，继承）、0006（目录与门禁，修改 0005 条款）、0007、0008。
> **references/**：本文件受 800 行上限约束（S6），超出部分下沉到这个目录：[references/impact-and-rename.md](references/impact-and-rename.md)（§5.6 细则）、[references/trash-semantics.md](references/trash-semantics.md)（§3.11.1 细则）。
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

另有一个**点开头的插件私有状态目录**，它不是内容目录、也不是派生物，见 §3.11：

```
<book-root>/.inkflow/            ← 插件私有状态（不进 git、不进索引、不参与门禁）
├── trash/                       ← 回收站（删除的可恢复副本，#35）
├── backup/                      ← 迁移/修复前的回滚包（#36）
└── audit/                       ← 体检报告导出（派生物，可随时重算，#33）
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

#### 3.1.1 写入后回读校验与编码可疑（issue #89）

写出去 ≠ 读回来是同一份。`inkflow_project_init` 在 apply 结束后**重新读一次** `inkflow.json`，把 `title` 与本次请求的 `title` 比较（**正规化**：`trim` + 连续空白折叠 + NFC），结果作为**两个非致命字段**返回，调用本身仍是 `ok: true`：

| 字段 | 取值 | 语义 |
|---|---|---|
| `metaVerified` | `true` / `false` / **缺省** | 请求带 `title` 时给出比较结果；未带 `title` 时缺省——没有可比的东西，就不声称校验过 |
| `warnings[]` | `{ code, message, hint, requested?, onDisk?, title?, hits? }` | 只读提示，供模型原样转述；不改判定、不阻断后续操作 |

| 告警码 | 触发条件 | 附带证据 | 回滚 / 改写文件 |
|---|---|---|---|
| `META_READBACK_MISMATCH` | 请求的 `title` 与磁盘上的 `title`（正规化后）不一致 | `requested` / `onDisk`（各截断 120 字符） | **否**：向导只替换「不可用」的 meta，可用的文件原样保留 |
| `META_ENCODING_SUSPECT` | 磁盘上的 `title` 命中 GBK 乱码判据（`src/host/encoding.ts`） | `title` 与 `hits[]`（命中的误读字节类，如 `lead-e4`） | **否** |

- 正规化只抹平**格式**差异（首尾空白、连续空白、全角空格 `U+3000`、Unicode 组合形式）；可打印内容不同就是真差异，不能靠「看起来差不多」放过。
- **手写文件必须 UTF-8（无 BOM）**：PowerShell 5 的 `Set-Content` / `echo` 默认 ANSI（中文 Windows 上是 GBK），会把 `人在蜀山，我是掌门` 写成 `浜哄湪铚€灞憋紝鏄帉闂?`。插件不阻止别人用错编码写文件，但会在回读与只读投影里明确报告，而不是把乱码当书名用。
- 乱码判据要**两个条件同时成立**：≥2 个**不同**误读字节类，且命中字符占非 ASCII 字符 **≥30%**。只看「非 ASCII 占比」会把每个中文书名都判可疑；只看单个特征字符会把「涓流」「河浜」这类正常书名误报——**宁漏不误报**（误报会骚扰所有正常书名）。
- `titleSuspicious` 只出现在**只读**投影里（`GET /inkflow/internal/status` 的 `value`、`inkflow_project_status` 的返回、面板标题旁的标记），**不参与四态判定**：书名乱码的书仍然是 `usable`，照常可读可写。

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

约束（由索引重建时的校验器检查，而非 DB 外键）：每项目恰 1 条 `overall`；`volume` 的 `parent` 必须是 `overall`；`chapter` 可挂 `overall`/`volume`，**禁止卷中卷、禁止章挂章**（三层为上限，code 见 data-model §5 的 I-02）。

**情节点语法**（正文解析，不进 frontmatter）：

- 顶层列表项（`- ` / `* ` / `+ `，缩进 0–3 空格）是一个情节点；
- 紧跟其后的更深缩进行并入上一条（不产生新情节点）；
- 围栏代码块（三个反引号或三个波浪号）内的列表项**不算**情节点；
- 空行或标题行结束当前列表；
- 可选前缀标签 `- [主线] 少年入山` 表示该情节点所属故事线；无标签时按 `conventions` 的普通情节点处理。

**故事线（arc）的落点**：`outlines/arcs/<slug>.md` 尚未实现；在那之前，前缀标签是唯一表示，索引里存成 `outline_nodes.plot_points`（JSON `[{text, arc?}]`）。等 `arcs/` 落地时两者需要合并，届时以本节为准改写。

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
.inkflow/
```

**实现状态**：向导当前只写 `REQUIRED_GITIGNORE_LINES`（`index/*.db*` 三行）；其余三行随 §3.8 catalog、§9 共享库/OVK 一起补，归 #15 / #40 / #41。最后一行 `.inkflow/` **不在**门禁必需行里：它由首次写入私有状态目录的代码追加（§3.11），因为那目录是可选的。

### 3.11 插件私有状态目录 `.inkflow/`（[ADR-0012](../adrs/0012-plugin-private-state-dir.md)）

回收站、迁移备份、审计报告三样都既不是正文也不是索引，因此单独一个点开头的目录。**它不是内容目录**：

| 事实 | 后果 |
|---|---|
| 不在 `CONTENT_DIRS` / `REQUIRED_DIRS` 里 | 门禁对它的存在与否**不表态**（存在即允许，缺失不修）；它不产 `entities` 行、不进索引扫描、不参与 catalog |
| 不进 git（`.gitignore` 加 `.inkflow/`，由**首次使用方** append-only 追加，不在门禁必需行里） | 已删除的正文不会以「新文件」身份重新出现在 `git status` 里；从不删东西的书也不会被永久提示 |
| 只经白名单写 | `resolveWriteTarget` 额外允许 `.inkflow/trash/`、`.inkflow/backup/`、`.inkflow/audit/` 三条**子路径**；`.inkflow/` 下其它子路径、`..`、绝对路径、符号链接逃出项目根仍拒 |
| 点开头即被 `walk()` 跳过（`src/host/indexer.ts:99`） | 新鲜度对拍与索引扫描天然看不到它，不需要额外排除规则 |
| 与 `index/` 生命周期无关 | 删掉 `index/` 重建索引，不影响回收站（这正是它不放在 `index/` 下的原因：`index/` 缺失会被静默重建，ADR-0006 D2） |

| 子目录 | 内容 | 谁写 | 清理策略 |
|---|---|---|---|
| `trash/` | 每个被删文件一份**副本**，路径为 `.inkflow/trash/<原相对路径>`（看一眼就知道从哪来）；外加清单 `.inkflow/trash/index.json`（形状见 §3.11.1） | #35 | **永不自动清理**（ADR-0012 #4）：条目只因「恢复」或「彻底删除」离开。超过 500 条或 50 MB【推断】只在面板提示可以清理【未实现：面板当前没有这条提示】，清空是显式动作且需二次确认 |
| `backup/` | 批量变更（6→9 目录迁移、frontmatter 修复）前的快照包，机器读 | #36 | 保留最近 3 次【推断】；更早的随新包建立时淘汰 |
| `audit/` | 体检报告导出（Markdown），纯派生物 | #33 | 可随时删除或覆盖，删了只丢报告不丢真相 |

细分契约（清单格式、保留阈值、迁移包结构）由 #35 / #36 各自在自己的 spec 段落里定；本节只定「它们住在哪、谁不许碰」。

#### 3.11.1 回收站语义（#35）

副本落点、清单形状、恢复的冲突规则、彻底删除的二次确认、同路径二次删除的拒绝、以及「清单读不出来时列表 500 且所有删除被拒」见 [references/trash-semantics.md](references/trash-semantics.md)。

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
status: planted           # planted / advanced / resolved / overdue（状态机见 data-model §3.2.1）
resolved: false          # 读兼容字段：是否已回收（与 status 矛盾即报 I-21）
resolvedChapter: ch-0001 # resolved: true 时必填：回收所在章 id
dueBy: vol-02            # 期望回收的章 id 或卷 id；超期判定只看它（§3.2.2）
---
伏笔正文（埋设位置、回收条件、读者提示强度，自由格式）
```

- `resolved: true` 而缺 `resolvedChapter` → 重建期校验报 `FORESHADOW_RESOLVED_WITHOUT_CHAPTER`，**不阻断索引**（data-model §5 I-09）。
- 章 id 取自章 frontmatter 的 `id`（缺省为章的相对路径），本文件不复制章标题或章号。
- 字段字典（`status` / `plantedAt` / `advancedAt` / `resolved` / `resolvedChapter` / `dueBy` / `linkedEntities` / `notes`，以及 `status` 状态机与超期口径）见 [data-model.md §3.2](data-model.md)。**字段名照那份写**：data-model 里不存在的键（如 `threads` / `characters`）会被解析器静默忽略，写了不报错也不生效。

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

### 4.0 新鲜度判定与唯一重建触发点

索引是缓存，缓存必须自证「还跟得上文件」。**判定**与**动作**分成两层，读路径只允许经过这两层：

| 层 | 实现 | 语义 |
|---|---|---|
| 判定（纯读） | `checkIndexFreshness(root)` → `{ state, reasons[], changes, checkedFiles, ms }` | 只判定，**不建库、不删库、不写锁、不写盘**。可用于每次读请求与断言「项目零变更」的测试 |
| 动作（唯一） | `ensureIndex(root, { rebuild? })` → `{ ok, state, rebuilt, freshness, build?, failure? }` | `fresh` → 直接返回；`stale` / `missing` / `incompatible` → 调一次 `buildIndex`（#4 的锁 / 单飞 / 原子替换）；失败返回结构化 `failure`，**不抛栈** |

**四态判据**（按序命中即停）：

| 状态 | 条件 |
|---|---|
| `missing` | `index/inkflow.db` 不存在 |
| `incompatible` | `PRAGMA user_version ≠ INDEX_SCHEMA_VERSION`，或数据库打不开 / 没有可读的 `files` 表 → 交给调用方决定重建，**判定阶段不删库** |
| `stale` | `files` 表逐行 `(path, size, mtime)` 与磁盘对拍出现差异：新增文件、删除文件、`size` 变、`mtime` 变 |
| `fresh` | 上述皆否 |

- **对拍口径**：一次 `readdir`+`stat` 遍历（`walkProjectFiles`，与建索引同一个遍历，跳过 `index/`、`node_modules`、`.git`、点文件，深度 ≤ 8），**不读文件内容、不做全量 hash**。500 章 / ~3000 文件的判定实测 30–35 ms（预算 < 50 ms，见 `tests/index-freshness.test.js` 的性能用例）。
- **为什么不用 `meta.builtAt` 对 `max(mtime)`**：删文件不会抬高任何 mtime；一删一增的「数量不变替换」也骗得过时间戳。因此 `builtAt` 只作诊断信息，**判定只认逐行对拍**。
- `reasons` 最多列 `FRESHNESS_REASON_LIMIT`（5）条并附「… and N more」，`changes` 是未截断的真实差异数。

**触发点唯一**：`inkflow_chapter_list`、`inkflow_chapter_search`、`GET /inkflow/internal/chapters`、`GET /inkflow/internal/search`、**`GET /inkflow/internal/library`、`/library/item`、`/library/issues`**（设定库读路由，消费 `entities` 与 `validation_issues`——不先刷索引，树会把「索引缺失」显示成「书里没有」）全部只调 `ensureIndex`，各自不再持有 `if (stale) build` 判断——所以「列表已新、搜索还旧」在结构上不可能发生。`inkflow_index_rebuild` 是**显式修复**（人/模型主动要求），`chapters.ts` 写路径成功后的重建是**写后失效**（文件刚变——设定库的 `POST /inkflow/internal/library/item` 同理，写成功后调 `ensureIndex(root, { rebuild: true })`），两者都不是「读时判定」，不构成第二个判定点。

**降级**：面板两条读路由在 `ensureIndex` 失败时仍返回数据（旧索引或 catalog 投影），并把 `indexState` / `indexError{code,errno,message}` / `indexReasons[]` 一并返回；工具侧则返回结构化失败（`INDEX_BUILD_FAILED` / `INDEX_BUSY`）。

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
| 只读 | 检索函数**不建库、不修复、不删库**；索引缺失或 `PRAGMA user_version` 不符 → `INDEX_UNAVAILABLE`，项目零变更。重建只由工具层的 `ensureIndex`（§4.0）决定并执行一次 |

**检索返回码**（与 §6 一样是结构化返回，不抛异常给模型）：

| code | 含义 | 模型下一步 |
|---|---|---|
| `INDEX_UNAVAILABLE` | 索引不存在、`user_version` 不符或无法读取；附 `message`，`hint` 指向重建 | 工具层的 `ensureIndex` 已先试过一次重建（§4.0）；仍失败则把原因转述给用户 |
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
| `FILE_CHANGED` | 调用方给的期望基线（`size` / `mtimeMs` / `sha256`）与磁盘不符；写路径见 §5.5，**零写入** |

**验证**：`node --test tests/io-writer.test.js`（实现与契约逐条对拍）。

### 5.5 写入 CAS（期望基线，`FILE_CHANGED`）

文件是真相，意味着**用户可以在插件之外改文件**——包括在「模型读过一章」与「工具写这一章」之间。所以写操作可以带上它期望的基线，不符就拒绝：

| 项 | 契约 |
|---|---|
| 参数 | `inkflow_chapter_write` / `_move` / `_delete` / `inkflow_project_init` 的 `expected`：`{ sha256?, size?, mtimeMs?, absent? }`，全部可选；**给了哪个字段就校验哪个** |
| 语义 | `sha256` 是内容身份；`size` 是廉价佐证；`mtimeMs` 只在**只给时间戳**时生效（另两字段在时以内容为准，避免不同文件系统的精度差异误报）；`absent: true` = 「此刻还不该存在」（初始化用） |
| 校验时机 | 两处：①调用方基线 vs 本次读到的字节（sha256 取自**将被替换的那份 buffer**，不是二次读）；②本次调用自己取的基线，在真正 `writeTextAtomic` / `removeProjectFile` 前再复核一次（抓「编辑器的保存不拿插件的写锁」这种情况）。两次都在项目写锁内、都在**第一个字节落盘前** |
| 失败返回 | `{ ok:false, error:{ code:'FILE_CHANGED', path, expected, current, changed[], nothingWritten:true, hint } }`；`current` 为 `null` 表示文件已消失 |
| 零写入 | 拒绝路径不改文件、不重建 catalog、不重建索引（项目树字节不变；写锁文件的建立/释放会移动 `index/` 目录 mtime，属既有行为） |
| 初始化 | `inkflow_project_plan` 回传 `metaFingerprint`（`null` = 还没有 `inkflow.json`）；`apply` 用 `{ absent: true }` 或该指纹作 `expected`。`git init` 之后、覆盖 `inkflow.json` 之前还会再复核一次基线，两个会话同时初始化时后者收到 `FILE_CHANGED` 而不是悄悄覆盖前者 |
| 写成功回传 | `inkflow_chapter_write` / `_move` 的返回里带 `fingerprint`（新文件的 `size`/`mtimeMs`/`sha256`），下一次 CAS 可直接用它 |

**验证**：`node --test tests/file-cas.test.js`（外部改动被拒且目标文件不变、基线正确时正常写入、初始化的两会话竞争）。

### 5.6 改名与影响面

改设定前先看影响面，改名**只写一次**（[ADR-0014](../adrs/0014-entity-id-pinning.md)，roadmap X-15）。完整契约（影响清单的五处来源、改名的文件效应、预览与拒绝同一套码、取消零写入）见 [references/impact-and-rename.md](references/impact-and-rename.md)。

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
- **无会话场景的锚点**（root 作用域书库，[ADR-0010](../adrs/0010-book-hub-entry.md) D6）：书库没有会话，锚点改为 ①**已注册工作区注册表**（`workspaceRegistry.list()`，路径已 `realpath` 规范化）②一次性 `planToken`（写动作，绑定 canonical 路径与动作集合）③**绝对拒绝集**（盘符/卷根、家目录本身与其祖先、系统与安装目录，判定在路由匹配与任何 IO 之前）。请求里出现 `root`/`path`/`cwd`/`workspace`/`projectRoot` 仍是 400（§6.2 的同一个 `ROOT_PARAM_NOT_ALLOWED`），因此书库读路由**不接受任何调用方路径**：书单只能来自注册表。

### 6.2 面板通道（`/inkflow/internal/*`）

面板与 Host 之间的数据通道是**内部实现**，不是对外 API（[ADR-0008](../adrs/0008-panel-data-channel.md) D2）：不版本化、不提供 OpenAPI、不承诺兼容；`/inkflow/api/*` 一律 404，不留兼容别名。

**路由表**（方法在路由表里逐条声明，未声明的动词 → 405 + `Allow` 头；读路由只有 GET，写路由是 POST/DELETE 并额外过写守卫，见下文「写路由」）：

| 路由 | 方法 | 参数 | 成功值 `value` | 专属错误码 |
|---|---|---|---|---|
| `/inkflow/internal/status` | GET | `sessionId` | `root`、`label`、`state`、`checks`、`missing`、`actions`、`meta`、`index`（`dbExists`/`schemaMatches`/`builtAt`/`counts`）、`catalog`（`stale`/`volumes`/`chapters`）、`search` | `SESSION_ID_INVALID` |
| `/inkflow/internal/chapters` | GET | `sessionId` | `volumes[]`（`volumeId`/`dir`/`title`/`order`/`chapters[]`）+ `looseChapters[]` + `catalogStale`、`indexBuilt`、`indexRebuilt`、`indexState`（`indexError`/`indexReasons` 仅在重建失败时出现） | — |
| `/inkflow/internal/library` | GET | `sessionId` | `kinds[]`（八类，`CONTENT_DIRS` 去 `chapters`，X-7）每类含 `count`/`truncated`/`groups[]`（`world` 按 category 分组，未分类排最后）；`indexState` | `SESSION_ID_INVALID` |
| `/inkflow/internal/library/item` | GET | `sessionId`、`kind`、`id` | 实体投影行 + 该文件的 `frontmatter` / `body` / `bodyChars` / `issues` / `fingerprint`（写路由的 `expected` 基线）；`KIND_REQUIRED`/`KIND_INVALID`(附 `allowed[]`)/`ID_REQUIRED`；索引不可用时 200 + `INDEX_UNAVAILABLE` | `400 KIND_REQUIRED`、`400 KIND_INVALID`、`400 ID_REQUIRED`、`404 library-item-not-found` |
| `/inkflow/internal/library/issues` | GET | `sessionId` | `issues[]`（`code`/`path`/`detail`）+ `counts`（按 code）+ `truncated` | `SESSION_ID_INVALID` |
| `/inkflow/internal/library/item` | POST | `sessionId`；`kind`、`id`（实体地址，**不是路径**）、`frontmatter`（键→string/number/boolean/数组；`null` 或 `[]` 删除该键）、`body`（整体替换正文）、`expected`（**必填**基线） | 写后的 `path`/`frontmatter`/`body`/`bodyChars`、`replaced`、`changed[]`（`replacedKeys`/`appendedKeys`/`removedKeys`）、新 `fingerprint`、`indexRebuilt`/`indexState`（失败时 `indexError`/`indexReasons`） | `400 KIND_REQUIRED`/`KIND_INVALID`/`ID_REQUIRED`/`PATH_OUT_OF_SCOPE`/`BODY_INVALID`/`EXPECTED_REQUIRED`/`EXPECTED_INVALID`/`FRONTMATTER_INVALID`/`FRONTMATTER_VALUE_INVALID`/`EMPTY_UPDATE`、`404 library-item-not-found`、`409 FILE_CHANGED`、`200 + indexError`（索引不可用不阻止写） |
| `/inkflow/internal/impact` | GET | `sessionId`、`kind`；`id` 或 `title`（二选一），可选 `slug` / `newTitle` 出改名预览 | 影响清单（§5.6）：`chapters[]`（`chapterId`/`title`/`seq`/`path`/`mentions`）、`relations[]`、`events[]`、`facts[]`、`foreshadowing[]`、`totals`、`fingerprint`、`indexAvailable`/`indexState`、`rename`（预览计划：`from`/`to`/`slug`/`title`/`pinId`/`targetExists`/`blockers[]`）；只读、零写盘 | `400 KIND_REQUIRED`/`KIND_INVALID`/`SELECTOR_REQUIRED`/`TITLE_AMBIGUOUS`（附 `candidates[]`）、`404 impact-entity-not-found` |
| `/inkflow/internal/impact/rename` | POST | `sessionId`；`kind`、`id`（实体地址）、`slug`/`title`（至少一个改动）、`expected`（**必填**基线） | 改名结果（§5.6）：`path`（新）/`previousPath`/`id`（不变）/`title`、`pinnedId`（**该条目现在是否已钉住**：真的移动过，或文件原本就带 `id`；只改显示名且原本没有 `id:` 时为 `false`）、`changed[]`（`file`/`id`/`title` 中实际写了的那些）、新 `fingerprint`、`entities` 前后行（`id` 同、`path` 变）、`mentions` 前后条数、`indexRebuilt`/`indexState` | `400 KIND_REQUIRED`/`KIND_INVALID`/`ID_REQUIRED`/`SLUG_INVALID`/`TITLE_INVALID`/`RENAME_NO_CHANGE`/`KIND_NOT_RENAMEABLE`/`EXPECTED_REQUIRED`/`EXPECTED_INVALID`、io 层兜底 `400 PATH_INVALID`/`PATH_TOO_LONG`/`PATH_RESERVED`、`404 impact-entity-not-found`、`409 TARGET_EXISTS`/`FILE_CHANGED`/`PROJECT_BUSY`、`500 IO_FAILED`（附 `rolledBack`） |
| `/inkflow/internal/chapters/:id` | GET | `sessionId`、`:id`＝章节 `id` 或项目相对路径 | `frontmatter`、`status`、`body`、`bodyChars`、`hasFrontmatter`、`issues`、`volumeId`、`fingerprint`（`size`/`mtimeMs`/`sha256`，写路由的 `expected` 基线） | `404 chapter-not-found`（含越出 `chapters/` 的路径） |
| `/inkflow/internal/search?q=` | GET | `sessionId`、`q` | `results[]`（章节元数据）、`searchUnavailable: true`、`searchScope: 'chapter-metadata'`、`indexRebuilt`、`indexState`（+ 失败时的 `indexError`/`indexReasons`） | `400 QUERY_REQUIRED` |
| `/inkflow/internal/chapters` | POST | `sessionId`；`title`（必填）、`volumeId`（`vol-NN` 或 `null`＝散章）、`slug`、`seq` | 新建章 `chapter`（`chapterId`/`file`/`title`/`seq`/`volumeId`/`status`）+ `fingerprint` + `catalogRebuilt`/`indexRebuilt` | `400 TITLE_REQUIRED`/`SEQ_INVALID`/`VOLUME_ID_INVALID`、`404 VOLUME_NOT_FOUND`、`409 CHAPTER_EXISTS`/`SEQ_CONFLICT` |
| `/inkflow/internal/chapters/:id` | POST | `sessionId`；`title`/`body`/`status`（三者至少一个）、`expected`（§5.5 基线） | 改后的 `chapter` + `changed[]`（+ 改标题时的 `renamedFrom`）+ `fingerprint` + `catalogRebuilt`/`indexRebuilt` | `400 TITLE_REQUIRED`/`STATUS_INVALID`、`404 chapter-not-found`、`409 FILE_CHANGED`/`CHAPTER_EXISTS` |
| `/inkflow/internal/chapters/:id/move` | POST | `sessionId`；`volumeId`（必填，`vol-NN` 或 `null`＝移出卷）、`expected` | `chapter` + `moved`/`movedFrom`/`changed[]` + `fingerprint` + 双投影状态 | `404 chapter-not-found`/`VOLUME_NOT_FOUND`、`409 FILE_CHANGED`/`TARGET_EXISTS` |
| `/inkflow/internal/chapters/:id` | DELETE | `sessionId`；`expected` | `deleted`（`chapterId`/`file`/`title`/`seq`/`volumeId`）+ `catalogRebuilt`/`indexRebuilt` | `404 chapter-not-found`、`409 FILE_CHANGED` |

**错误码**（信封 `{ok:true,value}` / `{ok:false,error:{code}}`；失败一律结构化，不抛栈）：

| HTTP | code | 触发条件 |
|---|---|---|
| 400 | `ROOT_PARAM_NOT_ALLOWED` | query 或 body 出现 `root`/`path`/`cwd`/`workspace`/`projectRoot`；附 `reason: 'unexpected-path-param'` 与 `param`/`in`；判定在路由匹配与任何文件 IO 之前 |
| 400 | `SESSION_ID_INVALID` | `sessionId` 形状非法（非 `[A-Za-z0-9._:@-]{1,200}`） |
| 400 | `QUERY_REQUIRED` / `invalid-body` / `invalid-path-encoding` | `/search` 缺 `q`；请求体不是 JSON 对象；`:id` 百分号编码损坏 |
| 400 | `KIND_REQUIRED` / `KIND_INVALID` / `ID_REQUIRED` | 设定库路由缺类别（附 `allowed[]`）或缺实体 id；`kind`/`id` 是**实体地址**，不是路径 |
| 400 | `PATH_OUT_OF_SCOPE` | 设定库写路由的 id 试图逃出该 kind 的内容目录（绝对路径、`..` 段、realpath 落在 `kind/` 之外）；判定在任何写之前 |
| 400 | `BODY_INVALID` / `EXPECTED_REQUIRED` / `EXPECTED_INVALID` | 设定库写路由：`body` 不是字符串或含无法编码为 UTF-8 的代理对；缺基线（`expected` 必填，空对象也算缺）；基线形状不合法 |
| 400 | `FRONTMATTER_INVALID` / `FRONTMATTER_VALUE_INVALID` / `EMPTY_UPDATE` | 设定库写路由：`frontmatter` 不是对象或键名非法；值是无法写进 frontmatter 的嵌套结构/多行文本；`frontmatter` 与 `body` 都没给 |
| 400 | `invalid-field` / `EXPECTED_INVALID` / `UNEXPECTED_BODY_FIELD` | 写路由：声明字段的类型不符（附 `field`）、`expected` 不是对象、body 出现路由未声明的字段（写路由只接受 `sessionId` + 该路由声明的字段） |
| 403 | `forbidden-host` / `forbidden-origin` / `forbidden-remote` | `Host` 非 loopback；`Origin` 存在但非 loopback；socket 对端地址非 loopback |
| 403 | `forbidden-origin`（`reason: 'cross-site-fetch'`） | **写路由**缺 `Origin` 且 `Sec-Fetch-Site` 声明为跨站：缺 `Origin` 本身不再拒绝（浏览器 POST 必带 `Origin`，缺省说明调用方不是网页；见 note） |
| 404 | `not-found` / `chapter-not-found` | 未知路径（含全部 `/inkflow/api/*`）；章节 id 不存在或不在 `chapters/` 内 |
| 405 | `method-not-allowed` | 动词不在该路由声明的 `methods` 内（响带 `Allow`） |
| 409 | `FILE_CHANGED` | **写路由**的 `expected` 与磁盘不符（§5.5）：附 `expected`/`current`/`changed[]`，**零写入**、缓存不重建 |
| 409 | `CHAPTER_EXISTS` / `CHAPTER_AMBIGUOUS` / `SEQ_CONFLICT` / `TARGET_EXISTS` / `VOLUME_EXISTS` / `PROJECT_BUSY` | 写路由的目标已存在、id 歧义、序冲突、另一会话持写锁 |
| 413 | `payload-too-large` | 请求体 > 1 MiB（`MAX_INTERNAL_BODY_BYTES`） |
| 415 | `unsupported-media-type` | **写路由**的 `Content-Type` 不是 `application/json`（写路由一律带 JSON body，DELETE 也发 `{}`） |
| 200 | `NO_SESSION_CONTEXT` | 缺 `sessionId`，或会话解析不到工作区：`ok:false` + `actions[]`，**零写盘** |
| 200 | `NOT_AN_INKFLOW_PROJECT` / `PROJECT_NEEDS_REPAIR` / `PROJECT_NEEDS_NEWER_PLUGIN` | 解析到目录但四态门禁非 `usable`：附 `state`/`checks`/`missing`/`actions`/`readOnly`，**零写盘** |

**会话来源**：Client 只传 `sessionId`（query `sessionId` 或 header `x-inkflow-session`）；Host 依次用 ①`workspaceRegistry.list()` 中 `sessionIds` 含该会话的 `Workspace.path` ②`workingDirectory.get(sessions.get(id))` ③`Session.header.cwd`；都失败 → `NO_SESSION_CONTEXT`。会话 id 的 `session-` 前缀两种写法都接受（宿主的 `workspace.json` 用 `session-<uuid>`，会话日志头用裸 `<uuid>`）。解析出的目录再 `findProjectRoot` 向上找书（与工具同一套语义）。

**写路由的 `Origin` 口径（2026-10，ADR-0008 D3 修订）**：`Origin` 存在时必须 loopback；**缺省不再直接拒绝**。依据是实测：一次真实的面板保存带着「其它守卫全部满足」却缺 `Origin` 的请求打到 Host，被回`forbidden-origin / origin-required`，作者看到的是「保存按钮没反应」。安全边界没有变薄：跨站页面无法在没有 CORS 预检的情况下发出 `application/json` 的 POST（本通道不应答预检），其它 Content-Type 一律 415，对端与 `Host` 都必须 loopback，请求还必须指名一个 Host 能解析到真书的 session；另外补了 `Sec-Fetch-Site` 这道网——浏览器万一不发 `Origin`，跨站页面仍会自报 `cross-site`。

**加固**（继承 [ADR-0004](../adrs/0004-loopback-http.md)）：`Host` 必须 loopback；`Origin` 存在时必须 loopback；socket 对端地址非空时必须 loopback；不发 CORS 头；`Cache-Control: no-store` + `X-Content-Type-Options: nosniff`；请求体 ≤1 MiB 且必须是 JSON 对象。

**只读纪律（读路由）**：通道**不修复项目结构**、不写 `state.json`、不写任何真相文件。门禁以 `inspectProject(root, { recreateIndexDir: false })` 判定（关掉 `index/` 的自动放宽），卷章树走 `readCatalog` 的 `.md` 投影，索引只以 `readOnly` 打开（检索函数本身不建库），章节文件只读且必须落在 `chapters/` 内。

**唯一例外（issue #5）**：`/chapters` 与 `/search` 先调 `ensureIndex`（§4.0）刷新派生缓存——索引是**可重建的缓存**，不是真相，且只在 `usable` 项目的 `index/` 内发生；重建失败时通道降级作答并回 `indexError`（不把失败变成 4xx/5xx）。

**写路由（5 条：4 条改章 + 1 条改设定库条目）**：写的是**真相文件**，因此比读路由多四道守卫，全部在任何文件 IO 之前：

| # | 守卫 | 拒绝 |
|---|---|---|
| 1 | 方法只 POST/DELETE（读路由只有 GET） | 405 + `Allow` |
| 2 | `Origin` 存在时必须 loopback；**缺省时**看 `Sec-Fetch-Site`：缺省/`same-origin`/`none` 放行，其它值拒绝（读路由不校验） | 403 `forbidden-origin`（`reason: 'cross-site-fetch'`） |
| 3 | `Content-Type: application/json`（DELETE 也发 `{}`） | 415 `unsupported-media-type` |
| 4 | body 只接受 `sessionId` + 该路由声明的字段；体积 ≤1 MiB | 400 `UNEXPECTED_BODY_FIELD` / 413 `payload-too-large` |

- **业务实现只复用** [`chapters.ts`](../../src/host/chapters.ts) 的六个操作（`createVolume`/`renameVolume`/`createChapter`/`writeChapter`/`moveChapter`/`deleteChapter`），通道不自写文件、不改它们的语义；章级写路由只有四个。设定库条目不属于章域（没有卷/序/改名语义），它的唯一写实现是 [`library-write.ts`](../../src/host/library-write.ts)：`patchFrontmatter` 做行级改写、`io.ts` 做原子替换与写锁，通道本身不碰文件。
- **CAS（§5.5）**：`expected` 原样透传；不符 → `409 FILE_CHANGED` + `expected`/`current`/`changed[]`，**零写入**（文件、catalog、索引都不动）。读路由 `/chapters/:id` 与 `/library/item` 回传的 `fingerprint` 就是下一次写的基线；写成功也回传新 `fingerprint`。设定库的写路由**要求**基线（缺 → `400 EXPECTED_REQUIRED`），它没有"不带 expected 覆盖写"这条路。
- **派生缓存**：章写成功后由 `chapters.ts` 的写路径重建 catalog 并 `commitIndex`；设定库写成功后由通道调 `ensureIndex(root, { rebuild: true })`（写后失效，§4.0）。索引失败**不回滚文件**，响应标 `indexError`——文件是真相，索引是缓存。
- **面板不静默覆盖**：客户端拿到 409 后必须由用户显式二选一（重新载入＝丢弃本地改动，或仍要保存＝不带 `expected` 的覆盖写），默认不覆盖；设定库编辑器只提供「重新加载」这一条。
- **门禁**：非 `usable` 项目上五条写路由与读路由一样回结构化门禁清单（`200 + ok:false`），零写入；写路由不做任何"修复"。写真相仍只走工具/域模块 → `io.ts`，面板不是第二条写入实现（ADR-0006 D3 的"用户确认"在面板里由「保存 / 仍要保存」这两个显式动作承担）。

#### 6.2.1 书库通道（`/inkflow/internal/hub/*`，**无会话**）

书库是 root 作用域面板（左侧栏 `sidebar.panellist` 图标 + `main` 主体），拿不到会话，因此这条通道**不解析会话、不要求 `sessionId`**，锚点改为**已注册工作区注册表 + 绝对拒绝集**（§6.1，[ADR-0010](../adrs/0010-book-hub-entry.md) D2/D3/D6）。浏览器依然"什么都不点名"：书单只能来自注册表，请求里出现路径参数仍是 400。

| 路由 | 方法 | 参数 | 成功值 `value` | 状态 |
|---|---|---|---|---|
| `/inkflow/internal/hub/books` | GET | **无**（不读 `sessionId`；带了也忽略） | `books[]`（见下）、`total`（去重后的工作区数）、`capped`、`truncated`、`readOnly: true`、`home`（供客户端渲染 `~/…`）、`pluginVersion` | 已落地 |
| `/inkflow/internal/hub/plan` | POST | `candidate`（**唯一允许的路径字段**，必须绝对路径）、`outsideRegistry?`、`title?` | `path`（canonical）、`anchor`、`state`、`usable`、`checks`、`missing[]`、`actions[]`、`willCreate[]`、`notices[]`、`metaRaw?`、`canApply`、`planToken?`、`alreadyRegistered?`、`blockedReason?`、`message?`、`hint?` | 已落地 |
| `/inkflow/internal/hub/apply` | POST | `planToken`、`confirm: true`、`title?`（**不接受任何路径**） | `path`、`anchor`、`state`、`created[]`、`updated[]`、`skipped[]`、`gitInit`、`notices[]`、`warnings[]`、`registered`、`workspace`（注册结果或 `null`）、`hint?`、`nextStep` | 已落地 |
| `/inkflow/internal/hub/shared` | GET | `kind?`（`world`/`library`/`snippets`/`series`）、`q?` | `created`、`indexSource`（`'index'`/`'scan'`）、`kinds[]`、`entries[]`、`countsByKind`、`total`、`truncated` | 已落地（见 §6.2.2） |
| `/inkflow/internal/hub/shared/copies` | GET | `book`（**已注册工作区的 canonical 路径**） | `projectId`、`seriesId`、`seriesFound`、`selfContained`、`entries[]`（`file`/`kind`/`entryId`/`mode`/`contentHash?`/`currentHash?`/`state`）、`references[]`、`counts{total,current,stale,missing}`、`truncated` | 已落地（见 §6.2.3） |
| `/inkflow/internal/hub/shared/copy` | POST | `book`、`entryId`、`mode?`（`copy`/`reference`）、`confirm: true` | `entryId`、`kind`、`mode`、`files[]`、`origin?`、`projectId`、`projectIdCreated`、`seriesId?`、`warnings[]` | 已落地（见 §6.2.3） |
| `/inkflow/internal/hub/shared/update` | POST | `book`、`entryId?`／`file?`（二选一）、`confirm: true` | `updated[]`、`unchanged[]`、`backupDir?`、`origin?` | 已落地（见 §6.2.3） |

**`books[]` 行形状**（每行 = 一个已注册工作区）：

| 字段 | 含义 |
|---|---|
| `workspaceId` | 注册表 id；宿主不提供时为 `null` |
| `path` | 注册表里的 canonical 路径（展示数据，客户端不会把它发回来） |
| `title` | 注册表标题，缺失取目录名 |
| `state` | 四态门禁之一，另加 `'timeout'`（本次没拿到判定：单本 2 s 超时或判定抛错，**不重试**） |
| `usable` / `missing[]` / `actions[]` | 与工具、工作台**同一份** `inspectProject` 判定（ADR-0008 D5） |
| `dirStatus` | `'ok'` / `'missing-dir'`：注册还在但目录已被删/搬走（来自 `Workspace.status()`，缺失时退化为一次 `stat`）。**不重建、不自动移除注册** |
| `counts?` | `{chapters, volumes}`，取自**已提交的** catalog（`chapters/index.json` + 每卷 `index.json`）；缺失或读不完整则**不带该字段**（未知），绝不扫正文、绝不重建 |
| `notABook?` | `true` = 无 `inkflow.json` 且无任何内容目录：这是用户打开过的工作区，不是坏书。**不自动初始化**；它的初始化走它自己会话里的 `inkflow_project_init`（已注册目录在书库侧不发写凭证） |
| `duplicates?` | 同一 canonical 目录被注册多次时被折叠的条数（只列首行） |

**守卫顺序**（fail-closed，与 §6.2 会话路由同一套，另加"无会话"差异）：

1. `Host` loopback → 403 `forbidden-host`；`Origin` 存在时必须 loopback → 403 `forbidden-origin`；对端地址非空时必须 loopback → 403 `forbidden-remote`。
2. 路径参数禁令（`root`/`path`/`cwd`/`workspace`/`projectRoot`，query 或 body）→ 400 `ROOT_PARAM_NOT_ALLOWED`，**判定在路由匹配与任何文件 IO 之前**。`candidate` 不在禁令名单里，且只被 `plan` 接受：它是本通道唯一能携带**未注册**路径的字段，名字固定为 `candidate`（不叫 `path`/`root`）。`book` 是第二个路径形状字段（只被 `/hub/shared/copies`、`/copy`、`/update` 接受），语义更窄：它**必须是注册表里的 canonical 路径**，否则 400 `BOOK_NOT_REGISTERED`（§6.2.3）。
3. 方法逐路由声明 → 未声明动词 405 + `Allow`（`/hub/books` 只有 GET；`/hub/plan`、`/hub/apply`、`/hub/shared/copy`、`/hub/shared/update` 只有 POST）。
4. 写路由（`plan`/`apply`/`shared/copy`/`shared/update`）额外要求 **`Origin` 与 `Host` 同源（含端口）**（ADR-0010 D6 #6，比会话写路由更严）→ 403 `forbidden-origin`（`reason: 'origin-required'` 或 `'origin-mismatch'`）；`Content-Type: application/json` → 415；体积 ≤1 MiB → 413；body 字段白名单（`plan` 只接受 `candidate`/`outsideRegistry`/`title`，`apply` 只接受 `planToken`/`confirm`/`title`，`shared/copy` 只接受 `book`/`entryId`/`mode`/`confirm`，`shared/update` 只接受 `book`/`entryId`/`file`/`confirm`）→ 400 `UNEXPECTED_BODY_FIELD`。
5. 不解析会话：缺 `sessionId` **不是**错误，`NO_SESSION_CONTEXT` 在 hub 上**不适用**。

**向导两条写路由的契约（plan → apply）**

- **锚点三级判定**（写进 `anchor` 字段，[ADR-0010](../adrs/0010-book-hub-entry.md) D6 锚点 1–3【已定】）：①`candidate` 的 canonical 路径已是注册工作区 → `anchor: 'registered'`，回该书既有状态、**不发 `planToken`**（`message: "这本书已经在书库里"`；已注册目录的写入路径是它自己会话里的 `inkflow_project_init`）；②`candidate` 落在某个注册工作区之内 → `anchor: 'in-workspace'`，用该工作区做作用域跑 `checkProjectRootScope`（文本层级包含判定、canonical 层级作用域判定：junction 指到工作区外 → `PATH_OUT_OF_SCOPE`）；③都不命中 → 必须显式 `outsideRegistry: true`（UI 二次确认），否则 400 `ANCHOR_REQUIRED`；此时作用域取 `candidate` 自身，只留**绝对拒绝集**（盘符/卷根、家目录与其祖先、系统与安装目录 → `PATH_FORBIDDEN`）。
- **`plan` 零写盘**：`inspectProject(root, { recreateIndexDir: false })` + `planWorkspace(root)`，连 `index/` 的放宽都不做；`needs-newer-plugin` 回 `state` + `canApply: false` + `blockedReason`，**不发 token**。
- **`planToken` 生命周期**：进程内随机值（不落盘）、**一次性**、TTL **5 分钟**（默认值 `HUB_PLAN_TOKEN_TTL_MS`，测试可注入时钟/TTL）、绑定 canonical `path` + `anchor` + **plan 摘要**（动作集合、`missing`、`state`、meta 基线）。`apply` 先校验 `confirm`（缺 → 400 `INIT_REQUIRES_CONFIRMATION`，**不消耗 token**），再**在重新推导 plan 之前消耗 token**，然后比对摘要（不一致 → 409 `PLAN_CHANGED`）。因此：重放 → 409 `TOKEN_CONSUMED`；过期 → 400 `TOKEN_EXPIRED`；未知 → 400 `TOKEN_UNKNOWN`；**任何一条拒绝路径都在写盘之前返回，且第二次使用同一 token 不会再写**。
- **`apply` 只做 plan 列出的动作**：复用 `applyWorkspace`（只补缺失、不覆盖；`git init` 是唯一 git 写且不 commit/不配远端/不设身份，§6.4）。
- **注册在 Host 内完成**：`apply` 成功后同一请求调用 `workspaceRegistry.create(path, title)`；服务缺失或抛错 → `registered: false` + `hint`（"在左侧手动打开该目录"），**不假装成功**。客户端**不**再调 `workspaces.create`（避免两条注册写入路径）。
- **降级 A（ADR-0010 D4）**：成功值带 `nextStep: {kind: 'open-new-session', title, path, message}`，`message` 为「书已就绪。在左侧工作区「<title>」点「新会话」开始创作」；面板不跳转、不渲染空白编辑器（程序化建会话做不到）。

**向导错误码**：

| HTTP | code | 触发条件 |
|---|---|---|
| 400 | `CANDIDATE_REQUIRED` / `CANDIDATE_NOT_ABSOLUTE` | `plan` 缺 `candidate`，或给的是相对路径（会按 Host 自己的 cwd 解析，用户从未点名该目录） |
| 400 | `ANCHOR_REQUIRED` | `candidate` 不在任何注册工作区内且未带 `outsideRegistry: true`；**零写盘** |
| 403 | `PATH_FORBIDDEN` / `PATH_OUT_OF_SCOPE` | 绝对拒绝集命中 / 解析后逃出锚定工作区；判定在任何写盘之前 |
| 400 | `PLAN_TOKEN_REQUIRED` / `TOKEN_UNKNOWN` / `TOKEN_EXPIRED` | `apply` 缺 token / 本进程从未签发 / 超过 5 分钟 |
| 409 | `TOKEN_CONSUMED` / `PLAN_CHANGED` / `FILE_CHANGED` / `PROJECT_NEEDS_NEWER_PLUGIN` | 重放 / 目录在 plan 之后被改动（含 meta 基线漂移）/ `applyWorkspace` 的 CAS 冲突 / 旧插件不写新书 |
| 400 | `INIT_REQUIRES_CONFIRMATION` / `META_TITLE_REQUIRED` / `TARGET_NOT_DIRECTORY` | 未带 `confirm: true`（token 不消耗）/ 需要写 `inkflow.json` 却没给 `title` / 目标存在但不是目录 |
| 500 | `GIT_INIT_FAILED` / `APPLY_FAILED` | `git init` 失败（已回滚半成品）/ 应用后仍非 `usable` |

**错误码**：

| HTTP | code | 触发条件 |
|---|---|---|
| 200 | `HUB_UNAVAILABLE` | 宿主没有可用的 `workspaceRegistry`（服务缺失、`list()` 不是函数或抛错）：`ok:false` + `message`/`hint`，**不抛**、不降级成空书单 |
| 200 | `HUB_CAPABILITY_DENIED` | 预留：将来若出现白名单外能力（正文/设定读写、任意文件操作、索引重建）一律回它，而不是新增路由（当前无路由可触发） |
| 400 | `ROOT_PARAM_NOT_ALLOWED` | 与会话路由同一个码：请求里出现路径参数名 |

**成本与规模**（[ADR-0010](../adrs/0010-book-hub-entry.md) D8）：判定并发 **4**；单本 **2 s** 超时 → 该行 `state: 'timeout'`，不重试；整次预算 **3 s** → 返回已完成行 + `truncated: true`；单次最多 **200** 行 → `capped: true`（`total` 仍是注册表总书数）。客户端**不做轮询**：打开时取一次 + 用户点「刷新」。

**只读纪律**：`inspectProject(root, { recreateIndexDir: false })`（关掉 `index/` 放宽）、catalog 只读已提交文件、`state.json` 不写、目录缺失只报告不创建。拒绝路径与只读路径都要求**零写盘**（整树 hash 前后一致）。本通道唯一的写路由是 `/hub/apply`（只补缺失、不覆盖），`/hub/plan` 仍是纯读。

#### 6.2.2 共享内容通道（`/inkflow/internal/hub/shared`，只读）

共享库是**插件级目录**（`dataDir/shared`，[ADR-0007](../adrs/0007-plugin-shared-library.md) C1），不属于任何一本书，因此这条路由**没有锚点可解析、也不接受任何路径参数**：根目录只来自 `src/host/config.ts` 的 `sharedDir(dataDir)`（`dataDir` 由插件配置解析一次）。它只回答"库里有什么"；复制 / 引用 / 重建清单归 #40。

| 项 | 值 |
|---|---|
| 方法 | 只 `GET`；其他动词 405 + `Allow: GET` |
| 参数 | `kind?`（`world`/`library`/`snippets`/`series`；其他值匹配为空）、`q?`（对条目相对路径做大小写不敏感子串匹配） |
| 成功值 | `{ok:true,value:{created,indexSource,kinds[],entries[],countsByKind,total,truncated}}` |
| 守卫 | 与 §6.2.1 **同一套**（loopback host/origin/peer、路径参数禁令、方法逐路由声明、体积上限、`no-store`+`nosniff`）；不解析会话，缺 `sessionId` 不是错误 |
| 错误码 | `SHARED_UNAVAILABLE`（数据目录无法定位：`200 + ok:false` + `message`/`hint`）、`ROOT_PARAM_NOT_ALLOWED`（路径参数，同 §6.2.1） |

**`value` 字段**：

| 字段 | 含义 |
|---|---|
| `created` | 共享库目录是否存在。`false` = **空，不是错误**：`entries: []`、`countsByKind: {}`、`kinds: []`，**不建目录、不写任何文件** |
| `indexSource` | `'index'` = 用了 `shared/index.json` 这份派生清单；`'scan'` = 清单缺失或不可信，在内存里扫四个目录重算，**没有写回清单** |
| `kinds[]` | 库里**存在**的 kind，固定顺序 `world` → `library` → `snippets` → `series` |
| `entries[]` | 过滤后的条目；先按 kind 顺序、再按 `path` 排序 |
| `countsByKind` | 四种 kind 各自的条目数，是**全库**计数（`kind`/`q` 不改变它，所以过滤器不会把页签上的数字改小） |
| `total` | 本次返回的条目数（过滤后、上限后） |
| `truncated` | 本次答案被条目上限或时间预算截断（`true` 时列表不完整，别当成"全库就这些"） |

**条目形状**（[ADR-0007](../adrs/0007-plugin-shared-library.md) C1）：

| 字段 | 含义 |
|---|---|
| `entryId` | `sh-<8 位十六进制>`。文件自带（`.md` frontmatter、`series/*.json` 顶层）就用它；没有则由 `path` 派生，并置 `entryIdDerived: true`——派生的 id 不伪装成作者写下的 id |
| `kind` | 条目所在的一级子目录，只可能是四个值之一 |
| `path` | 相对 `shared/` 的 **POSIX** 路径，例 `world/门派/白鹤门.md` |
| `sha256?` | 真实内容哈希；文件大于上限或读不了就**不带该字段**，绝不填假值 |
| `tags?` | 条目自带就带（`.md` 读 frontmatter 的 `tags`，`series/*.json` 读顶层 `tags`） |

**路径纪律**（[ADR-0010](../adrs/0010-book-hub-entry.md) D5，逐条）：

1. 不接受任何路径参数（`root`/`path`/`cwd`/`workspace`/`projectRoot`，query 或 body）→ 400 `ROOT_PARAM_NOT_ALLOWED`；共享库位置只由 `config.ts` 决定。
2. 条目路径必须落在四个子目录内：拒绝 `..` 段、绝对路径（含盘符与 UNC 写法）、反斜杠分隔符，以及一级目录与 `kind` 不一致的行。
3. 符号链接（含 Windows 目录联接）仅在 realpath 仍落在 `shared/` 内时保留；指向库外的链接、以及**穿过链接的整棵外部目录**都不浏览；同一真实目录只下钻一次（防环）。
4. 清单里只要有一条路径不合法，整份清单视为不可信 → 改走扫描（不"部分采信"，否则列出来的清单既不是清单的也不是目录的）。

**`indexSource` 的判据**：清单可用的条件是「可解析 + 每项 `entryId`/`kind`/`path` 合法 + 路径集合与目录扫描结果**完全一致**（两边都没有多余条目）」。不逐条校验内容哈希：那要对每条算一遍 `sha256`，正是 [ADR-0010](../adrs/0010-book-hub-entry.md) D8 要避免的首屏成本；内容是否过期由扫描重算出的 `sha256` 体现。

**成本与规模**：单次最多 **250** 条（`SHARED_MAX_ENTRIES`）、扫描预算 **1.5 s**（`SHARED_SCAN_BUDGET_MS`）、单文件哈希上限 8 MiB（`SHARED_MAX_HASH_BYTES`）、清单 ≤1 MiB、目录深度 ≤6。只读目录项 + 每文件一次有界头部读（4 KiB）与一次有界哈希，不把整库读进内存。超限只置 `truncated: true`，不静默少列。常量从 `lib/index.js` 导出，也可在调用 `buildHubShared` 时注入（测试因此不需要 sleep）。

**只读纪律**：不写 `shared/index.json`、不建目录、不改条目文件；扫描前后 `shared/` 整树 hash 必须一致（ADR-0010 D6 零写盘断言表）。实现：`src/host/hub-shared.ts`。

#### 6.2.3 共享库的取用方向（复制 / 引用 / 逐条更新）

语义见 [ADR-0007](../adrs/0007-plugin-shared-library.md) C2–C6，实现分两层：`src/host/shared-copy.ts`（域）与 `src/host/shared-channel.ts`（通道信封）。

| 动作 | 路由 | 关键判据 |
|---|---|---|
| 副本列表 / stale | `GET /hub/shared/copies?book=…` | `state`：`current`（`contentHash` = 当前 `sha256`）、`stale`（不等）、`missing-source`（条目已删，副本照旧可用）。**只读** |
| 复制快照 | `POST /hub/shared/copy` | 落位：`world/…`→`world/…`；`library/*.md`→`library/*.md`（连同原文副本）；`snippets/*.md`→`library/snippets/*.md`；`series/*.json`→**不落文件**，只写 `inkflow.json.seriesId` |
| 逐条更新 | `POST /hub/shared/update` | 只有 `stale` 会写；先 `.inkflow/backup/<stamp>/`（`kind: 'shared'`）再覆盖；`current` 是 no-op（`unchanged[]`，不建包） |

**`book` 的语义**：面板是 root 作用域、没有会话（[ADR-0010](../adrs/0010-book-hub-entry.md) D3），所以目标书必须由调用方指名，而唯一可信的名字来源是 Host 自己的注册表：`book` 必须 realpath 命中 `workspaceRegistry.list()` 里的某一项 → 否则 400 `BOOK_NOT_REGISTERED`（**在任何文件 IO 之前**）。命中之后再过四态门禁：非 `usable` → 409 `BOOK_NOT_USABLE`（带 `state`/`missing`/`actions`）。没有会话的通道因此仍然写不进"用户没打开过的目录"。

**`origin` 三字段**（[data-model](data-model.md) §3.7）：`projectId`（缺失时 `null`）、`entryId`、`contentHash`（复制那一刻的 `sha256`）。引用卡（`mode: reference`，**只允许 `library/`**）改记 `sha256`、不记 `contentHash`：它没有副本内容可比。落盘是 frontmatter 里的**嵌套映射**（`origin:` 下三行），写侧只插入/整体替换这一块。拒绝码：`SHARED_ENTRY_NOT_FOUND` / `SHARED_ENTRY_AMBIGUOUS`（同一 id 两条）/ `SHARED_COPY_CONFLICT`（目标已存在，**零写入**）/ `REFERENCE_NOT_ALLOWED`（对 `world/`、`snippets/`、`series/` 选引用）/ `REFERENCE_READONLY`（写引用卡；由 `library-write.ts` 拒绝，**先于** CAS 必填判定）/ `SHARED_COPY_NOT_FOUND` / `SHARED_SOURCE_MISSING`（源已删）/ `SHARED_SOURCE_NOT_UTF8` / `META_UNREADABLE`（记不了 `seriesId`）/ `CONFIRM_REQUIRED`。**`projectId`**：向导为**新书**生成（ADR-0018 D7）；既有书缺失时由 `ensureProjectId(root)` 补一次（第二次 no-op，已有值永不覆盖），读不出 `inkflow.json` 时**不修文件**、副本记 `null`。字段**不参与门禁**。

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
- 内容层的修复（frontmatter/catalog/大纲/关系）与老六目录书的迁移是**另一条链路**：`inkflow_project_repair` / `inkflow_project_migrate`，同样 plan → confirm，落 `.inkflow/{backup,audit}/`，契约见 [ADR-0015](../adrs/0015-repair-and-migration.md)。

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
| `.gitignore` 的 `index/.lock`、`index/.write.lock`、`.openviking/config.local.json` 三行 | 向导只写前三行 `index/*.db*` | #15 / #41 |
| 索引 v2（九目录全实体 + `entity_mentions` + 全实体 FTS） | 索引 v1 只覆盖章/角色/世界观/大纲/资料路径；章正文检索已可用（§4.1） | #23 |
| 面板编辑器与提案制修订 | 面板只有章节树与只读正文预览，写入仍走工具 | #45 |
| 搜索的正文全文检索 | `/search` 只匹配章节元数据，并标 `searchUnavailable: true` | #22 |
| 插件级共享库（复制快照 / `origin` / stale 列表） | 已落地：三条 hub 路由 + 三个工具（§6.2.3）；**未做**「引用卡 → 复制快照」的一键转换 | 转换随 #49 |
| OVK 语义检索（peer 只读、按章重建、降级 FTS5） | 未实现；当前只有 FTS5 | #41 |
| 旧库 ETL（43 表 → 文件树） | 未实现 | #51 |
