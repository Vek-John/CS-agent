# 长条件建议完整传递

2026-09-26，基线123c305，任务complete-conditional-advice。

A1通过：when/do/unless三项旧投影红例，尾部“不成立，不要执行”被截断。测试来源先经MemoryService两Demo形成active记录，再使用合法schema夹具设置长规则字段；不冒称专业真实案例。

A2通过：规则存在与独立advice两场景，record.transferRule、activeThreads.transferRule和advice对应字段逐字等于来源；optional unless保持。生产仅六处字段映射替换，原limitations完整保留。

A3通过：三个近800字合法字段超过总预算时，memories/activeThreads及条件文本全部清空；独立advice不能保留残缺前缀，估算≤800。原不确定召回/Wire/route回归通过。

A4通过：4文件67tests、TypeScript、production build，仅SQLite experimental warning。

```sh
pnpm exec vitest run libs/memory/src/memory.test.ts apps/web/lib/memory/uncertain-recall.integration.test.ts libs/coach-agent/src/memory-brief.test.ts apps/web/app/api/coaching/agent/route.test.ts
pnpm typecheck
pnpm build
```

A5：主控集中复核小变更，无新子任务或外部服务，测试/build退出，未改promotion/数据库/schema/token预算。

限制：长规则可能更常触发EMPTY；没有为旧advice补造limitations，也没改summary/claim等摘要字段。无用户DB/模型/桌面验收；下一项为已有correction.content220字截短的小例验证，UI A5独立保留。
