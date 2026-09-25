# CS2 AI Demo Coach 技术学习与决策日志

> **状态：持续维护的工程复盘，不是架构规范。**
>
> - 长期架构唯一事实来源仍是 [ARCHITECTURE.md](../ARCHITECTURE.md)。
> - 产品目标与范围以 [PRD.md](../PRD.md) 和 [MVP_SCOPE.md](../MVP_SCOPE.md) 为准。
> - 本文记录「为什么做这个选择」「实际踩到了什么问题」「如何验证」；它可以解释架构，但不能覆盖架构契约。
>
> 最后更新：2026-09-25

## 1. 维护规则

以下变化合并时，同时更新本文：

- 改动 Demo 解析、回放、iframe bridge、教学会话、模型、部署或第三方上游；
- 真实 Demo 验证暴露了影响用户体验、事实正确性或性能的坑；
- 用户反馈改变了交互原则、教练表达或产品路径；
- 新增或替换模型、地图/游戏资源、外部 API；
- 发现一个以后很容易重复犯的工程错误。

每条新记录至少回答五件事：触发问题、最后决定、代码/契约落点、验证方式、已知限制。纯颜色或间距调整无需记录；但若它揭示了交互原则，例如「只能有一条时间轴」，就应记录。

如果变更了长期模块、契约、信任边界、模型职责或部署边界，先同步 **ARCHITECTURE.md**，必要时新增 ADR；本文只留下可回看的过程和理由。

## 2. 一分钟理解当前路线

产品不是上传 Demo 后生成报告，而是 AI 像教练一样带用户看完整场：

~~~text
本地 .dem
  → WKWebView Viewer/Worker 内一次解析
  → 真实 2D 回放 + 结构化分析包
  → 教练选择值得讲的片段
  → 先完整看动作和结果
  → 再回到决策点讲清局面、错误和替代动作
  → 全场结束后总结
~~~

当前最重要的工程原则：

- **一份 Demo 只解析一次。** 回放与分析从同一份结构化 Replay 派生。
- **地图是全知回放；教练判断有信息边界。** 用户不需要看到“玩家已知”模式，但教练不能拿未来或不可知敌人位置批评玩家。
- **只有一条整场时间轴和一个播放头。** 教练路线、手动跳转、HUD、地图、回合信息和胜率曲线必须跟随它。
- **先把动作与结果看完，再讲。** 不让用户在事情发生后才跳进去，也不要求用户先做题。
- **模型是分析信号，不是事实或因果证明。** 胜率下降可以帮助定位，但不能自动断言“全是这个玩家造成的”。
- **先用可复用底座交付 MVP。** 不为了“自研”重复做成熟回放能力。

5.1.0 已对齐已实现的 local-first 桌面边界：Tauri 只监督一个自包含 Node/Next sidecar，现有 Next/cs2d/Session/Agent/Memory interface 继续作为深 module；桌面 Memory 与 Agent checkpoint 使用同一 Application Support SQLite 文件中的不同 Adapter/表。Cloudflare/DO/PostgreSQL 保留为 Web 兼容形态，不是桌面前置。实现测试/local ad-hoc RC 与 public distribution 仍必须分开记录。

## 3. 当前技术选型速查

| 领域 | 当前选择 | 选择原因 | 不能做什么 |
|---|---|---|---|
| Web 教练壳 | Next.js + React + TypeScript | 方便做会话、上传入口、教练侧栏与部署 | 不保存 raw Demo，也不直接渲染逐帧 Replay |
| 真实回放与解析 | 固定版本 zenojunior/cs2d 的 Vue/Canvas、Worker/WASM | 已具备真实雷达、10 人 HUD、多楼层、投掷物、炸弹和浏览器解析 | 上游许可未明确，不能当作可自由公开再分发的代码 |
| 回放整合 | 同源 iframe + cs2d-playback-bridge.v1 | 将上游 Viewer 与教练业务隔离，避免 raw Replay 跨应用边界 | 不能把 iframe 私有 Replay 偷渡给 Next 或 LLM |
| 教练分析 | cs2d-analysis-adapter + 确定性计划回退 | 把上游 Replay 转成稳定的 MatchTimeline、ObservableState、ReviewPlan | Parser 不产生“你打得蠢”这类结论 |
| 会话控制 | libs/session reducer + SessionOrchestrator | 把跳转、自动跳过、结果揭示、回看做成可测状态机 | 不能由 UI 每帧临时猜会话状态 |
| LLM | Provider-neutral JSON/Schema Adapter；当前可用 DeepSeek | LLM 负责表达与教学判断，不负责读取 Demo 或控制播放器 | 不能输出无事实引用的结果、数值或因果 |
| 实时胜率 | 固定 cs-net win-rate head → INT8 ONNX → iframe Worker ORT/WASM | 用真实局面信号辅助 Director 选择教学片段 | 不改变 Demo parser，也不是玩家当时的已知信息 |
| 模型资产 | 版本化 manifest、量化 ONNX、浏览器缓存 | 可复现、可校验，并适配 Worker 静态资源限制 | 不上传 Replay、模型输入或 .dem 到服务端 |
| 主产品部署 | Tauri 2.11.5 + pinned Node 24.19.0/Next standalone sidecar | 自包含 Apple Silicon app；宿主只监督进程/窗口/Secret/更新 | 不另造 Parser、Session、Memory，不依赖系统 Node/Cloudflare/PostgreSQL |
| 开发/兼容 Adapter | localhost 双进程；Cloudflare 同源 `/cs2d/` Viewer | 调试与保留 Web 部署兼容性 | 不能反向定义普通桌面用户前置；key 不进仓库、日志或 NEXT_PUBLIC |
| 桌面存储 | Application Support SQLite + macOS Keychain | Memory、checkpoint、preference 得到本机 locality，Secret 与数据库分离 | 同一 DB 文件不代表领域合并；WebView 永远不能读取 Secret |

## 4. 已学到的关键问题与结论

### 4.1 地图不是一个独立功能，它是教练讲解的空间语言

**遇到的问题**

最早的 CSS 示意地图和百分比坐标可以验证时间轴，却无法回答用户真正的问题：人在哪一层、谁拿什么枪、投掷物落在哪里、为什么这个 peek 有风险。地图如果脱离教练路线单独存在，用户会得到一个“能看”的 viewer，却不知道该学什么。

**最终结论**

- 默认地图必须消费真实 Replay 的世界坐标、雷达、楼层、玩家、装备、道具、炸弹和投掷物；
- 地图服务于当前教练片段：平时保持稳定居中，关键讲解时受控聚焦问题点，播放结果也保持聚焦；
- 地图和 HUD 不额外创造教学逻辑，仍跟随同一 canonical tick 和同一个播放头；
- 不继续扩展第二套自研 renderer。旧 PixiJS PoC 保留为实验与回归，而不是默认产品路线。

**实际选型**

采用固定版本 cs2d 作为浏览器解析与回放底座，主仓库只保存最小 host patch 和适配器，不把整个上游源码搬进来。相关决策见 [ADR-0002](./adr/ADR-0002-adopt-cs2d-localhost-playback-substrate.md)。

**以后如何判断是否该换底座**

只有在上游许可、可维护性、正确性或性能明确阻塞产品时，才做替换 ADR；“UI 看起来还不够漂亮”不是重写 renderer 的理由。

### 4.2 全知地图和玩家已知信息必须分开，但不必让用户看见两种模式

**遇到的问题**

把“玩家已知”简化成一个可见圆，或把未看见的人直接隐藏，既不符合 CS2：脚步、枪声、最后已知位置、伤害方向、队友信息都可能带来不完整线索，也让 UI 变得像考试工具。反过来，把全知地图直接喂给教练，又会出现“对手在 B，你为什么不去 A”这种不公平批评。

**最终结论**

- 地图始终显示当前 tick 的全知事实，方便用户理解全局；
- 内部单独从 Replay 派生 ObservableState / ObservationClaim，记录来源、时间、空间精度、身份精度、置信度和过期；
- 决策前的教练语言只能引用当时可用的证据；结果事实必须等播放完成后才解锁；
- “看见”“听到方向”“最后在某处看到”“队友可能知道”是不同的 claim，不能合并成一个 boolean。

**验证重点**

任何新增教练规则或 LLM 输入都要做 future-leak 回归：地图可以显示全知，但 Narrator 的决策侧包不能带未来敌人坐标、结果或未发生的投掷物路径。

### 4.3 一次解析、两个消费者：不要为了分析再读一遍 Demo

**遇到的问题**

早期 Python parser、旧 ReplayBundle、浏览器 renderer 并存时，很容易出现不同 tick、不同 round 编号、不同字段缺失处理，甚至 Falcons/Spirit 开场有占位 round_end 的兼容差异。

**最终结论**

~~~text
.dem
  → cs2d File / Worker / WASM（一次）
  → 同一份结构化 Replay
       ├─ cs2d renderer（全知显示）
       └─ Analysis Adapter（时间线、证据、计划、模型特征）
~~~

- raw Replay、二进制 Demo、逐帧数组留在 iframe；
- Host 只接收白名单 Cs2dAnalysisBundle，不能把大对象拷贝到 Next；
- 老 Python demoparser2 仅用于迁移回归和故障对照，不能与 cs2d Replay 混成同一场会话；
- Parser 发事实与 warning，不能发“错误行为”“建议”或 LLM 结论。

**工程收益**

这条边界同时解决了性能、隐私、版本一致性和 bug 定位问题：用户报告一次回放错误时，可以沿着一个 Replay、一个 canonical tick 和一个 bridge 追查。

### 4.4 教练片段不能从“人已经死了”开始

**用户体验问题**

只跳到死亡或击杀 tick，用户会先看到结果，再听“你不该大拉”。这不是复盘，是事后报答案；用户无法理解动作是如何发生的。

**最终播放语义**

~~~text
前置约 1 秒
  → 连续播放决策、动作与结果
  → 结果后约 1 秒上下文
  → 自动暂停
  → 回到 decision tick
  → 一次性显示：当前情况 / 你做了什么 / 教练分析
~~~

- FREEZE_TIME 是确定系统等待，自动跳过且不询问；
- 普通低价值区间仍应在时间轴上标明，可由用户自由跳转；
- “再看一遍”也必须从前置上下文开始；
- 结果区间结束前不能露出 outcome 文案；
- 收到旧播放位置的 PLAYBACK_STATE 时，不能把它误当成新的 seek 已落位，否则会提前进入结果或讲解阶段。

这条经验对应当前播放协议中的 seek 落位门槛、半开区间和 outcome_end_tick 校验。涉及播放契约时，必须同步更新 ARCHITECTURE.md。

### 4.5 只有一套控制：时间轴是全场的共同事实

**遇到的问题**

把上游播放器硬嵌进教练壳后，出现过两条进度条、两套快进按钮、用户手动跳转时地图、HUD、侧栏不同步的情况。这会直接破坏“AI 带看一场 Demo”的体验。

**最终结论**

- 对用户只显示一条整场时间轴和一套中文控制；
- 时间轴用不同色块表示教练重点、低价值和普通片段，能按回合定位；
- 胜率曲线显示在同一条时间轴下方，而不是再造一个播放器；
- 用户手动跳转时进入 UserTakeover：所有 UI 以实际播放头为准；
- 用户点“返回教练路线”时，选择最近 cue（等距选后一个），从该片段的前置上下文重新开始。

**界面准则**

目标玩家必须始终直观：右上角显示正在复盘谁，HUD 只能选目标玩家，地图标记用“你”；不要把 parser tick 直接暴露给普通玩家。

### 4.6 教练不是论文摘要，要用 CS 玩家听得懂的语言

**遇到的问题**

“风险暴露、观察状态、局面转换”这类正确但学术的表达，无法让玩家立即知道下一次该怎么做。一次让用户先猜再讲，也打断了观看节奏。

**最终结论**

每个结果后的讲解优先稳定成三段：

| 区块 | 作用 | 示例方向 |
|---|---|---|
| 当前情况 | 蓝色事实卡 | “你在狗洞，满血头甲，手里 AK，还有一颗道具。” |
| 你做了什么 | 红色行为卡 | “队友没到位、也没育苗，你直接大拉，被对面收掉。” |
| 教练分析 | 绿色可执行建议 | “B 小有人就先架好枪线、育苗，等队友能补再拉。” |

约束：

- 只用已经验证的事实，不把推测写成确定事实；
- 只有动作证据足够时才说“大拉”“小身位 peek”等术语；
- 先讲一个主动作，避免一次给五条泛泛建议；
- 经济局面要说人话：ECO 没头甲不要无脑和步枪硬磕；强起要提投入与风险；
- “你死后胜率掉了一半”必须同时能给出前后概率和百分点变化，避免相对变化与绝对变化混淆。

### 4.7 实时胜率用于定位和复盘，不能当作“玩家当时知道”的信息

**需求变化**

用户希望进度条下方一直看到整场实时胜率，并让 Director 把“玩家死亡 + 胜率显著下降”作为教学候选的重要信号。这个曲线允许显示未来，因为它是赛后复盘工具，而不是第一人称竞技辅助。

**最终设计**

