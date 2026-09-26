# 库存语义的SQLite保存与恢复

2026-09-26，基线12778fe。本轮仅新增集成回归和证据，没有发现需修改的生产缺口。

## 实际链路

当前Adapter1.11/Timeline1.2的合成Replay→buildCs2dAnalysisBundle→真实CoachingPackage/OutcomePackage及确定性Narration→route/session/recovery生成→逐artifact领域校验→DesktopReviewLibrary持久化到mkdtemp中的SQLite与ROUTE_START runtime head→关闭owner→新owner/library重开同文件→实际history GET→HistoryRestoreController→validateStoredReviewArtifacts/normalizeRecoveryAnalysis/restoreRecoveryArtifacts→实际恢复准备orchestrator→ThreeStageCoachingView与buildTeachingDiagnosisInput。

测试文件：apps/web/lib/review-history/inventory-restore.integration.test.ts。server-only环境标记和desktop origin边界用于本地测试；managed Demo只使用微型合成header字节，finalize valid是资料库生命周期stub。合成Replay时间不是实测canonical Demo tick，未读真实Demo或启动Parser。

## 六种情形与结果

| 输入 | 恢复后的类型列表 | 数量/界面 |
| --- | --- | --- |
| version1、明确[] | [] | utilityCount=0，显示无道具 |
| version1、Flash | [Flash] | 颗数未知，不显示无道具或伪造颗数 |
| version1、Smoke | [Smoke] | 颗数未知，不显示无道具或伪造颗数 |
| version1、省略库存 | null | unknown，不造零 |
| version1、无效类型 | null | unknown，不造零 |
| 无版本的输入列表 | null | unknown，不追认完整 |

“无版本输入列表”是新分析的旧parser输入情形，不是旧Adapter1.10已保存artifact迁移测试。每种情况同时断言健康资源和evidenceRefs有效，避免整个诊断输入缺失却弱通过。保存artifact和runtime head读回保持，未追加修复/重生成产物。

## 不重复生成的可观察证据

重开阶段spies清零并拒绝transport：

- 冻结prepareRoute校验调用1次，仅验证并返回保存路线，不能称为新的Director生成。
- prepareNarration、deterministicNarrator、buildCs2dAnalysisBundle重新调用均0。
- fetch/transport、Viewer source请求、loadManagedDemo均0。
- 实际orchestrator到READY_TO_START，没有NARRATION_UPDATE。

这证明ROUTE_START控制面和已保存讲解的恢复复用；不声称完整React Host挂载、Viewer重新解析/bridge定位或Graph重连均已测试。

## 验证、资源与下一项

六项新集成测试通过。主控联跑新集成、history-restore-controller、artifact-validation、coaching-view共4文件45项通过；TypeScript和Web production build通过。源码/Parser未变，不重复WASM/Viewer构建或旧Demo实验。SQLite experimental警告为现有运行时提示。

partial_revision_restore默认配置独占测试，主控查看完整实际链和差异并统一验收，无生产改动。每个测试finally取消本轮controllers、关闭owner并只删除自身mkdtemp目录；afterEach恢复环境/全局模块绑定。所有本轮测试/build进程退出，无用户库、模型、网络、浏览器、安装或部署。未修改架构契约，原UI A5独立待验。

下一可见改进已由生产代码确认：ThreeStageCoachingView当前只显示精确utilityCount，已确认Flash/Smoke种类但颗数未知时整个道具chip缺席；旁路Narration已有种类事实。下一项在同一决策身份/采样边界下直接呈现已确认种类，明确数量未知，保持unknown不造道具、knownempty仍无道具；沿现有chip，不新增复杂UI或放松证据资格。
