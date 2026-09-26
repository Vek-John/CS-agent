# 异议修订后当前追问

2026-09-26，基线538275f；主控独占，小范围gate修复。

| Before | After | Why |
| --- | --- | --- |
| 完整DISAGREED诊断显示，但追问context被拒 | revision>=1、异议已使用且原完整归属/结果门满足时开放原问法 | 完成修订后仍能理解当前反馈 |
| 修订前回答可由旧页面回调尝试提交 | 继续使用来源key，拒绝旧key | 不把原判断的回答套在新结果上 |

实际diagnoseTeachingCue→reviseTeachingDiagnosis→Session RECORD_TEACHING_CASE→当前context/Panel，default/manual两例初始都因context undefined失败。修改只新增DISAGREED资格与修订信息核对。覆盖新建议呈现、旧key拒绝、input无变化、busy/无完成门/版本0/异议次数0拒绝；原3+4+建议问法不扩。

```sh
pnpm exec vitest run apps/web/lib/coaching/current-cue-questions.test.ts apps/web/lib/coaching/current-cue-resource-questions.test.ts apps/web/components/playback/teaching-diagnosis-replay.test.ts libs/coach-agent/src/teaching-diagnosis.test.ts
pnpm typecheck
pnpm build
```

4文件173tests、TypeScript通过；Web production build通过。没有新fixture模拟解析/模型/Memory副作用，使用实际纯模块并比较输入前后不变；没有完整Host/browser/desktop实测。原布局、动效、reduced motion/transparency和键盘入口不改；不是视觉验收。主控负责测试/build退出，无服务/临时DB。
