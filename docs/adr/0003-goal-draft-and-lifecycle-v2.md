# ADR-0003：Goal 草案确认与全生命周期控制 v2

> **状态**：Accepted and implemented for Phase 1.8
>
> **日期**：2026-07-21
>
> **决策范围**：Goal 草案、合同 v2 基线、模型/用户生命周期控制、Pi session 链接和交付提交规则。合同演进与提示词续接部分已由 [ADR-0006](0006-goal-v3-and-compaction-recovery.md) 扩展。
>
> **关联设计**：[Pi-XK 架构策划案](../pi-xk-architecture-proposal.md)、[ADR-0001 Pi 集成边界](0001-pi-integration-boundaries.md)、[ADR-0002 Artifact Store 与 Goal Read Model](0002-artifact-store-v1.md)

## 背景

Phase 1.7 已经让 active Goal 在普通模型回复后继续运行，但新 Goal 仍把用户输入直接写成合同并启动，生命周期事件也不足以表达暂停审计、恢复证据和结束验收。这样会把未确认的目标写入项目目录，也无法让 host 验证模型对暂停或结束的判断。

本阶段把“起草合同”和“创建 Goal”分开。Pi session 继续保存会话级轻量状态；`.pi-xk/goals/<goalId>/events.jsonl` 仍是已确认 Goal 的唯一事实源。不会引入第三方问答包或另一套 session 存储。

## 决策

### 1. 使用 Pi 原生交互完成草案确认

TUI 环境使用 Pi 原生 `ctx.ui.custom` 显示全宽草案对话框。`/goal` 捕获下一条普通输入，`/goal <objective>` 作为快捷入口。模型只可提交或修订草案；对话框固定提供“确认，启动 Goal”和“修改草案”两个动作，Page Up/Page Down 滚动合同，Escape 关闭但不取消草案。修改动作打开空白的 Pi 原生多行 editor，用户提交反馈后模型重新起草。

非交互环境保留等价命令：`/goal review`、`/goal confirm`、`/goal revise <text>` 和 `/goal cancel`。确认前不创建 Goal ID、目录、事件日志、合同投影或两份 Goal Markdown 文件。

草案在 Pi session custom entry 中以 `goal_draft` 保存，状态只能沿以下有限集合变化：`requested`、`proposed`、`superseded`、`confirming`、`confirmed`、`cancelled`。它是会话恢复所需的暂态记录，不是 Goal event log，也不进入模型常规上下文。

同一 session branch 只允许一个当前 Goal。当前绑定 Goal 仍为 active 或 paused 时拒绝创建新草案；必须先结束当前 Goal，避免只替换 binding 却把旧 Goal 留在不可见的 active 状态。

### 2. 合同 v2 建立兼容基线，v1 保持可验证历史

本 ADR 实施时新增 `GoalContractV2`，在既有字段之外持久化：

- `nonGoals`；
- `doneCondition`；
- `pauseCondition`；
- `finalReport`；
- `executionAuthorization`。

新建 v2 Goal 至少有一个 `required` acceptance。历史 v1 JSONL 不原地迁移，也不重算 hash。replay 先按其原始 schema 校验事件 payload，再以纯 upcaster 提供统一的内存合同。当前新 Goal writer 已按 ADR-0006 生成 V3；V1/V2 仍按原始 payload/hash 读取，首次 V3 修订必须经用户确认。contract/read-model 和 Markdown 均由上转换后的合同投影，仍可删除重建。

### 3. 生命周期事件承载可验证决策

暂停事件保存 `actor`、`userRequest`、`nextBestAction` 和结构化 `audit`；审计至少列出未达 required acceptance、现有证据和未完成结论。恢复事件保存 `actor`、`reason` 和 `resumeEvidence`。结束事件保存 `verifiedAcceptanceIds`、`finalEvidence` 和 `finalSummary`。

