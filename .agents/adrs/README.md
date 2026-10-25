# 决策记录（ADRs）

> 架构决策记录（Architecture Decision Records）。**先写 ADR，再改代码**：涉及技术选型、架构边界、数据格式、对外契约的变更都需要一条。
> 格式：Nygard（状态 / 背景 / 决策 / 备选与取舍 / 后果 / 验证）。**必须写「为什么不选另一个方案」。**

## 1. 索引与速览

### 1.1 索引表（编号 / 标题 / 状态 / 日期）

| # | 标题 | 状态 | 日期 |
|---|---|---|---|
| [0001](0001-single-plugin.md) | 一个插件承载全部功能，不自研编排 | 已采纳 | 2026-10-21 |
| [0002](0002-sqlite-truth-source.md) | SQLite 为真相源，同步只在架构上预留 | 已被 0005 取代 | 2026-10-21 |
| [0003](0003-build-chain.md) | P0 用 esbuild 单工具链（偏离 tsdown） | 已采纳（P0）；P1 复评 | 2026-10-21 |
| [0004](0004-loopback-http.md) | 面板 HTTP 只绑 loopback 并自校验 Host/Origin | 已采纳；**部分条款被 [0008](0008-panel-data-channel.md) 收窄** | 2026-10-21 |
| [0005](0005-files-first-with-derived-index.md) | 文件真相 + SQLite 派生索引 | 已采纳（现行）；门禁与目录条款被 0006 修改 | 2026-10-21 |
| [0006](0006-workspace-contract-v2.md) | 工作区契约 v2（9 内容目录 / 四态门禁 / 卷章 catalog） | 已采纳 | 2026-10-21 |
| [0007](0007-plugin-shared-library.md) | 插件级共享库（`$DSH_HOME/inkflow/shared/`，复制快照 + `origin` 溯源） | 已采纳 | 2026-10-21 |
| [0008](0008-panel-data-channel.md) | 面板入口只在 `conversation.view`，数据走私有内部通道（不是 API） | 已采纳；**取代/收窄 [0004](0004-loopback-http.md)** 的对外接口定位与路径命名；**D1 入口范围被 [0010](0010-book-hub-entry.md) 收窄** | 2026-10-21 |
| [0009](0009-ovk-semantic-search.md) | 语义检索复用 OpenViking（peer 从工作区读 / 按章重建 / 召回不等于定位） | 已采纳 | 2026-10-21 |
| [0010](0010-book-hub-entry.md) | 书库入口（root 侧栏）+ 书单来自 DSH 工作区注册表，无会话通道只做状态/初始化/共享库只读 | 已采纳；**收窄 [0008](0008-panel-data-channel.md) D1**（创作工作台仍只留 `conversation.view`） | 2026-10-21 |
| [0011](0011-ci-merge-gate.md) | 合并前 CI 门禁由分支保护强制，配置期望值由仓库内脚本可验证 | 已采纳 | 2026-10-22 |
| [0012](0012-plugin-private-state-dir.md) | 插件私有状态目录 `<book>/.inkflow/`（回收站/迁移备份/审计导出）+ 写白名单扩展 | 已采纳 | 2026-10-24 |
| [0013](0013-facts-ledger-line-format.md) | 事实账本用正文列表项 + 竖线分隔键值（一文件多事实的编码） | 已采纳 | 2026-10-24 |
| [0014](0014-entity-id-pinning.md) | 实体改名用「id 钉住」，不级联重写引用 | 已采纳 | 2026-10-24 |
| [0015](0015-repair-and-migration.md) | **修复三段式（detect/preview/fix）+ 6→9 迁移**：动作只有五种、只补不改；迁移前开备份包（`.inkflow/backup/`），失败不自动回滚而由包撤销，回滚逐文件核对改后摘要 | 改已存在的文件无法用内存撤销；只补不改是「不给作者改内容」的硬边界 |
| [0017](0017-extraction-by-session-model.md) | **插件不调 LLM**：提取候选由会话里的模型经工具提交，落 `.inkflow/candidates/`，只有 `accept(confirm)` 才写真相 | 零依赖 + 不做第二个消费者（ADR-0008）→ 插件内没有可信的模型调用面；候选制才保得住「静默入库 = 0」 |
| [0018](0018-settings-backup-diagnostics.md) | **设置写 `$DSH_HOME/inkflow/settings.json`**（不写书）、**备份 = store-only ZIP**（自写 CRC32，保留 5 份）、**诊断包白名单**（不含正文/密钥） | 设置写书会进 git；自研 deflate 出错时坏的是唯一备份；诊断包是要发出去的 |
| [0019](0019-one-level-nested-frontmatter.md) | frontmatter 支持一层嵌套映射（只为 `origin` 这类对象字段） | 已采纳 | 2026-10-24 |
| [0020](0020-ovk-endpoint-from-settings.md) | 语义后端的连接来自插件设置，不去挖 OVK 的配置文件 | 已采纳 | 2026-10-24 |
| [0021](0021-candidate-duplicate-and-overwrite.md) | 候选遇到既有实体：同身份同内容→跳过、同身份异内容→问作者是否覆盖、异身份→硬冲突 | 已采纳 | 2026-10-25 |
| [0015](0015-repair-and-migration.md) | 一键修复与 6→9 迁移（三段式 + 可回滚备份包） | 已采纳 | 2026-10-24 |
| [0017](0017-extraction-by-session-model.md) | 提取由「会话里的模型」产出，插件只做队列与落地 | 已采纳 | 2026-10-24 |
| [0018](0018-settings-backup-diagnostics.md) | 全局设置 + store-only ZIP 备份 + 白名单诊断包 | 已采纳 | 2026-10-24 |
| [0019](0019-one-level-nested-frontmatter.md) | **读取器支持一层嵌套映射**（`origin` 需要对象字段）：只有缩进的 `key: value` 挂到待决键、值仍只到标量/内联数组/块列表、列表与映射混用报 issue、写侧只做块替换 | 扁平键的点号不在键字符集（读侧报 unparsed）、内联 JSON 让字段不可读；而完整 YAML 违反零依赖 |
| [0020](0020-ovk-endpoint-from-settings.md) | **语义后端连哪由设置说**：`settings.json` 的 `semanticSearch`(boolean) + `semanticEndpoint` + `semanticApiKey?`（**平铺追加**，不改已有 boolean 的形状）；peer 仍只读工作区配置；缺什么降级什么（六种 `degradedReason`）。**S1**：块写 `viking://resources/inkflow/<projectId>/chapters/<chapterId>/<index>.md`（peer 子树只读）；**S2**：tombstone 账本放 `dataDir/semantic/`（派生索引推不出来） | 读 `ov.conf` 等于把 OVK 的凭据面搬进插件、且它一改字段就静默失效；env 在桌面版被 scrub、且不随书走；嵌套对象会让老读者把开关读成关；peer 子树只读会把「能用」换成「更整齐」 |
| [0015](0015-repair-and-migration.md) | 一键修复与 6→9 迁移（检测/预览/修复三段 + 可回滚备份包） | 已采纳 | 2026-10-24 |
| [0016](0016-preserve-file-eol-on-edit.md) | 编辑既有文件时保留该文件的行尾与 BOM（新文件仍归一 LF / 无 BOM） | 已采纳 | 2026-10-24 |
| [0021](0021-candidate-duplicate-and-overwrite.md) | **候选遇到既有实体三选一**（`judgeCandidate()` 是唯一判定，propose 与 accept 共用）：同身份 + 内容一致 → 提交时**直接跳过**（不建候选、零写盘）；同身份 + 内容不一致 → 建候选并带 `duplicate{path,digest,changedFields}`，采纳需显式 `overwrite: true`，替换前写 `replace` 备份包、CAS 基线用**propose 时**的 digest；跨类 id 等才是硬冲突。面板逐条问「已存在，内容不一致——是否覆盖？」，**批量永不覆盖** | 重复提取是常态，一致的那些让作者手工拒绝一半是把无意义工作留给用户；不一致自动覆盖会静默重写手写正文（ADR-0012/0015 的一贯口径是破坏性动作要显式确认）；按字节比「一致」在手写卡与渲染文档之间永远判成不一致；用采纳瞬间的 digest 做 CAS 会覆盖作者在两次点击之间的修改 |

