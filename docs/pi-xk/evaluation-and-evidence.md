# Pi-XK 评测与证据

本文汇总 Pi-XK 当前能被证据支持的结论，并明确哪些结果仍未证明。原始脱敏报告、注册计划和评测实现位于 [`evaluation/capabilities/`](../../evaluation/capabilities/README.md)。

## 结论

当前证据支持三点：

1. Pi-XK 的 Goal、Task、Session Chain、compaction recovery、Memory、Skill、doctor 和本地安装工作流能通过确定性验证，并能被真实模型完成。
2. 在固定 DeepSeek 模型和密封三臂任务中，安全 D0 路由与模型自主 D1-D3 Recall 相比等形 placebo 提高了外部 verifier 通过数。
3. 在五个短小公共代码任务中，Pi-XK 与 Native Pi 都通过，说明扩展层没有破坏这组任务的完成率；Pi-XK 没有显示结果质量领先，并付出了更高输入 token 和成本。

当前证据不支持“Pi-XK 普遍优于其他 Agent”“所有任务都更快/更省 token”或“Memory 在任意模型和项目上都有效”。

## 证据层级

| 层级 | 能证明什么 | 不能证明什么 |
| --- | --- | --- |
| 类型、单元和故障注入测试 | schema、CAS、权限、恢复和失败路径满足实现契约 | 真实模型会主动选择正确工作流 |
| 确定性语义 fixture | 摘要、Memory、Recall、Skill 的协议与阈值计算可重复 | 真实 provider 的语义效果 |
| 真实 provider workflow smoke | 模型确实调用工具并完成受验证的领域工作流 | 相对 Native Pi 的任务收益 |
| 同模型公共任务配对 | 在相同任务、模型、runtime、预算和 verifier 下比较 Native/Pi-XK | 未注册任务、长任务或其他 Agent 的表现 |
| 隔离三臂效果评测 | relevant Memory 相对 disabled/placebo 是否改变独立 verifier 结果 | 跨模型、跨项目和长期 SLA |

协议测试、功能 smoke 和因果效果必须分开报告。Native Pi 没有 Pi-XK 专属功能，不能因此在专属工作流表中记为失败。

## 2026-08-06 公共任务与工作流

运行基线为 Pi-XK `e08bad29b158372125a4a9652d2b48a1e5da4317`、Pi `0.80.10`、`deepseek/deepseek-chat`、thinking `low`。公共任务使用 Harbor `0.20.0` 和固定 Aider Polyglot revision，Native Pi/Pi-XK 共享任务、模型、工具策略、900 秒预算和独立 verifier，五对任务交替执行且不允许单边重试。

### 公共代码任务

| 指标 | Native Pi | Pi-XK | Pi-XK 变化 |
| --- | ---: | ---: | ---: |
| Verifier 通过 | 5/5 | 5/5 | 持平 |
| 总输入 token（含 cache） | 451,182 | 607,043 | +34.5% |
| 总输出 token | 47,559 | 45,429 | -4.5% |
| 总成本 | $0.052115 | $0.064170 | +23.1% |
| 总耗时 | 2,608.240 s | 2,490.087 s | -4.5% |

按每个 Agent 的五次运行分别取中位数，Pi-XK 耗时低 `19.8%`，但输入 token 高 `74.9%`、成本高 `37.8%`。语言间方差很大、样本只有五个，不能把中位或总耗时差解释为稳定速度优势。

### Pi-XK 专属工作流

共 `15/15` 通过：8 个 faux-provider 确定性场景，加 7 个真实 DeepSeek 断言。它们覆盖 Goal contract continuity、Task child delivery、Chain rollover/L2/restart、compaction 单一路径续接、Ambient Memory D1/D2/review、Skill 发布与无重启热刷新、doctor projection repair 和本地安装。

七个断言来自三个真实 execution group，同组记录共享一次模型消耗，不能逐条重复计费：

| Execution group | 断言 | 输入 token | 输出 token | 成本 | 耗时 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Chain + Memory + compaction + doctor | 4 | 127,580 | 3,121 | $0.011942 | 72.544 s |
| Goal + Task | 2 | 443,324 | 21,869 | $0.033359 | 425.082 s |
| Skill evolution + hot reload | 1 | 226,855 | 12,542 | $0.020254 | 171.631 s |

