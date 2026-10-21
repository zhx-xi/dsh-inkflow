# dsh-inkflow 架构

> 状态：**v2（2026-10-21 架构变更：文件真相 + 派生索引）**。
> 本文只写**已验证**的契约；未验证的推测单列 §9。DSH 侧签名来自 `cordis_inspect_query` 的 Host/Client Service 与 Slot 契约（0.2.1-rc.2 实测）。

## 1. 一句话架构

一个 Cordis bundle，两半：**Host 半**在 DSH Node 进程内注册工具与 loopback HTTP 路由，**Client 半**注册「左侧栏图标 + main 整页工作台」。
**作品的真相是每个小说仓库里的 Markdown/JSON 文件**；SQLite 只是 `index/` 下可删可重建的查询缓存。DSH 自带的 agent 循环、chat、skills、memory、模型配置全部复用。

```
┌──────────────────── DSH 0.2.1-rc.2 (Electron / Web) ────────────────────┐
│ Agent loop / Chat / Skills / Memory / Logs / 模型与凭据   （复用，不改）   │
│                                                                        │
│ dsh-inkflow                                                            │
│ ├─ Host (lib/index.js)                                                 │
│ │    ctx.tools.register          → inkflow_project_status / _init /     │
│ │                                   _index_rebuild / _chapter_list      │
│ │    ctx.webServer.register      → /inkflow/api/status|chapters         │
│ │    node:fs  ← 读写文件（真相）                                         │
│ │    node:sqlite ← 只写 <project>/index/inkflow.db（缓存）               │
│ └─ Client (lib/client.js)                                              │
│      sidebar.panellist(id='inkflow') · main(key='inkflow')             │
└────────────────────────────────────────────────────────────────────────┘
        │ 每个小说一个 git 仓库
        ▼
  <book>/ { inkflow.json, chapters/ characters/ world/ outlines/ library/ index/ }
```

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

`findProjectRoot(start)` 从会话工作目录向上走，判定条件（[.agents/specs/conventions.md](conventions.md) §1）：

| 条件 | 检测 | 不满足时 |
|---|---|---|
| G1 是 git 仓库 | 根目录存在 `.git`（目录或 worktree 文件） | 返回 `NOT_AN_INKFLOW_PROJECT`，`missing` 含 `.git` |
| G2 六个目录齐全 | `chapters characters world outlines index library` | 同上，`missing` 列出具体目录 |
| G3 `inkflow.json` 可解析 | 存在 + `schemaVersion` 为整数（容忍 UTF-8 BOM） | 同上，`missing` 含 `inkflow.json` |

**唯一放宽**：`index/` 是派生物。当其余五项 + git + meta 齐全而 `index/` 缺失时，插件自动创建 `index/`（含 `.gitkeep`）并在结果里标 `indexDirRecreated: true`——否则删一次索引目录就等于永久锁死插件。

失败一律返回结构化清单（`checks` / `missing` / `reasons` / `hint`），不抛异常、不静默兜底、不在随机目录建库。

**会话目录来源**：优先 `ctx.get('workingDirectory').ensure(agent)`（公共服务，缺失时降级 `process.cwd()`）。工具也接受显式 `projectRoot`，但该路径必须 `realpath` 后落在**会话工作区子树**内；盘符根、家目录本身、系统与安装目录硬拒（`PATH_OUT_OF_SCOPE` / `PATH_FORBIDDEN`，写盘前拒绝）。跨会话状态 `state.json` 的 `lastProjectRoot` 只用于展示（启动日志），**不作为任何解析来源**——它是"某个会话最后碰过的书"，拿来兜底会把别人的书当成当前项目。

## 4. DSH 集成点（实测签名）

### 4.1 工具 — `ctx.tools`

`ctx.tools.register(definition: ToolDefinition): () => void`，注册即进 system prompt。本插件用**原始 JSON Schema**（`parameters`）+ 纯对象定义，不 import `defineTool`（零运行时依赖，见 §5.1）。`output.render(args, value)` 必须返回 `[{type:'text', text}]`。

### 4.2 HTTP — `ctx.webServer`

`ctx.webServer.register({kind:'prefix', path:'/inkflow', handler})`。**零鉴权**，因此 fail-closed（ADR-0004）：`Host` 必须 loopback、`Origin` 若存在必须 loopback、只允许 GET、不发 CORS 头、统一 `no-store` + `nosniff`。

请求不携带会话身份，所以在"会话 → 工作区"解析落地前，`/api/status` 与 `/api/chapters` **一律返回 `200 + ok:false + NO_SESSION_CONTEXT`**，且不读查询串、不读插件状态、不创建任何文件（详见 [conventions.md](conventions.md) §6.2）。这样面板在拿到解析能力前只会"不知道"，不会显示另一本书。

### 4.3 Client 槽位 — `ctx.slots`

| 槽位 | 类型 | 注册参数 | 说明 |
|---|---|---|---|
| `main` | keyed | `{name:'main', key:'inkflow'}` | 整页工作台 |
| `sidebar.panellist` | list | `{name:'sidebar.panellist', id:'inkflow', order:30, label}` | 左侧栏图标 |

两者 id/key 必须一致（共用一个常量 `PANEL_ID`）；注册包在 `ctx.effect(() => ctx.slots.inject(...))` 里。

