# P0 技术验证记录（tech spike）

> 日期：2026-10-21
> 结论：**DSH 插件四件难事全部打通并通过实测** —— 能装能跑、工具能注册能调用、loopback 路由可用、`node:sqlite` 读写可用、Client 槽位可注册。
> 本文只记**实测**结果；未验证项在 §6 单列，不与已验证结论混写。

## 1. 环境基线（实测）

| 项 | 值 | 取证方式 |
|---|---|---|
| DSH 桌面版运行时 | `@deepseek-ai/dsh-desktop-runtime` 0.2.1-rc.2，Electron 44.7.0 | 可行性评估报告 §1 + profile 包版本 |
| DSH Web GUI | `http://127.0.0.1:2149` | 运行时上下文 |
| Profile | `desktop`，目录 `C:\Users\zhx-xi\.dsh\profiles\desktop` | `$env:DSH_PROFILE_DIR` |
| 宿主 Node | **v24.21.0** | `resources\runtime\primary-runtime\dependencies\node\bin\node.exe -v` |
| 宿主 SQLite（`node:sqlite`） | **3.53.4** | 用宿主 Node 跑 `select sqlite_version()` |
| 开发机 Node（非宿主） | v24.16.0 → SQLite 3.53.0 | `node -v` |
| pnpm | 11.18.0（开发机）/ 11.28.5（DSH 自带） | `pnpm --version`；安装日志 |
| 仓库 | `zhx-xi/dsh-inkflow`（public，MIT），本地 `D:\develop\projects\dsh-inkflow` | `gh repo create` 输出 |
| 数据目录 | `C:\Users\zhx-xi\.dsh\inkflow\inkflow.db`（WAL） | `/inkflow/api/health` 返回 |

> 注意：宿主 Node 与开发机 Node 的 SQLite 小版本不同（3.53.4 vs 3.53.0）。凡涉及 SQLite 行为的结论以**宿主**为准。

## 2. 构建与静态检查

| 验证项 | 结果 | 证据 |
|---|---|---|
| `tsc --noEmit`（严格模式） | 通过，退出码 0 | `pnpm.cmd run typecheck` |
| `pnpm.cmd run build` | 产出两半 | 见下 |
| `lib/index.js`（Host, ESM） | 17,179 B，`export { apply, inject, name }` | 文件 + `import()` 导出检查 |
| `lib/client.js`（Client, loader factory） | 13,178 B，首行 `window.__ModuleLoader__.load({`，末行 `return module.exports; } });`，`require("react")` 在工厂内 | `node --check lib/client.js` 退出码 0 |

## 3. 契约测试（不依赖 DSH 进程）

`pnpm.cmd test` → **5 passed / 0 failed**，覆盖：

| # | 用例 | 断言要点 |
|---|---|---|
| 1 | Host 插件形状 | `name === 'dsh-inkflow'`、`inject === ['tools']`、`apply` 为函数 |
| 2 | 注册面 | 3 个 `inkflow_*` 工具 + 1 条 `/inkflow` prefix 路由；每个工具描述 > 20 字符、parameters 为 object、有 output.schema 与 execute |
| 3 | SQLite 往返 | 建库 → create → list → 关闭 → 重开 → 数据仍在；`change_log` 恰 1 条 `insert`；`device_id` 为 UUID |
| 4 | HTTP 安全 | 正常 GET 200（带 `content-type`/`cache-control: no-store`）；伪造 `Host: evil.example.com` → 403；跨站 `Origin` → 403；同源 Origin → 200；POST → 405；未知路径 → 404 |
| 5 | 输入校验 | 空标题 create 抛 `title must not be empty`，不落库 |

## 4. 真机安装与运行时验证（desktop profile）

### 4.1 安装

`plugin_manager install_bundle`，target = `D:\develop\projects\dsh-inkflow`：

```json
{"stage":"enable","target":"dsh-inkflow","enabled":true,"changed":true,"application":"applied",
 "packageResult":{"exitCode":0,"output":"+ dsh-inkflow 0.0.1 <- D:\\develop\\projects\\dsh-inkflow"},
 "logPath":"C:\\Users\\zhx-xi\\.dsh\\profiles\\desktop\\.plugin-manager\\logs\\operation-jV4Oho\\pnpm.log"}
```

