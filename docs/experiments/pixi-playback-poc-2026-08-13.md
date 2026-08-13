# PixiJS Playback PoC · 2026-08-13

这是一次可重跑的迁移实验记录，不是新的架构事实来源。长期职责边界以
`ARCHITECTURE.md` 为准。

## 结论

PoC 已跑通 `test_demo` 和 Falcons vs Spirit 的首个完整回合，统一
`PlaybackFrameViewModel`、玩家已知白名单和 PixiJS layer 的方向成立；暂不替换
当前 AI 带看地图。缺少生产 HUD、多楼层、按回合缓存、完整效果生命周期和会话
状态接线时，直接迁移只会把可运行 MVP 换成一个能力更少的 renderer。

本地入口：<http://localhost:3000/pixi-poc>

## 上游审查

### benginN/csfreezetime

- 固定 commit：`dcf6a20e89dd11f7b3440a38c9e130d086566268`
- 许可证：MIT，Copyright (c) 2026 Orhan Bengin Epözdemir
- 审查文件：
  - `apps/web/src/components/ReplayView.tsx`：Pixi application、layer container、ticker、缩放和平移；
  - `apps/web/src/lib/mapbase.ts`：地图空间边界；
  - `apps/web/src/api.ts`：播放器输入形状。
- 只采用底层技术思路，没有复制其页面、API、React Query 状态、报告或 ML 功能。

### sparkoo/csgo-2d-demo-viewer

- 固定 commit：`0765bf613131a4fd5f88ed034bd9bc41bfb31e7e`
- 许可证：MIT，Copyright (c) 2023 Michal Vala
- 审查文件：
  - `web/public/worker.js`：浏览器 Worker 边界；
  - `web/src/Player/MessageBus.js`、`web/src/Player/Player.js`：消息与播放器解耦；
  - `protos/Message.proto`：逐回合消息；
  - `parser/pkg/parser/map.go`：多楼层设计参考。

许可证全文和固定来源见仓库根目录 `THIRD_PARTY_NOTICES.md`。cs2replays 只用于观察
公开产品行为；未复制其无公开许可证的 JS、WASM 或 UI。

## PoC 模块

- `ground-truth-adapter.ts`：把已经加载的一份 `ReplayBundle` 建成按玩家索引的
  `GroundTruthReplaySource`；不读取或二次解析 `.dem`。
- `playback-frame.ts`：分别实现 `buildOmniscientFrame` 和
  `buildKnowledgeFrame`。后者不接收全知 source，从空 frame 按当前且未过期的
  claim 添加 actor/evidence/overlay，并重新投影 round，删除 winner、score_after、
  end_tick。
- `pixi-playback-layer.ts`：唯一逐帧入口是 `update(PlaybackFrameViewModel)`；实现
  Radar、Player、Grenade、Bomb、DroppedWeapon、Effects、Evidence、Annotation
  的最小层。
- `pixi-replay-poc.tsx`：真实雷达、首回合播放、Pixi ticker、进度条、拖拽、缩放、
  键盘和全知/玩家已知手动验证入口。

投掷物只包含 `sample.tick <= frame.tick` 的已发生轨迹；玩家已知 projectile、effect、
bomb、dropped weapon 和 annotation 都必须携带当前有效 claim ID。声音只画短线方向，
不会生成隐藏敌人 marker 或实心月牙。world yaw 在 builder 内经地图 affine 转成
`radar_yaw`，renderer 不猜地图轴方向。

## 真实数据与性能

命令：

```bash
CS2_RUN_LARGE_DEMO_TESTS=1 pnpm exec vitest run \
  apps/web/lib/pixi-poc/real-bundle.integration.test.ts --reporter=verbose
```

本机一次运行结果：

| Bundle | JSON 大小 | 回合 | 玩家 | 投掷物轨迹 | 首回合采样帧 | JSON＋索引 | frame 平均 | frame p95 | 进程 heap 增量 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| test_demo | 18,273,559 B | 10 | 10 | 150 | 594 | 187.052 ms | 0.336 ms | 0.811 ms | 83.8 MB |
| Falcons vs Spirit | 59,252,599 B | 21 | 10 | 427 | 593 | 436.024 ms | 0.365 ms | 0.853 ms | 214.5 MB |

`frame p95` 是纯 ViewModel builder 延迟，不是浏览器实测 FPS；两份样本都低于
16.7 ms 的 60 Hz 帧预算。heap 增量包含整份 JSON 文本、解析对象和索引，不等于
Pixi GPU 占用。浏览器在真实 `test_demo` 上验证首帧 10 人、玩家已知只剩 1 个自身
actor、播放 tick 前进、切换视角、拖拽/缩放和 console 0 error/warning。

## 代码量比较

| 范围 | 行数 | 说明 |
|---|---:|---|
| 当前 renderer 相关 4 文件 | 1,221 | `replay-viewer`、`player-rail`、`replay-grenades`、`replay-knowledge` |
| PoC Pixi layer | 215 | 纯 renderer，只读统一 ViewModel |
| PoC builders＋adapter | 909 | 显式全知/Observation 边界与坐标转换 |
| PoC 页面 | 421 | 隔离加载、播放与相机验证入口 |

PoC 总产品代码暂为 1,545 行，比当前 1,221 行多；增加的主要是长期需要的明确数据
边界，而不是 UI 功能。因此迁移的价值是正确的职责隔离和高频 canvas 更新，不是现阶段
减代码。

## 迁移门槛

下一步只在以下门槛完成后替换主地图：

1. 把主会话 phase 映射接入统一 frame，决策前和下一个未揭示 cue 强制知识视角；
2. 补齐当前 HUD、官方图标、投掷物类型/落点、炸弹和效果生命周期；
3. 按回合分块与缓存，避免一次把 59 MB JSON 常驻浏览器；
4. 加 Mirage 固定截图和后续多楼层地图回归；
5. 用同一真实回合做旧/新画面对照，再删除旧 renderer。
