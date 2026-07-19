# ADR-0001：Pi-XK 的 Pi 集成边界

> **状态**：Accepted for Phase 0
>
> **日期**：2026-07-19
>
> **决策范围**：MVP 的宿主、会话、扩展、资源、压缩、RPC 和权限接入边界。
>
> **关联设计**：[Pi-XK 架构策划案](../pi-xk-architecture-proposal.md)

## 背景

Pi-XK 要在 Pi 基础上新增 Goal、checkpoint、策略、任务和 artifact，而不是重新实现 provider、Agent loop、会话树或 TUI。Pi 中同时存在两类接口：

1. coding-agent 的 Extension API 与 AgentSession，已提供 session、资源、trust、context、工具、压缩和生命周期事件；
2. AgentHarness 的通用化生命周期设计，其中有一部分仍明确标为 planned 或 in progress。

MVP 不能把未完成的 Harness 设计当作已稳定 API，也不能让 Pi-XK 的需求反过来改变 Pi 的 session 格式。本 ADR 固定第一阶段允许依赖的真实接入点、禁止的捷径和相应测试契约。

## 决策

Pi-XK MVP 采用 extension-first，并继承启动 Pi 的用户进程权限：

~~~text
Pi interactive / print / RPC host
    -> AgentSession
    -> Pi-XK 用户级 Extension
    -> pi-xk-core（contract、事件、policy、artifact）
    -> 可选的 sandbox / RPC child adapter
~~~

不新增 Pi session 文件格式，不修改 Pi 的 provider transport，也不在 MVP 修改 AgentHarness。Goal、Task、Proposal 的可变事实源留在 .pi-xk 领域事件日志；Pi session 只保存小型、不可变的关联引用。Phase 0 与 MVP 不增加权限确认、CapabilityPolicy 或沙箱，所有 Pi-XK 操作与 Pi 默认行为一致，拥有启动用户的权限。

## 可直接使用的 Pi 接入点

| Pi 能力 | 证据 | Pi-XK 使用方式 | 约束 |
| --- | --- | --- | --- |
| Session tree、branch 和 leaf | [session-manager.ts](../../packages/coding-agent/src/core/session-manager.ts) | 对话、fork、resume 继续完全交给 Pi | 不维护 children 反向索引，不复制 history |
| custom entry | [ExtensionAPI.appendEntry](../../packages/coding-agent/src/core/extensions/types.ts) | 写 goal_binding、checkpoint_ref、task_link 等小型引用 | custom entry 默认不进入模型 context；不放 Goal read model 或大 payload |
| before_agent_start | [Extension events](../../packages/coding-agent/docs/extensions.md) | 在一次 agent run 开始时绑定 policy/resource generation，并注入最小 L0 | 不把可写状态或敏感 artifact 直接拼进 system prompt |
| context | [Extension events](../../packages/coding-agent/docs/extensions.md) | 在每个 turn 选择 L1/L2 artifact 片段 | 只注入已校验、带 provenance 且受预算限制的内容 |
| turn_end / agent_settled | [Extension events](../../packages/coding-agent/docs/extensions.md) | turn_end 自动写 checkpoint；agent_settled 处理最终审计和延后操作 | 不在 agent_end 假定任务已彻底静止；Pi 可能继续 retry、compact 或消费 follow-up |
| session_before_compact / session_compact | [Extension events](../../packages/coding-agent/docs/extensions.md) | 前者写 checkpoint intent，后者记录 compaction artifact/ref | 默认不替换 Pi compaction summary；失败不破坏原 session |
| project_trust / resources_discover | [Extension events](../../packages/coding-agent/docs/extensions.md)、[resource-loader.ts](../../packages/coding-agent/src/core/resource-loader.ts) | 用户级 Pi-XK extension 在 trust 前运行；信任后再读取项目级 Pi-XK 资源 | 沿用 Pi 的 trust 语义；Phase 0 不额外建立工具权限层 |
| session_shutdown / session_start | [Extension events](../../packages/coding-agent/docs/extensions.md) | 释放运行时句柄、重建只读 index 与 generation | replacement 后旧 ctx、旧 pi 和旧 SessionManager 都可能失效 |
| AgentSession SDK | [sdk.md](../../packages/coding-agent/docs/sdk.md) | 只读 child 或嵌入式控制面可创建独立 in-process session | 写入/不可信工作不共享父 workspace |
| RPC process/supervisor | [rpc-process.ts](../../packages/orchestrator/src/rpc-process.ts)、[supervisor.ts](../../packages/orchestrator/src/supervisor.ts) | 作为将来隔离 child Pi 进程的传输与事件通道 | 不把它误用为预算、进程组、sandbox 或恢复系统 |

