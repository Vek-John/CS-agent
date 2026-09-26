# 跨Demo召回中的不确定性

2026-09-26，基线83bcb39，任务uncertain-recall。

A1通过：资源与信息两种真实diagnose产物，各经两个独立合成Demo身份和本地producer、MemoryService/InMemory聚合为EMERGING。verdict INCONCLUSIVE、相关USER claim UNVERIFIABLE仍保留，没有制造已验证习惯。

A2原失败→通过：原规则limitations包含条件建议限定，Agent投影缺失整个字段；2项正确字段红例复现。共享compactTransferRule复制完整限制数组，普通资源/信息brief的非空activeThreads与memories均保留限定，source identity不外泄。

A3通过：schema合法的12×240字限制探针（非新观察/数据库写）超过原预算时，既有EMPTY降级清空memories/activeThreads及唯一advice标记。Wire校验通过，估算仍≤800；正常链consent撤回后空召回。

A4通过：4文件63tests、TypeScript、production build；追加非空thread断言后目标2tests复验。仅SQLite experimental warning来自原route测试。

```sh
pnpm exec vitest run apps/web/lib/memory/uncertain-recall.integration.test.ts libs/memory/src/memory.test.ts libs/coach-agent/src/memory-brief.test.ts apps/web/app/api/coaching/agent/route.test.ts
pnpm typecheck
pnpm build
```

A5：主控实现和真实diff复核；revision_semantics_review默认只读方案审查确认接口/预算并提出大限制回归，RELEASE。生产变化仅共享projection的limitations字段，未改promotion/存储/schema/预算，所有进程退出。

限制：纯内存生产链，非SQLite/浏览器/模型效果验收，无用户数据修改。旧record.advice没有独立limitations，不能声称其原限定已还原；when/do/unless截短本轮未改，下轮用长条件句验证。原锁屏UI A5独立保留。
