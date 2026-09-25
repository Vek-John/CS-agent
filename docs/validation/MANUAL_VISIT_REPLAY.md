# 手动回访中的同次处理重播

2026-09-26；基线a3ff09b（产品1bb88e2）。本轮允许最小Session动作/Host接线及USER_INTERACTION兼容变更，不改manual初次播放门或默认路线进度。

## A1 基线与契约

真实Session reducer构造两类manual：默认已看过的cue和从未默认看过的cue。begin清gate、到decision仍LOCKED，均不能提前重播。完成后原动作对未默认看过cue仍拒绝（依赖global revealed），对已看过cue却接受带错误visit身份的动作（旧实现忽略身份）：2红→绿。

入口前态由Host源代码明确：基础按钮整段`!manual`隐藏，诊断manual传`onReplay=undefined`；实际Panel既有SSR无handler测试确认不显示按钮。这不是旧Host浏览器操作录像。旧visit ID生成式将counter放在长session/cue后再截160；匿名100字符session＋100字符cue复现两次生成值相同。获主控确认后改用`manual-${crypto.randomUUID()}`，不扫描或改造其他ID体系。

动作仍为`REPLAY_OUTCOME`，新增可选`target:{sessionId,cueId,visitId?}`。默认旧无target调用保留global revealed门；manual缺target或身份不符均拒绝，且必须PAUSED、本visit对应cue的gate COMPLETE、outcomeEnd匹配、completedAt为合法确认位置。Session导出`canReplayOutcome`给Host预检，reducer再次复核；不接收任意tick，播放窗口只从frozen cue派生。

## A2/A3 入口、控制和记录

| Before | After | Why |
| --- | --- | --- |
| manual基础和诊断表面都无“再看一遍” | 本次完整处理结束后均提供重播入口 | 不必退出本次回访 |
| 统一clearUserTakeover会抹掉手动控制 | manual只reset transport和旧seek，保留接管态 | 返回默认/取消控制保持，默认observer不被重新开启 |
| 无visit身份的global replay门 | 匹配session/cue/visit的本次完成门 | 已看标记不能代替本次播放，旧回调不串visit |

完整诊断仍采用原Panel草稿保护：展开异议或收起后有未提交内容/目标时不显示新入口。basic按钮使用同一生产请求guard，不要求不存在的诊断产物；工具/当前诊断忙碌时禁用/拒绝。原默认回看和继续行为保持，manual继续使用原确认/取消/返回流程。

Host在任何reset/log前拒绝过期target和忙碌条件，并用WeakSet对同一尚未发布的paused Session对象去重。第一次接受后重置transport暂停/等待确认、通知状态并使旧seek失效；manual不调用clearUserTakeover。真实生产guard测试模拟React排队状态，双击只排一个reducer action、只reset/log一次。返回PAUSED后的新状态对象允许同visit再次显式重播，不因去重永久锁按钮。

只读审查确认一个同turn缺口：free seek已同步reset，而CANCEL还在React队列中时，旧liveSession仍可匹配manual身份。UI现在捕获**渲染时**transport epoch，实时请求入口先比较；旧epoch在transition/reset/log之前拒绝。epoch不进Session动作或持久schema。pause notify后的新渲染捕获新epoch，保留pause→replay。

USER_INTERACTION沿用`user-interaction.v1`。新增target严格字段/outer session/cue绑定，禁止额外tick；旧无target、新默认target、manual target的append及ready artifact集合验证均通过。manual key复用既有stable identity token方法覆盖完整session/cue/visit，生成有界标识，避免截掉visit尾部。同visit再次显式重播仍可执行，但用相同逻辑key/payload，存储按原幂等规则处理；不同visit/长ID不同尾部不串key。此token只用于幂等标识，不是安全授权或新哈希体系。

## A4 生产链与测试

- 实际TeachingDiagnosisPanel按钮callback，default/manual参数化，经生产request guard、HostOutcomeReplayGuard、Session reducer、guidedPlaybackDirective与HostPlaybackControl完成回看并回同cue/visit/decision。反思、诊断、verdict、transfer、case/thread/attempt与呈现/消费记录保持，诊断函数仅用于初始fixture一次。
- basic路径使用同一生产入口（`requireDiagnosis=false`）通过集成测试，实际Host内联按钮接线由源审查核对；未挂载完整Host或单独把内联basic区当浏览器测试。
- 暂停→回看清掉等待pause，manual takeover保留；播放中暂停/继续门正常，结束pause/seek到原decision。RETURN_TO_DEFAULT_ROUTE恢复原默认游标；free seek排队取消的旧epoch回调不执行。没有新Stage3工具，既有controller回归保持。
- 已保存问答答案和未提交草稿经真实manual replay/end保留同key，资源cache不重算；不同visit/cue/session target、缺target、缺/错gate和旧确认位置在副作用前拒绝。原未提交异议关闭/重开测试保持。

```sh
pnpm exec vitest run libs/session/src/manual-cue-visit.test.ts libs/session/src/index.test.ts apps/web/lib/coaching/diagnosis-replay.test.ts apps/web/components/playback/teaching-diagnosis-replay.test.ts apps/web/lib/coaching/current-cue-questions.test.ts apps/web/lib/coaching/current-cue-resource-questions.test.ts apps/web/lib/coaching/cs2d-guided-session.test.ts apps/web/lib/playback/cs2d-playback-host.test.ts apps/web/lib/review-history/artifact-validation.test.ts apps/web/lib/coaching/coach-agent-stage3-controller.test.ts
pnpm typecheck
pnpm build
```

最终10文件234项全部通过；TypeScript/Next production build通过。此后仅补同visit连续两次合法回看/同key断言，受影响29项再次通过并再次TypeScript；无新增产品修改。证据日志`.local-data/manual-replay-evidence/`。默认配置只读`manual_replay_boundary_review`指出epoch问题后已修复并测试，主控实际diff复核无其他must-fix；无并行写入。

## A5 / 限制

架构、学习、任务板与本记录同批更新；测试/build退出后commit/push/release。相同visit只保留页面状态，不声称跨visit/cue/重启永久保存。没有真实浏览器、完整Host挂载、iframe或辅助技术验收；SSR/callback/生产状态夹具不能替代原UI暂停A5。无Demo解析、真实模型、用户DB/密钥、UI服务、安装部署/main操作，不宣称专业质量或真实播放性能提升。
