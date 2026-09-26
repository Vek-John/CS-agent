# CS-Agent 持续优化任务板

更新时间：2026-09-26。执行流程唯一模板为 [PROJECT_UPDATE_TEMPLATE.md](prompts/PROJECT_UPDATE_TEMPLATE.md)，架构唯一事实源为 [ARCHITECTURE.md](../ARCHITECTURE.md)。

## 已交付：已显示道具种类的明确追问（2026-09-26）

- ID utility-kind-question，基线e62a59c clean；partial_revision_restore继承默认模型/推理，独占question/resource-source/view必要共享投影、新helper与测试；root拥有docs/ARCH/集成与push。先核实真实分支：Host诊断与baseline三段互斥，种类chip目前只在baseline，不能借未显示的另一分支回答。
- A1真实Adapter verified库存→当前显示→明确问句；5分钟提交最小接线方案。A2复述同源已展示种类且数量未知，未知/未verified/旧/未来/缺本人拒绝；A3结果门、分支、旧token/恢复、数值/clock/建议兼容；A4相关tests/TS/build，root读实际diff及本地日志，文档后push。
- 风险/边界：不把种类数量当颗数，不新增战术判断/模型/Graph/Memory/播放；复用opaque cache和已安装emil/apple规则，先来源而非新UI。15分钟有限交付，测试60秒，两次基础设施失败简化；无Demo/DB/服务/GUI/安装，执行者清理进程，原A5独立。
- A1方案已确认：仅baseline三段（含FALLBACK）实际显示种类chip时开放，诊断分支不引用隐藏chips。原View/helper共用种类规则，cache来源对照actual displayedUtilityText；root独占Host新增这一标量行，执行者不写Host。最终匹配结果参与key以拒绝旧回答；已知空仅在同源已显示“无道具”且原count=0时中性复述。
- 交付：22新增项、5文件180相关tests、TS/build通过，root已读实际日志与关键diff；未知/空、诊断隐藏chip、显示变化、manual结果门、旧token及无重复投影覆盖。负例发现两个undefined相等导致解引用，已用明确source存在门修复。执行者RELEASE、进程全部退出；[记录](validation/CURRENT_CUE_UTILITY_QUESTIONS.md)。仅合成Replay实际模块/SSR，未真实Demo/完整浏览器/用户库。
- 后继：当前基础局面卡回合时间仍写“回合剩余N秒”，而诊断/追问明确最近采样约秒。先核实实际卡片文案并对齐采样限定，不动时钟计算/判决或重复真实Demo解析；随后转回有实际证据的教学/等待问题，不逐字段制造新入口。

## 已交付：当前回合时间的有来源追问（2026-09-26）

- ID clock-question，基线42d6b37已push；partial_revision_restore默认模型/推理独占current-cue-resource-source.ts、current-cue-questions.ts及新clock问答测试，必要最小提取原Host clock helper须先同步。root拥有docs/ARCH/最终集成与push，不并发写源码。
- 目标/流程：完整结果门→当前诊断已有时间measurement→明确“当时回合还剩多久”追问→复述相同可信源约秒。A1真实Adapter/Host/诊断/Session/问答贯通；A2严格核对测量与source，旧/缺/错身份或测量不匹配无数字，C4/假设不混淆；A3恢复/缺本人资源和既有资源/建议/结果门保持；A4相关tests/TS/build/主控关键diff、文档后push。
- 边界/风险：复用opaque cache、不可只凭label或持久化数字，不新增模型/工具/布局或战术结论，不重新计算C4；emil/apple既有交互保持。5分钟smoke、15分钟有限交付、测试60秒；无Demo/用户DB/服务/浏览器/安装，执行者清理自身进程，A5独立。
- 结果：明确回合时间问法复述同源已显示约秒；提取原Host clock helper共享，cache独立保存公开clock，缺本人资源仍可用。C4、未知/旧来源和不匹配measurement不输出数字。32新项原2正例红→绿，4文件149tests、TS/build通过；root已读关键diff并复验新增32项。[证据](validation/CURRENT_CUE_CLOCK_QUESTIONS.md)。未真实Demo/浏览器/模型，已释放写入及进程。
- 下一有限目标：核实当前已显示的道具种类能否用明确追问复述；现有“几颗”不应把种类折成数量，未可信来源保持未知。先实际Adapter小例与当前显示入口，必要才接线，不重试Jev拒判集或锁屏A5。

## 已核实：公开时钟不依赖本人资源完整（2026-09-26）

- ID clock-without-self，基线78fe948 clean，root独占diagnosis-clock.test.ts与本轮文档。A1真实Adapter缺本人frame但公开clock齐全→实际Host/诊断；A2只修证实的事实丢失，资源/时机判断门不放宽；A3相关tests/TS/build及行动结论push。无代理、Demo/DB/模型/GUI；小测试60秒，20分钟内闭合，root清理进程。
- 结果：假设不成立。fresh_player_state实际上表示frame过旧，并非本人记录缺失。独立WIN_RATE_DROP信号正常提名的实际Adapter cue中，本人快照null、decisionResources缺省，公开clock仍进入时机measurement，判决保持INCONCLUSIVE。最初DEATH fixture缺本人无法提名，不将其作为产品故障；改用已有独立信号路径，不强造cue或降低提名门。
- 不修改生产代码或拆出重复投影。新增这一跨层边界用例，关闭上轮“可能剔除”限制；后继选择已展示回合时间的明确数值追问，当前入口仅支持血量/护甲/道具/弹匣，先核实是否能复述当前clock而不扩成C4或时机判断。
- 验收：21项相关测试、TypeScript和production build通过；无生产行为变化，root集中审diff，进程退出。初版fixture只读数组赋值已改成不可变构造；没有安装/部署或用户数据操作。

## 已交付：时机诊断消费已验证回合时钟（2026-09-26）

- ID diagnosis-clock-context，基线0d83957 clean；root拥有可选紧凑DTO/Host投影/诊断/测试/docs。核实自适应trade/info/timing已有具体缺项说明，不重复加UI；新缺口是时机诊断没有接收当前已知回合时钟，仍笼统宣称缺剩余时间。
- A1实际Adapter带clock小fixture→当前Host packet→时机诊断；A2只投影同决策fresh Snapshot OBSERVABLE LIVE剩余秒数和允许的决策refs，作为背景测量；A3未知/旧/错player/结果ref不输出数值，诊断保持UNVERIFIABLE/INCONCLUSIVE、无目标/替代方案推断，旧packet兼容；A4相关tests/TS/build/窄审和push。
- 仅数据接线和既有测量显示，无新UI布局/模型/工具能力；root20分钟任务，测试60秒、只读独审按需默认3分钟。无Demo/DB/网络/安装/GUI，合成时钟不冒称真实Demo；不改变PlayerState缺失门，进程清理，A5独立。

- 交付：自适应缺项原已有具体解释，不重复加UI；补可选decisionClock，从fresh当前Snapshot公开LIVE余量及允许refs经严格事件进入时机诊断。现有数值列表显示最近采样约秒数，保持UNVERIFIABLE/INCONCLUSIVE，非C4/时机判定。
- 验收：13新集成tests、244项不同相关tests、TS/build通过；Adapter/严格事件/诊断/实际Panel SSR和JSON重载。partial_revision_restore默认只读RELEASE，无must-fix；主控审diff，进程退出，无用户数据/模型/部署。[记录](validation/DIAGNOSIS_CLOCK_CONTEXT.md)。
- 下一有限目标：公共clock复用了currentDiagnosisSnapshot本人新鲜度门；用缺本人但公共时钟完整的当前Adapter场景核实是否误丢有效时间，若真实可达再独立投影，个人资源和未知倒计时仍保持原门。A5独立，无真实Demo/GUI重试。

## 已交付：不确定性讲解的具体回看问题（2026-09-26）

- ID uncertainty-review-questions，基线ed1dc29 clean；root独占展示投影/Host小接线/测试/docs。当前betterPlay无可验证方案时固定泛化提示，而当前Snapshot已区分tradeWindow/目标等待/道具用途/替代位置缺项。
- A1当前Adapter→Narration→三段投影的小fixture验证具体缺项；A2仅INSUFFICIENT_EVIDENCE且同决策Snapshot生成最多3个静态回看问题，不引用隐藏玩家/结果或原始reason，不进入建议/判断/记忆；A3已确认/不可行条件不当作未知，缺/旧Snapshot兼容，Narration和门保持；A4相关tests/TS/build、窄审/证据push。
- 应用既有emil/apple规则，沿当前可行处理区分开标记“回看时先核实”，原生列表无新动画。只基于项目已具备条件做问句，不新增战术事实，暂无需外部研究。root20分钟有限任务，测试60秒；零Demo/DB/模型/GUI/安装，bulk无外传，进程清理，A5独立。

- 交付：基础三段卡独立显示最多3个具体回看问题；只用同决策Snapshot的已知UNVERIFIABLE条件，排除已确认/不可行/OUTCOME，闪光问题有本人OBSERVABLE库存前提。不改Narration/Advice/判决/Memory，不输出原始reason。
- 验收：5新增Adapter→Narration→View测试，81项不同相关tests、TS/build通过，root集中复查，无新代理/后台进程/用户数据/模型请求。[记录](validation/UNCERTAINTY_REVIEW_QUESTIONS.md)。非浏览器/真实Demo教学质量验收，A5独立。
- 下一有限目标：自适应UNKNOWN诊断走独立hinge/transferRule卡，先核实具体缺条件说明是否足够、与本轮fallback问句一致；已有充分解释则不制造重复UI。按真实可达缺口选择一项教学内容提升，不反复Jev拒判试验。

## 已交付：整场完成恢复点的延迟收敛（2026-09-26）

- 结果：真实Graph完成cursor原为末段index，已推进到末端WRAP_UP；COMPLETED可合法捕获边界。终结mirror允许同owner自由回看，Host等mirror专属ACK再清理；summary/transport不毁终结retry，ACK后takeover清理已接通。
- 验收：9新项及176其他相关tests、TS/build通过；实际Adapter/Session/Graph及fake-indexedDB、历史写fake，既有小SQLite回归通过。partial_revision_restore默认只读RELEASE，三类必修由root落实；进程退出、无用户数据或部署。[记录](validation/TERMINAL_CHECKPOINT.md)。
- 下一有限目标转回教学：从当前cue生成路径核实默认不确定性讲解的具体证据缺项和可行动内容，选一类可验证提升。先小输入/源码消费，需要知识再查一手资料；不降低判断门或重试同Jev拒判集合，A5独立。

- ID terminal-checkpoint，基线af88557 clean；root独占Session recovery边界/Host/mirror/测试/docs。已查三处：mirror拒takeover、stable builder不收COMPLETED、完成effect先删除recovery身份，需真实终结序列验证。
- A1当前Adapter+Session/Graph完成产物，小fixture重现完成前后seek/点击完成导致head未提交；A2仅精确COMPLETE_SESSION完成回执允许终结自由查看同步，COMPLETED仍从plan精确末端捕获WRAP_UP；A3本地删除身份等待已确认终结mirror，错误/跨owner/非终结继续拒绝，retry仍绑定checkpoint；A4相关tests/TS/build/独立窄审和push。
- 风险：不能假造结束、提前销毁旧可恢复点或放宽活动cue takeover；head写入与ACK分开验证，失败保留原record。默认只读子审3分钟，root写文件；先小真实模块，外部存储fake，不读Demo/用户库/模型/GUI，60秒测试/20分钟交付，进程清理。原A5独立。

## 已交付：总结保存失败的同内容重试（2026-09-26）

- ID summary-save-retry，基线0e1b0ed clean；root独占完成seam/Host/Panel/测试/docs。已核实仅historyError，无总结重试；RuntimeHeadRetry只重交恢复点，不能复用为重新生成总结。
- A1保存失败保留结果快照+原owner显式重试；A2同payload/key/revision重复点击合并，成功只清自身状态，零Graph/重新总结；A3切历史/同ID重新adopt、保存中切换及再次失败正确收敛，既有回看/完成仍可用；A4相关tests/TS/build/窄审后push。
- 风险/资源：长驻重试必须捕获persistence ownershipGeneration和现有session/run/epoch门，不能把旧内容写新历史；只内存留一个总结，刷新不假称可恢复。已有emil/apple规则与原生disabled/busy按钮复用，无新动画/布局系统。先小deferred/真实HistoryPersistenceController，必要隔离API重试验证；不用户DB/Demo/模型/UI锁屏/安装。20分钟有限交付，测试60秒，root清理进程；独立只读审查默认配置3分钟上限。

- 交付：内存保留结果快照，原summary key/revision/幂等键重试，双击共用promise、成功关闭；owner guard增加persistence ownershipGeneration。同ID重开/历史切换拒旧，Panel显示失败/忙/成功，零重新生成。SESSION_SUMMARY接入原20秒fetch+body期限。
- 证据：7新重试＋1期限用例，95相关tests/TS/build通过；partial_revision_restore默认只读RELEASE，root核diff。[记录](validation/SUMMARY_SAVE_RETRY.md)。mock外部append/网络、SSR非完整浏览器，进程退出，无用户数据/部署。
- 下一有限任务：实际mirror源码仍拒takenOver，stable recovery builder只收WRAP_UP不收COMPLETED。沿真实终结事件的延迟序列核实自由seek/提前点完成时head是否停前cue，若存在则窄修终结恢复收敛；不把本次summary保存成功当作head成功，不重跑同一真实Demo存储链或锁屏UI。

## 已交付：总结生成与自由回看的生命周期分离（2026-09-26）

- ID wrap-up-takeover，基线35d37ee clean；root独占完成seam/Host/回归/docs。当前Host将userTookOver作为总结归属条件，普通时间轴自由seek可能丢在途结果且Controller去重阻止再产出。
- A1抽取实际Host归属判定并用deferred Controller完成/总结返回复现；A2同会话终结自由seek保留生成与一次保存，generation/session/run/history epoch/persistence/review/revision变化仍拒；A3完成状态释放临时run保持兼容，错误正常收敛、不重复请求；A4相关tests/TS/build/证据push。
- 风险：仅终结总结的控制权与归属分离，不放宽活动cue/工具取消或引用门；readonly独立窄审按需，root文件owner。无Demo/SQLite/模型/浏览器/服务，mock外部延迟不冒称真实Graph或网络；测试60秒，20分钟有限交付，清理自己进程，A5独立。

- 结果：原predicate在真实Controller完成等待期间seek后onResult=0；新实际Host guard只移除takeover，保留所有owner与terminal条件，完成effect同样允许自由查看。13新回归＋47相关tests、TS/build通过，partial_revision_restore默认只读RELEASE，无must-fix。[记录](validation/WRAP_UP_TAKEOVER.md)。
- 资源/限制：首fixture空routeHash导致等待失败，第二次后改为单例阶段检查+真实Adapter路线，未放宽产品门；最终进程退出。Graph响应/保存是fixture/spy，不冒称真实Graph服务/SQLite/完整UI；Graph checkpoint镜像原规则未改变。
- 下一有限目标：SESSION_SUMMARY保存失败目前只有historyError，已有RuntimeHeadRetry不覆盖该artifact。核实并实现对同owner已生成结果的明确重试，验证零重新生成/Graph调用与切历史拒旧写；不从单一UI等待扩大项目阻塞。

## 已交付：结束页已完成片段回看（2026-09-26）

- ID wrap-up-revisit，基线3813709 clean；root拥有Panel/Host小接线/测试/文档。真实NO_REPEATED_THEME只显示不归纳提示；现有时间轴可seek、Session禁止终结后ManualCueVisit，不重新启动教学。
- A1仅当前冻结plan中已presented且consumed的cue成为回看目标；A2结束页显示回合入口，复用现有pause→seek到segment开头，COMPLETED/WRAP_UP进度与摘要不变；A3回看期间保留结束页、准备中禁用，不新开Graph/讲解/工具；A4相关tests/TS/build/证据push。
- 已应用emil/apple技能，原样式/键盘button/减少动效透明度规则复用，无新动画。root先小模块/SSR与实际Session控制测试，UI不重试锁屏路径；不假称浏览器验收。20分钟有限实现/60秒测试，零Demo/用户DB/模型/服务/安装；必要窄审只读，清理本任务进程。保留原主题证据门，不从skip制造判断。

- 交付：结束页同plan已presented/consumed回合按钮，暂停定位到segment开头；终结自由查看保留总结，不重新进入Graph/ManualCueVisit。IDLE/LOADING/未就绪禁用，回调绑定session/generation/open epoch；原“讲解最近点”终结时禁用，返回文案对齐。
- 验收：5新项＋67相关tests、TS/build通过；原生Button SSR/真实Session/HostPlaybackControl及JSON恢复验证，未声称真实浏览器/Viewer。partial_revision_restore默认只读窄审指出并已修LOADING/旧回调风险，root读diff；无Demo/用户库/服务进程。[记录](validation/WRAP_UP_REVISIT.md)。
- 下一有限任务：现有普通时间轴仍可在总结LOADING期间takeover，当前总结接收条件可能丢弃同owner迟到结果。用deferred实际completeStage3SessionWrapUp流程核实并只修已确认问题，优先保持完成和摘要保存；不再重复存储测试、不降低教学门，A5独立。

## 已交付：历史保存的重复校验等待（2026-09-26）

- ID artifact-save-latency，基线ee29f4b clean；root独占profile/必要校验窄修/docs。目标从上轮17次保存3.927秒中定位load/validation/write占比，仅对已证明的重复工作优化。
- A1已有隔离SQLite测试加入每请求分段计时，小smoke后授权60.6MB样本单解析测量；A2若主因是同请求两次Analysis/Candidate校验，去重但每请求仍读当前revision并做完整领域验证，不跨请求缓存；A3非法分析/候选/身份/早期缺计划行为保持，关闭重开保持；A4相关tests/TS/build、前后匿名计时和push。
- 预检/边界：bulk仅测试进程，不读用户SQLite/模型/桌面，不安装部署。每真实run外部150秒/内部120秒，先smoke，两次基础设施失败简化；root拥有临时库finally清理。不更改Graph/引用门，不扩大无意义完整性审查。原A5独立，允许同样本必要前后各一次解析以测真实效益，区别于重复质量评估。

- 结果：真实前后17次保存4094→2642ms（-35.5%），校验2918→1632ms，读725→651ms，写116→114ms。完整集合去掉同请求二次Analysis/Candidate校验；bootstrap与所有引用/身份门保持，不跨请求缓存。[证据](validation/ARTIFACT_SAVE_LATENCY.md)。
- 验收/清理：新增8回归、56相关tests及opt-in真实API/SQLite重开通过、TS/build通过；partial_revision_restore默认配置两次窄只读审查RELEASE。实际进程与临时库清理，无用户数据/部署；计时是单次对照，不外推p95。
- 下一有限目标转回教学交付：真实全跳过结束摘要为NO_REPEATED_THEME，现有SessionWrapUpPanel仅显示不归纳习惯提示。先核实用户在这个状态能否直接回看已完成教学点，以及能否从现有证据给出明确下一步；不降低重复主题门、不凭skip编造习惯，不重复测同存储链。原A5继续独立。

## 已交付：真实结束产物的隔离SQLite恢复（2026-09-26）

- ID real-history-reopen，基线184ee6f clean；root独占opt-in集成测试/必要窄修/docs。先读既有inventory恢复链与真实API；不重复造存储层或绕过HTTP body门。
- A1单读授权60.6MB Demo/单解析，实际Analysis序列化与结束产物；A2真实artifact POST写隔离库、提交WRAP_UP head、关闭重开；A3实际GET→HistoryRestoreController→恢复验证/冻结准备，零新分析/讲解/Viewer请求且摘要保留；A4相关tests/TS/build、小摘要与push。必须记录真实payload体积和等待，不把模拟存储当已验收。
- 风险/所有权：bulk仅测试进程，临时目录由finally关闭owner并删除；同一读取供Parser和临时managed Demo导入，不再读用户文件。外部150秒/测试120秒期限；先合成smoke，连续两次同基础设施失败先简化。无用户SQLite、模型/网络、浏览器/安装，不触原A5；只根据实际失败调整产品。

- 真实发现/交付：完整Parser版本>160阻断恢复；CandidateSet请求1.73MB超过小JSON门。只扩parser字段512且两事件一致、候选复用gzip；通过实际POST/PUT和真实SQLite completed checkpoint，不能直接DAL绕门。测试捕获WRAP_UP边界，先前harness错误已对齐生产契约。
- 证据：最终60.6MB单读/解析7.501秒，17产物（分析5.88MB/候选1.73MB gzip）保存3.927秒，关闭重开GET/恢复204ms；4skip/摘要保持，零新生成/Viewer请求。141相关tests＋opt-in真实测试、TS/build通过；partial_revision_restore默认配置只读窄验收RELEASE，root读diff与结果。[记录](validation/REAL_HISTORY_REOPEN.md)。临时库/副本/进程清理，无用户库/安装/部署；UI/服务器/Graph重连未声称验收。
- 下一有限目标：实际17次artifact保存约4秒且小记录单次约200ms，先测同一revision重复物化与语义校验各占比，评估减少等待的安全可行路径。root先小probe，无需桌面/Demo重解析/模型，避免任意缓存改变删除或revision语义；证据不足不改生产。原A5仍独立。

## 已验证：真实Demo整场带看模块消费（2026-09-26）

- ID real-guided-lifecycle，基线61ae6fe clean；root独占可复用验证工具/docs，无新代理。目标为当前Parser→Adapter→Session/Controller→Graph完成→受限总结真实数据消费，不重做字段/哈希一致性审计。
- A1合成小smoke通过实际消费；A2授权60.6MB test_demo.dem单读/单WASM解析，同进程保留Replay，优先原Dog玩家，整场快速skip与混合反思路径；A3完整覆盖/结果门/确认次数/零工具及网络/最终摘要结果，实际缺口才修；A4相关tests/TS/build、匿名小摘要和证据push。
- 风险/生命周期：解析同步WASM必须外部120秒进程期限，脚本仅返回计数/时间，不把Replay/身份/坐标送出进程；两次基础设施失败先简化。复用现有parser产物，不安装/重新构建/写用户Demo或SQLite；无UI/模型服务，胜率模型未运行须如实标明，不把模块驱动的tick通知当画面实测。执行完进程退出，不留后台资源。
- 实际结果：60,601,900字节单读/单解析7.458秒，9回合/33段/44候选/4cue；ALL_SKIP为4跳过，MIXED为2跳过+2真实Graph诊断，两路径均Session/Graph完成4cue、摘要仅写一次，0工具/网络。NO_REPEATED_THEME是有界证据不足的正常结果，未生成虚假重复问题。
- 交付：新增可复用validate-guided-lifecycle.ts，smoke通过、29相关tests、TS及production build通过。[记录](validation/REAL_GUIDED_LIFECYCLE.md)和匿名JSON已保存；没有发现需修改产品的缺口。root单进程完成，无代理/后台资源。
- 限制/下一项：CS-Net未运行，使用实际事实的确定性路线；播放通知由harness驱动，持久化仅计数seam，不是UI/SQLite。下一有限任务验证真实分析/结束产物在隔离SQLite关闭重开后恢复，关注实际体积/等待及零重复分析，不触用户库、不做哈希或供应链审计。

## 已交付：已展示节点前的普通段自动补齐（2026-09-26）

- ID presented-cue-order，基线d4b724e clean；root独占Controller/测试/docs，无新委派。上一轮真实手动回访序列已经证明缺段导致拒绝，本轮消除对外部再次触发的依赖。
- 目标/验收：A1缺普通段时首次observePresentedCue自动按序补齐并被Graph接受；A2与正在等待的observer及后续观察共用串行队列，不提前预约跳过未确认段；A3失败仍不确认、同event可重试、reset与重复保持，未展示教学段不可伪造跳过；A4相关tests/TS/build后commit/push。
- 边界/风险：复用dispatchObserversUntil和回执规则，不改Graph协议、不新增工具/模型/网络重试。只为匹配冻结plan的cue/segment索引工作，原缺证据教学段保持保守失败。真实Graph小例，8分钟实现/验收目标，无Demo/用户库/UI/服务/安装，root清理进程；原A5独立。
- 实际结果：首尝试缺普通段1红5绿→新路径一次成功；目标不再提前预约，共用observerTail保证普通段→已展示cue→后续段顺序，reset补齐期间无旧mirror。保留本地丢账时含教学段不自动补齐、原事件回执重试，修正初版过度补齐造成的reset重试回归。
- 验证：presented-cue-ack现9项（本轮新增4）及其他57项，合计66tests；TS及production build通过。[记录](validation/PRESENTED_CUE_ORDER.md)。root独占，未重试额度失败的代理，所有进程退出，无用户数据写入。
- 下一项转向真实数据消费：用已有授权小Demo，在同一拥有数据的进程内验证当前Parser→Adapter→完整默认路线/跳过→Graph结束与总结，输出小统计，不重做哈希/字段完整性审计，不启动锁屏UI，不把该验证冒充浏览器验收。

## 已交付：已展示教学点的真实同步确认（2026-09-26）

- ID presented-cue-ack，基线c51a6b0 clean；原委派因额度错误终止且无文件产出，root已核实并自行接手，不重复派发。上一轮源码证据已定位status误判，本轮实际Graph序列验证，不做通用完整性审查。
- 目标/验收：A1真实手动已展示→返回默认路线，后台段观察缺席时Graph拒绝且cursor不动，Controller不得误confirm/mirror；A2补齐缺段后同event可重试，合法呈现只确认一次；A3reset晚回包无效、丢ACK且Graph已前进仍可据原事件回执确认；A4相关tests/TS/build、证据及push。
- 风险/边界：不以历史fallbackReasons判定本次拒绝，不改Graph顺序/手动访问/工具门；仅Controller确认与mirror时机，保留64事件回执窗口的保守语义。无网络/模型/Demo/用户库/UI；root独占生产/测试/docs并清进程，原A5独立。
- 已复现：实际Graph返回COMPLETED但ROUTE_ORDER_MISMATCH、游标3未动，旧Controller错误推进5；reset后旧回包也把新controller游标-1写成5。原3测试2红1绿，修复后新4测试及32Controller测试通过；已加正常重试与丢ACK正向对照。
- 最终：5个新真实Graph测试及57相关测试、TS和production build通过；确认依据为事件回执+绑定+完整身份+游标，mirror移到确认之后，reset token及同event新promise归属保持。[证据](validation/PRESENTED_CUE_ACK.md)。root独占接手完成，无新子代理/外部请求，测试进程已退出。
- 下一有限体验目标：本次真实失败来自普通段观察尚未到达而已展示cue先发出；核实该观察能否加入现有串行observer队列自动补齐必要前段，避免用户等另一次触发才恢复。只沿已证明的缺段序列，不扩大Graph协议或重复全量检查；真实UI仍独立待验。

