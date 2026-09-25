# 核对当前已验证资源数值

2026-09-26；基线62e22a7（前产品7913aac）。仅扩充本地追问的明确资源核对，不修改解析器、诊断结果、推理、模型或持久化。

## A1 真实来源与四个红例

Synthetic timeline/observer/snapshot＋标准ammo normalizer → 生产`buildTeachingDiagnosisInput/currentDiagnosisResources` → `diagnoseTeachingCue` → 实际TeachingDiagnosisPanel SSR：完整诊断已展示35HP、0甲、0颗道具、AK-47决策前最近记录0发。原问答对以下四句仍返回不支持、零数值项；4红后接线4绿。

| 明确问法 | 修复后核对项 |
| --- | --- |
| 我当时多少血？ | 当前合法来源与已展示measurement一致的35HP |
| 当时有多少护甲？ | 已知0甲，不替换为unknown |
| 当时有几颗道具？ | 已知0颗，不把缺失当0 |
| 弹匣当时还有几发？ | 决策前最近记录0发，附非瞬间精确、换枪/换弹可能未知、备弹未知限定 |

这些是合成来源协议/界面夹具，不是新增Demo解析或精确Demo tick测量。健康值使用35；既有alive=true且raw health=0矛盾门仍拒绝，不能为“保留0”放宽这个门。

## A2 来源契约与缓存

先向主控提交最小来源契约并获确认：沿用既有Window/Resources，不复制采样/库存/弹药算法。新增reader检查plan拥有该cue、player/demo/material归属，合法compact仅通过页面内WeakMap source token交给追问模块，伪造或序列化出的revision对象无效。来源替换/清空时旧token也失效。

当前完整诊断通过原question gate及CueCase schema后，只匹配`measurement-${cueId}-health/armor/utility/weapon-clip`。要求唯一ID、number值相同、规范label/unit相同、非空引用集合完全一致（不接受重复引用）。普通refs使用生产诊断相同的去重前8项，ammo用独立refs。不会凭标签、用户自称数值或任意历史数值回答。缺显示行、缺来源、旧来源、数值/标签/单位/引用冲突均返回来源缺口。

cache单条保存不可变plan/cue/timeline/material引用和selectedPlayer；渲染与live回调共用。测试spy观察**初次投影后**连续20次草稿更新＋真实Session replay/end新增投影调用0；同cue新timeline调用增至1、新material增至2，随后相同来源仍为2。新source revision进入question key，即使数值相同也不复用旧问答；旧回调拒绝，旧token不再提供数值。只证明调用复用，不代表真实大Demo耗时基准。遵守源对象不可变替换约定，未增加按键filter/sort轨迹。

## A3 交互与边界

原3类问法、300字/4条、页面内保存、重播保留和case revision门保持。资源问法使用有限整句匹配；“如果只有5滴血该怎么打”、自称数值、其他cue、职业/语音或错误前提不因包含资源关键词就获得数值回答或建议。baseline和未可信history不提权。

| Before | After | Why |
| --- | --- | --- |
| 已展示的资源数值无法直接追问 | 四类明确问法返回经双重核对的原值及来源 | 方便核对，不新增事实或判断 |
| 文本输入仅提示通用事实/限制 | 增加一句可核对血量、护甲、道具、此前弹匣的提示 | 保持原三条快捷按钮和简洁布局 |

实际受控Panel submit callback→生产question update→SSR显示弹匣回答及来源；没有内部ref/handle泄露。诊断verdict/transfer/attempt/thread前后不变，无新Provider、诊断、Memory或历史调用。没有新控件、样式、动画或reduced motion/transparency改动。

## A4 验证

新增43项覆盖四类正例及0、显示行缺失/篡改/重复、类型/label/unit/refs、伪造token、生产来源缺失/矛盾/过期/未来/身份失效；ammo同tick/未来/过期/前回合/实体变化/本人开火换弹捡放/最新缺失；假设与跨域问句；history/baseline、cache复用/失效及实际Panel回调输出。

```sh
pnpm exec vitest run apps/web/lib/coaching/current-cue-resource-questions.test.ts apps/web/lib/coaching/current-cue-questions.test.ts apps/web/lib/coaching/decision-ammo.test.ts apps/web/lib/coaching/teaching-diagnosis-freshness.test.ts apps/web/components/playback/teaching-diagnosis-panel.test.ts
pnpm typecheck
pnpm build
```

最终5文件210项通过；TypeScript和Next production build通过。测试扩展期间3处readonly fixture赋值被TS拒绝，改为不可变来源替换后全部通过；无产品基线失败。本地日志`.local-data/resource-question-evidence/`。主控实际diff复核无must-fix，未另建审查代理。

## A5 / 剩余限制

架构、学习日志及任务板同批更新。没有浏览器、完整Host挂载、真实iframe或辅助技术验收；SSR/回调/生产来源夹具不冒称这些检查。无新增Demo解析、真实模型、服务、用户DB/密钥或安装部署/main操作；进程由本轮清理。仅支持明确有限问法，manual和跨重启历史仍不支持，不代表MVP开放语义问答、专业判断或性能提升；原UI A5仍未完成。
