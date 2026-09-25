# 整场完成同步失败：明确未生成总结并保留完成/回看

2026-09-26；基线c6f4e2d（前产品f9d9cbd）。本轮仅修改完成请求、Host总结入口与既有失败保存接线；不改Graph/Session完成门、默认diagnostics、专业判断、Memory或重试架构。

## A1 复现与用户反馈

隔离fixture使用真实CoachAgentStage3Controller、真实Host Adapter和生产组件调用的`completeStage3SessionWrapUp`，fake transport拒绝COMPLETE_SESSION。以实际SessionWrapUpPanel做SSR：旧代码将失败吞成undefined，结果只有“本场复盘总结”和“完成本次复盘”，期望“未生成全场总结”的断言失败（1红）。不是只验证新predicate。

| 之前 | 现在 | 原因 |
|---|---|---|
| 完成同步拒绝后总结空白 | 显示“缺少完整的会话摘要，未生成全场总结；已完成的复盘和回看不受影响。” | 真实当前失败进入既有有限失败artifact |
| 网络pending阶段仍IDLE | 仅请求owner显示“正在整理…”；完成按钮可用 | 不将重复/确认过的effect当新请求 |
| 去重、过期与请求失败都undefined | pending/CONFIRMED/settled重复及本地token过期仍无副作用；当前异常/空/未完成/错身份响应返回本地FAILED | 区分无须处理和实际失败，不伪造Graph完成 |

## A2/A3 行为与身份边界

`Stage3SessionCompletion`是本地请求结果：SUCCEEDED携带真实COMPLETED Graph；FAILED不带Graph或错误payload。只有当前完整身份匹配且Graph/sessionStatus均COMPLETED才确认生命周期和调用原checkpoint mirror。错身份响应不引用、不镜像、不存内容，仅保存MISSING_SESSION_SUMMARY。保存沿原`SESSION_SUMMARY / session-wrap-up.v1`，无schema迁移；错误文案不冒充NO_REPEATED_THEME。

Host在请求前捕获generation、session/run、review/revision、persistence实例和history-open epoch，回调/保存均核对。正常完成清除临时run identity后，同一COMPLETED session仍可显示其收尾；切换session/run/review、接管、重置或dispose后的旧结果不写新UI或artifact。

完成attempt按eventId及controller token记录。pending、确认成功或已处理失败的重复effect不重发、重写或覆盖READY/FALLBACK。取消旧owner时释放其PENDING，显式返回同run可以再次完成；旧owner清理仅针对自己的token，不能删新pending或清掉新LOADING。成功确认在异步mirror之后且token仍当前时发生。

29个新增入口集成用例包括：

- pending显示与按钮，真实异常只保存一次；没有可用持久化时仍展示。
- 成功、CONFIRMED重复；六类未完成/空响应；六类错误identity字段不留下错误payload。
- generation/session/run/review/revision/history epoch/takeover/reset/dispose失效返回无写入。
- 正常完成释放identity时旧请求仍可收尾；接管后显式resumeAfterTakeover返回同run；旧/新请求交错时只保存新owner。
- 默认diagnostics ANSWERED与SKIPPED：使用合法frozen/READY输入，经真实synchronizeDiagnosis产生START/OBSERVE transport失败，再runTeachingDiagnosis本地fallback、真实Session reducer记反思并消耗所有cue到WRAP_UP，最后真实完成入口失败提示；COMPLETE_SESSION后仍可由HostPlaybackControl发送自由seek。未启动教学工具或模型。

初版诊断fixture缺少合法READY/frozen条件，只在validator失败；增加dispatch事件断言暴露该不足，补齐fixture后确认实际经过Agent同步失败。没有为夹具放松生产门。

## A4 验证范围

最终命令：

```sh
pnpm exec vitest run \
  apps/web/lib/coaching/session-completion-feedback.test.ts \
  apps/web/lib/coaching/coach-agent-stage3-controller.test.ts \
  apps/web/lib/coaching/session-wrap-up-completion.test.ts \
  apps/web/lib/coaching/session-wrap-up-presentation.test.ts \
  apps/web/lib/coaching/coach-agent-stage3-wrap-up.test.ts \
  apps/web/lib/coaching/deepseek-wrap-up.test.ts \
  apps/web/lib/review-history/artifact-validation.test.ts \
  apps/web/lib/review-history/history-restore-controller.test.ts
pnpm typecheck
pnpm build
```

8文件118项通过，TypeScript和Next production build通过。包含正常Graph总结、原139eb95三类失败保存/恢复、旧成功及历史缺失总结恢复且不重新生成/计费的回归。没有重复全量测试或重新解析Demo。

独立默认配置子代理completion_feedback_review限定只读复核完成入口与身份/保存边界，无must-fix；主控另指出pending显示、取消attempt及当前错identity永久LOADING风险，已修复并以实际入口复验。前端遵循emil/apple的明确反馈原则，复用既有aria-live面板、按钮、样式，不新增动效或透明度。

## A5 交付与剩余限制

ARCHITECTURE、TECHNICAL_LEARNINGS与持续任务板同步；代码与文档在同分支commit/push后释放。隔离测试与构建进程退出，不触及Demo、浏览器服务、真实模型、用户DB、密钥、Memory或部署安装。

验证是生产模块集成加SSR面板，不等同真实浏览器操作；原UI A5仍独立待验。当前dispatchCoachAgentEvent的fetch/json没有客户端deadline：请求永不settle时仍pending，但完成/自由回看可用。本轮处理已失败/无可信结果，不增加通用timeout、重试或新队列；这一等待上限问题保留为独立后续范围。