- `application: applied` → 无需重启即生效（**推翻**了「新装 bundle 必须重启」的预设；与官方文档「Installing a new bundle can activate through HMR」一致）。
- 唯一 warning 是既有皮肤包 `@linxin666/dsh-client-ui-skin-whale-song` 导入失败，**与本插件无关**（装前即存在）。

### 4.2 工具注册与调用

- 安装后本会话工具表立即多出 3 个 schema：`inkflow_health` / `inkflow_project_create` / `inkflow_project_list`（DSH 推送的 Updated Tool Schemas）。
- 实际调用 `inkflow_health` 返回：

```
InkFlow ok=true schema=v1 projects=0
dataDir: C:\Users\zhx-xi\.dsh\inkflow
db: C:\Users\zhx-xi\.dsh\inkflow\inkflow.db
```

### 4.3 写路径（工具 → SQLite）

| 步骤 | 结果 |
|---|---|
| `inkflow_project_create {title:"P0 自检样例", author:"dsh-inkflow P0", genre:"自检"}` | `Created project "P0 自检样例" (262e1bb5-389b-4545-b84b-5f8fa51d6a1c)` |
| `inkflow_project_list` | `1 project(s): - P0 自检样例 [draft] 0 chapters / 0 words — id 262e1bb5-…` |
| 清理（测试数据不留在用户库里） | 直接 SQL 删除该行 + 对应 change_log，`projectCount` 回到 0 |
| 清理后复核 | `{"ok":true,...,"projectCount":0}` / `{"total":0,"projects":[]}` |

### 4.4 HTTP 路由（浏览器同源路径，实测）

```
GET http://127.0.0.1:2149/inkflow/api/health  -> HTTP 200
content-type: application/json; charset=utf-8
cache-control: no-store
{"ok":true,"value":{"pluginVersion":"0.0.1","dataDir":"C:\\Users\\zhx-xi\\.dsh\\inkflow",
 "dbFile":"C:\\Users\\zhx-xi\\.dsh\\inkflow\\inkflow.db","schemaVersion":1,"projectCount":0}}

GET http://127.0.0.1:2149/inkflow/api/projects -> HTTP 200 {"ok":true,"value":{"total":0,"projects":[]}}
```

（403 / 405 的拒绝分支由 §3 用例 4 覆盖；浏览器侧无法伪造 Host 头，故不在真机重复。）

### 4.5 客户端槽位（live Slot 树）

`cordis_inspect_query` client `Slots.listSubTree`：

| 槽位 | 结果 |
|---|---|
| `sidebar.panellist` | occupants 新增 `{id:"inkflow", order:30, active:true}` |
| `main`（keyed） | occupants 新增 `{key:"inkflow", active:true}` |

即：Client 半已加载并完成两处注册，且 **active**。渲染外观需人眼确认（见 §6）。

### 4.6 数据落盘

```
C:\Users\zhx-xi\.dsh\inkflow\
  inkflow.db       4,096 B
  inkflow.db-shm  32,768 B
  inkflow.db-wal  49,472 B
```

## 5. `node:sqlite` 能力探针

数据模型（`.agents/specs/data-model.md`）依赖以下能力，全部实测可用：

| 能力 | 结果 |
|---|---|
| `json1`（`json_valid`） | 可用（`json_valid('{"a":1}') = 1`） |
| 生成列（`GENERATED ALWAYS AS … VIRTUAL`） | 可用（`a=3 → b=6`） |
| 复合外键 `FOREIGN KEY (pid, refid) REFERENCES p(pid, id)` | **强制生效**（插入不存在引用被拒） |
| 部分索引 `CREATE UNIQUE INDEX … WHERE deleted_at IS NULL` | 可用 |
| FTS5 + `tokenize='trigram'` | 可用；**3 字词命中 1 条**（白鹤门），**2 字词不命中**（苍山 → 0） |
| FTS5 默认 `unicode61` | 中文按整段切词，3 字词查询不命中 → 中文检索必须用 trigram 或自定义分词 |