## 已交付：快速跳过后的诊断连续性（2026-09-26）

- ID skip-lifecycle-continuity，基线3195bb1 clean；root生产/docs，revision_semantics_review默认配置5分钟真实序列预检/8分钟上限，先只读。已核实OBSERVE_PRESENTED_CUE需要Graph已有绑定，不能用它凭空登记刚显示的baseline。
- 目标/验收：A1实际Controller+Graph两cue复现；A2只为当前结果已完成、已显示且身份/冻结路线验证过的baseline保存本地凭据，后续按序使用现有无capability START_CUE补记，不阻挡基础显示；A3错误身份/未完成/重置/失败不假确认、不执行工具或mirror旧head；A4实际下一诊断可用，相关tests/TS/build后push。
- 风险/范围：旧Graph未注册cue会让queueObserversUntil永久degraded；不得通过改Graph顺序门解决。仅有限运行期凭据及串行消费，保护已有恢复/手动访问边界，不新增模型/协议/安装。无Demo/用户库/网络/UI；root清理测试进程，原A5独立，缺证据的历史保持已有fallback。
- 实际修复：默认skip发布时注册完整验证过的纯START事件；后续observer按序补记capabilities=[]，严格核对返回游标/完成身份后才同步，不动下一cue registry、不mirror旧START。整轮observer串行，最后cue直接总结也先补记；reset清缓存与旧token。
- 验证：真实Adapter两cue原先连续两次同步失败；14新tests含下一cue实际反思诊断、全部skip最终COMPLETE、并发顺序、错身份/结果门/reset/错cursor和零工具/旧head。109相关tests、TS和production build通过。[证据](validation/SKIP_LIFECYCLE_CONTINUITY.md)。代理RELEASE，probe清理，主控读真实diff与输出。
- 限制/后继：未真实UI/网络，运行期凭据不为旧历史造证据。此次实测表明Graph可能用现有COMPLETED返回拒绝的旧请求；现有observePresentedCue只判status，下一项只用真实默认/手动已展示路径核实是否会误确认游标，不预设漏洞或重做完整性审查。原A5独立。

## 已交付：跳过反思后的立即讲解（2026-09-26）

- ID skip-reflection-flow，基线136c101 clean；root拥有必要Host/辅助函数/测试/docs，revision_semantics_review默认配置5分钟只读预检异步消费（8分钟上限）。已读emil/apple，复用原FALLBACK三段讲解，不新增动画或布局。
- 实际线索：skipTeachingReflection在显示已准备的基础讲解前，依次等待互动保存、Graph同步与提交；按钮无busy，已存在SKIPPED/UNKNOWN和下一段的领域行为，缺口可能是本地显示被后台等待阻挡。
- 目标/验收：A1真实入口延迟依赖的小复现；A2跳过立即展示基础讲解且保留SKIPPED；A3原interaction→case→runtime head顺序和失败提示保持，切cue/接管后晚返回不覆盖；A4相关tests/TS/build、证据和push。只修实际等待路径，不改判断质量门或重复造Graph状态机。
- 风险/资源：先模块小例，无真实模型/Demo/用户DB/UI/服务；旧请求不得覆盖新cue，不能因乐观显示冒称已保存，不能在未保存互动时提交新head。新helper若需要必须由Host实际消费，测试不复刻另一条流程；root清理所有测试进程，原A5独立。
- 实际改动：Host使用skipReflectionToBaseline先发布/Session记一次skip，同步ref挡重复；后台用捕获history保存一次最终case，切cue后拒绝旧Graph发布和head。submit首次await前认领epoch，skip清理旧busy；拒绝Graph预算耗尽后返回的既有ANSWERED case。未改判断、工具或保存协议。
- 证据：9个新deferred/真实Session/HistoryController/Graph小例及105其他相关测试、TS与production build通过。证明等待互动或Graph时已可继续、错误不提交head、换owner不写新review、正常v1一次和真实ANSWERED→SKIP竞态。[记录](validation/SKIP_REFLECTION_FLOW.md)。默认代理窄审已RELEASE，主控读diff并处理三项实际竞态。
- 精确限制/后继：未挂载完整React/真实浏览器，UI A5仍独立。立即继续可能令旧cue未同步Graph，后续走既有local fallback；下一有限任务据此核实跨cue生命周期跟进是否能在不等待、不回退游标的条件下保留连续诊断，先小真实Controller序列验证，不伪造远端成功。

## 已交付：工具选择摘要的完整条件（2026-09-26）

- ID policy-summary-conditions，基线da0f511 clean；root拥有生产/文档，revision_semantics_review默认配置独占新policy-summary-conditions.test.ts，8分钟首例/12分钟上限。先核实合法长Narration→实际Host/Graph Policy输入，不能只看slice宣称错误。
- 目标/验收：A1真实输入尾部否定/条件丢失红例；A2既有240字符和总预算内整段保留或明确整段省略，不能将半句与原引用当完整；A3短内容、工具资格、取消/恢复及默认确定性行为保持；A4相关tests/TS/build、证据和同分支push。没有复现则闭合假设。
- 边界/风险：不扩模型预算、不改Narrator讲解正文/持久化/工具权限，不泛化全文摘要重构；明确默认deterministic和可选Provider影响，provider仅mock，不模型/网络/用户DB/Demo/UI/安装。进程由执行者清理，原A5独立。
- 实际链：合法长fact→deterministicNarration及两处正常语义校验→真实Host/Graph中240字符前缀丢条件；显式旧focus多能力Policy spy也收到截断。2红1绿；默认当前单能力走RULE，未声称默认模型误判。
- 修复/交付：正文+refs+限定整体超预算则明确整段省略并清refs，短文/240边界完整，原正文不变。最终7新tests及34其他相关tests、TS和production build通过；代理RELEASE，主控追加预算反例并审阅真实diff。[证据](validation/POLICY_SUMMARY_CONDITIONS.md)。无后台资源。
- 下一项转回默认带看体验：已定位面板“跳过，直接看分析”→skipTeachingReflection与UNKNOWN/SKIPPED投影；有限核实用户不填反思时实际分析/保存/继续下一段是否连贯，不把已有按钮当缺失功能，也不再扩大摘要完整性检查。

## 已核实：旧位置标注被当前工具资格门挡住（2026-09-26）

- ID annotation-consumption，基线4d25954 clean；主控拥有必要实现/测试/docs，revision_semantics_review默认配置8分钟只读追踪实际Adapter→cue→Stage3/Stage2/诊断，不改文件或启动服务。
- 目标/流程：缺失本人快照的不确定性cue，旧raw.state位置是否成为可展示的教学地图证据。A1实际消费和资格门；A2合法新鲜对照；A3仅真实误导才窄修，不改focus/compiledPlan制造失败；A4相关tests/TS/build、证据和行动结论push。
- 风险/边界：现行判断focus可能已阻止所有地图工具，遗留字段本身不等于用户错误。先小fixture，不读Demo/用户库、不模型/UI/安装；默认教学门和旧已保存产物保持，15分钟调查上限，执行者清理自己的小探针与进程。未发现缺口则闭合假设并选择实际体验改进，不做无收益“防御性”重构。
- 实际结果：stale/missing/fresh三种正式REVIEW_UNCERTAINTY都保留annotation，但真实Stage2/Stage3入口均无地图capability，诊断不传annotation/callout/坐标。显式Stage2 Host拒绝零能力结果。未发现当前可达误导，不改生产；新增4项跨层回归，59相关tests、TS及production build通过。[证据](validation/ANNOTATION_CONSUMPTION.md)。代理已RELEASE，无后台资源。
- 下一独立线索：Stage3工具选择摘要对每段讲解截240字，但保留原引用；下一轮只小验证合法长讲解尾部条件是否在实际Policy输入中丢失，明确确定性/可选模型入口区别，不调用模型、不扩大摘要预算或重做全文审查。

## 已交付：状态栏旧采样误用修复（2026-09-26）

- ID decision-state-freshness，基线9a8d6f5 clean；主控真实链/必要View改动及docs，revision_semantics_review默认配置独占新decision-state-freshness.test.ts，先调查不改生产。
- 假设：View的最近旧状态可能与Snapshot null/当前缺本人矛盾。但Adapter常把decisionTick设为合法前一采样，且已有Snapshot门会去掉旧state事实/context，不能单凭无界查找函数宣称bug。A1实际Adapter→有效cue→View/恢复链小例；A2合法前置采样保持；A3有真实误导才窄修，否则记录拒绝门证据并关闭该假设；A4相关tests/TS/build和行动结论push。
- 风险/阶段：最多8分钟首例+5分钟额外合法候选，不手改compiledPlan/降低提名门制造红例；候选被拒不是UI失败。合成fixture时间，不实测Demo；无模型/用户DB/UI/安装，root保护其他工作树，原A5独立。
- 实际复现：独立WIN_RATE_DROP仍可产生不确定性cue；本人采样过旧或当前帧缺本人，Snapshot为null、事实/讲解已排除资源，但View显示旧40HP/75甲/ak47/$1,234。实际Adapter链7tests中2红→绿，DEATH/HP_CHANGE既有拒绝门与合法前置采样保持。
- 仅View复用玩家/sample/decision/canonical引用绑定，禁止旧行恢复个人资源；未知提示优先。Parser/Adapter/Planner/候选门不改。65相关tests、TS、production build通过；代理默认配置完成新测试并RELEASE，主控审阅真实diff。[证据](validation/DECISION_STATE_FRESHNESS.md)。
- 下一项：小验证候选annotation仍使用raw.state的位置是否进入不确定性cue的实际教学呈现；先追消费和复现，无误导不改。原A5独立等待桌面条件。

## 已交付：教练状态栏显示已确认道具种类（2026-09-26）

- ID utility-kind-chip，基线81fc947 clean；主控View/Host接线/样式和单元测试/docs，partial_revision_restore默认配置独占上一轮SQLite恢复集成测试，其他owner RELEASE。已读emil/apple与Next测试指南，沿现有chip反馈，不加动画/依赖。
- 流程：当前cue决策采样+相同玩家/时间/sourceRef的受限Snapshot种类→中文标签+数量未知；完整空沿现有无道具，精确数量旧行为保持，完全unknown不造标签。A1实际Adapter产物当前显示Flash/Smoke；A2错player/tick/决策/source/unknown/非法列表均不显示；A3长列表在现有chip内换行，SSR验证真实渲染/来源，reduced motion/transparency不新增依赖；A4SQLite重开也显示种类、零新生成，相关tests/TS/build与证据push。
- 风险/边界：新种类只用于展示，不授予专业判决、推断颗数或修改保存数据；Host显式传decisionTick避免跨cue拼接。5分钟小回归/10分钟实现/15分钟验收，测试60秒，子任务临时库finally清理；不重试锁屏浏览器路径、不模型/真实Demo/安装/用户DB，准确区分SSR与真实UI未测，原A5独立。

- 结果：已确认Flash/Smoke等显示中文种类+数量未知；Host传当前decisionTick及实际canonical决策事实，错身份/时间/引用/unknown不显示。修正初raw/canonical ref层级误配而未降低引用门；真实生产status组件SSR及长标签通过，CSS限宽换行。SQLite恢复两红→六绿、42相关tests/TS/build通过。[证据](validation/UTILITY_KIND_CHIP.md)。
- 清理/限制：两个默认代理RELEASE、临时SQLite/进程清理；无模型/用户库/安装，SSR不是浏览器布局实测，原A5独立。下一有限核实：playerStateAtOrBefore无最大年龄，而旧health/armor chip无Snapshot绑定；用实际Adapter/恢复小例判断是否真会缺当前样本却显示旧资源，有复现再窄修，不把合法前置采样当错误，不做全UI审计。

## 已交付：库存语义的SQLite恢复（2026-09-26）

- ID inventory-history-restore，基线12778fe clean；partial_revision_restore默认配置独占新inventory-restore.integration.test.ts，主控读真实恢复链/必要生产修复及文档，其他owner RELEASE。不重复Parser验证或读取Demo。
- 目标/流程：当前Adapter1.11/Timeline1.2合成库存empty/Flash/Smoke/unknown→实际DesktopReviewLibrary隔离SQLite保存分析、候选、路线、讲解和recovery/runtimehead→close/reopen→artifact validation/HistoryRestoreController/实际恢复函数→教练View/数量投影。A1真实库重开保存语义保持；A2仅明确空为0/无道具、种类不冒充颗数；A3恢复使用已存route/narration，不新分析/生成；A4相关tests/TS/build和证据push，有失败才改生产。
- 风险/边界：必须保存有效route/hash/recovery身份链，不能手拼无效快照绕过验证；源为合成fixture时间，不冒充真实Demo实测。5分钟链路/12分钟小测试/25分钟交付，每轮test60秒，mkdtemp库/伪Demo字节仅测试身份，owner finally关闭并只清自建临时目录；无真实用户DB、模型、网络、浏览器或安装，原A5独立。

- 结果：新6情形通过，主控4文件45tests/TS/build通过。真实SQLite关闭重开→GET/HistoryRestore/恢复orchestrator/View保持空/种类/unknown，health/refs有效；冻结路线验证1次，重新分析/Narrator/prepareNarration/transport/Viewer source-load0，产物不改，READY_TO_START。无生产缺口，仅新增集成回归。[证据](validation/INVENTORY_HISTORY_RESTORE.md)。
- 限制/下一项：合成Replay+微型资料库header，不是真实Demo/旧Artifact迁移/Graph/UI。agent默认配置RELEASE、临时库及所有进程清理，原A5独立。下一可见改进是当前View只显示精确数量，已确认Flash/Smoke种类因数量未知没有状态chip；按同一决策身份/采样边界显示已确认种类并标数量未知，保留明确空/完全unknown区别，沿现有chip无需新复杂UI。

## 已交付：收起主枪当前库存（2026-09-26）

- ID primary-inventory-identity，基线2b36007 clean；主控Adapter来源/真实消费/docs，partial_revision_restore默认配置weapons/lib+0019/tool，revision_semantics_review默认配置primary源fixture及必要旧grenade helper提取适配。
- 流程：可靠动态向量N前缀→所有当前handle与标签完整验证→第一primary优先、否则第一pistol，未知空串保持schema省略。A1实际源tail/partial/earlyreturn红例；A2合法优先级/USP保持、grenade/active回归；A3普通Viewer持刀时primary与经济统计不消费历史物品，Host本来显示active不扩宣称；A4相关tests/TS/Web及WASM/Viewer build、真实只允许primary字段变化、文档push。
- 风险/边界：不重复长度probe或改整个装备系统；可抽窄完整inventory helper防规则漂移，但旧grenade验收不降低。不因先见rifle就漏后续unknown。5分钟接口/12分钟实现/20分钟交付，root唯一60.6MB前后WASM各120秒、bulk留进程+压缩基线，纯统计，清理自建资源；不模型/安装/UI/用户DB，原A5独立保留。

- 结果：实际primary9红/3绿→12绿，grenade旧11断言全绿；实际Viewer/经济选择9断言、88相关tests、TS/Web及native9+vendor33/WASM/Viewer build/TS通过。真实19,777行primary变化，18,655旧标签消失、683处于持刀展示条件，所有非primary字段及回合边界保持，10人消费通过，0网络。[证据](validation/PRIMARY_INVENTORY_IDENTITY.md)。
- 清理/后继：两默认代理RELEASE，无must-fix，临时fixture/checkout和所有进程退出。空primary仍未知/无枪合并回退，不作专业质量或完整经济/UI结论。source修复阶段收敛；下一有限目标为当前库存Adapter1.11/Timeline1.2的明确空/种类/unknown经隔离SQLite保存重开→History Restore→View保真及零重分析，已有JSON往返不足以替代这条恢复链；只在有失败时改生产，保护用户库，原A5独立。

## 已交付：道具库存完整性（2026-09-26）

- ID grenade-inventory-certainty，基线b99d12e clean；主控Adapter/只读probe/真实消费/docs，partial_revision_restore默认配置生产0018/patch工具，revision_semantics_review默认配置源注入inventory fixture；其他owner均RELEASE。
- 已证实：get_iter返回只增不减的历史children；真正空Vec此前序列化省略，不能误称[]。partial列表误断言没Flash，去重类型数量被错误叫颗数。首probe72,273pawn全children414,532槽有大量旧/不存在实体；根length后197,474当前槽全部合法、217,058历史尾槽，18,536显式N0。按本地ValueVector源码和demoinfocs一手Issue450核实父length语义。
- 流程/验收：根strictN<=64→只前N严格packed/可分类→完整Some(kinds)/明确空Some[]/任何未知None，版本1标记；Adapter旧无标记或None保持unknown，已知种类可做presence但非空不冒充颗数，空完整才0。A1真实源shrink/partial红例；A2unknown/empty与类型/颗数分离，保留其他资源；A3历史产物直接读、旧raw不追认完整；A4相关tests/TS/Web和parser/Viewer build，真实一次最终消费比较非库存字段/边界保持，文档push。
- 风险/所有权：Option/schema+collector/assemble透传，不改primary/整个背包；主控更新旧frame fixture Option stub。5分钟接口/12分钟实现/20分钟验证；两个必要native probe分别单read、单进程，bulk本地，120秒stage/finally清example，不安装/模型/UI/用户DB。未知项不当空slot，合法类型列表不当总颗数；原A5独立。

- 结果：源回归8红/3绿→11绿、旧frame fixture10绿；273相关tests+10教练View tests=283、15patch、native9+vendor33、TS/Web和WASM/Viewer build/TS通过，1既有WebGPU产物测试跳过。Option/version1→明确完整/空/unknown；去重types不冒充颗数。真实最终72,193行中48,315空、23,878非空、0unknown，8,774条旧有道具改当前空；所有非库存字段/9回合边界保持，10人消费通过，0网络。[证据](validation/GRENADE_INVENTORY_CERTAINTY.md)。
- 接线收尾：独立审查发现View局部计数漏inventory.count，实际Flash/Smoke被说无道具；两红后改纯共享projectDecisionUtilityCount并复验，known[]仍无道具、其他不伪造零。root遵循已读UI技能/Next测试文档，不需要锁屏UI。两代理RELEASE，全部进程/临时目录清理。
- 后继/限制：数字为重复采样行，非独立错误数；旧保存不重算，需新解析应用修复，无UI/DB/专业质量实测。下一项已证primary_weapon也读动态向量全children，先核实收起主枪的真实源和Viewer消费，再做局部长度/身份修复；不猜物理颗数或重写整装备系统。原A5独立保留。

## 已交付：活动武器即时身份（2026-09-26）

- ID active-weapon-identity，基线546ac82 clean；partial_revision_restore默认配置独占0017/patch工具/upstream weapons/assemble/lib，revision_semantics_review默认配置独占源注入武器/knife fixture，主控Adapter/真实消费/docs。
- 目标/流程：m_hActiveWeapon network packed→当前匹配实体→武器名称/资源消费；失效保持unknown空串，不能读替代实体或作为“无人持枪”的刀局证据。A1原函数生命周期红例；A2合法标签/USP行为保持，不native转换、不按alive拒绝；A3两knife推断拒unknown、不影响respawn；A4相关tests/TS/Web和parser/Viewer build、已有已验证当前帧基线对照单次真实消费、文档push。
- 边界/风险：不改primary/grenade_inventory/label映射表、不新schema，不把unknown当刀/空手或拒整player。5分钟接口/12分钟实现/20分钟交付；根单Demo进程120秒，仅统计，复用上一轮已验证546ac82 projection避免重复baseline parse；bulk本地gzip，不网络/安装/模型/UI/用户DB，原A5独立保留。

- 接线补充：真实Viewer domain/rounds.ts也把空武器或空players判刀局，影响0编号和统计排除，已纳入0017窄修；root拥有新knife-rounds-source.test.mjs，实际旧源4红/1绿、当前patch函数5绿。沿emil/apple已读设计技能保持准确状态反馈；pure domain逻辑，不改布局/动画或需要锁屏UI验收。无frames pregame独立规则保持。

- 结果：实际武器/Parser knife源6红/4绿→10绿，Viewer源4红/1绿→5绿；82相关tests+14patch tests、native9+vendor33、TS/Web及WASM/Viewer build/TS通过。本轮单次60.6MB parse7.555秒，真实7239帧/72193玩家行和9回合边界JSON字段与已验基线一致，10人消费通过，0网络。[证据](validation/ACTIVE_WEAPON_IDENTITY.md)。
- 后继/限制：unknown刀局保守不识别，不声称外部武器真值/完整名单/UI质量。已核实grenade_inventory仍index-only解析m_hMyWeapons且缺字段返回空数组，下一项先小例明确道具误归属与unknown/empty资源语义，再决定窄改；不泛化全背包。全部进程/临时目录清理，两个默认代理分工结束，原A5独立待验。

## 已交付：玩家采样packed身份（2026-09-26）

- ID frame-pawn-identity，基线af8e53a clean；主控Adapter/真实消费/docs，partial_revision_restore默认配置先接口预检后props/collector/assemble/lib和0016工具，revision_semantics_review默认配置独占源注入fixture/harness；已核实现有owner均RELEASE。
- 目标：controller network packed句柄→当前匹配pawn→本人位置/资源，拒绝错serial/错class/冲突绑定；不把native转换套到network。A1实际采样入口生命周期红例；A2死pawn合法/当前绑定字段保持，未知不造错人状态；A3缺行不得使all-alive respawn提前（内部frame完整性）；A4相关tests/TS/Web及parser/Viewer build、真实前后消费比较、文档push。
- 风险/阶段：玩家缺行会影响respawn和名单，需要同时查assemble/Adapter降级；不修改public Frame schema、cache/ADR/其他handle。5分钟接口、12分钟实现、20分钟交付；主控唯一60.6MB Demo控制器，bulk本地进程和临时压缩基线、仅统计输出，单运行120秒，不安装/模型/UI/用户DB。原A5独立保留。

- 结果：真实采样/assemble源注入8红/2绿→10绿，80相关tests/13patch tests、native9+vendor33、TS/Web和WASM/Viewer build/TS通过；新增内部完整性同时保护respawn和两knife推断，缺当前名单不补旧人。真实7239帧/72193玩家行及9回合边界JSON字段一致，10人消费通过。[证据](validation/FRAME_PAWN_IDENTITY.md)。
- 验证纠偏/后继：直接runtime-vs-JSON深比较误报-0，离线projection相等后简化JSON正规化，最终18行负零；共旧1/新3次parse，无产品改动迁就测试。全部进程/临时资源退出，两默认代理RELEASE；单样本不外推零缺行，无UI/DB质量结论。下一项有真实源码线索active_weapon_label的weapon handle仍index-only，弹药校验却已严格；先小生命周期证实错武器标签可能性和资源消费，避免全背包泛化。原A5独立等待。

## 已交付：几何字段完整性证据（2026-09-26）

- ID geometry-field-evidence，基线fe1941a clean；主控独占geometry-fields诊断probe/真实读取/docs，revision_semantics_review默认配置只读消费链8分钟预检，其他owner RELEASE。
- 流程：实际cell/offset属性→区分missing/wrongtype/nonfinite/合法zero→tick_start stride8和death/plant/fire事件当前pawn统计→据证据决定下一修复。A1查实际默认值与Adapter/Viewer消费；A2小分类测试再单60.6MB native probe、1024tick smoke后同parser继续；A3只返回统计不泄露ID/坐标、保持unknown；A4相关tests/TS/build、行动结论与push。未证真实发生前不泛化生产几何协议。
- 风险/清理：vendor+locked+offline已有工具链，单编译/运行120秒，唯一controller finally移除临时example；bulk单进程，无安装/模型/UI/用户DB。几何缺失不能等同玩家死亡/缺身份，合法零不能当unknown；必须核实插值/旧数据兼容。原A5独立待验。

- 结果/决定：1项Rust分类测试、26相关tests、TS/build通过；native单读60.6MB 0.776秒，72,273pawn/73death/7plant/1,590fire六字段缺失/错类型/非有限均0，0事件pawn解析失败。没有实际缺口证据，不改跨层生产几何协议；若未来有缺口必须保留非几何名单/资源并门控插值，不能删整player。[证据](validation/GEOMETRY_FIELD_EVIDENCE.md)。
- 交接：只读代理默认配置已RELEASE，唯一controller finally清example，全部进程退出，无模型/用户DB/安装/UI。下一独立目标为collector玩家采样network packed句柄仍走index-only lookup，先源注入生命周期验证是否误采替代pawn状态，再定局部校验；不复用native转换，不重复同样本几何probe。原A5独立待验。

## 已交付：player_death即时身份（2026-09-26）

- ID death-identity，基线e7fba6b已push且启动干净；总goal已创建。主控整合/文档，子代理`/root/revision_semantics_review`默认配置独占只读链路预检，8分钟期限；无生产并写。
- 目标/流程：collector→RawEvent Kill→assemble/schema→Viewer/Adapter，先核实非空victim协议，再选择只改death分支的兼容当前pawn方案。A1列出nonnull victim和几何依赖；A2合法未知attacker/assister保持null，失效victim不造人或位置；A3小生命周期红例后再实现；A4相关tests/TS/production和parser构建、真实消费、文档push。
- 风险/边界：死亡事件时pawn可能已消失，直接机械替换可能丢合法事件；不得放松serial或用旧cache补未知。预检禁止Demo/build/安装/UI/模型/写文件；先3分钟接口、8分钟行动结论，主控随后接线和资源清理。明确排除ADR/userid/network handle，原UI A5独立等待。当前预检已派发，下一heartbeat先读代理结果，不重复派发。
- 预检完成：非空victim依赖RawEvent/schema/replay-core、Viewer计分/死亡点及Adapter死亡证据。根任务确定只在当前验证pawn+唯一owner时发Kill，未知victim保留既有skip，三方不使用alive资格；坐标字段缺省本轮不扩展。partial_revision_restore独占0015/patch工具/upstream collector/lib；revision_semantics_review独占death源注入fixture/harness；主控Adapter/真实消费/docs，默认配置。修前生产WASM真实60.6MB样本单parse7.180秒、73个Kill，紧凑基线留忽略目录用于修后覆盖率比较。


