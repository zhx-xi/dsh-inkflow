# ADR-0024：导出与 ZIP 复用（一个 store-only 写入器，EPUB 的 mimetype 首条且不压缩）

- 状态：已采纳（2026-10-25）
- 日期：2026-10-25

## 背景

#50 要把一本书导成 **EPUB** 与 **DOCX**。两者都是 ZIP 容器，仓库里已经有一个 ZIP 实现：

`src/host/zip.ts`（[ADR-0018](0018-settings-backup-diagnostics.md) D3）是 **store-only**（method 0）+ 自写 CRC-32 的容器：

| 能力 | 现状 |
|---|---|
| 写 | `writeZip(entries)`：本地文件头 + 中央目录 + EOCD，MS-DOS 时间戳，条目顺序 = 传入顺序 |
| 读 | `readZip(buffer)`：**读中央目录**（不是扫本地头），逐条校验 CRC 与长度 |
| 拒 | method ≠ 0、zip64、密文包、`..` / 绝对路径 / 反斜杠 / 空段名（防解压逃逸）、重名条目 |
| 依赖 | 零（`crc32` 也在本文件里，手写表驱动实现） |

同时 0.4.0 已经证明过两条事实（记在 roadmap §2.3「两处已在 B0 拍定的实现前提」）：store-only 约 200 行、`unzip` / 资源管理器 / 7-Zip 都能打开；而正文压缩收益与自研 deflate 的风险不成比例（出错时坏的是唯一副本）。

导出物还有第二个问题：**落在哪**。书的内容目录被索引、catalog、门禁、备份同时盯着，多一个 `exports/` 会被当成作品内容；而 `$DSH_HOME/inkflow/` 已经是设置、备份包与诊断包的落点（ADR-0018 D1/D4/D5）。

## 决策

### D1 只有一个 ZIP 写入器：复用 `src/host/zip.ts`

#50 的导出**不得**出现第二个 zip 写入器（不论自写还是引库）：

1. 写导出物一律 `writeZip()`，读回来做自检一律 `readZip()`；
2. CRC-32 只有 `zip.ts` 里那一份实现，别的模块不许再写一遍「算个 CRC」；
3. 需要新能力（例如带注释的条目、目录条目）时**改 `zip.ts`** 并补 `tests/zip.test.js`，不在导出模块里绕过它。

这条能被检查：`src/host/` 里除 `zip.ts` 外的模块只要 import 了 `crc32` 或自己拼 `0x04034b50` 之类的魔数，评审就该拦下来（一条 grep 就能查）。

### D2 EPUB：`mimetype` 是第一个条目且不压缩

OCF / EPUB 3 的硬性要求：

```
1. 第一个条目必须是 `mimetype`
2. 它的内容必须是 `application/epub+zip`（20 字节，无 BOM、无换行）
3. 它必须**不被压缩**（stored）
```

store-only 实现正好满足第 3 条，而「条目顺序 = 传入顺序」满足第 1 条——两个要求都不需要给 `zip.ts` 加分支。EPUB 的最小部件集：

| 路径 | 作用 |
|---|---|
| `mimetype` | 必须第一条、不压缩 |
| `META-INF/container.xml` | 指向 OPF 的根文件 |
| `OEBPS/content.opf` | 元数据（标题/作者/语言）+ manifest + spine（阅读顺序） |
| `OEBPS/toc.ncx` 或 `OEBPS/nav.xhtml` | 目录（EPUB 2 / 3 各一份的最小形态，选一即可） |
| `OEBPS/<chapterId>.xhtml` | 每章一个 XHTML 文档 |

### D3 DOCX：最小 OOXML 部件集

Word 能打开一份 `.docx` 的最小集合是三个部件（再加一个可选样式表）：

| 路径 | 作用 |
|---|---|
| `[Content_Types].xml` | 默认扩展名 → 内容类型，外加 `word/document.xml` 的 override |
| `_rels/.rels` | 包关系，指向 `word/document.xml` |
| `word/document.xml` | 正文（`w:document` / `w:body` / `w:p` / `w:r` / `w:t`） |
| `word/styles.xml`（可选） | `Heading1` 之类，用于章标题层级 |

XML 一律 UTF-8 无 BOM，段落顺序 = 章序（卷/章结构用标题层级表达，不新建 `sectPr` 分节）。

### D4 导出物落 `$DSH_HOME/inkflow/exports/`，不落书内

- 落点：`dataDir/exports/`（`dataDir` 缺省 `$DSH_HOME/inkflow`，`config.ts` 已有），与 `settings.json` / `backups/` / `diagnostics/` 同级。
- 命名：`<bookSlug>-<kind>-<stamp>.<ext>`（`kind` ∈ `epub` / `docx`；stamp 为 UTC，同秒再加 `-2` 后缀），沿用 `backup-zip.ts` 的命名习惯，避免同一套规则写两遍。
- **不落书内**的三个理由（按严重度）：①书是 git 仓库，导出物一落进去就是「每次导出改变工作树」，作者要么提交一个二进制、要么每次都被 `git status` 提醒；②内容目录会被索引与 catalog 扫描（`library/` 下的文件还会被资料卡片/导入路径登记）；③导出物可随时重算，属于派生物——而书里唯一放派生物的 `index/` 只允许 `.gitkeep` 与 `*.db`（[ADR-0023](0023-proposal-job-private-placement.md) D2）。
- 清理：不自动删（与 `backups/` 的保留策略分开定；导出物由用户自己删，面板只提供「打开所在目录」）。

