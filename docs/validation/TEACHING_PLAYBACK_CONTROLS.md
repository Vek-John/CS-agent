# 教学演示暂停/继续：阶段验证（2026-09-25）

基线bb0bc11，分支codex/jev-decision-assessment。代码和自动检查通过；实际活动教学工具的暂停/继续验收尚未完成，原目标不标完成。本轮没有新Jev/DeepSeek质量实验，不能据此声称模型判断质量提升。

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
