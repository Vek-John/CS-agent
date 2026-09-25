# 教学演示暂停/继续：阶段验证（2026-09-25）

最新状态（21:48续跑）：新接线b5da690后，以6cb402d基线再次进入真实页面；文件解析完成后选择玩家时Mac重新锁屏，未进入教学工具验收。原A5仍未完成，不能用此前4fffe02的空工具记录判断新接线是否生效。见文末两次续跑证据。

原实现基线bb0bc11，分支codex/jev-decision-assessment。代码和自动检查通过；实际活动教学工具的暂停/继续验收尚未完成，原目标不标完成。本轮没有新Jev/DeepSeek质量实验，不能据此声称模型判断质量提升。

## 实现与使用

在既有`?teachingDiagnostics=off`入口进入Stage3；当真实教学资格与证据允许、实际发出REPLAY_CUE_SLOW或SHOW_GRENADE_TRACE后，底部按钮显示“暂停演示”。点击后显示“演示已暂停/继续演示”，继续同一次调用及位置。静态讲解仍使用卡片“再看一遍/继续下一段”。默认诊断入口没有因此启动视觉工具。

| Before | After | 依据 |
|---|---|---|
| Session停靠阶段一律禁用通用播放 | 只有已经POSTED的活动播放工具可暂停/继续 | 真实Host入口回归先红后绿 |
| 工具ACK按10秒墙钟计时 | 暂停时间不扣预算；恢复只使用剩余活动时间，慢放预算覆盖真实窗口 | 假时钟超时、连续暂停与超时回归 |
| 原始play或晚到nextTick可能绕过活动工具 | 身份限定命令；Viewer保持对象、屏蔽迟到启动和完成推进 | 执行补丁内真实helper的行为测试 |
| iframe重载后contentWindow仍存在 | load/error明确使旧调用进入RECOVERY_REQUIRED | 新生命周期回归 |
| RESULTED写入期间取消后仍可能RESUME | await后重新校验token、live与pending对象 | 取消/重连/断连3条红→绿 |

没有新增动效/透明度样式，沿用既有键盘button与辅助显示规则；未更改系统辅助设置。工具暂停不向Graph发USER_TAKEOVER、不重新START_CUE、不重计呈现或Memory。自由seek、失败/超时、取消和连接变更继续终止旧实例。新Viewer协议位于补丁0008，需与Host配套构建。

## 自动检查结果

- 初始Host回归：31通过、1失败，活动播放工具被错误禁用；修复后通过。
- 独立审查补充生命周期回归：26通过、4失败；修复后30通过。失败分别覆盖取消/重连后晚RESULTED、iframe生命周期失效。
- 最终相关套件：13文件、156测试通过。范围为Host控制、Stage3 Controller/adapter/真实Agent runtime集成、Session结果门与manual回访、恢复、协议、Viewer补丁helper及补丁应用。
- 真实Agent runtime集成使用内存状态及确定性Policy：单个工具post、单次RESUME_TOOL、单次tool history/完成cue；这属于集成测试，不是浏览器实测，也不等同于生产Memory持久化验证。
- `pnpm typecheck`、`pnpm build`通过；`pnpm cs2d:typecheck`、`pnpm cs2d:build`通过。
- 最终测试命令：

```sh
pnpm exec vitest run apps/web/lib/playback apps/web/lib/coaching/coach-agent-stage3-controller.test.ts apps/web/lib/coaching/coach-agent-stage3-integration.test.ts apps/web/lib/coaching/coach-agent-stage3-host-adapter.test.ts apps/web/lib/coaching/cs2d-guided-session.test.ts libs/session/src apps/web/lib/recovery libs/coach-agent/src/manual-cue-visit.test.ts libs/contracts/src/playback-bridge.test.ts tools/cs2d-host/teaching-playback.test.mjs tools/apply-cs2d-host-patch.test.mjs
```

合成测试中的时间/位置仅用于回归，不称为真实Demo canonical tick。两种工具的暂停行为都通过模拟及Viewer helper验证；目前没有一种完成此次真实浏览器全链路验收。

## 实际页面证据与缺口

