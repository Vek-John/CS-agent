# 历史分页与搜索归属

2026-09-26，基线fde53ae，7f2b / codex/jev-decision-assessment。

## 验收

- A1通过：生产HistoryPageRequests＋refreshHistoryPage，旧分页延迟成功/错误均不能写新查询列表/cursor/error或结束新请求loading；同query新首屏已完成后旧页也不能追加。
- A2通过：提交query至React effect前旧refresh/query/cursor失效；同步pending拒绝渲染前双击，接受cursor同步推进，旧已消费cursor拒绝。
- A3通过：正常页追加、当前页失败释放pending且保留cursor可手动重试，后台分页保留已有错误/保存警告。Host原id去重表达式源码保持。Sidebar原160ms防抖保持，输入草稿未提交前仍属旧查询。
- A4通过：相关5文件49tests、TypeScript与production Web build；仅原Node SQLite experimental warning。
- A5通过：主控实现/实际diff复核，默认revision_semantics_review独立只读窄审无must-fix，RELEASE。测试/build已退出，架构/学习/任务板同步。

```sh
pnpm exec vitest run apps/web/lib/review-history/history-page-requests.test.ts apps/web/lib/review-history/refresh-history-page.test.ts apps/web/lib/review-history/history-bookkeeping-deadline.test.ts apps/web/components/history/review-history-sidebar.test.ts apps/web/lib/coaching/cs2d-route-integration.test.ts
pnpm typecheck
pnpm build
```

| Before | After | Why |
| --- | --- | --- |
| 旧分页可改新搜索结果 | 首屏/分页共用query与请求归属 | 列表与cursor保持同一查询 |
| 只靠React loading防双击 | 同步pending与已接受cursor检查 | 覆盖渲染前间隙 |
| 旧分页finally关闭loading | 只有当前请求可结束自己的loading | 不误报新查询已结束 |

## 限制与下一项

证据为生产模块与受控异步回调，不是完整Host/真实浏览器。旧Host源代码可确认缺门，本轮未声称旧完整界面红例。没有缓存框架、自动retry或立即取消网络；既有每请求20秒保留。无用户数据/DB/Demo/模型/服务/部署安装，原UI A5独立待验。

下一项：用真实修订诊断核实整场总结是否消费当前结论；目前wrap-up adapter不接CueCase，这是待验证影响的具体接线线索，不预先宣称专业判断改善。
