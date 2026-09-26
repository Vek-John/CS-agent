# 可选胜率停滞回退验证

日期：2026-09-27；实现基线358329d，功能分支codex/jev-decision-assessment。0029仅修改Viewer推理生命周期，模型算法和Provider选择不变。

## 行为与证据

1. 实际inferWinRate与selectHostPlayer函数由source harness加载。无消息原先120秒后仍pending、builder零次；现在120秒空闲时一次terminate/清timer，一次unavailable，构建无winProbabilityTimeline的bundle并发出一次ANALYSIS_READY。
2. 分别跟踪下载字节、推理样本的最大值；有限正增长可让工作持续超过120秒，重复/倒退/零/NaN/Infinity/telemetry不续期。ready进度归推理计数域。
3. 现有一次GPU普通失败转WASM允许重置计数，使较小但递增的WASM进展可续期；失败telemetry本身不续期，重复失败及TIMEOUT/ABORTED不重置。
4. 新推理、换managed文件、unmount立即结算取消，旧message/error/timer不污染新任务或生成旧基础路线；当前error/postMessage同步失败/成功均清理。RESTORE不启动推理。
5. 真实Adapter消费合成死亡事件，在没有模型时间线时输出UNAVAILABLE、空rounds/swings且没有WIN_RATE_DROP候选；实际Planner、模板讲解与Session可START到PLAYING，不调用网络。合成事件不作为真实Demo精确tick或教学质量证据。

## 执行结果

- 新source文件20项；含旧Worker归属、Parser取消、温恢复与patch registry共5文件65项通过。真实Adapter/Session新增1项通过，总66项。
- pnpm typecheck、pnpm cs2d:typecheck、pnpm build、pnpm cs2d:build均退出0。
- 0028→0029隔离受控尾升级与重复reuse通过，重现当前Viewer文本；实际checkout重复reuse通过。空upstream的20项显式skip，未计入通过。
- 主控独立读取patch、registry、关键测试及运行时实际progress/Provider fallback实现；执行者已RELEASE，临时checkout与测试资源已清理，无后台构建遗留。
- 本地日志：.local-data/win-rate-idle-fallback/{red,smoke,tests,route,upgrade,reuse,no-upstream,typecheck-web,typecheck-viewer,build-web,build-viewer}.txt。

## 剩余限制

没有运行真实CS-Net下载/编译/推理、浏览器、用户Demo或SQLite。120秒是保守空闲策略而非性能SLA，正常无进度编译超过该窗口也会回退；浏览器节流或主线程阻塞可能推迟计时器。持续有进展的长任务不受总时长限制，主动选择基础路线列为下一项。仅基础带看可启动已验证，不声称专业判断改善或完成桌面A5。
