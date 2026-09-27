# 真实 Demo 文件与 Host 入口验收

日期：2026-09-27。基线4f774c3，codex/jev-decision-assessment。

## 目的与预检结论

前序真实Host控制/教学/收尾使用合成入口。本轮接实际DemoAnalyzerView、Vue memory router、原文件输入/玩家选择、Parser Web Worker与本地WASM，再进入已验证Host；不发送伪造Replay/PLAYER_SELECTED/ANALYSIS_READY。

实际数据路径：File→decompress/parse Worker（原始buffer transfer）→WASM/JSON Replay→child（Replay结构化克隆，voice transfer）→recent.save的archive/gzip与新origin IndexedDB/localStorage→真实玩家选择→本地CS-Net Worker（Replay克隆）→AnalysisBundle→Host。后两项分别带来缓存和模型计算成本，不能宣称零存储或零模型。

已有资产本地可用：parser WASM约602KiB、INT8约9.8MiB、FP16约19MiB、ORT运行时。此次显式wasm-int8/单线程/batch16便于控制预算，不代表默认WebGPU性能；不下载模型、不调用外部LLM、不载入.env或用户SQLite/Memory。

## 预算与隔离

- 每次新loopback origin；发现已有存储时停止，不读或删除已有记录。新origin自产缓存保留。
- 仅.dem、输入<=128MiB；已授权test_demo文件只核实存在/大小60,601,900B，正式解析仅root决定的一次。
- 解析/归档缓存阶段与选人后计算阶段各120秒，总等待边界独立于生产win-rate的120秒无进展期限；用户选人停留不算处理时间。
- CSP限制child与Worker连接到self，已有本地资产白名单和正确WASM/MJS MIME；COOP/COEP对齐所需隔离。
- 浏览器无单页RSS硬限制，不把文件上限冒充内存上限。bulk只在所属page/Worker；timeout卸载组件并终止本页Worker，root关闭自己页面/服务作为最终清理，不删除用户数据。

## 分阶段验收

A1源码与预算已核实。A2独立真实入口构建/无文件挂载。A3先极小无效.dem确认实际文件输入、Worker/WASM及诚实错误反馈；该样本不表示解析成功。基础设施成立后新origin只一次正式test_demo/原指定玩家povergo，观察入口至准备/首教学点或明确真实阻塞。

## 实际结果

1. IAB tab21 / 新origin55643小挂载成功，原文件选择器正常。8字节无效样本经过真实Parser Worker/WASM后42ms返回PARSER_ERROR，界面显示“Demo解析失败 / Supports only Source 2 replays”；ParserWorker1、modelWorker0、activeWorkers0，未冒充成功。
2. 关闭小样本页与服务，新origin55719 / tab22只选择一次已授权test_demo.dem，原界面选择指定玩家povergo。真实解析与cache共8428ms，9回合10玩家；ParserWorker1结束，缓存路由已就绪。没有再解析、修改或复制原文件到仓库。
3. wasm-int8/单线程/batch16本地模型确已启动。观察进度45%后，通过产品现有“先用基础路线”按钮停止等待；选人至ANALYSIS_READY共91330ms（含等待、取消与分析准备，非纯模型耗时）。modelWorker1被终止，activeWorkers0。本轮**未完成胜率推理**，不称为模型通过或默认WebGPU耗时。既有默认WebGPU旧测量已在任务板，不能拿这次保守配置替代它。
4. 实际AnalysisBundle进入Host：Analysis1、route1、narration2，自动4倍播放至首教学点并返回决策位置暂停，Reflection Gate可用。可见事实包括低血量、护甲/头盔未知项、最近采样地面接触及其非开火瞬间限定、决策前本人开火；没有提交臆造的玩家意图或声称专业判断改善。
5. 实际Node Runtime收到OBSERVE_SEGMENT2，外部fetch0；父页forbidden/provider fetch0。real响应实际带self CSP/COOP/COEP，child/Worker外连被禁止；浏览器错误/警告读取为空。模型启用/启动与完成分开记录，stageReady=null不伪造Stage ACK。[有界摘要](REAL_DEMO_HOST_ENTRY_RESULT.json)。

## 工具与验证

复跑（先小样本，正式文件不要反复解析）：

```sh
node tools/cs2d-host/react-host-smoke.mjs --real-demo
node tools/cs2d-host/react-host-smoke.mjs --serve-only --port=0 --real-demo
pnpm exec vitest run tools/cs2d-host/react-host-smoke.test.mjs tools/cs2d-host/viewer-two-cue-fixture.test.mjs tools/cs2d-host/react-host-smoke-real-lifecycle.test.mjs
pnpm exec tsc --noEmit -p tools/cs2d-host/react-host-smoke.tsconfig.json
pnpm exec tsc --noEmit -p tools/cs2d-host/react-host-smoke-real.tsconfig.json
node --check tools/cs2d-host/react-host-smoke.mjs
```

3文件8tests、两套专项TS、脚本语法、真实模式Vite build4.78s通过；`pnpm typecheck` / `pnpm cs2d:typecheck` / `pnpm build` / `pnpm cs2d:build`全部exit0。新增Vue wrapper单独配置避免Vite ImportMeta与Next全局类型冲突，实际SFC内部由Viewer vue-tsc与构建覆盖，不关闭产品检查或新增依赖。

root读实际工具diff/Parser/缓存/模型生命周期与测试，执行者RELEASE。tab21/22及55643/55719两个服务已关闭，Worker都已退出；新origin自产缓存保留，未删除任何库。截图/日志 .local-data/real-demo-host-entry-preflight/，首点first-cue.png及first-cue.json保留，截图不提交仓库。原合成模式与旧证据保留，没有生产代码变更、安装或部署。

## 后继与剩余限制

本次完成真实文件→解析/缓存→原玩家选择→取消模型等待→实际首点；不是完整真实Demo整场教学、完整胜率模型、模型质量、原生桌面或恢复证明。小样本目前直接显示底层英文“Supports only Source 2 replays”，对于截断/无法识别的文件缺少清楚的下一步。下一有限目标 parser-file-error-feedback：先核实真实worker错误来源，用小无效输入验证可行动的解析错误反馈与重选能力；不再次解析正式Demo、不把未验证文件一概标为损坏，也不混淆模型不可用与Parser失败。

