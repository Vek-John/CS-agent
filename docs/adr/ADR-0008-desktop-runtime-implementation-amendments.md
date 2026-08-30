# ADR-0008：Desktop runtime 实现修订、信任边界与发布完整性

- 状态：Accepted
- 日期：2026-08-31
- 取代范围：部分取代 ADR-0007 中“双 `127.0.0.1`”、token 完全不进入 WebView、通用 drain、桌面 principal/Keychain 含混、向量实现未定和 updater 仅为待实现目标的具体细节
- 保留范围：ADR-0007 的 Tauri 单宿主、唯一 sidecar、SQLite 真相、Web Adapter 兼容、零 remote capability、File → Worker/WASM 与 fail-closed distribution Gate 继续有效

## 背景

ADR-0007 在代码落地前冻结了 module boundary，但实现与真实 bundle/smoke 暴露了需要正式记录的具体偏差：两个 IPv4 host 不能提供最清晰的 cookie 隔离；session token 必须在不进入 URL/JS 的前提下授权 Next WebView；Node binary 需要 JIT/permission/license 的可审计打包；update backup 不能在活动 Route Handler 尚未静止时复制数据库；桌面删除不应经过 Cloudflare invalidator；默认 embedding 必须诚实描述为本地词法 feature hash，而不是神经语义模型。

这些都是长期信任边界变化，不能通过原地改写 ADR-0007 抹去冻结时的历史，因此由本 ADR 明确取代具体实现细节。

## 决策

### 1. 双 host 与 WebView 授权

唯一 sidecar 使用两个 OS 分配的 loopback host：

- App/Next：`http://127.0.0.1:<random-port>`；
- Viewer：`http://[::1]:<random-port>`。

禁止 `localhost`、LAN、`0.0.0.0` 和 IPv6 通配 `::`。不同 host 使 App cookie 不会被发送到 Viewer。Rust 在主 WebView 导航 `/desktop` 前设置 `cs_agent_runtime=<43-char-token>; HttpOnly; SameSite=Strict; Path=/`；token 不进入 URL或 JavaScript 可读状态。admin token 只驻留 Rust/sidecar 内存，完全不进入 WebView。

Protected sidecar 在严格校验 Host 与 43 字符 session cookie 后，覆盖写入可信 `x-cs-agent-app-origin`；客户端自报同名 header 不可保留。所有 desktop coaching 与 Memory mutating Route Handler 共用 trusted-origin helper，只接受该进程注入的精确 origin。Desktop iframe URL 显式携带编码后的 `parentOrigin=window.location.origin`，不依赖 referrer、不携带 token；Host 与 Viewer 消息同时校验 `event.source` 和 exact origin。

Next 使用 custom-server request handler 承载页面与 `/_next/static`；直接实例化内部 `NextServer` 虽能返回 SSR HTML，却会漏掉外层静态资产路由，禁止作为 readiness 证据。runtime 注入的精确 App origin 同时进入 Desktop SSR 与 hydration，避免先用占位 port 生成 iframe 后错过 load/bridge。Viewer 的受控 `/cs2d/` build base 在 Desktop handler 内只做解码、traversal 拒绝后的精确前缀映射；Viewer HTML 的远程字体 link 在打包后确定性移除。

App CSP 固定为 same-origin＋per-response nonce script（无 eval/unsafe-inline）、same-origin＋inline style，以及 `frame-src http:`。`frame-src http:` 是 WKWebView 无法可靠解析 IPv6 literal host-source 的兼容层，不是授权边界；Rust 只允许 readiness 中认证的 App/Viewer exact origin 或 bundled maintenance URL，Viewer 仍以 exact App origin 作为 `frame-ancestors`。三层必须一起维护。

### 2. Node runtime、权限与许可

Sidecar 固定 Node `24.19.0` darwin-arm64。准备脚本固定并验证官方 archive SHA、Mach-O architecture、runtime version 与 binary SHA，同时从同一 tar 提取完整 Node `LICENSE`；resource manifest 记录 license SHA，bundle audit 复核，`THIRD_PARTY_NOTICES.md` 保留 binary 来源和 Node/随附第三方许可说明。source map 不进入正式 runtime resource，精确 repo build-root 会在审计前做等长清理，避免把构建机绝对路径误判为 bundled secret；上游 binary 自带的 `/Users/runner` 字符串不作为仓库路径泄漏。

Node 只获得 data/cache/log/runtime/viewer 等精确路径的 filesystem permission，拒绝 wildcard/relative path，使用 `--jitless`，并显式 deny child permission。CI 专用 updater signature verifier binary 通过 Cargo feature gate 构建，不进入最终 App bundle。

