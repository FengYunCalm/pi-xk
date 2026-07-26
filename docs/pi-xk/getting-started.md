# Pi-XK 上手指南

本指南面向第一次安装 Pi-XK 的使用者。固定版本优先使用 GitHub 二进制归档；参与开发或需要修改源码时使用可信 checkout。本指南假设你已经完成 provider/model 配置，并理解扩展会以当前用户权限执行。

## 1. 前置条件

- GitHub 归档路径不要求 Node.js 或 npm；checkout 路径要求 Node.js `>=22.19.0`；
- 对应平台的完整 Pi-XK 归档，或当前仓库的可信 checkout；
- 已完成 Pi provider/model 配置；
- `fd` 或 Ubuntu/Debian 提供的 `fdfind`，供 Pi 原生 `find` 工具使用；
- 一个你有权写入的项目目录。Pi-XK 会在该目录下创建 `.pi-xk/`。

Pi-XK 当前没有内置权限系统或沙箱。不要在不可信仓库、共享生产账号或无人值守环境中把本指南当作安全部署方案。

## 2. 使用 GitHub 二进制归档

从仓库 Releases 下载对应平台的 `pi-xk-*` 归档、`PI-XK-RELEASE.json` 和 `SHA256SUMS`。先按[GitHub-only 发行说明](github-release.md)校验，再完整解压。Linux/macOS 示例：

```bash
tar -xzf pi-xk-linux-x64.tar.gz
cd pi-xk
./pi-xk --version
./pi-xk
```

Windows 解压 zip 后运行 `pi-xk.exe`。不要只复制可执行文件：同目录的 `PI-XK-RELEASE.json`、`pi-xk-extension/` 和 `pi-xk-docs/` 都是运行时或诊断载荷。归档同时保留底层 `pi` 可执行文件，用于确认未加载 Pi-XK 时的上游行为；日常使用应启动 `pi-xk`。

二进制入口不写 profile package 设置。它在每次启动时显式加载归档内的私有 Extension，并继续使用 Pi 原有的 profile、provider 认证和 session 目录。`pi-xk --version` 会同时显示独立 Pi-XK 版本与内嵌 Pi 基线。

## 3. 从 checkout 构建与安装

首次准备仓库依赖时，在仓库根执行：

```bash
npm ci --ignore-scripts
```

推荐使用仓库提供的本地管理脚本。它会构建 Core/Extension、运行无网络 runtime preflight，并以原子写入更新指定 Pi profile 的 `settings.json`：

```bash
npm run pi-xk:install
npm run pi-xk:upgrade
```

先预览而不构建、不写设置：

```bash
npm run pi-xk:install -- --dry-run
npm run pi-xk:install -- --agent-dir /tmp/pi-xk-profile --dry-run
```

脚本只管理当前 checkout 的本地 package 引用，不复制 package，也不删除任何项目 `.pi-xk/`。修改源码或执行 upgrade 后必须完全重启 Pi。`upgrade` 要求目标 profile 已安装；不会把拼写错误的 profile 静默变成新安装。

需要手工检查时，等价流程仍是构建、preflight 后运行 `pi install /absolute/path/to/packages/pi-xk-extension`。项目级 `pi install -l ...` 仍由 Pi 原生命令管理，不由本地脚本修改。

只试运行一次、不修改 settings 时，可使用 Pi 的临时 package 参数：

```bash
pi -e /home/mechrevo/projects/pi-xk/packages/pi-xk-extension
```

临时加载不会让项目 `.pi-xk/` 也变成临时数据。Session Chain bootstrap、Goal 确认或 Task 启动产生的项目文件仍会保留。

### 项目级安装

只想在当前项目启用时，可在目标项目中使用：

```bash
pi install -l /home/mechrevo/projects/pi-xk/packages/pi-xk-extension
```

这会修改项目的 `.pi/settings.json`。绝对本地路径通常不能直接供其他开发者复用；提交该设置前应先约定每台机器的 checkout 路径或改用未来的固定发行来源。

### 隔离 profile

