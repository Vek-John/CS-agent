# 真实Viewer动作回放小验收

2026-09-27；基线bd83113；任务basic-route-viewer-action。

新增tools/cs2d-host/viewer-action-smoke.mjs，用已安装Vite/Vue把实际ViewerStage、useReplay、ViewerMap、hostBridge及原样式编译成独立静态页。父页与iframe使用真实postMessage/source/origin校验，命令和事件经过现有contract validator。合成2人1回合49帧，只在浏览器页内生成；没有Parser、模型或用户Demo，不传comments id。

## 重放方式

```sh
node tools/cs2d-host/viewer-action-smoke.mjs --build
node tools/cs2d-host/viewer-action-smoke.mjs --serve-only --port=4321
```

打开http://127.0.0.1:4321，先确认实际Viewer已就绪且地图/人物可见，再点击“运行动作回放”。合成时间64→256、speed0.5，对应约6秒；返回128后暂停。合成时间不是测得Demo精确tick。Ctrl+C关闭服务；关闭tab触发Vue卸载。静态产物保留.local-data/basic-route-viewer-action/dist供重用，不包含用户数据。

服务仅绑定127.0.0.1，只提供dist及maps/weapons/teams白名单静态目录，realpath阻止越界。/.env、/libs/contracts/src/playback-bridge.ts和编码父目录访问均返回404。

## 实际观察

- root独立IAB预检WebGL2可用，原生RAF自然推进60帧；随后关闭预检tab与4320服务。ViewerMap使用原canvas实现，不把WebGL预检等同地图通过。
- 首次harness尝试实际时钟与ACK成功，但地图白屏，canvas高度异常增长到33554432，出现ResizeObserver循环。root立即关闭tab，未把这次记作渲染通过。
- 原因是独立Tailwind构建没有扫描被忽略的上游源码：产物缺absolute/inset-0/h-full/w-full/relative。仅修harness，显式@source上游src、约束html/body/#app高度，并在mount前检查实际CSS。没有修改产品Viewer代码或假装渲染。
- 第二次实际Viewer渲染通过：Mirage地图、两名合成人物、HUD与回决策点提示可见；canvas尺寸2496×1280前后稳定，页面errors=[]。
- 一次实际工具命令；观察playing时间从64到255，随后收到1次SUCCEEDED/CUE_PLAYED/completed=true，返回128、playing=false、speed=1。终点256由Viewer内部watcher到达后回退，跨bridge事件可被Vue合批，因此不要求父页收到每一tick。
- [有界DOM观察摘要](BASIC_ROUTE_VIEWER_ACTION_RESULT.json)。截图已在本任务中观察；无真实Demo/GPU模型性能主张。

## 验证与限制

独立小构建、脚本语法检查及真实contract命令检查通过；相关3文件19tests通过。pnpm typecheck、pnpm cs2d:typecheck、pnpm build、pnpm cs2d:build均退出0。两个验收tab、预检tab与loopback服务均退出，执行者RELEASE。

这里使用真实Viewer/自然浏览器时钟/真实ACK，但父页命令是固定合法测试命令，没有运行完整Next Host、默认Graph、数据库或真实Demo。上一轮默认策略闭环是独立证据，不能把两次相加称为一次整场端到端。原native桌面A5未运行；本次证明不依赖锁屏路径的小场景渲染验收可行。
