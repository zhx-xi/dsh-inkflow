# dsh-inkflow 数据模型（文件真相 + 派生索引）

> **依据**：[ADR-0005](../adrs/0005-files-first-with-derived-index.md)（文件真相 / 派生索引 / 不写迁移）、[ADR-0006](../adrs/0006-workspace-contract-v2.md)（九目录 / 卷章 catalog）、[ADR-0007](../adrs/0007-plugin-shared-library.md)（共享库 / `origin`）、[ADR-0009](../adrs/0009-ovk-semantic-search.md)（语义检索）。
> **依赖**：[conventions.md](conventions.md)（目录、文件格式、门禁、写入纪律）。
> **相关 ADR**：0005、0006、0007、0009。
> **状态**：活跃（v6）。本文只描述**数据形状**与**不变量**；未实现的表/字段在 §4.2 与 §7 显式标注。

## 1. 一句话

**真相 = 项目 git 仓库里的 Markdown/JSON 文件；索引 = `index/inkflow.db`，随时可删可重建；卷章 catalog 是入库的结构投影。**
因此没有数据库迁移，也没有「插件升级改坏存量项目」：升级只改解析器与索引 schema 版本，索引直接重建。

三层分工：

| 层 | 位置 | 进 git | 承载 |
|---|---|---|---|
| 真相 | 九个内容目录 + `inkflow.json` | ✅ | 正文、设定、关系、账本 |
| 结构投影 | `chapters/index.json`、`chapters/<vol>/index.json` | ✅ | 卷章清单（可 `git diff` 审阅，[ADR-0006](../adrs/0006-workspace-contract-v2.md) D6） |
| 派生缓存 | `index/inkflow.db`、`index/audit/`、`index/extraction/`、`index/proposals/` | ❌ | 检索、校验结果、临时件 |

**唯一双向约束**：投影和缓存都可以由真相重建；反过来用手改投影/缓存来改数据不成立（会被下一次重建覆盖）。

## 2. 实体 → 文件位置（22 个业务实体组）

| # | 实体组 | 位置 | 形态 | 说明 |
|---|---|---|---|---|
| 1 | 项目（book） | `inkflow.json` | JSON | 唯一元信息文件（`schemaVersion` / `title` / `author` / `projectId` / `seriesId`，见 [conventions.md](conventions.md) §3.1） |
| 2 | 卷 volume | `chapters/index.json` 的 `volumes[]` + 卷大纲节点 | JSON + MD | 卷的稳定身份是 `volumeId`（`vol-NN`）；卷标题/顺序的文学内容在大纲 `kind: volume` 节点 |
| 3 | 章 chapter | `chapters/**/<seq>-<slug>.md` | MD + frontmatter | 正文即 body；章归属由 frontmatter `volume`（值=volumeId）决定；`id` 是建档时生成的 uuid |
| 4 | 章版本 | git 提交历史 | git | 不建 `chapter_versions`；版本 = commit |
| 5 | 大纲节点 outline | `outlines/*.md` | MD + frontmatter | `kind: overall\|volume\|chapter`，`parent` 挂接 |
| 6 | 情节点 plot_point | 大纲文件正文的列表项 | MD 列表 | 结构化语法未定；当前自由文本 |
| 7 | 故事线 arc | `outlines/arcs/<slug>.md` | MD + frontmatter | 【未实现】 |
| 8 | 世界观树 world_setting | `world/<category>/<slug>.md` | MD + frontmatter | 目录即分类；`parent` 建树 |
| 9 | 世界书词条 worldbook | `world/**` 的 frontmatter 字段 | 复用 | `keywords` / `always` / `priority` |
| 10 | 角色 character | `characters/<slug>.md` | MD + frontmatter | `name` 项目内唯一（索引校验） |
| 11 | 角色分组 group | 角色 frontmatter `group` | 字段 | 独立分组文件【未实现】 |
| 12 | 角色关系 relation | `relations/<slug>.md` | MD + frontmatter | 一级目录（[ADR-0006](../adrs/0006-workspace-contract-v2.md) D1），见 §3.3 |
| 13 | 角色语言基因 voice | 角色 frontmatter + body 段 | MD | 字段名与结构未定 |
| 14 | 角色状态 state | 角色 frontmatter `states`（按章） | JSON 片段 | 结构未定 |
| 15 | 伏笔 foreshadowing | `foreshadowing/<slug>.md` | MD + frontmatter | 一级目录，见 §3.2 |
| 16 | 时间线事件 timeline_event | `timeline/<slug>.md` | MD + frontmatter | 一级目录，见 §3.4 |
| 17 | 知识关系 knowledge_relation | `relations/<slug>.md` | MD + frontmatter | 与 #12 共用目录，按 `kind` 区分 |
| 18 | 事实账本 facts_ledger | `facts/<subject>.md` | MD + frontmatter | 一级目录，见 §3.5 |
| 19 | 场景契约 scene_contract | `outlines/scenes/<chapter>.md` | MD + frontmatter | 【未实现】 |
| 20 | 提案 / 修订 proposal | `index/proposals/` | JSON | 派生临时件；接受后才写正文并 git commit |
| 21 | 审计运行 audit_run | `index/audit/<timestamp>.json` | JSON | 派生物，可删 |
| 22 | 提取暂存 extraction_staging | `index/extraction/<run>.json` | JSON | 派生物；确认后才生成实体文件 |

系统/检索类（不计入 22 组）：

