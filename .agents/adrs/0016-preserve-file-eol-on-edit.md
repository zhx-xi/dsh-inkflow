# ADR-0016：编辑既有文件时保留该文件的行尾与 BOM（新文件仍归一 LF / 无 BOM）

- 状态：已采纳（2026-10-24）
- 日期：2026-10-24

## 背景

0.3.0 验证在作者的真书副本上实测（#132，F-1）：在面板上把第 20 章的正文改动**一个字**再保存，落盘字节从 8,996 B / 159 个 CRLF 变成 8,840 B / 0 CRLF，`git diff --stat` 显示 318 行（159 增 159 删）——正文一字未丢，但整章被重写成 LF，`git blame` 与「这次到底改了哪一句」一起失效。

根因链是两处**各自都正确**的归一化在写路径上叠加：

1. 读：`parseMarkdown` 把正文归一成 LF（`ParsedMarkdown.body` 的契约就是这个），`GET /chapters/:id` 把这份 LF 正文发给面板；
2. 写：面板把正文原样提交回来，`io.ts` 的 `normalizeText`（剥 BOM + `CRLF`/`CR` → LF）作为**写入口统一纪律**再归一一次并落盘。

于是「读进来的风格」在两处都被丢掉，谁也不知道这份文件原本是 CRLF。工具路径（`inkflow_chapter_write`）同样整篇重写、同样改风格。

约束（不因本 ADR 改变）：

- `normalizeText` 是**写入口的唯一纪律**（[data-safety](../constitution/data-safety.md) §2.6）：任何写都必须先归一，否则 BOM 与混合行尾会从任意一处漏进用户仓库；
- 作者的书是 CRLF 且 `core.autocrlf=false`：插件没有立场把 29 章正文一次性「修」成 LF（那是另一个决定，且必须由作者发起）；
- 新建文件必须仍是 UTF-8 无 BOM、LF。

## 决策

### D1 读路径把「原文件格式」作为只读元数据带出，body 仍是 LF

`GET /inkflow/internal/chapters/:id` 增两个只读字段：

| 字段 | 类型 | 含义 |
|---|---|---|
| `eol` | `'lf' \| 'crlf'` | 该文件**当前**的行尾风格 |
| `bom` | `boolean` | 该文件当前是否以 U+FEFF 开头 |

`body` 不变（LF、无 BOM）：面板拿到的正文与 `bodyChars`、检索片段、`chapters_fts` 仍然是同一份形状，`\r` 永远不会跑进编辑器或被算进字数。元数据是**文件的**属性，不是正文的属性，所以它只出现在详情响应里。

判定规则与行级补丁同源（[frontmatter.ts](../../src/host/frontmatter.ts) 的 `lineTerminator`）：以**首个行终止符**为准，`\r\n` → `crlf`，否则 `lf`。

### D2 写路径按「声明的风格」重新序列化，声明来自调用方或文件本身

`AtomicWriteOptions` 增 `style?: { eol, bom }`：`writeTextAtomic` 先照旧 `normalizeText`（纪律不动），**然后**按目标风格序列化——`crlf` 时把 `\n` 换成 `\r\n`、`bom` 时补 U+FEFF。`verbatim: true`（回滚）跳过两步，仍是逐字节还原。

生效风格的来源按调用方分两种，因为它们掌握的信息不同：

| 写路径 | 生效风格 | 为什么 |
|---|---|---|
| 面板（`POST /chapters/:id`，body 白名单 + `eol`/`bom`） | 调用方声明；未声明时回落到文件自身风格 | 面板是读-改-写客户端，它**看不到**原始字节，只能把读到的那份元数据带回来；这正是 #132 要求「带回元数据」的原因 |
| 工具（`inkflow_chapter_write`，schema 不变） | 文件自身风格（写前从字节判定） | 工具自己读文件，磁盘就是它的来源，多一个参数只会多一条能被传错的路 |
| 新建（`inkflow_chapter_create` / 卷目录 / 一切 `writeTextAtomic` 默认调用） | LF、无 BOM | 没有「原风格」可保留 |

