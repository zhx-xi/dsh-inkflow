# InkFlow 使用手册

> 面向**使用者**：怎么装、怎么建书、日常怎么用、出问题怎么查。
> 面向开发者的规范在 [`.agents/`](../.agents/)（章程 / spec / ADR），本目录不放规范。

## 1. 这是什么

一个 DeepSeek Harness（DSH）插件：装一个插件，就能在 DSH 里完成长篇小说创作的全部工作——项目/卷/章、大纲、人物、世界观、伏笔、时间线，以及一个内置工作台。

**核心设计：文件就是你的书。** 每部小说是一个独立的 git 仓库，正文和设定都是你能直接打开、直接搜索、直接改的 Markdown/JSON 文件。插件读取这些文件，并维护一个可随时删除重建的索引（`index/inkflow.db`）用来做检索和统计。

因此：

- 插件升级**不会动**你的书，也不需要跑数据库迁移；
- 你可以用任何编辑器改文件，改完让插件重建索引即可；
- 卸载插件不影响作品，作品永远在自己的 git 仓库里。

## 2. 系统要求

| 项 | 要求 |
|---|---|
| DSH | 桌面版 `0.2.1-rc.2` 或更新（插件靠 `engines.dsh` 校验） |
| 系统 | Windows 10/11（macOS/Linux 未验证） |
| Node | 用 DSH 自带的 Node 24；自行构建时需要 Node ≥ 22.12 |

## 3. 安装与卸载

在 DSH 的插件管理器里安装（推荐）：目标填本仓库的绝对路径，安装后**重启 DSH**。

命令行等价方式：

```powershell
pnpm.cmd install
pnpm.cmd run build          # 生成 lib/index.js 与 lib/client.js
dsh plugin --profile desktop add link:D:\develop\projects\dsh-inkflow
```

卸载：插件管理器里移除该 bundle，然后重启 DSH。**作品不会被动**（它们在各自的 git 仓库里）。

> 升级插件后如果行为没变，先确认已重启 DSH——新代码不会热替换正在运行的旧版本。

## 4. 创建一部新书

一部书 = 一个 git 仓库，根目录必须长这样（九个内容目录 + 派生 `index/`，**每个目录里都有一个空的 `.gitkeep`**）：

```
<你的书名>/
├── inkflow.json        # 项目元信息（schemaVersion / title / author）
├── .gitignore          # 至少忽略 index/*.db*
├── chapters/           # 正文
├── characters/         # 角色
├── world/              # 世界观 / 设定库
├── outlines/           # 大纲
├── foreshadowing/      # 伏笔
├── timeline/           # 时间线
├── relations/          # 知识关系
├── facts/              # 事实账本
├── library/            # 资料（参考素材）
└── index/              # 派生索引（可删可重建，只有 .gitkeep 进 git）
```

每个目录里的 `.gitkeep` 不是装饰：git 不跟踪空目录，没有它，`git clone` 之后目录会消失，插件就会把结构齐全的书判成「缺目录」。

**目录名固定、不可改**——插件靠它判断"这是一个 InkFlow 项目"。

两种建法：

**方式一：让 DSH 里的 AI 建**（推荐）

在新目录里打开一个 DSH 会话，说「在这里建一本叫《书名》的小说项目」。AI 会先调 `inkflow_project_plan` 把**将创建什么**列给你看，你同意后它才调 `inkflow_project_init` 落盘（并代跑 `git init`，但不会 commit、不配远端、不改你的 git 身份）。

**方式二：手动建**

建十个目录（各放一个空 `.gitkeep`）、写 `inkflow.json`：

```json
{ "schemaVersion": 1, "title": "书名", "author": "你的笔名" }
```

再 `git init`、`git add .`、`git commit`。

> 插件只在**四态里的 `usable`** 才工作：① 目录是 git 仓库 ② 九个内容目录与 `index/` 齐全且每项带 `.gitkeep` ③ `inkflow.json` 可解析且版本不高于插件。差哪一项，工具会告诉你缺什么、下一步该做什么。

## 5. 日常使用

### 5.1 工作台面板

面板入口在**会话的「对话 / 轨迹」栏**——切换到这个页签，它只显示当前会话所在的那本书，不需要你选项目（[ADR-0008](../.agents/adrs/0008-panel-data-channel.md)）。左栏不再有全局图标：全局入口拿不到会话，无法判断该显示哪本书。

面板**只读地判定这本书的状态**（四态门禁），`usable` 时右栏是可直接写作的编辑器；非 `usable` 时一切写入仍然只能由工具完成：

