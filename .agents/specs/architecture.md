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

1. **代码层**：模块没有任何写 API —— 不 `mkdir`、不写 `index.json`、不改条目文件；库不存在只回 `created:false`（空不是错误，也不是"顺手建一个"的理由）。
2. **数据层**：`index.json` 是**派生清单**（[ADR-0005](../adrs/0005-files-first-with-derived-index.md)：文件是真相、清单是缓存）。清单与目录不一致时**以目录为准**，清单既不修也不补。
3. **证据层**：拒绝路径与正常读取都要求 `shared/` 整树 hash 前后一致（`tests/hub-shared.test.js`）。

**为什么不写回 `index.json`**

- **能力边界**：写入属于共享库写入方（#40）。hub 的能力白名单只有"列书 / 初始化计划 / 初始化执行 / 共享内容只读浏览"（ADR-0010 D3），通道里没有写路由；在同一个投影里顺手写清单，等于给只读页开了一个写后门。
- **幂等与并发**：面板可能同时开在多个窗口。谁都写清单就会出现"最后写者赢"的清单；不写，则任何窗口看到的都是同一份真相——目录本身。
- **失败形态更好**：清单坏了只是"这次扫描"；扫描被预算截断只是"这次少列 + `truncated:true`"。两者都不留下半写状态。

**成本上限**：见 [conventions.md](conventions.md) §6.2.2。常量在 `hub-shared.ts` 顶部导出，测试注入而非真的等待 1.5 秒。

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

`ctx.systemPrompt.section(section: PromptSection): () => void`，`PromptSection = { name, order, text: string | ((context: AssembleContext) => string), interpolate?, complete? }`；同名 section 在**同一层**重复注册会抛 `already registered`。本插件注册一个段 `inkflow:writing-context`（order 120，位置只是建议值：宿主按 order 排序，具体邻居到重启后目视才算验证）：写作会话的 system prompt 里直接带上「这是哪本书、写到哪一章、上一章怎么收尾、本章该记起哪些设定」，让模型在**第一次工具调用之前**就知道处境。

**为什么不用 `inject: ['systemPrompt']`**：硬注入会让服务缺失直接拖死整个插件（与 skills/preset 同一条纪律，§4.6）。

#### 注入源与门禁

| 步骤 | 实现 | 失败时 |
|---|---|---|
| 会话目录（同步） | `ctx.get('workingDirectory').get(session)`（提交值，无文件 IO）→ `session.header.cwd` → `process.cwd()` | 取不到 → 空 section |
| 项目根 | `findProjectRoot(cwd)`（向上找 `inkflow.json` / `.git`，§3） | 未命中 → 空 section |
| 四态门禁 | `inspectProject(root)`；只有 `usable` 才注入 | 其余三态 → 空 section（一个字节都不注入） |

`AssembleContext` 的**公开**声明只有 `{ scope?, signal? }`；会话身份 `context.agent` 是运行时实际传入、但没写进类型声明的字段（本机 `dsh-memory-evolve` 与 `dsh-novel-forge` 两个插件的实现都依赖它）。因此本插件把 `context` 当 `unknown` 收窄后逐层可选读取，取不到就退回 `process.cwd()`：宿主哪天改掉这个字段，最坏结果是「某些会话不注入」，不是抛错。

#### 四段

| # | 段 | 取数 | 依据 |
|---|---|---|---|
| 1 | 项目摘要 | 书名（`inkflow.json` 的 `title`，缺省目录名）、卷数（`outline_nodes.kind='volume'`）、章数与总字数（`chapters` 行数 / `SUM(word_count)`）——全部来自派生索引 | [data-model](data-model.md) §4 |
| 2 | 当前章 | 章号最大的章（`seq` 降序；`seq` 缺省取文件名前导数字）：标题 + `volume`/`seq`/`status` + 该章大纲 `outlines/ch-<seq>.md`（也认 `chapter-` 前缀与不补零写法）的正文 | [conventions](conventions.md) §3.2 / §3.5 |
| 3 | 上一章结尾 | 次大 `seq` 章的正文**最后 300 字**（`config.promptTailChars`；截断标记计入上限，保留结尾而不是开头——「结尾」的价值全在最后几句） | P1 F-P1-06 的「上章结尾」 |
| 4 | 命中的世界书条目 | 以「本章大纲 + 上章结尾」为关键词串，匹配 `world/**` 的 `keywords`；`always: true` 常驻；命中注入 `title` + 正文前 200 字；排序 `always` 降序 → `priority` 降序 → 路径升序 | [conventions](conventions.md) §3.4、[data-model](data-model.md) §2 #9 |

