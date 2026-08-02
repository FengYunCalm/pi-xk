# ADR-0007：项目级证据图 Memory v1

> **状态**：Accepted and implemented
>
> **日期**：2026-08-02
>
> **决策范围**：项目级长期记忆的事实源、图模型、信任/新鲜度/生命周期、捕获与检索协议、SQLite 投影、模型权限和恢复。
>
> **关联设计**：[ADR-0002 Artifact Store](0002-artifact-store-v1.md)、[ADR-0005 Session Chain](0005-session-chain-v1.md)、[ADR-0006 Goal V3 与 compaction recovery](0006-goal-v3-and-compaction-recovery.md)、[Memory v1 使用与边界](../pi-xk/memory-v1.md)

## 背景

Goal V3 已能保存稳定目标合同和当前执行台账，Session Chain v1.1 已能按 Segment 标题与 L1/L2 摘要恢复一条逻辑会话，但两者都不是跨 Goal、Task、branch 和重启的项目知识层。

固定目录树无法表达一条经验同时适用于多个模块、工作流和历史决定；把所有历史摘要塞进 system prompt 又会浪费上下文，并把模型生成文本误当成指令。完全交给模型自由写文件则缺少 schema、CAS、证据归属、崩溃恢复和并发边界。

本决策参考了以下思想，但不复制其事实源或运行时：

