# ADR-0006：工作区契约 v2（9 内容目录 / 四态门禁 / 卷章 catalog）

- 状态：**已采纳（用户拍板 2026-10-21）**
- 日期：2026-10-21
- 关系：[ADR-0005](0005-files-first-with-derived-index.md) **继续有效**；本 ADR 只修改它的**目录条款（原决策 4）与门禁条款（原决策 5）**，原决策 1（文件真相）/2（SQLite 派生索引）/3（不写数据库迁移）不变
- 影响：见下文「影响面」一节

## 背景

ADR-0005 确定的六目录 + 布尔门禁，在现行实现与使用中暴露出五个具体缺口（下文行号基于 `e3c6427`）：

1. **目录只有六项，四个域被挤进子目录**：现行 `src/host/conventions.ts:23-34` 的 `CONTENT_DIRS` 是 `chapters/characters/world/outlines/library`。伏笔、时间线、知识关系、事实账本没有一级归属，只能挂在 `world/`、`outlines/` 下面（[S-06](../specs/open-questions.md) 的 Q2 建议就是 `world/timeline/`、`world/facts/`、`world/relations.json`、`outlines/foreshadowing/`）。后果：门禁只能检查到一级目录，跨域查询要猜嵌套层级，目录树的"域"概念被目录层级掩盖。
2. **门禁是布尔的，三种不同处置被折叠成一句话**：`src/host/project.ts:126-183` 只产出 `usable: true/false` + 缺失清单；`src/host/tools.ts:84-100` 把所有失败统一成 `NOT_AN_INKFLOW_PROJECT`。而实际要做的动作完全不同：**新建一本书**（needs-setup）、**补齐缺失项**（needs-repair）、**升级插件**（meta 版本更高，needs-newer-plugin）。三者对用户是同一句"这不是 InkFlow 项目"，于是用户很可能在第三种情况下选择"修复"，而修复会覆盖新版本数据。
3. **空目录不进入 git**：git 不跟踪空目录（既有事实，现行 S-03 §3.7 只用 `index/.gitkeep` 兜底）。九目录里新书天然有多个空目录，`git clone` 后目录消失，门禁把"结构齐全的书"判成"缺目录"。
4. **卷章归属靠路径猜**：现行 S-03 §3.2 用 frontmatter 的 `volume` + 文件名派生章号，没有一份可审阅的卷章清单。目录改名或文件改名就会改变归属与顺序，且卷/章的完整结构无法 `git diff` 审阅。
5. **多项目兜底让"当前工作在哪个工作区"变得不确定**：`src/host/tools.ts:76-80` 与 `src/host/routes.ts:77` 用 `state.json` 的 `lastProjectRoot` 作为第三来源（`src/host/state.ts:12-47`）。在书 A 的工作区里未显式指定根时，可能静默读到上次打开的书 B，写操作就会写错项目。

约束不变：一个工作区 = 一部小说；零运行时依赖；不引入项目注册表/路径配置文件；不在随机目录建库（ADR-0005 决策 4/5 的动机）。

## 决策

### D1 九个内容目录 + 派生 `index/`

**决策**

- 内容目录固定为**九个**：`chapters/`、`characters/`、`world/`、`outlines/`、`foreshadowing/`、`timeline/`、`relations/`、`facts/`、`library/`。
- 派生目录 `index/` 不是内容目录，但同样固定；内容目录与 `index/` **合计十项**是门禁检查范围。
- 目录名固定英文、**不可配置**；改约定只能改契约 + 代码（同一次变更内）。
- 九个内容目录与 `index/` **都**带 `.gitkeep`（空文件）。`.gitkeep` 不参与解析（解析器只认 `*.md`/`*.json`），也不被工具当作内容。
- **缺 `.gitkeep` 等同于结构缺失**：目录在但 `.gitkeep` 不在，会被下一次 `git clone` 抹掉目录，因此它进 D2 的 `needs-repair`，由修复向导补；只有"目录与 `.gitkeep` 都在"才算该项齐全。除此之外门禁不检查目录里有没有内容文件。

