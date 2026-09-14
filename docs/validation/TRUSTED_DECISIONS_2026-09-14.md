# 可信决策上下文与建议适用性验收

日期：2026-09-14。此文件是验证记录；长期契约以 `ARCHITECTURE.md` 5.6 为准。

## 实现结果

每个候选窗口具有独立的决策前快照与可观察上下文。具体建议由固定规则目录声明前提并逐项检查；缺少信息不会被当成条件成立。死亡、掉血、击杀、道具事件不再自动成为决策错误。新版本1.5保留读取1.4历史的能力，不改写已保存的路线或哈希。

当前解析结果尚不能可靠证明视线、声学、精确补枪时机、道具用途、可达掩体和剩余时间，故真实样本主要是不确定判断或显式带过；这是证据不足的真实结果，不能宣传为已实现通用战术判断。

## 基线与根因定位

开始时 Git 仅有用户未跟踪的 `docs/prompts/`；未修改其中任何文件，没有 reset、checkout 回滚、广泛删除或无关格式化。

基线命令 `pnpm exec vitest run libs/cs2d-analysis-adapter libs/contracts libs/review-planner apps/web/lib/coaching --reporter=dot`：29文件、208测试通过。基线测试没有覆盖建议适用性。

真实复现命令 `pnpm exec tsx .local-data/acceptance-trusted-decisions/reproduce.ts` 通过同一 cs2d WASM 解析器，在十名玩家共175个旧模板教学点中发现8条依赖已阵亡队友的建议，按预期退出1。基线日志与原始比较在 `.local-data/acceptance-trusted-decisions/before.json`、`reproduce.log`。

数据流追踪：

1. `cs2d-analysis-adapter.collectStates` 原先仅采所选玩家状态；`collectCandidates` 以击杀/伤害等事件定位窗口。
2. `actionFactText` 把死亡/击杀变成主动或继续对枪，把血量变化变成留在枪线。现在纯结果事件没有动作事实；已验证的投掷/目标动作使用真实事件时间。
3. `candidate-generator` 产生事件候选；旧实用性门主要排除正向击杀，其他信号容易直接进入负面教学。
4. `coaching-package-builder` 根据低血量、装备等局部条件选择模板，却没有检查队友、时间或空间前提；错误推断和错误建议由此进入 Cue。
5. Narrator 旧校验只证明引用合法，无法证明文案含义被引用支持；Presenter 固定负面标题，Reflection 与总结也存在旁路。
6. 真实模型另暴露：没有离散 swing 的11%→24%正向窗口只在 OutcomeImpact 出现。现改为在候选阶段以严格有界采样产生带引用的正负结果摘要，供判断与 Director 使用。

## 架构与权限边界

- `DecisionSnapshot` 仅在 Replay 所有者内读取必要十人状态；仅 Material 保存快照，不向 Host 复制十人逐帧数据。隐藏位置和装备不进入快照传输。
- `ObservableDecisionContext` 复用观察主张，约束来源、决策时间、有效期、置信度和限制；公开人数/比分/已知目标作为有引用的事实。未知计时不以最终回合长度反推。
- `BehaviorHypothesis` 与正式 Inference 分别记录支持、反证、缺失、置信度和呈现许可。正式过程评价要求独立可观察过程证据；结果变化不能替代它。
- Candidate Utility Gate 筛除普通结果与重复内容，保留有具体局面价值的少量不确定反思；全部回合仍由连续区间覆盖。
- Advice Gate 的六类规则逐项区分适用、不适用、不可验证。完整世界状态只作否决；批准须依赖当时可观察证据。
- Director 只接匿名紧凑摘要，Compiler 再检查选点和重点。Narrator 与总结采用封闭的已验证表达；合法引用不能授权增加战术事实或替代方案。
- 历史恢复只在明确旧版本执行原命名空间验证；用户呈现使用保守投影，旧建议/诊断不被升级为已验证建议。真实1.4历史无需重新调用模型。

## 三条真实案例

以下三条比较复用同一真实 Demo 和同一来源窗口。旧判断/建议来自修改前实际生成的确定性产物，不冒称旧 DeepSeek 实测回答。

### povergo · 第 1 回合 · canonical decision 8969

- 原始事实：你在B小：2 HP，93 甲、头盔未知，手持 P2000，道具数量未知，存款 $750、装备价值 $850。 当时己方 1 人存活（包括你），对方 2 人存活。 当时比分：进攻方 0，防守方 0。
- 旧判断：你现在在B小，血量已经偏低。现在别第一个拉出去，先让高血量队友架枪，你跟第二身位补枪，打完还能马上换位。
- 旧建议：让高血量队友打首接触；你跟着补枪，独自拿信息时只露一个能立刻收回的身位。
- 新判断：当前证据不足以判断这次选择是否有问题；结果本身不能说明决策对错。
- 适用性：队友先接触、补枪、等待队友均为 `INAPPLICABLE`；闪光用途、安全掩体和替代路线未获证实，保持 `UNVERIFIABLE`。
- 最终建议文案：目前无法确认更好的可执行方案，需要先核实当时的可用信息和行动条件。
- 结果事实：你随后被击杀。
- 可信原因：区分事件、意图和选择；用当时存活名单否决物理上不可执行的协同建议，缺少其他条件时不替换成泛化战术。

