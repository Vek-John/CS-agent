# Spotted候选位映射与当前身份

2026-09-26，基线87f9694，任务spotted-identity。只读研究工具，无生产Replay/Observation/教练变化。

## 契约与测试

[spotted-identity.rs](../../tools/cs2d-host/fixtures/spotted-identity.rs)读取已验证的扁平mask路径，每8个解析tick重建当前controller/pawn snapshot。位公式沿用[上轮上游来源](SPOTTED_SOURCE_EVIDENCE.md)：controllerEntityId减1，不把controller ID与零基slot混写。所需mask段None为unknown，Some(0)才是未置位；另一段缺失不取消已知段。

身份仅在当前CCSPlayerPawn index及网络handle低10位serial匹配、SteamID非0/最大值、owner与SteamID无重复时关联。高packed位、sentinel和超14位pawn index拒绝；上次snapshot只计连续样本重绑，从不填补当前缺失。

3个Rust单测覆盖：bit0/31/32/63，非法controller ID0/65，分段未知/zero；同index新serial、当前解绑；错误class、重复pawn/SteamID、缺失/非法handle和高index。它们是合成生命周期，不能叫真实Demo tick或真实重生实测。

## 真实样本

既有test_demo.dem（60,601,900字节），vendor source2-demo0.5.4，locked/offline release。先1024tick smoke，再同parser继续；仅汇总，不输出身份、坐标或rawmask。

| 指标 | smoke | complete |
| --- | ---: | ---: |
| 采样tick | 128 | 7248 |
| pawn样本 | 1280 | 72283 |
| controller样本 | 1408 | 79728 |
| 有效当前绑定 | 1280 | 72283 |
| 未知当前绑定 | 128 | 7445 |
| 缺失mask段 | 0 | 0 |
| 置位样本 | 12 | 6573 |
| 可映射双方当前身份 | 12 | 6573 |
| 未知target / observer | 0 / 0 | 0 / 0 |
| 自指对 | 0 | 0 |
| 连续采样间重绑 | 0 | 0 |

未知controller原因没有被猜测。6573次置位全部映射仅支持候选公式在此样本的结构覆盖，不是独立游戏语义标注；该样本未观察到重绑，不能据此证明所有重生/换绑情况。不能推出LOS、雷达实际显示、队内共享、玩家感知或无人。

## 命令与资源

临时复制probe到当前parser examples/cs_coach_spotted_identity.rs；若已存在则停止。从packages/parser运行同一vendor参数：

```sh
cargo test --config 'patch.crates-io.source2-demo.path="/Users/vekel/.codex/worktrees/7f2b/CS-agent/vendor/source2-demo"' --locked --offline --release --no-default-features --example cs_coach_spotted_identity
cargo build --config 'patch.crates-io.source2-demo.path="/Users/vekel/.codex/worktrees/7f2b/CS-agent/vendor/source2-demo"' --locked --offline --release --no-default-features --example cs_coach_spotted_identity
./target/release/examples/cs_coach_spotted_identity /Users/vekel/编程/CS-agent/demoTests/test_demo.dem
```

每stage120秒期限，唯一Python owner finally清example，锁文件不变；只保留忽略目录.local-data/spotted-identity日志/小摘要。首轮后补高index/重复SteamID守卫并最终复验，共2次单pass读取；最终native0.843秒，不是性能提升对照。37项Observation/decision-context/patch回归、TypeScript/production build通过；既有parser deprecated与SQLite experimental警告，无安装/模型/用户DB。

主控实现和实际diff复核；revision_semantics_review默认只读方案风险复核并RELEASE。后续不直接接spotted教学，在有独立语义证据前保留研究结果。下一独立工作是bomb事件仍用旧缓存/索引归属的具体路径验证；锁屏UI A5继续独立待验。
