# 决策前弹药：来源调查交付，未接入产品

2026-09-26；基线 `a4f3ca4`（产品 `82d234f`）。**本轮没有发布弹药功能。** 两次真实解析确认字段解码边界；未执行第三次读取。已撤回本轮实验产品接线、恢复原解析器与生成产物。后置 Signed32 逆变换不作为正式事实来源。

## 一手来源

| 来源 | 核实结果 |
|---|---|
| cs2d `packages/parser/src/weapons.rs:165` | active weapon来自`m_pWeaponServices.m_hActiveWeapon`。 |
| 锁定source2-demo 0.5.4 `src/entity/container.rs:169` | `get_by_handle`只使用低14位index，未校验serial。可靠新证据须另验14位index＋10位serial；不能仅复用索引查询。 |
| source2-demo 0.5.4 `src/entity/field/decoder.rs:73,106` | 声明int32的字段进入`Signed32(read_var_i32())`；当前库没有clip专用修正。 |
| 同版本`src/stream/reader/slice.rs:155–161`与seekable同名函数 | 先将unsigned varint转i32，再按奇偶做算术右移/取反。高位原wire的信息可能丢失。 |
| [demoparser decode_ammo](https://raw.githubusercontent.com/LaihoE/demoparser/main/src/parser/src/second_pass/decoder.rs) | 该字段读取unsigned varint，正wire减1。本项目要求wire0保持未知，仅wire1为空弹匣0。 |
| [demoinfocs底层field_decoder](https://raw.githubusercontent.com/markus-wa/demoinfocs-golang/master/pkg/demoinfocs/sendtables/sendtablescs2/field_decoder.go) | 同样有clip专用unsigned读取与减1；其当前[高层equipment](https://raw.githubusercontent.com/markus-wa/demoinfocs-golang/master/pkg/demoinfocs/common/equipment.go)也出现减1，因此不能把两层API拼在一起当唯一正确数值依据。 |
| [Valve 2026-03-18公告](https://steamcommunity.com/games/CSGO/announcements/detail/532126482488623354)、demoinfocs AmmoReserve | 新旧Demo备弹单位不同，新版依武器可为弹匣/霰弹/发数；缺时代和单位映射时不得直接写ammo_reserve发数。Python total_ammo_left是聚合值，不能替代clip。 |

当前本地依赖位于`~/.cargo/registry/src/index.crates.io-1949cf8c6b5b557f/source2-demo-0.5.4/`，本轮只读，没有修改共享registry。

## 两次真实验证

[匿名小摘要](DECISION_AMMO_EVIDENCE.json)保留两个完整结果。bulk只存在单owner进程/WASM，未保存Replay、帧或身份dump。每次外部120秒process-group期限，0网络/模型。

| 次数 | 授权与目的 | 解析 / 总计 | 结果 |
|---|---|---|---|
| 1 | 原任务的一次生产WASM验收，先编译与消费smoke | 9,093 / 9,321 ms | 本人7,239帧，ammo来源0、4个正式cue消费0；44候选assessment、完整plan、诊断status/verdict/advice与同次Replay字段消融一致。 |
| 2 | 主控明确追加，定位哪个拒绝门阻断 | 9,150 / 9,381 ms | 所有通过身份/生命/武器门的clip均为Signed32：tick-end 32,005次全被Unsigned-only拒绝；其中7,774次为-16。handle均u32、life均u8零，未发现身份世代门拒绝。仍0正式消费。 |

计数覆盖所有采样玩家，正式消费摘要只针对原目标玩家。第2次是临时诊断构建，不算产品解析能力。probe在读取前有早退计数fixture，编译成功后才运行，且没有从probe旁路填入clip。首次的0覆盖不是教学层拒绝，而是来源读取类型错误。

第3次曾获得附条件授权，但随后高位歧义发现使条件改变为原wire无歧义解码；因此**第三次没有运行，累计读取/解析均2次**。

## 为什么不能在调用端补一个inverse

在小wire域，31经当前signed reader变成-16，inverse可还原31，再减1得到30。离线实验及fixture能通过，但这不足以证明事实正确：

- wire `1` 与 `0xfffffffe` 均可读成Signed32 `-1`。后置inverse会把异常高位值变成“空弹匣”。
- wire `31` 与 `0xffffffe0` 均可读成Signed32 `-16`。后置结果无法区分合法30发与异常输入。
- 输出限制0..255不能找回已经丢失的信息；不能宣称已拒绝所有原始超界/哨兵值。

[离线反例与拟议规格](../../tools/ammo-codec-boundary.test.mjs)可运行：`node --test tools/ammo-codec-boundary.test.mjs`，3项通过，无Demo读取。它不是已安装的decoder修复，也不证明真实消费。

## 最小正确修复与下一必要条件

[可review的局部建议diff](SOURCE2_AMMO_DECODER_PROPOSAL.patch)针对source2-demo 0.5.4 `src/parser/demo/commands.rs`构造Field前，仅在`feature="cs2" && var_name=="m_iClip1"`时选择`FieldDecoder::Unsigned32`。保留原wire，不在该层减1；cs2d消费层再`checked_sub(1)`并检查明确支持的范围。其他int32保持原decoder。

公共API无法做同等替换：FieldDecoder、Field、Serializer、FieldReader及Parser.field_reader均为crate私有；Context只读。Observer虽见原SVC包，但缺公开字段路径/serializer，重新定位等于重做实体解码；DemoRewriter拿到已解码值也无法挽回高位。当前“不修改registry、不安装依赖、不大规模vendor”的范围下无可控窄入口。

下一有限任务可独立评估项目内受控vendor/fork＋Cargo path override：固定版本和许可证、只应用上述字段diff、可复现构建；不修改共享registry。至少需要真实字段decoder fixture覆盖raw0、raw1、31、41、101、高位值和其他int32不变，再编译生产WASM，获得独立真实读取预算后验证。不能沿用本轮小域inverse为正式实现。

## 已验证但未发布的下游设计

实验将tick-end弹药与既有tick-start玩家资源分离，使用独立来源ref；严格选择决策前最新样本，核对本人/回合/新鲜度及两端已验证武器handle。同tick、可证本人开火/换弹/捡放物品、同名不同实体均拒绝。两端一致不能证明区间从未换枪/换弹，文案只能称“此前最近记录”。compact不发送原handle、tick或玩家身份，低弹药不改风险门/判决/训练建议。

实验中本地及strict Graph消费fixture通过，31项弹药边界、相关150项tests、TS/Web build曾通过；**这些代码已撤回，不计作本次产品功能验收**。只读review发现的实体切换及两帧测试缺口已纳入私有研究快照，便于正确源修复后复用。

私有快照：`.local-data/ammo-evidence/rejected-implementation/`按repo路径保存实验diff对应文件、测试、parser patch和验证脚本；`preprobe/`保存探针前Rust，`baseline/`保存原源文件。仅本地、未作为产品代码提交，不含Demo/Replay。日志与两次匿名输出在同一目录。

## 恢复与局限

本轮曾因临时probe额外WASM export使生成JS/类型文件成为未批准dirty paths而被标准reuse门拒绝；没有放宽allowlist或运行旧binary。恢复原源码后，使用既有buildParserWasm重生成普通绑定，静态确认无probe export，再跑原Viewer构建。没有第三次解析。

最终交付是来源证据、反例、局部上游建议和学习记录。弹匣与备弹在当前产品仍按未知处理；未证明教学质量提升。原UI暂停A5、用户数据、Memory、模型、浏览器服务均未触及。

最终恢复检查：7个upstream源文件与本轮前快照逐字一致，新ammo模块不存在；apps/libs/原patch工具tracked diff为零。普通WASM静态导出检查无ammo_probe，原`pnpm cs2d:build`通过；离线3项、原patch工具8项通过，恢复后的`pnpm typecheck`和`pnpm build`通过。所有自有parse/probe/build进程已退出，保留的仅源研究快照与小证据。
