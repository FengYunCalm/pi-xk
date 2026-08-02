# Pi-XK 运维与恢复

本文面向需要检查落盘状态、备份项目、诊断中断和安全移除扩展的使用者。Pi-XK 当前没有独立 daemon 或服务端；“运维”主要是 Pi profile、项目 `.pi-xk/`、原生 session、Goal/Task/Chain/Memory 事件与 Artifact Store 之间的一致性管理。

## 1. 数据位置

### 项目级 Pi-XK 数据

```text
.pi-xk/
  artifacts/
    objects/<hash-prefix>/
      <content-hash>.data
      <content-hash>.json
  goals/<goalId>/
    .write.lock                      # 仅写入期间存在；PID/nonce/createdAt
    events.jsonl
    contract.json
    goal-objective.md
    goal-state.md
    goal-read-model.json
  tasks/<taskId>/
    .write.lock                      # 仅写入期间存在；PID/nonce/createdAt
    events.jsonl
    task-read-model.json
    session/                         # 仅 Task V1 历史兼容
      <child-session>.jsonl
  memory/
    .write.lock                       # 仅事件写入期间存在；PID/nonce/createdAt
    events.jsonl
    memory-read-model.json
    memory-read-model.checkpoint.json
    memory-config.json
    source-cursors.json
    history-cue-cursor.json
    index.sqlite
    locks/<captureId>.generation.lock
    locks/projection.lock
    pending/<captureId>.result.json
    projections/
      manifest.json
      index.md
      memories/<memoryId>.md
  sessions/
    catalog.json
    chains/<chainId>/
      events.jsonl
      chain-read-model.json
      locks/
      branches/<branchId>/
        segments/<ordinal>_<session-id>.jsonl
        rollups/<window>.md
        rollups/<window>.pending.json
        rollups/<window>.job.json
        rollups/state.json
  session-chain.json
```

### Pi profile 数据

默认 Pi profile 位于 `~/.pi/agent/`。其中包括 package 设置、Pi 管理的二进制和原生 session。设置 `PI_CODING_AGENT_DIR` 后，该变量指定替代 profile 根。

Pi-XK 不创建项目级 `.pi` 目录来保存自己的领域状态。项目 `.pi/settings.json` 仍可能存在，因为它是 Pi 的项目级 package/settings 入口。

## 2. 文件职责

| 文件 | 是否事实源 | 能否手工删除重建 | 说明 |
| --- | --- | --- | --- |
| Pi session JSONL | 是 | 否 | 对话、工具和 tree 的原生事实 |
| Goal `events.jsonl` | 是 | 否 | 合同与 lifecycle 事件 |
| Goal `goal-state.md` | 是，执行状态 | 否 | 模型维护的当前证据、完成/未决项、失败路径、阻塞和下一动作 |
| Goal `contract.json` / `goal-objective.md` | 投影 | 通过 Core 恢复路径 | 必须与完整合同 revision 一致；Objective 不允许直接编辑 |
| Goal `goal-read-model.json` | 投影 | 通过 replay 重建 | 不参与最终裁决 |
| Task `events.jsonl` | 是 | 否 | TaskSpec、child、终态与 result reference |
| Task `task-read-model.json` | 投影 | 通过 replay 重建 | 可丢弃视图，不是历史 |
| Memory `events.jsonl` | 是 | 否 | revision/Cue/Edge/proposal 引用、capture、生命周期、purge tombstone 和 access 事件 |
| Memory revision/Cue/Edge/proposal/source artifact | 是 | 否 | Artifact Store 中的 canonical 内容；事件发布这些对象 |
| Memory read model/checkpoint | 投影 | 通过 replay 重建 | 普通 status/search 的快速路径，不参与裁决 |
| Memory `index.sqlite` / Markdown | 投影 | `/memory doctor repair-projections` | FTS5、图、时间、heat 和人类可读视图 |
| Memory `source-cursors.json` / `history-cue-cursor.json` / pending result | 恢复数据 | 由 source bridge/controller 管理 | 控制自动发现基线、sealed Segment 增量扫描并复用已生成结果；不是 Memory 事实 |
| Chain `events.jsonl` | 是 | 否 | chain/branch/segment/rollover 拓扑 |
| managed Segment JSONL | 是 | 否 | 完整 Pi session；sealed 后不可变 |
| L1/L2 Artifact object | 是 | 否 | 内容寻址的 Segment summary、Chain Rollup、checkpoint 或 result 内容 |
| `chain-read-model.json` / `catalog.json` | 投影 | 通过 Core rebuild API 重建 | 包含已发布 Rollup 和失败投影 |
| Rollup Markdown | 投影 | 由 repair 路径重建 | doctor 检测缺失或陈旧；不是 L2 事实源 |
| Rollup pending/state | 恢复数据 | 由 Controller 管理 | 复用已生成 artifact，并标记历史自动 backfill 边界 |
| Goal/Task/Chain/Memory write lock | 并发协调 | 只能按 doctor 给出的 nonce 显式修复 | metadata 为 PID、nonce、createdAt；不是业务完成证据 |