| [0022](0022-writing-context-gate-findings.md) | 简报/门禁/审稿的装配与问题形状：`buildWritingContext()` 是唯一装配点、9 段固定顺序与裁剪顺序、门禁结论 `gate-<chapterId>.json` 同输入同字节 | 已采纳 | 2026-10-25 |
| [0023](0023-proposal-job-private-placement.md) | 提案与批量作业的私有落点（`.inkflow/{proposals,jobs}`）+ 写白名单第三次扩容 | 已采纳 | 2026-10-25 |
| [0024](0024-export-zip-reuse.md) | 导出复用 `zip.ts`（EPUB `mimetype` 首条且不压缩、DOCX 最小 OOXML、导出物落 `$DSH_HOME/inkflow/exports/`） | 已采纳 | 2026-10-25 |
| [0025](0025-calendar-and-place-kind.md) | 历法与地点：`calendar.ts` 是换算的唯一实现（`A→B→A` 误差 0）、`worldTime` 保持标量、地点不新增 kind | 已采纳 | 2026-10-25 |
| [0026](0026-private-purge-area.md) | 私有状态回收区 `.inkflow/purged/`（#199 手动清理可还原）+ 写白名单第四次扩容；清单逻辑与回收站共用一份 | 已采纳 | 2026-10-25 |
| [0027](0027-external-reference-tiers.md) | 外部参考的复用档位：方法论自写、数据表可引用（须署名）、代码只允许单文件移植（须文件头写明来源与许可） | 已采纳 | 2026-10-25 |

