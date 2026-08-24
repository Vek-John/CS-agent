# ADR-0003：Coach Agent 的运行位置、生命周期与 checkpoint 选择

- 状态：Accepted
- 日期：2026-08-24
- 范围：`libs/coach-agent` Stage 0/1/2 及 Stage 3A 的 Coach Agent runtime

## 背景

教练 Agent 需要在一个 cue 的讲解工具动作前暂停，并在同一 callId 下恢复；Stage 3A 还需要在同一 CoachRun 中继续后续 cue。默认会话仍由现有 CandidateGenerator、Teaching Director、PlanCompiler、Narrator、Session 和 OutcomeGate 负责；本 ADR 只决定 Agent 的运行、生命周期与恢复 seam。

浏览器 LangGraph interrupt 的 AsyncLocalStorage seam 已在真实 in-app browser 连续失败两次：Node/Vitest 可以运行，但浏览器 graph context 会在 `interrupt()` 外丢失。继续堆 browser shim 会把不可用的 graph runtime 和 checkpoint 误带进产品 client。

## 决策

1. 每个 session 由一个 Cloudflare Durable Object 承载 Coach Agent runtime 与 checkpoint。DO 只接收严格的 remote dispatch envelope；浏览器公开入口只使用 `@cs-coach/coach-agent/client` 的 envelope/result schema，不加载 LangGraph graph、runtime 或 saver。
2. DO runtime 使用实际锁定的 `@langchain/langgraph@1.4.12`、`@langchain/core@1.2.9` 和 `zod@4.4.3`，保留 `StateGraph`、`interrupt` 与 `Command({ resume })`。Cloudflare `nodejs_compat` 的原生 AsyncLocalStorage 由 Worker/DO 启动 seam 初始化；不使用 browser AsyncLocalStorage shim。
3. `DurableObjectCheckpointSaver` 通过最小 structural storage interface 保存 LangGraph serializer 的 typed bytes、metadata 和 pending writes；retention 按 thread/namespace 生效。状态不保存 raw Replay、frames、Demo binary、prompt、CoT 或 API key。
4. checkpoint thread 以稳定 `sessionId` 为主键；恢复前逐字段校验 run、demo content hash、selected player、route id/hash。刷新后找不到或不匹配时返回 `DORMANT`，不能误启动旧 run；route mismatch 不会读取另一个 thread。
5. 浏览器只发送匿名、严格 JSON 的 `CoachAgentEvent` envelope，并接收 `CoachAgentResult`。tool request/result 是 remote tool seam 的唯一外部动作；Graph interrupt 前不产生副作用，重复 callId/event 不产生第二个 effect。
6. DeepSeek Policy 继续只通过同源 server/Worker route 调用，secret 留在服务端；Policy 只选择已有 capabilityId，boundArgs 由本地合法 capability 绑定。
7. MemorySaver 保留为 Node/单进程测试 adapter；IndexedDB saver 保留为 Stage 0 实验代码，但不是默认产品路径，也不是浏览器生产恢复方案。默认生产 backend 是 `DURABLE_OBJECT`，结果必须显式报告 `recoverableAfterRefresh: true`。
8. Agent state/event 使用当前 v2 契约；旧 checkpoint 不伪装成新 state，恢复时拒绝并返回 DORMANT，新的 START_CUE 才能建立新 run。一个 run 可以按既定 route 观察多个 cue；已完成 cue 去重，且每 cue 的 Policy 与替代预算独立重置。
9. route lifecycle event 只能观察 frozen route 的 segment；SKIP、FREEZE 和普通观察不调用 Policy。USER_TAKEOVER 会屏蔽旧结果，只有带新 eventId 的合法 cue 恢复事件才能继续。
10. 主题聚合只消费已完成且可展示的 PresentableCueSummary；SessionSummaryInput 只保留最多三个有反复证据的主题及合法 advice refs，不生成新的 cue 文案。
11. SessionWrapUp 只消费已完成的 SessionSummaryInput 与 PRESENTABLE cue 摘要，逐主题产生一次性总结；它不能改变 route、补充 singleton 主题或取回未完成 cue。

## 后果

- 浏览器 bundle 可以只携带紧凑远程 contract；LangGraph runtime 与 checkpoint 实现留在 DO/Worker。
- DO 需要由 Worker route 按 `sessionId` 选定实例，并在实例间复用同一 storage；Worker 路由和 binding 不属于本模块。
- Node/MemorySaver 仍可快速运行单 cue contract tests；IndexedDB 仅用于保留 Stage 0 的失败方案对照，不应被新产品入口依赖。
- Stage 3A 已覆盖紧凑多 cue graph、fake/deterministic policy、受控 playback tool、takeover/cancel 与受限主题总结；完整 route/Host integration、真实 tool bridge 和 provider 端到端恢复仍由后续阶段负责。

## 验证

- `runtime.test.ts` 覆盖 gate readiness、single rule capability、Policy selection/fallback、idempotent resume、identity mismatch、tool failure budget 和 JSON snapshot。
- `runtime.test.ts` 另覆盖多 cue continuation、已完成 cue 去重、route observation 零 Policy、takeover 恢复/旧结果屏蔽、cancel、主题总结和每 cue 替代预算。
- `durable-object-checkpoint.test.ts` 覆盖 LangGraph v4 typed checkpoint、pending writes、latest/list order、namespace retention、deleteThread、DO runtime A/B resume 和 route mismatch。
- `remote-dispatch.test.ts` 与 `browser-client-bundle.test.ts` 覆盖 envelope session binding、strict JSON、client entry 不包含 LangGraph runtime/interrupt。
- `teaching-capability-eval.test.ts` 通过注入 deterministic Policy 实际计算合法生成、need-tool、preferred selection、非法选择和 evidence 引用指标；当前基线要求 need-tool ≥90%、preferred ≥80%、illegal selection 0%。

## 未决限制

- 当前 `test_demo.dem` 的可读 artifact `apps/web/public/generated-data/test_demo.replay.json` 是 parser/planner `1.1.0` 的旧 5-cue bundle，虽然提供 canonical fact/tick 参考，但缺少 `candidate_id` 与 `primary_focus_code`，不能当作当前 Director → PlanCompiler route。
- 技术记录只保留了当前真实纵向 smoke 的 58 candidates/8 cues 汇总，没有保存可直接消费的当前 AnalysisBundle；真实当前 cue id/tick 仍需由 cs2d AnalysisBundle 导出 seam 提供。
- Stage 3A 的 takeover 语义已在 runtime contract/fake tool 中验证；真实 Host takeover bridge、全场 route 输入和真实 provider latency/token 仍需集成验证，缺失的 provider metadata 保持 `null`。

## 参考

- [LangGraph JS interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts)：interrupt 节点恢复会从节点开头重新执行，外部副作用必须位于 interrupt 之后或保持幂等。
- [LangGraph JS persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence)：checkpointer 以 thread 配置保存 graph checkpoint 与 pending writes。
- [langgraphjs issue #879](https://github.com/langchain-ai/langgraphjs/issues/879)：官方仓库记录 browser export 的 interrupt/AsyncLocalStorage 限制；本项目仍以自己的两次真实浏览器失败作为决策证据。
- [Cloudflare AsyncLocalStorage](https://developers.cloudflare.com/workers/runtime-apis/nodejs/asynclocalstorage/) 与 [Durable Object migrations](https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/)：DO runtime 使用 `nodejs_compat` 原生 async context 与 SQLite class migration。
