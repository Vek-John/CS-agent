# Jev source capability audit

审计日期：2026-09-22。这是只读源码与本机工具链审计，不是新增 parser 能力或真实 Demo 验证结果。未读取大 Demo/Replay，未运行模型、接触凭证或启动服务。审计适用 cs2d pin `dbbe698c9b9c91f9a14cecea92374b4114bf60ec` 加本工作树已有补丁。

## 结论与可立即实施的工作

**射击行动者保留是可编码缺口，WASM 工具链已经存在；二者不是外部阻塞。** `weapon_fire` 已经给出 `userid_pawn`，Collector 已有同一 parse 内的 pawn→SteamID 解析函数。当前只是将其丢弃。可保留“该玩家在该 tick 开枪”的事实，不需要坐标匹配、死亡或击杀结果。

**射击主体和 spotted mask 都不足以证明重复 peek。** 开枪没有证明目标、视线、接触对象或退出后再次暴露；spotted-by 的上游 API 明确否认其等价于 LOS/FOV，多个 spotter 还有语义限制。故可以先修复事实保留，同时继续拒绝凭这两个字段自动产生 `RECONTACT`/`REPEEK`。真实视觉接触与脱离仍需要独立证据和验证，不能把字段名当真值。

## Shot actor 的最小可信传递链

| 位置 | 当前证据 | 最小改动及限制 |
| --- | --- | --- |
| `.local-data/upstream/cs2d/packages/parser/src/collector.rs:131` | `shots` 只有 `(tick,x,y,yaw)` | 追加 `Option<String>` actor，或等价 RawShot；空值保持未知 |
| 同文件 `:179`、`:286` | `steam_from_pawn_handle` 已通过 entity handle 及 `pawn_to_steam` 解析；map 在每个 tick 刷新 | 复用现有解析，不按最近坐标猜射手；跨重生或无解析时留空 |
| 同文件 `:636` | `weapon_fire` 使用 `userid_pawn` 取 pawn，随后仅保存 tracer 坐标/方向 | 在事件处理时保存已解析 actor；既有 bullet weapon 过滤意味着这不是全部武器动作流 |
| `packages/parser/src/assemble.rs:446` | Raw shots 转为每回合 `Event::Shot` | 原样传递 actor，不重新从后续状态推导 |
| `packages/parser/src/schema.rs:212` | `Shot` 使用 `serde` camelCase | 可选 `shooter_steam_id` 序列化为 `shooterSteamId`；旧数据兼容 |
| `packages/replay-core/src/schema.ts:311` | `ShotEvent` 缺 actor | 加可选 `shooterSteamId`；Viewer 仍可只使用 tracer 字段 |
| `libs/cs2d-analysis-adapter/src/index.ts:159`、`:657` | TS 输入缺 actor；shot 分支直接返回；`:83` 警告无主体 | 增加可选输入、本人归属校验和原始事实。actor 缺失保留降级，不将 actor 的存在升级为 peek 标签 |

该字段属于内部 canonical Demo 事实，可在 Worker 中保留原始身份；进入模型必须经过现有匿名化投影。actor+tick 也不能赋予其他玩家的枪声可听性，不得自动生成所选玩家获得了敌人位置的 Observation。

持久化实现应增加 `tools/cs2d-host/patches/0007-….patch` 并注册到 `tools/apply-cs2d-host-patch.mjs` 的 `CS2D_PATCH_FILES`，不要只编辑忽略的 upstream checkout。当前 `CONTROLLED_EXACT_PATHS` 已允许上述 Rust/TS schema 和生成 WASM 文件；如生成 glue 有实质变化，仅在验证后扩展具体允许路径。为新能力增加 marker，并扩展 `tools/apply-cs2d-host-patch.test.mjs` 的应用/重复应用/受控复用验证。已有 `--build-parser` 会主动将 `~/.cargo/bin` 放在 PATH 首位。

建议验证顺序：先 Rust schema/unit serialization（actor 有值/缺失）与 adapter 本人/他人/缺失测试，再构建 WASM，最后在同一个受控 Worker 里做一次真实 Demo smoke，仅返回 shot 总数、归属/未知数及输出版本。更新 adapter/capability provenance；历史打开不得因此重解析或重新计费。这是建议后续动作，本次审计未执行这些测试。

## Spotted 能读取什么、不能证明什么

