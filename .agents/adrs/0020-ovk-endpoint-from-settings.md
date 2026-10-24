# ADR-0020：OVK 的连接从设置来、块落在资源树、tombstone 账本放插件私有目录

- 状态：**已采纳（2026-10-24）**
- 日期：2026-10-24
- 关系：实施 [ADR-0009](0009-ovk-semantic-search.md)（P1–P10 是决策依据，本 ADR 只补齐它留给实施的三处空档：连接从哪里来、块写到哪里、tombstone 记在哪里）；沿用 [ADR-0018](0018-settings-backup-diagnostics.md)（D1/D2 设置语义与诊断包白名单）；遵守 [ADR-0012](0012-plugin-private-state-dir.md)（插件私有目录）
- 影响：`src/host/ovk*.ts`（新）、`src/host/settings.ts`、`src/host/search.ts`、`src/host/hub-settings.ts`、[S-02 architecture](../specs/architecture.md) §6、[docs/user-guide.md](../../docs/user-guide.md)

## 背景

[ADR-0009](0009-ovk-semantic-search.md) 定了「语义检索复用 OVK、peer 只从工作区读、按章重建、删章不调 `forget`、召回不等于定位、无 OVK 时降级 FTS5」，但三件事留给实施，原文明确标为未定项：

1. **连接从哪里来**——ADR-0009 §12 提到 embedding/摘要的配置在 `~/.openviking/ov.conf`，那是 OVK 自己的机器配置文件。InkFlow 该读它，还是让用户填？
2. **块写到哪里**——ADR-0009 P10 的未定项原文：「`write` 的落点究竟是 resources 还是 peer memories（探针 E6 的【未验证】项）」。
3. **tombstone 与清理清单记在哪里**——P5/P6 要求每块带 `deleted`、`purge` 要能列出待删 URI，但「已删章」在文件系统里已经不存在，任何从文件重建的派生索引都**不可能**推导出这份状态。

## 决策

### E1 连接只从插件设置读，绝不读 OVK 的机器配置文件

| 项 | 决定 |
|---|---|
| 开关 | `settings.json` 的 `semanticSearch`（boolean，ADR-0018 已定；缺失 = 关） |
| 端点 | `settings.json` 的 `semanticEndpoint`（`http://host:port`，无尾斜杠）；缺失 = `no-endpoint` 降级 |
| 凭据 | `settings.json` 的 `semanticApiKey`（可选；作为 `Authorization: Bearer` 发送）。诊断包里打码（见 E6） |
| **不读** | `~/.openviking/ov.conf`、`~/.openviking/ovcli.conf`、`$DSH_HOME/.env` 等任何 OVK 机器级配置 |

三条理由：

1. **一机一份 vs 一份真相**：`ov.conf` 是 OVK 的**机器级**配置（本机 `storage.workspace` 指向 `D:\develop\openviking-data`，`vlm.api_key` 是作者自己的 key）。插件读它，等于把别人的运维细节当成自己的输入，换机器/换 profile 就漂移，且读者无法从设置页看见「到底连的是谁」。
2. **ADR-0018 D1 已经给了落点**：插件只有一处自有数据目录，插件的跨书偏好写在那里。端点与凭据正是「跨书、机器相关、用户可见」的一类，和共享库路径同级。
3. **可测**：一条断言「代码里不出现 `ov.conf` / `ovcli.conf`」就能把这条边界钉死（`tests/ovk.test.js` 的 grep 守卫）；读机器配置的实现没法这样守。

字段形状选**平铺三字段**而不是嵌套对象 `semanticSearch: { enabled, endpoint, apiKey }`：`semanticSearch` 在 0.4.0 B1 已作为 boolean 落地并被设置页与既有测试消费，改成对象是一次形状变更（`SETTINGS_SCHEMA_VERSION` 该 +1，老读者会把对象读成默认 false，用户会看到「开关自己关了」）。平铺加字段是**追加**：老读者忽略未知键，新读者给缺失项默认值（ADR-0018 D2）。

### E2 peer 仍然只从工作区读（不改 ADR-0009 P2）

peer **不是**设置项，也不派生：`<book>/.openviking/config.local.json` → 缺则 `config.json`，只读 `peer.id`，`version` 必须为 `1`、文件 ≤ 64 KiB、id 只允许 `[A-Za-z0-9_.@-]`（≤100 字符），不代写、不派生模板、不编造。来源与失败原因**回显**在 `inkflow_semantic_status` 与降级原因里，用户能看见「哪一层生效 / 为什么没有 peer」。

