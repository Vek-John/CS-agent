# ADR-0005：默认路线游标与手动 cue 点播分离

- 状态：Accepted
- 日期：2026-08-25

用户自由跳转后可以点播当前位置附近的 frozen cue，但这不能等价为放宽 `START_CUE` 的顺序校验。我们保留严格的 `DefaultRouteCursor`，把乱序教学建模为独立 `ManualCueVisit`；Session 从 frozen plan 推导其播放边界，Agent 通过不写默认 cursor 的显式事件处理它，完成后只增加一次 `PresentedCue`。默认路线随后经过已 Presented cue 时用确定性事件推进并复用现有讲解，不重复 Narrator、Policy 或工具。

该分离使自由 seek 保持纯播放控制，前面未观看的 cue 继续留在默认路线，也让 `RECOVERY_REQUIRED` 只表示真实 checkpoint、网络、bridge 或 ledger 故障。未完成 manual visit 不是 RecoveryBoundary；刷新只恢复此前稳定边界，不把点播过程伪装为完成。
