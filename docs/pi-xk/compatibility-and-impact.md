# Pi-XK 兼容性与使用影响

本文回答安装 Pi-XK 后，现有 Pi 工作流会发生什么变化。结论是：Pi 的核心协议和原生命令仍保留，但 extension 会主动管理 session、增加模型调用、写入项目状态，并在部分边界排队输入、拒绝状态变更或暂停 Goal。它不是“只增加几个命令、其余完全无感”的被动插件。

## 1. 支持基线

当前主要支持场景：

- 本仓库构建的 Pi-XK fork；
- Node.js `>=22.19.0`；
- 个人本机、单用户、交互式 TUI；
- 受信任项目和 full-access profile；
- 一个 Pi 进程写一个物理 session；
- 本地文件系统上的项目 `.pi-xk/`。

有限支持或没有产品化承诺的场景：

| 场景 | 当前结论 |
| --- | --- |
| print/RPC/no-TUI | Goal 提供 review/confirm/revise/cancel 命令降级；整体 Pi-XK 流程未作为无人值守 RPC 产品验证 |
| `--no-session` ephemeral mode | 保持 Pi 原生 ephemeral 行为，不创建 managed Session Chain |
| 不可信项目 | 不支持；extension 与 child 继承完整用户权限 |
| 多进程/多 UI 同写一个 session | 不支持，可能破坏 Pi JSONL 与 chain hash |
| 网络文件系统或最终一致存储 | 未验证；durability、rename、fsync 和 lock 语义可能不同 |
| Windows 原生 | 未形成正式兼容矩阵；路径、锁和未来沙箱仍是开放问题 |
| 无人值守运行 | 不支持安全承诺；Policy、预算与 fail-closed sandbox 未完成 |
| 跨版本 schema 迁移 | Goal/Task/Chain 有明确历史读兼容，Memory v1 从空域开始；没有通用迁移 CLI |

## 2. 安装作用域

`npm run pi-xk:install` 默认原子更新 `PI_CODING_AGENT_DIR` 或 `~/.pi/agent` 的用户级 settings，因此会在该 profile 的所有项目中加载。安装后第一次进入任意项目，都可能创建 `.pi-xk/sessions/` 并管理 Session Chain。`--dry-run` 只显示将要使用的 profile、extension 和 settings，不构建也不写入。

只希望影响一个项目时使用项目级 `pi install -l ...`。但项目 settings 中的绝对路径可能不适合提交或跨机器共享。

使用 `PI_CODING_AGENT_DIR` 可以隔离 Pi profile，却不会改变项目 `.pi-xk/` 的位置。两个 profile 若在同一项目中运行，仍可能同时触碰同一 `.pi-xk/`；profile 隔离不是项目数据的并发隔离。

## 3. 对 Pi 原生能力的影响

| Pi 能力 | Pi-XK 是否替换 | 实际影响 |
| --- | --- | --- |
| Provider/model registry | 否 | 使用当前 model；Goal/Task/L1 summary/L2 Rollup/Memory capture 可能产生额外 provider 调用 |
| Agent loop | 否 | active Goal settled 后由 extension 发起下一 run |
| Tool protocol | 否 | 新增 Goal/Task/Chain/Memory model tools；Goal draft 时限制可调用工具；proposal 与修订仍受 Host schema 和 CAS 控制 |
| Session JSONL schema | 否 | 使用原生 custom entry/custom message 承载小型引用和 marker |
| Session tree | 否 | tree navigation 会暂停 active Goal；从历史位置继续时 chain 创建 successor branch |
| `/resume` | 否 | 仍选择物理 session；逻辑 chain head 应用 `/chain` 选择 |
| `/new`、`/fork`、`/clone` | 否 | 普通 session 切换会保守暂停 active Goal；新空 session 会被 chain bootstrap |
| `/compact` | 否 | compaction 保持 Pi 原生；生成历史标题，并给下一次真实 run 一次性 recovery system context；active Goal 写 checkpoint，但不暂停 |
| Footer | 不替换 | 通过 `setStatus` 组合显示 Goal timer 和 Chain 状态 |
| System prompt | 不替换 | 按状态追加 Goal 文件路径/revision、固定大小 Session Chain/Memory manifest 和一次性 compaction recovery；不注入完整 Goal 合同、标题、摘要或 Memory 正文 |
| ResourceLoader/trust | 否 | package 仍按 Pi 的 user/project scope 与 trust 规则加载 |

