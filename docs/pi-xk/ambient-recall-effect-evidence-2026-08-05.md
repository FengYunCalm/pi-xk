# Ambient Recall 效果证据（2026-08-05）

这是 ADR-0009 的一次独立真实 provider 效果运行摘要。它保留可审计的环境、报告 digest、阈值和限制，但不提交提示词、任务正文、Memory 正文、模型回答、verifier 输出、原始 JSONL 或认证材料。

## 运行边界

| 项目 | 值 |
| --- | --- |
| 基线 commit | `e08bad29b158372125a4a9652d2b48a1e5da4317` |
| provider/model | DeepSeek `deepseek/deepseek-v4-flash` |
| thinking | `off` |
| runtime | Node `v24.14.1`，`linux-x64` |
| 任务矩阵 | 12 个 sealed task：6 个历史决定正例、3 个 stale/冲突反例、3 个无关一次性负例 |
| 物理运行 | 21 个独立三臂组，63 次 run；每次 implementation session 均与 research/capture、Git 历史、先前 transcript、隐藏 verifier、期望 patch 和宿主临时目录隔离 |
| 评测命令标识 | `ambient-effect-deepseek-v4-flash-v1` |
| 评测命令 digest | `sha256:a5af5bc65a39a90b0ed41a8b019cb320de06e68ef51bbe127f5711f9981ae3d6` |
| 脱敏 provider report SHA-256 | `297bc0a824c9b22978561fa52d3dab0827c16b92800932cc1a9f56aa4cf8b6d8` |
| 运行前费用预测 | `$0.028642` |
| 实际费用 | `$0.020264` |

三臂为：无 Memory baseline、metadata/routing 形状匹配但内容无关的 placebo、相关 Memory treatment。每个三臂组共享模型、thinking、token/时间上限和工具集 digest；外部 verifier 只在实现 session 之外运行。

## 结果

| 验收项 | 门槛 | 实测 | 结果 |
| --- | ---: | ---: | --- |
| 历史 task treatment 主动 D1 | 至少 15 / 18 | 16 / 18 | 通过 |
| 历史 task treatment 相关 D2 | 至少 12 / 18 | 12 / 18 | 通过 |
| treatment 相对 placebo 的外部 verifier 净增 | 至少 3 | 10（12 对 2） | 通过 |
| stale/冲突 task 盲从 | 0 | 0 | 通过 |
| 无关 task treatment D1 | 至多 1 / 3 | 0 / 3 | 通过 |
| treatment 中位 token 相对 placebo | 不高于 125% | 5651.5 对 6174 | 通过 |
| treatment 中位耗时相对 placebo | 不高于 125% | 5082 ms 对 8288 ms | 通过 |
| 单 run Ambient Recall 预算 | 不超过既有上限 | 全部通过 | 通过 |

重新执行 `node --import tsx scripts/evaluate-pi-xk-ambient-effect.mjs <redacted-provider-report.json>` 的结果为 `evidenceClass: "provider_run"`、`realProviderEvidence: true`、`findings: []`。

## 结论与限制

该运行证明：在这个固定模型、密封任务集和隔离条件下，安全 D0 路由加上模型自主 D1-D3 检索带来了超过预设门槛的独立 verifier 净收益，并且没有触发无关任务的主动检索或超过既有预算。

它不证明所有模型、代码库或任务类型都会获得相同收益，也不授权扩大 D0 内容、Host 自动检索、候选注入或工具预算。三项 stale/冲突任务都没有盲从，但本次真实运行没有形成“模型已 D2 读取 disputed Memory 后再拒绝其结论”的直接证据；该语义仍由确定性 provenance/工具测试覆盖。D3 也没有在本次真实 treatment 中发生，因此该报告不能替代 D3 的直接真实行为评测。

若将来重新评测，必须生成新的脱敏 `provider_run` report，并以当时的 commit、模型、运行时、任务 digest、命令 digest 和成本重新判断，不能把本页指标当成长期 SLA。
