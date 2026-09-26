# 修订诊断与整场总结资格

2026-09-26，基线0dae213，7f2b / codex/jev-decision-assessment。

## 行为与证据

A1通过：生产diagnoseCue→reviseDiagnosis使用合成决策事实和USER补充，原BELIEF_INCORRECT变INCONCLUSIVE，新rule明确语音无法验证。原adapter忽略诊断，仍输出两例重复主题，实际红例转绿。

A2通过：当前页面与完成Graph诊断并列，任一合法匹配case有revision/disagreement就从原主题支持中排除；确认COMPLETED及JSON恢复仍识别，两来源先后顺序不影响。USER原文未进入总结投影。三例去一后，若原代表仍合格，剩余两例继续，cueRefs/occurrence/roundRefs/evidenceRefs/adviceRefs重算；无合法原代表则整主题省略。

A3通过：无诊断/未修订、无关cue或错candidate不误删正常主题。原已验证习惯与引用门保持，没有把新rule塞旧advice。actual completeAndSaveSessionWrapUp发布/保存同一结果，JSON保留修订说明，SSR从保存bundle展示空主题说明。达到八条来源限制后无法加说明时明确报SOURCE_LIMITATIONS_EXCEED_OUTPUT_LIMIT，旧限制未截断；core空主题最多八条限制完整保留，无限定时仍NO_REPEATED_THEME。

A4通过：7文件122tests、TypeScript和production Web build；包含browser-client-bundle回归，仅原SQLite experimental warning。

```sh
pnpm exec vitest run apps/web/lib/coaching/coach-agent-stage3-wrap-up.test.ts apps/web/lib/coaching/session-wrap-up-presentation.test.ts apps/web/lib/coaching/session-wrap-up-completion.test.ts apps/web/lib/coaching/deepseek-wrap-up.test.ts libs/coach-agent/src/session-wrap-up.test.ts libs/coach-agent/src/teaching-diagnosis.test.ts libs/coach-agent/src/browser-client-bundle.test.ts
pnpm typecheck
pnpm build
```

A5通过：主控全部实现/真实diff复核；revision_semantics_review默认配置只读诊断语义例，partial_revision_restore默认配置独立最终审查无must-fix，两者RELEASE。架构/学习/任务板同步，所有本轮进程退出。

| Before | After | Why |
| --- | --- | --- |
| 用户补充后的点仍支持旧重复总结 | 已修订支持不计入原确定重复主题 | 保持当前诊断与总结的资格一致 |
| 空主题隐藏所有限制 | 保存并显示修订排除说明 | 说明为何暂不归纳习惯 |

## 限制

合成规则例不是专家gold或真实Demo判断质量验证。没有直接输出新诊断训练建议（当前只有原advice引用契约），无原合法代表时即使剩余支持也可能省略主题。只处理已修订标记，不泛化为所有初次INCONCLUSIVE诊断。没有改Graph内部sessionThemes、Memory计数/协议，不重算旧保存总结。

保存spy/JSON/SSR及生产模块验证不冒称完整Host/真实SQLite或浏览器。无模型/用户数据/DB/密钥/服务/部署安装；原UI A5继续独立待验。下一项用同修订例核实已有USER_CORRECTED_COACH消费者效果，不预设纠正链缺失。
