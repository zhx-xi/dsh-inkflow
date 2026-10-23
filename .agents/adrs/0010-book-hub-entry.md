# ADR-0010：书库入口（root 侧栏）+ 书单来自 DSH 工作区注册表

- 状态：**已采纳（2026-10-21）**。本文**收窄** [ADR-0008](0008-panel-data-channel.md) **D1**（"入口只留 `conversation.view`" → 改为"创作工作台只留 `conversation.view`"，另加一处 root 作用域书库入口）；0008 的 D2–D7 全部继续有效
- 日期：2026-10-21
- 关系：遵守 [ADR-0006](0006-workspace-contract-v2.md) D5（一个工作区 = 一部小说）、D2（四态门禁）、D3/D4（plan → apply、`git init` 边界）；共享内容的复制/引用语义仍按 [ADR-0007](0007-plugin-shared-library.md)（本文只负责**只读浏览**共享库）
- 影响：`src/client/index.tsx`（新增 `sidebar.panellist` 注册）、`src/host/routes.ts`（新增 `/inkflow/internal/hub/*` 无会话路由组）、[S-02 architecture](../specs/architecture.md) §4.2/§4.3/§5.4、[S-03 conventions](../specs/conventions.md) §6.1/§6.2、[docs/user-guide.md](../../docs/user-guide.md)、[AGENTS.md](../../AGENTS.md) §8 陷阱 3

## 背景

### 1. 用户诉求

在实际使用中，**在新工作区里开一本书的入口不好用**：现行唯一入口是会话作用域的 `conversation.view`（ADR-0008 D1），因此必须先有一个落在小说目录里的会话，面板才会出现、才能触发初始化。新开书的实际路径是"自己建空目录 → 在该目录开新会话 → 在面板里点初始化"，三步都散落在不同界面。

诉求是：左侧栏一个 InkFlow 按钮，点进去是**书库**——所有书籍项目 + 共享内容 + 「新开书」按钮；点新开书 → 建工作区并初始化项目；初始化完再无缝衔接到该工作区的会话创作。

这与 ADR-0008 D1 直接冲突。按 [AGENTS.md](../../AGENTS.md) §9.2 A1，必须先有 ADR 再改实现。

### 2. 本次实测的宿主能力（DSH 0.2.1-rc.2）

| # | 事实 | 来源 |
|---|---|---|
| E1 | Host `workspaceRegistry` 提供 `create(path, title?)`（**目录必须已存在**，经 `fs.realpath` 规范化；相对路径 / 不存在 / 非目录一律拒绝；同一 canonical 路径重复调用返回既有实体且**不改 title**）、`list()`、`get(id)`、`resolveByPath(path)`、`delete(id)`（只删注册，保留目录与会话日志）、`Workspace.status()` → `'ok' \| 'missing-dir'` | `cordis_inspect_query`（platform=host，provider=Service，method=listService，service=`workspaceRegistry`） |
| E2 | Client `workspaces` 有 `create({path})`（把**已存在**目录注册为工作区）、`rename`、`delete`、`archiveSession`… | issue #84 实测记录（打包 Client 模块；本 ADR 起草时 client Service inspect 仍 10 s 超时，与 [ADR-0008](0008-panel-data-channel.md) E1 同现象） |
| E3 | Client `sessions` **没有 `create`**（只有 retain / using / fork / search…）→ 插件**不能程序化新建会话** | 同上 |
| E4 | Host `sessions.create({meta:{cwd}})` 存在但**不可用于产品路径**：服务文档明确 "Persistence is intentionally not implemented here——在该生命周期外发布的 session 不落盘" | issue #84 实测记录 |
| E5 | root 作用域插槽拿不到 `sessionId`（`sidebar.panellist` / `main` 都是 root），因此书库需要一条**无会话上下文**的通道 | issue #17 实测（[ADR-0008](0008-panel-data-channel.md) 背景 4 同结论） |
| E6 | Client 侧文件能力只有 `uiWorkspace.listDirectory / pickDirectory / createDirectory`，**不能读文件内容、不能写文件**；`workspaceFiles` 只读且依赖 Typert 生成产物 | [ADR-0008](0008-panel-data-channel.md) 背景 6（同一份宿主能力核对） |

【推断】由 E1/E2 直接得到的两条设计要求：

- 书的**列表**只能来自宿主注册表（这正好就是"一部书一个工作区"的宿主表达，见 ADR-0006 D5）；插件自建 `books.json` 会多一个真相源。
- 书库里的"新开书"必须拆成**先建目录内容、后注册工作区**两步：注册要求目录已存在，初始化则要求目录可用但尚未是书。

【推断】注册表里**会有非书目录**：工作区是宿主的通用概念（任何被打开过的目录），所以书库必须能显示 `not-a-book` 行并把"初始化为书"作为该行的动作，而不是假设每一行都是一本书。

### 3. 不动的部分（本文的前提）

