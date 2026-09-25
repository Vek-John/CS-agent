# 手动回访完成后的有据追问

2026-09-26；基线89f488c（产品9311269）。仅QA gate及visit key的小接线，不改Session reducer、global progress或REPLAY_OUTCOME。

## A1/A2 本次visit完成才授权

两种真实Session fixture（默认路线已看过/从未看过）均执行`BEGIN_MANUAL_CUE_VISIT`：先清空outcome gate，TICK到decision为LOCKED，完整到outcome end才PAUSED+COMPLETE。finish不修改global revealed；原QA对两种完成状态仍返回undefined，2红后修复通过。

| Before | After | Why |
| --- | --- | --- |
| manual/takeover一律拒绝，必须global revealed | manual须匹配当前cue、非空实际visit_id及本次完整gate，允许本visit takeover | 不用默认路线曾看过标记代替当前回访完成 |
| question key不含visit | manual实际visit_id，default为null | 相同cue的不同visit不能串答案；合法名“default”不碰撞 |

plan/session/cue/segment、现代observer来源、PAUSED、gate cue/outcomeEnd/completedAt、诊断链/讲解归属、事实时间及资源双重核对全部保留。默认路线仍需未自由接管且global revealed；空visit ID、错误manual cue、普通自由查看继续拒绝。fresh gate由Session begin/finish保证，不新造第二套播放完成状态。

## A3 只读与隔离

- 实际Panel快捷按钮callback：同visit重渲染保留未提交草稿和答案；开始新visit时gate清空，旧callback拒绝；完成新visit后key变化，旧callback仍不能改写新状态，SSR不显示旧草稿。
- QA前后整个Session相等，包含case/thread/attempt及默认cursor/consumed/presented。取消manual经既有reducer恢复默认游标；仍自由接管时不可问，返回默认路线后可用原QA，推进结果与原路线一致。未改Host原确认/呈现副作用，fixture不替代完整Host取消交互。
- 基础讲解和完整诊断均可在合法manual完成后使用原3类问法；4类资源回答与默认来源逐项一致，伪造source仍unknown。spy证明同源manual进入/完成/草稿更新不新增资源投影调用。
- 不发新QUESTION/Reflection/Disagreement/Provider/Memory/history或播放事件。不新增manual“再看一遍”；REPLAY_OUTCOME原global gate不变。

Host已将Panel可见性和live callback统一交给生产QA context gate，且既有诊断表面允许manual完成，故无需改Host/Panel代码或样式。沿用原生可访问控件和reduced motion/transparency；没有新UI控件。

## A4 运行证据

```sh
pnpm exec vitest run apps/web/lib/coaching/current-cue-questions.test.ts apps/web/lib/coaching/current-cue-resource-questions.test.ts apps/web/lib/coaching/diagnosis-replay.test.ts apps/web/components/playback/teaching-diagnosis-replay.test.ts libs/session/src/manual-cue-visit.test.ts libs/session/src/index.test.ts
pnpm typecheck
pnpm build
```

新增5项并扩既有baseline/归属测试；最终6文件136项全部通过，TypeScript与Next production build通过。日志在本地`.local-data/manual-question-evidence/`。主控集中复核实际gate/key与Host接线，无新审查代理。

## A5 / 剩余限制

架构、学习日志、任务板同批更新后交付。仅同visit页面内状态；新visit/cue不复用旧答案，刷新清空，不承诺永久或跨visit草稿恢复。支持仍为有限3类解释/事实/未知＋4类数值核对，不是开放NLP或新专业判断。

证据为synthetic Session/来源、真实Panel callback与SSR，不是完整Host挂载、浏览器、iframe或辅助技术验收，原锁屏UI A5保留未完成。无Demo解析、真实模型、服务、用户DB/密钥、安装部署或main变更；自有测试和build已退出。
