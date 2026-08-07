# 研究资料

本目录保存外部项目、论文和生态候选的研究快照。研究材料是设计输入，不代表依赖已经采用、安装经过授权、版本仍然最新或第三方工具可与 Pi-XK 同时写同一项目状态。

## 当前索引

- [Pi 生态研究地图](pi-ecosystem-forum-map.md)：context、memory、subagent、MCP、UI、gateway 和安全工具的候选、冲突面与采用边界。

## 使用规则

1. 采用第三方 package 前重新核对当前版本、许可证、依赖和供应链状态。
2. 触碰 context、compaction、session 或 memory 生命周期的项目，只能在隔离 profile 和临时项目中做替代方案实验。
3. 同一可写 profile 不叠装第二套 context/memory 主机制；Pi-XK Memory、Goal event log 和 Pi 原生 session 的事实边界保持独立。
4. 研究结论不能直接修改事实源、权限、schema 或恢复协议；这类变化必须经过 ADR、实现和契约测试。
5. 日期化兼容信息可能过期，使用前按仓库当前 Pi 版本和 package metadata 复核。