“可重建”不等于建议直接删除。优先使用对应 Core rebuild API；Session Chain prepared rollover 和 sealed integrity 使用 `/chain doctor`。保留操作前备份，并先确认损坏的是投影而不是事实源。

## 3. 创建时机

| 动作 | 预期落盘 |
| --- | --- |
| 空的持久 session 收到第一条有效普通请求 | 创建 `.pi-xk/sessions/`、chain 事件与 managed root Segment；启动、命令和空输入本身不落盘 |
| 扩展在已有正文 session 启动 | 记录 external root adoption，不复制原生 session |
| `/goal <objective>` 草案阶段 | 只写 Pi session custom entry，不创建 `.pi-xk/goals/` |
| `/goal confirm` | 创建 Goal V3 目录、事件、合同、objective、state 和 read model |
| `/task start ...` | 创建 Task 目录、事件和独立 child SessionChain |
| 自动或手动 rollover | 创建 L1 artifact、target Segment 和 chain event；完整窗口可能再生成 L2 |
| `/chain rollup backfill [limit]` | 显式生成最早缺失的完整 L2 窗口，可能调用 provider |
| 第一次加载 Memory v1 | 默认启用并记录当前 Goal/Chain head 作为自动捕获 baseline；建立不复制正文的 History Cue cursor/cache；不批量调用模型回填旧历史 |
| 新 Goal checkpoint/completion 或 L2 publication | 后台发现稳定来源并产生 Memory capture；可能调用 provider |
| `/memory remember <text>` | 不调用模型，创建用户确认的 verified Memory |
| `/memory backfill [limit]` | 显式、有限额捕获历史 eligible Goal/L2 source；默认一个、最多 20 |
| compaction | Pi 写带可选标题、原因和 recovery version 的原生 compaction entry；active Goal 另写 checkpoint evidence reference |

如果草案取消，项目中不应出现对应 Goal 目录。若确认过程被中断，create 的幂等恢复会根据已有事实补齐缺失投影，而不是重复 initial event。

## 4. 日常检查

### Goal

```text
/goal status
```

重点检查：

- Intent Anchor 是否仍是用户确认的最终意图，Current Objective 是否仍准确描述当前路径；
- 当前合同 revision 与 `goal-state.md` 的 `contract_revision` 是否一致；
- lifecycle 是 active、paused 还是 ended；
- run 总数、当前 run 和累计 wall/active/busy 时间；
- 当前 branch 是否仍绑定预期 Goal；
- required acceptance 是 verified、missing 还是 unverified；
- wall、active 和 busy 时间的含义是否被正确区分；
- 最近 checkpoint、pause audit、blocker 和 next best action 是否仍成立；
- `goal-state.md` 路径、状态及其中的 `next_best_action`、`blocked_on`、`acceptance_matrix`；旧 State 才回退读取 `acceptance_gaps`。

V3 State 的 `recent_work_log` 最多保留 20 条重要记录。`tried_and_rejected` 应写明每条路径的 `reconsider_when`，避免模型在没有新证据时重复已经失败的方法。

合同修订待确认时使用：

```text
/goal revision show
/goal revision confirm
/goal revision revise <feedback>
/goal revision cancel
```

只有 Current Objective 单字段变化可自动应用。其他字段变化在确认前只存在于 Pi session revision entry，不修改 Goal event log；pending revision 也会阻止 Session Chain rollover。

重启后看到 paused 通常是保守恢复，不是数据丢失。先读状态，再显式 `/goal start`。

### Task

```text
/task status
/task status <taskId>
```

重点检查：

- `running` 是否有 live child；
- terminal status 是 succeeded、failed、cancelled 还是 orphaned；
- succeeded result 是否至少包含一条能证明 expected result 的非空 evidence；
- parent result 是否已经 delivered。

`orphaned` 表示 runtime 无法确认 child 正常收束，不表示 child 的进程或副作用已回滚。需要结合进程、workspace diff 和任务证据继续审计。

