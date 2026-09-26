# 拥挤Brief优先保留完整纠正

2026-09-26，基线d0794ff，任务correction-budget-priority。

A1通过：超长thread使能独立放下的1200字纠正被EMPTY；超长record使两条短纠正被EMPTY。两个旧生产红例转绿。

A2通过：含纠正时先从尾部整条舍memories，再舍activeThreads，必要时清偏好，最后才舍第二条纠正；记录内部advice/限定同时移除，首条内容不截字，两短纠正可同时保留。投影新数组独立，输入JSON不变。

A3通过：首条完整纠正加8条来源限定仍超800时EMPTY且无纠正残留；无纠正大规则原EMPTY路径保持。原删除/身份过滤在预算之前，SQLite召回/授权撤回/真实route回归保持。

A4通过：5文件72tests、TypeScript、production build，仅SQLite experimental warning。

```sh
pnpm exec vitest run libs/memory/src/memory.test.ts apps/web/lib/memory/uncertain-recall.integration.test.ts apps/web/lib/memory/history-idempotency.integration.test.ts libs/coach-agent/src/memory-brief.test.ts apps/web/app/api/coaching/agent/route.test.ts
pnpm typecheck
pnpm build
```

A5：主控实现/关键diff复核，revision_semantics_review默认只读终审无must-fix、RELEASE。全部进程退出，无用户DB/模型/服务或安装部署。

限制：不是智能相关性排序，也不保证所有纠正都能召回；当前教练仍以纠正存在性选择复核。下一项查真实DIRECT_VISION/SPOTTED来源接线与上游语义，避免合成支持被当作parser实有能力。UI锁屏A5独立保留。
