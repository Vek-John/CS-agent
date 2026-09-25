# 总结失败保存与恢复验证

2026-09-26，基线 `90e3772`，产品基线 `04e6b71`。本轮只修复完成收尾与历史呈现，不变更教学判断、播放完成门或总结正文协议。

## 复现与改变

| 情况 | 原 Host 行为 | 当前保存与恢复 |
|---|---|---|
| 缺完整会话摘要 | 仅内存提示、不保存 | FALLBACK + MISSING_SESSION_SUMMARY |
| 可展示输入无效 | 仅内存提示、不保存 | FALLBACK + INVALID_PRESENTABLE_INPUT |
| 必须保留的来源限定超限 | 内存提示具体，但内存manifest降成输入无效且不保存 | FALLBACK + SOURCE_LIMITATIONS_EXCEED_OUTPUT_LIMIT |
| 旧记录无 summary | IDLE，被面板显示成没有重复主题 | 未保存、当时生成结果未知 |
| 正常无重复主题 | NO_REPEATED_THEME | 原语义保持 |
| 旧本地/DeepSeek成功 | 已保存正文 | 正文、引用、来源manifest原样恢复 |

展示层缺失/超限两项回归先红；修复后通过。未改变既有 result schema、artifact envelope、DB 或幂等键。失败存有限代码和预定义提示，不存任意异常文本；没有主题不再自动意味着没有重复证据。

`completeAndSaveSessionWrapUp` 是 Host 实际使用的完成入口。正常、缺摘要和异常统一发布/保存；Host 恢复使用相同 `sessionWrapUpPresentation`，实际 `SessionWrapUpPanel` 渲染该状态。恢复链没有调用完成入口或生成器。

## 验证层次

- 七类隔离记录经生产完成入口（新结果）或 controller（旧结果）→ `HistoryPersistenceController.artifact` → `validateReviewArtifactAppend` → `restoreHistoryControlPlane` → `validateStoredReviewArtifacts` → 实际面板 SSR。三失败准确保存、正常无主题保留；旧本地/DeepSeek正文和refs深相等，旧缺失不产生artifact。恢复 fetch 0、额外写入 0。
- generation、run、review、revision和接管变化拒绝等待中的发布/保存；controller既有待revision失效测试保持。已发出的写只绑定原review/revision，迟到拒绝不污染新review提示。
- 模拟保存拒绝后仍返回可呈现失败结果，生产Session reducer可从WRAP_UP进入COMPLETED，实际Host自由回看命令仍发pause＋seekCanonicalTick；按钮与已完成事实不依赖保存成功。
- 独立只读复核发现新增run guard会误拒绝正常完成清理Stage3 identity后的同场收尾。回归1红→绿：只有同session id、COMPLETED且临时run已清理可继续；不同session、不同run和非完成缺identity仍拒绝。generation/review/revision/epoch检查保持，完整guard在LOADING写之前执行；复核确认闭合。

## 检查与局限

8文件、84 tests通过：completion、presentation、artifact-validation、history-persistence-controller、history-restore-controller、cs2d-session-recovery、deepseek-wrap-up、coach-agent-stage3-wrap-up。`pnpm typecheck` 与 `pnpm build` 通过，`git diff --check` 干净。

使用已有 emil-design-eng / apple-design 技能，沿用布局/class/aria-live与完成按钮，无新增动画或透明效果。SSR和内存transport不等于真实浏览器、SQLite磁盘持久性或播放器操作验收；本轮未读真实Demo、调用模型/Memory或接触用户DB，原UI暂停A5仍未验证。没有实测教学质量、真实等待秒数或费用提升。本轮提升是失败说明可恢复、缺失语义诚实以及迟到结果不串会话。

保存层不可用时仍可能没有summary，显示保存失败并允许完成；不增加重试框架或重生成历史产物。下一独立方向：用隔离迟到dispatch fixture验证Host SESSION_COMPLETED恢复回调的身份清理边界，证实影响后才窄修。
