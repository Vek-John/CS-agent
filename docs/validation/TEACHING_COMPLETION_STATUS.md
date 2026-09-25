# 教学完成状态文案验证（2026-09-25）

基线fc9b8b4，分支codex/jev-decision-assessment。本轮只修复Stage3的状态呈现，不改变Graph、Session、工具控制、预算、计数或持久化。

| Before | After | Why |
|---|---|---|
| COMPLETED一律显示“教学工具已完成” | 无工具的正常结束显示“无需额外演示” | 讲解结束不证明执行过演示 |
| 工具失败后Graph完成也显示成功 | 显示“额外演示未完成”，仍可读讲解或继续 | 以本次工具结果判断成功 |
| 所有完成态声称证据已回到讲解卡 | 成功显示具体动作，例如“关键动作回放已完成”；未知恢复显示“本段讲解已就绪” | 不承诺未验证的动作 |
| 上一cue/run/visit的呈现字段可能被复用 | 完成提示匹配session/run/cue/generation/visit，错误身份不展示成功或详情 | 不借上次成功推断本次 |

生产入口：`CoachAgentStage3Controller.resumeWithResult → handleAgentResult → completionNotice → stage3StatusView → Cs2dPlaybackHost`。已验证的请求与结果在现有持久化及Graph返回之后形成仅用于显示的完成说明；不是新的生命周期状态或持久化字段。无工具的直接结束必须有本run/cue最近POLICY决策、未选择capability、无pending/lastToolResult且没有当前cue工具历史。历史缺失或只有恢复COMPLETED不能猜测成功，也不推断无需演示。

Host实际渲染`stage3StatusView`的标题、说明和详情开关。原`role=status`、`aria-live=polite`、按钮与键盘行为、布局、动画和透明度规则保持不变。具体成功标题按已执行工具区分：关键动作回放、关键站位、道具轨迹、胜率变化、经济情况。

## 验证

- 4文件84相关测试通过：Controller、真实内存Agent runtime集成、Host adapter及Host播放入口。
- 真实runtime集成覆盖零capability、存在capability但Policy主动FINISH（实际分别0次/1次Policy调用且零工具发送）、成功工具ACK后仅一次完成，并直接断言Host使用的渲染投影。
- 覆盖工具失败但Graph仍COMPLETED、取消/恢复/尚未完成不显示成功，cue/run/session/generation/visit切换、旧成功历史与缺失恢复证据均不泄漏旧成功或详情。
- `pnpm typecheck`与`pnpm build`通过；最终检查以日志及提交时结果为准。
- 初次新增Policy FINISH集成夹具使用了不在schema中的理由码，触发正常fallback；修正为已有`NO_EXTRA_VISUAL_VALUE`后验证真正主动FINISH。严格化未知恢复判断后，修正旧测试缺失必要state的夹具，并用项目支持的数组API替代findLast；没有改变生产schema或编译目标。

```sh
pnpm exec vitest run apps/web/lib/coaching/coach-agent-stage3-controller.test.ts apps/web/lib/coaching/coach-agent-stage3-integration.test.ts apps/web/lib/coaching/coach-agent-stage3-host-adapter.test.ts apps/web/lib/playback/cs2d-playback-host.test.ts
pnpm typecheck
pnpm build
```

## 限制与清理

本轮未启动服务、浏览器、Demo解析或外部模型请求；未运行真实UI或桌面App。上轮教学演示暂停/继续的实际工具A5仍受锁屏阻塞，原goal不由本轮文案测试关闭。测试使用内存runtime及合成夹具，不当作真实Demo演示或模型质量证据。

所有本轮测试/build进程结束后释放代码写入；不合并main、不部署、不安装。上轮未能关闭的InPrivate窗口仍由原接续任务负责。本轮没有操作该窗口。
