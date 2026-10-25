# ADR-0028：按书的门禁口径——数值进 `inkflow.json` 的 `gate` 段，字面豁免进 `library/gate-whitelist.txt`

- 状态：已采纳（2026-10-26）
- 日期：2026-10-26

## 背景

质量门禁（[ADR-0022](0022-writing-context-gate-findings.md) D3/D4）现在有两个「同一件事只能由代码说」的缺口：

1. **阈值只能由调用方临时覆盖**。`runGate()` 的 `options.thresholds` 是给测试与面板用的参数，作者没有任何地方可以声明「这本书就用破折号、句长上界 45、一章 6000 字」。`GATE_AI_PUNCT` 判破折号 0.6/千字，作者若本来就用破折号，唯一的出路是把警告当没看见。
2. **具体某一句没有任何豁免路径**。「——」在这本书里是某个人物的口癖、「早该如此」是固定台词、某个词是剧情必需的敏感面——这些都是**作者知道自己在写什么**的句子，门禁却只能照报。

约束（既有事实，不是本 ADR 新定的）：

- `inkflow.json` 是[唯一配置入口](../specs/conventions.md)（§3.1），它随仓库走、可提交、可 diff；加字段要过 `schemaVersion` 与向导的写入路径。
- 内容目录是九个固定英文名（[ADR-0006](0006-workspace-contract-v2.md) D1）；`library/` 里已经有过非卡片文件（旧库迁移写 `library/etl-chapter-summaries.md`），所以「约定文件」在这个目录里不是新形态。
- 门禁结论文件 `.inkflow/audit/gate-<chapterId>.json` 是**可 diff 的事实**：无时间戳、无随机 id、键序固定（ADR-0022 D4）。
- 一个门禁项一旦能被作者关掉，「门禁通过」就不再是同一个意思——所以这个功能必须先写死它**不能**做什么。

## 决策

### D1 数值落点：`inkflow.json` 的 `gate` 段

```json
{ "schemaVersion": 1, "title": "蜀山", "gate": { "aiDashPer1000": 1.5, "wordCountMax": 6000 } }
```

- 键的集合**只有一个来源**：`GateThresholds`（`src/host/gate-vocabulary.ts`）。段里出现未知键 → 拒绝（`GATE_BOOK_CONFIG_INVALID`），不当作没看见：拼错的键会静默失效，而作者以为自己改过了。
- 每个键都可单独省略；省略即取 `GATE_DEFAULTS` 的值。**段整体缺失 = 全部取 `GATE_DEFAULTS`**，`GATE_DEFAULTS` 仍是唯一默认值来源，书不复制一份默认值进来。
- 取值校验：必须是有限正数；`maxFindingsPerRule` 必须是 ≥1 的整数；`wordCountMin < wordCountMax`。任何一条不满足 → 拒绝并指出键名与实值。
- 优先级：`GATE_DEFAULTS` < 书的 `gate` 段 < 调用方 `options.thresholds`。调用方覆盖仍然赢，因为它是测试与面板的**一次性**入参，不是持久口径。
- **不 bump `FILE_SCHEMA_VERSION`**：`gate` 是可选增字段，旧读者忽略它，新读者缺省即老行为；bump 的代价是「新插件建的书旧插件打不开」，而无任何收益。向导新建的书**也不写 `gate` 段**（写默认值等于把默认值复制到每一本书里，第二份默认值就诞生了——这也是 `workspace.ts` 的 `metaBody` 不需要改的原因）。

### D2 字面豁免落点：`library/gate-whitelist.txt`

- 它是**资料**，不是配置：作者写的是「这句话是什么」，不是「把哪个开关关掉」。
- 在内容目录内 → 随书提交、随书 clone、随书 diff；`library/` 已在写白名单里，作者可以用普通文本编辑器改，也可以提交进 git 供他人审阅。
- 文件不存在 = **零豁免**（不是错误）。

### D3 匹配语义：字面片段、按行生效、命中即不报

- 一行一条片段；行内首尾空白去掉；整行以 `#` 开头是注释；空行忽略；读取容忍 BOM 与 CRLF。
- 归一：两侧都做 `NFKC` + 小写折叠（全角/半角、大小写归一）。片段本身**不做**正则、不做通配、不做分词——写什么就匹配什么。
- 生效范围是**行**：一条 finding 的定位行（`path#L<n>` 的那一行正文）里出现该片段，且该 finding 的码在 D4 的可豁免闭集里，才豁免。
- 命中后**不报这一处**（从 `findings` 里移除），**不降级为 info**。理由：降级只是把同一句话换个音量，作者仍然要读它、仍然要在报告里占一行；而「作者已经声明过这句是有意的」这件事本身不需要重复通知。留痕由 D6 的 `waivers.applied` 承担，可见性不靠严重级。

### D4 可豁免码是闭集（7 个），其余一律不可豁免

