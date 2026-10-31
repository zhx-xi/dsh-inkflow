# 子智能体委派：设置三字段、三态文案、三层落地与 `GET /hub/models`

> **依据**：[ADR-0018](../../adrs/0018-settings-backup-diagnostics.md) D1/D2（设置不属于任何一本书；读永不抛错）、roadmap X-19 / X-20（插件级设置、书库设置页）/ X-26（插件没有模型客户端）。
> **依赖**：[conventions.md](../conventions.md) §6.2.1（书库通道的守卫与路由表）、[architecture.md](../architecture.md) §6（`delegation.ts` / `hub-models.ts` / `preset.ts` 的边界）。
> **状态**：活跃。本文件是 [conventions.md](../conventions.md) §6.2.1 中 `/hub/models` 那一行与设置三字段的细则（主文件已到 800 行上限，按 S6 下沉）。

## 1. 概述

作者要的是**分档用工**：大纲 / 细纲 / 正文用好模型，审计与设定入库留在会话里。本插件落这件事的方式只有一种——**声明策略**，不执行策略。

三句真话，写在这里也写在用户手册里：

1. **插件不代你调模型**。本插件零运行时依赖、没有模型客户端（X-26），所以「开启子智能体」不会产生任何模型调用；它只把「生成类任务应当交给哪个模型」写成会话能读到的一句话。
2. **改设置只影响新开的会话**。会话能用的工具集来自它启动时绑定的 preset revision；开关决定要不要挂委派那一行，所以开关变了就要重注册 —— 在跑的会话保持它自己那份。
3. **插件无法证明 agent 真的委派了**。子智能体不落书，章节仍由会话自己写；插件没有观察点，也没有任何字段声称「已委派」。

## 2. 数据形状（`settings.json`，插件级）

| 字段 | 类型 | 缺省 | 语义 |
|---|---|---|---|
| `subagentEnabled` | boolean | `false` | 是否把生成类任务交给子智能体。**关闭 = 今天的默认行为** |
| `subagentProvider` | string? | **键缺席** | 派发用的 provider 路由名 |
| `subagentModel` | string? | **键缺席** | 派发用的模型 id |

三条形状规则：

- 两个可选键**缺席**而不是空串（与 `sharedRoot` / `authorName` 同口径）：`null` 清空、空串视作清空并**不写回文件**。
- `provider` 有值而 `model` 缺省 ⇒ **未配置**。只填 provider 不构成一条能派发的路由，界面提示「还差模型」，注入段与 `inkflow_batch_take` 都按未配置处理、不派发。
- 加字段**不 bump** `SETTINGS_SCHEMA_VERSION`（仍是 1）：旧读者按白名单读、新读者给缺失字段默认值，两者都不会读错。

**手改出来的非法值**（`"   "`、`42`、内含空格的 route）不抛错：归一为「未配置」，逐字段进 `SettingsRead.notices`，并由它们拼出诊断包里的那条 `warn: SETTINGS_FIELD_IGNORED`。判据只认**形状**（非空、无空白、长度 ≤ 200、provider 限路由名字符）；「这个 provider 在本机是否存在」属于本机模型目录，由设置页在列得到目录时提示，不进入读语义（读语义不碰 Host 服务）。

## 3. 三态文案（唯一的措辞来源：`src/host/delegation.ts` 的 `describeDelegation`）

| 状态 | 判定 | 「写作方式」那一句 | 注入段随后说什么 |
|---|---|---|---|
| `off` | `subagentEnabled !== true` | 写作方式：自己写（未开启子智能体） | 本章由你自己写；不要委派。 |
| `delegated` | 开启且 `model` 有值 | 写作方式：委派子智能体（`provider/model`，无 provider 时只写 model） | 生成类任务（大纲 / 细纲 / 正文）必须委派给子智能体，provider/model 写明；审计与设定入库留在本会话。 |
| `unconfigured` | 开启且 `model` 缺省 | 写作方式：未配置模型 —— 先问作者要哪个模型，再委派 | 动手前先用 `ask_user_question` 让作者从模型目录里选，再派发；不要自己挑一个。只填了 provider 时点名这件事。作者选定的模型只用于本次会话：不要调用 `inkflow_settings_update` 写回，也不要当作默认值。 |

**一个函数、两个消费者**：`describeDelegation` 同时产出 `sentence`（工具回复那一行）与 `policy`（注入段正文，第一行就是 `sentence`）。两处不得各写一套 —— 测试按「同一字符串出现在两处」断言，而不是按两段看起来像的话。

**人在回路（HITL）**：模型留空时由 agent 现场问作者，选择**只记这次会话**，不落库、不写回设置。设置页不提供「设为默认」按钮；agent 也不得自行 `inkflow_settings_update`。判据是 `settings.json` 在「记住之后」**字节不变**（有测试），以及 `delegation.ts` 不持有写入口（有源码守卫）。

