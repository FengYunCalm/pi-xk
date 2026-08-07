# Pi-XK controlled evaluation — 2026-08-06

## 结论

- 公共 Aider Polyglot 对照中，Native Pi 与 Pi-XK 均为 5/5，通过率和 verifier reward 完全持平；本轮不能宣称 Pi-XK 在短代码任务结果上优于 Native Pi。
- Pi-XK 专属工作流共 15/15 通过：8 个 faux-provider 确定性场景，以及 7 个 DeepSeek 真实模型场景。
- 在五个公共任务总量上，Pi-XK 输入 token 高 34.5%、输出 token 低 4.5%、成本高 23.1%、总耗时低 4.5%。按每个 agent 的五次运行分别取中位数，Pi-XK 耗时低 19.8%，但输入 token 高 74.9%、成本高 37.8%。
- 已证明的主要价值不是提高小任务 verifier 分数，而是 Goal、Task、Session Chain、compaction、Memory、Skill 和 doctor 能在真实模型下完成受验证的长期工作流。

## 控制条件

- Pi-XK baseline：`e08bad29b158372125a4a9652d2b48a1e5da4317`
- Evaluated runtime：Chain/Memory `pi-0.80.10-runtime-sha256:3a80d7e3bcc341df748e13f7fcc93b7cf3809a667a51ac8270d5151a8a57fbea`；Goal/Task/Skill `pi-0.80.10-runtime-sha256:d7c924ee6b2ec1148e5cd713306ffe1821b663ec27db055556e7090f85195449`
- Pi：`0.80.10`
- Provider/model：`deepseek/deepseek-chat`
- Thinking：`low`
- Node/npm：`24.14.1` / `11.11.0`
- OS：Ubuntu 24.04 on WSL2, Linux `6.6.87.2-microsoft-standard-WSL2`
- Docker：`29.1.3`
- Harbor：`0.20.0`, commit `459ff6ec99417589b7f679d14ddf3b3f0ae4f1dc`
- Aider Polyglot：commit `7e0611e77b54e2dea774cdc0aa00cf9f7ed6144f`
- Buildx/Compose：使用隔离 `DOCKER_CONFIG` 加载 Buildx `0.30.1` 与 Compose `2.40.3`；未修改主机全局 Docker CLI 配置。
- Network：`portable-loopback-v1`。当前 WSL2 kernel 缺少 Harbor 上游规则依赖的 `CONFIG_NFT_FIB_INET`，因此使用显式 IPv4/IPv6 loopback 与 Docker DNS 规则，保持透明代理和默认拒绝语义。
- 公共任务 agent 与 setup timeout 均为 900 秒；五对任务交替执行顺序，禁止单边重试。
- 凭据只通过进程环境传入。所有固化结果均不包含密钥、提示词、模型正文、transcript 或工具参数。

## 公共代码任务

| Task | Native reward | Pi-XK reward | Native input | Pi-XK input | Native cost | Pi-XK cost | Native seconds | Pi-XK seconds |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Python phone-number | 1 | 1 | 40,883 | 100,700 | $0.004872 | $0.008949 | 398.802 | 472.188 |
| Go robot-simulator | 1 | 1 | 233,884 | 208,519 | $0.027692 | $0.030331 | 588.696 | 875.214 |
| Rust acronym | 1 | 1 | 89,688 | 67,028 | $0.009266 | $0.008863 | 612.565 | 332.688 |
| C++ clock | 1 | 1 | 57,586 | 153,005 | $0.006492 | $0.009304 | 401.623 | 473.132 |
| Java all-your-base | 1 | 1 | 29,141 | 77,791 | $0.003793 | $0.006723 | 606.554 | 336.865 |

### 资源汇总

| Metric | Native total | Pi-XK total | Total delta | Native median | Pi-XK median | Median delta |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Input tokens including cache | 451,182 | 607,043 | +34.5% | 57,586 | 100,700 | +74.9% |
| Output tokens | 47,559 | 45,429 | -4.5% | 5,071 | 4,767 | -6.0% |
| Cost | $0.052115 | $0.064170 | +23.1% | $0.006492 | $0.008949 | +37.8% |
| Elapsed seconds | 2,608.240 | 2,490.087 | -4.5% | 588.696 | 472.188 | -19.8% |

Rust 和 Java 中 Pi-XK 明显更快，Go 中明显更慢；样本只有五个，不能把耗时差异解释为稳定性能优势。公共结果只证明在这五个小型、多语言、确定性 verifier 任务上保持 parity。

## Pi-XK 工作流证据

确定性验证覆盖以下八个场景，全部通过：

- Goal contract continuity
- Task child delivery
- Chain rollover/Rollup/recovery
- Compaction continuation without duplicate user input
- Ambient Memory recall/review
- Skill evolution/reload
- Doctor projection repair
- Local installation lifecycle