结论：**中文检索策略定为 trigram（≥3 字）+ 2 字回退 `LIKE`**，与 roadmap R-07 / P0-5 一致。

## 6. 未验证 / 未完成（不得当作已通过）

| 项 | 状态 | 原因 / 下一步 |
|---|---|---|
| 面板视觉渲染（图标外观、三栏布局、深浅色） | **未验证** | 无浏览器控制；Slot 注册 active 只证明挂载，不证明观感。需用户重启/刷新后目视确认 |
| `iframe` 数量 = 0（P0 DoD-2） | **未验证** | 同上（代码层无 iframe，但未做 DOM 实测） |
| 重启 DSH 后插件仍生效 | **未验证** | 本次为 HMR 生效路径；重启持久性需用户下次重启时观察 |
| 卸载无残留（P0 DoD-6） | **未验证** | 未执行卸载 |
| 20 条中文检索用例（P0 DoD-5） | **未做** | 仅验证了机制可行性（§5），用例集留到 P1 检索功能落地时建立 |
| 大库（59 万字）FTS 性能 | **未验证** | P1 用真实库基准 |

## 7. 复跑命令

```powershell
cd D:\develop\projects\dsh-inkflow
pnpm.cmd install
pnpm.cmd run typecheck
pnpm.cmd run build
pnpm.cmd test
Invoke-WebRequest http://127.0.0.1:2149/inkflow/api/health -UseBasicParsing | Select-Object -Expand Content
# 宿主 SQLite 版本
& 'D:\program\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe' `
  -e "const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(':memory:');console.log(process.version, db.prepare('select sqlite_version() v').get().v)"
```


---

## 8. 架构变更后的补充验证（2026-10-21 下午：文件真相 + 派生索引）

> 背景：用户拍板改用「文件真相 + SQLite 派生索引」（[ADR-0005](../.agents/adrs/0005-files-first-with-derived-index.md)），P0 代码当日切换。§1–§7 记录的是切换前（SQLite 真相源）的证据，仍然有效；本节记录切换后的验证。

| 验证项 | 结果 | 证据 |
|---|---|---|
| `tsc --noEmit` | 通过 | 退出码 0 |
| 构建 | `lib/index.js`（host ESM）+ `lib/client.js`（loader factory） | `pnpm run build` |
| 契约测试 | **13 / 13 通过**（门禁 5 种组合、BOM 回归、索引重建、不变量、HTTP 安全、frontmatter 边界） | `tests/contract.test.js`，约 250 ms |
| 门禁：普通目录 | `NOT_AN_INKFLOW_PROJECT`，`missing` 含 `.git`／六个目录／`inkflow.json` | 测试用例 3 |
| 门禁：git 但缺目录 | `missing` 恰为 `outlines`、`world` | 测试用例 4 |
| 门禁：缺 `index/` | 自动重建并标 `indexDirRecreated: true`（派生物不锁死插件） | 测试用例 5 |
| 真实样例项目（`.tmp/sample-book`，git init + 7 个文件） | 门禁通过；重建 `files 7 / chapters 2 / characters 1 / world 1 / outlines 1 / library 1`，`issues: []`，10 ms | `.tmp/verify.mjs` 驱动**构建产物** lib/index.js |
| 派生索引文件 | 106,496 B，`PRAGMA user_version = 1`，`chapters_fts` 2 行，章行 seq/title/status/word_count 正确 | 同上 |
| HTTP 投影（构建产物 + 假 req） | `/inkflow/api/status` 200、`/inkflow/api/chapters` 200 | 同上 |
| **HMR 边界（重要）** | 修改已安装插件的 `lib/` **不会**热替换：运行中的 DSH 仍暴露旧的 3 个工具（`inkflow_health` 等） | `cordis_inspect_query` Tool.listTools |
| 真实文件坑：UTF-8 BOM | PowerShell `Set-Content -Encoding utf8` 写出的 `inkflow.json` 带 BOM，导致 `JSON.parse` 失败、项目被判无效 | 已修（读前剥 BOM）+ 回归测试 |
| 未验证 | 新代码在运行中 DSH 里生效（需重启）、面板视觉、59 万字重建耗时 | 见 architecture.md §9 |
