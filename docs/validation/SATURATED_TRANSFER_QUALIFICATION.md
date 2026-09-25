# 限制饱和时保留条件化建议说明

2026-09-26；基线 af0ec28；7f2b/codex/jev-decision-assessment。仅 createTransferRule、相关测试及文档。沿用前轮展示能力，无 Panel/CSS 变更。

## A1：实际生产链复现

三个合法合成输入分别通过实际 diagnoseCue 的资源风险（道具未知）、语音同步、声音信息路径。10 条输入限制经 executeDiagnostic 加入对应的两条说明，得到 12 条 DiagnosticResult.limitations 和 INCONCLUSIVE verdict。

旧 createTransferRule 追加“这条规则是条件化建议，不代表已确定归因。”后 slice(0,12)，三个用例均证明：原 12 条仍在，但新增说明既不在 limitations，也不在 do 中，产生 3 个目标失败。不是手填 DiagnosticResult 伪装完整链路。输入是合成夹具，不代表真实比赛或模型实测。

## A2：最小处理

保留原有 limitations 生成顺序和 12 条上限。仅当 INCONCLUSIVE 且最终列表没有完整条件化句时，在固定生成的 doText 末尾附同一句，以现有 TextSchema（800 字）校验。所有已有 result 限制逐条保留，不替换最后一条、不往 240 字的 ShortText 条目拼接，也不提高上限。

普通未饱和结果仍把说明放在原来的 limitations 位置；when、原 doText、unless、refs 和 confidence 不变。非 INCONCLUSIVE 不新增此说明。该变化不添加判决、战术选项、证据或状态，不修改 schema、Host、Graph、Session、Memory、Parser 或模型。

| Before | After | Why |
| --- | --- | --- |
| 12 条列表占满时追加说明被丢弃 | 原建议说明后保留完整条件化句，12 条列表原样保留 | 同时保留适用限制和不确定归因 |
| 普通结果从 limitations 展示说明 | 保持原位置 | 不改变未饱和展示 |

## A3：保存与兼容证据

- 三条生产链测试扩到每条输入限制恰为 240 字，完整保留 12 条 result 文本；对照普通输入确认仅 do 追加和 limitations 存在差异，when/unless/refs/confidence 保持，do 不超过 800 字，LearningThread 同步持有相同规则。
- 非 INCONCLUSIVE 的函数边界测试复用真实饱和 result，仅置换 verdict type，证明不会附该句；该项是局部边界测试，不冒称生产生成了这种判决。
- 实际 diagnoseTeachingCue 生成饱和 CueCase/LearningThread，经过真实 validateReviewArtifactAppend、内存 restoreHistoryControlPlane、validateStoredReviewArtifacts，再进入实际 TeachingDiagnosisPanel SSR。新产物的 12 条限制及条件化句全部可见。
- 旧形态 fixture 使用修复前的原 do 文本和同一 12 条限制，经同样保存/恢复校验保持原样，Panel 不回填缺句。恢复前后产物相等；没有调用重新诊断路径。此处使用真实 validator 与内存 DTO，不是 SQLite 写入/用户数据库恢复验收。

## A4：命令与结果

```sh
pnpm exec vitest run libs/coach-agent/src/teaching-diagnosis.test.ts apps/web/lib/review-history/artifact-validation.test.ts apps/web/components/playback/teaching-diagnosis-panel.test.ts apps/web/components/playback/teaching-diagnosis-replay.test.ts apps/web/lib/coaching/teaching-diagnosis-host.test.ts
pnpm typecheck
pnpm build
```

5 文件 102 项通过，3 红转绿，TypeScript 通过；Web production build 通过。已有 Panel 限制列表、重播/异议草稿、诊断/保存回归通过。无子代理，主控只读复核关键 diff，无 must-fix。

## 剩余边界

旧已保存的缺句产物仍按原样恢复，本轮只修新生成结果。上游 executeDiagnostic、CueCase、verdict 等其他已有裁剪不在范围；不承诺保留那些从未进入 result 的输入限制。既有技术词玩家投影不变。本轮无真实 UI/桌面、Demo、网络模型、DB/Memory、服务、安装或部署；SSR 不等于浏览器布局验收，也不证明专业判断准确性提升。
