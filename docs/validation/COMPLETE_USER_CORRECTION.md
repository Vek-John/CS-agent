# 长用户纠正完整传递

2026-09-26，基线4bffdb5，任务complete-user-correction。

A1通过：原真实SQLite集成夹具扩为220字后含否定、总长≤500的异议。诊断修订/producer/持久化正确，真实POST投影却只保留220字前缀，Graph缺少否定；旧实现1红例。

A2通过：单行完整content映射，实际Graph收到与已接受异议相同全文及USER/revision；原Memory目标、重复幂等、机会计数及授权撤回验收保持。

A3通过：两条近1200字、通过MemoryBriefSchema的纠正超预算后只留第一条全文；加合法长规则使整体超额时EMPTY清空thread/correction，不能留下半句，估算≤800。未增加来源或总预算。

A4通过：4文件69tests、TypeScript、production build，仅SQLite experimental warning。

```sh
pnpm exec vitest run apps/web/lib/memory/history-idempotency.integration.test.ts libs/memory/src/memory.test.ts libs/coach-agent/src/memory-brief.test.ts apps/web/app/api/coaching/agent/route.test.ts
pnpm typecheck
pnpm build
```

A5：主控集中复核单行生产改变，无新子任务；临时SQLite已有finally/afterEach清理，route after由既有测试拦截，测试/build退出。无用户数据库、模型、服务或部署安装。

限制：默认教练只按纠正存在性选模式，本轮不证明其理解末尾否定；旧Graph不重写。总预算仍可能清空所有纠正，下一项依据拥挤fixture评估先舍弃整条低优先级内容、保留完整纠正。UI A5独立待验。
