# AGENTS.md — AI 编码助手说明书

> **一句话**：DSH 插件项目（纯 TypeScript），**文件即真相** + SDD + TDD。动手写代码前先读 [.agents/constitution/constitution.md](.agents/constitution/constitution.md) 与相关的 [.agents/specs/](.agents/specs/)。
> 本文件只放**权威源索引 + 长期纪律**；**易变内容（待拍板、进度、版本、日期）一律不进本文件**（见 §9.6）。

## 0. 文件体系与权威源（先读）

| 文件 | 角色 | 何时读 |
|---|---|---|
| [.agents/constitution/constitution.md](.agents/constitution/constitution.md) | **最高依据**：核心原则 + 技术约束 + 质量门 + 治理 | 每次会话开始 |
| [.agents/constitution/hard-constraints.md](.agents/constitution/hard-constraints.md) | **DSH 宿主硬约束** H1–H11（违反会静默失败） | 碰插件装配/路由/UI/文件 IO 前 |
| [.agents/constitution/engineering-discipline.md](.agents/constitution/engineering-discipline.md) | SDD/TDD/评审/证据的执行细则（治理规则见 §9） | 写代码与提交前 |
| [.agents/constitution/data-safety.md](.agents/constitution/data-safety.md) | 数据边界、写入纪律、危险操作、路径与密钥安全 | 任何会写文件的操作前 |
| [.agents/specs/README.md](.agents/specs/README.md) | **spec 索引**（S-01…S-06）+ 编写规范 | 接新功能前 |
| [.agents/specs/conventions.md](.agents/specs/conventions.md) | **项目目录/文件契约**（九内容目录 + `index/` + `.gitkeep` + 四态门禁 + 向导） | 碰数据/路径/工具前 |
| [.agents/specs/data-model.md](.agents/specs/data-model.md) | 实体→文件映射、字段字典、派生索引表、不变量 | 碰数据结构前 |
| [.agents/specs/architecture.md](.agents/specs/architecture.md) | 模块边界、DSH 集成点实测签名、数据流 | 改结构/加模块前 |
| [.agents/specs/open-questions.md](.agents/specs/open-questions.md) | **待裁决清单**（唯一允许频繁更新的规范类文件） | 开工前 / 决策卡住时 |
| [.agents/adrs/README.md](.agents/adrs/README.md) | **ADR 索引 + 决策速览**（改代码前先查） | 做技术选型前 |
| [docs/user-guide.md](docs/user-guide.md) | **用户使用手册**（安装、使用、排错、FAQ）——面向插件使用者，不是规范 | 写用户可见行为时 |
| [package.json](package.json) / [scripts/build.mjs](scripts/build.mjs) | 构建入口、脚本、`engines.dsh` | 改构建/依赖时 |

放置规则：**纪律/政策** → `.agents/constitution/`；**规范** → `.agents/specs/`；**决策** → `.agents/adrs/`；**面向用户的手册** → `docs/`；**证据与过程稿** → issue / PR comment（不入库，见 §9.5 D7）。

## 1. 项目概览

**dsh-inkflow**：一个 DSH 插件（Host 半 + Client 半），用**一个插件**完成长篇小说创作全流程——项目/卷/章、大纲、人物、世界观、伏笔、时间线、工作台、`inkflow_*` 工具。
三个差异点：①旧稿/设定 → 结构化资料库的**提取管线**；②**系列共享设定 / 同世界观多故事**（插件级共享库 + 复制快照）；③**复用 OpenViking 的语义检索**（不自研 embedding / 向量库）。
范围、阶段与估工见 [S-05 roadmap](.agents/specs/roadmap.md)（阶段进度也在那里，不在本文件）。

## 2. 技术栈（易错项，无法从代码推导）

| 事实 | 说明 |
|---|---|
| 纯 TypeScript，**零运行时依赖** | `package.json` 的 `dependencies` 必须保持为空 |
| **不 import `@deepseek-ai/*`** | 宿主表面自己手写结构类型（`src/host/context.ts`、`src/client/context.ts`） |
| `node:sqlite` 只做**派生索引** | 不做真相源、不写迁移；schema 不符就删库重建 |
| 构建 = esbuild 双半 | Host → `lib/index.js`(ESM)；Client → `lib/client.js`(loader factory) |
| `lib/` 不入库 | 装之前必须 `pnpm.cmd run build` |
| Windows 用 `pnpm.cmd` | `pnpm.ps1` 会被执行策略拦；Node ≥ 22.12（宿主 Node 24） |
| `pnpm-workspace.yaml` 只放 `allowBuilds: esbuild` | pnpm 11 的依赖预检会因 esbuild 的 postinstall 被拒而让 `pnpm run check` 第一行就失败；CI 用 `--ignore-scripts`，不依赖这条 |

