# 已展示节点之前的普通段自动补齐（2026-09-26）

任务presented-cue-order，基线d4b724e，7f2b功能工作树；root独占实现、真实Graph测试和文档。无新委派、网络、模型、Demo、用户库或UI操作。

## 复现与修复

复用实际Graph手动回访→返回默认路线的合成fixture：Graph和本地cursor都位于第一cue，第二cue已经手动展示，二者之间缺一个普通段观察。新增“第一次观察就成功”回归在旧实现失败（新用例1红，既有5绿）。

observePresentedCue现在验证完整冻结plan的目标绑定，并排入普通observer相同的串行队列。纯普通段间隔先沿既有dispatchObserversUntil发送，再预约/发送目标；不会跳过尚未确认的普通段。Controller的普通段派发及回包增加同token保护，重置后不mirror旧补齐结果、旧finally不删除新请求。

初版把所有缺口都补齐，导致reset后同event重试遇到未知教学段而被阻断。最终只主动补齐纯普通段间隔；夹有未知教学段时不制造呈现，而保留Graph依据既有绑定/回执确认或拒绝目标的行为。上一轮的真实拒绝测试现在显式模拟本地ledger比Graph提前一段，仍验证不能误认成功，并保留缺段到达后重试。

## 验证

- `pnpm exec vitest run apps/web/lib/coaching/presented-cue-ack.test.ts apps/web/lib/coaching/coach-agent-stage3-controller.test.ts apps/web/lib/coaching/skip-lifecycle-continuity.test.ts`：55项通过，呈现回包文件共9项，本轮新增4项。
- `pnpm exec vitest run apps/web/lib/coaching/coach-agent-stage3-integration.test.ts libs/coach-agent/src/manual-cue-visit.test.ts`：11项通过；合计66项。
- `pnpm typecheck`、`pnpm build`：通过。
- 新用例：首尝试自动成功；挂起普通观察→重复目标调用→后续普通观察保持单调一次；补齐中reset不发旧目标/不mirror；错误segment或未冻结目标零派发。原丢ACK与reset同event去重保持。

没有实际React点击、浏览器或网络故障实测；没有新增网络重试、Graph协议或工具资格。所有本轮测试/build进程退出。下一项针对已有授权小Demo的整场模块消费，不把其结果等同于UI验收。
