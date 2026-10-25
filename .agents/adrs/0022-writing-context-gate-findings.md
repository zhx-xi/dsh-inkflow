# ADR-0022：简报/门禁/审稿的装配与问题形状（一个装配、一份问题词表、一份可 diff 的门禁结论）

- 状态：已采纳（2026-10-25）
- 日期：2026-10-25

## 背景

0.5.0 的六个单里有四个（#43 九段简报与质量门禁、#44 七项门禁、#45 提案制与 diff、#46 审稿 DAG）都在做同一类事：**把若干段材料拼进一次生成，或者把「哪里不对」讲清楚**。三处接缝是已经踩过的坑的复现，不是新想法：

| 接缝 | 现状 | 如果不先定口径 |
|---|---|---|
| 上下文的装配 | `buildWritingContext()`（`src/host/writing-context.ts`）是纯投影：六段（`project → chapter → tail → world → facts → foreshadow`）、一个全局预算 `DEFAULT_BUDGET_TOKENS = 1200`、一条写死的裁剪阶梯；`EXTRA_SEGMENTS` 只让域声明 `{name,label,capRatio,build}`，顺序与阶梯归本模块（X-13） | #43 要扩到 9 段并加「预览 + 审计」。预览若另写一份装配，预览与真实注入必然漂——0.4.0 在「两份 body 白名单」上刚吃过这个亏（`routes.ts` 手抄字段集，后由 `SETTINGS_FIELDS` 派生修掉，#166） |
| 问题的形状 | `src/host/findings.ts` 只有一套：`{code, group, severity, locator, detail, hint, fixable}` + `FINDING_CODES` 目录 + `compareFindings` 的稳定排序，且与 [data-model §5](../specs/data-model.md) 由 `tests/findings.test.js` 双向对拍（X-14） | #44 门禁、#46 审稿、#45 提案的逐段差异都是「带定位的问题」；各造一套等于三套词汇，体检页与门禁页各认一套，同一个毛病在两张表里长成两个名字 |
| 门禁结论落在哪 | #43 正文写「注入审计落 `index/audit/`」，#47 写「进度落 `index/jobs/`」 | `index/` 的契约是派生物且**缺失即静默重建**（ADR-0006 D2）——结论落进去等于「重建一次就没了」；落点口径见 [ADR-0023](0023-proposal-job-private-placement.md) |
| 时间轴的解释 | `timeline/` 的 `worldTime` 是扁平标量（data-model §3.4），比较只能靠字符串；多纪元一来，同一个字符串在不同纪元是两个日子 | #48 要在索引里加派生的绝对日列。换算不在一个纯函数里，就会出现「索引算一遍、面板再算一遍」，两处差一天没人查得出来（X-28） |

## 决策

### D1 一个装配点：简报与注入共用一个装配、一份段渲染器

> **修订（2026-10-25，#43）**：本节标题原写 `buildWritingContext()` 是「简报的唯一入口」，落地后函数名分开、纪律不变——简报的装配是 `buildWritingBrief()`，旧六段注入仍是 `buildWritingContext()`，两者**共用** `writing-context-render.ts` 的同一份段渲染器。**注入面本轮未切换**（生成路径仍用六段装配）：`tests/prompt.test.js:516` 钉死 `section.text === buildWritingContext(root).text`、同文件 286–357 钉死六段阶梯，迁移要一次性改这三处断言，已在 **#183** 立单专门做。因此本 ADR 的「预览＝注入」目前只对**简报自身**成立（预览与审计同源），对生成路径要等 #183。

> **修订（2026-10-25，#183 落地）**：生成路径已切到 `briefFor()` → `buildWritingBrief()`，注入、`GET /brief` 与落盘审计现在是同一次计算、同一份入参，D1 的「预览＝注入」对生成路径成立。三处旧断言按上面的约定**迁移**而非删除（`tests/prompt.test.js` 里标 `MIGRATED (#183)`）：section 文本改为逐字节等于简报的 `text`，裁剪断言改钉 `BRIEF_TRIM_ORDER` 与「`outline`/`promise`/`characters` 永不裁」，模板外超预算（`overBudget`）取代旧阶梯的「把当前章大纲丢掉」。`buildWritingContext()` 保留为第二套装配，由一条**等价性用例**逐字节对拍「当前章/上章结尾/世界书/账本/伏笔」五个段在两套装配下文字相同——切换因此不是一次静默的内容变更。D2 的「项目摘要不进简报」代价如实记下：注入文本里不再有书名与全书字数，章级身份（标题/卷/序号/状态/大纲）仍由 `outline` 段承担。

