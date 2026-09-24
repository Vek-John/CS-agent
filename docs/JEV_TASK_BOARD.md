# Jev 决策评估试点任务卡与 Task Board

## 2026-09-24：集成、体验修复与推送

用户授权按模板自主推进、安排子任务并 push 已验证进展；审查集中在实际功能与教学行为，不进行额外完整性或哈希审计。主控接管原隔离工作树，分支为 `codex/jev-decision-assessment`，其他工作树和用户数据保持不变。

完成行为：实验准备有总体等待上限；重复评估不浪费新请求预算；未开启 Jev 时新增动作提名不会吞掉原有胜率讲解点。交付为验证后的代码提交与远端分支，不发布或安装桌面应用。

| 任务 / 验收 | 负责人 / 文件所有权 | 状态 |
|---|---|---|
| A1 实验评估并发 2、总期限 6 秒、取消与迟到隔离 | improve_assessment_latency / decision-assessment-host 与新测试 | 8 项测试通过；主控已审阅实际代码 |
| A2 保存结果与相同请求在预算用尽后仍可复用 | 同上 | 已复现旧失败，修复后通过 |
| A3 RETURN_AND_FIRE 与 WIN_RATE_DROP 重合仍保留原讲解 | 主控 / cs2d adapter 与测试 | 已复现旧失败，修复后原 cue 与 segment 均保持 |
| 功能审查 | audit_decision_boundary、audit_integration / 只读 | 默认路线回归已修复；空间观察内容不足列为能力限制 |
| 完整回归、构建、文档、push | 主控 | 1,039测试/TS/Web/Viewer/desktop构建与80项桌面unit、正常及decision-pilot真实sidecar通过；验收通过，随本分支交付 |

子代理均使用继承默认模型/推理配置。实现与两个审查各有独立范围，避免共享文件写冲突。该轮不重复调用已知只能拒判的真实模型输入，不将测试数量当作教学质量进展。

剩余能力限制：非用户 ObservationClaim 当前只投影类型、来源、置信度、年龄、共享元数据，未给 Jev 足够的空间/主体语义；相同元数据下改变合法观察位置不会改变问题输入。当前肯定判断仍受代码 checks 限制，真实 RETURN_AND_FIRE 仍只允许拒判。这需要单独设计匿名、保持原精度的语义投影并验证价值，不能靠放开全知坐标或降低接受门解决。

以下是前阶段实现和模型效果记录；其中“未提交”和历史阻塞描述以各记录日期为准。


最新效果复核已完成：9个不同合成输入三方对照、5个生成超时案例10秒诊断、5个真实Demo包按原请求hash三方对照。新增28次真实请求，未发现新增通过门的非拒判判断；速度优势不能替代质量提升。证据见 [效果对照](validation/JEV_QUALITY_COMPARISON.md)。

基线：隔离工作树 HEAD = origin/main = 6f5bf45，初始干净。只读复用主工作区既有 Demo、具名生成配置与本地缓存；实现和输出仅在本任务工作树。没有提交、部署或安装。

用户最新指示（2026-09-23）：使用已有材料继续，不要求用户补充Demo或标注。原专业判断目标保留；当前使用本人移动和明确开枪事实打通真实输入的受限拒判，不把几何返回称为重新接敌。

| 任务 | 负责人/文件所有权 | 状态/证据 |
|---|---|---|
| 原生Jev、独立配置、实验准备/冻结/恢复 | 主控与decision_config | 已完成；原有988测试、TS、Web/Viewer构建及桌面smoke通过 |
| 既有数据/shot归属、封闭用户context | observable_source_audit与主控 | 已完成；真实1242 shots有明确actor；v2语义/HTTP回归 |
| v3事实动作与未知接触门 | decision_core：contracts/decision-assessment及Jev adapter | 完成；48核心/原生与集成tests，旧v1/v2兼容，新分支只允许拒判 |
| 返回开枪提名器 | observable_source_audit：cs2d-analysis-adapter | 完成；52局部tests，本人shot+连续位置，2秒动作/10秒回看 |
| 候选与Director适配 | 主控：candidate-generator/deepseek-director | 局部26 tests与TS通过；默认无新增教学 |
| 单解析真实输入+实际Jev+恢复验证 | decision_config：verify-jev-real-smoke/helper | 完成；18真实pattern/8eligible，5live拒判、2实际教学消费，恢复0重新评估 |
| 最终回归/独立审查/文档 | 主控、独立审查代理 | 完成；最终1,024 tests通过/5既有跳过，TS/Web/Viewer构建通过，独审无open P1/P2 |
| 专业质量 | 无教练留出标签 | 未验证；正式自动接受保持关闭，不伪造黄金标签 |

