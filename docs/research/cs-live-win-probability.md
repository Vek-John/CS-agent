# CS 比赛实时胜率计算：公开系统与模型调研

> 调研日期：2026-08-22
>
> 范围：Counter-Strike: Global Offensive（CS:GO）与 Counter-Strike 2（CS2）的公开、可核验资料。优先使用源代码、项目文档、论文 DOI 和论文元数据；不把搜索结果摘要、博彩页面或无法核验的营销文案当作模型证据。

## 结论先说

有，但要把“实时胜率”拆成不同层次来理解：

1. **确实接入实时 CS2 比赛的公开系统**：[Eon](https://github.com/mortenlein/eon/tree/61759cd8376eb2fa8b3542e2242c38d2fd002b98) 通过 Valve Game State Integration（GSI）接收本机比赛状态，以约 20 Hz 向 HUD 推送，并显示胜率。源码表明它的胜率是“存活人数 + 总生命值 + 炸弹倒计时”的启发式，不是已公开训练和校准的机器学习模型。
2. **曾用于真实直播、但闭源的系统**：[BLAST.tv 的官方文章](https://blast.tv/article/blast-fall-final-2023-innovations) 说明其 Fall Final 2023 直播重新引入了自研的回合结果 AI 预测；文章没有公开模型、训练数据、接口或校准指标，并承认预测可能明显出错。
3. **最完整的公开 CS2 模型候选**：[Evalbar](https://github.com/eigenpaul/cs2-evalbar/tree/a50a83057fde7d5c66d9af8d3f2bb262d4fcb406) 有因果时间窗口、神经模型、校准和分阶段验证，但当前明确是对 `de_inferno` `.dem` 的离线分析，没有实时 GSI 推理服务。
4. **比赛级实时系统**：[Esports Analyst](https://github.com/OlegMarko/esports-analyst/tree/38400fae1ef8df9ea716281589bf4e4908e538b7) 接收 Faceit webhook，并以轮询补齐活动比赛，给出基于 ELO 和近期战绩的两队比赛胜率；它不读取回合内状态，因此不是 round win probability。
5. **另一个公开原型**：[WPAModelCSGO](https://github.com/nkashyap14/WPAModelCSGO/tree/72232f47de292e6333b5614d491a7e81cf0a389f) 用 XGBoost 从回放 tick 提取特征并输出一侧的 round-win 概率；代码是回放/训练管线，没有实时输入端点，CS2 分支也仍像研究原型。
6. **实时架构示例但不是已验证的生产模型**：[esports-live-analytics](https://github.com/rustkas/esports-live-analytics/tree/e19a1bd99ec32cbc069c52a0dd7b8c6ad2343856) 有事件摄取、状态消费者、预测 API 和订阅，但当前 `RuleBasedEngine` 明确是 `v0.1.0-baseline` 规则引擎，README 的延迟数字是项目目标/自述，且示例输入是合成事件。
7. **学术上已有 CS:GO 胜率研究**，例如 Xenopoulos、Freeman、Silva 的 Web Conference 2022 论文；但论文证明的是“可以从游戏状态估计某一时点的胜率”，不等于公开了可直接接入比赛的低延迟服务。CS:GO 的实时遥测研究也存在，但有些预测的是下一次死亡而不是胜负。

因此，对“有没有系统”的直接回答是：**有公开的实时显示系统，也有公开的离线模型；目前没有在公开一手资料中核验到一个同时具备 CS2 实时接入、公开模型权重、独立校准结果和可复现实测延迟的完整开源方案。** 私有转播/数据供应商可能有商业系统，但本次没有把未公开实现当成事实。

## 先统一几个定义

- **实时系统**：有正在进行的比赛状态输入（例如 GSI 或事件流），有在线推理路径，并持续发布新概率。单纯对 `.dem` 按 tick 计算，不算实时部署。
- **更新粒度**：输入频率、模型触发频率和 UI 推送频率可能不同；“20 Hz HUD”不代表模型每 50 ms 都重新训练或产生独立新信息。
- **输出对象**：下表中的大多数输出是“当前回合某一方赢下 round 的概率”。这不是 BO1/BO3 系列胜率，也不是整场比赛最终获胜概率；后者需要把地图、经济和系列规则另建一层状态模型。
- **概率质量**：是否有 `log-loss`、Brier、ECE、留出集和时间切分，决定概率能否用于决策。一个看起来平滑的百分比不等于校准概率。

## 候选对比

| 候选 | 版本/快照 | 输入 | 更新粒度与延迟 | 输出定义 | 公开程度与证据强度 | 主要限制 |
|---|---|---|---|---|---|---|
| [Eon](https://github.com/mortenlein/eon/tree/61759cd8376eb2fa8b3542e2242c38d2fd002b98) | CS2；commit `61759cd`（2026-06-27） | 本机 GSI JSON：玩家状态/位置/武器、生命值、炸弹、地图、回合 | 配置 `throttle=0`；服务端 websocket 广播上限 20 Hz（50 ms）；端到端实测未公布 | CT 当前回合胜率 `0..1`、历史曲线、回合结束 0/1 和 swing | 公开源码；“实时系统存在”证据高，“概率有效性”证据低 | 启发式；未见训练集、校准、独立准确率；忽略大量战术/经济信息；不是系列胜率 |
| [BLAST.tv AI prediction](https://blast.tv/article/blast-fall-final-2023-innovations) | CS2 广播；官方文章 2023-11-21 | 直播制作链路的内部比赛状态（细节未公开） | 官方称用于 live broadcast；更新频率和端到端延迟未公开 | 回合结果预测/解说辅助 | 一手官方存在性证据高；可复现性和模型证据低 | 闭源；无公开权重、数据、API、校准或独立评估；官方承认会出错 |
| [Esports Analyst](https://github.com/OlegMarko/esports-analyst/tree/38400fae1ef8df9ea716281589bf4e4908e538b7) | CS2/Faceit；commit `38400fa`（2026-05-20） | Faceit webhook 的比赛/阵容，以及 Faceit API 轮询 | webhook 在 READY/ONGOING 事件触发；轮询任务每 5 分钟；没有回合/tick 流 | 当前整场 Faceit match 的 team A/B 概率、confidence、误差范围 | 公开源码；在线链路证据中等，概率有效性证据低 | 60% ELO + 40% 近期战绩；无公开留出集/校准；依赖 Faceit 凭据；不是 round win probability |
| [Evalbar](https://github.com/eigenpaul/cs2-evalbar/tree/a50a83057fde7d5c66d9af8d3f2bb262d4fcb406) | CS2；commit `a50a830`（2026-07-07） | 解析 `.dem`；20 秒因果窗口、4 Hz（默认 80 个采样点）；含人数/HP/经济/装备/道具/地图压力/炸弹可拆等 | 离线生成时间线；没有 GSI 端点或在线延迟声明 | 校准后的 `ct_win` round 概率；另有 plant、retake、save、defuse、contact、next-kill 等头 | MIT 公开代码；模型与验证证据高，实时部署证据无 | 当前只支持 `de_inferno` 离线分析；训练数据/权重不随仓库完整提供；实验结果仍有阶段差异 |
| [WPAModelCSGO](https://github.com/nkashyap14/WPAModelCSGO/tree/72232f47de292e6333b5614d491a7e81cf0a389f) | CS:GO/CS2；commit `72232f`（2025-02-28） | Awpy/回放帧或 tick；人数、装备、买型、HP、道具、炸弹、位置等 | 提取器遍历回放 tick；离线训练/预测；无实时端点和延迟数据 | 一侧视角的 round `TeamWin` 二分类概率 | 公开代码；存在模型管线的证据中等，生产可用性低 | CS2 分支有硬编码 demo 路径和原型痕迹；模型产物/数据不完整；未见校准报告 |
| [esports-live-analytics](https://github.com/rustkas/esports-live-analytics/tree/e19a1bd99ec32cbc069c52a0dd7b8c6ad2343856) | CS2 形态后端；commit `e19a1bd`（2026-01-18） | 通用 HTTP 事件源；README smoke test 使用 `source: "demo"` 的合成 kill 事件 | 只在显著事件触发；文档写 `<500 ms` 热路径、`<50 ms` predictor，但未提供独立基准 | team A/B 概率、confidence、模型版本、时间戳和派生 decimal odds | MIT 公开 demo；架构证据中等，真实比赛证据低 | 当前是规则引擎；没有 Valve GSI 连接器；roadmap 仍写着替换为 ML |
| [Xenopoulos / Freeman / Silva](https://doi.org/10.1145/3485447.3512277) | CS:GO；ACM Web Conference 2022 | 大规模 CS:GO 数据；论文摘要强调 HP、装备价值和 Elo 类技能特征 | 论文摘要未给在线 cadence、推理延迟或部署服务 | 某一游戏时点的团队胜率 | 同行评审论文；研究证据高，实时服务证据未知 | 不是 CS2 运行时系统；完整特征、权重和服务接口需看论文/作者资料 |
| [Hirota](https://doi.org/10.1109/gcce62371.2024.10760945) | CS:GO；GCCE 2024 | 比赛回放帧中的玩家坐标等特征 | 论文描述回合进程/回合末分析；实时 cadence 和延迟未知 | round win-condition 概率 | 论文证据中等 | 未证明在线部署，也未见公开运行时实现 |
| [Marshall / Mavromoustakos Blom / Spronck](https://doi.org/10.1145/3555858.3555859) | CS:GO；FDG 2022 | 3 秒遥测窗口、36 个特征 | 面向实时播报辅助；LSTM/CNN/RNN 比较；不是胜率 | 预测十名玩家下一次死亡，最佳报告 F1 约 0.38 | 邻近实时遥测证据高 | 目标不是 team win probability；没有可直接复用的胜率模型 |

## 实时系统：Eon 是目前最清楚的公开例子

### 输入和链路

Eon 的 [README](https://github.com/mortenlein/eon/blob/61759cd8376eb2fa8b3542e2242c38d2fd002b98/README.md) 将产品定义为 CS2 broadcast HUD，并明确列出 live radar、win probability 和约 20 Hz 的 GSI 驱动。仓库内的 [`gamestate_integration_eon.cfg`](https://github.com/mortenlein/eon/blob/61759cd8376eb2fa8b3542e2242c38d2fd002b98/gamestate_integration_eon.cfg) 把 GSI URI 配为 `http://127.0.0.1:31982/gsi`，`timeout=0.5`、`buffer=0`、`throttle=0`，并请求 all players、位置、状态、武器、炸弹、地图、回合和倒计时字段。

[`src/server/gsi.js`](https://github.com/mortenlein/eon/blob/61759cd8376eb2fa8b3542e2242c38d2fd002b98/src/server/gsi.js) 的链路是：接收 HTTP POST → 更新状态 → 统计玩家和生命值 → 更新当前回合概率 → 用 websocket 广播。广播函数以 50 ms 为间隔上限，因此“约 20 Hz”是代码可核验的 UI 推送上限，而不是端到端延迟测量。

### 源码中实际实现的概率

在该 commit 的 `processAllPlayers` 中，源码先统计活着的 CT/T 人数和双方总 HP，然后按下面的启发式计算 CT 概率：

```text
player_weight = ct_alive / (ct_alive + t_alive)
hp_ratio      = ct_hp / (ct_hp + t_hp)       # 无 HP 时回退 0.5
prob          = 0.5 * player_weight + 0.5 * hp_ratio

if bomb_planted:
    bomb_factor = (countdown / 40) ** 2
    prob *= bomb_factor
```

回合开始把概率重置为 `0.5`，只有变化超过 0.01 才追加到历史数组；回合结束时，CT 胜把最终值设成 `1.0`，否则设成 `0.0`。这足以证明它是一个**能在现场运行的胜率显示功能**，但不足以证明它是统计上可靠的预测器。

### 对质量的判断

**源码事实**：没有发现训练数据、模型权重、留出集指标、校准曲线或独立延迟基准；公式未使用经济、武器质量、剩余道具、位置、地图区域、声音、时间压力或拆包可行性等许多信号。炸弹逻辑只把 CT 概率乘以剩余倒计时平方，并没有完整建模双方身份、拆包时间和道具。

**推断**：Eon 适合做广播中的直觉提示或 baseline，不能直接把百分比当作已验证的“真实概率”，也不宜把它当作本项目训练标签。

## 官方真实直播但闭源：BLAST.tv

BLAST.tv 在 [Fall Final 2023 的官方介绍](https://blast.tv/article/blast-fall-final-2023-innovations) 中写明，直播重新引入了自研的 **AI predicting the round outcome**，定位是帮助解说员和分析师讲述回合走势。文章同时明确提醒，这仍处于实验性质，模型可能给出“明显错误”的预测。

这条来源能确认“真实转播系统存在”，但不能确认模型质量或接入方式：BLAST 没有公开权重、训练数据、实时 API、输入字段、更新频率、校准曲线或独立评估。因此它更像商业系统的存在性证据和产品方向参考，不能直接下载或复现。

## 比赛级实时：Esports Analyst

[Esports Analyst](https://github.com/OlegMarko/esports-analyst/tree/38400fae1ef8df9ea716281589bf4e4908e538b7) 是这轮检索里新增的另一类候选：它面向 Faceit 活动比赛，而不是 GSI 或 Demo 的回合状态。`ProcessFaceitWebhookJob` 在 `match_status_ready`/`match_status_ongoing` 事件到达时读取阵容并写入 `LiveMatch`；`PollLiveMatchesJob` 作为兜底每 5 分钟拉取一次活动比赛。

`PredictionService` 的实现是可直接核验的启发式组合：

```text
elo_prob = 1 / (1 + 10 ** ((team_b_elo - team_a_elo) / 400))
match_prob_a = clamp(0.6 * elo_prob + 0.4 * recent_form_prob, 0.05, 0.95)
```

页面还展示 `confidence`、二项误差范围和由概率派生的十进制赔率，但仓库没有给出独立测试集、校准曲线或真实端到端延迟。它适合做“当前比赛哪队更可能赢”的轻量基线；如果要找“当前回合在 30 秒后谁更可能赢”，它的输入粒度不够，不能替代 Eon 或 Evalbar 这一层。

## 实时形态原型：esports-live-analytics

这个项目展示了一个较完整的事件到预测发布链路：ingestion → queue/state → predictor → REST/GraphQL/WebSocket。其 [`state-consumer`](https://github.com/rustkas/esports-live-analytics/blob/e19a1bd99ec32cbc069c52a0dd7b8c6ad2343856/services/state-consumer/src/predictor-client.ts) 注释和代码都写明只在显著事件触发预测，而不是每一个 tick；API 返回 team A/B 概率、confidence、版本和时间戳。

但 [`RuleBasedEngine.ts`](https://github.com/rustkas/esports-live-analytics/blob/e19a1bd99ec32cbc069c52a0dd7b8c6ad2343856/services/predictor/src/engine/RuleBasedEngine.ts) 的 `v0.1.0-baseline` 从 0.5 起步，仅按 strength、alive differential、equipment differential、炸弹和 streak 加减固定权重，再把结果限制在 0.05–0.95。README 的 roadmap 仍列出“Replace rule-based predictor with ML model”。此外，README 的 smoke test 发送合成 kill 事件，没有包含真实 CS2 GSI 适配器。

所以它可作为“实时服务边界和 API 形状”的参考，不能作为已经验证的 CS2 实时胜率模型或 `<500 ms` 生产性能证明。项目将概率转换成 decimal odds 只是展示层派生字段，不是博彩公司市场赔率。

## 离线/回放模型

### Evalbar：最值得研究的公开 CS2 模型

Evalbar 的 [README](https://github.com/eigenpaul/cs2-evalbar/blob/a50a83057fde7d5c66d9af8d3f2bb262d4fcb406/README.md) 明确写的是 round-outcome probability model，并反复限定为 offline analysis of `de_inferno` demos。它的默认输入是以预测点为最后样本的 20 秒、4 Hz 因果窗口（80 个采样点），包括：

- 全局回合状态：时钟、比分、存活人数和 HP、经济/装备、买型；
- 炸弹状态、剩余时间和 `can_defuse_in_time`；
- 玩家位置、朝向、武器、护甲、头盔、拆弹器、道具和存活状态；
- 地图区域压力、队友/敌人距离、活动烟雾/火焰、声音和近期事件。

模型包括约 70K 参数的 `GraphTemporalTransformer` 和梯度提升 baseline，主要二分类头是 `ct_win`，时间线保留 `sample_tick`、起始/结束/最小/最大概率。README 给出的 keeper 结果包括：`tiny_pg` 五个 seed 的验证集 CT `log-loss = 0.534 ± 0.012`，最佳 seed `0.5148`，4–5 seed 集成约 `0.517`；不同阶段差异明显（例如 `<15s` 的 log-loss 为 `0.656`、准确率 `0.60`，而 `>=90s` 为 `0.317`、`0.88`）。仓库还使用 Brier、ECE 和校准输出。

**这意味着什么**：Evalbar 是很好的“模型和验证方法”参考，尤其是因果窗口和校准；但它目前没有 GSI 消费者、在线 state store、推理服务或端到端延迟数据。公开的是源代码，训练语料、checkpoint 和完整可运行资产并不等于已随仓库交付。

### WPAModelCSGO：回放 tick 的 XGBoost 原型

该项目的 [`WPAModel`](https://github.com/nkashyap14/WPAModelCSGO/blob/72232f47de292e6333b5614d491a7e81cf0a389f/cs2/src/model/model.py) 使用 XGBoost `binary:logistic`、`logloss`、深度 6、学习率 0.1、1000 轮并带 early stopping；`predict_proba` 返回每个特征向量的标量概率。CS:GO 提取器按每个 round 的每个 replay tick 生成 CT/T 两个视角，使用 alive、equipment、买型、clock、炸弹、HP、utility 和 player-count differential 等字段，标签是 `TeamWin`。

CS2 分支的 [`extractor.py`](https://github.com/nkashyap14/WPAModelCSGO/blob/72232f47de292e6333b5614d491a7e81cf0a389f/cs2/src/preprocessing/extractor.py) 通过 Awpy `Demo` 遍历 ticks，并额外使用 flash、smoke、inferno、队伍位置质心距离、击杀差、拆弹器和炸弹地点。训练脚本读预处理 CSV，没有 GSI HTTP 入口、在线状态连接器或公开推理 cadence。CS2 运行示例含本地 Windows demo 路径，说明它更像可读的研究原型而非可直接部署的服务。

## 论文与邻近证据

### 直接研究胜率

- **Xenopoulos, Freeman, Silva， “Analyzing the Differences between Professional and Amateur Esports through Win Probability”**，[DOI](https://doi.org/10.1145/3485447.3512277)，ACM Web Conference 2022。摘要说明他们在大型 CS:GO 数据上建立可解释的 win-probability model，估计游戏任意时点的团队胜率，并发现 HP 和装备价值是跨水平的重要特征，Elo 类玩家技能估计有小幅帮助。摘要没有给出在线更新频率、推理延迟或可调用服务；应把它归类为 CS:GO 研究模型，而不是已知的实时产品。
- **Hirota， “Predicting Win Conditions of Counter-Strike: Global Offensive for Analyzing Round Progression”**，[DOI](https://doi.org/10.1109/gcce62371.2024.10760945)，GCCE 2024。摘要描述用 Set Transformer 和比赛帧中的玩家坐标预测回合结束的 win conditions，用于分析回合进程；没有公开在线服务、延迟或模型权重的证据。

### 邻近的实时 CS 遥测研究

**Marshall、Mavromoustakos Blom、Spronck， “Enabling Real-Time Prediction of In-game Deaths through Telemetry in Counter-Strike: Global Offensive”**，[DOI](https://doi.org/10.1145/3555858.3555859)，FDG 2022。论文研究的是 3 秒遥测窗口内预测十名玩家的下一次死亡，不是 team win probability；比较 CNN、RNN 和 LSTM，LSTM 在“预测全部十名玩家死亡”的设置下报告最佳 F1 约 0.38，并以广播评论员/观察员辅助为目标。它证明 CS 遥测可以支持实时模型，但不能被当作胜率系统。

### 可迁移但非 CS 的实时电竞证据

Hodge 等人的 **“Win Prediction in Multiplayer Esports: Live Professional Match Prediction”**（[DOI](https://doi.org/10.1109/TG.2019.2948469)）在 DotA 2 职业赛事中部署了实时预测流程，比较 logistic regression、random forest 和 LightGBM，并讨论 GSI 类 JSON 快照和时间精度限制。它是“实时电竞胜率系统确实可以落地”的方法论先例，但不是 CS/CS2 证据，因此不能替代 CS 模型验证。

## 不要把博彩赔率当作胜率模型

博彩市场的十进制赔率包含庄家水位、抽水、限额和市场行为；从赔率反推概率还要先去除 overround。它与“根据当前游戏状态预测 CT/T round outcome”的模型不是同一个对象。

在本次公开资料中，Rustkas 项目返回的 `odds_a/odds_b` 是其内部概率的派生展示字段；这不证明它接入了 bookmaker feed，也不证明赔率已经校准。若未来要比较市场信号，应另列数据源、时间戳、盘口规则和去水方法。

## 对本项目的启示

### 建议的分层边界

1. **输入适配层**：把 GSI 或其他赛事事件转换成统一的当前 round state；保留来源、接收时间和字段新鲜度。实时输入应和 `.dem` 解析输入走同一套事实字段契约，但不要假设两者拥有相同的时间语义。
2. **特征/模型层**：以 Evalbar 的因果 20 秒窗口和校准评估为参考，先输出 `ct_round_win_prob`，再按需要推导 T 概率；把模型版本、特征 schema 和校准器一起版本化。
3. **发布层**：按事件或固定采样间隔发布概率快照，明确 `computed_at`、`source_tick`（只有真正解析 Demo 时才填写 canonical Demo tick）、模型版本和输入新鲜度。UI 推送频率不应被误解为模型有效信息频率。
4. **展示/教练层**：把概率当作定位教学片段的信号，不当作事实、因果结论或玩家当时可见的信息。概率下降只能说明状态评估变化，不能自动断言“某个动作造成了下降”。

### 需要补齐的验证门槛

- 用按比赛/地图隔离的留出集评估 `log-loss`、Brier、ECE、可靠性图和分阶段表现；不要只报准确率。
- 分开报告开局、人数优势、残局、下包后和可拆/不可拆等状态，避免一个总体数字掩盖早期回合失真。
- 测量从输入接收、状态更新、推理到 UI 发布的 p50/p95 延迟，并记录丢包、乱序和 stale-state 行为。
- 明确 round 概率与 BO1/BO3 系列概率的关系；系列模型需要地图选择、当前比分和规则状态，不能直接复用 round head。
- 为 GSI、回放和视频/合成输入分别标记时间来源；合成 fixture 或视频媒体时间不能被标成精确 Demo tick。

## 证据与限制

- 本笔记优先引用固定 commit 的公开源码和 README，避免使用会变化的默认分支链接；论文使用 DOI 和 OpenAlex/Crossref 元数据核对标题、作者和出版信息。
- Valve Developer Community 的 GSI 页面在本环境返回了反爬挑战页，未把页面正文当作事实依据；Eon 仓库中签入的 GSI 配置和处理代码可直接核验实时接入路径。
- “未找到公开证据”不等于“商业市场不存在”。这里的结论只针对能公开复核的实现、论文和 API 描述。
- 候选覆盖回合级、地图/系列级和 Faceit 比赛级概率；没有一个候选在公开资料中同时证明了 CS2 回合或 BO3 系列的实时接入、公开权重、校准结果和生产级延迟。

## 主要来源

### 开源实现

- [Eon README（固定 commit）](https://github.com/mortenlein/eon/blob/61759cd8376eb2fa8b3542e2242c38d2fd002b98/README.md)
- [Eon GSI server（固定 commit）](https://github.com/mortenlein/eon/blob/61759cd8376eb2fa8b3542e2242c38d2fd002b98/src/server/gsi.js)
- [Eon GSI 配置（固定 commit）](https://github.com/mortenlein/eon/blob/61759cd8376eb2fa8b3542e2242c38d2fd002b98/gamestate_integration_eon.cfg)
- [BLAST.tv 官方广播创新说明](https://blast.tv/article/blast-fall-final-2023-innovations)
- [Esports Analyst README（固定 commit）](https://github.com/OlegMarko/esports-analyst/blob/38400fae1ef8df9ea716281589bf4e4908e538b7/README.md)
- [Esports Analyst prediction service（固定 commit）](https://github.com/OlegMarko/esports-analyst/blob/38400fae1ef8df9ea716281589bf4e4908e538b7/app/Services/PredictionService.php)
- [Esports Analyst live polling job（固定 commit）](https://github.com/OlegMarko/esports-analyst/blob/38400fae1ef8df9ea716281589bf4e4908e538b7/app/Jobs/PollLiveMatchesJob.php)
- [Evalbar README（固定 commit）](https://github.com/eigenpaul/cs2-evalbar/blob/a50a83057fde7d5c66d9af8d3f2bb262d4fcb406/README.md)
- [Evalbar neural dataset/model code](https://github.com/eigenpaul/cs2-evalbar/blob/a50a83057fde7d5c66d9af8d3f2bb262d4fcb406/src/evalbar/neural.py)
- [Evalbar baseline and timeline code](https://github.com/eigenpaul/cs2-evalbar/blob/a50a83057fde7d5c66d9af8d3f2bb262d4fcb406/src/evalbar/baseline.py)
- [WPAModelCSGO XGBoost model](https://github.com/nkashyap14/WPAModelCSGO/blob/72232f47de292e6333b5614d491a7e81cf0a389f/cs2/src/model/model.py)
- [WPAModelCSGO CS2 extractor](https://github.com/nkashyap14/WPAModelCSGO/blob/72232f47de292e6333b5614d491a7e81cf0a389f/cs2/src/preprocessing/extractor.py)
- [esports-live-analytics rule engine](https://github.com/rustkas/esports-live-analytics/blob/e19a1bd99ec32cbc069c52a0dd7b8c6ad2343856/services/predictor/src/engine/RuleBasedEngine.ts)
- [esports-live-analytics predictor client](https://github.com/rustkas/esports-live-analytics/blob/e19a1bd99ec32cbc069c52a0dd7b8c6ad2343856/services/state-consumer/src/predictor-client.ts)

### 论文与元数据

- [Xenopoulos, Freeman, Silva（DOI）](https://doi.org/10.1145/3485447.3512277)；[OpenAlex 元数据](https://api.openalex.org/works/https://doi.org/10.1145/3485447.3512277)
- [Hirota（DOI）](https://doi.org/10.1109/gcce62371.2024.10760945)；[OpenAlex 元数据](https://api.openalex.org/works/https://doi.org/10.1109/gcce62371.2024.10760945)
- [Marshall 等（DOI）](https://doi.org/10.1145/3555858.3555859)；[OpenAlex 元数据](https://api.openalex.org/works/https://doi.org/10.1145/3555858.3555859)
- [Hodge 等（DOI）](https://doi.org/10.1109/TG.2019.2948469)
