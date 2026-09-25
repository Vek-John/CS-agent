# 封闭整场总结本地完成

2026-09-26；基线 `0b806b9`。范围为总结客户端及实际 Host 投影，未改变 Director、Jev、专业判断或 Session/Graph 完成门。

## 成本与语义

生产 `SessionWrapUpBuildInput → buildSessionWrapUpRequest` 校验同主题的代表与建议。假客户端/Provider 链复现原来一场有主题总结需要 **1 次 HTTP + 1 次 Provider 复制**；现在默认本地路径二者均 **0**。挂起 transport 不被调用，推进 0 ms 虚拟时钟即可取得结果、计时器为 0。没有真实网络、模型调用或 Demo 测量，不能据此宣称节省真实秒数或费用。

固定的是全部主题及每个主题的两段正文：代表 coreIssue 和首条合法 advice。原契约允许合法 refs/limitations 子集，测试保留该 Provider 自由，因此不宣称所有可接受 bundle 完全相同。本地版本使用完整主题、实际代表 ref 和去重保留的来源限定；不新增训练建议或改写正文。

默认 `requestSessionWrapUp` 复用原领域 builder、匿名主题/引用归属检查和 closed 正文校验，返回 `DISABLED / DETERMINISTIC / CLOSED_SESSION_PROJECTION`。显式 `requestSessionWrapUpFromProvider` 及匿名 HTTP 服务端仍保留旧模型路径、15 秒服务端预算和原响应校验。无重复主题保持 `NO_REPEATED_THEME`，取消 signal 在生成前检查。

## 实际入口修复

真实内存 Graph 中两个同主题 cue 完成后，`COMPLETE_SESSION` 产生两个支持 cueRefs，却只保留一个 completedCues 代表。原 Host 将代表清单当全部支持清单，过滤后只有一条、主题被清空。基线实际 Graph 回归 **1 红**；修复后经 Host→builder→本地总结产生 **1 个主题、2 条已完成支持、1 个代表**。

Host 只从 Graph 主题 refs 取支持，不从全 plan 或 narration map 扩展；逐条重新验证候选/材料/当前窗口/叙述身份、DECISION_ERROR、同 verifiedHabitKey 和可执行 advice。至少两条一致支持才保留；未列入 Graph、缺来源或未准备叙述、不同 habit、冲突证据、代表无 advice、presentationOnly 动作等负例均排除。过滤后的 occurrence/round/evidence refs 收窄，最终只提交代表来源，未放宽原三代表限制或 exact source identity。

独立审查还发现两项原确定性实现问题，均先补回归再修复：

- 正文取代表 B，却引用 `theme.cueRefs[0]` 的 A。现在引用实际代表 `cue.cueId`。
- 只保留顶层 limitations，遗漏主题和代表正文/建议上的限定。现在按来源原文去重合并。

这两项共 **2 红→绿**。不是提高专业判错率，也不是将不确定 cue 升格为习惯。

## 上限、完成与恢复

原输出仍最多 **8 条限定、每条 200 字符**。输入各字段可以合法但合并后不可完整表示；此时明确拒绝，不能为输出成功丢弃限定或扩大 schema。领域返回 typed `SOURCE_LIMITATIONS_EXCEED_OUTPUT_LIMIT`，兼容客户端在请求前同样拒绝；匿名 Provider 预检转换为既有验证错误，HTTP **400 / INVALID_REQUEST**、fetch 0，无裸 schema 异常。

实际 Host 使用的总结面板已提取为可独立 SSR 的同一组件。生产 Session reducer 运行到 WRAP_UP 后，超界失败显示“未生成总结”，保留“完成本次复盘”按钮；COMPLETE_SESSION 后保持 COMPLETED。生产 `issueHostUserCommand` 仍能发送 pause＋seekCanonicalTick 进入自由回看，不改会话完成事实。失败不误报“无重复主题”，不进入无限 LOADING，也不持久化为成功总结。

| Before | After | Why |
|---|---|---|
| 确定性完成被提示“智能总结暂不可用” | 正常本地来源为 READY，无失败提示 | 来源变化不等于失败 |
| 总结失败后同时显示“没有足够重复证据” | 显示失败原因并保留完成入口 | 不把失败当作领域结论 |
| 已保存的限制未在总结面板显示 | 保留并逐条显示来源限定 | 不使固定正文脱离适用范围 |

使用 emil-design-eng / apple-design 技能；沿用原 class、布局结构、按钮和 aria-live，没有新增动画或透明效果。SSR 不是浏览器、桌面或键鼠交互验收。

Host 在 Graph 完成请求前捕获 generation，且只允许 run/generation 匹配、未接管、Graph/sessionStatus 均 COMPLETED 时发布；旧 generation 无新结果或 artifact 写入。旧本地/DEEPSEEK summary 经实际 stored-artifact validator 原文恢复，0 fetch，不调用新生成器、不迁移旧引用或正文、无新分析和 Memory 写入。

## 验证与交付

**8 文件、93 tests 通过**：

```sh
pnpm test \
  apps/web/lib/coaching/deepseek-wrap-up.test.ts \
  apps/web/lib/coaching/coach-agent-stage3-wrap-up.test.ts \
  apps/web/lib/coaching/session-wrap-up-presentation.test.ts \
  apps/web/lib/coaching/coach-agent-stage3-controller.test.ts \
  apps/web/app/api/coaching/wrap-up/route.test.ts \
  libs/coach-agent/src/session-wrap-up.test.ts \
  libs/coach-agent/src/stage3-integration.test.ts \
  apps/web/lib/recovery/cs2d-session-recovery.test.ts
pnpm typecheck
pnpm build
```

类型检查和生产构建通过。覆盖多主题、空主题、代表/建议/refs 归属、合法 800 字长正文与越界拒绝、源限定溢出、Provider 兼容、真实 Graph/Host、取消、SSR 和恢复。`local_wrap_up_review` 默认配置，5 分钟只读审查及 2 分钟闭合；两项必修已关闭，无剩余 must-fix。没有运行模型、Demo、浏览器、服务、用户数据库或密钥操作；全部测试/build 退出，同分支 commit/push 后释放。

原 UI A5、真实播放暂停/续播、实际网络耗时、费用和专业质量均未在本轮验证。单候选 Director 仍有拒选等自由，未实现跳过。

下一独立建议：本轮明确了总结失败的当前 UI，但 Host 目前只在成功分支保存 SESSION_SUMMARY；可以用隔离 artifact fixture 核实失败后恢复是否丢失失败说明，再决定是否需要持久化最小失败状态。不得自动重生成旧总结、修改已保存正文或启动模型。