委派均继承默认模型/推理强度；文件所有权互不重叠。子代理不接触凭证、不运行远端模型或另起真实Demo控制器；主控统一执行真实调用。最终请求只含匿名固定投影；原始Replay留在child。每个子任务有25分钟上限、阶段检查与进程清理责任。

工程实现、模型实测、专业质量分别报告。累计实际执行21次Jev（16次合成输入、5次真实输入）+6次生成请求（其中4次HTTP400与2次成功）。本轮真实输入证据为JEV_RETURN_FIRE_LIVE.json。没有教练标签不意味着可以宣称专业准确率，也不阻止独立可做的真实输入与失败链路验证。

本地工程交付及现有数据条件下的失败结论已完成；专业能力未通过验收，正式自动接受保持关闭。无需为本轮继续索要材料。

以下为历史阶段记录，历史“blocked/未完成”描述不覆盖上面的当前任务状态。

### 目标续轮：生产证据绑定修复

上一目标轮分类：progress（实现、真实模型调用和验证均改变了权威状态）。本续轮继续处理可独立完成的工程缺口，而非重复状态说明。

- cs2d adapter 1.5.1：本人状态与公共人数的 snapshot refs 精确绑定到候选事实；旧1.5.0/1.4.0恢复保持不变。
- CandidateGenerator 2.2.0：带明确行动者、独立source refs和合法窗口的CanonicalAnalysisFact可传递decisionAction，其他玩家动作过滤；没有新增检测结论。
- 真Demo重新单次解析：517候选、354不在场景、163缺结构动作、0模型调用。1937断言保持通过。原始首轮证据保留，新结果为JEV_REAL_BOUNDARY_SMOKE.json。
- `pnpm check` 982测试通过/5既有跳过，TypeScript/Web build通过；`pnpm cs2d:typecheck`、`pnpm cs2d:build`通过。Viewer源码与依赖仅在隔离工作树从现有本地源/缓存准备，0依赖下载。
- 原P1的快照引用及动作传递子问题已关闭；实际接触/曝光/再次接触生产与报点语义、专家标签仍未完成，不把0可评估当作产品成功。

### 再续轮：关闭可编码的信息缺口

上一轮分类progress（修复public binding/动作传递并用新真实smoke验证）。本轮没有直接把剩余项标blocked：一手源码审计发现shot actor可编码保留、WASM工具链实际存在，因此实现0007补丁及adapter1.5.2明确本人WEAPON_FIRE事实。真实1242shots均合法actor，未推断contact/LOS。

同时完成ObservationBuilder→封闭USER报点→最终HTTP v2。无内容保持v1兼容；两新报点真实请求均UNKNOWN/INSUFFICIENT，累计16calls。987测试、tsc、Web/Viewer构建通过。具体语义内容差异、原始引用/注入排除已有测试；未新增报点UI，不声称专业理解通过。

仍打开：可靠接触/曝光/再次接触动作事实和教练标注。shot及spotted均不足以证明这件事，见JEV_SOURCE_CAPABILITY_AUDIT.md。独立工程审查见JEV_USER_CONTEXT_REVIEW.md，真实证据分别为JEV_SHOT_ACTOR_SMOKE.json/JEV_REAL_SHOT_SMOKE.json/JEV_USER_CONTEXT_LIVE.json。总目标仍未完成。

补充审计还纠正了“没有生成凭证”的过早结论：主工作区既有具名provider文件可用，仅读所需key/model后完成两例真实生成模型对照，保留前4次400。当前累计22请求（Jev16、生成6），生成返回deepseek-flash、两例UNKNOWN/INSUFFICIENT；总费用未知。没有把配置文件或凭证复制进任务文件。现有凭证/工具链可编码问题已处理，不能再把它们列作阻塞。

### 最终审计

前两目标轮均为progress，本轮也关闭了可编码事实/USER语义/凭证发现及协议问题。相同的可靠再次接触证据与教练留出标签缺口已连续三个目标轮核实；新WASM仍0 eligible，原目标未缩小。当前已没有能在现有证据上诚实完成该验收的独立步骤，继续猜测spotted/坐标语义或生成代理标签会违反目标。最终988测试通过/5既有跳过；模型请求22次（Jev16、生成6），总provider费用未知。目标阻塞，等待可追溯接触/曝光事实或人工动作注释及教练留出数据，不标全部完成。
