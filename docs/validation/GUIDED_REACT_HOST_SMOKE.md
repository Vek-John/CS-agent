# 真实 React Host 准备与首教学点小场景验收

日期：2026-09-27。基线：7bf5b77，功能分支 codex/jev-decision-assessment。

## 范围与复跑

使用实际 Cs2dPlaybackHost、生产 CSS、Session、准备 Orchestrator/Compiler、默认 Stage3 Graph（内存 checkpoint）、Vue ViewerStage、自然播放时钟与工具 ACK。复用 186 帧双回合合成输入；合成时间和固定身份只用于测试，不能解释为真实 Demo canonical tick/hash。

```sh
node tools/cs2d-host/react-host-smoke.mjs
node tools/cs2d-host/react-host-smoke.mjs --serve-only --port=0
```

打开输出的独立 loopback URL，保持 teachingDiagnostics=off。点击「载入合成比赛」，再点明确标注替代 DemoAnalyzer 的合成选人按钮；观察真实 Host 自动准备、开始与首教学点。每次新验收使用新端口；首次挂载发现已有 IndexedDB 或 localStorage 会停止，不读取或删除原记录。关闭自建页面后向本次唯一服务 PID 发送 SIGINT。

## 真实边界

- Parser、系统文件选择、真实 DemoAnalyzer 选人页不运行；合成入口调用实际 Adapter/序列化产生 AnalysisBundle，raw Replay 留在 child。
- Decision assessment 采用 RULE_BASELINE，Director 采用现有确定性 fallback，Narrator 使用真实合同的本地投影；禁止模型调用。不是专业判断能力改善，也不是默认诊断教学模式验收。
- Node 只提供限定的 agent HTTP 路由、协议校验和实际内存 Runtime；不启动 Next 服务、不载入 .env、桌面 SQLite 或 Memory。浏览器恢复仅使用新 origin 的测试存储，未验证重开恢复。
- Runtime 外部 fetch 被拒绝并计数；父页仅允许本 origin agent API 与已有物品目录 URL。没有部署、安装或正式 Demo 读取。

## 已定位的测试页差异

1. 初版误以为 ViewerStage 名单点击就是选人。实际该名单只控制跟随，选人归 DemoAnalyzer；补明确合成入口，不注入成功状态。
2. 初版选人前已挂 ViewerStage，其首次 PLAYBACK_STATE 早于 REPLAY_READY，随后被 Host reset 清除。真实 DemoAnalyzer 选人后才挂 ViewerStage；Host 自动 directive 要求收到播放状态。手动点 Host 播放能推进，说明桥接可用，但不等于自动开始通过。
3. 因此收敛为选人后首次挂实际 Stage，让 onMounted 自然发送状态。未改变产品门、发送假的播放状态或修改自动开始逻辑。

手动启动的中间验收：首 cue ACK1，合成1400暂停、讲解/问题面板/继续入口可用；继续后第二 cue 也在2600暂停。它是中间证据，不充作最终自动开始验收。原失败及中间摘要保留在 .local-data/guided-react-host-smoke/。

## 验证与结论

最终 IAB tab15 / 独立53771 origin，选择后没有点播放：自动进入4倍普通段，首 cue 慢放后回到合成1400、playing=false，显示“关键动作回放已完成”、当前状态、讲解、问题面板以及可用的“继续下一段”。Stage只挂载1次，Replay/selected/Analysis/route各1，Narration2；工具ACK1。实际内存Graph收到 OBSERVE_SEGMENT2、START_CUE1、RESUME_TOOL1，外部fetch0；父页forbidden/provider fetch0、errors=[]。[冻结摘要](GUIDED_REACT_HOST_SMOKE_RESULT.json)。

- `pnpm exec vitest run tools/cs2d-host/react-host-smoke.test.mjs tools/cs2d-host/viewer-two-cue-fixture.test.mjs`：最终2文件3tests通过（root移除仅匹配源码字符串的生命周期测试，以实际UI验证此行为）。
- `pnpm exec tsc --noEmit -p tools/cs2d-host/react-host-smoke.tsconfig.json`：parent/runtime/selection/fixture通过。Vue child由独立Vite构建和实际浏览器运行覆盖，不冒称这个专项tsc覆盖Vue child。
- `node --check tools/cs2d-host/react-host-smoke.mjs`、最终独立Vite build（3.54秒）通过。
- `pnpm typecheck`、`pnpm cs2d:typecheck`、`pnpm build`、`pnpm cs2d:build`：均exit0。其后仅测试工具改变，受影响的工具构建/类型/测试复验通过，生产文件未改变。
- root已读实际工具、生产Host启动/播放门、DemoAnalyzer/Stage生命周期及日志。没有产品bug需要修复，不把测试页接线问题算产品改进。

截图与运行日志：`.local-data/guided-react-host-smoke/final.png`、`final-observation.json`、`final-runtime.json`、`{tests,typecheck,web-typecheck,viewer-typecheck,web-build,viewer-build}.txt`。三个自建页面和对应服务都关闭，不删除独立origin产生的测试存储，不触碰用户资源。

下一有限目标：在同一已核实Host生命周期基础上启用默认诊断教学模式，验证其当前本地教学内容/回退、工具完成与提问接线；先检查必要provider接口，只对远端provider做显式隔离，不绕过diagnosis/引用/未来信息门。不重新验证Parser、整场Renderer或旧锁屏A5。
