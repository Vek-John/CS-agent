# 起点准备的小控制记录等待（2026-09-26）

## 已核实路径

已完成的优化继续保留：assessment配置750ms/实验总预算6s，Director及旧Narrator每请求20s，现代闭合Narrator本地零请求，前两cue并行就绪，历史列表收尾不阻挡激活。

本轮缺口在Host收到READY_TO_START后：durabilityCommit先等待HistoryPersistenceController.beginRevision；它又可能先等待createForPlayer的reviewPromise。API create与startRevision原来均为无期限fetch+JSON，小记录请求挂起会使settlePreparedCoachingStart无法结算，本地Session也无法激活。

两项POST默认最大16KiB输入，服务端仅验证元数据、检查现有Demo/Review并插入PREPARING记录，不解析文件或调用模型。现统一复用既有HISTORY20秒fetch+body期限，沿原“保存未确认但当前会话仍可继续”路径激活。超时不自动重试；服务端每次UUID，客户端abort不保证撤销。

## 验证

11项新增集成测试通过真实API包装器→HistoryPersistenceController→settlePreparedCoachingStart→activatePreparedCoachingSession。合成计划的前两点已就绪且route.startable=true，分别挂起create/revision的fetch与body；到20秒前不激活，到期后unconfirmed一次并mount一次。迟到headers不读正文、迟到body不接纳ID、不提交head、不重复创建；正常成功和HTTP合法/坏JSON错误语义保持。切代/adopt新历史后，旧超时不反馈旧UI、不激活旧Session、不覆盖新revision。

最终命令：`pnpm exec vitest run apps/web/lib/review-history/startup-record-deadline.test.ts apps/web/lib/review-history/api.test.ts apps/web/lib/review-history/checkpoint-save-api.test.ts apps/web/lib/review-history/history-persistence-controller.test.ts apps/web/lib/coaching/cs2d-route-integration.test.ts`，5文件70项通过；TypeScript及production build通过。

partial_revision_restore默认配置先只读定位，再独占新测试；root独占两处API接线/文档，读取实际测试日志与diff，并统一相关检查。测试在生产补丁之后落地，没有声称旧实现红测；日志`.local-data/startup-record-deadline/`。HTTP transport和本地Recovery persistStart是stub，真实模块的Session mount不等同于浏览器/SQLite落盘。全部进程退出，无用户数据操作。

没有修改bulk Analysis/Candidate/Route等待策略，也不声称启动总时长只有20秒。服务端迟到成功可能留下PREPARING记录；这里不自动删除或重新创建，不做未提交保证。

## 后继证据

只读定位还发现：起点record捕获后，Host保存循环在异步等待后读取live narration map，可能把后续cue纳入阻塞保存；这些NARRATION_UPDATE又已排在durabilityReady之后保存。下一有限任务用4cue与deferred起点写入验证是否产生重复等待，之后才决定按捕获起点快照保存；本轮不并改该路径。