| 面板状态 | 你看到什么 | 下一步 |
|---|---|---|
| **可用**（`usable`） | 顶部：项目标题、四态徽章、项目根（相对会话目录，通常就是 `./`）；左：章节树（卷 → 章，可「新建章」）；右：标题 / 状态 / 正文编辑器 | 直接写：停止输入 1.5 秒自动保存，`Ctrl/Cmd+S` 立刻保存，`Ctrl/Cmd+Z` 撤销；文件在插件外被改过时提示冲突，默认**不**覆盖（重载或明确覆盖由你选） |
| **待初始化**（`needs-setup`） | 缺什么（`missing[]`）+ 初始化向导会做什么（`actions[]`）+「打开初始化向导」按钮 | 点按钮看只读计划；确认后让 AI 调 `inkflow_project_init`（`confirm: true`） |
| **待修复**（`needs-repair`） | 同上，清单是缺的目录/`.gitkeep`/`inkflow.json` 等 | 同上：先看计划，再确认补齐（只补缺的，不覆盖已有文件） |
| **需升级插件**（`needs-newer-plugin`） | 只读提示：这本书由更新版本的插件写入 | 先升级插件，这个版本不写入 |
| **没有会话身份**（`NO_SESSION_CONTEXT`） | 明确空态文案，不是报错 | 在小说目录的会话里打开这个页签 |

- 设定 / 大纲 / 伏笔三个页签显示为**禁用态**并标注「0.2.0 起」——对应功能尚未实现，摆一个点了没反应的按钮比禁用更糟。
- 面板不写盘、不建索引、不修复项目：它只投影 Host 的判定结果，写入一律是「用户确认后的工具调用」。
- 面板看不到内容时，项目状态也可以直接问 AI：`inkflow_project_status`（判定）与 `inkflow_project_plan`（只读计划）。

### 5.2 对 AI 说人话就行

插件提供六个工具，DSH 里的 AI 会在需要时自己调用：

| 工具 | 作用 | 你可以这样说 |
|---|---|---|
| `inkflow_project_status` | 检查当前目录的项目状态（可用 / 待初始化 / 待修复 / 需升级插件）、缺什么、索引状态 | 「看看这个目录能不能写小说」 |
| `inkflow_project_plan` | **只读**：列出"若初始化/修复，会创建哪些目录与文件"，不写任何东西 | 「先给我看看你打算建什么」 |
| `inkflow_project_init` | 执行上面那份清单（建目录 + `.gitkeep` + `inkflow.json` + `.gitignore` + 必要时 `git init`）；**只补缺的，不覆盖已有文件**；必须带确认 | 「就按这个清单建」/「把缺的补齐」 |
| `inkflow_index_rebuild` | 从文件重建索引并检查一致性 | 「重建一下索引」/「检查一下设定有没有冲突」 |
| `inkflow_chapter_list` | 按阅读顺序列出章节 | 「列一下现在有哪些章」 |
| `inkflow_chapter_search` | 在章节正文里找关键词，返回命中的章与前后各 40 字的片段（1–2 个字也能搜） | 「哪一章写过云海翻涌」/「搜一下『宝剑』」 |
| `inkflow_volume_create` | 建卷：分配 `vol-NN`、建 `chapters/vol-NN-<slug>/` 并刷新卷章清单 | 「开一个第一卷」 |
| `inkflow_volume_rename` | 改卷名：目录与清单一起改，**章的归属和章 id 不变** | 「把第一卷改名叫入山卷」 |
| `inkflow_chapter_create` | 建章：分配 uuid `id` 和章号，写 frontmatter 与空正文 | 「加一章，标题叫第一章 入山」 |
| `inkflow_chapter_write` | 改标题 / 正文 / 状态；只改你指定的字段，改标题会同时改文件名 | 「把这一章改成《夜行》，状态标成 revised」 |
| `inkflow_chapter_move` | 移卷或移出卷（`volume` 跟着改，章 id 不变） | 「把第三章挪到第二卷」/「把这篇外传移出卷」 |
| `inkflow_chapter_delete` | 删章（**物理删除**，恢复靠 git 历史） | 「删掉那一章」 |

向导的两段式是刻意设计的：先看清单（`plan`），你点头之后才落盘（`init` + 确认）。修复老项目时它只补缺失项——已有的正文、设定、`inkflow.json` 一个字节都不会动；唯一例外是**坏掉的** `inkflow.json`：它会先把原文（超长会截断并标注）给你看，你确认后才重建。

### 5.3 自己改文件后

用 VSCode/记事本直接改 `.md` 文件是**允许且推荐**的。改完让 AI「重建索引」，或手动调用 `inkflow_index_rebuild`。

索引是缓存：删掉 `index/inkflow.db` 也不会丢任何内容，下次使用时自动重建。

### 5.4 写作模式与五个写作技能

装好插件后，在**小说项目目录**里开会话，AI 的技能目录里会自带五个写作工艺技能：

