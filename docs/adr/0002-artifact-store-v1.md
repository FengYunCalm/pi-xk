# ADR-0002：项目作用域 Artifact Store 与 Goal Read Model v1

> **状态**：Accepted for Phase 1.5
>
> **日期**：2026-07-20
>
> **决策范围**：Goal checkpoint evidence 的不可变对象、脱敏、重放投影和恢复边界。
>
> **关联设计**：[Pi-XK 架构策划案](../pi-xk-architecture-proposal.md)

## 背景

Phase 1.4 的 checkpoint 只保存 Pi session、leaf、turn 和工具结果计数。它可以定位来源，却不能提供可验证的 evidence reference，也没有可删除后重建的 Goal 查询视图。把完整 prompt、工具参数、工具结果或 `goal-state.md` 复制到 Goal JSONL 会制造第二事实源，并增加凭据与个人数据泄漏面。

本 ADR 为本机 WSL/Linux 项目目录定义最小 artifact 协议。它不试图把同用户磁盘变成可信存储，也不把规则脱敏描述为完整的 secret scanner。

## 决策

### 1. Artifact 是项目作用域的不可变对象

对象存储在项目根目录下：

~~~text
.pi-xk/artifacts/objects/<digest-prefix>/<digest>.data
.pi-xk/artifacts/objects/<digest-prefix>/<digest>.json
~~~

ID 固定为 `sha256:<lowercase-hex>`，只在同一 project scope 内寻址；不建立跨项目或跨用户的去重服务。metadata 包含 schema、ID、媒体类型、字节数、首次创建者、敏感级别、脱敏版本和首次 source IDs。多处引用同一内容时，真正的每次 provenance 留在 checkpoint event 的 evidence reference，而不改写 immutable metadata。

首版只接受有界 UTF-8 `text/plain` 和稳定 JSON `application/json`，拒绝二进制、NUL 和超限输入。写入前使用版本化规则脱敏；当前 extension 进一步只写 runtime 生成的 session/leaf/计数/原因 provenance，完全不采集 prompt、objective、`goal-state.md` 正文、工具参数、工具结果正文、OAuth URL 或原始二进制。

### 2. 发布协议优先保证“不返回半对象”

写入流程为：临时文件写入 -> `fsync` -> 在同目录建立不可覆盖的 hard link -> 目录同步；data 与 metadata 分别发布。hard link 在本 scope 内避免 `rename` 覆盖已存在的内容对象。崩溃可能留下仅 data 或仅 metadata 的不完整对象；读取一律报 corruption，绝不把它返回为有效 artifact。相同内容的并发发布只保留第一份 immutable metadata。

若只有 data 已完整发布且后续相同内容重试重新验证 hash，Store 可以安全补齐缺失 metadata；只有 metadata 的对象、hash 不一致对象或已存在的损坏 metadata 一律不自动修复。

测试 hook 仅用于验证 data/metadata 的 fsync、发布和目录同步故障，不构成通用存储抽象或生产策略接口。

### 3. Checkpoint v2 只引用 evidence

新 writer 使用 `pi-xk.goal-checkpoint.v2`。它保存 session/leaf、`turn_end` 或 `session_before_compact` 原因、可选 turn 计数，以及带 source entry IDs 的 evidence artifact reference。GoalStore 在追加事件前验证 artifact 位于同一 project scope 且可读取。

既有 `pi-xk.goal-checkpoint.v1` 事件保持原 payload 和原 hash，不原地迁移。读取阶段使用纯 upcaster 将它投影为 v2（没有 artifact reference），因此旧事件链仍可验证，新的 writer 不再生成 v1。

固定顺序为：Pi 已持久化来源 -> Pi custom checkpoint intent -> durable artifact -> Goal checkpoint event -> Pi custom checkpoint ref。artifact 成功而 CAS/事件写失败时可留下不可引用孤儿；不能把它当作 checkpoint 成功，也不自动删除。

### 4. Read model 是纯派生投影

`<goal>/goal-read-model.json` 只从 `events.jsonl`、Goal contract 的 replay 和 artifact metadata 重建，保存 source head、生命周期、checkpoint 数、最新 v2 checkpoint 与 artifact diagnostics。它不解析、缓存或注入 `goal-state.md` 内容。

event 已落盘而 contract/read-model 投影写入失败时，事件仍是事实；调用方得到错误诊断。`rebuildContractProjection` 和 `rebuildGoalReadModel` 是显式恢复 API。`loadGoalReadModel` 会重放当前事件并重新检查 artifact diagnostics；base hash、投影或 artifact 状态有差异时拒绝把旧文件表示为当前事实。

Goal 首个 `goal_created` 事件也使用同目录临时文件、文件同步、原子 rename 和目录同步发布，不跟随遗留的 `events.jsonl` symlink 目标。若发布失败且无法重放出同一事件，本次创建的初始 Markdown 文件会被移除；若事件已经 durable 而投影缺失，相同 idempotency key 的重试会重建 objective、contract 和 read-model 投影，不追加第二个创建事件。

## 后果

- Pi session 继续是完整对话与工具结果事实源，Goal JSONL 继续是 Goal 事实源；custom entry 只保存 binding、intent 和 event ref。
- artifact read model 可安全删除重建，但当前没有 GC、retention、tombstone、加密、签名、跨项目复制、全文检索或模型 context 注入。
- 内容哈希和本机 JSONL hash chain 只能发现意外损坏或不一致，不能抵抗拥有相同用户权限的恶意进程。需要该威胁模型时，必须新增签名或独立 append-only sink。
- 规则脱敏不是完整凭据或个人数据发现器。首版的安全策略是最小采集；后续 Policy/credential broker/secret scanner 仍是独立阶段。

## 验证门

1. Artifact schema、路径、脱敏、并发去重、篡改检测和 fsync/publish/directory-sync 故障测试。
2. v1 hash replay/upcast、v2 hash/CAS/idempotency、首次事件原子发布与投影重建、artifact 缺失或损坏、read-model 删除/失效/重建测试。
3. Pi faux harness 验证工具结果先于 v2 evidence checkpoint，reload/fork 不重复写 ref，compaction-before 不替换 Pi 原生 summary。
