# CS-Agent 持续优化任务板

更新时间：2026-09-25。执行流程唯一模板为 [PROJECT_UPDATE_TEMPLATE.md](prompts/PROJECT_UPDATE_TEMPLATE.md)，架构唯一事实源为 [ARCHITECTURE.md](../ARCHITECTURE.md)。

## 用户授权与优先级

用户授权持续自主学习、思考、实现、安排新任务，在有实际收益且验证通过时提交并 push；每个新对话使用项目更新模板。审查聚焦真实功能、教学判断、信息边界、恢复和用户体验，避免反复完整性检查、哈希审计、无收益重构或为了消耗额度运行测试。

当前只做离线 Demo 完整带看产品。优先级：
1. 用户能顺畅完成整场复盘，暂停、重放、继续及历史恢复可靠。
2. 教学有可追溯依据，能解释实际选择和可行替代，缺信息时诚实。
3. 降低等待和失败成本，改善必要交互。
4. 只有前面的证据支持时再扩大模型实验或新能力。

每轮先读最新实现与任务板，明确一个可观察目标及验收，再实施、学习、验证和 push。学习结论必须连接实际设计、实现或测量；不制造空泛学习报告。测试只覆盖实际改动风险，相关检查通过后不无理由反复全量执行。

## 协调与续跑

本统筹任务：01a0c8ea-9dca-7332-b03d-3b38b88ed630。已启用本任务 heartbeat，每15分钟检查/接续；运行中的子任务保持执行，heartbeat不重复派工。仅有已push成果、重要发现、失败或需用户处理的事项时通知。

同一工作树同一时间只有一个写任务负责人；独立任务优先使用隔离工作树，共享契约由主控协调。需要新对话时填写模板的目标、预期流程、验收、不做项、交付终点，并附所有权、依赖、风险、阶段检查、超时和清理。新任务先核实最新已验证基线，不能把旧main当最新成果。

大型Demo或浏览器测试先smoke，bulk留在所属Worker/页面，由一个控制器负责整个进程生命周期；超时有退出和清理。同一基础设施边界失败两次先简化harness。保护未提交工作、真实Demo、SQLite/Memory及密钥；不force push，不擅自部署、发布或安装用户应用。缺信息时完成独立可做项；无新信息的失败路径不无限重试。

## 当前成果与任务

| 状态 | 任务 | 对话 / 所有权 | 证据与下一步 |
|---|---|---|---|
| 已push | Jev受限评估与准备性能修复 | 原任务 01a0c914-96d1-72c0-b00d-f1b02ed6f4a4（空闲，不再派发写工作） | da640a6；1039 tests、TS、Web/Viewer/desktop构建和sidecar通过 |
| 已push | 观察语义与联合证据协议 | 同上 | 6ba9e31；1073 tests/TS/Web/Viewer通过；27次live未证明Jev判断质量提高 |
| 已push | 真实整场复盘体验与可靠性改进 | 01a0d72c-d1b6-7d31-9b5a-8705470ff0be（已结束，释放写入与进程） | d69a290；修复启动阻塞、已看cue回访跳过结果门；真实9回合/4cue到完成、刷新恢复、相关测试/TS/build通过；主控核对关键diff与验证记录 |
| 已push、验收完成 | 暂停/播放保留带看意图 | 01a0d759-8472-7072-ae94-84ec101ece3b；已完成并释放写入/进程 | bf42aef修复；105测试/TS/build通过，锁屏恢复后原A5四条真实交互及Space/Return通过；见GUIDED_PAUSE_RESUME.md |
| 阶段已push，真实验收未完成 | 教学演示暂停与继续 | 01a0d77e-085f-7880-9331-c01becde48cd；已释放写入，服务已停 | 214d743；156测试/Host与Viewer TS/Web与Viewer构建通过；锁屏阻塞原A5，不自动唤醒重试UI；解锁后先协调所有权再补验，见TEACHING_PLAYBACK_CONTROLS.md |
| 实现与本地验收完成 | 区分无需演示与实际工具完成 | 01a0d795-539b-7421-afbd-64e3f0e5c42a；阶段push后释放写入，无服务/浏览器 | 当前身份完成说明接入真实渲染；无演示、具体成功、失败与未知恢复准确区分；84测试/TS/production build通过，详见TEACHING_COMPLETION_STATUS.md；不关闭原工具暂停A5 |
| 已push | 决策时公开回合时钟 | 01a0d7bb-d7ea-7e21-864f-54e7e2e17049，完成并释放写入 | 9150d51；44候选/38个有效时钟、4cue/3个教学包消费，148测试通过/1个既有缺产物跳过，TS/Web/Viewer构建通过；暂停补偿未知仍null，不据时间单独判错，见PUBLIC_ROUND_CLOCK.md |
| 已push | 新解析器构建工具链配置 | 01a0d7ce-5686-7d33-84f4-717bae0a8401，完成并释放写入/进程 | 355e3f7；CI补WASM target/固定CLI0.2.125，保持Rust1.89；本地同toolchain预检和一次编译接线完成，21测试/真实parser与Viewer构建/TS/Web build通过；CI及1.89实际编译未运行，见PARSER_TOOLCHAIN.md |
| 已push | 准备阶段本地请求期限 | 01a0d7e0-5597-7bf1-bc85-832b767654a7，完成并释放写入/进程 | 413f15a；两个client fetch＋JSON共用20秒期限，父取消立即退出；4红复现后69相关测试/TS/build通过，真实prepare集成证明fallback后READY_TO_START/后续准备与保存恢复零请求；见PREPARATION_REQUEST_DEADLINES.md |
| 已push、本地验收完成 | 逐次受击事实与决策前本人证据 | 01a0d7f1-0580-7910-abbd-554dcd9a55de；已完成，释放写入与进程 | 264 hurt/本人27，23/44 snapshot和2/4教学包/确定性讲解实际消费；182测试+Rust3/TS/Web与Viewer构建通过；仍不证明专业判断提升，见SELF_HURT_EVIDENCE.md |

