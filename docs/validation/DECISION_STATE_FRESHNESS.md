# 教练状态栏缺采样验证（2026-09-26）

基线：codex/jev-decision-assessment / 9a8d6f5；工作树7f2b。任务decision-state-freshness，主控View/docs；revision_semantics_review默认配置独占新测试，已完成释放。没有用户数据、模型、浏览器、服务或安装操作。

## 真实链与修复

新decision-state-freshness.test.ts使用合成Replay/胜率输入，通过实际Adapter生成review_plan正式cue和material，再进入CoachingPackage、OutcomePackage、确定性Narration和Host同样的View输入。未改compiledPlan或降低提名门。

WIN_RATE_DROP独立负向30个百分点，保留不确定性教学。decision=1064，两情形：最近本人采样1008（过旧）；最近本人1056而1064帧本人缺席。Snapshot.selectedPlayer均null、事实/讲解/位置已排除旧资源，但旧View恢复40HP、75头甲、ak47和$1,234。新增7测试在旧实现2红5绿，修复后全绿。DEATH/HP_CHANGE缺独立上下文仍不提名；1064合法本人前置采样仍展示资源。所有时间是fixture值，不是实测Demo tick。

View现要求现代个人状态匹配OBSERVABLE非空Snapshot、同玩家、sample和decision，且引用解析到该采样的当前DEMO/DECISION可知事实。Snapshot拒绝的旧行不能回到个人状态chip。不可确认说明优先；无chip时不复述旧资源文案。独立公开局面代码不变；旧无Snapshot路径保留兼容。

## 验证

- `pnpm exec vitest run apps/web/lib/coaching/decision-state-freshness.test.ts apps/web/lib/coaching/cs2d-coaching-view.test.ts apps/web/lib/review-history/inventory-restore.integration.test.ts apps/web/lib/review-history/history-restore-controller.test.ts apps/web/lib/review-history/artifact-validation.test.ts`：其余58测试通过；新增7测试最终单独复跑全通过。中途追加时钟断言不符合fixture实际公开信息，已纠正测试假设，未改变生产规则。
- `pnpm typecheck`：通过。
- `pnpm build`：通过。
- 既有SQLite6场景保持：明确空、Flash、Smoke、unknown、无效kind、旧无版本raw；该回归不是新增缺采样SQLite注入。临时库由既有finally清理。

## 限制与后继

本轮是确定性View消费修复，未进行新真实Demo解析、模型专业判断评估或真实浏览器布局验收，原A5桌面路径独立。没有Parser/Adapter/Planner/持久化协议变化。后继仅核实raw.state annotation在当前不确定性cue路径是否实际展示旧位置；没有复现不扩修。
