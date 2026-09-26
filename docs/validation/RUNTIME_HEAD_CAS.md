# 恢复点提交并发保护

日期：2026-09-26。基线1da3de5，工作树7f2b，codex/jev-decision-assessment。

## 交付

- HTTP显式expectedRecoveryArtifactId；首次null，缺失/非法值400。目标合法后由DAL在同一事务内CAS；已被其他提交推进则409 RUNTIME_HEAD_CONFLICT。
- 同目标完整字段相同才幂等成功，不重写head/Review时间；同目标修改tick、progress、status或completedAt拒绝。原身份/产物/单调进度门保持。ACK取事务内结果，不在await后读别人推进的head。
- Controller串行，队列保存输入副本；只有当前owner合法ACK推进预期ID。超时/冲突不自动重试或重读token，旧owner已排队请求不发送、晚ACK不污染新owner。
- Host新建Review从null起步；RESTORE和REANALYZE/SELECT_PLAYER读取已有head。旧存储无artifact三元组可在身份匹配后以null开始显式重新分析；新ACK仍必须有ID。不迁移已存数据。

## 验收证据

A1/A2通过：partial_revision_restore在临时SQLite复现同cue等计数C0覆盖C1、跨Revision旧owner回退及重复确认改写时间，原3红转绿。库26项最终包含并发两个后继只有一个成功、同目标不同字段冲突、legacy head→新Revision。使用真实SqliteCheckpointSaver，紧凑构造身份/产物，不是用户比赛或专业判断验证。

A3通过：实际Controller排队/ACK/失效/重分析测试，实际API非法ACK/HTTP409与deadline保持；两个Hostadopt点源码复核。路由protocol测试单独mock领域validator，验证传参/必传和409映射；原route.test保留真实领域validator拒绝坏产物，不冒称全HTTP→DB集成。

A4通过：集成相关8文件114tests；独审legacy修复后受影响3文件49tests，TypeScript和production Web build通过。仅现有Node SQLite experimental warning。

```sh
pnpm exec vitest run libs/review-library/src/library.test.ts apps/web/lib/review-history/history-persistence-controller.test.ts apps/web/lib/review-history/checkpoint-save-api.test.ts apps/web/lib/review-history/teaching-save-deadline.test.ts apps/web/lib/recovery/agent-checkpoint-mirror.test.ts apps/web/lib/recovery/cs2d-session-recovery.test.ts 'apps/web/app/api/review-history/[id]/runtime-head/route.test.ts' 'apps/web/app/api/review-history/[id]/runtime-head/protocol.test.ts'
pnpm exec vitest run apps/web/lib/review-history/history-persistence-controller.test.ts libs/review-library/src/library.test.ts apps/web/lib/review-history/history-restore-controller.test.ts
pnpm typecheck
pnpm build
```

A5通过：revision_semantics_review默认配置独立只读审查发现legacy兼容must-fix；Controller红例与SQLite旧row回归补齐后独审确认关闭。主控查看真实diff/结果；架构、学习和任务板更新。两代理RELEASE，临时DB与测试/build资源已结束清理。

## 限制与下一项

尚未实现显式或自动重试；timeout不证明服务器未写。CAS保证捕获前驱的迟到网络请求不覆盖新head，不能辨识主动以最新token重新提交的语义旧状态，业务owner门仍必需。旧无expected字段的写客户端需加载匹配版本；历史读取不受新协议限制。

未运行完整Host/真实桌面UI/用户SQLite或部署安装；所有DB验证在临时目录。下一项核实保留同一提交及原expected的显式重试资格，不能重新诊断或自动择latest Graph。原锁屏UI A5保持独立待验。