### 1.2 决策速览（一行一条）

| # | 决策 | 关键理由 |
|---|---|---|
| [0001](0001-single-plugin.md) | 一个插件承载全部功能，不自研编排 | 避免多插件冲突；复用 DSH agent/skills/chat |
| [0002](0002-sqlite-truth-source.md) | ~~SQLite 为真相源~~ | 早期方案；保留作历史（被 0005 取代） |
| [0003](0003-build-chain.md) | P0 用 esbuild 单工具链（偏离 tsdown） | Client 半必须产出 loader factory 形状；单工具链失败面小 |
| [0004](0004-loopback-http.md) | 面板 HTTP 只绑 loopback 并自校验 Host/Origin | 宿主路由零鉴权，必须 fail-closed（对外接口部分见 0008） |
| [0005](0005-files-first-with-derived-index.md) | **文件真相 + SQLite 派生索引** | 升级不破坏存量项目；没有数据库迁移；git 即版本历史 |
| [0006](0006-workspace-contract-v2.md) | **工作区契约 v2**：9 内容目录 + 派生 `index/`、四态门禁、卷章 catalog | 门禁要输出可执行动作，而不是一句"不是项目"；卷章归属不靠路径猜；一个工作区只服务一部小说 |
| [0007](0007-plugin-shared-library.md) | **插件级共享库**：`$DSH_HOME/inkflow/shared/`（world / library / snippets / series），默认复制快照 + `origin{projectId,entryId,contentHash}` 溯源，引用仅限 `library/` 原文，系列 = 共享库分组 | 一次维护多书取用；书仍自包含；来源可追溯（`entryId` + `contentHash`） |
| [0008](0008-panel-data-channel.md) | **面板入口只留 `conversation.view`**，数据走私有 `/inkflow/internal/*`（**不是 API**），客户端只传 `sessionId`、Host 用 workspace 解析路径 | root 插槽拿不到工作区；路径不能让调用方指定；第三方 `@Remote` 当前不可行 |
| [0009](0009-ovk-semantic-search.md) | **语义检索复用 OpenViking**：peer 从工作区配置只读、按章同路径覆盖重建、召回不等于定位、缺 OVK 降级 FTS5（含 2 字 `LIKE` 兜底） | 零依赖下自研向量库不现实；`forget` 是永久物理删除，不能映射「删章」；结果只到文件级 |
| [0010](0010-book-hub-entry.md) | **书库入口（root `sidebar.panellist`）+ 书单 = DSH 工作区注册表**（不自建 `books.json`，一本书 = 一个 workspace）；新增无会话通道 `/inkflow/internal/hub/*`，能力白名单只有列书状态 / 初始化 plan、apply / 共享库只读，**禁止任何作品正文读写**；新开书 = pickDirectory → plan → apply(confirm) → 注册工作区 → 引导开新会话（不能程序化建会话） | 没有会话就看不到面板，新开书路径太长；注册表已是"一书一工作区"的宿主表达；root 槽位无 `sessionId`，正文读写仍必须由会话推出路径 |
| [0011](0011-ci-merge-gate.md) | **合并前 CI 门禁 = 分支保护（`strict` + `enforce_admins` + 禁 force push + 评审线程必须解决）+ 仓库内期望值（`EXPECTED`）与 `check`/`apply` 脚本**；检测在本地 `check` 链，应急出口 = 临时 DELETE 后立刻 apply 并留痕 | 纪律没有机制承载时坏一次就重来一次（`#7`）；管理员捷径正是事故路径；public 仓库的 `GITHUB_TOKEN` 拿不到保护配置，只能本地验 |
| [0012](0012-plugin-private-state-dir.md) | **插件私有状态目录 `<book>/.inkflow/{trash,backup,audit}/`**：不是内容目录、不参与门禁、不进索引与 git（`REQUIRED_GITIGNORE_LINES` 追加 `.inkflow/`），写只经 `resolveWriteTarget` 批过的三条子路径；`trash/` 永不自动清理，超阈值只提示 | `index/` 缺失会被静默重建（ADR-0006 D2）且只忽略 `*.db` → 回收站放进去等于「重建索引即丢数据、还会被提交进 git」；`$DSH_HOME` 方案依赖未裁决的 `projectId`（Q12） |
| [0013](0013-facts-ledger-line-format.md) | **事实账本一条事实一个正文列表项**：`- attribute: … │ value: … │ since: … │ chapterId: … │ source: …`，frontmatter 只放 `subject`；值里的 `│` 写 `\|`；未知键保留 | 读取器不支持嵌套映射（同时间线 `worldTime` 的因），Markdown 表格与中文竖线打架、对齐行污染 diff，一条一文件又与 §3.5 的文件粒度冲突 |
| [0014](0014-entity-id-pinning.md) | **实体改名 = 移动文件 + 把旧 id 写进新文件 frontmatter**，五处引用（关系端点/时间线参与/账本主体/伏笔关联/提及键）一个都不重写；影响清单只告知；新增 info 级 `ID_PATH_DIVERGED` | 级联重写是 N 个文件的非事务动作，中途失败留半改状态，正好违反「取消时零写入」；而显式 `id` 本来就是 §3.1 推荐的合法写法，钉住只需一次写 |
| [0015](0015-repair-and-migration.md) | **修复 = 检测/预览/修复三段**（`detect` 与 `preview` 零写盘，`fix` 需 `confirm`），动作只有四种（补 frontmatter 必填键 / 重挂 `parent:` / 删重复关系 / 重建 catalog 投影），`fixable:false` 一律不做；**6→9 迁移只增目录 + 只改两个元数据文件**（`.gitignore` append-only、`inkflow.json` 只改 `schemaVersion`），内容文件零字节变动；两者都先写 `<book>/.inkflow/backup/<stamp>/`（清单先写 `sealed:false` 再盖章）以便逐字节回滚，报告落 `.inkflow/audit/` | 迁移改的是**已存在**的文件，向导式的内存撤销一崩就没，所以只在「改已存在文件」的路径上落盘撤销；删除重复关系按「索引保留第一条」这一条确定规则而不是猜哪条更「像名字」；非法枚举值不改——修复侧与写侧同一条纪律：拒绝而不是降级 |
| [0020](0020-ovk-endpoint-from-settings.md) | **OVK 的连接 = 插件设置**（`semanticSearch` + `semanticEndpoint` + `semanticApiKey`，平铺追加字段，不读 `ov.conf`）；**块写 `viking://resources/inkflow/<projectId>/chapters/<chapterId>/<blockIndex>.md`**（peer 子树只读）；**tombstone 账本 = `dataDir/semantic/<slug>.json`**（派生索引推不出来）；降级原因固定六词表 | 机器级配置不能当插件输入（读者看不见、换机漂移、还带着别人的 key）；嵌套对象会让老读者把开关读成关（ADR-0018 加字段不 bump）；peer 子树只读会把「能用」换成「更整齐」；已删章的状态不在文件里，放进缓存等于重建即丢清理清单 |
| [0016](0016-preserve-file-eol-on-edit.md) | **编辑既有文件保留该文件自己的行尾与 BOM**：`GET /chapters/:id` 增只读 `eol`/`bom`（body 仍 LF），写路径在 `normalizeText` **之后**按目标风格重新序列化（面板声明优先、工具回落磁盘、**新建仍 LF 无 BOM**）；混合行尾按首个终止符统一 | 读写两处都归一会把「原风格」丢两次，读者改一个字就得到整章 diff（`git blame` 失效）；拆掉 `normalizeText` 又会让 BOM/混合行尾从任意一处漏进用户仓库；一次性把作者的书转 LF 是另一个必须由作者发起的决定 |
| [0022](0022-writing-context-gate-findings.md) | **简报/门禁/审稿：一个装配、一份词表、一份可 diff 的结论**——`buildWritingContext()` 是唯一装配点（预览与真实注入同函数同入参，每段 `{id, bytes, tokens, truncated}`）；9 段顺序 `outline → promise → characters → voice → facts → foreshadow → world → prevTail → anchors`，超预算按 `world → facts → foreshadow → prevTail` 裁（前三段不裁、每次裁剪埋点）；门禁/审稿/校对一律用 `findings.ts` 的形状（`fixable` 只对机械可修项 true）；门禁结论落 `.inkflow/audit/gate-<chapterId>.json` 且**不含时间戳**（同输入同字节，可 diff） | 预览另写一份装配必然漂（0.4.0 的双份 body 字段集 #166 就是这么坏的）；三套问题类型会让体检页与门禁页各认一套；`index/` 缺失即静默重建（ADR-0006 D2），结论落进去等于「重建一次就没了」；带戳的文件每跑一次多一个，diff 永远是新文件 |
| [0023](0023-proposal-job-private-placement.md) | **提案与作业进度落 `.inkflow/{proposals,jobs}/`**（`PRIVATE_STATE_SUBDIRS` 与 `resolveWriteTarget` 白名单从四条扩到六条**子路径**）；`index/` 除 `.gitkeep` 与 `*.db*` 外一律为空（用例断言）；`.gitignore` 的 `.inkflow/` 行仍由首次使用方 append-only 追加（X-9 不变）；`..` 与符号链接逃逸仍拒 | 判据不是「同类放一起」而是「重建不可再生」：`index/` 删了会回来，提案与断点删了就没了——#43/#47 正文的 `index/audit/`、`index/jobs/` 因此以本条为准；落 `$DSH_HOME` 与「换机继续跑」直接冲突 |
| [0024](0024-export-zip-reuse.md) | **导出复用 `src/host/zip.ts`，不出现第二个 ZIP 写入器**：store-only（method 0）+ 自写 CRC-32；EPUB 的 `mimetype` 必须**第一个条目且不压缩**（OCF 规范，store-only + 条目顺序天然满足）；DOCX 用最小 OOXML 部件集；导出物落 `$DSH_HOME/inkflow/exports/`（**不落书内**） | 引库破坏零运行时依赖；自研 deflate 出错时坏的是唯一一份导出；导出物落书内会进 git、被索引与资料卡片扫描，而书里唯一放派生物的位置只允许 `.gitkeep` 与 `*.db` |
| [0025](0025-calendar-and-place-kind.md) | **历法与地点：一个换算函数、一个既有 kind**——`calendar.ts`（`toAbsolute` ⇄ `fromAbsolute`，可配置纪元/闰规则）是唯一实现，`A→B→A` 逐日误差 0，`fromAbsolute` 先夹上界再二分而非按平均年长估算；非法输入与非法历法表一律结构化拒绝；`timeline/*.md` 的 `worldTime` **仍是标量**，绝对日只是 #48 在**索引**里加的派生列；地点就是 `world/<category>` 的条目，地图只挂既有条目，**不新增 kind、不新建 `locations/`** | 换算散在三处，闰日旁差一天没人查得出；平均年长估算在闰日旁必差；`worldTime` 改嵌套会作废 ADR-0019 的读回约束与全部既有时间线文件；给地点新开身份会让改名/影响面/提及/检索各认一套；派生列若回写 frontmatter 就是同一事实两处存储，必漂 |