当前实现工作树：/Users/vekel/.codex/worktrees/7f2b/CS-agent，分支 codex/jev-decision-assessment。主工作区 /Users/vekel/编程/CS-agent 仍在main，含用户未跟踪提示词；不得覆盖。工作树位置变化时用 git worktree list 核实并更新本表。

## 本轮任务卡：逐次受击事实与决策前本人证据（2026-09-25）

- 基线65deea8（实现413f15a＋交接）；主控已读准备期限关键diff/69测试验证记录，旧任务明确完成push并释放写入/进程。新任务01a0d7f1-0580-7910-abbd-554dcd9a55de独占本轮parser补丁、Adapter/contract/planner与相关文档测试；串行复用已具备WASM工具链和真实样本的当前树，避免重复大数据移动与并发写入。
- 真实缺口：parser collector的player_hurt已接收tick/dmg_health/attacker_pawn/userid_pawn，只保留(tick,attacker,damage,weapon)用于回合ADR并丢弃受害者及逐次事件。Adapter明确记录无HurtEvent，以前后8Hz健康采样生成区间事实，不能精确定位受击。下一步是补parser-owned事实，而非继续同一Jev拒判集合。
- 目标与验收：A1核实一手源码和已有真实Demo事件字段；A2以可选兼容数据保留canonical tick及受害者归属，未知不猜；A3实际决策前CoachingPackage仅消费所选玩家本人受击的可知事实，结果另入Outcome，攻击者/敌人命中数值/坐标/武器类别不得凭hurt泄入可知信息，不推断LOS/重复peek/伤害方向；A4同tick/未来/不同人/缺字段/自伤或世界伤/旧Replay及历史往返回归，避免精确事件与帧掉血重复计数；A5一次最终真实WASM解析到教学包的小摘要、相关测试/TS/Web与Viewer/parser构建、架构/学习日志/验证记录、commit/push。
- 契约注意：优先可选独立hurt事实流，避免插入既有events数组改变按索引引用；不得默认补零/按位置猜actor，不改变旧ADR规则或把dmg_health直接声称为实际HP减少而未核实overkill语义。若无法验证精确损失，仅提供受击发生事实；无可靠来源则维持未知。已保存旧记录继续可读，新派生语义应有版本provenance；不重写历史。
- 边界/风险/阶段：前10分钟局部源码与小probe；必要时现有native样本探针120秒上限，一次最终WASM消费120秒；bulk留在拥有它的进程，只回summary。实现与局部测试30分钟，构建10分钟阶段上限；已有工具不足不安装。禁止浏览器/服务/外部模型/用户DB/发布/旧锁屏A5。当前默认模型/推理；独立边界审查若需要限5分钟只读。当前执行者负责parser/probe/build资源、临时源文件清理，保留用户Demo和共享缓存。第一次验证失败先定位，连续两次同一基础设施失败简化工具，不叠加harness。

