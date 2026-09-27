# 双教学点真实Viewer播放

2026-09-27；基线39fdf23；任务guided-two-cue-viewer-playback。

## 执行范围

复用viewer-action-smoke的Vite/Vue、Tailwind显式source、固定画布与loopback静态白名单服务，新增`--two-cue`，旧单段模式和输出目录不变。root唯一持有IAB tab12与4321服务，全程仅在页面内生成两个小合成回合，不读取或传输用户Demo/Replay。

父页实际运行Adapter、自然编译计划、本地Narration、Session reducer、guidedPlaybackDirective/transport/seek gate、呈现门及HostAdapter的能力/命令/ACK校验。工具选择是受控测试driver，仅使用真实注册的REPLAY_CUE_SLOW；不运行Graph Runtime、完整React Host、Parser或模型。子页是真实ViewerStage/useReplay/Map/bridge，以自然浏览器时钟发PLAYBACK_STATE和ACK。

必须先完整播放结果、回decision暂停，再经实际工具ACK与返回落点，才能显示讲解并启用继续。两段分别点击继续；总90秒、活动阶段30秒，错误可见，不用定时器伪造成功。合成整数位置不是实测Demo精确tick。

```sh
pnpm exec tsc --noEmit -p tools/cs2d-host/tsconfig.viewer-smoke.json
node tools/cs2d-host/viewer-action-smoke.mjs --two-cue --build
node tools/cs2d-host/viewer-action-smoke.mjs --two-cue --serve-only --port=4321
```

打开http://127.0.0.1:4321/，开始→第一段就绪后继续→第二段就绪后完成。服务只提供已编译dist与地图/武器/队伍白名单资产，停止时SIGINT/SIGTERM。

## 两次验收修正

1. 首run两段均ACK1、成功、回各自decision暂停，但父页在发最终pause后立即标complete，未消费实际暂停回报。只修harness：WRAP_UP继续接收消息，必须seek落点与真实playing=false确认才完成。
2. 修正后的run诚实停在终结不匹配而超时。原fixture最后frame2960，却声明postEnd3000；真实useReplay离线seek3000落2960且已暂停，父页2902/playing=true只是被seek门拒绝后保留的旧状态，不能据此称Viewer未暂停。
3. 查受控Parser assemble端点语义后，只修原始合成输入：按8tick步长补post-round帧至1800/3000，postEnd按半开规则设1801/3001；official end/事件/两个自然cue不变。真实useReplay离线确认请求3001落3000，在原±1内。未降低父目标、放宽容差或改生产代码；离线小验证通过后才进行最终必要UI复验，没有再盲跑整链定位。

原两run摘要与诊断保留于`.local-data/guided-two-cue-viewer-playback/`，不覆盖为新成功结果。不能从这个刻意缺尾帧的合成输入直接推断真实Demo存在生产故障。

## 最终真实观察

[匿名DOM摘要](GUIDED_TWO_CUE_VIEWER_PLAYBACK_RESULT.json)：2个自然cue、11个segment，分别在合成1336–1663与2536–2863观察到工具播放增长，各1次SUCCEEDED ACK；回1400/2600且playing=false后才显示当前讲解。两次显式继续均只计1，Presented=2、consumed=2。

最终phase=WRAP_UP、目标3001、实际3000、playing=false、terminalPausedConfirmed=true、complete=true、errors=[]。末轮采用半开端点，原±1门未改。地图、两个人物与HUD实际可见，截图保留于`.local-data/guided-two-cue-viewer-playback/final.png`；未从不可读取的canvas DOM推断尺寸。

初版fixture176帧，修正后186帧。Parser对末轮使用max(last sampled tick, official end)+1，对非末轮使用下一轮freeze start；本合成fixture仍有显式轮间间隔，不是完整Parser输出模拟，也不证明所有真实Demo的尾部覆盖。

## 检查与清理

两cue fixture与上一轮集成共2文件6tests通过；末帧修正后相关fixture1项复验通过。独立验收页构建、parent/fixture专项TS、脚本语法检查通过；Web/Viewer TypeScript及两端production build通过。最终只改tools与验证文档，产品文件未改。

三次UI运行的原因分别是首版终结过早、修正后暴露夹具缺帧、离线确认补齐后最终复验；不是性能基准或重复真实Demo解析。root关闭tab12与唯一4321服务，所有构建/测试退出，无Parser、模型、用户数据库、安装或部署操作。

下一有限目标guided-react-host-smoke：源码已确认Cs2dPlaybackHost提供viewerUrl、parentOrigin及reviewPreparationDependencies seam；先用当前小Viewer验证真实React Host的入口与准备接线，再依据实际依赖决定最小双cue路径。明确provider/runtime stub范围，不重复Renderer本身或把独立证据相加为完整应用通过。