- 结果：源注入9红/1绿→10绿；98相关tests、12patch tests、native9+vendor33、TS/Web与WASM/Viewer build/TS通过。真实样本73个Kill完整字段与基线相同，10人Adapter消费正式范围64死亡、9个边界外事件仍保留；旧1次/新2次解析，最终7.112秒，0网络。首验证脚本混淆Parser与教练范围已修正，失败输出改固定代码避免dump真实身份。[证据](validation/DEATH_IDENTITY.md)。
- 所有权/后继：两默认代理已RELEASE，根diff复核/独立只读审查完成，进程与临时checkout已清理。未知victim仍skip，单样本不能外推零损失；无真实UI/DB/专业质量结论。下一可独立核实线索为world_coord缺cell/offset默认值可能形成貌似有效坐标，先统计真实字段缺失并查Viewer/分析未知几何消费，再决定是否需协议改动；不为默认值代码本身就声称真实bug发生。原锁屏A5独立保留。

## 已交付：Bomb事件即时归属（2026-09-26）

- ID bomb-identity，基线0f94799 clean；主控Adapter/证据/集成，partial_revision_restore独占0014补丁、patch工具与upstream collector/lib，revision_semantics_review独占源注入Bomb fixture/harness，均默认模型/推理，复用已释放checkout。
- 流程：native事件handle→当前验证pawn和唯一controller→公共Bomb事件及plant几何→Adapter本人动作。A1旧serial/错class/缺handle保持公共kind/tick且actor/geometry unknown；A2同tick重绑用当前owner、缺owner保留有效plant位置；A3已知本人plant/defuse仍可用、未知不变本人动作、爆炸不是本人动作；A4来源版本、相关tests/TS/Web和parser/Viewer build、一次真实Demo消费、文档push。
- 风险/边界：只改三种Bomb事件，不泛化network m_hThrower；低10serial不能证明未传输高位。0014须可受控追加、既有补丁不能随尾索引漂移。5分钟接口/12分钟实现/20分钟交付；根任务统一vendor+locked工具链和120秒单次60.6MB Demo，bulk留进程、只输出摘要，负责清理。无安装/模型/用户DB/UI，原A5独立保留。

- 结果：实际旧分支8红/2绿→当前10绿；Adapter来源两红修复，已知hurt/shot/ammo/bomb链完整、unknown actor不造本人动作。89相关tests/11patch tests，native9+vendor33、TS/Web build、WASM/Viewer build/TS均通过。真实60.6MB单read/parse 7.407秒、10个公共Bomb事件、10人bundle消费8个plant/defuse个人事件，0网络；[证据](validation/BOMB_IDENTITY.md)。
- 交付/后继：两代理默认配置已RELEASE，主控真实diff及只读终审无must-fix；临时资源/进程已清，旧历史不重写，未验证UI/SQLite或外部身份真值。下一独立目标已核实player_death仍旧缓存解析三方身份和index-only坐标，victim缺失直接丢事件；先核实非空victim schema/Viewer消费与生命周期红例，再选兼容修复，不机械替换全局helper。原UI A5独立等待。

## 已交付：Spotted候选位映射与当前身份（2026-09-26）

- ID spotted-identity，基线87f9694 clean；主控只读probe/tests/docs，revision_semantics_review默认配置3分钟只读风险复核、已RELEASE。slot公式是外部解析器实现假设，不是独立Valve语义证明。
- 流程：Option低/高word→controllerEntityId1..64对应bit0..63→当前唯一有效controller/pawn packed匹配→仅统计。A1bit1/32/33/64、missing段与zero、无效ID；A2同index新serial/解绑/错class/重复绑定/无效身份unknown；A3小回归后单60.6MB Demo1024tick smoke再同parser继续，输出无ID/坐标/rawmask；A4相关tests/TS/build与证据push。
- 风险/边界：低10serial不是完整native身份；映射不等于真实LOS/感知，sample间重绑仅telemetry不补当前缺失。vendor+locked/offline命令，不安装/改锁；unit/build/run各120秒、唯一controller finally清临时example。常量规模snapshot，原始字节单进程，不接Replay/Observation/模型/用户DB，原UI A5独立。

- 结果：3个Rust单测覆盖边界位、单段unknown/zero、ID范围、当前serial/解绑/错class/重复pawn或身份、非法packed与高index；native锁定vendor构建成功。既有60.6MB Demo最终0.843秒：6,573置位样本全部可按候选公式映射当前双方身份，0自指/未解析对；72,283有效当前绑定，7,445未知controller样本，连续采样重绑0（不能声称真实重生已测）。37相关tests、TS/build通过。[证据](validation/SPOTTED_IDENTITY_MAPPING.md)。
- 范围/后继：候选位公式来自外部解析器，覆盖率不是独立语义标注，更不证明LOS/雷达/感知；当前仍不接生产Observation。最终高index守卫补强后复验，因此共两次单pass，锁不变、临时example清理。此spotted路径先保留研究结果；下一独立目标已核实collector bomb_planted/defused仍走旧steam_from_pawn_handle缓存/索引解析，复用既有native/packed生命周期夹具小验证事件归属，不再为缺乏spotted语义重复读Demo。全部进程退出，无模型/用户DB/UI，原A5独立保留。

## 已交付：真实可见性字段与上游语义（2026-09-26）

- ID spotted-source-evidence，基线b652845 clean；主控真实接线/只读probe/docs，revision_semantics_review默认配置一手来源研究10分钟，无并写。沿用research技能和用户要求记录行动结论。
- 已核实adapter只把本人位置映射SELF DIRECT_VISION；当前cs2d collector/props/schema未读取spotted，不能从合成Observation测试推出敌方视线。目标核实网络字段可读性和语义边界，先不接教练。
- 流程：固定cs2d/source2-demo依赖→通用属性probe→既有60.6MB Demo单进程单次读取→1024tick smoke，字段可读才同parser继续→只输出统计。A1一手源码区分spotted与LOS；A2missing/type错误与false/zero分离；A3无身份/坐标/rawmask或大数组输出，不做observer映射；A4相关tests/TS/build及学习证据push。
- 风险：属性路径与数组编码未知，禁止用prop_bool缺省false冒充未标记；offline编译120秒、单pass120秒，临时example由唯一Python owner finally移除，只保留小probe/摘要。未证语义绝不接DIRECT_VISION或宣称玩家已知，不安装/改锁文件/模型/UI/用户DB，原A5独立待验。

- 结果：一手demoinfocs v5.2.0明确spotted不是LOS/FOV；CounterStrikeSharp仅证明bool+uint32[2]字段布局。当前adapter只生成本人位置，生产parser无spotted接线。正确vendor source2-demo0.5.4、locked/offline native探针在60.6MB样本读到扁平路径：72,283 pawn样本中bool与低mask各5,258非零，高mask全零；嵌套路径全部missing。1024tick smoke后同parser继续，1.111秒，仅统计输出。[证据/来源](validation/SPOTTED_SOURCE_EVIDENCE.md)。
- 编译纠偏：初次通用cargo漏本地vendor配置，离线更新了构建checkout的lock并读了一次样本；该次不作当前生产依据。已恢复本任务引入的libredox更新与source2 registry绑定，随后vendor+locked/offline重跑成功且lock不变。总两次读取，无下载/安装/用户文件修改；临时example finally移除，probe源码保留可复现。37相关tests、TS/build通过，研究owner RELEASE。
- 后继：确认字段可读仍不能接教练视线。下一项有限raw-mask解码/身份映射验证（边界bit0/31/32/63，controller与当前pawn、重生/缺失未知），保持诊断隔离；若映射或语义不足就只保留raw标记研究结果，不补造可知敌情。无用户DB/模型/UI，全部进程退出，原A5独立待验。

## 已交付：拥挤Brief优先保留完整纠正（2026-09-26）

- ID correction-budget-priority，基线d0794ff clean；主控独占brief.ts/memory.test.ts及必要接线tests/docs，现有owner RELEASE。
- 目标/流程：含用户纠正的Brief超800→从尾部整条移除低优先级记录/线程及必要偏好→仍超限才舍第二条纠正→完整保留可容纳的首条或安全EMPTY。A1拥挤长thread不再带走能单独容纳的纠正；A2两条短纠正优先于大record/advice；A3原文/limits不截断、source对象不变、身份/授权/无纠正原路径保持；A4相关tests/TS/build及窄审、文档push。
- 风险：舍记录必须连advice一起舍，不能只删限定；纠正单独加必要限定仍超额时继续EMPTY，不承诺无条件召回。5分钟红例、10分钟实现、15分钟验证；不改query/存储/预算/模型，无用户DB/服务，主控清进程，原锁屏A5独立待验。

- 结果：2红转绿，超长thread不再带走可容纳的首条完整纠正，大record不再挤掉两条短纠正；记录连同advice整体去除，无输入变异。新增首条纠正+顶层限定仍超额的EMPTY覆盖，不截任何纠正文案。5文件72tests、TS/production build通过；revision_semantics_review默认只读终审无must-fix、RELEASE。[证据](validation/CORRECTION_BUDGET_PRIORITY.md)。
- 限制/后继：按当前有序召回数组舍尾，不是智能相关性排名；默认教练仍仅用纠正提示复核。Memory文本传递本轮阶段收敛。下一项转向可知信息证据：libs/observation支持DIRECT_VISION/SPOTTED，但本轮rg仅发现合成/契约用例，尚未证明当前parser提供真实输入；先查实际生产接线与上游一手源码，明确可采集语义，不能凭spotted字段名授予真实视线或队内语音。无模型/用户DB/服务，测试/build退出，push后释放；UI A5独立待验。

## 已交付：长用户纠正完整传递（2026-09-26）

- ID complete-user-correction，基线4bffdb5 clean；主控拥有brief.ts、history-idempotency.integration.test.ts、memory.test.ts/docs，所有旧owner RELEASE。
- 流程：220字后含否定的合法≤500字异议→真实diagnose/revise/producer→临时SQLite→getBrief→真实POST→Graph。A1实际截断红例；A2完整USER原文、revision和原目标不变，未知仍未知；A3超预算整条放弃/EMPTY而非截字、删除授权门保持；A4相关tests/TS/build及证据push。不扩语义判断或token门。
- 风险/阶段：调度预算仍可能舍掉整条次要纠正，不能承诺永远全部召回；Memory管理纠正可长于对话500上限。5分钟小链、8分钟实现、15分钟验证；复用已有SQLite finally/after拦截，无用户DB/服务/模型，主控清进程，锁屏A5独立待验。

- 结果：真实SQLite→POST→Graph红例证明220字截断丢掉末尾“其实没有语音，也不是固定战术”；单行改为完整content后通过，原目标/幂等/consent链保持。两条域内近1200字纠正超预算时只留完整第一条，拥挤长规则触发EMPTY全清而非半句。4文件69tests、TS/build通过，主控集中复核，无新并写owner。[证据](validation/COMPLETE_USER_CORRECTION.md)。
- 限制/后继：默认教练仍只用纠正存在性选模式，未实现语义采纳，旧已保存Graph不重写。本轮拥挤fixture也给出下一项真实机会：最新完整纠正单独能放入800预算，但一条超长thread会让整份EMPTY，连纠正一起丢；下轮优先评估先剔除低优先级整条线程/记录以保留完整纠正，保持身份/授权与总预算，不截字。无用户DB/服务/模型，测试/build退出，push后释放；原UI A5独立待验。

## 已交付：长条件建议完整传递（2026-09-26）

- ID complete-conditional-advice，基线123c305 clean；主控拥有brief.ts/memory.test.ts/docs，现有owner RELEASE。实际helper分别对rule和advice的when/do/unless截字，尾部“不要执行”可丢失。
- 流程：合法Memory域规则/独立advice→Agent投影→完整条件字段或原预算安全EMPTY。A1when/do/unless尾部否定红例覆盖record/thread与独立advice；A2三字段原文整体保留，不只改unless；A3总800预算不增加，超限不留残缺建议，身份门保持；A4相关tests/TS/build及窄审，文档commit/push。
- 边界/风险：保留长字段可能更常触发原EMPTY，不能以增预算或丢条件换成功；不用文本摘要猜语义，不改promotion/数据库/旧记录。5分钟红例、8分钟实现、15分钟验证；内存夹具无用户DB/模型/服务，主控清进程，原锁屏A5独立待验。

- 结果：when/do/unless三个红例均确实截掉末尾“不成立就不要执行”；现在record/thread规则和独立advice完整保留三个字段。合法近800字字段组合超预算后连同advice全清；4文件67tests、TS/production build通过。主控集中复核六处字段替换，未改其他摘要/身份/生命周期，无新增并发owner。[证据](validation/COMPLETE_CONDITIONAL_ADVICE.md)。
- 限制/后继：长规则可能更常EMPTY，默认短规则正常；历史advice无limitations无法凭空补齐，其他summary/claim截短未泛化修改。下一项明确线索是同Brief的correction.content仍截220字，用户异议原文可500字；用末尾否定的小例核实，优先保留整条纠正或整条放弃，不扩大token门。无用户DB/服务/模型，测试/build退出，push后释放，原UI A5独立待验。

## 已交付：跨Demo聚合后的不确定性保留（2026-09-26）

- ID uncertain-recall，基线83bcb39 clean，主控独占uncertain-recall.integration.test.ts及必要brief/docs，小链先验证，无同文件并写。
- 流程：两份独立合成Demo身份→真实资源/信息diagnose→本地producer→MemoryService/InMemory adapter→Agent Brief schema。A1单份CANDIDATE/两份EMERGING实际路径；A2verdict INCONCLUSIVE、USER UNVERIFIABLE和条件建议保留，主体身份不外泄；A3撤回consent空召回；A4相关tests/TS/build及证据push。仅真丢失才改生产，不把EMERGING等同专业判断正确。
- 风险/边界：producer逻辑key需相同而Demo身份不同；不得直接伪造聚合结果。5分钟小例、10分钟局部实现（必要时）、15分钟验证；纯内存无用户DB/服务/模型，主控清进程；不新增完整性审计或旧数据迁移，锁屏A5独立待验。

- 结果：真实资源/信息两条链均CANDIDATE→EMERGING且verdict/claim未知保持，未改promotion；但Agent compactTransferRule丢整个来源limitations，两个正确指向该数组的红例复现。共享投影增加完整limitations，activeThreads和memories同时保留；12×240字合法大限制触发原EMPTY预算降级，记录/线程/标记advice全清，未提高800预算。4文件63tests、TS/build通过，补非空线程断言后2tests复验，独立只读方案审查无冲突并RELEASE。[证据](validation/UNCERTAIN_MEMORY_RECALL.md)。
- 限制/后继：纯内存生产链，不是SQLite/真实UI/模型质量；没有旧数据重写，record.advice旧协议本身无limitations。本轮只保证存活transferRule的限定完整。已核实同helper仍对when/do/unless各截140/180/140字，可能切掉尾部否定条件；下一项先构造合法长规则验证语义丢失，再考虑整条保留或整条放弃，连同advice副本一并明确，不扩大上下文预算。所有测试/build退出，push后释放，原A5独立待验。

## 已交付：条件测量与用户原话验证分离（2026-09-26）

- ID condition-claim-separation，基线f39355b clean，主控独占diagnosis.ts/tests/docs；现有owner RELEASE。目标是保留真实资源/人数测量与条件状态，但不把整体SUPPORTED/PARTIAL/CONTRADICTED复制给任意USER信念及refs。
- 流程：资源/人数→diagnostic result与hinge→USER原话单独保持未核实。A1“没甲”配100甲、同测量不同原话和零队友反例；A2保留数值/条件/引用/原文与最终保守判决，显式目标仍为用户自述；A3一次修订/Memory/恢复不受影响；A4相关tests/TS/build及只读窄审，文档commit/push。
- 风险/边界：未建立逐条主张对应证据前，不能从同主题条件测试推论原话真假。不是删测量或重算旧数据，不编新schema/NLP/模型。5分钟红例、10分钟实现、15分钟验证；无用户DB/服务/模型，主控清进程，原UI A5独立待验。

- 结果：5个有效红例复现（另1初版fixture未命中资源词，已改为真实可分类陈述）；同一资源测量不能证明任意原话，零队友条件也不直接否定先前预期。删除通用claim状态/refs复制，相关非GOAL未核实，诊断数值/条件/ref完整保留。旧覆盖缺口测试仍验condition PARTIAL，已不要求错误支持USER；7文件218tests、TS/build通过，revision_semantics_review默认只读终审无must-fix、RELEASE。[证据](validation/CONDITION_CLAIM_SEPARATION.md)。
- 边界/后继：不重算旧claim；GOAL仅支持自述，当前不自动验证自由文本命题。已读Memory policy两Demo可EMERGING及boundedClaims保留claim字段；下一项小例核实两个INCONCLUSIVE点进入Agent Brief时是否完整保留不确定说明，不能仅因生命周期活跃就改promotion策略，不重做存储审计。无模型/用户DB/服务，测试/build退出，push后释放；UI A5独立待验。

## 已交付：信息反证必须对应用户主张（2026-09-26）

- ID information-contradiction-boundary，基线313a8d1 clean；主控拥有diagnosis.ts/tests、相关两fixture断言/docs；revision_semantics_review默认配置8分钟只读输入契约，无并写。
- 目标/流程：负向decisionFact→真实信息诊断→无绑定具体主张/主体/时点的反证不能标CONTRADICTED/BELIEF_INCORRECT；事实仍可引用，返回准确未知边界。A1相同否定/无主张/听觉/不同地点/其他报点红例；A2不再通过regex定罪、不编新proof协议；A3修订/Memory旧目标与总结过滤仍工作，保存旧产物不重算；A4相关tests/TS/build与窄审；文档commit/push。
- 风险：只加更多否定词会继续误判实体/时点；若现schema没有可靠反证绑定，保守禁用该定罪分支，不能改成认定用户正确。不扩大模型/拒判实验，不放松引用门。5分钟小例、10分钟实现、15分钟验证；无用户DB/服务/模型，主控清进程，原UI A5独立待验。

- 结果：6个实际红例转绿，删除文本定罪helper及分支，保留事实refs、UNVERIFIABLE/INCONCLUSIVE与具体待核条件；不把视觉输入默认转述为声音。两处旧fixture不再要求错误定罪，但仍验证信息→同步的规则身份变化、Memory原对象和总结过滤。9文件179tests、TypeScript/production build通过；独审实际diff无must-fix，RELEASE。[证据](validation/INFORMATION_CONTRADICTION_BOUNDARY.md)。
- 限制/后继：当前信息诊断尚无可用的主张绑定反证，因此不能做肯定或否定判断；不是认定用户正确，旧保存结果仍可读且不重算。下一项已定位updateClaimVerification会把风险资源诊断整体SUPPORTED/PARTIALLY_SUPPORTED赋给任意RESOURCE_BELIEF并加入支持refs；用“我没甲”配100甲等真实小例核实，避免测量资源预算被当作验证任意原话。无用户DB/模型/服务/安装部署，测试/build退出，push后释放；UI A5独立待验。

## 已交付：纯目标与独立条件陈述分离（2026-09-26）

- ID goal-context-separation；基线b0ea734 clean，主控拥有teaching-diagnosis.ts/tests/docs；revision_semantics_review默认配置8分钟只读风险/终审，无并写。
- 目标：纯目标句（包括否定/疑问）不再重复产生敌情/队友/时间信念并劫持hinge；保留独立敌情、队友位置、窗口和执行陈述。A1初次及revision同反例红复现；A2只排除有限完整目标分句而不删除裸关键词，原文/来源保留；A3指定focus、肯定GOAL和独立事实条件保持；A4相关tests/TS/build、窄审与文档push。
- 流程：USER描述→只用于分类的上下文投影→typed claim与GOAL→hinge；不引入schema/模型/完整NLP。风险为删裸词吞掉“补枪窗口”、删词留下“队友”假信念、旧修订重复伪信念；5分钟红例、12分钟实现、15分钟验证，无用户DB/Demo/服务，主控清进程，锁屏A5仍独立。

- 结果：7个真实红例转绿；纯否定/疑问目标不再经信息/队友/时间/战术伪信念选错hinge。真实独立位置/敌情/补枪窗口/执行问题仍保留，指定focus/肯定目标保持；Graph一次修订也通过。独审发现旧自动TACTICAL_CONTEXT会把剩余“时间充足”仍当战术，增加omittedGoal门和旧混合反思回归后主控关闭。7文件132tests、TS/production build通过，reviewer只读RELEASE。[证据](validation/GOAL_CONTEXT_SEPARATION.md)。
- 后继/限制：有限完整目标分句规则，不处理任意否定/指代，不重算保存结果。下一项已读explicitInformationContradiction：只检查decisionFact含“没有看到敌人”等文本，executeDiagnostic忽略claims就标CONTRADICTED。需先用“用户也说没看到”与“用户只想拿信息”核实是否误判为信念错误；不把缺少可见证据直接等同于假设错误，不扩大NLP/调用旧Jev集合。测试/build退出，push后释放；无用户DB/服务，UI A5独立保留。

## 已交付：自由目标描述的否定与歧义（2026-09-26）

- ID reflection-goal-polarity，基线52ca299 clean；主控拥有teaching-diagnosis.ts/tests/docs；revision_semantics_review默认配置8分钟只读语义链，不并写。
- 目标/流程：初次/一次异议的USER描述→有界目标分类→GOAL陈述，不把否定或多目标强认作一个肯定目标；TIME_BELIEF保留中性原文。A1真实diagnose红例，A2selectedGoal仍优先、撤回旧目标不复活/无新目标保留，A3不修改原文/来源/预算/旧保存结果；A4相关tests/TS/build及窄审；交付文档commit/push。
- 边界/风险：仅有限词法分类，不完整解析自然语言；已有hinge仍扫描其他claim关键词，不能以目标修复冒称判决完整理解。优先保守UNKNOWN；否定不跨分句污染后面的肯定目标；时间中性陈述不改变回合时钟事实。5分钟红例，12分钟实现，15分钟验证；无模型/用户DB/服务，主控清测试进程，原锁屏A5独立待验。

- 结果：13个真实红例转绿；显式目标优先，有限否定/分句/多目标判定保守处理，时间陈述不强加压力。独审补出“该保枪吗？”仍当肯定的must-fix，主控加入问号/有限疑问句式及初次/修订回归后关闭；最终6文件119tests、TypeScript/production build通过。reviewer只读RELEASE，主控实际diff复核。[证据](validation/REFLECTION_GOAL_POLARITY.md)。
- 后继/限制：目标陈述更忠实，但selectHingeCondition还按其他claim里的“信息/补枪”选条件，不能宣称最终判断完全理解否定。下一项对同反例核实这一错接；优先仅去掉从否定目标衍生的条件，保留真正独立敌情/队友陈述与显式focus，不扩大NLP。旧保存不重算，无模型/真实Demo/用户DB/服务；测试/build退出，push后释放，UI A5独立待验。

## 已交付：教学模式标题准确呈现（2026-09-26）

- ID pedagogy-labels；基线8ceb81f clean，现有owner均RELEASE，主控独占Panel/docs，小文案映射不另派代理。沿用已读emil-design-eng/apple-design的具体反馈与克制原则，不新增动效/透明度/布局。
- 目标：实际REINFORCE/CHECK_TRANSFER/DEFER不再显示“第一次讲清”；流程保存诊断→原Panel→对应中性标题；A1完整类型映射覆盖七模式，A2判决/引用/交互及旧记录门保持，A3现有相关tests/TS/build，A4学习/任务板与证据push。不扩语义诊断、模型或记忆调用。
- 风险/阶段：措辞不能声称理解了异议或已经验证通过；5分钟源改/复核，10分钟验证，主控清测试build，无用户DB/服务/浏览器/安装部署。低影响文本修改不新增逐项复写映射的测试；使用现有真实diagnose SSR与Graph回归。旧UI A5独立待验。

- 结果：完整类型映射七种现有模式，REINFORCE显示“重新核对”、CHECK_TRANSFER显示“换个局面再检查”、DEFER显示“待核实”；原INTRODUCE/CLARIFY保持，CONTRAST/BRIEF_REPEAT也有准确标题。3文件32既有tests、TypeScript/production build通过，主控集中复核，只有10行常量和1处呈现替换，没有改数据/操作/样式。
- 限制/后继：现有SSR与Graph回归不是完整UI验收；未新增逐文案快照测试。原A5仍独立待验。下一项已定位真实教学语义风险：inferGoalFromText按关键词先后，可能把“不是拿信息，是保枪”归为GET_INFO；buildUserClaims又把任何含“时间”的描述写成存在时间压力。下轮先以小型真实diagnose输入复现，保守处理明确否定/中性陈述，不企图完整自然语言理解或引入新模型。

## 已交付：纠正召回到后续教学的实际消费（2026-09-26）

- ID memory-correction-recall；基线28c44c5 clean；主控拥有history-idempotency.integration.test.ts及docs；revision_semantics_review默认配置只读消费语义，8分钟终点，无并发写。
- 目标/流程：真实修订纠正→隔离SQLite→MemoryService Brief→真实POST服务端净化→后续诊断模式；撤回consent后新cue回到基线。A1纠正作为USER保留而旧DISPUTED不列active；A2实际路由移除ID且Graph使用有界模式；A3授权撤回清空新cue，不重写比赛事实/判决；A4相关tests/TS/build并记录语义未实现边界；交付有限验证与必要窄修后push。
- 风险预检：Next after后台写不能逃逸临时库生命周期，测试拦截新反思的after调度（本轮仅验证召回）；复用已有schema/Brief，不开服务/模型/桌面/用户DB。5分钟小链，12分钟测试，15分钟验证，同一工具两败先简化；owner关闭tmp库和清理stub。旧Memory写链已有上一轮真实验证，不重复模拟全栈。

- 结果：既有召回链实际通过，无需新增生产召回逻辑。真实修订→SQLite→getBrief→POST→Graph保留USER纠正、移除管理ID，旧争议不列active；可验证资源诊断模式REINFORCE而claims/verdict等于无记忆基线。撤回授权后合法下一cue清空Brief并不再REINFORCE。4文件69tests、TS/build通过，新增最终断言后目标3tests/TS复验；无完整浏览器/HTTP服务或语义质量证明。
- 重要边界：当前只采用“需要复核”的模式/工具提示，没有把历史原文交给诊断语义判断；UNVERIFIABLE仍DEFER。只读reviewer已RELEASE。[证据](validation/CORRECTION_RECALL_CONSUMPTION.md)。后继已核实TeachingDiagnosisPanel除CLARIFY外一概显示“第一次讲清”，会误标REINFORCE/CHECK_TRANSFER/DEFER；下一项用真实产物修正现有模式标题，保持判决与引用不变。主控清tmp库/stub，无常驻进程；原锁屏A5单独保留。

