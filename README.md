# CS Agent Coach

> macOS Apple Silicon 上的 local-first CS2 Demo 教练。主产品是一场覆盖整场比赛的引导式复盘，而不是赛后报告或问题列表。

## 发布状态：公开下载尚未开放

仓库已经实现并验证本地 Desktop 核心链路，最新资源与 verifier gate 合入后的本机 `.app`/DMG 也已重建复核；但它们只是 ad-hoc internal RC，**当前没有可供普通用户安全下载的公开 Release**。公开发行同时受三类外部事项阻塞：

- 固定的 cs2d 上游没有已记录的明确再分发许可；
- Valve 雷达、武器和游戏资源仍是 `LOCALHOST_ONLY` / `REVIEW_REQUIRED`；
- Developer ID、notarization 凭据和 Tauri updater 正式公钥尚未在公开发布 Gate 中满足，配置里的 updater 公钥仍是显式阻断占位值。

因此不要把本地 ad-hoc DMG、internal RC 或已有 updater 测试描述成已签名、已公证、可公开再分发的 macOS Release。当前状态见 [Desktop distribution audit](./docs/DESKTOP_DISTRIBUTION_AUDIT.md)，发布步骤见 [Desktop release runbook](./docs/DESKTOP_RELEASE_RUNBOOK.md)。

## 普通用户的目标安装体验

以下是 rights、Developer ID、notarization 和 updater 公钥全部通过后才会开放的目标流程，不代表现在已经有公开下载：

1. 从本仓库的不可变 `desktop-vX.Y.Z` GitHub Release 下载 Apple Silicon DMG 和 `SHA256SUMS`；
2. 校验哈希，打开已签名并 stapled 的 DMG，把 `CS Agent Coach.app` 拖入“应用程序”；
3. 正常启动应用，在 macOS 原生文件选择器中选择 `.dem`；
4. 跟随教练从第一回合看到最后一回合，在完整结果播放后回到决策点讲解。

普通用户安装包是自包含的，不需要系统 Node.js、pnpm、Rust、PostgreSQL、Cloudflare、Docker 或单独启动 localhost 服务。Node `24.19.0`、它的完整 `LICENSE`、Next standalone、Viewer/WASM 和 SQLite adapter 都随 app 打包；prepared manifest 记录 Node binary/license SHA，bundle audit 会复核，`THIRD_PARTY_NOTICES.md` 必须保留 Node binary 的来源与许可记录。CI 专用 updater signature verifier 通过 Cargo feature 单独构建，不进入最终 App。

## 产品如何工作

```text
WKWebView 原生 File chooser
        │  .dem 只进入 Viewer 的 File → Worker/WASM
        ▼
Ground-truth Replay + 完整时间线
        │
        ├── ObservableState：决策时真正可用的信息
        ├── Candidate → Director → frozen ReviewPlan
        ├── 完整处理与结果先播放
        └── 回到 decision point：当前状态 → 问题 → 改进
```

核心不变量：

- 每个正式回合都在时间线上，跳过区间有原因且可以展开；
- 地图可以显示当前时刻的全知事实，但建议不能使用玩家当时不知道的信息；
- 事实、推断、建议和证据引用分离；
- LLM 不能解析原始 Demo、发明 tick/坐标或直接控制播放器；
- 总结只归纳已经完成的讲解，不绕过整场带看。

## Local-first 桌面边界

Tauri 只监督一个直接 child：固定 Node `24.19.0` 运行的 desktop runtime。它不会实现第二套 Parser、Session 或 Memory。

- App 与 Viewer 两个 socket 都随机绑定 `127.0.0.1:<port>`；浏览器分别使用 App 的 literal IPv4 authority 与 Viewer 的隐藏 `localhost:<port>` authority，形成 cookie 隔离。`localhost` 不是额外 listener，端口与地址对用户不可见，也不要求用户手工启动服务器。
- Rust 在导航到 `/desktop` 前写入 `HttpOnly; SameSite=Strict; Path=/` 的 `cs_agent_runtime` cookie。cookie 进入 WKWebView cookie store，但 URL 和 JavaScript 都读不到它。
- Protected sidecar 只有在精确 Host 和唯一 43 字符 cookie 都通过后，才覆盖注入可信 `x-cs-agent-app-origin`。所有 Desktop coaching 与 Memory 写路由共享同一 trusted-origin 校验；前端不能靠自报 header、Origin 或 deploy target 冒充桌面请求。
- admin token 只存在于 Rust 与 sidecar 内存，用于 health、backup 和 shutdown；它不进入 WebView、URL、argv、environment、磁盘或日志。
- remote coaching WebView 没有 Tauri capability。只有 bundle 内的 bootstrap/settings/update 窗口能调用 AppManifest 明列的窄命令。
- Demo 路径、bytes、raw Replay 和 frames 不经过 Rust、Next Route Handler 或 Agent。
- Sidecar 使用精确 filesystem allow-list、`--jitless` 和 child permission deny；Node 不得创建 grandchildren。