### Session Chain

```text
/chain status
/chain history
/chain summary [segmentId]
/chain rollups
/chain rollup <window>
/chain rollup config
/chain doctor
/chain doctor deep
/chain doctor repair-projections
```

`status` 集中显示标题、归档、writable head、size、entry 数、threshold、gate 和后台 Rollup 状态；`history` 查看 branch/segment 拓扑；`summary` 核对 L1；`rollups/rollup` 检查 L2。普通 `doctor` 走 read-model 快速路径；`doctor deep` 才完整 replay、hash Segment 并验证全部 L1/L2；`repair-projections` 只重建 read model、catalog 和 Markdown。

需要同时查看 Chain、Goal、Task 与恢复诊断时使用：

```text
/xk status
```

### Memory

```text
/memory status
/memory search <query>
/memory show <memoryId>
/memory timeline <memoryId>
/memory graph <memoryId> [1|2]
/memory proposals
/memory doctor
/memory doctor deep
/memory doctor repair-projections
```

重点检查：

- event head、read-model checkpoint 和 SQLite head 是否一致；
- trust/freshness/lifecycle 是否被分开解释，尤其不要把 inferred 或 stale 当作 verified current；
- capture 是 scheduled、generating、proposed、applied、failed 还是 indeterminate；
- unresolved proposal 是否需要用户 confirm/reject；
- History Cue 是否只用于定位 L1/compaction 来源，而没有被升级成正式事实；
- write lock 是否属于仍存活进程。

普通 `/memory doctor` 检查 head、index、lock、capture 和 projection metadata；deep 模式完整 replay event、验证全部 artifact/evidence、引用、purge tombstone 和 Markdown digest。repair 只重建 read model、SQLite 与 Markdown。

## 5. 正常生命周期

### Goal

| 事件 | 结果 |
| --- | --- |
| 普通模型回复 | Goal 保持 active，并开始下一 run |
| 模型提交合格 pause intent | checkpoint durable 后转 paused |
| 模型提交合格 end intent | required acceptance 校验与 checkpoint 后转 ended |
| 用户 `/goal pause` | 用户显式暂停 |
| 用户 `/goal end` | 立即 ended，outcome 为用户终止 |
| graceful quit/reload/session switch | open run 中断，active Goal 保守暂停 |
| unclean crash | 下次 startup 恢复 open run，并暂停仍 active Goal |
| model switch | lifecycle 不变 |
| Pi compaction | 写 checkpoint，不暂停；下一次真实 run 接收一次性 recovery system context，不重发用户消息 |
| Session Chain rollover | binding 迁移到 target Segment，不暂停 |

### Task

| 事件 | 结果 |
| --- | --- |
| child 调用 `pi_xk_finish_task` | 写 succeeded/failed result envelope |
| 用户取消 | 请求 abort，并在确认收束后写 cancelled |
| reload/shutdown/tree navigation | 请求取消；五秒内未确认则 orphaned |
| startup 发现 pending | 标记 cancelled |
| startup 发现 running | 标记 orphaned，并补缺失 terminal result message |
| model switch/parent compaction | Task 状态不变；child 保留启动快照 |

### Session Chain

| 事件 | 结果 |
| --- | --- |
| soft threshold + settled + gates clear | 自动 rollover |
| hard threshold + 普通输入 | 先 rollover，再转发输入 |
| hard rollover 失败 | 输入不送给 provider，显示错误 |
| 从历史 tree 位置继续输入 | 创建 successor branch，再转发输入 |
| `/chain continue` | 从指定 Segment/entry 创建 successor branch |
| 达到完整 Rollup 窗口 | rollover commit 后登记后台 publication job，立即进入 successor Segment |
| `/chain rollup config off` | 停止新的自动 L2；既有摘要保持可读 |
| `/chain rollup backfill [limit]` | 显式、有限额补齐历史窗口 |
| sealed Segment hash 变化 | doctor 报 corruption，不自动重写 |

### Memory

| 事件 | 结果 |
| --- | --- |
| 新 stable source | 后台串行 capture；模型结果 canonical read-back 后记录 proposal/application |
| `/memory remember` | 直接写 verified Memory，不调用 provider |
| 模型提出 Memory 变更 | 只记录 CAS 保护 proposal，不直接 apply |
| `/memory config off` | 停止 capture、proposal apply 和 access 写入；既有 Memory 保持只读 |
| SQLite/Markdown 更新失败 | Memory fact 保持已提交；doctor 可重建投影 |
| generation started 后结果未知 | 标记 indeterminate，不自动重复 provider 调用 |
| archive/invalidate | 新 lifecycle revision；旧 artifact 保留 |
| purge | 显式确认、引用检查和 tombstone 后才清理独占 artifact |