## 已交付：记忆纠正绑定修订前目标（2026-09-26）

- 基线afab505 clean；主控有限goal拥有contracts/diagnosis/Memory producer及相关unit/docs；partial_revision_restore默认配置先只读消费者，随后独占history-idempotency.integration.test.ts隔离SQLite回归。其余owner RELEASE，无同文件并写。
- 证据：旧producer先解析CREATE/USER_CORRECTED_COACH非法组合，实际先被schema阻断。原子构造修复后，受控去掉旧目标绑定的小实库红例证明潜在目标错误：logicalKey含hinge/diagnosis/rule全文，信息误判→语音SYNC改变key，新目标缺失则拒绝，若新key已有独立记录则会纠正错对象。不能声称旧用户数据库已发生错误纠正。既有correctMemory receipt可复用。
- 流程：一次合法revision时保留原有界LearningThread快照→producer验证同thread/同cue→用旧logicalKey定位旧Memory→既有CORRECT将原记录DISPUTED，重试不增加机会/修订。A1真实diagnose/revise→producer→SQLite旧实现红例；A2新key已有另一记录也只纠正旧目标；A3重复幂等/计数/consent和缺少旧快照不猜目标；A4相关tests/TS/build及独立窄审；A5架构学习证据push。
- 数据/边界：CueCase可选previousLearningThread使用现有ThreadSchema边界，旧case新代码可读，但旧已修订无快照不能自动纠正/回填；不重构逻辑key、不改Memory schema/DB迁移/用户记忆、隐私/consent/删除门。原输入strict不接受客户端塞历史快照。5分钟接口、12分钟实现/小实库、15分钟验证，隔离tmp库owner关闭清理，无模型/真实Demo/服务/部署安装；不能把DISPUTED说成新观点已证实。

- 结果：保存previousLearningThread与acceptedDisagreement；合法原子CORRECT定位旧聚合，纠正文案/ID绑定Graph真正接受的异议。独审发现拒绝第二次异议仍返回旧case，已补请求身份/规范化内容匹配与新provenance隔离，并用真实Runtime拒绝/同eventId换文案回归。隔离SQLite两目标场景、幂等/旧revision/机会计数通过；8文件161tests、TypeScript、production build通过。partial_revision_restore只写集成测试、revision_semantics_review只读复审无遗留must-fix，均RELEASE。[证据](validation/REVISED_DIAGNOSIS_MEMORY_TARGET.md)。
- 限制/后继：没有真实HTTP/UI或用户Memory迁移，没有提高专业判断正确率。缺少旧快照的旧修订保守不发纠正。已读MemoryService.getBrief有独立DISPUTED纠正查询（limit4），不是缺失能力；下一项仅核实此次真实纠正→Brief→教练消费的有界接线与consent撤回，发现实际缺口才改，不重做Memory完整性审计。测试/build退出，提交push后释放本轮文件；锁屏A5单独待验。

## 已交付：修订诊断与总结资格（2026-09-26）

- 基线0dae213 clean；主控有限goal独占wrap-up adapter/Host/必要总结限制呈现与tests/docs；revision_semantics_review默认配置8分钟只读diagnose/revise，已返回真实内存例并RELEASE，无文件/模型。主控核实Graph complete只从原completedCueSummaries/sessionThemes归纳，Host adapter不接CueCase。
- 可观察目标：两次原候选重复中一个经用户补充修订，不再作为确定重复错误出现在最终总结；USER补充不当作比赛事实，也不把新rule伪装旧advice ID。流程真实diagnose→revise→当前/Graph两来源case→原总结投影→重算剩余支持与refs→保存/呈现明确限制。A1真实修订+原总结红例；A2revision/attempt识别含确认/JSON恢复，过滤支持而非只换文案；A3未修订/无case旧记录保持，剩余重复可继续、错cue/candidate不误伤，不改Graph/Memory计数或引用门；A4相关tests/TS/build与窄独审；A5架构学习证据push。
- 风险/范围：现总结只能引用原advice，没有新rule引用契约，本轮仅保守排除已修订支持并说明，不声称新专业判断改善。Graph和Host来源取并集，避免旧来源覆盖新修订；无合格原代表时可整主题不输出，不凭空挑新代表。限制满额沿明确失败路径，不截断旧限制。5分钟小例、15分钟实现、15分钟验证；无真实Demo/模型/DB/安装部署，SSR不冒称浏览器，原A5独立待验。

- 结果：真实diagnose→revise使结论由BELIEF_INCORRECT变INCONCLUSIVE，原adapter仍计两例的红例转绿。当前/Graph case并列输入，确认/JSON后修订仍过滤；剩余两合格支持继续并重算refs/rounds/count，无原合法代表保守省略。说明进保存bundle，空主题也显示；不提升USER为事实或替换旧advice文本。相关7文件122tests、TS/production build通过；partial_revision_restore独立只读终审无must-fix，owner均RELEASE。[证据](validation/REVISED_DIAGNOSIS_WRAP_UP.md)。
- 边界/后继：仅新总结投影，不改Graph内部主题/Memory或重写旧保存总结，非专业质量gold；合成模块/保存spy/SSR非整Host真实浏览器。已读apps/web/lib/memory/agent-events.ts，修订发USER_CORRECTED_COACH，COMPLETE_SESSION仅闭合元数据；下一项只用同修订例验证消费者纠正/机会计数是否正确，不重复实现现有链或触碰用户记忆。测试/build退出，commit/push后释放，原UI A5独立待验。

## 已交付：历史分页与搜索归属（2026-09-26）

- 基线fde53ae clean，主控有限goal独占Host/窄请求归属helper/tests/docs；原owner均RELEASE。已核实首屏有epoch，但loadMore不验证search/cursor/request，React loading状态发布前双击也可重复请求。
- 流程：搜索改变即同步失效旧请求/cursor→当前search首屏刷新→只允许当前已接受cursor分页→只接受当前请求；A1延迟旧分页成功/失败不改新列表/cursor/loading/error；A2搜索改变到effect前及旧callback、同cursor双击拒绝；A3正常刷新/追加去重和失败后明确重试保持，API仍20秒且零自动retry；A4相关tests/TS/build与窄审；A5架构/学习/证据push。
- 范围/风险：仅列表的search/cursor/待请求归属，不引入缓存/数据查询框架，不改Review数据/恢复/Graph。复用现有refreshHistoryPage异步发布，增加小型同步请求owner以验证React提交前间隙；5分钟接口/局部例、12分钟实现、10分钟验证。emil/Apple沿用现有loading/按钮、无新动效；无用户Demo/DB/模型/服务/安装部署，主控清进程，原UI A5不重试。

- 结果：小型HistoryPageRequests共同管理首屏/分页，同步拒绝旧query/cursor与双击，复用原refresh发布/错误门。保留Sidebar原160ms防抖，指提交query后同步失效。新增5项生产owner/helper回归，相关5文件49tests、TS/production build通过；默认revision_semantics_review只读窄审无must-fix、RELEASE，主控实际diff与去重/防抖接线确认。[证据](validation/HISTORY_QUERY_PAGINATION.md)。
- 后继切回教学质量：已读实际buildStage3WrapUpInput与deterministicSessionWrapUpBundle，前者只接plan/narration/candidateSet，没有CueCase修订输入。下一轮用真实diagnose→revise→总结小例核实用户补充是否在最终总结中被旧建议覆盖；先确定影响，再最小接线，不重跑旧Jev拒判或扩大模型门。测试/build退出，当前文件commit/push后释放，原UI A5独立待验。

## 已交付：历史后台请求等待上限（2026-09-26）

- 基线f772ba9 clean；主控有限goal独占API/目标tests/docs；原owner已RELEASE。真实list route默认30/max50条摘要，不携带Artifact；markFailed是小PATCH状态DTO，仍直接fetch/json无界。
- 目标/流程：列表或失败状态请求→fetch/body共用20秒→本地失败结算与best-effort abort→既有刷新释放loading、保留后台保存警告；失败收尾随后可继续尝试一次列表读取，本地Session已独立启动。A1 API两类fetch/body挂起红例；A2真实refresh/settlement接线可结束、晚响应不发布且零自动retry；A3 query/摘要映射/HTTP code和void PATCH语义保持，大detail/AnalysisBundle不套期限；A4相关tests/TS/build，窄独审；A5架构学习证据push。
- 边界/预检：复用现有requestJsonWithDeadline和小JSON解析，避免新增请求框架；每请求20秒非整链20秒、非服务端取消保证，原owner guard保留。不扩create/revision/detail/删除等未核实请求，不改SQLite/Graph/模型；5分钟红例、8分钟实现、10分钟验证，无用户数据/DB/Demo/服务/安装部署，主控清测试/build，原UI A5仍独立待验。

- 结果：3红→绿，新增8项覆盖两种请求fetch/body、实际后台串联释放loading/保留警告、查询/摘要映射、HTTP code、void PATCH与大detail隔离。相关6文件66tests、TS/production build通过；主控实际diff复核，revision_semantics_review只读窄审无must-fix、RELEASE。[证据](validation/HISTORY_BOOKKEEPING_DEADLINE.md)。API修改仅用途枚举/两入口，0新依赖或UI组件。
- 后继：真实Host loadMoreReviewHistory仍无request/search/cursor归属复核；首屏新搜索刷新后，旧分页晚响应可能追加旧结果并改cursor/loading。下一轮小复现并接同一明确列表归属，不扩缓存/通用请求框架。后台单请求20秒非整链/服务端保证，原A5独立待验；测试/build退出，commit/push后释放。

## 已交付：起点收尾不阻挡基础会话激活（2026-09-26）

- 基线5558690 clean；主控有限goal独占Host/route-integration及tests/docs，既有owner已RELEASE。实际证据：成功durabilityCommit包含await列表刷新；失败catch等待markFailed再列表刷新，最后才activateSession。
- 目标/流程：起点提交结果确定→反馈已确认/未确认→启动现有本地Session；状态标记/历史列表更新独立收尾。A1成功刷新悬挂与失败标记/刷新悬挂都不能拖住激活；A2保存尚未结束不能提前启动、切代不启动/不发布旧刷新；A3激活异常不能被误分类为保存失败再markFailed，旁路错误被观察，不重试/不改head/诊断；A4相关tests/TS/build与窄审；A5架构学习证据push。
- 风险/边界：列表刷新会清错误并写React状态，需代际/请求归属，未确认提示不能被成功旁路刷新抹掉；本轮不为所有请求加通用deadline/队列，不加UI控制/Graph能力，不绕原activatePreparedCoachingSession的Recovery持久化和路线门。5分钟小链、12分钟实现、10分钟验证；无用户数据/Demo/模型/服务/安装部署，测试进程主控清理。原UI A5仍独立待验，模块/源审不冒称完整Host。

- 结果：成功/失败路径均解除列表与状态收尾等待，仍等待真实durability和原本地Recovery激活门。新增真实Session激活与挂起收尾测试；revision_semantics_review只读独审发现列表失败会覆盖保存警告，抽出当前刷新副作用为可验证窄helper修复并补5项测试，复核关闭must-fix。最终4文件73tests、TS/production build通过，owner RELEASE。[证据](validation/PREPARED_START_BOOKKEEPING.md)。
- 边界/后继：未挂载完整Host/真实浏览器，没有新增API超时或取消语义；后台status/list请求本身仍可能长期悬挂，但已不阻挡Session。下一项针对这两个小DTO请求核实有界等待和旧请求回收，不扩到大detail/Demo/所有持久化。测试/build退出，commit/push后本轮释放，原UI A5独立待验。

## 已交付：未知保存结果不得降级可恢复历史（2026-09-26）

- 基线19b1a17 clean；主控有限goal拥有Host文案/docs/接线验证；partial_revision_restore默认配置独占library.ts/library.test.ts，在临时SQLite复现并窄修。现无其他写owner。
- 真实调用：起点durabilityCommit catch总会markFailed；API PATCH→updateReviewStatus(FAILED)无条件改Review及全部PREPARING Revision。预期流程：head成功但ACK丢失/新分析失败→失败标记请求→若已有匹配activeRevision且READY的精确head，同事务保留可恢复状态；未有可用head仍按原失败处理。
- A1真实SQLite先红后绿覆盖ACK未知后不降级；A2旧head与新准备Revision并存不污染旧记录和其他准备版本；A3无有效head原失败保持、失败后晚head能提交、CAS幂等不回归；A4相关tests/TS/build与只读窄审；A5架构学习证据commit/push。
- 风险/边界：状态更新与head竞争必须同事务；不是删除失败语义、数据完整性审计或历史批量修复。只用既有绑定/READY资格，不扫描用户产物、不迁移/重解析/猜latest；5分钟红例、12分钟实现、15分钟验证，owner清tmpSQLite/测试；主控不启用锁屏UI、不部署安装/触碰密钥。Host未知结果文案不能再声称“历史已标记失败”。

- 交付：DAL仅FAILED更新增加13行事务内精确绑定保护；2个真实SQLite红例转绿，新增6项涵盖旧head/并存准备Revision、无head晚提交和不合格绑定。Host两处文案改“保存未确认”，不声称已标失败。主控复核真实diff，4文件42tests、TS/production build通过；revision_semantics_review独审无must-fix，两owner RELEASE。[证据](validation/PRESERVE_CONFIRMED_REVIEW_STATUS.md)。
- 限制：不修既有误标数据；有有效head时未指定Revision的失败请求不会替某个新准备版本标失败。仅tmp SQLite，无真实HTTP丢包/桌面/用户DB。后继实际线索：同一catch仍await markFailed和refreshReviewHistory后才activateSession，二者网络未设等待上限，可能让“仍可继续”悬挂；下一轮小复现并确定失败收尾与基础激活的必要依赖，不扩大持久化框架。测试/build已退出，commit/push后释放。

## 已交付：当前会话恢复点显式重试（2026-09-26）

- 基线a9c80a8 clean；主控有限goal独占Controller/Mirror/Host/tests/docs；revision_semantics_review默认配置独占历史栏UI及窄测试，复用emil/Apple与原样式；无并发同文件写入。
- 流程：教学及Recovery artifact已成功→head请求未确认→历史栏显示显式重试→复用原payload/expected→CAS成功才接受原保存记录；不重新诊断/重写artifact/读取latest Graph。A1真实API失败→原请求重发/ACK；A2双击合并、失败继续可试、409/非法状态不提供重试，新artifact/head/owner/离开边界使旧操作失效；A3UI忙态和反馈、旧基础回放不阻断；A4相关tests/TS/build与独立窄审；A5架构学习证据commit/push。
- 范围：仅本页默认Agent镜像的最后head步骤，排除artifact未确认/ROUTE_START失败/跨重启队列/自动retry。不放宽CAS/旧恢复保护、结果门或诊断预算。5分钟接口、15分钟实现、15分钟验证；风险是重跑mirror改变completedAt、用新expected、迟到成功覆盖新owner以及双击重复回调。复用原快照与20秒请求限时；无服务/用户DB/Demo/模型/部署安装，UI以组件证据如实说明。每个owner清自有进程，原UI A5不重试。

- 结果：历史栏入口/忙态已接通；原body/expected重发、零新artifact/Recovery dispatch，成功才accept。7文件121tests通过；补重试在途owner/新artifact失效及再次瞬时失败后Mirror31tests/TS/production build通过。两个owner RELEASE，独审无must-fix，主控实际diff及UI小表复核。[证据](validation/EXPLICIT_HEAD_RETRY.md)。无完整浏览器/Host验收，原A5独立保留。
- 后继真实线索：Host起点durabilityCommit catch总会markFailed并activateSession；如果head已提交仅ACK丢失，可能把有效历史误标失败。下一轮先用小型生产链复现这一区别，不直接扩大重试到所有artifact/初始路径。测试/build已退出，commit/push后本轮释放。

## 已交付：恢复点提交并发保护（2026-09-26）

- 基线1da3de5 clean；主控有限goal拥有apps协议/Controller/Host及docs，partial_revision_restore默认配置独占libs/review-library契约/DAL/tests。共享树按文件独占，无其他运行写owner。
- 目标/流程：客户端带读取或上次确认的artifact ID→服务端事务比较当前head→相符才提交；同目标完全相同幂等确认，迟到旧请求拒绝，保留新进度。A1真实临时SQLite同cue与跨Revision红例；A2首次null/缺失按无head、同目标同内容幂等且不同内容不绕门；A3客户端串行head写及初始/恢复/重新分析expected接线，超时不自动rebase/retry，旧owner ACK不污染新owner；A4相关tests/TS/build与独立窄审；A5架构学习证据commit/push。
- 接口：DAL expectedRecoveryArtifactId可选，缺失视null；HTTP必须显式null或非空ID，拒绝旧无条件协议；不迁移已存数据。API返回已确认recoveryArtifactId，Controller只在合法ACK后推进token。正常产物顺序/身份/单调检查不放宽。
- 风险/阶段：5分钟小复现，15分钟实现，15分钟整链验证；重点同cue计数相同、跨Revision、首次route启动/重新分析和超时服务器仍执行。仅隔离tmp SQLite，不碰用户DB/Demo/密钥/Memory，无服务/模型/安装部署；两次基础设施失败先简化。各owner清自有测试资源，本轮不加重试UI或猜latest Graph，不声称通用语义旧result识别。交付后选择基于新证据的明确失败恢复路径。

- 结果：DAL真实SQLite 3红→绿；主控接线后8文件114tests通过。独审发现旧存储head无绑定不能重分析，新增1红→绿并分离legacy存储读取与严格ACK；相关3文件49tests再过，TypeScript/production build通过（仅现有SQLite experimental warning）。revision_semantics_review确认must-fix关闭，两个owner均RELEASE，主控关键diff及生产调用集中复核。[证据](validation/RUNTIME_HEAD_CAS.md)。
- 本轮未加重试入口；未知保存结果保留旧token，可能需要重开历史读取确认进度。后继：核实能否在当前owner中保留同一已保存提交及原expected，让显式重试只重复这次head提交且不重跑诊断；一旦新动作/owner变化即失效，不猜最新Graph。原UI A5独立待验，未操作用户库或启动服务。自有测试/build结束，commit/push后释放文件。

## 已交付：教学保存等待上限与恢复重试资格（2026-09-26）

- 基线 e27360e clean；主控有限 goal 独占 API/目标测试/docs；partial_revision_restore 默认配置只读 DAL/route，8 分钟内交付并 RELEASE，无服务/DB/文件写入。
- 资格核实结果：现有 head 事务仅保证原子与部分进度单调；同 cue 的新旧 checkpoint 计数可相同，跨 Revision 也无 expected-head CAS。捕获旧请求并不能安全自动重试，须所有相关写入共同采用事务内 expected-head 比较；本轮不接通用重试，不猜 latest Graph。
- 转向已核实的独立缺口：反思/异议 USER_INTERACTION 与后续四种教学 artifact 仍直接 fetch/json，无等待上限。流程：提交教学内容→单次请求超过 20 秒→既有失败提示/保留展示/释放等待→不提交新的 head；成功路径保持原顺序。
- A1 小型 fetch/body 悬挂红例；A2 五类教学小产物复用既有 deadline，晚响应不继续保存链，不自动重试；A3 真实 API＋PersistenceController＋persistTeachingBeforeRuntimeHead 验证失败阻止 head、成功保持 payload/idempotency，AnalysisBundle 等大产物不套此限制；A4 相关 tests/TS/build；A5 窄独审、学习/证据/commit/push。
- 范围/风险：仅客户端等待，不保证服务端取消或数据未落盘，不改变恢复选择/DB/Graph/schema；不能把未确认报成功。5 分钟红例、10 分钟修复、15 分钟验证，最多两次基础设施失败先简化。无 Demo/模型/浏览器服务/真实DB/密钥/安装部署；主控清测试/build，无整页 UI 验收承诺。后继明确为 head CAS 最小契约，优先以真实 SQLite 小复现再实现，不让旧 UI A5 阻塞。

- 结果：6个真实API/保存helper红例转绿，相关6文件77tests、TypeScript和production build均通过；新增9项测试涵盖5类fetch/body、晚成功、失败阻head、成功原序/幂等、HTTP code与大AnalysisBundle隔离。主控实际diff复核，partial_revision_restore窄独审无must-fix并 RELEASE。[证据](validation/TEACHING_SAVE_DEADLINE.md)。无产品重试入口；错误提示沿现有Host。自有测试/build均退出，commit/push后释放写入。

## 已交付：部分提交时禁止教学内容回退（2026-09-26）

- 基线c5b6aa4 clean；主控有限goal拥有产品/docs，partial_revision_restore默认配置独占一个recovery测试，真实C0→C1及历史保存/旧head→重连复现后RELEASE。其测试明确内存append和head失败注入，不冒称完整SQLite/UI。
- A1新产物revision/attempt1在旧checkpoint恢复后回0，原数据没被删除但显示/操作预算回退；A2保持精确恢复点，若当前已保存教学进度领先则在结果接受/镜像之前拒绝本次恢复，保存内容继续可读且报告冲突；不直接采用latest Graph、不倒扣预算或混合新case与旧Graph；A3正常/相等/旧产物/其他cue与所有权保持；A4相关tests/TS/build，独立窄审；A5架构/学习/证据与push。
- 重点风险：Controller默认吞镜像错误，判定必须在该catch之前；不能先更新head再检测、不能凭COMPLETED确认状态就判冲突。生产范围为reconnect可选同步验收、Host已验证产物快照与窄进度比较，不改Graph/SQLite/schema。8分钟红例、20分钟修复、15分钟验证；无Demo/UI/网络模型/用户DB/服务，主控清理测试build。原锁屏A5与app子任务认证失败不重试。
- 已完成：真实红例转绿，验收回调在镜像之前拒绝进度回退；当前已保存新case/thread保持，Panel不重开异议，原head/产物不变。正常/旧保存/纯确认状态不误阻。6文件129tests、TS/Web build通过；追加Panel断言后2目标tests/TS通过。partial_revision_restore只读终审无must-fix，所有权/进程RELEASE，主控集中diff复核。[证据](validation/PARTIAL_TEACHING_RECOVERY.md)。
- 边界与衔接：本轮只拒绝不一致的教练同步，不自动恢复最新状态；Graph可写自身checkpoint，缺失case/跨cue/同revision差异未扩。下一项先核实已经保存但未激活的Recovery artifact是否可按既有提交契约安全重试，若无明确资格不猜latest Graph；原数据/基础播放保留。测试/build退出，commit/push后本轮释放。

## 已交付：修订诊断经Recovery重连后的追问（2026-09-26）

- 基线22b4f5a clean；主控有限goal，独占recovery集成测试/必要窄修复/docs。核实原子任务仍401失败无写入，不重启或重复派发；其余本轮owner均RELEASE。
- 流程：生产Host同步diagnosis→真实Runtime诊断/修订→捕获Recovery+实际checkpoint→新Runtime重连→原落点restore helper→当前追问。A1新旧USER原文/修订预算与结果门保留；A2问答显示新建议；A3恢复只请求RECONNECT、无新诊断/Policy/长期Memory proposal或工具；A4相关tests/TS/build，若已正确不改产品；A5证据/docs提交push。
- 范围：复用内存checkpointer与既有紧凑Replay fixture；不是用户Demo解析/真实持久DB/浏览器。风险为把两条分离恢复源当一份、伪造Graph状态替代真实event、错把合法checkpoint写当Memory副作用。5分钟小链、10分钟验证，失败最多两次先简化。主控清理自有测试/build，无服务、下载、模型、密钥或schema扩展。
- 结果：正常产品路径已正确，新增1条Controller同步→Host event builder→Runtime两次提交→实际checkpoint/Recovery→新Runtime重连→Session落点→追问回归，未改产品代码。3文件91tests、TS、Web build通过；两段原文/完整修订/门/进度保持，重连无诊断/Policy/工具/长期Memory事件，重复重连checkpoint不变。[证据](validation/REVISED_DIAGNOSIS_RECOVERY.md)。仅测试包helper解决依赖所有权，fixture构造问题不称产品red；MemorySaver不是持久DB，未跑UI。
- 后继：partial_revision_restore默认配置8分钟只读，已RELEASE无写入/进程。真实顺序为新教学artifact先存、后head；若head失败，历史先显示最新教学artifact，握手又以旧精确checkpoint覆盖。同点静默回退/预算重新开放尚未fixture验证，下一项只先验证该不一致；不能把回到旧确认点本身当bug，也不能简单改为用latest Graph。当前所有测试/build退出，commit/push后主控释放本轮写入。

## 已交付：异议修订后的当前追问（2026-09-26）

- 基线538275f已push/clean；主控有限goal，独占current-cue-questions.ts/对应tests及docs。原API子任务认证失败未重启；本轮小改动主控执行，不并发写入。模板沿用，emil/Apple技能用于保持明确反馈与现有交互，不加新布局动画。
- A1实际diagnose→revise(DISAGREED)→真实Session记录→问答gate复现；A2仅已完成修订且完整身份链/当前结果完成门允许原问法；A3旧key拒绝、当前默认/manual可用，busy/不完整/伪修订仍拒，零副作用；A4相关tests/TS/build；A5文档commit/push。无schema/producer/Graph/Memory/Session改动，无UI/Demo/模型/DB，5分钟红例/5分钟实现/10分钟检查，主控清理测试build。
- 实际default/manual两红→绿，2行资格改动，4文件173tests、TypeScript及Web production build通过。主控集中diff复核，无新代理；[证据](validation/REVISED_CUE_QUESTIONS.md)。所有测试/build退出，commit/push后释放本轮写入；SSR非真实UI。下一轮先核对同一修订产物经过完整Recovery恢复后的追问资格与零重新诊断，只跑小范围实际链，若已正确则不制造产品修改。

## 已交付：合法长异议修订（2026-09-26）

