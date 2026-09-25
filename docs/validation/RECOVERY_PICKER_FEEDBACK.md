# 恢复入口等待选 Demo 的反馈

2026-09-26，基线 `ca36bb2`（产品 `64f9fb5`）。范围为导航入口与状态呈现；没有修改 Runtime、Viewer、Parser 或教学判断。

## 问题与落地

原Host chooseRecoveryDemo只滚动/聚焦iframe，却发REPLAY_LOADING，Runtime返回REBUILDING。REQUEST_REPLAY效果没有生产消费者来打开picker或导入；实际文件只能由Viewer内可信用户动作选择。按原行为抽出Host实际使用入口，以生产Runtime/fakeIDB/面板SSR复现：未选文件就显示「正在验证并重新解析」，并隐藏选择按钮，基线1红。

| Before | After | Why |
|---|---|---|
| 点击导航就显示解析中 | 同步导航，保持原等待/错误状态 | 尚无选定文件或导入事件 |
| 未选文件无法再次使用选择入口 | 明示选择文件后才开始，按钮保持可用 | 等待用户不是后台忙碌 |
| 恢复面板没有真实导入反馈 | 当前请求实际导入时显示导入中 | 复用已有Viewer进度 |
| A导入进度可能残留到B | requestId匹配，打开历史清旧进度 | 防止新面板被旧进度锁成忙碌 |

移除Host REPLAY_LOADING派发，不增加新请求或复杂回调守卫。Runtime事件契约继续保留兼容；真实REPLAY_READY可以直接触发原身份、玩家、版本检查和恢复握手。

面板新增可操作等待说明与aria-busy；现有historyImportProgress只在当前managed request匹配时驱动importing。DEMO_IMPORT_REQUESTED来自Viewer确有File后，PROGRESS仅代表传输进度，字节100%不冒称解析/恢复完成；SUCCEEDED/FAILED继续使用原Host清理与反馈。打开另一历史review清旧进度。独立复核新增导入显示的残留问题，单独1红→绿，复审闭合。

## 验证

- 生产focus入口＋真实Runtime＋SSR：初始DORMANT未选择仍保留记录和选择按钮，0 runtime调用，正常scroll/focus；REJECTED/DEGRADED重复导航也不声称已修复。没有事件代表未选择，未假造picker取消事件。
- 生产bridge validator接受实际IMPORT_REQUESTED/PROGRESS/SUCCEEDED/FAILED形状，匹配request后给面板既有导入props；SSR检查等待、导入、失败和恢复显示。此处没有挂载完整React Host或真实Parser，不能把适配器/面板组合称为浏览器端到端通过。
- 新提示的生产请求匹配函数拒绝旧A进度＋已清空或替换为B的expected request；旧完成事件仍由已有managedRequestMatchesExpected拒绝。
- 真实BrowserSessionRecoveryRuntime无需前置REPLAY_LOADING，BOOT→REPLAY_READY选择原玩家→ANALYSIS_READY生成rehydrate/seek/reconnect效果→HANDSHAKE_COMPLETED为RECOVERED，record不改写。
- 7文件138tests通过：recovery-demo-picker、session-recovery-runtime、cs2d-session-recovery、cs2d-playback-host、history-restore-controller、playback-bridge、apply-cs2d-host-patch；`pnpm typecheck`、`pnpm build`、`git diff --check`通过。patch测试只读契约，未修改或构建Viewer/Parser。

## 局限与交付

使用emil-design-eng/apple-design技能，沿用原class、布局和reduced-motion/transparency样式；导航behavior=auto，无新增动画。没有真实浏览器取消、文件导入或渲染验证，也未解析Demo/调用模型/启动服务或访问用户DB/Memory/密钥。原UI暂停A5仍未验；fakeIDB清理、所有test/build退出。

非managed Viewer的解析进度仍由其自身界面呈现，本轮没有为它虚构managed进度。未测真实等待时间或教学质量改善。下一步应回到已有自然动作回放案例的完整带看体验：主控明确桌面可用后优先检查旧专属窗口Replay缓存，再按原A5预算接续，不继续扫描Host回调或无依据重构。