真实 DeepSeek smoke 分为三个不可重复计费的 execution group：

| Execution group | Covered assertions | Input incl. cache | Output | Cost | Seconds |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chain + Memory + compaction + doctor | 4 | 127,580 | 3,121 | $0.011942 | 72.544 |
| Goal + Task | 2 | 443,324 | 21,869 | $0.033359 | 425.082 |
| Skill evolution + hot reload | 1 | 226,855 | 12,542 | $0.020254 | 171.631 |
| Total unique execution groups | 7 | 797,759 | 37,532 | $0.065554 | 669.257 |

同一 execution group 下的多个 scenario record 共享一次模型消耗，不能把每条 record 的 metrics 再次相加。

真实检查结果：

- Chain/Memory：rollover、L2 Rollup、重启恢复、compaction 续接、Memory D1/D2 自动检索、结果哨兵和三类 doctor/repair 均通过，doctor diagnostic code 为空。
- Goal/Task：Goal draft tool、`goal_ended`、验收文件、独立 Task `task_succeeded`、child `pi_xk_finish_task`、父会话 durable result delivery 均通过。
- Skill：模型自主调用 Skill review，发布 `skill_change_applied`，生成 active projection；同一 Pi 进程的新 session 读取热加载 Skill，完成后续任务并写入 `skill_use_recorded`；doctor diagnostic code 为空。

## 本轮发现并修复

- Goal 完成后的 session 仍绑定 ended Goal，按设计不能直接启动 Task。真实 runner 现在等待 `goal_ended` 事实、确认 idle，再切换到无 Goal 的新 session。
- 用户启动的 Task 在 child AgentSession 中完成，不会产生父会话 `agent_settled`。runner 现在等待 Task terminal event，并验证 child session 中真实的结构化 finish tool call 与父会话 result projection。
- Skill smoke 的诊断字段引用了不存在的变量，导致成功运行在汇总阶段失败；已增加纯函数回归测试，并让顶层 scenario error 总是保留 stage。
- 原 Skill fixture 只有一次性单文件校验，模型合理地拒绝沉淀 Skill。fixture 现在提供重复性、适用边界、验证和失败处理证据，并增加无重启 hot-reload 使用验证。
- 空 Skill 事实域没有 SQLite index 时，doctor 现在视为健康；存在事实后仍要求完整索引一致性。
- 原 Memory smoke 的 D1 标题已包含精确答案，模型合理地停在 D1，不能证明 D2 读取。fixture 现在只在标题范围暴露主题，把精确标识符留在 D2 statement，并由工具事件独立验证真实 D1/D2。
- Memory `doctor` 曾可能在后台 stable-source/history-cue publication 已提交事实但尚未推进 SQLite/Markdown 的窗口读取，产生瞬时 `index_stale` 与 `projection_manifest_stale`。doctor 现在在同一跨实例 projection lock 下读取一致快照，并有 Core 与 Extension 并发回归覆盖。
- Workflow runtime ID 现在覆盖 Pi、Pi-XK Core/Extension、相关 manifests、lockfile 和 shrinkwrap 的完整构建内容；RPC `compact`/`new_session` 也继承真实 provider turn 的超时预算。

## 结果边界

- 本结果不是 SWE-bench、Terminal-Bench 或 DeepSWE 排名，也不能与使用不同模型、提示、工具、预算和任务版本的公开 agent 分数直接比较。
- 5/5 parity 不证明 Pi-XK 能提高短任务成功率，只证明这些功能没有破坏本次小任务完成率。
- 工作流 smoke 证明真实模型能使用 Pi-XK 机制并产出受验证结果，但没有 Native Pi 对应功能，因此不能把 Native 缺少该功能计为失败。
- 长任务收益仍需要同一模型、同一任务、相同预算的多 session/多 compaction 对照实验；本次只完成架构功能与小型公共任务的第一层证据。

## 复现

```bash
node scripts/evaluate-pi-xk-capabilities.mjs \
  --matrix evaluation/capabilities/capability-matrix.json \
  --report evaluation/capabilities/results/2026-08-06/public-evaluation.json \
  --report evaluation/capabilities/results/2026-08-06/workflow-validation.json \
  --report evaluation/capabilities/results/2026-08-06/workflow-smoke-chain-memory.json \
  --report evaluation/capabilities/results/2026-08-06/workflow-smoke-goal-task.json \
  --report evaluation/capabilities/results/2026-08-06/workflow-smoke-skill.json \
  --format markdown
```

机器可读汇总见 [summary.json](./summary.json)。原始脱敏 capability reports 与真实 smoke diagnostics 位于同一目录。