## 3. 目录约定（文件的真相）

一部小说 = 一个 git 仓库 = 一个项目根：`inkflow.json` + `chapters/ characters/ world/ outlines/ foreshadowing/ timeline/ relations/ facts/ library/` + `index/`（十项，每项带一个空的 `.gitkeep`）。
门禁四态（[ADR-0006](.agents/adrs/0006-workspace-contract-v2.md)）：`needs-newer-plugin` / `usable` / `needs-repair` / `needs-setup`，按序命中即停；非 `usable` 只允许向导（plan 只读 → apply 带 `confirm: true`，只补缺失项，`git init` 但不 commit/不配远端）。
目录名**固定英文、不可配置**——改约定必须**同一提交**内改 `src/host/conventions.ts` 与 [S-03](.agents/specs/conventions.md)。

## 4. 架构规则（不可违反）

```
✅ 写数据：工具 → io.ts（路径解析 + 写锁 + 原子替换）→ 文件（真相）→ 用户 git commit
✅ 读数据：工具/面板 → indexer（缺失或版本不符则重建）→ index/inkflow.db
✅ 面板数据：Client → /inkflow/internal/*（私有内部通道，不是对外 API）
❌ 禁止：改索引来改数据（索引是缓存，不是真相）
❌ 禁止：在随机目录建库/写文件（必须先过门禁）
❌ 禁止：client 半做文件 IO（只能 fetch /inkflow/internal/*）
❌ 禁止：tools.ts 直接扫目录（走 project.ts / indexer.ts）
```

- `src/host/conventions.ts` 是**目录/文件约定的唯一常量来源**；任何字面量目录名都应从那里取。
- 不变量靠「写入校验 + 索引重建校验」双重保障；新增不变量必须同时加重建期 code 与测试。
- 依赖方向：`client/index.tsx` → `client/context.ts`；Host 侧 `index.ts` → `tools.ts` / `routes.ts` → `{project,workspace,io,indexer,state,conventions}`。

## 5. 开发工作流（SDD + TDD）

```
Spec（改 .agents/specs/） → Test(RED) → Code(GREEN) → Refactor → pnpm run check → Commit
```

- **spec 先行**：spec 与实现矛盾 → 先改 spec，再改代码。
- **测试打构建产物**（`lib/index.js`），不是源码：测用户真正装到的东西。
- 提交前必过：`pnpm.cmd run check`（typecheck + build + test + 链接门禁 + 分支保护）。
- 分支保护是**机制**不是口令：`check` 末端的 `check:branch-protection` 需要 gh 已登录才有结论，输出 `SKIP …（未验证）` 表示**没验证**，不等于通过（[engineering-discipline §9.5「CI 门禁」](.agents/constitution/engineering-discipline.md)，与本节 §9.5 的文档门禁不同号不同事）。
- 提交信息：Conventional Commits，冒号后**小写**，例 `feat(tools): add inkflow_chapter_list`。

## 6. 编码规范

- TS **strict**；`verbatimModuleSyntax`（类型导入必须 `import type`）；不新增裸 `any`。
- 注释写「为什么」与宿主契约来源（例：`// DSH 0.2.1-rc.2 实测：...`），不写「改了什么」。
- 文件 IO：UTF-8 无 BOM、LF；**读取用户文件必须容忍 BOM/CRLF**；写入用「临时文件 + rename」原子替换。
- 纯函数优先（`frontmatter.ts`、`project.ts` 的判定逻辑），便于单测。
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
| 2 | 改完 `lib/` 直接测 | HMR 不热替换已加载插件，必须重启 DSH；面板出现 stale build 警告条（或启动日志说磁盘有更新构建）时先重启——刷新面板不会生效 |
| 2b | 客户端组件里把 `useXxx` 写在早退之后（`if (view === 'settings') return …`） | 切页时 hook 数量变化 → React 抛 "Rendered fewer hooks than expected" → **整页白屏**，界面不给原因。所有 hook 必须声明在第一个可能的 `return` 之前；`scripts/check-hooks-order.mjs`（`pnpm run check:guards` 的一环）用 AST 拦这一类 |
| 3 | 面板指错书 / 有图标没页面 | 入口按职责分两处：**书库** = root 的 `sidebar.panellist`（图标）+ `main`（主体，按 `key` 注册，缺 key 点击即抛错），**创作工作台** = session 的 `conversation.view`（[ADR-0010](.agents/adrs/0010-book-hub-entry.md)）。root 插槽拿不到工作区，书库的书单只能来自工作区注册表，不能靠"上次打开的书"猜（[ADR-0008](.agents/adrs/0008-panel-data-channel.md) D1 对工作台仍成立） |
| 4 | Windows 写 BOM | 读 `inkflow.json`/frontmatter 前剥 BOM |
| 5 | 给索引写 `ALTER TABLE` | 索引是缓存：改 schema 版本号 → 删库重建 |
| 6 | 把证据/过程稿写进仓库 | 证据 → issue/PR comment；仓库只留手册与规范 |
| 7 | 把「应该可以」写成「已验证」 | 未跑过的标【未验证】 |

