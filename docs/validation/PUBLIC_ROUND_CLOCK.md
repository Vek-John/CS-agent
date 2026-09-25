# 决策时公开回合时钟（2026-09-25）

基线2f7ff61。本轮把可靠的正常回合时钟从已有parser接入DecisionSnapshot、公开事实和现有CoachingPackage；不新增UI，不调用模型，不改变教学适用性门。

## 来源与计算

- source2-demo 0.5.4的`Context.tick()`是Demo command时间；`net_tick()`来自CNetMsgTick，两者不能混用。数据在`on_tick_end`采样，在当次Demo tick内所有实体/网络消息处理后附到同tick的已有frame。服务器tick只留在Replay拥有进程作计算。
- `CCSGameRulesProxy.m_pGameRules.m_iRoundTime`为不含冻结的回合秒数；[demoinfocs源码](https://github.com/markus-wa/demoinfocs-golang/blob/master/pkg/demoinfocs/game_state.go#L300-L312)对此有明确说明。`m_fRoundStartTime`为浮点游戏时间，source2-demo将GameTime_t解为Float32；[CounterStrikeSharp字段定义](https://docs.cssharp.dev/api/CounterStrikeSharp.API.Core.CCSGameRules.html)提供对应字段。
- 服务器当前游戏时间使用真实`CSvcMsgServerInfo.tick_interval × netTick`，依据[Server API](https://docs.cssharp.dev/api/CounterStrikeSharp.API.Server.html)及[ServerInfo间隔读取](https://github.com/markus-wa/demoinfocs-golang/blob/master/pkg/demoinfocs/net_messages.go#L36-L46)。仅在本次netTick与Demo tick增量一致、值有效时使用；未初始化、缺失、倒退或跳变的采样不计算。
- 正常live候选公式为`duration − (serverTick × interval − roundStartTime)`，不使用最终回合长度、winner、decidedTick/endTick，也不默认115秒。本次115是实际字段值，不是代码常量。
- 公开的只有派生约秒事实。精确服务器起点、server tick、暂停计数等并非玩家知识，不进入模型或教学包。约秒向上取整，正的不足1秒明确说不足1秒；不把无效/过期计算压成0秒，不声称复刻HUD取整。

## 有效性与兼容

Frame增加可选`clock`来源样本，缺字段保持null；旧Replay无字段仍能解析、分析和恢复。相同frame canonical tick和样本tick必须匹配，不能晚于decisionTick，不能早于当前冻结窗口；`roundsPlayed`必须匹配当前回合，采样年龄不超过半秒，不对当前tick外推。缺少可靠时钟的旧记录不再借最终`decidedTick`推断公开clock phase，而是UNKNOWN。

仅明确正常live、未植包、未暂停且无暂停历史的有效字段算剩余秒。freeze保留FREEZE但无剩余秒，warmup/未知阶段未知，已结束由当时GameRules win status确认而非未来结果。植包事件即使在frame和decision之间发生，也会使普通回合时钟失效，不推算C4。

目前没有可靠的一般暂停补偿依据：[CGameRules](https://docs.cssharp.dev/api/CounterStrikeSharp.API.Core.CGameRules.html)公开暂停计数字段，但不说明应如何补偿此公式。parser只要见到暂停或无法确认暂停字段/计数，就在该次Demo剩余部分保守禁用时钟；暂停后、即使回合重置也不猜补偿。未植包正常时钟也不能使`objectiveAllowsDelay`变为APPLICABLE；缺目标、路线、LOS或接触信息仍UNVERIFIABLE。RETURN_AND_FIRE专业判断门未改变。

## 真实样本与消费证据

使用已有约60.6 MB test_demo.dem、Dog，原文件只读。总共两次有明确目的的有界读取：A1独立native流式字段探针一次；完成源码修改后A4在单一Node/WASM进程中一次解析并直接消费。没有在同一消费链里重复解析，没有导出Replay/frames或复制到主控；各步骤只输出小摘要。单次解析设120秒超时。

| 项目 | 实际结果 |
|---|---|
| 源头native探针 | 1.45秒；57970个tick可读GameRules；仅42条字段采样和36个事件摘要 |
| 时间域实证 | Demo tick3081对应server tick7545，interval0.015625；startTime97.265625、duration115，剩余94.375秒 |
| live起点 | freeze_end的Demo tick1761，对应采样netTick6225；乘interval恰为97.265625 |
| 不可用的替代来源 | round_start事件的timelimit实际为0，未使用 |
| 最终WASM消费 | 解析6185ms，解析至教学包6351ms；9回合7239帧，全部有可选clock来源样本 |
| 有效决策快照 | 44个候选中38个有正常回合剩余秒 |
| 现有教学包 | 4个cue中3个含约秒事实：decisionTick19426约77秒、31179约63秒、44507约54秒 |
| 教学边界 | 这3个包均INSUFFICIENT_EVIDENCE，objectiveAllowsDelay均UNVERIFIABLE；原始网络时钟字段不在包中 |
| 历史兼容 | 最终bundle序列化/反序列化后直接构建上述教学包通过；旧无clock记录由回归覆盖 |

这些tick来自真实Demo，不是视频时间；测试文件的周边场景和边界改写是合成夹具，不能当实际比赛事实。比例仅是该样本的字段覆盖提升，不是教练判断准确率或模型质量提升。

最终消费脚本可在已构建环境中复用：

```sh
pnpm cs2d:build
pnpm exec tsx tools/validate-public-round-clock.ts <已有Demo路径> <玩家名>
```

脚本在一个进程内保有字节、WASM、Replay、Adapter和教学包，只输出受限摘要；运行方应保留120秒超时。它会验证教学包消费、历史往返、无原始服务器字段泄漏。不是浏览器验收，也不运行CS-Net/远端模型。

## 自动检查及构建

- 148测试通过、1项既有WebGPU保存产物对照因本地缺产物跳过；包括32个clock边界测试、Adapter、Observation、Narration package、Host recovery和patch工具。
- `pnpm typecheck`、`pnpm build`、`pnpm cs2d:typecheck`、`pnpm cs2d:build`通过。
- `cargo test --no-default-features --lib --manifest-path .local-data/upstream/cs2d/packages/parser/Cargo.toml`通过（1个既有Rust测试）；clock计算边界由TS helper测试和实际WASM消费验证，不冒称有额外Rust场景测试。
- `0009-public-round-clock.patch`可用于现有受控checkout增量升级。Viewer构建现在同步构建parser WASM，避免只有Rust源码更新而Worker继续运行旧二进制；因此需要现有Rust wasm32 target和匹配wasm-bindgen工具链，本轮沿用已安装工具，未安装新依赖。

```sh
pnpm exec vitest run libs/cs2d-analysis-adapter/src libs/observation/src libs/review-planner/src/narration-package-builder.test.ts tools/apply-cs2d-host-patch.test.mjs apps/web/lib/recovery
```

## 剩余限制与资源

无真实暂停段的HUD对照，没有实现暂停补偿、C4精确倒计时或任意模式计时；缺/错字段与非一致round index保守unknown。时间只是决策前近邻采样，带采样误差。本轮无UI/桌面实测，没有操作锁屏或原InPrivate窗口，原教学工具暂停A5仍未完成。没有Jev/DeepSeek请求、用户SQLite访问、main合并、部署或安装。

唯一native探针和WASM消费进程均已退出；临时probe源码从上游构建目录移出，所有测试/构建结束后释放代码写入。仅保留本工作树忽略目录的小摘要、日志与源头探针以便追溯。