### 123 · 第 2 回合 · canonical decision 14481

- 原始事实：你在拱门：6 HP，头甲齐全（92 甲），手持 Deagle，道具数量未知，存款 $1950、装备价值 $2400。 当时己方 1 人存活（包括你），对方 2 人存活。 当时比分：进攻方 1，防守方 0。
- 旧判断：你现在在拱门，血量已经偏低。现在别第一个拉出去，先让高血量队友架枪，你跟第二身位补枪，打完还能马上换位。
- 旧建议：让高血量队友打首接触；你跟着补枪，独自拿信息时只露一个能立刻收回的身位。
- 新判断：当前证据不足以判断这次选择是否有问题；结果本身不能说明决策对错。
- 适用性：队友先接触、补枪、等待队友均为 `INAPPLICABLE`；闪光用途、安全掩体和替代路线未获证实，保持 `UNVERIFIABLE`。
- 最终建议文案：目前无法确认更好的可执行方案，需要先核实当时的可用信息和行动条件。
- 结果事实：你随后被击杀。
- 可信原因：区分事件、意图和选择；用当时存活名单否决物理上不可执行的协同建议，缺少其他条件时不替换成泛化战术。

### Dog · 第 5 回合 · canonical decision 31179

- 原始事实：你在A包点：20 HP，头甲齐全（48 甲），手持 M4A4，道具数量未知，存款 $2200、装备价值 $4100。 当时己方 1 人存活（包括你），对方 1 人存活。 当时比分：进攻方 3，防守方 1。
- 旧判断：你现在在A包点，血量已经偏低。现在别第一个拉出去，先让高血量队友架枪，你跟第二身位补枪，打完还能马上换位。
- 旧建议：让高血量队友打首接触；你跟着补枪，独自拿信息时只露一个能立刻收回的身位。
- 新判断：当前证据不足以判断这次选择是否有问题；结果本身不能说明决策对错。
- 适用性：队友先接触、补枪、等待队友均为 `INAPPLICABLE`；闪光用途、安全掩体和替代路线未获证实，保持 `UNVERIFIABLE`。
- 最终建议文案：目前无法确认更好的可执行方案，需要先核实当时的可用信息和行动条件。
- 结果事实：你的血量随后下降，伤害来源尚不能确认。
- 可信原因：区分事件、意图和选择；用当时存活名单否决物理上不可执行的协同建议，缺少其他条件时不替换成泛化战术。

### 真实11%→24%与 Reflection

最终浏览器使用本地 WebGPU FP16，完成7,239个样本。povergo 第1回合的2 HP死亡窗口，胜率由11%升到24%；候选在 Director 之前已携带正向窗口测量反证，仍为证据不足，未据此宣称过程正确。

实际选择“给队友补枪”后，用户看到：“你想接上队友的交火，这个意图我理解。但当时四名队友都已阵亡，已经无法和存活队友形成补枪配合。这个条件不成立，并不单独说明你之前的选择有错。”选项不再显示 `TRADE`，不会显示 `USER claim` 或内部字段。

## 自动化与构建结果

| 命令 | 结果 |
|---|---|
| `pnpm check` | 127文件通过、2文件跳过；938测试通过、4测试跳过；TypeScript、Next生产构建通过 |
| `pnpm build` | 最后自然语言文案变更后的生产构建通过 |
| `pnpm cs2d:typecheck` | 上游 Viewer 类型检查通过 |
| `pnpm cs2d:build` | 受控 patch/资产同步与 Viewer 生产构建通过 |
| `pnpm exec tsx tools/verify-trusted-demo.ts` | 十名玩家、每人9回合；2,694条断言通过，快照数逐一等于候选数，所有生成讲解通过引用和语义验证 |
| `PLAYWRIGHT_MODULE='/Users/vekel/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright' pnpm exec tsx tools/verify-trusted-demo-browser.mjs` | 真实本地文件→解析→选povergo→65候选→4讲解→9回合结束；四个结果窗口均实际播放，Reflection、跳过、Next和全场总结通过；自动清理 |
| `PLAYWRIGHT_MODULE='/Users/vekel/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright' pnpm exec tsx tools/verify-trusted-demo-browser.mjs --recovery` | 真实回答→有效检查点→刷新进入DORMANT→同文件重解析→MATCHED重连；同玩家、c1、canonical 8969、路线哈希和诊断结果保留，不重复追问；零Director重跑，恢复后续跑1条待处理Narrator；自动清理 |
| `pnpm exec tsx .local-data/acceptance-trusted-decisions/verify-history-full.ts` | 用户既存11点/20点两份历史，31份讲解只读恢复验证通过，路线和哈希不变 |
| `git diff --check` | 通过 |