| 实体 | 位置 | 形态 | 说明 |
|---|---|---|---|
| 资料 library | `library/**` | 任意文件 | 索引只登记路径/大小；卡片见 §3.6 |
| 卷章 catalog | `chapters/index.json`、`chapters/<vol-dir>/index.json` | JSON | 结构投影，入库（§3.1） |
| 插件设置 app_settings | `$DSH_HOME/inkflow/state.json` | JSON | 只存 `lastProjectRoot` 一类机器状态，不存作品数据；**不作项目解析来源** |
| 变更日志 change_log | git 历史 | git | 不自建 outbox：git 就是变更日志 |
| 共享库条目 | `$DSH_HOME/inkflow/shared/{world,library,snippets,series}/` | MD/JSON | 插件级，不属于任何书的仓库（[ADR-0007](../adrs/0007-plugin-shared-library.md) C1） |
| 语义检索块 | OVK 服务端（按 peer 命名空间） | 外部 | 块 `{chapterId, seq, blockIndex, contentHash, deleted}`，见 [ADR-0009](../adrs/0009-ovk-semantic-search.md) P5 |

## 3. 字段字典

### 3.1 通用 frontmatter 字段

| 字段 | 类型 | 适用 | 语义 |
|---|---|---|---|
| `id` | string | 全部 | 稳定标识。章：建章时由插件写入 uuid（`randomUUID()`），**改名与移卷都不变**，引用一律用它；其余实体：缺省用相对路径（改名即换 id，建议显式写） |
| `title` | string | 章/世界观/大纲/伏笔/时间线/关系 | 显示名；章改标题会同时改文件名（`NNNN-<新 slug>.md`） |
| `name` | string | 角色 | 角色名（唯一性按归一化 name 判定） |
| `aliases` | string[] | 角色 | 别名（索引用于提及扫描） |
| `volume` | string | 章 | 卷归属，值就是稳定 `vol-NN`（[conventions.md](conventions.md) §3.2），**不从目录名推导**；移出卷时整行删除 |
| `seq` | int | 章 | 卷内序号；缺省取文件名前导数字。建章缺省 = 同卷（或散章）最大 `seq` + 1；删章不重排 |
| `status` | enum | 章 | `draft` / `revised` / `final`；伏笔/提案另有自己的状态枚举 |
| `kind` | enum | 大纲/关系 | 大纲：`overall` / `volume` / `chapter`；关系：见 §3.3 |
| `parent` | string | 世界观/大纲 | 上级 id（树结构） |
| `category` | string | 世界观 | 分类名，应与所在目录一致（不一致以 `category` 为准并告警） |
| `keywords` / `always` / `priority` | string[] / bool / int | 世界观 | 世界书触发词、常驻注入、优先级 |
| `group` / `role` / `pov` / `firstAppearance` | string/int | 角色/章 | 创作辅助字段 |
| `origin` | object | 共享库副本 | `{projectId, entryId, contentHash}` 来源证据（§3.7） |

未知字段：**保留在文件里，索引忽略**——加字段不需要改插件，也不会因为插件旧而丢用户数据。

### 3.2 伏笔 `foreshadowing/<slug>.md`

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `id` | string | — | 稳定标识；缺省用相对路径。工具写入时显式落 `id`，此后改名不再换 id（I-20） |
| `title` | string | ✅ | 伏笔名；缺省回退为文件名（去掉扩展名），**不报问题**——存量手写文件大量没有 `title` |
| `status` | enum | — | `planted`（已埋）/ `advanced`（已推进）/ `resolved`（已回收）/ `overdue`（超期）。缺省由 `resolved` 推导（见下） |
| `plantedAt` | string | — | 埋设位置：章 id。**不是必填**：没有对应的问题 code，把存量文件全标成问题只会制造噪声；工具建新条目时提示填 |
| `advancedAt` | string[] | — | 推进位置列表，按时间顺序（块列表写入，读 `stringArrayField`） |
| `resolved` | bool | — | **读兼容字段**：老文件/手写文件用它表达「已回收」；`true` 时 `resolvedChapter` 必填（I-09） |
| `resolvedChapter` | string | — | 回收所在章 id；回收状态必填（I-09） |
| `dueBy` | string | — | 期望回收的章 id 或卷 id（`vol-NN`）；**超期判定的唯一输入**（§3.2.2） |
| `linkedEntities` | string[] | — | 相关角色/世界观条目 id；看板「按角色分组」的来源 |
| `notes` | string | — | 自由备注 |

**`status` 与 `resolved` 的关系**（两个字段都表达「是否回收」，不能各自为政）：

- `status` 是状态机的唯一真相字段；`resolved` 只为读兼容保留。
- 文件只写 `resolved`（没有 `status`）：`resolved: true` → 有效状态 `resolved`；其余 → `planted`。
- 两者同时出现且矛盾（`resolved: true` 而 `status` 不是 `resolved`，或反之）→ 报 `FORESHADOW_TRANSITION_INVALID`，**以 `status` 为准**。
- `status` 取值不在枚举内 → 报 `FRONTMATTER_ISSUE`，并按 `resolved` 回退推导。

#### 3.2.1 状态机（I-21）

四个状态：`planted`（已埋）→ `advanced`（已推进）→ `resolved`（已回收）；`overdue`（超期）是可写进文件的**标记态**，不承载进度。

允许的转换（`from → to`；「无变化」是幂等写，不构成流转）：

| from \ to | `planted` | `advanced` | `resolved` | `overdue` |
|---|---|---|---|---|
| `planted` | ✅ 无变化 | ✅ | ✅ | ✅ |
| `advanced` | ❌ | ✅ 无变化 | ✅ | ✅ |
| `resolved` | ❌ | ❌ | ✅ 无变化 | ❌ |
| `overdue` | ❌ | ✅ | ✅ | ✅ 无变化 |