- 引入固定 [cs-net](https://github.com/Gary2005/cs-net) win-rate head 的模型契约与 checkpoint；不引入它的 parser、产品 UI、Flask 服务或其他预测头；
- 同一 cs2d Replay 在 iframe 内构造 31-token 特征，独立 Worker 用 ONNX Runtime Web 推理；
- WinProbabilityTimelineV1 覆盖所有正式回合和当前播放头之后的时间，不受 cue 或结果门槛裁剪；
- 选手换边时，根据该回合阵营显示“你方胜率”；
- Director 综合死亡、负向 swing、PISTOL、ECO、FORCE、FULL、UNKNOWN 经济语境；
- OutcomeImpact 只在结果播放结束后展示，带前后概率、百分点、相对变化、归因置信度与并发事件限制。

**一个容易犯的错**

胜率变化与某个动作发生在同一段时间，**不等于**该动作独自造成了变化。若同时有队友死亡、C4 状态变化等并发事件，教练应说“这段处理后胜率从 X 到 Y”，而不是绝对归因。

**当前验证与限制（2026-08-18）**

- FP32 对 PyTorch 的最大概率误差：2.09e-7；
- INT8 对 FP32 的最大误差：0.00385，排序与 swing 方向一致率均为 1.0；
- FP32 ONNX：38,284,975 bytes；INT8 ONNX：10,302,780 bytes；ORT WASM 资产：13,479,978 bytes；
- test_demo.dem 已生成 AVAILABLE 曲线；本机 CPU/WASM 冷启动整场推理约 172.5 秒；
- Falcons/Spirit 已通过解析、10 人与目标选手选择 smoke，但未在本轮等待窗口内完成模型推理。

因此下一阶段的首要技术债不是“再加一个模型”，而是缩短整场浏览器推理时间：优先评估采样/批处理、Worker 调度、模型缓存与可选 WebGPU，同时保持 WASM 回退和相同输出契约。

### 4.8 模型资源要可复现、可部署、可降级

**遇到的问题**

原始模型大于单个静态资源允许的大小，量化后如果只看“能跑”而不做 parity，可能让曲线的排序与摆动方向失真；模型下载/推理如果没有真实进度，用户只会看到不可信的加载圆圈。

**最终结论**

- 模型 revision、checkpoint/config/tokenizer/feature builder SHA、temperature、量化类型、资产 SHA 和大小都写进 WinProbabilityModelManifest；
- INT8 资产小于 Worker 单文件静态资源限制，构建中验证大小；
- 每次重新导出或量化都测 FP32/INT8 概率误差、排序和 swing 方向；
- 下载与分块推理上报真实进度；
- 模型失败只输出 UNAVAILABLE，基础回放、确定性 Director 和模板教练仍可继续；禁止伪造一条“看起来合理”的胜率曲线。

### 4.9 外部项目可以复用技术，不可以硬套 UI 或默认相信许可

**遇到的问题**

参考 cs2replays、Freezetime、cs2d 等项目能快速得到正确的功能方向，但“能看到网页”不等于可以复制其 UI、JS/WASM、资源或发布方式。直接搬页面还会造成双进度条、双控制和与教练壳不匹配的布局。

**最终结论**

- cs2replays 只学习公开行为与产品能力（真实雷达、装备、投掷物轨迹、逐回合体验），不复制 UI、代码或无明确许可的运行时；
- MIT 项目可按其许可证复用底层技术，但要在 THIRD_PARTY_NOTICES.md 记录来源、commit、许可证和使用范围；
- cs2d 当前没有发现明确 LICENSE：固定 commit、最小 patch、忽略上游源码、限制发布边界；公开商业化或扩大再分发前必须解决授权或更换底座；
- 游戏资产与代码许可证是两件事。使用前记录版本、哈希、来源、权利状态与再分发策略；不能因为“像官方游戏素材”就假定可自由发布。

### 4.10 真实 Demo 是验收，不是可选锦上添花

**遇到的问题**

合成 fixture 很容易掩盖 round 0、null winner、首 tick 占位事件、换边、缺字段、模型性能和浏览器 Worker 生命周期问题。Falcons/Spirit 就暴露过 parser 兼容边界；大文件也暴露了性能差异。

**最终结论**

- 每个重要解析、回放、模型变更至少跑 test_demo.dem；
- 涉及 parser 兼容或大文件性能时，再跑 Falcons/Spirit；
- 测试要分层：纯函数与契约测试 → bridge/会话集成 → 上游 typecheck/build → 浏览器 smoke → 真实 Demo；
- 文档要分别记录“通过”“未完成/超时”“环境权限阻断”，不能把 smoke 写成整场验证；
- synthetic fixture 只能叫 fixture 时间，不能称为精确 demo tick。

### 4.11 2026-08-20：WebGPU + FP16 只能作为隔离实验

**触发**

需要评估 WebGPU FP16 是否能改善 7,239 个样本的整场推理，同时保持现有 INT8 WASM 默认链路、采样顺序、feature 语义和教学结果不变。

**决定**

只从原始 FP32 ONNX（SHA `f9aa34f7...`）转换 FP16，使用固定的 ORT 1.19.2 转换器参数 `keep_io_types=true`、默认 op block list、shape inference 和非 external-data 输出。WebGPU 路径独立导入 `onnxruntime-web/webgpu`，必须通过 `navigator.gpu`、adapter、device、`shader-f16` 和 Worker session gate；失败时记录结构化原因并回到 INT8 WASM。ORT 没有足够的节点分配证明时，纯 WebGPU 状态保持 `UNKNOWN`，不把 session 创建成功当成 GPU 纯度证明。

**落点**

`libs/cs-net-winrate/src/runtime-webgpu.ts`、`tools/cs-net/convert_fp16_onnx.py`、`tools/cs-net/verify_fp16_parity.py`、本地-only `tools/prepare-cs-net-webgpu-assets.mjs` 与 cs2d Worker 的 `csProvider=webgpu-fp16` 查询分支。FP16/JSEP 资产不进入默认 INT8 同步或 Cloudflare 资产目录。

**验证**

FP16 产物为 19,452,396 bytes，转换 manifest、FP32/FP16 CPU sanity parity、capability/session/profile/计时 telemetry 均独立记录；正式浏览器验收固定同一输入与 canonical 顺序，先用 batch16/32 判断收益，再尝试 batch8/64。batch8 在本轮验收时限内未返回 telemetry，batch64 未启动；不把未完成的组合写成性能数字。保存的 batch16 timeline 与 FP32 CPU parity 继续用于概率、swing、Director cue 和 OutcomeImpact 检查。

**限制 / 下一步**

当前浏览器或模型若缺少 Worker WebGPU、`shader-f16`、JSEP runtime 或纯算子分配证据，继续使用 INT8 WASM；JSEP WASM 本身超过 Cloudflare 单文件限制，故 WebGPU 资产只保留本地实验。只有 parity、稳定性、纯度证据和相对现有 86.882 秒 inference 至少 1.3× 全部通过，才另开 ADR 讨论默认切换。

### 4.12 2026-08-20：adapter-only WebGPU session 与小矩阵验收

**触发**

真实 Edge 的自建 `GPUDevice` 路径会触发 Metal operation wait failure，需要在同一硬件上验证 ORT 自己管理 device 的路径，并快速判断 FP16 是否有明显收益。

**决定**

`libs/cs-net-winrate/src/runtime-webgpu.ts` 只设置 `ort.env.webgpu.adapter`，不写 `ort.env.webgpu.device`，session 只配置 WebGPU EP；profiling 延迟且可选。默认仍为 INT8 WASM `auto → 4 threads × batch16`。

**落点**

`tools/cs-net/benchmark_webgpu_edge.mjs` 通过 `EDGE_CDP_ENDPOINT` 复用已有 localhost 页面；FP16 模型 SHA 为 `94ef9a19ff5e3d2e122e57fd0fb2a79c670f14746d79399c1352ab9b25742f63`，大小 `19,452,396` bytes。ORT JSEP WASM 为 `26,827,543` bytes，超过 Cloudflare 单文件上限，FP16 只保留 localhost/local-only。

**验证**

Edge `151.0.4129.93`、macOS `26.5.2 (25F84)`、Apple M1 Metal 的主页面、iframe、Worker 均有隔离、GPU adapter 和 `shader-f16`。test_demo 真实解析得到 9 回合、7,239 个 canonical samples；batch16 cold `16.69858s`，三个 warm `15.39264s`、`16.885485s`、`17.024465s`，median `16.885485s`，约 `428.7 samples/s`，相对 INT8 `86.882s` 约 `5.15×`；batch32 warm `20.075405s`，更慢。ORT warning 明确 shape ops 被 CPU 分配，telemetry 为 `KNOWN_CPU_SHAPE_OPS_FROM_ORT_WARNING`、2 条 warning；`profileKernelCount=0` 单独表示 profiling 无 kernel 事件，结果不称 pure WebGPU。

**限制 / 下一步**

batch8 raw-CDP 运行超过 5 分钟没有 telemetry，按时限终止；batch64 未启动，未测结果不写成性能数字。Falcons/Spirit `453,978,283` bytes 的 batch16 尝试了 CDP target、iframe-local Replay 和最后一次 Playwright Edge 启动：CDP target 在 iframe 可用前超时，首个 harness 曾因把 433 MB Replay 序列化回 Node OOM，Playwright `channel=msedge` 又在页面创建前 `SIGABRT`，所以无 Falcons WebGPU telemetry；既有 parser smoke 仍只证明约 `25.562s` 解析、10 人和 NiKo 选择。当前保守推荐 batch16，合理区间约 8–16（8 未实测），不再扩展 128/256。已知 CPU shape fallback、profiling 无 kernel 事件和 Cloudflare 26.8 MB WASM 限制均阻止切换生产默认；保留失败时独立回退到 INT8 WASM。

### 4.13 2026-08-20：WebGPU 结果的证据边界

**触发**

WebGPU session 成功不等于 pure WebGPU；必须同时保留 ORT 节点分配 warning、profiling 状态、providerActual 和 fallbackDetection。

**决定**

保留 WebGPU FP16 为 local-only PoC；能力或 session 失败时回到同一 Replay 的 INT8 WASM。当前真实结果使用 adapter-only ORT 设备管理，默认 provider、采样密度、feature 语义和 Director 不变。

**落点**

`libs/cs-net-winrate/src/runtime-webgpu.ts`、`tools/prepare-cs-net-webgpu-assets.mjs`、`tools/sync-cs-net-assets.mjs` 与 Edge harness。完整证据在 `.local-data/acceptance-csnet-webgpu-fp16/benchmark-summary.json`、batch16/batch32 benchmark JSON 和 Director parity JSON。

**验证**

保存的 Director parity 对照确认 7,239 点、82 个 swing、cue IDs `c1/c2`、OutcomeImpact 数值和 session 结果确定性一致；FP16 CPU parity 误差低于 `max 0.005 / mean 0.001` 门槛。

**限制 / 下一步**

不得把 5.15× 相对收益解读为纯 GPU 收益；已知 CPU shape fallback、profiling 无 kernel 事件及 Cloudflare JSEP 26,827,543 bytes 限制仍使它只能作为 local-only 候选。默认继续 INT8 WASM `auto → 4 threads × batch16`。

### 4.14 2026-08-21：Falcons 单 controller 阶段门槛

**触发**

需要对 `spirit-vs-falcons-m2-mirage.dem` 做一次有界的 WebGPU FP16 batch16 验收；该文件为 `453,978,283` bytes，不能把 Replay 或逐帧数据搬回 Node。

**决定**

验收脚本收缩为一个 controller：它自行启动 localhost 3000/5174、自行用独立临时 profile 启动官方 Edge、只连接自己的 CDP endpoint，并在 finally 清理浏览器、服务与 profile。A/B/C/D/E 分别设置 `90s/90s/120s/180s/480s` 门槛，总时限为 10 分钟；页面内 Worker 只向 Node 返回摘要与 telemetry。

**落点**

`tools/cs-net/benchmark_webgpu_edge.mjs` 与 `.local-data/acceptance-csnet-webgpu-fp16/falcons-batch16-final/` 阶段 JSON。脚本固定使用原生 Edge 参数，不含 SwiftShader、use-angle 或软件 GPU 参数；test_demo smoke 只构造页面内前 16 个 canonical samples，Falcons 阶段不回传 Replay。

**验证**

A 阶段通过：服务启动、Falcons 文件、FP16 模型 `19,452,396` bytes 与 asyncify WASM `24,254,953` bytes 均存在，9333 预检为空。B 阶段使用 `/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge`、临时 profile `/var/folders/m3/g18ldpm962x7y2s_7dz0r5q80000gn/T/cs-coach-edge-falcons-controller-fDfN4y`、PID `30757` 和固定参数等待 60 秒，但未出现 9333；stdout/stderr 均为空。finally 后 3000、5174、9333 均关闭，profile 已删除。

**限制 / 下一步**

本次没有进入 test_demo、Falcons 解析或 WebGPU 推理，因此没有新增 Falcons telemetry，不能把任何 INT8 fallback 当作结果。既有 test_demo FP16 batch16 和 Falcons 解析/选人 smoke 证据仍保持有效；下一次若要继续，先解决同一执行环境下原生 Edge headless 进程不暴露 CDP 的启动权限边界，不再叠加 attach 或 Replay 搬运 workaround。

### 4.15 2026-08-21：WebGPU 默认请求与非回退错误边界

**触发**

WebGPU FP16 已有真实 Edge batch16 结果，但 Worker 仍把 provider 缺省解释为 WASM，并在所有 WebGPU 异常上立即回退。这样会把请求取消、旧请求 superseded 或超时误报成可用的 INT8 结果，也无法让 UI 知道当前分析确实 unavailable。

**决定**

Worker、页面路由和共享 runtime 统一默认 `webgpu-fp16` + `batchSize=16`。错误同时读取 `name`、`code`、`message`，归一化为 `FAILURE`、`TIMEOUT` 或 `ABORTED`：只有 `FAILURE` 发送 `providerActual=unavailable` 的失败 telemetry 后，才用同一 Replay、选手和 batch16 执行独立的 INT8 WASM；timeout、AbortError、取消和 superseded 只发送 unavailable/error，不调用 WASM。旧请求在任何阶段都不能写回当前请求。

**落点**

`libs/cs-net-winrate/src/runtime-config.ts`、`libs/cs-net-winrate/src/runtime-webgpu.ts`、`libs/cs-net-winrate/src/runtime-webgpu.test.ts`、`libs/contracts/src/playback-bridge.ts`、上游 `csNetWinRate.worker.ts`/`DemoAnalyzerView.vue` 与 pinned cs2d host patch。

**验证**

定向 runtime 测试覆盖默认 provider/batch、AbortError/取消、TimeoutError/deadline、普通 ORT failure、terminal error code、失败 telemetry 的 `unavailable` provider；bridge validator 测试覆盖该 telemetry。上游 Worker 与 patch 已用 `git apply --reverse --check` 做逐行同步校验；主站 production build、cs2d build、Cloudflare OpenNext build 和资产检查均通过，部署结果包含根 `/models/...` sidecar 与 `/cs2d/` asyncify 资源；未启动浏览器或大型 Replay。

**限制 / 下一步**

本轮没有重新跑 Edge 或 Falcons；真实浏览器仍可能因能力、ORT session 或已知 CPU shape-op 分配进入 INT8 fallback。FP16 模型（19,452,396 bytes）和匹配的 asyncify WASM（24,254,953 bytes）已纳入默认 viewer 发布并按需加载；旧 JSEP WASM（26,827,543 bytes）仍因 Cloudflare 单文件限制排除。生产结果需继续保留实际 provider telemetry，不能把失败记录当成 WASM 结果。

### 4.16 2026-08-21：Demo 与胜率共用可平移时间画布

**触发**

整场 Demo 进度与胜率曲线虽然都用 canonical tick 百分比，但位于两个独立宽度容器；加入横向缩放后会失去回合边界和播放头的视觉对齐，也无法像时间编辑器一样拖动画布查看局部。

**决定**

将 Demo 轨标为 A、胜率轨标为 B，放入同一个横向滚动内容画布。横向缩放只改变共享画布宽度，因此 A/B 始终使用相同百分比坐标；纵向缩放只改变 B 的图表高度。横向放大时，A 保留拖动定位播放头，B 和空白画布使用 Pointer Capture 直接平移，触控板横向滚动继续走原生 overflow；缩放以当前播放头为中心。

**落点**

`apps/web/components/playback/cs2d-playback-host.tsx` 与 `apps/web/app/globals.css`。控件使用 Lucide 方向图标、原生 range 和即时数值反馈，支持键盘、`prefers-reduced-motion` 与窄屏换行；不改变 Replay、canonical tick、Bridge、胜率模型或教练状态机。

**验证**

localhost 载入 `test_demo.dem` 并生成真实胜率曲线：横向 `2.5x` 时共享内容宽度约为 viewport 的 `2.5x`，B 画布拖动使 `scrollLeft` 从 `0` 到 `500px`；A 的第 2/3 回合边界与 B 对应竖线误差小于 `1px`。B 从 `1x` 放到 `2x` 时高度约由 `51.2px` 变为 `102.4px`，A 始终约 `40.8px`。定向测试、TypeScript 检查和宽屏视觉检查通过。

**限制 / 下一步**

当前不实现惯性甩动或缩略导航器；A 的主拖动手势继续负责 seek，画布平移放在 B/空白区域，以免两种高频操作互相抢夺。后续只有真实用户频繁在 A 上尝试平移时，再评估 Space/中键平移手势。

### 4.17 2026-08-21：Session gate 与冻结路线的集成 seam

**触发**

Session 需要同时处理连续播放、结果呈现授权、首批讲解就绪和后台 Narration 更新；旧的 PlanCompiler gate 位置容易让 replay 撤销已完成授权，也容易让旧 generation 的异步结果回写路线。

**决定**

OutcomeCompletionGate 归 Session 所有，并且只沿 `LOCKED → COMPLETE` 前进；重播由 phase selector 隐藏正文，不回撤 gate。Host 只保存 generation、frozen plan snapshot、route state 和 `narrationByCue`，Director → Compiler 通过必需的 `prepareRoute` seam 先冻结路线，Narrator 通过必需的 `prepareNarration` seam 之后按 cue 顺序补包。首两个 cue 并发完成后才发 `READY_TO_START`，其余 cue 不能越过该事件提前调用；取消时旧 generation 静默终止。

**落点**

`libs/session/src/index.ts`、`apps/web/lib/coaching/cs2d-route-integration.ts`、`apps/web/components/playback/cs2d-playback-host.tsx` 及对应 session、route、view、host 测试。

**验证**

定向 Vitest 为 4 个文件、36 tests 全部通过；覆盖 bundle identity/readiness、manifest status、Director → Compiler 顺序、前两个 cue 的 start gate、第三 cue 的调用顺序、自然边界 BUFFERING、one-way gate/replay、generation cancellation 与旧结果隔离；`pnpm typecheck` 与 `git diff --check` 通过。

**限制 / 下一步**

当前 02 的 `requestTeachingDirector + compileReviewPlan` 适配器尚未注入应用入口；默认 Host 使用显式 `ROUTE_PREPARATION_NOT_WIRED` seam，adapter plan 不会被标成冻结路线。接线后只需提供紧凑 AnalysisBundle/route input 与总能返回 READY/FALLBACK 的 Narrator adapter，不改变 Session/Host 的冻结和 gate 契约。

### 4.18 2026-08-21：S2 真实领域 seam 与 localhost 验收边界

**触发**

S1 的 generation controller 需要接入冻结的 CandidateSet、Director、PlanCompiler、CoachingPackage、OutcomePackage 和 Narrator provider；同时需要确认 CandidateSet 失败与空候选路径不会伪造路线或调用 provider。

**决定**

`ANALYSIS_READY` 只把 candidate set、观察证据、MatchTimeline 和胜率时间线传入 Host-owned preparation context。`prepareRoute` 执行 Director → Compiler，只有返回的 compiled plan 写入 `planRef`；`prepareNarration` 对最终 cue 构建双包并调用 Narrator，provider 返回的 `SUCCEEDED` 映射为 READY，`FALLBACK/DISABLED` 映射为 FALLBACK。空 COMPLETE CandidateSet 直接编译 BRIEF/SKIP 覆盖且 provider 调用数为零；FAILED CandidateSet 保留基础 iframe 回放并呈现可恢复错误。换人时 selected-player ref 与 generation 同时失效旧事件，并清除自由查看状态。

**落点**

`apps/web/lib/coaching/cs2d-route-integration.ts`、`apps/web/components/playback/cs2d-playback-host.tsx`、`apps/web/lib/playback/cs2d-playback-host.ts` 及对应测试。

**验证**

全量 Vitest：38 files，253 passed，1 skipped；S2 定向集成覆盖真实 Director → Compiler → packages → Narrator seam、prompt provenance、空/失败 CandidateSet、provider fallback、route freeze、consumed/frozen cue 拒绝更新和 selected-player stale-event guard。`pnpm typecheck`、`pnpm build`、`pnpm cs2d:typecheck`、`pnpm cs2d:build`、`pnpm cloudflare:build`、`pnpm cloudflare:assets` 与 `git diff --check` 通过；Cloudflare source/bundle secret check 通过。viewer dist 的 localhost 证据使用受控静态服务可同时提供 index、asyncify WASM 和模型端点。

`demoTests/test_demo.dem` 另做了一次不依赖浏览器权限的真实纵向 smoke：WASM 只解析一次，约 6.1 秒得到 `de_mirage`、9 回合、10 玩家；CandidateGenerator 产生 58 个候选，确定性 Director/PlanCompiler 得到 8 个 cue、43 个连续 segment，前两个 cue 的双包与五字段 fallback 均通过引用校验并达到 startable，AnalysisBundle roundtrip 不含 `rawReplay`、`frames` 或 `grenadePaths` 结构键。临时验收测试随后删除，没有进入常规测试负担。

**限制 / 下一步**

应用内 Browser 可以加载 `http://localhost:3000` 的 Host，但当前保存权限明确拒绝 `http://localhost:5174`，因此 iframe 无法用于自动上传、截图和 console 验收；没有伪造这些浏览器结果。服务 controller 已清理 3000/5174/9333。下一次可视化验收需先允许 Browser 访问 5174，再上传 `test_demo.dem`；这不影响上述真实 parser/领域链路证据。

### 4.19 2026-08-21：私有仓库推送与 Cloudflare 生产发布

**触发**

完成 WebGPU FP16 batch16 默认路径与确定性候选 → Director → Compiler → Narrator → OutcomeCompletionGate 纵向链路后，需要确认 GitHub 与生产 Worker 使用同一份已验证代码，同时不把 DeepSeek key 写入 Git、bundle 或浏览器变量。

**决定**

以提交 `5a28c8c` 作为本次运行时发布源，推送到私有仓库 `Vek-John/CS-agent` 的 `main`，再通过仓库唯一的 `cloudflare:deploy` 脚本完成 cs2d、OpenNext、静态资产和 Worker 的连续构建发布。DeepSeek 凭据只保留为 Cloudflare Secret；部署后用公开端点状态、隔离响应头、模型清单和无效请求契约做轻量 smoke，不上传真实 Demo 或调用付费模型。

**落点**

GitHub `main`、Cloudflare Worker `cs2-ai-demo-coach`，生产地址 `https://cs2-ai-demo-coach.vekel-hord.workers.dev`；Worker 版本 `e7b8c5bc-b5ac-4d90-a416-3487bd4208a2`。

**验证**

发布前全量 Vitest 为 38 files、253 passed、1 skipped，`pnpm typecheck` 与暂存区 secret scan 通过。Cloudflare build 的 source/bundle secret check 通过，准备 359 个静态资产（183,485,984 bytes），上传 45 个新增或变更资产并成功部署。线上 `/`、`/cs2d/`、`/models/cs-net/win-rate.fp16.manifest.json` 均返回 HTTP 200；根页面包含 COOP `same-origin`、COEP `require-corp`、CORP `cross-origin`；`POST /api/coaching/direct` 的空对象返回预期 HTTP 400。Cloudflare Secret 列表包含 `DEEPSEEK_API_KEY`，未读取或输出其值；GitHub 本地与远端 SHA 一致。

**限制 / 下一步**

Wrangler 打包报告生成 bundle 中存在重复 `radar_position` 对象键；本次编译与线上 smoke 未受影响，但应在下一轮修改相应 Adapter 时消除，避免前一个字段被后一个字段覆盖。此次只做结构与静态资产 smoke，没有在线上传完整 Demo 或消耗 DeepSeek API；真实生产 Demo 的浏览器端到端表现仍需下一次有界验收。

### 4.20 2026-08-21：Cloudflare 静态资产隔离头与 cs2d iframe 拒绝访问

**触发**

生产 Host 自身返回 HTTP 200，但 Edge 在中间地图区域显示 `chrome-error://chromewebdata/` 的拒绝图标；直接打开同一 `/cs2d/` URL 又能正常显示选择 Demo 页面。线上响应对比发现 Host 有 COOP/COEP/CORP，而精确匹配的 `/cs2d/` 静态资产只有 `Content-Type`。

**决定**

根因是 Cloudflare Workers Static Assets 默认资产优先：命中静态文件时不会执行 `tools/cloudflare-worker.mjs`，所以该文件声称统一添加的隔离头实际上没有覆盖 Viewer。没有启用全局 `assets.run_worker_first`，因为本地验证证明它会让 OpenNext 把 `/cs2d/` 308 到 `/cs2d` 后返回 404，并让所有大 WASM/模型请求额外经过 Worker。改为由 `prepare_cloudflare_assets.mjs` 在最终发布资产根生成 Cloudflare `_headers`，对所有静态资产补同一组 COOP `same-origin`、COEP `require-corp`、CORP `cross-origin`。

**落点**

`tools/prepare_cloudflare_assets.mjs`；修复提交 `0b3feda`；Cloudflare Worker 版本 `cc160f0c-646c-4314-b703-213ab7ae7996`。

**验证**

修复前的线上断言稳定失败：`/cs2d/?host=1...` 缺少 `Cross-Origin-Opener-Policy`。修复后 Wrangler 本地解析 1 条 `_headers` 规则，`/cs2d/` 返回 200 且三项隔离头齐全；Edge 本地完整 Host 中 iframe 正常显示“选择本地 Demo”，Viewer 的脚本、Worker、WASM、地图和武器资源均返回 200。全量 Vitest 38 files、253 passed、1 skipped，typecheck、Cloudflare production build 与 source/bundle secret scan 通过。重新部署后同一线上断言转绿，`/cs2d/` 返回 200 且三项隔离头齐全。

**限制 / 下一步**

部署前曾直接访问生产 `/cs2d/` 的 Edge profile 可能仍由旧 PWA Service Worker/CacheStorage 返回不带隔离头的缓存导航，普通强制刷新不能保证立即退出旧控制器；这不是 Cloudflare Access 权限。首次访问和新网络响应已修复，旧 profile 需要关闭仍打开的 `/cs2d/` 页面并清除此站点的离线缓存或重启浏览器。后续应在嵌入 host 模式禁用上游 PWA 注册，避免 Viewer 基础设施与主产品共享 Service Worker 生命周期。

### 4.21 2026-08-21：五字段证据收敛为三段式玩家讲解

**触发**

真实侧栏把 `currentSituation/playerAction/coreIssue/betterPlay/outcomeImpact` 五个内部字段逐张展示，造成卡片过长；确定性回退还把 `OBJECTIVE_TIMING` 等内部 taxonomy 直接显示给玩家，并重复展示 OutcomeImpact 与“胜率信号”。当概率变化小于一个显示百分点时，界面会出现“94% 到 94%，上升 0 个百分点”。

**决定**

保留 NarrationBundle 五字段及各自 refs，避免破坏 decision/action/outcome namespace 防火墙；新增唯一的 `ThreeStageCoachingView` 玩家投影：结构化状态用位置、HP、护甲、官方物品、道具、C4 和经济图标短标签展示；`playerAction + coreIssue + 有意义的 outcome` 合并为“这样做的问题”；`betterPlay` 单独成为“可以怎么改进”。Presenter 和 deterministic fallback 共用玩家语言映射，内部 focus code 永不进入 UI。`buildOutcomeImpactForCue` 在绝对变化四舍五入不足 1 个百分点时返回无 cue 影响，完整胜率曲线仍保留。DeepSeek Narrator prompt 升到 1.1.0，要求单句、具体 CS 术语、禁止 taxonomy 文案和零百分点。

`emil-design-eng` 与 `apple-design` 的影响是删掉重复层级而不是增加装饰：五张带状卡收敛为三张，状态改为可扫读 chip，问题与后果在同一卡内建立因果，按钮保留即时按压反馈，不为频繁讲解卡增加入场动画；继续支持 reduced motion/transparency。

**落点**

`apps/web/lib/coaching/cs2d-coaching-view.ts`、`apps/web/components/playback/cs2d-playback-host.tsx`、`apps/web/app/globals.css`、`libs/review-planner/src/coaching-language.ts`、Narrator fallback/prompt、cs2d action fact 文案和 OutcomeImpact builder；ARCHITECTURE 3.4.1。

**验证**

全量 Vitest：39 files、258 passed、1 skipped；`pnpm typecheck`、Next production build、`pnpm cs2d:typecheck`、cs2d production build 与 `git diff --check` 通过。定向测试覆盖旧 taxonomy 文案的人话降级、结构化状态 chip、最后决策状态选择、零百分点隐藏和有意义胜率保留。本地临时预览页使用最终 class/资产完成视觉检查，确认三段层级、Valve C4 图标、两行状态 chip 和双按钮在窄侧栏内可读；预览路由随后删除，未进入项目。

**限制 / 下一步**

本次未在浏览器重新上传真实 Demo；动态状态来自既有 MatchTimeline 契约和单元夹具，下一次实际 Demo 复盘应抽查三类 cue（死亡、C4、道具）是否都能生成准确短句。NarrationBundle 仍是五字段内部契约，后续不要为了 UI 数量再次复制一套 LLM Schema。

### 4.22 2026-08-21：Cloudflare DeepSeek 讲解全部降级为模板

**触发**

生产 `/api/coaching/narrate` 对最小匿名合法请求连续返回 `HTTP 200 / FALLBACK / UPSTREAM_SCHEMA`。Cloudflare Secret 元数据存在；上游实际响应为 HTTP 200、`finish_reason=stop`，因此不是密钥缺失、超时或 HTTP 错误。

**决定**

用同一模型和请求参数做脱敏结构探针后确认，DeepSeek 按旧 prompt 将五个 Narration 字段输出成纯字符串，而服务端契约要求每个字段携带 `text + refs`，以维持 decision/action/outcome 证据防火墙。保留严格解析和拒绝无引用输出的行为；将 prompt 升级到 `deepseek-narration-bundle/1.1.1`，明确禁止裸字符串并给出五个字段的匿名引用形状示例。没有用代码猜测 refs，因为那会把未验证文本伪装成有证据讲解。

**落点**

`apps/web/lib/coaching/deepseek-narrator.ts`、对应 prompt 回归断言和本节记录；NarrationBundle/ARCHITECTURE 契约不变。

**验证**

修复前线上最小请求连续 3 次均为 `UPSTREAM_SCHEMA`。修复后使用本地授权 Secret 直连同一 DeepSeek 模型，响应仍为 HTTP 200/`stop`，且 `currentSituation/playerAction/coreIssue/betterPlay/outcomeImpact` 五项均为包含 `text`、`refs` 的对象；定向 Vitest 12 项、typecheck 通过。Worker `3a09fb7d-1760-41c8-8354-bde7c8817f50` 发布后，线上同一请求连续 2 次返回 `SUCCEEDED/DEEPSEEK`，prompt 版本为 `1.1.1`。

**限制 / 下一步**

真实 Demo 的完整复盘仍需抽查一条死亡 cue 和一条道具/C4 cue，确认模型在多事实、多引用时保持命名空间正确；模型再次输出非法结构时仍会可追溯降级为确定性模板，不阻塞回放。

### 4.23 2026-08-21：Cloudflare Director 回显请求包并使用错误顶层键

**触发**

生产 `/api/coaching/direct` 同样连续返回 `HTTP 200 / FALLBACK / UPSTREAM_SCHEMA`。脱敏上游响应显示模型回显了完整 `candidate_set_*` 和 `candidates`，并使用 `selections` 顶层键，缺少 `priority`、`reason_refs`、`evidence_refs` 和 `confidence`。

**决定**

保留 Director 的严格 `selected[]` 校验；prompt 明确禁止回显输入包和 `selections`，并给出完整单项输出骨架及匿名引用数组。Director prompt 版本升级到 `deepseek-teaching-director/1.0.1`，非法响应继续走确定性候选回退。

**落点**

`apps/web/lib/coaching/deepseek-director.ts`、`deepseek-director.test.ts`；候选、DirectorDecisionSet 和 PlanCompiler 契约不变。

**验证**

修复前最小 Director 请求连续 2 次为 `UPSTREAM_SCHEMA`；修复后同模型直连探针返回 `selected`，每项字段集合完整且类型正确，定向测试 17 项与 typecheck 通过。Worker `8d28ba61-df7c-49b5-a8ec-a153228bc327` 发布后，同一线上请求返回 `SUCCEEDED/DEEPSEEK`，prompt 版本为 `1.0.1`；Narrator 同时返回 `SUCCEEDED/DEEPSEEK`，首页和 `/cs2d/` 仍为 200。

**限制 / 下一步**

模型供应商仍可能在复杂候选包上产生非法引用，服务端会拒绝并记录可追溯 fallback reason；后续应在真实 Demo 复盘中抽查多候选排序和重复习惯覆盖，而不是放宽校验。

### 4.24 2026-08-24：教学候选上限与成功对枪过滤

**触发**

生产/真实夹具路线仍沿用旧的 8 个 cue 上限；同时，所选玩家赢下对枪且所选方胜率上升的 `KILL` 仍可能被编译为教练片段，结果卡甚至会生成“胜率上升”影响文案。这类片段对用户没有明确可执行的纠错价值。

**决定**

新增跨 contracts、CandidateGenerator、Director、PlanCompiler、Host preparation 和 DeepSeek request parser 共用的 `MAX_TEACHING_CUES=50`。这是硬上限而非目标数量，确定性路线仍按回合代表、窗口去重和分数选择更少的候选。新增 `isPracticalTeachingCandidate`：模型曲线可用时，成功 `KILL` 只有在所选方结果窗口至少下降 1 个百分点时才允许进入路线；胜率上升、零/无负向摆动的 KILL 被保留为回放事实但不会触发 Director/Narrator。模型不可用时保留 KILL 事实候选，但不生成伪造胜率影响。

**落点**

`libs/contracts/src/coaching.ts`、`libs/review-planner/src/teaching-pipeline.ts`、`candidate-generator.ts`、`narration-package-builder.ts`、`apps/web/lib/coaching/cs2d-route-integration.ts`、`deepseek-director.ts`、`libs/cs2d-analysis-adapter/src/index.ts`；MVP/ARCHITECTURE 更新为最多 50 个 practical cue，版本分别为 CandidateGenerator 1.1.0、Director prompt 1.0.2、cs2d adapter 1.4.0、ARCHITECTURE 3.4.2。

**验证**

回归测试先稳定复现旧行为：成功 KILL 被选中、50 被压回 8、60 回合只生成 8 个停点。修复后定向测试 43 项、全量 Vitest 39 files / 264 passed / 1 skipped、typecheck、Next production build、cs2d typecheck/build 和 Cloudflare build secret scan 通过；cs2d 适配器夹具验证 60 回合最多生成 50 个 cue，并保留跨全场分布；正向 KILL 不进入 deterministic Director，且不生成 OutcomeImpact。完整 Falcons/Spirit Demo 的新路线仍需在发布后抽查。

**限制 / 下一步**

DeepSeek Director packet 仍为紧凑的最多 32 个候选，避免把大 CandidateSet 传给模型；50 是最终路线 ceiling，Provider 一次可能返回少于 50，后续未选候选不会被自动补成教练点。需要更多覆盖时应改进候选摘要/排序，而不是放宽成功对枪过滤。

### 4.25 2026-08-24：固定 PIN 的 cs2d 受控 patched checkout 复用

**触发**

`.local-data/upstream/cs2d` 的 HEAD 仍是固定 PIN，但已有受控回放、Host bridge、分析 Worker 和模型资产修改。0001 patch 的 reverse/apply check 均因超集 dirty diff 失败，导致 `pnpm cs2d:build` 在 patch 阶段阻塞；0002 patch 仍可精确 reverse。

**决定**

把 patcher 作为唯一深模块 seam：新增显式 `--reuse-patched-checkout` 路径，只有固定 PIN、`git diff --check` 通过、dirty 路径属于 patch/受控生成资产 allowlist，且 host bridge、host mode、canonical seek、Cloudflare base/COI 和 parser/replay marker 全部存在时，才返回 `EXACT_APPLIED` 或 `CONTROLLED_SUPERSET` 并跳过重复 apply。干净 checkout 仍走 clone/apply；错误 PIN、任意 dirty 路径、缺 marker 或 diff whitespace 错误直接拒绝。

**落点**

`tools/apply-cs2d-host-patch.mjs`、`tools/apply-cs2d-host-patch.test.mjs`、`tools/build-cs2d-viewer.mjs`。build caller 显式传 reuse flag，但没有改变 CoachAgent、DO Worker 或默认 Host。

**验证**

patcher smoke 复用当前受控超集 checkout 成功；三态与拒绝路径测试 4 项通过；`git diff --check` 和 upstream `git diff --check` 通过；`CI=true pnpm cs2d:build` 在 17 秒内成功完成模型/ORT 同步与 Vite viewer build，生成 `apps/app/dist`。

**限制 / 下一步**

本次没有运行 Cloudflare 全链或 `--build-parser`；复用 allowlist 对模型生成目录采用显式受控前缀，若生成资产布局变化需同步更新 patcher marker/allowlist 和测试。首次干净环境仍需 clone、安装依赖并正常 apply 两个 patch。

### 4.26 2026-08-24：浏览器 LangGraph interrupt 被否决，切换每 session Durable Object

**触发**

Stage 0 的最小 TypeScript `StateGraph`、MemorySaver、IndexedDB saver 和 browser bundle 单测都通过，但真实浏览器第一次执行 `interrupt()` 报“outside the context of a graph”。在同一 async-context seam 做一次有界 single-flight shim 修正后，第二次能抛出 GraphInterrupt，却仍由 browser graph invoke 向页面冒泡，未形成可 resume checkpoint。两次都发生在相同的 LangGraph browser async-context/interrupt 边界。

**决定**

按“两次同一基础设施 seam 失败即停止 workaround”的规则否决浏览器内 Graph。生产改为每个 session 一个 Cloudflare Durable Object：TypeScript StateGraph 与自定义 `BaseCheckpointSaver` 在 `nodejs_compat` 原生 AsyncLocalStorage 环境运行；浏览器只导入 client-safe remote dispatch，Graph 用 interrupt 返回紧凑 ToolRequest，Host 执行本地 Replay 工具后用 ToolResult/Command resume。localhost 同路径使用 process-local MemorySaver，并诚实标记刷新后不可恢复；IndexedDB saver 只保留为实验事实，不进入默认入口。

**落点**

`libs/coach-agent`、`apps/web/app/api/coaching/agent`、`apps/web/app/agent-poc`、`tools/coach-agent-durable-object.mjs`、`tools/cloudflare-worker.mjs`、`wrangler.jsonc`、ADR-0003 与 ARCHITECTURE 3.5.0。Graph state 和 checkpoint 只保存版本化身份、cue/capability、有限 tool history/theme/trace；raw Replay、frames、模型、Prompt、CoT 和 Key 不进入该边界。

**验证**

固定依赖解析为 `@langchain/langgraph@1.4.12`、`@langchain/core@1.2.9`、`zod@4.4.3`。Durable Object 定向测试 13 files / 42 tests、TypeScript 检查、OpenNext build、Cloudflare assets prepare 和 Wrangler release-assets dry-run 通过。真实 `wrangler dev` HTTP smoke 的三个独立请求依次得到 `START: WAITING_TOOL + 1 effect`、`RESUME: COMPLETED + 0 effect`、重复 resume `0 effect`，backend 为 `DURABLE_OBJECT` 且 `recoverableAfterRefresh=true`；8787 等测试端口和临时持久化目录均已清理。

**限制 / 下一步**

当前 Graph 仍是单 cue 纵向切片；Stage 2 需要从当前 cs2d 生成的冻结 ReviewPlan 提取一个真实 test_demo cue，接入 OutcomeCompletionGate、三段式 Narration、CapabilityBuilder 和一个 Host visual tool。完整多 cue、takeover、SessionTheme、真实 DeepSeek Policy trace 与会话结束后的 checkpoint 压缩仍未完成。浏览器内失败证据保存在 `.local-data/acceptance-agent-eval/stage0/in-app-browser-fallback-decision.json`，Durable Object HTTP 证据保存在 `.local-data/acceptance-agent-eval/stage0-do/wrangler-http-smoke.json`。

### 4.27 2026-08-24：Capability 合法性不能代替 Agent Policy 质量

**触发**

首版 TeachingCapability Eval 只检查“标注的首选工具是否出现在 builder 生成列表中”，没有实际执行 Policy；只要 builder 多生成工具，指标就会虚高。Graph 与 DeepSeek fallback 同时还会在 Provider 失败时机械选择第一个 capability，导致“合法但没有额外教学价值”的演示被当成成功。

**决定**

把 Eval 分成两层：CapabilityBuilder 只判断工具是否合法并绑定参数；Policy Eval 实际调用可注入 `PolicyAdapter`，判断是否应 `FINISH_CUE`、实际选中的 capability、禁止工具和输出 evidence。新增 Graph/Provider/Eval 共用的 deterministic policy seam：只有 focus 与 evidence 形成唯一有价值匹配时选择工具；多项同等合法、没有增量价值或证据不匹配时结束 cue。慢放进一步要求 verified `actionRefs`，不能用 decision/outcome fact 冒充可回放动作。生产 runtime 默认使用 deterministic adapter，Fake 只允许测试显式注入。

**落点**

`libs/coach-agent/src/deterministic-policy.ts`、`capability-builder.ts`、`graph.ts`、`adapters.ts`、`teaching-capability-eval.ts`、Agent Eval manifest、DeepSeek Coach Policy fallback 与 ADR-0003。

**验证**

23 个手工 fixture 实际运行 Policy 后：need-tool 一致率 100%，需要工具时首选一致率 100%，非法选择率 0%，required evidence 与合法 capability 生成均 100%，实际选择/结束为 12/11。相关回归 13 files / 52 tests、标准 TypeScript 检查与 `git diff --check` 通过；默认多 capability runtime 不再产生虚假 `POLICY_INVALID_OUTPUT`。

**限制 / 下一步**

这些是合成/手工领域 fixture，不代表真实 Demo 的模型质量；Stage 4 仍需用当前 cs2d AnalysisBundle、DeepSeek Policy 和真实 ToolObservation 重放同一标注集。`USER_TAKEOVER` 只有状态枚举，尚无可执行事件，因此保持明确 `UNVERIFIED`。

### 4.28 2026-08-24：Stage 2 visual tool 必须由 Host 绑定证据并受 ACK/超时约束

**触发**

Stage 2 要把真实 frozen ReviewPlan 的一个 cue 纵向接入地图工具。直接让 Agent 传坐标会越过证据边界；同时 React 异步 START、iframe ACK、用户接管和重复 resume 可能让旧 generation 继续产生副作用。Parser 还需要把 60MB raw `.dem` 的内容身份从 recent-history UUID 中分离出来。

**决定**

新增纯 `CoachAgentHostAdapter` 深 seam：它只接 frozen route、presentable narration、COMPLETE gate、allowlisted analysis identity 和 parser SHA-256，CapabilityBuilder 只生成 `FOCUS_MAP_EVIDENCE`，Host registry 保留 annotation→WORLD point 绑定，request 只能选择 capability ID。严格 bridge command/ACK 带 run/cue/generation/callId；Host 在 postMessage 前去重，ACK 后才 resume，generation cancel 会清 registry。ACK watchdog 超时转结构化失败并恢复基础回放控制，不盲目推进。raw bytes 留在 parser Worker，跨 iframe 只发 hash/摘要/命令。

**落点**

`apps/web/lib/coaching/coach-agent-host-adapter.ts`、`apps/web/components/playback/cs2d-playback-host.tsx`、`libs/contracts/src/playback-bridge.ts`、`libs/cs2d-analysis-adapter/src/index.ts`、`tools/cs2d-host/patches/0003-cs2d-stage2-map-focus.patch`、固定 cs2d 的 parser/bridge/Viewer patch。

**验证**

Adapter/bridge/client-safe 定向测试 49 项通过；root typecheck、Next typecheck、cs2d `vue-tsc` 通过；`CI=true pnpm cs2d:build` 成功。Stage2 patch 在临时 worktree 以固定 PIN 干净应用 0001+0002 后由 `git diff --binary --relative` 一次性生成，随后 clean `git apply --check`、apply 与 marker/reuse 验证通过；临时 worktree 已清理。60,601,900B `test_demo.dem` 的 Node WebCrypto SHA-256 基线为 42.13ms，摘要为 `84a1…b622cb2`；Hash latency 只记录 Worker 返回的诊断字段，不进入 UI。

**限制 / 下一步**

本轮没有跑浏览器自动化、完整 Cloudflare 链路或 433MB Falcons；没有在真实浏览器中测量 Worker hash latency。当前仅一个 cue、一个地图点工具，Viewer ACK 仍是本地可执行命令确认；多 cue、其他 visual tools、真实 Durable Object resume 与真实 Demo 浏览器 telemetry 需下一阶段验证。

### 4.29 2026-08-24：Stage 3B 的 lifecycle recovery 必须由 Host ledger 证明

**触发**

把 Stage 2 单一地图聚焦扩展到多 cue 和五种受约束工具后，冻结路线中的连续 FREEZE/普通段可能被 reducer 一次性消费；同时 HTTP observer/COMPLETE 失败、iframe ACK 丢失、takeover 和 React effect 重入都可能让 Host 把未确认的 segment 当成已同步，或让 Graph checkpoint 永久停在等待工具。

**决定**

以 `CoachAgentHostAdapter`/controller 作为深 seam：capabilityId/callId 按 run+cue+graph step 稳定，Host 只在 registry 中绑定 canonical tick、世界坐标、player、速度和展示参数；lifecycle event 使用 `PENDING`/`CONFIRMED` 状态，HTTP/dispatch 失败释放 PENDING，同 eventId 可安全重试，只有匹配结果 CONFIRMED 才推进 route cursor。观察事件通过单一 Promise tail 按 frozen plan catch-up 串行发送；工具 effect 使用独立单调 epoch，takeover 后旧 ACK 永不复活。五种工具均由各自 evidence/gate/可靠性资格决定，浏览器只呈现短状态和已绑定的证据卡。

**落点**

`apps/web/lib/coaching/coach-agent-stage3-host-adapter.ts`、`coach-agent-stage3-controller.ts`、`cs2d-playback-host.tsx`、`libs/contracts/src/playback-bridge.ts`、Stage 3 wrap-up seam，以及固定 PIN cs2d 的 `ViewerStage.vue`/`hostBridge.ts` 受控 patch。Stage 3 事件使用 v2；Stage 2 v1 入口保留。

**验证**

Stage3 Host/controller/integration/wrap-up 与 bridge/patcher 定向回归 6 files / 35 tests 通过；`CI=true pnpm typecheck`、Next production build、cs2d `vue-tsc --noEmit` 与 `CI=true pnpm cs2d:build` 通过。`0003` 在临时 worktree 以固定 PIN 干净应用 `0001`/`0002` 后，用六个当前上游文件一次生成 447 行 binary diff；随后三份 patch clean apply-check/apply、`git diff --check` 与受控 marker/reuse 校验通过，临时 worktree 已清理。

**限制 / 下一步**

Stage 2 的真实浏览器单 cue 地图聚焦已有验收证据；本轮没有再跑浏览器自动化、完整 Cloudflare bundle、433MB Falcons 或真实多 cue Stage 3 浏览器 telemetry。Stage 3 的五工具资格、ACK/timeout/takeover/recovery 已有纯 seam 覆盖，但实际可用性仍取决于当前 cue 是否存在合法 WORLD/trajectory/measurement/economy refs；不满足条件时会确定性降级，不伪造证据。

### 4.30 2026-08-24：Takeover 不能把未消费的 reveal 当成已完成教学

**触发**

真实 Stage 3 回放中，cue2 正在慢放时用户自由接管并回到 cue1。cue1 恢复成功后，Session 因 `revealed_cue_ids` 仍保留未 `consumed_cue_ids` 的 cue2，把它当成已揭示节点直接越过，继续到了后续进度；旧 iframe ACK 也必须继续失效。

**决定**

`RETURN_TO_NEAREST_CUE` 仍只撤销目标 cue 的 consumed/revealed 状态，但同时撤销所有“已 revealed、未 consumed”的其他 cue；已消费的后续 cue 保留，避免整场重复教学。Host controller 在 takeover 取消仍在 START/tool effect 的 cue 时释放该 cue 的 started marker；重新进入后复用稳定 run ledger，旧 POSTED/未知 call 不重新 post，只产生一次受限 FAILED resume，旧 epoch ACK 永不通过。已 COMPLETED 的 cue 不释放 marker，继续由 Graph completedCueIds 和 reducer consumed 事实防止重复 TeachingMove。

**落点**

`libs/session/src/index.ts`、`libs/session/src/index.test.ts`、`apps/web/lib/coaching/coach-agent-stage3-controller.ts` 及其 Stage 3 controller 回归测试。

**验证**

Session 红测先复现“cue2 revealed 未消费后被越过”，修复后 session 12 tests 通过；Stage3 Host/controller/integration/wrap-up、bridge 与 session 定向回归 6 files / 44 tests 通过；`CI=true pnpm typecheck` 与 `CI=true pnpm build` 通过。回归覆盖未消费 cue 再次完整 outcome→pause/gate、已消费 cue 不重复教学、takeover 后旧 ACK 屏蔽及 posted-unknown call 的一次 FAILED recovery。

**限制 / 下一步**

本轮未重新跑真实浏览器自动化、完整 Cloudflare 链路或 433MB Demo；真实 Stage4 多 cue 场景仍需在同一 test_demo/Dog 路线复验截图和 console。当前修复只改变 Session reveal/consume recovery 与 Host/controller ledger，不改变 Agent Graph route 排序或默认入口。

### 4.31 2026-08-24：整场 Agent 验收必须同时证明工具价值、恢复边界和 Provider 身份

**触发**

Stage 3 的 seam 测试通过后仍有三类真实问题不会由单元测试暴露：全场重复主题引用会随 cue 数增长而超过紧凑 state 上限；用户在慢放中接管可能留下 revealed-but-unconsumed cue；本地文件中存在 DeepSeek key 也不代表手工启动的 Next 进程实际加载了它。Falcons/Spirit 的 433 MB 回放还会把浏览器 controller 生命周期和产品失败混在一起。

**决定**

SessionTheme 对 cue/round/evidence refs 使用稳定去重并分别限制为 16，完成态只保留必要摘要和最近三个 checkpoint；takeover 回到最近 cue 时撤销所有未消费 reveal，并用 effect epoch 屏蔽旧 ACK。真实 Demo 只由页面/Worker 持有，控制面逐 cue 读取摘要。localhost DeepSeek 只由 `tools/run-localhost.mjs` 显式解析 `.local-data/deepseek.env` 并注入 Next 子进程；手工 `next start` 不再被当成带 Provider 的验收方式。

**验证**

`test_demo.dem` 以 Dog 完成 14/14 cue：实际执行 3 次 `SHOW_GRENADE_TRACE`、11 次 `REPLAY_CUE_SLOW`，全部回到稳定决策画面，生成 3 个只引用已完成 cue 的全场主题，最终新标签页 console warn/error 为空。Stage 2 已单独证明 `FOCUS_MAP_EVIDENCE`。Falcons/Spirit 以 NiKo 完成首 cue smoke，并在第二次有界运行推进到 29/49；实际观察到 grenade、slow replay、map focus 和 win-rate impact，随后浏览器自动化 kernel 被 SIGKILL。按大文件基础设施“两次失败停止叠 workaround”以及发布范围收敛，不再启动第三次全场运行。

DeepSeek Policy 使用项目私密 env 启动后的同源 `/api/coaching/policy` 实测返回 HTTP 200、`SUCCEEDED/DEEPSEEK`、`deepseek-v4-flash`、629 tokens，约 1.84 秒；模型从两个合法 capability 中选择 `cap-smoke-slow`，只引用 `action-1/outcome-1`。同一旧 `next start` 进程的无泄密探针明确得到 `DEEPSEEK_API_KEY=false`，因此此前 fallback 是验收启动错误，不是用户 key 错误。

发布门禁为 66 个 Vitest 文件、423 passed、1 skipped；TypeScript、Next production build、cs2d typecheck/build、Cloudflare OpenNext build、source/bundle secret scan、363 个静态资产准备和 Wrangler dry-run 全部通过。dry-run 显示 `COACH_AGENT → CoachAgentDurableObject` binding，Worker 约 11,317 KiB、gzip 约 2,253 KiB；生产 Secret 列表只确认名称 `DEEPSEEK_API_KEY`，未读取其值。

**限制 / 下一步**

Falcons/Spirit 没有完成 49/49，真实 Demo 尚未命中 `SHOW_ECONOMY_CONTEXT`；该工具只有 fixture、Host 和 UI 回归证据。Stage 3 继续由 `?coachAgent=stage3` 显式启用，默认入口保留为快速回退。发布后仍需用轻量线上请求确认 Durable Object binding、Policy Provider 和静态 Viewer，不上传大 Demo。

### 4.32 2026-08-25：部署能力与产品默认入口是两个独立开关

**触发**

Cloudflare 已部署 Coach Agent Durable Object、Policy API 和完整 Stage 3 前端代码，但访问根路径仍需要 `?coachAgent=stage3`。Wrangler binding 和 Secret 只提供服务端能力，不能改变 React Host 中按 URL 查询参数选择运行模式的逻辑。

**决定**

Stage 3 改为 localhost 与 Cloudflare 的无参数默认入口，不增加 Cloudflare 重定向、环境变量或 `off` 回退。入口解析只有两个结果：无参数、`stage3` 或其他值都进入 Stage 3；仅 `coachAgent=stage2` 进入现有单 cue 回归 harness。Host 使用单一模式状态，避免 Stage 2/Stage 3 两个布尔状态短暂不一致。

**验证**

入口回归覆盖空查询、显式 `stage3`、不存在的 `off` 和显式 `stage2`；Host 与 Stage 3 定向回归 2 files / 20 tests、TypeScript 检查和 Next production build 通过。该变化不新增 UI、动画、Cloudflare binding 或 Provider 调用。

**限制 / 下一步**

`coachAgent=stage2` 仅保留给开发回归，不是用户产品模式。旧发布版本在新提交完成 Cloudflare 部署前仍需要显式参数。

### 4.33 2026-08-25：恢复握手必须以 saver checkpoint 为事实

**触发**

真实恢复需要在页面重新获得同一 Demo 后接回 Durable Object Agent。原 runtime 结果没有暴露 saver tuple 的最新 `checkpoint_id`，且等待工具时若只看 Host ledger，可能重复发布 effect 或错误进入替代工具路径。

**决定**

增加严格的 `RECONNECT_REPLAY` 事件：只接受 `ReplayAvailability=READY`，逐项校验 identity、graph/state/recovery 版本、RecoveryBoundary 和 saver 的精确 checkpoint id。成功的持久化工具结果只走一次 `Command({ resume })`；`POSTED/FAILED/REJECTED` 确定性收敛为 `CANCELLED`，不调用 Policy、不发新 effect、不改路线或 Session phase。重复同一已处理 event 可以带旧 checkpoint id 返回当前状态，其他旧 id 仍拒绝。

**落点**

`libs/coach-agent/src/types.ts` 暴露 reconnect/recovery boundary 与实际 `checkpointId`；`runtime.ts` 读取 saver tuple config；`graph.ts` 负责无 Policy 的 reconnect lifecycle 收敛；`recovery-contract.ts` 提供有界 schema-only Host contract。Recovery record 不承载 File、Replay、frames、模型权重、Prompt、CoT 或 Secret。

**验证**

定向 reconnect 覆盖成功 resume、POSTED/FAILED/REJECTED 收敛、duplicate event、identity/version/boundary/checkpoint mismatch、READY-only、实际 saver checkpoint id，以及从持久化完整 `AgentToolResult` ledger 无猜测构造 reconnect disposition。Recovery lifecycle contract 另覆盖 `BOOT → SESSION_STARTED → STABLE_BOUNDARY_REACHED → TOOL_LEDGER_UPDATED → RECOVERY_HANDSHAKE_COMPLETED/FAILED`，并校验 ledger observation 一致性；stable boundary 可原子携带唯一 POSTED ledger entry。Runtime 还验证了 latest 已前进时按同 thread 的精确历史 checkpoint 恢复，以及 takeover checkpoint 在合法 CUE_PAUSED/NONE 握手下零 Policy、零 effect 收敛当前 cue。完整 `libs/coach-agent` 与 Stage3 integration、typecheck、diff check 继续通过。

**限制 / 下一步**

本轮没有实现 Host Recovery Store、`libs/session` rehydrate、IndexedDB 或 Playback seek；Host 仍需在 Session seam 完成 boundary 后发送严格事件。Agent 只负责 checkpoint 侧握手，基础回放继续独立可用。

### 4.34 2026-08-25：Host Recovery Store 只保存恢复事实，不承担 Replay 或 Graph checkpoint

**触发**

Gate C 需要在刷新后发现未完成复盘，并等待用户重新选择同一 Demo；浏览器不能保存或上传 raw Replay，也不能把 IndexedDB 误当成 LangGraph saver。

**决定**

新增 `SessionRecoveryRuntime.dispatch(event)` 深 seam。原生 IndexedDB 内部负责 TTL 7 天、最多 3 条未完成记录、单条 1 MiB、原子 boundary/tool ledger 更新和 schema/plain-JSON 校验；open/transaction/blocked 失败切到当前 tab memory，并返回明确 DEGRADED/刷新不可恢复状态。`REPLAY_READY` 只接受 hash 与 player IDs；匹配后才产生 SELECT_PLAYER，分析版本匹配后才产生 rehydrate/seek/reconnect effects。

**落点**

`apps/web/lib/recovery/host-recovery-store.ts`、`session-recovery-runtime.ts`、`cs2d-session-recovery.ts`、`apps/web/components/playback/session-recovery-status.*`、`cs2d-playback-host.tsx` 与 client-safe recovery contract export。`libs/session` 是唯一 capture/rehydrate seam；Host 只执行 runtime effects。Host 把现有 iframe 文件入口带回视野，用户以 iframe 内的受信任点击选择文件；严格 `selectPlayer` bridge command 只传玩家 ID，File 不回到 Host。

**验证**

Recovery Adapter、Session、bridge、Controller、DO saver 与 reconnect 聚焦测试共 75 个通过；`CI=true pnpm typecheck`、Next production build、cs2d typecheck/build、Cloudflare OpenNext build与source/bundle secret scan 通过。覆盖 stable+POSTED 原子写入、RESULTED/RESUMED、takeover CANCELLED 收敛、历史 checkpoint 不串 cue、hash/player/route/version/tick mismatch 拒绝、DO runtime A/B 重建与一次 resume。

**限制 / 下一步**

本轮 `pnpm dev` 在 Watchpack `EMFILE` 后反复重启并最终缺少 `@swc/helpers`，因此没有运行真实 `test_demo` 第三 cue→刷新→重选→恢复 smoke，不能把它写成浏览器验收通过。该 dev/watch seam 已是第二次失败，未继续切换浏览器或服务 harness；下一次先重设 localhost watcher/harness，再执行唯一的真实恢复流程。Wrangler dry-run 另受现有 `wrangler.jsonc` 指向缺失 `.open-next/assets` 影响，OpenNext build、资产准备与 secret scan 已通过。

### 4.35 2026-08-25：Recovery Host 只在稳定边界绑定历史 checkpoint

**触发**

刷新恢复同时跨越 Host IndexedDB、iframe 播放落位和 Durable Object checkpoint；若将“最新” Agent checkpoint 绑定到下一 cue 或 wrap-up，会让 exact historical reconnect 读取到错误路线位置。

**决定**

Session capture/rehydrate 只接受 `ROUTE_START`、完成 gate 的 `CUE_PAUSED` 与 `WRAP_UP`。cs2d 在本地 hash 完成后用 `cs2d-${demoContentHash}` 作为稳定分析身份，避免同一文件重选时随机 route id 改写 Demo identity。Host Recovery Adapter 校验 hash、player、冻结 route、版本与 candidate/tick 绑定；checkpoint 仅在 Agent 的 active cue/phase/route cursor 与该 stable boundary 全部一致时持久化。`POSTED` 与 waiting checkpoint 通过一次 `STABLE_BOUNDARY_REACHED` 原子写入，`RESULTED/RESUMED` 保留结构化结果；POSTED 写入不能确认时不发送 iframe 副作用。恢复时已保存的 narration 摘要立即可用，后续只走 narration-only 队列，不重跑 Director/PlanCompiler。

**落点**

`cs2d-session-recovery.ts` 是 Host Recovery Adapter；`CoachAgentStage3Controller` 只用 `onAgentResult(event, result)` 与 tool ledger callback 暴露时机。桥接只新增严格 `selectPlayer`；文件选择继续由 iframe 内已有 input 的受信任用户点击承接，避免跨 frame `postMessage` 丢失 user activation。0004 patch 与上游 marker 同步。

**验证**

真实 `test_demo.dem` 在无 watcher 的 production harness 中完成本地解析并选择 Dog，生成 14 个 cue；会话推进到 3/14、完成教学工具后刷新，页面正确进入 DORMANT，未加载 Replay、未推进 Graph。重新选择同一文件已实际到达恢复身份校验，并暴露 cs2d 随机 `demo_id`；源头改为 `cs2d-${demoContentHash}` 后，Recovery、Session、bridge、Controller、DO saver/reconnect 的最终定向回归为 11 files / 81 tests，DO 重建相关为 3 files / 16 tests。typecheck、Next production build、cs2d typecheck/build、Cloudflare OpenNext build、364 个资产准备和 source/bundle secret scan 均通过。服务端 DeepSeek Policy smoke 实际返回 `DEEPSEEK` / `deepseek-v4-flash`，结构化 Schema 有效且未输出 Key、Prompt 或 CoT。

**限制 / 下一步**

稳定 `demo_id` 修复后的最后一次“同文件重选 → Dog / frozen route / 3/14 → `CUE_PAUSED`”没有再次自动执行：in-app Browser 无法捕获系统文件选择器，Edge 扩展未获本地文件权限，Mac 当时锁屏。没有切换第三套 harness，也没有伪称最终落位已验证；已有结构化回归证明错误 Demo/player/route/version 拒绝、pending tool 收敛和重复副作用为 0。下一次人工可操作文件选择器时只补这一条 smoke，不跑 Falcons。

### 4.36 2026-08-25：完成态 checkpoint 才能绑定 WRAP_UP 恢复边界

**触发**

Graph 完成 `COMPLETE_SESSION` 时保留最后一个 cue 的 `currentSessionPhase`，只把 `sessionStatus/runStatus` 置为 `COMPLETED`。如果 Host 仅按 phase 绑定 checkpoint，合法的 `WRAP_UP` record 会丢失 Agent checkpoint，刷新后只能降级。

**决定**

Host checkpoint metadata 显式携带 `sessionStatus`。`CUE_PAUSED` 仍要求 cue、phase、gate 与 route cursor 全部匹配；`WRAP_UP` 只接受 `sessionStatus=COMPLETED` 且 route cursor 匹配的 checkpoint。Agent reconnect 同样只接受 `sessionStatus/runStatus` 均为 `COMPLETED` 的完成态，运行中 checkpoint 不能冒充全场总结边界。

**落点**

`cs2d-session-recovery.ts` 负责 Host boundary/checkpoint 绑定，`cs2d-playback-host.tsx` 从 Agent result 和工具 transition 传递完成态元数据；`CoachAgentRuntime` 继续负责 checkpoint 内状态校验，Session reducer 的 phase 与 tick 权威不变。

**验证**

定向回归覆盖完成态 checkpoint 恢复 `WRAP_UP`、ACTIVE/错 cursor 拒绝、完成态 reconnect 零 Policy/零工具/零旧 effect，以及上一 cue checkpoint 不串线；这些用例包含在最终 81 个 Recovery/Session/bridge/Controller 测试与通过的 typecheck、生产构建中。

**限制 / 下一步**

浏览器文件选择权限仍是唯一未补的端到端证据；它不改变完成态 checkpoint 的领域约束，也不影响基础回放。

### 4.37 2026-08-25：Session Recovery 已发布并通过线上 DO / DeepSeek smoke

**触发**

Gate D 的代码、构建和服务端 Provider 已通过，但发布决定还需要确认 Cloudflare 静态入口、Durable Object binding 与线上 DeepSeek Secret 确实属于同一版本。

**决定**

将 `a8dcf9d` 推送到 `main`，只通过仓库现有 `Cloudflare production` workflow 发布；线上 smoke 只发送合成、白名单 Agent/Policy fixture，不上传 Demo、File、Replay 或真实 trace。

**落点**

GitHub Actions run `32836672732` 成功部署 Worker `cs2-ai-demo-coach`，Cloudflare version ID 为 `23a45d60-327d-492c-8161-79f8fba71ad9`。

**验证**

生产根页面与 `/cs2d/` 均返回 HTTP 200，并包含 COOP `same-origin`、COEP `require-corp`、CORP `cross-origin`。线上 Durable Object 以 HTTP 200 完成 START/interrupt、resume、重复 resume 与 COMPLETE_SESSION：backend 为 `DURABLE_OBJECT`、`recoverableAfterRefresh=true`、首次 effect 为 1、重复 effect 为 0。线上 Policy route 返回 HTTP 200、`SUCCEEDED`、provider `DEEPSEEK`、model `deepseek-v4-flash`，只选择请求内合法 capability。

**限制 / 下一步**

线上没有上传真实 Demo；稳定 Demo identity 修复后的“重新选择同一文件并回到 3/14 cue”仍等待一次可操作系统文件选择器的人工 smoke。

### 4.38 2026-08-25：乱序 cue 点播不能借用默认路线追平逻辑

**触发**

用户从默认复盘中跳到后置 cue 时，Controller 的 `queueObserversUntil` 会尝试沿默认路线补齐中间 segment；遇到尚未观看的 teaching segment 后把正常点播误判为 lifecycle degraded，并进入 `RECOVERY_REQUIRED`。

**决定**

把 `DefaultRouteCursor`、`ManualCueVisit` 和 `PresentedCue` 分开建模。Manual visit 通过独立 Session/Agent 事件引用 frozen cue，不修改默认 cursor，也不补齐前置 teaching segment；只有完整 outcome、Gate、Narration 和 Agent 收敛后才记录 Presented。默认路线以后经过 Presented cue 时保留原时间线，但以确定性事件推进，零 Narrator、Policy 和教学工具重复调用。返回默认路线时先协调 takeover checkpoint，再解除 Host guard，避免无 `resumeFromTakeover` 的 `START_CUE` 抢跑。

**落点**

`libs/session` 拥有 manual visit、默认 cursor、Gate 与 Presented 恢复；`libs/coach-agent` 拥有显式 manual/observe-presented 事件和有界状态；Stage 3 Controller/Host Adapter 负责旧 ACK、effect epoch、当前标签页工具 ledger 与 identity-only takeover；Web Host 只从 frozen plan 选择最近 cue。架构决策记录在 ADR-0005，Recovery Record 与 Session snapshot 分别升级到 v2，Agent state/graph 升级到 v3。

**验证**

固定任务 04 独立执行 9 个 Session、Controller、Host、Recovery 与 Agent 聚焦测试文件，共 98/98 通过；`pnpm typecheck`、一次 Next production build 与 `git diff --check` 通过。用例覆盖 PENDING 零调用、manual outcome/Gate、旧 ACK 失效、连续点播去重、Presented 默认经过、稳定边界恢复和返回默认顺序竞态；未运行 Falcons、cs2d/Cloudflare build 或无关全量测试。

代码提交 `8a9af92` 后，Cloudflare production run `32844999809` 在 1 分 21 秒内成功，Worker version ID 为 `dadfe351-0b47-441c-ac38-b6d08f86aadb`。线上根页面与 `/cs2d/` 均为 HTTP 200 且隔离头完整；合成 DO smoke 返回 Agent state/graph v3、`DURABLE_OBJECT`、`recoverableAfterRefresh=true`，START 产生 1 个 effect，resume、重复 resume 与 COMPLETE_SESSION 均为 HTTP 200，重复 effect 为 0。DeepSeek Policy smoke 返回 `SUCCEEDED / DEEPSEEK / deepseek-v4-flash`，只选择请求白名单内的地图 capability。请求未包含 Demo、File、Replay、Prompt 或 CoT。

**限制 / 下一步**

本轮没有用真实 Demo 做长时间浏览器点播验收。首次线上 DO 探针因本机 Node `fetch` 未走当前网络代理而连接超时，改用已连通生产的 `curl` 后一次通过；这是本地探针传输限制，不是服务端失败。未完成 manual visit 仍是瞬时状态，刷新只回到此前稳定默认边界；这是刻意的恢复语义，不是跨 Demo 历史记录。GitHub Actions 另报告 Node 20 action runtime 弃用提醒，当前由 runner 强制使用 Node 24，后续应升级 action 版本。

### 4.39 2026-08-26：Reflection Gate 让用户意图进入有界教学诊断

**触发**

固定讲解不能把未确认的玩家意图当成 Demo 事实，也需要在用户补充队友语音或战术背景时保留不可验证边界；本轮要把反思接入会话学习主线而不改变冻结路线和结果前门控。

**决定**

独立 Feature Flag 开启时，cue 只在 `OutcomeCompletionGate=COMPLETE` 后展示 Reflection Gate。用户回答先解析为 `USER` claim，不写入 Demo facts；再由确定性 Hinge 选择预绑定 Diagnostic Capability，本轮完整使用 `VERIFY_RISK_BUDGET`，`TRADE` 在没有明确覆盖事实时返回 `UNVERIFIABLE`，只有 Demo 明确记录空间/时机缺口时返回 `PARTIALLY_SUPPORTED`，不伪造 LOS/语音。远端 Graph 不接收 Host 的 rich `DecisionState`（身份、坐标、朝向等）；资源诊断使用无身份 `DecisionResources` 投影，事实数组仍是 parser-owned 的有界确定性证据（保留验证时序/动作归属字段，不由 LLM 生成）。确定性执行器生成 result，再形成 Verdict/TransferRule 并合并 session `LearningThread`。跳过或失败走 Baseline fallback；Graph 只允许经过 identity/gate 校验的首个 reflection bootstrap 和完成诊断后的连续 cue 过渡，不创建 route/tick/播放器状态；异议最多一次并降低置信度。

**落点**

`apps/web/lib/playback/cs2d-playback-host.ts` 的 `teachingDiagnosticsEnabled`（查询参数/环境变量）、`TeachingDiagnosisPanel` 与 `teaching-diagnosis-host.ts`；`libs/contracts/src/teaching-diagnosis.ts`、`libs/coach-agent/src/teaching-diagnosis.ts` 及 Graph/runtime 的诊断事件、state 和 schema；会话保存 `cueCases` 与 `learningThreads`。关闭 flag 时保留 Baseline narration 与既有 Stage 3 路径。

**验证**

已执行教学诊断、Graph、API、Host、Session、Recovery 定向测试（8 个文件、66/66），`pnpm typecheck`、`pnpm build` 和 `git diff --check` 均通过。覆盖资源投影 schema、USER claim 边界、资源诊断、TRADE 不可验证/部分支持、LearningThread 更新、Graph bootstrap/连续 cue、跳过幂等、一次异议预算、API seam、Feature Flag 解析和旧 IndexedDB 记录清理。localhost 浏览器用 `demoTests/test_demo.dem` 完成了上传 → 选 Dog → 路线准备 → Reflection Gate → 选择“给队友补枪” → 诊断结论 → 异议“有队友语音”改判 → 继续 → 下一 cue → 跳过并回到 Baseline 的 smoke；提交后约 1.2 秒出现“诊断完成”，该流程无新的控制台错误。

**限制 / 下一步**

本轮只做了一个 9 回合小 Demo 的短浏览器 smoke，没有声称完成整场长时间验收；真实语音、逐玩家 LOS、阻挡和精确接触窗口仍不可验证。另修复了旧恢复记录在 IDB request 回调中抛错导致的开发态 issue overlay，以及手动 cue visit 下提交反思被 takeover guard 静默丢弃的问题。push 后 Cloudflare Actions `32978616087` 成功部署 Worker，线上首页 HTTP 200、`/api/coaching/diagnose` POST 返回 `SUCCEEDED`，`/api/coaching/agent` 的 Reflection smoke 返回 `CUE_COMPLETED`、`DURABLE_OBJECT` 且 `recoverableAfterRefresh=true`；线上 IAB 页面加载超过 30 秒，未将其记作浏览器通过，curl/API 结果是当前可复核证据。

### 4.40 2026-08-28：OpenNext trace 需保留 pg-cloudflare 的 workerd 包

**触发**

Cloudflare OpenNext 在 server bundle 阶段解析 `pg@8.16.3` 的可选 `pg-cloudflare` 失败。锁文件中依赖存在，但 Next trace 只复制了 `dist/empty.js`；`pg-cloudflare` 的 `workerd.require` 导出声明的 `dist/index.js` 因而找不到。

**决定**

在 `apps/web/next.config.ts` 将 `pg-cloudflare` 列入 `serverExternalPackages`，让 OpenNext 的 workerd package copy 阶段保留完整 `dist/` 和 workerd 导出。继续复用 `libs/memory-postgres` 的动态 `pg` driver seam，不把 `pg-cloudflare` 当作独立 PostgreSQL 连接实现。

**落点**

仅修改 Web 的 OpenNext/Next 打包配置；未改变 memory domain、schema、repository、DO 或 Worker 行为。

**验证**

首轮 `pnpm cloudflare:build` 在上述解析错误处失败；配置 smoke、frozen lockfile 检查、第二轮 `pnpm cloudflare:build`（含 OpenNext bundle 与 source/bundle secret scan）通过。`libs/memory-postgres` migrations/repository/server 定向测试 15/15、`pnpm typecheck` 和 `pnpm build` 均通过。

**限制 / 下一步**

构建只证明 `dist/index.js` 与 `cloudflare:sockets` 已进入 bundle，尚未证明真实 Cloudflare Worker 的 Hyperdrive binding、Secret 与 PostgreSQL 网络连通性；生产环境仍需一次不带本地凭据的 Hyperdrive runtime smoke。

### 4.41 2026-08-28：长期记忆收口必须把授权、删除和教学提示当作同一条链路

**触发**

针对长期记忆第一版的回放、授权、Outbox、PostgreSQL 和管理面审查发现了几类容易被 happy path 掩盖的问题：重复请求只改变 producer timestamp 却被误判为冲突；墓碑提交后 host/DO fan-out 失败会留下旧 Brief 缓存；已脱敏的删除事件不能再用原始 payload 重放；`DISPUTED` 纠正会在结构化 active 查询中被挤掉；feature flag 关闭时仍可能写 refresh marker，且关闭后错误设置 revoked latch 会阻止同一 DO 在重新开启时恢复既有授权；Outbox 首次投影成功但响应丢失时，consumer 的幂等拒绝还会被误判为失败；以及只把 Brief 放进 PolicyInput 并不会让下一 cue 产生明确的迁移复查模式。

**决定**

保留 PostgreSQL 为长期记忆真相源、Durable Object 为 Session checkpoint＋可靠 Outbox、pgvector 为可选派生索引。服务层使用 canonical event 比较（忽略 envelope/Proposal 的 producer 时间和重试元数据，但仍拒绝 payload、目标和身份冲突），删除在墓碑提交后立即 bump Brief generation，并在首次 fan-out 失败时允许重复 DELETE/`MEMORY_DELETED` 只做清理重试而不重新写入正文。结构化 recall 为 active memories 单独使用状态白名单，同时开一个有界 `DISPUTED` correction channel。Graph 从已验证 Brief 派生 `memoryPedagogyMode`：thread→`CHECK_TRANSFER`、correction→`REINFORCE`，但永远服从当前 cue 的 Outcome Gate 和证据状态。Outbox/consumer 对 `DUPLICATE_IDEMPOTENCY`、`DELETED_TOMBSTONE` 和已存在的删除 tombstone 视为终态收敛，真正的 repository/persistence error 仍按失败重试。flag-off 只清进程内上下文，不写持久 refresh marker，也不把部署开关本身当作用户撤回；因此 feature-off 清理使用 `latch:false`，保留旧 GRANTED consent 在同一 DO 重新开启时可恢复。localhost 的延迟 Memory 写入按 principal 串行，保证诊断事件先于同一用户的纠正事件落地。

**落点**

主要落在 `libs/memory` 的 service、InMemory adapter、Brief 和 preference/event schema，`libs/memory-postgres` 的事务锁、删除 marker、可选 vector probe、redaction 和 session enumeration，`tools/memory-outbox.mjs`、`tools/coach-agent-durable-object.mjs`、Cloudflare Worker 的授权/签名/invalidation seam，`apps/web` 的 consent、memory management、local Agent dispatch，以及 `libs/contracts`/`libs/coach-agent` 的受限教学模式字段。对应长期契约同步到 `ARCHITECTURE.md` 和 ADR-0006。

**验证**

最终收口的本地全套 Vitest 为 **93 个文件、666 个测试通过，1 个文件跳过、2 个测试跳过**；定向记忆/PG/DO/API/Graph 回归也全部通过。`pnpm typecheck`、`pnpm build`、Cloudflare OpenNext build（含 source/bundle secret scan）、`node --check tools/cloudflare-worker.mjs`、`node --check tools/coach-agent-durable-object.mjs` 和 `git diff --check` 均已运行并通过。仓库没有 `lint` script，`pnpm lint` 因命令不存在退出，不能报告 lint 已通过。新增回归覆盖 timestamp-only idempotency、删除缓存/host 重试、direct delete redaction、flag-off storage no-write 与 off→on 授权恢复、幂等 consumer→Outbox 收敛、Brief→`CHECK_TRANSFER`/`REINFORCE` 和 stale sink race。

**限制 / 下一步**

本轮没有运行 live PostgreSQL、Cloudflare Durable Object/Worker、Hyperdrive 或真实 embedding provider；`postgres.real.test.ts` 仍按环境变量跳过，因此跨 Demo 链路目前是 InMemory＋fake sink 的 contract E2E，不应称为真实部署验收。未知且从未写入 PostgreSQL 的 DO session 仍只能依赖实时 authority 的 fail-closed 防线；合法 future-clock event 尚未由独立 deletion generation 证明；PostgreSQL `RETRY→DEAD_LETTER` 需要外部 consumer/retention job；授权读取与外部 provider/dispatch 之间仍有极窄的跨系统 TOCTOU 窗口。生产发布前应在带真实凭据的隔离环境补跑这些链路，并确认 lint 工具可用后再执行 lint。

### 4.42 2026-08-28：明确资料切片与 Outbox 授权拒绝必须在 Agent 边界外收敛

**触发**

长期记忆已经有偏好、候选习惯和纠正链路，但“用户明确填写的资料”仍容易被误当作 cue proposal；同时，Outbox 在 consent 被撤回、authority 暂时不可用或 sink 返回 HTTP 200/`accepted:false` 时，若只看 transport 状态，就可能错误投递、保留原文或把拒绝误记为成功。授权队列与 Outbox flush 互相等待还会形成 auth↔Outbox deadlock。

**决定**

新增 bounded `MemoryProfile`（最多 8 个 `string | number | boolean` 字段）和 `USER_PROFILE_STATED` 事件；`PROFILE` proposal/record 只能由签名 anonymous principal 在 consent gate 后写入，首次资料立即 `CONFIRMED`，canonical 快照重复请求幂等，管理面通过 `/api/memory/profile` 读取/更新。资料保留在用户管理/User brief 供查看，但 `buildAgentMemoryBrief` 完全排除 `PROFILE` record，不把资料元数据或值送入 Agent。

Outbox 在发送前复核实时 consent authority：authority outage 返回 fail-closed 并保留 `PENDING` 以待后续 alarm；明确的 `CONSENT_REQUIRED`、`MEMORY_DISABLED`、版本过期或 `CONSENT_REVOKED` 终止投递、脱敏事件 payload 并进入 `DEAD_LETTER`。HTTP 200 但 `accepted:false` 仍按领域拒绝处理，只有明确幂等收敛才标记 `DELIVERED`。授权串行尾只排队 Outbox invalidation，flush 内的 veto 只终止当前行并异步安排剩余清理，避免等待对方队列造成 deadlock；authority outage 同时清除本地 Brief，不能把旧上下文送入 Agent。

**落点**

资料切片落在 `libs/memory` 的 `MemoryProfileSchema`、`USER_PROFILE_STATED` proposal/policy/reducer/service、`/api/memory/profile` 和 `MemoryManager`；Agent 投影边界落在 `libs/memory/src/brief.ts`。Outbox 授权拒绝、payload redaction、before-send authority gate 与 serialized invalidation 落在 `tools/memory-outbox.mjs`、`tools/coach-agent-durable-object.mjs`，服务端 consent/签名/invalidation seam 与 `libs/memory-postgres` authority transaction 共同 fail-closed。

**验证**

当前全套 Vitest：**94 个文件通过、1 个文件跳过；689 个测试通过、2 个测试跳过**（`pnpm exec vitest run --reporter=dot`）。覆盖 PROFILE service/API 管理与 Agent projection 排除、feature-off 无持久化读取、principal/query 隔离、Outbox consent rejection redaction、authority outage pending、HTTP 200 domain rejection、幂等收敛和 auth↔Outbox 串行化。`pnpm typecheck` 已通过；此前的 `pnpm build`、Cloudflare OpenNext build、source/bundle secret scan 和 `git diff --check` 仍保留在 4.41 验证记录中。

**限制 / 下一步**

本轮仍未运行 live PostgreSQL、Cloudflare Durable Object/Worker、Hyperdrive 或真实 embedding/provider；`postgres.real.test.ts` 因环境变量缺失跳过，不能把 InMemory＋fake sink contract E2E 称为真实部署验收。仓库没有 `lint` script，`pnpm lint` 无法执行，不能报告 lint 通过。未知且从未写入 PostgreSQL 的 DO session 仍依赖实时 authority 的 fail-closed 防线；跨独立 Node/DO 系统仍存在极窄 TOCTOU 窗口，生产前需在隔离真实凭据环境补跑。

### 4.43 2026-08-30：localhost 启动必须把可选基础设施与受管进程生命周期同时收口

**触发**

长期记忆的 domain/API/UI 已存在，但 localhost 启动器只允许 DeepSeek 变量，无法通过受控的 `.local-data/deepseek.env` 启用 Memory；`MEMORY_ENABLED` 没有显式安全默认，文件值还会覆盖命令行变量。同时，原启动器在 `3000`/`5174` 冲突前没有统一预检，退出时只向 `pnpm` 直系子进程发送一次信号，可能遗留 Next/Vite 后代。README 又把 Cloudflare 部署写得像当前交付前置，与本轮 localhost-only 目标不一致。

**决定**

`pnpm dev` 在没有显式变量时固定以 `MEMORY_ENABLED=false` 启动；新增跨平台 `pnpm dev:memory`，通过启动器 `--memory` 参数提供默认 true，而不使用 POSIX shell 前缀。shell 显式值优先于本地文件，两者中任一显式 `false` 都不会被 `--memory` 反转。无 DB 时复用现有 `getMemoryRuntime` 的 `IN_MEMORY` 适配器并明确报告“进程内、重启清空”；有 `MEMORY_DATABASE_URL`/`DATABASE_URL` 时仍走唯一 PostgreSQL adapter，embedding 继续可选。Migration CLI 提供 `--dry-run` 和 `--check-config` 两个不连库的预检面。

启动器在任何准备或子进程启动前同时检查两个端口，冲突时只返回可诊断错误，不动旧进程。Unix 上为自己创建的两个服务建独立进程组，正常退出先 `SIGTERM`、超时再 `SIGKILL`；任一服务异常退出都会收敛另一个。当时把运行与验收基线收口为 localhost 模块化单体，并把桌面容器选型后置；该桌面决定已由 4.45 与 ADR-0007 取代，localhost 进程生命周期证据本身继续有效。

**落点**

启动契约落在 `tools/run-localhost.mjs`、`package.json`、`deepseek.env.example` 及定向回归测试；用户命令、Memory migration 预检和 Cloudflare 的可选定位写入 `README.md`。localhost/桌面壳的模块边界、技术选型后置以及 raw Demo/单次解析/Outcome Gate 不变式写入 `ARCHITECTURE.md`。

**验证**

`node --check tools/run-localhost.mjs` 通过；localhost 启动与旧 cs2d patch seam 定向 Vitest 为 **2 个文件、12 个测试全部通过**。真实 `pnpm dev` 和 `pnpm dev:memory` smoke 均启动 `localhost:3000` 与 `localhost:5174`；首页与 cs2d Viewer 均返回 HTTP 200，首页 iframe 指向并加载 `:5174` Viewer。默认路径的 `/api/memory/status` 返回 `featureFlag=false`；`dev:memory` 返回 `featureFlag=true`、`storage=IN_MEMORY`、`durable=false` 和 `LOCAL_IN_MEMORY_STORAGE`，Memory consent 与 profile 的 POST/GET 链路均完成 HTTP 200 smoke。已配置 DeepSeek 的 models 连通检查返回 HTTP 200，输出中没有凭据。

端口冲突 smoke 证明：旧 listener 占用目标端口时，新启动器在创建任何服务前失败，旧 listener 仍存活。正常 `Ctrl-C` 后复查 `3000`/`5174` 均已释放，没有遗留本轮 Next/Vite 进程。

**限制 / 下一步**

当前环境没有提供 `MEMORY_DATABASE_URL` 或 `DATABASE_URL`，因此没有运行真实 PostgreSQL migration、持久化 consent/profile 或重启恢复；上述 Memory HTTP smoke 只证明 InMemory 垂直链路，不能称为长期持久化验收。也未运行真实 embedding provider、Cloudflare/Hyperdrive/DO 或桌面壳；桌面容器仍需在权限、进程生命周期、签名更新和可测量包体证据就绪后用独立 ADR 选型。

### 4.44 2026-08-30：localhost 长期记忆必须用真实重启证明“持久”

**触发**

4.43 只验证了 `IN_MEMORY` 垂直链路，它能证明 consent/profile API 和本地启动契约可用，但不能证明 migration 能在真实 PostgreSQL 执行、跨 Demo 记忆能从新 Session 召回，也不能证明用户资料在应用完整停止后仍存在。把 `storage=IN_MEMORY` 的 HTTP 200 写成“长期记忆已就绪”会混淆功能可用与持久性两个不同结论。

真库验收还暴露了三个被 fake adapter 遮住的具体问题。第一，real test 最初从脱离工作区模块解析位置的 seam 执行 `dynamic import("pg")`，失败反映的是测试 harness 与生产驱动路径不一致，不是 PostgreSQL 连通性失败。第二，PROFILE 管理 proposal schema 把“必须有 profile”错误施加到所有 operation，因而拦住不应携带资料正文的 DELETE。第三，service delete 在 tombstone 已提交后运行 `purgeMemoryResidue`，却把合法 `sourceRefs` 顶层数组直接交给只接收 object 的持久化 payload guard；真实 HTTP 因此表现为删除墓碑已落库，但请求返回 503。

**决定**

使用 macOS Homebrew 的 `postgresql@17` 作为 localhost 单机真相源，由 `brew services` 管理数据库生命周期，并把项目数据限定在显式数据库 `cs_agent_local`。应用继续通过已忽略提交的 `.local-data/deepseek.env` 读取 `MEMORY_DATABASE_URL`、功能开关和稳定匿名 principal 签名配置；凭据值不进入 Git、文档或验证输出。

先执行 core migration，再执行可选 vector migration；`memory_schema_migrations` 是已应用版本的可审计 ledger，pgvector 仍只是可重建的派生索引能力。localhost 持久性的验收标准不是“进程返回 200”，而是：同一签名匿名 principal 完成 consent 与 profile 写入，完整停止并重启应用后，仍能从 PostgreSQL 读回同一 profile，且 status 明确为 `POSTGRES`/durable。

Real tests 不再建第二套 `pg` 加载路径，改为复用生产 `createNodePostgresPool`，使测试与真实 runtime 共用连接配置、驱动解析和关闭语义。PROFILE proposal 的约束收紧到精确 operation：只有 `CREATE`/`UPDATE` 必须携带 profile，`DELETE` 仍使用不带资料正文的 tombstone 语义。`purgeMemoryResidue` 改为向原 object-only guard 传入 `{ sourceRefs }`，仅修正调用形状；没有放宽通用 persisted payload 必须为 object、不得携带 raw artifact 的边界。

**落点**

运行环境落在 Homebrew PostgreSQL service、`cs_agent_local` 和已忽略的本地 env 文件；核心结构仍由 `libs/memory-postgres` 的同一 migration/repository 边界创建和访问，没有新增第二套本地 store。`README.md` 只补充安装、建库、migration、启停、状态与故障检查命令；长期模块、权威与隐私契约仍以 `ARCHITECTURE.md` 为唯一事实源。

最终修复分别落在 real PostgreSQL 测试的生产 pool factory seam、PROFILE 管理 proposal 的 operation-aware schema，以及 Memory Service 删除后清理的 payload guard 调用点。这三处都复用原模块，没有新增 PostgreSQL adapter、宽松 payload schema 或绕过 tombstone 的特殊 API。

**验证**

Homebrew PostgreSQL **17.11** 以 service 形式运行，`cs_agent_local` 连接成功。真实 migration ledger 包含 `memory-core-001`、`memory-core-003` 和 `memory-vector-002`，数据库中 pgvector extension 版本为 **0.8.6**。以 `RUN_POSTGRES_TESTS=1` 启用的真实 migration/cross-Demo suites 为 **3/3 通过**：覆盖空 schema 的 core migration，已记录 `core-001` 的 legacy schema 升级与幂等重跑，以及两个不同 Demo hash 从 `CANDIDATE` 晋级 active memory、新 `MemoryService` 实例召回的完整链路。测试使用隔离 schema 或随机测试 principal，并在结束时清理自己的数据。

真实 localhost 应用完成 consent 和 profile 写入后，`/api/memory/status` 报告 `storage=POSTGRES` 且 `durable=true`。完整停止并重启应用后，使用同一签名匿名 principal 再次读取 profile，内容仍存在，证明它来自 PostgreSQL 而非旧 Node 进程内存。本轮所有输出只记录版本、migration ID、HTTP/存储状态与测试计数，未记录连接凭据、API key 或签名密钥。

修复后使用一个全新签名匿名 principal 重跑真实 PostgreSQL HTTP 链路：consent 写入成功，profile POST/GET 成功，DELETE 返回 HTTP 200，随后 profile 为 `null`。数据库复查显示该 smoke 数据只留下不含资料正文的脱敏 tombstone，active records 为 **0**；因此这次不再把“墓碑已提交但清理返回 503”误记为删除未发生，也不把 503 接口状态接受为正常成功。

最终全量 Vitest 执行 **96 files**，**715 passed**、**4 skipped**；其中显式启用真库的 PostgreSQL suites 为 **2 files / 3 passed**。`pnpm typecheck` 与 `pnpm build` 均通过。这些结果与上述真实 HTTP 重跑一起构成本轮 localhost PostgreSQL 收口证据，但不代表未运行的外部系统。

**限制 / 下一步**

本轮只验证 macOS 单机 Homebrew PostgreSQL，不包含 Cloudflare、Hyperdrive、Durable Object 或远程数据库，也不把 localhost 结果外推为云部署结论。pgvector extension 和 vector migration 已就绪，但没有配置或验证真实 embedding provider，因此本轮语义召回仍不是验收项。Homebrew service 的备份、升级和本机凭据轮换仍由操作者管理；项目不自动 drop/reset 任何本地数据库。

### 4.45 2026-08-30：冻结 local-first Tauri 桌面架构，但不冒充实现完成

> 历史说明：本节记录 5.0.0 冻结当日的状态；其中双 IPv4 loopback 与“尚未实现”结论已由 4.46、ADR-0008 与 ARCHITECTURE 5.1.0 取代，不是当前架构事实。ADR-0007 同样保留这段冻结历史，不能被当作当前实现快照。

**触发**

4.1.1 只确认 localhost 模块化单体适合被桌面壳监督，却仍把容器选型、桌面 Memory 真相和 Agent checkpoint 留在“后续/云端默认”状态。若直接开始实现，最容易出现四种结构性错误：在 Rust/Tauri 内复制 Parser/Session/Memory；让桌面仍依赖 Cloudflare、Durable Object 或 PostgreSQL；把 raw Demo path/bytes 从 File/Worker seam 搬进高权限宿主；或直接调用缺少 restore 保证的 updater install 并把失败变成不可恢复覆盖。

**决定**

通过 [ADR-0007](./adr/ADR-0007-local-first-tauri-desktop.md) 冻结 Apple Silicon `aarch64` 首发：Tauri `2.11.5` 只监督一个自包含 desktop runtime sidecar，sidecar 打包 pinned Node `24.19.0` 与 Next standalone traced resources，并在同一进程中持有两个 OS 分配的 `127.0.0.1:0` 端口（Next UI/API 与独立 cs2d Viewer）。不用 `localhost` hostname、LAN、通配监听或 grandchildren。Next UI/Route Handler、cs2d File → Worker/WASM、Playback bridge、Outcome Gate、完整时间线和 observable-state 证据边界全部复用；raw Demo/Replay 不跨 iframe。

supervision 使用 stdin init 与 token admin transport 的严格版本 envelope。nonce/token 不进入 argv、environment、disk、log 或 WebView；Keychain generic password secret 只经 Rust → sidecar 内存。后续 Review History 修订仅给 main coaching remote origin 增加 `open_settings` 窄导航 capability；bundled bootstrap/settings/update window 只有 AppManifest allowlist 中的窄 `status/set/delete` 等命令，所有窗口仍不提供 broad shell/fs/http/process/dialog/opener，Secret 永不 `get`。Demo 继续由 WKWebView 原生 HTML File chooser 选择，路径/bytes 不跨 Rust。

Application Support SQLite 成为桌面 Memory 真相，并以不同表/Adapter 同时承载 preferences、consent、events/revisions/tombstones/evidence/Float32 embeddings 与 LangGraph checkpoint。`memory-sqlite` 实现既有 `MemoryRepository`/`AuthorizationStore`，checkpoint saver 独立实现 `BaseCheckpointSaver`；Memory Domain 与 Session/Agent 不合并。SQLite 固定 WAL、foreign keys、FULL synchronous、busy timeout、checksummed migrations、single writer；embedding 只做 bounded exact cosine，首发不加载 `sqlite-vec`。IndexedDB 仍只保存 Host Recovery，恢复与 SQLite checkpoint 精确双状态握手。Web 的 Cloudflare/DO/PostgreSQL Adapter 和历史保留，但退出桌面默认；`MemoryWritePolicy`、跨 Demo 晋级、consent、revision、tombstone 和 late-event 防复活不变。

Updater 只用官方 Tauri Updater 完成 HTTPS check/download、minisign、`latest.json` 和 SemVer；启动异步检查并 24 小时频控，下载与安装分别确认，活跃工作受 busy gate。因 plugin `2.10` 的 macOS install 缺少 restore 保证，不调用破坏性官方 install；改为验签后在同卷 staging 校验签名并用 `renamex_np(RENAME_SWAP)` 原子交换。原子能力、权限或签名任一不足时保持当前 app，降级打开 DMG。数据库升级前 backup + integrity，新版本 health 成功后才清旧 bundle。

**落点**

长期契约更新到 `ARCHITECTURE.md` 5.0.0；不可逆取舍和被取代的桌面解释写入 ADR-0007。本阶段没有修改生产代码、PRD、MVP_SCOPE 或 README。版本唯一源冻结为 `apps/desktop/package.json`，tag 为 `desktop-vX.Y.Z`，发布资产为 `dmg`、`app.tar.gz`、`.sig`、`latest.json`、`SHA256SUMS`。正式发布必须通过 `distribution:audit`；当前 cs2d 无 LICENSE，Valve 资源为 `LOCALHOST_ONLY/REVIEW_REQUIRED`，因此只允许本机/internal RC，公开 workflow 保持 blocked。没有 Apple Developer 凭据时只能称 ad-hoc、未公证构建。

**验证**

本阶段开始前工作树为 clean。沿用并明确记录上一轮已完成的实现基线：`pnpm typecheck` 通过；Vitest 为 **96 个文件通过、2 个文件跳过，715 个测试通过、4 个测试跳过**；Next production build 通过。另做的 in-memory browser bundle probe 成功，证明把紧凑前端 bundle 放进 WebView 在技术上可行；最终仍选择 Next standalone sidecar，因为它能直接复用 Route Handler、服务端 Provider/Memory interface、traced resources 和现有 localhost 运行语义，interface 更小且 module depth/locality 更好。

本次文档检查使用冲突 `rg`、`apply_patch`、二次冲突 `rg`、Markdown heading/fence 检查和 `git diff --check`。没有运行新的产品测试或构建，也没有把上述历史基线重新表述为 Tauri/SQLite/updater 验收。

**限制 / 下一步**

Tauri 宿主、pinned Node/Next sidecar 打包、双 loopback origin、`memory-sqlite`、SQLite saver、Keychain、AppManifest capability、日志权限/轮转、updater 原子交换与 rollback 都尚未实现。Updater 仍需安全评审、故障注入和真实同卷 `RENAME_SWAP` 验证；Xcode/Apple Developer 签名/notarization 凭据未验证。cs2d 许可证与 Valve 资源权利仍阻止公开发行。下一阶段只能逐 gate 实现并分别报告结果，不能以 localhost、in-memory probe 或文档冻结替代桌面验证。

### 4.46 2026-08-31：桌面实现完成后，用户文档必须从 localhost 叙事迁移到 distribution truth

**触发**

桌面壳、sidecar、SQLite、Keychain 和 updater/rollback 已从 ADR 目标进入实现，但 README 仍把 localhost、系统 Node/pnpm、PostgreSQL 和 Cloudflare 写成普通用户主路径；ARCH/ADR 仍保留两个 `127.0.0.1`、token 完全不进 WebView、桌面 principal 由 Keychain 支撑和“全部尚未实现”等冻结期文字。另一方面，release workflow 的完整性容易被误读成已有公开下载，忽略 rights JSON=false、第三方 notices、updater placeholder 公钥和缺少 rights-approved Developer ID/notary 资产的事实。

**决定**

把 Desktop 明确为主产品，并将普通用户的目标安装流与当前可执行状态分开：目标 DMG 自包含 Node `24.19.0`、Next/Viewer/WASM 和 SQLite，不要求系统开发工具或云基础设施；当前只允许本地/internal ad-hoc RC，public Release 继续 fail closed。Cloudflare/PostgreSQL 退到开发兼容附录。

架构边界对齐实现：App host 为随机 `127.0.0.1`，Viewer host 为随机 `[::1]`；session token 由 Rust 写入 HttpOnly/Strict cookie store，进入 WKWebView cookie store但不进入 URL/JS；admin token不进入 WebView。Node 使用精确 FS permission、`--jitless` 和 child deny。桌面 Memory principal 是 sidecar session-cookie保护下的稳定非 secret ID；Keychain 只保存 Provider key。Updater 文档区分“代码/测试已实现”与“正式公钥、Developer ID、notarization、rights-approved public asset 尚未验证”。

**落点**

README 改为用户优先的 Desktop 文档，补充数据路径、卸载、Keychain、更新模型、ad-hoc/Gatekeeper 边界和开发命令。新增贡献、安全、CHANGELOG、Bug/Feature Issue 与 PR 模板，统一禁止自动附带 Demo、DB/backup、日志、secret/token 和用户 Memory。发布 Runbook 与 distribution audit 文档记录真实 Gate。`ARCHITECTURE.md` 升至 5.1.0；ADR-0007 保留冻结历史，具体实施偏差由后续 ADR-0008 记录。PRD/MVP_SCOPE、代码、manifest、workflow、rights JSON 和 notices 保持不变。

**验证**

本轮是文档与只读一致性审计，没有运行构建、产品测试或浏览器。验证只包括：对 package scripts、Tauri/runtime/updater/provider/supervisor、SQLite backup/export/delete、release workflow/audit 与 rights records 的只读映射；Markdown heading/fence、相对链接、Issue YAML、workflow YAML/JSON 基本解析；冲突措辞 `rg`；`git diff --check`。这些检查不能替代既有模块测试，也不能证明正式 updater/Public Release 通过。

**限制 / 下一步**

公开发行仍受 cs2d/Valve rights、正式 updater 公钥、Developer ID/notarization 和 protected environment 实际凭据阻塞。只有上述外部事项形成可审查 evidence，并由 workflow 对同一不可变 tag 完成签名、staple、公钥反验和固定资产发布，README 才能改成公开下载说明。local/internal ad-hoc 构建不得被用来缩短该 Gate。

### 4.47 2026-08-31：桌面安全边界必须以运行时注入、静止点和可审计资源描述

**触发**

实现收口后仍有六类文档漂移风险：把浏览器自报 `Origin` 当成桌面信任；把“收到 backup 请求”误写成 Next 响应已经静止；让 Desktop 删除继续依赖 Cloudflare invalidation；把本地 feature hash 称为神经语义模型；只验证 Node binary 而漏掉随包许可；以及把 CI signature verifier 或较早 bundle 误认为最终 App 已通过。ADR-0007 是实现前冻结历史，若原地改写会同时失去决策上下文并制造“未实现/已实现”自相矛盾。

**决定**

新增 [ADR-0008](./adr/ADR-0008-desktop-runtime-implementation-amendments.md) 部分取代 ADR-0007 的具体实现细节，ADR-0007 保持 Accepted 历史。当前 Desktop App 使用 `127.0.0.1`，Viewer 使用 `[::1]`；protected sidecar 在严格 Host＋唯一 43 字符 session cookie 后覆盖注入 `x-cs-agent-app-origin`，所有 coaching 与 Memory mutating routes 共用 trusted-origin helper。iframe 只携带编码后的精确 `parentOrigin`，不携带 token。

Updater backup 先切换到 `DRAINING`，拒绝新 Next 请求，等待 handler 与 response 两部分 active 状态都完成后才 drain SQLite writer/checkpoint 并备份。该计数只覆盖 Next/API 活动；iframe parser 是纯本地计算，不产生 server write。关闭主窗口只隐藏并继续保持 busy；只有 Settings 的“结束当前复盘”成功导航 bundled maintenance page 后才设置 `review_ended`，“稍后”或关闭 Settings 会恢复复盘。Desktop 删除使用 local no-op invalidator，由 SQLite single-writer、tombstone、deletion marker 与 residue purge 收敛；Web/Cloudflare 的严格 notification/invalidation 不变。

默认桌面向量 provider 固定为 `local-unicode-feature-hash/1.0.0`，用 256 维 Unicode 1–3 gram Float32 feature hash 做有界 exact cosine。它是词法相似度补充，不是 neural embedding；结构化召回优先。固定 Node `24.19.0` tar 同时提取完整 `LICENSE`，manifest 记录 license SHA，bundle audit 复核；精确 repo build-root 只做等长清理，上游 binary 自带 `/Users/runner` 不误报。CI updater verifier 通过 Cargo feature gate 单独构建，禁止进入 App。DMG fallback 只一键打开由版本构造并再次校验的固定 GitHub asset URL；release workflow 把 tag、精确 commit、`HEAD` 与 `CS_AGENT_BUILD_SHA` 固定为同一发布身份。

**落点**

长期事实更新到 `ARCHITECTURE.md` 5.1.0 和 ADR-0008；README、SECURITY、CHANGELOG、Desktop Release Runbook 与 Distribution Audit 同步用户可见边界和发布限制。ADR-0007 与本日志 4.45 保留实现前历史，不承担当前架构真相。

**验证**

实现证据来自两次真实 protected-sidecar smoke：consent、export、跨进程 persistence 与 delete 均 PASS，测试数据和进程已清理；相关 Host/cookie/trusted-origin、Viewer origin、route mutation gate、local invalidator、feature hash、Node license manifest、backup quiescence、updater rollback 和 verifier feature gate 另有单元/fixture/audit 检查。本次记录只做代码与文档只读映射、Markdown/YAML/JSON/链接/围栏和 `git diff --check`，没有重跑构建、浏览器或产品测试。

**限制 / 下一步**

这些 smoke 证明 protected runtime 的本地边界，不单独证明最终 App 或 public distribution；后续最终 App/DMG 的重建、bundle 与 GUI 证据记录在 4.48。公开发行继续受 cs2d/Valve rights、正式 updater 公钥、Developer ID/notarization 与 rights-approved 最终资产阻塞。词法 feature hash 不具备神经语义召回能力，文档和 UI 都不得暗示相反结论。

### 4.48 2026-08-31：桌面 readiness 必须覆盖浏览器真实资产、hydration 与 iframe，而不只是 HTML 200

**触发**

最终 `.app` 首轮 GUI 能到达 `/desktop`，但页面没有样式、Viewer 停在 `about:blank`。原有真实 sidecar smoke 只验证 SSR Route 200、Viewer 根文档 200 和 CSP header，因此把“服务启动”误当成“产品可交互”。补齐 CSS/JavaScript 检查后首先发现 `/_next/static` 为 404；修复后 CSS 恢复，但 Web Inspector 又显示 Viewer build 引用的 `/cs2d/assets/*` 在 Desktop root handler 下 404、SSR iframe 使用占位 App port、Google Fonts 仍尝试外网，以及 style nonce 与 `unsafe-inline` 在 WebKit 下不能承担原注释所声称的兼容语义。

Distribution audit 同时发现 Next 随包 docs 中存在示例 `BEGIN RSA PRIVATE KEY` 文本。它不是真实密钥，但不属于运行时资源并会让私密材料 Gate 失去区分力；不能通过放宽扫描解决。

**决定**

Desktop runtime 改用 Next custom-server handler，保留严格 Host/cookie/header 包装；不再直接使用只覆盖内部渲染的 `NextServer`。真实 smoke 解析 SSR HTML，验证每个 Next CSS/JavaScript 的 200、MIME、非空内容和 CSP nonce，并验证 iframe 的 Viewer origin、`host=1` 与精确 App `parentOrigin`。

Viewer static handler 在 URL decode 与 `..`/escape 拒绝后，只把精确 `/cs2d/` 前缀映射回同一 Viewer root，使 Cloudflare 与 Desktop 复用同一受控产物。Desktop page 从 runtime 注入 header 取得可信 App origin并同时用于 SSR/client prop，消除占位 port hydration 差异。App CSP 使用 same-origin＋nonce script、same-origin＋inline style、`frame-src http:`；frame scheme 兼容必须与 Rust readiness 派生的 exact App/Viewer navigation allow-list、Viewer exact `frame-ancestors` 同时成立。构建后删除 Viewer 的远程字体 links。准备器排除 dependency `docs/`，但继续从 pinned Node tar 单独带入完整 LICENSE。

**落点**

变化落在 `desktop-runtime` 的 Next/Viewer/security seam、Tauri supervisor navigation gate、Desktop page 与 `Cs2dPlaybackHost` 的 exact parent-origin prop、cs2d Viewer HTML sanitizer、prepared resource filter，以及真实 sidecar smoke。没有把 Parser、Session、Memory 或 Demo bytes 搬入 Rust；raw Demo 仍只属于 iframe Worker。

**验证**

Web Inspector 明确复现并分类了五条浏览器错误。最终回归为 Vitest **109 files passed / 2 skipped、763 tests passed / 4 skipped**，desktop runtime **8/8**、runtime prepare/bootstrap **14/14**、stub sidecar **1/1**、Rust **35/35**，`pnpm typecheck`、普通 Next production build与 Desktop webpack production build均通过。`pnpm desktop:dev` 实际完成 prepare、Rust dev build并启动 Tauri 主进程和唯一 sidecar，随后中断开发命令并确认两者均清理。增强后的 prepared 与最终 bundled real-sidecar 双启动 smoke 均 PASS：逐一检查首屏 SSR 已进入“请选择本地 Demo”且没有残留“正在连接本地回放”、Next CSS/JS、精确 iframe query、全部 `/cs2d/assets` HEAD、Viewer、SQLite consent/export/delete/persistence、backup、route gate 与 graceful shutdown；资源产物不再含 Google Fonts link 或 Next docs 示例私钥文本。

真实 WKWebView 验收使用 `demoTests/test_demo.dem`（Finder 显示 60.6 MB）：完成 de_mirage 解析、10 人与 9 回合识别、主体选择、胜率模型、11 个 guided cue、播放/自由接管/回到默认顺序、decision-before-outcome 提问、USER claim 诊断，以及 Settings 的 busy/install gate 与“稍后”精确恢复。最终 App bundle 仅含两个 arm64 executable，strict codesign integrity 通过。最终 DMG 的冻结校验值更新在 4.49。

**限制 / 下一步**

完整 GUI 路径在最终首屏状态一行修订之前已经通过；该修订不改变 chooser、Worker、Replay、Session 或 Agent seam。精确最终重建的 prepared/bundled SSR 与进程级 smoke 已覆盖这行状态，但 macOS 再次自动锁屏，阻止了对重建后窗口的最后一次视觉读取；因此不能声称为这次重建另有一张最终截图。Public Release 仍独立受第三方权利、正式 updater 公钥、Developer ID 与 notarization 阻塞；当前 App 是 ad-hoc 签名的本机验证产物，`spctl` 拒绝且 distribution audit 按预期停在 `APP_DEVELOPER_ID_SIGNATURE_MISSING`。

### 4.49 2026-08-31：DMG 构建不能把 Finder 窗口生命周期当作发布依赖

**触发**

Tauri 的默认 DMG 美化脚本在同一最终 App 上两次卡在 Finder/AppleScript 边界；手动复用脚本可以成功，但 `pnpm desktop:build` 与 CI 仍会留下概率性失败。发布 workflow 的静态审计此前也只确认存在 Tauri build，没有证明自定义 DMG 在 notarization 前执行。

**决定**

Tauri 固定只构建并签名 App。`create-dmg.mjs` 在私有临时目录使用 `ditto` 复制该 App，加入精确 `/Applications` symlink 和 `.metadata_never_index`，再以 `hdiutil` 生成压缩 DMG；不调用 Finder 或 `osascript`。partial 先校验，替换后再校验；最终校验失败恢复旧镜像原字节，无法恢复时保留显式 previous 文件而不删除。CLI 相对路径始终以 repo root 解析，避免 `pnpm --dir` 在 CI 中重复 `apps/desktop`。workflow audit 固定 App build、`create:dmg`、notary、bundle audit 的顺序并拒绝 Finder/Tauri DMG 回退。

**落点**

`apps/desktop/scripts/create-dmg.mjs` 与测试、根/desktop package scripts、`.github/workflows/desktop-release.yml`、release audit/tests、README、Runbook 与本架构记录。

**验证**

完整 `pnpm desktop:build` 一次通过并生成 App 与 Finder-free DMG；打包器 **6/6**、desktop prepare/bootstrap/DMG **20/20**、release audit **10/10**、workflow audit、prepared/bundled real-sidecar 与 bundle lifecycle 均通过。DMG CLI 只接受 canonical App 与版本化 output，不能覆盖任意 `.dmg`。DMG 挂载根目录精确为 `.metadata_never_index`、`Applications -> /Applications`、`CS Agent Coach.app`，无脚本/icon/source；App、sidecar、manifest hashes 与最终 bundle 一致，卸载后无 mount/temp/previous。合入 Ready v2、updater 纵向 seam 与 Viewer oversized-Cookie fail-closed guard 后的最终 DMG 为 **208,304,335 bytes**，SHA-256 `5f10b8d6122702c822fc141bbb48cdbd61133ec28d45b7ac803f844ee2e7ae62`，CRC `$FC9BD06F`；最终 Rust 为 **38/38**。

**限制 / 下一步**

这解决本地与 CI 的 Finder 生命周期问题，不提供第三方再分发权利、正式 updater key、Developer ID 或 notarization。公开 workflow 仍必须在具备这些受保护输入后真实执行；当前产物继续是 ad-hoc internal RC。

### 4.50 2026-08-31：监听地址与浏览器 authority 必须分开建模

**触发**

ADR-0008 用 App `127.0.0.1`＋Viewer `[::1]` 避免 Cookie 跨端口发送，但原始桌面验收明确要求内部 socket 只绑定 `127.0.0.1`。直接把 Viewer origin 也改成 literal IPv4 会让 host-only Cookie发送到 Viewer，因为 Cookie 不区分端口；同时旧 IPv6 workaround 迫使 App CSP 使用过宽的 `frame-src http:`。

**决定**

通过 Design It Twice 比较了三种 interface：单一 `localhost` Viewer authority、随机 sibling `.localhost` authorities、Tauri custom scheme。接受最小方案：`DesktopOriginPair` module 一次绑定并验证两个 `127.0.0.1:0` socket，App browser origin 保持 literal IPv4，Viewer browser origin 使用不向用户暴露的 `localhost:<port>`。Tauri cookie 仍只属于 `127.0.0.1`；Viewer 在进入静态路径处理前拒绝任何 `cs_agent_runtime` Cookie，超过 Cookie 解析上限的非空输入也按 malformed transport fail closed。Ready/HTTP wire contract 升到 v2，Rust 拒绝旧 v1、`[::1]`、共享 IPv4 authority 和同端口；App CSP 收紧为 exact Viewer origin。

随机 sibling hostname 对 single-instance 产品没有足够收益；custom scheme 尚未证明 module Worker、WASM、IndexedDB、SharedArrayBuffer、COOP/COEP 与 exact `postMessage`，均不进入默认路径。历史 ADR-0008 不原地改写，由 ADR-0009 取代相关段落。

**落点**

`apps/desktop-runtime/src/origins.ts`、runtime/security/viewer 与测试，Rust protocol/supervisor，Web desktop/playback validators，sidecar/bundle/WKWebView smoke，以及 ADR-0009、Architecture、README、Security、Changelog。

**验证**

红测先分别复现旧 `[::1]` runtime、Web validator、同端口 readiness 被接受，以及 8192-byte 上限之外的 Cookie 绕过 Viewer guard。修复后 origin module 证明两个真实 socket 都是 `IPv4 / 127.0.0.1`、端口不同、失败清理；Runtime **10/10**、Web transport **23/23**、Rust **38/38** 通过。prepared 与 bundled real-sidecar 双启动继续通过，并新增 exact CSP、Viewer session-cookie guard 和 Ready v2 检查；release App lifecycle smoke 只接受两个 `TCP 127.0.0.1:*` listener。

macOS 锁屏使可访问性截图不可读，但新增的无界面真实 `WKWebView` 阶段仍通过：受保护 Next `/desktop`、精确 localhost Viewer origin、CSS/JS、`crossOriginIsolated`、SharedArrayBuffer、module Worker、parser WASM fetch/compile 与 session Cookie host 隔离全部为真。扩展 Gate 通过标准 `runOpenPanel` delegate 把 60.6 MB `test_demo.dem` 交给同一 File input，raw bytes 留在 WebKit/Worker；真实解析到 10 人选择面，选择首位玩家后进入 Canvas 回放舞台。一次性 token 只经 stdin 进入临时 WebKit test process，不进入 argv或输出，controller 负责 sidecar/临时目录清理。

**限制 / 下一步**

此变化只替换 transport，不改变 Demo、Replay、Session、Agent、Memory 或教学顺序。60.6 MB Demo 的完整 Coach GUI 旅程已在同一产品代码的上一 transport 上通过；精确 v2 transport 又以真实 WKWebView 完成 File input、解析、玩家选择和 Canvas stage。锁屏只阻止了新的可访问性截图，不再缺少执行证据。Public Release 仍独立受 rights、正式 updater key、Developer ID 和 notarization 阻塞。

### 4.51 2026-08-31：Updater 需要一条真实签名数据流，也需要可替换的安装验证 seam

**触发**

Updater 已有 metadata、minisign、safe extraction、backup、swap、rollback 的分散测试，但缺少真实 versioned App archive 从签名、HTTPS 下载到 production verifier 的纵向证据。正式 GitHub key、Developer ID 与 notarization 当前不可用，不能伪造 public update 成功；同时 `install_staged` 把外部证书验证与本地原子事务写死在同一函数中，使无凭据环境无法证明 receipt/swap/health cleanup 的顺序。

**决定**

增加单一 controller 的 macOS local updater smoke：从最终 0.1.0 App 用 `ditto` 复制，修改 plist 为 0.1.1并 ad-hoc 重签；运行时生成临时 Tauri updater key，签名真实 App tar；本地自签 CA 的 HTTPS server 只提供有界 `latest.json` 与 archive，客户端流式下载；随后调用 production `updater-signature-verify`，解包并重新验证 version、arm64 和 codesign integrity，再篡改 archive 确认 verifier fail closed。私钥、证书、archive、下载和解包内容都属于同一临时目录，finally 清理；SQLite sentinel 只读复核不变。

把 `install_staged` 深化为 production wrapper＋私有 `install_staged_with(validate, swap)` seam。生产仍注入真实 Developer ID/spctl validator 与 `RENAME_SWAP`；macOS 测试只替换外部凭据 validator，继续执行真实 same-volume check、receipt、原子交换、RELAUNCH_REQUIRED 和 health 后旧 App 清理。这样 caller interface 不变，测试不绕开安装事务。

**落点**

`apps/desktop/scripts/local-updater-smoke.mjs`、desktop/root scripts、Rust updater 与纵向测试、README、Runbook、Architecture 和本日志。

**验证**

最终 Ready v2 App 的真实 local smoke 从 **0.1.0 → 0.1.1** 通过：164,135,699-byte archive 经 HTTPS 流式下载，临时 Tauri signature 由 production Rust verifier 接受，追加篡改后返回 `VERIFY_SIGNATURE_INVALID`；解包后的 App 为 arm64、0.1.1且 strict codesign integrity有效，SQLite sentinel不变。临时 key/cert/archive/download/extract/process 全部清理。Rust 原子安装纵向测试通过 1.2.3→1.2.4 swap、pending receipt、RELAUNCH_REQUIRED、health cleanup 和数据保持。

**限制 / 下一步**

这是可执行的本地更新工程证据，不是公开 GitHub Release 或 Apple trust chain。正式公钥仍为阻断占位值；没有 rights-approved Developer ID/notary 输入，因此 production `spctl`、真实 GitHub endpoint、App restart 与新版本首次 launch 不能诚实宣称已完成公开验收。workflow 已保留这些 fail-closed Gate。

### 4.52 2026-08-31：桌面视觉优化必须强化带看主线，而不是把播放器包装成 AI dashboard

**触发**

桌面链路和真实 Demo 已经可用，但最终 App 的首屏仍有三类体验债：长期记忆入口以固定浮层压在顶栏外；Demo 读取、玩家选择、胜率/路线准备分散成多个同权重小卡；教练侧栏、三段式讲解和诊断选项大量使用约 10px 的文字。功能正确，但用户仍需要自行拼出“现在在哪一步、接下来会发生什么”，不够像教练主持的一场完整复盘。macOS 多次锁屏也说明视觉验收不能只依赖可见桌面自动化。

**决定**

保持地图主画面、教练侧栏和完整时间轴三个既有区域，不改变 Replay、ReviewPlan、Outcome Gate、播放器命令或 Memory 边界。参考 Beautiful UI 的 AI-native primitive，把准备阶段收敛为三条有状态任务行，把讲解进度做成明确的整场路线进度，把诊断改成两步 approval card，并提高教练卡、状态 chip 和建议文案的字号与对比。长期记忆入口并入应用顶栏，不再作为 fixed overlay。

引入 MIT `liquid-gooey@0.2.1`，但只用于本地 runtime phase 的低频合并/分离提示。播放、暂停、seek、回合切换、速度和键盘动作全部保持普通即时 DOM 控件；没有给高频输入增加弹簧等待。Gooey 内容层继续是真实 DOM，`prefers-reduced-motion` 由组件和仓库 CSS 双重降级；新增 translucent surface 同时覆盖 `prefers-reduced-transparency` 与 `prefers-contrast`。

**落点**

新增 `CoachSetupFlow`、`LiquidPhaseStatus` 及各自 CSS Module；更新 `Cs2dPlaybackHost` 顶栏、准备态、整场路线进度、三段式讲解卡与时间轴视觉层级；更新 `TeachingDiagnosisPanel` 的两步 approval card 表达。`page.tsx` 与 Desktop page 不再重复渲染浮动 Memory link。第三方来源记录在 `THIRD_PARTY_NOTICES.md`，用户可见变化记录在 `CHANGELOG.md`。现有单 controller WKWebView smoke 新增可选 PNG snapshot 输出，先等待 Viewer host-mode 稳定后截取外层 App，不创建第二套浏览器生命周期。

**验证**

`pnpm check` 通过：Vitest **109 files passed / 2 skipped、763 tests passed / 4 skipped**，TypeScript 与普通 Next production build 通过；Desktop webpack production build通过。`desktop:test:unit` 继续为 Runtime **10/10**、prepare/bootstrap/DMG **20/20**、stub sidecar **1/1**、Rust **38/38**。prepared 与最终 bundled sidecar 的真实 WKWebView smoke 都通过 exact IPv4/localhost authority、Cookie 隔离、CSS/JS、Worker、WASM 与 graceful shutdown；`test_demo.dem`（60.6 MB）继续完成 File→Worker/WASM、玩家选择和 Canvas stage。

最终 arm64 `.app` 完成 strict ad-hoc codesign，两个 executable 均为 Mach-O arm64；Finder-free DMG 经 partial 与 final 两次 `hdiutil verify`。本轮 UI internal RC DMG 为 **208,132,141 bytes**，SHA-256 `a5123b7246059f96c52262458f5e85eb94b352b32b798fdd8413fcfb1d1b1535`。真实 bundled WKWebView 快照保存在忽略目录 `.local-data/ui-qa/desktop-shell-bundled.png`，确认 Viewer host-mode 已隐藏上游 GitHub、语言和 Library/Tournaments chrome，外层任务流、Gooey 状态和时间轴同时可见。

**限制 / 下一步**

快照覆盖最终 bundled 首屏，真实 Demo 的解析/选择/Canvas 由无界面 WKWebView 验证；锁屏状态下没有重新录制完整有窗口的全场教练交互。Beautiful UI 只作为 MIT 设计参考，没有 vendored 其源码；Liquid Gooey 是新增运行依赖，后续若浏览器兼容或包体成本不再值得，应保留普通状态 pill 的确定性降级。公开 GitHub Release 仍被 cs2d/Valve 权利、正式 updater 公钥、Developer ID 与 notarization 阻塞；新的 ad-hoc DMG 不能被称为公开 macOS release。

### 4.53 2026-08-31：GitHub runner context 只能在 runner 可用的 workflow 位置读取

**触发**

Desktop release workflow 首次推送后在 GitHub Actions 以 0 秒、无 job 的方式失败。仓库自带的文本审计能验证 tag、secret、签名和发布顺序，但没有覆盖 GitHub 表达式的上下文可用性。同时，rights preflight 未声明 `desktop-release` Environment，因此不可能读到同名 Environment variable；只在文档中要求设置该变量会让正式 tag 在预检阶段继续失败。

**决定**

不在 `jobs.<job_id>.env` 中读取 `${{ runner.temp }}`。改为在 Apple Silicon job 的首个 shell step 中读取 runner 已提供的 `$RUNNER_TEMP`，并通过 `$GITHUB_ENV` 向后续 step 传递 `RELEASE_DIR`。Rights 批准则明确拆成两层：仓库级 `DESKTOP_DISTRIBUTION_PREFLIGHT_APPROVED` 只允许无 secret 的 Linux 预检继续；受保护 Environment 级 `DESKTOP_DISTRIBUTION_APPROVED` 只在人工批准后交给签名和发布 job。这保留临时目录的自动清理边界，也不让廉价预检广泛获得 Environment secret。

**落点**

更新 `.github/workflows/desktop-release.yml` 和 `docs/DESKTOP_RELEASE_RUNBOOK.md`；`auditWorkflow` 新增 runner-only context 拒绝规则、两层 approval variable 静态契约和对应回归 fixture，避免只靠 GitHub 远程失败发现同类问题。

**验证**

`node --test tools/desktop-release/audit.test.mjs` 与 `node tools/desktop-release/audit.mjs workflow --path .github/workflows/desktop-release.yml` 通过；正式 tag 触发仍留待 rights、Apple 和 updater 凭据配齐后的首轮验收。

**限制 / 下一步**

本地 static audit 只锁定当前 workflow 使用的高风险 context，不是 GitHub Actions schema 的完整替代。两个 approval variable 都是非 secret 的明文变量，仅能表达“已完成权利审核”，不能取代 rights JSON、HTTPS evidence 或 GitHub Environment 人工批准。公开发布仍必须先完成权利批准、正式 updater key、Developer ID/notarization 凭据和 `desktop-release` Environment。

### 4.54 2026-08-31：未公证 Preview 必须与 stable/updater 通道完全隔离

**触发**

项目所有者确认已取得第三方内容再分发授权，并明确要求在没有 Apple Developer Program 的情况下继续公开发布。直接删除 Developer ID/notary/updater Gate 会把未公证产物伪装成正式更新，而完全拒绝发布又无法实现所有者明确授权的预览目标。

**决定**

保留 `desktop-vX.Y.Z` 正式 workflow、`distribution:audit`、updater 占位公钥和全部 Developer ID/notary Gate；新增隔离的 `desktop-preview-vX.Y.Z` GitHub Pre-release 契约。Preview 只包含 ad-hoc Apple Silicon DMG 与覆盖该 DMG 的 `SHA256SUMS`，不上传 `latest.json`、updater archive 或 signature，因此不能被当前自动更新链路消费。Release 标题和首段明确披露未使用 Developer ID、未公证、Gatekeeper 可能拒绝和无自动更新。

**落点**

`ARCHITECTURE.md` 5.3.0、README、Changelog、Distribution Audit 说明和 Release Runbook 共同冻结 Preview/stable 分离。本轮不改 `DESKTOP_DISTRIBUTION_AUDIT.json`、`tauri.conf.json` 的 updater 公钥、正式 workflow 触发器或 updater 代码。

**验证**

Preview tag `desktop-preview-v0.1.0` 指向 commit `6f1b841102147c2fd26a5d598af8c84c867af72e`。首次普通本地 build 会把运行时 build SHA 设为 `development`；一轮手工扩展错误的短 SHA 在打包前被中止，其 265 MB 临时 prepare 目录已精确清理。最终构建直接使用 `git rev-parse HEAD` 返回的完整 SHA 注入 `CS_AGENT_BUILD_SHA`，并从 Mach-O strings 反查到相同值。

`pnpm check` 通过：109 files passed / 2 skipped，763 tests passed / 4 skipped，TypeScript 和 Web production build 通过。`desktop:test:unit` 通过 Runtime 10/10、prepare/bootstrap/DMG 20/20、stub 1/1 与 Rust 38/38；重建后 bundled sidecar smoke、strict ad-hoc codesign、双 arm64 Mach-O 和 DMG partial/final `hdiutil verify` 通过。最终 DMG 为 206,236,857 bytes，SHA-256 `4bb715af35231c633ede3b61df62313b9d6787a5d47230912201253192fe99de`。GitHub 远端 Release 为 `draft=false` / `prerelease=true`，只有 DMG 和 99-byte `SHA256SUMS`，远端 DMG digest 与本地完全一致，公开页与 checksum asset 均可访问。

**限制 / 下一步**

该 Preview 只支持 Apple Silicon/macOS 13+，没有 Developer ID、Team ID、notarization ticket 或公开自动更新；Gatekeeper 在默认策略下可能拒绝打开。权利状态仅记录了项目所有者本轮确认，正式 machine-readable rights evidence 尚未入库；因此该 Pre-release 不能提升为 stable，也不能用来证明正式 updater 链路已通过。

### 4.55 2026-09-02：永久复盘必须把媒体、分析版本、运行头与记忆证据拆成不同身份

**触发**

原有桌面流程只把 File 留在当前 WKWebView：应用退出后无法再次打开同一 Demo，ReviewPlan、Narration、教学结论和 Agent checkpoint 也没有统一的复盘归属。若简单把整个 Replay 或大 Analysis JSON 塞进 SQLite，会同时破坏 Viewer-only raw media 边界、备份大小和内存上限；若把每次重新分析都当成新 Memory 机会，又会让同一行为在长期记忆中重复增长。

真实 App 验收还暴露了两个只在完整纵向链路出现的问题。第一，打包的 Node 24 Permission Model 会以 `ERR_ACCESS_DENIED` 禁用同步 `fsyncSync`，导致 60.6 MB Demo 已写完却在目录耐久性屏障处失败。第二，首次 RuntimeHead 把 AnalysisBundle 的内部 `demo_id` 误当作 DemoAsset UUID，Review/Revision/Artifacts 已生成但稳定起点无法提交。

**决定**

新增 `review-library` 深模块，以同一个 desktop SQLite owner 管理 `DemoAsset 1:N Review 1:N ReviewRevision 1:N ReviewArtifact`、单一 RuntimeHead、导入/产物/删除 job 与 Memory evidence claim。原始 Demo 使用 SHA-256 内容寻址文件；大型 AnalysisBundle 使用应用目录内 gzip 文件，小型控制面 JSON 留在 SQLite。数据库只保存受策略验证的相对路径，所有发布先写同卷 partial、校验、同步、硬链接发布，再提交索引；删除走可恢复 Saga/tombstone。SQLite backup 继续只备份小型数据库，不复制原始 Demo。

Viewer 用一次性、对象绑定、短期 Bearer capability 直接向 Viewer-origin sidecar 流式写入或读取 Demo；Host 只交换 DTO 和控制命令，Rust、Next、Agent、Memory 与 LLM 都不接触 raw bytes 或完整 Replay。默认历史点击先恢复持久化控制面，再让 Viewer 读取托管 Demo，并设置 playback-only gate；只有显式重新分析或换玩家才创建新 Revision。

目录同步改为异步 `fs.promises.open(directory)`＋`FileHandle.sync()`＋close：它与文件同步表达相同 durability barrier，同时是受限 Node 24 允许的 API。`HistoryPersistenceController` 在创建或 adopt Review 时绑定 DemoAsset UUID，提交 RuntimeHead 时强制覆盖调用者传入的同名字段，防止 parser artifact identity 越过持久化边界。Memory 则把稳定 opportunity key 与 revision evidence key 分开：相同 Demo hash、玩家、稳定 cue source 与 taxonomy 只 claim 一次，分析版本只作为附加 evidence。

**落点**

新增 `libs/review-library`、desktop migrations 003/004、Review History API/Sidebar/restore/persistence controller、cs2d managed-library patch、Viewer raw-byte endpoints、Settings 资料库管理、ADR-0010。更新 desktop runtime/Rust supervisor、Memory evidence ingest/policy、checkpoint identity helper、Architecture、README、Changelog 与真实 sidecar smoke。

**验证**

`pnpm check` 通过：**113 files passed / 2 skipped、797 tests passed / 4 skipped**，TypeScript 与普通 Next production build通过；Desktop webpack production build和 cs2d `vue-tsc` 通过。桌面门禁继续为 runtime **10/10**、prepare/bootstrap/DMG **20/20**、stub sidecar **1/1**、Rust **40/40**。真实 sidecar smoke 现在在 Node `24.19.0 --permission --jitless` 下执行两次启动：第一次走受保护 Next capability＋Viewer raw endpoint 导入，第二次以同一 hash/同一 Demo UUID 去重；该测试在旧 `fsyncSync` 实现上可稳定变红，改用 `FileHandle.sync()` 后通过。

真实 ad-hoc Tauri App 通过原生文件选择器导入 `demoTests/test_demo.dem`（Finder 60.6 MB，60,601,900 bytes），落盘 SHA-256 为 `84a1a4191302bdd2a3bbb5a727842093744b1fb1a228aeec630369e44b622cb2`，解析为 `de_mirage`、10 名玩家、9 回合。选定 `povergo` 后生成 20 个教学点，Review 为 `IN_PROGRESS`、Revision 为 `READY`，RuntimeHead 的 Demo UUID 与 DemoAsset 一致。冷重启后直接点击该历史记录恢复到第 1 回合、讲解 1/20；点击前后精确保持 2 Reviews、2 Revisions、37 Artifacts、1 RuntimeHead、40 Agent checkpoints 和 0 Memory events，证明默认恢复没有生成新版本、讲解或 Agent checkpoint。Settings 显示 1 个 Demo、2 条复盘、58 MB 原始文件、806 KB 产物，并报告“已校验 1 个 Demo 和 2 个大型产物”。

**限制 / 下一步**

Parser 的既有 WASM 接口仍需要在 Viewer 内把完整 Demo 转为 ArrayBuffer；资料库传输是流式且 bounded，但解析峰值内存尚未变成真正增量解析。真实 UI 覆盖了导入、解析、换玩家、新 RuntimeHead、冷重启和 route-start 恢复；更深的 CUE_PAUSED/WRAP_UP checkpoint 恢复由状态机与数据库测试覆盖，没有在本轮再手工走完 20 个教学点。清理缓存和删除入口因会改变本地数据没有在最终 UI 验收中点击；其 job/Saga 行为由单元测试覆盖。公开 macOS stable 发行仍独立受 Developer ID、notarization 与 updater 正式密钥约束。

### 4.56 2026-09-02：READY 与 RuntimeHead 必须分别通过语义门和精确恢复点门

**触发**

第一次独立终审指出，ROUTE_START 虽已改为“关键产物落盘后再提交”，但后续 CUE_PAUSED/WRAP_UP 仍并行 fire-and-forget 写 `SESSION_RECOVERY` 与 RuntimeHead；DAL 只检查“存在某类 Artifact”，冷恢复又选择时间上最新的 Recovery。这样可能形成新 head 指向旧 snapshot。终审还用伪 JSON 证明低层 checksum/type 计数不足以代表 Revision 语义 READY，并发现 Demo 删除无法覆盖 `source_review_id=NULL` 的同哈希 Memory evidence。

真实 App 冷恢复同时出现 `PLAYBACK_LANDING_TIMEOUT`：Viewer 已在 canonical tick 73 显示画面，Host 进度仍为 `—`。Host 侧缓存最后状态的第一版修复仍失败，说明唯一一次初始 `PLAYBACK_STATE` 发生在 `REPLAY_READY` 前后竞态中，幂等 pause/seek 又没有产生新的响应。

**决定**

所有稳定边界改为严格顺序：先持久化本次 `SESSION_RECOVERY`，再提交 RuntimeHead。提交输入携带精确 Recovery artifact key；Review History 服务先复用当前 Analysis adapter、ReviewPlan、Narration/CueCase、SessionRecovery 等领域 validator 验证指定 Revision，资料库事务再逐项核对 session、run、Demo hash、玩家、route、boundary、cursor、cue、checkpoint 和计数。冷恢复只选择与 RuntimeHead 完整身份匹配的 snapshot。新 Revision 记录真实 adapter 1.4.0、Agent graph v3、prompt 与 Director metadata；`CANDIDATE_SET` 成为 READY 必需 Artifact。

Demo 删除 job snapshot 额外保存内容哈希；删除整个 Demo 时按 hash 将包括无唯一 Review 归属在内的 evidence 标为 DELETED 并写 tombstone，同时保留 opportunity claim 防止重新导入后重计。Viewer bridge 对 pause/seek 即使状态不变也显式回传 `PLAYBACK_STATE`，并在 `ViewerStage` mount、命令监听器安装完成后的 next tick 再发布一次初始状态；该改动继续位于受控 cs2d patch stack。

**落点**

`apps/web/lib/review-history/artifact-validation.ts` 成为 Review History 应用服务的语义门；`libs/review-library` 保留文件/checksum、指定 Revision 读取、精确 Recovery/head 事务和删除 Saga。Host 的首个 durability promise 串行保存 Analysis、CandidateSet、Plan、已就绪 Narration、Recovery 与 head，后续 Narration 等待该 promise 后追加；中途稳定边界也不再并行提交。Architecture 5.4/ADR-0010 同步记录了这两个层次，避免把“可存储 JSON”误写成“可恢复 READY”。

**验证**

真实领域 fixture 证明当前 Analysis/Plan/Narration/Recovery 集可通过 READY，route/run 漂移会被拒绝；Route Handler 回归证明伪 Analysis JSON 返回 `REVISION_ARTIFACTS_INCOMPLETE` 且不会调用 commit。资料库测试覆盖错误 Recovery key/run、READY/FALLBACK Narration、指定 Revision materialize 和无 Review 归属 evidence 的 hash tombstone。最终 `pnpm check` 为 **120 files passed / 2 skipped、817 tests passed / 4 skipped**，TypeScript 与 Next production build 通过；Runtime **10/10**、prepare/bootstrap/DMG **21/21**、stub **1/1**、Rust **42/42**、真实受限 sidecar 双启动、cs2d typecheck/build 与 patch reverse-check 通过。

真实 App 已连续复现两次旧 Viewer 时序下的 tick 73/Host `—` 超时，第二次排除了单纯 Host 容差问题；mount 后显式确认的 Viewer 产物随后完成 typecheck、production build、受控 patch 校验与 ad-hoc App 重建。最终点击复验开始前 macOS 自动锁屏，Computer Use 无权解锁，因此这一条 UI 结论仍待屏幕解锁后补齐，不能把构建通过写成实际落位通过。

**限制 / 下一步**

当前 WASM Parser 仍需完整 Blob/ArrayBuffer；列表与删除明细有界为 50，删除确认显示精确总数和前 8 条明细，impact token 覆盖全部关联。最终 mount-ack UI 点击、Settings 新删除选择器的只读视觉检查仍受锁屏阻塞；不得为了通过验收修改系统锁屏设置，也不得未经确认点击真实删除操作。

### 4.57 2026-09-03：永久历史需要 parser、恢复身份和事件时序三类独立门

**触发**

第二轮独立 Spec 审查证明“文件已安全落盘”和“Review 可安全恢复”之间仍有多个不能互相替代的边界。最初导入会在真实 parser 前把 Demo 标成 READY，Settings 的物理 verify 又能把 `IMPORTING/CORRUPT` 重新升成 READY；RuntimeHead 只保存 Recovery key 时，同 key 多 revision 无法唯一指向 snapshot；历史打开期间迟到的 `ANALYSIS_PROGRESS/TELEMETRY/FAILED` 仍可覆盖已恢复控制面。默认 answer/disagreement/skip 的诊断产物、独立 ToolResult 和 exact Recovery identity 也需要在 head 前完整持久化。

真实生产 WKWebView 纵向测试又抓到两个单元测试不容易暴露的事件竞态。第一，Viewer 先发 `PLAYER_SELECTED`，下一个 Vue tick 才挂载 `ViewerStage` 命令 listener，Host 的首次 pause/seek 会被父级 no-op handler 消费并在十秒后 `PLAYBACK_LANDING_TIMEOUT`。第二，首次导入时 Viewer 选人可能快于 React 对 `REPLAY_READY` 的 rerender，`PLAYER_SELECTED` handler 读到旧 `replay=undefined`，从而漏建 Review。大文件采样还显示原逐 chunk `await FileHandle.write` 的 RSS 裕量过小，WriteStream `flush:true` 又会在 Node Permission Model 下调用被禁用的 `fs.fsync`。

最终双轴复审继续找出四个跨边界窗口：backup 的旧 active count 没有覆盖 Viewer import/read/finalize 与已进入的 admin 删除；import 已 link/fsync final、删除 temp、但尚未提交 SQLite 时崩溃会留下永远 PUBLISHING 的 final-only job；parser 完成会由 watcher 在 VALIDATE READY 前暴露选人；连续点击历史时，Host HTTP controller、Host async state commit 与 Viewer parser 各自都可能让慢 A 覆盖快 B。另一个容易误判的细节是 Node `response.writableEnded` 只说明调用过 `end()`，并不代表字节已经 `finish/close`。

最新 debug App 解锁后的可见验收又证明“新增完整性门”本身也需要版本化：真实 `povergo` Review 是独立 CandidateSet Artifact 成为强制项之前写成的 READY Revision，checksummed AnalysisBundle 内已有完整 67-candidate set，但历史层把“缺少新投影”误判成“旧分析不可恢复”。永久历史不能因为后来把同一数据拆成独立 Artifact 就强迫用户重新调用 LLM。

**决定**

Demo 导入改成三层门：64 KiB high-water-mark 的 `Readable → hash/size/header Transform → FileHandle WriteStream` pipeline 先发布内容寻址文件和 `IMPORTING` 行；同一用户 File 经真实 Worker/WASM parser 后，Viewer 才以一次性、Demo-bound VALIDATE capability 提交 READY 或 CORRUPT。失去内存 capability 的中断 IMPORTING 在启动时变 CORRUPT；Settings verify 只允许把既有 READY 降级，绝不语义晋升。受限 Node 的 durability 顺序固定为 pipeline finish → `FileHandle.sync()` → WriteStream destroy/close acknowledgement → directory sync；不用同步 `fsyncSync` 或 `flush:true`。

Migration 005 为 RuntimeHead 增加 Recovery Artifact ID/key/revision 三元身份；只有能唯一匹配的旧行才回填，其他旧 head 恢复失败关闭。Artifact append 复用真实 Analysis/CandidateSet/Plan/Narration/CueCase/Recovery validator，并要求 Analysis → CandidateSet → Plan → session Artifact 的依赖顺序；每个稳定边界先写精确 Recovery，再提交 head。answer/disagreement/skip 先持久化用户交互和完整诊断投影，再镜像 Agent 结果；ToolResult 以独立 Artifact 校验并只合并到匹配的 POSTED ledger。

历史打开严格拆成 SQLite control plane 和 Viewer source 两阶段。RESTORE 在 bridge 入口丢弃全部迟到 `ANALYSIS_*`；Viewer 不运行胜率 Worker，只有 `ViewerStage` 已安装命令 bridge 并发出 `host-ready` 后才发 PLAYER_SELECTED。Host 在收到 REPLAY_READY 的同一消息 turn 写 `replayRef`，选人建 Review 和恢复 tick-rate 都读取该 ref。main remote window 只增加 `open_settings` 命令，用于显示/聚焦 bundled Settings；文件、Keychain、删除、验证、统计与通用 Tauri 权限仍未开放。

backup/shutdown 改用统一 activity tracker：Next、Viewer Library `IMPORT/VALIDATE/READ` 与 admin 资料库操作都在 READY 检查后、首个 await 前登记，只有 handler 结束且 response 真正 `finish/close` 才退休；DRAINING 后新入口返回 503。`publishImport` 在 final 已存在时先复核 exact hash/size，再允许无 temp 完成数据库提交。managed parser watcher 不再自行发布 Replay；首次导入必须先 VALIDATE READY，随后按 `DEMO_IMPORT_SUCCEEDED → REPLAY_READY` 发布并解锁选人。历史恢复则在 Host 每个 await 后检查 open epoch，Viewer 用 AbortController＋串行 parse tail＋load generation 屏蔽不可取消 parser 的旧结果，Host 再以 requestId/demoId/hash 做第二层精确校验；PLAYER_SELECTED 与全部 ANALYSIS_* 在 desktop managed mode 下还必须绑定当前已接受 Replay，已排队的旧 postMessage 不能写入新 Review。

Migration 006 为 Revision 增加 `artifact_contract_version`：既有行默认 v1，新建行显式 v2。v2 的 append/READY/head 仍要求独立 CANDIDATE_SET；v1 只有在 Revision 已 READY 时，恢复层才从 checksummed、随后仍会经过 Analysis/Candidate/Plan/Recovery 现有领域校验的 AnalysisBundle 读取 embedded CandidateSet。兼容层不回写伪 Artifact，也不放宽任何新 Revision 的持久化门。

**落点**

核心落点为 `libs/review-library`、desktop migrations 005/006、Review History Artifact/restore/persistence controller、Playback Host、受控 cs2d managed-library patch、Viewer import/finalize/read endpoints、Settings capability/页面，以及 Memory opportunity evidence 集成测试。`ARCHITECTURE.md` 升至 5.5.2，ADR-0010、README 与 Changelog 同步上述合同。

**验证**

最终全仓 `pnpm check` 通过：**123 files passed / 2 skipped、840 tests passed / 4 skipped**，TypeScript、普通 Next production build 均通过。桌面 webpack/Viewer/runtime prepare 产出 **7,428 files / 431,265,701 bytes**；desktop runtime **12/12**、prepare/bootstrap/DMG **21/21**、stub sidecar **1/1**、Rust **42/42** 均通过。受限 Node 24.19.0 `--permission --jitless` 的真实 sidecar 双启动、cs2d `vue-tsc`、patch **6/6** 与 patch reverse-check、Swift typecheck、Node syntax check、`git diff --check` 均通过。最新 `tauri build --debug --target aarch64-apple-darwin --bundles app` 成功，ad-hoc bundle 通过 `codesign --verify --deep --strict`；实际启动得到 Tauri PID 39491、受限 sidecar PID 39550 和 `RUNTIME_READY`。

最终 `smoke:webkit-demo` 使用生产 `/desktop`、真实原生 file chooser 和 `demoTests/test_demo.dem`：文件为 **60,601,900 bytes**，SHA-256 为 `84a1a4191302bdd2a3bbb5a727842093744b1fb1a228aeec630369e44b622cb2`，真实 parser 得到 de_mirage、10 名玩家、9 回合，并进入首位玩家和 Canvas。为避免把全场 CS-Net 时长混进历史恢复断言，测试随后只经正式 Review History HTTP API 写入一组由当前领域 validator 接受的确定性 1-cue Artifact/RuntimeHead 到临时 SQLite，明确标记 `seededHistoryFixture=true`；刷新生产 App 后实际点击历史行，恢复到“讲解 1/1”和非空播放位置。点击前清零的 document-start fetch spy 与 Resource Timing 同时证明 Director、Narrator、Reflection、Adaptive、Wrap-up 和 `/api/memory/events` 为 **0**；观察到的 API 只有该 Review detail 与 viewer-source 各 **1**。最终一次 XHR send→sidecar publish RSS delta 为 **56,377,344 bytes < 60,601,900-byte file**；前一次最终代码样本为 **58,867,712 bytes**，另一次相同 pipeline 样本为 **18,268,160 bytes**，说明运行噪声存在，不能据此宣称任意尺寸下 RSS 恒定。

独立 Memory 集成测试使用真实临时 SQLite owner、ReviewLibrary、SqliteMemoryRepository 与 MemoryService：同一 Review 打开五次、同 cue 回看五次、同机会从恢复路径重复发出五次后，claim/evidence/event/record 均保持 1，`occurrenceCount=1`，独立 Demo hash 仍只有一个。Demo 删除测试在删除前 stat 内容寻址文件成功，删除后明确得到 `ENOENT`；数据库、其他 Review、checkpoint、evidence tombstone 与失败重试另有回归覆盖。

真实 Settings 可见验收显示 1 个 Demo、2 条复盘、58 MB 原始文件、806 KB 产物、0 B 缓存，并且 Review/Demo 删除入口分离且默认禁用；没有点击删除。真实用户 SQLite 已通过 migration 006，`integrity_check=ok`、foreign-key check 为空，仍为 1 Demo、2 Reviews、2 Revisions、37 Artifacts、1 RuntimeHead、40 checkpoints、0 Memory events/records/claims。领域集成测试以真实 Analysis/Plan/Narration/Recovery fixture 验证 v1 embedded CandidateSet 恢复，v1 PREPARING 和 v2 缺独立 CandidateSet 均失败关闭；独立终审最终报告 No P1/P2 findings。

**限制 / 下一步**

当前 Viewer WASM parser 仍把完整 Blob 转为 ArrayBuffer；上述 RSS 只测 sidecar raw transport/publish，不代表 WebView parser 增量内存，也不证明更大文件的 RSS 常量界。无头历史测试的 Artifact 是 validator-backed deterministic fixture，不等于本轮重新跑完真实 CS-Net/Director/Narrator；真实用户数据库中的 20-cue v1 Review 与数据仍保留。修复 migration 006 并重启最新 App 后 macOS 再次锁屏，因此该真实 v1 Review 的最终可见 re-click 未完成；不能绕过锁屏，但相同兼容路径已有真实领域 fixture、实际数据库 migration/integrity 与新 v2 WebKit 纵向链路证据。没有在真实用户库点击任何删除或重新分析操作。更深 CUE_PAUSED/WRAP_UP 由状态机、SQLite 和 Artifact 测试覆盖，而非本轮手工看完整场。

### 4.58 2026-09-14：合法引用不等于可信判断，具体建议必须先验证适用条件

**触发 / 根因**

真实 `test_demo.dem` 的旧确定性链路在十名玩家175个教学点中出现8条依赖已阵亡队友的建议。`povergo` 第1回合只剩2 HP、四名队友已阵亡，仍被建议让高血量队友先接触；同一真实模型窗口的胜率由11%升到24%，旧候选层却未把它纳入反证。原先仅采集所选玩家，死亡/掉血直接转成行为文字，再按局部资源套战术模板；合法引用验证只能证明ID存在，无法证明文案含义或建议前提。

**决定**

在原 contracts、adapter 与 review-planner 中增加可信上下文和适用性门，不增加Parser或基础设施。每个候选在Replay所有者内读取必要十人局面，输出一个有界快照；隐藏位置不跨界，全知信息只作否决。观察主张保持决策前、来源、有效期和置信度。事件只证明事件；正式行为判断必须有独立过程证据，结果变化仅作影响和反证。具体建议来自固定目录，逐项前提检查决定适用、拒绝或不可验证；未获批准时不用另一个通用战术替代。

Director只选已经通过门的候选和重点，Compiler重验。Narrator与总结采用封闭的已验证语义投影，未经证明的自由改写被拒绝。没有可靠过程证据的真实窗口保留少量明确的反思或显式带过，不为数量或习惯标签编造错误。Reflection使用有来源的存活队友计数，区分零与未知；用户意图仍是用户补充，不因条件失败自动判其决策错误。

**集成中新增发现**

- 新增观察上下文带入可选undefined字段会改变序列化形状；不能通过修改全局哈希算法解决，否则旧历史失效。只规范化新增紧凑上下文，保留历史哈希语义。
- 1.5缺快照但保留publicFacts的包可以绕过检查，即使哈希有效；新版本必须完整绑定，1.4只允许旧字段全部缺失的兼容形状。
- 旧Narration/CueCase须作为不可变历史恢复，但呈现必须安全降级，不能把旧战术文案当作新门已经批准的建议。
- 没有离散swing的正向结果必须从严格结果窗口采样生成测量引用，不能等到OutcomeImpact才发现反证。
- 实际组件仍能把TRADE直接输出给用户；新增真实React渲染测试，而非只测文案辅助函数。Vitest只增加自动JSX变换支持该回归。
- 快速降级讲解在异步保存恢复记录期间就绪，可能被旧initialSession覆盖，导致第三点永久BUFFERING。激活前经Session reducer合并最新同路线就绪状态，并再次检查generation，拒绝迟到旧会话启动。
- 真实刷新恢复暴露独立握手漏洞：诊断面板跳过视觉START_CUE，但此前普通段已写入Agent，因此反思无法走fresh bootstrap，只有本地诊断而无匹配检查点。反思前通过现有串行控制器发送零工具能力的START_CUE，仅同步身份和路线；不执行播放效果、不改Graph规则。非起点恢复记录必须匹配检查点才可覆盖上一个稳定边界，握手期间禁止普通稳定写入覆盖恢复状态。匹配重连后经Session reducer恢复已有诊断，不能让用户重新回答已完成反思。

**落点**

长期契约为ARCHITECTURE5.6；实现落在decision-context contracts、adapter snapshot/validator、teaching-gates、candidate-generator、Narration双包/严格语义校验、Director、Reflection、最小呈现、历史安全投影和Session激活seam。PRD/MVP_SCOPE及用户原有docs/prompts保持不变。详细证据见[可信决策验收](./validation/TRUSTED_DECISIONS_2026-09-14.md)。

**验证**

最终 `pnpm check`：127文件通过、2文件跳过，938测试通过、4测试跳过；TypeScript与Next生产构建通过。最后纯文案调整另跑 `pnpm build`；Viewer的 `pnpm cs2d:typecheck`、`pnpm cs2d:build` 通过。新增自动化覆盖请求的十个场景和上述集成漏洞，未减少旧门控/恢复断言。

真实WASM单次解析后遍历十个分析主体，2,694条断言验证每人9回合、快照/候选一一对应、字节上限、全文案与引用。真实Edge使用生产Next和既有桌面Viewer资源处理器，从File解析、选povergo、本地WebGPU FP16的7,239样本到4/4讲解与第9回合结束均通过；四个结果窗口均实际播放，反思、跳过与Next通过，11%→24%已进入候选反证。实际两份1.4历史（11点和20点）的31份讲解只读校验保持路线/哈希不变。

额外真实刷新恢复通过：保存非空且匹配的c1检查点，刷新后DORMANT不触发模型请求，同Demo重解析后RECONNECT_REPLAY返回MATCHED、routeCursor 2、c1诊断。前后均为povergo、canonical 8969、路线fnv1a-4d4ca391；已完成反思原样显示，不再次追问。没有重跑Director，恢复后仅续跑1条待处理Narrator。此证据限同一服务生命周期的localhost MEMORY检查点，不等于桌面服务冷重启验收。

通用预览服务器两次在构建base/绝对资源路径边界失败后停止叠加补丁，改用生产资源处理器并先验证地图/模型/WASM；一个控制器始终拥有浏览器和服务并清理。没有把仅通过前两条讲解的中途结果当作全场验收。

**限制 / 下一步**

当前解析结果仍缺少可靠LOS/声学/语音、伤害来源、补枪时机、道具用途、可达掩体和剩余计时，具体建议因此保持不可验证；正式正向/执行/被迫分类已有过程证据门，但不能称此Demo已经具备这些确定判断。模型自由改写目前受封闭语义限制；未使用真实DeepSeek凭据，本地HTTP降级和模拟Provider输出均经过验证。真实PostgreSQL三项与旧Pixi Falcons一项保持原有opt-in跳过。本轮不发布或替换用户安装包；生产策略拒绝旧PWA注册的404及ORT的CPU shape节点提示保持诊断记录，不称纯GPU或零控制台诊断。

### 2026-09-24：修复观察语义损失与引用题错位后，Jev质量仍未改善

**问题**：合法SELF观察从(100,100,0)改到(2000,2000,0)时旧最终HTTP相同；另旧题让单条人数/动作证据单独证明战术结论，而validator要求联合前提，造成引用语义错位。

**决定/落点**：新v4投影保留来源、knowledge、匿名主体、时效及原空间类型，用明确粗化的地图格与代码计算的有界相对关系表达内容。声音仍需observer audibility；不从Snapshot全知数据补身份/坐标。新6题让模型独立选择判断和最小联合证据，保存原始witness分布并校验一致性，不自动修正答案。旧binding按LEGACY投影本地恢复，6秒预算与RETURN未知接触保护不改。

**验证**：1,073项全量tests/TS/Web production/Viewer构建通过，另5个评测器测试通过；真实Demo一次解析535候选/8合法v4包/1,999断言、0模型请求。实际模型开发9次＋冻结代理测试18次：新Jev有效明确判断仍0，合法通过2/9低于旧3/9；新协议下生成模型有4个明确代理判断，但冻结测试的2个成功均沿用开发相似家族，不能称新战术泛化。独立功能与模型审查见 [阶段验收](validation/JEV_SEMANTIC_ACCEPTANCE.md)。

**限制/决定**：新Jev输入/输出量下降不能替代质量。既有信息损失和引用表达可修，但模型仍会内部冲突或违反概率/条件，拒绝门保持。默认规则/正式接受关闭，本方向到27次停止，不继续追调同一集合。代理测试家族分离不充分已明确，历史产物不重写；真实contact/LOS和专家质量仍未验证。

### 2026-09-23：同输入比较显示Jev更快，但尚无新增可用决策判断

**问题**：接线和拒判测试不能回答用户“是否有提升”。此前只有两条生成模型对照，且真实v3模式受未知接触门限制，5次拒判无法证明战术能力。

**决定**：冻结现有题目/门槛，用9个不同合成输入给两个provider各跑一次3秒同题对照；对生成模型5个超时输入单列10秒诊断。真实Demo重新单次解析，精确匹配此前5个Jev final-body哈希后复用历史结果，并调用现有生成模型；同信息、异协议/非同时测量的限制明确记录。

**验证**：本轮28次新请求。3秒下Jev解析9/9、门通过4/9，生成模型解析/门通过4/9，其余超时；通过者全部拒判。10秒诊断也未产生通过门的非拒判结果。5个真实输入三方原子选择完全一致；Jev历史p50 461ms、生成本次1814ms。新增工具5tests及严格TS通过，独审关闭输出symlink边界P2。完整数据见 [效果对照](validation/JEV_QUALITY_COMPARISON.md)。

**限制/处理**：作者设定不是专家标签，单Demo5节点相关，超时为右删失，10秒是失败子集诊断。可以说本次结构化完成更快，不能说准确率或教学质量更好。保留默认规则/关闭正式接受，先解决合法信息与原子引用支持，再验证新增判断；不靠更多相同拒判调用宣称提升。

### 2026-09-23：用已有本人轨迹验证拒判，不把坐标返回升级为重新接敌

**问题**：真实Demo已有本人开枪归属和8Hz位置，但旧试点要求RECONTACT/REPEEK结构事实，导致517个原候选没有可发送输入。用户要求直接复用现有材料；继续索取标注不能解决可独立实现的事实动作链路。

**决定与落点**：cs2d adapter增加保守RETURN_AND_FIRE提名：同回合本人明确射击、连续存活自身采样、离开48 units后返回24 units内，2秒动作/10秒先前射击范围。阈值只定义未校准的动作模式。接触/视野仍UNKNOWN；projection.v3与独立问题版本明确这一点，强判由CONTACT_UNVERIFIED拒绝并保留原答案诊断。CandidateGenerator转发事实，Director仍决定是否值得讲，Narrator表达已接受的证据不足；默认模式不增加这种教学。结果窗口本人状态单独作为OUTCOME，不影响提名或Jev请求。

**验证**：新测试覆盖actor/缺帧/高度/时间/连发去重、最终HTTP结果替换不变、强判拒绝、默认无教学、TEST_ONLY实际准备和恢复零重复评估；全量测试/TypeScript/production build及单解析真实输入证据见 [验收报告](validation/JEV_ACCEPTANCE.md)。真实调用只由一个有期限的控制器执行，凭证从不回显stdin读入，不写配置。原始Replay不离开子进程。

**限制**：8Hz采样并非逐tick位置。几何模式可能对应战术上完全不同的动作，缺少视野、报点及目标条件仍不能判对错。专业质量与自动接受门槛没有教练留出数据，保持未验证；本次真实输入可运行不等于模型具备专业教练能力。

### 2026-09-22：Jev 决策评估接线不能代替合法动作生产或专业验证

**问题**

现有 `assessment` 由 `assessCandidateTeaching` 在 assembly、Director、Compiler 和 CoachingPackage 多处重算，混合过程判断与教学价值；单改 Director 字段会在下游丢失。真实候选主要来自死亡/击杀，不能反推玩家重复 peek。当前 cs2d shot 无 shooter，Observer 只构建自身位置，snapshot 的原始引用也不满足新候选内别名门。

**决策**

增加 provider-neutral 的三原子评估和原生 Jev adapter，默认规则、旁路和显式 TEST_ONLY 分离。规则数值/窗口留代码；最终 HTTP 精确重建白名单，所有自由文本和未来结果不入 Jev。评估是派生 Inference，冻结 cue 持有 artifact，恢复时纯本地重验。新准备关闭实验时剥离旧 overlay；未校准评估不产生新习惯计数。长期约束见 ARCHITECTURE 6.6.1。

Jev 并行问题看不到彼此答案，不能泛问“此引用支持判断吗”；改为具体命题×引用别名逐项判断。引用归属不等于语义支持，不能自动把所有白名单引用塞给结论。Native confidence 不等于 argmax probability，更不等于战术正确率。HTTP fetch 和 JSON 解码一起受总期限约束，本地 GET/POST 也需要独立期限及取消 race；仅上游 AbortController 不足以防止准备永久卡住。

**验证**

最终 `pnpm check`：130 文件通过、3 文件跳过，978 测试通过、5 测试跳过；TypeScript 与 Web production build 通过。`pnpm desktop:test:unit`：runtime 14、打包/IPC 21、sidecar stub 1、Rust 44 全通过。桌面 runtime 与 standalone 构建通过，真实 sidecar 两次启动、SQLite/资料库去重/Memory导出删除/backup及新可选init→内存配置 smoke通过；没有安装用户应用。构建脚本改为包内 esbuild/Next 命令，修复隔离工作树无根级软链接的既有假设。

Synthetic 实际准备链证明一次假 Provider 调用进入 Director、冻结 cue、Narrator，重复准备和本地恢复无新增调用；声明为工程测试而非模型效果。真实 60.6MB Demo 一次 WASM解析、10玩家×9回合、517候选，1937断言通过，**0可评估候选**。不能用修复第一层snapshot引用来掩盖后续动作、视野和适用性缺口。

使用用户提供凭证运行两轮各7次真实 `jev-1.13.0` 请求；第二轮保留被门拒绝的输出，避免首轮只统计通过者的分母偏差。累计73606输入tokens、18615输出tokens，按公开费率估算$0.003091452；两轮p50为547/707ms，p95/p99样本不足。第二轮9条案例记录（7个真实请求、2次反事实复用）：7条可解析，2条概率校验失败；可解析中2条通过、5条引用校验拒绝；全部可解析输出都认为上下文不足。自动正式接受保持0。没有生成模型凭证或教练标签，不能报告三模型完整比较或专业准确率。

**限制**

真实产品最小切片未完成：需要明确射手事实、observer-scoped接触/曝光、独立“接触→脱离→再次接触”动作生产及规范引用传递；当前报点只含类别元数据。旁路仍在冻结前有界等待，不是独立后台队列。Jev的引用/概率失败保留在报告，没有降低策略换通过。详细命令、版本、结果与逐条验收见 docs/validation/JEV_ACCEPTANCE.md；模型实测与专业质量分别列状态。

### 2026-09-22：候选证据引用要在生产处闭合，不能让模型绕过悬空引用

**问题**：首轮真实Demo的517个候选全部停在MISSING_LIVE_PLAYER_CONTEXT，但快照实际有决策前本人状态；引用仍是raw frame ID，不是候选持有的Fact ID。

**决策**：adapter1.5.1在创建已有本人/人数事实时绑定快照引用，事实自身保留原始source refs。旧1.5.0/1.4.0历史不重写。CandidateGenerator2.2.0只传递已经存在、明确属于所选玩家且有独立来源/合法窗口的结构动作；其他玩家动作过滤，不把传递接口描述成接触检测器。

**验证**：新真实复验仍0可评估，但拒判准确分为354个场景外和163个缺动作；1937断言通过。完整pnpm check为982测试通过、5既有跳过，tsc与Web生产构建通过；Viewer的vue-tsc和生产构建也通过，全部在任务工作树。

**限制**：没有shot shooter或observer-scoped接触/曝光事实，仍不能生成真实再次接触动作。动作传递和引用修复是必要工程步骤，不能代替信息来源。专业标注/具体报点语义也仍缺失。

### 2026-09-22：不能把PATH缺失误判为工具链缺失，也不能把shot/spotted当作peek

**问题**：续轮初查只用默认PATH，误以为缺WASM工具链；源码实际在weapon_fire已有明确pawn，射手属于可编码的漏字段。同时USER_CONTEXT只有opaque引用，模型无法区分不同报点内容。

**决策**：重新核对既有build脚本的`~/.cargo/bin`配置与一手源码，采用0007加法补丁保留shooterSteamId，unknown=null；adapter仅输出明确本人WEAPON_FIRE事实。原schema不读取射击目标、不推断接触。增加封闭UserTacticalContext并严格维持用户陈述来源；有内容才用v2模型投影，无内容v1/cache不变。

**验证**：offline WASM构建、Rust序列化、patch幂等与工具7测通过；真实Demo1242shots全合法actor，十玩家1937断言与整场覆盖通过，但163个优势窗口仍缺独立接触动作。封闭报点两例新增真实Jev调用都拒判信息不足；累计16次，估算$0.003287592。987项测试、tsc、Web与Viewer生产构建通过。

**限制**：一手资料明确spotted不是LOS/FOV；射击和雷达信息不能直接成为真实重复peek标签。类型/适配/接口改善不等于新事实已经存在，也不等于专业质量。新报点schema未接新增用户UI或任意自由文本解析。后续需要可靠接触/曝光事实或可追溯人工标注，以及独立教练留出集。

### 2026-09-22：凭证缺失与JSON模式契约应在明确配置路径上核实

**问题**：任务进程未注入生成key，但主工作区已有合法localhost provider配置；只查process.env造成“无可用凭证”的过早结论。对照生成请求又缺少官方JSON模式要求的显式JSON指令，前四次返回400。

**决策**：仅通过显式路径流式读取具名key/model，不复制配置、不输出key；补JSON指令、与既有provider一致的非思考模式，分别记录请求模型与服务端实际返回标识。失败证据保留，不改成零费用或成功。

**验证**：DeepSeek两次真实同packet对照成功，返回deepseek-flash，1933/2002ms、3618输入/1050输出tokens，两例均UNKNOWN/INSUFFICIENT。加了请求JSON关键字和服务端模型provenance回归。全部provider累计22次（Jev16、生成6含4失败），Jev已知估算$0.003287592，生成及全部provider总费用未知。

**限制**：只有两个同组synthetic报点案例，不是专业留出；服务端Flash标识不是不可变模型权重版本。真实接触事实、专业标注和用户报点入口仍未获得验收。

### 2026-09-24：实验调用要限制整段等待，实验候选不能吞掉基线讲解

**问题**：评估最多10次串行本地请求，每次上限3.5秒，旁路也可能拖住开始复盘约35秒。请求次数门还在保存产物和重复请求复用之前，预算用完时会错误跳过无需付费的结果。另一处真实功能回归是 RETURN_AND_FIRE 提名抑制同一时刻的独立 WIN_RATE_DROP，但自身在基线为 NO_TEACHING_VALUE，从而让默认路线少讲一段。

**决策**：准备阶段改为最多2个并发、配置后6秒总体期限，保持10个独立请求上限、零重试。每个包共享一次请求，候选绑定独立，输出顺序稳定；期限到达保留已完成结果，剩余明确记录 SESSION_TIME_BUDGET。用户取消终止准备，迟到结果不能再写入。Adapter 1.6.1 将实验返回开枪候选排除在独立胜率窗口的抑制条件之外，保留1.6.0历史读取。

**验证**：先分别复现6秒仍未完成、预算阻止保存结果复用，以及明确射手归属将原1个cue变为0个的失败，再修复。新增8项调度测试覆盖总体期限、并发、同包复用、预算后复用、顺序、取消和晚到响应；重合候选测试同时检查原cue与segment保持。`pnpm check`：135文件/1,039测试通过，5项既有跳过，TypeScript及Web production build通过。桌面unit：14 runtime、21 prepare/IPC、1 stub、44 Rust通过；Viewer与desktop prepare构建通过，真实sidecar正常及decision-pilot两种启动均通过，测试数据和进程由harness清理。

**限制**：这些改动提升准备速度和基线稳定性，没有新增Jev专业准确率证据；本轮不重复调用已知只能拒判的真实输入。当前非用户观察只投影元数据，缺少空间/主体语义，需后续独立设计有用且不越界的表示。取消不能保证上游已发生费用被撤销。未做本轮完整WKWebView视觉走查、应用安装或发布。用户要求审查聚焦实际功能，本轮没有新增产物哈希审计。

## 5. 常用问题排查表

| 现象 | 首先检查 | 常见根因 | 不要做什么 |
|---|---|---|---|
| 跳到教练片段时人已经死了 | cue 的 pre-roll、seek 落位、旧 PLAYBACK_STATE | 旧 tick 被 reducer 当成新 seek，或 replay 从 outcome 开始 | 只把常量从 1 秒改成 2 秒 |
| 显示两条进度条或两套快进 | Host 与上游 Viewer 的控制面 | 上游 UI 未被适配到唯一时间轴 | 保留两套并让用户自己猜 |
| 手动跳转后 HUD/侧栏错位 | PLAYBACK_STATE.canonicalTick 与 UserTakeover | UI 仍在跟自动路线而非真实播放头 | 在各组件单独维护本地时间 |
| 教练泄漏未来信息 | CoachingPackage、Outcome gate、claim refs | 全知 Replay 或曲线结果混进决策侧输入 | 仅在地图上藏几个敌人图标 |
| 教练说得太学术 | facts / behavior / advice 三段 | Narrator 直接复述抽象字段 | 让 LLM 自由发挥而不提供术语约束 |
| 胜率曲线不可信 | manifest、模型 SHA、parity、事件并发 | 使用了假曲线、错误量化或过度归因 | 只展示单个百分比、不说明局限 |
| Cloudflare 构建找不到 Viewer/模型 | asset sync、/cs2d/ base、大小检查 | 只在 localhost 准备了生成物 | 手动把大模型或 source tree 塞进仓库 |
| 本地能跑、真实比赛失败 | warnings、round 0、null winner、缺字段 | fixture 假设过强 | 为了让 UI 不空而补造事实 |
| key 出现在构建物或日志 | local secret 文件、Cloudflare Secret、scan | 使用了 .env 或公开浏览器变量 | 把 key 写进 README、patch 或前端变量 |

## 6. 每次大更新的最小检查清单

- [ ] 这个变化是否改变了长期模块、契约、信任边界、模型职责或部署边界？如果是，先更新 ARCHITECTURE.md，必要时新增 ADR。
- [ ] 本文是否新增了一个可复用的“问题 → 决策 → 验证 → 限制”记录？
- [ ] 是否仍然只有一次 Demo 解析、一个 canonical tick 空间和一个用户可见播放头？
- [ ] 是否验证了全知显示与决策侧证据边界没有串线？
- [ ] 是否保留冻结时间自动跳过、低价值区间显式标记、完整时间线覆盖和结果后讲解？
- [ ] 新模型/新资源是否有版本、来源、哈希、大小和降级策略？
- [ ] 是否更新 THIRD_PARTY_NOTICES.md，并确认没有复制未授权 UI/运行时？
- [ ] 是否至少跑了相关单测、typecheck、production build；涉及真实数据时是否跑了 test_demo.dem？
- [ ] 是否记录了失败、超时、性能数据和剩余限制，而不是只记录成功？
- [ ] 是否检查了 secret，不把 key 放入 Git、日志、构建资产或浏览器变量？

## 7. 新记录模板

复制下面的模板追加到“已学到的关键问题与结论”中：

~~~md
### YYYY-MM-DD：简短标题

**触发**

用户反馈、真实 Demo、线上日志或测试暴露了什么问题？

**决定**

采用什么方案？为什么不采用看似更简单的方案？

**落点**

涉及哪些模块、契约、ADR、脚本或资源 manifest？

**验证**

跑了哪些测试、真实样本或截图？结果是什么？

**限制 / 下一步**

什么还没有解决？下一步最小可验证动作是什么？
~~~

## 8. 关联文档

- [长期架构](../ARCHITECTURE.md)
- [产品需求](../PRD.md)
- [MVP 范围](../MVP_SCOPE.md)
- [ADR-0001：全知地图与观察者知识分离](./adr/ADR-0001-ground-truth-map-and-observer-knowledge.md)
- [ADR-0002：采用 cs2d 回放底座](./adr/ADR-0002-adopt-cs2d-localhost-playback-substrate.md)
- [PixiJS 回放 PoC 实验记录](./experiments/pixi-playback-poc-2026-08-13.md)
- [第三方来源与权利记录](../THIRD_PARTY_NOTICES.md)


## 2026-09-25：真实带看启动与已看教学点回访

- **问题**：真实9回合Demo在默认RULE_BASELINE完成本地CS-Net、Director和前两段Narrator后卡在“正在提交可恢复起点”。实际prepareRoute添加decision_assessment_run，但FrozenReviewPlan的严格schema仍拒绝该字段；旧恢复测试直接使用Adapter计划，漏掉生产编排边界。
- **决定**：显式加入可选、有界的audit投影，保留旧记录兼容与严格未知字段/Replay/secret拦截；不删除新产物、不使用passthrough。Host捕获同步构造失败并给出准备失败状态。新增测试经过实际prepareRoute→buildSessionRecoveryRecord→JSON→restore，而非只验证手写旧计划。
- **第二个问题**：首cue讲解后自由后退15秒→“讲解最近教练点”，真实页面旧逻辑从R1直接跑进R2且没有返回讲解。ManualCueVisit重置了完成门，但TICK复用了全局revealed标记，跳过本次结果生命周期。
- **决定**：每次匹配当前cue的manual visit重新进入结果门；复用已有讲解，保持默认游标、全局消费/呈现/习惯去重。没有新增播放控制体系。
- **验证**：两个回归先红后绿；恢复用例原始失败为frozenReviewPlan.decision_assessment_run unrecognized key，回访用例原始失败为PLAYING而非REVEALING。相关28文件274测试、历史库及Host恢复7文件46测试通过；TypeScript通过。真实Edge localhost已观察正常启动、首cue结果后停靠、修复前跨cue、修复后停回同一决策点、返回默认顺序与重播完成。
- **限制与教训**：本轮provider凭据为空，只有本地确定性回退，不构成Jev教学质量提升证据。CUA浏览器连接失败后使用原生Edge；Vite两次依赖优化热重载中断Demo后改用现有静态Viewer，避免混入测试基础设施故障。普通localhost浏览器恢复与桌面SQLite历史UI需分别报告。刷新重选Demo已恢复原暂停点并继续至R9，四个教学点全部经过后到达“复盘完成”；生产build通过，详见[完整验证记录](validation/FULL_REVIEW_RELIABILITY.md)。补充准备失败时取消本代编排，防止晚到讲解覆盖错误状态；编排集成16测试通过。


## 2026-09-25：普通暂停不是退出教练

- **问题**：底部pause/play和seek共用无差别issueUserCommand→markUserTookOver，普通暂停触发Agent接管并取消manual visit。上一轮真实R2已有证据，本轮先将原行为无改动提取到实际Host使用的入口，回归出现1失败/24通过：暂停再播放后freeViewing仍true。
- **决定**：Host拥有瞬时transport暂停/ACK与控制epoch，Session继续权威拥有phase、路线、进度和结果门。暂停时冻结TICK/自动directive/自动skip；同一transition续播不重跑seek。快速pause/play先排空暂停确认，迟到回报不改变意图，functional updater再核对epoch。没有新增Session phase、持久化schema或模型调用。
- **入口一致性**：时间轴、拖动和±15秒使用同一显式seek入口。只读独立审查发现无Session时pause latch会拦住旧独立seek路径，已修复并补对应回归。返回默认路线await也检查控制epoch，防止旧恢复撤销新选择。
- **教学停靠取舍**：通用播放按钮在教学停靠/缓冲等非主动播放阶段禁用，用户使用既有卡片回看/继续，不让raw play绕过Outcome gate。已有Stage3教学工具播放时也不能用这个按钮暂停，可用自由seek接管取消；本轮没有重写工具播放生命周期。
- **验证**：8文件105相关测试、TypeScript和production build通过。包含默认及已看manual结果窗口暂停，暂停期间旧大tick不推进、门不提前开放、续播只play且恰好一次完成，free seek仍接管，无Session seek正常，快速暂停续播/更新epoch和延迟自动skip。
- **环境限制**：初次真实页面验收受阻（后已补验通过）。Edge原生连接持续超时；内置浏览器能返回localhost DOM/截图，但文件入口的AX、DOM和坐标点击均报告目标不可用，未能导入Demo。后来工具明确报告Mac锁屏，三轮后goal进入blocked；15:23原生Edge控制恢复后，复用单控制器与一个新InPrivate窗口完成原四条UI验收，没有把上轮UI结果或自动测试替代实际交互。详细状态见[本轮证据](validation/GUIDED_PAUSE_RESUME.md)。

- **补验结果**：默认片段暂停6秒保持同一点，Space续播保持带看；真实结果窗口8995暂停后Return续播、完成后回8969；已看cue manual回访9004暂停6秒后续播停回8969，返回默认恢复R2 2/4；暂停后显式后退15秒进入自由查看并保持6秒。四条真实路径通过，无新增代码改动，不重复已通过的105测试/TS/build。窗口和服务已清理。键盘Space/Return沿同一button入口工作，完整证据见上链。


## 2026-09-25：教学演示暂停必须保持同次工具身份

- 问题：Stage3慢放/道具轨迹在Session的PAUSED_FOR_COACHING中播放，但Host把该阶段全部禁用；原Controller按10秒墙钟等待ACK，单纯暂停Viewer会被当成失败。仅开放raw play还可能越过教学门、重启或接管原调用。
- 决定：Controller拥有同次工具暂停意图，只有POSTED后的播放工具暴露控制；session/run/cue/callId/generation绑定，暂停不改Session或Graph、不重新START、不重复呈现/Memory。Viewer补丁0008维持活动对象，守住nextTick和完成watch；计时仅消耗活动时间，slow预算覆盖0.5倍速的实际窗口。
- 生命周期复查：contentWindow在iframe重载后仍存在，不能作为旧工具连接身份仍有效的证明；load/error明确通知Controller进入恢复。RESULTED持久化期间取消/重连也必须在await后重新核对token和pending对象；两处已由回归复现并修复。
- 验证：原Host门禁红测试失败后修复；额外生命周期4红→4绿。相关156项、Host TS、Web生产构建以及Viewer TS/构建的最终结果见[验证记录](validation/TEACHING_PLAYBACK_CONTROLS.md)。真实Agent runtime集成验证单次派发、单次RESUME/完成计数；两种Viewer播放工具由补丁原始helper行为测试覆盖，不等于真实UI完成。
- 限制：实际已有Demo进入teachingDiagnostics=off、完成本地解析和CS-Net后只观察到首个静态讲解点，未确认活动播放工具；随后Mac锁屏，无法完成暂停超过旧超时后续播的UI验收。不得将零capability FINISH的“教学工具已完成”文案视为实际演示证据，不为找通过案例放松教学门或强制注入工具。原目标保留未完成。


## 2026-09-25：流程完成不等于演示成功

- 问题：实际页面首个静态讲解点显示“教学工具已完成”，但没有工具执行证据。Controller把零capability、Policy主动FINISH以及失败工具的正常Graph收敛都设为COMPLETED；Host据此统一显示成功。toolHistory缺少visit身份，也不能直接拿旧cue的tool/presentation推断本次结果。
- 决定：仅新增瞬时completionNotice，生产结果入口绑定session/run/cue/generation/visit及已校验call结果。成功需本次SUCCEEDED且completed；失败结果即使流程收敛也显示未完成。无需工具需最近对应POLICY的无选择记录及无当前工具结果/历史，恢复信息不足保持中性。Host用同一投影函数渲染，并按身份阻止旧成功或详情泄漏。
- 验证：4文件84相关测试、TS与Web生产构建通过；真实内存Graph测试实际零capability/主动FINISH/成功ACK后接入渲染投影，另覆盖失败、取消、回访切换与未知恢复。详见[验证记录](validation/TEACHING_COMPLETION_STATUS.md)。
- 限制：没有启动浏览器或真实Demo；此窄文案修复不证明原暂停/继续A5已通过，不产生模型质量提升结论。不改Graph生命周期、Session门、预算/计数或持久化，保持原aria-live、布局、键盘及辅助样式。


## 2026-09-25：公开回合时钟必须使用服务器时间域与已到期采样

- 问题：DecisionSnapshot.remainingSeconds一直null；沿最终回合长度反推会引入后见之明，round_start.timelimit在真实样本中为0，也不能当默认时长。Demo tick与server netTick存在偏移。
- 决定：源头native探针一次确认GameRules duration/startTime与ServerInfo interval；parser补丁0009在on_tick_end附加可选clock。Adapter严格检查同回合、非未来/新鲜样本、阶段、暂停历史、连续网络时间，仅把计算后的约秒公开事实交教学包。原始网络字段不进入模型。未知/冻结/植包/暂停及补偿不明时不计算，旧回放正常unknown；不改变objectiveAllowsDelay与专业判断门。
- 验证：已有Demo源头探针1.45s；最终单一WASM消费链一次解析6185ms、至教学包6351ms，44候选中38个snapshot有效，4cue中3个CoachingPackage含约秒事实，历史往返通过。148测试通过/1个既有缺WebGPU产物对照跳过；TS、Web/Viewer构建与Viewer TS、Rust现有1测试通过。细节见[验证记录](validation/PUBLIC_ROUND_CLOCK.md)。
- 学习：公开HUD值可被观察，不意味着所有GameRules原始网络字段都是玩家知识。必须分开数据来源、时间可用性和知识边界；累计暂停字段没有可证公式时宁可缺失。构建还需同步重新编译parser WASM，否则源代码加字段不会在Worker落地。
- 限制：没有真实暂停段HUD对照，早期缺暂停字段也会禁用整份Demo后续时钟；没有C4精确计时和HUD取整复刻。两次读取分别用于源头可行性与最终一次解析消费，未重复大模型实验、导出bulk或操作浏览器。覆盖率改进不等于教学准确率提升，原工具暂停A5仍独立阻塞。


## 2026-09-25：WASM源码落地需要同一套可执行工具链

- 问题：Viewer开始默认编译parser后，desktop CI只装Apple Silicon Rust target，没有WASM target和匹配bindgen。普通shell与构建PATH还可能分别选中Homebrew和rustup；已安装某个target不意味着实际编译器可用。Rust setup action默认-D warnings也会把上游parser的deprecated warning转成失败。
- 决定：沿用CI Rust1.89.0，显式补WASM target和固定CLI0.2.125，匹配版本不重复安装，保留桌面-D warnings，仅parser Cargo子进程追加--force-warn deprecated使上游弃用警告保持可见。共享只读预检在parser cwd解析active toolchain，检查锁文件、所选target及实际版本，并将绝对Cargo/rustc/CLI用于同一次构建。禁用隐式安装、不升级用户工具；desktop:prepare先预检，失败给操作指引。
- 验证：21项命令探针/patch测试通过，真实CI安装shell在隔离假工具PATH中验证缺失/错版/匹配三种分支；pnpm cs2d:check、真实parser/Viewer构建、TS/Web生产构建通过；收到作用域复查后只重验相关工具链测试与-D warnings父环境的实际parser构建，确认不改桌面警告策略。见[验证记录](validation/PARSER_TOOLCHAIN.md)。
- 限制：真实本地编译为已有Rust1.97.1/CLI0.2.125；CI1.89沿用现有固定版本且满足已核对的依赖声明，但没有在本轮安装1.89或运行GitHub CI/desktop发布。没有改架构边界、模型或原锁屏A5，所有子进程退出并释放写入。


## 2026-09-25：服务端模型期限不能代替Host transport期限

- 问题：Director/Narrator服务端15秒timeout不覆盖客户端fetch或正文挂起。两个生产client seam在非协作fetch/JSON测试中4红，阻塞路线或首两cue准备。
- 决定：仅这两个客户端共用20秒fetch＋JSON总期限，保留LOCAL_REQUEST_TIMEOUT原因、原确定性fallback/schema/引用门，不新增重试。父取消单独结算AbortError并传播子signal，不等fetch自觉结束；所有结算清理timer/listener，late headers不读body、late reject被处理。Controller取消后不再进入额外fallback。
- 验证：5文件69测试通过，TypeScript和Web生产构建通过；真实prepare controller＋两个生产client timeout仍可冻结3-cue完整路线、首两cue READY_TO_START、后续继续准备；实际恢复依赖复用已存内容零请求，取消/late不发布。共享deadline19999ms headers＋1ms body边界、原HTTP/坏正文/正常映射亦覆盖。详见[验证记录](validation/PREPARATION_REQUEST_DEADLINES.md)。
- 限制：全部为有限假transport与合成数据，不证明生产网络延迟、教学质量或整段启动SLA；没有改Jev路径，没有模型/浏览器/Demo/数据库调用。原锁屏工具A5不动。只读竞态复查无确定缺陷，测试替身类型问题已用真实Response修正，未弱化生产类型。


## 2026-09-25：逐次本人受击必须先验证handle编码，再进入教学

- 问题：player_hurt原来只入ADR聚合，Adapter只能用8Hz健康区间。事件native handle与网络packed handle编码不同，直接完整比较得到0归属，按index查又可能误认复用实体。
- 决定：依据SDK维护者ToPackedInt/FromPackedInt及真实首事件，转换native15位index/17位serial到packed14位index/低10位serial，核对当时pawn与唯一controller绑定，未知不猜。新增独立hurt流在ADR过滤前采集，原事件索引和ADR代码保持；reported伤害不等于实际扣血。严格决策前10秒/最多3条本人发生事实，结果独立，精确事件覆盖的健康区间抑制重复。
- 验证：最终一次真实WASM 7247ms，总消费7464ms；264hurt归属成功、本人27，23/44候选snapshot与2/4教学包/确定性Narration消费，2/4结果包消费。相同Replay去掉新流是0snapshot/0包，候选路线不变；两包仍INSUFFICIENT_EVIDENCE。182相关测试通过/1既有缺产物跳过，Rust3、TS/Web build/Viewer TS/WASM+Viewer build通过。详见[验证记录](validation/SELF_HURT_EVIDENCE.md)。
- 学习与限度：编码一致性和当前绑定比“字段存在”更重要；只验证wire携带的serial位。事件发生/报告伤害/实际HP减少必须分开；上下文覆盖增加不等于教学准确率提高。恢复保持旧产物，不自动补新事实。没有外部模型或UI测试，原工具暂停A5未关闭。
- 执行偏差：初次native探针后，获准首事件诊断时发生编译失败后误运行旧binary，额外全量读一次，已报告；改成build成功门后首事件即停。真实读取总计原probe、误运行旧probe、首事件诊断、最终WASM四次，不掩盖为一次。bulk均留在进程，只有小摘要；源码探针已从上游bin移走，所有进程退出。


## 2026-09-25：射击身份与几何必须来自同一即时pawn

- 问题：weapon_fire的几何按index-only get_by_handle取实体，身份从tick_start缓存取SteamID。直接编译生产分支/helper/source2 lookup的合成实体生命周期夹具7项中6红，确定性复现同index serial复用、当前绑定换人/解绑/冲突、非pawn及不可表示native index的错身份或错几何；不声称已有真实Demo已出现错误。
- 决定：0011只迁移weapon_fire到共用verified_event_pawn，返回同一有效pawn和可空当前owner。无效pawn不出shot，有效pawn/未知owner保留几何和null；hurt wrapper语义等价，其它共享旧归属调用方及network m_hThrower不动。只核对wire低10位serial。新shot-identity.v2与hurt-events.v1并存，不把版本后删除事件导致的索引变化伪装成跨版稳定。
- 验证：同一原7测试变绿，加2项连续生命周期/signed handle后9通过；parser Rust3、相关186测试/1既有缺产物跳过、Host/Viewer TS、Web与真实WASM/Viewer构建通过。一次真实WASM解析6141ms、消费6311ms；1242shot有actor、本人152入时间线、2 RETURN_AND_FIRE、44候选4cue；hurt264/本人27/23snapshot/2包及clock38snapshot/3包保持。见[紧凑记录](validation/CURRENT_SHOT_IDENTITY.md)。
- 限制与清理：相同计数只证明样本兼容，不是actor准确率或专业教学质量提升；unknown由生产路径fixture覆盖，实际Demo无null。无native探针/模型/UI/用户DB/安装/发布，不检查全部事件生命周期，旧A5不动。独立默认配置5分钟只读终审无阻断；编译成功门后才消费WASM，所有进程退出、临时目录自动清理，push后释放写入。


## 2026-09-25：道具数量必须独立于全库存总数与未知库存

- 问题：Host和rich诊断均对inventory全量求和，WEAPON AK-47被标为1颗道具；Adapter无grenades时inventory为空但missing_fields含inventory，旧计数却报0。两条真实消费者4红/20旧测试绿，明确复现。
- 决定：共用projectDecisionUtilityCount，只认明确UTILITY/GRENADE，已知非道具不计，未知类别或部分/缺失/不支持数量使计数整体未知。新增optional utilityCount与0..64整数strict schema；32条/64数量只是已有诊断传输边界。legacy inventoryCount保持可读且不重新解释，新诊断显示未知，已存测量原样恢复。未知说明有界，不改风险阈值/判决资格。
- 验证：6文件79测试、TypeScript、Web生产build通过。Host→strict事件/remote envelope→真实内存Graph→确定性POST与本地rich一致；重复dispatch无额外attempt/trace，真实保存结果恢复0/2和legacy1.5原样、零fetch；组件SSR显示0/2或未知并保留继续。原4红已绿，风险status/Verdict除新增limitations外保持。见[验证记录](validation/DIAGNOSTIC_UTILITY_COUNT.md)。
- 限制：上游若先过滤坏项却没标缺失，本层不能恢复其完整性；本轮只修诊断，不拓展Parser或其它资源语义。没有模型/Demo/浏览器/DB/Memory/发布操作，原锁屏工具A5不动。按两项UI技能保持既有布局/辅助入口，SSR不冒充浏览器验收；所有测试/build退出，主任务自行复查，无代理，push后释放写入。


## 2026-09-25：诊断资源必须绑定当前回合与新鲜样本

- 问题：Host只取player的最后一个不晚于decision的state，无age/round门。真实Host→diagnose合成回归先2红：64tick/s下33tick旧样本和round2 decision1601前的round1样本1599都被报为当前血量/库存/资源SUPPORTED；不声称真实Demo已误诊。
- 决定：cue→segment→唯一当前round绑定，freeze包含/end半开，合法tick/rate及ceil(rate/2)年龄门，存活/必需字段/missing和已到期死亡边界；已有snapshot必须同身份/采样时间/OBSERVABLE且不能绕过missing。通过的同一state供rich与compact，测量只留其source refs。独立decisionRoster保留无本人资源时的可信当前公共人数，新优先旧兼容，不合并引用。
- 复查：默认只读代理发现结果已读新roster而Verdict/Transfer仍读旧字段，2个新旧0/2冲突回归先红后绿，统一selector保持原INCONCLUSIVE与规则；补unknown side门。新增未知说明触发GET_INFO/DELAY限制数组超12的2红，预留执行器说明容量后修复，不改变专业判断阈值。
- 验证：7文件147测试、TypeScript及Web build通过；实际Host→strict event/remote envelope→内存Graph及确定性POST与local rich的result/verdict/transfer一致，合法facts保留、引用分离、重复事件幂等，旧保存测量恢复零fetch原样。SSR有未知说明和继续按钮；详见[记录](validation/DIAGNOSTIC_RESOURCE_FRESHNESS.md)。fixture共享round数组导致的3个假失败已用独立克隆修复，未改生产来迁就测试。
- 限制/清理：Host拥有时间可信门，低层rich调用仍依赖调用方可信输入；旧历史不追溯修正。无Demo/模型/浏览器/服务/用户DB/发布，Parser/Viewer与原工具A5不动，不以测试声称专业准确率提升。所有检查进程退出，忽略目录仅小日志，commit/push后释放写入。


## 2026-09-25：整体样本可信性不等于所有资源字段齐备

- 问题：新鲜正确身份的70HP/80甲样本因snapshot helmet=null/missing被整份丢弃；实际Host两例先红。不能撤掉时效门或补false来救显示。
- 决定：保留整体round/player/时间/唯一采样/死亡/snapshot门，随后按字段保留已知值，primitive与同tick snapshot不一致或显式unknown则只省略该字段。H/A/helmet改optional，Host本地与远端共用compact，不再传rich；显式compact不被legacy rich默认值补全。资源背景沿原45/0/false与ECO/FORCE阈值做受限/未受限/未知三值，partial高值和FULL-only不能证成充分，Verdict保持INCONCLUSIVE。
- 复查：默认只读终审发现raw明确0HP被snapshot冲突降为unknown后可绕过旧死亡矛盾门，组合先1红/1绿，检查前置后闭合；缺失标记的默认0仍不当死亡。库存只沿既有数组可用性/分类规则，不泛称全部资源冲突已审计。
- 验证：7文件177测试/TS/Web build通过；Host→strict事件/envelope→内存Graph及确定性POST的partial/full/all-unknown/known-false与本地结果一致，旧utility/roster规则保持；partial及旧保存测量恢复原样零fetch，SSR显示70HP/80甲与头盔未知并保留继续。见[记录](validation/PARTIAL_DIAGNOSTIC_RESOURCES.md)。
- 限制/清理：无Parser/Viewer/全域类型重构或Demo/模型/浏览器/用户DB/安装发布，原A5未验，不以测试声称专业质量提升。原历史不追溯修正，库存跨视图内容未检查，低层rich仍由调用方保证上下文。所有检查进程退出，仅忽略目录小日志，commit/push后release。


## 2026-09-25：真实正式cue验证必须区分已知人数与未知接触

- 真实收益：当前9回合/44候选/4正式cue全部以age0样本进入Host；资源分别5HP68甲、20HP48甲、100HP100甲、73HP97甲，头盔均true。第2cue库存未知但其余资源保留，第三cue真实存款0保留；独立存活队友4/0/0/0。人工RISK/TRADE探针不是用户意图，所有Verdict INCONCLUSIVE。
- 问题/修复：第1cue已知4名队友，TRADE文案仍说缺少是否存活。最小投影先1红后绿，现明确4人已知，仅视线/接战窗口待确认，并加入roster refs；不改status、Verdict或阈值。修复后只复放捕获小投影，不再解析Demo。
- 验证：第二次成功解析6079ms/至消费恢复6317ms，AnalysisBundle/Host输入往返一致；8个诊断输出恢复保持measurement/gate，额外diagnosis0/fetch0，16次确定性本地/compact消费。真实缺陷修复后180相关测试、TS/Web build通过。详见[完整证据](validation/REAL_CUE_RESOURCE_CONSUMPTION.md)。
- 脚本教训：首smoke只有自动freeze skip，首次真实读取后恢复helper在普通SKIPPING误用ADVANCE_SEGMENT，且最后才输出摘要导致证据丢失。已立即报告；改用生产SKIP_SEGMENT、补普通skip和双cue smoke、先输出每cue证据/隔离恢复失败后，获协调明确授权补一次。总计2读，非一次；没有因此修改产品Session或伪造暂停状态。
- 限制/清理：真实4cue没有unknown/false helmet、过期或跨回合拒绝、已知道具0，仍只由fixture覆盖；不声称专业质量或UI验证。无模型/浏览器/服务/用户DB/Memory/安装部署，Parser/Viewer未重建、原A5不动，无子代理。所有解析/测试/build退出，仅保留去身份小摘要，push后release。


## 2026-09-25：真实工具验收先证明存在可执行能力

- 问题：教学暂停A5原被锁屏阻塞，首cue的COMPLETED曾不能证明是否真做演示；后续完成文案已区分“无需额外演示”，仍需实际逐cue核实。
- 决定：用户续跑后只用一个可操作Edge窗口/服务控制器和原Demo一次解析，走最新4fffe02的自然4-cue路线；用Agent返回处去身份小摘要核对capabilities/effects，不注入工具、改Policy、降门或切模型。
- 验证：c1–c4均START_CUE→COMPLETED、capabilities/effects空、RESUME_TOOL为0，UI均“无需额外演示”和静态播放禁用。每cue停靠位置和摘要见[原A5续跑证据](validation/TEACHING_PLAYBACK_CONTROLS.md#2117续跑完整样本没有合法工具a5仍未通过)。该轮实际只检查工具资格，没有产品修改，不重复既有156/180测试或构建。
- 限制：桌面已恢复，但此样本无合法活动工具，所以≥12秒暂停/同次续播/工具中seek与重连仍未验收；不外推所有路线都无工具。下一步先独立复现新版teaching focus与工具旧白名单是否接线不一致，不能直接将空能力归因于事实不足；需要真实合法工具，不拿静态COMPLETED或普通Session重播代替。专用窗口和服务均清理，临时日志代码移除，原goal不标完成。


## 2026-09-25：判断类别与动作事实演示分离

- 问题：当前 Compiler 的判断类别未匹配旧战术工具规则；有本人动作且被讲解引用的 REVIEW_UNCERTAINTY 被错误地零工具结束。真实四 cue 为空只提供线索，独立 Compiler fixture 才确认这一机制。
- 决定：新增单一 ACTION_FACT_REPLAY 用途，以当前候选/冻结窗口/本人动作/讲解引用和实际结果完成边界授权。用途不升级 INSUFFICIENT_EVIDENCE，不由结果倒推动作；其他四种新展示用途暂不开放。保持旧 focus 与单工具/暂停/取消身份门。
- 验证：原主链 1 红→绿；复核发现结果末端门遗漏，2 红→绿。默认内存 Graph 自然返回真实 effect，再由 Host 绑定命令并去重；共 257 个不同相关测试、TypeScript 和 Web production build 通过。独立复核闭合。
- 限制：无真实 Demo/模型/UI 新结果，不能宣布原 A5 或专业质量提升。[详细记录](validation/CURRENT_FOCUS_ACTION_REPLAY.md)；契约以 ARCHITECTURE.md 为准。


## 2026-09-25：控制恢复只证明当前可操作，验收仍需连续证据

- 问题：新focus事实慢放接线b5da690给原A5带来新条件，21:48桌面smoke与文件选择均成功，但Demo解析完成后点击玩家时重新锁屏。
- 决定：不把前序smoke当作后续UI仍可用的保证；CUA明确锁屏后立即停止，不重复驱动/解析，不将点击尝试、旧空工具或集成自然effect当真实验收。
- 验证：基线6cb402d一次真实解析到“解析完成/10人选择”，服务小摘要仅两次IDLE，无工具或START_CUE；controller退出、端口释放，临时遥测全部移除。无产品改动，不重跑既有257用例/构建。详见[原A5记录](validation/TEACHING_PLAYBACK_CONTROLS.md)。
- 限制：原A5仍未完成，新接线真实工具效果未知；专属InPrivate因锁屏未关闭，解锁后先检查现有Replay可复用性，再继续原验收，不能为了补证无预算重解析。代码写入在文档push后释放。


## 2026-09-25：真实规则路线可自然触发动作回放

- 问题：b5da690 只通过合成主链证明动作事实演示接线；真实 UI 被锁屏阻塞，不能因此将其它项目验证全部暂停，也不能把模拟执行当 UI 通过。
- 决定：单 Node owner 一次读/解析原 Demo，顺序派生原玩家及必要其他玩家，复用生产 Compiler/Narrator/Session/Host/默认 Graph。先用两 cue/普通 SKIP smoke 验证编排；Session 自动冻结跳过与 Graph observer 分别处理，不手写结果 gate。只保存匿名小摘要。
- 验证：6255 ms 解析、7053 ms 总计，6 玩家/356 候选/16 自然 cue；P6/R1/8257–8515 的本人动作事实被 Narrator 引用，自然得到一条 0.5 倍慢放命令；15 个 cue 无 PlayerActionFact，正确 FINISH。0 网络/模型调用，外部 120 秒期限，真实阶段一次成功。Script smoke、项目/脚本 TS 与 production build 通过；构建过期 dev 类型缓存移走后恢复。独立只读复核无 must-fix。
- 限制：规则路线未运行 CS-Net/模型，与旧 UI 选点不同；ACK/进度模拟不验证真实渲染、暂停/seek/重连。Session 完成不等于 Graph 尾段/整场完成。本轮没有产品缺陷或代码修复，也没有专业质量提升结论。下一步可用现有射击小材料调查死亡/受击候选的动作绑定覆盖：Adapter 普通 shot 已进入 WEAPON_FIRE，但 hasVerifiedAction 仅 RETURN_AND_FIRE/UTILITY/非爆炸 BOMB；先证明确有合法 shot 时是否丢失传递，再决定后续工作；不把缺动作直接判成来源遗漏。[证据](validation/REAL_ACTION_REPLAY.md)。


## 2026-09-25：把已归属 shot 作为处理窗口发生事实

- 问题：DEATH/HP_CHANGE 原处理窗口有独立本人 shot，时间线已识别，却没有动作事实进入讲解。实际 Adapter→Compiler→Narrator 两类2红复现，未把15个空动作cue当成15个遗漏。
- 决定：严格 decision<shot<reveal 且早于同回合已知死亡，要求决策时存活/明确本人，不扩窗口和提名；单候选一事实、最多3原事件refs。presentationOnly标记排除两处动作排序加分及过程/结构化决策/不可回撤判断，保持旧动作缺省语义，诊断strict传输保留。Adapter/signals1.8、Generator2.4，旧1.7可读。
- 验证：326相关用例通过/1既有WebGPU产物缺失skip，TS/脚本TS/Web build通过；独立复核非法死亡时间3红→绿并闭合。原Demo一次解析6395ms、总6795ms；44候选10窗口补事实=9独立shot，四正式cue自然effect0→2（R5/c2、R7/c3），消融全部候选assessment/Director摘要/路线选点窗口不变。旧无actor和序列化恢复对照通过。
- 限制：发生事实不证明专业质量；规则路线与模型UI路线不同，ACK/进度模拟不关闭原A5，未跑新模型/浏览器/Parser重建。下一独立方向可用假provider检查Narrator是否把仅发生事实误扩写为接触/命中/错误，先合同验证而非live调用。[证据](validation/WINDOW_SELF_FIRE.md)。
