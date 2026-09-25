# 默认诊断结果回看当前处理

2026-09-26；基线 db9fbc8（前产品 6a33ca6）。只新增默认完成诊断结果的显式回看入口，复用原 Session/Host 播放，不改 Parser、判断、Memory 或手动回访。

## 可见变化

| Before | After |
| --- | --- |
| 默认诊断结果只有确认/异议，无回看按钮 | 完整、无编辑草稿的结果态显示“再看一遍” |
| 要重看支撑诊断的处理需离开默认诊断流程 | 播完当前处理后停回同一决策点，保留原反思、判断、建议和学习线程 |
| 结果与反思/异议编辑同属会卸载的面板 | 反思未提交、异议编辑展开或收起仍有草稿时隐藏新入口；已提交草稿不阻止回看 |

复用原生 button、secondary 样式和 aria-live 区域；busy 时语义 disabled。没有新增动画、材质或CSS，现有 reduced motion/transparency 路径保持。没有真实视觉/键盘/屏幕阅读器验收。

## 生产链与保存边界

实际 TeachingDiagnosisPanel.onReplay → Host requestTeachingDiagnosisReplay → 原 transition(REPLAY_OUTCOME) → Session.REPLAYING → 原 guidedPlaybackDirective。原 transition 负责 clearUserTakeover/transport reset、reducer 及幂等 USER_INTERACTION；没有私人状态通道，也不抑制真实用户重播操作记录。

Host 读取当前 Session/case，拒绝旧会话、旧 cue/case、接管、诊断/工具 busy、非停靠阶段、未揭示或结果门不匹配/未完成、缺反思或诊断产物。ManualCueVisit 不传 callback，guard 同时拒绝 manual；不改变其专有完成门或保存的默认路线游标。

播放保留现有决策前置上下文、目标镜头、速度和 outcome end 边界；结束由 Session 返回相同 cue/decision point。完整结果门单向保持；不会在重播时确认/消费/呈现 cue。Host 保存的 case/thread 不随 Panel 卸载而清除；默认 diagnostics 的自动 Stage3 入口仍禁用，回看不调用反思提交、诊断同步或 Provider。确认继续仍执行原确认流程及自动冻结时间跳过规则。

## 验证层次

1. 原面板实际 SSR 元素没有“再看一遍”，基线 1 红；接线后实际按钮 callback 可调用。使用 React 服务端真实 hook dispatcher 捕获元素及事件，不 mock useState；render-phase 状态更新覆盖反思草稿、展开异议、输入后关闭/重新打开及关闭空编辑器。
2. 实际按钮 callback 经生产 guard、生产 Session reducer、guidedPlaybackDirective、HostPlaybackControl：重播进入/结束同 cue、完整结果门不回退、诊断/反思/线程/消费/呈现不变；暂停/继续门与原暂停意图重置、重复 transition claim、重播中重复请求拒绝；原确认后路线与未重播的正常继续一致。冻结段自动消费意味着段索引可能大于原索引加一，测试按原路线语义校验。
3. guard 16 种拒绝边界及真实 Session 手动回访，全部零 transition、无 case/cursor 变更。
4. 只读审查实际 Host 接线、原 clearUserTakeover/transition、Session finishOutcome 及 diagnostics 自动入口，无 must-fix。

第 2 层的 transition wrapper 使用原 transport reset、生产 reducer 与本地幂等 Map 观察操作记录；**没有挂载完整 Host React 组件，没有真实 history 存储或 iframe 播放**。诊断函数调用计数和 callback 零重复只证明 fixture 所覆盖链；不声称真实 Provider/Memory 服务已受浏览器验证。所有测试使用 synthetic fixture，其时间不是 Demo canonical tick 证据。

## 命令与结果

```sh
pnpm exec vitest run \
  apps/web/components/playback/teaching-diagnosis-panel.test.ts \
  apps/web/components/playback/teaching-diagnosis-replay.test.ts \
  apps/web/lib/coaching/diagnosis-replay.test.ts \
  apps/web/lib/coaching/cs2d-guided-session.test.ts \
  apps/web/lib/playback/cs2d-playback-host.test.ts \
  apps/web/lib/coaching/teaching-diagnosis-host.test.ts \
  apps/web/lib/coaching/teaching-diagnosis-freshness.test.ts \
  libs/session/src/index.test.ts \
  libs/session/src/manual-cue-visit.test.ts \
  libs/coach-agent/src/teaching-diagnosis.test.ts \
  libs/coach-agent/src/teaching-diagnosis-graph.test.ts
pnpm typecheck
pnpm build
```

11 文件 239 项相关测试全部通过（新增 27 项）；TypeScript 与 Next production build 通过。基线红例、局部回归和最终运行日志位于本地 `.local-data/diagnosis-replay-evidence/`。

## 剩余限制

本轮证明已有产品链新增显式回看能力，不能证明教学判断质量、用户理解或播放性能提升。未读/解析 Demo、调用真实模型、启动浏览器/服务、读用户DB/密钥、安装或部署。默认完整结果态以外（手动回访、降级、未提交反思/异议）不新增回看。原真实浏览器暂停 A5 仍未完成，本轮不替代它。
