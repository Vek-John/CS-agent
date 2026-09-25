# 当前追问复述已有建议与条件

2026-09-26；基线 7bdbe68；7f2b/codex/jev-decision-assessment。

## A1：生产断点

实际 diagnoseTeachingCue 从合法合成输入生成 INCONCLUSIVE 和满12条限制，包含上一轮饱和时保留在 do 末尾的条件化说明。真实 TeachingDiagnosisPanel SSR 确认原建议及12条限制均存在；同输入经 buildCurrentCueQuestionContext 后问“下次记住什么？”，旧 answerGroundedCueQuestion 返回unsupported。该实际producer→Panel→问答断言先红后绿。

## A2：投影和来源

沿用已有Session/plan/cue/segment、observer、fresh outcome gate、CueCase/reflection/hinge/result/verdict身份链与busy门，只从该完整诊断的transferRule读取。when/do非空才有建议能力。保存原when/do/unless，限制按Panel既有playerFacingLimitation投影和去重；全部schema有界条目进入回答，不套事实400字或通用前4项限制。

支持“下次记住什么”“下次要记住什么”“复述一下当前建议”三种精确问法，标点/空白处理沿既有normalize。回复说明只复述已展示内容，不重新评判或证明最优。动作文本的本地refs只保留rule.refs与既有合法、唯一、已显示决策事实的交集；不从这些refs声称每句话已被证实，限制不补造引用。内部ID不显示给玩家。

## A3：UI与状态

| Before | After | Why |
| --- | --- | --- |
| 已展示建议仍被通用unsupported挡回 | 明确问法复述原建议及完整条件 | 复用当前已有内容 |
| 问答快捷区只有原3项 | 合格诊断才出现“下次记住什么？” | 不对基础/fallback许诺无源能力 |
| 同case/result ID的规则变化可能复用旧答案 | 完整rule加入sourceRevision | when/do/unless/limitations/refs变化均失效 |

Panel使用原按钮、列表、换行和滚动样式，无新动画/透明材质；Host仅增加canRepeatAdvice能力prop。缺失/旧未可信/不匹配身份仍关闭问答入口；合法基础/fallback上下文保留原3+4类，建议问法明确无可复述来源，无快捷按钮。不从cue.advice或Narration补建议。

实际Panel回调使用同一生产updateCurrentCueQuestions复查live context。测试证明快捷提交保留独立草稿、重复提交去重；手动新visit播放中及完成后均拒绝旧callback。同来源默认/manual真实Session重播返回保留建议答案与草稿，不改变cueCases/learningThreads/诊断attempt或默认路线。旧保存规则按原文复述，不补回历史缺失限制。

## A4：验证与成本边界

```sh
pnpm exec vitest run apps/web/lib/coaching/current-cue-questions.test.ts apps/web/lib/coaching/current-cue-resource-questions.test.ts apps/web/components/playback/teaching-diagnosis-panel.test.ts apps/web/components/playback/teaching-diagnosis-replay.test.ts apps/web/lib/coaching/diagnosis-replay.test.ts
pnpm typecheck
pnpm build
```

相关5文件154项、TypeScript、Web production build全部通过。除生产红例外，还验证超过400字的schema合法保存条件不截断、unless完整、饱和12条与额外说明、非法refs不进入引用、5种同ID内容修改、基线/fallback/缺transfer/空建议、错误前提/职业/语音假设/其他cue不扩权、原3+4问法与资源cache回归。

新逻辑只读取已解析有界字符串，未调用模型/诊断执行/Memory/持久化/播放或Demo读取。20次实际建议快捷回调保持输入不变、同问题仅一条；已有资源cache测试继续证明同来源草稿/回看不重算投影。状态仍本页300字草稿和最多4条回答，完整回答可长于事实回答，不为缩短而删适用条件。

开发时两处新增测试自身问题（readonly refs使用push、manual比较未过滤既有回放事件）已修正；不计为产品回归。主控只读关键diff无must-fix，未另开代理。

## 剩余限制

这是三种明确问法的原建议复述，非通用战术问答、建议质量验证或新推理。rule schema/身份通过不代表专业判断正确。限制技术词投影沿既有Panel政策，未重做全项目文案。旧历史产物未重算/补写。原页面最多4条、刷新清空，无跨重启保存。测试为生产模块/SSR/callback/Session合成fixture，未做真实浏览器布局、桌面、DB、Demo或模型实测；未启动服务、安装部署或修改main。
