# ADR-0023：提案与批量作业的私有落点（`.inkflow/{proposals,jobs}`）与写白名单的第三次扩容

- 状态：已采纳（2026-10-25）
- 日期：2026-10-25

## 背景

0.5.0 又有两样东西要在书里落下「不是正文、也不是索引」的东西，而且两样都比前几次更怕重建：

| 需求 | 来源 | 内容性质 | 断一次电会怎样 |
|---|---|---|---|
| 提案 | #45 | 会话模型产出的改写草稿 + 逐段 diff，等作者决定接受/拒绝 | 作者的接受进度没了，重来一遍（模型调用不可复现） |
| 批量作业进度 | #47 | 「批量起草跑到第几章、哪些章已完成」 | D5-5 的断点续跑变成假的：重启后只能从头来 |

现行落点（[ADR-0012](0012-plugin-private-state-dir.md)）已经划到 `.inkflow/{trash,backup,audit,candidates}/` 四条子路径，`resolveWriteTarget` 的白名单只认这四条（`src/host/conventions.ts` 的 `PRIVATE_STATE_SUBDIRS`、`src/host/io.ts` 的 `privateSub` 判定）。而 #43 / #47 的正文分别写了 `index/audit/` 与 `index/jobs/`，`index/` 的契约是：

1. **除 `.gitkeep` 外全是派生物**（[conventions §2](../specs/conventions.md)）；
2. **目录缺失时静默重建并继续**（ADR-0006 D2，`indexDirRecreated: true`）；
3. `.gitignore` 只忽略 `index/*.db`、`index/*.db-wal`、`index/*.db-shm`（`REQUIRED_GITIGNORE_LINES`）。

于是把作业进度写进 `index/jobs/` 就等于：**作者为了重建索引删掉 `index/`，断点一起没了**；而且那个 JSON 会被 `git status` 当成新文件，随时可能被提交。

## 决策

### D1 `.inkflow/{proposals,jobs,audit}/` 与既有子路径同列

`PRIVATE_STATE_SUBDIRS` 从四条扩到六条（`trash` / `backup` / `audit` / `candidates` / `proposals` / `jobs`），`resolveWriteTarget` 的白名单随之扩到六条**子路径**（不是整个 `.inkflow/`）：

```
<book>/.inkflow/
  trash/       # 回收站（#35）
  backup/      # 回滚包（#36 / #42 / #51）
  audit/       # 体检报告（#33）+ 门禁结论 gate-<chapterId>.json（#44，见 ADR-0022 D4）
  candidates/  # 提取候选（#38）
  proposals/   # 提案：草稿 + 逐段 diff，等作者决定（#45）
  jobs/        # 批量作业进度与断点（#47）
```

理由不是「同类东西放一起」，而是**「重建不可再生」的判据**：`index/` 可以删，删完重扫文件就回来了；提案与作业进度删了就没了。凡是「重建不可再生」的插件状态，一律进 `.inkflow/`。

### D2 `index/` 除 `.gitkeep` 与数据库文件外保持为空（用例断言）

新增一条用例：跑完私有状态的六类写入后，`readdirSync(<book>/index)` 的结果必须只含 `.gitkeep` 与 `*.db` / `*.db-wal` / `*.db-shm`。这条断言针对的不是某一次具体 bug，而是 #43/#47 正文里那句「落 `index/…`」——把它变成红的能力比评审时说一遍可靠。

### D3 `.gitignore` 的 `.inkflow/` 行仍由首次使用方 append-only 追加（X-9 不变）

`PRIVATE_STATE_IGNORE_LINE` 仍**不在** `REQUIRED_GITIGNORE_LINES` 里：`.inkflow/` 是可选的，门禁不该为「从不删东西、也从不提提案」的书永久列一条修复动作。第一次往任一子目录写入时由 `ensurePrivateStateIgnored()` 追加（`tests/private-state.test.js` 已断言幂等与「认得三种同义写法」）。

### D4 逃逸仍然要拒

白名单扩宽**不**放松任何路径检查：`..` 段、绝对路径、UNC、指向项目根之外的 junction/symlink 一律拒；`.inkflow/` 本身与六条之外的任何名字（`.inkflow/other/`、`.inkflow/proposals` 作为**文件**而非目录）也拒。放宽的只是「哪六个名字可写」，不是「怎么判合法」。

### D5 谁来写

| 子目录 | 写者 | 读者 |
|---|---|---|
| `proposals/` | #45（提案落盘/状态翻转） | #45 面板、#46 审稿（读同一份提案上下文） |
| `jobs/` | #47（作业开始/每章完成/暂停/恢复） | #47 面板与工具 |
| `audit/` | #33（报告，带戳）、#44（门禁结论，不带戳） | 体检页、门禁页 |