## 4. 可见 UI 变化

扩展加载后增加：

- `/goal`、`/task`、`/chain`、`/memory`、`/xk status` 命令；
- 模型可见的 Goal lifecycle、Goal draft、Task start/finish、Chain summary 和 Memory D1–D3/proposal/compaction-request 工具；
- `Goal active · 12m 34s` 一类 footer status；
- `Chain <id> · S<n> · <size>` 一类 footer status；
- Goal 草案的 TUI review/revise 对话框；
- 受保护 Goal revision 的 TUI/命令审阅，以及 compaction 的短标题展示；
- lifecycle、Task 和 rollover 的通知与错误提示。
- `Memory <count> · stale <count> · disputed <count>` 状态及 proposal/capture/doctor 输出。

Goal timer 每秒刷新 UI，但不每秒写事件。多个扩展都使用 footer status 时应依赖 Pi 的组合机制；Pi-XK 不替换整个 footer。

## 5. 输入处理变化

Pi-XK 会在以下情况消费、延迟或拒绝用户输入：

| 条件 | 输入行为 | 用户下一步 |
| --- | --- | --- |
| `/goal` 多行捕获处于 open | 下一条输入作为 Goal objective，不作为普通聊天 | 等待草案，随后 review/confirm/revise/cancel |
| Goal revision 待确认 | Goal/Chain 写操作与普通 Goal 工具被 gate | `/goal revision show|confirm|revise|cancel` |
| Task 正在 running | 普通输入进入 follow-up 队列；Task 终态后按序处理 | 可继续排队，或立即执行 `/task status`、`/task cancel` |
| Task 正在 running 且输入为 Goal/Chain 写命令 | 拒绝状态变更 | 等待 Task 结束或先取消 Task |
| 当前 Segment 达 hard threshold | 先生成摘要并 rollover，成功后转发输入 | 等待；失败则诊断后重新提交 |
| 当前位于历史 tree/Segment | 创建 successor branch，切换后转发输入 | 在新 branch 继续 |
| hard rollover 失败 | 输入不送给 provider | `/chain doctor`，处理错误后再次输入 |

这些行为用于避免把输入送入错误的 parent、sealed Segment 或不一致状态。Task 队列不会让 parent 与 child 并发调用模型；它只延后处理。调用方若通过 RPC/自动化发送输入，仍必须区分“已排队”“handled 但未交付 provider”和“已进入模型 turn”，不能只依据发送 API 返回判定模型已收到。

## 6. 模型调用、费用和时延

除普通对话外，以下动作可能调用 provider：

| 动作 | 调用原因 |
| --- | --- |
| `/goal <objective>` 或 revise | 生成或修订结构化 Goal contract |
| active Goal 的 Objective refinement | 在普通 Goal run 内提交 revision；仅 objective 变化可自动应用，受保护变化等待用户确认 |
| active Goal settled | 自动开始下一 Goal run |
| provider 失败后的 active Goal | 按指数退避重新尝试 |
| Task start | child 使用启动时的 provider/model/thinking snapshot 执行 |
| Session Chain rollover | 生成 segment delta 与 cumulative carry-forward summary |
| 每 N 个 sealed Segment | rollover 提交后登记后台 L2 Rollup；失败不回滚 rollover |
| `/chain rollup backfill` | 显式生成历史完整窗口，受 limit 控制 |
| 新 Goal checkpoint/completion 或 L2 publication | Memory source bridge 在稳定边界生成结构化 inferred/disputed Memory proposal |
| `/memory backfill [limit]` | 显式捕获历史 eligible Goal/L2 source，默认一个、最多 20 |

因此：