## 本地数据、记忆与 Provider

桌面 Memory 与 Agent checkpoint 的真相是 Application Support 下同一个 SQLite 文件中的独立表/adapter，不依赖 PostgreSQL 或 Durable Object。

- SQLite：WAL、foreign keys、`synchronous=FULL`、busy timeout、checksummed/atomic migration 和 single writer；敏感文件权限为 `0600`，目录为 `0700`。
- 召回：结构化过滤优先；默认 `local-unicode-feature-hash/1.0.0` 把 Unicode 1–3 gram 哈希为 256 维 Float32 向量，只在有界候选集上做精确 cosine，未启用 `sqlite-vec`。它是确定性的词法相似度补充，不是神经语义模型。
- 生命周期：单 cue 先形成候选；跨不同 Demo 重复或用户确认后才晋级；纠正产生不可变 revision，删除产生 tombstone，迟到事件不能复活记录。
- 管理：设置/记忆页提供真实的导出、删除与 SQLite backup；Desktop 删除由 SQLite single-writer、tombstone/deletion marker 和本地 no-op invalidator 收敛，不依赖 Cloudflare Outbox。Web/Cloudflare 的严格通知/invalidation 规则不变。migration、update 和 restore 都先做 integrity/manifest 校验并失败关闭。
- Provider：DeepSeek 或 OpenAI-compatible 的 API Key 存在 macOS Keychain generic password 中。WebView 只能查看“是否已保存”、设置或删除，永远不能读取密钥明文；非 secret base URL/model 写入 `0600` 本地配置。

## 数据位置与卸载

标准路径由 Tauri identifier `com.csagent.coach` 解析：

| 内容 | 默认位置 |
| --- | --- |
| SQLite、provider 配置、备份、update receipt | `~/Library/Application Support/com.csagent.coach/` |
| 可重建缓存 | `~/Library/Caches/com.csagent.coach/` |
| 有界脱敏日志 | `~/Library/Logs/com.csagent.coach/` |
| Provider API Key | macOS Keychain service `com.csagent.coach.provider`，account `api-key` |

路径也会在 bundle 内 settings 窗口显示。卸载前如需保留个人数据，先使用应用内导出/备份。随后退出应用、删除 `.app`；若要彻底清除数据，再通过 Finder 删除上述三个精确目录，并在“钥匙串访问”中删除对应 generic password。不要删除整个 `~/Library`、整个 Keychain 或其他应用目录。

日志不应包含 token、secret、Demo 路径、Memory 正文、raw artifact 或完整身份。提交 Issue 前仍需人工检查并脱敏。

## 更新模型

实现的目标流程是：HTTPS `latest.json` check → Tauri/minisign 下载验签 → 用户分别确认下载与安装 → coaching/SQLite busy gate → runtime 进入 `DRAINING` 并拒绝新 Next 请求 → 等待既有 handler 与 response 都完成、active count 归零 → pre-update SQLite backup 与 integrity → 同 volume staging → Developer ID/team/版本/权限校验 → `renamex_np(RENAME_SWAP)` 原子交换 → 新版本首次 sidecar/database health → 确认或回滚。

这个 activity counter 只覆盖 Next/API 工作；Viewer iframe 内 parser 是纯本地计算，不产生 server write。关闭主窗口只会隐藏窗口，当前复盘仍保持 busy；只有在 Settings 明确点击“结束当前复盘”，且应用成功切到 bundled maintenance page 后才允许安装。“稍后”或关闭 Settings 会恢复原复盘。

