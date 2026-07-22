# ADR 0005：Session Chain v1 链式会话与物理分段

- 状态：Accepted
- 日期：2026-07-22
- 作用域：`pi-xk-core`、`pi-xk-extension`、`coding-agent` 的最小通用 host API

## 背景

Pi compaction 只改变发送给模型的上下文投影，不删除旧 entry，也不缩小原生 session JSONL。`SessionManager` 打开 session 时会读取完整文件并建立内存索引，session picker 还会聚合全部消息文本。长期会话因此会持续增加恢复时间、常驻内存和浏览成本。

Task Run v1 的 child transcript 隔离只定义子代理工作边界。把一个 Task 等同于一个物理会话段，既不能分段父会话，也无法表达一个长 Task 自身跨多个物理文件。因此 Task、逻辑会话链、物理会话段和 compaction 必须是四个独立对象。

## 决策

### Session Chain 与 Segment

`SessionChain` 表示用户感知的长期逻辑会话。每条 branch 由一个或多个 `SessionSegment` 构成；每个 Segment 都是完整合法的 Pi 原生 JSONL，并可被 Pi 单独打开。Pi-XK 不引入第二种 transcript 格式，也不复制旧正文。

项目级布局固定为：

```text
<project>/.pi-xk/sessions/
├── catalog.json
└── chains/<chainId>/
    ├── events.jsonl
    ├── chain-read-model.json
    ├── locks/
    └── branches/<branchId>/segments/<ordinal>_<sessionId>.jsonl
```

`events.jsonl` 是链拓扑的唯一事实源；read model 和 catalog 均可删除重建。新链使用项目级 managed Segment。既有 Pi 全局 session 可作为不复制的 `external-root` 被采用，后续 Segment 进入项目目录。

Pi `SessionHeader.parentSession` 继续只表达 fork/clone，不用于顺序接力。Segment ID 直接复用 Pi session ID，不维护第二个物理文件身份。每条 branch 同时最多有一个 writable head；sealed Segment 永久只读。

### 递进摘要

每个封存 Segment 的逻辑布局是：

```text
SessionHeader
session_chain_link
summary-in
Pi 原生正文 entries
summary-out
```

`summary-in` 是前一 Segment 的 carry-forward；`summary-out` 同时保存本段 delta 与融合后的 carry-forward。摘要以 `pi-xk.segment-summary.v1` artifact 持久化，携带 source entry 范围/hash、base summary、模型、prompt 版本和 token provenance。新段只注入同一 artifact 中经 hash 校验的 carry-forward，不复制旧 transcript。

Segment 内存在 Pi compaction 时，递进摘要以最新 compaction summary 为 base，只处理该 compaction 保留边界后的尾部；没有 compaction 时以 `summary-in` 为 base。摘要失败不得 seal 或切换 Segment。摘要是派生上下文，不是对话事实。

### 两阶段 rollover

事件类型固定为：

- `chain_created`
- `rollover_prepared`
- `rollover_committed`
- `rollover_aborted`
- `branch_created`
- `chain_metadata_updated`

写入沿用 Goal/Task 的 sequence、hash chain、idempotency key、CAS head、单链写锁、fsync、尾部半行诊断和显式修复。`rollover_prepared` 把源 Segment 从 active 投影为 prepared，并保存 staged target；target 在 commit 前不是 branch head。`rollover_committed` 原子地把源投影为 sealed、发布 target 为 active head；abort 恢复源为 active。

rollover 只允许在 agent fully settled、输入队列为空、无运行或待交付 Task、无 Goal draft 和未结算 lifecycle intent 时执行。目标 JSONL 与源 `summary-out` durable 后才能提交领域事件。prepared 崩溃恢复必须根据两端 marker 幂等 commit、重建目标或 abort，不能伪造完成。

### Host 边界

Extension 普通事件上下文没有安全的 runtime replacement 能力，现有 `newSession` 又会触发 Goal 的真正 shutdown 语义。因此增加两个小型、通用的 coding-agent host 扩展点：

- `summarizeSessionContext`：复用 Pi 当前模型、认证和 summarizer，但不修改 transcript；
- `rolloverSession`：只在 settled 边界创建目标 session、执行 durable 初始化与领域 commit，再替换 runtime。

生命周期增加 `reason: "rollover"` 和可取消的 `session_before_rollover`。rollover 是同一逻辑会话内部切换，不暂停 active Goal；quit、reload、new、resume、fork 和真实历史分支继续遵循现有暂停规则。Agent loop、provider transport 和原生 message/session entry schema 不变。

### 与 Task 和 compaction 的关系

Task 可从普通会话或 Goal 启动，只引用父 `chainId/branchId/segmentId/entryId`。新 Task child 拥有自己的 SessionChain；单次 Task 通常只有一个 Segment，但合同不再把两者等同。Task V1 事件保持原 hash，读取时 upcast，不迁移原 child JSONL。

compaction 继续按 context token 触发；rollover 独立按物理字节数、entry 数和实测加载成本触发。v1 soft threshold 为 16 MiB/4,000 entries，hard threshold 为 64 MiB/16,000 entries，只在 settled 边界评估。

## 后果

正面后果：

- 长期父会话和 child 会话都能限制单文件加载与内存成本；
- Pi 原生 JSONL、tree、provider 和 compaction 保持可用；
- Task、Goal 与会话物理布局不再互相冒充；
- rollover 崩溃可以从事件和 marker 恢复到明确状态。

代价：

- Pi-XK 需要维护一个很小的 upstream-compatible host patch；
- 原生 `/resume` 仍面向物理 session，逻辑会话通过 `/chain` 管理；
- 跨 Segment 历史导航不能伪装成单文件 `/tree`，继续旧历史必须创建 successor branch。

## V1 明确不做

- 不实现第二套 transcript、历史正文复制或 `children_uuids` 反向事实；
- 不实现长期 memory、全文索引、retention/GC；
- 不实现并发 Task、DAG、retry、预算、worktree、RPC child、Policy 或沙箱；
- 不让模型直接调用 seal、commit 或 recovery 工具。
