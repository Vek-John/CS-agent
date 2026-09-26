# 起点保存失败后的本地恢复（2026-09-27）

## 范围

既有测试分别证明直接SESSION_STARTED可写入IndexedDB及不可用时内存降级；最近的保存超时测试则stub了本地persistStart。此次只补它们之间的实际链路：首批Narration资料库写入失败→真实起点结算/激活→BrowserSessionRecoveryRuntime→新Runtime BOOT。

IndexedDB持久化的是SessionRecoveryRecord，包括冻结路线、稳定边界和buildStage3NarrationSummary，不是完整Analysis或原始Narration资料库备份。摘要有每字段240字、8引用等边界，超限整字段省略；恢复应按实际记录解释，不承诺完整原文。

## 证据

两条组合用例首次通过。使用单cue实际Adapter/Narration/保存seam，首Narration API返回500后仅有Analysis/Candidate/Plan/Narration四个artifact尝试、Recovery/head零次。真实settle→activatePreparedCoachingSession→BrowserSessionRecoveryRuntime SESSION_STARTED确认本地record并mount一次。

独立fake-indexeddb可用时，新Runtime BOOT为DORMANT，保持同一record/身份/冻结plan/ROUTE_START/ready摘要；restoreRecoveryArtifacts回到INTRO、原起点、无已消费/揭示cue，逐字段等于record实际summary。错误Demo身份被拒且原记录保留；BOOT/restore没有重新分析、生成讲解或新增HTTP。

IDB不可用时，本次DEGRADED但仍mount，同一runtime有内存record；新Runtime BOOT的record与recoveryId为null，提示“刷新后不能恢复”。不因此宣称SQLite历史已持久化，也不模拟整个桌面重启。

partial_revision_restore默认配置仅新增组合测试；root审阅真实代码/日志并统一运行相关检查。数据库名字独有，finally deleteDatabase通过versionchange关闭连接；未修改生产代码、未操作用户库/浏览器/模型。阶段日志`.local-data/failed-start-local-recovery/tests.txt`。

`pnpm exec vitest run apps/web/lib/recovery/failed-start-local-recovery.test.ts apps/web/lib/recovery/session-recovery-runtime.test.ts apps/web/lib/recovery/cs2d-session-recovery.test.ts apps/web/lib/review-history/prepared-start-persistence.test.ts`：4文件85项通过；`pnpm typecheck`与`pnpm build`通过。

尚未覆盖Host接收REPLAY_READY/PLAYER_SELECTED再接回真实Viewer的完整链路。特别是MANAGED_LIBRARY选择分支会调用createForPlayer；下一任务先核实本地恢复的自动选择是否走到该分支以及是否符合恢复语义，再决定是否修复。这里的BOOT/restore无新分析调用，不等于真实重新选择Demo无需解析。
