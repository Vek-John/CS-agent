# 已展示教学点的观察回包确认（2026-09-26）

基线c51a6b0，工作树7f2b；任务presented-cue-ack。子代理因额度错误未产生文件，root核实干净树后独立完成；没有继续重试委派、调用外部模型或碰用户数据。

## 实际复现

真实Graph沿合成路线完成第一cue→USER_TAKEOVER→提前手动看第二cue→返回默认第一cue。第二cue有真实presentedCueBindings，但中间普通段的后台观察尚未到达；此时Controller观察第二cue，Graph返回COMPLETED以及ROUTE_ORDER_MISMATCH、实际cursor仍3。旧Controller却确认到5并mirror。另一个实际Graph回包在controller.reset之后返回，旧实现把新cursor从-1改为5。原3项测试2红1绿。

这验证了后台观察缺段/迟到条件的错误确认，不声称普通无延迟浏览器必然走到该问题，也没有伪造Graph拒绝结果。错误cursor和COMPLETED均由实际runtime返回。

## 修复

仅修改observePresentedCue确认路径：完整identity、已处理eventId、呈现绑定、cursor不早于目标及无工具效果同时成立后才确认，并随后调用checkpoint mirror。失败释放pending并重置预约位置，不把历史fallbackReasons当作本次结果；补齐缺段后同event可真实成功。

已接受但ACK丢失后，重试返回同event回执，即使Graph已走到更后段也确认原观察且不重复呈现。reset使旧派发/回包失效，旧promise finally只有仍拥有映射时才能删除pending，避免删掉新同event请求。没有改Graph schema、顺序门、工具预算、手动访问或持久化结构。

## 验证

- `pnpm exec vitest run apps/web/lib/coaching/presented-cue-ack.test.ts apps/web/lib/coaching/coach-agent-stage3-controller.test.ts`：最初新4+32既有共36通过；新增同event重置竞态后，单独新测试5/5通过。
- `pnpm exec vitest run apps/web/lib/coaching/skip-lifecycle-continuity.test.ts apps/web/lib/coaching/coach-agent-stage3-integration.test.ts libs/coach-agent/src/manual-cue-visit.test.ts`：25通过；本轮去重合计62项。
- `pnpm typecheck`、`pnpm build`：通过。
- 更新一个旧mock正向回包，提供真实协议所需事件回执与绑定，未降低生产确认条件。

无浏览器、网络、模型、真实Demo或用户数据库操作；测试只使用合成路线、内存Graph与可控延迟/丢ACK。有限回执窗口已过期时仍保守不追认；当前不主动修复缺段顺序，后续有限任务核实接入既有observer串行补齐。所有测试/build进程结束。