### 3. Backup quiescence、退出与 updater rollback

Updater backup 请求先把 runtime 切到 `DRAINING`，拒绝新的 Next 请求，并等待现有 handler 与 response active count 都归零；之后才 drain SQLite writer/checkpoint 并创建 backup/manifest。这个 activity counter 只覆盖 Next/API 活动，不声称跟踪 iframe 内 parser 的纯本地计算。关闭主窗口只隐藏窗口并继续保持 review busy；只有用户在 Settings 明确选择“结束当前复盘”，且主窗口成功导航到 bundled maintenance page 后，才设置 `review_ended` 并允许安装。“稍后”或关闭 Settings 会恢复原复盘。parser 不产生 server write，因此无需把每一帧解析活动变成数据库 busy 状态。

下载与安装继续分别确认。安装前必须通过 coaching busy gate、minisign、safe extraction、Developer ID/team/version/permission、同 volume staging 和 verified SQLite backup；随后使用 `renamex_np(RENAME_SWAP)`，写入 pending receipt。新版本首次 sidecar/database health 成功才确认，失败使用受 manifest/hash/permission 约束的备份原子恢复数据库并交换回旧 app；无法安全交换时保持当前 app，并由一个明确按钮只打开版本固定的 `https://github.com/Vek-John/CS-agent/releases/download/desktop-v{version}/CS-Agent-Coach_{version}_aarch64.dmg`，不接受 manifest 或前端提供任意 URL。不得调用 Tauri 官方破坏性 install 路径。

Release workflow 先把现有 `desktop-vX.Y.Z` tag 解析为一个精确 commit；后续 Apple Silicon job 只 checkout 该 commit，并再次验证 tag、`HEAD` 与 `CS_AGENT_BUILD_SHA` 都等于同一值。tag 名、版本、build SHA 与最终 immutable asset URL 必须形成同一发布身份。

### 4. Desktop Memory、本地删除与默认向量

在 protected session-cookie 单用户 loopback 边界，桌面使用稳定、非 secret 的 local principal；它不读取 Cloudflare/env cookie secret，也不写 Keychain。Keychain 仅保存 Provider API Key。

Desktop 删除的 invalidator 默认为纯本地 no-op：SQLite single-writer 事务、tombstone、deletion marker 和 residue purge 是本地权威，不依赖 Cloudflare Outbox 或网络。Web/Cloudflare 仍保留严格的 Outbox/consumer invalidation 与 consent authority 语义；deploy target 不能相互降级或双写。

桌面默认向量 provider 是 `local-unicode-feature-hash/1.0.0`：256 维 Unicode 1–3 gram feature hash，以 Float32 BLOB 保存并在有界候选集上做 exact cosine。它是确定性词法相似度，不是 neural embedding 或通用语义模型；结构化召回始终优先，向量失败不能阻断 consent/export/delete 或 Baseline coaching。

## 验证状态

- Protected sidecar 已进行两次真实 smoke，覆盖 consent、export、跨进程 persistence 与 delete，均 PASS；测试数据与进程已清理。
- Host/cookie/trusted-origin、Viewer origin、route mutation gate、local invalidator、feature hash、Node permission/license manifest、backup quiescence、updater rollback 和 verifier feature gate 均有对应单元/fixture 或 audit 检查。
- 最终本机 App/DMG 已在 verifier feature gate 与最新资源修订后重新构建；prepared 与 bundled real-sidecar、bundle lifecycle、arm64/manifest/codesign integrity、DMG CRC/内容一致性及真实 Demo GUI 旅程均有验收证据。
- 这些结果证明本地候选实现边界，不证明 public distribution。产物仍为 ad-hoc 签名，distribution audit 按预期停在 Developer ID Gate；第三方权利、正式 updater 公钥、Developer ID 与 notarization 未完成前不得公开发布。

## 后果与剩余限制

Host 隔离与 trusted-origin 不再依赖 referrer或前端自报；backup 获得明确 quiescence；桌面删除和召回不再依赖云端；Node runtime 的许可随 binary 可审计。

代价是 supervisor/runtime/Route Handler 必须共同维护 cookie、header、activity 与 exact permission 契约；词法 feature hash 的能力上限必须在 UI/文档中保持诚实。Public Release 仍受 cs2d/Valve rights、正式 updater 公钥、Developer ID/notarization 和 rights-approved 最终资产验收阻塞。
