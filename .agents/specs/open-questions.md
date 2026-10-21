# 待裁决清单（Open Questions）

> **唯一允许频繁更新的规范类文件**。AGENTS.md 不承载易变内容，所有「还没定、等用户拍板」的事项都落在这里。
> 状态流转：`待定` → `已裁决`。已裁决项**不删除**，转入文末「裁决记录」并保留原推断与用户原话要点（防止下一轮被改回去）。

## 待定

| # | 问题 | 建议默认值 | 影响面 | 状态 |
|---|---|---|---|---|
| Q1 | `index/` 缺失时自动重建（其余五项缺失即拒绝） | 接受——否则误删索引目录即永久失效 | 门禁 | 待定 |
| Q2 | 伏笔 / 时间线 / 知识关系 / 账本的归属子目录 | 伏笔 → `outlines/foreshadowing/`；时间线 → `world/timeline/`；知识关系/角色关系 → `world/relations.json`；账本 → `world/facts/` | 数据模型（P1 落地前必须定） | 待定 |
| Q3 | 目录名是否就按 `chapters/characters/world/outlines/library/index` | 按此套（「资料」用 `library`） | 全部 | 待定 |
| Q4 | 每部小说一个 git 仓库与外层仓库的嵌套关系 | 外层 `.gitignore` 忽略各书目录（不用 submodule） | 仓库结构 | 待定 |
| Q5 | `inkflow_project_init` 是否需要自动 `git init` | 不需要——仓库身份/远端由用户决定 | 工具边界 | 待定 |
| Q6 | frontmatter 的键是否允许非 ASCII（如 `作者备注: 待改`） | 暂不允许：现存语法是 `^[A-Za-z_][A-Za-z0-9_-]*:`，中文键行会被记成 `FRONTMATTER_ISSUE`（不影响正文与索引可用）。若要支持，需先定键名规范化与写回规则，否则 `patchFrontmatter` 无法保留该行 | frontmatter 语法 / 老稿导入（issue #8 实测发现） | 待定 |

## 已裁决（裁决记录）

| # | 原推断 | 处置 | 用户原话 / 修正要点 |
|---|---|---|---|
| Q0 | 存储采用 SQLite 为唯一真相源（ADR-0002） | ✏️ 修正为 **B：文件真相 + SQLite 派生索引** | 「我选择B，文件真相+sqlite派生索引，这样后续插件升级不影响现存项目，并且不需要考虑数据库迁移」；另要求「一个小说一个 git」+ 六个英文目录门禁（ADR-0005） |
| — | 文档体系：spec/adr 放 `docs/` | ✏️ 修正为 `.agents/{constitution,specs,adrs}` | 「spec、adr、政策文件统一放到 .agents 目录下分别创建 constitution、specs、adrs 目录」 |
| — | `docs/` 放验证证据与归档 | ✏️ 修正为 `docs/` 只放**用户使用手册**；证据与过程稿走 issue/PR comment | 「docs/下应该放用户使用手册，而不是其他内容」「本次产生的内容放到临时文件，放到 issue comment 和 PR comment，不保留在项目 git 中」 |
| — | AGENTS.md 含「当前待拍板」小节 | ✏️ 移出本文件，改由本清单承载 | 「AGENTS 中的 11.当前待拍板删除，这个 AGENTS.md 不应该经常修改」 |
| — | spec 单文件 ≤500 行 | ✏️ 修正为 **≤800 行** | 「2. 800行」 |
