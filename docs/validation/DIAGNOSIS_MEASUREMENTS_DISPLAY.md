# 诊断数值证据完整呈现

2026-09-26；基线3d7a757（前产品8a7ecee）。本轮仅修复TeachingDiagnosisPanel数值列表与必要换行样式，不改领域契约或数据来源。

| Before | After | Why |
| --- | --- | --- |
| measurements固定取前4项 | 按原顺序显示全部合法measurements（既有schema最多16项） | 道具、弹药等已保存数值不应被静默丢弃 |
| 列数只依赖viewport断点，长标签/值没有明确断行规则 | 列宽按可用容器宽度auto-fit，标签/值可换行，保留原窄屏单列规则 | 侧栏窄于窗口时也允许降低列数，无省略号或隐藏数值 |
| list-style:none的无名列表 | 显式role=list并命名“诊断数值证据” | 保留可访问列表语义，无新增展开操作 |

## A1/A2：真实诊断到实际Panel的SSR证据

调用生产`diagnoseTeachingCue`，传入完整DecisionResources；诊断输出6项，实际Panel SSR的数值行通过逐项标签/值/单位及顺序比较验证如下。0是fixture明确提供的已知值，不代表未知或真实Demo采样。

| 顺序 | 原标签 | 值及单位 | 修复前列表 | 修复后列表 |
| --- | --- | --- | --- | --- |
| 1 | 决策时血量 | 100HP | 有 | 有 |
| 2 | 决策时护甲 | 100甲 | 有 | 有 |
| 3 | 决策时存款 | 800$ | 有 | 有 |
| 4 | 决策时装备价值 | 4100$ | 有 | 有 |
| 5 | 决策时道具数量 | 0颗 | 无 | 有 |
| 6 | M4A4 决策前最近记录弹匣 | 0发 | 无 | 有 |

原解释长文仍可能包含后两项，问题是数值列表截断，不能称这些事实完全不可见。测试限定`li > b + span`行，避免仅查全文导致假通过；原弹药解释“不能当作决策瞬间精确余量”仍保留。

第二个小fixture经生产DiagnosticResultSchema验证16项，确认全部渲染、末项长中英文标签和单位完整；这是合法上限的展示测试，不是16项真实资源诊断。没有增加排序、过滤、分页或展开状态。宽度适配通过CSS审查及production build验证，**SSR不计算布局，因此未证明真实窄栏的视觉效果**。

## A3/A4：兼容及运行结果

新增3项集中渲染测试，复用原测试覆盖已知0/2道具与未知不补0、旧历史trust gate、空数值列表、回看/确认/异议及草稿保护。旧历史即使带16项也不越过trust gate显示旧诊断；空列表不产生空可访问区域，操作保持。

```sh
pnpm exec vitest run apps/web/components/playback/teaching-diagnosis-panel.test.ts apps/web/components/playback/teaching-diagnosis-replay.test.ts
pnpm typecheck
pnpm build
```

基线2红（6→4、16→4），修复后2文件20项全部通过；TypeScript、Next production build通过。本地日志：`.local-data/measurement-display-evidence/`。主控审查实际diff；未新建审查代理或重复上一轮239项回归。

产品diff仅列表map/可访问名称与4条measurement样式声明，不触及回调、effect、Host或请求/写入代码；无新增请求或计数路径。原Limitations截断、判决文案、输入、动画和reduced motion/transparency规则不改。架构/PRD/MVP契约未变，无需新增架构版本。

## 剩余限制

证据是生产诊断函数→实际React SSR输出和现有callback/state测试，不是浏览器截图、屏幕阅读器或完整Host/iframe验收。未开启UI/服务、读取Demo/用户DB/密钥、调用真实模型或Memory、安装部署或改main。只证明已有证据在列表完整可读的输出，不证明诊断质量、事实覆盖或性能提高；原UI A5仍未完成。
