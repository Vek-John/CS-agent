# 等待胜率时主动使用基础路线

日期：2026-09-27。基线009ce8a，功能分支codex/jev-decision-assessment；任务win-rate-user-fallback。

## 验收范围与结果

| 验收 | 证据 |
| --- | --- |
| 当前请求主动跳过 | 实际Viewer selectHostPlayer/inferWinRate源码+FakeWorker：原来跳过后builder零次的红例，现匹配player/request命令立即终止Worker，清timer，一次unavailable、无胜率bundle、ANALYSIS_READY |
| 旧请求及重复行为 | 错player/错request、ready之后、同玩家后继、重复点击、迟到ready/error、换Demo/unmount均不产生额外bundle或误终止后继；RESTORE不运行模型 |
| 命令边界 | 两端严格schema只接受正安全整数请求ID与玩家身份，拒绝额外字段；Viewer实际listener继续校验parent source/origin，Stage可选handler不重复消费 |
| Host控制 | 真实请求控制helper按对象身份claim一次，旧回调不能claim重载后数字ID相同的新token；progress继续到达不恢复已点击按钮，分析结束失效；旧无ID进度正常显示但不提供按钮 |
| 下游带看 | 既有真实Adapter→Planner→Session无胜率用例通过，UNAVAILABLE且无概率/胜率下降信号，START可进入PLAYING |
| UI | 实际CoachSetupFlow+helper+CSS通过独立localhost IAB控件验收，键盘Return发一次命令，立即disabled并更新status；再次Return计数仍1，340px宽未见溢出 |

## UI集中复查

| Before | After | Why |
| --- | --- | --- |
| 胜率持续推进时只能等待 | 当前推理期间可选择“先用基础路线”，说明本次不包含胜率 | 用户可以减少可选推理等待，收益边界明确 |
| 操作提交后缺乏确认 | 原生按钮立即禁用，role=status提示正在切换 | 支持键盘、读屏反馈并避免重复发送 |

沿用现有卡片、按钮、reduced-motion/transparency样式；新增区域没有动画和透明层。没有更改OS辅助功能偏好，不能把源码兼容声明为真实偏好模式视觉实测。

## 测试与构建

新增14项，相关7文件66项通过。pnpm typecheck、pnpm cs2d:typecheck、pnpm build、pnpm cs2d:build最终均退出0。首次Web TS报helper当前对象可能undefined，主控将可选链相等改成显式current存在检查；受影响3项测试及Web TS/build复验通过，未改变请求行为。

## 可重放性与资源

0030只包含Viewer与hostBridge变化；registry只在0030完整reverse成立时承认被覆盖的0028/29上下文。当前checkout reuse、隔离0029→0030升级及再次reuse通过。临时checkout已删除，执行者RELEASE；root临时IAB页已关闭，127.0.0.1:4319服务器已退出。未安装依赖、未运行用户Demo/真实模型/SQLite。

日志保留于.local-data/win-rate-user-fallback：red.txt、tests.txt、host-recheck.txt、reuse.txt、upgrade.txt、ui-check.txt、typecheck-web.txt、typecheck-viewer.txt、build-web.txt、build-viewer.txt。

## 限制

控件预览使用真实组件和helper，但发送命令的接收端是计数harness；Viewer消费和下游路线分别由source/真实领域模块测试验证。没有声称完整Host→真实模型→真实Demo桌面端到端通过，也未完成既有A5。跳过不会后台补回胜率到已冻结路线；已有120秒空闲回退仍保留，不代表真实模型SLA或专业判断能力改善。
