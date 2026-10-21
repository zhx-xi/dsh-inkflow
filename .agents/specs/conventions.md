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
volume: vol-01          # 可选；缺省取 chapters/<vol>/ 的目录名（顶层章为空，不会是 "chapters"）
seq: 1                  # 可选；缺省取文件名前导数字
status: draft           # draft | revised | final
pov: 主角                # 可选
---

正文第一段……
```

- **正文就是 Markdown 正文**（frontmatter 之后），不加任何包装标记。
- **frontmatter 解析规则**（实现见 `src/host/frontmatter.ts`）：`#` 只有在引号外、且前面是行首或空白时才算注释；结束符必须是独立成行的 `---`（`----`、`--- x` 不算）；首块内不含任何 `key:` 行时判为「无 frontmatter」，正文优先——宁可丢元数据，也不吞正文。
- **写回规则**：只做**行级补丁**（只替换目标 key 所在行及其块列表项），未知字段、行内注释、键序、引号风格原样保留；原子写盘由调用方负责（临时文件 + rename）。
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
| 不静默覆盖 | 改写既有正文必须走「提案 → 用户确认」（P1 提案制），P0 无写正文工具 |
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

**返回码一览**（失败一律结构化返回，不抛异常给模型）：

| code | 含义 | 模型下一步 |
|---|---|---|
| `NOT_AN_INKFLOW_PROJECT` | 会话工作目录（或显式 `projectRoot`）不是项目；附 `needsSetup: true` | 把 `missing` 转述给用户；用户同意后 `inkflow_project_init` |
| `PATH_OUT_OF_SCOPE` | 显式路径不在**会话工作区子树**内 | 在会话工作目录内开项目，或先切会话工作目录 |
| `PATH_FORBIDDEN` | 盘符/卷根、家目录本身（或其祖先）、系统与安装目录（`Windows`、`Program Files`、`ProgramData`、宿主可执行目录） | 换工作区内的子目录 |
| `INIT_REQUIRES_CONFIRMATION` | 目标目录非空且无 `inkflow.json` | 展示 `willCreate`；用户同意后以 `confirm: true` 重调 |
| `NO_SESSION_CONTEXT` | 面板 HTTP 请求无法得知所属会话工作区（见 §6.2） | 改用工具读；不要把面板结果当作项目真相 |

### 6.1 路径作用域（`projectRoot` / `root`）

- **信任锚点只有一个**：会话工作目录（`ctx.get('workingDirectory')`，缺失时降级 `process.cwd()`）。
- 显式路径先 `realpath`（不存在时对最近存在祖先 `realpath` 再拼回剩余段），再做子树判定；判定在**任何写盘之前**（`inspectProject` 会创建 `index/`，`init` 会创建整棵树）。
- 因此"越界路径"不仅被拒，目标目录**零变更**（mtime/条目不变）。
- 拒绝盘符根与安装目录是硬规则：那里写入会破坏系统或宿主，且绝不可能是用户的书写目录。

### 6.2 面板路由（`/inkflow/api/*`）

浏览器请求不携带会话身份，因此在"会话 → 工作区"解析落地之前：

- 不读 `?root=`（否则任意页面可让插件读写任意目录）；
- 不读 `state.json` 的 `lastProjectRoot`（那是"某个会话最后碰过的书"，不代表当前会话）；
- `/api/status`、`/api/chapters` 一律返回 **HTTP 200 + `ok:false` + `NO_SESSION_CONTEXT`**，且**不创建任何文件**。

## 7. 与旧 InkFlow 的关系

旧库（43 表 / 59 万字）不再是真相源；**迁移 = 生成上述文件树**。逐章、逐实体落盘后可直接 `git commit` 审阅，比跨 schema ETL 更容易核对（P4 执行）。

## 8. 待拍板（3 条，含建议默认值）

| # | 问题 | 建议默认 |
|---|---|---|
| C1 | `index/` 缺失时自动重建（§1 的放宽）是否接受？ | 接受（否则误删索引目录即永久失效） |
| C2 | 伏笔 / 时间线 / 知识关系 / 账本 的归属目录 | 伏笔 → `outlines/foreshadowing/`；时间线 → `world/timeline/`；知识关系 → `world/relations.json`；账本 → `world/facts/` |
| C3 | 新书创建是否提供 `inkflow_project_init`（建目录 + meta，不自动 `git init`）？ | 提供，且不代替用户 `git init`（git 身份/远端应由用户决定） |