| 技能 | 管什么 |
|---|---|
| `inkflow-architect` | 架构：把设定与大纲折成**本章任务书**（目标 / 冲突 / 信息增量 / 伏笔动作 / 禁区） |
| `inkflow-writer` | 起草：按任务书写正文，管视角、场景、对话、节奏、章末钩子、去 AI 味 |
| `inkflow-auditor` | 审校：设定 / 时间线 / 人物 / 伏笔四维**只读**审计，逐条给正文原句与严重级 |
| `inkflow-reviser` | 修订：按审计清单定向改写，只动被点名的位置，不重写全章 |
| `inkflow-polisher` | 润色：句子级去 AI 味、去翻译腔、修重复与标点，**不改情节** |

这些技能**只在作品目录里出现**：会话工作目录不在任何 InkFlow 项目里时，技能目录里不会有它们，写代码/聊天类的会话不受影响。

**写作模式（agent preset）**：会话的模式选择里会多一项 **InkFlow 写作**（`inkflow-writing`）。它的差别只有两件事：

- 人设按五阶段流水线组织，并点名这五个技能；
- 工具只给读文件 / 文件搜索 / 待办 / 提问 / 联网这些日常工具，外加 `inkflow_*`。**不给 shell、不给子智能体、不给工作流**——作者会话不该顺手去改仓库。

写小说用这个模式，写代码用默认模式。

**怎么用**（照旧说人话，不用记技能名）：

- 「写下一章」→ 先 `inkflow-architect` 出任务书，再 `inkflow-writer` 成文，最后 `inkflow-auditor` 审一遍；
- 「按审校意见改」→ `inkflow-reviser`；「这段读着像 AI 写的，润一下」→ `inkflow-polisher`；
- 想直接点名，输入框里打 `/inkflow-writer` 即可。

**想改工艺**：技能文件在插件包内 `skills/<技能名>/SKILL.md`，正文就是给 AI 的指令（frontmatter 里的 `name` 必须与目录名一致，改名要同时改两处）。技能按作品目录生效，所以同一套工艺对所有书一致。

## 6. 文件格式速查

正文（`chapters/vol-01/0001-入山.md`）：

```markdown
---
id: ch-1
title: 第一章 入山
volumeId: vol-01     # 卷归属（vol-NN 稳定标识；catalog 尚未实现）
seq: 1
status: final        # draft | revised | final
---

他沿着石阶向上走，雾从脚边漫过来。
```

角色（`characters/清音.md`）：

```markdown
---
id: char-1
name: 清音
aliases: [青音]
group: 门派
role: 主角
---

角色卡正文（性格/外貌/动机，自由格式）。
```

世界观（`world/门派/白鹤门.md`）：

```markdown
---
id: w-1
title: 白鹤门
category: 门派
keywords: [白鹤, 鹤鸣剑]   # 世界书触发词
always: false
---

条目正文。
```

大纲（`outlines/overall.md`、`outlines/vol-01.md`）：

```markdown
---
id: ov
kind: overall        # overall | volume | chapter
title: 全书总纲
---

- 少年入山
- 门派倾覆
```

约定：`frontmatter` 里的未知字段会被保留、索引忽略——所以你可以自由加字段，不会因为插件旧而丢数据。

## 7. 索引是什么

- 位置：`<书名>/index/inkflow.db`（SQLite，WAL）。
- 内容：章节、角色、世界观、大纲的**摘要** + 全文检索表（中文 ≥3 字可搜，2 字走退化的精确匹配）。
- 特性：**可随时删除**。删除后下次打开/调用工具会自动重建，耗时与文件量成正比（几千章量级预计数秒）。
- 索引**不进 git**（`.gitignore` 里已排除），所以不会污染你的提交历史。

## 8. 排错