1. **单工作区单书**（ADR-0006 D5）：书库是**工作区切换器**，不是"多书混管"。同一工作区不管理第二本书；书库不跨工作区读写任何内容。
2. **门禁四态与"列出清单而非一句错误"**（ADR-0006 D2）：书库每本书的状态与工作台、工具看到的是**同一套**判定（`state`/`checks`/`missing`/`actions`）。
3. **通道不是 API**（ADR-0008 D2）：新增的 hub 路由同样是内部实现，不版本化、不自描述、不对外文档化。
4. **共享库是插件级目录**（ADR-0007 C1）：`$DSH_HOME/inkflow/shared/`（`dataDir/shared`），复制 / 引用语义归 ADR-0007 与 #40，本文只裁定"只读浏览"。

## 决策

### D1 入口：新增 root 作用域 `sidebar.panellist` 书库；`conversation.view` 保留为创作工作台

**入口与注册形状**

| 槽位 | 作用域 | 注册参数 | 职责 |
|---|---|---|---|
| `sidebar.panellist` | **root** | `id: 'inkflow-hub'`、`order: 35`、`label: () => 'InkFlow 书库'`，图标取插件包 ``./icon`` 导出 | 书库：列书状态、新开书、共享内容只读浏览 |
| `conversation.view` | **session** | `id: 'inkflow'`、`order: 40`、`label: () => 'InkFlow'`（**不变**，ADR-0008 D1 原文） | 创作工作台：当前这本书的驾驶舱与编辑器 |

**职责边界（硬规则）**

| 能力 | 书库（root，`sidebar.panellist`） | 创作工作台（session，`conversation.view`） |
|---|---|---|
| 列书 / 列门禁状态 | ✅ 只读（注册表 × 门禁判定） | — |
| 注册工作区、新开书（plan → apply） | ✅（D4） | ❌ |
| 共享内容只读浏览 | ✅（D5） | — |
| **读写作品正文/设定/大纲/伏笔/时间线** | ❌ **禁止**（无此路由，见 D3/D6） | ✅ 唯一写路径（既有章级路由） |
| 索引重建 / catalog 重建 | ❌ 一律不重建（只读判定） | ✅ 既有行为 |
| 会话上下文 | 无 `sessionId` | 有 `sessionId`，Host 由会话推出路径 |

- **书库不读写任何作品文件**：它对作品唯一的动作是"判定能不能进"与"初始化 / 修复缺失项"（ADR-0006 D3 的向导动作）。看到正文、改正文，都只能在工作台。
- **不注册 `main`**：书库不占用 `main`（按 id 分发的 root 面板）承载任何作品数据视图，避免出现第三处入口与"有图标没页面"的失配（[AGENTS.md](../../AGENTS.md) §8 陷阱 3）。
  实现确认项【未验证】：`sidebar.panellist` 图标点开后面板主体在宿主里的渲染落点，需要在 #85 落地时按实际宿主契约确认；若确需 `main` 承载，`main` 只允许承载**书库**，且不得因此出现作品数据视图（D6 的同一份拒绝判据覆盖它）。若宿主根本不提供 root 面板承载面，降级为"书库作为 `conversation.view` 内的一个页签"，入口虽不常驻，"列书 + 新开书"两项能力不变。

### D2 书单来源 = DSH 工作区注册表（**不自建** `books.json`）

| 项 | 决定 |
|---|---|
| 唯一来源 | Host `workspaceRegistry.list()`（`Workspace.path` 已 `fs.realpath` 规范化、`sessionIds` 已按 canonical cwd 过滤）→ 书单集合；Client `workspaces` 快照只用于显示与选中 |
| 一本书的身份 | **一个 workspace**（ADR-0006 D5 不变）。不引入 `books.json`、不扩展 `state.json`、不建第二个项目注册表 |
| 每行的数据 | `path`（canonical）、`title`（注册表标题，缺失取目录名）、`state`（四态之一，取 `inspectProject(root, { recreateIndexDir: false })`）、`missing[]`/`actions[]`、`dirStatus`（`ok` / `missing-dir`，来自 `Workspace.status()`）、`chapters`/`volumes`（来自 catalog 投影，catalog 缺失则为 `null`，**不重建**） |
| 非书目录 | 有工作区但门禁为 `needs-setup` 且无 meta 无 `.git` → 行标 `not-a-book`，动作是"初始化为书"（D4），**不自动初始化** |
| 已删目录 | `dirStatus: 'missing-dir'` → 行显示"目录不在了"，提供"移除注册"（`workspaceRegistry.delete` 只删注册、保留目录与会话日志），**不自动移除** |
| 不做的事 | 不跨书检索、不合并统计、不做"最近打开列表"、不缓存书单到磁盘（每次打开/刷新实时读注册表） |

**为什么这是"不违反单工作区单书"**：书库读的是宿主的**工作区清单**，不是作品的**内容清单**；它不打开任何一本书的文件做跨书操作，也不让同一工作区承载两本书。列的多样性来自"用户打开过的目录有多本"，不是"插件把多本混在一起管"。

### D3 无会话通道 `/inkflow/internal/hub/*`：能力白名单，禁止任何正文读写

root 槽位无 `sessionId`（E5），因此需要一条**不依赖会话**的通道。

