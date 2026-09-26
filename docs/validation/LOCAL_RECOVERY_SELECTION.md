# 本地恢复选择与历史创建（2026-09-27）

## 实际入口

本地Runtime匹配重新加载的Demo后产生SELECT_PLAYER；Host的PLAYER_SELECTED原managed分支会直接createForPlayer，而真正的ANALYSIS_READY恢复入口在后面。managed导入去重处理并不总会打开既有历史，因此该冲突可达。

本地恢复选择改为接续原路线，不自动新建空Review。恢复导入同步捕获恢复意图，跳过“打开最近/创建新复盘”的去重弹窗；普通新导入仍保持原选择。已有SQLite历史恢复与重新分析维持原分支；这里不把IDB摘要迁移成完整资料库备份，不删除旧记录。

创建结果使用稳定的Replay/player/open epoch/Controller及其内部ownership代次，避免旧成功或失败污染另一复盘；不使用正常分析也会更新的准备generation，避免误丢正常结果。

## 验证

实际隔离IndexedDB中新Runtime BOOT→REPLAY_READY→SELECT_PLAYER，原忽略recoveryPending的副作用seam创建1条Review；加入门后为0。14项新增回归覆盖普通managed1次、不匹配恢复仍pending、已有历史/非managed、正常analysis generation变化，以及Demo/player/history切换、同ID重新选择时的迟到成功/失败。未把未确认请求说成服务端取消。

`pnpm exec vitest run apps/web/lib/review-history/player-selection-history.test.ts apps/web/lib/review-history/history-persistence-controller.test.ts apps/web/lib/recovery/failed-start-local-recovery.test.ts apps/web/lib/recovery/session-recovery-runtime.test.ts`：4文件79项通过；`pnpm typecheck`与`pnpm build`通过。

partial_revision_restore默认配置独占2个新module/test，root接Host并集中复查实际diff/日志；日志`.local-data/local-recovery-selection/`。隔离IndexedDB已删除/关闭，全部进程退出。原Host入口及去重弹窗guard由主控代码复核，未挂载完整Host或执行真实浏览器弹窗；未操作用户SQLite，不自动将IDB摘要迁移成完整历史。