与 E1 的分工：**连接是插件的偏好，命名空间是书的事实**。前者跨书共享、换机器要重填；后者必须跟书走（否则同一本书在两台机器上分裂成两个命名空间，ADR-0009 P2 的原话）。

### E3 块落在 `viking://resources/` 下的项目子树；peer 子树是只读的

块 URI 固定为：

```
viking://resources/inkflow/<projectId>/chapters/<chapterId>/<blockIndex>.md
```

召回时 `target_uri` 取 `viking://resources/inkflow/<projectId>`（只召回本书的块，不串书）。

为什么不是 peer 子树（P10 的未定项在此关闭）：**OVK 的 `write` 工具文档写明可写范围是 `viking://resources/`、`viking://user/{user_id}/`、`viking://agent/`，而受管子目录 `skills/`、`peers/`、`privacy/`、`sessions/` 是只读的**（`openviking/server/mcp_endpoint.py:863`，本机 ovk 0.4.21 代码级取证）。块写进 `<user>/peers/<peer>/resources/` 会被拒，而「被拒之后降级」会让语义检索在本机永远不可用。因此：

- 写入落在账号级资源树，用 `resources/inkflow/<projectId>/` 做书的隔离；
- **peer 仍然是请求的一部分**：每个请求带 `X-OpenViking-Actor-Peer: <peer>`（ADR-0009 P3 的显式携带），peer 也记在块元数据与账本里，用于诊断与将来的命名空间迁移；
- 这条与 ADR-0009 P5「同路径覆盖」不冲突：URI 由 `projectId + chapterId + blockIndex` 决定，与 peer 无关。

【未验证】本机没有 OVK 在跑（`127.0.0.1:1933` 无监听），E3 的写入是否真的成功、`/api/v1/content/write` 的 `tags` 是否被索引参与过滤，都只做了**代码级取证 + stub 服务**，没有真机实测。

### E4 tombstone 账本放插件私有目录，不放派生索引

`dataDir/semantic/<bookSlug>.json`（`schemaVersion: 1`），记录每章的 `{path, seq, title, contentHash, blocks[], deleted, updatedAt}` 与最近一次重建的统计。

为什么不放 `index/inkflow.db`（自有索引）：

1. **索引是缓存**（ADR-0005）。「这块曾经写过、现在是 tombstone」是**状态**，不是从文件推得出来的事实——章文件已经被删了。放进派生索引，一次重建就把待清理清单清零，`purge` 永远找不到孤儿。
2. 免去 `INDEX_SCHEMA_VERSION` +1 与随之而来的「删库重建」（AGENTS §8 陷阱 5）。0.4.0 B2 有并行单在动索引，少一个共享热点就少一次 rebase 冲突。

代价：账本与书可能不同步（用户手删了账本、或换了机器）。对策：账本缺失 = 当作「从未重建」，`rebuild` 会把所有章的块重写一遍（同路径覆盖，幂等），而不是报错。

`projectId` 由 `inkflow.json` 提供（ADR-0018 D7 由向导写入）；缺失时用 `book-<sha256(目录名) 前 12 位>` **一次性**写进账本并固定下来，之后不再重算（否则改目录名就换命名空间）。

### E5 降级原因是固定词表，不是一个自由文本

`degradedReason` ∈ `disabled` / `no-endpoint` / `no-peer` / `unreachable` / `unauthorized` / `timeout`，另有 `http` 与 `malformed` 只在诊断里出现、不进检索响应（用户能做的动作只有前六个）。词表固定的理由：面板要按它给**可执行的下一步**（「去设置里填端点」/「写 `peer.id`」/「把 OVK 起来」），自由文本会让这句翻译每处各写一份。

判定顺序（先廉价后昂贵，且与用户能修的顺序一致）：`disabled` → `no-endpoint` → `no-peer` → 健康探测（`unreachable` / `unauthorized` / `timeout`）。**任何一步失败都不许 500**：`searchEntries` 仍然返回 FTS5 结果（ADR-0009 P8）。

### E6 超时与凭据的两条硬边界

- 每个 OVK 请求带 `AbortController` 超时（默认 5000 ms；实现上一个可注入的 `timeoutMs`，测试用它把「超时降级」压到 150 ms，避免测试等 5 秒）。超时 → `timeout` 降级，**不重试**（检索是读，用户已经在等）。
- `semanticApiKey` **绝不**出现在：工具回执、面板响应、诊断包（打码为 `[redacted]`）、日志。诊断包只报「是否已设置」。

