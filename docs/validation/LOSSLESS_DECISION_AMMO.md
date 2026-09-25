# 无损弹匣解码：来源修复通过，真实教学消费未通过

2026-09-26，基线 `85d0983`，分支 `codex/jev-decision-assessment`。这是前次[来源调查](DECISION_AMMO.md)之后的独立实现阶段。工程修复落地，但当前 Demo 的正式教学消费仍 **0/4**，不宣称教学质量、判断或建议提升。

## 交付与证据

- 项目内受控 source2-demo 0.5.4，仅对 CS2 scalar `m_iClip1: int32` 在真实 SendTable→Field 构造前选择 Unsigned32。保留原 wire；cs2d 再 checked_sub(1)，raw0/高位/超界未知。共享 registry 与全局 Cargo 配置未改。来源、许可、局部差异见 [UPSTREAM.md](../../vendor/source2-demo/UPSTREAM.md)。
- 新 0012 patch 将独立 tick-end 弹匣记录接到 adapter 1.9、严格 prior 的 Host 和匿名 compact。旧数据无字段仍未知，legacy rich 不可借同 tick 数据补值。独立 ref 不冒充 tick-start 状态。
- 有效样本仅描述“决策前最近记录”，不保证期间从未换枪/换弹；备弹未知。可证开火/换弹/捡放物品使采样失效。换弹/捡放事件的生产覆盖未证明完整。
- 显式相对 Cargo patch 覆盖统一用于 metadata、WASM 与 native tests；lock 只改变 source2 本地来源，其他依赖未升级。`cs2d:check` 仅预检工具链，先于完整 patch；build/test 在 patch 后验证实际 vendor 与 CS2 feature。默认不强制离线，本次所有真实 Cargo 构建用既有缓存，后续可显式 `CARGO_NET_OFFLINE=true`。

## 唯一新增真实验收

[匿名紧凑原始摘要](LOSSLESS_DECISION_AMMO_EVIDENCE.json)。同一现有 Demo、同一目标玩家；生产 WASM 无 probe export，外部 120 秒进程组期限。新阶段读取/解析均 1 次，两阶段累计各 3 次；没有重试、模型或网络调用，未保存 bulk Replay。

| 指标 | 前次未修 decoder 的验收 | 本次无损 decoder |
|---|---:|---:|
| 目标玩家采样帧 | 7,239 | 7,239 |
| 通过来源门的弹匣记录 | 0 | 2,960 |
| 其中 clip=0 的采样记录 | 0 | 41 |
| 正式教学点消费 | 0/4 | 0/4 |
| 解析时间 | 9,093 ms | 9,198 ms |

41 是空弹匣采样记录数，不能视为 41 次打空事件。单次耗时差异不证明性能提升或退化。本次总耗时 9,444 ms。

四个 cue 的当前/此前样本分别为 19426/19418、31179/31171、44507/44499、45091/45083，均严格早 8 canonical Demo ticks。实体两端一致、此前 ammo 存在，但期间本人开火分别 2/2/1/1 次，严格变化门全部拒绝。没有把失效数据称为当前弹匣，没有调整 cue 或放宽门。

以同一次解析的 Replay 移除新增 weaponAmmo 做消融（不重新解析）：44 个候选 assessment、整个 ReviewPlan、4 个真实 Host diagnosis 的 status/Verdict/Transfer advice 均保持一致。真实来源修复已证；真实教学消费和专业质量收益未证，A4 的实际消费部分未通过。

## 自动化与构建

- 真实 production SendTable→Field→SliceReader fixture：未修复时 1 红/1 绿，修复后 CS2 两项通过；无 CS2 的隔离依赖 fixture 两项通过。覆盖 raw0/1/31/41/101/256/257、0x80000000、0xffffffe0、0xfffffffe、u32::MAX，及普通 int32、数组、其他 clip 类型保持原 decoder。
- `pnpm cs2d:test-parser`：parser 6 项 + vendor 33 项通过；只调用既有工具链及缓存。
- 7 文件相关 tests 初次 165 项通过；工具链最终新增 fresh-check 与显式 offline 回归后 2 文件 26 项通过。弹药 31 项含 Host 本地/strict Graph 消费、两帧 strict prior、同名不同实体、重复/缺失样本、same-tick 拒绝、0/30 发不改判断/建议。
- 零 Demo 的消费 smoke：1 个 cue / 1 个实际 measurement，评估/路线/判断建议消融一致。合成 fixture 不算真实教学覆盖。
- TypeScript、Next production build、生产 WASM/Viewer build、Viewer vue-tsc 均通过；最后一次构建在真实解析前完成。
- 独立干净 pinned git worktree：`--check-parser` → 12 个完整 patches → `--reuse-patched-checkout` → 真实 locked target-specific metadata 均通过；指定 CS2D_UPSTREAM_DIR，未安装依赖。修复了 0012 单独 apply 检查误拒绝干净 checkout 的回归。命令 fixture 另证默认无强制 offline、check 阶段不提前 resolve 未 patch 的 lock。

## 下一项待设计能力

此次 `parse_demo(..., 8)` 是每秒 8 个 gameplay samples，源码 tick_step=round(64/frame_rate)，即 8 ticks；当前 ammo 只在已有 frame 的 tick-end 补齐。因此早 8 ticks 的数据可能在 decision 前已过时。

仅从现有源码可提出：在每个 tick-end 只维护每玩家最新可信 ammo 小缓存，在下一 tick-start frame 附带其独立 sample time，减少间隔而不存逐 tick 全量 Replay。此方案尚未实现或验证。必须先验证 observer 生命周期、跨回合/死亡/重生/换实体失效、按原 sample 时间选择与同 tick fire 拒绝。现有摘要没有开火精确 tick，无法保证四个 cue 会通过；不应为提高覆盖率降低未来信息边界。

本阶段不再读取 Demo。实际教学消费目标仍未完成；原 UI 暂停 A5、部署/安装、用户数据和模型未触及。