- `resolved` 是**终态**：从它出发的任何改变都拒绝（只允许「仍是 `resolved`」）。
- `overdue` 只表达「该回收了却没收」，因此**回到 `planted` 被拒绝**（那是退步），而「继续推进 / 回收」允许——超期是标记，不是进度。
- 非法流转 → `FORESHADOW_TRANSITION_INVALID`，**写入侧与重建侧各一条网**：
  - **写入侧**：`inkflow_foreshadow_upsert` 用候选状态与已有行的状态比这张表，拒绝且不落盘。
  - **重建侧**：文件自带的历史字段与 `status` 矛盾即报——① `resolved: true` 但 `status` 不是 `resolved`（或反之）；② `status: planted` 却有 `advancedAt`；③ `status: advanced` 却没有 `advancedAt`。重建期只报不阻断，与其它不变量一致。
- 判定只有一处实现（`src/host/domains/foreshadowing-plan.ts` 的 `foreshadowTransitionAllowed()` / `parseForeshadowFile()`），写入侧调同一个函数，不写第二份（X-4）。

#### 3.2.2 超期（`overdue`）的判定

`overdue` 是**算出来的看板状态**，不存进索引表；文件里的 `status: overdue` 只是作者/工具留下的标记。

**判定输入**（三个条件同时成立才算超期）：

1. 有效状态不是 `resolved`（回收了就永不超期）；
2. `dueBy` 非空且**能解析**：命中 catalog 的章 id，或命中 catalog 的卷 id（`vol-NN`，即 `chapters/vol-*` 里存在的卷）；解析不到 → 不算超期（无法判定），payload 用 `dueKind: "unknown"` 说出来。**不存在的卷 id（如 `vol-99`）算解析不到**——否则「书已经越过卷 99」恒真，一个拼错的卷号会让所有条目永远显示超期；
3. **当前位置严格晚于到期位置**：
   - 当前位置 = 当前章的 `(卷序, seq)`。卷序 = `volumeId` 的数值部分（`vol-02` → 2；与 catalog 的 `volumes[].order` 同源）；**散章（无 `volume`）卷序记 0**，即排在所有卷之前。`seq` 是**卷内**序号（建章取同卷最大 `seq` + 1），取 frontmatter，缺省取文件名前导数字，两者都没有记 1。
   - `dueBy` 是**章** → 到期位置 = 该章的 `(卷序, seq)`；到期那章本身是「本期到期」，**不超期**。
   - `dueBy` 是**卷** → 到期位置 = `(卷序, +∞)`：当前章进入**更后的卷**才超期，同卷内不超期（卷内哪一章兑现由作者排）。
   - 比较只用这两个数字，**不用文件名字典序**（字典序里 `10` 排在 `9` 前面），**也不能只用 `seq`**（`seq` 是卷内序号：卷一两章 + 卷二一章时，只看 `seq` 会把卷一的第 3 章当成全书最后一章）。

**优先级**：算出来的结果**优先于**文件里的 `status`。

- 算出来超期、文件写 `planted`/`advanced` → 看板显示 `overdue`；**文件不改**，索引里仍是文件值（索引是缓存，不替作者写回）。
- 文件写 `overdue`、算出来不超期 → 看板回落：`advancedAt` 非空 → `advanced`，否则 `planted`。此时把 `planted` 写回文件仍被状态机拒绝（那是对文件里已声明标记的退步），拒绝的 hint 必须说清「看板显示的是算出来的值，要改就写 `advanced`/`resolved` 或手改文件」。
- 因此工具与面板 payload 同时给两个值：`status`（算出来的看板值）与 `declaredStatus`（文件里的值）。

**当前章**：看板与 `inkflow_foreshadow_list` 默认取**全书位置最靠后的一章**（`(卷序, seq)` 最大者），页脚文案按 `（卷 id 第 N 章）` 标出位置；`inkflow_foreshadow_list` 的 `chapter` 参数可改判「截至某一章」。

**写作上下文段（X-13）的「当前章」** = **正在写的那一章**：同样按 `(卷序, seq)` 取最大者，但**数据来自文件**而不是索引——写入路径在 prompt provider 里，既不能等待异步重建，也不能假设索引是最新的（作者在编辑器里加了一章、切了分支、上一轮工具没重建都会让它过期）。索引过期时若从索引取位置，`dueBy` 指向的新章会解析成 `unknown`，整段提示**静默消失**，作者会从一本有超期伏笔的书里读到「没有该回收的」。因此位置表（`chapterPositionsFromFiles`）与超期判定都用文件，索引路径（`chapterPositions`）只服务看板与工具，两者对同一棵树必须给出同一份位置表。


**列表上限**：`inkflow_foreshadow_list` 与看板一次最多列 `500` 条。`counts` 按**全部**条目统计（不是被截断后的那一截——`total: 500` 会让一本有 527 条伏笔的书看起来"刚好 500"），列表被截断时 payload 带 `truncated: true`。

### 3.3 关系 `relations/<slug>.md`

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `kind` | enum | — | `character`（角色关系，缺省）/ `knowledge`（知识图谱关系）；非法值降级为 `character` 并报 `FRONTMATTER_ISSUE` |
| `source` / `target` | string | ✅ | 两端实体 id（各恰一个，跨 kind 解析；见 I-08 的 `RELATION_ENDPOINT`） |
| `title` | string | — | 可读标签（如「清音 → 白鹤掌门」）；缺省时由两端推导，仅用于展示与 `entities.title` |
| `dir` | enum | — | `directed`（缺省）/ `undirected`；读写统一用 `dir`，读时兼容旧字段 `direction` |
| `since` / `until` | string | — | 关系成立 / 失效的叙事位置（章节 id 或世界内时间） |
| `chapter` | string | — | 该关系首次成立的章（用于按章回看） |

