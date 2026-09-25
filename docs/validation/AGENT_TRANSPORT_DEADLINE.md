# Agent请求与正文读取共用等待上限

2026-09-26，基线7e1861b（产品6bc126b）。本轮只修改Agent客户端传输和复用的窄期限函数；不改Graph、Controller队列、事件schema、服务器执行或checkpoint/Memory。

后续[checkpoint镜像归属与保存期限更新](CHECKPOINT_MIRROR_OWNERSHIP.md)已针对默认镜像中的两项HTTP保存增加期限；本记录保留当时不覆盖持久化的边界。

## A1 真实入口复现

新`coach-agent-transport.test.ts`最初通过真实dispatchCoachAgentEvent和Stage3Controller.completeSession→dispatchSerial复现3红：fetch永不返回、headers成功但response.json永不返回、前一个请求挂起后第二个请求无法发出。Fake clock前进20秒后Promise仍未结算；没有用一个新helper的自测替代原入口失败。

## A2 预算与实现

| 当前源码事实 | 对客户端期限的含义 |
|---|---|
| Next Agent route使用默认runtime；runtime.ts默认DeterministicPolicyAdapter | 默认本地路线不需要模型等待，但I/O仍可能挂起 |
| graph.ts的Policy节点只在可选能力需要选择时调用一次；types.ts maxPolicyCalls字面1 | 单事件没有本轮新增的循环模型预算；诊断/普通观察/完成不走该模型选择 |
| deepseek-coach-policy.ts的provider预算15,000ms；tools/coach-agent-durable-object.mjs Policy route预算15,000ms | 采用20,000ms客户端等待，容纳一次既有15秒调用与通常路由/body开销；两个嵌套预算不简单相加为30秒 |
| Memory读取有局部250ms保护，但服务器排队/checkpoint没有全程硬期限 | 不能把20秒称为Graph最坏执行时间或服务端取消保证 |

从preparation-transport原fetch+body lifetime小提取`request-json-deadline.ts`。preparation保留20秒、LOCAL_REQUEST_TIMEOUT、原AbortError和JSON异常语义；Agent使用20秒、固定AgentRequestTimeout与中文反馈。HTTP非成功仍不读正文；网络错误原样抛出，JSON解析失败仍为原固定错误，成功仍过原strict schema。

一个计时器从实际网络请求开始，headers到达后不重置。超时先结算owned Promise，再abort transport，防止AbortError掩盖timeout；不合作的fetch或JSON也不能阻止本地退出。成功/失败/取消清理自有timer和父AbortSignal listener，迟到headers不开始读body，迟到正文成功/拒绝均不能复活请求，晚拒绝有catch观察。

`dispatchCoachAgentEvent(event, fetcher?, signal?)`仅增加向后兼容可选第三参。直接取消测试不代表所有Host接管路径已接上主动abort；未传父signal时仍靠原controller token/身份门隔离旧结果，并由网络deadline释放等待。

## A3 实际消费者验证

17项Agent测试＋原8项preparation测试覆盖：

- 挂起fetch和挂起body各自在20秒结算；headers在19,999ms到达时body只余1ms。
- 父取消、预先取消、abort-aware立即拒绝、不合作transport、晚成功/晚拒绝、timer/listener回收。
- 成功真实Graph响应deep equal；原HTTP/JSON/schema/网络错误；序列化event及eventId不增加重试字段。
- 两种挂起均经真实Controller串行入口超时成FAILED，后续已排队请求实际发出并结束；没有新队列。
- 真实Host完成入口`completeStage3SessionWrapUp`→SessionWrapUpPanel SSR，在期限后显示未生成并按已有SESSION_SUMMARY保存一次；重复effect零新增请求，完成按钮不依赖总结成功。
- 默认diagnostics经真实synchronizeDiagnosis请求timeout后调用原runTeachingDiagnosis本地fallback，零教学工具。
- 真正的内存Graph生成合法WAITING_TOOL响应，body延迟至切换/dispose和deadline之后；零工具post、checkpoint mirror或旧状态更新。最初夹具未建立Graph前序OBSERVE，只返回RUNNING；补齐真实route前置后才算此项通过，不把被路线门拒绝的响应算作晚工具隔离证据。

计时器均为fake clock，transport为隔离fake fetch；未调用真实模型或网络。测试不是实际网络耗时基准或真实浏览器验收。

## A4 命令与结果

```sh
pnpm exec vitest run \
  apps/web/lib/coaching/coach-agent-transport.test.ts \
  apps/web/lib/coaching/preparation-transport.test.ts \
  apps/web/lib/coaching/coach-agent-host-adapter.test.ts \
  apps/web/lib/coaching/coach-agent-stage3-host-adapter.test.ts \
  apps/web/lib/coaching/coach-agent-stage3-controller.test.ts \
  apps/web/lib/coaching/coach-agent-stage3-integration.test.ts \
  apps/web/lib/coaching/session-completion-feedback.test.ts \
  apps/web/lib/coaching/session-wrap-up-completion.test.ts \
  apps/web/lib/coaching/deepseek-director.test.ts \
  apps/web/lib/coaching/narrator-contract.test.ts \
  apps/web/lib/coaching/cs2d-route-integration.test.ts
pnpm typecheck
pnpm build
```

11文件169项通过，TypeScript与Next production build通过。默认配置agent_deadline_review独立只读审查共享helper、Agent/preparation接线和Controller直接边界，无must-fix。原Stage2/Stage3成功、失败、身份、取消与6bc126b总结反馈回归保持。

## A5 交付与限制

本轮更新架构、学习记录、持续任务卡并commit/push后释放；自有测试/build退出，无Demo、浏览器服务、用户DB、密钥、真实模型、安装或部署操作。原UI A5未宣称通过。

20秒从网络请求启动计算，不包含dispatchSerial队列中开始前的等待，不覆盖成功响应之后`onAgentResult`/checkpoint mirror或其他持久化Promise。前一网络Promise无限挂起已修；若前一checkpoint mirror自己不settle，后续串行工作仍可能受阻，这不属于已解决范围。

超时只证明客户端未及时取得可信响应，不能证明服务器没有执行、写checkpoint或产生既有副作用。保留原eventId和服务端幂等，零自动retry，不以换eventId重新执行规避未知状态；模型请求预算与Session/Graph完成门不变。
