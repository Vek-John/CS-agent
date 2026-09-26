# 教学保存等待上限与重试资格

日期：2026-09-26。基线：e27360e；工作树7f2b，分支codex/jev-decision-assessment。

## 结论与范围

USER_INTERACTION、CUE_CASE、DIAGNOSTIC_RESULT、TRANSFER_RULE、LEARNING_THREAD 的单次 HTTP 保存现有20秒 fetch＋JSON共同期限；超时进入已有失败处理，保留教学显示，不发布新的已确认恢复点。没有自动重试或数据库迁移。

重试前提已通过API→validator→DAL源码核实：`apps/web/app/api/review-history/[id]/runtime-head/route.ts` 验证目标Revision及产物，`libs/review-library/src/library.ts` 的事务仅部分保护同Revision游标/完成数，不能阻止同cue旧checkpoint或旧Revision的迟到提交。没有expected-head条件时不能把“原子提交”当作安全重试；后继需先补真实SQLite小复现，再设计所有相关写入共同采用的事务内CAS。

## 验收

- A1 通过：原API五类 fetch 等待20秒仍pending，保存链busy也未结束，共6红；修复后全部转绿。
- A2 通过：五类均覆盖fetch及body悬挂，非合作transport仍本地结束并abort；晚headers不读body，晚body不续写，无自动retry，timer清理。
- A3 通过：实际API＋HistoryPersistenceController＋persistTeachingBeforeRuntimeHead，第二个教学产物保存超时返回ARTIFACTS_INCOMPLETE，后续artifact和head均不执行。成功时原类型顺序、payload、revision、idempotencyKey与head保持；HTTP错误code保留，AnalysisBundle不套短期限。
- A4 通过：相关6文件77tests，TypeScript，production Web build（仅现有Node SQLite experimental warning）。
- A5 通过：默认partial_revision_restore只读最终审查无must-fix，主控diff复核；架构、学习、任务板同步。测试/build已退出。

命令：

```sh
pnpm exec vitest run apps/web/lib/review-history/teaching-save-deadline.test.ts apps/web/lib/review-history/checkpoint-save-api.test.ts apps/web/lib/review-history/api.test.ts apps/web/lib/review-history/history-persistence-controller.test.ts apps/web/lib/playback/cs2d-playback-host.test.ts apps/web/lib/recovery/agent-checkpoint-mirror.test.ts
pnpm typecheck
pnpm build
```

## 剩余限制

20秒是每请求而非整链总期限。服务端可能已落盘或在超时后继续完成，不做取消/回滚承诺；USER_INTERACTION失败后原流程仍可继续诊断，但interactionDurable=false阻止head。恢复安全重试尚未实现。

测试transport为fake，产物payload用于API传输验证而非完整领域校验；保存helper回调遵循Host的原异常契约，没有挂载整个Host或操作真实SQLite/浏览器。没有用户Demo/DB/Memory/密钥、模型、安装部署操作；原桌面UI验收仍独立待验证。