| 现象 | 原因 | 处理 |
|---|---|---|
| 面板显示「没有会话身份」（`NO_SESSION_CONTEXT`） | 面板在会话的「对话 / 轨迹」栏里才有会话身份；从没有会话的页面打开、或会话还没绑定工作区时，Host 无法判断该显示哪本书 | 在小说目录的会话里切到 InkFlow 页签；同时可调 `inkflow_project_status` 看项目状态 |
| 工具报 `NOT_AN_INKFLOW_PROJECT`（`needs-setup`） | 这里还不是项目：缺 git / 缺目录 / 缺 `inkflow.json` | 看返回的 `missing` 与 `actions`；确认后让 AI 走 `inkflow_project_plan` → `inkflow_project_init`（`confirm: true`） |
| 工具报 `PROJECT_NEEDS_REPAIR`（`needs-repair`） | 书已经存在，但缺目录/缺 `.gitkeep`/`inkflow.json` 坏了 | 先看 `actions`（只补缺失项，不覆盖已有文件）；坏 meta 会先回原文再重建 |
| 工具报 `PROJECT_NEEDS_NEWER_PLUGIN` | `inkflow.json` 的 `schemaVersion` 比你装的插件新 | **升级插件**；不要试图修复或重建——旧版本写入会破坏新版本写下的数据 |
| 工具报 `META_TITLE_REQUIRED` | 需要写 `inkflow.json` 但没告知书名 | 告诉 AI 书名后重试（插件不编造标题） |
| 工具报 `GIT_INIT_FAILED` | 机器上没有可用的 git | 装好 git 后重试；或自己在书目录 `git init`，再走修复向导 |
| 工具报 `PATH_OUT_OF_SCOPE` / `PATH_FORBIDDEN` | 传的路径不在当前会话工作目录里（或是盘符根/家目录/安装目录） | 在会话工作目录内建项目，或先把会话切到书的目录 |
| 工具报 `INIT_REQUIRES_CONFIRMATION` | 向导还没拿到你的确认 | 看返回的「将创建/将修复」清单，确认无误后让 AI 带 `confirm: true` 再跑一次 |
| 会话的「对话 / 轨迹」栏里没有 InkFlow 页签 | 插件未安装/未激活，或改了代码没重启（HMR 不热替换已加载的插件） | 检查插件列表；重启 DSH |
| 装了插件但工具列表里没有 `inkflow_*` | 还是旧版本代码在跑 | 重启 DSH |
| 技能目录里没有 `inkflow-*` 五个写作技能 | 会话工作目录不在 InkFlow 项目里（技能按目录门禁），或宿主没有 skills 服务 | 把会话切到书的目录；重启后在启动日志里看有没有 `skills service missing` |
| 模式选择里没有「InkFlow 写作」 | 宿主没有 `agentPresets` 服务（或该宿主不支持 preset） | 技能与 `inkflow_*` 工具不依赖 preset，写作照常可用；重启升级后再看 |
| 改了章文件，面板还是旧的 | 索引未重建 | 触发 `inkflow_index_rebuild` 或重启会话 |
| 中文两字词搜不到 | trigram 分词限制 | 用 3 字以上关键词，或直接全文搜文件 |
| 文档乱码 / 项目识别失败 | 文件被写入了 UTF-8 BOM | 用「UTF-8 无 BOM」重新保存；插件读取时会容忍 BOM，但建议统一 |
| 书名/正文乱码（如 `浜哄湪铚€灞憋紝鏄帉闂?`） | 文件根本不是 UTF-8：PowerShell 5 的 `Set-Content` / `echo` 默认 ANSI，在中文 Windows 上写出的是 GBK；插件自己的写入路径不会这样 | 用「UTF-8 无 BOM」重写这个文件，书名可以让 AI 用工具重新写一次。插件会发现并提示（`inkflow_project_status` 的 `titleSuspicious`、`inkflow_project_init` 的 `META_ENCODING_SUSPECT`、面板标题旁的 ⚠），但**不会自动改你的文件** |
| `git clone` 后插件说缺目录 | 空目录被 git 丢了（`.gitkeep` 被删） | 删掉过 `.gitkeep` 就会这样：让 AI 走修复向导补回来，或手动补空文件 |

## 9. FAQ

**Q：我的书会被上传吗？**
不会。第一阶段完全本地：没有账号、没有服务端、没有同步。只有你主动调用模型生成内容时，相关上下文才会发送给你自己配置的模型服务。

**Q：能多本书吗？**
能，但**一个会话工作区只管一本书**：一本书 = 一个目录 = 一个 git 仓库；在不同书的目录里分别开会话即可，插件不会跨目录串数据。

**Q：怎么备份？**
`git push` 到你的私有远端即可。这也是推荐做法：每完成一章提交一次。

**Q：可以不用 git 吗？**
不可以。git 是本设计的版本历史与回滚面，也是插件识别项目的条件之一。

**Q：卸载插件后书还在吗？**
在。作品是普通文件 + 你自己的 git 仓库，与插件无关。

**Q：能自定义目录名吗？**
不能。目录名是项目契约的一部分（见 `.agents/specs/conventions.md`），改名会导致插件不认这个项目。

## 10. 想了解设计细节

- 目录与文件契约（权威）：[`.agents/specs/conventions.md`](../.agents/specs/conventions.md)
- 架构与 DSH 集成点：[`.agents/specs/architecture.md`](../.agents/specs/architecture.md)
- 为什么是「文件真相 + 派生索引」：[`.agents/adrs/0005-files-first-with-derived-index.md`](../.agents/adrs/0005-files-first-with-derived-index.md)
- 为什么是九目录 + 四态门禁 + 向导：[`.agents/adrs/0006-workspace-contract-v2.md`](../.agents/adrs/0006-workspace-contract-v2.md)
