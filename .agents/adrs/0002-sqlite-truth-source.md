# ADR-0002：SQLite 为真相源，同步只在架构上预留

- 状态：**已被 ADR-0005 取代（2026-10-21 用户拍板改为文件真相 + 派生索引）**；本文仅作历史记录。
- 日期：2026-10-21

## 背景

旧 InkFlow 用 43 表 SQLite 存 12.61 MB / 59 万字正文，实测 11 条引用不变量全绿，说明 SQLite 作为小说数据载体是够用且成熟的。用户要求第一阶段纯本地、不做账号/计费/远程服务端，但要在目录结构与代码架构上预留同步接口，避免 2.0 推倒重来。

旧库的教训：`knowledge_relations` 用 `(source_type, source_id)` 多态无 FK；52 个 `ensure_*` 幂等迁移不可重放；实体表 `project_id` 是 int 代理键而对外用 uuid。

## 决策

1. **SQLite 是唯一真相源**（`node:sqlite`，不用 better-sqlite3，避免原生编译）。Markdown/JSON 导出只做 git 备份，不参与运行时读取。
2. **每张可变表自带同步字段**：`rev INTEGER`、`updated_at TEXT`、`device_id TEXT`。
3. **写路径同步追加 `change_log`**：`(seq, entity_table, entity_id, op, rev, device_id, changed_at, payload)`；`op ∈ insert|update|delete`。
4. **删除用 tombstone**（`deleted_at`），不做硬 DELETE，避免同步端复活。
5. **迁移顺序化**：`PRAGMA user_version` + 顺序迁移，禁止 `ensure_*` 式不可重放补丁。
6. **不实现**：outbox 网络投递、冲突合并 UI、账号与鉴权。2.0 只加传输层与 `sync_state` 游标表。

## 后果

- 第一阶段零服务器、零网络依赖，数据完全在本机。
- 每个写操作多一次 `change_log` insert（可忽略）；`change_log` 需要定期归档策略（P3 处理）。
- 表结构比"纯本地"多 3 列，换来 2.0 无需改表。

## 验证

P0 实测：`projects` 建表 + 插入 + 重开库后数据与 `device_id` 保留；`change_log` 正确记录 1 条 `insert`。见 `tests/p0.test.js`。