预览与真实注入调用**同一个函数、同一份入参**（`{ root, budgetTokens?, tailChars?, chapterSeq? }`），差别只在调用方拿返回值做什么：

1. 生成路径用它拼 `text` 注入系统提示段；
2. 预览路径用它**逐段**展示，并把自己打印/落盘的那份审计记录与生成时落盘的那一份做逐字段比较（用例断言，不靠人眼）。

每段统一返回 `{ id, bytes, tokens, truncated }`：

| 字段 | 含义 | 为什么要有 |
|---|---|---|
| `id` | 段的稳定标识（`outline` / `promise` / `characters` / `voice` / `facts` / `foreshadow` / `world` / `prevTail` / `anchors`） | 裁剪记录与预览行按它对齐；用中文标签在日志里搜不到 |
| `bytes` | 该段渲染后的 UTF-8 字节数 | 「为什么模型没看见伏笔」要能一眼归因到体积 |
| `tokens` | `estimateTokens()` 的估计值（CJK 一字一 token，其余四字符一 token） | 预算判定的唯一口径，与 `budgetTokens` 同源 |
| `truncated` | 这一段被**段上限**或**预算阶梯**动过 | 与 `trimmed` 列表分开：「被剪短」和「被整体丢掉」是两种事实 |

本单（#180）只定死**形状与顺序**（就是下面 D2 这张表）并登记 `brief` 占位页；把字段真正加进 `WritingContextSegment` 的是 #43——加的时候不许改顺序、不许改裁剪阶梯（见 D2），否则 #43 与 #46 会在同一处排队。

> **为什么不在这里就把常量表落进代码**：一张没有被任何调用方使用、只被用例盯住的表，是投机代码（AGENTS.md §10.2）。B0 交付的是「口径已定、门禁可查」，常量表随 #43 与它的第一个消费者一起进 `writing-context.ts`；那时若与本表不一致，`tests/writing-context-segments.test.js` 的扩展用例会红。

### D2 9 段固定顺序与裁剪顺序

段顺序（唯一常量表，写在 `writing-context.ts`，任何调用方不得重排）：

```
outline → promise → characters → voice → facts → foreshadow → world → prevTail → anchors
```

超预算时的裁剪顺序（从先丢到后丢）：

```
world → facts → foreshadow → prevTail
```

`outline` / `promise` / `characters` **永不裁**：这三段是「这一章要写什么」的本身，删掉之后模型写出来的东西与作者的意图无关；宁可超预算让调用方报错，也不要静默地把任务书抽走。

每次裁剪都要**埋点**：`{ segment: id, before, after, ratio }`（段 id + 裁掉的比例），同一章的超预算次数进诊断包（[ADR-0018](0018-settings-backup-diagnostics.md) D5 的白名单字段里加一项，不含正文）。

> 现行实现仍是 X-13 的六段 + `EXTRA_SEGMENTS` 注册表；本 ADR 定的是 #43 落地时必须满足的形状。这是一次**扩容**（六段 → 九段），不是重写：`EXTRA_SEGMENTS` 的「只声明不排序」纪律继续有效。
>
> **修订（2026-10-25，#43）**：九段是**简报**的段集，**不包括 `project`**——既有六段注入里的「项目摘要」不进简报，项目信息仍在系统提示的其他段里。两套装配共用同一份段渲染器（`writing-context-render.ts`），因此同一个段在两处不可能渲染成两种文字；简报的段集与顺序由 `BRIEF_SEGMENT_ORDER` 与 `BRIEF_TRIM_ORDER` 两个常量表定死（`src/host/writing-context.ts`），本表与它们由用例对拍。

### D3 门禁/审稿/校对一律用 `findings.ts` 的既有形状

