# 基础路线默认工具闭环

日期2026-09-27；基线32f1b25，任务basic-route-default-tool。

## 为什么补这一条

既有current-focus-tools验证编译fixture经默认Graph到Host命令，旧stage3-integration使用手工cue与显式策略验证ACK；tools/validate-guided-lifecycle.ts的整场链禁止策略/可视工具。本轮仅补无胜率真实Adapter的自然输入到Controller结果的结合点，不重做它们的矩阵。

实际Next agent API的runtimeFor未注入policy；桌面只指定SQLite saver，Runtime缺省使用DeterministicPolicyAdapter。本轮以memory checkpoint验证相同默认策略，不读取或写入用户SQLite。

## 两条执行路径

现有fireReplay合成死亡和本人射击事件→真实buildCs2dAnalysisBundle→确定性讲解与冻结路线→真实Session前置片段与outcome COMPLETE→实际默认Runtime、HostAdapter、Controller。

| 路径 | 验证结果 |
| --- | --- |
| 正常ACK | 自然选择REPLAY_CUE_SLOW/ACTION_FACT_REPLAY；matching CUE_PLAYED ACK后1次RESUME_TOOL、1条SUCCEEDED toolHistory、1次cue完成 |
| 工具超时 | 可用bridge上触发实际Controller timeout处理；1次RESUME_TOOL、1条FAILED toolHistory、1次cue完成；迟到成功ACK不覆盖失败 |
| 重复及旧回调 | 重复ACK、保存的旧timeout回调、重复start均不产生第二条工具命令或resume |
| 无胜率边界 | timeline=UNAVAILABLE，无WIN_RATE_DROP候选，能力中不含SHOW_WIN_RATE_IMPACT；独立动作事实仍可回放 |
| 时间线与推进 | 按冻结plan核对所有前置segments，包括Session START自动越过的freeze；工具完成后Session仍PAUSED_FOR_COACHING，下一段沿原有推进契约 |

新增2例，相关4文件22tests通过。初次smoke失败来自测试漏算自动跨过的freeze段，按实际plan纠正；没有发现必须修改的产品逻辑，因此仅新增测试。主控独立读取真实测试、默认API/Runtime接线与Controller timeout/resume处理。

两端TypeScript与production build均退出0。首次Web TS因expect不收窄Session phase和action refs可选而失败，改为实际phase guard与空数组断言后，新2例及Web TS/build复验通过；不使用强制类型断言绕过状态门。

## 限制和资源

合成事件时间不是测得的Demo精确tick；控制器scheduler和Viewer ACK为受控测试边界，没有实际Viewer像素播放或真实桥接延迟。Adapter、Planner、Session、默认Policy、Graph与HostAdapter/Controller为真实实现；fetch设为抛错且断言0次，不调用模型或外部服务。没有声称专业判断改善或真实桌面A5完成。

Controller dispose后timer清零；Runtime使用内存checkpoint，无外部进程或数据库。执行者已RELEASE；本地日志.local-data/basic-route-default-tool/{smoke,tests,recheck,typecheck-web,typecheck-viewer,build-web,build-viewer}.txt。
