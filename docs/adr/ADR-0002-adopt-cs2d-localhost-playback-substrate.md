# ADR-0002：采用 cs2d 作为 localhost Demo 回放底座

- 状态：Accepted
- 日期：2026-08-14
- 决策者：项目总控
- 取代：ARCHITECTURE 1.5 中“继续迁移自研 PixiJS renderer”的默认路线

## 背景

旧 Web renderer 已能验证 canonical tick、真实 Mirage 雷达和 Observation 边界，但地图、HUD、多楼层、投掷物、效果与浏览器解析仍需大量重复建设。产品当前最需要验证的是“AI 带用户看完整场”，而不是单独打造 Demo viewer。用户决定以 `zenojunior/cs2d` 的源代码作为本地解析/回放底座，并把既有分析与会话能力接到它上面。

审查的固定上游为：

- Repository: <https://github.com/zenojunior/cs2d>
- Commit: `dbbe698c9b9c91f9a14cecea92374b4114bf60ec`
- 2026-08-14 审查结果：仓库根目录、相关 package 与源码头未发现明确 LICENSE 或再许可声明。

## 决策

1. `pnpm cs2d:setup` 把固定 commit 克隆到忽略的 `.local-data/upstream/cs2d`，再应用主仓库内的可重放 patch；不 vendor 整个上游。
2. `.dem` 由 cs2d 浏览器 File/Worker/WASM 管线完整解析一次。raw Replay 留在 iframe，并直接驱动 cs2d renderer。
3. 地图始终显示当前 canonical tick 的全知 Replay；用户界面不提供“玩家已知 / 全知”切换。
4. `@cs-coach/cs2d-analysis-adapter` 从同一 Replay 派生所选玩家的 `MatchTimeline`、内部 `ObservableState` 与 `ReviewPlan`。Observation 只约束规则和 LLM 决策证据，不控制 renderer。
5. Next 教练壳与 iframe 只通过 `cs2d-playback-bridge.v1` 交换严格白名单摘要、播放状态、AnalysisBundle 与受限命令。raw Replay、Demo 二进制和上游私有状态不跨 bridge。
6. Session reducer 自动跳过冻结/低价值区间，在 cue 决策点暂停；“看结果”只推进同一张地图的时间。全场教学停顿预算为 4–8 个，当前最大 8 个。
7. DeepSeek 只润色匿名、决策侧结构化事实/推断/建议；API key 只保存在 Cloudflare Secret。模型失败保留确定性模板。
8. 旧 Python `demoparser2`、Falcons/Spirit 修复、`/legacy` 与 `/pixi-poc` 保留为迁移回归和备选，不再是默认产品链路。

## 权利与发布边界

由于固定上游没有明确许可证：

- 上游源码、WASM、地图、图标和构建产物不提交到本仓库；
- 当前集成只用于 localhost source-reference；
- Cloudflare 构建不包含 cs2d runtime，线上不能声称支持该 Demo 解析器；
- 公开部署前必须获得明确授权、上游补充许可证，或替换为许可清晰的实现；
- `THIRD_PARTY_NOTICES.md` 持续记录 commit、审查日期与边界。

## 后果

正向：立即获得真实地图、多楼层、10 人状态、装备、投掷物、炸弹、掉落武器、效果、时间轴与浏览器 Worker/WASM；工程集中在会话节奏和分析质量。

代价：localhost 需要首次联网克隆/安装；上游 schema 变化必须通过固定 commit 和 Adapter 隔离；当前 Cloudflare 只承载教练壳与 DeepSeek route，不承载 cs2d 回放。

## 验证

- 固定 patch 可在干净 commit 上 `git apply --check`；
- 上游 Vue typecheck 与 Vite production build 通过；
- `test_demo.dem` 在浏览器完成 58 MB 解析、9 个正式回合、10 人选择、8 个以内教学停顿、决策前暂停、同图结果播放与继续下一段；
- bridge 精确字段、Round 0/null winner、post-round、比分、GrenadePath 近似、非 Mirage、Observation 绑定和未来信息泄漏均有回归测试。
