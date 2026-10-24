# ADR-0020：语义后端的连接来自插件设置，不去挖别的工具的配置文件

- 状态：已采纳（2026-10-24）
- 日期：2026-10-24
- 关系：实施 [ADR-0009](0009-ovk-semantic-search.md) 的 P1–P3/P8；沿用 [ADR-0018](0018-settings-backup-diagnostics.md) D1/D2（设置写全局、读设置永不抛）；遵守 [ADR-0012](0012-plugin-private-state-dir.md)（插件私有目录）
- 影响：`src/host/ovk*.ts`、`src/host/settings.ts`、`src/host/search.ts`、`src/host/hub-settings.ts`、[S-02 architecture](../specs/architecture.md) §6、[docs/user-guide.md](../../docs/user-guide.md)

## 背景

[ADR-0009](0009-ovk-semantic-search.md) 把语义检索定成「复用 OpenViking、不自研 embedding」，并写清了 peer 从**工作区配置**只读（P2）、每次请求显式带 actor peer（P3）、缺能力就降级 fts5（P8）。但它没有回答一个实现问题：**插件从哪里知道 OVK 服务在哪、用什么凭据？**

现状（本机实测，2026-10-24）：

- OVK 的数据面是 **HTTP**：`@openviking/dsh-memory-plugin` 的 `client.mjs` 通过 `createOvHttp()` 打 `/health` 与 `/api/v1/…`，头是 `Authorization: Bearer <apiKey>` + `X-OpenViking-Actor-Peer: <peer>`，base URL 来自配置里的 `baseUrl`/`endpoint`（`@openviking/dsh-memory-plugin` 的 `shared/ov-http.mjs`，本机 profile 里可读）。也就是说**用 `fetch` 就能接**，不需要任何依赖。
- 这套连接信息由 OVK 自己的解析链给出：`~/.openviking/ov.conf` 的 `dsh` 段 + `OPENVIKING_*` 环境变量 + `~/.openviking/ovcli.conf` 的 `plugin` 段（那份 `resolveConfig()` 就是它的规则）。
- 本机当前**没有 OVK 服务在跑**（`127.0.0.1:1933`/`7801` 均无响应；`ov.conf` 里只有一个 embedding 端点 `127.0.0.1:11435/v1`，那是 OVK 自己用的）。

ADR-0009 还留了两处**实现空档**，本 ADR 一并关闭（见「补充决策」）：块写进 OVK 的哪个命名空间、以及「已删章」的 tombstone 状态记在哪里。

## 决策

**插件不解析 OVK 的配置文件，也不抄它的解析链。连接信息来自插件自己的设置。**

| 项 | 决定 |
|---|---|
| 端点与凭据 | `$DSH_HOME/inkflow/settings.json` 的三个字段：`semanticSearch: boolean`（开关）、`semanticEndpoint: string`（如 `http://127.0.0.1:1933`，只收 http/https，尾斜杠剥掉）、`semanticApiKey?: string`（可选，作为 `Authorization: Bearer` 发送）。**只读设置**，环境变量不参与（一个进程级环境变量不该决定一本书的检索行为） |
| 字段形状 | **平铺追加**，不是嵌套对象（实现时对原措辞的修正）：0.4.0 B1（#42）已把 `semanticSearch` 作为 **boolean** 落地并被设置页与既有测试消费；改成 `{enabled,endpoint,apiKey}` 是一次形状变更（`SETTINGS_SCHEMA_VERSION` 该 +1，老读者会把对象读成默认 `false`，用户看到「开关自己关了」）。平铺加字段是**追加**：老读者忽略未知键、新读者给缺失项默认值（ADR-0018 D2「加字段不需要 bump」） |
| peer | 仍按 ADR-0009 P2：只读 `<工作区根>/.openviking/config.local.json` → `.openviking/config.json` 的 `peer.id`；**不代写**、不派生模板（roadmap X-21）。`version` 必须为 1、文件 ≤ 64 KiB、`peer.id` 只允许 ASCII（否则服务端会静默删成空串，比报错更糟） |
| 缺什么就降级什么 | 没开关、没 `endpoint`、没 `peer.id`、连不上、超时、401/403 → 一律 `searchBackend: 'fts5'` + `degradedReason`（取值固定：`disabled` / `no-endpoint` / `no-peer` / `unreachable` / `unauthorized` / `timeout`）。**不阻塞任何写作功能**（X-16 的「后端失败不许 500」） |
| 为什么不去读 `ov.conf` | 那是 **OVK 的**私有配置，含 VLM 的 `api_key` 与模型选择；插件读它等于把别人的凭据面搬进自己的代码，而且 OVK 一改字段就静默失效（[hard-constraints](../constitution/hard-constraints.md) 的「不猜别人的契约」）。ADR-0009 P2 拒绝自己实现 `peer.source` 的模板派生，是同一个理由 |
| 为什么不用环境变量 | DSH 会 scrub 掉形似凭据的环境变量（`X-API-Key` 之类），env 在桌面版里来源不稳定；而且「这台机器的环境变量」不是「这本书的检索设置」 |
| 凭据不外流 | `semanticApiKey` 是一个秘密：工具回执、面板响应、诊断包**都只报「已设置」**（`redactSettings()` 是唯一出站点；诊断包写 `[redacted]`，ADR-0018 D5） |