## 9. 文档治理（ADR / spec / constitution）

> 本节是文档治理的**唯一入口**；模板与索引细则见 [.agents/adrs/README.md](.agents/adrs/README.md)、[.agents/specs/README.md](.agents/specs/README.md)。

### 9.1 五类内容的边界

| 想写的内容 | 放哪 | 变化频率 |
|---|---|---|
| 「必须/禁止做什么」（原则、硬约束、安全） | `.agents/constitution/` | 低 |
| 「是什么」（数据形状、契约、边界、验收） | `.agents/specs/` | 中 |
| 「为什么选 A 不选 B」 | `.agents/adrs/` | 低（只追加） |
| 「还没定，等裁决」 | `.agents/specs/open-questions.md` | **高（唯一允许频繁改）** |
| 「这东西怎么用」（面向使用者） | `docs/` | 中 |
| 「这次实测跑出了什么」 | **issue / PR comment**（不入库） | 高 |

### 9.2 ADR 治理（硬性）

| # | 规则 |
|---|---|
| A1 | **先 ADR 后代码**：技术选型、架构边界、数据格式、对外契约变更，必须先落 ADR 再改实现 |
| A2 | 编号 `NNNN-<kebab-slug>.md`，四位递增；**不复用、不跳号**；被删除/合并的编号也保留空缺 |
| A3 | 状态机：`提议 → 已采纳 → 已被 NNNN 取代`。被取代时**不改原文**，只改头部状态并指向新 ADR；新 ADR 注明取代关系 |
| A4 | 可按域分子目录，但**文件名与编号稳定**（不因目录重构改号，避免断外部引用）；移动用 `git mv` 保留历史 |
| A5 | 新增/变更后必须同步 [.agents/adrs/README.md](.agents/adrs/README.md)：索引表（编号/标题/状态/日期）+「决策速览」一行一条 |
| A6 | 必须含「备选与取舍」与「验证」；只写结论不写为什么不选别的，视为不合格 ADR |
| A7 | 代码与 ADR 不一致时：**以 ADR 为决策依据修代码**；若决策本身已变，先改 ADR 再改代码 |

### 9.3 Spec 治理（硬性）

| # | 规则 |
|---|---|
| S1 | spec 是功能的**唯一真相**；先改 spec 再改代码；实现与 spec 矛盾先修 spec 并说明理由 |
| S2 | 编号 `S-NN` 稳定不复用；合并/并入时保留旧编号并标「并入 S-xx（见附录）」；空号保留 |
| S3 | 一个文件一个域，**不按技术层拆分**；端/域只在头部标注 |
| S4 | 头部只留：`依据` / `依赖`（相对链接）/ `相关 ADR` / `状态`（活跃·草稿·已取代）；不写日期、版本号、进展、快速导航 |
| S5 | 必含章节：概述、数据形状、契约（工具/路由/文件格式）、边界与错误、验收判据、不在范围内、非功能（规模/延迟/降级各一行，无则写「不适用」）、验证命令 |
| S6 | 篇幅：单文件 **≤800 行**；超出且章节内聚可拆时，允许 `<spec>/references/` 子目录，spec 头部必须声明清单 |
| S7 | 不贴实现代码；决策集中在「决策表」（含备选列）；不写「修改履历」 |

### 9.4 Constitution 治理

