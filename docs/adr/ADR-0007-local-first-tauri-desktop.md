# ADR-0007：local-first Tauri 桌面宿主、sidecar 与 SQLite 真相

- 状态：Accepted；具体 runtime 实现细节由 [ADR-0008](./ADR-0008-desktop-runtime-implementation-amendments.md) 部分取代
- 日期：2026-08-30
- 影响范围：macOS 桌面宿主、desktop runtime、进程监督、loopback origin、权限、Secret、长期记忆、Agent checkpoint、恢复、更新与发布
- 取代：仅取代桌面运行形态中的“容器技术未决”“桌面仍经 API/云端执行”“PostgreSQL 是桌面长期记忆唯一真相”“Durable Object 是桌面 Agent checkpoint”决定；Web/Cloudflare 的历史与可选 Adapter 保留

## 背景

现有 localhost 模块化单体已经验证 Next Host/Route Handler、cs2d File → Worker/WASM、Playback bridge、Outcome Gate、Session、Coach Agent 和 Memory interface。4.1.1 仍把桌面容器选型后置，并让长期记忆与 Agent checkpoint 的规范文字默认指向 PostgreSQL/Durable Object；这会让桌面实现依赖云端，或在 Tauri 内重新实现 Parser/Session/Memory，破坏 module depth 与 data locality。

桌面目标不是另做一套产品。它仍交付覆盖整场、显式跳过、先看完整处理和结果、再回到决策点讲解的 coaching session。需要冻结的是宿主、进程、存储、安全、更新与发布 seam，并诚实区分“架构已接受”和“实现已验证”。

## 决策

### 1. 宿主与运行单元

Apple Silicon `aarch64` 首发固定使用 Tauri `2.11.5`。Tauri 是监督宿主：负责 bootstrap/settings/update 窗口、Keychain、sidecar 生命周期、health 和更新；它不是第二个 Parser、Renderer、Session、Agent 或 Memory module。

随 app 打包一个自包含 desktop runtime sidecar：pinned Node `24.19.0` binary 与 Next standalone traced resources 在同一进程内运行。sidecar 同时拥有两个由操作系统分配的 `127.0.0.1:0` 端口：一个承载 Next UI/Route Handler，一个承载独立 cs2d Viewer。禁止 `localhost` hostname、LAN、`0.0.0.0` 和 `::`；sidecar 不 spawn grandchildren。

Next 继续是应用 module，cs2d 继续是 iframe 内的 Parser/Renderer 执行 module。Demo 使用原生 HTML File chooser 进入 File → Worker/WASM；同一 Replay 驱动 renderer 与 Analysis Adapter。raw Demo、raw Replay、frames 和文件路径不跨 iframe，也不经 Rust。

### 2. Supervision 与 capability seam

Rust 通过 sidecar stdin 发送一次性严格版本 init envelope，只含 data/cache/log 标准目录和从 macOS Keychain 读取的 secret。readiness、health 与 shutdown 使用严格版本 envelope 和每次启动新建的 token admin transport。nonce/token 不得进入 argv、environment、disk、log、WebView 或前端持久状态；只驻留 Rust 与 sidecar 内存。

main coaching remote origin 拥有零 Tauri capability。只有随 bundle 固定的 bootstrap/settings/update window 可以调用自定义窄命令，且窗口与命令都必须在 AppManifest allowlist。前端不获得通用 shell、filesystem、HTTP、process、dialog 或 opener permission。WKWebView 原生 File chooser 不由 Tauri dialog 替代。

这形成一个深 supervision module：调用方只学习 init/readiness/health/shutdown 的小 interface，进程、端口、token、drain 和 cleanup 实现保持在该 module 内，提高 locality。Playback bridge 是另一条 seam；不得混入 admin token 或宿主命令。

### 3. 桌面 SQLite、Memory 与 checkpoint

Application Support 下的单一 SQLite 文件是桌面 Memory 真相，并保存 preferences、consent、Memory events/records/revisions/tombstones/typed evidence/embeddings，以及 LangGraph checkpoint。共享物理文件不表示领域合并：