本机缓存中的 `source2-demo-0.5.4.crate/src/entity/mod.rs:264` 具有 `get_property_by_name`，返回 `Result<&FieldValue, EntityError>`；其文档支持嵌套名称和 `.0000` 数组下标。因此同一解析过程中读取可用的 spotted 网络属性是工程上可行的，不需要第二次解析或另一服务。[source2-demo API](https://docs.rs/source2-demo/0.5.4/source2_demo/struct.Entity.html)

CounterStrikeSharp 的实际 schema API 暴露 `CCSPlayerPawn.m_entitySpottedState`，其中有 `m_bSpotted` 与 uint32 数组 `m_bSpottedByMask`。这证明 schema 字段存在，**没有证明本 Demo 的序列化路径、采样完整性或游戏视觉语义**。[Pawn schema](https://docs.cssharp.dev/api/CounterStrikeSharp.API.Core.CCSPlayerPawn.html)、[Spotted state schema](https://docs.cssharp.dev/api/CounterStrikeSharp.API.Core.EntitySpottedState_t.html)

demoinfocs 自己实现 `IsSpottedBy` 时，以 observer 的 controller entity index 减一对应 mask bit，并读 pawn 上的 `m_bSpottedByMask.0000/0001`。其文档明确说这不是 LOS/FOV，多个 spotter 可能不符合预期。这是 parser 作者定义，不是 Valve 发布的完整可见性规范。[demoinfocs implementation](https://github.com/markus-wa/demoinfocs-golang/blob/master/pkg/demoinfocs/common/player.go)

由以上源码可做的保守设计是保留“指定 observer bit 在该采样 tick 被设定”的原始网络状态，并标出解码版本、mask 是否存在、controller 映射是否完整。必须使用可选读取；当前 `prop_bool`/`prop_u32` 的默认 false/0 会混淆缺失和未设定位，不能直接用于该能力。实际属性可能是扁平路径而非 schema 展示的嵌套路径，须用本项目 pinned parser 的真实 Demo 小型 smoke 证实，不能直接宣布任一拼法可用。

以下语义在本次一手资料审计中**未得到证明**：

- 指定位意味着该玩家已实际看见目标、注意到雷达或获得精确位置。
- 团队任一成员设位意味着所选玩家获知；`m_bSpotted` 全局布尔尤其不提供 observer 归属。
- 清位意味着目标离开真实 LOS，设位意味着重新暴露；也未验证 bit 更新延迟、持续时间、烟/闪光影响和多观察者交互。
- 下采样帧之间没有未记录的状态变化。当前 Collector 约 8Hz 的 Frame 采样不支持把短暂消失/重新出现压成精确 tick 事件。

因此，若先实现 mask 保留，应留在不参与决策包接受的诊断/原始事实层，直到 observer 语义经可控 replay/POV 或引擎级证据验证。团队 spotted、直接视觉、报点与个人认知必须继续区分。无需断言这条路径永远不可用，但本轮不能诚实将它认证为视觉接触真值。

## 工具链实测

2026-09-22 只运行路径/版本/installed-target 查询：

| 查询 | 结果 |
| --- | --- |
| 默认 `command -v cargo` / `cargo --version` | `/opt/homebrew/bin/cargo`，1.97.1 Homebrew |
| 默认 `command -v rustup`、`command -v wasm-bindgen` | 默认 shell PATH 未找到 |
| `/Users/vekel/.cargo/bin/wasm-bindgen --version` | `wasm-bindgen 0.2.125`，与现有 `packages/parser/build.sh` 要求一致 |
| `/Users/vekel/.cargo/bin/rustup target list --installed` | `aarch64-apple-darwin`、`wasm32-unknown-unknown` |
| `/Users/vekel/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc --version` | 1.97.1 |

本机缓存还存在 `source2-demo`/macros/protobufs 0.5.4 crate。未运行构建，所以不能以缓存及版本查询代替编译成功；不过“缺工具链导致无法扩展”已被当前证据否定。无安装操作。

## 仍需获得的证据

shot actor 扩展可独立实施；spotted raw capture 可以独立实验但须避免授予其个人可见性权限。自动再次接触/重复 peek 识别需要独立、可验证的接触—脱离—再次接触定义及来源：例如经过验证的可见性算法/POV 对照，或清楚标记来源、时间与不确定性的人工动作注释。仅增加 actor/mask 不足以填补这一条件。专业 CS2 教练留出标注仍是战术正确性验收所需条件，不能由这个源码审计或规则产生的标签替代。
