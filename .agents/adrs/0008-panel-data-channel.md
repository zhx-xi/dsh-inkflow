# ADR-0008：面板入口只在 `conversation.view`，数据走私有内部通道

- 状态：**已采纳（2026-10-21）**。本文**取代/收窄 [ADR-0004](0004-loopback-http.md)**：其路由加固条款继续有效，其"对外接口"定位与 `/inkflow/api/*` 路径命名由本文取代（0004 头部已按 A3 标注，正文未改）
- 日期：2026-10-21
- 关系：遵守 [ADR-0006](0006-workspace-contract-v2.md) D5（单工作区单项目）与 D2（四态门禁）；与 [ADR-0005](0005-files-first-with-derived-index.md) 不冲突（面板只读投影）
- 影响：`src/client/index.tsx`（插槽注册）、`src/host/routes.ts`（路由与拒绝语义）、`src/host/config.ts`（`serveHttp` 语义）、[S-02 architecture](../specs/architecture.md) 的路由与集成点章节、[docs/user-guide.md](../../docs/user-guide.md) 的面板入口描述

## 背景

现状（基线 `baf3ee6`）：

1. 面板注册在**两处**：`sidebar.panellist` 图标 + `main` 工作台（`src/client/index.tsx:311-318`）。
2. 数据走 `/inkflow/api/status` 与 `/inkflow/api/chapters`（`src/host/routes.ts:35,100-105`），当前一律返回 `NO_SESSION_CONTEXT`。
3. 造成 `NO_SESSION_CONTEXT` 的两个捷径已被移除，理由写在 `src/host/routes.ts:13-21`：`?root=<path>`（任何 loopback 页面都能指向任意目录，`inspectProject` 还会在目标目录建 `index/`）与 `state.json` 的 `lastProjectRoot`（插件级单一值，可能属于另一本书）。`src/host/state.ts:1-13` 也已把该值降级为"仅展示，永不作解析来源"。

宿主事实（W0 探针结论，见本文「验证」的 E1–E3）：

4. `sidebar.panellist` 与 `main` 是 **root 作用域**：拿不到"当前会话属于哪个工作区"。
5. `conversation.view` 是 **session 作用域**（与「对话 / 轨迹」同栏）；其 standardProps 提供 `useWorkspaces`（items 含 `path`）与 `useSessions`（含 `cwd`）。
6. 第三方插件**不能**用官方 `@Remote`：需要 Typert 生成产物（schema 注册项）+ Zod 工厂，而生成器未随 App 发布 → 纯 TS 第三方插件没有官方 RPC 面。
7. Host 侧存在可用的会话 → 目录解析面：`sessions.get(id)` → `Session`（`SessionHeader.cwd`）、`workingDirectory.get(session)`、`workspaceRegistry.list()`（`Workspace.path` 经 `fs.realpath` 规范化，`Workspace.sessionIds` 与会话关联）。

产品口径（本文的前提）：

8. **删除对外 HTTP API**：不版本化、不自描述（OpenAPI）、不对外文档化、不承诺兼容；未来远程同步走"每书 git remote / 对象存储"，不写自建 API 服务端。面板仍需一条数据通道，但它是**内部实现**，不是 API。

## 决策

### D1 入口：只有 `conversation.view`

- 唯一入口：`conversation.view`，`id: inkflow`，`order: 40`（与「对话 / 轨迹」同栏）。
- **撤掉** `sidebar.panellist` 与 `main` 的注册（`src/client/index.tsx:311-318` 两处 `slots.inject` 全部删除）。
- 理由：面板的语义是"这本书的驾驶舱"，而"这本书"只能从会话推出；root 作用域插槽没有会话，只剩"上次打开的书"这条已删的捷径（背景 3）。

### D2 通道定性：`/inkflow/internal/*` **不是 API**

| 维度 | 决定 |
|---|---|
| 定位 | 面板与 Host 之间的**内部实现细节**，不是对外接口 |
| 版本化 | 无。路径里不出现 `/v1`；不承诺兼容，删改路由与两侧同一次发布 |
| 文档 | 不进 [docs/user-guide.md](../../docs/user-guide.md)、不提供 OpenAPI / 自描述、不承诺给第三方或 MCP 使用 |
| 消费方 | 只有本插件的 Client 半（同包、同版本发版，host/client 锁步） |
| 形状 | 路径 `/inkflow/internal/<域>`；信封 `{ok:true,value}` / `{ok:false,error:{code}}`（沿用 ADR-0004 决策 6） |

### D3 路由加固：继承 ADR-0004，方法逐路由声明

**继承不变**：`Host` 必须匹配 loopback（否则 403 `forbidden-host`）；`Origin` 存在时必须匹配 loopback origin（否则 403 `forbidden-origin`）；不发任何 CORS 头；响应 `Cache-Control: no-store` + `X-Content-Type-Options: nosniff`；未知路径 404；密钥永不下发浏览器；本机其他进程**不在**威胁模型内。

