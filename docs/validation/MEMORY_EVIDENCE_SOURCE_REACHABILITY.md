# Memory evidence 来源路径核实

2026-09-26；基线 402c584，7f2b/codex/jev-decision-assessment。结论：当前严格入口阻断该路径，本轮不修改产品代码或幂等身份。

## 问题与修正后的范围

`apps/web/lib/memory/agent-events.ts` 的内部 `provenanceRefs` 确实把 `input.material.evidence` 的全部 ID 投成 PRO_EVIDENCE，临时 ProvenanceItem 类型也未保留 source。`libs/review-planner/src/teaching-pipeline.ts` 真实 compiler 会生成 RULE evidence，EvidenceSource 契约还有 DEMO/PRO_SCENE。

但真实 producer 存在该数据，不等于该数据会到达 Memory adapter。检查调用链后，主控将目标收敛为“核实来源是否可达并决定是否修复”。原A1所要求的当前生产误标复现不适用，不能把人工 cast 拼接字段当作真实 Host 链通过。

## 实际入口

1. 全仓搜索 `buildLocalAgentMemoryEvents`，唯一生产 caller 是 `apps/web/app/api/coaching/agent/route.ts`，传入已解析 dispatchEnvelope.event 和校验后的 result；其他引用均是测试。
2. Host 的 `buildTeachingDiagnosisInput` 将 CandidateMaterial 投影为 candidateId、decision/action/outcome facts、advice、limitations 及可选 economy/contextCode，不包含 evidence。`buildTeachingDiagnosisSubmissionEvent` 再以 CoachAgentEventSchema 校验。
3. `TeachingDiagnosisInputSchema.material` 是 strict object，不接收 evidence。事件 input 的 split/combined 两个合法分支都使用该 schema；补一个带任意source的evidence字段也会失败，而不是忽略source后继续。
4. route 在访问 runtime/Memory 之前运行 `parseRemoteCoachAgentDispatchEnvelope`，其 event 使用上述严格schema，失败返回 INVALID_ENVELOPE。
5. runtime.dispatch 和 dispatchOne 都先 parse；Graph 的重复提交/已有result复用及backend恢复在其后。不能通过重复eventId或已有诊断绕过该输入门。
6. RECONNECT_REPLAY/PLAYBACK_CONFIRMED 等历史回放事件不是 adapter 的诊断事件，返回空事件列表；当前 adapter 不从恢复的result反向提取 material.evidence。

因此未发现当前受支持入口可把带evidence的raw input及可接受result同时送达该循环。本轮没有证据说明真实用户Memory已被此路径污染；也没有检查或清洗任何历史数据库，不能据此保证历史从未存在错误来源。

## 最小执行验证

临时 Vitest 测试使用合成timeline/plan和带RULE evidence的Host material：

- 实际 `buildTeachingDiagnosisSubmissionEvent` 输出不含 material.evidence；实际 diagnoseTeachingCue 成功，结果经 buildLocalAgentMemoryEvents 发出合法Memory事件且不含 PRO_EVIDENCE。
- 分别向已有合法事件注入 RULE、DEMO、PRO_SCENE、缺失source、UNKNOWN 五种evidence：CoachAgentEventSchema、parseRemoteCoachAgentDispatchEnvelope、runtime.dispatch 均拒绝；runtime在排队或读backend之前同步拒绝。
- 没有把注入后的非法事件送入adapter制造“产品红例”，没有 ingest Memory、网络、Demo解析或数据库访问。

执行命令：`pnpm exec vitest run apps/web/lib/memory/memory-source-reachability-audit.test.ts`，1文件1测试通过（含上述五种source×三层入口断言）。临时测试执行后移除，源码/输出保留在忽略目录 `.local-data/memory-source-audit/executed-test.ts` 和 `vitest.log`。最初根目录tsx两次包解析失败后，改用项目已有Vitest及web依赖解析；未增加依赖或继续堆环境变通。

本轮仅提交文档，没有重新运行全量tests、TypeScript或production build；不借用基线检查声称本轮产品变更通过。未修改producer version、namespace/schema、policy/reducer、marker或计数。未安排“实现后”独立审查，因为没有实现；主控已只读复核入口并接受停止改造的结论。

## 后续触发条件

若未来明确把 Evidence 引入诊断/Memory入口，必须在真实适配边界保留 source，只有 PRO_SCENE 可标 PRO_EVIDENCE；RULE/普通DEMO不能伪装专业证据，也不能仅因label或ID被换成事实/观察分类。届时再验证candidate正常路径与无candidate旧兼容路径的marker、idempotency和实际Memory消费端，避免分类修正双计机会。

下一项值得核实的是实际职业案例材料、检索接口和适用性约束如何进入 CandidateMaterial/Evidence。当前枚举和规则样例不证明职业检索已经接入。不要重复派发这个已被严格schema阻断的内部cast路径，也不把本次来源审查称为教练判断质量提升。
