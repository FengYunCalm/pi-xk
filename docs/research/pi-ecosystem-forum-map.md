# Pi 生态研究地图：论坛实践与架构取舍

> **状态**：研究快照
>
> **日期**：2026-07-28（在 2026-07-19/21 快照上增量核验 6 个候选）
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

论坛材料部分只覆盖已提供的四份副本。研究时 Linux.do 的 HTTPS 连接不可达；仓库信息改由 GitHub API、GitHub README 和 npm 元数据交叉核验。

2026-07-28 根据用户补充的 6 个入口重新核验了 `pi-observational-memory`、`pi-ace-tool`、`pi-nano-context`、`pi-tool-display`、`@juicesharp/rpiv-ask-user-question` 和 `oh-my-pi`。本次证据来自 GitHub API、仓库 README/`package.json`、官方 npm registry 元数据及关键扩展入口源码；没有把第三方源码复制进本仓库。

其他主体项目的外部版本、许可证和活跃度仍以 2026-07-19/21 快照为准。实际引入任何候选前必须再次核验源码、许可证、peer dependency、安装脚本和 lockfile。

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

## 2026-07-28 六项增量核验

| 项目 | 当前事实快照 | 实际接入面 | 与 Pi-XK 的关系 | 当前决定 |
| --- | --- | --- | --- | --- |
| [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) | npm `3.0.3`，MIT；`master` 是活跃开发分支且 dev 依赖已指向 Pi `0.81.x`；V3 不读取 V2 配置或 memory 格式 | 注册自己的 proactive compaction trigger、`session_before_compact` summary、observer/reflection/dropper 和按 ID recall | 与当前 Pi-XK `0.80.x` 的 compaction recovery、Session Chain L1/L2 和后续通用 memory 都有语义重叠 | 只在独立 profile 做替代方案实验；完成版本加载、compaction、恢复和事实源契约测试前不与日常 Pi-XK profile 叠装 |
| [pi-ace-tool](https://github.com/justhil/pi-ace-tool) | 仓库 `package.json` 为 `0.1.0` 并声明 MIT，但仓库没有 LICENSE 文件；官方 npm registry 无同名包 | 注册 `search_context`，本地增量索引后把新增或变更代码块上传到 Augment 官方或兼容 API；提供 OAuth、配置和显式 prompt enhance | 是远程语义代码检索 adapter，不是本地索引或 Goal/Session 状态源 | 仅可从固定 Git commit 在隔离项目试验；许可证补齐且上传/删除/忽略规则可验收前不进入默认工具集 |
| [pi-nano-context](https://www.npmjs.com/package/pi-nano-context) | npm `0.1.1`，MIT；仍 peer 依赖旧包名 `@mariozechner/pi-coding-agent` | 读取当前 session context，在编辑器下方画分段 token bar，并替换 footer 后重新呈现 extension statuses | 只影响 TUI，不改变 context 或 session；自定义 footer 可能与其他 UI 扩展竞争 | 等待上游切换到 `@earendil-works` peer 或完成兼容补丁后再做 UI smoke |
| [pi-tool-display](https://www.npmjs.com/package/pi-tool-display) | npm `0.5.0`，MIT；支持当前 Pi `0.80.x` peer；包声明条件式 `postinstall` | 接管内置工具、MCP 和显式 custom tool 的渲染，提供紧凑输出、diff、pending preview、preset 和 consumer adapter | 可改善日常 TUI，但不提供 Pi-XK 状态或事实源；默认工具 ownership 可能与其他 renderer 冲突 | 可作为隔离 profile 的可选 UI；采用前核验 lifecycle script、reload cleanup、窄终端和逐工具 ownership |
| [@juicesharp/rpiv-ask-user-question](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) | npm `2.1.0`，MIT；依赖 `rpiv-config`，`rpiv-i18n` 为 optional peer | 注册一个 `ask_user_question` 工具；一次最多四题，支持选项说明、preview、note、复核，以及 TUI/RPC/ACP 降级 | 与 Goal revision/draft 的确认 UX 可互相参考，但它不是 Goal 合同变更入口 | 作为通用澄清 UI 候选；不替代 Pi-XK 的受保护字段确认、CAS 或 Goal event |
| [oh-my-pi](https://github.com/can1357/oh-my-pi) | MIT 的独立大型 Pi fork；npm 正确入口为 `@oh-my-pi/pi-coding-agent@17.1.7`，仓库 `main` 已包含 `17.1.8` catalog | 独立 `omp` CLI，整合 LSP/DAP、browser、subagent、memory、hashline、native runtime 和大量工具 | 不是可加载到 Pi-XK 的普通 extension；整体采用意味着切换 harness、包命名空间、配置、session 和发布链 | 只作为架构、工具和 benchmark 对照；不整体合并，也不与 Pi-XK 共用可写 profile/session |

注意：npm 上未加 scope 的 `oh-my-pi@0.2.0` 指向 `acidsugarx/oh-my-pi`，不是 `can1357/oh-my-pi`。评估后者时只能使用仓库说明的 `@oh-my-pi/pi-coding-agent` 或官方安装入口。

## A 类：优先研究或隔离试点

| 项目 | 已核验快照 | 能学到/复用的边界 | Pi-XK 决策 |
| --- | --- | --- | --- |
| [Pi MCP Adapter](https://github.com/nicobailon/pi-mcp-adapter) | MIT，npm 2.11.0 | lazy server、metadata cache、proxy/direct tools、OAuth、输出保护 | 首个可选 MCP adapter；所有 MCP 仍由 Pi-XK host 统一编排 |
| [pi-subagents](https://github.com/nicobailon/pi-subagents) | npm 声明 MIT，0.35.1，异步 artifact、session sharing、worktree、depth 限制 | child 生命周期文件、结构化输出、后台可见性、child 边界 | 重点研究；不直接替代 TaskSupervisor |
| [pi-observational-memory](https://github.com/elpapi42/pi-observational-memory) | MIT，npm 3.0.3；V3 与 V2 配置/memory 不兼容；master 可能含未发布改动 | observation/reflection/dropper、预计算 compaction、按 ID evidence recall | 只做单独上下文实验；不得与 DCP/Hermes/Pi-XK compaction controller 未经契约测试叠装 |
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
| [oh-my-pi](https://github.com/can1357/oh-my-pi) | 独立 `omp` harness、LSP/DAP、browser、subagent、Hindsight、hashline 和 native tools | 大型 fork，不是 Pi extension；整体合并会替换 Pi-XK 的 host、profile 与上游同步边界 |
| [pi-adaptative](https://github.com/Caupulican/pi-adaptative) | source-backed self-modification、profile、reload | 研究 proposal/reload 边界；不接入其自动演化实现 |
| [rpiv-ask-user-question](https://www.npmjs.com/package/@juicesharp/rpiv-ask-user-question) | MIT，2.1.0；最多四题、预览、note、复核、自由输入和 RPC/ACP fallback | 可作为通用澄清 UI；Goal 受保护字段仍走 Pi-XK revision 确认和事件 CAS |
| [pi-tool-display](https://www.npmjs.com/package/pi-tool-display) | MIT，0.5.0；紧凑工具输出、MCP/custom renderer、pending diff 和三种 preset | 可选 TUI 实验；Goal UI 不接管其 renderer，且必须显式处理工具 ownership 和 lifecycle script |
| [pi-nano-context](https://www.npmjs.com/package/pi-nano-context) | MIT，0.1.1；编辑器下方 context bar 和替换式 footer | 证明 `setWidget/setFooter` 组合模式；采用前需修正旧 peer 包名并验证与 Pi-XK status 共存 |

## C 类：个人工作台或外围 adapter

| 项目 | 用途 | Pi-XK 位置 |
| --- | --- | --- |
| [pi-switch npm](https://www.npmjs.com/package/@cokefenta/pi-switch) | 本地 Rust/NAPI 模型网关、模型路由、429/5xx failover、断路器、models.json 管理 | 个人供应商 sidecar；不嵌入核心，不托管其凭据或 daemon |
| [pi-web](https://github.com/agegr/pi-web) | 浏览器会话、上下文、模型、Skill 和 worktree UI | GUI 参考；可单独使用 |
| [pi-app](https://github.com/justhil/pi-app) | 桌面壳、时间线、工具卡、会话树、插件适配器 | 只观察；仓库未在本次 API 快照中声明许可证，且帖子说明 GUI/TUI 非实时同步同一 JSONL |
| [pi-ace-tool](https://github.com/justhil/pi-ace-tool) | Augment 兼容语义搜索、本地增量索引、OAuth 和显式 prompt enhance；代码块会发送到远端 | GitHub-only 可选 adapter，不进入内核；固定 commit、补齐许可证并在隔离项目验证后再考虑 |
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
4. pi-observational-memory 的开发分支可能含未发布行为且当前 dev 依赖已指向 Pi `0.81.x`；当前 Pi-XK `0.80.x` 应固定 npm 发布版本并先做加载/compaction 契约测试。
5. Telegram bridge、MCP 和搜索工具会引入 token、网络、后台进程或外部服务；它们属于 adapter，不能成为 Goal/Task 事实源。
6. 所有安装前检查 package name、repository、license、依赖、lifecycle script、固定版本和实际入口。帖子中的个人体验不是供应链审计。
7. `rpiv-ask-user-question` 已升级到 2.1.0；功能完整但不能替代 Goal revision 的受保护字段确认和事件 CAS。若只借鉴 UX，不引入其 `rpiv-config` 依赖和可选 i18n 状态面。
8. `pi-ace-tool` 当前只能从 GitHub 安装，仓库缺少独立 LICENSE 文件；它还会把索引代码块发送到远端。不得把 `package.json` 的许可证声明或本地 `.ace-tool` cache 误当成完整采用审计。
9. `pi-tool-display` 的发布包声明条件式 `postinstall`，并默认可接管多个内置工具 renderer；采用前同时审查安装脚本与工具 ownership。
10. `pi-nano-context` 仍 peer 依赖旧的 `@mariozechner/pi-coding-agent`，并调用 `setFooter`；不能只因 TypeScript 能加载就宣称与当前 Pi-XK profile 兼容。
11. `can1357/oh-my-pi` 的 npm 包是 `@oh-my-pi/pi-coding-agent`；无 scope 的 `oh-my-pi` 是不同项目。OMP 是独立 fork/CLI，不按 Pi extension 安装。

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

### 六项候选的最小实验顺序

1. `pi-tool-display`：独立 profile 做 renderer ownership、reload、窄终端和 Pi-XK custom tool smoke；不修改事实源。
2. `rpiv-ask-user-question`：比较普通澄清与 Goal revision 确认，验证非交互/RPC fallback；不把工具回答直接提交为 Goal event。
3. `pi-ace-tool`：只在无敏感内容的 fixture 仓库验证索引增量、远端删除语义、忽略规则和 WSL 路径；不连接日常项目。
4. `pi-observational-memory`：单独 profile 跑多次 compaction/重启，与 Pi-XK 原生 compaction + Session Chain 做同任务对照；不叠装其他 memory extension。
5. `pi-nano-context`：上游 peer 包名修复或本地兼容补丁后再验证 footer/status 共存。
6. `oh-my-pi`：只作为独立 `omp` 可执行文件跑相同 benchmark，不共享 Pi-XK 可写 profile，不尝试作为 extension 加载。

## 后续研究问题

- 对 pi-subagents 的 child session、artifact、worktree 和 stop 语义写一次契约对照；
- 用同一长任务分别评估 observational-memory、DCP 和 Hermes，测量 token、恢复质量与 session 可重放性；
- 对 pi-mcp-adapter 的输出 spill 文件、OAuth 与 project config 做最小集成实验；
- 对 `pi-tool-display`、`rpiv-ask-user-question` 和 `pi-nano-context` 建立当前 Pi `0.80.x` 的加载、reload、窄终端与多扩展 UI 兼容矩阵；
- 对 `pi-ace-tool` 记录上传边界、远端删除能力、Git commit pin 和许可证补齐结果；
- 用相同代码任务对比 Pi-XK 与 OMP 的工具成功率、token、冷启动、session/Goal 连续性，但不互相导入状态；
- 若要采用任何包，先新建单独 ADR，不直接写入 package.json。