`ChapterWriteInput.eol` / `.bom` 是**类型化**的（`'lf' | 'crlf'` / `boolean`），线上非法值在 `internal.ts` 以既有的 `invalid-field` 400 拒绝，不会进域层。

### D3 面板侧只加一条传递链，不改编辑器状态机

`ChapterDetailValue` → `EditorPane` 的 `style` → `SaveRequest.eol`/`.bom` → 保存 payload。`EditorFields`（title/body/status）不变：行尾不是可编辑字段，`undo`、冲突文案、自动保存的判定都不该看见它。`discardAndReload` 会用重读结果刷新 style（外部编辑器换过风格时跟着走）。

### D4 混合行尾按首行统一，并把这个限制写明

一份文件里 CRLF 与 LF 并存时，归一化后的正文已经无法逐行还原对应关系（面板改的是整段字符串），落盘统一到**首个行终止符**的风格。诚实后果：那些「本来就与首行不一致」的行会在这次保存里被改成首行风格——差异只涉及这些行，不会扩散到全文。

## 备选与取舍

| 备选 | 结论 | 理由 |
|---|---|---|
| A. 拆掉 `normalizeText`，`writeTextAtomic` 原样写回 | 不采用 | 写入口纪律是唯一能挡住 BOM/混合行尾扩散的地方；拆了等于把「格式卫生」下放给每个调用方。现有 `verbatim` 已经证明「原样写」应当是**显式**的例外，而不是默认 |
| B. 读路径让 `body` 原样带 CRLF，让面板自己保留 | 不采用 | `body` 的 LF 契约同时服务 `bodyChars`、`chapters_fts`、检索片段与 `parseMarkdown`；一改就有两个风格来源，冲突时无法判断谁对。且 `\r` 会进编辑器与光标计算 |
| C. 生效风格**只**看磁盘（忽略面板声明） | 部分采用：工具路径就是这条 | 对工具路径这是唯一正确做法。对面板路径它会让 `eol`/`bom` 变成**没人读的协议面**——而 #132 明确要求把元数据带回来；同时它把「面板与磁盘风格不一致」这件事静默吞掉，正是 #132 要消灭的那类静默 |
| D. 一次性把整本书转成 LF（作者发起的迁移） | 不采用（本单） | 那是「改用户全部正文」的另一个决定，必须由作者发起、单独记 ADR、单独走确认流程；不能在修 bug 时顺手做 |
| E. 让写入口「猜」风格（比如沿用上次写的风格） | 不采用 | 进程内状态无法表达「这本书里第一章 LF、第二章 CRLF」；猜错就是整章 diff |

C 与 D2 的差别值得写清：C 更保守，但它把面板声明的**存在**意义抹掉了，而面板是唯一拿不到原始字节的一方。选择「声明优先」的前提是面板的声明描述的是它刚读到的那份字节；这个前提由既有的 CAS 基线兜着——正文真被外部改过时 `expected` 不匹配（409 `FILE_CHANGED`，零写盘），保存根本走不到序列化。若日后发现陈旧面板会写坏风格，切到 C 只需改 `chapters.ts` 里取生效风格的那一行。

## 验证

- `tests/internal-write.test.js`：CRLF+BOM 章经 `POST /chapters/:id` 保存后，逐字节只有被改的那个字不同、BOM 在、CRLF 数量不变；LF 章保存后仍是 LF 且不新增 BOM。
- `tests/chapters.test.js`：`inkflow_chapter_write` 对 CRLF 文件写完，frontmatter 块逐字节相同、正文是该文件的 CRLF；新建章仍是 LF 无 BOM。
- 变异自检：把「按目标风格重新序列化」那一行去掉，上述用例必须变红。
