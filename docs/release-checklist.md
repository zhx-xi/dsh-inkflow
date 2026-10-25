# 发布回归清单（安装 → 启用 → 写入 → 重启 → 升级 → 卸载 → 残留）

面向**执行回归的人**。每一步只做两件事：跑给定的命令，对照「判据」写下结论。判据不成立就是一条缺陷，不要绕过。

- 依据：[roadmap §5.6 发布 DoD](../.agents/specs/roadmap.md)（D6-1：数据丢失 = 0、残留 = 0）；导出相关见 [ADR-0024](../.agents/adrs/0024-export-zip-reuse.md)。
- **本清单不自动执行**：它动的是执行者自己的 DSH 安装（升级与卸载会把插件真的装一遍、删一遍），所以由人在**一台可以重装的环境**上跑，跑完把结果贴回 issue/PR comment（证据不入库，见 [AGENTS.md §9.5 D7](../AGENTS.md)）。
- 能在用例里断言的已尽量前置：**不要**再手工重复的那部分见文末「自动化已覆盖」。
- 路径约定（Windows + DSH 桌面版）：`DSH_HOME = %USERPROFILE%\.dsh`；插件数据目录 `%USERPROFILE%\.dsh\inkflow`；profile 目录 `%USERPROFILE%\.dsh\profiles\desktop`；自带运行时 `D:\program\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\{node\bin\node.exe,pnpm\bin\pnpm.cjs}`（用你机器上的实际安装位置替换）。

> 记号：**【已验证】** = 本文档成稿时有人跑过并留下证据；**【待跑】** = 需要执行者本次跑。当前整份清单为【待跑】。

---

## 0. 前置：准备一次可回滚的验证

| 项 | 命令 | 判据 |
|---|---|---|
| 记下起点 | `git -C <仓库> rev-parse HEAD` | 记下被验证的 commit（版本号 + commit 一起贴） |
| 需要一个非仓库的书 | 新建 `D:\tmp\relcheck\书A`，让插件把它初始化成书（`inkflow_project_plan` → `inkflow_project_init`） | 十项目录 + `.gitkeep` + `inkflow.json` + `git init` 都在，且**没有** commit |
| 记下数据目录基线 | `dir /s /b %USERPROFILE%\.dsh\inkflow` | 存成 `before.txt`，卸载后要比对 |

---

## 1. 安装

**目的**：插件能被装进 profile，且依赖面仍然是零运行时依赖。

```powershell
# 1) 构建产物（仓库里 lib/ 不入库，必须自己构建）
cd <仓库>
pnpm.cmd --config.verify-deps-before-run=false run build

# 2) 装进 profile（桌面版自带的 pnpm；路径换成你机器上的）
cd %USERPROFILE%\.dsh\profiles\desktop
"D:\program\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" `
  "D:\program\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs" `
  add link:<仓库绝对路径>
```

| 判据 | 怎么看 |
|---|---|
| profile 的 `package.json` 里出现 `dsh-inkflow`，且是 `link:` 或精确版本 | 打开文件看 `dependencies` |
| 装完 profile 里没有多出运行时依赖 | `git -C <仓库> show HEAD:package.json` 的 `dependencies` 为空 |
| 装的过程没有 ERR_PNPM_IGNORED_BUILDS 卡住 | 若出现，按 profile 的 `pnpm-workspace.yaml` 的 `allowBuilds` 处理，**不要**改仓库 |

**常见失败**：桌面版对「同一个包已在 dependencies 里」会拒绝就地改版本（`already-installed`）。本轮验证若遇到，先卸载再装，或完全退出 DSH 后手装。

---

## 2. 启用（插件真的激活）

**目的**：`inkflow_*` 工具与面板通道都在，且没有「静默不激活」。

1. **完全退出** DSH，再启动（HMR 不热替换已加载的插件）。
2. 新建会话，在书 `D:\tmp\relcheck\书A` 里说话；或直接看工具表。

| 判据 | 怎么看 |
|---|---|
| 工具面是 **68 个（49 内置 + 19 域）** | 会话里让 AI 调 `inkflow_project_status`；面板/自检里也应报同一数量。数字对不上说明有工具没注册（往往是 schema 里用了宿主不支持的 keyword，整条静默丢弃） |
| 没有 `JsonSchemaError` / `1 entry did not activate` | 启动日志与 stderr |
| 左栏「书库」图标在，点开能看到书 | 面板插槽 = `sidebar.panellist` + `main` |
| 面板通道通 | `GET http://127.0.0.1:<DSH 端口>/inkflow/internal/hub/books` 返回 JSON（未登录/未启用会 404，两者都是缺陷） |

---

## 3. 写入（能写、写得对、只写该写的）

