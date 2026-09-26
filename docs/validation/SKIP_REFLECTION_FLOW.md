# 跳过反思后的立即分析（2026-09-26）

任务skip-reflection-flow，基线136c101；7f2b工作树/codex/jev-decision-assessment。主控拥有Host、实际helper和docs；revision_semantics_review默认配置只读预检后独占新测试，已RELEASE。沿emil/apple即时反馈原则复用原基础分析，无新动画、布局、透明依赖或安装。

| Before | After | Why |
| --- | --- | --- |
| 点击跳过后等待互动保存、Graph同步与提交，再显示已有分析 | 同步发布基础分析与SKIPPED，后台保存 | 已准备内容的呈现无需等待外部响应 |
| Graph回包可能重复记录或覆盖更新的跳过意图 | Session事件一次，仅同cue SKIPPED/FALLBACK可校准 | 用户的更新意图优先 |
| await结束时读取当前history，mirror只在构造时检查 | 捕获对象及ownershipGeneration，case保存后重验再mirror | 旧请求不能修改新review或推进错误恢复点 |

## 实现与边界

`skipReflectionToBaseline`由真实Host调用，不是测试专用流程。publishLocal在第一个await前设置本地FALLBACK、reflection预算1、同步ref认领和一次RECORD_TEACHING_CASE。普通submit在首次保存前认领epoch；跳过使旧submit失效并清busy。后台原顺序仍是interaction→可选Graph→一次最终CUE_CASE→可选mirror。保存失败仍保留旧恢复点；显示成功不等于已保存。

如果用户已经继续，当前UI不接受旧Graph；仍拥有原history时保存原skip，否则不写新review。case保存中切cue时mirror执行前拒绝旧请求。Graph拒绝重复反思并返回原ANSWERED case时，本地skip保持且不mirror该回包。合法Graph校准只更新case，不再次调用RECORD事件，不覆盖已完成状态。

## 验证

- `pnpm exec vitest run apps/web/lib/coaching/session-completion-feedback.test.ts apps/web/lib/coaching/teaching-diagnosis-host.test.ts apps/web/lib/review-history/teaching-save-deadline.test.ts libs/coach-agent/src/teaching-diagnosis-graph.test.ts`：56项通过。
- `pnpm exec vitest run apps/web/lib/coaching/skip-reflection-flow.test.ts libs/session/src/index.test.ts apps/web/lib/playback/cs2d-playback-host.test.ts`：58项通过，其中9项新增。
- 新测试使用实际helper、Session reducer、HistoryController和两例真实Graph；deferred模拟互动/Graph/case等待，验证即时可继续、事件一次、原review保存、换owner拒绝、失败不mirror、v1一次及实际ANSWERED后SKIP拒绝响应。
- `pnpm typecheck`：通过；`pnpm build`：通过。

没有真实浏览器或完整React挂载，无网络/模型、真实Demo、用户数据库操作；不能把模块顺序测试称为UI点击实测。旧浏览器A5独立保留。快速继续可能使Graph生命周期尚未跟上，从而后续沿既有本地fallback继续；本轮不为同步而阻塞显示、不强行回退Graph游标、不冒称远端连续恢复成功。下一项先用实际Controller的小序列核实这一明确限制。
