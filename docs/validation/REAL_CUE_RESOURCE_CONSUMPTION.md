# 真实教学点的资源与未知说明（2026-09-25）

基线43746ce（41799f6＋交接）。当前9回合Demo生成44候选、4个正式cue，均经过生产Host投影、本地确定性诊断、compact事件/remote envelope序列化后的确定性消费，以及隔离内存保存往返/恢复。发现并窄修一处已知正人数的错误未知文案。逐cue机器摘要见[JSON证据](REAL_CUE_RESOURCE_CONSUMPTION.json)。

**每cue的RISK（OTHER）与TRADE均为人工测试探针，不代表用户真实意图、模型判断或实际界面交互。** 未写入用户数据库或Memory，也未改变真实路线/cue/阈值。

## 真实正式cue结果

四个决策tick均来自本次Demo解析，每个源sample与snapshot tick等于decisionTick，age=0，阈值32tick，且属于cue绑定的同一回合。

| 正式cue | 回合 / decisionTick | HP / 甲 / 头盔 | 存款 / 装备价值 | 道具 | 存活队友 | 资源探针背景 |
|---|---|---|---|---|---|---|
| 1 | R3 / 19426 | 5 / 68 / 有 | 4400 / 5600 | 1 | 4 | 受限，血量低 |
| 2 | R5 / 31179 | 20 / 48 / 有 | 2200 / 4100 | 未知 | 0 | 受限，血量低 |
| 3 | R7 / 44507 | 100 / 100 / 有 | **0** / 3450 | 1 | 0 | 受限，既有FORCE经济语境 |
| 4 | R7 / 45091 | 73 / 97 / 有 | 300 / 4500 | 1 | 0 | 未触发原低预算阈值 |

资源诊断status依次PARTIALLY_SUPPORTED、PARTIALLY_SUPPORTED、PARTIALLY_SUPPORTED、SUPPORTED；所有Verdict均INCONCLUSIVE。背景受限或未受限都不是专业对错结论。

第2cue源grenades数组不可用，投影没有utilityCount，也没有生成0颗测量；其20HP、48甲、存款与装备值保留。真实诊断限制明确为“决策时道具数量未知，现有库存信息不足以确认。”这证明此样本中库存未知不会丢失其他资源。四个cue头盔都明确true，没有真实helmet unknown/false；这两类及核心资源不全的UNVERIFIABLE继续仅由fixture验证，不能借本轮宣传覆盖。

资源引用分别是state-3-19426、state-5-31179、state-7-44507、state-7-45091；人数引用分别为fact-cs2d-r3-event-79-alive-counts、fact-cs2d-r5-frame-health-31179-31187-alive-counts、fact-cs2d-r7-frame-health-44507-44515-alive-counts、fact-cs2d-r7-event-122-alive-counts。人数ref中的区间尾tick属于稳定候选ID，不作为该人数的可用时间；本次核对snapshot.sampledAtTick及当前sample均为decisionTick。资源与人数各有来源，没有把结果当作当前数值。

## 确证问题与最小修复

第1cue的decisionRoster已知4名存活队友，TRADE结果却说“还缺少队友是否存活”。这不是补枪能力不足，而是消费者文案没有承认已有事实。

| Before | After | Why |
|---|---|---|
| 已知4名队友仍存活，却询问是否存活 | “当时还有4名存活队友，但仍需确认双方能否看到同一个对手，以及你能否及时接上这次交火。” | 将已知人数和未知接触条件分开 |
| 正人数文字没有使用独立roster引用 | 新文字的结果证据包含该roster refs | 新事实断言有明确来源 |

使用现有统一roster selector，保持新优先/legacy兼容。status仍UNVERIFIABLE、Verdict仍INCONCLUSIVE；0人数仍CONTRADICTED该补枪条件但Verdict INCONCLUSIVE；未知人数保留原未知说明。没有增加新measurement、判断阈值或UI结构。

