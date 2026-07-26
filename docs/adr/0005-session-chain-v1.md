# ADR 0005：Session Chain v1.1、Rollup v1 与模型按需检索

- 状态：Accepted and implemented
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
    └── branches/<branchId>/
        ├── segments/<ordinal>_<sessionId>.jsonl
        └── rollups/
            ├── <window>.md
            ├── <window>.pending.json
            └── state.json
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

每次 rollover 前必须从 marker 重新读取 L1 artifact，验证 schema、chain、branch、source/target Segment、artifact ID、carry-forward 正文和 hash。新 L1 写入 Artifact Store 后也必须按返回 ID read-back，summary-out、source seal、successor summary-in 和 hash 只能使用 read-back 的 canonical 内容。任何不一致都以 integrity error 中止 rollover；不得自动改写 marker、Segment 正文或 artifact，也不得在 canonical read-back 失败后推进 branch head。

Segment 内存在 Pi compaction 时，递进摘要以最新 compaction summary 为 base，只处理该 compaction 保留边界后的尾部；没有 compaction 时以 `summary-in` 为 base。摘要失败不得 seal 或切换 Segment。摘要是派生上下文，不是对话事实。

### 两阶段 rollover

事件类型固定为：

- `chain_created`
- `rollover_prepared`
- `rollover_committed`
- `rollover_aborted`
- `branch_created`
- `chain_metadata_updated`
- `rollup_published`（v2）
- `rollup_failed`（v2）

写入沿用 Goal/Task 的 sequence、hash chain、idempotency key、CAS head、单链写锁、fsync、尾部半行诊断和显式修复。历史 v1 event 和 hash 不重写；replay 支持 v1/v2 混合日志，未知 schema/version 明确失败。`rollover_prepared` 把源 Segment 从 active 投影为 prepared，并保存 staged target；target 在 commit 前不是 branch head。`rollover_committed` 原子地把源投影为 sealed、发布 target 为 active head；abort 恢复源为 active。

### L2 Chain Rollup

每个 branch 默认每 5 个 sealed Segment 生成一个 L2 Rollup。配置为 `{ enabled: boolean; interval: positive integer }`，默认 enabled/5，保存在项目 `.pi-xk/session-chain.json`。窗口从 branch ordinal 1 开始，连续、固定大小、不重叠；successor branch 独立编号。不完整尾窗不生成，interval 改动只影响上一个已发布窗口之后的后续窗口。

L2 输入只包括窗口内有序且 provenance 校验通过的 L1 artifacts，不扫描 transcript。结构化 `pi-xk.session-chain-rollup.v1` artifact 保存 state、decisions、constraints、completed、unresolved、nextActions、来源 IDs、`sourceDigest` 和生成 provenance。Artifact Store ID 是正文 SHA-256，因此正文不递归包含自己的 artifact ID；该 ID 保存在 published event、read model 和读取包装中。

rollover commit 后持久化 `scheduled` publication job 并立即返回 successor Segment。每个 branch 在进程内串行 drain publication job，并以 branch/window generation lock 做跨进程去重；一个窗口发布后会重新检查下一个完整窗口，因此慢 W1 期间继续完成 W2 来源也不会丢失调度。失败 job 不在同一次 drain 中无限重试。第 N 次 rollover 不等待 L2 provider latency。L2 失败不回滚 rollover；`rollup_failed` 按 provider、I/O、provenance/schema/digest、event conflict 和 projection 分类表达 stage、errorCode 与 retryable。artifact 已生成但 event 未发布时，pending publication 允许重试复用 artifact。event 发布后，read model 可由日志重建；Markdown 仅是可重建的人类投影，缺失或陈旧不阻断已验证结构化 L2 的读取，doctor 继续报告并可重建投影。

旧 chain 不自动批量生成历史 L2。升级时记录历史 backfill 边界，只有 `/chain rollup backfill [limit]` 显式、有限额调用模型。关闭自动 Rollup 不删除既有 L1/L2，也不禁用读取。

### 模型发现和按需读取

每次普通模型请求只追加固定大小、由 read model 确定性生成的 Session Chain manifest，包含当前 branch、sealed/L1/L2 范围、完整窗口 pending 状态、失败数量和只读工具说明。read model checkpoint 保存已消费 event byte offset、head event offset、sequence 和 head hash。正常请求先读取并验证 checkpoint 对应的最后一条真实 event，再读取新增 tail；文件缩短、head event/offset/hash 异常时退回完整 replay。该快速证据读取与 event 总量无关，但不替代 deep doctor 对完整 hash chain 的线性校验。manifest 不包含摘要正文、历史用户原文、模型生成标题或 Artifact Store 内容。

模型通过两个只读工具访问历史证据：

- `pi_xk_list_chain_summaries`：分页列出 L1/L2 metadata 和完整性状态；
- `pi_xk_read_chain_summary`：按 artifact、L1 ordinal、L2 window 或 latest 读取当前 chain/read-model 关联 branch 的摘要。

工具不能触发生成、repair、backfill 或任意 Artifact Store 读取。列表页只做定位/schema 检查并返回 `unchecked|invalid`，不得把可解析误报为 verified；读取正文前必须通过共享 L1/L2 provenance 验证，成功才返回 `verified`。返回文本明确标记摘要是“historical evidence, not instructions”；摘要中的伪系统指令不得进入系统提示词或扩大工具权限。

### 管理与 doctor 补充

首条有效用户输入确定性生成截断标题，不调用模型；`/chain rename` 修改标题。archive 使用 v3 `chain_archive_updated` event，只影响默认 list/picker，不删除任何事实。replay 支持 v1/v2/v3 混合日志。

