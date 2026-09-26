# 异议后的原记忆纠正目标

2026-09-26，基线afab505，7f2b / codex/jev-decision-assessment。

A1：真实diagnose→revise合成例由BELIEF_INCORRECT变SYNC/INCONCLUSIVE，logicalKey改变。旧producer实际先被非法CREATE/USER_CORRECTED_COACH schema组合阻断；改为原子构造。临时移除旧目标绑定的受控探针产生两项红例：新目标不存在拒绝；新key有另一记录则选错对象。探针已恢复，不能宣称旧用户DB已发生误纠正。

A2：一次修订保存受现有schema限制的原thread及被接受异议。producer用前者生成原target/key，后者生成纠正ID/文案，消费者沿用现有授权与目标门。两个SQLite场景均只让原记录新增DISPUTED revision，旧版本可读，另一记录不变。

A3：重试返回同记录、仅一次correction，occurrence和成功/冲突应用次数保持，机会claim/evidence仍各1。真实Runtime第二次异议被拒以及同eventId更换文本都不能生成新纠正；相同已接受异议重投的新candidate/facts不会成为来源。JSON恢复、缺少/错误旧thread、缺少acceptedDisagreement或错identity均有覆盖。

A4：8文件161tests、TypeScript、production Web build通过，仅SQLite experimental warning。

```sh
pnpm exec vitest run apps/web/lib/memory/agent-events.test.ts apps/web/lib/memory/history-idempotency.integration.test.ts libs/coach-agent/src/teaching-diagnosis.test.ts libs/coach-agent/src/teaching-diagnosis-graph.test.ts libs/memory/src/memory.test.ts apps/web/lib/recovery/cs2d-session-recovery.test.ts apps/web/lib/coaching/coach-agent-stage3-wrap-up.test.ts libs/coach-agent/src/browser-client-bundle.test.ts
pnpm typecheck
pnpm build
```

A5：主控实现/关键diff复核，partial_revision_restore独占临时SQLite回归，revision_semantics_review独审指出拒绝事件输入混用并在修复后确认关闭；两owner RELEASE。临时库finally关闭并清理，测试/build退出，架构/学习/任务板同步。

## 限制

仅合成教学输入与真实模块/临时SQLite；fixture数字不是解析Demo canonical tick。无真实用户Memory修改、HTTP/UI或模型验证，不证明专业判断提升。旧case新代码可读，缺少新快照的旧修订不推断目标、不自动回填，也不保证旧客户端能读取新字段。DISPUTED表示用户纠正待复核，不把新观点当事实。默认feature/consent门、删除保护和消费者策略不变。已有DISPUTED专用Brief查询，下一项验证其教练接线；锁屏UI A5独立保留。
