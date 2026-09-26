# 活动武器名称与未知刀局证据

2026-09-26，基线546ac82，codex/jev-decision-assessment。

## 问题与最终改动

active_weapon_label原用宽松prop_u32和index-only lookup，活动武器句柄仍指向旧serial时可以取到同index替代实体名称。弹药路径已经校验serial，会出现弹药未知但名称仍错取的问题。

0017限定当前活动名称：m_hActiveWeapon必须Unsigned32、0<packed<0xffffff，当前实体index/可见低10serial匹配，再用原weapon_label和disambiguate_usp。缺失/错类型/失效保持空串unknown，不借库存或旧名称补齐；不native转换、不requirealive，不改primary/grenade_inventory或label表。USP/P2000回归是ItemDefinitionIndex 61/32消歧，不是消音器开关状态。

未知空串原还被当作“什么都没拿”来支持刀局，因此同时修两处assemble推断：整回合要求全为已知Faca；暖场拆分所检窗口遇空名称保守不拆。respawn门不变，玩家身份/血量等资源仍保留。

实际下游检查发现Viewer domain/rounds.ts也把空名称或空players数组判刀局，影响0编号和heatmap/duel统计排除。已把其窄修并入同0017：每帧至少有玩家且所采样名称全为Faca；未知回合保留编号和统计资格。无frames的旧pre-game规则单独保留，不做界面布局/动画变更。沿已读emil/apple技能的准确状态反馈原则执行；无需依赖被锁屏的真实UI操作。

## 验收

- A1：`python3 tools/validate-active-weapon-source.py --baseline-dir /tmp/cs-agent-active-weapon-before`实际旧源6红/4绿，当前10绿。真实标签表、active入口、USP消歧、vendor lookup和assemble两knife闭包注入；stale/current重绑、network非native、错类型/无效范围、可见serial、未知class及原标签均覆盖。
- A2：Adapter空weapon→null、missingFields包含weapon，但生命/护甲/存活与十人名单保持。来源manifest包含active-weapon-identity.v1，旧产物不重算。
- A3：`CS_COACH_KNIFE_BASELINE=/tmp/cs-agent-active-weapon-before/rounds.ts pnpm exec vitest run tools/cs2d-host/knife-rounds-source.test.mjs`旧Viewer源4红/1绿；默认从0017新增/上下文提取真实domain函数后5绿。覆盖空/混合unknown武器、空玩家帧、跨空帧不能判刀，真实Faca以及frameless独立pre-game保持。不依赖ignored checkout即可执行测试。
- A4：82项Adapter/decision-context/return-and-fire＋5 Viewer源回归＋14补丁工具tests，native parser9＋vendor33通过。TypeScript、Web production build、WASM/Viewer build、Viewer vue-tsc通过；存在上游既有deprecated警告。未运行真实UI。
- Patch：最初Rust17补丁clean重放/尾升级/重复reuse通过；发现Viewer消费后追加受控路径与完整函数上下文，只复验一次扩展0017的0016→0017真实尾升级、14工具tests与当前dirty复用，没有反复全量审计。

## 真实消费与资源

复用上一轮已验证546ac82输出一致的本地压缩projection，不再重复读baseline Demo。执行：

```sh
pnpm exec tsx tools/validate-frame-identity.ts --verify <authorized-demo.dem> .local-data/frame-identity/before.json.gz active-weapon-identity.v1
```

外层120秒期限。既有test_demo.dem 60,601,900字节，本轮仅read/parse一次，7.555秒解析、9.971秒含10人Adapter消费/往返。9回合、7,239帧、72,193玩家行的完整frame字段（含武器/弹药/资源）及回合边界在JSON契约下与已验证基线一致；10个bundle、来源标记与时间线JSON往返通过，0网络/模型。不是外部武器真值标注，不能外推所有Demo零变化。

两个默认配置代理分工生产补丁/源注入回归，主控审diff、接线与真实验证。临时fixture/checkout清理，所有构建/测试/解析进程退出，用户数据无改动。日志仅忽略目录`.local-data/active-weapon-identity/real.log`，不提交基线用户数据。

## 限制与后继

保守刀局推断可能少识别存在未知武器的真正刀局；不能为保留旧数量把unknown重新视为刀。Viewer对已采样玩家作判断，public Replay尚不携带内部identity_complete，不能据该函数证明全名单完整。无真实UI/SQLite/专业判断质量验收，未安装、部署或合并main，原UI A5独立待验。

下一具体线索：grenade_inventory的m_hMyWeapons仍index-only解析，缺字段与已知空库存都返回空数组；这会影响是否存在闪光/烟的教学资源判断。先小验证“旧handle误给道具”和“unknown误当没有”的消费边界，再决定如何保留未知语义；不直接重写全背包或泛化本次active名称修复。