**字段口径的三处变更是 #27 定的**（改 spec 后再改代码，S1）：
- `relation`（关系类型，如 `师徒`）、`weight`、`evidence` **未实现**：关系类型集合在 [open-questions.md](open-questions.md) Q8 未裁决，先把未定项写进文件会制造第二套真相。在裁决之前用自由文本 `title` 承载「这层关系叫什么」。
- `direction` → `dir`：两个字段读时都接受，写时只写 `dir`。
- 新增 `chapter`：与 [conventions.md](conventions.md) 的 `relations/` 契约一致，`since`/`until` 只表达抽象位置。

孤立 / 冲突的**校验强度**仍待定（Q8 的另一半），当前只做三件事：端点必须存在、禁止自环、同 `(source, target, kind)` 不许重复。

### 3.4 时间线事件 `timeline/<slug>.md`

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `title` | string | ✅ | 事件名 |
| `worldTime` | string | ✅（`confirmed` 时） | 世界内时间，**扁平标量** `YYYY` / `YYYY-MM` / `YYYY-MM-DD`；`precision` 由段数推导（1 段=年、2 段=月、3 段=日），不写字段 |
| `narrativeOrder` | number | — | 叙事顺序：**书内出现次序（book-wide），不是章内索引**；可与 `worldTime` 不一致（倒叙/回忆是正常写法） |
| `chapterId` | string | — | 关联章 id。frontmatter 键名 `chapterId`；读兼容旧文件里的 `chapter`；派生索引表 `timeline_events` 的列名是 `chapter`（§4.1） |
| `participants` | string[] | — | 参与角色 id；空格连接存储、读回成列表（id 内不得含空白 `,` `[` `]`，否则读回成两个 id） |
| `place` | string | — | 地点（世界观条目 id） |
| `status` | enum | — | `confirmed`（缺省）/ `unconfirmed`（时间未定，进待确认区）；`pending` 只作**读兼容**，等同 `unconfirmed` |
| `calendar` | string | — | 历法 id（多纪元历法落地后使用，见 [open-questions](open-questions.md) Q7） |

`worldTime` 与 `narrativeOrder` 是两条独立排序轴（双时间轴）；`status: unconfirmed` 的事件不参与时间轴排序，只出现在待确认区。

两条轴各有一套判定口径（详见 §5 的 I-16–I-19）：

- **`worldTime` 用扁平标量而不是 `{era, year, month, day, precision}` 对象**：项目读取器只支持标量、行内数组与块数组，嵌套映射会被读回成一整个字符串；而对象里 `precision` 要表达的信息恰好是「作者写了几段日期」，因此由段数推导。纪元（`era`）留给多纪元历法（Q7）。
- **`narrativeOrder` 是书内出现次序**：叙事轴按它全局排序，槽位冲突也在全书一个桶里判（跨章同槽即矛盾）。
- **叙事顺序与世界顺序不一致本身不是错误**：倒叙/回忆正是双时间轴要表达的东西，重建期报 `TIMELINE_WORLD_TIME_REVERSED` 作为提示，写入侧放行。

### 3.5 事实账本 `facts/<subject>.md`

**frontmatter**（只放身份）：

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `subject` | string | ✅ | 事实主体（角色/物品/地点 id） |
| `title` / `aliases` | string / string[] | — | 展示名与别名（可选） |

**正文**：一条事实一个列表项，字段用竖线分隔（[ADR-0013](../adrs/0013-facts-ledger-line-format.md)）：

```markdown
- attribute: 境界 | value: 筑基后期 | since: ch-0007 | chapterId: ch-0009 | source: text
- attribute: 持有物 | value: 青锋剑 | since: ch-0012 | until: ch-0061 | source: manual
```

| 键 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `attribute` | string | ✅ | 事实维度（年龄/境界/持有物/生死…） |
| `value` | string | ✅ | 该区段内的取值 |
| `since` / `until` | string | — | 生效 / 失效位置（章 id）；缺省 `until` 表示至今成立 |
| `chapterId` | string | — | 登记该事实的章 |
| `source` | enum | — | `text`（正文推导）/ `manual`（人工登记，缺省）/ `extract`（提取采纳） |
| `conflictsWith` | string[] | — | **仅索引列**，不写文件：由校验算出的冲突事实行锚 |