- 最终证据：一次最终WASM解析7247ms、至双Adapter消融和教学消费7464ms；264hurt均有受害者，本人27，23/44候选和2/4正式讲解消费，2/4结果包消费，旧字段消融0→23/0→2且路线不变。健康区间事件25→3，新增27精确事件不作伤害总量统计；两教学判断仍证据不足。
- 验证/分工：182相关测试通过/1既有缺WebGPU产物跳过；Rust3、TS/Web build、Viewer TS/WASM与Viewer构建通过。hurt_source_review继承默认配置负责只读source核实、独占新增self-hurt.test.ts（13项）和5分钟只读终审；无blocker，补齐1.6.1历史类型和测试。根任务唯一生产写入负责人。
- 执行/清理：native初probe1次＋诊断编译失败误运行旧binary全读1次（已报告）＋修正后首事件早停1次＋最终WASM1次；bulk不出进程。所有测试/build/probe已退出，临时Rust probe从上游bin移走；无服务/浏览器/模型/用户DB/部署/安装，原UI A5不动。源码与文档同次提交push后释放写入，细节见[验证记录](validation/SELF_HURT_EVIDENCE.md)。

## 本轮任务卡：准备阶段本地请求期限（2026-09-25）

- 基线33bdb30（实现355e3f7＋交接），工作树干净；上一任务已完成并释放所有进程/写入，故串行复用当前实现树，避免另起旧main。新任务01a0d7e0-5597-7bf1-bc85-832b767654a7独占本轮代码/测试/架构/日志/任务板写入；主控仅只读协调。
- 证据：`requestTeachingDirector`和`requestNarrationBundle`客户端分别等待fetch和response.json，没有自己的deadline。服务端15秒provider timeout不覆盖本地入口/正文卡住，Controller会一直等route或前两条narration。已有取消测试只验证fetch主动抛AbortError，未验证忽略abort的transport。
- 目标与验收：A1用有限计时假transport复现headers/body永久等待；A2限定单次请求的fetch+JSON总期限，超时返回已有经过校验的确定性route/五字段讲解；A3父取消立即退出、不生成新fallback、不发迟到事件，清理timer/listener，不重试；A4真实Controller与客户端接线证明前两cue仍可READY_TO_START、背景准备可继续、恢复已保存内容零调用；A5相关tests/TS/production build、架构/学习日志/证据记录并commit/push功能分支。
- 范围：当前两个Host客户端、窄transport helper和相关测试/文档；不改教学阈值、Jev实验、提示词/模型、持久化schema、播放器UI或Viewer，不延伸成全项目HTTP重构。默认客户端期限须容纳现有15秒provider预算和有界本地开销，记录选择理由；deadline不是端到端启动性能承诺。
- 风险与阶段：先8分钟以内小复现，20分钟实现与局部回归，再最多10分钟检查/构建；无真实Demo/模型/数据库/浏览器，不碰锁屏A5或残留Edge窗口。若无可复现功能缺口则报告证据并停止，不为制造改动推进。当前任务默认模型/推理，无需为小模块强行分工；若确需独立审查只读、5分钟上限。执行者负责测试/构建进程退出、临时文件清理与写入释放。

- 实际结果：4个挂起回归先红（13旧测试通过）；修复后5文件69测试通过，TypeScript与production build通过。20秒为每请求fetch+JSON共有deadline，不是整个启动耗时承诺；保留15秒server预算+5秒本地余量与LOCAL_REQUEST_TIMEOUT，无自动重试。
- 集成证据：真实Controller＋生产clients的Director和首两Narrator timeout仍冻结完整3-cue路线并READY_TO_START，第三cue继续准备；实际恢复依赖复用已存内容零fetch。取消立即完成，晚resolve/reject不写route或发布ready，不进入额外fallback。HTTP/坏正文/正常路径保持。
- 分工/清理：主控独占实现，preparation_cancel_review继承默认配置仅5分钟只读审查竞态，已结束、无确定must-fix；未启动服务/浏览器/模型/Demo/数据库调用，所有测试/build退出，日志仅留本树忽略目录。commit/push后释放代码写入；原工具暂停A5仍独立阻塞。后续只有实际慢请求新证据才考虑调整预算，不推广全项目HTTP重构。

