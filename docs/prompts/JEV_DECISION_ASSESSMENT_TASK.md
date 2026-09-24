请按 docs/prompts/PROJECT_UPDATE_TEMPLATE.md 执行本次 CS-Agent 更新，直接实施并验证，不止交方案。

启动材料：模板目前在主工作区 /Users/vekel/编程/CS-agent/docs/prompts/PROJECT_UPDATE_TEMPLATE.md，任务原文在同目录 JEV_DECISION_ASSESSMENT_TASK.md；它们可能尚未被 Git 跟踪。若新工作树没有这些文件，从上述绝对路径只读读取，并将需要的提示词文件复制到自己的工作树。实现、构建产物和测试修改只在本任务工作树完成，保护主工作区及用户数据。默认从项目默认分支建立的隔离工作树开始，先核实基线。

更新名称：Jev 对玩家决策合理性的受限评估试点

本次目标：
用户明确希望 Jev 承担教练的决策判断，而不仅是选择慢放、地图聚焦等视觉工具。本轮实现一个可运行、可回退、可评测的最小完整切片：先以“人数优势后的再次接触／重复 peek”作为专项场景，根据决策时可知信息和玩家实际动作，评估处理是否合理、证据是否充分及哪些缺失信息会改变判断。将评估作为受限 Inference 接入已有教学链路，由 Director 决定教学价值、Narrator 表达已通过校验的判断。专业正确性是待验证假设，不能因为接口运行成功就宣布 Jev 已能当专业 CS2 教练。

预期流程：
用户按现有入口导入本地 Demo 并开始复盘 → 既有解析、ObservationBuilder 和 CandidateGenerator 提供完整候选与合法证据 → 对符合范围的候选生成最小决策评估包 → 在显式实验配置下运行 Jev 评估，经过确定性校验和保守接受策略后参与现有 Director/Narrator 链路；后台旁路模式只记录对照结果 → 维持现有整场带看、完整播放动作与结果后回到决策点讲解 → 失败或证据不足时诚实降级，基础回放仍可用。给出明确的本地启用、关闭、评测和查看结果方法。

交付终点：
本地实现并验证。包括实际接线、相关测试、TypeScript 检查、production build、可复现评测入口及证据报告。不要求提交、PR、部署、公开发布或安装到用户应用目录。没有真实模型或人工标注条件时，完成独立可做的实现与离线验证，逐项标记外部阻塞，不能把 mock 结果写成模型效果或把总目标标记为全部完成。