| # | 规则 |
|---|---|
| C1 | 最高依据；与其他文档冲突时以章程为准，或**停下来指出冲突**交由用户裁决 |
| C2 | 修订分级：MAJOR = 删改原则；MINOR = 新增原则/约束；PATCH = 措辞澄清。修订需在 ADR 留痕（纯澄清除外） |
| C3 | 合规检查 = §5 的质量门 + 提交前自查清单（[engineering-discipline](.agents/constitution/engineering-discipline.md)） |

### 9.5 文档硬性门禁（跨类通用）

| # | 规则 | 违反后果 |
|---|---|---|
| D1 | 相对链接必须有效，提交前跑 `node scripts/check-links.mjs` | 断链 → 下一读者/agent 丢失权威源 |
| D2 | **不引用 gitignored 路径**（`.tmp/`、`lib/`、`node_modules/` 等） | 别人拿不到、且会被清理 |
| D3 | 不写进展叙事（「已实现」「已合入」「PR #NNN」「用户拍板 X」） | 噪声且随时间腐烂；归属是 git 历史 + ADR（ADR 头部允许日期/状态） |
| D4 | 来源逐条标注【已定】/【既有资料】/【推断】/【外部参考】；**推断不得标成已定**；推断集中进 open-questions | 污染用户决策 |
| D5 | 新增 spec/ADR 必须同步索引，否则视为未完成 | 索引与文件脱节 |
| D6 | 文档迁移/改名必须**同一提交**内修完所有相对链接 | 大规模断链 |
| D7 | **证据与过程稿不入库**：实测日志、探针输出、评审草稿、作废设计一律进 issue / PR comment（或临时文件），仓库只留规范、决策与用户手册 | 仓库被一次性材料污染 |

### 9.6 本文件（AGENTS.md）自身的稳定原则

- **只放**：权威源索引、长期纪律、高频陷阱、AI 行为准则。
- **不放**：待拍板清单（→ `open-questions.md`）、阶段进度（→ `roadmap.md`）、版本号与日期、临时排查记录。
- **改动门槛**：只有「新增/删除长期纪律」或「权威源变化」才改本文件；其余情况改对应文档。
- **篇幅上限**：约 150–250 行。逼近上限说明该把内容下沉到 constitution/specs，而不是继续往这里加。
- 判断方法：这条内容**半年后是否仍然成立**？是 → 可留在本文件；否 → 属于 open-questions / roadmap / issue。

## 10. AI 行为准则

### 10.1 Think Before Coding —— 不假设、不藏困惑

- 动手前**陈述假设**；不确定就问。
- 有多种合理解释时**全部呈现**，不要静默选一个。
- 有更简单的方案就说，该推回就推回。
- 架构点需要用户拍板时，给**选项 + 推荐 + 代价**，不要猜。

### 10.2 Simplicity First —— 最小可用，零投机

- 不做超范围功能；不为单次使用做抽象；不添加没人要的「灵活性」。
- 200 行能写成 50 行就重写。问自己：资深工程师会觉得这过度复杂吗？

### 10.3 测试哲学

- 不写无意义测试；测试必须能在代码损坏时 FAIL。
- 测试是契约：实现不得为了让测试过而改测试。

### 10.4 抑制必须带理由

- 每个 lint/type 抑制写明规则 + 理由；禁止裸 `@ts-ignore`。

### 10.5 工程惯例

- 组合优于继承、early return 优于深嵌套、显式优于隐式。
- 标准库优先；不手搓已有轮子。
- 无巨型文件（单文件 >600 行先考虑拆分；`pnpm run check:guards` 已把它变成机制——超 600 行的文件在 `scripts/check-guards.mjs` 的 `OVER_CAP_BUDGET` 里有显式预算，**只减不增**：新文件一律 ≤600，旧文件回到 600 以内时同一次改动里删掉它的条目）。
- 新代码全类型化；边界处先校验再进内部类型。

### 10.6 证据与来源

- 结论区分【已验证】/【未验证】，并给路径行号或命令输出；证据进 issue/PR comment。
- 只读取证优先；改动前给出根因与最小修复面。
- 写功能前先做外部参考对照（Openwrite / novel-forge / novel-studio / AI-Novel-Writer）：只学设计与交互，不搬代码；GPL 部分只读行为。对照结论与取舍写进 issue/PR，流程见 [engineering-discipline §8](.agents/constitution/engineering-discipline.md)。
- **合并前**要有一份独立评审结论；**声明完成前**由声明者本人重跑完整验证并引用本次输出（不采信子 agent 自述）。详见 [engineering-discipline §9](.agents/constitution/engineering-discipline.md)。