## 本轮任务卡：Parser WASM构建工具链（2026-09-25）

- 基线1e39be4干净，01a0d7ce-5686-7d33-84f4-717bae0a8401独占写入，有限goal已建。A1核实实际lock/MSRV/CI；A2显式target和匹配CLI；A3所选toolchain本地早期预检；A4受控命令失败路径及现有工具真实构建/TS/Web build；A5README/日志/任务板与commit/push。无浏览器、模型、Demo或发布操作。
- 已核实：parser锁定bindgen0.2.125；现有依赖声明最高Rust1.85，CLI官方声明1.86，沿用CI1.89而不升级。普通shell实际Homebrew Rust与构建原先优先~/.cargo/bin不同；预检与执行必须使用parser目录选择出的同一rustup toolchain和compiler。
- 范围：补WASM target/固定CLI的CI安装声明，仅parser Cargo恢复deprecated warning，保留桌面原-D warnings（action默认-D warnings会阻塞上游parser）；只读预检禁用隐式安装，缺cargo/rustup/target/CLI及版本不匹配先失败并提示操作。desktop:prepare先check，无自动本机升级或重复完整构建。主控自行完成，构建10分钟上限，负责所有进程清理。

- 最终证据：21项小范围测试通过，含执行实际CI安装shell的隔离命令探针，缺/错CLI安装一次、正确CLI零安装。真实cs2d:check、一次parser/Viewer构建、TS与production build通过，本机实际Rust1.97.1/CLI0.2.125。主控复查后将豁免缩到parser Cargo的deprecated lint；支持普通与encoded flags，严格父环境实际构建和相关测试再验通过，桌面-D warnings保持。
- 限制与清理：未运行GitHub CI或Rust1.89实际编译、未触发发布、不安装/升级本机工具或删除缓存；原A5不动。测试临时目录已清理，所有本轮进程退出；文档/README同步，commit/push后释放写入。不因验证不足声称干净CI实际通过，下一次正常CI运行再确认该环境。

## 本轮任务卡：决策时公开回合时钟（2026-09-25）

- 基线2f7ff61，工作树干净，01a0d7bb-d7ea-7e21-864f-54e7e2e17049独占写入。A1先查source2-demo 0.5.4和一手字段语义、对已有Demo做120秒上限native小探针；A2可靠源成立才加可选parser来源；A3守住决策前时间/知识边界；A4真实包消费；A5相关检查/构建/文档和同分支push。不操作浏览器或原blocked A5，不改主main、用户SQLite/数据，不请求模型。
- 分工与风险：主控拥有源码/契约、一次解析进程、构建与交付；clock_source_review继承默认模型/推理，先只读来源研究（15分钟），随后独占新round-clock.test.ts（8分钟），最后只读5分钟边界复查。重点为server/demo时域、缺字段与暂停补偿，禁止子任务解析Demo或启动服务/浏览器；已结束、无残留进程。
- A1/A4：source2 GameRules字段确实存在，round_start.timelimit为0不可用；Demo tick3081的serverTick7545计算94.375秒。源头native一次1.45s，最终WASM消费链一次解析6.185s；bulk始终留在拥有它的进程，输出小摘要。38/44候选时钟有效，3/4教学包有约秒事实，history往返通过；实际教学判断仍INSUFFICIENT_EVIDENCE、等待UNVERIFIABLE。
- A2/A3：optional frame clock采于on_tick_end，绑定本帧/round及可用时间。零默认/过期/未来/异常/冻结/植包/暂停与不明暂停历史不造值；只投影公开约秒，原始网络字段不入教学包。无general pause补偿，早期缺暂停字段会保守禁用后续整Demo；旧字段缺失仍可读。Observer/parser不产教学结论。
- A5：148测试通过、1个既有WebGPU产物对照因缺本地产物跳过；TypeScript、Web生产build、Viewer TS/build、parser WASM和Rust现有1测试通过。独立复查无确定must-fix，约秒不声称精确HUD取整。Viewer构建同步WASM源码补丁，使用已安装工具链。
- 清理/交付：本轮native/WASM/测试/build均退出，未启动服务或浏览器；临时probe源码已从上游构建目录移出，忽略目录仅留小摘要/日志；同分支commit/push后释放代码写入。下一步若需扩大时钟覆盖，应先取得含真实暂停的授权样本和暂停补偿语义证据，不凭字段名猜公式；不自动接续原工具A5。