Goal completion 的稳定来源不是结束后仍可编辑的 `goal-state.md`，而是 `goal_ended` 前最后一个 `turn_end` checkpoint 所引用的 event-time State artifact。checkpoint artifact、metadata、合同 revision 或 State grammar 不一致时，Memory capture 拒绝该来源。

## 6. Rollup 恢复与诊断

Rollup 发布的故障边界与 rollover 分开：

1. L2 生成失败：rollover 已成功，后台 job 写 `rollup_failed` 诊断并继续新 Segment。
2. artifact 已生成但 event 失败：保留 pending publication；重试复用 artifact，不再次调用模型。
3. event 已写但 read model 缺失/陈旧：从 v1/v2 混合 event log rebuild。
4. Markdown 缺失或陈旧：doctor 报 warning，可从 L2 artifact 重建。
5. artifact、sourceDigest 或 event identity 损坏：doctor 报 error，不自动重写事实源。

后台 publication 每个 branch 串行执行，并由 branch/window generation lock 防止多个进程重复调用模型。状态依次为 `scheduled`、`generating`、`artifact_ready`、`published`，失败为 `failed`。进程退出后，下次启动根据 job/pending/artifact 恢复；非重试型 provenance/schema/config 错误必须先修来源。

无效 L2 响应最多自动尝试 3 次，之后显示 `automatic retries exhausted`，需要审查 prompt/响应合同；provider timeout、临时 I/O 或 event publication 错误不使用该上限。`/chain rollups` 只展示每个窗口的最新 publication，历史失败 attempt 继续留在 event log，不会重复显示成多个当前窗口。

关闭自动 Rollup 不会禁用 doctor 或只读摘要工具。

## 7. Memory Capture 与索引恢复

Memory publication 的恢复边界：

1. 已有模型 result artifact：重新验证并复用，不再次调用 provider。
2. `proposal_recorded` 已存在且无需确认：下一次 stable-source scan 完成 apply，不再次调用 provider。
3. `memory_change_applied` 已写但 read model/SQLite/Markdown 未更新：重放 event tail、应用 event-head CAS delta，或 repair projections。
4. 已知 `capture_failed` 且 `retryable: true`、没有 pending result：后续 stable-source scan 为同一 capture 开始下一 attempt；即使 source cursor 已前移也会重新发现来源。
5. 已知 `capture_failed` 且 `retryable: false`：先修正来源、provenance、schema 或配置，不自动重试。
6. `generation_started` 后没有 result artifact：结果未知，保持 indeterminate；只能在确认 provider 幂等性或用户显式判断后处理。
7. source digest、evidence ownership、schema 或 CAS 无效：报告不可重试事实错误，不移动 cursor 伪装成功。

SQLite 缺失、损坏或与 event head 不一致时：

```text
/memory doctor
/memory doctor deep
/memory doctor repair-projections
```

repair 会先受控重建 History Cue cursor/cache，再固定一个 read-model head；SQLite 已与该 head 一致时复用，否则构建临时数据库，Markdown/manifest 也只使用该快照，最后复核事实 head。它不修改 Memory event、Artifact Store、Goal、Task、Chain 或 transcript。History Cue 和 source cursor 是派生/恢复数据；删除它们会使下一次 repair 重新扫描 sealed Segment，但不能删除已经发布的 Memory facts。

`source-cursors.v1` 会在 sequence 与事实日志一致时原位升级为携带 head hash 的 v2；`history-cue-cursor.v1` 会通过事实重建为带 content digest 的 v2。source cursor 损坏不能自动修复，因为猜测 baseline 可能跳过或重复付费 capture；History Cue cursor 只保存可重建 locator，可由 repair-projections 安全重建。

purge 在 tombstone 中记录可清理的 revision/edge/evidence 和独占 proposal/model-result 内容 artifact。共享 proposal/result、pending 引用以及 Goal/Task/Chain 等其他领域引用会保留；deep doctor 不把 tombstone 已声明删除的独占对象误报为事实损坏。

## 8. Rollover 恢复

两阶段 rollover 的恢复判断基于 chain event 与 session marker，而不是文件修改时间：

