# CS2 AI Demo Coach

当前仓库交付一个 `localhost` 最小可用纵向切片：用户可从本机选择 `.dem`、在识别出的 10 名玩家中指定分析主体，AI 再带用户走完整场；低价值区间显式跳过，关键接触在结果前暂停、讲解、播放结果、回看和追问，全部完成后才生成总结。内置样本当前为 5 个讲解点，另选玩家会依真实事件生成自己的讲解点数量。真实地图回放是讲解证据画布与二级“自由复查”入口，不是并列主产品；四回合合成夹具只保留为开发测试回退。

架构事实以 [ARCHITECTURE.md](./ARCHITECTURE.md) 为准；[PRD.md](./PRD.md) 与 [MVP_SCOPE.md](./MVP_SCOPE.md) 分别定义产品和首版边界。

## 本地运行

需要 Node.js 22+ 与 pnpm 11+。

```bash
pnpm install
pnpm dev
```

打开 <http://localhost:3000>。

DeepSeek 只负责把已有事实、判断和建议改写成更自然的直接讲解；未配置 key 时自动保留确定性模板，完整会话仍可运行。本地可选配置：

```bash
cp apps/web/.env.local.example apps/web/.env.local
# 再把 DEEPSEEK_API_KEY 写入未跟踪的 apps/web/.env.local
```

隔离的 PixiJS 迁移 PoC 位于 <http://localhost:3000/pixi-poc>。它用于验证统一 frame、真实雷达和玩家信息边界，当前不会替换 AI 带看的主地图。

前端与 TypeScript 领域验证：

```bash
pnpm check
```

Cloudflare 上只需添加 Worker Secret；不要把 key 写入 `wrangler.jsonc`、GitHub 或任何 `NEXT_PUBLIC_*` 变量：

```bash
pnpm exec wrangler secret put DEEPSEEK_API_KEY --config wrangler.jsonc
```

默认模型是 `deepseek-v4-flash`；如需覆盖，在 Cloudflare 配置普通变量 `DEEPSEEK_MODEL=deepseek-v4-flash` 或 `deepseek-v4-pro`。`main` 的 Cloudflare 构建只承载 Web 和讲解 API，当前不在线运行 Python Demo parser；本地 `.dem` 上传解析仍只在 localhost 可用。

真实 Demo Parser Adapter 使用 Python 3.12。首次建立本地环境：

```bash
/opt/anaconda3/bin/python -m venv .venv
.venv/bin/python -m pip install -e 'workers/analysis[test]'
.venv/bin/python -m pytest -q -m 'not slow' workers/analysis/tests
```

默认测试包含 `demoTests/test_demo.dem` 单样本；433 MB Demo 仅在显式设置 `CS2_RUN_LARGE_DEMO_TESTS=1` 时做轻量检查。

生成/刷新 localhost 真实回放数据：

```bash
.venv/bin/python -m cs2_demo_parser.build_replay \
  demoTests/test_demo.dem \
  apps/web/public/generated-data/test_demo.replay.json
```

显式选择分析玩家：

```bash
.venv/bin/python -m cs2_demo_parser.build_replay \
  demoTests/test_demo.dem \
  apps/web/public/generated-data/test_demo.replay.json \
  --selected-player-id 76561198244754626
```

缓存 Valve/Steam 托管的游戏物品图标与版本清单：

```bash
pnpm assets:valve-items
```

生成文件、上传原始 Demo、本地 Valve 雷达和物品图标缓存都在 `.gitignore` 中；执行 `pnpm dev` 后打开 <http://localhost:3000>。

## 当前已经能验证