| [0026](0026-private-purge-area.md) | **私有状态有自己的回收区 `.inkflow/purged/`**（`PRIVATE_STATE_SUBDIRS` 与 `resolveWriteTarget` 白名单从七条扩到八条子路径）：副本保持它在 `.inkflow/` 下的原相对路径，还原目标因此是事实而不是入参，且被 `restoreTargetOf` 限定在 `.inkflow/{review,proposals}`；可清理对象只有**单条审稿运行记录**与**已结束（`applied`/`rolled-back`）的提案**，`open` 永不进候选；清理要 `confirm: true` 并在 `.inkflow/audit/` 留一条删除记录（删了什么/何时/字节/哪个会话）；**`trash.ts` 对 `.inkflow/` 源的禁令不放宽**；清单逻辑抽成 `private-manifest.ts` 由两处共用；不新增 `inkflow_*` 工具（照 `trash` 的通道形状） | 放宽回收站等于让「作者删的正文」与「插件写的记录」共用一份清单与一套还原语义；直删（学 `candidates/purge`）删错一次就丢一次审稿证据；自动按条数淘汰与「运行记录是事实」冲突；落 `$DSH_HOME` 不随书走；给清理开工具则模型要替作者决定「留哪些历史」 |

| [0027](0027-external-reference-tiers.md) | **外部参考按内容性质分三档**：D1 方法论**一律自写**（只借结构与思路）；D2 纯数据表（词表/阈值/类别名单）**可引用**但须在使用处署名（项目 + 文件 + MIT + 我们改了什么）；D3 代码**只允许单文件移植**，文件头须写明来源/许可/改写点，禁止整目录复制；D4 非宽松许可（GPL 等）仍只读行为；D5 引用进来的阈值必须落在单一来源文件并注明出处（散落 = 迟早漂移）；D6 对照结论仍进 issue/PR。配套纪律改为指向本 ADR，不再写「只学设计，不搬代码」的绝对化读法 | 一律重写对数据表等于重做别人的标定过程（我们没有那份语料，只会得到更差的表）；允许整包派生则会让 4.3 MiB / 431 文件破坏零依赖与包体积，并退化成「别人的 skill 包 + 我们的壳」 |