不能安全交换时保持当前 app，并提供同版本 DMG fallback；fallback 按钮只会一键打开固定的 `desktop-v{version}/CS-Agent-Coach_{version}_aarch64.dmg` GitHub asset，不接受 manifest/前端任意 URL。应用不会调用缺少恢复保证的破坏性 updater install。当前公钥是阻断占位值，所以公开 update check/download/install 不可用。CI 先把已有 tag 固定到精确 commit，后续 job 只 checkout 并复核该 commit，同时执行 feature-gated verifier 的公钥与签名自验证；该工具不进入 App。本机已用随测试清理的临时 Tauri key 完成真实 0.1.0→0.1.1 App archive、HTTPS 流式下载、production Rust verifier、篡改拒绝、解包与原子安装/health-cleanup fixture；这不替代 rights、正式公钥、Developer ID 和 notarization 的公开 Release 证据。

## 开发者快速开始

开发仓库与普通用户安装包不同。开发者需要 Node、pnpm、Rust/WASM 和固定上游源码：

```bash
git clone https://github.com/Vek-John/CS-agent.git
cd CS-agent
pnpm install --frozen-lockfile
pnpm cs2d:setup
```

桌面常用命令：

```bash
pnpm desktop:dev          # prepare 后启动 Tauri 开发壳
pnpm desktop:build        # Apple Silicon ad-hoc app + Finder-free DMG；不是公开 Release
pnpm desktop:test         # prepare、unit 与真实 sidecar smoke
pnpm desktop:smoke:bundle # 已构建 app 的 bundle/lifecycle smoke
pnpm desktop:smoke:update-local # 临时签名的 0.1.0→0.1.1 本地 HTTPS 更新 smoke
pnpm desktop:smoke:webkit-demo # 真实 WKWebView + 60.6MB Demo/Worker/WASM/Canvas smoke
pnpm distribution:audit  # 当前应因 rights / updater 公钥门禁失败
pnpm release:check        # release workflow/audit 静态检查；不会发布
pnpm check                # 通用 tests + typecheck + Web production build
```

`desktop:build` 使用检查入库的 ad-hoc identity `-`。Tauri 只构建 App；仓库脚本再用 `ditto`＋`hdiutil` 创建包含 `/Applications` 链接的 DMG，不依赖 Finder/AppleScript。它适合开发机和受控 internal RC，不是 Developer ID 签名或 notarization。若通过下载、聊天工具或浏览器传给另一台 Mac，quarantine/Gatekeeper 可能拒绝启动；不要要求测试者关闭 Gatekeeper，也不要把绕过警告当作签名验证。公开测试应等待正式发行 Gate 全部通过。

### Localhost 开发兼容路径

需要调试 Web Adapter 时可运行：

```bash
pnpm dev
```

该命令启动可见的 `localhost:3000` Next 与 `localhost:5174` Viewer，仅用于开发，不是普通用户安装流程。可选 PostgreSQL、Cloudflare、Durable Object 和 pgvector 属于 Web/部署兼容 adapter；它们不是桌面产品前置。Cloudflare 命令和变量见 [ARCHITECTURE.md](./ARCHITECTURE.md)，不要把云端凭据写入仓库或 `NEXT_PUBLIC_*`。

## 仓库结构

```text
apps/desktop/             Tauri 宿主、bootstrap/settings/update UI
apps/desktop-runtime/     Node/Next sidecar、双 loopback host、admin transport
apps/web/                 复用的 coaching UI 与 Route Handler
libs/memory-sqlite/       桌面 Memory/checkpoint、migration、backup/export/delete
libs/                     Timeline、Observation、ReviewPlan、Session、Agent 等领域模块
tools/desktop-release/    fail-closed distribution audit
docs/                     架构、ADR、release runbook 与验证记录
```

[ARCHITECTURE.md](./ARCHITECTURE.md) 是长期架构唯一事实来源。产品定义见 [PRD.md](./PRD.md)，当前范围见 [MVP_SCOPE.md](./MVP_SCOPE.md)，实现学习记录见 [docs/TECHNICAL_LEARNINGS.md](./docs/TECHNICAL_LEARNINGS.md)。

## 贡献、安全与许可

- 贡献流程：[CONTRIBUTING.md](./CONTRIBUTING.md)
- 安全报告：[SECURITY.md](./SECURITY.md)
- 版本记录：[CHANGELOG.md](./CHANGELOG.md)
- 第三方权利：[THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)

不要自动附加 `.dem`、SQLite/backup、日志、Keychain 导出、API Key、token、完整路径或用户记忆到 Issue/PR。本仓库的 MIT 许可只覆盖原创代码和文档；第三方代码、模型、雷达与游戏资产按各自授权，当前 unresolved rights 正是公开桌面发行保持 blocked 的原因。