**收窄 / 调整**（相对 ADR-0004 决策 3、4）：

- 方法白名单从"P0 仅 GET"改为**逐路由声明**：读路由只 GET；写路由（如"确认并应用一次向导动作"）只 POST，且必须 `Content-Type: application/json`（否则 415）、请求体必须是对象。
- 写路由额外要求 **`Origin` 存在**且为 loopback（只读路由允许缺省 `Origin`）——同源校验只对会产生写入的请求强制。
- 前缀仍是 `/inkflow`，语义段改为 `/internal/`；`/inkflow/api/*` **一律 404**，不留兼容别名（它从不是对外契约）。

### D4 客户端只传 `sessionId`，Host 解析路径

- Client 只发送 `sessionId`（读：查询参数；写：请求体）+ 路由语义参数。
- **永不接受路径类参数**：`root`、`path`、`cwd` 出现在 query 或 body 即 400 `unexpected-path-param`，且不触达文件系统。
- Host 解析顺序（命中即停）：
  1. `workspaceRegistry.list()` 中 `sessionIds` 包含该会话的 `Workspace.path`（宿主已 `fs.realpath` 规范化）；
  2. `workingDirectory.get(sessions.get(sessionId))` 的当前有效目录；
  3. 都失败 → 结构化拒绝 `NO_SESSION_CONTEXT`（HTTP 200 + `ok:false`：这是"还答不了"，不是传输故障），**零写盘**。
- 解析出的根仍要过 [ADR-0006](0006-workspace-contract-v2.md) D2 的四态门禁；非 `usable` 时返回同一份结构化清单（`state` / `checks` / `missing` / `actions` / `readOnly`），面板不自己兜底。

### D5 与工具、与门禁的一致性

- 面板与 `inkflow_*` 工具**共用同一套**解析与判定：同一 `projectRoot` 语义、同一四态、同一 `actions[]`。
- 面板不做"只读模式下的自动修复"：`needs-repair` / `needs-setup` 下的写入只能由用户确认后的向导动作触发（ADR-0006 D3）。
- 面板访问**不更新** `state.json`（`lastProjectRoot` 不因面板请求而改变），避免面板成为新的隐式解析来源。

### D6 契约测试（每个 internal 路由四条）

1. 伪造 `Host` → 403 `forbidden-host`；
2. 跨站 `Origin` → 403 `forbidden-origin`；
3. 非白名单方法 → 405；写路由缺 `Content-Type` → 415；非对象体 → 400；
4. 会话无法解析 → 结构化拒绝，且**项目根全量 hash 前后一致**（零写盘）。

### D7 再评估触发条件（满足任一条即重审本文）

| 触发 | 动作 |
|---|---|
| 官方发布第三方可用的 `@Remote`（文档化契约 + 生成器随包发布） | 删私有通道，面板改装 `@Remote`；`/inkflow/internal/*` 一并移除 |
| 官方为 `conversation.view` 或其替代提供正式的"会话 → 工作区"契约（含 Host 侧读取 API） | 简化 D4 的解析链，重审是否还需要自有通道 |
| 宿主改变插槽作用域（例如 root 插槽也能拿到工作区） | 重审 D1（是否需要第二处入口） |
| 出现"插件作为服务被其他 agent 调用"的真实需求 | 另立 ADR 讨论对外接口；本文明确删除的那部分不自动复活 |

## 备选与取舍

| 方案 | 优点 | 代价 | 为什么没选 |
|---|---|---|---|
| 保留**对外 HTTP API**（`/v1` + OpenAPI + 供其他 agent 调用） | 可被第三方集成；未来远程同步有现成面 | 要承诺版本兼容、要设计鉴权、要写对外文档；而插件形态是"嵌入 DSH 的单机工作台"，没有第二个消费者 | 没有消费方的对外契约只会腐化成负担；远程同步已定为"每书 git remote"，不需要自建 API |
| 用官方 `@Remote` / Typert RPC 做数据面 | 不自建通道；类型与 schema 由官方管 | 需 Typert 生成产物 + Zod 工厂，生成器未随 App 发布 → 纯 TS 第三方插件做不出来 | 当前不可行；改设 D7 触发条件，官方支持后立刻删私有通道 |
| 保留 `sidebar.panellist` + `main` 入口 | 全局图标常驻，任意页面可见 | root 作用域拿不到工作区，只能靠"上次项目"或让客户端传路径 | 前者是 ADR-0006 D5 删掉的数据安全问题，后者是 `routes.ts:13-21` 记录的攻击面 |
| 客户端把 `workspace.path`（或 `root`）传给 Host | 少一次会话解析，Client 侧本来就有 `path` | 任何 loopback 页面都能构造请求指向任意目录；Host 还会在目标目录建 `index/` | 路径必须由 Host 从会话推出，不能让调用方指定（D4） |
| Client 直接读文件（`uiWorkspace` / `workspaceFiles`） | 连通道都不用 | 客户端只有 `uiWorkspace.listDirectory/pickDirectory/createDirectory`，**不能读内容、不能写文件**；`workspaceFiles` 只读且同样依赖 Typert | 能力不足，且只读满足不了向导的写动作 |
| 把 MCP 工具当 RPC（面板调用 `inkflow_*`） | 免新通道；工具已有校验与信封 | MCP 工具是**模型面**契约（有叙述包装、按 Agent 装配），不是浏览器面请求；同期决定删 MCP 双通道 | 语义错配：面板要的是"这本书的状态投影"，不是给模型看的工具输出 |
| 保留 `state.json.lastProjectRoot` 作为兜底 | 面板"总有点东西可显示" | A 工作区的面板会显示（甚至写入）B 的书 | 数据安全 > 体验；ADR-0006 D5 已删 |

