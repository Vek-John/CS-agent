# 结束页回看已完成片段（2026-09-26）

真实Demo全跳过路径生成NO_REPEATED_THEME，已有结束页只说明不归纳习惯。时间轴可以自由seek，但从结束页回到已讲解处理需要自己定位；终结Session也明确禁止新的ManualCueVisit。

按emil-design-eng/apple-design的既有样式、反馈与导航规则做小入口，不新增动画/透明层或判断。

| Before | After | Why |
|---|---|---|
| 空主题总结仅“不归纳为习惯” | 保留原提示，列出已看完的回合/片段入口 | 有下一步可做，不伪造习惯 |
| 必须自己在时间轴找位置 | 原生按钮定位到冻结segment开头并暂停，提示按播放继续 | 复用已有控制，让用户决定播放 |
| 接管后隐藏总结 | 终结期间继续显示总结和片段列表 | 可继续选另一段，保留结束上下文 |
| 完成后“讲解最近点”仍可能点了无效 | 终结时禁用；返回按钮标为“结束自由回看” | 与Session既有能力一致 |

## 验收

- A1：仅同一COMPLETE plan的WRAP_UP/COMPLETED Session、同时presented和consumed的cue进入列表。非法/缺失segment、不同plan、未呈现/未消费均不开放。标签只给回合和片段序号，避免旧cue标题被当作新判断。
- A2：实际Session reducer走完整合成路线，触发真实Panel按钮回调，经现有HostPlaybackControl发送pause→seek到冻结segment起点，完成状态/进度字节表示保持；JSON重载后入口保持。没有新增Session事件、主题、Narrator或诊断调用路径。
- A3：summary IDLE/LOADING和播放器未就绪时原生按钮disabled；Host同样检查，避免新入口的takeover丢弃在途总结。按钮回调捕获session/generation/history epoch并复核当前owner。终结自由seek不再执行旧Stage3 Graph takeover/resume；总结继续显示。
- A4：5项新行为回归与67项相关测试，共72通过；TypeScript及production Web build通过。独立代理partial_revision_restore默认配置只读指出LOADING与旧回调绑定风险，主控落实禁用与owner检查；无文件竞争。

样式复用现有按钮焦点、44px最小高度和reduced-motion规则，单列自适应且文字可换行；reduced-transparency继承结束卡已有实色背景。没有新服务/安装/数据库或Demo读取，测试进程退出。

## 精确限制与后继

这是实际Panel SSR/事件回调与Session/播放控制模块验证，不是完整React Host挂载、Viewer真实播放或浏览器视觉验收；原A5仍等待独立桌面条件。不会自动重讲已结束的cue，也不把导航点击算再次学习机会。旧历史若缺presented证据，不凭结束状态造回看列表，仍可用原时间轴。

审查同时揭示另一个现存路径：普通时间轴仍可能在总结LOADING期间接管，旧总结接收条件依赖非takeover。下一有限任务用deferred真实结束流程验证这个路径，若证实则允许同owner终结总结安全收敛；不把当前新按钮禁用当作全局问题已修复。
