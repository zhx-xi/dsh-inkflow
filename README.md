# dsh-inkflow

> One [DeepSeek Harness](https://github.com/deepseek-ai) plugin for the **entire** long-form novel writing workflow — projects, volumes, chapters, outlines, characters, world settings, foreshadowing, timelines, an in-Harness workbench, and `inkflow_*` tools. Local-first, pure TypeScript, MIT.

**Why one plugin:** installing five writing plugins to get five features means five chances of plugin conflict and five upgrade paths to babysit. dsh-inkflow is deliberately a single bundle: one sidebar icon, one workbench page, one data model, one upgrade.

**Status: P0 skeleton (not usable for writing yet).** What is verified working against a real DSH 0.2.1-rc.2 install are the four hard integration points: tool registration, a loopback-only HTTP route, SQLite persistence, and a workbench panel. The data model and the full tool surface land in P1 — see [docs/roadmap.md](docs/roadmap.md).

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
- 点击打开整页「InkFlow 长篇小说创作工作台」；
- 工具列表出现 `inkflow_health` / `inkflow_project_list` / `inkflow_project_create`；
- 页面里的「P0 自检」卡片显示本地库路径、schema 版本与项目数。

> ⚠️ 客户端 bundle 是预构建产物。改完 `src/client/**` 必须 `pnpm run build` **并重启 DSH**——DSH 的 HMR 不会加载新的 client generation。

## 数据放在哪

| 项 | 默认值 | 覆盖方式 |
|---|---|---|
| 插件状态目录 | `$DSH_HOME/inkflow`（即 `~/.dsh/inkflow`） | `cordis.patch.yml` 里本插件行的 `config.dataDir` |
| SQLite 库 | `<dataDir>/inkflow.db` | `config.dbFile` |
| HTTP 路由 | 开启，`/inkflow/api/*` | `config.serveHttp: false` 关闭 |

SQLite 是**真相源**；Markdown/JSON 导出只作为 git 备份格式。库文件**不进 git**：正文与设定属于用户，不属于仓库。

## 插件配置

在 profile 的 `cordis.patch.yml`（或 home patch）里按 id 覆盖本插件的行；`config` 是整体替换，不是深合并：

```yaml
- id: dsh-inkflow
  name: 'dsh-inkflow'
  config:
    dataDir: 'D:\\小说\\inkflow-dsh'   # 换作品库目录
    dbFile: 'inkflow.db'
    serveHttp: true
```

## 仓库结构

```
src/host/          Host 半（DSH Node 进程内）
  index.ts         apply(ctx, config)：注册工具、HTTP 路由，持有数据库生命周期
  context.ts       本插件用到的 DSH Host 表面（手写结构类型，零运行时依赖）
  config.ts        配置解析（dataDir / dbFile / serveHttp）
  db.ts            node:sqlite：连接、版本化迁移、projects/app_settings/change_log
  tools.ts         inkflow_* 工具定义（P0 三个）
  routes.ts        /inkflow/api/*（仅 loopback，fail-closed）
src/client/        Client 半（浏览器 React）
  index.tsx        侧栏图标 + 工作台整页（P0 占位）
  context.ts       本插件用到的 DSH Client 表面（slots / layout）
scripts/build.mjs  esbuild 双半构建（Host ESM + Client module-loader factory）
tests/             node:test 契约测试（不依赖 DSH 进程）
docs/              产品范围、架构、数据模型、路线图、ADR
```

## 开发命令

| 命令 | 作用 |
|---|---|
| `pnpm.cmd run build` | 构建 `lib/index.js`（Host, ESM）与 `lib/client.js`（Client, module-loader factory） |
| `pnpm.cmd run typecheck` | `tsc --noEmit` |
| `pnpm.cmd test` | `node --test`，契约测试 |
| `pnpm.cmd run check` | typecheck + build + test |

## 硬约束（写代码前请读）

这些不是建议，是实测出来的 DSH 事实，违反会静默失败：

1. **插件 API 处于 rc 期**：只依赖 `ctx.*` 公共面，不 import Host 内部包；`engines.dsh` 钉 `>=0.2.1-rc.2`。
2. **`cordis.patch.yml` 新增行必须写在 `- insert:` 下**；裸 `- id:` 只能覆盖已存在的行，目标不存在时整条被**静默丢弃**。
3. **改 Client bundle 必须重启 DSH**；HMR 不会加载新的 client generation。
4. **禁止 iframe**、禁止 `document.body` 挂第二个应用、禁止 `require` 宿主 Client 包；UI 只能是 Slot 注册。
5. **禁止向 session log append 新 type 的事件**（会话会打不开）；草稿/运行记录存自有 SQLite。
6. **插件无沙箱**：代码以用户权限在宿主进程里跑，输入校验与写保护自己担。
7. **HTTP 路由零鉴权**：面板 API 必须自校验 loopback Host/Origin，且只绑本机。

每条约束的验证依据与后果见 [docs/architecture.md](docs/architecture.md) 与 [docs/adr/](docs/adr/)。

## 路线图

P0 骨架 → P1 数据层与工具面 → P2 提取管线与写作 skills → P3 门禁与审稿 → P4 系列共享设定与历法/KG → P5 同世界观同步与发布。估工与每阶段 DoD 见 [docs/roadmap.md](docs/roadmap.md)。

## 许可证

MIT。参考实现（novel-forge / novel-studio / Openwrite / dsh-memory-evolve 等）均为 MIT/Apache-2.0，借用的片段在文件头保留原声明并在 PR 说明中标明「参考了什么、如何改写」。
