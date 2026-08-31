# Changelog

本文件记录用户可见和架构级变化。项目尚未发布公开 macOS 稳定版本；版本号不代表 public distribution 已获批准。

## [Unreleased]

### Added

- Apple Silicon local-first Tauri 宿主与自包含 Node `24.19.0`/Next standalone sidecar。
- 参考 Beautiful UI 的本地准备任务流、教练路线进度、诊断选择和三段式建议卡层级。
- `liquid-gooey@0.2.1` 驱动的低频运行阶段形态提示；高频播放控制保持即时响应。
- App/Viewer 双 `127.0.0.1` 随机 socket、literal IPv4/hidden localhost browser authority、HttpOnly runtime cookie、精确 CSP、窄 capability 和单实例生命周期。
- Desktop SQLite Memory/checkpoint、atomic migration、`local-unicode-feature-hash/1.0.0` 256 维 Unicode 1–3 gram 词法向量、精确 cosine、导出/删除、backup 与 update rollback seam。
- macOS Keychain Provider 设置，支持 `NONE`、DeepSeek 和 OpenAI-compatible。
- fail-closed distribution audit、Developer ID/notarization/updater 资产 workflow 和 release runbook。

### Changed

- Desktop 成为主产品；localhost 与 Cloudflare 降为开发/部署兼容 adapter。
- 播放主画面继续占据核心空间，长期记忆入口并入顶栏，教练侧栏与时间轴提高字号、对比和空间层级。
- Demo 继续通过 WKWebView 原生文件选择并在 Viewer Worker/WASM 内解析。
- Desktop 删除使用 SQLite/tombstone/deletion marker 与本地 no-op invalidator，不依赖 Cloudflare Outbox；Web/Cloudflare 严格通知/invalidation 保持不变。
- Updater 使用下载/安装分开确认、显式“结束当前复盘”/恢复 gate、`DRAINING` 后等待 Next handler＋response active count 归零的 SQLite backup、同卷原子交换与首次 health confirmation；关闭主窗口只隐藏且保持 busy。

### Security

- Secret 不进入 environment/argv/URL/SQLite/log/WebView 返回值；remote coaching WebView 保持零 Tauri capability。
- Protected sidecar 在 Host＋43 字符 cookie 校验后覆盖注入 trusted app origin，Desktop coaching/Memory 写路由共享该 origin gate。
- Sidecar 使用精确 filesystem permission、`--jitless` 与 child deny。

### Distribution

- Bundled Node `24.19.0` 同时携带完整 `LICENSE`，manifest/audit 复核 license SHA；CI updater verifier feature-gated 且不进入 App。
- DMG fallback 只一键打开版本固定且重新校验的 GitHub asset；release workflow 将 tag、精确 commit、`HEAD` 与 build SHA 绑定为同一身份。
- Release 临时目录改为在 runner 启动后通过 `RUNNER_TEMP`→`GITHUB_ENV` 注入，避免在 job 级 `env` 使用 GitHub 不支持的 `runner` context 而导致 workflow 0 秒配置失败；right preflight 与最终签名 job 分别使用仓库级和受保护 Environment 批准变量。
- 增加与正式 updater/stable 通道隔离的 `desktop-preview-v*` 未公证 GitHub Pre-release 契约；只发 ad-hoc Apple Silicon DMG 与 SHA256，必须显著披露 Gatekeeper、无自动更新和非 stable 限制。
- 已发布 [`desktop-preview-v0.1.0`](https://github.com/Vek-John/CS-agent/releases/tag/desktop-preview-v0.1.0)：精确绑定 `6f1b841102147c2fd26a5d598af8c84c867af72e`，只包含 206,236,857-byte Apple Silicon DMG 和 `SHA256SUMS`。
- **Formal stable desktop Release 仍 blocked**：当前 arm64 App/DMG 已完成本地重建与复核；再分发授权尚未按 machine-readable audit 格式录入，正式 updater 公钥和 Apple Developer ID/notarization 也尚未形成完整验收证据。
