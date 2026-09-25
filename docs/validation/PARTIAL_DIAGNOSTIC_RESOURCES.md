# 可信部分资源的独立测量（2026-09-25）

基线7d5de37（aad0732＋交接）。A1—A5本地实现与验收完成。本轮只改诊断字段可用性及已授权的三值资源背景，不改Parser或全域PlayerState。

## 实际问题与结果

生产Host回归使用新鲜、正确身份与回合的样本：health70、armor80，raw helmet为默认false，当前DecisionSnapshot.helmet为null；另一例同时标missing helmet。旧实现把资源整体丢弃，两例先红，修复后保留70HP/80甲，头盔未知，资源背景UNVERIFIABLE。没有为此读取真实Demo。

| Before | After | Why |
|---|---|---|
| 头盔未知导致已知血量/护甲一起消失 | 显示70HP/80甲，明确头盔未知 | 独立字段缺失不抹去已有事实 |
| 部分高值或空对象可被误当完整资源 | 核心判断字段不全时UNVERIFIABLE | 未知项可能改变结论 |
| 用!hasHelmet会把undefined当没头盔 | 只有明确false才说明无头盔 | 保留unknown与known false的区别 |

## 来源与接口

1. 原整体门保留：cue→segment→唯一round（含freeze/end半开）、同player、非未来合法tick/rate、ceil半秒、最新唯一采样、明确存活/阵营、死亡事件和snapshot身份/时间/OBSERVABLE/missing身份信息。整体不可信仍没有资源。
2. 通过整体门后，health/armor/helmet/money/equipmentValue独立判断，合法范围与原schema一致。raw missing、undefined/null、非有限/越界值仅省略该字段。已有snapshot时，其对应字段须明确可用且与同tick raw值一致；snapshot显式unknown、missing或数值/布尔冲突否决该字段，不能由归一化默认值补回。
3. 库存沿既有utilityCount分类/完整性/数量规则；snapshot.grenades非数组或inventory missing使道具数未知。本轮不比较snapshot与raw库存的具体内容/数量，不声称完成了库存一致性审计。
4. DecisionResources的health/armor/hasHelmet由必填改为optional，缺字段表示未知；其它值域和strict未知键拒绝保持。Host先省略非法原始字段，远端直接提交非法null/数值仍按strict schema拒绝，不自动转成false/0。
5. Host不再构造/传递诊断decisionState，而是本地与远端共用同一份compact资源。低层legacy rich入口仍可用并复用字段投影；同时有显式compact（包括只含refs的空投影）时compact优先，绝不合并rich默认值。全域PlayerState类型与旧rich schema未放宽。
6. refs始终来自该当前样本，未借其他facts背书；decisionRoster独立时效/引用/新优先旧兼容保持。legacy inventoryCount不重新解释为道具数。

明确的raw 0HP与alive=true矛盾继续整体拒绝，即使snapshot血量不同；health缺失标记导致的默认0不是死亡证据。独立终审发现初版先省略冲突血量会绕过这个旧门，组合回归先1红/1绿，改成字段投影前检查后两项通过。已知0护甲/金钱/装备值/道具数及已知false头盔仍保留，不与missing混淆。

## 三值资源背景

数值阈值仍为health<=45、armor<=0、明确hasHelmet=false；ECO/FORCE继续提供已有受限经济语境。

- 任一明确已知的低预算条件：PARTIALLY_SUPPORTED，只陈述已知受限背景。例health30而护甲/头盔未知，会说30HP及其余未知，不编造无护甲/无头盔。
- health/armor/helmet全部已知且未触发原阈值，也无受限经济语境：SUPPORTED，保持完整合法输入的既有背景分类。
- 其余情况：UNVERIFIABLE。health100+armor100但头盔未知、空资源对象、仅FULL/PISTOL经济、仅金钱/道具等均不能证明资源足够。

所有风险分支Verdict仍INCONCLUSIVE，不提升专业判错资格。解释分别列已知值和影响判断的未知核心项；道具未知说明继续独立保留。经济类别用玩家可读的“手枪局/经济局/强起/完整购买”，不把内部枚举带进可见文字。

## 验证与兼容

7文件177测试通过，无最终跳过；pnpm typecheck、pnpm build通过。

- 原2条Host红回归转绿；覆盖单字段missing/非法、同tick primitive冲突、最新样本部分缺失不退旧值、known false/0、全部unknown、empty compact优先、FULL-only、45/46阈值和原时效/死亡/roster边界。
- 实际Host→strict event→remote envelope→内存Graph及同包→真实POST函数，与本地DiagnosticResult/Verdict/Transfer一致；新增partial、low-partial、all-unknown、known-false四类。资源投影仍无身份、tick、位置或完整库存。
- 原utility/legacy inventoryCount、decisionRoster冲突优先级和Graph幂等继续通过。实际恢复新增partial与既有0/2/legacy1.5保存测量原样，零fetch，不重诊断或重解释历史。
- TeachingDiagnosisPanel静态渲染显示70HP/80甲、头盔未知、无错误“无头盔”，保留继续按钮。未修改布局/CSS/键盘与辅助入口；沿用已读emil-design-eng/apple-design、本地Next指引。SSR不称浏览器实测。

```sh
pnpm exec vitest run apps/web/lib/coaching/teaching-diagnosis-freshness.test.ts apps/web/lib/coaching/teaching-diagnosis-host.test.ts libs/coach-agent/src/teaching-diagnosis.test.ts libs/coach-agent/src/teaching-diagnosis-graph.test.ts apps/web/app/api/coaching/diagnose/route.test.ts apps/web/components/playback/teaching-diagnosis-panel.test.ts apps/web/lib/recovery/cs2d-session-recovery.test.ts
pnpm typecheck
pnpm build
```

旧新鲜度回归中“单字段缺失必须丢整份”的断言按新授权改为“该字段缺失，其余可信字段保留”；原年龄/回合/未来/身份/死亡用例保留，不通过删掉整体门迁就partial。中文经济文案映射时暴露economyFrom返回类型仍含undefined，已修正为实际NonNullable返回类型，最终TS/build通过。

## 限制与清理

时间门仍由Host负责；低层rich调用方须先提供可信状态。上游未标记的缺失或库存内容差异不由本轮恢复。旧已保存错误测量仍原样读取，只修正新诊断；不自动重新分析/计费。

无Parser/Viewer改动、真实Demo/模型/浏览器/服务/真实DB/Memory/密钥访问、数据迁移、安装部署发布或main合并，原锁屏A5保持未验。不声称专业准确率提高。

root独占实现；partial_resources_review继承默认配置做5分钟只读终审及1分钟闭合确认，唯一死亡门回归已关闭，没有写入或启动持久进程。所有测试/build退出，忽略目录仅留小日志；代码文档同次commit/push后释放写入。