## 2. 编号与登记规则

1. 文件名：`NNNN-<kebab-slug>.md`，四位递增，**不复用、不跳号**；
2. 新增后必须登记到 §1.1 索引表并补 §1.2 速览一行（否则等于没写）；
3. 决策被取代时：**不改写原文**，把头部「状态」改为「已被 NNNN 取代」并说明原因，原文保留作证据；
4. 纯文字澄清不算新决策，直接改原 ADR 并在状态里注明「澄清」。

## 3. 模板

```markdown
# ADR-NNNN：<决策的一句话标题>

- 状态：提议 / 已采纳 / 已被 NNNN 取代（YYYY-MM-DD）
- 日期：YYYY-MM-DD

## 背景
（问题是什么、约束是什么、有哪些已实测的事实）

## 决策
（做什么，可执行、可检验）

## 备选与取舍
| 方案 | 优点 | 代价 | 为什么没选 |
|---|---|---|---|

## 后果
（收益 / 代价与对策，最好用表格）

## 验证
（怎么证明这条决策成立：命令、测试文件、实测数据）
```

## 4. 当前未决问题

所有未决问题集中在 [S-06 open-questions](../specs/open-questions.md)；拍板后按需升级为 ADR（重要决策才立 ADR，纯口径调整记入裁决记录即可）。