试用时可让 package 设置、Pi 管理的二进制和原生 session 与日常 profile 分离：

```bash
export PI_CODING_AGENT_DIR=/tmp/pi-xk-profile
npm run pi-xk:install
pi list
```

同一个 shell 中启动 Pi，才能继续使用这个 profile。`PI_CODING_AGENT_DIR` 不是 Pi-XK 数据目录；项目领域数据仍写在当前工作目录的 `.pi-xk/`。

## 4. 首次启动会发生什么

从目标项目根启动 Pi。扩展加载后会注册 `/goal`、`/task`、`/chain`、`/xk` 命令和对应模型工具。

- 空的新 session 会被替换为 Session Chain 的 managed root Segment。
- 已有正文的 Pi session 会被采用为 external root，不复制原文件。
- 项目会出现 `.pi-xk/sessions/`，即使你还没有创建 Goal 或 Task。
- footer 会增加 `Chain <id> · S<n> · <size>` 状态。
- 只有确认 Goal 时才创建 `.pi-xk/goals/<goalId>/`。
- 只有启动 Task 时才创建 `.pi-xk/tasks/<taskId>/` 和 child chain。

先执行以下命令确认扩展与当前 session 的绑定：

```text
/chain status
/xk status
```

若命令不存在，先检查 `pi list`、构建产物 `packages/pi-xk-extension/dist/extension.js`，然后重启 Pi。若 runtime preflight 报 `fd is unavailable`，在 Ubuntu/Debian 安装 `fd-find`，或把可信的 `fd` 放到 Pi profile 的 `bin/` 目录。

## 5. 第一个 Goal

Goal 适合需要多个 run、明确验收和可恢复状态的工作。不要为一个简单问答创建 Goal。

直接提交目标：

```text
/goal 为当前项目补齐用户登录回归测试，并以定向测试通过作为完成条件
```

也可以先打开多行捕获，再把下一条输入作为 objective：

```text
/goal
```

模型只会生成结构化草案，不会在草案阶段执行 Goal 工作。TUI 会显示确认/修订对话框；无 TUI 时使用：

```text
/goal review
/goal revise 增加“不得修改生产配置”约束
/goal confirm
```

确认是第一次创建 Goal 文件并启动持续执行。之后常用命令为：

```text
/goal status
/goal pause 等待外部测试环境
/goal start
/goal end 用户决定终止
```

需要提交以保留字开头的 objective 时使用 `/goal -- <objective>`。例如：

```text
/goal -- status 命令的错误输出需要标准化
```

### Goal 的正常结束

active Goal 的普通模型回复不是完成信号。模型必须先更新 `goal-state.md`，再调用 `pi_xk_end_goal` 并提交所有 required acceptance 的验证证据。需要用户输入或外部变化时，模型应更新状态并调用 `pi_xk_pause_goal`。

用户 `/goal end` 是显式终止覆盖，不要求模型先证明验收完成。它表示“用户要求停止”，不要把这种 ended 状态误读为目标已验证完成。

## 6. 第一个 Task

Task 适合把一个有边界的研究、实现、验证或审查交给独立 child session。用户可以直接启动实现型 Task：

```text
/task start 检查登录模块现有测试覆盖并返回文件和命令证据
```

查看或取消：

```text
/task status
/task cancel 不再需要这项检查
```

父模型也可以调用 `pi_xk_start_task`，明确 role、prompt 与 expected result。child 必须调用 `pi_xk_finish_task` 提交结构化结果；普通文本回复不算成功。

当前约束：

- 一个 parent 同时只能有一个 Task；
- Task 运行时，普通输入进入 Pi 原生 follow-up 队列，Task 终态和结果交付后按输入顺序处理；
- `/task status`、`/task cancel` 和只读 doctor 命令立即执行；Goal/Chain 写命令仍被拒绝；
- child 与 parent 使用同一 workspace 和同一用户权限；
- child 不加载 extension，不能再创建 Goal 或 nested Task；
- child 固定使用启动时的 provider、model 和 thinking level；
- 取消绑定 active Goal 的 Task 会同时暂停该 Goal，之后需 `/goal start`。