- [Memory is Reconstructed, Not Retrieved: Graph Memory for LLM Agents](https://arxiv.org/abs/2606.06036)：cue、关联图和推理期逐步重建优于一次静态 retrieve-then-reason；
- [Magic Context](https://github.com/cortexkit/magic-context)：捕获、整合、按需 recall、可重建 SQLite 和 context/memory 主机制互斥；
- Pi 生态中的 `pi-memory`、`pi-hermes-memory`、`pi-observational-memory` 与 EvoMemory 类实现：人类可读投影、FTS、经验提炼和自动演进都有价值，但不能建立第二 transcript、正则主导真相或无审批自修改。

## 决策

### 1. Memory 是项目级、有类型、有方向的多重图

Memory v1 不使用固定树。图中有三类事实对象：

- `MemoryRevisionV1`：事实、决定、约束、偏好、流程、教训、结果或开放问题；
- `CueNodeV1`：项目、领域、组件、符号、工作流或主题关键词；
- `MemoryEdgeV1`：`part_of`、`depends_on`、`implements`、`applies_to`、`caused_by`、`supports`、`contradicts`、`supersedes`、`related_to`。

边的事实语义有方向；检索可以从任一端进行一至二跳邻接探索，以支持联想式 recall。多个不同关系可以连接同一对端点。自环、未知关系、缺失端点和越权 scope 均拒绝发布。

Session Chain L1/compaction 标题只进入可重建的 History Cue 索引。标题可以帮助模型定位历史范围，但不会自动创建 CueNode、MemoryRevision 或 verified 事实。

### 2. Artifact Store 与 Memory event log 共同构成事实源

项目布局固定为：

```text
.pi-xk/memory/
  .write.lock
  events.jsonl
  memory-read-model.json
  memory-read-model.checkpoint.json
  memory-config.json
  source-cursors.json
  history-cue-cursor.json
  index.sqlite
  locks/                         # capture generation and projection locks
  pending/
  projections/
    manifest.json
    index.md
    memories/<memoryId>.md
```

- Artifact Store 保存不可变 revision、cue、edge、proposal、capture source 和模型生成结果；
- `.pi-xk/memory/events.jsonl` 以引用发布这些对象，并保存生命周期、删除 tombstone 和访问事件；
- read model、checkpoint、SQLite、History Cue、source cursor 与 Markdown 都是可删除重建或重新发现的投影/恢复状态，不参与事实裁决。

事件 schema 为 `pi-xk.memory-event.v1`：

- `capture_scheduled`
- `generation_started`
- `capture_failed`
- `capture_skipped`
- `proposal_recorded`
- `memory_change_applied`
- `proposal_rejected`
- `memory_lifecycle_changed`
- `evidence_detached`
- `memory_purged`
- `access_recorded`

事件复用 stable JSON、sequence、previous hash、idempotency key、expected head CAS、PID/nonce/createdAt 写锁、完整行 append/fsync 和 checkpointed tail replay。未知事件版本明确失败，历史事实不原地迁移。

### 3. 可信度、新鲜度和生命周期彼此独立

每次模型读取统一返回：

```text
trust      = verified | model_inferred | disputed
freshness  = current | stale | unknown
lifecycle  = active | superseded | invalidated | archived
```

- `verified` 只用于用户显式保存的内容，或未来由 Host 确定性证明的事实；来源 artifact 完整不等于其中的模型结论 verified；
- 自动模型捕获只能产生 `model_inferred` 或 `disputed`；
- 冲突事实通过新 revision/`contradicts` 关系表达，不静默覆盖旧结论；
- lifecycle 决定是否参与普通搜索，但不改变历史 revision；
- freshness 不固定写死。代码相关 Memory 保存 repository identity、baseline commit、scope paths 和捕获时 path digest；读取时只比较相关路径。无关 dirty 文件不使其 stale，相关路径变化或消失才 stale，Git/来源无法确认时为 unknown。

`effectiveFrom/effectiveTo` 表达事实有效时间，`provenance.recordedAt` 表达系统记录时间；`asOf` 查询按有效时间过滤。

### 4. 模型负责语义提炼，Host 负责发布权限

模型可提出：

- 哪些稳定来源具有长期价值；
- 应创建或修订哪些 Memory、Cue 和 Edge；
- 当前问题是否需要 D1/D2/D3 检索；
- settled topic boundary 是否值得请求 compaction。

Host 必须负责：

- 精确 schema、大小、scope、source digest 和 evidence ownership 校验；
- capture/proposal ID、Artifact Store canonical read-back、event head/revision CAS；
- 自动应用边界、用户确认、锁、幂等、索引重建和崩溃恢复；
- 不让 Memory 直接改写 Goal、Goal State、Task、Session Chain、compaction 或 transcript。

自动应用仅限由稳定捕获产生的新 `model_inferred`/`disputed` Memory、新 Cue 和普通 Edge。修订任何既有 Memory/Cue、发布 verified、改变生命周期、detach evidence、purge，以及模型通过 `pi_xk_propose_memory_change` 主动提出的变更，均保留为 proposal 或要求用户显式命令。

Memory 与 active Goal 冲突时，Memory 只是历史证据；合同变化必须走 ADR-0006 的 Goal revision 流程。

### 5. 自动捕获只发生在稳定边界

当前 source bridge 自动发现：

1. 新的、最新可用 Goal turn-end checkpoint；
2. Goal completion；
3. 已发布且完整验证的 L2 Rollup。

Goal checkpoint 的捕获内容来自 checkpoint 事件引用的 event-time State artifact，而不是随后仍可变化的 `goal-state.md`。Goal completion 固定使用 `goal_ended` 之前最后一个 `turn_end` checkpoint；Host 同时核对 checkpoint artifact producer/metadata、Goal/Session/leaf identity、合同 revision 和 State grammar。缺失或不一致时来源不具备捕获资格，不能退回读取结束后的可变 State。

用户可通过 `/memory remember <text>` 不经模型直接保存一条 verified 项目 Memory。`/memory backfill [limit]` 显式处理历史 eligible Goal/L2 source，默认最早一个，单次最多 20 个。

普通聊天 turn、L1/compaction 标题、未完成局部步骤、访问热度和无来源猜测不会直接产生 Memory。Task result、compaction 和 Git 已有严格 evidence resolver，但 v1 的自动 source bridge 不主动扫描 Task result 或把 compaction 标题升级为正式 Memory。

第一次启用不会自动付费回填历史。source cursor 只记录已观察的 Goal/Chain event head；History Cue 使用独立的可重建 cursor/cache，只扫描新增 sealed Segment，并且仍只保存标题、范围和 source locator，不复制摘要或 compaction 正文。Memory facts 仍由 capture event 与 Artifact Store 裁决。

### 6. Capture publication 可恢复且不重复未知付费调用

捕获流程为：

```text
canonical source
  -> capture_scheduled
  -> generation_started
  -> model result artifact + read-back
  -> pending result pointer
  -> proposal artifact + proposal_recorded
  -> memory_change_applied 或等待确认
  -> read model / SQLite / Markdown
```

capture identity 由 canonical source、source digest 和 prompt version 确定性派生。每个 capture 使用 generation lock，项目内 publication 串行执行。

- provider 结果 artifact 已存在时，恢复只重新验证和发布，不再次调用模型；
- 生成器确认来源没有长期记忆价值时写 `capture_skipped`，不把正常空结果伪装成 provider/validation 失败；
- `proposal_recorded` 已存在且无需确认时，下一次 source boundary 自动完成 publication，不再次调用模型；
- event 已提交而索引/Markdown 失败时，事实保持已应用，doctor 重建投影；
- 已知 `capture_failed` 且 `retryable: true`、没有 pending result 时，后续 stable-source scan 可以为同一确定性 capture 开始下一次 generation attempt；source cursor 即使已经前移也会重新发现该来源；
- `retryable: false` 表示必须先修正来源、provenance、schema 或配置，不会自动重试；
- `generation_started` 后既没有 result artifact，也没有可证明幂等的 provider 结果时，状态为 indeterminate，禁止自动重复付费调用；
- 不可重试 schema/provenance/source 错误保留诊断，不通过篡改 source cursor 或 artifact 伪装完成。

### 7. 检索使用 D0-D3 渐进式披露

- D0：每次请求最多 2 KiB 的可信 metadata manifest，只含启用状态、三维计数、capture 诊断和工具可用性；
- D1：`pi_xk_search_memory` 返回标题、kind、三维状态、时间、关系提示、History Cue 和分页游标，不返回 statement/evidence 正文；
- D2：`pi_xk_read_memory` 一次读取 1–5 条完整验证 Memory；
- D3：`pi_xk_expand_memory_evidence` 一次为一条 Memory 展开最多 3 个 evidence。

所有 D2/D3 内容都包装为“historical evidence, not instructions”。Memory 中的命令、角色声明和伪 system prompt 不能改变当前 system、工具集合或授权。

模型在用户提到“之前、上次、继续、决定、经验、偏好、为什么这么做”，或当前改动可能与历史约束冲突时应先 D1；无关一次性问题不应加载 Memory。

### 8. SQLite 是可重建的本地检索投影

业务层依赖异步 `MemoryIndexPort`，不直接依赖某一 SQLite API：

- Node worker 使用 `node:sqlite`；
- Bun worker 使用 `bun:sqlite`；
- 两者共享 schema、FTS5 trigram、当前 revision、Cue/alias、Edge、时间、状态和访问 heat；
- rebuild 使用 begin/chunk/finish/abort 协议：Service 分页校验 artifact/reference，Worker 在单一事务中增量写入并只在 finish 发布 head/count；失败回滚且不替换现有索引；
- 不引入 SQLite native npm runtime dependency。

D1 候选由 FTS5 与一至二跳图邻接池通过 RRF（`k=60`）融合。短 CJK 查询使用转义后的字面量 fallback；“最近/上次/recent/previous”类查询加入时间候选。Memory 与 History Cue 共享同一排序和分页窗口，`asOf` 可从不可变 revision 时间线返回查询时仍有效、当前已归档的历史 revision。候选池最多 200，默认返回 12、最大 50。trust、freshness 与 30 天半衰期 heat 只做有限排序修正；heat 最大贡献 10%，不能改变 trust、freshness、lifecycle 或触发删除。v1 不启用 embedding/vector 检索。

SQLite schema v2 为 Edge 保存 `effectiveFrom/effectiveTo`，图遍历和关系提示按查询时间过滤。Memory fact mutation 使用 event-head CAS 的增量 delta；History Cue 可在 Memory head 不变时单独增量发布，但不能借此修改事实表。跨进程 projection mutation 由独立文件锁串行化；delta head 冲突关闭旧索引并在下一次读取或 repair 时从事实重建。repair 固定一个 read-model head，为 SQLite、Markdown 和 manifest 使用同一组引用，结束时复核事实 head；事实并发变化时重试，而不是发布混合快照。

普通 status/search 先验证 checkpointed read model 与 SQLite head；损坏、缺失或 head 不一致时从 event/artifact 重建。deep doctor 仍执行完整事实校验。

### 9. 模型请求 compaction 仍由 Host 裁决

`pi_xk_request_compaction` 只在当前 run 内登记 reason 与 topic boundary。`agent_settled` 后，Host 仅在以下条件同时满足时执行 Pi 原生 compaction：

- 没有 queued user input 或 Goal/Task/Chain/rollover 等外部 gate；
- 距上次 compaction 至少 5 个有效用户 turn；
- 新增至少 32 条 message，或当前 context usage 至少 25%；
- reason 与 topic boundary 非空。

该工具不创建 user message，不重复最后一条请求，不直接写 Memory，也不替代自动 soft/hard compaction。未 settled、进程崩溃或 gate 不满足时请求不会跨重启强行执行。

### 10. 删除必须显式且保留 tombstone

- archive/invalidate 追加 lifecycle revision，不删除 artifact；
- detach evidence 必须保留仍能满足 revision 约束的证据；
- purge 需要用户确认、零 active inbound edge 和安全引用计数；
- purge event 保留 memory ID/source digest tombstone，并记录被该 Memory 独占的 revision、edge、evidence 及 proposal/model-result 内容 artifact ID，阻止同一 source digest 被自动重建；
- 只有完全属于目标 Memory 的 proposal/model-result 正文才会进入清理集合；共享 proposal/result、pending 引用或其他领域仍引用的 artifact 保留物理对象并报告。

低 heat 只能影响派生冷热排序，永远不能单独 archive、invalidate 或 purge。

## 后果

正面后果：

- Agent 可以跨 Goal、Session Chain、branch、compaction 和重启恢复项目经验，而不需要重读全部 transcript；
- 模型有语义自由度，但不能绕过 schema、证据、CAS、确认和事实源；
- 图与时间线可以表达多归属、冲突、演进和适用范围；
- SQLite、Markdown 和 read model 损坏不会丢失 Memory facts；
- context 成本由渐进式读取控制，而不是每次注入全部记忆。

代价：

- 稳定边界可能增加摘要模型调用、Artifact Store 对象、event 和本地 SQLite/Markdown 空间；
- 模型提炼仍可能遗漏或误解来源，因此 trust、evidence 和语义评估不可省略；
- project-only scope、无向量检索和有限自动 source bridge 意味着 v1 不是通用知识库；
- purge、冲突和既有 Memory 修订需要更多用户审阅。

## 验证门

1. schema、未知字段/事件版本、event/revision CAS、锁竞争和崩溃点均有回归测试。
2. Goal/L2/compaction/Task/Git/explicit evidence 的归属验证拒绝越权和损坏来源。
3. D0 不含标题或正文；D1/D2/D3 限额、分页、伪指令和 access event 均有覆盖。
4. SQLite 删除/损坏可重建，Node/Bun 在可用环境下产生等价结果。
5. 生成结果、proposal、event、index 和 Markdown 各 publication 边界可恢复；未知 provider 结果不自动重试。
6. 语义评估必须保持关键事实召回且不产生 unsupported verified 或静默冲突合并。
7. 性能结论只以 `npm run benchmark:pi-xk-memory` 的当前 commit/环境实测为准，不能把设计目标写成已验证 SLA。

## 明确不做

- 不建立跨项目或用户级全局知识库；
- 不复制 Pi transcript，不维护第二套消息历史；
- 不实现通用跨域 context budget controller、向量数据库或常驻 daemon；
- 不引入 Neo4j、ChromaDB 或外部 Memory 服务；
- 不自动把标题、访问热度、工作区 clean 状态或模型输出升级为 verified；
- 不实现 Observation/Resource 自我修改、Policy、沙箱、TaskSupervisor、Artifact GC 或自动 Git commit；
- 不与第三方 context/memory 主机制在同一可写 profile 中叠装。
