# 当前回合时间的有来源追问（2026-09-26）

## 用户路径与边界

当前时机诊断已经能显示决策前最近采样的回合剩余时间，但本地数值追问原来只核对血量、护甲、道具数量与弹匣。此次在同一问答入口接受明确回合时间问法，复述已展示且与当前来源匹配的约秒值。

不新增时机判断、C4计算、模型或播放工具。结果播放完成、当前会话/教学点、可信观察上下文和完整诊断的原门继续适用。未知与未匹配值不补零；本人资源缺失不自动使公开回合时钟失效。

## 验证范围

由实际Adapter产物建立Host诊断和Session，再通过现有问答context/answer入口检查数值、来源、恢复及失效。合成Replay和模型结果只是测试输入，不冒称本轮真实Demo或CS-Net推理。SSR只能说明已有面板能渲染回答，不能代替浏览器交互验收。

新增32项回归：2个正向场景在原实现中均返回空items，接线后通过；覆盖缺本人、JSON诊断恢复、两个实际面板SSR、未知/旧/未来/错身份/结果引用、measurement的值/类型/标签/单位/引用、旧token失效和编辑不重复投影。C4/假设/其他教学点问法不匹配回合时间。严格保留原Host的时钟投影语义，共享helper避免两份校验漂移。

执行命令：`pnpm exec vitest run apps/web/lib/coaching/current-cue-clock-questions.test.ts apps/web/lib/coaching/diagnosis-clock.test.ts apps/web/lib/coaching/current-cue-resource-questions.test.ts apps/web/lib/coaching/current-cue-questions.test.ts`，4文件149项通过；`pnpm typecheck`与`pnpm build`通过。初版测试对readonly数组push被TS拦截，改为不可变替换后上述检查重新通过。

partial_revision_restore使用默认模型/推理，按模板独占5个源码/测试文件；root读取最终关键diff并复验32项新增测试，负责文档与提交。没有修改大Host或新建界面布局，原结果门、来源key和旧回调失效路径直接复用。所有测试/build进程退出，无用户数据操作或部署。

## 后继

当前基础局面卡已经区分道具种类与数量；追问却只接“几颗”。下一有限目标先用实际Adapter核实已显示种类能否以“当时有什么道具”复述，保持数量未知；没有可信显示来源时不补推，避免把种类数当持有颗数。原锁屏UI A5继续独立等待。