## 补充决策（实施 ADR-0009 时补齐的两处空档）

### S1 块写进 `viking://resources/` 下的项目子树，不写 peer 子树

块 URI 固定为：

```
viking://resources/inkflow/<projectId>/chapters/<chapterId>/<blockIndex>.md
```

召回时 `target_uri` 取 `viking://resources/inkflow/<projectId>`（只召回本书的块，不串书）。

为什么不是 peer 子树（ADR-0009 P10 的未定项在此关闭）：**OVK 的 `write` 工具文档写明可写范围是 `viking://resources/`、`viking://user/{user_id}/`、`viking://agent/`，而受管子目录 `skills/`、`peers/`、`privacy/`、`sessions/` 是只读的**（`openviking/server/mcp_endpoint.py:863`，本机 ovk 0.4.21 代码级取证）。块写进 `<user>/peers/<peer>/resources/` 会被拒，而「被拒之后降级」会让语义检索在本机**永远不可用**。因此：

- 写入落在账号级资源树，用 `resources/inkflow/<projectId>/` 做书的隔离；
- **peer 仍然是请求的一部分**：每个请求带 `X-OpenViking-Actor-Peer: <peer>`（ADR-0009 P3），peer 也记在块 tags 与账本里，用于诊断；
- 与 P5「同路径覆盖」不冲突：URI 由 `projectId + chapterId + blockIndex` 决定，与 peer 无关。

`projectId` 由 `inkflow.json` 提供（ADR-0018 D7）；缺失时用 `book-<sha256(目录名) 前 12 位>` **一次性**写进账本并固定，之后不再重算（否则改目录名就换命名空间）。

【未验证】本机没有 OVK 在跑，S1 的写入是否真的成功、`/api/v1/content/write` 的 `tags` 是否参与过滤，只做了**代码级取证 + stub 服务**。

### S2 tombstone 账本放插件私有目录，不放派生索引

`dataDir/semantic/<bookSlug>.json`（`schemaVersion: 1`），记录每章的 `{path, seq, title, contentHash, blocks[], deleted, updatedAt}` 与最近一次重建的统计。

为什么不放 `index/inkflow.db`：

1. **索引是缓存**（ADR-0005）。「这块曾经写过、现在是 tombstone」是**状态**，不是从文件推得出来的事实——章文件已经被删了。放进派生索引，一次重建就把待清理清单清零，`purge` 永远找不到孤儿。
2. 免去 `INDEX_SCHEMA_VERSION` +1 与随之而来的「删库重建」（AGENTS §8 陷阱 5），也少一个并行开发的共享热点。

代价：账本与书可能不同步（用户手删了账本、或换了机器）。对策：账本缺失 = 当作「从未重建」，`rebuild` 把所有章的块重写一遍（同路径覆盖，幂等），而不是报错。

## 备选与取舍

