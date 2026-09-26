# 信息反证与用户主张的对应边界

2026-09-26，基线313a8d1，任务information-contradiction-boundary。

A1通过：6项真实diagnose红例证实负向fact文本直接定罪，包括一致否定、没有具体主张、听觉、不同地点、其他报点以及表面文字冲突。输入缺少可核对主体/时点/命题关系，不足以作反证。

A2通过：删除explicitInformationContradiction及唯一文本定罪分支；信息诊断保留fact refs但UNVERIFIABLE，verdict INCONCLUSIVE，USER claims无contradictingRefs。executor/verdict/transfer统一中性说明，要求核对来源/对象/位置/时点，不将视觉或泛化信息改写为声音。

A3通过：更新两处依赖旧错误定罪的fixture，原判断现在INCONCLUSIVE但仍INFORMATION，异议后SYNC/规则变化、旧Memory目标纠正和总结资格过滤保持。旧schema枚举/历史读取代码未删；恢复和产物验证回归通过。资源/零队友等独立结构化诊断保持。

A4通过：9文件179tests、TypeScript、production build，仅SQLite experimental warning。

```sh
pnpm exec vitest run libs/coach-agent/src/teaching-diagnosis.test.ts libs/coach-agent/src/teaching-diagnosis-graph.test.ts apps/web/lib/memory/agent-events.test.ts apps/web/lib/memory/history-idempotency.integration.test.ts apps/web/components/playback/teaching-diagnosis-panel.test.ts apps/web/lib/coaching/coach-agent-stage3-wrap-up.test.ts apps/web/lib/recovery/cs2d-session-recovery.test.ts apps/web/lib/review-history/artifact-validation.test.ts libs/coach-agent/src/browser-client-bundle.test.ts
pnpm typecheck
pnpm build
```

A5：主控实现/关键diff复核，revision_semantics_review默认配置只读契约及终审，无must-fix，RELEASE。测试/build退出，无服务、用户DB、模型或安装部署。

限制：没有可用主张对应反证前，新信息诊断保守未知，不能据此说用户判断正确；历史不重算，也不是专业gold质量证明。下一项具体风险是资源预算SUPPORTED被直接复制给任意用户资源陈述，先用小例核实，不扩通用语义/NLP。锁屏UI A5独立保留。
