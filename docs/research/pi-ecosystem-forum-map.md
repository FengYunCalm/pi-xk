# Pi 生态研究地图：论坛实践与架构取舍

> **状态**：研究快照
>
> **日期**：2026-07-19
>
> **用途**：Pi-XK 选型前的首要参考；不是允许直接安装依赖的清单。
>
> **关联**：[总体架构策划案](../pi-xk-architecture-proposal.md)、[ADR-0001 Pi 集成边界](../adr/0001-pi-integration-boundaries.md)

## 结论

四份论坛副本和对应仓库共同证明：Pi 生态的强项是小而可替换的扩展，但也因此有三类高频风险：

1. 多个上下文/记忆扩展会同时改写 compaction、context 或 session 状态，造成事实源竞争；
2. Goal、子代理、模型代理和 GUI 往往各自维护状态，不能未经适配直接作为 Pi-XK 内核；
3. npm 同名包、未声明仓库、native addon、后台 daemon 和直接写 models.json 的工具需要单独审查。

Pi-XK 的策略是：核心保持 Pi 原生 session + 自己的 Goal event log；第三方项目优先作为设计证据和隔离实验对象，只有通过契约测试后才可作为可选 adapter。

## 证据范围与缺口

本研究读取了以下用户提供的论坛副本：

- 记事本 - 副本.md：Pi package 组合、上下文、Goal、检索、审查和 TUI。
- 记事本 - 副本 (2).md：pi-switch 的供应商故障转移与本地网关。
- 记事本 - 副本 (3).md：模型配置、pi-web、Telegram、子代理、记忆和 MCP 实践。
- 记事本 - 副本 (4).md：pi-app 桌面壳。

本轮研究范围只覆盖已提供的四份论坛副本。研究时 Linux.do 的 HTTPS 连接不可达；仓库信息改由 GitHub API、GitHub README 和 npm 元数据交叉核验。

外部版本、许可证、活跃度均为 2026-07-19 快照。实际引入前必须再次核验源码、许可证、peer dependency、安装脚本和 lockfile。

## 论坛实践的可迁移结论

| 主题 | 论坛经验 | 对 Pi-XK 的决定 |
| --- | --- | --- |
| 极简核心 | Pi 本体小，强大来自 package；但“全塞进去”的扩展反而破坏可控性 | 保持 extension-first，领域状态不塞进 Pi 核心 |
| 上下文 | context-mode、DCP、observational memory 都在解决长会话，但信息丢失和摘要链偏移是主要问题 | 一次只实验一个上下文主机制；Pi-XK 保持独立 artifact/provenance |
| Goal | pi-until-done、pi-codex-goal 提供持续执行体验 | 研究 UX，不把第三方 Goal 文件当 Pi-XK 的事实源 |
| 子代理 | pi-subagents 的角色、fallback、后台任务和 artifact 具有参考价值 | TaskSupervisor 仍由 Pi-XK 定义；第三方只做可替换 adapter |
| 模型网关 | pi-switch 解决模型路由、429/5xx failover 和本地配置 | 作为个人供应商 sidecar，不嵌入 Agent 内核 |
| GUI | pi-web/pi-app 改善会话可见性和配置体验 | UI 放在外围；禁止多 UI 同时写同一 session |
| Telegram | 多种 bridge 在 daemon、会话生命周期与 auth reload 上差异很大 | 消息桥接是外部 adapter，不影响 Goal/Task 内核 |

## A 类：优先研究或隔离试点

