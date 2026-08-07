# 文档导航

本目录同时保存当前产品文档、架构决策、可复现评测、历史实施计划和研究资料。它们的证据强度不同，不能互相替代。

## 先读什么

| 读者 | 建议入口 | 目的 |
| --- | --- | --- |
| 第一次使用 Pi-XK | [上手指南](pi-xk/getting-started.md) | 安装、首次 Goal/Task/Chain/Memory/Skill 使用和卸载 |
| 日常使用者 | [Pi-XK 总览](pi-xk/README.md) | 理解完整 Agent 工作流、自动行为、用户控制面和限制 |
| 维护者 | [设计与边界](pi-xk/design-and-boundaries.md) | 核对事实源、投影、领域所有权和 Host patch 边界 |
| 运维与故障恢复 | [运维与恢复](pi-xk/operations-and-recovery.md) | 诊断锁、事件、投影、rollover、Memory 和 Skill 故障 |
| 评测读者 | [评测与证据](pi-xk/evaluation-and-evidence.md) | 区分真实收益、功能验证、基准和仍未证明的结论 |
| 架构审查者 | [ADR 索引](adr/README.md) | 查看已经接受的设计决策及其取舍 |

## 当前产品文档

- [Pi-XK 总览](pi-xk/README.md)：产品定位、能力矩阵、心智模型和阅读路径。
- [上手指南](pi-xk/getting-started.md)：从安装到日常命令的最短闭环。
- [设计与边界](pi-xk/design-and-boundaries.md)：Goal、Task、Chain、Memory、Skill 和 Artifact 的所有权。
- [兼容性与使用影响](pi-xk/compatibility-and-impact.md)：安装后对 Pi、模型调用、磁盘和交互的影响。
- [运维与恢复](pi-xk/operations-and-recovery.md)：快速/深度 doctor、锁恢复和投影重建。
- [Session Chain Rollup 与模型检索](pi-xk/session-chain-rollups-and-model-retrieval.md)：L1/L2、完整性和渐进读取。
- [Memory v1/v2](pi-xk/memory-v1.md)：证据图、时间、信任、捕获、检索和生命周期。
- [Ambient Recall 与 Skill 演进](pi-xk/ambient-recall-and-skill-evolution.md)：模型自主 recall/review、预算和 Skill 发布。
- [Host patch 边界](pi-xk/host-patch-boundary.md)：fork 相对 Pi Host 的窄接口改动。
- [GitHub-only 发行](pi-xk/github-release.md)：独立二进制的构建、校验和安装。
- [Pi-XK Changelog](pi-xk/CHANGELOG.md)：独立功能演进记录。

## 架构决策

[ADR](adr/README.md) 记录已经接受的事实源、schema、权限和恢复边界。ADR 解释“为什么这样设计”，当前命令和行为仍以产品文档与代码为准。

## 评测证据

- [评测与证据总览](pi-xk/evaluation-and-evidence.md)：面向用户的结论、数字和证据边界。
- [Capability Evaluation](../evaluation/capabilities/README.md)：评测协议、注册计划和复现入口。
- [2026-08-06 受控结果](../evaluation/capabilities/results/2026-08-06/README.md)：Native Pi/Pi-XK 公共任务对照与真实工作流 smoke。
- [2026-08-05 Ambient Recall 效果证据](pi-xk/ambient-recall-effect-evidence-2026-08-05.md)：密封三臂任务的独立 provider 结果。

确定性 fixture 证明协议和不变量，不自动证明真实模型收益；真实 provider smoke 证明模型能使用工作流，不自动证明优于 Native Pi；不同模型、提示、工具和预算的公开榜单不能直接作为 Pi-XK 对照。

## 历史与研究

- [历史实施计划](plans/README.md)：保存阶段计划和当时的验收边界，不代表当前运行时行为。
- [研究资料](research/README.md)：保存第三方生态和设计输入，不代表已安装、受支持或获准写入 Pi-XK 事实源。
- [架构策划案](pi-xk-architecture-proposal.md)：长期架构演进记录，其中日期化状态和未来阶段必须与当前产品文档、ADR 和代码交叉核对。

## 事实优先级

发生冲突时，按以下顺序判断：

1. 当前代码、严格 schema、事件与 artifact 事实源；
2. 当前 commit 的测试、doctor 和可复现评测输出；
3. `docs/pi-xk/` 当前产品文档；
4. 已接受 ADR；
5. 日期化评测报告；
6. 历史计划、架构策划案中的阶段快照和研究材料。

历史文档不应被静默改写成“从未发生”。若实现改变事实源、权限、schema、生命周期或恢复协议，应先更新/新增 ADR，再同步当前文档和 Changelog。
