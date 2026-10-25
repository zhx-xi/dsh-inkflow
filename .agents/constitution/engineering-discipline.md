# 工程纪律（Engineering Discipline）

> 本文件是「怎么做」的执行细则：[constitution.md](constitution.md) 是「为什么/必须达到什么」，这里给可照做的步骤。

## 1. SDD：Spec 先行

流程：**Spec → Test (RED) → Code (GREEN) → Refactor → Commit**。

- **动手写代码前必须读对应 spec**（`.agents/specs/`）。
- **spec 是开发的唯一真相来源**：发现 spec 与实现矛盾 → **先改 spec**，再改代码。
- 新功能默认：先在 `.agents/specs/` 落一节（或新文件），再开测试。
- spec 写「是什么」（数据形状、契约、边界、验收），不写「怎么做」（不贴实现代码、不贴迁移 SQL）。
- spec 篇幅纪律：单文件 **≤800 行**（[AGENTS.md §9.3 S6](../../AGENTS.md)）；超出且章节内聚时，允许同目录 `references/` 子目录，但 spec 头部必须列出引用了哪些 references。

## 2. TDD：RED → GREEN → REFACTOR

```
1. RED:      先写会失败的测试 → 运行 → 确认 FAIL（且失败原因对）
2. GREEN:    写最少代码 → 运行 → 确认 PASS
3. REFACTOR: 重构 → 运行 → 仍 PASS
4. 提交:     pnpm run check 全绿后提交
```

铁律：

- **每个产出代码的层都要有测试**：Host 工具、索引构建、门禁判定、HTTP 路由、frontmatter 解析都算。
- **测试打构建产物**（`lib/index.js`）：测的是用户真正装到的东西，不是源码的美好版本。
- **不写无意义测试**：测试必须能在代码损坏时 FAIL。宁可没有信号，不要假信号。
- **每个不变量至少一条「它确实会拦住」的用例**（例如缺 `overall` 大纲必须报 `OUTLINE_NO_OVERALL`）。
- bug 修复必须带回归用例，且用例应精确复现根因（不是「跑一遍全绿」）。
- 扩展既有测试文件优于新建；新功能才开新文件。

## 3. ADR 治理

规则见 [AGENTS.md §9.2](../../AGENTS.md)（A1–A7）。本节只留执行动作：

1. 出现技术选型/架构边界/数据格式/对外契约的变更 → 先查 [.agents/adrs/README.md](../adrs/README.md) 有无相关 ADR；
2. 需要新决策 → 按模板写 `NNNN-<slug>.md`，并在索引表 + 决策速览登记；
3. 再改代码；提交信息与 PR 引用 ADR 编号。

## 4. 提交与合并