主控单独拥有一个Edge InPrivate窗口和一个40分钟服务控制器。开发Host localhost:3000与构建后的静态Viewer localhost:5174；空provider、RULE_BASELINE、Memory关闭。只读导入已有test_demo.dem一次（约60.6MB），选Dog，9回合，本地解析和CS-Net完成；Replay与帧留在原Viewer/Worker，未导出bulk。

实际进入`?teachingDiagnostics=off`，当前路线为4 cues。首cue在R1 0:47停靠，进度控件读到真实解析canonical tick 3081，标题“回看当时的选择，暂不判错”。此时底部为禁用“播放不可用，请使用讲解卡操作”，页面出现“教学工具已完成”。**该文案不能证明实际执行过工具**：零capability的FINISH也能到相同完成态。本轮没有取得该cue实际播放工具的callId/开始/结束证据；另外3 cues尚未逐个核实，不能断言整个样本没有工具，也不能用旧14-cue历史结果替代当前4-cue路线。

继续操作时，CUA明确返回Mac锁屏且自动解锁失败。已请求用户手动解锁；没有改用其他驱动绕过限制，没有反复解析Demo、强制插入工具或降低教学资格。两个生命周期修复在锁屏后完成，所以此真实页面也不是最终代码的UI回归证据。

## 最小接续与交付边界

1. 用户确认解锁后，先核实最新工作树所有权、可用页面及配套Viewer版本；只恢复一个控制器，先轻量点击smoke，不重复已通过自动检查。
2. 先从合法当前cue的轻量capability/工具摘要确认是否确有慢放或道具工具。若没有可执行工具，记录当前样本限制，不制造通过案例。不要将“再看一遍”的Session重播冒充Stage3新工具。
3. 对一个实际工具记录run/cue/callId/generation及起止事件摘要，暂停至少12秒，确认位置不变、没有超时/完成/新调用；继续同一实例，从原位置推进并只完成一次。显式seek与重连失效仍需实际UI覆盖，模拟覆盖不能冒称实测。
4. 补齐上述证据后才关闭原A5和goal；桌面App、打包安装、生产server、真实SQLite/Memory以及模型质量比较仍不在此次验证范围。

一个后继建议：为零capability的正常FINISH与实际工具完成区分简短状态文案，避免“教学工具已完成”误导验收与用户；本轮没有扩大范围修改该文案。


清理：唯一服务controller已停止，3000/5174无监听；所有测试和构建已退出，next-env没有生成差异。因Mac锁屏，本轮InPrivate窗口未能关闭；未强杀用户Edge、未触碰用户原普通窗口。解锁后需关闭或接续该专属窗口。阶段push后释放代码写入，接续前重新核实所有权；不合并main、不部署、不安装应用。


## 21:17续跑：完整样本没有合法工具，A5仍未通过

用户明确要求继续后，在最新4fffe02（产品886e9ad）干净基线重新检查桌面，原生Edge已可操作。旧专用窗口不在窗口列表中；新建本轮InPrivate窗口，保留原普通窗口及其他用户窗口。原goal工具仍显示blocked且没有resume接口，未另建目标、未将原目标标完成。

复用原40分钟单控制器、最新Host和现有构建的静态Viewer；空Jev/DeepSeek provider、RULE_BASELINE、Memory关闭，入口`?teachingDiagnostics=off`。文件选择smoke成功后，只读导入原test_demo.dem并选Dog，**本轮仅一次解析**。本地CS-Net完成后自然进入4-cue路线，按“继续下一段”逐个播放完整结果并回到决策点，没有自由seek、强制Policy、注入工具或更改教学门。

为避免仅凭UI文案推断，临时在本地Agent HTTP返回处记录event/cue/status/capability工具名/effect身份及完成计数的小摘要；不记录原始Replay、帧、玩家身份或密钥。全部验证后移除该日志代码，生产源码没有差异。可审阅的紧凑结果为[TEACHING_PLAYBACK_SAMPLE.json](TEACHING_PLAYBACK_SAMPLE.json)。

| 实际cue | UI停靠位置（真实解析） | START_CUE能力/调用 | UI状态与累计完成 |
|---|---|---|---|
| c1 | R1 0:47，canonical tick 3081 | capabilities=[]，effects=[] | 无需额外演示；1 |
| c2 | R3 0:58，canonical tick 19426 | capabilities=[]，effects=[] | 无需额外演示；2 |
| c3 | R5 1:12，canonical tick 31179 | capabilities=[]，effects=[] | 无需额外演示；3 |
| c4 | R7 1:30，canonical tick 45091 | capabilities=[]，effects=[] | 无需额外演示；4 |

