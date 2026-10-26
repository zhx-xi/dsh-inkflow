# dsh-inkflow 架构

> **依据**：[ADR-0005](../adrs/0005-files-first-with-derived-index.md)、[ADR-0006](../adrs/0006-workspace-contract-v2.md)、[ADR-0007](../adrs/0007-plugin-shared-library.md)、[ADR-0008](../adrs/0008-panel-data-channel.md)、[ADR-0009](../adrs/0009-ovk-semantic-search.md)。
> **依赖**：[conventions.md](conventions.md)（契约）、[data-model.md](data-model.md)（数据形状）。
> **相关 ADR**：0003（构建链）、0004（loopback 加固，继承）。
> **状态**：活跃（v3）。本文只写**已实测**的宿主契约与**已裁决**的目标形态；未落地部分标【未实现】，未观测部分标【未验证】。DSH 侧签名来自 `cordis_inspect_query` 的 Host/Client Service 与 Slot 契约（0.2.1-rc.2 实测）。

## 1. 一句话架构

一个 Cordis bundle，两半：**Host 半**在 DSH Node 进程内注册工具与私有内部通道，**Client 半**在会话视图（`conversation.view`）注册「这本书的驾驶舱」。
**作品的真相是每个小说仓库里的 Markdown/JSON 文件**；SQLite 只是 `index/` 下可删可重建的查询缓存，卷章 catalog 是入库的结构投影。DSH 自带的 agent 循环、chat、skills、memory、模型配置全部复用。

```
┌──────────────────── DSH 0.2.1-rc.2 (Electron / Web) ────────────────────┐
│ Agent loop / Chat / Skills / Memory / Logs / 模型与凭据   （复用，不改）   │
│                                                                        │
│ dsh-inkflow                                                            │
│ ├─ Host (lib/index.js)                                                 │
│ │    ctx.tools.register          → inkflow_project_status / _plan /     │
│ │                                   _init / _index_rebuild /            │
│ │                                   _chapter_list                       │
│ │    ctx.webServer.register      → /inkflow/internal/*（私有通道）       │
│ │    node:fs  ← 读写文件（真相），统一经 io.ts                           │
│ │    node:sqlite ← 只写 <project>/index/inkflow.db（缓存）               │
│ └─ Client (lib/client.js)                                              │
│      conversation.view(id='inkflow', order=40)                          │
└────────────────────────────────────────────────────────────────────────┘
        │ 每个小说一个 git 仓库
        ▼
  <book>/ { inkflow.json, chapters/ characters/ world/ outlines/
            foreshadowing/ timeline/ relations/ facts/ library/ index/ }
```

**实现状态**：工具与索引已按上图注册，`/inkflow/internal/*` 私有通道已落地（四条只读路由 + 四条章级写路由，见 §4.2 与 [conventions.md](conventions.md) §6.2）；Client 半只注册 `conversation.view(id='inkflow', order=40)` 一处（§4.3），面板因此拿到 `sessionId` 并把项目解析交给 Host。面板的章节编辑器（标题/正文/状态 + 自动保存 + 本地撤销 + CAS 冲突二选一）已接上写路由；提案制修订尚未落地（§9.1）。

## 2. 存储决策（ADR-0005）

| 维度 | 旧（ADR-0002，已作废） | 现（ADR-0005） |
|---|---|---|
| 真相源 | SQLite 单库 | 项目 git 仓库里的文件 |
| 索引 | 无（DB 即真相） | `index/inkflow.db`，可删可重建 |
| 升级/迁移 | 数据库迁移（schema 版本 + DDL） | **没有数据库迁移**：索引 schema 变了就删库重建 |
| 版本历史 | 自建 change_log | `git log` / `git revert` |
| 不变量强制 | FK / CHECK / 触发器 | 写入校验 + 索引重建校验 |
| 竞品对照 | 与桌面 App 一致 | 与 7/9 的 DSH 插件派一致（见 ADR-0005 背景表） |

## 3. 项目门禁（约定大于配置）

`findProjectRoot(start)` 从会话工作目录**向上**找最近的「已经有书」信号——存在 `inkflow.json` 或 `.git`（[ADR-0006](../adrs/0006-workspace-contract-v2.md) D5）；内容目录**不**参与信号，否则旧目录结构的半成品会被跳过，答成上一层仓库。命中后 `inspectProject(root)` 产出**四态之一**（[conventions.md](conventions.md) §1，按序命中即停）：

| # | 状态 | 检测 | 不满足时 |
|---|---|---|---|
| 1 | `needs-newer-plugin` | `inkflow.json` 可解析且 `schemaVersion` > 插件上限 | 业务工具只读拒绝；**零写入**（不改 meta、不重建索引） |
| 2 | `usable` | git + 九个内容目录与 `index/`（每项带 `.gitkeep`）+ meta 可解析且版本 ≤ 上限 | — |
| 3 | `needs-repair` | 有 meta（哪怕不可解析）或有 `.git` | 返回 `PROJECT_NEEDS_REPAIR` + 结构化清单；只能走修复向导 |
| 4 | `needs-setup` | 都不成立 | 返回 `NOT_AN_INKFLOW_PROJECT` + `needsSetup: true`；只能走初始化向导 |

**唯一放宽**：`index/` 是派生物。当其余九项 + git + meta 齐全而 `index/` 目录缺失时，插件自动创建 `index/`（含 `.gitkeep`）并在结果里标 `indexDirRecreated: true`——否则删一次索引目录就等于永久锁死插件。判定路径上只有这一个写操作。

失败一律返回结构化清单（`state` / `checks` / `missing` / `actions` / `readOnly` / `reasons` / `hint`），不抛异常、不静默兜底、不在随机目录建库。

**向导**（[conventions.md](conventions.md) §6.3）：`inkflow_project_plan`（只读）列出动作 → `inkflow_project_init`（`confirm: true`）只补缺失项；坏 `inkflow.json` 先回原文（截断标注）再允许重建；`git init` 是唯一允许的 git 写操作（不 add/commit/remote/身份）。

**会话目录来源**：优先 `ctx.get('workingDirectory').ensure(agent)`（公共服务，缺失时降级 `process.cwd()`）。工具也接受显式 `projectRoot`，但该路径必须 `realpath` 后落在**会话工作区子树**内；盘符根、家目录本身、系统与安装目录硬拒（`PATH_OUT_OF_SCOPE` / `PATH_FORBIDDEN`，写盘前拒绝）。跨会话状态 `state.json` 的 `lastProjectRoot` 只用于展示（启动日志），**不作为任何解析来源**——它是"某个会话最后碰过的书"，拿来兜底会把别人的书当成当前项目。

## 4. DSH 集成点（实测签名）

### 4.1 工具 — `ctx.tools`

`ctx.tools.register(definition: ToolDefinition): () => void`，注册即进 system prompt。本插件用**原始 JSON Schema**（`parameters`）+ 纯对象定义，不 import `defineTool`（零运行时依赖，见 §5.1）。`output.render(args, value)` 必须返回 `[{type:'text', text}]`。

### 4.2 私有内部通道 — `ctx.webServer`

`ctx.webServer.register({kind:'prefix', path:'/inkflow', handler})`。这是**面板与 Host 之间的内部实现**，不是对外 API（[ADR-0008](../adrs/0008-panel-data-channel.md) D2）：不版本化、不提供 OpenAPI、不承诺兼容、不对外文档化；`/inkflow/api/*` 一律 404。

**安全清单**（fail-closed；`src/host/routes.ts` 在请求入口按序执行，命中即返回）：

1. `Host` 必须 loopback → 否则 403 `forbidden-host`（防 DNS rebinding）。
2. `Origin` 存在时必须 loopback → 否则 403 `forbidden-origin`（防跨站 fetch）。
3. socket 对端地址非空时必须 loopback → 否则 403 `forbidden-remote`。
4. 方法**逐路由声明**（`ROUTES[].methods`）：读路由只有 GET，写路由是 POST/DELETE；未声明的动词 405 + `Allow` 头。
5. 路径参数一律拒绝：`root`/`path`/`cwd`/`workspace`/`projectRoot` 出现在 query 或 body → 400 `ROOT_PARAM_NOT_ALLOWED`（`reason: 'unexpected-path-param'`），判定在路由匹配与任何文件 IO 之前。
6. 请求体 ≤1 MiB（`MAX_INTERNAL_BODY_BYTES`，超限 413）。2026-10 由 64 KiB 提高：一次保存把整章正文当作**一个 JSON 字符串**提交，而 64 KiB 数的是序列化字节——一章 2 万汉字序列化后约 70 KB，长章因此根本存不进去（issue #115）。此外必须是 JSON 对象；未知路径 404。
7. 响应 `Cache-Control: no-store` + `X-Content-Type-Options: nosniff`，信封 `{ok:true,value}` / `{ok:false,error:{code}}`，**不发任何 CORS 头**。
8. **写路由**（`/chapters` POST、`/chapters/:id` POST/DELETE、`/chapters/:id/move` POST）：只 POST/DELETE + `Content-Type: application/json`（否则 415）+ **必须带 loopback `Origin`**（否则 403 `reason: 'origin-required'`）+ body 字段白名单（只接受 `sessionId` 与该路由声明的字段）+ `expected` 走 §5.5 CAS（不符 → 409 `FILE_CHANGED`，零写入）。业务只复用 `chapters.ts` 的六个操作，通道不自写文件。

请求只携带 `sessionId`（query 或 `x-inkflow-session`）。Host 按序解析：`workspaceRegistry.list()` 的 `sessionIds → Workspace.path` → `workingDirectory.get(sessions.get(id))` → `Session.header.cwd` → 失败即 `200 + ok:false + NO_SESSION_CONTEXT`（附 `actions[]`，零写盘）；`session-` 前缀的两种写法都匹配。解析出的目录经 `findProjectRoot` 向上找书，再 `inspectProject(root, { recreateIndexDir: false })` 过四态门禁——面板与工具看到同一份 `state`/`checks`/`missing`/`actions`（D5）。

路由清单与错误码见 [conventions.md](conventions.md) §6.2。投影实现在 `src/host/internal.ts`，全部只读真相文件：关掉 `index/` 的自动放宽、卷章树走 `readCatalog` 的 `.md` 投影、索引只以 `readOnly` 打开（检索函数本身不建库）、章节文件只读且必须落在 `chapters/` 内。**唯一允许的写是派生缓存**：`/chapters` 与 `/search` 先经 `ensureIndex` 把索引弄新鲜（issue #5，§7），失败则降级——继续用旧索引或 catalog 投影作答并回 `indexError`。面板**从不修复项目结构**（`needs-repair` / `needs-setup` 下的写入只能由用户确认后的向导触发）；`index/` 缺失时 `/status` 报 `index.dbExists: false`，卷章树仍从文件投影得到。

**body 白名单的归属（#162）**：每条路由的 `body` 是一个 `*_BODY_FIELDS` 常量，**定义在读取该 body 的模块里**（`internal.ts` 的 `CHAPTER_*_BODY_FIELDS`、`hub-settings.ts`、`hub-wizard.ts`、`shared-channel.ts`、`extract-channel.ts` …），`routes.ts` 只 import、不写字面量；设置页的 `HUB_SETTINGS_BODY_FIELDS` 由 `settings.ts` 的 `SETTINGS_FIELDS` **派生**（+ `confirm`），不再手抄。依据是 #162：手抄字段表在 #41 加 `semanticEndpoint`/`semanticApiKey` 时差点漏改，而漏改只表现为设置页保存 `400 UNEXPECTED_BODY_FIELD`——字段在设置层完全合法，所以没有任何别的测试会红。机械守卫：`tests/body-fields.test.js` 扫描 `routes.ts` 禁止行内 `body: [`；`tests/hub-settings.test.js` 断言白名单 = `SETTINGS_FIELDS` + `confirm`，且线上逐个字段都被接受。

**书库通道 `/inkflow/internal/hub/*`：无会话、独立路由组**（[ADR-0010](../adrs/0010-book-hub-entry.md) D3/D6）。左侧栏书库是 root 作用域面板，拿不到会话，所以这条通道**不改动上面的会话路由一行**，而是在同一个 `/inkflow` 前缀下先按段分发（`internalPath` 以 `/hub` 开头即进 hub 分派器）：

| 项 | 会话通道 | 书库通道 |
|---|---|---|
| 信任锚点 | 会话 → 工作区 → 目录 | **工作区注册表**（`workspaceRegistry.list()`）+ 绝对拒绝集；写动作另加一次性 `planToken` |
| 路径从哪来 | Host 从会话推出 | 读：注册表；写：只有 `planToken`（调用方永远拼不出路径） |
| `sessionId` | 必需（缺 → `NO_SESSION_CONTEXT`） | **不适用**：不读、不要求；带了也忽略 |
| 方法 | 逐路由声明 | 逐路由声明（`/hub/books` 只有 GET；`/hub/plan`、`/hub/apply` 只有 POST） |
| 写守卫 | 写路由要 loopback `Origin` + JSON | 写路由要 **`Origin` 与 `Host` 同源（含端口）** + JSON + body 字段白名单（更严，ADR-0010 D6 #6/#7） |
| 错误码 | `NO_SESSION_CONTEXT` / 门禁码 | `HUB_UNAVAILABLE`（无注册表）、`ROOT_PARAM_NOT_ALLOWED`（同一个码）、向导的 `ANCHOR_REQUIRED` / `TOKEN_*` / `PLAN_CHANGED`、预留 `HUB_CAPABILITY_DENIED` |

`/hub/books` 的投影实现在 `src/host/hub.ts`（不是 `internal.ts`）：每行 `state`/`missing`/`actions` 与工作台、工具**同一份** `inspectProject(root, { recreateIndexDir: false })`，另加 `dirStatus`（注册还在但目录已删）、`counts`（只读**已提交** catalog，缺失即未知）、`notABook`（无 meta 且无内容目录）。成本上限：并发 4、单本 2 s → 该行 `state:'timeout'` 不重试、整次预算 3 s → `truncated`、单次 200 行 → `capped`（ADR-0010 D8）。客户端**不轮询**：打开取一次 + 手动「刷新」。

#### 4.2.1 共享内容通道 — `src/host/hub-shared.ts`（只读，无会话）

书库的第二个只读投影：`GET /inkflow/internal/hub/shared` 回答 `dataDir/shared` 里有什么（[ADR-0010](../adrs/0010-book-hub-entry.md) D5；目录形状见 [ADR-0007](../adrs/0007-plugin-shared-library.md) C1）。它与上面的书库通道共用同一套守卫，差别只有两点——**没有锚点**（共享库不属于任何一本书，也不在 `workspaceRegistry` 里）和**没有参数**（根目录只来自插件配置，浏览器除了 `kind`/`q` 两个过滤器什么都给不了）。

**数据流**

```
请求（只有 kind? / q?）
  → config.ts sharedDir(dataDir)          根目录的唯一来源；请求里没有路径可传
  → walkKinds：只读四个 kind 目录的目录项
      每个子项 realpath 必须仍在 shared/ 内（同一道闸门也决定"能否下钻"）
      同一真实目录只下钻一次（防环）+ 深度上限 + 条目上限 + 时间预算
  → shared/index.json 可用？
      可用   → entries 取自清单                  → indexSource: 'index'
      不可用 → 逐条重算 id/tags/sha256（有界读） → indexSource: 'scan'
  → 过滤（kind/q）→ 全库计数 → 排序 → {ok:true,value}
```

**只读纪律（三层）**

1. **代码层**：`hub-shared.ts` 没有任何写 API —— 不 `mkdir`、不写 `index.json`、不改条目文件；库不存在只回 `created:false`（空不是错误，也不是"顺手建一个"的理由）。**取用方向（复制/引用/更新）不在这个文件里**：它在 `shared-copy.ts`（§4.2.3），由 `shared-channel.ts` 暴露成三条独立的 hub 路由，各自带写守卫。
2. **数据层**：`index.json` 是**派生清单**（[ADR-0005](../adrs/0005-files-first-with-derived-index.md)：文件是真相、清单是缓存）。清单与目录不一致时**以目录为准**，清单既不修也不补。
3. **证据层**：拒绝路径与正常读取都要求 `shared/` 整树 hash 前后一致（`tests/hub-shared.test.js`）；取用侧另有自己的整树证据（`tests/shared-copy.test.js`、`tests/shared-routes.test.js`）。

**为什么不写回 `index.json`**

- **能力边界**：清单是缓存，不是真相；#40 落地后仍然不写回——写回会让"手改清单"变成一件看起来有效的事，而 [ADR-0007](../adrs/0007-plugin-shared-library.md) C1 明确说手改会被下一次扫描覆盖。
- **幂等与并发**：面板可能同时开在多个窗口。谁都写清单就会出现"最后写者赢"的清单；不写，则任何窗口看到的都是同一份真相——目录本身。
- **失败形态更好**：清单坏了只是"这次扫描"；扫描被预算截断只是"这次少列 + `truncated:true`"。两者都不留下半写状态。

**成本上限**：见 [conventions.md](conventions.md) §6.2.2。常量在 `hub-shared.ts` 顶部导出，测试注入而非真的等待 1.5 秒。

#### 4.2.3 共享库的取用方向 — `shared-copy.ts` + `shared-channel.ts`（#40）

`GET /hub/shared` 只回答"库里有什么"；把条目**拿进一本书**是另一个方向、另一套纪律（[ADR-0007](../adrs/0007-plugin-shared-library.md) C2–C6），由两个模块分担：

| 模块 | 负责 | 不负责 |
|---|---|---|
| `src/host/shared-copy.ts` | 域：`copySharedEntry`（快照 + `origin`）、`updateSharedEntry`（逐条更新，先备份）、`buildSharedCopies`（副本与 stale 列表，只读）、`ensureProjectId`、`applyOriginBlock`/`readOrigin`（`origin` 块的写与读） | 认路径、认会话、认 HTTP；它只接收一个已经过门禁的 `root` |
| `src/host/shared-channel.ts` | 通道：`book` 必须命中 `workspaceRegistry`（`listRegisteredWorkspaces` + realpath 比较）→ 再过四态门禁 → 才调域；三条路由的 body 白名单 | 判定"什么算一条副本"、写 `inkflow.json` 字段 |

**落位（ADR-0007 C2）**：`world/…` 原样落 `world/…`；`library/*.md` 落 `library/*.md`（连同可选原文副本）；`snippets/*.md` 落 `library/snippets/*.md`（`library/` 是资料域，**不新增第十个一级目录**）；`series/*.json` **不落文件**，只写 `inkflow.json.seriesId`。

**三条路由**（只在写时有 `Origin` 同源要求，与 `plan`/`apply` 同一套守卫）：

| 路由 | 动词 | body | 语义 |
|---|---|---|---|
| `/hub/shared/copies` | GET | query: `book` | 本书副本 + `state`（`current`/`stale`/`missing-source`）+ `selfContained` + `seriesId`/`seriesFound`；**只读** |
| `/hub/shared/copy` | POST | `book` / `entryId` / `mode?` / `confirm` | 复制快照（默认）或 `library/` 引用卡；冲突 → `SHARED_COPY_CONFLICT`，零写入 |
| `/hub/shared/update` | POST | `book` / `entryId?` / `file?` / `confirm` | 逐条更新：先 `openBackup(root,'shared')` + `stageFile` + `sealBackup(sealed:false)`，再写，再 `sealBackup(sealed:true)` |

**`origin` 的落盘形式**：frontmatter 里的**嵌套映射**（`origin:` 下三行 `projectId`/`entryId`/`contentHash`，引用卡换成 `sha256`）。这要求 `frontmatter.ts` 能读缩进映射——原先缩进行会被报成"unparsed frontmatter line"，而那条 issue 会进 `validation_issues` 与体检报告，等于每条副本都是"坏文件"。因此读侧扩了**一层**嵌套映射支持（值仍只到标量/内联数组/块列表），写侧由 `applyOriginBlock` 负责"插入或整体替换"，不改其他任何字节。

**为什么 `stale` 不动文件**（[ADR-0007](../adrs/0007-plugin-shared-library.md) C3）：副本是作者的正文，来源变了不等于副本该被覆盖。列表报 `contentHash` 与当前 `sha256`，更新是显式动作且有备份包。

#### 4.2.2 向导线（plan → apply）— `src/host/hub-wizard.ts`（唯一的 hub 写面）

```
用户点「新开书」
  → Client uiWorkspace.pickDirectory()（能拿到"用户意图目录"的唯一能力，不读内容）
  → POST /hub/plan {candidate, outsideRegistry?, title?}
      ① 路径参数禁令：`candidate` 是唯一允许的路径字段，其余路径参数一律 400 ROOT_PARAM_NOT_ALLOWED
      ② 锚点：注册表命中            → anchor='registered'（回既有状态，不发 token）
              在注册工作区之内      → anchor='in-workspace'（作用域 = 该工作区）
              都不命中 + 无 outsideRegistry → 400 ANCHOR_REQUIRED（UI 二次确认后才带 true）
              都不命中 + outsideRegistry   → anchor='outside-registry'（作用域 = 自身，只剩绝对拒绝集）
      ③ checkProjectRootScope(canonical, 作用域) → PATH_FORBIDDEN / PATH_OUT_OF_SCOPE
      ④ inspectProject(root, {recreateIndexDir:false}) + planWorkspace(root)   ← 零写盘
      ⑤ 签发 planToken（绑定 canonical path + anchor + plan 摘要）
  → Client 确认卡：canonical path、willCreate[]、notices[]、书名
  → POST /hub/apply {planToken, confirm: true, title?}
      confirm 校验（不消耗 token）→ 消耗 token → 重新推导 plan 并比对摘要（PLAN_CHANGED）
      → applyWorkspace(root, {confirm:true, title, expected: metaFingerprint})
      → workspaceRegistry.create(path, title)（缺失/抛错 → registered:false + hint）
      → nextStep（降级 A 文案 + canonical path）
  → Client 就地更新该书行（不重拉整页、不轮询）
```