| 可豁免 | 为什么 |
|---|---|
| `GATE_AI_NARRATION` | 情绪直陈的判定是句级的；「他就这么个人」这句台词旁边的叙述可能确实是作者的选择 |
| `GATE_AI_TEMPLATE` | 段尾套路话是句级的；固定台词、口头禅会命中它 |
| `GATE_SENSITIVE_WORD` | 敏感自查本来就是**自查**：作者声明「这句是剧情必需的」，这是唯一合法的响应方式 |
| `GATE_PROOF_HALF_PUNCT` | 排版口径：有的作者刻意用半角逗号/冒号 |
| `GATE_PROOF_FULLWIDTH_ALNUM` | 同上（全角字母数字出现在书名、招牌里是有意的） |
| `GATE_PROOF_ARABIC_MEASURE` | 数字写法是作者口径（「3 个人」vs「三个人」） |
| `GATE_PROOF_NUMBER_MIXED` | 同上 |

| 不可豁免（举例） | 为什么 |
|---|---|
| `GATE_WORD_COUNT_*`、`GATE_AI_SENTENCE`、`GATE_AI_PUNCT`、`GATE_AI_MODIFIER`、`GATE_AI_STUTTER`、`GATE_AI_LOW_LINK`、`GATE_AI_LONG_PARA` | 章节级统计：一条「片段」说不清「整章的密度口径」。作者的意图由 D1 的数值表达 |
| `GATE_HOOK_*` | 章末收口是整章判断，单句豁免会让「这章就这样收」变成一句话就能关掉的开关 |
| `GATE_AI_PARALLEL`、`GATE_PROOF_APPELLATION_MIXED` | 定位是整章（`chapter:<id>`），没有可以挂片段的「那一行」 |
| `GATE_PROOF_PUNCT_UNPAIRED`、`GATE_PROOF_REPEAT_WORD`、`GATE_PROOF_NEAR_NAME` | 是**错**，不是口径：引号没配对、字打重了、角色名写错，都不是「作者故意的」 |
| `GATE_PLATFORM_RESIDUE`、`GATE_PLATFORM_PROMO` | 平台会直接下架/限流，作者的偏好改不了对面 |
| `GATE_DEGEN_*` | 判的是「模型写坏了」（复读、截断、占位语、工程词泄漏），不是风格 |
| `GATE_CONSISTENCY_*` | 与设定库/账本矛盾是事实问题，豁免它等于让书自相矛盾 |

闭集写在 `src/host/gate-waiver.ts` 的 `WAIVABLE_CODES`，由用例双向钉住（集合里的每个码都必须真的能挂行定位、集合外的一个都不许被豁免）。

### D5 防橡皮：三条可检查的边界

| 边界 | 值 | 越界时 |
|---|---|---|
| 单条片段长度 | ≤ 40 字符（归一见 D3，可见字符计） | 拒绝，指名 `library/gate-whitelist.txt` 的行号与实际长度 |
| 条目数 | ≤ 30 条 | 拒绝，指名实际条数与上限 |
| 生效面 | 只对 D4 的 7 个码、只对被命中行 | 结构上做不到（不是靠值限制） |

- 40×30 同时给文件大小兜了顶（最坏约 1.2 KB），不再单独设字节上限。
- 不做通配符、不做正则、不做「整段/整章」条目：作者**不能**把一章正文贴进白名单来关掉门禁——超长即拒，且即使贴进去也只影响那 7 个码的命中行。
- 上限是**代码里的固定判据**，不进 `GateThresholds`：能被书调高的上限就不是上限。

### D6 可见性：回执、结论文件、面板三处都有

`GateReport` 增一个字段，三处共用同一份：

```json
"waivers": {
  "configured": 2,
  "applied": [ { "code": "GATE_AI_NARRATION", "locator": "chapters/vol-01/0001-入山.md#L7",
                 "fragment": "早该如此", "whitelistLine": 3 } ]
}
```

- `configured`：白名单里的条数（含一条都没命中的那些）——「本作有 N 条豁免」里的 N。
- `applied`：这次判决里真正被豁免掉的每一处，带码、定位、片段与**白名单文件的行号**（作者能直接跳回去改）。
- 结论文件与 `gateWire`（工具回执 + `GET /gate`）都带这一段，面板页头把它作为一行显示。
- 结论文件的 `schemaVersion` 从 1 **bump 到 2**：形状变了（多一个键）。它是私有状态、无迁移问题，下一次运行就地重写。

### D7 不做 `.local` 变体

`library/gate-whitelist.local.txt`（或 `.inkflow/` 下的私有副本）明确**不做**。多一层优先级就是多一处漂移源：同一本书在两台机器上「门禁通过」的含义会不同，而结论文件、批量作业的暂停策略、面板都读同一个数字。要本地试验就改文件、不提交——git 已经是那层开关，不需要插件再发明一层。

### D8 老书行为完全不变

