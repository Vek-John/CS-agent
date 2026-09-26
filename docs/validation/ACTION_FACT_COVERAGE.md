# 动作事实覆盖与教学路线资格

2026-09-27；实现基线 `961ad1b`，`codex/jev-decision-assessment`，实际工作树7f2b。结论：暂不扩展 KILL 开火展示事实；小验证没有证明该扩展会改善当前带看体验。没有修改产品代码、引用门、判断门或版本。

## 现有来源

| 候选/事件 | 动作材料 | 限制 |
| --- | --- | --- |
| RETURN_AND_FIRE | 本人位移与开火的结构化动作 | 几何返回并开火不证明 LOS、再次接敌或战术意图 |
| UTILITY | 归属本人的 GrenadePath | 使用保守采样窗口，不声称精确投掷起点或战术目的 |
| BOMB planted/defused | 明确归属本人的事件 | 确认发生/完成，不推定动作起始；爆炸不是玩家动作 |
| DEATH / HP_CHANGE | 可选 presentationOnly 本人开火 | 独立 shot、明确本人、决策后且揭示前、已知死亡前；最多三条来源，不推定命中/目标 |
| KILL | 击杀结果，无自动动作事实 | 不从击杀反推开火，更不能据结果判断过程正确 |
| 单独 shot | Timeline WEAPON_FIRE | 不单独提名 cue；没有动作引用不等于本人未行动 |

代码依据：`libs/cs2d-analysis-adapter/src/index.ts` 的 `collectCandidates`、`buildCanonicalGeneratorInput`、`buildSelectedMatchEvents`；`window-self-fire.ts` 的严格时间/归属过滤。`candidate-generator.ts` 将展示动作传入材料，`teaching-pipeline.ts` 的 `hasRankingAction` 排除其排序加分，`decision-assessment.ts` 排除其结构化判断资格。

## 小验证与决定

复用 `window-self-fire-fixtures.ts` 的小合成回合；决策1400、shot1404、揭示1408仅为合成坐标，不是实测 Demo tick。保持事件索引，分别将 shooter 设为本人/null；KILL 对照仅将原 DEATH 事件改为本人击杀他人，并保持本人存活/40生命，避免混入掉血候选。调用实际 Adapter 和 `buildDirectorRequest`，未调用模型、网络、WASM或GUI。

| 类型 | 明确本人 shot | action 数 | assessment | Director 候选 / cue |
| --- | --- | --- | --- | --- |
| DEATH | 有 / 无 | 1 / 0 | 均 INSUFFICIENT_EVIDENCE | 均 1 / 1 |
| HP_CHANGE | 有 / 无 | 1 / 0 | 均 INSUFFICIENT_EVIDENCE | 均 1 / 1 |
| KILL | 有 / 无 | 均 0 | 均 NO_TEACHING_VALUE | 均 0 / 0 |

曾局部试验将 KILL 纳入同一开火过滤：动作材料确实从0变1，选点、决策事实、结果、评分和 assessment 消融不变，但 Adapter→Narrator/默认工具验收因**不存在 cue**失败。这证明字段覆盖不足不能直接等同用户路径缺陷。已完整撤回该试验的产品和测试改动，保留现有来源契约。

当前 `teaching-gates.ts:assessCandidateTeaching` 先要求有效独立过程依据；普通不确定性反思只在有决策事实及特定上下文的 DEATH/HP_CHANGE/BOMB，或满足阈值的 WIN_RATE_DROP 等条件成立。KILL 不因一个 presentationOnly shot 获得教学价值；不得为使工具执行而放低此门。这不表示所有带独立过程证据的 KILL 永远不能教学，也不证明任何真实候选的射击分布。

现有测试已覆盖无模型 KILL 不生成 Provider 任务/路线，故不新增重复矩阵。临时探针位于 `.local-data/action-fact-coverage/probe.ts`，结果 `result.json`；两次包别名解析失败后简化为源码相对导入成功，未安装依赖或堆叠运行器。

## 验证与下一步

相关现有5文件62 tests通过（window-self-fire、window-self-fire-boundaries、candidate-generator、teaching-gates、basic-route-default-tool.integration）。两端 TypeScript / production build结果见任务板。无真实Demo重读、Jev重复调用或新UI验收；本轮只交付覆盖学习，不声称专业判断改善。

下一有限目标 `decision-prior-self-fire`：源码已确认 Timeline 接收明确本人 WEAPON_FIRE，而 DecisionSnapshot 的近期自身事件目前只有 selfHurtEvents。先用一个小合成场景核实决策前本人开火是否已通过别的入口进入当前情况讲解；若未消费且有实际说明收益，再设计短时、有界、跨死亡拒绝的纯发生事实。不得将它变为敌情、接触、命中、错误判断或新的教学资格，也不扩大处理窗口来捕捉更多动作。
