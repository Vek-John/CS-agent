# 历史后台请求等待上限

2026-09-26，基线f772ba9，7f2b / codex/jev-decision-assessment。

## 验收

A1通过：原list/status fetch在20秒后仍pending，状态悬挂还阻止下一步刷新，共3红；改动后全部转绿。

A2通过：两类fetch/body共用20秒，非合作transport也结算并abort；晚headers不读body、晚body不发布，无自动retry、timer归零。实际settlePreparedCoachingStart→API.markFailed→refreshHistoryPage/API.list，Session立即启动；status超时后仅一次GET，GET超时后loading=false，既有保存警告保持，没有重复activate。

A3通过：搜索/cursor、摘要progress/字段映射、HTTP code与PATCH body/void ACK保持；full detail仍沿原生命周期。既有checkpoint和teaching timeout分类回归通过。

A4通过：6文件66tests，TypeScript、production Web build（仅原Node SQLite experimental warning）。

```sh
pnpm exec vitest run apps/web/lib/review-history/history-bookkeeping-deadline.test.ts apps/web/lib/review-history/api.test.ts apps/web/lib/review-history/checkpoint-save-api.test.ts apps/web/lib/review-history/teaching-save-deadline.test.ts apps/web/lib/review-history/refresh-history-page.test.ts apps/web/lib/coaching/cs2d-route-integration.test.ts
pnpm typecheck
pnpm build
```

A5通过：主控全部实现与真实diff复核；revision_semantics_review默认配置3分钟只读窄审无must-fix并RELEASE，未启动其他任务/服务。架构/学习/任务板同步，测试/build退出。

## 限制与后继

验证基于fake transport与生产模块，不冒称真实网络/浏览器或用户DB。单请求20秒，状态和列表均超时可合计40秒，Session无需等待。abort仅尽力取消，不证明服务器未写；不新增自动重试、大数据deadline或旧请求立即取消机制。

无用户Demo/DB/Memory/密钥、模型、服务或安装部署操作，原UI A5独立待验。下一项核实旧分页响应混入新搜索结果的已知接线缺口。
