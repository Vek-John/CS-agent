# 当前教学点的有据追问

2026-09-26；基线009aa04（产品2203ef7）。这是默认Host的有限本地只读能力补线，不是开放聊天、专业判断重构或生成式问答验收。

## A1 现状与方案

旧`answerCurrentCueQuestion`只在legacy review-experience使用；默认Host无入口。小fixture直接调用旧生产函数：PAUSED但无OutcomeGate仍回答；把未来OUTCOME引用放入observable refs就进入回答；空advice直接读取`.text`抛错。测试将这些作为旧行为特征记录，**不是新模块红例或真实Demo质量评测**。本轮不改legacy，也不把该函数接到默认Host。

先向主控提交范围/来源门/保存提案，确认只保留页面状态、不新增持久schema/Graph/模型。依据回答需区别于全facts列表，manual首版不开放；按这两项反馈收窄后实现。

## A2 支持与证据

| 问法 | 实际回答范围 |
| --- | --- |
| 这次判断依据是什么？ | 当前诊断evidenceRefs或基础assessment引用与合法已展示事实的交集；明确只是部分依据。无法解析时直说“目前只能列出已核实事实，尚不能完整解释这个判断” |
| 当时有哪些已知事实？ | 当前已展示内容对应的决策前DEMO事实，附自然语言来源；不复制之后结果 |
| 还有哪些未知条件？ | 当前可信诊断/讲解已显示的限制；没有列出更多限制不等于全部条件已知 |
| 职业、语音/战术、错误前提、不明确或其他问题 | 明确能力边界；不捏造职业样本、不把假设改成事实、不接受“一定错”等前提、不拼接无关建议 |
| 再看一遍等文字 | 引导使用既有按钮；不发播放命令 |

这是明确问法与有限同义表达的确定性路由，不是通用语义理解。不会重新解释数值measurement、复述未经独立资格验证的advice或产出新战术建议。

生产输入→buildCurrentCueQuestionContext→answerGroundedCueQuestion→updateCurrentCueQuestions→受控CurrentCueQuestionsPanel，真实默认Host负责传入来源及门控。只有默认路径、同Session/plan/cue/segment、PAUSED、已揭示、gate COMPLETED位置覆盖匹配outcome end、当前现代observer的demo/player/decision身份成立才开放。默认诊断还需完整既有schema结果与cue/candidate/reflection/hinge/result/verdict相互匹配；基础路径需要当前presentable narration归属匹配。

事实再次过滤DEMO/DECISION、observed、observable refs、唯一ID和合法非未来时间。诊断可读facts限制为原反思面板显示的前三项；基础路径只读currentSituation实际引用的facts，最多6项。事实/限制每项最多400字符，超长事实不引用，超长限制不给截断后的断言。答案保留本地refs但UI只显示可读来源，不展示ID/tick。全部为synthetic fixture，没有精确Demo tick证明。

## A3 页面状态及交互

Host state只存当前来源key、300字草稿与最近4条问答。key按数据内容和实际verdict revision生成，不依赖对象引用；相同输入克隆/普通重渲染key不变。实时回调再读取session/plan/case/generation/takeover/tool busy并重建gate，拒绝旧key。重播只隐藏面板，相同来源返回保留已提交答案和草稿；快捷问法不覆盖未提交文字；不同session/cue/generation或诊断修订显示空问答，不泄漏旧内容。重复已保存问题不重复追加。

不调用Provider、诊断、反思/异议提交、Memory或任何播放入口；不消费attempt。实际Session replay fixture比较case、thread和既有用户事件，只有原OUTCOME_REPLAYED事件新增。无历史artifact/Session QUESTION_ASKED事件或新schema版本；刷新/重启不恢复，也不把问答纳入总结。页面明确说明临时记录和4条限制。

| Before | After | Why |
| --- | --- | --- |
| 默认讲解结果无追问入口 | 合法结果下方有三条快捷问法和有标签的文本输入 | 让玩家核对已展示事实与限制 |
| 无问答来源区分 | 答案逐条列事实/限制，显示来源及部分解释边界 | 防止被理解为新增诊断 |
| Panel卸载可能失去局部输入 | Host受控保存，重播返回保留；快捷问题不覆盖草稿 | 与原回看流程共存 |

复用原Panel/原生button/form/textarea、rem尺寸、focus及reduced motion/transparency样式，只新增问答记录长文本换行规则。无新动画、分页、模态或工具控制。

## A4 验证

三类支持问法、越界/错误前提及实际Panel回调10项smoke先通过；后补gate/信息/状态边界。最终命令：

```sh
pnpm exec vitest run apps/web/lib/coaching/current-cue-questions.test.ts apps/web/components/playback/teaching-diagnosis-panel.test.ts apps/web/components/playback/teaching-diagnosis-replay.test.ts apps/web/lib/coaching/diagnosis-replay.test.ts apps/web/lib/coaching/cs2d-coaching-view.test.ts
pnpm typecheck
pnpm build
```

最终5文件81项全部通过（新增38项）；TypeScript与Next production build通过。主控指出空facts时文案不能声称可列出事实，已增加明确缺口分支与断言，并在最终产品改动后重跑上述检查。本地日志保留于`.local-data/cue-question-evidence/`。

新增测试使用生产diagnoseTeachingCue生成完整结果、生产Session/replay与实际Panel元素callback/SSR；覆盖21种状态/归属拒绝、未来/OUTCOME/未观察/无引用/重复ID/非法时间、空advice/不合格建议、基础讲解归属、空事实/限制、旧历史、追加指令拒绝、修订/旧回调、4条/300字上限。没有挂载完整Host React组件或iframe；Host接线通过实际diff审查，不能将fixture称为浏览器端到端。

获授权的默认配置`cue_question_boundary_review`进行了5分钟内只读源审查，未发现must-fix；所提revision/replay/stale边界均已纳入测试。无并行写入，无额外服务或资源。

## A5 / 剩余限制

ARCHITECTURE明确本地只读投影与旧legacy/未来生成式问答的分工，学习日志和任务板同步。未执行浏览器、键盘/屏幕阅读器或窄栏视觉验收；SSR只证明输出及实际回调，原锁屏UI A5继续未完成。没有Demo解析、真实模型、用户DB/密钥、安装部署/main操作。本轮不证明专业质量、泛问答能力或性能提升。
