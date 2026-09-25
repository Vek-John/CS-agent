# 处理窗口内本人开火事实

2026-09-25；基线 `f747eca`。范围仅已有 DEATH / HP_CHANGE 候选的动作事实传递；Parser、Viewer、路线窗口、模型和专业判断门未改。证据：[匿名机器摘要](WINDOW_SELF_FIRE_EVIDENCE.json)。

## 确证与修复

两个合成 Replay 分别包含 DEATH / HP_CHANGE、处理窗口 1400–1408，以及独立归属本人的 shot 1404。实际 Adapter→Compiler→CoachingPackage→确定性 Narrator 原本均缺动作事实，测试 **2 红 / 3 对照绿**。没有 shot、他人或未知 actor 的对照继续为空。这里的合成时间不代表 Demo 测量。

修复新增 `windowSelfFire`：仅 `decision < shot < reveal`，同回合、明确本人、决策时存活，且严格早于已知 kill / dead 或 health=0 样本 / 致死 hurt。遇到本人死亡但时间无效则拒绝，不能推定同 tick 先后。最多一条事实和最早三个原事件 refs；只说明记录本人开火，未知目标、命中、接触和意图。现有 RETURN_AND_FIRE / UTILITY / BOMB 不重复添加。

为保持既有选点，事实带可选 `presentationOnly: true`：排除 Director 包及确定性选点的动作加分，排除专业过程、结构化决策动作和不可回撤动作推断；正常进入 Narrator、Stage3 事实回看及诊断严格传输。旧字段缺省动作保持旧语义，不改写历史。版本为 Adapter/signals 1.8.0、CandidateGenerator 2.4.0，仍可读取旧 Adapter 1.7.0。

## 唯一真实解析与消融

原授权 `test_demo.dem`、原选手 Dog，读取/解析各 **1 次**。WASM 参数 8，解析 **6395 ms**，总计 **6795 ms**，外部 Python supervisor 对整个 Node 进程组设 **120 秒**期限；退出码 0。0 fetch、无模型。Replay、帧和身份一直留在唯一进程，不导出 bulk。

44 个候选中，**10 个原有窗口**补上动作事实，实际引用 **9 个不同 shot 事件**。第 4 回合一条 shot 同时被重叠 DEATH / HP_CHANGE 候选引用，因此不能把十条候选事实称为十次开火。

| 回合 | 候选类型 | 原 decision–reveal | 本人 shot tick | 原事件引用 | 正式 cue |
|---|---|---|---:|---|---|
| 1 | HP_CHANGE | 4505–4513 | 4510 | cs2d-r1-event-57 | 未选 |
| 2 | HP_CHANGE | 12161–12169 | 12162 | cs2d-r2-event-62 | 未选 |
| 3 | HP_CHANGE | 19386–19394 | 19387 | cs2d-r3-event-64 | 未选 |
| 3 | HP_CHANGE | 19394–19402 | 19400 | cs2d-r3-event-69 | 未选 |
| 3 | HP_CHANGE | 19418–19426 | 19419 | cs2d-r3-event-76 | 未选 |
| 4 | DEATH | 24723–24730 | 24728 | cs2d-r4-event-74 | 未选 |
| 4 | HP_CHANGE | 24723–24731 | 24728 | cs2d-r4-event-74 | 未选 |
| 5 | HP_CHANGE | 31179–31187 | 31185 | cs2d-r5-event-232 | c2 |
| 7 | HP_CHANGE | 44507–44515 | 44510 | cs2d-r7-event-99 | c3 |
| 8 | HP_CHANGE | 49019–49027 | 49021 | cs2d-r8-event-69 | 未选 |

消融从同一已派生 CandidateSet **只移除 presentationOnly 动作事实**，保留相同 Replay、观察、候选和窗口，再 assemble / Compiler。不是第二次解析，也不是旧二进制性能比较。断言通过：

- 全部候选 assessment 相同；候选实体 ID、decision/reveal/outcome 字段直接保留。
- Director 包候选摘要逐项相同，包括排序。
- 全路线 segment ID/模式/时间/cueIds、正式 cue ID/候选/窗口/assessment/focus 相同。
- 消融前后四个正式 cue 都经生产 Session 的 START、SKIP_SEGMENT、TICK、ADVANCE_SEGMENT 到达结果门；末端前 LOCKED，抵达末端后 COMPLETE。

| Cue | 回合 | decision / reveal / end | 移除新事实时自然 effect | 保留新事实时自然 effect | Host 实际生成命令 |
|---|---:|---|---:|---:|---|
| c1 | 3 | 19426 / 19429 / 19685 | 0 | 0 | 无动作事实，FINISH |
| c2 | 5 | 31179 / 31187 / 31443 | 0 | 1 | REPLAY_CUE_SLOW，31115–31443，0.5× |
| c3 | 7 | 44507 / 44515 / 44771 | 0 | 1 | REPLAY_CUE_SLOW，44443–44771，0.5× |
| c4 | 7 | 45091 / 45092 / 45348 | 0 | 0 | 无动作事实，FINISH |

c2/c3 的新事实由实际 CoachingPackage 和确定性 Narrator 引用，经 Host 既有 ACTION_FACT_REPLAY 门与默认内存 Graph 自然产生 callId/effect，Host 绑定窗口并抑制重复。没有指定工具/Policy/callId。所有 assessment 仍为 INSUFFICIENT_EVIDENCE，未得出决策有错。

## 检查与独立复核

- 最终相关 Vitest：**326 通过，1 跳过**（既有 WebGPU 产物对照缺本地产物）；覆盖 Adapter、候选/Compiler/Narrator/专业门、诊断、Stage3 主链及恢复。额外重跑两个集成用例确认 strict event/envelope 保留 presentationOnly，均通过，不另计独立用例。
- `pnpm typecheck`、`pnpm build` 通过；脚本以临时 extends tsconfig.base 配置单独 `tsc --project .local-data/window-self-fire/tsconfig.json` 通过。
- `pnpm exec tsx tools/validate-window-self-fire.ts --smoke` 先验证同一候选消融自然 effect 0→1，以及 route、Director packet、assessment 不变，才运行真实模式 `<existing.dem> Dog`。复用前轮 `consumeRoute`，将旧脚本改为只在 CLI 入口读取 Demo、按需加载 WASM，导入 helper 无解析/网络副作用。
- `window_fire_boundary_review` 默认配置、限时只读审查发现本人死亡 frame/hurt 的非法 tick 被跳过，**3 红→绿**修复，1 分钟闭合无剩余 must-fix。代理曾独立运行 22 个局部用例，无额外 Demo/模型/服务或文件写入。
- 无 Parser/Viewer 源码变更，未重建；未安装、发布、部署或合并 main。所有本轮解析、测试和构建进程退出。

## 精确限制与下一步

本轮真实路线使用规则 Director/确定性 Narrator，无 CS-Net 或模型，不等于旧 UI Director 路线。进度和工具 ACK 是无界面模拟；没有验证真实渲染、暂停≥12秒/续播、seek、重连，不关闭原 A5。Session 已完成，Graph 只验证各 cue 与前置 observer，不声称 Graph 尾段整场闭合。

狭窄窗口外的 shot 不补入；没有合法独立动作的 cue 保持 FINISH。未新增战术语义、未证明模型判断质量或用户学习效果提高。下一项可独立用假 provider 检查生成式 Narrator 在收到 presentationOnly 开火事实时，是否仍拒绝扩写成命中、再次接敌或决策错误；本轮只验证确定性 Narrator，不据此自动调用模型或重读 Demo。