**`planToken` 生命周期**：进程内 `Map`，**一次性**，TTL 5 分钟（`HUB_PLAN_TOKEN_TTL_MS`，测试可注入时钟与 TTL），不落盘；消耗发生在**重新推导 plan 与任何写盘之前**，所以重放必然是 `409 TOKEN_CONSUMED` 且零写盘，目录在 plan 之后被改动则是 `409 PLAN_CHANGED` 且零写盘。token 存储、摘要与两条写路由的业务逻辑都在 `hub-wizard.ts`；`routes.ts` 只做守卫与 `{status, body}` 信封。

### 4.3 Client 槽位 — `ctx.slots`

**两个入口，两个作用域**（[ADR-0010](../adrs/0010-book-hub-entry.md) D1，收窄 [ADR-0008](../adrs/0008-panel-data-channel.md) D1 的"唯一入口"）：

| 槽位 | 类型 | 作用域 | 注册参数 | 职责 |
|---|---|---|---|---|
| `sidebar.panellist` | list | **root** | `{name:'sidebar.panellist', id:'inkflow-hub', order:35, label: () => 'InkFlow 书库'}` | 书库**图标**（该槽位只渲染图标：occupant props `{size, active}`，`label` 同时是可见文字、无障碍名与折叠态 tooltip） |
| `main` | **keyed** | **root** | `{name:'main', key:'inkflow-hub'}` | 书库**主体**（`PanelRow` 选中后由 `renderSlot('main', {}, {entryKey})` 渲染；`main` 只认 `key`，用 `id` 注册等于没注册） |
| `conversation.view` | list | **session** | `{name:'conversation.view', id:'inkflow', order:40, label: () => 'InkFlow'}` | 创作**工作台**：与「对话 / 轨迹」同栏（chat 0、trajectory 10 之后） |

实测契约（DSH 0.2.1-rc.2 打包产物：`cordis_inspect_query` 的 client/Slots 在本机超时，改读 `dsh-cordis-client-runner/lib/client.js` 的槽位目录与各 `dsh-client-ui-<包>/lib/client.js` 的注册调用）：

- register options 只有 `id`（必填）、`order`、`label`；**没有图标位**——`label` 是页签文字，thunk 形式跟随当前语言。
- standardProps 中本面板用到的是：`sessionId`（会话 id）、`useSessions`（快照 `{ids, byId}`，`byId[id].cwd`）、`useWorkspaces`（快照 `items[]`，含 `path`/`title`/`sessionIds`）、`useSession`（会话快照，`openState` 等）。owner props（`inspectCall` / `viewRequest` / `openView` / `completeViewRequest`）骨架不使用。
- **`sidebar.panellist` 只渲染图标，主体必须落在 `main`**（0.2.1-rc.2 打包产物实测，`dsh-client-ui-sidebar/lib/client.js`）：`PanelRow` 用 `renderSlot('sidebar.panellist', {size, active}, {only: id})` 取**图标**，点击时只调 `selectPanel(id)`；`dsh-client-ui-layout` 的 `MainPanel` 再用 `renderSlot('main', {}, {entryKey: activePanelId ?? 'conversation'})` 渲染**主体**。两侧共用同一个 id：`main` 是 `kind:'keyed'`，注册参数是 **`key`**（写 `id` 无效），且 `layout.selectPanel(id)` 在 `main` 没有该 key 时**抛错**「main panel "…" is not registered」，当前选中不变。因此书库是**一对**注册（`id:'inkflow-hub'` + `key:'inkflow-hub'`），少任何一个都是"有图标没页面"（AGENTS.md §8 陷阱 3）。
- 注册包在 `ctx.effect(() => ctx.slots.inject(<slot>, () => ctx.slots.register(...)))` 里；Client 半共三处注册（工作台页签、书库图标、书库主体）与三处 `slots.inject`，**没有** `main` 的作品数据视图（书库主体只列书与门禁状态）。
- 书库拿不到会话，所以它不读 `useWorkspaces`/`useSessions`，也不拼任何路径：数据只经 `fetchInternal('/hub/books', { sessionless: true })`（`sessionless` 在 `internal.ts` 里被钉死为只允许 `/hub/*`）。

**槽位数据 → 面板区域**（`src/client/index.tsx`）：

| 用途 | 来源 |
|---|---|
| 会话 id（唯一发给 Host 的东西） | standardProp `sessionId` → `setActiveSessionId()` |
| 工作区标题、`path`（`root` 相对化与项目名兜底） | `useWorkspaces((s) => s.items)`，按 `sessionIds` 匹配（`session-<uuid>` 与裸 uuid 两种写法都认，与 Host 解析同宽容度） |
| 会话 `cwd`（工作区缺失时的相对化基准） | `useSessions((s) => s.byId)` |
| 会话是否仍在打开（不抢在会话之前报空态） | `useSession((s) => s.openState)` |

纯视图逻辑（四态徽标文案、卷章树、空态判定、`root` 相对化、页签表、`previewText` / `describeAction`）在 `src/client/panel-model.ts`：不碰 React、不发请求，由 `tests/panel-bundle.test.js` 直接打这个模块（`node --test` 无 DOM，组件本身只按构建产物做静态断言）。书库同理：徽标（含 `timeout` 的"无判定"档）、`~/…` 路径、卷章数文案、`missing-dir`/`notABook`/重复注册标记、`HUB_UNAVAILABLE` 文案全在 `src/client/hub-model.ts`。

#### 4.3.1 面板高度契约：两个独立滚动 box（issue 116）

**症状**：章节页签里章节树（左）与正文（右）没有各自的滚动条，两栏跟着整页一起滚。

**实测高度链**（DSH 0.2.1-rc.2 桌面版，独立 Electron 窗口载入 `http://127.0.0.1:8162`，窗口 1280×900 → 视口 1266×838，探针会话指向副本小说）：

| 层 | 高度 | 关键计算值 |
|---|---|---|
| 面板根（`height:'100%'`） | 2539px | 百分比**解析成功**，但基准是内容高度 |
| 两列 body（原 `flex:1`） | 2428px | `grid-template-rows` 为 `auto` |
| 左右两列（`overflowY:'auto'`） | 2428px | `scrollHeight === clientHeight` → `auto` 永不触发 |
| 槽位包装（flex 项，`min-height:auto`） | 2539px | 自动最小尺寸：不会缩到内容以下 |
| 会话滚动框（`overflow-y:auto`） | 762px（内容 2667px） | 页面上**唯一**的滚动条＝整页滚 |

结论：issue 的【推断】「`height:100%` 退化成 auto」只对了一半——百分比解析是成功的，问题在它的基准（槽位包装）本身是内容尺寸，面板拿不到任何"被视口截断"的高度。因此方案 A（最小改动）不成立；常数方案 B 会撞上下面 P3 的座位问题。

**契约**（`src/client/layout.ts` 读 DOM + `src/client/layout-model.ts` 算数）：

| # | 规则 | 理由（实测） |
|---|---|---|
| P1 | 两列 body 的高度由**运行时实测**写进 CSS 变量 `--inkflow-body-h`：`ResizeObserver` 观察滚动框及其子元素 + `window.resize` + 每次渲染复测 | 侧边栏折叠/面板切换会改宽度而不触发 `window.resize`；页头在窄窗换行、stale 构建警告条出现也会改面板自身 chrome |
| P2 | 量不到（无 DOM／无滚动祖先／几何退化）时兜底为 CSS `100%` | 即修复前行为：不理想但绝不塌成 0；不能因为测量失败把面板弄没 |
| P3 | 可用底边 = min(视口高, 最近滚动祖先底边, **同一滚动流里本 box 之后第一个元素的顶边**) | DSH 把输入框座位放在同一个滚动框里（实测高 128px、顶边 710）。按滚动框底边定高会让两列下沿钻到座位下面，并留下 128px 页面滚动条 |
| P4 | 取「之后的元素」用结构规则，**不认任何 harness 类名或 dom id** | `Dc7zOa_*` 是构建哈希，随 DSH 升级变 |
| P5 | 高度取 `Math.floor`，不四舍五入 | 886×638 下四舍五入留 1px 溢出＝一条页面滚动条 |
| P6 | body 加 `grid-template-rows: minmax(0,1fr)` 与 `flex: 0 0 auto` | `flex:1` 即 `flex-basis:0%`，会覆盖显式 `height`；实测只加 height 时 body 仍是 2428px |
| P7 | 面板**内部**再分「不滚的头 + 一个滚动 box」时（设定库详情，issue 133），内层 box 用同一个 `useScrollBox()`，且它与头必须是**两个兄弟节点**；内层 box 下方**不能**留 padding（呼吸位放进 box 内部） | 内层 box 的可用底边是所在列的 border box，列底边上的 padding 会被算进高度：列高 = 内容 + 该 padding，于是列多出正好等于 padding 的溢出，头又会跟着往上滑走（issue 133 的 14px 残留） |

**实测验收**（同一 GUI，按上述规则把高度手工写进 DOM 后量得）：body 523px 时外层滚动框 `scrollHeight 890 → 762 = clientHeight`（溢出 0）；左列 `clientHeight 523 / scrollHeight 2428` 自滚，滚它 120px 后右列与外层 `scrollTop` 仍为 0、面板顶边不动；`describeFacts` 那行统计在左列滚到底时可见（底边 696 < 列底 710）；900×700（视口 886×638）下可用 288px、外层溢出 0、两列不重叠、无横向溢出。

**不在范围**：非 `usable` 状态的单列卡片（不参与两列布局，走 P2 兜底）。

### 4.4 主题


只用 `--dsw-alias-*`（明暗双份）：`bg-base`、`bg-layer-1/2`、`border-l1/l2`、`label-primary/secondary`、`state-success/warn/error/idle-primary`。字面色只用于图标。

### 4.5 生命周期

每个注册都写成 `ctx.effect(() => resource)`；索引库按调用开/关，进程内不持有长连接——因此**没有需要清理的常驻资源**。

### 4.6 写作 skills 与写作 preset — `ctx.skills` / `ctx.agentPresets`

两个能力都按**可选服务**处理：`ctx.get('skills')` / `ctx.get('agentPresets')` 探测 + 形状校验（`src/host/probe.ts`），缺失时**各打一行日志**、其余能力照常。不写进 `inject:`——硬注入会让服务缺失直接拖死整个插件。

#### skills — 用 provider，不用 `register()`

`ctx.skills.registerProvider(create: (control) => SkillProvider): () => void`。**为什么不用 `ctx.skills.register()`**：它把技能写进**调用方 context 所在的层**，本插件是全局装配，写进去就进全局层——每个会话（写代码的也算）的技能目录里都会多出 5 个小说技能。provider 的 `list(options)` 会收到 `options.cwd`（`dsh-tool-skill` 用 `ctx.workingDirectory.ensure(agent)` 取值），因此按 `findProjectRoot(cwd)` 门禁：只有会话工作目录落在 InkFlow 项目里才返回候选，否则返回**空数组**。

> 返回空数组而不是「不完整观测」：观测不完整会让 `dsh-tool-skill` **整个技能目录停发**（`if (!snapshot.complete) return decision`，实测于 0.2.1-rc.2 源码），而空数组才是正确语义「本会话没有 InkFlow 技能」。

| 字段 | 取值 | 注册表校验（0.2.1-rc.2） |
|---|---|---|
| `name` | `inkflow-architect` / `-writer` / `-auditor` / `-reviser` / `-polisher` | kebab-case；provider 名不能是保留字 `runtime` |
| `description` | 来自 `SKILL.md` frontmatter | 非空（目录里逐条展示） |
| `rank` | `600` | 层内同名时小的赢；600 是 `dsh-skill` 给打包技能的档位，项目级技能仍能盖过它 |
| `source` / `provider` | `bundled` / `inkflow` | `candidate.provider` 必须等于 provider 名，否则抛错 |
| `locator` | 技能名 | 注册表原样交回 `get()` |
| `resourceBase` | `{kind:'directory', path:<skills/<name>>}` | 让正文里的相对路径相对技能目录解析 |

`list()` 只回摘要，`get(candidate)` 才回 `content`（`SKILL.md` 正文，frontmatter 已剥离）——目录列举不读正文。

#### preset — 一个 Cordis 组合，不是技能清单

`ctx.agentPresets.register(definition: PresetDefinition): Promise<() => Promise<void>>`，`PresetDefinition = { id, name?, description?, order?, plugins: LoaderEntryLike[] }`。`plugins` 是 **Cordis entry 列表**（与 bundle patch 的 `- insert:` 同形）：行里只能挂插件包，**不能直接写技能名或工具名**——技能与工具是这些行挂载后向 preset 作用域贡献的。

本插件注册 `id: inkflow-writing`：一行 `@deepseek-ai/dsh-persona`（人设点名 5 个技能与五阶段流水线）+ `tool-skill` / `tool-fs` / `tool-fs-search` / `tool-todo` / `tool-ask-user` / `tool-web`。**故意不含** shell、subagent、workflow：作者会话不该有仓库改造能力。`inkflow_*` 工具由 Host 半全局注册，preset 会话自然可见，行里不重复。

`register()` 是异步的且**失败不抛**（诊断留在名册 `broken` 上），所以在 `ctx.effect` 里消费这个 promise：成功记一行 info、拒绝记一行 warn，卸载时用 `cancelled` 标记再 `await` 它返回的 disposer，避免卸载后又把注册塞回去。

#### 降级（服务缺失时）

- 没有 `skills` 服务：5 个文件仍随包分发（`check:package` 会检查），只打一行 `skills service missing`。
- 没有 `agentPresets` 服务：只打一行日志；技能与 `inkflow_*` 工具照常工作。
- 某个 `SKILL.md` 缺失或 frontmatter 与目录名不一致：逐条 warn，其余技能照常注册；一个都读不出来时**什么都不注册**（不注册空目录）。

### 4.7 写作上下文注入 — `ctx.systemPrompt`

`ctx.systemPrompt.section(section: PromptSection): () => void`，`PromptSection = { name, order, text: string | ((context: AssembleContext) => string), interpolate?, complete? }`；同名 section 在**同一层**重复注册会抛 `already registered`。本插件注册一个段 `inkflow:writing-context`（order 120，位置只是建议值：宿主按 order 排序，具体邻居到重启后目视才算验证）：写作会话的 system prompt 里直接带上「写到哪一章、这一章要做什么、上一章怎么收尾、本章该记起哪些设定」，让模型在**第一次工具调用之前**就知道处境。

**这一段注入的是九段简报**（`briefFor()` → `buildWritingBrief()`，ADR-0022 D1/D2，§4.7 以下几节描述的是它复用的六段装配 `buildWritingContext()` 的取数与阶梯）：预览页、落盘审计与真实注入是**同一次计算**，因此「面板上看到的九段」与「模型收到的」在原理上不可能不同（X-23）。

**为什么不用 `inject: ['systemPrompt']`**：硬注入会让服务缺失直接拖死整个插件（与 skills/preset 同一条纪律，§4.6）。

#### 注入源与门禁

| 步骤 | 实现 | 失败时 |
|---|---|---|
| 会话目录（同步） | `ctx.get('workingDirectory').get(session)`（提交值，无文件 IO）→ `session.header.cwd` → `process.cwd()` | 取不到 → 空 section |
| 项目根 | `findProjectRoot(cwd)`（向上找 `inkflow.json` / `.git`，§3） | 未命中 → 空 section |
| 四态门禁 | `inspectProject(root)`；只有 `usable` 才注入 | 其余三态 → 空 section（一个字节都不注入） |

`AssembleContext` 的**公开**声明只有 `{ scope?, signal? }`；会话身份 `context.agent` 是运行时实际传入、但没写进类型声明的字段（本机 `dsh-memory-evolve` 与 `dsh-novel-forge` 两个插件的实现都依赖它）。因此本插件把 `context` 当 `unknown` 收窄后逐层可选读取，取不到就退回 `process.cwd()`：宿主哪天改掉这个字段，最坏结果是「某些会话不注入」，不是抛错。

#### 四份材料（六段装配的段；简报里 `outline` / `prevTail` / `world` 也读这四份）

> 注入的段集自 #183 起是简报的九段（`outline → promise → characters → voice → facts → foreshadow → world → prevTail → anchors`，ADR-0022 D2）。下表描述的是**取数**：其中「当前章」「上章结尾」「世界书」三份在简报里分别落到 `outline` / `prevTail` / `world`，而「项目摘要」只存在于六段装配（`buildWritingContext`），**不进简报**——简报的九个 id 里没有 `project`；书级标识与**章级身份**改由简报 **`text` 的第一行**承担（`《书名》· 全书 N 章 / M 万字 · 本章：<标题>（<卷> · seq N · <状态>）`，`WritingBrief.header` / 审计记录的 `header` 字段）：它不是第十段、不入裁剪阶梯、但计入 `tokens`，放不下整行时先丢全书计数与章标题、缩为 `《书名》· 本章：seq N`。
>
> 章级身份取自**本章自己的记录**（索引里的 `chapters` 行；无索引时取章文件 frontmatter），**不依赖大纲节点是否存在**——「先建章、后排细纲」是正常顺序。因此 `outline` 段只装情节点（`### 剧情点` + `大纲 <path>：` + 正文），节点不存在（或正文为空）时该段 `missing: true`，而第一行照样写着第几章；`chapterSeq` 指向还没建的章时第一行写 `本章：（尚未建章）`，不编标题/卷/seq。身份只出现这一处，段里不再重复 `### 当前章`。

| # | 段 | 取数 | 依据 |
|---|---|---|---|
| 1 | 项目摘要 | 书名（`inkflow.json` 的 `title`，缺省目录名）、卷数（`outline_nodes.kind='volume'`）、章数与总字数（`chapters` 行数 / `SUM(word_count)`）——全部来自派生索引 | [data-model](data-model.md) §4 |
| 2 | 当前章 | 六段装配：章号最大的章（`seq` 降序；`seq` 缺省取文件名前导数字）的标题 + `volume`/`seq`/`status`，加上该章大纲正文，一起渲染成 `### 当前章` 块。简报：标题 + `volume`/`seq`/`status` 进**第一行**，大纲正文单独成 `outline` 段（`### 剧情点` + `大纲 <path>：`）。大纲节点的定位是 `kind: chapter` 且 `order` = 章号（见 §3.5），旧书的 `outlines/ch-<seq>.md` / `chapter-<seq>.md`（含不补零）仍兜底 | [conventions](conventions.md) §3.2 / §3.5 |
| 3 | 上一章结尾 | 次大 `seq` 章的正文**最后 300 字**（`config.promptTailChars`；截断标记计入上限，保留结尾而不是开头——「结尾」的价值全在最后几句） | P1 F-P1-06 的「上章结尾」 |
| 4 | 命中的世界书条目 | 以「本章大纲 + 上章结尾」为关键词串，匹配 `world/**` 的 `keywords`；`always: true` 常驻；命中注入 `title` + 正文前 200 字；排序 `always` 降序 → `priority` 降序 → 路径升序 | [conventions](conventions.md) §3.4、[data-model](data-model.md) §2 #9 |

只出现书名与**相对路径**（`outlines/ch-0012.md`、`world/门派/白鹤门.md`），绝不出现项目绝对路径——提示词会进会话日志，日志可能被分享。

#### 预算与裁剪

> 注入的阶梯是简报的那一条（ADR-0022 D2）：`world → facts → foreshadow → prevTail`，`outline` / `promise` / `characters` **永不裁**，裁不动就报 `overBudget`（下面的 L0–L5 是六段装配 `buildWritingContext` 的阶梯，它现在只被测试与对照用例调用）。

预算按**估算 token** 计（默认 1200，`config.promptBudgetTokens`）：CJK 1 字 ≈ 1 token、其余 4 字符 ≈ 1 token【推断，无 tokenizer 依赖】。超预算按固定阶梯退化，**第一个装得下的阶梯胜出**：

| 级 | 丢什么 | 保留 |
|---|---|---|
| L0 | 不丢 | 四段全量 |
| L1 | 项目摘要 | 章 / 尾 / 世界书 |
| L2 | 当前章的大纲正文 | **当前章的标题 + frontmatter 永不丢** |
| L3 | 世界书 | |
| L4 | 上章结尾缩到 120 字 | |
| L5 | 上章结尾 | 当前章（硬地板；只剩它仍超预算就照发并标注） |

