# 条件测量与USER原话验证分离

2026-09-26，基线f39355b，任务condition-claim-separation。

A1通过：5个有效旧生产红例显示资源预算整体支持/部分支持被写给任意RESOURCE_BELIEF，零队友条件被当作对先前期待的反证。另一初版fixture未命中资源类型，修正fixture后验证；没有借此扩大词表。

A2通过：诊断仍输出真实护甲等measurement、原SUPPORTED/PARTIAL条件状态与refs；零队友measurement0及condition CONTRADICTED保持。相关自由文本USER陈述UNVERIFIABLE，无新增支持/反证refs，原文保持。GOAL仅为自述，非动作正确性证据。

A3通过：原覆盖缺口测试继续验证条件PARTIAL与decision-trade-gap引用，USER期待单独未知；Memory、Graph一次修订、精确恢复与历史artifact相关回归通过。初次及修订均从原反思生成空refs的claims，未复用旧verified claims。

A4通过：7文件218tests、TypeScript、production build，仅SQLite experimental warning。

```sh
pnpm exec vitest run libs/coach-agent/src/teaching-diagnosis.test.ts libs/coach-agent/src/teaching-diagnosis-graph.test.ts libs/memory/src/memory.test.ts apps/web/lib/memory/agent-events.test.ts apps/web/lib/memory/history-idempotency.integration.test.ts apps/web/lib/recovery/cs2d-session-recovery.test.ts apps/web/lib/review-history/artifact-validation.test.ts
pnpm typecheck
pnpm build
```

A5：主控实现和真实diff复核；revision_semantics_review默认只读终审无must-fix，RELEASE。无模型/用户DB/服务/安装部署，测试build退出。

限制：不验证任意自然语言数值主张，也不重算已保存claim；不能声称历史错误标记已修复。下轮核实不确定记录聚合后Brief是否保留限定，不凭active生命周期直接改策略。UI锁屏A5独立待验。
