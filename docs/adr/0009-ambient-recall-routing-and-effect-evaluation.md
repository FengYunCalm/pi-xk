# ADR-0009：Ambient Recall 安全路由与效果评测

> **状态**：Accepted and implemented; real-provider effect evidence recorded
>
> **日期**：2026-08-05
>
> **决策范围**：不注入 Memory 正文前提下的 Recall 可发现性、D0 路由 metadata、三臂效果评测隔离与结论边界。
>
> **关联决策**：[ADR-0007 Memory v1](0007-memory-v1.md)、[ADR-0008 Ambient Memory v2](0008-ambient-memory-v2-and-skill-v1.md)

## 背景

Ambient Recall v2 已允许模型自主决定是否使用 D1-D3，但只有状态计数时，模型很难稳定判断当前 Goal、Chain 或代码范围是否与历史证据相关。直接向 D0 注入标题、候选或正文会扩大提示注入面，也会把本应按需读取的信息固定塞进每次上下文。

协议测试只能证明预算、工具和 settled publication 正确，不能证明历史检索实际改善开发结果。因此可发现性和效果结论必须分别建立，并且真实效果不能由合成 fixture 替代。

## 决策

### 1. D0 只追加可重建的安全路由 metadata

Memory index schema v6 增加派生 `memory_recall_routes` 和单调逻辑时间，并使用独立的 `memory-recall-routing-read-model.json` 保存安全路由引用及其构建时的 read-model snapshot。逻辑时间只防止 Host 时钟回拨使刚发布的 Memory 暂时不可检索；显式 `asOf` 仍完全由调用方控制。路由有效性由 `memoryId + revision + lifecycle` 与当前事实 read model 的对齐决定；access 等不改变事实引用的事件可以推进 event head，但不会使 routing 投影失效。Memory Service 只从已完整验证的 `MemoryReadResult` 的 evidence locator 派生：Goal checkpoint/completion 的 Goal 绑定、Chain summary 的 Chain/branch 绑定、durable agent-run binding、严格匹配的 Git freshness basis 与 Git evidence scope path。完整路径只在 Host 内部验证 freshness；D0 仅显示固定的 Host scope 类别（例如 `src`、`packages`），不显示任意文件或目录名。routing read model、SQLite 和 Markdown 都不是事实源；旧 SQLite schema 或缺失/失效 routing read model 读取时完整重建，不改写 event、artifact、revision 或 hash。

D0 只暴露：active 数量、当前 Goal/Chain branch 命中数、来源类别计数和有限的 Host 验证 Git scope roots。它不包含标题、statement、Cue、artifact/source ID、Goal/Chain ID、历史用户文本或任何模型文本。固定安全规则和行为提示先写入，路由行只使用剩余预算；总 manifest 保持 2 KiB，超长 root 只能缩短可选展示，不能通过整体截断删除安全边界。

路由不会自动调用 D1，不会自动读取候选，也不会提升 stale/disputed 的信任。模型仍须判断历史是否可能实质改变既有项目的修改、诊断或方案选择；仅在判断为可能时自行执行 D1，并按需要进入 D2/D3。

### 2. 效果评测使用隔离三臂而不是自报成功

`evaluate:pi-xk-ambient-effect` 只解析脱敏 run report。每个 report 包含受限 telemetry、recall ledger 预算、D1/D2/D3 数量、Memory state 使用、token、耗时和外部 verifier 的 digest/结果；不接受提示词、回答、Memory 正文、verifier 输出或任何 credential-like 文本。

评测固定为 12 个 sealed task：6 个历史决定正例、3 个 stale/冲突反例、3 个无关一次性负例。九个历史 task 各有两次配对，得到 18 个历史 treatment/placebo 对。每个配对同时保留 baseline、metadata/routing-shape 匹配但内容无关的 placebo、以及相关 Memory treatment；三臂必须使用相同 model、thinking、时间/token 限额和 tool-set digest。

实现 session 必须与 research/capture session 分离，并声明没有 Git 历史、先前 transcript、隐藏 verifier、期望 patch 或宿主临时目录访问。verifier 仅在外部运行。真实 provider report 必须是一条物理 run 一次记录，不能通过 synthetic multiplicity 伪造样本。

确定性 fixture 仅验证 schema、隔离约束、阈值计算和敏感数据拒绝；其输出明确标记为 `deterministic_fixture`，不得作为真实效果结论。真实 provider 在已授权预算内先完成小规模成本校准，记录 commit、runtime、model、task digest、命令标识和费用预测，再提交独立 `provider_run` report。

2026-08-05 已完成一份符合该协议的独立 `provider_run`。它的脱敏摘要、报告 digest、阈值结果和证据强度限制见 [Ambient Recall 效果证据（2026-08-05）](../pi-xk/ambient-recall-effect-evidence-2026-08-05.md)。原始 report、模型回答、verifier 输出和认证材料不进入仓库。

### 3. 失败时不扩大注入面

真实 treatment 若未达到 D1/D2、独立 verifier、stale/冲突、无关查询或 25% token/时延门槛，不自动增加 D0 内容、不引入 Host 自动检索，也不扩大工具预算。保留脱敏报告，单独决定下一轮检索或 Memory 质量工作。

## 验收规则

- 18 个历史 treatment 中至少 15 个主动 D1，至少 12 个进入相关 D2；
- treatment 相比 placebo 至少多 3 个外部 verifier 通过；
- stale/冲突 task 不得盲从，3 个无关 task 中 treatment D1 不超过 1 个；
- treatment 相比 placebo 的中位 token 和时延均不超过 25%；
- 每条 report 保持既有 Ambient Recall 预算，且不把普通未使用 Memory 的 run 变成事件写入。

## 后果与非目标

该决策提高的是“该不该找历史”的可发现性，不是候选注入、自动检索、向量检索或新的事实域。Memory/Skill 的事实源、D1-D3 工具输入协议、信任语义、settled-only review 和用户生命周期控制保持不变。
