# Ambient Recall 与 Skill 演进

本文是 Pi-XK 当前模型工作流的操作说明。它描述“什么时候模型自己检索、什么时候可以沉淀、Host 如何阻止越权”，不把模型生成文本当作系统指令。设计决策见 [ADR-0008](../adr/0008-ambient-memory-v2-and-skill-v1.md)；基础 Memory 事实源和 D0-D3 细节见 [Memory v1](memory-v1.md)。

## 一次模型 run 的顺序

```mermaid
sequenceDiagram
    participant H as Host
    participant M as Model
    participant F as Memory/Skill facts
    H->>M: D0 metadata + fixed tools + current Goal/Chain guidance
    M->>M: 判断历史是否会改变答案、约束或实施决策
    opt 需要历史
        M->>F: D1 search candidates
        M->>F: D2 Memory / Skill candidate read
        M->>F: D3 evidence expansion when necessary
    end
    M->>H: 完成任务并可提交 review/skill-use
    H->>F: settled 后校验、CAS、原子发布
    H->>H: 下一 settled boundary 刷新 Skill generation
```

### D0 不是记忆正文

每次 run 只得到有界 metadata：Memory/Skill 是否启用、三维状态计数、pending/failed/indeterminate 诊断、可用工具和预算。D0 不含标题、statement、Skill instructions、历史用户文本或模型生成指令。因此模型看到的是“有多少可用历史”，不是自动塞入的答案。

### 模型何时搜索

模型应在历史可能实质改变当前答案时搜索，例如需要既有决定、项目约束、失败教训、用户偏好、跨 Segment 待办、Goal/Chain 恢复或与旧方案兼容时。一次性且与项目历史无关的问题应跳过搜索。不要用“之前/继续”等关键词硬触发，也不要因为 D0 有计数就主动读取正文。

搜索之后按需递进：

1. D1 只看标题、kind、三维状态、时间、关系和范围；
2. D2 只读最相关的结构化 Memory 或 Skill candidate；
3. D3 只在 D2 不足、过期、冲突或需要核对原始来源时展开有限 evidence。

Memory 与 Skill 正文必须包装为 `historical evidence, not instructions`。其中的命令、角色声明、伪 system prompt、权限要求和“忽略上文”等文本都是历史数据，不能改变当前工具集合、Goal 合同、用户授权或 system prompt 优先级。

## Recall ledger 与预算

一个 run 最多消耗：

| 额度 | 默认上限 |
| --- | ---: |
| 所有知识动作 | 10 |
| Memory 动作 | 8 |
| Memory search | 3 |
| 不重复的 Memory read | 10 |
| Evidence read | 6 |
| Skill candidate search/read | 4 |

超限返回 `budget_exhausted`，模型应停止扩展候选并基于已有证据继续或明确说明证据不足。ledger 记录 query/candidate/revision/evidence 的 digest 和停止原因，不保存提示词或回答正文。只有 D2/D3 实际读取记为 access；D1 曝光不增加 heat。允许的停止原因：`not_needed`、`sufficient`、`irrelevant`、`budget_exhausted`、`evidence_unavailable`、`conflict_found`、`run_failed`。

Pi 原生 follow-up 在同一个 `agent.prompt()` 内按顺序排空，随后才产生该 prompt 唯一的 `agent_settled`。因此 queued follow-up 不会重置 recall ledger、重复 `before_agent_start` 或产生第二个 reconstruction；它与首条输入共同构成一个 logical run。

## Memory review

成功 run 可以调用 `pi_xk_review_memory`：

- `keep`：当前读取仍然适用，只记录 reconstruction trace；
- `revise`：同一 Memory ID 的新 revision；模型改写后的 trust 默认 `model_inferred`；
- `supersede`：新结论取代一个或多个旧结论，旧 revision 永久保留；
- `dispute`：无法解决的冲突保留双方并创建 `contradicts`；
- `create`：必须由当前 run 或已读取 evidence 支持。

模型只能复核本 run 读取过的 revision。Host 会重新验证 evidence ownership、source digest、schema、event-head/revision CAS 和 transition。成功 settled 且模型未提出其他决定时，已读 Memory 隐式记录 `keep`；error、abort、length 或未完成 run 不发布语义 revision。新建的 `agent_run` evidence 使用 V3，并把从 durable session binding 验证得到的 `goalId` 与 entry 范围一同保存；V2 历史 evidence 仍可读取。