| 路由 | 方法 | 输入 | 成功值 `value` | 与工具的关系 |
|---|---|---|---|---|
| `/inkflow/internal/hub/books` | GET | 无 | `books[]`（D2 的行形状）、`total`、`capped`、`truncated`、`readOnly: true` | 无（纯投影） |
| `/inkflow/internal/hub/plan` | POST | `candidate`（目录，见 D6）、`outsideRegistry?`、可选 `title` | `path`（canonical）、`anchor`、`state`、`checks`、`missing[]`、`actions[]`、`notices[]`、`metaRaw`、`planToken`、`canApply` | 等价 `inkflow_project_plan`（只读） |
| `/inkflow/internal/hub/apply` | POST | `planToken`、`confirm: true`、可选 `title`（重建坏 meta 需要） | `created[]`、`updated[]`、`skipped[]`、`workspace`（注册结果或 `null`）、`nextStep` | 等价 `inkflow_project_init` + `workspaceRegistry.create` |
| `/inkflow/internal/hub/shared` | GET | 可选 `kind`（`world`/`library`/`snippets`/`series`）、`q` | `entries[]`、`created: false`（共享库尚未创建）、`indexSource: 'scan'` | 无（只读投影） |

**能力白名单（只有这四项，多一项都不加）**

1. 列书状态；
2. 初始化计划（只读）；
3. 初始化执行（用户确认后，只补缺失项）；
4. 共享内容只读浏览。

**显式禁止（不做路由，因此不可调用）**

| 禁止的能力 | 拒绝形态 |
|---|---|
| 章节目录 / 单章正文的读或写 | 不存在此类路由 → 404 `not-found`；若将来误加，必须回 `HUB_CAPABILITY_DENIED` |
| 设定、大纲、伏笔、时间线、事实、关系的读写 | 同上 |
| 任意文件读 / 写 / 删除 / 移动 | 通道内没有通用文件路由（通道不是 `fs` 门面） |
| 改 `state.json`、强制重建索引、重写 catalog、写共享库 `index.json` | 通道不调用这些写入；`apply` 只执行向导列出的动作 |
| 传 `root`/`path`/`cwd`/`workspace`/`projectRoot` 指书 | 400 `ROOT_PARAM_NOT_ALLOWED`（与 session 通道同一错误码与判定时机） |

**为什么 `plan` 要一个路径、而 `apply` 不要**：新开书时"用户选中的目录"必须跨一次边界，但它只用于**只读判定**（这个目录能不能初始化、要不要 `git init`）；一旦用户确认，写入就只认 `planToken`（一次性、绑定 canonical path 与计划内容），**写路由不接受任何调用方拼的路径**。这与 ADR-0008 D4 的精神一致：路径不能由调用方在写请求里指定。

**一次性 token 的契约**：`planToken` 为进程内随机会话值，单次使用；绑定 canonical `path` + 计划动作集合 hash；有效期 5 分钟；重放 → 409 `TOKEN_CONSUMED`，未知 / 过期 → 400 `TOKEN_INVALID`；`apply` 时**重新推导** plan，若动作集合与 token 记录的集合不一致 → 409 `PLAN_CHANGED`（零写盘，要求用户重新 plan）。token 不落盘。

### D4 新开书流程：pickDirectory → plan → apply(confirm) → 注册工作区 → 引导开新会话

**标准流程**

1. **选目录**：Client `uiWorkspace.pickDirectory()`（E6：这是 Client 侧唯一能拿到用户意图目录的能力，且不会读内容）。
2. **判定（只读）**：`POST /hub/plan {candidate, outsideRegistry?}` → 过 D6 的路径闸门后跑 `inspectProject(root, { recreateIndexDir: false })`，返回 `path`（canonical）、`anchor`（命中工作区 / `outside-registry`）、`actions[]`（`git-init` / `create-dir` / `create-gitkeep` / `create-meta` / `create-gitignore`，与 ADR-0006 D3 同一动作集）、`notices[]` 与 `planToken`。此步**零写盘**（连 `index/` 放宽都不做）。若 `candidate` 已被注册（D6 锚点第 2 条），直接回该书的既有状态，**不产生 planToken**（"这本书已经在书库里"）。
3. **展示 → 确认**：UI 显示 canonical `path`、`willCreate[]`、`notices[]`（如"外层仓库请自行 ignore"），用户确认后才进入下一步。
4. **执行**：`POST /hub/apply {planToken, confirm: true, title?}` → 只执行 plan 列出的动作（ADR-0006 D3：只补缺失、不覆盖；`git init` 是唯一 git 写，ADR-0006 D4：不 commit、不配 remote、不设身份）。
5. **注册工作区**：apply 成功后由 **Host** 在同一通道内调用 `workspaceRegistry.create(path, title)`（E1：目录必须已存在——此时已成立；同路径重复调用幂等且不改 title）。Client 侧只把返回值并进书单，**不**自己再调一次 `workspaces.create`，避免出现两条注册写入路径；Host 服务缺失时降级为 Client `workspaces.create({path})`，两者都失败则引导用户"在左侧手动打开该目录"。
6. **进入创作**：见下。

**"无缝进入会话"的现状与两档降级**

程序化新建会话做不到（E3/E4），所以 apply 之后**只能**做降级 A：

| 档 | 触发条件 | 行为 |
|---|---|---|
| **A（0.1.0 交付口径）** | 现在就可用 | 书库把该行切换为"下一步"卡片：文案「书已就绪。在左侧工作区「<title>」点「新会话」开始创作」，附该书 canonical `path` 供核对；**不假装已跳转**，不显示空白编辑器 |
| **B（未来升级）** | 宿主提供可落盘的"新建会话（带 cwd）"契约，或提供切换工作区 / 打开会话的导航 API | 升级为"一键进入"：apply → 建会话（或选中既有会话）→ 直接进入 `conversation.view` |

