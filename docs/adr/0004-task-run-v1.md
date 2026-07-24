# ADR 0004：Task Run v1 单子任务运行器

- 状态：Accepted and implemented
- 日期：2026-07-22
- 作用域：`pi-xk-core`、`pi-xk-extension`

## 背景

Goal 需要把一个边界明确的研究、实现、验证或审查工作交给独立 Agent 执行，同时保证父 Agent 与 child 不会并行修改同一项目。未来 Observation/反省 worker 也需要相同的持久化运行底座。

Pi 原生 session、Agent loop 和 provider 已提供创建、持久化、取消及等待 `AgentSession` 的公共 SDK。Pi-XK 不复制这些机制，也不修改 Pi 核心。

## 决策

### 领域事实与 transcript 分离

Task 是 Pi-XK 领域对象，不是 Pi transcript 的派生状态。其事实源为：

```text
<project>/.pi-xk/tasks/<taskId>/events.jsonl
```

事件日志使用单调 sequence、前序 hash、idempotency key、CAS head、单 Task 写锁和 fsync 后提交。`task-read-model.json` 是可删除、可重建的投影，不是事实源。

child transcript 由 Pi `SessionManager` 独立持久化到：

```text
<project>/.pi-xk/tasks/<taskId>/session/<child-session>.jsonl
```

父 session 只保存 `task_link`，不嵌入 Task read model、完整结果或 child transcript。完整结果 envelope 写入项目级 `ArtifactStore`，Task 终态事件只记录 artifact ID、结构化摘要和引用。

### 生命周期

Task v1 的状态机为：

```text
pending -> running -> succeeded | failed | cancelled | orphaned
```

- `pending` 表示 Task 事实已创建，但 child 尚未确认启动。
- `running` 表示 child session 已创建且 `task_started` 已提交。
- `succeeded` 和 `failed` 必须来自 child 的结构化 finish 结果或明确 runtime/provider 失败。
- `cancelled` 表示用户、树导航或 graceful shutdown 主动取消运行。
- `orphaned` 只表示 runtime 在 child 运行期间丢失，不能据此伪造成功或失败。
- 终态不可重启；重新执行必须创建新 Task。

启动恢复时，未产生 `task_started` 的 `pending` Task 转为 `cancelled`；遗留 `running` Task 转为 `orphaned`。终态 Task 不自动重跑。

### 运行与父 Agent 屏障

同一父 session 最多运行一个 child。child 在后台执行，但父 Agent 当前 run 在启动 Task 后立即终止；child 终态提交前，Goal 自动续跑被 gate 阻止，普通用户输入也不会进入父 Agent。

模型启动的 Task 完成后，Pi-XK 向父 session 注入结构化结果引用，并在父 run settled 后触发隐藏恢复 turn。用户通过命令启动的 Task 只通知用户，不自动触发模型 turn。

用户取消绑定 active Goal 的 Task 时，先提交 Task `cancelled`，再暂停 Goal；Goal 不自动恢复。

### child 隔离边界

child 使用 Pi 公共 `createAgentSession`、`DefaultResourceLoader` 和 `SessionManager`：

- `cwd` 与父 Agent 相同；父 Agent 在 child 运行期间不得继续工作。
- model 与 thinking level 在启动时快照，父 session 后续切换模型不影响 child。
- `noExtensions: true`，不加载 Pi-XK Goal/Task 扩展，禁止 nested spawn。
- 保留项目 Skills、AGENTS/context 文件和获准的 Pi 内置工具。
- 绑定 Goal 时，kickoff 明确提供该 Goal 的 `goal-objective.md` 和 `goal-state.md` 路径，不复制父 transcript。
- child 只能以一次 `pi_xk_finish_task` 提交成功或失败；普通文本结束不代表成功。
- 除非 TaskSpec 或父 Goal 明确授权，child 不自动 commit 或 push。

### session 生命周期

- tree navigation 前先取消 child；取消失败则拒绝导航。
- graceful shutdown 优先取消 child；5 秒内不能 settle 时提交 `orphaned` 并断开旧 runner。
- unclean crash 由下次 `session_start` 恢复为 `orphaned`。
- model select 与 compaction 不改变 Task 状态；child transcript 不参与父 transcript compaction。
- 所有异步回调携带 runtime nonce 和 parent session ID；旧 runtime 不得写入新 session。

## V1 明确不做

Task Run v1 不实现：

- 并发 Task、nested Task、DAG 或调度器；
- retry、deadline、预算和 Policy；
- 沙箱、额外权限确认或资源隔离；
- worktree、自动合并、RPC child；
- 第三方 subagent runtime 或第二套 transcript；
- child 自动 commit/push。

完整 Phase 3 可在此单 child runner 上扩展，但不得改变 V1 事实日志与父子 transcript 分离边界。

## TaskSpec V2 与 Session Chain 补充

2026-07-24 起，新 Task 在父 session 已绑定 Session Chain 时写入 `pi-xk.task.spec.v2`：

- `parent` 固定引用父 `chainId/branchId/segmentId/entryId`，不再把物理 session ID 当长期父身份；
- `childChainId` 指向 child 自己的 managed Session Chain，child transcript 位于 `.pi-xk/sessions/chains/<childChainId>`；
- Task 与 SessionChain 仍是独立领域对象：Task 生命周期不会随 Segment rollover 重建，单个长 Task 也可在后续版本跨多个 Segment；
- 普通会话与 Goal 会话均走相同 V2 路径。未绑定 Session Chain 的 SDK/兼容入口仍可创建 V1 Task；这不是新数据的首选路径。

既有 `pi-xk.task.spec.v1` 事件、hash、child transcript 路径和 read model 事实保持原样，不做落盘迁移。需要统一展示时只对已通过 V1 严格校验的 spec 做确定性内存 upcast；upcast 不写回事件日志。单 child、same-workspace、父屏障、取消和恢复语义不变。

## 后果

优点：

- Goal 分解与反省 worker 共享一个最小、可恢复的运行底座。
- Task 事实不依赖父 transcript 分支、压缩或模型切换。
- 父 Agent 与 child 不会并行写同一工作区。
- 异常退出不会被误报为任务失败或成功。

代价：

- 同一时间只能执行一个 Task。
- Task 运行期间用户不能向父 Agent追加普通消息。
- `orphaned` Task 需要创建新 Task 才能重新执行。
