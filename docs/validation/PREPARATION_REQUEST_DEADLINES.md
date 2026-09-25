# 复盘准备请求期限（2026-09-25）

基线33bdb30。只修改Director/Narrator Host客户端及窄transport helper、Controller取消保护；未改Jev、模型/提示词、引用门、持久化schema或UI。

## 问题与行为

服务端Director/Narrator已有15秒provider期限，但客户端直接await fetch和response.json，不能覆盖本地请求或正文挂起。修复前两个真实client seam各自的fetch/body挂起回归在假时钟20秒后仍未结算：**4失败、13通过**，没有依赖真实网络或任意长sleep。

两个客户端现在共用`requestPreparationJson`，单个请求的fetch和正文合计**20秒**，为服务端15秒预算预留5秒本地路由/正文开销，不重置阶段期限、不自动重试。超时终止Host等待、通知子signal取消，reason准确为`LOCAL_REQUEST_TIMEOUT`；原确定性Director与五字段Narrator fallback及其校验保持原入口。

已取消父signal在候选/资格检查之前退出，零请求；进行中取消立即以AbortError退出，即使transport忽略abort。超时先结算再通知子signal，避免底层AbortError掩盖超时。父取消在客户端await后再确认，不能误变fallback。Controller只对实际已取消/失效generation停止fallback，其他错误仍沿旧处理。

所有已结算路径清理本轮timer和父listener；迟到headers不再开始读正文，迟到JSON及reject被观察但不改变已结算结果、准备事件或route。组合后的signal只保证传播语义，原对象身份不是契约。

## 验证

| 项目 | 结果 |
|---|---|
| 两个client的fetch/body永久挂起 | 20秒虚拟时间内走合法fallback，保留LOCAL_REQUEST_TIMEOUT |
| 共享期限 | headers在19999ms返回，正文在总20000ms即超时，不再另给20秒 |
| 父取消 | 已取消零请求；进行中的非协作fetch/body立即AbortError；无剩余timer/listener |
| 迟到与原行为 | 迟到resolve/reject不发布、无unhandled rejection；成功映射、HTTP_503与坏正文原reason保持 |
| 真实prepare controller＋两个生产client | Director timeout后冻结完整3-cue路线；首两Narrator timeout后READY_TO_START；第三cue继续准备且最终fallback，身份、顺序和覆盖不变 |
| 保存内容恢复 | 实际Recovery dependencies＋Controller复用已存bundle，零fetch、无重复NARRATION_UPDATE |
| 取消与替换旧工作 | 在Director/首两Narrator阶段取消，无READY_TO_START/NARRATION_UPDATE、不调用额外fallback；晚响应不恢复旧generation |
| 最终检查 | 5文件69测试通过，pnpm typecheck与pnpm build通过 |

```sh
pnpm exec vitest run apps/web/lib/coaching/preparation-transport.test.ts apps/web/lib/coaching/deepseek-director.test.ts apps/web/lib/coaching/narrator-contract.test.ts apps/web/lib/coaching/cs2d-route-integration.test.ts apps/web/lib/recovery/cs2d-session-recovery.test.ts
pnpm typecheck
pnpm build
```

集成使用真实Compiler/CoachingPackage/fallback验证和合成数据；服务端模型请求全为假transport。只读独立审查聚焦取消/期限竞态，未发现确定must-fix。TypeScript检查曾拒绝不完整Response测试替身，已改为真实Response实例覆盖json方法；未因此放松类型或生产校验。

## 限制与清理

这是异步transport单请求期限，不是硬实时或端到端启动SLA；Director、assessment、首窗口准备、编译和持久化有各自阶段。客户端通知abort不能强制终止不合作实现内部的工作，但本轮拥有的等待、timer/listener和发布权限会结束。

未运行真实浏览器、Demo或外部模型，不评测教学质量；原工具播放暂停A5及锁屏/Edge窗口不动。没有启动服务、访问用户数据库或安装/部署/发布。所有本轮测试/build进程退出；忽略目录只保留复现与最终检查日志。commit/push后释放本轮写入。
