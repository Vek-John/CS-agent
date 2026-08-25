# ADR-0004：浏览器 Recovery Record 与 Durable Object Agent checkpoint 双状态握手

- 状态：Accepted
- 日期：2026-08-25

页面刷新后，Replay 必须由用户重新选择同一份本地 Demo 才能重新建立，但冻结路线、Session 稳定边界和 Host 工具去重事实属于浏览器会话，而 LangGraph 状态属于每 session 一个 Durable Object。我们选择双状态恢复：浏览器的 `SessionRecoveryRecord` 保存有界 Host/Session 恢复事实，Durable Object 继续只保存紧凑 Agent checkpoint；两者以会话身份、Demo hash、玩家、route hash、版本、`RecoveryBoundary` 和 checkpoint id 做精确 `RecoveryHandshake`。IndexedDB 因此只承载 Host Recovery Store，不重新启用浏览器 LangGraph checkpointer。

## 决策

- 对 Host 只暴露以下主要 Interface；IndexedDB schema、TTL、迁移、清理和容量控制留在模块内部：

```ts
interface SessionRecoveryRuntime {
  dispatch(event: SessionRecoveryEvent): Promise<SessionRecoveryResult>;
}
```

`SessionRecoveryEvent` 只表达 `BOOT`、`SESSION_STARTED`、`REPLAY_LOADING`、`REPLAY_READY`、`ANALYSIS_READY`、`STABLE_BOUNDARY_REACHED`、`TOOL_LEDGER_UPDATED`、`RECOVERY_HANDSHAKE_COMPLETED/FAILED`、`SESSION_COMPLETED` 与 `DISCARD_RECOVERY`。`BOOT` 不要求调用方预先知道 recoveryId；稳定边界更新同时携带有界 cue 进度、route readiness、最多三个 narration artifact 和 checkpoint id。结果只返回受校验的恢复状态和 Host effect，不返回数据库句柄、File 或 Replay。默认最多保留 3 条未完成记录、TTL 7 天、单条序列化后不超过 1 MiB，完成会话立即删除。
- `SessionRecoveryRecord` 保存会话唯一 `sessionId/runId`、Demo/player/route identity、parser/planner/graph/state/session/recovery 版本、冻结 `ReviewPlan`、最近 `RecoveryBoundary`、cue 进度、最近 Agent checkpoint id、最多 64 条 Host tool ledger 摘要，以及当前 cue 与随后最多两个已准备讲解产物。它禁止包含 File、Demo bytes、raw Replay、frames、完整 AnalysisBundle、地图/模型资产、Prompt、chain-of-thought 或 Secret。
- 初次复盘生成会话唯一的 `sessionId/runId`；恢复复用记录中的身份；放弃恢复或校验失败后开始新复盘必须生成新身份，不能仅由 Demo/player/route 确定性推导并误接旧 Durable Object。
- `RecoveryBoundary` 只允许 `ROUTE_START`、结果 Gate 已完成的 `CUE_PAUSED` 和 `WRAP_UP`。播放中、结果中、重播中、缓冲中、工具执行中和自由跳转位置只保留此前的稳定边界；恢复 seek 的 canonical tick 始终由冻结计划和 `libs/session` 推导，再经 Playback bridge 确认。
- 页面发现未完成记录但 Replay 为 `ABSENT/LOADING` 时只显示 `DORMANT`，不得调用 Director、Narrator、Coach Policy 或推进 Graph。cs2d iframe/Worker 本地计算 hash 并解析；Host 只接收白名单 `REPLAY_READY` 摘要，文件和 Replay 不跨网络 seam。
- 同一 Demo 的 `REPLAY_READY` 通过后，Host 选择记录中的玩家并在新的浏览器分析结果到达后校验版本与冻结计划；不重新调用 Director。缺失的后续 Narration 可以在 Replay `READY` 后按冻结路线继续准备，但恢复画面只使用记录内已校验产物。
- `libs/session` 提供受校验的 capture/rehydrate seam；Host 不得直接拼装或覆盖 `CoachingSessionState`。Agent reconnect 只能观察 Session boundary，不能修改 ReviewPlan、tick、focus、phase 或 OutcomeCompletionGate。
- Host 在发布 iframe 工具命令前先持久化 `POSTED`。刷新后只有 `POSTED` 的调用收敛为 `CANCELLED` 且不重发；已持久化的合法成功结果只向 Graph resume；`RESUMED` 调用保持去重。旧 effect epoch/ACK 永远不能改变新页面状态。
- RecoveryHandshake 任一 identity、route、version、boundary 或 checkpoint id 不匹配即拒绝恢复。用户可重新选择文件或开始新复盘；Agent/IndexedDB/Playback 恢复失败不得阻断基础回放。

