# 逐次本人受击证据验证（2026-09-25）

基线65deea8（实现413f15a＋交接），功能分支codex/jev-decision-assessment。已进入真实parser→Adapter→历史往返→CoachingPackage/OutcomePackage→确定性Narration链；没有调用模型或验收浏览器UI。

## 来源与归属

`source2-demo 0.5.4`的`get_by_handle()`只按低14位index查实体，不能独自验证归属。CS2事件pawn值是native handle；SDK维护者的[ToPackedInt](https://github.com/alliedmodders/hl2sdk/blob/cs2/public/entityhandle.h#L126)与[FromPackedInt](https://github.com/alliedmodders/hl2sdk/blob/cs2/game/shared/ehandle.h#L27)说明network packed转换，参见同文件的[native index/serial定义](https://github.com/alliedmodders/hl2sdk/blob/cs2/public/entityhandle.h#L58)。这是SDK维护者实现，非Valve正式wire规范；本轮读取cs2分支并用现有Demo核实。

真实首事件Demo tick3086：userid_pawn为signed -269811578（u32 4025155718），native index134/serial122838；packed16089222对应index134/低10位serial982。事件处理时当前CCSPlayerPawn index134/serial982，唯一controller的m_hPlayerPawn为同一packed值。实现核对当前实体class/index/可见serial与当前controller完整packed绑定，不沿用旧tick-start缓存或按位置猜归属；缺失、无效SteamID、多绑定均null。高位serial未在packed中传输，不宣称全17位验证。

[游戏事件资源镜像](https://github.com/SteamTracking/GameTracking-CS2/blob/master/game/csgo/pak01_dir/resource/mod.gameevents)列出health/armor（剩余值）和dmg_health/dmg_armor（报告值）；[demoinfocs处理](https://github.com/markus-wa/demoinfocs-golang/blob/master/pkg/demoinfocs/game_events.go#L472)及[事件类型](https://github.com/markus-wa/demoinfocs-golang/blob/master/pkg/demoinfocs/events/events.go#L420)区分报告伤害与HealthDamageTaken，存在overkill和同tick等语义问题。因此新流只把字段命名为reported，不声称实际HP损失。

## 实现边界

- 独立可选Round.hurtEvents在原ADR过滤前采集，保留自伤/世界伤/未知受害者；不插入原events，不改变索引引用或原ADR规则。原ADR保持由差异审查确认，本轮没有旧parser实际ADR数值对照。
- 决策仅取本人、严格小于decisionTick、最近10秒最多3条唯一ID，并检查新鲜存活状态/死亡边界。只投影发生事实及sourceRef/tick，未暴露攻击者、坐标、武器、方向或报告伤害数值。
- Outcome仍使用已有reveal到reveal+4秒及round容器截止窗口；同tick不进入决策，致死同tick不猜先后。round容器是freezeStartTick到postEndTick半开区间，不冒充正式endTick。
- Timeline中精确受击覆盖健康采样区间时抑制重复区间事件，并预留旧me编号。HP_CHANGE选点不增加，教学门不放宽。
- Parser hurt-events.v1、Adapter/Observation/Signal 1.7.0、Timeline 1.1.0；缺字段旧Replay仍支持，含1.6.1的旧历史原样恢复。snapshot恢复校验条数/唯一/strict prior/live；10秒窗由有tickRate的生产Adapter保证，不伪称旧snapshot自带tickRate。

## 一次最终WASM与同回放消融

使用已有约60.6MB test_demo.dem和既有选人，只读；单进程持有Replay并直接消费，无bulk导出、数据库访问或重复解析。最终一次WASM解析7247ms，总消费7464ms（包含两次Adapter派生作字段消融），120秒进程上限。时间是本次测量，不是前后性能提升证据。

| 测量 | 结果 |
|---|---|
| 回合/原始hurt | 9 / 264 |
| 受害者解析成功/未知 | 264 / 0，仅此样本 |
| 本人hurt / 原始health=0报告 | 27 / 64（全体） |
| 候选snapshot带prior本人受击 | 23 / 44 |
| 正式cue / 实际消费的CoachingPackage和Narration | 4 / 2 |
| OutcomePackage含受击 | 2 / 4 |
| 同Replay删除hurt流后的对照 | snapshot 0→23；讲解包0→2 |
| 对照候选及路线 | 44候选，cue的candidate ID和decisionTick不变 |
| Timeline区间DAMAGE | 25→3，另有27条精确本人受击；不能把数量相加当“多受伤次数” |
| 历史序列化往返 | 通过，恢复后直接建包 |
| 两个受益cue的判断 | 均INSUFFICIENT_EVIDENCE |

真实decisionTick19426引用19395/19419/19424三个hurt；decisionTick45091引用44514。公开陈述均仅为“决策前已记录到你本人受击；具体伤害来源、方向和实际扣血量尚不能仅凭该事件确认。”引用保存在candidate的DecisionSnapshot，Narration通过既有事实ID消费；未给Fact新增字段。

这证明新增事实已落地并改善该样本的事件定位和教学上下文覆盖，不证明战术建议准确率或模型专业质量提高。消融复用当前实现并删除新增字段，不是旧commit二进制的全面A/B测试。

## 检查及真实读取账目

- 最终相关11个文件182测试通过，1个既有WebGPU保存产物对照因缺本地产物跳过。含13条self-hurt边界/完整教学消费回归、旧版本恢复、Observation、Narration、Host recovery与patch工具。
- Rust parser 3测试通过（2个新增handle归属、1个已有shot）；pnpm typecheck、pnpm build、pnpm cs2d:typecheck、pnpm cs2d:build通过；后者实际重建WASM和Viewer。
- 只读独立复核无阻断项；补齐旧1.6.1版本联合类型和恢复测试。首次误用node --test运行Vitest文件仅为runner错误，改用Vitest后7项patch测试通过，纳入最终182。
- 源头原native全量probe一次约1.13秒，错误直接比较两种handle导致0归属。经协调授权额外首事件诊断时，编译错误后shell误运行旧二进制，产生一次额外全量读取（约0.26秒）；已立即报告。随后改用build check=True，正确首事件诊断约0.9秒即退出。最终一次WASM为第四次文件读取；没有把四次说成“一次总解析”。
- 临时native源码已移出上游bin；native/WASM/tests/build均退出，未开服务/浏览器或调用模型，未触碰用户Demo、SQLite、主main与旧锁屏窗口。原教学演示暂停A5未由本次代码验证关闭。

复用验证（需现有构建，调用方设120秒进程超时）：

```sh
pnpm exec tsx tools/validate-self-hurt.ts <已有Demo路径> <玩家名>
pnpm exec vitest run libs/cs2d-analysis-adapter/src libs/observation/src libs/review-planner/src/narration-package-builder.test.ts libs/review-planner/src/teaching-gates.test.ts apps/web/lib/recovery tools/apply-cs2d-host-patch.test.mjs
```

验证脚本由本次成功消费脚本整理为参数化入口；没有为了整理入口再次读取Demo。它要求样本确实有被现有cue消费的本人受击，不能用于声称所有Demo都会有此类cue。