1. `rollover_prepared` 已写，但 target 完整且身份匹配：提交 `rollover_committed`。
2. target 缺失，但记录足以确定性重建：重建 target 后提交。
3. target 不可安全使用，source 仍是 writable：写 `rollover_aborted`，继续 source。
4. sealed source 的最终 hash 不匹配：报告 corruption，停止自动修复。

启动同一 chain 时会尝试恢复 prepared rollover。检查结果使用：

```text
/chain doctor deep
```

doctor 只报告事实和恢复需求，不改写 sealed Segment。启动恢复后再次检查：

```text
/chain status
/chain history
```

不要通过复制最新 Segment、修改 event sequence、删除 hash 字段或把任意文件改名成 target 来绕过诊断。这会破坏可重放性。

## 9. 备份与恢复范围

完整恢复一个 Pi-XK 项目至少需要两部分：

1. 项目根的 `.pi-xk/`；
2. 对应 Pi profile 中的原生 session，尤其是被采用为 external root 的历史 session。

只备份 `.pi-xk/` 可能丢失 external root、compaction evidence 的原始正文；只备份 Pi session 又会丢失 Goal/Task/Chain/Memory 事件和 artifact。还应保留项目源码版本与工作区产物，因为 evidence 中可能只保存路径/hash，不复制正文，Git freshness 也依赖 repository identity、baseline 和相关 path。

备份时：

- 先正常退出 Pi，避免复制正在追加的 JSONL；
- 同时保留目录结构、文件名和字节内容；
- 不对 sealed Segment 或 artifact 做文本换行转换；
- 记录 Pi-XK Git revision、Node/Pi 版本和 `PI_CODING_AGENT_DIR`；
- 恢复后先运行 `/chain doctor` 与 `/memory doctor`，再恢复 Goal 或启动新 Task。

当前没有正式 backup/restore CLI、retention policy 或 GC。任何删除都应视为人工数据管理操作。

## 10. 常见故障

### `fd is unavailable`

运行：

```bash
npm run check:pi-xk-runtime
```

Ubuntu/Debian 可安装 `fd-find`；Pi 能识别 `fdfind`。也可以把可信的 `fd` 放入 `<PI_CODING_AGENT_DIR>/bin/fd`。preflight 不下载二进制，也不联系 provider。

### `/goal`、`/task`、`/chain` 或 `/memory` 不存在

依次检查：

1. `packages/pi-xk-extension/dist/extension.js` 是否存在；
2. `pi list` 是否列出本地 package；
3. 安装路径是否仍指向当前 checkout；
4. 是否在 build 后完全重启 Pi；
5. 项目级 package 是否因 trust 设置未加载。

### Goal 重启后自动暂停

这是预期行为。Pi-XK 不把旧 active 状态自动变成新的 live run。使用 `/goal status` 阅读 pause/recovery evidence，确认环境与 blocker，再执行 `/goal start`。

### Goal State revision mismatch

`/goal doctor` 或 `/goal status` 若报告 State revision 落后，先读取当前 `goal-objective.md`，再把 `goal-state.md` 的 `contract_revision`、Current Objective 相关未决项、失败路径和 acceptance matrix 同步到当前 revision。不要修改 Objective 文件，也不要通过删除 State 绕过诊断。State 同步完成后再继续实质工作。

### Goal revision 一直待确认

这是受保护合同字段发生变化时的预期 gate。运行 `/goal revision show` 对比完整 Current/Candidate contract，然后 confirm、revise 或 cancel。审阅正文只显示给用户，不会作为后续模型上下文注入。若 revision 已与较新合同冲突，重新读取 Objective/State 后提出新候选，不能覆盖新 revision。

### Compaction 后重复旧请求

新 compaction 不会追加或重发最后一条用户消息。若模型仍重复旧请求，先检查当前 branch 最新 compaction entry 是否包含 `recoveryPromptVersion: "compaction-recovery-v1"`，以及其后是否已有成功 assistant 响应。旧 entry 没有该字段时不会追溯启用 recovery。不要通过伪造 user/custom message 修复；保留原 transcript，并在下一条真实请求中明确当前任务。

### Task 运行时输入无响应

普通输入不会丢弃，而是进入 Pi 原生 follow-up 队列，待 Task terminal 和结果交付后按顺序处理。`/task status` 与 `/task cancel` 立即执行；会修改 Goal、Chain 或启动另一个 Task 的命令仍被拒绝。父模型与 child 仍不会并发调用模型或同时修改工作区。

### hard threshold 后输入未发送

