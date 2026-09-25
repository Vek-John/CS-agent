# 普通暂停/继续验证（2026-09-25）

基线2890ee6，分支codex/jev-decision-assessment。最终状态：产品修复bf42aef已push；2026-09-25 15:23电脑控制恢复后，原A5四条真实Demo交互已补验通过。此次接续未改产品代码，沿用该提交已通过的105相关测试、TS与production build；原目标验收完成。此前锁屏阻塞与阶段交付记录保留在下文。

## 语义和所有权

| Before | After | 原因 |
|---|---|---|
| 普通pause/play无差别触发USER_TAKEOVER | Host保存瞬时transport意图，Session及Agent默认意图保持 | 暂停不等于退出带看 |
| 单改按钮仍可能被effect重发seek/play | 暂停及ACK等待挡住TICK、移动命令和自动推进；同transition续播只play | 防止后台重启或倒回结果起点 |
| 已看manual cue可能随暂停被取消 | 暂停保留visit ID和本次独立结果门 | 不重复呈现/习惯，不改默认游标 |
| 教练停靠时通用raw play离开教学点 | 禁用底部播放，沿用卡片回看/继续及busy门 | 不绕过讲解门 |
| 无Session暂停后旧独立seek路径被新增latch阻挡 | 拖动/时间轴/±15秒统一入口先释放transport意图 | 独立审查发现并修复的本轮回归 |

HostPlaybackControl不拥有cue、tick、phase、Narration或Memory；不新增Session状态机。pause/continue不新增恢复边界，刷新仍按现有稳定教学边界恢复。普通seek和回合跳转仍明确接管。重连/更换Demo使旧控制epoch失效，回报只提供事实，不能恢复旧播放意图。

## 自动证据

- 原始入口提取后回归：`pnpm exec vitest run apps/web/lib/playback/cs2d-playback-host.test.ts`，24通过/1失败；freeViewing预期false、实际true，实际Host使用同一函数。
- 修复后相关命令：`pnpm exec vitest run apps/web/lib/playback apps/web/lib/coaching/cs2d-guided-session.test.ts libs/session/src apps/web/lib/recovery libs/coach-agent/src/manual-cue-visit.test.ts apps/web/lib/coaching/coach-agent-stage3-controller.test.ts`，8文件105测试通过。
- `pnpm typecheck`通过；空Jev/DeepSeek provider的`pnpm build`通过。
- 回归覆盖：普通pause/play零Agent takeover、Session进度不变；结果门前/末的迟到tick；已呈现cue manual回访独立门；快速pause/play等待ACK；旧epoch与默认恢复；自由seek接管；无Session pause→seek；自动skip暂停与重试。
- 合成测试数值仅用于状态机回归，不当作真实Demo canonical tick。

## A1–A6 状态

| 验收 | 状态 | 证据/限制 |
|---|---|---|
| A1实际控制入口红测试与owner定义 | 通过 | 原入口红→绿；修复前真实R2证据见FULL_REVIEW_RELIABILITY.md，当前修复后页面已补验；Host无第二个Session状态机 |
| A2普通暂停保持状态、防自动播放 | 通过 | 真实R1暂停6秒位置不变，空格续播仍默认带看；自动门回归通过 |
| A3结果/manual暂停续播 | 通过 | 真实结果重播和已看cue manual回访均暂停6秒，续播后正确停回同一决策点；独立门/去重由相关回归覆盖 |
| A4自由接管与停靠语义 | 通过 | 真实暂停后后退15秒进入自由查看并保持6秒；讲解停靠禁用raw play，卡片回看/继续正常；epoch由自动回归覆盖 |
| A5相关回归/TS/build与真实页面 | 通过 | bf42aef自动验证＋本轮原生Edge真实交互；无需重复同一套自动检查 |
| A6文档、提交push、清理 | 完成 | 实现与补验证据均提交当前分支；本轮窗口/服务清理如下 |

## 初次页面环境阻塞记录（历史）

主控复用开发Host localhost:3000＋预构建静态Viewer localhost:5174；唯一服务控制器40分钟期限，provider为空、Memory关闭，原Demo只读。Edge原生getApp持续timeout；Edge浏览器创建与库存查询timeout。内置浏览器能加载localhost并读DOM/截图，但iframe按钮和坐标点击均报Click target is no longer available，文件选择器未触发；切为可见窗口后仍相同。没有导入或导出raw Replay，没有重复大Demo解析。为了尝试当前基线页面复现，短暂保存本轮组件到忽略目录、载入HEAD组件，尝试失败后完整恢复本轮组件；没有覆盖用户改动。

当时已询问电脑是否锁屏/远程断开，随后CUA明确确认Mac锁屏且无法自动解锁；此前未把自动回归当作UI通过。不绕过电脑控制工具改用另一套浏览器驱动。桌面App、安装包、SQLite历史列表UI和付费模型实验未运行。

## 后续

本轮真实页面验收现已补齐。下一轮建议：教学工具播放时的暂停控制。独立审查指出Stage3 slow replay/grenade工具可在PAUSED_FOR_COACHING期间播放，当前底部按钮受教学门禁用；若要支持暂停需协调工具取消/完成，不可简单raw play。