只出现书名与**相对路径**（`outlines/ch-0012.md`、`world/门派/白鹤门.md`），绝不出现项目绝对路径——提示词会进会话日志，日志可能被分享。

#### 预算与裁剪

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

`buildWritingContext(root, opts)` 是这一段的唯一取数入口：纯投影（无缓存，除门禁文档化的 `index/` 自愈外无副作用），返回 `{ text, segments, trimmed, tokens, budgetTokens }`。取数规则集中在 `writing-sources.ts`（同步、失败即「缺这一段」），装配在 `prompt.ts`，section 回调只做「取 cwd → build → 返回 text」，所以测试直接断言纯函数；面板的「简报预览」将来复用它（当前版本只提供函数，没有面板入口）。

不在范围内：九段写作简报与「承诺书 / 场景契约 / 人物卡 / 账本 / 伏笔」（P1 F-P1-06）、面板预览与编辑。

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
| `src/host/writing-context.ts` | 写作上下文的**纯投影**：四段渲染、单段上限、预算阶梯、裁剪标记；另含**扩展段注册表** `EXTRA_SEGMENTS`（roadmap X-13：域只声明 `{name,label,capRatio,build}`，顺序与裁剪阶梯归本模块；`build()` 的入参带 `capChars = floor(capRatio × budgetTokens)`，段自己按整行装填——计数与装填必须由一处算，否则 header 会写着 N 条而实际只渲染出几行） | 会话/服务/日志、写任何作品数据 |
| `src/host/writing-sources.ts` | 写作上下文的取数：索引查询 + 文件读取（章节对/大纲/上章正文/世界书），全部同步且失败即缺段 | 渲染、预算、Host 装配 |
| `src/host/prompt.ts` | `systemPrompt` section 的注册：会话目录解析、text 回调、降级与幂等 | 取数规则、渲染规则 |
| `src/host/preset.ts` | 写作 preset 的声明（人设 + 工具行）、注册与降级 | 其他插件的业务逻辑、技能正文 |
| `src/host/tools.ts` | 工具 schema/执行/渲染、四态拒绝清单（当前注册 16 个：`project_status` / `project_plan` / `project_init` / `index_rebuild` / `chapter_list` / `chapter_search` / `search` / `search_replace` / `project_audit` / `volume_create` / `volume_rename` / `chapter_create` / `chapter_write` / `chapter_move` / `chapter_delete` / `project_repair` / `project_migrate`——其中 `search` 是 #39 的 X-16 单一入口，`search_replace` 是 X-17 的预览/执行两段工具） | 直接扫目录（走 indexer/project/workspace） |
| `src/host/chapters.ts` | 卷章 CRUD 的规则：id/uuid、seq/slug 分配、改卷名级联、移卷、删章、失败回滚、catalog 与索引重建、写锁内的期望基线 CAS（`FILE_CHANGED`） | 门禁判定（由 tools 先做）、直接拼项目路径（经 io.ts）、派生索引的 schema |
| `src/host/internal.ts` | 私有通道的**投影层**：会话 → 工作区/项目解析、四态门禁的通道版拒绝清单、`/status`/`/chapters`/`/chapters/:id`/`/search` 四个投影；`/chapters` 与 `/search` 先 `ensureIndex`，失败降级并报告 `indexError`（`/search` 自 #39 起是 X-16 的单一入口，索引不可用时降级为章元数据扫描并带 `degradedReason`；检索替换的三条路由在 `search-channel.ts`） | HTTP 加固、写作品文件、自己决定是否重建 |
| `src/host/findings.ts` | **「问题」的唯一形状**（roadmap X-14）：`Finding` / `FindingLocator` / 五个报告分组 / `FINDING_CODES` 目录 / `compareFindings` 的稳定排序 | 任何检查实现、任何 IO（#33 产出、#36 消费） |
| `src/host/audit.ts` | **一致性体检**（#33，X-14）：五类发现聚合成一份 `Finding[]`（只聚合 / 分组 / 排序 / 给人话 hint，判定一律调域模块）＋ Markdown 报告渲染 ＋ 唯一写动作（`exportAuditReport` → `.inkflow/audit/`） | 判任何不变量（那是 `scanProject` / `validateCatalog` / 域模块的事）、重建索引、在只读路径写盘 |
| `src/host/audit-channel.ts` | 体检的通道半：`GET /audit` 的投影（分组计数 + 前 N 条 + 定位与地址）与 `POST /audit/export` 的信封、`CONFIRM_REQUIRED` 闸门、失败码到 HTTP 状态的映射 | 体检规则、Markdown 排版、写盘（一律调 `audit.ts` 与 `io.ts`） |
| `src/host/private-state.ts` | 私有状态目录 `.inkflow/` 的三个共享助手（ADR-0012）：相对路径拼装、`isPrivateStatePath`、`ensurePrivateStateIgnored`（append-only 补 ignore 行，失败返回而不抛） | 决定什么时候删/备份（归 #35/#36）、清单格式 |
| `src/host/zip.ts` | **store-only ZIP 容器**（[ADR-0018](../adrs/0018-settings-backup-diagnostics.md) D3）：`writeZip`（本地头 + 中央目录 + EOCD，method 0，自算 CRC-32，MS-DOS 时间戳）、`readZip`（**读中央目录**而不是扫本地头，逐条校验 CRC 与长度）、导出的 `crc32`；拒绝 method≠0、zip64、密文包、`..`/绝对/反斜杠/空段名（防解压逃逸）与重名条目 | 压缩与解压（那是被 D3 否掉的方向）、决定备份包含哪些文件（归 #42）、写盘 |
| `src/host/hub.ts` | **书库投影**（无会话）：`workspaceRegistry.list()` → 书单行（四态门禁 + `dirStatus` + 只读 catalog 计数 + `notABook`）、realpath 去重、并发 4 / 单本 2 s→`timeout` / 预算 3 s→`truncated` / 200 行→`capped`、注册表缺失 → `HUB_UNAVAILABLE`；对外只暴露"列注册表"这一个只读入口（`listRegisteredWorkspaces`），供向导线解析锚点 | 接受任何路径、写盘、重建索引或 catalog、自动注册/移除工作区 |
| `src/host/hub-wizard.ts` | **新开书向导**（ADR-0010 D4/D6）：`plan`（锚点三级判定 → 路径闸门 → 只读 plan → 签发 token）与 `apply`（消耗 token → 摘要比对 → `applyWorkspace` → `workspaceRegistry.create`）、一次性 `planToken` 存储（TTL 5 分钟、可注入时钟）、`nextStep` 降级 A 文案 | 自己写文件（一律走 `workspace.ts`）、接受 `apply` 的路径、发 token 给已注册目录、commit/配远端 |
| `src/host/impact.ts` | **改设定前的影响清单 + 改名计划**（#34，[ADR-0014](../adrs/0014-entity-id-pinning.md)）：`(kind, id)`／标题模糊匹配 → 实体文件（只读扫描，索引不可用时也能解析）；五处影响面（提及章读 `entity_mentions`、关系读 `relations`、时间线/账本/伏笔因无投影直接读文件）＋总计数；改名计划（目标路径、要钉的 id、冲突判定） | 写任何文件、重建索引、决定是否执行（执行由 `impact-write.ts` 与面板的确认动作承担） |
| `src/host/impact-write.ts` | **改名的唯一写实现**：写锁内「先写新文件（旧 id 钉进 frontmatter `id`）→ 再删旧文件」、`TARGET_EXISTS`/`FILE_CHANGED`/失败回滚、写后 `ensureIndex(rebuild)` 并回报 `id` 不变 / `path` 更新 / 提及条数不变 | 生成影响清单、重写引用方字段（X-15：一个都不改）、直接拼项目路径（经 `io.ts`） |
| `src/host/routes.ts` | 私有内部通道的路由表（逐路由声明方法）、loopback 与参数加固、JSON 信封、body 字段白名单；另含**书库路由组** `/hub/*` 的独立分派（无会话；写路由要求 `Origin` 与 `Host` 同源） | 业务规则、写真相文件、解析会话 |
| `src/client/index.tsx` | 两处入口的注册（`conversation.view` 工作台 + `sidebar.panellist`/`main` 书库）、工作台骨架（四态徽章 / 章节树 / 编辑器 / 向导清单）、页表 `pageRenderers`（roadmap X-12：非 `chapters` 页一行一页，JSX 里不再有页分支）、`fetchInternal` 调用 | 业务规则、文件 IO、拼路径参数 |
| `src/client/hub.tsx` | 书库视图：书卡片（标题 / `~/…` 路径 / 徽标 / 卷章数 / 标记）、空态、加载与错误态、手动刷新、「新开书」向导入口（`HubWizard`）、共享内容的禁用占位（#87）、`apply` 成功后**就地合并**书单行 | 写动作本身、轮询、拼路径参数 |
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
| 插件级共享库 + `origin` 溯源 | 未落地 | #40 |
| OVK 语义检索（peer / 分块 / 按章重建 / 降级） | 未落地；当前只有 FTS5 | #41 |
| 写入器之上的提案制（改写正文需确认） | `io.ts` 已落地，提案制未落地 | #45 |
| 增量重建 / 大文件流式解析 | 未落地 | 随索引 v2 |
| 书库的共享内容页 | `/hub/shared` 与「共享内容」入口位未落地；书单与「新开书」向导已落地 | #87 |

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