- **Conventional Commits**：`type(scope): description`，冒号后**小写**、不加句号。
  - `type`: `feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `build`
  - 例：`feat(tools): add inkflow_chapter_list`、`docs(specs): move proposals under index/`
- 一次提交只做一件事；重构与功能分开。
- 提交前：`pnpm.cmd run check` 全绿。
- 提交信息写「为什么」而不是罗列「改了什么」（改了什么看 diff）。
- 工作项（GitHub issue）必须挂到**当前里程碑**；完成过程中新发现的缺陷/补充分项也直接挂当前里程碑，仓库里不允许出现无里程碑的 issue。

## 5. 评审（单人项目的自查清单）

提交前逐条自问（这是**实现者**的自查；合并前的独立评审另按 §9.1）：

1. 有没有引入运行时依赖？（`package.json` 的 `dependencies` 必须保持为空）
2. 有没有 `@deepseek-ai/*` 的运行时 import？
3. 有没有把「已验证」写成了「应该可以」？
4. 新写的不变量有没有「它会拦住」的测试？
5. 有没有在随机目录写文件 / 建库？
6. 新增的可见 UI 文本是否走宿主主题 token 与本地化？
7. 文档链接是否仍然有效（`node scripts/check-links.mjs`）？

## 6. 文档纪律

硬性门禁见 [AGENTS.md §9.5](../../AGENTS.md)（D1–D7）。本节只留两条操作习惯：

- **来源标注**：写设计/规格时逐条标【已定】/【既有资料】/【推断】/【外部参考】；推断集中进 [open-questions](../specs/open-questions.md)，拍板后转为「裁决记录」（保留原推断与用户原话要点，防止被改回去）。
- **改动顺序**：先改文档（spec/ADR）→ 再改测试 → 再改实现；文档迁移时同一提交内修完相对链接。

## 7. 证据纪律

- **编号不进代码**（作者 2026-10-25 裁决，绝对规则）：`src/`、`scripts/`、`tests/` 里**不允许出现 GitHub issue / PR 编号**（`#123`、`issue #123`、`(#123)` 都算）。要解释「为什么这样写」，就把理由写成话；编号属于提交信息、PR 与 issue 线程（D7 的落点）。`scripts/check-issue-refs.mjs` 是这条的机制，红/绿由它判。文档（`.agents/**`、`docs/**`）不受此限：spec/ADR 引用决策来源是记录，不是代码。
- 结论必须能指到**文件路径 + 行号**或**命令 + 输出**。
- 「我认为应该」不算证据；要么跑一次，要么标【未验证】。
- 排查顺序：先只读取证 → 再改；改动前给出根因与最小修复面。
- 涉及用户数据的操作：先盘点影响面，再执行，执行后复核并如实报告偏差。

## 8. 外部参考与竞品对照

实现功能前先看已有实现，避免重新发明。**复用的档位由 [ADR-0027](../adrs/0027-external-reference-tiers.md) 定义**：方法论一律自写、纯数据表（词表/阈值/类别名单）可引用但须在使用处署名、代码只允许单文件移植并须在文件头写明来源与许可。非宽松许可（GPL 等）仍**只读行为**，不适用数据表与代码档。

参考对象是本项目评估过的开源项目：

| 项目 | 许可 | 可学 | 不可做 |
|---|---|---|---|
| Openwrite（845★） | Apache-2.0 | 项目/卷章的数据形状、写作主界面信息架构 | 直接复制源码或界面资源 |
| novel-forge（24★） | MIT | 工具面切分、门禁清单 | 直接复制源码 |
| novel-studio（10★） | MIT | 设定库的树/关系组织 | 直接复制源码 |
| AI-Novel-Writer（1655★） | 桌面 GPL-3.0 / 插件 MIT | 只读**行为**（交互流程、边界处理） | 读 GPL 代码后改写（copyleft 污染），任何代码复制 |
| oh-story-claudecode（7982★） | MIT | 检测器设计（退化检测、AI 指纹类别）、细纲字段形状、失败语义（能力探测 + 优雅降级） | 整包派生（4.3 MiB / 431 文件）；扫榜爬虫与封面外呼（违反零依赖与 X-26）；把它的 `_tracking-state.json` 当权威（与「文件是真相」冲突） |

步骤（每个功能 issue 执行一次）：

1. **定位**：在参考项目里找到对应模块，记录文件路径 + 提交引用（证据可复跑）；
2. **提炼设计**：数据形状、交互流程、边界与失败处理，而不是抄实现细节；
3. **对照本项目契约**：文件真相 + 派生索引、零运行时依赖、单工作区单项目、四态门禁与 plan→apply 向导——参考实现里哪些前提我们不成立；
4. **写取舍**：借什么、为什么不照搬、我们改成什么样（一条一句）；
5. **落位置**：结论写进该 issue 的评论或 PR 描述（D7 不入库）；若牵涉架构边界/数据格式，按 A1 先落 ADR。

判据：一个功能 PR 若没写「参考了谁、借了什么、改了什么」，视为未完成评审。

## 9. 合并前评审与完成声明 Gate

本节约束两件彼此独立的事：**实现者不等于评审者**，以及**证据必须由声明完成的人本人在当前树复跑**。CI 全绿并不覆盖这两点——冲突可能到合并时才暴露，子 agent 自述的「全绿」也不等于当前树的真实输出。

### 9.1 合并前独立评审（不能由实现者自己完成）

每个 PR 在 squash merge 前必须有一次**独立于实现过程**的评审，产出「通过 / 需修改」结论：

- 评审者：PR 由子 agent 实现时是 Lead；Lead 本人是主要实现者时，另派 review 子 agent。
- 评审输入：该 issue 的验收标准 + 相关 `.agents/specs/` 契约 + `git diff origin/main`。**不只看实现者的总结。**
- 评审清单（逐条给结论，禁止笼统「看起来没问题」）：
  1. diff 是否只做了 issue 范围内的事（越界改动单列）；
  2. 新增/改动的行为是否有测试，且测试真会在实现坏掉时失败（指出断言点）；
  3. spec 是否同步（口径变了、文档没改 = 未完成）；
  4. 是否引入运行时依赖 / `@deepseek-ai/*` / 硬编码颜色 / 仓库内证据文件；
  5. 失败路径是否零写盘（门禁拒绝、CAS 冲突、路径逃逸）。
- 结论写进 PR 评论（D7）；「通过」也要留一行评审范围与逐项结论。
- 与改动无关的条目（如 docs-only PR 的写盘类判据）写 **N/A**，不留空、不略过。

### 9.2 完成声明 Gate

在向用户报告「完成 / 通过 / 已修复」之前：

```
1. IDENTIFY：哪条命令能证明这句话？
2. RUN：声明者本人，在当前树，完整跑一次（不接受子 agent 的输出转述）
3. READ：读完整输出，看 exit code 与失败数
4. VERIFY：输出确实支持这句结论；**不支持时以实际状态 + 证据陈述**（不改写结论去迁就预期）
5. ONLY THEN：写进回复/PR，并引用本次输出
```

- 子 agent 的「通过」「全绿」只是线索，不是证据；Lead 以自己的执行结果为准（`#7` 事故的教训）。
- 只跑了部分检查（如只跑 `pnpm test`）就声明「check 全绿」= 虚假声明。
- 措辞禁用「应该」「大概」「看起来」；没跑就写【未验证】并说明原因。

### 9.3 缺陷修复先复现

修 bug 的 PR 必须包含**修复前的失败证据**，优先脚本化：

- 一条可复跑的命令/脚本（放 `.tmp/`，D7 不入库）或一条先红后绿的测试；输出写进 PR/issue 评论；
- 确实复现不了时，写清「复现不了的部分」与基于代码/日志的根因推理；
- 没有复现证据的「预防性修改」按 `refactor` / `test` 提交，不得写成 `fix`。

### 9.4 issue 的 Review Focus

每个功能 issue 在实现前补一节 **Review Focus**：3–5 条「spec 没写、但用户一定会遇到」的输入/条件及其应有行为。

- 示例（来自 `#5`）：同 size 同 mtime 的内容替换、调用方不给 `expected` 时的覆盖行为；
- 每条 Review Focus 必须落到某个测试，或显式标【未验证】；
- 依据：spec 是愿景文档，**没写不等于可以出错**。

### 9.5 CI 门禁的机制保障

「CI 绿才能合」如果只写在本文件里，它就是一句承诺——GitHub 的一个设置页改动就能让它失效，而仓库里没有任何东西会报错。所以门禁必须同时是三样东西：**强制配置 + 仓库内可验证 + 应急出口有留痕**。决策与备选见 [ADR-0011](../adrs/0011-ci-merge-gate.md)。

- **必过检查的清单只有一处**：[scripts/branch-protection-rules.mjs](../../scripts/branch-protection-rules.mjs) 的 `REQUIRED_CONTEXTS`。本文不复制它——抄一份就等于埋一个漂移源。改 job 名等于删门禁，必须同步改那个常量，改完用下面的 `check` 证明。
- **期望值单一来源**：同一个文件里的 `EXPECTED` 集中定义 `strict: true`（分支须与 main 同步）、`enforce_admins: true`（管理员也不能绕过）、禁 force push / 禁删分支、`required_conversation_resolution: true`。
- **验证**：`node scripts/branch-protection.mjs check`（只读，PASS/FAIL 逐项给理由）。它接在 `pnpm run check` 末端并以 `--tolerant` 运行：缺 gh / 未登录 / 无网络时打印 `SKIP …（未验证）` 并 **exit 0**，因为本地全量门禁必须在离线机器上可跑。`--tolerant` 只覆盖「拿不到结论」，**读到了但不符照样 exit 1**。
- **SKIP 不等于通过**：声明「门禁已验证」前，必须跑一次不带 `--tolerant` 的 `check` 并引用输出。
- **应用**：`node scripts/branch-protection.mjs apply`（幂等，需仓库 admin；写完自动回读再评估，`--dry-run` 只打印 payload）。它会把已开启的「必须评审」要求原样保留，不会顺手删掉自己不管的设置。
- **唯一应急出口**：当 CI 自身坏在 main 上、导致所有 check 永久 pending 时（此时任何 PR 都无法合并），可 `gh api -X DELETE repos/OWNER/REPO/branches/main/protection` 临时解除阻塞，修完后**立刻** `apply` 并用 `check` 证明恢复；全过程在对应 issue 留时间、原因与恢复证据。
  - 出口的第二步必须能吃「未受保护」这个状态：`GET …/protection` 在此时 404 `Branch not protected`，`apply` 据此判定「没有设置需要携带」并直接装上（`check` 在这一步之前会红，**`--tolerant` 也不例外**——「没有门禁」是配置错误，不是拿不到结论）。这是**唯一**允许在预读失败后继续写入的情形——其它任何失败（缺 gh / 未登录 / 网络）都仍然拒绝，因为那时当前设置是未知的，盲写会静默删掉别人的评审要求。
- **平台前提**：分支保护需要仓库为 **public** 或账户付费（private + 免费额度会 403 `Upgrade to GitHub Pro`）。仓库若转 private 而账户没升级，`check` 只能走「读不到 → SKIP」，漂移检测会**静默消失**——转换前先确认账号能力。
- **触发面**（`.github/workflows/ci.yml` 顶部有注释）：PR 面向 `main` 时跑 `pull_request`（合并前门禁）；合并后 `main` 跑 `push`（验证真正落地的 squash commit）；`merge_group` 为 merge queue 预留——GitHub 只在仓库启用队列时派发该事件。
- **分支落后的同步手法**（`strict: true` 下的常规操作）：`gh pr update-branch <n> --rebase`，或本地 `git merge origin/main` + **普通** `git push`。保护规则只作用于 `main`，技术上 `--force-with-lease` 也能推进 PR 头分支，但**不用**它：改写头分支会让已发出的评审意见与 diff 行号错位，评审锚点就丢了。同步后 5 个 check 全部重跑，等于重新过一遍门禁。
- **与 `AGENTS.md` §9.5 的区别**：本节讲 CI 门禁（GitHub 平台配置），`AGENTS.md` §9.5 讲文档门禁（D1–D7）。引用时带限定词，避免同号混淆。
