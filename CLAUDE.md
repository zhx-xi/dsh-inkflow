# CLAUDE.md — 入口跳板

Read [AGENTS.md](AGENTS.md) for project guidelines — it is the single entry point.

**唯一约束源**：本文件只做跳板，不复制规则（复制体必然漂移）。

三条最高频的纪律先记住：

1. 先读 [.agents/constitution/constitution.md](.agents/constitution/constitution.md)（最高依据）与相关 [.agents/specs/](.agents/specs/)，再动手。
2. 文件是真相、索引是缓存：**不许用改索引的方式改数据**，也不许给索引写数据库迁移。
3. 提交前 `pnpm.cmd run check` 必须全绿；改完 `lib/` 必须重启 DSH 才生效。
