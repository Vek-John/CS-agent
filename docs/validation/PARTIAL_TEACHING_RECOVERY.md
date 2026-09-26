# 部分教学提交的恢复保护

2026-09-26，基线c5b6aa4；主控拥有产品/docs，partial_revision_restore默认配置先独占一个失败回归、随后只读终审。

## 真实可复现路径

Controller同步位置→真实Runtime反思C0→保存精确C0 Recovery/head→真实异议C1→HistoryPersistenceController把CUE_CASE/DIAGNOSTIC_RESULT/TRANSFER_RULE/LEARNING_THREAD存入内存artifact依赖→persistTeachingBeforeRuntimeHead的mirror阶段注入stableHead失败。

实际restoreHistoryControlPlane/validateStoredReviewArtifacts选择最新教学artifact与head精确指向的旧Recovery；新Runtime重连确实返回C0。原Host合并表达式使显示revision/attempt从1/1退回0/0并替换thread，新artifact数据本身没删除。最后“不应静默覆盖”的断言红。该复现没有挂载Host/SQLite；mirror失败注入不等于生产mirrorAgentCheckpoint必定向上抛错（它内部会反馈并吞错），但head保持旧值与独立产物先保存的边界真实存在。

## 修复

| Before | After | Why |
| --- | --- | --- |
| 镜像和Host合并前没有比较已保存教学进度 | CUE_PAUSED匹配cue/候选的合法case检查revision与尝试预算 | 不覆盖已存的新补充或重新开放异议 |
| Controller把镜像异常当可降级错误吞掉 | 同步validateResult在镜像try/catch之前，拒绝向Host传播 | 冲突不能被误当作可接受的旧结果 |
| 旧状态可进入READY成功反馈 | 进入既有DEGRADED路径，保留最新展示及原head | 精确恢复点和新保存内容不混成假成功 |

Host捕获当前教学快照，并在接受前复核epoch/generation/runtime/recoveryId。已用过的异议次数保持1，真实Panel SSR仍显示新建议、不再展示异议按钮。正常相等、checkpoint比保存产物新、单纯COMPLETED确认、无相关保存case或其他cue不误判。没有修改Graph/schema/SQL/Memory阈值，也没有把latest Graph当作恢复权威。

## 验证

```sh
pnpm exec vitest run apps/web/lib/recovery/cs2d-session-recovery.test.ts apps/web/lib/recovery/agent-checkpoint-mirror.test.ts apps/web/lib/coaching/coach-agent-stage3-controller.test.ts apps/web/lib/coaching/session-completion-feedback.test.ts apps/web/lib/review-history/history-restore-controller.test.ts libs/coach-agent/src/reconnect-replay.test.ts
pnpm typecheck
pnpm build
```

6文件129tests、TypeScript与Web production build通过。随后只强化Panel SSR断言，再跑2条目标正常/部分恢复回归与TS。拒绝时mirror和accept回调均0，原failed head尝试计数不增加、原head不改、新artifact原样保留；Policy/工具0。补充superseded回调拒绝也不会被当mirror错误吞掉。

只读终审无must-fix：Host catch在旧case/thread合并和成功状态之前发生，保存展示保留且异议budget仍1；HANDSHAKE_FAILED保留原record并给DEGRADED。主控最终diff复核。

## 限制

仅当前暂停cue的进度领先保护；缺少checkpoint case、跨cue、同版本内容变化不在门内。拒绝接受发生在Graph dispatch之后，所以Graph自身可能已经写checkpoint；不是零Graph写、自动补交head或恢复最新教练状态。新旧数据均保留，仍需单独设计安全补交已保存Recovery产物的路径。内存依赖/SSR不代表真实DB/完整Host/浏览器验收；无真实Demo/模型/用户数据/服务/安装部署。测试/build进程退出。
