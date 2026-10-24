# ADR-0019：frontmatter 支持**一层**嵌套映射（只为 `origin` 这类对象字段）

- 状态：已采纳（2026-10-24）
- 日期：2026-10-24

## 背景

[ADR-0007](0007-plugin-shared-library.md) C3 要求共享库副本在 frontmatter 里写来源证据 `origin: { projectId, entryId, contentHash }`；[data-model](../specs/data-model.md) §3.7 因此把它定成**嵌套映射**（`origin:` 下三行缩进字段），而不是 `origin.projectId: …` 这种扁平键——扁平键里的点号不在 frontmatter 键的字符集内，读侧会当成 unparsed line。

但项目读取器（`frontmatter.ts`）一直只支持标量、行内数组与块列表，**嵌套映射会被读回成一整个字符串**。这条限制被当作「事实」写进过三处规范（`data-model` §3.4 与 §3.5、[ADR-0013](0013-facts-ledger-line-format.md) 的两处理由），并且 #40 的实现一落地就会撞上：每张副本都会被报 `unparsed frontmatter line`，进而进 `validation_issues` 与体检报告。

## 决策

**读取器支持一层嵌套映射，边界写死如下：**

| 规则 | 说明 |
|---|---|
| 只有**缩进的** `key: value` 会挂到待决键下 | 未缩进的键永远是顶层；顶层标量后跟缩进行**仍是**非法 YAML（继续报 issue），不会因为「看起来像 map」就被接受 |
| 值仍只到标量 / 内联数组 / 块列表 | 两层以上嵌套不支持；`origin` 是唯一使用方，没有别的字段需要 |
| 一个键不能既是列表又是映射 | 已有块列表项时再出现缩进 `key: value` → issue（`mixed list and mapping under "<key>"`），不静默二选一 |
| 写侧不因此变得随意 | `origin` 的写入由 `applyOriginBlock` **只插入或整体替换这一块**，其余字节（键序、注释、行尾）不动；不是通用 YAML 序列化器 |

## 备选与取舍

| 方案 | 优点 | 代价 | 为什么没选 |
|---|---|---|---|
| 保持现状：`origin` 用扁平键 `origin.projectId` | 零解析器改动 | 点号不在键字符集 → 每张副本一条 `FRONTMATTER_ISSUE`；要么放宽键字符集（每个域都受影响），要么写成一串标量再拼 | 把一条已知不合法的写法扶正，代价扩散到所有域 |
| 把 `origin` 写成内联 JSON 标量 `origin: '{"projectId":…}'` | 零解析器改动 | 文件里「字段存在」变得不可读，手改容易写坏；审阅时看不出这是三个字段 | 与「文件是真相，人可以读」直接冲突 |
| 引入完整 YAML 解析器 | 一次解决所有形状 | 违反零依赖；且会把「未知形状」的边界从「不支持」变成「支持但语义不明」 | 零依赖是硬约束，且本项目只需要一个字段 |
| **一层嵌套映射，边界写死**（选中） | `origin` 自然可读、可手改；不扩散到两层；写侧仍是块替换 | 解析器多约 30 行；规范里原先「嵌套映射读回成一个字符串」的三处说法要改 | — |

## 后果

| 收益 | 代价与对策 |
|---|---|
| `origin` 三字段在文件里可见、可手改、可 diff | 规范三处旧说法必须同批改掉，否则「文档说不行、代码说行」（本 ADR 就是来钉这一条的） |
| `validation_issues` 不再为每张副本产噪声 | 读取器多一种形状，`parseMarkdown` 的边界用例要补（缩进、混合、两层） |
| 「未知字段保留」策略不变 | 嵌套映射只在**已知键**下有消费者（`origin`）；其它键的映射被读出来也只会原样保留，不会有行为 |

## 验证

- `tests/frontmatter.test.js`：一层嵌套读取；顶层标量 + 缩进行仍报 issue；列表与映射混用报 issue；两层嵌套不会被误读成一层。
- `tests/shared*.test.js`：副本写 `origin` 后 `validation_issues` 不含 `FRONTMATTER_ISSUE`；`applyOriginBlock` 只动该块（其余字节不变）。
- 回归：`data-model` §3.4 的「时间线 `worldTime` 用扁平标量」结论**不变**——那是由「一个值能由段数推导」决定的，不是因为解析器做不到；本 ADR 只改「能不能读」这件事。