```powershell
# 在书里让 AI 做三件事，或按手册手工触发
# a) 建卷 b) 建章 c) 写正文（含一个中文标题、一段带 < & " 的正文）
```

| 判据 | 怎么看 |
|---|---|
| 章文件出现且 frontmatter 有 `id`/`title`/`seq`/`status` | `dir /s /b D:\tmp\relcheck\书A\chapters` |
| UTF-8 无 BOM、行尾沿用文件原样 | 用编辑器确认；新建文件是 LF |
| 索引自动重建且能查 | `inkflow_chapter_list` 返回刚写的章 |
| `git status` 只有你写的章 + 索引被忽略 | `git -C D:\tmp\relcheck\书A status --porcelain`（`index/*.db` 应被 `.gitignore` 吃掉） |
| 书外零写入 | 书目录树指纹在这一步前后只应因你自己的写入而变 |

---

## 4. 导出（#50 专项）

```powershell
# 让 AI 依次调四次 inkflow_export：epub / docx / markdown / txt（target=book）
# 再调两次：target=volume（volumeId=vol-01）、target=status（status=draft）
dir %USERPROFILE%\.dsh\inkflow\exports
```

| 判据 | 怎么看 |
|---|---|
| 六个文件都在 `exports\`，命名 `<书名>-<格式>-<UTC 时间戳>.<扩展名>` | 目录列表 |
| **书里零新增** | 导出前后各跑一次 `git -C D:\tmp\relcheck\书A status --porcelain`，两次输出**完全一样**（导出物不在书内） |
| EPUB 合规 | `unzip -l 那份.epub` 的第一行是 `mimetype`；`unzip -p 那份.epub mimetype` 输出 `application/epub+zip`（20 字节、无换行） |
| EPUB 能被真实阅读器打开 | 拖进 Calibre 或 Thorium，目录里是**卷 → 章**两层，正文里的 `< & "` 显示成字符而不是标签（D5-7 的 2/2） |
| DOCX 能被 Word 打开 | 卷是「标题 1」、章是「标题 2」，导航窗格能折叠出层级 |
| 状态筛选是**筛**而不是全导 | `status=draft` 的产物里没有 `revised`/`final` 的章 |
| 同一秒导两次不覆盖 | 第二份文件名带 `-2` |
| 空书/筛不到章时是**拒绝**而不是空包 | 在空书上调一次，回答 `EXPORT_EMPTY`，`exports\` 里不多文件 |

---

## 5. 重启（幂等）

**目的**：重启不改状态、不重复注册、不重建索引。

1. 完全退出 DSH → 重新启动 → 打开同一本书。

| 判据 | 怎么看 |
|---|---|
| 面板没有「构建已过期」警告条 | 有就说明跑的是旧 `lib/`，重启一次再看 |
| 工具表仍是 68 个，没有重复项 | 同上一条命令 |
| `index/inkflow.db` 的 mtime **没变**（没触发重建） | 重启前后各 `dir index` 一次 |
| 刚写的章还在、导出物还在 | `chapters\` 与 `exports\` |

---

## 6. 升级（旧版本 → 本次版本）

**目的**：读者升插件不升书；书的格式不因升级而坏。

```powershell
# 装上一个已发布版本，建书写章，然后升到本版本
cd %USERPROFILE%\.dsh\profiles\desktop
# 先卸载旧版（桌面版不接受就地改版本），再 add 新版；然后完全退出并重启 DSH
```

| 判据 | 怎么看 |
|---|---|
| 老书打开即 `usable` | `inkflow_project_status` 的 `state` |
| 需要迁移的书会被**指出来**而不是自动改 | 六目录老书应给 `needs-repair` + 迁移建议（`inkflow_project_migrate plan`） |
| 索引版本变了就重建一次，之后稳定 | 首次打开 mtime 变一次，第二次重启不再变 |
| 设置（`settings.json`）与共享库（`shared\`）还在 | `%USERPROFILE%\.dsh\inkflow\` 下确认 |
| 书的 `git status` 没有因为升级而出现意外改动 | 与升级前对比 |

---

## 7. 卸载

```powershell
cd %USERPROFILE%\.dsh\profiles\desktop
"D:\program\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\node\bin\node.exe" `
  "D:\program\DeepSeek Harness\resources\runtime\primary-runtime\dependencies\pnpm\bin\pnpm.cjs" `
  remove dsh-inkflow
