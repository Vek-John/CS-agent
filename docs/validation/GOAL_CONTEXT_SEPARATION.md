# 纯目标与独立条件陈述分离

2026-09-26，基线b0ea734，任务goal-context-separation。

A1通过：5种纯否定/疑问表达、否定补枪后独立队友位置、旧目标一次修订共7红例实际复现。旧逻辑将它们误路由INFORMATION/TRADE/TIMING/SYNC。当前仅完整有限目标分句不参与条件类型检测；GOAL保留独立权威。

A2通过：补枪窗口只有半秒、队友无法补枪、我的瞄准有问题，以及独立敌情/队友位置仍保留其claim；不是全局删关键词。原raw及USER来源保持，指定TRADE focus与EXECUTE_PLAN目标保持；旧独立敌情在修订后仍可用于INFORMATION。

A3通过：真实Graph反思→异议完成一次修订并选择RISK，不复活被否定的目标伪信念。旧TACTICAL_CONTEXT纯目标和“执行战术，时间还充足”混合反思均覆盖；后者由独审指出，修复后仅保留GOAL与TIME_BELIEF，不借旧问题类型制造战术背景。空分句不作为背景。

A4通过：7文件132tests、TypeScript、production build，仅SQLite experimental warning。

```sh
pnpm exec vitest run libs/coach-agent/src/teaching-diagnosis.test.ts libs/coach-agent/src/teaching-diagnosis-graph.test.ts apps/web/lib/memory/agent-events.test.ts apps/web/lib/memory/history-idempotency.integration.test.ts apps/web/components/playback/teaching-diagnosis-panel.test.ts apps/web/lib/coaching/coach-agent-stage3-wrap-up.test.ts libs/coach-agent/src/browser-client-bundle.test.ts
pnpm typecheck
pnpm build
```

A5：主控实现/真实diff复核；revision_semantics_review默认配置只读方案与终审，指出旧自动类型问题后RELEASE，主控修复并复验。没有服务/模型/用户DB/Demo或UI操作，测试/build已退出。

限制：合成语义回归不是专业gold或真实Demo评价质量证明。有限完整目标分句规则，不解决任意否定、指代或事实与主张实体匹配；旧保存结果不重算。下一项具体执行器线索是explicitInformationContradiction忽略用户主张，仅凭负向fact文本就判矛盾，需先小例证实。原锁屏A5独立保留。
