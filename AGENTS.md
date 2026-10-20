# AGENTS.md — AI 编码助手说明书

> **一句话**：DSH 插件项目（纯 TypeScript），**文件即真相** + SDD + TDD。动手写代码前先读 [.agents/constitution/constitution.md](.agents/constitution/constitution.md) 与相关的 [.agents/specs/](.agents/specs/)。
> 本文件只放**索引 + 无法从代码推导的纪律**；规范细节一律看权威源，不在本文件复制（复制体必然漂移）。

## 0. 文件体系与权威源（先读）

| 文件 | 角色 | 何时读 |
|---|---|---|
| [.agents/constitution/constitution.md](.agents/constitution/constitution.md) | **最高依据**：6 条核心原则 + 技术约束 + 质量门 + 治理 | 每次会话开始 |
| [.agents/constitution/hard-constraints.md](.agents/constitution/hard-constraints.md) | **DSH 宿主硬约束** H1–H11（违反会静默失败） | 碰插件装配/路由/UI/文件 IO 前 |
| [.agents/constitution/engineering-discipline.md](.agents/constitution/engineering-discipline.md) | SDD/TDD/ADR/提交/评审/文档/证据纪律 | 写代码与提交前 |
| [.agents/constitution/data-safety.md](.agents/constitution/data-safety.md) | 数据边界、写入纪律、危险操作、路径与密钥安全 | 任何会写文件的操作前 |
| [.agents/specs/README.md](.agents/specs/README.md) | **spec 索引**（S-01…S-05）与编写规范 | 接新功能前 |
| [.agents/specs/conventions.md](.agents/specs/conventions.md) | **项目目录/文件契约**（六目录 + `inkflow.json` + 门禁） | 碰数据/路径/工具前 |
| [.agents/specs/data-model.md](.agents/specs/data-model.md) | 实体→文件映射、字段字典、派生索引表、不变量 | 碰数据结构前 |
| [.agents/specs/architecture.md](.agents/specs/architecture.md) | 模块边界、DSH 集成点实测签名、数据流 | 改结构/加模块前 |
| [.agents/adrs/README.md](.agents/adrs/README.md) | **ADR 索引 + 决策速览**（改代码前先查） | 做技术选型前 |
| [docs/](docs/) | **证据与归档**（验证记录、已作废设计），不是规范 | 需要复跑证据时 |
| [package.json](package.json) / [scripts/build.mjs](scripts/build.mjs) | 构建入口、脚本、`engines.dsh` | 改构建/依赖时 |

放置规则：**规范** → `.agents/specs/`；**决策** → `.agents/adrs/`；**纪律/政策** → `.agents/constitution/`；**证据/归档** → `docs/`。

## 1. 项目概览

**dsh-inkflow**：一个 DSH 插件（Host 半 + Client 半），用**一个插件**完成长篇小说创作全流程——项目/卷/章、大纲、人物、世界观、伏笔、时间线、工作台、`inkflow_*` 工具。
三个差异点：①旧稿/设定 → 结构化资料库的**提取管线**；②**系列共享设定 / 同世界观多故事**；③结构化深度（多纪元历法、双时间轴、知识图谱、地图）。
当前阶段：**P0 已交付**（文件真相骨架 + 4 个工具 + 工作台 + 派生索引），P1 待用户确认后开工。范围与估工见 [S-05 roadmap](.agents/specs/roadmap.md)。

## 2. 技术栈（易错项，无法从代码推导）

| 事实 | 说明 |
|---|---|
| 纯 TypeScript，**零运行时依赖** | `package.json` 的 `dependencies` 必须保持为空 |
| **不 import `@deepseek-ai/*`** | 宿主表面自己手写结构类型（`src/host/context.ts`、`src/client/context.ts`） |
| `node:sqlite` 只做**派生索引** | 不做真相源、不写迁移；schema 不符就删库重建 |
| 构建 = esbuild 双半 | Host → `lib/index.js`(ESM)；Client → `lib/client.js`(loader factory) |
| `lib/` 不入库 | 装之前必须 `pnpm.cmd run build` |
| Windows 用 `pnpm.cmd` | `pnpm.ps1` 会被执行策略拦；Node ≥ 22.12（宿主 Node 24） |

## 3. 目录约定（文件的真相）

一部小说 = 一个 git 仓库 = 一个项目根：`inkflow.json` + `chapters/ characters/ world/ outlines/ library/ index/`。
门禁三条全中才算项目：① 是 git 仓库 ② 六个目录齐全 ③ `inkflow.json` 可解析。
目录名**固定英文、不可配置**——改约定先改 `src/host/conventions.ts` 与 [S-03](.agents/specs/conventions.md)（同一提交）。

## 4. 架构规则（不可违反）

```
✅ 写数据：工具 → project/indexer → 文件（真相）→ 用户 git commit
✅ 读数据：工具/面板 → indexer（缺失或版本不符则重建）→ index/inkflow.db
❌ 禁止：改索引来改数据（索引是缓存，不是真相）
❌ 禁止：在随机目录建库/写文件（必须先过门禁）
❌ 禁止：client 半做文件 IO（只能 fetch /inkflow/api/*）
❌ 禁止：tools.ts 直接扫目录（走 project.ts / indexer.ts）
```

