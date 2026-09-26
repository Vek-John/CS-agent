# 收起枪械的当前库存验证

2026-09-26，基线2b36007，codex/jev-decision-assessment。

## 实现及实际消费范围

旧primary_weapon遍历全部历史children、忽略serial，且见到第一支primary就提前返回，可能显示已丢弃的枪或掩盖后续未知项。复用上一轮已证的动态向量长度语义，不重复做长度probe。

0019抽取private current_inventory_labels，先完整验证显式N<=64前缀、strict network packed范围/index/低10serial与可分类标签，再返回按槽位顺序、保留重复的标签。枪械执行既有USP/P2000定义编号消歧；primary从完整列表选第一primary，否则第一pistol。任一当前项未知、或确认只有刀/道具/C4/Zeus时沿旧空字符串/serde省略回退。共享helper让grenade沿同一身份边界筛选、原类型去重语义保持，未改active、schema、购买算法或UI。

真实消费者：ViewerRoster普通模式仅在当前weapon=Faca时使用primary，缺失回退刀；hostMode本来只显示active。buyBreakdown的holdsGun及carried main gun选择读取primary或合法active。该修复改善普通Viewer与经济来源，不声称增加教练判断能力。

## 验收

- A1/A2：实际primary源before9红/3绿→当前12绿，覆盖动态尾部、根0、missing/invalid/stale/unknownclass、早遇primary后unknown、完整64槽、当前重绑/低10serial、第一primary/第一pistol及USP61/P200032。既有grenade 11项断言不变，补充共享helper源码提取后全绿。
- A3：`node tools/validate-primary-consumers.mjs`提取并执行实际ViewerRoster.shownWeapon与buyBreakdown.holdsGun，9断言覆盖普通持刀收起枪、缺失回退、active保持、Host只active与经济枪身份选择。不是完整购买账重建或真实浏览器验收。
- A4：88相关Vitest（含16patch工具）、TypeScript及Web production build通过；native parser9+vendor33、WASM/Viewer build、Viewer vue-tsc通过。首轮root重复添加已存在primary类型声明造成TS失败，已删除重复项后通过，不计作产品红例。既有deprecated/SQLite/stripTypeScriptTypes警告保留。
- 接线：0018→0019实际受控工具升级和重复reuse通过，未重跑无收益全栈审计。两个默认代理分别拥有补丁/源回归，主控读实际diff；独立只读终审无must-fix。

## 真实生产WASM验证

对既有60,601,900字节test_demo.dem修前、修后各单read/parse，120秒进程期限，0网络/模型。修前7.578秒；修后7.410秒，含10人Adapter消费/JSON往返总9.864秒，不是性能提升实验。

| 对比项 | 结果 |
| --- | ---: |
| 回合／frame／玩家行 | 9 / 7,239 / 72,193 |
| primary变化的采样行 | 19,777 |
| 旧primary非空、当前省略 | 18,655 |
| 变化时当前持刀、普通Viewer选择会变化 | 683 |
| 所有非primary字段（含已修grenades及其版本） | 相同 |
| 全部回合边界 | 相同 |

数字是重复时间采样行，不是独立玩家或购买事件数。primary差异是本轮预期结果；验证器只排除primary比较，其他字段和边界仍严格按持久JSON契约比较。10个bundle来源、schema、时间线往返通过。修前压缩基线853,088字节留忽略目录`.local-data/primary-identity/`；不会传给Agent或提交用户数据。单样本不代表外部游戏画面真值或所有Demo零未知。

复现命令：

```sh
pnpm exec tsx tools/validate-frame-identity.ts --baseline <authorized-demo.dem> .local-data/primary-identity/before.json.gz grenade-inventory.v1
pnpm exec tsx tools/validate-frame-identity.ts --verify <authorized-demo.dem> .local-data/primary-identity/before.json.gz primary-weapon.v1
```

baseline必须在此前版本WASM运行；源码与二进制不同阶段需按来源标记核实，不能在新parser上伪造旧基线。所有本轮测试/构建/解析进程退出，临时fixture/checkout清理，无安装/部署/用户DB或浏览器。原UI A5独立待验。

## 限制与下一项

空primary仍不区分“未知”与“确认无枪”，消费者仅保守回退，不据其证明没枪。旧历史不自动重算；没有完整经济账或UI验收、专业判断质量结论。

最近库存派生已升级Adapter1.11/Timeline1.2，现验证覆盖了JSON往返，尚未把这一特定的knownempty/knownkind/unknown语义走一遍隔离SQLite保存、重开、History Restore→教练View。下一有限目标针对该实际恢复链验证语义及零重分析调用；只在发现真实丢失时修复，使用临时库，不触用户库或因锁屏停止工作。