必须实现：
1. 先核实当前 assessment 的生产者、消费者和真实路径，再确定最小接口。已知线索：apps/web/lib/coaching/deepseek-director.ts 中 DecisionSummary.assessment；libs/review-planner/src/teaching-gates.ts、coaching-package-builder.ts、teaching-pipeline.ts；libs/observation；apps/web/lib/coaching/deepseek-narrator.ts。路径与现状由你重新核实。
2. 增加 provider-neutral 的受限决策评估 seam 和 Jev adapter；在规则基线、Jev 旁路及实验使用之间显式切换。尽量复用现有领域接口和版本机制，避免建立第二套教练体系。通用默认行为不因未验证模型静默切换。
3. 将“决策合理性”“证据充分性”“教学价值”区分。现有 DECISION_ERROR、EXECUTION_ISSUE、POSITIVE_PROCESS、FORCED_CHOICE、INSUFFICIENT_EVIDENCE、NO_TEACHING_VALUE 是复用线索，不是已证明互斥且正确的标签体系。核实语义后设计映射：多个合理选项允许并存；证据不足不能被当成低教学价值；没有观察到替代方案也不等于证明玩家别无选择。
4. 将宽泛问题拆成有明确定义的少量原子判断，再用代码组合。人数、时间、距离、经济、tick 比较和其他可计算条件由代码提供；未知保留 unknown。定义战术原则和适用条件、反例与拒判条件，明确哪些属于待教练验证的规则。不要让既有 assessment 作为输入答案被 Jev 复述，也不要把基线输出当人工黄金标签。
5. 输入只能来自决策时该玩家合法的 ObservableState、允许的公共事实及单独标记的实际动作摘要。动作摘要用于描述被评价的行为，必须有严格窗口与字段白名单；不能夹带死亡、击杀、胜率变化、结果标签或后续敌情。昵称、原始身份、路径、原始 tick、raw Replay/完整事件流按现有匿名投影规则处理。直接测试最终 HTTP/SDK 序列化包，不能只测试中间 builder。
6. Jev 返回受限类别、分项分数或概率、候选内证据别名和限制码。引用必须支持具体判断，不能把全部白名单引用自动粘到每条结论来冒充依据。经 schema、引用归属、时间边界、建议适用性和版本校验后才进入正式教学。模型 confidence 与证据 confidence 分开记录，缺证据不会因高模型 confidence 被升级。
7. Jev 不生成教练长文本、不替代 parser 或胜率模型，不获得播放器和 Memory 写权限。Jev 对决策合理性的评估不使用结果；Director 按原契约可使用结果筛选教学价值。Narrator 的 decision/outcome 引用防火墙和 OutcomeCompletionGate 继续成立。Jev 并行问题共享 state，不是信息隔离；不同信息权限必须使用不同投影／请求。
8. 独立配置生成 provider 与决策 provider。当前项目的 /chat/completions 适配不能直接改模型名接 Jev 的 /v1/systemone。密钥按现有服务端和桌面 Keychain → 初始化包 → sidecar 内存边界处理；日志只留脱敏元数据，不打印凭证，不读取或输出整个环境配置。避免为了试点扩建无关设置、网关或基础设施。
9. 固定并记录实际 Jev 模型版本、问题定义版本、输入投影版本、接受策略版本、延迟、usage、降级原因与产物 provenance；兼容既有缓存／恢复。历史查看和重复打开不得触发隐式重新评估、重复计费或新增习惯计数。旧数据缺少 Jev assessment 时继续正常使用。
10. 建立对照评测工具，比较规则基线、可用的现有生成模型评估和 Jev；尽量使用相同合法信息与量表，记录剩余差异。已有 Policy eval 可借鉴工程方法，但它评估视觉选择，不能当作战术判断评测集。提供结构校验、可接受标签集合、标注来源、按 Demo 分组划分和回放结果。

验收标准：
A1：给定合法候选，在实验模式下 Jev 的经验证评估确实进入现有教学消费链路；提供调用计数和实际消费证据，不能只提交孤立 adapter／CLI。
A2：同一决策证据及动作，替换随后“赢／输、死亡／存活”的结果，发往 Jev 的决策评估包及其缓存键保持不变；正式讲解仍在原 Outcome Gate 完成后显示。
A3：补充决策前可靠报点或战术信息后，合法证据包发生相应变化；实际模型是否合理调整作为独立质量指标。用户补充保留 USER_PROVIDED 来源和不确定性，不能改写为 Demo 事实。测试也覆盖团队看见不自动等于个人获知。
A4：证据缺失、矛盾、过期，未支持的场景或地图，非法／跨候选引用，异常概率，未知模型输出，HTTP 429/529、超时、取消、迟到响应均有可观察且可回退的处理；取消／过期结果不能修改已经冻结或消费的 cue。缺 key 不阻塞基础复盘。
A5：评测覆盖好决策坏结果、坏决策好结果、合理主动争夺、无谓冒险、信息缺失、可靠新信息和多个合理动作。反事实构造及人工设定案例明确标注 synthetic；只有真实解析 Demo 才称 canonical tick。
A6：报告决策标签质量、拒判率、自动接受覆盖率与错误率、可接受替代项命中、置信校准、真实调用成本和 p50/p95/p99 延迟（样本不足则明确不能可靠估计），并报告提示注入／结果泄漏回归。统计单位及置信区间需考虑同一 Demo 相关性，阈值调优与测试数据分离。
A7：现有整场覆盖、显式跳过、计划冻结、结果播放授权、历史恢复零隐式模型调用及 Memory 同意／晋级边界保持通过。使用项目实际脚本运行相关测试、TypeScript 检查和生产构建；改动桌面初始化或设置则加相关 runtime／Rust／桌面 smoke。
A8：更新 ARCHITECTURE.md 的本次契约与边界、docs/TECHNICAL_LEARNINGS.md 的问题／决策／验证／限制，以及本地使用和评测说明。PRD.md、MVP_SCOPE.md 仅在范围真的变化时修改。最终区分实现验收、模型实测、专业质量验收三种状态。

