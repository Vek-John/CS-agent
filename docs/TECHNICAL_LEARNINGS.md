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

本轮只做了一个 9 回合小 Demo 的短浏览器 smoke，没有声称完成整场长时间验收；真实语音、逐玩家 LOS、阻挡和精确接触窗口仍不可验证。另修复了旧恢复记录在 IDB request 回调中抛错导致的开发态 issue overlay，以及手动 cue visit 下提交反思被 takeover guard 静默丢弃的问题。线上部署 smoke 待本次 push 后由现有 Cloudflare Actions 完成。

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
