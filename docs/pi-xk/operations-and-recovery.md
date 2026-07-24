# Pi-XK 运维与恢复

本文面向需要检查落盘状态、备份项目、诊断中断和安全移除扩展的使用者。Pi-XK 当前没有独立 daemon 或服务端；“运维”主要是 Pi profile、项目 `.pi-xk/`、原生 session 与事件日志之间的一致性管理。

## 1. 数据位置

### 项目级 Pi-XK 数据

```text
.pi-xk/
  artifacts/
    objects/<hash-prefix>/
      <content-hash>.data
      <content-hash>.json
  goals/<goalId>/
    events.jsonl
    contract.json
    goal-objective.md
    goal-state.md
    goal-read-model.json
  tasks/<taskId>/
    events.jsonl
    task-read-model.json
    session/                         # 仅 Task V1 历史兼容
      <child-session>.jsonl
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
| Goal `goal-state.md` | 是，执行状态 | 否 | 模型维护的当前进度、证据和下一动作 |
| Goal `contract.json` / `goal-objective.md` | 投影 | 通过 Core 恢复路径 | 必须与完整合同投影一致 |
| Goal `goal-read-model.json` | 投影 | 通过 replay 重建 | 不参与最终裁决 |
| Task `events.jsonl` | 是 | 否 | TaskSpec、child、终态与 result reference |
| Task `task-read-model.json` | 投影 | 通过 replay 重建 | 可丢弃视图，不是历史 |
| Chain `events.jsonl` | 是 | 否 | chain/branch/segment/rollover 拓扑 |
| managed Segment JSONL | 是 | 否 | 完整 Pi session；sealed 后不可变 |
| L1/L2 Artifact object | 是 | 否 | 内容寻址的 Segment summary、Chain Rollup、checkpoint 或 result 内容 |
| `chain-read-model.json` / `catalog.json` | 投影 | 通过 Core rebuild API 重建 | 包含已发布 Rollup 和失败投影 |
| Rollup Markdown | 投影 | 由 repair 路径重建 | doctor 检测缺失或陈旧；不是 L2 事实源 |
| Rollup pending/state | 恢复数据 | 由 Controller 管理 | 复用已生成 artifact，并标记历史自动 backfill 边界 |

“可重建”不等于建议直接删除。优先使用对应 Core rebuild API；Session Chain prepared rollover 和 sealed integrity 使用 `/chain doctor`。保留操作前备份，并先确认损坏的是投影而不是事实源。

## 3. 创建时机

| 动作 | 预期落盘 |
| --- | --- |
| 扩展在空 session 启动 | 创建 `.pi-xk/sessions/`、chain 事件与 managed root Segment |
| 扩展在已有正文 session 启动 | 记录 external root adoption，不复制原生 session |
| `/goal <objective>` 草案阶段 | 只写 Pi session custom entry，不创建 `.pi-xk/goals/` |
| `/goal confirm` | 创建 Goal 目录、事件、合同、objective、state 和 read model |
| `/task start ...` | 创建 Task 目录、事件和独立 child SessionChain |
| 自动或手动 rollover | 创建 L1 artifact、target Segment 和 chain event；完整窗口可能再生成 L2 |
| `/chain rollup backfill [limit]` | 显式生成最早缺失的完整 L2 窗口，可能调用 provider |
| compaction | Pi 写原生 compaction entry；active Goal 另写 checkpoint evidence reference |

如果草案取消，项目中不应出现对应 Goal 目录。若确认过程被中断，create 的幂等恢复会根据已有事实补齐缺失投影，而不是重复 initial event。

## 4. 日常检查

### Goal

```text
/goal status
```

重点检查：

- lifecycle 是 active、paused 还是 ended；
- 当前 branch 是否仍绑定预期 Goal；
- required acceptance 是否有对应证据；
- wall、active 和 busy 时间的含义是否被正确区分；
- pause audit 记录的 blocker 和 next best action 是否仍成立。

重启后看到 paused 通常是保守恢复，不是数据丢失。先读状态，再显式 `/goal start`。

### Task

```text
/task status
/task status <taskId>
```

重点检查：

- `running` 是否有 live child；
- terminal status 是 succeeded、failed、cancelled 还是 orphaned；
- result artifact 与 evidence 是否存在；
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
```

`status` 用于看 writable head、size、entry 数、threshold 和 gate；`history` 用于看 branch/segment 拓扑；`summary` 用于核对 L1；`rollups/rollup` 用于检查 L2；`doctor` 用于 replay、prepared rollover recovery、L1/L2 provenance、sealed hash 和 Markdown 诊断。

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
| Pi compaction | 写 checkpoint，不暂停 |
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
| 达到完整 Rollup 窗口 | rollover commit 后尝试生成 L2；失败不阻塞会话 |
| `/chain rollup config off` | 停止新的自动 L2；既有摘要保持可读 |
| `/chain rollup backfill [limit]` | 显式、有限额补齐历史窗口 |
| sealed Segment hash 变化 | doctor 报 corruption，不自动重写 |

## 6. Rollup 恢复与诊断

Rollup 发布的故障边界与 rollover 分开：