**顺序的理由**：上章结尾没有旁路——模型丢了它不能回头读上一章；世界书条目可以按 `path` 再取。所以先丢能再取的世界书，再缩、再丢上章结尾。

裁剪结果写进文本末尾一行 `[trimmed: …]`，并在上章结尾被丢/缩短时附一句「怎么精确找回（读哪个相对路径的尾部）」。**为什么必须让模型看见丢了什么**：不写这件事，模型会把「没注入」读成「本来就没有」，然后凭记忆编，或者整章 `read` 反而把上下文挤爆（`novel-forge` 真机事故同型，见 §9 末行的对照记录）。本版**不用**它那套「衔接保留额」两层预算：本插件只有四段、段内没有可均摊的卡片集合，1200 token 的规模上加保留额是多余机制；P1 F-P1-06 做九段简报时再引入。

#### 降级

- 任何异常（读文件、索引、frontmatter）→ 一行 `log.warn` + 返回 `''`：**提示词绝不影响对话**。
- 全链路同步，不 `await`。索引缺失或 schema 不符时**不重建**（重建是异步的）：项目摘要退化成一行「索引未建立」提示，章节段改用文件名派生——因此**首轮**（索引还没建）也有内容。
- 注册失败（同层已注册，例如组件被装配两次）→ 一行 warn + 跳过，其余能力不受影响。

#### 可观测

`briefFor(root, opts)` 是这一段的唯一取数入口（#183 起走简报；`buildWritingContext(root, opts)` 是同一批段渲染器的六段装配，`tests/prompt.test.js` 拿它与简报逐段对拍等价性）：两者都是纯投影（无缓存，除门禁文档化的 `index/` 自愈外无副作用）。取数规则集中在 `writing-sources.ts` / `brief-sources.ts`（同步、失败即「缺这一段」），装配在 `prompt.ts`，section 回调只做「取 cwd → build → 返回 text」，所以测试直接断言纯函数。`briefFor` 额外带进程内计数（`runs` / `overBudgetRuns` / `last`），由 `inkflow_diagnostics_export` 读走——**注入侧**的裁剪因此可测、可观测，不只是预览侧。

`promise`（承诺书）与 `anchors`（场景锚点）的取数自 #213 起落在**本章大纲节点的两个标签行**（`- [承诺] …` / `- [锚点] …`，见 [S-03 §3.5](conventions.md)）：`brief-sources.ts` 的 `taggedOutlineSegment()` 复用情节点解析器，没有标签即 `missing: true`，不跨章借用、不从角色卡兜底。不在范围内：简报页的编辑能力（这两段由作者在 `outlines/` 里手写，插件只读）。

### 4.8 构建标识与 stale 检测 — `src/host/build-info.ts`

DSH 只在进程启动时加载一次插件的 `lib/`，HMR 不替换已加载插件（§8）。所以进程可能正在执行一份**磁盘上已被覆盖**的代际：`pnpm run build` 改的是文件，不是运行中的代码。此时旧面板会对着完好的书写出「需要初始化」，而「刷新」只是重跑同一份旧代码——**刷新在原理上不可能修复它**。旧代码也无法自报「我是旧的」，所以判据落在能同时看见「进程」和「磁盘」的那一半（Host）。

**两个互相独立的事实**：

| 事实 | 来源 | 语义 |
|---|---|---|
| `build` | 构建期 esbuild `define` 注入 `__INKFLOW_BUILD__ = <git 短 sha>@<ISO>`（两半都注入） | 进程**正在执行**的代际；运行时无法被磁盘改写 |
| `diskBuildTime` | 调用期 `stat` 自身 `lib/index.js` 的 mtime | 磁盘上**最新**的代际；只是提示（git checkout、文件复制、进行中的构建都会动它） |
| `loadedAt` | `Date.now() - process.uptime() * 1000` | 进程启动时刻，比较的基准 |

**判据**（只由 `decideStale` 表述一处）：

```
staleLoadedCode = diskMtime > loadedAt + STALE_TOLERANCE_MS     // 容差 5000 ms
```

| 维度 | 规则 | 理由 |
|---|---|---|
| 单侧 | 只有「磁盘比进程新」为真 | 常见顺序是先构建、后重启；把「磁盘更旧」也当异常会让正常安装常亮 |
| 容差 | 5 s 窗口内不判 stale | 构建与重启交叠时产物可能在进程起来之后才落最后一块，此时进程加载的就是新代码。宁可漏报一次，也不要让用户学会无视警告条 |
| 不可用即不判 | 定位不到自身文件 / stat 失败 / 非 `file:` URL → `diskBuildTime = 'unknown'`、`staleLoadedCode = false`，**不抛** | 这些代码跑在 `/status` 与状态工具路径上：缺一个字段可以，丢面板不可以 |
| 两种安装形态 | `import.meta.url` 是 bundle 自身文件 URL；真实目录安装与 junction 指向开发仓命中同一个文件（Node 解析链接，两种写法同一个 mtime） | 开发与发布用同一条判据 |

**透出面**（同一份 `BuildSummary`：`{version, build, loadedAt, staleLoadedCode, diskBuildTime}`）：

| 位置 | 字段 | 说明 |
|---|---|---|
| `/inkflow/internal/status` | `value.build` | 面板的正常读数 |
| `/inkflow/internal/status` | `error.build` | **门禁拒绝信封也带**：stale 代际正是把可用书报成 `needs-setup` / `needs-repair` 的那一方，警告必须能出现在拒绝屏上 |
| `inkflow_project_status` | `build` | 只作信息字段，**不参与**四态判定与 `missing` 计算 |
| apply 启动日志 | `build <build> loaded at <iso>` | 不开面板也能从日志判断代际；stale 时代替为「磁盘有更新构建 + 重启步骤」一行 |

**面板**（`src/client/index.tsx` 的 `BuildStamp` / `StaleBuildBanner`，纯判定在 `src/client/panel-model.ts`）：页头显示 `build <sha>`；`staleLoadedCode === true` 时在页签行**之上**渲染不可关闭的警告条——磁盘构建时间、DSH 启动时间、`pnpm.cmd run build` 后完全退出重启、以及「刷新不会生效」。「重新检测」重新取 `/status` 并**重算同一判据**，因此既不会也不能清除警告：只有重启让进程比文件新之后它才消失。

**降级**：旧 Host 不带 `build` 字段 → 面板只显示自身 bundle 的 stamp（构建期同样注入），不推断、不警告；`version` 取 `package.json`，调用方传入则以调用方为准（与 `pluginVersion` 同源）；构建时拿不到 git → `unknown@<ISO>`，时间戳仍能区分两代。

## 5. 四个工程决策

### 5.1 零运行时依赖

`package.json` 无 `dependencies`。不 import 任何 `@deepseek-ai/*`，代价是手写结构类型（`src/host/context.ts`、`src/client/context.ts`），收益是 DSH 升级时不碎。

### 5.2 文件即真相，索引可弃

见 ADR-0005。关键纪律：**任何写正文/设定的操作必须落在文件上**；索引只能由重建流程写入，代码里不存在「改索引来改数据」的路径。

### 5.3 单一构建工具链（esbuild）

`lib/index.js` = Host ESM bundle；`lib/client.js` = CJS bundle 外套 `window.__ModuleLoader__.load({id, factory})`。Client 半必须是这个字节形状（React 走注入的 `require`，其余内联），esbuild 的 banner/footer + `format:'cjs'` 正好产出（[ADR-0003](../adrs/0003-build-chain.md)）。

### 5.4 面板通道：私有、按路由声明方法

面板与 Host 之间只有一条**私有内部通道**（[ADR-0008](../adrs/0008-panel-data-channel.md)，书库部分见 [ADR-0010](../adrs/0010-book-hub-entry.md)）：不对外、不版本化、不接受路径参数、逐路由声明方法（读 GET / 写 POST + JSON）。写操作（如"确认并应用一次向导动作"）必须是 POST + `Content-Type: application/json` + 带 loopback `Origin`，并由用户确认后触发（[ADR-0006](../adrs/0006-workspace-contract-v2.md) D3），面板不做只读模式下的自动修复。写入真相仍走工具 → `io.ts`。通道内部分两组路由：**会话路由**（有会话锚点）与**书库路由 `/hub/*`**（无会话锚点），后者不参与下面的会话解析链。

面板侧的数据流（`sessionId` → Host 解析 → 四态 → 投影）：

| 步骤 | 谁做 | 形状 |
|---|---|---|
| 1. 绑定会话 | Client：`setActiveSessionId(sessionId)` | 只一个会话 id |
| 2. 读门禁 | `GET /inkflow/internal/status?sessionId=…` | `usable` → `{ok:true,value:{state,checks,missing,actions,reasons,index,catalog}}`；其余三态 → `{ok:false,error:{code,state,checks,missing,actions,reasons,readOnly,hint}}`；解析不到会话 → `{ok:false,error:{code:'NO_SESSION_CONTEXT',actions}}`，**三种都是 HTTP 200** |
| 3. 读卷章树 | `GET /inkflow/internal/chapters?sessionId=…` | `{total, volumes[{volumeId,dir,title,chapters[]}], looseChapters[], catalogStale}` |
| 4. 读一章（编辑器基线） | `GET /inkflow/internal/chapters/:id?sessionId=…` | `{id,path,title,seq,body,bodyChars,issues,fingerprint}`；`fingerprint` 是下一次保存的 CAS 基线 |
| 5. 保存一章 | `POST /inkflow/internal/chapters/:id?sessionId=…`，body `{title?,body?,status?,expected?}` | 成功 → `{chapter,changed[],fingerprint}`；基线不符 → **409** `{ok:false,error:{code:'FILE_CHANGED',current,changed[]}}`，零写入 |
| 6. 新建 / 移动 / 删除 | `POST /chapters`、`POST /chapters/:id/move`、`DELETE /chapters/:id` | 同 [conventions.md](conventions.md) §6.2 的路由表；四条写路由共用同一套守卫与 CAS |

- **清单只来自 Host**：非 `usable` 时 `missing[]`/`actions[]` 在 `error` 里，`usable` 时在 `value` 里；面板把两种信封折成同一份 `PanelGate`（`src/client/panel-model.ts` 的 `readGate`），不自己补清单、不自己判定状态。
- **脏检查 / 防抖 / 撤销 / 冲突态是纯逻辑**：`src/client/editor-model.ts`（无 React、无 IO），React 只渲染与接键位；自动保存 1500ms 防抖、撤销 500ms 合并、保存成功清栈；**冲突永远要用户显式二选一**（重新载入＝丢弃本地改动 / 仍要保存＝覆盖），面板不静默覆盖外部改动。
- **向导仍只读**：向导按钮只重读 `/status` 的计划，不调 `inkflow_project_init`；项目结构与修复写入只能由用户确认后的工具调用完成。
- Client 侧永不拼 `root`/`path`/`cwd`（`tests/panel-bundle.test.js` 对产物断言这三种查询参数都不存在）。
- **通道有两类锚点**（[ADR-0010](../adrs/0010-book-hub-entry.md) D3/D7）：**有会话锚点**的会话路由（上面这张表 + [conventions.md](conventions.md) §6.2）与**无会话锚点**的书库路由（`/hub/*`：注册表 + 一次性 token + 绝对拒绝集，见 §4.2）。书库面板只调后者：`fetchInternal('/hub/books', { sessionless: true })`，一次打开取一次 + 手动「刷新」，不轮询（每次请求都要对每本书跑一次门禁判定）。


## 6. 模块边界

这张表是「新读者判断某件事归谁管」的入口，所以它由 [scripts/check-module-table.mjs](../../scripts/check-module-table.mjs)（`npm run check:docs` 的一环）**对拍**：`src/host/` 下每个 `.ts` 必须在这里有一行（行内写全 `src/host/<文件>.ts`，只在别人的行里被提到不算），客户端纯模型整组列在 §6.2。新增模块却漏了登记 → 守卫直接红并打印缺失清单。

**工具名也是契约**：一个工具名出现在两处——注册处（`name: 'inkflow_…'`）与所有提到它的地方（工具描述、错误提示、手册）。两边漂移时没有任何东西会失败：模型照着描述去调一个不存在的名字。所以 [scripts/check-tool-names.mjs](../../scripts/check-tool-names.mjs)（同样是 `npm run check:docs` 的一环）双向对拍：`src/` 下的每个 `inkflow_*` 提及都必须解析到一个已注册的工具（`inkflow_*`、`inkflow_outline_*` 这类通配不算名字），且每个已注册工具都必须在 [docs/user-guide.md](../../docs/user-guide.md) 里被点名——手册没提的工具，作者不可能发现。

