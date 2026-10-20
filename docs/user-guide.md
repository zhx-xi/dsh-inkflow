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

一部书 = 一个 git 仓库，根目录必须长这样：

```
<你的书名>/
├── inkflow.json        # 项目元信息（schemaVersion / title / author）
├── chapters/           # 正文
├── characters/         # 角色
├── world/              # 世界观 / 设定库
├── outlines/           # 大纲
├── library/            # 资料（参考素材）
├── index/              # 派生索引（可删可重建，只有 .gitkeep 进 git）
└── .gitignore          # 至少忽略 index/*.db
```

**目录名固定、不可改**——插件靠它判断"这是一个 InkFlow 项目"。

两种建法：

**方式一：让 DSH 里的 AI 建**（推荐）

在新目录里打开一个 DSH 会话，说「在这里建一本叫《书名》的小说项目」。AI 会调用 `inkflow_project_init` 生成上述目录与 `inkflow.json`。

**方式二：手动建**

建目录、写 `inkflow.json`：

```json
{ "schemaVersion": 1, "title": "书名", "author": "你的笔名" }
```

然后 `git init` 并提交一次。

> 插件只在**三条同时满足**时工作：① 目录是 git 仓库 ② 六个目录齐全 ③ `inkflow.json` 可解析。缺哪条，工具会告诉你缺什么。

## 5. 日常使用

### 5.1 工作台面板

左侧栏点 **InkFlow** 图标打开工作台：

- **左栏**：章节列表（章号 / 标题 / 状态 / 字数，来自索引）
- **中栏**：正文区（编辑能力在后续版本）+ 项目诊断（项目路径、索引状态、统计）
- **右栏**：六目录勾选状态 + 约定速览

### 5.2 对 AI 说人话就行

插件提供四个工具，DSH 里的 AI 会在需要时自己调用：

| 工具 | 作用 | 你可以这样说 |
|---|---|---|
| `inkflow_project_status` | 检查当前目录是不是 InkFlow 项目、缺什么、索引状态 | 「看看这个目录能不能写小说」 |
| `inkflow_project_init` | 生成项目骨架（目录 + `inkflow.json`，**不会** `git init`） | 「在这里建一本新书叫《蜀山》」 |
| `inkflow_index_rebuild` | 从文件重建索引并检查一致性 | 「重建一下索引」/「检查一下设定有没有冲突」 |
| `inkflow_chapter_list` | 按阅读顺序列出章节 | 「列一下现在有哪些章」 |

### 5.3 自己改文件后

用 VSCode/记事本直接改 `.md` 文件是**允许且推荐**的。改完让 AI「重建索引」，或手动调用 `inkflow_index_rebuild`。

索引是缓存：删掉 `index/inkflow.db` 也不会丢任何内容，下次使用时自动重建。

## 6. 文件格式速查

正文（`chapters/vol-01/0001-入山.md`）：

```markdown
---
id: ch-1
title: 第一章 入山
volume: vol-01
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
| 面板显示「未检测到 InkFlow 项目」 | 当前目录不是项目根 | 在项目目录里开会话，或先用 `inkflow_project_init` 建项目 |
| 工具报 `NOT_AN_INKFLOW_PROJECT` | 缺 git / 缺目录 / `inkflow.json` 坏了 | 看返回里的 `missing` 清单逐条补齐 |
| 左侧栏没有 InkFlow 图标 | 插件未安装/未激活，或改了代码没重启 | 检查插件列表；重启 DSH |
| 装了插件但工具列表里没有 `inkflow_*` | 还是旧版本代码在跑 | 重启 DSH |
| 改了章文件，面板还是旧的 | 索引未重建 | 触发 `inkflow_index_rebuild` 或重启会话 |
| 中文两字词搜不到 | trigram 分词限制 | 用 3 字以上关键词，或直接全文搜文件 |
| 文档乱码 / 项目识别失败 | 文件被写入了 UTF-8 BOM | 用「UTF-8 无 BOM」重新保存；插件读取时会容忍 BOM，但建议统一 |

## 9. FAQ

**Q：我的书会被上传吗？**
不会。第一阶段完全本地：没有账号、没有服务端、没有同步。只有你主动调用模型生成内容时，相关上下文才会发送给你自己配置的模型服务。

**Q：能多本书吗？**
能。一本书一个目录（一个 git 仓库），互不干扰。面板显示的是当前会话所在的项目。

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