## 7. 使用 Session Chain

Session Chain 把一个长期逻辑会话拆成多个完整的 Pi JSONL Segment。常用命令：

```text
/chain status
/chain list
/chain rename 登录回归
/chain archive
/chain list all
/chain history
/chain summary
/chain rollups
/chain rollup config
/chain rollover 阶段性收束
/chain doctor
/chain doctor deep
/chain doctor repair-projections
```

达到 soft 阈值（16 MiB 或 4,000 entries）后，Pi-XK 会在 settled 且 gate 清空时自动 rollover。达到 hard 阈值（64 MiB 或 16,000 entries）后，下一条普通输入必须先成功 rollover 才会送给 provider。

`/chain` 与 Pi 原生命令的职责不同：

| 需求 | 使用命令 |
| --- | --- |
| 打开另一个 Pi 物理 session | `/resume` |
| 在当前 session tree 内跳转 | `/tree` |
| 压缩当前物理 session 的上下文 | `/compact` |
| 切换某条 Pi-XK 逻辑链的 writable head | `/chain` 或 `/chain resume <chainId|prefix>` |
| 从历史 Segment/entry 继续并创建新分支 | `/chain continue <segmentId> [entryId]` |
| 主动切到下一个物理 Segment | `/chain rollover [reason]` |

不要用 `/resume` 代替 `/chain resume` 来推断逻辑链状态。前者只知道 Pi 的物理 session，后者会按 Pi-XK catalog 和 branch head 切换。

### L1/L2 摘要和模型读取

每次 rollover 生成一个 L1 Segment Summary。默认每 5 个 sealed Segment 生成一个 L2 Rollup；每个 branch 独立编号，不完整尾窗不会生成。

```text
/chain rollups
/chain rollup 1
/chain rollup config off
/chain rollup config 3
/chain rollup backfill
/chain rollup backfill 2
```

关闭自动生成不会删除既有 L1/L2。历史窗口不会在升级后自动批量调用模型；使用有限额 backfill 明确产生调用和费用。

模型每次请求只能看到摘要 manifest 的范围、数量和失败状态，看不到摘要正文。需要恢复“之前的决定、原始要求、待办或跨 Segment 约束”时，模型可调用 `pi_xk_list_chain_summaries` 再按需调用 `pi_xk_read_chain_summary`。工具返回内容是历史证据，不是系统指令。

## 8. 停止使用

用户级本地安装可移除：

```bash
npm run pi-xk:uninstall
npm run pi-xk:uninstall -- --agent-dir /tmp/pi-xk-profile
```

可先加 `--dry-run` 查看目标。项目级手工安装仍需在对应项目中用 Pi 的 `remove -l` 移除。移除 package 不会删除：

- 项目 `.pi-xk/` 中的 Goal、Task、Chain 和 artifact；
- Pi profile 中既有原生 session；
- local checkout 和构建产物。

删除任何数据前先阅读[运维与恢复](operations-and-recovery.md)，确认事实源、引用关系和备份范围。

GitHub 归档没有 profile package 引用；停止使用时退出 `pi-xk` 并删除解压目录即可。删除程序不会删除项目 `.pi-xk/` 或 Pi profile 中的原生 session。

## 9. 开发者验证

修改 Pi-XK 代码后，仓库级验证顺序为：

```bash
npm run test:pi-xk
npm run check
./test.sh
npm run evaluate:session-chain-summaries
npm run benchmark:session-chain -- --sizes 1,8,32,128 --runs 3 --json
npm run benchmark:session-chain-events -- --counts 100,1000 --runs 3 --json
git diff --check
```

`npm run check` 会执行带写入的 Biome 格式化。多人或多会话共享 worktree 时，先检查 dirty 文件归属，避免重写其他人的改动。不要直接运行仓库全量 raw Vitest；使用 `npm run test:pi-xk`、根目录 `./test.sh`，或 package 内的定向 Vitest 命令。
