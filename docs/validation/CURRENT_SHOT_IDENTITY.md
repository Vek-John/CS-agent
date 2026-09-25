# 射击事件即时身份归属（2026-09-25）

基线7bcf32f（618c33b＋交接），分支codex/jev-decision-assessment。A1—A5本地实现、回归、构建与一次真实消费完成；本次不评估专业教学质量。

## 确定性问题复现

旧weapon_fire首先使用source2-demo 0.5.4的get_by_handle（实际只以低14位index取实体）取得几何，再通过steam_from_pawn_handle读取tick_start时的pawn_to_steam[index]。实体复用或同tick controller绑定改变后，两个读数都可能已经过期。

`python3 tools/validate-shot-identity-source.py`直接抽取当前生产weapon_fire分支、身份helper与依赖的原get_by_handle函数，编译到一个小型Rust实体生命周期夹具。夹具替代实体存储和属性访问，不重写待测归属算法，也不声称模拟完整Demo消息解码。原始7项测试1通过、6失败：

| 触发 | 旧生产路径结果 | 必须满足的结果 |
|---|---|---|
| 同index从serial3变为4，旧事件仍指serial3 | 画新实体位置，actor仍旧缓存111 | 不生成shot |
| 同tick当前controller已从111换成222 | actor111 | actor222，几何来自同一pawn |
| 当前controller解绑 | actor111 | 合法几何保留，actor null |
| 当前controller冲突/重复/无效SteamID/不同handle | actor111 | 合法几何保留，actor null |
| 索引处为非CCSPlayerPawn | 仍画shot | 不生成shot |
| native index超出network可表示范围，但低位命中实体 | 仍画shot | 不生成shot |

这些是合成生命周期数据，不是已发现真实样本误归属。失败日志留本地忽略目录；修复后同一7项全绿，新增同一Collector连续换绑/解绑和signed native/可见serial位两项，最终9项全绿。

## 窄修复与降级契约

- 0011仅把weapon_fire接到verified_event_pawn：复用上一轮已验证的native→packed转换，当前pawn必须匹配class/index及network保留的低10位serial；身份来自唯一当前controller的完整packed m_hPlayerPawn绑定、有效SteamID。
- helper返回同一个pawn引用及可空owner。几何和身份从这一结果同时取得，不再读tick_start缓存。无法验证pawn时不输出shot；pawn有效但owner未知时照常保留几何，actor为null。不会为了保持旧计数保留已知错误几何。
- hurt_victim_steam仅委托该helper取owner，其原判定语义保持。共享旧steam_from_pawn_handle及kill/ADR/bomb/grenade/pickup调用方不变；尤其m_hThrower等network字段没有被套native转换。
- 没有改变合法shot的字段、构造顺序、坐标计算或现有数组排序。如果旧解析包含现在被拒绝的shot，删除它会使同回合后续基于数组位置的引用改变；不能承诺这种错误输入跨版本索引不变。新版内部引用一致，旧保存产物原样恢复、不重解析重写。
- generatedBy新增shot-identity.v2并保留hurt-events.v1；Adapter manifest使用`/hurt-events.v1/shot-identity.v2`，旧hurt-only和无标记输入的provenance保持。Adapter/Planner算法版本未变化。旧缺actor输入仍不能凭位置认人，RETURN_AND_FIRE/contact/LOS等教学门不变。
- 只核对network实际携带的serial位，不声称验证native完整17位；有效pawn的坐标属性仍按既有读取规则，未扩展为全字段精度审计。

沿用[上一轮来源核实](SELF_HURT_EVIDENCE.md#来源与归属)，未重复网络研究或额外native Demo探针。

## 检查结果

| 验证 | 结果 |
|---|---|
| 生产源码注入的Rust生命周期回归 | 9通过（原7项先6红） |
| 实际parser Rust单元测试 | 3通过（原hurt转换/归属及shot序列化） |
| Adapter、RETURN_AND_FIRE、Observation、Narration、恢复与patch工具 | 186通过，1既有WebGPU保存产物对照因缺本地产物跳过 |
| pnpm typecheck / pnpm build | 通过 |
| pnpm cs2d:build | 实际WASM与Viewer生产构建通过 |
| pnpm cs2d:typecheck | 通过 |
| 独立5分钟只读边界终审 | 无阻断项，已明确跨版本删除事件的索引变化 |

构建成功后才运行最终消费，没有编译失败后运行旧binary；没有安装工具。生产夹具编译及运行分别60/30秒期限、临时目录自动删除；Viewer构建600秒、最终WASM120秒。

## 一次真实WASM消费

已有约60.6MB Demo、既有选人；只读一次，Replay和原始字节留单一进程，返回统计摘要。解析6141ms，至Adapter/历史往返/教学包6311ms。这是本次耗时，不是性能提升对照。

| 指标 | 实测 |
|---|---|
| 回合 | 9 |
| shot总数 / actor非空 / null | 1242 / 1242 / 0 |
| 非有限几何 / 越界tick / roster外或错误类型actor | 0 / 0 / 0 |
| 本人shot / 时间线WEAPON_FIRE | 152 / 152 |
| RETURN_AND_FIRE候选 | 2 |
| 全部候选 / 正式教学点 | 44 / 4 |
| hurt总数 / 可归属 / 本人 | 264 / 264 / 27 |
| snapshot含本人hurt / 正常公开clock | 23 / 38 |
| 教学包消费hurt / clock | 2 / 3 |
| 序列化往返与双parser provenance | 通过 |

1242与旧记录相同，hurt和clock统计与上轮一致，只证明此样本兼容、未见这些覆盖回退；没有逐发外部真值对照，不能宣称绝对身份准确率。真实样本没有null actor，unknown降级由生产路径夹具和序列化测试证明。

复用命令（调用方对WASM设120秒进程上限；先确认当前构建成功）：

```sh
python3 tools/validate-shot-identity-source.py
cargo test --no-default-features --lib --manifest-path .local-data/upstream/cs2d/packages/parser/Cargo.toml
pnpm exec vitest run libs/cs2d-analysis-adapter/src libs/observation/src libs/review-planner/src/narration-package-builder.test.ts libs/review-planner/src/teaching-gates.test.ts apps/web/lib/recovery tools/apply-cs2d-host-patch.test.mjs
pnpm exec tsx tools/validate-current-shot-identity.ts <已有Demo路径> <玩家名>
```

没有模型/Jev重评、浏览器/UI/桌面实际验收、用户SQLite/Memory/密钥访问、安装/发布/部署或main合并。原教学工具暂停A5仍独立未验。未检查其他事件生命周期，也未扩大完整性审计。所有本轮测试、构建和WASM进程已退出，临时夹具源码未留上游；提交的是可复用测试工具和fixture，本地忽略目录仅保留小日志/摘要与基线文本。当前任务完成push后释放写入。