## 备选与取舍

| 方案 | 优点 | 代价 | 为什么没选 |
|---|---|---|---|
| **读 `~/.openviking/ov.conf` 自动发现端点** | 用户零配置 | 机器级私有文件成为插件输入；换机器/换 profile 漂移；作者两份真相；reader 看不到连的是谁 | 违反 ADR-0018 D1「设置写全局、用户可见」；且 `ov.conf` 里有别人的 API key，读它等于把密钥引入插件的信任边界 |
| **`semanticSearch` 改成嵌套对象** | 字段语义聚在一处 | 形状变更：老读者把对象读成默认 `false`（开关自己关了），`SETTINGS_SCHEMA_VERSION` +1，设置页与既有测试全改 | 追加平铺字段同样表达力，且零迁移（ADR-0018 明确「加字段不需要 bump」） |
| **块写进 `<user>/peers/<peer>/resources/`** | 命名空间与 OVK 记忆一致，天然按 peer 隔离 | 该子树只读（`mcp_endpoint.py:863`），写入被拒 → 语义检索在本机永远不可用 | 让「能用的功能」为了「更好看的命名空间」而不可用，方向反了；隔离改由 URI 前缀承担 |
| **tombstone 记录进派生索引** | 与块记录同库，查询快 | 索引重建即丢失（章文件已删，推不回来）；`purge` 永远空；还要 `INDEX_SCHEMA_VERSION` +1 | 状态不能放缓存里（ADR-0005 的核心区分） |
| **`degradedReason` 用自由文本** | 信息更全 | 面板要按原因给下一步，自由文本只能靠子串匹配，翻译会各写一份 | 固定词表 + 详情另开 `detail` 字段 |
| **失败后自动落盘重试队列（跨进程）** | 断网时不丢作业 | 多一个持久化队列与恢复逻辑；检索是读，用户重搜即可 | 进程内队列 + `stale` 标记已够；跨进程续跑没有需求 |

## 后果

| 收益 | 代价与对策 |
|---|---|
| 端点/凭据在设置页可见可改，改完即时生效（ADR-0018 D2 不缓存） | 换机器要重填端点；文档写明（`docs/user-guide.md` 的「语义检索（可选）」） |
| 块写入只用一条 HTTP 契约，可被 stub 覆盖测试 | 契约是【未验证】的真机行为；OVK 升级改端点时语义检索掉到 FTS5，不影响数据与写作 |
| tombstone 与清理清单不会被重建抹掉 | 账本与书可能不同步；缺失即当「从未重建」，幂等重写 |
| 降级词表固定，面板能给可执行下一步 | 新增原因要同时改词表、面板文案、测试 |

## 验证

- `tests/ovk.test.js`：peer 六态（local 赢、team 兜底、`version:2` 忽略、>64 KiB 忽略、非 ASCII 拒绝、只有 `peer.source` 不派生）；分块（块上限/重叠、空章 0 块）；URI 模板与 `contentHash`；**grep 守卫**：`src/host/ovk*.ts` 不出现 `ov.conf` / `ovcli.conf`。
- `tests/ovk.stub.test.js`（`node:http` 起的 stub，零依赖）：`/health` 200/200-非 JSON/401/挂住 + `timeoutMs` 注入；`/api/v1/search/find` 的请求体字段与 actor peer 头；`/api/v1/content/write` 的同路径覆盖；`DELETE /api/v1/fs` 只出现在 purge 路径。
- `tests/ovk-search.test.js`：六种降级各一条，六种下 `searchEntries`/`searchWithSemantic` 仍返回 FTS5 结果且**不抛错**；stub 200 时 `searchBackend='ovk'`、定位回跳（chapterId + 字符区间 → 回文件读正文）。
- `tests/ovk-ledger.test.js`：幂等（同章重建两次块数不变、URI 相同）、改章后旧块被覆盖且旧文不命中、删章变 tombstone 且召回过滤、`forget` 只在 purge 路径出现（grep 断言）。
- `tests/settings.test.js`：`semanticEndpoint`/`semanticApiKey` 的缺失/类型错/空白回退；诊断包对 key 打码。
- 未验证项：真机 OVK 的写入/召回（本机 `127.0.0.1:1933` 无服务）、面板真实观感（需重启宿主）。