**取舍**：四个域各自独立成一级目录，而不是继续用 `world/timeline/` 这类子目录——归属靠一级目录自证，门禁与工具都不必猜嵌套；代价是新书要建十个目录、仓库里多十个空文件，这两件事都由向导一次完成，且 `.gitkeep` 体积为 0 byte。
本条取代 S-06 Q2 的四个建议归属（`outlines/foreshadowing/`、`world/timeline/`、`world/relations.json`、`world/facts/`）与 Q3 的六目录口径。

**验证锚点**：V1、V2、V5。

### D2 四态门禁（三态 + 第 4 态）与 fail-closed

**决策**

每次判定产出**四态之一**，判定顺序固定（序号小者优先，命中即停）：

| # | 状态 | 条件 | 业务工具 | 允许的写操作 |
|---|---|---|---|---|
| 1 | `needs-newer-plugin` | `inkflow.json` 可解析且 `schemaVersion` > 插件支持上限 | 拒绝（只读） | **无**：不改 meta、不重建索引、不"修复" |
| 2 | `usable` | 是 git 仓库 + 九个内容目录与 `index/` 齐（每项需含 `.gitkeep`，`index/` 缺失见放宽条款）+ `inkflow.json` 可解析且版本 ≤ 上限 | 正常 | 正常 |
| 3 | `needs-repair` | 未达 1/2，但书目录**有 `inkflow.json`（哪怕不可解析）或有 `.git`** | 拒绝 | 仅修复向导（只补缺失项，不覆盖） |
| 4 | `needs-setup` | 1/2/3 都不成立 | 拒绝 | 仅初始化向导（只建缺少项） |

- **fail-closed**：非 `usable` 时业务工具一律拒绝，并且返回**结构化清单**，不是一句错误：`state`、`root`、`checks`（逐项布尔）、`missing[]`、`actions[]`（可执行动作 + 目标路径）、`readOnly`。拒绝路径**零写盘**。
- **唯一放宽**：`index/` 缺失且其余全部满足 → 静默创建 `index/` 与 `index/.gitkeep`，并在返回里标 `indexDirRecreated: true`。这是门禁判定路径上唯一的写操作。
- **第 4 态是终态**：`needs-newer-plugin` 下唯一出路是升级插件；旧插件不得以任何"修复"名义改写 meta 或删除索引。
- 【细化】repair / setup 的判别信号取「有 meta 或有 `.git`」而不是「有任一目录」：目录可能是用户手工先建的，也不能说明项目已经成立；meta 与 `.git` 是"这已经是一本书"的可靠信号。两者只影响向导默认动作与文案，写入集合相同（都只补缺失项）。

**取舍**：四态而不是布尔——布尔把"该新建/该补齐/该升级插件"混成一个失败，用户拿不到可执行动作，而门禁的产出物本来就应该是"下一步做什么"；把 `needs-newer-plugin` 单独成态而不是并入 repair——并入后 repair 的默认动作（重建坏 meta）会直接覆盖高版本契约写下的文件，属于数据损坏；不做"自动升级 schemaVersion"——降级写入比拒绝写入危险得多。

**验证锚点**：V3、V4、V10。

### D3 初始化 / 修复向导：先列清单，确认后只补缺失

**决策**

- 向导分两段：**plan（只读）** → **apply（需确认）**。
  - `plan` 输出 `actions[]`：每条含动作类型、目标路径、为什么需要。plan 不写任何文件，也不执行 `git init`。
  - `apply` 必须带显式确认（交互向导里是用户点确认，工具调用里是 `confirm: true`）；只执行 plan 列出的动作。
- **初始化 plan** 的完整覆盖面：`git init`（边界见 D4）、九个内容目录 + 九个 `.gitkeep`、`index/` + `index/.gitkeep`、`inkflow.json`、`.gitignore`（至少忽略 `index/*.db`、`index/*.db-wal`、`index/*.db-shm`）。
- **修复**：只补缺失项（含单个目录内缺失的 `.gitkeep`）。已存在的文件/目录一律跳过，并在报告里列 `skipped[]`（含原因）；不覆盖、不改写、不重排格式。
- **坏 meta**：先展示原文（完整内容；超长时截断并明确标注被截断），用户确认后才重建；重建 `inkflow.json` 是**唯一**允许覆盖已有文件的场景，且必须由该确认触发。
- **幂等**：同一状态连续 apply 两次，第二次 `created[]` 为空、`skipped[]` 覆盖上次创建过的全部项。