- “没有继续输入”不代表 active Goal 不会继续消耗 token；
- manual rollover 也可能产生摘要调用；
- 默认每五次成功 rollover 会登记一次 L2 调用；它按 branch 串行后台执行，不增加第 5 次 rollover 的同步等待；
- `rollup config off` 停止新的自动 L2，但不影响 L1 rollover 摘要；
- backfill 是显式付费操作，不会在升级时自动批量执行；
- Task child 的消耗独立于 parent 当前 turn；
- provider failure retry 没有当前文档可配置的次数上限，Goal 会保持 active，直到生命周期改变或 runtime 退出；
- L2 无效响应自动尝试最多 3 次；Rollup provider/I/O/event publication 的临时失败保持可重试，不与无效响应共用该上限；
- Memory 自动 capture 只处理启用后的新 stable source；第一次加载不批量回填旧历史；
- `/memory remember`、search/read/expand、refresh 和 doctor 不调用模型；`pi_xk_propose_memory_change` 也只记录 proposal；
- `generation_started` 后结果未知的 Memory capture 不自动重试，以避免重复付费调用；
- 当前没有强制 cost/token budget controller，provider 账单仍需外部监控。

在有成本约束的环境中，应主动查看 `/goal status`、及时 pause/end，并避免把 Pi-XK 当作无人值守预算执行器。

## 7. Session 和磁盘影响

### 新 session

空的持久 session 在第一条有效普通请求到达前不创建 managed Chain；命令、空输入和启动本身不产生项目会话数据。首条请求到达后创建 managed SessionChain root，并把 runtime 切换到项目 `.pi-xk/sessions/chains/.../segments/` 下的物理 JSONL。此后长期对话可能产生多个 Segment、L1/L2 artifacts、v1/v2 events、Rollup Markdown 和恢复状态文件。

### 已有 session

已有正文的 Pi session 作为 external root 被采用，不复制原始 JSONL。Pi-XK 记录其身份和拓扑；下一次 rollover 后进入 managed Segment。

### 历史与分支

sealed Segment 不重写。从历史 Segment 或 tree 位置继续会创建 successor branch，因此磁盘会保留旧路径和新分支。当前没有自动 retention/GC。

### 移除 extension

移除 package 不删除任何 session 或 `.pi-xk` 数据。原生 Pi 仍能打开单个 Segment JSONL，但不会自动理解 Pi-XK 的逻辑 chain、Goal/Task/Memory 事件、证据图或跨 Segment summary 关系。

### Memory 数据

Memory facts 由 `.pi-xk/memory/events.jsonl` 与 `.pi-xk/artifacts/objects/` 中的 revision/Cue/Edge/proposal/source artifact 共同构成。`index.sqlite`、read model、History Cue、source cursor 和 Markdown 是可重建或可重新发现的投影/恢复数据。自动捕获和显式 backfill 会增加 artifact/event/SQLite 空间；archive/invalidate 不删除历史，purge 也保留 tombstone。当前没有自动 retention 或 Artifact GC。

Ambient Memory v2 还会在成功 `agent_settled` 边界写入 reconstruction trace、Memory review 和 agent-run evidence。模型自主搜索不代表每轮都会产生事件：无 Memory 使用的普通 run 不写 access/reconstruction；只有 D2/D3 实际读取才计入访问。`error`、`abort`、`length` 或截断 run 不发布语义 revision。

项目 Skill facts 位于 `.pi-xk/skills/`，全局 Skill facts 位于 profile 的 `pi-xk/skills/`；`.pi/skills/` 和 profile `skills/` 是可重建的 managed projection。候选不足、bundle 越界、非 managed 同名或 stale/cooldown 时不会进入下一轮 Skill generation。Skill-only reload 只在 settled boundary 发生，不重载 settings、extensions、prompts、themes、providers，不改变 tools，不发送 shutdown/start。

## 8. Goal 对日常 session 操作的影响