## 明确不依赖的能力

| 能力或捷径 | 原因 | Pi-XK 决策 |
| --- | --- | --- |
| AgentHarness 通用 hooks/facade | 设计文档仍标注为 planned/in progress，生命周期和 abort barrier 仍待审计 | MVP 不依赖；未来仅在稳定实现和 contract test 后评估 |
| AgentHarness 的自动 compaction/retry 决策 | 文档明确称尚未实现 | 使用 coding-agent 的 AgentSession compaction 事件 |
| 每个工具调用前直接重读 Skill | 可能让同一 tool batch 的工具/schema 变化，破坏 prompt cache 和可重放性 | resource generation 只在 agent_settled 或显式批准边界切换 |
| project trust 作为完整权限系统 | 它控制项目动态资源是否加载，不控制 shell、文件、网络或凭据的每次副作用 | 当前接受 Pi 的无限制宿主权限；未来如需不可信/无人值守运行，再单独引入 CapabilityPolicy 与沙箱 |
| custom entry 作为 Goal 事件日志 | Pi session 仍是对话域，且 ExtensionAPI append 是无 schema 的便利接口 | 只保存引用；Goal event log 独立、可校验、可重放 |
| OrchestratorSupervisor 作为 TaskSupervisor | 它负责实例/RPC 连接，当前没有 TaskSpec、预算、deadline、进程组或 worktree 语义 | Phase 3 在它之上实现 xk-tasks adapter |
| ctx.reload 作为模型中途热更新工具 | reload 后旧闭包失效，且 handler 仍在旧 frame 继续执行 | 仅允许由批准后的控制命令触发；reload 视为当前 handler 的终点 |

## 接入规则

### 1. 宿主与扩展

Pi-XK 的首个可执行入口是用户级 extension 或受控 CLI extension。它必须在 project_trust 阶段存在，才能决定项目级 .pi-xk 资源是否可以参与后续解析。项目级 extension、Skill、MCP command 和 proposal 一律在 trust 后加载。

project trust 是“允许项目动态代码进入宿主进程”的决定，不是沙箱。Phase 0 直接沿用 Pi 的 trust 行为和启动用户权限，不额外限制项目 extension、shell、文件、网络或凭据。若未来支持不可信项目或无人值守运行，必须新增独立 ADR 来定义受限 profile、资源 allowlist 与 sandbox。

MVP 中不创建新的 Pi provider、TUI fork 或 session storage 实现。必要的 UI 先通过 Pi command、通知和 custom entry renderer 暴露；复杂 UI 留到功能稳定后。

### 2. Session 与 Goal 的关系

Pi session 是对话事实源，Goal event log 是 Goal 事实源。两者仅通过以下版本化 custom entry 关联：

~~~json
{
  "schema": "pi-xk.session-link.v1",
  "kind": "goal_binding | checkpoint_ref | task_link",
  "goalId": "goal_...",
  "eventId": "evt_...",
  "artifactId": "sha256:...",
  "generation": 1
}
~~~

entry 中的字段是引用，不是可修改的缓存。Goal 真实状态、验收记录、Task read model 和 artifact 内容不能写入 Pi custom entry。Pi-XK 在恢复时先重放 Goal event log，再校验 Pi session 中的链接是否仍可解析；解析失败显示诊断，不回写或伪造状态。

### 3. Checkpoint 与压缩

checkpoint 的最小顺序为：

~~~text
Pi 完成 assistant 消息和工具结果
  -> turn_end
  -> Pi-XK 追加 Goal checkpoint 事件
  -> Pi custom entry 写 checkpoint_ref
  -> 后续 provider request 或 agent_settled
~~~

任何一次 checkpoint 写入失败都不能回滚 Pi turn。扩展必须显示可恢复诊断，并在下一个安全边界按 idempotency key 重试。

在 session_before_compact 中，Pi-XK 仅执行 checkpoint intent 和来源记录；在 session_compact 中记录 Pi 保存的 compaction entry 与 artifact 引用。MVP 不提供自定义摘要，不改变 Pi 的 compaction 选择和 session tree。这样避免两套摘要链竞争事实。

### 4. Resource、trust 与 generation

Pi ResourceLoader 已经提供 project trust 前的 bootstrap 和 trust 后 reload。Pi-XK 在其上增加自己的 immutable ResourceGeneration：

~~~text
discover
  -> parse and schema validate
  -> build candidate generation
  -> smoke test
  -> publish at agent_settled boundary
~~~

一个 agent run 与其 tool batch 固定使用同一 generation。禁止 extension 在工具批次中直接 reload 或重新注册工具。资源候选不通过 schema 或 smoke test 时，继续使用前一个 generation。未来如启用受限 profile，再在 schema 校验后增加 CapabilityPolicy 评估。

