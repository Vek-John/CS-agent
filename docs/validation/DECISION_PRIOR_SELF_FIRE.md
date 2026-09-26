# 决策前本人开火的当前情况消费

2026-09-27，基线 `f8d805d`；实际7f2b工作树，功能分支 `codex/jev-decision-assessment`。

## 用户可见变化

符合来源与时间条件时，当前情况在原自身状态后补充一句“决策前近期记录到本人开火。”原有比分、时钟或人数等前三条内容不因此被挤掉。它只说明自身动作已发生，不表示已知敌人位置、命中、再次接敌、战术意图或选择正确/错误。

此前合成回合中decision1400前shot1392已产生Timeline WEAPON_FIRE，但实际Adapter→CoachingPackage→确定性Narrator的正文与未知射手对照完全相同。修改后该句出现一次，未知射手仍没有；future1404仍只可能进入原处理窗口动作事实，不能回流到决策前。所有时间仅为合成输入，不冒充真实Demo tick。

## 实现边界

- `DecisionSnapshot.selfFireEvents` 可选，最多三条，保存DEMO_WEAPON_FIRE/sourceRef/tick，原parser数组索引可追溯，未知射手不猜。
- 仅同live回合、决策前10秒内、严格早于decision且不晚于新鲜存活状态sampledAtTick；kill、dead/零生命frame、致死hurt报告已发生或其时间不可用时拒绝。
- 说明与来源附到原state DECISION_CONTEXT，原available_at_tick不变；没有新增PLAYER_ACTION、教学资格、工具资格、候选或窗口。原资源/库存校验要求sample与fact时间一致，因而样本后/决策前射击暂不合并。
- Adapter/signals版本1.12；1.11及既有历史版本仍可读，旧无字段产物不回填。Narrator选句规则及共享专业判断门未改。

## 证据与验收

A1/A2摘要留在 `.local-data/decision-prior-self-fire/a1.jsonl`、`a2.jsonl`。独立只读审查核对原始引用、状态绑定、生产Narrator消费与版本兼容，无已确认must-fix；主控另读实际新增测试和diff。20新增、7文件170tests通过；root类型修正后再验资源/库存/新链3文件86tests通过（含20新增），两端TypeScript与production build均通过。首次类型失败是严格shape后tick需显式number收窄、测试optional数组和kill字段不完整；均已修复，未放宽校验。

新增回归覆盖实际正文和原信息保留、原cue/窗口/分数/assessment/actionRefs稳定、未知/他人/同tick/未来/非整数/过期、sample后shot拒绝、三类死亡与非法死亡时间、来源有界、严格持久形状、新旧JSON读取及库存资源引用。旧win-rate重叠用例仅排除授权新增的一句后仍深比较原cue和segments。曾直接删字段构造旧产物被既有内容身份校验拒绝，改用既有工厂生成旧形状，未放松校验。

未重新解析真实Demo、调用模型或执行GUI；本轮证明小场景的事实消费和兼容性，不声称提升专业判断或已完成原生桌面A5。

下一有限目标 `narration-clock-coverage`：当前Narrator固定前三条事实，而合法公开时钟排在人身状态/受击/人数/比分之后。先用完整人数与本人受击的小场景核实已知时钟是否从当前情况正文丢失；有具体缺口才讨论有界选择方案，不重跑旧clock Parser测试或改变时钟可知性门。