| 操作 | active Goal 的结果 | 原因 |
| --- | --- | --- |
| 正常 quit 或 signal shutdown | 暂停 | 新 runtime 不自动继承执行责任 |
| reload extension | 暂停 | 代码 generation 改变，需要重新确认 |
| `/new`、`/resume`、`/fork`、`/clone` | 旧 session Goal 暂停 | 防止绑定被静默留在后台运行 |
| agent abort | open run interrupted，Goal 暂停 | 不把中断误写为完成 |
| `/tree` navigation | 先暂停；失败时取消 navigation | Goal event log 不随 Pi tree 回退 |
| model switch | 保持状态 | 下一 run 使用新 model |
| `/compact` | 保持 active | 增加 checkpoint evidence；下一次 Goal kickoff 附带 recovery context，但不会产生第二个 kickoff |
| Session Chain rollover | 保持 active | 只是受控物理 session 替换 |

这意味着频繁切换 session 的用户会更常看到 paused Goal。恢复必须显式 `/goal start`，以便先审查状态和环境变化。

## 9. Task 对工作区的影响

Task child 使用相同项目根、相同用户权限和默认内置工具 `read`、`bash`、`edit`、`write`。它不是只读分析器，也不是 worktree：

- child 修改会立即出现在 parent 所见 worktree；
- parent 与其他 Pi 进程并行修改同一文件可能冲突；
- cancel 只控制 child AgentSession，不自动回滚文件、命令或外部副作用；
- `orphaned` 只说明 runtime 丢失了受控 child，不保证操作系统进程全部消失；
- child 不加载其他 extensions，因此不能依赖 parent extension 提供的工具或保护策略。

启动 implementation Task 前，应在 prompt 中写清文件范围、禁止项、验证和是否允许提交/外部操作。当前默认不会授权 commit 或 push。

## 10. Compaction 与 Session Chain 的共同使用

两者可以同时存在：

- compaction 解决当前物理 Segment 送给 provider 的上下文预算；
- rollover 解决长期逻辑会话的文件规模、恢复边界和跨 Segment 递进摘要；
- compaction entry 留在原 Segment；
- 新 compaction entry 可带一个最多 60 Unicode code point 的非命令式标题、触发原因和 recovery prompt version；
- rollover summary 带 source entry range/hash、base summary、model 和 token usage provenance；
- active Goal 在两者之间都保持连续，但普通 session switch 会暂停。

Compaction 后不会把最后一条用户提示词再次发送。overflow 在同一逻辑 run 内继续一次；active Goal threshold 只使用已有 Goal kickoff；无 Goal 的 manual/threshold compaction 等待下一条真实请求；queued message 仍由 Pi 原生队列触发。recovery 只作为下一次实际 run 的 system context，成功 assistant 响应后即不再 pending。Session Chain rollover 后 successor 使用 L1 summary-in，不继承源 Segment 的临时 recovery。

不要关闭 Pi compaction 并期待 Session Chain 或 Memory 自动替代所有 context 管理。Session Chain 管理当前逻辑会话的 L1/L2；Memory v1 管理当前项目跨来源的长期证据图。两者都不是统一 token budget controller，也不提供跨项目 knowledge base。

## 11. 模型可见性和提示词影响

每次普通请求会追加两类有界 metadata：Session Chain manifest 包含当前 branch、sealed/L1/L2 范围和 publication 状态；Memory D0 manifest 最多 2 KiB，包含 enabled、trust/freshness 计数、capture 诊断和工具可用性。两者都不包含标题、摘要正文、Memory statement、evidence 或历史用户文本。

当模型判断当前问题依赖“之前、继续、原始要求、待办、历史约束或 Goal/Task 恢复”时，可先调用只读列表工具查看 L1 标题和 L1/L2 范围，再读取相关摘要。工具调用会增加本地读取和一个 tool round，但不会触发 provider 摘要生成、backfill 或修复。摘要内的命令和伪系统提示仅作为不可信历史证据返回，不能扩大工具权限。

