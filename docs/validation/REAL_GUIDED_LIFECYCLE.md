# 真实Demo完整带看模块消费（2026-09-26）

任务real-guided-lifecycle，基线61ae6fe，7f2b工作树。root单独执行，复用已构建WASM Parser；外部subprocess设120秒期限，进程已退出。授权小Demo只读一次，未触用户数据库、启动服务或浏览器。

## 方法

新增 `tools/validate-guided-lifecycle.ts`。先运行 `pnpm exec tsx tools/validate-guided-lifecycle.ts --smoke`，再对已有授权Demo和此前使用的所选玩家运行同一工具。真实Replay始终留在该进程，Parser→实际Adapter→assertValidReviewPlan→确定性Narration与冻结路线→真实Session/Controller/内存Graph→实际Host总结入口。正常Host身份只从同一读取计算一次，不做独立完整性比较。

ALL_SKIP通过实际skipReflectionToBaseline同步记一次SKIPPED并立即推进Session，Controller后续消费呈现凭据。MIXED交替跳过与OTHER反思，后者实际经过Controller同步、Graph诊断、Session确认。最后两次调用总结入口，要求只有一次结果保存。普通段/冻结段仍由Session推进并经Controller串行观察；运行次数有上限，结果门必须完整。

## 结果

完整匿名计数见 [REAL_GUIDED_LIFECYCLE_RESULT.json](REAL_GUIDED_LIFECYCLE_RESULT.json)。

| 项目 | ALL_SKIP | MIXED |
| --- | --- | --- |
| 回合 / 路线段 / 候选 / cue | 9 / 33 / 44 / 4 | 9 / 33 / 44 / 4 |
| 跳过 / 实际诊断 | 4 / 0 | 2 / 2 |
| Graph完成cue | 4 | 4 |
| Graph事件 | 34 | 36 |
| 总结保存次数 | 1 | 1 |
| Session终态 | COMPLETED | COMPLETED |
| 重复主题 | 0 | 0 |
| 工具发出 | 0 | 0 |

真实文件60,601,900字节，单次解析7,458ms，全工具过程7,961ms；两条模块消费路径各180ms/172ms，不代表用户观看耗时。网络调用0。Parser来源为当前primary-weapon.v1链。总结status=DISABLED、reason=NO_REPEATED_THEME，表示没有足够已验证证据生成重复主题，不是流程失败；不得通过放宽建议或引用门制造主题。

## 检查与限制

- 合成smoke通过（1回合/1cue；其中MIXED没有第二cue，真正混合分支由真实4cue运行覆盖）。
- `pnpm exec vitest run apps/web/lib/coaching/skip-lifecycle-continuity.test.ts apps/web/lib/coaching/session-wrap-up-completion.test.ts apps/web/lib/coaching/coach-agent-stage3-wrap-up.test.ts`：29项通过。
- `pnpm typecheck`：通过；`pnpm build`：通过。

本轮没有生产行为修改。CS-Net胜率推理未运行，使用其不可用时实际事实支持的确定性路线；没有调用语言模型。Session收到的tick通知由工具驱动，绝不是Viewer播放或真实React点击验收。`storedCases`只统计跳过case的保存seam，摘要保存也为计数seam；没有宣称SQLite恢复通过。原UI A5独立待验。下一步在隔离SQLite中验证真实规模产物落盘与重开，禁止写用户库或把新运行当作本轮已完成证据。
