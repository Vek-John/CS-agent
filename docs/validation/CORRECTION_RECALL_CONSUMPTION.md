# 纠正召回与后续教学消费

2026-09-26，基线28c44c5；任务memory-correction-recall。

A1通过：真实规则诊断与一次异议→生产producer→MemoryService→隔离SQLite。实际getBrief的corrections含用户原文和原记录身份，memories不含DISPUTED原聚合。

A2通过：同SQLite repository/authorizationStore接实际POST handler，服务端投影保留content/source=USER/revision，移除principal/memoryId。Graph后续可验证资源诊断为REINFORCE，claims/verdict与无记忆基线相同。不是把USER原文当比赛事实，也不是重新理解历史语义。

A3通过：同会话撤回授权，下一合法START_CUE进入对应cue与cursor，旧Brief清除；后续诊断不再REINFORCE，getBrief纠正为空。测试初次cursor配置漏了0，导致route-order拒绝，是夹具错误，修正后通过；不是生产授权漏洞。

A4通过：相关4文件69tests、TypeScript、production build；补强基线判决/当前cue断言后目标文件3tests与TypeScript复验。仅SQLite experimental warning。

```sh
pnpm exec vitest run apps/web/lib/memory/history-idempotency.integration.test.ts apps/web/app/api/coaching/agent/route.test.ts libs/coach-agent/src/teaching-diagnosis-graph.test.ts libs/memory/src/memory.test.ts
pnpm typecheck
pnpm build
```

A5：主控只修改集成测试与文档，没有生产行为变化；revision_semantics_review默认配置只读链路核实并RELEASE。临时数据库finally关闭、afterEach清理目录/运行时/env stub；Next after被拦截，后续新反思的后台持久化不在本测试范围，不遗留异步写。前轮已验证原始纠正写链。

限制：直接调用生产handler与Graph，不是运行HTTP服务或真实UI。纠正文字实际到达Graph，但当前确定性实现仅以其存在选择模式/工具偏好，原文不进入diagnosisInput；不可验证时DEFER优先。无专业gold、真实Demo或用户Memory。下一项修正Panel对非初次教学模式的错误标题；原桌面锁屏验收独立待恢复。
