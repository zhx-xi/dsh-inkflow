# dsh-inkflow 架构

> 状态：P0（骨架已在本机 DSH 0.2.1-rc.2 上实测）。
> 本文只写**已验证**的契约；未验证的推测单独标注。所有 DSH 侧签名来自 `cordis_inspect_query` 的 Host/Client Service 与 Slot 契约（2026-10-21 实测），不是凭记忆。

## 1. 一句话架构

一个 Cordis bundle，两半：**Host 半**在 DSH Node 进程内注册工具与 loopback HTTP 路由并持有 SQLite；**Client 半**在 DSH Web 页面里注册「左侧栏图标 + main 整页工作台」。DSH 自带的能力（agent 循环、chat、skills、memory、模型配置、审批、日志）**全部复用，不重造**。

```
┌───────────────────────── DSH 0.2.1-rc.2 (Electron / Web) ─────────────────────────┐
│  Agent loop / Chat UI / Skills / Memory / Logs / 模型与凭据        （复用，不改）    │
│                                                                                   │
│  dsh-inkflow bundle                                                               │
│  ├─ Host 半  (lib/index.js)                                                       │
│  │    ctx.tools.register(...)        → inkflow_* 工具（P0: 3 个）                  │
│  │    ctx.webServer.register(prefix) → /inkflow/api/*（仅 loopback，fail-closed）   │
│  │    ctx.effect(...)                → 注册与 DB 生命周期                           │
│  │    node:sqlite                    → $DSH_HOME/inkflow/inkflow.db               │
│  └─ Client 半 (lib/client.js)                                                      │
│       ctx.slots.inject('main')                 → 整页工作台（key = 'inkflow'）      │
│       ctx.slots.inject('sidebar.panellist')    → 左侧栏图标（id = 'inkflow'）      │
└───────────────────────────────────────────────────────────────────────────────────┘
                                   │ 同源 fetch（127.0.0.1:2149）
                                   ▼
                        /inkflow/api/health · /api/projects
```

**刻意不做的**：不内嵌 Python 内核（用户已拍板纯 TS）、不用 iframe 嵌旧 InkFlow Web UI、不自研 Chat UI / agent 编排、不拆多个插件、第一阶段不做远程同步与账号。

## 2. DSH 集成点（实测签名 + 使用方式）

### 2.1 工具注册 — `ctx.tools`

| 项 | 契约（实测） |
|---|---|
| 服务获取 | `inject: ['tools']` → `ctx.tools` |
| 注册 | `ctx.tools.register(definition: ToolDefinition): () => void` |
| 去重 | 同一层重复名报错；`run_code` 为保留名 |
| 注册即进 prompt | 无需额外声明，schema 自动进入 system prompt 的工具表 |
| 可见性 | 全局注册对所有 agent 可见；`ctx.tools.restrict/guard` 可收窄 |

`ToolDefinition` 关键字段（P0 只用到这些）：

```ts
{
  name: string
  description: string
  parameters: Record<string, unknown>   // 原始 JSON Schema（不是 defineTool DSL）
  output: {
    schema: JsonSchemaNode              // 返回值形状
    render(args, value): ContentBlock[] // 必须是 [{ type: 'text', text }]
  }
  execute(args, exec): Promise<unknown> // exec.signal 必须被观察
}
```

**为什么要手写原始 JSON Schema 而不是 `defineTool`**：`defineTool` 来自 `@deepseek-ai/dsh-tools`，而本插件**零运行时依赖**（见 §3.1）。两者在 registry 里等价——`defineTool` 只是把 DSL 归一化成同一份 JSON Schema。

### 2.2 HTTP 路由 — `ctx.webServer`

| 项 | 契约（实测） |
|---|---|
| 注册 | `ctx.webServer.register(route: WebRoute): () => void` |
| WebRoute | `{ kind: 'exact' \| 'prefix', path, handler(req: IncomingMessage, res: ServerResponse) }` |
| 重复 | 相同 (kind, path) 重复注册会 throw |
| 鉴权 | **无**。整个 webServer 是浏览器 HTTP 载体，不带 cookie/会话鉴权 |

