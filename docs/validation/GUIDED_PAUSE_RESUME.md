# 普通暂停/继续验证（2026-09-25）

基线2890ee6，分支codex/jev-decision-assessment。状态：阶段修复提交并push；实现与自动验证通过，真实页面交互验收受环境阻塞，A5和原goal尚未完成。经主控明确允许阶段push，不将阶段提交视为完整验收。

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
| A1实际控制入口红测试与owner定义 | 通过（代码）；页面复现未运行 | 原入口红→绿，Host无第二个Session状态机 |
| A2普通暂停保持状态、防自动播放 | 自动验证通过；页面待验证 | TICK、commands、automaticAction及epoch门 |
| A3结果/manual暂停续播 | 自动验证通过；页面待验证 | Session真实reducer＋Host入口，独立门和去重 |
| A4自由接管与停靠语义 | 自动验证通过；页面待验证 | seek统一入口、教学停靠禁用raw play、await epoch |
| A5相关回归/TS/build与真实页面 | 部分通过 | 自动检查通过；实际Demo交互受阻 |
| A6文档、阶段提交push、清理 | 阶段完成 | 原整体目标仍待A5；清理如下 |

## 页面环境记录

主控复用开发Host localhost:3000＋预构建静态Viewer localhost:5174；唯一服务控制器40分钟期限，provider为空、Memory关闭，原Demo只读。Edge原生getApp持续timeout；Edge浏览器创建与库存查询timeout。内置浏览器能加载localhost并读DOM/截图，但iframe按钮和坐标点击均报Click target is no longer available，文件选择器未触发；切为可见窗口后仍相同。没有导入或导出raw Replay，没有重复大Demo解析。为了尝试当前基线页面复现，短暂保存本轮组件到忽略目录、载入HEAD组件，尝试失败后完整恢复本轮组件；没有覆盖用户改动。

已向用户询问电脑是否锁屏/远程断开，等待可用交互环境。不绕过电脑控制工具改用另一套浏览器驱动。桌面App、安装包、SQLite历史列表UI和付费模型实验未运行。

## 后续

先补齐本轮真实页面验收，不把它转移成下一轮任务或宣称完成。下一轮候选（待本轮验收后选定）：教学工具播放时的暂停控制。独立审查指出Stage3 slow replay/grenade工具可在PAUSED_FOR_COACHING期间播放，当前底部按钮受教学门禁用；若要支持暂停需协调工具取消/完成，不可简单raw play。


## 精确缺失步骤与最小接续路径

1. 先核实当前功能分支/工作树所有权和电脑控制可用；不再反复尝试已失败的同一边界。复用忽略目录`.local-data/guided-pause/serve.ts`的单控制器、静态Viewer和空provider配置；先轻量localhost点击smoke成功再导入原Demo。
2. 导入现有9回合Demo并选择玩家，默认普通片段点暂停，记录可见回合/播放位置；等待至少5秒应保持“已暂停带看”和同一位置，点继续后仍默认带看、从原位置推进。
3. 第一个cue可用既有“再看一遍”延长操作窗口，在结果结束前暂停；等待时讲解保持不可见，续播后恰好一次回decision并显示讲解。用Space/Enter激活同一button至少一次验证键盘入口。
4. 已看cue→后退15秒（自由查看）→讲解最近教练点，在本次结果窗口暂停/续播，保留manual visit并停回同一cue；显式回默认顺序可继续。单独确认暂停后自由seek进入自由查看且不会被自动拉回。
5. 控制恢复后只补这些缺失的实际UI步骤；除非改动或新失败，不重复105测试、build或整场Jev实验。若新修改涉及新风险再针对性复验；补证据、更新A5、提交push后才完成原goal。

清理：本轮服务控制器已退出，3000/5174无监听；IAB临时页已close并恢复隐藏，tab列表为空。Edge原生/浏览器创建尝试超时，没有返回可用句柄，无法确认其后台窗口状态；未强制结束用户Edge进程。所有测试/build已结束；冗余临时组件备份移除，忽略目录只保留控制器和日志以便接续。阶段push后释放写入，后续重新接管前需核实主控安排。
