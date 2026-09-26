# 已显示道具种类的明确追问（2026-09-26）

## 实际路径

Host的诊断面板与baseline三段讲解互斥。现有种类chip由baseline的`buildThreeStageCoachingView`生成，不能因为内存中还有这份投影，就允许诊断分支回答未显示的种类。

此次仅在合法baseline讲解及原结果完成门内，回答明确“当时有什么道具”。同一helper供局面卡和cache使用；Host只把实际chip文本作为显示对照，来源仍须来自当前合法Snapshot及事实。文本一致、来源合法才复述；种类已知不能替代颗数未知。已知空库存与未知库存分别处理。

## 验收

实际Adapter v1库存（Flash/Smoke）→确定性Narration→三段View的道具chip→真实Session结果完成→问答，原实现原生/JSON恢复两例均返回空items；接线后两例及原View 23项通过。CoachingStatusList与CurrentCueQuestionsPanel均以SSR核对显示内容，分析产物保持不变。

共享helper保留原View种类映射和采样/事实规则，cache额外要求当前fresh Snapshot；actual displayedUtilityText只作为显示对照。只在baseline赋值utilityKinds，诊断分支即使仍计算了三段View也不能借用。最终匹配种类参与source key，旧回调沿原门拒绝；没有另建库存推断或按键扫描逻辑。

最终新增22项，覆盖已知空与未知、诊断隐藏chip、8类来源失效、显示/key变化、结果/manual门、假设问句、cache复用及token失效。5文件180项相关测试通过：current-cue-utility-questions、cs2d-coaching-view、current-cue-resource-questions、current-cue-clock-questions、current-cue-questions；`pnpm typecheck`与`pnpm build`通过。原实现两正例红，负例还发现两个undefined相等导致matcher解引用的问题，已增加source存在门后全绿。

partial_revision_restore使用默认模型/推理，独占5个源码/测试文件；root负责Host一行显示值接线、架构/文档、实际日志及diff复核。没有新增布局/控件，原View只提取共用函数。日志位于`.local-data/utility-question-evidence/`，全部测试/build进程已退出。

没有真实Demo、浏览器、模型或用户数据库请求，本轮SSR不作为完整Host交互验收，JSON测试不声称SQLite历史恢复。问答仍是明确问法匹配，不提供通用语义或如何使用道具的判断。来源缺失或当前分支未显示时不会补齐。
