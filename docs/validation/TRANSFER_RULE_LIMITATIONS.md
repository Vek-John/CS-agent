# 教学建议适用限制展示

2026-09-26；基线 6c6c720，7f2b/codex/jev-decision-assessment。仅 TeachingDiagnosisPanel、相关测试及文档。

## A1：生产输出到实际 Panel 的红例

`completeResourceDiagnosis` 调用实际 `diagnoseTeachingCue`，使用合成资源事实得到 INCONCLUSIVE verdict。生产 `createTransferRule` 生成“这条规则是条件化建议，不代表已确定归因。”；测试确认它不在 hinge、diagnosticResult、verdict 的限制中。真实 Panel SSR 的“下次记住什么”区域缺少该句，断言失败。另一个 schema 合法 12 条限制 fixture 在同区域显示 0 条；两项先红后绿。

第一项是实际 producer 输出缺失的证据；第二项是列表上限测试，不能把手工构造的 12 条限制称为真实比赛或模型输出。

## A2–A3：最小展示与回归

Limitations 增加默认关闭的 showAll，建议区域显式启用，避开原 slice(0,4)。沿用已有 playerFacingLimitation 技术术语投影和去重，无新增翻译/战术文本；已有玩家文案保持原文。when/do/unless 不改，原通用限制列表保留，最多 12 条已保存建议限制均参与展示。

| Before | After | Why |
| --- | --- | --- |
| 建议仅显示当／做／除非，独有限制缺失 | 同一建议框下面显示已生成的适用限制 | 条件性与建议一起阅读 |
| 复用通用 helper 会只留前四条 | 建议列表 showAll，不按条数裁剪 | 第五到十二条仍可见 |

复用原 ul/li 样式，无固定列表高度、折叠、行数裁剪、新动画或布局系统。父教练栏原有 overflow-y:auto，小屏原有自然页面滚动；原 reduced motion/transparency 媒体规则未改。SSR 可证明文本和操作节点存在，不能证明窄屏滚动、视觉布局或桌面交互实测通过。

相关回归覆盖资源风险、补枪、信息/语音、时机、fallback、旧未可信及缺 transfer 的历史、重播及异议草稿保护。新增断言保留原建议文本、继续/重播/异议入口，JSON 往返同一产物后 SSR 一致，渲染前后 CueCase 不变。没有添加 effect、诊断/模型/Memory/保存调用；Host/Graph/Session/Parser/producer/schema 未修改。

## A4：验证

```sh
pnpm exec vitest run apps/web/components/playback/teaching-diagnosis-panel.test.ts apps/web/components/playback/teaching-diagnosis-replay.test.ts libs/coach-agent/src/teaching-diagnosis.test.ts apps/web/lib/coaching/teaching-diagnosis-host.test.ts apps/web/lib/coaching/teaching-diagnosis-freshness.test.ts
pnpm typecheck
pnpm build
```

相关 5 文件 160 项通过；TypeScript 通过。Web production build 通过。没有新增代理；主控只读复核关键 diff，无 must-fix。

## 剩余限制

- 仅保留已生成的 transferRule.limitations；producer 本身将 result 限制加条件化句后 slice 到 12 条，若前面已占满 12 条，追加句仍可能没有生成。这是独立 producer 范围，本轮不改规则或承诺永远存在该句。
- 已有技术术语投影仍可能把内部描述归为通用玩家提示；本轮未重新审计或改变该政策，也未改变其他列表的前四条上限。
- JSON 往返/SSR 不是真实 DB 恢复、浏览器或桌面验收；无真实 Demo 解析、网络模型、服务、用户数据/密钥、安装部署/main 操作。不据此声称专业判断质量提升。
