# 诊断提交失败后的真实 Host 回退

日期：2026-09-27。基线8907c0d，codex/jev-decision-assessment。

## 目标与边界

在已验证的真实 React Host / Vue Viewer / Session / 内存 Graph 小场景中，首cue正常完成处理结果与诊断同步后，只令一次 SUBMIT_REFLECTION HTTP提交返回503，且该次不进入Runtime。核实用户reflection与本地诊断保留、反馈准确、后续cue还能正常提交，以及Analysis/route/narration不重复准备。

这是立即HTTP错误，不是连接中断、长时间超时或“服务已执行但响应丢失”的试验。输入为186帧合成Replay，选人入口替代DemoAnalyzer，准备provider确定性隔离；零正式Demo/Parser/模型/用户SQLite/Memory/.env操作。旧已测正常/主动跳过结果不能替代这次故障证据。

Host生产路径：先synchronizeDiagnosis以capabilities=[]绑定cue；SUBMIT_REFLECTION异常时保留用户reflection并调用实际runTeachingDiagnosis。未得到agentResult时不镜像一个虚假的Graph诊断checkpoint。下一段按Session实际确认/推进，由Controller同步后续路线。

## 复跑与证据

```sh
node tools/cs2d-host/react-host-smoke.mjs
node tools/cs2d-host/react-host-smoke.mjs --serve-only --port=0 --diagnostics --fail-first-reflection
```

故障开关仅供隔离harness使用，默认无故障模式保持。每次新origin保护用户存储，页与服务由同一root启动/关闭。日志位于 .local-data/guided-diagnosis-transport-fallback/。

## 实际发现与最小修复

修前IAB tab18 / origin54532：选择GET_INFO并填写明确的合成反思；首提交503后，Runtime记录transport4/dispatch3、reflections空。真实Host本地diagnoseTeachingCue保留原输入与条件化INCONCLUSIVE结果，但Panel完整结果分支漏掉了已有error反馈。继续第二cue后，旧error又显示在尚未提交的Reflection Gate；随后第二cue实际Graph成功，证明不是整条路线中断。

生产修复仅针对反馈：

- Host的六处诊断错误附上捕获的cueId，既有clear、generation与迟到请求guard不变。
- Panel同步仅消费与当前cue匹配的错误，无依赖effect清理的瞬时串线。
- 当前错误在完整结果、基础fallback及未核实历史三个分支均可显示，沿既有样式/role=alert；不改文案、判断、Graph、保存或回放逻辑。

最终IAB tab19 / origin54780重复必要路径：首cue回到合成1400，提交一次503后，原输入与本地诊断保留，已显示“智能讲解暂不可用，已根据现有证据继续检查。”；点击继续，第二cue回到2600，旧提示DOM匹配数0。第二次提交进入真实Graph并显示正常待确认诊断。

计数：[冻结摘要](GUIDED_DIAGNOSIS_TRANSPORT_FALLBACK_RESULT.json)。transport11、reflection attempts2、injected failure1、Runtime dispatch10；OBSERVE7、START_CUE2、SUBMIT_REFLECTION1。只有第二点在Graph产生诊断case（AWAITING_CONFIRMATION / UNVERIFIABLE / INCONCLUSIVE，verdict refs5、thread1）。浏览器Analysis1/route1/narration2、模型/外网/视觉工具ACK均0、errors=[]。不把本地首点结果称为Graph成功或持久化确认。

## 验证与清理

- 工具2文件6tests通过：实际dispatchCoachAgentEvent消费503、Runtime不执行失败请求、真实local diagnosis/Session继续到第二cue、后续真实Graph成功。各测试单独拒绝外网fetch。
- Panel真实SSR先复现3个error缺失失败，修后包含同一旧error切cue立即消失的覆盖；最终命令：

```sh
pnpm exec vitest run apps/web/components/playback/teaching-diagnosis-panel.test.ts apps/web/components/playback/teaching-diagnosis-replay.test.ts apps/web/lib/coaching/skip-reflection-flow.test.ts apps/web/lib/coaching/coach-agent-stage3-integration.test.ts tools/cs2d-host/react-host-smoke.test.mjs
pnpm typecheck
pnpm build
pnpm cs2d:typecheck
pnpm cs2d:build
pnpm exec tsc --noEmit -p tools/cs2d-host/react-host-smoke.tsconfig.json
node --check tools/cs2d-host/react-host-smoke.mjs
```

最终5文件48tests、Web TS/build及工具build通过；Viewer TS/build本轮通过且后续没有Viewer改动。工具专项TS通过，Vue child另由实际Vite/GUI覆盖。root读实际diff/Host与Graph源码/测试日志并运行UI，没有源字符串镜像测试。

执行者RELEASE，tab18/19与54532/54780自建服务均关闭。截图hidden-feedback-before-fix.png、stale-next-cue-before-fix.png、visible-feedback-after-fix.png、next-cue-after-fix.png和feedback-*日志保留；未清理用户资源、未安装/部署。

## 下一项

guided-default-session-wrap-up：已实测默认教学的回答/跳过/单次503回退与继续，但真实完整Host尚未验收到最终收尾。复用小场景与当前实现，先核对completeStage3SessionWrapUp→requestSessionWrapUp的provider边界，再验证末段、终结暂停、混合本地/Graph教学内容进入受限总结和完成入口；不伪造HTTP成功、不新增模型调用、不重新做故障矩阵。