- `memory-sqlite` Adapter 实现既有 `MemoryRepository`/`AuthorizationStore` interface；
- SQLite checkpoint saver 独立实现 `BaseCheckpointSaver`；
- 两者使用不同表、migration 与事务入口；
- Memory Domain、Session Domain 和 Agent state 继续分离。

数据库使用 Node built-in sqlite，启用 WAL、foreign keys、`synchronous=FULL`、busy timeout、checksummed migrations 和 single writer。migration/backup/integrity 失败时 fail closed。目录 `0700`，数据库、备份与敏感文件 `0600`。

embedding 使用带 dimension/version/model manifest 的 Float32 BLOB，只对 bounded candidate 集做 exact cosine。首发不加载 `sqlite-vec`。结构化召回优先；向量失败不影响 Memory lifecycle、授权、删除或 Baseline coaching。

Host Recovery 仍在 IndexedDB；Agent checkpoint 在 SQLite。恢复必须执行与 ADR-0004 相同的精确双状态握手：identity、Demo hash、player、route hash、版本、RecoveryBoundary 和 checkpoint id 任一不匹配都拒绝。IndexedDB 不成为 LangGraph saver。

`MemoryWritePolicy`、至少两个不同 Demo 或用户确认的晋级门槛、consent、不可变 revision、tombstone 与 late-event 防复活语义不变。桌面本地 event 由 SQLite single-writer 事务幂等收敛，不经 Durable Object/PostgreSQL Outbox。

### 4. Web/Cloudflare 兼容性

Cloudflare Worker、每 session Durable Object checkpoint/Outbox、PostgreSQL `memory-postgres` Adapter、可选 pgvector 和对象存储继续是合法 Web 形态。ADR-0003、ADR-0004 与 ADR-0006 的 Web 历史仍有效；本 ADR 只撤销把这些 Adapter 当作桌面默认或前置条件的解释。

同一运行实例只能有一个 Memory 真相 Adapter 和一个 Agent checkpoint Adapter。不得用双写把 SQLite 与 PostgreSQL 都称为桌面真相，也不得为桌面加一个云端透传 module 来伪装 locality。

### 5. Keychain、目录与日志

Secret 存为 macOS Keychain generic password。WebView 只获得 `status`、`set`、`delete` 窄命令，永远没有 `get`。secret 经 Rust → sidecar stdin 进入内存，不写 SQLite、日志、environment、argv 或前端持久状态。

data、cache、log 使用 macOS 标准目录；日志轮转、有界并脱敏。日志禁止记录 nonce/token、secret、Demo 路径、Memory 正文、raw artifact 或完整身份。

### 6. 更新、回滚与数据安全

官方 Tauri Updater 负责 HTTPS check/download、minisign 验签、`latest.json` 与 SemVer。启动后异步检查，24 小时频控，并支持手动检查。下载与安装分别由用户确认；活跃解析、Session、checkpoint、SQLite write/migration 进入 busy gate。

由于官方 updater plugin `2.10` 的 macOS install 路径没有本项目要求的 restore 保证，不调用其破坏性 install。验签完成后，受审查的 macOS installer 仅在当前 app 同一 volume staging，校验 bundle 签名/权限后使用 `renamex_np(RENAME_SWAP)` 原子交换。缺少原子能力、权限或签名验证时，当前 app 不变并降级打开 DMG。新版本首次 sidecar/数据库 health 成功后才清旧 bundle；失败保留旧 bundle。

数据库升级前创建 SQLite backup 并运行 integrity check。任一步失败都不能修改当前数据库或 app。

### 7. 版本、资产与发布门禁

桌面版本唯一源是 `apps/desktop/package.json`。tag 固定为 `desktop-vX.Y.Z`；release assets 固定包含 `dmg`、`app.tar.gz`、`.sig`、`latest.json`、`SHA256SUMS`。

