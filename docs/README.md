# docs/ — 证据与归档

本目录**只**放两类东西：

| 子项 | 内容 |
|---|---|
| [tech-spike.md](tech-spike.md) | P0 技术验证记录：环境基线、逐项实测结果、未验证清单、复跑命令 |
| [archive/](archive/) | 已被取代的设计稿（保留作复盘，**不是现行规范**） |

## 规范不在这里

| 想找 | 位置 |
|---|---|
| 项目章程、纪律、硬约束、数据安全 | [../.agents/constitution/](../.agents/constitution/) |
| 规范（产品范围/架构/目录约定/数据模型/路线图） | [../.agents/specs/](../.agents/specs/) |
| 决策记录（ADR） | [../.agents/adrs/](../.agents/adrs/) |
| 给 AI 的入口 | [../AGENTS.md](../AGENTS.md) |

## 归档说明

[archive/data-model-sqlite-truth.md](archive/data-model-sqlite-truth.md) 是「SQLite 为真相源」时期的完整数据模型（35 张物理表 / FK / 触发器 / 迁移）。
该方案已被 [ADR-0005](../.agents/adrs/0005-files-first-with-derived-index.md) 取代，现行模型见 [S-04 data-model](../.agents/specs/data-model.md)。
保留它的价值：里面「哪些不变量值得保留」的清单仍然有效。