## 原缺失步骤与最小接续路径（已完成，保留交接记录）

1. 先核实当前功能分支/工作树所有权和电脑控制可用；不再反复尝试已失败的同一边界。复用忽略目录`.local-data/guided-pause/serve.ts`的单控制器、静态Viewer和空provider配置；先轻量localhost点击smoke成功再导入原Demo。
2. 导入现有9回合Demo并选择玩家，默认普通片段点暂停，记录可见回合/播放位置；等待至少5秒应保持“已暂停带看”和同一位置，点继续后仍默认带看、从原位置推进。
3. 第一个cue可用既有“再看一遍”延长操作窗口，在结果结束前暂停；等待时讲解保持不可见，续播后恰好一次回decision并显示讲解。用Space/Enter激活同一button至少一次验证键盘入口。
4. 已看cue→后退15秒（自由查看）→讲解最近教练点，在本次结果窗口暂停/续播，保留manual visit并停回同一cue；显式回默认顺序可继续。单独确认暂停后自由seek进入自由查看且不会被自动拉回。
5. 控制恢复后只补这些缺失的实际UI步骤；除非改动或新失败，不重复105测试、build或整场Jev实验。若新修改涉及新风险再针对性复验；补证据、更新A5、提交push后才完成原goal。

清理：本轮服务控制器已退出，3000/5174无监听；IAB临时页已close并恢复隐藏，tab列表为空。Edge原生/浏览器创建尝试超时，没有返回可用句柄，无法确认其后台窗口状态；未强制结束用户Edge进程。所有测试/build已结束；冗余临时组件备份移除，忽略目录只保留控制器和日志以便接续。阶段push后释放写入，后续重新接管前需核实主控安排。


## 15:23恢复后的实际验收

环境：macOS原生Edge，新建独立InPrivate窗口；开发Host与既有静态Viewer由一个40分钟控制器持有。只解析同一test_demo.dem一次，9回合/10人，选择原验证玩家；本地CS-Net正常完成。模型provider仍为空，未调用远端Jev/DeepSeek。原始Demo只读，Replay/帧始终留在Viewer/Worker。

以下tick均为**此次真实Demo解析后**在播放器进度控件中读到的canonical tick，不是合成夹具值；用户控件同时显示回合时间。数值用于核对同一停点与连续性，不代表新增时间精度承诺。

| 实际操作 | 暂停/等待证据 | 继续/结束证据 |
|---|---|---|
| R1普通默认带看点暂停 | 显示“已暂停带看”；R1 1:02、4085；等待6秒AX状态完全不变，没有自由查看入口 | 焦点上的继续按钮按Space，回“带你看比赛”；4385/R1 1:07，仍原方向4倍速推进，没有重回起点 |
| 首cue“再看一遍”后在结果窗口暂停 | 起播8935后暂停8995（决策点8969之后），显示“已暂停带看”，完整讲解卡尚未显示；等待6秒不变 | 按Return续播至9058，没有退回8928前置点；结果完成回8969，显示教练暂停和讲解卡，底部raw play禁用 |
| 首cue继续后已推进至默认2/4，再自由跳回R1→讲解最近教练点 | manual从8928起播，暂停9004；等待6秒无推进、无讲解卡，“讲解最近教练点”保持禁用，证明本次visit未被取消 | 继续至9081后停回8969并显示原讲解；点“回到默认顺序”恢复R2 12833、2/4，原默认游标未被回访改写 |
| R2既有回看中暂停→后退15秒 | 暂停12853；显式后退落11893/R2 0:38，标题变“自由查看”，保留回默认/点播入口 | 等待6秒AX状态完全不变，未恢复旧播放意图；此前单独跳回R1后也保持自由查看6秒 |

基础播放准备阶段也观察到暂停与继续控件可用；该阶段一次后退时Session已完成准备，故不把这次观察宣称为无Session seek的独立UI验证。该边界由本轮针对性自动回归证明。

实际首cue第一次自然结果窗口的暂停操作晚于结果末，页面正确已停靠且按钮禁用；没有将这次未命中窗口视作通过。随后用既有“再看一遍”连续操作，在8995结果窗口内暂停并完成上述有效验收。反思问题均显式跳过，没有填造玩家意图。

观察到的暂停/返回/继续均符合预期，未发现需追加产品代码修复的问题。本次不重跑已通过的测试/build；只更新验收记录。开发日志中的本地API响应均为200，无新的unhandled错误；这不替代桌面运行或模型质量验证。

清理：已关闭此次新建InPrivate窗口，原生AX回到原有普通“新标签页”，未关闭用户窗口。唯一controller退出，3000/5174无监听。Next dev自动生成的next-env路径差异已恢复原production版本。没有遗留测试/构建任务，未安装应用、部署或合并main。最后释放写入与资源。

限制：实际交互运行在开发Host＋静态Viewer；生产构建此前已通过，但本轮未启动生产server或桌面App。未运行桌面历史列表UI、安装包、Stage3教学工具播放暂停或新增付费模型对照。没有新增动效/透明度样式，复用既有控件及其reduced-motion/transparency规则；本轮未切换用户系统辅助设置。
