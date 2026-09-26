# 总结在自由回看期间完成（2026-09-26）

## 复现与修复

在实际Controller的COMPLETE_SESSION dispatch等待期间，通过现有HostPlaybackControl执行时间轴pause→seek，将播放控制切到用户。原Host的isCurrent还要求非takeover，于是Graph完成后总结没有发布或保存；再次调用也被Controller终结去重挡住。抽取原谓词后单例明确复现：期望一次onResult，实际零次。

Host现在使用createSessionWrapUpGuard捕获原owner；只移除播放takeover约束，并允许终结effect在已接管时启动。其余原条件保留：session/run、generation、history open epoch、persistence引用、reviewId/revisionId以及WRAP_UP/COMPLETED。正常完成释放run的兼容逻辑继续复用。活动cue与工具取消、Graph自身checkpoint镜像不改；总结本身不控制播放，不把用户拉回默认路线。

## 验收

- A1通过：同一实际Controller/Adapter、完成seam与Host当前消费的guard，延迟Graph响应；时间轴seek之后总结发布和artifact保存各一次，第二次结束调用无重复dispatch。红例转绿。
- A2通过：generation/session/run/phase/history epoch/persistence/review/revision任一变化，晚Graph结果均不发布/写入；晚总结返回时换历史也拒绝。
- A3通过：在总结边界再做deferred延迟，进入COMPLETED并释放临时run、自由查看仍接收同owner结果；保存失败仅在原owner显示错误，换历史不把旧错误带过去。
- A4通过：13新增测试＋47相关测试，共60；TypeScript和production Web build通过。partial_revision_restore默认配置独立窄审当前实际diff，无must-fix，主控核实结果。

## 测试边界与学习

真实代码包括Controller/Adapter事件去重、Host播放控制、完成/保存seam和抽取后Host实际使用的归属闭包；Graph返回为合法身份的受控fixture，artifact保存为spy，后段总结延迟也为mock。默认总结是本地确定性投影，没有声称真实模型/网络/SQLite/完整React或Viewer验收，也未读取用户Demo/数据库。

初次fixture的routeFingerprint为空，Controller在dispatch前正确拒绝，测试等待信号超时；两次后立即改为单例阶段检查，定位空routeHash，使用真实Adapter产出有效路线后才得到产品红例。未放宽产品输入门或继续叠加等待。最终测试进程已退出。

本轮解决总结发布/保存被takeover丢弃，不声称所有终结checkpoint镜像路径已改进。下一有限目标：已看到SESSION_SUMMARY保存失败仅显示错误，而现有RuntimeHeadRetry不覆盖它；核实能否重试同一已生成结果，避免重新运行Graph/总结或写入另一历史。