**`confirm` 的判据（#50 落地时定，免得下一个人以为是漏了）**：一个写动作要不要求 `confirm`，看它**能不能覆盖或删除既有产物**，不看它写不写盘。`inkflow_backup_create` 要 `confirm`，因为保留策略会删掉旧包；`inkflow_diagnostics_export` 要 `confirm`，因为它写一份会被下一个人当「当前状态」的包。导出物两样都不是：stamp 命名保证**永不覆盖**，也不清理任何东西，失败可随时重来——所以 `inkflow_export` 不需要 `confirm`。这条判据比「同一类动作统一加 confirm」更可靠，后者会让确认框变成无脑下一步。

**入口归属**：本 ADR 说「书库侧」，实际 GUI 入口未随 #50 落地（工具 + 手册已可发现），落差由 issue #195 补；在那之前，导出的唯一入口是 `inkflow_export`。

## 备选与取舍

| 方案 | 优点 | 代价 | 为什么没选 |
|---|---|---|---|
| 引第三方 ZIP 库（jszip / archiver / yazl） | 开箱即用、支持 deflate | 破坏零运行时依赖（`dependencies` 必须为空，`check:guards` 会红）；插件在宿主进程内跑，多一个依赖就多一个升级面 | 依赖是硬约束，不是偏好 |
| 自研 deflate（替 `zip.ts` 升级） | 导出物体积更小 | 压缩是**有状态**的算法：一次编码错误产出的还是「能打开的 zip」，只是内容坏了——而它承载的是作者唯一一份导出；store-only 出错会立刻打不开，这是好事 | 省下的字节不值这个风险类别（ADR-0018 D3 的同一理由） |
| 调系统 `zip` / `7z` 子进程 | 零代码 | 宿主不保证有；跨平台路径与输出不可控；桌面版沙箱下子进程行为不可预期 | 把「能不能导出」绑在一台机器的 PATH 上 |
| 导出落书内（`exports/` 或 `library/exports/`） | 与书同处，用户容易找 | 污染内容目录：进 git、被索引/资料卡片扫描、每次导出都改变工作树；`library/` 下还会被导入路径当成资料 | 导出物是派生物，书里没有它的位置（`index/` 只放 `.gitkeep` 与 `*.db`） |
| EPUB 的 `mimetype` 允许压缩（更「通用」的 zip 配置） | 少一条特例 | 违反 OCF：多数阅读器会直接判非法包（或不认它是 EPUB） | 规范原文要求 stored；而 store-only 恰好不需要特例 |
| DOCX 用 HTML-in-docx 或 flat OPC（单文件 XML） | 生成更简单 | Word 对二者的兼容性/行为不一致（HTML-in-docx 打开是「网页」预览、flat OPC 是另一种 MIME 包装） | 最小 OOXML 部件集的成本是三段 XML，收益是「一份真正的 docx」 |

## 后果

| 收益 | 代价与对策 |
|---|---|
| 导出与备份共用同一个容器实现：一个 CRC、一处魔数、一套拒收规则 | 导出需要的能力若 `zip.ts` 没有，只能改 `zip.ts`（这不是限制，是「不出现第二份实现」的价格） |
| EPUB 的规范要求由实现形态天然满足（store-only + 顺序） | 条目顺序成为契约：`mimetype` 必须在 `entries[0]`，用例断言 |
| 书的 git 工作树不受导出影响 | 用户要去 `$DSH_HOME/inkflow/exports/` 找文件；面板给「打开目录」 |
| 导出物可随时重算，删了不丢真相 | 没有保留策略（会累积）；用户自行清理，面板不代删 |

## 验证

- `tests/zip.test.js`（既有）：store-only 往返、CRC 校验、拒收 method ≠ 0 / zip64 / 密文 / 逃逸路径 / 重名条目 —— 导出沿用同一实现，因此这些保证自动继承。
- #50 落地时追加：
  - 导出的 EPUB 用 `readZip()` 回读：`entries[0].name === 'mimetype'`、其 `method === 0`、内容逐字节等于 `application/epub+zip`；
  - 必需部件齐全（`META-INF/container.xml`、`OEBPS/content.opf`、spine 引用的每个 XHTML 都在包里）；
  - DOCX 三个部件齐全且 `[Content_Types].xml` 的 override 与 `document.xml` 的实际路径一致；
  - 导出物**不在**书目录内：导出后对书目录做一次树指纹（`tests/tree-digest.mjs` 已在用）比对，指纹不变。
- 手工（登记在 issue，不入库）：把导出的 `.epub` 拖进 Calibre/Thorium 打开一次、`.docx` 用 Word 打开一次；`unzip -l` 确认 `mimetype` 是第一条。
- 一条 grep 形式的守卫（#50 自查）：`grep -rn "crc32" src/host --include=*.ts` 只应命中 `zip.ts` 与（将来的）`export.ts` 的**读取方**，不应出现第二份 CRC 实现。
