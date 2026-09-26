# 修订诊断的Recovery模块链验证

2026-09-26，基线22b4f5a。新增一条跨模块回归，无产品代码修改。

## 实际路径

既有紧凑Replay fixture生成Analysis/Plan/Narration，真实Session走到CUE_PAUSED；Host Controller.synchronizeDiagnosis使用当前证据建立Graph位置。真实buildTeachingDiagnosisSubmissionEvent→Runtime分别提交近500字反思和近500字异议，得到DISAGREED。

buildCheckpointedRecoveryRecord使用实际返回的checkpoint ID，经SessionRecoveryRecordSchema与JSON往返，restoreRecoveryArtifacts只恢复路线/位置；诊断不在这份记录中。新Runtime/Controller复用同一个测试MemorySaver，buildReconnectReplayEvent读取匹配checkpoint，然后调用Host实际使用的restoreCheckpointTeachingCase与adoptRecoveredCue，最后进入buildCurrentCueQuestionContext及原有建议问答。

## 观察结果

- 两段USER原文、完整修订CueCase、一次异议预算保持，暂停结果门/default cursor/consumed不变。
- 当前追问成功复述恢复的修订建议，读取不改变Session。
- 恢复控制器仅分发两次RECONNECT_REPLAY（含重复重连）；diagnoseTeachingCue/reviseTeachingDiagnosis spies、Policy及工具post均0。
- 实际buildLocalAgentMemoryEvents对重连返回空事件；不是声明数据库没有合法checkpoint更新。
- 重复重连复用同一已恢复checkpoint，未新增诊断或修订。

正常产品路径未发现缺口。首次fixture有包依赖定位/遗漏必填evidence/把对象游标按引用比较的问题，分别改为由LangGraph所属包提供测试MemorySaver、satisfies实际输入类型、结构比较；这些不是产品故障。无依赖安装和替代浏览器harness。

```sh
pnpm exec vitest run apps/web/lib/recovery/cs2d-session-recovery.test.ts apps/web/lib/coaching/current-cue-questions.test.ts libs/coach-agent/src/reconnect-replay.test.ts
pnpm typecheck
pnpm build
```

相关3文件91tests、TypeScript通过；Web production build通过。测试文件/共享测试fixture以外没有生产改动。控制器在finally dispose，spies恢复，内存数据随进程退出。

## 准确边界

这是实际生产模块串联的内存验证；MemorySaver不跨进程持久化，本轮没有证明真实SQLite、IndexedDB、浏览器刷新或桌面重启。没有装载完整Host/iframe，Host在重连成功后把restoredSession.cue_cases同步到teachingCases的接线另经只读核对。fixture时间不称为真实Demo tick。未验证partial artifact/head提交失败，本轮结论仅涵盖匹配且完整的CUE_PAUSED保存点；独立小诊断将核实失败路径是否符合已有降级契约。