**取舍**：一键静默初始化——省一次点击，但新书目录里可能有用户放进去的稿件/设定，静默建文件容易与既有内容冲突；把确认下沉到每个写动作——确认次数过多，用户会形成"一路点确定"的肌肉记忆，等于没有确认；允许 repair 顺手"规范化"已有文件——任何"顺手改"都会让 `git diff` 出现用户没同意的改动。

**验证锚点**：V1、V2。

### D4 `git init` 边界

**决策**

- 向导**可以**执行 `git init`，这是全插件唯一允许的 git 写操作。
- 一律**不做**：`git add`、`git commit`、`git remote add`/改远程、设置 `user.name`/`user.email`、改默认分支或任何 git 配置、`git submodule`。
- 已有 `.git` → plan 不再包含 `git init`。
- **父级已有 git 仓库**（向上能找到 `.git`，而书目录本身还没有 `.git`）：plan 仍包含 `git init`（一部小说 = 一个仓库），并附一条提示「请在外层仓库的 `.gitignore` 里忽略本书目录」；**不代改项目根以外的任何文件**，外层 `.gitignore` 由用户自己改。
- 不 commit 意味着"向导跑完 = 工作区干净但没有提交"，首次提交由用户审阅后进行。

**取舍**：不替用户 `git init`、只提示手跑（S-06 Q5 的原建议）——新书最常见的失败点就是"忘了 git init 然后门禁报错"，而这恰好是向导能安全代劳的一步；自动 commit——提交信息、身份、节奏都属于作者，自动提交会污染历史且绕开人审；用 submodule 表达嵌套——submodule 把书的版本指针绑在外层仓库，回滚与协作都更重，而"外层 ignore + 内层独立仓库"是纯文件方案。

**验证锚点**：V7、V8。

### D5 单工作区单项目

**决策**

- **一个工作区 = 一部小说 = 一个 git 仓库**。同一工作区不管理第二本书。
- 工作区根解析只有两个来源，按序：① 显式 `projectRoot` 参数；② 会话工作目录**向上**找到的第一个项目根（要求有 meta 或 `.git` 信号）。
- **取消** `state.json` 的 `lastProjectRoot` 作为项目来源（`src/host/state.ts`、`src/host/tools.ts:76-80`、`src/host/routes.ts:77` 的兜底逻辑全部移除）；**取消**任何全局多项目注册表/项目列表。
- 解析失败 → 返回结构化 `state` + `actions`（"打开书目录"或"传入 projectRoot"），不回退到上次项目。
- 面板与 HTTP 路由使用**同一个**解析结果（当前工作区），不允许各自兜底。

**取舍**：全局注册表 + 项目切换器——多书跳转方便，但跨工作区误写、同步冲突、状态污染同时出现，且与"工作区即项目"的宿主语义打架；保留 `lastProjectRoot`——面板"总有点东西可显示"，代价是在 A 工作区静默读写 B 的库，是数据安全问题，不是体验问题。

**验证锚点**：V9。

### D6 卷章 catalog（`chapters/index.json`）

**决策**

- 两份 catalog（UTF-8 无 BOM、LF、临时文件 + rename 原子替换写）：
  - `chapters/index.json`：**卷列表 + 散章**（不属于任何卷的章节）。
  - `chapters/<vol-dir>/index.json`：该卷的**章清单**。
