# 双教学点衔接与前段同步竞态

日期2026-09-27，基线444e5f3，任务guided-two-cue-handoff。

## 真实输入与执行路径

两个小合成回合共176帧：第1回合DEATH，第2回合HP_CHANGE。相同DEATH回合会自然压缩成1cue，因此只调整原始场景；最终真实Adapter自然生成3候选/2cue，分别属于两个回合，没有修改生成后的plan、hash或cue。合成整数时间不是实测Demo tick。

实际Adapter/plan校验→本地Narration→Session reducer→guidedPlaybackDirective/HostPlaybackControl/seek gate→hostCoachingCueSurface→默认CoachAgentRuntime/Stage3 Controller→cuePresentedActionForTerminal→显式ADVANCE_SEGMENT。结果完成前采样pre-roll/decision/end-1都不能看到讲解；end后要求COMPLETE、回decision与pause命令。两个cue分别完成、呈现和消费，重复及首cue迟到ACK不完成第二cue；普通段包括最后一个cue后的尾段也经过observer。

## 发现的产品问题

初版快速推进fixture出现Graph ROUTE_ORDER_MISMATCH。检查表明，observe先预留queuedCursor，但响应尚未确认时start增加token，旧工作放弃确认。新队列用max(confirmed,queued)跳过前置段。真实慢response或checkpoint mirror同样可能触发，不能只让测试等待收据后把问题归为fake clock。

独立有限审查确认最小方案：observerTail已串行，dispatchObserversUntil只从最后confirmed lifecycleCursor继续。旧事件若已进入Graph但尚未被Host确认，重放同一eventId由Runtime processedEventIds去重；既有token、PENDING/CONFIRMED和跨identity清理不变。

另一个同边界问题是start的observerReady回调先处理false再验证owner，旧取消可以把新run状态写成RECOVERY_REQUIRED。将isCurrent检查前置，旧回调不再写失败反馈。生产diff仅这两处，没有放宽路线顺序、结果门、工具资格或增加自动模型重试。

## 验证边界

播放器状态/clock及TEACHING_TOOL_ACK是明确的有界测试输入，不是实际iframe时钟；完整React Host未挂载，未验证真实画面、用户点击或网络延迟分布。Runtime与Controller、幂等checkpoint、选择工具及Session均为生产实现；使用内存checkpoint，无真实Demo/Parser/模型/用户库/GUI或安装部署。

新回归分别延迟已进入Runtime的OBSERVE响应、延迟mirror，以及reset后释放旧响应，验证前段不漏、eventId只处理一次、新owner不被旧失败覆盖。独立审查只读实际diff与测试、未自行运行，不冒称独立测试通过。

## 下一有限目标

把本轮双cue控制链接到既有小Viewer验收页，验证实际iframe播放/返回/跨cue ACK。先复用可用Vite/Vue和loopback白名单服务，小Replay留页面内，一个controller负责启动到清理；只回传计数和位置摘要，不解析真实Demo，不再次尝试旧native锁屏路径。不能把此前单工具Viewer证据与本轮fake clock相加说成完整端到端已通过。

## 结果

规范两例中每次均为2个START_CUE、2个RESUME_TOOL与2条教学工具命令，两个cue分别Presented/consumed一次。全11段覆盖，9条普通段观察与冻结plan顺序一致，Graph到最后cursor；衔接期间新analysis、Narration生成和fetch调用均0。3项deferred竞态原先失败，最小修复后通过。

相关5文件78项tests通过；随后测试代码TS收窄修正，受影响5项及Web类型检查复验通过。日志`.local-data/guided-two-cue-handoff/`保留race-red、规范链、相关回归与最终检查。执行者/独立审查者均释放，controller/timers退出。

```sh
pnpm exec vitest run apps/web/lib/coaching/guided-two-cue-handoff.integration.test.ts
```

最终`pnpm typecheck`、`pnpm cs2d:typecheck`、`pnpm build`、`pnpm cs2d:build`与`git diff --check`均通过，root已读实际日志；没有遗留测试或构建进程。
