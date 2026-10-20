# 项目章程（Constitution）

> **地位**：本项目最高依据。与任何 spec / ADR / 文档冲突时，以本章程为准；确需突破时先改本章程（并说明理由），再改其他文档。
> **适用对象**：所有 AI 编码会话与人类贡献者。

## 一、核心原则

| # | 原则 | 含义 | 可检验的判据 |
|---|---|---|---|
| P1 | **一个插件，端到端** | 用户装一个插件就能完成长篇创作全流程；不拆多插件、不依赖第三方插件拼装 | 功能清单里没有「需要另装 X 才能用」的条目 |
| P2 | **文件即真相** | 作品是可读的 Markdown/JSON，放在用户自己的 git 仓库里；索引/缓存随删随建 | 删掉所有派生物后，作品内容零丢失 |
| P3 | **约定大于配置** | 目录名、文件名、门禁都靠固定约定自证；不为「万一」加配置项 | 新增一个配置项必须有「无约定可用」的理由 |
| P4 | **复用宿主，不重造** | Agent 循环、对话、skills、记忆、模型配置都用宿主能力 | 没有自研 Chat UI / 编排引擎 / 模型客户端 |
| P5 | **可验证** | 结论分「已验证 / 未验证」；未验证的不得写成已通过 | 每条结论能指到复跑命令或证据文件 |
| P6 | **数据属于用户** | 本地优先；不静默覆盖；可 git 回滚；不把正文/密钥写到公共位置 | 任何覆盖性写入都可被 `git revert` |

## 二、技术约束

1. **语言**：纯 TypeScript（Host 与 Client 两半），不引入 Python/sidecar。
2. **运行时依赖**：**零**。不 import 宿主的 `@deepseek-ai/*` 包；需要的宿主表面在 `src/host/context.ts`、`src/client/context.ts` 手写结构类型。
3. **原生模块**：禁止需要编译的原生依赖（`better-sqlite3` 等）；SQLite 只用宿主 Node 内置的 `node:sqlite`，且只用于派生索引。
4. **构建**：esbuild 单工具链；Client 半必须产出 `window.__ModuleLoader__.load({id, factory})` 的字节形状。
5. **平台**：Windows 为主（`pnpm.cmd`，不能用 `pnpm.ps1`）；Node ≥ 22.12，宿主为 Node 24。
6. **仓库**：public + MIT；构建产物 `lib/` 不入库（`pnpm run build` 生成）。

## 三、质量门（提交前必须全绿）

| 门 | 命令 | 通过标准 |
|---|---|---|
| 类型 | `pnpm.cmd run typecheck` | `tsc --noEmit` 零错误（strict） |
| 构建 | `pnpm.cmd run build` | 两半产物生成，无 warning |
| 契约测试 | `pnpm.cmd test` | 全绿；新增不变量必须带失败用例 |
| 文档链接 | `node scripts/check-links.mjs` | 0 断链 |
| 一键 | `pnpm.cmd run check` | 以上串联 |

不满足任何一项 → 不得提交/合并。

## 四、流程

1. **Spec 先行**（SDD）：先改 `.agents/specs/`，再写测试，再写实现。
2. **测试先行**（TDD）：RED → GREEN → REFACTOR。
3. **决策留痕**：技术选型/架构调整先写 `.agents/adrs/`，PR/提交引用 ADR 编号。
4. **文档归属**：规范类 → `.agents/specs/`；决策 → `.agents/adrs/`；纪律/政策 → `.agents/constitution/`；面向用户的手册 → `docs/`；证据与过程稿 → issue / PR comment（不入库）。

## 五、治理

- 本章程的修订需在 `.agents/adrs/` 留一条决策记录（除非纯文字澄清）。
- 章程条款与实现冲突时：**先停下来**，指出冲突点，给出「改章程 / 改实现」两条路，由用户裁决。
- 不得为通过检查而放宽本章程；放宽必须单独提出并经用户确认。
