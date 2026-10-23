# ADR-0012：插件私有状态目录 `<book>/.inkflow/`（回收站 / 迁移备份 / 审计导出）与写白名单扩展

- 状态：已采纳（2026-10-24）
- 日期：2026-10-24

## 背景

0.3.0 有三件事要在书里留下一份「不是正文、也不是索引」的东西：

| 需求 | 来源 | 内容性质 |
|---|---|---|
| 回收站 | #35 | 用户删掉的章/条目原文，**用户数据**，要能恢复 |
| 迁移备份 | #36 | 一次批量变更（6→9 目录、frontmatter 修复）之前的快照，**回滚包**，机器读 |
| 审计导出 | #33 | 体检报告 Markdown，**派生物**，可随时重算 |

现有的两个候选落点都不成立，原因是实测过的约定事实：

1. **`index/` 不能放用户数据**。`index/` 的契约是「除 `.gitkeep` 外全部是派生物」（[conventions.md](../specs/conventions.md) §2），而且 ADR-0006 D2 规定 `index/` 目录缺失时**静默重建并继续**（`indexDirRecreated: true`）。用户为了重建索引而删掉 `index/` 是常见动作，把回收站放进去等于「重建索引就丢回收站」，与 [data-safety](../constitution/data-safety.md) 的写入纪律直接冲突。
2. **`index/` 里的文件默认会被 git 提交**。`REQUIRED_GITIGNORE_LINES` 只忽略 `index/*.db`、`*.db-wal`、`*.db-shm`（`src/host/conventions.ts:145`）。把回收站放 `index/trash/` 会让**已删除的正文以新文件身份重新出现在 `git status` 里**，并且被作者一不小心提交进历史。
3. **`$DSH_HOME/inkflow/` 需要项目 id**，而 `inkflow.json.projectId` 是 [open-questions](../specs/open-questions.md) Q12 的未裁决项（由共享库单落地）。用它做目录键会把「回收站」绑到一条还没落地的口径上；而且它不随书走，换个 DSH_HOME 或换台机就找不回来。
4. **新增第十一个内容目录不可接受**：十项必需目录是门禁判据（ADR-0006 D1/D2），改它要同时动门禁、向导、`CONTENT_DIRS` 与 spec，代价远大于收益。

写路径本身还有一条硬约束（risk R-04）：插件在宿主进程内可写任意路径，因此**所有写入都必须经 `io.ts` 的 `resolveWriteTarget` 白名单**，`..` 与符号链接逃逸必须被拒。

## 决策

在**书的根目录**下新增一个点开头的私有状态目录，三件事各占一个子目录：

```
<book>/.inkflow/
  trash/     # 回收站：<保留原相对路径> + 清单（#35）
  backup/    # 迁移/修复前的回滚包（#36）
  audit/     # 体检报告导出（#33）
```

可执行、可检验的六条：

1. **它不是内容目录**：不进 `CONTENT_DIRS`、不是门禁必需项、不产 `entities` 行、不被索引扫描、不参与 catalog。门禁对它的存在与否**不表态**（存在即允许，缺失不修）。
2. **它不进 git**：那行由**首次使用它的写入者**追加（`ensurePrivateStateIgnored()`，append-only，与向导同一纪律），**不放进** `REQUIRED_GITIGNORE_LINES`。理由：`.inkflow/` 是可选的，门禁不该为一个从不删东西的书永久列一条「缺 ignore 行」的修复动作；而那行真正开始起作用的时刻，正是第一次往里写东西的时候。
3. **它只能经白名单写**：`resolveWriteTarget` 允许的写入前缀从「九个内容目录 + `index/`」扩到再加 `.inkflow/trash/`、`.inkflow/backup/`、`.inkflow/audit/` 三条**子路径**（不是整个 `.inkflow/`），其余子路径仍拒；`..`、绝对路径、符号链接逃出项目根仍拒。
4. **不自动清理用户数据**：`trash/` 不按时间或体积自动删除任何东西；超过阈值（【推断】500 条或 50 MB）只在面板提示「可以清空」，清理永远是显式动作且需二次确认（[data-safety](../constitution/data-safety.md) 的「危险操作」条）。
5. **删 `index/` 不影响这里**：`index/` 的重建只碰 `index/`；`.inkflow/` 的存续与索引无关。
6. **`audit/` 只放派生物**：报告随时可重算，删了不丢真相；因此它是三者中唯一允许被工具覆盖/清理的。

## 备选与取舍

| 方案 | 优点 | 代价 | 为什么没选 |
|---|---|---|---|
| `index/trash/`（#35 正文原写法） | 零新概念，落点现成 | `index/` 缺失即被静默重建 → 丢回收站；默认会被 git 提交（只忽略 `*.db`）；违反「`index/` 全是派生物」 | 与 ADR-0006 D2 直接冲突，且制造一条「重建索引即丢数据」的路径 |
| `$DSH_HOME/inkflow/trash/<projectId>/` | 书目录保持纯净；跨书集中管理 | 依赖未裁决的 `projectId`（Q12）；不随书走；用户看不到、也想不起来 | 把功能绑在未落地口径上；且「书搬到另一台机就找不回」对误删恢复是致命的 |
| 新增一级目录 `trash/`（等同内容目录） | 语义最直白 | 要改十项必需目录、门禁、向导、`CONTENT_DIRS` 与 IDE/编辑器约定；空目录还要 `.gitkeep` | 为一份临时副本改掉整个目录契约，代价与收益不成比例 |
| **`<book>/.inkflow/{trash,backup,audit}/`**（选中） | 随书走、与索引无关、git 忽略一行搞定、点开头一眼看出是工具状态 | 写白名单要显式扩三条子路径；跨机器不同步 | — |

## 后果

| 收益 | 代价与对策 |
|---|---|
| 回收站/备份与 `index/` 生命周期解耦，重建索引不再是一条数据丢失路径 | 写白名单扩宽——用「三条子路径」而非整目录，并配越界用例（`../`、绝对路径、符号链接） |
| `.gitignore` 一行覆盖三者，`git status` 始终干净 | 向导只 append：已有 `.gitignore` 不被改写，缺行时列入可执行动作 |
| 书目录自包含：拷走整个文件夹，回收站也在 | 跨机器/跨 DSH_HOME 不同步——可接受：**跨机的真相是 git**，回收站只解决「未提交前的误删」 |
| 备份包与回收站共用落点、各自一个模块（roadmap X-10） | 两个模块要各自带清单格式；不共享格式是有意的（语义不同，共享会迫使一方迁就另一方） |

## 验证

- `tests/io-writer.test.js`：`.inkflow/trash/a.md` 可写；`.inkflow/other/a.md`、`.inkflow/../x.md`、指向项目外的符号链接均被拒。
- `tests/workspace.test.js`：`REQUIRED_GITIGNORE_LINES` **不含** `.inkflow/`（门禁不为可选目录制造修复动作），向导只追加不改写。
- `tests/private-state.test.js`：`ensurePrivateStateIgnored` 幂等、append-only、认得 `.inkflow` / `/.inkflow/` / 带空格的同一规则；`.gitignore` 不可写时返回值而不是抛出。
- `tests/trash.test.js`（#35）：删章后原文在 `.inkflow/trash/<原相对路径>`、恢复后字节与 hash 一致、`git status` 无新增未跟踪文件。
- 手工：删掉 `index/` 后回收站条目仍在。