- 一主体一文件、一文件多事实；跨章校验的输入是同一 `subject + attribute` 的多个 `since` 区段。
- `subject` 是**引用字段**（指向被描述的主体 id），不是本文件的实体 id：本文件的实体 id 是路径（§4.1）。缺 `subject` 时按文件名回退，并在重建时以 `FRONTMATTER_ISSUE`（warning，不阻断）提示——否则这些事实会登记到一个没人选的 subject 名下。
- 值里要含字面 `|` 时写 `\|`；未知键**保留不报错**（与 frontmatter 未知字段同策略），包括**空值**未知键（`备注:`）——它必须能被原样渲染回去，否则「解析→渲染→再解析」会丢掉作者写的字段。
- **哪些 `- ` 列表项算事实行**：看第一个分段的键——是上面六个已知键之一就是事实行（解析失败则报 `FACT_LINE_MALFORMED`）；否则若任意分段含已知键，判「想写事实但写坏了」并报同一条 code；两者都不满足就是**散文，静默忽略**（零 issue）。账本同时是作者的笔记，把散文报成坏行会让体检报告淹没真正写坏的那一行（[ADR-0013](../adrs/0013-facts-ledger-line-format.md) 修订一节）。
- 不可解析的**事实行**报 `FACT_LINE_MALFORMED` 并带行锚 `path#L<n>`，不阻断整文件。
- **旧式单事实 frontmatter（只读兼容）**：ADR-0013 之前的字段表把一条事实放在 frontmatter（`subject` / `attribute` / `value` / `since` / `until` / `chapterId` / `source`）。这种文件按**一条**事实读入：`attribute` 与 `value` **同时存在**才产生事实；`subject` 缺省回退文件名；缺 `since` = 书首、缺 `source` = `manual`；行锚取 `attribute:` 所在行；`conflictsWith` 不读。**只读**——没有写入路径产出这种形状，`inkflow_facts_append` 仍只写正文行，老格式的事实不被搬运或改写；同一文件里两种形状并存时两条都进索引，并按同一 `attribute` 正常参与 I-23。**不再新增这种写法**（新建账本只写 `subject`）。
- 为什么不用 frontmatter 块数组或 Markdown 表格：见 ADR-0013 的备选表（嵌套映射读回成一个字符串；表格与中文竖线冲突且 diff 不可读）。

### 3.6 资料卡片 `library/<slug>.md`

`library/` 里可放任意文件；对需要被检索/引用的资料，另写一张卡片：

| 字段 | 类型 | 必填 | 语义 |
|---|---|---|---|
| `title` | string | ✅ | 资料名 |
| `source` | string | — | 来源（URL / 书名 / 口述） |
| `license` | string | — | 许可；缺省 `unknown`（[ADR-0007](../adrs/0007-plugin-shared-library.md) 风险表） |
| `sha256` | string | — | 原文副本的哈希（有副本时） |
| `mode` | enum | — | `copy`（缺省）/ `reference`（引用共享库原文，只读，[ADR-0007](../adrs/0007-plugin-shared-library.md) C4） |
| `origin` | object | — | 来自共享库时的溯源（§3.7） |

### 3.7 共享库副本的 `origin`

| 字段 | 类型 | 语义 |
|---|---|---|
| `projectId` | string \| null | 复制发生时项目的 `inkflow.json.projectId`；老项目缺失时为 `null` |
| `entryId` | string | 共享库条目 id（`sh-<8 位十六进制>`） |
| `contentHash` | string | **复制那一刻**共享条目的 `sha256` |

`origin` 是来源证据，不是同步指针；`contentHash` 与共享库当前内容不一致 → 副本标 stale，但**不自动改**。

## 4. 派生索引（`index/inkflow.db`）

### 4.1 v7（现行，`PRAGMA user_version = 7`）

| 表 | 主键 | 主要内容 | 用途 |
|---|---|---|---|
| `meta` | key | builtAt / root / indexSchemaVersion / fileCount / entityCount | 索引元信息（`builtAt` 只作诊断，**不作新鲜度判据**，见下） |
| `files` | path | dir / kind / size / mtime | 全量文件清单，**同时是新鲜度对拍基线** |
| `entities` | (kind, id) | path / title / name_key / category / parent / order_index / status / keywords / aliases | 跨类统一投影：九分类树、跨类 id 冲突、提及定位（X-1） |
| `entities_fts` | (virtual) | entity_key / title / aliases / keywords，`tokenize='trigram'` | 全实体检索（X-3）；1–2 字走 `LIKE` 兜底 |
| `chapters` | id | path / seq / title / volume / status / word_count | 章列表、字数统计 |
| `characters` | id | path / name / name_key / group_name / role / pov / first_appearance / aliases / voice | 角色查询、重名校验、角色卡（#25） |
| `character_states` | `<cardId>#<chapter>` | path / character_id / chapter / status | 「第 N 章时他在什么状态」（#25） |
| `world_entries` | id | path / title / category / parent / keywords / always / priority | 世界观树、世界书关键词（#26） |
| `outline_nodes` | id | path / kind / title / parent / order_index / plot_point_count / plot_points | 大纲树与不变量校验；`plot_points` 是解析后的正文列表项（JSON `[{text, arc?}]`） |
| `relations` | id | path / title / relation_kind / source / target / direction / since / until / chapter | 关系图谱查询与校验（#27） |
| `timeline_events` | id | path / title / world_time / narrative_order / chapter / participants / status | 双轴排序、待确认区、冲突检测（#28） |
| `facts` | id（`= path#L<line>`） | path / line / subject / attribute / value / since / until / chapter / source | 账本「截至第 N 章生效中」快照与区间冲突校验（#32）；一条事实一行，`line` 是 1-based 行锚 |
| `foreshadowings` | id | path / title / status / planted_at / advanced_at / due_by / resolved_chapter / linked_entities | 状态机查询、超期列表与看板（#31）。`status` 存**文件里的值**；`overdue` 是算出来的看板状态，**不进表**（§3.2.2）；`advanced_at` / `linked_entities` 空格连接（与 `participants` 同策略） |
| `entity_mentions` | (entity_key, chapter_id, offset, source) | entity_key / chapter_id / offset / source | 正文与 frontmatter 的提及定位（#29）；`entity_key` = `kind:id`，`explicit` 行的 offset 为 -1 |
| `library_files` | path | size / mtime | 资料登记 |
| `validation_issues` | seq | code / path / detail | 重建时发现的不变量问题 |
| `chapters_fts` | (virtual) | chapter_id / title / body，`tokenize='trigram'` | 章正文全文检索（≥3 字命中；1–2 字走 `LIKE` 兜底） |