- 字段形状【细化】：根 `{ schemaVersion, volumes[], looseChapters[] }`；卷项 `{ volumeId, dir, title, order }`；章项 `{ chapterId, file, seq, title }`。**不写字数、状态统计等派生量**——统计由索引派生，写进 catalog 只会让 AI 与插件互相改同一字段。
- **catalog 是派生投影**：`.md`（文件名 + frontmatter）是真相。catalog 与真相不一致 → **以 `.md` 重建并覆盖 catalog**；手改会被覆盖，不提供"保留你的改动"。
- **catalog 入库**（与 `index/` 相反）：卷章清单因此可 `git diff` 审阅、跨机器一致。
- **`volumeId` 稳定**：形如 `vol-NN`（两位起，超过 99 自然扩展）；卷目录名 `vol-NN-<slug>`，slug 可改而 `volumeId` 不变。**章 frontmatter 用 `volumeId` 记录归属**（字段名取代现行契约的 `volume`，S-03 按本 ADR 对齐），归属不从目录名推导（目录名只用于定位文件）。
- 读写分工【细化】：**读路径不写盘**（catalog 缺失或漂移时返回 `catalogStale: true` 并以 `.md` 为准）；**写路径在写入时重建**受影响的 catalog，并在结果里标 `catalogRebuilt: true`；另提供显式重建动作。
- catalog **不是门禁必需项**：删掉它不改变 D2 的状态（重建即可），避免"删一个投影文件 = 项目损坏"。
- 与 `index/` 的边界：catalog 是**可审阅的结构投影**（入库、只含结构不含统计）；`index/` 是 SQLite 检索缓存（不入库、整库可删）。两者都不承载真相。

**取舍**：catalog 作为真相源——省一次投影，但会让"手改 JSON"与"改 md"变成两条写路径，冲突时无法判定谁对；catalog 不入库、纯运行时缓存——省一次提交，但卷章结构就不可审阅、不可跨机器核对，等于把第 4 个缺口原样保留；归属继续由卷目录名推导——改名即改归属，违反 `volumeId` 稳定；全书一个 catalog——任何一次章节写入都要重写整文件，冲突面最大。

**验证锚点**：V6。

### D7 与 ADR-0005 的关系

**决策**

- ADR-0005 **继续有效**：文件真相、SQLite 派生索引、不写数据库迁移、约定大于配置、门禁 fail-closed 的目的都不变。
- 本 ADR 只修改 0005 的**决策 4（目录条款）**与**决策 5（门禁条款）**；在 0005 头部注明"门禁/目录条款已被 0006 修改"，**不改写 0005 正文**（ADR 治理 A3：被取代时只改头部状态）。
- 两处冲突时以本 ADR 为准；0005 的其余条款按原文执行。
- 不做"0007 取代 0005"：本 ADR 只动两条，整条取代会让读者误以为文件真相也被推翻。

**取舍**：直接改写 0005 正文——省一个文件，但抹掉决策演化与外部引用（A3 明确禁止）；新开 ADR 取代 0005——会连带作废文件真相/sqlite 派生索引这些仍然有效的条款；只改 S-03 不立 ADR——目录与门禁属"数据格式/对外契约"变更，A1 要求先有 ADR。

**验证锚点**：V11。

## 备选与取舍（被否方案汇总）

