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
| `src/host/probe.ts` | 可选 Host 服务的结构化探测（形状校验 + 降级）、错误文本 | 任何业务规则 |
| `src/host/skills.ts` | 5 个写作技能的读取与校验、按 cwd 门禁的 provider、注册与降级 | 写作品数据、生成正文 |
| `src/host/preset.ts` | 写作 preset 的声明（人设 + 工具行）、注册与降级 | 其他插件的业务逻辑、技能正文 |
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
| 用 `ctx.skills.register()` 注册随包技能 | 落到**全局层**：所有会话（含代码会话）的技能目录都被塞进小说技能 | 走 `registerProvider` + `cwd` 门禁（§4.6） |
| 技能 provider 的 `list()` 返回「不完整观测」 | `dsh-tool-skill` 会**停发整个技能目录**，不是只少几个技能 | 无技能时返回空数组 |

## 9. 未验证 / 待确认

| 项 | 状态 | 计划 |
|---|---|---|
| 新 Host 代码在**运行中的 DSH** 里生效 | **未验证**（需重启加载新 generation） | 用户重启后复核工具表 |
| 面板视觉（六目录勾选、章节列表） | 未验证 | 重启后目视 |
| 59 万字全量重建耗时 | 未验证 | P1 用真实库基准（当前样例 7 文件 10ms） |
| 面板的项目来源（会话 → 工作区） | 未做：路由当前 fail-closed 返回 `NO_SESSION_CONTEXT` | 按会话解析工作区后再镜像工具侧的作用域规则 |
| 增量重建 / 大文件流式解析 | 未做 | P1 |
| 写入器（原子替换 + 提案制） | 未做 | P1（P0 无写正文能力） |
| 写作 preset 在真实会话里挂载成功 | **未验证**：签名与行名来自 `cordis_inspect_query` 与官方 preset 声明，但本次没有重启后的名册/会话观测 | 重启 DSH 后看模式选择里是否出现「InkFlow 写作」，再在其中确认工具表无 shell、技能目录有 5 个 `inkflow-*` |
| 每个会话的 `cwd` 都非空 | 代码路径已确认（`dsh-tool-skill` 用 `workingDirectory.ensure`），真实会话**未观测** | 重启后在工作区外的会话里确认技能目录不含 `inkflow-*` |
| 5 个技能的实际写作效果 | **未验证**（未跑真实章节生成） | 用一章真实任务书跑 架构→起草→审校，人工判读 |
