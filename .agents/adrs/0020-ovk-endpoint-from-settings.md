# ADR-0020：语义后端的连接来自插件设置，不去挖别的工具的配置文件

- 状态：已采纳（2026-10-24）
- 日期：2026-10-24

## 背景

[ADR-0009](0009-ovk-semantic-search.md) 把语义检索定成「复用 OpenViking、不自研 embedding」，并写清了 peer 从**工作区配置**只读（P2）、每次请求显式带 actor peer（P3）、缺能力就降级 fts5（P8）。但它没有回答一个实现问题：**插件从哪里知道 OVK 服务在哪、用什么凭据？**

现状（本机实测，2026-10-24）：

- OVK 的数据面是 **HTTP**：`@openviking/dsh-memory-plugin` 的 `client.mjs` 通过 `createOvHttp()` 打 `/health` 与 `/api/v1/…`，头是 `Authorization: Bearer <apiKey>` + `X-OpenViking-Actor-Peer: <peer>`，base URL 来自配置里的 `baseUrl`/`endpoint`（`@openviking/dsh-memory-plugin` 的 `shared/ov-http.mjs`，本机 profile 里可读）。也就是说**用 `fetch` 就能接**，不需要任何依赖。
- 这套连接信息由 OVK 自己的解析链给出：`~/.openviking/ov.conf` 的 `dsh` 段 + `OPENVIKING_*` 环境变量 + `~/.openviking/ovcli.conf` 的 `plugin` 段（那份 `resolveConfig()` 就是它的规则）。
- 本机当前**没有 OVK 服务在跑**（`127.0.0.1:7801` 无响应；`ov.conf` 里只有一个 embedding 端点 `127.0.0.1:11435/v1`，那是 OVK 自己用的）。

## 决策

**插件不解析 OVK 的配置文件，也不抄它的解析链。连接信息来自插件自己的设置。**

| 项 | 决定 |
|---|---|
| 端点与凭据 | `$DSH_HOME/inkflow/settings.json` 的 `semanticSearch` 块：`enabled: boolean`、`endpoint: string`（如 `http://127.0.0.1:7801`）、`apiKey?: string`。**只读设置**，环境变量不参与（一个进程级环境变量不该决定一本书的检索行为） |
| peer | 仍按 ADR-0009 P2：只读 `<工作区根>/.openviking/config.local.json` → `.openviking/config.json` 的 `peer.id`；**不代写**、不派生模板（roadmap X-21） |
| 缺什么就降级什么 | 没 `enabled`、没 `endpoint`、没 `peer.id`、连不上、超时、401/403 → 一律 `searchBackend: 'fts5'` + `degradedReason`（取值固定：`disabled` / `no-endpoint` / `no-peer` / `unreachable` / `unauthorized` / `timeout`）。**不阻塞任何写作功能**（X-16 的「后端失败不许 500」） |
| 为什么不去读 `ov.conf` | 那是 **OVK 的**私有配置，含 VLM 的 `api_key` 与模型选择；插件读它等于把别人的凭据面搬进自己的代码，而且 OVK 一改字段就静默失效（[hard-constraints](../constitution/hard-constraints.md) 的「不猜别人的契约」）。ADR-0009 P2 拒绝自己实现 `peer.source` 的模板派生，是同一个理由 |
| 为什么不用环境变量 | DSH 会 scrub 掉形似凭据的环境变量（`X-API-Key` 之类），env 在桌面版里来源不稳定；而且「这台机器的环境变量」不是「这本书的检索设置」 |

## 备选与取舍

| 方案 | 优点 | 代价 | 为什么没选 |
|---|---|---|---|
| 读 `~/.openviking/ov.conf` 的 `dsh` 段取 endpoint/apiKey | 用户配一次，处处生效 | 解析别人的配置格式；把 OVK 的 VLM `api_key` 面拉进来；OVK 改结构即失效 | 与 ADR-0009 P2「不重写 OVK 的解析规则」直接冲突 |
| 读 `OPENVIKING_*` 环境变量 | 零配置 | DSH scrub 凭据类 env；env 是进程级，不随书走；桌面版来源不稳 | 行为不可解释 |
| 固定 `http://127.0.0.1:7801` | 最简单 | 端口不可配；换机/换端口即失效；测试无法指向 stub | 硬编码不可接受 |
| **设置里显式给 endpoint/apiKey**（选中） | 可解释、可测试（测试指向本地 stub 服务）、与 ADR-0018 D1「设置写全局」一致 | 用户要手填一次；`ov.conf` 里已有的信息不共享 | — |

## 后果

| 收益 | 代价与对策 |
|---|---|
| 语义后端的连接是**可解释的**：面板显示「已启用/未配置端点/无 peer/连不上」，不再有"配了没生效"的谜 | 用户要手填 endpoint；对策：设置页给一行示例，并在诊断包里带上「是否配置/是否可达」 |
| 测试可以指向本地 stub HTTP 服务，把「命中/降级/超时」三态都钉住 | stub 服务要写在测试里（`node:http` 起一个临时端口，零依赖） |
| 不碰别人的凭据面 | 共享库 peer（`dsh-inkflow-common-shared`）仍按 ADR-0009 P4 固定，与这条决策无关 |

## 验证

- `tests/ovk.test.js`：无 `enabled` → `disabled`；有 `enabled` 无 `endpoint` → `no-endpoint`；无 peer → `no-peer`；stub 服务 200 → `searchBackend='ovk'`；stub 服务 401 → `unauthorized`；stub 服务不响应 → `timeout`（超时阈值可注入）；六种降级下 `searchEntries` 仍返回 fts5 结果。
- 结构守卫：`src/host/ovk.ts` 里**不出现** `ov.conf` / `ovcli.conf` 字样（grep 式断言）。
- 真机 E2E（启动 OVK 后）：改章 → 旧块覆盖为 tombstone → 召回不含旧文；首建耗时与调用量在面板可见。**本机当前没有 OVK 服务，这一条标【未验证】，验证脚本随 PR 交付。**
