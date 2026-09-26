# Spotted来源、字段可读性与边界

2026-09-26，基线b652845，任务spotted-source-evidence。研究按用户要求保存可执行结论，尚未修改生产Replay或教学输入。

## 一手来源与当前接线

- [demoinfocs v5.2.0 Player.IsSpottedBy](https://github.com/markus-wa/demoinfocs-golang/blob/v5.2.0/pkg/demoinfocs/common/player.go#L184)：作者明确区分spotted与LOS/FOV，并提示多spotter异常；实现以另一个controller EntityID减1定位两段mask的bit。这是该解析器的实现，不直接证明本项目映射正确。
- [CounterStrikeSharp EntitySpottedState_t](https://github.com/roflmuffin/CounterStrikeSharp/blob/main/managed/CounterStrikeSharp.API/Generated/Schema/Classes/EntitySpottedState_t.g.cs)：生成字段为bool和uint32[2]。布局不能证明触发、共享、延迟、残留或注意到目标的语义；未找到足够Valve官方语义材料。
- [source2-demo固定源码](https://github.com/Rupas1k/source2-demo/blob/5dd12b587c0653a96f1c844103fd13d9aea34ace/source2-demo/src/entity/mod.rs)：支持嵌套与0000式数组路径，读取失败可区别于值false/0。
- [cs2d固定props](https://github.com/zenojunior/cs2d/blob/dbbe698c9b9c91f9a14cecea92374b4114bf60ec/packages/parser/src/props.rs)：普通bool/u32 helper会把失败默认false/0，不能直接用于未知性敏感字段。
- 本地当前collector/props/schema无spotted；libs/cs2d-analysis-adapter/src/index.ts只由本人sample构造observerFacts，再传buildObservableState。现有SPOTTED合成测试不是生产敌情证据。

## 原始字段smoke

探针：[visibility-fields.rs](../../tools/cs2d-host/fixtures/visibility-fields.rs)。仅汇总查询成功零/非零、missing和wrongType，不收集身份、坐标或输出逐tick数组。输入为既有test_demo.dem，60,601,900字节；同一进程读一次，先run_to_tick(1024)，字段可读才继续run_to_end，stride8。正确vendor构建14.00秒，native解析1.111秒；不是性能改善对照。

| 属性路径 | zero | nonzero | missing | wrongType |
| --- | ---: | ---: | ---: | ---: |
| m_bSpotted | 67025 | 5258 | 0 | 0 |
| m_bSpottedByMask.0000 | 67025 | 5258 | 0 | 0 |
| m_bSpottedByMask.0001 | 72283 | 0 | 0 | 0 |
| m_entitySpottedState.m_bSpotted | 0 | 0 | 72283 | 0 |
| m_entitySpottedState.m_bSpottedByMask.0000 | 0 | 0 | 72283 | 0 |
| m_entitySpottedState.m_bSpottedByMask.0001 | 0 | 0 | 72283 | 0 |

smoke为128 tick样本/1280 pawn样本，完整为7248/72283。高32位读到零不是字段缺失；非零计数相同也不证明每次bool与mask完全等价，更不证明视线。

## 复现与资源

将探针临时复制到当前已打补丁parser的examples/cs_coach_visibility_probe.rs（若存在则停止），从packages/parser运行：

```sh
cargo build --config 'patch.crates-io.source2-demo.path="/Users/vekel/.codex/worktrees/7f2b/CS-agent/vendor/source2-demo"' --locked --offline --release --no-default-features --example cs_coach_visibility_probe
./target/release/examples/cs_coach_visibility_probe /Users/vekel/编程/CS-agent/demoTests/test_demo.dem
```

编译/运行分别120秒期限；本轮唯一Python controller以finally移除自己创建的example，保留忽略目录.local-data/visibility-fields/vendor-summary.jsonl和build日志。初次未带vendor配置的通用cargo离线修改了构建checkout lock，且读取了一次Demo；此结果未当作生产依赖证据。已撤销本轮引入的libredox更新及source2 registry绑定，再以vendor+locked执行成功，lock保持；总计两次读取，没有下载或安装。不要照抄缺vendor/locked的试跑路径。

## 验收与下一步

一手来源、真实字段可读性、unknown/false区分通过；controller/pawn映射、bit边界、更新延迟、雷达共享与真正LOS未验证。37个Observation/decision-context/patch工具测试、TypeScript、production build通过；不需重新构建Viewer/WASM，因为没有改其生产代码。仅既有parser deprecated和SQLite experimental警告。

研究子任务revision_semantics_review默认配置只读来源调查并RELEASE，主控完成真实probe与接线核实。下一项仅raw-mask解码与身份生命周期小验证；不得将网络标记直接送入当前精确位置Observation或教练反证。若缺语义证据，生产接线继续保守不启用。原锁屏UI A5独立保留。
