# ADR-0010: 本地 Demo 资料库与可恢复复盘历史

> 状态：Accepted
> 日期：2026-09-02
> 修订：2026-09-03
> 取代范围：ADR-0007/0008 中“原始 Demo 永不进入 sidecar 文件系统”的实现限制、ADR-0008 中 backup activity 只覆盖 Next/API 的旧限制，以及 ADR-0007 第 2 节“main coaching remote origin 零 Tauri capability”的绝对限制；后者只被 `open_settings` 窄导航命令取代，不改变 Agent/LLM/Memory 无权读取 raw Demo，也不授予文件、Provider、资料库管理或通用 Tauri 权限。

## 背景

当前桌面应用只把用户选择的 `File` 交给 cs2d Viewer/Worker。未完成会话在 IndexedDB 中最多保留少量恢复记录，完成后删除；原始 Demo、完整 Narration、CueCase、用户回答、总结和用户可见进度没有永久 Review 索引。用户重启后仍需重新找文件，现有恢复还可能为缺失 Narration 再次调用模型。

cs2d 自带 history 会把完整 Replay 冗余写入 Viewer IndexedDB；它不是应用托管的原始 Demo 资料库，也不能提供 Review/Revision、删除引用或长期 Memory 幂等语义。

## 决策

1. 在唯一 desktop runtime sidecar 内建立 `LocalReviewLibrary` 深模块；Tauri main coaching window 仅增加 `open_settings` 窄导航 capability，继续没有通用 filesystem、shell、HTTP、dialog、opener 或资料库管理能力。
2. 复用 Tauri `dataDir` 与现有 SQLite owner。目录为 `library/demos`、`library/artifacts`、`library/tmp`；数据库只存相对路径。
3. 首次导入先于 WASM 解析：Viewer 发出有界元数据请求，受保护 Host 申请一次性 IMPORT capability，Viewer 以 Authorization header 向自己的 loopback authority 流式发送 `File`。sidecar 通过固定 high-water-mark 的 backpressure pipeline 同时计算 SHA-256、校验大小/`PBDEMS2`、fsync 并不可覆盖地发布内容寻址文件，但此时只登记为 `IMPORTING`。Viewer 随后用同一 `File` 执行真实 Worker/WASM parser，再用一次性、绑定 Demo 的 VALIDATE capability 提交 `READY` 或 `CORRUPT`；只有 `READY` 可读。
4. capability 为 32-byte CSPRNG、仅内存、用途/对象绑定、短 TTL、成功即消费；不进入 URL、日志、SQLite、IndexedDB、Checkpoint 或 Agent state。
5. 数据模型固定为 `DemoAsset → Review → ReviewRevision → ReviewArtifact`，另设 `ReviewRuntimeHead` 和持久化 import/delete job。重新分析只追加 Revision，旧 Artifact 不覆盖。
6. 小型不可重建 JSON 放 SQLite；大型白名单 AnalysisBundle 放校验和 gzip Artifact 文件。绝不持久化 raw Replay、frames 或完整逐 tick 临时对象。
7. 历史打开分两阶段：SQLite control plane 立即显示；Viewer 用单 Demo READ capability 后台取得托管 `.dem` 并仅恢复播放。该路径不启动任何 LLM、Embedding 或胜率分析 Worker。
8. cs2d managed mode 禁止 `recent.save`，避免冗余完整 Replay 与额外压缩内存峰值。
9. 文件系统与 SQLite 按可重试 Saga 处理。`.partial`、状态机和 job ledger 覆盖崩溃窗口；删除 Review 与删除 Demo 分开，删除 Demo 先做引用检查并撤销 read capability。
10. Memory 以稳定 opportunity key claim 行为机会；analysis evidence revision 只更新 provenance，不增加同一机会计数。删除来源保留 evidence tombstone。
11. Demo 的 parser readiness、Artifact 的 JSON/checksum 校验与 Review Revision 的领域语义校验是三道不同门：Settings verify 只能把既有 `READY` 降级，不能把 `IMPORTING`/`CORRUPT`/`MISSING` 晋升；Review History 服务在 Artifact append 与 Revision READY commit 两次复用现有 Analysis、Plan、Narration、诊断和 Recovery schema。
12. `ReviewRuntimeHead` 不能只依赖“存在某个 Recovery artifact”或仅存 key。Host 必须先顺序写入本次 `SESSION_RECOVERY`，DAL 再原子保存并核对其 `artifactId + artifactKey + artifactRevision`、session/run/route/boundary/checkpoint；冷恢复只选择三元身份和内容均与 head 精确匹配的 snapshot，不能唯一回填的旧 head 失败关闭。
13. Demo 删除确认展示精确关联总数和有界 Review 明细，并携带覆盖完整 Review ID 集合的 impact token；关联变化时拒绝旧确认。Demo 删除按内容哈希 tombstone 所有 evidence，包括没有唯一 Review 归属的 evidence。
14. 历史 RESTORE 在 Playback bridge 分发入口丢弃迟到的 `ANALYSIS_PROGRESS/TELEMETRY/FAILED/READY`，防止前一次分析污染已恢复控制面；Viewer 不运行胜率 Worker，并在 `ViewerStage` 命令 bridge 明确发出 mount acknowledgement 后才发布 `PLAYER_SELECTED`，保证 Host 的首次 pause/seek 不会被父级 no-op handler 抢先消费。
15. main remote history sidebar 通过唯一 `open_settings` 命令显示既有 bundled Settings window；文件、Keychain Provider、删除、验证和统计仍只由各自窄 native/sidecar seam 承担。
16. backup 与 shutdown 使用同一 runtime quiescence tracker：Next、Viewer Library `IMPORT/VALIDATE/READ`、Settings/admin 资料库操作都在 health 仍为 `READY` 时同步登记，handler 与 response `finish/close` 两者完成后才退休；进入 `DRAINING` 后新操作失败关闭。
17. 首次导入的 parser 成功不等于用户可选人。Viewer 必须先用 VALIDATE capability 得到 `READY`，再按 `DEMO_IMPORT_SUCCEEDED → REPLAY_READY` 顺序暴露 exact requestId/demoId/hash 并解锁选人。
18. 历史恢复采用三层 latest-wins：Host open epoch 在每个 await 后复核；Viewer 中止旧 fetch/XHR、串行不可取消的 parser 并以 load generation 屏蔽旧结果；Host 只接受与当前期望 requestId/demoId/hash 完全一致的 managed REPLAY_READY/失败事件，PLAYER_SELECTED 与全部 ANALYSIS_* 也必须绑定该已接受 Replay。文件与 SQLite Saga 还必须恢复“temp 已删除、final 已发布、job 仍 PUBLISHING”的崩溃窗口。
19. migration 006 给 ReviewRevision 增加 artifact contract 版本。新建 Revision 固定为 v2，继续要求独立 CandidateSet Artifact；既有行迁移为 v1，只有已经 READY 且 checksummed AnalysisBundle 能通过现有领域校验时，恢复层才可复用其中完全相同的 embedded CandidateSet。该兼容读取不允许提交新的 v2 RuntimeHead，也不回写或伪造 Artifact。