正式 Release 必须通过 `distribution:audit`。当前 cs2d 固定上游无 LICENSE；Valve 雷达/游戏资源的发布审查状态为 `LOCALHOST_ONLY/REVIEW_REQUIRED`。因此只允许本机开发或 internal RC，公开 workflow 保持 blocked，直到权利记录更新并审查通过。没有 Apple Developer 签名/notarization 凭据时只能生成 ad-hoc、未公证构建，不得标为正式 release。

### 8. UI 与产品不变量

桌面 UI 继续遵循既有 `emil-design-eng` 与 `apple-design` 约束，支持 reduced motion 与 reduced transparency。设置、更新与宿主状态服务于 coaching session，不能把产品退化为报告或运维 dashboard。完整时间线、显式跳过、decision-before-outcome、observable-state future-information boundary 和事实/推断/建议/证据分离全部保持不变。

## 被取代的具体决定

1. **“桌面技术未决/容器选型后置”**：由 Tauri `2.11.5`、Apple Silicon `aarch64` 首发取代。
2. **“桌面仍走 API/云端运行”**：由单一本地 Node/Next sidecar 与双 `127.0.0.1:0` origin 取代；远程 Provider 仍可作为明确 Adapter，但不是桌面运行前置。
3. **“PostgreSQL 是桌面长期记忆唯一真相”**：由 Application Support SQLite 取代；PostgreSQL 保留为 Web Adapter。
4. **“Durable Object 是桌面 Agent checkpoint”**：由 SQLite `BaseCheckpointSaver` 取代；Durable Object 保留为 Web Adapter。

上述取代不改写各决定曾服务的 Web 历史，也不宣称 Tauri/SQLite/updater 已实现。

## 后果

正向后果：桌面无需 Cloudflare/PostgreSQL 前置；Demo、Memory 与 checkpoint 获得本机 locality；宿主 interface 很小，复杂性集中在监督与 Adapter 内；现有 Next/cs2d/Session/Agent 深 module 获得复用，不产生第二套业务逻辑。

代价与风险：需要实现并验证 Tauri 宿主、pinned runtime 打包、SQLite Adapter/saver、Keychain、安全 update/rollback 和 Apple 签名/公证；两个 loopback origin 仍需严格 CSP/origin/token 防护；同文件 SQLite 的 migration、single-writer 与 backup 需要故障注入；第三方权利当前阻止公开发行。

## 实施验收门禁

- sidecar 无 grandchildren，两个监听均为 OS 分配的 `127.0.0.1`，shutdown 后无残留进程/端口；
- nonce/token/secret 不出现在 argv、environment、disk、log、WebView 或前端持久状态；
- main coaching window capability 为空，bootstrap/settings/update 只能调用 allowlist 窄命令；
- File chooser 完整处理 Demo，Rust/Next/bridge 均不接触 path/bytes，raw Replay 不跨 iframe；
- SQLite 从空库迁移、checksum drift 拒绝、WAL/foreign keys/FULL/busy timeout/single-writer、backup/integrity、Memory lifecycle 和 saver typed checkpoint 均有测试；
- IndexedDB Host Recovery 与 SQLite checkpoint 完成精确 handshake，错误 identity/version/checkpoint 拒绝且基础回放可用；
- updater 覆盖验签失败、busy gate、原子交换、无原子能力时 DMG fallback、新版本 health 成功清理与失败保留旧 bundle；
- `distribution:audit`、rights、签名/notarization 未满足时公开 release job 必须失败关闭。

## 当前验证状态

本 ADR 只冻结架构，没有实现 Tauri、sidecar 打包、SQLite Adapter/saver、Keychain 或 updater。已验证基线仍是干净工作树上的现有 localhost/Web module：`pnpm typecheck` 通过，Vitest 为 96 个文件通过/2 个文件跳过、715 个测试通过/4 个测试跳过，Next production build 通过；内存中 browser bundle probe 成功，但最终选择 Next standalone sidecar 以复用已验证的 Route Handler、traced resources 与运行 interface。详细过程与剩余限制记录在 `docs/TECHNICAL_LEARNINGS.md`。