**D4 的再评估触发条件**（满足任一条即重审本 ADR 的 D3/D4）

| 触发 | 动作 |
|---|---|
| Client `sessions` 增加 `create({cwd})`，或 Host `sessions.create` 改为落盘契约 | 走降级 B：apply → 建会话 → 选中；hub 通道不再需要 `nextStep` 文案 |
| 出现工作区/会话的导航 API（router / `selectWorkspace` / `openSession`） | 至少做到"切到该工作区 + 打开新会话"，降级 A 的文案可以去掉 |
| `pickDirectory` 能直接"选空目录并立即注册为工作区" | 合并第 1 步与第 5 步，plan 的 `candidate` 改由注册表反查（可取消 `candidate` 参数） |
| root 槽位开始提供"当前工作区" | 重审 D2：书单可能不再需要 host hub 通道（但"不能程序化建会话"这条仍限制 D4） |

### D5 共享内容：`$DSH_HOME/inkflow/shared/` 只读浏览

- 浏览范围固定为 ADR-0007 C1 的四个子目录：`world/`、`library/`、`snippets/`、`series/`；`kind` 只在这四个值里取。
- 数据来源：优先 `shared/index.json`（ADR-0007 C1 的**派生清单**）；缺失或与文件不一致时**在内存里扫目录重算**（`entryId` / `path` / `sha256` / `tags`），**不写回** `index.json`——书库是只读浏览，写入归 #40。返回 `indexSource: 'scan'` 明示这一点。
- 共享库不存在 = 空，不是错误：返回 `created: false`、`entries: []`，UI 文案「共享库尚未创建（0.4.0 支持）」，**不建目录、不写任何文件**。
- 路径纪律：`dataDir/shared` 由插件配置固定（`src/host/config.ts`），**不接受任何路径参数**；条目路径必须落在四个子目录内（拒绝 `..`、绝对路径、realpath 逃出 `shared/` 的符号链接）。
- **复制 / 引用不进本 ADR**：语义与 `origin` 三字段见 [ADR-0007](0007-plugin-shared-library.md)，落地归 #40；书库本期只读。

### D6 安全与拒绝路径

**锚点的变化（root 通道为什么不能照抄 session 通道）**

| 通道 | 信任锚点 | 路径从哪来 |
|---|---|---|
| `/inkflow/internal/*`（ADR-0008 D4） | 会话 → 工作区（`workspaceRegistry` / `workingDirectory` / `Session.header.cwd`） | Host 从会话推出，客户端只传 `sessionId` |
| `/inkflow/internal/hub/*`（本文） | **注册表 + 一次性 token + 绝对拒绝集** | 读：注册表；写：只有 `planToken` |

**复用既有闸门（同一实现，不新写一套）**

- `checkProjectRootScope(candidate, workspace)`（`src/host/project.ts:225`）：盘符 / 卷根、家目录本身或其祖先、系统与安装目录（`forbiddenRoots()`，`src/host/project.ts:189`）→ `PATH_FORBIDDEN`；不在信任子树 → `PATH_OUT_OF_SCOPE`。判定在**任何写盘之前**（`inspectProject` 的 `index/` 放宽、向导建树、`git init` 都在其后）。
- hub 通道里 `workspace` 这一参数**不来自调用方**，按序取锚点：
  1. `candidate` 落在某个已注册工作区之内（`Workspace.path` 是 canonical，直接做 `isWithin`）→ 锚点 = 该工作区路径，`PATH_OUT_OF_SCOPE` 照常生效；
  2. `candidate` 本身就是/已被注册（`workspaceRegistry.resolveByPath` 命中）→ 不新建，直接回该书的既有状态（"这本书已经在书库里"）；
  3. `candidate` 不在任何工作区内（**新开书的常见情形**：一个全新目录）→ 锚点缺失。此时不放开写，而是要求 `plan` 显式带 `outsideRegistry: true`（UI 二次确认"这是一个全新目录，确认在此初始化"），回值里标 `anchor: 'outside-registry'` + `willCreate[]`；`apply` 仍然只接受 `planToken` + `confirm: true`。
- **为什么锚点缺失时仍然允许**：`pickDirectory` 的结果 Host 无法验证——这一点与 session 通道（路径由会话推出）本质不同。因此 hub 的写动作不靠"路径可信"，而靠三条叠起来的约束：**绝对拒绝集**（系统/家/盘符根永不允许）+ **同源 `Origin`** + **一次性 token + 显式确认**；且初始化的写入集合是**只增不改**（ADR-0006 D3：只补缺失，唯一例外是被确认的坏 meta 重建）。残余风险在「后果」的风险表里如实列出，不做"已彻底防住"的表述。
- 拒绝返回保持 ADR-0006 D2 的结构化清单（`state`/`checks`/`missing`/`actions`/`readOnly`），并回**零写盘**。

**路由加固（继承 ADR-0008 D3，另加两条收紧）**

