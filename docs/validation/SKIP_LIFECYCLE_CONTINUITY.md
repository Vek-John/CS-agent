# 快速跳过后的诊断连续性（2026-09-26）

任务skip-lifecycle-continuity，基线3195bb1，7f2b功能工作树。root负责Host/Controller/来源构造和文档；revision_semantics_review默认配置预检及独占新回归。无外部网络、模型、用户库、Demo、浏览器或安装操作。

## 复现与方案

预检使用实际Adapter生成两段正式cue：第一段DEATH、第二段HP_CHANGE。第一段本地已显示基础讲解但未发Graph START时，Controller直接同步第二段两次均undefined且永久标记lifecycleDegraded；实际仅发出前置两个OBSERVE_SEGMENT。现有OBSERVE_PRESENTED_CUE需要Graph已经有该cue绑定，不能用于第一次登记。

Host现在只在默认路线实际发布SKIPPED/FALLBACK时注册有限的内存凭据。纯构造入口检查当前live、冻结cue/candidate/窗口、Narration身份、完整结果gate和可用baseline；捕获的严格START_CUE事件清空所有capabilities。手动访问、仅历史播放或缺身份信息不注册。

后续Controller按默认路线串行消费observer时，遇到该旧教学段可使用同一完整identity的凭据补记零能力START。只在返回的cue、segment、cursor、完成gate、completedCueIds、空effects/pending tool和identity全部匹配时确认。补记不执行工具、不mirror旧START、不再写Session用户事件，也不调用adapter.prepareStart(oldCue)破坏下一cue注册表。reset清空凭据，排队中的旧token不再派发。最后一cue直接进入总结时，同一identity的凭据会先完成路线补记再COMPLETE_SESSION。

Graph拒绝迟到旧cue时可能返回现有COMPLETED状态而游标并未改变，所以仅看status不足以确认成功。原Graph顺序、工具、判断和持久化协议均未放松；没有可信凭据或真正网络/Graph拒绝仍沿已有fallback处理。

## 验证

新增skip-lifecycle-continuity.test.ts共14项通过。两个cue由实际Adapter编译，未改focus/route；第一cue索引2补记后，第二cue索引8同步成功，再提交实际反思生成诊断case，reflection/diagnostic预算各1。重复不重复completedCueIds/presentedCueBindings；全部skip（含最后cue）可完整到COMPLETE_SESSION及两个completedCueSummaries。并发observer与下一cue按0..8单调串行；无凭据、错run/session/route、未完整gate、错candidate、非skip、非live、reset与错误返回cursor不能假确认。

- `pnpm exec vitest run apps/web/lib/coaching/coach-agent-stage3-controller.test.ts apps/web/lib/coaching/coach-agent-stage3-integration.test.ts apps/web/lib/coaching/session-completion-feedback.test.ts`：67项通过。
- `pnpm exec vitest run apps/web/lib/coaching/skip-lifecycle-continuity.test.ts apps/web/lib/coaching/skip-reflection-flow.test.ts apps/web/lib/coaching/coach-agent-stage3-host-adapter.test.ts libs/coach-agent/src/manual-cue-visit.test.ts`：42项通过，本轮合计109项。
- `pnpm typecheck`、`pnpm build`：通过。

主控检查真实diff并补充第二cue实际诊断断言；代理RELEASE，临时probe删除，无后台进程。模块测试不是实际React点击或浏览器播放；运行期凭据不持久化，不声称旧历史刷新后能重建丢失的未确认状态。