### 5. 未来的 CapabilityPolicy 接入预留

Pi 的 tool_call 事件可以阻止模型工具调用，tool_result 可以受控修改模型工具输出；这为未来的应用层 preflight/postflight 留出接入点。Phase 0 不启用该层，Pi-XK 直接继承 Pi 的宿主权限。

未来如需引入 policy adapter，它还必须覆盖 user_bash 和 Pi-XK extension 内部的 exec 路径。任意项目 extension 都可能直接调用 Node/Bun API，因此不能把“已经 trust 的第三方 extension”表述为受工具 hook 完整控制。该限制不影响当前本机无限权限模式。

### 6. 子代理与 RPC

Phase 0 只允许两种 child 模式：

- 只读短任务：独立 in-process AgentSession；
- 需要独立 Pi runtime 的任务：通过 RPC child process 运行，结果只以结构化 envelope 与 artifact 返回。

不可信、写入或无人值守任务在 Phase 3 的 TaskSupervisor 可用前不启动。现有 RpcProcessInstance 仅发送 JSONL RPC、转发事件和 SIGTERM 结束子进程；Pi-XK 不能把这些行为误认为进程组清理、预算控制或工作区隔离已经完成。

## 核心补丁政策

Phase 0 和 Phase 1 的默认答案是“零 Pi 核心补丁”。出现下列情况才可以提出 core patch：

1. Extension API 无法以公开契约完成必须的、已批准的 MVP 验收项；
2. 不能由 Pi-XK 适配器安全解决；
3. 有最小复现、上游兼容性测试、删除条件和 UPSTREAM.md 条目；
4. 先获得人工批准。

任何 patch 必须优先进入 upstream-compatible 的小接口，而不是把 Pi-XK 领域状态塞进 Pi 的通用 session、ResourceLoader 或 AgentHarness。

## Phase 0 测试契约

| 编号 | 场景 | 通过条件 | 测试层 |
| --- | --- | --- | --- |
| C-01 | 启动未信任项目 | 项目 extension 和动态资源不执行；用户级 Pi-XK trust handler 可运行 | coding-agent integration |
| C-02 | Goal 绑定与 resume/fork | custom link 在 Pi session tree 中保留；Goal 状态从独立 event log 重建 | session + xk-state |
| C-03 | 含工具调用的 turn | turn_end 后恰好产生一个幂等 checkpoint；工具结果已先持久化 | faux provider harness |
| C-04 | 手动、threshold、overflow compaction | pre/post hook 顺序正确；Pi summary 不被替换；checkpoint ref 可追溯 | AgentSession integration |
| C-05 | Resource reload | 在 agent_settled 前不切换 generation；reload 后旧 extension ctx 不再使用 | extension lifecycle |
| C-07 | RPC child 退出 | pending RPC 被拒绝、事件订阅解绑、child 结果标记失败或 orphaned | orchestrator adapter |

所有 provider 测试使用 Pi faux provider 或专用假工具，不使用真实 provider、密钥或付费 token。

## 退出标准

满足以下条件即可结束 Phase 0，进入 Goal event log 与 checkpoint 的 Phase 1：

1. C-01 至 C-05、C-07 已有可执行测试或已明确标注为下一阶段实现前置条件；
2. 能用 extension-first 路径证明 Goal link、turn_end checkpoint 和 compaction hook 不需要改变 Pi session 格式；
3. 没有未登记的 Pi 核心补丁；
4. ResourceGeneration 和 TaskSupervisor 的缺口已分别落到 Pi-XK 领域层，而没有伪装成 Pi 已有功能；权限与沙箱明确不属于当前 MVP。

## 后果

正面后果是 Pi-XK 立即复用 Pi 的 provider、session、TUI、资源和 RPC 能力，且上游同步面保持小。代价是 MVP 需要先接受 Pi Extension API 的生命周期语义，不能把所有期望能力一次性塞进 Harness 或 orchestrator。

本 ADR 也故意推迟了权限/沙箱、完整 TaskSupervisor、自动 proposal 和复杂 memory。当前默认模式是本机个人使用的 Pi 无限权限模式。

## 复核触发器

重新审查本 ADR 的条件：

- Pi 将 AgentHarness hooks/facade 标记为稳定并提供完整 lifecycle contract；
- Pi Extension API 改变 session、trust、reload 或 compaction 语义；
- 项目需要支持不可信项目、共享部署或无人值守运行；
- Phase 1 的 checkpoint 无法以 custom link + 独立 Goal event log 实现；
- Phase 3 需要的 child cancellation/worktree/sandbox 能力无法安全包裹现有 RPC transport。