| 项目 | 已核验快照 | 能学到/复用的边界 | Pi-XK 决策 |
| --- | --- | --- | --- |
| [Pi MCP Adapter](https://github.com/nicobailon/pi-mcp-adapter) | MIT，npm 2.11.0 | lazy server、metadata cache、proxy/direct tools、OAuth、输出保护 | 首个可选 MCP adapter；所有 MCP 仍由 Pi-XK host 统一编排 |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | npm 声明 MIT，0.35.1，异步 artifact、session sharing、worktree、depth 限制 | child 生命周期文件、结构化输出、后台可见性、child 边界 | 重点研究；不直接替代 TaskSupervisor |
| [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) | MIT，3.0.3；master 可能包含未发布改动 | observation/reflection、预计算 compaction、evidence recall | 只做单独上下文实验；不得与 DCP/Hermes/自定义 context controller 叠装 |
| [Dynamic Context Pruning](https://github.com/complexthings/pi-dynamic-context-pruning) | scoped 安装名为 @complexthings/pi-dynamic-context-pruning | tool-call/result 成对裁剪、compression block、context nudge | 对照实验；不作为 Pi-XK 基础层 |
| [pi-codex-goal](https://github.com/fitchmultz/pi-codex-goal) | MIT，0.1.37 | 持续 Goal 的命令与用户体验 | 只借鉴 UX；Pi-XK 使用自己的 Goal event log |
| [Taskflow](https://github.com/heggria/taskflow) | MIT，0.2.3 | 可验证 DAG、gate、approval、budget、resume/replay | Phase 3 以后评估，不在 MVP 引入完整运行时 |

### 上下文扩展的互斥规则

以下项目都触碰 context、compaction 或跨会话记忆；同一 Pi profile 中只能选择一个作为主实验对象：

- pi-observational-memory：事件/反思驱动的预备记忆；
- Dynamic Context Pruning：模型调用压缩工具并在 context 中替换消息；
- [pi-hermes-memory](https://github.com/chandra447/pi-hermes-memory)：SQLite FTS、长期记忆和纠正/失败记录；
- [pi-memory](https://github.com/chendpoc/pi-memory)：本地 Markdown 记忆与可重建检索；
- [pi-lcm](https://github.com/codexstar69/pi-lcm)：SQLite 保存完整消息与 DAG 摘要。

评估标准不是“记忆更多”，而是：是否保留 Pi 原始 session、是否可回链原始证据、是否会改变 compaction、失败时是否降级、是否会把敏感内容写入额外存储。

## B 类：设计参考，不进入 MVP

| 项目 | 价值 | 不直接采用的原因 |
| --- | --- | --- |
| [Pievo](https://github.com/kky42/pievo) | profile 隔离、Pending Change Set、CAS、审批、Git 回滚 | 自动 Evolution 有成本和数据外发边界；只借 proposal/approval 思路 |
| [Plannotator](https://github.com/backnotprop/plannotator) | 浏览器计划/diff 审阅、批注回传 | 适合 proposal 审批 UI；不参与运行时事实源 |
| [Magic Context](https://github.com/cortexkit/magic-context) | 分层上下文、cache-stable context、SQLite 工作流 | 体量和状态面较大，不适合作为 Pi-XK 地基 |
| [oh-my-pi](https://github.com/can1357/oh-my-pi) | LSP、browser、subagent、hash anchored edit、丰富工具 | 大型 fork；直接合并会失去上游同步能力 |
| [pi-adaptative](https://github.com/Caupulican/pi-adaptative) | source-backed self-modification、profile、reload | 研究 proposal/reload 边界；不接入其自动演化实现 |

## C 类：个人工作台或外围 adapter

| 项目 | 用途 | Pi-XK 位置 |
| --- | --- | --- |
| [pi-switch npm](https://www.npmjs.com/package/@cokefenta/pi-switch) | 本地 Rust/NAPI 模型网关、模型路由、429/5xx failover、断路器、models.json 管理 | 个人供应商 sidecar；不嵌入核心，不托管其凭据或 daemon |
| [pi-web](https://github.com/agegr/pi-web) | 浏览器会话、上下文、模型、Skill 和 worktree UI | GUI 参考；可单独使用 |
| [pi-app](https://github.com/justhil/pi-app) | 桌面壳、时间线、工具卡、会话树、插件适配器 | 只观察；仓库未在本次 API 快照中声明许可证，且帖子说明 GUI/TUI 非实时同步同一 JSONL |
| [pi-ace-tool](https://github.com/justhil/pi-ace-tool) | 代码搜索/检索 | 可选工具包，不进入内核 |
| [pi-search](https://github.com/justhil/pi-search) | 搜索、抓取、Context7 等 | 可选外部检索 adapter；审查网络与依赖范围 |
| [pi-image-gen](https://github.com/justhil/pi-image-gen) | 前端场景图像生成/编辑 | 仅作为设计资产工具 |
| [pi-rewind](https://github.com/arpagon/pi-rewind) | Git checkpoint/rewind | 借鉴回滚 UX；与 Pi-XK artifact/checkpoint 先做兼容性实验 |
| [pi-brainstorm](https://github.com/paulmupeters/pi-brainstorm) | 只读讨论和总结模式 | 可作为用户交互扩展，不影响内核 |

## D 类：消息桥接

| 项目 | 观察 | 建议 |
| --- | --- | --- |
| [官方 pi-telegram](https://github.com/badlogic/pi-telegram) | 在单个 Pi 会话中连接 Telegram，不另起服务 | 个人轻量桥接优先候选 |
| [pi-telegram-plus](https://github.com/jalyfeng/pi-telegram-plus) | 帖子称支持自动连接与 systemd 场景 | 需验证 daemon 生命周期、凭据和重连 |
| [pi-telegram-bridge](https://github.com/bytesbrains/pi-telegram-bridge) | Telegram bot bridge | 外部 adapter，先在隔离 profile 验证 |
| [TelePi](https://github.com/benedict2310/TelePi) | 帖子记录过 auth reload 问题 | 不作为默认方案 |

## 已发现的安装与供应链陷阱

1. 不按模糊名称安装 DCP。论坛给出的是 @complexthings/pi-dynamic-context-pruning 或 GitHub 源；npm 上存在无 scope 的同名包，仓库归属不同。
2. pi-switch 是 native NAPI + 本地 daemon + 凭据配置工具，即使许可证为 MIT，也要按本地基础设施审查，而不是普通 Pi skill。
3. pi-web 会读写 Pi 的 models.json；pi-app 与 TUI 共用 JSONL 时不是实时协同。不要并行让多个 UI/进程写同一 session。
4. pi-observational-memory 的开发分支可能含未发布行为；优先固定 npm 发布版本。
5. Telegram bridge、MCP 和搜索工具会引入 token、网络、后台进程或外部服务；它们属于 adapter，不能成为 Goal/Task 事实源。
6. 所有安装前检查 package name、repository、license、依赖、lifecycle script、固定版本和实际入口。帖子中的个人体验不是供应链审计。

## Pi-XK 的采用顺序

### 现在：不引入第三方运行时依赖

- 保持 Pi 原生 session 与 Pi-XK Goal event log 的边界；
- 完成 extension-first integration spike；
- 不同时安装任何 context/memory 扩展；
- 不把 GUI、模型网关、Telegram 当作核心设计前提。

### 第一批隔离实验

1. pi-mcp-adapter：验证 lazy lifecycle、输出保护和 Pi-XK resource generation 的兼容性。
2. pi-subagents：只读研究任务，比较其 artifact/status 契约与 Pi-XK TaskSpec。
3. pi-observational-memory、DCP、pi-hermes-memory 三选一：分别在独立 profile 中跑长会话，不叠装。
4. pi-codex-goal：只比较 Goal UX，不导入其状态格式。

### 后续可选能力

- Taskflow：当 Pi-XK 的 TaskSpec 和事件日志稳定后，再决定是否采用 DAG adapter；
- Plannotator：当 proposal/approval 流程存在后再接 review UI；
- pi-web 或 pi-app：当 session 写入者和 GUI 协议稳定后再考虑桌面体验。

## 后续研究问题

- 对 pi-subagents 的 child session、artifact、worktree 和 stop 语义写一次契约对照；
- 用同一长任务分别评估 observational-memory、DCP 和 Hermes，测量 token、恢复质量与 session 可重放性；
- 对 pi-mcp-adapter 的输出 spill 文件、OAuth 与 project config 做最小集成实验；
- 若要采用任何包，先新建单独 ADR，不直接写入 package.json。