- 默认进入本机 Demo 选择入口；预检只读取地图与 10 名玩家，选择主体后才生成 AI 全场带看；
- 真实 Mirage 雷达、固定 world→radar 标定与 10 名玩家同步；
- `test_demo.dem` 的 10 回合、23,846 条状态样本和 7,374 个事件可在 Web 时间轴播放；
- 150 条 parser 投掷物轨迹将 87,024 个有效坐标压缩为 9,967 个可追溯点，并展示飞行路径和解析器终点；
- HUD 显示逐样本阵营、生命、护甲、经济、当前手持、库存、拆弹器/C4；不可得字段显示未知；
- 10 名玩家栏紧凑放在地图两侧，地图与名单下方是共享 canonical tick 的播放条和完整比赛进度；
- 当前手持与库存使用版本锁定、本机缓存的 Valve/Steam 游戏物品图片；清单缺项时保留规范化文字，不拼接外部 URL；
- “完整复盘 / 玩家已知”数据层明确分离；20 个主体视角检查点包含自身状态与保守声音方向证据；
- 脚步/枪声只显示“可能听见的未知来源区域”，不据隐藏真值标出具体敌人；
- `ReviewPlan` 以 38 个半开 tick 区间连续覆盖真实 10 回合及回合间隙，无空洞或重叠；
- `SKIP` 片段显示原因并允许展开；
- `DEEP_DIVE` / `HABIT_CHECK` 在决策前暂停；
- 结果揭示前，讲解和当前局面追问只能引用玩家当时可知事实；
- 播放结果后可回看，再继续到后续回合；
- 总结只从已消费的讲解点生成，并在全场路径完成前保持锁定。
- DeepSeek Cloudflare route 一场最多处理 32 个 cue；真实 Falcons/Spirit 的 15 个 cue 已覆盖。缺 key、超时或上游失败时无感回退到确定性直接讲解；
- `/pixi-poc` 已用 `test_demo` 与 Falcons/Spirit 跑通统一 `PlaybackFrameViewModel`、Pixi ticker 和知识帧白名单，迁移证据见 `docs/experiments/pixi-playback-poc-2026-08-13.md`。

## 当前限制

- `apps/web` 仍是 localhost BFF，没有 FastAPI、队列 Worker、LangGraph 或多用户服务；上传文件与作业元数据保存在 `.local-data/demo-jobs`，可跨开发服务重启恢复，但当前 UI 尚无删除入口；
- 投掷物落点只使用 parser 轨迹末端或生命周期事件，不推断投掷起手 tick；没有明确半径事实时不绘制烟雾/燃烧范围；
- 当前教学信号是确定性的“主体死亡前接触生存复查”规则，尚不覆盖站位、经济、道具配合、残局等完整教练 taxonomy；死亡只作为复查入口，不被当作错误证明；
- 声音可听性仅用距离阈值做 `POSSIBLY_AUDIBLE` 保守判断，尚未建模墙体遮挡、同时噪声和语音；
- 当前只接受 `de_mirage` 的单个 `.dem` 文件，最大 512 MB；浏览器把文件流式写入本地作业目录，尚未实现断点续传；
- 状态采用 24-tick 网格加回合边界；播放器只对连续存活、同阵营的真实位置/朝向做显示插值，离散装备状态保持前值；
- 库存数量不可得时以 `count=1` 呈现并在 coverage/manifest 标注限制；C4 只在直接库存名出现时判真；
- 第 10 回合缺少 parser `freeze_end`，Bundle 以该回合 start tick 作为播放器边界回退并记录 warning；
- 当前 cue 讲解可由 DeepSeek 润色；用户自由追问仍由证据约束模板回答，尚未接入通用 LLM 问答；

真实雷达与物品图标都作为版本化 localhost 本地缓存使用；图标目录记录源 URL、内容 SHA-256、生成器版本和 `LOCALHOST_ONLY` 权利状态。用户已授权本地使用这些 Valve 游戏内容；公开分发前仍需单独复核。没有复制参考站点的 UI、布局、组件、品牌或自有图标。生成资产、生成数据、上传原始文件、`.venv` 和解析缓存均被忽略，不随源码提交。

## 代码边界

- `apps/web`：localhost 在线 2D 会话页；
- `libs/contracts`：首批 TypeScript 语义契约；
- `libs/demo-domain`：合成时间轴夹具、Parser Port 和轨迹采样；
- `libs/review-planner`：全场覆盖与未来信息边界校验；
- `libs/session`：确定性会话安全内核、受限追问和总结门禁；
- `workers/analysis`：Python Demo Parser Adapter 与确定性 ReplayBundle builder，可读取真实小 Demo 的玩家、回合、状态以及击杀/伤害/脚步/开火/投掷物/炸弹事件；缺失字段以 coverage、warning 和 generation manifest 返回。

真实媒体验证遵循单样本优先：先处理一条已授权视频或一份 Demo，人工确认时间轴与边界，再批量扩展。视频媒体时间不得冒充精确 Demo tick。