- `src/host/conventions.ts` 是**目录/文件约定的唯一常量来源**；任何字面量目录名都应从那里取。
- 不变量靠「写入校验 + 索引重建校验」双重保障；新增不变量必须同时加重建期 code 与测试。
- 组件依赖方向：`client/index.tsx` → `client/context.ts`；Host 侧 `index.ts` → `tools.ts` → `{project,indexer,state,conventions}`。

## 5. 开发工作流（SDD + TDD）

```
Spec（改 .agents/specs/） → Test(RED) → Code(GREEN) → Refactor → pnpm run check → Commit
```

- **spec 先行**：spec 与实现矛盾 → 先改 spec，再改代码。
- **测试打构建产物**（`lib/index.js`），不是源码：测用户真正装到的东西。
- 提交前必过：`pnpm.cmd run check`（typecheck + build + test）+ `node scripts/check-links.mjs`。
- 提交信息：Conventional Commits，冒号后**小写**，例 `feat(tools): add inkflow_chapter_list`。

## 6. 编码规范

- TS **strict**；`verbatimModuleSyntax`（import 类型必须 `import type`）；不新增裸 `any`。
- 注释写「为什么」与宿主契约来源（例：`// DSH 0.2.1-rc.2 实测：...`），不写「改了什么」。
- 文件 IO：UTF-8 无 BOM、LF；**读取用户文件必须容忍 BOM/CRLF**；写入用「临时文件 + rename」原子替换。
- 纯函数优先（`frontmatter.ts`、`project.ts` 的判定逻辑不做 IO 以外的事），便于单测。
- 可见文本走宿主主题 token（`--dsw-alias-*`）；不硬编码颜色（图标除外）。

## 7. 测试

- 框架：`node --test`；测试文件 `tests/*.test.js`（ESM），用临时目录 + 构造数据。
- 覆盖要求：Host 工具 / 门禁判定 / 索引重建 / 不变量 / HTTP 安全 / frontmatter 边界各至少一条。
- **每个不变量至少一条「它确实会拦住」的失败用例**。
- bug 修复必须带能精确复现根因的回归用例（例：UTF-8 BOM 导致项目判无效）。

## 8. 常见陷阱（高频）

| # | 陷阱 | 对策 |
|---|---|---|
| 1 | `cordis.patch.yml` 漏 `- insert:` | 新增行一律写在 `- insert:` 下（漏了整条静默丢弃） |
| 2 | 改完 `lib/` 直接测 | HMR 不热替换已加载插件，必须重启 DSH |
| 3 | 面板有图标没页面 | `sidebar.panellist.id` 与 `main.key` 必须是同一个 `PANEL_ID` |
| 4 | Windows 写 BOM | 读 `inkflow.json`/frontmatter 前剥 BOM |
| 5 | 给索引写 ALTER TABLE | 索引是缓存：改 schema 版本号 → 删库重建 |
| 6 | 在 `.tmp/` 里留证据并引用 | `.tmp/` 是 gitignored；长期证据放 `docs/` |
| 7 | 把「应该可以」写成「已验证」 | 未跑过的标【未验证】 |

## 9. AI 行为准则

### 9.1 Think Before Coding —— 不假设、不藏困惑

- 动手前**陈述假设**；不确定就问。
- 有多种合理解释时**全部呈现**，不要静默选一个。
- 有更简单的方案就说，该推回就推回。
- 架构点需要用户拍板时，给**选项 + 推荐 + 代价**，不要猜。

### 9.2 Simplicity First —— 最小可用，零投机

- 不做超范围功能；不为单次使用做抽象；不添加没人要的「灵活性」。
- 200 行能写成 50 行就重写。问自己：资深工程师会觉得这过度复杂吗？

### 9.3 测试哲学

- 不写无意义测试；测试必须能在代码损坏时 FAIL。
- 测试是契约：实现不得为了让测试过而改测试。

### 9.4 抑制必须带理由

- 每个 lint/type 抑制写明规则 + 理由；禁止裸 `@ts-ignore`。

### 9.5 工程惯例

- 组合优于继承、early return 优于深嵌套、显式优于隐式。
- 标准库优先；不手搓已有轮子。
- 无巨型文件（单文件 >600 行先考虑拆分）。
- 新代码全类型化；边界处先校验再进内部类型。

### 9.6 证据与来源

- 结论区分【已验证】/【未验证】，并给路径行号或命令输出。
- 写设计/规格时逐条标【已定】/【既有资料】/【推断】/【外部参考】；**绝不把推断标成已定**。

## 10. 文档纪律（摘要）

- 不写进展叙事（「已实现」「PR #NNN 已合」）：归属是 git 历史 + ADR。
- ADR 头部允许写状态与日期；正文不写「修改履历」。
- 不引用 `.tmp/` 等 gitignored 路径。
- 待裁决项集中在文末表格；拍板后转成「裁决记录」保留原话要点。

## 11. 当前待拍板（P1 开工前）

见 [S-03 conventions §8](.agents/specs/conventions.md) 与 [S-04 data-model §7](.agents/specs/data-model.md)：

1. `index/` 缺失自动重建是否接受（建议接受）；
2. 伏笔/时间线/知识关系/账本的归属子目录（已有建议值）；
3. 目录名是否就按 `chapters/characters/world/outlines/library/index`；
4. 每部小说一个 git 仓库与外层仓库的嵌套关系（建议外层 `.gitignore` 忽略各书目录）。