- 基线7a32699 clean；原任务01a0daba-7e7c-7fd2-a199-fc23c43bd643启动认证401、未产生改动。2026-09-26主控核实systemError/真实clean后接管写入，不重复启动同失败路径。主控有限goal：保留两段合法USER原文与来源，修复内部拼接和限制追加的实际失败，相关tests/TS/build后commit/push。
- 沿原完整模板任务卡与边界：纯diagnosis/必要兼容输出/tests/docs，先真实diagnose→revise红例；不截断否定、不扩单条500字或限制12条上限；一次异议预算、stable case/thread/历史恢复保持。前端如需修改沿emil/Apple技能；无UI服务/Demo/模型/用户DB。原文本与补充组合需明确来源，必要窄契约变化同步架构，不能偷偷改变旧数据。
- 完成：真实长文本/满限制2红→绿；optional previousReflection分别保留500字USER来源，新类型优先且保留旧origin，限制无空位时新增说明进入verdict解释，rule/thread同步低置信度。独立revision_semantics_review发现旧目标/问题类型继承的2项语义缺口，针对性红→绿后复核无must-fix。
- 验证：相关7文件168tests、TS、Web production build通过；真实Graph异议不fallback、重复/第二次异议不重跑，actual append→内存restore保留两段来源。见[证据](validation/LONG_DIAGNOSIS_DISAGREEMENT.md)。无需DB迁移；旧记录读兼容，不承诺旧客户端读新可选字段；关键词/hinge不是通用语义撤回理解。测试/build全部退出，无服务/真实用户数据，原UI A5独立保留。
- 后继已知入口：完整修订结果使用DISAGREED，但当前追问gate允许状态未含DISAGREED；下一轮先用实际修订→当前问答入口确认是否误隐藏，再补最小状态资格，不能拿本轮作为已修复证据。当前交付commit/push后主控释放本轮写入。

## 已交付：一手教学材料的条件与接入边界（2026-09-26）

- 主控01a0c8ea-9dca-7332-b03d-3b38b88ed630有限goal，前owner3c84d55已push/clean/RELEASE后独占本板/学习日志；研究期间只读，与来源可达性任务无并发写入。默认配置，不派额外代理。
- 目标与流程：核实具名选手材料和CS2作者教程→对照现有PRO_SCENE/规则/默认问答→记录可执行条件与不能接入的部分。A1两篇原发布页/时代/作者归属明确；A2协同/资源/路线意图等前提不冒充gold；A3既有样本和信息门保持；A4docs commit/push。采用两篇一手材料，10分钟内收敛，无批量下载/模型/视频或Demo解析，未启动进程。
- 结果：2021 GeT_RiGhT访谈是CS:GO具名职业观点，2024 CS2教程是作者指导；均无对应完整决策资料，不生成职业样本或默认判错。具体链接/可执行字段与限制见TECHNICAL_LEARNINGS同日条目。资料可用于设计条件核对，不代表当前版本投法实测或职业判断质量改善。
- 接续实际问题：reviseDiagnosis把两段各最多500字的rawText连接后再次parseUserReflection(max500)，Panel两个输入各允许500，合法长补充存在失败风险；同时满12条诊断在修订追加限制时可能超限。下一有限任务先走真实诊断→异议生产链复现，再决定如何保留原思路/新增信息且不截断语义；不做全项目长度审计。当前只交学习记录，未重跑TS/build，原UI A5保持独立等待。

## 已核实：Memory evidence 误标路径当前不可达（2026-09-26）

- 基线402c584已push/clean；01a0dab3-4810-76a2-a23d-d7e278972014串行核查，主控只读。原任务怀疑RULE经material.evidence误标PRO_EVIDENCE；适配器内部代码确有该问题，但严格输入不包含evidence，不能用cast拼接fixture宣称产品红例。
- 主控修正目标为“核实是否可达并作出是否修复决策”：唯一生产caller是agent route；Host剔除evidence，route envelope、runtime.dispatch/dispatchOne在Graph去重/恢复前严格parse，播放恢复事件不产诊断Memory。未发现当前实际可达链，原A1产品修复标不适用，停止产品/identity/版本改造，非假通过。
- 一次临时Host→合法诊断→adapter内存smoke及5种source×3层schema/runtime拒绝断言通过，临时测试已移除；[证据](validation/MEMORY_EVIDENCE_SOURCE_REACHABILITY.md)。仅docs，不跑全tests/TS/build、没有“实现后”子代理，主控接受结论；无服务/用户DB/Memory/keys/Demo/模型/安装部署main。全部自有进程退出，docs commit/push后RELEASE。
- 潜在cast错误待未来真实证据入口接入时连同来源/legacy幂等验证解决，不声称历史数据库已清洗。下一项可核实实际职业材料/检索及适用性契约，避免再次派发已阻断路径。

## 已交付：当前追问复述已有建议与适用条件（2026-09-26）

- 基线 7bdbe68 已push/clean，前 owner RELEASE；01a0daaa-2bac-7222-8c53-f813ce51a8f9 独占当前问答/Panel/Host一行能力props/tests/docs，主控只读关键diff，无子代理。emil/apple沿用原样式，无浏览器/服务。风险集中完整条件、同ID来源变化和跨visit回调，先实际producer红例再接有界投影。
- A1 diagnoseTeachingCue 满12条→实际DiagnosisPanel已有完整建议，而问答unsupported红例；A2 完整诊断身份链内复述when/do/unless/全部已有适用限制，不截400字/前4条，明确不重判/不证明最优；A3 基础/fallback无源不许诺，rule完整内容进key，默认/manual同visit回看保留且旧visit/旧内容回调拒绝；A4 问答/资源cache/Panel/replay回归、TS/build；A5 架构/学习/简证及commit/push/RELEASE。
- 仅3个精确问法，当前页面最多4条，不新增诊断/Memory/持久化/模型/播放动作，不改producer/Graph/Session/schema。旧规则按原文复述不回填；refs仅现有rule与合法决策事实交集，不认证建议正确。相关5文件154tests、TypeScript、Web production build通过，主控只读关键diff无must-fix；[验证](validation/CURRENT_CUE_ADVICE_QUESTIONS.md)。SSR/生产callback与Session fixture不等于真实UI或专家质量验收。自有验证进程已退出，文档同批commit/push后RELEASE。

## 已交付：保留限制饱和时的条件化建议说明（2026-09-26）

- 基线 af0ec28 已 push/clean 且前 owner RELEASE；01a0daa4-7a86-7780-b109-a9a8601d2bdf 独占 producer/两测试/docs，主控只读，默认配置无子代理。风险：替换原限制、放错 unless、超长和旧结果重算；采用固定 do 文本末尾条件化完整句，沿 800 字 schema，不改 12 条上限。
- A1 实际 diagnoseCue 的 RISK/SYNC/INFORMATION 合法输入各得到满 12 条和 INCONCLUSIVE，追加说明丢失 3 红；A2 保留原 12 条、仅说明未进入列表时附 do，其他字段/普通结果/非 INCONCLUSIVE 保持；A3 actual append/restore validators→Panel SSR 新旧产物兼容，新句可见旧记录不回填；A4 相关 tests/TS/build；A5 学习/证据及 commit/push/RELEASE。
- 3 红→绿，相关 5 文件 102 tests、TS、Web production build 通过，主控只读 diff 无 must-fix。[验证](validation/SATURATED_TRANSFER_QUALIFICATION.md)。无 Panel/Host/Graph/Memory/schema/Parser 变更，无新模型、QA、真实 UI/DB/Demo/服务/安装部署/main；其他上游限制裁剪不扩大。自有测试/build 已退出，文档同批 commit/push 后 RELEASE。

## 已交付：保留教学建议已生成的适用限制（2026-09-26）

- 基线 6c6c720 已 push/clean，前 owner RELEASE；01a0da9f-bb2d-7151-8e81-8e1502a03145 独占 Panel/tests/docs，主控只读，默认配置无子代理。风险集中在 slice4 再裁剪、改写语义及 12 条内容挤压操作；复用现有列表和滚动，不启动浏览器或服务。
- A1 实际 diagnoseTeachingCue INCONCLUSIVE→Panel SSR 独有条件化句缺失红例；A2 transfer 区域完整展示已生成有界限制，保留当/做/除非与既有技术词投影，其他限制不删除；A3 fallback/旧无 transfer、回看/继续/异议和草稿保持；A4 相关 tests/TS/build；A5 学习/验证及 commit/push/RELEASE。
- 已实现最小 showAll 接线，2 红→绿，相关 5 文件 160 tests、TS、Web production build 通过，主控关键 diff 只读复核无 must-fix。[紧凑证据](validation/TRANSFER_RULE_LIMITATIONS.md)。不改 Host/Graph/Session/producer/schema/Memory，不扩建议追问；JSON 往返/SSR 不等于真实 UI/DB。producer 满 12 条时追加条件化句可能被裁掉，单列为本轮之外限制。测试/build 进程均已退出，文档同批 commit/push 后 RELEASE。

## 已交付：历史总结的可验证代表案例回合（2026-09-26）

- 基线 e25df67；01a0da91-8b1a-7941-a95c-6f833c9807ed 串行独占总结展示/tests/docs，主控只读复核真实 diff，无 must-fix。A1 默认 deterministic→实际内存保存/恢复校验→Panel SSR 得到回合丢失红例；A2 从保存 summary.refs 解析当前 COMPLETE plan 唯一同主题 cue 和反向 segment，正整数回合去重；A3 混合/旧/歧义引用保守降级；A4 相关 tests/TS/build；A5 学习日志/简证及 commit/push/RELEASE。
- 只显示“代表案例”，不用临时 request 填整个主题回合，不把未知写成准备阶段。保留三主题、限定、失败状态和既有样式。未改 Host/Controller/Graph、总结生成政策、Memory、保存 schema 或架构契约。
- 相关 5 文件 68 tests 通过，目标红例转绿；TypeScript 测试 refs 类型修复后通过，Web production build 通过。[验证记录](validation/SUMMARY_REPRESENTATIVE_ROUNDS.md)。单回合 authored summary projection 不验证 Graph 重复资格；旧缺 focus 仍降级；SSR/内存恢复不等于完整 Host/真实 UI/DB 验收，原 UI A5 保持。
- 无真实 Demo/模型/浏览器服务/用户 DB 或密钥/安装部署/main 操作；不声称专业判断或性能提升。自有验证进程完成后 commit/push 并释放文件所有权。

## 已交付：历史回放入口有限等待与迟到失败隔离（2026-09-26）

- 基线c8bba49已push/clean，产品1f7c091；01a0da83-62cf-77c2-8d01-0e4f7c5af15b串行独占7f2b功能分支的review-history API/Controller/Host source阶段及tests/docs，主控只读。未切main/新建旧基线或触用户主树修改。
- A1真实问题：Controller只对成功检查generation，AbortError/普通晚失败穿透Host内catch写B提示；source fetch/body无界。先将真实Host阶段提取并接回，生产API/Controller/Host seam 6红（含Host epoch先失效、Controller代未变）。A2只给source小DTO20秒fetch+JSON期限；A3成功/失败双归属及三mode准确反馈；A4相关tests/TS/build；A5同批文档commit/push/RELEASE。
- 实现：复用共享deadline不改其行为，原HTTPcode/坏JSON和父取消保持，不合作transport也settle，late headers/body不再使用，timer/listener清理。Controller attach失败按generation/abort转STALE；Host expected source/Viewer激活和错误UI写前复核epoch。当前RESTORE保留READY讲解/进度，REANALYZE/SELECT_PLAYER源失败不误报产物校验。
- 验证：6红→绿；新增29项真实模块定时/竞态fixture，相关7文件99tests、TypeScript、Web production build通过。[验收](validation/HISTORY_VIEWER_SOURCE_LIFETIME.md)。默认viewer_source_race_review有限只读审查及主控实际diff复核无must-fix，root独占写入。
- 边界/release：20秒不覆盖大detail/AnalysisBundle、Demo流/解析或控制面恢复；取消不证明服务器未发capability，默认60秒/首次尝试消费/原过期语义保持，零自动retry。原Revision/Graph/Memory不动，无真实Demo/模型/UI/用户DB密钥/安装部署/main操作，原UI A5仍未验。测试/build退出、文档同步后commit/push并释放写入。
- 主控研究衔接真实结论：tools/verify-jev-real-smoke.ts逐候选验证packet后只输出统计，现有.local-data/real-cue-resources/replayed-projections.json仅资源/roster而非完整cue；目前没有已核实能直接打包的新完整标注材料，本轮不为纸面包重复解析旧Demo。该结论不阻塞本次恢复修复。

## 已交付：专业判断评估来源与最小标注路径（2026-09-26）

- 基线1f7c091 clean且原owner RELEASE；主控01a0c8ea-9dca-7332-b03d-3b38b88ed630有限goal负责一手来源/本地评估契约，独占本板与TECHNICAL_LEARNINGS。expert_eval_sources默认模型/推理只读核实最多3源，已交付，无写入/进程/下载；主控复核关键原文。
- 任务：当前没有专业教练gold，先区分可学习素材和能证明判断质量的标签。流程为真实packet/validator核实→一手资料来源与可知边界→可执行小验证；A1三源标签类别/访问许可清楚，A2对照当前三原子与contact门，A3记录不重复拒判集合的下一步，A4 docs commit/push。排除产品门槛修改、模型调用、大数据下载、联系他人、桌面A5重试。
- 风险/阶段：来源自称expert或caption易误当gold，论文许可易误当数据许可；先官方论文/仓库，15分钟内收敛，有访问失败据实记录，不扩全网搜索/变通下载。主控本地只读对照，资料不送模型，结束释放文件所有权；不因数据标注未解就停止其他功能工作。
- 结果：CSKnow人类相似度/轨迹与作者规则、EgoCS VLM captions、OpenCS2动作/世界状态均不提供本项目可直接用的三原子专业gold；没有改默认模型或复跑旧拒判。具体链接、访问限制和结果盲法建议见学习日志同日条目。现有真实RETURN contact门及9例AGENT_AUTHORED_PROXY保持。
- 衔接：先核实本地新候选是否有可交付完整决策资料，不能把消费摘要或职业胜负伪装专家答案；可做时限一包、保持UNLABELED/UNLABELABLE，输入充分性先行。若仅有聚合摘要，不为此重复解析旧Demo；同时继续定位无需桌面的实际恢复/等待缺口。只有记录更新，本轮未重跑TS/build，不冒称新产品验证。

## 已交付：手动回访中的同次重播（2026-09-26）

- 1bb88e2已push/clean且owner release；01a0da66-e866-7c11-a7d8-aa863864691b串行独占Session重播动作的visit绑定、Host/诊断/基础面板窄入口及tests/docs，主控只读，默认配置。
- 证据：PRD7.6要求重放当前片段；manual完成不写global revealed，REPLAY_OUTCOME却要求global revealed，Host在manual隐藏基础和诊断重播入口。本轮补同visit完成后的重播，不借旧全局标记、不重新开visit。
- A1真实reducer已看/未看manual完整播放后现动作/入口缺口；A2明确session/cue/visit匹配与本次完整gate才允许重播，继续使用frozen窗口/现有directive，结束回同visit/decision；A3保留manual接管/取消与默认cursor，重置普通暂停意图但不误回默认，旧visit双击/晚回调拒绝，诊断/问答保留且无重复模型/Memory/呈现计数；A4相关tests/TS/build；A5架构学习证据/任务板commit/push/release。
- 先5分钟给最小动作契约（可沿既有REPLAY_OUTCOME增加可选visit/cue绑定，default旧调用兼容），15分钟实现、10分钟验证，必要5分钟独立时间/visit审查。无新任意seek/Graph工具、cue时间/完成门不降低；无Demo/模型/UI服务/用户DB密钥/部署main，SSR/生产链fixture不冒称真实浏览器。owner清进程，原UI A5独立等待。

- 交付：REPLAY_OUTCOME可选target身份，manual必须匹配本session/cue/visit与本次完整gate，不依global；default旧调用/global门保留。基础/完整诊断入口已接同一guard，原异议草稿保护不变。manual重置transport/seek但保留接管与返回/取消，结束同visit/decision且defaultcursor/case/thread/QA不变。
- 归属/记录：共享Session资格预检和reducer复核，Host同paused对象去重双击；独审发现free seek先reset而取消state排队的空隙，补render捕获epoch实时校验。旧长ID截尾counter碰撞已证，改manual-UUID；USER_INTERACTION v1 target strict/outer绑定，旧无target兼容，既有有界token key包含完整visit。回到停靠后同visit仍可再明确重播，复用同一幂等逻辑记录。
- 验证：已看/未看manual 2红→绿；实际Panel default/manual callback、basic生产入口、reducer/directive/transport、保存校验/QA/Stage3回归10文件234tests、TS/build通过。仅补同visit第二次合法回看断言后受影响29tests/TS再过。默认manual_replay_boundary_review只读审查指出epoch缺口已闭合，主控实际diff无其他must-fix；[证据](validation/MANUAL_VISIT_REPLAY.md)。
- 文档/release：架构/学习/本卡/validation同批commit/push/release，自有测试/build退出。SSR/fixture及basic Host源审不冒称完整Host/浏览器/iframe，原UI A5保持；无跨visit/重启草稿保存、新Graph工具、Demo/模型/UI服务/用户DB密钥/安装部署main，未扩其他confirm或ID体系。

## 已交付：手动回访完成后的有据追问（2026-09-26）

- 9311269已push/clean、210tests/TS/build且owner release；01a0da50-848f-78d3-bb41-f028c8aed357串行独占问答上下文gate/visit状态key、必要窄Host和tests/docs，默认配置，主控只读。
- 来源依据：Session BEGIN_MANUAL_CUE_VISIT重置outcome gate，finishOutcome完成本visit但故意不写global revealed；当前问答一律拒绝manual/takeover，导致已完整回看的合法诊断无法用3+4类既有问法。本轮只补问答，不新增manual重播或修改Session reducer/全局进度。
- A1真实manual reducer从开始到结束证明fresh gate与global reveal区别，完成前不显示/不答；A2同visit PAUSED+匹配COMPLETE及原现代可信内容才支持既有问法，合法manual takeover可读、普通自由查看仍拒绝；A3key绑定visit_id，旧visit回调拒绝、同visit重渲染保留草稿，返回默认游标/consumed/presented不因提问改变，无额外诊断/Memory/历史写；A4相关tests/TS/build；A5架构/学习/简证/任务板commit/push/release。
- 5分钟门契约、10分钟小改、10分钟验证；emil/apple沿用，不绕原本次visit播放门，不借global旧看过记录授权，不扩持久化/自由语义/新字段或重播控制。0Demo/模型/浏览器服务/用户DB密钥/安装部署main，证据为生产模块/Session/SSR，原UI A5独立等待。owner清自有进程。

- 交付：只改QA上下文gate与key，合法manual采用当前cue匹配/非空实际visit_id及Session本次PAUSED+完整gate，可在本visit takeover状态使用原3+4类问法；default仍未接管+global reveal。未改Session/replay/global progress/Host与Panel事件，未加manual再看一遍。
- 身份/状态：key用manual实际visit_id或default null，测试合法visit名“default”也不碰撞；同visit重渲染草稿保持，新visit播放中及完成后旧callback均拒绝。QA不改defaultcursor/consumed/presented/case/thread/attempt，cancel按既有Session恢复默认游标，资源核对及单条cache复用保持。
- 验证：已看/未默认看过两种真实reducer begin清gate→LOCKED→finish不写global reveal，2红→绿。新增5项并扩原baseline测试，6文件136tests、TS、production build通过；[证据](validation/MANUAL_VISIT_QUESTIONS.md)。主控集中只读复核，无新代理。
- 文档/release：ARCHITECTURE/学习/本卡/validation同步后commit/push/release，自有tests/build退出。仅同visit页面状态，不承诺跨visit/跨cue/重启永久保存；SSR/callback/Session fixture不冒称完整Host或浏览器验收。无模型/Demo/UI服务/用户DB密钥/安装部署main，原UI A5保持。

## 已交付：已验证资源数值追问（2026-09-26）

- 7913aac已push/clean且owner release，有限3类追问81tests/TS/build通过。01a0da41-5267-7a31-b26b-d7a55e040a59串行独占现有问答纯投影/必要Host来源接线/少量问法/tests/docs，主控只读，默认配置。
- 依据：已验证health/armor/utility/近期ammo已在当前诊断数值列表完整呈现，但“当时多少血/弹匣几发”等仍被首版问答拒绝。本轮只扩这些明确数值核对，不新增parser字段或专业判断。
- A1生产诊断/来源投影+问答入口复现已有可验证数值仍不能问；A2少量明确问法返回当前已展示measurement且与当前Host合法resource来源值/refs一致，未知不补0，ammo标注此前最近采样而非精确瞬间；A3假设/错误前提/其他cue/旧未可信history不拿数值作建议，已有3类与重播/修订隔离保持，无新诊断/模型/Memory；A4相关tests/TS/build；A5架构/学习/简证/任务板commit/push/release。
- 先5分钟最小来源契约（不得只信标签或任意measurement），10分钟实现、10分钟验证；只声明有限问法，避免每次输入字符遍历大timeline，按cue/来源缓存或提交时有界读取。不加开放NLP/建议/新存储，0Demo/模型/UI服务/用户DB密钥/部署main，emil/apple沿用，owner清自有资源。

- 交付：在原完整可信诊断gate内新增4类明确资源问法，生产currentDiagnosisWindow/Resources与已展示measurement唯一规范ID、值/类型、标签/单位、非空refs双重匹配；不信label或历史数值。0甲/道具/此前ammo保留，未知不补0，原alive+health0矛盾门不放宽；ammo始终最近记录/非精确瞬间/备弹未知，不产生建议。
- 性能与状态：Host单条immutable plan/cue/timeline/material/player cache＋页面WeakMap来源token，替换/清空旧token失效，source revision与matched值进原问答key；真实spy证明20次草稿/replay零新增投影，新timeline/material各重算一次、旧回调拒绝。原3类/300字/4条/page-only/重播保留保持。
- 验证：真实来源/diagnose/Panel已有数值的4红→绿；新增43、相关5文件210tests、TS和production build通过，主控真实diff只读复核无must-fix。假设/自称数值/其他cue/未来或无源ammo/history/baseline均不能提权；[验收](validation/CURRENT_CUE_RESOURCE_QUESTIONS.md)。
- 文档/release：ARCHITECTURE/学习/本卡/紧凑证据同步后commit/push/release，自有tests/build退出。无新代理/字段/模型/保存/Parser变更，无Demo/浏览器服务/用户DB密钥/部署main。SSR不冒称完整Host、真实浏览器或性能基准，有限问法和manual/重启未支持明确，原UI A5保持。

## 已交付：当前教学点有据追问（2026-09-26）

- 2203ef7已push/clean且owner释放（20相关tests/TS/build）；01a0da30-b678-7c22-8623-707b3f03635a串行负责当前cue问答接口/纯回答投影/Host与小UI/必要保存/tests/docs，主控只读，默认配置。
- 产品证据：PRD7.6/MVP4.3要求当前局面文本追问；实际answerCurrentCueQuestion仅legacy页面使用，默认Host没有入口。旧函数只看PAUSED和observable refs、直接advice[0]，无当前OutcomeGate/字段时间/建议资格，不可直接接通。
- 先10分钟给最小契约与支持问题范围，目标是当前已展示证据内的解释/事实/未知条件及明确越界回退；不做开放聊天或新模型判断。A1实际入口缺失/旧helper不适用的小fixture；A2当前同cue/session且PAUSED+COMPLETE+可信presentable包，回答引用按事实/判断/建议分离，未知不编造/语音只用户假设/职业需已验证样本；A3反思与追问不混淆，已保存诊断不改写、replay/切换时状态隔离、显式重播意图仅调用已有白名单入口，重复无额外诊断/Memory；A4真实生产模块＋Panel交互/SSR、相关tests/TS/build；A5架构/学习/证据/任务板commit/push/release。
- 风险/边界：先小闭环，再扩大支持意图；10分钟契约、20分钟实现、15分钟验证，必要5分钟独立信息边界审查。优先确定性合法内容投影，0模型/Demo/UI服务/用户DB密钥/安装部署main；旧产品scope不改，有限输出/refs，rawReplay不入问答。持久化若需要小版本先说明，不重构历史/Graph；实际UI未验明确说明，owner清进程。

- 本轮交付：新增默认Host本地只读追问入口，三类明确问法/快捷按钮（部分判断依据、当时已知事实、未知条件）＋300字文本。旧legacy不接通；当前plan/session/cue/segment、PAUSED/完整gate、observer身份、诊断链或presentable narration归属及busy/takeover守卫。只用严格合法的已展示决策facts和既有限制，不生成新建议/判断。
- 主控确认的收窄：basis使用实际诊断/assessment引用交集，无法解释时直说不完整，空事实明确无可逐条引用的依据；不把全部facts冒称完整verdict说明。manual首版不显示，不写新持久schema/Graph/Memory。职业/语音/错误前提/不明确问题返回具体边界，文本无控制副作用。
- 保存/交互：Host临时草稿和最近4条，稳定来源key、实时回调门；重播保留，快捷问法不覆盖草稿，切换cue/session/generation或修订隔离。刷新不恢复，不进入历史/总结/长期记忆，不重跑诊断或消费attempt。
- 验证：旧生产helper无gate、未来OUTCOME混入和空advice特征fixture；新增38项，最终5文件81tests、TS、production build通过。[验收](validation/CURRENT_CUE_QUESTIONS.md)。默认cue_question_boundary_review获授权5分钟内独立只读审查无must-fix，主控真实diff复核的小文案修正已复验；没有并行写入。
- 文档/release：ARCHITECTURE明确local只读分工，学习/本卡/紧凑验证同步后commit/push/release；自有tests/build退出。实际Panel callback/SSR＋生产gate/reducer状态fixture不冒称完整Host挂载或浏览器验收。无Demo/模型/UI服务/用户DB/密钥/安装部署main；有限问法、manual/重启历史未支持，原UI A5保持。

## 已交付：诊断数值证据不静默截断（2026-09-26）

- 8a7ecee已push/clean且owner释放（239相关tests/TS/build）。01a0da2a-b0da-7800-8dd1-d34b01af663b串行独占Panel数值列表/必要小样式与本轮docs，默认配置，主控只读。
- 源码证据：DiagnosticResult最多16 measurements；resourceMeasurements依次health/armor/money/equipment/utility/ammo，Panel固定slice(0,4)，合法道具/弹药记录在列表不可见，虽仍在长解释中。本轮仅呈现已有数值，不补数据/改变判决。
- A1实际完整6项diagnosis→Panel SSR确认后2项被截断；A2现有有界数值完整可访问，保持标签/单位/最近采样限定，窄宽度可读，零值保留未知不造值；A3旧历史/trust gate、回看和异议交互不回归，无额外请求；A4复用相关测试/一次渲染证据、TS/build，不为小展示新增大批测试；A5学习/简证/任务板commit/push/release。
- 3分钟现状、8分钟小改、10分钟验证；emil/apple必用，无新动画/表单/分页框架/测量排序体系，不改模型/route/领域schema。无Demo/UI服务/用户数据/密钥/安装部署main；无实际浏览器则明确SSR层次，owner清自有进程。