# 完全退出 DSH 再启动
```

| 判据 | 怎么看 |
|---|---|
| 重启后 `inkflow_*` 工具全部消失、书库图标消失 | 新建会话看工具表；面板不再出现在左栏 |
| DSH 仍能正常启动，没有「entry did not activate」的报错刷屏 | 启动日志 |
| profile 的 `package.json` / `pnpm-lock.yaml` 里没有 dsh-inkflow 残留 | 打开文件搜 `inkflow` |
| （若曾手改）`cordis.patch.yml` 里没有指向 `dsh-inkflow` 的 insert 行 | 搜 `inkflow` |

---

## 8. 残留检查（数据丢失 = 0、残留 = 0）

| 检查 | 命令 | 判据 |
|---|---|---|
| 书**没被卸载动过** | `git -C D:\tmp\relcheck\书A status --porcelain` 与卸载前逐行相同 | 相同 |
| 书的正文/设定一个字节都没少 | 卸载前后各算一次树指纹（`Get-FileHash` 全文件或 `git status` 无 deletion） | 相同，deletion = 0 |
| 插件自有状态**保留**（不是缺陷，是设计） | `dir %USERPROFILE%\.dsh\inkflow` | `settings.json`、`backups\`、`diagnostics\`、`exports\` 仍在；`shared\` 若用过也在 |
| 插件自有状态里**没有**书的内容副本泄漏 | 同上：不该出现 `chapters\`、`characters\` 这类目录 | 0 个 |
| profile 里没有半截安装 | 重装一次能成功（第 1 步复跑） | 成功 |
| 数据目录差异符合预期 | 与第 0 步的 `before.txt` 对比 | 只有本轮新建的导出/备份/诊断文件，且都在插件自有目录内 |

> 「残留 = 0」的范围是**安装残留**（profile 里的引用、注册行、锁），不包含插件数据目录——那里是用户数据（设置、共享库、备份、导出），卸载不代删，见 [ADR-0018](../.agents/adrs/0018-settings-backup-diagnostics.md) 与 [ADR-0024](../.agents/adrs/0024-export-zip-reuse.md) D4。

---

## 自动化已覆盖（本清单不重复，跑 `pnpm.cmd run check` 即可）

| 项 | 用例 | 断言 |
|---|---|---|
| 导出物不在书内、书内零新增 | `tests/export.test.js`「落点：导出物在 dataDir/exports，书里零新增」 | 树指纹（名字/类型/大小/mtime）导出前后完全一致；文件路径不在书内 |
| EPUB 的 `mimetype` 第一条且不压缩 | 同上「EPUB：mimetype 是第一个条目、未压缩」 | 直接读原始字节：本地头签名、method 字段 = 0、名字 = `mimetype`、载荷 20 字节等于 `application/epub+zip` |
| EPUB 能被同一读取器解回来、部件齐全 | 「EPUB：能被 zip.ts 解回来，manifest/spine 与包内文件逐一对上」 | `readZip()` 往返；manifest 的每个 href 都在包里；spine = 阅读顺序 |
| 卷 → 章 的目录层级 | 「EPUB：目录树是「卷 → 章」两层」 | 导航文档里有 3 个 `<ol>`（外层 + 两卷），卷名在章之前 |
| 正文转义 | 「EPUB：正文里的 < & " 被转义」 | 源码里的 `<script>` 不出现为标签；`&lt;` `&amp;` `&quot;` 都在 |
| DOCX 部件与标题层级 | 「DOCX：五个部件齐全…」 | 五个部件顺序固定；`[Content_Types]` 的 override 与真实路径一致；卷 Heading 1 / 章 Heading 2 |
| Markdown/TXT 的作用域与筛选 | 「Markdown/TXT：整本是单文件…」「按状态筛选时打成 zip」「按卷导出是一卷的单文件」 | 单文件 vs zip 的判定、卷与章标题层级、筛选不泄漏别的状态 |
| 拒绝 = 零写盘 | 「拒绝：format 非法」「target/volume/status/选择轴混用」「空书」「筛不到章」 | 每种都是结构化错误码，且 `exports/` 目录不存在或没变 |
| 不写第二个 ZIP 写入器 | `tests/zip.test.js`（既有） | store-only 往返、CRC 校验、拒收压缩/zip64/密文/逃逸路径/重名条目 |

**必须人工的那几条**（用例无法替代）：真实阅读器打开 EPUB/DOCX（第 4 步）、Word 的导航窗格层级、升级与卸载对**真实 DSH 安装**的影响（第 6、7 步）。

---

## 结果记录模板

| 步骤 | 结论（通过/失败） | 证据（命令输出 / 截图路径 / 文件） | 时间 | 执行人 |
|---|---|---|---|---|
| 1 安装 |  |  |  |  |
| 2 启用 |  |  |  |  |
| 3 写入 |  |  |  |  |
| 4 导出 |  |  |  |  |
| 5 重启 |  |  |  |  |
| 6 升级 |  |  |  |  |
| 7 卸载 |  |  |  |  |
| 8 残留 |  |  |  |  |

填完贴回对应的 issue / PR comment；仓库只留这份清单本身。