**`entity_mentions` 由接缝建**（`indexer.ts` 的 `writeIndexDatabase`），不属任何域模块：`mentions` 不在 `CONTENT_DIRS` 里，且它是一次全书扫描的结果（自动机由全部实体建、走全部章节），不是某个目录的行集。

**表归谁建（X-2）**：`chapters`/`chapters_fts`、`characters`、`world_entries`、`outline_nodes` 由各自的域模块提供 DDL 与写入（[`src/host/domains/`](../../src/host/domains/)）；`meta`、`files`、`library_files`、`validation_issues`、`entities`、`entities_fts` 由索引构建与接缝层提供。没有一张表在两处创建。

**`entities` 主键是复合的 `(kind, id)`，不是单列 `id`**：不同内容目录是不同表、各有自己的主键，所以两个 kind 可以合法地共用一个 id —— 这种冲突由 I-04 报 `DUPLICATE_ID`，**两行都保留**（`(kind, id)` 足以表示）。单列主键会把这种既有合法状态判成不可表示。

**`entities` 的 `id` 取自何处**（按 kind）：章/角色/世界观/大纲/关系/时间线取文件 frontmatter 的 `id`（未写时按各域约定从文件名派生）；**`facts` 取文件路径** `facts/<subject>.md`。理由见 §5 I-04：账本条目没有自己的名字，`title` 就是主体的显示名，把 `subject` 当 `id` 会与主体实体撞号并让同一处正文进两条 `entity_mentions`。`subject` 因此是 §3.5 的**引用字段**，不参与 `entities` 主键。

**`files` 是新鲜度的对拍基线**（`checkIndexFreshness`，契约见 [conventions.md §4.0](conventions.md)）：

- 每行 `(path, size, mtime)` 描述建库那一刻该文件的字节数与 mtime；`mtime` 与磁盘 `stat.mtime.toISOString()` **同源同精度**（毫秒），因此比较是字符串相等，不需要额外列，也不需要改 schema。
- 对拍方式：一次 `readdir`+`stat`（与建索引同一个 `walkProjectFiles`）得到磁盘视图，与 `files` 全表比对 → 新增 / 删除 / `size` 变 / `mtime` 变 都算 `stale`。**不读文件内容、不算 hash**，所以 3000 文件量级仍是几十毫秒。
- 为什么 `meta.builtAt` 不够：删文件不会抬高任何 mtime，一删一增的「等量替换」也骗得过时间戳。`builtAt` 仅用于诊断输出。
- 索引 schema 不变（仍是 `user_version = 1`）：加入新鲜度不需要新列。若将来把内容 hash 也存进 `files`（用于「同 size 同 mtime 但内容被替换」这种极端情形），那是一次 `INDEX_SCHEMA_VERSION` 递增 + 删库重建，不写 ALTER。

