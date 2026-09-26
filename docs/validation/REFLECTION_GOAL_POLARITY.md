# 自由目标描述的否定与歧义

2026-09-26，基线52ca299，任务reflection-goal-polarity。

A1通过：真实diagnose与revise初始13红例，包含“不是拿信息，是保枪”“不是补枪，而是拿信息”、纯否定旧目标、多目标、冲突及时间充足/无压力被错误转述。有限分句实现后通过。

A2通过：显式selectedGoal优先；同一目标重复不算多目标；有目标词但否定/歧义返回UNKNOWN，因此revision不回退复活旧目标；只补充无目标上下文时沿用旧值。肯定补枪/拿信息、否定换保枪、英文逗号分句、明显他人/条件句均有回归。

A3通过：原始USER文本与acceptedDisagreement/previousReflection保留，时间原文中性转述。未改一次异议预算、Demo事实、schema、Memory消费者或旧保存记录；相关Memory/Graph/总结/SSR回归通过。

A4：独审发现“该保枪吗？”的疑问目标仍被肯定，补问号/有限疑问句式以及初次/修订回归，由主控关闭；reviewer只读RELEASE。最终6文件119tests、TypeScript和production build通过，仅SQLite experimental warning。

```sh
pnpm exec vitest run libs/coach-agent/src/teaching-diagnosis.test.ts libs/coach-agent/src/teaching-diagnosis-graph.test.ts apps/web/lib/memory/agent-events.test.ts apps/web/lib/memory/history-idempotency.integration.test.ts apps/web/components/playback/teaching-diagnosis-panel.test.ts apps/web/lib/coaching/coach-agent-stage3-wrap-up.test.ts
pnpm typecheck
pnpm build
```

范围：有限词法分类，不是完整NLP；有些真实肯定句也会保守UNKNOWN。其他claim及hinge独立按词选择条件，本轮不保证最终判决正确理解“不是补枪/拿信息”；需要下一步以这些反例单独处理。合成规则例不是专家gold，不重跑Jev或降低证据门。没有UI/用户DB/模型/服务或安装部署，测试进程已退出。
