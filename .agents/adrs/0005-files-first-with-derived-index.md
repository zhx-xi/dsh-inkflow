# ADR-0005：文件真相 + SQLite 派生索引（取代 ADR-0002）

- 状态：**已采纳（用户拍板 2026-10-21）**，取代 [ADR-0002](0002-sqlite-truth-source.md)
- 日期：2026-10-21
- 影响：`.agents/specs/data-model.md`（原 SQLite 真相源设计）作废重写；P0 代码切换存储层

## 背景

P0 阶段按 ADR-0002 把 SQLite 定为唯一真相源。随后对比了 9 个竞品的真实存储形态（2026-10-21 实查 README + `package.json` 依赖 + 源码引用）：

| 项目 | 形态 | 存储 |
|---|---|---|
| AI-Novel-Writer / 书童 1687★ | 桌面 App | **SQLite**（`better-sqlite3@^12.8.0`）+ 作品文件夹 |
| Openwrite 848★ | DSH 插件 + 受管后端 | **后端 SQLite 事务**，插件侧作品目录 |
| dsh-novel-forge 25★ | DSH 插件 | **文件**（`novel.json`/`设定/*.json`）；SQLite 只做可重建检索索引，且「无 sqlite 自动退化」 |
| deepseek-harness-novel-studio 10★ | DSH 插件 | **纯文件**（`.novel-studio/project.json`） |
| novelAssist-dsh 1★ | DSH 插件 | **文件 + git 仓库为真相**（「文件是唯一真相」） |
| dsh-novel-writer 23★ | DSH 插件 | **文件目录**（`.novel-writer/*` + `state.json`） |
| dsh-novel-workbench / dsh-novel-craft / 催更姬 | DSH 插件 | 文件 |

**9 家里 7 家以文件为真相，唯一以 SQLite 为唯一真相的是那家桌面 App。**

用户据此拍板：采用文件为真相、SQLite 为派生索引。

## 决策

1. **文件是唯一真相**。每部小说 = 一个 git 仓库 = 一个项目根目录，正文与全部资料是可读的 Markdown/JSON 文件；`git` 即版本历史与回滚面。
2. **SQLite 只做派生索引**，放在项目根的 `index/` 下；任何时刻可删可重建，**不进版本控制**。
3. **不写数据库迁移**。升级只改「解析器版本 + 索引 schema 版本」；索引 schema 变化 → 直接删库重建。存量项目只受文件契约约束。
4. **约定大于配置**：目录名固定（英文），插件靠「目录存在 + 是 git 仓库」自证项目身份，不做项目注册表、不做路径配置文件。
5. **门禁**：工作区不是 git 仓库、或缺必需目录 → 插件业务工具一律拒绝并给出补齐清单，不猜、不自动在任意目录建库。

## 后果

**收益**
- 升级不破坏存量项目：文件格式向后兼容即可，索引丢了重建。
- 用户可以 `git diff` 看 AI 改了什么、`git revert` 回滚；也可以直接文本编辑。
- Agent 天然友好：DSH 的 Agent 本来就用文件工具读写，不需要为「改个角色卡」专门造一个写库工具。
- 迁移旧 InkFlow 数据变成「生成文件」，比「跨 schema ETL + 不变量对账」简单且可逐章核对。

**代价与对策**
| 代价 | 对策 |
|---|---|
| 关系查询、跨表不变量不在 DB 强制 | ①写入时校验（应用层）；②`index` 重建时做全量不变量检查，失败即报错并列出文件；③索引表的 UNIQUE 作为第二道 |
| 大库检索性能 | 派生索引 + FTS5（trigram ≥3 字 + 2 字 `LIKE` 兜底），与 ADR-0004 前的探针结论一致 |
| 并发/半写 | 单用户单实例；写文件走「临时文件 + rename」原子替换；索引重建用事务 |
| 目录被用户改名/移动 | 门禁 fail-closed，工具报「不是 InkFlow 项目根」并列出缺哪个目录 |

## 验证

- 约定本身：`.agents/specs/conventions.md`
- P0 实测：`tests/*.test.js`（门禁组合、索引重建幂等、不变量、HTTP 安全）；实测证据贴在对应 PR 评论（不入库）