由捕获的5HP/68甲/1道具/4队友紧凑投影最小复现，1个生产诊断回归先红后绿；补Host→Graph/API正人数一致性和SSR已知人数文案。修复后只重放已捕获的资源/roster小投影，没有第三次Demo读取。四个TRADE状态与Verdict不变，正人数引用包含原fact-cs2d-r3-event-79-alive-counts。该复放明确不是完整原cue上下文重跑。

## 保存、恢复与调用

AnalysisBundle在同进程序列化/反序列化后，4cue的生产Host输入与往返前相同。每cue两种探针均以local和compact分别诊断，共16次本地确定性调用、0fetch。

8个输出经严格schema及JSON内存往返保持不变；使用现有Session reducer的START、普通SKIP_SEGMENT、TICK与ADVANCE_SEGMENT抵达各真实cue的Outcome COMPLETE暂停边界，再调用restoreCheckpointTeachingCase。恢复前后measurement与Outcome gate相同，新增诊断调用0、fetch0。没有手写伪造PAUSED状态，也没有打开用户历史数据库。

## 解析次数与脚本失败账目

本轮共 **2次** Demo读取：

1. 初始smoke通过Host、诊断、envelope与首fixture cue恢复，但fixture只有自动freeze skip。首次真实解析后，脚本在普通SKIPPING阶段错误发送ADVANCE_SEGMENT而无法推进，尚未输出整组摘要便退出；Replay随子进程释放，未保住逐cue摘要。此为验证脚本缺口，不是产品故障。首读解析耗时未留存。
2. 立即报告协调任务，不自行重读。修复同一harness为SKIP_SEGMENT，smoke增加普通非freeze SKIP并遍历两个既有fixture cue，0fetch、两次恢复成功。协调任务明确追加一次120秒补读授权；第二次解析6079ms，至全部消费/恢复6317ms，成功完成上述4cue证据。

修复脚本后，解析和每cue诊断消费的去身份紧凑证据先写阶段日志，恢复错误独立记录，外层每cue隔离失败，不再因末尾恢复失败丢全部消费结果。没有输出/保存原始Replay、大帧或玩家身份；始终一个解析进程拥有bulk。沿用e90493b构建的现有WASM/Viewer，未重建Parser。

## 命令与交付检查

```sh
pnpm exec tsx tools/validate-real-cue-resources.ts --smoke
# 调用方须设置120秒进程超时；本轮实际执行两次，第二次有追加授权。
pnpm exec tsx tools/validate-real-cue-resources.ts <已有Demo路径> <既有玩家名>
# 仅重放小投影，不读取Demo：
pnpm exec tsx tools/validate-real-cue-resources.ts --replay-summary docs/validation/REAL_CUE_RESOURCE_CONSUMPTION.json
```

生产代码发生了上述窄修复，因此运行7文件180项相关测试（全通过，无跳过）、pnpm typecheck和pnpm build（通过），没有将41799f6基线检查冒充本轮检查。若无这处实际缺陷，本轮原计划只提交工具与证据，不重复177项测试。

检查文件包括Host freshness/projection、teaching diagnosis与Graph、diagnose API、Panel SSR和实际恢复回归。沿用已读取的emil-design-eng/apple-design，仅修文字/引用；布局、键盘与辅助入口未改，SSR不等于浏览器验收。

## 未测与清理

单Demo、确定性规则路线与人工探针不能证明专业准确率、真实用户意图或UI质量。真实4cue不覆盖过期/跨回合拒绝、unknown helmet、known false、known-zero utility；这些保持已通过fixture证据。原工具暂停/锁屏A5未补验。

无模型/Jev、浏览器/服务、用户DB/Memory/密钥、安装发布部署/main合并或完整性/哈希审计。root独占脚本/窄修复与文档，无子代理。两个解析进程、smoke、投影复放、测试和build均退出；忽略目录仅小日志/摘要，保留用户Demo和共享缓存。commit/push后释放写入。