四次START_CUE均直接COMPLETED，全程工具effect为0、RESUME_TOOL为0，没有可供验证的真实播放tool/callId。每次静态停靠底部raw play均正确禁用，现有“无需额外演示”文案准确；此前建议的完成文案区分已由后续任务实现，不再列为待办。

**验收判定**：环境阻塞已解除、所有4个自然cue的资格检查已完成；“实际教学工具暂停≥12秒、同次resume恰好一次完成，以及工具中seek/重连”均未运行。普通Session结果播放不能替代这些工具验收，四次COMPLETED也不代表工具完成。当前记录仅证明这个玩家/样本/当前基线路线没有可执行工具，不外推其他玩家/Demo或所有产品路线，不声称模型质量提升。

本轮没有产品改动，未重复已通过的156/180测试或Host/Viewer构建，未重建Parser。无需继续在同一空capability集合上重试；下一步需要先核实资格来源，再在不降低教学门的前提下取得含合法自然工具的真实路线，补原A5，不以新的mock或Session“再看一遍”替代。主控只读发现teaching-gates的新focus集合与capability-builder/Host部分旧focus白名单可能未同步；这是待独立最小复现的接线线索，本轮不修改资格，也不直接认定样本事实不足。

清理已完成：本轮InPrivate窗口已关闭，AX回到用户原普通新标签页；唯一controller67027退出，3000/5174无监听。临时Agent日志代码和next-env生成差异已去除，没有遗留测试/构建/解析任务。原Demo、用户窗口/SQLite/Memory、其他工作树均未修改；只提交本轮文档/去身份小摘要，push后释放写入与资源。


## 21:48新接线后续跑：解析完成后重新锁屏

基线6cb402d（产品b5da690），工作树启动时干净，其他owner已release。此次条件已变化：现行focus通过ACTION_FACT_REPLAY与独立动作/冻结窗口/引用/完整结果门获得事实慢放资格；沿用[接线验证](CURRENT_FOCUS_ACTION_REPLAY.md)已通过的257个不同相关用例、TS和Web build，不能用上次空capability事实否定新代码，也不能用该集成测试替代真实A5。

- 21:48原生Edge成功返回可操作普通新标签页。新建本轮InPrivate窗口，最新Host+既有静态Viewer启动成功；入口teachingDiagnostics=off，空provider、RULE_BASELINE、Memory关闭。单controller13398保留40分钟期限。
- Demo文件选择smoke成功；原test_demo.dem本轮只读解析一次，页面明确显示“解析完成”、10人选择页和Dog按钮。Bulk始终留Viewer/Worker。
- 点击Dog时CUA等待约13.7秒，返回“The Mac is locked and automatic unlock could not unlock it.”。无法确认该点击完成，不能报告玩家已选定、CS-Net完成或任何cue/tool已开始。
- 唯一服务日志只有入口200和两次Controller IDLE小摘要，没有START_CUE、工具post或RESUME_TOOL；尚未获得真实慢放callId、暂停/续播、seek/重连证据。新接线在这个真实样本的效果仍未验证。
- 已停止UI路径，没有再次查询锁屏、换driver、绕路或第二次解析；没有改资格/输入/Policy、调用模型或修改产品代码。临时轻量遥测API及Host/Agent日志全部去除，next-env生成差异恢复，生产diff为零。

清理：controller13398已退出，3000/5174无监听，没有测试/构建进程；本轮InPrivate窗口在锁屏后无法关闭，未强杀用户Edge或触碰普通窗口。需解锁后只接续/关闭该专属窗口。临时日志仅保留忽略目录，无Replay/帧/身份/密钥导出。文档阶段commit/push后释放写入，原goal保持未完成，不另建替代目标。

最小接续：仅在明确桌面恢复后重新核实所有权，先检查该专属窗口仍有已解析Replay时能否直接选Dog继续，优先复用已有缓存而不是再导入；若页面/Worker已丢失，先报告实际状态并由主控安排解析预算。仍按原A5自然tool/callId、≥12秒pause、同次resume恰好一次完成和必要seek/重连验收，不补造完成。
