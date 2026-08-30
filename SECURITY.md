# 安全政策

## 报告漏洞

请使用 GitHub 的私密安全报告渠道（Security Advisories / “Report a vulnerability”）。如果该渠道不可用，请先提交一个**不含技术细节和用户数据**的 Issue，请求维护者提供私密联系方式。不要公开可利用细节、API Key、token、Keychain 内容、Demo、数据库、日志或用户记忆。

安全报告请包含受影响版本/commit、平台、最小复现步骤、预期与实际边界，以及经过脱敏的错误码。不要自动上传诊断包。

## 当前支持范围

- 首发目标：macOS Apple Silicon，Tauri `2.11.5`。
- 公开桌面 Release 当前被 rights、正式 updater 公钥和 Apple 签名/notarization 外部事项阻塞；因此没有可承诺安全更新支持期的公开稳定版本。
- localhost/Cloudflare 是开发兼容路径，不代表桌面发行状态。

## 关键安全不变量

- `.dem` 只进入 WKWebView 原生 File chooser → Viewer Worker/WASM；Rust、Next、Agent 不接触文件路径/bytes。
- App/Viewer 两个 socket 都只监听随机 `127.0.0.1` 端口；Viewer 仅使用隐藏的 `localhost` browser authority 做 Cookie/origin 隔离，不监听 IPv6、LAN 或通配地址。
- runtime session 使用唯一 43 字符 HttpOnly/Strict cookie；admin token 不进入 WebView。
- protected sidecar 严格验证 Host＋cookie 后覆盖注入 `x-cs-agent-app-origin`；所有 Desktop coaching/Memory mutating routes 共享 trusted-origin helper，不信任客户端同名 header、Origin 或 deploy target。
- remote coaching WebView 零 Tauri capability；bundled 窗口仅有 AppManifest allowlist 窄命令。
- Provider Key 只存 macOS Keychain，并只经 Rust → sidecar stdin 进入内存。
- SQLite、备份、日志与配置使用最小权限；更新 backup 必须先进入 `DRAINING`、拒绝新 Next 请求并等待 handler＋response active count 归零，再备份/校验并支持原子回滚。
- 关闭主窗口只隐藏并保持复盘 busy；必须由 Settings 的显式“结束当前复盘”成功导航 bundled maintenance page 后才允许安装，“稍后”或关闭 Settings 会恢复。DMG fallback 只打开版本固定、重新校验的 GitHub asset URL。
- sidecar 为唯一直接 child，固定 Node `24.19.0`、精确 filesystem permission、`--jitless`、无 grandchildren。
- 固定 Node tar 同时提供完整 `LICENSE`，manifest 与 bundle audit 复核 license SHA；CI updater verifier 是 feature-gated 工具，不得进入 App。
- Desktop 删除由本地 SQLite/tombstone/deletion marker 收敛，不依赖 Cloudflare Outbox；Web/Cloudflare 的严格 invalidation 规则不得被桌面分支削弱。

任何能绕过上述边界、泄漏 future information/secret/user data、扩大 loopback/capability、跳过 updater 验签/backup/rollback 或复活已删除 Memory 的问题都应按安全漏洞报告。