| # | 守卫 | 拒绝 |
|---|---|---|
| 1 | `Host` 必须 loopback | 403 `forbidden-host` |
| 2 | `Origin` 存在时必须 loopback | 403 `forbidden-origin` |
| 3 | socket 对端地址非空时必须 loopback | 403 `forbidden-remote` |
| 4 | 方法逐路由声明（`books`/`shared` 只 GET；`plan`/`apply` 只 POST） | 405 + `Allow` |
| 5 | 路径参数名禁令：`root`/`path`/`cwd`/`workspace`/`projectRoot` 出现在 query 或 body | 400 `ROOT_PARAM_NOT_ALLOWED`（`reason: 'unexpected-path-param'`），判定在路由匹配与任何文件 IO 之前 |
| 6 | 写路由（`plan`/`apply`）**`Origin` 必须与 `Host` 同源**（不只是"loopback"） | 403 `forbidden-origin`（`reason: 'origin-required'`） |
| 7 | 请求体 ≤64 KiB（**2026-10 修订为 1 MiB**：一次保存把整章正文当一个 JSON 字符串提交，64 KiB 数的是序列化字节，2 万汉字约 70 KB，长章因此存不进去；见 issue #115 与 architecture.md §4.2） 且必须是 JSON 对象；`apply` 必须 `confirm: true` | 413 / 400 `invalid-body` / 400 `INIT_REQUIRES_CONFIRMATION` |
| 8 | 响应 `Cache-Control: no-store` + `X-Content-Type-Options: nosniff`；信封 `{ok,value}` / `{ok:false,error}`；**不发 CORS 头** | — |

第 6 条是本 ADR 相对 0008 D3 的**收紧**：0008 的写路由路径由 Host 从会话推出，所以"loopback Origin"够用；hub 的 plan 接受一个用户选中的目录，因此要求 `Origin` 与 `Host` 完全同源（含端口），挡掉"本机另一个端口的页面"。

**零写盘断言（拒绝路径与只读路径都要测）**

| 场景 | 断言 |
|---|---|
| `hub/books` | 每个已知项目根的**全量 hash 前后一致**（复用 `tests/contract.test.js:145` 的 `hashTree` 助手）；`state.json`、`shared/index.json`、任何 catalog 均不变 |
| `hub/plan`（含 `PATH_FORBIDDEN` / `PATH_OUT_OF_SCOPE` / `needs-newer-plugin`） | 目标目录与项目根全量 hash 一致；`index/` 未被创建 |
| `hub/apply` 被拒（`TOKEN_CONSUMED` / `PLAN_CHANGED` / 缺 `confirm` / 非同源） | 全量 hash 一致；token 不被消耗两次 |
| `hub/shared` | `shared/` 目录树 hash 一致；共享库缺失时目录仍不存在 |

### D7 与 ADR-0008 的关系

- 本文**收窄** 0008 的 **D1**：0008 的"唯一入口 `conversation.view`"改为"**创作工作台**唯一入口 `conversation.view`"，另加一处 root 书库入口（D1）。收窄的是**范围**（多一处入口、且该入口的能力被 D3 白名单钉死），不是推翻 0008 的论证。
- 0008 的 **D2**（通道不是 API）、**D3**（路由加固）、**D4**（客户端只传 `sessionId`，Host 解析路径）、**D5**（与工具、与门禁一致）、**D6**（契约测试四条）、**D7**（再评估触发）**全部继续有效**，且对 hub 通道**同样适用**（hub 在此基础上另加 D6 的第 5–7 条）。
- 按 [AGENTS.md](../../AGENTS.md) §9.2 **A3 不改 0008 正文**：只改 0008 头部状态并在头部"取代与收窄"段加一条指向本文。
- 两条通道的**优先级**：任何"作品正文/设定"语义只有 session 通道有；hub 上出现同类请求一律 404。若未来两者对同一路径给出不同结论，以 session 通道（由会话推出、经同一门禁）为准，hub 侧按 bug 修。

### D8 刷新、规模与超时（不做轮询）

| 项 | 决定 | 理由 |
|---|---|---|
| 刷新时机 | 打开书库时拉一次；用户点"刷新"；`apply` 成功后就地更新该行；从工作台切回书库时重拉 | 不做 `setInterval` 轮询：每轮都要对 N 个目录做 stat + 门禁判定，成本随书数线性增长，而书单的变化只由用户动作触发 |
| 每本书的判定成本 | 只读元信息（meta 存在性 / 目录与 `.gitkeep` 存在性 / `.git`）+ catalog 投影；**不扫正文、不建索引、不重建 catalog** | 门禁判定本来就只需结构信号（ADR-0006 D2） |
| 并发 | 状态读取并发上限 **4**（分批复用，不一次性 `Promise.all` 全部目录） | 机械盘/网络盘上并发过高会把首屏拖垮；4 是【推断】起点，实现期用 20/50 本书实测校准 |
| 超时 | 单本判定 **2 s** → 该行 `state: 'timeout'`，**不重试**；整次 `/hub/books` 预算 **3 s** → 返回已完成行 + `truncated: true` | 把"慢盘"表达成一行状态，而不是整页卡住 |
| 规模上限 | 单次返回 **200** 行（`capped: true` + `total` 总书数）；超出部分不判定 | 【推断】200 已远超单人作者的书写量；上限的作用是给首屏一个确定性上界 |
| 不做的事 | 不做内容级统计（字数 / 角色数 / 最近编辑章），不做跨书搜索，不做缩略信息缓存 | 那是工作台与索引的职责；书库只回答"是不是书、能不能进、目录还在不在" |

