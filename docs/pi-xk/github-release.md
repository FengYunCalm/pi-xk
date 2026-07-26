# Pi-XK GitHub-only 发行

Pi-XK 使用独立的 `pi-xk-v<semver>` GitHub Release 版本线。它不发布 `pi-xk-extension`、`pi-xk-core` 或 fork 版本的 `@earendil-works/*` npm package，也不改变 npm `latest`。底层 Pi package 版本与 Pi-XK 产品版本分别记录。

## 发行物

每个 release 包含：

- `pi-xk-darwin-arm64.tar.gz`
- `pi-xk-darwin-x64.tar.gz`
- `pi-xk-linux-arm64.tar.gz`
- `pi-xk-linux-x64.tar.gz`
- `pi-xk-windows-arm64.zip`
- `pi-xk-windows-x64.zip`
- `PI-XK-RELEASE.json`
- `SHA256SUMS`

每个平台归档内部包含：

```text
pi-xk/                         # Windows zip 直接以归档根为此目录内容
  pi-xk[.exe]                  # 默认入口，自动加载 Pi-XK
  pi[.exe]                     # 未自动加载 Pi-XK 的底层 Pi 入口
  PI-XK-RELEASE.json
  pi-xk-extension/
    dist/
    node_modules/pi-xk-core/
  pi-xk-docs/
  docs/                        # 底层 Pi 文档
```

`PI-XK-RELEASE.json` 的 schema 为 `pi-xk.github-release.v1`，记录 Pi-XK version、tag、完整 source commit、内嵌 Pi base version、入口和 extension 路径。它是发行 provenance，不是项目 `.pi-xk/` 数据，也不包含凭据。

## 下载与校验

从同一个 GitHub Release 下载目标归档、顶层 manifest 和 `SHA256SUMS`。Linux x64 示例：

```bash
rg '  (pi-xk-linux-x64.tar.gz|PI-XK-RELEASE.json)$' SHA256SUMS | sha256sum -c -
tar -xzf pi-xk-linux-x64.tar.gz
cd pi-xk
./pi-xk --version
```

Windows PowerShell 可分别计算摘要并与 `SHA256SUMS` 对照：

```powershell
Get-FileHash .\pi-xk-windows-x64.zip -Algorithm SHA256
Get-FileHash .\PI-XK-RELEASE.json -Algorithm SHA256
```

校验失败时不要运行或局部修补归档，重新下载完整 release。`pi-xk` 启动时还会验证相邻 manifest、底层 Pi 版本和 extension 路径；缺少任何运行时载荷都会拒绝启动。

## 运行与 profile

完整解压后，从目标项目目录启动归档中的 `pi-xk`。它使用 Pi 原有的 `PI_CODING_AGENT_DIR`、provider 认证、模型设置和原生 session；不会把私有 package 写入 profile `settings.json`。显式加载的 Pi-XK extension 不受 `--no-extensions` 对自动发现资源的关闭影响。

首次进入项目后会按正常产品行为创建 `.pi-xk/sessions/`。先运行：

```text
/xk status
/chain status
```

归档中的底层 `pi` 仅用于对照或诊断。它不会自动加载 Pi-XK，因此不能作为日常 Pi-XK 入口。

## 升级与移除

升级时下载并校验新 release，解压到新目录，执行 `pi-xk --version` 后再替换启动路径。不要覆盖旧目录中的部分文件。Pi profile、原生 session 和项目 `.pi-xk/` 不在程序目录中，因此不会随二进制升级被删除。

停止使用 GitHub 归档时退出进程并删除解压目录。项目 `.pi-xk/` 和 profile session 会保留；需要删除这些数据时先按[运维与恢复](operations-and-recovery.md)确认事实源和备份范围。

## 版本规则

- Pi-XK 当前版本来自仓库根 `pi-xk-release.json`。
- tag 必须严格等于 `pi-xk-v<version>`。
- `pi-xk --version` 输出 `pi-xk <version> (pi <baseVersion>)`。
- Pi-XK version 不声称已合入更高版本 upstream Pi；底层版本单独显示。
- 普通 upstream `v*` tag 与 `pi-xk-v*` workflow 相互独立。

## 维护者发布流程

1. 在独立 PR 中更新 `pi-xk-release.json` 和 `docs/pi-xk/CHANGELOG.md`，并确认 changelog 存在对应版本 section。
2. 运行定向发行测试、`npm run check`、`./test.sh`、`npm run test:pi-xk`、benchmark 和本机单平台 `npm run release:pi-xk:local -- --platform <platform>` smoke。
3. 合并 PR，确认目标 `main` commit 的 CI 全绿且工作区干净。
4. 获得正式发布授权后，在该 commit 创建并推送 `pi-xk-v<version>` tag。
5. `.github/workflows/build-pi-xk-release.yml` 重新执行检查和测试，构建六个平台，校验 checksum，先创建 draft GitHub Release，成功后再发布。
6. 验证 GitHub Release 的 tag、manifest、六个归档、checksum，以及至少一个下载后 `/xk status` smoke。

tag workflow 没有 npm job、npm OIDC environment 或 npm publish 命令。构建、staging 或发布失败时不会公开半成品 release；已创建的 draft 会被清理。不要用 upstream `release:patch`/`release:minor` 生成 Pi-XK tag。
