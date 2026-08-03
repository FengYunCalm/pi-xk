# ADR-0008：Ambient Memory v2 与自演进 Skill v1

> **状态**：Accepted and implemented
>
> **日期**：2026-08-04
>
> **决策范围**：模型主导的 Memory recall/review、项目与全局 Skill 事实域、跨项目晋升、settled-boundary 热刷新及其恢复边界。
>
> **关联决策**：[ADR-0001 Pi 集成边界](0001-pi-integration-boundaries.md)、[ADR-0002 Artifact Store](0002-artifact-store-v1.md)、[ADR-0005 Session Chain](0005-session-chain-v1.md)、[ADR-0006 Goal 与 compaction recovery](0006-goal-v3-and-compaction-recovery.md)、[ADR-0007 Memory v1](0007-memory-v1.md)

## 背景

Memory v1 已提供项目级、有证据的 D0-D3 检索，但模型仍需要显式 proposal 才能沉淀“这次读取后的结论”。Skill 也只有 Pi ResourceLoader 的静态投影，缺少可审计的候选、使用证据和跨项目晋升边界。直接让模型写 Memory 或 `SKILL.md` 会绕过 schema、来源、CAS 和资源 generation。

本 ADR 将“模型判断”与“Host 发布”分开：模型可以自主跳过或执行检索，并在成功 run 后提交语义 review；Host 只在 settled 边界验证、发布和刷新下一代资源。它不建立第二 transcript、第二 context manager、daemon 或外部数据库。

## 决策

### 1. Ambient Recall 是单次 run 的受限协议

每个逻辑 run 有内存态 `runId` 和 recall ledger。D0 只提供不含正文的 Memory/Skill metadata；模型自主决定是否使用 D1-D3 和 Skill candidate/read 工具。没有项目历史价值的一次性问题不应搜索，关键词不会强制触发搜索。

默认预算固定为：

```text
10 total knowledge actions
8 Memory actions / 3 Memory searches / 10 unique Memory reads / 6 evidence reads
4 Skill candidate actions
```

超限返回结构化 `budget_exhausted`，不得扩大候选池。`keep`、review、compaction request 不计入知识动作。只有 D2/D3 实际读取才记录 access；搜索曝光不算 recall。ledger 只保存 ID、revision、digest、预算和停止原因，不保存用户提示词或回答正文。

允许的停止原因是 `not_needed`、`sufficient`、`irrelevant`、`budget_exhausted`、`evidence_unavailable`、`conflict_found` 和 `run_failed`。

### 2. Memory review 取代模型直接写 proposal

新增 `pi_xk_review_memory`，输入是高层语义动作：`keep`、`revise`、`supersede`、`dispute`、`create`。模型只能修改本 run 已读取的 D2 revision，或使用本 run 的 evidence 创建新 Memory；它不能提供 artifact ID、event head 或绕过 CAS。

模型未为已读取项提交非 `keep` 决策时，成功 settled 自动产生隐式 `keep` trace。`revise` 保持 Memory ID、`supersede` 保留旧 revision 并建立关系、`dispute` 创建 disputed revision 和 `contradicts` edge；任何模型重写默认是 `model_inferred`，不会继承 `verified`。目标 revision 变化时拒绝语义 rebase，下一 run 重新读取。

原 `pi_xk_propose_memory_change`、V1 proposal 和历史事件继续可读，但不再出现在模型 manifest；用户仍可通过命令审查遗留 proposal。模型不可 archive、invalidate、detach 或 purge。

Memory revision v2 增加 transition、reviewId、source revisions 和 trust derivation；`agent_run` evidence 只引用原生 Pi entry 范围、digest、Goal/Chain identity 和工具结果 ID，不复制 transcript。run 为 error、abort 或截断时不发布语义 revision，只保留运行诊断。

### 3. 捕获只在稳定边界整合既有 Memory

Goal checkpoint/completion、L2 publication、显式 backfill 先用有限候选搜索同主题 current Memory，再要求捕获模型返回 review action。重复 capture 使用 source digest、prompt version 和结果 artifact 幂等；CAS 冲突至多在新的稳定边界重新生成，连续冲突进入 cooldown。`generation_started` 后无 durable result pointer 的状态为 indeterminate，禁止未知结果的自动付费重试。

标题、L1 和 compaction cue 仍只是历史定位信息，不直接创建 Memory。

### 4. Skill 是独立的、有证据的事实域

Skill facts 位于项目 `.pi-xk/skills/`，全局事实位于 agent directory 的 `pi-xk/skills/`；active projection 分别写入项目 `.pi/skills/<name>` 与全局 `skills/<name>`。事件、Artifact Store、read model、SQLite 和 projection 的职责与 Memory 相同，未知 Skill event schema 拒绝 replay。