- 版本不符 → **删库重建**，不做 `ALTER`。
- 重建：清空 → 全量扫描 → 事务写入 → 校验；`index/` 里除 `.gitkeep` 外全部是派生物。
- 中文检索实测：SQLite 3.53.4 + FTS5 `trigram`，3 字命中、2 字不命中（证据在对应 PR 评论，不入库）。
- `chapters_fts.body` 存的是 `parseMarkdown` 的 `body`，**frontmatter 已剥离**：检索片段因此不可能带出 `id` / `status` / 备注等元数据。
- 检索契约（`searchChapters` / `inkflow_chapter_search`，边界与错误码见 [conventions.md §4.1](conventions.md)）：
  - **2 字边界**：trigram 以 3 字为一个 token，1–2 字查询 `MATCH` 返回 0 行且不报错，因此 1–2 字（或含短词的组合查询）走 `body LIKE '%q%'`，按 `seq` / 文件排序；≥3 字走 `MATCH`，按 `rank`（bm25）排序。
  - 查询按 FTS5 短语转义（内部 `"` → `""`），`-` `*` `OR` `NEAR(` 都当字面文本；LIKE 分支转义 `%` `_` `\`。
  - 短片段取命中词前后各 40 字（连续空白折叠），**不返回命中偏移的字符位置**；`chapterId` 是 `chapters.id`，`file` 是项目内相对路径。
  - 索引缺失 / `user_version` 不符 → `INDEX_UNAVAILABLE`（读路径零写盘）；重建只由 `ensureIndex` 决定并执行一次（[conventions.md §4.0](conventions.md)）。

### 4.2 v2 里尚未落地的表

`entities`、`entities_fts` 与四个既有域表已在 §4.1 落地；下表是 v2 剩余部分，尚未实现。

| 表 | 用途 | 状态 |
|---|---|---|
| `chapters_catalog` | catalog 与 `.md` 一致性快照 | 未实现（#15 已交付 catalog 的读写与校验，未建快照表） |
| `semantic_blocks` | OVK 块的本地定位副本（uri → 章/字符区间） | 未实现（#41） |

**v3 = v2 + `outline_nodes` 两列**（`plot_point_count` / `plot_points`）**+ `world_entries` 三列**（`keywords` / `always` / `priority`）；**v4 = v3 + `characters` 四列**（`pov` / `first_appearance` / `aliases` / `voice`）**+ `character_states` 表**；**v5 = v4 + `timeline_events` 表**（双时间轴）；**v6 = v5 + `entity_mentions` 表**（提及定位）；**v7 = v6 + `facts` 表**（账本一行一事实，行号即锚）；**v8 = v7 + `foreshadowings` 表**（伏笔状态机与到期输入）。**新增表或列都不写 `ALTER`**：`INDEX_SCHEMA_VERSION` 递增即删库重建（ADR-0005）。每个域单在自己的 `schema()` 里声明表，索引只执行注册表（roadmap §2.1 X-2）。

## 5. 不变量与强制手段

不变量靠「写入校验（工具侧）+ 重建校验（索引侧）」双重保障；每条都必须在重建校验里有对应 code，作为「代码没兜住」的第二道网。

| # | 不变量 | 写入时 | 重建时 code |
|---|---|---|---|
| I-01 | 每项目恰 1 条 `overall` 大纲 | 拒绝第二份 | `OUTLINE_NO_OVERALL` / `OUTLINE_MULTIPLE_OVERALL` |
| I-02 | 卷大纲必须挂 overall；禁止卷中卷；**三层为上限**（`chapter` 可挂 overall 或 volume，不可挂 chapter） | 拒绝 | `OUTLINE_VOLUME_PARENT` / `OUTLINE_VOLUME_IN_VOLUME` / `OUTLINE_CHAPTER_IN_CHAPTER` |
| I-03 | 角色名项目内唯一（归一化） | 拒绝 | `CHARACTER_NAME_DUPLICATE` |
| I-04 | 同一 kind 内 id 唯一（域表主键）；**跨 kind 同 id 只报不丢**（不同表各有主键，投影的 `(kind, id)` 可表示） | 重建时保留首个并报 issue；写入时同 kind 拒绝（#24 接上写入侧后生效） | `DUPLICATE_ID` |
| I-05 | `parent` 必须指向存在条目 | 拒绝 | `DANGLING_PARENT` |
| I-06 | 章状态取值合法 | 拒绝 | 非法值降级为 `draft`（不阻断） |
| I-07 | 正文文件必须是 `.md`。**例外**：`chapters/index.json` 与 `chapters/<vol>/index.json` 是本插件写的 catalog（结构投影，见 I-11），索引重建时不参与章节扫描，因此不报这一条 | 拒绝 | `CHAPTER_NOT_MARKDOWN` |
| I-08 | 树/图引用完整：世界观根唯一、非根必须有 `parent` + `category`；**扁平分类书**（全部条目在 `world/<category>/` 且都不写 `parent`）允许无根；关系两端各恰一个实体且都存在 | 拒绝 | `WORLD_ROOT_MISSING` / `WORLD_ROOT_MULTIPLE` / `WORLD_CATEGORY_REQUIRED`；`RELATION_ENDPOINT` / `RELATION_SELF_LOOP` / `RELATION_DUPLICATE`（#27 落地） |
| I-09 | 伏笔 `resolved: true` 必须带 `resolvedChapter` | 拒绝 | `FORESHADOW_RESOLVED_WITHOUT_CHAPTER` |
| I-10 | frontmatter / JSON 可解析 | 写入前序列化 | `FRONTMATTER_ISSUE` |
| I-11 | catalog 与 `.md` 一致（结构投影不漂移） | 写入时重建受影响的 catalog | `CATALOG_STALE` |
| I-12 | 同一章不得同时出现在两个卷或两条 catalog 项 | 拒绝 | `CATALOG_DUPLICATE` |
| I-13 | 卷目录名与 `volumeId` / 卷大纲一致 | 拒绝 | `VOLUME_DIR_MISMATCH` |
| I-14 | catalog 引用的章文件必须存在 | 拒绝 | `CHAPTER_FILE_MISSING` |
| I-15 | `entities` 投影与各域表同源：同一行事实在两张表里的 `id` / `path` / `title` / `name_key` 必须一致（由同一次 scan、同一事务产出；投影主键为 `(kind, id)`） | 同一 scan 产出，无独立写入 | `ENTITIES_DRIFT` |
| I-16 | 时间线 `confirmed` 事件必须带 `worldTime`（时间未定就该标 `unconfirmed`，进待确认区） | 拒 | `TIMELINE_TIME_MISSING` |
| I-17 | 时间线 `worldTime` 必须是真实日期 `YYYY[-MM[-DD]]`（月 13、2 月 30 日都不合法） | 拒 | `TIMELINE_TIME_INVALID` |
| I-18 | 同一叙事槽位（book-wide `narrativeOrder`，跨章也同槽）不得声明两个不同世界时间 | 拒 | `TIMELINE_ORDER_CONFLICT` |
| I-19 | 叙事槽位递增时世界时间不得倒退（＝倒叙/回忆，正常写法） | 报（不拒） | `TIMELINE_WORLD_TIME_REVERSED` |
| I-20 | 实体 `id` 与文件路径可以不一致（改名时旧 id 被钉住，[ADR-0014](../adrs/0014-entity-id-pinning.md)）；唯一性仍按 `(kind, id)` 判。**报出条件**：`id ≠ path` **且** id 形如旧路径（含 `/` 且以 `.md` 结尾）；**章除外**（id 是 catalog 给的 uuid，永远不等于路径）；**手写短 id 不报**（`id: char-1` 是身份，不是改名留下的痕迹） | 放行；体检列为提示（判据＝上行「报出条件」，提示的呈现归 #33） | `ID_PATH_DIVERGED`（info，不阻断） |
| I-21 | 伏笔状态机按 §3.2.1 的 4×4 矩阵：`planted → advanced → resolved`，任一未终态 → `overdue`；`overdue` 只可继续推进或回收（回退到 `planted` 拒）；`resolved` 是终态。文件的历史字段（`resolved` / `advancedAt`）与 `status` 矛盾同样算非法流转（§3.2.1 的两条网）。**碰撞时答案唯一**：修复器按「`resolved: true` 或 `resolvedChapter` 非空 → `resolved`；否则 `advancedAt` 非空 → `advanced`；否则 → `planted`」改写 `status` **一行**（[ADR-0015](../adrs/0015-repair-and-migration.md) D2），于是本条对这类文件是**可自动修**的；证据自相矛盾（`resolved: false` 却有 `resolvedChapter`，或 `resolved: true` 缺 `resolvedChapter`）时**不推导**，仍留给作者 | 拒 | `FORESHADOW_TRANSITION_INVALID` |
| I-22 | 账本每行必须可解析为一条事实：`attribute` + `value` 必填，段形如 `键: 值` 且以 `\|` 分隔，值内含字面 `\|` 时写 `\|`；未知键保留不报错 | 不阻断，报行锚 `path#L<n>`（1-based） | `FACT_LINE_MALFORMED` |
| I-23 | 同一 `subject + attribute` 的生效区间不得重叠且取值不同（`since` 含、`until` 不含；缺省 `until` = 至今成立）。区间按**章序**（`chapters.seq`）比较，不按 id 字典序；章序解析不出的边界不参与判定。**空区间不算区间**：`until <= since`（含 `until == since` 的 `[c,c)` 与写反的 `until < since`）永不成立，既不进快照也不参与冲突配对——把它当跨段比对会诬告一条永不在生效的事实 | 拒 | `FACT_CONFLICT` |

