# 当前教练状态栏的道具种类

2026-09-26，基线81fc947。

## 可观察行为

已确认种类但无法确认颗数时，教练当前状态显示“闪光弹、烟雾弹（数量未知）”；五种既有标签均映射中文。明确空继续“无道具”，完全未知不造标签，旧明确数量仍沿原“N颗道具”。不新增道具存在性或专业判断，只呈现已经验证的Snapshot事实。

Host显式传当前cue decisionTick与coachingView.decisionFacts。只有quantity未知、state缺口为inventory.count且无其他inventory缺口、Snapshot OBSERVABLE、合法非空唯一种类、玩家ID/sample tick/decision tick一致、采样不晚于决策，并且引用命中同sample tick的已观察DEMO/DECISION Fact时才能展示。

最初直接比Snapshot引用与Timeline raw state ref失败：真实生成链把state-rN-t重映射成canonical fact-cs2d...-state。修正为解析当前cue实际事实引用及采样时间，保留引用门，未通过放松证据要求制造通过。

## 组件与样式

沿已读emil-design-eng/apple-design技能，复用原status chip列表、图标和资产解析。将原Host内联列表提取为实际生产CoachingStatusList，让SSR测试直接渲染同一组件；Host已接该组件，没有复制测试专用UI。长种类标签加max-width:100%、文本min-width:0/overflow-wrap:anywhere，保留完整不确定性说明。已有box-sizing、reduced-motion/transparency规则继续生效，不加动画、材质、交互或网络依赖。

## 验收证据

- A1：真实Adapter产物驱动View，Flash/Smoke中文组合及五种名称通过；实际生产CoachingStatusList SSR包含完整种类/数量未知，语义ul/li与装饰图标aria-hidden保持，没有无道具或伪造颗数。
- A2：玩家不匹配、sample不匹配、decision不匹配、未来采样、错误来源引用、unknown、重复/无效kind、其他库存缺口、非OBSERVABLE边界均不显示；缺decisionTick也不补。旧精确数量及已知空保持。
- A3：新增长文本布局约束经源码核实；SSR验证实际markup，不等于浏览器宽度/视觉实测。未重试锁屏的旧UI路径，未验证小屏截图。纯文本变化不新增键盘交互或motion/transparency依赖。
- A4：上一轮SQLite恢复链Flash/Smoke实际两红→绿，使用生产buildCoachingCueView的decisionFacts；6库存情形保存关闭重开恢复仍正确，颗数保持未知、健康证据有效，重新分析/讲解/transport/Viewer请求0。42项相关测试、TypeScript和Web production build通过；未改Parser，不重复WASM/Demo实验。

root拥有View/Host/组件/CSS/unit/docs，partial_revision_restore默认配置独占SQLite集成测试，revision_semantics_review默认配置5分钟只读审查无must-fix。所有临时库finally清理、测试/build进程退出，无用户DB/模型/浏览器/安装/部署。原工具暂停UI A5仍独立未验。

## 限制与后继

证据真实性依赖已验证Bundle的Snapshot/事实来源契约；这里增加展示绑定，不是外部游戏真值验证。旧精确数量产物不重算，SSR不证明真实浏览器布局。

下一项先小验证而不预设改动：Host playerStateAtOrBefore只取不晚于cue的最近状态，旧health/armor等chip无当前Snapshot绑定。需要核实真实Adapter候选/恢复路径是否可能在缺当前玩家或过旧采样时仍显示旧资源；只有实际可复现误导才改，避免把合法决策前采样误判成错误或扩大为全UI审计。