数据与质量门槛：
先清点可用真实 Demo、既有脱敏候选和专家标注，不假定已有 300–500 条可靠标签。先构建小而有区分度的人工设定回归样本验证工程边界，再运行少量真实输入 smoke；真实 CS2 专业质量需要教练标注的留出集。可提出后续 300–500 节点标注计划，但没有标注时不能要求自己伪造完成该规模。AI 标签／确定性规则标签只标记为代理标签。任何正式自动接受阈值都需要明确来源和验证结果；样本不足默认旁路，实验接线仍可在显式测试模式验证。

模型事实与参考（2026-09-22 已初查，开始实现时重新核实必要事实）：
- https://docs.typesafe.ai/introduction/quickstart ：原生 POST https://api.typesafe.ai/v1/systemone，state/questions/model。
- https://docs.typesafe.ai/models ：当时稳定版本 jev-1.13.0，$0.042/百万输入 tokens，文本输入，64k 总预算及 state+最长问题 32k，英文优于未经验证的中文，不提供客户微调。
- https://docs.typesafe.ai/confidence ：Choice/Score confidence 来源于概率分布，不能直接解释为 CS2 判断正确率；Noul 无独立 confidence。
- https://docs.typesafe.ai/model-jaggedness/jev-1.13 ：精确数值、间接推理、无关长上下文、对抗性输入及跨问题逻辑恒等式均有局限。
- https://docs.typesafe.ai/sdk/javascript 和 https://github.com/typesafe-ai/typesafe-sdk-js ：官方 SDK；初查 v0.6.0 默认 10 秒单次超时、两次重试，交互路径需要明确总期限。
- https://docs.typesafe.ai/cookbooks/citation_check ：学习确定性引用检查与语义支持判断的分工。
- https://docs.typesafe.ai/patterns/composite-scoring ：分项判断、代码组合。
- https://github.com/anisselbd/jev-phishing-bench ：学习分解任务、规则基线、同问题模型对照、留出集和校准审计；邮件指标不能外推 CS2。
- https://github.com/sutro-sh/jev-align ：可借鉴人工标注和量表迭代方法，不要求安装或把用户数据发布到公共注册表。

风险预检与执行责任：
- 主控拥有共享契约、集成、实际 diff 审查及证据结论；按模板确有收益时委派独立子任务，分配互不重叠的写入文件。中大型模型／恢复改动安排独立最终审查。
- 最高概率风险是“已有 assessment 答案泄漏给模型”“动作摘要混入未来结果”“fixture 被说成专家黄金集”“缺 key 却只写 mock”“工作树缺未跟踪模板／本地样本”“SDK 自动重试拖长交互”。阶段检查分别检查最终请求白名单、结果变更不影响请求、标注来源、live/mock 标识及实际模型版本、依赖可用性、超时取消。
- 原始 Demo／Replay 留在拥有它的 Viewer/Worker，主控只取摘要。测试优先复用既有紧凑输入，避免复制大 Demo、下载大语料、重新安装大规模依赖或启动另一个常驻服务来绕过边界。
- 真实 API 使用已有可用凭证时先 5–10 次 smoke；首次完整模型评测最多 100 次远端请求，记录实际用量，更多规模必须先证明前阶段有效并说明预算。缺凭证时可请求所需配置，同时完成所有独立实现；不把凭证写进文件、日志或新任务消息。
- 建议实验请求总期限从 1.5–3 秒起测，按实测尾延迟记录取舍；离线评测先最多 10 分钟 smoke，较大步骤设明确结束时间，不无限重试。此处是实验预算而非对产品性能的预先承诺。
- 一个测试控制器拥有浏览器／页面／Worker 从启动到清理；启动前确认所需 localhost/runtime 服务，先 smoke 再完整运行，只返回摘要与遥测；同一基础设施边界连续失败两次先简化 harness。主控负责清理本任务创建的进程和临时测试目录，保护真实 Demo、SQLite、长期记忆和原有未提交内容。

本轮不做：
不扩展成全地图全战术自动裁判，不训练自有模型，不改成实时对局助手，不重写 Parser／Playback／Session／Memory，不把 Jev 换到 Narrator，也不以完成全量专家标注或公开发布作为本轮隐含任务。

按模板建立本次总目标与 Task Board，先完成基线和任务卡，再确定接口、实施、集成、评测及审查。常规工程选择自行处理；如果证据显示 Jev 质量不足，交付诚实的失败结果、可复现对照和可关闭的实验实现，不为得到正结论而调低验收标准。