| 模块 | 只做 | 不做 |
|---|---|---|
| `src/host/index.ts` | 装配、生命周期、日志 | 业务逻辑 |
| `src/host/config.ts` | 插件配置（`dataDir` 缺省 `$DSH_HOME/inkflow`、`serveHttp`） | 作品数据 |
| `src/host/conventions.ts` | **目录/文件约定的唯一常量来源**（九目录 + `index/` + `.gitkeep` + `.gitignore` 必需行） | 任何 IO |
| `src/host/project.ts` | 四态门禁判定、逐项清单（`missing` / `actions`）、`inkflow.json` 读写、路径作用域 | 执行动作、索引 |
| `src/host/workspace.ts` | 向导 plan（只读）/ apply（`confirm`）、只补缺失项、`git init`（唯一 git 写）、失败回滚 | 门禁判定（读 `inspectProject`） |
| `src/host/frontmatter.ts` | 极简 frontmatter 解析（标量/内联数组/块数组/注释） | 完整 YAML |
| `src/host/indexer.ts` | 扫描九目录 → 派生索引 + 不变量校验；`walkProjectFiles` 是**唯一**的项目遍历（建索引与新鲜度共用） | 写真相文件 |
| `src/host/index-build.ts` | 索引重建的原子替换、进程内单飞、`index/.lock` | 解析文件格式 |
| `src/host/index-freshness.ts` | **新鲜度判定**（`checkIndexFreshness`，纯读：一次 readdir+stat 对拍 `files` 表）与**唯一重建触发点**（`ensureIndex`，四态 → 至多一次 `buildIndex`，失败结构化） | 改索引内容、删除索引文件、写项目文件 |
| `src/host/file-cas.ts` | 写入的期望基线：`sha256`/`size`/`mtimeMs`/`absent` 的指纹与比对（`FILE_CHANGED` 的数据面） | 决定是否写（由 chapters/workspace 在写锁内调用）、拼接项目路径 |
| `src/host/search.ts` | 章正文检索（`chapters_fts`）：trigram `MATCH`、1–2 字 `LIKE` 兜底、片段裁剪；**只读**，不建库不修复。另含 **X-16 的单一检索入口** `searchEntries`：章正文（正文 + 标题）＋九个内容目录的设定条目，固定条目形状 `{kind,id,path,title,snippet,offset?,score?}`、分页 `{offset,limit,total}`（`limit` ≤ 100，超出上限按上限截断并 `truncated: true`）、后端字段 `searchBackend`/`degradedReason`；索引缺失或异版只得到 `INDEX_UNAVAILABLE`，绝不 500 | 写盘、门禁判定（由工具层先过门禁）、决定是否重建（归 `index-freshness.ts`／工具层） |
| `src/host/snippet.ts` | **片段裁剪的唯一实现**：`locateHit`（首个命中位置）、`makeSnippet`（半径内上下文，空白折叠）、`sliceContext`（已知位置的上下文，供替换预览的「前/后」）。叶模块（无 import）：`search.ts` 与 `domains/query.ts` 都要用它，而前者经 `indexer.ts` 绕回域注册表，不能成为共享路径 | 读文件、决定命中（只渲染调用方给的文本） |
| `src/host/replace.ts` | **检索替换的唯一实现**（X-17）：预览与执行共用 `planReplace`（同一份计数 + 同一份新文本 → 预览=执行）；逐章保留原行尾/BOM（`text-style.ts` + `io.ts` 唯一写入口）；`expected`（chapterId + count）对不上的章 `PREVIEW_STALE` 跳过并报告；执行前开 `openBackup(root,'replace')` 并封 `sealed:false`，任一步失败即从备份包回滚。章列表读 catalog（文件的投影）而非索引：预览在没有索引时也必须正确 | 决定是否重建索引（工具层写后 `ensureIndex`）、替换设定条目的结构化正文（需按类写入器） |
| `src/host/search-channel.ts` | 检索与替换的通道半：`GET /search` 的 X-16 信封（读前 `ensureIndex`，索引不可用时降级为元数据扫描并带 `degradedReason`）、`GET /replace`（预览，**零写盘**，回传 `expected`）、`POST /replace/apply`（要 `confirm: true` + `expected`）、失败码到 HTTP 状态的映射 | 检索/替换规则、投影字段的所有权（归 `search.ts`/`replace.ts`）、HTTP 加固（归 `routes.ts`） |
| `src/host/io.ts` | **唯一写入口**：路径解析、原子写、单项目写锁 | 业务规则、索引 |
| `src/host/state.ts` | 插件自身状态（`lastProjectRoot`，仅展示），原子写 | 作品数据、项目解析来源 |
| `src/host/probe.ts` | 可选 Host 服务的结构化探测（形状校验 + 降级）、错误文本 | 任何业务规则 |
| `src/host/skills.ts` | 5 个写作技能的读取与校验、按 cwd 门禁的 provider、注册与降级 | 写作品数据、生成正文 |
| `src/host/writing-context.ts` | 写作上下文的**纯投影**：段渲染（六段装配 `buildWritingContext()` + #43 的**九段简报**装配 `buildWritingBrief()`——#183 起注入走简报，六段保留为对照与等价性基准；两者共用 `writing-context-render.ts` 的同一份段渲染器）、单段上限、预算阶梯、裁剪标记、九段顺序常量 `BRIEF_SEGMENT_ORDER` 与裁剪常量 `BRIEF_TRIM_ORDER`；另含**扩展段注册表** `EXTRA_SEGMENTS`（roadmap X-13：域只声明 `{name,label,capRatio,build}`，顺序与裁剪阶梯归本模块；`build()` 的入参带 `capChars = floor(capRatio × budgetTokens)`，段自己按整行装填——计数与装填必须由一处算，否则 header 会写着 N 条而实际只渲染出几行） | 会话/服务/日志、写任何作品数据 |
| `src/host/writing-sources.ts` | 写作上下文的取数：索引查询 + 文件读取（章节对/大纲/上章正文/世界书），全部同步且失败即缺段 | 渲染、预算、Host 装配 |
| `src/host/prompt.ts` | `systemPrompt` section 的注册：会话目录解析、text 回调、降级与幂等；text 回调调 `briefFor()`（#183：注入的就是简报，与预览/审计同一次计算） | 取数规则、渲染规则 |
| `src/host/preset.ts` | 写作 preset 的声明（人设 + 工具行）、注册与降级 | 其他插件的业务逻辑、技能正文 |
| `src/host/tools.ts` | **工具表的装配处**：`ToolDeps` 的对外形状、`buildTools()` 的注册顺序（内置各域 → repair / settings / extract / semantic / etl / review / proposal / jobs / export / series → 域模块，顺序由 `tests/domain-registry.test.js` 逐名钉住）与 `TOOL_OUTPUT_SCHEMA` 的再导出。单个工具的定义在 `src/host/tools/<域>-tools.ts` | 任何工具 schema 与拒绝码的定义（归各域工具文件）、直接扫目录（走 indexer/project/workspace） |
| `src/host/tools/shared.ts` | 工具面共用的**形状**（不含规则）：`ToolDeps` / `Json`、`{ok, …}` 信封（`SUCCESS_SCHEMA` / `text` / `asRecord`）、`PROJECT_ROOT_PARAM`、CAS 写入基线（`EXPECTED_PARAM` / `expectedParam`）、索引重建失败的两种渲染（`indexBuildFailure` / `ensureFailure`）、`commitLine` | 任何领域判定或拒绝码语义（每个域的拒绝渲染留在该域自己的文件里）、读文件、写盘 |
| `src/host/tools/project-tools.ts` | 四个项目级工具，两个聚合：`projectTools()` = `inkflow_project_status` / `inkflow_index_rebuild`，`projectWizardTools()` = `inkflow_project_plan`（只读）/ `inkflow_project_init`（`confirm`）。分成两个聚合是因为注册顺序把向导那对放在检索组之后 | 门禁判定本体（`project.ts`）、向导动作（`workspace.ts`）、索引重建（`index-build.ts`） |
| `src/host/tools/chapter-tools.ts` | 读侧 `chapterReadTools()` = `inkflow_chapter_list`；写侧 `chapterTools()` = `inkflow_volume_create` / `_rename`、`inkflow_chapter_create` / `_write` / `_move` / `_delete`（门禁 → `chapters.ts` → 回报 catalog 与索引级联），以及拒绝渲染 `renderChapterFailure` | 卷章 CRUD 规则与写锁（`chapters.ts`）、catalog 投影（`catalog.ts`）、门禁判定本体 |
| `src/host/tools/search-tools.ts` | 三个检索工具：`inkflow_chapter_search`、`inkflow_search`（X-16 单一入口，语义召回排在关键词命中之后）、`inkflow_search_replace`（X-17 预览=执行）；三者共用 `ensureIndex` 这一个重建触发点 | 检索与替换规则（`search.ts` / `replace.ts`）、语义召回（`ovk-search.ts`）、决定是否重建（`index-freshness.ts`） |
| `src/host/tools/audit-tools.ts` | `inkflow_project_audit`（#33）：只读体检，`export: true` 时才写 `.inkflow/audit/`；配套 `renderAuditFailure` | 体检规则与落盘（`audit.ts`）、重建索引 |
| `src/host/tools/gate-tools.ts` | `inkflow_gate_check`（#44）：八项门禁跑一章 + 结论文件；`write: false` 只算不写 | 八条规则（`gate-rules.ts` / `gate-fragment.ts` / `gate-proofread.ts` / `gate-degeneration.ts`）、词表（`gate-vocabulary.ts`）、任何模型调用 |
| `src/host/tools/shared-library-tools.ts` | 共享库三工具（#40）：`inkflow_shared_list` / `_copy` / `_update`；`list` 不要求书可用（库不属于任何项目），书可用时同一答案附副本与 stale 列表 | 写共享库或 `index.json`、双向同步（ADR-0007 C6）、副本语义（`shared-copy.ts`） |
| `src/host/tools/import-tools.ts` | `inkflow_library_import`（#37）：`plan` 只读、`apply` 要 `confirm` + `planToken`；配套 `renderImportFailure` / `importFailure` | 分章与编码判定（`import.ts`）、写入与整批回滚（`import-write.ts`） |
| `src/host/chapters.ts` | 卷章 CRUD 的规则：id/uuid、seq/slug 分配、改卷名级联、移卷、删章、失败回滚、catalog 与索引重建、写锁内的期望基线 CAS（`FILE_CHANGED`） | 门禁判定（由 tools 先做）、直接拼项目路径（经 io.ts）、派生索引的 schema |
| `src/host/internal.ts` | 私有通道的**投影层**：会话 → 工作区/项目解析、四态门禁的通道版拒绝清单、`/status`/`/chapters`/`/chapters/:id`/`/search` 四个投影；`/chapters` 与 `/search` 先 `ensureIndex`，失败降级并报告 `indexError`（`/search` 自 #39 起是 X-16 的单一入口，索引不可用时降级为章元数据扫描并带 `degradedReason`；检索替换的三条路由在 `search-channel.ts`） | HTTP 加固、写作品文件、自己决定是否重建 |
| `src/host/findings.ts` | **「问题」的唯一形状**（roadmap X-14）：`Finding` / `FindingLocator` / 五个报告分组 / `FINDING_CODES` 目录 / `compareFindings` 的稳定排序 | 任何检查实现、任何 IO（#33 产出、#36 消费） |
| `src/host/calendar-book.ts` | **哪张历法表属于这本书**（#48，ADR-0025 D1/D3）：`readBookCalendar(root)` 从 `inkflow.json` 的 `calendar` 读表（缺省 → `DEFAULT_CALENDAR`，**存在但非法 → 结构化拒绝，绝不回退**）、`writeBookCalendar(root, spec)` 校验后临时文件+rename 原子改写（`resolveWriteTarget` 有意不管根级元数据，与 `hub-wizard`/`shared-copy` 同路）、`defaultEraOf(spec)`（裸日期读在**最新**纪元）、`calendarFingerprint(root)`（索引 `meta` 里存的那枚指纹，供新鲜度对拍） | 任何换算（`calendar.ts`）、索引列的写入（timeline 域）、私有落点 |
| `src/host/calendar.ts` | **历法换算的唯一实现**（#180，roadmap X-28）：可配置历法表（每纪元 `epochOffsetDays` + 月长 + 三种闰规则 `none`/`every N`/`gregorian`）、`toAbsolute({era,y,m,d})` 与 `fromAbsolute(days)` 双向换算（A→B→A 误差 0，含闰日与跨纪元）、`calendarDaysBetween`、`monthLength`/`isLeapYear`/`eraAt`/`findEra`、`validateCalendarSpec` 与 `DEFAULT_CALENDAR`；结果是 `{ok,value}`/`{ok,error}`，**永不抛**。理由写在文件头（不另立 ADR：X-28 已是决策，编号不预占） | 任何 IO、任何 `Date`/时钟、解析 `timeline/*.md`（文件与字段归 timeline 域）；它只回答「这一天是第几天」 |
| `src/host/audit.ts` | **一致性体检**（#33，X-14）：五类发现聚合成一份 `Finding[]`（只聚合 / 分组 / 排序 / 给人话 hint，判定一律调域模块）＋ Markdown 报告渲染 ＋ 唯一写动作（`exportAuditReport` → `.inkflow/audit/`） | 判任何不变量（那是 `scanProject` / `validateCatalog` / 域模块的事）、重建索引、在只读路径写盘 |
| `src/host/audit-channel.ts` | 体检的通道半：`GET /audit` 的投影（分组计数 + 前 N 条 + 定位与地址）与 `POST /audit/export` 的信封、`CONFIRM_REQUIRED` 闸门、失败码到 HTTP 状态的映射 | 体检规则、Markdown 排版、写盘（一律调 `audit.ts` 与 `io.ts`） |
| `src/host/gate.ts` | **质量门禁**（#44，ADR-0022 D4、X-24/X-26）：一次 `walkProjectFiles` + 读本章正文/角色卡/账本 → 交给 `gate-rules.ts` 的 `GATE_CHECKS` 跑八项 → 逐项应用按书口径的豁免 → 排序、计数、序列化与落盘。落点是 `.inkflow/audit/gate-<chapterId>.json`（不是 `index/`，X-25），内容**无时间戳、无随机 id、无绝对路径、键序固定**，同章同文件两次运行字节相同（`chapterDigest` 记录本章正文、被读设定文件与白名单文件的摘要，用来判断"这是最新一次吗"）；`record: false` 只算不写，供 `GET /gate` 这条只读路由使用 | 自己判任何一条规则（在 `gate-rules.ts`）、读 `inkflow.json` 的 `gate` 段与白名单文件（归 `gate-config.ts`）、序列化与计数（归 `gate-report.ts`）、调模型或出站请求（X-26）、重建索引、写内容目录 |
| `src/host/gate-config.ts` | **按书口径的读取端**（ADR-0028 D1/D2/D5）：读 `inkflow.json` 的 `gate` 段（键集合只有 `GateThresholds`；未知键 / 非法值 / 区间颠倒一律 `GATE_BOOK_CONFIG_INVALID`；段或键缺省即取 `GATE_DEFAULTS`——默认值不复制进书里）与 `library/gate-whitelist.txt`（不存在 = 零豁免，越界 = `GATE_WHITELIST_INVALID`）。自己读 meta 而不加宽 `ProjectMeta`：那份结构是四态门禁的输入、人人都在用，而 `gate` 段只有质量门禁读 | 判任何一条规则、决定豁免语义（归 `gate-waiver.ts`）、把拒绝降级成默认值、写任何文件 |
| `src/host/gate-waiver.ts` | **字面豁免的语义**（ADR-0028 D3–D5）：解析白名单（一行一条片段、`#` 注释、BOM/CRLF 容忍、单条 40 字与 30 条两个上限）、`fold()`（NFKC + 小写折叠的比对形式）、`WAIVABLE_CODES`（七个句级码的闭集）与 `waiveFindings()`（只对 finding 自己那一行、只对闭集、命中即移除并记一条 `GateWaiverHit`） | 读文件（归 `gate-config.ts`）、判任何一条规则、把两个上限做成可配 |
| `src/host/gate-report.ts` | **结论的形状与字节**（ADR-0022 D4，从 `gate.ts` 拆出以守住 600 行）：`GateReport` / `GateCounts` / `GateCheckSummary` 类型、`countsOf()`、`gateFindingRecord()`、`renderGateFile()`（键序即契约；`schemaVersion` 2 起含 `waivers`）、`gateWire()`（工具回执与 `GET /gate` 同一份）、`gateFileName()` / `gateFilePath()`（落 `.inkflow/audit/`） | 判任何一条规则、读文件、决定豁免（豁免由 `gate.ts` 在跑完规则之后应用） |
| `src/host/gate-vocabulary.ts` | **门禁的词表**：八个 `check` id 与顺序、中文标签、`GATE_CODES`（每码一行：check / severity / hint）、阈值类型与 `GATE_DEFAULTS`、**退化检测的 `DEGENERATION`**（#212）与**太碎的 `FRAGMENT`**（#214：短句连发 / 无连接词 / 超长段的阈值与连接词表）两张固定判据表（含 ADR-0027 D2/D5 的出处与「自标」标定说明；有意不进 `GateThresholds`——它们是代码里的固定判据，不是随判决落盘的可配参数）、规则读的输入形状（`GateChapter` / `GateRosterEntry` / `GateFact` / `GateInput`）、`gateFinding()`（`group` 与 `fixable` 从 `findings.ts` 取，不造第二份意见）。拆分理由：词表是 `gate.ts`、工具/路由与各条规则多方共用，与规则同文件就会出现第二份定义 | 任何规则实现、任何 IO、新造问题形状（X-24）、把 `fixable` 说成 `true` |
| `src/host/gate-rules.ts` | **前七项里的六项判定**：字数 / 章末钩子 / 去 AI 味（六维：句长、破折号省略号、排比、解释性旁白、修饰密度、段尾套路）/ 一致性（pov、账本取值失效）/ 敏感自查 / 平台规则（残留、引流）。全部是正则 + 静态词表 + 算术阈值；`GATE_CHECKS` 是八项的固定顺序表（机械校对那条从 `gate-proofread.ts` 引入，退化检测从 `gate-degeneration.ts` 引入，太碎三码从 `gate-fragment.ts` 并入 `aiFlavor` 这一行——项数仍是八，`GATE_CHECK_IDS` 的顺序是已发布的契约） | 任何 IO、任何模型调用、词表定义（在 `gate-vocabulary.ts`） |
| `src/host/gate-fragment.ts` | **去 AI 味的「太碎」三码**（#214 B 块）：`GATE_AI_STUTTER`（连续 `stutterRun` 句都 ≤ `stutterSentenceMax` 可见字，**引号外**才算——短句台词是角色在说话）、`GATE_AI_LOW_LINK`（连接词密度低于 `lowLinkPer1000`，照 `GATE_DENSITY_FLOOR` 只在长章上判）、`GATE_AI_LONG_PARA`（单段可见字 > `longParaChars`）。阈值与词表在 `gate-vocabulary.ts` 的 `FRAGMENT`，标定语料是本仓自己的正文样本（出处见文件头与 `FRAGMENT` 注释，ADR-0027 D2/D5） | 任何 IO、任何模型调用、自己改正文、把 `fixable` 说成 `true`；也不判「长而匀」（那是六维的事） |
| `src/host/gate-degeneration.ts` | **第 8 项退化检测**（#212）：复读（紧邻整行 / 整段 / 同句连发）、截断（末段不以句末标点结束）、占位语与元话语、工程词泄漏四类判定；全部在**遮掉成对引号后**的叙述上判（引号内是角色台词，引号外才是模型在说话）。阈值与词表在 `gate-vocabulary.ts` 的 `DEGENERATION`，出处与改写点写在文件头（ADR-0027 D2/D3/D5） | 任何 IO、任何模型调用、自己改正文、把 `fixable` 说成 `true`；也不判「写得好不好」（那归前七项） |
| `src/host/gate-proofread.ts` | **第 7 项机械校对**：标点配对、半角标点混入、全角字母数字、重复字词（功能词 + 不可叠用的副词闭集）、别名词表外的近似名（只认 ≥3 字名字，限制写在文件头）、称谓混用、数字与单位。零模型、确定性；**只判不改**（改写动作归 `repair.ts`） | 任何 IO、任何模型调用、自己改正文、把 `fixable` 说成 `true` |
| `src/host/gate-text.ts` | 门禁的纯文本助手（ADR-0022 D4 的确定性前提）：`lineOf` / `paragraphsOf` / `sentencesOf` / `finalClause`（保留终止符，钩子规则要用）、`occurrences` / `per1000` / `exceedsAllowance`（一章至少允许一次）、`GATE_DENSITY_FLOOR`、定位器构造 | 读文件、读时钟、判任何一项 |
| `src/client/gate.tsx` | 「门禁」页签（#44 + X-12 的一行一页）：选章 → 八项计数 → 每条 finding 的严重级/码/地址/说什么/怎么办 → 按严重级过滤；只调 `GET /chapters` 与 `GET /gate`，不写任何文件（结论文件由工具落盘） | 判任何一项、拼第二套规则、写盘 |
| `src/client/purge-card.tsx` | 回收区卡（#199）：两个页签共用的**同一份**渲染（条目行 + 「还原」），空且无错时不渲染；还原与失败的文案由 `purge-model.ts` 给 | 取数（页签各自 `GET /purged`）、判谁能被还原（归 Host） |
| `src/client/proposal-closed.tsx` | 提案页的「已结束」折叠组（#199）：折叠行 + 展开后的逐条行（与首屏 `open` 用**同一个** `ProposalListItem`）+ 每条的「清理」两段式按钮；页签把 fold 与选中的状态传进来 | 决定哪条已结束（归 `proposal-model.ts` 的 `splitProposals`/`cleanable`）、发请求 |
| `src/host/private-state.ts` | 私有状态目录 `.inkflow/` 的三个共享助手（ADR-0012）：相对路径拼装、`isPrivateStatePath`、`ensurePrivateStateIgnored`（append-only 补 ignore 行，失败返回而不抛） | 决定什么时候删/备份（归 #35/#36）、清单格式 |
| `src/host/private-manifest.ts` | 私有状态**清单的唯一实现**（ADR-0012 / ADR-0026）：`schemaVersion` 校验、坏文件拒绝而不重建、逐行 `parse` 决定「这一行还能用吗」、io 失败码透传；回收站（`.inkflow/trash/index.json`）与私有状态回收区（`.inkflow/purged/index.json`）共用它，各带自己的 `parse` 与拒绝码 | 决定某条能不能还原（归各自领域：回收站拒 `.inkflow/` 源，回收区只认 `review/`/`proposals/`）、移动任何文件 |
| `src/host/private-purge.ts` | **私有状态回收区的形状**（#199，ADR-0026）：落点 `.inkflow/purged/<.inkflow 相对路径>`、清单行与 `digestOfFiles` 摘要、`listPurged` 读回、`restoreTargetOf`（还原目标只允许 `.inkflow/{review,proposals}`，`..`/绝对路径/其它子目录一律拒）、`privateRelativeOf`/`projectRelativeOf`（清单里存的状态相对路径 ⇄ 项目相对路径） | 任何移动/写入（归 `private-purge-actions.ts`）、读某条提案/某次运行自己的元数据（归 `proposal.ts`/`review-store.ts`）、通道信封（归 `private-purge-channel.ts`） |
| `src/host/private-purge-actions.ts` | **回收区的三个动作**（#199）：`cleanUp`（`confirm: true` 闸门 + 按 kind 分派）、`cleanUpReviewRun`（`<chapterId>/<runId>`，路径由 `reviewRunPath` 算）、`cleanUpProposal`（`open` 一律 `PURGE_OPEN_PROPOSAL`，整目录搬）、`restorePurged`（逐字节写回、目标已存在即零写入）；顺序固定为「副本逐字节校验 → 清单 → `.gitignore` → 删源 → `.inkflow/audit/purge-<stamp>.md`」 | 判断「这条能不能清理」（归 `proposal.ts` 的状态与 `review-store.ts` 的路径）、决定还原目标（归 `restoreTargetOf`）、放宽 `trash.ts` 对 `.inkflow/` 源的禁令 |
| `src/host/private-purge-channel.ts` | 回收区的通道半：`GET /purged`、`POST /purged/clean`、`POST /purged/restore` 的信封、body 字段白名单、拒绝码到 HTTP 状态的映射（`PURGE_OPEN_PROPOSAL`/已存在 → 409，找不到 → 404） | 清单与文件的移动（归 `private-purge*.ts`）、HTTP 加固（归 `routes.ts`） |
| `src/host/private-purge-routes.ts` | 回收区的三条**路由描述符**（`PRIVATE_PURGE_ROUTES`）：写在 `routes.ts` 之外，因为该文件正卡在记录预算上（`check-guards` 第 10 条）；分派与加固仍由 `routes.ts` 的同一张表统一执行 | 任何分派/加固逻辑（那张表只有一份）、业务规则 |
| `src/host/zip.ts` | **store-only ZIP 容器**（[ADR-0018](../adrs/0018-settings-backup-diagnostics.md) D3）：`writeZip`（本地头 + 中央目录 + EOCD，method 0，自算 CRC-32，MS-DOS 时间戳）、`readZip`（**读中央目录**而不是扫本地头，逐条校验 CRC 与长度）、导出的 `crc32`；拒绝 method≠0、zip64、密文包、`..`/绝对/反斜杠/空段名（防解压逃逸）与重名条目 | 压缩与解压（那是被 D3 否掉的方向）、决定备份包含哪些文件（归 #42）、写盘 |
| `src/host/hub.ts` | **书库投影**（无会话）：`workspaceRegistry.list()` → 书单行（四态门禁 + `dirStatus` + 只读 catalog 计数 + `notABook`）、realpath 去重、并发 4 / 单本 2 s→`timeout` / 预算 3 s→`truncated` / 200 行→`capped`、注册表缺失 → `HUB_UNAVAILABLE`；对外只暴露"列注册表"这一个只读入口（`listRegisteredWorkspaces`），供向导线与共享库写通道解析锚点 | 接受任何路径、写盘、重建索引或 catalog、自动注册/移除工作区 |
| `src/host/shared-copy.ts` | **共享库取用方向的唯一实现**（#40、ADR-0007 C2–C6）：`copySharedEntry`（快照 + `origin{projectId,entryId,contentHash}`，冲突零写入）、`updateSharedEntry`（逐条更新：先备份包再写）、`buildSharedCopies`（副本 + stale 列表，只读）、`ensureProjectId`（可选 `inkflow.json.projectId`）、`applyOriginBlock`（`origin` 块的插入/替换） | 认路径/会话/HTTP、写共享库与 `index.json`、自动更新、双向同步 |
| `src/host/shared-channel.ts` | 共享库的三条 hub 路由信封：`book` 必须命中 `workspaceRegistry`（realpath 比较）→ 四态门禁 → 再调域；body 白名单 `SHARED_COPY_BODY_FIELDS` / `SHARED_UPDATE_BODY_FIELDS`；拒绝码 → HTTP 状态 | 判定副本语义、写 `inkflow.json` 字段、接受 `root`/`path` |
| `src/host/series.ts` | **系列同步的唯一实现**（#49、ADR-0007 C2/C5、X-17）：`buildSeriesPlan` 一次算出四类判定（`create`/`update`/`conflict`/`unchanged`，差异按读者意义、复用 `extract-compare.ts` 的 `compareDocument`）且**只读**；`applySeriesSync` 重算同一份计划、按「条目 id + 动作」与 `expected` 做集合比较（漂移的行 `SERIES_PLAN_STALE` 跳过）、**每个冲突必须带裁决**否则 `SERIES_CONFLICT_UNRESOLVED` 且零写入、写入前开 `.inkflow/backup/<stamp>/` 包（`kind: 'shared'`）、跑完把运行记录落 `.inkflow/audit/series-<stamp>.json`（带时间戳、不记正文） | 认路径/会话/HTTP、写共享库、自动同步、双向同步、把计划或记录写进 `index/` |
| `src/host/series-channel.ts` | 系列同步的两条 hub 路由信封：复用 #40 的 `registeredBook` / `usableBook`（锚点规则与四态门禁只有一份）→ 再调域；body 白名单 `SERIES_APPLY_BODY_FIELDS`；series 拒绝码 → HTTP 状态（`SERIES_CONFLICT_UNRESOLVED` 为 409，`SHARED_UNAVAILABLE` 为 200 + `ok:false`） | 判定四类语义、重写锚点规则、接受 `root`/`path` |
| `src/host/series-tools.ts` | 系列同步的工具面（#49）：`inkflow_series_plan`（只读）与 `inkflow_series_apply`（`confirm` + `expected` + `decisions`）。只做转发与渲染，所以工具面永远不会比引擎更宽松 | 另一套计划计算、绕过裁决守卫、写任何文件 |
| `src/host/timeline-channel.ts` | 时间线页签的通道半：`GET /timeline`（两条轴 + 待确认区 + 冲突 + 本书历法，读前 `ensureIndex`，失败按码映射）与 `POST /timeline/upsert`（`confirm` 闸门、拒绝码 → HTTP 状态）；`TIMELINE_QUERY` / `TIMELINE_UPSERT_BODY_FIELDS` 白名单与两条**路由描述符** `TIMELINE_ROUTES` 也在这里（本文件即 `routes.ts` 的行预算出口）。载荷与写入**不在这里实现**：线上形状是 `domains/timeline-view.ts`（与 `inkflow_timeline_list` 同一函数）、写链路是 `domains/timeline-write.ts`（与 `inkflow_timeline_upsert` 同一函数），所以两面对拍是构造上成立而不是靠纪律 | 判时间线的规则（`domains/timeline-plan.ts`）、写盘（`io.ts`）、HTTP 加固（`routes.ts` 的分派层统一做）、自己造第二份线形状或第二套拒绝码 |
| `src/host/foreshadow-channel.ts` | 伏笔页签的写半边：唯一一条 `POST /foreshadow/advance`（把一条已在书里的伏笔推进到下一个合法状态），body 白名单 `FORESHADOW_ADVANCE_BODY_FIELDS` 与路由描述符 `FORESHADOW_ROUTES` 也在这里（本文件是 `routes.ts` 的行预算出口）。判定**不在这里**：`upsertForeshadow`（`domains/foreshadowing-write.ts`，与 `inkflow_foreshadow_upsert` 同一个函数）跑状态机与 `confirm` 闸门，所以拒绝码逐字相同；条目按文件定位（`scanProject`）、标题取自文件，请求里不带 `title`/`id`/`path`，因此"推进"不会顺手改名；slug 不在书里答 `FORESHADOW_NOT_FOUND`（工具是 upsert，会建） | 写状态机或第二套拒绝码、写盘（`io.ts`）、HTTP 加固（`routes.ts` 分派层）、新建条目或改正文（仍在工具上） |
| `src/host/settings.ts` | **插件级设置的唯一读写口**（[ADR-0018](../adrs/0018-settings-backup-diagnostics.md) D1/D2）：`$DSH_HOME/inkflow/settings.json`（`config.ts` 的 `dataDir`）、`schemaVersion: 1`、六个字段的白名单；读语义集中在一处（文件缺失=默认、字段缺失=该字段默认、越界夹取、类型错回退、坏文件=默认 + 一条 `warn`，**任何情况都不让插件起不来**）、无进程内缓存（用时即读）、写为合并 + 临时文件 rename、文件的 `schemaVersion` 比本版新则**拒绝覆盖**（否则会静默丢掉更新版本写的字段）。配套：`settings-tools.ts`（`inkflow_settings_get`/`_update`）与 `hub-settings.ts` 的设置两路由 | 写任何书内文件（D1：设置与书不镜像）、读作品数据、缓存 |
| `src/host/diagnostics.ts` | **白名单诊断包**（D5，roadmap X-22）：版本与构建戳、`engines`、平台/架构/Node/ICU、索引元信息（`user_version`/文件数/实体数/最近重建/新鲜度/各域计数）、工具清单（名字 + surface hash）、脱敏后的设置、`logs`（如实写"不可用"：宿主不向插件暴露日志，去尾随宿主的日志会把别的插件的输出一起带出去）；`exportDiagnostics` 落到 `dataDir/diagnostics/<stamp>.json`——选 JSON 而非 Markdown，是因为测试要断言"那段正文不在这里"（字符串搜索对 JSON 精确），且两次导出可直接 diff；另有文档级后置脱敏（`~/…`、`<book>`、形似凭据的串） | 读任何正文/设定/`.env`/`.credentials.yaml`/OVK 私有 peer、在任何输出里留下绝对路径、写任何书内文件 |
| `src/host/backup-zip.ts` | **本地备份包**（D3/D4/D6）：用 `zip.ts` 写 store-only ZIP 到 `dataDir/backups/<bookSlug>-<stamp>.zip`（stamp 为 UTC，同秒加 `-2` 后缀）、内容集合 = 九内容目录 + `inkflow.json` + `.gitignore`，排除 `index/`、`.git/`、`.inkflow/`（`includeTrash` 可选把 `trash/` 带上）、保留 `backupKeep` 份并删最旧（只认自己写的文件名，手放的 ZIP 不动）、`planRestore` 只比较不写盘、`restoreBookBackup` 用计划里的逐文件摘要做 CAS（改过的文件报 `BACKUP_CONFLICT` 且不覆盖，其余照常写回，写后逐字节校验）再 `ensureIndex(rebuild)`。配套：`settings-tools.ts`（`inkflow_backup_create`/`_restore`）、`hub-settings.ts` 的备份三路由、`client/settings-model.ts` + `settings.tsx`（书库里的「设置」页） | 压缩/解压（D3 否掉的方向）、决定备份何时做（由工具/面板触发）、把备份写进书（`index/` 或 `.inkflow/`） |
| `src/host/import.ts` | **旧稿导入的分析半**（#37，X-17）：编码三档回落（UTF-8 严格 → UTF-16 BOM → `TextDecoder('gbk')`）、原文行尾记忆、分章识别（强标记 / `一、` / 短行独占，各带最低证据数）、段落与字数计数；**全是纯函数**（`Buffer` 进，结构出） | 任何 IO、写盘、备份、门禁 |
| `src/host/import-write.ts` | **旧稿导入的写入半**：`planImport`（零写盘：读源 + 读 catalog 投影算序号；同名原件按「相同则复用、不同则排 -2/-3」选名）与 `applyImport`（`confirm` + `planToken` 闸门、逐章走 `createChapter`/`writeChapter`、`library/` 原件副本、一次 `openBackup('import')` 封包、失败整批 `rollbackBackup`、末尾一次索引重建） | 解析规则（在 `import.ts`）、HTTP 信封（在 `import-channel.ts`）、自己拼章文件路径（一律经 `chapters.ts` → `io.ts`） |
| `src/host/import-channel.ts` | 导入的通道半：`POST /library/import` 的 `plan`/`apply` 两个动作、字段校验、失败码到 HTTP 状态的映射；`sourcePath` 为什么走写路由的守卫（POST + 必须有 loopback `Origin`）写在这一层的文件头 | 导入规则、写盘、会话解析 |
| `src/host/extract.ts` | **候选队列的唯一读写口**（#38，[ADR-0017](../adrs/0017-extraction-by-session-model.md) D2/D3）：`.inkflow/candidates/<stamp>-<kind>.json`（`{schemaVersion, submittedAt, source.chapters[], proposals[]}`）、`ex-<8 位十六进制>` id 由插件发放（模型回传已有 id 即「更新」，条数不变、字段变）、`evidence` 必填并**当场**校验（`path#L<n>` 的行必须存在，章 id 必须在 catalog 里）、`fields` 按 [data-model](data-model.md) §3 的字段字典逐键判类型与枚举（未知键直接拒：候选是机器写的，未知键是生产者 bug，不是作者的补充）、状态机 `proposed → accepted \| rejected`、`purge` 只删已处理；proposal 可带可选的 `willFail`（硬冲突）与 `duplicate`（同身份异内容），都由工具层调 `judgeCandidate()` 得到，队列只负责存；同身份**同内容**的候选在提交时就被丢掉（回答里列 `skipped`） | 写任何内容目录文件（只有 `extract-accept.ts` 能）、调模型、重建索引、自己判实体冲突（归 `judgeCandidate()`） |
| `src/host/extract-compare.ts` | **「内容一致」怎么算**（#178, ADR-0021）：只比候选自己提供的字段（没提的字段不能算「不同」）、忽略 `id` 与文件簿记键、正文按 CRLF/行尾空白/首尾空行归一、列表按集合比；答案带「哪些字段不同」供面板显示 | 判定身份（归 `judgeCandidate()`）、写盘、知道候选的 evidence/id |
| `src/host/extract-accept.ts` | **候选变实体文件的唯一路径**（ADR-0017 D4/D5）：`judgeCandidate()`（**唯一判定**，accept 与 propose 的预检共用，三种结局：创建 / 同身份同内容跳过 / 同身份异内容等作者点头；所以面板说的话与采纳做的事不可能漂）；`overwrite` 路径先开 `replace` 备份包（X-17）并拿 **propose 时的 digest** 做 CAS→ `materializeCandidate()` 用**该域自己的渲染器**把 `fields` 渲染成一份文档 → `domain.parseFile()` → `applyCandidate()` → `domain.validate({candidate})` → `io.ts` 写锁内原子写；冲突报该类领域已有的码（`CHARACTER_NAME_DUPLICATE` / `DUPLICATE_ID` / `WORLD_ROOT_MULTIPLE` / `OUTLINE_NO_OVERALL`…）且零写盘；采纳**从不覆盖**既有实体 | 第二套字段渲染、自己拼 `characters/`… 之类的路径（路径由域渲染器与 `defaultRelationPath` 决定）、HTTP |
| `src/host/extract-tools.ts` | 五个工具（`inkflow_extract_propose` / `_list` / `_accept` / `_reject` / `_purge`）：kind 是**提交级**参数（一份提交一类实体）、`accept`/`purge` 要 `confirm: true`、`reject` 回报 `contentFilesWritten: 0`、`accept` 之后一次 `ensureIndex` | 判定字段/证据（归 `extract.ts`）、写实体文件（归 `extract-accept.ts`） |
| `src/host/extract-channel.ts` | 候选页的四条通道：`GET /candidates`（按 kind/status 筛、分页、计数覆盖整个队列而不是本页、`evidence` 与 `locator` **一起**下发使面板不必解析字符串）、`POST /candidates/{accept,reject,purge}` 与失败码到 HTTP 状态的映射；只读路由**不** `ensureIndex`（索引缺失时正是该能审候选的时候） | 队列规则、写盘、HTTP 加固（归 `routes.ts`） |
| `src/client/extract.tsx` + `extract-model.ts` | 「候选」页签（X-20 唯一新增的页签）与它的纯视图模型：kind/status 筛选、字段摘要、证据文案与跳转目标、置信度/状态文案、逐条**两段式**采纳与一次点击拒绝、批量只对未审行生效、半成功批次两种结果都摆在屏幕上 | React 之外的 IO、拼路径/路由（只走 `fetchInternal`/`writeInternal`，证据跳转交给工作台） |
| `src/client/library-import.tsx` + `library-import-model.ts` | 设定库「资料」分组里的导入对话框（三步：选文件 → 预览 → 确认）与它的纯视图模型（草案校验、请求体、预览文案、结果文案、拒绝码 → 人话） | 读文件（Client 无文件 API：路径由作者填、Host 读）、判分章规则、写任何文件 |
| `src/host/hub-wizard.ts` | **新开书向导**（ADR-0010 D4/D6）：`plan`（锚点三级判定 → 路径闸门 → 只读 plan → 签发 token）与 `apply`（消耗 token → 摘要比对 → `applyWorkspace` → `workspaceRegistry.create`）、一次性 `planToken` 存储（TTL 5 分钟、可注入时钟）、`nextStep` 降级 A 文案 | 自己写文件（一律走 `workspace.ts`）、接受 `apply` 的路径、发 token 给已注册目录、commit/配远端 |
| `src/host/impact.ts` | **改设定前的影响清单 + 改名计划**（#34，[ADR-0014](../adrs/0014-entity-id-pinning.md)）：`(kind, id)`／标题模糊匹配 → 实体文件（只读扫描，索引不可用时也能解析）；五处影响面（提及章读 `entity_mentions`、关系读 `relations`、时间线/账本/伏笔因无投影直接读文件）＋总计数；改名计划（目标路径、要钉的 id、冲突判定） | 写任何文件、重建索引、决定是否执行（执行由 `impact-write.ts` 与面板的确认动作承担） |
| `src/host/impact-write.ts` | **改名的唯一写实现**：写锁内「先写新文件（旧 id 钉进 frontmatter `id`）→ 再删旧文件」、`TARGET_EXISTS`/`FILE_CHANGED`/失败回滚、写后 `ensureIndex(rebuild)` 并回报 `id` 不变 / `path` 更新 / 提及条数不变 | 生成影响清单、重写引用方字段（X-15：一个都不改）、直接拼项目路径（经 `io.ts`） |
| `src/host/routes.ts` | 私有内部通道的路由表（逐路由声明方法）、loopback 与参数加固、JSON 信封、body 字段白名单；另含**书库路由组** `/hub/*` 的独立分派（无会话；写路由要求 `Origin` 与 `Host` 同源） | 业务规则、写真相文件、解析会话 |
| `src/host/route-types.ts` | 通道的**路由契约**（`HttpMethod` / `RouteInput` / `RouteReply` / `InternalRoute` / `KNOWN_METHODS`），被 `routes.ts` 与自带路由描述符的通道模块共用 | 任何分派、加固或业务（纯类型 + 一个常量，运行时不可见） |
| `src/client/index.tsx` | 两处入口的注册（`conversation.view` 工作台 + `sidebar.panellist`/`main` 书库）、工作台骨架（四态徽章 / 章节树 / 编辑器 / 向导清单）、页表 `pageRenderers`（roadmap X-12：非 `chapters` 页一行一页，JSX 里不再有页分支）、`fetchInternal` 调用 | 业务规则、文件 IO、拼路径参数 |
| `src/client/hub.tsx` | 书库视图：书卡片（标题 / `~/…` 路径 / 徽标 / 卷章数 / 标记）、空态、加载与错误态、手动刷新、「新开书」向导入口（`HubWizard`）、「共享内容」页入口（关闭时回到书单，并把**书单**交给它当复制目标）、`apply` 成功后**就地合并**书单行 | 写动作本身、轮询、拼路径参数 |
| `src/client/hub-shared.tsx` | 共享内容页（#87 只读 + #40 取用）：库条目按 kind 分组、目标书选择（只列 `usable`）、复制/引用两段式确认（先臂上再「确认复制」）、本书副本列表与逐条更新（确认后带 `confirm: true`）、`selfContained` 与 `seriesId` 说明；只走 `fetchInternal`/`writeInternal` 的 `sessionless` 调用 | 判副本语义、拼 `root`/`path` 参数、轮询 |
| `src/client/hub-shared-model.ts` | 共享内容页的纯视图模型：两种信封折叠（库 / 副本）、`state` 文案、`copyNeedsUpdate`（只为 `stale` 给按钮）、`copyModes`（引用只给 `library/`）、`copyTargets`（只列 `usable` 书）、`selfContainedNote`、拒绝码 → 人话 | React、网络、IO |
| `src/client/hub-wizard.tsx` | 新开书向导的视图：`pickDirectory` → plan → 确认卡（`willCreate[]` / `notices[]` / 书名 / `outsideRegistry` 二次确认）→ apply → 降级 A 卡片；目录选择器不可用时退化为手输绝对路径 | 拼第二套规则、跳转/建会话、轮询 |
| `src/client/hub-wizard-model.ts` | 向导的纯视图模型：`plan` 的四态折叠（ready / anchor-required / blocked / refused）、`willCreate` 文案、书名建议与必填判定、降级 A 文案、`mergeHubRow`（就地更新或追加） | React、网络、IO |
| `src/client/panel-model.ts` | 纯视图模型：四态徽标文案、`readGate`（两种信封折一份）、卷章树与扁平化、空态判定、`root` 相对化、页签表、预览裁剪 | React、网络、IO |
| `src/client/search-model.ts` | 检索框的纯视图模型（#39，X-16/X-20）：请求路径与「全部类型」开关的换算（`kinds=chapters` vs 省略）、X-16 信封的防御式读取、命中行文案（`章正文 · 标题`）、点击去向（章正文 → 本页编辑器；设定条目 → 设定库）、摘要与降级文案 | React、网络、IO |
| `src/client/hub-model.ts` | 书库的纯视图模型：徽标（含 `timeout`）、`~/…` 相对化、卷章数文案、`missing-dir`/`notABook`/重复注册标记、`HUB_UNAVAILABLE` 文案、信封折叠 | React、网络、IO |
| `src/client/layout-model.ts` | 面板滚动 box 的纯几何（§4.3.1）：可用底边规则、`Math.floor` 定高、CSS 变量与兜底、两列共享的样式常量 | React、DOM、配色 |
| `src/client/layout.ts` | 高度实测的 DOM 读取与 React 接线：`useScrollBox()`（每次渲染复测 + `ResizeObserver` + `window.resize`），把高度写成 `--inkflow-body-h`；量不到返回空样式走 CSS 兜底 | 业务规则、网络、写文件 |
| `src/client/internal.ts` | 面板通道的 Client 半：`sessionId` 注入、`{ok,value}` 解包、`NO_SESSION_CONTEXT` 本地短路；`sessionless: true` 只放行 `/hub/*` | 拼路径参数、文件 IO |
| `src/client/audit-model.ts` | 体检页的纯视图模型：信封折叠、分组与严重级文案、`定位` 的人话标签（`.` = 整本书）、`jumpTargetOf`（能不能跳、跳到哪）、导出与失败文案 | React、网络、IO |
| `src/client/audit.tsx` | 体检页：五组计数 + 逐条 finding（code / 严重级 / 地址 / 说明 / 处理建议）+ 导出按钮（标签里写明落点） | 判问题是否成立、判严重级（都来自 Host）、写报告 |
| `src/host/context.ts` | **宿主表面的手写结构类型**（`ctx.tools`/`webServer`/`slots`/`skills`/`agentPresets`/`systemPrompt` 等、`JsonSchemaNode`、`ToolDefinition`、`ToolRunContext`），按 DSH 0.2.1-rc.2 的实测契约抄录；DSH 升级改形状时重查契约再改这里 | 任何运行时实现、业务规则；不 import `@deepseek-ai/*`（[硬约束 H1](../constitution/hard-constraints.md)） |
| `src/host/text-style.ts` | 稿件**行尾/BOM 风格**的检测与还原（`detectTextStyle` / `applyTextStyle`）：首个终止符决定风格，新建文件按 LF 无 BOM | 读写文件（字节进出归 `io.ts` 与调用方）、解析 frontmatter |
| `src/host/path-rules.ts` | 提议文件名/段的**纯规则**（`checkSegment`：Windows 保留名 `CON`/`COM1`…、非法字符、长度上限；`isSingleLine`）；`io.ts` 的写门与 `impact.ts` 的只读预览共用同一份判定，所以预览说能执行就等于写门放行 | 任何 `fs`/项目/写锁；路径解析与拼装 |
| `src/host/session-cwd.ts` | 会话的有效工作目录：`workingDirectory` 服务可用就用它，缺失/失败降级 `process.cwd()`，供域模块与内置工具用同一套解析。`sessionCwd()` 只给目录，`sessionCwdWithSource()` 额外给 `source: 'session' \| 'process'`——降级路径与真实会话目录**不可互换**（宿主进程里 `process.cwd()` 是 DSH 安装目录），要「拒绝而不是猜」的调用方靠它区分 | 项目解析与门禁、写任何状态；不 import 内置工具面（那会成运行时环） |
| `src/host/domains/outline-target.ts` | **大纲工具认哪一本书**（`resolveTarget`）：显式 `projectRoot` 先 `resolve`，然后**自比着**过作用域闸门（用自己当锚点，所以卷根、家目录、含家目录的目录与安装目录内照样拒），否则从**会话**目录向上找最近的书；禁止路径清单跑在 `inspectProject()` **之前**（那次调用会建 `index/`，事后判作用域就已经写进一个即将被拒的目录），四态门禁最后。两种锚点拒绝都带 `cwd` / `searchedFrom` / `cwdSource`：会话目录退化到 `process.cwd()` 时答 `PROJECT_ROOT_UNKNOWN` 而**不搜**——猜这个锚点正是它解决的缺陷 | 拼项目路径与写盘（归工具侧）、门禁判定本体（`project.ts`）、`sessionCwd()` 的实现（`session-cwd.ts`）、大纲文档的解析与不变量（`domains/outline-model.ts`） |
| `src/host/domains/outline-tools.ts` | `inkflow_outline_*` 的工具面：三个工具（`tree` / `upsert` / `move`）的 schema、渲染与 `confirm` 闸门。读侧直接解析 `outlines/` 目录（`indexer.ts` 反向 import 本域，走索引就是运行期环），写侧经 `io.ts` 写锁内的期望基线 CAS | **书锚点解析**（归 `outline-target.ts`：这里只调 `resolveTarget()`，不自己解析 cwd、不自己比门禁）、大纲文档解析与不变量（归 `domains/outline-model.ts` 的 `parseOutlineDocument` / `validateOutlineScan`）、`index/` 写入 |
| `src/host/build-info.ts` | **构建代次判定**（#88）：`build`（构建期 `__INKFLOW_BUILD__`）与 `diskBuildTime`（本进程加载的 `lib/index.js` mtime）两侧事实、单向容差的 `staleLoadedCode`、`summarizeBuild` 文案 | 构建本身（归 `scripts/build.mjs`）、HMR、缓存 mtime；mtime 只当提示，不据此改任何行为 |
| `src/host/catalog.ts` | 卷章 catalog 的**结构投影**（ADR-0006 D6）：`readCatalog`（只读：缺失/手改/陈旧只报 `catalogStale` 并在内存里从 `.md` 重投影）、`rebuildCatalog`（写锁内先卷后顶层，半途失败让顶层保持陈旧）、`validateCatalog`（报漂移，不拦不修） | 正文真相（`.md` 是真相）、自动修复、索引 schema；读路径绝不写盘 |
| `src/host/encoding.ts` | 手写元文件（`inkflow.json`）的**乱码识别**（#89）：按「读成 GBK 才会出现」的窄字集表判定（语料实测 0 误报），`looksLikeGbkMojibake` / `describeEncodingSuspicion` 供门禁与文档提示 | 修复或转换编码、嗅探旧稿导入的编码（那在 `import.ts`）、抛错 |
| `src/host/library-view.ts` | 设定库的**面板投影**（X-7/X-8）：8 个 kind（`CONTENT_DIRS` 去掉 `chapters`）的树 + 实体条目；读前 `ensureIndex`（可重建缓存的唯一例外）；索引缺席/异版答 `indexAvailable: false` 而不是"这本书没有角色" | 写任何文件、决定是否重建索引；不拥有通道入口（`internal.ts` 只 re-export） |
| `src/host/library-request.ts` | 设定库保存请求的**取值规则**：`null` 删一个键、`[]` 删一个列表（两者归并成同一套 `remove`）、嵌套 mapping 是 400 而不是静默重写、`expected` 在本路由必填 | 找文件/写文件（归 `library-write.ts`）、HTTP 信封与状态码 |
| `src/host/library-write.ts` | 设定库保存的**唯一写实现**：id 从文件解析（不依赖索引缓存）、只替换作者编辑过的字段、其余字节原样、经 `io.ts` 原子写 + CAS 基线；标题改动**不**改名（文件名就是无 `id:` 文件的实体 id） | 章的写入规则（标题→改名、卷分配、catalog 重建归 `chapters.ts`）、请求取值规则（`library-request.ts`）、直接拼项目路径 |
| `src/host/trash.ts` | **回收站域**（#35，X-9/X-10，ADR-0012）：删除前先复制到 `.inkflow/trash/<原相对路径>` 并逐字节复核（复核失败则原件不动）、manifest 记身份/来源/时间/摘要/原因、`restoreTrash` 绝不覆盖、还原后顺手修书内目录投影（判定与重建归 `trash-catalog.ts`）、`purgeTrash` 要 `confirm: true`、非 UTF-8 源文件拒绝删除 | 自动清理或按数量轮转（回收站永不自动裁剪）、批量的 `before/after` 日志包（归 `backup.ts`）、通道信封 |
| `src/host/trash-catalog.ts` | 还原的**catalog 半**：`isProjectedChapterPath` 用与 `catalog.ts` 扫描同一口径判定「这次还原是否落在目录投影的扫描范围内」（`chapters/` 之下、`.md` 结尾、无点开头路径段），`repairCatalogAfterRestore` 只对章文件重建 `chapters/index.json` 与各卷 `index.json` 并给出 `{ rebuilt, error? }` | 回收站格式与不变量（归 `trash.ts`）、catalog 的读写与重投影（归 `catalog.ts`）、为无关路径制造写盘或把「重建失败」升级成「还原失败」 |
| `src/host/trash-channel.ts` | 回收站的通道半：`GET /trash`、`POST /trash/restore`、`POST /trash/purge` 的请求规则与 `{ok,value|error}` 信封；条目只按 `id` 寻址、缺 `id` 是 400（不回落成批量动作）、purge 缺 `confirm` 是 `CONFIRM_REQUIRED` | 回收站格式与不变量（归 `trash.ts`）、HTTP 加固（归 `routes.ts`）、接受路径参数 |
| `src/host/backup.ts` | 批量改动前的**回滚日志包**（#36，X-9/X-10，ADR-0012）：改动前先落 manifest（`sealed:false`）+ 逐文件 `before/after` 摘要与字节副本、`stageFile` 读回复核、`rollback` 覆盖前核对当前摘要（改过的文件报冲突且不覆盖、其余照常写回） | 用户可见的回收站列表（X-10 归 `trash.ts`）、ZIP 备份包（归 `backup-zip.ts`）、决定何时开包（归调用方） |
| `src/host/migrate.ts` | 六目录旧书 → 九目录 + `index/` 的**加法式迁移**（#36）：不搬家不改名不重写内容，可能变的只有 `inkflow.json`（`schemaVersion`）与 `.gitignore`；`planMigration` 与 `applyMigration` 的清单按**集合**对拍、写前快照、回滚靠日志包 | 自动回滚（向导式内存撤销在这里不成立）、改任何内容文件、改索引内容；`index/` 由 `io.ts` 自己建时视为已采纳 |
| `src/host/repair.ts` | 修复三段（#36，X-14）：`detectFindings` / `planRepair` 只读（不建 `index/`、不追加 `.gitignore`），`applyRepair` 是唯一写者且要 `confirm: true`；只**重塑**既有检查的发现（`scanProject`/`validateCatalog`）并每条给一个动作，修完重跑同一批检查证明修到了 | 重新实现任何检查、重写正文/标题/id、对 `fixable: false` 的 code 编造数据；批量修复前先进 `backup.ts` 的快照 |
| `src/host/repair-report.ts` | 维护运行的 **Markdown 报告**渲染（`.inkflow/audit/`，ADR-0012 #6）：计划 / 跳过 / 回滚的排版，两个调用方（`repair.ts`/`migrate.ts`）共用一份 | 任何业务判断（报告只渲染调用方已决定的事）、改正文、决定落点或文件名 |
| `src/host/repair-tools.ts` | 维护工具面（#36）：`inkflow_project_repair`（detect/preview/fix，`select` 可只修一条）与 `inkflow_project_migrate`（plan/apply/rollback），都三态 + `confirm`；**`needs-repair` 放行**（要修的书正是这种），`needs-setup`/`needs-newer-plugin` 拒绝 | 修复/迁移实现（归 `repair.ts`/`migrate.ts`）、门禁判定本体（镜像 `resolveProject` 只多一次放行） |
| `src/host/hub-shared.ts` | 共享库的**无会话只读投影**（#87/#40，ADR-0010 D5）：manifest 与目录路径集合一致时用 `indexSource:'index'`，否则内存扫描重算（有界：条目上限 / 时间预算 / 哈希字节上限，超限答 `truncated`）；条目路径必须留在自己的 kind 目录内 | 写回 `shared/index.json`（派生物，写侧不在这里）、解析共享库根（根来自 `settings.ts` 的 `sharedRootOf`）、接受任何路径参数、把设置里的拒绝原因再判一次（随选项传入） |
| `src/host/hub-settings.ts` | 设置页的 Host 半（#42，ADR-0018）：设置读写两路由（无锚点，不碰书）+ 诊断预览/导出 + 备份三路由；`book` 是注册表 id 或目录名（两个命中即 `BOOK_AMBIGUOUS`，路径不匹配永不降级成名字匹配）；对外路径一律 `maskPath` 脱敏 | 判定备份/恢复语义（归 `backup-zip.ts`）、接受目录路径、轮询、写任何书内文件 |
| `src/host/settings-tools.ts` | 插件自身状态的工具面（#42）：`inkflow_settings_get`/`_update`（只碰 `settings.json`、**不过门禁**——书坏了也要能看设置）、`inkflow_diagnostics_export`（要 `confirm`，书不可用也能导）、`inkflow_backup_create`/`_restore`（要 `usable` 书，恢复默认先 `dryRun`）；输出里给出 `sharedRoot` 的**生效根**与未生效原因 | 章节/索引工具（归 `tools.ts`）、设置的读语义（归 `settings.ts`）、备份包格式（归 `backup-zip.ts`） |