模型可使用：

- `pi_xk_search_skill_candidates`：只读候选元数据；
- `pi_xk_read_skill_candidate`：读取受标记的历史候选 bundle；
- `pi_xk_review_skills`：提交 `keep/create/revise/supersede` 及实际使用结果。

模型只有在成功 run、有可解析 evidence、bundle 通过 Host 验证时才能创建或更新 Skill。候选不足时不进入 system prompt；active Skill 修改必须引用精确 revision 和本次使用或用户要求。连续两次 evidence-backed failure 进入 `needs_review` cooldown，旧 bundle 保留。archive/purge 永远是用户命令。

Host 渲染并校验 Skill bundle：名称不超过 64 字符，description 不超过 1024 字符，`SKILL.md` 不超过 500 行/32 KiB，最多 20 个相对路径文件且总计不超过 256 KiB；拒绝 symlink、路径逃逸、非 managed 同名覆盖和跨 lineage 的同名碰撞。

### 5. 跨项目晋升是 candidate 流程

项目 Skill 发布后只创建全局 candidate。自动晋升至少需要两个不同 repository identity、最新 revision 三次成功使用、至少一次发生在创建项目之外、无未解决 failure，以及 bundle/evidence/name collision/forward validation 全部通过。单个项目不能直接覆盖全局 active Skill；失败保留诊断和旧版本。

### 6. Skill reload 只在 settled boundary 发生

Pi Host 提供窄接口 `reloadSkills()` 与 `reloadSkillsAtSettledBoundary()`。reload 只重新解析当前 trust/settings 快照里的 Skill 路径，不重载 settings、extensions、prompts、themes、providers，不发送 shutdown/start，不改变工具集合。当前 run 固定使用原 generation；事实和 managed projection 原子发布后，下一逻辑 run 才得到新 Skill generation。

ResourceLoader 可以复用上一次完整 reload 的受信任路径和 metadata，并对内容未变的 Skill 缓存 frontmatter 解析；新增或修改文件重新解析，disabled path 不会被默认目录扫描重新启用。重载失败保留旧 snapshot 和 base prompt，并记录 projection/reload 诊断。

### 7. 发布顺序与恢复

成功 settled 后固定顺序：

```text
reconstruction/skill-use trace
  -> Memory review validation and CAS publication
  -> Skill candidate/revision/use publication
  -> read model / SQLite update
  -> managed Skill projection exchange
  -> Skill-only reload at next settled boundary
  -> stable Goal/L2 capture scan
  -> model compaction request gate
```

任何中间崩溃都只能留下 staged intent、pending pointer 或待修投影，不能产生半个 revision。artifact 已写但 event 未写时复用 artifact；event 已写但索引或 projection 未更新时重放 event tail 或 repair，不再次调用模型。事实源损坏只报告，不自动改写。

## 后果

正面后果：模型可以在真正需要时主动回忆，并把读取后的长期价值沉淀为可审计 Memory/Skill；普通 run 不会因强制搜索或正文注入增加成本；新 Skill 不会改变正在运行的工具集合。

代价是每次成功 settled 需要 ledger/review 校验，Skill bundle 和跨项目晋升需要更多 evidence；模型判断可能保守或遗漏，必须以 recall/冲突/unsupported verified 评估和预算诊断为准。项目 Skill 仍继承 Pi 进程权限，未引入沙箱。

## 验证门

1. V1/V2 Memory revision、proposal、event 混合 replay 与未知版本拒绝。
2. 自主搜索、主动跳过、预算边界、隐式 keep、revise/supersede/dispute/create 和 CAS 冲突。
3. error/abort/length/compaction/queued message 不发布语义 revision。
4. Skill 创建、实际受管读取证据、更新、cooldown、stale、rollback、名称碰撞和两项目晋升。
5. Skill-only reload 不产生 shutdown/start，不改变 settings、extensions、prompts 或 tools。
6. D0 不含 Memory/Skill 正文，历史候选伪指令不能改变权限；Node/Bun/Windows 的恢复语义保持一致。
7. `evaluate:pi-xk-ambient-recall`、`evaluate:pi-xk-skill-evolution`、Memory/Skill benchmark 和完整 Pi-XK 门槛通过。

## 明确不做

- 不自动 archive、invalidate、detach、purge 或物理删除 Memory/Skill；
- 不把标题、heat、单次失败或模型语气升级为事实或 Skill；
- 不复制 transcript，不建立第二 context manager 或 memory daemon；
- 不引入向量数据库、外部 Memory 服务、Neo4j、ChromaDB 或 native SQLite npm runtime；
- 不让 Skill 改变 system prompt 优先级、Goal 合同、用户授权或工具权限；
- 不自动 Git commit、发布版本或创建 tag。