### 4.4 主题

只用 `--dsw-alias-*`（明暗双份）：`bg-base`、`bg-layer-1/2`、`border-l1/l2`、`label-primary/secondary`、`state-success/warn/error/idle-primary`。字面色只用于图标。

### 4.5 生命周期

每个注册都写成 `ctx.effect(() => resource)`；索引库按调用开/关，进程内不持有长连接——因此**没有需要清理的常驻资源**。

## 5. 四个工程决策

### 5.1 零运行时依赖

`package.json` 无 `dependencies`。不 import 任何 `@deepseek-ai/*`，代价是手写结构类型（`src/host/context.ts`、`src/client/context.ts`），收益是 DSH 升级时不碎。

### 5.2 文件即真相，索引可弃

见 ADR-0005。关键纪律：**任何写正文/设定的操作必须落在文件上**；索引只能由重建流程写入，代码里不存在「改索引来改数据」的路径。

### 5.3 单一构建工具链（esbuild）

`lib/index.js` = Host ESM bundle；`lib/client.js` = CJS bundle 外套 `window.__ModuleLoader__.load({id, factory})`。Client 半必须是这个字节形状（React 走注入的 `require`，其余内联），esbuild 的 banner/footer + `format:'cjs'` 正好产出（[ADR-0003](../adrs/0003-build-chain.md)）。

### 5.4 面板 API 只读 + 只绑 loopback

工作台只需要读投影（status/chapters），P0 不开放任何写接口（ADR-0004）。写入走工具（模型侧），走 `inkflow_*` 的校验与未来的提案制。

## 6. 模块边界

| 模块 | 只做 | 不做 |
|---|---|---|
| `src/host/index.ts` | 装配、生命周期、日志 | 业务逻辑 |
| `src/host/conventions.ts` | **目录/文件约定的唯一常量来源** | 任何 IO |
| `src/host/project.ts` | 门禁检测、`inkflow.json` 读写、脚手架 | 索引 |
| `src/host/frontmatter.ts` | 极简 frontmatter 解析（标量/内联数组/块数组/注释） | 完整 YAML |
| `src/host/indexer.ts` | 扫描 → 派生索引 + 不变量校验 | 写真相文件 |
| `src/host/index-build.ts` | 索引重建的原子替换、进程内单飞、`index/.lock` | 解析文件格式 |
| `src/host/io.ts` | **唯一写入口**：路径解析、原子写、单项目写锁 | 业务规则、索引 |
| `src/host/state.ts` | 插件自身状态（lastProjectRoot），原子写 | 作品数据 |
| `src/host/tools.ts` | 工具 schema/执行/渲染 | 直接扫目录（走 indexer/project） |
| `src/host/routes.ts` | 只读投影 + 安全校验 | 写操作 |
| `src/client/index.tsx` | 视图、槽位注册、fetch | 业务规则、文件 IO |

## 7. 数据流

```
写：Agent → inkflow_* 工具 → io.ts（解析 + 写锁 + 原子写）→ git commit（用户/AI）
读：Agent → inkflow_* 工具 ─┐
    面板 → /inkflow/api/*  ─┴→ indexer（缺失/版本不符则重建）→ index/inkflow.db
```

- 索引重建是**全量**的（删除 + 重扫 + 事务写入），P1 再按需做增量（`files` 表的 mtime 是基础）。
- 正文仍在文件里；`chapters_fts` 只存副本用于检索。

## 8. 已踩过的坑（都写进了代码注释/测试）

| 坑 | 现象 | 规避 |
|---|---|---|
| patch 裸 `- id:` | 目标不存在时整条 patch 静默丢弃 | 新增行一律 `- insert:` |
| 改已装插件的 `lib/` | **HMR 只对新装 bundle 生效**，改代码不生效 | 改完必须重启 DSH（本次实测：旧 3 工具仍在运行） |
| `sidebar.panellist` 与 `main` 的 id 不一致 | 有图标没页面 | 共用 `PANEL_ID` 常量 |
| Windows 工具写 UTF-8 BOM | `JSON.parse` 抛错 → 项目被判无效 | 读 `inkflow.json` 前剥 BOM（已有回归测试） |
| `main` 已有 key `conversation` | 复用会被替换 | 用自有 key `inkflow` |
| `node:sqlite` 的 `PRAGMA user_version` | 只能 `prepare().get()` 读、`exec()` 写 | 已封装在 indexer |

## 9. 未验证 / 待确认

| 项 | 状态 | 计划 |
|---|---|---|
| 新 Host 代码在**运行中的 DSH** 里生效 | **未验证**（需重启加载新 generation） | 用户重启后复核工具表 |
| 面板视觉（六目录勾选、章节列表） | 未验证 | 重启后目视 |
| 59 万字全量重建耗时 | 未验证 | P1 用真实库基准（当前样例 7 文件 10ms） |
| 面板的项目来源（会话 → 工作区） | 未做：路由当前 fail-closed 返回 `NO_SESSION_CONTEXT` | 按会话解析工作区后再镜像工具侧的作用域规则 |
| 增量重建 / 大文件流式解析 | 未做 | P1 |
| 写入器（原子替换 + 提案制） | 未做 | P1（P0 无写正文能力） |