| `src/host/ovk.ts` | **语义后端的边界与传输**（#41，[ADR-0009](../adrs/0009-ovk-semantic-search.md) P1–P3/P5、[ADR-0020](../adrs/0020-ovk-endpoint-from-settings.md) 决策 + S1）：peer 只读解析（`config.local.json` 优先 → `config.json`；`version` 必须 1、≤64 KiB、`peer.id` 只 ASCII；每种失败各有 `problem`，**不代写、不派生模板**）；连接**只从插件设置**来（`semanticSearch` + `semanticEndpoint` + `semanticApiKey`），**不读** OVK 的机器配置；一个 `fetch` 客户端（每请求 `AbortController` 超时；401/403 → `unauthorized`，超时 → `timeout`，非 JSON 的 2xx → `malformed`，连不上 → `unreachable`，**从不抛**）；`/health`、`/api/v1/search/find`、`/api/v1/content/write`（`replace` 同路径覆盖）与 `DELETE /api/v1/fs`（**只允许 purge 调**）；块地址 `viking://resources/inkflow/<projectId>/chapters/<chapterId>/<index>.md`、`contentHash`、按段聚合并带重叠的分块（块大小/重叠是【推断】常量）、块正文与 tombstone 文本及 OVK 检索 tags | 做检索/排序（那是 OVK 的事）、读或写 `ov.conf`/`ovcli.conf`、在任何**写作或删章**路径上调用物理删除、读作品正文（只接收调用方给的文本） |
| `src/host/ovk-ledger.ts` | **每本书的块账本**（ADR-0020 S2）：`dataDir/semantic/<bookSlug>.json`（`schemaVersion: 1`，原子替换写）记录每章 `{path, seq, title, contentHash, blocks[{index,uri,contentHash,charStart,charEnd}], deleted, updatedAt}` 与最近一次重建统计；`projectIdFor`（`inkflow.json.projectId` → 否则一次性派生 `book-<hash12>` 并固定）；章列表读取（`chapterSources` 走 `indexer.ts` 的 `listAllChapters`：全量无上限，与 `countChapters` 同一来源——页上限 500 只约束 `listChapters`，首建阈值 200 章的书不能被它截断）；`planRebuild`（**纯比较**：`new`/`changed`/`unchanged`/墓碑/`unreadable`，块数与字节的预估也从这里出；**读不到正文的章不是墓碑**——它仍在索引的章列表里，被单列为 `unreadable` 交给调用方记入 stale 待下次重试，否则一次临时读失败就会把活着的章覆盖成墓碑（#207））；`tombstonedUrisOf`（purge 的清单来源） | 发 HTTP、写 OVK、判门禁；把「已删章」当可推导的事实（章文件已不在，状态必须在账本里） |
| `src/host/ovk-queue.ts` | **按章重建作业**（P5/P6/P10）：读章正文（一次读取同时算 `contentHash` 与分块；读失败**重试一次**，仍失败则计入 stale）→ `replace` 同路径覆盖写块 → 每章写完即落账本（中断可续）→ 失败按「可重试 / 不可重试」分别处理（401 不重试）→ 没写完的与**读不到正文的**都进 `staleChapters`（后者也拦住「无需重建」的提前返回：读不到就不是「已同步」）；队列**按书串行**、请求**去抖合并**；`runRebuild` / `planOnly`（估算章数 / 块数 / 字节 / 摘要调用次数） | 物理删除（tombstone 用覆盖实现，P6）、跨书并发轰炸、决定是否要 `confirm`（阈值判定归 `ovk-status.ts` 与工具层） |
| `src/host/ovk-search.ts` | **接进 X-16 的那一层**（P7/P8）：`diagnoseSemantic` 按「用户能修的顺序」判可用性（`disabled` → `no-endpoint` → `no-peer` → 健康探测的 `unreachable`/`unauthorized`/`timeout`，词表固定）；`searchWithSemantic` = 先跑关键词入口，可用时再召回，把 `uri` 经账本定位成 `{chapterId, 字符区间}` 并**回文件读正文**裁片段（OVK 的 `abstract` 只当线索、绝不当正文），语义命中排在前面并按章去重；**任何失败都只降级不抛**（`searchBackend: 'fts5'` + `degradedReason`） | 建向量 / 做排序、猜章节号（账本里没有的 URI 记 `staleIndex` 而不猜）、写盘 |
| `src/host/ovk-status.ts` | **三个语义动作的唯一实现**（工具与面板共用）：`semanticStatusOf`（设置 + peer + 可用性 + 账本计数 + 队列状态 + 阈值）、`estimateRebuild`（含 `requiresConfirm`：>200 章或 >5 MB）、`rebuildNow`（走队列）、`purgePlanOf` / `purgeApply`（逐条删、**首条失败即停**、只摘掉真正删掉的条目） | 会话 / 书锚点解析（那两个调用方各做各的）、HTTP 细节、工具 schema |
| `src/host/ovk-tools.ts` | 语义三工具：`inkflow_semantic_status`（只读、无 `confirm`）、`inkflow_semantic_rebuild`（先估值、超阈值要 `confirm`）、`inkflow_semantic_purge`（**唯一会物理删除**、先列清单再 `confirm`、首条失败即停并报位置） | 动作实现（在 `ovk-status.ts`）、直连 OVK、读作品正文以外的内容 |
| `src/host/ovk-hub.ts` | 设置页「语义检索」块的三条 hub 路由（`GET /hub/semantic`、`POST /hub/semantic/rebuild`、`POST /hub/semantic/purge`）：书锚点走 `resolveHubBook`（注册表 id / 已注册路径 / 目录名，**不接受任意路径**），先把索引刷新鲜再估值，动作一律调 `ovk-status.ts` | 在请求里携带端点或密钥（ADR-0020 决策：连接只来自设置文件）、自己再实现一遍重建 / 清理 |
| `src/host/writing-context-render.ts` | 两套装配共用的**段渲染器**（#43，[ADR-0022](../adrs/0022-writing-context-gate-findings.md) D1/D2）：`### 项目` / `### 当前章` / `### 上一章结尾` / `### 世界书` 四个块的文字、简报的第一行（`renderBriefHeader`：`《书名》· 全书 N 章 / M 万字 · 本章：<标题>（<卷> · seq N · <状态>）`，章名未建时写 `（尚未建章）`，放不下时缩为 `《书名》· 本章：seq N`）、`outline` 段的 `### 剧情点`（`renderOutlineSegment`，与六段装配的 `### 当前章` 共用同一段 `大纲 <path>：` 渲染）、`[trimmed: …]` 标记、`MAX_OUTLINE_CHARS` 与两个裁剪方向（尾段留尾、其余留头）；六段装配与简报的九段调同一份，所以同一份材料在两处不可能渲染成两种文字——`chapter` 块与 `outline` 段共用 `大纲 <path>：` + 正文这一段渲染，差别只在段头与「身份归第一行」，等价性用例逐字节对拍的就是这个交集 | 决定要渲染哪些段、预算与裁剪顺序（归 `writing-context.ts`）、任何 IO |
| `src/host/brief-sources.ts` | 简报 `characters` / `voice` 两段的**来源**（#43）：从 `characters` + `character_states` 取「本章大纲 + 上章结尾」里点名的人物卡（姓名/别名 ≥2 字、`firstAppearance` 不晚于本章），按「角色 · 本章状态」与 `voice`（语言基因）整行装填到 `capChars`；无索引/无命中 → `undefined`（简报记 `missing`），有来源但装不下一整行 → `{ text: '', truncated: true }` | 段顺序、预算与裁剪阶梯（归 `writing-context.ts`）、写入人物卡、拿 `entity_mentions` 当来源（那是「已存在章」的提及，而本章还没有正文） |
| `src/host/brief.ts` | 简报的**审计、注入入口与两个通道回复**（#43，ADR-0022 D1/D4、[ADR-0023](../adrs/0023-proposal-job-private-placement.md)）：`briefFor`（唯一装配入口 + 进程内超预算计数；#183 起 `prompt.ts` 也调它，所以注入、预览、审计是同一份）、`briefAuditRecord`/`serializeBriefAudit`（确定性：无时钟、无随机 id、无绝对路径，字段顺序即构造顺序）、`writeBriefAudit`（落 `.inkflow/audit/brief-<chapterId>.json`，`sha256` 从磁盘回读）、`GET /brief` 与 `POST /brief/audit`（要 `confirm: true`；审计与预览**取同一组寻址与预算参数**，章解析只有 `addressChapter()` 一处，章不存在即 `404 CHAPTER_NOT_FOUND` + `nothingWritten`） | 装配规则（归 `writing-context.ts`）、第二次装配（预览与审计必须是同一份）、把段正文写进审计文件 |
| `src/host/etl-source.ts` | 旧 InkFlow 库的**只读取数**（#51）：`readOnly` 打开 `.db`，按 `PRAGMA table_info` **只投影该文件真正有的列**（52 次 `ensure_*` 的历史意味着老库缺列，缺列不该让迁移器拒绝最老的书），把 13 张内容表读成 `LegacyBook`；工程按 `uuid / 名字 / 序号` 解析，缺省选内容最多的那个 | 写库、建表、判迁移规则（归 `etl-plan.ts`）、碰书里的任何文件 |
| `src/host/etl-plan.ts` | 旧行 → 九目录的**纯映射**（#51，X-29）：13 类各落到哪、卷 id 与目录重建、章号（`keep` 保原号含断层 / `compact` 显式重排）、`(table,id)` 幂等键与 id 钉住旧 uuid（ADR-0014）、`planToken` 与条目集合；每类给 `mapped / dropped（新模型无落点）/ lost（该落没落）` 三档与 ≤1% / 0.5% 结论；文档一律走**该域现有渲染器**（`renderCharacterCard` / `renderWorldFile` / `renderOutlineDocument` / `renderForeshadowDocument` / `renderTimelineDocument` / `renderRelationFile` / `renderPlotPoints`） | 读写磁盘、取写锁、建索引；不发明回收章、历法日期或 dangling 关系的端点 |
| `src/host/etl.ts` | 迁移的**执行与撤销**（#51，X-29/X-30）：`planEtl` 零写盘、`applyEtl` 复用同一次计算 → 暂存到 `.inkflow/backup/<stamp>/staging/` → **逐文件 `rename`**（按批取写锁，默认 25 个/批，批次间放开）→ 合并写 `.inkflow/backup/etl-idmap.json` → 封包 → `rebuildCatalog` + `buildIndex` + `detectFindings` 报告；`rollbackEtl` 用 `backup.ts` 清单删本轮新建的文件、恢复改过的文件、清暂存、删本轮建的空目录；`commitSuggestion` 只回字符串，**从不跑 git** | 自己的备份格式（复用 `backup.ts`）、覆盖已有内容、整段持锁、自动提交 |
| `src/host/etl-tools.ts` | 迁移工具面（#51）：`inkflow_etl_plan`（只读：13 类表 + 断层 + 裁决清单 + `planToken`）与 `inkflow_etl_apply`（`apply` 需 `confirm` + `planToken`，`rollback` 需 `confirm`），两个都走 `resolveProject` 的四态门禁 | 映射与执行实现（归 `etl-plan.ts` / `etl.ts`）、门禁判定本体、接受第三个入口 |
| `src/host/review.ts` | **审稿 DAG 的编排与对外回执**（#46，ADR-0022 D3、X-24/X-26）：`runReview` 一次读章 → 把每条意见按 `dimension` 路由 → 只跑 `dimensions` 点名的节点（没点名的记 `skipped`，抛错/拒绝的记 `failed` 而其余四维照常完成）→ 规范排序 → 落记录。三条对外回执也在这里：`buildReviewContext`（给模型的带段号/偏移上下文文本与定位协议）、`buildReviewList`（面板 `GET /review`：章 + 该章全部运行 + 选中那次的完整记录，404 话术在这一层）、`runReview` 本身；`record: false` 让只读通道算结果而不写盘 | 维度与节点定义（归 `review-nodes.ts`）、定位与证据窗口（归 `review-locate.ts`）、记录文件与它的 wire（归 `review-store.ts`）、生成任何意见（插件零模型调用，X-26）、自己的审美阈值表（机械判定归 #44 门禁）、写内容目录或 `index/` |
| `src/host/review-compare.ts` | **模型横评表**（#46）：从同一章的运行记录算出 `(运行 × 维度) + 每运行一行合计` 的表——列集固定（`REVIEW_COMPARE_COLUMNS`），模型自评**原样抄**、意见数 / 可定位率 / 密度 / 严重级计数按定义算；`—`（`null`）表示无从相除；`comparable` 说清是否真有 ≥2 个模型；`renderCompareMarkdown` 出可粘贴的 Markdown。`buildReviewCompare` 是同一条计算的只读通道投影。**表头的章身份（`chapterId`/`chapterTitle`/`wordCount`）只有一个来源：`compareChapterIdentity()`**——优先取路由解析出的那一章，只有拿不到解析结果时才回落最新记录；因此「章解析成功但还没有任何审稿运行」仍回报该章的 id / 标题 / 字数（`rows: []` 照旧），`note` 说明这一章还没跑过 | 打分（模型自评是模型给的，插件不改写、不评判）、读正文重判意见、写盘、自己解析章（章解析归 `review.ts` 的 `buildReviewContext`） |
| `src/host/review-locate.ts` | **定位与证据链**（#46）：`readChapter` 把一章读成 `ReviewChapter`（正文 + 非空行段块 + frontmatter 行数）；`locateOpinion` 按 `quote` → `paragraph`+`offset` → `offset` → `line` 逐个核对原文，记下真正生效的提示来源（`source`）与窗口前后文。两处判定写在这里：同一句出现多次算**有歧义**（要求补位置）而不是取第一个，引用对不上时**退化到位置提示**而不是整条丢弃 | 意见该不该存在、落哪一维（归 `review-nodes.ts`）、写记录（归 `review-store.ts`）、判定文风好坏、任何模型调用 |
| `src/host/review-nodes.ts` | **五维定义与节点表**（#46）：`REVIEW_DIMENSIONS` 与每维 spec（标签 / 目录码 / finding group / 打印给模型的任务书）、`REVIEW_NODES` 五个互相独立的节点（各读本章，结构/人物两维另读 `characters/`、`facts/`）产出 anchors + 意见、`checkOpinion` 校验维度/文本/严重级（`severity` 只认 warning / info：审美判断永不是阻断项，ADR-0015 D2） | 判定好坏（机械阈值归 #44 七项门禁，这里只交数字）、把提示换算成偏移与前后文（归 `review-locate.ts`）、编排与落盘（归 `review.ts` / `review-store.ts`）、任何模型调用 |
| `src/host/review-store.ts` | **运行记录的磁盘契约**（#46，ADR-0023）：文件路径与 run id、`chapterDigest` 配方（本章 + `characters/` + `facts/`，排序后 sha256 —— 「这次运行是不是针对我眼前的文本」是关于字节的事实）、意见的规范顺序（`sortOpinions`：维度 → 偏移 → 文本，两次运行不得重排）、写入（`recordRun` + `renderReviewRunFile`）、读回（`listReviewRuns` 与防御式 reader：schema 版本不符只拒收该文件、手改坏的记录计进 `skippedFiles`）、以及两块投影（`reviewRunSummary` 一行、`reviewRunWire` 一次运行且 opinions 截断而计数覆盖全部） | 定位意见（归 `review-locate.ts`）、决定要不要写（归 `review.ts`）、横评表（归 `review-compare.ts`）、重建索引或写 `index/`（记录不是缓存，ADR-0022 D4.5） |
| `src/host/review-tools.ts` | 审稿工具面（#46）：`inkflow_review_run`（收模型写好的意见 → 定位/证据/落记录，`opinions` 必填）、`inkflow_review_context`（**只读**，返回带段号偏移的上下文文本与定位协议）、`inkflow_review_compare`（读记录出横评表）；三个都走 `resolveProject` 的四态门禁 | DAG 与横评的实现（归 `review.ts` / `review-compare.ts`）、门禁判定本体、任何模型调用或出站请求 |
| `src/host/proposal-diff.ts` | **行级 diff 的唯一实现**（#45，X-26）：patience 锚点（两侧各自只出现一次的行 + 下一侧索引的最长递增子序列）、`splitLines`/`joinLines`/`diffLines`/`applyHunks`；按行切而不是按字符切（中文按字符切会把词切成两半）；没有唯一锚点的区域塌成一段整体 `replace`，诚实降级 | 任何 IO、时钟、随机数；提案的落盘与决定（归 `proposal.ts`） |
| `src/host/proposal.ts` | **提案的磁盘形状与只读口**（#45，[ADR-0023](../adrs/0023-proposal-job-private-placement.md) D5）：`.inkflow/proposals/<proposalId>/{meta.json,hunks/<n>.json}` 的形状、逐字段校验（字段值非法即整份拒绝）、`readProposal` / `listProposals`、id 与路径拼装、`countsOf` 的单一汇总口径；只读 + 形状，一次内容写入都不做 | 三个会改东西的动作（归 `proposal-actions.ts` / `proposal-apply.ts`）、章节写入（归 `chapters.ts`）、索引表/列 |
| `src/host/proposal-actions.ts` | **提案的两个记账动作**（#45）：`createProposal`（把会话模型已写好的修订正文按行切成段，只写提案目录，回答里 `contentFilesWritten: 0`；修订正文与正文一致回 `PROPOSAL_EMPTY`、整份文档回 `PROPOSAL_BODY_REQUIRED`）、`decideProposal`（逐段裁决，**决定时刻**取章节指纹当 CAS 基线 —— ADR-0021 的教训；基线不符即 `FILE_CHANGED` 且一段裁决都不记） | 任何正文写入（这一层没有章节写入器）、调模型、备份包（归 `proposal-apply.ts`） |
| `src/host/proposal-apply.ts` | **提案唯一的写入路径**（#45）：`applyProposal`（`confirm` + 无待定段 + 有已接受段 + 与决定时刻基线相符 → 先开 `replace` 备份包并封 `sealed:false` → 走 `chapters.ts` 的写链（写锁、原子替换、文件自身行尾/BOM，ADR-0016）→ 封包并记 `meta.apply`）、`rollbackProposal`（`rollbackBackup` 逐字节还原后回读校验摘要，`verified` 才是"100% 一致"的证据） | 自己拼章路径/自己写章文件（归 `chapters.ts`/`io.ts`）、新造备份格式（归 `backup.ts`）、diff 与裁决（归另两个模块）、跑 git |
| `src/host/proposal-channel.ts` | 提案页签的通道半：`GET /proposal`（列表 + 可选 `proposalId` 的逐段差异；读路径**不** `ensureIndex`）、`POST /proposal/{decide,apply,rollback}` 的信封、`confirm: true` 闸门、拒绝码到 HTTP 状态；每个 hunk 连同自己的 `baseLines`/`nextLines` 一起下发，面板不必再算一次 diff | 提案规则、写盘（一律调 `proposal.ts`）、HTTP 加固（归 `routes.ts`） |
| `src/host/proposal-tools.ts` | 四个工具（#45）：`inkflow_proposal_create`（收会话已产出的修订正文，切段落盘）、`_decide`（逐段接受/拒绝/撤回，`contentFilesWritten: 0`）、`_apply` 与 `_rollback`（都要 `confirm: true`）。走 `resolveProject` 的四态门禁，与内置工具同一套判定 | 提案语义（归 `proposal.ts`）、调模型或出站请求（X-26）、直接拼章路径 |
| `src/client/proposal.tsx` | 「提案」页签（#45 + X-12 的一行一页）：提案列表、逐段差异（原文行与修订行分开染色）、逐段接受与拒绝、全部接受/拒绝、应用与回滚各自**两段式确认**、以及「为什么现在不能应用」的那句话；只调 `/proposal` 四条路由 | 判 diff 是否成立、算 hunk（都来自 Host）、写盘 |
| `src/host/jobs.ts` | **批量作业的入口面**（#47）：把四层再导出（`jobs-model` / `jobs-store` / `jobs-actions` / `jobs-drafts`），让工具、面板路由与测试只认一个 import，并把「哪件事归哪个文件」写死成本文件的文件头（模块表 §6 逐行登记）。拆分前它是 1374 行同时干这四件事的文件 | 任何实现：这里没有状态机、没有 IO、没有锁；`jobs-wire.ts` 仍独立于本文件之外 |
| `src/host/jobs-model.ts` | **批量作业的词汇表**（#47）：两种文件格式与其 schema 版本（`inkflow.batch-job` / `inkflow.batch-chapter`，读不懂就拒收而不是半懂）、上限（并发 3/8、每批 3/20、`CLAIM_LEASE_MS`、`MAX_ATTEMPTS`）、状态机取值（`JOB_STATUSES` 里 `paused` 是人工审批点；`CHAPTER_STATUSES` 里 `held` 待批、`edited` 是作者接手且终止）、记录形状（`JobChapter`/`JobMeta`/`JobState`/`JobChapterRef`/`JobPause`/`JobGateVerdict`/`JobSummary`）与两个结果信封（`JobResult` + `refuse`/`accept`） | 任何磁盘访问（归 `jobs-store.ts`）、任何状态迁移（归 `jobs-actions.ts` / `jobs-drafts.ts`）、面板投影（归 `jobs-wire.ts`）、门禁自己的 `GATE_*` 词表（归 `gate.ts`） |
| `src/host/jobs-store.ts` | **作业记录落盘与它周围的锁**（#47，[ADR-0023](../adrs/0023-proposal-job-private-placement.md)）：`.inkflow/jobs/<jobId>/{meta.json,chapters/<seq>.json}` 的路径与 `bj-` 作业号、读回（`readMeta`/`readChapters` 的防御式取值、`readJob`/`listJobs`/`resolveJobId`）、保存（`saveState` 把 `meta.chapters` 从章节文件**重算**成汇总，两者不是两个真相）、锁（`locked`/`lockedAsync`/`lockFailure`/`lockHolderOf`：一次同步临界区，`PROJECT_BUSY` 还必须报出是谁在持锁，X-30）、以及两个判据：`chapterDigest`（落盘字节的 sha256）与 `reconcileChapter`（摘要不符即 `edited`，永不覆盖作者），外加 `claimExpired`/`inFlightCount` | 动作语义（归 `jobs-actions.ts` / `jobs-drafts.ts`）、写正文（归 `chapters.ts`）、跨模型调用持锁（X-30）、`index/` 写入 |
| `src/host/jobs-actions.ts` | **队列侧的三个动作**（#47）：`enqueueJob`（只写作业目录、零内容写入，同 seq 幂等进 `skipped`；**省略 `seq` 时取书内下一章号**——`bookNextSeq()` 从 catalog 投影 `readCatalog()` 读书里已用的最高 `seq` + 1，空档不回填，作业自己已占的号抬高这个下限，显式 `seq` 优先且一批里全给时不读书）、`takeBatch`（按 `concurrency − inFlight` 与 `batchSize` 领章，每章附写作上下文；`claimedAt` 租约 + `attempts` 上限决定重发）、`resumeJob`（`failed` 重排队；门禁暂停一律 `APPROVAL_REQUIRED`——续跑不是绕过人的路） | 起草与落章（归 `jobs-drafts.ts`：`complete`/`approve`）、记录格式与锁（归 `jobs-store.ts`）、面板投影（归 `jobs-wire.ts`）、任何模型调用（X-26） |
| `src/host/jobs-drafts.ts` | **草稿侧的两个动作**（#47）：`completeChapter`（**先把草稿过七项门禁**：干净才经 `chapters.ts` 落盘并记 digest；有 warning 即 `held` + `pendingBody`，一个字节都不写）、`approveDrafts`（`confirm` 后写的就是门禁判过的那份草稿，判词与字节一起留档）、`gateVerdictOf`/`pauseWorthy`（`GateReport` → 记录里保留的计数与样本，以及 `pauseOn` 策略） | 自造暂停策略（策略来自作业记录的 `pauseOn`）、门禁判定本体（归 `gate.ts`）、记录格式与锁（归 `jobs-store.ts`）、领章与排队（归 `jobs-actions.ts`）、起草（X-26） |
| `src/host/jobs-wire.ts` | 批量页签的读投影与**唯一**写（#47）：`GET /batch`（作业列表 + 选中作业的逐章状态/门禁计数/暂停原因；读路径**不** `ensureIndex`，作业本来就不在索引里）、`POST /batch/resume`（只改作业记录；门禁暂停回 409 `APPROVAL_REQUIRED`）、`BATCH_RESUME_BODY_FIELDS` | 状态机（归 `jobs-actions.ts` / `jobs-drafts.ts`）、写正文、HTTP 加固（归 `routes.ts`） |
| `src/host/jobs-tools.ts` | 四个工具（#47，X-26）：`inkflow_batch_enqueue`（建作业/加章，回答 `contentFilesWritten: 0`）、`inkflow_batch_take`（领章 + 写作上下文；暂停的作业不给任务，`reason: "PAUSED"`）、`inkflow_batch_complete`（交回草稿：落盘或 `held`）、`inkflow_batch_approve`（需 `confirm: true`）。走 `resolveProject` 的四态门禁 | 起草（模型侧）、状态机（归 `jobs-actions.ts` / `jobs-drafts.ts`）、`index/` 写入 |
| `src/host/export.ts` | **导出的唯一写入器**（#50，[ADR-0024](../adrs/0024-export-zip-reuse.md)、X-27）：`exportBook()` 读 `readCatalog()` 的投影（章序/卷序来自 `.md`，不信 `index.json`）→ 组 EPUB（`mimetype` 第一条且 store-only + `container.xml` + `content.opf` + 导航 xhtml + 每章一个 XHTML）、DOCX（`[Content_Types].xml` / `_rels/.rels` / `word/document.xml` / `word/_rels/document.xml.rels` / `word/styles.xml`，卷 Heading 1、章 Heading 2）、或 Markdown/TXT（作用域=单文件，状态筛选=一卷一条目的 zip），**全部经 `zip.ts` 的 `writeZip`**；写盘前用 `readZip` 读回自检（条目数、EPUB 首条），成品落 `dataDir/exports/<bookSlug>-<kind>-<stamp>.<ext>`，书内零写入 | 第二个 ZIP 写入器/第二份 CRC（D1 禁止）、Markdown 解析库或任何依赖（自写「转义 + 段落 + 标题」最小渲染器）、把导出物写进书内（`dataDir` 落在书内直接拒）、模型调用 |
| `src/host/export-tools.ts` | 一个工具（#50）：`inkflow_export`（`format` = epub/docx/markdown/txt，`target` = book/volume/status，可选 `volumeId`/`status`）。走 `resolveProject` 的四态门禁；拒绝一律零写盘（空书/命中 0 章 → `EXPORT_EMPTY`，两条选择轴混用 → `EXPORT_SELECTION_UNUSED`） | EPUB/DOCX 的组装与落点（归 `export.ts`）、面板页签（导出是一次性动作，ADR-0024 不另开常驻页） |
| `src/host/export-channel.ts` | **导出入口的宿主半**（#195，ADR-0024 入口归属）——**薄转发**，不含第二条导出链：`GET /hub/export/options?book=` 回可导出的卷（`readCatalog` 投影）与三条词表（原样转出 `export.ts` 的 `EXPORT_FORMATS`/`EXPORT_TARGETS` + `CHAPTER_STATUSES`）+ 落点 `exportsDir`；`POST /hub/export` 把请求原样交给 `exportBook()`，只做锚点（复用 `shared-channel.ts` 的 `registeredBook`/`usableBook`）与拒绝码 → HTTP 状态映射。按 ADR-0024 的判据**不要 `confirm`**：带戳的文件名永不覆盖、也没东西被清理 | 第二套导出实现、自己的格式/范围词表、接受 `root`/`path`、写书内文件、重建 catalog |

