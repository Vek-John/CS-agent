# 诊断资源时效与回合绑定（2026-09-25）

基线91a6c02（67b7497＋交接）。本轮A1—A5实现与本地验收完成，修复Host把旧状态当成当前资源的问题。没有新Demo或专业质量评估。

## 生产路径红→绿

原stateAtOrBefore只按player与tick<=decision选最新，未约束年龄或回合。两条实际runTeachingDiagnosis回归先红：64tick/s、decision2000使用1967（超出32tick）；第二回合decision1601使用第一回合1599（虽近但跨回合）。旧路径生成100HP、100甲、4000存款、4000装备值、2颗道具，并判资源SUPPORTED；修复后不生成这些测量，无其他经济证据时UNVERIFIABLE。

以上均为合成fixture时间，不是已观察到真实Demo误诊。

| Before | After | Why |
|---|---|---|
| 过期或上一回合样本被说成当前资源 | 省略确定测量，并说明本人资源未知 | 近邻时间不等于同一决策的可信状态 |
| 本人资源不可用就连公共队友人数也丢失 | 独立可信decisionRoster仍可验证TRADE条件 | 公共人数不应依赖必填血量字段 |
| 当前facts/结果refs拼进资源measurement | 资源只引用样本来源，人数只引用snapshot名单来源 | 新事实不能替旧资源背书 |

## 时效与字段规则

- Host由cue.segment_id及其cue_ids绑定唯一计划segment，再匹配timeline中唯一包含decisionTick的round，round_number必须一致。start_tick含冻结期；end_tick半开，下一回合起点不能沿用前回合样本。freeze_end_tick须为合法回合内边界。
- context选人与timeline.selected_player_id一致。decision/sample ticks须非负安全整数；tickRate须正安全整数。取同player、同round中不晚于decision的最新样本，年龄<=ceil(tickRate/2)，沿用半秒的离散tick约定。64允许32tick、拒33；65允许33、拒34。不外推，不读未来。
- 顺序不影响选择；最新tick有多份样本时保守unknown，最新状态字段不合法时不退回更早状态。无timeline、round不明、segment不匹配或重叠round均不提供确定资源。
- 样本须明确存活、health>0且<=100、armor在0..100、helmet布尔值、阵营T/CT、缺失元数据合法。必需资源或存活/阵营/新鲜度缺失标记不允许以归一化默认值补齐。当前回合已发生本人死亡事件（不晚于decision）也不能沿用死前状态。
- 若已有DecisionSnapshot，还需其player/round/decision一致、sampledAtTick非未来且新鲜、与所选样本tick相同，selectedPlayer为OBSERVABLE且有必需资源/存活值；不回退绕过其missing或错误身份。只存在raw新帧不能修复错误绑定的snapshot。
- 未知/非法的可选money/equipmentValue省略，不钳为0；inventory仍走上一轮完整性/utilityCount规则，未知不变成零。无法满足既有rich库存结构/schema的样本不进入资源诊断。

已通过选择门的同一个state用于Host本地rich与远端compact，旧state不会留在另一条分支。资源measurement引用只来自state.fact_refs；不追加当前decision/action/outcome，也不与roster refs混合。合法决策facts、动作和结果仍在各自既有字段中，既有独立经济语境与风险阈值保持。

## 独立公共人数与兼容

新增可选TeachingDiagnosisInput.decisionRoster，仅有aliveTeammates（0..4整数）和有界evidenceRefs，strict schema拒绝player/time/position等字段。Host人数只取绑定当前cue/player/round/decision且sampledAtTick同回合、非未来、新鲜的OBSERVABLE snapshot；需明确己方阵营、本人存活布尔值、完整人数及includesSelectedPlayer语义，不允许缺fresh_player_state、complete_current_roster、alive或current_side依据。

本人state过期或没有state时，可信snapshot的0存活队友仍使“补枪条件”CONTRADICTED，同时保持原Verdict INCONCLUSIVE和“不能据此评价先前选择”的文案/规则。不因为拆分字段提升专业判错资格。

共用selector在executeDiagnostic、Verdict及Transfer全链路优先新decisionRoster；无新字段时继续接受旧decisionResources.aliveTeammates。独立复查发现初版后两处仍读legacy，新增(新0/旧2)、(新2/旧0)完整result/verdict/transfer对照先2红后绿，已关闭。另补未知side的snapshot守卫。新字段只传到既有Graph/API schema，没有新服务或身份泄漏。

旧保存诊断按原产物恢复，不补新鲜度标签、不改历史测量或自动重新诊断。既有实际恢复测试继续验证0/2及legacy1.5原样、零fetch；这不意味着旧错误显示被追溯修正。

## 验证

7文件147测试全部通过，无跳过；pnpm typecheck、pnpm build通过。

覆盖：乱序/同tick/半秒边界、冻结与跨回合、未知round/错误segment/错误选人、NaN/小数/未来/非法rate、重复最新样本、死亡及required missing、snapshot原state绕过、独立人数存在/缺失/错player/round/future/过期、引用分离和旧人数优先级。Host→strict event→序列化remote envelope→真实内存Graph及同包→实际POST /api/coaching/diagnose，与本地rich的DiagnosticResult/Verdict/Transfer完全一致，重复dispatch不改变trace。静态组件渲染验证未知说明、不展示旧测量且继续按钮保留。

收尾发现新增未知说明会占用限制条数：GET_INFO/DELAY在已有10条限制时2红（超出12项schema），为各执行器最多2条说明预留预算后全绿。只调整文本容量，不改判决条件。

```sh
pnpm exec vitest run apps/web/lib/coaching/teaching-diagnosis-freshness.test.ts apps/web/lib/coaching/teaching-diagnosis-host.test.ts libs/coach-agent/src/teaching-diagnosis.test.ts libs/coach-agent/src/teaching-diagnosis-graph.test.ts apps/web/app/api/coaching/diagnose/route.test.ts apps/web/components/playback/teaching-diagnosis-panel.test.ts apps/web/lib/recovery/cs2d-session-recovery.test.ts
pnpm typecheck
pnpm build
```

一次新增测试阶段曾因合成timeline共享round数组被前一用例修改而产生3个假失败；改成每例structuredClone隔离后通过，非生产缺陷。MatchEvent fixture缺两个必填字段的类型错误也已补齐，没有削弱类型。

## 限制、所有权与清理

时间可信门由拥有timeline的Host执行；远端只接受已经投影的资源/人数，不接收raw state来重做时间验证。保留的低层rich入口仍要求调用方提供可信决策状态，本轮未将所有内部入口改造成全局时间验证器。没有独立snapshot时，合法的同回合新鲜timeline样本仍可用；缺必要上下文则保守未知。

没有新Demo解析、模型、浏览器、服务、真实DB/Memory/密钥访问、安装发布部署或main合并；Parser/Viewer不改。原锁屏工具A5未补验，不把SSR当浏览器实测。既有布局、键盘与辅助入口保持，沿用已读emil-design-eng/apple-design；没有UI重构。

root独占实现；resource_freshness_review继承默认配置，5分钟只读终审及2分钟闭合复核，没有写文件/启动进程。所有测试/build已退出，无临时服务，忽略目录只留小日志。文档/实现同次commit push后释放当前树写入。测试通过证明边界行为，不代表专业教学准确率提升。