- 交付：只移除measurement的前4项截断，完整保留既有有界列表（schema最多16）顺序/标签/数值/单位，已知0不丢失、未知不补值、弹药最近记录限定不改。显式列表名称与role，4条CSS调整为容器宽度自适应和长标签/值换行；未新增交互/请求或修改其他面板。
- 验证：真实6项diagnosis→实际Panel SSR精确复现utility/ammo数值行缺失，16项schema夹具同样被截为4，2红→绿。新增3项，复用相关2文件20tests、TypeScript、production build通过；[SSR证据与限制](validation/DIAGNOSIS_MEASUREMENTS_DISPLAY.md)。
- 交付边界：主控只读复核diff，无新代理/239项全量重复；学习/验证/本卡同步后commit/push/release，自有test/build退出。未运行浏览器/屏幕阅读器/窄栏视觉检查，SSR不作为布局验收；无Demo/模型/服务/用户DB/密钥/安装部署。领域及架构契约未变，原UI A5保留。

## 已交付：诊断结果回看当前处理（2026-09-26）

- 6a33ca6已push/clean，181tests/TS/build且owner release；01a0da19-8171-7750-8265-b47a9d50a442串行独占TeachingDiagnosisPanel/Host重播窄接线及相关tests/docs，主控只读，默认配置。
- 证据：默认diagnostics面板只有确认/异议，无回看入口；基础面板已有REPLAY_OUTCOME按钮。诊断后玩家需离开默认教学流程才能重看支撑结论的处理。优先复用Session既有重播动作，不自动启用Graph可视化工具。
- A1生产面板+Host/reducer入口复现可用动作差异；A2诊断完成后显式重看完整当前处理，结束回同cue/原诊断，不自动前进、不再提交反思或调用模型；A3确认下一段、manual默认游标、暂停/取消/接管/忙碌兼容，未提交反思或异议草稿不因重播丢失（可限定入口展示时机，不重写表单系统）；A4相关tests/TS/build，实际层次如实说明不冒称锁屏UI已验；A5架构/学习/证据/任务板commit/push/release。
- 5分钟现状/小复现、15分钟接线、10分钟检查，必要5分钟只读复核；必须emil/apple，复用样式与reduced motion/transparency。不改新判断、cue时刻/完成门/Replay帧/自动工具/Memory，不解析Demo、不起锁屏UI服务、不读用户DB密钥、不安装部署main。owner清测试资源，原UI A5继续独立等待。

- 本轮交付：默认完整诊断结果增加“再看一遍”，经当前身份/结果门/反思与诊断/busy/接管guard调用原transition(REPLAY_OUTCOME)，保留暂停意图reset和幂等USER_INTERACTION，既有播放结束回同cue/decision与保存的诊断。只确认继续才推进，不重复反思、诊断或学习线程。manual不提供新入口，不改其默认游标。
- 草稿边界：反思编辑、异议展开或收起仍有内容/目标时不提供回看；关闭空异议恢复入口。不是将草稿持久化跨Panel卸载，也未新增表单状态系统。
- 验证：原生产Panel无入口1红→绿；新增27项SSR实际按钮回调/状态、生产guard、Session/directive/transport与manual边界。相关11文件239tests、TypeScript和production build通过；独立diagnosis_replay_review只读终审无must-fix。参见[验证](validation/DIAGNOSIS_OUTCOME_REPLAY.md)。
- 文档/release：ARCHITECTURE/TECHNICAL_LEARNINGS/验证与本卡同步后commit/push/release，自有tests/build退出。无Demo/真实模型/浏览器或服务/用户DB/密钥/安装部署main。SSR/fixture不冒称完整Host挂载、iframe或浏览器验收，原UI A5保持未完成；不宣称专业质量或性能提升。

## 已交付：恢复点保存等待与会话归属（2026-09-26）

- 354d2e4已push/clean、owner release；01a0da00-4ec9-7211-b228-55e4def573c7串行独占mirrorAgentResult及其必要checkpoint保存API/小helper/tests/docs，主控只读，默认配置。
- 证据：Controller.dispatchSerial/completeSession仍await onAgentResult；Host mirror先更新latestCheckpoint，await runtime STABLE_BOUNDARY后无当前身份guard直接accept，再取当前history controller保存旧durable。IndexedDB已有1.5秒transaction期限，但appendArtifact/commitRuntimeHead fetch/json无期限。只针对这条生产链先复现卡住/跨review，不展开其他callback扫描。
- A1实际mirror入口+Controller/API deferred fixture，证明悬挂保存和A等存储时打开B的影响；A2当前保存有界且失败明确保留上一个恢复点，live合法结果/完成能继续，不直接detach乱序保存；A3请求前绑定session/run/recovery/generation/review/revision与实例，等待后旧结果不写B的checkpoint/record/artifact/head/error，正常首次checkpoint/同场保存不破坏；A4相关tests/TS/build；A5架构学习证据/任务板commit/push/release。
- 风险/边界：只控制检查点保存的小JSON链，不把Demo/raw上传、所有历史API、服务端事务或重试架构纳入。先查artifact真实大小/语义再选deadline，尽量复用新helper并保留HTTP错误code；超时不证明服务器未写入、零自动retry，不将未完整提交叫耐久成功。5分钟复现/预算、20分钟窄修、10分钟验证，必要5分钟独审；0模型/Demo/UI服务/用户DB/密钥/部署main，owner清临时资源。

- 本轮交付：提取生产mirror入口，实际跨review旧checkpoint/晚accept与晚取B controller、悬挂artifact三红→绿。写任何ref前匹配当前event/result/full identity，捕获generation/openEpoch/recovery/runtime/history ownershipGeneration和既有review/revision，每await及catch重核；首次无record合法缓存与同代pending revision正常完成保留。
- 保存顺序：仅匹配READY/DEGRADED实际record可artifact→head→accept，拒绝draft fallback；DEGRADED内存结果可再由library耐久保存。SESSION_RECOVERY/head各20秒fetch+body，错误code/旧void JSON语义不变；其他artifact尤其AnalysisBundle不套期限，IDB原1.5秒保护不改。失败保留Host上次确认记录、已发服务端写未知，不宣称远端回滚或未提交。
- 验证：生产入口3红→绿；新增mirror22/API9测试；相关11文件181tests、TypeScript及production build通过。真实START_CUE/内存Graph合法checkpoint→默认notify=true mirror挂起时deadline前后dispatch次数1→2，完成请求独立超时测试保留；原完成反馈/Agent与preparation期限/IDB/历史回归保持。隔离序列化DTO artifact1761B/head663B只是fixture，不外推全比赛；实际持久化限制256KiB/head128000B。见[验收](validation/CHECKPOINT_MIRROR_OWNERSHIP.md)。
- 审查/release：默认checkpoint_mirror_review只读调查与终审实现无must-fix；其指出原completion测试不能独证serial tail，已补真实默认路径并验证。架构/学习/本卡先同步后commit/push/release，自有tests/build退出，无Demo/真实模型/浏览器服务/用户DB/密钥/Memory/部署安装。未扩revision创建、其他API、服务端事务或端到端持久化保证；原UI A5保持。

## 已交付：Agent传输等待上限（2026-09-26）

- 6bc126b已push/clean，前owner释放且118tests/TS/build通过；01a0d9f3-fd61-7af0-89a7-5a7462b9bdfb串行独占dispatchCoachAgentEvent传输/必要复用deadline helper/tests/docs，主控只读，默认配置。
- 真实依据：coach-agent-host-adapter.ts的fetch和response.json无期限；Stage3 dispatchSerial await其结果，首请求不settle会卡lifecycleTail。此前只补已失败完成请求UI。preparation-transport已有fetch+body同一20秒deadline/不合作Abort安全settle能力，可复用而非重写队列。
- A1实际dispatch/Controller小fixture复现悬挂fetch/JSON与阻塞后续；A2依据现有服务预算设置有界期限、释放计时器/Abort listener、晚headers不读body/晚result拒绝发布；A3真实Controller失败反馈与串行后续可进、默认diagnosis回退、成功schema/身份及取消保持，不自动重试，超时不假称服务器未执行；A4相关tests/TS/build；A5架构/学习/证据/任务板commit/push/release。
- 5分钟现状与预算、15分钟最小实现、10分钟检查，必要5分钟只读review。无Demo/模型/UI服务/用户DB/密钥/部署main，不改Graph/checkpoint/Memory或全局fetch，不重写通用调度系统。纯fake transport/fake clock；owner清自有资源；不将checkpointer mirror悬挂扩大纳入本轮。

- 交付结果：实际dispatch fetch永不返回、JSON永不返回及Stage3串行tail阻塞3红→绿。Agent fetch+body统一20秒，从网络开始计时；复用preparation owner逻辑小提取，Preparation错误/取消语义不变。超时先本地结算再abort，不合作transport也能退出，晚headers不读body/晚reject被观察。成功schema、HTTP/JSON错误与原eventId保持。
- 预算/局限：Next默认确定性，Graph每cue最多1次Policy，远端Policy route/provider15秒；20秒是等待政策，不是Graph/服务器队列/checkpoint完成保证。不含客户端dispatchSerial排队前时间或后续checkpoint mirror；超时不证明服务器未执行，不自动retry。可选signal测试不冒称所有Host接管都主动abort，原token/identity隔离仍负责旧返回。
- 验证：新Agent17＋原prep8项局部通过；相关11文件169tests、TypeScript、Web production build通过。真实Controller fetch/body timeout后后续队列前进，默认diagnostics可本地fallback，实际Host总结timeout→有限失败artifact，真实Graph WAITING_TOOL迟到正文在dispose后零tool/post/mirror/UI更新。默认agent_deadline_review限定只读终审无must-fix；见[验收](validation/AGENT_TRANSPORT_DEADLINE.md)。
- 文档与release：ARCHITECTURE/TECHNICAL_LEARNINGS/本卡同批更新后commit/push，测试/build退出，无Demo/真实模型/浏览器服务/用户DB/密钥/Memory/部署安装操作。原UI A5仍独立等待；不扩大到持久化或服务器队列。

## 已交付：整场完成同步失败反馈（2026-09-26）

- 4de4a91基线clean，前产品f9d9cbd已完成/release，01a0d9e3-8904-7a40-a998-a6ed8a7558df串行独占本轮Stage3 Controller完成结果/Host收尾/既有总结fallback/tests/docs，主控只读，默认配置。
- 新证据：Controller.completeSession catch返回undefined，CONFIRMED去重和身份不符也返回undefined；Host完成effect只在result存在调用requestStage3WrapUp。Graph不可用而本地诊断/Session已经走完时，摘要可停在IDLE无result，面板空白。先真实controller→Host入口fixture复现，不预设必须新增模型/数据契约。
- A1区分实际失败、pending/已确认去重、过期/取消；A2当前会话失败明确提示未生成并可完成/回看，若存储可用复用既有失败artifact语义；A3重复effect不得把已保存成功覆盖为失败，旧会话不写新UI，默认diagnostics本地fallback可收尾且恢复不重新调用；A4相关tests/TS/production build；A5必要架构/学习/证据/任务板commit/push/release。
- 风险/边界：只修有证据的完成请求→收尾展示，不全Host审计、不重写Graph/恢复/重试框架、不伪造Graph已完成或无重复主题、不改Session完成门。5分钟复现、15分钟实现、10分钟检查，必要5分钟只读review；无Demo/模型/UI服务/用户DB/密钥/部署main。纯fixture/fake transport，owner清自有测试资源。

- 本轮完成：真实Controller→生产Host收尾入口→SSR Panel先复现仅标题/按钮无反馈（1红），现在当前异常/空或未完成/错身份响应均为有限FAILED→既有MISSING_SESSION_SUMMARY artifact。失败不伪Graph/sessionSummaryInput、不推导无重复主题、不保存异常或错误payload。START显示LOADING，pending/CONFIRMED/重复不覆盖；正常完成和自由回看保持。
- 取消边界：attempt由eventId+owner token绑定，当前失败不自动重试；takeover→显式同run返回可释放被取消旧attempt。旧owner迟到不得删新PENDING或改新UI。请求前捕获generation/session/run/review/revision/history epoch，失效回调不发布/写入；当前请求错identity降级而非永久LOADING。
- 验证/审查：8文件118tests、TypeScript、Web production build通过；29项新增入口集成覆盖默认diagnostics答题/跳过经真实同步失败→本地诊断→Session WRAP_UP/完成/自由seek、pending/去重/身份失效、同run返回及正常成功。原139eb95失败artifact验证/历史恢复零重新生成回归通过。默认completion_feedback_review只读终审无must-fix，主控发现的pending和cancel-owner补充边界已修复实测。见[紧凑验收](validation/SESSION_COMPLETION_FEEDBACK.md)。
- 限制与release：不启动浏览器/服务，不读Demo/用户DB/密钥、不调用模型或安装部署main。测试均隔离fixture/fake transport，SSR不冒称真实浏览器验收；原UI A5保持。Agent fetch目前无客户端deadline，永不settle仍pending，但完成和自由回看可用；后续独立处理，不扩本轮。文档、commit/push及自有测试/build退出后释放，旧证据保留。

## 最新交付：弹药真实教学消费已闭合（2026-09-26）

- f9d9cbd已push，主控核对真实diff与PRIOR_TICK_AMMO_EVIDENCE.json；工作树干净、owner01a0d9c5-a6c6-78d3-9b79-acc3620a154e完成goal并release。3/4正式cue消费此前一tick弹匣记录，c1同decision tick开火继续未知，不追求4/4；原9092a71阶段A4缺口已被新证据闭合，已通知原owner仅更新goal。
- 真实本轮1读/1parse（整个弹药工作累计4次），frame7239不变，cache max实测10，来源2970；11/12/14发为此前采样，不是决策瞬间精确余量。44评估、全路线、4诊断判决/建议消融不变；不声称专业质量或稳定性能改善。
- parser9/vendor33、相关180tests、TypeScript、Web/WASM/Viewer构建与ViewerTS通过，clean13patches和0012到0013升级通过；自有进程/临时worktree退出。源码已释放，其他worktree及用户数据保留。
- 后续继续以完整带看、真实教学收益为准，不自动增加稀有字段、不重复此Demo/Jev集合或完整性审查；当前原UI暂停A5仍仅待明确桌面可用条件，由原owner接续，不能把它扩大成全项目等待。新实施任务须先有具体证据并按模板登记。

## 已交付：决策前最近弹药缓存（2026-09-26）

- 实现f9d9cbd已push，01a0d9c5-a6c6-78d3-9b79-acc3620a154e本轮goal完成并release。源任务01a0d9ad-f238-7392-aa56-746b60afd5d6在9092a71的0/4真实消费缺口由本轮3/4证据闭合，历史失败结果保留；主控负责回传旧goal。串行独占实现，默认配置只读ammo_lifecycle_review完成生命周期与时间边界复核，无must-fix。
- 依据：源已证2960/7239条，4个正式cue均与prior隔8ticks且中间开火被正确拒绝。先核实source2 tick lifecycle，再用每玩家仅最新tick-end小缓存，在下一tick-start帧带独立时间；不提高Replay帧率/不存逐tick全帧、不取decision同tick end、不放松开火门，不保证四点覆盖。
- A1真实observer生命周期fixture证明来源严格早于容器/决策；A2跨回合/死亡重生/实体换武器/无效或缺失采样立即失效，未知不回退；A3实际消费按sample时间与独立refs，rich/compact兼容、旧1.9字段不误解释，判决/路线不变；A4先小smoke和成功生产build，再本轮最多1读/parse（总历程第4次）120秒外部上限，小摘要含覆盖/精确变化时刻/同次消融/性能与缓存上限；若0消费不重试；A5相关tests/TS/Web/Viewer/parser构建、架构学习证据和阶段commit/push/release，未达真实消费不标原goal完成。
- 风险/阶段：10分钟生命周期/缓存与内存设计，20分钟最小链，15分钟验证；固定单owner缓存应O(player数)且每tick不做每玩家全实体重复扫描，先明确上界与帧输出不膨胀。必要5分钟独立时间边界review，结束清自有进程。0模型/UI服务/用户DB/密钥/部署main；不扩大到备弹/新战术判断或完整事件系统。原UI A5独立等待。

- 最终验收：真实Observer/CNetMsgTick生命周期与缓存夹具、parser9/vendor33、相关180tests、TS/Web/WASM/Viewer构建与ViewerTS通过；clean13patches和0012→0013标准升级通过。v2保留独立sample/refs与最新缺失marker，未知不回退；controller每tick一次扫描，缓存O(players)。
- 唯一真实读取/解析各1次（历程累计4）：frame仍7239、来源2970、cache最大实测10条、41条空clip采样；正式教学消费3/4。c2/c3/c4分别消费此前记录M4A4=11/FAMAS=12/AK47=14，c1因WEAPON_FIRE@decision19426正确拒绝；44候选/全路线/4诊断判断建议同Replay消融一致。解析7118ms/总7363ms为单次观测，不作性能提升外推。
- 证据：[验收记录](validation/PRIOR_TICK_AMMO.md)、[匿名JSON](validation/PRIOR_TICK_AMMO_EVIDENCE.json)。缓存临时worktree与本轮parse/build/test进程已清理，旧研究证据保留。未读用户DB/密钥、未调用模型、未开UI服务、未安装部署或合并main。备弹与事件完整性仍未知，不把此前采样称为决策瞬间精确量，不声称专业质量提升；原UI A5保持，不为追求4/4放宽边界或自动新增稀有字段。

## 已交付阶段：原始弹药字段解码与生产消费（2026-09-26）

- 1f2b92c调查已push且owner释放。01a0d9ad-f238-7392-aa56-746b60afd5d6串行负责受控source2-demo0.5.4源码副本、单字段patch、可复现Cargo接线与验证通过后最小弹药消费链；默认配置，主控只读。上一轮2次真实读/parse且0消费，本轮明确最多新增1次（跨两轮总3次）。
- 当前授权变化：允许约620K项目内受控vendor，保留许可证/版本/局部patch说明，禁止共享registry修改和新依赖安装；不是升级整个parser。只让CS2 m_iClip1在原wire解码为Unsigned32，消费者再checked_sub(1)，不得有损inverse。先确认真实Field构造/decoder fixture而非重复伪函数规格。
- A1 raw0/1/31/41/101/高位及其他int32不变真实Rust测试；A2原cs2d setup/build/check/reuse可复现采用副本，原parser行为不回归，无隐藏全局Cargo配置；A3原源修复成功后按必要范围复用私有下游快照，独立tick-end严格prior/端点武器身份/变化失效/最近记录措辞，未知不造0、reserve未知，不改判决建议；A4最终WASM一次parse证明来源和实际Host/compact消费并同Replay消融判断/路线不变，相关tests/TS/Web/Viewer/parser构建；A5架构/学习/证据/任务板commit/push/release。
- 风险/阶段：10分钟源码副本和真实decoder smoke、15分钟可复现构建、20分钟下游/验证；单owner、先build成功再跑、120秒外部Demo deadline、bulk留WASM、0模型/UI/服务/用户DB/密钥/部署main。两次同基础设施失败先简化，不为过门扩大allowlist。必要5分钟独立边界审查；owner清理所有临时进程和probe，保留研究快照，原UI A5不动。

## 已交付调查：决策前本人弹药证据（2026-09-26）

- 82d234f已push且owner释放；01a0d989-e5a7-77c3-99fb-75a486bcd8a3负责有限来源调查及有证据才实施的弹药事实链，主控只读协调。默认配置，串行当前树。停止相邻Host回调扫描。
- 依据：contracts/match已有active_item.ammo_clip/ammo_reserve，当前Cs2dPlayerState/normalizeState未提供；Python备用链total_ammo_left是聚合值，不是当前武器弹匣。目标减少讲解缺乏本人可知武器资源背景，绝不由低弹药直接判错或自动建议换弹。
- A1查当前parser/一手源码确切字段、编码与武器实体身份，fixture先验证；A2若可靠，先给主控最小契约后实现parser事实→adapter→决策前新鲜同玩家同回合信息→实际Host/compact教学消费；未知不造0、aggregate不冒充clip、未来结果不回灌；A3必要时单次限120秒真实Demo探针（先编译成功+小smoke），只输出小摘要，证明实际覆盖与原判断不变；A4相关tests/TS/build及触及parser/viewer构建；A5架构/学习/紧凑证据、commit/push/release。有来源/收益阻塞则交可执行调查结论，不为了额度加字段。
- 风险/阶段：10分钟来源调查、5分钟fixture，可靠才20分钟实现；一个原Demo解析owner、bulk留所属进程、禁止多次失败重跑/模型/用户DB/密钥/UI服务/安装部署main；来源编码/主动武器绑定/旧数据兼容为重点。deadline外置，build失败不得运行旧binary；owner清理所有probe/build资源，必要5分钟只读复核。原UI A5继续独立等待明确桌面条件。

- 最终结论：本轮不发布弹药功能。第一次生产WASM来源0；明确追加第二次匿名诊断确认32005个合格end clip均为Signed32而被原门拒绝。source2 0.5.4 signed decoder有高位碰撞，后置inverse不能严格证明raw边界；第三次条件变更后未执行，累计Demo读/parse2，0模型。
- 交付：撤回本轮未证产品与parser接线，保留[来源报告](validation/DECISION_AMMO.md)、两次小摘要、3项离线codec反例和source2局部Unsigned32 decoder建议；实验下游31/相关150tests与TS/build不冒称当前产品能力。私有可复用代码在.local-data/ammo-evidence/rejected-implementation，未提交产品链。
- 恢复验收：原7个upstream源文件精确恢复，普通WASM无probe导出、原Viewer pipeline通过；3项离线codec＋8项patch tests、恢复后TS/Web build通过，自有进程退出，调查commit/push后release。
- 下一有限任务：主控独立评估项目内受控vendor/fork＋固定版本Cargo path override，以正确原wire字段decoder替代有损inverse，不改共享registry/不安装依赖；先字段级fixture/构建，再单独授权真实预算。不能把无public override当项目整体等待，也不能未经来源验证宣称弹药判断提升。原UI A5保持。

## 已交付：恢复入口的等待选文件反馈（2026-09-26）

- 64f9fb5已push且owner释放，01a0d981-0b6d-7143-a1f9-f138ebb0d04a串行独占chooseRecoveryDemo入口/恢复状态反馈/必要helper/tests/docs，主控只读，继承默认配置。
- 真实依据：chooseRecoveryDemo仅scroll/focus却dispatch REPLAY_LOADING，Runtime返回REBUILDING，实际面板显示“正在验证并重新解析”且隐藏choose。没有Demo导入时不应声称在解析；另有直接then(acceptRecoveryResult)旧返回风险。优先修正可见流程，不继续全Host回调扫描。
- 目标/验收：A1实际入口+Runtime/面板复现未选文件的虚假加载；A2等待选同一Demo时明确等待、选择入口可再次使用，未选择/取消不陷无限加载；实际导入后才准确进入解析/验证；A3新review/放弃后旧入口响应不复活旧记录，正常DORMANT/REJECTED/DEGRADED保持，现有握手接线不回归；A4相关tests/TS/build；A5架构/学习/紧凑证据、commit/push/release。
- 风险/边界：先查REPLAY_LOADING的真实消费者，可能只需移除过早事件，不新增虚构进度/重复事件或通用状态框架。5分钟最小复现、15分钟实现、10分钟验证，必要5分钟只读review；不读Demo/模型、不启动锁屏UI/服务、不动用户数据，模拟不冒称浏览器取消验收。owner清理自有测试资源。

- 本轮交付：实际入口＋真实Runtime＋SSR虚假REBUILDING1红→绿。choose仅同步scroll/focus，无runtime请求和可迟到响应；等待说明保留选择入口，DORMANT/REJECTED/DEGRADED原状态/记录不改写。真实Viewer导入进度驱动当前请求的导入提示，握手无需前置REPLAY_LOADING，原Runtime/Viewer契约不改。
- 复核/验收：独立只读发现导入A切换B残留progress会假忙，requestId绑定＋打开历史清进度1红→绿、复审无must-fix。7文件138tests、TS/Web build/diffcheck通过，架构/学习/[证据](validation/RECOVERY_PICKER_FEEDBACK.md)同步；commit/push后release。fakeIDB已清理、测试构建退出，无Demo/模型/UI服务/用户数据操作，未把模拟未选择当浏览器取消通过。
- 下一步：不继续callback扫描。现有[自然动作案例](validation/WINDOW_SELF_FIRE.md)证明技术链有回放材料，完整带看实际效果仍缺原UI暂停A5；仅主控确认桌面可用后优先复用专属窗口Replay缓存再按既定预算接续。本轮未发现新教学缺陷，不制造无依据重构。

## 已交付：放弃恢复的失败与迟到回调（2026-09-26）

- 6509747已push且owner释放；01a0d976-bf65-7ad1-a1d9-4d57c30583c7串行独占discardRecovery窄接线/必要helper/tests/docs，主控只读，继承默认配置。真实代码约1021：DISCARD_RECOVERY任意返回都会清mode/landing/checkpoint/identity，无跨review guard。
- 目标/验收：A1生产派发入口+deferred runtime/fake IDB复现跨review迟到与REJECTED/DEGRADED误清理；A2只在当前操作且耐久删除成功清理，失败保留可恢复资料并明确状态，迟到成功/异常不影响新review；A3初始DORMANT无liveSession也能正常放弃、恢复中放弃仍能取消，旧boundary失效保持；A4相关tests/TS/build及6509747/139eb95回归；A5必要架构/学习/证据、commit/push/release。
- 范围不扩至全Host审计、通用取消框架或Runtime/DB重写，无Demo/模型/UI/服务/用户DB/Memory/密钥/部署main。风险是照搬boundary guard要求liveSession导致DORMANT无法放弃；先5分钟小复现，15分钟窄修，10分钟验证，必要5分钟只读终审，owner清理自有进程与fake存储。无证据不造变更。