Coach Agent 增加唯一的恢复事件 `RECONNECT_REPLAY`：它携带原 `CoachAgentIdentity`、`replayAvailability: "READY"`、期望 checkpoint id、RecoveryBoundary 的只读投影，以及 Host 已持久化的 pending call disposition。Runtime 在读取 checkpoint 后逐项校验；checkpoint 为 `WAITING_TOOL` 时，已持久化的合法 `SUCCEEDED` 结果只执行一次 Command resume，其余 `POSTED/FAILED/REJECTED` 都以 `CANCELLED` 收敛。该事件不得调用 Policy、不得返回新的 AgentEffect、不得改变 route cursor/focus/Session phase/gate；checkpoint id 缺失或不一致返回 DORMANT mismatch，由 Host 降级或创建新 run。

v1 record 的字段范围冻结为：

```ts
interface SessionRecoveryRecord {
  schemaVersion: "session-recovery-record.v1";
  status: "INCOMPLETE" | "INCOMPATIBLE";
  createdAt: number;
  updatedAt: number;
  recoveryId: string;
  sessionId: string;
  runId: string;
  demoContentHash: string;
  selectedPlayerId: string;
  routeId: string;
  routeHash: string;
  versions: {
    parser: string;
    analysisAdapter: string;
    candidateGenerator: string;
    director: string;
    planCompiler: string;
    reviewPlanSchema: string;
    sessionSchema: string;
    graph: string;
    agentState: string;
  };
  frozenReviewPlan: ReviewPlan;
  routeReadiness: Record<string, "PENDING" | "READY" | "FALLBACK">;
  boundary: RecoveryBoundary;
  cueProgress: {
    completedCueIds: string[];
    consumedCueIds: string[];
    revealedCueIds: string[];
  };
  agentCheckpointId: string | null;
  toolLedger: HostToolLedgerSummary[];
  narrationArtifacts: PreparedNarrationArtifact[];
}
```

数组、字符串和嵌套产物仍须由 Schema 单独设上限；`narrationArtifacts` 只保留 boundary cue 与路线中的随后最多两个 cue。`status=INCOMPATIBLE` 只用于记录自身 schema/version 已不能恢复；用户误选其他 Demo 不污染原记录，仍可重新选择正确文件。

`RecoveryBoundary` 是 discriminated union，不接收任意 tick：

```ts
type RecoveryBoundary =
  | { kind: "ROUTE_START"; boundaryId: string; segmentIndex: 0 }
  | {
      kind: "CUE_PAUSED";
      boundaryId: string;
      segmentId: string;
      segmentIndex: number;
      cueId: string;
      sessionPhase: "PAUSED_FOR_COACHING";
      outcomeGateStatus: "COMPLETE";
    }
  | { kind: "WRAP_UP"; boundaryId: string; segmentIndex: number };
```

`libs/session` 根据 frozen ReviewPlan 校验 segment/cue/index、cue 集合和 Gate，再自行推导 decision tick/outcome end；Host、IndexedDB 内容和 Agent 都不能提供恢复 tick。

## 权威矩阵

| 状态 | 唯一权威 | Recovery Record 的角色 |
|---|---|---|
| Demo hash、Replay 与事实 | cs2d Parser/Worker | 只保存 hash，不保存事实流 |
| 冻结路线、tick 与 focus | PlanCompiler 产出的 immutable ReviewPlan | 保存并按 provenance/hash 复用，不重编译 |
| Session phase 与 OutcomeCompletionGate | `libs/session` | 保存 RecoveryBoundary 输入，由 session seam 重建 |
| 实际播放位置与 seek 完成 | Playback bridge / iframe | 只保存 boundary identity，不保存瞬时画面 |
| Agent 状态、Policy budget、processed event | Durable Object checkpoint | 只保存最近 checkpoint id 用于精确握手 |
| 工具副作用与 callId 去重 | Host tool ledger | 保存 POSTED/RESULTED/RESUMED 摘要 |
| ReplayAvailability 与恢复编排 | Host SessionRecoveryRuntime | 保存记录并发出受控 Host effect |

## 恢复状态图

```text
NO_RECORD
  -> ACTIVE
  -> (刷新且存在 INCOMPLETE record)
DORMANT / ABSENT
  -> 用户选择文件
DORMANT / LOADING
  -> REPLAY_READY hash 不匹配 -> MISMATCH -> DORMANT / ABSENT
  -> REPLAY_READY hash 匹配 -> REBUILDING / READY
  -> ANALYSIS_READY + player/version/route 校验
VALIDATING
  -> Session rehydrate -> Playback pause/seek confirmation -> Agent RECONNECT_REPLAY
  -> RECOVERED at ROUTE_START | CUE_PAUSED | WRAP_UP
  -> 任一关键校验失败 -> REJECTED（可重选或创建新 run）
  -> Agent/IndexedDB 非关键失败 -> DEGRADED（基础回放继续）
```

## 后果

恢复不依赖上传 Demo，也不把 Replay 复制进控制面；代价是用户仍需重新选择原文件并等待本地重新解析。Host Recovery Store 与 Agent checkpoint 可能独立成功，因此恢复必须显式握手，不能把“IndexedDB 可读”或“DO 有 checkpoint”单独当作闭环完成。
