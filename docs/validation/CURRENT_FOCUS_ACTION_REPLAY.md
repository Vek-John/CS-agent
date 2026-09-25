# 当前判断主题与动作事实演示验证

日期：2026-09-25。基线 c6265b1，产品前序 886e9ad。范围为 Stage3 工具资格接线，未进行新的 Demo、模型或浏览器运行。

## 问题与落地

现行 Compiler 输出判断类别，而旧工具规则主要识别战术主题。测试使用合成候选及独立 PlayerActionFact，通过实际 assessment、compileReviewPlan、确定性 Narrator、Host、builder 复现：REVIEW_UNCERTAINTY / INSUFFICIENT_EVIDENCE 有已引用的本人动作，却得到空 capability（原先 1 红、1 绿）。合成时间不代表真实 Demo 测量。

新增唯一用途 ACTION_FACT_REPLAY，允许符合身份、冻结窗口、动作来源和讲解引用条件的事实慢放。判断仍为 INSUFFICIENT_EVIDENCE。其他当前判断类别的地图、轨迹、胜率和经济用途没有开放；旧合法 focus 路径保留。

## 验证

- 同一实际 Compiler fixture 经 Host 的严格事件、内存 Graph 默认 Policy 和真实 Host registry，自然产生一条 REPLAY_CUE_SLOW effect 与绑定窗口/0.5 速度的命令；未指定工具选择或伪造 callId。重复请求不重复发命令。
- 无动作的实际 Compiler fixture 自然 FINISH。错误候选/actor、未来动作、讲解缺引用、动作未绑定、未完成 gate、错误完成末端和冻结窗口不同均阻止授权。
- 独立只读复核发现 COMPLETE 但窗口未真正完成的问题；新增两个负例先红，再收紧冻结 ticks / gate end / completedAtTick 后转绿。复核闭合无剩余 must-fix。
- 26 文件 256 项相关测试通过（完整 coach-agent 库、Stage3 Host/Controller、当前 Compiler 主链、DeepSeek Policy 假请求、teaching-gates）；随后新增冻结窗口负例，当前主链 13 项通过，总计 257 个不同用例。取消、暂停、旧调用/恢复、工具预算沿用相关回归覆盖。
- TypeScript 检查和 Web production build 通过。未改 Viewer/Parser，未重复其构建。

## 限制

本轮证明的是功能资格断层修复，不是模型判断准确率或用户体验评分提升。未运行实际 Demo、真实模型、浏览器/桌面 UI；不能认定原四个真实 cue 已有演示，也不能关闭原工具暂停 A5。后续由原负责人在合法自然工具出现时验证暂停至少 12 秒及同次继续。未启动服务、修改用户数据库或使用密钥。
