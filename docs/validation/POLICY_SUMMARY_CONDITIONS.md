# 工具选择摘要中的讲解条件（2026-09-26）

任务policy-summary-conditions，基线da0f511，工作树7f2b。主控拥有Host投影与文档；revision_semantics_review使用默认配置，独占新增真实链回归。目标是避免完整讲解进入工具选择摘要时只剩没有尾部条件的半句，不扩大模型输入预算。

## 已核实链路与适用范围

Host buildStage3NarrationSummary原先将各字段text截240字符、refs取8条、limitations取4条。Graph normalizeNarrationSummary和policyInputForState继续使用该摘要；可选directCoachPolicy把严格PolicyInput完整序列化给Provider。

必须区分当前默认行为：Graph零能力直接结束、单能力走RULE，当前判断focus仅支持ACTION_FACT_REPLAY，因此不能把此问题说成默认模型已经作出错误选择。确定性Policy不读取字段正文；旧focus存在多种合法能力时才有可选Provider消费路径。真实模型选择效果不在本轮验证范围。

Narrator正文允许1600字符，但当前生成仍须等于确定性approved投影，不能用任意长自由文案绕过语义门证明可达。验证须从合法package生成完整Narration并通过现有语义校验，再进入Host与Graph。

## 验证

新增policy-summary-conditions.test.ts：canonical fact合成合法长文本，经deterministicNarrationBundle、assertValidNarrationBundle、buildNarratorRequestContext与parseProviderBundle默认完整语义门通过。尾部条件在240字符后。真实Host→Graph状态以及显式旧focus多能力Graph→PolicyAdapter spy两红，短文一绿。后者是有意构造的受支持旧focus路径，不是声称新Compiler会产出该focus。

修复仅在Host字段投影：text超过240、去重refs超过8、限定超过4条或单条超过160时，整段正文与引用清空并给省略说明。短内容及边界内容完整保留。原limitationCount加省略字段数仍最多8；完整Narration未修改。附加四项Host接口兼容测试覆盖引用预算、第五条限定、单条长限定和240边界，不冒称这些限定形式由当前确定性生成器产生。

- `pnpm exec vitest run apps/web/lib/coaching/policy-summary-conditions.test.ts apps/web/lib/coaching/coach-agent-stage3-host-adapter.test.ts apps/web/lib/coaching/coach-agent-stage3-integration.test.ts libs/coach-agent/src/deterministic-policy.test.ts`：当时3项新测试加24项相关测试，共27通过。
- 补完预算测试后 `pnpm exec vitest run apps/web/lib/coaching/policy-summary-conditions.test.ts apps/web/lib/coaching/deepseek-coach-policy.test.ts`：7新+10相关，共17通过；本轮去重共41项通过。
- `pnpm typecheck` 与 `pnpm build`：通过。

仅使用合成fixture、内存Graph与PolicyAdapter spy，无真实网络、模型、Demo、用户数据库或浏览器；没有测模型输出改善，没有改写旧保存摘要或进行历史迁移。原工具资格/结果门保持，默认RULE与可选Provider影响如上区分。