| 方案 | 优点 | 代价 | 为什么没选 |
|---|---|---|---|
| 目录名可配置（配 `inkflow.json` 或全局配置文件） | 用户可用中文/自定义结构 | 必须有注册表与解析兜底，回到"配置地狱"；门禁无法靠目录自证身份 | 与 ADR-0005 决策 4 的"约定大于配置"正面冲突；可配置等于把身份判定交给用户输入 |
| 保留六目录，四域做 `world/`、`outlines/` 子目录 | 迁移量为零 | 门禁只到一级；跨域查询要认嵌套；域概念被层级掩盖 | 缺口 1 无法解决，只是把问题写进文档 |
| 门禁保持布尔（`usable` / 不是） | 实现与测试最简 | 用户拿不到"下一步做什么"；三种处置被折叠 | 缺口 2 无法解决；结构化清单是本 ADR 的主要产出 |
| `needs-newer-plugin` 并入 `needs-repair` | 少一个状态 | repair 的默认动作会覆盖高版本契约的文件 | 属于数据损坏路径，不能用"少一个状态"换 |
| 向导只提示"请手动 git init" | 仓库身份完全由用户决定 | 新书最常见的失败点保持原样；用户仍会卡在门禁 | D4 已用"不 commit/不配 remote/不设身份"把风险收窄，无需再放弃这一便利 |
| 嵌套仓库用 git submodule | 版本指针显式 | 书的提交指针绑在外层，回滚/协作变重 | 纯文件方案（外层 ignore + 内层独立仓库）满足同一需求且不引入新概念 |
| 卷章归属继续由目录名 + 扫描推导 | 无新文件、无新格式 | 改目录名即改归属；结构不可审阅 | 缺口 4 无法解决 |
| catalog 作为真相源（手改生效） | 用户可直接编辑 JSON | 两条写路径冲突时无法判定以谁为准 | `.md` 已是真相，第二个真相源必然漂移 |
| 保留全局多项目注册表 + `lastProjectRoot` 兜底 | 多书跳转、面板总有内容 | 跨工作区误写与状态污染 | 与"一个工作区 = 一部小说"冲突；写错项目是数据安全问题 |

## 影响面

| 文件 | 现行行为 | 本 ADR 要求 |
|---|---|---|
| [S-03 conventions.md](../specs/conventions.md) | 六目录、布尔门禁、§8 三条待拍板 | 按本 ADR 重写：九目录、四态、catalog 引用 |
| [S-04 data-model.md](../specs/data-model.md) | 卷章映射按六目录与 `volume` 字段 | 卷/章按 `volumeId` + catalog 描述 |
| [S-06 open-questions.md](../specs/open-questions.md) | Q1–Q5、Q2/Q3/Q5 的建议默认值 | 转入裁决记录，以本 ADR 为准 |
| `src/host/conventions.ts` | `CONTENT_DIRS` 五项、`REQUIRED_DIRS` 六项 | 九项 + `index/` + `.gitkeep` 清单 |
| `src/host/project.ts` | `usable` 布尔；`index/` 静默创建；高版本 meta 折叠为 invalid | 四态判定 + 结构化清单 + plan/apply |
| `src/host/tools.ts` | 三个解析来源（参数/cwd/state），单一错误码 | 两个来源；四态错误码；fail-closed |
| `src/host/state.ts`、`src/host/routes.ts` | `lastProjectRoot` 参与项目解析 | 取消其项目解析用途 |
| `src/host/indexer.ts` | 只扫六目录 | 扫九目录，并校验 catalog 与 `.md` 一致 |
| `tests/contract.test.js` | 覆盖六目录门禁 | 按四态矩阵与 catalog 扩用例 |

S-03 §8 三条待拍板的处置：C1（`index/` 缺失自动重建）**采纳**，成为 D2 的唯一放宽；C2（四域归属子目录）**被 D1 取代**；C3（init 不自动 `git init`）**被 D3/D4 取代**（向导可 `git init`，但不 commit/不配 remote/不设身份）。

## 不在范围

以下同属工作区契约周边，但**不在本 ADR 内**，由后续 ADR 各自承载：插件级共享资料库的位置与复制策略、语义检索（OpenViking）的接入与 peer、面板入口与路径来源、是否保留 MCP 双通道与对外 HTTP API、写作工艺 skills 的归属、按章删除后的索引重建策略。

## 后果

### 正面

- 门禁的产出物变成"下一步做什么"，而不是"你不是项目"：`actions[]` 可被 agent 直接执行。
- `git clone` 后结构齐全（`.gitkeep`），空目录不再被误判为缺目录。
- 卷章归属稳定：改卷目录 slug 不重编号，章归属由 `volumeId` 决定。
- 卷章结构进入 `git diff`，可审阅、可回滚。
- 单工作区单项目后，在书 A 的工作区里不可能读到/写到书 B。

### 负面