| 方案 | 优点 | 代价 | 为什么没选 |
|---|---|---|---|
| 读 `~/.openviking/ov.conf` 的 `dsh` 段取 endpoint/apiKey | 用户配一次，处处生效 | 解析别人的配置格式；把 OVK 的 VLM `api_key` 面拉进来；OVK 改结构即失效 | 与 ADR-0009 P2「不重写 OVK 的解析规则」直接冲突 |
| 读 `OPENVIKING_*` 环境变量 | 零配置 | DSH scrub 凭据类 env；env 是进程级，不随书走；桌面版来源不稳 | 行为不可解释 |
| 固定 `http://127.0.0.1:7801` | 最简单 | 端口不可配；换机/换端口即失效；测试无法指向 stub | 硬编码不可接受 |
| `semanticSearch` 存成嵌套对象 `{enabled,endpoint,apiKey}` | 字段语义聚在一处 | 形状变更：老读者把对象读成默认 `false`（开关自己关了），`SETTINGS_SCHEMA_VERSION` +1，设置页与既有测试全改 | 平铺追加表达力相同，且零迁移（ADR-0018 明确「加字段不需要 bump」） |
| **设置里显式给 endpoint/apiKey**（选中） | 可解释、可测试（测试指向本地 stub 服务）、与 ADR-0018 D1「设置写全局」一致 | 用户要手填一次；`ov.conf` 里已有的信息不共享 | — |
| 块写进 `<user>/peers/<peer>/resources/` | 命名空间与 OVK 记忆一致，天然按 peer 隔离 | 该子树只读（`mcp_endpoint.py:863`），写入被拒 → 语义检索在本机永远不可用 | 让「能用的功能」为了「更整齐的命名空间」而不可用，方向反了；隔离改由 URI 前缀承担 |
| tombstone 记录进派生索引 | 与块记录同库，查询快 | 索引重建即丢失（章文件已删，推不回来）；`purge` 永远空；还要 `INDEX_SCHEMA_VERSION` +1 | 状态不能放缓存里（ADR-0005 的核心区分） |

## 后果

| 收益 | 代价与对策 |
|---|---|
| 语义后端的连接是**可解释的**：面板显示「已启用/未配置端点/无 peer/连不上」，不再有"配了没生效"的谜 | 用户要手填 endpoint；对策：设置页给一行示例，并在诊断包里带上「是否配置/是否可达」 |
| 测试可以指向本地 stub HTTP 服务，把「命中/降级/超时」三态都钉住 | stub 服务要写在测试里（`node:http` 起一个临时端口，零依赖） |
| 不碰别人的凭据面 | 共享库 peer（`dsh-inkflow-common-shared`）仍按 ADR-0009 P4 固定，与这条决策无关 |
| 块写入只有一条 HTTP 契约，且能按书隔离 | URI 模板是【未验证】的真机行为；OVK 升级改端点时语义检索掉到 FTS5，不影响数据与写作 |
| tombstone 与清理清单不会被重建抹掉 | 账本与书可能不同步；缺失即当「从未重建」，幂等重写 |

## 验证

- `tests/ovk.test.js`：无开关 → `disabled`；有开关无 `endpoint` → `no-endpoint`；无 peer → `no-peer`；peer 六态（local 赢、team 兜底、`version:2` 忽略、>64 KiB 忽略、非 ASCII 拒绝、只有 `peer.source` 不派生）；分块（块上限/重叠、空章 0 块、超长段落硬切）；URI 模板与 `contentHash`；**grep 守卫**：`src/host/ovk*.ts` 不出现 `ov.conf` / `ovcli.conf`。
- `tests/ovk.stub.test.js`（`node:http` 起的 stub，零依赖）：六种降级各一条 + 「2xx 但非 JSON」；stub 200 → `searchBackend='ovk'` 且定位回跳正确；幂等（同章重建两次块数不变、URI 不变、第二次 0 写调用）；改章后旧文不命中；删章变 tombstone 且**召回过滤**、`forget` 调用数 = 0；purge 列表/确认/首条失败即停；首建 >200 章要 `confirm`；密钥不出现在任何回执里。
- **`forget` 只出现在 purge 路径**：`ovk.test.js` 的 grep 守卫断言 `src/host/ovk*.ts` 里只有 `ovk.ts`（定义）与 `ovk-status.ts`（purge）提到它，且章节/回收站/替换/导入四条写路径一次都不提。
- 真机 E2E（启动 OVK 后）：改章 → 旧块覆盖为 tombstone → 召回不含旧文；首建耗时与调用量在面板可见。**本机当前没有 OVK 服务，这一条标【未验证】。**