- 复用 `{ code, group, severity, locator, detail, hint, fixable }` 与 `FindingLocator` 的四个形状（`entity` / `path` / `chapter` / `catalog`）。
- 新 `code` 必须**同一提交**写进 [data-model §5](../specs/data-model.md)，`tests/findings.test.js` 的双向对拍继续兜底（代码里有、表里没有 → 红；反过来也红）。
- `fixable` **只对机械可修项为 true**：校对类（标点、全半角、重复空格）可修；#46 的审美类判读（节奏拖沓、人物动机不足）一律 `false`——一个 `fixable: true` 后面没有动作，会让「一键修复」变成数据丢失按钮（ADR-0015 D2 的同一理由）。

  > **修订（2026-10-25，#44）**：`fixable` 当且仅当 `repair.ts` 里存在对应动作时才为 `true`。`GATE_PROOF_*` 目前一律 `false`；#36 实现机械改写时在同一提交翻 `true` 并补用例。理由：#143 / ADR-0015 D2——报告说可修、按钮却不做事，比不报更糟。「判定层面机械可判」与「可自动改写」是两件事，前者本单交付，后者归修复路径。

- 分组（`FINDING_GROUPS`）暂不扩：门禁的七项先归入既有五组，确实归不进去时**先改本 ADR 再扩枚举**，而不是在 #44 里就地加一个字符串。

### D4 门禁结论落 `.inkflow/audit/gate-<chapterId>.json`，同输入同字节

1. 落点在 `.inkflow/audit/`（[ADR-0012](0012-plugin-private-state-dir.md) 已有的白名单子路径），不是 `index/`。
2. 文件名 `gate-<chapterId>.json`：**不带时间戳**。它回答的是「这一章此刻的门禁结论」，不是「哪一次运行」——带戳的文件每跑一次就多一个，diff 永远是新文件。
3. 内容**不含时间戳、不含随机 id、不含绝对路径**：同一章、同一套文件跑两次，两次的字节必须相同（`git diff --no-index` 为空）。字段顺序由序列化器固定（`JSON.stringify(…, null, 2)` 的键序来自构造顺序，因此构造顺序也是契约）。
4. 「这是最新一次吗」不靠文件名表达，靠内容里的 `chapterDigest`（章节正文 + 相关设定文件的摘要）与当前文件比对得出。
5. 既有 `exportAuditReport()` 仍按 `auditReportName(now)` 带戳导出 Markdown 报告：那是一次**运行**的产物，和门禁结论不是一件事。两者同名同目录，但一个是可 diff 的事实、一个是可归档的报告——区别写在这里，免得下一个人把它们合并。

### 附：本条与 X-28 的分工

历法换算（`calendar.ts`）与「地点不新增 kind」是 X-28 的两半，见 [ADR-0025](0025-calendar-and-place-kind.md)——它们与本条是同一条纪律的两个面：**一个概念只允许一个实现、一个身份**（上下文只有一个装配点，时间只有一个换算函数，地点只有一个 kind）。本条只管上下文的装配与问题的形状，不在此处重复历法口径。

## 备选与取舍

| 方案 | 优点 | 代价 | 为什么没选 |
|---|---|---|---|
| 预览另写一份装配（预览专用拼接） | 预览可以只挑想要的段，输出更"漂亮" | 两份装配必然漂：改了一边忘另一边，用户看到的与模型看到的不是同一份 | 0.4.0 的 `routes.ts` 双份字段集就是这么坏的（#166）；预览的价值全在「它就是生成时用的那份」 |
| 段字段只在预览侧计算（`text` 不动） | 不动既有 `WritingContextSegment` 形状 | 生成时没有 bytes/tokens/truncated，落盘的审计记录只能靠预览时重算 → 又变成两份计算 | X-23 要求落盘记录与预览逐字段相等，只有一次计算能满足 |
| 门禁各造一套问题类型（`GateIssue` / `ReviewNote`） | 字段可以贴合各自领域（门禁要 ruleId、审稿要段落偏移） | 三套词汇、三套排序、三处与 §5 对拍；面板要么认三套要么再写一层适配 | 既有 locator 已经能表达章/段/路径/条目；多出来的字段是同一个概念的不同叫法 |
| 门禁结果落 `index/`（`index/gate/`） | 与索引同处，删了"自动重建" | `index/` 缺失即静默重建（ADR-0006 D2）→ 「上次是否通过」的证据消失；只忽略 `*.db` → 结论会被提交进 git | 与 X-25 同一条理由：可重建的目录不能存不可重建的事实（[ADR-0023](0023-proposal-job-private-placement.md)） |
| 门禁结果不落盘，只从 findings 重算 | 零新文件、零清理 | 「上一次跑是什么结论」无从 diff；门禁可能要跨章扫描，重算不是零成本 | 门禁的用处有一半在「昨天没通过，今天通过了」这个比较上 |
| 简报用模板字符串硬编码段序（一个大 `join`） | 少一层数据结构 | 段序与预算变成隐式知识；超预算时无法逐段报告裁剪（D1 的四个字段就无从得来） | 本单要的正是「段是可寻址的」；硬编码的 join 里没有任何东西能被指出名字 |
| 历法塞进 timeline 域模块（或各面板各算一遍） | 少一个模块 | 索引算一遍、面板再算一遍，差了没人查；域模块从此要做两件事 | 纯函数才能盯住 `A→B→A = 0` 这条性质（`tests/calendar.test.js` 逐日跑） |

