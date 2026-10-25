# 门禁口径细则：`inkflow.json` 的 `gate` 段与 `library/gate-whitelist.txt`

> **依据**：[ADR-0028](../../adrs/0028-gate-calibration-per-book.md)（本细则的决策来源）、[ADR-0022](../../adrs/0022-writing-context-gate-findings.md) D3/D4（问题形状与结论文件的确定性）。
> **依赖**：[conventions.md](../conventions.md) §3.1（`inkflow.json` 字段表）、[data-model.md](../data-model.md) §5（`GATE_*` 码表）。
> **状态**：活跃。本文件是 [conventions.md](../conventions.md) §3.1 与 §3.6 的细则，按 S6 下沉（主文件已到 800 行上限）。

## 1. 概述

门禁默认是全书一套口径（`GATE_DEFAULTS`）。作者可以按书声明两件不同性质的事：

| 想说的 | 说在哪 | 为什么是那里 |
|---|---|---|
| 「这本书的破折号密度上限是 1.5/千字」「一章 6000 字」 | `inkflow.json` 的 `gate` 段 | 它是**配置**：数字、开关，随仓库走 |
| 「『早该如此』是固定台词，这句别报」 | `library/gate-whitelist.txt` | 它是**资料**：作者写的句子，随书提交、可 diff、可评审 |

规则只有一句：**口径可以声明，门禁不能被关掉**。下面每条边界都是这条规则的展开。

## 2. 数据形状

`inkflow.json`（未列出的键见 [conventions.md](../conventions.md) §3.1）：

```json
{
  "schemaVersion": 1,
  "title": "蜀山",
  "gate": { "aiDashPer1000": 1.5, "wordCountMin": 1, "wordCountMax": 6000 }
}
```

| 键 | 类型 | 语义 |
|---|---|---|
| `gate` | object | 可选。**只允许 `GateThresholds` 的八个键**：`wordCountMin` / `wordCountMax` / `aiDashPer1000` / `aiEllipsisPer1000` / `aiSentenceMeanMax` / `aiSentenceEvenness` / `aiModifierPer1000` / `maxFindingsPerRule` |
| `gate.<键>` | number > 0 | 覆盖该键的默认值；`maxFindingsPerRule` 必须是整数。省略即取 `GATE_DEFAULTS` |

`library/gate-whitelist.txt`（UTF-8 文本，无 frontmatter，不进索引的实体表）：

```
# 人物口癖：清音说话时爱用破折号顿一下
早该如此
ＡＢＣ招牌
```

| 元素 | 规则 |
|---|---|
| 一行 | 一条**字面片段**（去首尾空白后） |
| `#` 开头 | 注释行（原文不参与匹配，行号仍计入） |
| 空行 | 忽略 |
| 编码 | UTF-8；读取容忍 BOM 与 CRLF |
| 文件不存在 | 零豁免（不是错误） |

## 3. 契约

### 3.1 优先级

```
GATE_DEFAULTS  <  inkflow.json 的 gate 段  <  调用方 options.thresholds
```

调用方的覆盖排在最后，是因为它是一次性入参（测试、面板的临时比较），不是持久口径。豁免没有优先级链：只有一份白名单，**不做 `.local` 变体**（ADR-0028 D7）。

### 3.2 匹配

1. 归一：片段与正文行两侧都做 `NFKC` + 小写折叠（全半角、大小写一致）。
2. 范围：一条 finding 的定位行（`path#L<n>`，`n` 是**正文行号**）里出现该片段。
3. 码：只有闭集里的七个码可能被豁免（见 §3.3）。
4. 结果：命中即**从 findings 里移除**（不降级为 `info`），并记进 `waivers.applied`。

### 3.3 可豁免码闭集

| 可豁免 | 不可豁免（举例，完整判据见 ADR-0028 D4） |
|---|---|
| `GATE_AI_NARRATION`、`GATE_AI_TEMPLATE`、`GATE_SENSITIVE_WORD`、`GATE_PROOF_HALF_PUNCT`、`GATE_PROOF_FULLWIDTH_ALNUM`、`GATE_PROOF_ARABIC_MEASURE`、`GATE_PROOF_NUMBER_MIXED` | 章节级统计（`GATE_WORD_COUNT_*`、`GATE_AI_PUNCT`、`GATE_AI_SENTENCE`、`GATE_AI_MODIFIER`、`GATE_AI_STUTTER`、`GATE_AI_LOW_LINK`、`GATE_AI_LONG_PARA`、`GATE_AI_PARALLEL`）、章末钩子、平台规则、退化检测、与设定库/账本矛盾、真正的错字（`PUNCT_UNPAIRED` / `REPEAT_WORD` / `NEAR_NAME`）、整章定位的 `PROOF_APPELLATION_MIXED` |