Pi-XK 在 provider 调用前尝试 rollover。失败时输入被明确保留在“未交付”语义，不会偷偷送入旧 Segment。先查看错误并运行 `/chain doctor`，确认 gate、provider 摘要调用和文件状态后重新提交输入。

### doctor 报 sealed file corruption

停止继续写该 chain，保留原文件和备份。不要让 formatter、同步工具或编辑器改写 JSONL。对比备份与事件记录的 hash，确定是磁盘损坏、人工修改还是错误恢复。当前实现不会自动接受新的 hash。

### Rollup 一直显示 retry pending

先运行 `/chain rollups` 和 `/chain doctor`。输出中的 attempt 是同一窗口的最新 publication 状态，不是多个窗口。确认 L1 artifact 完整、当前 model 可用、配置 interval 未改变来源预期，并检查 `.pi-xk/sessions/chains/<chain>/branches/<branch>/rollups/` 是否存在 pending publication。不要删除 artifact 或修改 event；可使用 `/chain rollup backfill` 重试最早缺失窗口。若显示 `automatic retries exhausted`，先审查 L2 输出合同或模型兼容性，不要继续机械重试无效响应。

### doctor 报 abandoned write lock

Goal、Task、Chain、Memory 使用相同的 PID/nonce 锁协议。只有 owner PID 明确不存在且 nonce 与检查结果完全一致时，才允许显式修复：

```text
/goal doctor
/goal doctor repair-lock <nonce>
/task doctor [taskId]
/task doctor [taskId] repair-lock <nonce>
/chain doctor
/chain doctor repair-lock <nonce>
/memory doctor
/memory doctor repair-lock <nonce>
```

owner 仍存活、PID 状态无法确认、metadata malformed 或 nonce 已变化时都会拒绝删除。不要按锁年龄猜测，也不要手工删 `.write.lock`。

### Memory 显示 indeterminate capture

这表示 `generation_started` 已提交，但没有可证明的 result artifact。provider 可能已经计费并返回，也可能根本没有完成。Pi-XK 不自动重试，以免产生重复付费调用和重复事实。保留 pending/event/artifact 现场，运行 `/memory doctor deep`；只有确认 provider 幂等 key 可复用或用户明确决定重试时再处理。

如果 doctor 显示 `capture_failed_retryable`，这是结果已知的失败，下一次匹配 stable-source boundary 可以安全开始新 attempt；`capture_failed_non_retryable` 则要求先修正来源或配置。两者都不等同于 indeterminate。

### Memory index missing/corrupt/stale

先运行 `/memory doctor` 区分事实错误和投影错误。仅当 event/artifact 验证通过时执行 `/memory doctor repair-projections`。不要通过删除 `events.jsonl` 或 artifact 让 SQLite 看起来一致。

如果 session startup 报 History Cue cursor invalid，普通刷新会停止并保留现场；`/memory doctor repair-projections` 会从 sealed Segment 的标题和 compaction locator 受控重建该 cursor。稳定 chain 的日常刷新只比较 chain head，不会重复打开全部历史 Segment。

### Memory proposal 一直未处理

使用 `/memory proposals` 和 `/memory proposal show <id>` 检查。模型主动提出的变更、既有 Memory 修订、verified/lifecycle/evidence/purge 变更不会自动 apply；需要用户 confirm 或 reject。event head/revision 已变化时，旧 proposal 的 CAS 会拒绝覆盖新事实。

### Memory freshness 变为 stale/unknown

`stale` 表示相关 scope path 与捕获基线不一致或来源消失；无关 dirty 文件不会触发。`unknown` 表示 Git/source 无法确定。`/memory refresh <id>` 只重新计算投影和 freshness，不调用模型、不会把旧结论改成 current。

## 11. 更新与移除

受支持的本地管理入口为：

```bash
npm run pi-xk:install -- --dry-run
npm run pi-xk:install
npm run pi-xk:upgrade
npm run pi-xk:uninstall
```

可用 `--agent-dir <path>` 指定隔离 profile；`--dry-run` 不构建也不写 settings。install/upgrade 会构建并运行 runtime preflight，uninstall 只删除该 checkout 的 package 引用。然后正常退出并重启 Pi。不要在 active Goal 或 running Task 中热切换不兼容代码；reload 会触发保守暂停/取消语义。

移除扩展只删除 Pi settings 中的 package 引用，不删除项目数据，包括 Memory event、artifact、SQLite 和 Markdown。若需要归档项目，优先保留 `.pi-xk/` 和原生 session；确认不再需要且备份可用后，才单独处理这些目录。
