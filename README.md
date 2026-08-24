# CS2 AI Demo Coach

> 一个会陪你把整场 CS2 Demo 看完的 AI 教练：在关键决策前暂停，先让你看清当时的局面，再播放结果，最后给出能听懂、能执行的 CS 复盘。

[![Status: MVP](https://img.shields.io/badge/status-MVP-2ea043)](./MVP_SCOPE.md)
[![CI](https://github.com/Vek-John/CS-agent/actions/workflows/cloudflare-production.yml/badge.svg)](https://github.com/Vek-John/CS-agent/actions/workflows/cloudflare-production.yml)
[![License: MIT](https://img.shields.io/badge/code%20license-MIT-blue.svg)](./LICENSE)
[![Runs on localhost](https://img.shields.io/badge/runtime-localhost-111827)](#快速开始)

CS2 AI Demo Coach 不是“上传 Demo 后生成几条报告”。它把 Demo 变成一条有节奏的教练路线：低价值区间自动跳过，重要决策前保留上下文并暂停，结果播放完成后才展示完整分析，整场看完再总结。

当前版本优先支持本地浏览器运行，主链路使用 [zenojunior/cs2d](https://github.com/zenojunior/cs2d) 的真实 2D Demo 回放能力，并在其上接入候选生成、教练 Director、确定性路线编译和可选 DeepSeek 讲解。

## 目录

- [它解决什么问题](#它解决什么问题)
- [一次复盘如何运行](#一次复盘如何运行)
- [当前能力](#当前能力)
- [快速开始](#快速开始)
- [DeepSeek 配置](#deepseek-配置)
- [Cloudflare 部署](#cloudflare-部署)
- [项目结构](#项目结构)
- [验证与开发](#验证与开发)
- [当前限制](#当前限制)
- [开源与第三方许可](#开源与第三方许可)
- [参与贡献](#参与贡献)

## 它解决什么问题

传统 Demo 工具通常把信息堆在地图、统计面板或报告里；教练真正需要解决的是“当时为什么这么做、下一次应该怎么改”。因此本项目把产品核心定义为一场完整的 guided coaching session：

- 先选一个要复盘的玩家，HUD 会锁定目标并把他标成“你”；
- 冻结时间和普通回合由播放器自动消费，不让用户反复判断要不要跳过；
- 每个教练片段默认保留决策前后约 1 秒上下文；
- 决策前只使用当时可证明的玩家信息，避免用结果倒推当时判断；
- 播放结果后再讲“你做了什么、造成什么问题、可以怎么改”；
- 普通区间仍覆盖整条时间轴，并明确作为跳过/简述区间，不会凭空变成 AI 结论。

## 一次复盘如何运行

```text
本地 .dem
   │
   ▼
cs2d Browser Worker + WASM
   │  一次解析，生成真实回放事实
   ▼
Replay / MatchTimeline / Win-rate timeline
   │
   ├── Deterministic Candidate Generator
   │       找出死亡、显著胜率下降、道具时机等候选
   │
   ├── Teaching Director
   │       从候选中挑选实用的教学停顿（最多 50 段）
   │
   ├── Plan Compiler
   │       固定顺序、上下文窗口、结果门禁和整场覆盖
   │
   └── Narrator
           用决策侧材料 + 结果证据生成三段式讲解
           当前状态 → 这样做的问题 → 可以怎么改
```

播放器和教练共用同一条 canonical timeline。地图可以持续显示当前播放位置的完整回放事实，但 `ObservableState` 只在内部作为规则和 LLM 的证据白名单，绝不会把地图上的全知画面当成玩家当时已经知道的信息。

## 当前能力

### 回放与地图

- 本地选择 `.dem`，在浏览器 Worker/WASM 中解析，不把 Demo 上传到 Next 或 Cloudflare Worker；
- Mirage 真实雷达、多楼层基础、10 人位置/朝向/存活状态；
- 炸弹、投掷物轨迹与落点、掉落武器、生命/护甲/头盔和当前手持装备；
- 地图、两侧 5+5 HUD、回合条和整场进度保持同步；
- 普通播放保持地图居中，关键讲解时才进行受控聚焦；
- 可拖动进度、切换回合、调速，并从教练路线返回最近的未完成片段。

### 教练路线

- 一次解析生成 `ReplayBundle`，不为每个模块重复解析 Demo；
- 由确定性候选层先提名，再由 Director 选择，不让 LLM 发明 tick、玩家位置或新事实；
- 最多 50 个教练片段；Director 的匿名输入包单独限制为 32 个候选，两个上限不混用；
- 成功赢下对枪、胜率上升或没有真实负向胜率证据的 KILL 只保留为事实，不进入教练路线；
- WebGPU FP16 batch 16 是当前优先推理路径，只有明确推理失败才回退 INT8 WASM；
- 模型、DeepSeek 或部分字段不可用时，基础回放和可追溯的确定性回退仍可继续。

### 讲解风格

讲解刻意使用 CS 玩家能听懂的报点和术语，例如“先把准星摆好”“小身位 peek”“等补枪”“没头甲别和警察硬磕”，而不是只输出抽象的分析报告。完整讲解结构为：

1. **当前状态**：血量、头甲、手持、道具、经济和决策侧可见信息；
2. **这样做的问题**：动作与结果之间能被证据支持的实际风险；
3. **可以怎么改**：一个具体、可复用的下一次处理方式。

## 快速开始

### 环境要求

- Node.js 22+（CI 使用 Node.js 24）
- pnpm 11+
- Git
- `cs2d` parser 所需的 Rust/WASM 构建工具链
- 支持 WebGPU 的浏览器可启用 FP16；不支持时自动使用 INT8 WASM

### 启动 localhost

```bash
git clone https://github.com/Vek-John/CS-agent.git
cd CS-agent

pnpm install
pnpm cs2d:setup
pnpm dev
```

打开 <http://localhost:3000>，在回放区域选择本地 `.dem`。`pnpm dev` 会同时启动：

- `http://localhost:3000`：Next 教练壳；
- `http://localhost:5174`：cs2d Viewer。

首次安装会固定上游 commit、应用最小 host patch、安装依赖并本机构建 parser WASM。之后可以直接使用 `pnpm dev`。

旧实现只用于回归，不是默认产品链路：

- <http://localhost:3000/legacy>：旧 Python ReplayBundle 链路；
- <http://localhost:3000/pixi-poc>：停止扩展的自研 PixiJS PoC。

## DeepSeek 配置

DeepSeek 是可选的讲解润色层。它只接收匿名的决策侧事实、判断、建议和结果证据，不读取原始 `.dem`、完整事件流、稳定玩家 ID 或未揭示的未来画面。

### 本地

```bash
mkdir -p .local-data
cp deepseek.env.example .local-data/deepseek.env
# 编辑 .local-data/deepseek.env，填写 DEEPSEEK_API_KEY
pnpm dev
```

### Cloudflare Worker

```bash
pnpm exec wrangler secret put DEEPSEEK_API_KEY --config wrangler.jsonc
# 可选变量：DEEPSEEK_MODEL=deepseek-v4-flash 或 deepseek-v4-pro
```

不要把 key 写入 `wrangler.jsonc`、GitHub、`NEXT_PUBLIC_*`、标准 `.env*` 文件或日志。生产构建会检查 source 和 bundle，拒绝把本地 secret 打进产物。

## Cloudflare 部署

手动部署需要已登录 Wrangler，并配置 Cloudflare API 权限：

```bash
pnpm cloudflare:build
pnpm cloudflare:assets
pnpm cloudflare:deploy
```

生产 Worker 会把 Next 教练壳、`/api/coaching/narrate` 和 `/cs2d/` Viewer 放在同一部署中。推送 `main` 也会触发仓库现有的 Cloudflare Actions workflow；如果只想验证构建，请使用 `pnpm cloudflare:build`，不要执行 deploy。

## 项目结构

```text
apps/web/
  app/                         Next 页面与 API route
  components/playback/         默认 cs2d 播放宿主
  lib/coaching/                Director、Narrator、Session、证据边界
  lib/playback/                播放 bridge 与时间轴映射
  lib/legacy/                  旧链路与 PoC 回归代码

libs/
  contracts/                   领域契约与版本化数据结构
  cs2d-analysis-adapter/       Replay → Timeline / Observation / Plan
  review-planner/              候选、Director seam、PlanCompiler
  session/                     播放状态机、结果门禁和整场总结
  observation/                 玩家观察状态与 claim 白名单
  cs-net-winrate/              胜率特征与 Worker runtime
  map-semantics/               Mirage 点位和地图语义

workers/analysis/              旧 Python 分析 worker（迁移回归）
tools/                         cs2d patch、构建、资产和 Cloudflare 工具
docs/                          架构、ADR、技术学习和实验记录
```

长期维护的架构事实以 [ARCHITECTURE.md](./ARCHITECTURE.md) 为准；产品边界见 [PRD.md](./PRD.md) 和 [MVP_SCOPE.md](./MVP_SCOPE.md)，实际踩坑和验证记录见 [docs/TECHNICAL_LEARNINGS.md](./docs/TECHNICAL_LEARNINGS.md)。

## 验证与开发

常用检查：

```bash
pnpm test
pnpm typecheck
pnpm build

pnpm cs2d:typecheck
pnpm cs2d:build
pnpm cloudflare:build
pnpm cloudflare:assets
```

单元测试覆盖候选过滤、50/32 上限、结果门禁、未来信息边界、Narrator 引用完整性、WebGPU/WASM 回退和 Cloudflare secret scan。真实 Demo 验证优先使用已授权的本地 `.dem`；仓库不提交用户比赛文件。

## 当前限制

- 默认分析地图为 `de_mirage`；其他地图可以由 Viewer 播放，但 Adapter 暂不生成完整教练计划；
- cs2d Frame 通常约 8 Hz，状态不是逐 tick 无损；投掷物时间也有采样精度限制；
- 当前缺少可靠的逐次 HurtEvent、ShotEvent shooter、完整声学遮挡、队内语音和全部战术上下文；
- 目前的候选主要围绕玩家死亡、接触、生命变化、持包和道具时机，还没有职业样本检索、复杂补枪模型或自由追问；
- 选择玩家后若分析失败，需要重新载入 Demo 重试，会话进度尚未持久化；
- WebGPU/FP16 性能依浏览器、GPU 和 Worker 能力而异，失败时才回退 WASM，不把超时伪装成成功结果。

## 开源与第三方许可

本仓库的 MIT 许可只覆盖项目原创源代码和文档。以下内容不自动继承 MIT：

- Valve/CS2 游戏素材、地图雷达、武器与道具图标；
- `cs-net` 模型权重和模型资产；
- `cs2d` 上游源码及其生成的 Viewer/WASM；
- 任何在 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md) 中单独列出的依赖或素材。

请在再分发、商业部署或打包镜像前逐项核对上游条款。当前部分本地素材在 manifest 中明确标为 `LOCALHOST_ONLY` 或 `LOCALHOST_ONLY_REVIEW_REQUIRED`，这不是对外再分发许可。

## 参与贡献

欢迎提交 Issue、改进建议和 Pull Request。开始前请：

1. 阅读 [AGENTS.md](./AGENTS.md)、[ARCHITECTURE.md](./ARCHITECTURE.md) 和相关 ADR；
2. 保持“事实、推断、建议、证据引用”分离；
3. 不把完整 Replay 或本地 Demo 上传到 Issue、日志或第三方 API；
4. 为行为变化补测试，并在 `docs/TECHNICAL_LEARNINGS.md` 记录验证结果；
5. UI 变更保持 localhost 可运行，并遵循现有的设计 skill 约束。

## 致谢

项目借鉴并集成了 [cs2d](https://github.com/zenojunior/cs2d) 的回放底座，并参考了 [csfreezetime](https://github.com/benginN/csfreezetime) 与 [csgo-2d-demo-viewer](https://github.com/sparkoo/csgo-2d-demo-viewer) 的公开架构思路。完整的代码、模型、地图和素材说明见 [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md)。

## 许可

原创代码和文档以 [MIT License](./LICENSE) 发布；第三方内容按各自许可证或上游条款执行。
