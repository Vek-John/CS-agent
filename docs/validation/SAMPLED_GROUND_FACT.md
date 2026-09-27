# 采样地面事实完整接线

2026-09-27；任务sampled-ground-fact-contract；基线e1df6ad。先前单Demo覆盖证据见[SAMPLED_GROUND_COVERAGE.md](SAMPLED_GROUND_COVERAGE.md)，本次不再次解析正式Demo。

## 字段流与语义

单一GroundSampleEvidence包含version、source、phase、sampledAtTick、playerId、value。phase固定TICK_START，value为FLAG_SET、FLAG_UNSET或null。旧字段缺省与明确unknown不同，布尔false不是合法替代值。

| 边界 | 生产或接受的语义 |
| --- | --- |
| 受控Parser 0032 | 当前verified pawn、同一帧起始采样；严格flags及辅助地面实体一致才确定；缺失/错型/冲突/非明确存活为null |
| schema / assemble / replay-core | 可选groundEvidence原样携带来源及null；generatedBy包含sampled-ground.v1 |
| Adapter输入与Timeline | 共享shape检查，绑定父玩家与frame tick；ground_evidence保留合法unknown，原始非存活值降为unknown |
| DecisionSnapshot | 本人groundEvidence沿同采样投影，陈旧时父状态不可用；非明确存活不得保留确定值 |
| Agent运行时 | 原PlayerState passthrough不作为新字段校验；显式验证ground_evidence、父player_id/tick和已知值存活条件 |
| 保存与恢复 | serialize/deserialize统一assertValidBundle，检查Timeline与snapshot，历史入口复用此处；不回填旧无字段记录 |
| Fact / Package / Narration | 仅追加到原canonical本人状态事实，保持原采样时间与引用；不成为动作资格或专业评估证据 |
| View / Host | 匹配当前cue、本人新鲜存活状态、snapshot与state值、合法事实及当前完整讲解/引用，资源标签后显示一段采样说明 |

非法结构/source/phase/绑定身份或时间在接收边界拒绝，不能包装成可信unknown。原始采集缺失和非法跨边界输入不是一回事。Adapter/signals升级1.13，保留1.12及既有旧版本解码。

## 可见结果与限制

用户分别看到“最近采样记录到地面接触”“最近采样未记录到地面接触”或“最近采样无法确认地面接触状态”，并限定不代表开火瞬间移动。旧记录不出现新说明；没有新增AIRBORNE、速度、急停、命中或战术结论，也不替换CS-Net特征。

root使用真实Adapter/Narration/View与StatusList的SSR小页，在IAB检查set/unset/null/legacy四种结果，340px内容正常换行，旧记录只保留原chips。这是组件及投影验证，不是完整Host/native A5或真实Demo端到端验收。静态原生段落没有新增动画/透明材质，沿现有样式与减弱偏好路径；tab和loopback服务已清理。

独立接收端审查识别并要求闭合：不能仅在snapshot拒绝dead+known，却让持久Timeline和Agent运行时接受同一值。跨层串联测试需明确三者一致，合法null与absent继续兼容。

集成另用合成同tick样本核实事件顺序：decision晚于sample时，sample同tick的shot原先仍合入状态事实，但实际Parser先发tick-start再处理事件。新生成开火补充收紧到严格早于sample；带新TICK_START来源的snapshot/View同样拒绝等号。旧无字段保存产物仍兼容，不改canonical采样时间或窗口，不重新解析Demo。

下一独立目标 sampled-ground-history-restore：现有库存SQLite重开harness含固定1.11断言，不能直接证明当前1.13新增来源的真实历史打开。复用隔离临时库/API/HistoryRestoreController，核实新known/null与旧无字段记录重开后实际View和禁止重新生成/解析调用；与本轮已完成的JSON恢复验证区分，不操作用户库。

## 最终检查

- 首轮6文件223tests通过；同tick修复后3文件70项受影响复验通过，二者重叠不合计。
- 实际native ground reader/serde 2项、frame-source实际采样11项通过；0031→0032隔离apply/reverse及当前reuse通过。root将replay-core的库存注释移回对应字段，随0032校验reuse成功，未改逻辑。
- Web TypeScript最终复验、Viewer TypeScript、WASM构建、两端production build全部退出0。WASM之后追加的修复仅为Adapter/View，最终两端构建已重做。
- 独立审查的非存活known接收门遗漏已修；root集中核对字段流、源码、native fixture和边界probe。日志.local-data/sampled-ground-fact-contract；执行者RELEASE，所有临时进程已退出。