因此 `/inkflow` 前缀路由**必须自己 fail-closed**（详见 ADR-0004）：

1. `Host` 头必须是 loopback authority（`127.0.0.1` / `localhost` / `[::1]`）——抵御 DNS rebinding；
2. `Origin` 头存在时必须是 loopback origin——抵御跨站 fetch；
3. 方法白名单（P0 只允许 GET）；P1 的写接口额外要求 `Content-Type: application/json`；
4. 永不发 CORS 头，浏览器默认拒绝跨源读取。

### 2.3 Client 槽位 — `ctx.slots`

| 槽位 | 种类 | 注册参数 | 用途 |
|---|---|---|---|
| `main` | keyed | `{ name: 'main', key }` | 中央面板；`key` 由左侧栏 entry id 派发 |
| `sidebar.panellist` | list | `{ name: 'sidebar.panellist', id, order, label }` | 左侧栏图标；**id 与 main 的 key 必须一致**才能互相寻址 |

- `main` 已占用 key：`conversation`（保留给会话）；我们的 `key: 'inkflow'` 是新单元。
- panellist 组件收到的 props 是 `{ size: number, active: boolean }`（`SidebarPanelIconOwnerProps`）。
- 面板路由跳转用 `ctx.layout.selectPanel('inkflow')`（P0 未用到：点图标即由 sidebar 派发）。
- 注册必须包在 `ctx.effect(() => ctx.slots.inject(...))` 里，卸载时自动撤。

### 2.4 主题 — 只用 `--dsw-alias-*`

实测可用的 token（`Theme.listTokens`，全部要求明暗双份）：`--dsw-alias-bg-base`、`bg-layer-1`、`bg-layer-2`、`bg-overlay`、`border-l1`、`border-l2`、`brand-primary`、`label-primary`、`label-secondary`、`state-error-primary`、`state-idle-primary`、`state-success-primary`、`state-warn-primary`、`--dsw-specific-sidebar-fill`。

规则：容器与控件只用 token；字面色只用于图标/插画。**不许** `require('@deepseek-ai/dsh-client-ui-primitives')`，需要在需要控件时按宿主样式自己写。

### 2.5 生命周期 — `ctx.effect`

所有注册都写成 `ctx.effect(() => resource)`，返回的 disposer 在插件卸载 / HMR 替换时调用。P0 用它管：数据库关闭、每个工具注册、每条路由、每个槽位注入。

## 3. 四个工程决策（详见 ADR）

### 3.1 零运行时依赖

`package.json` 里没有 `dependencies`。插件**不在运行时 import 任何 `@deepseek-ai/*`**：profile 的 `node_modules` 只有极少数 `@deepseek-ai/*` 包（实测只有 `cosmokit`、`schemastery`），依赖宿主解析是未文档化且随版本漂移的赌注。代价是要手写几十行结构类型（`src/host/context.ts`、`src/client/context.ts`），收益是升级 DSH 时最不容易碎。

### 3.2 SQLite 是真相源

`node:sqlite`（宿主 Node 24 内置，**不用 better-sqlite3**，避免原生编译）。库文件 `$DSH_HOME/inkflow/inkflow.db`；迁移用 `PRAGMA user_version` 顺序版本化，**不做不可重放的 `ensure_*` 式补丁**（旧 InkFlow 52 个 ensure_* 的直接教训）。

每张可变表带 `rev / updated_at / device_id`，写操作同步追加 `change_log`，删除用 `deleted_at` tombstone——这样 2.0 加同步时只改传输层，不动表结构。

### 3.3 单一构建工具链（esbuild）

