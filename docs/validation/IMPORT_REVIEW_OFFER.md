# 去重提示与选人竞态

2026-09-27；基线03d61ad；root单独实现，分支codex/jev-decision-assessment。

实际顺序：Viewer验证导入后先发DEMO_IMPORT_SUCCEEDED、再REPLAY_READY并开放选人；Host异步等待列表和demoImpact后才确认打开已有复盘。原提示只绑定requestId/history epoch，普通PLAYER_SELECTED都不改变它们。

从Host提取原offer流程，用deferred列表/查询模拟选人交错，原实现4失败/6通过。修复后首次await前捕获独立选人序号，所有副作用检查导入及选人当前性；Host实际PLAYER_SELECTED递增，不使用普通Replay初始化也会变化的分析generation。

- 列表期间选人：不再查询impact，传给刷新函数的归属门失效。
- 查询期间选人：迟到成功不弹窗/打开，失败不报旧错。
- 确认后归属变化：不打开旧记录。
- 未选人：确认打开一次，取消不打开；恢复、非重复Demo及空历史无提示。
- 当前查询失败保留提示，换导入后的失败被拒。

命令：`pnpm exec vitest run apps/web/lib/review-history/import-review-offer.test.ts apps/web/lib/review-history/refresh-history-page.test.ts apps/web/lib/review-history/player-selection-history.test.ts apps/web/lib/playback/cs2d-playback-host.test.ts apps/web/lib/recovery/recovery-demo-picker.test.ts`：5文件64通过（新增10项）。`pnpm typecheck`、`pnpm build`通过。日志在`.local-data/import-review-offer`，原红测试为`red.txt`。

Host接线由主控读diff验证，测试使用真实offer/相关模块与注入回调，不是完整Host/桌面弹窗或真实传输测试。无用户Demo/DB、网络或模型请求，无新服务/浏览器，测试/build进程退出。没有取消服务器查询，仅丢弃失效结果；没有部署安装或关闭原UI A5。