1. L2 生成失败：rollover 已成功，写 `rollup_failed` 诊断并继续新 Segment。
2. artifact 已生成但 event 失败：保留 pending publication；重试复用 artifact，不再次调用模型。
3. event 已写但 read model 缺失/陈旧：从 v1/v2 混合 event log rebuild。
4. Markdown 缺失或陈旧：doctor 报 warning，可从 L2 artifact 重建。
5. artifact、sourceDigest 或 event identity 损坏：doctor 报 error，不自动重写事实源。

`/chain doctor` 在命令路径上会先恢复 prepared rollover，再报告诊断。关闭自动 Rollup 不会禁用 doctor 或只读摘要工具。

## 7. Rollover 恢复

两阶段 rollover 的恢复判断基于 chain event 与 session marker，而不是文件修改时间：

1. `rollover_prepared` 已写，但 target 完整且身份匹配：提交 `rollover_committed`。
2. target 缺失，但记录足以确定性重建：重建 target 后提交。
3. target 不可安全使用，source 仍是 writable：写 `rollover_aborted`，继续 source。
4. sealed source 的最终 hash 不匹配：报告 corruption，停止自动修复。

运行：

```text
/chain doctor
```

doctor 可能恢复 prepared rollover，也会输出诊断。执行后再次检查：

```text
/chain status
/chain history
```

不要通过复制最新 Segment、修改 event sequence、删除 hash 字段或把任意文件改名成 target 来绕过诊断。这会破坏可重放性。

## 8. 备份与恢复范围

完整恢复一个 Pi-XK 项目至少需要两部分：

1. 项目根的 `.pi-xk/`；
2. 对应 Pi profile 中的原生 session，尤其是被采用为 external root 的历史 session。

只备份 `.pi-xk/` 可能丢失 external root 的原始正文；只备份 Pi session 又会丢失 Goal/Task/Chain 事件和 artifact。还应保留项目源码版本与工作区产物，因为 evidence 中可能只保存路径/hash，不复制正文。

备份时：

- 先正常退出 Pi，避免复制正在追加的 JSONL；
- 同时保留目录结构、文件名和字节内容；
- 不对 sealed Segment 或 artifact 做文本换行转换；
- 记录 Pi-XK Git revision、Node/Pi 版本和 `PI_CODING_AGENT_DIR`；
- 恢复后先运行 `/chain doctor`，再恢复 Goal 或启动新 Task。

当前没有正式 backup/restore CLI、retention policy 或 GC。任何删除都应视为人工数据管理操作。

## 9. 常见故障

### `fd is unavailable`

运行：

```bash
npm run check:pi-xk-runtime
```

Ubuntu/Debian 可安装 `fd-find`；Pi 能识别 `fdfind`。也可以把可信的 `fd` 放入 `<PI_CODING_AGENT_DIR>/bin/fd`。preflight 不下载二进制，也不联系 provider。

### `/goal`、`/task` 或 `/chain` 不存在

依次检查：

1. `packages/pi-xk-extension/dist/extension.js` 是否存在；
2. `pi list` 是否列出本地 package；
3. 安装路径是否仍指向当前 checkout；
4. 是否在 build 后完全重启 Pi；
5. 项目级 package 是否因 trust 设置未加载。

### Goal 重启后自动暂停

这是预期行为。Pi-XK 不把旧 active 状态自动变成新的 live run。使用 `/goal status` 阅读 pause/recovery evidence，确认环境与 blocker，再执行 `/goal start`。

### Task 运行时输入无响应

普通输入被有意拦截。使用 `/task status` 或 `/task cancel`。Pi-XK 不支持在同一 parent 同时继续对话并让 Task 后台运行。

### hard threshold 后输入未发送

Pi-XK 在 provider 调用前尝试 rollover。失败时输入被明确保留在“未交付”语义，不会偷偷送入旧 Segment。先查看错误并运行 `/chain doctor`，确认 gate、provider 摘要调用和文件状态后重新提交输入。

### doctor 报 sealed file corruption

停止继续写该 chain，保留原文件和备份。不要让 formatter、同步工具或编辑器改写 JSONL。对比备份与事件记录的 hash，确定是磁盘损坏、人工修改还是错误恢复。当前实现不会自动接受新的 hash。

### Rollup 一直显示 retry pending

先运行 `/chain rollups` 和 `/chain doctor`。确认 L1 artifact 完整、当前 model 可用、配置 interval 未改变来源预期，并检查 `.pi-xk/sessions/chains/<chain>/branches/<branch>/rollups/` 是否存在 pending publication。不要删除 artifact 或修改 event；可使用 `/chain rollup backfill` 重试最早缺失窗口。

## 10. 更新与移除

本地 package 引用不会自动更新构建产物。更新仓库后：

```bash
npm --workspace pi-xk-core run build
npm --workspace pi-xk-extension run build
npm run check:pi-xk-runtime
```

然后正常退出并重启 Pi。不要在 active Goal 或 running Task 中热切换不兼容代码；reload 会触发保守暂停/取消语义。

移除扩展只删除 Pi settings 中的 package 引用，不删除项目数据。若需要归档项目，优先保留 `.pi-xk/` 和原生 session；确认不再需要且备份可用后，才单独处理这些目录。