## 备选与取舍（被否方案汇总）

| 方案 | 优点 | 代价 | 为什么没选 |
|---|---|---|---|
| 自建 `books.json`（或扩 `state.json`）做书单 | 书单完全可控，能存缩略信息与排序偏好 | 第二个真相源：用户直接删目录/换机器后立刻漂移；与"一个工作区一部书"的宿主语义并存两套注册表 | 注册表已存在且是 canonical（E1），自建只会让"哪份才对"变成日常问题（ADR-0005 的同类错误） |
| 沿用 `state.json.lastProjectRoot` + 最近打开列表 | 改动最小，书库立刻有内容 | 插件级单值/单列表，跨工作区误写（ADR-0006 D5 已删） | 这是被 0006 明确删除的数据安全问题，不是体验问题 |
| 书库也放在 `conversation.view`（不加 root 入口） | 入口只有一处，无新通道 | 需要先有会话才看得到书库——正是用户抱怨的那一步 | 需求本身就是"没有会话时也要能开书" |
| 书库放在 `main`（root，按 id 分发）而不放 `sidebar.panellist` | 面板主体落点更直观 | 不能常驻左栏；只有图标入口才能"点进去就有书库" | 用户诉求是左侧栏按钮；`main` 仅在宿主渲染需要时作为承载面（D1 实现确认项） |
| 书库面板内直接读写正文（复用 session 路由并传 `root`） | 一个面板搞定全部 | root 无 session 锚点 → 回到 ADR-0008 背景 3 记录的"任意 loopback 页面指向任意目录"攻击面 | 正文通道必须由会话推出路径；书库的能力白名单（D3）把它挡住了 |
| hub 通道接受通用 `root`/`path` 参数（照抄工具接口） | 实现最简单，语义与工具一致 | 等于把 0008 刚关掉的洞重新打开；`inspectProject` 还会在目标目录建 `index/` | 路径型输入收窄成 `plan` 的 `candidate`（只读）与写路由的 `planToken`（不接受路径） |
| 客户端直接读文件（`workspaceFiles` / `uiWorkspace`） | 连通道都不用 | 客户端只有 `listDirectory/pickDirectory/createDirectory`，不能读内容（E6）；`workspaceFiles` 依赖 Typert | 能力不足（ADR-0008 备选表同结论） |
| 用 Host `sessions.create({meta:{cwd}})` 程序化建会话，做到"一键进入" | 体验真正无缝 | 服务文档明确不落盘 → 造出"打不开 / 不持久"的会话 | 产品路径不能用未落盘的会话；降级 A + D4 触发条件才是可交付口径 |
| 用 `archiveSession` / `insertBefore` 等注册表方法拼出"导航" | 都是现成 API | 它们是注册表/归档操作，不是"打开某个工作区的会话界面" | 做不到需求；写进 D4 触发条件，等真正的导航 API |
| 共享库浏览复用 session 通道（在工作台里看） | 不用扩展 hub | 共享库不属于任何工作区，session 通道按会话解析路径没有这个概念 | 共享内容与"当前这本书"无关，归 root 入口（D5）；只读浏览不需要会话 |
| 书库定时轮询刷新（如 5 s） | 状态永远新鲜 | 每轮 N×stat + 门禁判定，成本随书数线性增长；绝大多数轮次无变化 | D8 的"用户动作驱动 + 显式刷新"足够；轮询还会与写路由抢目录 |
| 用 MCP 工具（`inkflow_project_plan` / `inkflow_project_init`）驱动书库 | 不新增通道，复用既有校验与信封 | 工具是**模型面**契约（叙述包装、按 Agent 装配），不是浏览器面请求 | ADR-0008 已按同一理由否决"把 MCP 工具当 RPC" |

## 影响面（落地后需要改的地方）

| 文件 | 现状 | 本 ADR 要求 |
|---|---|---|
| [S-02 architecture](../specs/architecture.md) §4.3 | "唯一入口 `conversation.view`"（1 处注册） | 两处注册（root 书库 + session 工作台）+ D1 的职责边界表；`sidebar.panellist` 的注册参数；`main` 若承载则只承载书库 |
| [S-02 architecture](../specs/architecture.md) §4.2 | 只有 session 通道的路由与加固 | 增加 hub 通道小节：4 条路由、锚点差异、"同源 `Origin`"与 `candidate`/`planToken` 契约 |
| [S-02 architecture](../specs/architecture.md) §5.4 | "面板通道：私有、按路由声明方法" | 区分为"有会话锚点"与"无会话锚点（注册表 + token）"两类 |
| [S-02 architecture](../specs/architecture.md) §6 / §9 | 模块边界与未实现清单 | 新增 `src/host/hub.ts`（书单投影 + plan/apply 编排）、`src/client/hub.tsx`（书库视图）；§9.1 记录落地状态 |
| [S-03 conventions](../specs/conventions.md) §6.1 | 信任锚点 = 会话工作目录 | 增加"无会话场景的锚点"（注册表 + token + 绝对拒绝集） |
| [S-03 conventions](../specs/conventions.md) §6.2 | session 通道路由表（4 读 + 4 写） | 新增 hub 路由表（D3）与错误码 `TOKEN_CONSUMED` / `TOKEN_INVALID` / `PLAN_CHANGED` / `ANCHOR_REQUIRED` / `HUB_CAPABILITY_DENIED` |
| [docs/user-guide.md](../../docs/user-guide.md) | 面板入口、初始化说明 | 书库入口、"新开书四步"、共享库空态文案、"最后一步仍需在左侧开新会话"的说明 |
| [AGENTS.md](../../AGENTS.md) §8 陷阱 3 | "面板入口用 session 作用域的 `conversation.view`" | 补一句限定：书库是**唯一** root 入口，且不读写作品文件（同一提交内改，避免陷阱条目失真） |
| `src/client/index.tsx`、`src/host/routes.ts` | 单入口、单路由组 | 新增 root 注册与 hub 路由组（实现归 #85–#87，本文不含实现代码） |

