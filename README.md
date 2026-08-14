# CS2 AI Demo Coach

当前交付是一个可运行的 `localhost` 纵向 MVP：用户选择本地 `.dem`，cs2d 在浏览器内解析并显示真实 2D 回放；用户选择一名玩家后，AI 教练接管同一个播放头，自动跳过冻结/低价值片段，在决策前暂停并直接讲解，点击“看结果”后播放结果，可回看或继续，整场结束后再总结。

长期架构唯一事实来源是 [ARCHITECTURE.md](./ARCHITECTURE.md)，本次底座决策见 [ADR-0002](./docs/adr/ADR-0002-adopt-cs2d-localhost-playback-substrate.md)。

## 本地运行

需要 Node.js 22+、pnpm 11+、Git 和 Rust/WASM 构建依赖已就绪。

```bash
pnpm install
pnpm cs2d:setup   # 克隆固定 cs2d commit、应用 host patch、安装上游依赖
pnpm dev          # cs2d http://localhost:5174 + 教练壳 http://localhost:3000
```

打开 <http://localhost:3000>，点击回放区域选择本机 `.dem`。文件直接进入 cs2d 的浏览器 File/Worker/WASM 管线，不上传到 Next，也不写入服务器。

旧实现仅用于回归：

- <http://localhost:3000/legacy>：Python ReplayBundle / 旧回放链路；
- <http://localhost:3000/pixi-poc>：已停止扩展的自研 PixiJS PoC。

## DeepSeek

DeepSeek 只润色已经存在的匿名决策侧事实、判断和建议；它不读取原始 Demo、完整事件流、稳定玩家 ID 或未来结果。缺少 key、超时或输出校验失败时自动保留确定性讲解，回放会话仍可继续。

本地可选：

```bash
cp apps/web/.env.local.example apps/web/.env.local
# 只在未跟踪的 apps/web/.env.local 中填写 DEEPSEEK_API_KEY
```

Cloudflare 配置：

```bash
pnpm exec wrangler secret put DEEPSEEK_API_KEY --config wrangler.jsonc
# 可选普通变量：DEEPSEEK_MODEL=deepseek-v4-flash 或 deepseek-v4-pro
```

任何 key 都不要写入 `wrangler.jsonc`、GitHub、日志或 `NEXT_PUBLIC_*` 变量。Cloudflare 当前只部署 Next 教练壳和 `/api/coaching/narrate`；由于 cs2d 上游没有明确许可证，cs2d 源码/WASM/资产不进入 Cloudflare 构建，线上暂不提供 `.dem` 回放。

## 当前已经能做什么

- 解析本地 `.dem`，显示真实阶段与 tick 进度条；
- 在 Mirage 真实雷达和多楼层上播放 10 人位置、存活、朝向、击杀、炸弹、掉落武器与投掷物；
- 地图两侧显示紧凑 5+5 HUD：姓名、金钱、道具/C4、生命、护甲/头盔和当前手持；C4/轨迹只读取当前播放位置以前的事实；
- 从 10 名玩家中选择一次分析主体；
- 从同一份 cs2d Replay 派生连续 `MatchTimeline`、内部 `ObservableState` 和 `ReviewPlan`，不二次解析 Demo；
- 自动消费冻结时间与低价值区间，全场最多安排 8 个跨回合教学停顿；
- 在 `decision_tick` 暂停后直接给出事实、判断、理由和一个主动作，不要求用户先预测；
- 点击“看结果”后在同一张全知地图推进 outcome，可“再看一遍”或“继续下一段”；
- 完整走完 ReviewPlan 后才进入全场总结；
- 模型不可用时使用确定性模板，数据与播放进度不丢失。

地图始终显示当前 tick 的全知事实。`ObservableState` 只作为规则/LLM 的内部证据白名单，不在 UI 中显式显示“玩家已知”模式；地图全知显示不能被教练当作决策前证据。

## 验证

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm cs2d:typecheck
pnpm --dir .local-data/upstream/cs2d --filter cs2-demo-viewer build
```

`test_demo.dem` 已通过真实浏览器链路：58 MB 本地解析、9 个正式回合、10 人选择、自动跳过、决策前暂停、同图结果播放与继续下一段。旧 Python worker 仍保留 Falcons/Spirit 首 tick 占位 `round_end` 的回归修复。

## 当前限制

- 当前分析仅支持 `de_mirage`；其他地图可由 cs2d 回放，但 Adapter 会诚实拒绝生成教练计划；
- cs2d Frame 常见约 8 Hz，下采样状态不是逐 tick 无损；GrenadePath 时间约为 0.1 秒精度；
- cs2d 当前缺少可靠逐次 HurtEvent、ShotEvent shooter、完整声学遮挡、队内语音和战术上下文，因此建议以自身状态与可验证决策上下文为主；
- 当前 deterministic signal 以选手参与的接触、生命变化、持包和投掷物为教学索引，已限制到 4–8 个停顿，但还没有职业样本检索、复杂站位/补枪模型或自由追问；
- 一次选择玩家后若分析失败，当前通过重新载入 Demo 重试；会话进度还没有持久化；
- cs2d 固定 commit `dbbe698c9b9c91f9a14cecea92374b4114bf60ec` 未发现明确 LICENSE，当前只作为 localhost source-reference；详见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 主要代码边界

- `apps/web/components/cs2d-playback-host.tsx`：Next 教练壳与 Session 集成；
- `apps/web/lib/cs2d-guided-session.ts`：Session → cs2d 播放命令的纯映射；
- `libs/cs2d-analysis-adapter`：结构化 Replay → MatchTimeline / Observation / ReviewPlan；
- `libs/contracts/src/playback-bridge.ts`：严格 iframe bridge 契约；
- `libs/session`：确定性会话 reducer、冻结时间自动消费与总结门禁；
- `tools/cs2d-host/patches/0001-cs2d-playback-host.patch`：固定上游的最小 HUD/bridge/Adapter patch；
- `workers/analysis`、`/legacy`、`/pixi-poc`：迁移回归，不是默认产品数据流。
