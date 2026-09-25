# 封闭讲解本地完成

2026-09-25，基线 `33b43e8`。范围是 Narrator 准备请求；不改 Director/Jev、教学内容、结果门、用户配置或历史产物。

## 成本复现与等价

`narration-fast-path.test.ts` 使用真实 Adapter 小 fixture→Compiler→CoachingPackage/OutcomePackage→生产 context。假 Provider 逐字复制当前 approvedNarration，经既有 Provider validator、refs 映射、领域 validator 后，五字段结果与领域 `deterministicNarrationBundle` **deepEqual**，包括文本、引用、置信度和限制。

原客户端仍调用 `/api/coaching/narrate`，后者假链再请求一次 Provider；无响应 transport 则保持等待。先有 **2 红 / 1 绿**，分别证明多余请求和等待确实存在，不是仅根据源码估计收益。

| 场景 | 优化前 | 优化后 |
|---|---|---|
| 当前单 cue 封闭 context | 1 次客户端 HTTP + 1 次 Provider 复制调用 | 二者均 0 |
| 假 transport 永不响应 | 尚未结算，等待期限/取消 | 不调用 transport，推进 0 ms 虚拟时钟即完成，计时器 0 |
| 三 cue 生产准备流程 | 旧逐 cue 请求路径保留为兼容回归 | 首两 cue 后 READY_TO_START，再完成第三 cue；Narrator 网络 0 |
| 已保存讲解复用 | 既有身份/就绪复用 | prepareNarration 0 次，旧正文不重写 |

这些是调用计数与可控等待实验，不是实测互联网延迟、费用或整场启动时间。没有调用真实模型、读取 Demo 或凭证。

## 实现与信任边界

- 当前 context 有 approvedNarration 字段时，从原始领域两份包重新 build；忽略 supplied approved 文本、request 内容和 aliases。伪造文本、跨字段 refs 或别名无法控制返回内容。
- 原请求/schema/字段/ref/封闭语义校验提取到纯 `narrator-validation.ts`，Provider 与本地路径共用。随后沿原 mapNarrationBundle 和领域 assert；校验逻辑未放宽，客户端不导入 Provider 网络配置。
- 正常返回 `DISABLED / DETERMINISTIC / CLOSED_SEMANTIC_PROJECTION`，复用既有 `FALLBACK` readiness，可开始，不表示准备失败。不伪报 DEEPSEEK 或模型名。
- 独立复核发现超长但领域有效的讲解原来可以 fallback，新 wire 异常若外抛会卡准备。新增 **1 红→绿**修复：只捕获 `NarratorValidationError`，进入原确定性生成＋领域断言，返回 `FALLBACK / DETERMINISTIC / LOCAL_WIRE_VALIDATION_FAILED`。追加实际准备就绪回归。身份、命名空间、无效 refs 与映射后的领域错误继续拒绝。
- 缺 approved 字段的旧 context 仍走原有 HTTP/Provider、20 秒客户端期限、15 秒 Provider 预算、取消及迟到响应机制。相关旧 transport 测试显式去掉字段来覆盖该兼容协议；没有删除 Provider 能力或降低服务器校验。
- 匿名 HTTP 服务端缺少完整领域材料，保留原行为；不能仅凭匿名调用方声称 approved 就本地信任返回。直接调用该兼容入口仍可能调用 Provider，零调用结论仅适用于新的当前客户端路径。

## 验证

相关 **9 文件、130 tests 通过**：

```sh
pnpm test \
  apps/web/lib/coaching/narration-fast-path.test.ts \
  apps/web/lib/coaching/narrator-contract.test.ts \
  apps/web/lib/coaching/deepseek-narrator.test.ts \
  apps/web/lib/coaching/narration-real-bundle.integration.test.ts \
  apps/web/app/api/coaching/narrate/route.test.ts \
  apps/web/lib/coaching/cs2d-route-integration.test.ts \
  apps/web/lib/coaching/jev-decision-assessment.test.ts \
  apps/web/lib/recovery/cs2d-session-recovery.test.ts \
  libs/review-planner/src/narration-package-builder.test.ts
pnpm typecheck
pnpm build
```

TypeScript 与 production build 均通过。测试覆盖实际首窗/后续编排、五字段等价、恶意 approved/别名、身份/namespace/ref 拒绝、预取消 AbortError/0请求、完成后 generation 取消零发布、旧 HTTP 非法输入及超时/迟到处理、超长本地回退、保存/恢复复用与原 Jev/Narrator 接线。只用 fixture、fake transport、内存准备状态，未访问用户数据库或 Memory。

`narration_fast_path_review` 默认配置，最多 5 分钟只读审查及 1 分钟闭合；发现并闭合上述长讲解兼容问题，无剩余 must-fix。所有测试/构建进程退出，无服务、浏览器或需要清理的用户数据。

## 限制与下一步

当前协议没有开放自由改写能力，因此省掉复制请求不改变可接受内容；未来若提供可验证的生成协议，应明确版本/资格并继续走相应 Provider 路径，不把本次优化扩展为禁止模型生成。

未测真实网络、浏览器/桌面 UI 或端到端 Demo 准备耗时，原工具暂停 A5 保持独立未验。不宣称教学判断准确率提升。剩余准备等待可能来自 Director 等阶段；源码目前仅在 0 个合法候选时跳过 Director。下一独立工作可先用单候选 fixture 核实是否仍存在真实选择自由，只有证明语义等价才考虑省请求，不先删除 Director 决策能力。