## 不在范围

| 项 | 归属 |
|---|---|
| 书库面板的视觉、交互与空态细节 | #85 |
| 新建书向导的字段（书名、模板、目录建议）与按钮流 | #86 |
| 共享内容页（浏览列表、预览、复制入口） | #87 |
| 共享库的复制 / 引用 / `origin` 溯源 / stale 判定 | [ADR-0007](0007-plugin-shared-library.md) + #40 |
| 语义检索（跨书召回、共享库 peer） | [ADR-0009](0009-ovk-semantic-search.md) |
| 多书混管、跨书全文检索、书间的引用与依赖 | 不做（与 ADR-0006 D5 冲突） |
| 远程同步 / 备份 | 未来 ADR（每书 git remote 方向） |

## 后果

### 正面

- 新开书从"手建空目录 → 在该目录开会话 → 面板里点初始化"收敛为"书库 → 新开书 → 选目录 → 看清单 → 确认"；初始化与注册同一次交互完成。
- 书单只有**一个**来源（注册表），不会出现"书单里有一本其实已经删掉/搬走的书"这种静默错误：目录没了由 `status()` 显式表达。
- 入口职责边界清晰：**书库只认路径与状态，工作台只认会话**；作品文件的读写仍然只有一条路径（session 通道 → `io.ts`）。
- hub 通道的能力白名单只有四项，攻击面比"再开一个 API"小得多：不接通用路径写入、不读正文、不对外文档化。

### 负面

- 两处入口需要用户理解"书库 = 切换器，工作台 = 干活"；这份理解只能靠 UI 文案与 `docs/user-guide.md` 承担。
- 新开书最后一步仍要用户**手动**在左侧开新会话（E3/E4），体验不是"无缝"；降级 A 的文案一旦写得含糊，用户会以为卡住了。
- 书库要判定 N 本书的状态，书多时首屏慢；D8 的并发/超时/上限是缓解，不是消除。
- root 通道与宿主 root 槽位、注册表方法强耦合：宿主升级改动槽位或 `workspaceRegistry` 契约就必须跟着改（D4 触发条件负责重审）。

### 风险

| 风险 | 触发条件 | 对策 |
|---|---|---|
| 书库在**错误的目录**跑了初始化 | 用户选错目录 / 手输路径 | plan 回显 canonical `path` + `anchor` + `willCreate[]`；必须显式确认；apply 只补缺失、**绝不覆盖**已有文件（ADR-0006 D3）；`forbiddenRoots` 绝对拒绝集 |
| 同源页面驱动 hub 写动作（残余风险，不宣称已彻底防住） | 恶意同源页面 / 本机脚本 | 写路由要求 `Origin` 与 `Host` 完全同源 + 一次性 `planToken` + `confirm: true`；`PATH_FORBIDDEN` 拦系统/家/盘符根；最坏结果是**只增不改**的一次初始化（十个空目录 + `.gitignore` + `inkflow.json` + `git init`），不读、不改、不删任何已有文件；正文通道不在此列（D3 白名单） |
| 锚点缺失被滥用（在注册表外的任意可写目录初始化） | 用户真的要新建到旧书目录之外的盘 | `plan` 必须显式 `outsideRegistry: true` + UI 二次确认，回值标 `anchor: 'outside-registry'`；不因此放开任何读能力 |
| 注册表里有非书目录 | 用户把普通项目目录开成工作区 | 行标 `not-a-book`，动作是"初始化为书"，**不自动初始化**（hash 一致） |
| 目录已被删/搬走但注册还在 | 用户手工移动书 | `dirStatus: 'missing-dir'` + "移除注册"（只删注册，保留目录与会话日志），不自动清理 |
| 宿主改掉 root 槽位或注册表方法 | DSH 升级 | 启动自检 `sidebar.panellist` 存在性并 warn；契约测试覆盖注册形状；D4 触发条件重审；降级为工作台内页签 |
| 书很多时首屏卡顿 / 慢盘拖死整页 | 20+ 工作区、网络盘 | D8：并发 4、单本 2 s、总预算 3 s、行上限 200，超时表达为行状态 |
| 用户以为"初始化完就能写"却找不到会话 | 降级 A 文案不清 | "下一步"卡片给出工作区名 + 路径 + 精确操作（左侧点「新会话」）；书库不显示空白编辑器 |

