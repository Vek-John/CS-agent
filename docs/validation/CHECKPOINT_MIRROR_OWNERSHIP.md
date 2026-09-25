# 恢复点镜像：有限保存等待与会话归属隔离

2026-09-26；基线4e41f6f（产品354d2e4）。本轮只处理Host生产mirrorAgentResult链、两项checkpoint JSON保存及必要只读归属token，不改Graph/checkpoint schema、Memory、服务器事务或自动重试。

## A1 生产入口红例

将原Host callback直接提取为`mirrorAgentCheckpoint`并接回真实组件，先保持原行为。以真实HistoryPersistenceController、ReviewHistory API、内存SessionRecoveryRuntime及deferred transport复现3红：

1. A等待runtime保存时切换B，旧结果被accept进B，之后晚读取已adopt B的history，向B发A的artifact/head。
2. 旧A结果在归属判断前写latest checkpoint，污染新会话。
3. 当前checkpoint artifact请求永不返回，合法Controller完成结果因await mirror一直无法返回。

这些测试调用生产镜像入口，不是只测新predicate；不触及用户DB、真实Demo或模型。

## A2 大小、职责和期限

| 一手源码边界 | 结论 |
|---|---|
| recovery-contract.ts record校验使用JSON字符串length，名义1Mi；最多64 ledger/3 narration | 含冻结路线、进度与有限讲解，不含raw Demo；该上限是UTF-16字符，不等同UTF-8字节 |
| review-library/library.ts smallJsonMaxBytes默认256KiB，只有ANALYSIS_BUNDLE可外置 | SESSION_RECOVERY实际入库受256KiB JSON限制 |
| artifacts请求体8MiB；runtime-head请求体128000B | artifact端点共用重型AnalysisBundle，不能全部套新小保存期限 |
| 两端均loadReview(materializeExternalArtifacts:true)并验证身份/checkpoint/artifact | 不能宣称只是瞬时小SQL；20秒为保守客户端等待政策，非实测SLA |
| HostRecoveryStore open/transaction已有1500ms保护和内存降级 | 原IDB实现保留，不另造事务timeout |

隔离实际DTO经生产mirror及history controller序列化后，artifact请求1761字节、head663字节。这是有限fixture测量，不代表整场比赛的通常大小或最大值。

只给`appendArtifact`的SESSION_RECOVERY分支及`commitRuntimeHead`各20秒fetch+body共同期限，复用共享owner。HTTP错误正文的原code保持；2xx空/非法JSON继续沿原void API成功语义，**兼容不等于新增或更强的保存证明**。错误正文挂起也必须到期；迟到headers不再读取body、迟到body/error不能重新结算或继续后续head。其他artifact、AnalysisBundle上传、detail/导入等历史操作不改变。

默认桌面Host在durabilityCommit（含beginRevision、初始artifact/head）resolve或reject之后才activateSession，因此正常mirror不会抢在初始化尚未结束前进入；本轮不扩创建review/revision等API期限。另用受控pending revision夹具确认同ownershipGeneration的首次初始化可完成，不把undefined→合法revision当成切换复盘。

## A3 归属与确认规则

- 在任何checkpoint ref写入前匹配event/result与live完整Agent身份、session、recovery及当前record，捕获generation、history open epoch、runtime、history实例及只读ownershipGeneration、已有review/revision。
- 首次没有record仍允许合法当前checkpoint缓存；它是已观察Graph checkpoint，不能据此宣称library head已稳定。
- 同实例adopt/reset使旧owner失效；每次runtime/artifact/head await后和catch显示错误前重核。捕获原history，不在await之后读取当前B controller。
- READY或DEGRADED必须返回真实且身份、checkpoint、boundary匹配的record，不能用`persisted.record ?? stable`把draft冒充保存结果。匹配DEGRADED内存record仍可成功写入library，接受时保留其降级含义。
- 保持runtime→artifact→head→Host accept顺序；artifact失败不调用head，head未确认不accept新record。失败仅提示本次保存未确认，保留Host此前已确认记录；旧A迟到不更新B record/checkpoint/error，也不向B写入。

已发请求仍可能在服务器执行或完成。本轮没有回滚IDB、服务器原子事务或取消保证；客户端超时不能证明服务器未提交。服务器原身份、幂等和进度单调校验不变，零自动retry。

## A4 真实消费者与回归

新增22项mirror与9项API测试包括：

- 首次无record、正常当前保存、匹配DEGRADED到library、pending revision同代完成、拒绝REJECTED/null/错checkpoint/错run。
- generation/openEpoch/recovery/runtime/history实例、同ID重新adopt/reset失效；runtime及artifact/head等待期间切换，旧回调无新UI/新review写入。
- artifact/head fetch或body挂起均到期，后续head不偷跑、Host旧确认record保持、late ack不复活；HTTPcode和成功JSON/无JSON兼容，300KB合成AnalysisBundle不受新增期限影响。
- 真实Controller.completeSession在镜像超时后仍返回合法live结果。
- 独立审查指出completeSession以notifyAgentResult=false dispatch后再await mirror，因此不能用它单独证明serial tail阻塞。补充真实START_CUE、真实内存Graph及checkpointForRecoveryBoundary匹配：默认notify=true镜像等待期间排入接管事件，19,999ms时dispatch只有1次，20,000ms后第二次实际进入并完成，旧接管前错误不更新接管UI。完成测试与串行测试分别保留。

最终相关命令：

```sh
pnpm exec vitest run \
  apps/web/lib/recovery/agent-checkpoint-mirror.test.ts \
  apps/web/lib/review-history/checkpoint-save-api.test.ts \
  apps/web/lib/review-history/api.test.ts \
  apps/web/lib/review-history/history-persistence-controller.test.ts \
  apps/web/lib/recovery/session-recovery-runtime.test.ts \
  apps/web/lib/coaching/coach-agent-transport.test.ts \
  apps/web/lib/coaching/preparation-transport.test.ts \
  apps/web/lib/coaching/coach-agent-stage3-controller.test.ts \
  apps/web/lib/coaching/session-completion-feedback.test.ts \
  apps/web/lib/coaching/session-wrap-up-completion.test.ts \
  'apps/web/app/api/review-history/[id]/runtime-head/route.test.ts'
pnpm typecheck
pnpm build
```

11文件181项通过；TypeScript、Next production build通过。产品代码最后改动后执行构建，随后补充独审要求的串行路径测试及再次TypeScript/相关回归；没有新增产品改动。原6bc126b完成反馈、354d2e4 Agent期限以及preparation原HTTP/JSON错误语义保持。

## A5 交付边界

默认配置checkpoint_mirror_review限定只读调查及终审；实现无must-fix，验证缺口已补证。架构、学习和持续任务卡随同commit/push完成后释放，自有测试/build结束。

所有网络/存储故障用fake transport、fake clock或隔离内存存储验证，未读用户DB、未运行Demo/模型/浏览器服务；没有安装部署或修改main。复用既有失败反馈，不新增动效；原UI A5未宣称通过。

20秒是每次目标HTTP请求期限，不是整个恢复系统的端到端上限：IDB排队、review/revision初始化、其他持久化链与服务器最终提交状态仍有各自边界。已发A请求可晚在A完成；本轮证明其结果不再触发新UI或后续错误归属写入，不宣称能撤销服务器提交或保证远端head永远没变。
