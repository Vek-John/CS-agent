# Coach Agent domain glossary

本文件只提供非规范领域术语；长期架构事实仍以 `ARCHITECTURE.md` 为准。

## Terms

- CoachRun：围绕一名选定玩家和一条教学路线展开的一次教练过程，包含当前片段、教学进度和可追溯结果。
- CoachAgentEvent：推动 CoachRun 发生一次领域变化的外部事件，例如开始片段、提交工具观察或结束过程。
- TeachingCapability：在当前片段中可用的一种受证据约束的教学方式，描述它能帮助用户理解什么。
- TeachingMove：本次片段实际选择的一项 TeachingCapability，以及选择来源和教学依据。
- ToolObservation：外部教学工具对一次 TeachingMove 的结构化观察，包含完成状态和已知限制。
- SessionTheme：跨片段反复出现、可由证据支持的教学主题，包含其出现范围和冲突情况。
- AgentEffect：CoachRun 请求领域外部动作或观察的可审计效果，不等同于任意播放器命令。
- AgentCheckpoint：CoachRun 在稳定边界上的可恢复快照，用于判断后续事件是否仍属于同一过程。
- RouteObservation：对既定教学路线片段的领域观察，只记录当前进度，不改变片段顺序或时间权威。
- PresentableCueSummary：一个片段在结果完成且可展示后形成的、受证据引用约束的完成摘要。
- SessionSummaryInput：由已完成片段和反复主题组成的受限总结输入，供总结者引用，不是新的片段文案。
- SessionWrapUp：一次 CoachRun 结束时对反复主题的全场总结，不是新的 cue，也不改变既定路线。
- SessionWrapUpRequest：由 SessionSummaryInput 和已展示 cue 的核心问题、改进方式、Advice 文本及引用组成的总结输入。
- SessionWrapUpBundle：逐个对应反复主题、带合法 cue/evidence 引用和 Advice 引用的全场总结结果。

## Recovery terms

**SessionRecoveryRecord**:
一场未完成复盘在浏览器本地留下的有界恢复描述，关联原会话身份、冻结路线和最近稳定教学进度；它不是 Demo、Replay 或历史记录。
_Avoid_: AgentCheckpoint、Replay cache、history entry

**RecoveryBoundary**:
Host、CoachingSession 与 Coach Agent 都能验证的稳定教学边界；瞬时播放画面、执行中的工具和任意自由跳转位置都不是 RecoveryBoundary。
_Avoid_: current tick、resume point、UI snapshot

**ReplayAvailability**:
当前页面是否重新拥有可执行 Replay 的三态事实：`ABSENT`、`LOADING` 或 `READY`；只有 `READY` 才允许恢复握手继续。
_Avoid_: loaded、connected、Agent status

**RecoveryHandshake**:
同一 Demo、玩家、冻结路线、版本、Session boundary 与 Agent checkpoint 共同匹配后，恢复原 CoachRun 的一次受校验协调。
_Avoid_: reload、rehydrate、checkpoint restore

## Avoid

- 用“建议”代替 TeachingCapability；建议是教学内容，能力是可执行的教学方式。
- 用“动作”代替 TeachingMove；动作可能没有教学选择或依据。
- 用“结果”代替 ToolObservation；结果可能丢失工具限制和观察范围。
- 用“恢复 checkpoint”代替 RecoveryHandshake；Agent checkpoint 只覆盖恢复所需状态的一部分。