## 结果

- 用户只需导入一次，可以从复盘历史立即恢复已生成控制面，再后台恢复 Viewer。
- raw Demo 现在会经过受限 Viewer ingress 进入 sidecar 管理目录；这是唯一新增的 raw-byte seam。Next Route Handler、React Host、Agent、LLM、Memory 与日志仍永不接收 bytes 或路径。
- Viewer 恢复的 HTTP 读取可以流式传输，但当前 parser 仍需要完整 `ArrayBuffer`；不得宣称已实现流式 WASM 解析。
- 物理完整性验证不等于 parser 语义验证；崩溃后失去 VALIDATE capability 的 `IMPORTING` 必须收敛为不可读 `CORRUPT`，重新导入并通过 parser 才能恢复。
- SQLite 小备份不包含 Demo/外部 Artifact；完整资料库备份与批量导出留作后续能力。

## 拒绝的方案

- 将 `.dem` 存入 SQLite BLOB：放大备份与 migration 风险。
- 给 Tauri main window 通用文件权限或传绝对路径：扩大攻击面并越过唯一获准的 `open_settings` 导航 capability。
- 复用 `/api/local-demo`：桌面明确禁用，且该链路依赖 Python/工作区临时目录，与默认 Worker/WASM 相冲突。
- 把现有 IndexedDB `SessionRecoveryRecord` 当永久历史：容量、TTL、完成即删除和 Narration 截断均不满足需求。
- 历史点击后自动补算缺失 Artifact：会隐藏成本并违反零重复分析。
