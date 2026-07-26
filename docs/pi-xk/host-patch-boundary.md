# Pi-XK Host Patch 边界与升级检查

Session Chain 需要在同一个 Pi runtime 内安全生成摘要并替换物理 session，Task 运行期间还需要延迟普通用户输入而不并发启动 parent turn。普通 Extension API 原本没有这三个边界，因此本 fork 对 `@earendil-works/pi-coding-agent` 保留一个小型通用 Host patch。本文记录其边界、原因、验证和升级检查项。

## 1. Patch 只提供什么

### `summarizeSessionContext`

位置：

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/src/core/extensions/runner.ts`

能力：复用当前 model、认证、thinking level 和 Pi summarizer，对调用方提供的 messages/previous summary 生成摘要，但不写 session transcript、不触发 compaction、不替换 runtime。

### `rolloverSession`

位置：

- `packages/coding-agent/src/core/agent-session-runtime.ts`
- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/src/core/extensions/runner.ts`

能力：只在 agent settled、输入队列可控的边界执行：

1. 发出可取消的 `session_before_rollover`；
2. 创建指定 identity/path 的 target session；
3. 调用 extension 的 target 初始化和 source finalize；
4. 执行领域 commit；
5. 用 replacement runtime 切换到 target；
6. 发出 `session_shutdown/session_start`，reason 为 `rollover`。

### Lifecycle 扩展

- 新事件：`session_before_rollover`；
- shutdown/start reason 增加 `rollover`；
- `reason: "rollover"` 表示同一逻辑会话内部物理替换，不等同于 `/new`、`/resume`、fork、reload 或 quit。

### `queueUserMessage`

位置：

- `packages/coding-agent/src/core/agent-session.ts`
- `packages/coding-agent/src/core/extensions/types.ts`
- `packages/coding-agent/src/core/extensions/runner.ts`

能力：extension 把 text/image 用户消息加入 Pi 原生 follow-up 队列，不立即启动 agent turn。消息仍由 Pi 的 session/runtime 队列拥有并按顺序处理；rollover pending 时拒绝写入只读 source transcript。Pi-XK 用它在 Task 运行期间保存普通输入，Task 终态交付后再让 parent 处理。

## 2. Patch 不做什么

- 不改变 provider transport、Agent loop 或 tool call 协议；
- 不改变 Pi 原生 message/session entry schema；
- 不替换 `/resume`、`/tree`、`/fork`、`/clone` 或 `/compact`；
- 不解析 Pi-XK chain、Goal、Task 或 artifact；
- 不决定 rollover 阈值、窗口、摘要格式或 recovery；
- 不提供后台 session、多写者、远程 RPC 或 sandbox。
- 不绕过 input hook、命令解析、Task gate 或 rollover read-only 边界，也不允许 parent/child 并发模型调用。

Pi-XK 的所有领域判断仍在 `packages/pi-xk-extension/src/session-chain-controller.ts`；Core 事实源仍在 `pi-xk-core`。

## 3. 为什么不能只用现有 `/new`

普通新建/切换 session 会触发真实 session shutdown 语义。Goal extension 会据此保守暂停 active Goal，且调用方无法在 target durable、source marker durable 和 chain event commit 之间建立一致顺序。

rollover 的语义是“同一逻辑会话更换物理承载文件”。它需要可取消 preflight、确定 target identity、两端 callback 和 commit 后 replacement。把它伪装成 `/new` 会混淆 Goal 生命周期并扩大崩溃窗口。

## 4. 验证

定向 Host 回归：

```bash
cd packages/coding-agent
node node_modules/vitest/dist/cli.js --run test/suite/agent-session-rollover.test.ts
node node_modules/vitest/dist/cli.js --run test/suite/agent-session-queue.test.ts
```

完整 Pi-XK 验收：

```bash
npm run test:pi-xk
npm run check
```

`agent-session-rollover.test.ts` 必须覆盖摘要不改 transcript、成功 replacement、取消、callback/commit 失败、busy/queue gate、事件顺序和 runtime identity。`agent-session-queue.test.ts` 必须覆盖 text/image、顺序、无即时 turn 和 rollover pending 拒绝。

## 5. 上游同步检查单

每次同步 upstream Pi 后逐项检查：

1. `AgentSession` 的 summarizer、model/auth 访问和 compaction API 是否变化。
2. `AgentSessionRuntime` 的 replacement、follow-up queue、abort、dispose 和 extension rebind 顺序是否变化。
3. Extension event 类型、runner dispatch、context actions 和 lifecycle reason 是否新增冲突。
4. `SessionManager.createAt/open/flushDurable` 是否仍能保证指定 path/identity 和 durable marker。
5. 新 upstream `/new`、resume 或 runtime replacement 能力是否可以等价替代本 patch。
6. Goal extension 对 `session_shutdown` 的判断是否仍明确排除 `reason: "rollover"`。
7. 运行 Host 定向测试、Session Chain Controller/Extension 测试、`npm run test:pi-xk` 和 `npm run check`。
8. 若删除或缩小 patch，先证明 source/target/event 的崩溃恢复语义没有退化。
9. 确认 `queueUserMessage` 仍只排队、不触发 turn，并且不会跳过正常 follow-up 的 transcript 持久化顺序。

## 6. 升级失败的停止条件

出现以下任一情况，不应继续发布或把同步描述为完成：

- replacement 前可能接收新输入或仍有 agent run；
- target 未 durable 就替换 runtime；
- commit 失败后 runtime 已切到未发布 target；
- rollover 被 Goal 当作真实 session 离开而暂停；
- summary helper 写入 transcript 或改变 compaction/tree；
- queued user message 立即启动 parent、乱序、丢失 image，或能在 rollover pending 时写 source；
- extension 无法区分取消、失败和成功 commit；
- Host 定向测试或 Pi-XK 完整测试未通过。
