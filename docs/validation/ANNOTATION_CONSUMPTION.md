# 不确定性教学点位置标注消费核实（2026-09-26）

任务annotation-consumption，基线4d25954，工作树7f2b。目标是核实上一轮发现的raw.state位置是否真的成为当前教学地图演示；不因存在字段就认定用户已受误导。

## 来源与消费门

- Adapter的worldAnnotation(raw.state, stateCallout(raw.state))确实将旧样本位置写为“你的决策位置”；CandidateGenerator和Compiler保留到正式cue。
- 默认Stage3不是无条件显示cue.annotations。worldPoints取出注解，但buildTeachingCapabilities对当前判断类focus要求独立presentationPurpose；现有唯一用途ACTION_FACT_REPLAY只对应REPLAY_CUE_SLOW，不对应FOCUS_MAP_EVIDENCE。
- 显式Stage2可以因WORLD point选中该cue，但仍进入同一capability-builder；当前REVIEW_UNCERTAINTY不能获得地图工具。
- 默认诊断的buildTeachingDiagnosisInput严格投影material，明确不传annotations和callout。当前cs2d Host没有直接渲染cue.annotations的代码；旧legacy replay-viewer的直接渲染不等于当前入口。

因此本轮不修改Adapter，也不放宽地图工具用途来制造可见失败。以后如引入“本人决策位置事实展示”，应先为新用途建立Snapshot位置与cue/样本/来源绑定，再开放能力；不能将现有annotation存在性直接当作可靠性证据。

## 验证与范围

实际Adapter→未改focus/plan的正式cue→合法冻结route与COMPLETE gate→Stage2/Stage3及诊断入口，覆盖旧样本、当前缺本人和正常新鲜样本。新增annotation-consumption.test.ts共4项通过：三种cue均保留POINT(123,456)，Stage2选择器选中，但两个Host构建入口capabilities均为空，诊断无坐标/位置label；缺本人时decisionResources也为空。默认入口STAGE3与显式STAGE2选择由实际函数验证。

- `pnpm exec vitest run apps/web/lib/coaching/annotation-consumption.test.ts apps/web/lib/coaching/coach-agent-host-adapter.test.ts apps/web/lib/coaching/coach-agent-stage3-host-adapter.test.ts apps/web/lib/coaching/teaching-diagnosis-host.test.ts libs/coach-agent/src/capability-builder.test.ts`：5文件59项通过。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- 代理默认配置只新增该测试，主控已读实际文件与输出，未更改生产逻辑或原有验收门。

全部输入是合成fixture，未解析用户Demo、调用模型、访问用户库或操作浏览器。证据证明当前接口资格门的行为，不声称真实UI已经完成、不认证旧历史所有annotation、不推定专业判断改善。