## 本轮任务卡：准确显示教学完成状态（2026-09-25）

- 基线fc9b8b4，工作树干净，01a0d795-539b-7421-afbd-64e3f0e5c42a独占写入。目标为无需演示、成功展示、未完成及未知恢复分别使用准确文案；不改变Graph/Session/Viewer生命周期、预算与持久化，也不接续原锁屏UI验收。
- 真实链路：Controller的handleAgentResult把零capability/Policy FINISH与工具结果闭合均转为COMPLETED；Host一律声称工具完成。toolHistory有cue/call但没有visit，不能借上一轮历史推断本次成功。
- 窄方案：生产结果入口绑定session/run/cue/generation/visit的瞬时completionNotice；只有本次已接受的成功工具结果可显示对应成功，失败结果即使Graph正常完成也显示未完成。存在当前run/cue最近POLICY无选择记录且无pending/结果/当前cue工具历史的直接FINISH可显示无需演示；恢复信息不足保持中性。实际Host使用同一状态投影函数，旧scope不显示旧成功或详情。
- 验收：真实内存Graph与Host Controller入口覆盖零capability、Policy主动FINISH及实际成功；结果失败、取消、cue/run/session/visit切换、恢复均覆盖到渲染投影。相关测试、TS、Web生产构建；使用说明/学习日志与任务板，commit/push。无新进程服务、浏览器、Demo或模型请求，不委派。

- 交付结果：4文件84测试、TypeScript及production build通过；实际Host使用同一投影函数。所有本轮测试/build进程已退出，未启动服务/浏览器/模型请求，无生成next-env差异；提交push后释放写入。
- 精确限制：本轮没有UI/桌面实测，不能关闭原教学演示暂停A5或原blocked goal。完成说明不持久化，缺少可靠恢复记录时宁可保持“本段讲解已就绪”。下一步由主控在用户解锁后协调原真实工具验收，不自动重开环境。

## 本轮任务卡：教学演示暂停与继续（2026-09-25）

- 基线bb0bc11，工作树干净；01a0d77e-085f-7880-9331-c01becde48cd独占写入，有限goal已建立。只扩展活动Stage3播放工具的用户控制，不重做普通暂停或Jev实验。
- A1已核实：静态教学PAUSED_FOR_COACHING也可能有REPLAY_CUE_SLOW/SHOW_GRENADE_TRACE执行；Host现有通用播放门一律禁用，Controller10秒ACK墙钟继续计时。默认诊断模式不启动这些工具，真实验证使用既有teachingDiagnostics=off入口，不新增强制工具或改教学资格。
- A2/A3：Controller绑定session/cue/run/callId/effect generation，只有已post的活动播放工具可暂停；新增身份限定的Viewer transport命令，保持同一工具和位置，不计暂停墙钟、不以暂停当完成；seek、取消、失败、超时及重连作显式终止或恢复收敛，拒绝旧控制和ACK。
- A4/A5：保留Session结果门、普通暂停/manual/free seek；先红测试，再相关Host/controller/协议/Viewer回归、TS和production/Viewer构建；实际至少一种播放工具暂停超过原超时后续播完成，其他工具仅模拟则明确记录。
- A6：架构、学习日志、最小验证记录、commit/push；不合并main、不部署/安装。主控单一浏览器/Worker/server控制器40分钟，原Demo只读、bulk留页面、空provider，无新模型调用；先轻量click smoke再解析。
- 分工：teaching_viewer_review继承默认模型/推理，先只读诊断后负责contracts Playback bridge与Viewer补丁/helper测试，20分钟阶段上限，不写apps/web/docs、不启动浏览器或大Demo。主控负责Controller/Host及文档、集成构建、真实UI、清理。风险集中在身份、晚到自动play/watch和暂停deadline。

