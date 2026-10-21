# ADR-0004：面板 HTTP 接口只绑 loopback 并自校验

- 状态：已采纳（**部分条款被 [ADR-0008](0008-panel-data-channel.md) 取代/收窄**，见下）
- 日期：2026-10-21
- 取代与收窄（2026-10-21，[ADR-0008](0008-panel-data-channel.md)；按 A3 只改头部，正文保留原文作证据）：
  - **继续有效**：决策 1（`Host` 必须 loopback）、决策 2（`Origin` 校验）、决策 5（不发 CORS 头）、决策 6（`no-store` / `nosniff` / JSON 信封）、决策 7（密钥永不下发浏览器），以及「本机其他进程不在威胁模型内」的边界。
  - **被收窄**：决策 3（「P0 仅 GET」）→ 0008 D3 改为**逐路由声明方法**（内部通道含写路由）；决策 4（写接口要求 `Content-Type: application/json`）→ 0008 D3 另加"写路由必须带 loopback `Origin`"的同源校验。
  - **被取代**：「对外接口」这一层定位与 `/inkflow/api/*` 路径命名 → 0008 D2/D3：路由改为 `/inkflow/internal/*`，明确**不是 API**（不版本化、不对外文档化、无兼容承诺），旧 `/inkflow/api/*` 一律 404。正文「后果」里"只能用同源相对路径 fetch（`/inkflow/api/...`）"的路径串按此改写为 `/inkflow/internal/...`。

## 背景

DSH 的 `ctx.webServer` 是浏览器 HTTP 载体，**没有鉴权**。工作台页面需要读本地库（健康状态、项目列表；P1 起还有章节、设定等），所以插件必须自曝一个 HTTP 前缀路由。

威胁模型（都是本机场景的真实威胁）：

1. **DNS rebinding**：用户浏览器打开恶意页面，该页面把域名解析到 127.0.0.1，然后向 `http://127.0.0.1:<port>/inkflow/...` 发请求。浏览器认为同源/可发（简单请求），插件若不校验就中招。
2. **跨站 fetch**：别的站点直接 fetch 本机端口（读不到响应，但可以触发写操作）。
3. **本机其他进程**：严格说无法防御（本机进程可伪造任何头），此层不承担该威胁。

## 决策

`/inkflow` 前缀路由统一 fail-closed：

1. `Host` 头必须匹配 `^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$`，否则 403 `forbidden-host`。
2. `Origin` 头存在时必须匹配 loopback origin，否则 403 `forbidden-origin`。
3. 方法白名单：P0 仅 GET，其余 405。
4. 写接口（P1+）额外要求 `Content-Type: application/json`，防止 HTML form 直接投递。
5. **不发任何 CORS 头**：浏览器默认拒绝跨源读取响应。
6. 响应统一 `Cache-Control: no-store`、`X-Content-Type-Options: nosniff`，JSON 信封 `{ok: true, value}` / `{ok: false, error: {code}}`。
7. 密钥（如未来接旧内核的 `X-InkFlow-Token`）**永不下发浏览器**，只在 Host 侧使用。

## 后果

- 工作台页面只能用同源相对路径 fetch（`/inkflow/api/...`），不能用别的 host。
- 若用户通过非 loopback 地址访问 DSH（例如局域网 IP），路由会 403——这是有意为之。
- 无法防御本机恶意进程（无沙箱的 DSH 插件本身也不防御这一层）。

## 验证

P0 契约测试覆盖四种情况：正常 GET 200、伪造 Host 403、跨站 Origin 403、非 GET 405。见 `tests/p0.test.js`「http route: loopback only, read-only, json envelopes」。