### 6.2 客户端纯模型（`src/client/*-model.ts`）

**纯视图模型：无 React、无网络、无 IO**——面板的判定都落在这里，好让它们能被单测（渲染、`fetch`、文件系统一律在 `.tsx` 与 Host 侧）。整组列全：

- `panel-model.ts` — 四态徽标与状态文案、`readGate`（两种信封折一份）、卷章树与扁平化、空态判定、`root` 相对化、页签表 `PANEL_TABS`、预览裁剪
- `hub-model.ts` — 书库行徽标（含 `timeout`）、`~/…` 相对化、卷章数文案、`missing-dir`/`notABook`/重复注册标记、`HUB_UNAVAILABLE` 文案；**两组切分**（#198：`isMainListRow`/`splitHubRows`/`othersHeading`/`whyNotABook`——主列表只留 `usable`/`needs-repair`/`needs-newer-plugin`/`timeout`，坏书与需升级的书**必须留着**）、初始化提示词单一常量（`INIT_PROMPT_TEMPLATE`/`buildInitPrompt`：绝对路径 + `<tool>inkflow_project_init</tool>` + 三条边界）、剪贴板结果（`copyPrompt` → `copied`/`fallback`）
- `export-model.ts` — 导出入口（#195）：三条词表与 `export.ts` 对齐（`EXPORT_FORMATS`/`EXPORT_TARGETS`/`EXPORT_STATUSES` 与其标签）、`buildExportBody`（两条选择轴照原样送出，由 Host 明确拒绝混用而不是这里静默丢）、`readExportOptions`/`readExportDone` 两种信封折叠、`describeExportValue`（成品：文件 + 范围 + 体积 + 落点）、`describeExportError`（每个拒绝码 → 人话）
- `hub-wizard-model.ts` — 向导 plan 的四态折叠（ready / anchor-required / blocked / refused）、`willCreate` 文案、书名建议与必填、降级 A 文案、`mergeHubRow`
- `hub-shared-model.ts` — 共享内容页：两种信封折叠（库 / 副本）、`copyNeedsUpdate`（只为 `stale` 给按钮）、`copyModes`（引用只给 `library/`）、`copyTargets`（只列 `usable`）、拒绝码 → 人话
- `series-model.ts` — 系列同步区块（#49）：计划信封的防御式折叠（`readSeriesPlan`，`expected` 缺省时由行重建）、四类分组（冲突在最上）、`applyBlockedReason`（选书 → 预览 → 裁决冲突 → "没有要写的"，按作者下一步排序）、`applyPayload`（把计划自己的 `expected` 交回去）、结果行与拒绝码 → 人话
- `library-model.ts` — 设定库：8 个 kind 的树与 `world` 的 category 分组（`buildLibraryTree`/`groupByCategory`）、每类的字段表（`KIND_FIELDS`/`fieldsForKind`）、编辑草稿与未知字段（`draftFromItem`/`unknownFields`）、问题分组与文案（`aggregateIssues`/`describeIssueRow`）
- `outline-model.ts` — 大纲页：三层树（`buildOutlineTree` 整体在前、卷章按 `order`、循环截断；未挂父节点与「父节点不存在」各成一组、从不吞节点）、层级推断（`inferOutlineTier` 与文件名的关系同 `domains/scan-helpers.ts`，详情里的 `kind` 一旦读到就压过来）、行与编辑器入参（`flattenOutlineTree`/`outlineItemOf` 把节点投成设定库的行，复用同一个编辑器）、情节点解析（`parseOutlinePlotPoints`：`[标签]` 留作 `arc`、不剥掉，每个点另带 `raw`——文件里那一行**原样**，含 `- `、且在标签解析与续行合并之前，所以页面的悬停提示直接引它而不是把 `text`+`arc` 拼回一行：拼回去的标签显示不出「丢掉一个 `- `」「续行被合并」「解析器拒收的标签仍留在文件里」这些差别）、地址 → 页签（`tabForEntityKind`：`outlines` → `outline`，其余 → `library`）、空态文案（`OUTLINE_EMPTY`）
- `library-import-model.ts` — 导入对话框三步：草案校验、请求体、预览文案、结果文案、拒绝码 → 人话（路径由作者填，Client 无文件 API）
- `editor-model.ts` — 编辑器的纯状态机：`AUTOSAVE_DELAY_MS`/`UNDO_GROUP_MS`、脏判定与 CAS 保存相（`SAVE_LABELS`）、撤销分组、文件被外部改过时的处理、`CHAPTER_STATUSES`
- `layout-model.ts` — 面板滚动 box 的纯几何（§4.3.1）：可用底边规则、`Math.floor` 定高、CSS 变量与兜底、两列共享的样式常量
- `foreshadow-model.ts` — 伏笔看板：三个状态（`open`/`late`/按关联实体）各一组文案（`statusLabel`）、`readForeshadowBoard` 的折叠——`late` 只显示 Host 的判定，**不**从 `dueBy` 与章号自行推算
- `trash-model.ts` — 回收站：`readTrashValue`、`describeEntry`（路径/大小/删除时间/原因）、`restoreBlockedReason`、`purgePrompt`/`purgeStage`（清空的两段确认）、`describeTrashError`
- `audit-model.ts` — 体检页：分组/严重级/code 文案、`readAuditValue` 与 `auditHeadline`/`auditGroupLine`、`locateLabel` 与 `jumpTargetOf`（能不能跳、跳到哪）、`exportLabel`/`exportNotice`
- `impact-model.ts` — 改设定的影响清单与改名计划：`buildImpactDigest`（五处影响面折叠）、`impactQuery`、`renamePayload`、`describeImpactError`/`describeRenameError`
- `search-model.ts` — 检索框：请求路径与「全部类型」开关换算（`kinds=chapters` vs 省略）、X-16 信封的防御式读取、命中行文案、点击去向、摘要与降级文案
- `extract-model.ts` — 候选页签：6 个 kind 与 3 个状态的取值与文案（`KIND_LABELS`/`STATUS_LABELS`/`CONFIDENCE_LABELS`）、`readCandidateList` 的防御式折叠、字段摘要（`describeFields`）与证据行（`describeEvidence`）、`evidenceTarget` 只认 Host 给的 `locator`（**不**二次解析 `path#L<n>`）、`describeCounts`/`waitingCount`
- `settings-model.ts` — 设置页三段的表单换算与文案：`formFromSettings`/`patchFromForm`（表单字符串 ↔ 线上类型，空串 → `null` 清除）、`describeSettings`/`describeDraftChanges`、`SETTINGS_FIELD_LABELS`、备份与恢复的 `backupSummary`/`mergeRestoreExpected`/`describePlan`
- `brief-model.ts` — 简报页（#43）：九段每行的状态（`ok`/`trimmed`/`missing`，只读 Host 的两个标记，**不**从 `bytes === 0` 自行推算）、占比文案（`formatShare`）、裁剪记录文案、`readBrief` 的三态折叠（请求失败 / 答案读不懂 / 九段真的都没有来源）
- `map-model.ts` — 地图页（#48，ADR-0025 D4）：把设定库同一份投影里的 `world` 分组重排成地点分组（`placeGroups`，保留分类存储顺序、未分类垫底）、三种空态分开（请求失败 / 索引不可读 / 这本书还没有地点）、`describePin` 与 `MAP_NOTE`；**地点就是 world 条目**，这里不定义第二套地点数据、不含任何坐标字段
- `timeline-model.ts` — 时间线页签：把 `GET /timeline` 折叠成两列（世界轴 / 叙事轴）＋待确认区＋冲突；**不改排序**（顺序是 Host 的，两轴本就不同序），唯一的重排是「读不出日期」的行挪到世界列末尾并标注；`flashback` 由叙事序上相邻两行的世界日比较得出（倒叙是数据的事实，不是错误）；`slot`/`undeclared`（未定叙事位）、`describeRow`/`describeConflict`、`readTimelineView` 的四种状态（失败 / 索引不可用 / 空书 / 未载入）、空态文案 `TIMELINE_EMPTY`、以及表单草稿与 `POST /timeline/upsert` 的请求体换算（`draftOf`/`upsertBodyOf`，空值送 absent、规则一律不回判）、回执文案 `describeUpsert`
- `review-model.ts` — 审稿页（#46）：三态（`loading`/`error`/`ready`，**没有**「无运行」这一态——那是 `ready` 且 `runCount: 0`，否则页面会把唯一的入口藏起来）、`readReviewValue`/`readCompareValue` 的防御式折叠、`evidenceJumpOf` 只认 Host 给的 `locator` 并复用候选页的 `EvidenceJump`（**不**自己解析 `path#L<n>`）、`evidenceLine`、`describeRun`/`describeScores`、`EMPTY_REVIEW`/`EMPTY_COMPARE`
- `proposal-model.ts` — 提案页（#45）：`readProposalPage` 的三态折叠（请求失败 / 答案读不懂 / 可读，其中「这本书还没有提案」是 `ready` 的空列表而不是错误）、段行摘要与状态文案、`preferredProposalId`、`applyBlocked`/`rollbackBlocked`（为什么现在不能按 —— 与 Host 的拒绝码同一口径）、两段式按钮文案、`decidePayload`/`confirmPayload`/`detailRequestPath`、拒绝码 → 人话；**不**重算 diff（hunk 与状态都由 Host 给）。另含 #199 的折叠：`splitProposals`（首屏只列 `open`，`applied`/`rolled-back` 进「已结束（N）」组；`truncated` 时计数取 Host 的全量 `counts`，否则取同一批行——**表头与列表必须同一口径**）、`describeClosedGroup`、`cleanable`（只有已结束的能清理）
- `purge-model.ts` — 回收区（#199）：`readPurgedValue` 的防御式折叠、`purgedFor`（审稿页只认 `review-run`、提案页只认 `proposal`）、`describePurgedEntry`（含 `present: false` 的「副本已不在」而不是隐藏该行）、`cleanActionLabel` 的两段式文案、`cleanPayload`（永远带 `confirm: true`）/`restorePayload`（只有 id，浏览器不给路径）、三个路径常量、`describePurgedError`/`describePurgedFailure`；**不**决定谁能被清理（归 Host 的 `PURGE_OPEN_PROPOSAL`）
- `batch-model.ts` — 批量页（#47）：`readBatchPage` 的防御式折叠 + 三态判定 `batchPanelState`（`empty` 无作业 / `active` 还有在写或待批准 / `closed` 收口；「门禁暂停」属于 `active`，不能并进进行中）、逐章状态与门禁计数文案（`describeChapter`/`describeChapterStatus`/`describeGate`）、暂停原因（`describePause`）、`resumeBlockedReason`（为什么续跑现在不能按 —— 门禁暂停要的是批准，不是续跑）、`resumePayload`、`EMPTY_BATCH_NOTE`

