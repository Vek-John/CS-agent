# 教学诊断道具数量（2026-09-25）

基线8290f72（e90493b＋交接）。A1—A5本地实现与验收完成；本轮只纠正资源测量和未知说明，不改变风险判断门。

## 原问题与新行为

生产Host和rich DecisionState都将inventory所有count相加，随后标成“决策时道具数量/颗”。两条实际消费者各有2个回归先失败：仅AK-47得到1而应为0；空数组同时missing_fields含inventory时得到0而应未知。首轮4失败/20通过，修复后原24全通过。

| Before | After | Why |
|---|---|---|
| 完整库存仅一把WEAPON，显示1颗道具 | 0颗 | 已知武器不是道具 |
| inventory缺失标记＋空数组，显示0颗 | 不生成数值，说明道具数量未知 | 未知不等于已知为空 |
| 旧inventoryCount被直接当道具数 | 字段继续可读，新诊断不将其解释成道具数 | 旧数值表示全物品总数，不能重新赋予语义 |

## 分类与完整性契约

InventoryItem.item_class是开放字符串，不是受限enum；当前cs2d Adapter库存产UTILITY，旧类型/夹具还使用grenade。共享projectDecisionUtilityCount用于Host紧凑投影及本地rich入口：

- 只计明确UTILITY/GRENADE（大小写归一）；WEAPON/KNIFE/BOMB/RIFLE/PISTOL明确不计，其余类别使总数未知。不检查item_id名称，不通过smoke/flash等名字猜类别。
- inventory须为最多32条数组，missing_fields须存在且是数组；inventory、inventory.*、inventory[...]缺失标记使总数未知。支持已知空数组和显式count0；重复同类型条目仍按条目数量求和，不擅自去重合法两颗闪光。
- 每个条目数量须为非负安全整数且<=64，道具总数<=64；任一条目类别/数量不支持时整份计数未知，不能过滤坏项后报0。32与64为已有诊断传输边界，不是游戏携带上限或实际模式规则。
- 新DecisionResources.utilityCount可选，strict schema只接受0..64整数，缺字段表示未知。旧inventoryCount原finite/nonnegative/max64规则保持（含旧合法小数），新诊断忽略它；同时存在两字段时只读utilityCount。
- 原rich schema对负数/NaN/Infinity等输入仍拒绝；原先允许的小数/超范围数量经共享投影变未知。没有放宽旧输入校验，也没有把不合法数量钳为0。既有有效输入的Host紧凑与rich口径一致。

未知新增有界自然语言说明；限制列表仍最多12项。健康、护甲、头盔、经济的风险阈值不变；测试比较诊断status与Verdict除新增limitations外全部字段相同。

## 接线与旧记录

真实Host submission builder→strict CoachAgentEvent→序列化remote envelope→内存Graph，以及同包→实际POST /api/coaching/diagnose处理函数均验证混合库存、已知空、部分、未知类别和小数五种场景，与本地rich诊断一致。资源投影不发送完整inventory、item_id、玩家身份、坐标或tick；API仍拒绝这些额外字段及非法utilityCount。

同事件重复dispatch保持原CueCase、trace和reflection预算1，没有新诊断副作用。实际restoreCheckpointTeachingCase在暂停cue中恢复新0/新2及旧1.5测量，经过JSON和严格输出schema后保持原测量及门状态，fetch计数为0。旧已存DiagnosticMeasurement不是待重算库存：历史错误标签/数值原样保留，本轮不改写旧产物、不自动重新诊断或计费。

实际TeachingDiagnosisPanel静态渲染验证0/2颗及未知文字，继续按钮保留；没有修改组件布局、CSS、动画、键盘/辅助入口。按项目要求读取emil-design-eng/apple-design与Next本地文档；SSR不等于浏览器交互验收。

## 验证命令与结果

- 6文件79项相关测试通过，无跳过。
- pnpm typecheck、pnpm build通过。
- 原4项红回归已保留；补充分类、整数/总量、完整性元数据缺失、12条限制上界、旧字段/严格API、Graph幂等、实际恢复和SSR。

```sh
pnpm exec vitest run libs/coach-agent/src/teaching-diagnosis.test.ts libs/coach-agent/src/teaching-diagnosis-graph.test.ts apps/web/lib/coaching/teaching-diagnosis-host.test.ts apps/web/app/api/coaching/diagnose/route.test.ts apps/web/components/playback/teaching-diagnosis-panel.test.ts apps/web/lib/recovery/cs2d-session-recovery.test.ts
pnpm typecheck
pnpm build
```

集中复查由本任务自行完成，未委派；只修改contracts可选字段、诊断helper/schema/测量、client导出和Host投影及相关测试文档。Graph/API/恢复实现未改。

## 限制与清理

库存完整性依赖上游缺失标记；若上游已经丢弃坏条目且没有标记不完整，本层无法恢复丢失事实，本轮不扩展成Parser或全资源管线重构。未做新Demo解析、外部模型、浏览器/桌面UI、真实DB/Memory、大压力测试或Viewer构建（未改Viewer）。原锁屏工具A5保持未验。

没有改风险判决资格，不声称专业教学准确率提高。没有迁移、用户历史重写、密钥访问、安装/发布/部署/main合并；全部测试/build退出，无服务或浏览器进程，本地忽略目录仅留验证日志。提交push后释放当前树写入。