- 本轮结果：实际Host discard入口＋BrowserRuntime/fakeIDB/deferred三红→绿；绑定有限记录身份和generation/history/runtime，当前重复点击合并，只有READY/null/null清理。DORMANT无session/identity可用，失败保留Host资料且固定准确提示进入实际面板。
- 复核闭合：慢删除期间已发landing timeout原then会覆写成功提示，主控同意A3范围内窄补，1红→绿；正常current timeout和拒绝discard后timeout仍生效。独立默认只读复审无must-fix。
- 验证/释放：5文件94项＋新增正例，最终43项runtime/Host子集通过（95不同相关用例），TS/Web build/diffcheck通过；架构/学习/[紧凑证据](validation/RECOVERY_DISCARD.md)同步，commit/push后release。自有进程退出、fakeIDB清理，无Demo/模型/UI/服务/用户DB/Memory/密钥或部署main，原UI A5未验。下一候选仅对已读chooseRecoveryDemo的REPLAY_LOADING.then直接accept做小fixture，先证实跨review影响，不自动全Host审计。

## 已交付：旧复盘迟到恢复回调（2026-09-26）

- 139eb95已push且owner释放，新任务01a0d96f-f08d-7470-83b7-cb56bd774cf6串行独占Host完成/同effect稳定边界回调、必要小helper/tests与本轮docs，主控只读，继承默认配置。
- 源码依据：Host SESSION_COMPLETED dispatch.then无身份检查即清checkpoint/recoveryIdentity并acceptRecoveryResult；同effect STABLE_BOUNDARY_REACHED也直接accept。切换历史先增加openEpoch/清旧ref，runtime串行队列并不能让旧Promise回调自动识别新UI。先用生产接线小fixture证明污染再修。
- 目标/验收：A1延迟旧完成/稳定边界返回并切换新review后，新identity/checkpoint/result不变；A2同场正常完成仍清理且总结可收尾，稳定点正常保存；A3取消/新导入/卸载及失败或REJECTED返回有明确边界，不把未成功删除视作成功清理；A4相关tests/TS/build；A5必要架构/学习/证据/任务板commit/push/release。不做全Host审计、Runtime/DB重构、UI/Demo/模型或主main/部署。
- 风险/阶段：5分钟最小复现，15分钟窄修，10分钟相关检查；恢复错误传播和正常收尾竞态为重点。纯fixture/deferred store，不动用户数据；必要5分钟只读复核，owner负责进程退出和临时资源清理。相同工具失败两次先简化。

- 本轮结果：真实BrowserRuntime/fakeIDB延迟通过实际Host发布入口复现完成清空B、稳定点替换B两红；新guard隔离generation/history/operation/runtime/session/recovery/run及接管恢复模式，显式discard立刻失效旧effect。READY/null/null才清理，REJECTED/DEGRADED/异常保留当前identity/checkpoint/record，不把失败当删除成功。
- 验收：2红→绿，5文件74相关tests、TS/Web build通过，同场正常完成/稳定点、同身份snapshot更新、10类失效、晚到错误和总结收尾兼容。独立只读终审无must-fix，补正例后runtime/Host22项通过。架构/学习/紧凑[证据](validation/STALE_RECOVERY_BOUNDARY.md)同步，commit/push后释放写入；无Demo/模型/浏览器/服务/用户SQLite/Memory/密钥操作，测试构建退出，原UI A5不变。
- 下一独立候选：本次显式discard仅负责失效旧完成/稳定点；discard自己的then仍无guard且无条件清identity，可先隔离复现其跨review/删除拒绝语义，再决定小改。未全Host审计或扩成重试框架。

## 已交付：总结失败状态恢复（2026-09-26）

- 上轮04e6b71已push、工作树干净、owner释放；93相关测试/TS/build通过。新任务01a0d964-7dcf-7062-8e43-7b08d87bfa18串行复用当前实现树，默认配置；独占总结Host/展示/必要历史artifact接线、tests及本轮docs，主控只读。
- 真实依据：Host仅正常返回分支保存SESSION_SUMMARY，MISSING_SESSION_SUMMARY与INVALID_PRESENTABLE_INPUT只更新内存；历史restore有summary一律READY，无summary则IDLE，可能把失败/缺失错误显示成无重复主题。先通过生产恢复入口和隔离artifact复现，再做最小修复。
- 目标/验收：A1失败、正常无主题、成功三者恢复可区分；A2失败记录当前身份绑定且恢复保留准确原因/完成回看能力，不冒充教学结论；A3旧保存正文不改写，无模型/分析/Memory副作用，取消/过期generation不写入；A4实际生产保存→validator→restore→展示路径、相关tests/TS/build；A5架构契约必要更新、学习/紧凑证据、commit/push/release。
- 边界与风险：优先既有artifact/result契约，不扩大为DB重构，不改用户SQLite/Demo/密钥，不改判断与播放门；无浏览器/模型/服务/安装部署main。重点失败语义、旧缺失记录诚实提示、artifact写失败与迟到写入。8分钟复现、20分钟实现、10分钟检查，必要5分钟只读终审；owner负责自有测试/build及临时资源退出。

- 本轮交付：统一Host完成保存入口，将三类失败保存为既有FALLBACK/DETERMINISTIC artifact并保留准确有限原因；旧缺失未知、正常无主题与成功明确区分，旧文本/refs/manifest不变且恢复0fetch/0写入。初始展示2红→绿；独立只读复核正常完成identity清理竞态1红→绿并闭合。
- 验收：实际保存→strict append validator→control-plane restore→stored validator→共享面板SSR，保存失败不阻塞生产Session完成/自由seek；当前身份、迟到错误隔离通过。8文件84相关tests、TS/Web production build通过，架构/学习/紧凑证据同步；见[记录](validation/SESSION_SUMMARY_FAILURE_RECOVERY.md)。进程退出后同分支commit/push并release，无Demo/模型/浏览器/服务/用户DB/Memory/密钥或部署main，原A5未验。
- 下一独立建议：小fixture核实Host SESSION_COMPLETED恢复dispatch迟到回调在切换review后是否会清除新identity；这是本轮复核发现的邻近边界，不在本轮扩改或假定必有影响。

## 已交付：封闭整场总结本地完成（2026-09-26）

- 基线0b806b9，01a0d94b-3e01-7003-bd26-8043799d4dc0独占wrap-up客户端/必要Host窄接线/tests/docs，主控只读，有限goal已建。A1生产builder/fake provider确认固定正文与调用成本；A2本地域重建并过原主题/完成/refs/closed校验，保留完整主题和限定；A3确定性来源/取消/恢复不改写；A4实际Host或严格controller完成链、长包/旧HTTP兼容与tests/TS/build；A5架构/学习/证据/commit/push/release。
- refs及limitations允许合法子集，不能称所有bundle完全唯一。保留兼容Provider入口；不做单候选Director跳过（其selected=[]等自由仍存在）。无Demo/模型/UI浏览器/服务/用户DB/Memory/密钥/部署main。Host完成提示如需窄调沿emil/apple技能，不改布局；8分钟诊断、20分钟实现、10分钟检查，必要5分钟只读终审，主控负责进程退出。

## 原始交接：封闭整场总结（2026-09-25）

- 基线4bf1eac已push干净，Narrator快路径owner已release；01a0d94b-3e01-7003-bd26-8043799d4dc0独占本轮wrap-up客户端/必要共享纯校验、相关tests/docs。主控只读，默认配置，串行复用当前树，无Demo/UI/模型。
- 选择依据：单候选Director仍允许selected=[]，保有真实选取/拒绝自由，不能照搬Narrator跳过。wrap-up则要求全部给定主题，summary/trainingAdvice逐字取既有已完成cue，当前requestSessionWrapUp仅零theme免请求，有theme仍请求模型复制。refs/limitations可能有合法子集，不能冒称所有可接受bundle逐字段唯一；目标是领域确定性完整内容、有效refs/限制保留，减少无收益收尾等待。
- 目标/验收：A1用实际SessionWrapUpBuildInput证明主题/教学正文封闭且当前有重复请求；A2从真实本地域输入重建并通过原主题归属/refs/closed语义门，本地确定性完成，禁止信任任意匿名approved或扩大主题/创造建议；A3准确provider/manifest，完成会话后才总结、取消/过期generation不写入、空theme/旧保存复用/多主题兼容；A4生产Host总结触发与内存Graph/恢复实际入口计数及相关tests/TS/build；A5架构/学习日志/紧凑证据/任务板commit/push/release及下一独立建议。
- 边界：不跳过Director/Jev/Policy，不改变会话完成门/记忆写入/训练建议，不删除兼容HTTP provider或放松校验，不把新本地产物伪报模型成功，不重写旧总结。不复测同一Demo或Jev，无浏览器服务/用户DB/Memory/密钥/安装发布main合并。原A5不动。
- 风险/阶段：8分钟语义/调用复现、20分钟实现/接线、10分钟相关检查；重点已完成来源、主题全集/引用映射、信息未知、取消和strict兼容、过长领域有效包不误卡。纯fixture/fake transport；必要5分钟只读终审，单写owner，负责test/build退出与自有临时清理。

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

- 本轮结果：默认当前总结本地完成，HTTP/Provider1+1→0+0；固定正文/完整主题与合法引用、来源限定保持，refs/限制子集自由未被宣称唯一。协调批准的Host窄修：真实Graph2同主题cue完成→1代表/2support，原Host基线1红、修复后产生1主题且仍仅1代表，不扩完成/专业门。
- 复核与边界：local_wrap_up_review发现正文ref未指实际代表及遗漏来源限定，2红→绿；去重合并限定，>8 typed失败且兼容HTTP400/0fetch，不截断/不扩schema。真实Host面板SSR+生产Session完成及自由seek验证失败保留回看/完成，正常本地不报模型失败，捕获旧generation并只发布COMPLETED结果。旧summary原文restore0fetch。
- 验收/释放：8文件93tests、TS/Web build通过；架构/学习/验证已同步，无Demo/模型/UI浏览器/服务/用户DB/Memory/密钥/Parser Viewer或发布main，全部进程退出，commit/push后release；见[记录](validation/LOCAL_SESSION_WRAP_UP.md)。原A5保持未验。下一独立建议：隔离artifact fixture核实总结失败后恢复是否丢失说明（当前仅成功分支保存摘要），不自动重生成旧内容。

## 当前独立任务：封闭讲解本地快路径（2026-09-25）

- 基线33b43e8，前owner均release，01a0d93c-fe09-7401-8afc-6a05fea80a91独占Narrator窄快路径/相关tests/docs，有限goal已建。按模板A1实际context/client/provider假链证明复制等价与调用成本；A2仅从完整Coaching/Outcome包独立重建并复用原schema/引用/closed语义校验后本地完成；A3真实DETERMINISTIC来源、既有DISABLED/FALLBACK就绪和取消；A4首窗/后续/恢复/旧HTTP及期限兼容、相关tests/TS/build；A5文档commit/push/release与下一建议。
- 已核实客户端持有完整领域包，匿名HTTP入口没有足够材料独立重建专业批准文本。因此快路径置于客户端，保留匿名server/legacy请求与全部校验；不直接信任request.approvedNarration。不要为小优化新增状态或改变Director/Jev/结果门/历史产物。
- 风险/阶段：8分钟等价与请求计数复现、20分钟窄实现/回归、10分钟TS/build；重点不可信approved、来源真假、取消和旧异步期限。只用fake transport/内存数据，无Demo/模型/UI/服务/用户DB/Memory/密钥/安装发布main；必要5分钟独立只读终审，主控单写且负责全部进程退出。

- 交付结果：生产context/client/Provider假链等价＋成本2红→绿。当前协议从领域包重建并经过原共享wire与domain门，本地DISABLED/DETERMINISTIC/CLOSED_SEMANTIC_PROJECTION，单cueHTTP/Provider1+1→0+0；三cue首两就绪/后续零Narrator网络和计时器、正文不变，旧saved/恢复零重新生成。
- 兼容/复核：缺approved保留HTTP/Provider/期限/取消；身份/ref错误仍拒绝。只读narration_fast_path_review发现领域有效长文超wire限制会卡PENDING，1红→绿修复为原domain fallback、真实来源LOCAL_WIRE_VALIDATION_FAILED，闭合无must-fix。9文件130tests、TS/Web build通过；见[验证](validation/CLOSED_NARRATION_FAST_PATH.md)。
- release/下一步：所有tests/build退出，无Demo/真实模型/UI/服务/用户DB/Memory/密钥/安装发布main。同分支commit/push后释放，原A5保持未验。可独立用单候选fixture核实Director是否有真实选择自由，再判断是否存在等价省请求机会，不先关闭其决策能力或重复Jev拒判。

## 本轮独立任务：处理窗口内本人开火事实（2026-09-25）

- 基线6ef784a干净已push，真实慢放资格任务已release；01a0d92a-c3dd-7143-9894-d5eaadcec0a8独占Adapter动作事实生产/必要窄引用接线、相关tests/验证工具/docs。主控只读，默认配置，串行复用已有树，不碰锁屏UI。
- 已见路径：hasVerifiedAction只覆盖RETURN_AND_FIRE/UTILITY/非爆炸BOMB；普通明确shooter的shot只进WEAPON_FIRE。上一轮15/16自然cue无PlayerActionFact，尚未证明这些窗口有shot。本轮先fixture区分真正没动作与已存在本人事件未传递，不把覆盖数当教学质量。
- 目标/验收：A1实际Adapter/Compiler/Narrator在DEATH或HP_CHANGE处理窗口有独立本人shot但action缺失先红；A2仅绑定当前同回合、明确本人、合法canonical且在已有处理窗口的shot，时间语义清楚，未知actor/未来/他人/死亡后或同tick顺序不明拒绝；A3独立PLAYER_ACTION只说已记录本人开火，不猜目标/命中/接敌/重复peek/意图，最多有界事实/refs，不借结果造动作，现有选点/decisionTick/assessment/门不变；A4真实生产Narrator/Host自然资格、旧历史兼容及相关tests/TS/Web build，必要一次最终WASM同进程消融验消费（先smoke，无Parser重建）；A5架构/学习日志/证据/任务板commit/push并release与下一建议。
- 风险/阶段：8分钟复现/时间契约，25分钟实现回归，10分钟验证构建；最多一次真实解析、120秒进程组deadline，bulk单owner，阶段小摘要先落位。范围先DEATH/HP_CHANGE两类，不为更多case扩选点/延长窗口或再提名事件。引用event稳定、source refs可追溯，死亡tick不推定事件次序；同一事件在既有动作事实内不重复放大。没有合法shot则仍无action/FINISH，不强制工具。无模型/UI/服务/用户DB/Memory/密钥/安装发布main，原A5单独待恢复。必要5分钟只读信息边界终审，执行者清理全部进程。

- 本轮完成：实际基线f747eca；Adapter→Compiler→Narrator两类2红→绿。严格决策后/揭示前/已知死亡前，仅已有DEATH/HP_CHANGE一条presentationOnly发生事实（最多3源ref），不重复现有动作。发现原动作排序加分会潜在漂移，窄标记贯通canonical/material/strict诊断并排除rank与专业过程判断，旧动作缺省不变。Adapter/signals1.8、Generator2.4，旧1.7可读。
- 真实/验收：一次Dog WASM6395ms/总6795ms、0fetch；44候选10窗口=9独立shot，四正式cue由0自然effect变2（c2/R5 shot31185、c3/R7 shot44510），全部candidate assessment/Director摘要/路线ID与窗口消融一致。326相关tests通过/1既有缺WebGPU产物skip，项目与脚本TS、Web build通过。只读window_fire_boundary_review发现非法死亡frame/hurt tick边界，3红→绿并闭合；见[验证](validation/WINDOW_SELF_FIRE.md)。
- 清理/release：无第二次解析、其他玩家、模型/UI/服务/用户DB/Memory/密钥/Parser或Viewer修改及安装发布main；所有进程退出，同分支commit/push后释放写入，原A5保持。新增供后续UI定位的Dog自然case也只经模拟进度/ACK，不能当作真实播放。下一独立建议为假provider下生成式Narrator的presentationOnly事实不扩写边界测试，不默认live调用或重读。

## 用户纠正与当前独立工作线（2026-09-25）

用户再次明确“怎么停了，继续”：锁屏只阻塞原UI A5，不代表项目整体应等待。主控继续推进不依赖桌面的真实数据、接线、恢复与学习；阶段交付后选择下一项有实际收益的独立工作。不能把无新UI条件当作停掉全部工作的依据，也不制造无价值变更或重复审计。heartbeat同样遵守这条纠正。

任务01a0d91d-29b6-7b80-b935-ef39ee0d0966“验证真实路线的自然慢放资格”已完成本地验收，实际起始基线458ec88（产品b5da690）；同分支commit/push后释放脚本/证据/docs写入，主控接续选择独立工作。原A5/残留InPrivate窗口保持独立待恢复，不启动CUA。

- 目标/流程：已有Demo只解析一次→先Dog，再必要时同一Replay其余玩家逐个派生真实规则路线→生产Compiler/Narrator/Host当前purpose资格→默认Graph/Host command，形成自然可执行案例和具体拒绝原因；不强制cue/工具，不冒称UI通过。
- 验收：A1先纯fixture贯通工具入口和状态机，确保smoke覆盖普通SKIP、多cue；A2一次WASM120秒、单进程拥有bulk且每player只留紧凑摘要，最多10人；A3自然候选与门逐项来源有据，默认Policy能自然effect或明确FINISH，至少一个合法case验证Host命令与原窗口/refs；A4真实缺陷先小fixture复现再窄修，相关tests/TS/build后push，无问题只交学习证据；A5记录真实数据与模拟执行界限、清理/释放和下一高价值建议。
- 风险/阶段：5分钟小smoke、一次解析及所有派生总120秒，20分钟核对/必要修复，10分钟checks/build；每stage先写小摘要再进行下游步骤，不能因恢复辅助失败丢全部证据。只允许一次读Demo，不再新native/browser/harness；同基础设施两败先简化。命令端模拟只证明接线，不关闭真实pause≥12秒/seek/reconnect A5。无外部模型/用户DB/Memory/密钥/安装发布main合并，默认模型/推理，单写owner，不复制大数据。

- 本轮结果：唯一Demo读取/解析各1次，6255ms解析/7053ms总计，外部120秒限时。按Dog优先顺序顺次派生6玩家、356候选、16自然cue；P6/c1/R1 decision8257/reveal8259/end8515得到自然ACTION_FACT_REPLAY→默认Graph→Host8193–8515/0.5倍速命令，15cue无PlayerActionFact正确FINISH。无产品缺陷，无Parser/Viewer/判断/路线改动。
- 验证/局限：两cue/普通skip/自动freeze smoke先通过，真实各Session结果门由reducer到达；一条ACK明确模拟，原UI A5不变，规则路线无CS-Net/模型且不是此前UI同一路线。项目/脚本TS与production build通过（移走旧临时验收接口的过期Next dev类型缓存后）；独立5分钟只读real_route_evidence_review无must-fix，不重复257基线测试。见[记录](validation/REAL_ACTION_REPLAY.md)和匿名JSON。
- 释放/下一步：全部parse/smoke/check/build退出，无浏览器/服务/用户DB/Memory/密钥操作；commit/push后release。下一独立方向：Adapter普通shot已进WEAPON_FIRE，但hasVerifiedAction仅RETURN_AND_FIRE/UTILITY/非爆炸BOMB；用小fixture证明确有合法shot时DEATH/HP_CHANGE窗口是否有事实传递缺口，不能从15无action臆断窗口实际有开火；不能将锁屏视为整体项目停止，也不能自动重读同一Demo。

## 新接线后的原A5接续（2026-09-25）

- 基线b5da690干净且已push，接线owner已release；主控核对currentEvidenceBound/currentActionRefs、默认Graph自然effect及CURRENT_FOCUS_ACTION_REPLAY记录。唯一新增ACTION_FACT_REPLAY仍要求真实动作、同cue/candidate/frozen窗口、Narrator引用、Outcome实际完成；不改变assessment或专业门。
- 原owner01a0d77e-085f-7880-9331-c01becde48cd重新独占UI/服务/必要窄修复与A5文档。实际代码变化提供新的验证条件；先桌面可操作smoke，仍锁屏即停UI，不换驱动。可用时单controller40分钟，现有静态Viewer/最新Host、空provider/Memory关闭、同Demo一次解析，自然路线/Policy，绝不强制tool。
- 原A5保持：真实合法工具callId暂停≥12秒且不超时/不新建调用，续播同实例一次完成，必要seek/重连失效；无工具时精确记录缺失条件，不再猜已成功。新capability只是集成通过，不等于真实4cue已拥有工具；地图/道具等新purpose未开放。实际问题最小修复及相关checks后push；无代码改动只补证据，退出清理专用窗口/服务并release。

- 21:48实际续跑：6cb402d干净基线、桌面与入口点击smoke成功，新专用InPrivate＋单controller13398；原Demo本轮一次解析完成并出现10人选择页。点击Dog时CUA明确Mac锁屏、自动解锁失败，未确认选定玩家/CS-Net/任何cue工具，不重试或换harness。服务仅IDLE，无START_CUE/tool/RESUME_TOOL；新接线实际效果仍未知，旧4cue空工具证据不外推至新版本。
- 本轮只有验证文档变更，不改产品/资格/Policy、不调用模型；全部临时遥测/next-env差异清除、生产diff零，不重复257相关用例/构建。controller已停、3000/5174释放；新InPrivate因锁屏未关，未强杀用户Edge。文档push后释放写入/服务，原A5和goal未完成。主控收到明确恢复证据后再协调接续，先检查专用窗口现有解析缓存，不自动重复导入。

## 用户主动续跑：补齐原工具暂停A5（2026-09-25）

- 用户在记录等待条件后明确发送“继续”。这授权接续工作及一次当前桌面可操作性检查，不等于已确认解锁成功。原负责人01a0d77e-085f-7880-9331-c01becde48cd优先接回A5，基线cb49754（最新产品886e9ad）；其他任务全部release。
- 本轮由原负责人独占当前树的必要修复/验证文档和唯一浏览器/Worker/服务controller。先只做轻量可操作性检查；若仍锁屏则不启动服务或解析、不反复尝试。若恢复，按原TEACHING_PLAYBACK_CONTROLS.md识别专用InPrivate窗口，保留用户其他窗口，单控制器40分钟、已有Demo一次解析、空provider/Memory关闭。
- 原验收不变：仅实际合法Stage3播放tool/callId可计，暂停至少12秒后同实例续播一次完成，加必要显式seek与重连；不把Session重播或零工具FINISH算成功。先检查真实4cue资格，无合格工具则报告样本缺口，不强制制造。新发现必要修复相关tests/TS/build后同分支push；仅补UI证据不重复基线全套。完成或再次阻塞都明确清理/释放所有权。

- 21:17接续结果：桌面恢复，旧专用窗口已不存在；新InPrivate与单controller完成原Demo本轮一次解析，Dog自然4 cues逐一播放结果并停靠。c1/R1/3081、c2/R3/19426、c3/R5/31179、c4/R7/45091均显示无需额外演示；临时Agent小摘要确认每次START_CUE capabilities=[]/effects=[]、完成计数1→4，RESUME_TOOL总0。没有强制工具/改门/切模型/第二次解析，原A5仍未完成，当前阻塞不是锁屏。
- 本轮只补实际验证文档与去身份摘要，生产diff零、不重复既有156/180测试/构建。临时遥测移除、next-env差异恢复，本轮InPrivate已关闭并回到用户普通新标签页；controller67027退出、3000/5174无监听。文档commit/push后释放写入/全部资源。
- 原因尚未确证：主控只读发现teaching-gates新focus集合与capability-builder/Host部分旧focus白名单可能未同步。这是独立最小复现的后继线索，不能把本次空capabilities直接归因于事实不足，也不为完成A5直接放开工具。原goal工具仍blocked、无resume接口；不另建或标complete。后续先核实合法语义接线，再按真实工具证据补原A5。

## 此前续跑入口（2026-09-25 21:04）

- 最新已验证实现886e9ad，全部近期写任务已结束并释放资源，当前没有活动写入负责人。主控已核对真实关键diff和REAL_CUE_RESOURCE_CONSUMPTION证据；资源投影/未知说明/恢复消费中已确认的问题均已修复。没有新的失败，不再重复同一Demo、相同模型拒判输入、已通过测试或假设性全仓检查。
- 下一优先项仍是原教学工具暂停A5：需出现明确桌面控制恢复的新证据或用户确认，再由01a0d77e-085f-7880-9331-c01becde48cd按原记录接续实际tool/callId的暂停≥12秒/同次续播/必要seek与重连。当前没有新的解锁证据；不因heartbeat或时间经过重复唤醒CUA、另开harness或强制制造工具。残留专用Edge窗口仍交原负责人处理。
- 教学质量下一步需要可靠接触/空间事实或独立专业标签；现有4cue与人工RISK/TRADE探针只能证明事实消费，不能充当专业黄金集。新增hurt/shot/clock本身不构成再次跑同一Jev集合的理由。CI1.89与公开发布限制仍按各验证记录，不为补证触发发布或安装工具。
- 此轮只记录续跑条件，不新增功能或验证任务；已通过的180测试/TS/Web build不重复运行，自动统筹保持启用。有新的用户指示、可复现体验问题、数据/来源证据或环境变化时重新选任务并填写模板，不将这里解释为项目已全部完成或用户暂停。

## 当前成果与任务