### 6.1 一致性体检（#33）的取数与落点

| 分组 | 唯一实现 | 体检做的事 |
|---|---|---|
| `structure` | `scanProject()` 的 `validation_issues` | 换 code → 分组/严重级/hint；定位解析成实体/章/文件行 |
| `ledger` | 同上（`facts-plan.ts` 产出 `FACT_*`） | 同上（行锚 `path#L<n>` 拆成 `line`） |
| `foreshadow` | 同上 ＋ `foreshadowing-plan.ts` 的 `foreshadowAuditIssues()`（`FORESHADOW_OVERDUE` / `FORESHADOW_DUE_NOW`） | 位置表**读文件**（`chapterPositionsFromFiles`），不用索引：过期缓存会让超期静默消失 |
| `timeline` | 同上（`timeline-plan.ts` 产出 `TIMELINE_*`） | 同上 |
| `catalog` | `scanProject()`（`CHAPTER_NOT_MARKDOWN`）＋ `validateCatalog()` | 同上；catalog 文件本身定位成 `catalog[:卷 id]` |

- **只读**：体检走 `scanProject`（纯读），**不** `ensureIndex`、不建 `.inkflow/`、不碰 `index/`。缓存状态作为 `indexState` 上报，由人决定要不要重建。
- **排序**：`compareFindings`（X-14）＋ `detail` 作最后决胜键 → 同一份未改动的书两次导出正文逐字相同（文件名带时间戳，正文不带）。
- **导出落点**：`<book>/.inkflow/audit/audit-<YYYYMMDD-HHmmss>.md`（[ADR-0012](../adrs/0012-plugin-private-state-dir.md) #6：派生物、可删、不进 git）；写入经 `writeTextAtomic` → `resolveWriteTarget` 白名单，首次写入时 `ensurePrivateStateIgnored()` 追加 `.gitignore` 行。工具侧 `inkflow_project_audit` 的 `export: true` 与通道侧 `POST /audit/export` 都要求 `confirm: true`。
- **通道**：`GET /audit`（读）与 `POST /audit/export`（写）；面板页 = `PANEL_TABS` 的 `audit` + `pageRenderers.audit`（X-12）。

