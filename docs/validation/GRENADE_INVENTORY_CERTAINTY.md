# 道具库存历史尾部与完整性

2026-09-26，基线b99d12e，codex/jev-decision-assessment。

## 真实问题与依据

旧grenade_inventory遍历get_iter的全部children、flatten丢未知项，再按实体index找标签。三处语义问题：动态向量缩短后历史尾部仍被读到；失效handle可取替代实体；部分已知列表被当完整，['Smoke']能使教学断言没有Flash。空Vec原被serde省略，因此此前真正空与未知都变undefined，并不是已把空[]传给模型。

本地依据：source2-demo entity/mod.rs get_iter遍历FieldState.children；field/state.rs set只扩容；commands.rs为ValueVector父值配置Unsigned32，serializer区分父路径与子decoder。一手解析器[demoinfocs Issue #450](https://github.com/markus-wa/demoinfocs-golang/issues/450)明确以m_hMyWeapons说明父属性是length，长度外存在残留项。这是协议解析器实现证据，非Valve正式规范。

首次native只看全部children：72,273 pawn、414,532槽，其中52,257 serial不符、122,380实体不存在。依据该发现扩展同探针读取父长度：72,273父值全为有效Unsigned32、无超64/缺项；前N共197,474槽全部当前绑定有效，而60,179个列表有217,058个历史尾槽，显式长度0有18,536个。源码机制与真实字段分布一致，不能继续用整个children推库存。

## 修复与兼容

0018只读N<=64前缀，strict network handle类型/范围/index/低10serial与可分类实体；任何前缀项未知整体None。N0或全验证后没有道具类型为Some([])，历史尾部完全忽略。64仅防护界限。未发现0/MAX可当合法空槽的依据，保持未知。

Rust grenades改Option并skip_none，新样本固定grenadeInventoryVersion=1，collector/assemble透传。可选public字段兼容旧Replay；已知[]不省略。primary、标签表、decoder、锁文件不改。

Adapter共享verifiedGrenadeKinds只接版本1合法完整去重列表；旧raw无版本和新None均未知，不能据partial说没Flash。已知种类可用于presence，去重长度不是颗数，因此不造count=1条目，不说“N颗道具”。已知非空inventory.count缺失；未知inventory缺失；仅完整空支持零。名单/生命/护甲等保持。Adapter/Signal1.11、Timeline1.2记录派生改变；旧保存1.10等bundle不重算。用户需重新解析才能修正旧已保存事实，本轮未改用户历史。

## 验收与真实消费

- A1源回归：旧实际入口8红/3绿，当前11绿；覆盖长度shrink且历史尾部仍有效、N0+tail、缺/错root、过界、短数组、None槽、invalid/stale/unknownclass、partialSmoke、类型去重、合法非道具库存为空。fake root/children仅用于生命周期，不替代真实协议读取。
- A2/A3：真实Adapter→DecisionSnapshot→projectDecisionUtilityCount覆盖旧partial、新unknown、knownempty、Smoke/Flash类型、重复类型拒绝；knownempty明确0，nonempty颗数未知。保存1.10产物带原count仍直接读，未以新规则重写历史。原事实文案“2颗”测试改为“种类/颗数未知”。旧frame source fixture同步Option stub后10绿。
- A4：273相关tests通过，另10项教练View测试通过（合计283）；1个既有缺WebGPU产物测试跳过；15patch工具tests，native parser9+vendor33、TypeScript/Web production build、WASM/Viewer build/Viewer TS通过。独立审查及主控实际diff复核针对本次数据边界，不做反复全量审计。18补丁clean重放、17→18/13→18与重复reuse通过。

本轮共两次必要native probe（全children1.089秒、显式length1.104秒）和一次最终生产WASM解析；均为既有60,601,900字节test_demo.dem、单进程一次read/pass、先1024tick smoke后继续，输出仅统计。最终WASM7.410秒，10人Adapter消费与往返共9.842秒：

| 最终玩家采样 | 数量 |
| --- | ---: |
| 明确无道具 | 48,315 |
| 完整非空道具种类 | 23,878 |
| 未知库存 | 0 |
| 相比旧值发生库存变化 | 49,341 |
| 旧声称有道具、按当前向量改为空 | 8,774 |

这是重复时间采样行数，不是玩家数或独立错误事件数。与此前已验证基线比对，7,239帧/72,193玩家行、9回合边界及所有非库存字段保持一致；仅预期grenades/version字段排除相等比较。10人新bundle都通过schema/JSON往返，非空种类不产生伪造颗数。0网络/模型调用。没有独立游戏画面真值或专业判断质量提升证明。

独立终审发现实际三阶段UI的局部utilityCount只识别inventory缺失，不识别inventory.count，导致已知Flash/Smoke被显示“无道具”。已用真实Adapter→View两红回归复现，改为复用同一projectDecisionUtilityCount纯函数（独立package subpath，不加载Graph）；四种Flash/Smoke/unknown/knownempty与原View共10项通过，只有完整空继续显示无道具。最终TypeScript/Web build复验通过，审查确认关闭。沿既有emil/apple技能保持准确反馈，未改动布局或动画，未声称真实UI操作已测。

## 资源、复现与后继

probe为tools/cs2d-host/fixtures/inventory-fields.rs；临时置入parser examples，使用现有preflight选定工具链、vendor cargoArgs、--locked --offline构建，再运行授权样本。每stage120秒上限，唯一controller finally删除自建example。最终消费使用：

```sh
pnpm exec tsx tools/validate-frame-identity.ts --verify <authorized-demo.dem> .local-data/frame-identity/before.json.gz grenade-inventory.v1
```

仅本地忽略目录保留probe/build/real-final日志和压缩基线；源码及小fixture提交。两个默认代理独占生产patch/源回归，主控拥有TS/probe/集成，全部进程和临时checkout退出，无安装/部署/用户DB/UI。原A5独立待验。

下一具体问题：primary_weapon也使用同一动态向量全children和index-only lookup，可能从已丢弃/历史物品推断当前收起的主枪。现在已有可靠length语义与本样本tail证据，下一轮先复现真实源并界定Viewer收起武器展示，再做同一局部边界修复，不重写整个装备系统。非空道具物理颗数继续未知，不能通过取消去重猜计数。
