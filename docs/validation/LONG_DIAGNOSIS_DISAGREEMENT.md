# 合法长异议与限制饱和修订

2026-09-26；基线7a32699。主控接管认证失败但未写入的任务01a0daba-7e7c-7fd2-a199-fc23c43bd643，无并发写入。

## 复现与根因

`pnpm exec vitest run libs/coach-agent/src/teaching-diagnosis.test.ts -t 'accepts separately valid|accepts one disagreement'` 实际2红，分别是rawText>500及cueCase.verdict.limitations/cueCase.limitations>12。每段输入均合法；真实runtime Graph调用前者并在异常后fallback。错误栈直接定位约束违例，无需广泛假设/性能探针。

分别保留原文与当前补充，采用optional previousReflection，不放宽500字/12条schema。按claim type应用新陈述，旧未提及类型带原origin保留。新选项/原文目标优先；独审的旧目标继承和问题类型错误各红→绿。不是将两段截到500字，也不是一般自然语言撤回识别。

满额时原限制原样保留，新增修订说明出现在800字verdict explanation；该说明由固定文本生成并经schema验证。TransferRule/Thread与修订低置信度保持一致。两个源都属于USER，不改Demo facts，case/thread身份和一次异议预算保持。旧记录缺少previousReflection仍可读取，新字段不承诺旧客户端兼容。

## 验证

```sh
pnpm exec vitest run libs/coach-agent/src/teaching-diagnosis.test.ts libs/coach-agent/src/teaching-diagnosis-graph.test.ts apps/web/lib/review-history/artifact-validation.test.ts apps/web/lib/coaching/teaching-diagnosis-host.test.ts apps/web/lib/coaching/current-cue-questions.test.ts apps/web/components/playback/teaching-diagnosis-panel.test.ts apps/web/lib/memory/agent-events.test.ts
pnpm typecheck
pnpm build
```

相关7文件168tests、TypeScript通过。真实Graph长异议达到DISAGREED，第一次和重复/第二次提交case一致，Policy调用0。原500字和新500字尾部保留；同类型以新原文为准，未提及类型仍保留原origin。新的CueCase经实际append和stored validators以及内存restore精确保留；没有真实DB。

Web production build通过。仅CPU内存fixture，没有服务、浏览器、Demo或模型调用。默认revision_semantics_review只读独审两项已关闭，无残留进程。全部临时验证资源由主控拥有；原锁屏工具A5保持独立未验。不把本轮声明为玩家质量/性能验证，不重构其他长度限制。