### 6.3 写工具 → 域模块校验

X-4 的写入侧是「**域模块的 `parseFile` → `applyCandidate` → `validate({candidate})` → `io.ts` 写锁内原子写**」：同一份文档在落盘前先被**重建期用的同一个解析器**读一遍、被**同一套不变量**判一遍，因此不存在「写进去合法、下次重建报错」的中间态。

按「谁在判」分成三档：**全链**（判定的实现与调用都来自 `DomainModule` 对象）、**同实现直调**（与全链同一份实现，但由域自己的工具直接调，因为 `world.ts` 之类会反向 import 它，走 module 对象会形成运行期环）、**链外**（不新增/不改实体，或由另一套结构契约管）。

| 写工具 | 判定 | 说明 |
|---|---|---|
| `inkflow_character_upsert` | 全链 | `characterDomain.parseFile()` + `.validate({candidate})`，`planCharacterUpsert()` 只是预检（I-03 的码由它先给，落盘前的判定仍是域模块） |
| `inkflow_relation_upsert` | 全链 | 同上；边的两端与自环由 `validate()` 判 |
| `inkflow_world_upsert` | 全链 | 同上；见下方说明 |
| `inkflow_extract_accept` | 全链 | 候选变实体的唯一路径：用该域渲染器出文档 → `parseFile` → `applyCandidate` → `validate` |
| `inkflow_outline_upsert` / `_move` | 同实现直调 | `parseOutlineDocument` + `validateOutlineScan` **就是** `outlineDomain.parseFile()` / `validate()` 委托的那两个函数；`outline.ts` 反向 import 本工具文件，所以只能直调 |
| `inkflow_timeline_upsert` | 同实现直调 | `timelineFileParse` / `timelineValidate` 与 `timelineDomain.parseFile()` / `validate()` 是同一份实现（`timeline-plan.ts`） |
| `inkflow_foreshadow_upsert` | 同实现直调 | 解析器只有一份（`parseForeshadowFile`），工具侧只补 `DomainFileParse` 的形状 |
| `inkflow_facts_append` | 同实现直调 | `factsFileParse` + `factsConflicts`（「一个判定、两张网」） |
| `inkflow_chapter_create` / `_write` / `_move` / `_delete`、`inkflow_volume_create` / `_rename` | 链外 | 卷章结构由 `chapters.ts` + `catalog.ts` 管（写后 `rebuildCatalog`，漂移由 `validateCatalog` 报）；`chapterDomain.parseFile()` 目前只在重建期用。把 `seq`/`volume`/`status` 的判定搬进 `validate({candidate})` 是独立改动，未做 |
| `inkflow_library_import` | 链外 | 逐章走 `createChapter` / `writeChapter`（同上），另写 `library/` 原件副本；导入的合法性由分章计划判（`import.ts` / `import-write.ts`） |
| `inkflow_search_replace` | 链外 | 只替换章正文文本（保留原行尾/BOM），不新建实体、不产生 frontmatter |
| `inkflow_shared_copy` / `_update` | 链外 | 快照复制/逐条刷新：字节来自共享库，冲突零写入；副本不是「用户刚输入的字段」，过本书的域校验等于让别的书的条目按本书规则被拒 |
| `inkflow_project_init` / `_repair` / `_migrate` / `_backup_restore` | 链外（结构性写） | 只补缺失项 / 重塑既有文件 / 用备份包逐字节还原（逐文件 CAS）；都不生成新实体 |
| `inkflow_extract_propose` / `_reject` / `_purge` | 链外（队列） | 只写 `.inkflow/candidates/`；进内容目录只有采纳那一步（在链上） |
| `inkflow_index_rebuild` | 链外（派生缓存） | 重建 `index/`；索引是缓存，不是真相 |
| `inkflow_project_audit`（`export`）/ `_settings_update` / `_diagnostics_export` / `_semantic_rebuild` / `_semantic_purge` | 链外（不写内容目录） | 分别写 `.inkflow/audit/`、`$DSH_HOME/inkflow/`、OVK 与 `dataDir/semantic/` |

**world 的具体形状**（因为它最能说明「预检 ≠ 判定」）：`planWorldUpsert()` 与 `worldDomain.validate()` 共用 `worldIssues()` 这一份树规则（I-08：至多一个根、有 parent 必带 category、parent 必须能解析），所以域链对 world 的**净增量**不是新规则，而是两件事——① `parseFile()`：渲染出来的文档能不能被**重建期的同一个解析器**读回（`planWorldUpsert()` 只判树，判不了文档）；② 视图来自 `scanProject()`（文件）而不是派生索引（缓存）。拒绝码一律回域模块给出的那个 code，`planWorldUpsert()` 的错误码只作为预检（让模型在渲染前就拿到能改的理由）。

## 7. 数据流

```
写：Agent → inkflow_* 工具 → io.ts（解析 + 写锁 + 原子写 + 期望基线 CAS）→ 文件（真相）→ git commit（用户/AI）
读：Agent → inkflow_* 工具 ─┐
    面板 → /inkflow/internal/* → ① ensureIndex（判定 + 唯一重建点）→ ② index/inkflow.db
语义：写入/重建 → OVK（peer 命名空间，按章同路径覆盖）→ 召回 uri → 自有索引定位 → 回文件读正文
```

**读路径先 `ensureIndex`**（issue #5）：每一条读入口（`inkflow_chapter_list`、`inkflow_chapter_search`、`GET /internal/chapters`、`GET /internal/search`）都先调 `ensureIndex`，由它用一次 `readdir`+`stat` 与 `files` 表对拍判出 `fresh` / `stale` / `missing` / `incompatible`，必要时**只**建一次索引。判定函数 `checkIndexFreshness` 是纯读；重建复用 #4 的锁、单飞与原子替换。因此「列表已新、搜索还旧」在结构上不会发生。

- 索引重建是**全量**的（删除 + 重扫 + 事务写入）；增量重建未实现（`files` 的 `(size, mtime)` 对拍是基础，按文件增量重扫是可选的下一步）。
- 写路径用**期望基线 CAS**（`size`/`mtimeMs`/`sha256`，见 [conventions.md §5.5](conventions.md)）：基线不符 → `FILE_CHANGED`，零写入。
- 卷章 catalog 是真相的结构投影：写路径重建、读路径只报 `catalogStale`（未实现，归 #15）。
- 正文仍在文件里；`chapters_fts` 只存副本用于检索。
- 语义检索是**叠加层**：OVK 缺席时降级为 FTS5，不影响数据与写作（[ADR-0009](../adrs/0009-ovk-semantic-search.md) P8）。

## 8. 已踩过的坑（都写进了代码注释/测试）

| 坑 | 现象 | 规避 |
|---|---|---|
| patch 裸 `- id:` | 目标不存在时整条 patch 静默丢弃 | 新增行一律 `- insert:` |
| 改已装插件的 `lib/` | **HMR 只对新装 bundle 生效**，改代码不生效 | 改完必须重启 DSH |
| `sidebar.panellist` 与 `main` 两处入口 | 两个 root 作用域槽位的 id/key 不一致就"有图标没页面"；且都拿不到会话工作区 | 两处都撤掉，只留 session 作用域的 `conversation.view`（ADR-0008 D1） |
| 把面板放在 root 作用域插槽 | 拿不到会话工作区，只能靠"上次打开的书"猜 | 入口用 session 作用域的 `conversation.view`（ADR-0008 D1） |
| 面板让客户端传 `root`/`path` | 任意 loopback 页面可指向任意目录，`inspectProject` 还会在那里建 `index/` | Client 只传 `sessionId`，Host 解析（ADR-0008 D4） |
| 按 `value` 读非 `usable` 的门禁清单 | 非 `usable` 的清单在 `error` 里（HTTP 仍是 200），只读 `value` 会得到"什么都没有"的空面板 | `readGate` 同时读两种信封（§5.4） |
| 给未实现的页签挂真按钮 | 点了没反应的死入口，用户以为插件坏了 | 未实现页签只做禁用态 + 版本 tooltip |
| Windows 工具写 UTF-8 BOM | `JSON.parse` 抛错 → 项目被判无效 | 读 `inkflow.json` 前剥 BOM（已有回归测试） |
| `node:sqlite` 的 `PRAGMA user_version` | 只能 `prepare().get()` 读、`exec()` 写 | 已封装在 indexer |
| 用 `ctx.skills.register()` 注册随包技能 | 落到**全局层**：所有会话（含代码会话）的技能目录都被塞进小说技能 | 走 `registerProvider` + `cwd` 门禁（§4.6） |
| 技能 provider 的 `list()` 返回「不完整观测」 | `dsh-tool-skill` 会**停发整个技能目录**，不是只少几个技能 | 无技能时返回空数组 |
| 只注册 `sidebar.panellist` 就以为有了全局面板 | 侧栏只渲染图标；点击时 `layout.selectPanel(id)` 在 `main` 没有该 `key` 时**抛错**，页面不出现 | 图标与主体成对注册（`id` + `key` 同值），主体必须用 `key`（§4.3） |
| 书库用 `readCatalog()` 数卷章 | 它会重扫整本书的 `.md` 并解析 frontmatter，N 本书就是首屏成本 | 只读已提交的 catalog 文件，缺失即"未知"（§4.2、ADR-0010 D8） |

## 9. 未验证 / 未实现

### 9.1 未实现（已裁决、尚未落地）

| 契约 | 现状 | 归属 |
|---|---|---|
| 面板编辑器与提案制修订 | 编辑器（标题/正文/状态、自动保存、本地撤销、CAS 冲突二选一）与四个章级写路由已落地；**提案制**（改正文前需用户审批）未落地，编辑器直接走 CAS 写文件 | #45 |
| 搜索的正文全文检索 | `/search` 目前只匹配章节元数据（id/路径/标题），并显式标 `searchUnavailable: true` | #22 |
| 卷章 catalog + `volumeId` | 未落地；卷归属按目录名推导 | #15 |
| 索引 v2（九目录全实体 + 提及 + 全实体 FTS） | 只覆盖章/角色/世界观/大纲 | #22 / #23 |
| 共享条目的「转为复制快照」 | 引用卡只读（写入即 `REFERENCE_READONLY`）；想改成快照，当前做法是删卡片再复制一次（ADR-0007 C4 的显式动作未做成按钮） | 随 #49 |
| OVK 语义检索（peer / 分块 / 按章重建 / 降级） | 未落地；当前只有 FTS5 | #41 |
| 写入器之上的提案制（改写正文需确认） | `io.ts` 已落地，提案制未落地 | #45 |
| 增量重建 / 大文件流式解析 | 未落地 | 随索引 v2 |
| 书库「共享内容」页的**运行中观感** | 契约测试打 `lib/client.js` 构建产物（入口、两条路由、两段式确认文案、无轮询），**没有在重启后的 DSH 里点过**「复制」「更新」与目标书下拉 | 重启 DSH 后：书库里点「共享内容」→ 选书 → 复制一条 → 看 `origin` 落到文件；改共享库再刷新 → 该行显示落后 → 更新 |

### 9.2 未验证（已实现但未观测）

| 项 | 状态 | 验证方式 |
|---|---|---|
| 新 Host 代码在**运行中的 DSH** 里生效 | 未验证（需重启加载新 generation） | 重启后复核工具表 |
| 面板视觉（四态徽章、章节树、只读正文预览、禁用页签） | 未验证（契约测试打构建产物，未在运行中的 DSH 里看过） | 重启后目视：会话的「对话 / 轨迹」栏第三个页签 InkFlow |
| 左侧栏书库面板的渲染与选中态 | 未验证：注册形状（`sidebar.panellist` 只渲染图标、`main` 按 `key` 渲染主体、缺 key 会抛错）来自 0.2.1-rc.2 打包产物的代码读取，**没有在运行中的 DSH 里点开过**；`cordis_inspect_query` 的 client/Slots 在本机 10 s 超时 | 重启 DSH 后点左侧栏「InkFlow 书库」图标：书库主体出现、卡片状态与 `inkflow_project_status` 一致、空态与刷新按钮可用、「共享内容」为禁用态 |
| 向导在运行中的 DSH 里的交互（plan → apply、`git init`） | 契约测试全绿（打 `lib/index.js`），未在重启后的会话里跑过 | 重启后手动跑一次全流程 |
| 书库「新开书」按钮背后的 `uiWorkspace.pickDirectory()` | 未验证：调用形状（返回 `string` / `{path}` / 取消时的形态）与是否存在都是按能力名推断的；Client 侧因此同时实现了返回值归一化与"没有选择器就手输绝对路径"的降级 | 重启后在真实 DSH 里点一次「新开书」：确认选择器弹出、选中后确认卡出现、取消不会把面板卡住 |
| 59 万字全量重建耗时 | 未验证 | 用真实库基准（当前样例 7 文件 10ms） |
| 面板的项目来源（会话 → 工作区） | 契约测试全绿（打 `lib/index.js`，含 registry → workingDirectory → header 三级链）；运行中 DSH 未观测 | 重启后在小说会话打开面板，确认 `/inkflow/internal/status` 的 `resolvedFrom` 与 `root` 指向该书 |
| 增量重建 / 大文件流式解析 | 未做 | P1 |
| 提案制（改正文需审批） | 未做（原子写入器已由 #14 落地；提案流程在 P3） | P3 |
| 写作 preset 在真实会话里挂载成功 | 未验证：签名与行名来自 `cordis_inspect_query` 与官方 preset 声明，缺少重启后的名册观测 | 重启后看模式选择里是否出现「InkFlow 写作」，确认工具表无 shell、技能目录有 5 个 `inkflow-*` |
| 每个会话的 `cwd` 都非空 | 代码路径已确认（`dsh-tool-skill` 用 `workingDirectory.ensure`），真实会话未观测 | 在工作区外的会话里确认技能目录不含 `inkflow-*` |
| 5 个技能的实际写作效果 | 未验证（未跑真实章节生成） | 用一章真实任务书跑 架构→起草→审校，人工判读 |
| OVK 首建成本 / 体积 / 块参数 | 未验证（只有量级推断） | 按 [ADR-0009](../adrs/0009-ovk-semantic-search.md) P10 先估算再实测 |
| 写作上下文四段在真实会话 system prompt 里的位置与内容 | 未验证：`cordis_inspect_query` 只给签名，本次没跑真实会话（HMR 不热替换已加载插件，需重启 DSH） | 重启后在写作会话首轮看四段齐全、非项目会话看不到任何注入 |
| `context.agent` 在 section `text` 回调里存在 | 未验证（未写进公开类型；本机两个第三方插件依赖它） | 重启后若取不到 → 只是不注入（有降级）；届时改走 `variable()`（回调同样拿 `AssembleContext`）或等宿主给出 scope→session 映射 |
| 预算裁剪在真实书稿上的手感（1200 token 够不够） | 未验证 | 重启后用一本有正文的书看首轮 `[trimmed: …]`，再决定 `promptBudgetTokens` 默认值 |
| 真实 GBK 现场的乱码检测（`src/host/encoding.ts`，issue #89） | 【未验证】判据与阈值是在真实中文语料上学得并测得的（另取一份语料做留出验证：2/3/4/6/10 字窗口误报 0/783，GBK 误读召回 31% / 75% / 82% / 92% / 94%），但**没有在真实的 Windows GBK 事故文件上复核**——`PowerShell 5 Set-Content` 产出的字节与 `TextDecoder('gbk')` 的解码结果可能不同（配对偏移、非法字节被替换成 `?`） | 在中文 Windows 上用 PowerShell 5 以默认 ANSI 写一个含中文标题的 `inkflow.json`，跑 `inkflow_project_status` 看 `titleSuspicious` 与 `inkflow_project_init` 的 `warnings[]` 是否出现 `META_ENCODING_SUSPECT` |
| 外部参考（本机可复跑） | `huangziyuan-general/dsh-novel-forge@1f1af8a`：`lib/contextpack.js`（分层预算 / `dropped` 列表 / `clipTail` 保留结尾并把截断标记计入上限）、`lib/index.js`（`systemPrompt.section` 静态段 order 110 + 动态上下文走 briefing 工具） | 只借这几个结构，不搬代码；差异见 §4.7 |