三条子路径都是「一个模块写、别人只读」；没有任何一方被允许遍历它们来做业务判定（它们不产实体、不进索引——`walk()` 跳过全部点开头项）。

## 备选与取舍

| 方案 | 优点 | 代价 | 为什么没选 |
|---|---|---|---|
| 按 issue 正文落 `index/audit/`、`index/jobs/` | 零新增白名单条目，路径现成 | `index/` 缺失即静默重建 → 断点与门禁结论一起消失；只忽略 `*.db` → 这些文件会被提交；直接违反「`index/` 全是派生物」 | 把 D5-5 的断点续跑做成假的，是功能层面的失败，不是整洁问题 |
| 落 `$DSH_HOME/inkflow/{proposals,jobs}/<projectId>/` | 书目录保持纯净，跨书集中管理 | 作业进度**必须随书走**（换机继续跑、git clone 到另一台继续）；`inkflow.json.projectId` 仍是可选字段（#40 的 `ensureProjectId` 只在共享库路径上按需补），缺失时无从取键 | 断点续跑的前提是「进度和书在一起」；放进 `$DSH_HOME` 等于承认换台机就得从头来 |
| 新增第十一个内容目录 `proposals/` | 语义最直白，编辑器里一眼看见 | 要同时改 `CONTENT_DIRS`、`REQUIRED_DIRS`、门禁、向导、`.gitkeep`、spec 与 IDE 约定 | 提案是**工作物**（可能永远不被接受），把它做成作品内容会让门禁为它背书 |
| 提案不落盘，直接写章节 + 靠备份包回滚 | 少一个落点 | 「逐段接受/拒绝」意味着接受是**多次**动作，中间态必须持久；未接受的提案一个字都不能进正文 | 部分接受是这个功能的全部价值（#45 的核心），它就是需要一份持久的工作副本 |
| 整个 `.inkflow/` 放开写 | 以后不用再扩白名单 | 白名单从「六个关闭的名字」退化成「调用方随便造目录」；文件名逃逸面（保留字、长路径、符号链接）要在更多层级上兜 | 白名单的价值在于**它是关闭的**；每扩一次都该是一次显式决策（这正是本 ADR 存在的理由） |

## 后果

| 收益 | 代价与对策 |
|---|---|
| 提案与作业进度扛得住「重建索引」「删 `index/`」，也不会被提交进 git | 白名单再加两条：`tests/io-writer.test.js` 的六子路径用例与 `index/` 空目录用例是这条的机制承载 |
| `.inkflow/` 与 `index/` 的边界一句话能说清：可重建的进 `index/`，不可再生的进 `.inkflow/` | `audit/` 是唯一一个「可重建却也放在这里」的例外（报告随时能重算），继续保留在 `.inkflow/` 是因为它历来与回收站/备份同处，且它被 git 忽略更合适 |
| 面板与工具用同一套相对路径拼装（`privateStateRelative()`） | 新增子路径要同时改 `conventions.ts`、`io.ts` 的错误文案与架构表（模块表守卫会对拍） |
| #43/#47 的正文口径被覆盖，但不改它们的话 | 以本 ADR 为准（A7）；#43/#47 落地时按 `.inkflow/audit/`、`.inkflow/jobs/` 写 |

## 验证

- `tests/private-state.test.js`：`PRIVATE_STATE_SUBDIRS` **精确等于**六个名字（顺序也断言）；`privateStateDirRelative('jobs')` / `privateStateRelative('proposals', …)` 的拼装；`.gitignore` 仍只由首次使用方追加，且 `REQUIRED_GITIGNORE_LINES` 不含 `.inkflow/`。
- `tests/io-writer.test.js`：
  - 六个子路径都能 `resolveWriteTarget` 且 `target.dir === '.inkflow'`；
  - `.inkflow/proposals`（无文件名）、`.inkflow/proposals/../../chapters/x.md`、`.inkflow/other/x.md` 分别以 `PATH_INVALID` / `PATH_INVALID` / `PATH_NOT_WRITABLE` 拒；
  - 真实写入 `.inkflow/proposals/ch-0001/0001-diff.json` 与 `.inkflow/jobs/<stamp>-draft.json` 成功（证明是「可写」而不只是「可解析」）；
  - **新增**：六类私有写入之后，`index/` 只剩 `.gitkeep`（且允许集合 = `.gitkeep` ∪ `*.db*`）。
- 逃逸面（既有用例继续跑）：`../`、绝对路径、`C:\` / UNC、项目外 junction 均拒（`tests/io-writer.test.js` 的 junction 用例）。
- 手工（#45 落地后）：写入 `proposals/` 之后 `git status --porcelain` 仍然干净（`.inkflow/` 已被忽略）。
