# 历史总结的代表案例回合

2026-09-26；基线 e25df67，7f2b/codex/jev-decision-assessment。仅总结展示、相关测试和文档。

## 复现与修复

`artifact-validation.test.ts` 使用实际分析生成器产出的合成 Replay plan/narration，构造一个总结输入投影，经 `completeAndSaveSessionWrapUp` 的默认 deterministic 路径生成结果，再经 `HistoryPersistenceController` 和实际 append validator 保存到内存。随后运行 `restoreHistoryControlPlane`、`validateStoredReviewArtifacts` 和真实 `SessionWrapUpPanel` SSR。

修改前，带临时 request 的展示包含“第 1 回合”，恢复后同一个保存结果仅显示“已完成讲解点”，目标断言失败。修改后两者都从保存的 `theme.summary.refs` 解析代表案例。恢复没有重新调用输入构造、总结生成或 append。

该单回合 fixture 的 summary projection 由测试构造，不验证 Graph 的重复主题准入或专业判断质量。最初双回合 fixture 被生产 uncertainty 去重为单 cue 的失败属于测试假设错误，不计作产品红例。这里没有真实 Demo tick 或模型实测。

## 出处边界

- 当前 plan 必须 COMPLETE；ref 必须唯一对应同主题 cue，且没有与 plan 内 fact/inference/advice/evidence/action/outcome id 冲突。
- segment 必须唯一、反向包含该 cue，round 必须是正安全整数；按保存 ref 顺序对回合去重。
- evidence ref、未知/旧 ref、跨主题 cue、缺失主题标识、缺失 segment 或无效 round 不补造出处；有部分合法引用时只展示可核实部分。
- 不再从临时 request 的整个主题 cueRefs 补回合；保留 prop 兼容。最多三主题、限定和失败提示保持原样。

| Before | After | Why |
| --- | --- | --- |
| 恢复后 request 缺失，回合丢失 | 从已存总结引用显示“代表案例：第 1 回合” | 出处随已存内容恢复 |
| live 可显示整个主题回合 | 只显示被该段总结引用的案例回合 | 不把代表案例冒充全部发生回合 |
| 找不到 segment 可写“准备阶段” | 无法验证时保留“已完成讲解点” | 未知不等于准备阶段 |

复用原 markup/styles，无新增动画、透明材质或交互，不改变 reduced motion/transparency 行为。无持久化/schema/Host/Graph/Memory 变更，因此没有新增架构契约。

## 验证

```sh
pnpm exec vitest run apps/web/lib/coaching/session-wrap-up-presentation.test.ts apps/web/lib/review-history/artifact-validation.test.ts apps/web/lib/coaching/session-wrap-up-completion.test.ts libs/coach-agent/src/session-wrap-up.test.ts apps/web/lib/coaching/deepseek-wrap-up.test.ts
pnpm typecheck
pnpm build
```

相关 5 文件 68 项通过，包含恢复红例转绿、混合引用/部分合法引用、去重、旧临时 request 不影响结果、无效出处降级、三主题上限、限定与失败状态。TypeScript 首轮发现测试 readonly refs 与输入 mutable refs 类型不符，复制数组后复验通过。Web production build 通过。

证据是生产模块调用、内存存储和 SSR，不是完整 Host、浏览器、桌面或真实 DB 验收。旧 cue 缺少 primary_focus_code 仍降级，不能声称所有历史都有回合标签。没有模型准确率、性能或训练效果的前后对照；此次证明的是出处恢复行为改善。