兼容读取旧 lifecycle payload：缺失字段使用明确的默认值。新 v2 Goal 的 host 校验必须拒绝空 pause 审计、未知 acceptance ID、遗漏 required acceptance 的 end；旧 Goal 维持可读，不能因新增字段被损坏或拒绝 replay。

### 4. 模型可操作生命周期，但不能绕过用户确认

草案 kickoff 只注入草案合同写作规则，只提供 `pi_xk_submit_goal_draft`，不得开始工作或调用 start/pause/end。

active Goal 的模型可调用：

- `pi_xk_start_goal(reason, resumeEvidence)`，仅允许 paused Goal；
- `pi_xk_pause_goal(reason, userRequest, nextBestAction, audit)`，仅允许 active Goal，且 audit 证明目标尚未满足；
- `pi_xk_end_goal(outcome, reason, verifiedAcceptanceIds, finalEvidence, finalSummary)`，仅在全部 required acceptance 有验证证据后允许结束新的 v2 Goal。

工具先追加 Pi session lifecycle intent；当前 run 的最终 turn checkpoint 已持久化到 Goal event log 后才写 Goal 事件和状态转换。checkpoint 失败时 intent 在当前 live runtime 的后续安全边界重试；遇到 shutdown、startup 或 tree navigation 时，只有 checkpoint 已 durable 的 pause/end 可先提交，其余 intent 写入 `rejected` 终态。start intent 不跨这些 runtime 边界恢复。start 成功后立即结束普通 turn，写入 `goal_resumed` 并开始新的 active kickoff。pause/end 成功后不自动续跑。无绑定、状态不匹配、缺少审计、非法 acceptance ID 或不完整验收必须返回明确错误。

`goal-objective.md` 是当前合同的规范投影。读取侧校验完整规范正文；合同更新和 projection rebuild 会原子重建 objective 文件。只保留正确 identity header 但修改正文必须诊断为 mismatched。

paused Goal 收到普通用户输入时，只获得轻量恢复提示：先读取 pause audit 与新输入。只有新输入、外部变化或新证据解除阻塞时模型才可 start；恢复前不得执行 Goal 工作。用户 `/goal pause` 可由模型基于新证据恢复；用户 `/goal end` 立即结束且不可重新启动。

### 5. 统一提示词决策表

每个 active run 和隐藏 kickoff 都要求先读取 `goal-objective.md` 与 `goal-state.md`，审计 required acceptance；有可执行动作就继续；普通回复、部分结果、token 消耗、run 数或“计划已写好”均不是 pause/end 理由。当前实现只注入文件路径、合同 revision 和必要诊断，不复制原始用户要求或完整合同正文。Objective/State 的 V3 分工、受控修订和 compaction recovery 见 ADR-0006。

提示词只约束模型决策，不能替代 host 校验。模型不能借提示词获得额外文件、网络、部署或 Git 权限；`executionAuthorization` 只说明用户已授权的 Goal 范围内代码、测试、脚本和正式文档修改。

### 6. CLI 状态与交互边界

TUI footer 通过 `ctx.ui.setStatus` 显示当前 Goal 状态和 `activeElapsed`。active 时每秒只刷新显示；paused、ended 或 session shutdown 时停止计时器。刷新不追加 Goal event、不写 session entry，也不替换 Pi 原生 footer。`/goal status` 展示包括暂停的 `wallElapsed`、排除暂停的 `activeElapsed` 和已关闭 run 的 `busyElapsed`。

草案对话框、滚动和多行修订全部由 `pi-xk-extension` 使用 Pi 公开 UI API 实现。第三方问答、工具展示和 context bar 仅作为 UX 证据，不进入运行时依赖，也不修改 `packages/coding-agent/src` 或 `packages/tui`。

### 7. Session、树与模型生命周期

active Goal 的自动续跑只属于当前 live session。以下边界必须保守暂停，而不是在新 runtime 自动继续：

