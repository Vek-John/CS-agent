# 时机诊断消费已知回合时钟（2026-09-26）

先核实自适应诊断：trade已有同目标视线/接触窗口说明，information已有来源/对象/位置/时点核对，timing已有缺少比较器的说明，因此不重复上一轮回看问题列表。

实际缺口是时机诊断packet没有接收解析器已产出的回合时钟：即使可确认剩余时间，结果仍只有笼统缺项。新增可选decisionClock紧凑DTO（remainingSeconds/evidenceRefs），实际Host与严格事件接线，诊断沿既有数值证据列表显示“决策前最近采样的回合剩余时间（约）”。不新增布局。

| Before | After | Why |
|---|---|---|
| 已知回合余量未进入时机诊断 | 显示带原决策引用的约秒数 | 区分已经知道与仍然缺失的信息 |
| 笼统列剩余时间等缺项 | 已知余量时明确仍缺安全路线/接触/替代选项，且非C4倒计时 | 不把数值背景升级为时机判断 |

## 验证

13项新增集成回归：带时钟的合成Replay→真实Adapter→Host input→严格SUBMIT_REFLECTION→确定性时机诊断→实际Panel SSR；保留UNVERIFIABLE/INCONCLUSIVE，JSON恢复后的显示仍带限定。未知旧packet没有数字，不补0；future/stale/wrong-player/wrong-decision/hidden/unknown/not-live/unobserved/bad-ref/outcome-ref均不通过Host数值投影，诊断模块再次拒绝仅指向结果事实的引用。

第一批6文件241项通过；补充3边界后13项新测试与TypeScript再通过，共244项不同相关测试通过。production Web build通过（补充后只改测试）。独立partial_revision_restore默认配置只读窄审RELEASE，无must-fix；主控核对真实diff与输出。

## 限制与行动

合成时钟不是本轮真实Demo测量；没有运行模型/真实网络、用户数据库、安装或浏览器。SSR不是完整Host视觉验收。默认诊断仍无可靠时机比较器；不因显示约110秒等数值判定选择正确或错误。已有旧存档不重生成，字段可缺省。

本轮保守复用currentDiagnosisSnapshot新鲜度门，因此本人状态不完整时公共clock可能也被剔除。下一项只用真实Adapter缺本人/已有公共时钟的小场景核实该限制是否造成可用事实丢失，再决定是否需要独立公共时钟投影；不放松本人资源门或填补未知倒计时。