## 4. 三层落地（静态与动态分开）

| 层 | 何时生效 | 落点 |
|---|---|---|
| 动态 · 策略文本 | 每次请求组装（即时） | `systemPrompt` 段 `inkflow:delegation`（order 121，text 是 thunk，每次读 `settings.json`）；`delegation.ts` 的 `registerDelegationSection`，降级姿势与 `prompt.ts` 同构 |
| 动态 · 工具回复 | 每次调用 | `inkflow_batch_take` 的回复多一行「写作方式：…」（值里带 `delegation` 块，渲染取 `sentence`） |
| 静态 · 工具行 | **新会话** | `inkflow-writing` preset 在开启时挂 `@deepseek-ai/dsh-tool-workflow`；开关一变就重注册（`registerWritingPreset` 返回的 `revise`），旧 revision 保留给在跑的会话 |

关闭时不挂 workflow 行，preset 描述也不再写「不含委派」。开关以外的设置（provider / model）**不重注册** —— 那两件只改文案，而动一次注册会重载整份组合。

## 5. `GET /inkflow/internal/hub/models`

| 项 | 值 |
|---|---|
| 方法 | 只 `GET`；其他动词 405 + `Allow: GET` |
| 参数 | **无**（不读 query；未声明的键 400 `UNKNOWN_QUERY_PARAM`），不接受 `book` 锚点 |
| 成功值 | `{ok:true,value:{providers:[{id,name,models:[{id,name,description?}]}], timeoutMs}}`；顺序按适配器注册顺序 |
| 失败 | HTTP **200** + `{ok:false,error:{code,message,hint}}`，`code` ∈ `LLM_UNAVAILABLE`（宿主没有 `llm` 服务）/ `LLM_TIMEOUT`（整次超过截止）/ `LLM_FAILED`（provider 列表本身读不出来） |
| 截止 | 整次收集共用 **2000 ms**（`MODELS_TIMEOUT_MS`，可注入以便测试）；超时**不返回半个目录** |
| 单个 provider 失败 | 只把该 provider 的 `models` 留空，目录其余部分照常返回；**适配器错误文本不转发**（它可能带 URL 与凭据） |
| 只读纪律 | 不落库、不写设置、不碰任何书；`listProviders` / `listModels` 的形状里没有凭据字段，本路由也只读这两个方法 |
| 降级 | 页面对三种失败一视同仁：provider / model 退化为**手填输入框** + 灰字原因，**不挡保存** —— 「列不出模型」不等于「不能配置模型」 |

## 6. 边界与错误

- 三字段都是**插件级**，不是每本书（D1）：写进书里会被作者的 git 提交带到别的机器上。
- 插件不接管会话自己的模型（那是 DSH 的 `/model`），也不承诺「审计自动跑在便宜模型上」——那句话只在「主会话保持便宜模型、生成类委派强模型」时才成立。
- 委派行缺失（关闭、或 profile 没有 `tool-workflow`）时，agent 只能自己写：这是**允许**的降级，不是错误。
- 工具面只有 `inkflow_settings_get/update` 读写这三字段；`inkflow_batch_take` 只**自述**，不改变作业状态机。

## 7. 非功能

| 项 | 一行 |
|---|---|
| 规模 | provider / model 数由本机 DSH 决定；单次最多遍历 `listProviders()` 的全集 |
| 延迟 | 设置页一次 `GET /hub/models`；截止 2 s，超时即降级（不重试） |
| 降级 | 服务缺失 / 超时 / 单 provider 失败三种各有确定答案，设置页三态都可用 |

## 8. 验收判据（对应测试）

- `tests/delegation.test.js`：三态文案、两处共用同一句、无隐式默认模型、thunk 每装配重读、preset 条件行 + 重注册、HITL 字节不变、`delegation.ts` 不持有写入口。
- `tests/settings.test.js`：三字段往返、`null` 清空留空键、手改非法值 → 未配置 + `notices` + 诊断包 `warn`、`schemaVersion` 不变。
- `tests/hub-settings.test.js`：`/hub/models` 的三条降级、单 provider 失败、截止、`/hub/settings` 载荷带 `delegation` 与 `notices`。
- `tests/settings-panel.test.js`：表单 ↔ wire、`还差模型`、只动开关才算改动。
- `tests/batch.test.js`：`inkflow_batch_take` 的回复里那一行。

## 9. 不在范围内

- 每本书的模型设置（D1）。
- 第二档「审计 / 抽取专用模型」（另见长期观察单）。
- 观察或验证 agent 是否真的派发了子智能体（没有观察点）。

## 10. 验证命令

```
pnpm.cmd --config.verify-deps-before-run=false run check
```
