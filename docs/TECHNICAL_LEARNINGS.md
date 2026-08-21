# CS2 AI Demo Coach 技术学习与决策日志

> **状态：持续维护的工程复盘，不是架构规范。**
>
> - 长期架构唯一事实来源仍是 [ARCHITECTURE.md](../ARCHITECTURE.md)。
> - 产品目标与范围以 [PRD.md](../PRD.md) 和 [MVP_SCOPE.md](../MVP_SCOPE.md) 为准。
> - 本文记录「为什么做这个选择」「实际踩到了什么问题」「如何验证」；它可以解释架构，但不能覆盖架构契约。
>
> 最后更新：2026-08-18

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
  → 浏览器内一次解析
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
| 部署 | localhost 双进程；Cloudflare 同源 /cs2d/ Viewer | 开发调试与生产体验使用同一播放契约 | key 不能进入仓库、日志、NEXT_PUBLIC 变量或普通 .env 文件 |

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

batch8 raw-CDP 运行超过 5 分钟没有 telemetry，按时限终止；batch64 未启动，未测结果不写成性能数字。Falcons/Spirit `453,977,283` bytes 的 batch16 尝试了 CDP target、iframe-local Replay 和最后一次 Playwright Edge 启动：CDP target 在 iframe 可用前超时，首个 harness 曾因把 433 MB Replay 序列化回 Node OOM，Playwright `channel=msedge` 又在页面创建前 `SIGABRT`，所以无 Falcons WebGPU telemetry；既有 parser smoke 仍只证明约 `25.562s` 解析、10 人和 NiKo 选择。当前保守推荐 batch16，合理区间约 8–16（8 未实测），不再扩展 128/256。已知 CPU shape fallback、profiling 无 kernel 事件和 Cloudflare 26.8 MB WASM 限制均阻止切换生产默认；保留失败时独立回退到 INT8 WASM。

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

需要对 `spirit-vs-falcons-m2-mirage.dem` 做一次有界的 WebGPU FP16 batch16 验收；该文件为 `453,977,283` bytes，不能把 Replay 或逐帧数据搬回 Node。

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

修复前线上最小请求连续 3 次均为 `UPSTREAM_SCHEMA`。修复后使用本地授权 Secret 直连同一 DeepSeek 模型，响应仍为 HTTP 200/`stop`，且 `currentSituation/playerAction/coreIssue/betterPlay/outcomeImpact` 五项均为包含 `text`、`refs` 的对象；定向 Vitest 12 项、typecheck 通过。待新 Worker 发布后再运行同一线上最小请求，要求状态为 `SUCCEEDED`。

**限制 / 下一步**

真实 Demo 的完整复盘仍需抽查一条死亡 cue 和一条道具/C4 cue，确认模型在多事实、多引用时保持命名空间正确；模型再次输出非法结构时仍会可追溯降级为确定性模板，不阻塞回放。

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