当问题依赖跨 Goal/branch 的决定、约束、偏好、经验、未决事项或设计原因时，模型自主用 `pi_xk_search_memory` 获取 D1 候选，再按需读取最多 5 条 D2，只有 D2 不足、stale 或 disputed 时才展开最多 3 个 D3 evidence。Memory 内容同样是历史证据，不是系统指令。D2/D3 的实际读取才记录 access；单纯搜索曝光不增加 heat。单次 run 共享 10 个知识动作、8 个 Memory 动作、3 次 Memory search、10 个 unique read、6 个 evidence 和 4 个 Skill candidate action 预算。

模型也可自主搜索和读取 Skill candidate，但只有成功 settled 后提交的 `pi_xk_review_skills` 才可能生成 candidate/revision。Skill 正文不注入 D0；模型必须说明适用/偏离条件和验证证据，Host 负责 bundle、CAS、证据和 projection。

V3 Goal 的普通 system guidance 也只提供 `goal-objective.md`、`goal-state.md` 路径、合同 revision 和 mismatch/修订反馈，不复制原始用户要求或完整合同。Objective 是只读合同投影；State 是执行台账，实质进展必须在 run 结束前回写。被用户要求修改的 revision feedback 只作为下一次修订 run 的 user-role JSON 数据，不能自行改变合同、system 规则、工具权限或授权；provider error/aborted 后仍可恢复，成功响应后不再注入。revision CAS 冲突会终止旧 run 并重新 preflight。模型只有在新证据使 Current Objective 的表述过时时才应提案，不能静默改变 Intent Anchor、验收、约束或授权。

## 12. 性能影响

Session Chain v1.1 对合成有效 Pi JSONL 的 `SessionManager.open()` 基线为：

| 文件大小 | events | 中位耗时 | 中位吞吐量 | 中位 peak RSS |
| --- | ---: | ---: | ---: | ---: |
| 1.043 MiB | 256 | 95 ms | 11.0 MiB/s | 152.4 MiB |
| 8.341 MiB | 2,048 | 422 ms | 19.8 MiB/s | 185.7 MiB |
| 32.324 MiB | 7,936 | 1,603 ms | 20.2 MiB/s | 294.7 MiB |
| 128.275 MiB | 31,488 | 6,492 ms | 19.8 MiB/s | 518.0 MiB |

peak RSS 包含 Node 进程和已加载 runtime 的基线，不是纯 session 增量。该数据说明超大物理 session 有明显时延和内存放大，也是 soft/hard 分段阈值的依据之一。完整环境、命令和三次测量方法见 ADR-0005。

限制：这些是特定机器、合成输入和完成基线上的测量，不是跨平台 SLA。真实时延还包括 JSONL 结构、消息内容、磁盘、provider 摘要调用、artifact fsync 和 UI 切换。性能判断应同时看：

- Segment byte 与 entry 数；
- rollover summary provider latency；
- 冷启动 RSS；
- `/chain doctor` replay 时间；
- 长期 branch/Segment 数量与磁盘增长。

另有 `npm run benchmark:session-chain-events -- --counts 100,1000 --runs 3 --json` 专门验证 checkpointed read model。它要求已消费完整 event log 后的重复 manifest/status 加载走 `fast` 模式，读取并验证 checkpoint 对应的最后一条 event，且读取量小于完整日志的 10%；该 benchmark 不替代 deep doctor 的线性事实校验。

Memory 使用 `npm run benchmark:pi-xk-memory` 测量合成 100/1,000/10,000/100,000 Memory 及图边场景，并用 `npm run evaluate:pi-xk-memory` 检查语义 fixture。它们是当前 commit/机器的回归证据，不是 Node/Bun、Windows/macOS 的正式 SLA。普通 D0/status/search 应走 checkpointed read model 与 SQLite，不完整 replay event log；deep doctor 和全量 projection rebuild 仍允许线性增长。

## 13. 第三方扩展兼容

高风险组合：

- 同时改写 context/compaction 的 memory 扩展；
- 另一套 Goal 或 subagent runtime；
- 会写同一 session JSONL 的 GUI/daemon；
- 替换 footer、input/follow-up 队列或 session lifecycle 的大型 extension；
- 自动修改 `models.json` 或重载 provider 的 gateway 管理器。

