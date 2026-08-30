# ADR-0009：双 IPv4 loopback 与浏览器 authority 分离

- 状态：Accepted
- 日期：2026-08-31
- 取代范围：取代 ADR-0008 第 1 节中 Viewer 监听 `[::1]`、禁止 `localhost` browser authority、`frame-src http:` 与 `desktop-runtime-ready/http.v1` 的具体实现
- 保留范围：ADR-0008 的 HttpOnly session、admin token、trusted-origin、Next custom server、Viewer `/cs2d/`、backup/updater、SQLite/Keychain 等其余决定不变

## 背景

原始桌面验收要求所有内部 loopback socket 只绑定 `127.0.0.1`。ADR-0008 为避免 Cookie 不区分端口而让 Viewer 监听 `[::1]`；这提供了清晰的 host 隔离，但偏离固定验收，并迫使 WKWebView 的 App CSP 使用过宽的 `frame-src http:`。

两个 browser origin 都使用 literal `127.0.0.1` 不可接受：RFC Cookie host matching 不区分端口，App 的 HttpOnly session cookie 会被自动发送到 Viewer 端口。为同时满足 IPv4-only socket、跨 origin iframe 与 Cookie 隔离，必须分开描述“实际 bind address”和“浏览器 authority”。

## 决策

唯一 desktop runtime 继续拥有两个随机端口，但二者的 TCP socket 都精确绑定 `127.0.0.1:0`：

- App socket 与 browser origin：`127.0.0.1:<app-port>` / `http://127.0.0.1:<app-port>`；
- Viewer socket 与 browser origin：`127.0.0.1:<viewer-port>` / `http://localhost:<viewer-port>`。

`localhost` 只是不向用户暴露的浏览器 authority，不是监听地址；Host gate 只接受精确 `localhost:<viewer-port>`，socket 仍拒绝 IPv6、LAN、通配和其他地址。Tauri 仍把 `cs_agent_runtime` 设置为 `Domain=127.0.0.1; Path=/; HttpOnly; SameSite=Strict`，所以浏览器不会把它发送给 `localhost`。Viewer outer handler 在读取路径或资产前额外拒绝任何名为 `cs_agent_runtime` 的 Cookie，形成可观察的 fail-closed guard；无关 localhost Cookie 不阻塞 Viewer。

Node 以一个 `DesktopOriginPair` module 隐藏 bind address 与 browser authority 的差异。它一次绑定并验证两台 IPv4 server，冻结 App/Viewer origin 与 Host，拒绝端口复用，任一失败关闭所有已取得的 socket。Ready wire contract 升为 `desktop-runtime-ready.v2`＋`desktop-runtime-http.v2`；Rust 独立拒绝旧 v1、`[::1]`、Viewer literal IPv4、同端口、LAN、HTTPS、路径、query、fragment 或 userinfo，不能静默兼容。

App CSP 恢复为精确 `frame-src http://localhost:<viewer-port>`，Viewer 保持精确 `frame-ancestors http://127.0.0.1:<app-port>`。iframe `parentOrigin`、双向 `postMessage`、Rust navigation gate 与 Next trusted headers 都继续使用 exact origin；token 不进入 URL、JavaScript、argv、environment、磁盘或日志。

## 被否决的方案

- 双 literal `127.0.0.1` origin：Cookie 会跨端口发送，否决。
- 给全部 Next 页面、API、chunks 增加 cookie path/basePath：会把 transport 复杂性扩散到所有调用者，且 Viewer 仍可请求匹配路径，否决。
- 每次运行随机 sibling `.localhost`：多实例隔离更强，但当前已有 single-instance，新增 runtime ID、DNS 与 readiness interface 成本没有对应收益。
- Tauri custom scheme Viewer：理论上完全没有 Viewer TCP/Cookie，但尚未证明 cs2d 的 module Worker、WASM、IndexedDB、SharedArrayBuffer、COOP/COEP 与 exact `postMessage` origin，保留为后备 Adapter，不作为当前生产路径。

## 验证

- origin module 真实 socket 测试证明两台 server 的 `address()` 都是 `IPv4 / 127.0.0.1`、随机端口不同，失败会清理已取得的 listener；
- Runtime/Web/Rust 测试覆盖 exact Host、旧 v1/[::1]/共享 IPv4/同端口拒绝、Viewer session Cookie guard、精确 CSP/frame-ancestors 与 shutdown；
- prepared 与 bundled real-sidecar 双启动继续覆盖 Next CSS/JS、Viewer assets、SQLite persistence/export/delete/backup 和 route gate；
- release App 的 `lsof` smoke 只接受恰好两个 `TCP 127.0.0.1:* (LISTEN)`，拒绝 `[::1]` 与通配 listener；
- 无界面真实 WKWebView smoke 在锁屏状态下仍完成受保护 `/desktop`、`localhost` Viewer、CSS/JS、cross-origin isolation、SharedArrayBuffer、module Worker 与 parser WASM compile；Viewer Cookie guard 保持未触发，证明 App session cookie 未发送到 Viewer authority。

## 后果

固定 IPv4-only 验收与 cookie 隔离不再冲突，CSP 比 ADR-0008 更窄。代价是实现必须始终区分 bind endpoint 与 browser authority；任何未来重构不得把 Viewer origin重新改为 literal App host，或把 hidden `localhost` 描述为额外 listener。正式公开发行 Gate 仍由第三方权利、updater key、Developer ID 和 notarization 独立决定。
