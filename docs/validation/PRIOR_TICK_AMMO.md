# 决策前弹药采样：真实教学消费从 0/4 到 3/4

2026-09-26；基线 `c460634`（产品 `9092a71`）。本轮实现并验证了独立的最近 tick-end 小缓存，保留 strict-prior、当前实体与变化失效门。实际教学消费验收通过；剩下一个同决策 tick 开火的点正确拒绝。未验证专业判断质量提升。

## A1：真实生命周期与来源时间

source2-demo 原源码不变。`vendor/source2-demo/src/parser/demo/runner.rs:123` 每条命令先触发 tick-start，再处理命令；`messages.rs:159` 进入更大 tick 时先结束旧 Context，随后更新 tick 再 start。同 tick 多条命令不重复触发回调；第一 tick 没有前置 end，跳 tick 不会生成中间时刻。生产入口使用 `run_to_end`。

0013 中的 Rust fixture 经真实 Parser、protobuf CNetMsgTick 和真实 Observer 驱动生产 AmmoCache。合成命令序列 `[100,100,101,104,105,103]` 中，100 的两条消息先后写 marker 7/6，start101 只能携带实际 end100 的 6；start104 拒绝 end101，start103 倒退拒绝，重复同 tick 命令只产生一组回调。未读取文件 Demo，不把 fixture 时间称为 canonical Demo tick。夹具首版缺 DemSyncTick，落入 prologue 而未进入回调，测试失败；补齐生产协议后通过，未修改生命周期实现来迁就测试。

## A2：有界缓存与失效

`capture_end` 每个实际 tick-end 一次 controller 扫描，再按 index 查必要 pawn/weapon；不再为每玩家扫描全部实体。身份绑定 controller index/serial、pawn handle/full serial、weapon handle/full serial、side 与 round signature。当前tick-start复核身份与存活。每tick整批替换缓存，缺失/无效/死亡/重复身份清除，存储为 O(当前玩家数)，没有追加逐tick历史。

`begin_tick`只接受记录中的实际 ended tick 与当前相邻，不能用当前tick减1构造样本。首次、跳跃、倒退或重复回调、回合变化失效。frame建立时复制合法此前样本，同tick结束不会再覆写frame ammo。新生产字段 `ammoCacheMaxEntries`仅为实测缓存条数摘要，不是固定10人的理论硬上限，也不是内存RSS测量。夹具连续10,000 ticks仍仅一条玩家缓存。

## A3：版本、Host与兼容

Parser player `ammoSamplingVersion:2` 即使最新ammo缺失也保留，ammo自带 `version:2`、真实sampledAtTick。Adapter 1.10保留sample独立ref，如 `state-5-31179-weapon-ammo-end-at-31178`。v2缺失不回退到旧frame；v1仍按sample==原容器tick解释，不能冒充更早记录。旧bundle 1.9继续可读，已保存诊断不重算。

Host在原player/round/alive/snapshot门之后，要求ammo sample属于当前round、严格早于decision、半秒以内、早于v2容器tick，且当前武器实体相符。已知变化仍按 `sample < event <= decision` 拒绝，包括decision同tick开火；采样同tick开火已先于tick-end被记录，允许使用其结束后的余量。首轮round_start事件在start后才处理，所以Host独立source-round检查不可省略。

43项弹药测试覆盖v1/v2区别、同tick/future/过旧source/跨round/当前身份/最新缺失不回退，以及Adapter→Host本地→strict Graph compact独立refs消费。legacy rich缺独立decision时间仍unknown，compact不增加身份/handle/tick。风险门、候选/路线/评估、Verdict/Transfer和备弹规则均不改变。

## A4：唯一真实验收

[机器可读紧凑证据](PRIOR_TICK_AMMO_EVIDENCE.json)。使用既有Demo和原目标玩家，先fixture/零Demo消费smoke，再成功构建生产WASM与Viewer，最后由一个外部进程组控制器执行120秒deadline。新阶段读取/解析各1次，跨调查与实现阶段累计各4次；无重试、网络或模型调用，bulk留在同一进程/WASM，未保存Replay。

| 指标 | 前阶段0012 | 本轮0013 |
|---|---:|---:|
| 目标玩家frame条数 | 7,239 | 7,239 |
| 有效ammo记录 | 2,960 | 2,970 |
| 空clip采样记录 | 41 | 41 |
| 正式cue消费 | 0/4 | 3/4 |
| 来源距当前容器 | 同tick结束；Host需退到早8ticks的frame | 真实早1tick的结束记录 |
| 缓存最大条数 | 未测 | 10（实测） |
| 解析耗时 | 9,198 ms | 7,118 ms |

本轮总耗时7,363 ms。单次耗时与前阶段不同，不足以作稳定性能提升结论。41是空弹匣采样记录，不是41次打空事件。

| cue | sample → decision（canonical Demo ticks） | 实际消费 | 失效事件 |
|---|---|---|---|
| c1 | 19425 → 19426 | 无 | WEAPON_FIRE @19426，仍拒绝 |
| c2 | 31178 → 31179 | M4A4，11发；measurement与独立ref一致 | 无 |
| c3 | 44506 → 44507 | FAMAS，12发；measurement与独立ref一致 | 无 |
| c4 | 45090 → 45091 | AK-47，14发；measurement与独立ref一致 | 无 |

同一次解析Replay移除新ammo进行消融：44候选assessment、整个ReviewPlan、4个正式Host诊断status/Verdict/Transfer advice均一致。3个新增measurement实际进入本地讲解结果，不只是有来源字段。没有修改cue、放宽开火门或使用decision同tick结束信息。

## A5：验证、交付与限制

- Native：同一显式vendor工具链的 `testParserNative`，parser 9项、vendor 33项通过。
- `pnpm exec vitest run` 指定ammo、teaching host、diagnosis、graph、adapter、patcher/toolchain的7文件：180项通过；`pnpm typecheck`、`pnpm build`通过。
- `CARGO_NET_OFFLINE=true pnpm cs2d:build`及`pnpm cs2d:typecheck`通过。没有安装或升级依赖。
- 干净固定PIN worktree完整13patches→reuse通过；在同一自有fixture移除0013后，标准reuse从0012实际升级0013通过。vendor、Cargo lock与其他decoder未改。
- 默认配置只读子代理 `ammo_lifecycle_review` 完成生命周期研究与实现终审，无must-fix；主控复查真实diff与输出。没有并行写文件或单独读取Demo。

采样仍不能证明期间动作事件完整，换弹/捡放覆盖未知；备弹未知。文案继续“决策前最近记录”，不当作决策瞬间精确余量，不据低弹匣自动判错或建议换弹。未执行真实浏览器UI、应用安装或部署；原UI暂停A5不在本轮。事实来源/实际消费目标通过，不将本次单Demo覆盖推广成全部Demo或专业教学准确率。