`lib/index.js` = Host ESM bundle；`lib/client.js` = CJS bundle 外面套 `window.__ModuleLoader__.load({id, factory})`。Client 半必须是这个字节形状：React 等平台模块通过工厂注入的 `require` 解析，其余全部内联。esbuild 的 banner/footer + `format:'cjs'` 正好产出该形状，且该模式已在 shipped 插件（dsh-memory-evolve）验证。

**与原始计划的偏离**：用户建议的 P0 构建链是 tsdown。P0 选择 esbuild 单工具链，原因是 Client 半的 loader 包装本来就需要 banner/footer，双工具链只是多一处失败面。若后续需要为库消费者产出 `.d.ts`，再把 Host 半换成 tsdown（见 ADR-0003）。

### 3.4 面板 API 只绑 loopback 且自校验

见 §2.2 与 ADR-0004。补充：`X-InkFlow-Token` 这类密钥**永远不下发浏览器**；P0 根本没有 token——路由只读、只本机、只同源。

## 4. 数据流（P0 实测路径）

```
Workbench (React)
  └─ fetch('/inkflow/api/health')
       └─ Host handler  ── 校验 Host/Origin → 查 countProjects(db)
            └─ node:sqlite  ── <dataDir>/inkflow.db
  └─ render 自检卡片（路径 / schema 版本 / 项目数）
```

Agent 侧同源能力走工具而不是 HTTP：

```
Agent ── inkflow_project_create{title} ──► createProject() ──► projects + change_log
      ── inkflow_project_list{}        ──► listProjects()   ──► 结构化结果 + 渲染文本
```

## 5. 目录与模块边界

| 模块 | 只做 | 不做 |
|---|---|---|
| `src/host/index.ts` | 装配、生命周期、日志 | 业务逻辑 |
| `src/host/config.ts` | 配置解析与默认值 | 读文件、连库 |
| `src/host/db.ts` | DDL、迁移、仓储函数 | HTTP、prompt |
| `src/host/tools.ts` | 工具定义与参数/输出 schema | 直接 `new DatabaseSync()` |
| `src/host/routes.ts` | 路由 + 安全校验 + JSON 信封 | SQL |
| `src/client/index.tsx` | 视图、槽位注册、fetch | 业务规则、直连 SQL |

P1 起在 `src/host/` 下增加 `domain/`（纯函数：字数、去 AI 味、一致性规则）与 `tasks/`（断点续跑的后台队列），二者都不依赖 DSH，便于单测。

## 6. 已踩过的坑（写进代码注释，避免重犯）

| 坑 | 现象 | 规避 |
|---|---|---|
| patch 裸 `- id:` | 目标不存在时整条 patch 静默丢弃，无报错、无 UI 提示 | 新增行一律 `- insert:` 下挂 |
| HMR 不换 client generation | 改了客户端代码但界面没变 | 改完 `build` + **重启 DSH** |
| 缺少 `- insert:` 的 patch | 看起来 installed，实际没加载 | 装完用 Slot 树 / 工具表核对，而不是看日志 |
| `main` 与 `sidebar.panellist` 的 id 不一致 | 有图标没页面（或反之） | 两者共用一个常量 `PANEL_ID` |
| node:sqlite 的 `PRAGMA user_version` | 用 `prepare().get()` 读、`exec()` 写（不能参数化） | `db.ts` 里已封装 |

## 7. 未验证 / 待确认

| 项 | 状态 | 计划 |
|---|---|---|
| 一批 `inkflow_*` 工具（25–30 个）在模型侧的描述质量 | 未验证 | P1 用评测集对照，参考 `agent-experience` 技能 |
| `ctx.llm.stream` 直调（对话式改稿） | 未在本插件验证 | P2 探针 |
| `ctx.agents.create/resume` 驱动写作会话 | 未在本插件验证 | P2 探针 |
| 后台任务无通用调度器 | 已知限制 | 自建队列 + 落盘状态 + 看门狗（参考 memory-evolve COI） |
| 大库（59 万字）FTS5 检索性能 | 未验证 | P1 用真实库做基准 |