- 仓库里多十个 `.gitkeep`（0 byte，但会出现在目录列表里）。
- 判定从 2 分支变成 4 分支，测试矩阵变大（这正是 V1–V10 存在的原因）。
- catalog 与 `.md` 双份：写路径要维护投影，读路径要处理 `catalogStale`。
- 去掉 `lastProjectRoot` 后，"在任意目录问上次那本书"这种便利不再可用。

### 风险

| 风险 | 触发条件 | 对策 |
|---|---|---|
| 手改 catalog 被覆盖，用户以为丢数据 | 用户直接编辑 `chapters/index.json` | 文档与工具描述声明"派生投影，手改无效"；写路径返回 `catalogRebuilt`；真相在 `.md`，不丢数据 |
| `.gitkeep` 被当垃圾清理，clone 后目录消失 | 用户清理空文件 | 状态判定以 meta/`.git` 为信号（D2 细化），老项目不会被误判为 `needs-setup` |
| 高版本 meta 被"修复"覆盖 | 旧插件进入 repair 后重建 meta | 判定顺序把 `needs-newer-plugin` 放第一位，repair 前置拦截 |
| 嵌套仓库外层未 ignore | 用户忽略提示 | 向导只写书目录内的文件；外层文件 hash 不变（V8） |
| 把非书目录当书根 | 向上查找过宽 | 需要 meta 或 `.git` 信号；且不在任意目录建库 |

## 验证

文档门禁（本次即可执行）：

```bash
node scripts/check-links.mjs
pnpm.cmd run check
```

期望：`links ok: N relative link(s) across M markdown file(s)`；`check`（typecheck + build + test + links）全绿。

行为判据：下表是**验收判据**，不是现状陈述。用例落在 `tests/` 下的门禁与 catalog 测试文件（文件名由实现决定），实测证据贴对应 PR 评论（不入库，见 [AGENTS.md](../../AGENTS.md) §9.5 D7）。**实现未落地前，任何一行都不得对外声称"已验证"。**

| # | 场景 | 期望（判据） |
|---|---|---|
| V1 | 空目录执行初始化 | plan 列出九目录 + 九个 `.gitkeep` + `index/.gitkeep` + `inkflow.json` + `.gitignore` + `git init`；apply 后状态 `usable`；再次 apply 时 `created[]` 为空 |
| V2 | 老项目只缺 `world/`，执行修复 | 只创建 `world/` 与 `world/.gitkeep`；`inkflow.json` 与 `.gitignore` 内容 hash 前后一致；报告含 `skipped[]` |
| V3 | `inkflow.json` 的 `schemaVersion` 高于插件上限 | 状态 `needs-newer-plugin`；任一业务工具返回只读错误；项目根全量 hash 前后一致 |
| V4 | 只删 `index/` | 状态 `usable` 且 `indexDirRecreated: true`；其余目录与文件未被触碰 |
| V5 | 删除某内容目录的 `.gitkeep`；再清空该目录（模拟 `git clone` 后目录消失） | 第一步即 `needs-repair`（缺 `.gitkeep` 也算结构缺失）；第二步仍是 `needs-repair`（meta 或 `.git` 仍在），不是 `needs-setup` |
| V6 | 手改 `chapters/index.json`；删 catalog；改卷目录 slug | 写入后 catalog 回到 `.md` 派生值；删除后读工具只报 `catalogStale` 且不写盘、写工具重建；slug 改名后 `volumeId` 与章 frontmatter 均不变 |
| V7 | 在已有 `.git` 的目录执行初始化 | plan 不含 `git init` |
| V8 | 书目录位于另一个 git 仓库内 | plan 含 `git init` + 外层 `.gitignore` 提示；apply 后项目根以外文件 hash 不变；不产生 commit、remote、`user.name`/`user.email` 配置 |
| V9 | `state.json` 记着书 B，cwd 在书 A 之外 | 解析失败，返回结构化 `state` + `actions`；不读、不写书 B |
| V10 | 非 `usable` 状态调用任一业务工具 | 返回结构化清单（`state`/`checks`/`missing`/`actions`）；项目根全量 hash 前后一致（零写盘） |
| V11 | 文档门禁 | `check-links` 0 断链；`pnpm.cmd run check` 全绿 |
