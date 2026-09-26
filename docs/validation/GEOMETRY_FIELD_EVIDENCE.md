# 几何字段完整性证据

2026-09-26，基线fe1941a。此轮是诊断证据，不改变生产坐标协议。

## 源码结论与决策

`props.rs:56–70`的world_coord分别为缺失／错误类型的cell和offset补零，再计算`cell*512-16384+offset`；因此可能产生有限伪坐标，单凭Number.isFinite不能识别。合法零也不能当作缺失。Float非有限值当前未在此函数拒绝。

玩家采样直接消费world_coord；Adapter normalizeStateSample只校验finite，然后产生本人world_position、位置标注及本人观察事实，return-and-fire依赖该距离。Viewer useReplay直接插值x/y。因此一旦真实字段缺失，风险是把默认值当本人位置，而不是敌方可见性问题。

不能简单丢整个player行：assemble判断所有玩家alive且满血来识别respawn边界；丢行可能错误提前freeze，且DecisionSnapshot完整名单、生命和资源仍可能有效。若未来有触发样本，最小兼容方向是保留tick/身份/非几何状态，给玩家位置独立可用性，并同批让Viewer插值、位置事实/标注及移动提名拒用未知几何。不得以地图边界值过滤或隐式null→0替代明确语义。

**本轮决策：暂不改生产协议。** 下述真实样本未发现字段缺口，没有证据支持立即跨Parser/Viewer/Adapter改造。保留可复用小探针和明确失败时的处理方向；不把静态风险描述成已经观测到的产品事故。

## 真实探针

`tools/cs2d-host/fixtures/geometry-fields.rs`在tick_start每8tick读取所有当前CCSPlayerPawn的六个cell/offset字段，另外在death/plant/fire事件按native index/可见serial核对当前pawn后读取。不做owner推断；事件实体核对只是界定字段样本，不授予教练事实。tick_start抽样不声称与生产last_cap的每个采样点一一相同。

分开统计valid、missing、wrongType、nonfinite、zero；不会输出身份、坐标、事件数组。先run_to_tick(1024)检查可用，随后同一parser继续到结尾。真实test_demo.dem 60,601,900字节仅read/parse一次，0.776秒native运行：

| 范围 | 样本数 | 缺失/错类型/非有限的样本 |
| --- | ---: | ---: |
| tick_start pawn，7,247个采样tick | 72,273 | 0 |
| player_death当前pawn | 73 | 0 |
| bomb_planted当前pawn | 7 | 0 |
| weapon_fire当前pawn | 1,590 | 0 |

六字段全部符合world_coord接受类型，0事件pawn解析失败。实际样本六字段zero计数均0；合法零和缺字段分离由小分类测试覆盖，不能声称真实零输入已测。smoke128个tick/1,280 pawn、缺口0；早期无目标事件，完整阶段才产生事件计数。

该样本不代表其他Demo、所有网络更新瞬间或其他grenade/C4实体；没有验证游戏真实位置、插值质量或未知几何UI。没有重复扩大到大型Demo来追求“造出缺口”。

## 验证与复现

1项Rust分类回归：合法Unsigned16/8 cell零、Float offset零、missing、错类型、NaN/Infinity分开；26项decision-context/return-and-fire测试、TypeScript及Web production build通过。生产Parser/Viewer代码未改，不重复构建WASM。native test39.80秒、build5.92秒，仅既有deprecated warnings。

将fixture临时复制到当前parser的examples/cs_coach_geometry_fields.rs（存在则停止），使用tools/cs2d-parser-toolchain.mjs的preflight和cargoArgs，分别运行：

```sh
cargo test --config 'patch.crates-io.source2-demo.path="/Users/vekel/.codex/worktrees/7f2b/CS-agent/vendor/source2-demo"' --locked --offline --release --no-default-features --example cs_coach_geometry_fields
cargo build --config 'patch.crates-io.source2-demo.path="/Users/vekel/.codex/worktrees/7f2b/CS-agent/vendor/source2-demo"' --locked --offline --release --no-default-features --example cs_coach_geometry_fields
./target/release/examples/cs_coach_geometry_fields <authorized-demo.dem>
```

唯一Node controller对每stage设120秒timeout，finally删除自建example；无安装/网络/模型/数据库/UI，全部进程退出。忽略目录`.local-data/geometry-fields/`保留build/test日志和统计。只读消费预检代理默认配置，已RELEASE；主控拥有probe/集成/文档。

## 下一项独立工作

collector玩家采样仍把controller的network `m_hPlayerPawn`交给index-only get_by_handle，然后采集生命/资源/位置；这是不同于native事件的packed句柄路径。下一步先用当前采样代码与同index新serial的生命周期小例验证是否存在“身份正确但采到替代pawn状态”，再决定局部packed校验；不能直接复用native转换或把此轮零缺字段推成身份正确。几何可用性改造等待触发证据，原锁屏UI A5不影响该独立验证。
