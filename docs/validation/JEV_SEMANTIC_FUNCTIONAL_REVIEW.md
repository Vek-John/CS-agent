# Jev v4 独立功能审查

- 日期：2026-09-24
- 比较基线：`da640a6`；审查对象为当前工作树中的 observation semantics、joint witness、assessment builder/parser/resolver 和 Jev adapter。
- 方法：只读代码审查及三组局部功能测试。未解析大 Demo，未调用远端模型，未运行整仓构建，未进行供应链或凭证路径审计。
- 结论：**未发现可复现的 P1/P2 功能问题；限定范围内功能验收通过。** 该结论不代表模型判断正确率或专业教练质量验收通过。

## 功能结论与证据

| 关注点 | 核实结果 |
| --- | --- |
| 合法信息丢失 | 主 builder 默认采用 v4，并调用 `buildDecisionObservationSemantics`。同样的观测元数据、不同的合法 SELF 位置现在能改变最终 HTTP state；旧版本投影仍保持原行为。来源、知识类型、共享范围、匿名对象关系、可用时间与过期信息进入投影。 |
| 空间来源与精度 | 空间投影只接收候选引用的合法 ObservationClaim，不读取 snapshot 的全知 players 或 roster。相对几何仅使用当前决策时刻、DIRECT_VISION、OBSERVED、SELF 的一致锚点；缺少锚点或存在冲突时不输出相对几何。声音需有观察者可听证据且保留 INFERRED/UNKNOWN_ACTOR。圆形不确定范围保留半径、全部相交网格和向外取整的距离上下界；不输出其精确中心，不确定形状不输出高度差；方向扇区保留原方向与宽度，不凭空生成有限区域。 |
| 旧 cue 恢复 | `resolveDecisionAssessment` 对缺少 binding.projectionVersion 的已保存 artifact 明确采用 LEGACY 重建；新 v4 artifact 保存投影版本。局部测试验证旧 artifact 的判断和内容在 JSON 往返后保持一致，新 v4 artifact 可消费。恢复消费过程是本地函数调用，不触发 provider。 |
| 新有效判断消费 | 六题协议分别收集三项判断和三项显式联合证据选择；adapter 保留两者的冲突，validator 检查 witness 适用性、标签匹配及具体 refs。有效非拒判实例实际通过 preparation → Director → Compiler → Narrator，产出并读取 DECISION_ERROR 推断；不相关 observation 不被附加到 witness 来凑引用。 |
| RETURN_AND_FIRE | v4 仍必须为 UNKNOWN / UNKNOWN / INSUFFICIENT，并使用 UNVERIFIED_CONTACT witness。返回位置和开枪不会被提升为已确认接敌、敌人暴露或视野。已消费 cue 仍说明证据不足。 |
| 会话预算 | Host 相对基线无修改。默认 6000 ms 从配置读取完成后开始，配置读取另有 750 ms 上限；并发上限仍为 2。v4 仍由单次 `/systemone` 请求携带六题，不按题发起六次网络请求。局部预算测试覆盖默认截止、取消在途请求、标注未启动候选、保留已完成结果、并发去重及候选绑定独立。未发现新协议绕开预算。 |

关键代码位置：`libs/review-planner/src/decision-assessment.ts:159`（默认 v4）、`libs/review-planner/src/decision-observation.ts:102`（合法 SELF 锚点）、`libs/review-planner/src/decision-witness.ts:59`（显式证据校验）、`libs/review-planner/src/decision-assessment.ts:285`（legacy 恢复）、`apps/web/lib/coaching/jev-decision-assessment.ts:79`（六题请求）、`apps/web/lib/coaching/decision-assessment-host.ts:75`（会话截止）。

## 本次实际执行

1. 空间投影与精度边界：**14 passed**。

   ```sh
   pnpm exec vitest run libs/review-planner/src/decision-observation.test.ts
   ```

2. 投影、旧 artifact 恢复、有效教学消费、RETURN_AND_FIRE、六题协议和最终 HTTP 输入：**20 passed，39 按过滤条件跳过**。

   ```sh
   pnpm exec vitest run libs/review-planner/src/decision-assessment.test.ts apps/web/lib/coaching/jev-decision-assessment.test.ts -t 'semantic observation projection|actual preparation|RETURN_AND_FIRE real-request|six-question joint|default v4'
   ```

3. Host 默认 6 秒预算、并发、取消和去重：**8 passed**。

   ```sh
   pnpm exec vitest run apps/web/lib/coaching/decision-assessment-host.test.ts
   ```

合计 **42 项通过**。模型返回使用测试替身；它们证明接口与接受/拒绝路径，不能证明真实模型效果。

## 剩余限制

- v4 是有意的粗粒度投影，不是所有合法空间信息的无损表达。同一网格内的小幅位置变化可能保持相同投影；G0–G63 不是战术区域、导航连通性、可达时间或视野证明。
- Joint witness 的联合前提及适用规则仍是待 CS2 教练验证的战术假设。模型选择了代码允许的 witness，并不等于该原则已具备专业正确性。
- 本次只核实合法输入到消费的工程功能。真实数据适用率、模型开发集/留出集结果及相对生成模型是否改善，由主控本轮评测另行报告；本审查未运行或引用尚未完成的模型调用。
- 6 秒是配置完成后的评估预算；局部测试验证截止和降级行为，不构成真实服务尾延迟承诺。
