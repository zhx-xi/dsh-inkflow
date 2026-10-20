# dsh-inkflow

> One [DeepSeek Harness](https://github.com/deepseek-ai) plugin for the **entire** long-form novel writing workflow — projects, volumes, chapters, outlines, characters, world settings, foreshadowing, timelines, an in-Harness workbench, and `inkflow_*` tools. Local-first, pure TypeScript, MIT.

**Why one plugin:** installing five writing plugins to get five features means five chances of plugin conflict and five upgrade paths to babysit. dsh-inkflow is deliberately a single bundle: one sidebar icon, one workbench page, one data model, one upgrade.

**Storage: files are the truth.** Every novel is its own git repository; the plugin reads and writes Markdown/JSON files, and keeps `index/inkflow.db` only as a **rebuildable query cache**. That is why plugin upgrades never touch existing projects and why there is no database migration to run — see [ADR-0005](.agents/adrs/0005-files-first-with-derived-index.md) and the directory contract in [.agents/specs/conventions.md](.agents/specs/conventions.md).

**Status: P0 (files-first skeleton, not usable for writing yet).** Verified against a real DSH 0.2.1-rc.2 install: project gate (git + six directories + `inkflow.json`), derived index rebuild with invariant checks, four `inkflow_*` tools, a loopback-only HTTP projection, and the workbench panel. Write tools and the editor land in P1 — see [.agents/specs/roadmap.md](.agents/specs/roadmap.md).

---

## 目录约定（约定大于配置）

一部小说 = 一个 git 仓库 = 一个项目根：

```
<book-root>/
├── inkflow.json      # 项目元信息（schemaVersion/title/author）
├── chapters/         # 正文（Markdown + frontmatter）
├── characters/       # 角色
├── world/            # 世界观 / 设定库（目录即分类）
├── outlines/         # 大纲（kind: overall|volume|chapter）
├── library/          # 资料（原始参考材料）
└── index/            # 派生索引（可删可重建，只 .gitkeep 进 git）
```

插件只在**同时满足**以下条件时工作：① 是 git 仓库；② 六个目录齐全；③ `inkflow.json` 可解析。缺任一条 → 工具返回 `NOT_AN_INKFLOW_PROJECT` 并列出缺什么。目录名**固定英文、不可配置**。

---

## 快速开始（开发者 / 本机试用）

```powershell
# 1. 克隆 + 构建（构建产物 lib/ 不入库）
git clone https://github.com/zhx-xi/dsh-inkflow.git
cd dsh-inkflow
pnpm.cmd install
pnpm.cmd run build

# 2. 自检（不需要 DSH 进程）
pnpm.cmd test

# 3. 安装进当前 DSH profile（会改动你的 profile，装完需重启 DSH）
#    推荐在 DSH 里用插件管理器：plugin_manager install_bundle，target = 本仓库绝对路径
#    或命令行：
dsh plugin --profile desktop add link:D:\develop\projects\dsh-inkflow
```

重启 DSH 后应看到：

- 左侧栏出现 **InkFlow** 图标（order 30，排在已有面板之后）；
- 点击打开整页「InkFlow 工作台」（章节列表 + 项目诊断 + 六目录勾选）；
- 工具列表出现 `inkflow_project_status` / `inkflow_project_init` / `inkflow_index_rebuild` / `inkflow_chapter_list`。

> ⚠️ 改完 `src/**` 必须 `pnpm run build` **并重启 DSH**：实测 HMR 只对新装 bundle 生效，改动已加载插件的 `lib/` 不会热替换（旧 generation 会继续跑）。

## 数据放在哪

| 内容 | 位置 | 进 git？ |
|---|---|---|
| 作品（正文/设定/大纲/资料） | 每个小说自己的 git 仓库 | ✅ 全部 |
| 派生索引 | `<book>/index/inkflow.db`（WAL） | ❌ 只 `.gitkeep` |
| 插件自身状态（lastProjectRoot） | `$DSH_HOME/inkflow/state.json` | — |
| HTTP 路由 | `/inkflow/api/status`、`/api/chapters`（只读） | — |

没有「作品库目录」这个配置：**项目在哪由 git 仓库和六个目录自己声明**。

## 插件配置

只保留两个键（其余都是约定）：

```yaml
- id: dsh-inkflow
  name: 'dsh-inkflow'
  config:
    dataDir: 'D:\\somewhere\\inkflow-state'  # 插件自身状态目录（默认 ~/.dsh/inkflow）
    serveHttp: true                          # 关闭则不注册 /inkflow/api/*
```

## 仓库结构

```
src/host/              Host 半（DSH Node 进程内）
  index.ts             apply(ctx, config)：注册工具与 HTTP 路由
  context.ts           本插件用到的 DSH Host 表面（手写结构类型，零运行时依赖）
  config.ts            配置解析（dataDir / serveHttp）
  conventions.ts       ★ 目录/文件约定的唯一常量来源（改约定先改这里）
  project.ts           门禁检测、inkflow.json 读写、项目脚手架
  frontmatter.ts       极简 frontmatter 解析（标量/内联数组/块数组/注释）
  indexer.ts           文件 → 派生索引 + 不变量校验（node:sqlite）
  state.ts             插件自身状态（lastProjectRoot），原子写
  tools.ts             inkflow_project_status / _init / _index_rebuild / _chapter_list
  routes.ts            /inkflow/api/*（只读投影，仅 loopback，fail-closed）
src/client/            Client 半（浏览器 React）
  index.tsx            侧栏图标 + 工作台整页
  context.ts           本插件用到的 DSH Client 表面（slots / layout）
scripts/build.mjs      esbuild 双半构建（Host ESM + Client module-loader factory）
tests/                 node:test 契约测试（不依赖 DSH 进程，13 条）
.agents/constitution/  项目章程、DSH 硬约束、工程纪律、数据安全政策
.agents/specs/         规范：产品范围 / 架构 / 目录约定 / 数据模型 / 路线图 + spec 索引
.agents/adrs/          决策记录 + 索引与决策速览
docs/                  用户使用手册（安装 / 使用 / 文件格式 / 排错 / FAQ）
AGENTS.md              AI 编码助手入口（权威源索引 + 高频纪律）
CLAUDE.md              Claude Code 入口（指向 AGENTS.md，不复制规则）
```

## 开发命令

| 命令 | 作用 |
|---|---|
| `pnpm.cmd run build` | 构建 `lib/index.js`（Host, ESM）与 `lib/client.js`（Client, module-loader factory） |
| `pnpm.cmd run typecheck` | `tsc --noEmit` |
| `pnpm.cmd test` | `node --test`，契约测试 |
| `pnpm.cmd run check` | typecheck + build + test |

## 硬约束（写代码前请读）

这些不是建议，是实测出来的事实，违反会静默失败：

1. **文件是唯一真相**：任何写正文/设定的代码必须落文件；索引只能由重建流程写入，禁止「改索引改数据」。
2. **升约只加不改**：`inkflow.json` 的 `schemaVersion` 与 frontmatter 字段只做增量；读不懂的高版本拒绝写入，不静默降级。
3. **插件 API 处于 rc 期**：只依赖 `ctx.*` 公共面，不 import Host 内部包；`engines.dsh` 钉 `>=0.2.1-rc.2`。
4. **`cordis.patch.yml` 新增行必须写在 `- insert:` 下**；裸 `- id:` 只能覆盖已存在的行，目标不存在时整条被**静默丢弃**。
5. **改了 `lib/` 必须重启 DSH**；HMR 只对新装 bundle 生效（实测：改代码后旧 generation 仍在跑）。
6. **禁止 iframe**、禁止 `document.body` 挂第二个应用、禁止 `require` 宿主 Client 包；UI 只能是 Slot 注册。
7. **禁止向 session log append 新 type 的事件**（会话会打不开）。
8. **插件无沙箱**：代码以用户权限在宿主进程里跑；读 `inkflow.json` 要容忍 UTF-8 BOM（Windows 工具会写）。
9. **HTTP 路由零鉴权**：面板 API 必须自校验 loopback Host/Origin，且只绑本机。

每条约束的验证依据与后果见 [.agents/specs/architecture.md](.agents/specs/architecture.md) 与 [.agents/adrs/](.agents/adrs/)。

## 路线图

P0 文件真相骨架 → P1 写入器/提案制 + 全量工具面 + 工作台编辑器 → P2 提取管线与写作 skills → P3 门禁与审稿 → P4 系列共享设定与历法/KG → P5 同世界观同步与发布。估工与每阶段 DoD 见 [.agents/specs/roadmap.md](.agents/specs/roadmap.md)。

## 许可证

MIT。参考实现（novel-forge / novel-studio / Openwrite / dsh-memory-evolve 等）均为 MIT/Apache-2.0，借用的片段在文件头保留原声明并在 PR 说明中标明「参考了什么、如何改写」。