4个跳过测试保持原有 opt-in：真实 PostgreSQL迁移/跨Demo共3项，以及旧Pixi Falcons大文件回归1项。本次不涉及云数据库或旧播放底座，未启用这些外部/大文件测试。没有删除或跳过新增可信性回归。

十种要求均有自动回归：全队友阵亡、活队友但无补枪窗、正向死亡反证、手雷/未知来源掉血、正确道具过程、未来敌人、缺字段、换边、内部术语、体积。另覆盖已重算哈希的残缺上下文绕过、旧历史安全呈现和启动期间讲解就绪状态丢失。

十人分析共517个候选，对应517份快照；最大快照4,496 bytes（上限16 KiB），最大无模型分析包6,170,104 bytes（上限16 MiB）。真实带模型浏览器包约6.58 MB；没有跨Host传输完整十人逐帧轨迹。

## 浏览器证据与限制

控制器使用生产 Next 与桌面已有 `createViewerHandler`，一个生命周期拥有服务、浏览器与清理。通用 Vite Preview 先后在根路径和绝对资源路径失败两次后被停止；改用生产资源处理器并先完成地图/模型/WASM smoke，才执行完整旅程。

浏览器真实发现并修复了三项单元测试未覆盖问题：反思选项仍显示内部枚举、正向采样没有进入候选反证、异步恢复写入期间第三条讲解就绪状态被旧 Session 覆盖。最后一次完整旅程由更严格的所有Cue与wrap-up断言验收，没有以只过前两条替代整场。

额外刷新验收发现：诊断面板跳过视觉教学时，也漏掉了已开始路线中的START_CUE同步；反思只能本地执行，没有对应Agent检查点。现复用串行控制器发送零工具能力的START_CUE再提交反思，不执行额外回放；非起点必须有匹配检查点才提升为稳定恢复点；恢复握手期间禁止普通写入覆盖其状态。匹配重连后通过Session reducer还原已有诊断。真实API顺序为OBSERVE_SEGMENT→START_CUE→SUBMIT_REFLECTION→RECONNECT_REPLAY，后两步保有c1诊断、routeCursor 2；恢复前后路线均为`fnv1a-4d4ca391`，播放暂停于8969。

证据位于 `.local-data/acceptance-trusted-decisions/`：`browser.json`、`browser-stage.json`、`browser-recovery.json`、`recovery-restored.png`、`cue-1.png`至`cue-4.png`、`final.png`、`after.json`、`history-full-readonly.json`和`check.log`。本机私有历史与截图没有加入Git。

- 浏览器有生产策略阻止旧PWA脚本注册的404诊断，以及ORT已知CPU shape节点分配提示；没有把它们称为纯GPU或零控制台诊断。
- 本次未使用真实DeepSeek凭据；实际HTTP走受校验的确定性降级，Provider成功/伪造输出/有效引用新增语义由自动测试覆盖。
- 已验证同一生产服务生命周期内的真实浏览器刷新恢复；localhost Agent使用MEMORY检查点，不能据此宣称服务重启后的冷恢复。最终用户库写入、安装包重新发布、Tauri App/DMG重打包未执行；本次未替换用户已安装App。桌面历史证据为实际旧产物只读校验与Session/历史自动测试。
- 目前仍无法确认LOS、语音、精确道具用途、可达安全空间、可靠回合/C4剩余计时。相应建议保持不可验证；未用通用战术文案掩盖数据缺口。
- 正向/执行/被迫等正式分类已有独立过程证据门和测试，但此Demo没有足够经认证的过程证据产生确定战术判断。

## 主要修改文件

`libs/contracts/src/decision-context.ts`：统一领域与信息用途契约；`libs/cs2d-analysis-adapter/src/decision-context.ts`、`index.ts`：紧凑快照、事实边界、体积与版本校验；`libs/review-planner/src/teaching-gates.ts`、`candidate-generator.ts`、`teaching-pipeline.ts`：建议门、正负采样、候选/习惯/讲解校验；`narration-package-builder.ts`：不可绕过的双包构造；`apps/web/lib/coaching/`：匿名模型输入、安全呈现、反思与总结；播放Host：最小UI和激活竞态；`apps/web/lib/recovery/cs2d-session-recovery.ts`：历史兼容且不信任旧建议。`vitest.config.ts`仅增加自动JSX变换以测试真实组件渲染。
