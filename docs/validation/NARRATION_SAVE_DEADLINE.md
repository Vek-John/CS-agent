# 完整讲解保存期限（2026-09-27）

NarrationBundle不在原API的有界小产物集合，首批讲解fetch或body挂起会阻挡整个起点durability。实际DAL默认smallJsonMaxBytes=256KiB，超过它只允许AnalysisBundle/CandidateSet外置；Narration不是大文件例外。共享路由接收上限较大且仍会物化已有分析验证，所以复用现有20秒TEACHING等待策略，不声称服务端耗时上界。

只新增NARRATION_BUNDLE到原集合，不改变body/存储上限、引用校验、请求次数或生成流程。起点超时走未确认保存与本地激活，后台超时沿已有同owner错误处理；没有自动重试或服务端撤销保证。

两个新增用例使用实际Adapter的合成内容，经真实API包装器、HistoryPersistenceController、persistPreparedReviewStart和settlePreparedCoachingStart，分别挂起第一个Narration的fetch/body。原代码在20秒后仍未结算，两例红；修复后TEACHING_SAVE_TIMEOUT、unconfirmed一次、激活回调一次。只调用Analysis/Candidate/Plan/首Narration，后续Recovery/head零次；迟到响应不推进，迟到headers不读取正文，计时器清理。

`pnpm exec vitest run apps/web/lib/review-history/prepared-start-persistence.test.ts apps/web/lib/review-history/api.test.ts apps/web/lib/review-history/checkpoint-save-api.test.ts apps/web/lib/coaching/cs2d-route-integration.test.ts`：4文件54项通过；`pnpm typecheck`、`pnpm build`通过。既有重Analysis上传不套checkpoint期限的测试保持。

root独占源码/测试/文档并集中复查，无新代理或后台进程。transport为stub、激活为实际结算函数的回调，不代表完整Host/真实服务器/SQLite。没有读取用户Demo、数据库或调用模型。下一步仅核实失败继续后的本地恢复覆盖；不将单请求20秒描述成全部准备耗时。