> I-21 由伏笔域 [`domains/foreshadowing-plan.ts`](../../src/host/domains/foreshadowing-plan.ts) 产出（写入侧与重建侧各一条网）；I-22 / I-23 由账本域 [`domains/facts.ts`](../../src/host/domains/facts.ts) 产出；`src/host/findings.ts` 的 `FINDING_CODES` 与本表由 `tests/findings.test.js` 双向对拍。

> **I-04 与账本主体**：`facts/<subject>.md` 的 `subject` **有意复用**所描述主体的 id（`characters/qingyin.md` 的 `id: char-qingyin` + `facts/char-qingyin.md` 的 `subject: char-qingyin` 是标准写法），**不算违规**：账本实体不作为 id 发布——它在 `entities` 里的 id 是**文件路径**（§4.1），`subject` 只是引用字段；`entity_mentions` 也**不扫 `facts`**（账本条目没有自己的名字，`title` 就是主体名，扫了会在同一处正文双计）。

**仅重建期诊断**（不是不变量，写入侧放行）：`RELATION_FIELD_DEPRECATED`——关系文件里出现已废弃字段（如 `direction`），重建时提示、写入时按新字段名归一，不阻断。

**既是校验码、又是写侧拒绝码**（手写文件能触发，所以进 `FINDING_CODES` 与体检报告；工具参数不合法时也复用同一个码）：`CHARACTER_NAME_REQUIRED`、`CHARACTER_FIRST_APPEARANCE_INVALID`、`OUTLINE_KIND_UNKNOWN`、`KEYWORD_INVALID`、`PARTICIPANT_INVALID`。它们都 `fixable: false`——修法要作者判断（补什么名字、写哪个章号），不该由一键修复猜。

**仅体检期诊断**（不是不变量，写入侧与重建侧都不报，只出现在一致性体检报告里）：

| code | 含义 | 判据与产出 |
|---|---|---|
| `FORESHADOW_OVERDUE` | 伏笔已过 `dueBy` 仍未回收 | §3.2.2 的三条件同时成立（有效状态不是 `resolved` + `dueBy` 可解析 + 当前位置严格晚于到期位置），由 `foreshadowing-plan.ts` 的 `foreshadowUrgency()` 判定 |
| `FORESHADOW_DUE_NOW` | 伏笔正好本期到期（当前位置 = 到期位置） | 同上的第 1、2 条件成立且位置相等；是「该回收了」的提示，不是缺陷（严重级 info） |

两者都是「书走到哪儿」的函数而不是文件属性，所以不写进 `validation_issues`（每天的答案都不同，存进索引就会过期）；它们进 `FINDING_CODES` 是为了让报告与修复共用一套词（X-14）。

**与旧设计的差异**：不再有 FK / CHECK / 触发器；UNIQUE 只对「索引内可判定的键」有效。I-11–I-14 由 `src/host/catalog.ts` 的 `validateCatalog` 在 catalog 层与非阻塞方式报告（写入侧工具在级联时重建、把 `SEQ_CONFLICT` / `VOLUME_EXISTS` 前移到拒绝）。

## 6. 2.0 同步为什么更容易了

旧设计需要 outbox / 版本向量 / tombstone 才能同步（SQLite 变更不可读）。文件真相下：

| 旧需求 | 文件方案 |
|---|---|
| change_log 表 | `git log`（自带 author/time/diff） |
| tombstone 防复活 | git 删除提交（可 revert） |
| 冲突检测 | git merge 冲突（同一文件） |
| 增量传输 | 传输 commit 范围 / 文件 diff |
| 备份 | 每书一个 git remote |

因此 2.0 服务端只需「git 远端 / 对象存储 + 认证」，不需要自定义变更日志协议。

## 7. 未实现清单（数据层）

| 契约 | 现状 | 归属 |
|---|---|---|
| 索引 v2 剩余部分（`foreshadowings` 表 + 伏笔解析器与状态机校验） | 未落地 | #31 |
| 故事线 / 场景契约 / 角色分组独立文件 | 未落地 | 对应功能 issue |
| 共享库与 `origin` 溯源 | 未落地 | #40 |
| OVK 语义块与 `semantic_blocks` | 未落地 | #41 |
