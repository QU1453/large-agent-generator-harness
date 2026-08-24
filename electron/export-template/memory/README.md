# 记忆空间

本目录是本 LA 的记忆空间（md 文件优先，人可读、可审计）：

- `policy.md` — 场景策略：什么时候读写、何时遗忘（可编辑）
- `ledger.md` — 原始账本：只追加，每次读写留痕
- `facts/`   — 陈述性事实（用户偏好 / 配置 / 结论）
- `episodes/`— 情景记忆（具体事件，含双时态时间戳）
- `skills/`  — 程序性技能（踩坑修复轨迹 → 可复用步骤）
- `views/`   — 派生视图（时间线 / 索引，查询或复盘时生成）

所有记忆以 md 文件保存；每条记录建议带 [[valid:…]] / [[txn:…]] 时间戳头。
记忆读写工具见 M3（`memory_read / memory_write / memory_append / memory_search / memory_forget`）。