当前规则是 Pi-XK Memory 作为日常 profile 的唯一 context/memory 主机制。Magic Context、`pi-observational-memory`、DCP、Hermes 等只能在另一个隔离 profile 做替代方案实验，不能与同一项目的可写 Pi-XK Memory 叠装。`pi-mcp-adapter`、`pi-subagents` 等也不属于核心依赖，采用前需要契约测试和供应链复核。

Pi-XK 为此增加的 Host API 还包括 `queueUserMessage`：extension 可以把用户消息加入 Pi 原生 follow-up 队列而不立即启动 turn。它不是通用后台调度器，不允许绕过 rollover read-only 状态，也不改变正常 `prompt()` 的 input hook 顺序。

普通只读工具、独立 UI status、不会改写 session/context 的小型 extension 风险较低，但仍需检查事件顺序和命令/工具重名。Pi-XK 依赖 Goal/Task 输入 gate 先于 Session Chain replacement 执行；改变 extension 加载顺序可能影响组合行为。

## 14. 升级影响

当前本地 package 不自动迁移数据。升级前：

1. 正常结束或暂停 active Goal；
2. 等待 Task terminal，避免留下 running child；
3. 运行 `/chain doctor` 并记录 current head；
4. 退出 Pi；
5. 备份 `.pi-xk/` 与相关 Pi 原生 session，包含 Memory event/artifact；
6. 更新 checkout、build、运行验证，再重启。

升级到 Session Chain v1.1 不重写现有 chain 或 L1 artifact。新代码从后续完整窗口开始自动生成 L2；历史完整窗口只在 `/chain rollup backfill [limit]` 时生成。写入 v2 Rollup event 后，旧代码可能无法继续写同一 chain，因此不要让新旧版本交替运行。

Goal V1/V2 和 Task V1 的读取兼容已经实现，但这不代表任意未来版本都可直接降级。新 Goal 使用 V3；旧 Goal 首次迁移需用户确认，历史 event/hash 不重写。写入 Goal event v2、Session Chain L1 V2 或其他新 schema 后，旧代码可能无法继续写同一状态。没有明确 migration/rollback 说明时，不应让新旧 Pi-XK 版本交替写同一个项目状态。

Memory v1/v2 不自动回填升级前的 Goal/L2。升级后先记录当前 source head 作为 baseline，之后的新稳定边界才自动捕获；历史来源使用有限额 `/memory backfill [limit]`。Skill facts/候选同样不自动批量生成，跨项目晋升必须显式满足 evidence 门槛。一旦写入 `pi-xk.memory-event.v1`、`pi-xk.skill-event.v1` 和对应 artifact，旧版本可以忽略这些目录，但不能安全管理、修复或继续写 Memory/Skill；SQLite/Markdown/projection 可以重建，event/artifact 不能通过降级删除。

## 15. 决策清单

安装前确认：

- 接受 extension 与 child 使用当前用户完整权限；
- 接受项目新增 `.pi-xk/` 和 managed session 数据；
- 接受 Goal、Task、rollover 带来的额外 provider 调用；
- 接受 Memory 稳定边界捕获带来的额外 provider 调用，或预先执行 `/memory config off`；
- 接受成功 run 的 Ambient Memory review 和 Skill candidate/reload 可能增加 provider 调用，或预先关闭 `/memory config ambient off`、`/memory config evolution off` 和 `/skill config off`；
- 接受默认每 5 个 sealed Segment 的 L2 调用，或预先执行 `/chain rollup config off`；
- 不需要同一 parent 的并发 Task、worktree 隔离或无人值守预算；
- 不会让多个进程并行写同一 session；
- 已决定使用用户级还是项目级 package scope；
- 已准备同时备份 `.pi-xk/` 与原生 Pi session。
- 不会在同一可写 profile 叠装另一套 context/memory 主机制。

任一项不成立时，应先使用隔离 profile/容器做实验，或暂不启用 Pi-XK。