| 状态 | 任务 | 对话 / 所有权 | 证据与下一步 |
|---|---|---|---|
| 已push | Jev受限评估与准备性能修复 | 原任务 01a0c914-96d1-72c0-b00d-f1b02ed6f4a4（空闲，不再派发写工作） | da640a6；1039 tests、TS、Web/Viewer/desktop构建和sidecar通过 |
| 已push | 观察语义与联合证据协议 | 同上 | 6ba9e31；1073 tests/TS/Web/Viewer通过；27次live未证明Jev判断质量提高 |
| 已push | 真实整场复盘体验与可靠性改进 | 01a0d72c-d1b6-7d31-9b5a-8705470ff0be（已结束，释放写入与进程） | d69a290；修复启动阻塞、已看cue回访跳过结果门；真实9回合/4cue到完成、刷新恢复、相关测试/TS/build通过；主控核对关键diff与验证记录 |
| 已push、验收完成 | 暂停/播放保留带看意图 | 01a0d759-8472-7072-ae94-84ec101ece3b；已完成并释放写入/进程 | bf42aef修复；105测试/TS/build通过，锁屏恢复后原A5四条真实交互及Space/Return通过；见GUIDED_PAUSE_RESUME.md |
| 新接线真实验收再次受锁屏阻塞 | 教学演示暂停与继续 | 01a0d77e-085f-7880-9331-c01becde48cd；文档push后释放写入/服务，专用窗口待解锁清理 | 6cb402d桌面smoke/一次解析成功，选择Dog时重新锁屏，未取得tool证据；新b5da690真实效果未验，不能沿用a35614d空工具结论；原A5保持未完成 |
| 实现与本地验收完成 | 区分无需演示与实际工具完成 | 01a0d795-539b-7421-afbd-64e3f0e5c42a；阶段push后释放写入，无服务/浏览器 | 当前身份完成说明接入真实渲染；无演示、具体成功、失败与未知恢复准确区分；84测试/TS/production build通过，详见TEACHING_COMPLETION_STATUS.md；不关闭原工具暂停A5 |
| 已push | 决策时公开回合时钟 | 01a0d7bb-d7ea-7e21-864f-54e7e2e17049，完成并释放写入 | 9150d51；44候选/38个有效时钟、4cue/3个教学包消费，148测试通过/1个既有缺产物跳过，TS/Web/Viewer构建通过；暂停补偿未知仍null，不据时间单独判错，见PUBLIC_ROUND_CLOCK.md |
| 已push | 新解析器构建工具链配置 | 01a0d7ce-5686-7d33-84f4-717bae0a8401，完成并释放写入/进程 | 355e3f7；CI补WASM target/固定CLI0.2.125，保持Rust1.89；本地同toolchain预检和一次编译接线完成，21测试/真实parser与Viewer构建/TS/Web build通过；CI及1.89实际编译未运行，见PARSER_TOOLCHAIN.md |
| 已push | 准备阶段本地请求期限 | 01a0d7e0-5597-7bf1-bc85-832b767654a7，完成并释放写入/进程 | 413f15a；两个client fetch＋JSON共用20秒期限，父取消立即退出；4红复现后69相关测试/TS/build通过，真实prepare集成证明fallback后READY_TO_START/后续准备与保存恢复零请求；见PREPARATION_REQUEST_DEADLINES.md |
| 已push、本地验收完成 | 逐次受击事实与决策前本人证据 | 01a0d7f1-0580-7910-abbd-554dcd9a55de；已完成，释放写入与进程 | 264 hurt/本人27，23/44 snapshot和2/4教学包/确定性讲解实际消费；182测试+Rust3/TS/Web与Viewer构建通过；仍不证明专业判断提升，见SELF_HURT_EVIDENCE.md |
| 已push、本地验收完成 | 射击事件即时身份归属 | 01a0d81c-bee6-7161-9cae-58ff2eea392b；完成并释放写入与进程 | 旧生产路径6红→绿，最终Rust夹具9＋parser3、186相关测试/TS/Web和Viewer构建通过；一次WASM1242shot/本人152、hurt与clock保持，见CURRENT_SHOT_IDENTITY.md |
| 已push、本地验收完成 | 诊断道具数量与未知库存 | 01a0d837-aff5-7560-a4b1-ba553cd77ba6；完成并释放写入/进程 | 生产双入口4红→绿，共享utilityCount，不重解释legacy总数；79测试/TS/build通过，Graph/API/恢复/SSR已验证，见DIAGNOSTIC_UTILITY_COUNT.md |
| 已push、本地验收完成 | 诊断资源时效与回合绑定 | 01a0d850-9c52-7803-85ca-03c7c8f5576e；完成并释放写入/进程 | 过期/跨回合2红→绿，同回合半秒门与独立可信decisionRoster落地；147测试/TS/build通过，见DIAGNOSTIC_RESOURCE_FRESHNESS.md |
| 已push、本地验收完成 | 可信部分资源的独立测量 | 01a0d870-79b9-7d22-ae10-fc28ec2ceb6b；完成并释放写入/进程 | 70HP/80甲与未知helmet两红→绿，partial compact和三值资源背景落地；177测试/TS/build通过，见PARTIAL_DIAGNOSTIC_RESOURCES.md |
| 已push、本地验收完成 | 真实教学点诊断消费验证 | 01a0d88c-619b-7e72-8133-40fae1e40057；完成并释放写入/进程 | 实际4cue均age0，partial库存未知/独立人数/8输出恢复通过；发现正人数被文案说未知并窄修，180测试/TS/build通过；首次harness失败后获准补读，总2次，见REAL_CUE_RESOURCE_CONSUMPTION.md |

| 已push，本地验收完成 | 现行教学主题与证据工具接线 | 01a0d8c0-2ca6-71e2-a54c-d210097d46b3；已release | b5da690；当前Compiler→Host红→绿，唯一ACTION_FACT_REPLAY保持动作/引用/完整结果窗口门，默认Graph自然effect；257相关用例/TS/build通过，真实UI待原A5 |

| 已push，验收完成 | 真实路线自然慢放资格 | 01a0d91d-29b6-7b80-b935-ef39ee0d0966；已release | 6ef784a；一次解析6玩家/16cue，1个P6 C4类自然慢放及15个无动作正确FINISH，0fetch；模拟ACK不关闭A5 |

| 已push，验收完成 | 处理窗口内本人开火事实 | 01a0d92a-c3dd-7143-9894-d5eaadcec0a8；已release | 69ca18e；10窗口/9shot，4cue路线与判断不变，0→2自然慢放；326tests/1旧skip/TS/build通过，模拟ACK不关闭A5 |

| 已push，验收完成 | 封闭讲解本地快路径 | 01a0d93c-fe09-7401-8afc-6a05fea80a91；已release | 4bf1eac；当前语义等价、Narrator client/provider 1+1→0+0，130tests/TS/build；legacy provider保留 |

| 已完成本地验收，同分支交付 | 封闭整场总结本地完成 | 01a0d94b-3e01-7003-bd26-8043799d4dc0；push后release | 当前请求1+1→0+0；真实Graph支持/代表分离及引用/限定修复，93tests/TS/build；不省Director真实决策 |

当前实现工作树：/Users/vekel/.codex/worktrees/7f2b/CS-agent，分支 codex/jev-decision-assessment。主工作区 /Users/vekel/编程/CS-agent 仍在main，含用户未跟踪提示词；不得覆盖。工作树位置变化时用 git worktree list 核实并更新本表。

## 本轮任务卡：现行教学主题与证据工具接线（2026-09-25）

- 基线a35614d干净已push，原A5负责人已关闭专用窗口/服务并release。新任务01a0d8c0-2ca6-71e2-a54c-d210097d46b3独占capability builder/必要Host接线/相关tests和docs；默认配置，串行复用当前树，主控只读。原A5仍未通过，不改其验收记录。
- 新证据：teaching-gates.allowedTeachingFocusCodes产VERIFIED_DECISION_REVIEW/EXECUTION_REVIEW/POSITIVE_PROCESS/FORCED_CHOICE/REVIEW_UNCERTAINTY；capability-builder的timing/map/utility/impact旧枚举与regex基本不识别它们，Host economy白名单也是旧focus。真实4cue空capability证明症状，但具体新旧主题映射仍需独立复现。
- 目标/验收：A1由当前Compiler产生真实现行focus，并用具有实际合法action/annotation/trajectory等的fixture通过生产Host→builder证明资格断层；A2明确现行focus（判断类别）和工具展示目的的关系，不把所有新focus简单加入所有工具白名单，不伪造refs或专业判断；A3每工具仍要求现有动作/空间/道具/量化来源及结果门，未知/空证据/错scope继续零工具，旧合法路径兼容；A4实际Graph默认Policy能消费合法候选而非仅builder非空，取消/暂停/旧调用边界保持，相关tests/TS/build；A5架构/学习日志/记录/任务板commit/push，release后才由原owner补A5。
- 边界：不改route/assessment/引用强度/接触LOS门，不以INSUFFICIENT自动禁止事实回看，也不以不确定自动允许所有演示。需要对照展示的动作必须有可验证事实、工具用途明确且文案不暗示已判错；已有事实不足的cue仍FINISH。不能以本轮UI验收凑数为目标，不强制Policy或任意callId，不新增model调用。
- 风险/阶段：10分钟复现和契约、25分钟实现/局部检查、10分钟TS/build；无新Demo解析/浏览器/服务/用户DB，复用已有小证据/fixture。必要独立只读边界审查5分钟，单写owner。若无法证明合理工具因旧focus被拒，交研究证据停止，不制造资格放宽。执行者负责全部进程清理；不改Viewer/Parser或安装发布main，不关闭原A5。

- 交付结果：实际起始基线 c6265b1。Compiler→Narrator→Host→builder 原 1 红→绿；只开放 ACTION_FACT_REPLAY，默认内存 Graph 自然 effect→Host command，判断仍 INSUFFICIENT_EVIDENCE。其他新用途缩出本轮，不将当前 focus 加入通用工具白名单。
- 边界复核：purpose_boundary_review 只读 5 分钟上限及 1 分钟闭合，指出冻结窗口/实际完成末端门遗漏；2 红→绿修复并闭合。合计 257 个不同相关测试、TypeScript/Web production build 通过，详见 [验证记录](validation/CURRENT_FOCUS_ACTION_REPLAY.md)。
- 限制/释放：未运行 Demo/模型/UI/服务或修改用户 DB，未改 Viewer/Parser、原 A5 证据。所有测试/build 退出，同分支 commit/push 后释放写入。后续交原 A5 owner 验证真实自然工具，不声称四 cue 已有工具或 Jev 专业质量提高。

## 本轮任务卡：真实教学点诊断消费验证（2026-09-25）

- 基线43746ce（41799f6＋交接）已push干净，partial任务release；01a0d88c-619b-7e72-8133-40fae1e40057独占本轮小验证工具/证据/docs及真实发现的必要窄修复，主控只读。默认配置，无需额外子代理或数据复制；使用现有WASM和授权Demo。
- 目标：最近utility/freshness/partial三轮已验证fixture，但尚无实际Demo→当前Host诊断的消费证据。验证真实正式cue能显示哪些可靠血量/护甲/道具/人数、哪些应未知，当前讲解不泄漏来源不明数值。不重复shot/hurt/clock源头实验或同Jev拒判集。
- 流程/验收：A1先以小fixture smoke复用脚本/import和生产Host调用，避免解析后才发现脚本错误；A2原有60.6MB Demo一次WASM解析（120秒），同进程持有Replay、Adapter及当前4cue，经过生产Host submission/诊断和保存往返；A3回传逐cue紧凑测量/未知原因/样本age/引用对照，原始帧和身份留owner，明确人工RISK/TRADE探针选择不是用户真实意图；A4若有真实功能缺陷先用最小fixture复现再修，在同次解析内留紧凑必要数据避免重复读Demo，相关tests/TS/build后push；无缺陷则只交实际学习证据，不制造代码变更；A5记录局限与清理、任务板及提交push。
- 边界：没有UI或完整播放器验收，不关闭原工具暂停A5；不访问用户数据库/记忆或保存探针用户意图，不调用模型、不改教学阈值/路线、不伪造工具/cue、不重建Parser/Viewer（自e90493b未改源码，现有构建可复用），不做hash审计。旧历史仍仅隔离内存恢复。
- 风险/阶段：5分钟入口smoke、一次最终解析120秒、15分钟核对真实测量与必要窄修复；bulk不经工具输出/持久文件，固定一个进程owner，最终只摘要。编译或smoke失败不得进入Demo解析；同基础设施失败两次先简化，不换多套harness。无生产修改则不重复177测试/TS/build，明确沿用已通过基线；新增工具按其实际风险做小验证。执行者负责所有进程/临时文件清理，保留用户Demo/缓存/其他树，不安装部署main合并。

- 实际结果：9round/44候选/4正式cue均同round sample=decision、age0≤32；HP/甲为5/68、20/48、100/100、73/97，头盔均true，道具1/未知/1/1，人数4/0/0/0。RISK背景3受限1未触发阈值，所有Verdict仍INCONCLUSIVE；第2cue缺库存仍保留其它字段，第三cue存款0保留。8个risk/trade输出local/compact一致、隔离恢复新增fetch/诊断0。
- 执行偏差：首次小fixture未覆盖普通SKIP，真实parse后恢复helper错误ADVANCE_SEGMENT阻塞且未写出摘要。立即报告后修同一脚本为SKIP_SEGMENT、普通skip/双cue smoke通过，并按协调明确追加授权补读1次；总2次真实读取。成功parse6079ms/总6317ms，bulk一直在单进程，修脚本后每cue先小摘要再独立恢复，不改Session门。
- 确证修复/验收：真实第1cue已知4队友却说缺少是否存活，最小fixture1红→绿；只改正人数文字/roster refs，不改status或专业门。已捕获小投影复放确认最终说明，没有第三次Demo读取。生产改动后7文件180测试/TS/build通过；文档/JSON证据记录真实探针与所有局限。未知helmet/false及其他拒绝边界仅fixture，不冒称真实覆盖。
- 清理：默认配置root独占，无子代理，无模型/浏览器/服务/用户DB/Memory/密钥/安装发布/main合并，WASM未重建、旧A5不动。所有parse/smoke/复放/tests/build退出，只保留去身份小日志/证据，commit/push后释放；见[记录](validation/REAL_CUE_RESOURCE_CONSUMPTION.md)。

## 本轮任务卡：可信部分资源的独立测量（2026-09-25）

- 基线7d5de37（aad0732＋交接）已push干净，前任务release；本轮01a0d870-79b9-7d22-ae10-fc28ec2ceb6b独占Host资源投影/窄诊断contracts/helper/执行器及tests/docs。默认配置，串行复用当前树，主控只读。
- 新证据：当前fresh selector对helmet缺失一律整份return，DecisionResources又要求health/armor/hasHelmet齐备；真实parser省略false helmet，Snapshot保守保留null，所以新鲜已知血量/护甲可因无关头盔unknown全部丢失。不能撤掉新鲜度门或将unknown补false来救显示；需分离整体样本可信性与字段可用性。
- 目标/验收：A1生产Host/local/remote复现helmet unknown使known health/armor消失；A2保持同round/player/decision/半秒/死亡/绑定门后逐字段保留可靠值，不制造新rich假默认，字段missing/null/非法仅使该字段unknown；A3只显示已知测量，unknown不是0/false；低资源背景仅由明确已知条件支持，部分高值不能推出资源足够，维持既有数值阈值与Verdict INCONCLUSIVE；A4旧完整投影/legacy utility/roster/已保存恢复兼容，Graph/API与Host结果一致、相关tests/TS/build；A5架构/学习日志/验证/任务板及commit/push。
- 边界：此轮明确允许窄partial DecisionResources契约及资源背景三值处理，不升级专业判断，不修改Parser/Viewer/原始PlayerState全域类型、不重写历史。不借schema变更吞掉未来/身份错误/过期数据；总体可信门失败仍无资源。只恢复已有可知字段，未知头盔不冒称没头盔。
- 风险/阶段：8分钟复现设计、25分钟实现/接线、10分钟相关构建；重点!undefined隐式false、undefined数值比较、empty对象误认为SUPPORTED、rich回退、已知false/0与缺失区别。纯fixture/真实Host-Graph-API入口，无Demo/模型/浏览器/服务/用户DB；必要5分钟只读终审。执行者负责所有测试/build退出，不改旧A5或发布安装main。

- 结果：整体可信门通过后独立保留字段，snapshot明确unknown/primitive冲突只否决该字段；Host仅compact，本地与remote同源，legacy rich不补显式compact缺项。H/A/helmet optional，原阈值下明确低→受限、核心三项齐全且不低→未受限、其余unknown；FULL-only不能证成充足，Verdict仍INCONCLUSIVE。原2红转绿，known false/0与missing区分。
- 验收：7文件177测试、TypeScript/Web build通过；Host→strict event/envelope→内存Graph/确定性POST、旧utility/roster、partial和legacy保存测量恢复零fetch、SSR已验证。partial_resources_review默认5分钟只读终审＋1分钟闭合确认，发现raw已知0被snapshot冲突省略后绕过死亡门，1红→绿修复；既有时效/回合/死亡门保留。
- 清理/限制：主任务独占写入，全部测试/build退出，无Demo/模型/UI浏览器/服务/用户DB/Memory/密钥/Parser/Viewer/全域类型改动或安装部署main合并，旧A5不动。snapshot库存仅数组可用性而非内容对照，旧已保存测量不追溯修正。忽略目录仅日志，文档实现同次commit/push后释放；见[验证记录](validation/PARTIAL_DIAGNOSTIC_RESOURCES.md)。

## 本轮任务卡：诊断资源时效与回合绑定（2026-09-25）

- 基线91a6c02（67b7497＋交接）已push且干净，上一任务明确release；本轮01a0d850-9c52-7803-85ca-03c7c8f5576e独占Host诊断资源选择、必要窄领域共享函数/契约及tests/docs，主控只读协调。默认模型/推理，小串行工作复用现有树，无Demo/依赖复制。
- 已见源码证据：teaching-diagnosis-host.ts的stateAtOrBefore仅判断player_id和tick<=decision_tick，未检查tick有限性、年龄、当前回合；buildTeachingDiagnosisInput直接把该state当决策资源且本地rich优先。Trusted DecisionSnapshot已有半秒新鲜规则，诊断独立从timeline读取可绕开。缺口需用生产调用的过期/上一回合夹具验证，不声称真实样本已错。
- 目标/验收：A1复现过期和跨回合资源实际进入测量/风险背景；A2以同回合、非未来、明确tickRate/年龄及当前身份为依据筛选，优先复用已有可信快照/领域规则而不发明无限期fallback；无可信资源时不出假血量/库存，不用后果补数；A3Host→remote紧凑与本地rich一致，乱序/未来/无tickRate/轮次不明/边界及合法新鲜数据回归；已有道具unknown/zero、TRADE公共人数及旧保存结果恢复行为不被无关改写；A4相关tests/TS/Web build；A5架构/学习日志/证据/任务板，commit/push后释放。
- 范围：时效与回合绑定、必要未知降级，不扩展Parser/Viewer/所有资源或风险阈值，不重写历史/自动重诊断。若字段缺失或状态死亡是否可用涉及现有语义，先明确规则并测试，不把所有缺信息当0或硬说决策有错。
- 风险/阶段：8分钟复现与契约、20分钟实现、10分钟相关验证/构建；重点跨回合freeze边界、采样age、rich路径绕过、历史兼容。小fixture与实际Host/Graph/API接线，不做新Demo解析、模型/浏览器/服务/用户DB，不碰旧A5。必要只读5分钟独立复查；执行者负责所有测试/build退出和临时清理，不安装/部署/main合并。

- 实际结果：Host stale33tick/跨round近邻2tick两例先红后绿。新selector绑定cue segment/round/player/decision与合法tickRate、半秒ceil年龄、freeze及死亡/missing边界，已有snapshot失效不能靠raw绕过；资源refs仅样本自身。独立decisionRoster从可信当前snapshot提供0..4人数，不要求伪补本人健康字段，新优先旧兼容，result/verdict/transfer统一，专业门保持。
- 验收与分工：7文件147测试、TS与Web production build通过；Host→strict event/envelope→内存Graph与实际确定性POST同local rich结果一致，旧恢复零fetch原样、SSR有未知与继续。resource_freshness_review默认配置5分钟只读终审＋2分钟闭合复核，发现legacy人数残留导致的Verdict/Transfer不一致，2红→绿修复；同时补side known门。收尾发现未知说明超过12条限制预算，2红→绿修复文本容量。
- 清理/限制：主任务独占生产写入，全部测试/build退出，无服务、Demo、模型、浏览器、用户DB/Memory/密钥、安装部署或main合并，原UI A5不动。时间门在Host，低层rich仍要求可信输入；旧错误记录不追溯改写。忽略目录仅保留小日志，代码与文档同次commit/push后释放，见[验证记录](validation/DIAGNOSTIC_RESOURCE_FRESHNESS.md)。

## 本轮任务卡：诊断道具数量与未知库存（2026-09-25）

- 基线8290f72（e90493b＋交接）干净且已push，射击任务结束并释放写入/进程；01a0d837-aff5-7560-a4b1-ba553cd77ba6独占本轮诊断contracts/module/Host投影、相关tests/docs，主控只读。使用默认模型/推理；小串行修复复用当前树，无需额外代理或Demo复制。
- 证据：teaching-diagnosis-host.ts约117行和coach-agent/teaching-diagnosis.ts约522行对state.inventory所有item.count求和；后者约538行一律标为“决策时道具数量/颗”。契约InventoryItem允许WEAPON，已有fixture仅一把AK；Adapter在grenades缺失时产inventory:[]并标missing_fields.inventory，当前投影却给0。
- 目标/验收：A1用生产Host→诊断及rich DecisionState入口先红复现枪械计入道具、未知当0；A2明确只统计有依据的道具，缺失/部分/不合法数量不伪造0，已知空库存仍能0，远端不泄漏完整inventory/身份；A3两路径一致，旧inventoryCount-only投影不得不经说明当作已校验道具数，新恢复/Graph/API兼容；A4相关tests/TS/production build；A5架构/学习日志/紧凑验证与任务板、commit/push及释放所有权。
- 范围：准确资源measurement与窄投影，不改风险阈值/专业判断/选点/Parser/Viewer，不重写历史，不新增模型或真实Demo解析。先核实inventory分类/缺字段语义；不靠道具名字模糊匹配猜分类。必要新增可选utility字段需区分legacy总物品数和真实道具数，不能悄悄重解释旧值。
- 风险/阶段：5分钟复现、20分钟实现兼容、10分钟局部验证/构建。风险是缺失与真0混淆、Host/rich路径口径不一致、旧checkpoint/schema误拒或重解释；用小fixture/Graph/API测，不启动浏览器/服务/真实DB/模型，不碰旧UI A5。若修改前端呈现按AGENTS读两UI技能；不改布局交互。执行者负责进程退出/临时清理，无安装/发布/main合并/完整性审计。

- 实际结果：Host→diagnose和直接rich两条路径先4红，修复后全部通过。新增utilityCount只计明确道具，完整已知空为0，缺失/部分/未知类别/不支持数量未知；legacy inventoryCount schema兼容但不转道具数，旧测量原样恢复。风险门和Verdict除新limitations外未变。
- 验收：6文件79测试/TypeScript/Web production build通过；Host strict事件→remote envelope→实际内存Graph及同包确定性POST保持一致，重复事件无新attempt/trace，实际恢复新0/2与旧1.5零fetch，SSR验证数值/未知及继续按钮。无UI布局/键盘样式修改；已读emil-design-eng/apple-design与本地Next指引。
- 所有权/清理：默认配置主任务独占并自行集中复查，无子代理。无Parser/Viewer改动、Demo解析、外部模型、浏览器、用户DB/Memory/密钥、安装发布部署或main合并；原工具A5仍未验。上游未标记的部分库存无法由诊断恢复，留作精确限制；测试/build全退出，仅忽略目录日志。代码与文档commit/push后释放写入，详见[验证记录](validation/DIAGNOSTIC_UTILITY_COUNT.md)。

## 本轮任务卡：射击事件即时身份归属（2026-09-25）

- 基线7bcf32f（618c33b＋交接）干净且已push；前负责人明确完成并释放写入/进程。本轮01a0d81c-bee6-7161-9cae-58ff2eea392b独占相关parser patch/helper/tests与必要provenance/docs，继续串行使用现有已构建工具链，不复制大Demo，不触及其他工作树。
- 新证据：hurt任务已核实native事件handle与network packed编码不同，只有当前pawn可见serial和controller绑定共同校验才提供归属。现有weapon_fire仍调用get_by_handle(index-only)和steam_from_pawn_handle→tick_start建立的pawn_to_steam[index]，未验证serial/class/当前绑定。此为可复现风险，不声称真实样本已发生错归属。
- 目标/验收：A1小fixture复现旧缓存对同index不同serial、当tick controller换绑/解绑/冲突的错误或陈旧归属；A2只修weapon_fire，复用正确native→packed与当前实体/唯一controller校验，未知null，不按位置猜人；A3已验证pawn的几何与actor使用一致身份，不能因actor改好却保留错误实体坐标；现有合法shot、缺actor兼容、RETURN_AND_FIRE与未知contact门保持；A4相关Rust/patch/Adapter/回归、Host与Viewer TS/Web/WASM+Viewer build，一次最终120秒内真实WASM汇总shot/归属/未归属及hurt/clock回归，不再native probe或模型调用；A5架构/学习日志/验证/任务板、commit/push和释放资源。
- 边界：不要改共享steam_from_pawn_handle的所有调用方；grenade使用network字段、其他事件的生命周期不在本轮，不能未经证明套用native转换。也不变更kill/ADR/bomb/道具归属、教学阈值、旧保存数据或UI。先明确不合法native handle/pawn无几何与actor未知的不同降级，保留事件引用稳定或说明不可避免的正确变化。
- 风险/阶段：10分钟复现、20分钟实现局部检查、10分钟构建，最终只一次WASM且raw留单进程摘要；编译成功门后才执行，禁止重现旧probe误跑。当前默认模型/推理，若独立终审仅5分钟只读；执行者负责全部临时资源退出。不访问用户DB/密钥/浏览器/锁屏A5，不安装/发布。不证实问题就交证据停止，不制造重构或新增多轮实测。

- 实际结果：旧weapon_fire/source2 lookup/helper生产代码注入小fixture，原7项6红；修复后7绿，加连续同tick绑定变化/signed serial位后9通过。仅weapon_fire与hurt共用窄helper；几何和actor同源，invalid pawn不emit、owner未知保持null。生成版本shot-identity.v2保留hurt provenance；删除旧无效shot允许新版索引变化，旧历史不改。
- 验收：186相关测试通过/1既有WebGPU缺产物跳过，parser Rust3、Host/Viewer TS、Web生产与WASM/Viewer build通过。最终唯一WASM解析6141ms、消费6311ms，1242shot/1242actor、本人152全部入时间线、2 RETURN_AND_FIRE、44候选4cue；hurt264/本人27/23snapshot/2包和clock38snapshot/3包保持，历史往返通过。计数不是绝对准确率或教学质量证据。
- 所有权/清理：根任务独占生产与测试写入；shot_identity_review默认配置仅5分钟只读终审，无blocker，提醒索引变化已记录。无额外native probe、模型、浏览器、DB、安装/部署，原锁屏A5不动；全部测试/build/WASM退出，测试临时目录自动删除，忽略目录留摘要日志，不留临时Rust源码在上游。文档和代码同次commit/push后释放所有权。详见[验证记录](validation/CURRENT_SHOT_IDENTITY.md)。

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
