# 保存结果未知时保留已确认历史

2026-09-26，基线19b1a17，7f2b / codex/jev-decision-assessment。

## 验收

- A1通过：真实临时SQLite提交ROUTE_START后模拟调用者不采纳ACK，再调用FAILED。原实现把IN_PROGRESS改FAILED，修复后Review及Revision全部字段/时间保持，原head仍可幂等确认。
- A2通过：旧已确认路线同时有两个PREPARING Revision，失败请求不污染旧Review，也不批量改变新准备版本。
- A3通过：无head仍标FAILED；随后合法首次head到达仍恢复READY/IN_PROGRESS。无artifact绑定、非READY、非active三种记录不误享保护。
- A4通过：相关4文件42tests，TypeScript和production Web build通过；只有原有Node SQLite experimental warning。
- A5通过：主控复核13行DAL保护和2处Host文案，partial_revision_restore实现，revision_semantics_review独立只读审查无must-fix；均默认配置且已RELEASE。临时DB关闭清理，测试/build已退出。

```sh
pnpm exec vitest run libs/review-library/src/library.test.ts 'apps/web/app/api/review-history/[id]/route.test.ts' 'apps/web/app/api/review-history/[id]/runtime-head/route.test.ts' 'apps/web/app/api/review-history/[id]/runtime-head/protocol.test.ts'
pnpm typecheck
pnpm build
```

| Before | After | Why |
| --- | --- | --- |
| 未收到保存确认却称历史已标失败 | “复盘保存未确认；当前会话仍可继续。” | 区分客户端未知与服务端状态 |
| 起点“保存失败” | 起点“保存未确认” | 避免误报确定结果 |

## 限制与后继

测试是实际DAL调用顺序，不是完整Host或真实网络丢包。事务使用现有绑定元数据，不重新验证文件或自动修复历史误标状态；有有效head时未指定Revision的失败请求不替任何新准备版本猜测失败。无迁移、用户DB/Memory/Demo/密钥、模型、服务或安装部署。

原UI A5保持独立待验。下一项：Host失败收尾仍等待markFailed与列表refresh才activateSession，核实并解除不必要的基础播放等待。