完整任务表、runtime digest、环境和已修复问题见[受控结果原文](../../evaluation/capabilities/results/2026-08-06/README.md)。

## 2026-08-05 Ambient Recall 效果

评测包含 12 个 sealed task：6 个历史决定正例、3 个 stale/冲突反例、3 个无关一次性负例。21 个独立三臂组共 63 次 run；baseline、等形无关 placebo 和 relevant treatment 使用相同模型、thinking、token/时间上限和工具集。implementation session 与 research/capture、Git 历史、先前 transcript、隐藏 verifier 和期望 patch 隔离。

| 验收项 | 实测 |
| --- | ---: |
| 历史任务 treatment 主动 D1 | 16/18 |
| 历史任务 treatment 相关 D2 | 12/18 |
| 外部 verifier | treatment 12，placebo 2，净增 10 |
| stale/冲突盲从 | 0 |
| 无关任务 treatment D1 | 0/3 |
| treatment/placebo 中位 token | 5,651.5 / 6,174 |
| treatment/placebo 中位耗时 | 5,082 / 8,288 ms |

这证明在该固定模型和密封任务集中，Memory 的相关内容而不只是 D0/工具形状带来了净收益。真实 treatment 没有发生 D3，也没有形成“D2 读取 disputed 后拒绝其结论”的直接 provider 证据；这两项仍依赖确定性 provenance/工具测试。详情见[效果证据原文](ambient-recall-effect-evidence-2026-08-05.md)。

## Memory 跨任务迁移状态

仓库已经提供四臂 Memory transfer harness：Native Pi、Pi-XK Memory off、等形 placebo、relevant learned Memory，并区分学习、完全复用、相似迁移、规则变化和无关任务。确定性 fixture 能验证报告契约与阈值：

```bash
npm run evaluate:pi-xk-memory-transfer-fixture
```

截至本文基线，仓库没有提交一份满足全部 registered attempts 和阈值的真实 provider Memory transfer 报告。因此当前只能确认 harness 可运行，不能把跨任务学习/相似迁移描述为已证明收益。provider、认证、网络、余额或中断导致的部分运行必须标记为 `inconclusive`，不能计为通过或失败。

## 复现入口

```bash
# 已提交的受控结果
npm run evaluate:pi-xk-controlled-result

# 评测计划与确定性协议
npm run evaluate:pi-xk-public-plan
npm run evaluate:pi-xk-capabilities
npm run evaluate:pi-xk-ambient-recall
npm run evaluate:pi-xk-ambient-effect
npm run evaluate:pi-xk-memory-transfer-fixture

# 领域语义评估
npm run evaluate:session-chain-summaries
npm run evaluate:pi-xk-memory
npm run evaluate:pi-xk-skill-evolution
```

`evaluate:pi-xk-ambient-effect` 默认读取确定性 fixture，只证明评测器和隔离协议。真实 provider 结果必须使用新的脱敏 report，记录 commit、模型、runtime、任务/命令 digest 和费用，并在报告中标记 `provider_run`。

## 对外表述边界

可以表述：

- Pi-XK 在受控的五个公共短任务中与 Native Pi 保持 `5/5` parity。
- Pi-XK 的八类专属工作流通过确定性验证，真实 DeepSeek smoke 完成七个断言。
- Ambient Recall 在一次严格隔离、固定模型的密封任务评测中取得 treatment `12` 对 placebo `2` 的 verifier 结果。

不能表述：

- Pi-XK 已在 SWE-bench、Terminal-Bench、DeepSWE 或其他公开排行榜上领先。
- Pi-XK 普遍提高代码正确率、速度或成本效率。
- 不同模型、任务、机器或未来版本会复现同样的 Memory 数字。
- 未完成的 Memory transfer 真实矩阵已经证明“做过一次后相似任务必然更好”。

任何新结论都应保留原始脱敏机器报告、独立 verifier、对照条件和失败记录，而不是依据模型自报或一次成功截图。
