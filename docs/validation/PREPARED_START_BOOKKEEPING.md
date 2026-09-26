# 起点收尾不阻挡基础会话激活

2026-09-26，基线5558690，7f2b / codex/jev-decision-assessment。

## 验收与行为

- A1通过：实际生产settlement→activatePreparedCoachingSession→Session，成功列表刷新、失败状态标记、失败列表刷新三种Promise挂起时会话均已挂载，收尾随后完成不重复启动。
- A2通过：durability未结束不激活；结束前换代无反馈/激活，markFailed结束前换代不发后续刷新。刷新helper自身拒绝旧代际/旧请求的成功或错误；旧请求不结束新请求loading。
- A3通过：已确认起点下激活异常只报本地启动异常，不markFailed；收尾错误被观察。后台列表成功/失败均保留已有保存警告，普通手动刷新仍可清旧读取错误。原保存顺序/恢复与route指纹/readiness门保持。
- A4通过：最终4文件73tests、TypeScript、production Web build；仅原Node SQLite experimental warning。
- A5通过：主控实现与diff复核；revision_semantics_review默认配置只读审查指出背景列表失败覆盖保存警告，修复并补回归后确认关闭must-fix。自有测试/build退出，无额外服务。

```sh
pnpm exec vitest run apps/web/lib/coaching/cs2d-route-integration.test.ts apps/web/lib/review-history/history-persistence-controller.test.ts apps/web/lib/recovery/cs2d-session-recovery.test.ts apps/web/lib/review-history/refresh-history-page.test.ts
pnpm typecheck
pnpm build
```

| Before | After | Why |
| --- | --- | --- |
| 等历史列表/失败状态更新后才启动 | 真实保存结果结束后启动，列表与状态独立收尾 | 非必要网络等待不阻挡已备好的会话 |
| 列表失败覆盖保存警告 | 背景刷新保留既有警告 | 不掩盖恢复点未确认状态 |
| 本地启动异常进入保存失败catch | 单独提示会话未启动 | 不错误改写保存状态 |

## 限制

源码证据确认旧Host串行等待；测试验证接线后的生产协调模块和真实Session，不宣称运行了旧完整Host红例、浏览器/iframe或真实网络丢包。首屏刷新ownership受保护，加载更多的通用分页竞态不属于本轮。

没有为后台status/list新增deadline或服务器取消保证；后台长期请求仍可能留待结束，已经与Session激活分离。原本地Recovery持久化仍必须完成。无用户数据/DB/Demo/密钥、模型、安装部署，原UI A5独立待验。下一项核实这两个小DTO请求的有界等待与回收。
