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

FP16 产物为 19,452,396 bytes，转换 manifest、FP32/FP16 CPU sanity parity、capability/session/profile/计时 telemetry 均独立记录；正式浏览器矩阵固定同一输入，执行 WebGPU batch 16/32/64/128/256 的 cold1 + warm3，并与 FP32 WASM 比较概率、swing、Director cue 和 OutcomeImpact。

**限制 / 下一步**

当前浏览器或模型若缺少 Worker WebGPU、`shader-f16`、JSEP runtime 或纯算子分配证据，继续使用 INT8 WASM；JSEP WASM 本身超过 Cloudflare 单文件限制，故 WebGPU 资产只保留本地实验。只有 parity、稳定性、纯度证据和相对现有 86.882 秒 inference 至少 1.3× 全部通过，才另开 ADR 讨论默认切换。

### 4.12 2026-08-20：真实 Edge 远程调试仍受环境阻断

**触发**

用户要求使用真实 Microsoft Edge GUI、硬件 Metal 和独立远程调试实例完成 WebGPU 结果，避免把 Playwright 的 SwiftShader 或 Chrome 结果当作 GPU 结论。

**决定**

优先尝试 `open -na "Microsoft Edge" --args --remote-debugging-port=9333 --user-data-dir=/tmp/cs-coach-edge-webgpu-poc --no-first-run --no-default-browser-check`，随后尝试绝对路径和 Computer Use；Playwright Edge 仅作为诊断，不将其失败或 SwiftShader 结果纳入性能结论。

**落点**

`tools/cs-net/benchmark_webgpu_edge.mjs` 固定 `channel=msedge`、headed、移除 SwiftShader 默认参数并使用 `--use-angle=metal`；远程调试与能力记录保存在 `.local-data/acceptance-csnet-webgpu-fp16/edge-webgpu-benchmark.json`。

**验证**

Edge `151.0.4129.93`、macOS `26.5.2 (25F84)`、Apple M1 Metal 可用。LaunchServices 报 `kLSNoExecutableErr`；Playwright headed Edge 和移除 SwiftShader 的真实 GPU 尝试均在页面创建前 `SIGABRT`。Computer Use 读取 `com.microsoft.edgemac` 时被环境权限拒绝，9333 未监听。

**限制 / 下一步**

本轮没有 navigator.gpu、adapter/device、shader-f16、ORT WebGPU session、batch 矩阵、Falcons 或截图证据；不宣称 WebGPU 性能或纯度，不改变 INT8 WASM 默认。Edge GUI/远程调试可启动后直接运行现有 benchmark harness。

### 4.13 2026-08-20：真实 Edge 能力可用但 ORT WebGPU session 未建立

**触发**

总控提供了独立 GUI Edge CDP 实例，要求在 Apple Metal 硬件路径上验证 Worker WebGPU、`shader-f16`、仅 WebGPU EP 的 ORT session 和 test_demo batch16；不得把回退结果算作 GPU 性能。

**决定**

保留 WebGPU FP16 为 local-only PoC。真实 Edge 能力探测通过后，session 创建失败即记录 `FAILED` 并回到同一 Replay 的 INT8 WASM；不继续扩展 batch 矩阵，也不改变默认 INT8 WASM `auto → 4 threads × batch16`。ORT 1.27 的 profiling surface 先按兼容方式初始化；匹配的 asyncify WASM 资产替代不兼容的 JSEP runtime 文件。

**落点**

`libs/cs-net-winrate/src/runtime-webgpu.ts`、`tools/prepare-cs-net-webgpu-assets.mjs`、`tools/sync-cs-net-assets.mjs` 与 Edge harness。FP16 模型 SHA 为 `94ef9a19ff5e3d2e122e57fd0fb2a79c670f14746d79399c1352ab9b25742f63`，大小 `19,452,396` bytes；匹配 asyncify WASM 为 `24,254,953` bytes。旧尝试和新 continuation 证据均保留。

**验证**

Edge `151.0.4129.93` 的主页面、iframe、Worker 均有 `crossOriginIsolated`、`SharedArrayBuffer`、GPU adapter/device 与 `shader-f16`；`edge-gpu.png` 记录 Apple M1 Metal 硬件加速。test_demo 真实解析得到 9 回合、7,239 个 canonical samples；batch16 进入 ORT WebGPU session 创建，随后以 `Failed to wait for the operation:3` 失败，telemetry 明确 `ortSessionCreated=false`、`providerActual=wasm-int8`、`fallbackDetection=FAILED`。控制台只有 ORT 的节点分配 warning，无 page error。Falcons/Spirit 已有一次有界解析/10 人选择证据（约 25.9s），未重复长跑。

**限制 / 下一步**

本轮没有可用的 WebGPU inference 时间、FP16 browser parity、batch32/64/128/256、纯 WebGPU 证明或 1.3× 结论；部分 shape 节点分配 warning 与 session wait failure 需要单独定位。默认继续 INT8 WASM，不把这一轮的 58.3s INT8 fallback wall time 当作 WebGPU 指标。

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
