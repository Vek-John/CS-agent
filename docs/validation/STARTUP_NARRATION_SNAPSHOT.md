# 起点讲解保存快照（2026-09-27）

## 问题与行为

READY_TO_START时已经捕获起点恢复记录；但原Host在等待创建Revision和保存Analysis/Candidate/Plan之后，才读取live narration map保存讲解。此时后来生成的cue也可能加入首批保存，同时它们的NARRATION_UPDATE已排队等待durabilityCommit之后再次保存。

起点保存改为与恢复记录共用当时的完整讲解快照，保留所有当时已准备项，不机械截成两项；后续讲解各自沿后台路径保存。原Analysis→Candidate→Plan→起点Narrations→Recovery→head顺序保持，起点未结算前不假称已保存。

后台保存同步捕获history实例、ownershipGeneration及准备generation，等待起点后只允许原owner保存；错误反馈也重新检查当前归属。bulk JSON读取仍在beginRevision之后的原阶段，不增加Replay或Analysis复制。

## 验证与限制

初始四轮夹具只有一个合法cue，不能覆盖后台准备；该长度失败不是业务红。最终使用实际Adapter能产出的三个合法cue，保持生产提名门。由真实Orchestrator并行完成首两cue，在deferred beginRevision期间生成后一个cue；原保存seam保留await后读取live map时，激活被后cue保存阻挡且总Narration写入4次，修复后总3次、起点HEAD先于后cue保存，后cue存储仍挂起时激活回调已执行。没有靠放宽教学门、修改时间线或直接插入cue制造结果。

8项新增回归还覆盖当时已有3项全部保留、真实validateStoredReviewArtifacts消费、首批讲解写失败head=0、缺必需bundle早失败，以及起点/后台同Controller adopt、换owner和generation失效。背景写入仍等待起点成功，不把未落盘讲解标为已保存。

相关命令：`pnpm exec vitest run apps/web/lib/review-history/prepared-start-persistence.test.ts apps/web/lib/review-history/artifact-validation.test.ts apps/web/lib/review-history/history-persistence-controller.test.ts apps/web/lib/coaching/cs2d-route-integration.test.ts apps/web/lib/recovery/cs2d-session-recovery.test.ts`，5文件100项通过；`pnpm typecheck`及`pnpm build`通过。原红与最终日志保留在`.local-data/startup-narration-snapshot/`。

partial_revision_restore默认配置独占保存seam与测试，root负责Host接线、文档、实际关键diff复核及集成检查。进程退出、无用户数据写入。合成Replay的实际Adapter/编排/Controller，存储为stub，激活回调不是完整Host挂载；不代表真实Demo、浏览器或SQLite落盘，不声称具体真实毫秒提升。原UI A5独立。