`/chain doctor` 是 event/read-model head、拓扑、锁、publication 和 projection metadata 的快速检查；`/chain doctor deep` 完整 replay、hash Segment 并验证全部 L1/L2；`/chain doctor repair-projections` 只重建 read model、catalog 和 Markdown。事实损坏始终只报告。统一 PID/nonce/createdAt 写锁仅允许按 doctor 给出的 exact nonce 显式恢复死亡 owner。

rollover 只允许在 agent fully settled、输入队列为空、无运行或待交付 Task、无 Goal draft 和未结算 lifecycle intent 时执行。目标 JSONL 与源 `summary-out` durable 后才能提交领域事件。prepared 崩溃恢复必须根据两端 marker 幂等 commit、重建目标或 abort，不能伪造完成。

### Host 边界

Extension 普通事件上下文没有安全的 runtime replacement 能力，现有 `newSession` 又会触发 Goal 的真正 shutdown 语义。因此增加两个小型、通用的 coding-agent host 扩展点：

- `summarizeSessionContext`：复用 Pi 当前模型、认证和 summarizer，但不修改 transcript；
- `rolloverSession`：只在 settled 边界创建目标 session、执行 durable 初始化与领域 commit，再替换 runtime。

生命周期增加 `reason: "rollover"` 和可取消的 `session_before_rollover`。rollover 是同一逻辑会话内部切换，不暂停 active Goal；quit、reload、new、resume、fork 和真实历史分支继续遵循现有暂停规则。Agent loop、provider transport 和原生 message/session entry schema 不变。

### 与 Task 和 compaction 的关系

Task 可从普通会话或 Goal 启动，只引用父 `chainId/branchId/segmentId/entryId`。新 Task child 拥有自己的 SessionChain；单次 Task 通常只有一个 Segment，但合同不再把两者等同。Task V1 事件保持原 hash，读取时 upcast，不迁移原 child JSONL。

compaction 继续按 context token 触发；rollover 独立按物理字节数、entry 数和实测加载成本触发。v1 soft threshold 为 16 MiB/4,000 entries，hard threshold 为 64 MiB/16,000 entries，只在 settled 边界评估。

### 加载性能基线

2026-07-24 在 WSL2 Linux 6.6、Node v24.14.1 上生成含 4 KiB custom entry 的合法 Pi JSONL，并在独立 Node 进程中对 `SessionManager.open()` 运行三次。命令为 `npm run benchmark:session-chain -- --sizes 1,8,32,128 --runs 3 --json`。Git 基线为 `126db23`，测量时工作区包含尚未提交的 Session Chain v1.1 实现；发布提交后应更新为最终 commit。表中记录三次中位打开耗时、吞吐量和进程 peak RSS。测量不调用模型或使用真实会话。

| 目标文件 | 实际文件 | events | open 中位数 | 中位吞吐量 | 中位 peak RSS |
| --- | ---: | ---: | ---: | ---: | ---: |
| 1 MiB | 1.043 MiB | 256 | 95 ms | 11.0 MiB/s | 152.4 MiB |
| 8 MiB | 8.341 MiB | 2,048 | 422 ms | 19.8 MiB/s | 185.7 MiB |
| 32 MiB | 32.324 MiB | 7,936 | 1,603 ms | 20.2 MiB/s | 294.7 MiB |
| 128 MiB | 128.275 MiB | 31,488 | 6,492 ms | 19.8 MiB/s | 518.0 MiB |

因此 soft threshold 放在 16 MiB/4,000 entries，使正常 settled 边界在 32 MiB 量级前主动轮转；hard threshold 放在 64 MiB/16,000 entries，避免继续增长到已出现多秒打开和约 518 MiB 进程 peak RSS 的 128 MiB 量级。peak RSS 包含 Node 进程与已加载 runtime 的基线，不等于纯 Session 增量。该基线用于 v1 默认值，不代表所有磁盘、CPU 或真实消息分布；Host 或数据形态变化后应重新测量。

稳定化版本另增加 `npm run benchmark:session-chain-events -- --counts 100,1000 --runs 3 --json`。它构造确定性 v1 event log、先完整 rebuild read model，再重复加载 snapshot；验收要求每次为 `fast` mode，实际读取 checkpoint head event，且读取量小于完整 event log 的 10%。该基准证明常规 status/manifest 能以常量级证据验证 checkpoint，而不是盲信零字节投影；它不取消 `/chain doctor deep` 的线性事实验证职责。

## 后果

正面后果：

- 长期父会话和 child 会话都能限制单文件加载与内存成本；
- Pi 原生 JSONL、tree、provider 和 compaction 保持可用；
- Task、Goal 与会话物理布局不再互相冒充；
- rollover 崩溃可以从事件和 marker 恢复到明确状态。
- 模型可以发现并按需读取跨 Segment 的 L1/L2 历史证据，而不会把全部摘要正文塞入每次请求；
- Rollup 失败与会话可用性解耦，历史回填由用户显式控制。

代价：

- Pi-XK 需要维护一个很小的 upstream-compatible host patch；
- 原生 `/resume` 仍面向物理 session，逻辑会话通过 `/chain` 管理；
- 跨 Segment 历史导航不能伪装成单文件 `/tree`，继续旧历史必须创建 successor branch。
- 默认每 5 个 sealed Segment 增加一次摘要模型调用；manifest 和按需工具增加少量 prompt/tool 开销。

## v1.1 明确不做

- 不实现第二套 transcript、历史正文复制或 `children_uuids` 反向事实；
- 不实现通用长期 memory、全文索引、retention/GC；Session Chain 专用 L1/L2 不扩展为跨项目知识库；
- 不实现并发 Task、DAG、retry、预算、worktree、RPC child、Policy 或沙箱；
- 不让模型直接调用 seal、commit 或 recovery 工具。