闭集在 `src/host/gate-waiver.ts` 的 `WAIVABLE_CODES`；可豁免的码必须能落到 `path#L<n>`，不可豁免的码里凡是整章定位的（`chapter:<id>`）在结构上就不可能被豁免。

### 3.4 上限（代码持有，书改不了）

| 项 | 上限 | 越界 |
|---|---|---|
| 单条片段长度 | 40 字符 | `GATE_WHITELIST_INVALID`，消息指名文件、行号、实际长度 |
| 条目数 | 30 条 | `GATE_WHITELIST_INVALID`，消息指名实际条数与上限 |

### 3.5 拒绝码

| 码 | 触发 | 影响 |
|---|---|---|
| `GATE_BOOK_CONFIG_INVALID` | `gate` 段不是对象；未知键；非正数/非有限数；`maxFindingsPerRule` 非整数；合并后 `wordCountMin >= wordCountMax` | 整次门禁拒绝，不出判决 |
| `GATE_WHITELIST_INVALID` | 单条超长；条数超限 | 整次门禁拒绝 |

拒绝而不是降级：静默忽略一条超长条目，等于作者以为豁免了、实际没有。

## 4. 边界与错误

- **只改上限要连下限一起写**：`wordCountMin >= wordCountMax` 会被拒，所以「我的章都短，上限收到 1500」必须同时写 `wordCountMin`。
- **`inkflow.json` 缺失或不可解析时取默认值**：那是四态门禁的判断（[conventions.md](../conventions.md) §1），质量门禁不再多一个失败面。
- **重复条目**（折叠后相同）只留第一条，不报错。
- **`gate` 段非法不阻断其它工具**：只有门禁读它。
- **结论文件**：`schemaVersion` 2，新增 `waivers` 块；`chapterDigest` 把白名单文件算进去（改白名单 = 换一次判决），没有该文件的书摘要不变。

## 5. 可见性

三处显示同一份数据（`GateReport.waivers`）：

| 位置 | 形态 |
|---|---|
| 结论文件 `.inkflow/audit/gate-<chapterId>.json` | `"waivers": { "configured": 2, "applied": [{ "code", "locator", "fragment", "whitelistLine" }] }` |
| 工具回执 / `GET /gate` | 同名字段（`gateWire`） |
| 面板「门禁」页签 | 一行：`本作有 N 条豁免（library/gate-whitelist.txt），这一章用掉 M 处：…` |

`configured` 是白名单的条数（含一条都没命中的），`applied` 只列这次真正生效的每一处。

## 6. 验收判据

- 无 `gate` 段、无白名单文件的书：`thresholds` 深等于 `GATE_DEFAULTS`，`waivers.configured === 0`，`findings` 与加这个功能之前逐条相同，`chapterDigest` 相同。
- 有豁免时：被点名那一处不报；同行的不可豁免码照报；别的行照报。
- 越界（41 字符 / 31 条）被拒且消息指名行号与上限。
- 带 BOM / CRLF / 注释 / 空行的白名单能读；全半角与大小写归一后再比对。
- 数值生效；非法值、未知键、区间颠倒被拒；调用方一次性 `thresholds` 仍赢。
- 白名单一改，`chapterDigest` 就变。

## 7. 不在范围内

- 白名单的正则 / 通配 / 分词（ADR-0028 备选 G）。
- `.local` 私有变体，或任何「只在本机生效」的豁免（D7）。
- 让书调高单条长度或条数上限（D5）。
- 白名单的写入工具：它是普通文本文件，用编辑器或 `git` 管。

## 8. 非功能

| 维度 | 目标 |
|---|---|
| 规模 | 白名单最坏 30 × 40 ≈ 1.2 KB；判定是每码每 finding 一次子串查找，单章 < 1 秒 |
| 延迟 | 多两次小文件读（`inkflow.json` 与白名单），都不存在时零额外读 |
| 降级 | 两者的错误都是**结构化拒绝**，不降级、不静默 |

## 9. 验证命令

```bash
node --test tests/gate-waivers.test.js    # 本细则的全部用例（先 RED 写的）
pnpm run check                            # 全套门禁
```
