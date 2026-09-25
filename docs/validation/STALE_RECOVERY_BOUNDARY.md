# 旧复盘完成与稳定点回调隔离

2026-09-26；基线 `bccf390`（产品 `139eb95`）。仅处理 Host 同一个 effect 中的 SESSION_COMPLETED 与 STABLE_BOUNDARY_REACHED；不改变 Runtime/DB/教学完成门。

## 原行为与修复

先原样抽取两分支派发与回调到 Host 实际使用的 `dispatchHostRecoveryBoundary`。用生产 BrowserSessionRecoveryRuntime、隔离 fake IndexedDB 和延迟返回，在 A 派发后把 Host 显示状态换到 B，再放行 A：

| Before | After | Why |
|---|---|---|
| 完成回调清掉B的identity/checkpoint/record | 旧回调不更新B | 存储返回不代表仍拥有当前UI |
| 稳定点回调将B的record换回A | B的record与提示保留 | Runtime串行队列不能识别Host已切换 |
| 任意完成返回都清身份 | 仅READY/null/null清理 | REJECTED/DEGRADED不是持久删除成功 |

两条基线红例均已转绿。测试使用实际派发/发布入口和运行时，不只测新增predicate。

捕获 generation、history open epoch、effect operation epoch、runtime实例及session/recovery/run。返回和异常再次核对；卸载清runtime、新导入/取消的generation、历史打开epoch、接管/恢复模式、更新操作序号都会拒绝旧写入。显式放弃仅新增一次operation失效，阻止旧完成/稳定点回调；不重写discard自身流程。同身份record快照替换仍合法，不能用对象引用相等阻止正常更新。

失败显示只更新有限status/reason，保留当前record/identity/checkpoint。真实Runtime在不可用IndexedDB下返回DEGRADED，即使结果record为空也不能作为耐久删除证明。捕获的异常原文不会进入显示。既有dedup保留，本轮不加入自动重试。

## 验收

- A1通过：生产Host入口＋真实runtime/fake IDB的两条延迟污染，2红→绿。
- A2通过：generation/history/operation/runtime/session/record/run/takeover/recovering/unmount十类失效，迟到结果不调用清理/accept/失败提示；同身份新record对象可正常放行。
- A3通过：真实current完成一次READY/null/null清理、stable更新checkpoint；真实REJECTED/DEGRADED不清理，异常和晚到异常受控，外来stable结果拒绝；当前failure显示保留记录。完成后保留Session，139eb95总结身份函数仍允许COMPLETED＋临时run清理后的收尾。
- A4通过：`pnpm exec vitest run`五文件共74项（session-recovery-runtime、cs2d-session-recovery、session-wrap-up-completion、session-wrap-up-presentation、history-restore-controller）；`pnpm typecheck`、`pnpm build`通过；`git diff --check`通过。独立只读终审无must-fix，建议强化的同身份快照正例已加入并复验22项runtime/Host子集。
- A5：架构、学习日志、任务板同步；同分支提交推送后释放。

## 边界

沿用emil-design-eng/apple-design的状态反馈要求，无布局、样式、动画或透明度修改。全部测试是隔离内存/fake IDB与SSR，不代表真实浏览器/SQLite磁盘或原工具暂停A5通过。没有Demo解析、模型、Memory、用户DB或密钥操作，无服务/浏览器进程。生产编译只证明Web构建可用。

下一独立候选：相邻 `discardRecovery` 自己的异步返回也直接清identity和accept；先用小fixture证明切换期间/删除拒绝是否污染，再决定窄修。本次只让discard使旧boundary操作失效，未扩为全Host审核。