| 边界 | 决策 |
| --- | --- |
| graceful quit、signal shutdown、reload、new、resume、fork/clone | `session_shutdown` 在 teardown 前中断 open run 并写 runtime pause；新 session 启动后保持 paused。 |
| SIGKILL、进程崩溃等未执行 shutdown hook 的退出 | 下次 `session_start` 恢复遗留 open run，并在任何 provider 调用前写 runtime pause。 |
| agent aborted | open run 写 interrupted，Goal 写 paused，不安排重试或续跑。 |
| session tree undo/navigation | `session_before_tree` 先同步安全 checkpoint、处理可提交 intent 并暂停；失败返回 cancel。`session_tree` 重挂同一 Goal binding，因为独立 event log 不随 Pi branch 回滚。 |
| model switch | 不改变 Goal lifecycle、generation 或 binding；下一次 active run 使用 Pi 当前模型。 |
| compaction | 只写 checkpoint evidence，保持 lifecycle 不变，不替换 Pi summary。 |

跨 shutdown/startup/tree 的未提交 `start` intent 一律 rejected，不能让旧动作自动恢复 Goal。可验证的 pause/end intent 可在最终 checkpoint 已 durable 时先提交；其余 intent rejected 后再保守暂停。恢复后必须由用户显式 `/goal start`，模型只能在一个新的普通输入回合中依据新证据请求恢复。

草案单独遵循 Pi session 分支：没有绑定 Goal 的 requested/proposed/confirming 草案可在会话恢复后继续 review/confirm/revise；若恢复时同一 branch 已绑定 active/paused Goal，残留 outstanding draft 被视为不可能状态并退役。若 confirming 草案的 goalId 已与 binding 匹配，则恢复为 confirmed，避免重复创建。

### 8. 分段交付与 Git

实现按 ADR、Core V2、模型工具与提示词、草案 UI/命令/文档四段进行。每段完成后运行定向测试、`npm run test:pi-xk`、`npm run check` 与 `git diff --check`，只暂存该段文件并创建 Conventional Commit。

正常情况下每个本地提交立即 `git push origin main`。远端前进、分叉、hook/check 失败或工作区出现无关改动时停止当前段，不做自动 rebase 或覆盖。网络不可用时，已获用户授权的实现可继续创建顺序本地提交；恢复网络后先重新核验 fast-forward，再按原顺序推送，不能把本地成功表述为远端已发布。

## 后果

- 用户始终拥有新 Goal 的创建、取消和最终终止权；模型仅在已确认 Goal 内做可审计的生命周期判断。
- 草案不会污染项目 `.pi-xk` 目录，但 session 恢复需要能重建其待确认状态。
- v1 数据保持可重放；本 ADR 引入的 v2 验证和 ADR-0006 的 V3 revision 均不重写历史 hash 链。
- 自动续跑不再依赖 run 上限；在 live session 内是否暂停或结束由验收证据和 host 校验共同决定，runtime 关闭和树导航按上表保守暂停。
- CLI 计时和草案交互是可删除的扩展投影；不会成为 Goal 或 Pi session 的新事实源。
- 本阶段不实现通用 Context/memory、TaskSupervisor、Policy/沙箱、外部问答依赖或未确认 Goal 的自动执行。

## 验证门

1. v1 raw event hash/replay 不变，v2 合同和 lifecycle 字段被严格校验并可上转换。
2. 草案创建、修订、取消在确认前不产生 `.pi-xk/goals/<goalId>`；确认可幂等恢复。
3. faux provider 覆盖模型恢复用户或模型暂停、pause audit、end acceptance、非法 start 和 checkpoint 后提交顺序。
4. active Goal 在普通回复后继续；pause/end 后不续跑；ended Goal 拒绝 start。
5. TUI footer 的 active 时间逐秒更新并在 pause/end 后冻结；草案 custom UI 覆盖滚动、确认、修订、取消和无 UI 降级。
6. quit/reload/new/resume/fork、unclean startup recovery、agent abort 和 tree navigation 均留下 paused Goal；model switch 与 compaction 不改变 lifecycle；恢复必须手动 start。