## 验证

### 证据附录（本次只读核对；过程记录按 [AGENTS.md](../../AGENTS.md) §9.5 D7 不入库）

| 编号 | 结论 | 判据 / 证据 |
|---|---|---|
| E1 | `workspaceRegistry.create(path, title?)` 要求目录已存在、canonical 化、重复幂等；另有 `list`/`get`/`resolveByPath`/`delete`；`Workspace.status()` 回 `'ok' \| 'missing-dir'` | `cordis_inspect_query`：platform=host，provider=Service，method=listService，service=`workspaceRegistry`（本次实测，返回含上述签名与 `Workspace` 声明） |
| E2 | Client `workspaces` 有 `create({path})` 等；Client `sessions` **无 `create`** | issue #84 实测记录（打包 Client 模块）；本机 client Service inspect 两次 10 s 超时（与 ADR-0008 E1 同现象），故以打包产物为准 |
| E3 | Host `sessions.create` 存在但该生命周期外**不落盘** | issue #84 实测记录（服务文档原话） |
| E4 | root 槽位拿不到 `sessionId` | issue #17 实测；[ADR-0008](0008-panel-data-channel.md) 背景 4 |
| E5 | 路径闸门与绝对拒绝集 | `src/host/project.ts:225`（`checkProjectRootScope`）、`src/host/project.ts:189`（`forbiddenRoots`） |
| E6 | 零写盘断言的既有做法 | `tests/contract.test.js:145`（`hashTree`）、`tests/file-cas.test.js:96` |

### 文档门禁（本文即可执行）

```bash
node scripts/check-links.mjs
pnpm.cmd run check
```

期望：`links ok: N relative link(s) across M markdown file(s)`；`check`（typecheck + lint + build + test + links + docs + guards + package）全绿。

### 判据（**验收判据，不是现状陈述**）

用例落在 `tests/`（文件名由 #85–#87 的实现决定），实测证据贴对应 PR 评论、不入库。**实现未落地前，任何一行都不得对外声称"已验证"。**

| # | 场景 | 期望（判据） |
|---|---|---|
| V1 | 注册面板 | `sidebar.panellist`（`id: 'inkflow-hub'`）与 `conversation.view`（`id: 'inkflow'`）各一处；`main` 不含任何作品数据视图 |
| V2 | `GET /hub/books` | 返回注册表全部工作区，每行含 `state`/`dirStatus`；所有已知项目根全量 hash 前后一致（零写盘）；`state.json` 不变 |
| V3 | 书库响应内容 | `books` 与 `shared` 的响应体不含任何正文/设定字段（无 `body`、无 frontmatter 内容），符合 D3 白名单 |
| V4 | `Host: evil.example` / 跨站 `Origin` / 非 loopback 对端 | 403 `forbidden-host` / `forbidden-origin` / `forbidden-remote`；`/inkflow/api/*` 与 hub 上未声明路径均 404 |
| V5 | `hub/apply` 缺同源 `Origin`、缺 `confirm`、重放 token、plan 后目录状态改变 | 403 `origin-required` / 400 `INIT_REQUIRES_CONFIRMATION` / 409 `TOKEN_CONSUMED` / 409 `PLAN_CHANGED`；四种都全量 hash 一致 |
| V6 | `hub/plan` 带 `root`/`path`/`cwd`；`candidate` 指盘符根、家目录、`Program Files`；`candidate` 在注册表外但未带 `outsideRegistry: true`；`candidate` 是已注册的书 | 400 `ROOT_PARAM_NOT_ALLOWED`；`PATH_FORBIDDEN`；`anchor` 缺失 → 400 `ANCHOR_REQUIRED`（零写盘）；第三例直接回既有状态、**不发 `planToken`**；三种情况目标目录零变更（mtime 与条目不变） |
| V7 | 空目录走 plan → apply | plan 列九目录 + 九个 `.gitkeep` + `index/.gitkeep` + `inkflow.json` + `.gitignore` + `git init`；apply 后 `state: usable` 且书单多一行（`workspaceRegistry` 注册成功）；再 apply 幂等（`created[]` 为空） |
| V8 | 已有 `.git` 的目录走 plan | plan 不含 `git init`；apply 后无 commit、无 remote、无 `user.name`/`user.email` 变更（ADR-0006 D4） |
| V9 | 注册表里的非书目录（有 `.git` 无 meta） | 行 `state: needs-repair` + `not-a-book` 标记；不自动初始化，项目根全量 hash 一致 |
| V10 | 注册表里的目录已删 | 行 `dirStatus: 'missing-dir'`；不自动移除注册；文件系统零变更 |
| V11 | 共享库不存在 / 存在但无 `index.json` | `created: false` 且 `entries: []`（不建目录、不写盘）；有文件时 `indexSource: 'scan'` 且 `shared/` 树 hash 一致 |
| V12 | 30 个以上工作区、其中一本目录在慢盘 | 单本超时行 `state: 'timeout'`；整次请求在预算内返回 + `truncated`；不做第二轮重试 |
| V13 | 文档门禁 | `check-links` 0 断链；`pnpm.cmd run check` 全绿 |