## 后果

| 收益 | 代价与对策 |
|---|---|
| 预览 = 生成：一次计算，几乎不可能漂 | 预览要接受「段就是这些、顺序就是这个」，UI 不能自行挑拣——这正是它可信的原因 |
| 一个问题词表贯穿体检/门禁/审稿/提案 | 新 code 必须落 data-model §5；`FINDING_CODES` 会持续变长（可接受：它就是词表） |
| 门禁结论可 `git diff`（虽然它被 git 忽略，但可跨机器/跨时间比） | 需要在内容里放 `chapterDigest` 才能判新旧，而不是靠文件名 |
| 9 段顺序与裁剪顺序一处分定，两个单不再抢同一行 | 顺序常量落地时要求 `writing-context.ts` 的既有六段行为保持不变（用例兜底） |
| 历法只有一个实现，多纪元（#48）接上就行 | 纯函数没有缓存，每次换算都重算；量级是 O(月数 + log 年数)，与一次文件解析相比可忽略 |

## 验证

- `tests/calendar.test.js`（本单已落地，13 个用例）：`A→B→A` 逐日 0 误差（2019–2029 全量 + 锚点两侧 + 双纪元 −3652…1600 全量）、闰日三档（2024 / 1900 / 2000 / 2100）、纪元边界（day −1 属旧纪元、day 0 属新纪元）、非整数 / 非数值 / 未知纪元 / `y = 0` / 越界日 / 非法历法表一律结构化拒绝。运行：`node --test tests/calendar.test.js`。
- `tests/findings.test.js`（既有）：`FINDING_CODES` ⇄ data-model §5 双向对拍，新 code 两侧都写才绿。
- `tests/writing-context-segments.test.js`（既有）：段注册表的顺序与「只声明不排序」纪律；#43 扩到九段时这条用例必须同步扩展而不是被删。
- #43 落地时追加：预览返回的段数组与落盘审计记录**逐字段相等**（同一个函数、同一份入参，两次调用结果相同）。
- #44 落地时追加：同一章跑两次门禁 → `git diff --no-index .inkflow/audit/gate-<chapterId>.json.bak .inkflow/audit/gate-<chapterId>.json` 为空；文件里不含时间戳与绝对路径（字符串搜索断言）。

## 补充（#44 落地，2026-10-25）

D3 留了两个「落地时再定」的口子。按 A7（代码与 ADR 不一致时先改 ADR）在动代码之前把它们定案：

1. **`FINDING_GROUPS` 仍然不扩。** 门禁的七项确实不属于五个不变量族，但扩一枚组名的代价是：`audit.ts` 的 `GROUP_LABELS` 是 `Record<FindingGroup, string>`（不加就 tsc 红）、`tests/audit.test.js` 两条既有断言逐字钉住五组、体检页正文会多出一个**恒为 0** 的小节——那会被读成「门禁通过」，而体检从不跑门禁。所以 #44 走 D3 的默认：七项各成一个 `check`（面板按 `check` 分组），`group` 回答「这条 finding 挂在哪个域」——名字与实体引用 → `structure`、账本取值 → `ledger`、其余（章文本层）→ `catalog`。判定规则写在 `gate-rules.ts` 的文件头。
2. **`GATE_*` 的 `fixable` 全部为 `false`**，机械校对类也一样。D3 的「校对类可修」说的是**判定层面机械可判**；「可修」要求 `repair.ts` 里有对应动作，而它是唯一修复路径、目前没有 `GATE_*` 分支。先标 `true` 会让报告说「N 项可由一键修复处理」而按钮什么也不做（ADR-0015 D2；同类事故见 #143，`tests/repair.test.js` 有回归用例）。翻成 `true` 的那次提交必须同时让 `repair.ts` 学会改写并补用例。

若日后确实需要第六个组（例如 #46 的审美类也要求独立分组），那是**扩枚举 + 同时改上面三处**的一次提交，不在别单里顺手加。