## 后果

### 正面

- 面板与"当前这本书的会话"一一对应，不存在"面板指向另一本书"的路径。
- 入口只有一处，去掉两套注册与"图标有、页面没有"这类失配（[AGENTS.md](../../AGENTS.md) §8 陷阱 3 的成因）。
- 攻击面小于对外 API：不文档化、不版本化、不接受路径参数、逐路由方法白名单。
- 与工具共用一条解析链，面板看到的四态就是工具看到的四态。

### 负面

- 私有通道与宿主插槽 / RPC 形状耦合：宿主升级改动插槽作用域或 props 时必须跟着改（D7 负责触发重审）。
- 面板**必须**在书会话里打开；没有会话上下文时只能显示"无法定位项目"。
- 没有 OpenAPI / 版本化 → 将来若真需要对外集成，不能复用这条通道，要另立 ADR。

### 风险

| 风险 | 触发条件 | 对策 |
|---|---|---|
| 宿主改插槽名 / 作用域，面板静默消失 | DSH 升级 | 启动自检插槽存在性并 warn；契约测试覆盖注册形状；D7 触发重审 |
| 会话 → 工作区解析失败 | 会话来自非书目录、会话已归档 | 结构化拒绝 + `actions[]`（"在该书目录新开会话"），零写盘 |
| 私有通道被本机其他进程探测 | 任意本机进程 | 明确不承担该威胁（ADR-0004 背景第 3 条）；仍保持 loopback + 无 CORS + 不文档化 |
| 官方已支持 `@Remote` 而私有通道被保留 | 惰性 | D7 写成触发条件而非"以后再说" |

## 验证

### 证据附录（W0 探针，issue #12 收尾评论；报告为过程稿，按 D7 不入库）

| 编号 | 结论 | 判据 / 证据 |
|---|---|---|
| E1 | `sidebar.panellist` / `main` 为 root 作用域；`conversation.view` 为 session 作用域且 standardProps 有 `useWorkspaces`（items 含 `path`）与 `useSessions`（含 `cwd`） | 读取 DSH 0.2.1-rc.2 打包 Client 模块的 `standardProps` 声明（client inspect 两次超时，改读打包产物）→ 本文 D1 |
| E2 | 第三方 `@Remote` 不可行 | Typert loader / protocol 源码：需生成产物（schema 注册项）+ Zod 工厂，生成器未随 App 发布 → 本文 D2/D7 |
| E3 | Host 侧会话 → 目录解析面存在 | `workspaceRegistry`（`Workspace.path` 经 `fs.realpath` 规范化、`Workspace.sessionIds`）、`workingDirectory.get(session)`、`sessions.get(id)` 的 Host Service 契约 → 本文 D4 |

### 判据（**验收判据，不是现状陈述**；用例落在 `tests/`，实测证据贴对应 PR 评论、不入库）

| # | 场景 | 期望（判据） |
|---|---|---|
| V1 | 注册面板 | 只有 `conversation.view` 一处；`sidebar.panellist` / `main` 无注册 |
| V2 | 伪造 `Host: evil.example` | 403 `forbidden-host`；读路由 / 写路由 / 未知路径 / 旧 `/api/*` 表现一致 |
| V3 | 跨站 `Origin` | 403 `forbidden-origin` |
| V4 | 写路由缺 `Content-Type`、或请求体非对象 | 415 / 400，均不落盘 |
| V5 | 请求带 `?root=`，或 body 内含 `path` | 400 `unexpected-path-param`，不触达文件系统 |
| V6 | 会话能解析到书 A，而 `state.json.lastProjectRoot` 指向书 B | 返回书 A 的投影；不读、不写书 B；`state.json` 内容 hash 前后一致 |
| V7 | 会话解析失败 | 200 `{ok:false,error:{code:'NO_SESSION_CONTEXT'}}` + `actions[]`；项目根全量 hash 前后一致 |
| V8 | `GET /inkflow/api/status` | 404（旧路径不留别名） |
| V9 | 非 `usable` 的书调用任一 internal 读路由 | 返回结构化清单（`state`/`checks`/`missing`/`actions`），零写盘 |
| V10 | 文档门禁 | `check-links` 0 断链；`pnpm.cmd run check` 全绿 |