- 阶段结果：原Host门禁31绿/1红；修复后相关13文件156测试通过，Host/Viewer TypeScript与Web/Viewer构建通过。独立复查的iframe reload仍保留contentWindow、RESULTED持久化await后晚取消两处问题，已用额外4条红→绿回归修复。
- 真实界面：已解析一次原test_demo.dem/Dog并进入teachingDiagnostics=off；当前4 cues首点为静态不确定讲解，未取得实际tool/callId起止证据，其余3 cues尚未验证。“教学工具已完成”可能只是零capability FINISH，不能当作实际演示成功。此后Mac锁屏、自动解锁失败，已请求手动解锁，不重复重试或另开harness。
- 原A5和goal保持未完成；统筹已授权带明确缺口的阶段commit/push。解锁后只补真实工具暂停至少12秒再同次续播完成，以及必要seek/重连交互；不重复模型实验、不放松教学门、不强制制造工具。
- 清理：唯一服务controller已停止，3000/5174无监听；测试/构建全部退出，next-env无差异。新建InPrivate窗口因锁屏不能关闭，未强杀用户Edge；解锁后需要只关闭本轮窗口。阶段push后释放代码写入，下一次接续先核实所有权。一个后继建议是区分零工具FINISH与实际工具完成状态文案，本轮不扩展功能。

## 本轮任务卡：暂停/继续保留带看意图（2026-09-25）

- 基线2890ee6，启动时工作树干净，负责人01a0d759-8472-7072-ae94-84ec101ece3b；有限goal已建立。只处理暂停语义，不重做d69a290或Jev实验。
- A1复现：底部pause/play共用issueUserCommand，无条件USER_TAKEOVER；先提取原行为到Host真实调用的共享入口，写Session/Agent交接红测试，再验证现有真实Demo页面。
- A2/A3：暂停为Host瞬时播放意图，Session仍拥有phase/cue/default cursor/Outcome gate；普通及manual结果窗口暂停期间不得推进或被effect重播，续播从当前帧继续，恰好一次完成门。
- A4：seek/回合跳转继续接管并使旧意图失效；教练已暂停时用既有“再看一遍/继续下一段”，不让通用play跨门；旧bridge状态只能提供事实，不能恢复用户意图。
- A5/A6：相关语义回归、TS、build，实际默认/结果/manual暂停续播与自由seek；ARCHITECTURE、学习日志、验证记录、commit/push。桌面App/安装不在本轮验证范围。
- 风险/所有权：主控负责所有写入与唯一Edge窗口、页面/Worker/server；复用开发Host+静态Viewer，空provider、原Demo只读，bulk不出页面。controller40分钟超时，完成后关闭窗口、服务并确认端口释放。pause_effect_review只读检查effect/Agent/重连风险，继承默认模型/推理，10分钟期限，不启动进程、不写文件。

- 阶段结果：原始Host入口回归1红/24绿；修复后8文件105相关测试、TS、production build通过。只读审查发现的无Session pause→seek回归已统一真实入口修复。未修改Session契约/持久化或模型调用，教练停靠时原始play禁用。
- A5仍环境阻塞：Edge原生timeout；内置浏览器快照可读，但AX/DOM/坐标点击目标不可用，文件选择未触发，未执行四条真实Demo交互。已问用户桌面可操作状态，未重复追问。经主控明确许可只提交阶段成果，原goal不标完成、不降低验收。
- 后续已确诊为Mac锁屏：CUA明确返回“The Mac is locked and automatic unlock could not unlock it.”，连续三轮相同阻塞后执行者将原goal设为blocked。主控已通知用户一次。heartbeat在用户确认手动解锁/恢复任务前不得再次唤醒该任务重试电脑控制，也不另起浏览器harness。可以推进不依赖该环境且有真实收益的独立事项；没有此类事项就安静等待，不重复通知。
- 清理与接续：主控唯一server已停，3000/5174无监听；本轮IAB页已关，浏览器tab清单为空；Edge调用没有返回可用窗口句柄，无法确认其后台窗口状态，未强制终止用户浏览器。阶段提交后释放写入；恢复交互后按[最小接续路径](validation/GUIDED_PAUSE_RESUME.md)补验，进入前核实最新工作树所有权。

- 2026-09-25 15:23控制恢复：原生Edge成功返回可操作窗口并打开文件选择器；外部状态已改变，主控确认由原执行者接续A5。新InPrivate窗口和同一40分钟服务控制器独占本轮验证，复用原Demo与静态Viewer，不重复自动回归或模型实验。