无 `gate` 段 + 无白名单文件时：阈值 = `GATE_DEFAULTS`（同一个对象、同一批值）、零豁免、`findings` 与今天逐条相同、`chapterDigest` 也逐字节相同（白名单不存在就不进摘要输入）。结论文件唯一的差别是多出 `"waivers": { "configured": 0, "applied": [] }`，那是可见性要求（D6）的代价，不是判定变化。

## 备选与取舍

| 方案 | 优点 | 代价 | 为什么没选 |
|---|---|---|---|
| **A（本 ADR）**：数值进 `inkflow.json.gate`，片段进 `library/gate-whitelist.txt` | 配置归配置、资料归资料；两者都随书走、可 diff、可提交 | 两处落点，读侧要各写一个解析器 | — |
| B：两样都塞进 `inkflow.json` | 单一入口，一次解析 | 片段数组会让配置文件变胖，且「原始资料」的语义被配置吃掉；白名单会长到要注释，`inkflow.json` 又不是给人逐行编辑的文本 | 语义错位；`inkflow.json` 只该放「开关与数字」 |
| C：两样都放内容目录的一个约定文件（如 `library/gate-config.md`） | 一处落点 | 数值要走文件格式解析（键值表），而 `inkflow.json` 已经是配置入口；等于给配置另开一个入口 | 与「唯一配置入口」冲突，且要发明第二套语法 |
| D：白名单放 `.inkflow/`（私有、不入 git） | 不污染内容目录 | 不随书走：换机器、clone 给别人、CI 上跑门禁，结论都不同；且 `.inkflow/` 会在首次使用时被写进 `.gitignore` | 与「结论文件可 diff、可复现」直接矛盾 |
| E：豁免降级为 `info` 而不是移除 | 保留「这里命中过」的痕迹 | 作者仍要在报告里读它；「警告数」变成口径噪音，`pauseOn: warning` 的批量作业也不会因此放行（本来就不是 warning） | 留痕用 D6 的结构化字段更省读者的注意力 |
| F：做成可被书调高的软上限（如「最多 200 条」写在 `gate` 段里） | 灵活 | 上限一旦可调，就等于没有上限：把整章贴进去只需把上限调大 | 防橡皮的边界必须由代码持有 |
| G：白名单支持正则/通配 | 表达力强 | 一条 `.*` 就是「关掉全部门禁」；正则引擎的写法差异还会让「同一份白名单在不同插件版本上匹配不同」 | 与 D5 直接冲突 |

## 后果

| 影响 | 内容 | 对策 |
|---|---|---|
| 作者 | 两处新入口（`inkflow.json` 的 `gate` 段、`library/gate-whitelist.txt`），各有硬上限 | 手册 §5.23 教怎么写，回执与面板显示「本作有 N 条豁免」 |
| 门禁判定 | 判定前多两步读：`inkflow.json` 与白名单文件（都不存在时零成本） | 两者都是小文件；门禁仍然零模型调用、单章 < 1 秒 |
| 结论文件 | 形状 +1 键，`schemaVersion` 1→2 | 私有状态，无迁移；`chapterDigest` 在白名单变化时改变，所以「这是最新一次吗」仍然可答 |
| 批量作业 | 判决里多了 `waivers`，`jobs-drafts.ts` 只挑它认识的字段，记录形状不变 | 不改作业格式 |
| 拒绝路径 | 白名单超长/超条数、`gate` 段非法 → **整次门禁拒绝**（`GATE_WHITELIST_INVALID` / `GATE_BOOK_CONFIG_INVALID`） | 拒绝而不是降级：静默忽略一条超长条目 = 作者以为豁免了、实际没有 |
| 老书 | 判定与摘要逐字节不变 | D8，用例 `老书零行为变化` 取证 |

## 验证

- 用例文件 `tests/gate-waivers.test.js`（先 RED）：①无豁免照常报；②有豁免那一处不报；③同行的不可豁免码照报；④越界（超长 41 字 / 超 31 条）被拒并指名；⑤老书零行为变化（阈值 = `GATE_DEFAULTS`、`chapterDigest` 与不带该文件时相同、`waivers.configured === 0`）；⑥白名单带 BOM/CRLF/注释/空行可读；⑦数值生效（`gate.wordCountMax` 把一章判超长）、非法值被拒、未知键被拒、调用方 `options.thresholds` 仍然赢；⑧`renderGateFile` 带 `waivers` 且白名单改动会改变 `chapterDigest`；⑨全半角/大小写归一生效。
- 命令：`pnpm.cmd run check`（typecheck + lint + build + test + 链接 + 文档 + 守卫 + 编号 + 包 + 分支保护）。
- 文档：`.agents/specs/references/gate-waivers-and-thresholds.md` 是这套口径的规范正文，[conventions](../specs/conventions.md) 头部登记；手册 `docs/user-guide.md` §5.23 是作者视角的写法。
