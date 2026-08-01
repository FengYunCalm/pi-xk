# Pi-XK 架构决策记录

ADR 记录已经接受的 Pi-XK 设计决策、约束和取舍。它们解释“为什么这样设计”，不替代[当前使用文档](../pi-xk/README.md)或[总体架构路线](../pi-xk-architecture-proposal.md)。

| ADR | 状态 | 决策范围 |
| --- | --- | --- |
| [0001：Pi 集成边界](0001-pi-integration-boundaries.md) | Accepted for Phase 0 | extension-first、Pi 原生 session/compaction/RPC/权限边界 |
| [0002：Artifact Store 与 Goal Read Model v1](0002-artifact-store-v1.md) | Accepted for Phase 1.5 | 项目级内容寻址 artifact、checkpoint evidence 与可重建投影 |
| [0003：Goal 草案与生命周期 v2](0003-goal-draft-and-lifecycle-v2.md) | Accepted; contract evolution superseded by ADR-0006 | 确认前零落盘、Goal V2 基线、模型/用户 lifecycle 与恢复 |
| [0004：Task Run v1](0004-task-run-v1.md) | Accepted and implemented | 单 in-process child、结构化结果、取消、orphan 和 parent link |
| [0005：Session Chain v1.1 / Rollup v1](0005-session-chain-v1.md) | Accepted and implemented | 原生 Segment、L1/L2 摘要、模型按需检索、两阶段 rollover、恢复和分支 |
| [0006：Goal V3 与 compaction recovery](0006-goal-v3-and-compaction-recovery.md) | Accepted and implemented | Intent Anchor、受控 Objective 修订、Objective/State 分工、单一续接触发器和摘要标题 |
| [0007：项目级证据图 Memory v1](0007-memory-v1.md) | Accepted and implemented | 项目级有向多重图、证据/时间/三维状态、D0–D3 检索、捕获发布、SQLite 投影和恢复 |

## 阅读顺序

1. 先读 ADR-0001，确认 Pi 与 Pi-XK 的所有权边界。
2. 涉及 Goal 持久化或执行状态时读 ADR-0002、ADR-0003 和 ADR-0006。
3. 涉及 child 执行时读 ADR-0004。
4. 涉及长期 session、rollover 或分支时读 ADR-0005；涉及 compaction 后续接时再读 ADR-0006。
5. 涉及跨 Goal、Task、branch 或重启的项目经验时读 ADR-0007；它不替代 ADR-0005 的会话摘要或 ADR-0006 的 Goal 合同。

新增或改变事实源、权限、schema、生命周期、恢复协议或外部依赖边界时，应新增 ADR 或明确修订现有 ADR，不能只修改操作文档。
