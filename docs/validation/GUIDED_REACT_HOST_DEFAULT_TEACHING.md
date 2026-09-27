# 默认诊断教学：真实 Host 验收

日期：2026-09-27。基线1c46d29，功能分支codex/jev-decision-assessment。

## 验收路径与边界

复用真实React Host、Session、自然Vue Viewer时钟、生产准备合同和实际内存Graph。186帧合成双回合只用于接线验证，选人入口明确替代DemoAnalyzer；不解析真实Demo，不访问用户库或外部模型。此次使用无teachingDiagnostics参数的默认开启值；旧off模式继续保留。

源码核实：Reflection Gate仅在处理结果完成后显示；默认诊断模式不启动基础模式的视觉工具controller。提交先synchronizeDiagnosis以无视觉能力同步当前cue，再SUBMIT_REFLECTION；Graph直接调用现有确定性diagnoseTeachingCue。Graph失败时Host可本地回退，因此界面出现结论不足以证明Graph成功，需同时看真实Runtime事件与case输出。跳过是明确SKIPPED路径，不算诊断成功或专业判断改善。

计划实际操作：合成载入/选人→自动播放首cue→选择用户目标并提交→核对有据结论/未知边界与当前提问→明确继续→第二cue跳过→保持可继续。所有引用、未来信息与结果完成门不变。

## 复跑

```sh
node tools/cs2d-host/react-host-smoke.mjs
node tools/cs2d-host/react-host-smoke.mjs --serve-only --port=0 --diagnostics
```

仅使用输出的新origin，初始存储不为空时停止，不清用户数据。测试环境仍为本地内存Runtime和确定性准备provider，不是完整Next/native/SQLite/模型E2E。

## 本轮证据

1. IAB tab16 / 独立54049 origin：首cue处理完成后回合成1400暂停，出现Reflection Gate，没有视觉工具ACK。选择“拿信息”并提交后，真实Graph输出 AWAITING_CONFIRMATION / UNVERIFIABLE / INCONCLUSIVE，verdict引用5条、当前learningThread1。UI明确“待核实”，USER陈述没有变成DEMO事实。
2. 点击“下次记住什么？”后，原文复述当前TransferRule的当/做/除非及全部适用限制，不新判错、不声称最优。点击“懂了，继续”实际进入第二cue。
3. 第二cue回合成2600暂停，明确跳过后Graph记录SKIPPED/FALLBACK，没有diagnostic/verdict/thread。两点共 START_CUE2 / SUBMIT_REFLECTION2 / OBSERVE_SEGMENT7，外网0；准备没有重复。
4. 发现真实缺陷：跳过后虽然基础讲解和继续可用，仍出现“正在准备讲解”。原因是Host在默认诊断模式不启动视觉controller，却仍渲染它的旧/空状态卡。生产只在该卡显示条件增加 `!diagnosticsEnabled`，不改诊断、播放控制、准备或结果门。
5. 最终IAB tab17 / 独立54218 origin复验首cue跳过：准备状态卡消失、事实/讲解/提问保留，继续按钮实际推进第二回合。实际Graph SKIPPED/FALLBACK且无诊断，父页/服务零外网、零模型、errors=[]。[冻结摘要](GUIDED_REACT_HOST_DEFAULT_TEACHING_RESULT.json)。

## 检查、清理和后继

- 工具2文件5tests通过：真实Controller.synchronizeDiagnosis与Graph的ANSWERED/SKIPPED、重复事件幂等，无视觉工具。每例独立阻断并断言fetch零调用（修正模块缓存造成后续test未重新阻断的问题）。
- 生产窄修后5文件64tests通过，Web TypeScript / production build及工具build复验通过。专项 `pnpm exec tsc --noEmit -p tools/cs2d-host/react-host-smoke.tsconfig.json`、脚本语法通过；Vue child由已存在构建/GUI覆盖。Viewer TypeScript / production build本轮已通过，之后Viewer无改动。
- Root实际审阅生产单行diff、Host/Graph诊断门和匿名计数，未新增镜像实现字符串测试。仅当前功能分支，不安装或部署。
- 页面tab16/17、54049/54218服务全部关闭；测试执行者RELEASE。截图 `diagnosis-question.png`、`skipped-before-fix.png`、`skipped-after-fix.png`，日志 `tests.txt`、`typecheck.txt`、`feedback-{tests,typecheck,web-build,harness-build}.txt` 与两端基线检查保留在 .local-data/guided-react-host-default-teaching/。
- 剩余：本次实际Graph成功与用户主动跳过，不等于网络失败回退或持久化恢复通过。下一有限目标使用已核实小场景，对一次SUBMIT_REFLECTION运输故障做有界验证，确认本地回退保留用户意图、能继续后续路线，不重新准备/分析或假报保存成功；不重跑拒判集合或降低引用门。
