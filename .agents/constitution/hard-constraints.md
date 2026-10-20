# DSH 宿主硬约束（Hard Constraints）

> 这些不是编码风格，而是**实测出来的宿主事实**：违反时通常**静默失败**（不报错、界面无提示、重启后才发现）。
> 每条给出「事实 / 判据 / 违反后果」。宿主版本：DSH `0.2.1-rc.2`（Electron 44.7.0，Node 24）。

## H1 插件 API 处于 rc 期

- **事实**：只保证 `ctx.*` 公共面；`client` 侧内部包明示「change without notice」。
- **判据**：插件代码里 `grep "@deepseek-ai/"` 只应出现在 `package.json` 的 `peerDependencies`/`devDependencies` 里，不应出现在 `src/**` 的运行时 import。
- **后果**：DSH 小版本升级即可能白屏或启动失败。

## H2 `cordis.patch.yml` 新增行必须在 `- insert:` 下

- **事实**：带 `id` 但无 `insert:` 的条目只用于**覆盖已存在的行**；目标 id 不存在时整条被静默丢弃（只进 loader logger，桌面版不落盘）。
- **判据**：`grep -n "^- \?id:" cordis.patch.yml` 若无 `insert:` 父级，就是覆盖语义。
- **后果**：插件「装上了」但完全不生效，且没有任何可见错误。

## H3 改 `lib/` 必须重启 DSH

- **事实**：HMR 只对**新装** bundle 生效；修改已加载插件的 `lib/` 不会热替换，旧 generation 会继续跑。
- **判据**：改完代码后调用新工具，若行为/工具表未变即为旧 generation。
- **后果**：你以为在测新代码，其实在测旧的。

## H4 Client 半是预构建产物

- **事实**：浏览器侧模块由宿主提供 `require`，插件必须自带 `lib/client.js`（loader factory 格式）。
- **判据**：`lib/client.js` 首行为 `window.__ModuleLoader__.load({`，末行 `return module.exports; } });`。
- **后果**：格式不对 → 面板不出现，控制台报 slot 相关错误。

## H5 UI 只能用 Slot 注册

- **事实**：禁止 iframe 嵌自有页面、禁止 `document.body` 挂第二个应用、禁止 `require` 宿主 Client 包（`dsh-client-ui-primitives` 等）。
- **判据**：`grep -n "iframe\|document.body.append" src/client/` 应为空。
- **后果**：主题/明暗/本地化失效，或随宿主升级直接崩溃。

## H6 禁止向 session log append 新 type 的事件

- **事实**：读取方只接受带 `ignorable: true` 的未知事件，而在线 `Session.append()` 无法设置该标记。
- **后果**：**会话会打不开**（重开会失败）。草稿/运行记录一律放插件自己的存储。

## H7 插件无沙箱

- **事实**：Host 代码以用户权限跑在宿主进程里，装了就信。
- **判据**：所有外部输入（模型参数、浏览器请求、文件内容）都要校验。
- **后果**：一个路径拼接错误就是任意文件读写。

## H8 HTTP 路由零鉴权

- **事实**：`ctx.webServer` 是浏览器 HTTP 载体，不带 cookie/会话鉴权。
- **判据**：路由 handler 必须校验 `Host` 是 loopback；`Origin` 存在时必须是 loopback；只允许白名单方法；不发 CORS 头。
- **后果**：任意网页可借 DNS rebinding 读写本机作品。

## H9 `engines.dsh` 决定能否安装

- **事实**：`package.json` 的 `engines.dsh`（或 DSH peer 依赖）不满足时，安装/激活会被版本闸门拒绝。
- **判据**：`package.json` 的 `engines.dsh` 与实际宿主版本比对。
- **后果**：用户装不上，或装上后激活失败。

## H10 派生索引不做数据库迁移

- **事实**（本项目决策，[ADR-0005](../adrs/0005-files-first-with-derived-index.md)）：索引是缓存，schema 版本不符就**删库重建**。
- **判据**：`grep -n "ALTER TABLE" src/host/indexer.ts` 应为空。
- **后果**：一旦开始写迁移，就把「升级不破坏存量项目」这个卖点丢掉。

## H11 Windows 文件的两个坑

- **BOM**：PowerShell `Set-Content -Encoding utf8` 会写 UTF-8 BOM；`JSON.parse` 会失败。读用户文件前必须剥 BOM。
- **行尾**：仓库用 `.gitattributes` 固定 LF；不要提交 CRLF 版本文件。
- **判据**：`grep -rn "\uFEFF" src/` 为空；`git status` 无「LF will be replaced by CRLF」的新增噪音。
- **后果**：项目被判为无效（曾真实发生：样例项目因 BOM 无法识别）。