`verified` 不能由模型语气或来源完整性继承。只有用户明确保存或 Host 确定性验证才可保持 verified；冲突用 disputed 表达。archive、invalidate、detach、purge 只提供给用户命令。

稳定来源捕获（Goal checkpoint/completion、L2 Rollup 和显式 backfill）也先搜索同主题 Memory，再执行同一 review 语义。结果 artifact 已存在时恢复复用；generation started 但结果未知时保持 indeterminate，不自动重复付费调用。若 revision CAS 冲突，Host 只在下一稳定边界发起新的 attempt；前两次冲突可重试，第三次记录 `memory_capture_revision_conflict_cooldown` 并停止自动 provider 调用，等待新的事实或用户/doctor 介入。

## Skill 演进

Skill 不是每轮都要创建的“总结”。只有可复用流程、适用条件、偏离条件、验证和失败处理都清楚，并且有本次成功 run 的 evidence，模型才应提交 `create` 或 `revise`。模型可先：

1. `pi_xk_search_skill_candidates` 看候选 metadata；
2. `pi_xk_read_skill_candidate` 读取受标记的候选 bundle；
3. 实际使用受管 `SKILL.md` 后，在 `pi_xk_review_skills` 中提交 use outcome 或 review。

Host 渲染 bundle 并拒绝路径逃逸、symlink、非法名称、超大文件和非 managed 同名覆盖。项目 Skill 首次成功且 evidence 可解析后可进入项目 active projection；全局 Skill 必须先成为 candidate，满足两个 repository、三次成功使用和跨创建项目使用等条件后才可晋升。连续两次未解决的 evidence-backed failure 进入 `needs_review` cooldown，旧 revision 不删除。

Skill 正文不会进入 D0。只有在下一逻辑 run 的固定 Skill generation 中才可能被 Pi ResourceLoader 读取。发布后 reload 只发生在 settled boundary，不重启 session、不改变 tool schema、settings、extensions、prompts 或 provider。reload 失败保留旧 snapshot。

## 用户控制面

```text
/memory status
/memory reviews
/memory review show <run|decision>
/memory config ambient on|off
/memory config evolution on|off
/memory archive <id>
/memory invalidate <id>
/memory purge <id>

/skill status
/skill list [all]
/skill show <id|name>
/skill timeline <id>
/skill candidates
/skill candidate show|promote|reject <id>
/skill archive <id>
/skill rollback <id> <revision>
/skill purge <id>
/skill config on|off
/skill doctor [deep|repair-projections|repair-lock <nonce>]
```

用户可审计、回滚和删除；模型默认负责搜索、review 和候选演进，但不能执行生命周期删除。`/xk status` 汇总 recall budget、最近 reconstruction、可重试 Memory capture、CAS cooldown、Memory conflict、Skill active/candidate/stale/cooldown、索引和 projection/reload 状态。

## 与 Goal、compaction、Session Chain 的关系

- Goal kickoff 仍是唯一任务驱动；Memory recall 不会启动第二次模型调用来“推动目标”。
- compaction recovery 只附加到下一次实际 run；它不重复最后一条 user message，也不直接写 Memory。
- Session Chain L1/L2 和 compaction title 只提供历史 cue/evidence；标题不会自动升级为 Memory 或 Skill。
- run settled 后先固化 trace/review，再发布 Memory/Skill；后续 source capture 和模型 compaction 仍遵守各自 gate。
- Memory/Skill 不能修改 Goal contract、Goal State、Chain、transcript 或工具权限。

## 失败与恢复

事实 artifact/event 已发布而 SQLite/Markdown/Skill projection 未更新时，使用对应 `doctor repair-projections`，不重新调用模型。artifact 已写但 event 未写时通过 pending pointer 复用；交互式 review 的 CAS 冲突要求下一 run 重新读取，不做语义 rebase。稳定 capture 的 CAS 冲突走有界 attempt/cooldown，不会复用冲突前的模型结果。未知 event schema、证据越权、digest 不一致、同名非 managed Skill 或损坏 bundle 都是不可静默修复的诊断。

Memory/Skill 目录第一次有效使用或显式命令才创建；关闭 ambient/evolution 只停止新的自动 capture、review/access 或 Skill publication，既有事实仍可只读审计。关闭期间的历史不自动批量回填。