- 最终补验：15:23控制恢复后，默认播放/结果窗口/manual回访分别暂停6秒不推进，续播不回起点并正确停靠；manual结束返回原R2 2/4；暂停后显式后退进入自由查看且不被自动拉回。Space与Return验证通过。此次未改代码，不重复既有105测试/TS/build，详见验证记录。
- 最终清理：新建InPrivate窗口关闭并回到用户原有普通新标签页；唯一控制器退出，3000/5174无监听；Next dev生成差异恢复。实现与补验证据提交push后完成原goal，释放写入。下一轮只建议根据独立审查证据处理Stage3工具播放中的暂停控制；本轮此阶段底部播放禁用，未做工具生命周期改造。

## 本轮任务卡：真实带看控制可靠性（2026-09-25）

- 基线：a1d5858，分支codex/jev-decision-assessment启动时干净；写入负责人为01a0d72c-d1b6-7d31-9b5a-8705470ff0be。goal已通过工具建立。
- 本轮固定两项：①真实默认入口准备完成后无法启动；②回访已讲过的教学点跳过本次结果完成门。暂停/播放接管行为留下一轮。
- 第一项真实复现：静态Viewer解析现有9回合Demo、本地CS-Net完成、Director及两段Narrator均200后，页面持续“正在提交可恢复起点”；浏览器Zod错误定位frozenReviewPlan拒绝decision_assessment_run。真实prepareRoute总附加该字段，恢复严格schema未同步。验收为实际编排产物可序列化/恢复、旧记录兼容、页面正常进入带看，失败有明确状态。
- 第二项前置与最小复现：正常完成一个cue→自由查看→点播同一已揭示cue→播放到结果末。合成计划内存复现显示仍PLAYING、无完成门，段末跳到下一cue但manual visit仍绑定旧cue。根因为本次visit错误复用全局revealed标记；红测试与真实页面均复现，修复后两者通过。
- 验收：已看/首次点播都完整播放后回决策点；不会越入下一cue；取消回默认游标；呈现/习惯/模型调用不重复；暂停/自由跳转相关操作保持可用。真实页面未通过前不以单元测试声称UI通过。
- 验证安排：主控唯一拥有Edge InPrivate窗口、页面/Worker与localhost服务；原Demo只读。CUA浏览器连接失败后采用原生Edge控制；Vite两次按需依赖重载中断启动后改用已构建静态Viewer，不改用户应用。模型provider为空，使用实际本地解析/CS-Net与确定性教练回退。
- 范围限制：普通localhost没有桌面历史库；浏览器刷新恢复已通过，隔离SQLite/Host历史46测试与desktop runtime14测试通过，完整桌面历史UI及打包sidecar smoke未运行。
- 所有权：playback_path_review负责只读定位/随后指定回归测试；主控负责UI与集成、任务卡、验证和push。其他工作树不改。阶段日志仅在本工作树忽略目录.local-data/full-review-ux。

- 收尾：真实9回合、4个教学点完成；已看cue回访、默认重播、取消回默认、刷新恢复后继续均实际验证。相关274测试通过，补充错误取消后编排集成16测试通过；额外重连/客户端打包检查通过，TS与production build通过。详细证据见[验证记录](validation/FULL_REVIEW_RELIABILITY.md)。provider为空，无新Jev质量结论。
- 资源已释放：自建Edge InPrivate窗口关闭、唯一服务控制器退出，3000/5174无监听；无遗留测试/构建进程，无主工作树改动。成果提交到当前分支，不合并main、不部署。


## 已知判断，避免重复试错

- Jev已修复投影中的信息损失、改用6题联合证据表达，但9个代理输入中仍没有有效明确判断。默认规则和显式实验保持不变；不重复调用相同拒判集合、不通过放松门槛声称进步。
- RETURN_AND_FIRE只是本人返回位置并开枪，不证明再次接敌、LOS或重复peek。真实接触/空间可达/战术信息仍不足。
- 生成模型在部分相似代理家族有明确输出，不等于真实专业质量通过。当前没有教练黄金标签。
- 非用户观察的合法语义现在通过v4匿名粗化摘要表达，后续不能把这项已经完成的修复再次列为全新任务。
- 现有证据报告位于 docs/validation/JEV_SEMANTIC_ACCEPTANCE.md 与 JEV_QUALITY_COMPARISON.md。使用报告了解失败模式，不重复做哈希或供应链核查。

每个负责者结束前更新本表：实际变化、commit/push、测试结果、剩余限制、是否仍持有进程和下一轮建议。旧记录留作证据，最新状态应清楚可见。
